import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  advanceCollaboration,
  agentDisplayName,
  bindCollaborationQuestions,
  COLLABORATION_PROTOCOL,
  collaborationActionSchema,
  collaborationActor,
  collaborationAskActor,
  collaborationAskAvailable,
  collaborationDocumentSchema,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationMarkdownNodeSchema,
  collaborationMarkdownTreeWithinBudget,
  collaborationOpenPlanPublishAllowed,
  collaborationPlanAccepted,
  collaborationPlanMode,
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  collaborationWorkflowInputBasis,
  deriveCollaborationDecision,
  isAgentInPair,
  MAX_COMMENTS_PER_MESSAGE,
  originSideChatSchema,
  otherAgent,
  pactCommandRouteAllowed,
  pactEntryPrimary,
  parseComposerCommandPrefix,
  relaySchedulingDecisionProofSchema,
  resolveActiveAgentPair,
  settleCollaborationStage,
  type AgentRun,
  type AnchoredComment,
  type CollaborationActionInput,
  type CollaborationAskRef,
  type CollaborationDocument,
  type CollaborationLimits,
  type CollaborationMarkdownNode,
  type CollaborationReplyIntentBasis,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type ConversationPatch,
  type OriginSideChat,
  type RuntimeAgentId,
  type SchedulingHandoff,
  type WorkflowRelayCandidateId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  anchoredComments,
  collaborationActionReceipts,
  collaborationInputs,
  collaborationMarkdownPages,
  collaborationTasks,
  conversationBodyInputs,
  conversationBodyParts,
  conversationImageAssets,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationQueueOperations,
  relayDecisions,
  runReexecutionOperations,
  schedulingBudgetReservations,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import {
  finalizeMainSyncBackReceipt,
  recoverIncompleteSyncMainOperations,
} from '../side-chat-persistence.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { samePlanContent, storedReceivedMetadata } from './helpers.js'
import {
  activeRunStatuses,
  BODY_INTERNAL_READ_BYTES,
  BODY_PART_UNITS,
  RunOperationConflictError,
  type BeginRunInput,
  type RelayWorkflowSnapshot,
} from './types.js'

export function receivedCollaborationInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  includeCancelled = false,
) {
  if (!includeCancelled) return repo.sourceQueries.activeReceivedInput().get({ sessionId })
  return repo.database
    .select()
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.sessionId, sessionId),
        includeCancelled
          ? and(
              ne(collaborationInputs.state, 'materialized'),
              sql`NOT EXISTS (SELECT 1 FROM ${conversationQueueOperations} WHERE ${conversationQueueOperations.inputId} = ${collaborationInputs.id} AND ${conversationQueueOperations.kind} = 'remove' AND ${conversationQueueOperations.targetRunId} IS NOT NULL AND ${conversationQueueOperations.state} = 'complete')`,
            )
          : inArray(collaborationInputs.state, ['accepted', 'blocked']),
      ),
    )
    .orderBy(desc(collaborationInputs.createdAt))
    .limit(1)
    .get()
}

export function receivedInputReceipt(
  repo: ConversationRepositoryHost,
  sessionId: string,
  clientMessageId: string,
  input?: import('@pact/contracts').ConversationSendInput,
  waitingForWork = false,
  expectedActor?: RuntimeAgentId,
): ConversationPatch | undefined {
  const row = repo.database
    .select()
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.id, clientMessageId),
        eq(collaborationInputs.sessionId, sessionId),
      ),
    )
    .get()
  if (!row) return undefined
  if (expectedActor && expectedActor !== row.actor) {
    throw new RunOperationConflictError('This received nonce belongs to different input.')
  }
  if (input) {
    const meta = storedReceivedMetadata(row.metadataJson)
    let effectivePrefixText = input.content
    if (input.inputId && input.inputId === row.inputId && !input.content) {
      const body = repo.database
        .select()
        .from(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.id, row.inputId),
            eq(conversationBodyInputs.sessionId, sessionId),
          ),
        )
        .get()
      if (body?.sealed && body.bytes <= BODY_INTERNAL_READ_BYTES) {
        const read = repo.readBody(body, true)
        if (read.hash === row.digest && read.hash === body.hash) {
          effectivePrefixText = read.text
        }
      }
    }
    const prefix = parseComposerCommandPrefix(effectivePrefixText, input.skills)
    const routeMatches = (() => {
      if (meta.route?.type === 'all') {
        const requested = input.route ?? prefix.route
        if (requested?.type !== 'all') return false
        if (input.route && input.route.type !== 'all') return false
        if (input.route && 'firstAgentId' in input.route && 'firstAgentId' in meta.route) {
          return (
            Reflect.get(input.route, 'firstAgentId') === meta.route.firstAgentId &&
            Reflect.get(input.route, 'secondAgentId') === meta.route.secondAgentId
          )
        }
        return true
      }
      return JSON.stringify(input.route) === JSON.stringify(meta.route)
    })()
    const askOnly =
      meta.replyIntentBasis?.kind === 'ask_only'
        ? { taskId: row.taskId, expectedRevision: meta.replyIntentBasis.taskRevision }
        : undefined
    if (
      (input.inputId && input.inputId !== row.inputId) ||
      (!input.inputId && createHash('sha256').update(input.content).digest('hex') !== row.digest) ||
      (!meta.batchId && JSON.stringify(input.commentIds) !== JSON.stringify(meta.commentIds)) ||
      (input.batchId ?? input.clientMessageId) !== (meta.batchId ?? row.id) ||
      (input.freezeDrafts ?? true) !== (meta.freezeDrafts ?? true) ||
      JSON.stringify(input.imageIds ?? []) !== JSON.stringify(meta.imageIds) ||
      JSON.stringify(input.skills ?? []) !== JSON.stringify(meta.skills) ||
      !routeMatches ||
      !isDeepStrictEqual(input.replyToDecision, meta.replyToDecision) ||
      !isDeepStrictEqual(input.replaceTask, meta.replaceTask) ||
      !isDeepStrictEqual(input.askOnly, askOnly)
    )
      throw new RunOperationConflictError('This received nonce belongs to different input.')
  }
  return repo.createPatch(sessionId, {
    receivedInputIds: [row.id],
    ...(waitingForWork && row.state === 'accepted' ? { queuedInputIds: [row.id] } : {}),
  })
}

/** New user input admission; durable receipts and authorized workflow dispatch are checked separately. */
export function assertDecisionInput(
  repo: ConversationRepositoryHost,
  input: Pick<
    import('@pact/contracts').ConversationSendInput,
    | 'sessionId'
    | 'content'
    | 'replyToDecision'
    | 'freezeDrafts'
    | 'imageIds'
    | 'commentIds'
    | 'skills'
    | 'route'
    | 'returnedInputOperationId'
    | 'queueReturnOperationId'
  >,
): void {
  const saved = collaboration(repo, input.sessionId)
  const task = saved?.status === 'complete' ? undefined : saved
  const decision = task && collaborationInputProcessing(task).decision
  if (!input.replyToDecision) {
    if (decision)
      throw new RunOperationConflictError(
        'Answer the current questions in the question card before sending another message. Your message draft was preserved.',
      )
    return
  }
  const ref = input.replyToDecision
  const gate = task && collaborationInputGate(task)
  const previous = task && repo.findRun(task.runId)
  const confirmedFollowUp =
    gate === 'incomplete' &&
    previous &&
    ((previous.dispatchPhase === 'ended' && previous.nativeEffectsState === 'settled') ||
      workflowInputWasNotSent(repo, previous)) &&
    !repo.nativeRecoveryBlocksInput(input.sessionId)
  if (
    !task ||
    !decision ||
    task.id !== ref.taskId ||
    decision.runId !== ref.runId ||
    decision.inputSequence !== ref.decisionInputSequence ||
    task.inputSequence !== ref.expectedInputSequence ||
    (gate !== 'needs_reply' && !confirmedFollowUp)
  )
    throw new RunOperationConflictError(
      'These questions changed or the previous answer is not yet settled. Your answers were preserved; review the current request or recovery notice.',
    )
  const prefix = parseComposerCommandPrefix(input.content, input.skills)
  if (
    input.freezeDrafts !== false ||
    input.imageIds?.length ||
    input.commentIds.length ||
    input.skills?.length ||
    input.returnedInputOperationId ||
    input.queueReturnOperationId ||
    input.route ||
    prefix.pact ||
    prefix.route
  )
    throw new RunOperationConflictError(
      'Submit only the card answers. Your message, attachments and other drafts must stay separate.',
    )
}

/** A new Pact command can replace the unfinished current task only with its confirmed reference. */
export function assertTaskReplacement(
  repo: ConversationRepositoryHost,
  input: Pick<import('@pact/contracts').ConversationSendInput, 'sessionId' | 'replaceTask'>,
  workflowCommand: boolean,
): void {
  const saved = collaboration(repo, input.sessionId)
  const unfinished = saved && saved.status !== 'complete' && !saved.ending ? saved : undefined
  const reference = input.replaceTask
  if (!workflowCommand) {
    if (reference)
      throw new RunOperationConflictError(
        'This task replacement no longer matches its command. Send it again.',
      )
    return
  }
  if (!unfinished) {
    if (reference && saved?.id !== reference.taskId)
      throw new RunOperationConflictError(
        'The confirmed task is no longer current. Review and send this command again.',
      )
    return
  }
  if (
    !reference ||
    reference.taskId !== unfinished.id ||
    reference.revision !== unfinished.revision
  )
    throw new RunOperationConflictError(
      'Confirm replacing the current task before sending this command. Your draft was preserved.',
    )
}

function freezeReplyIntent(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  inputId: string,
  inputDigest: string,
  actor: RuntimeAgentId,
  _explicitTarget: RuntimeAgentId | undefined,
  waitingForWork: boolean,
  askOnly?: CollaborationAskRef,
): CollaborationReplyIntentBasis | undefined {
  if (askOnly)
    return freezeReplyCheckpoint(
      repo,
      task,
      inputId,
      inputDigest,
      actor,
      waitingForWork,
      askOnly,
      'ask_only',
    )
  return freezeReplyCheckpoint(
    repo,
    task,
    inputId,
    inputDigest,
    actor,
    waitingForWork,
    undefined,
    'explanation_only',
  )
}

/**
 * Freeze a settled checkpoint for a read-only reply. Only the host receipt creates this
 * record; a missing review is never fabricated and no unrelated native context is initialized.
 * ask_only keeps its legacy identity checks; explanation_only binds the already-admitted
 * ordinary input and carries the semantic workflow basis inside the checkpoint.
 */
function freezeReplyCheckpoint(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  inputId: string,
  inputDigest: string,
  actor: RuntimeAgentId,
  waitingForWork: boolean,
  askOnly: CollaborationAskRef | undefined,
  mode: 'ask_only' | 'explanation_only',
): CollaborationReplyIntentBasis | undefined {
  const status = task.status
  const gate = repo.activeRelayDecisionRow(task.sessionId)
  if (
    waitingForWork ||
    (mode === 'ask_only' &&
      (askOnly?.taskId !== task.id || askOnly.expectedRevision !== task.revision)) ||
    status === 'running' ||
    status === 'complete' ||
    (mode === 'ask_only' && actor !== collaborationAskActor(task)) ||
    !collaborationAskAvailable(task) ||
    (gate && !repo.isUnansweredRelaySuggestion(gate)) ||
    repo.nativeRecoveryBlocksInput(task.sessionId) ||
    repo.hasPendingRoutedContinuation(task.sessionId)
  )
    return undefined
  const binding = repo.nativeContext(task.sessionId, actor)
  if (
    !binding?.nativeSessionId ||
    binding.bindingGeneration === undefined ||
    binding.continuationState !== 'ready' ||
    binding.permissionRequests?.length
  )
    return undefined
  const review = task.review
  if (review) {
    const original = repo.relayCompletedTurn(
      task,
      repo.database.select().from(workflowTurns).where(eq(workflowTurns.runId, review.runId)).get(),
    )
    if (
      !original ||
      original.source.verdict !== review.verdict ||
      original.source.inputSequence !== review.inputSequence ||
      original.source.actor !== review.actor ||
      !isDeepStrictEqual(original.source.document, review.document) ||
      !isDeepStrictEqual(original.auth.planReference, review.planReference)
    )
      return undefined
  }
  if (task.planReference) {
    const document = collaborationDocumentRow(repo, task.sessionId, task.planReference.document)
    if (document.sourceRunId !== task.planReference.sourceRunId) return undefined
  }
  return {
    kind: mode,
    askBinding: {
      nativeSessionId: binding.nativeSessionId,
      generation: binding.bindingGeneration,
    },
    askCheckpoint: {
      stage: task.stage,
      actor: task.actor,
      status,
      automation: task.automation,
      ...(task.pauseReason ? { pauseReason: task.pauseReason } : {}),
      ...(task.nextStage ? { nextStage: task.nextStage } : {}),
      ...(task.notice ? { notice: task.notice } : {}),
      ...(mode === 'explanation_only'
        ? {
            ...(task.planInputSequence !== undefined
              ? { planInputSequence: task.planInputSequence }
              : {}),
            inputBasis: collaborationWorkflowInputBasis(task),
          }
        : {}),
    },
    inputId,
    inputDigest,
    priorInputSequence: task.inputSequence,
    taskRevision: task.revision,
    ...(review ? { review } : {}),
    stageRoles: task.stageRoles,
    planReference: task.planReference,
  }
}

