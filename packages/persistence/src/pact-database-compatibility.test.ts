import Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DefaultSessionSettings } from '@pact/contracts'

import { PactDatabase, DatabaseOpenError } from './pact-database.js'

const folder = resolve(import.meta.dirname, '../drizzle')
const migrations = readMigrationFiles({ migrationsFolder: folder })
const legacyGroupCleanupIndex = 105
const legacyGroupCleanupTag = '0105_legacy_sidebar_empty_groups.sql'
const legacyGroupCleanupPath = resolve(
  import.meta.dirname,
  '../../../tests/fixtures/migrations',
  legacyGroupCleanupTag,
)
const groupCleanupReplacement = migrations[legacyGroupCleanupIndex]!
const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-compatible-database-'))
  directories.push(directory)
  return { directory, filePath: join(directory, 'pact.sqlite') }
}
function historical(file: string, count = migrations.length) {
  const db = new Database(file)
  try {
    db.exec(
      'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)',
    )
    db.transaction(() => {
      for (const migration of migrations.slice(0, count)) {
        for (const statement of migration.sql) db.exec(statement)
        db.prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)').run(
          migration.hash,
          migration.folderMillis,
        )
      }
      db.exec(
        "CREATE TABLE preserved_fixture(value TEXT); INSERT INTO preserved_fixture VALUES ('preserved')",
      )
    })()
  } finally {
    db.close()
  }
}

async function copyMigrationPrefix(
  directory: string,
  count: number,
  followUp?: string,
): Promise<string> {
  const prefix = join(directory, followUp ? 'with-follow-up' : `prefix-${count}`)
  await cp(folder, prefix, { recursive: true })
  const path = join(prefix, 'meta', '_journal.json')
  const journal: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!journal || typeof journal !== 'object' || !('entries' in journal))
    throw new Error('Invalid migration journal.')
  if (!Array.isArray(journal.entries)) throw new Error('Invalid migration entries.')
  const entries: unknown[] = journal.entries.slice(0, count)
  if (followUp) {
    const tag = '0106_fixture_follow_up'
    await writeFile(join(prefix, `${tag}.sql`), followUp)
    entries.push({
      idx: count,
      version: '6',
      when: groupCleanupReplacement.folderMillis + 1,
      tag,
      breakpoints: true,
    })
  }
  await writeFile(path, JSON.stringify({ ...journal, entries }))
  return prefix
}

