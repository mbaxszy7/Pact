import { randomUUID } from 'node:crypto'

import type {
  AgentAdapter,
  AgentPromptEnvelope,
  AgentRunInput,
  RunExecutionHost,
  RunRecoveryPort,
} from '@pact/agent-runtime'
import type {
  AgentRun,
  DefaultSessionSettings,
  RuntimeAgentId,
  SchedulingHandoff,
} from '@pact/contracts'

import {
  isAgentInPair,
  nativeBackgroundReportIdentitySchema,
  nativeBackgroundReportSchema,
  otherAgent,
  resolveActiveAgentPair,
} from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { ActiveExecution, NativeObservation } from '../conversation-types'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  NativeInputWithheldError,
  NativeThreadArchivedError,
  NativeThreadOccupiedError,
  PermissionModeRejectedError,
} from '../agent-execution-error'
import { pathlessExecutionInput, restoreExecutionInput } from '../execution-input'
import { FrozenSourceReader } from '../frozen-source-reader'
import { encodeNativeJsonFrame } from '../native-json-encoder'
import { safeNativePermissionText } from '../native-permission-wait'
import { NativeWorkingMemory } from '../native-working-memory'
import { RunOutputArchiver, type CompletedNativeReceipt } from '../run-output-archiver'
import { pendingContinuationFailureCopy } from './collaboration-and-handoff-coordinator'

/**
 * Autonomous coordinator owning Run lifecycle execution, single-writer output archiving
 * (`RunOutputArchiver`), workspace-change finalization, confirmed-unsent reexecution,
 * and grouped `RunExecutionHost` port construction.
 */
export class RunExecutor {
  constructor(private readonly core: ConversationRuntimeCore) {}

  execute(
    run: AgentRun,
    initialPrompt: AgentPromptEnvelope,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    return this.trackExecution(run, async (execution) => {
      await this.executeAttempts(execution, run, initialPrompt, cwd, settings, executablePaths)
      if (this.core.conversations.findRun(run.id)?.status !== 'completed') return
      const primaryRunId = run.id
      try {
        await this.core.collaboration.executeRoutedContinuation(
          execution,
          run.userMessageId,
          cwd,
          settings,
          executablePaths,
        )
      } catch (error) {
        if (execution.run.id !== primaryRunId) {
          throw error
        }
        if (
          !this.core.disposed &&
          !execution.abortController.signal.aborted &&
          !execution.cancelledByUser
        ) {
          const activePair = resolveActiveAgentPair(settings)
          const targetAgentId: RuntimeAgentId = isAgentInPair(run.agentId, activePair)
            ? otherAgent(run.agentId, activePair)
            : activePair[0] === run.agentId
              ? activePair[1]
              : activePair[0]
          this.core.publish(
            this.core.conversations.failPendingRoutedContinuation(
              run.sessionId,
              run.userMessageId,
              targetAgentId,
              pendingContinuationFailureCopy(targetAgentId, error),
            ),
          )
        }
      }
    })
  }

  trackExecution(
    run: AgentRun,
    work: (execution: ActiveExecution) => Promise<void>,
  ): Promise<void> {
    if (this.core.activeExecutions.has(run.sessionId)) {
      throw new RunOperationConflictError('This Session already has an active operation.')
    }
    const execution: ActiveExecution = {
      run,
      protectedAgentId: run.agentId,
      deliveryPossible: false,
      abortController: new AbortController(),
    }
    this.core.activeExecutions.set(run.sessionId, execution)
    execution.completion = work(execution)
      .catch((error: unknown) => {
        if (
          !this.core.disposed &&
          !execution.cancelledByUser &&
          this.core.activeExecutions.get(execution.run.sessionId) === execution &&
          this.core.conversations.findRun(execution.run.id)?.status !== 'completed'
        ) {
          this.core.publish(
            this.core.conversations.failRun(
              execution.run.id,
              execution.run.failureKind === 'unknown_delivery' || execution.deliveryPossible
                ? 'unknown_delivery'
                : 'protocol_error',
              error instanceof Error ? error.message : 'Pact could not start the Agent stream.',
            ),
          )
        }
      })
      // oxlint-disable-next-line typescript/no-misused-promises -- Promise.finally awaits asynchronous resource cleanup on both settlement paths.
      .finally(async () => {
        let drainError: unknown
        try {
          const owner = this.core.nativeObservations.get(execution.run.id)
          const archiverForRun = owner?.archiver ?? execution.lastArchiver
          if (archiverForRun) {
            try {
              await archiverForRun.drain()
            } catch (error: unknown) {
              drainError = error
            }
          }
          if (owner) {
            owner.foregroundExited = true
            if (
              !owner.adapter.hasActiveBackgroundWork?.(execution.run.id) &&
              !(owner.backgroundReportTasks?.size ?? 0)
            ) {
              if (execution.streamBuffer && !execution.streamBuffer.flush()) {
                drainError ??= new Error('The last foreground output could not be committed.')
              }
              if (
                owner.archiver.archiveBuffer &&
                (!owner.archiver.archiveBuffer.flush() || !owner.archiver.archiveBuffer.dispose())
              ) {
                drainError ??= new Error('The late native output could not be committed.')
              }
              owner.release?.()
              if (this.core.nativeObservations.get(execution.run.id) === owner) {
                if (owner.archiver.failureRecordingError !== undefined) {
                  this.core.recordUnrecordedArchiveFailure(
                    execution.run.id,
                    run.sessionId,
                    owner.archiver.failureRecordingError,
                  )
                }
                owner.observationController.abort()
                this.settleOrphanedPendingEffects(
                  execution.run.id,
                  Boolean(execution.enteredNativeAdapter) || execution.deliveryPossible,
                )
                this.core.retireStreamTrace(owner, execution.streamBuffer)
                owner.sourceReader?.retire()
                this.core.recovery.clearBackgroundStop(owner)
                this.core.nativeObservations.delete(execution.run.id)
              }
            }
          }
          if (drainError === undefined && archiverForRun?.failureRecordingError !== undefined) {
            drainError = archiverForRun.failureRecordingError
          }
          await this.finalizeWorkspaceChanges(execution.run.id)
          const settled = this.core.conversations.reconcileCompletedCollaboration(execution.run.id)
          if (settled) this.core.publish(settled)
          if (drainError !== undefined) throw drainError
        } finally {
          execution.streamBuffer?.dispose()
          execution.streamBuffer = undefined
          const finished = this.core.conversations.findRun(execution.run.id)
          const task = this.core.conversations.collaboration(run.sessionId)
          if (
            !this.core.disposed &&
            this.core.conversations.queueState(run.sessionId).input?.state === 'queued' &&
            !this.core.conversations.receivedCollaborationInput(run.sessionId)?.taskId &&
            (finished?.status !== 'completed' ||
              finished.dispatchPhase !== 'ended' ||
              finished.nativeOutcome !== 'completed' ||
              !this.core.conversations.hasCompleteResponse(execution.run.id) ||
              finished.nativeEffectsState === 'unknown' ||
              (task?.runId === execution.run.id && task.status === 'failed'))
          ) {
            this.core.publish(
              this.core.conversations.pauseConversationQueue(
                run.sessionId,
                'The execution did not complete normally. Check its state, then resume the queued message when ready.',
              ),
            )
          }
          if (this.core.activeExecutions.get(run.sessionId) === execution) {
            this.core.activeExecutions.delete(run.sessionId)
          }
          if (!this.core.disposed) {
            this.core.publish(this.core.conversations.metadataPatch(run.sessionId))
          }
          this.core.collaboration.schedulePendingRoutedContinuations()
        }
      })
    void execution.completion.catch(() => undefined)
    return execution.completion
  }

