import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  agentDisplayName,
  collaborationActor,
  collaborationMarkdownNodeSchema,
  collaborationNextStage,
  collaborationPlanAccepted,
  collaborationStageLabel,
  collaborationViewSchema,
  collaborationWorkflowInputBasis,
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_PAGE_ITEMS,
  CONVERSATION_PATCH_BYTES,
  CONVERSATION_PATCH_TEXT_BYTES,
  CONVERSATION_WORK_LOG_ITEMS,
  conversationPatchSchema,
  frozenSkillInvocationSchema,
  isConversationBackgroundReport,
  originSideChatSchema,
  workspaceChangeSetSchema,
  type AgentRun,
  type CollaborationDocument,
  type ConversationActivityChange,
  type ConversationGetInput,
  type ConversationMessage,
  type ConversationMessageChange,
  type ConversationObservation,
  type ConversationPage,
  type ConversationPatch,
  type ConversationSnapshot,
  type FrozenSkillInvocation,
  type NativeAgentContext,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import * as forkFacts from '../conversation-fork.js'
import {
  afterOutputOrder,
  beforeOutputOrder,
  hasArchivedBackgroundReports,
  outputRunContext,
  outputSnapshotMetadata,
  outputTimelineSql,
  parseOutputSnapshotSummary,
  type OutputTimelineItem,
} from '../conversation-output-snapshots.js'
import {
  agentEventJournal,
  agentRunActivities,
  agentRuns,
  anchoredComments,
  collaborationInputs,
  collaborationMarkdownPages,
  collaborationTasks,
  conversationInputBatches,
  conversationMessages,
  conversationOutputSnapshots,
  nativeAgentContexts,
  sessions,
  workflowTurns,
} from '../schema/index.js'
import {
  deriveSessionActivity,
  hasUnreadSessionMessage,
  projectSessionTitle,
} from '../session-projection.js'
import {
  fitsPage,
  storedReceivedMetadata,
  toActivity,
  toComment,
  toMessageRoute,
  toMessageSkills,
  toNativeContext,
  toOriginSideChat,
} from './helpers.js'
import {
  BODY_CHUNK_CHARS,
  BODY_INTERNAL_READ_BYTES,
  BODY_PREVIEW_CHARS,
  HANDOFF_PAGE_ITEMS,
  HANDOFF_SOURCE_IDS_BYTES,
  INLINE_CONTENT_BYTES,
  MAX_OBSERVED_SESSIONS,
  OversizedConversationEntityError,
  publicRunColumns,
  RunOperationConflictError,
  StaleConversationCursorError,
  visibleWorkspaceArtifact,
  type BeginRunInput,
  type BeginRunResult,
  type PatchInput,
} from './types.js'

export function metadataPatch(
  repo: ConversationRepositoryHost,
  sessionId: string,
  options: { draftsChanged?: boolean } = {},
) {
  const current = repo.database
    .select({ runId: sql<string>`json_extract(${collaborationTasks.stateJson}, '$.runId')` })
    .from(collaborationTasks)
    .where(and(eq(collaborationTasks.sessionId, sessionId), eq(collaborationTasks.active, true)))
    .get()
  const run = current && repo.findRun(current.runId)
  return createPatch(repo, sessionId, {
    runs: run ? [run] : [],
    ...(options.draftsChanged
      ? {
          comments: {
            revision: repo.database
              .select({ revision: sessions.commentsRevision })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .get()!.revision,
            upserts: [],
            removedIds: [],
          },
          resync: { messages: false, drafts: true, activityRunIds: [] },
        }
      : {}),
  })
}

function observationState(
  repo: ConversationRepositoryHost,
  sessionId: string,
): ConversationObservation {
  const existing = repo.observations.get(sessionId)
  if (existing) {
    repo.observations.delete(sessionId)
    repo.observations.set(sessionId, existing)
    return existing
  }
  const created = { incarnation: randomUUID(), sequence: 1 }
  repo.observations.set(sessionId, created)
  if (repo.observations.size > MAX_OBSERVED_SESSIONS) {
    const oldest = repo.observations.keys().next().value
    if (oldest) repo.observations.delete(oldest)
  }
  return created
}

function currentObservation(
  repo: ConversationRepositoryHost,
  sessionId: string,
): ConversationObservation {
  return observationState(repo, sessionId)
}

function nextObservation(
  repo: ConversationRepositoryHost,
  sessionId: string,
): ConversationObservation {
  const current = observationState(repo, sessionId)
  const next = { ...current, sequence: current.sequence + 1 }
  repo.observations.set(sessionId, next)
  return next
}

function requireIncarnation(
  repo: ConversationRepositoryHost,
  sessionId: string,
  incarnation: string | undefined,
): void {
  if (incarnation && incarnation !== currentObservation(repo, sessionId).incarnation) {
    throw new StaleConversationCursorError()
  }
}

/** Test/benchmark baseline only; production uses bounded pages and Patches. */
export function read(repo: ConversationRepositoryHost, sessionId: string): ConversationSnapshot {
  repo.completeReadCount += 1
  const session = repo.database.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!session) throw new Error('Session does not exist.')
  const runs = repo.database
    .select(publicRunColumns)
    .from(agentRuns)
    .where(eq(agentRuns.sessionId, sessionId))
    .orderBy(asc(agentRuns.createdAt))
    .all()
    .map((run) => toRun(repo, run))
  const messages = repo.database
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, sessionId))
    .orderBy(asc(conversationMessages.sequence))
    .all()
  const latestCompleteAssistantSequence = messages.findLast(
    (entry) =>
      entry.role === 'assistant' &&
      entry.state === 'complete' &&
      (entry.isVisible || !isConversationBackgroundReport(entry)),
  )?.sequence
  const title = projectSessionTitle(
    session.title,
    session.titleSource,
    session.parentSessionId ? 'New side chat' : 'New session',
  )
  const liveSideChatTitles = liveOriginSideChatTitles(repo, messages)
  return {
    observation: currentObservation(repo, sessionId),
    sessionId,
    session: {
      id: session.id,
      title: title.title,
      titleSource: title.titleSource,
      status: session.status,
      activity: deriveSessionActivity(session.status, runs.at(-1)),
      hasUnread: hasUnreadSessionMessage(
        session.lastSeenMessageSequence,
        latestCompleteAssistantSequence,
      ),
      updatedAt: session.updatedAt,
    },
    messages: messages.map((entry) => toMessage(repo, entry, liveSideChatTitles)),
    comments: repo.database
      .select()
      .from(anchoredComments)
      .where(eq(anchoredComments.sessionId, sessionId))
      .orderBy(asc(anchoredComments.position))
      .all()
      .map((comment) => toComment(comment)),
    commentsRevision: session.commentsRevision,
    activities: repo.database
      .select()
      .from(agentRunActivities)
      .where(eq(agentRunActivities.sessionId, sessionId))
      .orderBy(asc(agentRunActivities.sequence))
      .all()
      .map((activity) => toActivity(activity)),
    runs,
    nativeContexts: repo.database
      .select()
      .from(nativeAgentContexts)
      .where(eq(nativeAgentContexts.sessionId, sessionId))
      .orderBy(asc(nativeAgentContexts.agentId))
      .all()
      .map((context) => projectNativeContext(repo, context)),
    rebuildOperations: repo.rebuildOperations(sessionId),
    rebuildInputRecovery: repo.rebuildInputRecovery(sessionId),
    forkOperation: repo.forkOperation(sessionId),
  }
}

