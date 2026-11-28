/* oxlint-disable no-await-in-loop -- Protected directory walks, file verification and cleanup are deliberately sequential to bound memory and uphold path invariants. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  open,
  opendir,
  readdir,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  directoryFileOperationInputSchema,
  MAX_DIRECTORY_REQUEST_BYTES,
  WORKSPACE_FILE_BYTES,
  type AgentRun,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
  type DirectoryIdentity,
  type WorkspaceFileVersion,
} from '@pact/contracts'

export const EMPTY_VERSION: WorkspaceFileVersion = { hash: null, bytes: 0, mode: 0 }

export class WorkspaceChangeError extends Error {
  constructor(
    readonly code:
      | 'WORKSPACE_BUSY'
      | 'WORKSPACE_CONFLICT'
      | 'WORKSPACE_UNDO_UNAVAILABLE'
      | 'WORKSPACE_RECOVERY_REQUIRED'
      | 'VALIDATION'
      | 'PERMISSION_DENIED',
    message: string,
  ) {
    super(message)
  }
}

export interface WorkspaceReservation {
  ownerId: string
  sessionId: string
  projectId: string
  root: string
  key: string
  rootDevice: string
  rootInode: string
  handle: Awaited<ReturnType<typeof open>>
}

export interface StagedAnchor {
  version: WorkspaceFileVersion
  stagedFile: string | null
  releaseScratch: (() => void) | null
  auxiliary: boolean
}

export interface PendingAnchorTask {
  task: Promise<void>
  cancel: () => void
}

export interface WorkspaceRun {
  reservation: WorkspaceReservation
  run: AgentRun
  stagingRoot: string
  signal: AbortSignal
  unavailableReason?: string
  finalEndpointsUncertain?: boolean
  retainedHashes: Set<string>
  operations: Set<string>
  anchors: Map<string, StagedAnchor>
  pendingAnchors: Map<string, PendingAnchorTask>
  anchorBytes: number
  retainedBytes: number
  backupBytes: number
  queued: number
  queueBytes: number
  tail: Promise<void>
  closing: boolean
  stagingReady: boolean
}

export interface ApplyFile {
  path: string
  before: WorkspaceFileVersion
  after: WorkspaceFileVersion
  stage: string | null
  backup: string
}

export interface WorkspaceCleanupOwner {
  handle?: FileHandle
  reservation?: WorkspaceReservation
  cleanup?: Promise<void>
  cleanupFailed?: boolean
}

export interface UndoOperation extends WorkspaceCleanupOwner {
  sessionId: string
  projectId: string
  controller: AbortController
  applicationStarted: boolean
  completed: Promise<void>
  complete: () => void
  fail: (error: unknown) => void
  releaseScratch?: () => void
}

export type DirectoryOperationExecutor = (
  input: DirectoryFileOperationInput,
  signal: AbortSignal,
) => Promise<DirectoryFileOperationResult>

export function safeRelativePath(path: string): string {
  // oxlint-disable-next-line no-control-regex -- File names must reject control characters at this trust seam.
  if (isAbsolute(path) || path.includes('\\') || /[\u0000-\u001f]/u.test(path))
    throw new WorkspaceChangeError('VALIDATION', 'Use a regular Project-relative file path.')
  const parts = path.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git' ||
        (process.platform === 'win32' && /[:*?"<>|]|[ .]$/u.test(part)),
    )
  )
    throw new WorkspaceChangeError(
      'VALIDATION',
      'This Project path is unsupported or targets protected repository metadata.',
    )
  return parts.join('/')
}

export function blobPathFor(storageRoot: string, hash: string): string {
  if (!/^[a-f\d]{64}$/u.test(hash))
    throw new WorkspaceChangeError('VALIDATION', 'Invalid saved file reference.')
  return join(storageRoot, 'objects', hash.slice(0, 2), hash)
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function workspaceKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function versionsEqual(a: WorkspaceFileVersion, b: WorkspaceFileVersion): boolean {
  return a.hash === b.hash && a.bytes === b.bytes && a.mode === b.mode
}

export function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT')
}

export function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'EEXIST')
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function writeDurableFile(
  path: string,
  bytes: Buffer,
  allowExisting = false,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (allowExisting && isEexist(error)) return
    throw error
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
}

export async function verifyFileVersion(
  path: string,
  version: WorkspaceFileVersion,
  signal: AbortSignal,
  checkMode = false,
): Promise<void> {
  signal.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.size !== BigInt(version.bytes) ||
      (checkMode && Number(before.mode & 0o7777n) !== version.mode)
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'A saved version has incomplete bytes or metadata.',
      )
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset < version.bytes) {
      signal.throwIfAborted()
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, version.bytes - offset),
        offset,
      )
      if (!read.bytesRead)
        throw new WorkspaceChangeError(
          'VALIDATION',
          'A saved version ended before its expected byte count.',
        )
      hash.update(buffer.subarray(0, read.bytesRead))
      offset += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (
      hash.digest('hex') !== version.hash ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'The saved file version failed its complete integrity check.',
      )
  } finally {
    await handle.close()
  }
}

export async function copyBlobVersion(
  storageRoot: string,
  version: WorkspaceFileVersion,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  if (!version.hash) throw new Error('An absent version cannot be copied.')
  signal.throwIfAborted()
  await copyFile(blobPathFor(storageRoot, version.hash), destination, constants.COPYFILE_EXCL)
  if (process.platform === 'win32') {
    const named = await lstat(destination, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n)
      throw new WorkspaceChangeError('VALIDATION', 'The copied version is unavailable.')
    const original = await open(destination, 'r')
    let writable: FileHandle | undefined
    let verified = false
    try {
      const opened = await original.stat({ bigint: true })
      if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1n)
        throw new WorkspaceChangeError('VALIDATION', 'The copied version changed.')
      verified = true
      // Windows fchmod operates on this verified object through ReOpenFile.
      // A path replacement must never make an immutable blob temporarily writable.
      await original.chmod(0o600)
      writable = await open(destination, 'r+')
      const next = await writable.stat({ bigint: true })
      if (next.dev !== opened.dev || next.ino !== opened.ino || next.nlink !== 1n)
        throw new WorkspaceChangeError('VALIDATION', 'The copied version changed.')
      await original.chmod(version.mode)
      await verifyFileVersion(destination, version, signal, true)
      await writable.sync()
      const current = await lstat(destination, { bigint: true })
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1n ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        throw new WorkspaceChangeError('VALIDATION', 'The copied version changed.')
    } finally {
      try {
        if (verified) await original.chmod(version.mode)
      } finally {
        try {
          await writable?.close()
        } finally {
          await original.close()
        }
      }
    }
  } else {
    const handle = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.nlink !== 1n)
        throw new WorkspaceChangeError('VALIDATION', 'The copied version is unavailable.')
      await verifyFileVersion(destination, version, signal, false)
      await handle.chmod(version.mode)
      const after = await handle.stat({ bigint: true })
      const named = await lstat(destination, { bigint: true })
      if (
        !after.isFile() ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        Number(after.mode & 0o7777n) !== version.mode
      )
        throw new WorkspaceChangeError('VALIDATION', 'The copied version changed.')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  await syncDirectory(dirname(destination))
}

export async function isTextualBlob(
  storageRoot: string,
  version: WorkspaceFileVersion,
  signal: AbortSignal,
): Promise<boolean> {
  if (!version.hash) return false
  const handle = await open(blobPathFor(storageRoot, version.hash), 'r')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const buffer = Buffer.alloc(64 * 1024)
  try {
    let position = 0
    while (true) {
      signal.throwIfAborted()
      const read = await handle.read(buffer, 0, buffer.length, position)
      if (!read.bytesRead) break
      const bytes = buffer.subarray(0, read.bytesRead)
      if (bytes.includes(0)) return false
      decoder.decode(bytes, { stream: true })
      position += bytes.length
      if (position > WORKSPACE_FILE_BYTES) return false
    }
    decoder.decode()
    return true
  } catch {
    signal.throwIfAborted()
    return false
  } finally {
    await handle.close()
  }
}

export async function verifyRootHandle(
  reservation: WorkspaceReservation,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const identity = await reservation.handle.stat({ bigint: true })
  if (
    !identity.isDirectory() ||
    identity.dev.toString() !== reservation.rootDevice ||
    identity.ino.toString() !== reservation.rootInode
  )
    throw new WorkspaceChangeError('VALIDATION', 'The Project directory identity changed.')
}

const SAMPLE_REQUEST_ID = '00000000-0000-0000-0000-000000000000'

export type StandardDirectoryOperation = Exclude<
  DirectoryFileOperationInput['operation'],
  'preview' | 'rmdir_verified'
>

function assertNotLiveDatabaseTarget(
  liveDatabaseFile: string | undefined,
  root: string,
  relativePath: string,
): void {
  if (!liveDatabaseFile) return
  const target = workspaceKey(join(root, relativePath))
  if (
    ['', '-wal', '-shm', '-journal'].some(
      (suffix) => target === workspaceKey(`${liveDatabaseFile}${suffix}`),
    )
  )
    throw new WorkspaceChangeError(
      'PERMISSION_DENIED',
      'Pact’s live database and journal files are not Project-editing targets.',
    )
}

function validateTransportPayload(
  payload: DirectoryFileOperationInput,
): DirectoryFileOperationInput {
  const parsed = directoryFileOperationInputSchema.safeParse(payload)
  if (!parsed.success)
    throw new WorkspaceChangeError(
      'VALIDATION',
      'The file path or operation exceeds protected directory limits.',
    )
  const envelope = {
    type: 'workspace.directory.request' as const,
    requestId: SAMPLE_REQUEST_ID,
    input: parsed.data,
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_DIRECTORY_REQUEST_BYTES)
    throw new WorkspaceChangeError(
      'VALIDATION',
      'The directory operation exceeds its request size budget.',
    )
  return parsed.data
}

/**
 * Validates components, depth (<= 128 directories), live-DB exclusion, and transport request size
 * identically to the protected directory worker BEFORE any disk inspection, intent write, or mutation.
 */
