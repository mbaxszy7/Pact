import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import {
  decodeIdentity,
  encodeIdentity,
  RELEASE_PLATFORMS,
  signReleaseState,
  validateBundle,
  verifyArtifactRun,
  verifyReleaseState,
  verifySignedState,
} from './release-control.mjs'

const NOTES = 'Authenticated Pact platform staging. Never publish this draft.'
const noteDigest = createHash('sha256').update(NOTES).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const execFileAsync = promisify(execFile)
const fail = (condition, message) => {
  if (!condition) throw new Error(message)
}
const stageTag = (identity, staging) =>
  `pact-stage-${identity.tag}-r${identity.releaseId}-${staging.platform}-run${staging.runId}-a${staging.attempt}`
const body = (state) =>
  `${encodeIdentity(state)}\n<!-- PACT_RELEASE_NOTES_START -->\n${NOTES}\n<!-- PACT_RELEASE_NOTES_END -->`

/** An App uploader alone cannot authenticate contents. Only the protected controller signs this ledger. */
export function verifyStagingRelease(release, identity, context) {
  const state = decodeIdentity(release.body)
  verifySignedState(state, context.signingKey)
  for (const name of ['repository', 'releasePR', 'version', 'sourceSha', 'tag', 'releaseId'])
    fail(state[name] === identity[name], 'Staging identity differs from formal release')
  const stage = state.staging
  fail(
    state.scope === 'platform-staging' && stage && RELEASE_PLATFORMS.includes(stage.platform),
    'Unknown staging scope/platform',
  )
  fail(
    state.appBotId === context.botId &&
      release.author?.id === context.botId &&
      release.draft === true &&
      release.prerelease === false,
    'Staging draft identity/state changed',
  )
  fail(
    stage.stageReleaseId === null || stage.stageReleaseId === release.id,
    'Staging Release ID differs',
  )
  fail(
    release.tag_name === stageTag(identity, stage) &&
      state.releaseNotesSha256 === noteDigest &&
      release.body === body(state),
    'Staging metadata changed',
  )
  fail(
    Number.isSafeInteger(stage.runId) &&
      stage.runId > 0 &&
      Number.isSafeInteger(stage.attempt) &&
      stage.attempt > 0 &&
      Number.isSafeInteger(stage.artifactId) &&
      stage.artifactId > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(stage.artifactDigest),
    'Staging run/artifact identity is incomplete',
  )
  fail(
    hashPattern.test(stage.appContentHash) &&
      typeof stage.complete === 'boolean' &&
      Array.isArray(stage.files) &&
      stage.files.length >= 4 &&
      stage.files.length <= 8,
    'Staging content commitment is incomplete',
  )
  const names = new Set(),
    locals = new Set()
  for (const file of stage.files) {
    fail(
      typeof file.name === 'string' &&
        file.name === basename(file.name) &&
        !/[\\\r\n\0]/.test(file.name) &&
        !names.has(file.name) &&
        typeof file.local === 'string' &&
        file.local === basename(file.local) &&
        !/[\\\r\n\0]/.test(file.local) &&
        !locals.has(file.local) &&
        hashPattern.test(file.sha256) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= 2 * 1024 * 1024 * 1024,
      'Invalid staged asset',
    )
    names.add(file.name)
    locals.add(file.local)
  }
  return state
}

async function verifiedAssets(api, release, state, context) {
  const assets = await api.list(api.path(`/releases/${release.id}/assets`))
  fail(
    assets.length <= 8 && new Set(assets.map((asset) => asset.name)).size === assets.length,
    'Staging assets are ambiguous',
  )
  for (const asset of assets) {
    const expected = state.staging.files.find((file) => file.name === asset.name)
    fail(
      expected &&
        asset.uploader?.id === context.botId &&
        asset.state === 'uploaded' &&
        asset.size === expected.bytes &&
        // oxlint-disable-next-line eslint/no-await-in-loop -- Authenticate every existing asset before any recovery mutation.
        (await api.assetDigest(asset)) === expected.sha256,
      'Unknown or mismatched staging bytes block recovery',
    )
  }
  if (state.staging.complete)
    fail(assets.length === state.staging.files.length, 'Completed staging bytes have disappeared')
  return assets
}

