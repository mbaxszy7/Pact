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
  awaitWithinStopBudget,
  readRunStopAbortReason,
  remainingStopBudgetMs,
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
  isUserStopCancellationError,
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
import { nativeEffectsUncertain } from '../native-file-changes'
import { NativeWorkingMemory } from '../native-working-memory'
import { TurnResourceScope } from '../turn-resource-scope'
import { CodexTurnNativeObserver } from './native-event-observer'
import {
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TURN_ACCEPT_TIMEOUT_MS,
  CodexReasoningSummaryTracker,
  acceptsCodexReroute,
  buildCodexRecoveryConfiguration,
  buildCodexRecoverySettings,
  buildCodexStartupRequest,
  buildCodexTurnStartParams,
  classifyCodexRpcError,
  classifyCodexStartupRejection,
  cleanTitle,
  confirmPermissionMode,
  describeTool,
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
  type CodexAdapterRuntime,
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
      const stopAbort = readRunStopAbortReason(signal)
      await rejectBeforeStart(
        stopAbort?.reason === 'user_stop'
          ? new AgentExecutionError('user_stopped', 'Stopped by the user.', false)
          : new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
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
    let observerRef: CodexTurnNativeObserver | undefined
    const freezeForegroundCommands = (): void => {
      const stopAbort = readRunStopAbortReason(signal)
      this.kernel.requestAbort(stopAbort?.reason, stopAbort?.deadlineAt)
      background.stopRequested = true
      if (background.closed || stoppedCommands) return
      if (sourceGrant) this.runtime.peerToolServer.retireSourceReader(sourceGrant)
      stoppedCommands = background.rootTerminal ? new Map() : background.foregroundCommands
      background.foregroundCommands = new Map()
      background.foregroundCommandBytes = 0
      background.cancellationPending = true
      if (
        stopAbort?.reason === 'user_stop' &&
        background.primaryTurnId &&
        !background.rootTerminal
      ) {
        void observerRef?.maybeInterruptRoot(stoppedCommands, false, true, stopAbort.deadlineAt)
      }
    }
    const foregroundScope = new TurnResourceScope()
    const releaseScope = new TurnResourceScope()
    signal.addEventListener('abort', freezeForegroundCommands, { once: true })
    foregroundScope.add('codex_abort_listener', () =>
      signal.removeEventListener('abort', freezeForegroundCommands),
    )
    let provisionalThreadId: string | undefined
    let threadStartupDispatched = false
    let threadStartupCompleted = false
    let lateStartupRejection: Error | undefined
    let rootTurnRequested = false
    let foregroundTurnCompletedYielded = false
    const answer = new AgentAnswerAssembler(input.runId)
    const planMemory = releaseScope.trackReservation(
      'plan_memory',
      new NativeWorkingMemory().reserve(0),
    )
    let submittedPlan: { nativeId: string; text: string } | undefined
    let retainedPlan: CollaborationRetainedPlan | undefined
    let planOperationObserved = false
    let reviewResult: CollaborationReviewObservation | undefined
    let inputResult: CollaborationInputObservation | undefined
    let projectionFailure: unknown
    releaseScope.add('answer_and_plan_state', () => {
      answer.dispose()
      submittedPlan = undefined
      retainedPlan = undefined
    })
    if (sourceGrant) {
      releaseScope.add('source_reader', () =>
        this.runtime.peerToolServer.retireSourceReader(sourceGrant),
      )
    }
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
      releaseScope.dispose()
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
    let wakeStopWaiter: (() => void) | undefined
    const notifyStopWaiter = (): void => {
      const wake = wakeStopWaiter
      wakeStopWaiter = undefined
      wake?.()
    }
    const reasoningSummaries = new CodexReasoningSummaryTracker()
    const observer = new CodexTurnNativeObserver({
      runtime: this.runtime,
      kernel: this.kernel,
      input,
      signal,
      foregroundInteractionSignal,
      sourceGrant,
      background,
      delivery,
      answer,
      getConnection: () => connection,
      getThreadId: () => threadId,
      getTurnId: () => turnId,
      setTurnId: (nextTurnId) => {
        turnId = nextTurnId
      },
      getProvisionalThreadId: () => provisionalThreadId,
      setProvisionalThreadId: (nextThreadId) => {
        provisionalThreadId = nextThreadId
      },
      isThreadStartupDispatched: () => threadStartupDispatched,
      isForegroundTurnCompletedYielded: () => foregroundTurnCompletedYielded,
      getPeerReceipt: () => peerReceipt,
      getProjectionFailure: () => projectionFailure,
      setProjectionFailure: (err) => {
        projectionFailure = err
      },
      projectOutput,
      capturePlan,
      observePlanOperation,
      captureRetainedPlan,
      captureReview,
      captureInputResult,
      getWorkflowArtifacts: () => ({ submittedPlan, reviewResult, inputResult }),
      onStateChanged: notifyStopWaiter,
    })
    observerRef = observer

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
      const activePeerReceipt = peerReceipt
      foregroundScope.add('peer_tool_turn', () =>
        this.runtime.peerToolServer.endTurn(activePeerReceipt),
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
      observer.attachSubscriptions(nativeConnection, releaseScope)

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
            const lateError = Reflect.get(lateMessage, 'error')
            if (lateError) {
              lateStartupRejection = classifyCodexStartupRejection(lateError, input.nativeSessionId)
              if (background.foregroundReleased) {
                if (
                  input.nativeSessionId &&
                  lateStartupRejection instanceof AgentExecutionError &&
                  lateStartupRejection.kind === 'context_resume_failed'
                ) {
                  input.host?.lifecycle?.recordNativeEvidence?.({
                    kind: 'missing',
                    source: 'native_error',
                    identity: this.runtime.runIdentity(input, input.nativeSessionId),
                  })
                }
                observer.reportUnknown(lateStartupRejection.message)
              }
              observer.markRootNotStartedIfUnsent(input.nativeSessionId)
              observer.maybeSettle()
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
              observer.drainPendingOwnedFacts(false)
              observer.markRootNotStartedIfUnsent(lateThreadId)
              observer.maybeSettle()
            } else {
              observer.reportUnknown(
                'Codex late thread startup reply carried an invalid or mismatched thread identity.',
              )
              observer.markRootNotStartedIfUnsent(input.nativeSessionId)
              observer.maybeSettle()
            }
          },
        })
        threadStartupDispatched = startupOp.requestId !== null
        void startupOp.physicalCompletion
          .then((completion) => {
            if (completion === 'not_sent') {
              observer.markRootNotStartedIfUnsent(input.nativeSessionId)
              observer.maybeSettle()
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
          observer.markRootNotStartedIfUnsent(input.nativeSessionId)
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
          observer.markRootNotStartedIfUnsent(input.nativeSessionId)
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
        observer.replayEarly()
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
              () => observer.maybeSettle(),
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
              observer.markRootNotStartedIfUnsent(threadId)
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
              observer.markRootNotStartedIfUnsent(threadId)
            }
            throw error
          }
          delivery.phase = 'possibly_delivered'
        },
        // S3-F4 & A-F3: Unified late-ACK binding through bindRootTurn so identity persistence,
        // arrival-order fact replay, and one-shot Stop interruption share one transition.
        onLateReply: (lateMessage) => {
          if (background.closed || background.rootNotStarted) return
          const lateTurnError = Reflect.get(lateMessage, 'error')
          if (lateTurnError) {
            if (!background.primaryTurnId) {
              const classified = classifyCodexRpcError(lateTurnError, 'Codex rejected turn/start.')
              lateStartupRejection = classified
              if (background.foregroundReleased) {
                observer.reportUnknown(classified.message)
              }
              observer.markRootNotStartedIfUnsent(threadId)
              observer.maybeSettle()
            }
            return
          }
          const lateResult = Reflect.get(lateMessage, 'result')
          const lateTurn =
            lateResult && typeof lateResult === 'object' ? Reflect.get(lateResult, 'turn') : null
          const lateTurnId =
            lateTurn && typeof lateTurn === 'object' ? Reflect.get(lateTurn, 'id') : undefined
          if (typeof lateTurnId !== 'string' || !lateTurnId || lateTurnId.length > 1024) {
            observer.reportUnknown('Codex late turn/start reply carried an invalid Turn identity.')
            observer.releaseRootStartupEarly()
            observer.maybeSettle()
            return
          }
          observer.bindRootTurn(lateTurnId, 'late_ack')
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
              observer.markRootNotStartedIfUnsent(threadId)
              if (recovery && requestId !== null) {
                recovery.recordConfirmedUnsent(
                  { kind: 'codex_root_frame_not_written', requestId },
                  identity,
                )
              }
              observer.maybeSettle()
            }
            return undefined
          })
          .catch(() => undefined)
      }
      const turnResponse = await rootOperation.result
      const turnRpcError = Reflect.get(turnResponse, 'error')
      if (turnRpcError) {
        delivery.phase = 'before_dispatch'
        if (!background.primaryTurnId) observer.markRootNotStartedIfUnsent(threadId)
        throw classifyCodexRpcError(turnRpcError, 'Codex rejected turn/start.')
      }
      const turnResult = Reflect.get(turnResponse, 'result')
      const turn =
        turnResult && typeof turnResult === 'object' ? Reflect.get(turnResult, 'turn') : null
      const resolvedTurnId = turn && typeof turn === 'object' ? Reflect.get(turn, 'id') : undefined
      if (typeof resolvedTurnId !== 'string') {
        throw new AgentExecutionError('protocol_error', 'Codex returned no Turn ID.', false)
      }
      if (!observer.bindRootTurn(resolvedTurnId, 'ack')) {
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
        if (observer.handleOwnedNativeEvent(message)) continue
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
          observer.cacheApprovalItem(item, threadId, turnId)
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
              const pendingRecording = observer.getFileChangeRecording(item)
              if (pendingRecording) {
                // oxlint-disable-next-line no-await-in-loop -- Preserve applied native operation order without blocking Stop on slow file I/O.
                await new Promise<void>((resolveRec, rejectRec) => {
                  const recAbortError = (): AgentExecutionError =>
                    readRunStopAbortReason(signal)?.reason === 'user_stop'
                      ? new AgentExecutionError('user_stopped', 'Stopped by the user.', false)
                      : new AgentExecutionError(
                          'agent_process_crash',
                          'Codex was interrupted.',
                          false,
                        )
                  if (signal.aborted) {
                    rejectRec(recAbortError())
                    return
                  }
                  const onRecAbort = (): void => rejectRec(recAbortError())
                  signal.addEventListener('abort', onRecAbort, { once: true })
                  void pendingRecording.then(
                    () => {
                      signal.removeEventListener('abort', onRecAbort)
                      resolveRec()
                      return undefined
                    },
                    (recError: unknown) => {
                      signal.removeEventListener('abort', onRecAbort)
                      rejectRec(recError)
                    },
                  )
                })
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
                outcome: toolFailed(item)
                  ? background.stopRequested || signal.aborted
                    ? 'interrupted'
                    : 'failed'
                  : 'completed',
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
            observer.handledRequests,
            observer.approvalItems,
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
        observer.markRootNotStartedIfUnsent()
      }
      const stopAbort = readRunStopAbortReason(signal)
      const isUserStopCancelError = isUserStopCancellationError(error, signal)
      if (
        stopAbort?.reason === 'user_stop' &&
        isUserStopCancelError &&
        !inputWithheldError &&
        !projectionFailure
      ) {
        if (lateStartupRejection) {
          throw lateStartupRejection
        }
        if (background.rootNotStarted) {
          return
        }
        if (connection?.isOpen && !background.closed && !this.runtime.disposed) {
          // Hand off queued notifications to the observer BEFORE awaiting physical root Stop drain.
          background.foregroundReleased = true
          connection.replayBackgroundNotifications()
          observer.drainPendingOwnedFacts(false)
          void observer.maybeInterruptRoot(stoppedCommands, false, true, stopAbort?.deadlineAt)
          const waitUntil = async (
            predicate: () => boolean,
            remainingMsFn: () => number,
          ): Promise<void> => {
            while (!predicate()) {
              const remainingMs = remainingMsFn()
              if (remainingMs <= 0) return
              // oxlint-disable-next-line no-await-in-loop -- Event-driven wait bounded by monotonic user Stop deadline.
              await new Promise<void>((resolve) => {
                const done = (): void => {
                  clearTimeout(timer)
                  background.observation.signal.removeEventListener('abort', done)
                  if (wakeStopWaiter === done) wakeStopWaiter = undefined
                  resolve()
                }
                const timer = setTimeout(done, remainingMs)
                wakeStopWaiter = done
                background.observation.signal.addEventListener('abort', done, { once: true })
                if (predicate()) done()
              })
            }
          }
          const stopTerminalReady = (): boolean =>
            !connection?.isOpen ||
            this.runtime.disposed ||
            background.closed ||
            background.rootNotStarted ||
            (background.rootTerminal &&
              !observer.hasRootOperations() &&
              background.recordings.size === 0 &&
              !background.early.length)
          // Wait up to the 10s monotonic deadline for rootTerminal + root operations/recordings drain.
          // If rootTerminal arrives while only confirmed-stopped root commands remain open (C2),
          // allow a short 250ms grace window for late item/completed before closing only those commands.
          await waitUntil(
            () =>
              stopTerminalReady() ||
              (background.rootTerminal &&
                background.recordings.size === 0 &&
                !background.early.length &&
                observer.hasStillOpenStoppedCommands()),
            () => remainingStopBudgetMs(stopAbort),
          )
          const activeInterrupt = observer.getRootInterruptState().promise
          if (activeInterrupt) {
            await awaitWithinStopBudget(activeInterrupt, stopAbort)
          }
          if (
            background.rootTerminal &&
            observer.hasStillOpenStoppedCommands() &&
            connection.isOpen &&
            !background.closed
          ) {
            const c2GraceEnd = performance.now() + Math.min(remainingStopBudgetMs(stopAbort), 250)
            await waitUntil(stopTerminalReady, () =>
              Math.max(0, Math.ceil(c2GraceEnd - performance.now())),
            )
            observer.clearConfirmedStoppedRootCommands()
          }
          // Re-check ALL root operations (including unconfirmed commands, fileChange, MCP)
          // and recordings within the same single monotonic deadline before settling.
          if (!stopTerminalReady() && remainingStopBudgetMs(stopAbort) > 0) {
            await waitUntil(stopTerminalReady, () => remainingStopBudgetMs(stopAbort))
          }
          if (lateStartupRejection) {
            throw lateStartupRejection
          }
          if (background.rootNotStarted) {
            return
          }
          const interruptState = observer.getRootInterruptState()
          if (
            interruptState.promise !== undefined &&
            !interruptState.confirmed &&
            (!background.rootTerminal || observer.hasRootOperations())
          ) {
            observer.reportUnknown(
              'Codex interruption could not be confirmed before the Stop deadline.',
            )
          }
          if (
            stopTerminalReady() &&
            connection.isOpen &&
            !background.closed &&
            !this.runtime.disposed
          ) {
            return
          }
        }
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
      foregroundScope.dispose()
      background.foregroundReleased = true
      observer.handoffUndeliveredTerminalSnapshot()
      if (background.closed) answer.dispose()
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
      const finallyInterrupt = observer.maybeInterruptRoot(stoppedCommands, false)
      if (finallyInterrupt) {
        await finallyInterrupt
      }
      stoppedCommands?.clear()
      background.cancellationPending = false
      this.runtime.running = false
      if (!threadStartupDispatched || (threadStartupCompleted && !rootTurnRequested)) {
        observer.markRootNotStartedIfUnsent()
      }
      if (!connection?.isOpen) {
        if (!background.rootNotStarted) background.unknown = true
        await Promise.allSettled(background.recordings)
        this.runtime.settleNativeBackground(background)
      } else {
        if (!background.rootTerminal && !background.rootNotStarted)
          // The background observer still receives every frame on this live connection.
          // Its later exact terminal and fully drained work can settle this temporary state.
          observer.reportUnknown(
            'The foreground ended without proof that native work finished.',
            'unlisted',
            'awaiting_terminal',
          )
        observer.maybeSettle()
      }
      if (background.closed) {
        await this.kernel.settle()
      }
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }
}
