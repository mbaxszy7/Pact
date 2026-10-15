/* oxlint-disable no-await-in-loop -- Snapshot buffers, whole-round preflight and directory writes are deliberately sequential to bound memory and preserve operation order. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  opendir,
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
  WORKSPACE_FILE_BYTES,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  WORKSPACE_ROUND_BYTES,
  WORKSPACE_STORAGE_BYTES,
  WORKSPACE_EVIDENCE_BYTES,
  WORKSPACE_PREVIEW_BYTES,
  workspaceFileVersionSchema,
  type AgentRun,
  type WorkspaceChangeFilePreview,
  type WorkspaceChangeFileReadInput,
  type WorkspaceChangeSet,
  type WorkspaceChangesPage,
  type WorkspaceChangesReadInput,
  type WorkspaceFileVersion,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts'
import {
  WorkspaceChangesRepository,
  type WorkspaceChangeIntent,
  type WorkspaceChangeSetRecord,
  type ProjectCatalogRepository,
  type SessionRepository,
} from '@pact/persistence'

import { workspaceGit } from './workspace-git'

const EMPTY: WorkspaceFileVersion = { hash: null, bytes: 0, mode: 0 }
const PREVIEW_BYTES = WORKSPACE_PREVIEW_BYTES
const TOOL_QUEUE_ITEMS = 4
const RECORDING_RUNS = 5
const UNDO_OPERATIONS = 5
const RECOVERY_PAGE_LIMIT = 1024
const RECOVERY_PATH_REFERENCES = 1024

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

interface WorkspaceRun {
  reservation: WorkspaceReservation
  run: AgentRun
  stagingRoot: string
  signal: AbortSignal
  unavailableReason?: string
  finalEndpointsUncertain?: boolean
  retainedHashes: Set<string>
  operations: Set<string>
  retainedBytes: number
  backupBytes: number
  queued: number
  queueBytes: number
  tail: Promise<void>
  closing: boolean
  stagingReady: boolean
}

interface ApplyFile {
  path: string
  before: WorkspaceFileVersion
  after: WorkspaceFileVersion
  stage: string | null
  backup: string
}

interface WorkspaceCleanupOwner {
  handle?: FileHandle
  reservation?: WorkspaceReservation
  cleanup?: Promise<void>
  cleanupFailed?: boolean
}

interface RecordingPreparation extends WorkspaceCleanupOwner {
  sessionId: string
  projectId: string
  attempt: Promise<string | undefined>
}

interface UndoOperation extends WorkspaceCleanupOwner {
  sessionId: string
  projectId: string
  controller: AbortController
  applicationStarted: boolean
  completed: Promise<void>
  complete: () => void
  fail: (error: unknown) => void
  releaseScratch?: () => void
}

/** Owns passive native evidence and cold whole-round Undo, never forward Agent writes. */
export class WorkspaceChanges {
  private readonly owners = new Map<string, WorkspaceReservation>()
  private readonly runs = new Map<string, WorkspaceRun>()
  // At most five preparations and five Undo operations; no native execution is queued.
  private readonly preparingRuns = new Map<string, RecordingPreparation>()
  private readonly undoOperations = new Map<string, UndoOperation>()
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
    private readonly directoryOperation?: (
      input: DirectoryFileOperationInput,
      signal: AbortSignal,
    ) => Promise<DirectoryFileOperationResult>,
    private readonly liveDatabaseFile?: string,
  ) {}

  async initialize(): Promise<WorkspaceChangeSet[]> {
    await mkdir(join(this.storageRoot, 'objects'), { recursive: true, mode: 0o700 })
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(new Error('Workspace recovery timed out.')),
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    try {
      await this.pruneCaptures(controller.signal)
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
      const key = this.key(root)
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
    return (
      this.repository.find(runId) !== undefined &&
      (this.repository.summary(runId).fileCount > 0 ||
        Boolean(this.repository.summary(runId).undoUnavailableReason) ||
        Boolean(this.repository.summary(runId).effectsUncertain))
    )
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
    if (
      bytes > WORKSPACE_EVIDENCE_BYTES ||
      context.queued >= TOOL_QUEUE_ITEMS ||
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
    const operation = context.tail.then(async () => {
      controller.signal.throwIfAborted()
      if (change.invalidateOnly) {
        this.recordUnavailableFile(context, change)
        return undefined
      }
      await this.ensureStaging(context)
      this.ensureRecord(context)
      const path = this.safeRelative(
        isAbsolute(change.path)
          ? relative(context.reservation.root, change.path).split(sep).join('/')
          : change.path,
      )
      const old = this.repository.file(runId, path)
      if (this.repository.files(runId).length >= WORKSPACE_CHANGE_FILES && !old)
        throw new Error('This round exceeded the native file recording limit.')
      const current = await this.observe(context.reservation, path, controller.signal)
      const mode = current.hash ? current.mode : 0o644
      const beforeAvailable = change.before !== undefined
      let afterAvailable = change.after !== undefined
      const before = beforeAvailable
        ? await this.saveText(context, change.before!, mode, controller.signal)
        : EMPTY
      let after = afterAvailable
        ? await this.saveText(context, change.after!, mode, controller.signal)
        : EMPTY
      if (beforeAvailable && !afterAvailable && change.patch && !change.previousPath) {
        // A complete native before + operation patch is sufficient to derive its after,
        // without reading the current file as historical truth. Git owns the algorithm.
        after = await this.nativePatchedVersion(
          context,
          path,
          before,
          change.patch,
          mode,
          controller.signal,
        )
        afterAvailable = true
      }
      let reason =
        change.unavailableReason ??
        (change.mixed
          ? 'The native result includes simultaneous user edits; Undo is unavailable.'
          : undefined)
      // Native results prove text, not historical modes. Existing-file text Undo
      // preserves independently observed current metadata; path changes need more proof.
      if (beforeAvailable && afterAvailable && (!before.hash || !after.hash || change.previousPath))
        reason ??=
          'Native file results do not include complete path and filesystem metadata for safe Undo of additions, deletions or renames.'
      if (
        change.patch &&
        /^(?:old mode |new mode |new file mode |deleted file mode |GIT binary patch|Binary files )/mu.test(
          change.patch,
        )
      )
        reason ??=
          'Native mode or binary patch metadata needs complete original evidence. Undo is unavailable.'
      if (afterAvailable && !this.equal(current, after))
        reason ??=
          'The file changed outside the recorded native operation. Undo is unavailable for this mixed round.'
      if (
        old &&
        old.afterAvailable !== false &&
        beforeAvailable &&
        (old.modeKnown === false
          ? old.after.hash !== before.hash || old.after.bytes !== before.bytes
          : !this.equal(old.after, before))
      )
        reason ??= 'Native file versions do not form one continuous round. Undo is unavailable.'
      if (change.previousPath)
        reason ??=
          'Native rename evidence does not include complete path metadata; Undo is unavailable.'
      const patchVersions = change.patch
        ? [await this.saveText(context, change.patch, 0o600, controller.signal)]
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
          ? await this.statistics(
              old?.before ?? before,
              after,
              context.stagingRoot,
              controller.signal,
            )
          : { additions: null, deletions: null }
      this.repository.recordFiles(
        runId,
        [
          {
            path,
            previousPath: change.previousPath ?? null,
            kind: change.kind,
            before,
            after,
            beforeAvailable,
            afterAvailable,
            modeKnown: false,
            undoStrategy: strategy,
            ...(patchVersions ? { patchVersions } : {}),
            ...stats,
            hidden: false,
            reason: reason ?? null,
          },
        ],
        reason ?? context.unavailableReason,
      )
      return undefined
    })
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
      const path = this.safeRelative(
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
              before: EMPTY,
              after: EMPTY,
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
    if (text === null) return EMPTY
    if (Buffer.byteLength(text) > WORKSPACE_FILE_BYTES)
      throw new Error('Native file evidence exceeds the complete-version limit.')
    const temporary = join(context.stagingRoot, `native-${randomUUID()}`)
    try {
      await this.writeDurable(temporary, Buffer.from(text))
      return await this.captureStaged(temporary, mode, context, signal)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async nativePatchedVersion(
    context: WorkspaceRun,
    path: string,
    before: WorkspaceFileVersion,
    patch: string,
    mode: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    const tree = join(context.stagingRoot, `native-patch-${randomUUID()}`)
    const candidate = join(tree, path)
    const patchFile = join(context.stagingRoot, `native-patch-input-${randomUUID()}`)
    try {
      await mkdir(dirname(candidate), { recursive: true, mode: 0o700 })
      if (before.hash) await this.copyVersion(before, candidate, signal)
      await this.writeDurable(patchFile, Buffer.from(patch))
      const summary = await workspaceGit(
        ['apply', '--numstat', '-z', '--', patchFile],
        tree,
        signal,
      )
      const entries = summary.output.split('\0').filter(Boolean)
      if (
        summary.code !== 0 ||
        entries.length !== 1 ||
        entries[0]!.split('\t').slice(2).join('\t') !== path
      )
        throw new Error('The native patch does not describe exactly its recorded file.')
      const check = await workspaceGit(['apply', '--check', '--', patchFile], tree, signal)
      if (check.code !== 0)
        throw new Error('The native patch does not apply to its original version.')
      const applied = await workspaceGit(['apply', '--', patchFile], tree, signal)
      if (applied.code !== 0) throw new Error('Git could not derive the complete native version.')
      return await this.captureStaged(candidate, mode, context, signal)
    } finally {
      await unlink(patchFile).catch(() => undefined)
      await rm(tree, { recursive: true, force: true })
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

  hasPendingFinalization(scope: import('@pact/contracts').WorkspaceArchiveScope): boolean {
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

  async awaitFinalization(scope: import('@pact/contracts').WorkspaceArchiveScope): Promise<void> {
    await Promise.all(this.scopeFinalizations(scope))
  }

  private scopeFinalizations(
    scope: import('@pact/contracts').WorkspaceArchiveScope,
  ): Promise<unknown>[] {
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
          if (this.repository.summary(runId).state === 'recovery_required') break
          try {
            const current = await this.observe(context.reservation, file.path, controller.signal)
            if (
              file.afterAvailable !== false &&
              (file.modeKnown === false
                ? current.hash !== file.after.hash || current.bytes !== file.after.bytes
                : !this.equal(current, file.after))
            )
              this.repository.recordFiles(
                runId,
                [],
                `The file ${file.path} changed while the Agent Run was active. Undo is unavailable for this mixed round.`,
              )
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
          this.blobPath(version.hash),
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
    if (bytes.length !== version.bytes || (version.hash && this.hash(bytes) !== version.hash))
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
      contentHash: version.hash ?? this.hash(bytes),
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
    projectBusy: (projectId: string) => boolean = () => false,
  ): Promise<WorkspaceChangeSet> {
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
    if (changeSet.state !== 'ready' || changeSet.undoUnavailableReason)
      throw new WorkspaceChangeError(
        'WORKSPACE_UNDO_UNAVAILABLE',
        changeSet.undoUnavailableReason ?? 'This round cannot be undone again.',
      )
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
      if (latest.state !== 'ready' || latest.undoUnavailableReason)
        throw new WorkspaceChangeError(
          'WORKSPACE_UNDO_UNAVAILABLE',
          latest.undoUnavailableReason ?? 'This round is no longer available for Undo.',
        )
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
      operation.releaseScratch = this.reserveScratch(
        WORKSPACE_ROUND_BYTES + WORKSPACE_FILE_BYTES,
        controller.signal,
      )
      await mkdir(work, { mode: 0o700 })
      const staging = await stat(work, { bigint: true })
      if (staging.dev.toString() !== reservation.rootDevice)
        throw new WorkspaceChangeError(
          'WORKSPACE_UNDO_UNAVAILABLE',
          'The Project and protected storage are on different volumes. Saved changes remain readable, but Undo is unavailable. No Project files were changed.',
        )
      const prepared: ApplyFile[] = []
      const conflicts: string[] = []
      let candidateBytes = 0
      let backupBytes = 0
      const retained = this.roundVersions(id)
      for (const file of this.repository.files(id)) {
        controller.signal.throwIfAborted()
        try {
          const current = await this.capture(
            reservation.root,
            file.path,
            undefined,
            controller.signal,
            reservation,
          )
          let desired = file.before
          const textOnly = file.modeKnown === false
          if (textOnly) {
            if (!current.hash || !file.before.hash || !file.after.hash || file.previousPath)
              throw new Error('Path metadata is unavailable for Undo.')
            desired = { ...file.before, mode: current.mode }
          }
          if (
            file.undoStrategy === 'unavailable' ||
            file.undoStrategy === 'patch' ||
            file.beforeAvailable === false ||
            file.afterAvailable === false
          )
            throw new Error('Complete original and final native file versions are unavailable.')
          if (
            textOnly
              ? current.hash !== file.after.hash || current.bytes !== file.after.bytes
              : !this.equal(current, file.after)
          ) {
            if (
              !current.hash ||
              !file.before.hash ||
              !file.after.hash ||
              (!textOnly && current.mode !== file.after.mode) ||
              (!textOnly && file.before.mode !== file.after.mode) ||
              file.previousPath
            )
              throw new Error('Path, type or metadata conflict.')
            for (const version of [current, file.before, file.after])
              await this.verifyVersion(this.blobPath(version.hash!), version, controller.signal)
            if (
              !(await this.textual(current, controller.signal)) ||
              !(await this.textual(file.before, controller.signal)) ||
              !(await this.textual(file.after, controller.signal))
            )
              throw new Error('Binary conflict.')
            const merged = join(work, `merged-${prepared.length}`)
            const result = await workspaceGit(
              [
                'merge-file',
                '-p',
                this.blobPath(current.hash),
                this.blobPath(file.after.hash),
                this.blobPath(file.before.hash),
              ],
              work,
              controller.signal,
              merged,
            )
            if (result.code !== 0) throw new Error('Text conflict.')
            desired = await this.captureStaged(
              merged,
              textOnly ? current.mode : file.before.mode,
              undefined,
              controller.signal,
            )
            await unlink(merged)
          }
          candidateBytes += desired.bytes
          backupBytes += current.bytes
          for (const version of [current, desired]) {
            if (version.hash && !retained.hashes.has(version.hash)) {
              retained.hashes.add(version.hash)
              retained.bytes += version.bytes
            }
          }
          if (
            candidateBytes + backupBytes > WORKSPACE_ROUND_BYTES ||
            retained.bytes + backupBytes > WORKSPACE_ROUND_BYTES
          )
            throw new WorkspaceChangeError(
              'VALIDATION',
              'Undo candidates exceed the round temporary-storage budget.',
            )
          const stage = desired.hash ? join(work, `candidate-${prepared.length}`) : null
          if (stage) {
            await this.copyVersion(desired, stage, controller.signal)
          }
          prepared.push({
            path: file.path,
            before: current,
            after: desired,
            stage,
            backup: join(work, `original-${prepared.length}`),
          })
        } catch (error) {
          if (controller.signal.aborted) throw error
          conflicts.push(file.path)
        }
      }
      // Nothing above this line creates/removes/replaces any Project file.
      if (conflicts.length)
        throw new WorkspaceChangeError(
          'WORKSPACE_CONFLICT',
          `Undo was refused for the entire round. No files were changed. Conflicts: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''}`,
        )
      for (const file of prepared) {
        const current = await this.observe(reservation, file.path, controller.signal)
        if (!this.equal(current, file.before))
          throw new WorkspaceChangeError(
            'WORKSPACE_CONFLICT',
            `Undo was refused because ${file.path} changed during checking. No files were changed.`,
          )
      }
      controller.signal.throwIfAborted()
      requireIdle()
      intentId = randomUUID()
      this.repository.intent({
        id: intentId,
        changeSetId: id,
        kind: 'undo',
        payload: { root: reservation.root, files: prepared },
        retainedBytes: prepared.reduce((sum, file) => sum + file.before.bytes, 0),
      })
      try {
        await this.apply(reservation, prepared, controller.signal, intentId, operation, requireIdle)
        return this.repository.completeUndo(intentId, id)
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

  private async apply(
    reservation: WorkspaceReservation,
    files: ApplyFile[],
    signal: AbortSignal,
    intentId: string,
    operation: UndoOperation,
    requireIdle: () => void,
  ): Promise<void> {
    let actualBackupBytes = 0
    for (const file of files) {
      signal.throwIfAborted()
      requireIdle()
      if (file.before.hash) {
        let stashFailure: { error: unknown } | undefined
        try {
          operation.applicationStarted = true
          await this.directoryJob(reservation, file.path, 'stash', signal, file.backup)
        } catch (error) {
          stashFailure = { error }
        }
        const saved = await lstat(file.backup).catch((error) => {
          if (this.missing(error)) return undefined
          throw error
        })
        if (saved) actualBackupBytes += saved.size
        const intent = this.repository.findIntent(intentId)!
        const remainingEstimate = files
          .slice(files.indexOf(file) + 1)
          .reduce((sum, later) => sum + later.before.bytes, 0)
        const retainedBytes = Math.max(intent.retainedBytes, actualBackupBytes + remainingEstimate)
        this.repository.intent({ ...intent, retainedBytes })
        if (stashFailure) throw stashFailure.error
        const actual = await this.captureStaged(file.backup, undefined, undefined, signal)
        if (!this.equal(actual, file.before))
          throw new Error(
            'A source changed after Undo preflight; its actual object was preserved. Undo did not complete.',
          )
      }
    }
    for (const file of files) {
      signal.throwIfAborted()
      if (file.stage) {
        requireIdle()
        // Creating a hard link is exclusive: EEXIST preserves any external file that appeared.
        operation.applicationStarted = true
        await this.directoryJob(reservation, file.path, 'install', signal, file.stage)
        await unlink(file.stage)
      } else {
        await this.directoryJob(reservation, file.path, 'absent', signal)
      }
    }
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
    const releaseScratch = this.reserveScratch(WORKSPACE_FILE_BYTES, signal)
    const temporary = join(this.storageRoot, `directory-capture-${randomUUID()}`)
    try {
      const result = await this.directoryJob(authority, path, 'capture', signal, temporary)
      if (!result.existed) return EMPTY
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
          if (!this.missing(error)) throw error
        })
      } finally {
        releaseScratch()
      }
    }
  }

  private async directoryJob(
    reservation: WorkspaceReservation,
    rawPath: string,
    operation: DirectoryFileOperationInput['operation'],
    signal: AbortSignal,
    auxiliaryPath?: string,
    linkedCandidatePath?: string,
  ) {
    if (!this.directoryOperation)
      throw new WorkspaceChangeError(
        'PERMISSION_DENIED',
        'Protected directory operations are unavailable; no Project file will be changed.',
      )
    signal.throwIfAborted()
    const relativePath = this.safeRelative(rawPath)
    if (this.liveDatabaseFile) {
      const target = this.key(join(reservation.root, relativePath))
      if (
        ['', '-wal', '-shm', '-journal'].some(
          (suffix) => target === this.key(`${this.liveDatabaseFile}${suffix}`),
        )
      )
        throw new WorkspaceChangeError(
          'PERMISSION_DENIED',
          'Pact’s live database and journal files are not Project-editing targets.',
        )
    }
    const parts = relativePath.split('/')
    const result = await this.directoryOperation(
      {
        operation,
        rootPath: reservation.root,
        rootDevice: reservation.rootDevice,
        rootInode: reservation.rootInode,
        directories: parts.slice(0, -1),
        name: parts.at(-1)!,
        ...(auxiliaryPath ? { auxiliaryPath } : {}),
        ...(linkedCandidatePath ? { linkedCandidatePath } : {}),
        maximumBytes: WORKSPACE_FILE_BYTES,
      },
      signal,
    )
    if (!result.ok) throw new WorkspaceChangeError('VALIDATION', result.message)
    return result
  }

  private async captureStaged(
    path: string,
    mode: number | undefined,
    context: WorkspaceRun | undefined,
    signal: AbortSignal,
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
      context.retainedBytes + context.backupBytes + metadata.size > WORKSPACE_ROUND_BYTES
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
      await this.verifyVersion(temporary, { hash: digest, bytes: total, mode: 0 }, signal)
      const stored = this.blobPath(digest)
      await mkdir(dirname(stored), { recursive: true, mode: 0o700 })
      // Admission precedes the persistent link: an abort cannot leave an uncharged blob.
      // A failed private installation may leave conservatively charged metadata; no caller
      // receives the version until the named object passes its integrity check below.
      this.repository.recordBlob(digest, total)
      try {
        await link(temporary, stored)
        await chmod(stored, 0o400)
        await this.syncDirectory(dirname(stored))
      } catch (error) {
        if (!this.exists(error)) throw error
      }
      await this.verifyVersion(stored, { hash: digest, bytes: total, mode: 0 }, signal)
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
          if (!this.missing(error)) throw error
        })
      } finally {
        this.pendingBlobBytes -= metadata.size
        releaseScratch()
      }
    }
  }

  private async statistics(
    before: WorkspaceFileVersion,
    after: WorkspaceFileVersion,
    work: string,
    signal: AbortSignal,
  ): Promise<{ additions: number | null; deletions: number | null }> {
    const empty = join(work, 'empty')
    await this.writeDurable(empty, Buffer.alloc(0), true)
    const result = await workspaceGit(
      [
        'diff',
        '--no-index',
        '--numstat',
        '-z',
        '--',
        before.hash ? this.blobPath(before.hash) : empty,
        after.hash ? this.blobPath(after.hash) : empty,
      ],
      work,
      signal,
    )
    if (result.code > 1)
      throw new WorkspaceChangeError('VALIDATION', 'Git could not inspect the saved change.')
    if (!result.output) return { additions: 0, deletions: 0 }
    const [added, removed] = result.output.split('\t')
    return {
      additions: added === '-' ? null : Number(added),
      deletions: removed === '-' ? null : Number(removed),
    }
  }

  private async textual(version: WorkspaceFileVersion, signal: AbortSignal): Promise<boolean> {
    if (!version.hash) return false
    const handle = await open(this.blobPath(version.hash), 'r')
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
    await this.syncDirectory(dirname(context.stagingRoot))
    context.stagingReady = true
  }

  private safeRelative(path: string): string {
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

  private validateSet(id: string) {
    const changeSet = this.repository.find(id)
    const session = changeSet ? this.sessions.find(changeSet.sessionId) : undefined
    if (!changeSet || !session || session.status === 'archived')
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

  private async pruneWork(work: string, keep: Set<string>): Promise<void> {
    const entries = await readdir(work).catch(() => [])
    for (const name of entries) {
      if (keep.has(name)) continue
      await rm(join(work, name), { recursive: true, force: true })
    }
    if (!keep.size) await rm(work, { recursive: true, force: true })
  }

  private intentFiles(intent: WorkspaceChangeIntent): ApplyFile[] {
    const raw = intent.payload['files']
    if (!Array.isArray(raw) || raw.length > WORKSPACE_CHANGE_FILES)
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
        path: this.safeRelative(path),
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
        (intent.kind !== 'undo' || this.repository.find(intent.changeSetId)?.state === 'undone')
      for (const file of this.intentFiles(intent)) {
        for (const path of [
          file.backup,
          ...(applicationConfirmed || !file.stage ? [] : [file.stage]),
        ]) {
          if (dirname(path) !== work)
            throw new Error('A saved private file escaped its operation directory.')
          const saved = await lstat(path).catch((error) => {
            if (this.missing(error)) return undefined
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
    await this.pruneWork(work, keep)
    if (intent && retainedBytes > intent.retainedBytes)
      this.repository.intent({ ...intent, retainedBytes })
  }

  private async pruneSetWork(record: WorkspaceChangeSetRecord, signal: AbortSignal): Promise<void> {
    const intents = this.repository.intents(record.id)
    const byWork = new Map(
      intents.map((intent) => [dirname(this.intentFiles(intent)[0]?.backup ?? ''), intent.id]),
    )
    const entries = await readdir(record.stagingRoot).catch((error) => {
      if (this.missing(error)) return []
      throw error
    })
    if (entries.length > RECOVERY_PATH_REFERENCES + 1)
      throw new Error('Workspace temporary directories exceed their round limit.')
    for (const name of entries) {
      signal.throwIfAborted()
      if (!/^(operation|undo)-[a-f\d-]{36}$/u.test(name)) continue
      const work = join(record.stagingRoot, name)
      await this.pruneIntentWork(work, byWork.get(work))
    }
  }

  private async pruneCaptures(signal: AbortSignal): Promise<void> {
    const directory = await opendir(this.storageRoot)
    let count = 0
    try {
      for await (const entry of directory) {
        signal.throwIfAborted()
        count += 1
        if (count > 4096) throw new Error('Workspace capture cleanup exceeded its entry budget.')
        if (entry.isFile() && /^(directory-capture|capture)-[a-f\d-]{36}$/u.test(entry.name))
          await unlink(join(this.storageRoot, entry.name))
      }
    } finally {
      await directory.close().catch(() => undefined)
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

  private async copyVersion(
    version: WorkspaceFileVersion,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!version.hash) throw new Error('An absent version cannot be copied.')
    signal.throwIfAborted()
    await copyFile(this.blobPath(version.hash), destination, constants.COPYFILE_EXCL)
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
        await this.verifyVersion(destination, version, signal, true)
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
      await chmod(destination, version.mode)
      await this.verifyVersion(destination, version, signal, true)
      const handle = await open(destination, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await this.syncDirectory(dirname(destination))
  }

  private async verifyVersion(
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
              if (this.missing(error)) return undefined
              throw error
            })
            if (staged?.nlink === 2) {
              await this.verifyVersion(file.stage, file.after, signal, true)
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
          if (!this.equal(current, file.before) && !this.equal(current, file.after))
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
    const releaseScratch = this.reserveScratch(WORKSPACE_FILE_BYTES, signal)
    const temporary = join(this.storageRoot, `directory-capture-${randomUUID()}`)
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
      if (result.existed) await this.verifyVersion(temporary, version, signal)
      if (linkedCandidatePath) {
        if (!linkedCandidateVersion || !this.equal(version, linkedCandidateVersion))
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
        await this.syncDirectory(dirname(linkedCandidatePath))
      }
      return version
    } finally {
      try {
        await unlink(temporary).catch((error) => {
          if (!this.missing(error)) throw error
        })
      } finally {
        releaseScratch()
      }
    }
  }

  private async writeDurable(path: string, bytes: Buffer, allowExisting = false): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'wx', 0o600)
    } catch (error) {
      if (allowExisting && this.exists(error)) return
      throw error
    }
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.syncDirectory(dirname(path))
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return
    const directory = await open(path, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  private blobPath(hash: string): string {
    if (!/^[a-f\d]{64}$/u.test(hash))
      throw new WorkspaceChangeError('VALIDATION', 'Invalid saved file reference.')
    return join(this.storageRoot, 'objects', hash.slice(0, 2), hash)
  }
  private hash(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex')
  }
  private key(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  private equal(a: WorkspaceFileVersion, b: WorkspaceFileVersion): boolean {
    return a.hash === b.hash && a.bytes === b.bytes && a.mode === b.mode
  }
  private missing(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT')
  }
  private exists(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'EEXIST')
  }
}