export function receiveCollaborationInput(
  repo: ConversationRepositoryHost,
  input: import('@pact/contracts').ConversationSendInput,
  inputId: string,
  actor: RuntimeAgentId,
  policy: 'immediate_safe_point' | 'next_round',
  ownerKey: string,
  waitingForWork = false,
  anchorRunId?: string,
  rolePolicy?: CollaborationTask['rolePolicy'],
  options?: {
    originSideChat?: OriginSideChat
    syncMainOperationId?: string
  },
): ConversationPatch {
  return repo.database.transaction(() => {
    assertSessionAvailable(repo.database, input.sessionId)
    const originSideChat = options?.originSideChat
      ? originSideChatSchema.parse(options.originSideChat)
      : undefined
    const priorReceipt = receivedInputReceipt(
      repo,
      input.sessionId,
      input.clientMessageId,
      input,
      waitingForWork,
      actor,
    )
    if (priorReceipt) return priorReceipt
    if (receivedCollaborationInput(repo, input.sessionId))
      throw new RunOperationConflictError(
        'One message is already waiting. Your draft was preserved.',
      )
    const count = repo.database
      .select({ value: sql<number>`count(*)` })
      .from(collaborationInputs)
      .where(inArray(collaborationInputs.state, ['accepted', 'blocked']))
      .get()!.value
    if (count >= 5)
      throw new RunOperationConflictError(
        'All five received-input slots are occupied. Your draft was preserved.',
      )
    const session = repo.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    if (
      !session ||
      (!originSideChat && session.commentsRevision !== input.expectedCommentsRevision)
    )
      throw new RunOperationConflictError('Comment drafts changed before receipt.')
    if (
      !session.queueEnabled &&
      (!collaboration(repo, input.sessionId) ||
        collaboration(repo, input.sessionId)?.status === 'complete')
    )
      throw new RunOperationConflictError('The queue is disabled. Your draft was preserved.')
    const freezeDrafts = input.freezeDrafts ?? true
    if (!freezeDrafts && input.commentIds.length)
      throw new RunOperationConflictError(
        'A preserved draft cannot also be included in this message.',
      )
    const commentCount = repo.database
      .select({ value: sql<number>`count(*)` })
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, input.sessionId),
          originSideChat
            ? eq(anchoredComments.pendingReceiptId, input.clientMessageId)
            : and(
                isNull(anchoredComments.sentWithMessageId),
                isNull(anchoredComments.pendingReceiptId),
                freezeDrafts ? undefined : sql`0`,
              ),
        ),
      )
      .get()!.value
    const body = repo.bodyInput(inputId, input.sessionId, ownerKey)
    if (
      !body.sealed ||
      body.bytes > BODY_INTERNAL_READ_BYTES ||
      body.clientMessageId !== input.clientMessageId
    )
      throw new RunOperationConflictError('The received input is not sealed.')
    if (
      (!input.inputId && createHash('sha256').update(input.content).digest('hex') !== body.hash) ||
      (input.inputId && input.inputId !== inputId)
    )
      throw new RunOperationConflictError('The received nonce has different body content.')
    const source = repo.readBody(body, true)
    if (source.hash !== body.hash)
      throw new RunOperationConflictError('The received body changed after sealing.')
    assertDecisionInput(repo, { ...input, content: source.text })
    const prefix = parseComposerCommandPrefix(source.text, input.skills)
    if (prefix.error) throw new RunOperationConflictError(prefix.error)
    if (
      input.askOnly &&
      (prefix.pact ||
        prefix.route ||
        input.route ||
        freezeDrafts ||
        input.commentIds.length ||
        input.imageIds?.length ||
        input.skills?.length ||
        input.userInformation ||
        input.replyToDecision ||
        input.returnedInputOperationId ||
        input.queueReturnOperationId)
    )
      throw new RunOperationConflictError('Ask only sends question text to the Plan author.')
    const savedTask = collaboration(repo, input.sessionId)
    const candidate = savedTask?.status === 'complete' ? undefined : savedTask
    const inTaskReview = repo.isInTaskReviewCommand(candidate, prefix.pact)
    const workflowCommand = Boolean(prefix.pact) && !inTaskReview
    const settings = repo.database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, input.sessionId),
          eq(sessionSettingsRevisions.revision, session.settingsRevision),
        ),
      )
      .get()
    if (!settings) {
      throw new RunOperationConflictError('Session settings are unavailable.')
    }
    const activePair = resolveActiveAgentPair({
      primaryAgentId: settings.primaryAgentId,
      secondaryAgentId: settings.secondaryAgentId,
    })
    const allowedMembers =
      !workflowCommand && candidate && candidate.owner !== candidate.reviewer
        ? ([candidate.owner, candidate.reviewer] as const)
        : activePair
    if (!isAgentInPair(actor, allowedMembers)) {
      throw new RunOperationConflictError(
        `${agentDisplayName(actor)} is not an active Agent in this Session.`,
      )
    }
    if (prefix.route?.type === 'agent' && !isAgentInPair(prefix.route.agentId, allowedMembers)) {
      throw new RunOperationConflictError(
        `@${prefix.route.agentId} is not an active Agent in this Session.`,
      )
    }
    if (input.route?.type === 'agent' && !isAgentInPair(input.route.agentId, allowedMembers)) {
      throw new RunOperationConflictError(
        `@${input.route.agentId} is not an active Agent in this Session.`,
      )
    }
    for (const skill of input.skills ?? []) {
      if (!isAgentInPair(skill.agentId, allowedMembers)) {
        throw new RunOperationConflictError(
          `Skill /${skill.name} belongs to ${agentDisplayName(skill.agentId)}, which is not an active Agent in this Session.`,
        )
      }
    }
    if (rolePolicy) {
      const requestedRoute = input.route ?? prefix.route
      const primary = prefix.pact
        ? pactEntryPrimary(
            prefix.pact,
            settings.primaryAgentId,
            requestedRoute?.type === 'agent' ? requestedRoute.agentId : undefined,
            settings.secondaryAgentId,
          )
        : undefined
      if (
        requestedRoute?.type === 'all' ||
        (requestedRoute?.type === 'agent' && requestedRoute.agentId !== actor) ||
        !prefix.pact ||
        !primary ||
        actor !==
          collaborationActor(
            {
              kind: prefix.pact,
              owner: primary,
              reviewer: otherAgent(primary, activePair),
              rolePolicy,
            },
            prefix.pact === 'plan' ? 'plan' : prefix.pact === 'build' ? 'implement' : 'code_review',
          )
      )
        throw new RunOperationConflictError('The queued workflow role changed before receipt.')
    }
    const anchor = anchorRunId ? repo.findRun(anchorRunId) : undefined
    const task =
      !workflowCommand && (!anchor || anchor.collaboration?.taskId === candidate?.id)
        ? candidate
        : undefined
    assertTaskReplacement(repo, input, workflowCommand)
    if (
      (task && input.route && prefix.route && !isDeepStrictEqual(input.route, prefix.route)) ||
      (prefix.pact && !pactCommandRouteAllowed(input.route, prefix.route))
    )
      throw new RunOperationConflictError(
        'The explicit Agent recipients conflict. Your draft was preserved.',
      )
    const images = repo.resolveMessageImages(input.sessionId, input.imageIds ?? [], ownerKey)
    if (!commentCount && !images.length && !repo.bodyHasText(body))
      throw new RunOperationConflictError(
        'Write a message, add a Comment, or attach an image before sending.',
      )
    const requestedRoute = input.route ?? prefix.route
    const intent =
      task && !inTaskReview && !input.replyToDecision
        ? freezeReplyIntent(
            repo,
            task,
            input.clientMessageId,
            body.hash,
            actor,
            requestedRoute?.type === 'agent' ? requestedRoute.agentId : undefined,
            waitingForWork,
            input.askOnly,
          )
        : undefined
    const askOnly = intent?.kind === 'ask_only'
    if (input.askOnly && !askOnly)
      throw new RunOperationConflictError(
        'Ask only needs an idle Agent at the current task checkpoint.',
      )
    const frozenQueueRoute =
      requestedRoute?.type === 'all'
        ? {
            type: 'all' as const,
            firstAgentId: actor,
            secondAgentId: otherAgent(actor, allowedMembers),
          }
        : input.route
    const metadata = JSON.stringify({
      workflowCommand,
      ...(inTaskReview ? { inTaskReview: true } : {}),
      ...(input.routeIntent ? { routeIntent: input.routeIntent } : {}),
      replyIntentBasis: intent,
      ...(rolePolicy ? { rolePolicy } : {}),
      skills: input.skills ?? [],
      imageIds: images.map((v) => v.id),
      commentIds: [],
      batchId: input.batchId ?? input.clientMessageId,
      freezeDrafts,
      route: frozenQueueRoute,
      replyToDecision: input.replyToDecision,
      replaceTask: input.replaceTask,
      ...(originSideChat ? { originSideChat } : {}),
    })
    if (Buffer.byteLength(metadata) > 64 * 1024)
      throw new RunOperationConflictError('Received metadata exceeds 64 KiB.')
    const now = new Date().toISOString()
    repo.freezeInputBatch({
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      commentsRevision: session.commentsRevision,
      actor,
      ...(task && !askOnly ? { taskId: task.id } : {}),
      inputId,
      ...(originSideChat ? { pendingReceiptId: input.clientMessageId } : {}),
      preserveDraftComments: !freezeDrafts,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    })
    repo.database
      .insert(collaborationInputs)
      .values({
        id: input.clientMessageId,
        sessionId: input.sessionId,
        taskId: task?.id ?? null,
        anchorRunId:
          task?.runId ??
          repo.database
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.sessionId, input.sessionId),
                inArray(agentRuns.status, [...activeRunStatuses]),
              ),
            )
            .get()?.id ??
          input.clientMessageId,
        preview: repo.receivedBodyPreview(body.id),
        queueRevision: session.queueRevision + 1,
        queueState: 'queued',
        queueReason: null,
        inputId,
        digest: body.hash,
        actor,
        policy,
        metadataJson: metadata,
        state: 'accepted',
        createdAt: now,
        deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .run()
    repo.supersedePausedPreparedInput(input.sessionId, input.batchId ?? input.clientMessageId)
    repo.database
      .update(conversationBodyInputs)
      .set({ pendingReceiptId: input.clientMessageId })
      .where(eq(conversationBodyInputs.id, inputId))
      .run()
    if (commentCount && !originSideChat)
      repo.database
        .update(anchoredComments)
        .set({ pendingReceiptId: input.clientMessageId })
        .where(
          and(
            eq(anchoredComments.sessionId, input.sessionId),
            isNull(anchoredComments.sentWithMessageId),
            isNull(anchoredComments.pendingReceiptId),
          ),
        )
        .run()
    if (images.length)
      repo.database
        .update(conversationImageAssets)
        .set({ pendingReceiptId: input.clientMessageId, committed: true })
        .where(
          inArray(
            conversationImageAssets.id,
            images.map((v) => v.id),
          ),
        )
        .run()
    repo.database
      .update(sessions)
      .set({
        commentsRevision: originSideChat ? session.commentsRevision : session.commentsRevision + 1,
        queueRevision: session.queueRevision + 1,
        queuePauseReason: null,
      })
      .where(eq(sessions.id, input.sessionId))
      .run()
    if (options?.syncMainOperationId && originSideChat) {
      finalizeMainSyncBackReceipt(repo.database, {
        operationId: options.syncMainOperationId,
        sideChatId: originSideChat.sideChatId,
        parentSessionId: input.sessionId,
        cutoffId: originSideChat.cutoffId,
        disposition: 'queued',
        mainMessageId: null,
        queuedOperationId: input.clientMessageId,
      })
    }
    repo.database
      .update(agentRuns)
      .set({ peerProposalState: 'superseded' })
      .where(
        and(eq(agentRuns.sessionId, input.sessionId), eq(agentRuns.peerProposalState, 'pending')),
      )
      .run()
    if (input.queueReturnOperationId) {
      repo.requireInstalledQueueReturn(input.sessionId, input.queueReturnOperationId)
      repo.consumeQueuedReturn(input.sessionId, input.queueReturnOperationId)
    }
    const relayGate = repo.activeRelayDecisionRow(input.sessionId)
    if (relayGate && repo.isUnansweredRelaySuggestion(relayGate))
      repo.discardUnansweredRelaySchedulingDecision(input.sessionId, false)
    if (!workflowCommand && !inTaskReview)
      repo.registerWorkflowInput(input.sessionId, input.clientMessageId, askOnly)
    return repo.createPatch(input.sessionId, {
      receivedInputIds: [input.clientMessageId],
      ...(waitingForWork ? { queuedInputIds: [input.clientMessageId] } : {}),
      resync: { messages: false, drafts: !originSideChat, activityRunIds: [] },
      runs: task ? [repo.findRun(task.runId)!] : [],
      comments: {
        revision: originSideChat ? session.commentsRevision : session.commentsRevision + 1,
        upserts: [],
        removedIds:
          !originSideChat && input.commentIds.length <= MAX_COMMENTS_PER_MESSAGE
            ? input.commentIds
            : [],
      },
    })
  })
}