export function buildValidatedDirectoryJobInput(
  liveDatabaseFile: string | undefined,
  reservation: WorkspaceReservation,
  rawPath: string,
  operation: StandardDirectoryOperation,
  auxiliaryPath?: string,
  linkedCandidatePath?: string,
): DirectoryFileOperationInput {
  const relativePath = safeRelativePath(rawPath)
  assertNotLiveDatabaseTarget(liveDatabaseFile, reservation.root, relativePath)
  const parts = relativePath.split('/')
  return validateTransportPayload({
    operation,
    rootPath: reservation.root,
    rootDevice: reservation.rootDevice,
    rootInode: reservation.rootInode,
    directories: parts.slice(0, -1),
    name: parts.at(-1)!,
    ...(auxiliaryPath ? { auxiliaryPath } : {}),
    ...(linkedCandidatePath ? { linkedCandidatePath } : {}),
    maximumBytes: WORKSPACE_FILE_BYTES,
  })
}

export async function executeDirectoryJob(
  directoryOperation: DirectoryOperationExecutor | undefined,
  liveDatabaseFile: string | undefined,
  reservation: WorkspaceReservation,
  rawPath: string,
  operation: StandardDirectoryOperation,
  signal: AbortSignal,
  auxiliaryPath?: string,
  linkedCandidatePath?: string,
): Promise<Extract<DirectoryFileOperationResult, { ok: true }>> {
  if (!directoryOperation)
    throw new WorkspaceChangeError(
      'PERMISSION_DENIED',
      'Protected directory operations are unavailable; no Project file will be changed.',
    )
  signal.throwIfAborted()
  const payload = buildValidatedDirectoryJobInput(
    liveDatabaseFile,
    reservation,
    rawPath,
    operation,
    auxiliaryPath,
    linkedCandidatePath,
  )
  const result = await directoryOperation(payload, signal)
  if (!result.ok) throw new WorkspaceChangeError('VALIDATION', result.message)
  return result
}

