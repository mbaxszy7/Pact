/* oxlint-disable no-await-in-loop -- Snapshot buffers, whole-round preflight and directory writes are deliberately sequential to bound memory and preserve operation order. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { NativeFileChange } from '@pact/agent-runtime'

import {
  WORKSPACE_CHANGE_FILES,
  WORKSPACE_EVIDENCE_BYTES,
  WORKSPACE_FILE_BYTES,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  WORKSPACE_PREVIEW_BYTES,
  WORKSPACE_ROUND_BYTES,
  WORKSPACE_STORAGE_BYTES,
  workspaceFileVersionSchema,
  type AgentRun,
  type DirectoryFileOperationResult,
  type WorkspaceArchiveScope,
  type WorkspaceChangeFilePreview,
  type WorkspaceChangeFileReadInput,
  type WorkspaceChangeSet,
  type WorkspaceChangesPage,
  type WorkspaceChangesReadInput,
  type WorkspaceFileVersion,
} from '@pact/contracts'
import {
  WorkspaceChangesRepository,
  type ProjectCatalogRepository,
  type SessionRepository,
  type WorkspaceChangeIntent,
  type WorkspaceChangeSetRecord,
} from '@pact/persistence'

import {
  anchorStagingDir,
  blobPathFor,
  buildValidatedDirectoryJobInput,
  EMPTY_VERSION,
  ensureParentDirectoriesViaWorker,
  executeDirectoryJob,
  inspectParentDirectoriesViaWorker,
  isEexist,
  isEnoent,
  isTextualBlob,
  pruneAnchorStagingFiles,
  pruneCaptureFiles,
  pruneWorkDirectory,
  safeRelativePath,
  sha256Hex,
  syncDirectory,
  verifyFileVersion,
  versionsEqual,
  WorkspaceChangeError,
  workspaceKey,
  writeDurableFile,
  type ApplyFile,
  type DirectoryOperationExecutor,
  type StandardDirectoryOperation,
  type UndoOperation,
  type WorkspaceCleanupOwner,
  type WorkspaceReservation,
  type WorkspaceRun,
} from './workspace-change-fs'
import {
  computeDiffStatistics,
  deriveAfterFromBeforeAndPatch,
  deriveBeforeFromCurrentAndPatch,
  hasUnsupportedPatchMetadata,
} from './workspace-change-patch'
import {
  applyUndoOperations,
  planUndoOperations,
  selectUndoTargets,
  type UndoExecutionContext,
} from './workspace-change-undo'

export { WorkspaceChangeError, type WorkspaceReservation } from './workspace-change-fs'

const PREVIEW_BYTES = WORKSPACE_PREVIEW_BYTES
const TOOL_QUEUE_ITEMS = 4
const RECORDING_RUNS = 5
const UNDO_OPERATIONS = 5
const RECOVERY_PAGE_LIMIT = 1024
const RECOVERY_PATH_REFERENCES = 1024

interface RecordingPreparation extends WorkspaceCleanupOwner {
  sessionId: string
  projectId: string
  attempt: Promise<string | undefined>
}

/** Owns passive native evidence and cold round / single-file Undo, never forward Agent writes. */
export class WorkspaceChanges {
  private readonly owners = new Map<string, WorkspaceReservation>()
  private readonly runs = new Map<string, WorkspaceRun>()
  // At most five preparations and five Undo operations; no native execution is queued.
  private readonly preparingRuns = new Map<string, RecordingPreparation>()
  private readonly undoOperations = new Map<string, UndoOperation>()
  private readonly pendingAnchorDeletions = new Map<
    string,
    { stagedFile: string; bytes: number; releaseScratch: () => void }
  >()
  private pendingBlobBytes = 0
  // Reservations include every private capture, merge/patch output and candidate until cleanup
  // or transfer to the durable intent counter. Each caller owns its release in a finally block.
  private scratchBytes = 0
  private disposed = false

  constructor(
    private readonly repository: WorkspaceChangesRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectCatalogRepository,
    private readonly storageRoot: string,
    private readonly directoryOperation?: DirectoryOperationExecutor,
    private readonly liveDatabaseFile?: string,
  ) {}

  async initialize(): Promise<WorkspaceChangeSet[]> {
    await mkdir(join(this.storageRoot, 'objects'), { recursive: true, mode: 0o700 })
    await mkdir(anchorStagingDir(this.storageRoot), { recursive: true, mode: 0o700 })
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(new Error('Workspace recovery timed out.')),
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    try {
      await pruneCaptureFiles(this.storageRoot, controller.signal)
      await pruneAnchorStagingFiles(this.storageRoot, controller.signal)
      // No-write startup reconciliation. Uncertain filesystem effects never become an automatic restore.
      const summaries = new Map<string, WorkspaceChangeSet>()
      let cursor: string | undefined
      for (let page = 0; page < 1024; page += 1) {
        const pending = this.repository.pendingIntents(cursor)
        if (!pending.length) break
        for (const intent of pending) {
          controller.signal.throwIfAborted()
          const changeSet = this.repository.find(intent.changeSetId)
          if (!changeSet) throw new Error('A workspace recovery record has no owning round.')
          this.repository.recoverInterruptedRecording(changeSet.id)
          const summary = this.repository.markRecoveryRequired(
            changeSet.id,
            'A file operation was interrupted. Saved versions are retained; further Undo is unavailable until the operation is reconciled.',
          )
          summaries.set(summary.id, this.repository.finalize(summary.id))
        }
        cursor = pending.at(-1)?.id
        if (pending.length < 100) break
        if (page === 1023) throw new Error('Workspace recovery exceeds its startup page budget.')
      }
      let setCursor: string | undefined
      for (let page = 0; page < 1024; page += 1) {
        const sets = this.repository.recoverableSets(setCursor)
        if (!sets.length) break
        for (const record of sets) {
          controller.signal.throwIfAborted()
          await this.pruneSetWork(record, controller.signal)
          this.repository.recoverInterruptedRecording(record.id)
          summaries.set(record.id, this.repository.finalize(record.id))
        }
        setCursor = sets.at(-1)?.id
        if (sets.length < 100) break
        if (page === 1023)
          throw new Error('Workspace startup reconciliation exceeds its page budget.')
      }
      return [...summaries.values()]
    } finally {
      clearTimeout(deadline)
    }
  }

  async reserve(
    sessionId: string,
    ownerId: string,
    exclusive = true,
    signal?: AbortSignal,
    owner?: WorkspaceCleanupOwner,
  ): Promise<WorkspaceReservation> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    const deadline = setTimeout(
      () => controller.abort(new Error('Project preparation timed out.')),
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let transferred = false
    let reservation: WorkspaceReservation | undefined
    try {
      controller.signal.throwIfAborted()
      if (this.disposed) throw new WorkspaceChangeError('PERMISSION_DENIED', 'Pact is closing.')
      const session = this.sessions.find(sessionId)
      const project = session ? this.projects.find(session.projectId) : undefined
      if (!session || session.status === 'archived' || !project || project.archivedAt)
        throw new WorkspaceChangeError('VALIDATION', 'This Project is unavailable.')
      const root = await realpath(project.directoryPath)
      controller.signal.throwIfAborted()
      if (root !== project.directoryPath)
        throw new WorkspaceChangeError(
          'VALIDATION',
          'The registered Project root was replaced or redirected.',
        )
      const key = workspaceKey(root)
      const previous = this.owners.get(key)
      if (exclusive && previous && previous.ownerId !== ownerId)
        throw new WorkspaceChangeError(
          'WORKSPACE_BUSY',
          'Another Session is modifying this Project. Wait for its Run to finish.',
        )
      if (exclusive && previous) {
        await this.acquire(previous, controller.signal)
        return previous
      }
      if (exclusive && this.owners.size >= 5)
        throw new WorkspaceChangeError(
          'WORKSPACE_BUSY',
          'At most five Projects can be modified at once.',
        )
      handle = await open(
        root,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      )
      if (owner) owner.handle = handle
      const identity = await handle.stat({ bigint: true })
      controller.signal.throwIfAborted()
      if (!identity.isDirectory() || (await realpath(project.directoryPath)) !== root) {
        throw new WorkspaceChangeError(
          'VALIDATION',
          'The Project root changed while its directory object was opened.',
        )
      }
      controller.signal.throwIfAborted()
      reservation = {
        ownerId,
        sessionId,
        projectId: project.id,
        root,
        key,
        handle,
        rootDevice: identity.dev.toString(),
        rootInode: identity.ino.toString(),
      }
      if (exclusive) await this.acquire(reservation, controller.signal)
      if (owner) owner.reservation = reservation
      transferred = true
      return reservation
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      if (!transferred && handle) {
        await this.closeHandle(handle, owner)
        if (reservation && this.owners.get(reservation.key) === reservation)
          this.owners.delete(reservation.key)
      }
    }
  }

  async release(reservation: WorkspaceReservation, owner?: WorkspaceCleanupOwner): Promise<void> {
    await this.closeHandle(reservation.handle, owner)
    if (this.owners.get(reservation.key) === reservation) this.owners.delete(reservation.key)
  }

