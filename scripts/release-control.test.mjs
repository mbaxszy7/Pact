import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Errors, GitHub as ReleasePleaseGitHub } from 'release-please'

import {
  compareVersions,
  decodeIdentity,
  encodeIdentity,
  establishDraft,
  GitHub,
  main as releaseMain,
  publishRelease,
  releaseVersion,
  RELEASE_PLATFORMS,
  resolveReleaseIdentity,
  restorePlatform,
  signReleaseState,
  validateBundle,
  verifyArtifactRun,
  verifyReleaseState,
  verifyTag,
} from './release-control.mjs'
import { bootstrapDecision } from './release-please.mjs'
import {
  releaseManifest,
  authenticatePublishedReleases,
  createValidatedPullRequests,
} from './release-please.mjs'
import {
  findStagedPlatforms,
  stagePlatform,
  materializeStagedPlatforms,
} from './release-staging.mjs'

const identity = {
  schemaVersion: 1,
  repository: 'example/Pact',
  releasePR: 42,
  version: '0.1.0',
  sourceSha: 'a'.repeat(40),
  tag: 'v0.1.0',
}
const digest = (value) => createHash('sha256').update(value).digest('hex')
// Ephemeral, unregistered RSA keys only authenticate these in-memory REST doubles.
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const fixtureKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' })
const signContext = {
  signingKey: fixtureKey,
  botId: 12345,
  runId: 10,
  controlSourceSha: 'c'.repeat(40),
}
const fixtureNotes = '## Features\nSynthetic fixture release notes.'
function fixtureReleaseState(releaseId = 100) {
  return signReleaseState(
    {
      ...identity,
      releaseId,
      appBotId: 12345,
      releaseNotesSha256: digest(fixtureNotes),
      trustedRuns: [{ runId: signContext.runId, controlSourceSha: signContext.controlSourceSha }],
    },
    fixtureKey,
  )
}

function apiFixture({ published = false, version = '0.1.0' } = {}) {
  const state = {
    parentMetadata: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
    productMetadata: { version, candidateVersion: version },
    mergeCommit: { sha: identity.sourceSha, parents: [{ sha: 'd'.repeat(40) }] },
    tag: { object: { type: 'commit', sha: identity.sourceSha } },
    release: {
      id: 100,
      tag_name: identity.tag,
      draft: !published,
      prerelease: false,
      author: { id: 12345, type: 'Bot' },
      body: `${encodeIdentity(fixtureReleaseState())}\n<!-- PACT_RELEASE_NOTES_START -->\n${fixtureNotes}\n<!-- PACT_RELEASE_NOTES_END -->`,
    },
    assets: [],
    reviews: [
      {
        id: 1,
        user: { id: 31481964 },
        state: 'APPROVED',
        commit_id: 'b'.repeat(40),
        submitted_at: '2026-10-12T11:00:00Z',
      },
    ],
    mutations: [],
    newer: [],
    stages: [],
    archives: new Map(),
    run: {
      name: 'Pact Release - Publish app downloads',
      run_attempt: 1,
      path: '.github/workflows/release.yml',
      event: 'pull_request_target',
      head_branch: 'release-please--branches--main',
      pull_requests: [],
      repository: { full_name: identity.repository },
    },
    jobs: [
      { name: 'quality', status: 'completed', conclusion: 'success' },
      ...RELEASE_PLATFORMS.map((key) => ({
        name: `build-${key}`,
        status: 'completed',
        conclusion: 'success',
      })),
    ],
    pr: {
      number: 42,
      state: 'closed',
      merged: true,
      merged_at: '2026-10-12T12:00:00Z',
      merged_by: { id: 31481964 },
      auto_merge: null,
      merge_commit_sha: identity.sourceSha,
      user: { id: 12345, type: 'Bot' },
      base: { ref: 'main', repo: { full_name: identity.repository } },
      head: {
        sha: 'b'.repeat(40),
        ref: 'release-please--branches--main',
        repo: { full_name: identity.repository },
      },
      title: `chore(main): release ${version}`,
      body: '## Features\nSynthetic fixture release notes.',
      labels: [{ name: 'autorelease: pending' }],
    },
  }
  const api = {
    repository: identity.repository,
    path: (suffix) => `/repos/${identity.repository}${suffix}`,
    async request(path, options = {}) {
      if (options.method) state.mutations.push({ path, ...options })
      if (path.startsWith('/users/')) return { id: 12345, type: 'Bot' }
      if (path.endsWith('/actions/runs/10')) return structuredClone(state.run)
      if (path.endsWith('/pulls/42')) return structuredClone(state.pr)
      if (path.endsWith(`/commits/${identity.sourceSha}`)) return structuredClone(state.mergeCommit)
      if (path.endsWith('/git/ref/tags/v0.1.0')) return state.tag
      if (path.endsWith('/git/refs')) {
        state.tag = { object: { type: 'commit', sha: options.body.sha } }
        return state.tag
      }
      if (path.endsWith('/releases/100')) {
        if (options.method === 'PATCH') Object.assign(state.release, options.body)
        return structuredClone(state.release)
      }
      const archiveMatch = path.match(/actions\/artifacts\/(\d+)\/zip$/)
      if (archiveMatch && options.binary)
        return new Response(state.archives.get(RELEASE_PLATFORMS[Number(archiveMatch[1]) - 1000]))
      const releaseMatch = path.match(/\/releases\/(\d+)$/)
      if (releaseMatch) {
        const release = state.stages.find((item) => item.id === Number(releaseMatch[1]))
        if (!release) throw Error('unknown fixture release')
        if (options.method === 'PATCH') Object.assign(release, options.body)
        return structuredClone(release)
      }
      const assetMatch = path.match(/\/releases\/assets\/(\d+)$/)
      if (assetMatch && options.binary) {
        const asset = state.assets.find((entry) => entry.id === Number(assetMatch[1]))
        return new Response(asset.content)
      }
      if (path.endsWith('/releases') && options.method === 'POST') {
        const release = {
          id: options.body.tag_name === identity.tag ? 100 : 200 + state.stages.length,
          author: { id: 12345, type: 'Bot' },
          ...options.body,
        }
        if (release.id === 100) state.release = release
        else state.stages.push(release)
        return structuredClone(release)
      }
      throw new Error(`Unexpected fixture API path ${path}`)
    },
    async list(path) {
      if (path.endsWith('/pulls/42/reviews')) return structuredClone(state.reviews)
      if (path.endsWith('/actions/runs/10/jobs')) return structuredClone(state.jobs)
      if (path.endsWith('/attempts/' + state.run.run_attempt + '/jobs'))
        return structuredClone(state.jobs)
      if (path.endsWith('/artifacts'))
        return RELEASE_PLATFORMS.map((key, index) => ({
          id: 1000 + index,
          name: `stable-${key}-a${state.run.run_attempt}`,
          expired: false,
          digest: 'sha256:' + digest(state.archives.get(key) ?? key),
        }))
      if (path.endsWith('/assets'))
        return state.assets
          .filter((asset) => asset.releaseId === Number(path.match(/releases\/(\d+)/)[1]))
          .map((asset) => Object.assign({}, asset))
      if (path.endsWith('/releases'))
        return [state.release, ...state.newer, ...state.stages]
          .filter(Boolean)
          .map((release) => structuredClone(release))
      throw new Error(`Unexpected fixture list ${path}`)
    },
    async jsonAt(path, sha) {
      if (path === 'version.json' && sha === 'd'.repeat(40))
        return structuredClone(state.parentMetadata)
      assert.equal(sha, identity.sourceSha)
      if (path === 'version.json') return structuredClone(state.productMetadata)
      return path === '.release-please-manifest.json' ? { '.': version } : { version }
    },
    async assetDigest(asset) {
      return asset.hash
    },
    async upload(releaseId, file, name) {
      assert.ok(releaseId === 100 || state.stages.some((release) => release.id === releaseId))
      const bytes = await readFile(file)
      state.assets.push({
        id: state.assets.length + 1,
        releaseId,
        name,
        hash: digest(bytes),
        content: bytes,
        size: bytes.length,
        state: 'uploaded',
        uploader: { id: 12345, type: 'Bot' },
      })
      state.mutations.push({ method: 'UPLOAD', name })
    },
  }
  return { api, state }
}

