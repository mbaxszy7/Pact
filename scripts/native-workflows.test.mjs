import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const { load } = builderRequire('js-yaml')
const loadWorkflow = async (name) =>
  load(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
const [ci, distribution, release] = await Promise.all(
  ['ci-native', 'distributions', 'release-native'].map(loadWorkflow),
)
const allWorkflows = [ci, distribution, release]
const retry = await loadWorkflow('retry-native')
const setup = load(
  await readFile(new URL('../.github/actions/setup/action.yml', import.meta.url), 'utf8'),
)
const commands = (job) => job.steps?.map((step) => step.run ?? '').join('\n') ?? ''
const upload = (job) =>
  job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
const downloads = (job) =>
  job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'))
const retryStep = retry.jobs.retry.steps[0]
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const runRetry = new AsyncFunction('github', 'context', 'core', retryStep.with.script)

async function retryFixture(
  change = {},
  { failRead = false, failWrite = false, context: replacement } = {},
) {
  const context = replacement ?? {
    repo: { owner: 'mbaxszy7', repo: 'Pact' },
    payload: { workflow_run: { id: 123, run_attempt: 1 } },
  }
  const run = {
    id: 123,
    repository: { id: 1416403312 },
    name: 'Pact CI',
    path: '.github/workflows/ci-native.yml',
    event: 'pull_request',
    head_branch: 'feature',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    ...change,
  }
  const calls = []
  const failures = []
  const execute = () =>
    runRetry(
      {
        request: async (route, args) => {
          calls.push({ route, args })
          if (route.startsWith('GET ') && !failRead) return { data: run }
          if (failRead || failWrite)
            throw Object.assign(new Error('Synthetic private failure body'), {
              request: { headers: { authorization: 'unregistered-fixture-secret' } },
              response: { data: 'Synthetic private API response' },
            })
          return { status: 201 }
        },
      },
      context,
      { info: () => {}, setFailed: (message) => failures.push(message) },
    )
  return { calls, failures, execute }
}

void test('one metadata-only retry job uses native failed-job recovery without consuming untrusted code or artifacts', () => {
  assert.deepEqual(retry.on, {
    workflow_run: { workflows: ['Pact CI', 'Pact release'], types: ['completed'] },
  })
  assert.deepEqual(retry.permissions, {})
  assert.deepEqual(Object.keys(retry.jobs), ['retry'])
  assert.deepEqual(retry.jobs.retry.permissions, { actions: 'write' })
  assert.equal(retry.jobs.retry['timeout-minutes'], 2)
  assert.match(retry.jobs.retry.if, /conclusion == 'failure'.*run_attempt == 1/u)
  assert.equal(retry.jobs.retry.steps.length, 1)
  assert.match(retryStep.uses, /^actions\/github-script@[a-f0-9]{40}$/u)
  assert.equal(retryStep.with.retries, 0)
  assert.equal(retry.concurrency['cancel-in-progress'], false)
  assert.equal(retry.concurrency.group, 'pact-retry-${{ github.event.workflow_run.id }}')
  assert.doesNotMatch(
    JSON.stringify(retry),
    /checkout|download-artifact|cache@|secrets\.|environment|head_sha|eval\(|exec\(/u,
  )
})

void test('initial CI and release failures request exactly one rerun of failed jobs with their native dependents', async () => {
  for (const change of [
    {},
    { event: 'push', head_branch: 'dev' },
    { event: 'workflow_dispatch' },
    {
      name: 'Pact release',
      path: '.github/workflows/release-native.yml@refs/heads/main',
      event: 'push',
      head_branch: 'main',
    },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Execute the actual workflow policy against each distinct native trigger.
    const fixture = await retryFixture(change)
    // oxlint-disable-next-line eslint/no-await-in-loop -- No real Actions or provider work is requested by the fixture boundary.
    await fixture.execute()
    assert.deepEqual(fixture.failures, [])
    assert.deepEqual(
      fixture.calls.map((call) => call.route),
      [
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs',
      ],
    )
    assert.deepEqual(fixture.calls[1].args, {
      owner: 'mbaxszy7',
      repo: 'Pact',
      run_id: 123,
      request: { timeout: 30000 },
    })
  }
})

void test('fresh attempt and run identity checks suppress retry loops, already-observed manual reruns and unrelated execution', async () => {
  for (const change of [
    { run_attempt: 2 },
    { run_attempt: 4 },
    { status: 'in_progress' },
    { conclusion: 'success' },
    { conclusion: 'cancelled' },
    { id: 456 },
    { repository: { id: 1 } },
    { name: 'Unrelated workflow' },
    { path: '.github/workflows/untrusted.yml' },
    { event: 'workflow_run' },
    { event: 'push', head_branch: 'main' },
    {
      name: 'Pact release',
      path: '.github/workflows/release-native.yml',
      event: 'push',
      head_branch: 'dev',
    },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck live API state independently of the initial completed event.
    const fixture = await retryFixture(change)
    // oxlint-disable-next-line eslint/no-await-in-loop -- The original event still says attempt 1; a newer live attempt must consume the opportunity.
    await fixture.execute()
    assert.equal(fixture.calls.length, 1)
    assert.ok(fixture.calls[0].route.startsWith('GET '))
  }
})

void test('an uncertain retry request is not repeated and invalid repository or run input never reaches the API', async () => {
  const uncertain = await retryFixture({}, { failWrite: true })
  await uncertain.execute()
  assert.deepEqual(uncertain.failures, [
    'Automatic retry request failed or was unconfirmed; the request was not repeated.',
  ])
  assert.equal(uncertain.calls.filter((call) => call.route.startsWith('POST ')).length, 1)
  const unreadable = await retryFixture({}, { failRead: true })
  await unreadable.execute()
  assert.deepEqual(unreadable.failures, [
    'Automatic retry could not read the current run; no retry was requested.',
  ])
  assert.equal(unreadable.calls.length, 1)
  for (const context of [
    { repo: { owner: 'external', repo: 'Pact' }, payload: { workflow_run: { id: 123 } } },
    {
      repo: { owner: 'mbaxszy7', repo: 'Pact' },
      payload: { workflow_run: { id: '123; echo unsafe' } },
    },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Boundary rejection precedes even the read request.
    const invalid = await retryFixture({}, { context })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Never interpolate event text into commands or routes.
    await assert.rejects(invalid.execute(), /Unexpected retry repository|Invalid retry run/u)
    assert.equal(invalid.calls.length, 0)
  }
})

void test('shared Windows toolchain publishes native pnpm independently of optional CLI installation', () => {
  const steps = setup.runs.steps
  const dependencies = steps.findIndex((step) => step.name === 'Install frozen source dependencies')
  const admission = steps.findIndex((step) => step.run?.includes('publishWindowsPnpmPath'))
  const native = steps.findIndex((step) => step.run?.includes('node scripts/ci-native.mjs'))
  assert.ok(dependencies < admission && admission < native)
  assert.equal(steps[admission].if, "runner.os == 'Windows'")
  assert.doesNotMatch(steps[admission].run, /inputs\.native|shell: true|\.cmd/u)
})

void test('main version-merge events queue without replacing an earlier pending release', () => {
  assert.equal(release.concurrency['cancel-in-progress'], false)
  assert.equal(release.concurrency.queue, 'max')
})

void test('both native callers explicitly bind only the reusable model secret contract', () => {
  const expected = [
    'PACT_CLAUDE_SETTINGS_JSON',
    'PACT_CODEX_CONFIG_TOML',
    'PACT_CODEX_AUTH_JSON',
    'PACT_CODEX_PROVIDER_ENV_JSON',
  ].toSorted()
  assert.deepEqual(Object.keys(distribution.on.workflow_call.secrets).toSorted(), expected)
  for (const caller of [ci.jobs.checks, release.jobs.validate]) {
    assert.deepEqual(Object.keys(caller.secrets).toSorted(), expected)
    for (const name of expected) assert.equal(caller.secrets[name], '${{ secrets.' + name + ' }}')
  }
})

void test('ordinary validation uses native PR events and exact event source without privileged fallbacks', () => {
  assert.deepEqual(Object.keys(ci.on).toSorted(), ['pull_request', 'push', 'workflow_dispatch'])
  assert.deepEqual(ci.on.push.branches, ['dev'])
  assert.deepEqual(ci.on.pull_request.branches, ['main'])
  assert.equal(ci.jobs.checks.with.source_sha, '${{ github.sha }}')
  assert.equal(ci.jobs.checks.with.channel, "${{ inputs.channel || 'dev' }}")
  assert.match(
    ci.jobs.checks.with.real_allowed,
    /pull_request\.head\.repo\.full_name == github\.repository/u,
  )
  assert.match(ci.jobs.checks.with.real_allowed, /repository_id == '1416403312'/u)
  for (const value of allWorkflows) {
    assert.deepEqual(value.permissions, { contents: 'read' })
    const serialized = JSON.stringify(value)
    assert.doesNotMatch(
      serialized,
      /pull_request_target|workflow_run|PACT_CI_BOOTSTRAP|PACT_GOVERNANCE_READY|PACT_PACKAGING_READY|ci-control|ci-identity|release-staging/u,
    )
    for (const job of Object.values(value.jobs)) {
      if (job.steps) {
        assert.ok(job['timeout-minutes'] >= 5 && job['timeout-minutes'] <= 150)
        for (const step of job.steps) {
          if (step.uses && !step.uses.startsWith('./'))
            assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/u)
          if (step.uses?.startsWith('actions/checkout@')) {
            assert.equal(step.with['persist-credentials'], false)
            assert.ok(
              [
                '${{ github.sha }}',
                '${{ inputs.source_sha }}',
                '${{ needs.resolve.outputs.source_sha }}',
              ].includes(step.with.ref),
            )
            assert.equal(step.with.path, undefined)
          }
        }
      }
    }
  }
})

void test('each native responsibility is a separate job with exact package-to-smoke artifact linkage', () => {
  const expectedJobs = [
    'quality',
    'native_mac',
    'native_win',
    'native_win_arm64',
    'package_mac',
    'package_win',
    'package_win_arm64',
    'smoke_mac',
    'smoke_win',
    'smoke_win_arm64',
    'real_mac',
    'real_win',
    'real_win_arm64',
    'complete',
  ]
  assert.deepEqual(Object.keys(distribution.jobs).toSorted(), expectedJobs.toSorted())
  for (const [suffix, runner] of [
    ['mac', 'macos-15'],
    ['win', 'windows-2025'],
    ['win_arm64', 'windows-11-arm'],
  ]) {
    const native = distribution.jobs[`native_${suffix}`]
    const pack = distribution.jobs[`package_${suffix}`]
    const smoke = distribution.jobs[`smoke_${suffix}`]
    const real = distribution.jobs[`real_${suffix}`]
    for (const job of [native, pack, smoke, real]) {
      assert.equal(job['runs-on'], runner)
      assert.equal(job.strategy, undefined)
      if (suffix === 'win_arm64') {
        assert.equal(job.steps[0].shell, 'pwsh')
        assert.equal(job.steps[0].name, 'Require native Windows ARM64 before setup')
        assert.match(job.steps[0].run, /process\.platform!=="win32"\|\|process\.arch!=="arm64"/u)
        assert.match(job.steps[0].run, /\$LASTEXITCODE/u)
        assert.match(job.steps[1].uses, /^actions\/checkout@/u)
      }
    }
    assert.match(commands(native), /node scripts\/ci\.mjs native/u)
    assert.doesNotMatch(
      commands(native),
      /build-distribution|ci-artifacts\.mjs smoke|ci\.mjs real/u,
    )
    assert.match(commands(pack), /build-distribution\.mjs/u)
    assert.doesNotMatch(commands(pack), /ci-artifacts\.mjs smoke|ci\.mjs (native|real)/u)
    assert.equal(smoke.needs, `package_${suffix}`)
    assert.match(commands(smoke), /ci-artifacts\.mjs smoke/u)
    assert.doesNotMatch(commands(smoke), /build-distribution|ci\.mjs (build|native|real)/u)
    assert.equal(downloads(smoke).length, 1)
    assert.equal(
      downloads(smoke)[0].with['artifact-ids'],
      '${{ needs.package_' + suffix + '.outputs.id }}',
    )
    assert.equal(smoke.env.PACKAGE_DIGEST, '${{ needs.package_' + suffix + '.outputs.digest }}')
    assert.match(commands(real), /node scripts\/ci\.mjs real core/u)
    assert.doesNotMatch(
      commands(real),
      /build-distribution|ci-artifacts\.mjs smoke|ci\.mjs (native|ui|deterministic)/u,
    )
    assert.equal(real.environment, 'pact-provider-ci')
    assert.equal(real.if, 'inputs.real_allowed')
    assert.deepEqual(real.needs, ['quality', `native_${suffix}`])
    const execute = real.steps.find((step) => step.id === 'execute')
    const gate = real.steps.find((step) => step.run?.includes('real-e2e-policy.mjs'))
    assert.equal(execute['continue-on-error'], true)
    assert.equal(gate.if, 'always()')
    assert.match(gate.run, /real-e2e-policy\.mjs core core/u)
    assert.equal(
      gate.env.PACT_REAL_EXECUTION_COMPLETED,
      '${{ steps.execute.outputs.real_execution_completed }}',
    )
    assert.equal(upload(pack).length, 1)
    for (const jobName of [`package_${suffix}`, `smoke_${suffix}`]) {
      assert.equal(distribution.jobs[jobName].outputs.id, '${{ steps.upload.outputs.artifact-id }}')
      assert.equal(
        distribution.jobs[jobName].outputs.digest,
        '${{ steps.upload.outputs.artifact-digest }}',
      )
      for (const output of ['id', 'digest'])
        assert.equal(
          distribution.on.workflow_call.outputs[`${jobName}_${output}`].value,
          '${{ jobs.' + jobName + '.outputs.' + output + ' }}',
        )
    }
  }
})

void test('complete gate actually rejects failures, cancellation, missing jobs and skipped model execution', () => {
  const complete = distribution.jobs.complete
  assert.equal(complete.if, 'always()')
  assert.equal(complete.needs.length, 13)
  assert.deepEqual(
    complete.needs.toSorted(),
    Object.keys(distribution.jobs)
      .filter((name) => name !== 'complete')
      .toSorted(),
  )
  const baseline = Object.fromEntries(complete.needs.map((name) => [name, { result: 'success' }]))
  const script = complete.steps[0].run
  const execute = (needs) =>
    spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH, RESULTS: JSON.stringify(needs) },
      encoding: 'utf8',
      timeout: 5000,
    }).status
  assert.equal(execute(baseline), 0)
  for (const name of complete.needs) {
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.notEqual(execute({ ...baseline, [name]: { result } }), 0)
    const missing = { ...baseline }
    delete missing[name]
    assert.notEqual(execute(missing), 0)
  }
  assert.equal(ci.jobs.ci_complete.if, 'always()')
  assert.match(commands(ci.jobs.ci_complete), /test "\$RESULT" = success/u)
})

void test('all automated quality obligations remain mandatory and no business lane expands beyond core', () => {
  const quality = commands(distribution.jobs.quality)
  for (const required of [
    'check-secrets.mjs --history',
    'check-e2e-coverage.mjs --source-only --json',
    'ci.mjs quality',
    'ci.mjs infra',
    'ci.mjs build',
    'check-e2e-coverage.mjs --json',
  ])
    assert.ok(quality.includes(required), required)
  assert.doesNotMatch(
    JSON.stringify(allWorkflows),
    /ci\.mjs (ui|deterministic|real full)|extended_e2e|full_regression/u,
  )
  assert.deepEqual(ci.on.workflow_dispatch.inputs.channel.options, ['dev', 'stable'])
})

void test('model secrets and version App credentials are confined to their sole owners', () => {
  for (const workflow of allWorkflows) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const text = JSON.stringify(job)
      if (/secrets\.PACT_(CLAUDE|CODEX)_/u.test(text)) {
        if (job.uses) {
          assert.equal(job.uses, './.github/workflows/distributions.yml')
          assert.ok(job === ci.jobs.checks || job === release.jobs.validate)
        } else {
          assert.equal(workflow, distribution)
          assert.ok(['real_mac', 'real_win', 'real_win_arm64'].includes(name))
          for (const step of job.steps)
            if (/secrets\.PACT_(CLAUDE|CODEX)_/u.test(JSON.stringify(step)))
              assert.equal(step.id, 'execute')
        }
      }
      if (/secrets\.PACT_CI_APP_/u.test(text)) {
        assert.equal(workflow, release)
        assert.equal(name, 'version_pr')
      }
      assert.doesNotMatch(
        text,
        /permission-checks|checks:write|id-token|attestations|auto-merge|--approve|--merge/u,
      )
    }
  }
  assert.equal(
    release.jobs.version_pr.steps.some((step) => step.uses?.includes('checkout')),
    false,
  )
  const app = release.jobs.version_pr.steps.find((step) => step.id === 'app')
  assert.deepEqual(
    Object.keys(app.with)
      .filter((name) => name.startsWith('permission-'))
      .toSorted(),
    ['permission-contents', 'permission-issues', 'permission-pull-requests'],
  )
  const version = release.jobs.version_pr.steps.find((step) =>
    step.uses?.startsWith('googleapis/release-please-action@'),
  )
  assert.equal(version.with['skip-github-release'], true)
  assert.equal(version.with['target-branch'], 'main')
})

