import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CIAPI,
  providerScopes,
  requireTrustedWorkflowSource,
  ciJobs,
  checkWriterJob,
  platformKeys,
  executionAdmission,
  requiredJobsPassed,
  validateSourceRun,
  verifyReleaseOnlyChanges,
  verifyCandidateAttestation,
  requireLatestGeneration,
  latestGeneration,
  currentPrerequisitesPassed,
  requirePublishedChecks,
  providerJobs,
  main,
} from './ci-control.mjs'

const platformJobs = (job, purpose) => {
  assert.equal(job.name, '${{ matrix.label }} - ' + purpose)
  assert.deepEqual(
    job.strategy.matrix.include.map(({ key }) => key),
    platformKeys,
  )
  return job.strategy.matrix.include.map(({ label, platform, arch }) => {
    assert.equal(label, `${platform === 'darwin' ? 'macOS' : 'Windows'} ${arch}`)
    return `${label} - ${purpose}`
  })
}

void test('model environment secrets cross only the explicitly named reusable-workflow interface', async () => {
  const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
  const { load } = builderRequire('js-yaml')
  const root = load(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const provider = load(
    await readFile(new URL('../.github/workflows/provider-e2e.yml', import.meta.url), 'utf8'),
  )
  const required = ['PACT_CLAUDE_SETTINGS_JSON', 'PACT_CODEX_CONFIG_TOML', 'PACT_CODEX_AUTH_JSON']
  const names = [...required, 'PACT_CODEX_PROVIDER_ENV_JSON']
  assert.deepEqual(
    root.jobs.provider.secrets,
    Object.fromEntries(names.map((name) => [name, '${{ secrets.' + name + ' }}'])),
  )
  assert.deepEqual(
    provider.on.workflow_call.secrets,
    Object.fromEntries(names.map((name) => [name, { required: required.includes(name) }])),
  )
  assert.equal(
    provider.jobs.provider.environment,
    '${{ needs.admission.outputs.provider_environment }}',
  )
})

void test('readable workflow names match the exact jobs required by the trusted controller', async () => {
  const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
  const { load } = builderRequire('js-yaml')
  const root = load(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const provider = load(
    await readFile(new URL('../.github/workflows/provider-e2e.yml', import.meta.url), 'utf8'),
  )
  assert.deepEqual(ciJobs, [
    root.jobs.identity.name,
    root.jobs['candidate-attestation'].name,
    root.jobs.publication.name,
    root.jobs.quality.name,
    ...platformJobs(root.jobs.platform, 'UI and native tests'),
  ])
  assert.deepEqual(
    providerJobs,
    [provider.jobs.admission.name, ...platformJobs(provider.jobs.provider, 'Claude and Codex')].map(
      (name) => `${root.jobs.provider.name} / ${name}`,
    ),
  )
  assert.equal(root.jobs['check-writer'].name, checkWriterJob)
  // These contexts are already required by main protection and cannot be renamed alone.
  assert.equal(root.jobs.quality.name, 'quality')
  assert.equal(root.jobs.publication.name, 'publication')
  // A skipped ordinary-branch job must never produce the required PR context.
  const finalGate = root.jobs['pact-complete']
  const trustedCondition = finalGate.if.replace(/^always\(\) && /u, '')
  assert.equal(
    finalGate.name,
    '${{ ' +
      trustedCondition +
      " && 'PR checks complete' || 'PR checks not required for branch' }}",
  )
  for (const workflow of [root, provider])
    for (const job of Object.values(workflow.jobs).filter(
      (candidateJob) => candidateJob !== finalGate,
    ))
      if (!job.strategy) assert.ok(job.name && !job.name.includes('${{'))
})

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  candidate = 'c'.repeat(40),
  tree = 'd'.repeat(40)
const identity = {
  schemaVersion: 3,
  repository: 'mbaxszy7/Pact',
  repositoryId: 1416403312,
  headRepositoryId: 1416403312,
  pullRequest: 7,
  headSha: head,
  baseSha: base,
  candidateSha: candidate,
  treeSha: tree,
  policySha: base,
  sourceKind: 'main',
  controllerSha: base,
  controllerRef: 'refs/heads/main',
  product: {
    before: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
    after: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
  },
  authorId: 31481964,
  channel: 'dev',
}
const releaseProduct = {
  before: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
  after: { version: '0.1.0', candidateVersion: '0.1.0' },
}
function productFile(path, ref, product) {
  if (path === '.github/CODEOWNERS') {
    const bytes = Buffer.from('* @mbaxszy7\n')
    return {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      content: bytes.toString('base64'),
    }
  }
  const data = ref === base ? product.before : product.after
  const value =
    path === 'version.json'
      ? data
      : path === '.release-please-manifest.json'
        ? { '.': data.version }
        : { version: data.version }
  const bytes = Buffer.from(JSON.stringify(value))
  return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }
}
const commit = { sha: candidate, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] }
const currentFacts = { commit, mainSha: base }
const pr = {
  number: 7,
  state: 'open',
  user: { id: 31481964 },
  head: { sha: head, repo: { id: 1416403312 } },
  base: { sha: base, ref: 'main', repo: { id: 1416403312 } },
  merge_commit_sha: candidate,
}
const sourceRun = {
  id: 100,
  run_number: 10,
  run_attempt: 1,
  repository: { id: 1416403312, full_name: 'mbaxszy7/Pact' },
  workflow_id: 50,
  path: '.github/workflows/ci.yml',
  head_sha: head,
  event: 'pull_request_target',
  status: 'completed',
  conclusion: 'success',
  pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
}

