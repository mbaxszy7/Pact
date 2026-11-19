import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, rename, stat, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, sep } from 'node:path'

import {
  directoryFileOperationInputSchema,
  directoryFileOperationResultSchema,
  PROJECT_FILE_PREVIEW_BYTES,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts/directory-file-operations'
import { WORKSPACE_FILE_BYTES } from '@pact/contracts/workspace-changes'

const COPY_BUFFER_BYTES = 64 * 1024
type FailureCode = Extract<DirectoryFileOperationResult, { ok: false }>['code']
class DirectoryFileError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message)
  }
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
function stableVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}
function requireRegular(info: BigIntStats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
    throw new DirectoryFileError('UNSUPPORTED', 'Only non-linked regular files can be protected.')
}
function metadata(info: BigIntStats, hash: string | null = null): DirectoryFileOperationResult {
  return {
    ok: true,
    existed: true,
    hash,
    bytes: Number(info.size),
    mode: Number(info.mode & 0o7777n),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  }
}
function absent(): DirectoryFileOperationResult {
  return { ok: true, existed: false, hash: null, bytes: 0, mode: 0 }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/** All Project operations use this process's anchored cwd, never a reconstructed absolute path. */
async function enterDirectory(input: DirectoryFileOperationInput): Promise<void> {
  for (const value of [...input.directories, input.name])
    if (value.includes(sep))
      throw new DirectoryFileError('UNSUPPORTED', 'Invalid preview file-name component.')
  const root = await stat('.', { bigint: true })
  if (
    !root.isDirectory() ||
    root.dev.toString() !== input.rootDevice ||
    root.ino.toString() !== input.rootInode
  )
    throw new DirectoryFileError('PATH_CHANGED', 'The Project directory identity changed.')
  for (const component of input.directories) {
    // oxlint-disable-next-line no-await-in-loop -- Each checked directory becomes the cwd anchor for the next component.
    const named = await lstat(`./${component}`, { bigint: true })
    if (named.isSymbolicLink() || !named.isDirectory())
      throw new DirectoryFileError(
        'UNSUPPORTED',
        'Linked or non-directory ancestors cannot be modified.',
      )
    process.chdir(`./${component}`)
    // oxlint-disable-next-line no-await-in-loop -- Verify the cwd object before accessing its next child.
    const entered = await stat('.', { bigint: true })
    if (!sameObject(named, entered) || !entered.isDirectory())
      throw new DirectoryFileError('PATH_CHANGED', 'A Project directory changed during navigation.')
  }
}

async function copySnapshot(
  leaf: string,
  auxiliary: string,
  maximumBytes: number,
  linkedCandidatePath?: string,
): Promise<DirectoryFileOperationResult> {
  let named: BigIntStats
  try {
    named = await lstat(leaf, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return absent()
    throw error
  }
  const linkedCandidate = linkedCandidatePath
    ? await lstat(linkedCandidatePath, { bigint: true })
    : undefined
  const requireSource = (info: BigIntStats): void => {
    // Installation can crash after linking a private candidate but before its
    // private link is released. No unrelated external hardlink is admitted.
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 2n &&
      linkedCandidate?.isFile() &&
      !linkedCandidate.isSymbolicLink() &&
      linkedCandidate.nlink === 2n &&
      sameObject(info, linkedCandidate)
    )
      return
    requireRegular(info)
  }
  requireSource(named)
  const source = await open(leaf, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output: FileHandle | undefined
  try {
    const before = await source.stat({ bigint: true })
    requireSource(before)
    if (!sameObject(named, before))
      throw new DirectoryFileError('PATH_CHANGED', 'The file changed before capture.')
    if (before.size > BigInt(maximumBytes))
      throw new DirectoryFileError('TOO_LARGE', 'The file exceeds the protected snapshot size.')
    output = await open(auxiliary, 'wx', 0o600)
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    const hash = createHash('sha256')
    let position = 0
    const bytes = Number(before.size)
    while (position < bytes) {
      // oxlint-disable-next-line no-await-in-loop -- A fixed buffer bounds snapshot memory and preserves byte order.
      const read = await source.read(buffer, 0, Math.min(buffer.length, bytes - position), position)
      if (read.bytesRead === 0)
        throw new DirectoryFileError('PATH_CHANGED', 'The file changed while being captured.')
      hash.update(buffer.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        // oxlint-disable-next-line no-await-in-loop -- Complete partial writes before reusing the single buffer.
        const result = await output.write(
          buffer,
          written,
          read.bytesRead - written,
          position + written,
        )
        if (!result.bytesWritten)
          throw new DirectoryFileError('IO', 'The saved version could not be written.')
        written += result.bytesWritten
      }
      position += read.bytesRead
    }
    const after = await source.stat({ bigint: true })
    const stillNamed = await lstat(leaf, { bigint: true })
    requireSource(after)
    requireSource(stillNamed)
    if (!stableVersion(before, after) || !stableVersion(after, stillNamed))
      throw new DirectoryFileError('PATH_CHANGED', 'The file changed while being captured.')
    if (after.nlink === 2n && linkedCandidatePath) {
      const stillLinked = await lstat(linkedCandidatePath, { bigint: true })
      if (!sameObject(after, stillLinked) || !stillLinked.isFile() || stillLinked.nlink !== 2n)
        throw new DirectoryFileError('PATH_CHANGED', 'The private installation link changed.')
    }
    await output.sync()
    return metadata(after, hash.digest('hex'))
  } finally {
    await Promise.allSettled([source.close(), ...(output ? [output.close()] : [])])
  }
}

async function readPreview(
  leaf: string,
  deadlineAt: number,
): Promise<DirectoryFileOperationResult> {
  if (Date.now() >= deadlineAt) throw new DirectoryFileError('CANCELLED', 'File preview timed out.')
  const named = await lstat(leaf, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink())
    throw new DirectoryFileError('UNSUPPORTED', 'This link does not point to a file.')
  const handle = await open(
    leaf,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameObject(named, before))
      throw new DirectoryFileError('PATH_CHANGED', 'This file changed while being read. Try again.')
    if (before.size > BigInt(PROJECT_FILE_PREVIEW_BYTES))
      throw new DirectoryFileError('TOO_LARGE', 'This file is too large to preview.')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) {
      if (Date.now() >= deadlineAt)
        throw new DirectoryFileError('CANCELLED', 'File preview timed out.')
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the same bounded descriptor sequentially until EOF or the byte limit.
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const stillNamed = await lstat(leaf, { bigint: true })
    if (
      length !== Number(before.size) ||
      !stableVersion(before, after) ||
      !stableVersion(after, stillNamed) ||
      stillNamed.isSymbolicLink()
    )
      throw new DirectoryFileError('PATH_CHANGED', 'This file changed while being read. Try again.')
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0))
      throw new DirectoryFileError('UNSUPPORTED', 'Binary files cannot be previewed.')
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new DirectoryFileError('UNSUPPORTED', 'This file is not valid UTF-8 text.')
    }
    const result = metadata(after, createHash('sha256').update(bytes).digest('hex'))
    if (!result.ok) return result
    const preview = {
      ...result,
      preview: { content, updatedAt: new Date(Number(after.mtimeMs)).toISOString() },
    }
    if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > PROJECT_FILE_PREVIEW_BYTES)
      throw new DirectoryFileError('TOO_LARGE', 'This file is too large to preview.')
    if (Date.now() >= deadlineAt)
      throw new DirectoryFileError('CANCELLED', 'File preview timed out.')
    return preview
  } finally {
    await handle.close()
  }
}

