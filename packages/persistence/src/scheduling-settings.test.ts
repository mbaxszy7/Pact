import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { schedulingActivityPageSchema } from '@pact/contracts'

import { refreshNativeRebuildActivityForRecovery } from './conversation-scheduling-activity.js'
import { PactDatabase } from './pact-database.js'
import { schedulingActivity, schedulingEvaluations, schedulingHandoffs } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const databases = new Set<PactDatabase>(),
  directories: string[] = []
const defaults = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const
afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder, measurePerformance: true })
  databases.add(db)
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Activity project',
    directoryPath: '/scheduling-fixture',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Activity session', createdAt: now },
    defaults,
  )
  const handoffId = 'a'.repeat(64)
  db.drizzle
    .insert(schedulingHandoffs)
    .values({
      id: handoffId,
      sessionId,
      budgetSubjectId: `input:${randomUUID()}`,
      eventId: 'stored-event',
      slot: 'workflow_next',
      factFingerprint: 'b'.repeat(64),
      freshnessGuardJson: '{}',
      createdAt: now,
    })
    .run()
  const seed = (count: number, start: number, ageDays: number, active = false) => {
    const ids: string[] = []
    db.drizzle.transaction((transaction) => {
      for (let i = 0; i < count; i++) {
        const id = randomUUID()
        const createdAt = new Date(
          Date.now() - ageDays * 86400_000 - (start + i) * 1000,
        ).toISOString()
        ids.push(id)
        transaction
          .insert(schedulingEvaluations)
          .values({
            id,
            sessionId,
            handoffId,
            budgetSubjectId: `input:${id}`,
            factFingerprint: id.replaceAll('-', '').padEnd(64, '0'),
            provider: 'codex',
            model: 'gpt-6-luna',
            configurationFingerprint: 'c'.repeat(64),
            handoffJson: '{}',
            active,
            called: !active,
            outcome: active ? 'possibly_sent' : 'completed',
            createdAt,
            deadline: now,
            settledAt: active ? null : now,
          })
          .run()
        // This historical fixture supplies source facts and their derived projection
        // together; current execution producers write the same projection transactionally.
        transaction
          .insert(schedulingActivity)
          .values({
            id,
            sessionId,
            evaluationId: id,
            handoffId,
            reason: 'workflow',
            unresolved: active,
            activityAt: createdAt,
          })
          .run()
      }
    })
    return ids
  }
  return { db, repo: db.conversationRepository, projectId, sessionId, handoffId, seed }
}

