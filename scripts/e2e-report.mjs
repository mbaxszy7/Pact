import { constants } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { isScriptEntry } from './script-entry.mjs'

export const e2eReportLimits = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  retainedRuns: 4096,
})

export const reportRepository = 'mbaxszy7/Pact'
const ciEvents = new Set([
  'push',
  'pull_request',
  'workflow_dispatch',
  'workflow_call',
  'merge_group',
])

/** Informational source/run projection; native GitHub jobs own their actual result gates. */
export function publicReportIdentity(identity) {
  if (identity === null) return null
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    identity.schemaVersion !== 1 ||
    identity.repository !== reportRepository ||
    !['ci', 'local'].includes(identity.kind) ||
    !(typeof identity.sourceSha === 'string' && /^[a-f\d]{40}$/u.test(identity.sourceSha))
  )
    throw new Error('Invalid report source identity')
  const result = {
    schemaVersion: 1,
    kind: identity.kind,
    repository: reportRepository,
    sourceSha: identity.sourceSha,
  }
  if (identity.kind === 'local') return result
  if (
    !Number.isSafeInteger(identity.runId) ||
    identity.runId < 1 ||
    !Number.isSafeInteger(identity.runAttempt) ||
    identity.runAttempt < 1 ||
    !ciEvents.has(identity.eventName) ||
    typeof identity.ref !== 'string' ||
    Buffer.byteLength(identity.ref) > 1024 ||
    !/^refs\/(?:heads|tags|pull|merge-queue)\/[^\s\p{Cc}]+$/u.test(identity.ref)
  )
    throw new Error('Invalid report CI run identity')
  return Object.assign(result, {
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    eventName: identity.eventName,
    ref: identity.ref,
  })
}