async function execute(input: DirectoryFileOperationInput): Promise<DirectoryFileOperationResult> {
  if (input.operation === 'preview' && Date.now() >= input.deadlineAt)
    throw new DirectoryFileError('CANCELLED', 'File preview timed out.')
  await enterDirectory(input)
  const leaf = `./${input.name}`
  if (input.operation === 'preview') return readPreview(leaf, input.deadlineAt)
  if (input.operation === 'absent') {
    try {
      await lstat(leaf, { bigint: true })
    } catch (error) {
      if (isMissing(error)) return absent()
      throw error
    }
    throw new DirectoryFileError('IO', 'The destination already exists.')
  }
  const auxiliary = input.auxiliaryPath
  if (!auxiliary || !isAbsolute(auxiliary))
    throw new DirectoryFileError('IO', 'A protected private file path is required.')
  const maximumBytes = input.maximumBytes ?? WORKSPACE_FILE_BYTES
  if (input.linkedCandidatePath && !isAbsolute(input.linkedCandidatePath))
    throw new DirectoryFileError('IO', 'The private installation link must be absolute.')
  if (input.operation === 'capture')
    return copySnapshot(leaf, auxiliary, maximumBytes, input.linkedCandidatePath)
  if (input.operation === 'stash') {
    const before = await lstat(leaf, { bigint: true })
    requireRegular(before)
    if (before.size > BigInt(maximumBytes))
      throw new DirectoryFileError(
        'TOO_LARGE',
        'The current file exceeds the protected backup size.',
      )
    // A regular-file sentinel prevents a late directory from being moved wholesale:
    // rename(directory, existing regular file) fails atomically in the OS.
    const sentinel = await open(auxiliary, 'wx', 0o600)
    await sentinel.sync()
    await sentinel.close()
    await rename(leaf, auxiliary)
    await syncDirectory('.')
    await syncDirectory(dirname(auxiliary))
    const saved = await lstat(auxiliary, { bigint: true })
    requireRegular(saved)
    if (saved.size > BigInt(maximumBytes))
      throw new DirectoryFileError(
        'TOO_LARGE',
        'The actual backup exceeds the supported size and was preserved.',
      )
    return metadata(saved)
  }
  const candidate = await lstat(auxiliary, { bigint: true })
  requireRegular(candidate)
  if (candidate.size > BigInt(maximumBytes))
    throw new DirectoryFileError('TOO_LARGE', 'The saved candidate exceeds the supported size.')
  await link(auxiliary, leaf)
  await syncDirectory('.')
  const installed = await lstat(leaf, { bigint: true })
  if (!installed.isFile() || !sameObject(candidate, installed))
    throw new DirectoryFileError('PATH_CHANGED', 'The destination changed during installation.')
  return metadata(installed)
}

const parentPort = process.parentPort
if (!parentPort) throw new Error('A directory operation requires an Electron parent port.')
let started = false
const receive = (event: Electron.MessageEvent): void => {
  if (started) return
  started = true
  parentPort.removeListener('message', receive)
  void (async () => {
    let result: DirectoryFileOperationResult
    try {
      result = await execute(directoryFileOperationInputSchema.parse(event.data))
    } catch (error) {
      result =
        error instanceof DirectoryFileError
          ? { ok: false, code: error.code, message: error.message }
          : {
              ok: false,
              code: isMissing(error) ? 'PATH_CHANGED' : 'IO',
              message:
                'The protected file operation could not finish safely. Saved private files were retained.',
            }
    }
    parentPort.postMessage(directoryFileOperationResultSchema.parse(result))
    setImmediate(() => process.exit(0))
  })().catch(() => {
    process.exitCode = 1
  })
}
parentPort.on('message', receive)
