import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { AgentPromptEnvelope } from '@pact/agent-runtime'
import type {
  AnchoredComment,
  CollaborationActionInput,
  CollaborationTask,
  ConversationPatch,
  ConversationSendInput,
  DefaultSessionSettings,
  PeerProposalAcceptInput,
  PeerProposalDismissInput,
  PeerRequestKind,
  RelayDecisionMaterial,
  RpcResult,
  RuntimeAgentId,
  SchedulingHandoff,
} from '@pact/contracts'
import type { ConversationRepository } from '@pact/persistence'

import {
  advanceAutomaticCollaboration,
  agentDisplayName,
  agentIdForRouteCandidate,
  collaborationActionPrompt,
  collaborationActor,
  collaborationInputGate,
  CollaborationTransitionError,
  decisionJsonBytes,
  deriveCollaborationDecision,
  initialTaskRoleCandidateIdSchema,
  isAgentInPair,
  isCollaborationOpenMode,
  otherAgent,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  routeCandidateIdSchema,
} from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationImages } from '../conversation-images'
import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type {
  ActiveExecution,
  DecisionInvocationOwner,
  PreparedSession,
  PreparingContinuation,
  SendOptions,
} from '../conversation-types'

import { AgentExecutionError } from '../agent-execution-error'
import { MAX_AGENT_OPERATIONS } from '../conversation-types'
import { evaluateRelayPolicy } from '../relay-policy'

export interface PendingRoutedContinuation {
  sessionId: string
  userMessageId: string
  agentId: RuntimeAgentId
}

export function pendingContinuationFailureCopy(agentId: RuntimeAgentId, error: unknown): string {
  const name = agentDisplayName(agentId)
  const detail = error instanceof Error ? error.message.trim() : ''
  return `${name} could not start the second @all response.${detail ? ` ${detail.slice(0, 300)}` : ''}`
}

export function peerActionCopy(kind: PeerRequestKind, source: string): string {
  switch (kind) {
    case 'supplement':
      return `Supplement ${source}’s previous response.`
    case 'fact_check':
      return `Verify the key facts in ${source}’s previous response.`
    case 'challenge':
      return `Challenge the assumptions and conclusions in ${source}’s previous response.`
    case 'review':
      return `Review ${source}’s previous response.`
  }
  throw new Error('Unsupported peer request kind.')
}

export async function loadCollaborationBasis(
  conversations: ConversationRepository,
  images: ConversationImages | undefined,
  task: CollaborationTask,
  currentMessageId: string,
  signal: AbortSignal,
): Promise<AgentPromptEnvelope['collaborationBasis']> {
  const read = async (id: string | undefined) => {
    if (!id || id === currentMessageId) return undefined
    const source = await conversations.readCollaborationSource(task.sessionId, id, signal)
    const resolvedImages = (source.images ?? []).map((image) => {
      if (!images) throw new Error('Task images are unavailable.')
      return images.resolve(task.sessionId, image)
    })
    return {
      id,
      content: source.content,
      inputBatchRef: conversations.inputBatchForMessage(task.sessionId, id) ?? undefined,
      comments: source.comments.map(({ id: commentId, body, anchor }) => ({
        id: commentId,
        body,
        anchor,
      })),
      ...(resolvedImages.length ? { images: resolvedImages } : {}),
    }
  }
  const original = await read(task.taskMessageId)
  const latest =
    task.latestUserMessageId !== task.taskMessageId
      ? await read(task.latestUserMessageId)
      : undefined
  return { ...(original ? { original } : {}), ...(latest ? { latest } : {}) }
}

export function deriveCollaborationNotification(
  conversations: ConversationRepository,
  task: CollaborationTask,
): ConversationPatch['collaborationNotification'] {
  if (task.ending) return undefined
  const currentRun = conversations.findRun(task.runId)
  const runSettled =
    currentRun?.status === 'completed' &&
    currentRun.outputSnapshots?.settled !== false &&
    currentRun.nativeEffectsState !== 'pending' &&
    currentRun.nativeEffectsState !== 'unknown'
  if (
    runSettled &&
    !task.inputProcessing?.pending &&
    ((task.inputProcessing?.settled?.runId === task.runId &&
      Boolean(task.inputProcessing.settled.unchanged)) ||
      (task.authorization?.runId === task.runId &&
        task.authorization.replyIntentBasis?.kind === 'ask_only' &&
        Boolean(task.authorization.replyIntentBasis.askCheckpoint)))
  ) {
    return {
      taskId: task.id,
      revision: task.revision,
      runId: task.runId,
      state: 'complete',
      agentId: currentRun.agentId,
    }
  }
  const decision = deriveCollaborationDecision(task)
  type Notification = NonNullable<ConversationPatch['collaborationNotification']>
  let state: Notification['state'] | undefined
  if (task.status === 'complete') state = currentRun && !runSettled ? 'working' : 'complete'
  else if (task.status === 'failed') {
    if (task.pauseReason !== 'stopped') state = 'failure'
  } else if (decision.inputGate === 'incomplete') state = 'failure'
  else if (decision.inputGate === 'needs_reply') state = 'needs_user'
  else if (decision.inputGate === 'processing' || decision.inputGate === 'queued') state = 'working'
  else if (task.status === 'running') state = 'working'
  else if (task.status === 'questions' || task.status === 'ready') state = 'needs_user'
  else if (!isCollaborationOpenMode(task) && task.automation === 'paused') {
    if (task.pauseReason === 'user_message') state = 'working'
    else if (task.pauseReason !== 'stopped')
      state = task.pauseReason === 'failure' ? 'failure' : 'needs_user'
  } else if (decision.nextStage) state = 'auto_continue'
  else
    state =
      isCollaborationOpenMode(task) && decision.availableActions.length === 0
        ? runSettled
          ? 'complete'
          : 'working'
        : 'needs_user'
  return state
    ? {
        taskId: task.id,
        revision: task.revision,
        runId: task.runId,
        state,
        agentId: task.actor,
      }
    : undefined
}

/**
 * Autonomous deep coordinator owning collaboration workflow actions, Relay workflow
 * consultations, peer proposals, routed `@all` continuations, and the coalesced
 * continuation/recovery scheduler directly against `ConversationRuntimeCore`.
 * Replaces the former `ConversationCollaborationHost` and `ConversationHandoffHost` bags.
 */
