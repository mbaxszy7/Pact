import { isDeepStrictEqual } from 'node:util'

import type { AgentRunInput } from '@pact/agent-runtime'
import type { NormalizedAgentEvent, SessionPermissionMode } from '@pact/contracts'

import {
  awaitWithinStopBudget,
  readRunStopAbortReason,
  remainingStopBudgetMs,
  RunLifecycleKernel,
  validateSourceGrant,
} from '@pact/agent-runtime'
import { collaborationAskMode, collaborationPlanMode } from '@pact/contracts'

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
import { collaborationReadOnly } from '../collaboration-prompt'
import {
  AgyRoundEffectsTracker,
  nativeEffectsUncertain,
  recordNativeChanges,
} from '../native-file-changes'
import { NativePermissionWait } from '../native-permission-wait'
import { bindAgySkillSelections } from '../native-skill-catalog'
import { TurnResourceScope } from '../turn-resource-scope'
import {
  formatAgyRpcErrorMessage,
  parseAgyPromptTerminalReply,
  validateAgyFrame,
  type ParsedAgyPromptTerminalReply,
} from './frame-validator'
import { AgyRunMcpServer } from './peer-mcp-server'
import {
  AgyTurnInteractionRouter,
  buildAgyTurnSystemAppend,
  parseAcpSessionDescriptor,
  prepareAgyTurnPromptBlocks,
} from './permission-and-elicitation'
import {
  AgyTurnBackgroundObserver,
  AgyTurnCancelController,
  AgyTurnEffectsReporter,
} from './turn-background-observer'
import { AgyTurnCollaborationTracker } from './turn-collaboration-tracker'
import {
  AgyPendingEventQueue,
  AgyPrePromptReplayTracker,
  AgyTurnFrameAdmitter,
} from './turn-frame-admitter'
import {
  AGY_CONTROL_DRAIN_HANDOFF_MS,
  AGY_MAX_TOOL_STATE_BYTES,
  AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
  AGY_SESSION_METADATA_UPDATES,
  asString,
  awaitPhysicalCompletionBounded,
  classifyAgyCloseFailureDiagnostic,
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
      readerIdentity: input.host?.workflow?.sourceReader?.identity,
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
    const collaboration = new AgyTurnCollaborationTracker({
      input,
      planModeStage,
      authorization,
    })
    let unresolvedPreBindOutput = false
    let foregroundDeltaDropped = false

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
    let rootWithheldByGuard = false
    let inputWithheldError: NativeInputWithheldError | undefined
    let retainTimedOutRecordings = false
    let promptEnteredTransport = false
    let rootConfirmedNotSent = false
    const isConfirmedZeroBytesSent = (): boolean =>
      (!promptEnteredTransport && !rootFirstByteWritten) || rootConfirmedNotSent
    let promptRpcCompleted = false
    let promptReplyReceived = false
    let userCancelRequested = false
    let rootTerminal = false
    let rootReleasing = false
    let foregroundReleased = false
    let controlDrainActive = false
    let onControlSettled: (() => void) | undefined
    let enableEventDiscardMode: (() => void) | undefined

    const foregroundScope = new TurnResourceScope()
    const retainedScope = new TurnResourceScope()
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
    let clearCancelGraceTimer: (() => void) | undefined
    const clearCancelGrace = (): void => {
      clearCancelGraceTimer?.()
      clearCancelGraceTimer = undefined
    }
    let promptSettled = false
    const promptRpcAbort = new AbortController()
    const runDisposeAbort = new AbortController()
    const runSignal = AbortSignal.any([signal, runDisposeAbort.signal])
    const observation = new AbortController()
    const runFinalizer = Promise.withResolvers<void>()
    let stopStreamPump: (() => void) | undefined
    let drainBufferedPostCutoff: (() => void) | undefined
    let stopPrePromptDrain: ((drainRemaining?: boolean) => Promise<void>) | undefined
    let handoffOrderedStreamToBackground: ((onRetainedCleanup: () => void) => void) | undefined
    let cleanupForegroundResources:
      | ((opts?: { readonly keepForeignExecReservation?: boolean | undefined }) => void)
      | undefined
    let compactTerminalCommitted = false
    let finalTerminalEvidenceCommitted = false
    let compactTerminalCommitError: unknown
    let liveTerminalOutcome: 'completed' | 'interrupted' | 'failed' | undefined
    let clearControlDrainTimer: (() => void) | undefined
    const clearControlDrain = (): void => {
      clearControlDrainTimer?.()
      clearControlDrainTimer = undefined
    }
    let releaseReplayMarker: (() => void) | undefined
    let settlePromptFromResponseRef: ((res: object) => void) | undefined
    let promptRpcResolvedResponseRef: object | undefined
    const ensureCompactEndedCommitted = (): boolean => {
      if (compactTerminalCommitted || finalTerminalEvidenceCommitted) return true
      if (!liveTerminalOutcome || !activeRun || !resolvedSessionId) return false
      rootTerminal = true
      activeRun.rootTerminal = true
      this.kernel.recordTerminal(liveTerminalOutcome)
      try {
        this.runtime.recordEvidence(
          input,
          resolvedSessionId,
          activeExecutorId,
          { kind: 'ended', source: 'live_terminal', outcome: liveTerminalOutcome },
          activeRun.nativeTurnId,
        )
        compactTerminalCommitted = true
        return true
      } catch (err) {
        compactTerminalCommitError ??= err
        return false
      }
    }

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
        !promptRpcCompleted &&
        !promptReplyReceived &&
        !rootTerminal &&
        !rootReleasing &&
        !foregroundReleased &&
        !signal.aborted,
      isSourceCurrent: () =>
        !this.runtime.disposed &&
        rootFirstByteWritten &&
        !promptRpcCompleted &&
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
      isPlanRetentionCurrent: () => collaboration.isPlanRetentionCurrent(),
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

    let promptPhysicalSettled = false
    const cancelController = new AgyTurnCancelController({
      runtime: this.runtime,
      input,
      getActiveRun: () => activeRun,
      getResolvedSessionId: () => resolvedSessionId,
      getActiveExecutorId: () => activeExecutorId,
      getConnection: () => lease?.connection,
      isPromptPhysicalSettled: () => promptPhysicalSettled,
      hasServerPromptReply: () => promptRpcResolvedResponseRef !== undefined,
      isCancelEligible: () =>
        rootFirstByteWritten && !promptSettled && !promptRpcCompleted && !rootTerminal,
      isTurnClosedForCancel: () => rootTerminal || promptSettled || promptRpcCompleted,
    })
    const requestTurnCancel = cancelController.requestCancel.bind(cancelController)

    let replayingHistory = false
    let promptCutoffSeq: number | undefined
    let pushPendingEventForRouter: ((event: NormalizedAgentEvent) => void) | undefined
    const interactionRouter = new AgyTurnInteractionRouter({
      runtime: this.runtime,
      kernel: this.kernel,
      input,
      mcpServer,
      tools,
      approvedBrainPlanCalls: collaboration.approvedBrainPlanCalls,
      onBrainPlanWriteApproved: (toolCallId) => {
        collaboration.onBrainPlanWriteApproved(toolCallId)
      },
      readOnlyStage,
      planModeStage,
      askOnlyStage,
      readOnlyNonInteractive:
        readOnlyStage && !planModeStage && (authorization?.stage ?? workflow?.stage) !== 'reply',
      permissionMode: effectivePermissionMode,
      signal,
      getActiveRun: () => activeRun,
      getResolvedSessionId: () => resolvedSessionId,
      getActiveExecutorId: () => activeExecutorId,
      isRootFirstByteWritten: () => rootFirstByteWritten,
      isRootTerminal: () => rootTerminal,
      isReplayingHistory: () => replayingHistory,
      getPromptCutoffSeq: () => promptCutoffSeq,
      onRequestTurnCancel: () =>
        requestTurnCancel({
          onError: () => {
            if (!rootTerminal) {
              reportUnknown(
                'Native Antigravity cancellation could not be confirmed; observation remains active.',
              )
            }
          },
        }),
      pushPendingEvent: (ev) => pushPendingEventForRouter?.(ev),
    })
    const interactionControllers = interactionRouter.interactionControllers
    const cancelDisownedInteractions = (): void => interactionRouter.cancelDisowned()
    const abortOutstandingInteractions = (): void => interactionRouter.abortAll()
    const recordings = new Set<Promise<void>>()
    let recordingTail = Promise.resolve()
    const effectsReporter = new AgyTurnEffectsReporter({
      runtime: this.runtime,
      input,
      getActiveRun: () => activeRun,
    })
    const detachActiveRun = (): void => effectsReporter.detachActiveRun()
    const reportSettled = (): void => effectsReporter.reportSettled()
    const reportUnknown = (reason: string): void => effectsReporter.reportUnknown(reason)

    // Register base retained teardown steps in bottom-to-top LIFO order so pool lease release
    // ALWAYS runs last (after background unsubscribe, reservations, source reader, and observation).
    retainedScope.add('pool_lease', () => {
      lease?.release()
      lease = undefined
    })
    retainedScope.add('detach_active_run', () => detachActiveRun())
    retainedScope.add('observation_abort', () => observation.abort())
    retainedScope.add('retire_source_reader', () => retireSourceReader())

    const recordHostBeforeRootStart = (): void => {
      if (resolvedSessionId && input.host?.recovery) {
        input.host?.recovery.recordConfirmedUnsent(
          { kind: 'host_before_root_start' },
          { executorId: activeExecutorId, nativeSessionId: resolvedSessionId },
        )
      }
    }

    let zeroInputClosePromise: Promise<void> | undefined
    const closeZeroInputSessionOnce = (maxTimeoutMs?: number): Promise<void> => {
      if (zeroInputClosePromise) return zeroInputClosePromise
      if (
        !createdFreshSession ||
        !resolvedSessionId ||
        !isConfirmedZeroBytesSent() ||
        !lease?.connection.isOpen
      ) {
        return Promise.resolve()
      }
      const timeoutMs = maxTimeoutMs !== undefined ? Math.min(1_500, maxTimeoutMs) : 1_500
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
    const completeFinalTeardown = (options: {
      emergency: boolean
      unknownReason?: string | undefined
    }): Promise<void> => {
      if (options.emergency) {
        emergencyCleanedUp = true
      }
      if (finalizationPromise) {
        return finalizationPromise
      }
      controlDrainActive = false
      onControlSettled = undefined
      finalizationPromise = (async () => {
        let cleanupFailure: unknown = compactTerminalCommitError
        const runIsolated = (fn: () => void): void => {
          try {
            fn()
          } catch (err) {
            cleanupFailure ??= err
          }
        }
        try {
          clearCancelGrace()
          clearControlDrain()
          runIsolated(() => releaseReplayMarker?.())
          // B-F5: If transport already received a verified root reply while consumer paused at soft cap,
          // unblock backpressure and settle that reply BEFORE stopping the stream pump and closing stream.
          if (promptRpcResolvedResponseRef !== undefined && !promptSettled) {
            runIsolated(() => enableEventDiscardMode?.())
            runIsolated(() => settlePromptFromResponseRef?.(promptRpcResolvedResponseRef!))
          }
          promptRpcAbort.abort()
          await stopPrePromptDrain?.(false).catch(() => undefined)
          runIsolated(() => stopStreamPump?.())
          if (!options.emergency && !emergencyCleanedUp) {
            runIsolated(() => drainBufferedPostCutoff?.())
          }
          runIsolated(() => ensureCompactEndedCommitted())
          foregroundReleased = true
          controlDrainActive = false
          const isEmergency = options.emergency || emergencyCleanedUp
          if (isEmergency || !rootTerminal) {
            rootTerminal = true
          }
          if (activeRun) {
            activeRun.foregroundReleased = true
            if (activeRun.controlDrainActive) {
              activeRun.controlDrainActive = false
              runIsolated(() => input.host?.effects?.backgroundWorkChanged?.())
            }
            if (isEmergency || rootTerminal) {
              activeRun.rootTerminal = true
            }
            runIsolated(() => this.runtime.projector.notifyRootExecutionWaiters(activeRun!))
          }
          const fullyDrainedBeforeEmergency =
            isEmergency &&
            Boolean(activeRun) &&
            finalTerminalEvidenceCommitted &&
            !effectsReporter.isUnknownReported &&
            !activeRun!.backgroundUnconfirmed &&
            activeRun!.activeBackgroundTasks.size === 0 &&
            recordings.size === 0 &&
            !(backgroundObserver?.hasPendingWork() ?? false)
          runIsolated(() =>
            this.runtime.invalidateNonTerminalEvidence(input.runId, resolvedSessionId),
          )
          // Root Turn has ended: unconditionally revoke and close MCP server before releasing its reservation.
          runIsolated(() => mcpServer.revokeRun())
          await mcpServer.close().catch((err) => {
            cleanupFailure ??= err
          })
          const retainBackground =
            !isEmergency &&
            !this.runtime.disposed &&
            Boolean(
              activeRun &&
              (activeRun.activeBackgroundTasks.size > 0 ||
                (retainTimedOutRecordings && recordings.size > 0)) &&
              rootTerminal &&
              (compactTerminalCommitted ||
                finalTerminalEvidenceCommitted ||
                retainTimedOutRecordings),
            )
          runIsolated(() =>
            cleanupForegroundResources?.({ keepForeignExecReservation: retainBackground }),
          )
          cleanupFailure ??= foregroundScope.dispose()
          if (!retainBackground) {
            runIsolated(() => {
              foreignExecIdsMemoryReservation?.release()
              foreignExecIdsMemoryReservation = undefined
            })
          }
          abortOutstandingInteractions()
          tools.clear()
          collaboration.clearApprovedCalls()
          if (!isEmergency) {
            const stopAbort = readRunStopAbortReason(signal)
            await closeZeroInputSessionOnce(
              stopAbort?.reason === 'user_stop' ? remainingStopBudgetMs(stopAbort) : undefined,
            ).catch(() => undefined)
          }
          runIsolated(() => {
            serverRequestOwner?.dispose()
            serverRequestOwner = undefined
          })
          if (retainBackground && activeRun) {
            const retainedRun = activeRun
            const cleanupRetained = (): void => {
              retainedScope.dispose()
            }
            try {
              handoffOrderedStreamToBackground?.(cleanupRetained)
            } catch {
              detachActiveRun()
              reportUnknown(
                'Antigravity background observer handoff exceeded connection listener capacity.',
              )
              sessionStream?.close()
              sessionStream = undefined
              cleanupRetained()
            }
            sessionStream?.close()
            sessionStream = undefined
            if (
              !retainedScope.isDisposed &&
              (retainedRun.observation.signal.aborted ||
                this.runtime.disposed ||
                emergencyCleanedUp)
            ) {
              backgroundObserver?.closeRetainedBackground({
                reason: 'disposed',
                emergency: emergencyCleanedUp || this.runtime.disposed,
              })
              cleanupRetained()
            } else if (!retainedScope.isDisposed) {
              retainedRun.observation.signal.addEventListener(
                'abort',
                () => {
                  backgroundObserver?.closeRetainedBackground({
                    reason: 'disposed',
                    emergency: true,
                  })
                  cleanupRetained()
                },
                { once: true },
              )
            }
          } else {
            runIsolated(() => {
              sessionStream?.close()
              sessionStream = undefined
            })
            if (!isEmergency) {
              await recordingTail.catch(() => undefined)
              await backgroundObserver?.awaitTail().catch(() => undefined)
            }
            // Carbon B-3: Detach activeRun BEFORE reporting terminal effects so RunExecutor sees
            // `hasActiveBackgroundWork(runId) === false` and deterministically reclaims nativeObservations.
            runIsolated(() => detachActiveRun())
            runIsolated(() =>
              effectsReporter.settleNonRetainedTerminalEffects({
                isEmergency,
                fullyDrainedBeforeEmergency,
                rootTerminal,
                confirmedZeroBytesSent: isConfirmedZeroBytesSent(),
                terminalEvidenceCommitted:
                  compactTerminalCommitted || finalTerminalEvidenceCommitted,
                unknownReason: options.unknownReason,
              }),
            )
            runIsolated(() =>
              backgroundObserver?.closeRetainedBackground({
                reason: 'disposed',
                emergency: isEmergency,
              }),
            )
            cleanupFailure ??= retainedScope.dispose()
          }
          await this.kernel
            .settle({ retainBackgroundObservation: retainBackground })
            .catch((err) => {
              cleanupFailure ??= err
            })
        } finally {
          this.runtime.ownedRunHandles.delete(runHandle)
          runFinalizer.resolve()
        }
        if (cleanupFailure !== undefined) {
          throw cleanupFailure
        }
      })()
      return finalizationPromise
    }

    const finalizeRun = (options: { emergency: boolean }): Promise<void> => {
      if (options.emergency) {
        return completeFinalTeardown({ emergency: true })
      }
      if (finalizationPromise) {
        return finalizationPromise
      }
      // S2-F7: Body consumer exited early (e.g., archive persistence failure invoking generator.return())
      // while root control RPC is still live. Keep bounded control-only drain running until the root
      // reply/EOF settles so we never hand a `rootTerminal=false` Run to TurnBackgroundObserver.
      if (
        !emergencyCleanedUp &&
        !rootTerminal &&
        !promptSettled &&
        rootFirstByteWritten &&
        !isConfirmedZeroBytesSent() &&
        !this.runtime.disposed &&
        activeRun &&
        lease?.connection.isOpen
      ) {
        controlDrainActive = true
        foregroundReleased = true
        activeRun.foregroundReleased = true
        activeRun.controlDrainActive = true
        mcpServer.notifyRootStateChanged()
        input.host?.effects?.backgroundWorkChanged?.()
        enableEventDiscardMode?.()
        abortOutstandingInteractions()
        clearControlDrainTimer = foregroundScope.setTimeout(
          'control_drain_timer',
          () => {
            clearControlDrainTimer = undefined
            if (!controlDrainActive) return
            void completeFinalTeardown({
              emergency: true,
              unknownReason: 'Antigravity control-drain handoff exceeded its bounded timeout.',
            }).catch(() => undefined)
          },
          AGY_CONTROL_DRAIN_HANDOFF_MS,
          true,
        )
        onControlSettled = () => {
          if (!controlDrainActive) return
          void completeFinalTeardown({
            emergency: emergencyCleanedUp || this.runtime.disposed,
          }).catch(() => undefined)
        }
        observation.signal.addEventListener(
          'abort',
          () => {
            if (controlDrainActive) {
              void completeFinalTeardown({ emergency: true }).catch(() => undefined)
            }
          },
          { once: true },
        )
        return Promise.resolve()
      }
      return completeFinalTeardown({ emergency: false })
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
        clearCancelGrace()
        void requestTurnCancel()
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

      const { systemAppend, systemPromptMeta } = buildAgyTurnSystemAppend({
        workflow,
        authorization,
        readOnlyStage,
        planModeStage,
        mcpServer,
      })

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
      pendingEventsMemoryReservation = foregroundScope.trackReservation(
        'pending_events_mem',
        connection.reserveWorkingMemory(0),
        () => {
          pendingEventsMemoryReservation = undefined
        },
      )
      const eventQueue = new AgyPendingEventQueue(() => pendingEventsMemoryReservation)
      enableEventDiscardMode = () => {
        eventQueue.enableDiscardMode()
      }
      const notifyEventLoop = (): void => eventQueue.notifyEventLoop()
      const isPendingEventsAtSoftCap = (): boolean => eventQueue.isAtSoftCap()
      const pushPendingEvent = (ev: NormalizedAgentEvent): void => eventQueue.push(ev)
      pushPendingEventForRouter = pushPendingEvent
      const shiftPendingEvent = (): NormalizedAgentEvent | undefined => eventQueue.shift()
      const clearPendingEvents = (): void => eventQueue.clear()

      const permissionWait = new NativePermissionWait()
      const releaseWaitObserver = permissionWait.subscribe(() => {
        if (
          activeRun?.turnAccepted &&
          !rootTerminal &&
          !compactTerminalCommitted &&
          !finalTerminalEvidenceCommitted &&
          !promptRpcCompleted &&
          resolvedSessionId
        ) {
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

      const handleOrderedServerRequest = (
        req: Extract<AgyIngress, { kind: 'server_request' }>,
      ): boolean =>
        interactionRouter.handleOrderedServerRequest({
          connection,
          canonicalCwd: lease!.canonicalCwd,
          permissionWait,
          req,
        })

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

      const prePromptReplay = new AgyPrePromptReplayTracker()
      const observePrePromptNotification = (note: object, targetSessionId: string): void => {
        prePromptReplay.observeNotification(note, targetSessionId, (n, sid) => {
          this.runtime.bootstrap.observeSessionTitleFromNotification(n, sid, input)
        })
      }

      let descriptor: AcpSessionDescriptor
      if (input.nativeSessionId) {
        resolvedSessionId = input.nativeSessionId
        replayingHistory = true
        const replaySid = input.nativeSessionId
        this.runtime.replayingSessions.set(
          replaySid,
          (this.runtime.replayingSessions.get(replaySid) ?? 0) + 1,
        )
        let replayMarkerReleased = false
        releaseReplayMarker = () => {
          if (replayMarkerReleased) return
          replayMarkerReleased = true
          const remainingReplays = (this.runtime.replayingSessions.get(replaySid) ?? 1) - 1
          if (remainingReplays <= 0) this.runtime.replayingSessions.delete(replaySid)
          else this.runtime.replayingSessions.set(replaySid, remainingReplays)
        }
        try {
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
              eventQueue.wakeEventLoop = fn
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
                ? formatAgyRpcErrorMessage(
                    loadError,
                    'Antigravity could not load the saved native session.',
                  )
                : 'Antigravity could not load the saved native session.',
              false,
            )
          }
          descriptor = parseAcpSessionDescriptor(loadResult, input.nativeSessionId)
          if (descriptor.configOptions.length === 0 && replayConfigOptions) {
            descriptor.configOptions = replayConfigOptions
          }
        } finally {
          replayingHistory = false
        }
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
            eventQueue.wakeEventLoop = fn
          },
          onNotification: () => undefined,
        })
        const newError = Reflect.get(newResp, 'error')
        const newResult = Reflect.get(newResp, 'result')
        if (newError || !isPlainObject(newResult)) {
          throw new AgentExecutionError(
            'protocol_error',
            newError
              ? formatAgyRpcErrorMessage(
                  newError,
                  'Antigravity ACP server did not create a session.',
                )
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
            rootWithheldByGuard = true
            recordHostBeforeRootStart()
            try {
              this.kernel.recordDispatch('rejected', resolvedSessionId, activeExecutorId)
            } catch {
              // Preserve confirmed-unsent proof and withheld classification if host callback throws.
            }
            inputWithheldError = new NativeInputWithheldError(
              'Antigravity replacement settings or executor differed from the expected recovery binding.',
            )
            throw inputWithheldError
          }
        }
      }

      // Prepare prompt content with Cutoff serialization & verified ACP images.
      const currentEnvelope =
        input.host?.lifecycle?.currentPromptEnvelope?.() ?? input.promptEnvelope
      toolStateMemoryReservation = foregroundScope.trackReservation(
        'tool_state_mem',
        connection.reserveWorkingMemory(0),
        () => {
          toolStateMemoryReservation = undefined
        },
      )
      foregroundDedupMemoryReservation = retainedScope.trackReservation(
        'foreground_dedup_mem',
        connection.reserveWorkingMemory(0),
        () => {
          foregroundDedupMemoryReservation = undefined
        },
      )
      mcpCorrelationMemoryReservation = foregroundScope.trackReservation(
        'mcp_correlation_mem',
        connection.reserveWorkingMemory(0),
        () => {
          mcpCorrelationMemoryReservation = undefined
        },
      )
      publishedPlanMemoryReservation = foregroundScope.trackReservation(
        'published_plan_mem',
        connection.reserveWorkingMemory(0),
        () => {
          publishedPlanMemoryReservation = undefined
        },
      )
      stagedPreBindMemoryReservation = foregroundScope.trackReservation(
        'staged_pre_bind_mem',
        connection.reserveWorkingMemory(0),
        () => {
          stagedPreBindMemoryReservation = undefined
        },
      )
      foreignExecIdsMemoryReservation = retainedScope.trackReservation(
        'foreign_exec_ids_mem',
        connection.reserveWorkingMemory(0),
        () => {
          foreignExecIdsMemoryReservation = undefined
        },
      )
      postCutoffBgMemoryReservation = retainedScope.trackReservation(
        'post_cutoff_bg_mem',
        connection.reserveWorkingMemory(0),
        () => {
          postCutoffBgMemoryReservation = undefined
        },
      )
      const { promptBlocks, expectedFullPromptText } = await prepareAgyTurnPromptBlocks({
        currentEnvelope,
        runId: input.runId,
        runSignal,
        workflow,
        systemAppend,
        mcpServer,
        sourceReader: input.host?.workflow?.sourceReader,
        reservePromptMemory: (bytes) => {
          promptMemoryReservation = foregroundScope.trackReservation(
            'prompt_mem',
            connection.reserveWorkingMemory(bytes),
            () => {
              promptMemoryReservation = undefined
            },
          )
        },
      })

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
          (!other.rootTerminal ||
            other.activeBackgroundTasks.size > 0 ||
            other.backgroundUnconfirmed) &&
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
        promptRpcCompleted: false,
        promptReplyReceived: false,
        replayingHistory: false,
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
        pendingLaunchToolCallIds: new Set(),
        launchedCompletedToolCallIds: new Set(),
        backgroundUnconfirmed: false,
        reportUnknown,
        observation,
        retireSourceReader,
        isSteerLeaseOpen: () =>
          !this.runtime.disposed &&
          !promptRpcCompleted &&
          !activeRun!.promptRpcCompleted &&
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
        canSettleEffects: () => !effectsReporter.isUnknownReported,
        isRootTerminal: () => rootTerminal,
        hasVerifiedRootOutcome: () => liveTerminalOutcome !== undefined || rootTerminal,
        ensureCompactEndedCommitted,
        awaitRecordings: () => recordingTail,
        hasPendingRecordings: () => recordings.size > 0,
        detachBeforeTerminalReport: detachActiveRun,
        reportSettled,
        reportUnknown,
        getForegroundDedupReservation: () => foregroundDedupMemoryReservation,
        getPostCutoffBgReservation: () => postCutoffBgMemoryReservation,
      })
      backgroundObserver = observer
      retainedScope.add('background_observer_unsubscribe', () => observer.unsubscribe())

      // Abort handler: distinguishes pre-write abort (`not_sent`) from post-write `session/cancel`
      // with a bounded settlement window for a real native `{ stopReason: 'cancelled' }` reply.
      const onCallerAbort = (): void => {
        const stopAbort = readRunStopAbortReason(signal)
        this.kernel.requestAbort(stopAbort?.reason, stopAbort?.deadlineAt)
        if (rootTerminal) return
        userCancelRequested = true
        if (activeRun) activeRun.cancellationPending = true
        abortOutstandingInteractions()
        if (!rootFirstByteWritten) {
          promptRpcAbort.abort()
          return
        }
        if (promptSettled || promptRpcCompleted) return
        void requestTurnCancel({
          onError: () => {
            if (!rootTerminal && stopAbort?.reason !== 'user_stop') {
              reportUnknown(
                'Native Antigravity cancellation could not be confirmed; observation remains active.',
              )
            }
          },
        })
        if (!clearCancelGraceTimer) {
          // A3: Explicit user Stop shares one monotonic 10s deadline; plain abort() preserves 1.5s grace.
          const cancelGraceMs =
            stopAbort?.reason === 'user_stop'
              ? Math.max(1, remainingStopBudgetMs(stopAbort))
              : AGY_PHYSICAL_SETTLEMENT_GRACE_MS
          clearCancelGraceTimer = foregroundScope.setTimeout(
            'cancel_grace_timer',
            () => {
              clearCancelGraceTimer = undefined
              promptRpcAbort.abort()
            },
            cancelGraceMs,
            true,
          )
        }
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      const unregisterCallerAbort = foregroundScope.add('caller_abort_listener', () =>
        signal.removeEventListener('abort', onCallerAbort),
      )
      if (signal.aborted) {
        onCallerAbort()
      }

      // Dispatch `session/prompt` with ordered reply delivery (`replyTo: sessionStream`).
      const promptParams: Record<string, unknown> = {
        sessionId: resolvedSessionId,
        prompt: promptBlocks,
        ...systemPromptMeta,
      }

      await stopPrePromptDrain(true)
      releaseReplayMarker?.()
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
          try {
            this.kernel.recordDispatch('possibly_sent', resolvedSessionId, activeExecutorId)
          } catch (error) {
            if (error instanceof NativeInputWithheldError) {
              rootWithheldByGuard = true
              inputWithheldError = error
            }
            throw error
          }
          rootFirstByteWritten = true
          promptMemoryReservation?.release()
          promptMemoryReservation = undefined
        },
      })
      void promptOp.physicalOutcome.then(() => {
        promptPhysicalSettled = true
        return undefined
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

      const acceptRootTurn = (): boolean => {
        if (!activeRun || activeRun.turnAccepted) return false
        activeRun.turnAccepted = true
        this.kernel.recordDispatch('accepted', resolvedSessionId, activeExecutorId)
        return true
      }

      let drainStagedPreBindIntoQueue: (() => void) | undefined

      const settlePromptFromResponse = (res: object): void => {
        promptResponse = res
        promptRpcResolvedResponseRef ??= res
        parsedPromptTerminalReply = parseAgyPromptTerminalReply(res, resolvedSessionId)
        promptSettled = true
        promptRpcCompleted = true
        promptReplyReceived = true
        abortOutstandingInteractions()
        if (activeRun) {
          activeRun.promptRpcCompleted = true
          activeRun.promptReplyReceived = true
          if (parsedPromptTerminalReply.ok) {
            const respExecId = parsedPromptTerminalReply.executionId
            const hasExecConflict = Boolean(
              respExecId &&
              (activeRun.knownForeignExecutionIds.has(respExecId) ||
                (activeRun.providerExecutionId && activeRun.providerExecutionId !== respExecId)),
            )
            if (!hasExecConflict) {
              if (respExecId && !activeRun.providerExecutionId) {
                this.runtime.projector.bindRootExecutionId(activeRun, input, respExecId)
                cancelDisownedInteractions()
              }
              // Drain staged pre-bind frames synchronously BEFORE opening post-cutoff background
              // routing so task aliases and foreground dedup IDs exist before any background frame.
              // Isolate hard-cap overflow so promptCutoffSeq and liveTerminalOutcome always commit.
              try {
                drainStagedPreBindIntoQueue?.()
              } catch {
                unresolvedPreBindOutput = true
                reportUnknown(
                  'Antigravity staged pre-bind drain exceeded pending event queue capacity; output completeness cannot be confirmed.',
                )
              }
              if (acceptRootTurn()) {
                pushPendingEvent({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
              }
              const earlyOutcome: 'completed' | 'interrupted' | 'failed' =
                parsedPromptTerminalReply.stopReason === 'cancelled'
                  ? 'interrupted'
                  : parsedPromptTerminalReply.stopReason === 'end_turn' ||
                      parsedPromptTerminalReply.stopReason === 'stop_sequence'
                    ? 'completed'
                    : 'failed'
              liveTerminalOutcome = earlyOutcome
              this.kernel.recordTerminal(earlyOutcome)
              if (
                controlDrainActive ||
                activeRun.activeBackgroundTasks.size > 0 ||
                observer.hasObservedBackgroundTask()
              ) {
                ensureCompactEndedCommitted()
              }
              observer.flushPreTerminalEntries()
            }
          }
          this.runtime.projector.notifyRootExecutionWaiters(activeRun)
        }
        clearCancelGrace()
        notifyEventLoop()
        if (controlDrainActive) {
          onControlSettled?.()
        }
      }
      settlePromptFromResponseRef = settlePromptFromResponse

      const failPromptControl = (err: Error, abortPump = false): void => {
        promptError ??= err
        promptSettled = true
        promptRpcCompleted = true
        promptReplyReceived = true
        mcpServer.notifyRootStateChanged()
        abortOutstandingInteractions()
        if (activeRun) {
          activeRun.promptRpcCompleted = true
          activeRun.promptReplyReceived = true
          this.runtime.projector.notifyRootExecutionWaiters(activeRun)
        }
        clearCancelGrace()
        if (abortPump) pumpAbort.abort()
        else promptRpcAbort.abort()
        notifyEventLoop()
        if (controlDrainActive) onControlSettled?.()
      }

      void promptOp.result.then(
        (res) => {
          promptRpcResolvedResponse = res
          promptRpcResolvedResponseRef = res
          promptRpcCompleted = true
          mcpServer.notifyRootStateChanged()
          if (activeRun) {
            activeRun.promptRpcCompleted = true
            this.runtime.projector.notifyRootExecutionWaiters(activeRun)
          }
          abortOutstandingInteractions()
          clearCancelGrace()
          // If the stream already ended before delivering the reply frame, settle immediately.
          if (streamEnded && !promptSettled) {
            settlePromptFromResponse(res)
          }
          return undefined
        },
        (err: unknown) => {
          failPromptControl(err instanceof Error ? err : new Error(String(err)), true)
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
        void task.finally(() => {
          recordings.delete(task)
          observer.onRecordingsSettled()
        })
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
          approvedBrainPlanCalls: collaboration.approvedBrainPlanCalls,
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
          ...collaboration.projectorCallbacks({
            mcpServer,
            getPublishedPlanReservation: () => publishedPlanMemoryReservation,
          }),
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
          onAcceptTurn: () => {
            acceptRootTurn()
          },
          canAdmitForegroundDelta: () => this.kernel.canAdmitEffect('stream_delta'),
          retainHiddenAnswerAfterFreeze: readRunStopAbortReason(signal)?.reason === 'user_stop',
          canAdmitWorkflowEffect: () => this.kernel.canAdmitEffect('open_plan_publish'),
          onForegroundDeltaDropped: () => {
            foregroundDeltaDropped = true
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
        prePromptReplay,
        hasCurrentRunTool: (toolCallId) => tools.has(toolCallId),
        expectedFullPromptText,
        expectedPromptContent: currentEnvelope.message.content.trim(),
        getStagedPreBindReservation: () => stagedPreBindMemoryReservation,
        releaseStagedPreBindReservation: () => {
          stagedPreBindMemoryReservation?.release()
          stagedPreBindMemoryReservation = undefined
        },
        getForeignExecIdsReservation: () => foreignExecIdsMemoryReservation,
        releaseForeignExecIdsReservation: () => {
          foreignExecIdsMemoryReservation?.release()
          foreignExecIdsMemoryReservation = undefined
        },
        onExecutionOwnershipChanged: cancelDisownedInteractions,
        onOwnedOutOfTurnUpdate: (params, update) => {
          observer.enqueuePostCutoffBackgroundUpdate(params, update)
        },
        projectValidatedFrame,
      })

      drainStagedPreBindIntoQueue = (): void => {
        if (!activeRun || activeRun.stagedPreBindNotifications.length === 0) {
          return
        }
        for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
          pushPendingEvent(ev)
        }
      }

      let foregroundResourcesCleaned = false
      cleanupForegroundResources = (opts): void => {
        if (foregroundResourcesCleaned) return
        foregroundResourcesCleaned = true
        try {
          clearPendingEvents()
        } catch {
          // Isolate cleanup errors so later reservations and answer always dispose.
        }
        try {
          frameAdmitter.close(opts)
        } catch {
          // Isolate cleanup errors so answer.dispose() always runs.
        }
        prePromptReplay.clear()
        try {
          answer.dispose()
        } catch {
          // Isolate answer disposal errors.
        }
      }

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
      drainBufferedPostCutoff = (): void => {
        if (promptCutoffSeq === undefined || !sessionStream) return
        while (true) {
          const buffered = sessionStream.shift()
          if (!buffered) break
          if (buffered.seq > promptCutoffSeq) routePostCutoffIngress(buffered)
        }
      }

      const dispatchOrderedIngress = (item: AgyIngress): void => {
        if (item.kind === 'end') {
          streamEnded = true
          if (promptCutoffSeq === undefined) {
            if (promptRpcResolvedResponse && !promptSettled) {
              settlePromptFromResponse(promptRpcResolvedResponse)
            } else if (!promptError) {
              if (!activeRun!.turnAccepted && connection.isOpen) {
                void requestTurnCancel()
              }
              failPromptControl(
                new AgentExecutionError(
                  item.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
                  item.detail ?? 'Antigravity session stream ended before prompt settlement.',
                  item.cause === 'deadline',
                ),
              )
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

      handoffOrderedStreamToBackground = (onRetainedCleanup: () => void): void => {
        observer.handoffOrderedStreamToBackground({
          connection,
          sessionStream,
          promptCutoffSeq,
          routePostCutoffIngress,
          onStreamClosed: () => {
            sessionStream = undefined
          },
          onRetainedCleanup,
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
                eventQueue.wakePumpForBackpressure = resolveDrain
                if (!isPumpActive() || !isPendingEventsAtSoftCap()) {
                  eventQueue.wakePumpForBackpressure = undefined
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
                  void requestTurnCancel()
                }
                failPromptControl(err)
              }
              break
            }
            dispatchOrderedIngress(nextItem)
          }
        } catch (err) {
          pumpError ??= err instanceof Error ? err : new Error(String(err))
          failPromptControl(pumpError)
        }
      })()

      try {
        while (true) {
          while (eventQueue.length > 0) {
            const nextEv = shiftPendingEvent()
            if (nextEv) yield nextEv
          }
          if (activeRun.stagedPreBindNotifications.length > 0) {
            for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
              yield ev
            }
          }
          if (promptSettled) {
            while (eventQueue.length > 0) {
              const nextEv = shiftPendingEvent()
              if (nextEv) yield nextEv
            }
            if (activeRun.stagedPreBindNotifications.length > 0) {
              for (const ev of frameAdmitter.drainStagedPreBindNotes()) {
                yield ev
              }
            }
            break
          }
          // oxlint-disable-next-line no-await-in-loop -- Generator yields events as the independent frame pump pushes them.
          await new Promise<void>((resolveWake) => {
            eventQueue.wakeEventLoop = resolveWake
          })
        }

        // Fence steer dispatch BEFORE releasing the root Turn, and verify any dispatched steer receipts.
        rootReleasing = true
        activeRun.rootReleasing = true
        signal.removeEventListener('abort', onCallerAbort)
        unregisterCallerAbort()
        clearCancelGrace()

        if (pumpError) {
          promptError = pumpError
        }
        if (promptError) {
          promptRpcAbort.abort()
          const stopAbort = readRunStopAbortReason(signal)
          const physicalBudgetMs =
            stopAbort?.reason === 'user_stop'
              ? remainingStopBudgetMs(stopAbort)
              : AGY_PHYSICAL_SETTLEMENT_GRACE_MS
          const physical =
            physicalBudgetMs <= 0
              ? 'timeout'
              : await awaitPhysicalCompletionBounded(promptOp.physicalOutcome, physicalBudgetMs)
          if (physical === 'not_sent') {
            rootConfirmedNotSent = true
            rootFirstByteWritten = false
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
            try {
              this.kernel.recordDispatch('rejected', resolvedSessionId, activeExecutorId)
            } catch {
              // Keep confirmed-unsent recovery proof and withheld error classification intact
              // even if the host dispatch callback itself threw.
            }
            if (rootWithheldByGuard) {
              throw (
                inputWithheldError ??
                new NativeInputWithheldError(
                  'Antigravity root prompt was withheld by the recovery dispatch guard before any byte was written.',
                )
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
          cancelDisownedInteractions()
        }
        this.runtime.projector.notifyRootExecutionWaiters(activeRun)

        if (activeRun.stagedPreBindNotifications.length > 0) {
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

        // A4: Suppress late `reasoning.summary.completed` emission after user Stop.
        if (!userCancelRequested && !signal.aborted) {
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
        }
        reasoningItems.clear()

        await collaboration.readbackBrainPlanIfNeeded({
          runtime: this.runtime,
          canonicalCwd: lease.canonicalCwd,
          resolvedSessionId,
          activeRun,
          signal: postReplyCheckSignal,
        })

        const activeStopAbort = readRunStopAbortReason(signal)
        if (activeStopAbort?.reason === 'user_stop' && recordings.size > 0) {
          const drainedInBudget = await awaitWithinStopBudget(recordingTail, activeStopAbort)
          if (!drainedInBudget) {
            retainTimedOutRecordings = true
            activeRun.backgroundUnconfirmed = true
            reportUnknown(
              'Antigravity workspace file recording did not finish before the Stop deadline.',
            )
          }
        } else {
          await recordingTail
        }
        await input.host?.lifecycle?.waitForRootOutput?.()
        drainBufferedPostCutoff?.()
        await observer.awaitTail()

        const incompleteVisiblePrefix = unresolvedPreBindOutput || foregroundDeltaDropped
        const finalSnapshot = answer.finalize()

        // Preserve verified native `stopReason` (`end_turn` -> `completed`) even if Stop (`signal.aborted`)
        // arrived late while draining foreground output!
        const outcome: 'completed' | 'interrupted' | 'failed' =
          liveTerminalOutcome ??
          (stopReason === 'cancelled'
            ? 'interrupted'
            : stopReason === 'end_turn' || stopReason === 'stop_sequence'
              ? 'completed'
              : 'failed')

        rootTerminal = true
        activeRun.rootTerminal = true
        this.kernel.recordTerminal(outcome)

        const { settledPlan, reviewResult, inputResult } =
          collaboration.getTerminalOutputArtifacts()
        const outputCompleteness: 'complete' | 'partial' =
          outcome === 'completed' && !incompleteVisiblePrefix ? 'complete' : 'partial'
        const terminalEvidence: Parameters<AgyAdapterRuntime['recordEvidence']>[3] = {
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          ...(answer.text || (outcome === 'completed' && !incompleteVisiblePrefix && settledPlan)
            ? {
                output: {
                  outputId: answer.outputId,
                  text: answer.text,
                  completeness: outputCompleteness,
                  ...(outcome === 'completed' && !incompleteVisiblePrefix && settledPlan
                    ? { plan: settledPlan }
                    : {}),
                  ...(outcome === 'completed' && !incompleteVisiblePrefix && reviewResult
                    ? { reviewVerdict: reviewResult.verdict, reviewResult }
                    : {}),
                  ...(outcome === 'completed' && !incompleteVisiblePrefix && inputResult
                    ? { inputOutcome: inputResult.outcome, inputResult }
                    : {}),
                },
              }
            : {}),
        }

        // S2-F1 & B-F6: Persist verified native terminal receipt BEFORE yielding `text.completed`
        // or truncated `turn.completed(failed)` so SQLite monotonically retains `nativeOutcome=completed`
        // even if the consumer exits or restarts at that yield point.
        if (!finalTerminalEvidenceCommitted && !foregroundReleased) {
          this.runtime.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )
          finalTerminalEvidenceCommitted = true
          compactTerminalCommitted = true
        }

        if (finalSnapshot !== undefined && !incompleteVisiblePrefix) {
          yield {
            agentId: 'agy',
            type: 'text.completed',
            turnId: input.runId,
            outputId: answer.outputId,
            text: finalSnapshot,
          }
        }

        collaboration.recordPlanUnavailabilityIfNeeded({ outcome, mcpServer })
        yield* collaboration.promoteArtifactsIfEligible({
          outcome,
          unknownReported: effectsReporter.isUnknownReported,
          incompleteVisiblePrefix:
            incompleteVisiblePrefix || activeStopAbort?.reason === 'user_stop',
          resolvedSessionId,
          mcpServer,
        })

        if (!foregroundReleased) {
          if (incompleteVisiblePrefix && outcome === 'completed') {
            yield {
              agentId: 'agy',
              type: 'turn.completed',
              turnId: input.runId,
              outcome: 'failed',
            }
            if (
              !effectsReporter.isUnknownReported &&
              !activeRun.backgroundUnconfirmed &&
              activeRun.activeBackgroundTasks.size === 0
            ) {
              reportSettled()
            }
          } else {
            if (
              !effectsReporter.isUnknownReported &&
              !activeRun.backgroundUnconfirmed &&
              activeRun.activeBackgroundTasks.size === 0
            ) {
              reportSettled()
            }

            yield {
              agentId: 'agy',
              type: 'turn.completed',
              turnId: input.runId,
              outcome,
            }
          }
        }
      } finally {
        ensureCompactEndedCommitted()
        if (
          promptSettled ||
          rootTerminal ||
          isConfirmedZeroBytesSent() ||
          this.runtime.disposed ||
          !lease?.connection.isOpen
        ) {
          cleanupForegroundResources({
            keepForeignExecReservation:
              !emergencyCleanedUp &&
              !this.runtime.disposed &&
              (activeRun.activeBackgroundTasks.size > 0 ||
                (retainTimedOutRecordings && recordings.size > 0)) &&
              rootTerminal &&
              (compactTerminalCommitted ||
                finalTerminalEvidenceCommitted ||
                retainTimedOutRecordings),
          })
        }
      }
    } catch (error) {
      rootTerminal = true
      if (activeRun) {
        activeRun.rootTerminal = true
        this.runtime.projector.notifyRootExecutionWaiters(activeRun)
      }
      clearCancelGrace()
      promptRpcAbort.abort()
      await stopPrePromptDrain?.(false).catch(() => undefined)
      stopStreamPump?.()
      this.runtime.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      const catchStopAbort = readRunStopAbortReason(signal)
      if (catchStopAbort?.reason === 'user_stop' && recordings.size > 0) {
        const drainedInBudget = await awaitWithinStopBudget(
          recordingTail.catch(() => undefined),
          catchStopAbort,
        )
        if (!drainedInBudget) {
          retainTimedOutRecordings = true
          if (activeRun) activeRun.backgroundUnconfirmed = true
          reportUnknown(
            'Antigravity workspace file recording did not finish before the Stop deadline.',
          )
        }
      } else {
        await recordingTail.catch(() => undefined)
      }
      const confirmedZeroBytesSent = isConfirmedZeroBytesSent()
      if (!effectsReporter.isUnknownReported) {
        if (confirmedZeroBytesSent) {
          if (activeRun || rootWithheldByGuard) {
            effectsReporter.reportSettled(
              rootWithheldByGuard ? 'workflow_input_withheld' : 'native_turn_not_started',
            )
          }
        } else {
          reportUnknown(
            effectsReporter.lastUnknownReason ??
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