describe('Global Relay settings and authoritative activity', () => {
  it('uses only the indexed live-obligation range for bounded startup native rebuild projection', async () => {
    const f = await fixture()
    f.seed(1, 0, 1, true)
    f.seed(10_000, 1, 60)
    const before = f.db.performanceDiagnostics()!.sqlite
    refreshNativeRebuildActivityForRecovery(f.db.drizzle, [f.sessionId])
    const after = f.db.performanceDiagnostics()!.sqlite
    expect(after.operations - before.operations).toBe(1)
    expect(after.rowsReturned - before.rowsReturned).toBe(0)
    const plans = after.queryPlans.filter((plan) =>
      plan.details.some((detail) => detail.includes('scheduling_activity_unresolved')),
    )
    expect(plans).toHaveLength(1)
    expect(
      plans[0]!.details.some((detail) =>
        detail.includes(
          'SEARCH scheduling_activity USING INDEX scheduling_activity_unresolved (unresolved=?)',
        ),
      ),
    ).toBe(true)
    console.info(
      'Relay startup native activity EXPLAIN QUERY PLAN:',
      JSON.stringify(plans[0]!.details),
    )
    expect(() =>
      refreshNativeRebuildActivityForRecovery(
        f.db.drizzle,
        Array.from({ length: 26 }, () => f.sessionId),
      ),
    ).toThrow('page exceeds its budget')
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_activity`)).toEqual({
      count: 10_001,
    })
  })

  it('defaults Off without a model, saves with CAS independently from Session defaults/settings and survives restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-relay-settings-'))
    directories.push(directory)
    const file = join(directory, 'pact.sqlite'),
      f = await fixture(file)
    f.db.defaultSessionSettingsRepository.save(defaults)
    const beforeDefaults = f.db.defaultSessionSettingsRepository.read(),
      beforeSession = f.db.sessionRepository.find(f.sessionId)
    expect(f.repo.schedulingSettings()).toEqual({
      enabled: false,
      selection: null,
      showIndicator: true,
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    })
    let events = 0
    const unsubscribe = f.repo.subscribeSchedulingChanges(() => {
      events++
    })
    const first = f.repo.saveSchedulingSettings({ expectedRevision: 0, enabled: true })
    expect(first).toMatchObject({
      enabled: true,
      selection: null,
      showIndicator: true,
      revision: 1,
    })
    expect(() =>
      f.repo.saveSchedulingSettings({ expectedRevision: 0, showIndicator: false }),
    ).toThrow(/changed/u)
    const selected = f.repo.saveSchedulingSettings({
      expectedRevision: 1,
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
      showIndicator: false,
    })
    const saved = f.repo.saveSchedulingSettings({
      expectedRevision: selected.revision,
      enabled: false,
    })
    expect(saved).toMatchObject({
      enabled: false,
      selection: selected.selection,
      showIndicator: false,
      revision: 3,
    })
    expect(f.db.defaultSessionSettingsRepository.read()).toEqual(beforeDefaults)
    expect(f.db.sessionRepository.find(f.sessionId)).toEqual(beforeSession)
    expect(events).toBe(3)
    unsubscribe()
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 0 })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(3)
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({ filePath: file, migrationsFolder })
    databases.add(reopened)
    expect(reopened.conversationRepository.schedulingSettings()).toEqual(saved)
    expect(reopened.conversationRepository.schedulingConfigurationGeneration()).toBe(3)
    expect(reopened.sessionRepository.find(f.sessionId)).toEqual(beforeSession)
    expect(reopened.conversationRepository.readSchedulingActivity({}).rows).toEqual([])
  })

  it('projects only recorded evaluations, includes old unresolved facts and keeps forward/backward keysets exact', async () => {
    const f = await fixture()
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([]) // An ordinary handoff is not a helper invocation.
    const recent = f.seed(63, 0, 1),
      unresolved = f.seed(1, 0, 45, true)
    f.seed(80, 0, 45)
    const first = f.repo.readSchedulingActivity({}),
      all = [...first.rows]
    expect(first.rows).toHaveLength(25)
    expect(
      first.rows.every(
        (row) =>
          row.suggestion === null &&
          row.model === 'gpt-6-luna' &&
          row.project === 'Activity project',
      ),
    ).toBe(true)
    let cursor = first.nextCursor
    while (cursor) {
      const page = f.repo.readSchedulingActivity({ cursor, direction: 'older' })
      expect(schedulingActivityPageSchema.safeParse(page).success).toBe(true)
      expect(page.asOf).toBe(first.asOf)
      all.push(...page.rows)
      cursor = page.nextCursor
    }
    expect(all).toHaveLength(64)
    expect(new Set(all.map((row) => row.id))).toEqual(new Set([...recent, ...unresolved]))
    expect(all.at(-1)).toMatchObject({
      id: unresolved[0],
      result: 'possibly_sent',
      physicalUnconfirmed: true,
      called: false,
      suggestion: null,
    })
    const backwards = f.repo.readSchedulingActivity({
      direction: 'newer',
      cursor: { asOf: first.asOf, createdAt: all[50]!.createdAt, id: all[50]!.id },
    })
    expect(backwards.rows.map((row) => row.id)).toEqual(all.slice(25, 50).map((row) => row.id))
    expect(Buffer.byteLength(JSON.stringify(backwards))).toBeLessThanOrEqual(128 * 1024)
  })

  it('uses indexed bounded reads for the same page before and after retained history grows', async () => {
    const f = await fixture()
    f.seed(100, 0, 1)
    f.seed(500, 0, 60)
    const read = () => {
      const before = f.db.performanceDiagnostics()!.sqlite
      const page = f.repo.readSchedulingActivity({})
      const after = f.db.performanceDiagnostics()!.sqlite
      return {
        page,
        operations: after.operations - before.operations,
        rows: after.rowsReturned - before.rowsReturned,
        plans: after.queryPlans,
      }
    }
    const before = read()
    f.seed(10_000, 500, 60)
    const after = read()
    expect(after.page.rows).toEqual(before.page.rows)
    expect([before.operations, after.operations]).toEqual([2, 2])
    expect([before.rows, after.rows]).toEqual([26, 26])
    const plans = after.plans.filter((plan) =>
      plan.details.some((detail) => detail.includes('scheduling_activity_')),
    )
    expect(plans).toHaveLength(2)
    expect(
      plans.every((plan) =>
        plan.details.some((detail) => detail.includes('SEARCH scheduling_activity')),
      ),
    ).toBe(true)
    console.info(
      'Relay activity EXPLAIN QUERY PLAN:',
      JSON.stringify(plans.map((plan) => plan.details)),
    )
    console.info(
      'Relay activity retained rows 600 -> 10600; SQL operations/read 2 -> 2; returned rows/read 26 -> 26; projected rows/read 25 -> 25',
    )
  })

  it.each([75, 76])(
    'upgrades the complete 00%s prefix without changing receipt, budget, evaluation or journal facts',
    async (previous) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-relay-migration-'))
      directories.push(directory)
      const file = join(directory, 'pact.sqlite'),
        legacy = new Database(file),
        migrations = readMigrationFiles({ migrationsFolder })
      legacy.exec(
        'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at NUMERIC)',
      )
      const prefix = migrations.slice(0, previous + 1)
      expect(prefix.at(-1)?.sql.join('\n')).toContain(
        previous === 75 ? 'scheduling_handoffs' : 'scheduling_settings',
      )
      legacy.transaction(() => {
        for (const [index, migration] of prefix.entries()) {
          for (const statement of migration.sql) legacy.exec(statement)
          legacy
            .prepare('INSERT INTO __drizzle_migrations VALUES (?, ?, ?)')
            .run(index + 1, migration.hash, migration.folderMillis)
        }
        legacy.exec(
          "INSERT INTO projects (id,name,directory_path,kind,created_at) VALUES ('project','Original','/original','directory','2026-01-01T00:00:00.000Z')",
        )
      })()
      // Use explicit columns so later unrelated schema additions cannot silently move preserved values.
      legacy
        .prepare(
          'INSERT INTO sessions (id,project_id,title,status,settings_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run('session', 'project', 'Original session', 'paused', 1, timestamp, timestamp)
      legacy
        .prepare(
          'INSERT INTO scheduling_handoffs (id,session_id,budget_subject_id,event_id,slot,fact_fingerprint,freshness_guard_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          'handoff',
          'session',
          'task:stable',
          'event',
          'workflow_next',
          'facts',
          '{"original":true}',
          timestamp,
        )
      legacy
        .prepare('INSERT INTO scheduling_budget_counters VALUES (?,?,?,?,?,?,?)')
        .run('task:stable', 'session', 27, 1, 1, 2, 1)
      legacy
        .prepare(
          'INSERT INTO scheduling_evaluations (id,session_id,handoff_id,budget_subject_id,fact_fingerprint,provider,model,configuration_fingerprint,handoff_json,active,called,outcome,created_at,deadline) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          'evaluation',
          'session',
          'handoff',
          'task:stable',
          'facts',
          'codex',
          'gpt-6-luna',
          'config',
          '{"complete":"source"}',
          1,
          1,
          'possibly_sent',
          timestamp,
          timestamp,
        )
      legacy
        .prepare(
          'INSERT INTO agent_event_journal (session_id,sequence,run_id,event_type,payload,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          'session',
          0,
          'run',
          'native.dispatch_observed',
          '{"phase":"possibly_sent"}',
          timestamp,
        )
      if (previous === 76)
        legacy
          .prepare(
            'INSERT INTO scheduling_settings (id,enabled,selection_json,show_indicator,revision,updated_at) VALUES (1,1,?,0,7,?)',
          )
          .run(
            JSON.stringify({ target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' }),
            timestamp,
          )
      const tables = [
        'scheduling_handoffs',
        'scheduling_budget_counters',
        'scheduling_evaluations',
        'agent_event_journal',
        'projects',
        'sessions',
        ...(previous === 76 ? ['scheduling_settings'] : []),
      ]
      const columns = tables.map((table) =>
        legacy
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => {
            if (
              !column ||
              typeof column !== 'object' ||
              !('name' in column) ||
              typeof column.name !== 'string'
            )
              throw Error('Invalid migration columns')
            return column.name
          })
          .join(','),
      )
      const before = tables.map((table, index) =>
        legacy.prepare(`SELECT ${columns[index]} FROM ${table}`).all(),
      )
      const history = legacy.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
      legacy.close()
      const db = await PactDatabase.open({ filePath: file, migrationsFolder })
      databases.add(db)
      const current = new Database(file, { readonly: true })
      try {
        expect(
          tables.map((table, index) =>
            current.prepare(`SELECT ${columns[index]} FROM ${table}`).all(),
          ),
        ).toEqual(before)
        expect(
          current
            .prepare('SELECT * FROM __drizzle_migrations ORDER BY id')
            .all()
            .slice(0, history.length),
        ).toEqual(history)
        expect(db.conversationRepository.schedulingSettings()).toMatchObject({
          enabled: previous === 76,
          selection:
            previous === 76
              ? { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' }
              : null,
          showIndicator: previous !== 76,
          revision: previous === 76 ? 7 : 0,
        })
      } finally {
        current.close()
      }
    },
  )
})
const timestamp = '2026-10-22T00:00:00.000Z'
