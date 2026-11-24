import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  collaborationDocumentSchema,
  collaborationInputProcessing,
  collaborationPlanAccepted,
  collaborationPlanMode,
  CONVERSATION_MARKDOWN_BYTES,
  DECISION_INPUT_BYTES,
  FROZEN_EXECUTION_INPUT_ITEMS,
  handoffGuidanceSchema,
  isCollaborationOpenMode,
  isConversationBackgroundReport,
  MAX_COMMENTS_PER_MESSAGE,
  PLAN_REVISION_GUIDANCE_BYTES,
  storedCommentAnchor,
  type AnchoredComment,
  type CollaborationDocument,
  type CollaborationInputBatchReference,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type ConversationPage,
  type HandoffGuidance,
  type RuntimeAgentId,
  type SchedulingHandoff,
  type UserInformationDeclaration,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  anchoredComments,
  collaborationInputs,
  collaborationTasks,
  conversationBodyInputs,
  conversationBodyParts,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationMessages,
  conversationQueueOperations,
  conversationRunSourceRefs,
  nativeAgentContexts,
  nativeForkIntents,
  nativeRebuildOperations,
  runReexecutionOperations,
  schedulingRecoveryFaults,
  sessionForkOperations,
  sessions,
  workflowTurns,
  workspaceChangeSets,
  workspaceFileChanges,
} from '../schema/index.js'
import { storedDocuments, storedReceivedMetadata, toComment, validBodyText } from './helpers.js'
import {
  BODY_INTERNAL_READ_BYTES,
  BODY_PART_UNITS,
  COLLABORATION_INDEX_BYTES,
  COLLABORATION_INDEX_ITEMS,
  HANDOFF_PAGE_BYTES,
  HANDOFF_PAGE_ITEMS,
  HANDOFF_READ_DEADLINE_MS,
  HANDOFF_SAFETY_BYTES,
  HANDOFF_SOURCE_IDS_BYTES,
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
  OversizedConversationEntityError,
  RunOperationConflictError,
  visibleWorkspaceArtifact,
  type FrozenInputBatchPage,
  type HandoffBundle,
  type HandoffRow,
  type HandoffSourceRef,
  type InputBatchReference,
  type RunSourcesPage,
  type WorkflowInputsPage,
} from './types.js'

export function handoffRange(
  repo: ConversationRepositoryHost,
  sessionId: string,
  targetAgentId: RuntimeAgentId,
): { afterSequence: number; throughSequence: number } {
  const context = repo.database
    .select({
      nativeSessionId: nativeAgentContexts.nativeSessionId,
      bindingGeneration: nativeAgentContexts.bindingGeneration,
      sequence: nativeAgentContexts.rebuiltThroughSequence,
      forkSequence: nativeAgentContexts.forkThroughSequence,
    })
    .from(nativeAgentContexts)
    .where(
      and(
        eq(nativeAgentContexts.sessionId, sessionId),
        eq(nativeAgentContexts.agentId, targetAgentId),
      ),
    )
    .get()
  const lastAccepted = context
    ? repo.database
        .select({ sequence: conversationMessages.sequence })
        .from(agentRuns)
        .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
        .where(
          and(
            eq(agentRuns.sessionId, sessionId),
            eq(agentRuns.agentId, targetAgentId),
            isNull(agentRuns.forkSourceRunId),
            eq(agentRuns.nativeSessionId, context.nativeSessionId),
            eq(agentRuns.bindingGeneration, context.bindingGeneration),
            isNotNull(agentRuns.nativeTurnId),
            or(
              sql`${agentRuns.failureKind} IS NULL`,
              sql`${agentRuns.failureKind} NOT IN ('context_limit', 'unknown_delivery')`,
            ),
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(conversationMessages.sequence))
        .limit(1)
        .get()
    : undefined
  const latest = repo.database
    .select({ sequence: max(conversationMessages.sequence) })
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, sessionId))
    .get()
  return {
    afterSequence: Math.max(
      lastAccepted?.sequence ?? -1,
      context?.sequence ?? -1,
      context?.forkSequence ?? -1,
    ),
    throughSequence: latest?.sequence ?? -1,
  }
}

function askOnlySource(
  repo: ConversationRepositoryHost,
  message: {
    runId: SQLWrapper
    sourceMessageId: SQLWrapper
    sessionId: SQLWrapper
    role: SQLWrapper
  },
) {
  return sql`EXISTS (SELECT 1 FROM workflow_turns question
      WHERE question.run_id = coalesce(${message.runId},
        CASE WHEN ${message.role} = 'assistant' THEN (
          SELECT origin.run_id FROM conversation_messages origin
          WHERE origin.id = ${message.sourceMessageId}
            AND origin.session_id = ${message.sessionId} AND origin.role = 'user'
        ) END)
      AND (json_extract(question.authorization_json, '$.replyIntentBasis.kind') = 'ask_only'
        OR json_extract(question.authorization_json, '$.historicalInputKind') = 'ask_only'))`
}

function handoffRows(
  repo: ConversationRepositoryHost,
  sessionId: string,
  targetAgentId: RuntimeAgentId,
  afterSequence: number,
  throughSequence: number,
  excludeMessageId?: string,
  workflow = false,
): HandoffRow[] {
  const targetContext = repo.database
    .select({
      nativeSessionId: nativeAgentContexts.nativeSessionId,
      bindingGeneration: nativeAgentContexts.bindingGeneration,
      rebuiltThroughSequence: nativeAgentContexts.rebuiltThroughSequence,
      forkThroughSequence: nativeAgentContexts.forkThroughSequence,
    })
    .from(nativeAgentContexts)
    .where(
      and(
        eq(nativeAgentContexts.sessionId, sessionId),
        eq(nativeAgentContexts.agentId, targetAgentId),
      ),
    )
    .get()
  const forkOperation = repo.database
    .select({
      id: sessionForkOperations.id,
      sourceSequence: sessionForkOperations.sourceSequence,
    })
    .from(sessionForkOperations)
    .where(eq(sessionForkOperations.sessionId, sessionId))
    .get()
  const targetForkIntent = forkOperation
    ? repo.database
        .select({
          state: nativeForkIntents.state,
          nativeSessionId: nativeForkIntents.nativeSessionId,
        })
        .from(nativeForkIntents)
        .where(
          and(
            eq(nativeForkIntents.operationId, forkOperation.id),
            eq(nativeForkIntents.agentId, targetAgentId),
          ),
        )
        .get()
    : undefined
  const targetForkedNativeSessionId =
    targetForkIntent?.state === 'ready' &&
    targetForkIntent.nativeSessionId &&
    targetContext?.nativeSessionId === targetForkIntent.nativeSessionId
      ? targetForkIntent.nativeSessionId
      : undefined
  const rebuiltThrough = targetContext?.rebuiltThroughSequence ?? -1
  const forkThrough = targetForkedNativeSessionId ? (targetContext?.forkThroughSequence ?? -1) : -1
  const inheritedSameAgentRunUncovered = (runTable: SQLWrapper) =>
    targetForkedNativeSessionId && targetContext
      ? sql`(${runTable}.fork_source_run_id IS NOT NULL
            AND NOT (${runTable}.native_session_id = ${targetForkedNativeSessionId}
              AND ${runTable}.binding_generation = ${targetContext.bindingGeneration})
            AND ${conversationMessages.sequence} > ${rebuiltThrough})`
      : forkOperation
        ? sql`(${runTable}.fork_source_run_id IS NOT NULL AND ${conversationMessages.sequence} > ${rebuiltThrough})`
        : sql`0`
  const rows = repo.database
    .select({
      id: conversationMessages.id,
      runId: conversationMessages.runId,
      sourceMessageId: conversationMessages.sourceMessageId,
      sequence: conversationMessages.sequence,
      role: conversationMessages.role,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      contentRevision: conversationMessages.contentRevision,
      handledBy: sql<RuntimeAgentId>`coalesce(${agentRuns.agentId}, ${conversationMessages.agentId})`,
    })
    .from(conversationMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
    .where(
      and(
        eq(conversationMessages.sessionId, sessionId),
        eq(conversationMessages.isVisible, true),
        ...(excludeMessageId ? [ne(conversationMessages.id, excludeMessageId)] : []),
        ...(workflow ? [sql`NOT ${askOnlySource(repo, conversationMessages)}`] : []),
        gt(conversationMessages.sequence, afterSequence),
        lte(conversationMessages.sequence, throughSequence),
        or(
          and(
            eq(conversationMessages.role, 'user'),
            isNotNull(agentRuns.id),
            sql`EXISTS (
                SELECT 1 FROM agent_runs AS accepted
                WHERE (accepted.user_message_id = ${conversationMessages.id}
                  OR accepted.id = ${conversationMessages.runId})
                  AND (accepted.agent_id <> ${targetAgentId}
                    OR ${inheritedSameAgentRunUncovered(sql`accepted`)})
                  AND accepted.native_turn_id IS NOT NULL
                  AND (accepted.failure_kind IS NULL OR accepted.failure_kind NOT IN ('context_limit', 'unknown_delivery'))
              )`,
          ),
          and(
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            or(ne(agentRuns.agentId, targetAgentId), inheritedSameAgentRunUncovered(agentRuns)),
            isNotNull(agentRuns.nativeTurnId),
            or(
              sql`${agentRuns.failureKind} IS NULL`,
              sql`${agentRuns.failureKind} NOT IN ('context_limit', 'unknown_delivery')`,
            ),
          ),
          and(
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            isNull(conversationMessages.runId),
            isNotNull(conversationMessages.sourceMessageId),
            or(
              ne(conversationMessages.agentId, targetAgentId),
              forkOperation
                ? and(
                    lte(conversationMessages.sequence, forkOperation.sourceSequence),
                    gt(conversationMessages.sequence, Math.max(rebuiltThrough, forkThrough)),
                  )
                : sql`0`,
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(conversationMessages.sequence))
    .limit(HANDOFF_PAGE_ITEMS + 1)
    .all()
  // A required visible report with a missing immutable carrier is unavailable,
  // not an optional context row that may silently disappear from the page.
  for (const row of rows)
    if (isConversationBackgroundReport(row)) backgroundReportDocument(repo, sessionId, row.id)
  return rows
}

export function readHandoffPage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  targetAgentId: RuntimeAgentId,
  afterSequence: number,
  throughSequence: number,
): { messages: HandoffBundle[]; nextSequence?: number } {
  const rows = handoffRows(repo, sessionId, targetAgentId, afterSequence, throughSequence)
  const admitted = admitHandoffRows(repo, rows.slice(0, HANDOFF_PAGE_ITEMS))
  const hydrated = hydrateHandoffRows(repo, admitted)
  const messages: HandoffBundle[] = []
  let bytes = 0
  for (const message of hydrated) {
    const nextBytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    if (nextBytes > HANDOFF_PAGE_BYTES)
      throw new HandoffTooLargeError('A required Message exceeds Pact’s safe page size.')
    if (bytes + nextBytes > HANDOFF_PAGE_BYTES) break
    messages.push(message)
    bytes += nextBytes
  }
  return {
    messages,
    ...(messages.length > 0 &&
    (messages.length < hydrated.length ||
      admitted.length < Math.min(rows.length, HANDOFF_PAGE_ITEMS) ||
      rows.length > HANDOFF_PAGE_ITEMS)
      ? { nextSequence: messages.at(-1)!.sequence }
      : {}),
  }
}

/** Internal complete sources: metadata pages stay small; oversized text is read in byte parts.
 * The caller consumes only one fixed <=8 MiB context, never a public oversized page. */
export async function* readHandoffSources(
  repo: ConversationRepositoryHost,
  sessionId: string,
  targetAgentId: RuntimeAgentId,
  afterSequence: number,
  throughSequence: number,
  signal: AbortSignal,
  excludeMessageId?: string,
  workflow = false,
): AsyncIterable<HandoffBundle> {
  const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
  let cursor = afterSequence,
    totalBytes = 0
  while (cursor < throughSequence) {
    if (signal.aborted || Date.now() >= deadline)
      throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
    const rows = handoffRows(
      repo,
      sessionId,
      targetAgentId,
      cursor,
      throughSequence,
      excludeMessageId,
      workflow,
    )
    if (!rows.length) return
    for (const row of rows.slice(0, HANDOFF_PAGE_ITEMS)) {
      if (!workflowSourceHandoff(repo, row))
        admitHandoffRows(repo, [row], HANDOFF_SAFETY_BYTES - totalBytes)
      // oxlint-disable-next-line no-await-in-loop -- Each complete source is assembled from bounded SQLite byte parts.
      const message = await readHandoffSource(repo, row, signal, deadline)
      totalBytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
      if (totalBytes > HANDOFF_SAFETY_BYTES)
        throw new HandoffTooLargeError('The Agent context exceeds its working budget.')
      yield message
      cursor = row.sequence
    }
    if (rows.length <= HANDOFF_PAGE_ITEMS) return
    // oxlint-disable-next-line no-await-in-loop -- Preserve a control-plane turn between metadata pages, including all-small-body history.
    await yieldImmediate(undefined, { signal })
  }
}

async function readHandoffSource(
  repo: ConversationRepositoryHost,
  row: HandoffRow,
  signal: AbortSignal,
  deadline: number,
  withReports: boolean | 'native_workflow_v1' = true,
): Promise<HandoffBundle> {
  const quoted = withReports !== false ? workflowSourceHandoff(repo, row) : undefined
  if (quoted) return quoted
  if (row.contentBytes > BODY_INTERNAL_READ_BYTES)
    throw new HandoffTooLargeError('A required Message exceeds the context working budget.')
  if (row.contentBytes <= 128 * 1024) {
    if (signal.aborted || Date.now() >= deadline)
      throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
    return hydrateHandoffRows(repo, [row], undefined, Boolean(withReports))[0]!
  }
  const parts: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = 0
  while (offset < row.contentBytes) {
    if (signal.aborted || Date.now() >= deadline)
      throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
    const part = repo.database
      .select({
        revision: conversationMessages.contentRevision,
        bytes: sql<Buffer>`substr(CAST(${conversationMessages.content} AS BLOB), ${offset + 1}, 8192)`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, row.id),
          eq(conversationMessages.contentRevision, row.contentRevision),
        ),
      )
      .get()
    if (
      !part ||
      !part.bytes.length ||
      part.bytes.length > 8192 ||
      parts.length >= Math.ceil(BODY_INTERNAL_READ_BYTES / 8192)
    )
      throw new HandoffSourceUnavailableError('A required Message changed while reading.')
    offset += part.bytes.length
    if (offset > row.contentBytes)
      throw new HandoffSourceUnavailableError('A required Message changed while reading.')
    parts.push(decoder.decode(part.bytes, { stream: true }))
    // oxlint-disable-next-line no-await-in-loop -- Yield the Utility between finite physical body reads.
    await yieldImmediate(undefined, { signal })
  }
  const suffix = decoder.decode()
  const body = parts.join('') + suffix
  if (
    Buffer.byteLength(body, 'utf8') !== row.contentBytes ||
    signal.aborted ||
    Date.now() >= deadline
  )
    throw new HandoffSourceUnavailableError('A required Message could not be read completely.')
  return hydrateHandoffRows(repo, [row], new Map([[row.id, body]]), Boolean(withReports))[0]!
}

export async function readCollaborationSource(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageId: string,
  signal: AbortSignal,
): Promise<HandoffBundle> {
  const row = repo.database
    .select({
      id: conversationMessages.id,
      sequence: conversationMessages.sequence,
      role: conversationMessages.role,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      contentRevision: conversationMessages.contentRevision,
      handledBy: agentRuns.agentId,
    })
    .from(conversationMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
    .where(
      and(
        eq(conversationMessages.id, messageId),
        eq(conversationMessages.sessionId, sessionId),
        eq(conversationMessages.role, 'user'),
      ),
    )
    .get()
  if (!row) throw new HandoffSourceUnavailableError('The original task input is unavailable.')
  return readHandoffSource(repo, row, signal, Date.now() + HANDOFF_READ_DEADLINE_MS)
}

export function inputBatchForMessage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageId: string,
): CollaborationInputBatchReference | undefined {
  const row = repo.database
    .select()
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.sessionId, sessionId),
        eq(conversationInputBatches.messageId, messageId),
      ),
    )
    .get()
  return row
    ? { id: row.id, revision: row.commentsRevision, memberCount: row.memberCount }
    : undefined
}

