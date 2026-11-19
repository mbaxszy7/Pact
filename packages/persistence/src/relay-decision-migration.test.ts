import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { randomUUID } from 'node:crypto'
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import { copyLegacyDatabase } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import { collaborationActionReceipts, relayDecisions } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
type Row = Record<string, unknown>
type Layout = Array<{ name: string; columns: string[] }>

function layout(database: Database.Database): Layout {
  return database
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      name,
      columns: database
        .prepare<[], { name: string }>(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((column) => column.name),
    }))
}

function contents(database: Database.Database, tables: Layout) {
  return tables.map(({ name, columns }) => ({
    name,
    rows: database
      .prepare<[], Row>(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}`)
      .all()
      .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }))
}

function history(database: Database.Database) {
  return database.prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid').all()
}

function foreignKeys(database: Database.Database, table: string) {
  // SQLite may renumber independent constraints when it reconstructs a table.
  // Compare their actual source/target columns and update/delete semantics.
  return database
    .prepare<
      [],
      {
        table: string
        from: string
        to: string
        on_update: string
        on_delete: string
        match: string
      }
    >(`PRAGMA foreign_key_list(${quote(table)})`)
    .all()
    .map(({ table: target, from, to, on_update, on_delete, match }) => ({
      target,
      from,
      to,
      on_update,
      on_delete,
      match,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function indexes(database: Database.Database, table: string) {
  return database
    .prepare<[], { name: string; unique: number; origin: string; partial: number }>(
      `PRAGMA index_list(${quote(table)})`,
    )
    .all()
    .filter((index) => index.origin !== 'pk')
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      partial: index.partial,
      columns: database
        .prepare<[], { name: string }>(`PRAGMA index_info(${quote(index.name)})`)
        .all()
        .map((column) => column.name),
      predicate:
        database
          .prepare<[string], { sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
          )
          .get(index.name)!
          .sql.split(/\bWHERE\b/iu)[1]
          ?.replaceAll(/["`\s]/gu, '') ?? null,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

async function migrationPrefix(destination: string) {
  await cp(migrationsFolder, destination, { recursive: true })
  const journalPath = join(destination, 'meta', '_journal.json')
  const journal: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
  if (!journal || typeof journal !== 'object' || Array.isArray(journal))
    throw Error('Invalid migration journal')
  const entries: unknown = Reflect.get(journal, 'entries')
  if (!Array.isArray(entries)) throw Error('Missing migration entries')
  Reflect.set(
    journal,
    'entries',
    entries.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw Error('Invalid migration entry')
      const index: unknown = Reflect.get(entry, 'idx')
      if (typeof index !== 'number' || !Number.isInteger(index))
        throw Error('Invalid migration index')
      return index <= 85
    }),
  )
  await writeFile(journalPath, JSON.stringify(journal))
  const migrations = readMigrationFiles({ migrationsFolder: destination })
  expect(migrations).toHaveLength(86)
  return migrations
}