async function bundleFixture(context, key, parentRoot) {
  const { mkdir } = await import('node:fs/promises')
  const root = parentRoot
    ? join(parentRoot, key)
    : await mkdtemp(join(tmpdir(), 'pact-release-controller-'))
  await mkdir(root, { recursive: true })
  if (!parentRoot) context.after(() => rm(root, { recursive: true, force: true }))
  const [platform, arch] = key.split('-')
  const artifacts = []
  const kinds = platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']
  for (const kind of kinds) {
    const path = `Pact-${identity.version}-${key}.${kind === 'nsis' ? 'exe' : kind}`
    const bytes = Buffer.from(`Synthetic nonfunctional installer bytes: ${key}/${kind}`)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Deterministic fixture construction records each file after its write settles.
    await writeFile(join(root, path), bytes)
    artifacts.push({ path, kind, bytes: bytes.length, sha256: digest(bytes) })
  }
  const manifest = {
    schemaVersion: 1,
    smokeProtocolVersion: 2,
    ...identity,
    productVersion: identity.version,
    channel: 'stable',
    platform,
    arch,
    sourceDirty: false,
    productName: 'Pact',
    appId: 'com.pact.desktop',
    application: { contentSha256: digest(`Synthetic app ${key}`) },
    artifacts,
  }
  const common = {
    schemaVersion: 1,
    status: 'passed',
    sourceSha: identity.sourceSha,
    version: identity.version,
    channel: 'stable',
    platform,
    arch,
    appContentHash: manifest.application.contentSha256,
    appId: manifest.appId,
    productName: manifest.productName,
  }
  const smoke = {
    ...common,
    installationVerified: true,
    cleanupVerified: true,
    defaultChannelPathsVerified: true,
    productionDataRootVerified: true,
    verificationMode: platform === 'darwin' ? 'mounted-dmg-copy' : 'installed-nsis',
    artifacts: [artifacts[0]],
  }
  const write = (file, value) => writeFile(join(root, file), `${JSON.stringify(value)}\n`)
  await write('distribution-manifest.json', manifest)
  await write('package-smoke-report.json', smoke)
  if (platform === 'darwin')
    await write('package-zip-smoke-report.json', {
      ...smoke,
      verificationMode: 'extracted-zip',
      artifacts: [artifacts[1]],
    })
  return { root, manifest, smoke, write }
}

async function archiveFixture(context, state, key, root) {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-artifact-fixture-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const archive = join(temporary, 'artifact.zip')
  execFileSync(
    'python3',
    [
      '-c',
      "import os,sys,zipfile;root=sys.argv[1];out=sys.argv[2];archive=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED);[archive.write(os.path.join(root,name),name) for name in os.listdir(root) if os.path.isfile(os.path.join(root,name))];archive.close()",
      root,
      archive,
    ],
    { timeout: 5000, maxBuffer: 1024 },
  )
  state.archives.set(key, await readFile(archive))
}

void test('first-release override is transient; later maintenance never pins 0.1.0', () => {
  assert.deepEqual(
    bootstrapDecision({
      tags: [],
      releases: [],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
    }),
    {
      pendingRelease: false,
      releaseAs: '0.1.0',
    },
  )
  assert.deepEqual(
    bootstrapDecision({
      tags: [{ name: 'v0.1.0' }],
      releases: [{ tag_name: 'v0.1.0', draft: false, prerelease: false }],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
    }),
    { pendingRelease: false, releaseAs: '' },
  )
  assert.deepEqual(
    bootstrapDecision({
      tags: [],
      releases: [],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
      releaseMerge: true,
    }),
    { pendingRelease: true, releaseAs: '' },
  )
})