export function inputBatchForRun(
  repo: ConversationRepositoryHost,
  runId: string,
): CollaborationInputBatchReference | undefined {
  const run = repo.findRun(runId)
  return run ? inputBatchForMessage(repo, run.sessionId, run.userMessageId) : undefined
}

function inputBatchReference(
  repo: ConversationRepositoryHost,
  row: typeof conversationInputBatches.$inferSelect,
): InputBatchReference {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    sequence: row.sequence,
    memberCount: row.memberCount,
    commentsRevision: row.commentsRevision,
    revision: row.commentsRevision,
  }
}

export function freezeInputBatch(
  repo: ConversationRepositoryHost,
  input: {
    sessionId: string
    clientMessageId: string
    commentsRevision: number
    actor: RuntimeAgentId
    taskId?: string
    runId?: string
    messageId?: string
    inputId?: string
    pendingReceiptId?: string
    preserveDraftComments?: boolean
    userInformation?: UserInformationDeclaration
    batchId?: string
    check?: () => void
  },
): InputBatchReference {
  const existing = repo.database
    .select()
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.sessionId, input.sessionId),
        eq(conversationInputBatches.clientMessageId, input.clientMessageId),
      ),
    )
    .get()
  if (existing) {
    if (
      input.pendingReceiptId &&
      !existing.taskId &&
      input.taskId &&
      !existing.runId &&
      !existing.messageId
    ) {
      const ownerTask = repo.database
        .select()
        .from(collaborationTasks)
        .where(eq(collaborationTasks.id, input.taskId))
        .get()
      if (!ownerTask)
        throw new RunOperationConflictError('The queued workflow task is unavailable.')
      existing.taskId = input.taskId
      existing.sequence = ownerTask.inputSequence + 1
      repo.database
        .update(conversationInputBatches)
        .set({ taskId: existing.taskId, sequence: existing.sequence })
        .where(eq(conversationInputBatches.id, existing.id))
        .run()
      repo.database
        .update(collaborationTasks)
        .set({ inputSequence: existing.sequence })
        .where(eq(collaborationTasks.id, input.taskId))
        .run()
      repo.database
        .update(collaborationInputs)
        .set({ taskId: input.taskId })
        .where(eq(collaborationInputs.id, input.pendingReceiptId))
        .run()
    }
    if (
      existing.actor !== input.actor ||
      existing.taskId !== (input.taskId ?? null) ||
      existing.id !== (input.batchId ?? input.clientMessageId)
    )
      throw new RunOperationConflictError(
        'This input Batch nonce belongs to another authorization.',
      )
    if (input.runId && !existing.runId)
      repo.database
        .update(conversationInputBatches)
        .set({ runId: input.runId, messageId: input.messageId ?? null })
        .where(eq(conversationInputBatches.id, existing.id))
        .run()
    if (input.userInformation)
      repo.freezeUserInformation(existing.id, input.userInformation, input.runId)
    else if (existing.userInformationDocumentJson)
      throw new RunOperationConflictError('The original user declaration must be retained.')
    return inputBatchReference(repo, existing)
  }
  const condition = and(
    eq(anchoredComments.sessionId, input.sessionId),
    input.preserveDraftComments
      ? sql`0`
      : input.pendingReceiptId
        ? eq(anchoredComments.pendingReceiptId, input.pendingReceiptId)
        : and(
            isNull(anchoredComments.sentWithMessageId),
            isNull(anchoredComments.pendingReceiptId),
          ),
  )
  const count = repo.database
    .select({ value: sql<number>`count(*)` })
    .from(anchoredComments)
    .where(condition)
    .get()!.value
  const task = input.taskId
    ? repo.database
        .select()
        .from(collaborationTasks)
        .where(eq(collaborationTasks.id, input.taskId))
        .get()
    : undefined
  if (input.taskId && !task)
    throw new RunOperationConflictError('The input Batch task is unavailable.')
  const sequence = task ? task.inputSequence + 1 : 0
  const batchId = input.batchId ?? input.clientMessageId
  const now = new Date().toISOString()
  repo.database
    .insert(conversationInputBatches)
    .values({
      id: batchId,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      sequence,
      clientMessageId: input.clientMessageId,
      actor: input.actor,
      commentsRevision: input.commentsRevision,
      runId: input.runId ?? null,
      messageId: input.messageId ?? null,
      inputId: input.inputId ?? null,
      memberCount: count,
      createdAt: now,
    })
    .run()
  let position = -1
  let ordinal = 0
  for (;;) {
    input.check?.()
    const rows = repo.database
      .select()
      .from(anchoredComments)
      .where(and(condition, gt(anchoredComments.position, position)))
      .orderBy(asc(anchoredComments.position))
      .limit(COLLABORATION_INDEX_ITEMS)
      .all()
    if (!rows.length) break
    for (const row of rows) {
      input.check?.()
      storedCommentAnchor(JSON.parse(row.anchorJson))
      repo.database
        .insert(conversationInputBatchMembers)
        .values({
          batchId,
          memberId: row.id,
          ordinal: ordinal++,
          commentId: row.id,
          commentRevision: row.draftRevision,
          anchorJson: row.anchorJson,
          bodySha256: createHash('sha256').update(row.body).digest('hex'),
          updatedAt: now,
        })
        .run()
    }
    position = rows.at(-1)!.position
  }
  if (ordinal !== count)
    throw new RunOperationConflictError('Comment drafts changed while freezing the Batch.')
  if (task)
    repo.database
      .update(collaborationTasks)
      .set({ inputSequence: sequence })
      .where(eq(collaborationTasks.id, task.id))
      .run()
  if (input.userInformation) repo.freezeUserInformation(batchId, input.userInformation, input.runId)
  return {
    id: batchId,
    sessionId: input.sessionId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    sequence,
    memberCount: count,
    commentsRevision: input.commentsRevision,
    revision: input.commentsRevision,
  }
}