void test('delivery and publication consume exact accepted IDs in separate non-executing jobs', () => {
  const delivery = ci.jobs.deliver_dev
  const publish = release.jobs.publish
  assert.deepEqual(delivery.needs, ['checks', 'ci_complete'])
  assert.match(delivery.if, /event_name == 'push'.*refs\/heads\/dev/u)
  assert.equal(downloads(delivery).length, 6)
  assert.equal(upload(delivery).length, 1)
  assert.match(commands(delivery), /ci-artifacts\.mjs verify/u)
  assert.doesNotMatch(
    commands(delivery),
    /build-distribution|package-smoke|ci\.mjs (real|native|build)/u,
  )
  assert.deepEqual(release.on, { push: { branches: ['main'] } })
  assert.deepEqual(publish.needs, ['resolve', 'validate'])
  assert.equal(downloads(publish).length, 6)
  const evidence = upload(publish)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].if, 'always()')
  assert.equal(evidence[0].with.name, 'release-evidence-stable-a${{ github.run_attempt }}')
  assert.deepEqual(evidence[0].with.path.trim().split('\n'), [
    '${{ runner.temp }}/release/pact-release-manifest.json',
    '${{ runner.temp }}/release/SHA256SUMS',
  ])
  assert.equal(evidence[0].with['retention-days'], 14)
  assert.equal(evidence[0].with['if-no-files-found'], 'warn')
  for (const job of [delivery, publish]) {
    for (const step of downloads(job)) {
      assert.ok(step.with['artifact-ids'])
      assert.equal(step.with.name, undefined)
      assert.equal(step.with['run-id'], undefined)
    }
  }
  assert.match(commands(publish), /release-native\.mjs publish/u)
  assert.doesNotMatch(
    commands(publish),
    /build-distribution|package-smoke|ci\.mjs|pnpm|\.exe|open /u,
  )
  assert.deepEqual(publish.permissions, {
    contents: 'write',
    issues: 'write',
    'pull-requests': 'write',
    actions: 'read',
  })
  const command = publish.steps.find((step) => step.run?.includes('release-native.mjs publish'))
  const artifacts = JSON.parse(command.env.PACT_RELEASE_ARTIFACTS_JSON)
  assert.deepEqual(Object.keys(artifacts).toSorted(), ['darwin-arm64', 'win32-arm64', 'win32-x64'])
  for (const [platform, suffix] of [
    ['darwin-arm64', 'mac'],
    ['win32-x64', 'win'],
    ['win32-arm64', 'win_arm64'],
  ]) {
    for (const [job, caller, root] of [
      [delivery, 'checks', 'delivery'],
      [publish, 'validate', 'release'],
    ]) {
      for (const kind of ['package', 'smoke']) {
        const step = downloads(job).find(
          (download) =>
            download.with.path === '${{ runner.temp }}/' + root + '/' + platform + '/' + kind,
        )
        assert.equal(
          step?.with['artifact-ids'],
          '${{ needs.' + caller + '.outputs.' + kind + '_' + suffix + '_id }}',
        )
      }
    }
    const verify = delivery.steps.find((step) => step.env?.PACT_CI_PLATFORM === platform)
    assert.equal(verify?.env.PACKAGE_ID, '${{ needs.checks.outputs.package_' + suffix + '_id }}')
    assert.equal(
      verify?.env.PACKAGE_DIGEST,
      '${{ needs.checks.outputs.package_' + suffix + '_digest }}',
    )
    assert.ok(verify.run.includes('delivery/' + platform + '/package'))
    assert.ok(verify.run.includes('delivery/' + platform + '/smoke'))
    assert.equal(
      artifacts[platform].packageId,
      '${{ needs.validate.outputs.package_' + suffix + '_id }}',
    )
    assert.equal(
      artifacts[platform].packageDigest,
      '${{ needs.validate.outputs.package_' + suffix + '_digest }}',
    )
    assert.equal(
      artifacts[platform].smokeId,
      '${{ needs.validate.outputs.smoke_' + suffix + '_id }}',
    )
    assert.equal(
      artifacts[platform].smokeDigest,
      '${{ needs.validate.outputs.smoke_' + suffix + '_digest }}',
    )
  }
  assert.match(release.jobs.version_pr.if, /needs\.publish\.result == 'success'/u)
  assert.doesNotMatch(JSON.stringify(release), /release_created/u)
})

