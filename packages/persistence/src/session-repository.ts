import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
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
  SessionSidebarHiddenInput,
  NativeSessionRow,
  NativeSessionOpenInput,
  NativeJumpListSuppressionInput,
  SessionPage,
  SessionPageInput,
  SessionPageScope,
  SessionPageCursor,
  SessionGroup,
  SessionGroupPage,
  SessionGroupPageInput,
  SessionGroupPageCursor,
  SessionGroupDetail,
  SessionGroupDetailInput,
  SessionMembership,
  SessionMembershipInput,
  LocateSessionNavigationInput,
  LocatedSessionNavigation,
  SessionCreationState,
  SessionCreationStateInput,
  CreateSessionGroupInput,
  UpdateSessionGroupInput,
  MoveSessionGroupInput,
  DissolveSessionGroupInput,
  SetSessionGroupInput,
  SessionGroupMutation,
} from '@pact/contracts'

import {
  SESSION_CATALOG_PAGE_BYTES,
  SESSION_CATALOG_PAGE_ITEMS,
  SESSION_GROUP_PAGE_BYTES,
  SESSION_GROUP_PAGE_ITEMS,
} from '@pact/contracts'

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
  sessionGroups,
  sessionGroupMembers,
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
type SessionGroupRow = typeof sessionGroups.$inferSelect
type DrizzleTransaction = Parameters<Parameters<PactDrizzleDatabase['transaction']>[0]>[0]

type NavigationAnchor = {
  id: string
  createdAt: string
  groupPosition?: number | undefined
}
type NavigationEntry = { session: CollaborationSession; groupPosition: number | null }

const sidebarVisible = and(
  isNull(sessions.archivedAt),
  sql`${sessions.status} <> 'archived'`,
  eq(sessions.sidebarHidden, false),
)

function navigationCursor(
  projectId: string,
  scope: SessionPageScope,
  revision: number,
  direction: SessionPageCursor['direction'],
  entry: NavigationEntry,
): SessionPageCursor {
  return {
    projectId,
    scope,
    revision,
    direction,
    id: entry.session.id,
    createdAt: entry.session.createdAt,
    groupPosition: entry.groupPosition ?? undefined,
  }
}

function toSessionGroup(row: SessionGroupRow): SessionGroup {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    creationOrdinal: row.creationOrdinal,
    position: row.position,
    collapsed: row.collapsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function sameScope(left: SessionPageScope, right: SessionPageScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'ungrouped') return true
  return right.kind === 'group' && left.groupId === right.groupId
}

function scopeOf(groupId: string | null): SessionPageScope {
  return groupId ? { kind: 'group', groupId } : { kind: 'ungrouped' }
}

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