export function readPage(
  repo: ConversationRepositoryHost,
  input: ConversationGetInput,
): ConversationPage {
  if (input.scope === 'collaboration-quote') {
    const row = repo.collaborationDocumentRow(input.sessionId, input.document)
    if (row.sourceRunId !== input.runId)
      throw new RunOperationConflictError('The source Run changed.')
    if (
      input.startOffset < 0 ||
      input.endOffset <= input.startOffset ||
      input.endOffset - input.startOffset > 20_000 ||
      input.offset < input.startOffset ||
      input.offset >= input.endOffset
    )
      throw new RunOperationConflictError('Invalid document selection range.')
    const end = Math.min(input.endOffset, input.offset + 4096)
    const text = repo.collaborationQuote(
      input.sessionId,
      input.document,
      input.offset,
      end,
      input.basis,
    )
    return {
      scope: 'collaboration-quote',
      sessionId: input.sessionId,
      document: input.document,
      basis: input.basis,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      offset: input.offset,
      text,
      nextOffset: end < input.endOffset ? end : null,
    }
  }
  if (input.scope === 'collaboration-markdown') {
    const row = repo.collaborationDocumentRow(input.sessionId, input.document)
    if (row.sourceRunId !== input.runId)
      throw new RunOperationConflictError('The source Run changed.')
    if (input.basis === 'plain-visible-v1' || row.projectionBasis === 'plain-visible-v1') {
      let start =
        input.aroundOffset !== undefined ? Math.max(0, input.aroundOffset - 128) : input.offset
      if (
        start > 0 &&
        /[\uDC00-\uDFFF]/u.test(
          repo.collaborationRawRange(
            input.sessionId,
            input.document,
            start,
            Math.min(row.chars, start + 1),
          ),
        )
      )
        start++
      let end = Math.min(row.chars, start + 8192)
      let text = repo.collaborationRawRange(input.sessionId, input.document, start, end)
      if (end < row.chars && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) {
        text = text.slice(0, -1)
        end--
      }
      return {
        scope: 'collaboration-markdown',
        basis: 'plain-visible-v1',
        sessionId: input.sessionId,
        document: input.document,
        offset: start,
        visibleStart: start,
        visibleEnd: end,
        tree: {
          type: 'root',
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: {
                'data-pact-node-id': 0,
                'data-pact-projection-start': start,
                'data-pact-projection-end': end,
              },
              children: [{ type: 'text', value: text }],
            },
          ],
        },
        previousOffset: start ? Math.max(0, start - 8192) : null,
        nextOffset: end < row.chars ? end : null,
      }
    }
    if (row.sourceRunId !== input.runId || row.projectionPages === null)
      throw new RunOperationConflictError('The Markdown source is not ready.')
    const page = repo.database
      .select()
      .from(collaborationMarkdownPages)
      .where(
        and(
          eq(collaborationMarkdownPages.documentId, row.id),
          input.aroundOffset !== undefined
            ? and(
                lte(collaborationMarkdownPages.visibleStart, input.aroundOffset),
                gt(collaborationMarkdownPages.visibleEnd, input.aroundOffset),
              )
            : eq(collaborationMarkdownPages.ordinal, input.offset),
        ),
      )
      .orderBy(desc(collaborationMarkdownPages.visibleStart))
      .limit(1)
      .get()
    if (!page) throw new RunOperationConflictError('The Markdown page is unavailable.')
    return {
      scope: 'collaboration-markdown',
      basis: 'markdown-visible-v2',
      sessionId: input.sessionId,
      document: input.document,
      offset: page.ordinal,
      visibleStart: page.visibleStart,
      visibleEnd: page.visibleEnd,
      tree: collaborationMarkdownNodeSchema.parse(JSON.parse(page.treeJson)),
      previousOffset: page.ordinal ? page.ordinal - 1 : null,
      nextOffset: page.ordinal + 1 < row.projectionPages ? page.ordinal + 1 : null,
    }
  }
  if (input.scope === 'collaboration-text') {
    const run = repo.findRun(input.runId)
    if (!run || run.sessionId !== input.sessionId)
      throw new RunOperationConflictError('The source Run is unavailable.')
    const row = repo.collaborationDocumentRow(input.sessionId, input.document)
    if (row.sourceRunId !== input.runId)
      throw new RunOperationConflictError(
        'The document does not belong to the requested source Run.',
      )
    if (input.offset > row.chars) throw new RunOperationConflictError('Invalid document offset.')
    const parts = repo.sourceQueries.documentPart().all({
      documentId: row.id,
      offset: input.offset,
    })
    const part = parts[0]
    let text = part ? part.text.slice(input.offset - part.offset) : ''
    while (Buffer.byteLength(JSON.stringify({ text })) > 40 * 1024)
      text = text.slice(0, Math.max(1, text.length - 256))
    if (text.length && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) text = text.slice(0, -1)
    return {
      scope: 'collaboration-text',
      sessionId: input.sessionId,
      document: input.document,
      offset: input.offset,
      text,
      nextOffset: input.offset + text.length < row.chars ? input.offset + text.length : null,
    }
  }
  if (input.scope === 'collaboration') {
    const task = repo.collaboration(input.sessionId, input.runId, false)
    const active = repo.collaboration(input.sessionId)
    const requestedRunId = input.runId ?? task?.runId
    const turn = requestedRunId
      ? repo.database
          .select()
          .from(workflowTurns)
          .where(eq(workflowTurns.runId, requestedRunId))
          .get()
      : undefined
    const received = repo.receivedCollaborationInput(input.sessionId)
    const current = Boolean(task && active?.id === task.id && active.runId === requestedRunId)
    const actionable = current && !received
    const documents: Array<{ key: string; source: CollaborationDocument }> = []
    if (task?.planReference) documents.push({ key: 'plan', source: task.planReference.document })
    if (turn?.applied && turn.reportBodyId)
      documents.push({
        key: 'report',
        source: repo.documentReference(input.sessionId, turn.reportBodyId),
      })
    const planRecovery = Boolean(task && current && repo.needsWorkflowPlanRecovery(task.runId))
    const stage = task && !planRecovery ? collaborationNextStage(task) : undefined
    return {
      scope: 'collaboration',
      sessionId: input.sessionId,
      view: collaborationViewSchema.parse({
        task: task ?? null,
        accepted: task
          ? collaborationPlanAccepted(task) ||
            (task.review?.stage === 'code_review' &&
              task.review.verdict === 'accepted' &&
              task.review.inputSequence === collaborationWorkflowInputBasis(task).inputSequence &&
              task.status === 'complete')
          : false,
        reportAvailable: Boolean(turn?.applied && turn.reportBodyId),
        actionable,
        ...(task && current && !task.ending && task.status !== 'complete'
          ? { replacement: repo.collaborationReplacementProjection(task) }
          : {}),
        ...(task && actionable && !planRecovery
          ? repo.collaborationActionProjection(task)
          : { availableActions: planRecovery && actionable ? ['recover_plan'] : [] }),
        ...(planRecovery
          ? {
              planSync: {
                state: 'recovery_required',
                kind:
                  turn && repo.workflowPlanRetention(task!.runId, turn.planNativeId)
                    ? 'response'
                    : 'plan',
                runId: task!.runId,
                retainedVersion: task!.planVersion,
              },
            }
          : {}),
        ...(stage
          ? {
              nextStep:
                collaborationStageLabel(stage, task!.kind) +
                ' with ' +
                agentDisplayName(collaborationActor(task!, stage)),
            }
          : {}),
        ...(task?.planReference
          ? {
              planSource: {
                runId: task.planReference.sourceRunId,
                messageId: task.planReference.sourceMessageId,
              },
            }
          : {}),
        documents,
        ...(received && received.taskId === task?.id
          ? {
              received: {
                id: received.id,
                actor: received.actor,
                state: received.state,
                preview: received.preview,
              },
            }
          : {}),
      }),
    }
  }
  if (input.scope === 'prepared-input') return repo.readPreparedInput(input)
  if (input.scope === 'queued-input') return repo.readQueuedInputSource(input)
  if (input.scope === 'rebuild-input')
    return repo.readReturnedInput(input.sessionId, input.operationId, input.offset)
  repo.pageReadCount += 1
  // All reads in this method are synchronous on the Utility's single SQLite connection.
  // Message/Activity sequences and Comment positions never change, so keyset cursors stay
  // traversable during appends. Draft membership alone uses commentsRevision as a fence.
  const session = repo.database
    .select()
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .get()
  if (!session) throw new Error('Session does not exist.')
  const observation = currentObservation(repo, input.sessionId)

  if (input.scope === 'run-artifacts') {
    requireIncarnation(repo, input.sessionId, input.incarnation)
    const group = repo
      .readRunArtifacts(input.sessionId, [input.userMessageId])
      .find((item) => item.agentId === input.agentId)
    const latest = group?.latestRunId
      ? repo.database
          .select(publicRunColumns)
          .from(agentRuns)
          .where(eq(agentRuns.id, group.latestRunId))
          .get()
      : undefined
    const before =
      input.before ?? (latest ? { createdAt: latest.createdAt, id: latest.id } : undefined)
    const rows = !before
      ? []
      : repo.database
          .select(publicRunColumns)
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.sessionId, input.sessionId),
              eq(agentRuns.userMessageId, input.userMessageId),
              eq(agentRuns.agentId, input.agentId),
              or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
              or(
                lt(agentRuns.createdAt, before.createdAt),
                and(eq(agentRuns.createdAt, before.createdAt), lt(agentRuns.id, before.id)),
              ),
            ),
          )
          .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
          .limit(4)
          .all()
    const page: Extract<ConversationPage, { scope: 'run-artifacts' }> = {
      scope: 'run-artifacts',
      sessionId: input.sessionId,
      observation,
      userMessageId: input.userMessageId,
      agentId: input.agentId,
      totalCount: group?.totalCount ?? 0,
      runs: [],
      ...(latest ? { latestRunId: latest.id } : {}),
    }
    for (const row of rows.slice(0, 3)) {
      page.runs.push(toRun(repo, row))
      if (!fitsPage(page)) {
        page.runs.pop()
        if (!page.runs.length) throw new OversizedConversationEntityError()
        break
      }
    }
    const last = page.runs.at(-1)
    if (last && rows.length > page.runs.length)
      page.nextBefore = { createdAt: last.createdAt, id: last.id }
    if (!fitsPage(page)) throw new OversizedConversationEntityError()
    return page
  }

  if (input.scope === 'messages') {
    requireIncarnation(repo, input.sessionId, input.incarnation)
    if (
      Number(input.beforeSequence !== undefined) +
        Number(input.beforeDisplay !== undefined) +
        Number(input.aroundMessageId !== undefined) >
      1
    ) {
      throw new Error('Choose one Conversation history direction.')
    }
    let target = input.aroundMessageId
      ? repo.database
          .select({
            id: conversationMessages.id,
            sequence: conversationMessages.sequence,
            replyTo: conversationMessages.replyToMessageId,
            agentId: conversationMessages.agentId,
            visible: conversationMessages.isVisible,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.id, input.aroundMessageId),
              eq(conversationMessages.sessionId, input.sessionId),
            ),
          )
          .get()
      : undefined
    const targetSnapshot = target ? outputSnapshotMetadata(repo.database, target.id) : undefined
    const preserveRunId =
      input.preserveRunId ??
      (input.snapshotView?.mode === 'preserve' ? input.snapshotView.runId : undefined)
    if (
      preserveRunId &&
      !repo.database
        .select({ id: conversationOutputSnapshots.runId })
        .from(conversationOutputSnapshots)
        .where(
          and(
            eq(conversationOutputSnapshots.sessionId, input.sessionId),
            eq(conversationOutputSnapshots.runId, preserveRunId),
            eq(conversationOutputSnapshots.ordinal, 0),
          ),
        )
        .get()
    )
      throw new RunOperationConflictError('The preserved response is unavailable in this Session.')
    const snapshotView =
      targetSnapshot && input.includeHistoricalSource
        ? {
            runId: repo.database
              .select({ runId: conversationMessages.runId })
              .from(conversationMessages)
              .where(eq(conversationMessages.id, target!.id))
              .get()!.runId!,
            mode: 'expanded' as const,
          }
        : input.snapshotView
    if (
      snapshotView &&
      !repo.database
        .select({ runId: conversationOutputSnapshots.runId })
        .from(conversationOutputSnapshots)
        .where(
          and(
            eq(conversationOutputSnapshots.runId, snapshotView.runId),
            eq(conversationOutputSnapshots.sessionId, input.sessionId),
          ),
        )
        .limit(1)
        .get()
    )
      throw new Error('The selected output snapshots are unavailable.')
    if (
      target &&
      !targetSnapshot &&
      !target.visible &&
      !input.includeHistoricalSource &&
      target.replyTo
    ) {
      target = repo.database
        .select({
          id: conversationMessages.id,
          sequence: conversationMessages.sequence,
          replyTo: conversationMessages.replyToMessageId,
          agentId: conversationMessages.agentId,
          visible: conversationMessages.isVisible,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.replyToMessageId, target.replyTo),
            eq(conversationMessages.role, 'assistant'),
            ...(target.agentId ? [eq(conversationMessages.agentId, target.agentId)] : []),
            eq(conversationMessages.isVisible, true),
          ),
        )
        .get()
    }
    const targetSequence = target?.sequence
    if (input.aroundMessageId && targetSequence === undefined) {
      throw new Error('The selected Message is unavailable.')
    }
    // For a direct Comment jump, admit the target first. Filling context before the
    // target could exhaust the byte budget and return a page that never contains it.
    const goingNewer = targetSequence !== undefined
    const legacy = !repo.database
      .select({ runId: conversationOutputSnapshots.runId })
      .from(conversationOutputSnapshots)
      .where(eq(conversationOutputSnapshots.sessionId, input.sessionId))
      .limit(1)
      .get()
    const archivedBackground = hasArchivedBackgroundReports(repo.database, input.sessionId)
    const timelineFor = (filter: ReturnType<typeof sql>, newer: boolean) =>
      outputTimelineSql(input.sessionId, snapshotView, {
        filter,
        newer,
        legacy,
        preserveRunId,
        archivedBackground,
      })
    const snapshotOrder = target
      ? outputSnapshotMetadata(repo.database, target.id, snapshotView, preserveRunId)?.order
      : undefined
    const targetOrder = target
      ? (snapshotOrder ?? { sequence: target.sequence, rank: 1, id: target.id })
      : undefined
    const oldHistoricalSource =
      target && input.includeHistoricalSource && !targetSnapshot ? target : undefined
    const directionCondition = input.beforeDisplay
      ? beforeOutputOrder(input.beforeDisplay)
      : input.beforeSequence !== undefined
        ? sql`sequence<${input.beforeSequence}`
        : targetOrder
          ? afterOutputOrder({ ...targetOrder, id: targetOrder.id }, true)
          : targetSequence !== undefined
            ? sql`sequence>=${targetSequence}`
            : sql`1=1`
    const pageCondition = oldHistoricalSource
      ? sql`${directionCondition} AND id<>${oldHistoricalSource.id}
        AND (kind='context' OR id NOT IN (SELECT id FROM conversation_messages
          WHERE reply_to_message_id=${oldHistoricalSource.replyTo} AND agent_id=${oldHistoricalSource.agentId}))`
      : directionCondition
    const timeline = timelineFor(pageCondition, goingNewer)
    const timelineItems = repo.database.all<OutputTimelineItem>(sql`${timeline}
        SELECT * FROM timeline WHERE ${pageCondition}
        ORDER BY sequence ${goingNewer ? sql`ASC` : sql`DESC`}, rank ${goingNewer ? sql`ASC` : sql`DESC`},
          id ${goingNewer ? sql`ASC` : sql`DESC`} LIMIT ${CONVERSATION_PAGE_ITEMS + 1}`)
    const messageQuery = () =>
      repo.database
        .select({
          id: conversationMessages.id,
          sessionId: conversationMessages.sessionId,
          runId: conversationMessages.runId,
          isVisible: conversationMessages.isVisible,
          replyToMessageId: conversationMessages.replyToMessageId,
          role: conversationMessages.role,
          agentId: conversationMessages.agentId,
          routeKind: conversationMessages.routeKind,
          routeAgentsJson: conversationMessages.routeAgentsJson,
          routePendingAgentId: conversationMessages.routePendingAgentId,
          sourceMessageId: conversationMessages.sourceMessageId,
          originSideChatJson: conversationMessages.originSideChatJson,
          skillsJson: sql<
            string | null
          >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
          state: conversationMessages.state,
          sequence: conversationMessages.sequence,
          createdAt: conversationMessages.createdAt,
          updatedAt: conversationMessages.updatedAt,
          contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
          contentRevision: conversationMessages.contentRevision,
          // The outer column must remain qualified: a raw interpolated column here
          // renders unqualified and SQLite resolves it against the inner table.
          hasActivities: sql<number>`EXISTS (SELECT 1 FROM agent_run_activities a WHERE a.run_id = "conversation_messages"."run_id" LIMIT 1)`,
          hasComments: sql<number>`EXISTS (SELECT 1 FROM anchored_comments c WHERE c.sent_with_message_id = "conversation_messages"."id" LIMIT 1)`,
          content: sql<string>`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${INLINE_CONTENT_BYTES} THEN ${conversationMessages.content} ELSE substr(${conversationMessages.content}, 1, ${BODY_PREVIEW_CHARS}) END`,
        })
        .from(conversationMessages)
    const messageIds = timelineItems
      .filter((item) => item.kind === 'message')
      .map((item) => item.id)
    const candidateMap = new Map(
      (messageIds.length
        ? messageQuery().where(inArray(conversationMessages.id, messageIds)).all()
        : []
      ).map((row) => [row.id, row]),
    )
    const candidates = timelineItems.flatMap((item) =>
      item.kind === 'message' && candidateMap.has(item.id) ? [candidateMap.get(item.id)!] : [],
    )
    if (oldHistoricalSource) {
      // Read an old source by primary key separately so hidden retries cannot
      // turn around-navigation into a scan of every superseded response.
      const source = messageQuery().where(eq(conversationMessages.id, oldHistoricalSource.id)).get()
      if (source) {
        candidates.unshift(source)
        candidateMap.set(source.id, source)
        timelineItems.unshift({
          id: source.id,
          kind: 'message',
          runId: source.runId,
          sequence: source.sequence,
          rank: 1,
        })
      }
    }
    const latestRunRow = repo.database
      .select(publicRunColumns)
      .from(agentRuns)
      .where(and(eq(agentRuns.sessionId, input.sessionId), isNull(agentRuns.forkSourceRunId)))
      .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    const latestRun = latestRunRow ? toRun(repo, latestRunRow) : undefined
    const latestCompleteAssistantSequence = repo.database
      .select({ value: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, input.sessionId),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.state, 'complete'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .get()?.value
    const title = projectSessionTitle(
      session.title,
      session.titleSource,
      session.parentSessionId ? 'New side chat' : 'New session',
    )
    const receivedInput = repo.receivedCollaborationInput(input.sessionId)
    const header: Extract<ConversationPage, { scope: 'messages' }>['header'] = {
      queue: repo.queueState(input.sessionId),
      ...(receivedInput ? { receivedInputIds: [receivedInput.id] } : {}),
      session: {
        id: session.id,
        title: title.title,
        titleSource: title.titleSource,
        status: session.status,
        activity: deriveSessionActivity(session.status, latestRun),
        hasUnread: hasUnreadSessionMessage(
          session.lastSeenMessageSequence,
          latestCompleteAssistantSequence ?? undefined,
        ),
        updatedAt: session.updatedAt,
      },
      commentsRevision: session.commentsRevision,
      nativeContexts: repo.nativeContexts(input.sessionId),
      rebuildOperations: repo.rebuildOperations(input.sessionId),
      rebuildInputRecovery: repo.rebuildInputRecovery(input.sessionId),
      forkOperation: repo.forkOperation(input.sessionId),
      ...(latestRun ? { latestRun } : {}),
      ...(latestCompleteAssistantSequence === null || latestCompleteAssistantSequence === undefined
        ? {}
        : { latestCompleteAssistantSequence }),
    }
    const page: Extract<ConversationPage, { scope: 'messages' }> = {
      scope: 'messages',
      sessionId: input.sessionId,
      observation,
      header,
      messages: [],
      runContexts: [],
      ...(snapshotView ? { snapshotView } : {}),
      ...(preserveRunId ? { preserveRunId } : {}),
      runs: [],
      runArtifacts: [],
      hasOlder: false,
      hasNewer: false,
      ...(target && input.includeHistoricalSource ? { sourceMessageId: target.id } : {}),
    }
    const candidateRunIds = [
      ...new Set(timelineItems.flatMap((candidate) => (candidate.runId ? [candidate.runId] : []))),
    ]
    const candidateRuns = new Map(
      (candidateRunIds.length === 0
        ? []
        : repo.database
            .select(publicRunColumns)
            .from(agentRuns)
            .where(inArray(agentRuns.id, candidateRunIds))
            .all()
      ).map((run) => [run.id, run]),
    )
    const candidateArtifacts = repo.readRunArtifacts(input.sessionId, [
      ...new Set(candidates.map((candidate) => candidate.replyToMessageId ?? candidate.id)),
    ])
    const artifactRuns = new Map(
      candidateArtifacts.map((group) => {
        const row = repo.database
          .select(publicRunColumns)
          .from(agentRuns)
          .where(eq(agentRuns.id, group.latestRunId))
          .get()
        return [group.latestRunId, row] as const
      }),
    )
    const candidateImages = repo.imagesForMessages(candidates.map((row) => row.id))
    const liveSideChatTitles = liveOriginSideChatTitles(repo, candidates)
    const runIds = new Set<string>()
    const admitted: OutputTimelineItem[] = []
    for (const item of timelineItems.slice(0, CONVERSATION_PAGE_ITEMS)) {
      if (item.kind === 'context') {
        const context = outputRunContext(repo.database, item.id)!
        const candidate = candidateRuns.get(item.id)
        const addRun = candidate && !runIds.has(item.id)
        page.runContexts!.push(context)
        if (addRun) page.runs.push(toRun(repo, candidate))
        if (page.runs.length > CONVERSATION_PAGE_ITEMS || !fitsPage(page)) {
          page.runContexts!.pop()
          if (addRun) page.runs.pop()
          if (!admitted.length) throw new OversizedConversationEntityError()
          break
        }
        if (addRun) runIds.add(item.id)
        admitted.push(item)
        continue
      }
      const row = candidateMap.get(item.id)!
      const previousRuns = [...page.runs]
      const previousArtifacts = [...page.runArtifacts!]
      const projectedMessage = {
        outputSnapshot: outputSnapshotMetadata(repo.database, row.id, snapshotView, preserveRunId),
        id: row.id,
        sessionId: row.sessionId,
        role: row.role,
        state: row.state,
        sequence: row.sequence,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        contentRevision: row.contentRevision,
        ...(candidateImages.get(row.id)?.length ? { images: candidateImages.get(row.id)! } : {}),
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
        ...(!row.isVisible && isConversationBackgroundReport(row)
          ? { historicalBackgroundReport: true as const }
          : {}),
        ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
        ...toMessageRoute(row),
        ...toMessageSkills(row),
        ...toOriginSideChat(row, liveSideChatTitles),
      }
      const pageMessage =
        row.contentBytes > INLINE_CONTENT_BYTES
          ? ({
              kind: 'oversized',
              message: projectedMessage,
              contentBytes: row.contentBytes,
              preview: row.content,
              previewChars: Array.from(row.content).length,
              hasActivities: Boolean(row.hasActivities),
              hasComments: Boolean(row.hasComments),
            } as const)
          : ({
              kind: 'complete',
              message: { ...projectedMessage, content: row.content },
              hasActivities: Boolean(row.hasActivities),
              hasComments: Boolean(row.hasComments),
            } as const)
      const candidateRun =
        row.runId && !runIds.has(row.runId) ? candidateRuns.get(row.runId) : undefined
      page.messages.push(pageMessage)
      if (candidateRun) {
        const runSummary = toRun(repo, candidateRun)
        delete runSummary.failureMessage
        page.runs.push(runSummary)
        runIds.add(candidateRun.id)
      }
      const userId = row.replyToMessageId ?? row.id
      for (const group of candidateArtifacts.filter(
        (artifact) => artifact.userMessageId === userId,
      )) {
        if (page.runArtifacts!.some((artifact) => artifact.latestRunId === group.latestRunId))
          continue
        page.runArtifacts!.push(group)
        const latest = artifactRuns.get(group.latestRunId)
        if (latest && !runIds.has(latest.id)) {
          const summary = toRun(repo, latest)
          delete summary.failureMessage
          page.runs.push(summary)
          runIds.add(latest.id)
        }
      }
      if (page.runs.length > CONVERSATION_PAGE_ITEMS || !fitsPage(page)) {
        // A rejected candidate is not passed by the cursor. The caller can retry it on
        // the next page, and a first-item failure is visible instead of an empty loop.
        page.messages.pop()
        page.runs = previousRuns
        page.runArtifacts = previousArtifacts
        runIds.clear()
        for (const run of previousRuns) runIds.add(run.id)
        if (admitted.length === 0) throw new OversizedConversationEntityError()
        break
      }
      admitted.push(item)
    }
    if (!goingNewer) {
      page.messages.reverse()
      page.runContexts!.reverse()
      admitted.reverse()
    }
    const first = admitted[0]
    const last = admitted.at(-1)
    page.hasOlder =
      first !== undefined &&
      Boolean(
        repo.database.get(
          sql`${timelineFor(beforeOutputOrder(first), false)} SELECT id FROM timeline WHERE ${beforeOutputOrder(first)} LIMIT 1`,
        ),
      )
    page.hasNewer =
      last !== undefined &&
      Boolean(
        repo.database.get(
          sql`${timelineFor(afterOutputOrder(last), true)} SELECT id FROM timeline WHERE ${afterOutputOrder(last)} LIMIT 1`,
        ),
      )
    if (!fitsPage(page)) throw new OversizedConversationEntityError()
    if (target && input.includeHistoricalSource && !target.visible) page.hasNewer = true
    return page
  }

  if (input.scope === 'activity-body') {
    const source = repo.database
      .select({
        revision: agentRunActivities.detailRevision,
        chars: sql<number>`length(${agentRunActivities.detail})`,
        text: sql<string>`substr(${agentRunActivities.detail}, ${input.offset + 1}, ${BODY_CHUNK_CHARS})`,
      })
      .from(agentRunActivities)
      .where(
        and(
          eq(agentRunActivities.id, input.activityId),
          eq(agentRunActivities.sessionId, input.sessionId),
        ),
      )
      .get()
    if (!source) throw new Error('The selected Conversation item is unavailable.')
    if (source.revision !== input.detailRevision) throw new StaleConversationCursorError()
    if (input.offset > (source.chars ?? 0)) throw new Error('Body offset is invalid.')
    const nextOffset = input.offset + Array.from(source.text ?? '').length
    const page: Extract<ConversationPage, { scope: 'activity-body' }> = {
      scope: 'activity-body',
      sessionId: input.sessionId,
      observation,
      activityId: input.activityId,
      detailRevision: input.detailRevision,
      offset: input.offset,
      text: source.text ?? '',
      ...(nextOffset < (source.chars ?? 0) ? { nextOffset } : {}),
    }
    if (!fitsPage(page)) throw new OversizedConversationEntityError()
    return page
  }

  if (input.scope === 'drafts' || input.scope === 'comments') {
    if (
      input.scope === 'drafts' &&
      input.expectedRevision !== undefined &&
      input.expectedRevision !== session.commentsRevision
    ) {
      throw new StaleConversationCursorError()
    }
    const rows = repo.database
      .select()
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, input.sessionId),
          input.scope === 'drafts'
            ? sql`${anchoredComments.sentWithMessageId} IS NULL AND ${anchoredComments.pendingReceiptId} IS NULL`
            : inArray(anchoredComments.sentWithMessageId, input.messageIds),
          input.afterPosition === undefined
            ? undefined
            : gt(anchoredComments.position, input.afterPosition),
        ),
      )
      .orderBy(asc(anchoredComments.position))
      .limit(CONVERSATION_PAGE_ITEMS + 1)
      .all()
    const page: Extract<ConversationPage, { scope: 'drafts' | 'comments' }> =
      input.scope === 'drafts'
        ? {
            scope: 'drafts',
            sessionId: input.sessionId,
            observation,
            commentsRevision: session.commentsRevision,
            comments: [],
            hasMore: false,
          }
        : {
            scope: 'comments',
            sessionId: input.sessionId,
            observation,
            comments: [],
            hasMore: false,
          }
    for (const row of rows.slice(0, CONVERSATION_PAGE_ITEMS)) {
      page.comments.push(toComment(row))
      if (!fitsPage(page)) {
        page.comments.pop()
        if (page.comments.length === 0) throw new OversizedConversationEntityError()
        break
      }
    }
    page.hasMore = rows.length > page.comments.length
    return page
  }

  const rows = repo.database
    .select({
      id: agentRunActivities.id,
      sessionId: agentRunActivities.sessionId,
      runId: agentRunActivities.runId,
      agentId: agentRunActivities.agentId,
      nativeId: agentRunActivities.nativeId,
      kind: agentRunActivities.kind,
      toolName: agentRunActivities.toolName,
      title: agentRunActivities.title,
      status: agentRunActivities.status,
      sequence: agentRunActivities.sequence,
      createdAt: agentRunActivities.createdAt,
      updatedAt: agentRunActivities.updatedAt,
      detailRevision: agentRunActivities.detailRevision,
      detailBytes: sql<number>`length(CAST(${agentRunActivities.detail} AS BLOB))`,
      detail: sql<
        string | null
      >`CASE WHEN length(CAST(${agentRunActivities.detail} AS BLOB)) <= ${INLINE_CONTENT_BYTES} THEN ${agentRunActivities.detail} ELSE substr(${agentRunActivities.detail}, 1, ${BODY_PREVIEW_CHARS}) END`,
    })
    .from(agentRunActivities)
    .where(
      and(
        eq(agentRunActivities.sessionId, input.sessionId),
        eq(agentRunActivities.runId, input.runId),
      ),
    )
    .orderBy(desc(agentRunActivities.sequence))
    .limit(CONVERSATION_WORK_LOG_ITEMS + 1)
    .all()
  const page: Extract<ConversationPage, { scope: 'activities' }> = {
    scope: 'activities',
    sessionId: input.sessionId,
    observation,
    runId: input.runId,
    activities: [],
    truncated: false,
  }
  for (const row of rows.slice(0, CONVERSATION_WORK_LOG_ITEMS)) {
    const activity = toActivity({ ...row, detail: row.detail })
    const activityWithoutDetail = { ...activity }
    delete activityWithoutDetail.detail
    page.activities.push(
      row.detailBytes > INLINE_CONTENT_BYTES
        ? {
            kind: 'oversized',
            activity: activityWithoutDetail,
            detailBytes: row.detailBytes,
            preview: row.detail ?? '',
            previewChars: Array.from(row.detail ?? '').length,
          }
        : { kind: 'complete', activity },
    )
    if (!fitsPage(page)) {
      page.activities.pop()
      if (page.activities.length === 0) throw new OversizedConversationEntityError()
      break
    }
  }
  page.activities.reverse()
  page.truncated = rows.length > page.activities.length
  return page
}

