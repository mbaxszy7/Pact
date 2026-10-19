import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle as createDrizzleDatabase } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  openSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { AppUpdatesRepository } from './app-updates-repository.js'
import {
  DrizzleAppearanceSettingsRepository,
  type AppearanceSettingsRepository,
} from './appearance-settings-repository.js'
import { ConversationRepository } from './conversation-repository.js'
import { DatabasePerformance } from './database-performance.js'
import { DefaultSessionSettingsRepository } from './default-session-settings-repository.js'
import { ProjectCatalogRepository } from './project-catalog-repository.js'
import {
  DrizzleRuntimePreparationRepository,
  type RuntimePreparationRepository,
} from './runtime-preparation-repository.js'
import { schema } from './schema/index.js'
import { SessionRepository } from './session-repository.js'
import { WorkspaceChangesRepository } from './workspace-changes-repository.js'

export interface PactDatabaseOpenOptions {
  filePath: string
  migrationsFolder: string
  backupFilePath?: string
  signal?: AbortSignal
  measurePerformance?: boolean
}

export type DatabaseFailureCode =
  | 'DATABASE_IN_USE'
  | 'DATABASE_INCOMPATIBLE'
  | 'DATABASE_BACKUP_FAILED'
  | 'DATABASE_MIGRATION_FAILED'
  | 'DATABASE_STORAGE_FAILED'
export class DatabaseOpenError extends Error {
  override readonly cause: unknown
  readonly code: DatabaseFailureCode
  readonly reason: string
  readonly dataFilePath: string
  readonly backupFilePath: string | undefined
  readonly partialBackupFilePath: string | undefined
  readonly stagingFilePath: string | undefined
  constructor(
    code: DatabaseFailureCode,
    reason: string,
    filePath: string,
    options: {
      cause?: unknown
      backupFilePath?: string
      partialBackupFilePath?: string
      stagingFilePath?: string
    } = {},
  ) {
    super(`Pact database startup stopped: ${reason}. The existing data has been preserved.`)
    this.name = 'DatabaseOpenError'
    this.code = code
    this.reason = reason
    this.dataFilePath = filePath
    this.cause = options.cause
    this.backupFilePath = options.backupFilePath
    this.partialBackupFilePath = options.partialBackupFilePath
    this.stagingFilePath = options.stagingFilePath
  }
}
export class DatabaseMigrationError extends DatabaseOpenError {
  constructor(
    filePath: string,
    options: { cause: unknown; backupFilePath?: string; stagingFilePath?: string },
  ) {
    super('DATABASE_MIGRATION_FAILED', 'migration-failed', filePath, options)
    this.name = 'DatabaseMigrationError'
  }
}
interface Migration {
  hash: string
  createdAt: number
  statements: string[]
}
interface HistoryRow {
  hash: string
  createdAt: number
}
const MIGRATION_COUNT_LIMIT = 4096
const MIGRATION_FILE_BYTES = 1024 * 1024
const MIGRATION_TOTAL_BYTES = 16 * 1024 * 1024
const OPEN_DEADLINE_MS = 30_000

const drizzleMigrations = sqliteTable('__drizzle_migrations', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  createdAt: integer('created_at'),
})

export class PactDatabase {
  // An uncertain native close must retain both handles and stop admission until process exit.
  private static failedOpenCleanup:
    | { sqlite: Database.Database | undefined; writer: Database.Database | undefined }
    | undefined
  private readonly performanceProbe: DatabasePerformance | undefined

  readonly appUpdatesRepository: AppUpdatesRepository
  readonly appearanceSettingsRepository: AppearanceSettingsRepository
  readonly conversationRepository: ConversationRepository
  readonly defaultSessionSettingsRepository: DefaultSessionSettingsRepository
  readonly projectCatalogRepository: ProjectCatalogRepository
  readonly sessionRepository: SessionRepository
  readonly runtimePreparationRepository: RuntimePreparationRepository
  readonly workspaceChangesRepository: WorkspaceChangesRepository

  private constructor(
    private readonly sqlite: Database.Database,
    readonly drizzle: PactDrizzleDatabase,
    private readonly writer: Database.Database | undefined,
    filePath: string,
    measurePerformance = false,
  ) {
    this.performanceProbe = measurePerformance
      ? new DatabasePerformance(sqlite, drizzle, filePath)
      : undefined
    this.appUpdatesRepository = new AppUpdatesRepository(drizzle)
    this.appearanceSettingsRepository = new DrizzleAppearanceSettingsRepository(drizzle)
    this.conversationRepository = new ConversationRepository(drizzle)
    this.conversationRepository.recoverAbandonedBodyInputs()
    this.defaultSessionSettingsRepository = new DefaultSessionSettingsRepository(drizzle)
    this.projectCatalogRepository = new ProjectCatalogRepository(drizzle)
    this.sessionRepository = new SessionRepository(drizzle)
    this.runtimePreparationRepository = new DrizzleRuntimePreparationRepository(drizzle)
    this.workspaceChangesRepository = new WorkspaceChangesRepository(drizzle)
  }

