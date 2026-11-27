import type { query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

import type { AgentRunInput, AgentSteerInput, AgentSteerResult } from '@pact/agent-runtime'
import type {
  CollaborationTask,
  CollaborationTurnAuthorization,
  NormalizedAgentEvent,
  RunEffectiveExecutionSettings,
  RuntimeAgentId,
} from '@pact/contracts'

import { RunLifecycleKernel, validateSourceGrant } from '@pact/agent-runtime'
import {
  collaborationOpenPlanPublishAllowed,
  collaborationPlanRetentionAllowed,
  collaborationPlanRetentionInputSchema,
  collaborationInputResultSchema,
  nativeBackgroundReportIdentitySchema,
  sessionTitleInputSchema,
} from '@pact/contracts'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  NativeInputWithheldError,
  PermissionModeRejectedError,
} from '../agent-execution-error'
import { ClaudeAnswerAssembler } from '../claude-answer-assembler'
import {
  mergeWorkflowInput,
  mergeWorkflowReview,
  readWorkflowReview,
} from '../collaboration-answer'
import {
  collaborationInputResultAllowed,
  collaborationInstructions,
  collaborationPlanMode,
  collaborationPlanningInstructions,
  collaborationReadOnly,
  collaborationReviewMode,
  frozenSourceInstructions,
} from '../collaboration-prompt'
import {
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
  type NativeChanges,
} from '../native-file-changes'
import { freezeNativeJsonFrame } from '../native-json-encoder'
import { NativePermissionWait } from '../native-permission-wait'
import { nativeSkillCatalog } from '../native-skill-catalog'
import { NativeWorkingMemory, type NativeMemoryReservation } from '../native-working-memory'
import { PeerAssistanceTurn } from '../peer-assistance-policy'
import {
  completedText,
  configureFastMode,
  confirmAutoMode,
  confirmNativeExecutionMode,
  describeTool,
  drainStderr,
  elicitationHandler,
  fastModeDisabledDetail,
  isRequestUuid,
  nextWithCancellation,
  permissionHandler,
  permissionOptions,
  promptMessages,
  readRunSettings,
  runSettingsOptions,
  supportsReasoningSummaries,
  withDeadline,
} from './permissions-and-settings'
import { ClaudePlanCaptureCoordinator } from './plan-capture-coordinator'
import { createClaudeTurnMcpServer } from './turn-mcp-server'
import {
  ClaudeNativeWork,
  FAST_MODE_CHECK_TIMEOUT_MS,
  MAX_NATIVE_CLAUDE_QUERIES,
  MAX_STEERING_INPUTS,
  NATIVE_INTERRUPT_TIMEOUT_MS,
  RUN_STARTUP_TIMEOUT_MS,
  type ClaudeAdapterRuntime,
  type ClaudeSteeringInput,
} from './types'

/**
 * Explicit TurnSession FSM for a single Claude Code native Query execution.
 *
 * Drives `RunLifecycleKernel` across:
 *   PreLease -> BootstrappingSession -> ReadyToDispatch -> DispatchedStreaming
 *     -> TerminalObserved | AbortRequested -> DrainingEffects -> Settled
 *
 * Preserves all Claude CLI protocol invariants (L1-L5):
 * - L1: Exit code 1 after confirmed interrupt + terminal result + stdin close is normal settlement.
 * - L2: Assembled vs delivered answer tracking via `ClaudeAnswerAssembler`.
 * - L3: Irreversible `unknown` lock on unconfirmed interruption/timeout/overflow.
 * - L4: Dual proof (reader EOF + actor exit) and `ambientTasks` exclusion from stoppable work.
 * - L5: Deferred result flushing after `interrupt({ cancelQueued: true })` recalls queued steering inputs.
 */
export class ClaudeTurnSession {
  readonly kernel: RunLifecycleKernel
  private readonly startupDeadline = Date.now() + RUN_STARTUP_TIMEOUT_MS
  private readonly nativeExecutorId = randomUUID()
  private readonly resolvedSessionId: string
  private readonly sourceReader: ReturnType<
    NonNullable<AgentRunInput['host']>['workflow'] extends infer W
      ? W extends { sourceReader?: infer R }
        ? () => R
        : () => undefined
      : () => undefined
  >
  private readonly hasSourceReader: boolean
  private readonly sourceGrant: { runId: string; grant: string; active: boolean } | undefined
  private readonly workflow: CollaborationTask | undefined
  private readonly authorization: CollaborationTurnAuthorization | undefined
  private readonly nativePlanning: boolean
  private readonly nativeRetention: boolean
  private readonly nativeOpenPlanPublish: boolean
  private readonly nativeReview: boolean
  private readonly nativeInputResult: boolean
  private readonly readOnlyStage: boolean
  private readonly showReasoningSummaries: boolean

  private readonly abortController = new AbortController()
  private readonly observation = new AbortController()
  private readonly queryMemory = new NativeWorkingMemory()
  private readonly answer: ClaudeAnswerAssembler
  private readonly nativeWork = new ClaudeNativeWork()
  private readonly permissionWait = new NativePermissionWait()
  private readonly planCapture: ClaudePlanCaptureCoordinator
  private readonly peerAssistanceAllowed: boolean
  private readonly peerTargetAgentId: RuntimeAgentId
  private readonly peerAssistance: PeerAssistanceTurn
  private readonly peerRequests: Array<
    Extract<NormalizedAgentEvent, { type: 'peer.assistance.requested' }>
  > = []

  private readonly titleToolName: string
  private readonly peerToolName: string
  private readonly reviewToolName: string
  private readonly inputResultToolName: string
  private readonly retentionToolName: string
  private readonly publishPlanToolName: string

  private readonly recordings = new Set<Promise<void>>()
  private recordingTail = Promise.resolve()
  private readonly reasoningBlocks = new Map<
    number,
    { activityId: string; text: string; bytes: number; emitted: boolean }
  >()
  private reasoningBytes = 0
  private readonly tools = new Map<
    string,
    { toolName: string; title: string; detail?: string | undefined }
  >()
  private readonly peerToolCallIds = new Set<string>()
  private readonly titleCalls = new Map<string, string>()
  private titleRecorded = false

  private session: ReturnType<typeof query> | undefined
  private iterator: AsyncIterator<SDKMessage> | undefined
  private nativeActor: ChildProcess | undefined
  private sessionStarted = false
  private permissionRefused = false
  private turnStarted = false
  private assistantMessageId: string
  private nativeResultAssistantText = false
  private nativeResultNumber = 0
  private resolvedModel: string | null
  private terminalKnown = false
  private terminalOutcome: 'completed' | 'failed' | 'interrupted' | undefined
  private currentRequestMatched = false
  private foregroundReleased = false
  private nativeNotStarted = false
  private inputWithheldError: NativeInputWithheldError | undefined
  private observedReportableTask = false
  private foreignBackgroundInput = false
  private observedBackgroundActivity = false
  private pendingRead: Promise<IteratorResult<SDKMessage>> | undefined
  private iteratorDone = false
  private interruptedReaderClosed = false
  private unknownReported = false
  private rootObservationUnknown = false
  private deliveryAttempted = false
  private interruptRequested = false
  private actorObserved = false
  private actorExited = false
  private readerSettled = false
  private readerEof = false
  private transportReleased = false
  private nativeQueueCancellationSupported = false
  private skillCatalogChangedDuringRun = false
  private speedDetail: string | undefined
  private lastSpeedState: string | undefined
  private projectionFailure: AgentExecutionError | undefined
  private nativeMessageIdentityUnconfirmed = false

  private readonly deferredResultMemory: NativeMemoryReservation
  private deferredResult: SDKMessage | undefined
  private deferredEnding: 'completed' | 'failed' | 'interrupted' | undefined
  private deferredResultHasText = false
  private inputReservation: NativeMemoryReservation | undefined

  private inputOpen = true
  private pendingInput: ClaudeSteeringInput | undefined
  private wakeInput: (() => void) | undefined
  private readonly steeredInputs = new Map<string, ClaudeSteeringInput>()
  private interruptTask: Promise<void> | undefined
  private releaseExitedTask: Promise<void> | undefined

  private readonly speedInput: PromiseWithResolvers<boolean> | undefined
  private readonly recoveryInput: PromiseWithResolvers<boolean> | undefined
  private readonly skillInput: PromiseWithResolvers<boolean> | undefined
  private confirmPermissionInput: ((confirmed: boolean) => void) | undefined
  private readonly permissionInput: Promise<boolean> | undefined

  constructor(
    private readonly runtime: ClaudeAdapterRuntime,
    private readonly input: AgentRunInput,
    private readonly signal: AbortSignal,
  ) {
    if (runtime.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Claude Code is shutting down.', false)
    }
    if (signal.aborted) {
      throw new AgentExecutionError('agent_process_crash', 'Claude Code was interrupted.', false)
    }

    this.sourceReader = input.host?.workflow?.sourceReader
    this.hasSourceReader = Boolean(this.sourceReader)
    this.sourceGrant = input.promptEnvelope.sourceGrant
      ? { ...input.promptEnvelope.sourceGrant, active: true }
      : undefined

    const grantCheck = validateSourceGrant({
      runId: input.runId,
      nativeGeneration: input.nativeGeneration,
      hasSourceReader: this.hasSourceReader,
      sourceGrant: input.promptEnvelope.sourceGrant,
    })
    if (!grantCheck.ok) {
      throw new AgentExecutionError(
        'protocol_error',
        grantCheck.reason ?? 'The source reader has no exact root owner.',
        false,
      )
    }

    // An exited transport with a missing Native ending remains unresolved and
    // still occupies one of the shared eight Native context slots.
    if (runtime.backgroundRuns.size + runtime.forkInitializing.size >= MAX_NATIVE_CLAUDE_QUERIES) {
      throw new NativeCapacityError(
        'Claude Code has too many owned native queries. Wait for background work to finish; no new task was submitted.',
      )
    }

    if (
      input.host?.recovery?.expected &&
      (input.host.recovery.expected.executorId !== this.nativeExecutorId ||
        input.host.recovery.expected.nativeSessionId !== input.nativeSessionId)
    ) {
      throw new NativeInputWithheldError(
        'The original native executor or Session changed. The replacement input was withheld.',
      )
    }

    this.workflow = input.promptEnvelope.collaboration
    this.authorization = input.promptEnvelope.collaborationAuthorization
    if (
      this.workflow &&
      (!this.authorization ||
        this.authorization.runId !== input.runId ||
        this.authorization.taskId !== this.workflow.id ||
        this.authorization.taskRevision !== this.workflow.revision ||
        this.authorization.stage !== this.workflow.stage ||
        this.authorization.inputSequence !== this.workflow.inputSequence ||
        this.workflow.sessionId !== input.sessionId ||
        input.promptEnvelope.sessionId !== input.sessionId ||
        this.authorization.actor !== runtime.id ||
        this.workflow.actor !== runtime.id)
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'The frozen Pact duty authorization is missing or inconsistent. Nothing was sent.',
        false,
      )
    }