  /** A Steer boundary freezes only output committed before its accepted User. */
  flushRunOutput(run: Pick<AgentRun, 'id' | 'sessionId'>): void {
    const owner = this.core.nativeObservations.get(run.id)
    if (owner) {
      owner.archiver.flush()
      return
    }
    const execution = this.core.activeExecutions.get(run.sessionId)
    const foreground = execution?.run.id === run.id ? execution.streamBuffer : undefined
    if (foreground && !foreground.flush()) {
      this.failRunOutput(
        run,
        new AgentExecutionError(
          'protocol_error',
          'The current output could not be committed before its input boundary.',
          false,
        ),
      )
    }
  }

  /** Quarantine only the body lane; exact native control callbacks stay live. */
  failRunOutput(run: Pick<AgentRun, 'id' | 'sessionId'>, error: unknown): AgentExecutionError {
    const owner = this.core.nativeObservations.get(run.id)
    if (owner) {
      return owner.archiver.markAborted(error)
    }
    const failure = classifyAgentError(error)
    const execution = this.core.activeExecutions.get(run.sessionId)
    if (execution?.run.id === run.id) execution.streamBuffer?.discard()
    this.core.publish(this.core.conversations.recordOutputFailure(run.id, failure))
    if (this.core.conversations.findRun(run.id)?.dispatchPhase === 'ended') {
      this.core.publish(this.core.conversations.settleKnownNativeEnding(run.id))
    }
    return failure
  }

  private settleOrphanedPendingEffects(runId: string, deliveryPossible: boolean): void {
    const saved = this.core.conversations.findRun(runId)
    if (saved?.nativeEffectsState !== 'pending') return
    if (
      !deliveryPossible &&
      saved.dispatchPhase === 'not_sent' &&
      !saved.nativeTurnId &&
      !saved.nativeOutcome
    ) {
      this.core.publish(
        this.core.conversations.recordNativeEffects(
          runId,
          'not_dispatched',
          'stopped_before_native_dispatch',
        ),
      )
      return
    }
    this.core.publish(
      this.core.conversations.recordNativeEffects(
        runId,
        'unknown',
        'observer_ended_without_settlement',
      ),
    )
  }

  async finalizeWorkspaceChanges(runId: string): Promise<void> {
    if (this.core.disposed) return
    const run = this.core.conversations.findRun(runId)
    if (!run || ['starting', 'running', 'recovering'].includes(run.status)) return
    const activeAdapter =
      this.core.nativeObservations.get(runId)?.adapter ??
      this.core.adapters.get(`${run.sessionId}:${run.agentId}`)?.adapter
    if (activeAdapter?.hasActiveBackgroundWork?.(runId)) {
      const recorded = this.core.workspaceChanges?.summary(runId)
      if (run.dispatchPhase === 'ended' && recorded && recorded.fileCount > 0) {
        this.core.publish(this.core.conversations.recordWorkspaceChanges(recorded))
      }
      return
    }
    const summary = await this.core.workspaceChanges?.finish(runId)
    if (
      summary &&
      (summary.fileCount > 0 ||
        summary.state === 'recovery_required' ||
        run.workspaceChanges !== undefined)
    ) {
      this.core.publish(this.core.conversations.recordWorkspaceChanges(summary))
    }
  }

  launchConfirmedUnsentReexecution(faultId: string, node: SchedulingHandoff): void {
    const original =
      node.freshnessGuard.runId && this.core.conversations.findRun(node.freshnessGuard.runId)
    if (!original) return
    const saved = this.core.conversations.executionInput(original.id)
    const cached = this.core.adapters.get(`${original.sessionId}:${original.agentId}`)
    const settings = this.core.sessions.findSettingsRevision(
      original.sessionId,
      original.settingsRevision,
    )
    if (
      !saved?.proof ||
      !cached ||
      !this.core.adapterOwnsExecutor(cached.adapter, saved.proof.executorId) ||
      !settings ||
      this.core.gate.hasBlockingBackgroundWork(original.sessionId)
    ) {
      return
    }
    const snapshot = this.core.conversations.frozenExecutionEnvelope(original.id)
    const originalHandoffCount = original.handoffMessageCount ?? 0
    if (
      originalHandoffCount > 0 &&
      (snapshot.handoffContext?.length ?? 0) < originalHandoffCount &&
      !snapshot.handoffSpine?.length
    ) {
      return
    }
    if (
      snapshot.collaboration &&
      (snapshot.collaboration.planVersion > 0 || Boolean(snapshot.collaboration.review?.verdict)) &&
      !snapshot.planSummary
    ) {
      return
    }
    if (
      originalHandoffCount > 0 &&
      snapshot.peerWorkspaceChanges === undefined &&
      this.core.workspaceChanges
    ) {
      const peerMessageIds = [
        ...(snapshot.handoffSpine ?? [])
          .filter((entry) => entry.speaker !== 'user')
          .map((entry) => entry.messageId),
        ...(snapshot.handoffContext ?? [])
          .filter((entry) => entry.speaker !== 'user')
          .map((entry) => entry.messageId),
      ]
      if (
        peerMessageIds.length > 0 &&
        this.core.conversations.recentPeerWorkspaceChangeCandidates({
          sessionId: original.sessionId,
          messageIds: peerMessageIds,
          limit: 1,
        }).length > 0
      ) {
        return
      }
    }
    const prompt = restoreExecutionInput(
      snapshot,
      (image) => {
        if (!this.core.images) {
          throw new RunOperationConflictError('The original image source is unavailable.')
        }
        return this.core.images.resolve(original.sessionId, image)
      },
      this.core.conversations.skillInvocation(original.userMessageId),
    )
    const started = this.core.conversations.beginConfirmedUnsentReexecution({
      operationId: randomUUID(),
      faultId,
      handoff: node,
    })
    if (!started.created) return
    this.core.publish(started.patch)
    void this.trackExecution(started.run, async (execution) => {
      const prepared = await this.core.prepareSession(
        original.sessionId,
        execution.abortController.signal,
        [original.agentId],
      )
      if (!prepared.ok) {
        throw new AgentExecutionError('runtime_incompatible', prepared.error.message, false)
      }
      if (
        this.core.adapters.get(`${original.sessionId}:${original.agentId}`)?.adapter !==
          cached.adapter ||
        !this.core.conversations.canDispatchReexecution(started.run.id)
      ) {
        throw new NativeInputWithheldError()
      }
      await this.executeAttempts(
        execution,
        started.run,
        prompt,
        prepared.value.projectDirectory,
        settings,
        prepared.value.executablePaths,
      )
      if (this.core.conversations.findRun(started.run.id)?.status === 'completed') {
        await this.core.collaboration.executeRoutedContinuation(
          execution,
          started.run.userMessageId,
          prepared.value.projectDirectory,
          settings,
          prepared.value.executablePaths,
        )
      }
    })
  }

  ownsFrozenSourceRoot(run: AgentRun): boolean {
    const saved = this.core.conversations.findRun(run.id)
    const binding = this.core.conversations.nativeContext(run.sessionId, run.agentId)
    // A merely prepared/failed replacement candidate is not committed source
    // ownership loss. Its previous live root keeps only its original grant.
    return Boolean(
      saved &&
      !saved.forkSourceRunId &&
      saved.controlDisposition !== 'abandoned' &&
      saved.dispatchPhase !== 'ended' &&
      this.core.conversations.latestAgentRun(run.sessionId, run.agentId)?.id === run.id &&
      (!binding ||
        (binding.bindingGeneration === (run.bindingGeneration ?? 1) &&
          (!saved.nativeSessionId || binding.nativeSessionId === saved.nativeSessionId))),
    )
  }

