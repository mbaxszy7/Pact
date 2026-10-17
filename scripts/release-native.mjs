import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { artifactDigest, validateCandidate } from './ci-artifacts.mjs'
import { isScriptEntry } from './script-entry.mjs'

const repository = 'mbaxszy7/Pact'
const shaPattern = /^[a-f0-9]{40}$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const platforms = ['darwin-arm64', 'win32-x64']
const maximumAssets = 32
const maximumAssetBytes = 2 * 1024 ** 3
const execFileAsync = promisify(execFile)
const digest = (value) => createHash('sha256').update(value).digest('hex')
function requireFact(value, message) {
  if (!value) throw new Error(message)
}
function positive(value) {
  const number = Number(value)
  requireFact(
    /^[1-9]\d{0,15}$/u.test(String(value)) && Number.isSafeInteger(number),
    'Invalid native execution identifier',
  )
  return number
}
function releaseIdentity(value) {
  requireFact(
    value &&
      shaPattern.test(value.sourceSha) &&
      versionPattern.test(value.version) &&
      value.version !== '0.0.0' &&
      value.tag === `v${value.version}`,
    'Invalid release source or version',
  )
  requireFact(
    value.version.split('.').every((part) => Number.isSafeInteger(Number(part))),
    'Release version exceeds its numeric bound',
  )
  return {
    sourceSha: value.sourceSha,
    version: value.version,
    tag: value.tag,
    releasePR: positive(value.releasePR),
  }
}
async function boundedBytes(response, maximum) {
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    requireFact(length <= maximum, 'GitHub response exceeds its byte bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Repository-scoped REST operations; uncertain mutations are never automatically retried. */
export class ReleaseGitHub {
  constructor(token, { fetchImpl = fetch } = {}) {
    requireFact(
      typeof token === 'string' && token.length > 0,
      'A short-lived GitHub token is required',
    )
    this.token = token
    this.fetch = fetchImpl
    this.deadline = Date.now() + 30 * 60_000
    this.requests = 0
  }
  signal(milliseconds = 30_000) {
    requireFact(
      ++this.requests <= 1024 && Date.now() < this.deadline,
      'Release API work exceeded its bounded lifetime',
    )
    return AbortSignal.timeout(Math.max(1, Math.min(milliseconds, this.deadline - Date.now())))
  }
  headers(binary = false) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }
  async request(suffix, { method = 'GET', body, optional = false } = {}) {
    requireFact(
      suffix.startsWith('/') && !/[\r\n\0]/u.test(suffix),
      'Invalid repository API operation',
    )
    const response = await this.fetch(`https://api.github.com/repos/${repository}${suffix}`, {
      method,
      headers: { ...this.headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: this.signal(),
    })
    if (optional && response.status === 404) return null
    if (!response.ok) {
      const operation = ['GET', 'POST', 'PATCH', 'DELETE'].includes(method) ? method : 'UNKNOWN'
      const status =
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : 0
      console.error(`[pact-release] api-method=${operation} http-status=${status}`)
    }
    requireFact(response.ok, `GitHub ${method} failed with HTTP ${response.status}`)
    if (response.status === 204) return null
    return JSON.parse((await boundedBytes(response, 2 * 1024 ** 2)).toString('utf8'))
  }
  async list(suffix) {
    const result = []
    for (let page = 1; page <= 100; page++) {
      // oxlint-disable-next-line no-await-in-loop -- Complete bounded pagination before admitting a release or asset set.
      const items = await this.request(
        `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      )
      requireFact(Array.isArray(items), 'Invalid GitHub collection')
      result.push(...items)
      if (items.length < 100) return result
    }
    throw new Error('Release lookup exceeds its 10,000-item bound')
  }
  async sourceFile(path, sha, maximum = 64 * 1024) {
    requireFact(shaPattern.test(sha), 'An immutable source SHA is required')
    const file = await this.request(`/contents/${path}?ref=${sha}`)
    requireFact(
      file.type === 'file' && file.encoding === 'base64' && file.size > 0 && file.size <= maximum,
      'Invalid bounded release source file',
    )
    const bytes = Buffer.from(file.content, 'base64')
    requireFact(
      bytes.length === file.size && bytes.length <= maximum,
      'Incomplete release source file',
    )
    return bytes.toString('utf8')
  }
  async upload(releaseId, file) {
    const response = await this.fetch(
      `https://uploads.github.com/repos/${repository}/releases/${positive(releaseId)}/assets?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(file.bytes),
        },
        body: createReadStream(file.path),
        duplex: 'half',
        redirect: 'error',
        signal: this.signal(15 * 60_000),
      },
    )
    requireFact(
      response.ok,
      `Asset upload failed with HTTP ${response.status}; delivery must be reconciled before retry`,
    )
    return JSON.parse((await boundedBytes(response, 64 * 1024)).toString('utf8'))
  }
  async assetHash(asset) {
    requireFact(
      asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= maximumAssetBytes,
      'Asset upload is incomplete or oversized',
    )
    const response = await this.fetch(
      `https://api.github.com/repos/${repository}/releases/assets/${positive(asset.id)}`,
      {
        headers: this.headers(true),
        signal: this.signal(15 * 60_000),
        redirect: 'follow',
      },
    )
    requireFact(response.ok, `Asset download failed with HTTP ${response.status}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      requireFact(bytes <= asset.size, 'Downloaded asset exceeds its declared size')
      hash.update(chunk)
    }
    requireFact(bytes === asset.size, 'Downloaded asset is incomplete')
    return hash.digest('hex')
  }
}

/** Only the actual merged version PR for this main push starts formal publication. */
export async function resolveRelease(api, source) {
  requireFact(
    source.GITHUB_REPOSITORY === repository &&
      source.GITHUB_EVENT_NAME === 'push' &&
      source.GITHUB_REF === 'refs/heads/main' &&
      shaPattern.test(source.GITHUB_SHA ?? ''),
    'Release resolution requires the exact protected-main push',
  )
  const sha = source.GITHUB_SHA
  const related = await api.list(`/commits/${sha}/pulls`)
  const candidates = related.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === sha &&
      pr.base?.ref === 'main' &&
      pr.head?.ref === 'release-please--branches--main' &&
      pr.head?.repo?.full_name === repository,
  )
  requireFact(candidates.length <= 1, 'Release commit is associated with multiple version PRs')
  if (!candidates.length) return { applicable: false, sourceSha: sha }
  const pr = await api.request(`/pulls/${positive(candidates[0].number)}`)
  requireFact(
    pr.merged === true &&
      pr.state === 'closed' &&
      pr.merge_commit_sha === sha &&
      pr.base?.repo?.full_name === repository &&
      pr.base.ref === 'main' &&
      pr.head?.repo?.full_name === repository &&
      pr.head.ref === 'release-please--branches--main',
    'Version PR association changed',
  )
  const paths = [
    'version.json',
    'package.json',
    'apps/desktop/package.json',
    '.release-please-manifest.json',
  ]
  const [product, root, desktop, manifest] = await Promise.all(
    paths.map(async (path) => JSON.parse(await api.sourceFile(path, sha))),
  )
  const identity = releaseIdentity({
    sourceSha: sha,
    version: product.version,
    tag: `v${product.version}`,
    releasePR: pr.number,
  })
  requireFact(
    root.version === identity.version &&
      desktop.version === identity.version &&
      manifest['.'] === identity.version &&
      !Object.hasOwn(product, 'candidateVersion'),
    'Release version authorities differ',
  )
  await releaseNotes(api, identity)
  return { applicable: true, ...identity }
}

async function releaseNotes(api, identity) {
  const changelog = await api.sourceFile('CHANGELOG.md', identity.sourceSha, 128 * 1024)
  const lines = changelog.split(/\r?\n/u)
  const escaped = identity.version.replaceAll('.', '\\.')
  const index = lines.findIndex((line) =>
    new RegExp(`^## \\[?${escaped}\\]?(?:[ (]|$)`, 'u').test(line),
  )
  requireFact(index >= 0, 'The exact release version has no changelog section')
  const next = lines.findIndex((line, position) => position > index && line.startsWith('## '))
  const notes = lines
    .slice(index, next < 0 ? undefined : next)
    .join('\n')
    .trim()
  requireFact(
    notes.length > 0 && Buffer.byteLength(notes) <= 64 * 1024,
    'Release notes exceed their bound',
  )
  return notes
}

async function verifyTag(api, identity, optional) {
  let ref = await api.request(`/git/ref/tags/${identity.tag}`, { optional })
  if (ref === null) return
  for (let depth = 0; depth < 8; depth++) {
    if (ref.object?.type === 'commit') {
      requireFact(
        ref.object.sha === identity.sourceSha,
        'Release tag points to different source bytes',
      )
      return
    }
    requireFact(
      ref.object?.type === 'tag' && shaPattern.test(ref.object.sha),
      'Invalid release tag object',
    )
    // oxlint-disable-next-line no-await-in-loop -- Resolve at most eight immutable annotated tag objects.
    ref = await api.request(`/git/tags/${ref.object.sha}`)
  }
  throw new Error('Annotated release tag chain exceeds its bound')
}

async function checkArtifact(api, id, expectedDigest, runId, sourceSha) {
  const artifact = await api.request(`/actions/artifacts/${positive(id)}`)
  requireFact(
    artifact.id === Number(id) &&
      artifact.expired === false &&
      artifact.workflow_run?.id === runId &&
      artifact.workflow_run.head_sha === sourceSha &&
      artifactDigest(artifact.digest) === artifactDigest(expectedDigest),
    'Artifact identity, digest, source, run or retention differs',
  )
}

async function admitReleaseFiles(api, root, identity, artifacts, runId) {
  requireFact(
    artifacts && Object.keys(artifacts).toSorted().join() === [...platforms].toSorted().join(),
    'Both native platform artifact sets are required',
  )
  const files = [],
    evidence = [],
    projections = [],
    ids = new Set()
  for (const key of platforms) {
    const input = artifacts[key]
    const [platform, arch] = key.split('-')
    requireFact(input && Object.keys(input).length === 4, 'Unexpected release artifact fields')
    for (const [id, hash] of [
      [input.packageId, input.packageDigest],
      [input.smokeId, input.smokeDigest],
    ]) {
      requireFact(!ids.has(positive(id)), 'Release artifact IDs must be distinct')
      ids.add(Number(id))
      // oxlint-disable-next-line no-await-in-loop -- Four immutable producer artifacts are admitted serially with bounded API work.
      await checkArtifact(api, id, hash, runId, identity.sourceSha)
    }
    // oxlint-disable-next-line no-await-in-loop -- Hash one platform's bounded file set at a time.
    const validated = await validateCandidate({
      packageRoot: join(root, key, 'package'),
      smokeRoot: join(root, key, 'smoke'),
      packageId: input.packageId,
      packageDigest: input.packageDigest,
      expected: {
        sourceSha: identity.sourceSha,
        version: identity.version,
        runId,
        platform,
        arch,
        channel: 'stable',
      },
    })
    files.push(...validated.installers)
    evidence.push(...validated.files)
    projections.push({
      platform: key,
      packageArtifactId: Number(input.packageId),
      smokeArtifactId: Number(input.smokeId),
      packageDigest: artifactDigest(input.packageDigest),
      smokeDigest: artifactDigest(input.smokeDigest),
      packageAttempt: validated.packageContext.producerAttempt,
      smokeAttempt: validated.smokeContext.producerAttempt,
      appContentHash: validated.manifest.application.contentSha256,
      files: validated.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    })
  }
  const publication = { schemaVersion: 1, repository, ...identity, runId, platforms: projections }
  const manifestBytes = `${JSON.stringify(publication, null, 2)}\n`
  requireFact(
    Buffer.byteLength(manifestBytes) <= 4 * 1024 ** 2,
    'Release manifest exceeds its byte bound',
  )
  const add = async (name, bytes) => {
    const path = join(root, name)
    try {
      await writeFile(path, bytes, { flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = await lstat(path)
      requireFact(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.size === Buffer.byteLength(bytes) &&
          (await readFile(path, 'utf8')) === bytes,
        'Existing release evidence cannot be replaced',
      )
    }
    evidence.push({ path, name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  await add('pact-release-manifest.json', manifestBytes)
  await add('SHA256SUMS', evidence.map((file) => `${file.sha256}  ${file.name}\n`).join(''))
  requireFact(
    evidence.length <= maximumAssets &&
      new Set(evidence.map((file) => file.name)).size === evidence.length,
    'Release asset set exceeds its bound or has collisions',
  )
  return files
}

async function verifyAssets(api, releaseId, files, complete) {
  const assets = await api.list(`/releases/${positive(releaseId)}/assets`)
  requireFact(
    assets.length <= maximumAssets &&
      new Set(assets.map((asset) => asset.name)).size === assets.length,
    'Remote release has duplicate or too many assets',
  )
  const expected = new Map(files.map((file) => [file.name, file]))
  for (const asset of assets) {
    const file = expected.get(asset.name)
    requireFact(file && asset.size === file.bytes, 'Remote release has unexpected asset bytes')
    requireFact(
      // oxlint-disable-next-line no-await-in-loop -- Stream one remote asset at a time without retaining binary contents.
      (await api.assetHash(asset)) === file.sha256,
      'Existing asset differs; replacement is forbidden',
    )
  }
  if (complete) requireFact(assets.length === files.length, 'Release has missing assets')
  return new Set(assets.map((asset) => asset.name))
}

async function nativeReleaseProof(identity) {
  try {
    await execFileAsync('gh', ['release', 'verify', identity.tag, '--repo', repository], {
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    })
  } catch {
    throw new Error('Native immutable Release attestation is not verified')
  }
}

export async function publishRelease(
  api,
  {
    root,
    identity: input,
    artifacts,
    runId: inputRunId,
    verifyProof = nativeReleaseProof,
    reportPhase = () => {},
  },
) {
  const identity = releaseIdentity(input)
  const runId = positive(inputRunId)
  reportPhase('admit-candidates')
  const files = await admitReleaseFiles(api, root, identity, artifacts, runId)
  reportPhase('verify-initial-tag')
  await verifyTag(api, identity, true)
  reportPhase('resolve-release')
  const matches = (await api.list('/releases')).filter(
    (release) => release.tag_name === identity.tag,
  )
  requireFact(matches.length <= 1, 'Ambiguous Draft or published release identity')
  let release = matches[0]
  if (!release) {
    reportPhase('create-draft')
    release = await api.request('/releases', {
      method: 'POST',
      body: {
        tag_name: identity.tag,
        target_commitish: identity.sourceSha,
        name: `Pact ${identity.version}`,
        body: await releaseNotes(api, identity),
        draft: true,
        prerelease: false,
      },
    })
  }
  requireFact(
    release.prerelease === false &&
      release.target_commitish === identity.sourceSha &&
      release.tag_name === identity.tag,
    'Draft or published version points to another source',
  )
  reportPhase('verify-existing-assets')
  const present = await verifyAssets(api, release.id, files, !release.draft)
  if (release.draft) {
    reportPhase('upload-installers')
    for (const file of files)
      if (!present.has(file.name)) {
        await api.upload(release.id, file)
      }
    reportPhase('verify-draft-assets')
    await verifyAssets(api, release.id, files, true)
    reportPhase('verify-draft-tag')
    await verifyTag(api, identity, true)
    reportPhase('publish-draft')
    release = await api.request(`/releases/${positive(release.id)}`, {
      method: 'PATCH',
      body: { draft: false, make_latest: 'true' },
    })
  }
  reportPhase('verify-immutable-release')
  requireFact(
    release.draft === false && release.immutable === true,
    'Release must be published with native immutability enabled',
  )
  reportPhase('verify-published-tag')
  await verifyTag(api, identity, false)
  reportPhase('verify-published-assets')
  await verifyAssets(api, release.id, files, true)
  reportPhase('verify-native-attestation')
  await verifyProof(identity)
  reportPhase('verify-version-pr')
  const pr = await api.request(`/pulls/${identity.releasePR}`)
  requireFact(
    pr.merged === true &&
      pr.merge_commit_sha === identity.sourceSha &&
      pr.base?.ref === 'main' &&
      pr.head?.ref === 'release-please--branches--main',
    'Published release no longer matches its version PR',
  )
  reportPhase('add-tagged-label')
  await api.request(`/issues/${identity.releasePR}/labels`, {
    method: 'POST',
    body: { labels: ['autorelease: tagged'] },
  })
  if (pr.labels?.some((label) => label.name === 'autorelease: pending')) {
    reportPhase('remove-pending-label')
    await api.request(
      `/issues/${identity.releasePR}/labels/${encodeURIComponent('autorelease: pending')}`,
      { method: 'DELETE' },
    )
  }
  reportPhase('complete')
  return { releaseId: release.id, version: identity.version, sourceSha: identity.sourceSha }
}

export async function main(args = process.argv.slice(2), source = process.env) {
  requireFact(
    source.GITHUB_ACTIONS === 'true' &&
      source.GITHUB_REPOSITORY === repository &&
      source.GITHUB_REF === 'refs/heads/main' &&
      source.GITHUB_EVENT_NAME === 'push',
    'Formal release operations require the original protected-main push',
  )
  const api = new ReleaseGitHub(source.GH_TOKEN)
  if (args.length === 1 && args[0] === 'resolve') {
    const identity = await resolveRelease(api, source)
    requireFact(source.GITHUB_OUTPUT, 'Native job outputs are required')
    await appendFile(
      source.GITHUB_OUTPUT,
      Object.entries({
        applicable: String(identity.applicable),
        source_sha: identity.sourceSha,
        version: identity.version ?? '',
        tag: identity.tag ?? '',
        release_pr: identity.releasePR ?? '',
      })
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
    return identity
  }
  requireFact(
    args.length === 3 && args[0] === 'publish' && args[1] === '--root',
    'Use resolve or publish --root DIRECTORY',
  )
  const identity = releaseIdentity({
    sourceSha: source.PACT_RELEASE_SOURCE_SHA,
    version: source.PACT_RELEASE_VERSION,
    tag: source.PACT_RELEASE_TAG,
    releasePR: source.PACT_RELEASE_PR,
  })
  requireFact(
    identity.sourceSha === source.GITHUB_SHA &&
      Buffer.byteLength(source.PACT_RELEASE_ARTIFACTS_JSON ?? '') <= 16 * 1024,
    'Release source differs from the original event or artifact input exceeds its bound',
  )
  return publishRelease(api, {
    root: resolve(args[2]),
    identity,
    artifacts: JSON.parse(source.PACT_RELEASE_ARTIFACTS_JSON),
    runId: source.GITHUB_RUN_ID,
    reportPhase: (phase) => console.log(`[pact-release] phase=${phase}`),
  })
}

if (isScriptEntry(import.meta.url))
  main().catch(() => {
    console.error(
      'Native release operation failed; inspect the verified job identity and bounded evidence.',
    )
    process.exitCode = 1
  })
