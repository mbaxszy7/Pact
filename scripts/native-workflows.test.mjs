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
const setup = load(
  await readFile(new URL('../.github/actions/setup/action.yml', import.meta.url), 'utf8'),
)
const commands = (job) => job.steps?.map((step) => step.run ?? '').join('\n') ?? ''
const upload = (job) =>
  job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
const downloads = (job) =>
  job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'))

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
    'package_mac',
    'package_win',
    'smoke_mac',
    'smoke_win',
    'real_mac',
    'real_win',
    'complete',
  ]
  assert.deepEqual(Object.keys(distribution.jobs).toSorted(), expectedJobs.toSorted())
  for (const [suffix, runner] of [
    ['mac', 'macos-15'],
    ['win', 'windows-2025'],
  ]) {
    const native = distribution.jobs[`native_${suffix}`]
    const pack = distribution.jobs[`package_${suffix}`]
    const smoke = distribution.jobs[`smoke_${suffix}`]
    const real = distribution.jobs[`real_${suffix}`]
    for (const job of [native, pack, smoke, real]) {
      assert.equal(job['runs-on'], runner)
      assert.equal(job.strategy, undefined)
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
  assert.equal(complete.needs.length, 9)
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
          assert.ok(['real_mac', 'real_win'].includes(name))
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
  assert.equal(downloads(delivery).length, 4)
  assert.equal(upload(delivery).length, 1)
  assert.match(commands(delivery), /ci-artifacts\.mjs verify/u)
  assert.doesNotMatch(
    commands(delivery),
    /build-distribution|package-smoke|ci\.mjs (real|native|build)/u,
  )
  assert.deepEqual(release.on, { push: { branches: ['main'] } })
  assert.deepEqual(publish.needs, ['resolve', 'validate'])
  assert.equal(downloads(publish).length, 4)
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
    'pull-requests': 'read',
    actions: 'read',
  })
  const command = publish.steps.find((step) => step.run?.includes('release-native.mjs publish'))
  const artifacts = JSON.parse(command.env.PACT_RELEASE_ARTIFACTS_JSON)
  assert.deepEqual(Object.keys(artifacts).toSorted(), ['darwin-arm64', 'win32-x64'])
  for (const [platform, suffix] of [
    ['darwin-arm64', 'mac'],
    ['win32-x64', 'win'],
  ]) {
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