void test('unpublished tags, unfinished drafts and merged version changes wait for recovery', () => {
  const pending = { pendingRelease: true, releaseAs: '' }
  assert.deepEqual(
    bootstrapDecision({
      tags: [{ name: 'v0.1.0' }],
      releases: [],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
    }),
    pending,
  )
  assert.deepEqual(
    bootstrapDecision({
      tags: [{ name: 'v0.1.0' }],
      releases: [{ tag_name: 'v0.1.0', draft: true }],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
    }),
    pending,
  )
  assert.deepEqual(
    bootstrapDecision({
      tags: [{ name: 'v0.1.0' }],
      releases: [{ tag_name: 'v0.1.0', draft: false, prerelease: false }],
      manifestVersion: '0.2.0',
      productMetadata: { version: '0.2.0', candidateVersion: '0.2.0' },
    }),
    pending,
  )
  assert.throws(
    () =>
      bootstrapDecision({
        tags: [{ name: 'unknown' }],
        releases: [],
        manifestVersion: '0.1.0',
        productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
      }),
    /unknown tag/,
  )
  assert.throws(
    () =>
      bootstrapDecision({
        tags: [],
        releases: [{ tag_name: 'v0.1.0', draft: false }],
        manifestVersion: '0.1.0',
        productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
      }),
    /missing/,
  )
})

void test('stable major transition requires explicit owner approval; compare versions numerically', () => {
  assert.equal(releaseVersion('0.12.4'), '0.12.4')
  assert.throws(() => releaseVersion('0.0.0'), /cannot be released/)
  assert.throws(() => releaseVersion('1.0.0'), /owner approval/)
  assert.equal(releaseVersion('1.0.0', '1'), '1.0.0')
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
})

void test('merged PR identity uses fixed App user ID, owner merger and four version authorities', async () => {
  const { api, state } = apiFixture()
  assert.deepEqual(
    await resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    identity,
  )
  state.pr.user.id = 31481964
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /author/,
  )
  state.pr.user.id = 12345
  state.pr.merged_by.id = 99
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /merged by/,
  )
  state.pr.merged_by.id = 31481964
  state.pr.auto_merge = { enabled_by: { id: 31481964 } }
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /manually/,
  )
})

void test('ordinary business PR cannot create a stable release; unmerged bot PR cannot release', async () => {
  const { api, state } = apiFixture()
  state.pr.head.ref = 'feature/one'
  assert.equal(await resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }), null)
  state.pr.head.ref = 'release-please--branches--main'
  state.pr.merged = false
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /not merged/,
  )
})

void test('actual squash-parent metadata must introduce release intent before any Draft can exist', async () => {
  const { api, state } = apiFixture()
  const options = { botId: 12345, appSlug: 'pact-ci' }
  const goodParent = structuredClone(state.parentMetadata)
  for (const parent of [
    { version: '0.1.0', candidateVersion: '0.1.0' },
    { version: '0.2.0', candidateVersion: '0.2.0' },
    { version: '0.1.0' },
    null,
  ]) {
    state.parentMetadata = parent
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each immutable parent contradiction is a separate release admission.
    await assert.rejects(
      resolveReleaseIdentity(api, 42, options),
      /do not declare a new release|strictly increase|Product version|initialization/,
    )
    assert.equal(state.mutations.length, 0)
  }
  state.parentMetadata = goodParent
  state.productMetadata.candidateVersion = '0.1.0-unreleased'
  await assert.rejects(resolveReleaseIdentity(api, 42, options), /release/)
  state.productMetadata.candidateVersion = '0.1.0'
  for (const merge of [
    { sha: 'f'.repeat(40), parents: [{ sha: 'd'.repeat(40) }] },
    { sha: identity.sourceSha, parents: [] },
    { sha: identity.sourceSha, parents: [{ sha: 'd'.repeat(40) }, { sha: 'b'.repeat(40) }] },
  ]) {
    state.mergeCommit = merge
    // oxlint-disable-next-line eslint/no-await-in-loop -- Squash provenance must hold for each independently malformed commit response.
    await assert.rejects(resolveReleaseIdentity(api, 42, options), /squash/)
  }
  assert.equal(state.mutations.length, 0)
})

void test('a later formal release advances from its actual parent rather than the PR base metadata', async () => {
  const { api, state } = apiFixture({ version: '0.2.0' })
  state.parentMetadata = { version: '0.1.0', candidateVersion: '0.1.0' }
  state.pr.base.sha = 'e'.repeat(40)
  const result = await resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' })
  assert.equal(result.version, '0.2.0')
  assert.equal(result.sourceSha, identity.sourceSha)
  state.productMetadata.candidateVersion = '0.1.0'
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /Product version/,
  )
  assert.equal(state.mutations.length, 0)
})

void test('copied release metadata on main cannot bootstrap a second same-version PR or release', async () => {
  assert.deepEqual(
    bootstrapDecision({
      tags: [],
      releases: [],
      manifestVersion: '0.1.0',
      productMetadata: { version: '0.1.0', candidateVersion: '0.1.0' },
    }),
    { pendingRelease: true, releaseAs: '' },
  )
  const { api, state } = apiFixture()
  state.pr.user.id = 31481964
  await assert.rejects(
    resolveReleaseIdentity(api, 42, { botId: 12345, appSlug: 'pact-ci' }),
    /fixed App/,
  )
  assert.equal(state.mutations.length, 0)
  assert.throws(
    () =>
      bootstrapDecision({
        tags: [{ name: 'v0.1.0' }],
        releases: [{ tag_name: 'v0.1.0', draft: false, prerelease: false }],
        manifestVersion: '0.1.0',
        productMetadata: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
      }),
    /restore/,
  )
})

void test('existing tag SHA and durable draft identity cannot be replaced by recovery', async () => {
  const { api, state } = apiFixture()
  state.tag.object.sha = 'b'.repeat(40)
  await assert.rejects(establishDraft(api, identity, signContext), /another SHA/)
  assert.equal(state.mutations.length, 0)
  state.tag.object.sha = identity.sourceSha
  state.release.body = encodeIdentity({ ...identity, releasePR: 99 })
  await assert.rejects(establishDraft(api, identity, signContext), /conflicts/)
  assert.equal(state.mutations.length, 0)
})

void test('interruption before Draft creation resumes the fixed pre-existing tag', async () => {
  const { api, state } = apiFixture()
  state.release = null
  const established = await establishDraft(api, identity, signContext)
  assert.equal(established.releaseId, 100)
  assert.equal(established.published, false)
  assert.equal(state.mutations.length, 2)
  assert.equal(verifyReleaseState(state.release, identity, fixtureKey, 12345).releaseId, 100)
  const again = await establishDraft(api, identity, signContext)
  assert.equal(again.releaseId, 100)
  assert.equal(state.mutations.length, 2)
  assert.throws(
    () => decodeIdentity(`${encodeIdentity(identity)}\n${encodeIdentity(identity)}`),
    /unambiguous/,
  )
})

