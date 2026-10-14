import { lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import type { PactDrizzleDatabase } from '../../packages/persistence/src/drizzle-database.js'
import type { RuntimeFixture } from './runtime-fixture.js'

import { ConversationRepository } from '../../packages/persistence/src/conversation-repository.js'
import { DrizzleRuntimePreparationRepository } from '../../packages/persistence/src/runtime-preparation-repository.js'
import { schema } from '../../packages/persistence/src/schema/index.js'

// Resolve the Node-native dependency from its owner, independent of Electron's rebuilt copy.
const requireFromPersistence = createRequire(
  resolve(import.meta.dirname, '../../packages/persistence/package.json'),
)
interface NativeStatement {
  raw(): NativeStatement
  get(...parameters: unknown[]): unknown
  iterate(...parameters: unknown[]): IterableIterator<unknown>
  run(...parameters: unknown[]): unknown
}
interface NativeDatabase {
  prepare(sql: string): NativeStatement
  close(): void
}
interface GuardedStatement {
  raw(): GuardedStatement
  get(...parameters: unknown[]): unknown
  all(...parameters: unknown[]): unknown[]
  run(...parameters: unknown[]): unknown
}
type SqliteConstructor = new (
  file: string,
  options: { readonly: true; fileMustExist: true; timeout: 0 },
) => NativeDatabase
interface DrizzleModule {
  drizzle: (
    client: { prepare(sql: string): unknown },
    options: { schema: typeof schema },
  ) => PactDrizzleDatabase
}
function isSqliteConstructor(value: unknown): value is SqliteConstructor {
  return typeof value === 'function'
}
function isDrizzleModule(value: unknown): value is DrizzleModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'drizzle') === 'function'
  )
}
const sqliteModule: unknown = requireFromPersistence('better-sqlite3')
const drizzleModule: unknown = requireFromPersistence('drizzle-orm/better-sqlite3')
if (!isSqliteConstructor(sqliteModule) || !isDrizzleModule(drizzleModule))
  throw new Error('Owned native SQLite observation dependencies are unavailable')
const NativeSqlite = sqliteModule
const createDrizzle = drizzleModule.drizzle

const observationItems = 4096
const observationBytes = 8 * 1024 * 1024
const databaseBytes = 512 * 1024 * 1024
const statementBytes = 64 * 1024
const observationLeaseMs = 600_000

type OwnedFixture = Pick<RuntimeFixture, 'directory' | 'databaseFile'>
type ReadProjection = Pick<PactDrizzleDatabase, 'query' | 'select'>

/** Test-only observation; the running app remains the sole production writer. */
export class ReadonlyFixtureDatabase {
  private closed = false
  private readonly deadline = performance.now() + observationLeaseMs
  private readonly database: PactDrizzleDatabase
  readonly conversationRepository: Pick<ConversationRepository, 'read'>
  readonly runtimePreparationRepository: Pick<
    DrizzleRuntimePreparationRepository,
    'readSelectedExecutablePath'
  >

  private constructor(private readonly sqlite: NativeDatabase) {
    this.database = createDrizzle({ prepare: (sql) => this.prepare(sql) }, { schema })
    // Persistence recovery belongs to PactDatabase's writer lifecycle; this projection only reads.
    const conversation = new ConversationRepository(this.database)
    const runtime = new DrizzleRuntimePreparationRepository(this.database)
    this.conversationRepository = {
      read: (sessionId) => {
        this.requireOpen()
        const result = conversation.read(sessionId)
        requireResultBound(result)
        this.requireOpen()
        return result
      },
    }
    this.runtimePreparationRepository = {
      readSelectedExecutablePath: (agentId) => {
        this.requireOpen()
        return runtime.readSelectedExecutablePath(agentId)
      },
    }
  }

  static open(fixture: OwnedFixture): ReadonlyFixtureDatabase {
    const file = ownedDatabaseFile(fixture)
    const before = lstatSync(file)
    const sqlite = new NativeSqlite(file, { readonly: true, fileMustExist: true, timeout: 0 })
    try {
      const after = lstatSync(ownedDatabaseFile(fixture))
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error('Fixture database identity changed during readonly admission')
      return new ReadonlyFixtureDatabase(sqlite)
    } catch (error) {
      sqlite.close()
      throw error
    }
  }

  get drizzle(): ReadProjection {
    this.requireOpen()
    return this.database
  }

  close(): void {
    if (this.closed) return
    this.sqlite.close()
    this.closed = true
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Readonly fixture observation is closed')
    if (performance.now() >= this.deadline)
      throw new Error('Readonly fixture observation exceeded its lease deadline')
  }

  private prepare(sql: string): GuardedStatement {
    this.requireOpen()
    if (Buffer.byteLength(sql) > statementBytes)
      throw new Error('Readonly fixture statement exceeds its byte bound')
    const native = this.sqlite.prepare(sql)
    const prepared = {
      raw: () => {
        this.requireOpen()
        native.raw()
        return prepared
      },
      get: (...parameters: unknown[]) => {
        this.requireOpen()
        const result = native.get(...parameters)
        requireResultBound(result)
        this.requireOpen()
        return result
      },
      all: (...parameters: unknown[]) => {
        this.requireOpen()
        const rows: unknown[] = []
        let bytes = 0
        // Native iteration bounds hydration, including production complete-read baselines.
        for (const row of native.iterate(...parameters)) {
          this.requireOpen()
          bytes += resultBytes(row)
          if (rows.length >= observationItems || bytes > observationBytes)
            throw new Error('Readonly fixture query exceeds its item/byte bound')
          rows.push(row)
        }
        return rows
      },
      run: (...parameters: unknown[]) => {
        this.requireOpen()
        // SQLite itself rejects writes even if a test bypasses the read-only TypeScript projection.
        const result = native.run(...parameters)
        this.requireOpen()
        return result
      },
    }
    return prepared
  }
}

function ownedDatabaseFile(fixture: OwnedFixture): string {
  if (!isAbsolute(fixture.directory) || !isAbsolute(fixture.databaseFile))
    throw new Error('Readonly observation requires absolute fixture paths')
  const rootStat = lstatSync(fixture.directory)
  const root = realpathSync(fixture.directory)
  const temporaryRoot = realpathSync(tmpdir())
  const ownedName = relative(temporaryRoot, root)
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    dirname(root) !== temporaryRoot ||
    ownedName !== basename(root) ||
    !/^pact-runtime-e2e-[a-zA-Z0-9]+$/u.test(ownedName) ||
    (process.platform !== 'win32' &&
      (rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0))
  )
    throw new Error('Readonly observation requires an owned private runtime fixture directory')
  if (resolve(fixture.databaseFile) !== join(resolve(fixture.directory), 'pact.sqlite'))
    throw new Error('Readonly observation requires the fixture database, not another data path')
  const file = join(root, 'pact.sqlite')
  requireRegularFile(file)
  for (const suffix of ['-wal', '-shm']) {
    try {
      requireRegularFile(file + suffix)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return file
}

function requireRegularFile(file: string): void {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > databaseBytes)
    throw new Error('Readonly fixture database and sidecars must be bounded regular owned files')
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '')
}

function requireResultBound(value: unknown): void {
  if (
    (Array.isArray(value) && value.length > observationItems) ||
    resultBytes(value) > observationBytes
  )
    throw new Error('Readonly fixture observation exceeds its item/byte bound')
}
