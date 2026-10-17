import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ReleaseGitHub, main, publishRelease, resolveRelease } from './release-native.mjs'

const repository = 'mbaxszy7/Pact'
const sourceSha = 'a'.repeat(40)
const otherSha = 'f'.repeat(40)
const runId = 123
const identity = { sourceSha, version: '0.1.0', tag: 'v0.1.0', releasePR: 42 }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const clone = (value) => structuredClone(value)
const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`)
const trigger = () => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: String(runId),
  GH_TOKEN: 'unregistered-fixture-token',
})
const standardPR = () => ({
  number: 42,
  merged: true,
  merged_at: '2026-10-17T00:00:00Z',
  state: 'closed',
  merge_commit_sha: sourceSha,
  base: { ref: 'main', repo: { full_name: repository } },
  head: { ref: 'release-please--branches--main', repo: { full_name: repository } },
  labels: [{ name: 'autorelease: pending' }],
})

/** In-memory REST boundary. Binary uploads are read from real private temporary files. */
class ReleaseFixtureAPI {
  constructor() {
    this.pr = standardPR()
    this.related = [clone(this.pr)]
    this.source = new Map([
      ['version.json', JSON.stringify({ version: '0.1.0' })],
      ['package.json', JSON.stringify({ version: '0.1.0' })],
      ['apps/desktop/package.json', JSON.stringify({ version: '0.1.0' })],
      ['.release-please-manifest.json', JSON.stringify({ '.': '0.1.0' })],
      [
        'CHANGELOG.md',
        '# Changelog\n\n## [0.1.0](https://example.invalid/compare) (2026-10-17)\n\n### Features\n\n* Synthetic fixture release.\n\n## 0.0.0\n\nOlder fixture.\n',
      ],
    ])
    this.artifacts = new Map()
    this.release = undefined
    this.tag = undefined
    this.assets = []
    this.calls = []
    this.uploads = []
    this.failAfterUpload = undefined
  }

  async sourceFile(path, sha, maximum) {
    this.calls.push({ kind: 'sourceFile', path, sha, maximum })
    assert.equal(sha, sourceSha)
    assert.ok(this.source.has(path))
    return this.source.get(path)
  }

  async list(path) {
    this.calls.push({ kind: 'list', path })
    if (path === `/commits/${sourceSha}/pulls`) return clone(this.related)
    if (path === '/releases') return this.release ? [clone(this.release)] : []
    if (path === '/releases/77/assets')
      return this.assets.map(({ bytes: _bytes, ...metadata }) => clone(metadata))
    throw new Error(`Unexpected fixture list: ${path}`)
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET'
    this.calls.push({ kind: 'request', path, method, body: clone(options.body) })
    if (method === 'GET' && path === '/pulls/42') return clone(this.pr)
    if (method === 'GET' && path.startsWith('/actions/artifacts/'))
      return clone(this.artifacts.get(Number(path.split('/').at(-1))))
    if (method === 'GET' && path === '/git/ref/tags/v0.1.0') {
      if (this.tag) return clone(this.tag)
      assert.equal(options.optional, true)
      return null
    }
    if (method === 'POST' && path === '/releases') {
      assert.equal(this.release, undefined)
      this.release = { id: 77, ...clone(options.body), immutable: false }
      return clone(this.release)
    }
    if (method === 'PATCH' && path === '/releases/77') {
      assert.equal(options.body.draft, false)
      this.release.draft = false
      this.release.immutable = true
      this.tag = { object: { type: 'commit', sha: this.release.target_commitish } }
      return clone(this.release)
    }
    if (method === 'POST' && path === '/issues/42/labels') {
      for (const name of options.body.labels)
        if (!this.pr.labels.some((label) => label.name === name)) this.pr.labels.push({ name })
      return clone(this.pr.labels)
    }
    if (method === 'DELETE' && path === '/issues/42/labels/autorelease%3A%20pending') {
      this.pr.labels = this.pr.labels.filter((label) => label.name !== 'autorelease: pending')
      return null
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  }

  async upload(releaseId, file) {
    assert.equal(releaseId, 77)
    assert.equal(this.release.draft, true)
    assert.equal(
      this.assets.some((asset) => asset.name === file.name),
      false,
    )
    const bytes = await readFile(file.path)
    assert.equal(bytes.length, file.bytes)
    assert.equal(hash(bytes), file.sha256)
    const asset = {
      id: 1000 + this.assets.length,
      state: 'uploaded',
      name: file.name,
      size: bytes.length,
      bytes,
    }
    this.assets.push(asset)
    this.uploads.push(file.name)
    if (this.uploads.length === this.failAfterUpload)
      throw new Error('Synthetic uncertain upload after storage')
    return clone(asset)
  }

  async assetHash(asset) {
    const stored = this.assets.find((item) => item.id === asset.id)
    assert.ok(stored)
    return hash(stored.bytes)
  }
}

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-release-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const api = new ReleaseFixtureAPI()
  const artifacts = {}
  const manifests = {}
  for (const [key, firstId, attempt] of [
    ['darwin-arm64', 101, 1],
    ['win32-x64', 201, 2],
  ]) {
    const [platform, arch] = key.split('-')
    const packageRoot = join(root, key, 'package'),
      smokeRoot = join(root, key, 'smoke')
    // oxlint-disable-next-line eslint/no-await-in-loop -- Build each platform's independent private fixture once.
    await Promise.all([
      mkdir(packageRoot, { recursive: true }),
      mkdir(smokeRoot, { recursive: true }),
    ])
    const installers = []
    for (const kind of platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']) {
      const bytes = Buffer.from(`Synthetic native fixture ${key} ${kind}`)
      const extension = kind === 'nsis' ? 'exe' : kind
      const artifact = {
        kind,
        path: `Pact-0.1.0-${key}.${extension}`,
        bytes: bytes.length,
        sha256: hash(bytes),
      }
      installers.push(artifact)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Write small installer bytes without pretending to execute them.
      await writeFile(join(packageRoot, artifact.path), bytes)
    }
    const appContentHash = hash(`Synthetic app ${key}`)
    const manifest = {
      schemaVersion: 1,
      smokeProtocolVersion: 2,
      profile: 'production-ci',
      sourceSha,
      sourceDirty: false,
      version: '0.1.0',
      productVersion: '0.1.0',
      channel: 'stable',
      platform,
      arch,
      productName: 'Pact',
      appId: 'com.pact.desktop',
      application: {
        contentSha256: appContentHash,
        entries: [{ path: 'app', type: 'file', bytes: 1, sha256: appContentHash }],
      },
      artifacts: installers,
    }
    const packageContext = {
      schemaVersion: 1,
      kind: 'package',
      sourceSha,
      runId,
      producerAttempt: attempt,
      platform,
      arch,
      channel: 'stable',
    }
    const packageDigest = hash(`Package artifact ${key}`),
      smokeDigest = hash(`Smoke artifact ${key}`)
    artifacts[key] = { packageId: firstId, packageDigest, smokeId: firstId + 1, smokeDigest }
    manifests[key] = manifest
    api.artifacts.set(firstId, {
      id: firstId,
      digest: `sha256:${packageDigest}`,
      expired: false,
      workflow_run: { id: runId, head_sha: sourceSha },
    })
    api.artifacts.set(firstId + 1, {
      id: firstId + 1,
      digest: `sha256:${smokeDigest}`,
      expired: false,
      workflow_run: { id: runId, head_sha: sourceSha },
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Contexts bind package and smoke to the same source and exact artifact.
    await Promise.all([
      json(join(packageRoot, 'distribution-manifest.json'), manifest),
      json(join(packageRoot, 'execution-context.json'), packageContext),
      json(join(smokeRoot, 'execution-context.json'), {
        ...packageContext,
        kind: 'installed-smoke',
        packageArtifactId: firstId,
        packageArtifactDigest: packageDigest,
      }),
    ])
    for (const artifact of installers) {
      const report = {
        schemaVersion: 1,
        status: 'passed',
        ...Object.fromEntries(
          ['sourceSha', 'version', 'channel', 'platform', 'arch', 'appId', 'productName'].map(
            (name) => [name, manifest[name]],
          ),
        ),
        appContentHash,
        artifacts: [artifact],
        installationVerified: true,
        cleanupVerified: true,
        defaultChannelPathsVerified: true,
        productionDataRootVerified: true,
        verificationMode: { dmg: 'mounted-dmg-copy', zip: 'extracted-zip', nsis: 'installed-nsis' }[
          artifact.kind
        ],
        phases: ['seed', 'verify'],
        processOwnership: platform === 'darwin' ? 'verified-process-groups' : 'native-job',
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve a separate actual-format report fixture for each synthetic installer.
      await json(
        join(
          smokeRoot,
          artifact.kind === 'zip' ? 'package-zip-smoke-report.json' : 'package-smoke-report.json',
        ),
        report,
      )
    }
  }
  let proofs = 0
  const options = {
    root,
    identity,
    artifacts,
    runId,
    verifyProof: async (actual) => {
      assert.deepEqual(actual, identity)
      proofs++
    },
  }
  return { api, options, manifests, proofCount: () => proofs }
}

void test('resolve admits only the actual merged standard version PR and synchronized immutable source', async () => {
  const api = new ReleaseFixtureAPI()
  const result = await resolveRelease(api, trigger())
  assert.deepEqual(result, { applicable: true, ...identity })
  assert.equal(api.calls.filter((call) => call.kind === 'sourceFile').length, 5)
  assert.ok(
    api.calls.filter((call) => call.kind === 'sourceFile').every((call) => call.sha === sourceSha),
  )
  assert.equal(
    api.calls.some((call) => call.kind === 'request' && call.method !== 'GET'),
    false,
  )
})

void test('ordinary main commits and unrelated PR associations do not initiate release', async () => {
  for (const change of [
    { head: { ref: 'dev', repo: { full_name: repository } } },
    { merged_at: null },
    { merge_commit_sha: otherSha },
    { base: { ref: 'dev' } },
    { head: { ref: 'release-please--branches--main', repo: { full_name: 'external/Pact' } } },
  ]) {
    const api = new ReleaseFixtureAPI()
    api.related = [{ ...api.pr, ...change }]
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each association independently exercises the read-only resolver.
    assert.deepEqual(await resolveRelease(api, trigger()), { applicable: false, sourceSha })
    assert.equal(api.calls.length, 1)
  }
})

void test('resolve rejects unsynchronized authorities, old candidate state and absent exact changelog', async () => {
  for (const [path, content] of [
    ['package.json', '{"version":"0.2.0"}'],
    ['apps/desktop/package.json', '{"version":"0.2.0"}'],
    ['.release-please-manifest.json', '{".":"0.2.0"}'],
    ['version.json', '{"version":"0.1.0","candidateVersion":"0.1.0"}'],
    ['CHANGELOG.md', '# Changelog\n\n## 0.2.0\n\nOther release'],
  ]) {
    const api = new ReleaseFixtureAPI()
    api.source.set(path, content)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each immutable source authority must agree independently.
    await assert.rejects(resolveRelease(api, trigger()), /authorities differ|no changelog section/u)
  }
})

void test('resolve refuses changed or ambiguous version PR records and untrusted triggers', async () => {
  const changed = new ReleaseFixtureAPI()
  changed.pr.merge_commit_sha = otherSha
  await assert.rejects(resolveRelease(changed, trigger()), /association changed/u)
  const ambiguous = new ReleaseFixtureAPI()
  ambiguous.related.push({ ...clone(ambiguous.pr), number: 43 })
  await assert.rejects(resolveRelease(ambiguous, trigger()), /multiple version PRs/u)
  for (const change of [
    { GITHUB_REPOSITORY: 'external/Pact' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF: 'refs/heads/dev' },
    { GITHUB_SHA: 'main' },
  ])
    // oxlint-disable-next-line eslint/no-await-in-loop -- Trigger validation must reject before any API admission.
    await assert.rejects(
      resolveRelease(new ReleaseFixtureAPI(), { ...trigger(), ...change }),
      /protected-main push/u,
    )
})

void test('CLI rejects wrong events and source SHA before any network operation', async () => {
  await assert.rejects(
    main(['resolve'], { ...trigger(), GITHUB_EVENT_NAME: 'workflow_dispatch' }),
    /original protected-main push/u,
  )
  await assert.rejects(
    main(['publish', '--root', '/unused-fixture'], {
      ...trigger(),
      PACT_RELEASE_SOURCE_SHA: otherSha,
      PACT_RELEASE_VERSION: '0.1.0',
      PACT_RELEASE_TAG: 'v0.1.0',
      PACT_RELEASE_PR: '42',
      PACT_RELEASE_ARTIFACTS_JSON: '{}',
    }),
    /differs from the original event/u,
  )
})

void test('first publication admits both native targets, uploads exact files, verifies native proof and finalizes labels', async (t) => {
  const { api, options, manifests, proofCount } = await releaseFixture(t)
  const result = await publishRelease(api, options)
  assert.deepEqual(result, { releaseId: 77, version: '0.1.0', sourceSha })
  assert.equal(api.release.draft, false)
  assert.equal(api.release.immutable, true)
  assert.equal(proofCount(), 1)
  assert.deepEqual(api.pr.labels, [{ name: 'autorelease: tagged' }])
  for (const manifest of Object.values(manifests))
    for (const installer of manifest.artifacts)
      assert.equal(api.uploads.filter((name) => name === installer.path).length, 1)
  const publication = JSON.parse(
    api.assets.find((asset) => asset.name === 'pact-release-manifest.json').bytes.toString('utf8'),
  )
  assert.deepEqual(
    publication.platforms.map((item) => [item.platform, item.packageAttempt, item.smokeAttempt]),
    [
      ['darwin-arm64', 1, 1],
      ['win32-x64', 2, 2],
    ],
  )
  assert.equal(publication.runId, runId)
  assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 1)
})

void test('uncertain upload retries reconcile the same Draft and reuse original successful producer attempts', async (t) => {
  const { api, options, proofCount } = await releaseFixture(t)
  api.failAfterUpload = 1
  await assert.rejects(publishRelease(api, options), /uncertain upload/u)
  assert.equal(api.release.draft, true)
  assert.equal(api.assets.length, 1)
  assert.equal(proofCount(), 0)
  assert.deepEqual(api.pr.labels, [{ name: 'autorelease: pending' }])
  const firstName = api.uploads[0]
  api.failAfterUpload = undefined
  await publishRelease(api, options)
  assert.equal(api.uploads.filter((name) => name === firstName).length, 1)
  assert.equal(
    api.calls.filter((call) => call.path === '/releases' && call.method === 'POST').length,
    1,
  )
  assert.equal(api.release.immutable, true)
  assert.equal(proofCount(), 1)
})

void test('an existing matching empty Draft is resumed without another create', async (t) => {
  const { api, options } = await releaseFixture(t)
  api.release = {
    id: 77,
    tag_name: identity.tag,
    target_commitish: sourceSha,
    draft: true,
    prerelease: false,
    immutable: false,
  }
  await publishRelease(api, options)
  assert.equal(
    api.calls.filter((call) => call.path === '/releases' && call.method === 'POST').length,
    0,
  )
  assert.equal(api.release.immutable, true)
})

void test('already published immutable assets reconcile pending labels without uploading or republishing', async (t) => {
  const { api, options, proofCount } = await releaseFixture(t)
  await publishRelease(api, options)
  const count = api.uploads.length
  const patches = api.calls.filter((call) => call.method === 'PATCH').length
  api.pr.labels = [{ name: 'autorelease: pending' }]
  await publishRelease(api, options)
  assert.equal(api.uploads.length, count)
  assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, patches)
  assert.equal(proofCount(), 2)
  assert.deepEqual(api.pr.labels, [{ name: 'autorelease: tagged' }])
})

void test('same-name different remote bytes are rejected without replacement or finalization', async (t) => {
  const { api, options } = await releaseFixture(t)
  api.failAfterUpload = 1
  await assert.rejects(publishRelease(api, options), /uncertain upload/u)
  api.assets[0].bytes = Buffer.alloc(api.assets[0].size, 0)
  api.failAfterUpload = undefined
  await assert.rejects(publishRelease(api, options), /replacement is forbidden/u)
  assert.equal(api.uploads.length, 1)
  assert.equal(api.release.draft, true)
  assert.equal(
    api.calls.some((call) => call.method === 'DELETE'),
    false,
  )
})

void test('expired, wrong-run, wrong-source and changed-digest producer artifacts block any Draft mutation', async (t) => {
  for (const change of [
    { expired: true },
    { workflow_run: { id: 999, head_sha: sourceSha } },
    { workflow_run: { id: runId, head_sha: otherSha } },
    { digest: `sha256:${'0'.repeat(64)}` },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Every independent producer admission failure must be mutation-free.
    const { api, options } = await releaseFixture(t)
    api.artifacts.set(101, { ...api.artifacts.get(101), ...change })
    // oxlint-disable-next-line eslint/no-await-in-loop -- API metadata is validated through the real publication entry point.
    await assert.rejects(publishRelease(api, options), /Artifact identity/u)
    assert.equal(api.release, undefined)
    assert.equal(api.uploads.length, 0)
  }
})

void test('missing target, duplicate artifact identity or incomplete native installer formats block publication', async (t) => {
  const missing = await releaseFixture(t)
  delete missing.options.artifacts['win32-x64']
  await assert.rejects(publishRelease(missing.api, missing.options), /Both native platform/u)
  const duplicate = await releaseFixture(t)
  duplicate.options.artifacts['win32-x64'].smokeId = 101
  await assert.rejects(publishRelease(duplicate.api, duplicate.options), /IDs must be distinct/u)
  const format = await releaseFixture(t)
  format.manifests['darwin-arm64'].artifacts.pop()
  await json(
    join(format.options.root, 'darwin-arm64', 'package', 'distribution-manifest.json'),
    format.manifests['darwin-arm64'],
  )
  await assert.rejects(publishRelease(format.api, format.options), /installer must be present/u)
  for (const fixture of [missing, duplicate, format]) assert.equal(fixture.api.release, undefined)
})

void test('dirty source and missing default root or cleanup facts remain fatal in formal publication', async (t) => {
  for (const [file, field, value] of [
    ['package/distribution-manifest.json', 'sourceDirty', true],
    ['smoke/package-smoke-report.json', 'productionDataRootVerified', false],
    ['smoke/package-smoke-report.json', 'defaultChannelPathsVerified', false],
    ['smoke/package-smoke-report.json', 'cleanupVerified', false],
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- No failing platform evidence may create even a partial release.
    const { api, options } = await releaseFixture(t)
    const path = join(options.root, 'win32-x64', file)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Mutate exactly one existing synthetic evidence fact.
    const record = JSON.parse(await readFile(path, 'utf8'))
    record[field] = value
    // oxlint-disable-next-line eslint/no-await-in-loop -- File remains real input to the shared admission validator.
    await json(path, record)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Validate using publisher, not an implementation-shaped helper stub.
    await assert.rejects(publishRelease(api, options), /dirty|incomplete/u)
    assert.equal(api.release, undefined)
  }
})

void test('an existing tag or Draft pointing at another commit is rejected without writes', async (t) => {
  const tag = await releaseFixture(t)
  tag.api.tag = { object: { type: 'commit', sha: otherSha } }
  await assert.rejects(publishRelease(tag.api, tag.options), /different source bytes/u)
  assert.equal(tag.api.release, undefined)
  const draft = await releaseFixture(t)
  draft.api.release = {
    id: 77,
    tag_name: identity.tag,
    target_commitish: otherSha,
    draft: true,
    prerelease: false,
  }
  await assert.rejects(publishRelease(draft.api, draft.options), /another source/u)
  assert.equal(draft.api.uploads.length, 0)
})

void test('native immutable Release proof failure prevents label finalization and is recoverable', async (t) => {
  const { api, options } = await releaseFixture(t)
  await assert.rejects(
    publishRelease(api, {
      ...options,
      verifyProof: async () => {
        throw new Error('Synthetic native proof failure')
      },
    }),
    /native proof failure/u,
  )
  assert.equal(api.release.immutable, true)
  assert.deepEqual(api.pr.labels, [{ name: 'autorelease: pending' }])
  assert.equal(
    api.calls.some((call) => call.path.startsWith('/issues/')),
    false,
  )
  const count = api.uploads.length
  await publishRelease(api, options)
  assert.equal(api.uploads.length, count)
  assert.deepEqual(api.pr.labels, [{ name: 'autorelease: tagged' }])
})

void test('repository API pins destination, rejects redirects and bounds JSON responses', async () => {
  const requests = []
  const api = new ReleaseGitHub('unregistered-fixture-token', {
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify({ ok: true }))
    },
  })
  assert.deepEqual(await api.request('/releases'), { ok: true })
  assert.equal(requests[0].url, `https://api.github.com/repos/${repository}/releases`)
  assert.equal(requests[0].options.redirect, 'error')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  await assert.rejects(api.request('https://external.invalid/path'), /Invalid repository API/u)
  const oversized = new ReleaseGitHub('unregistered-fixture-token', {
    fetchImpl: async () => new Response(Buffer.alloc(2 * 1024 ** 2 + 1)),
  })
  await assert.rejects(oversized.request('/releases'), /byte bound/u)
})

