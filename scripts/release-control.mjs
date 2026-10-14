import { execFile } from 'node:child_process'
import { constants, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { isScriptEntry } from './script-entry.mjs'

const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MARKER = 'PACT_RELEASE_IDENTITY:'
const NOTES_START = '<!-- PACT_RELEASE_NOTES_START -->'
const NOTES_END = '<!-- PACT_RELEASE_NOTES_END -->'
const OWNER_ID = 31481964
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ASSETS = 32
const MAX_TRUSTED_RUNS = 128
const SIGNATURE_DOMAIN = 'PACT_STABLE_RELEASE_CONTROL_IDENTITY_V1\0'
const execFileAsync = promisify(execFile)
export const RELEASE_PLATFORMS = ['darwin-arm64', 'win32-x64', 'win32-arm64']

function requireFact(condition, message) {
  if (!condition) throw new Error(message)
}

async function responseBytes(response, limit) {
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    requireFact(bytes <= limit, 'Downloaded JSON exceeds its byte bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function releaseVersion(value, approvedMajor = '') {
  requireFact(typeof value === 'string' && VERSION.test(value), 'Invalid stable product version')
  requireFact(
    value.split('.').every((part) => Number.isSafeInteger(Number(part))),
    'Product version exceeds its numeric bound',
  )
  requireFact(value !== '0.0.0', 'Product version 0.0.0 cannot be released')
  const major = value.split('.')[0]
  requireFact(
    major === '0' || approvedMajor === major,
    'A stable major version needs owner approval',
  )
  return value
}

export function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/** Bounded REST owner. Mutations are never blindly retried after uncertain delivery. */
export class GitHub {
  constructor(repository, token, { fetchImpl = fetch, actionsToken } = {}) {
    requireFact(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository identity')
    requireFact(typeof token === 'string' && token.length > 0, 'GitHub App token is missing')
    this.repository = repository
    this.token = token
    this.fetch = fetchImpl
    this.actionsToken = actionsToken
  }

  async request(path, { method = 'GET', body, optional = false, binary = false } = {}) {
    requireFact(path.startsWith('/'), 'API path must be repository-relative')
    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        Authorization: `Bearer ${path.startsWith(this.path('/actions/')) ? (this.actionsToken ?? this.token) : this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(binary ? 15 * 60_000 : 30_000),
      redirect: binary ? 'follow' : 'error',
    })
    if (response.status === 404 && optional) return null
    requireFact(response.ok, `GitHub ${method} failed with HTTP ${response.status}`)
    if (binary) return response
    if (response.status === 204) return null
    return JSON.parse((await responseBytes(response, MAX_JSON_BYTES)).toString('utf8'))
  }

  async list(path, field) {
    const items = []
    for (let page = 1; page <= 100; page++) {
      const separator = path.includes('?') ? '&' : '?'
      // oxlint-disable-next-line eslint/no-await-in-loop -- Pagination admits one bounded page and proves completion before the next.
      const response = await this.request(`${path}${separator}per_page=100&page=${page}`)
      const batch = field ? response[field] : response
      requireFact(Array.isArray(batch), 'Expected a paginated GitHub list')
      items.push(...batch)
      if (batch.length < 100) return items
    }
    throw new Error('GitHub pagination exceeds 10,000 items; identity is incomplete')
  }

  path(suffix) {
    return `/repos/${this.repository}${suffix}`
  }

  async jsonAt(path, sha) {
    requireFact(SHA.test(sha), 'A complete immutable commit SHA is required')
    const response = await this.request(this.path(`/contents/${path}?ref=${sha}`))
    requireFact(
      response.type === 'file' && response.encoding === 'base64',
      'Expected a version file',
    )
    requireFact(response.size <= 64 * 1024, 'Version file exceeds its bound')
    return JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'))
  }

  async assetDigest(asset) {
    requireFact(asset.state === 'uploaded', 'An incomplete asset blocks recovery')
    requireFact(asset.size > 0 && asset.size <= MAX_ASSET_BYTES, 'Asset exceeds its byte bound')
    // Download and hash: the API digest alone does not validate transferred bytes.
    const response = await this.request(this.path(`/releases/assets/${asset.id}`), { binary: true })
    let bytes = 0
    const hash = createHash('sha256')
    for await (const chunk of response.body) {
      bytes += chunk.length
      requireFact(bytes <= asset.size, 'Downloaded asset exceeds its advertised bytes')
      hash.update(chunk)
    }
    requireFact(bytes === asset.size, 'Downloaded asset is incomplete')
    return hash.digest('hex')
  }

  async upload(releaseId, file, name) {
    const info = await stat(file)
    requireFact(
      info.isFile() && info.size > 0 && info.size <= MAX_ASSET_BYTES,
      'Invalid release asset',
    )
    const response = await this.fetch(
      `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
        },
        body: Readable.toWeb(createReadStream(file)),
        duplex: 'half',
        signal: AbortSignal.timeout(15 * 60_000),
        redirect: 'error',
      },
    )
    requireFact(
      response.ok,
      `Release upload failed with HTTP ${response.status}; recover before retry`,
    )
    await response.body?.cancel()
  }
}

function isReleaseBranch(pr) {
  return pr.head?.ref === 'release-please--branches--main'
}

