import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import { isScriptEntry } from './script-entry.mjs'

export const diagnosticLimits = Object.freeze({
  cases: 128,
  entriesPerCase: 8,
  files: 128,
  contextBytes: 256 * 1024,
  traceBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
})

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function contains(parent, child) {
  const local = relative(parent, child)
  return !local || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))
}

async function unchangedDirectory(path, expected) {
  const actual = await lstat(path)
  if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(actual, expected))
    throw new Error('UI diagnostic directory identity changed')
}

async function copyDiagnostic(source, target, limit) {
  const identity = await lstat(source)
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size > limit)
    throw new Error('UI diagnostic is not a bounded regular file')
  const input = await open(
    source,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  let output
  try {
    const initial = await input.stat()
    if (!initial.isFile() || !sameIdentity(initial, identity) || initial.size !== identity.size)
      throw new Error('UI diagnostic file identity changed before reading')
    output = await open(target, 'wx', 0o600)
    const buffer = Buffer.alloc(64 * 1024)
    const digest = createHash('sha256')
    let bytes = 0
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Copy the same bounded descriptor in order, including its EOF proof.
      const read = await input.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > limit) throw new Error('UI diagnostic grew beyond its byte bound')
      digest.update(buffer.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        // oxlint-disable-next-line no-await-in-loop -- Complete partial writes without recopying the source file or retrying an uncertain publication.
        const result = await output.write(buffer, written, read.bytesRead - written)
        if (!result.bytesWritten) throw new Error('UI diagnostic copy made no progress')
        written += result.bytesWritten
      }
    }
    const final = await input.stat()
    const current = await lstat(source)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, initial) ||
      !sameIdentity(final, initial) ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs ||
      bytes !== initial.size
    )
      throw new Error('UI diagnostic changed during copying')
    return { bytes, sha256: digest.digest('hex') }
  } finally {
    try {
      await input.close()
    } finally {
      await output?.close()
    }
  }
}

/** Collect only two named Playwright files from a no-credential executor. */
export async function collectUiDiagnostics(source, output) {
  if (
    !isAbsolute(source) ||
    !isAbsolute(output) ||
    basename(source) !== 'test-results' ||
    [source, output].some((path) => Buffer.byteLength(path) > 4096 || /[\r\n\0]/u.test(path)) ||
    contains(source, output) ||
    contains(output, source)
  )
    throw new Error('UI diagnostics need separate explicit source and output directories')
  // This directory is exclusively task-created. Existing evidence is never replaced.
  await mkdir(output, { mode: 0o700 })
  const records = []
  let totalBytes = 0
  let cases = 0
  let input
  try {
    let root
    try {
      root = await lstat(source)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(join(output, 'inventory.json'), '{"files":[],"sourcePresent":false}\n', {
        flag: 'wx',
        mode: 0o600,
      })
      return { files: [], sourcePresent: false }
    }
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error('UI diagnostic root must be a regular directory')
    const canonical = await realpath(source)
    input = await opendir(source)
    let rootEntries = 0
    for await (const entry of input) {
      rootEntries++
      if (rootEntries > diagnosticLimits.cases + 8)
        throw new Error('UI diagnostic root exceeds its entry bound')
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.isSymbolicLink()) throw new Error('UI diagnostic directories cannot be symlinks')
      if (!/^[a-z\d._-]{1,160}$/iu.test(entry.name))
        throw new Error('UI diagnostic case name exceeds its path bound')
      cases++
      if (cases > diagnosticLimits.cases) throw new Error('UI diagnostics exceed their case bound')
      const directory = join(source, entry.name)
      const identity = await lstat(directory)
      if (
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        (await realpath(directory)) !== join(canonical, entry.name)
      )
        throw new Error('UI diagnostic case escaped its source directory')
      const contents = await opendir(directory)
      let entries = 0
      for await (const file of contents) {
        entries++
        if (entries > diagnosticLimits.entriesPerCase)
          throw new Error('UI diagnostic case exceeds its entry bound')
        if (!['error-context.md', 'trace.zip'].includes(file.name)) continue
        if (!file.isFile() || file.isSymbolicLink())
          throw new Error('UI diagnostics cannot contain non-file sources')
        if (records.length >= diagnosticLimits.files)
          throw new Error('UI diagnostics exceed their file bound')
        const targetDirectory = join(output, entry.name)
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
        const copied = await copyDiagnostic(
          join(directory, file.name),
          join(targetDirectory, file.name),
          Math.min(
            file.name === 'trace.zip' ? diagnosticLimits.traceBytes : diagnosticLimits.contextBytes,
            diagnosticLimits.totalBytes - totalBytes,
          ),
        )
        totalBytes += copied.bytes
        records.push({ path: `${entry.name}/${file.name}`, ...copied })
      }
      await unchangedDirectory(directory, identity)
    }
    await unchangedDirectory(source, root)
    const inventory = { files: records, sourcePresent: true, totalBytes }
    await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    return inventory
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

export async function main(argv = process.argv.slice(2), source = process.env) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--source' ||
    argv[2] !== '--output' ||
    source.GITHUB_ACTIONS !== 'true' ||
    source.PACT_CI_DIAGNOSTIC_LANE !== 'uncredentialed'
  )
    throw new Error('UI diagnostics require the explicit no-credential CI lane')
  const report = await collectUiDiagnostics(argv[1], argv[3])
  console.log(JSON.stringify({ files: report.files.length, bytes: report.totalBytes ?? 0 }))
}

if (isScriptEntry(import.meta.url)) {
  try {
    await main()
  } catch {
    console.error('Bounded no-credential UI diagnostics could not be collected')
    process.exitCode = 1
  }
}
