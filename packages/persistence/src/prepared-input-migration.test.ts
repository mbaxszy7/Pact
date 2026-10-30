import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { randomUUID } from 'node:crypto'
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import type { NativeContextRebuildChunk } from '@pact/contracts'

import { createQueueFixture } from './conversation-queue.test-helper.js'
import { copyLegacyDatabase } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import { collaborationRequiredInputMembers, conversationInputBatchMembers } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
type Column = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}
type Row = Record<string, unknown>
type TableSnapshot = { name: string; columns: Column[]; foreignKeys: Row[]; rows: Row[] }

function tableSnapshot(database: Database.Database, previous?: TableSnapshot[]): TableSnapshot[] {
  const tables =
    previous?.map(({ name }) => ({ name })) ??
    database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .all()
  return tables.map(({ name }) => {
    const columns = database.prepare<[], Column>(`PRAGMA table_info(${quote(name)})`).all()
    const oldColumns = previous?.find((entry) => entry.name === name)?.columns ?? columns
    return {
      name,
      columns,
      foreignKeys: database.prepare<[], Row>(`PRAGMA foreign_key_list(${quote(name)})`).all(),
      rows: database
        .prepare<[], Row>(
          `SELECT ${oldColumns.map((column) => quote(column.name)).join(', ')} FROM ${quote(name)}`,
        )
        .all()
        .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }
  })
}

function history(database: Database.Database) {
  return database
    .prepare<[], { hash: string; created_at: number }>(
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid',
    )
    .all()
}

function sqliteFailure(work: () => unknown): unknown {
  try {
    work()
  } catch (error) {
    return error instanceof Error ? error.cause : error
  }
  return undefined
}

async function migrationPrefix(destination: string) {
  await cp(migrationsFolder, destination, { recursive: true })
  const path = join(destination, 'meta', '_journal.json')
  const journal: unknown = JSON.parse(await readFile(path, 'utf8'))
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
      return index <= 82
    }),
  )
  await writeFile(path, JSON.stringify(journal))
  const migrations = readMigrationFiles({ migrationsFolder: destination })
  expect(migrations).toHaveLength(83)
  return migrations
}

async function writeLegacyFixture(filePath: string, projectDirectory: string) {
  const fixture = await createQueueFixture(':memory:', projectDirectory)
  try {
    const run = fixture.root()
    fixture.comment(run, 'Keep this complete historical Comment and its frozen anchor.')
    const queued = fixture.queue(run, 'Complete supplemental input.\nPreserve Unicode: 路由 🙂.')
    fixture.prepare(run, queued)
    fixture.repo.markQueuedSteerPossiblySent(queued.operationId)
    fixture.repo.recordQueuedSteerConsumption(fixture.proof(run), queued.inputId)
    fixture.finish(run)
    fixture.repo.recordNativeEffects(run.id, 'settled')

    const member = fixture.db.drizzle.select().from(conversationInputBatchMembers).get()
    if (!member) throw Error('The real queued input did not freeze its Comment member')
    // This legacy grant table remains durable even though current ordinary
    // delivery reads the same Batch through its Run source authorization.
    fixture.db.drizzle
      .insert(collaborationRequiredInputMembers)
      .values({
        runId: run.id,
        batchId: member.batchId,
        memberId: member.memberId,
        inputRevision: 1,
        active: true,
      })
      .run()

    const rebuildId = randomUUID()
    fixture.repo.beginNativeRebuild({
      id: rebuildId,
      sessionId: fixture.sessionId,
      agentId: 'codex',
      expectedGeneration: run.bindingGeneration,
      abandon: false,
    })
    const chunks: NativeContextRebuildChunk[] = []
    for await (const chunk of fixture.repo.nativeContextRebuildSource(
      fixture.sessionId,
      new AbortController().signal,
      rebuildId,
    ))
      chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    fixture.repo.freezeNativeRebuildSource(rebuildId, chunks)

    const session = fixture.db.sessionRepository.find(fixture.sessionId)
    if (!session) throw Error('The migration fixture Session is unavailable')
    const otherSessionId = randomUUID()
    fixture.db.sessionRepository.create(
      {
        id: otherSessionId,
        projectId: session.projectId,
        title: 'Independent prepared Session',
        createdAt: new Date().toISOString(),
      },
      session.settings,
    )
    expect(fixture.db.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])

    // The existing historical copier executes the original SQL prefix and
    // copies only columns that actually existed in 0081, then checks its FKs.
    copyLegacyDatabase(fixture.db, filePath, migrationsFolder, 81)
    return { run, member, otherSessionId }
  } finally {
    fixture.close()
  }
}

it('0082 only adds nullable dispatch metadata and a prepared-only Session index', async () => {
  const source = await readFile(join(migrationsFolder, '0082_prepared_input_dispatch.sql'), 'utf8')
  const statements = source.split('--> statement-breakpoint').map((statement) => statement.trim())
  expect(statements).toHaveLength(3)
  expect(statements[0]).toBe('ALTER TABLE `conversation_input_batches` ADD `dispatch_state` text;')
  expect(statements[1]).toBe(
    'ALTER TABLE `conversation_input_batches` ADD `dispatch_metadata_json` text;',
  )
  expect(statements[2]).toBe(
    'CREATE UNIQUE INDEX `conversation_input_batches_preparing_session_idx` ON `conversation_input_batches` (`session_id`) WHERE "conversation_input_batches"."dispatch_state" = \'prepared\';',
  )
})