void test('the required macOS native job runs the separate pinned decision profile after legacy and preserves independent strict evidence', () => {
  const steps = distribution.jobs.native_mac.steps
  const legacy = steps.findIndex((step) => step.run === 'node scripts/ci.mjs native')
  const prepare = steps.findIndex(
    (step) => step.run === 'node scripts/ci-native.mjs decision-codex',
  )
  const decision = steps.findIndex(
    (step) => step.run === 'node scripts/ci.mjs native decision-codex',
  )
  assert(legacy >= 0 && prepare > legacy && decision > prepare)
  assert.equal(
    steps[decision].env.PACT_CI_NATIVE_IDENTITY_FILE,
    steps[legacy].env.PACT_CI_NATIVE_IDENTITY_FILE,
  )
  assert.notEqual(
    steps[decision].env.PACT_CI_NATIVE_REPORT_DIR,
    steps[legacy].env.PACT_CI_NATIVE_REPORT_DIR,
  )
  assert.notEqual(
    steps[decision].env.PACT_CI_NATIVE_ARTIFACT,
    steps[legacy].env.PACT_CI_NATIVE_ARTIFACT,
  )
  const preserved = steps.find(
    (step) => step.with?.name === steps[decision].env.PACT_CI_NATIVE_ARTIFACT,
  )
  assert.equal(preserved?.if, 'always()')
  assert.match(preserved.with.path, /native-summary\.json/u)
  for (const suffix of ['win', 'win_arm64'])
    assert.doesNotMatch(
      commands(distribution.jobs[`native_${suffix}`]),
      /node scripts\/ci(?:-native)?\.mjs (?:native )?decision-codex/u,
    )
  assert(distribution.jobs.complete.needs.includes('native_mac'))
})

