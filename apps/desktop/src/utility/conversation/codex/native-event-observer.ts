import type { AgentRunInput, RunLifecycleKernel } from '@pact/agent-runtime'
import type { CollaborationInputObservation, CollaborationReviewObservation } from '@pact/contracts'

import type { AgentAnswerAssembler } from '../agent-answer-assembler'
import type { CodexAppServerConnection } from '../codex-app-server-connection'
import type { TurnResourceScope } from '../turn-resource-scope'

import {
  codexFileChanges,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from '../native-file-changes'
import { freezeNativeJsonFrame } from '../native-json-encoder'
import {
  CODEX_MAX_PENDING_RECORDINGS,
  CODEX_MAX_PENDING_RECORDING_BYTES,
  CODEX_STOP_COMMANDS,
  CODEX_STOP_IDENTITY_BYTES,
  applyCodexWorkflowMcpToolCall,
  cacheApprovalItem,
  isCodexConnectionScopedNotification,
  relayPermissionInputFromRun,
  type ApprovalItem,
  type CodexAdapterRuntime,
  type EarlyNativeFact,
  type NativeBackground,
} from './types'

export interface CodexTurnDeliveryState {
  phase: 'before_dispatch' | 'possibly_delivered' | 'accepted' | 'terminal'
}

export interface CodexTurnNativeObserverHost {
  readonly runtime: CodexAdapterRuntime
  readonly kernel: RunLifecycleKernel
  readonly input: AgentRunInput
  readonly signal: AbortSignal
  readonly foregroundInteractionSignal: AbortSignal
  readonly sourceGrant: NativeBackground['sourceGrant']
  readonly background: NativeBackground
  readonly delivery: CodexTurnDeliveryState
  readonly answer: AgentAnswerAssembler
  readonly getConnection: () => CodexAppServerConnection | undefined
  readonly getThreadId: () => string | undefined
  readonly getTurnId: () => string | undefined
  readonly setTurnId: (turnId: string | undefined) => void
  readonly getProvisionalThreadId: () => string | undefined
  readonly setProvisionalThreadId: (threadId: string) => void
  readonly isThreadStartupDispatched: () => boolean
  readonly isForegroundTurnCompletedYielded: () => boolean
  readonly getPeerReceipt: () => string | undefined
  readonly getProjectionFailure: () => unknown
  readonly setProjectionFailure: (error: unknown) => void
  readonly projectOutput: <T>(project: () => T) => T | undefined
  readonly capturePlan: (nativeId: string, text: string) => void
  readonly observePlanOperation: () => void
  readonly captureRetainedPlan: (nativeId: unknown) => void
  readonly captureReview: (verdict: CollaborationReviewObservation) => void
  readonly captureInputResult: (outcome: CollaborationInputObservation) => void
  readonly getWorkflowArtifacts: () => {
    readonly submittedPlan: { nativeId: string; text: string } | undefined
    readonly reviewResult: CollaborationReviewObservation | undefined
    readonly inputResult: CollaborationInputObservation | undefined
  }
}

/**
 * Owns Codex app-server owned-event admission, pre-ACK early-frame buffering &
 * wire-order replay, child thread/turn & hook tracking, fileChange recording
 * queue, root Turn binding, one-shot interruption, and background settlement.
 */
export class CodexTurnNativeObserver {
  readonly handledRequests = new Set<string>()
  readonly approvalItems = new Map<string, ApprovalItem>()

  private readonly observed = new WeakSet<object>()
  private readonly fileChangeRecordings = new WeakMap<object, Promise<void>>()
  private replaying = false
  private handledNativeFactSeq = 0
  private rootAcceptedPersisted = false
  private rootRunningEvidencePersisted = false
  private rootTerminalOutcome: 'completed' | 'failed' | 'interrupted' | undefined
  private archivedTurnCompletedEmitted = false
  private lastBackgroundWork: 'working' | 'stoppable' | undefined

  constructor(private readonly host: CodexTurnNativeObserverHost) {}

  cacheApprovalItem(item: object, threadId: unknown, turnId: unknown): void {
    cacheApprovalItem(this.approvalItems, item, threadId, turnId)
  }

  getFileChangeRecording(item: object): Promise<void> | undefined {
    return this.fileChangeRecordings.get(item)
  }

  rejectServerRequest(req: object, message: string): void {
    const connection = this.host.getConnection()
    if (!connection?.isOpen) return
    const reqId = Reflect.get(req, 'id')
    if (typeof reqId === 'string' || typeof reqId === 'number')
      void connection.respondError(reqId, message).catch(() => undefined)
  }

  releaseRootStartupEarly(releaseUnboundStartupHooks = false): void {
    const { background } = this.host
    if (!background.early.length) return
    const kept: EarlyNativeFact[] = []
    let keptBytes = 0
    for (const entry of background.early) {
      if (
        entry.candidateKind === 'root_turn' ||
        (releaseUnboundStartupHooks && entry.candidateKind === 'startup_hook')
      ) {
        if (
          entry.candidateKind === 'root_turn' &&
          Object.hasOwn(entry.event, 'id') &&
          typeof Reflect.get(entry.event, 'method') === 'string'
        )
          this.rejectServerRequest(
            entry.event,
            'This native request belonged to a Turn that did not start.',
          )
        entry.reservation.release()
      } else {
        kept.push(entry)
        keptBytes += entry.bytes
      }
    }
    background.early = kept
    background.earlyBytes = keptBytes
    if (!background.early.length) {
      clearTimeout(background.earlyTimer)
      background.earlyTimer = undefined
    }
  }

  markRootNotStartedIfUnsent(targetThreadId?: string): void {
    const { background, input, kernel } = this.host
    if (background.rootNotStarted) return
    background.rootNotStarted = true
    this.releaseRootStartupEarly(!background.primaryThreadId)
    kernel.recordDispatch(
      'rejected',
      targetThreadId ?? this.host.getThreadId() ?? input.nativeSessionId,
      this.host.getConnection()?.executorId,
    )
  }

  emitArchivedTerminalSnapshot(status: 'completed' | 'failed' | 'interrupted'): void {
    const { answer, background, input } = this.host
    if (
      this.archivedTurnCompletedEmitted ||
      this.host.isForegroundTurnCompletedYielded() ||
      this.host.getProjectionFailure()
    )
      return
    this.archivedTurnCompletedEmitted = true
    const { submittedPlan, reviewResult } = this.host.getWorkflowArtifacts()
    const text =
      answer.finalize() ??
      (status === 'completed' && submittedPlan && !answer.text ? '' : undefined)
    if (text !== undefined)
      input.host?.effects?.recordArchivedEvent?.({
        agentId: 'codex',
        type: 'text.completed',
        turnId: background.primaryTurnId!,
        outputId: answer.outputId,
        text,
      })
    if (status === 'completed') {
      if (submittedPlan)
        input.host?.effects?.recordArchivedEvent?.({
          agentId: 'codex',
          type: 'collaboration.plan',
          turnId: background.primaryTurnId!,
          ...submittedPlan,
        })
      if (reviewResult)
        input.host?.effects?.recordArchivedEvent?.({
          agentId: 'codex',
          type: 'collaboration.review',
          turnId: background.primaryTurnId!,
          ...reviewResult,
        })
    }
    input.host?.effects?.recordArchivedEvent?.({
      agentId: 'codex',
      type: 'turn.completed',
      turnId: background.primaryTurnId!,
      outcome: status,
    })
  }

  /**
   * A-F5: If verified root terminal arrived before foreground exited (e.g., while paused
   * on fileChange recording or run.speed.resolved), hand off any undelivered authoritative
   * answer to RunOutputArchiver BEFORE `answer.dispose()` runs.
   */
  handoffUndeliveredTerminalSnapshot(): void {
    const { background } = this.host
    if (
      !background.rootTerminal ||
      !this.rootTerminalOutcome ||
      this.host.isForegroundTurnCompletedYielded() ||
      this.archivedTurnCompletedEmitted ||
      this.host.getProjectionFailure()
    ) {
      return
    }
    const outcome = this.rootTerminalOutcome
    if (background.steering && background.steeringDone) {
      const handoff = background.steeringDone
        .then(() => {
          this.emitArchivedTerminalSnapshot(outcome)
          return undefined
        })
        .catch(() => undefined)
      background.interactions.add(handoff)
      void handoff.finally(() => {
        background.interactions.delete(handoff)
        this.maybeSettle()
      })
    } else {
      this.emitArchivedTerminalSnapshot(outcome)
    }
  }

  reportUnknown(
    reason: string,
    scope: 'unlisted' | 'recorded_files' = 'unlisted',
    evidence: 'incomplete' | 'awaiting_terminal' = 'incomplete',
  ): void {
    const { background, input } = this.host
    if (evidence === 'incomplete') background.unknown = true
    nativeEffectsUncertain(input, reason, scope)
    if (!background.reportedUnknown) {
      background.reportedUnknown = true
      nativeFileChangesSettled(
        input,
        'unknown',
        evidence === 'awaiting_terminal' ? 'native_completion_pending' : 'native_work_unconfirmed',
      )
    }
  }

  maybeSettle(): void {
    const { background, input, runtime } = this.host
    const work = runtime.describeBackgroundWork(background)
    if (work !== this.lastBackgroundWork) {
      this.lastBackgroundWork = work
      input.host?.effects?.backgroundWorkChanged?.()
    }
    if (
      background.foregroundReleased &&
      (background.rootTerminal || background.rootNotStarted) &&
      !background.threads.size &&
      !background.operations.size &&
      !background.spawns.size &&
      !background.interactions.size &&
      !background.recordings.size &&
      !background.early.length &&
      !background.cancellationPending &&
      !background.untrackedWork
    )
      runtime.settleNativeBackground(background)
  }

  bufferEarly(
    event: object,
    retained?: EarlyNativeFact,
    retainRootTurnDuringReplay = false,
  ): boolean {
    const { background, delivery, input } = this.host
    const connection = this.host.getConnection()
    const params = Reflect.get(event, 'params')
    if (
      params &&
      typeof params === 'object' &&
      isCodexConnectionScopedNotification(Reflect.get(event, 'method'), params)
    ) {
      return false
    }
    const child =
      params && typeof params === 'object'
        ? (Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId'))
        : undefined
    const isPrimaryThread =
      typeof child === 'string' &&
      background.primaryThreadId !== undefined &&
      child === background.primaryThreadId
    // Carbon A-5: Never re-buffer a root_turn candidate or primary-thread event as child/spawn
    // just because pre-ACK `spawnAgent` already populated `background.spawns`.
    const isChildOrSpawn =
      retained?.candidateKind !== 'root_turn' &&
      !isPrimaryThread &&
      Boolean(
        background.spawns.size || (typeof child === 'string' && background.parents.has(child)),
      )
    const isStartupHookWindow =
      this.host.isThreadStartupDispatched() &&
      !background.primaryThreadId &&
      !background.rootNotStarted &&
      !(typeof child === 'string' && input.nativeSessionId && child !== input.nativeSessionId) &&
      ['hook/started', 'hook/completed'].includes(String(Reflect.get(event, 'method')))
    const isPossiblyDeliveredWindow =
      (!background.foregroundReleased &&
        delivery.phase === 'possibly_delivered' &&
        !background.primaryTurnId) ||
      (retainRootTurnDuringReplay && retained?.candidateKind === 'root_turn')
    if (!isChildOrSpawn && !isStartupHookWindow && !isPossiblyDeliveredWindow) return false
    const candidateKind: EarlyNativeFact['candidateKind'] =
      retained?.candidateKind ??
      (isChildOrSpawn ? 'child' : isStartupHookWindow ? 'startup_hook' : 'root_turn')
    let reservation = retained?.reservation
    try {
      const heldBytes = retained?.heldBytes ?? freezeNativeJsonFrame(event)
      // Admission includes the immutable DTO and worst-case UTF-16 escaped JSON counting copy.
      if (!connection?.isOpen) throw new Error('The early Native fact owner closed.')
      reservation ??= connection.reserveWorkingMemory(heldBytes * 7 + 4096)
      const bytes = retained?.bytes ?? Buffer.byteLength(JSON.stringify(event))
      if (background.early.length >= 128 || background.earlyBytes + bytes > 8 * 1024 * 1024) {
        reservation.release()
        background.untrackedWork = true
        this.reportUnknown(
          'Early native child events exceeded the observation budget; complete attribution is unavailable.',
        )
        return true
      }
      reservation.resize(heldBytes)
      background.early.push(retained ?? { event, bytes, heldBytes, reservation, candidateKind })
      background.earlyBytes += bytes
    } catch {
      reservation?.release()
      background.untrackedWork = true
      this.reportUnknown(
        'Early native facts could not be retained within the Connection working budget.',
      )
      return true
    }
    background.earlyTimer ??= setTimeout(() => {
      if (background.early.length) background.untrackedWork = true
      if (background.early.length)
        this.reportUnknown(
          'Early native child events could not be bound to an owned spawn before the deadline.',
        )
      for (const entry of background.early) entry.reservation.release()
      background.early = []
      background.earlyBytes = 0
      background.earlyTimer = undefined
      this.maybeSettle()
    }, 30_000)
    return true
  }

  replayEarly(evictUnmatchedRootCandidates = false): boolean {
    const { background } = this.host
    const connection = this.host.getConnection()
    if (this.replaying || !background.early.length) return false
    this.replaying = true
    let anyProgress = false
    try {
      for (let pass = 0; pass < 128 && background.early.length; pass += 1) {
        const queued: (EarlyNativeFact | undefined)[] = background.early
        background.early = []
        background.earlyBytes = 0
        let progressed = false
        try {
          for (let index = 0; index < queued.length; index += 1) {
            const entry = queued[index]!
            queued[index] = undefined
            try {
              if (!this.handleOwnedNativeEvent(entry.event)) {
                const rebuffered = this.bufferEarly(
                  entry.event,
                  entry,
                  !evictUnmatchedRootCandidates,
                )
                if (
                  !rebuffered &&
                  evictUnmatchedRootCandidates &&
                  entry.candidateKind === 'root_turn' &&
                  background.primaryTurnId &&
                  connection?.isOpen &&
                  Object.hasOwn(entry.event, 'id') &&
                  typeof Reflect.get(entry.event, 'method') === 'string'
                ) {
                  this.rejectServerRequest(
                    entry.event,
                    'This native request does not belong to the active Turn.',
                  )
                }
              } else {
                progressed = true
                anyProgress = true
              }
            } finally {
              if (!background.early.includes(entry)) entry.reservation.release()
            }
          }
        } finally {
          for (const entry of queued) entry?.reservation.release()
        }
        if (!progressed) break
      }
    } finally {
      this.replaying = false
      if (!background.early.length) {
        clearTimeout(background.earlyTimer)
        background.earlyTimer = undefined
      }
    }
    return anyProgress
  }

  drainPendingOwnedFacts(evictUnmatchedRootCandidates: boolean): void {
    const { background } = this.host
    const connection = this.host.getConnection()
    if (this.replaying || !connection) return
    // A-F1: Iteratively resolve queued connection FIFO notifications AND buffered early facts
    // to a fixed point BEFORE evicting unmatched root_turn candidates, so a pre-ACK root
    // spawnAgent in the connection FIFO registers `background.spawns` before child events replay.
    for (let pass = 0; pass < 16; pass += 1) {
      let progressed = false
      if (background.foregroundReleased) {
        const beforeSeq = this.handledNativeFactSeq
        connection.replayBackgroundNotifications()
        if (this.handledNativeFactSeq !== beforeSeq) {
          progressed = true
        }
      } else {
        connection.forEachQueuedNotification((queued) => {
          if (!this.observed.has(queued) && this.handleOwnedNativeEvent(queued)) {
            progressed = true
          }
        })
      }
      if (this.replayEarly(false)) progressed = true
      if (!progressed) break
    }
    if (evictUnmatchedRootCandidates) {
      this.replayEarly(true)
    }
  }

  maybeInterruptRoot(
    commands?: Map<string, string | undefined>,
    registerAsBackgroundInteraction = true,
  ): Promise<void> | undefined {
    const { background, runtime } = this.host
    const targetConnection = this.host.getConnection()
    const targetThreadId = this.host.getThreadId() ?? background.primaryThreadId
    const targetTurnId = background.primaryTurnId
    if (
      !background.stopRequested ||
      background.rootInterruptAttempted ||
      !targetConnection?.isOpen ||
      !targetThreadId ||
      !targetTurnId
    ) {
      return undefined
    }
    const remainingCommands = new Map<string, string | undefined>()
    for (const [id, handle] of commands ?? []) {
      if (background.operations.has(JSON.stringify([targetThreadId, targetTurnId, id]))) {
        remainingCommands.set(id, handle)
      }
    }
    if (background.rootTerminal && remainingCommands.size === 0) return undefined
    background.rootInterruptAttempted = true
    const interruptWork = runtime.connections
      .interruptForegroundCommands(
        background,
        targetConnection,
        targetThreadId,
        targetTurnId,
        remainingCommands,
        undefined,
        background.rootTerminal,
      )
      .catch(() => {
        const hasStillOpenStoppedCommands = [...remainingCommands.keys()].some((id) =>
          background.operations.has(JSON.stringify([targetThreadId, targetTurnId, id])),
        )
        if (!background.rootTerminal || hasStillOpenStoppedCommands) {
          this.reportUnknown(
            'Codex interruption could not be confirmed. Native observation remains active.',
          )
        }
      })
    if (registerAsBackgroundInteraction) {
      background.interactions.add(interruptWork)
      void interruptWork.finally(() => {
        background.interactions.delete(interruptWork)
        this.maybeSettle()
      })
    }
    return interruptWork
  }

  bindRootTurn(resolvedTurnId: string, source: 'ack' | 'late_ack' | 'user_message'): boolean {
    const { background, input, kernel, runtime } = this.host
    const connection = this.host.getConnection()
    const threadId = this.host.getThreadId()
    if (!connection || !threadId) return false
    if (background.primaryTurnId && background.primaryTurnId !== resolvedTurnId) return false
    this.host.setTurnId(resolvedTurnId)
    background.primaryTurnId = resolvedTurnId
    if (!this.rootAcceptedPersisted) {
      this.rootAcceptedPersisted = true
      kernel.recordDispatch('accepted', threadId, connection.executorId)
    }
    if (!background.rootTerminal && !this.rootRunningEvidencePersisted) {
      this.rootRunningEvidencePersisted = true
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'running',
        source: 'live_runtime',
        identity: runtime.runIdentity(input, threadId, resolvedTurnId),
      })
    }
    this.drainPendingOwnedFacts(true)
    if (background.foregroundReleased && background.stopRequested && !background.rootTerminal) {
      void this.maybeInterruptRoot()
    }
    if (source !== 'ack') this.maybeSettle()
    return true
  }

  handleOwnedNativeEvent(event: object): boolean {
    const {
      answer,
      background,
      delivery,
      foregroundInteractionSignal,
      input,
      kernel,
      runtime,
      signal,
      sourceGrant,
    } = this.host
    const nativeConnection = this.host.getConnection()
    if (!nativeConnection || background.closed || background.connection !== nativeConnection)
      return false
    const eventParams = Reflect.get(event, 'params')
    if (!eventParams || typeof eventParams !== 'object') return false
    const eventMethod = Reflect.get(event, 'method')
    if (isCodexConnectionScopedNotification(eventMethod, eventParams)) return false
    const startedThread =
      eventMethod === 'thread/started' ? Reflect.get(eventParams, 'thread') : undefined
    const suppliedThread =
      Reflect.get(eventParams, 'threadId') ?? Reflect.get(eventParams, 'conversationId')
    const suppliedTurn =
      Reflect.get(eventParams, 'turnId') ??
      (Reflect.get(eventParams, 'turn') && typeof Reflect.get(eventParams, 'turn') === 'object'
        ? Reflect.get(Reflect.get(eventParams, 'turn'), 'id')
        : undefined)
    const suppliedChild =
      startedThread && typeof startedThread === 'object'
        ? Reflect.get(startedThread, 'id')
        : suppliedThread
    if (
      (typeof suppliedChild === 'string' && runtime.retiredNativeChildren.has(suppliedChild)) ||
      (typeof suppliedThread === 'string' &&
        typeof suppliedTurn === 'string' &&
        runtime.retiredNativeTurns.has(JSON.stringify([suppliedThread, suppliedTurn])))
    ) {
      const requestId = Reflect.get(event, 'id')
      if (typeof requestId === 'string' || typeof requestId === 'number')
        void nativeConnection
          .respondError(requestId, 'This native request belongs to a retired Run generation.')
          .catch(() => undefined)
      return true
    }
    if (startedThread && typeof startedThread === 'object') {
      const parent = Reflect.get(startedThread, 'parentThreadId'),
        child = Reflect.get(startedThread, 'id')
      if (
        typeof child === 'string' &&
        child.length <= 1024 &&
        typeof parent === 'string' &&
        (parent === background.primaryThreadId || background.parents.has(parent)) &&
        background.spawns.size > 0
      ) {
        if (background.parents.size < 64) {
          background.parents.set(child, parent)
          background.threads.add(child)
          this.handledNativeFactSeq += 1
          this.replayEarly()
        } else {
          background.untrackedWork = true
          this.reportUnknown('Native child ancestry exceeded its bounded observer.')
        }
        return true
      }
    }
    const eventThread =
      Reflect.get(eventParams, 'threadId') ??
      Reflect.get(eventParams, 'conversationId') ??
      (startedThread && typeof startedThread === 'object'
        ? Reflect.get(startedThread, 'id')
        : undefined)
    const root = eventThread === background.primaryThreadId
    const detachedRoot = root && background.rootTerminal && eventMethod !== 'turn/completed'
    if (typeof eventThread !== 'string' || (!root && !background.parents.has(eventThread)))
      return this.replaying ? false : this.bufferEarly(event)
    const eventTurn = Reflect.get(eventParams, 'turn')
    const eventTurnId =
      Reflect.get(eventParams, 'turnId') ??
      (eventTurn && typeof eventTurn === 'object' ? Reflect.get(eventTurn, 'id') : undefined)
    // S3-F2: A root userMessage carrying our exact clientUserMessageId (input.runId) is
    // cryptographic/ID proof of root Turn ownership even before turn/start ACK arrives.
    if (
      root &&
      !background.primaryTurnId &&
      delivery.phase === 'possibly_delivered' &&
      typeof eventTurnId === 'string' &&
      eventTurnId.length > 0 &&
      eventTurnId.length <= 1024 &&
      (eventMethod === 'item/started' || eventMethod === 'item/completed')
    ) {
      const item = Reflect.get(eventParams, 'item')
      if (
        item &&
        typeof item === 'object' &&
        Reflect.get(item, 'type') === 'userMessage' &&
        Reflect.get(item, 'clientId') === input.runId
      ) {
        this.bindRootTurn(eventTurnId, 'user_message')
      }
    }
    const ownedTurn = root
      ? typeof background.primaryTurnId === 'string' && eventTurnId === background.primaryTurnId
      : typeof eventTurnId === 'string' &&
        background.turnIds.has(JSON.stringify([eventThread, eventTurnId]))
    if (root && typeof eventTurnId === 'string' && eventTurnId !== background.primaryTurnId) {
      return false
    }
    if (
      root &&
      ownedTurn &&
      typeof eventTurnId === 'string' &&
      eventMethod === 'item/completed' &&
      input.host?.lifecycle?.recordInputConsumption
    ) {
      const item = Reflect.get(eventParams, 'item')
      const id =
        item && typeof item === 'object' && Reflect.get(item, 'type') === 'userMessage'
          ? Reflect.get(item, 'clientId')
          : undefined
      if (typeof id === 'string' && background.steerInputIds.has(id)) {
        input.host?.lifecycle?.recordInputConsumption?.(id, {
          nativeSessionId: eventThread,
          nativeTurnId: eventTurnId,
          executorId: nativeConnection.executorId,
        })
        background.steerInputIds.delete(id)
        if (background.steeringInput?.id === id) background.steeringInput.consumed = true
      }
    }
    if (eventMethod === 'turn/started' && !root && typeof eventTurnId === 'string') {
      if (
        background.turnIds.size >= 256 &&
        !background.turnIds.has(JSON.stringify([eventThread, eventTurnId]))
      ) {
        background.untrackedWork = true
        this.reportUnknown('Native child Turn identities exceeded the bounded observer.')
        return true
      }
      background.turns.set(eventThread, eventTurnId)
      background.turnIds.add(JSON.stringify([eventThread, eventTurnId]))
      background.threads.add(eventThread)
      this.handledNativeFactSeq += 1
      // A-F1: Immediately replay child requests/items buffered before this child turn/started arrived.
      this.replayEarly(false)
    }
    const isChildTurnScopedServerRequest =
      !root && Object.hasOwn(event, 'id') && typeof eventTurnId === 'string'
    if (
      eventMethod !== 'turn/started' &&
      typeof eventMethod === 'string' &&
      (eventMethod.startsWith('item/') ||
        eventMethod === 'turn/completed' ||
        isChildTurnScopedServerRequest) &&
      !ownedTurn
    ) {
      if (root) return false
      if (!background.turns.has(eventThread) && typeof eventTurnId === 'string')
        return this.replaying ? false : this.bufferEarly(event)
      const requestId = Reflect.get(event, 'id')
      if (typeof requestId === 'string' || typeof requestId === 'number')
        void nativeConnection
          .respondError(
            requestId,
            'This native request does not belong to the registered child Turn.',
          )
          .catch(() => undefined)
      return true
    }
    if (eventMethod === 'hook/started' || eventMethod === 'hook/completed') {
      // Thread-scoped startup Hooks have no Turn ID. An older released Run
      // may finish its own Hook, but cannot claim a later startup's new Hook.
      const hook = Reflect.get(eventParams, 'run')
      const hookId = hook && typeof hook === 'object' ? Reflect.get(hook, 'id') : undefined
      const nullableTurn = eventTurnId == null ? null : eventTurnId
      if (nullableTurn !== null && !ownedTurn) return false
      const validIdentity =
        typeof hookId === 'string' &&
        Boolean(hookId) &&
        hookId.length <= 1024 &&
        eventThread.length <= 1024 &&
        (nullableTurn === null || (typeof nullableTurn === 'string' && nullableTurn.length <= 1024))
      if (eventMethod === 'hook/completed' && !validIdentity) return false
      const key = validIdentity
        ? JSON.stringify(['hook', nativeConnection.executorId, eventThread, nullableTurn, hookId])
        : ''
      if (
        eventMethod === 'hook/started' &&
        root &&
        !this.replaying &&
        background.foregroundReleased &&
        nullableTurn === null &&
        !background.operations.has(key)
      )
        return false
      if (!validIdentity) {
        background.untrackedWork = true
        this.reportUnknown('Native Hook identity exceeded its bounded observer.')
      } else if (eventMethod === 'hook/started') {
        const hookBytes = [...background.operations]
          .filter((value) => value.startsWith('["hook",'))
          .reduce((sum, value) => sum + Buffer.byteLength(value), 0)
        if (
          background.operations.has(key) ||
          (background.operations.size < 64 && hookBytes + Buffer.byteLength(key) <= 64 * 1024)
        )
          background.operations.add(key)
        else {
          background.untrackedWork = true
          this.reportUnknown('Native Hook work exceeded its bounded operation owner.')
        }
        nativeEffectsUncertain(
          input,
          'Native hooks may modify files beyond reported operation evidence.',
        )
      } else {
        // A different Run can own a nullable-turn Hook on this Thread.
        // Leave unmatched completion available to its exact owner.
        if (!background.operations.has(key)) return false
        if (
          ['completed', 'failed', 'blocked', 'stopped'].includes(
            String(Reflect.get(hook, 'status')),
          )
        )
          background.operations.delete(key)
      }
      this.maybeSettle()
      return true
    }
    const matchedDetachedLegacyRootRequest =
      root &&
      !ownedTurn &&
      eventTurnId == null &&
      Object.hasOwn(event, 'id') &&
      typeof eventMethod === 'string' &&
      (background.foregroundReleased || detachedRoot) &&
      (() => {
        const callId = Reflect.get(eventParams, 'itemId') ?? Reflect.get(eventParams, 'callId')
        if (typeof callId !== 'string' || !callId || !background.primaryTurnId) return false
        const opKey = JSON.stringify([eventThread, background.primaryTurnId, callId])
        return background.operations.has(opKey) || this.approvalItems.has(opKey)
      })()
    if (root && !ownedTurn && !matchedDetachedLegacyRootRequest) return false
    // S3-F1: Pre-terminal queued foreground items already captured by the observer must still
    // flow to the active foreground consumer even if turn/completed arrived ahead on the wire.
    if (this.observed.has(event)) return !root || background.foregroundReleased
    this.observed.add(event)
    this.handledNativeFactSeq += 1
    if (root && ownedTurn && (eventMethod === 'item/started' || eventMethod === 'item/completed')) {
      const item = Reflect.get(eventParams, 'item')
      if (item && typeof item === 'object' && Reflect.get(item, 'type') === 'plan')
        this.host.observePlanOperation()
    }
    if (root && ownedTurn && !background.rootTerminal && eventMethod === 'item/completed') {
      const item = Reflect.get(eventParams, 'item')
      if (item && typeof item === 'object') {
        if (Reflect.get(item, 'type') === 'agentMessage') {
          const id = Reflect.get(item, 'id'),
            text = Reflect.get(item, 'text')
          if (typeof id === 'string' && typeof text === 'string')
            this.host.projectOutput(() => answer.capture(id, text))
        } else if (Reflect.get(item, 'type') === 'plan') {
          const id = Reflect.get(item, 'id'),
            text = Reflect.get(item, 'text')
          if (
            typeof id === 'string' &&
            id.length > 0 &&
            id.length <= 1024 &&
            typeof text === 'string' &&
            text.trim()
          )
            this.host.capturePlan(id, text)
        } else {
          applyCodexWorkflowMcpToolCall({
            item,
            runId: input.runId,
            peerServerName: runtime.peerServerName,
            peerToolServer: runtime.peerToolServer,
            peerReceipt: this.host.getPeerReceipt(),
            capturePlan: this.host.capturePlan,
            captureRetainedPlan: this.host.captureRetainedPlan,
            captureInputResult: this.host.captureInputResult,
            captureReview: this.host.captureReview,
          })
        }
      }
    }
    if (eventMethod === 'turn/completed') {
      if (root) {
        const status =
          eventTurn && typeof eventTurn === 'object' ? Reflect.get(eventTurn, 'status') : undefined
        if (
          !background.rootTerminal &&
          (status === 'completed' || status === 'failed' || status === 'interrupted')
        ) {
          background.rootTerminal = true
          this.rootTerminalOutcome = status
          kernel.recordTerminal(status)
          if (sourceGrant) runtime.peerToolServer.retireSourceReader(sourceGrant)
          const settleTerminal = (): void => {
            if (!this.host.getProjectionFailure()) {
              const { submittedPlan, reviewResult, inputResult } = this.host.getWorkflowArtifacts()
              runtime.recordTerminal(
                input,
                background.primaryThreadId!,
                background.primaryTurnId!,
                status,
                answer,
                status === 'completed'
                  ? { plan: submittedPlan, reviewResult, inputResult }
                  : undefined,
              )
            }
            if (background.foregroundReleased) {
              this.emitArchivedTerminalSnapshot(status)
            }
          }
          if (background.steering && background.steeringDone) {
            // S3-F6: Persist compact terminal identity & outcome immediately on verified
            // turn/completed while Steer RPC is still in flight; defer only the
            // Steer-dependent final answer/workflow snapshot behind `steeringDone`.
            runtime.recordTerminal(
              input,
              background.primaryThreadId!,
              background.primaryTurnId!,
              status,
              { outputId: answer.outputId, text: '' },
            )
            const settling = background.steeringDone
              .then(settleTerminal)
              .catch((error: unknown) => {
                this.host.setProjectionFailure(error)
                this.reportUnknown(
                  'Native completion could not be reconciled with its steering receipt.',
                )
              })
            background.interactions.add(settling)
            void settling.finally(() => {
              background.interactions.delete(settling)
              this.maybeSettle()
            })
          } else {
            if (this.host.getProjectionFailure()) {
              runtime.recordTerminal(
                input,
                background.primaryThreadId!,
                background.primaryTurnId!,
                status,
                { outputId: answer.outputId, text: '' },
              )
            }
            settleTerminal()
          }
        }
      } else if (background.turns.get(eventThread) === eventTurnId) {
        const interrupting = background.interruptingChild,
          status =
            eventTurn && typeof eventTurn === 'object'
              ? Reflect.get(eventTurn, 'status')
              : undefined
        if (status === 'completed' || status === 'failed' || status === 'interrupted') {
          if (interrupting?.threadId === eventThread && interrupting.turnId === eventTurnId)
            interrupting.terminal = true
          background.threads.delete(eventThread)
        }
      }
    }
    if (root && background.foregroundReleased && ownedTurn) {
      if (eventMethod === 'item/agentMessage/delta') {
        const itemId = Reflect.get(eventParams, 'itemId'),
          delta = Reflect.get(eventParams, 'delta')
        if (typeof itemId === 'string' && typeof delta === 'string') {
          const text = this.host.projectOutput(() => answer.append(itemId, delta))
          if (text !== undefined)
            input.host?.effects?.recordArchivedEvent?.({
              agentId: 'codex',
              type: 'text.delta',
              turnId: background.primaryTurnId!,
              outputId: answer.outputId,
              text,
            })
        }
      } else if (eventMethod === 'item/completed') {
        const item = Reflect.get(eventParams, 'item')
        if (item && typeof item === 'object' && Reflect.get(item, 'type') === 'agentMessage') {
          const itemId = Reflect.get(item, 'id'),
            text = Reflect.get(item, 'text')
          if (typeof itemId === 'string' && typeof text === 'string') {
            const completed = this.host.projectOutput(() => answer.complete(itemId, text))
            if (completed !== undefined)
              input.host?.effects?.recordArchivedEvent?.({
                agentId: 'codex',
                type: 'text.completed',
                turnId: background.primaryTurnId!,
                outputId: answer.outputId,
                text: completed,
              })
          }
        }
      }
    }
    if (eventMethod === 'item/started') {
      const item = Reflect.get(eventParams, 'item')
      if (item && typeof item === 'object') {
        cacheApprovalItem(this.approvalItems, item, eventThread, eventTurnId)
        const itemId = Reflect.get(item, 'id'),
          type = Reflect.get(item, 'type')
        if (
          root &&
          ownedTurn &&
          !detachedRoot &&
          !signal.aborted &&
          !background.foregroundReleased &&
          nativeConnection === runtime.connection &&
          type === 'commandExecution' &&
          ['agent', 'unifiedExecStartup'].includes(String(Reflect.get(item, 'source')))
        ) {
          const processId = Reflect.get(item, 'processId')
          if (
            typeof itemId !== 'string' ||
            !itemId ||
            Buffer.byteLength(itemId) > 1024 ||
            (processId != null &&
              (typeof processId !== 'string' || !processId || Buffer.byteLength(processId) > 1024))
          ) {
            this.reportUnknown('Native foreground command identity could not be verified.')
          } else {
            const handle = typeof processId === 'string' ? processId : undefined
            const bytes = Buffer.byteLength(JSON.stringify([itemId, handle ?? null]))
            const previous = background.foregroundCommands.get(itemId)
            const previousBytes = background.foregroundCommands.has(itemId)
              ? Buffer.byteLength(JSON.stringify([itemId, previous ?? null]))
              : 0
            if (
              (!background.foregroundCommands.has(itemId) &&
                background.foregroundCommands.size >= CODEX_STOP_COMMANDS) ||
              background.foregroundCommandBytes - previousBytes + bytes >
                CODEX_STOP_IDENTITY_BYTES ||
              (previous !== undefined && handle !== previous)
            ) {
              this.reportUnknown(
                'Native foreground command ownership exceeded its bounded evidence.',
              )
            } else {
              background.foregroundCommands.set(itemId, handle)
              background.foregroundCommandBytes += bytes - previousBytes
            }
          }
        }
        if (
          typeof itemId === 'string' &&
          itemId.length <= 1024 &&
          typeof eventTurnId === 'string'
        ) {
          const key = JSON.stringify([eventThread, eventTurnId, itemId])
          if (
            ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
              String(type),
            )
          ) {
            if (background.operations.size < 64) background.operations.add(key)
            else {
              background.untrackedWork = true
              this.reportUnknown('Native command observation exceeded its bounded item set.')
            }
          }
          if (
            ['collabAgentToolCall', 'collabToolCall'].includes(String(type)) &&
            Reflect.get(item, 'tool') === 'spawnAgent'
          ) {
            if (background.spawns.size < 64) background.spawns.add(key)
            else {
              background.untrackedWork = true
              this.reportUnknown('Native spawn observation exceeded its bounded item set.')
            }
          }
        }
      }
    }
    if (Object.hasOwn(event, 'id') && typeof eventMethod === 'string') {
      if (root && !background.foregroundReleased && !detachedRoot && !this.replaying) return false
      if (background.interactions.size >= 8) {
        this.reportUnknown('Native interactions exceeded their bounded request owner.')
        const requestId = Reflect.get(event, 'id')
        if (typeof requestId === 'string' || typeof requestId === 'number')
          void nativeConnection
            .respondError(
              requestId,
              'Pact cannot display another native interaction within its request budget. No approval response was sent.',
            )
            .catch(() => undefined)
        return true
      }
      const interactionSignal =
        root && !background.foregroundReleased && !detachedRoot
          ? foregroundInteractionSignal
          : background.observation.signal
      const interaction = runtime.connections
        .relayPermission(
          nativeConnection,
          event,
          eventMethod,
          eventParams,
          relayPermissionInputFromRun(input),
          eventThread,
          eventThread === background.primaryThreadId
            ? background.primaryTurnId
            : typeof eventTurnId === 'string'
              ? eventTurnId
              : background.turns.get(eventThread),
          interactionSignal,
          this.handledRequests,
          this.approvalItems,
        )
        .catch(() =>
          this.reportUnknown('Native background approval delivery could not be confirmed.'),
        )
      background.interactions.add(interaction)
      void interaction.finally(() => {
        background.interactions.delete(interaction)
        this.maybeSettle()
      })
      if (root && this.replaying) return true
    }
    if (eventMethod === 'item/completed') {
      const item = Reflect.get(eventParams, 'item')
      if (item && typeof item === 'object' && Reflect.get(item, 'type') === 'fileChange') {
        const evidence = codexFileChanges(item, input.cwd)
        const nativeId = Reflect.get(item, 'id')
        evidence.changes = evidence.changes.map((change, index) => ({
          ...change,
          ...(typeof nativeId === 'string'
            ? {
                operationId: root ? `${nativeId}:${index}` : `${eventThread}:${nativeId}:${index}`,
              }
            : { unavailableReason: 'The native operation identity was unavailable.' }),
        }))
        const evidenceBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
        // S3-F3: Single bounded sequential FIFO queue for ALL owned fileChange recordings;
        // overflow immediately fails closed (`recorded_files` uncertain) with no foreground drop path.
        if (
          background.recordings.size >= CODEX_MAX_PENDING_RECORDINGS ||
          background.recordingBytes + evidenceBytes > CODEX_MAX_PENDING_RECORDING_BYTES
        ) {
          this.fileChangeRecordings.set(item, Promise.resolve())
          this.reportUnknown(
            'Native file evidence exceeded its bounded recording queue.',
            'recorded_files',
          )
        } else {
          background.recordingBytes += evidenceBytes
          const recording = background.recordingTail.then(() =>
            recordNativeChanges(input, evidence, background.observation.signal),
          )
          background.recordingTail = recording.catch(() => undefined)
          background.recordings.add(recording)
          this.fileChangeRecordings.set(item, recording)
          void recording.finally(() => {
            background.recordings.delete(recording)
            background.recordingBytes = Math.max(0, background.recordingBytes - evidenceBytes)
            this.maybeSettle()
          })
        }
      }
      if (item && typeof item === 'object')
        runtime.trackNativeBackground(
          background,
          item,
          eventThread,
          typeof eventTurnId === 'string' ? eventTurnId : undefined,
        )
      this.replayEarly()
    }
    this.maybeSettle()
    if (!root)
      nativeEffectsUncertain(
        input,
        'Native child/background work may include effects outside recorded file operations.',
      )
    return !root || background.foregroundReleased || detachedRoot
  }

  /**
   * Pre-register connection background & server-request listeners (invariant C1)
   * bound to `releaseScope` for LIFO disposal when native observation releases.
   */
  attachSubscriptions(
    nativeConnection: CodexAppServerConnection,
    releaseScope: TurnResourceScope,
  ): void {
    const { background, delivery, foregroundInteractionSignal, input, runtime } = this.host
    releaseScope.add(
      'codex_background_subscription',
      nativeConnection.subscribeBackground((event) => {
        // Settings ACK belongs to the current next-task update, not an older Run.
        if (Reflect.get(event, 'method') === 'thread/settings/updated') return false
        if (this.handleOwnedNativeEvent(event)) return true
        if (
          background.closed ||
          background.foregroundReleased ||
          background.rootTerminal ||
          background.rootNotStarted
        )
          return false
        const params = Reflect.get(event, 'params')
        if (
          !params ||
          typeof params !== 'object' ||
          Reflect.get(params, 'threadId') !==
            (this.host.getThreadId() ?? this.host.getProvisionalThreadId() ?? input.nativeSessionId)
        )
          return false
        const item = Reflect.get(params, 'item')
        if (item && typeof item === 'object' && Reflect.get(event, 'method') === 'item/started')
          cacheApprovalItem(
            this.approvalItems,
            item,
            Reflect.get(params, 'threadId'),
            Reflect.get(params, 'turnId'),
          )
        return false
      }),
    )
    releaseScope.add(
      'codex_server_request_subscription',
      nativeConnection.subscribeServerRequests((request) => {
        if (this.handleOwnedNativeEvent(request)) return true
        const method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') return false
        const nativeThread =
          Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId')
        const requestedTurn = Reflect.get(params, 'turnId')
        const expectedThread =
          this.host.getThreadId() ?? this.host.getProvisionalThreadId() ?? input.nativeSessionId
        if (
          !this.host.isThreadStartupDispatched() ||
          background.closed ||
          background.foregroundReleased ||
          background.rootTerminal ||
          background.rootNotStarted ||
          typeof nativeThread !== 'string' ||
          !nativeThread ||
          nativeThread.length > 1024 ||
          (expectedThread && nativeThread !== expectedThread)
        )
          return false
        if (
          delivery.phase === 'before_dispatch' &&
          (method !== 'mcpServer/elicitation/request' || requestedTurn != null)
        ) {
          this.rejectServerRequest(
            request,
            'This native request is not valid before Turn dispatch.',
          )
          return true
        }
        if (!this.host.getProvisionalThreadId()) {
          this.host.setProvisionalThreadId(nativeThread)
        }
        const turnId = this.host.getTurnId()
        if (delivery.phase !== 'before_dispatch') {
          if (!turnId) return this.bufferEarly(request)
          if (typeof requestedTurn === 'string' && turnId !== requestedTurn) {
            this.rejectServerRequest(
              request,
              'This native request does not belong to the active Turn.',
            )
            return true
          }
        }
        if (background.interactions.size >= 8) {
          this.reportUnknown('Native interactions exceeded their bounded request owner.')
          this.rejectServerRequest(
            request,
            'Pact cannot display another native interaction within its request budget. No approval response was sent.',
          )
          return true
        }
        const interaction = runtime.connections
          .relayPermission(
            nativeConnection,
            request,
            method,
            params,
            relayPermissionInputFromRun(input),
            nativeThread,
            turnId,
            foregroundInteractionSignal,
            this.handledRequests,
            this.approvalItems,
          )
          .catch(() =>
            nativeEffectsUncertain(
              input,
              'Native interaction response delivery could not be confirmed.',
            ),
          )

        background.interactions.add(interaction)
        void interaction.finally(() => {
          background.interactions.delete(interaction)
          this.maybeSettle()
        })
        return true
      }),
    )
  }
}