/** PR API identity, not event sender, author text, label alone, or commit author. */
export async function resolveReleaseIdentity(api, number, { botId, appSlug, approvedMajor = '' }) {
  requireFact(Number.isSafeInteger(number) && number > 0, 'A Release PR number is required')
  requireFact(Number.isSafeInteger(botId) && botId > 0, 'Verified App bot user ID is missing')
  requireFact(/^[a-z0-9-]+$/.test(appSlug), 'Verified App slug is missing')
  const bot = await api.request(`/users/${encodeURIComponent(`${appSlug}[bot]`)}`)
  requireFact(bot.id === botId && bot.type === 'Bot', 'GitHub App bot identity changed')
  const pr = await api.request(api.path(`/pulls/${number}`))
  if (!isReleaseBranch(pr)) return null
  requireFact(pr.base?.ref === 'main', 'Release PR must target main')
  requireFact(pr.base.repo.full_name === api.repository, 'Release PR targets another repository')
  requireFact(pr.head.repo.full_name === api.repository, 'Release PR comes from another repository')
  requireFact(
    pr.user?.id === botId && pr.user.type === 'Bot',
    'Release PR author is not the fixed App',
  )
  requireFact(pr.merged === true && pr.state === 'closed', 'Release PR is not merged')
  requireFact(pr.merged_by?.id === OWNER_ID, 'Release PR was not merged by the repository owner')
  requireFact(pr.auto_merge === null, 'Release PR must be manually merged')
  await verifyOwnerReleaseReview(api, pr)
  requireFact(SHA.test(pr.merge_commit_sha), 'Release PR merge SHA is unresolved')
  requireFact(
    pr.labels.some((label) => ['autorelease: pending', 'autorelease: tagged'].includes(label.name)),
    'Release label is missing',
  )
  const sourceSha = pr.merge_commit_sha
  const versions = await Promise.all([
    api.jsonAt('version.json', sourceSha),
    api.jsonAt('package.json', sourceSha),
    api.jsonAt('apps/desktop/package.json', sourceSha),
    api.jsonAt('.release-please-manifest.json', sourceSha),
  ])
  const version = releaseVersion(versions[0].version, approvedMajor)
  requireFact(
    versions[1].version === version &&
      versions[2].version === version &&
      versions[3]['.'] === version,
    'Product, desktop, root package and Release Please versions disagree at the merge SHA',
  )
  requireFact(pr.title === `chore(main): release ${version}`, 'Release PR title/version disagree')
  return {
    schemaVersion: 1,
    repository: api.repository,
    releasePR: number,
    version,
    sourceSha,
    tag: `v${version}`,
  }
}

export async function verifyOwnerReleaseReview(api, pr) {
  requireFact(SHA.test(pr.head?.sha), 'Release PR head identity is unresolved')
  const mergedAt = Date.parse(pr.merged_at)
  requireFact(Number.isFinite(mergedAt), 'Release PR merge time is unresolved')
  const reviews = await api.list(api.path(`/pulls/${pr.number}/reviews`))
  const meaningful = reviews.filter(
    (review) =>
      review.user?.id === OWNER_ID &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
  )
  for (const review of meaningful)
    requireFact(
      Number.isSafeInteger(review.id) &&
        review.id > 0 &&
        Number.isFinite(Date.parse(review.submitted_at)),
      'Owner review identity is unresolved',
    )
  const latest = meaningful.toSorted((a, b) => a.id - b.id).at(-1)
  requireFact(
    latest?.state === 'APPROVED' &&
      latest.commit_id === pr.head.sha &&
      Date.parse(latest.submitted_at) <= mergedAt,
    'The owner did not approve the actual Release PR head before merging',
  )
}

export function encodeIdentity(identity) {
  return `${MARKER}${Buffer.from(JSON.stringify(identity)).toString('base64')}`
}

export function decodeIdentity(body) {
  const matches = (body ?? '').match(/PACT_RELEASE_IDENTITY:([A-Za-z0-9+/=]+)/g) ?? []
  requireFact(
    matches.length === 1 && matches[0].length <= 32 * 1024,
    'Release has no unambiguous identity',
  )
  return JSON.parse(Buffer.from(matches[0].slice(MARKER.length), 'base64').toString('utf8'))
}

function sameIdentity(actual, expected) {
  requireFact(
    actual && expected && actual.schemaVersion === 1 && expected.schemaVersion === 1,
    'Unsupported persistent release identity',
  )
  requireFact(
    ['schemaVersion', 'repository', 'releasePR', 'version', 'sourceSha', 'tag'].every(
      (field) => actual[field] === expected[field],
    ),
    'Persistent release identity conflicts with the merged Release PR',
  )
}

function storedReleaseNotes(body) {
  requireFact(
    typeof body === 'string' && Buffer.byteLength(body) <= 256 * 1024,
    'Release notes exceed their byte bound',
  )
  const start = body.indexOf(NOTES_START)
  const end = body.indexOf(NOTES_END)
  requireFact(
    start >= 0 &&
      end > start &&
      body.lastIndexOf(NOTES_START) === start &&
      body.lastIndexOf(NOTES_END) === end,
    'Persistent release notes are missing or ambiguous',
  )
  return body.slice(start + NOTES_START.length, end).trim()
}

function signingKey(pem) {
  requireFact(
    typeof pem === 'string' && Buffer.byteLength(pem) <= 16 * 1024,
    'Protected release signing key is missing',
  )
  let key
  try {
    key = createPrivateKey(pem)
  } catch {
    throw new Error('Protected release signing key is invalid')
  }
  requireFact(
    key.asymmetricKeyType === 'rsa' &&
      key.asymmetricKeyDetails.modulusLength >= 2048 &&
      key.asymmetricKeyDetails.modulusLength <= 4096,
    'Unsupported release signing key',
  )
  return key
}

function signaturePayload(state) {
  requireFact(
    state.schemaVersion === 1 && SHA.test(state.sourceSha) && HASH.test(state.releaseNotesSha256),
    'Invalid signed release identity',
  )
  requireFact(
    state.releaseId === null || (Number.isSafeInteger(state.releaseId) && state.releaseId > 0),
    'Invalid signed Release ID',
  )
  requireFact(
    Number.isSafeInteger(state.appBotId) && state.appBotId > 0,
    'Signed App identity is missing',
  )
  requireFact(
    Array.isArray(state.trustedRuns) &&
      state.trustedRuns.length > 0 &&
      state.trustedRuns.length <= MAX_TRUSTED_RUNS,
    'Trusted run ledger exceeds its bound or is missing',
  )
  let previous = 0
  for (const run of state.trustedRuns) {
    requireFact(
      Number.isSafeInteger(run.runId) && run.runId > previous && SHA.test(run.controlSourceSha),
      'Trusted run ledger is incomplete or ambiguous',
    )
    previous = run.runId
  }
  // Exact fields and ordering; neither object insertion order nor extra JSON fields govern the signature.
  return Buffer.from(
    SIGNATURE_DOMAIN +
      JSON.stringify({
        schemaVersion: state.schemaVersion,
        repository: state.repository,
        releasePR: state.releasePR,
        version: state.version,
        sourceSha: state.sourceSha,
        tag: state.tag,
        releaseId: state.releaseId,
        appBotId: state.appBotId,
        releaseNotesSha256: state.releaseNotesSha256,
        trustedRuns: state.trustedRuns.map(({ runId, controlSourceSha }) => ({
          runId,
          controlSourceSha,
        })),
        scope: state.scope ?? 'formal',
        staging: canonicalJson(state.staging ?? null),
        contentCommitment: canonicalJson(state.contentCommitment ?? null),
        publicationProof: canonicalJson(state.publicationProof ?? null),
      }),
  )
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    requireFact(Number.isSafeInteger(value), 'Invalid signed numeric content')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalJson)
  requireFact(
    value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'Invalid signed content',
  )
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalJson(value[key])]),
  )
}

