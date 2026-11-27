import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { AgentPromptEnvelope } from '@pact/agent-runtime'
import type {
  AgentRun,
  AnchoredComment,
  CollaborationTask,
  ConversationMessageRoute,
  ConversationPatch,
  ConversationQueueActionInput,
  ConversationQueueEnabledInput,
  ConversationQueueReturnInput,
  ConversationSendInput,
  ConversationSnapshot,
  FrozenSkillInvocation,
  OriginSideChat,
  RpcResult,
  RuntimeAgentId,
  SchedulingHandoff,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import {
  AGENTS,
  agentDisplayName,
  agentIdForRouteCandidate,
  COLLABORATION_PROTOCOL,
  collaborationActor,
  collaborationAskActor,
  collaborationInitialStage,
  collaborationTaskSchema,
  decisionJsonBytes,
  defaultTaskStageRoles,
  isAgentInPair,
  otherAgent,
  pactCommandRouteAllowed,
  pactEntryPrimary,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  routeCandidateIdSchema,
} from '@pact/contracts'
import { PreparedInformationConflictError, RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type {
  ActiveExecution,
  PreparedSession,
  PreparingSend,
  SendOptions,
} from '../conversation-types'
import type { CollectedHandoff } from '../cross-agent-context-broker'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { BACKGROUND_INPUT_REASON, MAX_AGENT_OPERATIONS } from '../conversation-types'
import { evaluateRelayPolicy } from '../relay-policy'
import { loadCollaborationBasis } from './collaboration-and-handoff-coordinator'

export class SendAndSteerCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  async send(
    input: ConversationSendInput,
    ownerKey?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    return await this.sendWithOptions(input, ownerKey)
  }

  async sendWithOptions(
    input: ConversationSendInput,
    ownerKey?: string,
    syncOptions?: {
      originSideChat?: OriginSideChat | undefined
      syncMainOperationId?: string | undefined
    },
  ): Promise<RpcResult<ConversationPatch>> {
    let releaseImages: (() => void) | undefined
    try {
      const held = this.core.conversations.heldPreparedInputPatch(input)
      if (held) return { ok: true, value: held }
      const savedTask = this.core.conversations.collaboration(input.sessionId)
      const task = savedTask?.status === 'complete' ? undefined : savedTask
      const preparing = this.core.preparingSends.has(input.clientMessageId)
      const waitingForWork =
        task?.status === 'running' || this.core.gate.hasSessionOperation(input.sessionId)
      const received = this.core.conversations.receivedInputReceipt(
        input.sessionId,
        input.clientMessageId,
        input,
        waitingForWork,
      )
      if (received) {
        if (input.userInformation)
          throw new RunOperationConflictError(
            'A queued message cannot acquire a user declaration. Your draft was kept.',
          )
        return { ok: true, value: received }
      }
      const content = input.inputId
        ? this.core.conversations
            .resolveConversationInput(
              input.sessionId,
              input.clientMessageId,
              input.inputId,
              ownerKey ?? '',
            )
            .trim()
        : input.content
      this.core.conversations.assertPreparedInputRequest({ ...input, content })
      const submitted = this.core.conversations.submittedRunReceipt({ ...input, content })
      if (submitted) {
        this.core.publish(submitted.patch)
        return { ok: true, value: submitted.patch }
      }
      if (
        input.userInformation &&
        !preparing &&
        (task ||
          waitingForWork ||
          input.returnedInputOperationId ||
          input.queueReturnOperationId ||
          input.replyToDecision ||
          input.skills?.length ||
          input.imageIds?.length ||
          input.route?.type === 'all')
      )
        throw new RunOperationConflictError(
          'Reserved information supports a new ordinary message only. Remove it before queueing, steering, replying to a workflow, using Skills, images or @all. Your draft was kept.',
        )
      this.core.conversations.assertRelayDecisionResolved(input.sessionId, undefined, true)
      this.core.conversations.assertDecisionInput({ ...input, content })
      if (this.core.conversations.receivedCollaborationInput(input.sessionId))
        throw new RunOperationConflictError(
          'One message is already queued. Your draft was preserved.',
        )
      if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
      if (this.core.conversations.archives.blocksSession(input.sessionId))
        return this.core.archiveBusy()
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return this.core.nativeRecoveryRequired()
      if (this.core.gate.hasBlockingBackgroundWork(input.sessionId))
        throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)

      if (input.imageIds?.length) {
        if (!this.core.images) throw new Error('Image input is unavailable.')
        this.core.conversations.resolveMessageImages(input.sessionId, input.imageIds, ownerKey)
        releaseImages = this.core.images.hold(input.imageIds)
      }
      const prefix = parseComposerCommandPrefix(content, input.skills)
      if (prefix.btw)
        throw new RunOperationConflictError(
          '/btw opens a side chat instead of sending a regular message.',
        )
      const targetSession = this.core.sessions.find(input.sessionId)
      if (targetSession?.parentSessionId && prefix.pact)
        throw new RunOperationConflictError(
          'Side chats cannot run /plan, /build, or /review commands.',
        )
      if (
        input.askOnly &&
        (!task ||
          preparing ||
          waitingForWork ||
          this.core.interactions.pendingNativeInteractions(input.sessionId).length ||
          prefix.route ||
          prefix.pact ||
          input.route)
      )
        throw new RunOperationConflictError('Ask only needs a settled task and an idle Agent.')
      if (input.userInformation && (prefix.pact || prefix.skills.length || prefix.error))
        throw new RunOperationConflictError(
          'Remove reserved information before sending a command. Your draft was kept.',
        )
      if (prefix.pact && !pactCommandRouteAllowed(input.route, prefix.route))
        throw new RunOperationConflictError(
          'The explicit Agent recipients conflict. Your draft was preserved.',
        )
      const inTaskReview = this.core.conversations.isInTaskReviewCommand(task, prefix.pact)
      if (targetSession && targetSession.status !== 'archived') {
        const allowedPair =
          task && (!prefix.pact || inTaskReview)
            ? ([task.owner, task.reviewer] as const)
            : resolveActiveAgentPair(targetSession.settings)
        const explicitRoute = input.route ?? prefix.route
        if (explicitRoute?.type === 'agent' && !isAgentInPair(explicitRoute.agentId, allowedPair)) {
          throw new RunOperationConflictError(
            `${agentDisplayName(explicitRoute.agentId)} is not in this Session's active Agent pair. Your draft was preserved.`,
          )
        }
        for (const selection of input.skills ?? []) {
          if (!isAgentInPair(selection.agentId, allowedPair)) {
            throw new RunOperationConflictError(
              `/${selection.name} belongs to ${agentDisplayName(selection.agentId)}, which is not in this Session's active Agent pair. Your draft was preserved.`,
            )
          }
        }
      }
      this.core.conversations.assertTaskReplacement(input, Boolean(prefix.pact) && !inTaskReview)
      if (!preparing && (task || waitingForWork)) {
        if (task && (!prefix.pact || inTaskReview) && (input.route ?? prefix.route)?.type === 'all')
          throw new RunOperationConflictError(
            '@all is unavailable while a Pact task is unfinished. Choose one Agent.',
          )
        const session = this.core.sessions.find(input.sessionId)
        if (!session || session.status === 'archived')
          throw new RunOperationConflictError('The Session is unavailable.')
        const activePair = resolveActiveAgentPair(session.settings)
        const requestedRoute = input.route ?? prefix.route
        let actor =
          requestedRoute?.type === 'agent'
            ? requestedRoute.agentId
            : input.askOnly && task
              ? collaborationAskActor(task)
              : inTaskReview && task
                ? collaborationActor(task, 'code_review')
                : task && !prefix.pact
                  ? this.core.conversations.collaborationReplyActor(task, input.replyToDecision)
                  : activePair[0]
        if (prefix.pact && !inTaskReview) {
          const primary = pactEntryPrimary(
            prefix.pact,
            activePair[0],
            requestedRoute?.type === 'agent' ? requestedRoute.agentId : undefined,
            activePair[1],
          )
          actor = collaborationActor(
            {
              kind: prefix.pact,
              owner: primary,
              reviewer: otherAgent(primary, activePair),
              rolePolicy: 'split-stages-v1',
            },
            prefix.pact === 'plan' ? 'plan' : prefix.pact === 'build' ? 'implement' : 'code_review',
          )
          if (
            requestedRoute?.type === 'all' ||
            (requestedRoute?.type === 'agent' && requestedRoute.agentId !== actor)
          )
            throw new RunOperationConflictError(
              `This Pact ${prefix.pact} stage belongs to ${actor}. Remove the conflicting Agent recipient; your draft is preserved.`,
            )
        }
        const bodyOwner = ownerKey ?? 'pact-received-input'
        let retainedId = input.inputId
        if (!retainedId) {
          const initial = this.core.conversations.writeConversationInput(
            { type: 'begin', sessionId: input.sessionId, clientMessageId: input.clientMessageId },
            bodyOwner,
          )
          retainedId = initial.inputId
          let offset = initial.offset
          while (offset < content.length) {
            let end = Math.min(content.length, offset + 8192)
            if (
              end < content.length &&
              content.charCodeAt(end - 1) >= 0xd800 &&
              content.charCodeAt(end - 1) <= 0xdbff
            )
              end--
            this.core.conversations.writeConversationInput(
              {
                type: 'append',
                sessionId: input.sessionId,
                inputId: retainedId,
                offset,
                text: content.slice(offset, end),
              },
              bodyOwner,
            )
            offset = end
          }
          this.core.conversations.writeConversationInput(
            { type: 'seal', sessionId: input.sessionId, inputId: retainedId },
            bodyOwner,
          )
        }
        const anchor =
          this.core.activeExecutions.get(input.sessionId)?.run ??
          (task ? this.core.conversations.findRun(task.runId) : undefined) ??
          AGENTS.map((agentId) => this.core.conversations.latestAgentRun(input.sessionId, agentId))
            .filter((run): run is AgentRun => Boolean(run))
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        if (!anchor)
          throw new RunOperationConflictError(
            'Wait for the current execution to start before queuing a message.',
          )
        if (syncOptions?.originSideChat) {
          const gateFailure = this.core.sideChats.checkSideChatSyncGateFailure(
            syncOptions.originSideChat.sideChatId,
            input.sessionId,
          )
          if (gateFailure) return gateFailure
        }
        const patch = this.core.conversations.receiveQueuedInput(
          { ...input, content },
          retainedId,
          actor,
          bodyOwner,
          anchor.id,
          waitingForWork,
          prefix.pact && !inTaskReview ? 'split-stages-v1' : undefined,
          syncOptions?.originSideChat || syncOptions?.syncMainOperationId
            ? {
                ...(syncOptions.originSideChat
                  ? { originSideChat: syncOptions.originSideChat }
                  : {}),
                ...(syncOptions.syncMainOperationId
                  ? { syncMainOperationId: syncOptions.syncMainOperationId }
                  : {}),
              }
            : undefined,
        )
        this.core.publish(patch)
        if (task) {
          this.core.collaboration.abortPreparedWorkflow(input.sessionId)
          for (const pending of this.core.permissions.values())
            if (
              pending.sessionId === input.sessionId &&
              pending.details?.kind === 'questions' &&
              pending.valid()
            )
              pending.settle({ action: 'cancel' })
        }
        this.core.collaboration.schedulePendingRoutedContinuations()
        return { ok: true, value: patch }
      }
      const { inputId } = input
      return await this.enqueueSend(
        { ...input, content },
        {
          ...(ownerKey ? { imageOwnerKey: ownerKey } : {}),
          ...(syncOptions?.originSideChat ? { originSideChat: syncOptions.originSideChat } : {}),
          ...(syncOptions?.syncMainOperationId
            ? { syncMainOperationId: syncOptions.syncMainOperationId }
            : {}),
        },
      ).then((result) => {
        if (result.ok && inputId)
          this.core.conversations.consumeConversationInput(input.sessionId, inputId, ownerKey!)
        return result
      })
    } catch (error) {
      return this.core.sendFailure(error)
    } finally {
      releaseImages?.()
    }
  }

  private mutateQueue(
    sessionId: string,
    mutation: () => ConversationPatch,
  ): RpcResult<ConversationPatch> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.conversations.archives.blocksSession(sessionId)) return this.core.archiveBusy()
    try {
      const patch = mutation()
      this.core.publish(patch)
      this.core.collaboration.schedulePendingRoutedContinuations()
      return { ok: true, value: patch }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  setConversationQueueEnabled(input: ConversationQueueEnabledInput): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.core.conversations.setConversationQueueEnabled(input),
    )
  }

  resumeConversationQueue(input: ConversationQueueActionInput): RpcResult<ConversationPatch> {
    if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return this.core.nativeRecoveryRequired()
    return this.mutateQueue(input.sessionId, () =>
      this.core.conversations.resumeConversationQueue(input),
    )
  }

  removeQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.core.conversations.removeQueuedConversationMessage(input),
    )
  }

  returnQueuedConversationMessage(
    input: ConversationQueueReturnInput,
  ): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.core.conversations.returnQueuedConversationMessage(input),
    )
  }

  refreshExecutionInputScope(execution: ActiveExecution): void {
    if (
      this.core.activeExecutions.get(execution.run.sessionId) !== execution ||
      !this.core.conversations.ownsNativeControl(execution.run.id)
    )
      return
    const envelope = execution.promptEnvelope
    if (!envelope) return
    const authorization = this.core.conversations.collaborationTurnAuthorization(execution.run.id)
    execution.promptEnvelope = {
      ...envelope,
      collaborationAuthorization: authorization,
      requiredInputScopeRef: authorization?.sourceManifestRef ?? undefined,
    }
  }

  async steerQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.conversations.archives.blocksSession(input.sessionId))
      return this.core.archiveBusy()
    const execution = this.core.activeExecutions.get(input.sessionId)
    if (execution?.steering)
      return execution.steering.operationId === input.operationId
        ? execution.steering.task
        : {
            ok: false,
            error: { code: 'CONFLICT', message: 'A steering request is already being checked.' },
          }
    try {
      const receipt = this.core.conversations.queuedSteerReceipt(input)
      if (receipt) return { ok: true, value: receipt }
    } catch (error) {
      return this.core.sendFailure(error)
    }
    const run = execution && this.core.conversations.findRun(execution.run.id)
    const owner = run && this.core.nativeObservations.get(run.id)
    const adapter = execution?.adapter
    if (
      !execution ||
      !run?.nativeSessionId ||
      !run.nativeTurnId ||
      !owner ||
      !adapter?.steer ||
      execution.abortController.signal.aborted ||
      !execution.promptEnvelope
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The current execution cannot accept native steering. Your message remains queued.',
        },
      }
    const sessionId = input.sessionId
    const signal = execution.abortController.signal
    const current = (): boolean =>
      !this.core.disposed &&
      this.core.activeExecutions.get(sessionId) === execution &&
      this.core.nativeObservations.get(run.id) === owner &&
      this.core.conversations.ownsNativeControl(run.id) &&
      !signal.aborted
    const work = Promise.resolve().then(async (): Promise<RpcResult<ConversationPatch>> => {
      let prepared = false
      const delivery = {
        phase: 'prepared' as 'prepared' | 'possibly_sent' | 'accepted' | 'rejected',
      }
      let invocation: FrozenSkillInvocation | undefined
      let revokeNewlyAuthorizedCutoffs: (() => void) | undefined
      try {
        const queued = this.core.conversations.readReceivedInput(sessionId)
        if (!queued || queued.id !== input.inputId)
          throw new RunOperationConflictError('This queued message is no longer current.')
        const prefix = parseComposerCommandPrefix(queued.content, queued.metadata.skills)
        if (prefix.pact || queued.metadata.route?.type === 'all' || queued.actor !== run.agentId)
          throw new RunOperationConflictError(
            'This message must stay queued for its selected task and recipient.',
          )
        invocation = await this.core.skills.prepareSkillInvocation(
          { sessionId, content: queued.content, skills: queued.metadata.skills },
          [run.agentId],
          signal,
        )
        if (execution.steering?.operationId === input.operationId)
          execution.steering.invocation = invocation
        if (!current())
          throw new RunOperationConflictError('The target execution ended before steering.')
        const attempt = this.core.conversations.prepareQueuedSteer(
          input,
          {
            runId: run.id,
            bindingGeneration: run.bindingGeneration ?? 1,
            nativeTurnId: run.nativeTurnId!,
            ...(run.executorId ? { executorId: run.executorId } : {}),
          },
          invocation,
        )
        if (!attempt.created)
          return { ok: true, value: this.core.conversations.metadataPatch(sessionId) }
        prepared = true
        const images = this.core.conversations.resolveMessageImages(
          sessionId,
          queued.metadata.imageIds,
        )
        const envelope = this.promptEnvelope(
          sessionId,
          { id: queued.id, content: queued.content },
          [],
          undefined,
          images,
        )
        if (queued.inputBatchRef)
          envelope.inputBatchRef = {
            id: queued.inputBatchRef.id,
            revision: queued.inputBatchRef.commentsRevision,
            memberCount: queued.inputBatchRef.memberCount,
          }
        this.core.contextBroker.inlineCurrentComments(envelope, {
          sessionId,
          runId: run.id,
          batchId: envelope.inputBatchRef?.id,
        })
        envelope.sourceGrant = { runId: run.id, grant: owner.generation }
        envelope.targetAgentId = run.agentId
        envelope.skillInvocation = invocation
        envelope.collaboration = this.core.conversations.collaboration(sessionId, run.id, false)
        envelope.collaborationAuthorization =
          this.core.conversations.collaborationTurnAuthorization(run.id)
        envelope.requiredInputScopeRef =
          envelope.collaborationAuthorization?.sourceManifestRef ?? undefined
        const queuedCutoffId = queued.metadata.originSideChat?.cutoffId
        const steerCutoffs = [
          ...new Set([
            ...this.authorizedCutoffsForEnvelope(
              { sessionId, userMessageId: queued.id },
              envelope,
              Boolean(this.core.sessions.find(sessionId)?.parentSessionId),
            ),
            ...(queuedCutoffId &&
            this.core.conversations.buildCutoffInlineTail(queuedCutoffId, 256).maxMessageSequence >=
              0
              ? [queuedCutoffId]
              : []),
          ]),
        ]
        const steerInjectedCutoffs = steerCutoffs.length
          ? this.attachCutoffSupplement(
              run.sessionId,
              run.agentId,
              run.bindingGeneration ?? 1,
              envelope,
              steerCutoffs,
            )
          : []
        const newlyAuthorizedCutoffs = steerCutoffs.length
          ? (this.core.nativeObservations
              .get(run.id)
              ?.sourceReader?.authorizeCutoffs(steerCutoffs) ?? [])
          : []
        revokeNewlyAuthorizedCutoffs = () => {
          if (newlyAuthorizedCutoffs.length) {
            this.core.nativeObservations
              .get(run.id)
              ?.sourceReader?.revokeCutoffs(newlyAuthorizedCutoffs)
          }
        }
        let steerCutoffsMarked = false
        const markSteerCutoffs = (): void => {
          if (steerCutoffsMarked || !steerInjectedCutoffs.length) return
          const marked = this.core.conversations.markCutoffsDelivered(
            run.sessionId,
            run.agentId,
            run.bindingGeneration ?? 1,
            steerInjectedCutoffs,
          )
          if (marked.length > 0) steerCutoffsMarked = true
        }
        this.refreshExecutionInputScope(execution)
        this.core.publish(this.core.conversations.metadataPatch(sessionId))
        const accepted = (): void => {
          if (current()) this.core.executor.flushRunOutput(run)
          markSteerCutoffs()
          this.core.publish(
            this.core.conversations.markQueuedSteerAccepted(input.operationId, invocation),
          )
          this.refreshExecutionInputScope(execution)
        }
        const result = await adapter.steer!(
          {
            runId: run.id,
            inputId: queued.id,
            nativeSessionId: run.nativeSessionId!,
            nativeTurnId: run.nativeTurnId!,
            bindingGeneration: run.bindingGeneration ?? 1,
            nativeGeneration: owner.generation,
            promptEnvelope: envelope,
            recordDispatch: (next) => {
              if (
                next === 'possibly_sent'
                  ? !current()
                  : this.core.nativeObservations.get(run.id) !== owner
              )
                throw new RunOperationConflictError(
                  'The steering observation changed before its receipt.',
                )
              if (next === 'possibly_sent')
                this.core.publish(
                  this.core.conversations.markQueuedSteerPossiblySent(input.operationId),
                )
              else if (next === 'accepted') accepted()
              else {
                revokeNewlyAuthorizedCutoffs?.()
                this.core.publish(
                  this.core.conversations.markQueuedSteerRefused(
                    input.operationId,
                    'The native execution refused this steering request.',
                    true,
                  ),
                )
              }
              delivery.phase = next
              this.refreshExecutionInputScope(execution)
            },
            recordConsumption: (id) => {
              if (id !== queued.id || this.core.nativeObservations.get(run.id) !== owner) return
              if (current()) this.core.executor.flushRunOutput(run)
              markSteerCutoffs()
              this.core.publish(
                this.core.conversations.markQueuedSteerConsumed(input.operationId, id, invocation),
              )
              this.refreshExecutionInputScope(execution)
            },
          },
          signal,
        )
        if (result.status === 'accepted' && delivery.phase !== 'accepted') accepted()
        else if (
          (result.status === 'unsupported' || result.status === 'rejected') &&
          delivery.phase !== 'rejected'
        ) {
          revokeNewlyAuthorizedCutoffs?.()
          this.core.publish(
            this.core.conversations.markQueuedSteerRefused(
              input.operationId,
              result.reason,
              result.status === 'rejected',
            ),
          )
        }
        this.refreshExecutionInputScope(execution)
        return { ok: true, value: this.core.conversations.metadataPatch(sessionId) }
      } catch (error) {
        if (prepared) {
          // The original observer can persist incorporation before this RPC
          // loses its ACK. That stronger fact must not be downgraded or retried.
          const consumed = this.core.conversations.queuedSteerReceipt(input, run.id)
          if (consumed) {
            this.refreshExecutionInputScope(execution)
            return { ok: true, value: consumed }
          }
          if (delivery.phase === 'prepared') {
            revokeNewlyAuthorizedCutoffs?.()
            this.core.publish(
              this.core.conversations.markQueuedSteerRefused(
                input.operationId,
                'Steering could not be prepared. Your message remains queued.',
              ),
            )
          } else if (delivery.phase !== 'rejected' && delivery.phase !== 'accepted')
            this.core.publish(
              this.core.conversations.markQueuedSteerUnknown(
                input.operationId,
                'Native steering delivery could not be confirmed. It will not be sent again automatically.',
              ),
            )
          this.refreshExecutionInputScope(execution)
        }
        return this.core.sendFailure(error)
      }
    })
    const entry: NonNullable<ActiveExecution['steering']> = {
      operationId: input.operationId,
      inputId: input.inputId,
      task: work,
    }
    execution.steering = entry
    try {
      return await work
    } finally {
      if (execution.steering === entry) execution.steering = undefined
      this.core.collaboration.schedulePendingRoutedContinuations()
    }
  }

  /** A Steer boundary freezes only output committed before its accepted User. */

  enqueueSend(
    input: ConversationSendInput,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    if (!options.preparedInput) {
      try {
        const held = this.core.conversations.heldPreparedInputPatch(input)
        if (held) return Promise.resolve({ ok: true, value: held })
      } catch (error) {
        return Promise.resolve(this.core.sendFailure(error))
      }
    }
    if (this.core.disposed) return Promise.resolve(this.core.shuttingDown())
    if (this.core.gate.nativeQuitSealed()) return Promise.resolve(this.core.quitPrepared())
    if (this.core.conversations.archives.blocksSession(input.sessionId))
      return Promise.resolve(this.core.archiveBusy())
    try {
      this.core.conversations.assertRelayDecisionResolved(
        input.sessionId,
        options.collaborationActionReceiptId,
      )
    } catch (error) {
      return Promise.resolve(this.core.sendFailure(error))
    }
    if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return Promise.resolve(this.core.nativeRecoveryRequired())
    if (
      this.core.conversations
        .nativeContexts(input.sessionId)
        .some(
          (context) =>
            context.continuationState === 'responding' ||
            context.continuationState === 'waiting_user',
        )
    )
      return Promise.resolve(this.core.capacityFailure())
    if (this.core.conversations.hasPendingRoutedContinuation(input.sessionId))
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Wait for or stop the remaining @all response before sending another message.',
        },
      })
    const preparing = this.core.preparingSends.get(input.clientMessageId)
    if (preparing) {
      const prior = preparing.input
      const identical =
        prior.sessionId === input.sessionId &&
        prior.content === input.content &&
        JSON.stringify(prior.imageIds ?? []) === JSON.stringify(input.imageIds ?? []) &&
        JSON.stringify(prior.skills ?? []) === JSON.stringify(input.skills ?? []) &&
        JSON.stringify(prior.route) === JSON.stringify(input.route) &&
        prior.inputId === input.inputId &&
        prior.routeIntent === input.routeIntent &&
        prior.composerRevision === input.composerRevision &&
        JSON.stringify(prior.userInformation) === JSON.stringify(input.userInformation) &&
        JSON.stringify(prior.replyToDecision) === JSON.stringify(input.replyToDecision) &&
        (prior.batchId ?? prior.clientMessageId) === (input.batchId ?? input.clientMessageId) &&
        (prior.freezeDrafts ?? !preparing.options.preserveDraftComments) ===
          (input.freezeDrafts ?? !options.preserveDraftComments) &&
        prior.returnedInputOperationId === input.returnedInputOperationId &&
        prior.queueReturnOperationId === input.queueReturnOperationId &&
        isDeepStrictEqual(prior.replaceTask, input.replaceTask) &&
        prior.commentIds.length === input.commentIds.length &&
        prior.commentIds.every((id, index) => id === input.commentIds[index]) &&
        preparing.options.sourceProposalId === options.sourceProposalId
      return identical
        ? preparing.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'This message ID already has different content.' },
          })
    }
    try {
      const existing = this.core.conversations.submittedRunReceipt(input)
      if (existing) {
        this.core.publish(existing.patch)
        return Promise.resolve({ ok: true, value: existing.patch })
      }
    } catch (error) {
      return Promise.resolve(this.core.sendFailure(error))
    }
    if (this.core.gate.hasBlockingBackgroundWork(input.sessionId))
      return Promise.resolve(
        this.core.sendFailure(new RunOperationConflictError(BACKGROUND_INPUT_REASON)),
      )
    if (this.core.gate.hasSessionOperation(input.sessionId)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: this.core.gate.hasSessionOperation(input.sessionId, false)
            ? 'This Session already has an active operation.'
            : 'Native work from the previous task has not finished or could not be confirmed. Your draft was not sent.',
        },
      })
    }
    if (this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(this.core.capacityFailure())

    const controller = new AbortController()
    const task = Promise.resolve().then(() => this.sendWithInputRouting(input, controller, options))
    const entry: PreparingSend = { input, options, controller, task }
    this.core.preparingSends.set(input.clientMessageId, entry)
    this.core.workspaceChanges?.cancelUndoForNativeSession(input.sessionId)
    const release = (): void => {
      if (this.core.preparingSends.get(input.clientMessageId) === entry)
        this.core.preparingSends.delete(input.clientMessageId)
      if (!this.core.disposed)
        this.core.publish(this.core.conversations.metadataPatch(input.sessionId))
      this.core.collaboration.schedulePendingRoutedContinuations()
    }
    void task.then(release, release)
    return task
  }

  async awaitSettlingExecution(sessionId: string, runId?: string): Promise<void> {
    const activeExecution = this.core.activeExecutions.get(sessionId)
    if (!activeExecution?.completion) return
    if (runId && activeExecution.run.id !== runId) return
    const activeRun = this.core.conversations.findRun(activeExecution.run.id)
    if (!activeRun || ['starting', 'running', 'recovering'].includes(activeRun.status)) return
    await activeExecution.completion.catch(() => undefined)
  }

  private async sendWithInputRouting(
    input: ConversationSendInput,
    controller: AbortController,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    let receipt: import('@pact/persistence').PreparedInputDispatch | undefined =
      options.preparedInput
    let held = false
    let handoff: SchedulingHandoff | undefined
    try {
      const environmentStarted = Date.now()
      await this.core.runtimePreparation.prepareEnvironment(controller.signal)
      const environmentElapsed = Date.now() - environmentStarted
      const session = this.core.sessions.find(input.sessionId)
      const settings = this.core.conversations.schedulingSettings()
      const admission = this.core.scheduling.decisionRuntimeAdmission()
      if (
        !receipt &&
        session &&
        settings.enabled &&
        settings.credential.configured &&
        admission === 'may_attempt' &&
        !options.collaboration &&
        !options.receivedInputId &&
        !options.sourceProposalId &&
        !options.preserveDraftComments &&
        !options.originSideChat &&
        !this.core.interactions.pendingNativeInteractions(input.sessionId).length &&
        this.core.conversations.ordinaryInputWorthConsulting(input, session.settings.primaryAgentId)
      ) {
        const activePair = resolveActiveAgentPair(session.settings)
        const allowed = (['codex', 'claude', 'agy'] as const).filter((actor) => {
          if (!isAgentInPair(actor, activePair)) return false
          const context = this.core.conversations.nativeContext(input.sessionId, actor)
          return !context || context.continuationState === 'ready'
        })
        const scope = this.core.projects.find(session.projectId)
        const configurationKey =
          scope && this.core.runtimePreparation.catalogIdentity(scope.directoryPath)
        let material: { inputSha256: string; sourceFingerprint: string } | undefined
        const outcome = await this.core.scheduling.evaluateDecision(
          {
            sessionId: input.sessionId,
            prepare: async (context) => {
              // Runtime owns the fixed lease and original deadline before any complete input freeze.
              receipt = this.core.conversations.prepareInputDispatch(
                input,
                randomUUID(),
                allowed,
                context,
              )
              options.preparedInput = receipt
              const frozen = receipt
              handoff = this.core.conversations.preparedInputHandoff(receipt.batchId)
              this.core.publish(
                this.core.conversations.metadataPatch(input.sessionId, { draftsChanged: true }),
              )
              const routingCandidates = frozen.metadata.allowedAgentIds.map((actor) => ({
                id: `route_${actor}`,
                description: `Send the exact original input once to ${actor}, preserving its existing permissions and scope.`,
              }))
              const informationOpportunity =
                this.core.conversations.preparedInformationOpportunity(frozen)
              const candidates = [
                ...routingCandidates,
                ...(informationOpportunity
                  ? [
                      {
                        id: 'clarify_prepared_input',
                        information: { fieldId: informationOpportunity.fieldId },
                        description: `Collect the existing unanswered user-declared field ${informationOpportunity.fieldId}. Select only that exact fieldId; its question and choices are already frozen by the host.`,
                      },
                    ]
                  : []),
              ]
              if (routingCandidates.length < 2 && !informationOpportunity)
                throw new RunOperationConflictError('This input has no alternative recipient.')
              const read = await this.core.conversations.readPreparedInputDecisionSources(
                frozen,
                candidates,
                context,
              )
              const policy = evaluateRelayPolicy({
                node: 'send',
                informationOpportunity: informationOpportunity
                  ? {
                      ...informationOpportunity,
                      sourceId:
                        read.sources.find(
                          (source) =>
                            source.kind === 'declaration' &&
                            source.document?.id === informationOpportunity.document.id,
                        )?.id ?? '',
                    }
                  : undefined,
                ordinary: true,
                handoffId: handoff.id,
                budgetSubjectId: handoff.budgetSubjectId,
                primary: frozen.metadata.defaultAgentId,
                activePair,
                route: 'implicit',
                inputSourceId: 's0',
                referencedSourceIds: read.sources
                  .filter((source) => source.actor !== null)
                  .map((source) => source.id),
                materials: {
                  complete: true,
                  inputBytes: decisionJsonBytes(read.input),
                  sources: read.sources.map((source) => ({
                    id: source.id,
                    sha256: source.sha256,
                    bytes: source.bytes,
                    roles: source.roles,
                    actor: source.actor,
                    complete: true,
                    settled: true,
                    frozen: true,
                  })),
                },
                legalActions: frozen.metadata.allowedAgentIds.map((actor) => ({
                  action: 'route_send',
                  actor,
                  authorizationId: handoff!.id,
                  authorizationCurrent: true,
                  businessBudgetAvailable: true,
                })),
                admission: {
                  enabled: settings.enabled,
                  keyConfigured: settings.credential.configured,
                  runtimeAdmission: admission,
                  evaluationResourcesAvailable: true,
                  factAlreadyEvaluated: false,
                  pendingUserInput: Boolean(
                    this.core.conversations.receivedCollaborationInput(input.sessionId),
                  ),
                  nativeInteraction:
                    this.core.interactions.pendingNativeInteractions(input.sessionId).length > 0,
                  newTaskDispatchProtected: false,
                },
              })
              if (
                policy.kind !== 'eligible' ||
                !policy.candidates.length ||
                candidates.length !== policy.candidates.length ||
                candidates.some(
                  (candidate) => !policy.candidates.some((legal) => legal.id === candidate.id),
                )
              )
                throw new RunOperationConflictError(
                  'The frozen input does not need recipient advice.',
                )
              material = {
                inputSha256: read.inputSha256,
                sourceFingerprint: read.sourceFingerprint,
              }
              return read.input
            },
          },
          controller.signal,
        )
        const selected = outcome.kind === 'selection' ? outcome.selection.candidateId : undefined
        const parsedSelectedRoute = routeCandidateIdSchema.safeParse(selected)
        recordDiagnostic({
          operation: 'send',
          phase: outcome.kind === 'selection' ? 'ready' : 'blocked',
          level: 'info',
          sessionId: input.sessionId,
          inputAdviceResult:
            outcome.kind === 'unavailable'
              ? outcome.reason
              : selected === null
                ? 'no_advice'
                : selected === 'clarify_prepared_input'
                  ? selected
                  : parsedSelectedRoute.success
                    ? parsedSelectedRoute.data
                    : 'other_candidate',
        })
        if (
          outcome.kind === 'selection' &&
          material &&
          parsedSelectedRoute.success &&
          isAgentInPair(agentIdForRouteCandidate(parsedSelectedRoute.data), activePair)
        ) {
          options.inputRouting = {
            version: 'input-routing-v1',
            ...material,
            ...outcome.evaluationReceipt,
            candidateId: parsedSelectedRoute.data,
          }
          options.preparedSelectionCurrent = () =>
            Boolean(
              scope &&
              this.core.runtimePreparation.catalogIdentity(scope.directoryPath) ===
                configurationKey,
            )
        }
        if (
          outcome.kind === 'selection' &&
          material &&
          receipt &&
          outcome.selection.candidateId === 'clarify_prepared_input' &&
          !controller.signal.aborted &&
          !this.core.disposed &&
          !this.core.interactions.pendingNativeInteractions(input.sessionId).length &&
          scope &&
          this.core.runtimePreparation.catalogIdentity(scope.directoryPath) === configurationKey
        ) {
          try {
            this.core.conversations.proposePreparedInputInformation({
              receipt,
              original: input,
              selection: outcome.selection,
              evaluation: outcome.evaluationReceipt,
              ...material,
            })
            held = true
            const patch = {
              ...this.core.conversations.metadataPatch(input.sessionId),
              sendDisposition: 'held_for_information' as const,
            }
            this.core.publish(patch)
            return { ok: true, value: patch }
          } catch (error) {
            // An inadmissible auxiliary question never adds a new obstacle to the original Send.
            if (!(error instanceof RunOperationConflictError)) throw error
            recordDiagnostic({
              operation: 'send',
              phase: 'blocked',
              level: 'info',
              sessionId: input.sessionId,
              code: 'CONFLICT',
              informationAdviceRefusal:
                error instanceof PreparedInformationConflictError
                  ? error.informationAdviceRefusal
                  : 'host_validation',
            })
          }
        }
      }
      if (this.core.disposed || controller.signal.aborted || this.core.gate.nativeQuitSealed())
        throw new RunOperationConflictError(
          'This preparation ended without sending. Your draft is preserved.',
        )
      // PATH preparation shares the existing native-preparation budget, outside advisory time.
      options.preparationDeadlineAt ??=
        Date.now() + this.core.sessionPreparationTimeoutMs(input.sessionId) - environmentElapsed
      return await this.sendAdmitted(input, controller, options)
    } catch (error) {
      return this.core.sendFailure(error)
    } finally {
      receipt ??= options.preparedInput
      if (
        !held &&
        receipt &&
        this.core.conversations.cancelPreparedInputDispatch(
          receipt,
          controller.signal.aborted ? 'cancelled' : 'preparation_failed',
        )
      )
        this.core.publish(
          this.core.conversations.metadataPatch(input.sessionId, { draftsChanged: true }),
        )
      if (
        handoff &&
        this.core.decisionRuntime?.kind === 'evaluation' &&
        this.core.decisionRuntime.handoff?.id === handoff.id
      )
        this.core.scheduling.releaseDecisionHandoff(this.core.decisionRuntime)
    }
  }

  private async sendAdmitted(
    input: ConversationSendInput,
    controller: AbortController,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    const cancelled = Promise.withResolvers<RpcResult<PreparedSession>>()
    const onAbort = (): void => {
      cancelled.resolve({
        ok: false,
        error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
      })
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
    options.preparationDeadlineAt ??=
      Date.now() + this.core.sessionPreparationTimeoutMs(input.sessionId)
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, options.preparationDeadlineAt - Date.now()),
    )
    try {
      const context = await Promise.race([
        this.core.prepareSession(input.sessionId, controller.signal),
        cancelled.promise,
      ])
      if (this.core.disposed) return this.core.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      if (!context.ok) return context
      const commandPrefix = parseComposerCommandPrefix(input.content, input.skills)
      if (commandPrefix.error) throw new RunOperationConflictError(commandPrefix.error)
      if (commandPrefix.btw)
        throw new RunOperationConflictError(
          '/btw opens a side chat instead of sending a regular message.',
        )
      if (context.value.session.parentSessionId && commandPrefix.pact)
        throw new RunOperationConflictError(
          'Side chats cannot run /plan, /build, or /review commands.',
        )
      if (
        commandPrefix.pact &&
        this.core.conversations.receivedCollaborationInput(input.sessionId)?.id !==
          options.receivedInputId &&
        this.core.conversations.receivedCollaborationInput(input.sessionId)
      )
        throw new RunOperationConflictError(
          'Handle or cancel the received input before starting a new Pact task.',
        )
      if (
        !options.initialRolesConsidered &&
        !options.preparedInput &&
        !options.collaboration &&
        !options.receivedInputId &&
        !options.queuedRoute &&
        !options.sourceProposalId &&
        !options.preserveDraftComments &&
        commandPrefix.pact &&
        !input.returnedInputOperationId &&
        !input.queueReturnOperationId &&
        !input.replyToDecision &&
        !input.imageIds?.length &&
        !input.skills?.length &&
        !this.core.interactions.pendingNativeInteractions(input.sessionId).length
      ) {
        options.initialRolesConsidered = true
        await this.core.collaboration.consultInitialTaskRoles(
          input,
          context.value,
          controller,
          options,
        )
      }
      if (commandPrefix.pact && !pactCommandRouteAllowed(input.route, commandPrefix.route))
        throw new RunOperationConflictError(
          'The explicit Agent recipients conflict. Your draft was preserved.',
        )
      const requestedRoute = input.route ?? commandPrefix.route
      const activePair = resolveActiveAgentPair(context.value.session.settings)
      const [primaryAgentId, secondaryAgentId] = activePair
      let route: ConversationMessageRoute =
        options.queuedRoute ??
        (requestedRoute?.type === 'agent'
          ? { type: 'agent', agentId: requestedRoute.agentId }
          : requestedRoute?.type === 'all'
            ? {
                type: 'all',
                firstAgentId: primaryAgentId,
                secondAgentId: secondaryAgentId,
              }
            : {
                type: 'primary',
                agentId:
                  options.collaboration && !commandPrefix.pact
                    ? this.core.conversations.collaborationReplyActor(options.collaboration)
                    : primaryAgentId,
              })
      if (input.returnedInputOperationId) {
        const original = this.core.conversations.returnedInputRoute(
          input.sessionId,
          input.returnedInputOperationId,
        )
        if (!input.route) route = original
      }
      if (options.preparedInput) {
        if (options.preparedSelectionCurrent && !options.preparedSelectionCurrent()) {
          options.inputRouting = undefined
          options.initialTaskRoles = undefined
        }
        route = {
          type: 'primary',
          agentId: this.core.conversations.preparedInputRecipient(
            options.preparedInput,
            options.initialTaskRoles ?? options.inputRouting,
          ),
        }
      }
      const entryRolePolicy = options.receivedInputId ? options.queuedRolePolicy : 'split-stages-v1'
      const taskRoles = options.preparedInput?.metadata.taskRoles
      const entryAgent =
        options.receivedInputId && entryRolePolicy && route.type !== 'all'
          ? route.agentId
          : requestedRoute?.type === 'agent'
            ? requestedRoute.agentId
            : undefined
      const entryPrimary =
        taskRoles?.primaryAgentId ??
        (commandPrefix.pact
          ? pactEntryPrimary(commandPrefix.pact, primaryAgentId, entryAgent, secondaryAgentId)
          : primaryAgentId)
      const entryStageRoles = taskRoles
        ? this.core.conversations.preparedInitialTaskRoles(
            options.preparedInput!,
            options.initialTaskRoles,
          )
        : entryRolePolicy
          ? defaultTaskStageRoles(entryPrimary, otherAgent(entryPrimary, activePair))
          : undefined
      if (!options.collaboration && commandPrefix.pact && entryRolePolicy) {
        const stage = collaborationInitialStage(commandPrefix.pact)
        const entryActor = collaborationActor(
          {
            kind: commandPrefix.pact,
            owner: entryPrimary,
            reviewer: otherAgent(entryPrimary, activePair),
            rolePolicy: entryRolePolicy,
            ...(entryStageRoles ? { stageRoles: entryStageRoles } : {}),
          },
          stage,
        )
        if (route.type === 'all' || (route.type === 'agent' && route.agentId !== entryActor))
          throw new RunOperationConflictError(
            `This Pact ${commandPrefix.pact} stage belongs to ${entryActor}. Remove the conflicting Agent recipient; your draft is preserved.`,
          )
        route = { ...route, agentId: entryActor }
      }
      const targets =
        route.type === 'all' ? [route.firstAgentId, route.secondAgentId] : [route.agentId]
      const allowedTargetPair: readonly [RuntimeAgentId, RuntimeAgentId] = options.collaboration
        ? [options.collaboration.owner, options.collaboration.reviewer]
        : activePair
      for (const target of targets) {
        if (!isAgentInPair(target, allowedTargetPair)) {
          throw new RunOperationConflictError(
            `${agentDisplayName(target)} is not in this Session's active Agent pair. Your draft was preserved.`,
          )
        }
      }
      const agentId = targets[0]!
      const skillInvocation = await this.core.skills.prepareSkillInvocation(
        input,
        targets,
        controller.signal,
      )
      const agentSettings = context.value.session.settings.agents[agentId]
      // A saved, evidence-backed ready binding does not need a new startup probe.
      for (const target of targets) {
        const binding = this.core.conversations.nativeContext(input.sessionId, target)
        if (binding && binding.continuationState !== 'ready')
          return this.core.nativeRecoveryRequired()
      }
      const preparing = this.core.preparingSends.get(input.clientMessageId)
      if (preparing?.controller === controller) preparing.protectedAgentId = agentId
      const adapter = await this.core.adapterFor(
        input.sessionId,
        agentId,
        context.value.executablePaths[agentId],
        controller.signal,
        context.value.projectDirectory,
      )
      const nativeContext = this.core.conversations.nativeContext(input.sessionId, agentId)
      const handoff = await this.core.collectHandoff(
        input.sessionId,
        agentId,
        controller.signal,
        undefined,
        undefined,
        Boolean(options.collaboration || commandPrefix.pact),
      )
      if (this.core.disposed) return this.core.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      // The Repository freezes every draft member atomically at the expected revision.
      // The prompt carries only the resulting Batch reference; no mounted-page IDs limit delivery.
      const drafts: AnchoredComment[] = []
      const prompt = this.promptEnvelope(
        input.sessionId,
        { id: input.clientMessageId, content: input.content },
        drafts,
        handoff,
        this.core.conversations.resolveMessageImages(
          input.sessionId,
          input.imageIds ?? [],
          options.imageOwnerKey,
        ),
        options.imageOwnerKey,
      )
      let collaboration = options.collaboration
      if (!collaboration && commandPrefix.pact) {
        const kind = commandPrefix.pact
        const task =
          input.content.slice(commandPrefix.argumentsStart).trim() ||
          'Use the explicit conversation context if it establishes the task. Otherwise ask at most three material questions before proceeding. No implementation scope is authorized until clarified.'
        const owner = entryRolePolicy
          ? entryPrimary
          : kind === 'review'
            ? otherAgent(agentId, activePair)
            : agentId
        collaboration = collaborationTaskSchema.parse({
          protocol: COLLABORATION_PROTOCOL,
          id: randomUUID(),
          sessionId: input.sessionId,
          kind,
          revision: 0,
          owner,
          reviewer: entryRolePolicy
            ? otherAgent(owner, activePair)
            : kind === 'review'
              ? agentId
              : otherAgent(owner, activePair),
          ...(entryStageRoles ? { stageRoles: entryStageRoles } : {}),
          ...(entryRolePolicy ? { rolePolicy: entryRolePolicy } : {}),
          task,
          taskMessageId: input.clientMessageId,
          stage: kind === 'plan' ? 'plan' : kind === 'build' ? 'implement' : 'code_review',
          actor: agentId,
          status: 'running',
          automation: 'active',
          openMode: kind !== 'plan',
          ...(kind === 'plan' ? { planAuthor: agentId } : {}),
          ...(kind === 'build' ? { lastCodeActor: agentId } : {}),
          runId: input.clientMessageId,
          inputSequence: 0,
          handledInputSequence: 0,
          planVersion: 0,
          discussionRounds: 0,
          reviewCycles: kind === 'review' ? 1 : 0,
          repairAttempts: 0,
        })
      }
      if (collaboration) {
        prompt.collaboration = this.core.conversations.collaborationPromptState(collaboration)
        prompt.collaborationBasis = await this.collaborationBasis(
          prompt.collaboration,
          prompt.message.id,
          controller.signal,
        )
      }
      if (skillInvocation) {
        prompt.skillInvocation = skillInvocation
        prompt.targetAgentId = agentId
      }
      this.core.contextBroker.assertPromptFitsBudget(prompt, agentId)
      if (!collaboration)
        adapter.preflightPrompt?.({
          runId: input.clientMessageId,
          sessionId: input.sessionId,
          ...(nativeContext ? { nativeSessionId: nativeContext.nativeSessionId } : {}),
          peerAssistanceAllowed: route.type !== 'all',
          cwd: context.value.projectDirectory,
          promptEnvelope: prompt,
          model: agentSettings.model,
          effort: agentSettings.effort,
        })
      if (this.core.disposed) return this.core.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return this.core.nativeRecoveryRequired()
      if (
        this.core.conversations
          .nativeContexts(input.sessionId)
          .some(
            (binding) =>
              binding.continuationState === 'responding' ||
              binding.continuationState === 'waiting_user',
          )
      )
        return this.core.capacityFailure()
      for (const target of targets) {
        const binding = this.core.conversations.nativeContext(input.sessionId, target)
        if (binding && binding.continuationState !== 'ready')
          return this.core.nativeRecoveryRequired()
      }
      const binding = this.core.conversations.nativeContext(input.sessionId, agentId)
      if (
        binding?.bindingGeneration !== nativeContext?.bindingGeneration ||
        binding?.nativeSessionId !== nativeContext?.nativeSessionId
      )
        throw new RunOperationConflictError(
          'The native binding changed during message preparation.',
        )
      if (
        options.preparedInput &&
        (options.inputRouting || options.initialTaskRoles) &&
        (!options.preparedSelectionCurrent?.() ||
          this.core.conversations.preparedInputRecipient(
            options.preparedInput,
            options.initialTaskRoles ?? options.inputRouting,
          ) !== agentId ||
          (options.initialTaskRoles &&
            !isDeepStrictEqual(
              this.core.conversations.preparedInitialTaskRoles(
                options.preparedInput,
                options.initialTaskRoles,
              ),
              collaboration?.stageRoles,
            )))
      ) {
        options.inputRouting = undefined
        options.initialTaskRoles = undefined
        // A stale recommendation returns to the frozen default within the same business deadline.
        return await this.sendAdmitted(input, controller, options)
      }
      if (this.core.gate.hasBlockingBackgroundWork(input.sessionId))
        throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
      if (options.originSideChat) {
        const gateFailure = this.core.sideChats.checkSideChatSyncGateFailure(
          options.originSideChat.sideChatId,
          input.sessionId,
        )
        if (gateFailure) return gateFailure
      }
      let effectiveSettingsRevision = context.value.session.settingsRevision
      let effectiveSessionSettings = context.value.session.settings
      let effectiveAgentSettings = agentSettings
      if (
        (!options.sourceMessageId || Boolean(options.sourceProposalId)) &&
        !options.receivedInputId &&
        !options.collaborationActionReceiptId
      ) {
        const latestSession = this.core.sessions.find(input.sessionId)
        const latestAllowedPair: readonly [RuntimeAgentId, RuntimeAgentId] | undefined =
          latestSession
            ? options.collaboration
              ? [options.collaboration.owner, options.collaboration.reviewer]
              : resolveActiveAgentPair(latestSession.settings)
            : undefined
        if (
          !latestSession ||
          latestSession.status === 'archived' ||
          latestSession.settingsRevision !== context.value.session.settingsRevision ||
          (options.expectedSettingsRevision !== undefined &&
            latestSession.settingsRevision !== options.expectedSettingsRevision) ||
          !latestAllowedPair ||
          targets.some((target) => !isAgentInPair(target, latestAllowedPair))
        ) {
          await this.core.reconcileSessionSettingsChanged(input.sessionId).catch(() => undefined)
          throw new RunOperationConflictError(
            options.sourceProposalId
              ? 'Session settings changed while preparing this peer request. The request remains pending.'
              : 'Session settings changed while preparing your message. Your draft was preserved.',
          )
        }
      } else if (options.receivedInputId) {
        const liveSession = this.core.sessions.find(input.sessionId)
        if (!liveSession || liveSession.status === 'archived') {
          throw new RunOperationConflictError('Session is unavailable.')
        }
        const liveAllowedPair: readonly [RuntimeAgentId, RuntimeAgentId] = options.collaboration
          ? [options.collaboration.owner, options.collaboration.reviewer]
          : resolveActiveAgentPair(liveSession.settings)
        const retiredTarget = targets.find((target) => !isAgentInPair(target, liveAllowedPair))
        if (retiredTarget) {
          await this.core.reconcileSessionSettingsChanged(input.sessionId).catch(() => undefined)
          throw new RunOperationConflictError(
            `${agentDisplayName(retiredTarget)} is no longer in this Session's active Agent pair.`,
          )
        }
        if (liveSession.settingsRevision !== context.value.session.settingsRevision) {
          await this.core.reconcileSessionSettingsChanged(input.sessionId).catch(() => undefined)
        }
        effectiveSettingsRevision = liveSession.settingsRevision
        effectiveSessionSettings = liveSession.settings
        effectiveAgentSettings = liveSession.settings.agents[agentId]
      }
      const started = this.core.conversations.beginRun({
        preparedInput: options.preparedInput,
        inputRouting: options.inputRouting,
        initialTaskRoles: options.initialTaskRoles,

        ...(options.receivedInputId ? { receivedInputId: options.receivedInputId } : {}),
        ...(collaboration ? { collaboration } : {}),
        schedulingHandoff: options.schedulingHandoff,
        expectedCollaborationRevision: options.expectedCollaborationRevision,
        collaborationActionReceiptId: options.collaborationActionReceiptId,
        ...(skillInvocation ? { skillInvocation } : {}),
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        ...(input.userInformation ? { userInformation: input.userInformation } : {}),
        ...(input.replyToDecision ? { replyToDecision: input.replyToDecision } : {}),
        ...(input.replaceTask ? { replaceTask: input.replaceTask } : {}),
        ...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
        ...(options.imageOwnerKey ? { imageOwnerKey: options.imageOwnerKey } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.returnedInputOperationId
          ? { returnedInputOperationId: input.returnedInputOperationId }
          : {}),
        ...(input.queueReturnOperationId
          ? { queueReturnOperationId: input.queueReturnOperationId }
          : {}),
        expectedCommentsRevision: input.expectedCommentsRevision,
        commentIds: input.commentIds,
        freezeDrafts: input.freezeDrafts ?? !options.preserveDraftComments,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        agentId,
        settingsRevision: effectiveSettingsRevision,
        model: effectiveAgentSettings.model,
        effort: effectiveAgentSettings.effort,
        route,
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.sourceProposalId ? { sourceProposalId: options.sourceProposalId } : {}),
        ...(options.preserveDraftComments ? { preserveDraftComments: true } : {}),
        ...(options.originSideChat ? { originSideChat: options.originSideChat } : {}),
        ...(options.syncMainOperationId
          ? { syncMainOperationId: options.syncMainOperationId }
          : {}),
        handoffSourceRefs: handoff.sourceRefs,
        ...(context.value.session.titleSource === 'placeholder' && input.content.trim()
          ? {
              suggestedTitle: this.core.localTitle(
                input.content,
                context.value.session.parentSessionId ? 'New side chat' : 'New session',
              ),
            }
          : {}),
      })
      prompt.inputBatchRef = this.core.conversations.inputBatchForRun(started.run.id) ?? undefined
      const clarification = this.core.conversations.preparedAnswerForRun(started.run.id)
      prompt.clarificationAnswer = clarification?.document
      prompt.userClarification = clarification
      if (collaboration) {
        prompt.collaborationAuthorization =
          this.core.conversations.collaborationTurnAuthorization(started.run.id) ?? undefined
        prompt.collaboration = this.core.conversations.collaborationPromptState(
          this.core.conversations.collaboration(input.sessionId, started.run.id, false)!,
        )
        prompt.requiredInputScopeRef = prompt.collaborationAuthorization?.sourceManifestRef
      }
      this.core.publish(started.patch)
      if (started.created) {
        this.core.interactions.cancelTitleEnrichment(input.sessionId)
        const frozenSettingsForExecution =
          this.core.sessions.findSettingsRevision(input.sessionId, started.run.settingsRevision) ??
          effectiveSessionSettings
        void this.core.executor.execute(
          started.run,
          prompt,
          context.value.projectDirectory,
          frozenSettingsForExecution,
          context.value.executablePaths,
        )
      }
      return { ok: true, value: started.patch }
    } catch (error) {
      if (error instanceof RunOperationConflictError) {
        await this.core.reconcileSessionSettingsChanged(input.sessionId).catch(() => undefined)
      }
      return this.core.sendFailure(error)
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      const entry = this.core.preparingSends.get(input.clientMessageId)
      if (entry?.controller === controller) this.core.preparingSends.delete(input.clientMessageId)
    }
  }

  promptEnvelope(
    sessionId: string,
    message: Pick<ConversationSnapshot['messages'][number], 'id' | 'content'>,
    comments: AnchoredComment[],
    handoff?: CollectedHandoff,
    pendingImages?: ConversationImage[],
    imageOwner?: string,
  ): AgentPromptEnvelope {
    return this.core.contextBroker.buildPromptEnvelope({
      sessionId,
      message,
      comments,
      handoff,
      pendingImages,
      imageOwner,
    })
  }

  collaborationBasis(
    task: CollaborationTask,
    currentMessageId: string,
    signal: AbortSignal,
  ): Promise<AgentPromptEnvelope['collaborationBasis']> {
    return loadCollaborationBasis(
      this.core.conversations,
      this.core.images,
      task,
      currentMessageId,
      signal,
    )
  }

  authorizedCutoffsForEnvelope(
    run: Pick<AgentRun, 'sessionId' | 'userMessageId'> & { id?: string | undefined },
    envelope: AgentPromptEnvelope,
    isSideChat: boolean,
  ): string[] {
    return this.core.contextBroker.authorizedCutoffsForEnvelope(run, envelope, isSideChat)
  }

  attachCutoffSupplement(
    sessionId: string,
    agentId: RuntimeAgentId,
    bindingGeneration: number,
    envelope: AgentPromptEnvelope,
    authorizedCutoffIds: readonly string[],
  ): string[] {
    return this.core.contextBroker.attachCutoffSupplement(
      sessionId,
      agentId,
      bindingGeneration,
      envelope,
      authorizedCutoffIds,
    )
  }
}
