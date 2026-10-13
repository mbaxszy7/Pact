import { and, asc, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest'

import { SESSION_CATALOG_PAGE_BYTES } from '@pact/contracts'

import { copyLegacyDatabase } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  conversationMessages,
  projects,
  sessionSettingsRevisions,
  sessions,
} from './schema/index.js'
import { OversizedCatalogSessionError, StaleCatalogCursorError } from './session-repository.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const createdAt = '2026-09-24T00:00:00.000Z'

describe('SessionRepository Catalog projection', () => {
  it('rebuilds lookup indexes when an existing database receives the migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-catalog-upgrade-'))
    const filePath = join(directory, 'pact.sqlite')
    let database: PactDatabase | undefined
    try {
      database = await PactDatabase.open({ filePath, migrationsFolder })
      const projectId = randomUUID()
      const sessionId = randomUUID()
      database.drizzle
        .insert(projects)
        .values({
          id: projectId,
          name: 'Existing Catalog',
          directoryPath: join(directory, 'project'),
          kind: 'directory',
          createdAt,
        })
        .run()
      database.drizzle
        .insert(sessions)
        .values({
          id: sessionId,
          projectId,
          title: 'Preserved Session',
          status: 'idle',
          settingsRevision: 1,
          lastSeenMessageSequence: -1,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      database.drizzle
        .insert(sessionSettingsRevisions)
        .values({
          sessionId,
          revision: 1,
          primaryAgentId: 'codex',
          claudeModel: null,
          claudeEffort: null,
          codexModel: null,
          codexEffort: null,
          maxDiscussionRounds: 6,
          runningMessagePolicy: 'immediate_safe_point',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
          createdAt,
        })
        .run()
      const legacyPath = join(directory, 'legacy.sqlite')
      copyLegacyDatabase(database, legacyPath, migrationsFolder, 14)
      database.close()
      database = await PactDatabase.open({ filePath: legacyPath, migrationsFolder })
      expect(database.sessionRepository.readPage(projectId).sessions).toMatchObject([
        { id: sessionId, title: 'Preserved Session', activity: { state: 'idle' } },
      ])
      const indexes = database.drizzle.all(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'agent_runs_session_created_idx',
          'conversation_messages_session_role_state_sequence_idx',
          'conversation_messages_run_role_idx'
        )
      `)
      expect(indexes).toHaveLength(3)
      expect(
        database.drizzle.all(sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'sessions_project_created_id_active_idx'
        `),
      ).toHaveLength(1)
    } finally {
      database?.close()
      await rm(directory, { recursive: true })
    }
  })

  it('uses one latest Run and completed Assistant sequence per Session without loading history', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const projectId = randomUUID()
      const activeId = randomUUID()
      const archivedId = randomUUID()
      const noRunId = randomUUID()
      database.drizzle
        .insert(projects)
        .values({
          id: projectId,
          name: 'Catalog fixture',
          directoryPath: '/opt/pact-catalog-fixture',
          kind: 'git',
          createdAt,
        })
        .run()
      for (const [id, status] of [
        [activeId, 'discussing'],
        [archivedId, 'archived'],
        [noRunId, 'discussing'],
      ] as const) {
        database.drizzle
          .insert(sessions)
          .values({
            id,
            projectId,
            title: 'Catalog session',
            status,
            settingsRevision: 1,
            lastSeenMessageSequence: -1,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        database.drizzle
          .insert(sessionSettingsRevisions)
          .values({
            sessionId: id,
            revision: 1,
            primaryAgentId: 'codex',
            claudeModel: null,
            claudeEffort: null,
            codexModel: null,
            codexEffort: null,
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
            createdAt,
          })
          .run()
      }
      for (const [status, agentId] of [
        ['completed', 'claude'],
        ['failed', 'codex'],
      ] as const) {
        database.drizzle
          .insert(agentRuns)
          .values({
            id: randomUUID(),
            sessionId: activeId,
            userMessageId: randomUUID(),
            agentId,
            status,
            attemptCount: 1,
            settingsRevision: 1,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
      }
      for (const [sequence, role, state] of [
        [2, 'assistant', 'complete'],
        [5, 'assistant', 'complete'],
        [6, 'user', 'complete'],
        [7, 'assistant', 'incomplete'],
      ] as const) {
        database.drizzle
          .insert(conversationMessages)
          .values({
            id: randomUUID(),
            sessionId: activeId,
            role,
            content: `message-${sequence}`,
            state,
            sequence,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
      }

      const catalog = database.sessionRepository.readPage(projectId)
      const active = catalog.sessions.find((session) => session.id === activeId)
      const archived = database.sessionRepository.find(archivedId)
      const noRun = catalog.sessions.find((session) => session.id === noRunId)
      expect(catalog.sessions).toHaveLength(2)
      expect(active).toMatchObject({
        activity: { state: 'error', agentId: 'codex' },
        hasUnread: true,
      })
      expect(database.sessionRepository.find(activeId)).toEqual(active)
      expect(archived).toMatchObject({ status: 'archived', activity: { state: 'idle' } })
      expect(noRun).toMatchObject({ activity: { state: 'idle' }, hasUnread: false })
      expect(noRun?.activity).not.toHaveProperty('agentId')

      expect(database.sessionRepository.markRead(activeId, 5).session.hasUnread).toBe(false)
      const changesBeforeNoOp = totalChanges(database)
      database.sessionRepository.markRead(activeId, 5)
      database.sessionRepository.markRead(activeId, 4)
      expect(totalChanges(database)).toBe(changesBeforeNoOp)
      expect(
        database.drizzle
          .select({ sequence: sessions.lastSeenMessageSequence })
          .from(sessions)
          .where(eq(sessions.id, activeId))
          .get()?.sequence,
      ).toBe(5)

      const plan = database.drizzle.all(sql`
        EXPLAIN QUERY PLAN
        SELECT
          (SELECT id FROM agent_runs WHERE session_id = s.id
           ORDER BY created_at DESC, rowid DESC LIMIT 1),
          (SELECT sequence FROM conversation_messages
           WHERE session_id = s.id AND role = 'assistant' AND state = 'complete'
           ORDER BY sequence DESC LIMIT 1)
        FROM sessions AS s
      `)
      const details = plan
        .map((row) => {
          if (!row || typeof row !== 'object') throw new Error('Invalid EXPLAIN row.')
          return String(Reflect.get(row, 'detail'))
        })
        .join('\n')
      expect(details).toContain('agent_runs_session_created_idx')
      expect(details).toContain('conversation_messages_session_role_state_sequence_idx')
      expect(details).not.toMatch(/SCAN (?:agent_runs|conversation_messages)/u)
      expect(details).not.toContain('USE TEMP B-TREE')
    } finally {
      database.close()
    }
  })

  it('paginates newest created Sessions with deterministic ties and rejects stale cursors', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Paged Catalog',
        directoryPath: '/opt/pact-paged-catalog',
        kind: 'git',
        createdAt,
      })
      const ids = Array.from({ length: 8 }, () => randomUUID())
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]
        if (!id) continue
        database.sessionRepository.create(
          {
            id,
            projectId,
            title: `Session ${index}`,
            createdAt: new Date(Date.parse(createdAt) + Math.min(index, 6)).toISOString(),
          },
          {
            primaryAgentId: 'codex',
            agents: {
              claude: { model: null, effort: null },
              codex: { model: null, effort: null },
            },
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        )
      }
      database.sessionRepository.archive(ids[2]!)
      const expected = ids
        .map((id, index) => ({ id, timestamp: Math.min(index, 6) }))
        .filter(({ id }) => id !== ids[2])
        .toSorted(
          (left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id),
        )
        .map(({ id }) => id)

      const first = database.sessionRepository.readPage(projectId)
      expect(first.sessions.map(({ id }) => id)).toEqual(expected.slice(0, 5))
      expect(first.nextCursor).toMatchObject({ id: expected[4], revision: first.revision })
      const cursor = first.nextCursor
      if (!cursor) throw new Error('Expected a second Catalog page.')
      const second = database.sessionRepository.readPage(projectId, cursor)
      expect(second.sessions.map(({ id }) => id)).toEqual(expected.slice(5))
      expect(second.nextCursor).toBeUndefined()
      const plan = database.drizzle.all(sql`
        EXPLAIN QUERY PLAN
        SELECT id FROM sessions
        WHERE project_id = ${projectId} AND status <> 'archived'
          AND (created_at < ${cursor.createdAt}
            OR (created_at = ${cursor.createdAt} AND id < ${cursor.id}))
        ORDER BY created_at DESC, id DESC
        LIMIT 6
      `)
      const planDetails = plan
        .map((row) => {
          if (!row || typeof row !== 'object') throw new Error('Invalid EXPLAIN row.')
          return String(Reflect.get(row, 'detail'))
        })
        .join('\n')
      expect(planDetails).toContain('sessions_project_created_id_active_idx')
      expect(planDetails).not.toContain('USE TEMP B-TREE')
      expect(() => database.sessionRepository.readPage(randomUUID(), cursor)).toThrow(
        StaleCatalogCursorError,
      )
      database.sessionRepository.rename(ids[0]!, 'Renamed')
      expect(() => database.sessionRepository.readPage(projectId, cursor)).toThrow(
        StaleCatalogCursorError,
      )
    } finally {
      database.close()
    }
  })

  it('ends a page before its byte limit and visibly rejects one oversized Session', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Byte-limited Catalog',
        directoryPath: '/opt/pact-byte-limited-catalog',
        kind: 'git',
        createdAt,
      })
      const ids = Array.from({ length: 5 }, () => randomUUID())
      for (const [index, id] of ids.entries()) {
        database.sessionRepository.create(
          {
            id,
            projectId,
            title: `Session ${index}`,
            createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
          },
          {
            primaryAgentId: 'codex',
            agents: {
              claude: { model: null, effort: null },
              codex: { model: null, effort: null },
            },
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        )
        database.drizzle
          .update(sessionSettingsRevisions)
          .set({ codexModel: 'x'.repeat(300_000) })
          .where(eq(sessionSettingsRevisions.sessionId, id))
          .run()
      }
      const first = database.sessionRepository.readPage(projectId)
      expect(first.sessions).toHaveLength(3)
      expect(first.nextCursor).toBeDefined()
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(
        SESSION_CATALOG_PAGE_BYTES,
      )
      expect(
        database.sessionRepository.readPage(projectId, first.nextCursor).sessions,
      ).toHaveLength(2)
      database.drizzle
        .update(sessionSettingsRevisions)
        .set({ codexModel: 'x'.repeat(1_100_000) })
        .where(eq(sessionSettingsRevisions.sessionId, ids[4]!))
        .run()
      expect(() => database.sessionRepository.readPage(projectId)).toThrow(
        OversizedCatalogSessionError,
      )
    } finally {
      database.close()
    }
  })
})