export class StaleSessionGroupError extends Error {
  constructor() {
    super('Session groups changed while this operation was being saved. Reload and retry.')
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
    return this.database.transaction((transaction) => {
      const row = this.findNativeRow(sessionId)
      if (!row) throw new Error('This Session or its Project is archived or no longer available.')
      return {
        ...this.change(sessionId),
        groupRevision: SessionRepository.readGroupRevision(transaction, row.projectId).revision,
      }
    })
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
          groupId: sql<
            string | null
          >`(SELECT group_id FROM session_group_members m WHERE m.session_id = ${sessions.id})`.as(
            'session_group_id',
          ),
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
          row.groupId,
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

  readSessionPage(input: SessionPageInput): SessionPage {
    return this.database.transaction((transaction) => {
      const revision = SessionRepository.readCatalogRevision(transaction)
      const { revision: groupRevision } = SessionRepository.readGroupRevision(
        transaction,
        input.projectId,
        'visible',
      )
      if (input.scope.kind === 'group') {
        const group = transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(
            and(
              eq(sessionGroups.projectId, input.projectId),
              eq(sessionGroups.id, input.scope.groupId),
            ),
          )
          .get()
        if (!group) throw new Error('The target Session group no longer exists.')
      }
      const direction = input.cursor?.direction ?? 'older'
      if (
        input.cursor &&
        (input.cursor.projectId !== input.projectId ||
          input.cursor.revision !== revision ||
          !sameScope(input.cursor.scope, input.scope))
      ) {
        throw new StaleCatalogCursorError()
      }
      const rows = SessionRepository.readNavigationWindow(
        transaction,
        input.projectId,
        input.scope,
        direction,
        SESSION_CATALOG_PAGE_ITEMS + 1,
        input.cursor,
      )
      const entries: NavigationEntry[] = []
      let usedBytes = 1024
      for (const entry of rows) {
        if (entries.length === SESSION_CATALOG_PAGE_ITEMS) break
        const entityBytes = Buffer.byteLength(JSON.stringify(entry.session), 'utf8') + 1
        if (entityBytes + 1024 > SESSION_CATALOG_PAGE_BYTES)
          throw new OversizedCatalogSessionError(entry.session)
        if (usedBytes + entityBytes > SESSION_CATALOG_PAGE_BYTES) break
        entries.push(entry)
        usedBytes += entityBytes
      }
      const hasMore = rows.length > entries.length
      const page = direction === 'newer' ? entries.toReversed() : entries
      const last = page.at(-1)
      const first = page[0]
      const nextCursor =
        (direction === 'older' ? hasMore : Boolean(input.cursor)) && last
          ? navigationCursor(input.projectId, input.scope, revision, 'older', last)
          : undefined
      const previousCursor =
        (direction === 'newer' ? hasMore : Boolean(input.cursor)) && first
          ? navigationCursor(input.projectId, input.scope, revision, 'newer', first)
          : undefined
      const hasGroups = Boolean(
        transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(eq(sessionGroups.projectId, input.projectId))
          .limit(1)
          .get(),
      )
      return {
        kind: 'page',
        projectId: input.projectId,
        scope: input.scope,
        revision,
        groupRevision,
        sessions: page.map((entry) => entry.session),
        hasGroups,
        ...(nextCursor ? { nextCursor } : {}),
        ...(previousCursor ? { previousCursor } : {}),
      }
    })
  }

  private static readNavigationWindow(
    transaction: DrizzleTransaction,
    projectId: string,
    scope: SessionPageScope,
    direction: SessionPageCursor['direction'],
    limit: number,
    anchor?: NavigationAnchor,
    inclusive = false,
  ): NavigationEntry[] {
    const forward = direction === 'older'
    const settingsJoin = and(
      eq(sessionSettingsRevisions.sessionId, sessions.id),
      eq(sessionSettingsRevisions.revision, sessions.settingsRevision),
    )
    const groupPosition = anchor?.groupPosition
    if (scope.kind === 'group' && anchor && groupPosition === undefined)
      throw new StaleCatalogCursorError()
    const timestampBoundary = anchor
      ? or(
          forward
            ? lt(sessions.createdAt, anchor.createdAt)
            : gt(sessions.createdAt, anchor.createdAt),
          and(
            eq(sessions.createdAt, anchor.createdAt),
            forward
              ? inclusive
                ? lte(sessions.id, anchor.id)
                : lt(sessions.id, anchor.id)
              : gt(sessions.id, anchor.id),
          ),
        )
      : undefined
    // Limit the indexed membership range before deriving activity for any Session.
    const candidates =
      scope.kind === 'group'
        ? transaction
            .select({
              id: sessionGroupMembers.sessionId,
              position: sessionGroupMembers.position,
            })
            .from(sessionGroupMembers)
            .innerJoin(sessions, eq(sessions.id, sessionGroupMembers.sessionId))
            .innerJoin(sessionSettingsRevisions, settingsJoin)
            .where(
              and(
                eq(sessionGroupMembers.groupId, scope.groupId),
                eq(sessionGroupMembers.projectId, projectId),
                sidebarVisible,
                groupPosition === undefined
                  ? undefined
                  : forward
                    ? inclusive
                      ? gte(sessionGroupMembers.position, groupPosition)
                      : gt(sessionGroupMembers.position, groupPosition)
                    : lt(sessionGroupMembers.position, groupPosition),
              ),
            )
            .orderBy(
              forward ? asc(sessionGroupMembers.position) : desc(sessionGroupMembers.position),
            )
            .limit(limit)
            .all()
        : undefined
    if (candidates && !candidates.length) return []
    const latestRunId = sql<string>`(
      SELECT id FROM agent_runs
      WHERE session_id = ${sessions.id} AND control_disposition <> 'abandoned' AND fork_source_run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=agent_runs.session_id AND n.agent_id=agent_runs.agent_id AND n.binding_generation<>agent_runs.binding_generation)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    )`
    const projection = transaction
      .select({
        session: sessions,
        settings: sessionSettingsRevisions,
        forkError: sql<number>`EXISTS (SELECT 1 FROM ${sessionForkOperations} f WHERE f.session_id=${sessions.id} AND (f.ready=0 OR (SELECT count(*) FROM ${nativeAgentContexts} c WHERE c.session_id=f.session_id)<>2))`,
        latestRun: {
          agentId: agentRuns.agentId,
          status: agentRuns.status,
          attemptCount: agentRuns.attemptCount,
        },
        latestCompletedMessageSequence: sql<number | null>`(
        SELECT sequence FROM conversation_messages
        WHERE session_id = ${sessions.id} AND role = 'assistant' AND state = 'complete' AND is_visible = 1
        ORDER BY sequence DESC LIMIT 1
      )`,
      })
      .from(sessions)
      .innerJoin(sessionSettingsRevisions, settingsJoin)
      .leftJoin(agentRuns, eq(agentRuns.id, latestRunId))
    const rows = candidates
      ? projection
          .where(
            inArray(
              sessions.id,
              candidates.map((candidate) => candidate.id),
            ),
          )
          .all()
      : projection
          .where(
            and(
              eq(sessions.projectId, projectId),
              sidebarVisible,
              sql`NOT EXISTS (SELECT 1 FROM session_group_members m WHERE m.session_id = ${sessions.id})`,
              timestampBoundary,
            ),
          )
          .orderBy(
            forward ? desc(sessions.createdAt) : asc(sessions.createdAt),
            forward ? desc(sessions.id) : asc(sessions.id),
          )
          .limit(limit)
          .all()
    const project = (row: (typeof rows)[number], position: number | null): NavigationEntry => {
      const session = SessionRepository.toSession(
        row.session,
        row.settings,
        row.latestRun ?? undefined,
        row.latestCompletedMessageSequence ?? undefined,
        scope.kind === 'group' ? scope.groupId : null,
      )
      if (row.forkError) session.activity = { state: 'error' }
      return { session, groupPosition: position }
    }
    if (!candidates) return rows.map((row) => project(row, null))
    const byId = new Map(rows.map((row) => [row.session.id, row]))
    return candidates.map((candidate) => {
      const row = byId.get(candidate.id)
      if (!row) throw new Error('The Session navigation window changed.')
      return project(row, candidate.position)
    })
  }

  readSessionGroups(input: SessionGroupPageInput): SessionGroupPage {
    return this.database.transaction((transaction) => {
      const { revision } = SessionRepository.readGroupRevision(
        transaction,
        input.projectId,
        'visible',
      )
      const direction = input.cursor?.direction ?? 'older'
      if (
        input.cursor &&
        (input.cursor.projectId !== input.projectId || input.cursor.revision !== revision)
      ) {
        throw new StaleSessionGroupError()
      }
      if (input.aroundGroupId) {
        const target = transaction
          .select()
          .from(sessionGroups)
          .where(
            and(
              eq(sessionGroups.projectId, input.projectId),
              eq(sessionGroups.id, input.aroundGroupId),
            ),
          )
          .get()
        if (!target) throw new Error('This Session group no longer exists.')
        const project = eq(sessionGroups.projectId, input.projectId)
        const before = transaction
          .select()
          .from(sessionGroups)
          .where(and(project, lt(sessionGroups.position, target.position)))
          .orderBy(desc(sessionGroups.position))
          .limit(10)
          .all()
        const after = transaction
          .select()
          .from(sessionGroups)
          .where(and(project, gt(sessionGroups.position, target.position)))
          .orderBy(asc(sessionGroups.position))
          .limit(11)
          .all()
        const groups = [...before.slice(0, 9).toReversed(), target, ...after.slice(0, 10)].map(
          toSessionGroup,
        )
        const cursor = (
          group: SessionGroup,
          cursorDirection: 'older' | 'newer',
        ): SessionGroupPageCursor => ({
          projectId: input.projectId,
          revision,
          direction: cursorDirection,
          position: group.position,
          id: group.id,
        })
        return {
          kind: 'groups',
          projectId: input.projectId,
          revision,
          groups,
          previousCursor: before.length > 9 ? cursor(groups[0]!, 'newer') : undefined,
          nextCursor: after.length > 10 ? cursor(groups.at(-1)!, 'older') : undefined,
        }
      }
      const after = input.cursor
        ? direction === 'older'
          ? or(
              gt(sessionGroups.position, input.cursor.position),
              and(
                eq(sessionGroups.position, input.cursor.position),
                gt(sessionGroups.id, input.cursor.id),
              ),
            )
          : or(
              lt(sessionGroups.position, input.cursor.position),
              and(
                eq(sessionGroups.position, input.cursor.position),
                lt(sessionGroups.id, input.cursor.id),
              ),
            )
        : undefined
      const rows = transaction
        .select()
        .from(sessionGroups)
        .where(and(eq(sessionGroups.projectId, input.projectId), after))
        .orderBy(
          direction === 'older' ? asc(sessionGroups.position) : desc(sessionGroups.position),
          direction === 'older' ? asc(sessionGroups.id) : desc(sessionGroups.id),
        )
        .limit(SESSION_GROUP_PAGE_ITEMS + 1)
        .all()
      const groups = rows.slice(0, SESSION_GROUP_PAGE_ITEMS).map(toSessionGroup)
      if (direction === 'newer') groups.reverse()
      if (Buffer.byteLength(JSON.stringify(groups), 'utf8') > SESSION_GROUP_PAGE_BYTES) {
        throw new Error('Session group page exceeded its byte budget.')
      }
      const hasMore = rows.length > groups.length
      const last = groups.at(-1)
      const first = groups[0]
      const nextCursor: SessionGroupPageCursor | undefined =
        (direction === 'older' ? hasMore : Boolean(input.cursor)) && last
          ? {
              projectId: input.projectId,
              revision,
              direction: 'older',
              position: last.position,
              id: last.id,
            }
          : undefined
      const previousCursor: SessionGroupPageCursor | undefined =
        (direction === 'newer' ? hasMore : Boolean(input.cursor)) && first
          ? {
              projectId: input.projectId,
              revision,
              direction: 'newer',
              position: first.position,
              id: first.id,
            }
          : undefined
      return {
        kind: 'groups',
        projectId: input.projectId,
        revision,
        groups,
        ...(nextCursor ? { nextCursor } : {}),
        ...(previousCursor ? { previousCursor } : {}),
      }
    })
  }

  readSessionGroup(input: SessionGroupDetailInput): SessionGroupDetail {
    return this.database.transaction((transaction) => {
      const { revision } = SessionRepository.readGroupRevision(transaction, input.projectId)
      const row = transaction
        .select()
        .from(sessionGroups)
        .where(
          and(eq(sessionGroups.projectId, input.projectId), eq(sessionGroups.id, input.groupId)),
        )
        .get()
      if (!row) return { exists: false, revision }
      const previous = transaction
        .select({ id: sessionGroups.id })
        .from(sessionGroups)
        .where(
          and(
            eq(sessionGroups.projectId, input.projectId),
            or(
              lt(sessionGroups.position, row.position),
              and(eq(sessionGroups.position, row.position), lt(sessionGroups.id, row.id)),
            ),
          ),
        )
        .orderBy(desc(sessionGroups.position), desc(sessionGroups.id))
        .limit(1)
        .get()
      const next = transaction
        .select({ id: sessionGroups.id })
        .from(sessionGroups)
        .where(
          and(
            eq(sessionGroups.projectId, input.projectId),
            or(
              gt(sessionGroups.position, row.position),
              and(eq(sessionGroups.position, row.position), gt(sessionGroups.id, row.id)),
            ),
          ),
        )
        .orderBy(asc(sessionGroups.position), asc(sessionGroups.id))
        .limit(1)
        .get()
      return {
        exists: true,
        group: toSessionGroup(row),
        revision,
        ...(previous ? { previousGroupId: previous.id } : {}),
        ...(next ? { nextGroupId: next.id } : {}),
      }
    })
  }

  readSessionMembership(input: SessionMembershipInput): SessionMembership {
    return this.database.transaction((transaction) => {
      const { revision } = SessionRepository.readGroupRevision(transaction, input.projectId)
      return SessionRepository.readMembership(transaction, input, revision)
    })
  }

  locateSessionNavigation(input: LocateSessionNavigationInput): LocatedSessionNavigation {
    return this.database.transaction((transaction) => {
      const { revision } = SessionRepository.readGroupRevision(
        transaction,
        input.projectId,
        'visible',
      )
      const catalogRevision = SessionRepository.readCatalogRevision(transaction)
      const membership = SessionRepository.readMembership(transaction, input, revision)
      if (!membership.exists || membership.archived) {
        return {
          membership,
          catalogRevision,
          sessions: [],
          groups: [],
          hasGroups: false,
        }
      }
      if (!membership.createdAt) throw new Error('The Session is unavailable for navigation.')
      const scope = scopeOf(membership.groupId)
      const anchor = {
        id: input.sessionId,
        createdAt: membership.createdAt,
        groupPosition: membership.groupPosition,
      }
      const olderRows = SessionRepository.readNavigationWindow(
        transaction,
        input.projectId,
        scope,
        'older',
        4,
        anchor,
        true,
      )
      const newerRows = SessionRepository.readNavigationWindow(
        transaction,
        input.projectId,
        scope,
        'newer',
        3,
        anchor,
      )
      const window = [...newerRows.slice(0, 2).toReversed(), ...olderRows.slice(0, 3)]
      const groupPage = membership.groupId
        ? this.readSessionGroups({ projectId: input.projectId, aroundGroupId: membership.groupId })
        : undefined
      const hasGroups = Boolean(
        groupPage ||
        transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(eq(sessionGroups.projectId, input.projectId))
          .limit(1)
          .get(),
      )
      const lastSession = window.at(-1)
      const firstSession = window[0]
      const result: LocatedSessionNavigation = {
        membership,
        catalogRevision,
        sessions: window.map((entry) => entry.session),
        groups: groupPage?.groups ?? [],
        hasGroups,
        ...(lastSession && olderRows.length > 3
          ? {
              nextCursor: navigationCursor(
                input.projectId,
                scope,
                catalogRevision,
                'older',
                lastSession,
              ),
            }
          : {}),
        ...(firstSession && newerRows.length > 2
          ? {
              previousCursor: navigationCursor(
                input.projectId,
                scope,
                catalogRevision,
                'newer',
                firstSession,
              ),
            }
          : {}),
        nextGroupCursor: groupPage?.nextCursor,
        previousGroupCursor: groupPage?.previousCursor,
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SESSION_CATALOG_PAGE_BYTES) {
        throw new Error('Session navigation exceeds its byte budget.')
      }
      return result
    })
  }

  readSessionCreationState(input: SessionCreationStateInput): SessionCreationState {
    return this.database.transaction((transaction) => {
      const { revision } = SessionRepository.readGroupRevision(transaction, input.projectId)
      const catalogRevision = SessionRepository.readCatalogRevision(transaction)
      const row = transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, input.sessionId), eq(sessions.projectId, input.projectId)))
        .get()
      if (!row) return { state: 'absent', revision, catalogRevision }
      const session = this.find(input.sessionId)
      if (!session) return { state: 'absent', revision, catalogRevision }
      return {
        state: 'present',
        session,
        groupId: session.groupId ?? null,
        revision,
        catalogRevision,
      }
    })
  }

  createSessionGroup(input: CreateSessionGroupInput): SessionGroupMutation {
    const result = this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, input.projectId)
      const project = SessionRepository.readGroupRevision(transaction, input.projectId)
      if (project.revision !== input.expectedRevision) throw new StaleSessionGroupError()
      if (
        transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(eq(sessionGroups.id, input.groupId))
          .get()
      ) {
        throw new Error('This Session group already exists.')
      }
      if (input.sessionId) {
        const session = transaction
          .select({
            projectId: sessions.projectId,
            archivedAt: sessions.archivedAt,
            status: sessions.status,
          })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .get()
        if (
          !session ||
          session.projectId !== input.projectId ||
          session.archivedAt ||
          session.status === 'archived'
        ) {
          throw new Error('The Session no longer belongs to this Project.')
        }
        const membership = transaction
          .select({ groupId: sessionGroupMembers.groupId })
          .from(sessionGroupMembers)
          .where(eq(sessionGroupMembers.sessionId, input.sessionId))
          .get()
        if (membership)
          throw new Error('Move the Session out of its group before creating a group with it.')
      }
      const maxPosition =
        transaction
          .select({ value: sql<number>`coalesce(max(${sessionGroups.position}), -1)` })
          .from(sessionGroups)
          .where(eq(sessionGroups.projectId, input.projectId))
          .get()?.value ?? -1
      const createdAt = new Date().toISOString()
      transaction
        .insert(sessionGroups)
        .values({
          id: input.groupId,
          projectId: input.projectId,
          creationOrdinal: project.nextOrdinal,
          name: input.name,
          color: input.color,
          position: maxPosition + 1,
          collapsed: false,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      const revision = project.revision + 1
      transaction
        .update(projects)
        .set({
          sessionGroupRevision: revision,
          nextSessionGroupOrdinal: project.nextOrdinal + 1,
        })
        .where(eq(projects.id, input.projectId))
        .run()
      if (input.sessionId) {
        transaction
          .insert(sessionGroupMembers)
          .values({
            sessionId: input.sessionId,
            projectId: input.projectId,
            groupId: input.groupId,
          })
          .run()
        SessionRepository.bumpCatalogRevision(transaction)
      }
      const group = transaction
        .select()
        .from(sessionGroups)
        .where(eq(sessionGroups.id, input.groupId))
        .get()
      if (!group) throw new Error('The Session group could not be saved.')
      return { group: toSessionGroup(group), revision }
    })
    return {
      kind: 'group-change',
      revision: result.revision,
      group: result.group,
      ...(input.sessionId
        ? {
            session: this.find(input.sessionId),
            sourceScope: scopeOf(null),
            targetScope: { kind: 'group', groupId: input.groupId } as const,
          }
        : {}),
    }
  }

  updateSessionGroup(input: UpdateSessionGroupInput): SessionGroupMutation {
    return this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, input.projectId)
      const project = SessionRepository.readGroupRevision(transaction, input.projectId)
      if (project.revision !== input.expectedRevision) throw new StaleSessionGroupError()
      const row = transaction
        .select()
        .from(sessionGroups)
        .where(
          and(eq(sessionGroups.projectId, input.projectId), eq(sessionGroups.id, input.groupId)),
        )
        .get()
      if (!row) throw new Error('This Session group no longer exists.')
      const updatedAt = new Date().toISOString()
      transaction
        .update(sessionGroups)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}),
          updatedAt,
        })
        .where(eq(sessionGroups.id, input.groupId))
        .run()
      const revision = project.revision + 1
      transaction
        .update(projects)
        .set({ sessionGroupRevision: revision })
        .where(eq(projects.id, input.projectId))
        .run()
      const group = transaction
        .select()
        .from(sessionGroups)
        .where(eq(sessionGroups.id, input.groupId))
        .get()
      if (!group) throw new Error('This Session group no longer exists.')
      return { kind: 'group-change' as const, revision, group: toSessionGroup(group) }
    })
  }

  moveSessionGroup(input: MoveSessionGroupInput): SessionGroupMutation {
    return this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, input.projectId)
      const project = SessionRepository.readGroupRevision(transaction, input.projectId)
      if (project.revision !== input.expectedRevision) throw new StaleSessionGroupError()
      const moving = transaction
        .select()
        .from(sessionGroups)
        .where(
          and(eq(sessionGroups.projectId, input.projectId), eq(sessionGroups.id, input.groupId)),
        )
        .get()
      if (!moving) throw new Error('This Session group no longer exists.')
      const target = transaction
        .select({ position: sessionGroups.position })
        .from(sessionGroups)
        .where(
          and(
            eq(sessionGroups.projectId, input.projectId),
            input.direction
              ? eq(sessionGroups.position, moving.position + (input.direction === 'up' ? -1 : 1))
              : eq(sessionGroups.id, input.targetGroupId!),
          ),
        )
        .get()
      if (!target && !input.direction) throw new Error('The target Session group no longer exists.')
      const position =
        !target || target.position === moving.position
          ? moving.position
          : input.direction
            ? target.position
            : target.position +
              (input.placement === 'after' ? 1 : 0) -
              (moving.position < target.position ? 1 : 0)
      if (position === moving.position) {
        return {
          kind: 'group-change' as const,
          revision: project.revision,
          group: toSessionGroup(moving),
        }
      }
      const first = Math.min(position, moving.position)
      const last = Math.max(position, moving.position)
      transaction
        .update(sessionGroups)
        .set({ position: sql`-1 - ${sessionGroups.position}` })
        .where(
          and(
            eq(sessionGroups.projectId, input.projectId),
            gte(sessionGroups.position, first),
            lte(sessionGroups.position, last),
          ),
        )
        .run()
      const shift = position < moving.position ? 1 : -1
      transaction
        .update(sessionGroups)
        .set({
          position: sql`case when ${sessionGroups.id} = ${moving.id}
          then ${position} else -1 - ${sessionGroups.position} + ${shift} end`,
        })
        .where(and(eq(sessionGroups.projectId, input.projectId), lt(sessionGroups.position, 0)))
        .run()
      const revision = project.revision + 1
      transaction
        .update(projects)
        .set({ sessionGroupRevision: revision })
        .where(eq(projects.id, input.projectId))
        .run()
      const group = transaction
        .select()
        .from(sessionGroups)
        .where(eq(sessionGroups.id, input.groupId))
        .get()
      if (!group) throw new Error('This Session group no longer exists.')
      return { kind: 'group-change' as const, revision, group: toSessionGroup(group) }
    })
  }

  dissolveSessionGroup(input: DissolveSessionGroupInput): SessionGroupMutation {
    return this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, input.projectId)
      const project = SessionRepository.readGroupRevision(transaction, input.projectId)
      if (project.revision !== input.expectedRevision) throw new StaleSessionGroupError()
      SessionRepository.deleteGroupAndCompact(transaction, input.projectId, input.groupId)
      const revision = project.revision + 1
      transaction
        .update(projects)
        .set({ sessionGroupRevision: revision })
        .where(eq(projects.id, input.projectId))
        .run()
      SessionRepository.bumpCatalogRevision(transaction)
      return {
        kind: 'group-change' as const,
        revision,
        dissolvedGroupId: input.groupId,
        sourceScope: { kind: 'group', groupId: input.groupId } as const,
        targetScope: { kind: 'ungrouped' } as const,
      }
    })
  }

  setSessionGroup(input: SetSessionGroupInput): SessionGroupMutation {
    const result = this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, input.projectId)
      const project = SessionRepository.readGroupRevision(transaction, input.projectId)
      if (project.revision !== input.expectedRevision) throw new StaleSessionGroupError()
      const session = transaction
        .select({
          projectId: sessions.projectId,
          archivedAt: sessions.archivedAt,
          status: sessions.status,
          sidebarHidden: sessions.sidebarHidden,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()
      if (
        !session ||
        session.projectId !== input.projectId ||
        session.archivedAt ||
        session.status === 'archived'
      ) {
        throw new Error('The Session no longer belongs to this Project.')
      }
      if (input.groupId) {
        const group = transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(
            and(eq(sessionGroups.projectId, input.projectId), eq(sessionGroups.id, input.groupId)),
          )
          .get()
        if (!group) throw new Error('The target Session group no longer exists.')
      }
      const member = transaction
        .select({ groupId: sessionGroupMembers.groupId, position: sessionGroupMembers.position })
        .from(sessionGroupMembers)
        .where(eq(sessionGroupMembers.sessionId, input.sessionId))
        .get()
      const previous = member?.groupId ?? null
      const sameGroup = previous === input.groupId
      const placement = input.placement
      let destination = 0
      if (placement && placement.kind !== 'first' && input.groupId) {
        const anchor = transaction
          .select({ position: sessionGroupMembers.position })
          .from(sessionGroupMembers)
          .innerJoin(sessions, eq(sessions.id, sessionGroupMembers.sessionId))
          .where(
            and(
              eq(sessionGroupMembers.groupId, input.groupId),
              eq(sessionGroupMembers.projectId, input.projectId),
              eq(sessionGroupMembers.sessionId, placement.sessionId),
              isNull(sessions.archivedAt),
              ne(sessions.status, 'archived'),
            ),
          )
          .get()
        if (!anchor || placement.sessionId === input.sessionId) throw new StaleSessionGroupError()
        destination = anchor.position + Number(placement.kind === 'after')
        if (sameGroup && member && member.position < destination) destination--
      }
      if (sameGroup && (!placement || member?.position === destination)) {
        return {
          revision: project.revision,
          sourceGroupId: previous,
          targetGroupId: input.groupId,
        }
      }

      if (member) {
        transaction
          .delete(sessionGroupMembers)
          .where(eq(sessionGroupMembers.sessionId, input.sessionId))
          .run()
        if (sameGroup && member.position > destination)
          SessionRepository.shiftMembers(
            transaction,
            input.projectId,
            member.groupId,
            destination,
            1,
            member.position - 1,
          )
        else
          SessionRepository.shiftMembers(
            transaction,
            input.projectId,
            member.groupId,
            member.position + 1,
            -1,
            sameGroup ? destination : undefined,
          )
      }
      if (input.groupId) {
        if (!sameGroup)
          SessionRepository.shiftMembers(
            transaction,
            input.projectId,
            input.groupId,
            destination,
            1,
          )
        transaction
          .insert(sessionGroupMembers)
          .values({
            sessionId: input.sessionId,
            projectId: input.projectId,
            groupId: input.groupId,
            position: destination,
          })
          .run()
        transaction
          .update(sessionGroups)
          .set({ collapsed: false })
          .where(and(eq(sessionGroups.id, input.groupId), eq(sessionGroups.collapsed, true)))
          .run()
      }
      const dissolvedGroupId =
        previous && !sameGroup && !session.sidebarHidden
          ? SessionRepository.dissolveIfSidebarEmpty(transaction, input.projectId, previous)
          : undefined
      const revision = project.revision + 1
      transaction
        .update(projects)
        .set({ sessionGroupRevision: revision })
        .where(eq(projects.id, input.projectId))
        .run()
      SessionRepository.bumpCatalogRevision(transaction)
      return {
        revision,
        dissolvedGroupId,
        sourceGroupId: previous,
        targetGroupId: input.groupId,
      }
    })
    return {
      kind: 'group-change',
      revision: result.revision,
      dissolvedGroupId: result.dissolvedGroupId,
      session: this.find(input.sessionId),
      sourceScope: scopeOf(result.sourceGroupId),
      targetScope: scopeOf(result.targetGroupId),
    }
  }

  private static shiftMembers(
    transaction: DrizzleTransaction,
    projectId: string,
    groupId: string,
    from: number,
    offset: -1 | 1,
    to?: number,
  ): void {
    const scope = and(
      eq(sessionGroupMembers.projectId, projectId),
      eq(sessionGroupMembers.groupId, groupId),
    )
    // The negative range lets SQLite enforce uniqueness throughout both updates.
    transaction
      .update(sessionGroupMembers)
      .set({ position: sql`-1 - ${sessionGroupMembers.position}` })
      .where(
        and(
          scope,
          gte(sessionGroupMembers.position, from),
          to === undefined ? undefined : lte(sessionGroupMembers.position, to),
        ),
      )
      .run()
    transaction
      .update(sessionGroupMembers)
      .set({ position: sql`-1 - ${sessionGroupMembers.position} + ${offset}` })
      .where(and(scope, lt(sessionGroupMembers.position, 0)))
      .run()
  }

  private static dissolveIfSidebarEmpty(
    transaction: DrizzleTransaction,
    projectId: string,
    groupId: string,
  ): string | undefined {
    const visibleMember = transaction
      .select({ id: sessionGroupMembers.sessionId })
      .from(sessionGroupMembers)
      .innerJoin(sessions, eq(sessions.id, sessionGroupMembers.sessionId))
      .where(
        and(
          eq(sessionGroupMembers.groupId, groupId),
          eq(sessionGroupMembers.projectId, projectId),
          sidebarVisible,
        ),
      )
      .limit(1)
      .get()
    if (visibleMember) return undefined
    SessionRepository.deleteGroupAndCompact(transaction, projectId, groupId)
    return groupId
  }

  private static deleteGroupAndCompact(
    transaction: DrizzleTransaction,
    projectId: string,
    groupId: string,
  ): void {
    const row = transaction
      .select()
      .from(sessionGroups)
      .where(and(eq(sessionGroups.projectId, projectId), eq(sessionGroups.id, groupId)))
      .get()
    if (!row) throw new Error('This Session group no longer exists.')
    transaction.delete(sessionGroups).where(eq(sessionGroups.id, groupId)).run()
    transaction
      .update(sessionGroups)
      .set({ position: sql`-1 - ${sessionGroups.position}` })
      .where(and(eq(sessionGroups.projectId, projectId), gt(sessionGroups.position, row.position)))
      .run()
    transaction
      .update(sessionGroups)
      .set({ position: sql`-2 - ${sessionGroups.position}` })
      .where(and(eq(sessionGroups.projectId, projectId), lt(sessionGroups.position, 0)))
      .run()
  }

  private static readCatalogRevision(transaction: DrizzleTransaction): number {
    const row = transaction
      .select({ revision: sessionCatalogRevisions.revision })
      .from(sessionCatalogRevisions)
      .where(eq(sessionCatalogRevisions.id, 1))
      .get()
    if (!row) throw new Error('Session Catalog revision is unavailable.')
    return row.revision
  }

  private static bumpCatalogRevision(transaction: DrizzleTransaction): void {
    transaction
      .update(sessionCatalogRevisions)
      .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
      .where(eq(sessionCatalogRevisions.id, 1))
      .run()
  }

  private static readGroupRevision(
    transaction: DrizzleTransaction,
    projectId: string,
    scope: 'all' | 'visible' = 'all',
  ): { revision: number; nextOrdinal: number } {
    const row = transaction
      .select({
        revision: projects.sessionGroupRevision,
        nextOrdinal: projects.nextSessionGroupOrdinal,
      })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          scope === 'visible' ? isNull(projects.archivedAt) : undefined,
        ),
      )
      .get()
    if (!row) throw new Error('Project no longer exists.')
    return row
  }

  private static readMembership(
    transaction: DrizzleTransaction,
    input: SessionMembershipInput,
    revision: number,
  ): SessionMembership {
    const session = transaction
      .select({
        id: sessions.id,
        projectId: sessions.projectId,
        status: sessions.status,
        archivedAt: sessions.archivedAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(eq(sessions.id, input.sessionId), eq(sessions.projectId, input.projectId)))
      .get()
    if (!session) {
      return {
        exists: false,
        sessionId: input.sessionId,
        projectId: input.projectId,
        groupId: null,
        archived: false,
        revision,
      }
    }
    const membership = transaction
      .select({ groupId: sessionGroupMembers.groupId, position: sessionGroupMembers.position })
      .from(sessionGroupMembers)
      .where(eq(sessionGroupMembers.sessionId, input.sessionId))
      .get()
    const neighbors = membership
      ? transaction
          .select({ id: sessionGroupMembers.sessionId, position: sessionGroupMembers.position })
          .from(sessionGroupMembers)
          .where(
            and(
              eq(sessionGroupMembers.projectId, input.projectId),
              eq(sessionGroupMembers.groupId, membership.groupId),
              inArray(sessionGroupMembers.position, [
                membership.position - 1,
                membership.position + 1,
              ]),
            ),
          )
          .all()
      : []
    return {
      exists: true,
      sessionId: input.sessionId,
      projectId: input.projectId,
      groupId: membership?.groupId ?? null,
      archived: Boolean(session.archivedAt) || session.status === 'archived',
      createdAt: session.createdAt,
      groupPosition: membership?.position,
      previousSessionId:
        membership && neighbors.find((row) => row.position < membership.position)?.id,
      nextSessionId: membership && neighbors.find((row) => row.position > membership.position)?.id,
      revision,
    }
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

    const membership = this.database
      .select({ groupId: sessionGroupMembers.groupId })
      .from(sessionGroupMembers)
      .where(eq(sessionGroupMembers.sessionId, sessionId))
      .get()
    const projected = row
      ? SessionRepository.toSession(
          row.session,
          row.settings,
          latestRun,
          latestCompletedMessage?.sequence,
          membership?.groupId ?? null,
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

  create(
    record: NewSessionRecord,
    settings: DefaultSessionSettings,
    groupId: string | null = null,
    expectedGroupRevision?: number,
  ): SessionCatalogChange {
    const groupRevision = this.database.transaction((transaction) => {
      assertProjectAvailable(transaction, record.projectId)
      const grouping = groupId
        ? SessionRepository.readGroupRevision(transaction, record.projectId)
        : undefined
      if (grouping && grouping.revision !== expectedGroupRevision) {
        throw new StaleSessionGroupError()
      }
      if (groupId) {
        const group = transaction
          .select({ id: sessionGroups.id })
          .from(sessionGroups)
          .where(and(eq(sessionGroups.projectId, record.projectId), eq(sessionGroups.id, groupId)))
          .get()
        if (!group) throw new Error('The target Session group no longer exists.')
      }
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
      if (groupId) {
        SessionRepository.shiftMembers(transaction, record.projectId, groupId, 0, 1)
        transaction
          .insert(sessionGroupMembers)
          .values({ sessionId: record.id, projectId: record.projectId, groupId, position: 0 })
          .run()
        if (grouping) {
          transaction
            .update(projects)
            .set({ sessionGroupRevision: grouping.revision + 1 })
            .where(eq(projects.id, record.projectId))
            .run()
        }
      }
      SessionRepository.bumpCatalogRevision(transaction)
      return grouping ? grouping.revision + 1 : undefined
    })
    return { ...this.change(record.id), groupRevision }
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
        .set({ status: 'draft', archivedAt: null, sidebarHidden: false, updatedAt: restoredAt })
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

  setSidebarHidden(input: SessionSidebarHiddenInput): SessionCatalogChange {
    return this.database.transaction((transaction) => {
      const row = transaction
        .select({ projectId: sessions.projectId, groupId: sessionGroupMembers.groupId })
        .from(sessions)
        .leftJoin(sessionGroupMembers, eq(sessionGroupMembers.sessionId, sessions.id))
        .where(
          and(
            eq(sessions.id, input.sessionId),
            isNull(sessions.archivedAt),
            ne(sessions.status, 'archived'),
          ),
        )
        .get()
      if (!row) throw new Error('This Session is no longer available.')
      assertProjectAvailable(transaction, row.projectId)
      let { revision } = SessionRepository.readGroupRevision(transaction, row.projectId)
      const updated = transaction
        .update(sessions)
        .set({ sidebarHidden: input.hidden })
        .where(and(eq(sessions.id, input.sessionId), ne(sessions.sidebarHidden, input.hidden)))
        .run()
      const dissolvedGroupId =
        updated.changes && input.hidden && row.groupId
          ? SessionRepository.dissolveIfSidebarEmpty(transaction, row.projectId, row.groupId)
          : undefined
      if (updated.changes) {
        revision += 1
        transaction
          .update(projects)
          .set({ sessionGroupRevision: revision })
          .where(eq(projects.id, row.projectId))
          .run()
        SessionRepository.bumpCatalogRevision(transaction)
      }
      return {
        ...this.change(input.sessionId),
        groupRevision: revision,
        ...(dissolvedGroupId ? { dissolvedGroupId } : {}),
      }
    })
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
    groupId: string | null = null,
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
    if (groupId) result.groupId = groupId
    if (session.archivedAt) result.archivedAt = session.archivedAt
    if (session.sidebarHidden) result.sidebarHidden = true
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