export function signReleaseState(state, pem) {
  const key = signingKey(pem)
  return {
    ...state,
    signature: sign('sha256', signaturePayload(state), {
      key,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString('base64'),
  }
}

export function verifySignedState(state, pem) {
  requireFact(
    typeof state.signature === 'string' &&
      state.signature.length <= 1024 &&
      /^[A-Za-z0-9+/=]+$/.test(state.signature),
    'Release signature is missing',
  )
  requireFact(
    verify(
      'sha256',
      signaturePayload(state),
      { key: createPublicKey(signingKey(pem)), padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(state.signature, 'base64'),
    ),
    'Persistent release signature differs; unknown state will not be re-signed',
  )
}

export function verifyReleaseState(release, expected, pem, botId) {
  const state = decodeIdentity(release.body)
  requireFact(
    (state.scope ?? 'formal') === 'formal' && state.staging === undefined,
    'Staging release cannot become a formal release',
  )
  sameIdentity(state, expected)
  requireFact(
    release.author?.id === botId && state.appBotId === botId,
    'Release is not owned by the fixed GitHub App',
  )
  requireFact(
    state.releaseId === null || state.releaseId === release.id,
    'Signed Release ID differs from GitHub',
  )
  requireFact(
    typeof state.signature === 'string' &&
      state.signature.length <= 1024 &&
      /^[A-Za-z0-9+/=]+$/.test(state.signature),
    'Release signature is missing',
  )
  requireFact(
    verify(
      'sha256',
      signaturePayload(state),
      { key: createPublicKey(signingKey(pem)), padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(state.signature, 'base64'),
    ),
    'Persistent release signature differs; unknown state will not be re-signed',
  )
  requireFact(
    createHash('sha256').update(storedReleaseNotes(release.body)).digest('hex') ===
      state.releaseNotesSha256,
    'Persistent release notes changed after authentication',
  )
  return state
}

export async function verifyPublishedRelease(api, release, identity, context) {
  const state = verifyReleaseState(release, identity, context.signingKey, context.botId)
  requireFact(
    !release.draft && !release.prerelease && release.tag_name === identity.tag,
    'Release is not published Stable content',
  )
  const commitment = state.contentCommitment,
    proof = state.publicationProof
  requireFact(
    commitment?.schemaVersion === 1 &&
      commitment.platforms?.length === 3 &&
      new Set(commitment.platforms.map((item) => item.platform)).size === 3 &&
      commitment.platforms.every(
        (item) => RELEASE_PLATFORMS.includes(item.platform) && HASH.test(item.appContentHash),
      ) &&
      Array.isArray(commitment.assets) &&
      commitment.assets.length > 0 &&
      commitment.assets.length <= MAX_ASSETS &&
      proof?.schemaVersion === 1 &&
      Array.isArray(proof.assets) &&
      proof.assets.length === commitment.assets.length,
    'Published release has no complete signed publication proof',
  )
  const assets = await api.list(api.path(`/releases/${release.id}/assets`))
  requireFact(
    assets.length === proof.assets.length &&
      new Set(assets.map((asset) => asset.name)).size === assets.length,
    'Published assets are incomplete or ambiguous',
  )
  for (const asset of assets) {
    const recorded = proof.assets.find((file) => file.id === asset.id && file.name === asset.name)
    const expected = commitment.assets.find((file) => file.name === asset.name)
    requireFact(
      recorded &&
        expected &&
        recorded.sha256 === expected.sha256 &&
        recorded.bytes === expected.bytes &&
        asset.uploader?.id === context.botId &&
        asset.state === 'uploaded' &&
        asset.size === expected.bytes,
      'Published asset identity differs from its signed proof',
    )
    // Immutable API digests are the persisted outcome of original streamed transfer verification.
    const actual =
      release.immutable === true
        ? asset.digest?.replace(/^sha256:/, '')
        : // oxlint-disable-next-line eslint/no-await-in-loop -- Mutable API state needs byte verification before label writes.
          await api.assetDigest(asset)
    requireFact(actual === expected.sha256, 'Published asset digest differs from signed proof')
  }
  return state
}

function replaceIdentity(body, state) {
  decodeIdentity(body)
  return body.replace(/PACT_RELEASE_IDENTITY:[A-Za-z0-9+/=]+/, encodeIdentity(state))
}

async function controllerCheckoutSha(environment) {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC']) {
    if (environment[name] !== undefined) env[name] = environment[name]
  }
  let stdout
  try {
    ;({ stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      env,
      shell: false,
      timeout: 5000,
      maxBuffer: 1024,
    }))
  } catch {
    throw new Error('Trusted controller checkout SHA is unresolved')
  }
  const sha = stdout.trim()
  requireFact(SHA.test(sha), 'Trusted controller checkout SHA is invalid')
  return sha
}

export async function verifyTag(api, identity, create = false) {
  let tag = await api.request(api.path(`/git/ref/tags/${identity.tag}`), { optional: true })
  if (!tag && create) {
    await api.request(api.path('/git/refs'), {
      method: 'POST',
      body: { ref: `refs/tags/${identity.tag}`, sha: identity.sourceSha },
    })
    tag = await api.request(api.path(`/git/ref/tags/${identity.tag}`))
  }
  requireFact(tag !== null, 'Release tag is missing')
  let object = tag.object
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Annotated tags form a bounded dependency chain.
    object = (await api.request(api.path(`/git/tags/${object.sha}`))).object
  }
  requireFact(
    object.type === 'commit' && object.sha === identity.sourceSha,
    'Existing tag points to another SHA',
  )
}

export async function establishDraft(api, identity, context) {
  requireFact(
    context &&
      Number.isSafeInteger(context.runId) &&
      context.runId > 0 &&
      SHA.test(context.controlSourceSha),
    'Trusted controller run identity is required',
  )
  signingKey(context.signingKey)
  // By-tag API is insufficient for draft lookup; enumerate complete release state.
  const releases = await api.list(api.path('/releases'))
  const matches = releases.filter((release) => release.tag_name === identity.tag)
  requireFact(matches.length <= 1, 'Multiple releases claim the same tag')
  let release = matches[0]
  if (release) {
    // Authenticate existing durable state before any repair write, including tag creation.
    verifyReleaseState(release, identity, context.signingKey, context.botId)
    await verifyTag(api, identity, release.draft)
  }
  if (!release) {
    const pr = await api.request(api.path(`/pulls/${identity.releasePR}`))
    requireFact(
      typeof pr.body === 'string' &&
        Buffer.byteLength(pr.body) <= 128 * 1024 &&
        !pr.body.includes(NOTES_START) &&
        !pr.body.includes(NOTES_END),
      'Release Please notes are missing or exceed their bound',
    )
    const bootstrap = signReleaseState(
      {
        ...identity,
        releaseId: null,
        appBotId: context.botId,
        releaseNotesSha256: createHash('sha256').update(pr.body.trim()).digest('hex'),
        trustedRuns: [{ runId: context.runId, controlSourceSha: context.controlSourceSha }],
      },
      context.signingKey,
    )
    await verifyTag(api, identity, true)
    release = await api.request(api.path('/releases'), {
      method: 'POST',
      body: {
        tag_name: identity.tag,
        target_commitish: identity.sourceSha,
        name: `Pact ${identity.version}`,
        body: `${encodeIdentity(bootstrap)}\n\nValidation is incomplete. This release remains a draft until every required platform passes.\n\n${NOTES_START}\n${pr.body}\n${NOTES_END}`,
        draft: true,
        prerelease: false,
        make_latest: 'false',
      },
    })
  }
  let state = verifyReleaseState(release, identity, context.signingKey, context.botId)
  requireFact(Number.isSafeInteger(release.id) && release.id > 0, 'GitHub Release ID is invalid')
  requireFact(release.prerelease === false, 'Stable release cannot be a prerelease')
  if (state.releaseId === null) {
    requireFact(
      release.draft === true &&
        (await api.list(api.path(`/releases/${release.id}/assets`))).length === 0,
      'Authenticated bootstrap release unexpectedly contains assets or is published',
    )
  }
  if (release.draft) {
    const existingRun = state.trustedRuns.find((run) => run.runId === context.runId)
    if (existingRun)
      requireFact(
        existingRun.controlSourceSha === context.controlSourceSha,
        'An existing run has another controller source',
      )
    const runs = existingRun
      ? state.trustedRuns
      : [
          ...state.trustedRuns,
          { runId: context.runId, controlSourceSha: context.controlSourceSha },
        ].toSorted((a, b) => a.runId - b.runId)
    const next = signReleaseState(
      { ...state, releaseId: release.id, trustedRuns: runs },
      context.signingKey,
    )
    if (next.signature !== state.signature) {
      release = await api.request(api.path(`/releases/${release.id}`), {
        method: 'PATCH',
        body: { body: replaceIdentity(release.body, next) },
      })
      state = verifyReleaseState(release, identity, context.signingKey, context.botId)
    }
  }
  requireFact(state.releaseId === release.id, 'Authenticated Release ID is unresolved')
  if (!release.draft) await verifyPublishedRelease(api, release, identity, context)
  return { ...state, published: !release.draft }
}

async function readJson(file) {
  const info = await stat(file)
  requireFact(
    info.isFile() && info.size <= MAX_EVIDENCE_BYTES,
    'Evidence file exceeds its byte bound',
  )
  return JSON.parse(await readFile(file, 'utf8'))
}

async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function admittedFile(root, path) {
  requireFact(
    typeof path === 'string' && path.length > 0 && !isAbsolute(path),
    'Asset path must be relative',
  )
  requireFact(path === basename(path), 'Release assets must be flat bundle files')
  requireFact(!path.includes('\\'), 'Asset paths use forward slashes')
  const file = await realpath(resolve(root, path))
  const remainder = relative(await realpath(root), file)
  requireFact(
    remainder && !remainder.startsWith('..') && !isAbsolute(remainder),
    'Asset escapes its bundle',
  )
  const info = await stat(file)
  requireFact(info.isFile() && info.size > 0 && info.size <= MAX_ASSET_BYTES, 'Invalid asset bytes')
  return { file, bytes: info.size, sha256: await hashFile(file) }
}

function reportIdentity(report, manifest, label) {
  requireFact(report.status === 'passed', `${label} did not pass`)
  for (const field of ['version', 'sourceSha', 'channel', 'platform', 'arch']) {
    requireFact(report[field] === manifest[field], `${label} has a different ${field}`)
  }
  requireFact(
    report.appContentHash === manifest.application.contentSha256,
    `${label} content hash differs`,
  )
  requireFact(HASH.test(report.appContentHash), `${label} content hash is missing`)
}

/** Validation consumes actual platform reports. Unit fakes are never release evidence. */
export async function validateBundle(root, identity, platformKey) {
  requireFact(RELEASE_PLATFORMS.includes(platformKey), 'Unsupported release platform')
  const manifest = await readJson(join(root, 'distribution-manifest.json'))
  const [platform, arch] = platformKey.split('-')
  requireFact(manifest.schemaVersion === 1, 'Unsupported distribution manifest')
  requireFact(
    manifest.smokeProtocolVersion === 2,
    'Production path identity protocol is unverified',
  )
  requireFact(
    manifest.channel === 'stable' && manifest.sourceDirty === false,
    'Release must be a clean Stable build',
  )
  requireFact(
    manifest.sourceSha === identity.sourceSha &&
      manifest.version === identity.version &&
      manifest.productVersion === identity.version,
    'Distribution provenance/version differs from release identity',
  )
  requireFact(
    manifest.platform === platform && manifest.arch === arch,
    'Distribution has the wrong OS/architecture',
  )
  requireFact(
    manifest.productName === 'Pact' && manifest.appId === 'com.pact.desktop',
    'Distribution has the wrong Stable identity',
  )
  requireFact(HASH.test(manifest.application?.contentSha256), 'Application content hash is missing')
  const kinds = platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']
  requireFact(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length === kinds.length,
    'Every required installer must be present exactly once',
  )
  const files = []
  const names = new Set()
  for (const artifact of manifest.artifacts) {
    requireFact(kinds.includes(artifact.kind), 'Unexpected installer format')
    requireFact(!names.has(artifact.kind), 'Duplicate installer format')
    names.add(artifact.kind)
    // oxlint-disable-next-line eslint/no-await-in-loop -- One installer hash stream bounds filesystem residency.
    const actual = await admittedFile(root, artifact.path)
    requireFact(
      actual.sha256 === artifact.sha256 && actual.bytes === artifact.bytes,
      'Installer hash/size differs',
    )
    files.push({ ...actual, name: basename(artifact.path) })
  }
  const smoke = await readJson(join(root, 'package-smoke-report.json'))
  reportIdentity(smoke, manifest, 'Packaged smoke')
  requireFact(
    smoke.installationVerified === true &&
      smoke.cleanupVerified === true &&
      smoke.defaultChannelPathsVerified === true &&
      smoke.productionDataRootVerified === true,
    'Installed application/cleanup/default channel paths are unverified',
  )
  requireFact(
    smoke.appId === manifest.appId && smoke.productName === manifest.productName,
    'Installed product identity differs',
  )
  const installedArtifact = manifest.artifacts.find(
    (artifact) => artifact.kind === (platform === 'darwin' ? 'dmg' : 'nsis'),
  )
  requireFact(
    Array.isArray(smoke.artifacts) &&
      smoke.artifacts.length === 1 &&
      smoke.artifacts[0].path === installedArtifact.path &&
      smoke.artifacts[0].sha256 === installedArtifact.sha256 &&
      smoke.artifacts[0].bytes === installedArtifact.bytes &&
      smoke.verificationMode === (platform === 'darwin' ? 'mounted-dmg-copy' : 'installed-nsis'),
    'Smoke does not bind the actual installer',
  )
  if (platform === 'darwin') {
    const zipSmoke = await readJson(join(root, 'package-zip-smoke-report.json'))
    reportIdentity(zipSmoke, manifest, 'ZIP smoke')
    requireFact(
      zipSmoke.installationVerified === true &&
        zipSmoke.cleanupVerified === true &&
        zipSmoke.defaultChannelPathsVerified === true &&
        zipSmoke.productionDataRootVerified === true,
      'ZIP extraction/cleanup/default channel paths are unverified',
    )
    requireFact(
      zipSmoke.appId === manifest.appId && zipSmoke.productName === manifest.productName,
      'Extracted product identity differs',
    )
    const zipArtifact = manifest.artifacts.find((artifact) => artifact.kind === 'zip')
    requireFact(
      Array.isArray(zipSmoke.artifacts) &&
        zipSmoke.artifacts.length === 1 &&
        zipSmoke.artifacts[0].path === zipArtifact.path &&
        zipSmoke.artifacts[0].sha256 === zipArtifact.sha256 &&
        zipSmoke.artifacts[0].bytes === zipArtifact.bytes &&
        zipSmoke.verificationMode === 'extracted-zip',
      'ZIP smoke does not bind its archive',
    )
  }
  const soak = await readJson(join(root, 'package-soak-report.json'))
  reportIdentity(soak, manifest, 'Packaged soak')
  requireFact(
    Number.isFinite(soak.durationMs) && soak.durationMs >= 7_200_000,
    'Packaged soak is shorter than two hours',
  )
  requireFact(
    soak.budgetPass === true &&
      soak.cleanupVerified === true &&
      soak.resourceLifecycleVerified === true,
    'Packaged performance/resource lifecycle evidence is incomplete',
  )
  requireFact(
    Array.isArray(soak.artifacts) && soak.artifacts.length === manifest.artifacts.length,
    'Soak installer identity is incomplete',
  )
  for (const artifact of manifest.artifacts) {
    requireFact(
      soak.artifacts.some(
        (entry) =>
          entry.path === artifact.path &&
          entry.sha256 === artifact.sha256 &&
          entry.bytes === artifact.bytes,
      ),
      'Soak is not bound to every final installer',
    )
  }
  const reports = [
    'distribution-manifest.json',
    'package-smoke-report.json',
    'package-soak-report.json',
  ]
  if (platform === 'darwin') reports.push('package-zip-smoke-report.json')
  for (const path of reports)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Admit one bounded evidence file before retaining its digest.
    files.push({ ...(await admittedFile(root, path)), name: `${platformKey}-${path}` })
  requireFact(new Set(files.map((file) => file.name)).size === files.length, 'Asset names collide')
  return { platformKey, appContentHash: manifest.application.contentSha256, files }
}

export async function publishRelease(api, identity, artifactsRoot, context) {
  requireFact(
    context && Number.isSafeInteger(context.runId) && context.runId > 0,
    'Trusted publication run identity is required',
  )
  await verifyTag(api, identity)
  const release = await api.request(api.path(`/releases/${identity.releaseId}`))
  let state = verifyReleaseState(release, identity, context.signingKey, context.botId)
  requireFact(state.releaseId === release.id, 'Authenticated Release ID is unresolved')
  requireFact(
    !release.draft || state.trustedRuns.some((run) => run.runId === context.runId),
    'Publication run is not authenticated by the trusted controller',
  )
  requireFact(
    release.tag_name === identity.tag && release.prerelease === false,
    'Release metadata changed',
  )
  const bundles = []
  for (const key of RELEASE_PLATFORMS)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Platform validation owns at most one installer read stream.
    bundles.push(await validateBundle(join(artifactsRoot, key), identity, key))
  const files = bundles.flatMap((bundle) => bundle.files)
  requireFact(
    new Set(files.map((file) => file.name)).size === files.length,
    'Cross-platform asset names collide',
  )
  const provenance = {
    schemaVersion: 1,
    repository: identity.repository,
    releasePR: identity.releasePR,
    version: identity.version,
    sourceSha: identity.sourceSha,
    tag: identity.tag,
    releaseId: identity.releaseId,
    appBotId: state.appBotId,
    platforms: bundles.map((bundle) => ({
      platform: bundle.platformKey,
      appContentHash: bundle.appContentHash,
    })),
    assets: files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
    selectedStages: context.selectedStages ?? [],
  }
  const provenanceFile = join(artifactsRoot, 'release-provenance.json')
  await writeFile(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`)
  const checksumsFile = join(artifactsRoot, 'SHA256SUMS')
  const provenanceInfo = await stat(provenanceFile)
  files.push({
    file: provenanceFile,
    name: 'release-provenance.json',
    sha256: await hashFile(provenanceFile),
    bytes: provenanceInfo.size,
  })
  await writeFile(
    checksumsFile,
    `${files
      .map((file) => `${file.sha256}  ${file.name}`)
      .toSorted()
      .join('\n')}\n`,
  )
  files.push({
    file: checksumsFile,
    name: 'SHA256SUMS',
    sha256: await hashFile(checksumsFile),
    bytes: (await stat(checksumsFile)).size,
  })
  requireFact(files.length <= MAX_ASSETS, 'Release exceeds its asset-count bound')
  let existing = await api.list(api.path(`/releases/${identity.releaseId}/assets`))
  requireFact(existing.length <= MAX_ASSETS, 'Remote release exceeds its asset-count bound')
  const commitment = {
    schemaVersion: 1,
    platforms: provenance.platforms,
    selectedStages: provenance.selectedStages,
    assets: files
      .map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  }
  if (!state.contentCommitment) {
    requireFact(
      release.draft && existing.length === 0,
      'Unsigned remote contents block recovery; they will not be adopted',
    )
    const next = signReleaseState({ ...state, contentCommitment: commitment }, context.signingKey)
    const frozen = await api.request(api.path(`/releases/${identity.releaseId}`), {
      method: 'PATCH',
      body: { body: replaceIdentity(release.body, next) },
    })
    state = verifyReleaseState(frozen, identity, context.signingKey, context.botId)
  }
  requireFact(
    JSON.stringify(canonicalJson(state.contentCommitment)) ===
      JSON.stringify(canonicalJson(commitment)),
    'Final contents differ from the signed content commitment',
  )
  const expected = new Map(files.map((file) => [file.name, file]))
  requireFact(
    new Set(existing.map((asset) => asset.name)).size === existing.length,
    'Remote assets have duplicate names',
  )
  for (const asset of existing) {
    requireFact(asset.uploader?.id === context.botId, 'An asset was uploaded by another identity')
    const file = expected.get(asset.name)
    requireFact(file, 'Unknown remote asset blocks release recovery')
    requireFact(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each previously uploaded stream before making any external write.
      asset.size === file.bytes && (await api.assetDigest(asset)) === file.sha256,
      'Existing asset hash differs; it cannot be overwritten',
    )
  }
  if (!release.draft) {
    requireFact(
      existing.length === files.length,
      'Published release is immutable and its evidence is incomplete',
    )
    await verifyPublishedRelease(api, release, identity, context)
    return { ...identity, status: 'already-published', assets: files.length }
  }
  for (const file of files) {
    if (!existing.some((asset) => asset.name === file.name))
      // oxlint-disable-next-line eslint/no-await-in-loop -- A single upload writer stops on uncertain delivery; no blind replay.
      await api.upload(identity.releaseId, file.file, file.name)
  }
  existing = await api.list(api.path(`/releases/${identity.releaseId}/assets`))
  requireFact(existing.length === files.length, 'Final upload set is incomplete')
  for (const asset of existing) {
    requireFact(
      asset.uploader?.id === context.botId,
      'Final upload identity differs from the fixed App',
    )
    const file = expected.get(asset.name)
    requireFact(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Publication awaits complete ordered transfer verification.
      file && asset.size === file.bytes && (await api.assetDigest(asset)) === file.sha256,
      'Final uploaded bytes are unverified',
    )
  }
  // Recheck persistent identity and tag after upload, immediately before publication.
  await verifyTag(api, identity)
  const current = await api.request(api.path(`/releases/${identity.releaseId}`))
  const currentState = verifyReleaseState(current, identity, context.signingKey, context.botId)
  requireFact(
    currentState.signature === state.signature,
    'Authenticated release state changed during publication',
  )
  requireFact(
    current.draft === true && current.tag_name === identity.tag,
    'Draft state changed during publication',
  )
  const releases = await api.list(api.path('/releases'))
  const newer = releases.some(
    (candidate) =>
      !candidate.draft &&
      !candidate.prerelease &&
      /^v\d+\.\d+\.\d+$/.test(candidate.tag_name) &&
      compareVersions(candidate.tag_name.slice(1), identity.version) > 0,
  )
  const completed = signReleaseState(
    {
      ...currentState,
      publicationProof: {
        schemaVersion: 1,
        assets: existing
          .map((asset) => ({
            id: asset.id,
            name: asset.name,
            sha256: expected.get(asset.name).sha256,
            bytes: asset.size,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      },
    },
    context.signingKey,
  )
  await api.request(api.path(`/releases/${identity.releaseId}`), {
    method: 'PATCH',
    body: {
      draft: false,
      make_latest: newer ? 'false' : 'true',
      body: `${encodeIdentity(completed)}\n\nSource: ${identity.sourceSha}\nRelease PR: #${identity.releasePR}\nAll three installed platform builds passed smoke and two-hour packaged performance/resource checks. See release-provenance.json, platform evidence and SHA256SUMS.\n\n${NOTES_START}\n${storedReleaseNotes(current.body)}\n${NOTES_END}`,
    },
  })
  return { ...identity, status: 'published', assets: files.length, latest: !newer }
}