function totalChanges(database: PactDatabase): number {
  const rows = database.drizzle.all(sql`SELECT total_changes() AS changes`)
  const row = rows[0]
  if (!row || typeof row !== 'object') throw new Error('SQLite did not return a change row.')
  const changes: unknown = Reflect.get(row, 'changes')
  if (typeof changes !== 'number') throw new Error('SQLite did not return total_changes().')
  return changes
}

// Vitest only provides the bench fixture in benchmark mode. Keep the fixture beside
// the Catalog correctness tests without adding timing assertions to `pnpm test`.
const viteEnvironment: unknown = Reflect.get(import.meta, 'env')
const benchmarkMode =
  viteEnvironment &&
  typeof viteEnvironment === 'object' &&
  'MODE' in viteEnvironment &&
  viteEnvironment.MODE === 'benchmark'

describe.each([
  { sessionCount: 100, history: 10 },
  { sessionCount: 100, history: 100 },
  { sessionCount: 1_000, history: 10 },
  { sessionCount: 1_000, history: 100 },
])(
  'CatalogBenchmark: $sessionCount Sessions, 90% archived, $history historical pairs each',
  ({ sessionCount, history }) => {
    let database: PactDatabase
    let projectId: string

    beforeAll(async () => {
      database = await seedCatalogBenchmark(sessionCount, history)
      const project = database.drizzle.select({ id: projects.id }).from(projects).get()
      if (!project) throw new Error('Catalog benchmark Project is missing.')
      projectId = project.id
    }, 120_000)

    afterAll(() => database?.close())

    test.skipIf(!benchmarkMode)(
      'compares historical aggregation with the indexed first Catalog page',
      async ({ bench }) => {
        await bench.compare(
          bench('baseline historical JavaScript aggregation', () => {
            // Reproduces b572b02's historical queries/maps, but omits its final
            // object projection; the baseline therefore understates old cost.
            const catalogRows = database.drizzle
              .select({ session: sessions, settings: sessionSettingsRevisions })
              .from(sessions)
              .innerJoin(
                sessionSettingsRevisions,
                and(
                  eq(sessionSettingsRevisions.sessionId, sessions.id),
                  eq(sessionSettingsRevisions.revision, sessions.settingsRevision),
                ),
              )
              .orderBy(asc(sessions.createdAt))
              .all()
            const runRows = database.drizzle
              .select()
              .from(agentRuns)
              .orderBy(asc(agentRuns.createdAt))
              .all()
            const messageRows = database.drizzle
              .select({
                sessionId: conversationMessages.sessionId,
                sequence: conversationMessages.sequence,
              })
              .from(conversationMessages)
              .where(
                and(
                  eq(conversationMessages.role, 'assistant'),
                  eq(conversationMessages.state, 'complete'),
                ),
              )
              .orderBy(asc(conversationMessages.sequence))
              .all()
            const latestRuns = new Map(runRows.map((run) => [run.sessionId, run]))
            const latestMessages = new Map(
              messageRows.map((message) => [message.sessionId, message.sequence]),
            )
            if (
              catalogRows.length !== sessionCount ||
              latestRuns.size !== sessionCount ||
              latestMessages.size !== sessionCount
            ) {
              throw new Error('Catalog benchmark fixture is incomplete.')
            }
          }),

          bench('indexed SessionRepository.readPage first five', () => {
            if (database.sessionRepository.readPage(projectId).sessions.length !== 5) {
              throw new Error('Catalog benchmark projection is incomplete.')
            }
          }),
        )
        expect(database.sessionRepository.readPage(projectId).sessions).toHaveLength(5)
      },
    )
  },
)

