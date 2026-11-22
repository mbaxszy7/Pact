import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  AnchoredComment,
  CollaborationActionInput,
  CollaborationTask,
  ConversationMessageRoute,
  ConversationPatch,
  ConversationSendInput,
  DecisionEvaluationOutcome,
  DecisionInput,
  InitialTaskRolesProposal,
  InputRoutingProposal,
  OriginSideChat,
  PeerProposalAcceptInput,
  PeerProposalDismissInput,
  PeerRequestKind,
  PendingNativeInteraction,
  RelayDecisionMaterial,
  RpcResult,
  RuntimeAgentId,
  SchedulingHandoff,
} from '@pact/contracts'
import type {
  ConversationRepository,
  PreparedInputDispatch,
  ProjectCatalogRepository,
  SessionRepository,
} from '@pact/persistence'

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

import type { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import type { DecisionInputLoader, DecisionRuntime } from './decision-runtime'

import { evaluateRelayPolicy, type RelayPolicyAdmission } from './relay-policy'

const MAX_AGENT_OPERATIONS = 5

export interface CollaborationSendOptions {
  collaborationActionReceiptId?: string | undefined
  preparedInput?: PreparedInputDispatch | undefined
  inputRouting?: InputRoutingProposal | undefined
  initialTaskRoles?: InitialTaskRolesProposal | undefined
  initialRolesConsidered?: boolean
  preparedSelectionCurrent?: (() => boolean) | undefined
  preparationDeadlineAt?: number | undefined
  schedulingHandoff?: SchedulingHandoff | undefined
  imageOwnerKey?: string
  preserveDraftComments?: boolean
  sourceProposalId?: string
  sourceMessageId?: string
  expectedSettingsRevision?: number | undefined
  collaboration?: CollaborationTask | undefined
  expectedCollaborationRevision?: number | undefined
  receivedInputId?: string | undefined
  receivedComments?: AnchoredComment[] | undefined
  queuedRoute?: ConversationMessageRoute | undefined
  queuedRolePolicy?: CollaborationTask['rolePolicy'] | undefined
  originSideChat?: OriginSideChat | undefined
  syncMainOperationId?: string | undefined
}

export interface CollaborationDecisionOwner {
  kind: 'evaluation'
  operationId: string
  runtime?: DecisionRuntime | undefined
  sessionId: string
  handoff: SchedulingHandoff | undefined
  controller: AbortController
  current: () => boolean
  consulting: boolean
  reserved?: boolean
  settling?: boolean
}

export interface CollaborationPreparedSession {
  session: NonNullable<ReturnType<SessionRepository['find']>>
  projectDirectory: string
}

export interface ConversationCollaborationHost {
  readonly conversations: ConversationRepository
  readonly sessions: SessionRepository
  readonly projects: ProjectCatalogRepository
  readonly runtimePreparation: RuntimePreparation
  readonly routingOpenInputs: Map<string, AbortController>
  isDisposed(): boolean
  nativeQuitSealed(): boolean
  shuttingDown(): RpcResult<never>
  quitPrepared(): RpcResult<never>
  archiveBusy(): RpcResult<never>
  nativeRecoveryRequired(): RpcResult<never>
  sendFailure(error: unknown): RpcResult<never>
  awaitSettlingExecution(sessionId: string, runId?: string): Promise<void>
  hasSessionOperation(sessionId: string, includePreparingContinuation?: boolean): boolean
  operationCount(): number
  pendingNativeInteractions(sessionId: string): PendingNativeInteraction[]
  checkNativeBinding(
    sessionId: string,
    agentId: RuntimeAgentId,
    runId?: string,
  ): Promise<RpcResult<ConversationPatch>>
  currentDecisionRuntime(): CollaborationDecisionOwner | undefined
  releaseDecisionHandoff(owner: CollaborationDecisionOwner | undefined): void
  decisionRuntimeAdmission(): RelayPolicyAdmission['runtimeAdmission']
  hasPreparingSendForHandoff(handoff: SchedulingHandoff): boolean
  evaluateDecision(
    request:
      | DecisionInput
      | {
          handoff: SchedulingHandoff
          load: DecisionInputLoader
          retainHandoff?: boolean
        }
      | { sessionId: string; prepare: DecisionInputLoader },
    signal: AbortSignal,
  ): Promise<DecisionEvaluationOutcome>
  enqueueSend(
    input: ConversationSendInput,
    options: CollaborationSendOptions,
  ): Promise<RpcResult<ConversationPatch>>
  publish(patch: ConversationPatch, progress?: boolean): void
  schedulePendingRoutedContinuations(continueWorkflowScan?: boolean): void
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

export async function startWorkflowTurn(
  host: ConversationCollaborationHost,
  task: CollaborationTask,
  next: CollaborationTask,
  clientMessageId: string = randomUUID(),
  collaborationActionReceiptId?: string,
  schedulingHandoff?: SchedulingHandoff,
  action?: CollaborationActionInput['action'],
): Promise<RpcResult<ConversationPatch>> {
  const options: CollaborationSendOptions = {
    preserveDraftComments: true,
    collaboration: next,
    expectedCollaborationRevision: task.revision,
    collaborationActionReceiptId,
  }
  try {
    options.schedulingHandoff =
      schedulingHandoff ?? host.conversations.workflowHandoff(task, next.actor)
    const drafts = host.conversations.readPage({ scope: 'drafts', sessionId: task.sessionId })
    if (drafts.scope !== 'drafts')
      return host.sendFailure(new Error('Comment drafts are unavailable.'))
    const content = `@${next.actor} ${collaborationActionPrompt(next, action)}`
    return await host.enqueueSend(
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
export async function consultInitialTaskRoles(
  host: ConversationCollaborationHost,
  input: ConversationSendInput,
  prepared: CollaborationPreparedSession,
  controller: AbortController,
  options: CollaborationSendOptions,
): Promise<void> {
  const settings = host.conversations.schedulingSettings()
  if (!settings.enabled || !settings.credential.configured) return
  if (host.decisionRuntimeAdmission() !== 'may_attempt') return
  const activePair = resolveActiveAgentPair(prepared.session.settings)
  const orderedPair = (['codex', 'claude', 'agy'] as const).filter((actor) =>
    isAgentInPair(actor, activePair),
  )
  const opportunity = host.conversations.initialTaskRoleOpportunity(input, orderedPair)
  if (!opportunity) return
  const configurationKey = host.runtimePreparation.catalogIdentity(prepared.projectDirectory)
  let material: { inputSha256: string; sourceFingerprint: string } | undefined
  const outcome = await host.evaluateDecision(
    {
      sessionId: input.sessionId,
      prepare: async (decisionContext) => {
        const receipt = host.conversations.prepareInputDispatch(
          input,
          randomUUID(),
          orderedPair,
          decisionContext,
          'task_roles',
        )
        options.preparedInput = receipt
        host.publish(host.conversations.metadataPatch(input.sessionId, { draftsChanged: true }))
        const frozen = receipt.metadata.taskRoles!
        const candidates = frozen.candidates.map((candidate) => ({
          id: candidate.id,
          description: `Assign ${candidate.roles.planAuthor} to author plans and ${candidate.roles.planReviewer} to review plans; assign ${candidate.roles.codeAuthor} to implement, respond and repair, and ${candidate.roles.codeReviewer} to review code. Keep the original scope and permissions; implementation after planning and every new repair still require their existing user authorization.`,
        }))
        const read = await host.conversations.readPreparedInputDecisionSources(
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
      if (candidateId !== null)
        options.initialTaskRoles = {
          version: 'initial-task-roles-v1',
          ...material,
          ...outcome.evaluationReceipt,
          candidateId: initialTaskRoleCandidateIdSchema.parse(candidateId),
        }
      options.preparedSelectionCurrent = () =>
        host.runtimePreparation.catalogIdentity(prepared.projectDirectory) === configurationKey
    }
  }
}

/** Advisory-only consult: proposals never execute; false keeps the lawful default step. */
export async function consultWorkflowAlternatives(
  host: ConversationCollaborationHost,
  task: CollaborationTask,
  handoff: SchedulingHandoff,
): Promise<void> {
  let material: Omit<RelayDecisionMaterial, 'input'> | undefined
  let limitAttempt = false
  try {
    const preferences = host.conversations.schedulingSettings()
    if (!preferences.enabled || !preferences.credential.configured) return
    if (host.conversations.decisionEvaluationReceipt(handoff)) return
    if (host.conversations.planReviewLimitAdviceConsidered(handoff)) return
    const runtimeAdmission = host.decisionRuntimeAdmission()
    if (runtimeAdmission !== 'may_attempt') return
    const session = host.sessions.find(task.sessionId)
    const project = session && host.projects.find(session.projectId)
    if (!project) return
    const current = host.conversations.relayWorkflowAlternatives(handoff)
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
    const outcome = await host.evaluateDecision(
      {
        handoff,
        retainHandoff: true,
        load: async (context) => {
          const read = await host.conversations.readRelayWorkflowDecisionSources(
            handoff,
            candidates,
            context,
          )
          const fresh = host.conversations.relayWorkflowAlternatives(handoff)
          if (
            !fresh ||
            read.sourceFingerprint !== current.snapshot.sourceFingerprint ||
            fresh.snapshot.sourceFingerprint !== read.sourceFingerprint ||
            !isDeepStrictEqual(fresh.alternatives, alternatives) ||
            host.conversations.receivedCollaborationInput(task.sessionId) ||
            collaborationInputGate(read.snapshot.task) ||
            host.pendingNativeInteractions(task.sessionId).length > 0
          )
            throw new RunOperationConflictError(
              'This workflow node does not need a decision request.',
            )
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
    )
      limitAttempt = false
    if (outcome.kind !== 'selection' || !material || material.basis.kind !== 'workflow') return
    const chosenProposal = alternatives.find(
      (entry) => `propose_${entry.kind}` === outcome.selection.candidateId,
    )
    if (!chosenProposal || host.pendingNativeInteractions(task.sessionId).length) return
    // Host evidence only: prefer review, owner response and plan roles from the evaluated snapshot.
    const sourceIds = material.sources
      .filter((source) =>
        (['review', 'owner_response', 'plan'] as const).some((role) => source.roles.includes(role)),
      )
      .map((source) => source.id)
    if (!sourceIds.length) return
    host.conversations.proposeRelayWorkflowAction({
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
    host.publish(host.conversations.metadataPatch(task.sessionId))
  } catch {
    // Advisory consultation never blocks the lawful default step.
  } finally {
    if (limitAttempt) host.conversations.recordPlanReviewLimitAdviceConsidered(handoff)
    material = undefined
  }
}

export async function actOnCollaborationAdmitted(
  host: ConversationCollaborationHost,
  input: CollaborationActionInput,
): Promise<RpcResult<ConversationPatch>> {
  if (host.isDisposed()) return host.shuttingDown()
  if (host.nativeQuitSealed()) return host.quitPrepared()
  if (host.conversations.archives.blocksSession(input.sessionId)) return host.archiveBusy()
  await host.awaitSettlingExecution(input.sessionId)
  if (host.isDisposed()) return host.shuttingDown()
  if (host.nativeQuitSealed()) return host.quitPrepared()
  if (host.conversations.archives.blocksSession(input.sessionId)) return host.archiveBusy()
  try {
    if (input.action === 'swap_code_roles') {
      const patch = host.conversations.swapCodeRoles(
        input,
        host.hasSessionOperation(input.sessionId, true) ||
          host.pendingNativeInteractions(input.sessionId).length > 0,
      )
      host.publish(patch)
      return { ok: true, value: patch }
    }
    const context = host.sessions.find(input.sessionId)
    const task = host.conversations.collaboration(input.sessionId)
    const prior = host.conversations.collaborationActionReceipt(input)
    if (prior?.boundRunId) return { ok: true, value: host.conversations.runPatch(prior.boundRunId) }
    if (prior && prior.state !== 'available')
      return { ok: true, value: host.conversations.metadataPatch(input.sessionId) }
    if (
      !context ||
      !task ||
      task.id !== input.taskId ||
      (!prior && task.revision !== input.revision)
    )
      throw new RunOperationConflictError('This collaboration action is no longer current.')
    if (task.status === 'complete')
      throw new RunOperationConflictError('This collaboration is already complete.')
    host.conversations.discardUnansweredRelaySchedulingDecision(input.sessionId, false)
    if (host.conversations.receivedCollaborationInput(input.sessionId))
      throw new RunOperationConflictError(
        'Your queued message will be answered before collaboration continues.',
      )
    const planRecoveryState = host.conversations.workflowPlanRecoveryState(task.runId)
    if (input.action === 'recover_plan') {
      if (
        !planRecoveryState?.recoveryRequired ||
        !planRecoveryState.canRecoverNow ||
        task.automation !== 'paused'
      )
        throw new RunOperationConflictError('There is no paused native plan source to restore.')
      const settled = host.conversations.reconcileCompletedCollaboration(task.runId)
      if (settled) host.publish(settled)
      if (!host.conversations.workflowPlanSettled(task.runId)) {
        const checked = await host.checkNativeBinding(
          input.sessionId,
          planRecoveryState.actor,
          task.runId,
        )
        if (!checked.ok) return checked
      }
      const recovered = host.conversations.collaboration(input.sessionId)
      if (
        !recovered ||
        recovered.id !== task.id ||
        recovered.runId !== task.runId ||
        recovered.inputSequence !== task.inputSequence ||
        !host.conversations.workflowPlanSettled(task.runId) ||
        host.conversations.needsWorkflowPlanRecovery(task.runId)
      )
        throw new RunOperationConflictError(
          'The saved native plan could not be restored to this task. Its source is preserved; no Agent task was started.',
        )
      if (
        recovered.stage === 'reply' &&
        (collaborationInputGate(recovered) ||
          recovered.inputProcessing?.settled?.runId !== recovered.runId ||
          recovered.inputProcessing.settled.inputSequence !== recovered.inputSequence)
      )
        throw new RunOperationConflictError(
          'The plan was restored, but your reply still needs confirmation. Check its response or recovery notice before continuing.',
        )
      return { ok: true, value: host.conversations.metadataPatch(input.sessionId) }
    }
    if (planRecoveryState?.canRecoverNow)
      throw new RunOperationConflictError(
        'Restore the saved native plan before continuing collaboration.',
      )
    if (host.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return host.nativeRecoveryRequired()
    const prepared = host.conversations.prepareCollaborationAction(input, context.settings)
    if (prepared.receipt.boundRunId)
      return { ok: true, value: host.conversations.runPatch(prepared.receipt.boundRunId) }
    if (!prepared.task || !prepared.next || !prepared.handoff)
      throw new RunOperationConflictError('The original action preparation is unavailable.')
    let consultation: CollaborationDecisionOwner | undefined
    try {
      await consultWorkflowAlternatives(host, prepared.task, prepared.handoff)
      const runtime = host.currentDecisionRuntime()
      consultation =
        runtime?.kind === 'evaluation' && runtime.handoff?.id === prepared.handoff.id
          ? runtime
          : undefined
      const dispatched = startWorkflowTurn(
        host,
        prepared.task,
        prepared.next,
        input.clientMessageId,
        prepared.receipt.id,
        prepared.handoff,
        input.action,
      )
      host.releaseDecisionHandoff(consultation)
      return await dispatched
    } finally {
      host.releaseDecisionHandoff(consultation)
      host.conversations.cancelPreparedCollaborationAction(prepared.receipt.id)
    }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export function canDispatchWorkflowContinuation(
  host: ConversationCollaborationHost,
  sessionId: string,
): boolean {
  return (
    !host.isDisposed() &&
    !host.nativeQuitSealed() &&
    !host.hasSessionOperation(sessionId, true) &&
    host.operationCount() < MAX_AGENT_OPERATIONS &&
    !host.conversations.receivedCollaborationInput(sessionId) &&
    !host.conversations.nativeRecoveryBlocksInput(sessionId) &&
    !host.conversations.hasPendingRoutedContinuation(sessionId) &&
    host.pendingNativeInteractions(sessionId).length === 0 &&
    !host.conversations.hasRelayDecision(sessionId)
  )
}

export async function dispatchWorkflowContinuation(
  host: ConversationCollaborationHost,
  sessionId: string,
): Promise<void> {
  host.conversations.discardStaleRelaySchedulingDecision(sessionId)
  if (!canDispatchWorkflowContinuation(host, sessionId)) return
  const task = host.conversations.collaboration(sessionId)
  const session = host.sessions.find(sessionId)
  if (
    !task ||
    !session ||
    session.status === 'archived' ||
    (task.automation !== 'active' && task.pauseReason !== 'limit') ||
    (task.status !== 'waiting' && task.status !== 'ready')
  )
    return
  if (isCollaborationOpenMode(task)) return
  const decision = deriveCollaborationDecision(task)
  if (decision.inputGate) return
  if (task.automation === 'paused') {
    const handoff = host.conversations.workflowHandoff(
      task,
      collaborationActor(task, 'plan_review'),
    )
    await consultWorkflowAlternatives(host, task, handoff)
    const owner = host.currentDecisionRuntime()
    if (owner?.kind === 'evaluation' && owner.handoff?.id === handoff.id)
      host.releaseDecisionHandoff(owner)
    return
  }
  if (task.status === 'ready') {
    const handoff = host.conversations.workflowHandoff(task, collaborationActor(task, 'implement'))
    await consultWorkflowAlternatives(host, task, handoff)
    const owner = host.currentDecisionRuntime()
    if (owner?.kind === 'evaluation' && owner.handoff?.id === handoff.id)
      host.releaseDecisionHandoff(owner)
    return
  }
  if (!decision.nextStage) {
    if (!host.pendingNativeInteractions(sessionId).length) {
      const handoff = host.conversations.workflowHandoff(
        task,
        collaborationActor(task, task.stage === 'code_review' ? 'respond' : 'plan'),
      )
      await consultWorkflowAlternatives(host, task, handoff)
      const runtime = host.currentDecisionRuntime()
      const consultation =
        runtime?.kind === 'evaluation' && runtime.handoff?.id === handoff.id ? runtime : undefined
      host.releaseDecisionHandoff(consultation)
    }
    return
  }
  let next: CollaborationTask
  try {
    next = advanceAutomaticCollaboration(task, session.settings)
  } catch (error) {
    const current = host.conversations.collaboration(sessionId)
    if (current?.id !== task.id || current.revision !== task.revision) return
    const limitReached =
      error instanceof CollaborationTransitionError && error.reason.kind === 'limit'
    const notice = error instanceof Error ? error.message : 'Collaboration could not continue.'
    host.publish(
      host.conversations.setCollaborationState({
        ...task,
        revision: task.revision + 1,
        automation: 'paused',
        pauseReason: limitReached ? 'limit' : 'failure',
        notice: notice.slice(0, 512),
      }),
    )
    if (limitReached) host.schedulePendingRoutedContinuations()
    return
  }
  let consultation: CollaborationDecisionOwner | undefined
  const settings = host.conversations.schedulingSettings()
  if (settings.enabled && settings.credential.configured) {
    const handoff = host.conversations.workflowHandoff(task, next.actor)
    const activeRuntime = host.currentDecisionRuntime()
    if (
      activeRuntime?.kind === 'evaluation' &&
      activeRuntime.consulting &&
      activeRuntime.current() &&
      activeRuntime.handoff?.id === handoff.id
    )
      return
    await consultWorkflowAlternatives(host, task, handoff)
    const latestRuntime = host.currentDecisionRuntime()
    consultation =
      latestRuntime?.kind === 'evaluation' && latestRuntime.handoff?.id === handoff.id
        ? latestRuntime
        : undefined
    if (host.isDisposed() || host.nativeQuitSealed()) {
      host.releaseDecisionHandoff(consultation)
      return
    }
    if (host.conversations.hasRelayDecision(sessionId)) {
      host.releaseDecisionHandoff(consultation)
      return
    }
    if (!host.conversations.evaluationIsCurrent(handoff)) {
      host.releaseDecisionHandoff(consultation)
      host.schedulePendingRoutedContinuations()
      return
    }
    if (host.hasPreparingSendForHandoff(handoff)) {
      // The original manual claim is preparing; its existing release path wakes automation.
      host.releaseDecisionHandoff(consultation)
      return
    }
  }
  const preparation = startWorkflowTurn(host, task, next)
  // enqueueSend has synchronously registered the original business preparation, or refused it.
  host.releaseDecisionHandoff(consultation)
  const result = await preparation
  if (!result.ok) {
    const current = host.conversations.collaboration(sessionId)
    if (current?.id !== task.id || current.revision !== task.revision) return
    host.publish(
      host.conversations.setCollaborationState({
        ...current,
        revision: current.revision + 1,
        automation: 'paused',
        pauseReason: 'failure',
        notice: result.error.message.slice(0, 512),
      }),
    )
  }
}

export function acceptPeerProposal(
  host: ConversationCollaborationHost,
  input: PeerProposalAcceptInput,
): Promise<RpcResult<ConversationPatch>> {
  if (host.isDisposed()) return Promise.resolve(host.shuttingDown())
  if (host.nativeQuitSealed()) return Promise.resolve(host.quitPrepared())
  if (host.conversations.nativeRecoveryBlocksInput(input.sessionId))
    return Promise.resolve(host.nativeRecoveryRequired())
  const proposal = host.conversations.peerProposal(input.sessionId, input.proposalId)
  if (!proposal?.run.peerProposal || proposal.run.peerProposal.state !== 'pending')
    return Promise.resolve({
      ok: false,
      error: { code: 'CONFLICT', message: 'This peer request is no longer available.' },
    })
  const targetAgentId = proposal.run.peerProposal.targetAgentId
  const session = host.sessions.find(input.sessionId)
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
  const drafts = host.conversations.readPage({ scope: 'drafts', sessionId: input.sessionId })
  if (drafts.scope !== 'drafts')
    return Promise.resolve({
      ok: false,
      error: { code: 'INTERNAL', message: 'Comment drafts are unavailable.' },
    })
  return host.enqueueSend(
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

export function dismissPeerProposal(
  host: ConversationCollaborationHost,
  input: PeerProposalDismissInput,
): RpcResult<ConversationPatch> {
  if (host.isDisposed()) return host.shuttingDown()
  if (host.conversations.nativeRecoveryBlocksInput(input.sessionId))
    return host.nativeRecoveryRequired()
  try {
    const patch = host.conversations.dismissPeerProposal(input.sessionId, input.proposalId)
    host.publish(patch)
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

export async function consultOpenModeInputRouting(
  host: ConversationCollaborationHost,
  sessionId: string,
  task: CollaborationTask,
  receivedId: string,
  signal?: AbortSignal,
): Promise<RuntimeAgentId> {
  const fallbackActor: RuntimeAgentId = task.lastCodeActor ?? collaborationActor(task, 'implement')
  const settings = host.conversations.schedulingSettings()
  const admission = host.decisionRuntimeAdmission()
  if (
    !settings.enabled ||
    !settings.credential.configured ||
    admission !== 'may_attempt' ||
    host.pendingNativeInteractions(sessionId).length > 0
  )
    return fallbackActor
  const taskPair: readonly [RuntimeAgentId, RuntimeAgentId] = [task.owner, task.reviewer]
  const orderedTaskActors = (['codex', 'claude', 'agy'] as const).filter((actor) =>
    isAgentInPair(actor, taskPair),
  )
  const bothReady = orderedTaskActors.every((actor) => {
    const ctx = host.conversations.nativeContext(sessionId, actor)
    return !ctx || ctx.continuationState === 'ready'
  })
  if (!bothReady) return fallbackActor
  const handoff = host.conversations.workflowHandoff(task, fallbackActor, receivedId)
  if (host.conversations.decisionEvaluationReceipt(handoff)) return fallbackActor
  const candidates = orderedTaskActors.map((actor) => ({
    id: `route_${actor}`,
    description: `Send this open-mode task message to ${actor}, preserving its current session permissions and task context.`,
  }))
  try {
    const outcome = await host.evaluateDecision(
      {
        handoff,
        load: async (context) => {
          const read = await host.conversations.readOpenModeRoutingSources(
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
              nativeInteraction: host.pendingNativeInteractions(sessionId).length > 0,
              newTaskDispatchProtected: false,
            },
          })
          if (policy.kind !== 'eligible')
            throw new RunOperationConflictError(
              'Open-mode input is not eligible for Relay routing.',
            )
          return read.input
        },
      },
      signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
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
    const runtime = host.currentDecisionRuntime()
    if (runtime?.kind === 'evaluation' && runtime.handoff?.id === handoff.id)
      host.releaseDecisionHandoff(runtime)
  }
}

export async function dispatchReceivedInput(
  host: ConversationCollaborationHost,
  sessionId: string,
): Promise<void> {
  if (
    host.isDisposed() ||
    host.nativeQuitSealed() ||
    host.routingOpenInputs.has(sessionId) ||
    host.hasSessionOperation(sessionId, true) ||
    host.operationCount() >= MAX_AGENT_OPERATIONS ||
    host.conversations.nativeRecoveryBlocksInput(sessionId)
  )
    return
  const queue = host.conversations.queueState(sessionId)
  if (queue.input?.state !== 'queued') return
  // Preserve the original @all context boundary: queued work cannot enter the
  // Secondary's native history before its already-authorized independent stage.
  if (
    host.conversations
      .pendingRoutedContinuations()
      .some((pending) => pending.sessionId === sessionId)
  )
    return
  const input = host.conversations.readReceivedInput(sessionId)
  const task = host.conversations.collaboration(sessionId),
    session = host.sessions.find(sessionId)
  if (
    !input ||
    (!queue.enabled && !input.taskId) ||
    input.state !== 'accepted' ||
    !session ||
    session.status === 'archived'
  )
    return
  const prefix = parseComposerCommandPrefix(input.content, input.metadata.skills)
  const expectedInTaskReview = Boolean(input.metadata.inTaskReview)
  const actualInTaskReview = Boolean(
    input.taskId && task && host.conversations.isInTaskReviewCommand(task, prefix.pact),
  )
  if (
    prefix.error ||
    prefix.btw ||
    (session.parentSessionId && prefix.pact) ||
    expectedInTaskReview !== actualInTaskReview ||
    (Boolean(prefix.pact) && !expectedInTaskReview) !== input.metadata.workflowCommand ||
    (prefix.pact && input.taskId && !expectedInTaskReview)
  ) {
    host.publish(
      host.conversations.pauseConversationQueue(
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
  const anchor = host.conversations.findRun(input.anchorRunId)
  if (!anchor || (input.taskId && input.taskId !== task?.id)) {
    host.publish(
      host.conversations.pauseConversationQueue(
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
      !host.conversations.hasCompleteResponse(anchor.id))
  ) {
    host.publish(
      host.conversations.pauseConversationQueue(
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
        (input.taskId && host.conversations.workflowInputWasNotSent(anchor))
      )) ||
    (anchor.nativeEffectsState !== 'settled' && anchor.nativeEffectsState !== 'not_dispatched')
  )
    return
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
    host.publish(
      host.conversations.pauseConversationQueue(
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
      host.publish(
        host.conversations.pauseConversationQueue(
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
    next = host.conversations.workflowInTaskReview(activeTask, explicitReviewer)
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
      host.routingOpenInputs.set(sessionId, routingController)
      let routingCompleted = false
      try {
        targetActor = await consultOpenModeInputRouting(
          host,
          sessionId,
          activeTask,
          input.id,
          routingController.signal,
        )
        routingCompleted = true
      } finally {
        if (host.routingOpenInputs.get(sessionId) === routingController)
          host.routingOpenInputs.delete(sessionId)
      }
      const freshInput = host.conversations.readReceivedInput(sessionId)
      const freshTask = host.conversations.collaboration(sessionId)
      if (
        !routingCompleted ||
        routingController.signal.aborted ||
        host.isDisposed() ||
        host.nativeQuitSealed() ||
        host.hasSessionOperation(sessionId, true) ||
        !freshInput ||
        freshInput.id !== input.id ||
        freshInput.state !== 'accepted' ||
        !freshTask ||
        freshTask.id !== activeTask.id ||
        freshTask.revision !== activeTask.revision ||
        freshTask.status === 'running'
      ) {
        host.schedulePendingRoutedContinuations()
        return
      }
      activeTask = freshTask
      if (
        targetActor !== freshInput.actor &&
        isAgentInPair(targetActor, [freshTask.owner, freshTask.reviewer])
      )
        host.conversations.adoptOpenModeInputRecipient(sessionId, freshInput.id, targetActor)
    }
    next = host.conversations.workflowReply(activeTask, targetActor, askOnly)
    if (askOnly && next.stage !== 'reply') {
      host.publish(
        host.conversations.pauseConversationQueue(
          sessionId,
          'Ask-only questions require a read-only reply stage.',
        ),
      )
      return
    }
    if (!askOnly) next.latestUserMessageId = input.id
  }
  const currentDrafts = host.conversations.readPage({ scope: 'drafts', sessionId })
  if (currentDrafts.scope !== 'drafts') return
  const queuedSession = host.sessions.find(sessionId)
  const queuedPair = queuedSession ? resolveActiveAgentPair(queuedSession.settings) : undefined
  const result = await host.enqueueSend(
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
      ...(next ? { collaboration: next, expectedCollaborationRevision: activeTask!.revision } : {}),
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
  if (!result.ok && host.conversations.receivedCollaborationInput(sessionId)?.id === input.id)
    host.publish(host.conversations.pauseConversationQueue(sessionId, result.error.message))
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
