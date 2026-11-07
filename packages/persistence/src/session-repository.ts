import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import type {
  CollaborationSession,
  DefaultSessionSettings,
  SessionSettings,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SessionCatalogChange,
  SessionCatalogCursor,
  SessionCatalogPage,
  NativeSessionRow,
  NativeSessionOpenInput,
  NativeJumpListSuppressionInput,
} from '@pact/contracts'

import { SESSION_CATALOG_PAGE_BYTES, SESSION_CATALOG_PAGE_ITEMS } from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { updateSessionNativeMetadata } from './native-presence-metadata.js'
import {
  agentRuns,
  conversationMessages,
  sessionCatalogRevisions,
  sessionSettingsRevisions,
  sessions,
  sessionForkOperations,
  nativeAgentContexts,
  projects,
  nativePresenceMetadata,
  sessionOpenOperations,
} from './schema/index.js'
import {
  deriveSessionActivity,
  hasUnreadSessionMessage,
  projectSessionTitle,
  type LatestRunActivity,
} from './session-projection.js'
import {
  assertArchiveCommit,
  assertProjectAvailable,
  workspaceArchiveBlocked,
} from './workspace-archive-repository.js'

type SessionRow = typeof sessions.$inferSelect
type SettingsRevisionRow = typeof sessionSettingsRevisions.$inferSelect
type SettingsRevisionValues = typeof sessionSettingsRevisions.$inferInsert

function nativeMenuText(value: string): string {
  // Native menu labels must not retain control characters from user-owned titles.
  return (
    value
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 120) || 'Untitled'
  )
}

export interface NewSessionRecord {
  id: string
  projectId: string
  title: string
  createdAt: string
}

export class StaleCatalogCursorError extends Error {
  constructor() {
    super('The Session Catalog changed while loading. Restart from its first page.')
  }
}

export class OversizedCatalogSessionError extends Error {
  constructor(session?: Pick<CollaborationSession, 'id' | 'title'>) {
    const identity = session
      ? `Session “${session.title.slice(0, 60)}” (${session.id.slice(0, 8)})`
      : 'A Session'
    super(`${identity} exceeds the 1 MiB Catalog limit. Its saved data was not truncated.`)
  }
}

