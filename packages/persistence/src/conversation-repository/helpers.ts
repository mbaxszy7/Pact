import { and, desc, eq, inArray, isNull, lte, max, ne, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'

import {
  collaborationDocumentSchema,
  collaborationReceivedMetadataSchema,
  CONVERSATION_PAGE_BYTES,
  frozenSkillInvocationSchema,
  NATIVE_PERMISSION_REQUESTS,
  nativePermissionRequestSchema,
  originSideChatSchema,
  RELAY_CIPHERTEXT_BYTES,
  relayCiphertextSchema,
  skillSelectionsSchema,
  storedCommentAnchor,
  type AgentActivity,
  type AnchoredComment,
  type CollaborationDocument,
  type CollaborationTask,
  type ConversationMessage,
  type ConversationPage,
  type NativeAgentContext,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from '../drizzle-database.js'

import {
  agentRuns,
  collaborationInputs,
  conversationBodyInputs,
  conversationBodyParts,
  conversationMessages,
  nativeAgentContexts,
  nativeRebuildOperations,
  sessions,
  type agentRunActivities,
  type anchoredComments,
} from '../schema/index.js'
import {
  publicRunColumns,
  RunOperationConflictError,
  type BackgroundReportIdentity,
} from './types.js'

export function storedReceivedMetadata(json: string) {
  const value: unknown = JSON.parse(json)
  // Retain the stored receipt while discarding a retired, nonexecuting UI action.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const metadata = { ...value }
    Reflect.deleteProperty(metadata, 'planningAction')
    return collaborationReceivedMetadataSchema.parse(metadata)
  }
  return collaborationReceivedMetadataSchema.parse(value)
}

export function backgroundReportId(report: BackgroundReportIdentity): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'pact-background-report-v1',
        report.runId,
        report.bindingGeneration,
        report.nativeSessionId,
        report.executorId,
        report.frameId,
      ]),
    )
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Canonical ciphertext: strict base64 decode, 1..8192 bytes, re-encode identity. */
export function canonicalCiphertext(value: string): Buffer {
  const parsed = relayCiphertextSchema.safeParse(value)
  if (!parsed.success) throw new RunOperationConflictError('The credential request is invalid.')
  const decoded = Buffer.from(parsed.data, 'base64')
  if (
    decoded.length === 0 ||
    decoded.length > RELAY_CIPHERTEXT_BYTES ||
    decoded.toString('base64') !== parsed.data
  )
    throw new RunOperationConflictError('The credential request is invalid.')
  return decoded
}

export function validBodyText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export function samePlanContent(
  left: CollaborationTask['planReference'],
  right: CollaborationTask['planReference'],
): boolean {
  return (
    left?.version === right?.version &&
    left?.document.sha256 === right?.document.sha256 &&
    left?.document.bytes === right?.document.bytes &&
    left?.document.chars === right?.document.chars
  )
}

export function storedDocuments(
  text: string,
): Array<{ key: string; source: CollaborationDocument }> {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value))
    throw new RunOperationConflictError('The frozen source manifest is invalid.')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || typeof Reflect.get(item, 'key') !== 'string')
      throw new RunOperationConflictError('The frozen source entry is invalid.')
    return {
      key: String(Reflect.get(item, 'key')),
      source: collaborationDocumentSchema.parse(Reflect.get(item, 'source')),
    }
  })
}

/** A fixed template belongs to one connection; rows and parameters are never cached. */
export function lazyStatement<T>(build: () => { toSQL(): { sql: string }; prepare(): T }): () => T {
  let statement: T | undefined
  return () => {
    if (statement === undefined) {
      const query = build()
      if (Buffer.byteLength(query.toSQL().sql) > 8192)
        throw new Error('A fixed source query exceeds its SQL byte bound.')
      statement = query.prepare()
    }
    return statement
  }
}

