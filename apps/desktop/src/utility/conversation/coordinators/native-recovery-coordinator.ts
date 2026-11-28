import { randomUUID } from 'node:crypto'

import type {
  AgentRun,
  ConversationGetInput,
  ConversationPage,
  ConversationPatch,
  ConversationRetryInput,
  ConversationStopInput,
  NativeContextRebuildInput,
  RpcResult,
  RuntimeAgentId,
} from '@pact/contracts'
import type { ConversationRepository } from '@pact/persistence'

import {
  createRunStopAbortReason,
  type AgentAdapter,
  type AgentNativeCheckContext,
  type AgentNativeCheckOperation,
} from '@pact/agent-runtime'
import { NATIVE_PERMISSION_REQUESTS } from '@pact/contracts'
import {
  HANDOFF_READ_DEADLINE_MS,
  HANDOFF_SAFETY_BYTES,
  HandoffTooLargeError,
  RunOperationConflictError,
} from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { ActiveNativeRebuild, NativeObservation } from '../conversation-types'

import { AgentExecutionError, classifyAgentError } from '../agent-execution-error'
import { isVerifiedAgyRebuildWitness } from '../agy/native-storage-client'
import {
  BACKGROUND_STOP_TIMEOUT_MS,
  DELIVERY_RECONCILIATION_TIMEOUT_MS,
  MAX_AGENT_OPERATIONS,
} from '../conversation-types'
import { safeNativePermissionText } from '../native-permission-wait'