  private closeHandle(handle: FileHandle, owner?: WorkspaceCleanupOwner): Promise<void> {
    const close = async (): Promise<void> => {
      try {
        await handle.close()
      } catch {
        if (owner) owner.cleanupFailed = true
        throw new WorkspaceChangeError(
          'WORKSPACE_RECOVERY_REQUIRED',
          'File recording cleanup could not be confirmed. Restart Pact before checking this archive again.',
        )
      }
    }
    if (!owner) return close()
    owner.cleanup ??= close()
    return owner.cleanup
  }

  begin(reservation: WorkspaceReservation, run: AgentRun, signal: AbortSignal): void {
    if (this.disposed) throw new WorkspaceChangeError('PERMISSION_DENIED', 'Pact is closing.')
    if (run.sessionId !== reservation.sessionId)
      throw new WorkspaceChangeError('PERMISSION_DENIED', 'The Project Writer reservation expired.')
    this.cancelUndoForNativeRun(reservation.projectId)
    const stagingRoot = join(this.storageRoot, 'staging', randomUUID())
    this.runs.set(run.id, {
      reservation,
      run,
      stagingRoot,
      signal,
      retainedHashes: new Set(),
      operations: new Set(),
      anchors: new Map(),
      pendingAnchors: new Map(),
      anchorBytes: 0,
      retainedBytes: 0,
      backupBytes: 0,
      queued: 0,
      queueBytes: 0,
      tail: Promise.resolve(),
      closing: false,
      stagingReady: false,
    })
  }

  start(run: AgentRun, signal: AbortSignal): Promise<string | undefined> {
    const previous = this.preparingRuns.get(run.id)
    if (previous) return previous.attempt
    const projectId = this.sessions.find(run.sessionId)?.projectId
    if (projectId) this.cancelUndoForNativeRun(projectId)
    if (this.runs.has(run.id)) {
      this.setSignal(run.id, signal)
      return Promise.resolve(undefined)
    }
    if (this.runs.size + this.preparingRuns.size >= RECORDING_RUNS || !projectId)
      return Promise.resolve(
        'File change recording is unavailable because its bounded recording slots are occupied or the Project is unavailable. The native Agent can continue; these edits cannot be undone in Pact.',
      )
    const attempt = Promise.withResolvers<string | undefined>()
    const owner: RecordingPreparation = {
      sessionId: run.sessionId,
      projectId,
      attempt: attempt.promise,
    }
    this.preparingRuns.set(run.id, owner)
    void this.prepareRecording(run, signal, owner).then(attempt.resolve, attempt.reject)
    void owner.attempt.catch(() => undefined)
    return owner.attempt
  }

  private async prepareRecording(
    run: AgentRun,
    signal: AbortSignal,
    owner: RecordingPreparation,
  ): Promise<string | undefined> {
    let reservation: WorkspaceReservation | undefined
    let started = false
    // Recording preparation is not execution admission and never acquires a writer lease.
    try {
      reservation = await this.reserve(run.sessionId, run.id, false, signal, owner)
      this.begin(reservation, run, signal)
      started = true
    } catch (error) {
      if (owner.cleanupFailed) throw error
      // The native Agent remains usable. Without directory evidence no Undo is advertised.
      return 'File change recording could not verify this Project. The native Agent can continue; these edits cannot be undone in Pact.'
    } finally {
      if (reservation && !started) await this.release(reservation, owner)
      if (!owner.cleanupFailed) this.preparingRuns.delete(run.id)
    }
    return undefined
  }

  cancelUndoForNativeSession(sessionId: string): void {
    const projectId = this.sessions.find(sessionId)?.projectId
    if (projectId) this.cancelUndoForNativeRun(projectId)
  }

  private cancelUndoForNativeRun(projectId: string): void {
    const undo = this.undoOperations.get(projectId)
    if (!undo) return
    undo.controller.abort(
      new WorkspaceChangeError(
        undo.applicationStarted ? 'WORKSPACE_RECOVERY_REQUIRED' : 'WORKSPACE_BUSY',
        undo.applicationStarted
          ? 'An Agent started while Undo was applying. Remaining writes were stopped; recovery evidence is retained.'
          : 'An Agent started while Undo was checking. Undo was cancelled; no Project files were changed.',
      ),
    )
  }

  summary(runId: string): WorkspaceChangeSet | undefined {
    return this.repository.find(runId) ? this.repository.summary(runId) : undefined
  }

  setSignal(runId: string, signal: AbortSignal): void {
    const context = this.runs.get(runId)
    if (context) context.signal = signal
  }

  hasEffects(runId: string): boolean {
    const record = this.repository.find(runId)
    return (
      record !== undefined &&
      (record.fileCount > 0 ||
        Boolean(record.undoUnavailableReason) ||
        Boolean(record.effectsUncertain))
    )
  }

  /**
   * Captures a passive pre-touch baseline snapshot of `relativePath` before the first native
   * write/edit/delete tool mutates disk in `runId`. Never throws or blocks native execution.
   * Unconfirmed anchor bytes remain in bounded temporary staging and are promoted to durable
   * storage only if a finalized change requires them.
   */
  anchorBeforeFirstTouch(
    runId: string,
    relativePath: string,
    sourceSignal: AbortSignal,
  ): Promise<void> {
    const context = this.runs.get(runId)
    if (!context || context.closing || this.disposed) return Promise.resolve()
    // Async ACP start notifications are auxiliary only; skip pre-touch anchoring for AGY.
    if (context.run.agentId === 'agy') return Promise.resolve()
    let normalized: string
    try {
      normalized = safeRelativePath(
        isAbsolute(relativePath)
          ? relative(context.reservation.root, relativePath).split(sep).join('/')
          : relativePath,
      )
      buildValidatedDirectoryJobInput(
        this.liveDatabaseFile,
        context.reservation,
        normalized,
        'capture',
      )
    } catch {
      return Promise.resolve()
    }
    const inFlight = context.pendingAnchors.get(normalized)
    if (inFlight) return inFlight.task
    if (context.anchors.has(normalized)) return Promise.resolve()
    if (this.repository.find(runId) && this.repository.file(runId, normalized))
      return Promise.resolve()
    if (context.anchors.size + context.pendingAnchors.size >= WORKSPACE_CHANGE_FILES)
      return Promise.resolve()
    // Share the bounded 4-callback round queue with formal record operations.
    if (context.queued + context.pendingAnchors.size >= TOOL_QUEUE_ITEMS) return Promise.resolve()

    const controller = new AbortController()
    const abort = (): void => controller.abort(sourceSignal.reason)
    sourceSignal.addEventListener('abort', abort, { once: true })
    if (sourceSignal.aborted) abort()
    const deadline = setTimeout(() => controller.abort(), WORKSPACE_OPERATION_TIMEOUT_MS)

    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      clearTimeout(deadline)
      sourceSignal.removeEventListener('abort', abort)
      if (context.pendingAnchors.get(normalized)?.task === task) {
        context.pendingAnchors.delete(normalized)
      }
    }

    const task = context.tail
      .then(() => this.executeAnchorOperation(runId, context, normalized, controller.signal))
      .catch(() => {
        /* Pre-touch anchoring is passive and must never fail or block a native tool. */
      })
      .finally(cleanup)