// At most fourteen immutable templates. Each prepares on first use and SQLite
// finalizes it when this Repository's connection closes. All facts are reread.
export function createSourceQueries(database: PactDrizzleDatabase) {
  return {
    session: lazyStatement(() =>
      database
        .select()
        .from(sessions)
        .where(eq(sessions.id, sql.placeholder('sessionId'))),
    ),
    latestEligibleRun: lazyStatement(() =>
      database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, sql.placeholder('sessionId')),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
            sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
        .limit(1),
    ),
    latestCompleteVisibleSequence: lazyStatement(() =>
      database
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, sql.placeholder('sessionId')),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            eq(conversationMessages.isVisible, true),
          ),
        ),
    ),
    activeReceivedInput: lazyStatement(() =>
      database
        .select()
        .from(collaborationInputs)
        .where(
          and(
            eq(collaborationInputs.sessionId, sql.placeholder('sessionId')),
            inArray(collaborationInputs.state, ['accepted', 'blocked']),
          ),
        )
        .orderBy(desc(collaborationInputs.createdAt))
        .limit(1),
    ),
    run: lazyStatement(() =>
      database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(eq(agentRuns.id, sql.placeholder('runId'))),
    ),
    latestRun: lazyStatement(() =>
      database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(
          eq(
            agentRuns.id,
            database
              .select({ id: agentRuns.id })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.sessionId, sql.placeholder('sessionId')),
                  eq(agentRuns.agentId, sql.placeholder('agentId')),
                  isNull(agentRuns.forkSourceRunId),
                ),
              )
              .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
              .limit(1),
          ),
        ),
    ),
    latestGenerationRun: lazyStatement(() =>
      database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, sql.placeholder('sessionId')),
            eq(agentRuns.agentId, sql.placeholder('agentId')),
            isNull(agentRuns.forkSourceRunId),
            eq(agentRuns.bindingGeneration, sql.placeholder('generation')),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
        .limit(1),
    ),
    nativeContext: lazyStatement(() =>
      database
        .select()
        .from(nativeAgentContexts)
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sql.placeholder('sessionId')),
            eq(nativeAgentContexts.agentId, sql.placeholder('agentId')),
          ),
        ),
    ),
    lastRebuild: lazyStatement(() =>
      database
        .select({ id: nativeRebuildOperations.id })
        .from(nativeRebuildOperations)
        .where(
          and(
            eq(nativeRebuildOperations.sessionId, sql.placeholder('sessionId')),
            eq(nativeRebuildOperations.agentId, sql.placeholder('agentId')),
          ),
        )
        .orderBy(desc(nativeRebuildOperations.createdAt), desc(nativeRebuildOperations.id))
        .limit(1),
    ),
    rebuild: lazyStatement(() =>
      database
        .select({
          id: nativeRebuildOperations.id,
          oldGeneration: nativeRebuildOperations.oldGeneration,
          stage: nativeRebuildOperations.stage,
          provisionalNativeSessionId: nativeRebuildOperations.provisionalNativeSessionId,
          sourceHash: nativeRebuildOperations.sourceHash,
          failureReason: nativeRebuildOperations.failureReason,
          checkAction: nativeRebuildOperations.checkAction,
        })
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, sql.placeholder('operationId'))),
    ),
    document: lazyStatement(() =>
      database
        .select()
        .from(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.id, sql.placeholder('documentId')),
            eq(conversationBodyInputs.sessionId, sql.placeholder('sessionId')),
            inArray(conversationBodyInputs.purpose, ['collaboration', 'answer']),
          ),
        ),
    ),
    earlierInputDocument: lazyStatement(() =>
      database
        .select({ found: sql<number>`1`.as('found') })
        .from(sql`conversation_input_batches b
          LEFT JOIN conversation_input_batch_members m ON m.batch_id=b.id`)
        .where(sql`b.task_id=${sql.placeholder('taskId')} AND b.sequence<=${sql.placeholder('inputSequence')}
          AND (json_extract(b.body_document_json,'$.id')=${sql.placeholder('documentId')}
          OR json_extract(m.body_document_json,'$.id')=${sql.placeholder('documentId')}
          OR json_extract(m.anchor_document_json,'$.id')=${sql.placeholder('documentId')})`)
        .limit(1),
    ),
    quotedDocument: lazyStatement(() =>
      database
        .select({ found: sql<number>`1`.as('found') })
        .from(sql`conversation_run_source_refs s
          LEFT JOIN conversation_input_batches b ON b.id=s.batch_id
          LEFT JOIN conversation_input_batch_members m ON m.batch_id=s.batch_id`)
        .where(sql`s.run_id=${sql.placeholder('runId')} AND
          (EXISTS (SELECT 1 FROM json_each(s.documents_json) j WHERE json_extract(j.value,'$.source.id')=${sql.placeholder('documentId')})
          OR json_extract(b.body_document_json,'$.id')=${sql.placeholder('documentId')}
          OR json_extract(m.body_document_json,'$.id')=${sql.placeholder('documentId')}
          OR json_extract(m.anchor_document_json,'$.id')=${sql.placeholder('documentId')})`)
        .limit(1),
    ),
    documentPart: lazyStatement(() =>
      database
        .select()
        .from(conversationBodyParts)
        .where(
          and(
            eq(conversationBodyParts.inputId, sql.placeholder('documentId')),
            lte(conversationBodyParts.offset, sql.placeholder('offset')),
          ),
        )
        .orderBy(desc(conversationBodyParts.offset))
        .limit(1),
    ),
  }
}