export function pendingCollaborationInputs(repo: ConversationRepositoryHost) {
  return repo.database
    .select({
      sessionId: collaborationInputs.sessionId,
      id: collaborationInputs.id,
      deadline: collaborationInputs.deadline,
    })
    .from(collaborationInputs)
    .where(
      and(eq(collaborationInputs.state, 'accepted'), eq(collaborationInputs.queueState, 'queued')),
    )
    .orderBy(asc(collaborationInputs.createdAt))
    .limit(5)
    .all()
}

export function readReceivedInput(repo: ConversationRepositoryHost, sessionId: string) {
  const input = receivedCollaborationInput(repo, sessionId)
  if (!input) return undefined
  const body = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, input.inputId))
    .get()
  if (!body || !body.sealed || body.hash !== input.digest)
    throw new RunOperationConflictError('The received body is unavailable.')
  const read = repo.readBody(body, true)
  if (read.hash !== input.digest) throw new RunOperationConflictError('The received body changed.')
  const metadata = storedReceivedMetadata(input.metadataJson)
  return {
    ...input,
    manuallyResumed: Boolean(
      repo.database
        .select({ id: conversationQueueOperations.id })
        .from(conversationQueueOperations)
        .where(
          and(
            eq(conversationQueueOperations.sessionId, sessionId),
            eq(conversationQueueOperations.inputId, input.id),
            eq(conversationQueueOperations.kind, 'resume'),
            eq(conversationQueueOperations.state, 'complete'),
          ),
        )
        .orderBy(desc(conversationQueueOperations.createdAt))
        .limit(1)
        .get(),
    ),
    content: read.text,
    metadata,
    comments: [] as AnchoredComment[],
    inputBatchRef: repo.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.clientMessageId, input.id))
      .get(),
  }
}

export function setReceivedInputState(
  repo: ConversationRepositoryHost,
  sessionId: string,
  state: 'accepted' | 'blocked' | 'cancelled',
  receiptId?: string,
): ConversationPatch {
  return repo.database.transaction(() => {
    const row = receiptId
      ? repo.database
          .select()
          .from(collaborationInputs)
          .where(
            and(
              eq(collaborationInputs.id, receiptId),
              eq(collaborationInputs.sessionId, sessionId),
            ),
          )
          .get()
      : receivedCollaborationInput(repo, sessionId)
    if (!row || row.state === 'materialized') {
      if (receiptId)
        throw new RunOperationConflictError('This received input is no longer available.')
      return repo.metadataPatch(sessionId)
    }
    if (row.queueState === 'dispatching' || row.queueState === 'unknown')
      return repo.metadataPatch(sessionId)
    if (state !== 'cancelled' && row.state === 'cancelled')
      throw new RunOperationConflictError(
        'Cancelled input cannot be reauthorized. Send a new message.',
      )
    repo.database
      .update(collaborationInputs)
      .set({
        state,
        ...(state === 'blocked'
          ? {
              queueState: 'paused' as const,
              queueReason: 'Automatic queue delivery is paused. Resume when ready.',
            }
          : state === 'cancelled'
            ? { queueState: 'removed' as const }
            : {}),
        deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .where(eq(collaborationInputs.id, row.id))
      .run()
    if (state === 'cancelled') {
      const batch = repo.database
        .select({ id: conversationInputBatches.id })
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.clientMessageId, row.id))
        .get()
      if (batch) withdrawInputBatch(repo, batch.id)
    }
    repo.advanceQueue(sessionId)
    const task = collaboration(repo, sessionId)
    if (task) {
      task.revision++
      saveCollaboration(repo, task)
    }
    return repo.metadataPatch(sessionId)
  })
}

export function recoverCollaborationTasks(repo: ConversationRepositoryHost): void {
  reconcileCollaborationActionReceipts(repo)
  // A saved grant is audit history, never a queue to resume after restart.
  repo.database
    .update(collaborationActionReceipts)
    .set({ state: 'cancelled', active: false, updatedAt: new Date().toISOString() })
    .where(eq(collaborationActionReceipts.state, 'available'))
    .run()
  repo.database
    .update(collaborationInputs)
    .set({
      queueState: 'paused',
      queueReason: 'Application restarted before delivery began. Resume when ready.',
    })
    .where(
      sql`${collaborationInputs.id} IN (SELECT q.input_id FROM conversation_queue_operations q WHERE q.kind='steer' AND q.state='prepared')`,
    )
    .run()
  repo.database
    .update(conversationQueueOperations)
    .set({ state: 'refused' })
    .where(
      and(
        eq(conversationQueueOperations.kind, 'steer'),
        eq(conversationQueueOperations.state, 'prepared'),
      ),
    )
    .run()
  repo.database
    .update(collaborationInputs)
    .set({
      queueState: 'paused',
      queueReason: 'Application restarted. Resume the queue when ready.',
    })
    .where(
      and(
        inArray(collaborationInputs.state, ['accepted', 'blocked']),
        inArray(collaborationInputs.queueState, ['queued', 'paused']),
      ),
    )
    .run()
  repo.database
    .update(collaborationInputs)
    .set({
      queueState: 'unknown',
      queueReason: 'Delivery was interrupted. Resolve the original delivery before continuing.',
    })
    .where(
      and(
        inArray(collaborationInputs.state, ['accepted', 'blocked']),
        eq(collaborationInputs.queueState, 'dispatching'),
      ),
    )
    .run()
  repo.database
    .update(conversationQueueOperations)
    .set({ state: 'unknown' })
    .where(
      and(
        eq(conversationQueueOperations.kind, 'steer'),
        eq(conversationQueueOperations.state, 'possibly_sent'),
      ),
    )
    .run()
  repo.database
    .update(sessions)
    .set({
      queuePauseReason: 'Application restarted. Resume the queue when ready.',
      queueRevision: sql`${sessions.queueRevision} + 1`,
    })
    .where(
      sql`${sessions.id} IN (SELECT i.session_id FROM collaboration_inputs i WHERE i.state IN ('accepted','blocked'))`,
    )
    .run()
  // Keep native outcome/current work intact; unfinished automation restarts paused.
  const limitPaused = sql`(json_extract(${collaborationTasks.stateJson}, '$.automation') = 'paused' AND json_extract(${collaborationTasks.stateJson}, '$.pauseReason') = 'limit' AND json_extract(${collaborationTasks.stateJson}, '$.kind') = 'plan' AND json_extract(${collaborationTasks.stateJson}, '$.stage') IN ('plan', 'reply') AND json_extract(${collaborationTasks.stateJson}, '$.status') = 'waiting' AND json_extract(${collaborationTasks.stateJson}, '$.pendingWork') IS NULL AND json_extract(${collaborationTasks.stateJson}, '$.inputProcessing.pending') IS NULL)`
  repo.database
    .update(collaborationTasks)
    .set({
      stateJson: sql`json_set(${collaborationTasks.stateJson}, '$.automation', 'paused', '$.pauseReason', CASE WHEN ${limitPaused} THEN 'limit' ELSE 'restart' END, '$.revision', json_extract(${collaborationTasks.stateJson}, '$.revision') + 1, '$.notice', CASE WHEN json_extract(${collaborationTasks.stateJson}, '$.inputProcessing.pending') IS NOT NULL THEN coalesce(json_extract(${collaborationTasks.stateJson}, '$.notice'), 'Check the previous reply, then send a follow-up before continuing.') WHEN ${limitPaused} THEN coalesce(json_extract(${collaborationTasks.stateJson}, '$.notice'), 'Plan review limit reached.') ELSE 'Application restarted. Check the original execution, then continue collaboration.' END)`,
    })
    .where(
      and(
        eq(collaborationTasks.active, true),
        sql`json_extract(${collaborationTasks.stateJson}, '$.protocol') = ${COLLABORATION_PROTOCOL}`,
        sql`json_extract(${collaborationTasks.stateJson}, '$.status') <> 'complete'`,
      ),
    )
    .run()
  recoverUnsentPlanQuestions(repo)
  repo.recoverRelayDecisionGates()
  recoverIncompleteSyncMainOperations(repo.database)
}

function recoverUnsentPlanQuestions(repo: ConversationRepositoryHost): void {
  // Only current tasks can still own a pending question. A terminal Run can be
  // saved just before the Utility settles its workflow input.
  let afterSession = ''
  for (;;) {
    const rows = repo.database
      .select({ sessionId: collaborationTasks.sessionId, runId: agentRuns.id })
      .from(collaborationTasks)
      .innerJoin(
        agentRuns,
        sql`${agentRuns.id}=json_extract(${collaborationTasks.stateJson}, '$.runId')`,
      )
      .innerJoin(workflowTurns, eq(workflowTurns.runId, agentRuns.id))
      .where(
        and(
          sql`${collaborationTasks.active} = 1`,
          gt(collaborationTasks.sessionId, afterSession),
          eq(workflowTurns.taskId, collaborationTasks.id),
          eq(workflowTurns.applied, false),
          inArray(agentRuns.status, ['failed', 'interrupted']),
          inArray(agentRuns.dispatchPhase, ['not_sent', 'rejected']),
          sql`json_extract(${workflowTurns.authorizationJson}, '$.replyIntentBasis.kind') = 'ask_only'`,
        ),
      )
      .orderBy(asc(collaborationTasks.sessionId))
      .limit(25)
      .all()
    if (!rows.length) return
    for (const { runId } of rows) {
      const run = repo.findRun(runId)
      if (run && workflowInputWasNotSent(repo, run))
        finishCollaboration(repo, runId, false, 'The question was never sent.')
    }
    afterSession = rows.at(-1)!.sessionId
  }
}

export function collaboration(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId?: string,
  _hydrate?: boolean,
): CollaborationTask | undefined {
  if (runId) {
    const active = collaboration(repo, sessionId)
    if (active?.runId === runId) return active
    const run = repo.findRun(runId)
    if (!run || run.sessionId !== sessionId)
      throw new RunOperationConflictError('The workflow source is unavailable.')
    // An ended task stays readable on its last Run after it leaves the active slot.
    const taskRow = run.collaboration
      ? repo.database
          .select()
          .from(collaborationTasks)
          .where(
            and(
              eq(collaborationTasks.id, run.collaboration.taskId),
              eq(collaborationTasks.sessionId, sessionId),
            ),
          )
          .get()
      : undefined
    const ended = taskRow && decodedCollaboration(repo, taskRow.stateJson)
    if (ended?.ending && ended.runId === runId)
      return { ...ended, inputSequence: taskRow!.inputSequence }
    const turn = repo.database
      .select({
        applied: workflowTurns.applied,
        authorizationJson: workflowTurns.authorizationJson,
        state: workflowTurns.stateJson,
      })
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!turn) return undefined
    const snapshot = decodedCollaboration(repo, turn.state)
    return turn.applied &&
      !snapshot.ending &&
      snapshot.planReference?.sourceRunId !== runId &&
      (snapshot.status === 'waiting' ||
        snapshot.automation !== 'paused' ||
        snapshot.pauseReason !== 'failure')
      ? repo.projectAppliedPlanUnavailable(run, turn, snapshot)
      : snapshot
  }
  const row = repo.database
    .select()
    .from(collaborationTasks)
    .where(
      and(
        eq(collaborationTasks.sessionId, sessionId),
        eq(collaborationTasks.active, true),
        sql`json_extract(${collaborationTasks.stateJson}, '$.protocol') = ${COLLABORATION_PROTOCOL}`,
      ),
    )
    .get()
  if (!row) return undefined
  const task = decodedCollaboration(repo, row.stateJson)
  return { ...task, inputSequence: row.inputSequence }
}

/** Immutable Run-owned content; physical segment limits never bound cumulative text. */
export function saveCollaborationDocument(
  repo: ConversationRepositoryHost,
  runId: string,
  text: string,
): CollaborationDocument {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The content Run is unavailable.')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const ownerKey = `collaboration:${runId}`
  const old = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.ownerKey, ownerKey),
        eq(conversationBodyInputs.clientMessageId, sha256),
        eq(conversationBodyInputs.purpose, 'collaboration'),
      ),
    )
    .get()
  if (old?.sealed && old.hash === sha256)
    return { id: old.id, sha256, bytes: old.bytes, chars: old.chars }
  const now = new Date().toISOString()
  const id = randomUUID()
  repo.database
    .insert(conversationBodyInputs)
    .values({
      id,
      sessionId: run.sessionId,
      clientMessageId: sha256,
      ownerKey,
      purpose: 'collaboration',
      sourceRunId: runId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  let row = repo.bodyInput(id, run.sessionId, ownerKey)
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + BODY_PART_UNITS)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
    repo.appendBodyPart(row, offset, text.slice(offset, end))
    offset = end
    row = repo.bodyInput(id, run.sessionId, ownerKey)
  }
  repo.sealBody(row)
  return { id, sha256, bytes: row.bytes, chars: row.chars }
}

export function collaborationDocumentRow(
  repo: ConversationRepositoryHost,
  sessionId: string,
  ref: CollaborationDocument,
) {
  const row = repo.sourceQueries.document().get({ sessionId, documentId: ref.id })
  if (
    !row?.sealed ||
    !row.sourceRunId ||
    row.hash !== ref.sha256 ||
    row.bytes !== ref.bytes ||
    row.chars !== ref.chars
  )
    throw new RunOperationConflictError(
      'The immutable source does not match. Copy its complete id, sha256, bytes and chars from the supplied reference.',
    )
  return row
}

