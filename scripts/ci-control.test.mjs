import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CIAPI,
  providerScopes,
  ciJobs,
  executionAdmission,
  requiredJobsPassed,
  validateSourceRun,
  verifyReleaseOnlyChanges,
  verifyCandidateAttestation,
  requireLatestGeneration,
  latestGeneration,
  requireLatestProviderGeneration,
  main,
} from './ci-control.mjs'

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  candidate = 'c'.repeat(40),
  tree = 'd'.repeat(40)
const identity = {
  schemaVersion: 2,
  repository: 'mbaxszy7/Pact',
  repositoryId: 1416403312,
  headRepositoryId: 1416403312,
  pullRequest: 7,
  headSha: head,
  baseSha: base,
  candidateSha: candidate,
  treeSha: tree,
  policySha: base,
  authorId: 31481964,
  channel: 'dev',
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
  head_sha: base,
  event: 'pull_request_target',
  status: 'completed',
  pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
}

void test('only the fixed base CI workflow can supply candidate evidence', () => {
  validateSourceRun(sourceRun, identity, 50)
  for (const change of [
    { workflow_id: 51 },
    { path: 'anything.yml' },
    { head_sha: head },
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

void test('a late successful Provider writer cannot replace a newer failed dispatch or rerun', () => {
  const original = { ...sourceRun, id: 200, workflow_id: 75, head_branch: 'main' }
  requireLatestProviderGeneration([original], original)
  assert.throws(
    () =>
      requireLatestProviderGeneration(
        [original, { ...original, id: 201, run_number: 11, conclusion: 'failure' }],
        original,
      ),
    /newer Provider run/,
  )
  assert.throws(
    () => requireLatestProviderGeneration([{ ...original, run_attempt: 2 }], original),
    /attempt is obsolete/,
  )
})

void test('logical run numbers order generations independently of unique run IDs', () => {
  const newer = { ...sourceRun, id: 99, run_number: 11, conclusion: 'cancelled' }
  assert.throws(
    () => requireLatestGeneration([sourceRun, newer], sourceRun, identity),
    /newer CI run/,
  )
  assert.throws(
    () =>
      requireLatestProviderGeneration(
        [
          Object.assign({}, sourceRun, { head_branch: 'main' }),
          Object.assign({}, newer, { head_branch: 'main' }),
        ],
        { ...sourceRun, head_branch: 'main' },
      ),
    /newer Provider run/,
  )
  const older = { ...sourceRun, id: 999, run_number: 9, run_attempt: 2 }
  requireLatestGeneration([sourceRun, older], sourceRun, identity)
  requireLatestProviderGeneration(
    [
      { ...sourceRun, head_branch: 'main' },
      { ...older, head_branch: 'main' },
    ],
    { ...sourceRun, head_branch: 'main' },
  )
  for (const run_number of [undefined, 0, -1, 1.5]) {
    assert.throws(() =>
      requireLatestGeneration([{ ...sourceRun, run_number }], sourceRun, identity),
    )
    assert.throws(() =>
      requireLatestProviderGeneration([{ ...sourceRun, run_number, head_branch: 'main' }], {
        ...sourceRun,
        head_branch: 'main',
      }),
    )
  }
  const conflicting = { ...sourceRun, id: 101 }
  assert.throws(
    () => requireLatestGeneration([sourceRun, conflicting], sourceRun, identity),
    /generation identity/,
  )
  assert.throws(
    () =>
      requireLatestProviderGeneration(
        [
          { ...sourceRun, head_branch: 'main' },
          { ...conflicting, head_branch: 'main' },
        ],
        { ...sourceRun, head_branch: 'main' },
      ),
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
  const provider = { ...sourceRun, head_branch: 'main' }
  for (const field of ['head_branch', 'head_sha', 'workflow_id']) {
    for (const value of [undefined, null, 0, -1, 1.5, {}, '']) {
      const newer = { ...provider, id: 101, run_number: 11, conclusion: 'failure', [field]: value }
      assert.throws(
        () => requireLatestProviderGeneration([provider, newer], provider),
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
  const releaseIdentity = { ...identity, authorId: 342242262, channel: 'stable' }
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
    head_sha: candidate,
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
      else if (endpoint === '/git/ref/heads/main')
        response = { ref: 'refs/heads/main', object: { type: 'commit', sha: base } }
      else if (endpoint === `/commits/${candidate}/check-runs`)
        response = { total_count: 1, check_runs: [proof] }
      else if (endpoint === '/actions/runs/100/attempts/1/jobs')
        response = {
          total_count: ciJobs.length,
          jobs: ciJobs.map((name, index) => ({
            id: index + 1,
            name,
            status: 'completed',
            conclusion: 'success',
          })),
        }
      else if (endpoint === '/users/pact-ci-mbaxszy7%5Bbot%5D')
        response = { id: 342242262, type: 'Bot' }
      else if (endpoint === '/pulls/7/files')
        response = [{ filename: 'version.json', status: 'modified' }]
      else if (endpoint.startsWith('/contents/')) {
        const file = endpoint.slice('/contents/'.length),
          version = parsed.searchParams.get('ref') === base ? '0.1.0' : '0.2.0'
        const value = file === '.release-please-manifest.json' ? { '.': version } : { version }
        const bytes = Buffer.from(JSON.stringify(value))
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

void test('a fork or different API author needs owner authorization for the exact head/base/code tree', () => {
  assert.equal(executionAdmission(identity, pr, currentFacts).allowed, true)
  assert.equal(
    executionAdmission(
      { ...identity, headRepositoryId: 1 },
      { ...pr, head: { ...pr.head, repo: { id: 1 } } },
      currentFacts,
    ).allowed,
    false,
  )
  const outsider = { ...pr, user: { id: 999 } },
    outsiderIdentity = { ...identity, authorId: 999 }
  assert.equal(executionAdmission(outsiderIdentity, outsider, currentFacts).allowed, false)
  const grant = {
    ...currentFacts,
    manual: true,
    actorId: 31481964,
    headSha: head,
    baseSha: base,
    treeSha: tree,
  }
  assert.equal(executionAdmission(outsiderIdentity, outsider, grant).allowed, true)
  for (const change of [{ actorId: 999 }, { headSha: base }, { baseSha: head }, { treeSha: head }])
    assert.throws(() => executionAdmission(outsiderIdentity, outsider, { ...grant, ...change }))
  assert.throws(
    () =>
      executionAdmission(
        outsiderIdentity,
        { ...outsider, head: { ...outsider.head, sha: base } },
        grant,
      ),
    /exact current/,
  )
})

void test('automatic Release App execution admits only synchronized version-field changes', () => {
  const before = {
    'package.json': { name: 'pact', scripts: { test: 'vitest run' }, version: '0.1.0' },
    'apps/desktop/package.json': { name: 'desktop', version: '0.1.0' },
    'version.json': { version: '0.1.0' },
    '.release-please-manifest.json': { '.': '0.1.0' },
  }
  const after = {
    'package.json': { ...before['package.json'], version: '0.2.0' },
    'apps/desktop/package.json': { ...before['apps/desktop/package.json'], version: '0.2.0' },
    'version.json': { version: '0.2.0' },
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
    head_sha: candidate,
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
    { head_sha: head },
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
  assert.throws(
    () => verifyCandidateAttestation([check], { ...identity, pullRequest: 8 }, sourceRun, 1234),
    /disagrees/,
  )
})

void test('Provider dispatch startup revokes prior success through the fixed App; obsolete attempts cannot write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-provider-start-'))
  const originalFetch = globalThis.fetch
  const providerRun = {
    ...sourceRun,
    id: 200,
    workflow_id: 75,
    event: 'workflow_dispatch',
    head_branch: 'main',
    path: '.github/workflows/provider-e2e.yml',
    status: 'in_progress',
  }
  const proof = {
    name: 'pact-candidate-identity',
    external_id: 'pact-ci:100:1:candidate',
    app: { id: 1234 },
    status: 'completed',
    conclusion: 'neutral',
    head_sha: candidate,
    output: {
      summary: JSON.stringify({
        schemaVersion: 1,
        workflowRunId: 100,
        workflowAttempt: 1,
        identity,
      }),
    },
  }
  const writes = []
  let actualRun = providerRun,
    newerRun
  try {
    const path = join(root, 'identity.json')
    await writeFile(path, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(url).pathname.replace('/repos/mbaxszy7/Pact', '')
      let response
      if (options.method !== 'GET') {
        writes.push({ endpoint, ...JSON.parse(options.body) })
        response = { id: 550, app: { id: 1234 } }
      } else if (endpoint === '/actions/runs/100') response = sourceRun
      else if (endpoint === '/actions/runs/200') response = actualRun
      else if (endpoint === '/actions/workflows/ci.yml') response = { id: 50 }
      else if (endpoint === '/actions/workflows/provider-e2e.yml') response = { id: 75 }
      else if (endpoint === '/actions/workflows/50/runs')
        response = { total_count: 1, workflow_runs: [sourceRun] }
      else if (endpoint === '/actions/workflows/75/runs')
        response = {
          total_count: newerRun ? 2 : 1,
          workflow_runs: newerRun ? [actualRun, newerRun] : [actualRun],
        }
      else if (endpoint === '/pulls/7') response = pr
      else if (endpoint === `/git/commits/${candidate}`) response = commit
      else if (endpoint === '/git/ref/heads/main')
        response = { ref: 'refs/heads/main', object: { type: 'commit', sha: base } }
      else if (endpoint === `/commits/${candidate}/check-runs`)
        response = { total_count: 1, check_runs: [{ id: 500, ...proof }] }
      else if (endpoint === '/actions/runs/100/attempts/1/jobs')
        response = { total_count: 0, jobs: [] }
      else throw new Error(`Unexpected fixture endpoint: ${endpoint}`)
      return new Response(JSON.stringify(response))
    }
    const args = ['provider-start', '--identity', path, '--run', '100']
    const env = {
      GH_TOKEN: 'nonfunctional-fixture',
      PACT_CI_APP_ID: '1234',
      GITHUB_RUN_ID: '200',
      GITHUB_RUN_ATTEMPT: '1',
    }
    await main(args, env)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].name, 'provider-e2e')
    assert.equal(writes[0].head_sha, candidate)
    assert.equal(writes[1].status, 'completed')
    assert.equal(writes[1].conclusion, 'failure')
    writes.length = 0
    await assert.rejects(main(args, { ...env, GITHUB_RUN_ATTEMPT: '2' }), /exact current/)
    assert.equal(writes.length, 0)
    actualRun = { ...providerRun, path: '.github/workflows/other.yml' }
    await assert.rejects(main(args, env), /exact current/)
    assert.equal(writes.length, 0)
    actualRun = providerRun
    newerRun = { ...providerRun, id: 201, run_number: 11 }
    await assert.rejects(main(args, env), /newer Provider run/)
    assert.equal(writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

await test('ordinary PRs require core and optional full regression cannot weaken Release PRs', () => {
  assert.deepEqual(providerScopes({ ...identity, channel: 'dev' }), { suite: 'core', gate: 'core' })
  assert.deepEqual(providerScopes({ ...identity, channel: 'dev' }, 'full'), {
    suite: 'full',
    gate: 'core',
  })
  assert.deepEqual(providerScopes({ ...identity, channel: 'stable' }, 'core'), {
    suite: 'full',
    gate: 'full',
  })
  assert.deepEqual(providerScopes({ ...identity, channel: 'stable' }, 'full'), {
    suite: 'full',
    gate: 'full',
  })
  assert.throws(() => providerScopes(identity, 'skip'), /core or full/)
})