export function ciReportIdentity(source = process.env) {
  if (
    source.GITHUB_ACTIONS !== 'true' ||
    !/^[1-9]\d{0,15}$/u.test(source.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d{0,15}$/u.test(source.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw new Error('Native CI run metadata is required')
  return publicReportIdentity({
    schemaVersion: 1,
    kind: 'ci',
    repository: source.GITHUB_REPOSITORY,
    sourceSha: source.GITHUB_SHA,
    runId: Number(source.GITHUB_RUN_ID),
    runAttempt: Number(source.GITHUB_RUN_ATTEMPT),
    eventName: source.GITHUB_EVENT_NAME,
    ref: source.GITHUB_REF,
  })
}

export async function readCiReportIdentity(path) {
  const identity = publicReportIdentity(await readE2EJson(path, 4096))
  if (identity?.kind !== 'ci') throw new Error('CI run metadata is required')
  return identity
}

export function reportIdentityMarkdown(identity) {
  if (!identity) return 'Source identity is unavailable; no CI execution is attested.'
  const validated = publicReportIdentity(identity)
  return validated.kind === 'ci'
    ? `Source: \`${validated.sourceSha}\`; Actions run: ${validated.runId}, attempt ${validated.runAttempt}; event: ${validated.eventName}.`
    : `Local source: \`${validated.sourceSha}\`; this is not a CI run.`
}

/** One bounded no-overwrite native metadata file, never a trust controller or credential reader. */
export async function writeCiReportMetadata(path, source = process.env) {
  if (!isAbsolute(path) || /[\r\n\0]/u.test(path) || Buffer.byteLength(path) > 4096)
    throw new Error('Explicit bounded CI metadata path is required')
  const identity = ciReportIdentity(source)
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return identity
}

export async function readE2EJson(path, limit = e2eReportLimits.inputBytes) {
  if (
    !isAbsolute(path) ||
    /[\r\n\0]/u.test(path) ||
    Buffer.byteLength(path) > 4096 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > e2eReportLimits.inputBytes
  )
    throw new Error('Invalid bounded E2E evidence path or byte limit')
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1 || initial.size > limit)
    throw new Error('Invalid bounded E2E evidence file')
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.dev !== initial.dev ||
      info.ino !== initial.ino ||
      info.size !== initial.size
    )
      throw new Error('E2E evidence identity changed')
    const buffer = Buffer.alloc(info.size + 1)
    let size = 0
    while (size < buffer.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Complete one bounded descriptor to EOF, never accept a partial or growing report.
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const final = await file.stat(),
      current = await lstat(path)
    if (
      size !== info.size ||
      current.isSymbolicLink() ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs ||
      current.ctimeMs !== info.ctimeMs ||
      final.size !== info.size ||
      final.mtimeMs !== info.mtimeMs ||
      final.ctimeMs !== info.ctimeMs
    )
      throw new Error('E2E evidence changed or is incomplete')
    return JSON.parse(buffer.subarray(0, size).toString('utf8'))
  } finally {
    await file.close()
  }
}

async function localReportDirectory(workspace) {
  if (!isAbsolute(workspace) || /[\r\n\0]/u.test(workspace) || Buffer.byteLength(workspace) > 4096)
    throw new Error('E2E reports need an explicit bounded workspace')
  const canonical = await realpath(workspace)
  for (const path of [
    join(canonical, '.pact-data'),
    join(canonical, '.pact-data', 'e2e-reports'),
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Establish owned private parents in order and reject redirected paths.
    await mkdir(path, { recursive: true, mode: 0o700 })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Parent identity must be verified before admitting its child.
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('E2E report root cannot be redirected')
  }
  const root = join(canonical, '.pact-data', 'e2e-reports')
  const entries = await opendir(root)
  let count = 0
  for await (const entry of entries) {
    if (entry.name.length && ++count >= e2eReportLimits.retainedRuns)
      throw new Error('E2E report retention is full; preserve evidence and archive it explicitly')
  }
  const prefix = new Date().toISOString().replaceAll(/[-:.]/gu, '')
  return mkdtemp(join(root, `${prefix}-`))
}

/** One report owner writes safe projections, never raw Playwright/config/attachments. */
export async function writeE2EReport(
  report,
  { directory, basename, markdown, summary, workspace, artifactName },
) {
  if (
    !isAbsolute(directory) ||
    !/^(?:real|ui|deterministic|native)-summary$/u.test(basename) ||
    (artifactName !== undefined && !/^[a-z\d-]{1,100}$/u.test(artifactName))
  )
    throw new Error('Invalid E2E report destination')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('E2E report destination cannot be redirected')
  // Check before reserving another local run: an existing artifact is recovery evidence.
  for (const extension of ['json', 'md']) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Both fixed files must be absent before allocating a persistent run directory.
      await lstat(join(directory, `${basename}.${extension}`))
      const error = new Error('EEXIST: Existing E2E report cannot be overwritten')
      error.code = 'EEXIST'
      throw error
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const local = workspace ? await localReportDirectory(workspace) : null
  const output = {
    ...report,
    reportFiles: {
      json: `${basename}.json`,
      markdown: `${basename}.md`,
      localDirectory: local ? `.pact-data/e2e-reports/${local.split(/[\\/]/u).at(-1)}` : null,
      artifactName: artifactName ?? null,
      artifactRetentionDays: artifactName ? 14 : null,
    },
  }
  const json = `${JSON.stringify(output, null, 2)}\n`,
    text = markdown(output)
  if ([json, text].some((value) => Buffer.byteLength(value) > e2eReportLimits.outputBytes))
    throw new Error('E2E report exceeds its output bound')
  // A failed later write retains completed safe files for recovery; no previous run is removed.
  for (const target of [...(local ? [local] : []), directory]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Publish fixed no-overwrite files in the reserved directory in order.
    await writeFile(join(target, `${basename}.json`), json, { flag: 'wx', mode: 0o600 })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Markdown belongs to the same immutable report, not a replaceable latest pointer.
    await writeFile(join(target, `${basename}.md`), text, { flag: 'wx', mode: 0o600 })
  }
  if (summary) await appendFile(summary, text)
  return { report: output, directory: local ?? directory }
}

if (isScriptEntry(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.length !== 2 || argv[0] !== '--ci-metadata') {
    console.error('Expected --ci-metadata and an absolute output file.')
    process.exitCode = 1
  } else {
    writeCiReportMetadata(argv[1]).catch(() => {
      console.error('Native CI metadata could not be safely written.')
      process.exitCode = 1
    })
  }
}