export function collaborationCommentDocument(
  repo: ConversationRepositoryHost,
  sessionId: string,
  anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
): CollaborationDocument | undefined {
  const runId = anchor.plan?.runId ?? anchor.report?.runId
  if (!runId) return undefined
  const run = repo.findRun(runId)
  if (
    !run ||
    run.sessionId !== sessionId ||
    (run.userMessageId !== anchor.messageId && run.responseMessageId !== anchor.messageId)
  )
    throw new RunOperationConflictError('The Comment source Run changed.')
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  if (!turn?.applied) return undefined
  if (anchor.plan) {
    const task = decodedCollaboration(repo, turn.stateJson)
    if (task.planReference?.version !== anchor.plan.version)
      throw new RunOperationConflictError('The plan version changed.')
    return task.planReference.document
  }
  return turn.reportBodyId ? repo.documentReference(sessionId, turn.reportBodyId) : undefined
}

export function usePlainCollaborationProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .update(conversationBodyInputs)
    .set({ projectionBasis: 'plain-visible-v1' })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
}

export function collaborationRawRange(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  start: number,
  end: number,
): string {
  collaborationDocumentRow(repo, sessionId, source)
  let text = '',
    cursor = start
  while (cursor < end) {
    const row = repo.database
      .select()
      .from(conversationBodyParts)
      .where(
        and(
          eq(conversationBodyParts.inputId, source.id),
          lte(conversationBodyParts.offset, cursor),
        ),
      )
      .orderBy(desc(conversationBodyParts.offset))
      .limit(1)
      .get()
    if (!row) throw new RunOperationConflictError('The source has a missing text segment.')
    const next = row.text.slice(cursor - row.offset, Math.min(row.text.length, end - row.offset))
    if (!next.length) throw new RunOperationConflictError('The source has a missing text segment.')
    text += next
    cursor += next.length
  }
  return text
}

export function beginMarkdownProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .delete(collaborationMarkdownPages)
    .where(eq(collaborationMarkdownPages.documentId, source.id))
    .run()
}

export function recordMarkdownPage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  page: {
    ordinal: number
    visibleStart: number
    visibleEnd: number
    tree: CollaborationMarkdownNode
    visibleText: string
  },
): void {
  collaborationDocumentRow(repo, sessionId, source)
  const tree = collaborationMarkdownNodeSchema.parse(page.tree)
  const json = JSON.stringify(tree)
  if (
    Buffer.byteLength(json) > 40 * 1024 ||
    !collaborationMarkdownTreeWithinBudget(tree) ||
    page.visibleText.length > 4096 ||
    page.visibleText.length !== page.visibleEnd - page.visibleStart
  )
    throw new RunOperationConflictError(
      'Invalid Markdown projection page. Original content is preserved.',
    )
  const prior = repo.database
    .select()
    .from(collaborationMarkdownPages)
    .where(
      and(
        eq(collaborationMarkdownPages.documentId, source.id),
        eq(collaborationMarkdownPages.ordinal, page.ordinal - 1),
      ),
    )
    .get()
  if (
    (page.ordinal === 0 && page.visibleStart !== 0) ||
    (page.ordinal > 0 && prior?.visibleEnd !== page.visibleStart)
  )
    throw new RunOperationConflictError('Markdown projection has a missing page.')
  repo.database
    .insert(collaborationMarkdownPages)
    .values({
      documentId: source.id,
      ordinal: page.ordinal,
      visibleStart: page.visibleStart,
      visibleEnd: page.visibleEnd,
      treeJson: json,
      visibleText: page.visibleText,
    })
    .run()
}

export function sealMarkdownProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  pages: number,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .update(conversationBodyInputs)
    .set({ projectionPages: pages, projectionBasis: 'markdown-visible-v2' })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
}

export function collaborationQuote(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  start: number,
  end: number,
  basis: 'markdown-visible-v2' | 'plain-visible-v1' = 'markdown-visible-v2',
): string {
  if (end - start > 20_000 || start < 0 || end <= start)
    throw new RunOperationConflictError('Invalid Comment quote range.')
  if (basis === 'plain-visible-v1')
    return collaborationRawRange(repo, sessionId, source, start, end)
  const body = collaborationDocumentRow(repo, sessionId, source)
  if (body.projectionPages === null || end - start > 20_000)
    throw new RunOperationConflictError('The selected Markdown range is not ready.')
  const rows = repo.database
    .select({
      visibleStart: collaborationMarkdownPages.visibleStart,
      visibleText: collaborationMarkdownPages.visibleText,
    })
    .from(collaborationMarkdownPages)
    .where(
      and(
        eq(collaborationMarkdownPages.documentId, source.id),
        gte(collaborationMarkdownPages.visibleStart, Math.max(0, start - 4096)),
        lt(collaborationMarkdownPages.visibleStart, end),
        gt(collaborationMarkdownPages.visibleEnd, start),
        gt(collaborationMarkdownPages.visibleEnd, collaborationMarkdownPages.visibleStart),
      ),
    )
    .orderBy(asc(collaborationMarkdownPages.visibleStart))
    .limit(20_000)
    .all()
  const quote = rows
    .map((row) =>
      row.visibleText.slice(
        Math.max(0, start - row.visibleStart),
        Math.min(row.visibleText.length, end - row.visibleStart),
      ),
    )
    .join('')
  if (quote.length !== end - start)
    throw new RunOperationConflictError('The Comment source range is unavailable.')
  return quote
}

export function collaborationDocumentText(
  repo: ConversationRepositoryHost,
  sessionId: string,
  ref: CollaborationDocument,
): string {
  const row = collaborationDocumentRow(repo, sessionId, ref)
  const read = repo.readBody(row, true)
  if (read.hash !== ref.sha256)
    throw new RunOperationConflictError('The complete source digest changed.')
  return read.text
}

export function storedCollaboration(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): CollaborationTask {
  const taskDocument =
    task.taskDocument ??
    (task.task.length > 1024 && repo.findRun(task.runId)
      ? saveCollaborationDocument(repo, task.runId, task.task)
      : undefined)
  return collaborationTaskSchema.parse({
    ...task,
    task: taskDocument ? '' : task.task,
    ...(taskDocument ? { taskDocument } : {}),
  })
}

export function collaborationPromptState(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): CollaborationTask {
  const turn = repo.database
    .select({ state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, task.runId))
    .get()
  return turn ? decodedCollaboration(repo, turn.state) : storedCollaboration(repo, task)
}

export function assertWorkflowDispatch(repo: ConversationRepositoryHost, runId: string): void {
  const run = repo.findRun(runId)
  if (
    !run?.collaboration ||
    run.dispatchPhase === 'possibly_sent' ||
    run.dispatchPhase === 'accepted'
  )
    return
  const auth = repo.collaborationTurnAuthorization(runId)
  const current = collaboration(repo, run.sessionId)
  repo.assertRelayDecisionResolved(run.sessionId)
  if (auth?.replyIntentBasis?.kind === 'ask_only') {
    const intent = auth.replyIntentBasis
    const binding = repo.nativeContext(run.sessionId, run.agentId)
    if (
      !current ||
      current.runId !== runId ||
      current.inputProcessing?.pending?.inputId !== intent.inputId ||
      !repo.currentReplyIntent(current, run, auth) ||
      !intent.askBinding ||
      binding?.nativeSessionId !== intent.askBinding.nativeSessionId ||
      binding.bindingGeneration !== intent.askBinding.generation
    )
      throw new RunOperationConflictError(
        'The task checkpoint or its Agent changed before dispatch.',
      )
  }
  if (current && auth) {
    if (!isDeepStrictEqual(current.stageRoles, auth.stageRoles))
      throw new RunOperationConflictError('The workflow stage roles changed before dispatch.')
    if (current.planRevision && ['implement', 'repair', 'respond'].includes(auth.stage))
      throw new RunOperationConflictError(
        'The revised Plan requires a new explicit Implement action.',
      )
  }
  if (auth?.userAuthority) {
    const receipt = repo.database
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, auth.userAuthority.receiptId))
      .get()
    if (
      !receipt ||
      receipt.boundRunId !== runId ||
      receipt.taskId !== auth.taskId ||
      receipt.actor !== auth.actor ||
      receipt.state !== 'bound' ||
      receipt.rootReceiptId !== auth.userAuthority.rootReceiptId
    )
      throw new RunOperationConflictError('The native Turn has no current bound action receipt.')
    if (receipt.action === 'extend_plan_review') {
      const extension = scheduling.confirmedPlanReviewExtension(repo.database, receipt.id),
        session = repo.database
          .select({ settingsRevision: sessions.settingsRevision })
          .from(sessions)
          .where(eq(sessions.id, run.sessionId))
          .get()
      if (
        !repo.schedulingSettings().enabled ||
        !extension ||
        session?.settingsRevision !== run.settingsRevision ||
        auth.stage !== 'plan_review' ||
        extension.taskId !== auth.taskId ||
        extension.actor !== auth.actor ||
        extension.inputSequence !== auth.inputSequence ||
        !isDeepStrictEqual(extension.planReference, auth.planReference)
      )
        throw new RunOperationConflictError(
          'The one-review confirmation changed before native dispatch.',
        )
    }
  } else if (auth && ['implement', 'repair', 'respond'].includes(auth.stage))
    throw new RunOperationConflictError(
      'The native action is missing its concrete user authorization.',
    )
  if (
    !auth ||
    !current ||
    current.id !== auth.taskId ||
    current.runId !== runId ||
    current.revision !== auth.taskRevision ||
    current.inputSequence !== auth.inputSequence ||
    (!['reply', 'collaborate'].includes(auth.stage) &&
      (current.automation !== 'active' || Boolean(collaborationInputGate(current))))
  )
    throw new RunOperationConflictError(
      'The workflow was paused or changed before native dispatch.',
    )
}

export function decodedCollaboration(
  repo: ConversationRepositoryHost,
  state: string,
  _hydrate?: boolean,
): CollaborationTask {
  return collaborationTaskSchema.parse(JSON.parse(state))
}

export function withdrawInputBatch(repo: ConversationRepositoryHost, batchId: string): void {
  const batch = repo.database
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, batchId))
    .get()
  if (!batch) return
  const now = new Date().toISOString()
  repo.database
    .update(conversationInputBatchMembers)
    .set({ state: 'withdrawn', updatedAt: now })
    .where(eq(conversationInputBatchMembers.batchId, batchId))
    .run()
  repo.database
    .update(conversationInputBatches)
    .set({ bodyState: 'withdrawn', state: 'closed', closedAt: now })
    .where(eq(conversationInputBatches.id, batchId))
    .run()
  const task = collaboration(repo, batch.sessionId)
  if (
    task &&
    !batch.taskId &&
    collaborationInputProcessing(task).pending?.inputId === batch.clientMessageId
  ) {
    const receipt = repo.database
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, batch.clientMessageId))
      .get()
    if (
      receipt?.sessionId === task.sessionId &&
      !receipt.taskId &&
      storedReceivedMetadata(receipt.metadataJson).workflowCommand
    ) {
      task.inputProcessing = { ...collaborationInputProcessing(task), pending: undefined }
      task.revision++
      saveCollaboration(repo, task)
      return
    }
    const intent = receipt ? storedReceivedMetadata(receipt.metadataJson) : undefined
    if (
      receipt?.sessionId === task.sessionId &&
      receipt.taskId === task.id &&
      intent?.replyIntentBasis?.kind === 'ask_only'
    ) {
      const run = batch.runId ? repo.findRun(batch.runId) : undefined
      if (
        !run ||
        workflowInputWasNotSent(repo, run) ||
        (run.dispatchPhase === 'ended' && run.nativeOutcome && run.nativeEffectsState === 'settled')
      ) {
        task.inputProcessing = { ...collaborationInputProcessing(task), pending: undefined }
        repo.restoreAskCheckpoint(
          task,
          intent.replyIntentBasis,
          'restored',
          'The question was withdrawn.',
        )
        task.revision++
        saveCollaboration(repo, task)
      }
      return
    }
  }
  if (batch.taskId === task?.id && task.latestUserMessageId === batch.clientMessageId) {
    const latest = repo.database
      .select({ messageId: conversationInputBatches.messageId })
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.taskId, task.id),
          ne(conversationInputBatches.bodyState, 'withdrawn'),
          isNotNull(conversationInputBatches.messageId),
        ),
      )
      .orderBy(desc(conversationInputBatches.sequence))
      .limit(1)
      .get()
    task.latestUserMessageId = latest?.messageId ?? undefined
    const processing = collaborationInputProcessing(task)
    if (processing.pending?.inputSequence === batch.sequence) {
      // Withdrawal changes the input basis without a new confirmed reply. Retain
      // explicit pauses and require reconciliation before any automatic handoff.
      if (task.automation === 'active') {
        task.automation = 'paused'
        task.pauseReason = 'failure'
      }
      task.notice =
        'An input was withdrawn. Confirm the current scope before continuing collaboration.'
      const turn = repo.database
        .select()
        .from(workflowTurns)
        .where(and(eq(workflowTurns.runId, task.runId), eq(workflowTurns.taskId, task.id)))
        .get()
      const auth = turn
        ? collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
        : undefined
      const previous =
        (auth?.stage === 'reply' || auth?.stage === 'collaborate') && turn
          ? (
              auth.inputProcessing ??
              collaborationInputProcessing(decodedCollaboration(repo, turn.stateJson))
            ).pending
          : undefined
      const source = previous
        ? repo.database
            .select({ id: conversationInputBatches.id })
            .from(conversationInputBatches)
            .where(
              and(
                eq(conversationInputBatches.taskId, task.id),
                eq(conversationInputBatches.clientMessageId, previous.inputId),
                eq(conversationInputBatches.sequence, previous.inputSequence),
                ne(conversationInputBatches.bodyState, 'withdrawn'),
              ),
            )
            .get()
        : undefined
      const settled = source
        ? repo.database
            .select({ sequence: agentEventJournal.sequence })
            .from(agentEventJournal)
            .where(
              and(
                eq(agentEventJournal.runId, task.runId),
                eq(agentEventJournal.eventType, 'workflow.input_settled'),
              ),
            )
            .limit(1)
            .get()
        : undefined
      task.inputProcessing = {
        ...processing,
        pending: source && !settled ? previous : undefined,
      }
    }
    task.revision++
    const previousRun = task.inputProcessing?.pending ? repo.findRun(task.runId) : undefined
    if (
      (task.stage === 'reply' || task.stage === 'collaborate') &&
      previousRun?.dispatchPhase === 'ended'
    ) {
      task.status = 'failed'
      task.notice =
        'A later message was withdrawn. Check the previous reply and send a follow-up if its input still needs confirmation.'
    }
    saveCollaboration(repo, task)
    if (previousRun?.dispatchPhase === 'ended') repo.recoverAppliedWorkflowResult(task.runId)
  }
}