void test('only the fixed base CI workflow can supply candidate evidence', () => {
  validateSourceRun(sourceRun, identity, 50)
  for (const change of [
    { workflow_id: 51 },
    { path: 'anything.yml' },
    { head_sha: base },
    { event: 'workflow_dispatch' },
    { status: 'in_progress' },
    { pull_requests: [{ number: 8, head: { sha: head }, base: { sha: base } }] },
  ])
    assert.throws(() => validateSourceRun({ ...sourceRun, ...change }, identity, 50))
  assert.throws(
    () => validateSourceRun({ ...sourceRun, workflow_id: undefined }, identity, undefined),
    /unresolved/,
  )
})

void test('an older run/attempt cannot publish after a newer same-PR failure or an ambiguous newer run', () => {
  requireLatestGeneration([sourceRun], sourceRun, identity)
  const newer = { ...sourceRun, id: 101, run_number: 11, conclusion: 'failure' }
  assert.throws(
    () => requireLatestGeneration([sourceRun, newer], sourceRun, identity),
    /newer CI run/,
  )
  assert.throws(
    () =>
      requireLatestGeneration([sourceRun, { ...newer, pull_requests: [] }], sourceRun, identity),
    /ambiguous PR association/,
  )
  assert.throws(
    () => requireLatestGeneration([{ ...sourceRun, run_attempt: 2 }], sourceRun, identity),
    /attempt is obsolete/,
  )
  requireLatestGeneration(
    [sourceRun, { ...newer, pull_requests: [{ number: 8 }] }],
    sourceRun,
    identity,
  )
})

void test('the API freshness guard must not replace an old successful evidence attempt with a new running attempt', async () => {
  const newer = { ...sourceRun, run_attempt: 2, status: 'in_progress', conclusion: null }
  const api = { path: (suffix) => suffix, request: async () => newer, list: async () => [newer] }
  await assert.rejects(
    latestGeneration(api, identity, sourceRun),
    /attempt changed after evidence capture/,
  )
})

