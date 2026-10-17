import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import {
  agentRuns,
  nativeAgentContexts,
  nativeRebuildOperations,
  sessionForkOperations,
  nativePresenceMetadata,
  projects,
  sessions,
} from './schema/index.js'
import {
  projectSessionIssues,
  type SessionIssueRun,
  type SessionIssueContext,
} from './session-issues.js'

const issueRunColumns = {
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  status: agentRuns.status,
  dispatchPhase: agentRuns.dispatchPhase,
  nativeOutcome: agentRuns.nativeOutcome,
  nativeEffectsState: agentRuns.nativeEffectsState,
  bindingGeneration: agentRuns.bindingGeneration,
  failureKind: agentRuns.failureKind,
}

function projectNativeIssueRun(
  row: Pick<typeof agentRuns.$inferSelect, keyof typeof issueRunColumns> | undefined,
): SessionIssueRun | undefined {
  return row
    ? {
        ...row,
        nativeOutcome: row.nativeOutcome ?? undefined,
        nativeEffectsState: row.nativeEffectsState ?? undefined,
        failureKind: row.failureKind ?? undefined,
      }
    : undefined
}

/** Narrow current metadata only; no private JSON decoding, bodies or native I/O. */
export function nativeSessionIssueMetadata(database: PactDrizzleDatabase, sessionId: string) {
  const contexts: SessionIssueContext[] = database
    .select({
      agentId: nativeAgentContexts.agentId,
      nativeSessionId: nativeAgentContexts.nativeSessionId,
      bindingGeneration: nativeAgentContexts.bindingGeneration,
      continuationState: nativeAgentContexts.continuationState,
      state: nativeAgentContexts.state,
      recoveryFailureKind: nativeAgentContexts.recoveryFailureKind,
      recoveryAction: nativeAgentContexts.recoveryAction,
    })
    .from(nativeAgentContexts)
    .where(eq(nativeAgentContexts.sessionId, sessionId))
    .limit(2)
    .all()
    .map((row) => ({
      agentId: row.agentId,
      nativeSessionId: row.nativeSessionId,
      bindingGeneration: row.bindingGeneration,
      continuationState: row.continuationState,
      state: row.state,
      recoveryFailureKind: row.recoveryFailureKind ?? undefined,
      recoveryAction: row.recoveryAction ?? undefined,
    }))
  const readRun = (agentId: 'claude' | 'codex', generation?: number, unacknowledged = false) =>
    database
      .select(issueRunColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.agentId, agentId),
          isNull(agentRuns.forkSourceRunId),
          generation === undefined
            ? undefined
            : and(
                eq(agentRuns.bindingGeneration, generation),
                ne(agentRuns.controlDisposition, 'abandoned'),
              ),
          unacknowledged
            ? sql`${agentRuns.forkSourceRunId} IS NULL AND ${agentRuns.controlDisposition} <> 'abandoned' AND ${agentRuns.dispatchPhase} IN ('possibly_sent', 'accepted') AND ${agentRuns.status} IN ('failed', 'interrupted', 'recovering') AND ${agentRuns.nativeOutcome} IS NULL`
            : undefined,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
      .limit(1)
      .get()
  const runs = (['codex', 'claude'] as const).map((agentId) => {
    const context = contexts.find((row) => row.agentId === agentId)
    return projectNativeIssueRun(
      (!context ? readRun(agentId, undefined, true) : undefined) ??
        readRun(agentId, context?.bindingGeneration),
    )
  })
  const operations = (['codex', 'claude'] as const).flatMap((agentId) => {
    const row = database
      .select({
        id: nativeRebuildOperations.id,
        stage: nativeRebuildOperations.stage,
        provisionalNativeSessionId: nativeRebuildOperations.provisionalNativeSessionId,
        checkAction: nativeRebuildOperations.checkAction,
      })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.sessionId, sessionId),
          eq(nativeRebuildOperations.agentId, agentId),
        ),
      )
      .orderBy(desc(nativeRebuildOperations.createdAt), desc(nativeRebuildOperations.id))
      .limit(1)
      .get()
    return row
      ? [
          {
            agentId,
            operation: {
              ...row,
              provisionalNativeSessionId: row.provisionalNativeSessionId ?? undefined,
              checkAction: row.checkAction ?? undefined,
            },
          },
        ]
      : []
  })
  const incomplete = runs.flatMap((run) =>
    run?.dispatchPhase === 'ended' &&
    !database.get(sql`
    SELECT id FROM conversation_messages WHERE run_id=${run.id} AND role='assistant' AND is_visible=1 AND state='complete' AND length(content)>0 LIMIT 1
  `)
      ? [run.id]
      : [],
  )
  return {
    issues: projectSessionIssues(sessionId, contexts, runs, [], incomplete, operations),
    bindings: contexts.length,
  }
}