    this.resolvedSessionId = input.nativeSessionId ?? randomUUID()
    this.assistantMessageId = input.runId
    this.resolvedModel = input.model
    this.showReasoningSummaries = supportsReasoningSummaries(input.model)
    this.nativePlanning = collaborationPlanMode(this.workflow, this.authorization)
    this.nativeRetention = collaborationPlanRetentionAllowed(this.workflow, this.authorization)
    this.nativeOpenPlanPublish = collaborationOpenPlanPublishAllowed(
      this.workflow,
      this.authorization,
    )
    this.nativeReview = collaborationReviewMode(this.workflow, this.authorization)
    this.nativeInputResult = collaborationInputResultAllowed(this.workflow, this.authorization)
    this.readOnlyStage = collaborationReadOnly(this.workflow, this.authorization)

    this.titleToolName = `mcp__${runtime.peerServerName}__publish_session_title`
    this.peerToolName = `mcp__${runtime.peerServerName}__request_peer_assistance`
    this.reviewToolName = `mcp__${runtime.peerServerName}__submit_review`
    this.inputResultToolName = `mcp__${runtime.peerServerName}__submit_input_result`
    this.retentionToolName = `mcp__${runtime.peerServerName}__retain_current_plan`
    this.publishPlanToolName = `mcp__${runtime.peerServerName}__publish_plan`

    this.answer = new ClaudeAnswerAssembler(input.runId, this.queryMemory)
    this.deferredResultMemory = this.queryMemory.reserve(0)

    this.peerAssistanceAllowed = !this.workflow && input.peerAssistanceAllowed !== false
    const resolvedPeerCandidate = runtime.resolvePeerTarget?.(input.sessionId)
    this.peerTargetAgentId =
      resolvedPeerCandidate && resolvedPeerCandidate !== 'claude' ? resolvedPeerCandidate : 'codex'
    this.peerAssistance = new PeerAssistanceTurn(this.peerTargetAgentId, this.peerAssistanceAllowed)

    this.speedInput = input.speed === 'fast' ? Promise.withResolvers<boolean>() : undefined
    this.recoveryInput = input.host?.recovery ? Promise.withResolvers<boolean>() : undefined
    this.skillInput = input.promptEnvelope.skillInvocation
      ? Promise.withResolvers<boolean>()
      : undefined
    this.permissionInput =
      this.nativePlanning ||
      input.permissionMode === 'auto' ||
      (this.workflow && input.permissionMode === 'native')
        ? new Promise<boolean>((resolve) => {
            this.confirmPermissionInput = resolve
          })
        : undefined

    this.kernel = new RunLifecycleKernel({
      agentId: 'claude',
      runId: input.runId,
      sessionId: input.sessionId,
      nativeGeneration: input.nativeGeneration ?? input.runId,
      callbacks: {
        onExecutorBound: (executorId) => input.host?.lifecycle?.recordExecutor?.(executorId),
        onDispatchPhase: (phase, nativeSessionId, executorId) =>
          input.host?.lifecycle?.recordDispatch?.(phase, nativeSessionId, executorId),
        onConfirmedUnsent: (boundary, identity) =>
          input.host?.recovery?.recordConfirmedUnsent(boundary, identity),
      },
    })

    this.planCapture = new ClaudePlanCaptureCoordinator({
      runtime,
      input,
      resolvedSessionId: this.resolvedSessionId,
      workflow: this.workflow,
      authorization: this.authorization,
      nativePlanning: this.nativePlanning,
      nativeRetention: this.nativeRetention,
      nativeOpenPlanPublish: this.nativeOpenPlanPublish,
      nativeReview: this.nativeReview,
      nativeInputResult: this.nativeInputResult,
      readOnlyStage: this.readOnlyStage,
      peerServerName: runtime.peerServerName,
      titleToolName: this.titleToolName,
      peerToolName: this.peerToolName,
      reviewToolName: this.reviewToolName,
      inputResultToolName: this.inputResultToolName,
      retentionToolName: this.retentionToolName,
      publishPlanToolName: this.publishPlanToolName,
      queryMemory: this.queryMemory,
      permissionWait: this.permissionWait,
      signal,
      observationSignal: this.observation.signal,
      isTerminalOrReleased: () => this.terminalKnown || this.transportReleased,
      getProjectionFailure: () => this.projectionFailure,
      setProjectionFailure: (failure) => {
        this.projectionFailure = failure
      },
      failProjection: (error, defer) => this.failProjection(error, defer),
      observeFiles: (evidence) => this.observeFiles(evidence),
    })

    runtime.latestExecutorId = this.nativeExecutorId
    runtime.nativeEvidence.delete(input.runId)
    runtime.admitEvidenceCache()
    runtime.activeControllers.add(this.abortController)

