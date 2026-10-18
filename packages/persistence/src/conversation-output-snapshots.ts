import { and, desc, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import type {
  AgentRun,
  ConversationDisplayOrder,
  ConversationMessage,
  ConversationRunContext,
  ConversationSnapshotView,
} from '@pact/contracts'

import { agentRunSchema } from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { conversationMessages, conversationOutputSnapshots } from './schema/index.js'

type Reader = Pick<PactDrizzleDatabase, 'select' | 'all' | 'get'>
type Writer = Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>

// Match String.trim()/the transcript filter, including Unicode whitespace.
const BODY_WHITESPACE =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
export function outputHasBodySql(content: SQLWrapper): SQL<boolean> {
  return sql<boolean>`length(trim(${content},${BODY_WHITESPACE}))>0`
}

/** A normal ending alone cannot certify an uncommitted or uncertain answer. */
function settled(runId: SQLWrapper): SQL<number> {
  return sql<number>`EXISTS (
    SELECT 1 FROM agent_runs r JOIN conversation_messages c
      ON c.run_id=r.id AND c.role='assistant' AND c.is_visible=1
      JOIN conversation_output_snapshots body ON body.source_message_id=c.id AND body.has_body=1
    WHERE r.id=${runId} AND r.status='completed' AND r.native_outcome='completed'
      AND r.dispatch_phase='ended' AND r.control_disposition='retained'
      AND r.native_effects_state='settled'
      AND c.state='complete'
      AND NOT EXISTS (SELECT 1 FROM conversation_queue_operations q
        WHERE q.target_run_id=r.id AND q.kind='steer'
          AND q.state IN ('prepared','possibly_sent','accepted','unknown'))
      AND NOT EXISTS (SELECT 1 FROM native_agent_contexts n
        WHERE n.session_id=r.session_id AND n.agent_id=r.agent_id AND n.last_run_id=r.id
          AND (n.state<>'active' OR n.continuation_state<>'ready'))
  )`
}

export function outputSnapshotSummarySql(runId: SQLWrapper): SQL<string | null> {
  return sql<string | null>`(SELECT json_object(
    'count',(SELECT count(source_message_id) FROM conversation_output_snapshots WHERE run_id=s.run_id),
    'lastInputMessageId',s.after_message_id,'lastInputSequence',u.sequence,
    'settled',json(CASE WHEN ${settled(sql`s.run_id`)} THEN 'true' ELSE 'false' END))
    FROM conversation_output_snapshots s JOIN conversation_messages u ON u.id=s.after_message_id
    WHERE s.run_id=${runId} ORDER BY s.ordinal DESC LIMIT 1)`
}

export function parseOutputSnapshotSummary(
  json: string | null | undefined,
): AgentRun['outputSnapshots'] {
  if (!json) return undefined
  return agentRunSchema.shape.outputSnapshots.parse(JSON.parse(json))
}

/** Runs only inside the same transaction that materializes the accepted User input. */
export function freezeOutputAtSteer(
  database: Writer,
  run: AgentRun,
  inputMessageId: string,
): string | undefined {
  const previous = database
    .select()
    .from(conversationOutputSnapshots)
    .where(eq(conversationOutputSnapshots.runId, run.id))
    .orderBy(desc(conversationOutputSnapshots.ordinal))
    .limit(1)
    .get()
  if (previous?.ordinal === 63)
    throw new Error('This Run has reached its 64 output snapshot boundaries.')
  let sourceId = previous?.sourceMessageId ?? undefined
  if (!previous) {
    const source = database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        hasBody: outputHasBodySql(conversationMessages.content),
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.runId, run.id),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    const root = database
      .select({ sequence: conversationMessages.sequence })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, run.userMessageId))
      .get()!
    sourceId = source?.id
    database
      .insert(conversationOutputSnapshots)
      .values({
        sessionId: run.sessionId,
        runId: run.id,
        ordinal: 0,
        afterMessageId: run.userMessageId,
        sourceMessageId: source?.id ?? null,
        sourceSequence: source?.sequence ?? null,
        afterSequence: root.sequence,
        hasBody: Boolean(source?.hasBody),
        frozen: true,
        contextSequence: source?.sequence ?? root.sequence,
        contextRank: source ? 0 : 2,
      })
      .run()
  } else {
    database
      .update(conversationOutputSnapshots)
      .set({ frozen: true })
      .where(
        and(
          eq(conversationOutputSnapshots.runId, run.id),
          eq(conversationOutputSnapshots.ordinal, previous.ordinal),
        ),
      )
      .run()
  }
  const root = database
    .select()
    .from(conversationOutputSnapshots)
    .where(
      and(
        eq(conversationOutputSnapshots.runId, run.id),
        eq(conversationOutputSnapshots.ordinal, 0),
      ),
    )
    .get()!
  const after = database
    .select({ sequence: conversationMessages.sequence })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, inputMessageId))
    .get()!
  database
    .insert(conversationOutputSnapshots)
    .values({
      sessionId: run.sessionId,
      runId: run.id,
      ordinal: (previous?.ordinal ?? 0) + 1,
      afterMessageId: inputMessageId,
      afterSequence: after.sequence,
      frozen: false,
      contextSequence: root.contextSequence,
      contextRank: root.contextRank,
    })
    .run()
  return sourceId
}