export function freezeCollaborationAuthorization(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  runId: string,
  batch: InputBatchReference,
  sourceManifestRef?: CollaborationDocument,
  userAuthority?: CollaborationTurnAuthorization['userAuthority'],
  relayWorkRef?: CollaborationDocument,
  previousTask?: CollaborationTask,
): void {
  const row = repo.database
    .select()
    .from(collaborationTasks)
    .where(eq(collaborationTasks.id, task.id))
    .get()
  if (!row) throw new RunOperationConflictError('The workflow task is unavailable.')
  task = { ...task, runId, inputSequence: row.inputSequence }
  if (task.stage === 'plan' && task.planRevision && !task.planRevision.startedRunId)
    task.planRevision = { ...task.planRevision, startedRunId: runId }
  const run = repo.findRun(runId)!
  if (task.taskMessageId === run.userMessageId && !task.taskDocument) {
    const source = repo.database
      .select({ body: conversationInputBatches.bodyDocumentJson })
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, batch.id))
      .get()
    if (source?.body) task.taskDocument = collaborationDocumentSchema.parse(JSON.parse(source.body))
  }
  if (task.stage === 'code_review') {
    const scope = {
      task: task.taskDocument,
      implementationRunId: task.codeRunId ?? null,
      changes: task.codeRunId ? runChangeEvidence(repo, task.sessionId, task.codeRunId) : null,
      requestMessageId: task.taskMessageId,
    }
    task.reviewScopeRef = repo.saveCollaborationDocument(runId, JSON.stringify(scope))
  }
  const received = ['reply', 'collaborate'].includes(task.stage)
    ? repo.receivedCollaborationInput(task.sessionId)
    : undefined
  const intent =
    received?.id === run.userMessageId
      ? storedReceivedMetadata(received.metadataJson).replyIntentBasis
      : undefined
  const askOnly = intent?.kind === 'ask_only'
  const checkpointed =
    intent?.kind === 'ask_only' ||
    intent?.kind === 'explanation_only' ||
    Boolean(intent?.askBinding)
  const binding = checkpointed ? repo.nativeContext(task.sessionId, task.actor) : undefined
  const checkpointProven = Boolean(
    intent?.askBinding &&
    binding?.nativeSessionId === intent.askBinding.nativeSessionId &&
    binding.bindingGeneration === intent.askBinding.generation &&
    collaborationInputProcessing(task).pending?.inputId === intent.inputId &&
    (!askOnly ||
      (batch.memberCount === 0 &&
        (intent.askCheckpoint
          ? repo.database
              .select({ taskId: conversationInputBatches.taskId })
              .from(conversationInputBatches)
              .where(eq(conversationInputBatches.id, batch.id))
              .get()?.taskId === null
          : collaborationPlanAccepted({
              ...task,
              inputProcessing: {
                ...collaborationInputProcessing(task),
                pending: undefined,
              },
            })))),
  )
  const replyIntentBasis =
    intent &&
    task.revision === intent.taskRevision + 2 &&
    task.inputSequence === intent.priorInputSequence + (askOnly ? 0 : 1) &&
    received?.actor === task.actor &&
    received.digest === intent.inputDigest &&
    isDeepStrictEqual(task.review, intent.review) &&
    isDeepStrictEqual(task.stageRoles, intent.stageRoles) &&
    isDeepStrictEqual(task.planReference, intent.planReference) &&
    (!checkpointed || checkpointProven)
      ? intent
      : undefined
  if (askOnly && !replyIntentBasis)
    throw new RunOperationConflictError(
      'The queued question no longer matches its task checkpoint.',
    )
  const decision = collaborationInputProcessing(task).decision
  const decisionAuthorization = decision && repo.collaborationTurnAuthorization(decision.runId)
  const planningDecision = Boolean(
    decisionAuthorization &&
    decisionAuthorization.taskId === task.id &&
    decisionAuthorization.actor === task.actor &&
    collaborationPlanMode(task, decisionAuthorization),
  )
  const planningReply = !askOnly && (planningDecision || collaborationPlanMode(task))
  const planRevisionContextRef =
    previousTask && (task.stage !== 'reply' || planningReply)
      ? freezePlanRevisionSources(repo, runId, previousTask, task.stage)
      : undefined
  const authorization: CollaborationTurnAuthorization = {
    runId,
    taskId: task.id,
    taskRevision: task.revision,
    actor: task.actor,
    stage: task.stage,
    ...(task.stage === 'reply'
      ? {
          replyMode: planningReply ? ('plan' as const) : ('read_only' as const),
        }
      : {}),
    inputSequence: task.inputSequence,
    ...(task.stageRoles ? { stageRoles: task.stageRoles } : {}),
    ...(task.planReference ? { planReference: task.planReference } : {}),
    ...(task.reviewScopeRef ? { reviewScopeRef: task.reviewScopeRef } : {}),
    inputBatchRef: { id: batch.id, revision: batch.revision, memberCount: batch.memberCount },
    inputProcessing: collaborationInputProcessing(task),
    ...(replyIntentBasis ? { replyIntentBasis } : {}),
    ...(planRevisionContextRef ? { planRevisionContextRef } : {}),
    ...(sourceManifestRef ? { sourceManifestRef } : {}),
    ...(relayWorkRef ? { relayWorkRef } : {}),
    ...(userAuthority ? { userAuthority } : {}),
  }
  task.authorization = authorization
  const stored = repo.storedCollaboration(task)
  repo.database
    .insert(workflowTurns)
    .values({
      runId,
      taskId: task.id,
      stage: task.stage,
      actor: task.actor,
      inputSequence: task.inputSequence,
      taskRevision: task.revision,
      authorizationJson: JSON.stringify(authorization),
      stateJson: JSON.stringify(stored),
      reservation: isCollaborationOpenMode(task)
        ? null
        : task.stage === 'plan_review'
          ? 'discussionRounds'
          : task.stage === 'code_review'
            ? 'reviewCycles'
            : task.stage === 'repair' &&
                (!task.pendingWork || task.pendingWork.repairReservationReleased)
              ? 'repairAttempts'
              : null,
      createdAt: new Date().toISOString(),
    })
    .run()
  repo.saveCollaboration(task)
}

export function sealInputBatchSources(
  repo: ConversationRepositoryHost,
  batchId: string,
  runId: string,
): void {
  const batch = repo.database
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, batchId))
    .get()!
  if (!batch.bodyDocumentJson && batch.messageId) {
    const content = repo.database
      .select({ text: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, batch.messageId))
      .get()!.text
    repo.database
      .update(conversationInputBatches)
      .set({ bodyDocumentJson: JSON.stringify(repo.saveCollaborationDocument(runId, content)) })
      .where(eq(conversationInputBatches.id, batchId))
      .run()
  }
  let ordinal = -1
  for (;;) {
    const rows = repo.database
      .select({ member: conversationInputBatchMembers, body: anchoredComments.body })
      .from(conversationInputBatchMembers)
      .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
      .where(
        and(
          eq(conversationInputBatchMembers.batchId, batchId),
          gt(conversationInputBatchMembers.ordinal, ordinal),
        ),
      )
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS)
      .all()
    if (!rows.length) break
    for (const row of rows)
      if (!row.member.bodyDocumentJson)
        repo.database
          .update(conversationInputBatchMembers)
          .set({
            bodyDocumentJson: JSON.stringify(repo.saveCollaborationDocument(runId, row.body)),
            anchorDocumentJson: JSON.stringify(
              repo.saveCollaborationDocument(runId, row.member.anchorJson),
            ),
          })
          .where(
            and(
              eq(conversationInputBatchMembers.batchId, batchId),
              eq(conversationInputBatchMembers.memberId, row.member.memberId),
            ),
          )
          .run()
    ordinal = rows.at(-1)!.member.ordinal
  }
}

export function latestSteerGrant(
  repo: ConversationRepositoryHost,
  runId: string,
): typeof conversationQueueOperations.$inferSelect | undefined {
  return repo.database
    .select()
    .from(conversationQueueOperations)
    .where(
      and(
        eq(conversationQueueOperations.targetRunId, runId),
        eq(conversationQueueOperations.kind, 'steer'),
        inArray(conversationQueueOperations.state, [
          'prepared',
          'possibly_sent',
          'accepted',
          'consumed',
          'unknown',
        ]),
      ),
    )
    .orderBy(desc(conversationQueueOperations.inputRevision))
    .limit(1)
    .get()
}

export function documentReference(
  repo: ConversationRepositoryHost,
  sessionId: string,
  id: string,
): CollaborationDocument {
  const body = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(and(eq(conversationBodyInputs.id, id), eq(conversationBodyInputs.sessionId, sessionId)))
    .get()
  if (!body?.sealed || !body.hash || !body.sourceRunId)
    throw new RunOperationConflictError('The immutable workflow document is unavailable.')
  return { id: body.id, sha256: body.hash, bytes: body.bytes, chars: body.chars }
}

function backgroundReportDocument(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageId: string,
): CollaborationDocument {
  const body = repo.database
    .select({
      committed: conversationBodyInputs.committedMessageId,
      purpose: conversationBodyInputs.purpose,
    })
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.id, messageId),
        eq(conversationBodyInputs.sessionId, sessionId),
      ),
    )
    .get()
  if (body?.committed !== messageId || body.purpose !== 'answer')
    throw new HandoffSourceUnavailableError('The immutable background update is unavailable.')
  return documentReference(repo, sessionId, messageId)
}

export function messageDocument(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  messageId: string,
): CollaborationDocument | undefined {
  const row = repo.database
    .select({
      bytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      content: sql<
        string | null
      >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${CONVERSATION_MARKDOWN_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      state: conversationMessages.state,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, messageId),
        eq(conversationMessages.sessionId, sessionId),
        eq(conversationMessages.runId, runId),
      ),
    )
    .get()
  if (!row || row.state !== 'complete') return undefined
  const body = repo.database
    .select({ id: conversationBodyInputs.id })
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.sessionId, sessionId),
        eq(conversationBodyInputs.committedMessageId, messageId),
        eq(conversationBodyInputs.sourceRunId, runId),
        eq(conversationBodyInputs.sealed, true),
      ),
    )
    .orderBy(desc(conversationBodyInputs.updatedAt), desc(conversationBodyInputs.createdAt))
    .limit(1)
    .get()
  if (body) return documentReference(repo, sessionId, body.id)
  if (row.content === null)
    throw new RunOperationConflictError(
      'The complete response has not been sealed into its source document.',
    )
  return repo.saveCollaborationDocument(runId, row.content)
}

function runChangeEvidence(repo: ConversationRepositoryHost, sessionId: string, runId: string) {
  return (
    repo.database
      .select({
        id: workspaceChangeSets.id,
        revision: workspaceChangeSets.revision,
        state: workspaceChangeSets.state,
        fileCount: workspaceChangeSets.fileCount,
        effectsUncertain: workspaceChangeSets.effectsUncertain,
      })
      .from(workspaceChangeSets)
      .where(
        and(eq(workspaceChangeSets.sessionId, sessionId), eq(workspaceChangeSets.runId, runId)),
      )
      .get() ?? null
  )
}

export function runHasRecordedCodeChanges(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
): boolean {
  const set = runChangeEvidence(repo, sessionId, runId)
  if (!set || set.state === 'undone') return false
  if (set.fileCount > 0) return true
  return Boolean(
    repo.database
      .select({ path: workspaceFileChanges.path })
      .from(workspaceFileChanges)
      .where(eq(workspaceFileChanges.changeSetId, set.id))
      .limit(1)
      .get(),
  )
}