export function saveCollaboration(repo: ConversationRepositoryHost, task: CollaborationTask): void {
  task = { ...task, inputProcessing: collaborationInputProcessing(task) }
  const persistent = repo.database
    .select({ inputSequence: collaborationTasks.inputSequence })
    .from(collaborationTasks)
    .where(eq(collaborationTasks.id, task.id))
    .get()
  task.inputSequence = persistent?.inputSequence ?? task.inputSequence
  if (task.planAcceptanceCoverage?.throughInputSequence !== task.inputSequence)
    task.planAcceptanceCoverage = undefined
  if (task.reviewControlCoverage?.inputSequence !== task.inputSequence)
    task.reviewControlCoverage = undefined
  task = storedCollaboration(repo, task)
  const now = new Date().toISOString()
  repo.database
    .update(collaborationTasks)
    .set({ stateJson: JSON.stringify(task), updatedAt: now })
    .where(eq(collaborationTasks.id, task.id))
    .run()
  const run = repo.findRun(task.runId)
  if (run)
    repo.database
      .update(agentRuns)
      .set({
        updatedAt: new Date(Math.max(Date.now(), Date.parse(run.updatedAt) + 1)).toISOString(),
      })
      .where(eq(agentRuns.id, run.id))
      .run()
}

/** Explicit maintenance operation for an accepted plan with no code authority to transfer. */
export function adoptSplitStageRoles(
  repo: ConversationRepositoryHost,
  input: {
    sessionId: string
    taskId: string
    revision: number
    settingsRevision: number
    operationId: string
  },
): ConversationPatch {
  return repo.database.transaction(() => {
    assertSessionAvailable(repo.database, input.sessionId)
    const task = collaboration(repo, input.sessionId)
    if (!task || task.id !== input.taskId)
      throw new RunOperationConflictError('The requested collaboration task is no longer current.')
    if (task.rolePolicy === 'split-stages-v1') return repo.metadataPatch(input.sessionId)
    const session = repo.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    const settings = repo.database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, input.sessionId),
          eq(sessionSettingsRevisions.revision, input.settingsRevision),
        ),
      )
      .get()
    const run = repo.findRun(task.runId)
    const live = repo.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, input.sessionId),
          inArray(agentRuns.status, [...activeRunStatuses]),
        ),
      )
      .limit(1)
      .get()
    const unsafeTaskRun = repo.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.collaborationTaskId, task.id),
          or(
            inArray(agentRuns.collaborationStage, ['implement', 'repair']),
            isNull(agentRuns.nativeEffectsState),
            ne(agentRuns.nativeEffectsState, 'settled'),
          ),
        ),
      )
      .limit(1)
      .get()
    const authority = repo.database
      .select({ id: collaborationActionReceipts.id })
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.taskId, task.id))
      .limit(1)
      .get()
    if (
      !/^[a-f0-9-]{36}$/u.test(input.operationId) ||
      !session ||
      session.settingsRevision !== input.settingsRevision ||
      !settings ||
      task.revision !== input.revision ||
      task.kind !== 'plan' ||
      task.status !== 'ready' ||
      task.owner !== settings.primaryAgentId ||
      task.reviewer !== settings.secondaryAgentId ||
      !collaborationPlanAccepted(task) ||
      task.codeRunId ||
      task.pendingWork ||
      collaborationInputGate(task) ||
      receivedCollaborationInput(repo, input.sessionId) ||
      repo.nativeRecoveryBlocksInput(input.sessionId) ||
      repo.activeRelayDecisionRow(input.sessionId) ||
      live ||
      unsafeTaskRun ||
      authority ||
      !run ||
      run.nativeOutcome !== 'completed' ||
      run.dispatchPhase !== 'ended' ||
      !repo.hasCompleteResponse(run.id)
    )
      throw new RunOperationConflictError(
        'Only a settled accepted plan without existing code authority can adopt split stage roles.',
      )
    collaborationDocumentRow(repo, input.sessionId, task.planReference!.document)
    const next = { ...task, rolePolicy: 'split-stages-v1' as const, revision: task.revision + 1 }
    if (next.actor !== collaborationActor(next, next.stage))
      throw new RunOperationConflictError(
        'The completed stage does not match the requested responsibilities.',
      )
    saveCollaboration(repo, next)
    repo.nativeFact(task.runId, 'workflow.role_policy_adopted', {
      operationId: input.operationId,
      taskId: task.id,
      previousRevision: task.revision,
      revision: next.revision,
      settingsRevision: input.settingsRevision,
      rolePolicy: next.rolePolicy,
      owner: next.owner,
      reviewer: next.reviewer,
    })
    return repo.metadataPatch(input.sessionId)
  })
}

export function planRevisionBasisMatches(
  repo: ConversationRepositoryHost,
  current: CollaborationTask,
  next: CollaborationTask,
): boolean {
  return (
    isDeepStrictEqual(current.planRevision, next.planRevision) &&
    (!current.planRevision ||
      (current.inputSequence === next.inputSequence &&
        current.handledInputSequence === next.handledInputSequence &&
        isDeepStrictEqual(
          collaborationInputProcessing(current),
          collaborationInputProcessing(next),
        ) &&
        current.planVersion === next.planVersion &&
        current.planInputSequence === next.planInputSequence &&
        current.codeRunId === next.codeRunId &&
        isDeepStrictEqual(current.planReference, next.planReference) &&
        isDeepStrictEqual(current.review, next.review) &&
        isDeepStrictEqual(current.reviewScopeRef, next.reviewScopeRef)))
  )
}

export function setCollaborationState(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): ConversationPatch {
  return repo.database.transaction(() => {
    const current = collaboration(repo, task.sessionId)
    if (
      !current ||
      current.id !== task.id ||
      current.revision + 1 !== task.revision ||
      current.owner !== task.owner ||
      current.reviewer !== task.reviewer ||
      current.rolePolicy !== task.rolePolicy ||
      !isDeepStrictEqual(current.stageRoles, task.stageRoles) ||
      !isDeepStrictEqual(current.planAcceptanceCoverage, task.planAcceptanceCoverage) ||
      !isDeepStrictEqual(current.reviewControlCoverage, task.reviewControlCoverage) ||
      !planRevisionBasisMatches(repo, current, task) ||
      (current.planRevision &&
        (task.status === 'complete' ||
          task.stage !== current.stage ||
          task.actor !== current.actor ||
          task.runId !== current.runId ||
          !isDeepStrictEqual(current.pendingWork, task.pendingWork)))
    )
      throw new RunOperationConflictError('The collaboration changed before this action.')
    saveCollaboration(repo, task)
    return repo.metadataPatch(task.sessionId)
  })
}

export function pauseCollaboration(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason: NonNullable<CollaborationTask['pauseReason']>,
): ConversationPatch {
  return repo.database.transaction(() => {
    if (reason !== 'failure') repo.cancelSchedulingRecoveryFaults(sessionId)
    const task = collaboration(repo, sessionId)
    if (task && task.status !== 'complete') {
      task.automation = 'paused'
      task.pauseReason = reason
      task.revision++
      task.notice =
        reason === 'user_message'
          ? 'Automatic collaboration is paused. Your message will be answered next.'
          : 'Collaboration is paused. Continue when ready.'
      saveCollaboration(repo, task)
    }
    return repo.metadataPatch(sessionId)
  })
}

/** Terminal retirement for confirmed replacement, inside the caller's transaction. */
export function replaceCollaborationTask(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  input: {
    clientMessageId: string
    taskRevision: number
  },
): void {
  const now = new Date().toISOString()
  // Only unused task-bound grants retire; bound receipts and native evidence stay fenced by CAS.
  repo.database
    .update(collaborationActionReceipts)
    .set({ state: 'cancelled', active: false, updatedAt: now })
    .where(
      and(
        eq(collaborationActionReceipts.taskId, task.id),
        eq(collaborationActionReceipts.state, 'available'),
        eq(collaborationActionReceipts.active, true),
        isNull(collaborationActionReceipts.boundRunId),
      ),
    )
    .run()
  const gate = repo.activeRelayDecisionRow(task.sessionId)
  if (gate && gate.taskId === task.id) {
    repo.database
      .update(relayDecisions)
      .set({ state: 'invalid', active: false, revision: gate.revision + 1, updatedAt: now })
      .where(eq(relayDecisions.id, gate.id))
      .run()
    scheduling.recordRelayDecisionActivity(repo.database, gate.id)
    repo.database
      .update(collaborationActionReceipts)
      .set({ state: 'cancelled', active: false, updatedAt: now })
      .where(
        and(
          eq(collaborationActionReceipts.decisionId, gate.id),
          eq(collaborationActionReceipts.state, 'available'),
          isNull(collaborationActionReceipts.boundRunId),
        ),
      )
      .run()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: task.runId,
      eventType: 'scheduling.user_decision_invalidated',
      payload: JSON.stringify({ decisionId: gate.id, reason: 'task_replaced' }),
      createdAt: now,
    })
  }
  const unreviewedChanges = collaborationUnreviewedWrite(repo, task)
  appendAgentEvent(repo.database, {
    sessionId: task.sessionId,
    runId: task.runId,
    eventType: 'collaboration.task_replaced',
    payload: JSON.stringify({
      taskId: task.id,
      nonce: input.clientMessageId,
      stage: task.stage,
      status: task.status,
      pendingWorkStage: task.pendingWork?.stage ?? null,
      planRevision: Boolean(task.planRevision),
      unreviewedChanges,
      inputId: input.clientMessageId,
    }),
    createdAt: now,
  })
  task.ending = {
    clientMessageId: input.clientMessageId,
    taskRevision: input.taskRevision,
    endedAt: now,
    reason: 'replaced',
    replacementMessageId: input.clientMessageId,
    unreviewedChanges,
  }
  task.automation = 'paused'
  task.nextStage = undefined
  task.revision++
  saveCollaboration(repo, task)
  repo.database
    .update(collaborationTasks)
    .set({ active: false, updatedAt: now })
    .where(eq(collaborationTasks.id, task.id))
    .run()
}

/** Whether the latest authorized write lacks a successful settled review of that exact write. */
function collaborationUnreviewedWrite(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): boolean {
  // A current or interrupted write is reviewed before an earlier code Run it may supersede.
  const currentWrite =
    task.pendingWork?.runId ??
    (task.stage === 'implement' || task.stage === 'repair' ? task.runId : undefined)
  const currentRun = currentWrite ? repo.findRun(currentWrite) : undefined
  const lastWrite =
    currentRun && !workflowInputWasNotSent(repo, currentRun) ? currentRun.id : task.codeRunId
  if (!lastWrite) return false
  const review = task.review
  if (
    !review ||
    review.stage !== 'code_review' ||
    review.verdict === 'incomplete' ||
    !review.scopeRef ||
    !review.document
  )
    return true
  const reviewRun = repo.findRun(review.runId)
  const turn = repo.database
    .select({ applied: workflowTurns.applied, state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, review.runId))
    .get()
  if (
    !turn?.applied ||
    !reviewRun ||
    reviewRun.dispatchPhase !== 'ended' ||
    reviewRun.nativeOutcome !== 'completed' ||
    reviewRun.nativeEffectsState !== 'settled' ||
    !repo.hasCompleteResponse(review.runId)
  )
    return true
  const frozen = decodedCollaboration(repo, turn.state)
  return !(
    frozen.codeRunId === lastWrite &&
    frozen.review?.stage === 'code_review' &&
    frozen.review.verdict !== 'incomplete' &&
    Boolean(frozen.review.scopeRef) &&
    Boolean(frozen.review.document)
  )
}

