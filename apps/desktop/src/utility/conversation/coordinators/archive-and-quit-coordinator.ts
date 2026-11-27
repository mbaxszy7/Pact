import { randomUUID } from 'node:crypto'
import { setImmediate as yieldImmediate } from 'node:timers/promises'

import type { AgentAdapter } from '@pact/agent-runtime'
import type {
  ConversationPatch,
  NativeAttentionPage,
  NativeAttentionReadInput,
  NativePresenceSnapshot,
  NativePresenceVersion,
  NativeQuitOperationInput,
  NativeQuitPreparation,
  NativeQuitSessionRow,
  NativeSessionRow,
  RpcResult,
  WorkspaceArchivePrepareInput,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
  WorkspaceArchiveTask,
} from '@pact/contracts'

import {
  NATIVE_QUIT_PREPARATION_MS,
  WORKSPACE_ARCHIVE_PREVIEW_MS,
  WORKSPACE_ARCHIVE_STOP_MS,
  WORKSPACE_ARCHIVE_TASK_LIMIT,
} from '@pact/contracts'
import { WorkspaceArchiveConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { NativeObservation } from '../conversation-types'

import { AgyAgentAdapter } from '../agy-agent-adapter'
import { disposeDefaultAgySkillProbes } from '../native-skill-catalog'

export class ArchiveAndQuitCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  sessionTitleChanged(sessionId: string): void {
    this.core.interactions.scheduleNativeTitleSync(sessionId)
  }

  subscribeNativePresence(listener: (version: NativePresenceVersion) => void): () => void {
    if (this.core.nativeListeners.size >= 1)
      throw new Error('Native metadata already has its Utility subscriber.')
    this.core.nativeListeners.add(listener)
    return () => {
      this.core.nativeListeners.delete(listener)
    }
  }

  nativeMetadataChanged(): void {
    if (this.core.disposed) return
    this.core.nativeRevision += 1
    const version = this.nativePresenceVersion()
    for (const listener of this.core.nativeListeners) listener(version)
  }

  nativePresenceVersion(): NativePresenceVersion {
    return { incarnation: this.core.nativeIncarnation, revision: this.core.nativeRevision }
  }

  initializeNativePresence(): Promise<void> {
    this.core.nativeInitialization ??= (async () => {
      if (this.core.sessions.nativeInitialized()) return
      let after: string | undefined
      while (!this.core.disposed) {
        const ids = this.core.sessions.nativeInitializationPage(after)
        if (!ids.length) {
          this.core.sessions.finishNativeInitialization()
          this.nativeMetadataChanged()
          return
        }
        this.core.conversations.initializeNativeAttention(ids)
        after = ids.at(-1)
        // oxlint-disable-next-line no-await-in-loop -- Initial migration projects at most 25 metadata rows before yielding; later restarts never scan the Catalog.
        await yieldImmediate()
      }
    })()
    return this.core.nativeInitialization
  }

  liveNativeRows(): { running: NativeSessionRow[]; attention: NativeSessionRow[] } {
    const states = new Map<string, NativeSessionRow['state']>()
    const add = (id: string, state: NativeSessionRow['state']): void => {
      if (!states.has(id) || state === 'recovering') states.set(id, state)
    }
    const referenced = new Set<AgentAdapter>()
    for (const owner of this.core.activeExecutions.values())
      if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.core.nativeRebuilds.values())
      if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.core.nativeChecks.values())
      if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.core.nativeForks.values())
      for (const adapter of owner.activeAdapters ?? []) referenced.add(adapter)
    const cached = new Set([...this.core.adapters.values()].map((entry) => entry.adapter))
    if ([...referenced].some((adapter) => !cached.has(adapter)))
      throw new Error('An active native Adapter is absent from its physical owner.')
    for (const entry of this.core.adapters.values()) {
      if (!referenced.has(entry.adapter) && !entry.adapter.hasActiveBackgroundWork?.()) continue
      const recovering =
        [...this.core.nativeRebuilds.values()].some((owner) => owner.adapter === entry.adapter) ||
        [...this.core.nativeChecks.values()].some((owner) => owner.adapter === entry.adapter) ||
        [...this.core.nativeForks.values()].some((owner) =>
          owner.activeAdapters?.has(entry.adapter),
        ) ||
        [...this.core.activeExecutions.values()].some(
          (owner) =>
            owner.adapter === entry.adapter &&
            this.core.conversations.nativeRunStatus(owner.run.id) === 'recovering',
        )
      add(entry.sessionId, recovering ? 'recovering' : 'running')
    }
    const attention = new Map<string, NativeSessionRow>()
    for (const pending of this.core.permissions.values()) {
      if (!this.core.interactions.interactionCurrent(pending)) continue
      const row = this.core.sessions.findNativeRow(pending.sessionId)
      if (!row) continue
      const prior = attention.get(row.sessionId)
      if (!prior || pending.request.kind === 'approval')
        attention.set(row.sessionId, {
          ...row,
          state:
            pending.request.kind === 'approval' || pending.request.kind === undefined
              ? 'approval'
              : 'input',
        })
    }
    if (attention.size > 8 || states.size > 5)
      throw new Error('Native owner metadata exceeds its item budget.')
    const running = [...states].flatMap(([id, state]) => {
      const row = this.core.sessions.findNativeRow(id)
      return row ? [{ ...row, state }] : []
    })
    return { running, attention: [...attention.values()] }
  }

  getNativePresence(): RpcResult<NativePresenceSnapshot> {
    if (!this.core.sessions.nativeInitialized())
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Session metadata is starting.' },
      }
    try {
      const live = this.liveNativeRows()
      const liveIds = new Set(live.attention.map((row) => row.sessionId))
      const durable = this.core.sessions
        .nativeAttention()
        .filter((item) => !liveIds.has(item.row.sessionId))
      const attention = [...live.attention, ...durable.map((item) => item.row)].slice(0, 5)
      const attentionIds = new Set(attention.map((row) => row.sessionId))
      const running = live.running.filter(
        (row) => !attentionIds.has(row.sessionId) && !liveIds.has(row.sessionId),
      )
      const grouped = new Set([
        ...liveIds,
        ...attentionIds,
        ...live.running.map((row) => row.sessionId),
      ])
      const recent = this.core.sessions
        .nativeRecent()
        .filter((row) => !grouped.has(row.sessionId))
        .slice(0, 5)
        .map((row) => {
          if (this.core.gate.nativeLogicalPreparation(row.sessionId)) row.state = 'preparing'
          return row
        })
      const attentionTotal =
        this.core.sessions.nativeAttentionTotal() +
        live.attention.filter((row) => !this.core.sessions.nativeNeedsAttention(row.sessionId))
          .length
      return {
        ok: true,
        value: {
          version: this.nativePresenceVersion(),
          running,
          attention,
          recent,
          attentionTotal,
        },
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Native Session metadata could not be loaded.' },
      }
    }
  }

  readNativeAttention(input: NativeAttentionReadInput): RpcResult<NativeAttentionPage> {
    if (!this.core.sessions.nativeInitialized())
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Session metadata is starting.' },
      }
    const version = this.nativePresenceVersion()
    if (
      input.cursor &&
      (input.cursor.incarnation !== version.incarnation ||
        input.cursor.revision !== version.revision)
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Session attention changed. Reload its first page.' },
      }
    try {
      const live = this.liveNativeRows().attention
      const liveIds = new Set(live.map((row) => row.sessionId))
      let liveOffset = input.cursor?.liveOffset ?? 0
      const rows = live.slice(liveOffset, liveOffset + 5)
      liveOffset += rows.length
      let after = input.cursor?.after
      const candidates = this.core.sessions.nativeAttention(after)
      for (const item of candidates) {
        if (rows.length === 5) break
        after = { ordinal: item.ordinal, id: item.row.sessionId }
        if (!liveIds.has(item.row.sessionId)) rows.push(item.row)
      }
      const remainingDurable = candidates.some(
        (item) =>
          !liveIds.has(item.row.sessionId) &&
          !rows.some((row) => row.sessionId === item.row.sessionId) &&
          (!after ||
            item.ordinal < after.ordinal ||
            (item.ordinal === after.ordinal && item.row.sessionId < after.id)),
      )
      const total =
        this.core.sessions.nativeAttentionTotal() +
        live.filter((row) => !this.core.sessions.nativeNeedsAttention(row.sessionId)).length
      return {
        ok: true,
        value: {
          version,
          sessions: rows,
          total,
          ...(liveOffset < live.length || remainingDurable
            ? { nextCursor: { ...version, liveOffset, ...(after ? { after } : {}) } }
            : {}),
        },
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Sessions needing attention could not be loaded.' },
      }
    }
  }

  prepareNativeQuit(
    input: NativeQuitOperationInput,
    otherPreparationActive = false,
  ): RpcResult<NativeQuitPreparation> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.nativeQuitPreparation?.operationId === input.operationId)
      return this.core.nativeQuitPreparation.expired
        ? this.core.quitPrepared()
        : this.core.nativeQuitPreparation.result
    if (this.core.nativeQuitPreparation?.sealed) return this.core.quitPrepared()
    clearTimeout(this.core.nativeQuitPreparation?.timer)
    // Even a failed metadata query must leave this accepted operation
    // cancellable. Keep the failure itself, never an invented idle result.
    const quitOwner = {
      operationId: input.operationId,
      result: {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Running work could not be confirmed. Review before exiting.',
        },
      } as RpcResult<NativeQuitPreparation>,
      sealed: false,
      expired: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.core.nativeQuitPreparation = quitOwner
    quitOwner.timer = setTimeout(() => {
      if (this.core.nativeQuitPreparation === quitOwner) {
        quitOwner.sealed = false
        quitOwner.expired = true
        this.core.collaboration.schedulePendingRoutedContinuations()
      }
    }, NATIVE_QUIT_PREPARATION_MS)
    quitOwner.timer.unref()
    try {
      const rows = this.liveNativeRows()
      const identities = new Set([...rows.running, ...rows.attention].map((row) => row.sessionId))
      for (const sessionId of this.core.scheduling.decisionSessionIds()) identities.add(sessionId)
      for (const owner of this.core.preparingSends.values()) identities.add(owner.input.sessionId)
      for (const owner of this.core.preparingContinuations.values()) identities.add(owner.sessionId)
      for (const sessionId of this.core.routingOpenInputs.keys()) identities.add(sessionId)
      for (const id of this.core.nativeRebuilds.keys()) identities.add(id)
      for (const key of this.core.nativeChecks.keys()) identities.add(key.split(':')[0]!)
      for (const id of this.core.forkPreparations.keys()) identities.add(id)
      for (const owner of this.core.nativeForks.values())
        identities.add(owner.sessionId ?? owner.sourceSessionId)
      for (const id of this.core.workspaceChanges?.pendingSessionIds() ?? []) identities.add(id)
      for (const id of this.core.titleEnrichments.keys()) identities.add(id)
      for (const id of this.core.nativeTitleSyncs.keys()) identities.add(id)
      for (const owner of this.core.skillDiscoveries.values()) identities.add(owner.sessionId)
      for (const owner of this.core.conversations.pendingRoutedContinuations())
        identities.add(owner.sessionId)
      for (const owner of this.core.conversations.pendingCollaborationInputs())
        identities.add(owner.sessionId)
      const unsettled = this.core.conversations.nativeQuitUnsettled([...identities])
      const activeCount =
        identities.size +
        unsettled.count +
        Number(
          this.core.decisionRuntime?.sessionId === null ||
            this.core.decisionRecoveryOwner?.sessionId === null ||
            this.core.conversations.activeSchedulingRuntimeOwner()?.sessionId === null,
        ) +
        Number(otherPreparationActive && identities.size === 0 && unsettled.count === 0)
      const listed = [...new Set([...identities, ...unsettled.sessionIds])]
        .slice(0, 5)
        .flatMap<NativeQuitSessionRow>((id) => {
          const row = this.core.sessions.findNativeRow(id)
          return row
            ? [
                {
                  ...row,
                  state:
                    rows.attention.find((item) => item.sessionId === id)?.state ??
                    rows.running.find((item) => item.sessionId === id)?.state ??
                    (this.core.gate.nativeLogicalPreparation(id) ? 'preparing' : 'unsettled'),
                },
              ]
            : []
        })
      const result: NativeQuitPreparation = {
        operationId: input.operationId,
        state: activeCount ? 'confirmation_required' : 'idle_prepared',
        activeCount,
        sessions: listed,
      }
      quitOwner.result = { ok: true, value: result }
      quitOwner.sealed = activeCount === 0
    } catch {
      // The bounded owner retains the uncertain result for cancellation/readback.
    }
    return quitOwner.result
  }

  cancelNativeQuit(
    input: NativeQuitOperationInput,
  ): RpcResult<{ operationId: string; cancelled: true }> {
    const owner = this.core.nativeQuitPreparation
    if (!owner || owner.operationId !== input.operationId)
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This exit preparation is no longer current.' },
      }
    clearTimeout(owner.timer)
    owner.sealed = false
    owner.expired = true
    this.core.collaboration.schedulePendingRoutedContinuations()
    return { ok: true, value: { operationId: input.operationId, cancelled: true } }
  }

  prepareWorkspaceArchive(input: WorkspaceArchivePrepareInput): RpcResult<WorkspaceArchivePreview> {
    if (this.core.disposed) return this.core.shuttingDown()
    try {
      // A fresh user request may inspect old receipts; it never repeats their Stop or commit.
      for (const operationId of this.core.conversations.archives.unresolvedOperations(input.scope))
        this.readWorkspaceArchive(operationId)
      const context = this.core.conversations.archives.context(input.scope)
      const work = this.archiveWork(input.scope)
      const terminals =
        input.scope.kind === 'project'
          ? (this.core.terminalCoordinator?.listBlockingProjectSummaries(input.scope.projectId) ??
            [])
          : []
      return {
        ok: true,
        value: this.core.conversations.archives.prepare(
          {
            operationId: input.operationId,
            scope: input.scope,
            ...context,
            tasks: work.tasks,
            ...(terminals.length > 0 ? { terminals } : {}),
            ...(work.blockedReason ? { blockedReason: work.blockedReason } : {}),
            expiresAt: new Date(Date.now() + WORKSPACE_ARCHIVE_PREVIEW_MS).toISOString(),
          },
          this.core.archiveOwnerId,
        ),
      }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  readWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    try {
      const receipt = this.core.conversations.archives.read(operationId)
      if (!receipt)
        throw new WorkspaceArchiveConflictError('This archive operation no longer exists.')
      if (receipt.state === 'unresolved') {
        const work = this.archiveWork(receipt.preview.scope)
        if (
          !work.tasks.length &&
          !work.blockedReason &&
          !this.scopeHasPendingWorkspaceFinalization(receipt.preview.scope)
        )
          this.core.conversations.archives.releaseResolved(operationId)
      }
      return { ok: true, value: this.core.conversations.archives.read(operationId)! }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  cancelWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    try {
      return { ok: true, value: this.core.conversations.archives.cancel(operationId) }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  private scopeHasPendingWorkspaceFinalization(scope: WorkspaceArchiveScope): boolean {
    if (!this.core.workspaceChanges) return false
    if (this.core.workspaceChanges.hasPendingFinalization(scope)) return true
    if (scope.kind !== 'session') return false
    return this.core.workspaceChanges
      .pendingSessionIds()
      .some((id) => this.core.sessions.find(id)?.parentSessionId === scope.sessionId)
  }

  private async awaitScopeWorkspaceFinalization(scope: WorkspaceArchiveScope): Promise<void> {
    if (!this.core.workspaceChanges) return
    if (scope.kind !== 'session') {
      await this.core.workspaceChanges.awaitFinalization(scope)
      return
    }
    const targets = new Set<string>([
      scope.sessionId,
      ...this.core.workspaceChanges
        .pendingSessionIds()
        .filter((id) => this.core.sessions.find(id)?.parentSessionId === scope.sessionId),
    ])
    await Promise.all(
      [...targets].map((sessionId) =>
        this.core.workspaceChanges!.awaitFinalization({ kind: 'session', sessionId }),
      ),
    )
  }

  private archiveWork(scope: WorkspaceArchiveScope): {
    tasks: WorkspaceArchiveTask[]
    blockedReason?: string
  } {
    const projectId = this.core.conversations.archives.context(scope).projectId
    const belongs = (sessionId: string): boolean => {
      if (scope.kind === 'session') {
        return (
          sessionId === scope.sessionId ||
          this.core.sessions.find(sessionId)?.parentSessionId === scope.sessionId
        )
      }
      return this.core.conversations.archives.sessionMetadata(sessionId)?.projectId === projectId
    }
    const identities = new Map<string, { ids: string[]; state: WorkspaceArchiveTask['state'] }>()
    const add = (
      sessionId: string,
      identity: string,
      state: WorkspaceArchiveTask['state'],
    ): void => {
      if (!belongs(sessionId)) return
      const prior = identities.get(sessionId)
      if (prior) prior.ids.push(identity)
      else identities.set(sessionId, { ids: [identity], state })
    }
    const runs: string[] = []
    for (const entry of this.core.activeExecutions.values()) {
      add(entry.run.sessionId, `run:${entry.run.id}:${entry.run.bindingGeneration}`, 'running')
      if (belongs(entry.run.sessionId)) runs.push(entry.run.id)
    }
    for (const entry of this.core.preparingSends.values())
      add(entry.input.sessionId, `send:${entry.input.clientMessageId}`, 'preparing')
    for (const entry of this.core.preparingContinuations.values())
      add(entry.sessionId, `route:${entry.userMessageId}:${entry.protectedAgentId}`, 'continuing')
    for (const entry of this.core.conversations.pendingRoutedContinuations(scope))
      add(entry.sessionId, `pending:${entry.userMessageId}:${entry.agentId}`, 'continuing')
    for (const entry of this.core.conversations.archives.pendingInputs(scope))
      add(entry.sessionId, `input:${entry.id}`, 'continuing')
    const allTasks = [...identities].map(([sessionId, entry]) => ({
      sessionId,
      title: this.core.conversations.archives.sessionMetadata(sessionId)!.title,
      state: entry.state,
      identity: entry.ids.toSorted().join('|'),
    }))
    const exceedsTaskLimit = allTasks.length > WORKSPACE_ARCHIVE_TASK_LIMIT
    if (exceedsTaskLimit && scope.kind !== 'session')
      throw new WorkspaceArchiveConflictError(
        'Too many tasks changed at once. Nothing was stopped; try again.',
      )
    const tasks = exceedsTaskLimit ? allTasks.slice(0, WORKSPACE_ARCHIVE_TASK_LIMIT) : allTasks
    const unsupported =
      [...this.core.scheduling.decisionSessionIds()].some(belongs) ||
      [...this.core.nativeRebuilds.keys()].some(belongs) ||
      [...this.core.nativeForks.values()].some(
        (entry) =>
          belongs(entry.sourceSessionId) || Boolean(entry.sessionId && belongs(entry.sessionId)),
      ) ||
      [...this.core.nativeChecks.keys()].some((key) => belongs(key.split(':')[0]!)) ||
      [...this.core.adapters.values()].some((entry) => {
        if (!belongs(entry.sessionId) || !entry.adapter.hasActiveBackgroundWork?.()) return false
        const foreground = this.core.activeExecutions.get(entry.sessionId)
        return (
          !foreground || Boolean(this.core.conversations.findRun(foreground.run.id)?.nativeOutcome)
        )
      }) ||
      this.core.conversations.archives.hasNativeWork(scope, runs)
    const blockingTerminals =
      scope.kind === 'project'
        ? (this.core.terminalCoordinator?.listBlockingProjectSummaries(scope.projectId) ?? [])
        : []
    const blockedReason = exceedsTaskLimit
      ? 'More than 5 tasks are active across this Session and its side chats. Wait for tasks to finish before archiving. Nothing was stopped.'
      : unsupported
        ? 'Wait for active agent work (recovery, fork, rebuild, background tasks, or unconfirmed endings) to finish before archiving. Nothing was stopped.'
        : blockingTerminals.length > 0
          ? 'Close running project terminals before archiving this project. Nothing was stopped.'
          : undefined
    return {
      tasks,
      ...(blockedReason ? { blockedReason } : {}),
    }
  }

  async archiveWorkspace<T>(
    scope: WorkspaceArchiveScope,
    operationId: string | undefined,
    commit: (operationId: string) => RpcResult<T>,
    readCommitted: () => RpcResult<T>,
  ): Promise<RpcResult<T>> {
    if (this.core.disposed) return this.core.shuttingDown()
    const id = operationId ?? randomUUID()
    const outcomes: WorkspaceArchiveReceipt['tasks'] = []
    let confirmedTasks: WorkspaceArchiveTask[] = []
    let claimed = false
    let releaseTerminalLock: (() => void) | undefined
    try {
      const previous = this.core.conversations.archives.read(id)
      if (previous && JSON.stringify(previous.preview.scope) !== JSON.stringify(scope))
        throw new WorkspaceArchiveConflictError('This confirmation belongs to another item.')
      if (previous?.state === 'archived') {
        if (JSON.stringify(previous.preview.scope) !== JSON.stringify(scope))
          throw new WorkspaceArchiveConflictError('This receipt belongs to another item.')
        return readCommitted()
      }
      if (scope.kind === 'project' && this.core.terminalCoordinator) {
        releaseTerminalLock = this.core.terminalCoordinator.acquireProjectArchiveLock(
          scope.projectId,
        )
      }
      if (!operationId) {
        const preview = this.prepareWorkspaceArchive({ operationId: id, scope })
        if (!preview.ok) return preview
        if (
          preview.value.tasks.length ||
          (preview.value.terminals?.length ?? 0) > 0 ||
          preview.value.blockedReason
        )
          throw new WorkspaceArchiveConflictError(
            preview.value.blockedReason ?? 'Review the running tasks before archiving this item.',
          )
      }
      const work = this.archiveWork(scope)
      if (work.blockedReason) throw new WorkspaceArchiveConflictError(work.blockedReason)
      if (this.core.archiveOperations.size >= WORKSPACE_ARCHIVE_TASK_LIMIT)
        throw new WorkspaceArchiveConflictError(
          'Archive operations are busy. Nothing new was stopped; try again shortly.',
        )
      if (
        scope.kind === 'project' &&
        (this.core.terminalCoordinator?.listBlockingProjectSummaries(scope.projectId).length ?? 0) >
          0
      ) {
        throw new WorkspaceArchiveConflictError(
          'Close running project terminals before archiving this project. Nothing was stopped.',
        )
      }
      const ownedRunIds = [...this.core.activeExecutions.values()]
        .filter((entry) => work.tasks.some((task) => task.sessionId === entry.run.sessionId))
        .map((entry) => entry.run.id)
      const retiredPatches: ConversationPatch[] = []
      const receipt = this.core.conversations.archives.claim(
        id,
        this.core.archiveOwnerId,
        work.tasks,
        ownedRunIds,
        () => {
          for (const task of work.tasks) {
            this.core.conversations.setReceivedInputState(task.sessionId, 'cancelled')
            this.core.conversations.pauseCollaboration(task.sessionId, 'user')
            retiredPatches.push(
              this.core.conversations.cancelPendingRoutedContinuation(task.sessionId),
            )
          }
        },
      )
      if (JSON.stringify(receipt.preview.scope) !== JSON.stringify(scope))
        throw new WorkspaceArchiveConflictError('This confirmation belongs to another item.')
      claimed = true
      this.core.archiveOperations.add(id)
      confirmedTasks = receipt.preview.tasks
      for (const task of confirmedTasks)
        if (!work.tasks.some((current) => current.sessionId === task.sessionId))
          outcomes.push({ sessionId: task.sessionId, outcome: 'finished' })
      const deadline = performance.now() + WORKSPACE_ARCHIVE_STOP_MS
      const pending = new Set<string>()
      const failures = new Set<string>()
      const runIds: string[] = []
      for (const patch of retiredPatches) {
        try {
          this.core.publish(patch)
        } catch {
          /* Durable retirement remains authoritative; the Renderer resyncs. */
        }
      }
      const scopeSessionIds = new Set(work.tasks.map((task) => task.sessionId))
      for (const entry of this.core.adapters.values()) {
        if (
          scope.kind === 'session'
            ? entry.sessionId === scope.sessionId ||
              this.core.sessions.find(entry.sessionId)?.parentSessionId === scope.sessionId
            : this.core.conversations.archives.sessionMetadata(entry.sessionId)?.projectId ===
              receipt.preview.projectId
        )
          scopeSessionIds.add(entry.sessionId)
      }
      for (const task of work.tasks) {
        const sessionId = task.sessionId
        const execution = this.core.activeExecutions.get(sessionId)
        const preparations = [...this.core.preparingSends.values()].filter(
          (entry) => entry.input.sessionId === sessionId,
        )
        const continuation = this.core.preparingContinuations.get(sessionId)
        const promises = [
          execution?.completion,
          continuation?.completion,
          ...preparations.map((entry) => entry.task),
        ].filter((promise): promise is Promise<void> | Promise<RpcResult<ConversationPatch>> =>
          Boolean(promise),
        )
        if (execution) runIds.push(execution.run.id)
        const stop = this.core.stopSession(sessionId)
        if (!stop.ok) failures.add(sessionId)
        pending.add(sessionId)
        void Promise.allSettled(promises).then((results) => {
          if (results.some((result) => result.status === 'rejected')) failures.add(sessionId)
          pending.delete(sessionId)
          return undefined
        })
      }
      for (const sessionId of scopeSessionIds) {
        // Pending stages retired in the claim transaction cannot resume after a crash.
        const enrichment = this.core.titleEnrichments.get(sessionId)
        enrichment?.abortController.abort()
        // oxlint-disable-next-line no-await-in-loop -- The existing title owners have bounded native I/O and share the archive deadline.
        await ArchiveAndQuitCoordinator.awaitArchiveFinalization(
          Promise.all([
            this.core.interactions.cancelNativeTitleSync(sessionId),
            enrichment?.promise,
          ]).then(() => undefined),
          deadline,
        )
      }
      // One bounded wait chain per admitted archive (no Run queue, no provider replay).
      while (!this.core.disposed && performance.now() < deadline) {
        const current = [...scopeSessionIds].some(
          (sessionId) =>
            this.core.activeExecutions.has(sessionId) ||
            this.core.preparingContinuations.has(sessionId) ||
            this.core.routingOpenInputs.has(sessionId) ||
            [...this.core.preparingSends.values()].some(
              (entry) => entry.input.sessionId === sessionId,
            ),
        )
        const background = [...this.core.adapters.values()].some(
          (entry) =>
            scopeSessionIds.has(entry.sessionId) && entry.adapter.hasActiveBackgroundWork?.(),
        )
        if (!pending.size && !current && !background) break
        // oxlint-disable-next-line no-await-in-loop -- One absolute 15-second settlement chain, at most one timer.
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
      for (const task of work.tasks) {
        const unresolved =
          pending.has(task.sessionId) ||
          this.core.conversations.archives.hasNativeWork({
            kind: 'session',
            sessionId: task.sessionId,
          }) ||
          this.core.activeExecutions.has(task.sessionId) ||
          [...this.core.adapters.values()].some(
            (entry) =>
              entry.sessionId === task.sessionId && entry.adapter.hasActiveBackgroundWork?.(),
          )
        outcomes.push({
          sessionId: task.sessionId,
          outcome: unresolved ? 'unresolved' : failures.has(task.sessionId) ? 'failed' : 'stopped',
        })
      }
      if (
        this.core.disposed ||
        performance.now() >= deadline ||
        failures.size ||
        this.core.conversations.archives.hasNativeWork(scope) ||
        this.archiveWork(scope).tasks.length
      )
        throw new WorkspaceArchiveConflictError(
          'Not archived. Some tasks stopped, but active work couldn’t be confirmed finished. Stopped tasks will not restart automatically.',
        )
      for (const runId of runIds) {
        // Joining the existing owner also joins background-triggered finalization.
        // oxlint-disable-next-line no-await-in-loop -- At most five captured Runs, under the same absolute deadline.
        await ArchiveAndQuitCoordinator.awaitArchiveFinalization(
          this.core.executor.finalizeWorkspaceChanges(runId),
          deadline,
        )
      }
      if (this.core.workspaceChanges)
        await ArchiveAndQuitCoordinator.awaitArchiveFinalization(
          this.awaitScopeWorkspaceFinalization(scope),
          deadline,
        )
      if (this.core.disposed || performance.now() >= deadline)
        throw new WorkspaceArchiveConflictError(
          'Pact closed or timed out before archiving finished. Nothing was archived.',
        )
      if (scope.kind === 'project' && this.core.terminalCoordinator) {
        if (
          this.core.terminalCoordinator.listBlockingProjectSummaries(scope.projectId).length > 0
        ) {
          throw new WorkspaceArchiveConflictError(
            'Close running project terminals before archiving this project. Nothing was stopped.',
          )
        }
        await this.core.terminalCoordinator.releaseIdleProjectTerminals(scope.projectId)
      }
      const archivedResult = this.core.conversations.archives.finish(id, outcomes, () => {
        const result = commit(id)
        if (!result.ok) throw new WorkspaceArchiveConflictError(result.error.message)
        return result
      })
      releaseTerminalLock?.()
      releaseTerminalLock = undefined
      const archivedSessionIds = new Set<string>(scopeSessionIds)
      if (scope.kind === 'session') {
        archivedSessionIds.add(scope.sessionId)
      }
      const retireTasks: Promise<unknown>[] = [...archivedSessionIds].map((archivedId) =>
        this.core.reconcileSessionSettingsChanged(archivedId),
      )
      if (scope.kind === 'project') {
        const project = this.core.projects.find(scope.projectId)
        if (project) {
          for (const pool of this.core.agyConnectionPools.values()) {
            retireTasks.push(pool.retireFullAccess({ cwd: project.directoryPath }))
          }
        }
      }
      await Promise.allSettled(retireTasks)
      return archivedResult
    } catch (error) {
      if (claimed) {
        for (const task of confirmedTasks)
          if (!outcomes.some((result) => result.sessionId === task.sessionId)) {
            const remaining =
              this.core.conversations.archives.hasNativeWork({
                kind: 'session',
                sessionId: task.sessionId,
              }) ||
              this.core.activeExecutions.has(task.sessionId) ||
              [...this.core.preparingSends.values()].some(
                (entry) => entry.input.sessionId === task.sessionId,
              ) ||
              this.core.preparingContinuations.has(task.sessionId) ||
              this.core.routingOpenInputs.has(task.sessionId) ||
              this.core.workspaceChanges?.hasPendingFinalization({
                kind: 'session',
                sessionId: task.sessionId,
              })
            outcomes.push({
              sessionId: task.sessionId,
              outcome: remaining ? 'unresolved' : 'finished',
            })
          }
        try {
          const remaining = this.archiveWork(scope)
          const unresolved =
            this.core.conversations.archives.hasNativeWork(scope) ||
            remaining.tasks.length > 0 ||
            Boolean(remaining.blockedReason) ||
            this.scopeHasPendingWorkspaceFinalization(scope)
          this.core.conversations.archives.fail(
            id,
            outcomes,
            error instanceof Error ? error.message : 'Nothing was archived.',
            unresolved,
          )
        } catch {
          return {
            ok: false,
            error: {
              code: 'UNCERTAIN',
              message:
                'The archive result could not be saved. Check this operation after restarting Pact; it will not automatically repeat.',
            },
          }
        }
      }
      return this.core.sendFailure(error)
    } finally {
      if (claimed) this.core.archiveOperations.delete(id)
      releaseTerminalLock?.()
    }
  }

  private static async awaitArchiveFinalization(
    work: Promise<void>,
    deadline: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkspaceArchiveConflictError(
                  'Saving the stopped task took too long. Nothing was archived.',
                ),
              ),
            Math.max(1, deadline - performance.now()),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  resolveShutdownDeadlineAt(shutdown?: { flushDeadlineAt?: number }): number | undefined {
    const raw = shutdown?.flushDeadlineAt
    if (raw !== undefined && Number.isFinite(raw) && raw > 0) {
      const candidate = Math.min(Math.trunc(raw), Date.now() + 4000)
      this.core.shutdownDeadlineAt =
        this.core.shutdownDeadlineAt !== undefined
          ? Math.min(this.core.shutdownDeadlineAt, candidate)
          : candidate
    }
    return this.core.shutdownDeadlineAt
  }

  dispose(shutdown?: { flushDeadlineAt?: number }): Promise<void> {
    clearTimeout(this.core.nativeQuitPreparation?.timer)
    this.core.nativeQuitPreparation = undefined
    this.core.nativeListeners.clear()
    this.core.skillDocumentOwner?.controller.abort()
    for (const owner of this.core.skillDiscoveries.values()) owner.controller.abort()
    this.core.skillCatalogs.clear()
    if (this.core.disposal) return this.core.disposal
    const attempt = (
      this.core.baseShutdownDone ? this.retryPendingCleanup(shutdown) : this.close(shutdown)
    ).catch((error: unknown) => {
      if (this.core.disposal === attempt) {
        this.core.disposal = undefined
      }
      throw error
    })
    this.core.disposal = attempt
    return attempt
  }

  private async retryPendingCleanup(shutdown?: { flushDeadlineAt?: number }): Promise<void> {
    const flushDeadlineAt = this.resolveShutdownDeadlineAt(shutdown)
    if (flushDeadlineAt !== undefined) {
      for (const pool of this.core.agyConnectionPools.values()) {
        pool.capShutdownDeadline(flushDeadlineAt)
      }
    }
    const agyPoolEntries = [...this.core.agyConnectionPools.entries()]
    const agyForkFiles = this.core.agyForkFiles
    const poolResults = await Promise.allSettled([
      ...agyPoolEntries.map(async ([poolKey, pool]) => {
        await pool.dispose(flushDeadlineAt)
        if (pool.occupiedProcessSlotCount === 0) {
          if (this.core.agyConnectionPools.get(poolKey) === pool) {
            this.core.agyConnectionPools.delete(poolKey)
          }
          this.core.retiringAgyPools.delete(pool)
        } else {
          throw new Error('Antigravity connection pool still has unconfirmed process slots.')
        }
      }),
      ...(agyForkFiles
        ? [
            (async () => {
              await agyForkFiles.dispose(flushDeadlineAt)
              if (this.core.agyForkFiles === agyForkFiles) {
                this.core.agyForkFiles = undefined
              }
            })(),
          ]
        : []),
    ])
    if (this.core.permanentShutdownFailure) {
      throw this.core.permanentShutdownFailure
    }
    const rejected = poolResults.find((item) => item.status === 'rejected')
    if (rejected?.status === 'rejected') {
      throw new Error(
        'Pact could not finish all output commits and resource cleanup before shutdown.',
        { cause: rejected.reason },
      )
    }
  }

  private async close(shutdown?: { flushDeadlineAt?: number }): Promise<void> {
    this.core.disposed = true
    if (this.core.pendingContinuationImmediate)
      clearImmediate(this.core.pendingContinuationImmediate)
    this.core.pendingContinuationImmediate = undefined
    this.core.workflowCandidateCursor = undefined
    this.core.workflowCandidateRescan = false
    this.core.decisionRuntime?.controller.abort()
    const decisionCleanup = this.core.decisionRuntime?.runtime?.dispose().catch(() => false)
    this.core.decisionConnection = undefined
    const markdownCleanup: Promise<unknown>[] = [this.core.markdownTail]
    if (this.core.markdownWorker) markdownCleanup.push(this.core.markdownWorker.terminate())
    const forkOwners = [...this.core.nativeForks.values()]
    const forkPreparations = [...this.core.forkPreparations.values()]
    for (const owner of forkOwners) owner.controller.abort()
    const nativeChecks = [...this.core.nativeChecks.values()]
    for (const check of nativeChecks) check.controller.abort()
    this.core.interestedSessionIds.clear()
    this.core.steerReceiptChecks.clear()
    const executions = [...this.core.activeExecutions.values()]
    const preparing = [...this.core.preparingSends.values()]
    const preparingContinuations = [...this.core.preparingContinuations.values()]
    const nativeRebuilds = [...this.core.nativeRebuilds.values()]
    const titleEnrichments = [...this.core.titleEnrichments.values()]
    const nativeTitleSyncs = [...this.core.nativeTitleSyncs.values()]
    for (const owner of nativeTitleSyncs) {
      owner.cancelled = true
      owner.abortController.abort()
    }
    let flushed = true
    for (const execution of executions) {
      try {
        if (execution.streamBuffer && !execution.streamBuffer.dispose()) flushed = false
      } catch {
        flushed = false
      }
    }
    // Reuse the accepted restart classification, but save the interruption now.
    for (const execution of executions) {
      try {
        this.core.conversations.interruptRun(execution.run.id, execution.deliveryPossible)
      } catch {
        flushed = false
      }
    }
    // This is the first part of Main's existing four-second flush, not a new
    // Stop deadline. One cutoff covers at most the existing execution slots.
    const flushDeadlineAt = this.resolveShutdownDeadlineAt(shutdown)
    const drainUntil = flushDeadlineAt !== undefined ? flushDeadlineAt - 3000 : undefined
    const cutoff = Promise.withResolvers<void>()
    const shutdownOwners: NativeObservation[] = []
    const foregroundDisposals = new Map<AgentAdapter, Promise<void>>()
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined
    if (drainUntil !== undefined && drainUntil > Date.now() && flushDeadlineAt !== undefined) {
      for (const execution of executions) {
        try {
          const saved = this.core.conversations.findRun(execution.run.id)
          const owner = this.core.nativeObservations.get(execution.run.id)
          if (
            (saved?.agentId !== 'codex' && saved?.agentId !== 'agy') ||
            saved.dispatchPhase !== 'accepted' ||
            !saved.nativeSessionId ||
            !saved.nativeTurnId ||
            !saved.executorId ||
            !owner ||
            !this.core.adapterOwnsExecutor(owner.adapter, saved.executorId) ||
            this.core.adapters.get(`${saved.sessionId}:${saved.agentId}`)?.adapter !==
              owner.adapter ||
            !this.core.conversations.isCurrentBackgroundCursor(saved.id)
          )
            continue
          const proof = Promise.withResolvers<void>()
          owner.shutdown = {
            deadlineAt: drainUntil,
            nativeSessionId: saved.nativeSessionId,
            nativeTurnId: saved.nativeTurnId,
            executorId: saved.executorId,
            bindingGeneration: saved.bindingGeneration ?? 1,
            ended: false,
            drained: false,
            failed: false,
            complete: () => proof.resolve(),
          }
          shutdownOwners.push(owner)
          // dispose pins the connection cap before abort can enter its existing
          // native interruption path. Actual physical close waits for this proof/cutoff.
          let disposal: Promise<void>
          try {
            disposal = owner.adapter.dispose({
              flushDeadlineAt,
              foregroundSettlement: Promise.race([proof.promise, cutoff.promise]),
            })
          } catch (error) {
            disposal = Promise.reject(error)
          }
          void disposal.catch(() => undefined)
          foregroundDisposals.set(owner.adapter, disposal)
        } catch {
          // Lost metadata cannot skip abort, physical join, or arm another owner forever.
          flushed = false
        }
      }
      if (shutdownOwners.length)
        shutdownTimer = setTimeout(() => cutoff.resolve(), Math.max(0, drainUntil - Date.now()))
    }
    // Even late shutdown delivery retains Main's original physical cleanup cap.
    if (flushDeadlineAt !== undefined) {
      for (const pool of this.core.agyConnectionPools.values()) {
        pool.capShutdownDeadline(flushDeadlineAt)
      }
      for (const { adapter } of this.core.adapters.values()) {
        if ((adapter.id !== 'codex' && adapter.id !== 'agy') || foregroundDisposals.has(adapter))
          continue
        let disposal: Promise<void>
        try {
          disposal = adapter.dispose({ flushDeadlineAt })
        } catch (error) {
          disposal = Promise.reject(error)
        }
        void disposal.catch(() => undefined)
        foregroundDisposals.set(adapter, disposal)
      }
    }
    this.core.titleEnrichments.clear()
    for (const execution of executions) execution.abortController.abort()
    for (const admission of preparing) admission.controller.abort()
    for (const continuation of preparingContinuations) continuation.controller.abort()
    for (const controller of this.core.routingOpenInputs.values()) controller.abort()
    for (const rebuild of nativeRebuilds) rebuild.abortController.abort()
    for (const enrichment of titleEnrichments) enrichment.abortController.abort()
    // Actual App shutdown releases our waits. Abandon/Rebuild never enters
    // this path and never fabricates a user cancellation for old requests.
    for (const pending of this.core.permissions.values()) pending.withdraw('aborted')
    await Promise.allSettled([...this.core.skillDiscoveries.values()].map((owner) => owner.task))
    if (this.core.skillDocumentOwner) await this.core.skillDocumentOwner.task
    await this.core.adapterSlotTail
    const adapters = [...this.core.adapters.values()]
    this.core.adapters.clear()
    const agyPoolEntries = [...this.core.agyConnectionPools.entries()]
    const agyForkFiles = this.core.agyForkFiles
    for (const owner of this.core.nativeObservations.values()) {
      owner.sourceReader?.retire()
      this.core.recovery.clearBackgroundStop(owner)
      owner.observationController.abort()
      owner.archiver.archiveController.abort()
    }
    await Promise.allSettled(
      [...this.core.nativeObservations.values()].flatMap((owner) =>
        owner.archiver.archiveTail ? [owner.archiver.archiveTail] : [],
      ),
    )
    for (const owner of this.core.nativeObservations.values()) {
      try {
        if (owner.archiver.failureRecordingError !== undefined) flushed = false
        if (owner.archiver.archiveBuffer && !owner.archiver.archiveBuffer.dispose()) flushed = false
      } catch {
        flushed = false
      }
    }
    for (const owner of this.core.nativeObservations.values()) {
      owner.streamTrace?.reservation.release()
      owner.streamTrace = undefined
    }
    this.core.lastSettledStreamTrace?.reservation.release()
    this.core.lastSettledStreamTrace = undefined

    // Give zero-input registered Agy sessions one bounded close chance before tearing down
    // their shared ACP pools, then concurrently await adapters, pools, shared agyForkFiles,
    // and all remaining tasks so no join deadlocks and no promise can reject unhandled.
    const zeroInputCloseTasks = adapters.flatMap(({ adapter }) =>
      adapter instanceof AgyAgentAdapter && typeof adapter.closeZeroInputSessions === 'function'
        ? [adapter.closeZeroInputSessions(flushDeadlineAt).catch(() => undefined)]
        : [],
    )
    if (zeroInputCloseTasks.length > 0) {
      await Promise.allSettled(zeroInputCloseTasks)
    }

    const agyForkDisposal = agyForkFiles
      ? (async () => {
          await agyForkFiles.dispose(flushDeadlineAt)
          if (this.core.agyForkFiles === agyForkFiles) {
            this.core.agyForkFiles = undefined
          }
        })()
      : undefined

    const baseCleanupTasks: Promise<unknown>[] = [
      ...markdownCleanup,
      ...(decisionCleanup ? [decisionCleanup] : []),
      ...(this.core.decisionRecovery ? [this.core.decisionRecovery] : []),
      ...[...this.core.collaborationActions.values()].map((owner) => owner.task),
      ...adapters.map(async ({ adapter, disposeExtra }) => {
        await Promise.all([
          foregroundDisposals.get(adapter) ??
            adapter.dispose(flushDeadlineAt !== undefined ? { flushDeadlineAt } : undefined),
          disposeExtra ? disposeExtra() : Promise.resolve(),
        ])
      }),
      disposeDefaultAgySkillProbes(flushDeadlineAt),
      ...forkOwners.flatMap((owner) => (owner.completion ? [owner.completion] : [])),
      ...forkPreparations.map((owner) => owner.task),
      ...nativeChecks.map((owner) => owner.physicalCompletion),
      ...titleEnrichments.map(({ promise }) => promise),
      ...nativeTitleSyncs.map(({ promise }) => promise),
      ...executions.flatMap((execution) => (execution.completion ? [execution.completion] : [])),
      ...preparing.map((admission) => admission.task),
      ...preparingContinuations.flatMap((continuation) =>
        continuation.completion ? [continuation.completion] : [],
      ),
      ...nativeRebuilds.flatMap((rebuild) => (rebuild.completion ? [rebuild.completion] : [])),
    ]
    const retryablePhysicalTasks: Promise<unknown>[] = [
      ...agyPoolEntries.map(async ([poolKey, pool]) => {
        await pool.dispose(flushDeadlineAt)
        if (pool.occupiedProcessSlotCount === 0) {
          if (this.core.agyConnectionPools.get(poolKey) === pool) {
            this.core.agyConnectionPools.delete(poolKey)
          }
          this.core.retiringAgyPools.delete(pool)
        } else {
          throw new Error('Antigravity connection pool still has unconfirmed process slots.')
        }
      }),
      ...(agyForkDisposal ? [agyForkDisposal] : []),
    ]
    const [baseCleanupResults, retryablePhysicalResults] = await Promise.all([
      Promise.allSettled(baseCleanupTasks),
      Promise.allSettled(retryablePhysicalTasks),
    ])
    clearTimeout(shutdownTimer)
    if (shutdownOwners.some((owner) => owner.shutdown?.failed)) flushed = false
    for (const owner of shutdownOwners) delete owner.shutdown
    this.core.nativeObservations.clear()
    this.core.activeExecutions.clear()
    this.core.preparingSends.clear()
    this.core.preparingContinuations.clear()
    this.core.routingOpenInputs.clear()
    this.core.nativeRebuilds.clear()
    this.core.nativeForks.clear()
    this.core.forkPreparations.clear()
    this.core.listeners.clear()
    this.core.notificationProjector.dispose()
    this.core.notificationListeners.clear()
    await this.core.images?.dispose()
    const baseRejected = baseCleanupResults.find((result) => result.status === 'rejected')
    const decisionFailed = (await decisionCleanup) === false
    if (!flushed || decisionFailed || baseRejected?.status === 'rejected') {
      this.core.permanentShutdownFailure = new Error(
        'Pact could not finish all output commits and resource cleanup before shutdown.',
        ...(baseRejected?.status === 'rejected' ? [{ cause: baseRejected.reason }] : []),
      )
    }
    this.core.baseShutdownDone = true
    if (this.core.permanentShutdownFailure) {
      throw this.core.permanentShutdownFailure
    }
    const physicalRejected = retryablePhysicalResults.find((result) => result.status === 'rejected')
    if (physicalRejected?.status === 'rejected') {
      throw new Error(
        'Pact could not finish all output commits and resource cleanup before shutdown.',
        { cause: physicalRejected.reason },
      )
    }
  }
}