void test('frozen bootstrap generations are scoped to their exact push ref without ambiguous PR metadata', () => {
  const bootstrap = {
    ...identity,
    sourceKind: 'bootstrap',
    controllerSha: head,
    controllerRef: `refs/heads/codex/pact-ci-bootstrap-${head.slice(0, 12)}`,
    policySha: head,
  }
  const run = {
    ...sourceRun,
    event: 'push',
    head_branch: bootstrap.controllerRef.slice('refs/heads/'.length),
    pull_requests: [],
  }
  requireLatestGeneration([run], run, bootstrap)
  const newer = { ...run, id: 101, run_number: 11, conclusion: 'failure' }
  assert.throws(
    () => requireLatestGeneration([run, newer], run, bootstrap),
    /newer frozen bootstrap/,
  )
  requireLatestGeneration(
    [run, { ...newer, head_branch: 'codex/another-branch-with-the-same-head' }],
    run,
    bootstrap,
  )
  assert.throws(
    () => requireLatestGeneration([run, { ...newer, head_branch: undefined }], run, bootstrap),
    /metadata is unresolved/,
  )
  assert.throws(
    () => requireLatestGeneration([{ ...run, run_attempt: 2 }], run, bootstrap),
    /attempt is obsolete/,
  )
})

void test('logical run numbers order generations independently of unique run IDs', () => {
  const newer = { ...sourceRun, id: 99, run_number: 11, conclusion: 'cancelled' }
  assert.throws(
    () => requireLatestGeneration([sourceRun, newer], sourceRun, identity),
    /newer CI run/,
  )
  requireLatestGeneration(
    [sourceRun, { ...sourceRun, id: 999, run_number: 9, run_attempt: 2 }],
    sourceRun,
    identity,
  )
  for (const run_number of [undefined, 0, -1, 1.5])
    assert.throws(() =>
      requireLatestGeneration([{ ...sourceRun, run_number }], sourceRun, identity),
    )
  assert.throws(
    () => requireLatestGeneration([sourceRun, { ...sourceRun, id: 101 }], sourceRun, identity),
    /generation identity/,
  )
})

void test('missing scope metadata on a newer failed generation is ambiguous rather than unrelated', () => {
  for (const field of ['event', 'head_sha', 'workflow_id']) {
    for (const value of [undefined, null, 0, -1, 1.5, {}, '']) {
      const newer = { ...sourceRun, id: 101, run_number: 11, conclusion: 'failure', [field]: value }
      assert.throws(
        () => requireLatestGeneration([sourceRun, newer], sourceRun, identity),
        /metadata|unresolved/,
      )
    }
  }
  for (const pull_requests of [[{}], [{ number: 0 }], [{ number: '7' }]])
    assert.throws(
      () =>
        requireLatestGeneration(
          [
            sourceRun,
            { ...sourceRun, id: 101, run_number: 11, conclusion: 'failure', pull_requests },
          ],
          sourceRun,
          identity,
        ),
      /ambiguous/,
    )
})