export function quotedSource(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageId: string,
): {
  sourceMessageId: string
  sourceRevision: number
  batchId: string | null
  documentsJson: string
} {
  const message = repo.database
    .select({
      id: conversationMessages.id,
      runId: conversationMessages.runId,
      role: conversationMessages.role,
      sourceMessageId: conversationMessages.sourceMessageId,
      contentRevision: conversationMessages.contentRevision,
      state: conversationMessages.state,
    })
    .from(conversationMessages)
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
    )
    .get()
  if (message && isConversationBackgroundReport(message))
    return {
      sourceMessageId: messageId,
      sourceRevision: message.contentRevision,
      batchId: null,
      documentsJson: JSON.stringify(
        message.state === 'incomplete'
          ? []
          : [{ key: 'message', source: backgroundReportDocument(repo, sessionId, messageId) }],
      ),
    }
  if (!message?.runId)
    throw new HandoffSourceUnavailableError('The frozen quoted Message is unavailable.')
  const batch = inputBatchForMessage(repo, sessionId, messageId)
  const documents: Array<{ key: string; source: CollaborationDocument }> = []
  const inputBody =
    message.role === 'user' && batch
      ? repo.database
          .select({ document: conversationInputBatches.bodyDocumentJson })
          .from(conversationInputBatches)
          .where(
            and(
              eq(conversationInputBatches.id, batch.id),
              eq(conversationInputBatches.sessionId, sessionId),
              eq(conversationInputBatches.messageId, messageId),
            ),
          )
          .get()?.document
      : undefined
  // User inputs are sealed by their Batch; response documents belong to assistant Messages.
  const body = inputBody
    ? collaborationDocumentSchema.parse(JSON.parse(inputBody))
    : messageDocument(repo, sessionId, message.runId, messageId)
  if (body) {
    repo.collaborationDocumentRow(sessionId, body)
    documents.push({ key: 'message', source: body })
  }
  if (message.role === 'user' && batch) {
    const saved = repo.database
        .select()
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.id, batch.id))
        .get()!,
      answer = repo.preparedInformation(saved)?.answerDocument
    const declared = repo.userInformation(saved)
    if (declared) {
      repo.collaborationDocumentRow(sessionId, declared.document)
      documents.push({ key: 'user_information', source: declared.document })
    }
    if (answer) {
      repo.collaborationDocumentRow(sessionId, answer)
      documents.push({ key: 'user_clarification', source: answer })
    }
  } else if (message.role === 'user' && !batch) {
    const legacyCommentLimit = HANDOFF_PAGE_ITEMS * MAX_COMMENTS_PER_MESSAGE
    const legacyRows = repo.database
      .select()
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, sessionId),
          eq(anchoredComments.sentWithMessageId, messageId),
        ),
      )
      .orderBy(asc(anchoredComments.position))
      .limit(legacyCommentLimit + 1)
      .all()
    if (legacyRows.length > legacyCommentLimit) {
      throw new HandoffTooLargeError('Too many saved Comments to send safely.')
    }
    if (legacyRows.length > 0) {
      const serialized = JSON.stringify(
        legacyRows.map((row) => {
          const comment = toComment(row)
          return { id: comment.id, body: comment.body, anchor: comment.anchor }
        }),
      )
      if (Buffer.byteLength(serialized, 'utf8') > HANDOFF_SAFETY_BYTES) {
        throw new HandoffTooLargeError('The legacy Comments exceed the context working budget.')
      }
      const commentsDoc = repo.saveCollaborationDocument(message.runId, serialized)
      repo.collaborationDocumentRow(sessionId, commentsDoc)
      documents.push({ key: 'comments', source: commentsDoc })
    }
  }
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, message.runId))
    .get()
  if (message.role === 'assistant' && turn?.applied) {
    const task = repo.decodedCollaboration(turn.stateJson)
    if (task.planReference?.sourceRunId === message.runId)
      documents.push({ key: 'plan', source: task.planReference.document })
    if (turn.reportBodyId)
      documents.push({
        key: 'report',
        source: documentReference(repo, sessionId, turn.reportBodyId),
      })
  }
  if (message.role === 'assistant') {
    const manifest = handoffGuidanceForRun(repo, message.runId)
    if (manifest) {
      documents.push({ key: 'plan_revision_guidance', source: manifest.document })
      for (const source of manifest.guidance.sources)
        if (!documents.some((entry) => entry.source.id === source.document.id))
          documents.push({ key: `plan_revision_${source.id}`, source: source.document })
    }
  }
  return {
    sourceMessageId: messageId,
    sourceRevision: message.contentRevision,
    batchId: batch?.id ?? null,
    documentsJson: JSON.stringify(documents),
  }
}

export function freezeRunSources(
  repo: ConversationRepositoryHost,
  runId: string,
  refs: ReadonlyArray<HandoffSourceRef>,
  workflow: boolean,
): void {
  const run = repo.findRun(runId)!
  for (const ref of refs) {
    if (
      workflow &&
      repo.database
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, ref.id), askOnlySource(repo, conversationMessages)))
        .get()
    )
      throw new HandoffSourceUnavailableError(
        'A question is outside the automatic workflow handoff.',
      )
    const source = quotedSource(repo, run.sessionId, ref.id)
    if (source.sourceRevision !== ref.revision)
      throw new HandoffSourceUnavailableError('The quoted source changed before Run authorization.')
    repo.database
      .insert(conversationRunSourceRefs)
      .values({ runId, ...source })
      .onConflictDoNothing()
      .run()
  }
  const context = repo.nativeContext(run.sessionId, run.agentId)
  if (!context?.nativeSessionId || context.bindingGeneration !== (run.bindingGeneration ?? 1))
    return
  repo.database
    .run(sql`INSERT OR IGNORE INTO conversation_run_source_refs(run_id,source_message_id,source_revision,batch_id,documents_json)
      SELECT ${runId},s.source_message_id,s.source_revision,s.batch_id,s.documents_json FROM conversation_rebuild_source_refs s
      JOIN native_rebuild_operations n ON n.id=s.operation_id
      JOIN conversation_messages m ON m.id=s.source_message_id AND m.session_id=n.session_id
      WHERE n.session_id=${run.sessionId}
      AND n.agent_id=${run.agentId} AND n.old_generation+1=${run.bindingGeneration ?? 1}
      AND n.provisional_native_session_id=${context.nativeSessionId} AND n.stage='completed'
      AND n.native_work_state='settled' AND n.source_hash IS NOT NULL AND n.source_chunks_json IS NOT NULL
      AND n.through_sequence=${context.rebuiltThroughSequence ?? -1} AND m.sequence<=n.through_sequence
      ${workflow ? sql`AND NOT ${askOnlySource(repo, { runId: sql`m.run_id`, sourceMessageId: sql`m.source_message_id`, sessionId: sql`m.session_id`, role: sql`m.role` })}` : sql``}
      AND ((n.agent_id='codex' AND n.initialization_witness_json IS NOT NULL
          AND json_extract(n.initialization_witness_json,'$.kind')='codex_rollout_v1'
          AND json_extract(n.initialization_witness_json,'$.nativeSessionId')=n.provisional_native_session_id)
        OR (n.agent_id='agy' AND n.initialization_witness_json IS NOT NULL
          AND json_extract(n.initialization_witness_json,'$.kind')='agy_rebuild_v1'
          AND json_extract(n.initialization_witness_json,'$.nativeSessionId')=n.provisional_native_session_id
          AND json_extract(n.initialization_witness_json,'$.sourceHash')=n.source_hash
          AND json_extract(n.initialization_witness_json,'$.stepCount')=2
          AND json_extract(n.initialization_witness_json,'$.coldLoadVerifiedAt') IS NOT NULL)
        OR (n.agent_id='claude' AND n.initialization_witness_json IS NULL))`)
}

export function hasRunSources(repo: ConversationRepositoryHost, runId: string): boolean {
  return Boolean(
    repo.database
      .select({ id: conversationRunSourceRefs.sourceMessageId })
      .from(conversationRunSourceRefs)
      .where(eq(conversationRunSourceRefs.runId, runId))
      .limit(1)
      .get(),
  )
}

const RUN_SOURCES_INDEX_ITEM_MAX_BYTES = COLLABORATION_INDEX_BYTES - 1984

export type RunSourceSpeaker = 'user' | 'system' | 'assistant' | RuntimeAgentId

export interface RunSourceIndexItem {
  messageId: string
  sequence: number
  speaker: RunSourceSpeaker
  revision: number
  documents: Array<{ key: string; source: CollaborationDocument }>
  inputBatchRef?: InputBatchReference
}

export interface RunSourcesIndexPage extends RunSourcesPage {
  items: RunSourceIndexItem[]
}

function resolveRunSourceSpeaker(
  role: 'user' | 'assistant' | 'system',
  handledBy: RuntimeAgentId | null,
): RunSourceSpeaker {
  if (role === 'user') return 'user'
  if (role === 'system') return 'system'
  return handledBy ?? 'assistant'
}

export function readRunSources(
  repo: ConversationRepositoryHost,
  runId: string,
  offset = 0,
  fitsTransport?: (page: RunSourcesIndexPage) => boolean,
): RunSourcesIndexPage {
  const run = repo.findRun(runId)
  if (!run || !Number.isSafeInteger(offset) || offset < 0)
    throw new RunOperationConflictError('The Run source cursor is unavailable.')
  const rows = repo.database
    .select({
      sourceMessageId: conversationRunSourceRefs.sourceMessageId,
      sourceRevision: conversationRunSourceRefs.sourceRevision,
      batchId: conversationRunSourceRefs.batchId,
      documentsJson: conversationRunSourceRefs.documentsJson,
      sequence: conversationMessages.sequence,
      role: conversationMessages.role,
      handledBy: sql<RuntimeAgentId | null>`coalesce(${agentRuns.agentId}, ${conversationMessages.agentId})`,
    })
    .from(conversationRunSourceRefs)
    .innerJoin(
      conversationMessages,
      and(
        eq(conversationMessages.id, conversationRunSourceRefs.sourceMessageId),
        eq(conversationMessages.sessionId, run.sessionId),
      ),
    )
    .leftJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
    .where(eq(conversationRunSourceRefs.runId, runId))
    .orderBy(asc(conversationMessages.sequence), asc(conversationRunSourceRefs.sourceMessageId))
    .limit(COLLABORATION_INDEX_ITEMS + 1)
    .offset(offset)
    .all()
  const candidates: RunSourceIndexItem[] = rows.slice(0, COLLABORATION_INDEX_ITEMS).map((row) =>
    Object.assign(
      {
        messageId: row.sourceMessageId,
        sequence: row.sequence,
        speaker: resolveRunSourceSpeaker(row.role, row.handledBy),
        revision: row.sourceRevision,
        documents: storedDocuments(row.documentsJson),
      },
      row.batchId
        ? {
            inputBatchRef: inputBatchReference(
              repo,
              repo.database
                .select()
                .from(conversationInputBatches)
                .where(eq(conversationInputBatches.id, row.batchId))
                .get()!,
            ),
          }
        : {},
    ),
  )
  const items: RunSourceIndexItem[] = []
  let bytes = 2
  for (const candidate of candidates) {
    const itemBytes = Buffer.byteLength(JSON.stringify(candidate)) + 1
    const proposed = [...items, candidate]
    if (
      bytes + itemBytes > RUN_SOURCES_INDEX_ITEM_MAX_BYTES ||
      (fitsTransport &&
        !fitsTransport({
          runId,
          items: proposed,
          offset,
          nextOffset: rows.length > proposed.length ? offset + proposed.length : null,
        }))
    ) {
      if (!items.length) throw new OversizedConversationEntityError()
      break
    }
    items.push(candidate)
    bytes += itemBytes
  }
  return {
    runId,
    items,
    offset,
    nextOffset: rows.length > items.length ? offset + items.length : null,
  }
}