    context.pendingAnchors.set(normalized, {
      task,
      cancel: () => {
        cleanup()
        controller.abort()
      },
    })
    context.tail = task
    return task
  }

  private async executeAnchorOperation(
    runId: string,
    context: WorkspaceRun,
    normalized: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.retryPendingAnchorDeletions()
    if (
      context.closing ||
      this.disposed ||
      signal.aborted ||
      context.anchors.has(normalized) ||
      (this.repository.find(runId) && this.repository.file(runId, normalized))
    )
      return
    const location = relative(context.reservation.root, await realpath(this.storageRoot))
    if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)) return
    if (context.retainedBytes + context.backupBytes + context.anchorBytes >= WORKSPACE_ROUND_BYTES)
      return
    const anchorDir = anchorStagingDir(this.storageRoot)
    await mkdir(anchorDir, { recursive: true, mode: 0o700 })
    const stagedFile = join(anchorDir, `anchor-${randomUUID()}`)
    const releaseCaptureScratch = this.reserveScratch(WORKSPACE_FILE_BYTES, signal)
    let retained = false
    try {
      const result = await this.directoryJob(
        context.reservation,
        normalized,
        'capture',
        signal,
        stagedFile,
      )
      if (!result.existed) {
        context.anchors.set(normalized, {
          version: EMPTY_VERSION,
          stagedFile: null,
          releaseScratch: null,
          auxiliary: false,
        })
        return
      }
      const version: WorkspaceFileVersion = {
        hash: result.hash,
        bytes: result.bytes,
        mode: result.mode,
      }
      await verifyFileVersion(stagedFile, version, signal)
      if (
        context.retainedBytes + context.backupBytes + context.anchorBytes + version.bytes >
        WORKSPACE_ROUND_BYTES
      )
        return
      const holdScratch = this.reserveScratch(version.bytes, signal)
      context.anchorBytes += version.bytes
      let anchorReleased = false
      context.anchors.set(normalized, {
        version,
        stagedFile,
        releaseScratch: () => {
          if (anchorReleased) return
          anchorReleased = true
          context.anchorBytes -= version.bytes
          holdScratch()
        },
        auxiliary: false,
      })
      retained = true
    } finally {
      if (retained) {
        releaseCaptureScratch()
      } else {
        try {
          await unlink(stagedFile)
          releaseCaptureScratch()
        } catch (error) {
          if (isEnoent(error)) {
            releaseCaptureScratch()
          } else {
            // Retain conservative scratch charge until a later unlink confirms file deletion.
            this.pendingAnchorDeletions.set(stagedFile, {
              stagedFile,
              bytes: WORKSPACE_FILE_BYTES,
              releaseScratch: releaseCaptureScratch,
            })
          }
        }
      }
    }
  }

  private async releaseAnchor(context: WorkspaceRun, path: string): Promise<void> {
    const entry = context.anchors.get(path)
    if (!entry) return
    const staged = entry.stagedFile
    const release = entry.releaseScratch
    const bytes = entry.version.bytes
    entry.stagedFile = null
    entry.releaseScratch = null
    if (!staged) {
      release?.()
      return
    }
    try {
      await unlink(staged)
      this.pendingAnchorDeletions.delete(staged)
      release?.()
    } catch (error) {
      if (isEnoent(error)) {
        this.pendingAnchorDeletions.delete(staged)
        release?.()
      } else if (release) {
        this.pendingAnchorDeletions.set(staged, {
          stagedFile: staged,
          bytes,
          releaseScratch: release,
        })
      }
    }
  }

  private async evictUnusedAnchors(
    context: WorkspaceRun,
    bytesNeeded: number,
    excludePath?: string,
  ): Promise<void> {
    let freed = 0
    for (const [anchorPath, entry] of context.anchors) {
      if (freed >= bytesNeeded) break
      if (anchorPath === excludePath || !entry.stagedFile) continue
      const stagedPath = entry.stagedFile
      const entryBytes = entry.version.bytes
      await this.releaseAnchor(context, anchorPath)
      if (!this.pendingAnchorDeletions.has(stagedPath)) freed += entryBytes
    }
  }

  private async retryPendingAnchorDeletions(): Promise<void> {
    for (const entry of this.pendingAnchorDeletions.values()) {
      try {
        await unlink(entry.stagedFile)
        this.pendingAnchorDeletions.delete(entry.stagedFile)
        entry.releaseScratch()
      } catch (error) {
        if (isEnoent(error)) {
          this.pendingAnchorDeletions.delete(entry.stagedFile)
          entry.releaseScratch()
        }
      }
    }
  }

  private async releaseAllAnchors(context: WorkspaceRun): Promise<void> {
    for (const pending of context.pendingAnchors.values()) {
      pending.cancel()
    }
    for (const path of context.anchors.keys()) {
      await this.releaseAnchor(context, path)
    }
    context.anchors.clear()
    await this.retryPendingAnchorDeletions()
  }

  /** Recording is passive: no Project mutation or native-tool approval happens here. */
  async record(runId: string, change: NativeFileChange, sourceSignal: AbortSignal): Promise<void> {
    const context = this.runs.get(runId)
    if (!context || context.closing || this.disposed) return
    if (change.invalidateOnly) {
      /* Invalidation is ordered evidence, not a new edited-file operation. */
    } else if (
      !change.operationId ||
      change.operationId.length > 512 ||
      context.operations.size >= 1024
    ) {
      this.uncertain(
        runId,
        'Native file operations lack a complete bounded identity sequence. Undo is unavailable.',
      )
    } else if (context.operations.has(change.operationId)) return
    else context.operations.add(change.operationId)
    const bytes = [change.before, change.after, change.patch].reduce<number>(
      (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0,
    )
    // Prioritize completed native records over speculative pending anchors within the shared 4-slot queue.
    if (
      context.queued < TOOL_QUEUE_ITEMS &&
      context.queued + context.pendingAnchors.size >= TOOL_QUEUE_ITEMS
    ) {
      for (const pending of context.pendingAnchors.values()) {
        pending.cancel()
        if (context.queued + context.pendingAnchors.size < TOOL_QUEUE_ITEMS) break
      }
    }
    if (
      bytes > WORKSPACE_EVIDENCE_BYTES ||
      context.queued + context.pendingAnchors.size >= TOOL_QUEUE_ITEMS ||
      context.queueBytes + bytes > WORKSPACE_EVIDENCE_BYTES * 2
    ) {
      this.uncertain(
        runId,
        'Native file evidence exceeded the recording budget. Undo is unavailable.',
      )
      this.recordUnavailableFile(context, change)
      return
    }
    context.queued += 1
    context.queueBytes += bytes
    const controller = new AbortController()
    const abort = (): void => controller.abort(sourceSignal.reason)
    sourceSignal.addEventListener('abort', abort, { once: true })
    if (sourceSignal.aborted) abort()
    const deadline = setTimeout(() => controller.abort(), WORKSPACE_OPERATION_TIMEOUT_MS)
    const operation = context.tail.then(() =>
      this.executeRecordOperation(runId, context, change, controller.signal),
    )
    context.tail = operation.catch((error: unknown) => {
      this.uncertain(
        runId,
        error instanceof Error
          ? error.message
          : 'Native file evidence could not be saved. Undo is unavailable.',
      )
      this.recordUnavailableFile(context, change)
    })
    try {
      await context.tail
    } finally {
      clearTimeout(deadline)
      sourceSignal.removeEventListener('abort', abort)
      context.queued -= 1
      context.queueBytes -= bytes
    }
  }

  private async executeRecordOperation(
    runId: string,
    context: WorkspaceRun,
    change: NativeFileChange,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (change.invalidateOnly) {
      try {
        const invalidPath = safeRelativePath(
          isAbsolute(change.path)
            ? relative(context.reservation.root, change.path).split(sep).join('/')
            : change.path,
        )
        await this.releaseAnchor(context, invalidPath)
      } catch {
        /* Ignore invalid paths when discarding unused anchors. */
      }
      this.recordUnavailableFile(context, change)
      return
    }
    await this.ensureStaging(context)
    this.ensureRecord(context)
    const path = safeRelativePath(
      isAbsolute(change.path)
        ? relative(context.reservation.root, change.path).split(sep).join('/')
        : change.path,
    )
    const previousPath = change.previousPath
      ? safeRelativePath(
          isAbsolute(change.previousPath)
            ? relative(context.reservation.root, change.previousPath).split(sep).join('/')
            : change.previousPath,
        )
      : undefined
    const old = this.repository.file(runId, path)
    if (this.repository.files(runId).length >= WORKSPACE_CHANGE_FILES && !old)
      throw new Error('This round exceeded the native file recording limit.')

    const anchorKey = previousPath ?? path
    const anchorEntry = !old ? context.anchors.get(anchorKey) : undefined
    const trustedAnchor = anchorEntry && !anchorEntry.auxiliary ? anchorEntry : undefined
    const needsCapturedCurrent =
      previousPath !== undefined && change.after === undefined && trustedAnchor !== undefined
    const current = needsCapturedCurrent
      ? await this.capture(context.reservation.root, path, context, signal, context.reservation)
      : await this.observe(context.reservation, path, signal)
    const observedMode = current.hash !== null ? current.mode : 0
    const textMode = trustedAnchor?.version.hash ? trustedAnchor.version.mode : observedMode
    // Text-only in-place edits on pre-existing files never attest POSIX mode ownership:
    // keep modeKnown = false so Undo preserves current user permissions (e.g. chmod 0600).
    const isPreExistingModify =
      change.kind === 'modified' && previousPath === undefined && (!old || old.before.hash !== null)

    let beforeAvailable = change.before !== undefined
    let afterAvailable = change.after !== undefined
    let usedAnchorForBefore = false
    let modeKnown = false
    let before = beforeAvailable
      ? await this.saveText(context, change.before!, textMode, signal)
      : EMPTY_VERSION
    try {
      if (
        beforeAvailable &&
        trustedAnchor &&
        trustedAnchor.version.hash === before.hash &&
        trustedAnchor.version.bytes === before.bytes
      ) {
        before = { ...before, mode: trustedAnchor.version.mode }
        if (!isPreExistingModify) modeKnown = true
      } else if (!beforeAvailable && trustedAnchor !== undefined && !change.mixed) {
        if (trustedAnchor.version.hash === null) {
          before = EMPTY_VERSION
          beforeAvailable = true
          usedAnchorForBefore = true
          if (!isPreExistingModify) modeKnown = true
        } else if (trustedAnchor.stagedFile !== null) {
          before = await this.captureStaged(
            trustedAnchor.stagedFile,
            trustedAnchor.version.mode,
            context,
            signal,
            trustedAnchor.version.bytes,
            anchorKey,
          )
          beforeAvailable = true
          usedAnchorForBefore = true
          if (!isPreExistingModify) modeKnown = true
        }
      }
    } finally {
      if (anchorEntry) await this.releaseAnchor(context, anchorKey)
    }

    // Same-run continuous patch chain (e.g. Codex `added` B -> `update` patch B -> C):
    // forward-apply onto the already-verified intermediate `old.after` in private staging
    // instead of forcing `unavailable` when no pre-touch anchor applies to the 2nd operation.
    if (
      !beforeAvailable &&
      !change.mixed &&
      previousPath === undefined &&
      change.patch !== undefined &&
      old !== undefined &&
      old.beforeAvailable !== false &&
      old.afterAvailable !== false &&
      old.undoStrategy !== 'unavailable' &&
      old.after.hash !== null
    ) {
      before = old.after
      beforeAvailable = true
    }

    // Preserve verified mode continuity for a file created earlier in this same run (added -> modified/deleted).
    if (
      old &&
      old.before.hash === null &&
      old.modeKnown === true &&
      old.afterAvailable !== false &&
      beforeAvailable &&
      old.after.hash === before.hash &&
      old.after.bytes === before.bytes
    ) {
      before = { ...before, mode: old.after.mode }
      modeKnown = true
    }

    // Never absorb unattributed post-write disk mode changes into a mode-tracked rename or same-run added file:
    // keep the proven mode so external chmod drift is caught by the versionsEqual(current, after) check.
    const targetAfterMode =
      modeKnown && (previousPath !== undefined || (old !== undefined && old.before.hash === null))
        ? before.mode
        : observedMode

    let after = afterAvailable
      ? await this.saveText(context, change.after!, targetAfterMode, signal)
      : EMPTY_VERSION

    let reason: string | undefined = change.unavailableReason
    if (change.mixed)
      reason ??= 'The native result includes simultaneous user edits; Undo is unavailable.'

    const unsupportedPatch = change.patch !== undefined && hasUnsupportedPatchMetadata(change.patch)
    if (unsupportedPatch)
      reason ??=
        'Native mode or binary patch metadata needs complete original evidence. Undo is unavailable.'

    // Forward patch derivation: before + patch -> after (e.g. Claude Edit, Codex added, or chained same-run update).
    if (beforeAvailable && !afterAvailable && change.patch && !previousPath && !unsupportedPatch) {
      const releasePatchScratch = this.reserveScratch(
        before.bytes + Buffer.byteLength(change.patch) + WORKSPACE_FILE_BYTES,
        signal,
      )
      try {
        after = await deriveAfterFromBeforeAndPatch({
          storageRoot: this.storageRoot,
          stagingRoot: context.stagingRoot,
          path,
          kind: change.kind,
          before,
          patch: change.patch,
          mode: targetAfterMode,
          captureStaged: (staged, fileMode, sig) =>
            this.captureStaged(staged, fileMode, context, sig),
          signal,
        })
        afterAvailable = true
      } catch {
        reason ??=
          'The native patch could not be applied to its original version; Undo is unavailable.'
      } finally {
        releasePatchScratch()
      }
    }

    // Deletion-only reverse-patch derivation (non-relocatable complete deletion patch when absent on disk).
    // Relocatable reverse matching against disk bytes for `modified` or `renamed` is forbidden.
    if (
      change.kind === 'deleted' &&
      !beforeAvailable &&
      change.after === null &&
      change.patch &&
      !unsupportedPatch &&
      !reason
    ) {
      const releaseRevPatchScratch = this.reserveScratch(
        Buffer.byteLength(change.patch) + WORKSPACE_FILE_BYTES,
        signal,
      )
      try {
        before = await deriveBeforeFromCurrentAndPatch({
          storageRoot: this.storageRoot,
          stagingRoot: context.stagingRoot,
          path,
          kind: change.kind,
          current,
          patch: change.patch,
          mode: 0,
          captureStaged: (staged, fileMode, sig) =>
            this.captureStaged(staged, fileMode, context, sig),
          signal,
        })
        beforeAvailable = true
        if (!afterAvailable) {
          after = EMPTY_VERSION
          afterAvailable = true
        }
      } catch {
        reason ??=
          'The native patch could not be reversed and verified against the current file; Undo is unavailable.'
      } finally {
        releaseRevPatchScratch()
      }
    }

    // Pure rename backed by a trusted synchronous pre-touch anchor.
    if (
      previousPath &&
      beforeAvailable &&
      !afterAvailable &&
      current.hash !== null &&
      usedAnchorForBefore &&
      !reason
    ) {
      after = modeKnown ? { ...current, mode: before.mode } : current
      afterAvailable = true
    }

    if (previousPath) {
      const prevCurrent = await this.observe(context.reservation, previousPath, signal)
      if (prevCurrent.hash !== null)
        reason ??= 'The original rename source path still exists on disk; Undo is unavailable.'
    }

    // Added files have no historical pre-existing mode; when final content matches disk, record verified final mode.
    if (
      change.kind === 'added' &&
      !previousPath &&
      beforeAvailable &&
      before.hash === null &&
      afterAvailable &&
      current.hash !== null &&
      current.hash === after.hash &&
      current.bytes === after.bytes
    ) {
      after = { ...after, mode: current.mode }
      modeKnown = true
    }

    if (change.kind === 'deleted' && !modeKnown)
      reason ??=
        'The original file permissions were not captured before deletion; Undo is unavailable.'
    if ((change.kind === 'renamed' || previousPath !== undefined) && !modeKnown)
      reason ??=
        'The original file permissions were not captured before rename; Undo is unavailable.'

    if (
      afterAvailable &&
      (modeKnown
        ? !versionsEqual(current, after)
        : current.hash !== after.hash || current.bytes !== after.bytes)
    )
      reason ??=
        'The file changed outside the recorded native operation. Undo is unavailable for this mixed round.'

    if (
      old &&
      old.afterAvailable !== false &&
      beforeAvailable &&
      (old.modeKnown === false || !modeKnown
        ? old.after.hash !== before.hash || old.after.bytes !== before.bytes
        : !versionsEqual(old.after, before))
    )
      reason ??= 'Native file versions do not form one continuous round. Undo is unavailable.'

    // Reject binary/NUL or invalid UTF-8 endpoints before assigning `three_way` so summary counts
    // and Undo preflight agree (requirements.md: binary evidence disables Undo visibly).
    if (!reason && beforeAvailable && afterAvailable) {
      const checkedHashes = new Set<string>()
      for (const endpoint of [old?.before ?? before, before, after]) {
        if (!endpoint.hash || checkedHashes.has(endpoint.hash)) continue
        checkedHashes.add(endpoint.hash)
        if (!(await isTextualBlob(this.storageRoot, endpoint, signal))) {
          reason ??= 'Binary or non-UTF-8 file content cannot be undone safely.'
          break
        }
      }
    }

    const patchVersions = change.patch
      ? [await this.saveText(context, change.patch, 0o600, signal)]
      : undefined
    const strategy = reason
      ? 'unavailable'
      : beforeAvailable && afterAvailable
        ? 'three_way'
        : 'unavailable'
    if (strategy === 'unavailable')
      reason ??=
        'The Agent did not provide complete original and final file versions. A patch alone cannot safely identify this change for Undo.'

    const stats =
      beforeAvailable && afterAvailable
        ? await computeDiffStatistics({
            storageRoot: this.storageRoot,
            before: old?.before ?? before,
            after,
            workDir: context.stagingRoot,
            signal,
          })
        : { additions: null, deletions: null }

    this.repository.recordFiles(
      runId,
      [
        {
          path,
          previousPath: previousPath ?? null,
          kind: change.kind,
          before,
          after,
          beforeAvailable,
          afterAvailable,
          modeKnown,
          undoStrategy: strategy,
          ...(patchVersions ? { patchVersions } : {}),
          ...stats,
          hidden: false,
          reason: reason ?? null,
        },
      ],
      context.unavailableReason,
    )
  }

  uncertain(runId: string, reason: string): void {
    const context = this.runs.get(runId)
    if (!context) return
    context.unavailableReason ??= reason.slice(0, 1024)
    context.finalEndpointsUncertain = true
    try {
      this.ensureRecord(context)
    } catch {
      /* Native execution is not conditional on recording. */
    }
    if (this.repository.find(runId)) {
      try {
        this.repository.recordFiles(runId, [], context.unavailableReason)
      } catch {
        /* Evidence failure cannot stop a native tool. */
      }
    }
  }

  observeUncertainEffects(runId: string): void {
    const context = this.runs.get(runId)
    if (!context) return
    try {
      this.ensureRecord(context)
      this.repository.observeUncertainEffects(runId)
    } catch {
      /* Recording does not gate native execution. */
    }
  }

  private recordUnavailableFile(context: WorkspaceRun, change: NativeFileChange): void {
    try {
      this.ensureRecord(context)
      const path = safeRelativePath(
        isAbsolute(change.path)
          ? relative(context.reservation.root, change.path).split(sep).join('/')
          : change.path,
      )
      const previous = this.repository.file(context.run.id, path)
      if (change.invalidateOnly && !previous) return
      this.repository.recordFiles(
        context.run.id,
        [
          {
            ...(previous ?? {
              path,
              previousPath: change.previousPath ?? null,
              kind: change.kind,
              before: EMPTY_VERSION,
              after: EMPTY_VERSION,
              beforeAvailable: false,
              hidden: false,
            }),
            afterAvailable: false,
            undoStrategy: 'unavailable',
            patchVersions: [],
            additions: null,
            deletions: null,
            reason:
              context.unavailableReason ??
              change.unavailableReason ??
              'Complete native file evidence is unavailable.',
          },
        ],
        context.unavailableReason,
      )
    } catch {
      /* Native execution remains independent of storage/metadata availability. */
    }
  }

  private async saveText(
    context: WorkspaceRun,
    text: string | null,
    mode: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    if (text === null) return EMPTY_VERSION
    if (Buffer.byteLength(text) > WORKSPACE_FILE_BYTES)
      throw new Error('Native file evidence exceeds the complete-version limit.')
    const temporary = join(context.stagingRoot, `native-${randomUUID()}`)
    try {
      await writeDurableFile(temporary, Buffer.from(text))
      return await this.captureStaged(temporary, mode, context, signal)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private readonly finishing = new Map<
    string,
    { sessionId: string; projectId: string; promise: Promise<WorkspaceChangeSet | undefined> }
  >()

  finish(runId: string): Promise<WorkspaceChangeSet | undefined> {
    const existing = this.finishing.get(runId)
    if (existing) return existing.promise
    const context = this.runs.get(runId)
    if (!context) return Promise.resolve(undefined)
    const task = this.finishRun(runId).then((summary) => {
      if (this.finishing.get(runId)?.promise === task) this.finishing.delete(runId)
      return summary
    })
    this.finishing.set(runId, {
      sessionId: context.reservation.sessionId,
      projectId: context.reservation.projectId,
      promise: task,
    })
    // Keep the original rejected promise as the owner's outcome; observing it is not a retry.
    void task.catch(() => undefined)
    return task
  }

  hasPendingFinalization(scope: WorkspaceArchiveScope): boolean {
    return this.scopeFinalizations(scope).length > 0
  }

  /** Bounded ownership metadata for quitting; never reads files or releases an owner. */
  pendingSessionIds(): string[] {
    return [
      ...new Set([
        ...[...this.runs.values()].map((owner) => owner.run.sessionId),
        ...[...this.preparingRuns.values()].map((owner) => owner.sessionId),
        ...[...this.finishing.values()].map((owner) => owner.sessionId),
        ...[...this.undoOperations.values()].map((owner) => owner.sessionId),
      ]),
    ]
  }

  async awaitFinalization(scope: WorkspaceArchiveScope): Promise<void> {
    await Promise.all(this.scopeFinalizations(scope))
  }

  private scopeFinalizations(scope: WorkspaceArchiveScope): Promise<unknown>[] {
    return [
      ...this.finishing.values(),
      ...[...this.preparingRuns.values()].map((owner) => ({
        sessionId: owner.sessionId,
        projectId: owner.projectId,
        promise: owner.attempt,
      })),
      ...[...this.undoOperations.values()].map((owner) => ({
        sessionId: owner.sessionId,
        projectId: owner.projectId,
        promise: owner.completed,
      })),
    ]
      .filter((entry) =>
        scope.kind === 'session'
          ? entry.sessionId === scope.sessionId
          : entry.projectId === scope.projectId,
      )
      .map((entry) => entry.promise)
  }

  private async finishRun(runId: string): Promise<WorkspaceChangeSet | undefined> {
    const context = this.runs.get(runId)
    if (!context || context.closing) return undefined
    context.closing = true
    let finalized = false
    try {
      await context.tail
      if (!this.repository.find(runId)) {
        finalized = true
        return undefined
      }
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), WORKSPACE_OPERATION_TIMEOUT_MS)
      try {
        for (const file of this.repository.files(runId)) {
          if (this.repository.state(runId) === 'recovery_required') break
          try {
            const current = await this.observe(context.reservation, file.path, controller.signal)
            if (
              file.afterAvailable !== false &&
              (file.modeKnown === false
                ? current.hash !== file.after.hash || current.bytes !== file.after.bytes
                : !versionsEqual(current, file.after))
            ) {
              // Unattributed disk drift during an active Run must never be promoted into `after`:
              // keep the last confirmed native endpoint and disable Undo for the affected file.
              // Keep reason fixed-length (<= 1024 chars) so a long path never aborts settlement.
              const driftReason =
                'This file changed while the Agent Run was active. Undo is unavailable for this file.'
              this.repository.recordFiles(runId, [
                {
                  ...file,
                  undoStrategy: 'unavailable',
                  patchVersions: [],
                  reason: file.reason ?? driftReason,
                },
              ])
            }
          } catch {
            this.repository.recordFiles(
              runId,
              [],
              'A final file version could not be verified. Undo is unavailable because this round may contain simultaneous edits.',
            )
            break
          }
        }
      } finally {
        clearTimeout(deadline)
      }
      if (context.unavailableReason)
        this.repository.recordFiles(runId, [], context.unavailableReason)
      if (context.finalEndpointsUncertain)
        this.repository.recordFiles(
          runId,
          this.repository.files(runId).map((file) =>
            Object.assign({}, file, {
              afterAvailable: false,
              undoStrategy: 'unavailable',
              patchVersions: [],
              additions: null,
              deletions: null,
              reason:
                file.reason ??
                context.unavailableReason ??
                'The final native file sequence could not be confirmed.',
            }),
          ),
        )
      const summary = this.repository.finalize(runId)
      finalized = true
      return summary
    } finally {
      await this.releaseAllAnchors(context)
      context.retainedHashes.clear()
      context.operations.clear()
      await this.release(context.reservation)
      // A created staging directory holds valuable object backups whenever intents exist.
      if (context.stagingReady && !this.hasEffects(runId))
        await rm(context.stagingRoot, { recursive: true, force: true })
      if (finalized) this.runs.delete(runId)
    }
  }

  readPage(input: WorkspaceChangesReadInput): WorkspaceChangesPage {
    this.validateSet(input.changeSetId)
    return this.repository.readPage(input)
  }

  async readFile(input: WorkspaceChangeFileReadInput): Promise<WorkspaceChangeFilePreview> {
    const changeSet = this.validateSet(input.changeSetId)
    const file = this.repository.file(changeSet.id, input.path)
    if (!file || file.hidden)
      throw new WorkspaceChangeError('VALIDATION', 'This historical file is unavailable.')
    const patchCount = file.patchVersions?.length ?? 0
    const identity = {
      changeSetId: changeSet.id,
      side: input.side,
      ...(input.side === 'patch' ? { patchIndex: input.patchIndex ?? 0 } : {}),
    }
    const unavailable = (
      reason: Extract<WorkspaceChangeFilePreview, { status: 'unavailable' }>['reason'],
    ): WorkspaceChangeFilePreview => ({
      status: 'unavailable',
      ...identity,
      sessionId: changeSet.sessionId,
      relativePath: input.path,
      reason,
      patchCount,
    })
    if (
      input.side !== 'patch' &&
      (input.side === 'before' ? file.beforeAvailable : file.afterAvailable) === false
    )
      return unavailable(
        input.side === 'after' && changeSet.state === 'recording' ? 'not_final' : 'not_recorded',
      )
    const version =
      input.side === 'patch' ? file.patchVersions?.[input.patchIndex ?? 0] : file[input.side]
    if (!version) return unavailable('not_recorded')
    if (version.bytes > PREVIEW_BYTES) return unavailable('too_large')
    if (!version.hash && version.bytes !== 0) return unavailable('blob_corrupt')
    const bytes = Buffer.alloc(version.bytes)
    if (version.hash) {
      try {
        const handle = await open(
          blobPathFor(this.storageRoot, version.hash),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        )
        try {
          const metadata = await handle.stat()
          if (!metadata.isFile() || metadata.size !== version.bytes)
            return unavailable('blob_corrupt')
          let offset = 0
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!read.bytesRead) return unavailable('blob_corrupt')
            offset += read.bytesRead
          }
        } finally {
          await handle.close()
        }
      } catch (error) {
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
        return unavailable(
          code === 'ENOENT' ? 'blob_missing' : code === 'ELOOP' ? 'blob_corrupt' : 'temporary_io',
        )
      }
    }
    if (bytes.length !== version.bytes || (version.hash && sha256Hex(bytes) !== version.hash))
      return unavailable('blob_corrupt')
    let content: string
    try {
      if (bytes.includes(0)) throw new Error('binary')
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return unavailable('unsupported_encoding')
    }
    const result = {
      sessionId: changeSet.sessionId,
      relativePath: input.path,
      absolutePath: join(changeSet.root, input.path),
      content,
      contentHash: version.hash ?? sha256Hex(bytes),
      lineCount: content ? content.replace(/\r\n?/gu, '\n').split('\n').length : 0,
      updatedAt: changeSet.finalizedAt ?? changeSet.createdAt,
    }
    const preview: WorkspaceChangeFilePreview = {
      status: 'available',
      ...identity,
      file: result,
      patchCount,
    }
    if (Buffer.byteLength(JSON.stringify(preview)) > PREVIEW_BYTES) return unavailable('too_large')
    return preview
  }

  async undo(
    id: string,
    projectBusy?: (projectId: string) => boolean,
    path?: string,
  ): Promise<WorkspaceChangeSet>
  async undo(
    id: string,
    path?: string,
    projectBusy?: (projectId: string) => boolean,
  ): Promise<WorkspaceChangeSet>
  async undo(
    id: string,
    second?: ((projectId: string) => boolean) | string,
    third?: string | ((projectId: string) => boolean),
  ): Promise<WorkspaceChangeSet> {
    const projectBusy: (projectId: string) => boolean =
      typeof second === 'function' ? second : typeof third === 'function' ? third : () => false
    const path = typeof second === 'string' ? second : typeof third === 'string' ? third : undefined

    const changeSet = this.validateSet(id)
    const requireIdle = (): void => {
      if (projectBusy(changeSet.projectId))
        throw new WorkspaceChangeError(
          'WORKSPACE_BUSY',
          'Native work in this Project has not settled. No files were changed.',
        )
    }
    requireIdle()
    if (
      [...this.runs.values()].some((run) => run.reservation.projectId === changeSet.projectId) ||
      [...this.preparingRuns.values()].some((owner) => owner.projectId === changeSet.projectId)
    )
      throw new WorkspaceChangeError(
        'WORKSPACE_BUSY',
        'An Agent is still running in this Project. No files were changed.',
      )
    const assertRoundUndoEligible = (
      record: WorkspaceChangeSetRecord,
      fallbackMessage: string,
    ): void => {
      if (path !== undefined) {
        if (
          record.undoUnavailableReason !== null ||
          (record.state !== 'ready' && record.state !== 'mixed')
        )
          throw new WorkspaceChangeError(
            'WORKSPACE_UNDO_UNAVAILABLE',
            record.undoUnavailableReason ?? fallbackMessage,
          )
        return
      }
      if (record.state !== 'ready' || record.undoUnavailableReason !== null)
        throw new WorkspaceChangeError(
          'WORKSPACE_UNDO_UNAVAILABLE',
          this.repository.summary(record.id).undoUnavailableReason ?? fallbackMessage,
        )
    }
    assertRoundUndoEligible(changeSet, 'This round cannot be undone again.')
    if (this.undoOperations.has(changeSet.projectId) || this.undoOperations.size >= UNDO_OPERATIONS)
      throw new WorkspaceChangeError(
        'WORKSPACE_BUSY',
        'An Undo is already checking this Project or all five Undo slots are occupied. No files were changed.',
      )
    const controller = new AbortController()
    const completion = Promise.withResolvers<void>()
    const operation: UndoOperation = {
      sessionId: changeSet.sessionId,
      projectId: changeSet.projectId,
      controller,
      applicationStarted: false,
      completed: completion.promise,
      complete: completion.resolve,
      fail: completion.reject,
    }
    this.undoOperations.set(changeSet.projectId, operation)
    void operation.completed.catch(() => undefined)
    const timer = setTimeout(
      () => controller.abort(new Error('Undo timed out.')),
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    const work = join(changeSet.stagingRoot, `undo-${randomUUID()}`)
    let reservation: WorkspaceReservation | undefined
    let intentId: string | undefined
    const settleUndo = async (): Promise<void> => {
      try {
        if (operation.cleanupFailed) await operation.cleanup
        if (reservation) await this.release(reservation, operation)
        await this.pruneIntentWork(work, intentId)
        operation.releaseScratch?.()
        if (this.undoOperations.get(changeSet.projectId) === operation)
          this.undoOperations.delete(changeSet.projectId)
        operation.complete()
      } catch (error) {
        operation.fail(error)
        throw error
      }
    }
    try {
      reservation = await this.reserve(
        changeSet.sessionId,
        `undo:${id}:${randomUUID()}`,
        true,
        controller.signal,
        operation,
      )
      const latest = this.validateSet(id)
      assertRoundUndoEligible(latest, 'This round is no longer available for Undo.')
      if (reservation.root !== changeSet.root)
        throw new WorkspaceChangeError(
          'WORKSPACE_CONFLICT',
          'The Project directory changed. No files were changed.',
        )
      if (
        reservation.rootDevice !== changeSet.rootDevice ||
        reservation.rootInode !== changeSet.rootInode
      )
        throw new WorkspaceChangeError(
          'WORKSPACE_CONFLICT',
          'The Project directory object was replaced. No files were changed.',
        )
      const selection = selectUndoTargets(this.repository, id, path)
      operation.releaseScratch = this.reserveScratch(
        WORKSPACE_ROUND_BYTES + WORKSPACE_FILE_BYTES,
        controller.signal,
      )
      await mkdir(work, { recursive: true, mode: 0o700 })
      const staging = await stat(work, { bigint: true })
      if (staging.dev.toString() !== reservation.rootDevice)
        throw new WorkspaceChangeError(
          'WORKSPACE_UNDO_UNAVAILABLE',
          'The Project and protected storage are on different volumes. Saved changes remain readable, but Undo is unavailable. No Project files were changed.',
        )
      const undoCtx = this.undoContext()
      const plan = await planUndoOperations(
        undoCtx,
        reservation,
        id,
        work,
        selection.targets,
        selection.targetPath,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      requireIdle()
      intentId = randomUUID()
      this.repository.intent({
        id: intentId,
        changeSetId: id,
        kind: 'undo',
        payload: {
          root: reservation.root,
          ...(selection.targetPath ? { path: selection.targetPath } : {}),
          files: plan.prepared,
        },
        retainedBytes: plan.prepared.reduce((sum, file) => sum + file.before.bytes, 0),
      })
      try {
        await applyUndoOperations(
          undoCtx,
          reservation,
          plan,
          controller.signal,
          intentId,
          operation,
          requireIdle,
        )
        return selection.targetPath !== undefined
          ? this.repository.markFileUndone(id, selection.targetPath, intentId)
          : this.repository.completeUndo(intentId, id)
      } catch (error) {
        if (!operation.applicationStarted) {
          this.repository.cancelUnappliedUndo(intentId)
          throw error
        }
        this.repository.completeIntent(intentId, 'recovery_required')
        this.repository.markRecoveryRequired(
          id,
          'Undo was interrupted after application began. Saved originals and candidate versions are retained; no external edits will be force-restored.',
        )
        throw new WorkspaceChangeError(
          'WORKSPACE_RECOVERY_REQUIRED',
          'Undo could not finish. The original versions were preserved; further Undo is unavailable pending recovery. This is not a zero-change preflight refusal.',
        )
      }
    } catch (error) {
      // A cancelled read/Git worker may report its transport error; preserve the
      // operation owner's proven zero-write cancellation instead of that wrapper.
      if (!operation.applicationStarted) controller.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(timer)
      await settleUndo()
    }
  }

  private undoContext(): UndoExecutionContext {
    return {
      repository: this.repository,
      storageRoot: this.storageRoot,
      capture: (root, filePath, signal, reservation) =>
        this.capture(root, filePath, undefined, signal, reservation),
      observe: (reservation, filePath, signal) => this.observe(reservation, filePath, signal),
      captureStaged: (stagedPath, mode, signal) =>
        this.captureStaged(stagedPath, mode, undefined, signal),
      validateDirectoryJob: (reservation, rawPath, operation, auxiliaryPath) => {
        buildValidatedDirectoryJobInput(
          this.liveDatabaseFile,
          reservation,
          rawPath,
          operation,
          auxiliaryPath,
        )
      },
      directoryJob: (reservation, rawPath, operation, signal, auxiliaryPath) =>
        this.directoryJob(reservation, rawPath, operation, signal, auxiliaryPath),
      inspectParentDirs: (reservation, rawPath, signal) =>
        inspectParentDirectoriesViaWorker(
          this.directoryOperation,
          this.liveDatabaseFile,
          reservation,
          rawPath,
          signal,
        ),
      ensureParentDirs: (reservation, rawPath, signal) =>
        ensureParentDirectoriesViaWorker(
          this.directoryOperation,
          this.liveDatabaseFile,
          reservation,
          rawPath,
          signal,
        ),
      roundVersions: (changeSetId) => this.roundVersions(changeSetId),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const undos = [...this.undoOperations.values()]
    for (const undo of undos) undo.controller.abort(new Error('Pact is closing.'))
    const undoResults = await Promise.allSettled(undos.map((undo) => undo.completed))
    const preparations = await Promise.allSettled(
      [...this.preparingRuns.values()].map((owner) => owner.attempt),
    )
    const active = [...this.runs.values()]
    await Promise.allSettled(active.map((context) => context.tail))
    const finished = await Promise.allSettled([
      ...active.map((context) => this.finish(context.run.id)),
      ...[...this.finishing.values()].map((entry) => entry.promise),
    ])
    await this.retryPendingAnchorDeletions()
    if (
      [...undoResults, ...preparations, ...finished].some(
        (result) => result.status === 'rejected',
      ) ||
      this.owners.size
    )
      throw new WorkspaceChangeError(
        'WORKSPACE_RECOVERY_REQUIRED',
        'Some file recording resources did not finish cleanup. Their ownership is retained until Pact exits.',
      )
  }

  private async capture(
    root: string,
    path: string,
    context: WorkspaceRun | undefined,
    signal: AbortSignal,
    reservation?: WorkspaceReservation,
  ): Promise<WorkspaceFileVersion> {
    const authority =
      reservation ??
      context?.reservation ??
      [...this.owners.values()].find((owner) => owner.root === root)
    if (!authority)
      throw new WorkspaceChangeError(
        'PERMISSION_DENIED',
        'No directory-object authority is available for this file read.',
      )
    const temporary = join(this.storageRoot, `directory-capture-${randomUUID()}`)
    buildValidatedDirectoryJobInput(this.liveDatabaseFile, authority, path, 'capture', temporary)
    const releaseScratch = this.reserveScratch(WORKSPACE_FILE_BYTES, signal)
    try {
      const result = await this.directoryJob(authority, path, 'capture', signal, temporary)
      if (!result.existed) return EMPTY_VERSION
      const captured = await this.captureStaged(temporary, result.mode, context, signal)
      if (captured.hash !== result.hash || captured.bytes !== result.bytes)
        throw new WorkspaceChangeError(
          'VALIDATION',
          'The protected snapshot failed its directory-copy integrity check.',
        )
      return captured
    } finally {
      try {
        await unlink(temporary).catch((error) => {
          if (!isEnoent(error)) throw error
        })
      } finally {
        releaseScratch()
      }
    }
  }

  private directoryJob(
    reservation: WorkspaceReservation,
    rawPath: string,
    operation: StandardDirectoryOperation,
    signal: AbortSignal,
    auxiliaryPath?: string,
    linkedCandidatePath?: string,
  ): Promise<Extract<DirectoryFileOperationResult, { ok: true }>> {
    return executeDirectoryJob(
      this.directoryOperation,
      this.liveDatabaseFile,
      reservation,
      rawPath,
      operation,
      signal,
      auxiliaryPath,
      linkedCandidatePath,
    )
  }

  private async captureStaged(
    path: string,
    mode: number | undefined,
    context: WorkspaceRun | undefined,
    signal: AbortSignal,
    promotedAnchorBytes = 0,
    excludeAnchorPath?: string,
  ): Promise<WorkspaceFileVersion> {
    signal.throwIfAborted()
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1)
      throw new WorkspaceChangeError(
        'VALIDATION',
        'Only regular, non-linked files can be protected. Directories, links and special objects are unsupported.',
      )
    if (metadata.size > WORKSPACE_FILE_BYTES)
      throw new WorkspaceChangeError(
        'VALIDATION',
        'This file exceeds the 64 MiB complete-snapshot limit; Undo is unavailable.',
      )
    const netRoundDelta = Math.max(0, metadata.size - promotedAnchorBytes)
    if (context) {
      const roundExcess =
        context.retainedBytes +
        context.backupBytes +
        context.anchorBytes +
        netRoundDelta -
        WORKSPACE_ROUND_BYTES
      const storageExcess =
        this.repository.blobBytes() +
        this.pendingBlobBytes +
        this.scratchBytes +
        metadata.size * 2 -
        WORKSPACE_STORAGE_BYTES
      const bytesToFree = Math.max(roundExcess, storageExcess)
      if (bytesToFree > 0 && context.anchorBytes > 0) {
        await this.evictUnusedAnchors(context, bytesToFree, excludeAnchorPath)
      }
    }
    if (
      this.repository.blobBytes() + this.pendingBlobBytes + this.scratchBytes + metadata.size * 2 >
      WORKSPACE_STORAGE_BYTES
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'Workspace recovery storage is full; no file was changed.',
      )
    if (
      context &&
      context.retainedBytes + context.backupBytes + context.anchorBytes + netRoundDelta >
        WORKSPACE_ROUND_BYTES
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'This round cannot retain another complete recovery version.',
      )
    const releaseScratch = this.reserveScratch(metadata.size, signal)
    this.pendingBlobBytes += metadata.size
    const temporary = join(this.storageRoot, `capture-${randomUUID()}`)
    let source: Awaited<ReturnType<typeof open>> | undefined
    let destination: Awaited<ReturnType<typeof open>> | undefined
    try {
      source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = await source.stat()
      if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || !opened.isFile())
        throw new WorkspaceChangeError('VALIDATION', 'The source path changed during capture.')
      destination = await open(temporary, 'wx', 0o600)
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let total = 0
      while (true) {
        signal.throwIfAborted()
        const read = await source.read(buffer, 0, buffer.length, total)
        if (!read.bytesRead) break
        total += read.bytesRead
        if (total > WORKSPACE_FILE_BYTES || total > metadata.size)
          throw new WorkspaceChangeError('VALIDATION', 'The file grew beyond its snapshot budget.')
        const chunk = buffer.subarray(0, read.bytesRead)
        hash.update(chunk)
        let written = 0
        while (written < chunk.length) {
          signal.throwIfAborted()
          const result = await destination.write(
            chunk,
            written,
            chunk.length - written,
            total - read.bytesRead + written,
          )
          if (!result.bytesWritten)
            throw new WorkspaceChangeError(
              'VALIDATION',
              'The saved file version could not be written completely.',
            )
          written += result.bytesWritten
        }
      }
      const after = await source.stat()
      const named = await lstat(path)
      if (
        after.size !== total ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        named.ino !== opened.ino ||
        named.dev !== opened.dev
      )
        throw new WorkspaceChangeError(
          'VALIDATION',
          'The file changed while its version was captured; read it again.',
        )
      await destination.sync()
      await destination.close()
      destination = undefined
      const digest = hash.digest('hex')
      await verifyFileVersion(temporary, { hash: digest, bytes: total, mode: 0 }, signal)
      const stored = blobPathFor(this.storageRoot, digest)
      await mkdir(dirname(stored), { recursive: true, mode: 0o700 })
      // Admission precedes the persistent link: an abort cannot leave an uncharged blob.
      // A failed private installation may leave conservatively charged metadata; no caller
      // receives the version until the named object passes its integrity check below.
      this.repository.recordBlob(digest, total)
      try {
        await link(temporary, stored)
        await chmod(stored, 0o400)
        await syncDirectory(dirname(stored))
      } catch (error) {
        if (!isEexist(error)) throw error
      }
      await verifyFileVersion(stored, { hash: digest, bytes: total, mode: 0 }, signal)
      const version = { hash: digest, bytes: total, mode: mode ?? metadata.mode & 0o7777 }
      if (context && !context.retainedHashes.has(digest)) {
        context.retainedHashes.add(digest)
        context.retainedBytes += total
      }
      return version
    } finally {
      try {
        await Promise.allSettled([
          ...(source ? [source.close()] : []),
          ...(destination ? [destination.close()] : []),
        ])
        await unlink(temporary).catch((error) => {
          if (!isEnoent(error)) throw error
        })
      } finally {
        this.pendingBlobBytes -= metadata.size
        releaseScratch()
      }
    }
  }

  private async ensureStaging(context: WorkspaceRun): Promise<void> {
    if (context.stagingReady) return
    const location = relative(context.reservation.root, await realpath(this.storageRoot))
    if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))
      throw new WorkspaceChangeError(
        'VALIDATION',
        'Protected staging must be outside the Project directory.',
      )
    await mkdir(dirname(context.stagingRoot), { recursive: true, mode: 0o700 })
    await mkdir(context.stagingRoot, { mode: 0o700 })
    const [root, stage] = await Promise.all([
      context.reservation.handle.stat({ bigint: true }),
      stat(context.stagingRoot, { bigint: true }),
    ])
    if (
      root.dev.toString() !== context.reservation.rootDevice ||
      root.ino.toString() !== context.reservation.rootInode
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'The Project directory object changed before native evidence could be recorded.',
      )
    if (root.dev !== stage.dev)
      context.unavailableReason ??=
        'The Project and protected storage are on different volumes. Saved changes remain readable, but Undo is unavailable.'
    await syncDirectory(dirname(context.stagingRoot))
    context.stagingReady = true
  }

  private validateSet(id: string) {
    const changeSet = this.repository.find(id)
    const session = changeSet ? this.sessions.find(changeSet.sessionId) : undefined
    if (
      !changeSet ||
      (changeSet.fileCount === 0 && changeSet.state !== 'recovery_required') ||
      !session ||
      session.status === 'archived'
    )
      throw new WorkspaceChangeError('VALIDATION', 'This saved round is unavailable.')
    return changeSet
  }

  private ensureRecord(context: WorkspaceRun): void {
    if (this.repository.find(context.run.id)) return
    const reservation = context.reservation
    this.repository.begin({
      runId: context.run.id,
      sessionId: context.run.sessionId,
      projectId: reservation.projectId,
      agentId: context.run.agentId,
      root: reservation.root,
      stagingRoot: context.stagingRoot,
      rootDevice: reservation.rootDevice,
      rootInode: reservation.rootInode,
    })
  }

  private intentFiles(intent: WorkspaceChangeIntent): ApplyFile[] {
    const raw = intent.payload['files']
    if (!Array.isArray(raw) || raw.length > WORKSPACE_CHANGE_FILES * 2)
      throw new Error('The saved workspace operation has invalid file references.')
    return raw.map((file: unknown) => {
      if (!file || typeof file !== 'object') throw new Error('Invalid workspace recovery file.')
      const path = Reflect.get(file, 'path')
      const backup = Reflect.get(file, 'backup')
      const stage = Reflect.get(file, 'stage')
      if (
        typeof path !== 'string' ||
        typeof backup !== 'string' ||
        !isAbsolute(backup) ||
        (stage !== null && (typeof stage !== 'string' || !isAbsolute(stage)))
      )
        throw new Error('Invalid workspace recovery paths.')
      return {
        path: safeRelativePath(path),
        before: workspaceFileVersionSchema.parse(Reflect.get(file, 'before')),
        after: workspaceFileVersionSchema.parse(Reflect.get(file, 'after')),
        backup,
        stage,
      }
    })
  }

  private roundVersions(id: string): { bytes: number; hashes: Set<string> } {
    const hashes = new Set<string>()
    let bytes = 0
    for (const intent of this.repository.intents(id)) {
      bytes += intent.retainedBytes
      for (const file of this.intentFiles(intent)) {
        for (const version of [file.before, file.after]) {
          if (version.hash && !hashes.has(version.hash)) {
            hashes.add(version.hash)
            bytes += version.bytes
          }
        }
      }
    }
    return { bytes, hashes }
  }

  private async pruneIntentWork(work: string, intentId?: string): Promise<void> {
    const intent = intentId ? this.repository.findIntent(intentId) : undefined
    const keep = new Set<string>()
    let retainedBytes = 0
    if (intent) {
      const applicationConfirmed =
        intent.status === 'applied' &&
        (intent.kind !== 'undo' ||
          intent.reconciledAt !== null ||
          this.repository.find(intent.changeSetId)?.state === 'undone')
      for (const file of this.intentFiles(intent)) {
        for (const path of [
          file.backup,
          ...(applicationConfirmed || !file.stage ? [] : [file.stage]),
        ]) {
          if (dirname(path) !== work)
            throw new Error('A saved private file escaped its operation directory.')
          const saved = await lstat(path).catch((error) => {
            if (isEnoent(error)) return undefined
            throw error
          })
          if (saved) {
            keep.add(basename(path))
            retainedBytes += saved.size
          }
        }
      }
    }
    // Unreferenced Git inputs/outputs are never recovery evidence. Pending candidates and
    // displaced objects are retained and charged before their scratch reservation is released.
    await pruneWorkDirectory(work, keep)
    if (intent && retainedBytes > intent.retainedBytes)
      this.repository.intent({ ...intent, retainedBytes })
  }

  private async pruneSetWork(record: WorkspaceChangeSetRecord, signal: AbortSignal): Promise<void> {
    const intents = this.repository.intents(record.id)
    const byWork = new Map(
      intents.map((intent) => [dirname(this.intentFiles(intent)[0]?.backup ?? ''), intent.id]),
    )
    const entries = await readdir(record.stagingRoot).catch((error) => {
      if (isEnoent(error)) return []
      throw error
    })
    if (entries.length > RECOVERY_PATH_REFERENCES + 1)
      throw new Error('Workspace temporary directories exceed their round limit.')
    for (const name of entries) {
      signal.throwIfAborted()
      const work = join(record.stagingRoot, name)
      if (/^(operation|undo)-[a-f\d-]{36}$/u.test(name)) {
        await this.pruneIntentWork(work, byWork.get(work))
        continue
      }
      if (
        !byWork.has(work) &&
        /^(native-patch|native-revpatch|native-patch-input|native-revpatch-input|native|anchor)-[a-f\d-]{36}$/u.test(
          name,
        )
      ) {
        await rm(work, { recursive: true, force: true })
      }
    }
  }

  private reserveScratch(bytes: number, signal: AbortSignal): () => void {
    signal.throwIfAborted()
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.repository.blobBytes() + this.pendingBlobBytes + this.scratchBytes + bytes >
        WORKSPACE_STORAGE_BYTES
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'Workspace temporary/recovery storage is full. No new Project write was started.',
      )
    this.scratchBytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.scratchBytes -= bytes
    }
  }

  private async acquire(reservation: WorkspaceReservation, signal: AbortSignal): Promise<void> {
    const current = this.owners.get(reservation.key)
    if (current && current !== reservation)
      throw new WorkspaceChangeError(
        'WORKSPACE_BUSY',
        'Another Session currently holds this Project Writer. Read-only work may continue.',
      )
    if (!current && this.owners.size >= 5)
      throw new WorkspaceChangeError(
        'WORKSPACE_BUSY',
        'The bounded Project Writer slots are occupied.',
      )
    signal.throwIfAborted()
    this.owners.set(reservation.key, reservation)
    // reserve releases this directory object before retiring the acquired owner on failure.
    if (this.repository.hasRecoveryForRoot(reservation.root))
      await this.reconcile(reservation, signal)
    signal.throwIfAborted()
  }

  /** Observe known intent endpoints only. Equality does not establish who performed an
   * interrupted write, so settlement always disables Undo and never replays Project I/O. */
  private async reconcile(reservation: WorkspaceReservation, signal: AbortSignal): Promise<void> {
    const reason =
      'Pact observed every interrupted path at a saved before/after version without changing Project files. Operation attribution remains uncertain; this mixed round cannot be undone.'
    const records = new Map<string, { record: WorkspaceChangeSetRecord; intentIds: string[] }>()
    let cursor: string | undefined
    let observedFiles = 0
    for (let page = 0; page < RECOVERY_PAGE_LIMIT; page += 1) {
      signal.throwIfAborted()
      const pending = this.repository.pendingIntents(cursor)
      for (const intent of pending) {
        const record = this.repository.find(intent.changeSetId)
        if (!record || record.root !== reservation.root) continue
        if (
          record.rootDevice !== reservation.rootDevice ||
          record.rootInode !== reservation.rootInode ||
          intent.payload['root'] !== reservation.root
        )
          throw new WorkspaceChangeError(
            'WORKSPACE_RECOVERY_REQUIRED',
            'The interrupted operation belongs to a different Project directory object. No recovery write was performed.',
          )
        if (record.state !== 'recovery_required')
          this.repository.markRecoveryRequired(
            record.id,
            'An interrupted operation requires observation before another write.',
          )
        let observed = records.get(record.id)
        if (!observed) {
          if (records.size >= 32)
            throw new WorkspaceChangeError(
              'WORKSPACE_RECOVERY_REQUIRED',
              'The Project exceeds the bounded recovery observation limit.',
            )
          observed = { record, intentIds: [] }
          records.set(record.id, observed)
        }
        const files = this.intentFiles(intent)
        for (const file of files) {
          signal.throwIfAborted()
          observedFiles += 1
          if (observedFiles > RECOVERY_PATH_REFERENCES)
            throw new WorkspaceChangeError(
              'WORKSPACE_RECOVERY_REQUIRED',
              'Interrupted paths exceed the bounded recovery observation limit.',
            )
          let linkedCandidate: string | undefined
          if (file.stage) {
            if (
              dirname(file.stage) !== dirname(file.backup) ||
              !dirname(file.stage).startsWith(`${record.stagingRoot}${sep}`)
            )
              throw new WorkspaceChangeError(
                'WORKSPACE_RECOVERY_REQUIRED',
                'The saved candidate escaped its private operation directory.',
              )
            const staged = await lstat(file.stage).catch((error) => {
              if (isEnoent(error)) return undefined
              throw error
            })
            if (staged?.nlink === 2) {
              await verifyFileVersion(file.stage, file.after, signal, true)
              linkedCandidate = file.stage
            }
          }
          const current = await this.observe(
            reservation,
            file.path,
            signal,
            linkedCandidate,
            file.after,
          )
          if (!versionsEqual(current, file.before) && !versionsEqual(current, file.after))
            throw new WorkspaceChangeError(
              'WORKSPACE_RECOVERY_REQUIRED',
              `The interrupted path ${file.path} has external content or metadata outside its saved versions. No Project files were changed; recovery evidence is retained.`,
            )
        }
        observed.intentIds.push(intent.id)
      }
      if (pending.length < 100) break
      cursor = pending.at(-1)?.id
      if (page === RECOVERY_PAGE_LIMIT - 1)
        throw new WorkspaceChangeError(
          'WORKSPACE_RECOVERY_REQUIRED',
          'Recovery observation exceeded its page budget; no Project files were changed.',
        )
    }
    signal.throwIfAborted()
    for (const { record, intentIds } of records.values()) {
      this.repository.settleRecovery(record.id, intentIds, reason)
      await this.pruneSetWork(record, signal)
    }
    if (this.repository.hasRecoveryForRoot(reservation.root))
      throw new WorkspaceChangeError(
        'WORKSPACE_RECOVERY_REQUIRED',
        'This Project still has incomplete recovery evidence. Protected writes remain unavailable.',
      )
  }

  private async observe(
    reservation: WorkspaceReservation,
    path: string,
    signal: AbortSignal,
    linkedCandidatePath?: string,
    linkedCandidateVersion?: WorkspaceFileVersion,
  ): Promise<WorkspaceFileVersion> {
    const temporary = join(this.storageRoot, `directory-capture-${randomUUID()}`)
    buildValidatedDirectoryJobInput(
      this.liveDatabaseFile,
      reservation,
      path,
      'capture',
      temporary,
      linkedCandidatePath,
    )
    const releaseScratch = this.reserveScratch(WORKSPACE_FILE_BYTES, signal)
    try {
      const result = await this.directoryJob(
        reservation,
        path,
        'capture',
        signal,
        temporary,
        linkedCandidatePath,
      )
      const version = { hash: result.hash, bytes: result.bytes, mode: result.mode }
      if (result.existed) await verifyFileVersion(temporary, version, signal)
      if (linkedCandidatePath) {
        if (!linkedCandidateVersion || !versionsEqual(version, linkedCandidateVersion))
          throw new WorkspaceChangeError(
            'WORKSPACE_RECOVERY_REQUIRED',
            'The interrupted candidate changed before observation; all recovery evidence was retained.',
          )
        const candidate = await lstat(linkedCandidatePath, { bigint: true })
        if (
          candidate.dev.toString() !== result.device ||
          candidate.ino.toString() !== result.inode ||
          candidate.nlink !== 2n
        )
          throw new WorkspaceChangeError(
            'WORKSPACE_RECOVERY_REQUIRED',
            'The interrupted candidate identity changed during observation.',
          )
        // Only the intent-owned private alias is released. Saved immutable bytes and
        // the Project name/object remain intact; unrelated hard links are never allowed.
        await unlink(linkedCandidatePath)
        await syncDirectory(dirname(linkedCandidatePath))
      }
      return version
    } finally {
      try {
        await unlink(temporary).catch((error) => {
          if (!isEnoent(error)) throw error
        })
      } finally {
        releaseScratch()
      }
    }
  }
}