export function message(
  repo: ConversationRepositoryHost,
  messageId: string,
  sessionId: string,
): ConversationMessage | undefined {
  const row = repo.database
    .select({
      id: conversationMessages.id,
      sessionId: conversationMessages.sessionId,
      runId: conversationMessages.runId,
      replyToMessageId: conversationMessages.replyToMessageId,
      role: conversationMessages.role,
      agentId: conversationMessages.agentId,
      routeKind: conversationMessages.routeKind,
      routeAgentsJson: conversationMessages.routeAgentsJson,
      routePendingAgentId: conversationMessages.routePendingAgentId,
      sourceMessageId: conversationMessages.sourceMessageId,
      originSideChatJson: conversationMessages.originSideChatJson,
      skillsJson: sql<
        string | null
      >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
      state: conversationMessages.state,
      sequence: conversationMessages.sequence,
      createdAt: conversationMessages.createdAt,
      updatedAt: conversationMessages.updatedAt,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      contentRevision: conversationMessages.contentRevision,
      content: sql<
        string | null
      >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${CONVERSATION_MARKDOWN_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
    })
    .from(conversationMessages)
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
    )
    .get()
  if (!row) return undefined
  if (row.content === null) throw new OversizedConversationEntityError()
  return toMessage(repo, { ...row, content: row.content })
}