void test('authenticated bootstrap survives interruption between Draft creation and binding Release ID', async () => {
  const { api, state } = apiFixture()
  state.release.body = `${encodeIdentity(fixtureReleaseState(null))}\n<!-- PACT_RELEASE_NOTES_START -->\n${fixtureNotes}\n<!-- PACT_RELEASE_NOTES_END -->`
  const resumed = await establishDraft(api, identity, {
    ...signContext,
    runId: 11,
    controlSourceSha: 'd'.repeat(40),
  })
  assert.equal(resumed.releaseId, 100)
  assert.deepEqual(
    resumed.trustedRuns.map((run) => run.runId),
    [10, 11],
  )
  assert.equal(state.mutations.length, 1)
  assert.equal(verifyReleaseState(state.release, identity, fixtureKey, 12345).releaseId, 100)
})

void test('tampered ledgers, unrecognized old state and key rotation never get automatically re-signed', async () => {
  const { api, state } = apiFixture()
  const original = state.release.body
  const changed = decodeIdentity(original)
  changed.trustedRuns[0].controlSourceSha = 'd'.repeat(40)
  state.release.body = original.replace(
    /PACT_RELEASE_IDENTITY:[A-Za-z0-9+/=]+/,
    encodeIdentity(changed),
  )
  state.tag = null
  await assert.rejects(establishDraft(api, identity, signContext), /signature differs/)
  assert.equal(state.mutations.length, 0)
  state.release.body = encodeIdentity(identity)
  await assert.rejects(establishDraft(api, identity, signContext), /fixed GitHub App/)
  assert.equal(state.mutations.length, 0)
  state.release.body = original
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  await assert.rejects(
    establishDraft(api, identity, { ...signContext, signingKey: rotated }),
    /signature differs/,
  )
  assert.equal(state.mutations.length, 0)
})

void test('artifact recovery trusts the signed controller run, not ambiguous head branch metadata', async () => {
  const { api, state } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  assert.deepEqual(await verifyArtifactRun(api, established, 10, signContext), {
    verifiedRun: 10,
    controlSourceSha: signContext.controlSourceSha,
  })
  await assert.rejects(verifyArtifactRun(api, established, 11, signContext), /not authenticated/)
  state.jobs[0].conclusion = 'cancelled'
  await assert.rejects(verifyArtifactRun(api, established, 10, signContext), /did not pass/)
  assert.equal(state.mutations.length, 0)
})

void test('missing tag fails closed; complete new identity creates only its exact immutable tag', async () => {
  const { api, state } = apiFixture()
  state.tag = null
  await assert.rejects(verifyTag(api, identity), /missing/)
  await verifyTag(api, identity, true)
  assert.equal(state.tag.object.sha, identity.sourceSha)
  assert.deepEqual(state.mutations[0].body, { ref: 'refs/tags/v0.1.0', sha: identity.sourceSha })
})

void test('installed platform evidence must bind actual artifact and exact application bytes', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  assert.equal((await validateBundle(bundle.root, identity, 'win32-x64')).files.length, 3)
  bundle.smoke.appContentHash = 'f'.repeat(64)
  await bundle.write('package-smoke-report.json', bundle.smoke)
  await assert.rejects(validateBundle(bundle.root, identity, 'win32-x64'), /content hash/)
})

void test('deferred Windows ARM64 installers cannot enter a formal release', async (context) => {
  assert.deepEqual(RELEASE_PLATFORMS, ['darwin-arm64', 'win32-x64'])
  const bundle = await bundleFixture(context, 'win32-arm64')
  await assert.rejects(
    validateBundle(bundle.root, identity, 'win32-arm64'),
    /Unsupported release platform/,
  )
})

void test('deferred packaging blocks every remote release mutation entry before credentials or network', async () => {
  for (const command of ['prepare', 'stage', 'publish']) {
    for (const ready of [undefined, 'false', 'TRUE', '1']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each public command rejects before API construction or any remote side effect.
      await assert.rejects(
        releaseMain([command], { PACT_PACKAGING_READY: ready }),
        /deferred until native-machine acceptance/,
      )
    }
  }
})

void test('unpacked-only proof blocks publication', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  bundle.smoke.installationVerified = false
  await bundle.write('package-smoke-report.json', bundle.smoke)
  await assert.rejects(validateBundle(bundle.root, identity, 'win32-x64'), /unverified/)
})

void test('old smoke protocols and isolated-root-only evidence never prove production isolation', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  bundle.manifest.smokeProtocolVersion = undefined
  await bundle.write('distribution-manifest.json', bundle.manifest)
  await assert.rejects(validateBundle(bundle.root, identity, 'win32-x64'), /protocol is unverified/)
  bundle.manifest.smokeProtocolVersion = 2
  await bundle.write('distribution-manifest.json', bundle.manifest)
  bundle.smoke.productionDataRootVerified = false
  await bundle.write('package-smoke-report.json', bundle.smoke)
  await assert.rejects(validateBundle(bundle.root, identity, 'win32-x64'), /unverified/)
})

void test('macOS requires independently installed DMG and extracted ZIP evidence', async (context) => {
  const bundle = await bundleFixture(context, 'darwin-arm64')
  assert.equal((await validateBundle(bundle.root, identity, 'darwin-arm64')).files.length, 5)
  await rm(join(bundle.root, 'package-zip-smoke-report.json'))
  await assert.rejects(validateBundle(bundle.root, identity, 'darwin-arm64'), /ENOENT/)
})

void test('one failed or missing platform prevents any upload or publication', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-all-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await bundleFixture(context, 'darwin-arm64', root)
  const { api, state } = apiFixture()
  await assert.rejects(
    publishRelease(api, { ...identity, releaseId: 100 }, root, signContext),
    /ENOENT/,
  )
  assert.equal(state.mutations.length, 0)
  assert.equal(state.release.draft, true)
})