export class NativeRecoveryCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  private pauseSessionForStop(
    sessionId: string,
    queueReason = 'The execution was stopped. Resume the queued message when ready.',
  ): void {
    this.core.conversations.cancelSchedulingRecoveryFaults(sessionId)
    if (this.core.conversations.pausePreparedInputForStop(sessionId))
      this.core.publish(this.core.conversations.metadataPatch(sessionId, { draftsChanged: true }))
    for (const [key, check] of this.core.nativeChecks)
      if (check.automaticAttemptId && key.startsWith(`${sessionId}:`)) check.controller.abort()
    if (this.core.conversations.receivedCollaborationInput(sessionId))
      this.core.publish(this.core.conversations.pauseConversationQueue(sessionId, queueReason))
    this.core.conversations.pauseCollaboration(sessionId, 'stopped')
    this.core.collaboration.abortPreparedWorkflow(sessionId)
  }

  clearBackgroundStop(owner: NativeObservation): void {
    if (!owner.backgroundStop) return
    clearTimeout(owner.backgroundStop.deadline)
    owner.backgroundStop.controller.abort()
    owner.backgroundStop = undefined
  }

  private stopBackground(
    sessionId: string,
    target: NonNullable<ConversationStopInput['background']>,
  ): RpcResult<ConversationPatch> {
    const { runId, executorId } = target
    const run = this.core.conversations.findRun(runId)
    const owner =
      run?.sessionId === sessionId &&
      run.bindingGeneration === target.bindingGeneration &&
      run.nativeSessionId === target.nativeSessionId &&
      run.executorId === executorId
        ? this.core.gate.ownedBackground(run)
        : undefined
    if (owner?.backgroundStop) return this.core.recoveryResult(sessionId)
    if (
      !run ||
      !owner ||
      owner.backgroundStopUnconfirmed ||
      run.nativeEffectsState !== 'pending' ||
      !owner.adapter.stopBackgroundWork ||
      owner.adapter.backgroundWork?.(runId, executorId) !== 'stoppable'
    )
      throw new RunOperationConflictError(
        'The original background work is no longer available to stop.',
      )

    this.pauseSessionForStop(sessionId, '')
    this.core.publish(this.core.conversations.cancelPendingRoutedContinuation(sessionId))
    const controller = new AbortController()
    const unconfirmed = (): void => {
      if (this.core.disposed || owner.backgroundStop?.controller !== controller) return
      this.clearBackgroundStop(owner)
      owner.backgroundStopUnconfirmed = true
      this.core.publish(this.core.conversations.metadataPatch(sessionId))
    }
    owner.backgroundStop = {
      controller,
      deadline: setTimeout(unconfirmed, BACKGROUND_STOP_TIMEOUT_MS),
    }
    const result = this.core.recoveryResult(sessionId)
    // The RPC acknowledges this request. Only the existing native effects owner
    // can confirm that work has ended and clear the stopping projection.
    void owner.adapter.stopBackgroundWork(runId, executorId, controller.signal).catch(unconfirmed)
    return result
  }

  stop(input: ConversationStopInput): RpcResult<ConversationPatch> {
    if (this.core.disposed) return this.core.shuttingDown()
    try {
      if (input.background) return this.stopBackground(input.sessionId, input.background)
      this.pauseSessionForStop(input.sessionId)
      const execution = this.core.activeExecutions.get(input.sessionId)
      const continuation = this.core.preparingContinuations.get(input.sessionId)
      const preparingSend = [...this.core.preparingSends.values()].find(
        (entry) => entry.input.sessionId === input.sessionId,
      )
      if (execution) {
        const beforeStop = this.core.conversations.findRun(execution.run.id)
        const activeRunStatus = Boolean(
          beforeStop && ['starting', 'running', 'recovering'].includes(beforeStop.status),
        )
        // Option 1 intent boundary: if a verified native `completed` terminal already committed
        // BEFORE Stop arrived while this Run is still draining its own body, keep `completed`
        // and let it finish while pausing queue, collaboration, and follow-up `@all` routing.
        if (
          activeRunStatus &&
          beforeStop?.dispatchPhase === 'ended' &&
          beforeStop.nativeOutcome === 'completed'
        ) {
          const patch = this.core.conversations.cancelPendingRoutedContinuation(input.sessionId)
          this.core.publish(patch)
          return { ok: true, value: patch }
        }
        // When `beforeStop` is already terminal (e.g., Primary completed and `@all` is preparing
        // its Secondary continuation), cancel only `continuationAbortController` when active so an
        // already-completed Primary with live background work is not disrupted.
        if (!activeRunStatus) {
          execution.cancelledByUser = true
          if (execution.continuationAbortController) {
            execution.continuationAbortController.abort(createRunStopAbortReason('user_stop'))
          } else {
            execution.abortController.abort(createRunStopAbortReason('user_stop'))
          }
          const patch = this.core.conversations.cancelPendingRoutedContinuation(input.sessionId)
          this.core.publish(patch)
          return { ok: true, value: patch }
        }
        // Freeze foreground output synchronously so every Delta already accepted by Pact
        // crosses the durable checkpoint before the provider is interrupted; late post-Stop
        // display deltas are suppressed while terminal receipts still converge cleanly.
        let streamSaved = true
        try {
          streamSaved = execution.lastArchiver
            ? execution.lastArchiver.freezeForeground()
            : (execution.streamBuffer?.dispose() ?? true)
        } finally {
          execution.streamBuffer = undefined
          execution.adapter = undefined
          execution.cancelledByUser = true
          // Synchronously aborts every root-owned foreground interaction via its exact ioSignal
          // while preserving independent Codex sub-turn interactions on their background signal.
          execution.abortController.abort(createRunStopAbortReason('user_stop'))
        }
        const current = this.core.conversations.findRun(execution.run.id)
        if (!streamSaved) {
          if (current && ['starting', 'running', 'recovering'].includes(current.status)) {
            const outputFailure = execution.lastArchiver?.outputFailure
            try {
              const failedPatch = this.core.conversations.failRun(
                current.id,
                outputFailure?.kind ?? 'protocol_error',
                outputFailure?.message ??
                  'The response stopped, but its latest output could not be saved.',
                true,
                { userStopped: true },
              )
              this.core.publish(failedPatch)
            } catch (error) {
              if (!(error instanceof RunOperationConflictError)) throw error
            }
          }
          return {
            ok: false,
            error: {
              code: 'INTERNAL',
              message: 'The response stopped, but its latest output could not be saved.',
            },
          }
        }
        let patch: ConversationPatch
        if (
          current &&
          ['starting', 'running', 'recovering'].includes(current.status) &&
          !(current.dispatchPhase === 'ended' && current.nativeOutcome === 'completed')
        ) {
          try {
            patch = this.core.conversations.failRun(
              current.id,
              'user_stopped',
              'Stopped by the user.',
              true,
            )
          } catch (error) {
            if (!(error instanceof RunOperationConflictError)) throw error
            patch = this.core.conversations.cancelPendingRoutedContinuation(input.sessionId)
          }
        } else {
          patch = this.core.conversations.cancelPendingRoutedContinuation(input.sessionId)
        }
        this.core.publish(patch)
        return { ok: true, value: patch }
      }
      if (continuation) continuation.controller.abort()
      if (preparingSend) preparingSend.controller.abort()
      this.core.routingOpenInputs.get(input.sessionId)?.abort()
      if (
        this.core.conversations
          .nativeContexts(input.sessionId)
          .some(
            (context) =>
              context.continuationState === 'responding' ||
              context.continuationState === 'waiting_user',
          )
      )
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'Pact has no foreground Stop handle for this native task. Check its state or explicitly rebuild; it was not stopped.',
          },
        }
      const patch = this.core.conversations.cancelPendingRoutedContinuation(input.sessionId)
      this.core.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof RunOperationConflictError ? 'CONFLICT' : 'INTERNAL',
          message: error instanceof Error ? error.message : 'The Run could not be stopped.',
        },
      }
    }
  }

  async retry(input: ConversationRetryInput): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    const original = this.core.conversations.findRun(input.runId)
    if (original?.forkSourceRunId)
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Inherited native actions are read-only.' },
      }
    const sessionId = input.sessionId ?? original?.sessionId
    const agentId = input.agentId ?? original?.agentId
    if (!sessionId || !agentId)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'The native binding is unavailable.' },
      }
    if (
      (original && (original.sessionId !== sessionId || original.agentId !== agentId)) ||
      (!original && input.runId !== sessionId)
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This Check does not match its original execution.' },
      }
    const binding = this.core.conversations.nativeContext(sessionId, agentId)
    const receiptCheck =
      original && this.core.nativeChecks.get(`${sessionId}:${agentId}:${original.id}`)
    if (receiptCheck?.receiptSessionId)
      return receiptCheck.physicalCompletion.then(() => this.retry(input))
    if (
      original &&
      (!binding ||
        original.bindingGeneration !== binding.bindingGeneration ||
        original.nativeSessionId !== binding.nativeSessionId ||
        !this.core.conversations.isCurrentBackgroundCursor(original.id))
    )
      return this.inspectPreviousRun(original)
    // The first cold Check may establish the root ending. Keep its exact owner
    // so that the result can expose recovery for still-unconfirmed work.
    const background = original
      ? { runId: original.id, owner: this.core.gate.ownedBackground(original) }
      : undefined
    return this.checkNativeBinding(sessionId, agentId, original?.id, undefined, background)
  }

  scheduleSteerReceiptCheck(
    page: Extract<ConversationPage, { scope: 'messages' }>,
    input: Extract<ConversationGetInput, { scope: 'messages' }>,
  ): void {
    if (
      !this.core.interestedSessionIds.has(page.sessionId) ||
      this.core.disposed ||
      this.core.gate.nativeQuitSealed()
    )
      return
    const intent =
      input.includeHistoricalSource && input.aroundMessageId ? input.aroundMessageId : 'latest'
    const previous = this.core.steerReceiptChecks.get(page.sessionId)
    if (previous && (intent === 'latest' || previous === intent)) return
    const target = page.messages.find((item) => item.message.id === input.aroundMessageId)?.message
      .runId
    const candidates = target
      ? page.runs.filter((run) => run.id === target)
      : page.runs.toReversed()
    const run = candidates.find(
      (entry) =>
        (entry.agentId === 'codex' || entry.agentId === 'agy') &&
        entry.nativeSessionId &&
        entry.nativeTurnId &&
        !entry.forkSourceRunId &&
        !this.core.nativeObservations.has(entry.id) &&
        this.core.conversations.unresolvedSteerInputs(entry.id).length > 0,
    )
    if (!run) return
    // The page RPC never waits for native I/O. A receipt publishes its own bounded resync.
    void this.inspectPreviousRun(run, true)
    if (this.core.nativeChecks.has(`${run.sessionId}:${run.agentId}:${run.id}`))
      this.core.steerReceiptChecks.set(page.sessionId, intent)
  }

  private async probeSteerInputs(
    run: AgentRun,
    adapter: AgentAdapter,
    controller: AbortController,
  ): Promise<void> {
    if (
      (run.agentId !== 'codex' && run.agentId !== 'agy') ||
      run.forkSourceRunId ||
      !run.nativeSessionId ||
      !run.nativeTurnId ||
      !adapter.beginNativeInputsCheck ||
      this.core.nativeObservations.has(run.id)
    )
      return
    const ids = this.core.conversations
      .unresolvedSteerInputs(run.id)
      .flatMap((entry) => (entry.inputId ? [entry.inputId] : []))
    if (!ids.length) return
    const proof = {
      runId: run.id,
      sessionId: run.sessionId,
      nativeSessionId: run.nativeSessionId,
      nativeTurnId: run.nativeTurnId,
      bindingGeneration: run.bindingGeneration ?? 1,
      executorId: run.executorId,
    }
    await this.runNativeCheck(
      controller,
      (checkContext, checkSignal) =>
        adapter.beginNativeInputsCheck!(
          {
            ...proof,
            requestId: run.id,
            agentId: run.agentId,
            cwd: this.core.projects.find(this.core.sessions.find(run.sessionId)!.projectId)!
              .directoryPath,
            model: run.model,
            effort: run.effort,
            unresolvedInputIds: ids,
            recordConsumption: (id) => {
              if (this.core.disposed || checkSignal.aborted || !ids.includes(id)) return
              this.core.publish(this.core.conversations.recordQueuedSteerConsumption(proof, id))
            },
          },
          checkSignal,
          checkContext,
        ),
      true,
    )
  }

  inspectPreviousRun(
    run: AgentRun,
    receiptsOnly = false,
    automaticAttemptId?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    const key = `${run.sessionId}:${run.agentId}:${run.id}`
    const pending = this.core.nativeChecks.get(key)
    if (pending)
      return !receiptsOnly && pending.receiptSessionId
        ? pending.physicalCompletion.then(() => this.inspectPreviousRun(run))
        : pending.task
    if (!run.nativeSessionId)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The previous task has no confirmed native identity. The current binding was not changed.',
        },
      })
    if (
      this.core.gate.hasSessionOperation(run.sessionId, false, undefined, true) ||
      this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS
    )
      return Promise.resolve(this.core.capacityFailure())
    const controller = new AbortController()
    return this.startNativeCheck(
      key,
      controller,
      async () => {
        try {
          const session = this.core.sessions.find(run.sessionId),
            project = session && this.core.projects.find(session.projectId)
          if (!session || !project) throw new Error('The project is unavailable.')
          const executable = await this.core.runtimePreparation.findRecoveryExecutable(
            run.agentId,
            controller.signal,
          )
          if (!executable) throw new Error('The native executable is unavailable.')
          const adapter = await this.core.adapterFor(
            run.sessionId,
            run.agentId,
            executable,
            controller.signal,
            project.directoryPath,
            (acquired) => {
              const owner = this.core.nativeChecks.get(key)
              if (owner?.controller !== controller || controller.signal.aborted)
                throw new RunOperationConflictError('The native check is no longer current.')
              owner.adapter = acquired
              this.core.archiveAndQuit.nativeMetadataChanged()
            },
          )
          try {
            await this.probeSteerInputs(run, adapter, controller)
          } catch (error) {
            if (receiptsOnly || controller.signal.aborted) throw error
            // An unavailable input receipt must not suppress independent root inspection.
          }
          if (receiptsOnly)
            return { ok: true, value: this.core.conversations.metadataPatch(run.sessionId) }
          const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeStatusCheck)
              throw new Error('The runtime cannot own a native check.')
            return adapter.beginNativeStatusCheck(
              {
                sessionId: run.sessionId,
                agentId: run.agentId,
                runId: run.id,
                requestId: run.id,
                nativeSessionId: run.nativeSessionId!,
                bindingGeneration: run.bindingGeneration ?? 1,
                ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                nativeInputIds: this.core.conversations.nativeInputIdsForRun(run.id),
                planSource: this.core.conversations.workflowPlanSourceExpected(run.id),
                ...(this.core.conversations.needsWorkflowPlanRecovery(run.id) ||
                this.core.conversations.workflowPlanRecoveryState(run.id)?.recoveryRequired ||
                this.core.conversations.workflowOpenPlanPublishIntents(run.id).length > 0
                  ? { inspectMissingPlan: true }
                  : {}),
                planCheckpoint: this.core.conversations.workflowPlanCheckpoint(
                  run.id,
                  run.nativeSessionId!,
                ),
                ...(run.executorId ? { executorId: run.executorId } : {}),
                cwd: project.directoryPath,
                model: run.model,
                effort: run.effort,
              },
              checkSignal,
              checkContext,
            )
          })
          const archiveTail = this.core.nativeObservations.get(run.id)?.archiver.archiveTail
          if (archiveTail) await archiveTail
          if (!evidence || this.core.disposed || controller.signal.aborted)
            throw new Error('The previous native result could not be checked.')
          this.core.executor.flushRunOutput(run)
          this.core.publish(this.core.conversations.recordNativeEvidence(evidence))
          if ('output' in evidence && evidence.output)
            this.core.publish(
              await this.core.conversations.recordNativeOutputComplete(
                run.id,
                evidence.output,
                controller.signal,
              ),
            )
          if (evidence.kind === 'ended') {
            this.core.publish(this.core.conversations.settleKnownNativeEnding(run.id))
            if (
              evidence.outcome === 'completed' &&
              evidence.output?.completeness === 'complete' &&
              evidence.identity.nativeTurnId
            )
              this.core.executor.reconcileOwnedCompletedCollaboration(run.id, {
                nativeTurnId: evidence.identity.nativeTurnId,
                source: evidence.source,
                ...(evidence.identity.executorId
                  ? { executorId: evidence.identity.executorId }
                  : {}),
              })
          }
          return evidence.kind === 'ended'
            ? { ok: true, value: this.core.conversations.contextPatch(run.sessionId) }
            : {
                ok: false,
                error: {
                  code: 'CONFLICT',
                  message:
                    'The previous native result was not confirmed. The current binding was not changed.',
                },
              }
        } catch {
          return {
            ok: false,
            error: {
              code: 'CONFLICT',
              message:
                'The previous native result could not be checked. The current binding was not changed.',
            },
          }
        }
      },
      { ...(receiptsOnly ? { receiptSessionId: run.sessionId } : {}), automaticAttemptId },
    )
  }

  checkNativeBinding(
    sessionId: string,
    agentId: RuntimeAgentId,
    expectedRunId?: string,
    automaticAttemptId?: string,
    background?: { runId: string; owner?: NativeObservation | undefined },
  ): Promise<RpcResult<ConversationPatch>> {
    const backgroundOwner = background?.owner
    const fork = this.core.conversations.forkOperation(sessionId)
    const forkBinding = this.core.conversations.nativeContext(sessionId, agentId)
    if (
      fork &&
      !this.core.conversations.latestAgentRun(sessionId, agentId) &&
      (!forkBinding || forkBinding.bindingGeneration === 1)
    )
      return this.core.fork
        .forkSession({ action: 'check', sessionId, operationId: fork.id, agentId })
        .then((result) =>
          result.ok
            ? { ok: true, value: this.core.conversations.metadataPatch(sessionId) }
            : result,
        )
    const key = `${sessionId}:${agentId}`
    const pending = this.core.nativeChecks.get(key)
    if (pending)
      return pending.targetRunId === expectedRunId
        ? pending.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'A different native execution is being checked.' },
          })
    if (
      this.core.gate.hasSessionOperation(sessionId, false, undefined, true) ||
      backgroundOwner?.backgroundStop
    )
      return Promise.resolve(this.core.capacityFailure())
    if (this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(this.core.capacityFailure())
    const controller = new AbortController()
    let markLogicalTimeout: (() => void) | undefined
    return this.startNativeCheck(
      key,
      controller,
      async () => {
        const context = this.core.conversations.nativeContext(sessionId, agentId)
        const candidate = context?.lastRunId
          ? this.core.conversations.findRun(context.lastRunId)
          : this.core.conversations.latestAgentRun(sessionId, agentId)
        const run =
          candidate?.bindingGeneration === context?.bindingGeneration &&
          candidate?.nativeSessionId === context?.nativeSessionId
            ? candidate
            : undefined
        if (expectedRunId && run?.id !== expectedRunId)
          return {
            ok: false,
            error: {
              code: 'CONFLICT',
              message: 'The native plan source is no longer the current execution.',
            },
          }
        if (!context)
          return {
            ok: false,
            error: {
              code: 'CONFLICT',
              message:
                'No native identity was confirmed. You can create a replacement without reexecuting the task.',
            },
          }
        const generation = context.bindingGeneration ?? 1
        const currentTarget = (): boolean => {
          const current = this.core.conversations.nativeContext(sessionId, agentId)
          return (
            !this.core.disposed &&
            !controller.signal.aborted &&
            this.core.nativeChecks.get(key)?.controller === controller &&
            current?.bindingGeneration === generation &&
            current.nativeSessionId === context.nativeSessionId &&
            current.lastRunId === context.lastRunId &&
            !this.core.conversations.pendingNativeRebuild(sessionId, agentId) &&
            (!run ||
              context.lastRunId !== run.id ||
              this.core.conversations.isCurrentBackgroundCursor(run.id))
          )
        }
        const changedTarget: RpcResult<ConversationPatch> = {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'The native Check target changed. The current binding was not changed.',
          },
        }
        markLogicalTimeout = () => {
          if (!currentTarget()) return
          const message =
            'Native state check timed out. Cleanup remains pending. No task was reexecuted.'
          this.core.publish(
            this.core.conversations.setContinuation(
              sessionId,
              agentId,
              'recovery_required',
              message,
              generation,
              { kind: 'transient_transport', message, action: 'rebuild' },
            ),
          )
        }
        if (!currentTarget()) return changedTarget
        this.core.publish(
          this.core.conversations.setContinuation(
            sessionId,
            agentId,
            'checking',
            undefined,
            generation,
          ),
        )
        try {
          const session = this.core.sessions.find(sessionId)
          const project = session && this.core.projects.find(session.projectId)
          if (!session || !project) throw new Error('The Session project is unavailable.')
          let adapter = backgroundOwner?.adapter
          if (adapter) {
            const owner = this.core.nativeChecks.get(key)
            if (owner?.controller !== controller)
              throw new RunOperationConflictError('The native check is no longer current.')
            owner.adapter = adapter
          } else {
            const executable = await this.core.runtimePreparation.findRecoveryExecutable(
              agentId,
              controller.signal,
            )
            if (executable === undefined)
              throw new AgentExecutionError(
                'runtime_incompatible',
                'The native executable is unavailable. Restore the executable, then Retry.',
                false,
              )
            adapter = await this.core.adapterFor(
              sessionId,
              agentId,
              executable,
              controller.signal,
              project.directoryPath,
              (acquired) => {
                const owner = this.core.nativeChecks.get(key)
                if (owner?.controller !== controller || controller.signal.aborted)
                  throw new RunOperationConflictError('The native check is no longer current.')
                owner.adapter = acquired
                this.core.archiveAndQuit.nativeMetadataChanged()
              },
            )
          }
          if (run) {
            try {
              await this.probeSteerInputs(run, adapter, controller)
            } catch (error) {
              if (controller.signal.aborted) throw error
              // Receipt availability cannot change the separately checked root outcome.
            }
          }
          const observeCheckedTitle = (nativeSessionId: string, logicalTitle?: string): void => {
            const current = this.core.conversations.nativeContext(sessionId, agentId)
            if (
              !currentTarget() ||
              this.core.adapters.get(key)?.adapter !== adapter ||
              current?.nativeSessionId !== nativeSessionId ||
              current.bindingGeneration !== generation
            )
              return
            if (logicalTitle) {
              // A late first title must follow the same save/priority guard as
              // terminal enrichment before its Native name can be decorated.
              if (!run || !this.core.conversations.ownsNativeControl(run.id)) return
              try {
                this.core.publish(
                  this.core.conversations.applyEvent(sessionId, run.id, {
                    agentId,
                    type: 'session.title.updated',
                    title: logicalTitle,
                  }),
                )
              } catch {
                return // Title I/O cannot turn a reliable Native check into a failure.
              }
            }
            this.core.interactions.observeNativeTitle(
              sessionId,
              adapter,
              nativeSessionId,
              generation,
            )
          }
          if (!run) {
            const initialized = this.core.conversations.confirmedNativeInitialization(
              sessionId,
              agentId,
            )
            if (!initialized || !adapter.beginNativeStatusCheck)
              throw new Error('There is no confirmed current initialization to check.')
            const chunks = this.core.conversations.readNativeRebuildSource(initialized.rebuildId)
            const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) =>
              adapter.beginNativeStatusCheck!(
                {
                  target: 'initialized_binding',
                  resolveImage: (id, _signal) => this.core.resolveRebuildImage(sessionId, id),
                  sessionId,
                  agentId,
                  requestId: initialized.rebuildId,
                  nativeSessionId: initialized.nativeSessionId,
                  bindingGeneration: initialized.bindingGeneration,
                  cwd: project.directoryPath,
                  model: session.settings.agents[agentId].model,
                  effort: session.settings.agents[agentId].effort,
                  confirmedInitialization: {
                    rebuildId: initialized.rebuildId,
                    sourceHash: initialized.sourceHash,
                    ...(initialized.witness ? { witness: initialized.witness } : {}),
                  },
                  source: (async function* () {
                    yield* chunks
                  })(),
                  observeNativeTitle: observeCheckedTitle,
                },
                checkSignal,
                checkContext,
              ),
            )
            if (!evidence || !currentTarget())
              throw new Error('The initialized binding could not be checked.')
            this.core.publish(this.core.conversations.recordNativeEvidence(evidence))
            if (evidence.kind !== 'binding_ready')
              throw new Error('Native initialization readback did not confirm this binding.')
            this.core.interactions.scheduleNativeTitleSync(sessionId)
            return { ok: true, value: this.core.conversations.contextPatch(sessionId) }
          }
          const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeStatusCheck)
              throw new AgentExecutionError(
                'runtime_incompatible',
                'The runtime cannot provide a safe native check. Update the runtime, then Retry.',
                false,
              )
            return adapter.beginNativeStatusCheck(
              {
                sessionId,
                agentId,
                requestId: run?.id ?? sessionId,
                ...(run ? { runId: run.id } : {}),
                nativeSessionId: context.nativeSessionId,
                ...(run?.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                ...(run
                  ? {
                      nativeInputIds: this.core.conversations.nativeInputIdsForRun(run.id),
                      planSource: this.core.conversations.workflowPlanSourceExpected(run.id),
                      planCheckpoint: this.core.conversations.workflowPlanCheckpoint(
                        run.id,
                        context.nativeSessionId,
                      ),
                    }
                  : {}),
                ...(run &&
                (this.core.conversations.needsWorkflowPlanRecovery(run.id) ||
                  this.core.conversations.workflowPlanRecoveryState(run.id)?.recoveryRequired ||
                  this.core.conversations.workflowOpenPlanPublishIntents(run.id).length > 0)
                  ? { inspectMissingPlan: true }
                  : {}),
                bindingGeneration: generation,
                ...(run?.executorId ? { executorId: run.executorId } : {}),
                ...(agentId === 'claude' &&
                run?.dispatchPhase === 'ended' &&
                run.controlDisposition !== 'abandoned' &&
                run.nativeSessionId === context.nativeSessionId &&
                run.bindingGeneration === generation &&
                run.nativeTurnId
                  ? {
                      confirmedTerminal: {
                        kind: 'ended' as const,
                        source: 'stored_terminal' as const,
                        identity: {
                          sessionId,
                          agentId,
                          requestId: run.id,
                          runId: run.id,
                          nativeSessionId: context.nativeSessionId,
                          nativeTurnId: run.nativeTurnId,
                          bindingGeneration: generation,
                          ...(run.executorId ? { executorId: run.executorId } : {}),
                        },
                        ...(run.nativeOutcome ? { outcome: run.nativeOutcome } : {}),
                      },
                    }
                  : {}),
                cwd: project.directoryPath,
                model: session.settings.agents[agentId].model,
                effort: session.settings.agents[agentId].effort,
                observeNativeTitle: observeCheckedTitle,
              },
              checkSignal,
              checkContext,
            )
          })
          if (!evidence || !currentTarget())
            throw new Error('The native check did not return evidence.')
          const archiveTail = run && this.core.nativeObservations.get(run.id)?.archiver.archiveTail
          if (archiveTail) await archiveTail
          if (!currentTarget()) return changedTarget
          if (run) this.core.executor.flushRunOutput(run)
          this.core.publish(this.core.conversations.recordNativeEvidence(evidence))
          if (run && 'output' in evidence && evidence.output) {
            const outputPatch = await this.core.conversations.recordNativeOutputComplete(
              run.id,
              evidence.output,
              controller.signal,
            )
            if (!currentTarget()) return changedTarget
            this.core.publish(outputPatch)
          }
          if (run && evidence.kind === 'ended') {
            this.core.publish(this.core.conversations.settleKnownNativeEnding(run.id))
            if (
              evidence.outcome === 'completed' &&
              evidence.output?.completeness === 'complete' &&
              evidence.identity.nativeTurnId
            )
              this.core.executor.reconcileOwnedCompletedCollaboration(run.id, {
                nativeTurnId: evidence.identity.nativeTurnId,
                source: evidence.source,
                ...(evidence.identity.executorId
                  ? { executorId: evidence.identity.executorId }
                  : {}),
              })
          }
          if (evidence.kind === 'no_evidence' || evidence.kind === 'missing')
            return {
              ok: false,
              error: {
                code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
                message:
                  evidence.kind === 'missing'
                    ? 'The native session is unavailable. Rebuild it to continue.'
                    : 'The native check did not confirm the Turn. You can retry or rebuild; no task was reexecuted.',
              },
            }
          if (background && evidence.kind === 'ended') {
            const checked = this.core.conversations.findRun(background.runId)
            const owned = checked && this.core.gate.ownedBackground(checked)
            if (
              checked &&
              this.core.gate.isCurrentBackground(checked) &&
              (checked.nativeEffectsState === 'pending' ||
                checked.nativeEffectsState === 'unknown') &&
              (owned?.backgroundStopUnconfirmed ||
                owned?.adapter.backgroundWork?.(checked.id, checked.executorId!) !== 'stoppable')
            ) {
              // The check confirmed a root ending, not the old work. Record an
              // explicit recovery choice without changing the effects evidence.
              this.core.publish(
                this.core.conversations.recordNativeEffects(
                  checked.id,
                  checked.nativeEffectsState,
                  'background_check_unconfirmed',
                ),
              )
            }
          }
          this.core.interactions.scheduleNativeTitleSync(sessionId)
          return { ok: true, value: this.core.conversations.contextPatch(sessionId) }
        } catch (error) {
          if (this.core.disposed) return this.core.shuttingDown()
          if (!currentTarget()) return changedTarget
          const classified = classifyAgentError(error)
          if (
            classified.kind === 'authentication_required' ||
            classified.kind === 'runtime_incompatible' ||
            classified.kind === 'agent_process_crash'
          ) {
            this.core.runtimePreparation.invalidateAgentReadiness(agentId)
          }
          const patch = this.core.conversations.setContinuation(
            sessionId,
            agentId,
            'recovery_required',
            safeNativePermissionText(
              `Native state check failed: ${error instanceof Error ? error.message : 'No reliable response.'}`,
              240,
            ),
            generation,
            {
              kind: classified.kind,
              message: safeNativePermissionText(
                error instanceof Error ? error.message : 'No reliable native response.',
                1024,
              ),
              action: [
                'authentication_required',
                'quota_or_rate_limit',
                'permission_blocked',
                'runtime_incompatible',
              ].includes(classified.kind)
                ? 'retry'
                : 'rebuild',
            },
          )
          this.core.publish(patch)
          return {
            ok: false,
            error: {
              code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
              message:
                'The native check did not provide reliable evidence. No task was reexecuted.',
            },
          }
        }
      },
      {
        automaticAttemptId,
        targetRunId: expectedRunId,
        onLogicalTimeout: () => markLogicalTimeout?.(),
      },
    )
  }

  async rebuildNativeContext(
    input: NativeContextRebuildInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (input.intent === 'claim_input' || input.intent === 'discard_input') {
      try {
        if (!input.expectedRebuildId || this.core.gate.hasSessionOperation(input.sessionId))
          throw new RunOperationConflictError(
            'Input recovery is unavailable while this Session is working.',
          )
        const patch =
          input.intent === 'claim_input'
            ? this.core.conversations.claimReturnedInput(
                input.sessionId,
                input.expectedRebuildId,
                input.expectedGeneration ?? 0,
                input.expectedCommentsRevision ?? -1,
              )
            : this.core.conversations.discardReturnedInput(input.sessionId, input.expectedRebuildId)
        this.core.publish(patch)
        return { ok: true, value: patch }
      } catch (error) {
        return this.core.sendFailure(error)
      }
    }
    if (this.core.conversations.forkOperation(input.sessionId)?.ready === false)
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'Confirm the original native fork candidates first. Rebuild cannot replace this fork.',
        },
      }
    if (
      input.intent === 'create' &&
      input.clientOperationId &&
      this.core.conversations.nativeRebuildOperation(input.clientOperationId)
    ) {
      try {
        this.core.conversations.verifyRebuildReceipt(
          input.clientOperationId,
          input.sessionId,
          input.agentId,
          input.expectedRunId,
        )
        return this.core.recoveryResult(input.sessionId)
      } catch (error) {
        return this.core.sendFailure(error)
      }
    }
    const context = this.core.conversations.nativeContext(input.sessionId, input.agentId)
    const currentOperation = this.core.conversations.lastNativeRebuild(
      input.sessionId,
      input.agentId,
    )
    const currentOperationId =
      currentOperation && !['completed', 'superseded'].includes(currentOperation.stage)
        ? currentOperation.id
        : null
    if (
      (input.expectedNativeSessionId !== undefined &&
        context?.nativeSessionId !== input.expectedNativeSessionId) ||
      (input.expectedRunId !== undefined &&
        this.core.conversations.nativeRecoveryRun(input.sessionId, input.agentId)?.id !==
          (input.expectedRunId ?? undefined)) ||
      (input.expectedRebuildId !== undefined && currentOperationId !== input.expectedRebuildId)
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The session changed since this recovery card was shown. Review the refreshed card before continuing.',
        },
      }

    const last = input.clientOperationId
      ? this.core.conversations.nativeRebuildOperation(input.clientOperationId)
      : this.core.conversations.lastNativeRebuild(input.sessionId, input.agentId)
    if (input.intent === 'inspect') {
      if (input.clientOperationId) {
        try {
          this.core.conversations.verifyRebuildReceipt(
            input.clientOperationId,
            input.sessionId,
            input.agentId,
            input.expectedRunId,
          )
          if (
            input.expectedGeneration !== undefined &&
            last?.oldGeneration !== input.expectedGeneration
          )
            throw new RunOperationConflictError(
              'The rebuild confirmation belongs to a different generation.',
            )
        } catch (error) {
          return this.core.sendFailure(error)
        }
      }
      if (last?.stage === 'completed') return this.core.recoveryResult(input.sessionId)
      // Checking an unacknowledged creation never invokes create/resume or a model.
      if (!last?.provisionalNativeSessionId)
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'Native creation returned no identity. It cannot be confirmed by retrying creation. Create another only as a new explicit operation.',
          },
        }
      return this.checkNativeRebuild(input.sessionId, input.agentId, last)
    }
    if (!input.clientOperationId)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Rebuild requires a confirmation identity.' },
      }
    if (
      this.core.nativeRebuilds.has(input.sessionId) ||
      this.core.preparingSends.size >= MAX_AGENT_OPERATIONS ||
      this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS
    )
      return this.core.capacityFailure()
    if (this.core.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      return {
        ok: false,
        error: {
          code: 'AGENT_CAPACITY',
          message:
            'All 8 native interaction slots are occupied. Rebuild was not started; no native request was cancelled.',
        },
      }
    if (this.core.gate.hasSessionOperation(input.sessionId))
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The current foreground task is still observed. Stop it or check its state first.',
        },
      }
    try {
      const patch = this.core.conversations.beginNativeRebuild({
        id: input.clientOperationId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        expectedGeneration: input.expectedGeneration ?? context?.bindingGeneration ?? 1,
        ...(input.expectedRunId !== undefined ? { expectedRunId: input.expectedRunId } : {}),
        abandon: input.abandon === true,
        ...(input.agentId === 'claude' ? { reservedNativeSessionId: randomUUID() } : {}),
      })
      this.core.publish(patch)
      this.startNativeRebuildOperation(input.sessionId, input.agentId, input.clientOperationId)
      return { ok: true, value: patch }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  startNativeRebuildOperation(sessionId: string, agentId: RuntimeAgentId, rebuildId: string): void {
    const rebuild: ActiveNativeRebuild = {
      agentId,
      rebuildId,
      abortController: new AbortController(),
    }
    this.core.nativeRebuilds.set(sessionId, rebuild)
    this.core.workspaceChanges?.cancelUndoForNativeSession(sessionId)
    rebuild.completion = this.runNativeContextRebuild(sessionId, rebuild).finally(() => {
      if (this.core.nativeRebuilds.get(sessionId) === rebuild)
        this.core.nativeRebuilds.delete(sessionId)
      if (!this.core.disposed) this.core.publish(this.core.conversations.metadataPatch(sessionId))
    })
  }

  checkNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
    operation: NonNullable<ReturnType<ConversationRepository['nativeRebuildOperation']>>,
    automaticAttemptId?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    const key = `${sessionId}:${agentId}:rebuild`
    const pending = this.core.nativeChecks.get(key)
    if (pending) return pending.task
    if (this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(this.core.capacityFailure())
    if (this.core.gate.hasSessionOperation(sessionId, false, undefined, true))
      return Promise.resolve(this.core.archiveBusy())
    const controller = new AbortController()
    const expectedNativeSessionId = this.core.conversations.nativeContext(
      sessionId,
      agentId,
    )?.nativeSessionId
    return this.startNativeCheck(
      key,
      controller,
      async () => {
        try {
          this.core.conversations.verifyRebuildReceipt(operation.id, sessionId, agentId)
          const session = this.core.sessions.find(sessionId)
          const project = session && this.core.projects.find(session.projectId)
          if (!session || !project) throw new Error('The Session project is unavailable.')
          const executable = await this.core.runtimePreparation.findRecoveryExecutable(
            agentId,
            controller.signal,
          )
          if (!executable) throw new Error('The native executable is unavailable.')
          const adapter = await this.core.adapterFor(
            sessionId,
            agentId,
            executable,
            controller.signal,
            project.directoryPath,
            (acquired) => {
              const owner = this.core.nativeChecks.get(key)
              if (owner?.controller !== controller || controller.signal.aborted)
                throw new RunOperationConflictError('The native check is no longer current.')
              owner.adapter = acquired
              this.core.archiveAndQuit.nativeMetadataChanged()
            },
          )
          const chunks = this.core.conversations.readNativeRebuildSource(operation.id)

          const result = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeRebuildCheck)
              throw new Error('The runtime cannot own candidate inspection.')
            return adapter.beginNativeRebuildCheck(
              {
                rebuildId: operation.id,
                sessionId,
                resolveImage: (id, _signal) => this.core.resolveRebuildImage(sessionId, id),
                cwd: project.directoryPath,
                model: session.settings.agents[agentId].model,
                effort: session.settings.agents[agentId].effort,
                ...(operation.provisionalNativeSessionId
                  ? { nativeSessionId: operation.provisionalNativeSessionId }
                  : {}),
                ...(operation.sourceHash ? { sourceHash: operation.sourceHash } : {}),
              },
              (async function* () {
                yield* chunks
              })(),
              checkSignal,
              checkContext,
            )
          })
          if (controller.signal.aborted) throw new Error('The native check was interrupted.')
          if (this.core.disposed) throw new Error('Pact is shutting down.')
          if (
            !result ||
            (agentId === 'agy' &&
              !isVerifiedAgyRebuildWitness(
                result.initializationWitness,
                result.nativeSessionId,
                operation.sourceHash ?? undefined,
              ))
          ) {
            this.core.publish(
              this.core.conversations.recordNativeRebuildCheck(
                sessionId,
                agentId,
                operation,
                expectedNativeSessionId,
              ),
            )
            return {
              ok: false,
              error: {
                code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
                message: 'Pact couldn’t confirm the new session.',
              },
            }
          }
          const patch = this.core.conversations.completeNativeRebuild(
            operation.id,
            result.nativeSessionId,
            adapter.executorId,
            result.initializationWitness,
          )
          this.core.executor.retireChangedSourceGrants(sessionId, agentId)
          for (const interaction of this.core.permissions.values())
            if (interaction.sessionId === sessionId && interaction.agentId === agentId)
              interaction.visible = false
          this.core.publish(patch)
          this.core.interactions.scheduleNativeTitleSync(sessionId)
          return { ok: true, value: patch }
        } catch (error) {
          return this.core.sendFailure(error)
        }
      },
      {
        automaticAttemptId,
        onPhysicalCompletion: () => {
          if (!this.core.disposed) this.core.recoveryResult(sessionId)
        },
      },
    )
  }

  private async runNativeContextRebuild(
    sessionId: string,
    rebuild: ActiveNativeRebuild,
  ): Promise<void> {
    try {
      const prepared = await this.core.prepareSession(sessionId, rebuild.abortController.signal, [
        rebuild.agentId,
      ])
      if (!prepared.ok) throw new Error(prepared.error.message)
      const settings = prepared.value.session.settings.agents[rebuild.agentId]
      // The existing slot owner reserves a compatible Adapter or refuses before native creation.
      const adapter = await this.core.adapterFor(
        sessionId,
        rebuild.agentId,
        prepared.value.executablePaths[rebuild.agentId],
        rebuild.abortController.signal,
        prepared.value.projectDirectory,
      )
      rebuild.adapter = adapter
      this.core.archiveAndQuit.nativeMetadataChanged()
      if (this.core.permissions.size >= NATIVE_PERMISSION_REQUESTS)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'All 8 native interaction slots are occupied. No replacement native session was created.',
          false,
        )
      let dispatchedExecutorId = adapter.executorId
      rebuild.executorId = dispatchedExecutorId
      const chunks: import('@pact/contracts').NativeContextRebuildChunk[] = []
      const sourceRevisions = new Map<string, number>()

      let bytes = 2
      const sourceDeadline = Date.now() + HANDOFF_READ_DEADLINE_MS
      for await (const chunk of this.core.conversations.nativeContextRebuildSource(
        sessionId,
        rebuild.abortController.signal,
        rebuild.rebuildId,
        sourceRevisions,
      )) {
        bytes += Buffer.byteLength(JSON.stringify(chunk)) + 1
        if (chunks.length >= 4096 || bytes > HANDOFF_SAFETY_BYTES || Date.now() > sourceDeadline)
          throw new HandoffTooLargeError(
            'The complete rebuild history exceeds its bounded preparation. It was not shortened.',
          )
        chunks.push(chunk)
      }
      const sourceHash = this.core.conversations.freezeNativeRebuildSource(
        rebuild.rebuildId,
        chunks,
        sourceRevisions,
      )
      sourceRevisions.clear()
      const operation = this.core.conversations.nativeRebuildOperation(rebuild.rebuildId)!
      const current = (): boolean => {
        const saved = this.core.conversations.nativeRebuildOperation(rebuild.rebuildId)
        return (
          !this.core.disposed &&
          saved !== undefined &&
          !['completed', 'failed', 'superseded'].includes(saved.stage) &&
          (this.core.conversations.nativeContext(sessionId, rebuild.agentId)?.bindingGeneration ??
            1) === operation.oldGeneration &&
          (this.core.nativeRebuilds.get(sessionId) === rebuild ||
            adapter.hasActiveBackgroundWork?.(rebuild.rebuildId) === true)
        )
      }
      const owner = () => ({
        id: rebuild.rebuildId,
        sessionId,
        agentId: rebuild.agentId,
        bindingGeneration: operation.oldGeneration + 1,
        executorId: dispatchedExecutorId,
        valid: () => current(),
      })
      const result = await adapter.rebuildNativeContext(
        {
          rebuildId: rebuild.rebuildId,
          sessionId,
          resolveImage: (id, _signal) => this.core.resolveRebuildImage(sessionId, id),
          cwd: prepared.value.projectDirectory,
          model: settings.model,
          effort: settings.effort,
          sourceHash,

          permissionMode: prepared.value.session.settings.permissionModes?.[rebuild.agentId],
          ...(operation.provisionalNativeSessionId
            ? { nativeSessionId: operation.provisionalNativeSessionId }
            : {}),
          onNativeCreationDispatched: async (executorId) => {
            if (!current()) throw new Error('The rebuild creation owner changed.')
            dispatchedExecutorId = executorId
            rebuild.executorId = executorId
            this.core.conversations.markNativeRebuildDispatched(rebuild.rebuildId, executorId)
          },
          onNativeSessionCreated: async (nativeId) => {
            if (!current()) throw new Error('The rebuild acknowledgement owner changed.')
            this.core.conversations.recordNativeRebuildIdentity(rebuild.rebuildId, nativeId)
          },

          reportNativeWork: (report) => {
            dispatchedExecutorId = report.executorId
            rebuild.executorId = report.executorId
            this.core.conversations.recordNativeRebuildWork(
              rebuild.rebuildId,
              report.executorId,
              report.nativeSessionId,
              report.state,
            )
          },
          requestPermission: (request, signal) =>
            this.core.interactions.requestNativePermission(owner(), request, signal),
          requestUserInput: (request, signal) =>
            this.core.interactions.requestNativeUserInput(owner(), request, signal),
        },
        (async function* () {
          yield* chunks
        })(),
        rebuild.abortController.signal,
      )
      if (!current()) return
      if (
        rebuild.agentId === 'agy' &&
        !isVerifiedAgyRebuildWitness(
          result.initializationWitness,
          result.nativeSessionId,
          sourceHash ?? operation.sourceHash ?? undefined,
        )
      ) {
        throw new Error('Antigravity rebuild cold-load receipt could not be confirmed.')
      }
      this.core.publish(
        this.core.conversations.completeNativeRebuild(
          rebuild.rebuildId,
          result.nativeSessionId,
          dispatchedExecutorId,
          result.initializationWitness,
        ),
      )
      this.core.executor.retireChangedSourceGrants(sessionId, rebuild.agentId)
      this.core.interactions.scheduleNativeTitleSync(sessionId)
      // Retire only the UI/control projection. Do not answer or cancel old Native requests.
      for (const pending of this.core.permissions.values())
        if (
          pending.sessionId === sessionId &&
          pending.agentId === rebuild.agentId &&
          pending.operationId !== rebuild.rebuildId
        )
          pending.visible = false
    } catch (error) {
      if (this.core.disposed || this.core.nativeRebuilds.get(sessionId) !== rebuild) return
      this.core.publish(
        this.core.conversations.failNativeRebuild(
          rebuild.rebuildId,
          error instanceof Error ? error.message : 'Native initialization could not be confirmed.',
        ),
      )
    } finally {
      rebuild.adapter = undefined
      this.core.archiveAndQuit.nativeMetadataChanged()
    }
  }

  async resumeAutomaticRecovery(): Promise<void> {
    if (this.core.disposed || this.core.gate.nativeQuitSealed()) return
    for (;;) {
      const candidates = this.core.conversations.takeSchedulingRecoveryFaults()
      if (!candidates.length) return
      for (const { fault, node } of candidates) {
        try {
          const settings = this.core.conversations.schedulingSettings()
          if (
            !settings.enabled ||
            this.core.decisionRuntime ||
            this.core.decisionRecovery ||
            this.core.conversations.activeSchedulingRuntimeOwner() ||
            [...this.core.nativeChecks.keys()].some((key) =>
              key.startsWith(`${node.sessionId}:`),
            ) ||
            this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS ||
            this.core.gate.hasSessionOperation(node.sessionId, false, undefined, true) ||
            this.core.conversations.archives.blocksSession(node.sessionId) ||
            this.core.interactions.pendingNativeInteractions(node.sessionId).length
          )
            continue
          const session = this.core.sessions.find(node.sessionId),
            task = this.core.conversations.collaboration(node.sessionId)
          if (
            !session ||
            session.status === 'archived' ||
            this.core.projects.find(session.projectId)?.archivedAt ||
            (task?.automation === 'paused' && task.pauseReason !== 'failure')
          )
            continue
          const run =
              node.freshnessGuard.runId &&
              this.core.conversations.findRun(node.freshnessGuard.runId),
            binding = this.core.conversations.nativeContext(node.sessionId, fault.agentId)
          if (
            !run ||
            run.forkSourceRunId ||
            run.controlDisposition === 'abandoned' ||
            !run.nativeSessionId ||
            this.core.conversations.latestAgentRun(node.sessionId, fault.agentId)?.id !== run.id ||
            (binding &&
              (binding.bindingGeneration !== run.bindingGeneration ||
                binding.nativeSessionId !== run.nativeSessionId)) ||
            [
              'user_stopped',
              'authentication_required',
              'quota_or_rate_limit',
              'permission_blocked',
              'runtime_incompatible',
            ].includes(run.failureKind ?? '')
          )
            continue
          if (
            fault.faultKind === 'run' &&
            run.dispatchPhase === 'ended' &&
            this.core.conversations.hasCompleteResponse(run.id) &&
            run.nativeEffectsState === 'settled'
          )
            continue
          const generation = this.core.conversations.schedulingConfigurationGeneration()
          if (
            !this.core.conversations.schedulingSettings().enabled ||
            this.core.disposed ||
            this.core.gate.nativeQuitSealed() ||
            this.core.conversations.schedulingConfigurationGeneration() !== generation ||
            this.core.decisionRuntime ||
            this.core.decisionRecovery ||
            this.core.conversations.activeSchedulingRuntimeOwner() ||
            this.core.gate.hasSessionOperation(node.sessionId, false, undefined, true) ||
            this.core.interactions.pendingNativeInteractions(node.sessionId).length ||
            this.core.conversations.archives.blocksSession(node.sessionId)
          )
            continue
          if (
            fault.faultKind === 'run' &&
            !run.reexecutedFromRunId &&
            this.core.conversations.executionInput(run.id)?.proof &&
            ['not_dispatched', 'settled'].includes(run.nativeEffectsState ?? '') &&
            !this.core.gate.hasSessionOperation(node.sessionId, true)
          ) {
            this.core.executor.launchConfirmedUnsentReexecution(fault.id, node)
            continue
          }
          if (
            fault.faultKind === 'run' &&
            ['not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
          )
            continue
          const rebuild =
            fault.faultKind === 'rebuild'
              ? this.core.conversations.nativeRebuildOperation(fault.faultId)
              : undefined
          if (
            fault.faultKind === 'rebuild' &&
            (!rebuild ||
              rebuild.stage !== 'unconfirmed' ||
              !rebuild.provisionalNativeSessionId ||
              !rebuild.sourceHash)
          )
            continue
          const attempt = this.core.conversations.reserveSchedulingRecoveryCheck(
            fault.id,
            node,
            process.pid,
          )
          if (!attempt) continue
          const checking =
            fault.faultKind === 'rebuild'
              ? this.checkNativeRebuild(node.sessionId, fault.agentId, rebuild!, attempt.id)
              : fault.faultKind === 'queue'
                ? this.inspectPreviousRun(run, true, attempt.id)
                : this.checkNativeBinding(node.sessionId, fault.agentId, run.id, attempt.id)
          if (
            ![...this.core.nativeChecks.values()].some(
              (entry) => entry.automaticAttemptId === attempt.id,
            )
          )
            this.core.conversations.settleSchedulingRecoveryCheck(attempt.id, {
              ok: false,
              physicalReleased: true,
            })
          void checking.catch(() => undefined)
        } catch {
          // Unavailable/stale facts keep their original manual recovery path; no new card or retry.
        }
      }
    }
  }

  private startNativeCheck(
    key: string,
    controller: AbortController,
    operation: () => Promise<RpcResult<ConversationPatch>>,
    options: {
      receiptSessionId?: string
      onPhysicalCompletion?: () => void
      automaticAttemptId?: string | undefined
      onLogicalTimeout?: () => void
      targetRunId?: string | undefined
    } = {},
  ): Promise<RpcResult<ConversationPatch>> {
    const physical = Promise.withResolvers<void>()
    const interruption = Promise.withResolvers<RpcResult<ConversationPatch>>()
    const aborted = (): void =>
      interruption.resolve({
        ok: false,
        error: {
          code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
          message: 'Native state could not be confirmed. No task was reexecuted.',
        },
      })
    const owner: NonNullable<ReturnType<typeof this.core.nativeChecks.get>> = {
      controller,
      task: interruption.promise,
      physicalCompletion: physical.promise,
      physicalOperations: new Set(),
      logicalTimeout: () => {
        try {
          options.onLogicalTimeout?.()
        } catch {
          // A failed recovery projection cannot disable the check's deadline.
        } finally {
          aborted()
        }
      },
      phase: 'checking',
      automaticAttemptId: options.automaticAttemptId,
      targetRunId: options.targetRunId,
      configurationGeneration: options.automaticAttemptId
        ? this.core.conversations.schedulingConfigurationGeneration()
        : undefined,
      ...(options.receiptSessionId ? { receiptSessionId: options.receiptSessionId } : {}),
    }
    this.core.nativeChecks.set(key, owner)
    controller.signal.addEventListener('abort', aborted, { once: true })
    const timer = options.automaticAttemptId
      ? setTimeout(
          () => controller.abort(),
          Math.max(
            0,
            Date.parse(
              this.core.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)!
                .deadline,
            ) - Date.now(),
          ),
        )
      : undefined
    let workSucceeded = false
    const work = Promise.resolve()
      .then(() => {
        if (
          options.automaticAttemptId &&
          Date.now() >=
            Date.parse(
              this.core.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)!
                .deadline,
            )
        )
          controller.abort()
        controller.signal.throwIfAborted()
        if (options.automaticAttemptId)
          this.core.conversations.startSchedulingRecoveryCheck(options.automaticAttemptId)
        return operation()
      })
      .then((result) => {
        workSucceeded = result.ok
        return result
      })
    owner.task = Promise.race([work, interruption.promise])
      .then((result) => {
        if (options.automaticAttemptId)
          this.core.conversations.settleSchedulingRecoveryCheck(options.automaticAttemptId, {
            ok: result.ok,
            physicalReleased: false,
          })
        return result
      })
      .finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', aborted)
        if (this.core.nativeChecks.get(key) === owner) {
          owner.phase = 'cleanup_unconfirmed'
          this.core.archiveAndQuit.nativeMetadataChanged()
        }
      })
    void work
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.all(owner.physicalOperations)
        if (options.automaticAttemptId)
          this.core.conversations.settleSchedulingRecoveryCheck(options.automaticAttemptId, {
            ok: workSucceeded,
            physicalReleased: true,
          })
        if (this.core.nativeChecks.get(key) === owner) {
          owner.adapter = undefined
          this.core.nativeChecks.delete(key)
          physical.resolve()
          this.core.archiveAndQuit.nativeMetadataChanged()
          if (
            options.automaticAttemptId &&
            !this.core.disposed &&
            owner.configurationGeneration ===
              this.core.conversations.schedulingConfigurationGeneration()
          ) {
            const [sessionId, agentId] = key.split(':')
            if (
              sessionId &&
              (agentId === 'codex' || agentId === 'claude' || agentId === 'agy') &&
              !this.core.interactions.pendingNativeInteractions(sessionId).length &&
              this.core.conversations.schedulingSettings().credential.configured &&
              this.core.conversations.proposeRelayNativeRecovery(
                sessionId,
                agentId,
                this.core.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)
                  ?.faultId,
              )
            )
              this.core.publish(this.core.conversations.metadataPatch(sessionId))
          }
          this.core.collaboration.schedulePendingRoutedContinuations()
          options.onPhysicalCompletion?.()
        }
        physical.resolve()
        return undefined
      })
      .catch(physical.reject)
    // A rejected cleanup stays owned; disposal reports the failure instead of releasing its slot.
    void physical.promise.catch(() => undefined)
    this.core.archiveAndQuit.nativeMetadataChanged()
    return owner.task
  }

  private async runNativeCheck<T>(
    controller: AbortController,
    begin: (
      context: AgentNativeCheckContext | undefined,
      signal: AbortSignal,
    ) => AgentNativeCheckOperation<T>,
    receiptStage = false,
  ): Promise<T> {
    const owner = [...this.core.nativeChecks.values()].find(
      (entry) => entry.controller === controller,
    )
    if (
      owner?.automaticAttemptId &&
      Date.now() >=
        Date.parse(
          this.core.conversations.schedulingRecoveryAttempt(owner.automaticAttemptId)!.deadline,
        )
    )
      controller.abort()
    if (!owner || controller.signal.aborted)
      throw new Error('The native check is no longer current.')
    const child = owner.automaticAttemptId ? undefined : new AbortController()
    const checkSignal = child
      ? AbortSignal.any([controller.signal, child.signal])
      : controller.signal
    const interruption = Promise.withResolvers<never>(),
      ownerInterruption = Promise.withResolvers<never>()
    const interrupted = () => interruption.reject(new Error('The native check was interrupted.'))
    const ownerAborted = () =>
      ownerInterruption.reject(new Error('The native check owner was cancelled.'))
    checkSignal.addEventListener('abort', interrupted, { once: true })
    controller.signal.addEventListener('abort', ownerAborted, { once: true })
    // Both rejections are also observed while the result/physical branch is awaiting its peer.
    void interruption.promise.catch(() => undefined)
    void ownerInterruption.promise.catch(() => undefined)
    const timer = child
      ? setTimeout(() => {
          try {
            if (!receiptStage) owner.logicalTimeout()
          } finally {
            child.abort()
          }
        }, DELIVERY_RECONCILIATION_TIMEOUT_MS)
      : undefined
    try {
      const operation = begin(
        owner.automaticAttemptId
          ? {
              operationId: owner.automaticAttemptId,
              recordPhysicalOwner: (physicalOwner) =>
                this.core.conversations.recordSchedulingCheckPhysicalOwner(
                  owner.automaticAttemptId!,
                  physicalOwner,
                ),
            }
          : undefined,
        checkSignal,
      )
      owner.physicalOperations.add(operation.physicalCompletion)
      void operation.physicalCompletion.then(
        () => owner.physicalOperations.delete(operation.physicalCompletion),
        () => undefined,
      )
      try {
        const result = await Promise.race([
          operation.result.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          ),
          interruption.promise,
        ])
        // Serial stages cannot overlap a still-owned RPC, reader, encoder, or cleanup.
        await Promise.race([operation.physicalCompletion, interruption.promise])
        controller.signal.throwIfAborted()
        if (!result.ok) throw result.error
        return result.value
      } catch (error) {
        if (child?.signal.aborted && !controller.signal.aborted)
          await Promise.race([operation.physicalCompletion, ownerInterruption.promise])
        throw error
      }
    } finally {
      clearTimeout(timer)
      checkSignal.removeEventListener('abort', interrupted)
      controller.signal.removeEventListener('abort', ownerAborted)
    }
  }
}