export function collaborationReplacementProjection(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): NonNullable<import('@pact/contracts').CollaborationView['replacement']> {
  const agentName = (stage: Parameters<typeof collaborationActor>[1]) =>
    agentDisplayName(collaborationActor(task, stage))
  const unreviewedChanges = collaborationUnreviewedWrite(repo, task)
  const review = task.review
  const summary = task.planRevision
    ? 'The requirement change has not been re-planned.'
    : task.pendingWork
      ? `${agentName(task.pendingWork.stage)}'s ${
          task.pendingWork.stage === 'implement' ? 'implementation' : 'repair'
        } was interrupted and will not be resumed.`
      : task.status === 'running' && (task.stage === 'implement' || task.stage === 'repair')
        ? `${agentName(task.stage)} is still working. That response finishes first; its changes will not be reviewed.`
        : unreviewedChanges
          ? `${agentName('implement')}'s changes have not been reviewed.`
          : review?.stage === 'code_review' &&
              review.verdict === 'changes_requested' &&
              review.inputSequence === collaborationWorkflowInputBasis(task).inputSequence
            ? `${agentName('code_review')} requested changes that have not been addressed.`
            : collaborationPlanAccepted(task) && !task.codeRunId
              ? `Plan v${task.planReference?.version ?? task.planVersion} is accepted but not implemented.`
              : task.stage === 'plan'
                ? 'The plan is still being prepared.'
                : task.stage === 'plan_review'
                  ? `Plan v${task.planReference?.version ?? task.planVersion} is still in review.`
                  : 'This task is paused.'
  return {
    summary: summary.slice(0, 512),
    unreviewedChanges,
  }
}

export function reconcileCompletedCollaboration(
  repo: ConversationRepositoryHost,
  runId: string,
): ConversationPatch | undefined {
  const run = repo.findRun(runId)
  if (
    !run?.collaboration ||
    run.forkSourceRunId ||
    (run.dispatchPhase !== 'ended' && !workflowInputWasNotSent(repo, run))
  )
    return undefined
  const task = collaboration(repo, run.sessionId)
  const before = task?.revision
  finishCollaboration(
    repo,
    runId,
    run.dispatchPhase === 'ended' && run.nativeOutcome === 'completed',
  )
  return collaboration(repo, run.sessionId)?.revision !== before
    ? repo.metadataPatch(run.sessionId)
    : undefined
}

export function workflowInputWasNotSent(repo: ConversationRepositoryHost, run: AgentRun): boolean {
  return Boolean(
    run.collaboration &&
    !run.nativeTurnId &&
    !run.nativeOutcome &&
    ['not_sent', 'rejected'].includes(run.dispatchPhase ?? '') &&
    (run.nativeEffectsState === 'not_dispatched' ||
      (run.nativeEffectsState === 'settled' &&
        ['workflow_input_withheld', 'native_turn_not_started'].includes(
          run.nativeEffectsReason ?? '',
        ))),
  )
}

export function finishCollaboration(
  repo: ConversationRepositoryHost,
  runId: string,
  complete: boolean,
  notice?: string,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!run || run.forkSourceRunId || !turn || run.controlDisposition === 'abandoned') return
    settleCollaborationAction(repo, run)
    if (turn.applied) {
      if (complete) repo.recoverAppliedWorkflowResult(runId)
      return
    }
    const current = collaboration(repo, run.sessionId)
    const isCurrent = current?.id === turn.taskId && current.runId === runId
    if (!isCurrent) return
    const task = current
    task.inputProcessing = collaborationInputProcessing(task)
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = decodedCollaboration(repo, turn.stateJson)
    const nativeCompleted =
      complete && run.dispatchPhase === 'ended' && run.nativeOutcome === 'completed'
    if (auth.replyIntentBasis?.kind === 'ask_only') {
      repo.finishAskOnly(task, run, auth, nativeCompleted, notice)
      return
    }
    const unstarted = workflowInputWasNotSent(repo, run)
    const effectsSettled =
      run.nativeEffectsState === 'settled' || run.nativeEffectsState === 'not_dispatched'
    if (nativeCompleted && !effectsSettled) {
      if (
        run.nativeEffectsState === 'unknown' &&
        (task.status !== 'failed' || task.automation !== 'paused')
      ) {
        Object.assign(
          task,
          settleCollaborationStage(task, { kind: 'unavailable', reason: 'effects' }),
        )
        task.revision++
        saveCollaboration(repo, task)
      }
      return
    }
    if (nativeCompleted && !repo.hasCompleteResponse(runId) && run.status !== 'completed') return
    if (!nativeCompleted) {
      const ended = run.dispatchPhase === 'ended'
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'interrupted',
          authorization: auth,
          stopped: run.nativeOutcome === 'interrupted' || run.failureKind === 'user_stopped',
          unstarted,
          failed: run.nativeOutcome === 'failed',
          ended,
          effectsSettled,
          completeResponse: false,
          ...(turn.reservation ? { reservation: turn.reservation } : {}),
          ...(notice !== undefined ? { notice } : {}),
        }),
      )
      task.revision++
      saveCollaboration(repo, task)
      if (unstarted || run.dispatchPhase === 'ended')
        repo.database
          .update(workflowTurns)
          .set({
            applied: true,
            stateJson: JSON.stringify({
              ...task,
              inputSequence: auth.inputSequence,
              latestUserMessageId: frozen.latestUserMessageId,
            }),
          })
          .where(eq(workflowTurns.runId, runId))
          .run()
      return
    }
    const messageId = run.responseMessageId
    const report = messageId ? repo.messageDocument(run.sessionId, runId, messageId) : undefined
    const plan =
      turn.planBodyId && turn.planNativeId
        ? repo.documentReference(run.sessionId, turn.planBodyId)
        : undefined
    const planner = collaborationPlanMode(frozen, auth)
    const canPublishPlan = planner || collaborationOpenPlanPublishAllowed(frozen, auth)
    if (!report && !plan) {
      Object.assign(task, settleCollaborationStage(task, { kind: 'unavailable', reason: 'source' }))
      task.revision++
      saveCollaboration(repo, task)
      return
    }
    const retained = repo.workflowPlanRetention(runId, turn.planNativeId)
    const planSettled = Boolean(
      canPublishPlan && turn.planNativeId && repo.settleWorkflowPlan(task, run, auth, turn),
    )
    // A completed older root cannot settle or fail a newer accepted input.
    // A real failed Plan capture still pauses automation when newer input is queued.
    const supersededInput =
      ((auth.inputSequence < task.inputSequence &&
        task.inputProcessing?.pending?.inputSequence === task.inputSequence) ||
        Boolean(receivedCollaborationInput(repo, task.sessionId))) &&
      (!canPublishPlan || !repo.workflowPlanCaptureFailed(runId))
    task.sourceMessageId = messageId ?? run.userMessageId
    task.authorization = auth
    task.handledInputSequence = Math.max(task.handledInputSequence, auth.inputSequence)
    task.notice = undefined
    if (auth.stage === 'reply') {
      Object.assign(task, settleCollaborationStage(task, { kind: 'reply' }))
      if (
        !supersededInput &&
        !repo.settleWorkflowInput(task, run, auth, turn, planSettled) &&
        task.status === 'waiting'
      )
        Object.assign(
          task,
          settleCollaborationStage(task, { kind: 'unavailable', reason: 'reply' }),
        )
    } else if (auth.stage === 'plan') {
      const unanswered =
        !planSettled && !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      const observed =
        !planSettled &&
        !supersededInput &&
        !unanswered &&
        Boolean(
          plan ||
          retained ||
          repo.workflowPlanCaptureFailed(runId) ||
          repo.workflowInputResult(runId),
        )
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'plan',
          authorization: auth,
          settled: planSettled,
          supersededInput,
          observed,
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'plan_review' || auth.stage === 'code_review') {
      const verdict =
        !turn.verdictConflict && turn.verdict && report?.chars ? turn.verdict : 'incomplete'
      const needsDecision = verdict === 'needs_user'
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'review',
          authorization: { ...auth, stage: auth.stage },
          verdict,
          verdictConflict: turn.verdictConflict,
          supersededInput,
          ...(report ? { document: report } : {}),
          ...(needsDecision
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(
                    repo.workflowReviewResult(runId)?.questions,
                  ),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'collaborate') {
      const hasCodeChanges = repo.runHasRecordedCodeChanges(run.sessionId, runId)
      const hasPublishedPlan = Boolean(planSettled && turn.planBodyId)
      const planCaptureFailed = !hasPublishedPlan && repo.workflowPlanCaptureFailed(runId)
      const unanswered = !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'collaborate',
          authorization: auth,
          hasCodeChanges,
          hasPublishedPlan,
          ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'implement' || auth.stage === 'repair' || auth.stage === 'respond') {
      const hasCodeChanges = repo.runHasRecordedCodeChanges(run.sessionId, runId)
      const hasPublishedPlan = Boolean(planSettled && turn.planBodyId)
      const planCaptureFailed = !hasPublishedPlan && repo.workflowPlanCaptureFailed(runId)
      const unanswered = !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'work',
          authorization: { ...auth, stage: auth.stage },
          hasCodeChanges,
          hasPublishedPlan,
          ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    }
    task.revision++
    const snapshot = storedCollaboration(repo, {
      ...task,
      inputProcessing:
        task.inputProcessing?.pending &&
        task.inputProcessing.pending.inputSequence > auth.inputSequence
          ? (auth.inputProcessing ?? collaborationInputProcessing(frozen))
          : task.inputProcessing,
      inputSequence: auth.inputSequence,
      handledInputSequence: Math.min(task.handledInputSequence, auth.inputSequence),
      latestUserMessageId: frozen.latestUserMessageId,
    })
    repo.database
      .update(workflowTurns)
      .set({
        applied: true,
        reportBodyId: report?.id ?? null,
        stateJson: JSON.stringify(snapshot),
      })
      .where(eq(workflowTurns.runId, runId))
      .run()
    saveCollaboration(repo, task)
  })
}

export function actionReceiptBasis(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  next: CollaborationTask,
  handoff: SchedulingHandoff,
): {
  handoff: SchedulingHandoff
  taskId: string
  rolePolicy?: CollaborationTask['rolePolicy']
  stageRoles?: CollaborationTask['stageRoles']
  inputSequence: number
  stage: CollaborationTask['stage']
  actor: RuntimeAgentId
  planReference: CollaborationTask['planReference'] | null
  review: CollaborationTask['review'] | null
  reviewScopeRef: CollaborationDocument | null
  previousRunId: string | null
  planRevision?: CollaborationTask['planRevision']
  actorBinding: {
    generation: number
    nativeSessionId: string | null
    continuationState: string | null
    permissions: string
  }
} {
  const binding = repo.nativeContext(task.sessionId, next.actor)
  return {
    handoff,
    taskId: task.id,
    ...(task.rolePolicy ? { rolePolicy: task.rolePolicy } : {}),
    ...(task.stageRoles ? { stageRoles: task.stageRoles } : {}),
    inputSequence: task.inputSequence,
    stage: next.stage,
    actor: next.actor,
    planReference: task.planReference ?? null,
    review: task.review ?? null,
    reviewScopeRef: task.reviewScopeRef ?? null,
    previousRunId: task.pendingWork?.runId ?? null,
    ...(task.planRevision ? { planRevision: task.planRevision } : {}),
    actorBinding: {
      generation: binding?.bindingGeneration ?? 1,
      nativeSessionId: binding?.nativeSessionId ?? null,
      continuationState: binding?.continuationState ?? null,
      permissions: scheduling.fingerprint(binding?.permissionRequests ?? []),
    },
  }
}

export function authorityJson(repo: ConversationRepositoryHost, value: unknown): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > 4 * 1024)
    throw new RunOperationConflictError('The complete action receipt exceeds its metadata budget.')
  return json
}

export function collaborationActionProjection(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): {
  availableActions: import('@pact/contracts').CollaborationAction[]
} {
  const workflowDecision = deriveCollaborationDecision(task, repo.planReviewLimits(task.sessionId))
  try {
    const projected = workflowDecision.availableActions.filter(
      (action) =>
        action !== 'swap_code_roles' || repo.codeRoleChangeAvailable(task, undefined, true),
    )
    return { availableActions: projected }
  } catch (error) {
    if (!(error instanceof RunOperationConflictError)) throw error
    return { availableActions: [] }
  }
}

export function collaborationActionReceipt(
  repo: ConversationRepositoryHost,
  input: CollaborationActionInput,
) {
  const receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(
      and(
        eq(collaborationActionReceipts.sessionId, input.sessionId),
        eq(collaborationActionReceipts.clientNonce, input.clientMessageId),
      ),
    )
    .get()
  if (receipt && receipt.requestDigest !== scheduling.fingerprint(input))
    throw new RunOperationConflictError('This action nonce belongs to a different request.')
  return receipt
}