void test('a truncated Release file inventory cannot authorize paid execution through the trusted admit entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-admission-'))
  const originalFetch = globalThis.fetch
  const releaseIdentity = {
    ...identity,
    authorId: 342242262,
    channel: 'stable',
    product: {
      before: { version: '0.1.0', candidateVersion: '0.1.0' },
      after: { version: '0.2.0', candidateVersion: '0.2.0' },
    },
  }
  const releasePr = {
    ...pr,
    title: 'chore(main): release 0.2.0',
    changed_files: 6,
    user: { id: 342242262, type: 'Bot' },
    head: { ...pr.head, ref: 'release-please--branches--main' },
  }
  const proof = {
    id: 500,
    name: 'pact-candidate-identity',
    external_id: 'pact-ci:100:1:candidate',
    app: { id: 1234 },
    status: 'completed',
    conclusion: 'neutral',
    head_sha: head,
    output: {
      summary: JSON.stringify({
        schemaVersion: 1,
        workflowRunId: 100,
        workflowAttempt: 1,
        identity: releaseIdentity,
      }),
    },
  }
  try {
    const path = join(root, 'identity.json')
    await writeFile(path, JSON.stringify(releaseIdentity), { flag: 'wx', mode: 0o600 })
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'GET', 'admission must have no publication side effects')
      const parsed = new URL(url),
        endpoint = parsed.pathname.replace('/repos/mbaxszy7/Pact', '')
      let response
      if (endpoint === '/actions/runs/100') response = { ...sourceRun, conclusion: 'success' }
      else if (endpoint === '/actions/workflows/ci.yml') response = { id: 50 }
      else if (endpoint === '/actions/workflows/50/runs')
        response = { total_count: 1, workflow_runs: [sourceRun] }
      else if (endpoint === '/pulls/7') response = releasePr
      else if (endpoint === `/git/commits/${candidate}`) response = commit
      else if (endpoint === `/git/commits/${base}`)
        response = { sha: base, tree: { sha: 'f'.repeat(40) } }
      else if (endpoint === '/git/ref/heads/main')
        response = { ref: 'refs/heads/main', object: { type: 'commit', sha: base } }
      else if (endpoint === `/commits/${head}/check-runs`)
        response = { total_count: 1, check_runs: [proof] }
      else if (endpoint === '/actions/runs/100/attempts/1/jobs')
        response = {
          total_count: ciJobs.length,
          jobs: ciJobs.map((name, index) => ({
            id: index + 1,
            name,
            status: 'completed',
            conclusion: 'success',
            run_id: 100,
            run_attempt: 1,
          })),
        }
      else if (endpoint === '/users/mbaxszy7')
        response = { id: 31481964, login: 'mbaxszy7', type: 'User' }
      else if (endpoint === '/users/pact-ci-mbaxszy7%5Bbot%5D')
        response = { id: 342242262, type: 'Bot' }
      else if (endpoint === '/pulls/7/files')
        response = [{ filename: 'version.json', status: 'modified' }]
      else if (endpoint.startsWith('/contents/')) {
        const file = endpoint.slice('/contents/'.length),
          version = parsed.searchParams.get('ref') === base ? '0.1.0' : '0.2.0'
        const value =
          file === '.release-please-manifest.json'
            ? { '.': version }
            : file === 'version.json'
              ? { version, candidateVersion: version }
              : { version }
        const bytes = Buffer.from(
          file === '.github/CODEOWNERS' ? '* @mbaxszy7\n' : JSON.stringify(value),
        )
        response = {
          type: 'file',
          encoding: 'base64',
          size: bytes.length,
          content: bytes.toString('base64'),
        }
      } else throw new Error(`Unexpected fixture endpoint: ${endpoint}`)
      return new Response(JSON.stringify(response))
    }
    await assert.rejects(
      main(['admit', '--identity', path, '--run', '100'], {
        GH_TOKEN: 'nonfunctional-fixture',
        PACT_CI_APP_ID: '1234',
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: base,
        GITHUB_RUN_ID: '100',
        GITHUB_RUN_ATTEMPT: '1',
        PACT_EXPECTED_CI_ATTEMPT: '1',
        PACT_RELEASE_APP_BOT_ID: '342242262',
        PACT_RELEASE_APP_SLUG: 'pact-ci-mbaxszy7',
        GITHUB_OUTPUT: join(root, 'outputs'),
      }),
      /complete|unexpected|inventory/,
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

void test('failure, cancellation, skip, missing, duplicate and unfinished required jobs never pass', () => {
  const jobs = ciJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
  assert.equal(requiredJobsPassed(jobs, ciJobs), true)
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null])
    assert.equal(requiredJobsPassed([{ ...jobs[0], conclusion }, ...jobs.slice(1)], ciJobs), false)
  assert.equal(requiredJobsPassed(jobs.slice(1), ciJobs), false)
  assert.equal(requiredJobsPassed([...jobs, jobs[0]], ciJobs), false)
  assert.equal(
    requiredJobsPassed([{ ...jobs[0], status: 'in_progress' }, ...jobs.slice(1)], ciJobs),
    false,
  )
})

