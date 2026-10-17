import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import { PactDatabase } from './pact-database.js'
import { conversationImageAssets, conversationMessageImages } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
function version(bytes: Buffer) {
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    mode: 0o644,
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a fixture database row')
  return { ...value }
}
function names(rows: unknown[]): string[] {
  return rows.map((value) => {
    const name = record(value).name
    if (typeof name !== 'string') throw new Error('Expected a schema identifier')
    return name
  })
}

it('upgrades the real 0060 schema through archive and native presence without losing legacy facts or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-mac-upgrade-'))
  let database: PactDatabase | undefined
  let legacy: Database.Database | undefined
  try {
    const prefix = join(root, 'migrations-through-0060')
    await mkdir(join(prefix, 'meta'), { recursive: true })
    const journal = record(
      JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')),
    )
    if (!Array.isArray(journal.entries)) throw new Error('Migration journal missing')
    const entries = journal.entries
      .map((value: unknown) => {
        const entry = record(value)
        if (typeof entry.idx !== 'number' || typeof entry.tag !== 'string')
          throw new Error('Migration entry invalid')
        return { ...entry, idx: entry.idx, tag: entry.tag }
      })
      .filter((entry) => entry.idx <= 60)
    journal.entries = entries
    await Promise.all(
      entries.map((entry) =>
        copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`)),
      ),
    )
    await writeFile(join(prefix, 'meta/_journal.json'), JSON.stringify(journal))
    const filePath = join(root, 'legacy.sqlite'),
      backupFilePath = join(root, 'before-upgrade.sqlite')
    database = await PactDatabase.open({ filePath, migrationsFolder: prefix })
    database.close()
    database = await PactDatabase.open({ filePath: join(root, 'seed.sqlite'), migrationsFolder })
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      createdAt = new Date().toISOString()
    database.projectCatalogRepository.add({
      id: projectId,
      name: 'Existing Mac project',
      directoryPath: join(root, 'project'),
      kind: 'directory',
      createdAt,
    })
    database.sessionRepository.create(
      { id: sessionId, projectId, title: 'Existing conversation', createdAt },
      {
        primaryAgentId: 'codex',
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 3,
        runningMessagePolicy: 'next_round',
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const run = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Existing message with image',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    }).run
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b1kAAAAASUVORK5CYII=',
      'base64',
    )
    const imageId = randomUUID(),
      imagePath = join(root, `${imageId}.png`)
    await writeFile(imagePath, image)
    database.drizzle
      .insert(conversationImageAssets)
      .values({
        id: imageId,
        ownerKey: sessionId,
        ownerSessionId: sessionId,
        name: 'existing.png',
        bytes: image.byteLength,
        ready: true,
        committed: true,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        sha256: createHash('sha256').update(image).digest('hex'),
        thumbnailBytes: image.byteLength,
        createdAt,
        updatedAt: createdAt,
      })
      .run()
    database.drizzle
      .insert(conversationMessageImages)
      .values({ messageId: run.userMessageId, ordinal: 0, imageId })
      .run()
    const before = Buffer.from('before\n'),
      after = Buffer.from('after\n')
    const beforeVersion = version(before),
      afterVersion = version(after)
    const changes = database.workspaceChangesRepository
    changes.begin({
      runId: run.id,
      sessionId,
      projectId,
      agentId: 'codex',
      root: join(root, 'project'),
      rootDevice: '1',
      rootInode: '2',
      stagingRoot: join(root, 'staging'),
    })
    changes.recordBlob(beforeVersion.hash, before.byteLength)
    changes.recordBlob(afterVersion.hash, after.byteLength)
    changes.recordFiles(run.id, [
      {
        path: 'existing.txt',
        previousPath: null,
        kind: 'modified',
        before: beforeVersion,
        after: afterVersion,
        beforeAvailable: true,
        afterAvailable: true,
        modeKnown: true,
        undoStrategy: 'three_way',
        additions: 1,
        deletions: 1,
        hidden: false,
        reason: null,
      },
    ])
    changes.finalize(run.id)
    const blobPaths = [join(root, beforeVersion.hash), join(root, afterVersion.hash)]
    await Promise.all([writeFile(blobPaths[0]!, before), writeFile(blobPaths[1]!, after)])
    database.close()
    database = undefined

    // Build a genuine legacy database from the production migration prefix. Copy
    // fixture facts only through columns that existed then; never rewind a new schema.
    const source = new Database(join(root, 'seed.sqlite'), { readonly: true })
    legacy = new Database(filePath)
    const tables = names(
      legacy
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
        )
        .all(),
    )
    const facts = new Map<string, { columns: string[]; rows: unknown[] }>()
    try {
      legacy.pragma('foreign_keys = OFF')
      legacy.transaction(() => {
        for (const table of tables) {
          const columns = names(legacy!.prepare(`PRAGMA table_info("${table}")`).all())
          const projection = columns.map((name) => `"${name}"`).join(', ')
          const rows = source
            .prepare(`SELECT ${projection} FROM "${table}" ORDER BY rowid`)
            .all()
            .map(record)
          legacy!.exec(`DELETE FROM "${table}"`)
          const insert = legacy!.prepare(
            `INSERT INTO "${table}" (${projection}) VALUES (${columns.map(() => '?').join(', ')})`,
          )
          for (const row of rows) insert.run(...columns.map((name) => row[name]!))
          facts.set(table, { columns, rows })
        }
      })()
      legacy.pragma('foreign_keys = ON')
      expect(legacy.pragma('foreign_key_check')).toEqual([])
    } finally {
      source.close()
      legacy.close()
      legacy = undefined
    }
    database = await PactDatabase.open({ filePath, migrationsFolder, backupFilePath })
    for (const path of [filePath, backupFilePath]) {
      const receipt = new Database(path, { readonly: true })
      try {
        for (const [table, fact] of facts) {
          expect(
            receipt
              .prepare(
                `SELECT ${fact.columns.map((name) => `"${name}"`).join(', ')} FROM "${table}" ORDER BY rowid`,
              )
              .all(),
            `${table} in ${path === filePath ? 'upgraded database' : 'consistent backup'}`,
          ).toEqual(fact.rows)
        }
        expect(receipt.pragma('foreign_key_check')).toEqual([])
        expect(
          receipt
            .prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_archive_operations'")
            .get() !== undefined,
        ).toBe(path === filePath)
      } finally {
        receipt.close()
      }
    }
    expect(database.sessionRepository.find(sessionId)?.title).toBe('Existing conversation')
    expect(database.conversationRepository.read(sessionId).messages[0]?.content).toBe(
      'Existing message with image',
    )
    expect(
      database.workspaceChangesRepository.readPage({ changeSetId: run.id }).files[0],
    ).toMatchObject({ path: 'existing.txt', before: beforeVersion, after: afterVersion })
    expect(await readFile(imagePath)).toEqual(image)
    expect(await readFile(blobPaths[0]!)).toEqual(before)
    expect(await readFile(blobPaths[1]!)).toEqual(after)
    database.close()
    database = await PactDatabase.open({ filePath, migrationsFolder })
    expect(database.sessionRepository.find(sessionId)?.id).toBe(sessionId)
  } finally {
    legacy?.close()
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
})
