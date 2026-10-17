import Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PactDatabase, DatabaseOpenError } from './pact-database.js'

const folder = resolve(import.meta.dirname, '../drizzle')
const migrations = readMigrationFiles({ migrationsFolder: folder })
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
      expect(first.drizzle.all('SELECT hash FROM __drizzle_migrations')).toHaveLength(
        migrations.length,
      )
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