void test('external sources can only queue for the reviewed environment; review-like inputs cannot grant secrets', () => {
  assert.equal(
    executionAdmission(identity, pr, currentFacts).providerEnvironment,
    'pact-provider-ci',
  )
  const outsider = { ...pr, user: { id: 999 } },
    outsiderIdentity = { ...identity, authorId: 999 }
  assert.equal(
    executionAdmission(outsiderIdentity, outsider, {
      ...currentFacts,
      manual: true,
      actorId: 31481964,
    }).providerEnvironment,
    'pact-provider-reviewed-ci',
  )
  const fork = { ...pr, head: { ...pr.head, repo: { id: 1 } } }
  assert.equal(
    executionAdmission({ ...identity, headRepositoryId: 1 }, fork, currentFacts)
      .providerEnvironment,
    'pact-provider-reviewed-ci',
  )
  assert.throws(
    () =>
      executionAdmission(
        outsiderIdentity,
        { ...outsider, head: { ...outsider.head, sha: base } },
        currentFacts,
      ),
    /exact current/,
  )
})

void test('automatic Release App execution admits only synchronized version-field changes', () => {
  const before = {
    'package.json': { name: 'pact', scripts: { test: 'vitest run' }, version: '0.1.0' },
    'apps/desktop/package.json': { name: 'desktop', version: '0.1.0' },
    'version.json': { version: '0.1.0', candidateVersion: '0.1.0' },
    '.release-please-manifest.json': { '.': '0.1.0' },
  }
  const after = {
    'package.json': { ...before['package.json'], version: '0.2.0' },
    'apps/desktop/package.json': { ...before['apps/desktop/package.json'], version: '0.2.0' },
    'version.json': { version: '0.2.0', candidateVersion: '0.2.0' },
    '.release-please-manifest.json': { '.': '0.2.0' },
  }
  assert.equal(verifyReleaseOnlyChanges(before, after), '0.2.0')
  assert.throws(
    () =>
      verifyReleaseOnlyChanges(before, {
        ...after,
        'package.json': { ...after['package.json'], scripts: { test: 'true' } },
      }),
    /beyond/,
  )
  assert.throws(() =>
    verifyReleaseOnlyChanges(before, { ...after, 'version.json': { version: '0.1.0' } }),
  )
})

void test('API pagination establishes a complete job inventory rather than stopping after the first page', async () => {
  const calls = []
  const api = new CIAPI('nonfunctional-fixture', async (url) => {
    calls.push(url)
    return new Response(
      JSON.stringify({
        total_count: 101,
        jobs: calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }],
      }),
      {
        headers:
          calls.length === 1 ? { link: `<${url.replace('&page=1', '&page=2')}>; rel="next"` } : {},
      },
    )
  })
  assert.equal((await api.list(api.path('/actions/runs/100/jobs'), 'jobs')).length, 101)
  assert.equal(calls.length, 2)
  assert(calls[1].includes('page=2'))
})

void test('short pages, changing totals and the filtered Actions search ceiling cannot masquerade as complete evidence', async () => {
  for (const payload of [
    { total_count: 2, workflow_runs: [{ id: 1 }] },
    { total_count: 1000, workflow_runs: [{ id: 1 }] },
    { workflow_runs: [{ id: 1 }] },
  ]) {
    const api = new CIAPI(
      'nonfunctional-fixture',
      async () => new Response(JSON.stringify(payload)),
    )
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each fixed malformed evidence case must fail before the next fixture.
    await assert.rejects(
      api.list(api.path('/actions/workflows/50/runs?event=pull_request_target'), 'workflow_runs'),
      /complete|ceiling|total/,
    )
  }
  let page = 0
  const changed = new CIAPI('nonfunctional-fixture', async (url) => {
    page++
    return new Response(
      JSON.stringify({
        total_count: page === 1 ? 101 : 102,
        jobs:
          page === 1
            ? Array.from({ length: 100 }, (_, id) => ({ id }))
            : [{ id: 100 }, { id: 101 }],
      }),
      { headers: page === 1 ? { link: `<${url.replace('&page=1', '&page=2')}>; rel="next"` } : {} },
    )
  })
  await assert.rejects(
    changed.list(changed.path('/actions/runs/100/jobs'), 'jobs'),
    /total changed/,
  )
})