export class SessionRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  nativeInitialized(): boolean {
    return (
      this.database
        .select({ initialized: nativePresenceMetadata.initialized })
        .from(nativePresenceMetadata)
        .where(eq(nativePresenceMetadata.id, 1))
        .get()?.initialized === true
    )
  }

  nativeInitializationPage(after?: string): string[] {
    return this.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(after ? gt(sessions.id, after) : undefined)
      .orderBy(asc(sessions.id))
      .limit(25)
      .all()
      .map((row) => row.id)
  }

  finishNativeInitialization(): void {
    this.database
      .update(nativePresenceMetadata)
      .set({ initialized: true })
      .where(eq(nativePresenceMetadata.id, 1))
      .run()
  }

  nativeAttentionTotal(): number {
    return (
      this.database
        .select({ total: nativePresenceMetadata.attentionTotal })
        .from(nativePresenceMetadata)
        .where(eq(nativePresenceMetadata.id, 1))
        .get()?.total ?? 0
    )
  }

  nativeNeedsAttention(sessionId: string): boolean {
    return (
      this.database
        .select({ attention: sessions.needsAttention })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()?.attention === true
    )
  }

  nativeRecent(): NativeSessionRow[] {
    const ids = this.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        sql`${sessions.workspaceVisible} = 1 AND ${sessions.needsAttention} = 0 AND ${sessions.lastOpenedOrdinal} IS NOT NULL`,
      )
      .orderBy(desc(sessions.lastOpenedOrdinal), desc(sessions.id))
      .limit(18)
      .all()
    return ids.flatMap((row) => {
      const item = this.findNativeRow(row.id)
      return item ? [item] : []
    })
  }

  nativeQuitRecent(): NativeSessionRow[] {
    // The two indexed partitions cover every visible opened Session. Their top
    // five can contribute at most ten candidates to the final five.
    const select = (attention: boolean) =>
      this.database
        .select({ id: sessions.id, ordinal: sessions.lastOpenedOrdinal })
        .from(sessions)
        .where(
          attention
            ? sql`${sessions.workspaceVisible} = 1 AND ${sessions.needsAttention} = 1 AND ${sessions.lastOpenedOrdinal} IS NOT NULL`
            : sql`${sessions.workspaceVisible} = 1 AND ${sessions.needsAttention} = 0 AND ${sessions.lastOpenedOrdinal} IS NOT NULL`,
        )
        .orderBy(desc(sessions.lastOpenedOrdinal), desc(sessions.id))
        .limit(5)
        .all()
    return [...select(false), ...select(true)]
      .toSorted(
        (a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, 5)
      .flatMap((item) => {
        const row = this.findNativeRow(item.id)
        return row ? [row] : []
      })
  }

  nativeAttention(after?: {
    ordinal: number
    id: string
  }): Array<{ row: NativeSessionRow; ordinal: number }> {
    const read = (tail: SQL | undefined, limit: number) =>
      this.database
        .select({ id: sessions.id, ordinal: sessions.lastOpenedOrdinal })
        .from(sessions)
        .where(and(sql`${sessions.workspaceVisible} = 1 AND ${sessions.needsAttention} = 1`, tail))
        .orderBy(desc(sessions.lastOpenedOrdinal), desc(sessions.id))
        .limit(limit)
        .all()
    const ids =
      after?.ordinal === 0
        ? read(and(isNull(sessions.lastOpenedOrdinal), lt(sessions.id, after.id)), 14)
        : read(
            after
              ? and(
                  lte(sessions.lastOpenedOrdinal, after.ordinal),
                  or(
                    lt(sessions.lastOpenedOrdinal, after.ordinal),
                    and(eq(sessions.lastOpenedOrdinal, after.ordinal), lt(sessions.id, after.id)),
                  ),
                )
              : undefined,
            14,
          )
    // Seek opened and never-opened partitions independently. A nullable OR tail
    // otherwise scans every earlier attention entry before reaching this page.
    if (after && after.ordinal > 0 && ids.length < 14)
      ids.push(...read(isNull(sessions.lastOpenedOrdinal), 14 - ids.length))
    return ids.flatMap((item) => {
      const row = this.findNativeRow(item.id)
      return row ? [{ row, ordinal: item.ordinal ?? 0 }] : []
    })
  }

  /** Metadata only: no directory probe, native connection, body read, or task admission. */
  findNativeRow(sessionId: string): NativeSessionRow | undefined {
    const row = this.database
      .select({
        session: {
          id: sessions.id,
          projectId: sessions.projectId,
          title: sessions.title,
          titleSource: sessions.titleSource,
          lastSeen: sessions.lastSeenMessageSequence,
          attention: sessions.needsAttention,
          suppressed: sessions.jumpListSuppressed,
          removalObserved: sessions.jumpListRemovalObserved,
        },
        projectName: projects.name,
        completedSequence: sql<
          number | null
        >`(SELECT sequence FROM conversation_messages WHERE session_id=${sessions.id} AND role='assistant' AND state='complete' AND is_visible=1 ORDER BY sequence DESC LIMIT 1)`,
      })
      .from(sessions)
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.archivedAt),
          sql`${sessions.status} <> 'archived'`,
          isNull(projects.archivedAt),
        ),
      )
      .get()
    if (!row) return undefined
    const title = projectSessionTitle(row.session.title, row.session.titleSource).title
    return {
      sessionId: row.session.id,
      projectId: row.session.projectId,
      title: nativeMenuText(title),
      projectName: nativeMenuText(row.projectName),
      state: row.session.attention ? 'attention' : 'idle',
      unread: hasUnreadSessionMessage(row.session.lastSeen, row.completedSequence ?? undefined),
      jumpListSuppressed: row.session.suppressed,
      jumpListRemovalObserved: row.session.removalObserved,
    }
  }

  resolveNativeSession(sessionId: string): SessionCatalogChange {
    if (!this.findNativeRow(sessionId))
      throw new Error('This Session or its Project is archived or no longer available.')
    return this.change(sessionId)
  }

  recordNativeOpened(input: NativeSessionOpenInput): boolean {
    return this.database.transaction((transaction) => {
      if (!this.findNativeRow(input.sessionId)) throw new Error('This Session is unavailable.')
      const prior = transaction
        .select()
        .from(sessionOpenOperations)
        .where(eq(sessionOpenOperations.openingId, input.openingId))
        .get()
      if (prior) {
        if (prior.sessionId !== input.sessionId)
          throw new Error('This opening already belongs to another Session.')
        return false
      }
      const ordinal = transaction
        .update(nativePresenceMetadata)
        .set({ openingOrdinal: sql`${nativePresenceMetadata.openingOrdinal} + 1` })
        .where(eq(nativePresenceMetadata.id, 1))
        .returning({ value: nativePresenceMetadata.openingOrdinal })
        .get().value
      transaction
        .insert(sessionOpenOperations)
        .values({ ...input, ordinal })
        .run()
      transaction
        .update(sessions)
        .set({ lastOpenedOrdinal: ordinal, jumpListSuppressed: false })
        .where(eq(sessions.id, input.sessionId))
        .run()
      return true
    })
  }

  updateNativeJumpListSuppression(input: NativeJumpListSuppressionInput): boolean {
    return this.database.transaction((transaction) => {
      let changed = 0
      if (input.clearedSessionIds.length)
        changed += transaction
          .update(sessions)
          .set({ jumpListRemovalObserved: false })
          .where(
            and(
              inArray(sessions.id, input.clearedSessionIds),
              eq(sessions.jumpListRemovalObserved, true),
            ),
          )
          .run().changes
      if (input.removedSessionIds.length)
        changed += transaction
          .update(sessions)
          .set({ jumpListSuppressed: true, jumpListRemovalObserved: true })
          .where(
            and(
              inArray(sessions.id, input.removedSessionIds),
              eq(sessions.jumpListRemovalObserved, false),
            ),
          )
          .run().changes
      return changed > 0
    })
  }

  readPage(projectId: string, cursor?: SessionCatalogCursor): SessionCatalogPage {
    return this.database.transaction((transaction) => {
      const revision = transaction
        .select({ revision: sessionCatalogRevisions.revision })
        .from(sessionCatalogRevisions)
        .where(eq(sessionCatalogRevisions.id, 1))
        .get()?.revision
      if (revision === undefined) throw new Error('Session Catalog revision is unavailable.')
      if (cursor && (cursor.revision !== revision || cursor.projectId !== projectId)) {
        throw new StaleCatalogCursorError()
      }

      const latestRunId = sql<string>`(
        SELECT id FROM agent_runs
        WHERE session_id = ${sessions.id} AND control_disposition <> 'abandoned' AND fork_source_run_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=agent_runs.session_id AND n.agent_id=agent_runs.agent_id AND n.binding_generation<>agent_runs.binding_generation)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      )`
      const latestCompletedSequence = sql<number | null>`(
        SELECT sequence FROM conversation_messages
        WHERE session_id = ${sessions.id} AND role = 'assistant' AND state = 'complete' AND is_visible = 1
        ORDER BY sequence DESC
        LIMIT 1
      )`.as('latest_completed_message_sequence')
      const after = cursor
        ? or(
            lt(sessions.createdAt, cursor.createdAt),
            and(eq(sessions.createdAt, cursor.createdAt), lt(sessions.id, cursor.id)),
          )
        : undefined
      const rows = transaction
        .select({
          session: sessions,
          forkError: sql<number>`EXISTS (SELECT 1 FROM ${sessionForkOperations} f WHERE f.session_id=${sessions.id} AND (f.ready=0 OR (SELECT count(*) FROM ${nativeAgentContexts} c WHERE c.session_id=f.session_id)<>2))`,
          settings: sessionSettingsRevisions,
          latestRun: {
            agentId: agentRuns.agentId,
            status: agentRuns.status,
            attemptCount: agentRuns.attemptCount,
          },
          latestCompletedMessageSequence: latestCompletedSequence,
        })
        .from(sessions)
        .innerJoin(
          sessionSettingsRevisions,
          and(
            eq(sessionSettingsRevisions.sessionId, sessions.id),
            eq(sessionSettingsRevisions.revision, sessions.settingsRevision),
          ),
        )
        .leftJoin(agentRuns, eq(agentRuns.id, latestRunId))
        .where(
          and(
            eq(sessions.projectId, projectId),
            isNull(sessions.archivedAt),
            sql`${sessions.status} <> 'archived'`,
            after,
          ),
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(SESSION_CATALOG_PAGE_ITEMS + 1)
        .all()

      const pageSessions: CollaborationSession[] = []
      let usedBytes = 256 // RPC envelope, cursor and JSON punctuation reserve.
      for (const row of rows) {
        if (pageSessions.length === SESSION_CATALOG_PAGE_ITEMS) break
        const projected = SessionRepository.toSession(
          row.session,
          row.settings,
          row.latestRun ?? undefined,
          row.latestCompletedMessageSequence ?? undefined,
        )
        if (row.forkError) projected.activity = { state: 'error' }
        const entityBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1
        if (entityBytes + 256 > SESSION_CATALOG_PAGE_BYTES) {
          throw new OversizedCatalogSessionError(projected)
        }
        if (usedBytes + entityBytes > SESSION_CATALOG_PAGE_BYTES) break
        pageSessions.push(projected)
        usedBytes += entityBytes
      }
      const last = pageSessions.at(-1)
      const nextCursor =
        rows.length > pageSessions.length && last
          ? { projectId, revision, createdAt: last.createdAt, id: last.id }
          : undefined
      const page: SessionCatalogPage = {
        kind: 'page',
        projectId,
        revision,
        sessions: pageSessions,
        ...(nextCursor ? { nextCursor } : {}),
      }
      if (SessionRepository.responseBytes(page) > SESSION_CATALOG_PAGE_BYTES) {
        throw new Error('Session Catalog page exceeded its byte budget.')
      }
      return page
    })
  }

  find(sessionId: string): CollaborationSession | undefined {
    const row = this.database
      .select({
        session: sessions,
        settings: sessionSettingsRevisions,
        forkError: sql<number>`EXISTS (SELECT 1 FROM ${sessionForkOperations} f WHERE f.session_id=${sessions.id} AND (f.ready=0 OR (SELECT count(*) FROM ${nativeAgentContexts} c WHERE c.session_id=f.session_id)<>2))`,
      })
      .from(sessions)
      .innerJoin(
        sessionSettingsRevisions,
        and(
          eq(sessionSettingsRevisions.sessionId, sessions.id),
          eq(sessionSettingsRevisions.revision, sessions.settingsRevision),
        ),
      )
      .where(eq(sessions.id, sessionId))
      .get()

    const latestRun = this.database
      .select({
        agentId: agentRuns.agentId,
        status: agentRuns.status,
        attemptCount: agentRuns.attemptCount,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          ne(agentRuns.controlDisposition, 'abandoned'),
          sql`${agentRuns.forkSourceRunId} IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), sql`agent_runs.rowid DESC`)
      .get()
    const latestCompletedMessage = this.database
      .select({ sequence: conversationMessages.sequence })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.state, 'complete'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .get()

    const projected = row
      ? SessionRepository.toSession(
          row.session,
          row.settings,
          latestRun,
          latestCompletedMessage?.sequence,
        )
      : undefined
    if (projected && row?.forkError) projected.activity = { state: 'error' }
    return projected
  }

  findSettingsRevision(sessionId: string, revision: number): SessionSettings | undefined {
    const row = this.database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, sessionId),
          eq(sessionSettingsRevisions.revision, revision),
        ),
      )
      .get()
    return row ? SessionRepository.toSettings(row) : undefined
  }

  create(record: NewSessionRecord, settings: DefaultSessionSettings): SessionCatalogChange {
    this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, record.projectId)
      transaction
        .insert(sessions)
        .values({
          ...record,
          titleSource: 'placeholder',
          status: 'draft',
          settingsRevision: 1,
          lastSeenMessageSequence: -1,
          updatedAt: record.createdAt,
        })
        .run()
      transaction
        .insert(sessionSettingsRevisions)
        .values(
          SessionRepository.settingsValues(
            record.id,
            1,
            {
              ...settings,
              agents: {
                claude: { ...settings.agents.claude, speed: 'native' },
                codex: { ...settings.agents.codex, speed: 'native' },
              },
            },
            record.createdAt,
          ),
        )
        .run()
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })
    return this.change(record.id)
  }

  saveSettings(sessionId: string, settings: SessionSettings): SessionCatalogChange {
    this.database.transaction((transaction) => {
      const current = transaction.select().from(sessions).where(eq(sessions.id, sessionId)).get()
      if (!current) throw new Error('Session does not exist.')

      const revision = current.settingsRevision + 1
      const updatedAt = new Date().toISOString()
      transaction
        .insert(sessionSettingsRevisions)
        .values(SessionRepository.settingsValues(sessionId, revision, settings, updatedAt))
        .run()
      transaction
        .update(sessions)
        .set({ settingsRevision: revision, updatedAt })
        .where(eq(sessions.id, sessionId))
        .run()
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })

    return this.change(sessionId)
  }

  savePermission(input: SessionPermissionSaveInput): SessionCatalogChange {
    return this.database.transaction(() => {
      const current = this.find(input.sessionId)
      if (
        !current ||
        current.status === 'archived' ||
        current.settingsRevision !== input.expectedRevision
      )
        throw new Error('Session settings changed. Reopen the permissions menu and try again.')
      if (input.mode === 'full' && !input.confirmedFullAccess)
        throw new Error('Full access requires explicit confirmation.')
      const modes = current.settings.permissionModes ?? {
        claude: 'ask' as const,
        codex: 'native' as const,
      }
      if (modes[input.agentId] === input.mode) return this.change(input.sessionId)
      return this.saveSettings(input.sessionId, {
        ...current.settings,
        permissionModes: { ...modes, [input.agentId]: input.mode },
      })
    })
  }

  saveSpeed(input: SessionSpeedSaveInput): SessionCatalogChange {
    return this.database.transaction(() => {
      const current = this.find(input.sessionId)
      if (
        !current ||
        current.status === 'archived' ||
        current.settingsRevision !== input.expectedRevision
      )
        throw new Error('Session settings changed. Reopen the Speed menu and try again.')
      const selected = current.settings.agents[input.agentId]
      if ((selected.speed ?? 'native') === input.speed) return this.change(input.sessionId)
      return this.saveSettings(input.sessionId, {
        ...current.settings,
        agents: {
          ...current.settings.agents,
          [input.agentId]: { ...selected, speed: input.speed },
        },
      })
    })
  }

  rename(sessionId: string, title: string): SessionCatalogChange {
    const updatedAt = new Date().toISOString()
    this.database.transaction((transaction) => {
      const result = transaction
        .update(sessions)
        .set({ title, titleSource: 'user', updatedAt })
        .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'archived')))
        .run()
      if (result.changes === 0) throw new Error('Session does not exist.')
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })
    return this.change(sessionId)
  }

  markRead(sessionId: string, throughSequence: number): SessionCatalogChange {
    this.database.transaction((transaction) => {
      const session = transaction
        .select({ lastSeenMessageSequence: sessions.lastSeenMessageSequence })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'archived')))
        .get()
      if (!session) throw new Error('Session does not exist.')

      const message = transaction
        .select({ sequence: conversationMessages.sequence })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, sessionId),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            eq(conversationMessages.isVisible, true),
            lte(conversationMessages.sequence, throughSequence),
          ),
        )
        .orderBy(desc(conversationMessages.sequence))
        .get()
      const lastSeen = session.lastSeenMessageSequence ?? -1
      if (!message || message.sequence <= lastSeen) return
      transaction
        .update(sessions)
        .set({ lastSeenMessageSequence: message.sequence })
        .where(eq(sessions.id, sessionId))
        .run()
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })
    return this.change(sessionId)
  }

  archive(sessionId: string, operationId?: string): SessionCatalogChange {
    const archivedAt = new Date().toISOString()
    this.database.transaction((transaction) => {
      if (!this.find(sessionId)?.archivedAt)
        assertArchiveCommit(transaction, { kind: 'session', sessionId }, operationId)
      const result = transaction
        .update(sessions)
        .set({ status: 'archived', archivedAt, updatedAt: archivedAt })
        .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'archived')))
        .run()
      if (result.changes === 0) {
        if (this.find(sessionId)?.status !== 'archived') throw new Error('Session does not exist.')
        return
      }
      updateSessionNativeMetadata(transaction, sessionId)
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })
    return this.change(sessionId)
  }

  restore(sessionId: string): SessionCatalogChange {
    const restoredAt = new Date().toISOString()
    this.database.transaction((transaction) => {
      const session = this.find(sessionId)
      if (session && workspaceArchiveBlocked(transaction, session.projectId, sessionId))
        throw new Error('This archive is still settling. Check its result before restoring.')
      const result = transaction
        .update(sessions)
        .set({ status: 'draft', archivedAt: null, updatedAt: restoredAt })
        .where(
          and(
            eq(sessions.id, sessionId),
            sql`(${sessions.archivedAt} IS NOT NULL OR ${sessions.status} = 'archived')`,
          ),
        )
        .run()
      if (result.changes === 0) {
        if (!this.find(sessionId)) throw new Error('Session does not exist.')
        return
      }
      updateSessionNativeMetadata(transaction, sessionId)
      transaction
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
    })
    return this.change(sessionId)
  }

  change(sessionId: string): SessionCatalogChange {
    const session = this.find(sessionId)
    if (!session) throw new Error('Session does not exist.')
    const revision = this.database
      .select({ revision: sessionCatalogRevisions.revision })
      .from(sessionCatalogRevisions)
      .where(eq(sessionCatalogRevisions.id, 1))
      .get()?.revision
    if (revision === undefined) throw new Error('Session Catalog revision is unavailable.')
    const result: SessionCatalogChange = { kind: 'change', revision, session }
    if (SessionRepository.responseBytes(result) > SESSION_CATALOG_PAGE_BYTES) {
      throw new OversizedCatalogSessionError(session)
    }
    return result
  }

  private static responseBytes(value: SessionCatalogPage | SessionCatalogChange): number {
    return Buffer.byteLength(
      JSON.stringify({
        type: 'session-catalog.response',
        requestId: '00000000-0000-0000-0000-000000000000',
        result: { ok: true, value },
      }),
      'utf8',
    )
  }

  private static settingsValues(
    sessionId: string,
    revision: number,
    settings: SessionSettings,
    createdAt: string,
  ): SettingsRevisionValues {
    return {
      sessionId,
      revision,
      primaryAgentId: settings.primaryAgentId,
      claudeModel: settings.agents.claude.model,
      claudeEffort: settings.agents.claude.effort,
      claudeSpeed: settings.agents.claude.speed ?? 'native',
      codexModel: settings.agents.codex.model,
      codexEffort: settings.agents.codex.effort,
      codexSpeed: settings.agents.codex.speed ?? 'native',
      claudePermissionMode: settings.permissionModes?.claude ?? 'ask',
      codexPermissionMode: settings.permissionModes?.codex ?? 'native',
      maxDiscussionRounds: settings.maxDiscussionRounds,
      runningMessagePolicy: 'next_round',
      maxReviewCycles: settings.maxReviewCycles,
      maxRepairAttempts: settings.maxRepairAttempts,
      createdAt,
    }
  }

  private static toSession(
    session: SessionRow,
    settings: SettingsRevisionRow,
    latestRun?: LatestRunActivity,
    latestCompletedMessageSequence?: number,
  ): CollaborationSession {
    const title = projectSessionTitle(session.title, session.titleSource)
    const result: CollaborationSession = {
      id: session.id,
      projectId: session.projectId,
      title: title.title,
      titleSource: title.titleSource,
      status: session.archivedAt ? 'archived' : session.status,
      activity: deriveSessionActivity(session.archivedAt ? 'archived' : session.status, latestRun),
      hasUnread: hasUnreadSessionMessage(
        session.lastSeenMessageSequence,
        latestCompletedMessageSequence,
      ),
      settingsRevision: session.settingsRevision,
      settings: SessionRepository.toSettings(settings),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
    if (session.archivedAt) result.archivedAt = session.archivedAt
    return result
  }

  private static toSettings(settings: SettingsRevisionRow): SessionSettings {
    return {
      primaryAgentId: settings.primaryAgentId,
      permissionModes: {
        claude: settings.claudePermissionMode,
        codex: settings.codexPermissionMode,
      },
      agents: {
        claude: {
          model: settings.claudeModel,
          effort: settings.claudeEffort,
          speed: settings.claudeSpeed,
        },
        codex: {
          model: settings.codexModel,
          effort: settings.codexEffort,
          speed: settings.codexSpeed,
        },
      },
      maxDiscussionRounds: settings.maxDiscussionRounds,
      maxReviewCycles: settings.maxReviewCycles,
      maxRepairAttempts: settings.maxRepairAttempts,
    }
  }
}
