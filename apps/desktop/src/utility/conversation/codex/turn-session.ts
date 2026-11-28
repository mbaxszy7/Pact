import { isDeepStrictEqual } from 'node:util'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationRetainedPlan,
  CollaborationReviewObservation,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import {
  RunLifecycleKernel,
  sanitizeNativeTerminalFailure,
  validateSourceGrant,
} from '@pact/agent-runtime'
import {
  collaborationInputOutcomeAllowed,
  collaborationOpenPlanPublishAllowed,
  collaborationPlanRetentionAllowed,
} from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'

import type { CodexAppServerConnection } from '../codex-app-server-connection'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { AgentAnswerAssembler } from '../agent-answer-assembler'
import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  NativeInputWithheldError,
} from '../agent-execution-error'
import { mergeWorkflowInput, mergeWorkflowReview } from '../collaboration-answer'
import {
  collaborationInputResultAllowed,
  collaborationPlanMode,
  collaborationReadOnly,
  collaborationReviewMode,
} from '../collaboration-prompt'
import {
  codexFileChanges,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from '../native-file-changes'
import { freezeNativeJsonFrame } from '../native-json-encoder'
import { NativeWorkingMemory } from '../native-working-memory'
import {
  CODEX_MAX_PENDING_RECORDINGS,
  CODEX_MAX_PENDING_RECORDING_BYTES,
  CODEX_STOP_COMMANDS,
  CODEX_STOP_IDENTITY_BYTES,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TURN_ACCEPT_TIMEOUT_MS,
  CodexReasoningSummaryTracker,
  acceptsCodexReroute,
  applyCodexWorkflowMcpToolCall,
  buildCodexRecoveryConfiguration,
  buildCodexRecoverySettings,
  buildCodexStartupRequest,
  buildCodexTurnStartParams,
  cacheApprovalItem,
  classifyCodexRpcError,
  classifyCodexStartupRejection,
  cleanTitle,
  confirmPermissionMode,
  describeTool,
  isCodexConnectionScopedNotification,
  isPeerTool,
  observeThreadTitle,
  peerProposal,
  permissionReadback,
  reasoningSummary,
  relayPermissionInputFromRun,
  resolveCodexThreadConfiguration,
  resolvedModelEvent,
  threadTitle,
  toolFailed,
  type ApprovalItem,
  type CodexAdapterRuntime,
  type EarlyNativeFact,
  type NativeBackground,
} from './types'

/**
 * Explicit TurnSession FSM for a single Codex app-server Turn execution.
 *
 * Drives RunLifecycleKernel across PreLease -> BootstrappingSession ->
 * ReadyToDispatch -> DispatchedStreaming -> TerminalObserved | AbortRequested ->
 * DrainingEffects -> Settled, while preserving Codex CLI invariants C1-C7:
 * - C1: Notification & server-request listeners pre-registered before thread/start|resume & turn/start ACK.
 * - C2: Root settles only after rootTerminal and drained root/child operations.
 * - C3-C7: Zero-turn thread non-resumable handling, single turn/interrupt, thread/settings/update
 *   physical barrier, and strict sub-turn vs root-turn isolation.
 */
export class CodexTurnSession {
  readonly kernel: RunLifecycleKernel

  constructor(
    private readonly runtime: CodexAdapterRuntime,
    private readonly input: AgentRunInput,
    private readonly signal: AbortSignal,
  ) {
    this.kernel = new RunLifecycleKernel({
      agentId: 'codex',
      runId: input.runId,
      sessionId: input.sessionId,
      nativeGeneration: input.nativeGeneration ?? input.runId,
      callbacks: {
        onExecutorBound: (executorId) => input.host?.lifecycle?.recordExecutor?.(executorId),
        onDispatchPhase: (phase, nativeSessionId, executorId) =>
          input.host?.lifecycle?.recordDispatch?.(phase, nativeSessionId, executorId),
      },
    })
  }

  async *run(): AsyncIterable<NormalizedAgentEvent> {
    const input = this.input
    const signal = this.signal
    const rejectBeforeStart = async (error: Error): Promise<never> => {
      await this.kernel.settle()
      throw error
    }
    if (this.runtime.disposed || this.runtime.disposal)
      await rejectBeforeStart(
        new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false),
      )
    if (this.runtime.peerToolServer.hasSourceGrant())
      await rejectBeforeStart(
        new NativeCapacityError(
          'The previous native root still owns its frozen sources. No new task was submitted.',
        ),
      )
    const sourceReader = input.host?.workflow?.sourceReader
    const hasSourceReader = Boolean(sourceReader)
    const grantCheck = validateSourceGrant({
      runId: input.runId,
      nativeGeneration: input.nativeGeneration,
      hasSourceReader,
      sourceGrant: input.promptEnvelope.sourceGrant,
      readerIdentity: sourceReader?.identity,
    })
    if (!grantCheck.ok)
      await rejectBeforeStart(
        new AgentExecutionError(
          'protocol_error',
          grantCheck.reason ?? 'The source reader has no exact root owner.',
          false,
        ),
      )
    const sourceGrant = grantCheck.grant ? { ...grantCheck.grant } : undefined
    if (
      this.runtime.nativeBackground.size +
        this.runtime.nativeForkOwners.size +
        [...this.runtime.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending)
          .length >=
      8
    )
      await rejectBeforeStart(
        new NativeCapacityError(
          'Codex has too many owned native background contexts. Wait for one to settle; no new task was submitted.',
        ),
      )
    if (this.runtime.running) {
      await rejectBeforeStart(
        new AgentExecutionError(
          'protocol_error',
          'This Codex connection already has an active Run.',
          false,
        ),
      )
    }
    if (this.runtime.disposed) {
      await rejectBeforeStart(
        new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false),
      )
    }
    if (signal.aborted) {
      await rejectBeforeStart(
        new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
      )
    }

    const workflow = input.promptEnvelope.collaboration
    this.runtime.running = true
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    this.runtime.terminalEvidence.delete(input.runId)
    this.runtime.admitEvidenceCache()
    let connection: CodexAppServerConnection | undefined
    let recoveryConfiguration: { model: string; effort: string | null; policy: object } | undefined
    let threadId = input.nativeSessionId
    let turnId: string | undefined
    const delivery: {
      phase: 'before_dispatch' | 'possibly_delivered' | 'accepted' | 'terminal'
    } = { phase: 'before_dispatch' }
    let inputWithheldError: NativeInputWithheldError | undefined
    let lastSuggestedTitle: string | undefined
    let peerProposalEmitted = false
    let peerReceipt: string | undefined
    let retryNotifications = 0
    let foreignErrorNotifications = 0
    const background: NativeBackground = {
      input,
      sourceGrant,
      parents: new Map(),
      threads: new Set(),
      operations: new Set(),
      spawns: new Set(),
      interactions: new Set(),
      early: [],
      earlyBytes: 0,
      observation: new AbortController(),
      foregroundReleased: false,
      rootTerminal: false,
      rootNotStarted: false,
      reportedUnknown: false,
      untrackedWork: false,
      turns: new Map(),
      turnIds: new Set(),
      steerInputIds: new Set(),
      recordings: new Set(),
      recordingBytes: 0,
      recordingTail: Promise.resolve(),
      foregroundCommands: new Map(),
      foregroundCommandBytes: 0,
      cancellationPending: false,
      stopRequested: false,
      rootInterruptAttempted: false,
      unknown: false,
      closed: false,
    }
    // Stop withdraws only the foreground's current interaction. Native child
    // and detached requests keep their separate observation owner.
    const foregroundInteractionSignal = AbortSignal.any([signal, background.observation.signal])
    let stoppedCommands: Map<string, string | undefined> | undefined
    const freezeForegroundCommands = (): void => {
      this.kernel.requestAbort()
      background.stopRequested = true
      if (background.closed || stoppedCommands) return
      if (sourceGrant) this.runtime.peerToolServer.retireSourceReader(sourceGrant)
      stoppedCommands = background.rootTerminal ? new Map() : background.foregroundCommands
      background.foregroundCommands = new Map()
      background.foregroundCommandBytes = 0
      background.cancellationPending = true
    }
    signal.addEventListener('abort', freezeForegroundCommands, { once: true })
    const handledRequests = new Set<string>()
    const approvalItems = new Map<string, ApprovalItem>()
    const fileChangeRecordings = new WeakMap<object, Promise<void>>()
    let provisionalThreadId: string | undefined
    let threadStartupDispatched = false
    let threadStartupCompleted = false
    let rootTurnRequested = false
    let releaseNativeRequests: (() => void) | undefined
    let releaseApprovalMetadata: (() => void) | undefined
    const answer = new AgentAnswerAssembler(input.runId)
    const planMemory = new NativeWorkingMemory().reserve(0)
    let submittedPlan: { nativeId: string; text: string } | undefined
    let retainedPlan: CollaborationRetainedPlan | undefined
    let planOperationObserved = false
    let reviewResult: CollaborationReviewObservation | undefined
    let inputResult: CollaborationInputObservation | undefined
    let projectionFailure: unknown
    const failProjection = (error: unknown): void => {
      if (projectionFailure) return
      const failure = classifyAgentError(error)
      projectionFailure = failure
      answer.dispose()
      input.host?.lifecycle?.recordOutputFailure?.(failure)
    }
    const projectOutput = <T>(project: () => T): T | undefined => {
      if (projectionFailure) return undefined
      try {
        return project()
      } catch (error) {
        failProjection(error)
        return undefined
      }
    }
    const capturePlan = (nativeId: string, text: string): void => {
      if (
        !collaborationPlanMode(workflow, input.promptEnvelope.collaborationAuthorization) &&
        !collaborationOpenPlanPublishAllowed(
          workflow,
          input.promptEnvelope.collaborationAuthorization,
        )
      )
        return
      projectOutput(() => {
        planMemory.resize(4096 + Buffer.byteLength(text) * 4 + text.length * 2)
        submittedPlan = { nativeId, text }
        input.host?.workflow?.recordPlan?.(submittedPlan)
      })
    }
    const observePlanOperation = (): void => {
      if (!collaborationPlanMode(workflow, input.promptEnvelope.collaborationAuthorization)) return
      planOperationObserved = true
      const terminal = this.runtime.terminalEvidence.get(input.runId)
      if (terminal?.output?.retainedPlan) {
        const { retainedPlan: _retired, ...output } = terminal.output
        this.runtime.terminalEvidence.set(input.runId, { ...terminal, output })
      }
      if (retainedPlan) {
        retainedPlan = undefined
        try {
          input.host?.workflow?.recordPlanUnavailable?.()
        } catch {
          // The in-memory intent is already invalid. A metadata failure cannot
          // change the native outcome or make this intent eligible for settlement.
        }
      }
    }
    const captureRetainedPlan = (nativeId: unknown): void => {
      const authorization = input.promptEnvelope.collaborationAuthorization
      if (
        signal.aborted ||
        background.cancellationPending ||
        planOperationObserved ||
        submittedPlan ||
        retainedPlan ||
        inputResult ||
        background.interactions.size ||
        !collaborationPlanRetentionAllowed(workflow, authorization) ||
        !authorization?.planReference ||
        typeof nativeId !== 'string' ||
        !nativeId ||
        nativeId.length > 1024
      )
        return
      const { sha256, bytes, chars } = authorization.planReference.document
      const candidate = { nativeId, sha256, bytes, chars }
      projectOutput(() => {
        planMemory.resize(4096 + Buffer.byteLength(JSON.stringify(candidate)) * 6)
        retainedPlan = candidate
      })
    }
    const captureReview = (verdict: CollaborationReviewObservation): void => {
      if (!collaborationReviewMode(workflow, input.promptEnvelope.collaborationAuthorization))
        return
      projectOutput(() => {
        reviewResult = mergeWorkflowReview(reviewResult, verdict)
        input.host?.workflow?.recordReview?.(reviewResult)
      })
    }
    const captureInputResult = (outcome: CollaborationInputObservation): void => {
      if (
        !workflow ||
        !collaborationInputResultAllowed(
          workflow,
          input.promptEnvelope.collaborationAuthorization,
        ) ||
        !collaborationInputOutcomeAllowed(
          workflow,
          input.promptEnvelope.collaborationAuthorization,
          outcome.outcome,
        )
      )
        return
      projectOutput(() => {
        inputResult = mergeWorkflowInput(inputResult, outcome)
        input.host?.workflow?.recordInputResult?.(outcome)
      })
    }
    background.release = () => {
      const terminal = this.runtime.terminalEvidence.get(input.runId)
      if (
        retainedPlan &&
        !planOperationObserved &&
        !submittedPlan &&
        (!inputResult || inputResult.outcome === 'explanation_only') &&
        !projectionFailure &&
        !signal.aborted &&
        background.rootTerminal &&
        !background.unknown &&
        !background.untrackedWork &&
        !background.cancellationPending &&
        !background.threads.size &&
        !background.operations.size &&
        !background.spawns.size &&
        !background.interactions.size &&
        !background.recordings.size &&
        !background.early.length &&
        terminal?.kind === 'ended' &&
        terminal.outcome === 'completed' &&
        terminal.output &&
        input.host?.workflow?.recordPlanRetained
      ) {
        const confirmed = { ...retainedPlan, confirmation: 'native_root_settled_v1' as const }
        try {
          input.host?.workflow?.recordPlanRetained?.(confirmed)
          this.runtime.terminalEvidence.set(input.runId, {
            ...terminal,
            output: { ...terminal.output, retainedPlan: confirmed },
          })
          this.runtime.admitEvidenceCache()
        } catch {
          // A missing final confirmation leaves workflow input pending. Native
          // completion, answer content and actual effects remain independent.
        }
      }
      if (sourceGrant) this.runtime.peerToolServer.retireSourceReader(sourceGrant)
      releaseNativeRequests?.()
      releaseApprovalMetadata?.()
      answer.dispose()
      submittedPlan = undefined
      retainedPlan = undefined
      planMemory.release()
      if (background.unknown) {
        this.kernel.reportNativeEffects('unknown', 'native_observation_released')
      } else {
        this.kernel.reportNativeEffects(
          'settled',
          background.rootInputWithheld
            ? 'workflow_input_withheld'
            : background.rootNotStarted
              ? 'native_turn_not_started'
              : 'native_work_drained',
        )
      }
      void this.kernel.settle()
    }
    const reasoningSummaries = new CodexReasoningSummaryTracker()
    const observed = new WeakSet<object>()
    let replaying = false
    let handledNativeFactSeq = 0
    let rootAcceptedPersisted = false
    let rootRunningEvidencePersisted = false
    let rootTerminalOutcome: 'completed' | 'failed' | 'interrupted' | undefined
    let foregroundTurnCompletedYielded = false
    let archivedTurnCompletedEmitted = false
    const rejectServerRequest = (req: object, message: string): void => {
      if (!connection?.isOpen) return
      const reqId = Reflect.get(req, 'id')
      if (typeof reqId === 'string' || typeof reqId === 'number')
        void connection.respondError(reqId, message).catch(() => undefined)
    }
    const releaseRootStartupEarly = (releaseUnboundStartupHooks = false): void => {
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
            rejectServerRequest(
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
    const markRootNotStartedIfUnsent = (targetThreadId?: string): void => {
      if (background.rootNotStarted) return
      background.rootNotStarted = true
      releaseRootStartupEarly(!background.primaryThreadId)
      this.kernel.recordDispatch(
        'rejected',
        targetThreadId ?? threadId ?? input.nativeSessionId,
        connection?.executorId,
      )
    }
    const emitArchivedTerminalSnapshot = (status: 'completed' | 'failed' | 'interrupted'): void => {
      if (archivedTurnCompletedEmitted || foregroundTurnCompletedYielded || projectionFailure)
        return
      archivedTurnCompletedEmitted = true
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
    const reportUnknown = (
      reason: string,
      scope: 'unlisted' | 'recorded_files' = 'unlisted',
      evidence: 'incomplete' | 'awaiting_terminal' = 'incomplete',
    ): void => {
      if (evidence === 'incomplete') background.unknown = true
      nativeEffectsUncertain(input, reason, scope)
      if (!background.reportedUnknown) {
        background.reportedUnknown = true
        nativeFileChangesSettled(
          input,
          'unknown',
          evidence === 'awaiting_terminal'
            ? 'native_completion_pending'
            : 'native_work_unconfirmed',
        )
      }
    }
    let lastBackgroundWork: 'working' | 'stoppable' | undefined
    const maybeSettle = (): void => {
      const work = this.runtime.describeBackgroundWork(background)
      if (work !== lastBackgroundWork) {
        lastBackgroundWork = work
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
        this.runtime.settleNativeBackground(background)
    }
    const bufferEarly = (
      event: object,
      retained?: EarlyNativeFact,
      retainRootTurnDuringReplay = false,
    ): boolean => {
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
        threadStartupDispatched &&
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
          reportUnknown(
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
        reportUnknown(
          'Early native facts could not be retained within the Connection working budget.',
        )
        return true
      }
      background.earlyTimer ??= setTimeout(() => {
        if (background.early.length) background.untrackedWork = true
        if (background.early.length)
          reportUnknown(
            'Early native child events could not be bound to an owned spawn before the deadline.',
          )
        for (const entry of background.early) entry.reservation.release()
        background.early = []
        background.earlyBytes = 0
        background.earlyTimer = undefined
        maybeSettle()
      }, 30_000)
      return true
    }
    const replayEarly = (evictUnmatchedRootCandidates = false): boolean => {
      if (replaying || !background.early.length) return false
      replaying = true
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
                if (!handleOwnedNativeEvent(entry.event)) {
                  const rebuffered = bufferEarly(entry.event, entry, !evictUnmatchedRootCandidates)
                  if (
                    !rebuffered &&
                    evictUnmatchedRootCandidates &&
                    entry.candidateKind === 'root_turn' &&
                    background.primaryTurnId &&
                    connection?.isOpen &&
                    Object.hasOwn(entry.event, 'id') &&
                    typeof Reflect.get(entry.event, 'method') === 'string'
                  ) {
                    rejectServerRequest(
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
        replaying = false
        if (!background.early.length) {
          clearTimeout(background.earlyTimer)
          background.earlyTimer = undefined
        }
      }
      return anyProgress
    }
    const drainPendingOwnedFacts = (evictUnmatchedRootCandidates: boolean): void => {
      if (replaying || !connection) return
      // A-F1: Iteratively resolve queued connection FIFO notifications AND buffered early facts
      // to a fixed point BEFORE evicting unmatched root_turn candidates, so a pre-ACK root
      // spawnAgent in the connection FIFO registers `background.spawns` before child events replay.
      for (let pass = 0; pass < 16; pass += 1) {
        let progressed = false
        if (background.foregroundReleased) {
          const beforeSeq = handledNativeFactSeq
          connection.replayBackgroundNotifications()
          if (handledNativeFactSeq !== beforeSeq) {
            progressed = true
          }
        } else {
          connection.forEachQueuedNotification((queued) => {
            if (!observed.has(queued) && handleOwnedNativeEvent(queued)) {
              progressed = true
            }
          })
        }
        if (replayEarly(false)) progressed = true
        if (!progressed) break
      }
      if (evictUnmatchedRootCandidates) {
        replayEarly(true)
      }
    }
    const maybeInterruptRoot = (
      commands?: Map<string, string | undefined>,
      registerAsBackgroundInteraction = true,
    ): Promise<void> | undefined => {
      const targetConnection = connection
      const targetThreadId = threadId ?? background.primaryThreadId
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
      const interruptWork = this.runtime.connections
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
            reportUnknown(
              'Codex interruption could not be confirmed. Native observation remains active.',
            )
          }
        })
      if (registerAsBackgroundInteraction) {
        background.interactions.add(interruptWork)
        void interruptWork.finally(() => {
          background.interactions.delete(interruptWork)
          maybeSettle()
        })
      }
      return interruptWork
    }
    const bindRootTurn = (
      resolvedTurnId: string,
      source: 'ack' | 'late_ack' | 'user_message',
    ): boolean => {
      if (!connection || !threadId) return false
      if (background.primaryTurnId && background.primaryTurnId !== resolvedTurnId) return false
      turnId = resolvedTurnId
      background.primaryTurnId = resolvedTurnId
      if (!rootAcceptedPersisted) {
        rootAcceptedPersisted = true
        this.kernel.recordDispatch('accepted', threadId, connection.executorId)
      }
      if (!background.rootTerminal && !rootRunningEvidencePersisted) {
        rootRunningEvidencePersisted = true
        input.host?.lifecycle?.recordNativeEvidence?.({
          kind: 'running',
          source: 'live_runtime',
          identity: this.runtime.runIdentity(input, threadId, resolvedTurnId),
        })
      }
      drainPendingOwnedFacts(true)
      if (background.foregroundReleased && background.stopRequested && !background.rootTerminal) {
        void maybeInterruptRoot()
      }
      if (source !== 'ack') maybeSettle()
      return true
    }
    const handleOwnedNativeEvent = (event: object): boolean => {
      const nativeConnection = connection
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
        (typeof suppliedChild === 'string' &&
          this.runtime.retiredNativeChildren.has(suppliedChild)) ||
        (typeof suppliedThread === 'string' &&
          typeof suppliedTurn === 'string' &&
          this.runtime.retiredNativeTurns.has(JSON.stringify([suppliedThread, suppliedTurn])))
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
            handledNativeFactSeq += 1
            replayEarly()
          } else {
            background.untrackedWork = true
            reportUnknown('Native child ancestry exceeded its bounded observer.')
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
        return replaying ? false : bufferEarly(event)
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
          bindRootTurn(eventTurnId, 'user_message')
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
          reportUnknown('Native child Turn identities exceeded the bounded observer.')
          return true
        }
        background.turns.set(eventThread, eventTurnId)
        background.turnIds.add(JSON.stringify([eventThread, eventTurnId]))
        background.threads.add(eventThread)
        handledNativeFactSeq += 1
        // A-F1: Immediately replay child requests/items buffered before this child turn/started arrived.
        replayEarly(false)
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
          return replaying ? false : bufferEarly(event)
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
          (nullableTurn === null ||
            (typeof nullableTurn === 'string' && nullableTurn.length <= 1024))
        if (eventMethod === 'hook/completed' && !validIdentity) return false
        const key = validIdentity
          ? JSON.stringify(['hook', nativeConnection.executorId, eventThread, nullableTurn, hookId])
          : ''
        if (
          eventMethod === 'hook/started' &&
          root &&
          !replaying &&
          background.foregroundReleased &&
          nullableTurn === null &&
          !background.operations.has(key)
        )
          return false
        if (!validIdentity) {
          background.untrackedWork = true
          reportUnknown('Native Hook identity exceeded its bounded observer.')
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
            reportUnknown('Native Hook work exceeded its bounded operation owner.')
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
        maybeSettle()
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
          return background.operations.has(opKey) || approvalItems.has(opKey)
        })()
      if (root && !ownedTurn && !matchedDetachedLegacyRootRequest) return false
      // S3-F1: Pre-terminal queued foreground items already captured by the observer must still
      // flow to the active foreground consumer even if turn/completed arrived ahead on the wire.
      if (observed.has(event)) return !root || background.foregroundReleased
      observed.add(event)
      handledNativeFactSeq += 1
      if (
        root &&
        ownedTurn &&
        (eventMethod === 'item/started' || eventMethod === 'item/completed')
      ) {
        const item = Reflect.get(eventParams, 'item')
        if (item && typeof item === 'object' && Reflect.get(item, 'type') === 'plan')
          observePlanOperation()
      }
      if (root && ownedTurn && !background.rootTerminal && eventMethod === 'item/completed') {
        const item = Reflect.get(eventParams, 'item')
        if (item && typeof item === 'object') {
          if (Reflect.get(item, 'type') === 'agentMessage') {
            const id = Reflect.get(item, 'id'),
              text = Reflect.get(item, 'text')
            if (typeof id === 'string' && typeof text === 'string')
              projectOutput(() => answer.capture(id, text))
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
              capturePlan(id, text)
          } else {
            applyCodexWorkflowMcpToolCall({
              item,
              runId: input.runId,
              peerServerName: this.runtime.peerServerName,
              peerToolServer: this.runtime.peerToolServer,
              peerReceipt,
              capturePlan,
              captureRetainedPlan,
              captureInputResult,
              captureReview,
            })
          }
        }
      }
      if (eventMethod === 'turn/completed') {
        if (root) {
          const status =
            eventTurn && typeof eventTurn === 'object'
              ? Reflect.get(eventTurn, 'status')
              : undefined
          if (
            !background.rootTerminal &&
            (status === 'completed' || status === 'failed' || status === 'interrupted')
          ) {
            background.rootTerminal = true
            rootTerminalOutcome = status
            this.kernel.recordTerminal(status)
            if (sourceGrant) this.runtime.peerToolServer.retireSourceReader(sourceGrant)
            const settleTerminal = (): void => {
              if (!projectionFailure)
                this.runtime.recordTerminal(
                  input,
                  background.primaryThreadId!,
                  background.primaryTurnId!,
                  status,
                  answer,
                  status === 'completed'
                    ? { plan: submittedPlan, reviewResult, inputResult }
                    : undefined,
                )
              if (background.foregroundReleased) {
                emitArchivedTerminalSnapshot(status)
              }
            }
            if (background.steering && background.steeringDone) {
              // S3-F6: Persist compact terminal identity & outcome immediately on verified
              // turn/completed while Steer RPC is still in flight; defer only the
              // Steer-dependent final answer/workflow snapshot behind `steeringDone`.
              this.runtime.recordTerminal(
                input,
                background.primaryThreadId!,
                background.primaryTurnId!,
                status,
                { outputId: answer.outputId, text: '' },
              )
              const settling = background.steeringDone
                .then(settleTerminal)
                .catch((error: unknown) => {
                  projectionFailure = error
                  reportUnknown(
                    'Native completion could not be reconciled with its steering receipt.',
                  )
                })
              background.interactions.add(settling)
              void settling.finally(() => {
                background.interactions.delete(settling)
                maybeSettle()
              })
            } else {
              if (projectionFailure) {
                this.runtime.recordTerminal(
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
            const text = projectOutput(() => answer.append(itemId, delta))
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
              const completed = projectOutput(() => answer.complete(itemId, text))
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
          cacheApprovalItem(approvalItems, item, eventThread, eventTurnId)
          const itemId = Reflect.get(item, 'id'),
            type = Reflect.get(item, 'type')
          if (
            root &&
            ownedTurn &&
            !detachedRoot &&
            !signal.aborted &&
            !background.foregroundReleased &&
            nativeConnection === this.runtime.connection &&
            type === 'commandExecution' &&
            ['agent', 'unifiedExecStartup'].includes(String(Reflect.get(item, 'source')))
          ) {
            const processId = Reflect.get(item, 'processId')
            if (
              typeof itemId !== 'string' ||
              !itemId ||
              Buffer.byteLength(itemId) > 1024 ||
              (processId != null &&
                (typeof processId !== 'string' ||
                  !processId ||
                  Buffer.byteLength(processId) > 1024))
            ) {
              reportUnknown('Native foreground command identity could not be verified.')
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
                reportUnknown('Native foreground command ownership exceeded its bounded evidence.')
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
                reportUnknown('Native command observation exceeded its bounded item set.')
              }
            }
            if (
              ['collabAgentToolCall', 'collabToolCall'].includes(String(type)) &&
              Reflect.get(item, 'tool') === 'spawnAgent'
            ) {
              if (background.spawns.size < 64) background.spawns.add(key)
              else {
                background.untrackedWork = true
                reportUnknown('Native spawn observation exceeded its bounded item set.')
              }
            }
          }
        }
      }
      if (Object.hasOwn(event, 'id') && typeof eventMethod === 'string') {
        if (root && !background.foregroundReleased && !detachedRoot && !replaying) return false
        if (background.interactions.size >= 8) {
          reportUnknown('Native interactions exceeded their bounded request owner.')
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
        const interaction = this.runtime.connections
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
            handledRequests,
            approvalItems,
          )
          .catch(() => reportUnknown('Native background approval delivery could not be confirmed.'))
        background.interactions.add(interaction)
        void interaction.finally(() => {
          background.interactions.delete(interaction)
          maybeSettle()
        })
        if (root && replaying) return true
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
                  operationId: root
                    ? `${nativeId}:${index}`
                    : `${eventThread}:${nativeId}:${index}`,
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
            fileChangeRecordings.set(item, Promise.resolve())
            reportUnknown(
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
            fileChangeRecordings.set(item, recording)
            void recording.finally(() => {
              background.recordings.delete(recording)
              background.recordingBytes = Math.max(0, background.recordingBytes - evidenceBytes)
              maybeSettle()
            })
          }
        }
        if (item && typeof item === 'object')
          this.runtime.trackNativeBackground(
            background,
            item,
            eventThread,
            typeof eventTurnId === 'string' ? eventTurnId : undefined,
          )
        replayEarly()
      }
      maybeSettle()
      if (!root)
        nativeEffectsUncertain(
          input,
          'Native child/background work may include effects outside recorded file operations.',
        )
      return !root || background.foregroundReleased || detachedRoot
    }

    try {
      const resolvedPeerCandidate = this.runtime.resolvePeerTarget?.(input.sessionId)
      const expectedPeerTarget: RuntimeAgentId =
        resolvedPeerCandidate && resolvedPeerCandidate !== 'codex'
          ? resolvedPeerCandidate
          : 'claude'
      const expectedRecovery = input.host?.recovery?.expected
      connection = await this.runtime.connections.ensureConnection(
        input.cwd,
        expectedRecovery ? undefined : expectedPeerTarget,
        input.nativeSessionId,
      )
      if (
        expectedRecovery &&
        (expectedRecovery.executorId !== connection.executorId ||
          expectedRecovery.nativeSessionId !== input.nativeSessionId)
      )
        throw new NativeInputWithheldError(
          'The original native executor or Session changed. The replacement input was withheld.',
        )
      this.kernel.bindExecutor(connection.executorId)
      background.connection = connection
      this.runtime.nativeBackground.add(background)
      this.runtime.currentPeerTarget = expectedPeerTarget
      this.runtime.peerToolServer.setExpectedTarget(expectedPeerTarget)
      await this.runtime.connections.initializeConnection(connection, signal)
      background.sourceReadForm =
        this.runtime.nativeSourceContextSupported &&
        input.host?.workflow?.sourceReader?.readNativeRoot
          ? 'nativeRoot'
          : 'legacy'
      peerReceipt = this.runtime.peerToolServer.beginTurn(
        expectedPeerTarget,
        !workflow && input.peerAssistanceAllowed !== false,
        workflow,
        input.promptEnvelope.requestSessionTitle === true,
        hasSourceReader
          ? (raw) => {
              if (
                background.closed ||
                background.rootTerminal ||
                signal.aborted ||
                !connection?.isOpen
              )
                throw new Error('This source reader belongs to a retired root Turn.')
              return input.host!.workflow!.sourceReader!.read(raw).page
            }
          : undefined,
        sourceGrant,
        input.host?.workflow?.sourceReader,
        input.promptEnvelope.collaborationAuthorization,
        () =>
          !signal.aborted &&
          !background.rootTerminal &&
          !background.closed &&
          !background.cancellationPending &&
          !planOperationObserved &&
          !inputResult &&
          background.interactions.size === 0,
      )
      // Loaded Threads ignore resume config: their installed capability URL must stay stable.
      const peerToolUrl = await this.runtime.peerToolServer.start()
      const toolConfig = await this.runtime.connections.pactToolConfig(
        connection,
        peerToolUrl,
        input.cwd,
        signal,
        input.permissionMode,
      )
      const phasePolicy = collaborationReadOnly(
        workflow,
        input.promptEnvelope.collaborationAuthorization,
      )
        ? {
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
          }
        : toolConfig.settingsPolicy
      const nativeConnection = connection
      releaseApprovalMetadata = nativeConnection.subscribeBackground((event) => {
        // Settings ACK belongs to the current next-task update, not an older Run.
        if (Reflect.get(event, 'method') === 'thread/settings/updated') return false
        if (handleOwnedNativeEvent(event)) return true
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
            (threadId ?? provisionalThreadId ?? input.nativeSessionId)
        )
          return false
        const item = Reflect.get(params, 'item')
        if (item && typeof item === 'object' && Reflect.get(event, 'method') === 'item/started')
          cacheApprovalItem(
            approvalItems,
            item,
            Reflect.get(params, 'threadId'),
            Reflect.get(params, 'turnId'),
          )
        return false
      })
      releaseNativeRequests = nativeConnection.subscribeServerRequests((request) => {
        if (handleOwnedNativeEvent(request)) return true
        const method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') return false
        const nativeThread =
          Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId')
        const requestedTurn = Reflect.get(params, 'turnId')
        const expectedThread = threadId ?? provisionalThreadId ?? input.nativeSessionId
        if (
          !threadStartupDispatched ||
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
          rejectServerRequest(request, 'This native request is not valid before Turn dispatch.')
          return true
        }
        provisionalThreadId ??= nativeThread
        if (delivery.phase !== 'before_dispatch') {
          if (!turnId) return bufferEarly(request)
          if (typeof requestedTurn === 'string' && turnId !== requestedTurn) {
            rejectServerRequest(request, 'This native request does not belong to the active Turn.')
            return true
          }
        }
        if (background.interactions.size >= 8) {
          reportUnknown('Native interactions exceeded their bounded request owner.')
          rejectServerRequest(
            request,
            'Pact cannot display another native interaction within its request budget. No approval response was sent.',
          )
          return true
        }
        const interaction = this.runtime.connections
          .relayPermission(
            nativeConnection,
            request,
            method,
            params,
            relayPermissionInputFromRun(input),
            nativeThread,
            turnId,
            foregroundInteractionSignal,
            handledRequests,
            approvalItems,
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
          maybeSettle()
        })
        return true
      })

      // Native resume preserves the installed stable capability for a loaded Thread.
      {
        if (input.nativeSessionId) {
          await this.runtime.connections.awaitSettingsBarrier(
            connection,
            input.nativeSessionId,
            signal,
          )
        }
        const startupRequest = buildCodexStartupRequest(input, toolConfig)
        const startupOp = connection.requestOwned(startupRequest.method, startupRequest.params, {
          timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS,
          signal,
          // A-F4: If Stop/timeout aborted foreground after thread startup write and before reply,
          // bind the late reply to replay startup hooks, mark root Turn not started (never sending
          // turn/start or fabricating confirmed-unsent), and let maybeSettle release cleanly.
          onLateReply: (lateMessage) => {
            if (background.closed || background.rootNotStarted) return
            if (Reflect.get(lateMessage, 'error')) {
              markRootNotStartedIfUnsent(input.nativeSessionId)
              maybeSettle()
              return
            }
            const lateResult = Reflect.get(lateMessage, 'result')
            const lateThread =
              lateResult && typeof lateResult === 'object'
                ? Reflect.get(lateResult, 'thread')
                : null
            const lateThreadId =
              lateThread && typeof lateThread === 'object'
                ? Reflect.get(lateThread, 'id')
                : undefined
            if (
              typeof lateThreadId === 'string' &&
              lateThreadId &&
              lateThreadId.length <= 1024 &&
              (!input.nativeSessionId || input.nativeSessionId === lateThreadId) &&
              (!provisionalThreadId || provisionalThreadId === lateThreadId)
            ) {
              threadId = lateThreadId
              background.primaryThreadId = lateThreadId
              drainPendingOwnedFacts(false)
              markRootNotStartedIfUnsent(lateThreadId)
              maybeSettle()
            } else {
              reportUnknown(
                'Codex late thread startup reply carried an invalid or mismatched thread identity.',
              )
              markRootNotStartedIfUnsent(input.nativeSessionId)
              maybeSettle()
            }
          },
        })
        threadStartupDispatched = startupOp.requestId !== null
        void startupOp.physicalCompletion
          .then((completion) => {
            if (completion === 'not_sent') {
              markRootNotStartedIfUnsent(input.nativeSessionId)
              maybeSettle()
            }
            return undefined
          })
          .catch(() => undefined)
        const message = await startupOp.result
        threadStartupCompleted = true
        const rpcError = Reflect.get(message, 'error')
        if (rpcError) {
          // An explicit startup rejection proves no Turn was submitted. This is
          // not a completed Turn; outstanding startup interactions still drain.
          markRootNotStartedIfUnsent(input.nativeSessionId)
          throw classifyCodexStartupRejection(rpcError, input.nativeSessionId)
        }
        const result = Reflect.get(message, 'result')
        const thread = result && typeof result === 'object' ? Reflect.get(result, 'thread') : null
        const resolvedModel =
          result && typeof result === 'object' ? Reflect.get(result, 'model') : undefined
        const resolvedEffort =
          result && typeof result === 'object' ? Reflect.get(result, 'reasoningEffort') : undefined
        const resolvedThreadId =
          thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
        if (typeof resolvedThreadId !== 'string') {
          throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
        }
        if (input.nativeSessionId && input.nativeSessionId !== resolvedThreadId) {
          markRootNotStartedIfUnsent(input.nativeSessionId)
          // S3-F7: Thread ID mismatch is a protocol contradiction, NOT proof the saved thread is missing.
          throw new AgentExecutionError(
            'protocol_error',
            'Codex resumed a different native Thread. The original binding was preserved.',
            false,
          )
        }
        if (provisionalThreadId && provisionalThreadId !== resolvedThreadId)
          throw new AgentExecutionError(
            'protocol_error',
            'Codex returned a Thread different from its startup interaction.',
            false,
          )
        threadId = resolvedThreadId
        background.primaryThreadId = threadId
        replayEarly()
        let appliedPolicy: object
        try {
          if (
            input.nativeSessionId ||
            collaborationReadOnly(workflow, input.promptEnvelope.collaborationAuthorization)
          )
            appliedPolicy = await this.runtime.connections.applyPermissionSettings(
              connection,
              resolvedThreadId,
              phasePolicy,
              signal,
              message,
              background,
              maybeSettle,
            )
          else {
            confirmPermissionMode(message, input.permissionMode)
            appliedPolicy = permissionReadback(message)
          }
        } catch (error) {
          background.rootNotStarted = true
          this.kernel.recordDispatch('rejected', resolvedThreadId, connection.executorId)
          throw error
        }
        const priorConfig = this.runtime.loadedThreadConfigurations.get(resolvedThreadId)
        this.runtime.connections.rememberThread(
          resolvedThreadId,
          priorConfig ? { ...priorConfig, peerTargetAgentId: expectedPeerTarget } : undefined,
        )
        recoveryConfiguration = buildCodexRecoveryConfiguration(
          input,
          resolvedModel,
          resolvedEffort,
          appliedPolicy,
        )
        if (typeof resolvedModel === 'string' && resolvedModel) {
          const configuration = resolveCodexThreadConfiguration(input, {
            model: resolvedModel,
            ...(typeof resolvedEffort === 'string' ? { reasoningEffort: resolvedEffort } : {}),
          })
          this.runtime.connections.rememberThread(resolvedThreadId, {
            ...configuration,
            peerTargetAgentId: expectedPeerTarget,
          })
          yield* resolvedModelEvent(configuration)
        }
        yield { agentId: 'codex', type: 'session.started', nativeSessionId: threadId }
        observeThreadTitle(thread, input.host?.lifecycle?.observeNativeTitle)
        const existingTitle = threadTitle(thread)
        if (existingTitle) {
          lastSuggestedTitle = existingTitle
          yield { agentId: 'codex', type: 'session.title.updated', title: existingTitle }
        }
      }

      if (!threadId) {
        throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
      }
      this.runtime.preflightPrompt({ ...input, nativeSessionId: threadId })
      if (input.promptEnvelope.skillInvocation) {
        const selected = input.promptEnvelope.skillInvocation.bindings.filter(
          (entry) => entry.agentId === 'codex',
        )
        const current = await this.runtime.discoverSkills(input.cwd, signal)
        if (selected.some((entry) => !current.some((candidate) => candidate.id === entry.id)))
          throw new AgentExecutionError(
            'protocol_error',
            'The native Skill catalog changed before this task was sent.',
            false,
          )
      }
      const acceptanceDeadline = Date.now() + CODEX_TURN_ACCEPT_TIMEOUT_MS
      const modeConfiguration = this.runtime.loadedThreadConfigurations.get(threadId)
      const modeModel = input.model ?? modeConfiguration?.model
      if (!modeModel)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Codex did not resolve the model required by its native collaboration mode. Nothing was submitted.',
          false,
        )
      const speed = await this.runtime.connections.resolveTurnSpeed(
        connection,
        input.speed ?? 'native',
        input.model ?? this.runtime.loadedThreadConfigurations.get(threadId)?.model,
        signal,
        acceptanceDeadline,
      )
      const recoverySettings =
        input.host?.recovery && recoveryConfiguration
          ? buildCodexRecoverySettings(
              input,
              recoveryConfiguration,
              modeModel,
              speed.serviceTier,
              workflow,
            )
          : undefined
      if (recoverySettings && input.host?.recovery) {
        input.host.recovery.recordEffectiveSettings(recoverySettings, {
          executorId: connection.executorId,
          nativeSessionId: threadId,
        })
      }
      if (
        input.host?.recovery?.expected &&
        (!recoverySettings ||
          !isDeepStrictEqual(recoverySettings, input.host?.recovery.expected.settings))
      )
        throw new NativeInputWithheldError(
          'The native execution settings could not be confirmed unchanged. The replacement input was withheld.',
        )
      await this.runtime.connections.awaitSettingsBarrier(connection, threadId, signal)
      // S3-F5: Construct complete turn/start params BEFORE calling requestOwned / setting
      // rootTurnRequested so a retired FrozenSourceReader throw never strands an unsent observer.
      const turnStartParams = buildCodexTurnStartParams({
        threadId,
        input,
        workflow,
        authorization: input.promptEnvelope.collaborationAuthorization,
        sourceReader: input.host?.workflow?.sourceReader,
        sourceReadForm: background.sourceReadForm ?? 'legacy',
        withSourceCallable: (text) => this.runtime.withSourceCallable(text),
        phasePolicy,
        modeModel,
        modeEffort: modeConfiguration?.effort,
        serviceTier: speed.serviceTier,
      })
      const rootOperation = connection.requestOwned('turn/start', turnStartParams, {
        timeoutMs: Math.max(1, acceptanceDeadline - Date.now()),
        signal,
        canDispatch: input.host?.recovery?.expected
          ? () => {
              if (input.host?.recovery?.canDispatch?.() === true) return true
              inputWithheldError = new NativeInputWithheldError(
                'The replacement authority changed before native input delivery.',
              )
              background.rootInputWithheld = true
              markRootNotStartedIfUnsent(threadId)
              return false
            }
          : undefined,
        onDispatch: () => {
          try {
            this.kernel.recordDispatch('possibly_sent', threadId, nativeConnection.executorId)
          } catch (error) {
            if (error instanceof NativeInputWithheldError) {
              inputWithheldError = error
              background.rootInputWithheld = true
              markRootNotStartedIfUnsent(threadId)
            }
            throw error
          }
          delivery.phase = 'possibly_delivered'
        },
        // S3-F4 & A-F3: Unified late-ACK binding through bindRootTurn so identity persistence,
        // arrival-order fact replay, and one-shot Stop interruption share one transition.
        onLateReply: (lateMessage) => {
          if (background.closed || background.rootNotStarted) return
          if (Reflect.get(lateMessage, 'error')) {
            if (!background.primaryTurnId) {
              markRootNotStartedIfUnsent(threadId)
              maybeSettle()
            }
            return
          }
          const lateResult = Reflect.get(lateMessage, 'result')
          const lateTurn =
            lateResult && typeof lateResult === 'object' ? Reflect.get(lateResult, 'turn') : null
          const lateTurnId =
            lateTurn && typeof lateTurn === 'object' ? Reflect.get(lateTurn, 'id') : undefined
          if (typeof lateTurnId !== 'string' || !lateTurnId || lateTurnId.length > 1024) {
            reportUnknown('Codex late turn/start reply carried an invalid Turn identity.')
            releaseRootStartupEarly()
            maybeSettle()
            return
          }
          bindRootTurn(lateTurnId, 'late_ack')
        },
      })
      rootTurnRequested = rootOperation.requestId !== null
      {
        const recovery = input.host?.recovery
        const identity = { executorId: connection.executorId, nativeSessionId: threadId }
        const requestId = rootOperation.requestId
        // Only the actual writer's joined result proves that this exact root
        // frame never reached stdin. RPC rejection/EOF/timeout is insufficient.
        void rootOperation.physicalCompletion
          .then((completion) => {
            if (completion === 'not_sent') {
              markRootNotStartedIfUnsent(threadId)
              if (recovery && requestId !== null) {
                recovery.recordConfirmedUnsent(
                  { kind: 'codex_root_frame_not_written', requestId },
                  identity,
                )
              }
              maybeSettle()
            }
            return undefined
          })
          .catch(() => undefined)
      }
      const turnResponse = await rootOperation.result
      const turnRpcError = Reflect.get(turnResponse, 'error')
      if (turnRpcError) {
        delivery.phase = 'before_dispatch'
        if (!background.primaryTurnId) markRootNotStartedIfUnsent(threadId)
        throw classifyCodexRpcError(turnRpcError, 'Codex rejected turn/start.')
      }
      const turnResult = Reflect.get(turnResponse, 'result')
      const turn =
        turnResult && typeof turnResult === 'object' ? Reflect.get(turnResult, 'turn') : null
      const resolvedTurnId = turn && typeof turn === 'object' ? Reflect.get(turn, 'id') : undefined
      if (typeof resolvedTurnId !== 'string') {
        throw new AgentExecutionError('protocol_error', 'Codex returned no Turn ID.', false)
      }
      if (!bindRootTurn(resolvedTurnId, 'ack')) {
        turnId = undefined
        background.primaryTurnId = undefined
        throw new AgentExecutionError(
          'protocol_error',
          'Codex acknowledged a different Turn from its confirmed user message identity.',
          false,
        )
      }
      if (sourceGrant && background.sourceReadForm === 'nativeRoot' && !background.rootTerminal)
        this.runtime.peerToolServer.bindNativeSourceRoot(
          sourceGrant,
          { executorId: connection.executorId, threadId, turnId: resolvedTurnId },
          () =>
            this.runtime.connection === nativeConnection &&
            nativeConnection.isOpen &&
            !this.runtime.disposed &&
            !background.closed &&
            !background.rootTerminal &&
            !signal.aborted,
        )
      delivery.phase = 'accepted'
      yield {
        agentId: 'codex',
        type: 'run.speed.resolved',
        requested: input.speed ?? 'native',
        ...(speed.serviceTier === 'default' ? { speed: 'standard' as const } : {}),
        ...(speed.detail ? { detail: speed.detail } : {}),
      }
      yield { agentId: 'codex', type: 'turn.started', turnId: resolvedTurnId }

      let streamObserver = input.host?.lifecycle?.observeNativeDelta
      while (delivery.phase !== 'terminal') {
        // The Adapter consumes only provider notifications; RPC responses are routed independently.
        // oxlint-disable-next-line no-await-in-loop
        const message = await connection.nextNotification(undefined, signal)
        const method = Reflect.get(message, 'method')
        const params = Reflect.get(message, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') continue
        if (
          streamObserver &&
          (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta')
        ) {
          const delta = Reflect.get(params, 'delta')
          if (typeof delta === 'string' && delta.length) {
            const sourceThread = Reflect.get(params, 'threadId'),
              sourceTurn = Reflect.get(params, 'turnId')
            try {
              streamObserver({
                kind: method === 'item/agentMessage/delta' ? 'text' : 'reasoning',
                identity:
                  typeof sourceThread !== 'string' || typeof sourceTurn !== 'string' || !turnId
                    ? 'missing_identity'
                    : sourceThread !== threadId
                      ? 'foreign_thread'
                      : sourceTurn !== turnId
                        ? 'foreign_turn'
                        : 'matched',
                bytes: Buffer.byteLength(delta, 'utf8'),
              })
            } catch {
              streamObserver = undefined
            }
          }
        }
        // The cached connection can still deliver notifications from an earlier Turn or missing threadId.
        // Filter strict (threadId, turnId) ownership BEFORE awaiting steeringDone or projecting (S3-F2/S3-F6).
        const notificationThreadId =
          Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId')
        const notificationTurn = Reflect.get(params, 'turn')
        const notificationTurnId =
          Reflect.get(params, 'turnId') ??
          (notificationTurn && typeof notificationTurn === 'object'
            ? Reflect.get(notificationTurn, 'id')
            : undefined)
        const isCurrentRootMessage =
          notificationThreadId === threadId && notificationTurnId === turnId
        if (background.steering && background.steeringDone && isCurrentRootMessage) {
          const item = Reflect.get(params, 'item')
          if (
            method === 'turn/completed' ||
            (method === 'item/completed' &&
              item &&
              typeof item === 'object' &&
              Reflect.get(item, 'type') === 'agentMessage' &&
              Reflect.get(item, 'phase') !== 'commentary')
          )
            // oxlint-disable-next-line no-await-in-loop -- One same-owner steering RPC has its existing absolute deadline.
            await background.steeringDone
        }
        if (handleOwnedNativeEvent(message)) continue
        if (typeof notificationThreadId === 'string' && notificationThreadId !== threadId) {
          const requestId = Reflect.get(message, 'id')
          if (typeof requestId === 'string' || typeof requestId === 'number')
            // oxlint-disable-next-line no-await-in-loop -- Explicitly reject an unowned native request.
            await connection.respondError(requestId, 'This native thread is not owned by the Run.')
          continue
        }
        if (
          method === 'error' &&
          (notificationThreadId !== threadId || notificationTurnId !== turnId)
        ) {
          foreignErrorNotifications = Math.min(
            Number.MAX_SAFE_INTEGER,
            foreignErrorNotifications + 1,
          )
          if (foreignErrorNotifications === 1)
            recordDiagnostic({
              operation: 'native_check',
              phase: 'dropped',
              level: 'warn',
              scope: 'run',
              agentId: 'codex',
              sessionId: input.sessionId,
              runId: input.runId,
              runtimeBoundary: 'native_notification',
              count: foreignErrorNotifications,
            })
          continue
        }
        if (
          (method.startsWith('item/') || method === 'turn/completed') &&
          (notificationThreadId !== threadId || notificationTurnId !== turnId)
        )
          continue
        if (typeof notificationTurnId === 'string' && notificationTurnId !== turnId) {
          const requestId = Reflect.get(message, 'id')
          if (typeof requestId === 'string' || typeof requestId === 'number')
            // oxlint-disable-next-line no-await-in-loop -- Explicitly reject an unowned native request.
            await connection.respondError(
              requestId,
              'This native request does not belong to the active Turn.',
            )
          continue
        }
        if (method === 'thread/name/updated') {
          const eventThreadId = Reflect.get(params, 'threadId')
          const rawTitle = Reflect.get(params, 'threadName')
          const title = cleanTitle(rawTitle)
          if (eventThreadId === threadId && typeof rawTitle === 'string' && rawTitle.trim())
            input.host?.lifecycle?.observeNativeTitle?.(threadId, title)
          if (eventThreadId === threadId && title && title !== lastSuggestedTitle) {
            lastSuggestedTitle = title
            yield { agentId: 'codex', type: 'session.title.updated', title }
          }
        } else if (method === 'model/rerouted') {
          const eventThreadId = Reflect.get(params, 'threadId')
          const eventTurnId = Reflect.get(params, 'turnId')
          const toModel = Reflect.get(params, 'toModel')
          if (
            acceptsCodexReroute(threadId, turnId, eventThreadId, eventTurnId) &&
            typeof toModel === 'string' &&
            toModel
          ) {
            const current = this.runtime.loadedThreadConfigurations.get(eventThreadId)
            const configuration = {
              model: toModel,
              effort: input.effort ?? current?.effort ?? null,
            }
            this.runtime.connections.rememberThread(eventThreadId, configuration)
            yield* resolvedModelEvent(configuration)
          }
        } else if (method === 'item/started') {
          const item = Reflect.get(params, 'item')
          if (!turnId || !item || typeof item !== 'object') continue
          const itemId = Reflect.get(item, 'id')
          cacheApprovalItem(approvalItems, item, threadId, turnId)
          if (Reflect.get(item, 'type') === 'reasoning' && typeof itemId === 'string') continue
          if (
            isPeerTool(item, this.runtime.peerServerName) ||
            (Reflect.get(item, 'type') === 'mcpToolCall' &&
              Reflect.get(item, 'server') === this.runtime.peerServerName &&
              [
                'publish_session_title',
                'submit_review',
                'submit_input_result',
                'retain_current_plan',
                'publish_plan',
              ].includes(String(Reflect.get(item, 'tool'))))
          )
            continue
          const activity = describeTool(item, input.cwd, false)
          if (activity) {
            yield {
              agentId: 'codex',
              type: 'tool.started',
              turnId,
              toolCallId: activity.toolCallId,
              toolName: activity.toolName,
              title: activity.title,
              ...(activity.detail ? { detail: activity.detail } : {}),
            }
          }
        } else if (method === 'item/reasoning/summaryTextDelta') {
          const delta = Reflect.get(params, 'delta')
          const itemId = Reflect.get(params, 'itemId')
          if (turnId && typeof itemId === 'string' && typeof delta === 'string') {
            const outcome = reasoningSummaries.pushDelta(itemId, delta)
            if (outcome.kind === 'overflow') {
              failProjection(outcome.error)
            } else if (outcome.kind === 'emit') {
              yield {
                agentId: 'codex',
                type: 'reasoning.summary.delta',
                turnId,
                activityId: itemId,
                text: outcome.text,
              }
            }
          }
        } else if (method === 'item/agentMessage/delta') {
          const delta = Reflect.get(params, 'delta')
          const itemId = Reflect.get(params, 'itemId')
          if (typeof delta === 'string' && typeof itemId === 'string') {
            if (!turnId) continue
            const appended = projectOutput(() => answer.append(itemId, delta))
            if (appended !== undefined)
              yield {
                agentId: 'codex',
                type: 'text.delta',
                turnId,
                outputId: answer.outputId,
                text: appended,
              }
          }
        } else if (method === 'item/completed') {
          const item = Reflect.get(params, 'item')
          if (!item || typeof item !== 'object' || !turnId) continue
          if (Reflect.get(item, 'type') === 'agentMessage') {
            const text = Reflect.get(item, 'text')
            const itemId = Reflect.get(item, 'id')
            if (typeof text === 'string' && typeof itemId === 'string') {
              const completed = projectOutput(() => answer.complete(itemId, text))
              if (completed !== undefined)
                yield {
                  agentId: 'codex',
                  type: 'text.completed',
                  turnId,
                  outputId: answer.outputId,
                  text: completed,
                }
            }
          } else if (Reflect.get(item, 'type') === 'reasoning') {
            const itemId = Reflect.get(item, 'id')
            const text = reasoningSummary(item)
            if (typeof itemId === 'string') reasoningSummaries.complete(itemId)
            if (typeof itemId === 'string' && text) {
              yield {
                agentId: 'codex',
                type: 'reasoning.summary.completed',
                turnId,
                activityId: itemId,
                text,
              }
            }
          } else if (
            input.promptEnvelope.requestSessionTitle &&
            Reflect.get(item, 'type') === 'mcpToolCall' &&
            Reflect.get(item, 'server') === this.runtime.peerServerName &&
            Reflect.get(item, 'tool') === 'publish_session_title'
          ) {
            const result = Reflect.get(item, 'result')
            const structured =
              result && typeof result === 'object'
                ? Reflect.get(result, 'structuredContent')
                : undefined
            const receipt =
              structured && typeof structured === 'object'
                ? Reflect.get(structured, 'pactSessionTitle')
                : undefined
            if (
              notificationThreadId === threadId &&
              Reflect.get(item, 'status') === 'completed' &&
              Reflect.get(item, 'error') === null &&
              receipt &&
              typeof receipt === 'object' &&
              Reflect.get(receipt, 'accepted') === true &&
              Reflect.get(receipt, 'receipt') === this.runtime.peerToolServer.capabilityReceipt
            ) {
              const title = this.runtime.peerToolServer.acceptSessionTitle(
                Reflect.get(item, 'arguments'),
                peerReceipt,
              )
              if (title)
                yield {
                  agentId: 'codex',
                  type: 'session.title.updated',
                  title,
                  origin: 'turn_result',
                }
            }
          } else if (
            Reflect.get(item, 'type') === 'plan' ||
            (Reflect.get(item, 'type') === 'mcpToolCall' &&
              Reflect.get(item, 'server') === this.runtime.peerServerName &&
              [
                'submit_review',
                'submit_input_result',
                'retain_current_plan',
                'publish_plan',
              ].includes(String(Reflect.get(item, 'tool'))))
          ) {
            // Root plan/review metadata was captured by the owned native observer.
          } else if (isPeerTool(item, this.runtime.peerServerName)) {
            const proposal = peerProposal(
              item,
              turnId,
              this.runtime.peerToolServer.capabilityReceipt,
              this.runtime.peerServerName,
              expectedPeerTarget,
            )
            if (
              proposal &&
              notificationThreadId === threadId &&
              !peerProposalEmitted &&
              this.runtime.peerToolServer.acceptCompleted(
                Reflect.get(item, 'arguments'),
                peerReceipt,
              )
            ) {
              peerProposalEmitted = true
              yield proposal
            }
          } else {
            if (Reflect.get(item, 'type') === 'fileChange') {
              const pendingRecording = fileChangeRecordings.get(item)
              if (pendingRecording) {
                // oxlint-disable-next-line no-await-in-loop -- Preserve applied native operation order.
                await pendingRecording
              }
            } else if (
              [
                'commandExecution',
                'mcpToolCall',
                'collabAgentToolCall',
                'collabToolCall',
                'dynamicToolCall',
              ].includes(String(Reflect.get(item, 'type'))) &&
              !(
                Reflect.get(item, 'type') === 'mcpToolCall' &&
                Reflect.get(item, 'server') === this.runtime.peerServerName &&
                Reflect.get(item, 'tool') === 'read_collaboration_source'
              )
            ) {
              nativeEffectsUncertain(
                input,
                'Native shell, MCP or child-Agent effects are not fully represented by file operation results.',
              )
            }
            const activity = describeTool(item, input.cwd, true)
            if (activity) {
              yield {
                agentId: 'codex',
                type: 'tool.completed',
                turnId,
                toolCallId: activity.toolCallId,
                toolName: activity.toolName,
                title: activity.title,
                ...(activity.detail ? { detail: activity.detail } : {}),
                outcome: toolFailed(item) ? 'failed' : 'completed',
              }
            }
          }
        } else if (method === 'turn/completed') {
          const completedTurn = Reflect.get(params, 'turn')
          if (!completedTurn || typeof completedTurn !== 'object') continue
          const status = Reflect.get(completedTurn, 'status')
          if (!turnId) continue
          if (!['completed', 'failed', 'interrupted'].includes(String(status))) continue
          delivery.phase = 'terminal'
          if (projectionFailure) throw projectionFailure
          if (status === 'failed') {
            const error = Reflect.get(completedTurn, 'error')
            throw classifyCodexRpcError(error, 'Codex Run failed.')
          }
          const finalText = answer.finalize() ?? (submittedPlan && !answer.text ? '' : undefined)
          if (finalText !== undefined)
            yield {
              agentId: 'codex',
              type: 'text.completed',
              turnId,
              outputId: answer.outputId,
              text: finalText,
            }
          if (status === 'completed') {
            if (submittedPlan)
              yield { agentId: 'codex', type: 'collaboration.plan', turnId, ...submittedPlan }
            if (reviewResult)
              yield {
                agentId: 'codex',
                type: 'collaboration.review',
                turnId,
                ...reviewResult,
              }
          }
          foregroundTurnCompletedYielded = true
          yield {
            agentId: 'codex',
            type: 'turn.completed',
            turnId,
            outcome: status === 'interrupted' ? 'interrupted' : 'completed',
          }
        } else if (method === 'error') {
          const nativeError = Reflect.get(params, 'error'),
            willRetry = Reflect.get(params, 'willRetry')
          const rawMessage =
            nativeError && typeof nativeError === 'object'
              ? Reflect.get(nativeError, 'message')
              : undefined
          if (typeof willRetry !== 'boolean' || typeof rawMessage !== 'string')
            throw new AgentExecutionError(
              'protocol_error',
              'Invalid owned native error notification.',
              false,
            )
          const classified = classifyAgentError(new Error(rawMessage))
          const failure = new AgentExecutionError(
            classified.kind,
            sanitizeNativeTerminalFailure(rawMessage) || 'Codex reported a native error.',
            classified.retryable,
          )
          if (willRetry) {
            retryNotifications = Math.min(Number.MAX_SAFE_INTEGER, retryNotifications + 1)
            if (retryNotifications === 1)
              recordDiagnostic({
                operation: 'native_check',
                phase: 'dispatched',
                level: 'warn',
                scope: 'run',
                agentId: 'codex',
                sessionId: input.sessionId,
                runId: input.runId,
                runtimeBoundary: 'native_notification',
                nativeWillRetry: true,
                code: failure.kind,
                count: retryNotifications,
              })
            // Native retries the same owned Turn. Keep observing; Pact never starts another.
            continue
          }
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            agentId: 'codex',
            sessionId: input.sessionId,
            runId: input.runId,
            runtimeBoundary: 'native_notification',
            nativeWillRetry: false,
            code: failure.kind,
          })
          throw failure
        } else if (Object.hasOwn(message, 'id')) {
          input.host?.lifecycle?.recordNativeEvidence?.({
            kind: 'waiting_user',
            source: 'live_runtime',
            identity: this.runtime.runIdentity(input, threadId, turnId),
          })
          // oxlint-disable-next-line no-await-in-loop -- A native approval is one ordered request/reply exchange.
          await this.runtime.connections.relayPermission(
            connection,
            message,
            method,
            params,
            relayPermissionInputFromRun(input),
            threadId,
            turnId,
            signal,
            handledRequests,
            approvalItems,
          )
          if (!background.rootTerminal)
            input.host?.lifecycle?.recordNativeEvidence?.({
              kind: 'running',
              source: 'live_runtime',
              identity: this.runtime.runIdentity(input, threadId, turnId),
            })
        } else if (
          method === 'mcpServer/elicitation/complete' ||
          method === 'mcpServer/elicitation/completed'
        ) {
          // This is native progress, not a Pact assertion that OAuth succeeded.
        }
      }
    } catch (error) {
      // The frame writer wraps callback failures. Preserve the host's exact
      // proven-unsent reason instead of mistaking that wrapper for native work.
      const failure = inputWithheldError ?? classifyAgentError(error)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'run',
        agentId: 'codex',
        sessionId: input.sessionId,
        runId: input.runId,
        runtimeBoundary: 'foreground',
        code: failure.kind,
        runtimeErrorType:
          diagnosticEventSchema.shape.runtimeErrorType.safeParse(
            error instanceof Error ? error.name : 'other',
          ).data ?? 'other',
      })
      if (!threadStartupDispatched || (threadStartupCompleted && !rootTurnRequested)) {
        markRootNotStartedIfUnsent()
      }
      if (!background.rootTerminal && !background.rootNotStarted && threadId)
        input.host?.lifecycle?.recordNativeEvidence?.({
          kind: 'no_evidence',
          identity: this.runtime.runIdentity(input, threadId, turnId),
          reason: 'The native stream ended without a matching terminal receipt.',
        })
      // A foreground deadline/error does not prove native commands or descendants stopped.
      // Actual connection loss is retired by detachConnection, not by killing a healthy server.
      if (
        !background.rootTerminal &&
        (delivery.phase === 'possibly_delivered' ||
          (delivery.phase === 'accepted' &&
            [
              'transient_transport',
              'agent_process_crash',
              'protocol_error',
              'response_too_large',
            ].includes(failure.kind)))
      ) {
        throw new AgentExecutionError(
          'unknown_delivery',
          'Codex may have received the Turn, but Pact could not confirm its final state.',
          false,
          failure.kind === 'response_too_large' ? 'response_too_large' : undefined,
        )
      }
      throw failure
    } finally {
      signal.removeEventListener('abort', freezeForegroundCommands)
      background.foregroundReleased = true
      // A-F5: If verified root terminal arrived before foreground exited (e.g., while paused
      // on fileChange recording or run.speed.resolved), hand off any undelivered authoritative
      // answer to RunOutputArchiver BEFORE answer.dispose() runs.
      if (
        background.rootTerminal &&
        rootTerminalOutcome &&
        !foregroundTurnCompletedYielded &&
        !archivedTurnCompletedEmitted &&
        !projectionFailure
      ) {
        const outcome = rootTerminalOutcome
        if (background.steering && background.steeringDone) {
          const handoff = background.steeringDone
            .then(() => {
              emitArchivedTerminalSnapshot(outcome)
              return undefined
            })
            .catch(() => undefined)
          background.interactions.add(handoff)
          void handoff.finally(() => {
            background.interactions.delete(handoff)
            maybeSettle()
          })
        } else {
          emitArchivedTerminalSnapshot(outcome)
        }
      }
      if (background.closed) answer.dispose()
      if (peerReceipt) this.runtime.peerToolServer.endTurn(peerReceipt)
      if (
        sourceGrant &&
        (background.rootTerminal ||
          background.rootNotStarted ||
          signal.aborted ||
          !connection?.isOpen)
      )
        this.runtime.peerToolServer.retireSourceReader(sourceGrant)
      if (retryNotifications || foreignErrorNotifications)
        recordDiagnostic({
          operation: 'native_check',
          phase: background.rootTerminal ? 'completed' : 'interrupted',
          scope: 'run',
          agentId: 'codex',
          sessionId: input.sessionId,
          runId: input.runId,
          runtimeBoundary: 'native_notification',
          nativeWillRetry: retryNotifications > 0,
          count: retryNotifications + foreignErrorNotifications,
        })
      const finallyInterrupt = maybeInterruptRoot(stoppedCommands, false)
      if (finallyInterrupt) {
        await finallyInterrupt
      }
      stoppedCommands?.clear()
      background.cancellationPending = false
      this.runtime.running = false
      if (!threadStartupDispatched || (threadStartupCompleted && !rootTurnRequested)) {
        markRootNotStartedIfUnsent()
      }
      if (!connection?.isOpen) {
        if (!background.rootNotStarted) background.unknown = true
        await Promise.allSettled(background.recordings)
        this.runtime.settleNativeBackground(background)
      } else {
        if (!background.rootTerminal && !background.rootNotStarted)
          // The background observer still receives every frame on this live connection.
          // Its later exact terminal and fully drained work can settle this temporary state.
          reportUnknown(
            'The foreground ended without proof that native work finished.',
            'unlisted',
            'awaiting_terminal',
          )
        maybeSettle()
      }
      if (background.closed) {
        await this.kernel.settle()
      }
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }
}