/** Internal consumers may hydrate one complete body within the existing 8 MiB work budget. */
export function internalMessage(
  repo: ConversationRepositoryHost,
  messageId: string,
  sessionId: string,
): ConversationMessage | undefined {
  const row = repo.database
    .select({
      ...getTableColumns(conversationMessages),
      content: sql<
        string | null
      >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
    })
    .from(conversationMessages)
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
    )
    .get()
  if (!row) return undefined
  if (row.content === null)
    throw new RunOperationConflictError(
      'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
    )
  return toMessage(repo, { ...row, content: row.content })
}

export function messageMetadata(
  repo: ConversationRepositoryHost,
  messageId: string,
  sessionId: string,
): { contentRevision: number; contentBytes: number } | undefined {
  return repo.database
    .select({
      contentRevision: conversationMessages.contentRevision,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
    })
    .from(conversationMessages)
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
    )
    .get()
}

function sessionProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  latestRun: AgentRun | undefined,
): ConversationSnapshot['session'] {
  const session = repo.sourceQueries.session().get({ sessionId })
  if (!session) throw new Error('Session does not exist.')
  const latestCompleteAssistantSequence = repo.sourceQueries
    .latestCompleteVisibleSequence()
    .get({ sessionId })?.value
  const title = projectSessionTitle(
    session.title,
    session.titleSource,
    session.parentSessionId ? 'New side chat' : 'New session',
  )
  return {
    id: session.id,
    title: title.title,
    titleSource: title.titleSource,
    status: session.status,
    activity: forkFacts.forkBlocksInput(repo.database, sessionId)
      ? { state: 'error' as const }
      : deriveSessionActivity(session.status, latestRun),
    hasUnread: hasUnreadSessionMessage(
      session.lastSeenMessageSequence,
      latestCompleteAssistantSequence ?? undefined,
    ),
    updatedAt: session.updatedAt,
  }
}