void test('Link pagination is followed even for a short page, with no foreign origin or repeated entries admitted', async () => {
  let page = 0
  const complete = new CIAPI('nonfunctional-fixture', async (url) => {
    page++
    return new Response(JSON.stringify({ total_count: 2, check_runs: [{ id: page }] }), {
      headers: page === 1 ? { link: `<${url.replace('&page=1', '&page=2')}>; rel="next"` } : {},
    })
  })
  assert.equal(
    (
      await complete.list(
        complete.path(`/commits/${candidate}/check-runs?filter=all`),
        'check_runs',
      )
    ).length,
    2,
  )
  for (const next of [
    'https://foreign.example/list?page=2',
    `https://api.github.com/repos/mbaxszy7/Pact/actions/runs/100/jobs?per_page=100&page=1`,
  ]) {
    const invalid = new CIAPI(
      'nonfunctional-fixture',
      async () =>
        new Response(JSON.stringify({ total_count: 2, jobs: [{ id: 1 }] }), {
          headers: { link: `<${next}>; rel="next"` },
        }),
    )
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each forbidden link is a separate fixed trust-boundary fixture.
    await assert.rejects(invalid.list(invalid.path('/actions/runs/100/jobs'), 'jobs'), /pagination/)
  }
  page = 0
  const duplicate = new CIAPI('nonfunctional-fixture', async (url) => {
    page++
    return new Response(JSON.stringify({ total_count: 2, jobs: [{ id: 1 }] }), {
      headers: page === 1 ? { link: `<${url.replace('&page=1', '&page=2')}>; rel="next"` } : {},
    })
  })
  await assert.rejects(
    duplicate.list(duplicate.path('/actions/runs/100/jobs'), 'jobs'),
    /duplicate/,
  )
})

void test('a runtime artifact cannot replace the fixed-App receipt or another run/PR identity', () => {
  const check = {
    name: 'pact-candidate-identity',
    external_id: 'pact-ci:100:1:candidate',
    app: { id: 1234 },
    status: 'completed',
    conclusion: 'neutral',
    head_sha: head,
    output: {
      summary: JSON.stringify({
        schemaVersion: 1,
        workflowRunId: 100,
        workflowAttempt: 1,
        identity,
      }),
    },
  }
  verifyCandidateAttestation([check], identity, sourceRun, 1234)
  for (const changed of [
    { app: { id: 999 } },
    { head_sha: candidate },
    { status: 'in_progress' },
    { conclusion: 'success' },
    { external_id: 'pact-ci:101:1:candidate' },
  ])
    assert.throws(() =>
      verifyCandidateAttestation([{ ...check, ...changed }], identity, sourceRun, 1234),
    )
  assert.throws(
    () => verifyCandidateAttestation([check, check], identity, sourceRun, 1234),
    /unique/,
  )
  for (const changed of [
    { ...identity, pullRequest: 8 },
    { ...identity, candidateSha: 'e'.repeat(40) },
  ])
    assert.throws(() => verifyCandidateAttestation([check], changed, sourceRun, 1234), /disagrees/)
  assert.throws(
    () => verifyCandidateAttestation([check], identity, { ...sourceRun, run_attempt: 2 }, 1234),
    /unique/,
  )
})

await test('ordinary PRs require core and optional full regression cannot weaken Release PRs', () => {
  assert.deepEqual(providerScopes({ ...identity, channel: 'dev' }), { suite: 'core', gate: 'core' })
  assert.deepEqual(providerScopes({ ...identity, channel: 'dev' }, 'full'), {
    suite: 'full',
    gate: 'core',
  })
  assert.deepEqual(
    providerScopes({ ...identity, channel: 'stable', product: releaseProduct }, 'core'),
    {
      suite: 'full',
      gate: 'full',
    },
  )
  assert.deepEqual(
    providerScopes({ ...identity, channel: 'stable', product: releaseProduct }, 'full'),
    {
      suite: 'full',
      gate: 'full',
    },
  )
  assert.throws(() => providerScopes(identity, 'skip'), /core or full/)
})