/** Creates missing parent directories inside the protected directory worker relative to verified cwd handles. */
export async function ensureParentDirectoriesViaWorker(
  directoryOperation: DirectoryOperationExecutor | undefined,
  liveDatabaseFile: string | undefined,
  reservation: WorkspaceReservation,
  rawPath: string,
  signal: AbortSignal,
): Promise<DirectoryIdentity[]> {
  const payload = buildValidatedDirectoryJobInput(
    liveDatabaseFile,
    reservation,
    rawPath,
    'mkdir_parents',
  )
  if (payload.directories.length === 0) return []
  if (!directoryOperation)
    throw new WorkspaceChangeError(
      'PERMISSION_DENIED',
      'Protected directory operations are unavailable; no Project file will be changed.',
    )
  signal.throwIfAborted()
  const result = await directoryOperation(payload, signal)
  if (!result.ok) throw new WorkspaceChangeError('VALIDATION', result.message)
  return result.parentDirs ?? []
}

/** Inspects ancestor directories inside the protected directory worker without mutating disk. */
export async function inspectParentDirectoriesViaWorker(
  directoryOperation: DirectoryOperationExecutor | undefined,
  liveDatabaseFile: string | undefined,
  reservation: WorkspaceReservation,
  rawPath: string,
  signal: AbortSignal,
): Promise<{
  parentDirs: DirectoryIdentity[]
  missingDirs: string[]
}> {
  const payload = buildValidatedDirectoryJobInput(
    liveDatabaseFile,
    reservation,
    rawPath,
    'inspect_parents',
  )
  if (payload.directories.length === 0) return { parentDirs: [], missingDirs: [] }
  if (!directoryOperation)
    throw new WorkspaceChangeError(
      'PERMISSION_DENIED',
      'Protected directory operations are unavailable; no Project file will be changed.',
    )
  signal.throwIfAborted()
  const result = await directoryOperation(payload, signal)
  if (!result.ok) throw new WorkspaceChangeError('VALIDATION', result.message)
  return {
    parentDirs: result.parentDirs ?? [],
    missingDirs: result.missingDirs ?? [],
  }
}