/** Download the exact artifact ID, hard-verify its archive digest, then compare every admitted file. */
export async function verifyArtifactArchive(api, artifact, bundle) {
  const root = await mkdtemp(join(tmpdir(), 'pact-stage-archive-'))
  try {
    const response = await api.request(api.path(`/actions/artifacts/${artifact.id}/zip`), {
      binary: true,
    })
    let bytes = 0
    const hash = createHash('sha256')
    const guard = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        callback(
          bytes > 6 * 1024 * 1024 * 1024 ? new Error('Artifact archive exceeds 6 GiB') : null,
          chunk,
        )
      },
    })
    const archive = join(root, 'artifact.zip')
    await pipeline(
      Readable.fromWeb(response.body),
      guard,
      createWriteStream(archive, { flags: 'wx' }),
    )
    fail(
      bytes > 0 && `sha256:${hash.digest('hex')}` === artifact.digest,
      'Artifact archive digest mismatch',
    )
    const script = `import hashlib,json,stat,sys,zipfile
items=[];names=set();total=0
with zipfile.ZipFile(sys.argv[1]) as archive:
 entries=archive.infolist()
 if not 1<=len(entries)<=8: raise RuntimeError('Invalid archive inventory')
 for entry in entries:
  name=entry.filename;mode=stat.S_IFMT(entry.external_attr>>16)
  if not name or len(name.encode())>4096 or '/' in name or '\\\\' in name or any(ord(c)<32 for c in name) or name in ('.','..') or name.casefold() in names or entry.is_dir() or mode not in (0,stat.S_IFREG) or not 0<entry.file_size<=2147483648: raise RuntimeError('Unsafe archive entry')
  names.add(name.casefold());total+=entry.file_size
  if total>5368709120: raise RuntimeError('Archive working set exceeds 5 GiB')
  digest=hashlib.sha256();size=0
  with archive.open(entry) as file:
   while True:
    chunk=file.read(65536)
    if not chunk: break
    size+=len(chunk);digest.update(chunk)
    if size>entry.file_size: raise RuntimeError('Archive entry exceeds its bound')
  if size!=entry.file_size: raise RuntimeError('Incomplete archive entry')
  items.append({'name':name,'bytes':size,'sha256':digest.hexdigest()})
print(json.dumps(items))`
    const { stdout } = await execFileAsync('python3', ['-c', script, archive], {
      env: { PATH: process.env.PATH },
      shell: false,
      timeout: 20 * 60_000,
      maxBuffer: 16 * 1024,
    })
    const entries = JSON.parse(stdout)
    // Build-distribution's installer checksums are auxiliary; final SHA256SUMS is regenerated and signed.
    const expected = bundle.files.map((file) => ({
      name: basename(file.file),
      sha256: file.sha256,
      bytes: file.bytes,
    }))
    const checksum = entries.find((entry) => entry.name === 'SHA256SUMS')
    if (checksum) {
      const checksumPath = join(dirname(bundle.files[0].file), 'SHA256SUMS')
      fail((await stat(checksumPath)).size <= 16 * 1024, 'Installer checksums exceed their bound')
      const text = await readFile(checksumPath)
      fail(text.length <= 16 * 1024, 'Installer checksums exceed their bound')
      expected.push({
        name: 'SHA256SUMS',
        bytes: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
      })
    }
    fail(entries.length === expected.length, 'Archive has unexpected content')
    for (const file of expected)
      fail(
        entries.some(
          (entry) =>
            entry.name === file.name && entry.bytes === file.bytes && entry.sha256 === file.sha256,
        ),
        'Downloaded bundle does not match the exact authenticated artifact',
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function findStagedPlatforms(api, identity, context) {
  const formal = await api.request(api.path(`/releases/${identity.releaseId}`))
  const formalState = verifyReleaseState(formal, identity, context.signingKey, context.botId)
  const releases = (await api.list(api.path('/releases'))).filter((release) =>
    release.tag_name.startsWith(`pact-stage-${identity.tag}-r${identity.releaseId}-`),
  )
  fail(
    releases.length <= 128,
    'Staging attempt ledger exceeds 128 entries; preserve records and stop',
  )
  const complete = []
  for (const release of releases) {
    let state = verifyStagingRelease(release, identity, context)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Unknown/incomplete remote assets must be checked even when another attempt succeeds.
    const assets = await verifiedAssets(api, release, state, context)
    if (
      !state.staging.complete &&
      state.staging.stageReleaseId === release.id &&
      assets.length === state.staging.files.length &&
      formal.draft &&
      !formalState.contentCommitment
    ) {
      const completed = signReleaseState(
        { ...state, staging: { ...state.staging, complete: true } },
        context.signingKey,
      )
      // oxlint-disable-next-line eslint/no-await-in-loop -- A fully transferred signed intent can settle without expired Actions artifacts.
      const repaired = await api.request(api.path(`/releases/${release.id}`), {
        method: 'PATCH',
        body: { body: body(completed) },
      })
      state = verifyStagingRelease(repaired, identity, context)
    }
    if (state.staging.complete) complete.push({ release, state })
  }
  const selected = []
  for (const key of RELEASE_PLATFORMS) {
    const frozen = formalState.contentCommitment?.selectedStages?.find(
      (stage) => stage.platform === key,
    )
    const available = complete
      .filter((item) => item.state.staging.platform === key)
      .toSorted((a, b) => a.release.id - b.release.id)
    const choice = frozen
      ? available.find(
          (item) =>
            item.release.id === frozen.stageReleaseId && item.state.signature === frozen.signature,
        )
      : available[0]
    if (formalState.contentCommitment)
      fail(
        choice,
        'Frozen release original staged bytes are unavailable; rebuilding cannot replace them',
      )
    if (choice) selected.push(choice)
  }
  return selected
}

/** Commit and read back expected digests BEFORE uploading large assets. Partial attempts remain durable. */
export async function stagePlatform(api, identity, platform, root, context) {
  await verifyArtifactRun(api, identity, context.runId, context)
  const run = await api.request(api.path(`/actions/runs/${context.runId}`))
  fail(Number(run.run_attempt) === context.attempt, 'Workflow attempt changed')
  const jobs = await api.list(
    api.path(`/actions/runs/${context.runId}/attempts/${context.attempt}/jobs`),
    'jobs',
  )
  fail(
    jobs.some(
      (job) =>
        job.name === `build-${platform}` &&
        job.status === 'completed' &&
        job.conclusion === 'success',
    ),
    'Platform build did not succeed in this attempt',
  )
  const artifacts = await api.list(
    api.path(`/actions/runs/${context.runId}/artifacts`),
    'artifacts',
  )
  const candidates = artifacts.filter(
    (artifact) => artifact.name === `stable-${platform}-a${context.attempt}` && !artifact.expired,
  )
  fail(
    candidates.length === 1 && /^sha256:[a-f0-9]{64}$/.test(candidates[0].digest),
    'Platform artifact identity is unresolved',
  )
  const formal = await api.request(api.path(`/releases/${identity.releaseId}`))
  const formalState = verifyReleaseState(formal, identity, context.signingKey, context.botId)
  fail(
    formal.draft && !formalState.contentCommitment,
    'Frozen/published release cannot accept new platform contents',
  )
  const bundle = await validateBundle(root, identity, platform)
  await verifyArtifactArchive(api, candidates[0], bundle)
  // Authenticate every prior attempt and its contents before admitting a new attempt.
  await findStagedPlatforms(api, identity, context)
  const stage = {
    stageReleaseId: null,
    platform,
    runId: context.runId,
    attempt: context.attempt,
    artifactId: candidates[0].id,
    artifactDigest: candidates[0].digest,
    appContentHash: bundle.appContentHash,
    complete: false,
    files: bundle.files
      .map((file) => ({
        name: file.name,
        local: basename(file.file),
        sha256: file.sha256,
        bytes: file.bytes,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  }
  const tag = stageTag(identity, stage)
  const existing = (await api.list(api.path('/releases'))).filter(
    (release) => release.tag_name === tag,
  )
  fail(existing.length <= 1, 'Staging tag is ambiguous')
  let release = existing[0]
  if (!release) {
    const initial = signReleaseState(
      {
        ...identity,
        appBotId: context.botId,
        releaseNotesSha256: noteDigest,
        trustedRuns: formalState.trustedRuns,
        scope: 'platform-staging',
        staging: stage,
      },
      context.signingKey,
    )
    release = await api.request(api.path('/releases'), {
      method: 'POST',
      body: {
        tag_name: tag,
        target_commitish: identity.sourceSha,
        name: `Pact staging ${identity.version} ${platform}`,
        body: body(initial),
        draft: true,
        prerelease: false,
        make_latest: 'false',
      },
    })
  }
  let state = verifyStagingRelease(release, identity, context)
  fail(
    JSON.stringify({ ...state.staging, stageReleaseId: null, complete: false }) ===
      JSON.stringify(stage),
    'Staging attempt has different contents; do not adopt or replace it',
  )
  let assets = await verifiedAssets(api, release, state, context)
  if (state.staging.stageReleaseId === null) {
    fail(assets.length === 0, 'Unbound staging contains unexpected assets')
    const bound = signReleaseState(
      { ...state, staging: { ...state.staging, stageReleaseId: release.id } },
      context.signingKey,
    )
    release = await api.request(api.path(`/releases/${release.id}`), {
      method: 'PATCH',
      body: { body: body(bound) },
    })
    state = verifyStagingRelease(release, identity, context)
  }
  for (const file of bundle.files)
    if (!assets.some((asset) => asset.name === file.name))
      await api.upload(release.id, file.file, file.name)
  assets = await verifiedAssets(api, release, state, context)
  fail(assets.length === state.staging.files.length, 'Staging upload is incomplete')
  if (!state.staging.complete) {
    const completed = signReleaseState(
      { ...state, staging: { ...state.staging, complete: true } },
      context.signingKey,
    )
    release = await api.request(api.path(`/releases/${release.id}`), {
      method: 'PATCH',
      body: { body: body(completed) },
    })
    state = verifyStagingRelease(release, identity, context)
  }
  return { platform, stageReleaseId: release.id, signature: state.signature }
}

/** Actions retention is irrelevant here: selected original bytes are downloaded from authenticated drafts. */
export async function materializeStagedPlatforms(api, identity, output, context) {
  const selected = await findStagedPlatforms(api, identity, context)
  fail(
    selected.length === RELEASE_PLATFORMS.length,
    'Every platform needs a complete persistent staging attempt',
  )
  await mkdir(output)
  for (const { release, state } of selected) {
    const root = join(output, state.staging.platform)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each platform owns one fresh bounded download root.
    await mkdir(root)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Only authenticated stage asset IDs can supply bytes.
    const assets = await verifiedAssets(api, release, state, context)
    for (const file of state.staging.files) {
      const asset = assets.find((item) => item.name === file.name)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One transfer at a time prevents unbounded buffers and stops uncertain writes.
      const response = await api.request(api.path(`/releases/assets/${asset.id}`), { binary: true })
      let bytes = 0
      const hash = createHash('sha256')
      const guard = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length
          hash.update(chunk)
          callback(
            bytes > file.bytes ? new Error('Staging transfer exceeded signed bytes') : null,
            chunk,
          )
        },
      })
      // oxlint-disable-next-line eslint/no-await-in-loop -- Settle the exact original file before admitting the next.
      await pipeline(
        Readable.fromWeb(response.body),
        guard,
        createWriteStream(join(root, file.local), { flags: 'wx' }),
      )
      fail(
        bytes === file.bytes && hash.digest('hex') === file.sha256,
        'Downloaded staged bytes differ',
      )
      // oxlint-disable-next-line eslint/no-await-in-loop -- Check the settled local file before continuing the ordered transfer.
      const info = await stat(join(root, file.local))
      fail(info.size === file.bytes, 'Staging file is incomplete')
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Actual content-bound smoke/soak evidence remains necessary on recovery.
    await validateBundle(root, identity, state.staging.platform)
  }
  return selected.map(({ release, state }) => ({
    platform: state.staging.platform,
    stageReleaseId: release.id,
    signature: state.signature,
  }))
}