    const releasePermissionObservation = this.permissionWait.subscribe(() => {
      if (this.currentRequestMatched && !this.terminalKnown) {
        runtime.recordEvidence(input, this.resolvedSessionId, {
          kind: this.permissionWait.waiting ? 'waiting_user' : 'running',
          source: 'live_runtime',
        })
      }
    })
    this.observation.signal.addEventListener('abort', releasePermissionObservation, { once: true })
  }

  private readonly onAbort = (): void => {
    this.kernel.requestAbort()
    this.skillInput?.resolve(false)
    this.speedInput?.resolve(false)
    this.confirmPermissionInput?.(false)
    this.closeInput()
    const activeSession = this.session
    if (!activeSession || !this.deliveryAttempted || this.interruptRequested) return
    this.interruptRequested = true
    // Stop cancels the foreground/permission wait while this independent SDK
    // lifetime remains open to receive the real matching termination receipt.
    this.interruptTask = withDeadline(
      (async () => {
        // The pinned SDK runtime exposes the atomic queue sweep even though
        // its public declaration omits the optional argument. It shares the
        // SDK's exclusive frame writer with the long-lived input producer.
        const interrupt = Reflect.get(activeSession, 'interrupt') as (options: {
          cancelQueued: true
        }) => Promise<{ still_queued?: unknown; cancelled?: unknown } | undefined>
        const receipt = this.unfinishedSteering()
          ? await interrupt.call(activeSession, { cancelQueued: true })
          : await activeSession.interrupt()
        const cancelled = receipt?.cancelled
        const queued = receipt?.still_queued
        const cancel = Reflect.get(activeSession, 'cancelAsyncMessage')
        for (const entry of this.steeredInputs.values()) {
          if (!entry.yielded || entry.finished) continue
          let recalled = Array.isArray(cancelled) && cancelled.includes(entry.request.inputId)
          if (
            !recalled &&
            Array.isArray(queued) &&
            queued.includes(entry.request.inputId) &&
            typeof cancel === 'function'
          )
            // oxlint-disable-next-line no-await-in-loop -- Exact queued UUIDs share one native writer and one interrupt deadline.
            recalled = (await cancel.call(activeSession, entry.request.inputId)) === true
          if (recalled) {
            entry.cancelled = true
            entry.finished = true
            if (!entry.consumed) entry.request.recordDispatch('rejected')
          }
        }
        if (this.unfinishedSteering() && !Array.isArray(cancelled) && !Array.isArray(queued))
          this.reportUnknown()
      })(),
      NATIVE_INTERRUPT_TIMEOUT_MS,
      this.abortController.signal,
    ).catch(() => {
      if (!this.terminalKnown) {
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'no_evidence',
          reason:
            'Native interruption or queued-input cancellation was not confirmed; observation remains active.',
        })
        this.reportUnknown()
      }
    })
  }

  private reportUnknown(unconfirmed = true): void {
    this.rootObservationUnknown ||= unconfirmed
    if (this.unknownReported) return
    this.unknownReported = true
    this.kernel.reportNativeEffects('unknown', 'native_work_unconfirmed')
    nativeFileChangesSettled(this.input, 'unknown', 'native_work_unconfirmed')
  }

  private failProjection(error: unknown, deferForegroundFailure = false): void {
    if (!this.projectionFailure) {
      this.projectionFailure = classifyAgentError(error)
      this.reasoningBlocks.clear()
      this.reasoningBytes = 0
      this.tools.clear()
      this.answer.discardProjection()
      this.deferredResult = undefined
      this.deferredResultMemory.resize(0)
      this.input.host?.lifecycle?.recordOutputFailure?.(this.projectionFailure)
    }
    // Report once, then let the existing background reader retain control
    // receipts even when a later body/carrier cannot be retained.
    if (!this.foregroundReleased && !deferForegroundFailure) throw this.projectionFailure
  }

  private recordEnding(outcome: 'completed' | 'failed' | 'interrupted'): void {
    this.terminalKnown = true
    this.kernel.recordTerminal(outcome)
    this.sourceReader?.retire()
    this.terminalOutcome = outcome
    this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
      kind: 'ended',
      source: 'live_terminal',
      outcome,
      ...(this.planCapture.planPublication.unavailable ? { planUnavailable: true as const } : {}),
    })
  }

  private unfinishedSteering(): boolean {
    return [...this.steeredInputs.values()].some((entry) => entry.yielded && !entry.finished)
  }

  private backgroundWork(): 'working' | 'stoppable' | undefined {
    return this.terminalKnown && !this.actorExited && !this.readerSettled && this.nativeWork.active
      ? this.nativeWork.stoppable && this.inputOpen && this.nativeActor?.stdin?.writable !== false
        ? 'stoppable'
        : 'working'
      : undefined
  }

  private async stopBackgroundWork(stopSignal: AbortSignal): Promise<void> {
    const queryOwner = this.session
    if (!queryOwner || this.backgroundWork() !== 'stoppable')
      throw new Error('The original Claude background work is no longer available to stop.')
    const tasks = this.nativeWork.taskIds
    const requestSignal = AbortSignal.any([stopSignal, this.observation.signal])
    // This Query belongs only to this Run. Keep its writer open while observed
    // work remains and keep its reader alive through the terminal work receipts.
    if (this.nativeWork.hooksRunning) {
      requestSignal.throwIfAborted()
      await withDeadline(queryOwner.interrupt(), NATIVE_INTERRUPT_TIMEOUT_MS, requestSignal)
    }
    for (const taskId of tasks) {
      requestSignal.throwIfAborted()
      if (!this.nativeWork.hasTask(taskId)) continue
      // oxlint-disable-next-line no-await-in-loop -- One write per exact task, within the shared Stop deadline.
      await withDeadline(queryOwner.stopTask(taskId), NATIVE_INTERRUPT_TIMEOUT_MS, requestSignal)
    }
  }

  private closeInput(): void {
    this.inputOpen = false
    if (this.pendingInput && !this.pendingInput.yielded) {
      const entry = this.pendingInput
      this.pendingInput = undefined
      this.steeredInputs.delete(entry.request.inputId)
      try {
        entry.request.recordDispatch('rejected')
      } catch {
        this.reportUnknown()
      }
      entry.result.resolve({
        status: 'rejected',
        reason: 'The message was not delivered before the target execution ended.',
      })
    }
    this.wakeInput?.()
    this.wakeInput = undefined
  }

  private steerCurrent(request: AgentSteerInput, requestSignal: AbortSignal): boolean {
    return (
      this.inputOpen &&
      !this.runtime.disposed &&
      !this.signal.aborted &&
      !requestSignal.aborted &&
      !this.foregroundReleased &&
      !this.terminalKnown &&
      !this.transportReleased &&
      this.turnStarted &&
      request.runId === this.input.runId &&
      request.nativeSessionId === this.resolvedSessionId &&
      request.nativeTurnId === this.input.runId &&
      request.nativeGeneration === this.input.nativeGeneration &&
      request.bindingGeneration === (this.input.bindingGeneration ?? 1) &&
      request.promptEnvelope.sessionId === this.input.sessionId
    )
  }

  private async steer(
    request: AgentSteerInput,
    requestSignal: AbortSignal,
  ): Promise<AgentSteerResult> {
    if (!this.steerCurrent(request, requestSignal) || !this.session)
      return {
        status: 'rejected',
        reason: 'The target execution is no longer available for steering.',
      }
    if (
      !this.nativeQueueCancellationSupported ||
      typeof Reflect.get(this.session, 'cancelAsyncMessage') !== 'function'
    )
      return {
        status: 'unsupported',
        reason:
          'This Claude runtime cannot confirm safe cancellation of queued steering messages on Stop.',
      }
    if (
      this.pendingInput ||
      this.steeredInputs.size >= MAX_STEERING_INPUTS ||
      this.steeredInputs.has(request.inputId)
    )
      return {
        status: 'rejected',
        reason: 'This execution has no available steering input capacity.',
      }
    if (!isRequestUuid(request.inputId))
      return {
        status: 'rejected',
        reason: 'The steering message has an invalid native input identity.',
      }
    const duty = request.promptEnvelope.collaboration
    const scope = request.promptEnvelope.collaborationAuthorization
    if (
      Boolean(duty) !== Boolean(this.workflow) ||
      (duty &&
        (!scope ||
          duty.id !== this.workflow?.id ||
          duty.actor !== this.runtime.id ||
          scope.taskId !== duty.id ||
          scope.runId !== this.input.runId ||
          scope.actor !== this.runtime.id))
    )
      return {
        status: 'rejected',
        reason: 'The steering input does not belong to this execution duty.',
      }
    const controller = new AbortController()
    const entry: ClaudeSteeringInput = {
      request,
      signal: AbortSignal.any([this.signal, requestSignal, controller.signal]),
      result: Promise.withResolvers<AgentSteerResult>(),
      started: false,
      yielded: false,
      consumed: false,
      finished: false,
      cancelled: false,
    }
    this.pendingInput = entry
    this.planCapture.invalidateTerminalPlanIntent()
    this.steeredInputs.set(request.inputId, entry)
    this.wakeInput?.()
    this.wakeInput = undefined
    try {
      return await withDeadline(entry.result.promise, 10_000, requestSignal)
    } catch (error) {
      if (entry.yielded)
        throw new AgentExecutionError(
          'unknown_delivery',
          'Claude Code may have received this steering message. Do not resend it automatically.',
          false,
        )
      request.recordDispatch('rejected')
      if (requestSignal.aborted) throw error
      return {
        status: 'rejected',
        reason: 'The steering message was not delivered to Claude Code.',
      }
    } finally {
      controller.abort()
      if (!entry.yielded) {
        if (this.pendingInput === entry) this.pendingInput = undefined
        this.steeredInputs.delete(request.inputId)
        entry.reservation?.release()
      }
    }
  }

  private async *steeringMessages(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (!this.inputOpen) return
      const entry = this.pendingInput
      if (!entry || entry.started) {
        // Exactly one parked producer waiter, woken by admission or close.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          this.wakeInput = resolve
        })
        continue
      }
      entry.started = true
      const envelope = entry.request.promptEnvelope
      try {
        if (envelope.skillInvocation) {
          if (this.skillCatalogChangedDuringRun || !this.session)
            throw new Error('The native Skill catalog changed during this execution.')
          // oxlint-disable-next-line no-await-in-loop -- Read the same initialized Query's bounded command snapshot before this message can escape.
          const commands = await withDeadline(
            this.session.supportedCommands(),
            10_000,
            entry.signal,
          )
          const selected = envelope.skillInvocation.bindings.filter(
            (binding) => binding.agentId === 'claude',
          )
          const current = nativeSkillCatalog(
            'claude',
            this.input.cwd,
            this.runtime.executablePath,
            commands.filter((command) => selected.some((binding) => binding.name === command.name)),
          )
          if (selected.some((binding) => !current.some((candidate) => candidate.id === binding.id)))
            throw new Error('The steering Skill binding no longer matches the native catalog.')
        }
        yield* promptMessages(
          { ...this.input, runId: entry.request.inputId, promptEnvelope: envelope },
          this.resolvedSessionId,
          () => {
            if (!this.steerCurrent(entry.request, entry.signal)) return false
            entry.request.recordDispatch('possibly_sent')
            entry.yielded = true
            return true
          },
          undefined,
          entry.signal,
          undefined,
          this.queryMemory,
          (reservation) => {
            entry.reservation = reservation
          },
          {
            priority: 'next',
            prefix: envelope.collaboration
              ? collaborationInstructions(
                  envelope.collaboration,
                  envelope.collaborationAuthorization,
                )
              : this.hasSourceReader
                ? frozenSourceInstructions
                : undefined,
          },
        )
        entry.result.resolve(
          entry.yielded
            ? { status: 'submitted' }
            : {
                status: 'rejected',
                reason: 'The target execution ended before this input was sent.',
              },
        )
      } catch {
        if (entry.yielded)
          entry.result.reject(
            new AgentExecutionError(
              'unknown_delivery',
              'Steering input delivery is unconfirmed.',
              false,
            ),
          )
        else
          entry.result.resolve({
            status: 'rejected',
            reason: 'The steering input could not be prepared.',
          })
      }
      if (!entry.yielded) {
        try {
          entry.request.recordDispatch('rejected')
        } catch {
          // A retired foreground cannot turn one refused supplemental input
          // into an exception from the SDK producer and kill its native work.
          this.reportUnknown()
        }
        if (this.pendingInput === entry) this.pendingInput = undefined
      }
    }
  }

  private async observeFiles(evidence: NativeChanges): Promise<void> {
    if (this.recordings.size >= 8) {
      nativeEffectsUncertain(
        this.input,
        'Native file observation exceeded its bounded recording queue.',
        'recorded_files',
      )
      this.reportUnknown()
      return
    }
    const recording = this.recordingTail.then(() =>
      recordNativeChanges(this.input, evidence, this.observation.signal),
    )
    this.recordingTail = recording
    this.recordings.add(recording)
    try {
      await recording
    } finally {
      this.recordings.delete(recording)
    }
  }

  private async backgroundReport(message: SDKMessage): Promise<void> {
    const recordBackgroundReport = this.input.host?.effects?.recordBackgroundReport
    if (
      this.terminalOutcome !== 'completed' ||
      !this.observedReportableTask ||
      this.nativeMessageIdentityUnconfirmed ||
      this.foreignBackgroundInput ||
      !recordBackgroundReport
    )
      return
    // A native synthetic update has no client request echo. A different
    // explicit request on this Query disqualifies its later unstamped frames.
    const echoed: unknown = Reflect.get(message, 'user_message_uuid')
    const echoes: unknown = Reflect.get(message, 'user_message_uuids')
    if (echoed !== undefined || echoes !== undefined) {
      const ownsInput = (id: unknown): boolean =>
        typeof id === 'string' &&
        (id === this.input.runId || this.steeredInputs.get(id)?.finished === true)
      if (
        (echoed !== undefined && !ownsInput(echoed)) ||
        (echoes !== undefined &&
          (!Array.isArray(echoes) ||
            echoes.length > 64 ||
            echoes.some((id: unknown) => !ownsInput(id))))
      )
        this.foreignBackgroundInput = true
      return
    }
    if (
      message.type !== 'assistant' ||
      message.session_id !== this.resolvedSessionId ||
      message.parent_tool_use_id !== null ||
      message.resume_reason ||
      message.aborted ||
      message.error ||
      this.answer.hasNativeMessage(message.message.id) ||
      !isRequestUuid(message.uuid)
    )
      return
    const identity = nativeBackgroundReportIdentitySchema.parse({
      agentId: 'claude',
      runId: this.input.runId,
      nativeSessionId: this.resolvedSessionId,
      nativeTurnId: this.input.runId,
      bindingGeneration: this.input.bindingGeneration ?? 1,
      executorId: this.nativeExecutorId,
      frameId: message.uuid,
      nativeMessageId: message.message.id,
    })
    let reservation: NativeMemoryReservation | undefined
    try {
      let text: string
      try {
        let chars = 0,
          bytes = 0,
          blocks = 0,
          hasText = false
        // Measurement borrows the SDK's blocks. No joined text or duplicate
        // block array exists until this same Query admits the full workspace.
        for (const block of message.message.content) {
          if (block.type !== 'text') continue
          if (typeof block.text !== 'string')
            throw new AgentExecutionError(
              'protocol_error',
              'The native background update has an invalid text block.',
              false,
            )
          chars += block.text.length
          bytes += Buffer.byteLength(block.text)
          blocks++
          hasText ||= /\S/u.test(block.text)
        }
        if (!hasText) return
        reservation = this.queryMemory.reserve(4096 + chars * 10 + bytes * 2 + blocks * 16)
        const parts: string[] = []
        for (const block of message.message.content)
          if (block.type === 'text') parts.push(block.text)
        text = parts.join('')
      } catch (error) {
        const recordUnavailable = this.input.host?.effects?.recordBackgroundReportUnavailable
        if (!recordUnavailable) throw error
        recordUnavailable(identity)
        recordDiagnostic({
          operation: 'native_check',
          phase: 'failed',
          level: 'warn',
          scope: 'run',
          sessionId: this.input.sessionId,
          runId: this.input.runId,
          agentId: this.runtime.id,
          runtimeBoundary: 'archive',
          code: classifyAgentError(error).kind,
        })
        return
      }
      // The consumer borrows this admitted text through its complete seal;
      // persistence failures retain their existing observation error path.
      await recordBackgroundReport({ ...identity, text })
    } finally {
      reservation?.release()
    }
  }

  private *projectMessage(message: SDKMessage): Generator<NormalizedAgentEvent> {
    const providerSessionId = Reflect.get(message, 'session_id')
    if (
      typeof providerSessionId === 'string' &&
      providerSessionId &&
      providerSessionId !== this.resolvedSessionId
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Claude Code returned an unexpected Session ID.',
        false,
      )
    }
    const previousWork = this.backgroundWork()
    this.nativeWork.observe(message)
    if (providerSessionId === this.resolvedSessionId && message.type === 'system') {
      if (message.subtype === 'background_tasks_changed' && message.tasks.length <= 64)
        this.observedReportableTask ||= message.tasks.some(
          (task) => task.ambient !== true && this.nativeWork.hasTask(task.task_id),
        )
      else if (
        message.subtype === 'task_started' &&
        message.ambient !== true &&
        message.is_backgrounded !== false &&
        this.nativeWork.hasTask(message.task_id)
      )
        this.observedReportableTask = true
    }
    if (!this.observedBackgroundActivity && this.nativeWork.pending) {
      this.observedBackgroundActivity = true
      nativeEffectsUncertain(
        this.input,
        'Native hooks or background work may modify files beyond the available operation evidence.',
      )
    }
    if (this.terminalKnown) {
      if (!this.nativeWork.active) this.closeInput()
      if (previousWork !== this.backgroundWork())
        this.input.host?.effects?.backgroundWorkChanged?.()
      if (
        this.observedReportableTask &&
        providerSessionId === this.resolvedSessionId &&
        message.type === 'system' &&
        message.subtype === 'task_notification' &&
        !message.ambient &&
        !message.skip_transcript &&
        message.task_id &&
        message.task_id.length <= 1024 &&
        ['completed', 'failed', 'stopped'].includes(message.status)
      )
        yield {
          agentId: 'claude',
          type: 'tool.completed',
          turnId: this.input.runId,
          toolCallId: `background-task:${message.task_id}`,
          toolName: 'Background task',
          title: `Background task ${message.status}`,
          outcome: message.status === 'completed' ? 'completed' : 'failed',
        }
    }
    if (message.type === 'system' && message.subtype === 'init')
      this.nativeQueueCancellationSupported =
        Array.isArray(message.capabilities) &&
        message.capabilities.length <= 256 &&
        message.capabilities.includes('interrupt_cancel_queued_v1')
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.skillCatalogChangedDuringRun = true
      this.runtime.skillCatalogChanged?.()
    }
    if (this.terminalKnown && ['assistant', 'stream_event', 'result'].includes(message.type)) return
    const echoed = Reflect.get(message, 'user_message_uuid')
    const echoes = Reflect.get(message, 'user_message_uuids')
    const explicit = typeof echoed === 'string' || Array.isArray(echoes)
    const inputIds = new Set(
      [
        typeof echoed === 'string' ? echoed : undefined,
        ...(Array.isArray(echoes) && echoes.length <= 64 ? echoes : []),
      ].filter((value): value is string => typeof value === 'string'),
    )
    for (const entry of this.steeredInputs.values()) {
      if (!entry.yielded || !inputIds.has(entry.request.inputId)) continue
      if (!entry.consumed && !entry.cancelled) {
        entry.request.recordConsumption(entry.request.inputId)
        entry.consumed = true
        if (this.pendingInput === entry) this.pendingInput = undefined
        this.wakeInput?.()
        this.wakeInput = undefined
      }
      if (message.type === 'result') entry.finished = true
    }
    const matched =
      inputIds.has(this.input.runId) ||
      [...this.steeredInputs.values()].some(
        (entry) => entry.yielded && inputIds.has(entry.request.inputId),
      )
    if (explicit && !this.terminalKnown) {
      if (this.currentRequestMatched && !matched)
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'no_evidence',
          reason:
            'The live native stream changed request identity without a matching terminal receipt.',
        })
      this.currentRequestMatched = matched
    }
    if (
      message.type === 'system' &&
      message.subtype === 'session_state_changed' &&
      this.currentRequestMatched &&
      !this.terminalKnown
    ) {
      if (message.state === 'requires_action')
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'waiting_user',
          source: 'live_runtime',
        })
      else if (message.state === 'running')
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'running',
          source: 'live_runtime',
        })
    }
    if (
      ['assistant', 'stream_event', 'result'].includes(message.type) &&
      !this.currentRequestMatched
    )
      return
    if (message.type === 'system' || message.type === 'result') {
      const state = Reflect.get(message, 'fast_mode_state')
      const reason = Reflect.get(message, 'fast_mode_disabled_reason')
      if (state === 'on' || state === 'off' || state === 'cooldown') {
        const detail =
          state === 'cooldown'
            ? 'Fast is cooling down after a native rate limit. Continuing at standard speed.'
            : state === 'off'
              ? (this.speedDetail ?? fastModeDisabledDetail(reason))
              : undefined
        const identity = JSON.stringify([state, detail])
        if (identity !== this.lastSpeedState) {
          this.lastSpeedState = identity
          yield {
            agentId: 'claude',
            type: 'run.speed.resolved',
            requested: this.input.speed ?? 'native',
            speed: state === 'on' ? 'fast' : 'standard',
            ...(detail ? { detail } : {}),
          }
        }
      }
    }
    // SDK initialization alone does not prove this prompt was accepted.
    const acceptedTurn =
      (message.type === 'assistant' && !message.error) ||
      message.type === 'stream_event' ||
      message.type === 'result'
    if (!this.turnStarted && this.sessionStarted && acceptedTurn) {
      this.turnStarted = true
      this.kernel.recordDispatch('accepted', this.resolvedSessionId, this.nativeExecutorId)
      this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
        kind: 'running',
        source: 'live_runtime',
      })
      yield { agentId: 'claude', type: 'turn.started', turnId: this.input.runId }
    }
    while (this.peerRequests.length > 0) {
      const proposal = this.peerRequests.shift()
      if (proposal) yield proposal
    }

    const nativeMessageId =
      message.type === 'assistant' && message.parent_tool_use_id === null
        ? message.message.id
        : message.type === 'stream_event' &&
            !message.parent_tool_use_id &&
            message.event.type === 'message_start'
          ? message.event.message.id
          : undefined
    if (nativeMessageId !== undefined) {
      try {
        this.answer.observeNativeMessage(nativeMessageId)
      } catch (error) {
        this.nativeMessageIdentityUnconfirmed = true
        this.failProjection(error)
      }
    }

    if (!this.projectionFailure) {
      try {
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          const model = message.message.model
          if (model && model !== this.resolvedModel) {
            this.resolvedModel = model
            yield { agentId: 'claude', type: 'run.model.resolved', model }
          }
        }

        if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          const update = this.answer.stream(message.event)
          if (update.completed !== undefined)
            yield {
              agentId: 'claude',
              type: 'text.completed',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: update.completed,
            }
          if (update.delta) {
            this.nativeResultAssistantText = true
            yield {
              agentId: 'claude',
              type: 'text.delta',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: update.delta,
            }
          }
          const event = message.event
          if (event.type === 'message_start') {
            this.assistantMessageId = event.message.id
            const model = event.message.model
            if (typeof model === 'string' && model && model !== this.resolvedModel) {
              this.resolvedModel = model
              yield { agentId: 'claude', type: 'run.model.resolved', model }
            }
          }
          if (this.showReasoningSummaries && event.type === 'content_block_start') {
            const block = event.content_block
            if (block.type === 'thinking') {
              if (!this.reasoningBlocks.has(event.index) && this.reasoningBlocks.size >= 64)
                throw new AgentExecutionError(
                  'response_too_large',
                  'Claude reasoning activity exceeded the bounded item owner.',
                  false,
                )
              const activityId = `${this.assistantMessageId}:reasoning:${event.index}`
              const text = block.thinking ?? ''
              const bytes = Buffer.byteLength(text, 'utf8')
              this.reasoningBytes += bytes - (this.reasoningBlocks.get(event.index)?.bytes ?? 0)
              if (this.reasoningBytes > 2 * 1024 * 1024)
                throw new AgentExecutionError(
                  'response_too_large',
                  'Claude reasoning activity exceeded its 2 MiB owner budget.',
                  false,
                )
              const emitted = Boolean(text.trim())
              this.reasoningBlocks.set(event.index, { activityId, text, bytes, emitted })
              if (emitted) {
                yield {
                  agentId: 'claude',
                  type: 'reasoning.summary.delta',
                  turnId: this.input.runId,
                  activityId,
                  text,
                }
              }
            }
          }
          if (
            this.showReasoningSummaries &&
            event.type === 'content_block_delta' &&
            event.delta.type === 'thinking_delta'
          ) {
            const current = this.reasoningBlocks.get(event.index)
            if (!current && this.reasoningBlocks.size >= 64)
              throw new AgentExecutionError(
                'response_too_large',
                'Claude reasoning activity exceeded the bounded item owner.',
                false,
              )
            const activityId =
              current?.activityId ?? `${this.assistantMessageId}:reasoning:${event.index}`
            const text = event.delta.thinking
            const deltaBytes = Buffer.byteLength(text, 'utf8')
            this.reasoningBytes += deltaBytes
            if (this.reasoningBytes > 2 * 1024 * 1024)
              throw new AgentExecutionError(
                'response_too_large',
                'Claude reasoning activity exceeded its 2 MiB owner budget.',
                false,
              )
            const reasoning = {
              activityId,
              text: `${current?.text ?? ''}${text}`,
              bytes: (current?.bytes ?? 0) + deltaBytes,
              emitted: current?.emitted ?? false,
            }
            this.reasoningBlocks.set(event.index, reasoning)
            if (!reasoning.emitted && text.trim()) {
              reasoning.emitted = true
              yield {
                agentId: 'claude',
                type: 'reasoning.summary.delta',
                turnId: this.input.runId,
                activityId,
                text: reasoning.text,
              }
            } else if (reasoning.emitted && text) {
              yield {
                agentId: 'claude',
                type: 'reasoning.summary.delta',
                turnId: this.input.runId,
                activityId,
                text,
              }
            }
          }
          if (this.showReasoningSummaries && event.type === 'content_block_stop') {
            const reasoning = this.reasoningBlocks.get(event.index)
            if (reasoning) {
              this.reasoningBlocks.delete(event.index)
              this.reasoningBytes -= reasoning.bytes
              if (reasoning.text.trim()) {
                yield {
                  agentId: 'claude',
                  type: 'reasoning.summary.completed',
                  turnId: this.input.runId,
                  activityId: reasoning.activityId,
                  text: reasoning.text,
                }
              }
            }
          }
        }

        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_use') continue
            if (this.nativePlanning && ['Write', 'Edit'].includes(block.name)) {
              if (
                !this.planCapture.nativePlan ||
                (block.input &&
                  typeof block.input === 'object' &&
                  Reflect.get(block.input, 'file_path') ===
                    this.planCapture.nativePlan.binding.path)
              )
                this.planCapture.blockRetention()
            }
            if (this.nativePlanning && block.name === 'AskUserQuestion')
              this.planCapture.invalidateRetentionForQuestion()
            if (block.name === this.retentionToolName && this.nativeRetention) {
              const call = this.planCapture.retentionCall(block.id)
              if (call.observed) call.invalid = true
              call.observed = true
              if (!collaborationPlanRetentionInputSchema.safeParse(block.input).success)
                call.invalid = true
              if (call.invalid && this.planCapture.planPublication.retained?.nativeId === block.id)
                this.planCapture.captureUnavailable()
              continue
            }
            if (
              block.name === this.titleToolName &&
              this.input.promptEnvelope.requestSessionTitle
            ) {
              if (
                !this.titleRecorded &&
                this.titleCalls.size === 0 &&
                block.id.length > 0 &&
                block.id.length <= 256
              ) {
                const title = sessionTitleInputSchema.safeParse(block.input)
                if (title.success) this.titleCalls.set(block.id, title.data.title)
              }
              continue
            }
            if (block.name === this.reviewToolName && this.nativeReview) {
              const verdict = readWorkflowReview(block.input)
              if (
                !block.id ||
                block.id.length > 1024 ||
                (!this.planCapture.workflowCalls.has(block.id) &&
                  this.planCapture.workflowCalls.size >= 64)
              ) {
                this.planCapture.workflowProjectionFailed = true
                throw new AgentExecutionError(
                  'response_too_large',
                  'Native review submission activity exceeded its bounded owner.',
                  false,
                )
              }
              if (verdict) {
                const prior = this.planCapture.workflowCalls.get(block.id)
                const merged =
                  prior?.kind === 'input'
                    ? { verdict: 'incomplete' as const }
                    : mergeWorkflowReview(prior?.value, verdict)
                if (merged.verdict === 'incomplete') this.planCapture.captureReview(merged)
                this.planCapture.rememberWorkflowCall(block.id, { kind: 'review', value: merged })
              }
              continue
            }
            if (block.name === this.inputResultToolName && this.nativeInputResult) {
              if (
                !block.id ||
                block.id.length > 1024 ||
                (!this.planCapture.workflowCalls.has(block.id) &&
                  this.planCapture.workflowCalls.size >= 64)
              ) {
                this.planCapture.workflowProjectionFailed = true
                throw new AgentExecutionError(
                  'response_too_large',
                  'Native input-result activity exceeded its bounded owner.',
                  false,
                )
              }
              const parsed = collaborationInputResultSchema.safeParse(block.input)
              if (parsed.success) {
                const prior = this.planCapture.workflowCalls.get(block.id)
                const outcome =
                  prior && prior.kind !== 'input'
                    ? { outcome: 'incomplete' as const }
                    : mergeWorkflowInput(prior?.value, parsed.data)
                if (outcome.outcome === 'incomplete') this.planCapture.captureInputResult(outcome)
                this.planCapture.rememberWorkflowCall(block.id, { kind: 'input', value: outcome })
              }
              continue
            }
            if (this.nativeOpenPlanPublish && block.name === this.publishPlanToolName) {
              if (
                !block.id ||
                block.id.length > 1024 ||
                (!this.planCapture.planCalls.has(block.id) && this.planCapture.planCalls.size >= 64)
              ) {
                this.planCapture.workflowProjectionFailed = true
                throw new AgentExecutionError(
                  'response_too_large',
                  'Native plan submission activity exceeded its bounded owner.',
                  false,
                )
              }
              this.planCapture.planCalls.add(block.id)
              continue
            }
            if (this.nativePlanning && block.name === 'ExitPlanMode') {
              if (
                !block.id ||
                block.id.length > 1024 ||
                (!this.planCapture.planCalls.has(block.id) && this.planCapture.planCalls.size >= 64)
              ) {
                this.planCapture.workflowProjectionFailed = true
                throw new AgentExecutionError(
                  'response_too_large',
                  'Native plan submission activity exceeded its bounded owner.',
                  false,
                )
              }
              this.planCapture.planCalls.add(block.id)
              continue
            }
            if (block.name === this.peerToolName) {
              if (!this.peerToolCallIds.has(block.id) && this.peerToolCallIds.size >= 64)
                throw new AgentExecutionError(
                  'response_too_large',
                  'Claude peer activity exceeded the bounded item owner.',
                  false,
                )
              this.peerToolCallIds.add(block.id)
              continue
            }
            const activity = describeTool(block.name, block.input, this.input.cwd)
            if (block.name === 'Skill' && block.input && typeof block.input === 'object') {
              const name = Reflect.get(block.input, 'skill')
              const selected = this.input.promptEnvelope.skillInvocation?.bindings.find(
                (entry) => entry.agentId === 'claude' && entry.name === name,
              )
              if (
                selected &&
                (Reflect.get(block.input, 'args') ?? '') !==
                  this.input.promptEnvelope.skillInvocation!.arguments
              )
                activity.title += ' · Arguments differ from request'
            }
            if (!this.tools.has(block.id) && this.tools.size >= 64)
              throw new AgentExecutionError(
                'response_too_large',
                'Claude outstanding tool activity exceeded the bounded item owner.',
                false,
              )
            this.tools.set(block.id, { toolName: block.name, ...activity })
            yield {
              agentId: 'claude',
              type: 'tool.started',
              turnId: this.input.runId,
              toolCallId: block.id,
              toolName: block.name,
              title: activity.title,
              ...(activity.detail ? { detail: activity.detail } : {}),
            }
          }
        }

        if (
          message.type === 'user' &&
          !message.parent_tool_use_id &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_result') continue
            if (this.terminalKnown && !this.tools.has(block.tool_use_id)) continue
            const retention = this.planCapture.retentionCalls.get(block.tool_use_id)
            if (retention) {
              if (block.is_error || !this.currentRequestMatched || this.terminalKnown)
                retention.invalid = true
              else if (retention.succeeded) retention.invalid = true
              else retention.succeeded = true
              if (
                retention.invalid &&
                this.planCapture.planPublication.retained?.nativeId === block.tool_use_id
              )
                this.planCapture.captureUnavailable()
              continue
            }
            const title = this.titleCalls.get(block.tool_use_id)
            if (title) {
              if (!block.is_error && !this.titleRecorded) {
                this.titleRecorded = true
                yield {
                  agentId: 'claude',
                  type: 'session.title.updated',
                  title,
                  origin: 'turn_result',
                }
              }
              this.titleCalls.delete(block.tool_use_id)
              continue
            }
            const submission = this.planCapture.workflowCalls.get(block.tool_use_id)
            if (submission) {
              this.planCapture.workflowCalls.delete(block.tool_use_id)
              if (!block.is_error) {
                if (submission.kind === 'review') this.planCapture.captureReview(submission.value)
                else if (this.currentRequestMatched && !this.terminalKnown)
                  this.planCapture.captureInputResult(submission.value)
              }
              continue
            }
            if (this.planCapture.planCalls.delete(block.tool_use_id)) {
              if (
                this.nativeOpenPlanPublish &&
                !block.is_error &&
                this.currentRequestMatched &&
                !this.terminalKnown &&
                this.planCapture.openPlanPublish.completedMarkdown &&
                !this.planCapture.planPublication.plan
              ) {
                this.planCapture.capturePlan({
                  nativeId: block.tool_use_id,
                  text: this.planCapture.openPlanPublish.completedMarkdown,
                })
              }
              continue
            }
            if (this.peerToolCallIds.delete(block.tool_use_id)) continue
            const activity = this.tools.get(block.tool_use_id) ?? {
              toolName: 'tool',
              title: 'Used a tool',
            }
            this.tools.delete(block.tool_use_id)
            yield {
              agentId: 'claude',
              type: 'tool.completed',
              turnId: this.input.runId,
              toolCallId: block.tool_use_id,
              toolName: activity.toolName,
              title:
                activity.toolName === 'Skill'
                  ? `${activity.title} · ${block.is_error ? 'Invocation failed' : 'Loaded'}`
                  : activity.title,
              ...(activity.detail ? { detail: activity.detail } : {}),
              outcome: block.is_error ? 'failed' : 'completed',
            }
          }
        }

        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          const completed = completedText(message)
          if (completed) this.nativeResultAssistantText = true
          const update = this.answer.frame(
            message.message.id,
            message.uuid,
            completed,
            message.message.content.filter((block) => block.type === 'text').length,
          )
          if (update.completed !== undefined)
            yield {
              agentId: 'claude',
              type: 'text.completed',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: update.completed,
            }
          if (update.delta)
            yield {
              agentId: 'claude',
              type: 'text.delta',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: update.delta,
            }
        }
      } catch (error) {
        this.failProjection(error)
        return
      }
    }

    if (message.type === 'result') {
      if (!matched) {
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'no_evidence',
          reason: 'A native result did not identify this exact user request.',
        })
        return
      }
      this.nativeResultNumber += 1
      const outcome =
        message.terminal_reason === 'aborted_streaming' ||
        message.terminal_reason === 'aborted_tools'
          ? 'interrupted'
          : message.subtype === 'success' && !message.is_error
            ? 'completed'
            : 'failed'
      let terminalProjectionFailure: { error: unknown } | undefined
      if (!this.projectionFailure) {
        try {
          const completed = this.answer.finish(outcome !== 'completed')
          if (completed !== undefined)
            yield {
              agentId: 'claude',
              type: 'text.completed',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: completed,
            }
        } catch (error) {
          try {
            this.failProjection(error, true)
          } catch (publicationError) {
            terminalProjectionFailure = { error: publicationError }
            try {
              recordDiagnostic({
                operation: 'send',
                scope: 'run',
                phase: 'failed',
                level: 'error',
                runtimeBoundary: 'projection',
                failureSource: 'classified_error',
                code: classifyAgentError(publicationError).kind,
                sessionId: this.input.sessionId,
                runId: this.input.runId,
                agentId: 'claude',
              })
            } catch {
              // Optional diagnostics cannot interrupt the native control drain.
            }
          }
        }
      }
      if (this.unfinishedSteering()) {
        this.deferredEnding = outcome
        if (this.projectionFailure) {
          if (!this.foregroundReleased)
            throw terminalProjectionFailure
              ? terminalProjectionFailure.error
              : this.projectionFailure
          return
        }
        try {
          this.deferredResultMemory.resize(4096 + freezeNativeJsonFrame(message) * 6)
          this.deferredResult = message
          if (
            !this.nativeResultAssistantText &&
            message.subtype === 'success' &&
            !message.is_error &&
            message.result
          ) {
            const text = this.answer.complete(
              `${this.input.runId}:result:${this.nativeResultNumber}`,
              message.result,
            )
            if (text !== undefined)
              yield {
                agentId: 'claude',
                type: 'text.completed',
                turnId: this.input.runId,
                outputId: this.answer.outputId,
                text,
              }
            this.nativeResultAssistantText = true
          }
          this.deferredResultHasText = this.nativeResultAssistantText
          this.nativeResultAssistantText = false
        } catch (error) {
          this.failProjection(error)
          return
        }
        return
      }
      this.deferredResult = undefined
      this.deferredEnding = undefined
      this.deferredResultMemory.resize(0)
      if (!this.nativeWork.active) this.closeInput()
      this.recordEnding(outcome)
      if (this.projectionFailure) {
        if (!this.foregroundReleased)
          throw terminalProjectionFailure ? terminalProjectionFailure.error : this.projectionFailure
        return
      }
      if (message.subtype !== 'success' || message.is_error) {
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          ...(this.answer.text ||
          (outcome === 'completed' &&
            (this.planCapture.planPublication.plan || this.planCapture.reviewResult))
            ? {
                output: {
                  outputId: this.answer.outputId,
                  text: this.answer.text,
                  completeness: 'partial' as const,
                },
              }
            : {}),
        })
        const detail =
          'errors' in message && message.errors.length > 0
            ? message.errors.join('\n')
            : 'Claude Code could not complete the Run.'
        if (!this.foregroundReleased) throw classifyAgentError(new Error(detail))
        yield { agentId: 'claude', type: 'turn.completed', turnId: this.input.runId, outcome }
        return
      }
      this.planCapture.nativePlan?.finish()
      if (this.planCapture.nativePlan?.unavailable) this.planCapture.captureUnavailable()
      let finalText: string | undefined
      try {
        if (!this.nativeResultAssistantText && message.result) {
          const resultText = this.answer.complete(
            `${this.input.runId}:result:${this.nativeResultNumber}`,
            message.result,
          )
          if (resultText !== undefined)
            yield {
              agentId: 'claude',
              type: 'text.completed',
              turnId: this.input.runId,
              outputId: this.answer.outputId,
              text: resultText,
            }
        }
        finalText =
          this.answer.finalize() ??
          (this.planCapture.planPublication.plan && !this.answer.text ? '' : undefined)
      } catch (error) {
        this.failProjection(error)
        return
      }
      this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
        kind: 'ended',
        source: 'live_terminal',
        outcome,
        ...(this.planCapture.planPublication.unavailable ? { planUnavailable: true as const } : {}),
        ...(this.answer.text ||
        (outcome === 'completed' &&
          (this.planCapture.planPublication.plan || this.planCapture.reviewResult))
          ? {
              output: {
                outputId: this.answer.outputId,
                text: this.answer.text,
                completeness:
                  outcome === 'completed' ? ('complete' as const) : ('partial' as const),
                ...(outcome === 'completed' && this.planCapture.planPublication.plan
                  ? { plan: this.planCapture.planPublication.plan }
                  : {}),
                ...(this.planCapture.planPublication.unavailable
                  ? { planUnavailable: true as const }
                  : {}),
                ...(outcome === 'completed' && this.planCapture.reviewResult
                  ? { reviewResult: this.planCapture.reviewResult }
                  : {}),
                ...(outcome === 'completed' && this.planCapture.inputResult
                  ? { inputResult: this.planCapture.inputResult }
                  : {}),
              },
            }
          : {}),
      })
      if (finalText !== undefined)
        yield {
          agentId: 'claude',
          type: 'text.completed',
          turnId: this.input.runId,
          outputId: this.answer.outputId,
          text: finalText,
        }
      if (outcome === 'completed') {
        if (this.planCapture.planPublication.plan)
          yield {
            agentId: 'claude',
            type: 'collaboration.plan',
            turnId: this.input.runId,
            ...this.planCapture.planPublication.plan,
          }
        if (this.planCapture.reviewResult)
          yield {
            agentId: 'claude',
            type: 'collaboration.review',
            turnId: this.input.runId,
            ...this.planCapture.reviewResult,
          }
      }
      yield {
        agentId: 'claude',
        type: 'turn.completed',
        turnId: this.input.runId,
        outcome,
      }
      return
    }
  }

  private releaseExitedQuery(): Promise<void> {
    if (this.releaseExitedTask) return this.releaseExitedTask
    if (
      this.transportReleased ||
      !this.readerSettled ||
      (this.actorObserved ? !this.actorExited : Boolean(this.session) && !this.readerEof)
    )
      return Promise.resolve()
    // Register before the first await: close/drain callers join the same physical proof and cleanup.
    this.releaseExitedTask = Promise.resolve().then(async () => {
      await this.interruptTask
      const drained = await Promise.allSettled([this.recordingTail, ...this.recordings])
      let recordingFailed = drained.some((result) => result.status === 'rejected')
      while (this.recordings.size) {
        // oxlint-disable-next-line no-await-in-loop -- Drain the existing bounded recording owner before final proof.
        const batch = await Promise.allSettled(this.recordings)
        recordingFailed ||= batch.some((result) => result.status === 'rejected')
      }
      const settledRoot = (): boolean =>
        this.actorObserved &&
        this.actorExited &&
        this.currentRequestMatched &&
        !recordingFailed &&
        !this.rootObservationUnknown &&
        this.terminalOutcome === 'completed' &&
        this.readerEof &&
        !this.signal.aborted &&
        !this.interruptRequested &&
        !this.projectionFailure &&
        !this.unfinishedSteering() &&
        !this.nativeWork.pending &&
        this.tools.size === 0 &&
        this.planCapture.workflowCalls.size === 0 &&
        this.peerToolCallIds.size === 0 &&
        this.planCapture.planCalls.size === 0 &&
        !this.permissionWait.waiting
      const terminalPlanProjectionFailed = await this.planCapture.verifyTerminalPlanOnExit(
        settledRoot,
        recordingFailed,
      )
      this.transportReleased = true
      this.sourceReader?.retire()
      this.answer.dispose()
      this.planCapture.dispose()
      this.inputReservation?.release()
      this.inputReservation = undefined
      this.deferredResult = undefined
      this.deferredResultMemory.release()
      for (const entry of this.steeredInputs.values()) entry.reservation?.release()
      this.signal.removeEventListener('abort', this.onAbort)
      if (this.session) this.runtime.activeSessions.delete(this.session)
      this.runtime.activeControllers.delete(this.abortController)
      const workConfirmed =
        (this.terminalKnown || this.permissionRefused || this.nativeNotStarted) &&
        !terminalPlanProjectionFailed &&
        !this.planCapture.workflowProjectionFailed &&
        !this.rootObservationUnknown &&
        (!this.session ||
          this.readerEof ||
          (this.actorObserved && this.actorExited && this.interruptedReaderClosed)) &&
        !this.unfinishedSteering() &&
        !this.nativeWork.pending &&
        !this.permissionWait.waiting
      // Actor exit retires transport capacity; it does not prove unobserved
      // descendants or a missing native ending. Keep the recovery/work fence.
      if (
        workConfirmed ||
        (this.readerEof &&
          !this.unfinishedSteering() &&
          !this.nativeWork.pending &&
          !this.permissionWait.waiting) ||
        (!this.session && !this.actorObserved)
      ) {
        this.runtime.backgroundRuns.delete(this.input.runId)
        this.observation.abort()
      }
      const settleReason = this.inputWithheldError
        ? 'workflow_input_withheld'
        : this.permissionRefused || this.nativeNotStarted
          ? 'native_turn_not_started'
          : 'native_observation_released'
      this.kernel.reportNativeEffects(workConfirmed ? 'settled' : 'unknown', settleReason)
      await this.kernel.settle()
      nativeFileChangesSettled(this.input, workConfirmed ? 'settled' : 'unknown', settleReason)
      return undefined
    })
    this.runtime.backgroundDrains.add(this.releaseExitedTask)
    void this.releaseExitedTask.finally(() =>
      this.runtime.backgroundDrains.delete(this.releaseExitedTask!),
    )
    return this.releaseExitedTask
  }

  private async *createRootPromptStream(): AsyncIterable<SDKUserMessage> {
    let rootYielded = false
    try {
      for await (const message of promptMessages(
        this.input,
        this.resolvedSessionId,
        () => {
          try {
            if (
              this.input.host?.recovery?.expected &&
              this.input.host.recovery.canDispatch?.() !== true
            )
              throw new NativeInputWithheldError(
                'The replacement authority changed before native input delivery.',
              )
            this.kernel.recordDispatch(
              'possibly_sent',
              this.resolvedSessionId,
              this.nativeExecutorId,
            )
          } catch (error) {
            if (!(error instanceof NativeInputWithheldError)) throw error
            this.inputWithheldError = error
            this.nativeNotStarted = true
            this.kernel.recordDispatch('rejected', this.resolvedSessionId, this.nativeExecutorId)
            return false
          }
          this.deliveryAttempted = true
          if (this.signal.aborted) this.onAbort()
          return true
        },
        this.permissionInput,
        this.signal,
        this.speedInput || this.recoveryInput
          ? Promise.all([
              this.speedInput?.promise ?? true,
              this.skillInput?.promise ?? true,
              this.recoveryInput?.promise ?? true,
            ]).then((gates) => gates.every(Boolean))
          : this.skillInput?.promise,
        this.queryMemory,
        (reservation) => {
          this.inputReservation = reservation
        },
      )) {
        rootYielded = true
        yield message
      }
      if (this.deliveryAttempted) yield* this.steeringMessages()
    } finally {
      if (!rootYielded)
        this.kernel.recordConfirmedUnsent(
          { kind: 'claude_root_not_yielded' },
          {
            executorId: this.nativeExecutorId,
            nativeSessionId: this.resolvedSessionId,
          },
        )
    }
  }

  async *run(): AsyncIterable<NormalizedAgentEvent> {
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    const peerServer = createClaudeTurnMcpServer({
      serverName: this.runtime.peerServerName,
      input: this.input,
      workflow: this.workflow,
      authorization: this.authorization,
      hasSourceReader: this.hasSourceReader,
      sourceReader: this.sourceReader,
      sourceGrant: this.sourceGrant,
      nativeInputResult: this.nativeInputResult,
      nativeReview: this.nativeReview,
      nativeOpenPlanPublish: this.nativeOpenPlanPublish,
      nativeRetention: this.nativeRetention,
      peerAssistanceAllowed: this.peerAssistanceAllowed,
      peerTargetAgentId: this.peerTargetAgentId,
      peerAssistance: this.peerAssistance,
      peerRequests: this.peerRequests,
      openPlanPublish: this.planCapture.openPlanPublish,
      permissionWait: this.permissionWait,
      isRetired: () =>
        this.runtime.disposed ||
        this.transportReleased ||
        this.terminalKnown ||
        this.signal.aborted,
      canRetainPlan: () =>
        !this.runtime.disposed &&
        !this.transportReleased &&
        !this.terminalKnown &&
        !this.signal.aborted &&
        !this.planCapture.retentionBlocked &&
        !this.planCapture.planPublication.plan &&
        !this.planCapture.inputResult &&
        !this.permissionWait.waiting,
    })

    try {
      this.planCapture.initializeMetadataBudget()
      this.kernel.bindExecutor(this.nativeExecutorId)
      if (!this.permissionInput && !this.speedInput) {
        this.sessionStarted = true
        yield {
          agentId: 'claude',
          type: 'session.started',
          nativeSessionId: this.resolvedSessionId,
        }
      }
      this.session = this.runtime.dependencies.query({
        prompt: this.createRootPromptStream(),
        options: {
          abortController: this.abortController,
          cwd: this.input.cwd,
          pathToClaudeCodeExecutable: this.runtime.executablePath,
          spawnClaudeCodeProcess: (options) => {
            const child = (this.runtime.dependencies.spawn ?? spawn)(
              options.command,
              options.args,
              {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                shell: false,
              },
            )
            this.nativeActor = child
            drainStderr(child)
            this.actorObserved = true
            child.once('close', () => {
              this.actorExited = true
              void this.releaseExitedQuery()
            })
            return child
          },
          canUseTool: permissionHandler(
            {
              cwd: this.input.cwd,
              permissionMode: this.input.permissionMode,
              requestPermission: this.input.host?.interactions?.requestPermission,
              requestUserInput: this.input.host?.interactions?.requestUserInput,
            },
            this.signal,
            this.permissionWait,
            this.nativePlanning
              ? (id, toolInput) => this.planCapture.handlePlanSubmissionPermission(id, toolInput)
              : undefined,
          ),
          ...(this.input.promptEnvelope.requestSessionTitle || this.workflow || this.hasSourceReader
            ? {
                allowedTools: [
                  ...(this.input.promptEnvelope.requestSessionTitle ? [this.titleToolName] : []),
                  ...(this.nativeReview ? [this.reviewToolName] : []),
                  ...(this.nativeInputResult ? [this.inputResultToolName] : []),
                  ...(this.nativeRetention ? [this.retentionToolName] : []),
                  ...(this.nativeOpenPlanPublish ? [this.publishPlanToolName] : []),
                  ...(this.hasSourceReader
                    ? [`mcp__${this.runtime.peerServerName}__read_collaboration_source`]
                    : []),
                ],
              }
            : {}),
          ...permissionOptions(this.input.permissionMode),
          ...(this.nativePlanning
            ? {
                permissionMode: 'plan' as const,
                planModeInstructions: collaborationPlanningInstructions,
              }
            : {}),
          ...(this.readOnlyStage && !this.nativePlanning
            ? {
                tools: [
                  'Read',
                  'Grep',
                  'Glob',
                  'LS',
                  'WebSearch',
                  'WebFetch',
                  'TodoWrite',
                  'AskUserQuestion',
                ],
                strictMcpConfig: true,
              }
            : {}),
          onElicitation: elicitationHandler(
            { requestUserInput: this.input.host?.interactions?.requestUserInput },
            this.signal,
            this.permissionWait,
          ),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(this.workflow
              ? {
                  append: collaborationInstructions(this.workflow, this.authorization),
                }
              : this.hasSourceReader
                ? { append: frozenSourceInstructions }
                : {}),
          },
          hooks: this.planCapture.buildSdkHooks(),
          ...(this.peerAssistanceAllowed ||
          this.workflow ||
          this.input.promptEnvelope.requestSessionTitle ||
          this.hasSourceReader
            ? { mcpServers: { [this.runtime.peerServerName]: peerServer } }
            : {}),
          persistSession: true,
          includePartialMessages: true,
          includeHookEvents: true,
          settingSources: ['user', 'project', 'local'],
          ...(this.input.nativeSessionId ? { resume: this.input.nativeSessionId } : {}),
          ...(!this.input.nativeSessionId ? { sessionId: this.resolvedSessionId } : {}),
          ...(this.input.model ? { model: this.input.model } : {}),
          ...runSettingsOptions(this.input),
          ...(this.showReasoningSummaries
            ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
            : {}),
        },
      })
      this.runtime.activeSessions.add(this.session)

      this.runtime.backgroundRuns.set(this.input.runId, {
        observation: this.observation,
        sourceGrant: this.sourceGrant,
        sourceReader: this.sourceReader,
        recordings: this.recordings,
        executorId: this.nativeExecutorId,
        steer: (req, sig) => this.steer(req, sig),
        work: () => this.backgroundWork(),
        stopWork: (sig) => this.stopBackgroundWork(sig),
      })

      this.iterator = this.session[Symbol.asyncIterator]()
      if (this.speedInput) {
        this.speedDetail = await configureFastMode(
          this.session,
          () => this.nativeActor,
          this.input,
          this.signal,
          this.queryMemory,
          this.startupDeadline,
        )
        yield {
          agentId: 'claude',
          type: 'run.speed.resolved',
          requested: 'fast',
          ...(this.speedDetail ? { speed: 'standard' as const, detail: this.speedDetail } : {}),
        }
      }
      if (this.input.promptEnvelope.skillInvocation) {
        const selected = this.input.promptEnvelope.skillInvocation.bindings.filter(
          (entry) => entry.agentId === 'claude',
        )
        const commands = await withDeadline(
          this.session.supportedCommands(),
          Math.max(1, Math.min(10_000, this.startupDeadline - Date.now())),
          this.signal,
        )
        const current = nativeSkillCatalog(
          'claude',
          this.input.cwd,
          this.runtime.executablePath,
          commands.filter((entry) => selected.some((item) => item.name === entry.name)),
        )
        if (selected.some((entry) => !current.some((candidate) => candidate.id === entry.id)))
          throw new AgentExecutionError(
            'protocol_error',
            'The native Skill catalog changed before this task was sent.',
            false,
          )
        this.skillInput?.resolve(true)
      }
      if (this.permissionInput) {
        if (this.nativePlanning)
          await confirmNativeExecutionMode(
            this.session,
            this.signal,
            Math.max(1, this.startupDeadline - Date.now()),
            true,
          )
        else if (this.input.permissionMode === 'auto')
          await confirmAutoMode(
            this.session,
            this.signal,
            Math.max(1, this.startupDeadline - Date.now()),
          )
        else
          await confirmNativeExecutionMode(
            this.session,
            this.signal,
            Math.max(1, this.startupDeadline - Date.now()),
          )
        this.sessionStarted = true
        yield {
          agentId: 'claude',
          type: 'session.started',
          nativeSessionId: this.resolvedSessionId,
        }
        this.confirmPermissionInput?.(true)
      }
      if (this.recoveryInput) {
        let settings: RunEffectiveExecutionSettings | undefined
        const recoveryController = new AbortController()
        try {
          const activeSession = this.session
          settings = await withDeadline(
            (async () => {
              const initialization = await activeSession.initializationResult()
              const actual = await readRunSettings(
                this.nativeActor,
                AbortSignal.any([this.signal, recoveryController.signal]),
                this.queryMemory,
              )
              const permission = Reflect.get(initialization, 'current_permission_mode')
              const speed =
                actual.fastMode === true
                  ? 'fast'
                  : actual.fastMode === false ||
                      (this.input.speed === 'standard' && actual.fastModeDisabled)
                    ? 'standard'
                    : undefined
              if (
                !speed ||
                !actual.configurationSha256 ||
                typeof permission !== 'string' ||
                ![
                  'default',
                  'auto',
                  'plan',
                  'bypassPermissions',
                  'acceptEdits',
                  'dontAsk',
                ].includes(permission)
              )
                return undefined
              return {
                version: 1,
                provider: 'claude',
                model: actual.model,
                effort: { known: true, value: actual.effort },
                speed,
                permissionMode: this.input.permissionMode ?? 'native',
                configurationSha256: createHash('sha256')
                  .update(
                    JSON.stringify({ settings: actual.configurationSha256, permission, speed }),
                  )
                  .digest('hex'),
                provenance: 'claude_applied_settings',
              }
            })(),
            Math.max(1, Math.min(FAST_MODE_CHECK_TIMEOUT_MS, this.startupDeadline - Date.now())),
            this.signal,
          )
          if (settings)
            this.input.host?.recovery?.recordEffectiveSettings(settings, {
              executorId: this.nativeExecutorId,
              nativeSessionId: this.resolvedSessionId,
            })
          if (
            this.input.host?.recovery?.expected &&
            (!settings ||
              JSON.stringify(settings) !==
                JSON.stringify(this.input.host.recovery.expected.settings))
          )
            throw new NativeInputWithheldError(
              'The native execution settings could not be confirmed unchanged. The replacement input was withheld.',
            )
          this.recoveryInput.resolve(true)
        } catch (error) {
          if (this.input.host?.recovery?.expected || this.signal.aborted) throw error
          this.recoveryInput.resolve(true)
        } finally {
          recoveryController.abort()
        }
      }
      if (this.speedInput) {
        if (!this.sessionStarted) {
          this.sessionStarted = true
          yield {
            agentId: 'claude',
            type: 'session.started',
            nativeSessionId: this.resolvedSessionId,
          }
        }
        this.signal.throwIfAborted()
        this.speedInput.resolve(true)
      }
      this.kernel.markReadyToDispatch(this.resolvedSessionId)

      while (true) {
        // oxlint-disable-next-line no-await-in-loop
        const next = await nextWithCancellation(
          this.signal,
          (this.pendingRead = this.iterator.next()),
        )
        this.pendingRead = undefined
        if (next.done) {
          // oxlint-disable-next-line no-await-in-loop -- Native EOF must include the one bounded Stop receipt before settling queued inputs.
          await this.interruptTask
          if (this.deferredResult && !this.unfinishedSteering()) {
            this.nativeResultAssistantText = this.deferredResultHasText
            yield* this.projectMessage(this.deferredResult)
          } else if (this.deferredEnding && !this.unfinishedSteering()) {
            this.recordEnding(this.deferredEnding)
          }
          this.iteratorDone = true
          if (this.terminalKnown) return
          break
        }
        yield* this.projectMessage(next.value)
        if (this.terminalKnown) return
      }
      throw new AgentExecutionError(
        this.turnStarted ? 'unknown_delivery' : 'agent_process_crash',
        this.turnStarted
          ? 'Claude Code started the Turn, but Pact could not confirm its final state.'
          : 'Claude Code exited before completing the Run.',
        !this.turnStarted,
      )
    } catch (error) {
      if (this.inputWithheldError) throw this.inputWithheldError
      const failure = classifyAgentError(error)
      if (error instanceof PermissionModeRejectedError && !this.deliveryAttempted) {
        this.permissionRefused = true
        this.kernel.recordDispatch('rejected', this.resolvedSessionId, this.nativeExecutorId)
      }
      if (
        !this.turnStarted &&
        this.input.nativeSessionId &&
        error instanceof Error &&
        /^No conversation found with session ID:/iu.test(error.message)
      ) {
        this.nativeNotStarted = true
        this.kernel.recordDispatch('rejected', this.resolvedSessionId, this.nativeExecutorId)
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'missing',
          source: 'native_error',
        })
        throw new AgentExecutionError(
          'context_resume_failed',
          'Claude Code explicitly rejected the missing Native Session before this Turn started.',
          false,
        )
      }
      if (!this.terminalKnown && !this.permissionRefused && !this.nativeNotStarted)
        this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
          kind: 'no_evidence',
          reason: 'The native stream ended without a matching terminal receipt.',
        })
      if (
        this.deliveryAttempted &&
        !this.terminalKnown &&
        ['transient_transport', 'agent_process_crash', 'protocol_error'].includes(failure.kind)
      ) {
        throw new AgentExecutionError(
          'unknown_delivery',
          'Claude Code may have received the Turn, but Pact could not confirm its final state.',
          false,
        )
      }
      throw failure
    } finally {
      this.skillInput?.resolve(false)
      this.speedInput?.resolve(false)
      this.recoveryInput?.resolve(false)
      this.confirmPermissionInput?.(false)
      if (!this.terminalKnown || !this.nativeWork.active || this.iteratorDone) this.closeInput()
      this.foregroundReleased = true
      const emptyRejectedOwner =
        this.nativeNotStarted &&
        !this.inputWithheldError &&
        !this.observedBackgroundActivity &&
        !this.recordings.size &&
        !this.permissionWait.waiting
      if (this.session && this.iterator && !this.iteratorDone && !emptyRejectedOwner) {
        const ownedIterator = this.iterator
        const drain = (async () => {
          let effectsKnown = false
          let readingNative = false
          let rootOutputTransferred = false
          try {
            while (true) {
              if (this.terminalKnown && !rootOutputTransferred) {
                // oxlint-disable-next-line no-await-in-loop -- One-time barrier precedes the first post-terminal SDK read.
                await this.input.host?.lifecycle?.waitForRootOutput?.()
                this.answer.discardProjection()
                rootOutputTransferred = true
              }
              readingNative = true
              const next = this.pendingRead ?? ownedIterator.next()
              this.pendingRead = undefined
              // oxlint-disable-next-line no-await-in-loop -- The native stream remains owned until actual EOF.
              const result = await next
              readingNative = false
              if (result.done) {
                // oxlint-disable-next-line no-await-in-loop -- Native EOF must include the one bounded Stop receipt before settling queued inputs.
                await this.interruptTask
                if (this.deferredResult && !this.unfinishedSteering()) {
                  this.nativeResultAssistantText = this.deferredResultHasText
                  for (const event of this.projectMessage(this.deferredResult))
                    this.input.host?.effects?.recordArchivedEvent?.(event)
                } else if (this.deferredEnding && !this.unfinishedSteering()) {
                  this.recordEnding(this.deferredEnding)
                }
                if (!this.terminalKnown && !this.permissionRefused && !this.nativeNotStarted)
                  this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
                    kind: 'no_evidence',
                    reason: 'The native stream closed without a matching Turn termination receipt.',
                  })
                effectsKnown = true
                break
              }
              const hadEnded = this.terminalKnown
              for (const event of this.projectMessage(result.value))
                this.input.host?.effects?.recordArchivedEvent?.(event)
              if (hadEnded) {
                // oxlint-disable-next-line no-await-in-loop -- One background body is durably sealed before reading the next SDK frame.
                await this.backgroundReport(result.value)
              }
            }
          } catch {
            nativeEffectsUncertain(
              this.input,
              'Native background completion could not be confirmed.',
            )
            if (!this.terminalKnown && !this.permissionRefused && !this.nativeNotStarted)
              this.runtime.recordEvidence(this.input, this.resolvedSessionId, {
                kind: 'no_evidence',
                reason: 'The native stream ended without a matching terminal receipt.',
              })
            // L1: Exit code 1 after confirmed interrupt + terminal result + stdin close is normal.
            this.interruptedReaderClosed =
              readingNative &&
              this.terminalOutcome === 'interrupted' &&
              this.interruptRequested &&
              !this.unfinishedSteering() &&
              !this.nativeWork.pending &&
              !this.permissionWait.waiting
            this.reportUnknown(!this.interruptedReaderClosed)
          } finally {
            this.closeInput()
            await Promise.allSettled(this.recordings)
            this.signal.removeEventListener('abort', this.onAbort)
            this.readerSettled = true
            this.readerEof = effectsKnown
            await this.releaseExitedQuery()
          }
        })()
        this.runtime.backgroundDrains.add(drain)
        void drain.finally(() => this.runtime.backgroundDrains.delete(drain))
      } else {
        this.signal.removeEventListener('abort', this.onAbort)
        await Promise.allSettled(this.recordings)
        if (!this.session || !this.iterator || this.iteratorDone || emptyRejectedOwner) {
          this.readerSettled = true
          this.readerEof = this.iteratorDone || emptyRejectedOwner
          await this.releaseExitedQuery()
        }
        if (!this.transportReleased) this.reportUnknown(false)
      }
    }
  }
}