function frozenSourceDocuments(
  repo: ConversationRepositoryHost,
  runId: string,
  auth: CollaborationTurnAuthorization | undefined = repo.collaborationTurnAuthorization(runId),
): CollaborationDocument[] {
  if (!auth) return []
  const frozen = repo.database
    .select({ state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  const task = frozen ? repo.decodedCollaboration(frozen.state) : undefined
  const refs = [
    auth.relayWorkRef,
    auth.planRevisionContextRef,
    auth.planReference?.document,
    auth.reviewScopeRef,
    auth.sourceManifestRef,
    task?.taskDocument,
    task?.planReference?.document,
    task?.review?.document,
    task?.review?.planReference?.document,
    task?.review?.scopeRef,
  ]
  return refs.filter((ref): ref is CollaborationDocument => ref !== undefined)
}

function standardSourceDocumentAuthorized(
  repo: ConversationRepositoryHost,
  runId: string,
  document: CollaborationDocument,
): boolean {
  const run = repo.findRun(runId)
  if (!run) return false
  let body: ReturnType<ConversationRepositoryHost['collaborationDocumentRow']>
  try {
    body = repo.collaborationDocumentRow(run.sessionId, document)
  } catch {
    return false
  }
  if (body.sourceRunId === runId) return true
  const auth = repo.collaborationTurnAuthorization(runId)
  if (auth) {
    if (
      frozenSourceDocuments(repo, runId, auth).some(
        (ref) => ref.id === document.id && ref.sha256 === document.sha256,
      )
    )
      return true
    if (
      repo.sourceQueries.earlierInputDocument().get({
        taskId: auth.taskId,
        inputSequence: auth.inputSequence,
        documentId: document.id,
      })
    )
      return true
  }
  return Boolean(repo.sourceQueries.quotedDocument().get({ runId, documentId: document.id }))
}

function handoffGuidanceForRun(
  repo: ConversationRepositoryHost,
  runId: string,
): { document: CollaborationDocument; guidance: HandoffGuidance } | undefined {
  const auth = repo.collaborationTurnAuthorization(runId)
  const document = auth?.sourceManifestRef
  if (!auth || !document || document.bytes > PLAN_REVISION_GUIDANCE_BYTES) return undefined
  const run = repo.findRun(runId)
  if (!run) return undefined
  try {
    const owner = repo.collaborationDocumentRow(run.sessionId, document)
    if (owner.sourceRunId !== runId) {
      const replacement = repo.database
        .select()
        .from(runReexecutionOperations)
        .where(eq(runReexecutionOperations.replacementRunId, runId))
        .get()
      const originalAuth =
        replacement && repo.collaborationTurnAuthorization(replacement.originalRunId)
      if (
        !replacement ||
        owner.sourceRunId !== replacement.originalRunId ||
        !isDeepStrictEqual(originalAuth?.sourceManifestRef, document)
      )
        return undefined
    }
    const guidance = handoffGuidanceSchema.parse(
      JSON.parse(repo.collaborationDocumentText(run.sessionId, document)),
    )
    const bindingMatches =
      guidance.version === 'plan-revision-guidance-v1'
        ? guidance.taskId === auth.taskId &&
          guidance.inputSequence === auth.inputSequence &&
          guidance.planVersion === auth.planReference?.version
        : guidance.basis.task.id === auth.taskId &&
          guidance.basis.task.inputSequence === auth.inputSequence &&
          isDeepStrictEqual(guidance.basis.plan, auth.planReference ?? null)
    if (
      !bindingMatches ||
      guidance.sources.some(
        (source) => !standardSourceDocumentAuthorized(repo, runId, source.document),
      )
    )
      return undefined
    return { document, guidance }
  } catch {
    return undefined
  }
}

export function sourceDocumentAuthorized(
  repo: ConversationRepositoryHost,
  runId: string,
  document: CollaborationDocument,
): boolean {
  if (standardSourceDocumentAuthorized(repo, runId, document)) return true
  const manifest = handoffGuidanceForRun(repo, runId)
  return Boolean(
    manifest?.guidance.sources.some(
      (source) => source.document.id === document.id && source.document.sha256 === document.sha256,
    ),
  )
}

export function readWorkflowInputs(
  repo: ConversationRepositoryHost,
  runId: string,
  offset = 0,
  fitsTransport?: (page: WorkflowInputsPage) => boolean,
): WorkflowInputsPage {
  const auth = repo.collaborationTurnAuthorization(runId)
  if (!auth || !Number.isSafeInteger(offset) || offset < 0)
    throw new RunOperationConflictError('The frozen workflow input scope is unavailable.')
  const rows = repo.database
    .select()
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.taskId, auth.taskId),
        lte(conversationInputBatches.sequence, auth.inputSequence),
        gt(conversationInputBatches.sequence, offset),
        ne(conversationInputBatches.bodyState, 'withdrawn'),
      ),
    )
    .orderBy(asc(conversationInputBatches.sequence))
    .limit(COLLABORATION_INDEX_ITEMS + 1)
    .all()
  const candidates = rows.slice(0, COLLABORATION_INDEX_ITEMS).map((row) =>
    Object.assign(
      {
        sequence: row.sequence,
        messageId: row.messageId,
        batch: { id: row.id, revision: row.commentsRevision, memberCount: row.memberCount },
      },
      row.bodyDocumentJson
        ? { body: collaborationDocumentSchema.parse(JSON.parse(row.bodyDocumentJson)) }
        : {},
    ),
  )
  const items: WorkflowInputsPage['items'] = []
  for (const candidate of candidates) {
    const proposed = [...items, candidate]
    if (
      Buffer.byteLength(JSON.stringify(proposed)) > COLLABORATION_INDEX_BYTES - 2048 ||
      (fitsTransport &&
        !fitsTransport({
          items: proposed,
          offset,
          nextOffset: rows.length > proposed.length ? candidate.sequence : null,
        }))
    ) {
      if (!items.length) throw new OversizedConversationEntityError()
      break
    }
    items.push(candidate)
  }
  return {
    items,
    offset,
    nextOffset: rows.length > items.length ? rows[items.length - 1]!.sequence : null,
  }
}

/** Bounded frozen member identities and immutable bodies, also available to ordinary Runs. */
export function readFrozenInputBatch(
  repo: ConversationRepositoryHost,
  runId: string,
  batchId: string,
  afterOrdinal = -1,
  fitsTransport?: (page: FrozenInputBatchPage) => boolean,
): FrozenInputBatchPage {
  const run = repo.findRun(runId)
  const batch = repo.database
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, batchId))
    .get()
  const auth = repo.collaborationTurnAuthorization(runId)
  const allowed =
    batch &&
    run &&
    batch.sessionId === run.sessionId &&
    (batch.runId === runId ||
      (auth?.taskId === batch.taskId && batch.sequence <= auth.inputSequence) ||
      runHasBatchHandoff(repo, runId, batchId))
  if (!allowed || !batch || !run)
    throw new RunOperationConflictError('The input Batch is outside this Run authorization.')
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1)
    throw new RunOperationConflictError('Invalid input Batch cursor.')
  const rows = repo.database
    .select({ member: conversationInputBatchMembers, comment: anchoredComments })
    .from(conversationInputBatchMembers)
    .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
    .where(
      and(
        eq(conversationInputBatchMembers.batchId, batchId),
        gt(conversationInputBatchMembers.ordinal, afterOrdinal),
      ),
    )
    .orderBy(asc(conversationInputBatchMembers.ordinal))
    .limit(COLLABORATION_INDEX_ITEMS + 1)
    .all()
  const members: FrozenInputBatchPage['members'] = []
  const header = {
    batch: inputBatchReference(repo, batch),
    body: batch.bodyDocumentJson
      ? collaborationDocumentSchema.parse(JSON.parse(batch.bodyDocumentJson))
      : undefined,
    userInformation: batch.userInformationDocumentJson
      ? collaborationDocumentSchema.parse(JSON.parse(batch.userInformationDocumentJson))
      : undefined,
    clarificationAnswer: repo.preparedInformation(batch)?.answerDocument,
  }
  let bytes = 0
  for (const { member, comment } of rows.slice(0, COLLABORATION_INDEX_ITEMS)) {
    if (
      comment.draftRevision !== member.commentRevision ||
      createHash('sha256').update(comment.body).digest('hex') !== member.bodySha256
    )
      throw new RunOperationConflictError('The frozen Comment source changed.')
    // This immutable part reference is Run-owned; ordinary Runs use the same body source path.
    if (!member.bodyDocumentJson)
      throw new RunOperationConflictError('The frozen Comment source was not sealed.')
    const body = collaborationDocumentSchema.parse(JSON.parse(member.bodyDocumentJson))
    const item = {
      memberId: member.memberId,
      ordinal: member.ordinal,
      commentId: member.commentId,
      revision: member.commentRevision,
      anchorDocument: collaborationDocumentSchema.parse(JSON.parse(member.anchorDocumentJson!)),
      body,
      state: member.state,
      ...(member.answerResolver ? { answerResolver: member.answerResolver } : {}),
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(item))
    const proposed = [...members, item]
    if (
      bytes + itemBytes > COLLABORATION_INDEX_BYTES - 2048 ||
      (fitsTransport &&
        !fitsTransport({
          ...header,
          members: proposed,
          hasMore: rows.length > proposed.length,
          nextOrdinal: member.ordinal,
        }))
    ) {
      if (!members.length) throw new OversizedConversationEntityError()
      break
    }
    members.push(item)
    bytes += itemBytes
  }
  return {
    ...header,
    members,
    hasMore: rows.length > members.length,
    nextOrdinal: members.at(-1)?.ordinal ?? afterOrdinal,
  }
}

function runHasBatchHandoff(
  repo: ConversationRepositoryHost,
  runId: string,
  batchId: string,
): boolean {
  return Boolean(
    repo.database
      .select({ id: conversationRunSourceRefs.sourceMessageId })
      .from(conversationRunSourceRefs)
      .where(
        and(
          eq(conversationRunSourceRefs.runId, runId),
          eq(conversationRunSourceRefs.batchId, batchId),
        ),
      )
      .limit(1)
      .get(),
  )
}

export async function readRunHandoff(
  repo: ConversationRepositoryHost,
  runId: string,
  signal: AbortSignal,
): Promise<HandoffBundle[]> {
  const run = repo.database
    .select({ sourceIds: agentRuns.handoffSourceIds })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get()
  if (!run) throw new HandoffSourceUnavailableError('The Run no longer exists.')
  if (Buffer.byteLength(run.sourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
    throw new HandoffTooLargeError()
  const parsed: unknown = JSON.parse(run.sourceIds)
  if (!Array.isArray(parsed)) throw new HandoffSourceUnavailableError()
  const refs: HandoffSourceRef[] = parsed.map((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof Reflect.get(value, 'id') !== 'string' ||
      !Number.isInteger(Reflect.get(value, 'revision')) ||
      typeof Reflect.get(value, 'digest') !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(Reflect.get(value, 'digest')) ||
      (Reflect.get(value, 'contextVersion') !== undefined &&
        !['native_workflow_v1', 'native_workflow_v1'].includes(
          String(Reflect.get(value, 'contextVersion')),
        ))
    )
      throw new HandoffSourceUnavailableError()
    return Object.assign(
      {
        id: Reflect.get(value, 'id'),
        revision: Reflect.get(value, 'revision'),
        digest: Reflect.get(value, 'digest'),
      },
      Reflect.get(value, 'contextVersion') === 'native_workflow_v1' ||
        Reflect.get(value, 'contextVersion') === 'native_workflow_v1'
        ? {
            contextVersion:
              Reflect.get(value, 'contextVersion') === 'native_workflow_v1'
                ? ('native_workflow_v1' as const)
                : ('native_workflow_v1' as const),
          }
        : {},
    )
  })
  const context: HandoffBundle[] = []
  const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
  let totalBytes = 0
  for (let offset = 0; offset < refs.length;) {
    if (signal.aborted || Date.now() >= deadline)
      throw new HandoffSourceUnavailableError('Reading the saved Agent context timed out.')
    const page = refs.slice(offset, offset + HANDOFF_PAGE_ITEMS)
    const rows = repo.database
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        runId: conversationMessages.runId,
        sourceMessageId: conversationMessages.sourceMessageId,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        contentRevision: conversationMessages.contentRevision,
        handledBy: sql<RuntimeAgentId>`coalesce(${agentRuns.agentId}, ${conversationMessages.agentId})`,
      })
      .from(conversationMessages)
      .leftJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
      .where(
        inArray(
          conversationMessages.id,
          page.map((source) => source.id),
        ),
      )
      .all()
    const metadataById = new Map(rows.map((row) => [row.id, row]))
    const ordered = page.map((ref) => {
      const row = metadataById.get(ref.id)
      if (
        !row ||
        row.contentRevision !== ref.revision ||
        !['codex', 'claude', 'agy'].includes(row.handledBy)
      )
        throw new HandoffSourceUnavailableError('A saved context source changed.')
      if (isConversationBackgroundReport(row)) backgroundReportDocument(repo, row.sessionId, row.id)
      return row
    })
    for (const row of ordered) {
      const ref = page.find((candidate) => candidate.id === row.id)!
      if (ref.contextVersion !== 'native_workflow_v1')
        admitHandoffRows(repo, [row], HANDOFF_SAFETY_BYTES - totalBytes)
      // oxlint-disable-next-line no-await-in-loop -- Each source must be read in its frozen digest version before continuing.
      const message = await readHandoffSource(
        repo,
        row,
        signal,
        deadline,
        ref.contextVersion ?? false,
      )
      if (message.contentRevision !== ref.revision || message.digest !== ref.digest)
        throw new HandoffSourceUnavailableError('A saved context source changed.')
      totalBytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
      if (totalBytes > HANDOFF_SAFETY_BYTES)
        throw new HandoffTooLargeError('The saved context exceeds its working budget.')
      context.push(message)
    }
    offset += page.length
    // oxlint-disable-next-line no-await-in-loop -- One bounded source page yields before the next SQLite read.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return context
}