export function refreshNativeSessionMetadata(
  database: PactDrizzleDatabase,
  sessionId: string,
): void {
  const facts = nativeSessionIssueMetadata(database, sessionId)
  const fork = database
    .select({ ready: sessionForkOperations.ready })
    .from(sessionForkOperations)
    .where(eq(sessionForkOperations.sessionId, sessionId))
    .get()
  updateSessionNativeMetadata(
    database,
    sessionId,
    Boolean(fork && (!fork.ready || facts.bindings !== 2)) ||
      facts.issues.agents.some((issue) => issue.phase !== 'resolved'),
  )
}

/** Called within the mutation's transaction; counts describe only visible attention. */
export function updateSessionNativeMetadata(
  database: PactDrizzleDatabase,
  sessionId: string,
  needsAttention?: boolean,
): void {
  const row = database
    .select({
      session: {
        projectId: sessions.projectId,
        archivedAt: sessions.archivedAt,
        status: sessions.status,
        workspaceVisible: sessions.workspaceVisible,
        needsAttention: sessions.needsAttention,
      },
      projectArchivedAt: projects.archivedAt,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, sessionId))
    .get()
  if (!row) return
  const visible =
    !row.session.archivedAt && row.session.status !== 'archived' && !row.projectArchivedAt
  const attention = needsAttention ?? row.session.needsAttention
  if (visible === row.session.workspaceVisible && attention === row.session.needsAttention) return
  const delta =
    Number(visible && attention) -
    Number(row.session.workspaceVisible && row.session.needsAttention)
  database
    .update(sessions)
    .set({ workspaceVisible: visible, needsAttention: attention })
    .where(eq(sessions.id, sessionId))
    .run()
  if (delta) {
    database
      .update(projects)
      .set({ needsAttentionCount: sql`${projects.needsAttentionCount} + ${delta}` })
      .where(eq(projects.id, row.session.projectId))
      .run()
    database
      .update(nativePresenceMetadata)
      .set({ attentionTotal: sql`${nativePresenceMetadata.attentionTotal} + ${delta}` })
      .where(eq(nativePresenceMetadata.id, 1))
      .run()
  }
}

/** The Project owner changes exactly its own indexed scope in its existing transaction. */
export function updateProjectNativeVisibility(
  database: PactDrizzleDatabase,
  projectId: string,
): void {
  const project = database
    .select({ archivedAt: projects.archivedAt, count: projects.needsAttentionCount })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  if (!project) return
  database
    .update(sessions)
    .set({ workspaceVisible: false })
    .where(eq(sessions.projectId, projectId))
    .run()
  if (!project.archivedAt)
    database
      .update(sessions)
      .set({ workspaceVisible: true })
      .where(
        and(
          eq(sessions.projectId, projectId),
          isNull(sessions.archivedAt),
          sql`${sessions.status} <> 'archived'`,
        ),
      )
      .run()
  const count = project.archivedAt
    ? 0
    : database
        .select({ value: sql<number>`count(*)` })
        .from(sessions)
        .where(
          and(
            eq(sessions.projectId, projectId),
            sql`${sessions.workspaceVisible} = 1 AND ${sessions.needsAttention} = 1`,
          ),
        )
        .get()!.value
  database
    .update(projects)
    .set({ needsAttentionCount: count })
    .where(eq(projects.id, projectId))
    .run()
  if (count !== project.count)
    database
      .update(nativePresenceMetadata)
      .set({
        attentionTotal: sql`${nativePresenceMetadata.attentionTotal} + ${count - project.count}`,
      })
      .where(eq(nativePresenceMetadata.id, 1))
      .run()
}
