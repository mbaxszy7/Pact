import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENAI_DECISION_MODEL, schedulingActivityPageSchema } from '@pact/contracts'

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

  it('defaults Off without a credential, saves with CAS independently from Session defaults/settings and survives restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-relay-settings-'))
    directories.push(directory)
    const file = join(directory, 'pact.sqlite'),
      f = await fixture(file)
    f.db.defaultSessionSettingsRepository.save(defaults)
    const beforeDefaults = f.db.defaultSessionSettingsRepository.read(),
      beforeSession = f.db.sessionRepository.find(f.sessionId)
    expect(f.repo.schedulingSettings()).toEqual({
      enabled: false,
      provider: 'openai',
      model: OPENAI_DECISION_MODEL,
      credential: { configured: false, revision: 0 },
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
      credential: { configured: false, revision: 0 },
      showIndicator: true,
      revision: 1,
    })
    expect(() =>
      f.repo.saveSchedulingSettings({ expectedRevision: 0, showIndicator: false }),
    ).toThrow(/changed/u)
    expect(f.repo.schedulingConfigurationGeneration()).toBe(1)
    const indicator = f.repo.saveSchedulingSettings({
      expectedRevision: 1,
      showIndicator: false,
    })
    // Indicator preference is presentation-only and never bumps the semantic generation.
    expect(f.repo.schedulingConfigurationGeneration()).toBe(1)
    const saved = f.repo.saveSchedulingSettings({
      expectedRevision: indicator.revision,
      enabled: false,
    })
    expect(saved).toMatchObject({
      enabled: false,
      credential: { configured: false, revision: 0 },
      showIndicator: false,
      revision: 3,
    })
    expect(f.db.defaultSessionSettingsRepository.read()).toEqual(beforeDefaults)
    expect(f.db.sessionRepository.find(f.sessionId)).toEqual(beforeSession)
    expect(events).toBe(3)
    unsubscribe()
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 0 })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(2)
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({ filePath: file, migrationsFolder })
    databases.add(reopened)
    expect(reopened.conversationRepository.schedulingSettings()).toEqual(saved)
    expect(reopened.conversationRepository.schedulingConfigurationGeneration()).toBe(2)
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
          .filter(
            (name) =>
              table !== 'scheduling_settings' ||
              !['selection_json', 'enabled', 'revision', 'updated_at'].includes(name),
          )
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
        // The cutover always lands on disabled OpenAI-only settings; preserved
        // native selection is intentionally dropped, not carried forward.
        expect(db.conversationRepository.schedulingSettings()).toEqual({
          enabled: false,
          provider: 'openai',
          model: OPENAI_DECISION_MODEL,
          credential: { configured: false, revision: 0 },
          showIndicator: previous !== 76,
          revision: previous === 76 ? 8 : 0,
          updatedAt: expect.any(String),
        })
        expect(
          current
            .prepare('PRAGMA table_info(scheduling_settings)')
            .all()
            .some(
              (column) =>
                !!column &&
                typeof column === 'object' &&
                'name' in column &&
                column.name === 'selection_json',
            ),
        ).toBe(false)
      } finally {
        current.close()
      }
      db.close()
      databases.delete(db)
      // A cold second reopen must not bump the cutover revision again.
      const second = await PactDatabase.open({ filePath: file, migrationsFolder })
      databases.add(second)
      expect(second.conversationRepository.schedulingSettings().revision).toBe(
        previous === 76 ? 8 : 0,
      )
    },
  )
})
const timestamp = '2026-10-22T00:00:00.000Z'

const cipherA = Buffer.from('synthetic encrypted fixture A').toString('base64')
const cipherB = Buffer.from('synthetic encrypted fixture B').toString('base64')
const cipherC = Buffer.from('synthetic encrypted fixture C').toString('base64')
const saveRequest = (nonce: string, expectedRevision: number, ciphertext: string) => ({
  operation: 'save' as const,
  nonce,
  expectedRevision,
  deadlineAt: Date.now() + 5000,
  ciphertext,
})