void test('complete evidence publishes once, and repeated published recovery never mutates files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-all-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api, state } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  const result = await publishRelease(api, established, root, signContext)
  assert.equal(result.status, 'published')
  assert.equal(state.release.draft, false)
  assert.equal(state.release.make_latest, 'true')
  assert.ok(state.assets.some((asset) => asset.name === 'SHA256SUMS'))
  const mutations = state.mutations.length
  const again = await publishRelease(api, established, root, signContext)
  assert.equal(again.status, 'already-published')
  assert.equal(state.mutations.length, mutations)
  state.assets[0].hash = 'f'.repeat(64)
  await assert.rejects(publishRelease(api, established, root, signContext), /cannot be overwritten/)
  assert.equal(state.mutations.length, mutations)
})

void test('complete published bundles restore exact bytes and refuse an existing destination', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-restore-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  await publishRelease(api, established, root, signContext)
  const output = join(root, 'restored-mac')
  assert.equal(await restorePlatform(api, established, 'darwin-arm64', output, signContext), true)
  const original = await validateBundle(join(root, 'darwin-arm64'), established, 'darwin-arm64')
  const restored = await validateBundle(output, established, 'darwin-arm64')
  assert.deepEqual(
    restored.files.map(({ name, sha256 }) => ({ name, sha256 })),
    original.files.map(({ name, sha256 }) => ({ name, sha256 })),
  )
  await assert.rejects(
    restorePlatform(api, established, 'darwin-arm64', output, signContext),
    /EEXIST/,
  )
})

void test('recovering an older product version never downgrades Latest', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-all-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api, state } = apiFixture()
  state.newer.push({ id: 101, tag_name: 'v0.10.0', draft: false, prerelease: false })
  const result = await publishRelease(api, { ...identity, releaseId: 100 }, root, signContext)
  assert.equal(result.latest, false)
  assert.equal(state.release.make_latest, 'false')
})

void test('unknown or partially uploaded remote files never get silently replaced', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-all-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api, state } = apiFixture()
  state.assets.push({
    id: 1,
    name: 'unknown.exe',
    releaseId: 100,
    hash: digest('x'),
    size: 1,
    state: 'uploaded',
    uploader: { id: 12345 },
  })
  await assert.rejects(
    publishRelease(api, { ...identity, releaseId: 100 }, root, signContext),
    /Unsigned remote contents/,
  )
  assert.equal(state.mutations.length, 0)
  await assert.rejects(
    restorePlatform(
      api,
      { ...identity, releaseId: 100 },
      'win32-x64',
      join(root, 'restored'),
      signContext,
    ),
    /Unsigned remote contents/,
  )
})

void test('REST pagination reads every page and rejects incomplete oversized API state', async () => {
  const calls = []
  const api = new GitHub(identity.repository, 'synthetic-nonfunctional-token', {
    fetchImpl: async (url) => {
      calls.push(url)
      return new Response(
        JSON.stringify(
          url.endsWith('page=1') ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }],
        ),
      )
    },
  })
  assert.equal((await api.list('/synthetic')).length, 101)
  assert.equal(calls.length, 2)
  const oversized = new GitHub(identity.repository, 'synthetic-nonfunctional-token', {
    fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
  })
  await assert.rejects(oversized.request('/synthetic'), /exceeds its byte bound/)
})