export function messageChange(
  repo: ConversationRepositoryHost,
  messageId: string,
  requestedMode: ConversationMessageChange['mode'],
  text?: string,
  previousRevision?: number,
): ConversationMessageChange {
  const readReplacement = requestedMode === 'replace' && text === undefined
  const row = repo.database
    .select({
      id: conversationMessages.id,
      sessionId: conversationMessages.sessionId,
      runId: conversationMessages.runId,
      isVisible: conversationMessages.isVisible,
      replyToMessageId: conversationMessages.replyToMessageId,
      role: conversationMessages.role,
      agentId: conversationMessages.agentId,
      routeKind: conversationMessages.routeKind,
      routeAgentsJson: conversationMessages.routeAgentsJson,
      routePendingAgentId: conversationMessages.routePendingAgentId,
      sourceMessageId: conversationMessages.sourceMessageId,
      originSideChatJson: conversationMessages.originSideChatJson,
      skillsJson: sql<
        string | null
      >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
      contentRevision: conversationMessages.contentRevision,
      state: conversationMessages.state,
      sequence: conversationMessages.sequence,
      createdAt: conversationMessages.createdAt,
      updatedAt: conversationMessages.updatedAt,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      replacementText: sql<string | null>`CASE WHEN ${readReplacement ? 1 : 0} = 1 AND
          length(CAST(${conversationMessages.content} AS BLOB)) <= ${CONVERSATION_PATCH_TEXT_BYTES}
          THEN ${conversationMessages.content} ELSE NULL END`,
      hasActivities: sql<number>`EXISTS (SELECT 1 FROM agent_run_activities a WHERE a.run_id = "conversation_messages"."run_id" LIMIT 1)`,
      hasComments: sql<number>`EXISTS (SELECT 1 FROM anchored_comments c WHERE c.sent_with_message_id = "conversation_messages"."id" LIMIT 1)`,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .get()
  if (!row) throw new Error('Conversation Message does not exist.')
  const replacement = text ?? (readReplacement ? (row.replacementText ?? undefined) : undefined)
  const mode =
    (readReplacement && row.contentBytes > CONVERSATION_PATCH_TEXT_BYTES) ||
    (replacement !== undefined &&
      Buffer.byteLength(replacement, 'utf8') > CONVERSATION_PATCH_TEXT_BYTES)
      ? requestedMode === 'append'
        ? 'advance'
        : 'invalidate'
      : requestedMode
  const liveSideChatTitles = liveOriginSideChatTitles(repo, [row])
  return {
    message: {
      outputSnapshot: outputSnapshotMetadata(repo.database, row.id),
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      contentRevision: row.contentRevision,
      ...repo.messageImageMetadata(row.id),
      state: row.state,
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.runId ? { runId: row.runId } : {}),
      ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
      ...(!row.isVisible && isConversationBackgroundReport(row)
        ? { historicalBackgroundReport: true as const }
        : {}),
      ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
      ...toMessageRoute(row),
      ...toMessageSkills(row),
      ...toOriginSideChat(row, liveSideChatTitles),
    },
    mode,
    ...(mode === 'replace' || mode === 'append' ? { text: replacement ?? '' } : {}),
    ...((mode === 'append' || mode === 'advance') && previousRevision !== undefined
      ? { previousRevision }
      : {}),
    contentBytes: row.contentBytes,
    hasActivities: Boolean(row.hasActivities),
    hasComments: Boolean(row.hasComments),
  }
}

export function activityChange(
  repo: ConversationRepositoryHost,
  activityId: string,
  requestedMode: ConversationActivityChange['mode'],
  detail?: string,
  previousRevision?: number,
): ConversationActivityChange {
  const row = repo.database
    .select()
    .from(agentRunActivities)
    .where(eq(agentRunActivities.id, activityId))
    .get()
  if (!row) throw new Error('Conversation Activity does not exist.')
  const mode =
    detail !== undefined && Buffer.byteLength(detail, 'utf8') > CONVERSATION_PATCH_TEXT_BYTES
      ? requestedMode === 'append'
        ? 'advance'
        : 'invalidate'
      : requestedMode
  const activity = toActivity(row)
  const { detail: _detail, ...metadata } = activity
  return {
    activity: metadata,
    mode,
    ...(mode === 'replace' || mode === 'append' ? { detail: detail ?? '' } : {}),
    ...((mode === 'append' || mode === 'advance') && previousRevision !== undefined
      ? { previousRevision }
      : {}),
    detailBytes: row.detail ? Buffer.byteLength(row.detail, 'utf8') : 0,
  }
}

export function createPatch(
  repo: ConversationRepositoryHost,
  sessionId: string,
  input: PatchInput = {},
): ConversationPatch {
  repo.patchCount += 1
  const observation = nextObservation(repo, sessionId)
  const latestRunRow = repo.sourceQueries.latestEligibleRun().get({ sessionId })
  const latestRun = latestRunRow ? toRun(repo, latestRunRow) : undefined
  const latestRunId = latestRun?.id
  const received = repo.database
    .select({ id: collaborationInputs.id })
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.sessionId, sessionId),
        inArray(collaborationInputs.state, ['accepted', 'blocked']),
      ),
    )
    .get()
  const patch: ConversationPatch = {
    version: 'conversation-patch-v1',
    ...(input.runContexts ? { runContexts: input.runContexts } : {}),
    queue: repo.queueState(sessionId),
    ...(input.receivedInputIds
      ? { receivedInputIds: input.receivedInputIds }
      : received
        ? { receivedInputIds: [received.id] }
        : {}),
    ...(input.queuedInputIds?.length ? { queuedInputIds: input.queuedInputIds } : {}),
    sessionId,
    observation,
    session: sessionProjection(repo, sessionId, latestRun),
    messages: input.messages ?? [],
    ...(input.removedMessageIds?.length ? { removedMessageIds: input.removedMessageIds } : {}),
    runs: input.runs ?? [],
    ...(latestRunId ? { latestRunId } : {}),
    activities: input.activities ?? [],
    activityStates: input.activityStates ?? [],
    nativeContexts: repo.nativeContexts(sessionId),
    rebuildOperations: repo.rebuildOperations(sessionId),
    rebuildInputRecovery: repo.rebuildInputRecovery(sessionId),
    forkOperation: repo.forkOperation(sessionId),
    ...(input.comments ? { comments: input.comments } : {}),
    ...(input.commentDraftReceipt ? { commentDraftReceipt: input.commentDraftReceipt } : {}),
    ...(input.resync ? { resync: input.resync } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(patch), 'utf8') <= CONVERSATION_PATCH_BYTES) {
    return conversationPatchSchema.parse(patch)
  }

  return conversationPatchSchema.parse({
    version: 'conversation-patch-v1',
    ...(patch.runContexts ? { runContexts: patch.runContexts } : {}),
    sessionId,
    observation,
    session: patch.session,
    queue: patch.queue,
    ...(patch.receivedInputIds ? { receivedInputIds: patch.receivedInputIds } : {}),
    ...(patch.queuedInputIds ? { queuedInputIds: patch.queuedInputIds } : {}),
    messages: [],
    runs: patch.runs.slice(0, 4).map((run) => {
      const { failureMessage: _failureMessage, ...bounded } = run
      return bounded
    }),
    ...(patch.latestRunId ? { latestRunId: patch.latestRunId } : {}),
    activities: [],
    activityStates: patch.activityStates,
    nativeContexts: patch.nativeContexts,
    rebuildOperations: patch.rebuildOperations,
    rebuildInputRecovery: patch.rebuildInputRecovery,
    forkOperation: patch.forkOperation,
    ...(patch.commentDraftReceipt ? { commentDraftReceipt: patch.commentDraftReceipt } : {}),
    ...(patch.comments
      ? {
          comments: {
            revision: patch.comments.revision,
            upserts: [],
            removedIds: [],
          },
        }
      : {}),
    resync: {
      messages:
        patch.messages.length > 0 || patch.runs.length > 0 || Boolean(input.resync?.messages),
      drafts: Boolean(patch.comments) || Boolean(input.resync?.drafts),
      activityRunIds: [
        ...new Set([
          ...patch.activities.map((change) => change.activity.runId),
          ...(input.resync?.activityRunIds ?? []),
        ]),
      ].slice(0, 4),
    },
  })
}

