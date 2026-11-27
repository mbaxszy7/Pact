import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  agentDisplayName,
  COLLABORATION_PROTOCOL,
  collaborationActor,
  collaborationAskActor,
  collaborationAskAvailable,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationWorkflowInputBasis,
  isAgentInPair,
  MAX_COMMENTS_PER_MESSAGE,
  originSideChatSchema,
  otherAgent,
  pactCommandRouteAllowed,
  pactEntryPrimary,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  type AnchoredComment,
  type CollaborationAskRef,
  type CollaborationReplyIntentBasis,
  type CollaborationTask,
  type ConversationPatch,
  type OriginSideChat,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import {
  agentRuns,
  anchoredComments,
  collaborationActionReceipts,
  collaborationInputs,
  collaborationTasks,
  conversationBodyInputs,
  conversationImageAssets,
  conversationInputBatches,
  conversationQueueOperations,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import {
  finalizeMainSyncBackReceipt,
  recoverIncompleteSyncMainOperations,
} from '../side-chat-persistence.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { reconcileCollaborationActionReceipts } from './collaboration-action-queries.js'
import {
  receivedCollaborationInput,
  receivedInputReceipt,
  collaboration,
  collaborationDocumentRow,
  workflowInputWasNotSent,
} from './collaboration-document-queries.js'
import {
  withdrawInputBatch,
  saveCollaboration,
  finishCollaboration,
} from './collaboration-stage-queries.js'
import { storedReceivedMetadata } from './helpers.js'
import { activeRunStatuses, BODY_INTERNAL_READ_BYTES, RunOperationConflictError } from './types.js'

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