it('upgrades a populated 0081 Batch reference graph through PactDatabase without losing legacy rows or weakening constraints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-prepared-input-upgrade-'))
  const filePath = join(root, 'legacy.sqlite'),
    backupFilePath = join(root, 'before-0082.sqlite'),
    ownMigrationsFolder = join(root, 'migrations')
  let database: PactDatabase | undefined
  let inspection: Database.Database | undefined
  let backup: Database.Database | undefined
  try {
    const { run, member, otherSessionId } = await writeLegacyFixture(
      filePath,
      join(root, 'project'),
    )
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    inspection.pragma('foreign_keys = ON')
    const before = tableSnapshot(inspection),
      previousHistory = history(inspection)
    const oldBatch = before.find(({ name }) => name === 'conversation_input_batches')
    if (!oldBatch) throw Error('The 0081 Batch table is unavailable')
    expect(
      oldBatch.columns.some(
        ({ name }) => name === 'dispatch_state' || name === 'dispatch_metadata_json',
      ),
    ).toBe(false)
    expect(oldBatch.columns.find(({ name }) => name === 'actor')).toMatchObject({ notnull: 1 })
    expect(previousHistory).toHaveLength(82)
    const migrations = await migrationPrefix(ownMigrationsFolder)
    expect(previousHistory.at(-1)).toEqual({
      hash: migrations[81]!.hash,
      created_at: migrations[81]!.folderMillis,
    })
    for (const name of [
      'conversation_input_batches',
      'conversation_input_batch_members',
      'collaboration_required_input_members',
      'conversation_run_source_refs',
      'conversation_rebuild_source_refs',
      'conversation_queue_operations',
      'collaboration_inputs',
      'conversation_body_inputs',
      'conversation_body_parts',
      'anchored_comments',
      'native_rebuild_operations',
      'agent_runs',
      'conversation_messages',
      'agent_event_journal',
    ])
      expect(
        before.find((entry) => entry.name === name)?.rows.length,
        `${name}: nonempty fixture`,
      ).toBeGreaterThan(0)
    expect(oldBatch.rows.length).toBeGreaterThan(1)
    expect(new Set(oldBatch.rows.map((row) => row.session_id))).toEqual(new Set([run.sessionId]))
    expect(inspection.pragma('foreign_key_check')).toEqual([])
    expect(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='conversation_input_batches_preparing_session_idx'",
        )
        .get(),
    ).toBeUndefined()
    inspection.close()
    inspection = undefined

    // This is the real public opening/migration path. In particular, 0082 runs
    // inside applyMigrations' transaction with foreign_keys enabled and a backup.
    database = await PactDatabase.open({
      filePath,
      backupFilePath,
      migrationsFolder: ownMigrationsFolder,
    })
    expect(database.isHealthy()).toBe(true)
    expect(database.drizzle.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
    expect(database.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    const after = tableSnapshot(inspection, before)
    for (const [index, old] of before.entries()) {
      const current = after[index]!
      expect(current.name).toBe(old.name)
      expect(current.rows, `${old.name}: original column data`).toEqual(old.rows)
      expect(current.foreignKeys, `${old.name}: original foreign keys`).toEqual(old.foreignKeys)
      expect(
        current.columns.filter(
          ({ name }) => name !== 'dispatch_state' && name !== 'dispatch_metadata_json',
        ),
        `${old.name}: original column constraints`,
      ).toEqual(old.columns)
    }
    const newColumns = after
      .find(({ name }) => name === 'conversation_input_batches')!
      .columns.filter(({ name }) => name === 'dispatch_state' || name === 'dispatch_metadata_json')
    expect(
      newColumns.map(({ name, type, notnull, dflt_value }) => ({
        name,
        type,
        notnull,
        dflt_value,
      })),
    ).toEqual([
      { name: 'dispatch_state', type: 'TEXT', notnull: 0, dflt_value: null },
      { name: 'dispatch_metadata_json', type: 'TEXT', notnull: 0, dflt_value: null },
    ])
    expect(
      inspection
        .prepare('SELECT dispatch_state, dispatch_metadata_json FROM conversation_input_batches')
        .all(),
    ).toEqual(oldBatch.rows.map(() => ({ dispatch_state: null, dispatch_metadata_json: null })))
    expect(history(inspection)).toEqual(
      migrations.map((migration) => ({ hash: migration.hash, created_at: migration.folderMillis })),
    )
    inspection.close()
    inspection = undefined

    backup = new Database(backupFilePath, { readonly: true, fileMustExist: true })
    expect(history(backup)).toEqual(previousHistory)
    expect(tableSnapshot(backup)).toEqual(before)
    expect(backup.pragma('foreign_key_check')).toEqual([])
    backup.close()
    backup = undefined

    expect(
      sqliteFailure(() =>
        database!.drizzle.run(
          sql`UPDATE conversation_input_batches SET actor = NULL WHERE id = ${member.batchId}`,
        ),
      ),
    ).toMatchObject({
      code: 'SQLITE_CONSTRAINT_NOTNULL',
      message: 'NOT NULL constraint failed: conversation_input_batches.actor',
    })
    const insert = (
      id: string,
      sessionId: string,
      state: 'prepared' | 'dispatched' | 'cancelled' | null,
    ) =>
      database!.drizzle.run(sql`
      INSERT INTO conversation_input_batches
        (id,session_id,sequence,client_message_id,comments_revision,actor,member_count,created_at,dispatch_state,dispatch_metadata_json)
      VALUES (${id},${sessionId},0,${id},0,'codex',0,${new Date().toISOString()},${state},${state === null ? null : '{}'})
    `)
    const firstPrepared = randomUUID(),
      secondPrepared = randomUUID()
    // Existing nullable rows and closed dispatches do not consume the new slot.
    insert(randomUUID(), run.sessionId, null)
    insert(randomUUID(), run.sessionId, null)
    insert(randomUUID(), run.sessionId, 'dispatched')
    insert(randomUUID(), run.sessionId, 'cancelled')
    insert(firstPrepared, run.sessionId, 'prepared')
    expect(sqliteFailure(() => insert(secondPrepared, run.sessionId, 'prepared'))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: conversation_input_batches.session_id',
    })
    insert(randomUUID(), otherSessionId, 'prepared')
    database.drizzle.run(
      sql`UPDATE conversation_input_batches SET dispatch_state='dispatched' WHERE id=${firstPrepared}`,
    )
    insert(secondPrepared, run.sessionId, 'prepared')
    expect(
      database.drizzle.all(
        sql`SELECT session_id, count(*) AS count FROM conversation_input_batches WHERE dispatch_state='prepared' GROUP BY session_id ORDER BY session_id`,
      ),
    ).toEqual(
      [run.sessionId, otherSessionId].toSorted().map((session_id) => ({ session_id, count: 1 })),
    )
    expect(
      sqliteFailure(() =>
        database!.drizzle.run(sql`
      INSERT INTO conversation_run_source_refs(run_id,source_message_id,source_revision,batch_id,documents_json)
      VALUES (${run.id},${run.userMessageId},0,${randomUUID()},'[]')
    `),
      ),
    ).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'FOREIGN KEY constraint failed',
    })
    expect(database.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  } finally {
    backup?.close()
    inspection?.close()
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back all 0082 statements after a late failure and preserves the populated 0081 database and backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-prepared-input-upgrade-'))
  const filePath = join(root, 'legacy.sqlite'),
    backupFilePath = join(root, 'before-0082.sqlite'),
    ownMigrationsFolder = join(root, 'migrations')
  let unexpectedDatabase: PactDatabase | undefined
  let inspection: Database.Database | undefined
  try {
    await writeLegacyFixture(filePath, join(root, 'project'))
    inspection = new Database(filePath, { readonly: true, fileMustExist: true })
    const before = tableSnapshot(inspection),
      previousHistory = inspection
        .prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid')
        .all(),
      schemaBefore = inspection
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
        .all()
    expect(previousHistory).toHaveLength(82)
    expect(inspection.pragma('foreign_key_check')).toEqual([])
    inspection.close()
    inspection = undefined

    await migrationPrefix(ownMigrationsFolder)
    // The complete real 0082 SQL runs first. Only this owned temporary copy
    // gains a fourth statement, whose native error proves execution reached it.
    await appendFile(
      join(ownMigrationsFolder, '0082_prepared_input_dispatch.sql'),
      '\n--> statement-breakpoint\nINSERT INTO __pact_0082_forced_failure VALUES (1);',
    )
    const result: unknown = await PactDatabase.open({
      filePath,
      backupFilePath,
      migrationsFolder: ownMigrationsFolder,
    }).then(
      (opened) => {
        unexpectedDatabase = opened
        return opened
      },
      (error: unknown) => error,
    )
    expect(result).toMatchObject({
      code: 'DATABASE_MIGRATION_FAILED',
      backupFilePath,
      cause: {
        cause: {
          code: 'SQLITE_ERROR',
          message: 'no such table: __pact_0082_forced_failure',
        },
      },
    })

    for (const path of [filePath, backupFilePath]) {
      // Read through the original 0081 columns, without invoking current
      // repositories or starting another upgrade/recovery operation.
      inspection = new Database(path, { readonly: true, fileMustExist: true })
      expect(tableSnapshot(inspection)).toEqual(before)
      expect(inspection.prepare('SELECT * FROM __drizzle_migrations ORDER BY rowid').all()).toEqual(
        previousHistory,
      )
      expect(
        inspection
          .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
          .all(),
      ).toEqual(schemaBefore)
      expect(inspection.pragma('foreign_key_check')).toEqual([])
      expect(inspection.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      inspection.close()
      inspection = undefined
    }
  } finally {
    inspection?.close()
    unexpectedDatabase?.close()
    await rm(root, { recursive: true, force: true })
  }
})