await test('REST pull_request_target head is candidate head, distinct from the trusted base workflow source', () => {
  validateSourceRun({ ...sourceRun, head_sha: identity.headSha, pull_requests: [] }, identity, 50)
  assert.throws(() => validateSourceRun({ ...sourceRun, head_sha: identity.baseSha }, identity, 50))
})

await test('trusted base workflow provenance is a separate signed-job claim, not REST head metadata', () => {
  const env = {
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: base,
  }
  requireTrustedWorkflowSource(identity, env)
  for (const change of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: head },
    { GITHUB_SHA: undefined },
  ])
    assert.throws(
      () => requireTrustedWorkflowSource(identity, { ...env, ...change }),
      /does not match/,
    )
})

await test('one running root graph can admit completed prerequisites without a circular overall-success requirement', () => {
  const run = { ...sourceRun, status: 'in_progress', conclusion: null }
  const jobs = ciJobs.map((name, id) => ({
    id: id + 1,
    name,
    status: 'completed',
    conclusion: 'success',
    run_id: run.id,
    run_attempt: run.run_attempt,
  }))
  assert.equal(currentPrerequisitesPassed(jobs, run), true)
  for (const state of ['failure', 'cancelled', 'skipped', 'neutral', null])
    assert.equal(
      currentPrerequisitesPassed([{ ...jobs[0], conclusion: state }, ...jobs.slice(1)], run),
      false,
    )
  for (const changes of [
    { run_attempt: 2 },
    { run_id: 200 },
    { run_attempt: undefined },
    { status: 'queued' },
  ])
    assert.equal(
      currentPrerequisitesPassed([{ ...jobs[0], ...changes }, ...jobs.slice(1)], run),
      false,
    )
  assert.equal(currentPrerequisitesPassed(jobs.slice(1), run), false)
  assert.equal(currentPrerequisitesPassed([...jobs, jobs[0]], run), false)
  assert.equal(
    currentPrerequisitesPassed(jobs, { ...run, status: 'completed', conclusion: 'cancelled' }),
    false,
  )
})

await test('completion requires unique current-attempt fixed-App successes for this PR on H', () => {
  const checks = ['pact-ci', 'provider-e2e'].map((name, index) => ({
    id: index + 1,
    name,
    app: { id: 1234 },
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
    external_id: `pact:7:${head}:${base}:100:1:${name}`,
  }))
  requirePublishedChecks(checks, identity, sourceRun, 1234)
  for (const changes of [
    { app: { id: 999 } },
    { head_sha: candidate },
    { conclusion: 'neutral' },
    { conclusion: 'skipped' },
    { conclusion: 'cancelled' },
    { status: 'in_progress' },
  ])
    assert.throws(() =>
      requirePublishedChecks([{ ...checks[0], ...changes }, checks[1]], identity, sourceRun, 1234),
    )
  assert.throws(() => requirePublishedChecks([checks[0]], identity, sourceRun, 1234))
  assert.throws(() => requirePublishedChecks([...checks, checks[0]], identity, sourceRun, 1234))
  assert.throws(() =>
    requirePublishedChecks(checks, { ...identity, pullRequest: 8 }, sourceRun, 1234),
  )
  assert.throws(() =>
    requirePublishedChecks(checks, identity, { ...sourceRun, run_attempt: 2 }, 1234),
  )
})

