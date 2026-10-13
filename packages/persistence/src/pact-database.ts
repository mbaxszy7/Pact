import Database from 'better-sqlite3'
import { max, sql } from 'drizzle-orm'
import { drizzle as createDrizzleDatabase } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import {
  DrizzleAppearanceSettingsRepository,
  type AppearanceSettingsRepository,
} from './appearance-settings-repository.js'
import { ConversationRepository } from './conversation-repository.js'
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
}

export class DatabaseMigrationError extends Error {
  override readonly cause: unknown
  readonly backupFilePath: string | undefined

  constructor(message: string, options: { cause: unknown; backupFilePath?: string }) {
    super(message)
    this.name = 'DatabaseMigrationError'
    this.cause = options.cause
    this.backupFilePath = options.backupFilePath
  }
}

const drizzleMigrations = sqliteTable('__drizzle_migrations', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  createdAt: integer('created_at'),
})

export class PactDatabase {
  private static readonly migrationsTable = '__drizzle_migrations'

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
  ) {
    this.appearanceSettingsRepository = new DrizzleAppearanceSettingsRepository(drizzle)
    this.conversationRepository = new ConversationRepository(drizzle)
    this.defaultSessionSettingsRepository = new DefaultSessionSettingsRepository(drizzle)
    this.projectCatalogRepository = new ProjectCatalogRepository(drizzle)
    this.sessionRepository = new SessionRepository(drizzle)
    this.runtimePreparationRepository = new DrizzleRuntimePreparationRepository(drizzle)
    this.workspaceChangesRepository = new WorkspaceChangesRepository(drizzle)
  }

  static async open(options: PactDatabaseOpenOptions): Promise<PactDatabase> {
    const isMemoryDatabase = options.filePath === ':memory:'
    const databaseAlreadyExists = !isMemoryDatabase && existsSync(options.filePath)
    if (!isMemoryDatabase) mkdirSync(dirname(options.filePath), { recursive: true })

    const sqlite = new Database(options.filePath)
    sqlite.pragma('foreign_keys = ON')
    if (!isMemoryDatabase) sqlite.pragma('journal_mode = WAL')

    const drizzleDatabase = createDrizzleDatabase(sqlite, { schema })
    const backupFilePath =
      options.backupFilePath ??
      (databaseAlreadyExists ? `${options.filePath}.before-migrate.bak` : undefined)

    try {
      await PactDatabase.applyPendingMigrations(
        sqlite,
        drizzleDatabase,
        options.migrationsFolder,
        backupFilePath,
      )
    } catch (cause) {
      sqlite.close()
      throw new DatabaseMigrationError('Failed to migrate the Pact database.', {
        cause,
        ...(backupFilePath ? { backupFilePath } : {}),
      })
    }

    return new PactDatabase(sqlite, drizzleDatabase)
  }

  close(): void {
    this.sqlite.close()
  }

  isHealthy(): boolean {
    return this.sqlite.open
  }

  private static async applyPendingMigrations(
    sqlite: Database.Database,
    drizzleDatabase: PactDrizzleDatabase,
    migrationsFolder: string,
    backupFilePath: string | undefined,
  ): Promise<void> {
    if (!PactDatabase.hasPendingMigrations(drizzleDatabase, migrationsFolder)) return

    if (backupFilePath) {
      mkdirSync(dirname(backupFilePath), { recursive: true })
      await sqlite.backup(backupFilePath)
    }
    migrate(drizzleDatabase, { migrationsFolder })
  }

  private static hasPendingMigrations(
    drizzleDatabase: PactDrizzleDatabase,
    migrationsFolder: string,
  ): boolean {
    const latestApplied = PactDatabase.latestAppliedMigration(drizzleDatabase)
    return readMigrationFiles({ migrationsFolder }).some(
      (migration) => latestApplied === undefined || migration.folderMillis > latestApplied,
    )
  }

  private static latestAppliedMigration(drizzleDatabase: PactDrizzleDatabase): number | undefined {
    const tableExists = drizzleDatabase.get<{ name: string }>(sql`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ${PactDatabase.migrationsTable}
    `)
    if (!tableExists) return undefined

    const row = drizzleDatabase
      .select({ createdAt: max(drizzleMigrations.createdAt) })
      .from(drizzleMigrations)
      .get()
    return row?.createdAt ?? undefined
  }
}