export async function verifyArtifactRun(api, identity, runId, context) {
  requireFact(Number.isSafeInteger(runId) && runId > 0, 'Original run ID is invalid')
  const release = await api.request(api.path(`/releases/${identity.releaseId}`))
  const state = verifyReleaseState(release, identity, context.signingKey, context.botId)
  requireFact(
    state.releaseId === release.id && state.trustedRuns.some((run) => run.runId === runId),
    'Original artifact run is not authenticated by the trusted main controller',
  )
  const run = await api.request(api.path(`/actions/runs/${runId}`))
  requireFact(
    run.name === 'Stable Release' &&
      run.path === '.github/workflows/release.yml' &&
      run.repository.full_name === api.repository &&
      ['workflow_dispatch', 'pull_request_target'].includes(run.event),
    'Original artifacts have an unknown workflow source',
  )
  const jobs = await api.list(api.path(`/actions/runs/${runId}/jobs`), 'jobs')
  requireFact(
    jobs.some(
      (job) => job.name === 'quality' && job.status === 'completed' && job.conclusion === 'success',
    ),
    'Original source quality checks did not pass',
  )
  return {
    verifiedRun: runId,
    controlSourceSha: state.trustedRuns.find((entry) => entry.runId === runId).controlSourceSha,
  }
}