export function outputRunContext(
  database: Reader,
  runId: string,
): ConversationRunContext | undefined {
  const row = database.get<{ sequence: number; rank: number; count: number; settled: number }>(sql`
    SELECT s.context_sequence AS sequence,s.context_rank AS rank,
      (SELECT count(*) FROM conversation_output_snapshots p JOIN conversation_messages m ON m.id=p.source_message_id
        WHERE p.run_id=s.run_id AND m.is_visible=0 AND p.has_body=1) AS count,
      ${settled(sql`s.run_id`)} AS settled
    FROM conversation_output_snapshots s WHERE s.run_id=${runId} AND s.ordinal=0`)
  return row
    ? {
        runId,
        order: { sequence: row.sequence, rank: row.rank, id: runId },
        earlierResponseCount: row.count,
        settled: Boolean(row.settled),
      }
    : undefined
}

export function outputSnapshotMetadata(
  database: Reader,
  messageId: string,
  view?: ConversationSnapshotView,
  preserveRunId?: string,
): ConversationMessage['outputSnapshot'] {
  const row = database.get<{
    ordinal: number
    frozen: number
    canonical: number
    sequence: number
    lastSequence: number
    runId: string
    settled: number
  }>(sql`
    SELECT s.ordinal,s.frozen,m.is_visible AS canonical,m.sequence,s.run_id AS runId,
      (SELECT u.sequence FROM conversation_output_snapshots p JOIN conversation_messages u ON u.id=p.after_message_id
        WHERE p.run_id=s.run_id ORDER BY p.ordinal DESC LIMIT 1) AS lastSequence,
      ${settled(sql`s.run_id`)} AS settled
    FROM conversation_output_snapshots s JOIN conversation_messages m ON m.id=s.source_message_id
    WHERE s.source_message_id=${messageId}`)
  if (!row) return undefined
  const moved = Boolean(
    row.canonical &&
    row.settled &&
    row.sequence <= row.lastSequence &&
    row.runId !== (preserveRunId ?? (view?.mode === 'preserve' ? view.runId : undefined)),
  )
  return {
    ordinal: row.ordinal,
    frozen: Boolean(row.frozen),
    canonical: Boolean(row.canonical),
    order: {
      sequence: moved ? row.lastSequence : row.sequence,
      rank: moved ? 2 : 1,
      id: messageId,
    },
  }
}

export interface OutputTimelineItem {
  id: string
  kind: 'message' | 'context'
  runId: string | null
  sequence: number
  rank: number
}