export function anchorStagingDir(storageRoot: string): string {
  return join(storageRoot, 'staging-anchors')
}

export async function pruneWorkDirectory(work: string, keep: Set<string>): Promise<void> {
  const entries = await readdir(work).catch(() => [])
  for (const name of entries) {
    if (keep.has(name)) continue
    await rm(join(work, name), { recursive: true, force: true })
  }
  if (!keep.size) await rm(work, { recursive: true, force: true })
}

export async function pruneAnchorStagingFiles(
  storageRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const root = anchorStagingDir(storageRoot)
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(root)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  let count = 0
  try {
    for await (const entry of directory) {
      signal.throwIfAborted()
      count += 1
      if (count > 4096) throw new Error('Workspace anchor cleanup exceeded its entry budget.')
      if (entry.isFile() && /^anchor-[a-f\d-]{36}$/u.test(entry.name))
        await unlink(join(root, entry.name)).catch((error) => {
          if (!isEnoent(error)) throw error
        })
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
}

export async function pruneCaptureFiles(storageRoot: string, signal: AbortSignal): Promise<void> {
  const directory = await opendir(storageRoot)
  let count = 0
  try {
    for await (const entry of directory) {
      signal.throwIfAborted()
      count += 1
      if (count > 4096) throw new Error('Workspace capture cleanup exceeded its entry budget.')
      if (entry.isFile() && /^(directory-capture|capture)-[a-f\d-]{36}$/u.test(entry.name))
        await unlink(join(storageRoot, entry.name))
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
}