  retireChangedSourceGrants(sessionId: string, agentId: RuntimeAgentId): void {
    for (const [runId, owner] of this.core.nativeObservations) {
      const saved = this.core.conversations.findRun(runId)
      if (
        !owner.sourceReader ||
        saved?.sessionId !== sessionId ||
        saved.agentId !== agentId ||
        this.ownsFrozenSourceRoot(saved)
      ) {
        continue
      }
      owner.adapter.retireSourceGrant?.(owner.sourceReader.identity)
      owner.sourceReader.retire()
      owner.sourceReader = undefined
    }
  }

  reconcileOwnedCompletedCollaboration(runId: string, receipt: CompletedNativeReceipt): void {
    if (this.core.disposed || !this.core.conversations.ownsNativeControl(runId)) return
    const run = this.core.conversations.findRun(runId)
    if (
      !run ||
      run.forkSourceRunId ||
      run.nativeTurnId !== receipt.nativeTurnId ||
      run.dispatchPhase !== 'ended' ||
      run.nativeOutcome !== 'completed'
    ) {
      return
    }
    const binding = this.core.conversations.nativeContext(run.sessionId, run.agentId)
    if (
      !binding ||
      binding.nativeSessionId !== run.nativeSessionId ||
      binding.bindingGeneration !== (run.bindingGeneration ?? 1)
    ) {
      return
    }
    const patch = this.core.conversations.reconcileCompletedCollaboration(runId)
    if (patch) this.core.publish(patch)
  }

  ownsExecution(execution: ActiveExecution, runId: string): boolean {
    return (
      !this.core.disposed &&
      !execution.abortController.signal.aborted &&
      !execution.cancelledByUser &&
      this.core.activeExecutions.get(execution.run.sessionId) === execution &&
      execution.run.id === runId
    )
  }