async function seedCatalogBenchmark(
  sessionCount: number,
  historicalRowsPerSession: number,
): Promise<PactDatabase> {
  const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  try {
    const projectId = randomUUID()
    database.drizzle
      .insert(projects)
      .values({
        id: projectId,
        name: 'Catalog benchmark',
        directoryPath: '/opt/pact-catalog-benchmark',
        kind: 'git',
        createdAt,
      })
      .run()
    database.drizzle.transaction((transaction) => {
      for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = randomUUID()
        transaction
          .insert(sessions)
          .values({
            id: sessionId,
            projectId,
            title: `Session ${index}`,
            status: index % 10 === 0 ? 'idle' : 'archived',
            ...(index % 10 === 0 ? {} : { archivedAt: createdAt }),
            settingsRevision: 1,
            lastSeenMessageSequence: -1,
            createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
            updatedAt: createdAt,
          })
          .run()
        transaction
          .insert(sessionSettingsRevisions)
          .values({
            sessionId,
            revision: 1,
            primaryAgentId: 'codex',
            claudeModel: null,
            claudeEffort: null,
            codexModel: null,
            codexEffort: null,
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
            createdAt,
          })
          .run()
        for (let sequence = 1; sequence <= historicalRowsPerSession; sequence += 1) {
          const timestamp = new Date(Date.parse(createdAt) + sequence).toISOString()
          transaction
            .insert(agentRuns)
            .values({
              id: randomUUID(),
              sessionId,
              userMessageId: randomUUID(),
              agentId: 'codex',
              status: 'completed',
              attemptCount: 1,
              settingsRevision: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .run()
          transaction
            .insert(conversationMessages)
            .values({
              id: randomUUID(),
              sessionId,
              role: 'assistant',
              content: `answer ${sequence}`,
              state: 'complete',
              sequence,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .run()
        }
      }
    })
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