/** Resolve the frozen scope, independently of the cursor of later processed input. */
export function unfinishedWriteSource(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  runId: string,
  forPlanRevision = false,
): {
  run: AgentRun
  turn: typeof workflowTurns.$inferSelect
  auth: CollaborationTurnAuthorization
  frozen: CollaborationTask
} {
  const run = repo.findRun(runId)
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  const auth = turn
    ? collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    : undefined
  const frozen = turn ? decodedCollaboration(repo, turn.stateJson) : undefined
  if (
    !run ||
    !turn ||
    !auth ||
    !frozen ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    run.sessionId !== task.sessionId ||
    auth.runId !== run.id ||
    auth.taskId !== task.id ||
    turn.taskId !== task.id ||
    !['implement', 'repair'].includes(auth.stage) ||
    auth.actor !== collaborationActor(forPlanRevision ? frozen : task, 'implement') ||
    turn.stage !== auth.stage ||
    turn.actor !== auth.actor ||
    turn.inputSequence !== auth.inputSequence ||
    run.collaboration?.taskId !== task.id ||
    run.collaboration.stage !== auth.stage ||
    run.agentId !== auth.actor ||
    frozen.id !== task.id ||
    frozen.sessionId !== task.sessionId ||
    frozen.owner !== task.owner ||
    frozen.reviewer !== task.reviewer ||
    frozen.rolePolicy !== task.rolePolicy ||
    (!forPlanRevision && !isDeepStrictEqual(frozen.stageRoles, task.stageRoles)) ||
    (forPlanRevision &&
      (collaborationActor(frozen, 'plan') !== collaborationActor(task, 'plan') ||
        collaborationActor(frozen, 'plan_review') !== collaborationActor(task, 'plan_review'))) ||
    !isDeepStrictEqual(auth.stageRoles, frozen.stageRoles) ||
    frozen.kind !== task.kind ||
    frozen.taskMessageId !== task.taskMessageId ||
    !frozen.taskDocument ||
    !isDeepStrictEqual(frozen.taskDocument, task.taskDocument) ||
    (!forPlanRevision &&
      (!samePlanContent(auth.planReference, task.planReference) ||
        !isDeepStrictEqual(auth.reviewScopeRef, task.reviewScopeRef))) ||
    (!workflowInputWasNotSent(repo, run) &&
      !(
        run.dispatchPhase === 'ended' &&
        run.nativeEffectsState === 'settled' &&
        (['failed', 'interrupted'].includes(run.nativeOutcome ?? '') ||
          (forPlanRevision && run.nativeOutcome === 'completed' && turn.applied))
      ))
  )
    throw new RunOperationConflictError(
      'The original write authorization or settled execution could not be verified. Start a new explicitly authorized action.',
    )
  // A stage alone is not a legacy grant: retain its original task, complete input Batch,
  // published Plan/review scope and host-frozen authorization together.
  let inputOwnerRunId = run.id
  const operationId = repo.database
    .select({ id: agentRuns.reexecutionOperationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, run.id))
    .get()?.id
  if (run.reexecutedFromRunId || operationId) {
    const operation = repo.database
      .select()
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.replacementRunId, run.id))
      .get()
    const parent =
      operation &&
      repo.database
        .select({
          id: agentRuns.id,
          reexecutedFromRunId: agentRuns.reexecutedFromRunId,
          reexecutionOperationId: agentRuns.reexecutionOperationId,
          userMessageId: agentRuns.userMessageId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, operation.originalRunId))
        .get()
    const capture = parent && repo.executionInput(parent.id)
    if (
      !operation ||
      operation.id !== operationId ||
      operation.originalRunId !== run.reexecutedFromRunId ||
      !parent ||
      parent.reexecutedFromRunId ||
      parent.reexecutionOperationId ||
      parent.userMessageId !== run.userMessageId ||
      !capture?.proof ||
      capture.proof.runId !== parent.id ||
      capture.proof.inputSha256 !== capture.input.inputSha256
    )
      throw new RunOperationConflictError('The original replacement input lineage is unavailable.')
    const original = unfinishedWriteSource(repo, task, parent.id, forPlanRevision)
    const comparable = {
      ...auth,
      runId: original.auth.runId,
      taskRevision: original.auth.taskRevision,
    }
    for (const field of ['sourceManifestRef', 'relayWorkRef'] as const) {
      const prior = original.auth[field],
        current = auth[field]
      if (isDeepStrictEqual(prior, current)) continue
      if (
        !prior ||
        !current ||
        prior.sha256 !== current.sha256 ||
        prior.bytes !== current.bytes ||
        prior.chars !== current.chars ||
        collaborationDocumentRow(repo, task.sessionId, prior).sourceRunId !== parent.id ||
        collaborationDocumentRow(repo, task.sessionId, current).sourceRunId !== run.id
      )
        throw new RunOperationConflictError('The replacement host instruction changed.')
      comparable[field] = prior
    }
    if (!isDeepStrictEqual(comparable, original.auth))
      throw new RunOperationConflictError('The replacement write authorization changed.')
    inputOwnerRunId = original.run.id
  }
  const batch =
    auth.inputBatchRef &&
    repo.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, auth.inputBatchRef.id))
      .get()
  if (
    !batch ||
    batch.runId !== inputOwnerRunId ||
    batch.sessionId !== task.sessionId ||
    batch.messageId !== run.userMessageId ||
    batch.actor !== auth.actor ||
    batch.memberCount !== auth.inputBatchRef?.memberCount ||
    batch.commentsRevision !== auth.inputBatchRef?.revision ||
    !batch.bodyDocumentJson ||
    batch.bodyState === 'withdrawn'
  )
    throw new RunOperationConflictError('The original complete write input is unavailable.')
  collaborationDocumentRow(repo, task.sessionId, frozen.taskDocument)
  collaborationDocumentRow(
    repo,
    task.sessionId,
    collaborationDocumentSchema.parse(JSON.parse(batch.bodyDocumentJson)),
  )
  if (auth.planReference)
    collaborationDocumentRow(repo, task.sessionId, auth.planReference.document)
  if (task.planReference)
    collaborationDocumentRow(repo, task.sessionId, task.planReference.document)
  if (auth.reviewScopeRef) collaborationDocumentRow(repo, task.sessionId, auth.reviewScopeRef)
  if (
    !auth.userAuthority &&
    !(
      (auth.stage === 'implement' && frozen.kind === 'build') ||
      (auth.stage === 'implement' &&
        frozen.review?.stage === 'plan_review' &&
        frozen.review.actor === collaborationActor(frozen, 'plan_review') &&
        frozen.review.verdict === 'accepted' &&
        samePlanContent(frozen.review.planReference, auth.planReference)) ||
      (auth.stage === 'repair' &&
        frozen.review?.stage === 'code_review' &&
        frozen.review.actor === collaborationActor(frozen, 'code_review') &&
        frozen.review.verdict === 'changes_requested' &&
        isDeepStrictEqual(frozen.review.scopeRef, auth.reviewScopeRef))
    )
  )
    throw new RunOperationConflictError(
      'The legacy write has no complete original authorization basis.',
    )
  return { run, turn, auth, frozen }
}

export function originalWriteAuthority(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  preserveLegacy = false,
): typeof collaborationActionReceipts.$inferSelect {
  if (task.planRevision)
    throw new RunOperationConflictError(
      'The changed requirements require a newly accepted and authorized Plan.',
    )
  const pending = task.pendingWork
  if (!pending) throw new RunOperationConflictError('There is no original unfinished write.')
  const source = unfinishedWriteSource(repo, task, pending.runId)
  if (
    pending.stage !== source.auth.stage ||
    pending.inputSequence !== source.auth.inputSequence ||
    task.inputSequence < source.auth.inputSequence ||
    collaborationInputGate(task) ||
    receivedCollaborationInput(repo, task.sessionId)
  )
    throw new RunOperationConflictError(
      'The original unfinished write or its input is no longer current.',
    )
  if (task.inputSequence !== source.auth.inputSequence) {
    const processed = collaborationInputProcessing(task).settled
    const reply = processed ? repo.findRun(processed.runId) : undefined
    const observation = processed ? repo.workflowInputResult(processed.runId) : undefined
    const settled =
      processed &&
      repo.database
        .select({ sequence: agentEventJournal.sequence })
        .from(agentEventJournal)
        .where(
          and(
            eq(agentEventJournal.runId, processed.runId),
            eq(agentEventJournal.eventType, 'workflow.input_settled'),
          ),
        )
        .limit(1)
        .get()
    if (
      task.handledInputSequence !== task.inputSequence ||
      processed?.inputSequence !== task.inputSequence ||
      !reply ||
      reply.forkSourceRunId ||
      reply.controlDisposition === 'abandoned' ||
      reply.sessionId !== task.sessionId ||
      reply.collaboration?.taskId !== task.id ||
      reply.collaboration.stage !== 'reply' ||
      reply.dispatchPhase !== 'ended' ||
      reply.nativeOutcome !== 'completed' ||
      reply.nativeEffectsState !== 'settled' ||
      !repo.hasCompleteResponse(reply.id) ||
      !settled ||
      (observation?.outcome !== 'processed' && !repo.workflowPlanSettled(reply.id))
    )
      throw new RunOperationConflictError(
        'Later input has not been completely processed within the original write scope.',
      )
  }
  return originalWriteReceipt(repo, task, source, preserveLegacy)
}

export function originalWriteReceipt(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  source: ReturnType<typeof unfinishedWriteSource>,
  preserveLegacy: boolean,
  forPlanRevision = false,
): typeof collaborationActionReceipts.$inferSelect {
  const rootId = source.auth.userAuthority?.rootReceiptId
  let receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(
      rootId
        ? eq(collaborationActionReceipts.id, rootId)
        : eq(collaborationActionReceipts.boundRunId, source.run.id),
    )
    .get()
  const legacyBasis = (value: typeof source) => ({
    version: 'legacy-native-workflow-write-v1',
    sourceRunId: value.run.id,
    authorizationSha256: createHash('sha256').update(value.turn.authorizationJson).digest('hex'),
    taskId: task.id,
    actor: value.auth.actor,
    stage: value.auth.stage,
    inputSequence: value.auth.inputSequence,
    taskMessageId: value.frozen.taskMessageId,
    taskDocument: value.frozen.taskDocument,
    planReference: value.auth.planReference ?? null,
    reviewScopeRef: value.auth.reviewScopeRef ?? null,
  })
  if (!receipt && !source.auth.userAuthority && preserveLegacy) {
    const id = randomUUID(),
      now = new Date().toISOString(),
      basis = legacyBasis(source)
    receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: task.sessionId,
        taskId: task.id,
        // This reserved native Run identity is a derivation key, not fabricated user consent.
        clientNonce: source.run.id,
        requestDigest: scheduling.fingerprint(basis),
        action: 'legacy_write',
        actor: collaborationActor(task, 'implement'),
        handoffId: scheduling.fingerprint(basis),
        rootReceiptId: id,
        basisJson: authorityJson(repo, basis),
        state: 'settled',
        boundRunId: source.run.id,
        active: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: source.run.id,
      eventType: 'collaboration.legacy_write_authority_preserved',
      payload: JSON.stringify({
        receiptId: id,
        sourceRunId: source.run.id,
        authorizationSha256: basis.authorizationSha256,
      }),
      createdAt: now,
    })
  }
  if (
    !receipt ||
    receipt.taskId !== task.id ||
    receipt.sessionId !== task.sessionId ||
    receipt.actor !== source.auth.actor ||
    !receipt.boundRunId ||
    receipt.rootReceiptId !== receipt.id ||
    !['build', 'execute', 'repair', 'legacy_write'].includes(receipt.action) ||
    !['bound', 'settled', 'unknown', 'not_sent'].includes(receipt.state)
  )
    throw new RunOperationConflictError('The original concrete write authorization is unavailable.')
  const original = unfinishedWriteSource(repo, task, receipt.boundRunId, forPlanRevision)
  if (original.auth.stage !== source.auth.stage || original.auth.actor !== source.auth.actor)
    throw new RunOperationConflictError('The original write stage changed.')
  if (receipt.action === 'legacy_write') {
    if (
      original.auth.userAuthority ||
      receipt.basisJson !== authorityJson(repo, legacyBasis(original))
    )
      throw new RunOperationConflictError('The frozen legacy write authorization changed.')
  } else if (
    original.auth.userAuthority?.receiptId !== receipt.id ||
    original.auth.userAuthority.rootReceiptId !== receipt.id ||
    original.auth.userAuthority.purpose !== 'action'
  ) {
    throw new RunOperationConflictError('The write continuation has no original action root.')
  }
  return receipt
}

/** Capture the exact user action synchronously, before any preparation or advice await. */
export function prepareCollaborationAction(
  repo: ConversationRepositoryHost,
  input: CollaborationActionInput,
  limits: CollaborationLimits,
) {
  return repo.database.transaction(() => {
    const duplicate = collaborationActionReceipt(repo, input)
    const task = collaboration(repo, input.sessionId)
    if (duplicate) {
      if (duplicate.boundRunId)
        return { receipt: duplicate, task, next: undefined, handoff: undefined }
      if (duplicate.state !== 'available')
        throw new RunOperationConflictError(
          'This action was already settled or cancelled. Refresh its receipt.',
        )
    }
    if (!task || task.id !== input.taskId || (!duplicate && task.revision !== input.revision))
      throw new RunOperationConflictError('This collaboration action is no longer current.')
    if (
      receivedCollaborationInput(repo, input.sessionId) ||
      repo.nativeRecoveryBlocksInput(input.sessionId)
    )
      throw new RunOperationConflictError(
        'Resolve the current input or native recovery before starting this action.',
      )
    repo.assertRelayDecisionResolved(task.sessionId)
    const next = advanceCollaboration(task, input.action, limits)
    const handoff = repo.workflowHandoff(task, next.actor)
    const basisJson = authorityJson(repo, actionReceiptBasis(repo, task, next, handoff))
    if (duplicate) {
      if (duplicate.basisJson !== basisJson)
        throw new RunOperationConflictError('The authorized action changed before dispatch.')
      return { receipt: duplicate, task, next, handoff }
    }
    if (
      repo.database
        .select({ id: collaborationActionReceipts.id })
        .from(collaborationActionReceipts)
        .where(
          and(
            eq(collaborationActionReceipts.handoffId, handoff.id),
            eq(collaborationActionReceipts.active, true),
          ),
        )
        .get()
    )
      throw new RunOperationConflictError(
        'Another action already owns this handoff. Read its original receipt.',
      )
    const continuingWrite =
      !task.openMode &&
      Boolean(task.pendingWork) &&
      (next.stage === 'implement' || next.stage === 'repair') &&
      input.action !== 'execute' &&
      input.action !== 'fix'
    const root = continuingWrite ? originalWriteAuthority(repo, task, true) : undefined
    const id = randomUUID(),
      now = new Date().toISOString()
    const receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: task.sessionId,
        taskId: task.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint(input),
        action: input.action,
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: root?.id ?? id,
        basisJson,
        state: 'available',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: task.runId,
      eventType: 'collaboration.action_authorized',
      payload: JSON.stringify({
        receiptId: id,
        action: input.action,
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: receipt.rootReceiptId,
      }),
      createdAt: now,
    })
    return { receipt, task, next, handoff }
  })
}