  async executeAttempts(
    execution: ActiveExecution,
    run: AgentRun,
    promptEnvelope: AgentPromptEnvelope,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    const diagnosticStartedAt = Date.now()
    // Reset per-Run delivery & adapter state so a reused ActiveExecution (e.g., @all Secondary)
    // never inherits the Primary Run's deliveryPossible or adapter ownership.
    execution.deliveryPossible = false
    execution.enteredNativeAdapter = false
    execution.adapter = undefined
    execution.streamBuffer = undefined
    execution.lastArchiver = undefined
    recordDiagnostic({
      operation: 'send',
      scope: 'run',
      phase: 'started',
      sessionId: run.sessionId,
      runId: run.id,
      agentId: run.agentId,
    })
    let context: ReturnType<ConversationRuntimeCore['conversations']['nativeContext']>
    let peerAssistanceAllowed = false
    const signal = execution.abortController.signal
    let adapter: AgentAdapter
    try {
      context = this.core.conversations.nativeContext(run.sessionId, run.agentId)
      peerAssistanceAllowed =
        !run.collaboration &&
        this.core.conversations.internalMessage(run.userMessageId, run.sessionId)?.route?.type !==
          'all'
      const recordingIssue = await this.core.workspaceChanges?.start(run, signal)
      if (recordingIssue) {
        this.core.publish(
          this.core.conversations.recordWorkspaceRecordingUnavailable(run.id, recordingIssue),
        )
      }
      adapter = await this.core.adapterFor(
        run.sessionId,
        run.agentId,
        executablePaths[run.agentId],
        signal,
        cwd,
      )
      execution.adapter = adapter
      this.core.archiveAndQuit.nativeMetadataChanged()
      const currentBinding = this.core.conversations.nativeContext(run.sessionId, run.agentId)
      if (
        currentBinding &&
        (currentBinding.continuationState !== 'ready' ||
          currentBinding.bindingGeneration !== run.bindingGeneration ||
          (run.nativeSessionId && currentBinding.nativeSessionId !== run.nativeSessionId))
      ) {
        throw new RunOperationConflictError(
          'The native binding is no longer ready for this prepared task.',
        )
      }
      if (!this.ownsExecution(execution, run.id)) return
      this.retireChangedSourceGrants(run.sessionId, run.agentId)
      if (this.core.nativeObservations.size >= 40 && !this.core.nativeObservations.has(run.id)) {
        throw new NativeCapacityError('Native observation capacity is occupied.')
      }
    } catch (error) {
      if (this.core.disposed) return
      const saved = this.core.conversations.findRun(run.id)
      if (execution.cancelledByUser || saved?.status === 'interrupted') {
        if (saved?.nativeEffectsState === 'pending') {
          this.core.publish(
            this.core.conversations.recordNativeEffects(
              run.id,
              'not_dispatched',
              'stopped_before_native_dispatch',
            ),
          )
        }
        return
      }
      const failure = classifyAgentError(error)
      this.core.conversations.finishCollaboration(run.id, false, failure.message)
      if (saved && ['starting', 'running', 'recovering'].includes(saved.status)) {
        this.core.publish(
          this.core.conversations.failRun(run.id, failure.kind, failure.message, false),
        )
        if (error instanceof NativeCapacityError) {
          this.core.publish(
            this.core.conversations.recordNativeEffects(
              run.id,
              'not_dispatched',
              'native_capacity_not_started',
            ),
          )
        }
      }
      return
    }

    const generation = randomUUID()
    let cutoffsMarked = false
    let injectedCutoffIds: string[] = []
    const markInjectedCutoffs = (): void => {
      if (cutoffsMarked || !injectedCutoffIds.length) return
      const currentBindingGen =
        this.core.conversations.findRun(run.id)?.bindingGeneration ?? run.bindingGeneration ?? 1
      const marked = this.core.conversations.markCutoffsDelivered(
        run.sessionId,
        run.agentId,
        currentBindingGen,
        injectedCutoffIds,
      )
      if (marked.length > 0) cutoffsMarked = true
    }

    const ownsCurrentNativeRun = (): boolean =>
      this.core.activeExecutions.get(run.sessionId) === execution &&
      execution.run.id === run.id &&
      this.core.conversations.ownsNativeControl(run.id)
    const ownsAdmittedForegroundBatch = (): boolean => {
      if (!ownsCurrentNativeRun()) return false
      const saved = this.core.conversations.findRun(run.id)
      return Boolean(saved && ['starting', 'running', 'recovering'].includes(saved.status))
    }
    const ownsForegroundOutput = (): boolean => {
      if (!this.ownsExecution(execution, run.id)) return false
      return ownsAdmittedForegroundBatch()
    }
    const currentControl = (): boolean => !this.core.disposed && ownsCurrentNativeRun()

    // Construct the single-writer RunOutputArchiver first, then bind it to NativeObservation.
    let ownerRef!: NativeObservation
    const stillOwned = (): boolean =>
      !this.core.disposed && this.core.nativeObservations.get(run.id) === ownerRef
    // A-3: Keep already-queued archive/background-report persistence alive during close() drain
    // while `this.core.disposed = true` rejects new external requests.
    const canDrainObservation = (): boolean =>
      (!this.core.disposed || this.core.drainingForClose) &&
      this.core.nativeObservations.get(run.id) === ownerRef

    const archiver = new RunOutputArchiver({
      run,
      peerAssistanceAllowed,
      isOwned: canDrainObservation,
      isDisposed: () => this.core.disposed && !this.core.drainingForClose,
      ownsCurrentControl: ownsForegroundOutput,
      ownsAdmittedForegroundBatch,
      isRunEnded: () => this.core.conversations.findRun(run.id)?.dispatchPhase === 'ended',
      applyStreamBatch: (events, archive) =>
        archive
          ? this.core.conversations.applyArchivedBatch(run.sessionId, run.id, events)
          : this.core.conversations.applyStreamBatch(run.sessionId, run.id, events),
      applyEvent: (fact, archive) =>
        archive
          ? this.core.conversations.applyArchivedEvent(run.sessionId, run.id, fact)
          : this.core.conversations.applyEvent(run.sessionId, run.id, fact),
      completeAnswer: (metadata, parts, bodySignal, archive) =>
        this.core.conversations.completeAnswer(
          run.id,
          metadata,
          parts,
          bodySignal,
          archive ? { archive: true } : undefined,
        ),
      recordNativeEvidence: (evidence) =>
        this.core.conversations.recordNativeEvidence(evidence, 'retry'),
      recordOutputFailure: (failure) =>
        this.core.conversations.recordOutputFailure(run.id, failure),
      settleKnownNativeEnding: (failure) =>
        this.core.conversations.settleKnownNativeEnding(run.id, failure),
      recordWorkflowPlan: (plan) => {
        this.core.conversations.recordWorkflowPlan(run.id, plan)
      },
      recordWorkflowReview: (review) => {
        this.core.conversations.recordWorkflowReview(run.id, review)
      },
      publish: (patch, progress) => {
        this.core.publish(patch, progress, ownerRef)
      },
      observeNormalizedDelta: (fact, archived) => {
        this.core.observeNormalizedDelta(ownerRef, fact, archived)
      },
      markInjectedCutoffs,
      reconcileCompletedCollaboration: (receipt) => {
        this.reconcileOwnedCompletedCollaboration(run.id, receipt)
      },
      observeUncertainEffects: () => {
        this.core.workspaceChanges?.observeUncertainEffects(run.id)
      },
      onCodexTitleUpdated: () => {
        const binding = this.core.conversations.nativeContext(run.sessionId, 'codex')
        if (binding?.nativeSessionId) {
          this.core.interactions.observeNativeTitle(
            run.sessionId,
            adapter,
            binding.nativeSessionId,
            run.bindingGeneration ?? 1,
          )
        }
      },
      onSessionStartedOrTitleUpdated: () => {
        this.core.interactions.scheduleNativeTitleSync(run.sessionId)
      },
    })

    const owner: NativeObservation = {
      generation,
      adapter,
      archiver,
      foregroundExited: false,
      observationController: new AbortController(),
      backgroundReportTasks: new Set(),
    }
    ownerRef = owner
    this.core.nativeObservations.set(run.id, owner)
    owner.streamTrace = this.core.createStreamTrace(run, owner)
    execution.streamBuffer = archiver.foregroundBuffer
    execution.lastArchiver = archiver

    const closingObservation = (): NativeObservation['shutdown'] => {
      const shutdown = owner.shutdown
      if (
        !this.core.disposed ||
        !shutdown ||
        Date.now() >= shutdown.deadlineAt ||
        this.core.nativeObservations.get(run.id) !== owner ||
        owner.adapter !== adapter ||
        !this.core.adapterOwnsExecutor(adapter, shutdown.executorId)
      ) {
        return undefined
      }
      const saved = this.core.conversations.findRun(run.id)
      const closingContext = this.core.conversations.nativeContext(run.sessionId, run.agentId)
      return saved &&
        saved.controlDisposition !== 'abandoned' &&
        saved.executorId === shutdown.executorId &&
        saved.nativeSessionId === shutdown.nativeSessionId &&
        saved.nativeTurnId === shutdown.nativeTurnId &&
        saved.bindingGeneration === shutdown.bindingGeneration &&
        closingContext?.lastRunId === run.id &&
        closingContext.nativeSessionId === shutdown.nativeSessionId &&
        closingContext.bindingGeneration === shutdown.bindingGeneration
        ? shutdown
        : undefined
    }

    let enteredNativeAdapter = false
    let runDeliveryPossible = false

    const release = (): void => {
      if (
        !stillOwned() ||
        !owner.foregroundExited ||
        adapter.hasActiveBackgroundWork?.(run.id) ||
        (owner.backgroundReportTasks?.size ?? 0) > 0
      )
        return
      if (archiver.archiveTail) {
        void archiver.archiveTail.then(release, release)
        return
      }
      if (
        ['starting', 'running', 'recovering'].includes(
          this.core.conversations.findRun(run.id)?.status ?? '',
        )
      ) {
        return
      }
      archiver.flush()
      const disposedOk = archiver.dispose()
      const unrecordedFailure =
        archiver.failureRecordingError ?? owner.backgroundReportRecordingError
      if (!disposedOk || archiver.outputFailure || unrecordedFailure !== undefined) {
        this.core.workspaceChanges?.observeUncertainEffects(run.id)
      }
      if (unrecordedFailure !== undefined) {
        this.core.recordUnrecordedArchiveFailure(run.id, run.sessionId, unrecordedFailure)
        recordDiagnostic({
          operation: 'native_check',
          phase: 'failed',
          level: 'warn',
          scope: 'run',
          sessionId: run.sessionId,
          runId: run.id,
          agentId: run.agentId,
          runtimeBoundary: 'archive',
          code: classifyAgentError(unrecordedFailure).kind,
        })
      }
      owner.observationController.abort()
      this.settleOrphanedPendingEffects(run.id, enteredNativeAdapter || runDeliveryPossible)
      this.core.retireStreamTrace(owner, archiver.foregroundBuffer)
      owner.sourceReader?.retire()
      this.core.recovery.clearBackgroundStop(owner)
      this.core.nativeObservations.delete(run.id)
      void this.finalizeWorkspaceChanges(run.id).catch(() => undefined)
    }
    owner.release = release

    const interactionOwner = () => ({
      id: run.id,
      sessionId: run.sessionId,
      agentId: run.agentId,
      bindingGeneration: run.bindingGeneration ?? 1,
      executorId: this.core.conversations.findRun(run.id)?.executorId ?? adapter.executorId,
      valid: () =>
        stillOwned() && (currentControl() || Boolean(adapter.hasActiveBackgroundWork?.(run.id))),
    })

    try {
      const frozenAuthorization = this.core.conversations.collaborationTurnAuthorization(run.id)
      if (
        frozenAuthorization?.replyIntentBasis?.kind === 'ask_only' &&
        frozenAuthorization.stage !== 'reply'
      ) {
        throw new AgentExecutionError(
          'protocol_error',
          'Persisted ask-only authorization requires a read-only reply stage and cannot be dispatched.',
          false,
        )
      }
      this.core.publish(this.core.conversations.updateAttempt(run.id, 1, false))
      const frozenWorkflow = this.core.conversations.collaboration(run.sessionId, run.id, false)
      promptEnvelope.collaboration = frozenWorkflow
        ? this.core.conversations.collaborationPromptState(frozenWorkflow)
        : undefined
      promptEnvelope.collaborationAuthorization = frozenAuthorization
      const originalInputBatch = this.core.conversations.inputBatchForRun(run.id)
      promptEnvelope.inputBatchRef = originalInputBatch ?? promptEnvelope.inputBatchRef
      promptEnvelope.requiredInputScopeRef =
        promptEnvelope.collaborationAuthorization?.sourceManifestRef ?? undefined
      if (!run.reexecutedFromRunId) {
        this.core.contextBroker.inlineCurrentComments(promptEnvelope, {
          sessionId: run.sessionId,
          runId: run.id,
          batchId: promptEnvelope.inputBatchRef?.id,
        })
        this.core.contextBroker.attachPlanSummary(promptEnvelope, run.sessionId, run.id)
      }
      const runSession = this.core.sessions.find(run.sessionId)
      const authorizedCutoffIds = this.core.sendAndSteer.authorizedCutoffsForEnvelope(
        run,
        promptEnvelope,
        Boolean(runSession?.parentSessionId),
      )
      injectedCutoffIds = this.core.sendAndSteer.attachCutoffSupplement(
        run.sessionId,
        run.agentId,
        run.bindingGeneration ?? 1,
        promptEnvelope,
        authorizedCutoffIds,
      )
      promptEnvelope.sourceGrant =
        promptEnvelope.collaboration ||
        promptEnvelope.inputBatchRef ||
        promptEnvelope.handoffContext?.some((source) => source.inputBatchRef) ||
        Boolean(promptEnvelope.handoffSpine?.length) ||
        Boolean(promptEnvelope.handoffImages?.length) ||
        authorizedCutoffIds.length > 0
          ? { runId: run.id, grant: generation }
          : undefined
      if (promptEnvelope.sourceGrant) {
        owner.sourceReader = new FrozenSourceReader(
          promptEnvelope.sourceGrant,
          run.sessionId,
          this.core.conversations,
          () => stillOwned() && !signal.aborted && this.ownsFrozenSourceRoot(run),
          () => execution.promptEnvelope?.inputBatchRef?.id ?? promptEnvelope.inputBatchRef?.id,
          (error) => {
            recordDiagnostic({
              operation: 'native_check',
              phase: 'failed',
              level: 'warn',
              scope: 'run',
              sessionId: run.sessionId,
              runId: run.id,
              agentId: run.agentId,
              runtimeBoundary: 'source_read',
              code: classifyAgentError(error).kind,
              runtimeErrorType:
                diagnosticEventSchema.shape.runtimeErrorType.safeParse(
                  error instanceof Error ? error.name : 'other',
                ).data ?? 'other',
            })
          },
          signal,
          originalInputBatch?.id,
          authorizedCutoffIds,
        )
      }
      execution.promptEnvelope = promptEnvelope
      adapter.preflightPrompt?.({
        runId: run.id,
        sessionId: run.sessionId,
        cwd,
        promptEnvelope,
        ...(context?.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        permissionMode: run.permissionMode,
        peerAssistanceAllowed,
        model: run.model,
        effort: run.effort,
        speed: run.speed ?? 'native',
      })
      const titleSource = runSession?.titleSource
      if (
        (titleSource === 'placeholder' || titleSource === 'local') &&
        !this.core.conversations.forkOperation(run.sessionId)
      ) {
        promptEnvelope.requestSessionTitle = true
      }
      if (promptEnvelope.collaboration && !promptEnvelope.collaborationBasis) {
        promptEnvelope.collaborationBasis = await this.core.sendAndSteer.collaborationBasis(
          promptEnvelope.collaboration,
          promptEnvelope.message.id,
          signal,
        )
      }
      promptEnvelope.targetAgentId = run.agentId
      let recovery: RunRecoveryPort | undefined
      const schedulingSettings = this.core.conversations.schedulingSettings()
      if (schedulingSettings.enabled) {
        let captureMemory: ReturnType<NativeWorkingMemory['reserve']> | undefined
        try {
          captureMemory = new NativeWorkingMemory().reserve(8 * 1024 * 1024 + 128 * 1024)
          const captured = await this.core.conversations.captureExecutionInput({
            runId: run.id,
            nativeGeneration: generation,
            requested: {
              provider: run.agentId,
              model: settings.agents[run.agentId].model,
              effort: settings.agents[run.agentId].effort,
              speed: run.speed ?? 'native',
              permissionMode: run.permissionMode ?? 'native',
            },
            source: encodeNativeJsonFrame(pathlessExecutionInput(promptEnvelope), signal),
            signal,
          })
          const original = run.reexecutedFromRunId
            ? this.core.conversations.executionInput(run.reexecutedFromRunId)
            : undefined
          if (captured) {
            recovery = {
              inputSha256: captured.inputSha256,
              ...(original?.effective && original.proof
                ? {
                    expected: {
                      settings: original.effective,
                      executorId: original.proof.executorId,
                      nativeSessionId: original.proof.nativeSessionId,
                    },
                    canDispatch: () =>
                      currentControl() &&
                      !signal.aborted &&
                      !this.core.interactions.pendingNativeInteractions(run.sessionId).length &&
                      this.core.conversations.canDispatchReexecution(run.id),
                  }
                : {}),
              recordEffectiveSettings: (effective, identity) => {
                if (stillOwned()) {
                  this.core.conversations.recordEffectiveExecutionSettings(
                    run.id,
                    generation,
                    effective,
                    identity,
                  )
                }
              },
              recordConfirmedUnsent: (boundary, identity) => {
                if (stillOwned()) {
                  this.core.conversations.recordConfirmedUnsent(
                    run.id,
                    generation,
                    boundary,
                    identity,
                  )
                }
              },
            }
          }
        } catch (error) {
          if (signal.aborted || run.reexecutedFromRunId) throw error
        } finally {
          captureMemory?.release()
        }
      }
      if (run.reexecutedFromRunId && (!recovery?.expected || !recovery.canDispatch?.())) {
        throw new NativeInputWithheldError()
      }

      const host: RunExecutionHost = {
        recovery,
        lifecycle: {
          recordExecutor: (executorId) => {
            if (stillOwned()) {
              recordDiagnostic({
                operation: 'process',
                scope: 'run',
                phase: 'started',
                sessionId: run.sessionId,
                runId: run.id,
                agentId: run.agentId,
                executorId,
              })
              this.core.publish(this.core.conversations.recordExecutor(run.id, executorId))
            }
          },
          observeNativeTitle: (nativeSessionId, logicalTitle) => {
            if (currentControl() && !logicalTitle) {
              this.core.interactions.observeNativeTitle(
                run.sessionId,
                adapter,
                nativeSessionId,
                run.bindingGeneration ?? 1,
              )
              this.core.interactions.scheduleNativeTitleSync(run.sessionId)
            }
          },
          observeNativeDelta: (value) => {
            if (stillOwned()) this.core.observeNativeDelta(owner, value)
          },
          recordDispatch: (phase, nativeId, executorId) => {
            if (phase === 'possibly_sent') {
              try {
                this.core.conversations.assertWorkflowDispatch(run.id)
              } catch {
                throw new NativeInputWithheldError()
              }
            }
            if (stillOwned()) {
              recordDiagnostic({
                operation: 'send',
                scope: 'run',
                phase:
                  phase === 'possibly_sent' || phase === 'accepted'
                    ? 'dispatched'
                    : phase === 'rejected'
                      ? 'blocked'
                      : 'started',
                sessionId: run.sessionId,
                runId: run.id,
                agentId: run.agentId,
                ...(executorId ? { executorId } : {}),
              })
            }
            if (phase === 'possibly_sent' || phase === 'accepted') {
              runDeliveryPossible = true
              if (execution.run.id === run.id) {
                execution.deliveryPossible = true
              }
            }
            if (stillOwned()) {
              this.core.publish(
                this.core.conversations.recordDispatch(run.id, phase, nativeId, executorId),
              )
              if (phase === 'accepted') markInjectedCutoffs()
            }
          },
          recordNativeEvidence: (evidence) => {
            if (this.core.disposed) {
              try {
                const shutdown = closingObservation()
                if (
                  !shutdown ||
                  evidence.kind !== 'ended' ||
                  evidence.source !== 'live_terminal' ||
                  evidence.identity.agentId !== run.agentId ||
                  evidence.identity.sessionId !== run.sessionId ||
                  evidence.identity.runId !== run.id ||
                  evidence.identity.requestId !== run.id ||
                  evidence.identity.nativeSessionId !== shutdown.nativeSessionId ||
                  evidence.identity.nativeTurnId !== shutdown.nativeTurnId ||
                  evidence.identity.executorId !== shutdown.executorId ||
                  evidence.identity.bindingGeneration !== shutdown.bindingGeneration
                ) {
                  return
                }
                this.core.conversations.recordNativeEvidence({
                  kind: evidence.kind,
                  identity: evidence.identity,
                  source: evidence.source,
                  outcome: evidence.outcome,
                })
                shutdown.ended = true
                if (shutdown.drained) {
                  this.core.conversations.recordNativeEffects(
                    run.id,
                    'settled',
                    'native_work_drained',
                  )
                  shutdown.complete()
                }
              } catch {
                if (owner.shutdown) {
                  owner.shutdown.failed = true
                  owner.shutdown.complete()
                }
              }
              return
            }
            if (
              !stillOwned() ||
              evidence.identity.bindingGeneration !== (run.bindingGeneration ?? 1) ||
              evidence.identity.runId !== run.id ||
              (this.core.conversations.findRun(run.id)?.executorId &&
                evidence.identity.executorId !==
                  this.core.conversations.findRun(run.id)?.executorId)
            ) {
              return
            }
            archiver.admitTerminalReceipt(evidence)
          },
          recordInputConsumption: (id, identity) => {
            if (!stillOwned() || !identity.nativeTurnId) return
            archiver.flush()
            const steering = execution.steering
            this.core.publish(
              this.core.conversations.recordQueuedSteerConsumption(
                {
                  runId: run.id,
                  sessionId: run.sessionId,
                  bindingGeneration: run.bindingGeneration ?? 1,
                  nativeSessionId: identity.nativeSessionId,
                  nativeTurnId: identity.nativeTurnId,
                  executorId: identity.executorId,
                },
                id,
                steering?.inputId === id ? steering.invocation : undefined,
              ),
            )
            this.core.sendAndSteer.refreshExecutionInputScope(execution)
          },
          recordOutputFailure: (error) => {
            if (stillOwned()) archiver.markAborted(error)
          },
          waitForRootOutput: async () => {
            if (stillOwned()) archiver.flush()
            const pending = archiver.archiveTail
            if (pending) await pending
          },
          currentPromptEnvelope: () => execution.promptEnvelope ?? promptEnvelope,
        },
        effects: {
          recordArchivedEvent: (event) => {
            archiver.admitArchiveEventSync(event)
          },
          recordBackgroundReportUnavailable: (value) => {
            if (!stillOwned() || owner.observationController.signal.aborted) return
            const report = nativeBackgroundReportIdentitySchema.parse(value)
            if (
              report.runId !== run.id ||
              report.bindingGeneration !== (run.bindingGeneration ?? 1)
            ) {
              return
            }
            const patch = this.core.conversations.recordBackgroundReportUnavailable(report)
            if (patch) this.core.publish(patch)
          },
          recordBackgroundReport: async (value) => {
            if (!stillOwned() || owner.observationController.signal.aborted) return
            const report = nativeBackgroundReportSchema.parse(value)
            if (
              report.runId !== run.id ||
              report.bindingGeneration !== (run.bindingGeneration ?? 1)
            ) {
              return
            }
            const task = (async () => {
              const recordUnavailableBestEffort = (
                sourceError?: unknown,
              ): { ok: true } | { ok: false; error: unknown } => {
                try {
                  const patch = this.core.conversations.recordBackgroundReportUnavailable(report)
                  if (patch && stillOwned()) this.core.publish(patch)
                  return { ok: true }
                } catch (unavailableError) {
                  if (
                    sourceError instanceof RunOperationConflictError &&
                    unavailableError instanceof RunOperationConflictError
                  ) {
                    return { ok: true }
                  }
                  owner.backgroundReportRecordingError ??= unavailableError
                  this.core.workspaceChanges?.observeUncertainEffects(run.id)
                  this.core.recordUnrecordedArchiveFailure(run.id, run.sessionId, unavailableError)
                  return { ok: false, error: unavailableError }
                }
              }
              try {
                // A-3: Strictly await root answer `archiveTail` BEFORE allocating a background
                // report sequence so background reports never invert ahead of a large root answer.
                if (archiver.archiveTail) {
                  await archiver.archiveTail.catch(() => undefined)
                }
                if (owner.observationController.signal.aborted || !canDrainObservation()) {
                  recordUnavailableBestEffort()
                  return
                }
                const patch = await this.core.conversations.recordBackgroundReport(
                  report,
                  (bodySignal) => RunOutputArchiver.answerParts(report.text, bodySignal),
                  owner.observationController.signal,
                )
                if (patch && stillOwned()) this.core.publish(patch)
              } catch (error) {
                const unavailable = recordUnavailableBestEffort(error)
                if (!this.core.disposed) {
                  recordDiagnostic({
                    operation: 'native_check',
                    phase: 'failed',
                    level: 'warn',
                    scope: 'run',
                    sessionId: run.sessionId,
                    runId: run.id,
                    agentId: run.agentId,
                    runtimeBoundary: 'archive',
                    code: classifyAgentError(error).kind,
                  })
                }
                if (!unavailable.ok && !this.core.disposed && !this.core.drainingForClose) {
                  throw unavailable.error
                }
              }
            })()
            owner.backgroundReportTasks?.add(task)
            try {
              await task
            } finally {
              owner.backgroundReportTasks?.delete(task)
              if (owner.foregroundExited) owner.release?.()
            }
          },
          anchorFileBeforeEdit: async (path, ioSignal) => {
            if (!stillOwned()) return
            await this.core.workspaceChanges?.anchorBeforeFirstTouch(run.id, path, ioSignal)
          },
          recordFileChange: async (change, ioSignal) => {
            if (!stillOwned()) return
            await this.core.workspaceChanges?.record(run.id, change, ioSignal)
            const updated = this.core.conversations.findRun(run.id)
            const recorded = this.core.workspaceChanges?.summary(run.id)
            if (
              stillOwned() &&
              updated?.dispatchPhase === 'ended' &&
              recorded &&
              recorded.fileCount > 0
            ) {
              this.core.publish(this.core.conversations.recordWorkspaceChanges(recorded))
            }
          },
          recordUncertainEffects: (reason, scope) => {
            if (!stillOwned()) return
            if (scope === 'recorded_files') {
              this.core.workspaceChanges?.uncertain(run.id, reason)
            } else {
              this.core.workspaceChanges?.observeUncertainEffects(run.id)
            }
          },
          backgroundWorkChanged: () => {
            if (stillOwned()) {
              this.core.publish(this.core.conversations.metadataPatch(run.sessionId))
            }
          },
          reportNativeEffects: (report) => {
            if (this.core.disposed) {
              try {
                const shutdown = closingObservation()
                if (
                  !shutdown ||
                  report.runId !== run.id ||
                  report.generation !== generation ||
                  report.state !== 'settled' ||
                  report.reason !== 'native_work_drained'
                ) {
                  return
                }
                shutdown.drained = true
                if (shutdown.ended) {
                  this.core.conversations.recordNativeEffects(run.id, report.state, report.reason)
                  shutdown.complete()
                }
              } catch {
                if (owner.shutdown) {
                  owner.shutdown.failed = true
                  owner.shutdown.complete()
                }
              }
              return
            }
            if (!stillOwned() || report.runId !== run.id || report.generation !== generation) return
            // A-4: When `recordOutputFailure` failed to persist into SQLite (`failureRecordingError`),
            // retry recording it before settling effects; if it still cannot persist, converge to `unknown`
            // so SQLite never shows clean `settled` with zero persistence-failure evidence.
            let effectiveState = report.state
            let effectiveReason = report.reason
            if (report.state === 'settled') {
              if (owner.archiver.failureRecordingError !== undefined) {
                try {
                  const failure =
                    owner.archiver.outputFailure ??
                    classifyAgentError(owner.archiver.failureRecordingError)
                  this.core.publish(this.core.conversations.recordOutputFailure(run.id, failure))
                  if (this.core.conversations.findRun(run.id)?.dispatchPhase === 'ended') {
                    this.core.publish(
                      this.core.conversations.settleKnownNativeEnding(run.id, failure),
                    )
                  }
                  owner.archiver.clearFailureRecordingError()
                  if (owner.backgroundReportRecordingError === undefined) {
                    this.core.unrecordedArchiveFailures.delete(run.id)
                  }
                } catch {
                  effectiveState = 'unknown'
                  effectiveReason =
                    owner.archiver.outputFailure?.message ??
                    'Output archive failure could not be recorded before native effects settled.'
                }
              }
              if (owner.backgroundReportRecordingError !== undefined) {
                effectiveState = 'unknown'
                effectiveReason =
                  'Background report failure could not be recorded before native effects settled.'
              }
            }
            if (owner.backgroundStop && effectiveState !== 'pending') {
              this.core.recovery.clearBackgroundStop(owner)
              if (effectiveState === 'unknown') owner.backgroundStopUnconfirmed = true
            }
            this.core.publish(
              this.core.conversations.recordNativeEffects(run.id, effectiveState, effectiveReason),
            )
            if (effectiveState === 'unknown') {
              this.core.workspaceChanges?.observeUncertainEffects(run.id)
              const queued = this.core.conversations.receivedCollaborationInput(run.sessionId)
              if (
                queued &&
                (queued.anchorRunId === run.id ||
                  this.core.gate.isCurrentBackground(this.core.conversations.findRun(run.id)!)) &&
                !queued.taskId &&
                queued.queueState === 'queued'
              ) {
                this.core.publish(
                  this.core.conversations.pauseConversationQueue(
                    run.sessionId,
                    'Background work could not be confirmed. Check its state before resuming, or edit or remove the queued message.',
                  ),
                )
              }
            }
            if (effectiveState !== 'pending') {
              const saved = this.core.conversations.findRun(run.id)
              if (
                effectiveState === 'settled' &&
                effectiveReason === 'workflow_input_withheld' &&
                saved &&
                !saved.nativeTurnId &&
                !saved.nativeOutcome &&
                ['not_sent', 'rejected'].includes(saved.dispatchPhase ?? '') &&
                this.core.conversations.ownsNativeControl(run.id)
              ) {
                this.core.publish(
                  this.core.conversations.setContinuation(
                    run.sessionId,
                    run.agentId,
                    'ready',
                    undefined,
                    run.bindingGeneration,
                  ),
                )
              }
              const settled = this.core.conversations.reconcileCompletedCollaboration(run.id)
              if (settled) this.core.publish(settled)
              release()
              this.core.collaboration.schedulePendingRoutedContinuations()
            }
          },
        },
        workflow: {
          sourceReader: owner.sourceReader,
          getPlanCheckpoint: (nativeSessionId) =>
            stillOwned()
              ? this.core.conversations.workflowPlanCheckpoint(run.id, nativeSessionId)
              : undefined,
          recordPlan: (plan) => {
            if (stillOwned()) this.core.conversations.recordWorkflowPlan(run.id, plan)
          },
          recordOpenPlanFinalIntent: (intent) => {
            if (!stillOwned()) {
              throw new RunOperationConflictError(
                'This open-mode run is no longer owned; plan publish intent was rejected.',
              )
            }
            const committed = this.core.conversations.recordOpenPlanFinalIntent(run.id, intent)
            if (committed === undefined) {
              throw new RunOperationConflictError(
                'Failed to persist open-mode plan publish intent for this run.',
              )
            }
            return true
          },
          recordPlanRetained: (plan) => {
            if (stillOwned()) this.core.conversations.recordWorkflowPlanRetained(run.id, plan)
          },
          recordPlanUnavailable: () => {
            if (stillOwned()) this.core.conversations.recordWorkflowPlanUnavailable(run.id)
          },
          recordReview: (verdict) => {
            if (stillOwned()) this.core.conversations.recordWorkflowReview(run.id, verdict)
          },
          recordInputResult: (outcome) => {
            if (stillOwned()) this.core.conversations.recordWorkflowInputResult(run.id, outcome)
          },
        },
        interactions: {
          requestPermission: (request, ioSignal) =>
            this.core.interactions.requestNativePermission(interactionOwner(), request, ioSignal),
          requestUserInput: (request, ioSignal) =>
            this.core.interactions.requestNativeUserInput(interactionOwner(), request, ioSignal),
        },
      }

      const runInput: AgentRunInput = {
        host,
        runId: run.id,
        sessionId: run.sessionId,
        permissionMode: run.permissionMode,
        ...(context?.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        nativeGeneration: generation,
        bindingGeneration: run.bindingGeneration ?? 1,
        peerAssistanceAllowed,
        cwd,
        promptEnvelope,
        model: settings.agents[run.agentId].model,
        effort: settings.agents[run.agentId].effort,
        speed: run.speed ?? 'native',
      }

      if (!this.ownsExecution(execution, run.id)) return
      this.core.publish(this.core.conversations.recordNativeEffects(run.id, 'pending'))
      enteredNativeAdapter = true
      execution.enteredNativeAdapter = true

      for await (const event of adapter.run(runInput, signal)) {
        if (this.core.disposed) return
        await archiver.admitEvent(event, 'foreground', signal)
      }

      archiver.foregroundBuffer.flush()
      const saved = this.core.conversations.findRun(run.id)
      recordDiagnostic({
        operation: 'send',
        scope: 'run',
        phase:
          saved?.status === 'completed'
            ? 'completed'
            : saved?.failureKind === 'unknown_delivery'
              ? 'unknown_delivery'
              : 'interrupted',
        sessionId: run.sessionId,
        runId: run.id,
        agentId: run.agentId,
        durationMs: Date.now() - diagnosticStartedAt,
      })
      if (saved?.dispatchPhase !== 'ended') {
        this.core.publish(
          this.core.conversations.observationUnavailable(
            run.id,
            'The native Turn has not supplied a reliable ending. Check its state or rebuild.',
          ),
        )
      } else {
        this.core.publish(this.core.conversations.settleKnownNativeEnding(run.id))
        const settledRun = this.core.conversations.findRun(run.id)
        const titleBinding = this.core.conversations.nativeContext(run.sessionId, run.agentId)
        if (
          settledRun?.status === 'completed' &&
          titleBinding?.nativeSessionId &&
          titleBinding.bindingGeneration === (run.bindingGeneration ?? 1) &&
          currentControl()
        ) {
          if (!archiver.reportedTitle && !run.collaboration) {
            this.core.interactions.scheduleTitleEnrichment(
              adapter,
              run,
              titleBinding.nativeSessionId,
              cwd,
            )
          }
        }
      }
    } catch (error) {
      archiver.foregroundBuffer.flush()
      if (this.core.disposed) return
      const failure = classifyAgentError(error)
      if (
        failure.kind === 'authentication_required' ||
        failure.kind === 'runtime_incompatible' ||
        failure.kind === 'agent_process_crash'
      ) {
        this.core.runtimePreparation.invalidateAgentReadiness(run.agentId)
      }
      if (failure.kind === 'response_too_large') archiver.markAborted(error)
      const saved = this.core.conversations.findRun(run.id)
      // R2-A3: When native terminal `ended` is already durable, defer collaboration settlement
      // until after `archiver.drain()` so an archived completed snapshot is not prematurely
      // locked to `interrupted` or stamped with `pact.output_unavailable`.
      if (saved?.dispatchPhase !== 'ended') {
        this.core.conversations.finishCollaboration(run.id, false, failure.message)
      }
      recordDiagnostic({
        operation: 'send',
        scope: 'run',
        phase: 'failed',
        level: 'warn',
        sessionId: run.sessionId,
        runId: run.id,
        agentId: run.agentId,
        code: failure.kind,
        failureSource: 'classified_error',
        runtimeBoundary: 'foreground',
        runtimeErrorType:
          diagnosticEventSchema.shape.runtimeErrorType.safeParse(
            error instanceof Error ? error.name : 'other',
          ).data ?? 'other',
        durationMs: Date.now() - diagnosticStartedAt,
      })
      if (!enteredNativeAdapter && (execution.cancelledByUser || saved?.status === 'interrupted')) {
        if (saved?.nativeEffectsState === 'pending') {
          this.core.publish(
            this.core.conversations.recordNativeEffects(
              run.id,
              'not_dispatched',
              'stopped_before_native_dispatch',
            ),
          )
        }
        return
      }
      if (saved?.dispatchPhase === 'ended') {
        try {
          await archiver.drain()
        } catch {
          // Output archive failure is already latched on `archiver`.
        }
        const drainedSaved = this.core.conversations.findRun(run.id)
        const completedWithAnswer =
          drainedSaved?.nativeOutcome === 'completed' &&
          !archiver.outputFailure &&
          this.core.conversations.hasCompleteResponse(run.id)
        this.core.publish(
          completedWithAnswer
            ? this.core.conversations.settleKnownNativeEnding(run.id)
            : this.core.conversations.settleKnownNativeEnding(
                run.id,
                archiver.outputFailure ?? failure,
              ),
        )
        const completedReceipt = archiver.completedNativeReceipt
        if (completedReceipt) {
          this.reconcileOwnedCompletedCollaboration(run.id, completedReceipt)
        }
      } else if (saved?.dispatchPhase === 'rejected' || saved?.dispatchPhase === 'not_sent') {
        this.core.publish(
          this.core.conversations.failRun(run.id, failure.kind, failure.message, false),
        )
        const currentContext = this.core.conversations.nativeContext(run.sessionId, run.agentId)
        const unsentProof = this.core.conversations.executionInput(run.id)?.proof
        const unsentReadyQuotaOrAuthRejection = Boolean(
          context?.continuationState === 'ready' &&
          currentContext &&
          currentContext.nativeSessionId === context.nativeSessionId &&
          currentContext.bindingGeneration === context.bindingGeneration &&
          (!runDeliveryPossible || saved.dispatchPhase === 'rejected') &&
          !saved.nativeTurnId &&
          !saved.nativeOutcome &&
          (saved.nativeEffectsState === undefined ||
            ['not_dispatched', 'settled'].includes(saved.nativeEffectsState)) &&
          !adapter.hasActiveBackgroundWork?.(run.id) &&
          !this.core.interactions.pendingNativeInteractions(run.sessionId).length &&
          ['authentication_required', 'quota_or_rate_limit'].includes(failure.kind),
        )
        const confirmedUnsentBinding = Boolean(
          unsentReadyQuotaOrAuthRejection ||
          (unsentProof &&
            currentContext &&
            !saved.nativeTurnId &&
            !saved.nativeOutcome &&
            (saved.nativeEffectsState === undefined ||
              ['not_dispatched', 'settled'].includes(saved.nativeEffectsState)) &&
            currentContext.nativeSessionId === unsentProof.nativeSessionId &&
            currentContext.bindingGeneration === unsentProof.bindingGeneration &&
            currentContext.executorId === unsentProof.executorId &&
            this.core.adapterOwnsExecutor(adapter, unsentProof.executorId) &&
            !adapter.hasActiveBackgroundWork?.(run.id) &&
            !this.core.interactions.pendingNativeInteractions(run.sessionId).length &&
            ![
              'permission_blocked',
              'runtime_incompatible',
              'context_resume_failed',
              'native_session_occupied',
            ].includes(failure.kind)),
        )
        if (confirmedUnsentBinding) {
          this.core.publish(
            this.core.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'ready',
              undefined,
              run.bindingGeneration,
            ),
          )
        }
        const capacityRefusedBeforeStartup =
          error instanceof NativeCapacityError &&
          saved.dispatchPhase === 'not_sent' &&
          !saved.nativeTurnId &&
          !saved.nativeOutcome &&
          !runDeliveryPossible &&
          !adapter.hasActiveBackgroundWork?.(run.id)
        if (capacityRefusedBeforeStartup) {
          this.core.publish(
            this.core.conversations.recordNativeEffects(
              run.id,
              'not_dispatched',
              'native_capacity_not_started',
            ),
          )
        }
        const unchangedReadyBinding =
          confirmedUnsentBinding ||
          (context?.continuationState === 'ready' &&
            currentContext?.continuationState === 'ready' &&
            currentContext.nativeSessionId === context.nativeSessionId &&
            currentContext.bindingGeneration === context.bindingGeneration &&
            ((error instanceof PermissionModeRejectedError &&
              (!adapter.hasActiveBackgroundWork?.() ||
                (run.agentId === 'claude' &&
                  saved.dispatchPhase === 'rejected' &&
                  !saved.nativeTurnId &&
                  !saved.nativeOutcome &&
                  !runDeliveryPossible))) ||
              capacityRefusedBeforeStartup))
        if (
          error instanceof NativeThreadOccupiedError ||
          error instanceof NativeThreadArchivedError
        ) {
          this.core.publish(
            this.core.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'recovery_required',
              failure.message,
              run.bindingGeneration,
              {
                kind: failure.kind,
                message: safeNativePermissionText(failure.message, 1024),
                action: 'rebuild',
              },
            ),
          )
        } else if (failure.kind === 'context_resume_failed') {
          this.core.publish(
            this.core.conversations.markNativeContextsMissing(
              run.sessionId,
              [run.agentId],
              safeNativePermissionText(failure.message, 1024),
            ),
          )
        } else if (!unchangedReadyBinding) {
          this.core.publish(
            this.core.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'recovery_required',
              safeNativePermissionText(failure.message, 240),
              run.bindingGeneration,
              {
                kind: failure.kind,
                message: safeNativePermissionText(failure.message, 1024),
                action: 'retry',
              },
            ),
          )
        }
      } else {
        this.core.workspaceChanges?.observeUncertainEffects(run.id)
        this.core.publish(
          this.core.conversations.observationUnavailable(
            run.id,
            'Pact could not confirm the native Turn. Retry checks it without reexecuting.',
          ),
        )
      }
    } finally {
      archiver.foregroundBuffer.flush()
      owner.foregroundExited = true
      release()
    }
  }
}