describe('Relay credential durable write/readback', () => {
  it('writes, survives a cold reopen and removes with durable receipt metadata only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-relay-credential-'))
    directories.push(directory)
    const file = join(directory, 'pact.sqlite'),
      f = await fixture(file)
    const beforeDefaults = f.db.defaultSessionSettingsRepository.read(),
      beforeSession = f.db.sessionRepository.find(f.sessionId)
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: null, revision: 0 })
    const nonce = randomUUID(),
      receipt = f.repo.writeRelayCredential(saveRequest(nonce, 0, cipherA))
    expect(receipt).toEqual({ nonce, operation: 'save', revision: 1, configured: true })
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherA, revision: 1 })
    expect(f.repo.schedulingSettings()).toMatchObject({
      credential: { configured: true, revision: 1 },
      revision: 1,
    })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(1)
    expect(JSON.stringify(f.repo.schedulingSettings())).not.toContain(cipherA)
    expect(JSON.stringify(f.repo.readRelayCredentialReceipt(nonce))).not.toContain(cipherA)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 0 })
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([])
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({ filePath: file, migrationsFolder })
    databases.add(reopened)
    const repo = reopened.conversationRepository
    expect(repo.readRelayCredential()).toEqual({ ciphertext: cipherA, revision: 1 })
    expect(repo.readRelayCredentialReceipt(nonce)).toEqual({
      nonce,
      operation: 'save',
      revision: 1,
      configured: true,
    })
    expect(repo.readRelayCredentialReceipt(randomUUID())).toBeUndefined()
    expect(reopened.sessionRepository.find(f.sessionId)).toEqual(beforeSession)
    expect(reopened.defaultSessionSettingsRepository.read()).toEqual(beforeDefaults)
    const removed = repo.writeRelayCredential({
      operation: 'remove' as const,
      nonce: randomUUID(),
      expectedRevision: 1,
      deadlineAt: Date.now() + 5000,
    })
    expect(removed).toMatchObject({ revision: 2, configured: false })
    expect(repo.readRelayCredential()).toEqual({ ciphertext: null, revision: 2 })
    expect(repo.schedulingSettings()).toMatchObject({
      credential: { configured: false, revision: 2 },
      revision: 2,
    })
    expect(repo.schedulingConfigurationGeneration()).toBe(2)
    expect(repo.readRelayCredentialReceipt(nonce)).toEqual({
      nonce,
      operation: 'save',
      revision: 1,
      configured: true,
    })
    expect(
      reopened.drizzle.get(sql`SELECT count(*) AS count FROM relay_credential_receipts`),
    ).toEqual({ count: 2 })
  })

  it('replays a lost ACK against the same request and refuses conflicting nonces, revisions and stale expected revisions', async () => {
    const f = await fixture()
    const nonce = randomUUID(),
      request = saveRequest(nonce, 0, cipherA),
      receipt = f.repo.writeRelayCredential(request)
    expect(f.repo.writeRelayCredential(request)).toEqual(receipt)
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherA, revision: 1 })
    expect(f.repo.schedulingSettings().revision).toBe(1)
    expect(f.repo.schedulingConfigurationGeneration()).toBe(1)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM relay_credential_receipts`)).toEqual({
      count: 1,
    })
    for (const conflicting of [
      saveRequest(nonce, 0, cipherB),
      { operation: 'remove' as const, nonce, expectedRevision: 0, deadlineAt: Date.now() + 5000 },
      saveRequest(nonce, 1, cipherA),
    ])
      expect(() => f.repo.writeRelayCredential(conflicting)).toThrow(
        /credential|Scheduling settings/u,
      )
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherA, revision: 1 })
    expect(() => f.repo.writeRelayCredential(saveRequest(randomUUID(), 0, cipherB))).toThrow(
      /Scheduling settings changed/u,
    )
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherA, revision: 1 })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(1)
  })

  it('rejects expired deadlines, plaintext fields and malformed ciphertext before any side effect', async () => {
    const f = await fixture()
    const valid = saveRequest(randomUUID(), 0, cipherA)
    for (const invalid of [
      { ...valid, deadlineAt: Date.now() - 1 },
      { ...valid, key: 'sk-synthetic' },
      { ...valid, ciphertext: 'AB==' },
      { ...valid, ciphertext: Buffer.alloc(8193).toString('base64') },
      { ...valid, nonce: 'not-a-uuid' },
      { ...valid, expectedRevision: -1 },
      { ...valid, deadlineAt: 0 },
    ])
      expect(() => f.repo.writeRelayCredential(invalid)).toThrow(/credential/u)
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: null, revision: 0 })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(0)
    // Expiry inside the transaction: the third deadline check expires before the write.
    const t = Date.now()
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(t)
      .mockReturnValueOnce(t + 10)
      .mockReturnValue(t + 20)
    try {
      expect(() =>
        f.repo.writeRelayCredential({
          operation: 'save' as const,
          nonce: randomUUID(),
          expectedRevision: 0,
          deadlineAt: t + 15,
          ciphertext: cipherA,
        }),
      ).toThrow(/no longer current/u)
      expect(f.repo.readRelayCredential()).toEqual({ ciphertext: null, revision: 0 })
      expect(f.repo.schedulingSettings().revision).toBe(0)
      expect(
        f.db.drizzle.get(sql`SELECT count(*) AS count FROM relay_credential_receipts`),
      ).toEqual({ count: 0 })
    } finally {
      spy.mockRestore()
    }
  })

  it('rolls back the whole credential write when the receipt insert fails', async () => {
    const f = await fixture()
    const request = saveRequest(randomUUID(), 0, cipherA)
    const changed = vi.fn<() => void>()
    const unsubscribe = f.repo.subscribeSchedulingChanges(changed)
    f.db.drizzle.run(
      sql`CREATE TEMP TRIGGER reject_credential_receipt BEFORE INSERT ON relay_credential_receipts BEGIN SELECT RAISE(ABORT,'controlled credential receipt failure'); END`,
    )
    expect(() => f.repo.writeRelayCredential(request)).toThrow(
      /controlled credential receipt failure/u,
    )
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: null, revision: 0 })
    expect(f.repo.schedulingSettings().revision).toBe(0)
    expect(f.repo.schedulingConfigurationGeneration()).toBe(0)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM relay_credential_receipts`)).toEqual({
      count: 0,
    })
    expect(changed).not.toHaveBeenCalled()
    f.db.drizzle.run(sql`DROP TRIGGER reject_credential_receipt`)
    const receipt = f.repo.writeRelayCredential(request)
    expect(receipt).toMatchObject({ revision: 1, configured: true })
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('rotates ciphertext under CAS without touching settings authority, receipts or generation', async () => {
    const f = await fixture()
    const nonce = randomUUID(),
      original = f.repo.writeRelayCredential(saveRequest(nonce, 0, cipherA)),
      settingsBefore = f.repo.schedulingSettings(),
      generation = f.repo.schedulingConfigurationGeneration(),
      fingerprint = f.repo.schedulingConfigurationFingerprint()
    expect(f.repo.rotateRelayCredentialCiphertext(1, cipherA, cipherB)).toBe(true)
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherB, revision: 1 })
    expect(f.repo.schedulingSettings()).toEqual(settingsBefore)
    expect(f.repo.schedulingConfigurationGeneration()).toBe(generation)
    expect(f.repo.schedulingConfigurationFingerprint()).toBe(fingerprint)
    expect(f.repo.readRelayCredentialReceipt(nonce)).toEqual(original)
    for (const attempt of [
      [2, cipherB, cipherC],
      [1, cipherA, cipherC],
      [1, cipherB, 'AB=='],
    ] as const)
      expect(f.repo.rotateRelayCredentialCiphertext(attempt[0], attempt[1], attempt[2])).toBe(false)
    // Replaying the original save nonce returns the durable receipt without reverting the rotation.
    expect(f.repo.writeRelayCredential(saveRequest(nonce, 0, cipherA))).toEqual(original)
    expect(f.repo.readRelayCredential()).toEqual({ ciphertext: cipherB, revision: 1 })
    const second = f.repo.writeRelayCredential(saveRequest(randomUUID(), 1, cipherC))
    expect(second).toMatchObject({ revision: 2, configured: true })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(generation + 1)
    expect(f.repo.rotateRelayCredentialCiphertext(1, cipherB, cipherA)).toBe(false)
    const removed = f.repo.writeRelayCredential({
      operation: 'remove' as const,
      nonce: randomUUID(),
      expectedRevision: 2,
      deadlineAt: Date.now() + 5000,
    })
    expect(removed).toMatchObject({ revision: 3, configured: false })
    expect(f.repo.rotateRelayCredentialCiphertext(3, cipherC, cipherB)).toBe(false)
  })
})