export function diagnostics(repo: ConversationRepositoryHost): {
  completeReads: number
  pageReads: number
  patches: number
  observedSessions: number
  eventTransactions: number
  streamLookups: {
    text: { queries: number; returnedRows: number }
    activity: { queries: number; returnedRows: number }
  }
} {
  return {
    completeReads: repo.completeReadCount,
    pageReads: repo.pageReadCount,
    patches: repo.patchCount,
    observedSessions: repo.observations.size,
    eventTransactions: repo.eventTransactionCount,
    streamLookups: {
      text: { ...repo.streamLookups.text },
      activity: { ...repo.streamLookups.activity },
    },
  }
}

export function skillInvocation(
  repo: ConversationRepositoryHost,
  messageId: string,
): FrozenSkillInvocation | undefined {
  const row = repo.database
    .select({ json: conversationMessages.skillInvocationJson })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .get()
  return row?.json ? frozenSkillInvocationSchema.parse(JSON.parse(row.json)) : undefined
}

export function submittedRunReceipt(
  repo: ConversationRepositoryHost,
  input: Pick<
    BeginRunInput,
    | 'sessionId'
    | 'clientMessageId'
    | 'content'
    | 'commentIds'
    | 'expectedCommentsRevision'
    | 'skills'
    | 'route'
    | 'imageIds'
    | 'batchId'
    | 'freezeDrafts'
    | 'preserveDraftComments'
    | 'receivedInputId'
    | 'replyToDecision'
    | 'replaceTask'
    | 'userInformation'
  >,
): BeginRunResult | undefined {
  const existingMessage = repo.database
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.id, input.clientMessageId))
    .get()
  if (!existingMessage) return undefined
  if (
    existingMessage.sessionId !== input.sessionId ||
    existingMessage.role !== 'user' ||
    existingMessage.content !== input.content ||
    JSON.stringify(repo.imagesForMessage(existingMessage.id).map((image) => image.id)) !==
      JSON.stringify(input.imageIds ?? []) ||
    JSON.stringify(
      existingMessage.skillInvocationJson
        ? frozenSkillInvocationSchema.parse(JSON.parse(existingMessage.skillInvocationJson))
            .selections
        : [],
    ) !== JSON.stringify(input.skills ?? []) ||
    !existingMessage.runId
  ) {
    throw new RunOperationConflictError(
      'This message ID is already associated with different content.',
    )
  }
  const savedRoute = toMessageRoute(existingMessage)?.route
  if (
    input.route?.type === 'agent' &&
    (savedRoute?.type !== 'agent' || savedRoute.agentId !== input.route.agentId)
  )
    throw new RunOperationConflictError('This message ID has a different Agent target.')
  if (input.route?.type === 'primary' && savedRoute?.type !== 'primary')
    throw new RunOperationConflictError('This message ID has a different Agent target.')
  if (input.route?.type === 'all' && savedRoute?.type !== 'all')
    throw new RunOperationConflictError('This message ID has a different Agent target.')
  const existingRun = repo.findRun(existingMessage.runId)
  if (!existingRun) throw new Error('The existing message has no Agent Run.')
  const batch = repo.inputBatchForMessage(input.sessionId, existingMessage.id)
  if (!batch) throw new RunOperationConflictError('The original input Batch is unavailable.')
  const batchRow = repo.database
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, batch.id))
    .get()!
  if (!isDeepStrictEqual(repo.userInformation(batchRow)?.declaration, input.userInformation))
    throw new RunOperationConflictError('This message ID has a different user declaration.')
  const receipt = repo.database
    .select({
      freeze: sql<number | null>`json_extract(${agentEventJournal.payload},'$.freezeDrafts')`,
      decision: sql<string | null>`json_extract(${agentEventJournal.payload},'$.replyToDecision')`,
      replacement: sql<string | null>`json_extract(${agentEventJournal.payload},'$.replaceTask')`,
    })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, existingRun.id),
        eq(agentEventJournal.eventType, 'user.message'),
      ),
    )
    .limit(1)
    .get()
  const requestedFreeze = input.receivedInputId
    ? (storedReceivedMetadata(
        repo.database
          .select({ json: collaborationInputs.metadataJson })
          .from(collaborationInputs)
          .where(eq(collaborationInputs.id, input.receivedInputId))
          .get()!.json,
      ).freezeDrafts ?? true)
    : (input.freezeDrafts ?? !input.preserveDraftComments)
  if (
    batch.id !== (input.batchId ?? input.clientMessageId) ||
    Boolean(receipt?.freeze) !== requestedFreeze ||
    !isDeepStrictEqual(
      receipt?.decision ? JSON.parse(receipt.decision) : undefined,
      input.replyToDecision,
    ) ||
    !isDeepStrictEqual(
      receipt?.replacement ? JSON.parse(receipt.replacement) : undefined,
      input.replaceTask,
    )
  )
    throw new RunOperationConflictError(
      'This message nonce has a different Batch or draft-freeze intent.',
    )
  const commentsRevision =
    repo.database
      .select({ value: sessions.commentsRevision })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()?.value ?? input.expectedCommentsRevision
  return {
    run: existingRun,
    patch: createPatch(repo, input.sessionId, {
      resync: { messages: false, drafts: true, activityRunIds: [] },
      messages: [messageChange(repo, existingMessage.id, 'replace', existingMessage.content)],
      runs: [existingRun],
      comments: {
        revision: commentsRevision,
        upserts: [],
        removedIds: [],
      },
    }),
    created: false,
  }
}