function admitHandoffRows(
  repo: ConversationRepositoryHost,
  rows: HandoffRow[],
  budget = HANDOFF_PAGE_BYTES,
): HandoffRow[] {
  if (rows.some((row) => row.role === 'system')) throw new HandoffSourceUnavailableError()
  const userIds = rows.filter((row) => row.role === 'user').map((row) => row.id)
  const commentSizes = new Map(
    (userIds.length === 0
      ? []
      : repo.database
          .select({
            messageId: anchoredComments.sentWithMessageId,
            bytes: sql<number>`sum(length(CAST(${anchoredComments.body} AS BLOB)) + length(CAST(${anchoredComments.anchorJson} AS BLOB)))`,
            count: sql<number>`count(*)`,
          })
          .from(anchoredComments)
          .where(
            and(
              inArray(anchoredComments.sentWithMessageId, userIds),
              sql`NOT EXISTS (SELECT 1 FROM conversation_input_batches b WHERE b.message_id=${anchoredComments.sentWithMessageId})`,
            ),
          )
          .groupBy(anchoredComments.sentWithMessageId)
          .all()
    ).map((row) => [row.messageId, row]),
  )
  const admitted: HandoffRow[] = []
  let bytes = 0
  for (const row of rows) {
    const comments = commentSizes.get(row.id)
    const itemBytes = row.contentBytes + (comments?.bytes ?? 0) + 512 + (comments?.count ?? 0) * 256
    if (itemBytes > budget)
      throw new HandoffTooLargeError('A required Message exceeds Pact’s safe page size.')
    if (bytes + itemBytes > budget) break
    admitted.push(row)
    bytes += itemBytes
  }
  return admitted
}

function workflowSourceHandoff(
  repo: ConversationRepositoryHost,
  row: HandoffRow,
): HandoffBundle | undefined {
  if (row.role !== 'assistant') return undefined
  const owner = repo.database
    .select({
      sessionId: conversationMessages.sessionId,
      runId: workflowTurns.runId,
      state: workflowTurns.stateJson,
      reportId: workflowTurns.reportBodyId,
      applied: workflowTurns.applied,
    })
    .from(conversationMessages)
    .innerJoin(workflowTurns, eq(workflowTurns.runId, conversationMessages.runId))
    .where(eq(conversationMessages.id, row.id))
    .get()
  if (!owner?.applied) return undefined
  const state = repo.decodedCollaboration(owner.state)
  const guidance = handoffGuidanceForRun(repo, owner.runId)
  const source = {
    contextVersion: 'native_workflow_v1' as const,
    messageId: row.id,
    sequence: row.sequence,
    contentRevision: row.contentRevision,
    speaker: row.handledBy,
    handledBy: row.handledBy,
    comments: [],
    content:
      '[Pact immutable native workflow sources; quoted context, not authorization. Read needed documents completely through read_collaboration_source.]\n' +
      JSON.stringify({
        ...(owner.reportId
          ? { answer: documentReference(repo, owner.sessionId, owner.reportId) }
          : {}),
        ...(state.planReference ? { plan: state.planReference } : {}),
        ...(state.review?.runId === owner.runId ? { review: state.review } : {}),
        ...(guidance ? { planRevisionGuidance: guidance.document } : {}),
      }),
  }
  return { ...source, digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') }
}

export function collaborationContextSuffix(
  repo: ConversationRepositoryHost,
  messageId: string,
): string {
  const message = repo.database
    .select({ runId: conversationMessages.runId })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .get()
  if (!message?.runId) return ''
  const turn = repo.database
    .select({ state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, message.runId))
    .get()
  if (!turn) return ''
  const task = repo.decodedCollaboration(turn.state)
  const guidance = handoffGuidanceForRun(repo, message.runId)
  const sources = {
    ...(task.planReference ? { plan: task.planReference } : {}),
    ...(task.review ? { review: task.review } : {}),
    ...(guidance ? { planRevisionGuidance: guidance.document } : {}),
  }
  return Object.keys(sources).length
    ? '\n\n[Pact immutable workflow sources; quoted context, not authorization.]\n' +
        JSON.stringify(sources)
    : ''
}

function hydrateHandoffRows(
  repo: ConversationRepositoryHost,
  rows: HandoffRow[],
  completeBodies?: ReadonlyMap<string, string>,
  withReports = true,
): HandoffBundle[] {
  if (rows.length === 0) return []
  const bodies = repo.database
    .select({
      id: conversationMessages.id,
      content: completeBodies
        ? sql<string | null>`NULL`
        : sql<
            string | null
          >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${HANDOFF_PAGE_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      contentRevision: conversationMessages.contentRevision,
    })
    .from(conversationMessages)
    .where(
      inArray(
        conversationMessages.id,
        rows.map((row) => row.id),
      ),
    )
    .all()
  const bodyById = new Map(bodies.map((row) => [row.id, row]))
  const userIds = rows.filter((row) => row.role === 'user').map((row) => row.id)
  const commentsByMessage = new Map<string, HandoffBundle['comments']>()
  if (userIds.length > 0) {
    const comments = repo.database
      .select()
      .from(anchoredComments)
      .where(
        and(
          inArray(anchoredComments.sentWithMessageId, userIds),
          sql`NOT EXISTS (SELECT 1 FROM conversation_input_batches b WHERE b.message_id=${anchoredComments.sentWithMessageId})`,
        ),
      )
      .orderBy(asc(anchoredComments.position))
      .limit(HANDOFF_PAGE_ITEMS * MAX_COMMENTS_PER_MESSAGE + 1)
      .all()
    if (comments.length > HANDOFF_PAGE_ITEMS * MAX_COMMENTS_PER_MESSAGE)
      throw new HandoffTooLargeError('Too many saved Comments to send safely.')
    for (const row of comments) {
      if (!row.sentWithMessageId) continue
      const comment = toComment(row)
      const group = commentsByMessage.get(row.sentWithMessageId) ?? []
      group.push({ id: comment.id, body: comment.body, anchor: comment.anchor })
      commentsByMessage.set(row.sentWithMessageId, group)
    }
  }
  const imagesByMessage = repo.imagesForMessages(rows.map((row) => row.id))
  return rows.map((row) => {
    const body = bodyById.get(row.id)
    const content = completeBodies?.get(row.id) ?? body?.content
    if (!body || content == null || body.contentRevision !== row.contentRevision)
      throw new HandoffSourceUnavailableError('A required Message changed while reading.')
    const report =
      withReports && row.role === 'assistant' ? collaborationContextSuffix(repo, row.id) : ''
    const batch = inputBatchForMessage(
      repo,
      repo.database
        .select({ id: conversationMessages.sessionId })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, row.id))
        .get()!.id,
      row.id,
    )
    const source = {
      ...(batch
        ? {
            inputBatchRef: {
              id: batch.id,
              revision: batch.revision,
              memberCount: batch.memberCount,
            },
          }
        : {}),
      ...(report ? { contextVersion: 'native_workflow_v1' as const } : {}),
      messageId: row.id,
      sequence: row.sequence,
      contentRevision: row.contentRevision,
      speaker: row.role === 'user' ? ('user' as const) : row.handledBy,
      handledBy: row.handledBy,
      content: content + report,
      comments: commentsByMessage.get(row.id) ?? [],
      ...(imagesByMessage.get(row.id)?.length ? { images: imagesByMessage.get(row.id)! } : {}),
    }
    return {
      ...source,
      digest: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    }
  })
}

export function readRunArtifacts(
  repo: ConversationRepositoryHost,
  sessionId: string,
  userMessageIds: string[],
): NonNullable<Extract<ConversationPage, { scope: 'messages' }>['runArtifacts']> {
  if (!userMessageIds.length) return []
  const groups = repo.database
    .select({
      userMessageId: agentRuns.userMessageId,
      agentId: agentRuns.agentId,
      totalCount: sql<number>`count(*)`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, sessionId),
        inArray(agentRuns.userMessageId, userMessageIds),
        or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
      ),
    )
    .groupBy(agentRuns.userMessageId, agentRuns.agentId)
    .all()
  return groups.flatMap((group) => {
    const latest = repo.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.userMessageId, group.userMessageId),
          eq(agentRuns.agentId, group.agentId),
          or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(1)
      .get()
    return latest ? [{ ...group, latestRunId: latest.id }] : []
  })
}

export function receivedBodyPreview(repo: ConversationRepositoryHost, inputId: string): string {
  return (
    repo.database
      .select({ text: conversationBodyParts.text })
      .from(conversationBodyParts)
      .where(eq(conversationBodyParts.inputId, inputId))
      .orderBy(asc(conversationBodyParts.offset))
      .limit(1)
      .get()
      ?.text.slice(0, 512) ?? ''
  )
}