/** Resume exact uploaded bytes; absent/partial evidence never becomes a successful platform. */
export async function restorePlatform(api, identity, key, output, context) {
  requireFact(RELEASE_PLATFORMS.includes(key), 'Unsupported restore platform')
  await verifyTag(api, identity)
  const release = await api.request(api.path(`/releases/${identity.releaseId}`))
  const state = verifyReleaseState(release, identity, context.signingKey, context.botId)
  const assets = await api.list(api.path(`/releases/${identity.releaseId}/assets`))
  if (assets.length === 0 && !state.contentCommitment) return false
  requireFact(state.contentCommitment, 'Unsigned remote contents block recovery')
  const expected = new Map(state.contentCommitment.assets.map((asset) => [asset.name, asset]))
  requireFact(
    assets.length <= MAX_ASSETS &&
      new Set(assets.map((asset) => asset.name)).size === assets.length,
    'Remote assets are ambiguous',
  )
  for (const asset of assets) {
    const recorded = expected.get(asset.name)
    requireFact(
      recorded &&
        asset.uploader?.id === context.botId &&
        asset.size === recorded.bytes &&
        // oxlint-disable-next-line eslint/no-await-in-loop -- Authenticate every remote stream before trusting recovery metadata.
        (await api.assetDigest(asset)) === recorded.sha256,
      'Remote contents differ from signed commitment',
    )
  }
  const provenanceAsset = assets.find((asset) => asset.name === 'release-provenance.json')
  if (!provenanceAsset) {
    requireFact(
      assets.length === 0,
      'Partial upload requires the exact original workflow artifacts',
    )
    return false
  }
  requireFact(
    provenanceAsset.size > 0 && provenanceAsset.size <= MAX_JSON_BYTES,
    'Remote provenance exceeds its bound',
  )
  const response = await api.request(api.path(`/releases/assets/${provenanceAsset.id}`), {
    binary: true,
  })
  const bytes = await responseBytes(response, MAX_JSON_BYTES)
  const provenance = JSON.parse(bytes.toString('utf8'))
  sameIdentity(provenance, identity)
  requireFact(
    provenance.releaseId === identity.releaseId,
    'Remote provenance has another Release ID',
  )
  requireFact(
    Array.isArray(provenance.assets) && provenance.assets.length <= MAX_ASSETS,
    'Remote asset provenance is incomplete',
  )
  for (const asset of provenance.assets)
    requireFact(
      expected.get(asset.name)?.sha256 === asset.sha256 &&
        expected.get(asset.name)?.bytes === asset.bytes,
      'Provenance differs from signed commitment',
    )
  const platformManifest = provenance.assets.find(
    (asset) => asset.name === `${key}-distribution-manifest.json`,
  )
  requireFact(platformManifest, 'Remote provenance omits the requested platform')
  const manifestAsset = assets.find((asset) => asset.name === platformManifest.name)
  requireFact(
    manifestAsset?.size > 0 && manifestAsset.size <= MAX_EVIDENCE_BYTES,
    'Remote manifest exceeds its bound',
  )
  requireFact(
    manifestAsset && (await api.assetDigest(manifestAsset)) === platformManifest.sha256,
    'Remote manifest is unverified',
  )
  const manifestResponse = await api.request(api.path(`/releases/assets/${manifestAsset.id}`), {
    binary: true,
  })
  const manifestBytes = await responseBytes(manifestResponse, MAX_EVIDENCE_BYTES)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const wanted = [
    ...manifest.artifacts.map((artifact) => ({
      remote: basename(artifact.path),
      local: artifact.path,
    })),
    { remote: `${key}-distribution-manifest.json`, local: 'distribution-manifest.json' },
    { remote: `${key}-package-smoke-report.json`, local: 'package-smoke-report.json' },
    { remote: `${key}-package-soak-report.json`, local: 'package-soak-report.json' },
    ...(key === 'darwin-arm64'
      ? [{ remote: `${key}-package-zip-smoke-report.json`, local: 'package-zip-smoke-report.json' }]
      : []),
  ]
  await mkdir(dirname(output), { recursive: true })
  // A fresh owned root prevents prior symlinks or partial writes from escaping admission.
  await mkdir(output)
  for (const entry of wanted) {
    requireFact(
      typeof entry.local === 'string' &&
        !entry.local.includes('\\') &&
        entry.local === basename(entry.local) &&
        !isAbsolute(entry.local) &&
        !relative(output, resolve(output, entry.local)).startsWith('..'),
      'Restored path escapes its root',
    )
    const recorded = provenance.assets.find((asset) => asset.name === entry.remote)
    const asset = assets.find((candidate) => candidate.name === entry.remote)
    requireFact(
      recorded &&
        asset &&
        asset.state === 'uploaded' &&
        asset.size === recorded.bytes &&
        Number.isSafeInteger(recorded.bytes) &&
        recorded.bytes > 0 &&
        recorded.bytes <= MAX_ASSET_BYTES &&
        HASH.test(recorded.sha256),
      'Partial release upload requires original workflow artifacts',
    )
    const file = resolve(output, entry.local)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each admitted file owns its directory and one transfer lifecycle.
    await mkdir(dirname(file), { recursive: true })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Recovery retains one authenticated transfer stream at a time.
    const download = await api.request(api.path(`/releases/assets/${asset.id}`), { binary: true })
    let transferred = 0
    const bound = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length
        if (transferred > recorded.bytes)
          callback(new Error('Restored asset exceeds its recorded bytes'))
        else callback(null, chunk)
      },
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Finalize one transfer before validating and admitting the next.
    await pipeline(Readable.fromWeb(download.body), bound, createWriteStream(file, { flags: 'wx' }))
    requireFact(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Transfer verification settles the current file before moving on.
      (await stat(file)).size === recorded.bytes && (await hashFile(file)) === recorded.sha256,
      'Restored bytes differ from provenance',
    )
  }
  await validateBundle(output, identity, key)
  return true
}