export function runPatch(repo: ConversationRepositoryHost, runId: string): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The task is unavailable.')
  return createPatch(repo, run.sessionId, { runs: [run] })
}

export function contextPatch(
  repo: ConversationRepositoryHost,
  sessionId: string,
): ConversationPatch {
  return createPatch(repo, sessionId)
}

function liveOriginSideChatTitles(
  repo: ConversationRepositoryHost,
  rows: ReadonlyArray<{ originSideChatJson?: string | null }>,
): Map<string, string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.originSideChatJson) continue
    const parsed = originSideChatSchema.safeParse(JSON.parse(row.originSideChatJson))
    if (parsed.success) ids.add(parsed.data.sideChatId)
  }
  const titles = new Map<string, string>()
  if (ids.size === 0) return titles
  const uniqueIds = [...ids]
  for (let start = 0; start < uniqueIds.length; start += 200) {
    const chunk = uniqueIds.slice(start, start + 200)
    const fetched = repo.database
      .select({
        id: sessions.id,
        title: sessions.title,
        titleSource: sessions.titleSource,
      })
      .from(sessions)
      .where(inArray(sessions.id, chunk))
      .all()
    for (const entry of fetched) {
      titles.set(
        entry.id,
        projectSessionTitle(entry.title, entry.titleSource, 'New side chat').title,
      )
    }
  }
  return titles
}

function toMessage(
  repo: ConversationRepositoryHost,
  row: Omit<
    typeof conversationMessages.$inferSelect,
    'isVisible' | 'skillInvocationJson' | 'originSideChatJson'
  > & {
    isVisible?: boolean
    skillInvocationJson?: string | null
    originSideChatJson?: string | null
    skillsJson?: string | null
  },
  liveSideChatTitles?: ReadonlyMap<string, string>,
): ConversationMessage {
  const resolvedTitles = liveSideChatTitles ?? liveOriginSideChatTitles(repo, [row])
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    outputSnapshot: outputSnapshotMetadata(repo.database, row.id),
    ...repo.messageImageMetadata(row.id),
    contentRevision: row.contentRevision,
    state: row.state,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
    ...(row.isVisible === false && isConversationBackgroundReport(row)
      ? { historicalBackgroundReport: true as const }
      : {}),
    ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
    ...toMessageRoute(row),
    ...toMessageSkills(row),
    ...toOriginSideChat(row, resolvedTitles),
  }
}