function mergeFrozenRunSource(
  repo: ConversationRepositoryHost,
  runId: string,
  sessionId: string,
  source: {
    messageId: string
    revision: number
    batchId?: string | null
    documents: ReturnType<typeof storedDocuments>
  },
): void {
  const existing = repo.database
    .select()
    .from(conversationRunSourceRefs)
    .where(
      and(
        eq(conversationRunSourceRefs.runId, runId),
        eq(conversationRunSourceRefs.sourceMessageId, source.messageId),
      ),
    )
    .get()
  if (
    existing &&
    (existing.sourceRevision !== source.revision ||
      (existing.batchId && source.batchId && existing.batchId !== source.batchId))
  )
    throw new RunOperationConflictError('A frozen source grant conflicts with the receiving Run.')
  const batchId = existing?.batchId ?? source.batchId ?? null
  const batch = batchId
    ? repo.database
        .select()
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.id, batchId))
        .get()
    : undefined
  if (batchId && (!batch || batch.sessionId !== sessionId || batch.messageId !== source.messageId))
    throw new RunOperationConflictError('The frozen source Batch does not belong to its Message.')
  const documents = new Map<string, ReturnType<typeof storedDocuments>[number]>()
  for (const entry of [...storedDocuments(existing?.documentsJson ?? '[]'), ...source.documents]) {
    const previous = documents.get(entry.source.id)
    if (previous && !isDeepStrictEqual(previous.source, entry.source))
      throw new RunOperationConflictError(
        'A frozen document identity conflicts with the receiving Run.',
      )
    if (!previous) {
      repo.collaborationDocumentRow(sessionId, entry.source)
      documents.set(entry.source.id, entry)
    }
  }
  const merged = [...documents.values()]
  const messageMeta = repo.database
    .select({
      sequence: conversationMessages.sequence,
      role: conversationMessages.role,
      handledBy: sql<RuntimeAgentId | null>`coalesce(${agentRuns.agentId}, ${conversationMessages.agentId})`,
    })
    .from(conversationMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
    .where(
      and(
        eq(conversationMessages.id, source.messageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  const itemBytes =
    Buffer.byteLength(
      JSON.stringify({
        messageId: source.messageId,
        ...(messageMeta
          ? {
              sequence: messageMeta.sequence,
              speaker: resolveRunSourceSpeaker(messageMeta.role, messageMeta.handledBy),
            }
          : {}),
        revision: source.revision,
        documents: merged,
        ...(batch ? { inputBatchRef: inputBatchReference(repo, batch) } : {}),
      }),
    ) + 3
  if (itemBytes > RUN_SOURCES_INDEX_ITEM_MAX_BYTES)
    throw new HandoffTooLargeError('The complete frozen grants exceed their metadata budget.')
  const documentsJson = JSON.stringify(merged)
  repo.database
    .insert(conversationRunSourceRefs)
    .values({
      runId,
      sourceMessageId: source.messageId,
      sourceRevision: source.revision,
      batchId,
      documentsJson,
    })
    .onConflictDoUpdate({
      target: [conversationRunSourceRefs.runId, conversationRunSourceRefs.sourceMessageId],
      set: { documentsJson, batchId },
    })
    .run()
}

function inheritFrozenRunSources(
  repo: ConversationRepositoryHost,
  runId: string,
  sessionId: string,
  sourceRunId: string,
): void {
  let offset = 0
  for (;;) {
    const page = readRunSources(repo, sourceRunId, offset)
    for (const source of page.items)
      mergeFrozenRunSource(repo, runId, sessionId, {
        messageId: source.messageId,
        revision: source.revision,
        batchId: source.inputBatchRef?.id ?? null,
        documents: source.documents,
      })
    if (page.nextOffset === null) return
    offset = page.nextOffset
  }
}

function freezePlanRevisionSources(
  repo: ConversationRepositoryHost,
  runId: string,
  task: CollaborationTask,
  stage: CollaborationTask['stage'],
): CollaborationDocument | undefined {
  if (!['plan', 'plan_review', 'implement', 'code_review', 'repair', 'reply'].includes(stage))
    return undefined
  const revision = task.planRevision
  const revisedWrite = task.pendingWork?.runId ?? task.codeRunId
  const inherited = revisedWrite && repo.collaborationTurnAuthorization(revisedWrite)
  const priorContext = inherited && inherited.planRevisionContextRef
  if (!revision && (!priorContext || !revisedWrite)) return undefined

  const sourceRunId = revision?.writeRunId ?? revisedWrite!
  const original = repo.unfinishedWriteSource(task, sourceRunId, true)
  if (original.auth.userAuthority) repo.originalWriteReceipt(task, original, false, true)
  const source = quotedSource(repo, task.sessionId, original.run.userMessageId)
  if (source.batchId !== original.auth.inputBatchRef?.id)
    throw new RunOperationConflictError('The prior write input Batch is unavailable.')
  const documents = storedDocuments(source.documentsJson)
  const exactWriteDocuments = [
    ['prior_write_plan', original.auth.planReference?.document],
    ['prior_write_review_scope', original.auth.reviewScopeRef],
    ['prior_plan_revision', original.auth.planRevisionContextRef],
  ] as const
  for (const [key, document] of exactWriteDocuments)
    if (document) documents.push({ key, source: document })
  mergeFrozenRunSource(repo, runId, task.sessionId, {
    messageId: source.sourceMessageId,
    revision: source.sourceRevision,
    batchId: source.batchId,
    documents,
  })
  inheritFrozenRunSources(repo, runId, task.sessionId, sourceRunId)
  if (!revision && priorContext) {
    repo.collaborationDocumentRow(task.sessionId, priorContext)
    return priorContext
  }
  const report =
    original.run.responseMessageId && repo.hasCompleteResponse(sourceRunId)
      ? messageDocument(repo, task.sessionId, sourceRunId, original.run.responseMessageId)
      : undefined
  if (report && original.run.responseMessageId) {
    const carrier = quotedSource(repo, task.sessionId, original.run.responseMessageId)
    mergeFrozenRunSource(repo, runId, task.sessionId, {
      messageId: carrier.sourceMessageId,
      revision: carrier.sourceRevision,
      documents: storedDocuments(carrier.documentsJson),
    })
  }
  const changes = runChangeEvidence(repo, task.sessionId, sourceRunId)
  return repo.saveCollaborationDocument(
    runId,
    JSON.stringify({
      version: 'plan-revision-work-v1',
      originalWriteRunId: sourceRunId,
      revisionInputSequence: revision!.inputSequence,
      inputBatchRef: original.auth.inputBatchRef,
      originalWriteReport: report ?? null,
      originalWriteChanges: changes
        ? { ...changes, sourceChangeSetId: changes.id, id: undefined }
        : null,
      originalWriteOutcome: original.run.nativeOutcome ?? null,
    }),
  )
}

/** Stable business event identity, with independently replaceable freshness and source facts. */
export function workflowHandoff(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  actor: RuntimeAgentId,
  inputId?: string,
): SchedulingHandoff {
  const session = repo.database.select().from(sessions).where(eq(sessions.id, task.sessionId)).get()
  if (!session) throw new RunOperationConflictError('The workflow Session is unavailable.')
  const binding = repo.nativeContext(task.sessionId, actor)
  const facts = {
    taskId: task.id,
    ...(task.rolePolicy
      ? { rolePolicy: task.rolePolicy, owner: task.owner, reviewer: task.reviewer }
      : {}),
    ...(task.stageRoles ? { stageRoles: task.stageRoles } : {}),
    runId: task.runId,
    stage: task.stage,
    inputSequence: task.inputSequence,
    taskDocument: task.taskDocument,
    planReference: task.planReference,
    review: task.review,
    ...(task.reviewControlCoverage ? { reviewControlCoverage: task.reviewControlCoverage } : {}),
    reviewScopeRef: task.reviewScopeRef,
    codeRunId: task.codeRunId,
    pendingWork: task.pendingWork,
    ...(task.planRevision ? { planRevision: task.planRevision } : {}),
    inputProcessing: collaborationInputProcessing(task),
    authorization: task.authorization,
    inputId,
  }
  const roleHandoff =
    !inputId &&
    task.kind === 'plan' &&
    task.stage === 'plan_review' &&
    task.status === 'ready' &&
    collaborationPlanAccepted(task)
  return scheduling.handoff({
    sessionId: task.sessionId,
    budgetRoot: { kind: 'task', id: task.id },
    eventId: inputId ?? task.runId,
    slot: inputId ? 'input_dispatch' : 'workflow_next',
    factFingerprint: scheduling.fingerprint(
      repo.planReviewLimitReached(task)
        ? { ...facts, profile: 'plan_review_limit' }
        : roleHandoff
          ? { ...facts, stageRoles: undefined }
          : facts,
    ),
    freshnessGuard: {
      taskRevision: task.revision,
      settingsRevision: session.settingsRevision,
      inputSequence: task.inputSequence,
      runId: task.runId,
      agentId: actor,
      bindingGeneration: binding?.bindingGeneration ?? 1,
      stateFingerprint: scheduling.fingerprint({
        facts,
        status: task.status,
        automation: task.automation,
        pauseReason: task.pauseReason,
        nativeSessionId: binding?.nativeSessionId,
        continuationState: binding?.continuationState,
        permissions: binding?.permissionRequests,
        receivedInputId: repo.receivedCollaborationInput(task.sessionId)?.id,
        queueRevision: session.queueRevision,
        queuePauseReason: session.queuePauseReason,
      }),
    },
  })
}

/** Recovery identity/readback only: this does not run Check, retry, resend or create a candidate. */
export function recoveryHandoff(
  repo: ConversationRepositoryHost,
  fault: NonNullable<SchedulingHandoff['fault']>,
): SchedulingHandoff {
  const operation =
    fault.kind === 'queue'
      ? repo.database
          .select()
          .from(conversationQueueOperations)
          .where(eq(conversationQueueOperations.id, fault.id))
          .get()
      : fault.kind === 'rebuild'
        ? repo.database
            .select()
            .from(nativeRebuildOperations)
            .where(eq(nativeRebuildOperations.id, fault.id))
            .get()
        : undefined
  const queuedInput =
    operation && 'inputId' in operation && operation.inputId
      ? repo.database
          .select()
          .from(collaborationInputs)
          .where(eq(collaborationInputs.id, operation.inputId))
          .get()
      : undefined
  const queuedBody = queuedInput
    ? repo.database
        .select({ clientMessageId: conversationBodyInputs.clientMessageId })
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, queuedInput.inputId))
        .get()
    : undefined
  const replacement =
    fault.kind === 'run'
      ? repo.database
          .select({ runId: runReexecutionOperations.replacementRunId })
          .from(runReexecutionOperations)
          .innerJoin(
            schedulingRecoveryFaults,
            eq(schedulingRecoveryFaults.id, runReexecutionOperations.faultId),
          )
          .where(
            and(
              eq(schedulingRecoveryFaults.faultKind, 'run'),
              eq(schedulingRecoveryFaults.faultId, fault.id),
            ),
          )
          .get()
      : undefined
  const runId =
    fault.kind === 'run'
      ? (replacement?.runId ?? fault.id)
      : operation &&
        ('oldRunId' in operation
          ? operation.oldRunId
          : (operation.targetRunId ?? queuedInput?.anchorRunId))
  const run = runId ? repo.findRun(runId) : undefined
  if (!run) throw new RunOperationConflictError('The original recovery target is unavailable.')
  const session = repo.database.select().from(sessions).where(eq(sessions.id, run.sessionId)).get()!
  const task = run.collaboration ? repo.collaboration(run.sessionId) : undefined
  const binding = repo.nativeContext(run.sessionId, run.agentId)
  const facts = {
    target: fault,
    operation: operation
      ? 'oldRunId' in operation
        ? {
            id: operation.id,
            stage: operation.stage,
            oldGeneration: operation.oldGeneration,
            oldNativeSessionId: operation.oldNativeSessionId,
            provisionalNativeSessionId: operation.provisionalNativeSessionId,
            sourceHash: operation.sourceHash,
            nativeWorkState: operation.nativeWorkState,
            initializationWitness: operation.initializationWitnessJson,
          }
        : {
            id: operation.id,
            kind: operation.kind,
            state: operation.state,
            inputId: operation.inputId,
            targetRunId: operation.targetRunId,
            bindingGeneration: operation.bindingGeneration,
            nativeTurnId: operation.nativeTurnId,
            executorId: operation.executorId,
          }
      : undefined,
    runId: run.id,
    dispatchPhase: run.dispatchPhase,
    nativeTurnId: run.nativeTurnId,
    nativeOutcome: run.nativeOutcome,
    nativeEffectsState: run.nativeEffectsState,
    responseComplete: repo.hasCompleteResponse(run.id),
    nativeSessionId: run.nativeSessionId,
  }
  return scheduling.handoff({
    sessionId: run.sessionId,
    budgetRoot:
      queuedInput && queuedBody
        ? queuedInput.taskId
          ? { kind: 'task', id: queuedInput.taskId }
          : { kind: 'input', id: queuedBody.clientMessageId }
        : run.collaboration
          ? { kind: 'task', id: run.collaboration.taskId }
          : { kind: 'input', id: run.userMessageId },
    fault,
    eventId: `${fault.id}:${scheduling.fingerprint(facts)}`,
    slot:
      fault.kind === 'run'
        ? 'native_check'
        : fault.kind === 'queue'
          ? 'queue_check'
          : 'rebuild_check',
    factFingerprint: scheduling.fingerprint(facts),
    freshnessGuard: {
      taskRevision: task?.revision ?? null,
      settingsRevision: session.settingsRevision,
      inputSequence: task?.inputSequence ?? 0,
      runId: run.id,
      agentId: run.agentId,
      bindingGeneration: binding?.bindingGeneration ?? run.bindingGeneration ?? 1,
      stateFingerprint: scheduling.fingerprint({
        facts,
        task: task
          ? {
              id: task.id,
              revision: task.revision,
              status: task.status,
              automation: task.automation,
              inputSequence: task.inputSequence,
              runId: task.runId,
            }
          : undefined,
        binding: binding
          ? {
              generation: binding.bindingGeneration,
              nativeSessionId: binding.nativeSessionId,
              continuationState: binding.continuationState,
              permissions: binding.permissionRequests,
            }
          : undefined,
        queueRevision: session.queueRevision,
      }),
    },
  })
}

/** Physical parts are normalized before UTF-8 hashing or JSON escaping, including split pairs. */
export function* planRevisionDocumentChunks(
  repo: ConversationRepositoryHost,
  sessionId: string,
  document: CollaborationDocument,
  check = () => {},
): Generator<string> {
  repo.collaborationDocumentRow(sessionId, document)
  const hash = createHash('sha256')
  let offset = 0,
    chars = 0,
    bytes = 0,
    highSurrogate = ''
  while (offset < document.chars) {
    check()
    const part = repo.database
      .select({
        text: sql<
          string | null
        >`CASE WHEN length(CAST(${conversationBodyParts.text} AS BLOB)) <= ${4 * BODY_PART_UNITS} THEN ${conversationBodyParts.text} ELSE NULL END`,
      })
      .from(conversationBodyParts)
      .where(
        and(
          eq(conversationBodyParts.inputId, document.id),
          eq(conversationBodyParts.offset, offset),
        ),
      )
      .get()
    if (
      !part?.text ||
      part.text.length > BODY_PART_UNITS ||
      offset + part.text.length > document.chars
    )
      throw new RunOperationConflictError('The decision source has a missing text segment.')
    offset += part.text.length
    let text = highSurrogate + part.text
    highSurrogate = ''
    if (/[\uD800-\uDBFF]/u.test(text.at(-1)!)) {
      highSurrogate = text.slice(-1)
      text = text.slice(0, -1)
    }
    if (!validBodyText(text))
      throw new RunOperationConflictError('The decision source has invalid Unicode.')
    for (let start = 0; start < text.length;) {
      check()
      let end = Math.min(text.length, start + 2048)
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
      const chunk = text.slice(start, end)
      hash.update(chunk)
      chars += chunk.length
      bytes += Buffer.byteLength(chunk)
      yield chunk
      start = end
    }
  }
  if (
    highSurrogate ||
    chars !== document.chars ||
    bytes !== document.bytes ||
    hash.digest('hex') !== document.sha256
  )
    throw new RunOperationConflictError('The complete decision source digest changed.')
}

export function planRevisionAnchorText(
  repo: ConversationRepositoryHost,
  sessionId: string,
  document: CollaborationDocument,
  check: () => void,
): string {
  let text = ''
  for (const chunk of planRevisionDocumentChunks(repo, sessionId, document, check)) text += chunk
  return text
}

/** Existing immutable carriers only. Resolving an anchor cannot seal text or read the worktree. */
export function planRevisionAnchorTarget(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
  check: () => void,
): CollaborationDocument {
  const sessionId = task.sessionId
  const message = repo.database
    .select({
      id: conversationMessages.id,
      runId: conversationMessages.runId,
      role: conversationMessages.role,
      sourceMessageId: conversationMessages.sourceMessageId,
      state: conversationMessages.state,
      revision: conversationMessages.contentRevision,
      bytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, anchor.messageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  if (!message || message.state !== 'complete')
    throw new RunOperationConflictError(
      'The complete immutable Comment target Message is unavailable.',
    )
  if (repo.workflowDecisionMessageHasImages(message.id))
    throw new RunOperationConflictError('Decision advice does not support required target images.')
  let document: CollaborationDocument | undefined
  if (isConversationBackgroundReport(message) && !anchor.plan && !anchor.report) {
    document = backgroundReportDocument(repo, sessionId, message.id)
  } else if (!message.runId) {
    throw new RunOperationConflictError(
      'The complete immutable Comment target Message is unavailable.',
    )
  } else if (anchor.plan || anchor.report) {
    document = repo.collaborationCommentDocument(sessionId, anchor)
  } else if (message.role === 'user') {
    const batch = repo.database
      .select({ body: conversationInputBatches.bodyDocumentJson })
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.runId, message.runId),
          eq(conversationInputBatches.messageId, message.id),
          eq(conversationInputBatches.sessionId, sessionId),
        ),
      )
      .limit(1)
      .get()
    if (batch?.body) document = collaborationDocumentSchema.parse(JSON.parse(batch.body))
  } else {
    const sealed = repo.database
      .select({ source: sql<string>`json_extract(${agentEventJournal.payload}, '$.source')` })
      .from(agentEventJournal)
      .where(
        and(
          eq(agentEventJournal.runId, message.runId),
          eq(agentEventJournal.eventType, 'text.body.sealed'),
          eq(agentEventJournal.sessionId, sessionId),
          sql`json_extract(${agentEventJournal.payload}, '$.source.messageId')=${message.id}`,
          sql`json_extract(${agentEventJournal.payload}, '$.source.sha256')=${anchor.contentHash}`,
        ),
      )
      .orderBy(desc(agentEventJournal.sequence))
      .limit(1)
      .get()
    if (sealed) {
      const source: unknown = JSON.parse(sealed.source)
      document = collaborationDocumentSchema.parse({
        id: Reflect.get(Object(source), 'inputId'),
        sha256: Reflect.get(Object(source), 'sha256'),
        bytes: Reflect.get(Object(source), 'bytes'),
        chars: Reflect.get(Object(source), 'chars'),
      })
      const row = repo.collaborationDocumentRow(sessionId, document)
      if (row.committedMessageId !== message.id || row.sourceRunId !== message.runId)
        throw new RunOperationConflictError('The sealed Comment target does not match its Message.')
    } else {
      const known = repo.database
        .select({ id: conversationBodyInputs.id })
        .from(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.ownerKey, `collaboration:${message.runId}`),
            eq(conversationBodyInputs.sessionId, sessionId),
            eq(conversationBodyInputs.clientMessageId, anchor.contentHash),
            eq(conversationBodyInputs.purpose, 'collaboration'),
            isNull(conversationBodyInputs.committedMessageId),
            eq(conversationBodyInputs.sourceRunId, message.runId),
            eq(conversationBodyInputs.sealed, true),
          ),
        )
        .get()
      if (known) {
        const candidate = documentReference(repo, sessionId, known.id)
        if (!planRevisionTargetAlreadyAuthorized(repo, task, candidate))
          throw new RunOperationConflictError(
            'The Comment target is outside the original revision authorization.',
          )
        if (candidate.bytes !== message.bytes || message.bytes > DECISION_INPUT_BYTES)
          throw new RunOperationConflictError(
            'The complete Comment target exceeds its decision budget.',
          )
        const hash = createHash('sha256')
        for (let offset = 0; offset < message.bytes;) {
          check()
          const part = repo.database
            .select({
              bytes: sql<Buffer>`substr(CAST(${conversationMessages.content} AS BLOB), ${offset + 1}, 8192)`,
            })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, message.id),
                eq(conversationMessages.contentRevision, message.revision),
              ),
            )
            .get()
          if (!part?.bytes.length || part.bytes.length > 8192)
            throw new RunOperationConflictError('The exact Comment target Message changed.')
          hash.update(part.bytes)
          offset += part.bytes.length
        }
        if (hash.digest('hex') !== anchor.contentHash)
          throw new RunOperationConflictError('The exact Comment target Message digest changed.')
        document = candidate
      }
    }
  }
  if (!document || document.sha256 !== anchor.contentHash)
    throw new RunOperationConflictError(
      'The complete exact-SHA Comment target source is unavailable.',
    )
  if (!planRevisionTargetAlreadyAuthorized(repo, task, document))
    throw new RunOperationConflictError(
      'The Comment target is outside the original revision authorization.',
    )
  repo.collaborationDocumentRow(sessionId, document)
  return document
}