await test('the trusted primary admission, writer and completion interfaces share the same root and attempt', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-single-graph-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'identity.json'),
    outputs = join(root, 'outputs')
  await writeFile(path, JSON.stringify(identity))
  const run = { ...sourceRun, status: 'in_progress', conclusion: null }
  const proof = {
    id: 500,
    name: 'pact-candidate-identity',
    app: { id: 1234 },
    head_sha: head,
    external_id: 'pact-ci:100:1:candidate',
    status: 'completed',
    conclusion: 'neutral',
    output: {
      summary: JSON.stringify({
        schemaVersion: 1,
        workflowRunId: 100,
        workflowAttempt: 1,
        identity,
      }),
    },
  }
  let jobs = [...ciJobs, ...providerJobs, checkWriterJob].map((name, index) => ({
    id: index + 1,
    name,
    status: 'completed',
    conclusion: 'success',
    run_id: 100,
    run_attempt: 1,
  }))
  const checks = [proof],
    writes = [],
    requests = []
  const original = globalThis.fetch
  context.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace('/repos/mbaxszy7/Pact', '')
    requests.push(endpoint)
    let response
    if (options.method === 'POST' && endpoint === '/check-runs') {
      const body = JSON.parse(options.body)
      response = { id: 501 + writes.length, app: { id: 1234 }, ...body }
      checks.push(response)
      writes.push(body)
    } else if (options.method === 'PATCH') {
      const check = checks.find((item) => endpoint === `/check-runs/${item.id}`)
      assert.ok(check)
      Object.assign(check, JSON.parse(options.body))
      response = check
    } else if (endpoint === '/actions/runs/100') response = run
    else if (endpoint === '/actions/workflows/ci.yml') response = { id: 50 }
    else if (endpoint === '/actions/workflows/50/runs')
      response = { total_count: 1, workflow_runs: [run] }
    else if (endpoint === '/pulls/7') response = pr
    else if (endpoint === `/git/commits/${candidate}`) response = commit
    else if (endpoint === `/git/commits/${base}`)
      response = { sha: base, tree: { sha: 'f'.repeat(40) } }
    else if (endpoint === '/git/ref/heads/main')
      response = { ref: 'refs/heads/main', object: { type: 'commit', sha: base } }
    else if (endpoint === `/commits/${head}/check-runs`)
      response = { total_count: checks.length, check_runs: checks }
    else if (endpoint === '/actions/runs/100/attempts/1/jobs')
      response = { total_count: jobs.length, jobs }
    else if (endpoint === '/users/mbaxszy7')
      response = { id: 31481964, login: 'mbaxszy7', type: 'User' }
    else if (endpoint.startsWith('/contents/'))
      response = productFile(
        endpoint.slice('/contents/'.length),
        new URL(url).searchParams.get('ref'),
        identity.product,
      )
    else throw new Error(`Unexpected fixed fixture endpoint: ${endpoint}`)
    return new Response(JSON.stringify(response))
  }
  const env = {
    GH_TOKEN: 'nonfunctional-fixture',
    PACT_CI_APP_ID: '1234',
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: base,
    GITHUB_RUN_ID: '100',
    GITHUB_RUN_ATTEMPT: '1',
    PACT_EXPECTED_CI_ATTEMPT: '1',
    PACT_PROVIDER_SUITE: 'core',
    PACT_PROVIDER_ALLOWED: 'true',
    GITHUB_OUTPUT: outputs,
  }
  const args = (mode) => [mode, '--identity', path, '--run', '100']
  await main(args('admit'), env)
  assert.match(await readFile(outputs, 'utf8'), /provider_environment=pact-provider-ci/)
  await main(args('preflight'), env)
  await main(args('publish'), env)
  await main(args('complete'), env)
  assert.deepEqual(
    writes.map((item) => item.name),
    ['pact-ci', 'provider-e2e'],
  )
  assert(writes.every((item) => item.head_sha === head))
  assert(requests.includes('/actions/runs/100/attempts/1/jobs'))
  assert(!requests.some((item) => item.includes('provider-e2e.yml')))
  jobs = jobs.map((item) =>
    item.name === 'Real model tests / Windows arm64 - Claude and Codex'
      ? Object.assign({}, item, { conclusion: 'skipped' })
      : item,
  )
  await assert.rejects(main(args('complete'), env), /Every mandatory job/)
  await assert.rejects(main(args('admit'), { ...env, GITHUB_RUN_ID: '200' }), /one CI graph/)
  await assert.rejects(
    main(args('preflight'), { ...env, PACT_EXPECTED_CI_ATTEMPT: '2' }),
    /obsolete attempt/,
  )
})
