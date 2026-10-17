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

import { requireIdentity } from './ci-identity.mjs'

export const e2eReportLimits = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  retainedRuns: 4096,
})

/** Never publish optional identity extensions or an unvalidated branch author. */
export function publicReportIdentity(identity, kind = 'ci') {
  if (!['ci', 'release'].includes(kind)) throw new Error('Invalid report identity kind')
  if (identity === null) return null
  if (kind === 'release') {
    if (
      !identity ||
      identity.schemaVersion !== 1 ||
      identity.repository !== 'mbaxszy7/Pact' ||
      !Number.isSafeInteger(identity.releasePR) ||
      identity.releasePR < 1 ||
      !Number.isSafeInteger(identity.releaseId) ||
      identity.releaseId < 1 ||
      typeof identity.version !== 'string' ||
      identity.version.length > 128 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(identity.version) ||
      identity.version === '0.0.0' ||
      !/^[a-f\d]{40}$/u.test(identity.sourceSha ?? '') ||
      identity.tag !== `v${identity.version}`
    )
      throw new Error('Invalid release report identity')
    // This is an informational projection. The release controller still authenticates
    // the original signed identity before staging or publishing any application bytes.
    return Object.fromEntries(
      ['schemaVersion', 'repository', 'releasePR', 'version', 'sourceSha', 'tag', 'releaseId'].map(
        (name) => [name, identity[name]],
      ),
    )
  }
  requireIdentity(identity)
  const result = Object.fromEntries(
    [
      'schemaVersion',
      'repository',
      'repositoryId',
      'pullRequest',
      'headRepositoryId',
      'headSha',
      'baseSha',
      'candidateSha',
      'treeSha',
      'policySha',
      'authorId',
      'channel',
      'sourceKind',
      'controllerSha',
      'controllerRef',
    ]
      .filter(
        (name) =>
          Object.hasOwn(identity, name) && (name !== 'authorId' || identity.pullRequest !== null),
      )
      .map((name) => [name, identity[name]]),
  )
  result.product =
    identity.product === null
      ? null
      : {
          before:
            identity.product.before === null
              ? null
              : {
                  version: identity.product.before.version,
                  candidateVersion: identity.product.before.candidateVersion,
                },
          after: {
            version: identity.product.after.version,
            candidateVersion: identity.product.after.candidateVersion,
          },
        }
  return result
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