async function populated0084(filePath: string) {
  const f = await planRevisionFixture()
  try {
    const now = '2026-10-21T10:00:00.000Z'
    const decisionStates = ['awaiting_answer', 'available', 'bound'] as const
    const decisions = decisionStates.map((state, index) => ({
      id: randomUUID(),
      sessionId: f.sessionId,
      taskId: f.task.id,
      matterKey: `legacy-matter:${index}`,
      kind: index === 2 ? ('supplement_code_response' as const) : ('supplement_plan' as const),
      state,
      revision: index + 2,
      afterRunId: f.first.run.id,
      handoffId: `${index}`.repeat(64),
      proofJson: JSON.stringify({
        original: true,
        text: 'Complete historical authority 路由 🙂',
        index,
        facts: ['plan', 'review'],
      }),
      active: index < 2,
      createdAt: now,
      updatedAt: now,
    }))
    f.db.drizzle.insert(relayDecisions).values(decisions).run()
    const states = ['unknown', 'available', 'settled', 'cancelled'] as const
    f.db.drizzle
      .insert(collaborationActionReceipts)
      .values(
        states.map((state, index): typeof collaborationActionReceipts.$inferInsert => ({
          id: randomUUID(),
          sessionId: f.sessionId,
          taskId: f.task.id,
          clientNonce: randomUUID(),
          requestDigest: `${index + 1}`.repeat(64),
          action: 'supplement_plan',
          actor: 'codex' as const,
          handoffId: `${index + 3}`.repeat(64),
          decisionId: decisions[index]?.id ?? null,
          rootReceiptId: randomUUID(),
          basisJson: JSON.stringify({
            original: true,
            text: 'Complete frozen original receipt 🙂',
            source: { id: f.originalPlan.document.id, sha256: f.originalPlan.document.sha256 },
          }),
          state,
          boundRunId: index === 0 ? f.first.run.id : index === 2 ? f.reviewRun.id : null,
          budgetReservationId: index === 0 ? randomUUID() : null,
          active: index < 2,
          reviewState: index === 0 ? 'pending' : index === 2 ? 'fulfilled' : null,
          reviewRunId: index === 0 ? f.reviewRun.id : null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    copyLegacyDatabase(f.db, filePath, migrationsFolder, 84)
    return { sessionId: f.sessionId, taskId: f.task.id }
  } finally {
    f.db.close()
  }
}

it('upgrades the populated 0084 authority graph through PactDatabase with complete rows, all eleven indexes and unchanged FK semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-relay-0085-upgrade-')),
    filePath = join(root, 'legacy.sqlite'),
    backupFilePath = join(root, 'before-0085.sqlite')
  let database: PactDatabase | undefined, inspection: Database.Database | undefined
  try {
    await populated0084(filePath)
    const ownMigrations = join(root, 'migrations'),
      migrations = await migrationPrefix(ownMigrations)
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    const tables = layout(inspection),
      before = contents(inspection, tables),
      previousHistory = history(inspection),
      constraints = ['relay_decisions', 'collaboration_action_receipts'].map((table) => ({
        table,
        foreignKeys: foreignKeys(inspection!, table),
        indexes: indexes(inspection!, table),
      }))
    expect(previousHistory).toHaveLength(85)
    expect(constraints.reduce((count, table) => count + table.indexes.length, 0)).toBe(11)
    expect(inspection.pragma('foreign_key_check')).toEqual([])
    inspection.close()
    inspection = undefined
    database = await PactDatabase.open({
      filePath,
      backupFilePath,
      migrationsFolder: ownMigrations,
    })
    expect(database.drizzle.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
    expect(database.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    expect(
      database.drizzle.all(
        sql`SELECT format_version, answer_nonce, answer_digest, answer_json, result_json FROM relay_decisions`,
      ),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        format_version: 1,
        answer_nonce: null,
        answer_digest: null,
        answer_json: null,
        result_json: null,
      })),
    )
    database.close()
    database = undefined
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    expect(contents(inspection, tables)).toEqual(before)
    for (const constraint of constraints) {
      expect(foreignKeys(inspection, constraint.table)).toEqual(constraint.foreignKeys)
      expect(indexes(inspection, constraint.table)).toEqual(constraint.indexes)
    }
    const columns = inspection
      .prepare<[], { name: string; notnull: number }>('PRAGMA table_info(relay_decisions)')
      .all()
    expect(columns.find((column) => column.name === 'task_id')?.notnull).toBe(0)
    expect(columns.find((column) => column.name === 'after_run_id')?.notnull).toBe(0)
    expect(
      inspection.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all(),
    ).toEqual(
      migrations.map((migration) => ({ hash: migration.hash, created_at: migration.folderMillis })),
    )
    expect(inspection.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    inspection.close()
    inspection = new Database(backupFilePath, { readonly: true, fileMustExist: true })
    expect(contents(inspection, tables)).toEqual(before)
    expect(history(inspection)).toEqual(previousHistory)
    expect(inspection.pragma('foreign_key_check')).toEqual([])
    inspection.close()
    inspection = undefined
    // A second real cold open must not rerun or alter the reconstructed graph.
    database = await PactDatabase.open({ filePath, migrationsFolder: ownMigrations })
    expect(database.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  } finally {
    inspection?.close()
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back a late 0085 failure with foreign keys enabled and preserves the original database and backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-relay-0085-rollback-')),
    filePath = join(root, 'legacy.sqlite'),
    backupFilePath = join(root, 'before-0085.sqlite')
  let database: PactDatabase | undefined, inspection: Database.Database | undefined
  try {
    await populated0084(filePath)
    const ownMigrations = join(root, 'migrations')
    await migrationPrefix(ownMigrations)
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    const tables = layout(inspection),
      before = contents(inspection, tables),
      previousHistory = history(inspection),
      schema = inspection
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
        .all()
    inspection.close()
    inspection = undefined
    await appendFile(
      join(ownMigrations, '0085_relay_scheduling_decisions.sql'),
      '\n--> statement-breakpoint\nINSERT INTO __pact_0085_forced_failure VALUES (1);',
    )
    const failure: unknown = await PactDatabase.open({
      filePath,
      backupFilePath,
      migrationsFolder: ownMigrations,
    }).then(
      (opened) => {
        database = opened
        return opened
      },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({
      code: 'DATABASE_MIGRATION_FAILED',
      backupFilePath,
      cause: {
        cause: { code: 'SQLITE_ERROR', message: 'no such table: __pact_0085_forced_failure' },
      },
    })
    for (const path of [filePath, backupFilePath]) {
      inspection = new Database(path, { readonly: true, fileMustExist: true })
      expect(contents(inspection, tables)).toEqual(before)
      expect(history(inspection)).toEqual(previousHistory)
      expect(
        inspection
          .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
          .all(),
      ).toEqual(schema)
      expect(inspection.pragma('foreign_key_check')).toEqual([])
      expect(inspection.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      inspection.close()
      inspection = undefined
    }
  } finally {
    inspection?.close()
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
})