/** The descriptor and bodies share one keyset and LIMIT; collapsed rows cost no page slots. */
export function outputTimelineSql(
  sessionId: string,
  view?: ConversationSnapshotView,
  options: { filter: SQL; newer: boolean; legacy: boolean; preserveRunId?: string | undefined } = {
    filter: sql`1=1`,
    newer: false,
    legacy: false,
  },
): SQL {
  if (options.legacy)
    return sql`WITH timeline AS (
    SELECT id,'message' AS kind,run_id AS runId,sequence,1 AS rank FROM conversation_messages INDEXED BY conversation_messages_session_visible_sequence_idx
    WHERE session_id=${sessionId} AND is_visible=1)`
  const direction = options.newer ? sql`ASC` : sql`DESC`
  const preserveRunId =
    options.preserveRunId ?? (view?.mode === 'preserve' ? view.runId : undefined)
  const candidates = (
    name: SQL,
    source: SQL,
    variableRank = false,
  ): SQL => sql`${name} AS MATERIALIZED (
    SELECT * FROM (${source}) WHERE ${options.filter}
    ORDER BY sequence ${direction},${variableRank ? sql`rank ${direction},` : sql``}id ${direction} LIMIT 26)`
  // Immutable order keys are indexed. Bound each branch before the common merge;
  // neither a large legacy transcript nor collapsed bodies are materialized to sort it.
  return sql`WITH ${candidates(
    sql`normal_candidates`,
    sql`
    SELECT m.id,'message' AS kind,m.run_id AS runId,m.sequence,1 AS rank
    FROM conversation_messages m INDEXED BY conversation_messages_session_visible_sequence_idx
    WHERE m.session_id=${sessionId} AND m.is_visible=1
      AND NOT (m.role='assistant' AND m.run_id<>${preserveRunId ?? ''}
        AND EXISTS (SELECT 1 FROM conversation_output_snapshots p INDEXED BY conversation_output_snapshots_session_idx
          WHERE p.session_id=m.session_id AND p.run_id=m.run_id
          AND p.frozen=0 AND p.source_message_id IS NULL AND p.after_sequence>=m.sequence
          AND ${settled(sql`p.run_id`)}))`,
  )},
    ${candidates(
      sql`snapshot_candidates`,
      sql`
      SELECT s.source_message_id AS id,'message' AS kind,s.run_id AS runId,s.source_sequence AS sequence,1 AS rank
      FROM conversation_output_snapshots s INDEXED BY conversation_output_snapshots_source_order_idx
        JOIN conversation_messages m ON m.id=s.source_message_id
      WHERE s.session_id=${sessionId} AND s.source_sequence IS NOT NULL AND m.is_visible=0
        AND (s.run_id=${view?.runId ?? ''} OR s.run_id=${preserveRunId ?? ''} OR NOT ${settled(sql`s.run_id`)} )`,
    )},
    ${candidates(
      sql`final_candidates`,
      sql`
      SELECT m.id,'message' AS kind,s.run_id AS runId,s.after_sequence AS sequence,2 AS rank
      FROM conversation_output_snapshots s INDEXED BY conversation_output_snapshots_input_order_idx
        JOIN conversation_messages m ON m.run_id=s.run_id
        AND m.role='assistant' AND m.is_visible=1
      WHERE s.session_id=${sessionId} AND s.frozen=0 AND s.source_message_id IS NULL
        AND m.sequence<=s.after_sequence AND ${settled(sql`s.run_id`)}
        AND s.run_id<>${preserveRunId ?? ''}`,
    )},
    ${candidates(
      sql`context_candidates`,
      sql`
      SELECT run_id AS id,'context' AS kind,run_id AS runId,context_sequence AS sequence,context_rank AS rank
      FROM conversation_output_snapshots INDEXED BY conversation_output_snapshots_context_order_idx
      WHERE session_id=${sessionId} AND ordinal=0`,
      true,
    )},
    timeline AS (SELECT * FROM normal_candidates UNION ALL SELECT * FROM snapshot_candidates
      UNION ALL SELECT * FROM final_candidates UNION ALL SELECT * FROM context_candidates)`
}

export function beforeOutputOrder(order: ConversationDisplayOrder): SQL {
  return sql`(sequence,rank,id)<(${order.sequence},${order.rank},${order.id})`
}
export function afterOutputOrder(order: ConversationDisplayOrder, inclusive = false): SQL {
  return inclusive
    ? sql`(sequence,rank,id)>=(${order.sequence},${order.rank},${order.id})`
    : sql`(sequence,rank,id)>(${order.sequence},${order.rank},${order.id})`
}