  static async open(options: PactDatabaseOpenOptions): Promise<PactDatabase> {
    if (PactDatabase.failedOpenCleanup)
      throw new DatabaseOpenError(
        'DATABASE_STORAGE_FAILED',
        'writer-cleanup-unconfirmed',
        options.filePath,
      )
    const memory = options.filePath === ':memory:'
    const deadline = performance.now() + OPEN_DEADLINE_MS
    const checkDeadline = (): void => {
      if (options.signal?.aborted || performance.now() > deadline)
        throw new DatabaseOpenError(
          'DATABASE_STORAGE_FAILED',
          'opening-cancelled-or-deadline',
          options.filePath,
        )
    }
    let filePath = options.filePath
    let writer: Database.Database | undefined, sqlite: Database.Database | undefined
    let backupFilePath: string | undefined, stagingFilePath: string | undefined
    try {
      if (!memory) {
        const requested = resolve(options.filePath)
        PactDatabase.requireExactDriverPath(requested, options.filePath)
        mkdirSync(dirname(requested), { recursive: true, mode: 0o700 })
        filePath = join(realpathSync(dirname(requested)), basename(requested))
        const lockPath = join(dirname(filePath), '.pact-writer.sqlite')
        if (existsSync(lockPath)) PactDatabase.requireRegularFile(lockPath)
        writer = new Database(lockPath, { timeout: 0 })
        try {
          writer.exec('BEGIN EXCLUSIVE')
        } catch (cause) {
          throw new DatabaseOpenError(
            'DATABASE_IN_USE',
            'another-writer-owns-data-directory',
            filePath,
            { cause },
          )
        }
      }
      checkDeadline()
      const migrations = PactDatabase.loadMigrations(options.migrationsFolder, checkDeadline)
      if (memory) {
        sqlite = new Database(':memory:')
        sqlite.pragma('foreign_keys = ON')
        const drizzleDatabase = createDrizzleDatabase(sqlite, { schema })
        PactDatabase.applyMigrations(drizzleDatabase, migrations, 0, checkDeadline)
        return new PactDatabase(
          sqlite,
          drizzleDatabase,
          undefined,
          ':memory:',
          options.measurePerformance,
        )
      }
      if (!existsSync(filePath)) {
        stagingFilePath = join(dirname(filePath), `.pact-initialize-${randomUUID()}.sqlite`)
        closeSync(openSync(stagingFilePath, 'wx', 0o600))
        sqlite = new Database(stagingFilePath, { fileMustExist: true })
        sqlite.pragma('foreign_keys = ON')
        const staged = createDrizzleDatabase(sqlite, { schema })
        try {
          PactDatabase.applyMigrations(staged, migrations, 0, checkDeadline)
        } catch (cause) {
          throw new DatabaseMigrationError(filePath, { cause, stagingFilePath })
        }
        PactDatabase.requireCompatibleHistory(sqlite, migrations, filePath, true)
        sqlite.close()
        sqlite = undefined
        checkDeadline()
        // Atomic no-overwrite publication: a concurrent/unmanaged file is never replaced.
        linkSync(stagingFilePath, filePath)
        unlinkSync(stagingFilePath)
        stagingFilePath = undefined
      } else {
        PactDatabase.requireRegularFile(filePath)
        sqlite = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 0 })
        const applied = PactDatabase.requireCompatibleHistory(sqlite, migrations, filePath)
        if (applied < migrations.length) {
          checkDeadline()
          const reservedBackup = options.backupFilePath
            ? resolve(options.backupFilePath)
            : `${filePath}.before-migrate-${randomUUID()}.sqlite`
          PactDatabase.requireExactDriverPath(reservedBackup, filePath)
          mkdirSync(dirname(reservedBackup), { recursive: true, mode: 0o700 })
          try {
            closeSync(openSync(reservedBackup, 'wx', 0o600))
          } catch (cause) {
            throw new DatabaseOpenError(
              'DATABASE_BACKUP_FAILED',
              'backup-target-unavailable',
              filePath,
              { cause },
            )
          }
          try {
            // A failed backup retains its uniquely reserved target; no existing backup is overwritten.
            await sqlite.backup(reservedBackup, {
              progress: () => {
                checkDeadline()
                return 256
              },
            })
            const backup = new Database(reservedBackup, { readonly: true, fileMustExist: true })
            try {
              if (PactDatabase.requireCompatibleHistory(backup, migrations, filePath) !== applied)
                throw new Error('Backup history differs')
            } finally {
              backup.close()
            }
            backupFilePath = reservedBackup
          } catch (cause) {
            throw new DatabaseOpenError('DATABASE_BACKUP_FAILED', 'backup-failed', filePath, {
              cause,
              partialBackupFilePath: reservedBackup,
            })
          }
        }
        sqlite.close()
        sqlite = undefined
      }
      checkDeadline()
      sqlite = new Database(filePath, { fileMustExist: true, timeout: 0 })
      // The lock remains held over the readonly-to-writable transition and revalidation.
      const applied = PactDatabase.requireCompatibleHistory(sqlite, migrations, filePath)
      sqlite.pragma('foreign_keys = ON')
      sqlite.pragma('journal_mode = WAL')
      const drizzleDatabase = createDrizzleDatabase(sqlite, { schema })
      if (applied < migrations.length) {
        try {
          PactDatabase.applyMigrations(drizzleDatabase, migrations, applied, checkDeadline)
        } catch (cause) {
          throw new DatabaseMigrationError(filePath, {
            cause,
            ...(backupFilePath ? { backupFilePath } : {}),
          })
        }
      }
      return new PactDatabase(sqlite, drizzleDatabase, writer, filePath, options.measurePerformance)
    } catch (cause) {
      // A connection which has not physically closed retains its writer reservation.
      try {
        if (sqlite?.open) sqlite.close()
        if (writer?.open) writer.close()
      } catch (closeCause) {
        PactDatabase.failedOpenCleanup = { sqlite, writer }
        throw new DatabaseOpenError(
          'DATABASE_STORAGE_FAILED',
          'writer-cleanup-unconfirmed',
          filePath,
          {
            cause: closeCause,
            ...(backupFilePath ? { backupFilePath } : {}),
            ...(stagingFilePath ? { stagingFilePath } : {}),
          },
        )
      }
      if (cause instanceof DatabaseOpenError) throw cause
      throw new DatabaseOpenError(
        'DATABASE_STORAGE_FAILED',
        'storage-or-migration-package-unavailable',
        filePath,
        {
          cause,
          ...(backupFilePath ? { backupFilePath } : {}),
          ...(stagingFilePath ? { stagingFilePath } : {}),
        },
      )
    }
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close()
    this.performanceProbe?.dispose(this.drizzle)
    if (this.writer?.open) this.writer.close()
  }

  private static requireExactDriverPath(path: string, filePath: string): void {
    if (path !== path.trim() || path.includes('\0'))
      throw new DatabaseOpenError(
        'DATABASE_STORAGE_FAILED',
        'database-path-normalization-ambiguous',
        filePath,
      )
  }

  isHealthy(): boolean {
    return this.sqlite.open
  }

  performanceDiagnostics(): ReturnType<DatabasePerformance['snapshot']> | undefined {
    return this.performanceProbe?.snapshot()
  }

  private static requireRegularFile(path: string): void {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('Database and writer files must be owned regular single-link files')
  }

  private static loadMigrations(folder: string, checkDeadline: () => void): Migration[] {
    const journalPath = join(folder, 'meta/_journal.json')
    const journalInfo = lstatSync(journalPath)
    if (!journalInfo.isFile() || journalInfo.isSymbolicLink())
      throw new Error('Migration journal must be a regular file')
    if (journalInfo.size > MIGRATION_FILE_BYTES) throw new Error('Migration journal exceeds 1 MiB')
    const journal: unknown = JSON.parse(readFileSync(journalPath, 'utf8'))
    if (!journal || typeof journal !== 'object' || Reflect.get(journal, 'dialect') !== 'sqlite')
      throw new Error('Invalid migration journal')
    const entries: unknown = Reflect.get(journal, 'entries')
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MIGRATION_COUNT_LIMIT)
      throw new Error('Migration inventory exceeds its bound or is empty')
    let total = 0,
      previousTime = 0
    return entries.map((entry: unknown, index: number) => {
      checkDeadline()
      if (!entry || typeof entry !== 'object') throw new Error('Invalid migration entry')
      const tag: unknown = Reflect.get(entry, 'tag'),
        createdAt: unknown = Reflect.get(entry, 'when')
      if (
        Reflect.get(entry, 'idx') !== index ||
        typeof tag !== 'string' ||
        !/^\d{4}_[a-z0-9_-]+$/iu.test(tag) ||
        typeof createdAt !== 'number' ||
        !Number.isSafeInteger(createdAt) ||
        createdAt <= previousTime
      )
        throw new Error('Invalid ordered migration identity')
      previousTime = createdAt
      const path = join(folder, `${tag}.sql`)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MIGRATION_FILE_BYTES)
        throw new Error('Invalid or oversized SQL migration')
      const bytes = readFileSync(path)
      total += bytes.byteLength
      if (bytes.byteLength === 0 || total > MIGRATION_TOTAL_BYTES)
        throw new Error('SQL migration working set exceeds 16 MiB')
      const source = bytes.toString('utf8')
      if (!Buffer.from(source).equals(bytes)) throw new Error('SQL migration is not complete UTF-8')
      const statements = source
        .split('--> statement-breakpoint')
        .filter((statement) => statement.trim())
      if (statements.length === 0 || statements.length > 4096)
        throw new Error('Invalid SQL statement inventory')
      return { hash: createHash('sha256').update(bytes).digest('hex'), createdAt, statements }
    })
  }

  private static requireCompatibleHistory(
    sqlite: Database.Database,
    migrations: Migration[],
    filePath: string,
    exact = false,
  ): number {
    const fail = (reason: string): never => {
      throw new DatabaseOpenError('DATABASE_INCOMPATIBLE', reason, filePath)
    }
    let table: unknown
    try {
      table = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
        )
        .get()
    } catch {
      return fail('invalid-migration-history')
    }
    if (!table) return fail('missing-migration-history')
    // A declared column named rowid can hide SQLite's insertion order and force an unbounded sort.
    // Only the known ordinary rowid table shape can establish the migration-history proof.
    try {
      const columns = sqlite
        .prepare<
          [],
          { cid: number; name: string; type: string; pk: number; hidden: number; required: number }
        >(
          'SELECT cid, CASE WHEN length(CAST(name AS BLOB)) <= 32 THEN name ELSE NULL END AS name, CASE WHEN length(type) <= 16 THEN upper(type) ELSE NULL END AS type, pk, hidden, "notnull" AS required FROM pragma_table_xinfo(\'__drizzle_migrations\') LIMIT 4',
        )
        .all()
      const ordinary = sqlite
        .prepare<[], { type: string; wr: number }>(
          "SELECT type, wr FROM pragma_table_list WHERE schema='main' AND name='__drizzle_migrations' LIMIT 2",
        )
        .all()
      if (
        columns.length !== 3 ||
        ordinary.length !== 1 ||
        ordinary[0]!.type !== 'table' ||
        ordinary[0]!.wr !== 0 ||
        columns.some(
          (column, index) =>
            column.cid !== index ||
            column.hidden !== 0 ||
            column.name !== ['id', 'hash', 'created_at'][index],
        ) ||
        !['SERIAL', 'INTEGER'].includes(columns[0]!.type) ||
        columns[0]!.pk !== 1 ||
        columns[1]!.type !== 'TEXT' ||
        columns[1]!.required !== 1 ||
        columns[1]!.pk !== 0 ||
        !['NUMERIC', 'INTEGER'].includes(columns[2]!.type) ||
        columns[2]!.pk !== 0
      )
        return fail('unproven-migration-history-shape')
    } catch {
      return fail('unproven-migration-history-shape')
    }
    let rows: HistoryRow[]
    try {
      rows = sqlite
        .prepare<[number], HistoryRow>(
          "SELECT CASE WHEN typeof(hash) = 'text' AND octet_length(hash) = 64 THEN hash ELSE NULL END AS hash, CASE WHEN typeof(created_at) IN ('integer', 'real') THEN created_at ELSE NULL END AS createdAt FROM __drizzle_migrations ORDER BY rowid LIMIT ?",
        )
        .all(migrations.length + 1)
    } catch {
      return fail('invalid-migration-history')
    }
    if (!rows.length) return fail('missing-migration-history')
    if (rows.length > migrations.length) return fail('newer-migration-history')
    for (const [index, row] of rows.entries()) {
      const expected = migrations[index]!
      if (
        typeof row.hash !== 'string' ||
        row.hash !== expected.hash ||
        row.createdAt !== expected.createdAt
      )
        return fail('divergent-migration-history')
    }
    if (exact && rows.length !== migrations.length) return fail('incomplete-initialization')
    return rows.length
  }

  private static applyMigrations(
    database: PactDrizzleDatabase,
    migrations: Migration[],
    applied: number,
    checkDeadline: () => void,
  ): void {
    database.transaction((transaction) => {
      transaction.run(
        sql`CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)`,
      )
      for (const migration of migrations.slice(applied)) {
        for (const statement of migration.statements) {
          checkDeadline()
          transaction.run(sql.raw(statement))
        }
        transaction
          .insert(drizzleMigrations)
          .values({ hash: migration.hash, createdAt: migration.createdAt })
          .run()
      }
    })
  }
}