function getOrComputeHandoffSourceAgents(
  repo: ConversationRepositoryHost,
  runId: string,
  sessionId: string,
  runAgentId: RuntimeAgentId,
  runNativeSessionId: string | null,
): RuntimeAgentId[] | undefined {
  if (repo.handoffSourceAgentsCache.has(runId)) {
    const cached = repo.handoffSourceAgentsCache.get(runId)
    repo.handoffSourceAgentsCache.delete(runId)
    repo.handoffSourceAgentsCache.set(runId, cached ?? null)
    return cached ?? undefined
  }
  const cacheResult = (value: RuntimeAgentId[] | null): RuntimeAgentId[] | undefined => {
    if (repo.handoffSourceAgentsCache.size >= MAX_OBSERVED_SESSIONS) {
      const oldestKey = repo.handoffSourceAgentsCache.keys().next().value
      if (oldestKey !== undefined) {
        repo.handoffSourceAgentsCache.delete(oldestKey)
      }
    }
    repo.handoffSourceAgentsCache.set(runId, value)
    return value ?? undefined
  }
  const raw = repo.database
    .select({ handoffSourceIds: agentRuns.handoffSourceIds })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get()
  if (
    !raw?.handoffSourceIds ||
    Buffer.byteLength(raw.handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES
  ) {
    return cacheResult(null)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.handoffSourceIds)
  } catch {
    return cacheResult(null)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return cacheResult(null)
  }
  const refIds: string[] = []
  for (const item of parsed) {
    const id = typeof item === 'object' && item !== null ? Reflect.get(item, 'id') : undefined
    if (typeof id !== 'string' || id.length === 0) {
      return cacheResult(null)
    }
    refIds.push(id)
  }
  const coveredSessionId =
    runNativeSessionId ?? repo.nativeContext(sessionId, runAgentId)?.nativeSessionId ?? null
  const orderedUnique = new Set<RuntimeAgentId>()
  for (let offset = 0; offset < refIds.length; offset += HANDOFF_PAGE_ITEMS) {
    const pageIds = refIds.slice(offset, offset + HANDOFF_PAGE_ITEMS)
    const messages = repo.database
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        runId: conversationMessages.runId,
        role: conversationMessages.role,
        messageAgentId: conversationMessages.agentId,
        runAgentId: agentRuns.agentId,
      })
      .from(conversationMessages)
      .leftJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
      .where(inArray(conversationMessages.id, pageIds))
      .all()
    const msgById = new Map(messages.map((m) => [m.id, m]))
    const userIds = messages.filter((m) => m.role === 'user').map((m) => m.id)
    const userRunIds = messages
      .filter((m) => m.role === 'user' && m.runId !== null)
      .map((m) => m.runId!)
    const acceptedForUsers =
      userIds.length > 0
        ? repo.database
            .select({
              id: agentRuns.id,
              userMessageId: agentRuns.userMessageId,
              agentId: agentRuns.agentId,
              forkSourceRunId: agentRuns.forkSourceRunId,
              nativeSessionId: agentRuns.nativeSessionId,
            })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.sessionId, sessionId),
                ne(agentRuns.id, runId),
                isNotNull(agentRuns.nativeTurnId),
                or(
                  sql`${agentRuns.failureKind} IS NULL`,
                  sql`${agentRuns.failureKind} NOT IN ('context_limit', 'unknown_delivery')`,
                ),
                userRunIds.length > 0
                  ? or(inArray(agentRuns.userMessageId, userIds), inArray(agentRuns.id, userRunIds))
                  : inArray(agentRuns.userMessageId, userIds),
              ),
            )
            .orderBy(asc(agentRuns.createdAt), asc(sql`${agentRuns}.rowid`))
            .all()
        : []

    for (const refId of pageIds) {
      const msg = msgById.get(refId)
      if (!msg || msg.sessionId !== sessionId) {
        return cacheResult(null)
      }
      if (msg.role === 'assistant') {
        const actor = msg.runAgentId ?? msg.messageAgentId
        if (actor !== 'claude' && actor !== 'codex' && actor !== 'agy') {
          return cacheResult(null)
        }
        orderedUnique.add(actor)
      } else if (msg.role === 'user') {
        const peerRuns = acceptedForUsers.filter(
          (r) =>
            (r.userMessageId === msg.id || (msg.runId !== null && r.id === msg.runId)) &&
            (r.agentId !== runAgentId ||
              (r.forkSourceRunId !== null && r.nativeSessionId !== coveredSessionId)),
        )
        if (peerRuns.length === 0) {
          return cacheResult(null)
        }
        for (const r of peerRuns) {
          orderedUnique.add(r.agentId)
        }
      } else {
        return cacheResult(null)
      }
    }
  }
  if (orderedUnique.size === 0) {
    return cacheResult(null)
  }
  return cacheResult([...orderedUnique].slice(0, 3))
}

export function toRun(
  repo: ConversationRepositoryHost,
  row: Omit<
    typeof agentRuns.$inferSelect,
    'handoffSourceIds' | 'nativeInputIdsJson' | 'answerFormat' | 'automaticRecoveryRevoked'
  > & {
    responseMessageId?: string | null
    workflowTaskId?: string | null
    collaborationPlanVersion?: number | null
    outputSnapshotsJson?: string | null
  },
): AgentRun {
  const handoffSourceAgents =
    row.handoffMessageCount > 0
      ? getOrComputeHandoffSourceAgents(
          repo,
          row.id,
          row.sessionId,
          row.agentId,
          row.nativeSessionId,
        )
      : undefined
  return {
    outputSnapshots: parseOutputSnapshotSummary(row.outputSnapshotsJson),
    ...(row.workflowTaskId === row.collaborationTaskId &&
    row.collaborationTaskId &&
    row.collaborationKind &&
    row.collaborationStage
      ? {
          collaboration: {
            taskId: row.collaborationTaskId,
            kind: row.collaborationKind,
            stage: row.collaborationStage,
            ...(row.collaborationPlanVersion ? { planVersion: row.collaborationPlanVersion } : {}),
          },
        }
      : {}),
    ...(row.forkSourceRunId ? { forkSourceRunId: row.forkSourceRunId } : {}),
    id: row.id,
    sessionId: row.sessionId,
    userMessageId: row.userMessageId,
    agentId: row.agentId,
    status: row.status,
    attemptCount: row.attemptCount,
    bindingGeneration: row.bindingGeneration,
    controlDisposition: row.controlDisposition,
    dispatchPhase: row.dispatchPhase,
    ...(row.nativeOutcome ? { nativeOutcome: row.nativeOutcome } : {}),
    ...(row.executorId ? { executorId: row.executorId } : {}),
    ...(row.responseMessageId ? { responseMessageId: row.responseMessageId } : {}),
    nativeEffectsState: row.nativeEffectsState,
    ...(row.nativeEffectsReason ? { nativeEffectsReason: row.nativeEffectsReason } : {}),
    ...(row.workspaceRecordingUnavailableReason
      ? { workspaceRecordingUnavailableReason: row.workspaceRecordingUnavailableReason }
      : {}),
    ...(row.reexecutedFromRunId ? { reexecutedFromRunId: row.reexecutedFromRunId } : {}),
    settingsRevision: row.settingsRevision,
    permissionMode: row.permissionMode,
    model: row.model,
    effort: row.effort,
    speed: row.speed,
    ...(row.observedSpeed ? { observedSpeed: row.observedSpeed } : {}),
    ...(row.speedDetail ? { speedDetail: row.speedDetail } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.nativeSessionId ? { nativeSessionId: row.nativeSessionId } : {}),
    ...(row.nativeTurnId ? { nativeTurnId: row.nativeTurnId } : {}),
    ...(row.failureKind ? { failureKind: row.failureKind } : {}),
    ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    ...(row.handoffMessageCount > 0 ? { handoffMessageCount: row.handoffMessageCount } : {}),
    ...(handoffSourceAgents ? { handoffSourceAgents } : {}),
    ...(row.workspaceChangesJson
      ? { workspaceChanges: workspaceChangeSetSchema.parse(JSON.parse(row.workspaceChangesJson)) }
      : {}),
    ...(row.peerProposalId &&
    row.peerProposalTargetAgentId &&
    row.peerProposalKind &&
    row.peerProposalState
      ? {
          peerProposal: {
            id: row.peerProposalId,
            targetAgentId: row.peerProposalTargetAgentId,
            kind: row.peerProposalKind,
            state: row.peerProposalState,
            ...(row.peerProposalReason ? { reason: row.peerProposalReason } : {}),
            ...(row.peerProposalAcceptedMessageId
              ? { acceptedMessageId: row.peerProposalAcceptedMessageId }
              : {}),
          },
        }
      : {}),
  }
}

export function projectNativeContext(
  repo: ConversationRepositoryHost,
  row: typeof nativeAgentContexts.$inferSelect,
): NativeAgentContext {
  const operation = repo.lastNativeRebuild(row.sessionId, row.agentId)
  return {
    ...toNativeContext(row),
    ...(operation ? { rebuildOperation: operation } : {}),
  }
}
