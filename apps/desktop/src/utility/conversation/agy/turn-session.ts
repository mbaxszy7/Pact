import { isDeepStrictEqual } from 'node:util'

import type {
  AgentCollaborationSourceReader,
  AgentPromptImage,
  AgentRunInput,
  AgentSourceReadForm,
} from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  NativeUserInputRequest,
  NormalizedAgentEvent,
  SessionPermissionMode,
} from '@pact/contracts'

import {
  agentPromptImageGroups,
  RunLifecycleKernel,
  validateSourceGrant,
} from '@pact/agent-runtime'
import {
  buildBoundedNativePlanId,
  collaborationAskMode,
  collaborationPlanMode,
} from '@pact/contracts'

import type {
  AgyIngress,
  AgyOrderedSessionStream,
  AgyPoolLease,
  AgyServerRequestOwnerHandle,
} from '../agy-acp-connection'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAdapterRuntime } from './adapter-runtime'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { AgentAnswerAssembler } from '../agent-answer-assembler'
import {
  AgentExecutionError,
  NativeCapacityError,
  NativeInputWithheldError,
} from '../agent-execution-error'
import {
  AGY_MAX_CONTEXTS,
  AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
  createAgyRootFrameNotWrittenProof,
} from '../agy-acp-connection'
import { mergeWorkflowInput, mergeWorkflowReview } from '../collaboration-answer'
import {
  buildSourceInstructions,
  collaborationInstructions,
  collaborationReadOnly,
} from '../collaboration-prompt'
import { cutoffSourceNavigator } from '../frozen-source-reader'
import {
  AgyRoundEffectsTracker,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from '../native-file-changes'
import { agyPromptInput, nativeImagePreparationBytes } from '../native-image-content'
import { NativePermissionWait, safeNativePermissionText } from '../native-permission-wait'
import { bindAgySkillSelections } from '../native-skill-catalog'
import { PEER_ASSISTANCE_INSTRUCTIONS } from '../peer-assistance-policy'
import {
  computeRetainedPlanTextBytes,
  parseAgyPromptTerminalReply,
  validateAgyFrame,
  type ParsedAgyPromptTerminalReply,
} from './frame-validator'
import { AgyRunMcpServer } from './peer-mcp-server'
import {
  agyElicitationRequest,
  buildAgyPermissionCard,
  findRejectOnceOptionId,
  parseAcpSessionDescriptor,
} from './permission-and-elicitation'
import { AgyTurnBackgroundObserver } from './turn-background-observer'
import { AgyTurnFrameAdmitter } from './turn-frame-admitter'
import {
  AGY_MAX_PENDING_EVENTS,
  AGY_MAX_PENDING_EVENT_BYTES,
  AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS,
  AGY_MAX_TOOL_STATE_BYTES,
  AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
  AGY_PLAN_SUBMISSION_INSTRUCTIONS,
  AGY_READ_ONLY_STAGE_INSTRUCTIONS,
  AGY_SESSION_METADATA_UPDATES,
  asString,
  awaitPhysicalCompletionBounded,
  classifyAgyCloseFailureDiagnostic,
  estimateNormalizedEventBytes,
  isPlainObject,
  type AcpConfigOptionEntry,
  type AcpSessionDescriptor,
  type ActiveAgyRun,
  type AgyToolState,
  type ValidatedAgyFrame,
} from './types'

/**
 * Explicit TurnSession FSM for a single Antigravity ACP Turn execution.
 *
 * Drives RunLifecycleKernel across PreLease -> BootstrappingSession ->
 * ReadyToDispatch -> DispatchedStreaming -> TerminalObserved | AbortRequested ->
 * DrainingEffects -> Settled, while preserving Antigravity invariants A1-A5.
 */
export class AgyTurnSession {
  readonly kernel: RunLifecycleKernel

  constructor(
    private readonly runtime: AgyAdapterRuntime,
    private readonly input: AgentRunInput,
    private readonly signal: AbortSignal,
  ) {
    const grantCheck = validateSourceGrant({
      runId: input.runId,
      nativeGeneration: input.nativeGeneration,
      hasSourceReader: Boolean(input.host?.workflow?.sourceReader),
      sourceGrant: input.promptEnvelope.sourceGrant,
    })
    if (!grantCheck.ok) {
      throw new AgentExecutionError(
        'protocol_error',
        grantCheck.reason ?? 'The source reader has no exact root owner.',
        false,
      )
    }
    this.kernel = new RunLifecycleKernel({
      agentId: 'agy',
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
    signal.throwIfAborted()
    if (this.runtime.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (this.runtime.activeRuns.size >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError(
        'Antigravity has too many active native contexts. Wait for one to settle; no new task was submitted.',
      )
    }

    const workflow = input.promptEnvelope.collaboration
    const authorization = input.promptEnvelope.collaborationAuthorization ?? workflow?.authorization
    const readOnlyStage = collaborationReadOnly(workflow, authorization)
    const planModeStage = collaborationPlanMode(workflow, authorization)
    const askOnlyStage = Boolean(workflow && collaborationAskMode(workflow, authorization))
    const effectivePermissionMode: SessionPermissionMode = input.permissionMode ?? 'native'
    const permissionScope =
      !readOnlyStage && effectivePermissionMode === 'full' ? 'full' : 'standard'

    const tools = new Map<string, AgyToolState>()
    const approvedBrainPlanCalls = new Map<
      string,
      { readonly toolName: string; readonly args: Record<string, unknown> }
    >()
    let brainPlanTouched = false
    const activeBrainPlanOpCallIds = new Set<string>()
    const hasUnresolvedBrainPlanWrite = (): boolean => activeBrainPlanOpCallIds.size > 0
    let latestBrainPlanCandidate: { nativeId: string; text: string } | undefined
    let brainPlanReadbackRequired = false
    let brainPlanCaptureFailed = false
    let unresolvedPreBindOutput = false

    let sourceRetired = false
    const retireSourceReader = (): void => {
      if (sourceRetired) return
      sourceRetired = true
      input.host?.workflow?.sourceReader?.retire()
    }

    let resolvedSessionId: string | undefined = input.nativeSessionId
    let createdFreshSession = false
    let activeExecutorId = this.runtime.pool.executorId
    let rootFirstByteWritten = false
    let promptEnteredTransport = false
    let rootConfirmedNotSent = false
    const isConfirmedZeroBytesSent = (): boolean =>
      (!promptEnteredTransport && !rootFirstByteWritten) || rootConfirmedNotSent
    let promptReplyReceived = false
    let userCancelRequested = false
    let rootTerminal = false
    let rootReleasing = false
    let foregroundReleased = false

    let lease: AgyPoolLease | undefined
    let sessionStream: AgyOrderedSessionStream | undefined
    let promptMemoryReservation: NativeMemoryReservation | undefined
    let toolStateMemoryReservation: NativeMemoryReservation | undefined
    let foregroundDedupMemoryReservation: NativeMemoryReservation | undefined
    let mcpCorrelationMemoryReservation: NativeMemoryReservation | undefined
    let publishedPlanMemoryReservation: NativeMemoryReservation | undefined
    let pendingEventsMemoryReservation: NativeMemoryReservation | undefined
    let stagedPreBindMemoryReservation: NativeMemoryReservation | undefined
    let foreignExecIdsMemoryReservation: NativeMemoryReservation | undefined
    let postCutoffBgMemoryReservation: NativeMemoryReservation | undefined
    let serverRequestOwner: AgyServerRequestOwnerHandle | undefined
    let backgroundObserver: AgyTurnBackgroundObserver | undefined
    let activeRun: ActiveAgyRun | undefined
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined
    let promptSettled = false
    const promptRpcAbort = new AbortController()
    const runDisposeAbort = new AbortController()
    const runSignal = AbortSignal.any([signal, runDisposeAbort.signal])
    const observation = new AbortController()
    const runFinalizer = Promise.withResolvers<void>()
    let stopStreamPump: (() => void) | undefined
    let stopPrePromptDrain: ((drainRemaining?: boolean) => Promise<void>) | undefined
    let handoffOrderedStreamToBackground: (() => void) | undefined

    const loadHostTrajectoryIdentity = (loadSignal: AbortSignal) =>
      this.runtime.bootstrap.loadHostTrajectoryIdentity({
        resolvedSessionId,
        cwd: lease?.canonicalCwd ?? input.cwd,
        observationSignal: observation.signal,
        callerSignal: signal,
        loadSignal,
      })
    const loadHostTrajectoryIdentityBeforePrompt = (loadSignal: AbortSignal) =>
      this.runtime.bootstrap.loadHostTrajectoryIdentityBeforePrompt({
        resolvedSessionId,
        cwd: lease?.canonicalCwd ?? input.cwd,
        observationSignal: observation.signal,
        callerSignal: signal,
        loadSignal,
      })

    const mcpServer = new AgyRunMcpServer({
      runId: input.runId,
      getNativeSessionId: () => resolvedSessionId,
      getExecutorId: () => activeExecutorId,
      getExecutionId: () => activeRun?.providerExecutionId,
      getRootStepIdx: () => activeRun?.rootStepIdx,
      hasZeroTurnStepBoundary: () => createdFreshSession,
      tryLoadHostTrajectoryId: async () => {
        const res = await loadHostTrajectoryIdentity(
          AbortSignal.any([observation.signal, AbortSignal.timeout(500)]),
        ).catch(() => ({ status: 'transient_churn' as const }))
        return res.status === 'ok'
          ? { trajectoryId: res.trajectoryId, stepCount: res.stepCount }
          : undefined
      },
      bindingGeneration: input.bindingGeneration ?? 1,
      isRootCurrent: () =>
        !this.runtime.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !rootReleasing &&
        !foregroundReleased &&
        !signal.aborted,
      isSourceCurrent: () =>
        !this.runtime.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !sourceRetired &&
        !signal.aborted,
      workflow,
      authorization,
      requestSessionTitle: input.promptEnvelope.requestSessionTitle === true,
      peerAssistanceAllowed: !workflow && input.peerAssistanceAllowed !== false,
      peerTargetAgentId: this.runtime.options.peerTargetAgentId,
      sourceGrant: input.promptEnvelope.sourceGrant,
      sourceReader: input.host?.workflow?.sourceReader,
      isPlanRetentionCurrent: () => !brainPlanTouched && !hasUnresolvedBrainPlanWrite(),
      recordOpenPlanFinalIntent: input.host?.workflow?.recordOpenPlanFinalIntent,
      reserveCorrelationBytes: (nextBytes) => {
        if (!mcpCorrelationMemoryReservation) return true
        try {
          mcpCorrelationMemoryReservation.resize(nextBytes)
          return true
        } catch {
          return false
        }
      },
    })

    const interactionControllers = new Set<AbortController>()
    const abortOutstandingInteractions = (): void => {
      for (const ctrl of interactionControllers) {
        ctrl.abort()
      }
      interactionControllers.clear()
    }
    const recordings = new Set<Promise<void>>()
    let recordingTail = Promise.resolve()
    let unknownEffectsReported = false
    let unknownEffectsReason: string | undefined

    const reportUnknown = (reason: string): void => {
      if (unknownEffectsReported) return
      unknownEffectsReported = true
      unknownEffectsReason = reason
      nativeFileChangesSettled(input, 'unknown', reason)
    }

    const recordHostBeforeRootStart = (): void => {
      if (resolvedSessionId && input.host?.recovery) {
        input.host?.recovery.recordConfirmedUnsent(
          { kind: 'host_before_root_start' },
          { executorId: activeExecutorId, nativeSessionId: resolvedSessionId },
        )
      }
    }

    let zeroInputClosePromise: Promise<void> | undefined
    const closeZeroInputSessionOnce = (deadlineAt?: number): Promise<void> => {
      if (zeroInputClosePromise) return zeroInputClosePromise
      if (
        !createdFreshSession ||
        !resolvedSessionId ||
        !isConfirmedZeroBytesSent() ||
        !lease?.connection.isOpen
      ) {
        return Promise.resolve()
      }
      const timeoutMs = deadlineAt !== undefined ? Math.min(1_500, deadlineAt - Date.now()) : 1_500
      if (timeoutMs <= 0) {
        return Promise.resolve()
      }
      const targetSessionId = resolvedSessionId
      const targetLease = lease
      zeroInputClosePromise = (async () => {
        const closeRes = await targetLease.closeSession(targetSessionId, { timeoutMs })
        if (closeRes.confirmed) {
          this.runtime.sessionModes.delete(targetSessionId)
        } else {
          const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            sessionId: input.sessionId,
            runId: input.runId,
            agentId: 'agy',
            executorId: activeExecutorId,
            nativeMethod: 'session/close',
            failureSource: closeDiag.failureSource,
            code: closeDiag.code,
          })
        }
      })()
      return zeroInputClosePromise
    }

    let emergencyCleanedUp = false
    let finalizationPromise: Promise<void> | undefined
    const finalizeRun = (options: { emergency: boolean }): Promise<void> => {
      if (options.emergency) {
        emergencyCleanedUp = true
      }
      if (finalizationPromise) {
        return finalizationPromise
      }
      finalizationPromise = (async () => {
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        promptRpcAbort.abort()
        await stopPrePromptDrain?.(false).catch(() => undefined)
        stopStreamPump?.()
        foregroundReleased = true
        if (options.emergency || emergencyCleanedUp) {
          rootTerminal = true
        }
        if (activeRun) {
          activeRun.foregroundReleased = true
          if (options.emergency || emergencyCleanedUp) {
            activeRun.rootTerminal = true
          }
          this.runtime.projector.notifyRootExecutionWaiters(activeRun)
        }
        if (
          (options.emergency || emergencyCleanedUp) &&
          !unknownEffectsReported &&
          !isConfirmedZeroBytesSent()
        ) {
          reportUnknown(
            'Antigravity adapter disposed before native Turn cleanup could be confirmed.',
          )
        }
        this.runtime.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
        // Root Turn has ended: unconditionally revoke and close MCP server synchronously before releasing its reservation.
        mcpServer.revokeRun()
        await mcpServer.close().catch(() => undefined)
        mcpCorrelationMemoryReservation?.release()
        mcpCorrelationMemoryReservation = undefined
        publishedPlanMemoryReservation?.release()
        publishedPlanMemoryReservation = undefined
        promptMemoryReservation?.release()
        promptMemoryReservation = undefined
        toolStateMemoryReservation?.release()
        toolStateMemoryReservation = undefined
        pendingEventsMemoryReservation?.release()
        pendingEventsMemoryReservation = undefined
        stagedPreBindMemoryReservation?.release()
        stagedPreBindMemoryReservation = undefined
        foreignExecIdsMemoryReservation?.release()
        foreignExecIdsMemoryReservation = undefined
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        tools.clear()
        approvedBrainPlanCalls.clear()
        if (!options.emergency && !emergencyCleanedUp) {
          await closeZeroInputSessionOnce().catch(() => undefined)
        }
        serverRequestOwner?.dispose()
        serverRequestOwner = undefined
        if (
          !options.emergency &&
          !emergencyCleanedUp &&
          !this.runtime.disposed &&
          activeRun &&
          activeRun.activeBackgroundTasks.size > 0
        ) {
          handoffOrderedStreamToBackground?.()
          sessionStream?.close()
          sessionStream = undefined
          // Keep background listener & lease until active background tasks settle or pool disposes.
          const retainedRun = activeRun
          const retainedLease = lease
          lease = undefined
          let retainedCleaned = false
          const cleanupRetained = (): void => {
            if (retainedCleaned) return
            retainedCleaned = true
            backgroundObserver?.unsubscribe()
            foregroundDedupMemoryReservation?.release()
            foregroundDedupMemoryReservation = undefined
            postCutoffBgMemoryReservation?.release()
            postCutoffBgMemoryReservation = undefined
            retireSourceReader()
            this.runtime.activeRuns.delete(input.runId)
            retainedLease?.release()
          }
          if (
            retainedRun.observation.signal.aborted ||
            this.runtime.disposed ||
            emergencyCleanedUp
          ) {
            cleanupRetained()
          } else {
            retainedRun.observation.signal.addEventListener('abort', cleanupRetained, {
              once: true,
            })
          }
        } else {
          sessionStream?.close()
          sessionStream = undefined
          backgroundObserver?.unsubscribe()
          foregroundDedupMemoryReservation?.release()
          foregroundDedupMemoryReservation = undefined
          postCutoffBgMemoryReservation?.release()
          postCutoffBgMemoryReservation = undefined
          retireSourceReader()
          observation.abort()
          if (activeRun) this.runtime.activeRuns.delete(input.runId)
          lease?.release()
          lease = undefined
        }
        await this.kernel.settle({
          retainBackgroundObservation: Boolean(
            activeRun &&
            activeRun.activeBackgroundTasks.size > 0 &&
            !options.emergency &&
            !emergencyCleanedUp &&
            !this.runtime.disposed,
          ),
        })
        this.runtime.ownedRunHandles.delete(runHandle)
        runFinalizer.resolve()
      })()
      return finalizationPromise
    }

    const runHandle = {
      runId: input.runId,
      cancel: (): void => {
        runDisposeAbort.abort(
          new AgentExecutionError(
            'agent_process_crash',
            'Antigravity adapter is shutting down.',
            false,
          ),
        )
        observation.abort()
        if (activeRun) {
          this.runtime.projector.notifyRootExecutionWaiters(activeRun)
        }
        for (const ctrl of interactionControllers) ctrl.abort()
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        if (
          rootFirstByteWritten &&
          !promptSettled &&
          !rootTerminal &&
          resolvedSessionId &&
          lease?.connection.isOpen
        ) {
          void lease.connection
            .notify('session/cancel', { sessionId: resolvedSessionId }, {})
            .catch(() => undefined)
        }
        promptRpcAbort.abort()
      },
      closeZeroInputSession: (deadlineAt?: number): Promise<void> =>
        closeZeroInputSessionOnce(deadlineAt),
      forceCleanup: (): Promise<void> => finalizeRun({ emergency: true }),
      finalized: runFinalizer.promise,
    }
    this.runtime.ownedRunHandles.add(runHandle)

    try {
      // Re-verify explicit /skill selections before acquiring or dispatching to native process.
      if (input.promptEnvelope.skillInvocation) {
        const hasAgySkill = input.promptEnvelope.skillInvocation.bindings.some(
          (b) => b.agentId === 'agy',
        )
        if (hasAgySkill) {
          const catalog = await this.runtime.discoverSkills(input.cwd, runSignal)
          bindAgySkillSelections(input.promptEnvelope.skillInvocation.bindings, catalog)
        }
      }

      const mcpDescriptor = mcpServer.hasTools ? await mcpServer.start() : undefined

      const systemAppendParts: string[] = []
      if (workflow) {
        systemAppendParts.push(
          collaborationInstructions(workflow, authorization, mcpServer.sourceCapability),
        )
        if (readOnlyStage) {
          systemAppendParts.push(AGY_READ_ONLY_STAGE_INSTRUCTIONS)
        }
        if (planModeStage) {
          systemAppendParts.push(AGY_PLAN_SUBMISSION_INSTRUCTIONS)
        }
      } else {
        if (mcpServer.allowedToolNames.has('request_peer_assistance')) {
          systemAppendParts.push(PEER_ASSISTANCE_INSTRUCTIONS)
        }
        if (mcpServer.allowedToolNames.has('read_collaboration_source')) {
          systemAppendParts.push(buildSourceInstructions(mcpServer.sourceCapability))
        }
      }
      if (mcpServer.hasTools) {
        systemAppendParts.push(mcpServer.formatToolUsageInstructions())
      }
      const systemAppend = systemAppendParts.filter(Boolean).join('\n\n')
      const systemPromptMeta = systemAppend
        ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } }
        : {}

      lease = await this.runtime.pool.acquire({
        cwd: input.cwd,
        permissionScope,
        permissionMode: effectivePermissionMode,
        readOnly: readOnlyStage,
        sessionId: input.sessionId,
        signal: runSignal,
      })
      const connection = lease.connection
      activeExecutorId = connection.executorId
      this.kernel.bindExecutor(activeExecutorId)

      await lease.ensureInitialized(runSignal)

      // Event queue fed by ordered server-request interactions (approval / question) and session updates.
      pendingEventsMemoryReservation = connection.reserveWorkingMemory(0)
      const pendingEvents: Array<{ readonly event: NormalizedAgentEvent; readonly bytes: number }> =
        []
      let pendingEventsBytes = 0
      let wakeEventLoop: (() => void) | undefined
      let wakePumpForBackpressure: (() => void) | undefined
      const notifyEventLoop = (): void => {
        const wake = wakeEventLoop
        wakeEventLoop = undefined
        wake?.()
      }
      const notifyPumpForBackpressure = (): void => {
        const wake = wakePumpForBackpressure
        wakePumpForBackpressure = undefined
        wake?.()
      }
      const isPendingEventsAtSoftCap = (): boolean =>
        pendingEvents.length >= AGY_MAX_PENDING_EVENTS ||
        pendingEventsBytes >= AGY_MAX_PENDING_EVENT_BYTES
      const pushPendingEvent = (ev: NormalizedAgentEvent): void => {
        const evBytes = estimateNormalizedEventBytes(ev)
        const nextBytes = pendingEventsBytes + evBytes
        if (
          pendingEvents.length >= AGY_MAX_PENDING_EVENTS * 2 ||
          nextBytes > AGY_MAX_PENDING_EVENT_BYTES * 2
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity pending event queue exceeded working-memory budget.',
            false,
          )
        }
        pendingEventsMemoryReservation?.resize(nextBytes)
        pendingEventsBytes = nextBytes
        pendingEvents.push({ event: ev, bytes: evBytes })
        notifyEventLoop()
      }
      const shiftPendingEvent = (): NormalizedAgentEvent | undefined => {
        const entry = pendingEvents.shift()
        if (!entry) return undefined
        pendingEventsBytes = Math.max(0, pendingEventsBytes - entry.bytes)
        pendingEventsMemoryReservation?.resize(pendingEventsBytes)
        if (!isPendingEventsAtSoftCap()) {
          notifyPumpForBackpressure()
        }
        return entry.event
      }
      const clearPendingEvents = (): void => {
        pendingEvents.length = 0
        pendingEventsBytes = 0
        pendingEventsMemoryReservation?.resize(0)
        notifyPumpForBackpressure()
      }

      const permissionWait = new NativePermissionWait()
      let activePermissionRequests = 0
      const releaseWaitObserver = permissionWait.subscribe(() => {
        if (activeRun?.turnAccepted && !rootTerminal && resolvedSessionId) {
          this.runtime.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            {
              kind: permissionWait.waiting ? 'waiting_user' : 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
        }
      })
      observation.signal.addEventListener('abort', releaseWaitObserver, { once: true })

      let replayingHistory = false
      let promptCutoffSeq: number | undefined

      const isUnscopedDuringForeignTurn = (validated: ValidatedAgyFrame): boolean =>
        Boolean(
          activeRun &&
          activeRun.providerExecutionId === undefined &&
          activeRun.foreignTurnActiveUntilRootBound &&
          validated.executionId === undefined,
        )

      const isServerRequestIdentityContradicted = (validated: ValidatedAgyFrame): boolean =>
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        isUnscopedDuringForeignTurn(validated) ||
        (validated.executionId !== undefined &&
          activeRun?.providerExecutionId !== undefined &&
          validated.executionId !== activeRun.providerExecutionId) ||
        (validated.executionId !== undefined &&
          Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))

      const handleOrderedServerRequest = (
        req: Extract<AgyIngress, { kind: 'server_request' }>,
      ): boolean => {
        const { method, rpcId, message } = req
        if (method !== 'session/request_permission' && method !== 'elicitation/create') {
          void connection
            .respondError(rpcId, 'Unsupported Antigravity ACP server request.', -32_601)
            .catch(() => undefined)
          return false
        }
        const rawParams = Reflect.get(message, 'params')
        const paramsObjectValid = isPlainObject(rawParams)
        const params = paramsObjectValid ? rawParams : {}

        if (
          activeRun?.promptReplyReceived ||
          (promptCutoffSeq !== undefined && req.seq > promptCutoffSeq)
        ) {
          if (method === 'session/request_permission') {
            const rejectOnce = findRejectOnceOptionId(params.options)
            void connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
          } else {
            void connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
          return true
        }

        // Validate session, execution, trajectory/step, tokens, and operation-specific payload
        // BEFORE recording acceptance, showing an interaction, or granting permission!
        const validated = validateAgyFrame(
          req,
          resolvedSessionId,
          mcpServer.pinnedTrajectory,
          mcpServer.minStepIdx,
        )
        const unscopedForeign = isUnscopedDuringForeignTurn(validated)
        const identityContradicted = isServerRequestIdentityContradicted(validated)
        const permRequestInvalid =
          method === 'session/request_permission' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens ||
            validated.toolCallIdInvalid ||
            validated.argsEvidence.kind === 'invalid_or_conflict' ||
            (validated.statusPresent &&
              (validated.statusInvalid ||
                validated.status === 'completed' ||
                validated.status === 'failed' ||
                validated.status === 'cancelled')))
        const elicitRequestInvalid =
          method === 'elicitation/create' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens)

        let preBuiltPermissionCard: ReturnType<typeof buildAgyPermissionCard> | undefined
        let permissionCardValid = false
        if (method === 'session/request_permission' && !permRequestInvalid) {
          try {
            preBuiltPermissionCard = buildAgyPermissionCard(params, lease!.canonicalCwd)
            permissionCardValid = true
          } catch {
            permissionCardValid = false
          }
        }

        let preParsedElicitationRequest: NativeUserInputRequest | undefined
        let elicitationPayloadValid = false
        let elicitationParseErrorMessage: string | undefined
        if (method === 'elicitation/create' && !elicitRequestInvalid) {
          try {
            preParsedElicitationRequest = agyElicitationRequest(params)
            elicitationPayloadValid = true
          } catch (error) {
            elicitationPayloadValid = false
            elicitationParseErrorMessage =
              error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.'
          }
        }

        const requestValidForAcceptance =
          method === 'session/request_permission'
            ? !permRequestInvalid && permissionCardValid
            : !elicitRequestInvalid && elicitationPayloadValid

        // Only count as model Turn acceptance AFTER the root prompt has dispatched AND BOTH
        // attributable frame identity and operation-specific payload validation succeed!
        if (
          requestValidForAcceptance &&
          activeRun &&
          rootFirstByteWritten &&
          !activeRun.turnAccepted &&
          !activeRun.promptReplyReceived &&
          !rootTerminal &&
          !replayingHistory
        ) {
          activeRun.turnAccepted = true
          this.kernel.recordDispatch('accepted', activeRun.nativeSessionId, activeExecutorId)
          this.runtime.recordEvidence(
            input,
            activeRun.nativeSessionId,
            activeExecutorId,
            {
              kind: 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
          pushPendingEvent({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
        }

        if (method === 'session/request_permission') {
          this.runtime.projector
            .handlePermissionRequest({
              connection,
              validated,
              rpcId,
              params,
              paramsObjectValid,
              unscopedDuringForeignTurn: unscopedForeign,
              preBuiltCard: preBuiltPermissionCard,
              cwd: lease!.canonicalCwd,
              input,
              activeRun,
              getSessionId: () => resolvedSessionId,
              mcpServer,
              tools,
              approvedBrainPlanCalls,
              onBrainPlanWriteApproved: (toolCallId) => {
                brainPlanTouched = true
                if (activeBrainPlanOpCallIds.size < 64) {
                  activeBrainPlanOpCallIds.add(toolCallId)
                }
              },
              readOnlyStage,
              planModeStage,
              permissionMode: effectivePermissionMode,
              permissionWait,
              getActiveCount: () => activePermissionRequests,
              adjustActiveCount: (delta) => {
                activePermissionRequests += delta
              },
              interactionControllers,
              pushEvent: pushPendingEvent,
              signal,
            })
            .catch(() => undefined)
          return true
        }

        if (!elicitRequestInvalid && !elicitationPayloadValid) {
          void connection
            .respondError(
              rpcId,
              elicitationParseErrorMessage ?? 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return true
        }

        this.runtime.projector
          .handleElicitationRequest({
            connection,
            validated,
            rpcId,
            params,
            paramsObjectValid,
            unscopedDuringForeignTurn: unscopedForeign,
            preParsedRequest: preParsedElicitationRequest,
            input,
            activeRun,
            askOnlyStage,
            readOnlyNonInteractive:
              readOnlyStage &&
              !planModeStage &&
              (authorization?.stage ?? workflow?.stage) !== 'reply',
            permissionWait,
            interactionControllers,
            pushEvent: pushPendingEvent,
            signal,
          })
          .catch(() => undefined)
        return true
      }

      // Register this Run in the connection's server-request owner registry for its full lifetime so
      // concurrent sessions sharing one connection properly reject ambiguous unscoped requests (-32601),
      // while session-scoped requests are routed in strict stdout order via `openSessionStream({ ordered: true })`.
      serverRequestOwner = connection.registerServerRequestOwner({
        ownerId: `run:${input.runId}`,
        knownSessionId: resolvedSessionId,
        handler: (message, seq?: number) => {
          const method = asString(Reflect.get(message, 'method'))
          const rpcId = Reflect.get(message, 'id')
          if (
            (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
            !method ||
            (method !== 'session/request_permission' && method !== 'elicitation/create') ||
            !isPlainObject(message)
          ) {
            return false
          }
          const effectiveSeq = seq ?? (promptCutoffSeq !== undefined ? promptCutoffSeq + 1 : 0)
          return handleOrderedServerRequest({
            kind: 'server_request',
            seq: effectiveSeq,
            rpcId,
            method,
            message,
          })
        },
      })

      const prePromptReplayedToolCallIds = new Set<string>()
      const observePrePromptNotification = (note: object, targetSessionId: string): void => {
        this.runtime.bootstrap.observeSessionTitleFromNotification(note, targetSessionId, input)
        if (!isPlainObject(note) || asString(Reflect.get(note, 'method')) !== 'session/update') {
          return
        }
        const params = Reflect.get(note, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== undefined && sid !== targetSessionId) return
        const update = params.update
        if (!isPlainObject(update)) return
        const sessionUpdate = asString(update.sessionUpdate)
        if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return
        const toolCallId = asString(update.toolCallId ?? update.id)
        if (!toolCallId || toolCallId.length > 1024) return
        if (!prePromptReplayedToolCallIds.has(toolCallId)) {
          if (prePromptReplayedToolCallIds.size >= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS) {
            const oldest = prePromptReplayedToolCallIds.values().next().value
            if (oldest !== undefined) prePromptReplayedToolCallIds.delete(oldest)
          }
          prePromptReplayedToolCallIds.add(toolCallId)
        }
      }

      let descriptor: AcpSessionDescriptor
      if (input.nativeSessionId) {
        resolvedSessionId = input.nativeSessionId
        replayingHistory = true
        sessionStream = connection.openSessionStream(input.nativeSessionId, { ordered: true })
        let replayConfigOptions: AcpConfigOptionEntry[] | undefined
        const loadOp = connection.requestOwned(
          'session/load',
          {
            sessionId: input.nativeSessionId,
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
            ...systemPromptMeta,
          },
          {
            timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
            signal: runSignal,
            replyTo: sessionStream,
          },
        )
        const loadResp = yield* this.runtime.bootstrap.awaitControlRpcWithConcurrentDrain({
          requestPromise: loadOp.result,
          requestId: loadOp.requestId,
          stream: sessionStream,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: (replayed) => {
            observePrePromptNotification(replayed, input.nativeSessionId!)
            const notifiedOptions = this.runtime.bootstrap.extractConfigOptionsFromNotification(
              replayed,
              input.nativeSessionId,
            )
            if (notifiedOptions) replayConfigOptions = notifiedOptions
          },
          onServerRequest: (req) => {
            handleOrderedServerRequest(req)
          },
        })
        const loadError = Reflect.get(loadResp, 'error')
        const loadResult = Reflect.get(loadResp, 'result')
        if (loadError || !isPlainObject(loadResult)) {
          throw new AgentExecutionError(
            'context_resume_failed',
            loadError
              ? safeNativePermissionText(JSON.stringify(loadError), 240)
              : 'Antigravity could not load the saved native session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(loadResult, input.nativeSessionId)
        if (descriptor.configOptions.length === 0 && replayConfigOptions) {
          descriptor.configOptions = replayConfigOptions
        }
        replayingHistory = false
      } else {
        const newReq = connection.request(
          'session/new',
          {
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
            ...systemPromptMeta,
          },
          { timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS, signal: runSignal },
        )
        const newResp = yield* this.runtime.bootstrap.awaitControlRpcWithConcurrentDrain({
          requestPromise: newReq,
          stream: undefined,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: () => undefined,
        })
        const newError = Reflect.get(newResp, 'error')
        const newResult = Reflect.get(newResp, 'result')
        if (newError || !isPlainObject(newResult)) {
          throw new AgentExecutionError(
            'protocol_error',
            newError
              ? safeNativePermissionText(JSON.stringify(newError), 240)
              : 'Antigravity ACP server did not create a session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(newResult)
        resolvedSessionId = descriptor.sessionId
        createdFreshSession = true
        serverRequestOwner.updateSessionId(resolvedSessionId)
        sessionStream = connection.openSessionStream(resolvedSessionId, { ordered: true })
        // Drain any initial metadata updates or early server requests (`available_commands_update` / `config_option_update`).
        while (true) {
          const initialItem = sessionStream.shift()
          if (!initialItem) break
          if (initialItem.kind === 'server_request') {
            handleOrderedServerRequest(initialItem)
            continue
          }
          if (initialItem.kind !== 'notification') continue
          observePrePromptNotification(initialItem.message, resolvedSessionId)
          const notifiedOptions = this.runtime.bootstrap.extractConfigOptionsFromNotification(
            initialItem.message,
            resolvedSessionId,
          )
          if (notifiedOptions) descriptor.configOptions = notifiedOptions
        }
      }

      const sessionState = this.runtime.bootstrap.rememberSessionModeState(
        resolvedSessionId,
        descriptor.currentModeId,
      )

      // Enforce permission & read-only mode transitions BEFORE preparing or writing `session/prompt`.
      await this.runtime.bootstrap.configureSessionModeBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionState,
        sessionStream,
        onMetadataNotification: (note) => {
          observePrePromptNotification(note, resolvedSessionId!)
        },
        onServerRequest: (req) => {
          handleOrderedServerRequest(req)
        },
        readOnlyStage,
        permissionMode: effectivePermissionMode,
        signal: runSignal,
      })

      // Confirm applied model & thought_level via `session/set_config_option` (keeping speed: 'native').
      const appliedModelAndEffort =
        await this.runtime.bootstrap.configureModelAndEffortBeforePrompt({
          connection,
          sessionId: resolvedSessionId,
          descriptor,
          sessionStream,
          onMetadataNotification: (note) => {
            observePrePromptNotification(note, resolvedSessionId!)
          },
          onServerRequest: (req) => {
            handleOrderedServerRequest(req)
          },
          requestedModel: input.model,
          requestedEffort: input.effort,
          signal: runSignal,
        })

      let prePromptStreamEnd: Extract<AgyIngress, { kind: 'end' }> | undefined
      const handlePrePromptIngressItem = (item: AgyIngress): boolean => {
        if (item.kind === 'end') {
          prePromptStreamEnd ??= item
          return false
        }
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return true
        }
        if (item.kind === 'notification') {
          observePrePromptNotification(item.message, resolvedSessionId!)
        }
        return true
      }
      const drainPrePromptBuffered = (): void => {
        if (!sessionStream || prePromptStreamEnd) return
        while (true) {
          const item = sessionStream.shift()
          if (!item) break
          if (!handlePrePromptIngressItem(item)) break
        }
      }
      let prePromptDrainAbort: AbortController | undefined
      let prePromptDrainTask: Promise<void> | undefined
      stopPrePromptDrain = async (drainRemaining = true): Promise<void> => {
        const abort = prePromptDrainAbort
        const task = prePromptDrainTask
        prePromptDrainAbort = undefined
        prePromptDrainTask = undefined
        abort?.abort()
        if (task) {
          await task.catch(() => undefined)
        }
        if (drainRemaining) {
          drainPrePromptBuffered()
        }
      }
      if (sessionStream) {
        const activePrePromptStream = sessionStream
        const drainAbort = new AbortController()
        prePromptDrainAbort = drainAbort
        prePromptDrainTask = (async () => {
          while (!drainAbort.signal.aborted && !prePromptStreamEnd) {
            drainPrePromptBuffered()
            if (drainAbort.signal.aborted || prePromptStreamEnd) break
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Drain trailing session/load replay continuously across pre-prompt setup.
              nextItem = await activePrePromptStream.nextIngress(undefined, drainAbort.signal)
            } catch (err) {
              if (drainAbort.signal.aborted) break
              prePromptStreamEnd ??= {
                kind: 'end',
                seq: 0,
                cause: 'transport',
                incomplete: true,
                detail: err instanceof Error ? err.message : String(err),
              }
              break
            }
            handlePrePromptIngressItem(nextItem)
          }
        })()
      }
      const throwIfPrePromptStreamClosed = async (): Promise<void> => {
        if (!prePromptStreamEnd && connection.isOpen) return
        await stopPrePromptDrain?.(false)
        recordHostBeforeRootStart()
        this.kernel.recordDispatch('rejected', resolvedSessionId, activeExecutorId)
        if (connection.closeReason instanceof AgentExecutionError) {
          throw connection.closeReason
        }
        throw new AgentExecutionError(
          prePromptStreamEnd?.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
          prePromptStreamEnd?.detail ??
            connection.closeReason?.message ??
            'Antigravity ACP connection closed before prompt dispatch.',
          prePromptStreamEnd?.cause === 'deadline',
        )
      }

      let earlyEvent = shiftPendingEvent()
      while (earlyEvent !== undefined) {
        yield earlyEvent
        earlyEvent = shiftPendingEvent()
      }

      const appliedSettings = this.runtime.bootstrap.buildEffectiveExecutionSettings(
        appliedModelAndEffort.model,
        appliedModelAndEffort.effort,
        appliedModelAndEffort.effortKnown,
        effectivePermissionMode,
      )

      if (input.host?.recovery) {
        if (appliedSettings) {
          input.host?.recovery.recordEffectiveSettings(appliedSettings, {
            executorId: activeExecutorId,
            nativeSessionId: resolvedSessionId,
          })
        }
        if (input.host?.recovery.expected) {
          const exp = input.host?.recovery.expected
          if (
            !appliedSettings ||
            exp.executorId !== activeExecutorId ||
            exp.nativeSessionId !== resolvedSessionId ||
            !isDeepStrictEqual(exp.settings, appliedSettings)
          ) {
            recordHostBeforeRootStart()
            throw new NativeInputWithheldError(
              'Antigravity replacement settings or executor differed from the expected recovery binding.',
            )
          }
        }
      }

      // Prepare prompt content with Cutoff serialization & verified ACP images.
      const images: AgentPromptImage[] = []
      const currentEnvelope = input.currentPromptEnvelope?.() ?? input.promptEnvelope
      const sourceForm: AgentSourceReadForm | undefined = mcpServer.sourceCapability.sourceReference
        ? 'sourceReference'
        : mcpServer.sourceCapability.nativeRoot
          ? 'nativeRoot'
          : mcpServer.sourceCapability.legacy
            ? 'legacy'
            : undefined
      const sourceReader = input.host?.workflow?.sourceReader
      const navigate =
        sourceReader && sourceForm !== undefined
          ? (target: Parameters<AgentCollaborationSourceReader['navigation']>[0]) =>
              sourceReader.navigation(target, sourceForm)
          : undefined
      const navigateCutoff =
        sourceForm !== undefined ? cutoffSourceNavigator(sourceReader, sourceForm) : undefined

      for (const group of agentPromptImageGroups(currentEnvelope)) {
        images.push(...group.images)
      }
      promptMemoryReservation = connection.reserveWorkingMemory(
        64 * 1024 +
          Buffer.byteLength(systemAppend, 'utf8') * 2 +
          nativeImagePreparationBytes(images),
      )
      toolStateMemoryReservation = connection.reserveWorkingMemory(0)
      foregroundDedupMemoryReservation = connection.reserveWorkingMemory(0)
      mcpCorrelationMemoryReservation = connection.reserveWorkingMemory(0)
      publishedPlanMemoryReservation = connection.reserveWorkingMemory(0)
      stagedPreBindMemoryReservation = connection.reserveWorkingMemory(0)
      foreignExecIdsMemoryReservation = connection.reserveWorkingMemory(0)
      postCutoffBgMemoryReservation = connection.reserveWorkingMemory(0)
      const promptBlocks = await agyPromptInput(
        currentEnvelope,
        runSignal,
        navigate,
        navigateCutoff,
        {
          pactRunId: input.runId,
        },
      )
      if (workflow && systemAppend && promptBlocks[0]?.type === 'text') {
        promptBlocks[0] = {
          type: 'text',
          text: `Pact host instructions for this turn:\n${systemAppend}\n\n${promptBlocks[0].text}`,
        }
      }
      const expectedFullPromptText = promptBlocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      const turnEpoch = this.runtime.nextTurnEpoch++
      const roundTracker = new AgyRoundEffectsTracker(
        lease.canonicalCwd,
        mcpServer.serverName,
        this.runtime.primaryAppDataDir,
        resolvedSessionId,
      )

      const knownForeignExecutionIds = new Set<string>()
      for (const other of this.runtime.activeRuns.values()) {
        if (
          other.nativeSessionId === resolvedSessionId &&
          !other.rootTerminal &&
          other.providerExecutionId !== undefined
        ) {
          knownForeignExecutionIds.add(other.providerExecutionId)
        }
      }
      activeRun = {
        runId: input.runId,
        sessionId: input.sessionId,
        cwd: lease.canonicalCwd,
        nativeSessionId: resolvedSessionId,
        nativeTurnId: input.runId,
        providerExecutionId: undefined,
        rootStepIdx: undefined,
        resumedExistingSession: Boolean(input.nativeSessionId),
        knownForeignExecutionIds,
        foreignTurnActiveUntilRootBound: false,
        stagedPreBindNotifications: [],
        bindingGeneration: input.bindingGeneration ?? 1,
        nativeGeneration: input.nativeGeneration ?? input.runId,
        executorId: activeExecutorId,
        connection,
        turnEpoch,
        turnAccepted: false,
        promptReplyReceived: false,
        foregroundReleased: false,
        rootReleasing: false,
        rootTerminal: false,
        cancellationPending: false,
        steeringInFlight: false,
        steeredInputs: new Map(),
        pendingSteerOperations: new Set(),
        rootExecutionWaiters: new Set(),
        activeBackgroundTasks: new Set(),
        backgroundTaskAliases: new Map(),
        backgroundUnconfirmed: false,
        observation,
        retireSourceReader,
        isSteerLeaseOpen: () =>
          !this.runtime.disposed &&
          !promptReplyReceived &&
          !activeRun!.promptReplyReceived &&
          !rootTerminal &&
          !rootReleasing &&
          !foregroundReleased &&
          !activeRun!.cancellationPending &&
          activeRun!.turnAccepted &&
          connection.isOpen,
      }
      this.runtime.activeRuns.set(input.runId, activeRun)

      if (mcpServer.hasTools) {
        const hostTrajectory = await loadHostTrajectoryIdentityBeforePrompt(
          AbortSignal.any([runSignal, observation.signal, AbortSignal.timeout(2_500)]),
        )
        if (hostTrajectory.status === 'ok') {
          mcpServer.pinHostTrajectoryId(hostTrajectory.trajectoryId, hostTrajectory.stepCount)
          if (activeRun.rootStepIdx === undefined) {
            activeRun.rootStepIdx = hostTrajectory.stepCount
          }
        } else if (hostTrajectory.status === 'invalid') {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
            hostTrajectory.reason ??
              'Antigravity trajectory storage metadata is invalid or corrupted.',
            false,
          )
        } else if (
          hostTrajectory.status === 'budget_exceeded' ||
          hostTrajectory.status === 'worker_error'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'runtime_incompatible',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'budget_exceeded'
                ? 'Antigravity trajectory storage exceeded the bounded identity read budget.'
                : 'Antigravity trajectory identity worker failed before prompt dispatch.'),
            false,
          )
        } else if (
          hostTrajectory.status === 'transient_churn' ||
          hostTrajectory.status === 'timeout'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'transient_transport',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'timeout'
                ? 'Antigravity trajectory identity inspection timed out before prompt dispatch.'
                : 'Antigravity trajectory storage remained unstable before prompt dispatch.'),
            true,
          )
        } else if (hostTrajectory.status === 'missing') {
          if (activeRun.rootStepIdx === undefined) {
            recordHostBeforeRootStart()
            throw new AgentExecutionError(
              input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
              hostTrajectory.reason ??
                (input.nativeSessionId
                  ? 'Antigravity trajectory database for the resumed session is missing before prompt dispatch.'
                  : 'Antigravity trajectory database for the new session is missing before prompt dispatch.'),
              false,
            )
          }
        } else if (hostTrajectory.status === 'no_storage_root') {
          mcpServer.disallowLazyStorageDbPin()
        }
      }

      await throwIfPrePromptStreamClosed()

      yield {
        agentId: 'agy',
        type: 'session.started',
        nativeSessionId: resolvedSessionId,
      }
      yield {
        agentId: 'agy',
        type: 'run.model.resolved',
        model: appliedModelAndEffort.model,
        effort: appliedModelAndEffort.effort,
      }
      const requestedSpeed = input.speed ?? 'native'
      yield {
        agentId: 'agy',
        type: 'run.speed.resolved',
        requested: requestedSpeed,
        ...(requestedSpeed !== 'native'
          ? {
              detail:
                'Antigravity does not expose native speed controls; continuing at native provider speed.',
            }
          : {}),
      }

      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: activeRun.nativeGeneration,
        state: 'pending',
      })

      // Post-turn background listener & dedup observer for attributable out-of-turn completion updates.
      const observer = new AgyTurnBackgroundObserver({
        runtime: this.runtime,
        input,
        mcpServer,
        getActiveRun: () => activeRun,
        getResolvedSessionId: () => resolvedSessionId,
        canSettleEffects: () => !unknownEffectsReported,
        isRootTerminal: () => rootTerminal,
        reportUnknown,
        getForegroundDedupReservation: () => foregroundDedupMemoryReservation,
        getPostCutoffBgReservation: () => postCutoffBgMemoryReservation,
      })
      backgroundObserver = observer

      // Abort handler: distinguishes pre-write abort (`not_sent`) from post-write `session/cancel`
      // with a bounded settlement window for a real native `{ stopReason: 'cancelled' }` reply.
      const onCallerAbort = (): void => {
        this.kernel.requestAbort()
        if (rootTerminal) return
        userCancelRequested = true
        if (activeRun) activeRun.cancellationPending = true
        for (const ctrl of interactionControllers) ctrl.abort()
        if (!rootFirstByteWritten) {
          promptRpcAbort.abort()
          return
        }
        if (promptSettled) return
        void connection.notify('session/cancel', { sessionId: resolvedSessionId }, {}).catch(() => {
          if (!rootTerminal) {
            reportUnknown(
              'Native Antigravity cancellation could not be confirmed; observation remains active.',
            )
          }
        })
        if (cancelGraceTimer === undefined) {
          cancelGraceTimer = setTimeout(() => {
            cancelGraceTimer = undefined
            promptRpcAbort.abort()
          }, AGY_PHYSICAL_SETTLEMENT_GRACE_MS)
          cancelGraceTimer.unref?.()
        }
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      if (signal.aborted) {
        onCallerAbort()
      }

      // Dispatch `session/prompt` with ordered reply delivery (`replyTo: sessionStream`).
      let rootWithheldByGuard = false
      const promptParams: Record<string, unknown> = {
        sessionId: resolvedSessionId,
        prompt: promptBlocks,
        ...systemPromptMeta,
      }

      await stopPrePromptDrain(true)
      await throwIfPrePromptStreamClosed()

      promptEnteredTransport = true
      const promptOp = connection.requestOwned('session/prompt', promptParams, {
        timeoutMs: undefined,
        signal: promptRpcAbort.signal,
        replyTo: sessionStream,
        canDispatch: () => {
          if (this.runtime.disposed || signal.aborted || userCancelRequested) return false
          if (input.host?.recovery?.canDispatch && !input.host?.recovery.canDispatch()) {
            rootWithheldByGuard = true
            return false
          }
          return true
        },
        onDispatch: () => {
          rootFirstByteWritten = true
          promptMemoryReservation?.release()
          promptMemoryReservation = undefined
          this.kernel.recordDispatch('possibly_sent', resolvedSessionId, activeExecutorId)
        },
      })

      let promptResponse: object | undefined
      let parsedPromptTerminalReply: ParsedAgyPromptTerminalReply | undefined
      let promptRpcResolvedResponse: object | undefined
      let promptError: Error | undefined
      let pumpError: Error | undefined
      let streamEnded = false
      const pumpAbort = new AbortController()
      stopStreamPump = (): void => {
        pumpAbort.abort()
      }

      const settlePromptFromResponse = (res: object): void => {
        promptResponse = res
        parsedPromptTerminalReply = parseAgyPromptTerminalReply(res, resolvedSessionId)
        promptSettled = true
        promptReplyReceived = true
        abortOutstandingInteractions()
        if (activeRun) {
          activeRun.promptReplyReceived = true
          if (
            parsedPromptTerminalReply.ok &&
            parsedPromptTerminalReply.executionId &&
            !activeRun.providerExecutionId &&
            !activeRun.knownForeignExecutionIds.has(parsedPromptTerminalReply.executionId)
          ) {
            this.runtime.projector.bindRootExecutionId(
              activeRun,
              input,
              parsedPromptTerminalReply.executionId,
            )
          }
          this.runtime.projector.notifyRootExecutionWaiters(activeRun)
        }
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        notifyEventLoop()
      }

      void promptOp.result.then(
        (res) => {
          promptRpcResolvedResponse = res
          // Normal path waits for the ordered `{ kind: 'reply', seq }` ingress frame on `sessionStream`
          // so all notifications with `seq < cutoffSeq` are guaranteed pre-cutoff.
          // If the stream already ended before delivering the reply frame, settle immediately.
          if (streamEnded && !promptSettled) {
            settlePromptFromResponse(res)
          }
          return undefined
        },
        (err: unknown) => {
          promptError ??= err instanceof Error ? err : new Error(String(err))
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.runtime.projector.notifyRootExecutionWaiters(activeRun)
          }
          if (cancelGraceTimer !== undefined) {
            clearTimeout(cancelGraceTimer)
            cancelGraceTimer = undefined
          }
          pumpAbort.abort()
          notifyEventLoop()
          return undefined
        },
      )

      const answer = new AgentAnswerAssembler(input.runId)
      let totalToolStateBytes = 0
      const resizeToolStateBytes = (state: AgyToolState, nextBytes: number): void => {
        const clamped = Math.max(0, nextBytes)
        const delta = clamped - state.reservedBytes
        if (delta === 0) return
        if (totalToolStateBytes + delta > AGY_MAX_TOOL_STATE_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity in-flight tool call payloads exceeded the 8 MiB working-memory budget.',
            false,
          )
        }
        totalToolStateBytes = Math.max(0, totalToolStateBytes + delta)
        state.reservedBytes = clamped
        toolStateMemoryReservation?.resize(totalToolStateBytes)
      }
      const reasoningItems = new Map<string, string>()
      let reasoningBytes = 0
      let currentMessageIndex = 0
      let currentThoughtIndex = 0
      let reviewResult: CollaborationReviewObservation | undefined
      let inputResult: CollaborationInputObservation | undefined
      let planRetained = false
      let publishedOpenPlan: { nativeId: string; text: string } | undefined
      let openPlanPublishFailed = false
      let openPlanUnavailableRecorded = false
      let sessionTitleEmitted = false

      const observeFiles = (evidence: Parameters<typeof recordNativeChanges>[1]): void => {
        if (recordings.size >= 8) {
          nativeEffectsUncertain(
            input,
            'Native Antigravity file observation exceeded its bounded recording queue.',
            'recorded_files',
          )
          reportUnknown('Native file recording queue exceeded capacity.')
          return
        }
        const task = recordingTail.then(() =>
          recordNativeChanges(input, evidence, observation.signal),
        )
        recordingTail = task
        recordings.add(task)
        void task.finally(() => recordings.delete(task))
      }

      const projectValidatedFrame = (
        validated: ValidatedAgyFrame,
      ): Generator<NormalizedAgentEvent> => {
        const receivedAfterPromptReply =
          promptCutoffSeq !== undefined && validated.seq > promptCutoffSeq
        return this.runtime.projector.projectSessionNotification({
          validated,
          receivedAfterPromptReply,
          input,
          activeRun: activeRun!,
          cwd: lease!.canonicalCwd,
          mcpServer,
          roundTracker,
          answer,
          tools,
          approvedBrainPlanCalls,
          resizeToolStateBytes,
          reasoningItems,
          getReasoningBytes: () => reasoningBytes,
          setReasoningBytes: (v) => {
            reasoningBytes = v
          },
          getMessageIndex: () => currentMessageIndex,
          bumpMessageIndex: () => {
            currentMessageIndex += 1
          },
          getThoughtIndex: () => currentThoughtIndex,
          bumpThoughtIndex: () => {
            currentThoughtIndex += 1
          },
          planModeStage,
          onBrainPlanTouched: () => {
            brainPlanTouched = true
          },
          onBrainPlanOpStarted: (callId) => {
            // Invalidate any prior Plan candidate as soon as a subsequent Plan mutation begins so
            // deferred readback or the newer body is always obtained before publication.
            latestBrainPlanCandidate = undefined
            const hasOtherActivePlanOp =
              activeBrainPlanOpCallIds.size > (activeBrainPlanOpCallIds.has(callId) ? 1 : 0)
            if (hasOtherActivePlanOp) {
              // Overlapping Phase-1 Plan ops MUST verify final disk body via storage readback.
              brainPlanReadbackRequired = true
            }
            activeBrainPlanOpCallIds.add(callId)
          },
          onBrainPlanDeferredReadback: (callId) => {
            activeBrainPlanOpCallIds.delete(callId)
            latestBrainPlanCandidate = undefined
            brainPlanReadbackRequired = true
          },
          onBrainPlanCaptured: (callId, candidate) => {
            activeBrainPlanOpCallIds.delete(callId)
            if (activeBrainPlanOpCallIds.size === 0 && !brainPlanReadbackRequired) {
              latestBrainPlanCandidate = candidate
              brainPlanCaptureFailed = false
              input.host?.workflow?.recordPlan?.(candidate)
            } else {
              // Another concurrent Plan op was in flight or readback was already latched; defer to verified storage readback.
              brainPlanReadbackRequired = true
              latestBrainPlanCandidate = undefined
            }
          },
          onBrainPlanCaptureFailed: (callId) => {
            if (callId !== undefined) activeBrainPlanOpCallIds.delete(callId)
            brainPlanCaptureFailed = true
            latestBrainPlanCandidate = undefined
            input.host?.workflow?.recordPlanUnavailable?.()
          },
          onReviewAccepted: (obs) => {
            reviewResult = mergeWorkflowReview(reviewResult, obs)
            input.host?.workflow?.recordReview?.(reviewResult)
          },
          onInputResultAccepted: (obs) => {
            inputResult = mergeWorkflowInput(inputResult, obs)
            input.host?.workflow?.recordInputResult?.(inputResult)
          },
          onPlanRetainedAccepted: () => {
            if (!brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
              planRetained = true
            }
          },
          onOpenPlanPublished: (plan) => {
            try {
              publishedPlanMemoryReservation?.resize(
                computeRetainedPlanTextBytes(plan.text) + plan.nativeId.length * 2,
              )
              publishedOpenPlan = plan
              openPlanPublishFailed = false
              openPlanUnavailableRecorded = false
              input.host?.workflow?.recordPlan?.(plan)
            } catch {
              openPlanPublishFailed = true
              publishedOpenPlan = undefined
              if (!openPlanUnavailableRecorded) {
                openPlanUnavailableRecorded = true
                input.host?.workflow?.recordPlanUnavailable?.()
              }
            } finally {
              mcpServer.clearPendingTransferredPlanBytes()
            }
          },
          onOpenPlanPublishFailed: () => {
            openPlanPublishFailed = true
            publishedOpenPlan = undefined
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.host?.workflow?.recordPlanUnavailable?.()
            }
          },
          getSessionTitleEmitted: () => sessionTitleEmitted,
          markSessionTitleEmitted: () => {
            sessionTitleEmitted = true
          },
          recordSeenForegroundMessageId: (msgIdentity, trustedStepIdx) => {
            observer.recordSeenForegroundMessageId(msgIdentity, trustedStepIdx)
          },
          recordForegroundStepIdx: (stepIdx) => {
            observer.recordForegroundStepIdx(stepIdx)
          },
          onObservedBackgroundTask: () => {
            observer.markObservedBackgroundTask()
          },
          reportUnknown,
          observeFiles,
          signal,
        })
      }

      const frameAdmitter = new AgyTurnFrameAdmitter({
        runtime: this.runtime,
        input,
        activeRun,
        mcpServer,
        prePromptReplayedToolCallIds,
        expectedFullPromptText,
        expectedPromptContent: currentEnvelope.message.content.trim(),
        stagedPreBindReservation: stagedPreBindMemoryReservation,
        foreignExecIdsReservation: foreignExecIdsMemoryReservation,
        projectValidatedFrame,
      })

      const routePostCutoffIngress = (item: AgyIngress): void => {
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return
        }
        if (item.kind !== 'notification') return
        if (asString(Reflect.get(item.message, 'method')) !== 'session/update') return
        const params = Reflect.get(item.message, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== resolvedSessionId || !isPlainObject(params.update)) return
        observer.enqueuePostCutoffBackgroundUpdate(params, params.update)
      }

      const dispatchOrderedIngress = (item: AgyIngress): void => {
        if (item.kind === 'end') {
          streamEnded = true
          if (promptCutoffSeq === undefined) {
            if (promptRpcResolvedResponse && !promptSettled) {
              settlePromptFromResponse(promptRpcResolvedResponse)
            } else if (!promptError) {
              if (!activeRun!.turnAccepted && connection.isOpen) {
                void connection
                  .notify('session/cancel', { sessionId: resolvedSessionId! }, {})
                  .catch(() => undefined)
              }
              promptError ??= new AgentExecutionError(
                item.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
                item.detail ?? 'Antigravity session stream ended before prompt settlement.',
                item.cause === 'deadline',
              )
              promptSettled = true
              promptReplyReceived = true
              abortOutstandingInteractions()
              if (activeRun) {
                activeRun.promptReplyReceived = true
                this.runtime.projector.notifyRootExecutionWaiters(activeRun)
              }
              promptRpcAbort.abort()
              notifyEventLoop()
            }
          }
          return
        }

        if (item.kind === 'reply') {
          if (item.requestId === promptOp.requestId && promptCutoffSeq === undefined) {
            promptCutoffSeq = item.seq
            settlePromptFromResponse(item.message)
          }
          return
        }

        // Strict stdout-order post-cutoff routing: even while foreground is still yielding or
        // awaiting `waitForRootOutput()` / `recordingTail`, post-cutoff updates flow immediately
        // into the serialized background observer without blocking or contaminating foreground state.
        if (promptCutoffSeq !== undefined) {
          routePostCutoffIngress(item)
          return
        }

        // Pre-cutoff ordered frame (`item.seq < promptCutoffSeq`).
        mcpServer.beginWakeBatch()
        try {
          if (item.kind === 'server_request') {
            handleOrderedServerRequest(item)
            return
          }
          if (!rootFirstByteWritten && item.kind === 'notification') {
            const method = asString(Reflect.get(item.message, 'method'))
            const params = Reflect.get(item.message, 'params')
            const update = isPlainObject(params) ? Reflect.get(params, 'update') : undefined
            const sessionUpdate = isPlainObject(update) ? asString(update.sessionUpdate) : undefined
            if (
              method === 'session/update' &&
              (!sessionUpdate || !AGY_SESSION_METADATA_UPDATES.has(sessionUpdate))
            ) {
              if (resolvedSessionId !== undefined) {
                observePrePromptNotification(item.message, resolvedSessionId)
              }
              return
            }
          }
          const validated = validateAgyFrame(
            item,
            resolvedSessionId,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          for (const ev of frameAdmitter.admitAndProject(validated)) {
            pushPendingEvent(ev)
          }
        } finally {
          mcpServer.endWakeBatch()
        }
      }

      handoffOrderedStreamToBackground = (): void => {
        observer.handoffOrderedStreamToBackground({
          connection,
          sessionStream,
          promptCutoffSeq,
          routePostCutoffIngress,
          onStreamClosed: () => {
            sessionStream = undefined
          },
        })
      }

      // Continuous async frame pump over `sessionStream` with bounded backpressure on `pendingEvents`.
      const isPumpActive = (): boolean =>
        !pumpAbort.signal.aborted && !streamEnded && sessionStream !== undefined
      void (async () => {
        try {
          while (isPumpActive()) {
            if (isPendingEventsAtSoftCap() && promptCutoffSeq === undefined) {
              // oxlint-disable-next-line no-await-in-loop -- Apply backpressure to ordered stream when generator consumer lags.
              await new Promise<void>((resolveDrain) => {
                wakePumpForBackpressure = resolveDrain
                if (!isPumpActive() || !isPendingEventsAtSoftCap()) {
                  wakePumpForBackpressure = undefined
                  resolveDrain()
                }
              })
              if (!isPumpActive()) break
            }
            let drainedAny = false
            const canDrainPendingIngress = (): boolean =>
              !isPendingEventsAtSoftCap() || promptCutoffSeq !== undefined
            while (isPumpActive() && canDrainPendingIngress()) {
              const buffered = sessionStream?.shift()
              if (!buffered) break
              drainedAny = true
              dispatchOrderedIngress(buffered)
            }
            if (!isPumpActive() || !sessionStream) break
            if (drainedAny) continue
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Continuous ordered ingress pump independent of generator yield backpressure.
              nextItem = await sessionStream.nextIngress(undefined, pumpAbort.signal)
            } catch (waitErr) {
              if (pumpAbort.signal.aborted) break
              const err = waitErr instanceof Error ? waitErr : new Error(String(waitErr))
              if (promptCutoffSeq === undefined) {
                if (!activeRun.turnAccepted && connection.isOpen) {
                  void connection
                    .notify('session/cancel', { sessionId: resolvedSessionId }, {})
                    .catch(() => undefined)
                }
                promptError ??= err
                promptSettled = true
                promptReplyReceived = true
                abortOutstandingInteractions()
                if (activeRun) {
                  activeRun.promptReplyReceived = true
                  this.runtime.projector.notifyRootExecutionWaiters(activeRun)
                }
                promptRpcAbort.abort()
                notifyEventLoop()
              }
              break
            }
            dispatchOrderedIngress(nextItem)
          }
        } catch (err) {
          pumpError ??= err instanceof Error ? err : new Error(String(err))
          promptError ??= pumpError
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.runtime.projector.notifyRootExecutionWaiters(activeRun)
          }
          promptRpcAbort.abort()
          notifyEventLoop()
        }
      })()

      try {
        while (true) {
          while (pendingEvents.length > 0) {
            const nextEv = shiftPendingEvent()
            if (nextEv) yield nextEv
          }
          if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
            for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
              yield ev
            }
          }
          if (promptSettled) {
            while (pendingEvents.length > 0) {
              const nextEv = shiftPendingEvent()
              if (nextEv) yield nextEv
            }
            if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
              for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
                yield ev
              }
            }
            break
          }
          // oxlint-disable-next-line no-await-in-loop -- Generator yields events as the independent frame pump pushes them.
          await new Promise<void>((resolveWake) => {
            wakeEventLoop = resolveWake
          })
        }

        // Fence steer dispatch BEFORE releasing the root Turn, and verify any dispatched steer receipts.
        rootReleasing = true
        activeRun.rootReleasing = true
        signal.removeEventListener('abort', onCallerAbort)
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }

        if (pumpError) {
          promptError = pumpError
        }
        if (promptError) {
          promptRpcAbort.abort()
          const physical = await awaitPhysicalCompletionBounded(promptOp.physicalOutcome)
          if (physical === 'not_sent' && !rootFirstByteWritten) {
            rootConfirmedNotSent = true
            this.kernel.recordDispatch('rejected', resolvedSessionId, activeExecutorId)
            if (input.host?.recovery && appliedSettings) {
              const unsent = createAgyRootFrameNotWrittenProof({
                runId: input.runId,
                bindingGeneration: input.bindingGeneration ?? 1,
                nativeGeneration: input.nativeGeneration ?? input.runId,
                executorId: activeExecutorId,
                nativeSessionId: resolvedSessionId,
                inputSha256: input.host?.recovery.inputSha256,
                appliedSettings,
                requestId: promptOp.requestId,
                physicalCompletion: physical,
              })
              if (unsent) {
                input.host?.recovery.recordConfirmedUnsent(unsent.boundary, {
                  executorId: activeExecutorId,
                  nativeSessionId: resolvedSessionId,
                })
              }
            }
            if (rootWithheldByGuard) {
              throw new NativeInputWithheldError(
                'Antigravity root prompt was withheld by the recovery dispatch guard before any byte was written.',
              )
            }
          } else if (physical === 'invalid_reply') {
            reportUnknown(
              'Antigravity received an invalid session/prompt response after request bytes were written.',
            )
          } else {
            reportUnknown(
              userCancelRequested
                ? 'Antigravity cancellation did not receive a confirmed native terminal settlement.'
                : !activeRun.turnAccepted
                  ? 'Antigravity prompt write started without Turn acceptance confirmation.'
                  : 'Antigravity Turn ended without confirmed native terminal settlement.',
            )
          }
          throw promptError
        }

        const parsedTerminal =
          parsedPromptTerminalReply ??
          parseAgyPromptTerminalReply(promptResponse, resolvedSessionId)
        if (!parsedTerminal.ok) {
          reportUnknown(parsedTerminal.reason)
          throw new AgentExecutionError('protocol_error', parsedTerminal.message, false)
        }
        const stopReason = parsedTerminal.stopReason
        const respExecId = parsedTerminal.executionId
        if (respExecId) {
          if (activeRun.knownForeignExecutionIds.has(respExecId)) {
            reportUnknown(
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
              false,
            )
          }
          if (activeRun.providerExecutionId && activeRun.providerExecutionId !== respExecId) {
            reportUnknown(
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
              false,
            )
          }
          this.runtime.projector.bindRootExecutionId(activeRun, input, respExecId)
        }
        this.runtime.projector.notifyRootExecutionWaiters(activeRun)

        if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
          for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
            yield ev
          }
        }
        if (frameAdmitter.hasUnresolvedSubstantivePreBind()) {
          unresolvedPreBindOutput = true
          reportUnknown(
            'Antigravity terminal reply completed without binding execution_id for staged updates; output completeness cannot be confirmed.',
          )
        }
        frameAdmitter.clearStagedPreBindNotifications()

        if (!activeRun.turnAccepted) {
          activeRun.turnAccepted = true
          this.kernel.recordDispatch('accepted', resolvedSessionId, activeExecutorId)
          yield { agentId: 'agy', type: 'turn.started', turnId: input.runId }
        }

        if (activeRun.pendingSteerOperations.size > 0) {
          await Promise.allSettled(activeRun.pendingSteerOperations)
        }

        const postReplyCheckSignal = stopReason === 'cancelled' ? signal : observation.signal

        // Verify any in-Turn steer writes before releasing the root Turn (`B8`).
        await this.runtime.projector.verifySteerReceiptsBeforeRootRelease(
          activeRun,
          input,
          reportUnknown,
          postReplyCheckSignal,
        )

        // Complete any open reasoning items.
        for (const [idxKey, text] of reasoningItems) {
          if (text) {
            yield {
              agentId: 'agy',
              type: 'reasoning.summary.completed',
              turnId: input.runId,
              activityId: `${input.runId}:thought:${idxKey}`,
              text,
            }
          }
        }
        reasoningItems.clear()

        // If a brain plan write was touched and did not capture inline (or readback was latched due to
        // overlapping ops / deferred edit readback), inspect through the isolated storage client
        // (NEVER direct Utility `fs.open`!) for the SAME execution.
        if (
          planModeStage &&
          (latestBrainPlanCandidate === undefined || brainPlanReadbackRequired) &&
          !brainPlanCaptureFailed
        ) {
          if (brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
            const inspected = this.runtime.options.storageClient?.inspectRun
              ? await this.runtime.options.storageClient
                  .inspectRun(
                    {
                      appDataDir: this.runtime.primaryAppDataDir,
                      cwd: lease.canonicalCwd,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
              : await this.runtime
                  .getOwnedForkFiles()
                  .inspectAgyRun(
                    {
                      cwd: lease.canonicalCwd,
                      storageRoot: this.runtime.primaryAppDataDir,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
            const terminal = inspected?.exists ? inspected.terminalState : undefined
            const matchesExecution =
              terminal !== undefined &&
              !terminal.planUnavailable &&
              (activeRun.providerExecutionId === undefined ||
                terminal.executionId === activeRun.providerExecutionId)
            if (matchesExecution && terminal.plan?.text.trim()) {
              latestBrainPlanCandidate = {
                nativeId:
                  terminal.plan.nativeId ||
                  buildBoundedNativePlanId(resolvedSessionId, 'implementation_plan'),
                text: terminal.plan.text,
              }
              brainPlanReadbackRequired = false
              input.host?.workflow?.recordPlan?.(latestBrainPlanCandidate)
            } else {
              brainPlanCaptureFailed = true
              latestBrainPlanCandidate = undefined
              input.host?.workflow?.recordPlanUnavailable?.()
            }
          }
        }

        await recordingTail
        await input.host?.lifecycle?.waitForRootOutput?.()
        await observer.awaitTail()

        const finalSnapshot = answer.finalize()
        if (finalSnapshot !== undefined && !unresolvedPreBindOutput) {
          yield {
            agentId: 'agy',
            type: 'text.completed',
            turnId: input.runId,
            outputId: answer.outputId,
            text: finalSnapshot,
          }
        }

        // Preserve verified native `stopReason` (`end_turn` -> `completed`) even if Stop (`signal.aborted`)
        // arrived late while draining foreground output!
        const outcome: 'completed' | 'interrupted' | 'failed' =
          stopReason === 'cancelled'
            ? 'interrupted'
            : stopReason === 'end_turn' || stopReason === 'stop_sequence'
              ? 'completed'
              : 'failed'

        // Record negative plan unavailability OUTSIDE `!unknownEffectsReported` so recovery is never
        // suppressed when an open-mode final `publish_plan` was acknowledged without confirmed ACP promotion
        // or when a Phase-1 brain plan write failed.
        if (outcome === 'completed') {
          if (planModeStage) {
            if (
              hasUnresolvedBrainPlanWrite() ||
              brainPlanCaptureFailed ||
              brainPlanReadbackRequired
            ) {
              input.host?.workflow?.recordPlanUnavailable?.()
            }
          } else if (
            openPlanPublishFailed ||
            (mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan)
          ) {
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.host?.workflow?.recordPlanUnavailable?.()
            }
          }
        }

        // Promote collaboration artifacts ONLY after normal root completion & settlement (`B6`).
        if (outcome === 'completed' && !unknownEffectsReported && !unresolvedPreBindOutput) {
          if (planModeStage) {
            if (
              !hasUnresolvedBrainPlanWrite() &&
              !brainPlanCaptureFailed &&
              !brainPlanReadbackRequired
            ) {
              if (latestBrainPlanCandidate) {
                yield {
                  agentId: 'agy',
                  type: 'collaboration.plan',
                  turnId: input.runId,
                  nativeId: latestBrainPlanCandidate.nativeId,
                  text: latestBrainPlanCandidate.text,
                }
              } else if (planRetained && authorization?.planReference) {
                const planDoc = authorization.planReference.document
                input.host?.workflow?.recordPlanRetained?.({
                  nativeId: buildBoundedNativePlanId(resolvedSessionId, 'retained'),
                  sha256: planDoc.sha256,
                  bytes: planDoc.bytes,
                  chars: planDoc.chars,
                  confirmation: 'native_root_settled_v1',
                })
              }
            }
          } else if (
            !openPlanPublishFailed &&
            !(mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan) &&
            publishedOpenPlan
          ) {
            yield {
              agentId: 'agy',
              type: 'collaboration.plan',
              turnId: input.runId,
              nativeId: publishedOpenPlan.nativeId,
              text: publishedOpenPlan.text,
            }
          }
          if (reviewResult) {
            yield {
              agentId: 'agy',
              type: 'collaboration.review',
              turnId: input.runId,
              verdict: reviewResult.verdict,
              ...(reviewResult.questions ? { questions: reviewResult.questions } : {}),
            }
          }
        }

        rootTerminal = true
        activeRun.rootTerminal = true
        this.kernel.recordTerminal(outcome)

        const settledPlan = latestBrainPlanCandidate ?? publishedOpenPlan
        const outputCompleteness: 'complete' | 'partial' =
          outcome === 'completed' && !unresolvedPreBindOutput ? 'complete' : 'partial'
        const terminalEvidence: Parameters<AgyAdapterRuntime['recordEvidence']>[3] = {
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          ...(answer.text || (outcome === 'completed' && !unresolvedPreBindOutput && settledPlan)
            ? {
                output: {
                  outputId: answer.outputId,
                  text: answer.text,
                  completeness: outputCompleteness,
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && settledPlan
                    ? { plan: settledPlan }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && reviewResult
                    ? { reviewVerdict: reviewResult.verdict, reviewResult }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && inputResult
                    ? { inputOutcome: inputResult.outcome, inputResult }
                    : {}),
                },
              }
            : {}),
        }

        if (unresolvedPreBindOutput && outcome === 'completed') {
          // When unresolved substantive pre-bind frames remain after emitting a visible prefix,
          // emit `turn.completed { outcome: 'failed' }` (without `text.completed`) so SQLite marks
          // the truncated prefix `incomplete`, then record the independently verified native
          // outcome with `completeness: 'partial'` so `nativeOutcome` stays preserved.
          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome: 'failed',
          }
          this.runtime.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )
        } else {
          this.runtime.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )

          if (
            !unknownEffectsReported &&
            !unresolvedPreBindOutput &&
            !activeRun.backgroundUnconfirmed &&
            activeRun.activeBackgroundTasks.size === 0
          ) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }

          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome,
          }
        }
      } finally {
        clearPendingEvents()
        frameAdmitter.clearStagedPreBindNotifications()
        prePromptReplayedToolCallIds.clear()
        answer.dispose()
      }
    } catch (error) {
      rootTerminal = true
      if (activeRun) {
        activeRun.rootTerminal = true
        this.runtime.projector.notifyRootExecutionWaiters(activeRun)
      }
      if (cancelGraceTimer !== undefined) {
        clearTimeout(cancelGraceTimer)
        cancelGraceTimer = undefined
      }
      promptRpcAbort.abort()
      await stopPrePromptDrain?.(false).catch(() => undefined)
      stopStreamPump?.()
      this.runtime.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      await recordingTail.catch(() => undefined)
      const confirmedZeroBytesSent = isConfirmedZeroBytesSent()
      if (!unknownEffectsReported) {
        if (confirmedZeroBytesSent) {
          if (activeRun) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }
        } else {
          reportUnknown(
            unknownEffectsReason ??
              'Antigravity failed before its native Turn effects could be confirmed.',
          )
        }
      }
      throw error
    } finally {
      await finalizeRun({ emergency: false })
    }
  }
}
