import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PactDatabase, agentRuns, agentRunActivities } from './index.js'
const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
describe('Indexed streaming history isolation', () => {
  it.each([1_000, 10_000])(
    'bounds changed-entity reads/writes with %i completed steps and 10× unrelated steps',
    async (history) => {
      const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
      try {
        const sessionId = randomUUID(),
          projectId = randomUUID(),
          createdAt = new Date().toISOString()
        db.projectCatalogRepository.add({
          id: projectId,
          name: 'Fixture',
          directoryPath: '/fixture',
          kind: 'git',
          createdAt,
        })
        db.sessionRepository.create(
          { id: sessionId, projectId, title: 'Stream', createdAt },
          {
            primaryAgentId: 'codex',
            agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
            maxDiscussionRounds: 6,

            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        )
        const legacyRunId = randomUUID()
        db.drizzle
          .insert(agentRuns)
          .values({
            id: legacyRunId,
            sessionId,
            userMessageId: randomUUID(),
            agentId: 'codex',
            status: 'completed',
            attemptCount: 1,
            settingsRevision: 1,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: createdAt,
          })
          .run()
        const current = db.conversationRepository.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: 'Current request',
          expectedCommentsRevision: 0,
          commentIds: [],
          agentId: 'codex',
          settingsRevision: 1,
          model: null,
          effort: null,
        })
        db.conversationRepository.applyEvent(sessionId, current.run.id, {
          agentId: 'codex',
          type: 'text.delta',
          turnId: 'turn',
          outputId: 'output',
          text: 'Initial',
        })
        const count = history * 11 + 10
        db.drizzle.transaction((tx) => {
          for (let start = 0; start < count; start += 1_000) {
            tx.insert(agentRunActivities)
              .values(
                Array.from({ length: Math.min(1_000, count - start) }, (_, offset) => {
                  const sequence = start + offset,
                    target = sequence < history + 10
                  return {
                    id: randomUUID(),
                    sessionId,
                    runId: target ? current.run.id : legacyRunId,
                    agentId: 'codex' as const,
                    nativeId: `activity-${sequence}`,
                    kind: 'reasoning' as const,
                    title: 'Reasoning',
                    detail: 'Existing step',
                    status: sequence < 10 ? ('running' as const) : ('completed' as const),
                    sequence,
                    createdAt,
                    updatedAt: createdAt,
                  }
                }),
              )
              .run()
          }
        })
        const plan = db.drizzle
          .all<{ detail: string }>(
            sql`EXPLAIN QUERY PLAN UPDATE agent_run_activities SET status='completed' WHERE run_id=${current.run.id} AND status='running'`,
          )
          .map((row) => row.detail)
          .join('\n')
        expect(plan).toContain('agent_run_activities_run_status_idx')
        expect(plan).not.toContain('SCAN ')
        expect(
          db.drizzle.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM agent_run_activities WHERE run_id=${current.run.id} AND status='running'`,
          )?.count,
        ).toBe(10)
        const before = db.conversationRepository.diagnostics()
        const changes = db.drizzle.get<{ count: number }>(
          sql`SELECT total_changes() AS count`,
        ).count
        db.conversationRepository.applyStreamBatch(sessionId, current.run.id, [
          {
            agentId: 'codex',
            type: 'text.delta',
            turnId: 'turn',
            outputId: 'output',
            text: ' tail',
          },
          {
            agentId: 'codex',
            type: 'reasoning.summary.delta',
            turnId: 'turn',
            activityId: 'activity-0',
            text: ' new detail',
          },
        ])
        const after = db.conversationRepository.diagnostics()
        expect(after.completeReads).toBe(0)
        expect(after.eventTransactions - before.eventTransactions).toBe(1)
        expect(after.streamLookups.text.queries - before.streamLookups.text.queries).toBe(1)
        expect(after.streamLookups.text.returnedRows - before.streamLookups.text.returnedRows).toBe(
          1,
        )
        expect(after.streamLookups.activity.queries - before.streamLookups.activity.queries).toBe(1)
        expect(
          after.streamLookups.activity.returnedRows - before.streamLookups.activity.returnedRows,
        ).toBe(1)
        expect(
          db.drizzle.get<{ count: number }>(sql`SELECT total_changes() AS count`).count - changes,
        ).toBe(3)
      } finally {
        db.close()
      }
    },
    // Includes creating 110,010 real rows on hosted runners; the unchanged query,
    // returned-row and write-count assertions enforce changed-entity work.
    30_000,
  )
})