export type SourceQueries = ReturnType<typeof createSourceQueries>

export function fitsPage(page: ConversationPage): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: 'conversation.page.response',
        requestId: '00000000-0000-0000-0000-000000000000',
        result: { ok: true, value: page },
      }),
      'utf8',
    ) <= CONVERSATION_PAGE_BYTES
  )
}

export function toOriginSideChat(
  row: {
    originSideChatJson?: string | null
  },
  liveSideChatTitles?: ReadonlyMap<string, string>,
): Pick<ConversationMessage, 'originSideChat'> {
  if (!row.originSideChatJson) return {}
  const parsed = originSideChatSchema.parse(JSON.parse(row.originSideChatJson))
  const liveTitle = liveSideChatTitles?.get(parsed.sideChatId)
  return {
    originSideChat: liveTitle ? { ...parsed, sideChatTitle: liveTitle } : parsed,
  }
}

export function toMessageSkills(row: {
  skillsJson?: string | null
  skillInvocationJson?: string | null
}): Pick<ConversationMessage, 'skills'> {
  if (row.skillsJson !== null && row.skillsJson !== undefined)
    return { skills: skillSelectionsSchema.parse(JSON.parse(row.skillsJson)) }
  return row.skillInvocationJson
    ? {
        skills: frozenSkillInvocationSchema.parse(JSON.parse(row.skillInvocationJson)).selections,
      }
    : {}
}

export function toComment(row: typeof anchoredComments.$inferSelect): AnchoredComment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    body: row.body,
    anchor: storedCommentAnchor(JSON.parse(row.anchorJson)),
    status: row.sentWithMessageId ? 'sent' : 'draft',
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.sentWithMessageId ? { sentWithMessageId: row.sentWithMessageId } : {}),
  }
}

export function toActivity(row: typeof agentRunActivities.$inferSelect): AgentActivity {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    agentId: row.agentId,
    nativeId: row.nativeId,
    kind: row.kind,
    title: row.title,
    detailRevision: row.detailRevision,
    status: row.status,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.toolName ? { toolName: row.toolName } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  }
}

export function toMessageRoute(
  row: Pick<typeof conversationMessages.$inferSelect, 'routeKind' | 'routeAgentsJson'>,
): Pick<ConversationMessage, 'route'> | undefined {
  if (!row.routeKind || !row.routeAgentsJson) return undefined
  const agents: unknown = JSON.parse(row.routeAgentsJson)
  if (
    !Array.isArray(agents) ||
    agents.some((agent) => agent !== 'claude' && agent !== 'codex' && agent !== 'agy')
  )
    throw new Error('Conversation Message has an invalid persisted route.')
  if (row.routeKind === 'all') {
    const [firstAgentId, secondAgentId] = agents
    if (!firstAgentId || !secondAgentId || firstAgentId === secondAgentId)
      throw new Error('Conversation Message has an invalid all-Agent route.')
    return { route: { type: 'all', firstAgentId, secondAgentId } }
  }
  const [agentId] = agents
  if (!agentId) throw new Error('Conversation Message has no routed Agent.')
  return { route: { type: row.routeKind, agentId } }
}

export function toNativeContext(row: typeof nativeAgentContexts.$inferSelect): NativeAgentContext {
  return {
    ...(row.permissionRequestsJson
      ? {
          permissionRequests: nativePermissionRequestSchema
            .array()
            .max(NATIVE_PERMISSION_REQUESTS)
            .parse(JSON.parse(row.permissionRequestsJson)),
        }
      : {}),
    sessionId: row.sessionId,
    agentId: row.agentId,
    nativeSessionId: row.nativeSessionId,
    bindingGeneration: row.bindingGeneration,
    continuationState: row.continuationState,
    ...(row.executorId ? { executorId: row.executorId } : {}),
    ...(row.recoveryReason ? { recoveryReason: row.recoveryReason.slice(0, 240) } : {}),
    ...(row.recoveryAction ? { recoveryAction: row.recoveryAction } : {}),
    state: row.state,
    updatedAt: row.updatedAt,
    ...(row.lastRunId ? { lastRunId: row.lastRunId } : {}),
    ...(row.recoveryFailureKind ? { recoveryFailureKind: row.recoveryFailureKind } : {}),
    ...(row.recoveryFailureMessage ? { recoveryFailureMessage: row.recoveryFailureMessage } : {}),
    ...(row.rebuildMessageCount !== null ? { rebuildMessageCount: row.rebuildMessageCount } : {}),
    ...(row.rebuiltThroughSequence !== null
      ? { rebuiltThroughSequence: row.rebuiltThroughSequence }
      : {}),
  }
}