function planRevisionTargetAlreadyAuthorized(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  document: CollaborationDocument,
): boolean {
  const refs = [
    task.taskDocument,
    task.planReference?.document,
    task.review?.document,
    task.review?.planReference?.document,
    task.review?.scopeRef,
    task.reviewScopeRef,
  ]
  return (
    refs.some((ref) => ref?.id === document.id && ref.sha256 === document.sha256) ||
    Boolean(
      repo.sourceQueries
        .earlierInputDocument()
        .get({ taskId: task.id, inputSequence: task.inputSequence, documentId: document.id }),
    )
  )
}

export interface PeerWorkspaceChangeCandidate {
  messageId: string
  sequence: number
  runId: string
  changeSetId: string
}

/** Metadata-only bounded lookup of recent unseen peer turns with active non-undone workspace changes. */
export function recentPeerWorkspaceChangeCandidates(
  repo: ConversationRepositoryHost,
  input: {
    sessionId: string
    messageIds: readonly string[]
    limit: number
    check?: () => void
  },
): PeerWorkspaceChangeCandidate[] {
  const maxItems = Math.max(0, Math.min(input.limit, 64))
  if (!maxItems || !input.messageIds.length) return []
  const seenRunIds = new Set<string>()
  const collected: PeerWorkspaceChangeCandidate[] = []
  for (let end = input.messageIds.length; end > 0 && collected.length < maxItems; end -= 256) {
    input.check?.()
    const start = Math.max(0, end - 256)
    const chunk = input.messageIds.slice(start, end)
    const rows = repo.database
      .select({
        messageId: conversationMessages.id,
        sequence: conversationMessages.sequence,
        runId: workspaceChangeSets.runId,
        changeSetId: workspaceChangeSets.id,
      })
      .from(conversationMessages)
      .innerJoin(
        workspaceChangeSets,
        and(
          eq(workspaceChangeSets.runId, conversationMessages.runId),
          eq(workspaceChangeSets.sessionId, conversationMessages.sessionId),
        ),
      )
      .where(
        and(
          eq(conversationMessages.sessionId, input.sessionId),
          inArray(conversationMessages.id, chunk),
          isNotNull(conversationMessages.runId),
          ne(workspaceChangeSets.state, 'undone'),
          gt(workspaceChangeSets.fileCount, 0),
          sql`EXISTS (
            SELECT 1 FROM workspace_file_changes f
            WHERE f.change_set_id = ${workspaceChangeSets.id}
              AND f.hidden = 0
              AND CASE
                WHEN f.native_evidence_json IS NULL THEN 1
                WHEN json_valid(f.native_evidence_json) = 1 THEN
                  CASE WHEN coalesce(json_extract(f.native_evidence_json, '$.undone'), 0) != 1 THEN 1 ELSE 0 END
                ELSE 0
              END = 1
          )`,
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(maxItems)
      .all()
    for (const row of rows) {
      if (seenRunIds.has(row.runId)) continue
      seenRunIds.add(row.runId)
      collected.push(row)
      if (collected.length >= maxItems) break
    }
  }
  return collected
}

/** Validated frozen handoff message IDs within throughSequence that carry a Side Chat origin cutoff. */
export function frozenRunHandoffMessageIdsWithOriginCutoffs(
  repo: ConversationRepositoryHost,
  runId: string,
  sessionId: string,
): string[] {
  const run = repo.database
    .select({
      id: agentRuns.id,
      userMessageId: agentRuns.userMessageId,
      handoffSourceIds: agentRuns.handoffSourceIds,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.sessionId, sessionId)))
    .get()
  if (
    !run?.handoffSourceIds ||
    Buffer.byteLength(run.handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES
  ) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(run.handoffSourceIds)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || !parsed.length) return []
  const refsById = new Map<string, number>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const refId = Reflect.get(item, 'id')
    const revision = Reflect.get(item, 'revision')
    if (
      typeof refId === 'string' &&
      typeof revision === 'number' &&
      Number.isInteger(revision) &&
      !refsById.has(refId)
    ) {
      refsById.set(refId, revision)
      if (refsById.size >= FROZEN_EXECUTION_INPUT_ITEMS) break
    }
  }
  const refIds = [...refsById.keys()]
  if (!refIds.length) return []
  const userMessage = repo.database
    .select({ sequence: conversationMessages.sequence })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, run.userMessageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  const throughSequence = userMessage?.sequence
  const matched: Array<{ id: string; sequence: number }> = []
  for (let start = 0; start < refIds.length; start += 256) {
    const chunk = refIds.slice(start, start + 256)
    const rows = repo.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        contentRevision: conversationMessages.contentRevision,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          inArray(conversationMessages.id, chunk),
          isNotNull(conversationMessages.originSideChatJson),
          ...(throughSequence !== undefined
            ? [lte(conversationMessages.sequence, throughSequence)]
            : []),
        ),
      )
      .all()
    for (const row of rows) {
      if (refsById.get(row.id) === row.contentRevision) {
        matched.push({ id: row.id, sequence: row.sequence })
      }
    }
  }
  matched.sort((left, right) => left.sequence - right.sequence)
  return matched.map((item) => item.id)
}