export function cancelPreparedCollaborationAction(
  repo: ConversationRepositoryHost,
  id: string,
): void {
  repo.database
    .update(collaborationActionReceipts)
    .set({ state: 'cancelled', active: false, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(collaborationActionReceipts.id, id),
        eq(collaborationActionReceipts.state, 'available'),
      ),
    )
    .run()
}

export function admitCollaborationAction(
  repo: ConversationRepositoryHost,
  input: BeginRunInput,
  handoff: SchedulingHandoff | undefined,
  runId: string,
  current: CollaborationTask | undefined,
  candidateId?: WorkflowRelayCandidateId,
  approvedRelayScope?: RelayWorkflowSnapshot,
):
  | {
      userAuthority: NonNullable<CollaborationTurnAuthorization['userAuthority']>
      relayWorkRef?: CollaborationDocument
    }
  | undefined {
  const next = input.collaboration
  if (!next) return undefined
  if (
    input.expectedCollaborationRevision === undefined &&
    next.kind === 'build' &&
    next.stage === 'implement' &&
    next.taskMessageId === input.clientMessageId
  ) {
    const id = randomUUID(),
      now = new Date().toISOString()
    repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: next.sessionId,
        taskId: next.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint({
          action: 'build',
          taskId: next.id,
          clientNonce: input.clientMessageId,
          contentSha256: createHash('sha256').update(input.content).digest('hex'),
        }),
        action: 'build',
        actor: collaborationActor(next, 'implement'),
        handoffId: scheduling.fingerprint({
          taskId: next.id,
          initialBuild: input.clientMessageId,
        }),
        rootReceiptId: id,
        basisJson: authorityJson(repo, {
          taskId: next.id,
          inputSequence: next.inputSequence,
          stage: next.stage,
          actor: next.actor,
          ...(next.stageRoles ? { stageRoles: next.stageRoles } : {}),
          planReference: null,
          reviewScopeRef: null,
        }),
        state: 'bound',
        boundRunId: runId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { userAuthority: { receiptId: id, rootReceiptId: id, purpose: 'action' } }
  }
  let receipt = input.collaborationActionReceiptId
    ? repo.database
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, input.collaborationActionReceiptId))
        .get()
    : undefined
  if (
    !receipt &&
    !input.collaborationActionReceiptId &&
    current &&
    handoff &&
    current.pendingWork?.stage === next.stage &&
    (next.stage === 'implement' || next.stage === 'repair') &&
    current.automation === 'active'
  ) {
    // Automatic return from a required Plan review uses the existing write authority.
    // This is an idempotent derivation, not a new user action or an extra Repair.
    const root = originalWriteAuthority(repo, current, true)
    const id = randomUUID(),
      now = new Date().toISOString()
    const basisJson = authorityJson(repo, actionReceiptBasis(repo, current, next, handoff))
    receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: current.sessionId,
        taskId: current.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint({
          version: 'unfinished-write-continuation-v1',
          rootReceiptId: root.id,
          clientOperationId: input.clientMessageId,
          basisJson,
        }),
        action: 'continue',
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: root.id,
        basisJson,
        state: 'available',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: current.sessionId,
      runId,
      eventType: 'collaboration.write_continuation_prepared',
      payload: JSON.stringify({ receiptId: id, rootReceiptId: root.id }),
      createdAt: now,
    })
  }
  if (!receipt) {
    if (['implement', 'repair', 'respond'].includes(next.stage))
      throw new RunOperationConflictError(
        'This action requires its original concrete user receipt.',
      )
    return undefined
  }
  if (
    !current ||
    !handoff ||
    receipt.state !== 'available' ||
    !receipt.active ||
    receipt.boundRunId ||
    receipt.sessionId !== input.sessionId ||
    receipt.taskId !== next.id ||
    receipt.clientNonce !== input.clientMessageId ||
    receipt.actor !== next.actor ||
    receipt.handoffId !== handoff.id ||
    receipt.basisJson !== authorityJson(repo, actionReceiptBasis(repo, current, next, handoff))
  )
    throw new RunOperationConflictError('The concrete user authorization is no longer current.')
  if (
    current.planRevision &&
    ['implement', 'repair', 'respond'].includes(next.stage) &&
    (receipt.action !== 'execute' ||
      receipt.rootReceiptId !== receipt.id ||
      next.stage !== 'implement' ||
      next.pendingWork ||
      !collaborationPlanAccepted(current) ||
      !isDeepStrictEqual(next.planReference, current.planReference))
  )
    throw new RunOperationConflictError(
      'The revised Plan requires a new explicit Implement action.',
    )
  const continuation =
    !current.openMode &&
    Boolean(current.pendingWork) &&
    (next.stage === 'implement' || next.stage === 'repair') &&
    !['execute', 'fix'].includes(receipt.action)
  const relayAction =
    receipt.action === 'extend_plan_review' ? ('extend_plan_review' as const) : undefined
  const limits = repo.database
    .select()
    .from(sessionSettingsRevisions)
    .where(
      and(
        eq(sessionSettingsRevisions.sessionId, input.sessionId),
        eq(sessionSettingsRevisions.revision, input.settingsRevision),
      ),
    )
    .get()
  if (!limits)
    throw new RunOperationConflictError('The original collaboration limits are unavailable.')
  const expected =
    receipt.action === 'extend_plan_review'
      ? repo.relayWorkflowActionNext(current, 'extend_plan_review')
      : advanceCollaboration(current, collaborationActionSchema.parse(receipt.action), limits)
  if (!isDeepStrictEqual(next, expected))
    throw new RunOperationConflictError(
      'The authorized action, scope or original business counters changed before admission.',
    )
  let budgetReservationId: string | undefined
  let relayWorkRef: CollaborationDocument | undefined
  if (relayAction) {
    const decided = receipt.decisionId
      ? repo.database
          .select()
          .from(relayDecisions)
          .where(eq(relayDecisions.id, receipt.decisionId))
          .get()
      : undefined
    const accepted =
      decided?.formatVersion === 2 && decided.state === 'available' && decided.active
        ? relaySchedulingDecisionProofSchema.safeParse(JSON.parse(decided.proofJson))
        : undefined
    const confirmed =
      accepted?.success &&
      accepted.data.card.request.category === 'new_authorization' &&
      accepted.data.card.request.operation.kind === 'extend_plan_review' &&
      accepted.data.card.request.operation.taskId === current.id &&
      accepted.data.card.request.operation.afterRunId === current.runId &&
      accepted.data.card.request.operation.actor === next.actor &&
      next.stage === 'plan_review' &&
      accepted.data.card.request.operation.expectedDiscussionRounds === current.discussionRounds &&
      accepted.data.card.request.operation.maximum === limits.maxDiscussionRounds &&
      accepted.data.card.request.operation.inputSequence === current.inputSequence &&
      isDeepStrictEqual(
        accepted.data.card.request.operation.planReference,
        current.planReference,
      ) &&
      accepted.data.operationFingerprint ===
        scheduling.fingerprint(accepted.data.card.request.operation) &&
      accepted.data.configurationGeneration === repo.schedulingConfigurationGeneration() &&
      accepted.data.executionFingerprint ===
        repo.relayWorkflowActionExecutionFingerprint(current, handoff, relayAction) &&
      accepted.data.handoff.id === handoff.id &&
      accepted.data.sourceFingerprint === approvedRelayScope?.sourceFingerprint &&
      decided?.answerNonce === receipt.clientNonce &&
      decided.answerJson === authorityJson(repo, { kind: 'confirm' })
    if (!confirmed || !repo.planReviewExtensionAvailable(current))
      throw new RunOperationConflictError(
        'The plan-review extension was not selected by a current decision or is unavailable.',
      )
    if (confirmed && accepted?.success) {
      const card = accepted.data.card
      const scope = approvedRelayScope
      if (!scope)
        throw new RunOperationConflictError('The approved scheduling sources are unavailable.')
      const sources = card.sources.map((reference) => {
        const source = scope.sources.find((entry) => entry.id === reference.id)
        if (!source)
          throw new RunOperationConflictError('An approved scheduling citation is unavailable.')
        return { label: reference.label, document: source.document }
      })
      relayWorkRef = saveCollaborationDocument(
        repo,
        runId,
        authorityJson(repo, {
          version: 'relay-approved-work-v1',
          decisionId: card.decisionId,
          title: card.title,
          responsibility: card.reason,
          consequence: card.consequence,
          operation:
            card.request.category === 'new_authorization' ? card.request.operation : undefined,
          sources,
        }),
      )
    }
    const reserved = scheduling.reserveBudget(repo.database, {
      handoff,
      budget: 'extra_plan_turn',
      authorizationId: receipt.id,
    })
    if (reserved.status !== 'reserved')
      throw new RunOperationConflictError(
        'This plan-review extension allowance was already reserved.',
      )
    budgetReservationId = reserved.reservation.id
  }
  if (continuation && originalWriteAuthority(repo, current).id !== receipt.rootReceiptId)
    throw new RunOperationConflictError('The continued write has a different authorization root.')
  repo.database
    .update(collaborationActionReceipts)
    .set({
      state: 'bound',
      boundRunId: runId,
      budgetReservationId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collaborationActionReceipts.id, receipt.id))
    .run()
  if (receipt.decisionId)
    repo.database
      .update(relayDecisions)
      .set({ state: 'bound', active: false, updatedAt: new Date().toISOString() })
      .where(eq(relayDecisions.id, receipt.decisionId))
      .run()
  if (receipt.decisionId) scheduling.recordRelayDecisionActivity(repo.database, receipt.decisionId)
  return {
    userAuthority: {
      receiptId: receipt.id,
      rootReceiptId: receipt.rootReceiptId,
      purpose: continuation ? 'write_continuation' : 'action',
    },
    ...(relayWorkRef ? { relayWorkRef } : {}),
  }
}

export function settleCollaborationAction(repo: ConversationRepositoryHost, run: AgentRun): void {
  const receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(eq(collaborationActionReceipts.boundRunId, run.id))
    .get()
  if (!receipt || ['settled', 'not_sent'].includes(receipt.state)) return
  const reservation = receipt.budgetReservationId
    ? repo.database
        .select()
        .from(schedulingBudgetReservations)
        .where(eq(schedulingBudgetReservations.id, receipt.budgetReservationId))
        .get()
    : undefined
  const notSent =
    workflowInputWasNotSent(repo, run) &&
    (!reservation || reservation.state === 'reserved' || reservation.state === 'not_sent')
  const state = notSent
    ? 'not_sent'
    : run.dispatchPhase === 'ended' && run.nativeEffectsState === 'settled'
      ? 'settled'
      : 'unknown'
  repo.database
    .update(collaborationActionReceipts)
    .set({
      state,
      active: false,
      ...(notSent && receipt.reviewState === 'pending'
        ? { reviewState: 'not_required' as const }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collaborationActionReceipts.id, receipt.id))
    .run()
  if (reservation && state !== 'unknown')
    scheduling.settleBudget(
      repo.database,
      reservation.id,
      state === 'not_sent' ? 'not_sent' : 'settled',
    )
  if (notSent && receipt.decisionId)
    scheduling.recordPactRepairBusinessActivity(repo.database, run.id)
}

function reconcileCollaborationActionReceipts(repo: ConversationRepositoryHost): void {
  let cursor: string | undefined
  for (;;) {
    const rows = repo.database
      .select({
        id: collaborationActionReceipts.id,
        runId: collaborationActionReceipts.boundRunId,
      })
      .from(collaborationActionReceipts)
      .where(
        and(
          sql`${collaborationActionReceipts.boundRunId} IS NOT NULL AND ${collaborationActionReceipts.state} IN ('bound', 'unknown')`,
          cursor ? gt(collaborationActionReceipts.id, cursor) : undefined,
        ),
      )
      .orderBy(collaborationActionReceipts.id)
      .limit(25)
      .all()
    if (!rows.length) return
    repo.database.transaction(() => {
      for (const row of rows) {
        const run = row.runId ? repo.findRun(row.runId) : undefined
        if (
          run &&
          !run.forkSourceRunId &&
          (run.dispatchPhase === 'ended' ||
            ['completed', 'failed', 'interrupted'].includes(run.status))
        )
          settleCollaborationAction(repo, run)
      }
    })
    cursor = rows.at(-1)!.id
  }
}
