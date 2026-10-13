import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'

import type { PactDatabase } from './pact-database.js'

import { agentRuns, agentRunActivities, sessions } from './schema/index.js'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function names(value: unknown): { name: string }[] {
  if (!Array.isArray(value)) throw new Error('Invalid legacy schema metadata.')
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('name' in row) || typeof row.name !== 'string')
      throw new Error('Invalid legacy schema name.')
    return { name: row.name }
  })
}

/** Builds the real historical schema and copies only columns that existed then. */
export function copyLegacyDatabase(
  current: PactDatabase,
  filePath: string,
  migrationsFolder: string,
  throughMigration: number,
): void {
  const legacy = new Database(filePath)
  // Historical tables include forward/cyclic references; validate after the copy.
  legacy.pragma('foreign_keys = OFF')
  try {
    legacy.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at NUMERIC)',
    )
    legacy.transaction(() => {
      for (const migration of readMigrationFiles({ migrationsFolder }).slice(
        0,
        throughMigration + 1,
      )) {
        for (const statement of migration.sql) legacy.exec(statement)
        legacy
          .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
          .run(migration.hash, migration.folderMillis)
      }
      const tables = names(
        legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'",
          )
          .all(),
      )
      for (const { name } of tables) {
        const columns = names(legacy.prepare(`PRAGMA table_info(${quote(name)})`).all())
        const projection = columns.map((column) => quote(column.name)).join(', ')
        const rows = current.drizzle.all<Record<string, unknown>>(
          sql.raw(`SELECT ${projection} FROM ${quote(name)}`),
        )
        legacy.prepare(`DELETE FROM ${quote(name)}`).run()
        const insert = legacy.prepare(
          `INSERT INTO ${quote(name)} (${projection}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        for (const row of rows) insert.run(...columns.map((column) => row[column.name]))
      }
    })()
    const violations: unknown = legacy.pragma('foreign_key_check')
    if (!Array.isArray(violations) || violations.length > 0)
      throw new Error('Invalid legacy fixture references.')
  } finally {
    legacy.close()
  }
}

/** Seeds a persisted pre-removal answer attempt; production has no replay command. */
export function seedHistoricalAnswerAttempt(database: PactDatabase, originalRunId: string) {
  const repository = database.conversationRepository
  const original = repository.findRun(originalRunId)
  const stored = database.drizzle
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, originalRunId))
    .get()
  if (!original || !stored) throw new Error('Missing historical Run fixture.')
  const message = repository.message(original.userMessageId, original.sessionId)
  if (!message) throw new Error('Missing historical Message fixture.')
  const current = database.sessionRepository.find(original.sessionId)!
  const id = crypto.randomUUID(),
    timestamp = new Date().toISOString()
  database.drizzle.transaction((transaction) => {
    if (original.status === 'recovering') {
      transaction
        .update(agentRuns)
        .set({ status: 'interrupted' })
        .where(eq(agentRuns.id, originalRunId))
        .run()
      transaction
        .update(agentRunActivities)
        .set({ status: 'failed' })
        .where(eq(agentRunActivities.runId, originalRunId))
        .run()
    }
    transaction
      .insert(agentRuns)
      .values({
        id,
        sessionId: original.sessionId,
        userMessageId: original.userMessageId,
        agentId: original.agentId,
        status: 'starting',
        attemptCount: 1,
        bindingGeneration:
          repository.nativeContext(original.sessionId, original.agentId)?.bindingGeneration ?? 1,
        nativeEffectsState: 'not_dispatched',
        settingsRevision: original.settingsRevision,
        permissionMode:
          current.settings.permissionModes?.[original.agentId] ??
          (original.agentId === 'claude' ? 'ask' : 'native'),
        model: original.model,
        effort: original.effort,
        handoffSourceIds: stored.handoffSourceIds,
        handoffMessageCount: stored.handoffMessageCount,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run()
    transaction
      .update(sessions)
      .set({ status: 'discussing', updatedAt: timestamp })
      .where(eq(sessions.id, original.sessionId))
      .run()
  })
  const run = repository.findRun(id)!
  return {
    run,
    message,
    comments: repository.commentsForMessage(message.id),
    patch: repository.runPatch(id),
  }
}