const downloadAPI = (body) =>
  new ReleaseGitHub('unregistered-fixture-token', { fetchImpl: async () => new Response(body) })

void test('upload streams the admitted private file once and never retries uncertain delivery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-upload-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.alloc(192 * 1024, 0x50)
  const file = {
    path: join(root, 'Pact-0.1.0-win-x64.exe'),
    name: 'Pact-0.1.0-win-x64.exe',
    bytes: bytes.length,
    sha256: hash(bytes),
  }
  await writeFile(file.path, bytes)
  let requests = 0
  const api = new ReleaseGitHub('unregistered-fixture-token', {
    fetchImpl: async (url, options) => {
      requests++
      assert.equal(
        url,
        `https://uploads.github.com/repos/${repository}/releases/77/assets?name=${file.name}`,
      )
      assert.equal(options.method, 'POST')
      assert.equal(options.duplex, 'half')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers['Content-Length'], String(bytes.length))
      assert.equal(Buffer.isBuffer(options.body), false)
      const actual = createHash('sha256')
      let length = 0
      for await (const chunk of options.body) {
        length += chunk.length
        actual.update(chunk)
      }
      assert.equal(length, bytes.length)
      assert.equal(actual.digest('hex'), file.sha256)
      return new Response('uncertain fixture delivery', { status: 500 })
    },
  })
  await assert.rejects(api.upload(77, file), /reconciled before retry/u)
  assert.equal(requests, 1)
})

void test('asset downloads stream exact lengths and hashes without accepting truncated or enlarged bodies', async () => {
  const bytes = Buffer.from('Synthetic installed artifact')
  const asset = { id: 1000, size: bytes.length, state: 'uploaded' }
  assert.equal(await downloadAPI(bytes).assetHash(asset), hash(bytes))
  await assert.rejects(downloadAPI(bytes.subarray(1)).assetHash(asset), /incomplete/u)
  await assert.rejects(
    downloadAPI(Buffer.concat([bytes, Buffer.from('extra')])).assetHash(asset),
    /declared size/u,
  )
  await assert.rejects(
    downloadAPI(bytes).assetHash({ ...asset, state: 'new' }),
    /incomplete or oversized/u,
  )
})