function argumentsMap(args) {
  const map = new Map()
  for (let i = 0; i < args.length; i += 2) {
    requireFact(
      args[i]?.startsWith('--') && args[i + 1] && !map.has(args[i]),
      'Invalid release command arguments',
    )
    map.set(args[i], args[i + 1])
  }
  return map
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = args
  const options = argumentsMap(rest)
  const api = new GitHub(environment.GITHUB_REPOSITORY, environment.GH_TOKEN, {
    actionsToken: environment.GITHUB_TOKEN,
  })
  if (command === 'prepare') {
    requireFact(
      environment.PACT_GOVERNANCE_READY === 'true',
      'Exact repository governance has not been verified',
    )
    const identity = await resolveReleaseIdentity(api, Number(options.get('--pr')), {
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      appSlug: environment.PACT_RELEASE_APP_SLUG,
      approvedMajor: environment.PACT_APPROVED_MAJOR_VERSION,
    })
    if (!identity) {
      requireFact(
        environment.GITHUB_EVENT_NAME !== 'workflow_dispatch',
        'Recovery requires an actual Release PR',
      )
      if (environment.GITHUB_OUTPUT)
        await appendFile(environment.GITHUB_OUTPUT, 'applicable=false\n')
      return { applicable: false }
    }
    const established = await establishDraft(api, identity, {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      runId: Number(environment.GITHUB_RUN_ID),
      controlSourceSha: await controllerCheckoutSha(environment),
    })
    const { findStagedPlatforms } = await import('./release-staging.mjs')
    const staged = await findStagedPlatforms(api, established, {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
    })
    await writeFile(options.get('--identity'), `${JSON.stringify(established, null, 2)}\n`)
    if (environment.GITHUB_OUTPUT) {
      await appendFile(
        environment.GITHUB_OUTPUT,
        `applicable=true\nversion=${established.version}\nsource_sha=${established.sourceSha}\nrelease_id=${established.releaseId}\nrelease_pr=${established.releasePR}\ncontrol_source_sha=${established.trustedRuns.find((run) => run.runId === Number(environment.GITHUB_RUN_ID))?.controlSourceSha}\npublished=${established.published}\n${RELEASE_PLATFORMS.map((key) => `ready_${key.replaceAll('-', '_')}=${staged.some((item) => item.state.staging.platform === key)}`).join('\n')}\n`,
      )
    }
    return established
  }
  const identity = await readJson(options.get('--identity'))
  requireFact(
    Number.isSafeInteger(identity.releaseId) &&
      identity.releaseId > 0 &&
      Number.isSafeInteger(identity.releasePR) &&
      identity.releasePR > 0 &&
      identity.tag === `v${identity.version}`,
    'Invalid persisted Release ID/PR/tag',
  )
  requireFact(
    identity.repository === api.repository && SHA.test(identity.sourceSha),
    'Invalid persisted workflow identity',
  )
  if (environment.GITHUB_ACTIONS === 'true') {
    requireFact(
      environment.PACT_EXPECTED_VERSION === identity.version &&
        environment.PACT_EXPECTED_SOURCE_SHA === identity.sourceSha &&
        Number(environment.PACT_EXPECTED_RELEASE_ID) === identity.releaseId,
      'Workflow artifact differs from the trusted preparation job outputs',
    )
  }
  releaseVersion(identity.version, environment.PACT_APPROVED_MAJOR_VERSION)
  if (command === 'publish' || command === 'stage') {
    requireFact(
      environment.PACT_GOVERNANCE_READY === 'true',
      'Exact repository governance has not been verified',
    )
    // Re-read merged PR and version facts, not just a mutable workflow artifact.
    const current = await resolveReleaseIdentity(api, identity.releasePR, {
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      appSlug: environment.PACT_RELEASE_APP_SLUG,
      approvedMajor: environment.PACT_APPROVED_MAJOR_VERSION,
    })
    requireFact(current, 'Release PR identity is missing')
    sameIdentity(current, identity)
    const context = {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      runId: Number(environment.GITHUB_RUN_ID),
      attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    }
    if (command === 'stage') {
      const { stagePlatform } = await import('./release-staging.mjs')
      return stagePlatform(
        api,
        identity,
        options.get('--platform'),
        options.get('--artifacts'),
        context,
      )
    }
    const { materializeStagedPlatforms } = await import('./release-staging.mjs')
    const selectedStages = await materializeStagedPlatforms(
      api,
      identity,
      options.get('--artifacts'),
      context,
    )
    return publishRelease(api, identity, options.get('--artifacts'), {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      runId: Number(environment.GITHUB_RUN_ID),
      selectedStages,
    })
  }
  if (command === 'verify-artifact-run') {
    return verifyArtifactRun(api, identity, Number(options.get('--run')), {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
    })
  }
  if (command === 'restore-platform') {
    const restored = await restorePlatform(
      api,
      identity,
      options.get('--platform'),
      options.get('--output'),
      {
        signingKey: environment.PACT_RELEASE_SIGNING_KEY,
        botId: Number(environment.PACT_RELEASE_APP_BOT_ID),
      },
    )
    if (environment.GITHUB_OUTPUT)
      await appendFile(environment.GITHUB_OUTPUT, `restored=${restored}\n`)
    return { restored }
  }
  throw new Error('Unsupported release command')
}

if (isScriptEntry(import.meta.url)) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`Release blocked: ${error.message}`)
      process.exitCode = 1
    })
}