void test('Windows source jobs share installed native MSVC admission without downloading tools or exporting the whole environment', () => {
  let procedure
  for (const [suffix, arch] of [
    ['win', 'x64'],
    ['win_arm64', 'arm64'],
  ]) {
    for (const responsibility of ['native', 'package', 'real']) {
      const steps = distribution.jobs[`${responsibility}_${suffix}`].steps
      const prepare = steps.findIndex((step) => step.env?.PACT_MSVC_ARCH === arch)
      const setupAt = steps.findIndex((step) => step.uses === './.github/actions/setup')
      assert(prepare >= 0 && prepare < setupAt)
      const step = steps[prepare]
      assert.equal(step.shell, 'pwsh')
      assert.equal(step['timeout-minutes'], 2)
      assert.equal(step['continue-on-error'], undefined)
      procedure ??= step.run
      assert.equal(step.run, procedure)
      assert.match(step.run, /process\.arch!==process\.env\.PACT_MSVC_ARCH/u)
      assert.match(step.run, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.ARM64/u)
      assert.match(step.run, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/u)
      assert.match(step.run, /-requires \$component -property installationPath/u)
      assert.match(step.run, /-arch=\{1\} -host_arch=\{1\}/u)
      assert.match(step.run, /VSCMD_ARG_TGT_ARCH'\] -ne \$arch/u)
      assert(step.run.includes('\\Host$arch\\$arch\\cl.exe'))
      assert.match(step.run, /\$lines\.Count -gt 128/u)
      assert.match(step.run, /-gt 65536/u)
      assert.match(step.run, /GITHUB_PATH.*\$compilerDirectory/u)
      assert.doesNotMatch(
        step.run,
        /Invoke-WebRequest|DownloadFile|winget|choco|msiexec|setx\s|reg add/iu,
      )
      assert.doesNotMatch(step.run, /&& set(?:\s*'|\s*$)/mu)
      const exported =
        /foreach \(\$key in @\(([^)]+)\)\) \{\s*Add-Content -LiteralPath \$env:GITHUB_ENV/u.exec(
          step.run,
        )
      assert(exported)
      assert.deepEqual(
        [...exported[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]),
        ['INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH'],
      )
      assert.doesNotMatch(JSON.stringify(step), /secrets\.|pact-provider-ci/u)
    }
    assert.equal(
      distribution.jobs[`smoke_${suffix}`].steps.some((step) => step.env?.PACT_MSVC_ARCH),
      false,
    )
  }
  for (const name of ['native_mac', 'package_mac', 'real_mac', 'smoke_mac'])
    assert.equal(
      distribution.jobs[name].steps.some((step) => step.env?.PACT_MSVC_ARCH),
      false,
    )
})

function assertProfileEvidence(steps, execution, profile) {
  const command = steps[execution]
  assert.equal(command['continue-on-error'], undefined)
  assert.equal(command.if, undefined)
  const fallback = steps.find(
    (step) =>
      step.run === 'node scripts/ci-native-report.mjs' &&
      step.env?.PACT_CI_NATIVE_PROFILE === profile,
  )
  assert.equal(fallback?.if, 'always()')
  for (const key of [
    'PACT_CI_NATIVE_REPORT_DIR',
    'PACT_CI_NATIVE_IDENTITY_FILE',
    'PACT_CI_NATIVE_ARTIFACT',
  ])
    assert.equal(fallback.env[key], command.env[key])
  const artifact = steps.find((step) => step.with?.name === command.env.PACT_CI_NATIVE_ARTIFACT)
  assert.equal(artifact?.if, 'always()')
  assert.equal(artifact.with['retention-days'], 14)
  assert.deepEqual(artifact.with.path.trim().split('\n'), [
    `${command.env.PACT_CI_NATIVE_REPORT_DIR}/native-summary.json`,
    `${command.env.PACT_CI_NATIVE_REPORT_DIR}/native-summary.md`,
  ])
  assert.doesNotMatch(JSON.stringify(command), /secrets\.|--grep|--testNamePattern|--reporter/u)
}

void test('macOS requires the pinned Claude profile while Windows preserves blocked decision evidence and denies execution', () => {
  for (const suffix of ['mac', 'win', 'win_arm64']) {
    const job = distribution.jobs[`native_${suffix}`]
    const steps = job.steps
    const legacy = steps.findIndex((step) => step.run === 'node scripts/ci.mjs native')
    const prepare = steps.findIndex(
      (step) => step.run === 'node scripts/ci-native.mjs decision-claude',
    )
    const execute = steps.findIndex(
      (step) => step.run === 'node scripts/ci.mjs native decision-claude',
    )
    assert(legacy >= 0)
    if (suffix !== 'mac') {
      assert.equal(prepare, -1)
      assert.equal(execute, -1)
      const guard = steps.find(
        (step) => step.name === 'Verify decision isolation remains unavailable on Windows',
      )
      assert.match(guard.run, /nativeProfileSupports/u)
      assert.match(guard.run, /decision-codex/u)
      assert.match(guard.run, /decision-claude/u)
      assert.match(guard.run, /throw new Error/u)
      const blocked = steps.find(
        (step) =>
          step.run === 'node scripts/ci-native-report.mjs' &&
          step.env?.PACT_CI_NATIVE_PROFILE === 'decision-claude',
      )
      assert.equal(blocked.if, 'always()')
      assert.equal(
        blocked.env.PACT_CI_NATIVE_IDENTITY_FILE,
        steps[legacy].env.PACT_CI_NATIVE_IDENTITY_FILE,
      )
      assert.notEqual(
        blocked.env.PACT_CI_NATIVE_REPORT_DIR,
        steps[legacy].env.PACT_CI_NATIVE_REPORT_DIR,
      )
      const uploaded = steps.find((step) => step.with?.name === blocked.env.PACT_CI_NATIVE_ARTIFACT)
      assert.equal(uploaded.if, 'always()')
      assert.match(uploaded.with.path, /native-summary\.json/u)
      assert.equal(job.environment, undefined)
      assert.doesNotMatch(JSON.stringify(job), /secrets\.PACT_(CLAUDE|CODEX)_/u)
      assert(distribution.jobs.complete.needs.includes(`native_${suffix}`))
      continue
    }
    assert(prepare > legacy && execute > prepare)
    if (suffix === 'mac')
      assert(
        prepare >
          steps.findIndex((step) => step.run === 'node scripts/ci.mjs native decision-codex'),
      )
    assert.equal(
      steps[execute].env.PACT_CI_NATIVE_IDENTITY_FILE,
      steps[legacy].env.PACT_CI_NATIVE_IDENTITY_FILE,
    )
    assert.notEqual(
      steps[execute].env.PACT_CI_NATIVE_REPORT_DIR,
      steps[legacy].env.PACT_CI_NATIVE_REPORT_DIR,
    )
    assert.notEqual(
      steps[execute].env.PACT_CI_NATIVE_ARTIFACT,
      steps[legacy].env.PACT_CI_NATIVE_ARTIFACT,
    )
    assertProfileEvidence(steps, execute, 'decision-claude')
    assert.equal(job.environment, undefined)
    assert.doesNotMatch(JSON.stringify(job), /secrets\.PACT_(CLAUDE|CODEX)_/u)
    assert(distribution.jobs.complete.needs.includes(`native_${suffix}`))
  }
})

void test('Windows owner acceptance builds before legacy protocols and real source runners prepare their own helper without compiling installed smoke', () => {
  for (const suffix of ['win', 'win_arm64']) {
    const steps = distribution.jobs[`native_${suffix}`].steps
    const build = steps.findIndex((step) => step.run === 'node scripts/ci.mjs build')
    const owner = steps.findIndex((step) => step.run === 'node scripts/ci.mjs native windows-owner')
    const legacy = steps.findIndex((step) => step.run === 'node scripts/ci.mjs native')
    assert(build >= 0 && owner > build && owner < legacy)
    assertProfileEvidence(steps, owner, 'windows-owner')
    assert.notEqual(
      steps[owner].env.PACT_CI_NATIVE_REPORT_DIR,
      steps[legacy].env.PACT_CI_NATIVE_REPORT_DIR,
    )
    const real = distribution.jobs[`real_${suffix}`]
    const helper = real.steps.findIndex(
      (step) => step.run === 'node scripts/build-owned-process-group-win32.mjs',
    )
    const execute = real.steps.findIndex((step) => step.id === 'execute')
    assert(helper >= 0 && helper < execute)
    assert.equal(real.if, 'inputs.real_allowed')
    assert.equal(real.steps[helper].env, undefined)
    assert.doesNotMatch(
      commands(distribution.jobs[`smoke_${suffix}`]),
      /build-owned-process-group|windows-owner|cl\.exe/u,
    )
  }
  assert.doesNotMatch(
    commands(distribution.jobs.native_mac),
    /native windows-owner|build-owned-process-group/u,
  )
})