export class CollaborationAndHandoffCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  collaborationNotification(
    task: CollaborationTask,
  ): ConversationPatch['collaborationNotification'] {
    return deriveCollaborationNotification(this.core.conversations, task)
  }

  actOnCollaboration(input: CollaborationActionInput): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return Promise.resolve(this.core.shuttingDown())
    if (this.core.gate.nativeQuitSealed()) return Promise.resolve(this.core.quitPrepared())
    if (this.core.conversations.archives.blocksSession(input.sessionId)) {
      return Promise.resolve(this.core.archiveBusy())
    }
    const request = JSON.stringify({
      taskId: input.taskId,
      revision: input.revision,
      action: input.action,
      clientMessageId: input.clientMessageId,
    })
    const existing = this.core.collaborationActions.get(input.sessionId)
    if (existing) {
      return existing.request === request
        ? existing.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'A collaboration action is already starting.' },
          })
    }
    const entry = {
      request,
      task: this.actOnCollaborationAdmitted(input).finally(() => {
        if (this.core.collaborationActions.get(input.sessionId) === entry) {
          this.core.collaborationActions.delete(input.sessionId)
        }
      }),
    }
    this.core.collaborationActions.set(input.sessionId, entry)
    return entry.task
  }

  abortPreparedWorkflow(sessionId: string): void {
    for (const preparing of this.core.preparingSends.values()) {
      if (
        preparing.input.sessionId === sessionId &&
        (preparing.options.collaboration || preparing.options.receivedInputId)
      ) {
        preparing.controller.abort()
      }
    }
  }

  async startWorkflowTurn(
    task: CollaborationTask,
    next: CollaborationTask,
    clientMessageId: string = randomUUID(),
    collaborationActionReceiptId?: string,
    schedulingHandoff?: SchedulingHandoff,
    action?: CollaborationActionInput['action'],
  ): Promise<RpcResult<ConversationPatch>> {
    const options: SendOptions = {
      preserveDraftComments: true,
      collaboration: next,
      expectedCollaborationRevision: task.revision,
      collaborationActionReceiptId,
    }
    try {
      options.schedulingHandoff =
        schedulingHandoff ?? this.core.conversations.workflowHandoff(task, next.actor)
      const drafts = this.core.conversations.readPage({
        scope: 'drafts',
        sessionId: task.sessionId,
      })
      if (drafts.scope !== 'drafts') {
        return this.core.sendFailure(new Error('Comment drafts are unavailable.'))
      }
      const content = `@${next.actor} ${collaborationActionPrompt(next, action)}`
      return await this.core.sendAndSteer.enqueueSend(
        {
          sessionId: task.sessionId,
          clientMessageId,
          content,
          route: { type: 'agent', agentId: next.actor },
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
          freezeDrafts: false,
        },
        options,
      )
    } finally {
      options.schedulingHandoff = undefined
    }
  }

  /** Advisory-only initial-role consult: a choice is an ID only; the host metadata supplies roles. */
  async consultInitialTaskRoles(
    input: ConversationSendInput,
    prepared: PreparedSession,
    controller: AbortController,
    options: SendOptions,
  ): Promise<void> {
    const settings = this.core.conversations.schedulingSettings()
    if (!settings.enabled || !settings.credential.configured) return
    if (this.core.scheduling.decisionRuntimeAdmission() !== 'may_attempt') return
    const activePair = resolveActiveAgentPair(prepared.session.settings)
    const orderedPair = (['codex', 'claude', 'agy'] as const).filter((actor) =>
      isAgentInPair(actor, activePair),
    )
    const opportunity = this.core.conversations.initialTaskRoleOpportunity(input, orderedPair)
    if (!opportunity) return
    const configurationKey = this.core.runtimePreparation.catalogIdentity(prepared.projectDirectory)
    let material: { inputSha256: string; sourceFingerprint: string } | undefined
    const outcome = await this.core.scheduling.evaluateDecision(
      {
        sessionId: input.sessionId,
        prepare: async (decisionContext) => {
          const receipt = this.core.conversations.prepareInputDispatch(
            input,
            randomUUID(),
            orderedPair,
            decisionContext,
            'task_roles',
          )
          options.preparedInput = receipt
          this.core.publish(
            this.core.conversations.metadataPatch(input.sessionId, { draftsChanged: true }),
          )
          const frozen = receipt.metadata.taskRoles!
          const candidates = frozen.candidates.map((candidate) => ({
            id: candidate.id,
            description: `Assign ${candidate.roles.planAuthor} to author plans and ${candidate.roles.planReviewer} to review plans; assign ${candidate.roles.codeAuthor} to implement, respond and repair, and ${candidate.roles.codeReviewer} to review code. Keep the original scope and permissions; implementation after planning and every new repair still require their existing user authorization.`,
          }))
          const read = await this.core.conversations.readPreparedInputDecisionSources(
            receipt,
            candidates,
            decisionContext,
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
    if (outcome.kind === 'selection' && material) {
      const candidateId = outcome.selection.candidateId
      if (
        candidateId === null ||
        opportunity.candidates.some((candidate) => candidate.id === candidateId)
      ) {
        if (candidateId !== null) {
          options.initialTaskRoles = {
            version: 'initial-task-roles-v1',
            ...material,
            ...outcome.evaluationReceipt,
            candidateId: initialTaskRoleCandidateIdSchema.parse(candidateId),
          }
        }
        options.preparedSelectionCurrent = () =>
          this.core.runtimePreparation.catalogIdentity(prepared.projectDirectory) ===
          configurationKey
      }
    }
  }

  /** Advisory-only consult: proposals never execute; false keeps the lawful default step. */
  async consultWorkflowAlternatives(
    task: CollaborationTask,
    handoff: SchedulingHandoff,
  ): Promise<void> {
    let material: Omit<RelayDecisionMaterial, 'input'> | undefined
    let limitAttempt = false
    try {
      const preferences = this.core.conversations.schedulingSettings()
      if (!preferences.enabled || !preferences.credential.configured) return
      if (this.core.conversations.decisionEvaluationReceipt(handoff)) return
      if (this.core.conversations.planReviewLimitAdviceConsidered(handoff)) return
      const runtimeAdmission = this.core.scheduling.decisionRuntimeAdmission()
      if (runtimeAdmission !== 'may_attempt') return
      const session = this.core.sessions.find(task.sessionId)
      const project = session && this.core.projects.find(session.projectId)
      if (!project) return
      const current = this.core.conversations.relayWorkflowAlternatives(handoff)
      if (!current?.alternatives.length) return
      const { alternatives } = current
      limitAttempt = current.snapshot.node === 'plan_review_limit'
      const candidates = alternatives.map((entry) =>
        entry.kind === 'extend_plan_review'
          ? {
              id: 'propose_extend_plan_review',
              description: `Propose one additional read-only review of the current plan by ${entry.actor} despite the exhausted plan-review limit. Recommend it only when the complete current plan, latest review and author response establish that another independent check is useful. User confirmation is required. This permits one review only, preserves all consumed counts and Session defaults, and grants no implementation or repair. Abstain when work is not ready for another review.`,
            }
          : {
              id: 'propose_reassign_roles',
              description: `Propose swapping future code responsibilities: ${entry.operation.proposedRoles.codeAuthor} implements, responds and repairs; ${entry.operation.proposedRoles.codeReviewer} reviews code. Propose only when the complete accepted Plan and review establish a clear benefit over the current assignment. Preserve the Plan authors, accepted artifacts, original scope and permissions. The user must confirm the role change; this does not start work or grant writing. Choose false when the current assignment remains suitable.`,
            },
      )
      const outcome = await this.core.scheduling.evaluateDecision(
        {
          handoff,
          retainHandoff: true,
          load: async (context) => {
            const read = await this.core.conversations.readRelayWorkflowDecisionSources(
              handoff,
              candidates,
              context,
            )
            const fresh = this.core.conversations.relayWorkflowAlternatives(handoff)
            if (
              !fresh ||
              read.sourceFingerprint !== current.snapshot.sourceFingerprint ||
              fresh.snapshot.sourceFingerprint !== read.sourceFingerprint ||
              !isDeepStrictEqual(fresh.alternatives, alternatives) ||
              this.core.conversations.receivedCollaborationInput(task.sessionId) ||
              collaborationInputGate(read.snapshot.task) ||
              this.core.interactions.pendingNativeInteractions(task.sessionId).length > 0
            ) {
              throw new RunOperationConflictError(
                'This workflow node does not need a decision request.',
              )
            }
            material = {
              basis: read.basis,
              sources: read.sources,
              inputSha256: read.inputSha256,
              sourceFingerprint: read.sourceFingerprint,
            }
            return read.input
          },
        },
        new AbortController().signal,
      )
      if (
        outcome.kind === 'unavailable' &&
        ['busy', 'duplicate', 'cancelled', 'stale'].includes(outcome.reason)
      ) {
        limitAttempt = false
      }
      if (outcome.kind !== 'selection' || !material || material.basis.kind !== 'workflow') return
      const chosenProposal = alternatives.find(
        (entry) => `propose_${entry.kind}` === outcome.selection.candidateId,
      )
      if (
        !chosenProposal ||
        this.core.interactions.pendingNativeInteractions(task.sessionId).length
      ) {
        return
      }
      const sourceIds = material.sources
        .filter((source) =>
          (['review', 'owner_response', 'plan'] as const).some((role) =>
            source.roles.includes(role),
          ),
        )
        .map((source) => source.id)
      if (!sourceIds.length) return
      this.core.conversations.proposeRelayWorkflowAction({
        handoff,
        kind: chosenProposal.kind,
        evaluationId: outcome.evaluationReceipt.evaluationId,
        configurationGeneration: outcome.evaluationReceipt.configurationGeneration,
        configurationFingerprint: outcome.evaluationReceipt.configurationFingerprint,
        deadlineAt: outcome.evaluationReceipt.deadlineAt,
        inputSha256: material.inputSha256,
        sourceFingerprint: material.sourceFingerprint,
        sourceIds,
      })
      this.core.publish(this.core.conversations.metadataPatch(task.sessionId))
    } catch {
      // Advisory consultation never blocks the lawful default step.
    } finally {
      if (limitAttempt) this.core.conversations.recordPlanReviewLimitAdviceConsidered(handoff)
      material = undefined
    }
  }

  private async actOnCollaborationAdmitted(
    input: CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.conversations.archives.blocksSession(input.sessionId)) {
      return this.core.archiveBusy()
    }
    await this.core.sendAndSteer.awaitSettlingExecution(input.sessionId)
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.conversations.archives.blocksSession(input.sessionId)) {
      return this.core.archiveBusy()
    }
    try {
      if (input.action === 'swap_code_roles') {
        const patch = this.core.conversations.swapCodeRoles(
          input,
          this.core.gate.hasSessionOperation(input.sessionId, true) ||
            this.core.interactions.pendingNativeInteractions(input.sessionId).length > 0,
        )
        this.core.publish(patch)
        return { ok: true, value: patch }
      }
      const context = this.core.sessions.find(input.sessionId)
      const task = this.core.conversations.collaboration(input.sessionId)
      const prior = this.core.conversations.collaborationActionReceipt(input)
      if (prior?.boundRunId) {
        return { ok: true, value: this.core.conversations.runPatch(prior.boundRunId) }
      }
      if (prior && prior.state !== 'available') {
        return { ok: true, value: this.core.conversations.metadataPatch(input.sessionId) }
      }
      if (
        !context ||
        !task ||
        task.id !== input.taskId ||
        (!prior && task.revision !== input.revision)
      ) {
        throw new RunOperationConflictError('This collaboration action is no longer current.')
      }
      if (task.status === 'complete') {
        throw new RunOperationConflictError('This collaboration is already complete.')
      }
      this.core.conversations.discardUnansweredRelaySchedulingDecision(input.sessionId, false)
      if (this.core.conversations.receivedCollaborationInput(input.sessionId)) {
        throw new RunOperationConflictError(
          'Your queued message will be answered before collaboration continues.',
        )
      }
      const planRecoveryState = this.core.conversations.workflowPlanRecoveryState(task.runId)
      if (input.action === 'recover_plan') {
        if (
          !planRecoveryState?.recoveryRequired ||
          !planRecoveryState.canRecoverNow ||
          task.automation !== 'paused'
        ) {
          throw new RunOperationConflictError('There is no paused native plan source to restore.')
        }
        const settled = this.core.conversations.reconcileCompletedCollaboration(task.runId)
        if (settled) this.core.publish(settled)
        if (!this.core.conversations.workflowPlanSettled(task.runId)) {
          const checked = await this.core.recovery.checkNativeBinding(
            input.sessionId,
            planRecoveryState.actor,
            task.runId,
          )
          if (!checked.ok) return checked
        }
        const recovered = this.core.conversations.collaboration(input.sessionId)
        if (
          !recovered ||
          recovered.id !== task.id ||
          recovered.runId !== task.runId ||
          recovered.inputSequence !== task.inputSequence ||
          !this.core.conversations.workflowPlanSettled(task.runId) ||
          this.core.conversations.needsWorkflowPlanRecovery(task.runId)
        ) {
          throw new RunOperationConflictError(
            'The saved native plan could not be restored to this task. Its source is preserved; no Agent task was started.',
          )
        }
        if (
          recovered.stage === 'reply' &&
          (collaborationInputGate(recovered) ||
            recovered.inputProcessing?.settled?.runId !== recovered.runId ||
            recovered.inputProcessing.settled.inputSequence !== recovered.inputSequence)
        ) {
          throw new RunOperationConflictError(
            'The plan was restored, but your reply still needs confirmation. Check its response or recovery notice before continuing.',
          )
        }
        return { ok: true, value: this.core.conversations.metadataPatch(input.sessionId) }
      }
      if (planRecoveryState?.canRecoverNow) {
        throw new RunOperationConflictError(
          'Restore the saved native plan before continuing collaboration.',
        )
      }
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId)) {
        return this.core.nativeRecoveryRequired()
      }
      const prepared = this.core.conversations.prepareCollaborationAction(input, context.settings)
      if (prepared.receipt.boundRunId) {
        return { ok: true, value: this.core.conversations.runPatch(prepared.receipt.boundRunId) }
      }
      if (!prepared.task || !prepared.next || !prepared.handoff) {
        throw new RunOperationConflictError('The original action preparation is unavailable.')
      }
      let consultation: DecisionInvocationOwner | undefined
      try {
        await this.consultWorkflowAlternatives(prepared.task, prepared.handoff)
        const runtime = this.core.decisionRuntime
        consultation =
          runtime?.kind === 'evaluation' && runtime.handoff?.id === prepared.handoff.id
            ? runtime
            : undefined
        const dispatched = this.startWorkflowTurn(
          prepared.task,
          prepared.next,
          input.clientMessageId,
          prepared.receipt.id,
          prepared.handoff,
          input.action,
        )
        this.core.scheduling.releaseDecisionHandoff(consultation)
        return await dispatched
      } finally {
        this.core.scheduling.releaseDecisionHandoff(consultation)
        this.core.conversations.cancelPreparedCollaborationAction(prepared.receipt.id)
      }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  canDispatchWorkflowContinuation(sessionId: string): boolean {
    return (
      !this.core.disposed &&
      !this.core.gate.nativeQuitSealed() &&
      !this.core.gate.hasSessionOperation(sessionId, true) &&
      this.core.gate.operationCount() < MAX_AGENT_OPERATIONS &&
      !this.core.conversations.receivedCollaborationInput(sessionId) &&
      !this.core.conversations.nativeRecoveryBlocksInput(sessionId) &&
      !this.core.conversations.hasPendingRoutedContinuation(sessionId) &&
      this.core.interactions.pendingNativeInteractions(sessionId).length === 0 &&
      !this.core.conversations.hasRelayDecision(sessionId)
    )
  }

  async dispatchWorkflowContinuation(sessionId: string): Promise<void> {
    this.core.conversations.discardStaleRelaySchedulingDecision(sessionId)
    if (!this.canDispatchWorkflowContinuation(sessionId)) return
    const task = this.core.conversations.collaboration(sessionId)
    const session = this.core.sessions.find(sessionId)
    if (
      !task ||
      !session ||
      session.status === 'archived' ||
      (task.automation !== 'active' && task.pauseReason !== 'limit') ||
      (task.status !== 'waiting' && task.status !== 'ready')
    ) {
      return
    }
    if (isCollaborationOpenMode(task)) return
    const decision = deriveCollaborationDecision(task)
    if (decision.inputGate) return
    if (task.automation === 'paused') {
      const handoff = this.core.conversations.workflowHandoff(
        task,
        collaborationActor(task, 'plan_review'),
      )
      await this.consultWorkflowAlternatives(task, handoff)
      const owner = this.core.decisionRuntime
      if (owner?.kind === 'evaluation' && owner.handoff?.id === handoff.id) {
        this.core.scheduling.releaseDecisionHandoff(owner)
      }
      return
    }
    if (task.status === 'ready') {
      const handoff = this.core.conversations.workflowHandoff(
        task,
        collaborationActor(task, 'implement'),
      )
      await this.consultWorkflowAlternatives(task, handoff)
      const owner = this.core.decisionRuntime
      if (owner?.kind === 'evaluation' && owner.handoff?.id === handoff.id) {
        this.core.scheduling.releaseDecisionHandoff(owner)
      }
      return
    }
    if (!decision.nextStage) {
      if (!this.core.interactions.pendingNativeInteractions(sessionId).length) {
        const handoff = this.core.conversations.workflowHandoff(
          task,
          collaborationActor(task, task.stage === 'code_review' ? 'respond' : 'plan'),
        )
        await this.consultWorkflowAlternatives(task, handoff)
        const runtime = this.core.decisionRuntime
        const consultation =
          runtime?.kind === 'evaluation' && runtime.handoff?.id === handoff.id ? runtime : undefined
        this.core.scheduling.releaseDecisionHandoff(consultation)
      }
      return
    }
    let next: CollaborationTask
    try {
      next = advanceAutomaticCollaboration(task, session.settings)
    } catch (error) {
      const current = this.core.conversations.collaboration(sessionId)
      if (current?.id !== task.id || current.revision !== task.revision) return
      const limitReached =
        error instanceof CollaborationTransitionError && error.reason.kind === 'limit'
      const notice = error instanceof Error ? error.message : 'Collaboration could not continue.'
      this.core.publish(
        this.core.conversations.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          automation: 'paused',
          pauseReason: limitReached ? 'limit' : 'failure',
          notice: notice.slice(0, 512),
        }),
      )
      if (limitReached) this.schedulePendingRoutedContinuations()
      return
    }
    let consultation: DecisionInvocationOwner | undefined
    const settings = this.core.conversations.schedulingSettings()
    if (settings.enabled && settings.credential.configured) {
      const handoff = this.core.conversations.workflowHandoff(task, next.actor)
      const activeRuntime = this.core.decisionRuntime
      if (
        activeRuntime?.kind === 'evaluation' &&
        activeRuntime.consulting &&
        activeRuntime.current() &&
        activeRuntime.handoff?.id === handoff.id
      ) {
        return
      }
      await this.consultWorkflowAlternatives(task, handoff)
      const latestRuntime = this.core.decisionRuntime
      consultation =
        latestRuntime?.kind === 'evaluation' && latestRuntime.handoff?.id === handoff.id
          ? latestRuntime
          : undefined
      if (this.core.disposed || this.core.gate.nativeQuitSealed()) {
        this.core.scheduling.releaseDecisionHandoff(consultation)
        return
      }
      if (this.core.conversations.hasRelayDecision(sessionId)) {
        this.core.scheduling.releaseDecisionHandoff(consultation)
        return
      }
      if (!this.core.conversations.evaluationIsCurrent(handoff)) {
        this.core.scheduling.releaseDecisionHandoff(consultation)
        this.schedulePendingRoutedContinuations()
        return
      }
      const hasPreparingSendForHandoff = [...this.core.preparingSends.values()].some(
        ({ options }) =>
          options.schedulingHandoff?.id === handoff.id &&
          options.schedulingHandoff.factFingerprint === handoff.factFingerprint,
      )
      if (hasPreparingSendForHandoff) {
        this.core.scheduling.releaseDecisionHandoff(consultation)
        return
      }
    }
    const preparation = this.startWorkflowTurn(task, next)
    this.core.scheduling.releaseDecisionHandoff(consultation)
    const result = await preparation
    if (!result.ok) {
      const current = this.core.conversations.collaboration(sessionId)
      if (current?.id !== task.id || current.revision !== task.revision) return
      this.core.publish(
        this.core.conversations.setCollaborationState({
          ...current,
          revision: current.revision + 1,
          automation: 'paused',
          pauseReason: 'failure',
          notice: result.error.message.slice(0, 512),
        }),
      )
    }
  }

  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>> {
    if (this.core.disposed) return Promise.resolve(this.core.shuttingDown())
    if (this.core.gate.nativeQuitSealed()) return Promise.resolve(this.core.quitPrepared())
    if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId)) {
      return Promise.resolve(this.core.nativeRecoveryRequired())
    }
    const proposal = this.core.conversations.peerProposal(input.sessionId, input.proposalId)
    if (!proposal?.run.peerProposal || proposal.run.peerProposal.state !== 'pending') {
      return Promise.resolve({
        ok: false,
        error: { code: 'CONFLICT', message: 'This peer request is no longer available.' },
      })
    }
    const targetAgentId = proposal.run.peerProposal.targetAgentId
    const session = this.core.sessions.find(input.sessionId)
    if (
      !session ||
      session.status === 'archived' ||
      !isAgentInPair(targetAgentId, resolveActiveAgentPair(session.settings))
    ) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: `${agentDisplayName(targetAgentId)} is no longer in this Session's active Agent pair.`,
        },
      })
    }
    const target = targetAgentId
    const source = agentDisplayName(proposal.run.agentId)
    const action = peerActionCopy(proposal.run.peerProposal.kind, source)
    const drafts = this.core.conversations.readPage({
      scope: 'drafts',
      sessionId: input.sessionId,
    })
    if (drafts.scope !== 'drafts') {
      return Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'Comment drafts are unavailable.' },
      })
    }
    return this.core.sendAndSteer.enqueueSend(
      {
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        content: `@${target} ${action}`,
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: targetAgentId },
      },
      {
        preserveDraftComments: true,
        sourceProposalId: input.proposalId,
        sourceMessageId: proposal.sourceMessageId,
        expectedSettingsRevision: session.settingsRevision,
      },
    )
  }

  dismissPeerProposal(input: PeerProposalDismissInput): RpcResult<ConversationPatch> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId)) {
      return this.core.nativeRecoveryRequired()
    }
    try {
      const patch = this.core.conversations.dismissPeerProposal(input.sessionId, input.proposalId)
      this.core.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof RunOperationConflictError ? 'CONFLICT' : 'INTERNAL',
          message:
            error instanceof Error ? error.message : 'The peer request could not be dismissed.',
        },
      }
    }
  }

  private async consultOpenModeInputRouting(
    sessionId: string,
    task: CollaborationTask,
    receivedId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentId> {
    const fallbackActor: RuntimeAgentId =
      task.lastCodeActor ?? collaborationActor(task, 'implement')
    const settings = this.core.conversations.schedulingSettings()
    const admission = this.core.scheduling.decisionRuntimeAdmission()
    if (
      !settings.enabled ||
      !settings.credential.configured ||
      admission !== 'may_attempt' ||
      this.core.interactions.pendingNativeInteractions(sessionId).length > 0
    ) {
      return fallbackActor
    }
    const taskPair: readonly [RuntimeAgentId, RuntimeAgentId] = [task.owner, task.reviewer]
    const orderedTaskActors = (['codex', 'claude', 'agy'] as const).filter((actor) =>
      isAgentInPair(actor, taskPair),
    )
    const bothReady = orderedTaskActors.every((actor) => {
      const ctx = this.core.conversations.nativeContext(sessionId, actor)
      return !ctx || ctx.continuationState === 'ready'
    })
    if (!bothReady) return fallbackActor
    const handoff = this.core.conversations.workflowHandoff(task, fallbackActor, receivedId)
    if (this.core.conversations.decisionEvaluationReceipt(handoff)) return fallbackActor
    const candidates = orderedTaskActors.map((actor) => ({
      id: `route_${actor}`,
      description: `Send this open-mode task message to ${actor}, preserving its current session permissions and task context.`,
    }))
    try {
      const outcome = await this.core.scheduling.evaluateDecision(
        {
          handoff,
          load: async (context) => {
            const read = await this.core.conversations.readOpenModeRoutingSources(
              sessionId,
              task,
              receivedId,
              candidates,
              context,
            )
            const policy = evaluateRelayPolicy({
              node: 'send',
              openMode: true,
              ordinary: false,
              handoffId: read.handoff.id,
              budgetSubjectId: read.handoff.budgetSubjectId,
              primary: fallbackActor,
              activePair: taskPair,
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
              legalActions: orderedTaskActors.map((actor) => ({
                action: 'route_send',
                actor,
                authorizationId: read.handoff.id,
                authorizationCurrent: true,
                businessBudgetAvailable: true,
              })),
              admission: {
                enabled: settings.enabled,
                keyConfigured: settings.credential.configured,
                runtimeAdmission: admission,
                evaluationResourcesAvailable: true,
                factAlreadyEvaluated: false,
                pendingUserInput: false,
                nativeInteraction:
                  this.core.interactions.pendingNativeInteractions(sessionId).length > 0,
                newTaskDispatchProtected: false,
              },
            })
            if (policy.kind !== 'eligible') {
              throw new RunOperationConflictError(
                'Open-mode input is not eligible for Relay routing.',
              )
            }
            return read.input
          },
        },
        signal
          ? AbortSignal.any([AbortSignal.timeout(15_000), signal])
          : AbortSignal.timeout(15_000),
      )
      if (outcome.kind === 'selection') {
        const parsedRoute = routeCandidateIdSchema.safeParse(outcome.selection.candidateId)
        if (parsedRoute.success) {
          const selectedActor = agentIdForRouteCandidate(parsedRoute.data)
          if (isAgentInPair(selectedActor, taskPair)) return selectedActor
        }
      }
      return fallbackActor
    } catch {
      return fallbackActor
    } finally {
      const runtime = this.core.decisionRuntime
      if (runtime?.kind === 'evaluation' && runtime.handoff?.id === handoff.id) {
        this.core.scheduling.releaseDecisionHandoff(runtime)
      }
    }
  }

  async dispatchReceivedInput(sessionId: string): Promise<void> {
    if (
      this.core.disposed ||
      this.core.gate.nativeQuitSealed() ||
      this.core.routingOpenInputs.has(sessionId) ||
      this.core.gate.hasSessionOperation(sessionId, true) ||
      this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS ||
      this.core.conversations.nativeRecoveryBlocksInput(sessionId)
    ) {
      return
    }
    const queue = this.core.conversations.queueState(sessionId)
    if (queue.input?.state !== 'queued') return
    if (
      this.core.conversations
        .pendingRoutedContinuations()
        .some((pending) => pending.sessionId === sessionId)
    ) {
      return
    }
    const input = this.core.conversations.readReceivedInput(sessionId)
    const task = this.core.conversations.collaboration(sessionId)
    const session = this.core.sessions.find(sessionId)
    if (
      !input ||
      (!queue.enabled && !input.taskId) ||
      input.state !== 'accepted' ||
      !session ||
      session.status === 'archived'
    ) {
      return
    }
    const prefix = parseComposerCommandPrefix(input.content, input.metadata.skills)
    const expectedInTaskReview = Boolean(input.metadata.inTaskReview)
    const actualInTaskReview = Boolean(
      input.taskId && task && this.core.conversations.isInTaskReviewCommand(task, prefix.pact),
    )
    if (
      prefix.error ||
      prefix.btw ||
      (session.parentSessionId && prefix.pact) ||
      expectedInTaskReview !== actualInTaskReview ||
      (Boolean(prefix.pact) && !expectedInTaskReview) !== input.metadata.workflowCommand ||
      (prefix.pact && input.taskId && !expectedInTaskReview)
    ) {
      this.core.publish(
        this.core.conversations.pauseConversationQueue(
          sessionId,
          prefix.error ??
            (prefix.btw
              ? '/btw opens a side chat instead of sending a regular message.'
              : session.parentSessionId && prefix.pact
                ? 'Side chats cannot run /plan, /build, or /review commands.'
                : 'The queued message no longer matches its frozen task. Edit it before sending.'),
        ),
      )
      return
    }
    const anchor = this.core.conversations.findRun(input.anchorRunId)
    if (!anchor || (input.taskId && input.taskId !== task?.id)) {
      this.core.publish(
        this.core.conversations.pauseConversationQueue(
          sessionId,
          'The queued message needs its original execution to be checked.',
        ),
      )
      return
    }
    if (['starting', 'running', 'recovering'].includes(anchor.status)) return
    if (
      !input.manuallyResumed &&
      !input.taskId &&
      (anchor.status !== 'completed' ||
        anchor.nativeOutcome !== 'completed' ||
        !this.core.conversations.hasCompleteResponse(anchor.id))
    ) {
      this.core.publish(
        this.core.conversations.pauseConversationQueue(
          sessionId,
          'The execution did not complete normally. Resume the queued message when ready.',
        ),
      )
      return
    }
    if (
      (anchor.dispatchPhase !== 'ended' &&
        !(
          (input.manuallyResumed &&
            ['not_sent', 'rejected'].includes(anchor.dispatchPhase ?? 'not_sent')) ||
          (input.taskId && this.core.conversations.workflowInputWasNotSent(anchor))
        )) ||
      (anchor.nativeEffectsState !== 'settled' && anchor.nativeEffectsState !== 'not_dispatched')
    ) {
      return
    }
    if (input.taskId && task?.status === 'running') return
    const intent = input.metadata.replyIntentBasis
    const askOnly = intent?.kind === 'ask_only'
    if (
      askOnly &&
      (!task ||
        task.id !== input.taskId ||
        task.revision !== intent.taskRevision + 1 ||
        task.inputSequence !== intent.priorInputSequence)
    ) {
      this.core.publish(
        this.core.conversations.pauseConversationQueue(
          sessionId,
          'The task checkpoint changed. Return your question to the composer.',
        ),
      )
      return
    }
    if (input.metadata.workflowCommand) {
      const reference = input.metadata.replaceTask
      const unfinished = task && task.status !== 'complete' ? task : undefined
      if (
        (unfinished && (!reference || reference.taskId !== unfinished.id)) ||
        (!unfinished && reference && task?.id !== reference.taskId)
      ) {
        this.core.publish(
          this.core.conversations.pauseConversationQueue(
            sessionId,
            'This command no longer matches the current task. Edit it to confirm the current task, or remove it.',
          ),
        )
        return
      }
    }
    let activeTask = task
    let targetActor = input.actor
    let next: CollaborationTask | undefined
    const requestedRoute = input.metadata.route ?? prefix.route
    if (expectedInTaskReview && input.taskId && activeTask) {
      const explicitReviewer = requestedRoute?.type === 'agent' ? requestedRoute.agentId : undefined
      next = this.core.conversations.workflowInTaskReview(activeTask, explicitReviewer)
      next.latestUserMessageId = input.id
      targetActor = next.actor
    } else if (input.taskId && activeTask) {
      const isImplicitOpenMode =
        isCollaborationOpenMode(activeTask) &&
        !askOnly &&
        !input.metadata.replyToDecision &&
        input.metadata.routeIntent === 'implicit' &&
        requestedRoute?.type !== 'agent'
      if (isImplicitOpenMode) {
        const routingController = new AbortController()
        this.core.routingOpenInputs.set(sessionId, routingController)
        let routingCompleted = false
        try {
          targetActor = await this.consultOpenModeInputRouting(
            sessionId,
            activeTask,
            input.id,
            routingController.signal,
          )
          routingCompleted = true
        } finally {
          if (this.core.routingOpenInputs.get(sessionId) === routingController) {
            this.core.routingOpenInputs.delete(sessionId)
          }
        }
        const freshInput = this.core.conversations.readReceivedInput(sessionId)
        const freshTask = this.core.conversations.collaboration(sessionId)
        if (
          !routingCompleted ||
          routingController.signal.aborted ||
          this.core.disposed ||
          this.core.gate.nativeQuitSealed() ||
          this.core.gate.hasSessionOperation(sessionId, true) ||
          !freshInput ||
          freshInput.id !== input.id ||
          freshInput.state !== 'accepted' ||
          !freshTask ||
          freshTask.id !== activeTask.id ||
          freshTask.revision !== activeTask.revision ||
          freshTask.status === 'running'
        ) {
          this.schedulePendingRoutedContinuations()
          return
        }
        activeTask = freshTask
        if (
          targetActor !== freshInput.actor &&
          isAgentInPair(targetActor, [freshTask.owner, freshTask.reviewer])
        ) {
          this.core.conversations.adoptOpenModeInputRecipient(sessionId, freshInput.id, targetActor)
        }
      }
      next = this.core.conversations.workflowReply(activeTask, targetActor, askOnly)
      if (askOnly && next.stage !== 'reply') {
        this.core.publish(
          this.core.conversations.pauseConversationQueue(
            sessionId,
            'Ask-only questions require a read-only reply stage.',
          ),
        )
        return
      }
      if (!askOnly) next.latestUserMessageId = input.id
    }
    const currentDrafts = this.core.conversations.readPage({ scope: 'drafts', sessionId })
    if (currentDrafts.scope !== 'drafts') return
    const queuedSession = this.core.sessions.find(sessionId)
    const queuedPair = queuedSession ? resolveActiveAgentPair(queuedSession.settings) : undefined
    const result = await this.core.sendAndSteer.enqueueSend(
      {
        sessionId,
        clientMessageId: input.id,
        content: input.content,
        ...(input.metadata.replyToDecision
          ? { replyToDecision: input.metadata.replyToDecision }
          : {}),
        ...(input.metadata.replaceTask ? { replaceTask: input.metadata.replaceTask } : {}),
        route:
          input.metadata.route?.type === 'all'
            ? { type: 'all' }
            : { type: 'agent', agentId: targetActor },
        ...(input.metadata.skills.length ? { skills: input.metadata.skills } : {}),
        expectedCommentsRevision: currentDrafts.commentsRevision,
        commentIds: [],
        ...(input.metadata.batchId ? { batchId: input.metadata.batchId } : {}),
        freezeDrafts: false,
        ...(input.metadata.imageIds.length ? { imageIds: input.metadata.imageIds } : {}),
      },
      {
        ...(next
          ? { collaboration: next, expectedCollaborationRevision: activeTask!.revision }
          : {}),
        queuedRolePolicy: input.metadata.rolePolicy,
        queuedRoute:
          input.metadata.route?.type === 'all'
            ? 'firstAgentId' in input.metadata.route && 'secondAgentId' in input.metadata.route
              ? input.metadata.route
              : {
                  type: 'all',
                  firstAgentId: targetActor,
                  secondAgentId: otherAgent(targetActor, queuedPair),
                }
            : { type: 'agent', agentId: targetActor },
        preserveDraftComments: true,
        receivedInputId: input.id,
        receivedComments: input.comments,
      },
    )
    if (
      !result.ok &&
      this.core.conversations.receivedCollaborationInput(sessionId)?.id === input.id
    ) {
      this.core.publish(
        this.core.conversations.pauseConversationQueue(sessionId, result.error.message),
      )
    }
  }

  private async beginPendingRoutedContinuation(
    pending: PendingRoutedContinuation,
    context: {
      cwd: string
      settings: DefaultSessionSettings
      settingsRevision: number
      executablePaths: Record<RuntimeAgentId, string>
    },
    signal: AbortSignal,
  ): Promise<
    | {
        started: ReturnType<ConversationRepository['beginRoutedContinuation']>
        prompt: AgentPromptEnvelope
      }
    | undefined
  > {
    const message = this.core.conversations.internalMessage(
      pending.userMessageId,
      pending.sessionId,
    )
    if (message?.route?.type !== 'all') return undefined
    const agentId = pending.agentId
    const adapter = await this.core.adapterFor(
      pending.sessionId,
      agentId,
      context.executablePaths[agentId],
      signal,
      context.cwd,
    )
    const nativeContext = this.core.conversations.nativeContext(pending.sessionId, agentId)
    if (nativeContext && nativeContext.continuationState !== 'ready') {
      return undefined
    }
    const frozen = this.core.conversations.skillInvocation(pending.userMessageId)
    if (frozen) {
      const current = await this.core.skills.skillBindings(
        pending.sessionId,
        agentId,
        signal,
        true,
        true,
      )
      if (
        frozen.bindings
          .filter((entry) => entry.agentId === agentId)
          .some((entry) => !current.some((item) => item.id === entry.id))
      ) {
        throw new RunOperationConflictError(
          'The secondary Agent Skill catalog changed. Its stage was not sent; the first answer is preserved.',
        )
      }
    }
    const comments: AnchoredComment[] = []
    const handoff = await this.core.contextBroker.collectHandoff({
      sessionId: pending.sessionId,
      targetAgentId: agentId,
      signal,
      excludeMessageId: pending.userMessageId,
      throughSequence: message.sequence - 1,
    })
    const prompt = this.core.contextBroker.buildPromptEnvelope({
      sessionId: pending.sessionId,
      message: { id: message.id, content: message.content },
      comments,
      handoff,
    })
    this.core.contextBroker.assertPromptFitsBudget(prompt)
    adapter.preflightPrompt?.({
      runId: randomUUID(),
      sessionId: pending.sessionId,
      ...(nativeContext ? { nativeSessionId: nativeContext.nativeSessionId } : {}),
      peerAssistanceAllowed: false,
      cwd: context.cwd,
      promptEnvelope: prompt,
      model: context.settings.agents[agentId].model,
      effort: context.settings.agents[agentId].effort,
    })
    if (this.core.gate.hasBlockingBackgroundWork(pending.sessionId)) return undefined
    return {
      started: this.core.conversations.beginRoutedContinuation({
        sessionId: pending.sessionId,
        userMessageId: pending.userMessageId,
        agentId,
        settingsRevision: context.settingsRevision,
        model: context.settings.agents[agentId].model,
        effort: context.settings.agents[agentId].effort,
        handoffSourceRefs: handoff.sourceRefs,
      }),
      prompt,
    }
  }

  async executeRoutedContinuation(
    execution: ActiveExecution,
    userMessageId: string,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    const message = this.core.conversations.internalMessage(userMessageId, execution.run.sessionId)
    if (message?.route?.type !== 'all') return
    const pending = this.core.conversations
      .pendingRoutedContinuations()
      .find((entry) => entry.userMessageId === userMessageId)
    if (!pending) {
      execution.protectedAgentId = undefined
      return
    }
    execution.protectedAgentId = pending.agentId
    const continuationAbort = new AbortController()
    execution.continuationAbortController = continuationAbort
    let prepared: Awaited<
      ReturnType<CollaborationAndHandoffCoordinator['beginPendingRoutedContinuation']>
    >
    try {
      prepared = await this.beginPendingRoutedContinuation(
        pending,
        {
          cwd,
          settings,
          settingsRevision: execution.run.settingsRevision,
          executablePaths,
        },
        continuationAbort.signal,
      )
    } finally {
      if (execution.continuationAbortController === continuationAbort) {
        execution.continuationAbortController = undefined
      }
    }
    if (!prepared || execution.cancelledByUser || continuationAbort.signal.aborted) return
    const { started, prompt } = prepared
    execution.run = started.run
    execution.protectedAgentId = started.run.agentId
    this.core.publish(started.patch)
    await this.core.executor.executeAttempts(
      execution,
      started.run,
      prompt,
      cwd,
      settings,
      executablePaths,
    )
  }

  async preparePendingRoutedContinuation(
    pending: PendingRoutedContinuation,
    continuation: PreparingContinuation,
  ): Promise<void> {
    try {
      const preparedSession = await this.core.prepareSession(
        pending.sessionId,
        continuation.controller.signal,
        [pending.agentId],
      )
      if (!preparedSession.ok) {
        throw new AgentExecutionError('runtime_incompatible', preparedSession.error.message, false)
      }
      if (
        this.core.disposed ||
        continuation.controller.signal.aborted ||
        this.core.preparingContinuations.get(pending.sessionId) !== continuation
      ) {
        return
      }
      const context = preparedSession.value
      const source = this.core.conversations.internalMessage(
        pending.userMessageId,
        pending.sessionId,
      )
      const firstRun = source?.runId ? this.core.conversations.findRun(source.runId) : undefined
      const frozenSettings =
        firstRun &&
        this.core.sessions.findSettingsRevision(pending.sessionId, firstRun.settingsRevision)
      if (!firstRun || !frozenSettings) {
        throw new RunOperationConflictError('The original routed task settings are unavailable.')
      }
      const prepared = await this.beginPendingRoutedContinuation(
        pending,
        {
          cwd: context.projectDirectory,
          settings: frozenSettings,
          settingsRevision: firstRun.settingsRevision,
          executablePaths: context.executablePaths,
        },
        continuation.controller.signal,
      )
      if (
        !prepared ||
        this.core.disposed ||
        continuation.controller.signal.aborted ||
        this.core.preparingContinuations.get(pending.sessionId) !== continuation
      ) {
        return
      }
      this.core.preparingContinuations.delete(pending.sessionId)
      this.core.publish(prepared.started.patch)
      void this.core.executor.trackExecution(prepared.started.run, (execution) =>
        this.core.executor.executeAttempts(
          execution,
          prepared.started.run,
          prepared.prompt,
          context.projectDirectory,
          frozenSettings,
          context.executablePaths,
        ),
      )
    } catch (error) {
      if (
        !this.core.disposed &&
        !continuation.controller.signal.aborted &&
        this.core.preparingContinuations.get(pending.sessionId) === continuation
      ) {
        this.core.publish(
          this.core.conversations.failPendingRoutedContinuation(
            pending.sessionId,
            pending.userMessageId,
            pending.agentId,
            pendingContinuationFailureCopy(pending.agentId, error),
          ),
        )
      }
    } finally {
      if (this.core.preparingContinuations.get(pending.sessionId) === continuation) {
        this.core.preparingContinuations.delete(pending.sessionId)
      }
      if (!this.core.disposed) {
        this.core.publish(this.core.conversations.metadataPatch(pending.sessionId))
      }
      this.schedulePendingRoutedContinuations()
    }
  }

  schedulePendingRoutedContinuations(continueWorkflowScan = false): void {
    if (this.core.disposed) return
    if (!continueWorkflowScan && this.core.workflowCandidateCursor) {
      this.core.workflowCandidateRescan = true
    }
    if (this.core.pendingContinuationScheduled) {
      this.core.pendingContinuationWakeAgain = true
      return
    }
    this.core.pendingContinuationScheduled = true
    this.core.pendingContinuationImmediate = setImmediate(() => {
      this.core.pendingContinuationImmediate = undefined
      void this.resumePendingRoutedContinuations()
        .catch(() => undefined)
        .finally(() => {
          this.core.pendingContinuationScheduled = false
          if (this.core.pendingContinuationWakeAgain) {
            this.core.pendingContinuationWakeAgain = false
            this.schedulePendingRoutedContinuations(Boolean(this.core.workflowCandidateCursor))
          }
        })
    })
  }

  private async resumePendingRoutedContinuations(): Promise<void> {
    for (const pending of this.core.conversations.pendingPreparedInformationDefaults()) {
      if (this.core.disposed || this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS) break
      if (this.core.gate.hasSessionOperation(pending.sessionId)) continue
      const prepared = this.core.conversations.takePreparedInformationDefault(pending.batchId)
      if (!prepared || 'paused' in prepared) {
        this.core.publish(
          this.core.conversations.metadataPatch(pending.sessionId, {
            draftsChanged: Boolean(prepared?.draftsChanged),
          }),
        )
        continue
      }
      const sending = this.core.sendAndSteer.enqueueSend(prepared.input, {
        preparedInput: prepared.receipt,
      })
      void sending
        .finally(() => {
          const draftsChanged = this.core.conversations.cancelPreparedInputDispatch(
            prepared.receipt,
            'preparation_failed',
          )
          if (!this.core.disposed) {
            this.core.publish(
              this.core.conversations.metadataPatch(pending.sessionId, { draftsChanged }),
            )
          }
        })
        .catch(() => undefined)
    }
    for (const pending of this.core.conversations.pendingCollaborationInputs()) {
      void this.dispatchReceivedInput(pending.sessionId).catch(() => {
        if (
          !this.core.disposed &&
          this.core.conversations.receivedCollaborationInput(pending.sessionId)?.id === pending.id
        ) {
          this.core.publish(
            this.core.conversations.pauseConversationQueue(
              pending.sessionId,
              'Automatic delivery could not be prepared. Resume when ready.',
            ),
          )
        }
      })
    }
    if (!this.core.workflowCandidateCursor) this.core.workflowCandidateRescan = false
    const workflowCandidates = this.core.conversations.pendingWorkflowTasks(
      this.core.workflowCandidateCursor,
    )
    for (const pending of workflowCandidates) {
      void this.dispatchWorkflowContinuation(pending.sessionId).catch((error) => {
        const task = this.core.conversations.collaboration(pending.sessionId)
        if (!task || task.automation !== 'active') return
        this.core.publish(
          this.core.conversations.setCollaborationState({
            ...task,
            revision: task.revision + 1,
            automation: 'paused',
            pauseReason: 'failure',
            notice: (error instanceof Error
              ? error.message
              : 'Collaboration could not continue.'
            ).slice(0, 512),
          }),
        )
      })
    }
    if (
      workflowCandidates.length === 5 &&
      this.core.gate.operationCount() < MAX_AGENT_OPERATIONS &&
      !this.core.disposed
    ) {
      const last = workflowCandidates.at(-1)!
      this.core.workflowCandidateCursor = { updatedAt: last.updatedAt, id: last.id }
      this.core.pendingContinuationWakeAgain = true
    } else {
      this.core.workflowCandidateCursor = undefined
      if (this.core.workflowCandidateRescan) {
        this.core.workflowCandidateRescan = false
        this.core.pendingContinuationWakeAgain = true
      }
    }
    for (const pending of this.core.conversations.pendingRoutedContinuations()) {
      if (
        this.core.disposed ||
        this.core.gate.nativeQuitSealed() ||
        this.core.conversations.nativeRecoveryBlocksInput(pending.sessionId) ||
        this.core.gate.hasSessionOperation(pending.sessionId) ||
        this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS
      ) {
        continue
      }
      const continuation: PreparingContinuation = {
        sessionId: pending.sessionId,
        userMessageId: pending.userMessageId,
        protectedAgentId: pending.agentId,
        controller: new AbortController(),
      }
      this.core.preparingContinuations.set(pending.sessionId, continuation)
      this.core.workspaceChanges?.cancelUndoForNativeSession(pending.sessionId)
      continuation.completion = this.preparePendingRoutedContinuation(pending, continuation)
    }
    void this.core.recovery.resumeAutomaticRecovery().catch(() => undefined)
  }
}