void test('workflow keeps App credentials out of builds and forbids automatic/partial publication', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
  const parsedWorkflow = builderRequire('js-yaml').load(workflow)
  assert.equal(apiFixture().state.run.name, parsedWorkflow.name)
  for (const key of RELEASE_PLATFORMS) {
    const build = workflow.split(`\n  build-${key}:`)[1].split(`\n  stage-${key}:`)[0]
    assert.ok(!build.includes('PACT_CI_APP_PRIVATE_KEY'))
    assert.ok(!build.includes('PACT_CI_APP_ID'))
    assert.match(workflow, new RegExp(`needs\\.stage-${key}\\.result == 'success'`))
  }
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /group: pact-stable-publication/)
  assert.doesNotMatch(workflow, /run-soak|package-soak-report|--duration-ms/u)
  assert.doesNotMatch(workflow, /build-win32-arm64|stage-win32-arm64|ready_win32_arm64/u)
  const publication = await readFile(new URL('./release-control.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(publication, /two-hour packaged performance|All three installed/u)
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(ci, /run_soak|run-soak|package-soak-report|SOAK_DURATION/u)
  assert.doesNotMatch(ci, /key: win32-arm64|runner: windows-11-arm/u)
  assert.match(ci, /steps\.native\.outcome == 'success' && matrix\.package/u)
  assert.match(ci, /matrix\.package && \(vars\.PACT_PACKAGING_READY == 'true'/u)
  assert.match(workflow, /vars\.PACT_PACKAGING_READY == 'true'/u)
  const config = JSON.parse(
    await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
  )
  assert.equal(config['release-as'], undefined)
  assert.equal(config['bump-minor-pre-major'], true)
  assert.equal(config['bump-patch-for-minor-pre-major'], false)
  assert.equal(config['separate-pull-requests'], false)
  assert.equal(
    config['group-pull-request-title-pattern'],
    'chore${scope}: release${component} ${version}',
  )
  assert.deepEqual(Object.keys(config.packages), ['.'])
})

void test('merged Release PR needs the currently effective owner review before its protected manual merge', async () => {
  const { api, state } = apiFixture()
  const options = { botId: 12345, appSlug: 'fixture-app' }
  const valid = structuredClone(state.reviews)
  for (const reviews of [
    [],
    [{ ...valid[0], state: 'DISMISSED' }],
    [...valid, { ...valid[0], id: 2, state: 'DISMISSED' }],
    [...valid, { ...valid[0], id: 2, state: 'CHANGES_REQUESTED' }],
    [{ ...valid[0], submitted_at: '2026-10-12T13:00:00Z' }],
  ]) {
    state.reviews = reviews
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each review transition must be settled independently.
    await assert.rejects(resolveReleaseIdentity(api, 42, options), /did not approve/)
  }
  state.reviews = [...valid, { ...valid[0], id: 2, state: 'COMMENTED', commit_id: 'd'.repeat(40) }]
  assert.equal((await resolveReleaseIdentity(api, 42, options)).sourceSha, identity.sourceSha)
  state.reviews = [{ ...valid[0], commit_id: 'd'.repeat(40) }]
  assert.equal((await resolveReleaseIdentity(api, 42, options)).sourceSha, identity.sourceSha)
  state.reviews.push({
    ...valid[0],
    id: 2,
    state: 'COMMENTED',
    submitted_at: '2026-10-12T11:30:00Z',
  })
  assert.equal((await resolveReleaseIdentity(api, 42, options)).sourceSha, identity.sourceSha)
  state.reviews = [
    { ...valid[0], id: 2 },
    { ...valid[0], id: 1, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-12T11:30:00Z' },
  ]
  await assert.rejects(resolveReleaseIdentity(api, 42, options), /did not approve/)
  state.reviews = [...valid, { ...valid[0], id: 2, state: 'UNKNOWN' }]
  await assert.rejects(resolveReleaseIdentity(api, 42, options), /state is unresolved/)
})

void test('the pinned Release Please library produces first and later semantic versions without a permanent override', async () => {
  const config = JSON.parse(
    await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
  )
  for (const [previous, message, override, expected] of [
    ['', 'fix: correction', '0.1.0', '0.1.0'],
    ['', 'feat: capability', '0.1.0', '0.1.0'],
    ['0.1.0', 'fix: correction', '', '0.1.1'],
    ['0.1.0', 'feat: capability', '', '0.2.0'],
    ['0.1.0', 'feat!: incompatible capability\n\nBREAKING CHANGE: changed contract', '', '0.2.0'],
    ['0.1.0', 'chore: maintain tooling', '', ''],
    ['', 'chore: maintain tooling', '0.1.0', ''],
  ]) {
    const version = previous || '0.1.0'
    const github = {
      repository: { owner: 'example', repo: 'Pact', defaultBranch: 'main' },
      async getFileJson(path) {
        return path === 'release-please-config.json' ? config : { '.': version }
      },
      async getFileContentsOnBranch() {
        return {
          parsedContent: JSON.stringify({ name: 'pact', version }),
          content: '',
          sha: 'a'.repeat(40),
        }
      },
      async *releaseIterator() {
        if (previous) yield { tagName: `v${previous}`, sha: 'f'.repeat(40), notes: 'prior' }
      },
      async *tagIterator() {},
      async *mergeCommitIterator() {
        yield { sha: 'a'.repeat(40), message, files: ['src/fixture.ts'] }
        if (previous)
          yield {
            sha: 'f'.repeat(40),
            message: 'chore(main): release ' + previous,
            files: ['package.json'],
          }
      },
      async *pullRequestIterator() {},
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Preview the exact pinned library independently for each policy case.
    const manifest = await releaseManifest(github, override)
    // oxlint-disable-next-line eslint/no-await-in-loop -- The real strategy consumes its own manifest and commit history.
    const candidates = await manifest.buildPullRequests()
    assert.equal(candidates.length, expected ? 1 : 0)
    if (expected) {
      assert.equal(candidates[0].title.toString(), `chore(main): release ${expected}`)
      const changelog = candidates[0].updates.find((update) => update.path === 'CHANGELOG.md')
      assert.ok(changelog, 'The release PR must have an actual non-version file change')
      const prior = '# Changelog\n'
      assert.notEqual(changelog.updater.updateContent(prior), prior)
    }
  }
})

async function releasePreviewFixture({
  previous = '',
  message = 'fix: correction',
  override = '',
} = {}) {
  const config = JSON.parse(
    await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
  )
  const version = previous || '0.1.0'
  const productMetadata = {
    version,
    candidateVersion: previous || '0.1.0-unreleased',
  }
  const sourceSha = 'a'.repeat(40)
  const files = new Map([
    ['release-please-config.json', JSON.stringify(config)],
    ['.release-please-manifest.json', JSON.stringify({ '.': version })],
    ['version.json', JSON.stringify(productMetadata)],
    ['package.json', JSON.stringify({ name: 'pact', version, private: true })],
    [
      'apps/desktop/package.json',
      JSON.stringify({ name: '@pact/desktop', version, private: true }),
    ],
    ['CHANGELOG.md', '# Changelog\n'],
  ])
  const state = { builds: 0, sourceGuards: 0, writes: [], beforeWrite: undefined }
  const github = {
    repository: { owner: 'example', repo: 'Pact', defaultBranch: 'main' },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    async getFileJson(path) {
      return JSON.parse(files.get(path))
    },
    async getFileContentsOnBranch(path, branch) {
      assert.ok(branch === 'main' || branch === sourceSha)
      const content = files.get(path)
      if (content === undefined) throw new Errors.FileNotFoundError(path)
      return {
        parsedContent: content,
        content: Buffer.from(content).toString('base64'),
        sha: sourceSha,
      }
    },
    buildChangeSet(...args) {
      return ReleasePleaseGitHub.prototype.buildChangeSet.call(this, ...args)
    },
    async *releaseIterator() {
      if (previous) yield { tagName: `v${previous}`, sha: 'f'.repeat(40), notes: 'prior' }
    },
    async *tagIterator() {},
    async *mergeCommitIterator() {
      yield { sha: sourceSha, message, files: ['src/fixture.ts'] }
      if (previous)
        yield {
          sha: 'f'.repeat(40),
          message: `chore(main): release ${previous}`,
          files: ['package.json'],
        }
    },
    async *pullRequestIterator() {},
    async createPullRequest(pullRequest, branch, _message, updates) {
      state.beforeWrite?.()
      const changes = await this.buildChangeSet(updates, branch)
      state.writes.push({ pullRequest, changes })
      return { ...pullRequest, number: 43 }
    },
  }
  const plan = await releaseManifest(github, override)
  const build = plan.buildPullRequests.bind(plan)
  plan.buildPullRequests = async () => {
    state.builds++
    return build()
  }
  const options = {
    sourceSha,
    productMetadata,
    async verifySource() {
      state.sourceGuards++
    },
  }
  return { plan, github, state, options, files }
}

void test('pinned GenericJson composes both product fields and replaces the entire initial marker', async () => {
  const fixture = await releasePreviewFixture({ override: '0.1.0' })
  const candidates = await fixture.plan.buildPullRequests()
  const update = candidates[0].updates.find((entry) => entry.path === 'version.json')
  assert.equal(update.updater.constructor.name, 'CompositeUpdater')
  assert.deepEqual(
    update.updater.updaters.map((updater) => updater.jsonpath),
    ['$.version', '$.candidateVersion'],
  )
  assert.deepEqual(JSON.parse(update.updater.updateContent(fixture.files.get('version.json'))), {
    version: '0.1.0',
    candidateVersion: '0.1.0',
  })
})

void test('the validated pinned-library candidate is built once and is the exact subsequent PR write', async () => {
  for (const [previous, message, override, expected] of [
    ['', 'fix: first correction', '0.1.0', '0.1.0'],
    ['0.1.0', 'fix: correction', '', '0.1.1'],
    ['0.1.0', 'feat: capability', '', '0.2.0'],
    ['0.1.0', 'feat!: new contract\n\nBREAKING CHANGE: protocol changes', '', '0.2.0'],
    ['0.1.0', 'chore: maintain tooling', '', ''],
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each version decision uses a fresh real Manifest and complete immutable source.
    const fixture = await releasePreviewFixture({ previous, message, override })
    // oxlint-disable-next-line eslint/no-await-in-loop -- The actual pinned createPullRequests consumes the validated cached build.
    await createValidatedPullRequests(fixture.plan, fixture.github, fixture.options)
    assert.equal(fixture.state.builds, 1)
    assert.equal(fixture.state.sourceGuards, 2)
    assert.equal(fixture.state.writes.length, expected ? 1 : 0)
    if (!expected) continue
    const { pullRequest, changes } = fixture.state.writes[0]
    assert.equal(pullRequest.title, `chore(main): release ${expected}`)
    for (const path of [
      'version.json',
      'package.json',
      'apps/desktop/package.json',
      '.release-please-manifest.json',
    ]) {
      const metadata = JSON.parse(changes.get(path).content)
      assert.equal(metadata[path === '.release-please-manifest.json' ? '.' : 'version'], expected)
      if (path === 'version.json') assert.equal(metadata.candidateVersion, expected)
    }
  }
})

void test('RELEASE AS same-version or rollback cannot write an App PR', async () => {
  for (const [previous, target] of [
    ['0.1.0', '0.1.0'],
    ['0.2.0', '0.1.0'],
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The actual parser must reject each semantic release contradiction before mutation.
    const fixture = await releasePreviewFixture({
      previous,
      message: `fix: override\n\nRelease-As: ${target}`,
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each real candidate is independently admitted and blocked without a write.
    await assert.rejects(
      createValidatedPullRequests(fixture.plan, fixture.github, fixture.options),
      previous === target ? /no new release intent/ : /strictly increase/,
    )
    assert.equal(fixture.state.writes.length, 0)
  }
})

void test('a missing/unchanged marker, unauthorized major or source drift blocks the prospective PR write', async () => {
  const unchanged = await releasePreviewFixture({ previous: '0.1.0', message: 'fix: correction' })
  const originalBuild = unchanged.plan.buildPullRequests.bind(unchanged.plan)
  unchanged.plan.buildPullRequests = async () => {
    const candidates = await originalBuild()
    const update = candidates[0].updates.find((entry) => entry.path === 'version.json')
    update.updater.updaters = update.updater.updaters.filter(
      (updater) => updater.jsonpath !== '$.candidateVersion',
    )
    return candidates
  }
  await assert.rejects(
    createValidatedPullRequests(unchanged.plan, unchanged.github, unchanged.options),
    /Product version/,
  )
  assert.equal(unchanged.state.writes.length, 0)

  const missing = await releasePreviewFixture({ override: '0.1.0' })
  missing.options.productMetadata = { version: '0.1.0' }
  missing.files.set('version.json', JSON.stringify(missing.options.productMetadata))
  await assert.rejects(
    createValidatedPullRequests(missing.plan, missing.github, missing.options),
    /Product version/,
  )
  assert.equal(missing.state.writes.length, 0)

  const major = await releasePreviewFixture({
    previous: '0.1.0',
    message: 'feat: explicit major\n\nRelease-As: 1.0.0',
  })
  await assert.rejects(
    createValidatedPullRequests(major.plan, major.github, major.options),
    /owner approval/,
  )
  assert.equal(major.state.writes.length, 0)
  await createValidatedPullRequests(major.plan, major.github, {
    ...major.options,
    approvedMajor: '1',
  })
  assert.equal(major.state.writes.length, 1)

  const drift = await releasePreviewFixture({ previous: '0.1.0' })
  drift.state.beforeWrite = () => drift.files.set('CHANGELOG.md', '# Concurrent main change\n')
  await assert.rejects(
    createValidatedPullRequests(drift.plan, drift.github, drift.options),
    /changed after preview/,
  )
  assert.equal(drift.state.writes.length, 0)
})

void test('a changed main identity or non-version candidate update cannot write a PR', async () => {
  const changed = await releasePreviewFixture({ previous: '0.1.0' })
  changed.options.verifySource = async () => {
    changed.state.sourceGuards++
    if (changed.state.sourceGuards === 2) throw new Error('Current main changed')
  }
  await assert.rejects(
    createValidatedPullRequests(changed.plan, changed.github, changed.options),
    /main changed/,
  )
  assert.equal(changed.state.writes.length, 0)

  const nonVersion = await releasePreviewFixture({ previous: '0.1.0' })
  const build = nonVersion.plan.buildPullRequests.bind(nonVersion.plan)
  nonVersion.plan.buildPullRequests = async () => {
    const candidates = await build()
    const update = candidates[0].updates.find((entry) => entry.path === 'package.json')
    const originalUpdate = update.updater.updateContent.bind(update.updater)
    update.updater = {
      updateContent(content) {
        return JSON.stringify({ ...JSON.parse(originalUpdate(content)), private: false })
      },
    }
    return candidates
  }
  await assert.rejects(
    createValidatedPullRequests(nonVersion.plan, nonVersion.github, nonVersion.options),
    /non-version/,
  )
  assert.equal(nonVersion.state.writes.length, 0)
})

void test('a same-App uploader cannot supply self-consistent substituted contents under a valid identity signature', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-signed-content-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api, state } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  await publishRelease(api, established, root, signContext)
  const asset = state.assets.find((item) => item.name.endsWith('.exe'))
  asset.content = Buffer.from('substituted-but-same-App')
  asset.size = asset.content.length
  asset.hash = digest(asset.content)
  const provenance = state.assets.find((item) => item.name === 'release-provenance.json')
  const claims = JSON.parse(provenance.content)
  const claim = claims.assets.find((item) => item.name === asset.name)
  claim.sha256 = asset.hash
  claim.bytes = asset.size
  provenance.content = Buffer.from(JSON.stringify(claims))
  provenance.size = provenance.content.length
  provenance.hash = digest(provenance.content)
  const writes = state.mutations.length
  await assert.rejects(
    restorePlatform(api, established, 'win32-x64', join(root, 'restore'), signContext),
    /signed commitment/,
  )
  assert.equal(state.mutations.length, writes)
})

void test('persistent signed staging recovers exact original platform bytes after Actions artifacts expire', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-persistent-staging-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(RELEASE_PLATFORMS.map((key) => bundleFixture(context, key, root)))
  const { api, state } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  const stagingContext = { ...signContext, attempt: 1 }
  for (const key of RELEASE_PLATFORMS) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bind each in-memory Actions fixture to an actual archive digest.
    await archiveFixture(context, state, key, join(root, key))
    // oxlint-disable-next-line eslint/no-await-in-loop -- Persist each independently completed platform immediately.
    await stagePlatform(api, established, key, join(root, key), stagingContext)
  }
  assert.equal(
    (await findStagedPlatforms(api, established, signContext)).length,
    RELEASE_PLATFORMS.length,
  )
  // Remove the transient workflow copies: only durable signed draft bytes remain.
  await Promise.all(RELEASE_PLATFORMS.map((key) => rm(join(root, key), { recursive: true })))
  const output = join(root, 'restored')
  const selectedStages = await materializeStagedPlatforms(api, established, output, signContext)
  await publishRelease(api, established, output, { ...signContext, selectedStages })
  const mutations = state.mutations.length
  await materializeStagedPlatforms(api, established, join(root, 'second-read'), signContext)
  assert.equal(state.mutations.length, mutations)
  assert.ok(state.stages.every((release) => release.draft))
})

void test('partial staging intent survives an upload interruption and refuses unknown same-App bytes', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  const { api, state } = apiFixture()
  const established = { ...identity, releaseId: 100 }
  const stagingContext = { ...signContext, attempt: 1 }
  await archiveFixture(context, state, 'win32-x64', bundle.root)
  const upload = api.upload.bind(api)
  let attempted = 0
  api.upload = async (...args) => {
    if (++attempted === 2) throw Error('synthetic interrupted upload')
    return upload(...args)
  }
  await assert.rejects(
    stagePlatform(api, established, 'win32-x64', bundle.root, stagingContext),
    /interrupted/,
  )
  assert.equal(state.assets.length, 1)
  assert.equal(decodeIdentity(state.stages[0].body).staging.complete, false)
  api.upload = upload
  await stagePlatform(api, established, 'win32-x64', bundle.root, stagingContext)
  assert.equal(decodeIdentity(state.stages[0].body).staging.complete, true)
  state.assets[0].hash = digest('substituted same App data')
  const writes = state.mutations.length
  await assert.rejects(
    findStagedPlatforms(api, established, signContext),
    /mismatched staging bytes/,
  )
  assert.equal(state.mutations.length, writes)
})

void test('an authenticated empty draft changed to published cannot settle labels or become a published version', async () => {
  const { api, state } = apiFixture({ published: true })
  await assert.rejects(
    authenticatePublishedReleases(api, [state.release], signContext),
    /complete signed publication proof/,
  )
  assert.equal(state.mutations.length, 0)
})

void test('an archive digest mismatch stops staging before any remote content is signed or uploaded', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  const { api, state } = apiFixture()
  await archiveFixture(context, state, 'win32-x64', bundle.root)
  const request = api.request.bind(api)
  api.request = (path, options) =>
    path.endsWith('/actions/artifacts/1001/zip')
      ? Promise.resolve(new Response('substituted archive'))
      : request(path, options)
  await assert.rejects(
    stagePlatform(api, { ...identity, releaseId: 100 }, 'win32-x64', bundle.root, {
      ...signContext,
      attempt: 1,
    }),
    /archive digest mismatch/,
  )
  assert.equal(state.mutations.length, 0)
})

void test('a fully uploaded signed staging intent settles interrupted completion without original Actions artifacts', async (context) => {
  const bundle = await bundleFixture(context, 'win32-x64')
  const { api, state } = apiFixture()
  await archiveFixture(context, state, 'win32-x64', bundle.root)
  const request = api.request.bind(api)
  api.request = (path, options) => {
    if (
      options?.method === 'PATCH' &&
      options.body?.body &&
      path.endsWith('/releases/200') &&
      decodeIdentity(options.body.body).staging.complete
    )
      throw Error('interrupted completion marker')
    return request(path, options)
  }
  const established = { ...identity, releaseId: 100 }
  await assert.rejects(
    stagePlatform(api, established, 'win32-x64', bundle.root, { ...signContext, attempt: 1 }),
    /completion marker/,
  )
  assert.equal(state.assets.length, 3)
  const writes = state.mutations.length
  api.request = (path, options) =>
    path.endsWith('/actions/artifacts/1001/zip')
      ? Promise.resolve(new Response('substituted new transfer'))
      : request(path, options)
  await assert.rejects(
    stagePlatform(api, established, 'win32-x64', bundle.root, { ...signContext, attempt: 1 }),
    /archive digest mismatch/,
  )
  assert.equal(state.mutations.length, writes)
  assert.equal(decodeIdentity(state.stages[0].body).staging.complete, false)
  state.archives.clear()
  await rm(bundle.root, { recursive: true })
  api.request = request
  const selected = await findStagedPlatforms(api, established, signContext)
  assert.equal(selected.length, 1)
  assert.equal(selected[0].state.staging.complete, true)
  assert.equal(selected[0].state.staging.runId, 10)
})