async function historicalWithLegacyGroupCleanup(filePath: string) {
  historical(filePath, legacyGroupCleanupIndex)
  const originalSql = await readFile(legacyGroupCleanupPath, 'utf8')
  const hash = createHash('sha256').update(originalSql).digest('hex')
  const receipt = { hash, created_at: groupCleanupReplacement.folderMillis }
  const raw = new Database(filePath)
  try {
    raw.pragma('foreign_keys = ON')
    raw.transaction(() => {
      raw.exec(originalSql)
      raw
        .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
        .run(receipt.hash, receipt.created_at)
    })()
  } finally {
    raw.close()
  }
  return receipt
}
async function digest(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('complete migration compatibility through PactDatabase.open', () => {
  it('refuses a shadow rowid that disguises reversed physical migration history without modifying data', async () => {
    const { filePath } = await fixture()
    historical(filePath)
    const raw = new Database(filePath)
    try {
      const rows = raw
        .prepare<[], { hash: string; created_at: number }>(
          'SELECT hash,created_at FROM __drizzle_migrations ORDER BY rowid',
        )
        .all()
      raw.exec(
        'DROP TABLE __drizzle_migrations; CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC,rowid INTEGER)',
      )
      for (let index = rows.length - 1; index >= 0; index--)
        raw
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at,rowid) VALUES(?,?,?)')
          .run(rows[index]!.hash, rows[index]!.created_at, index + 1)
    } finally {
      raw.close()
    }
    const before = await digest(filePath)
    await expect(PactDatabase.open({ filePath, migrationsFolder: folder })).rejects.toMatchObject({
      reason: 'unproven-migration-history-shape',
    })
    expect(await digest(filePath)).toBe(before)
  })

  it('rejects a driver-trimmed backup path before reserving or overwriting either recovery file', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath, 1)
    const backup = join(directory, 'recovery.sqlite')
    historical(backup)
    const before = await digest(backup),
      source = await digest(filePath)
    await expect(
      PactDatabase.open({ filePath, migrationsFolder: folder, backupFilePath: `${backup} ` }),
    ).rejects.toMatchObject({ reason: 'database-path-normalization-ambiguous' })
    expect(await digest(backup)).toBe(before)
    expect(await digest(filePath)).toBe(source)
    expect(await readdir(directory)).not.toContain('recovery.sqlite ')
  })

  it('initializes a missing file atomically and retains its writer for the business lifetime', async () => {
    const { directory, filePath } = await fixture()
    const first = await PactDatabase.open({ filePath, migrationsFolder: folder })
    try {
      await expect(PactDatabase.open({ filePath, migrationsFolder: folder })).rejects.toMatchObject(
        { code: 'DATABASE_IN_USE' },
      )
      expect((await readdir(directory)).some((name) => name.startsWith('.pact-initialize-'))).toBe(
        false,
      )
      const history = first.drizzle.all(
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid',
      )
      expect(history).toHaveLength(migrations.length)
      expect(history[legacyGroupCleanupIndex]).toEqual({
        hash: groupCleanupReplacement.hash,
        created_at: groupCleanupReplacement.folderMillis,
      })
    } finally {
      first.close()
    }
    const next = await PactDatabase.open({ filePath, migrationsFolder: folder })
    next.close()
  })

  it('opens identical ordered NULL-id Drizzle history without making a backup', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath)
    const db = await PactDatabase.open({ filePath, migrationsFolder: folder })
    try {
      expect(db.drizzle.get('SELECT value FROM preserved_fixture')).toEqual({ value: 'preserved' })
    } finally {
      db.close()
    }
    expect((await readdir(directory)).some((name) => name.includes('before-migrate'))).toBe(false)
  })

  it('preserves a group with a previously hidden member and a later archived member on upgrade', async () => {
    const { directory, filePath } = await fixture()
    const prefix = await copyMigrationPrefix(directory, legacyGroupCleanupIndex)
    const legacy = await PactDatabase.open({ filePath, migrationsFolder: prefix })
    const projectId = randomUUID(),
      groupId = randomUUID(),
      archivedId = randomUUID(),
      hiddenId = randomUUID(),
      laterGroupId = randomUUID()
    const createdAt = '2026-10-14T00:00:00.000Z'
    const settings: DefaultSessionSettings = {
      primaryAgentId: 'codex',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    }
    const groupInput = { projectId, groupId }
    const sessionRepository = legacy.sessionRepository
    try {
      legacy.projectCatalogRepository.add({
        id: projectId,
        name: 'Migration fixture',
        directoryPath: '/group-migration-fixture',
        kind: 'directory',
        createdAt,
      })
      sessionRepository.create(
        { id: archivedId, projectId, title: 'Archive later', createdAt },
        settings,
      )
      sessionRepository.create(
        { id: hiddenId, projectId, title: 'Hide first', createdAt },
        settings,
      )
      const first = sessionRepository.createSessionGroup({
        ...groupInput,
        name: 'Keep this group',
        color: 'purple',
        sessionId: archivedId,
        expectedRevision: 0,
      })
      const joined = sessionRepository.setSessionGroup({
        ...groupInput,
        sessionId: hiddenId,
        expectedRevision: first.revision,
      })
      sessionRepository.createSessionGroup({
        projectId,
        groupId: laterGroupId,
        name: 'Keep this position',
        color: 'blue',
        expectedRevision: joined.revision,
      })
      sessionRepository.setSidebarHidden({ sessionId: hiddenId, hidden: true })

      const archives = legacy.conversationRepository.archives
      const scope = { kind: 'session' as const, sessionId: archivedId }
      const operationId = randomUUID()
      archives.prepare(
        {
          ...archives.context(scope),
          scope,
          operationId,
          tasks: [],
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
        'fixture',
      )
      archives.claim(operationId, 'fixture', [], [], () => {})
      archives.finish(operationId, [], () => sessionRepository.archive(archivedId, operationId))
      expect(sessionRepository.readSessionGroup(groupInput).exists).toBe(true)
      expect(sessionRepository.find(archivedId)?.groupId).toBe(groupId)
      expect(sessionRepository.find(hiddenId)?.groupId).toBe(groupId)
    } finally {
      legacy.close()
    }

    const upgraded = await PactDatabase.open({ filePath, migrationsFolder: folder })
    try {
      const sessions = upgraded.sessionRepository
      expect(sessions.readSessionGroups({ projectId }).groups).toMatchObject([
        { id: groupId, name: 'Keep this group', color: 'purple', position: 0 },
        { id: laterGroupId, position: 1 },
      ])
      expect(sessions.find(archivedId)).toMatchObject({ groupId, status: 'archived' })
      expect(sessions.find(hiddenId)).toMatchObject({ groupId, sidebarHidden: true })
      expect(sessions.restore(archivedId).session.groupId).toBe(groupId)
      expect(
        upgraded.drizzle.all('SELECT hash FROM __drizzle_migrations ORDER BY rowid')[
          legacyGroupCleanupIndex
        ],
      ).toEqual({ hash: groupCleanupReplacement.hash })
    } finally {
      upgraded.close()
    }
  })

  it('opens an exact previously applied legacy group cleanup without rewriting its receipt', async () => {
    const { directory, filePath } = await fixture()
    const receipt = await historicalWithLegacyGroupCleanup(filePath)
    const prefix = await copyMigrationPrefix(directory, legacyGroupCleanupIndex + 1)
    const opened = await PactDatabase.open({ filePath, migrationsFolder: prefix })
    try {
      expect(opened.drizzle.get('SELECT value FROM preserved_fixture')).toEqual({
        value: 'preserved',
      })
      expect(
        opened.drizzle.get(
          'SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid DESC LIMIT 1',
        ),
      ).toEqual(receipt)
    } finally {
      opened.close()
    }
    expect((await readdir(directory)).some((name) => name.includes('before-migrate'))).toBe(false)
  })

  it('backs up the exact legacy receipt before applying a later migration', async () => {
    const { directory, filePath } = await fixture()
    const receipt = await historicalWithLegacyGroupCleanup(filePath)
    const backupFilePath = join(directory, 'verified-backup.sqlite')
    const prefix = await copyMigrationPrefix(
      directory,
      legacyGroupCleanupIndex + 1,
      "CREATE TABLE migration_follow_up(value TEXT);\n--> statement-breakpoint\nINSERT INTO migration_follow_up VALUES ('ready');",
    )
    const upgraded = await PactDatabase.open({ filePath, migrationsFolder: prefix, backupFilePath })
    try {
      expect(upgraded.drizzle.get('SELECT value FROM migration_follow_up')).toEqual({
        value: 'ready',
      })
      expect(
        upgraded.drizzle.all('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid')[
          legacyGroupCleanupIndex
        ],
      ).toEqual(receipt)
    } finally {
      upgraded.close()
    }
    const backup = new Database(backupFilePath, { readonly: true, fileMustExist: true })
    try {
      expect(
        backup
          .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid DESC LIMIT 1')
          .get(),
      ).toEqual(receipt)
      expect(
        backup.prepare("SELECT name FROM sqlite_master WHERE name='migration_follow_up'").get(),
      ).toBeUndefined()
    } finally {
      backup.close()
    }
  })

  it.each(['backup', 'source'] as const)(
    'rejects a %s that changes between the two known cleanup receipts before applying migrations',
    async (changed) => {
      const { directory, filePath } = await fixture()
      await historicalWithLegacyGroupCleanup(filePath)
      const prefix = await copyMigrationPrefix(
        directory,
        legacyGroupCleanupIndex + 1,
        'CREATE TABLE migration_follow_up(value TEXT);',
      )
      // oxlint-disable-next-line typescript/unbound-method -- Call the original with the live database receiver.
      const originalBackup = Database.prototype.backup
      vi.spyOn(Database.prototype, 'backup').mockImplementation(
        async function (this: Database.Database, target, options) {
          const result = await originalBackup.call(this, target, options)
          const other = new Database(changed === 'backup' ? target : filePath, {
            fileMustExist: true,
          })
          try {
            other
              .prepare('UPDATE __drizzle_migrations SET hash=? WHERE rowid=?')
              .run(groupCleanupReplacement.hash, legacyGroupCleanupIndex + 1)
          } finally {
            other.close()
          }
          return result
        },
      )
      const recoveryPath = expect.any(String)
      await expect(PactDatabase.open({ filePath, migrationsFolder: prefix })).rejects.toMatchObject(
        changed === 'backup'
          ? { code: 'DATABASE_BACKUP_FAILED', partialBackupFilePath: recoveryPath }
          : { reason: 'migration-history-changed-during-open', backupFilePath: recoveryPath },
      )
      const current = new Database(filePath, { readonly: true, fileMustExist: true })
      try {
        expect(
          current.prepare("SELECT name FROM sqlite_master WHERE name='migration_follow_up'").get(),
        ).toBeUndefined()
        expect(current.pragma('journal_mode', { simple: true })).toBe('delete')
      } finally {
        current.close()
      }
    },
  )

  it('refuses a package with the original cleanup SQL in the active migration slot', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath, legacyGroupCleanupIndex)
    const prefix = await copyMigrationPrefix(directory, legacyGroupCleanupIndex + 1)
    await cp(legacyGroupCleanupPath, join(prefix, legacyGroupCleanupTag))
    const before = await digest(filePath)
    await expect(PactDatabase.open({ filePath, migrationsFolder: prefix })).rejects.toMatchObject({
      code: 'DATABASE_STORAGE_FAILED',
      reason: 'storage-or-migration-package-unavailable',
    })
    expect(await digest(filePath)).toBe(before)
    expect((await readdir(directory)).some((name) => name.includes('before-migrate'))).toBe(false)
  })

  it.each(['wrong-slot', 'wrong-timestamp', 'unknown-hash'] as const)(
    'refuses a legacy group cleanup receipt with %s before writing the database',
    async (kind) => {
      const { directory, filePath } = await fixture()
      historical(filePath)
      const hash = await digest(legacyGroupCleanupPath)
      const original = new Database(filePath)
      try {
        const index = kind === 'wrong-slot' ? legacyGroupCleanupIndex - 1 : legacyGroupCleanupIndex
        const createdAt = migrations[index]!.folderMillis + (kind === 'wrong-timestamp' ? 1 : 0)
        original
          .prepare('UPDATE __drizzle_migrations SET hash=?,created_at=? WHERE rowid=?')
          .run(kind === 'unknown-hash' ? 'f'.repeat(64) : hash, createdAt, index + 1)
      } finally {
        original.close()
      }
      const before = await digest(filePath)
      await expect(PactDatabase.open({ filePath, migrationsFolder: folder })).rejects.toMatchObject(
        {
          code: 'DATABASE_INCOMPATIBLE',
          reason: 'divergent-migration-history',
        },
      )
      expect(await digest(filePath)).toBe(before)
      expect((await readdir(directory)).some((name) => name.includes('before-migrate'))).toBe(false)
    },
  )

  it.each([
    'wrong-hash',
    'missing-middle',
    'reordered',
    'duplicate',
    'newer',
    'empty',
    'unmanaged',
    'zero-file',
  ] as const)('preserves the exact original file and refuses %s history', async (kind) => {
    const { directory, filePath } = await fixture()
    if (kind === 'zero-file') await writeFile(filePath, '')
    else {
      historical(filePath)
      const original = new Database(filePath)
      try {
        if (kind === 'wrong-hash')
          original.exec("UPDATE __drizzle_migrations SET hash = 'version-zero' WHERE rowid = 1")
        if (kind === 'missing-middle')
          original.exec('DELETE FROM __drizzle_migrations WHERE rowid = 2')
        if (kind === 'reordered')
          original
            .prepare('UPDATE __drizzle_migrations SET hash=?,created_at=? WHERE rowid=1')
            .run(migrations[1]!.hash, migrations[1]!.folderMillis)
        if (kind === 'duplicate')
          original
            .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
            .run(migrations[0]!.hash, migrations[0]!.folderMillis)
        if (kind === 'newer')
          original
            .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
            .run('a'.repeat(64), migrations.at(-1)!.folderMillis + 1)
        if (kind === 'empty') original.exec('DELETE FROM __drizzle_migrations')
        if (kind === 'unmanaged') original.exec('DROP TABLE __drizzle_migrations')
      } finally {
        original.close()
      }
    }
    const before = await digest(filePath)
    const result: unknown = await PactDatabase.open({ filePath, migrationsFolder: folder }).catch(
      (error: unknown) => error,
    )
    if (result instanceof PactDatabase) result.close()
    expect(result).toBeInstanceOf(DatabaseOpenError)
    expect(result).toMatchObject({ code: 'DATABASE_INCOMPATIBLE' })
    expect(await digest(filePath)).toBe(before)
    expect((await readdir(directory)).some((name) => name.includes('before-migrate'))).toBe(false)
  })

  it('never overwrites an existing recovery backup', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath, 1)
    const backupFilePath = join(directory, 'recovery.sqlite')
    await writeFile(backupFilePath, 'existing recovery evidence')
    const before = await digest(filePath)
    await expect(
      PactDatabase.open({ filePath, migrationsFolder: folder, backupFilePath }),
    ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' })
    expect(await readFile(backupFilePath, 'utf8')).toBe('existing recovery evidence')
    expect(await digest(filePath)).toBe(before)
  })

  it('uses the already validated migration bytes when the checkout changes during backup', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath, 1)
    const ownFolder = join(directory, 'migrations')
    await cp(folder, ownFolder, { recursive: true })
    // oxlint-disable-next-line typescript/unbound-method -- The probe explicitly invokes the saved native method with the original receiver.
    const originalBackup = Database.prototype.backup
    vi.spyOn(Database.prototype, 'backup').mockImplementation(
      async function (this: Database.Database, target, options) {
        await writeFile(
          join(ownFolder, '0001_appearance_preferences.sql'),
          'INVALID SQL FROM A DIFFERENT CHECKOUT',
        )
        return originalBackup.call(this, target, options)
      },
    )
    const db = await PactDatabase.open({ filePath, migrationsFolder: ownFolder })
    try {
      expect(db.drizzle.get('SELECT value FROM preserved_fixture')).toEqual({ value: 'preserved' })
      expect(db.drizzle.all('SELECT hash FROM __drizzle_migrations')).toHaveLength(
        migrations.length,
      )
    } finally {
      db.close()
    }
  })

  it('rolls back the complete failed upgrade and retains its completed backup', async () => {
    const { directory, filePath } = await fixture()
    historical(filePath, 1)
    const ownFolder = join(directory, 'migrations')
    await cp(folder, ownFolder, { recursive: true })
    await writeFile(join(ownFolder, '0002_runtime_preparation.sql'), 'THIS IS INVALID SQL')
    const result: unknown = await PactDatabase.open({
      filePath,
      migrationsFolder: ownFolder,
    }).catch((error: unknown) => error)
    expect(result).toMatchObject({
      code: 'DATABASE_MIGRATION_FAILED',
      backupFilePath: expect.any(String),
    })
    const inspect = new Database(filePath, { readonly: true })
    try {
      expect(inspect.prepare('SELECT hash FROM __drizzle_migrations').all()).toHaveLength(1)
      expect(
        inspect.prepare("SELECT name FROM sqlite_master WHERE name='appearance_settings'").get(),
      ).toBeUndefined()
      expect(inspect.prepare('SELECT value FROM preserved_fixture').get()).toEqual({
        value: 'preserved',
      })
    } finally {
      inspect.close()
    }
  })
})
