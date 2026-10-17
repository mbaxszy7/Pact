import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

import type { PactDrizzleDatabase } from '../../packages/persistence/src/drizzle-database.js'

import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import {
  conversationBodyInputs,
  conversationMessages,
  runtimeCliPaths,
} from '../../packages/persistence/src/schema/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

async function databaseFiles(directory: string): Promise<Record<string, string>> {
  const files = await Promise.all(
    ['pact.sqlite', 'pact.sqlite-wal', '.pact-writer.sqlite']
      .filter((name) => existsSync(join(directory, name)))
      .map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(join(directory, name)))
          .digest('hex'),
      ]),
  )
  return Object.fromEntries(files)
}

function hasUpdate(value: unknown): value is PactDrizzleDatabase {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'update') === 'function'
  )
}

test('a live readonly native observer sees commits, rejects writes and preserves the writer reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-'))
  const fixture = { directory, databaseFile: join(directory, 'pact.sqlite') }
  const writer = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  let observer: ReadonlyFixtureDatabase | undefined
  try {
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      createdAt = new Date().toISOString()
    writer.projectCatalogRepository.add({
      id: projectId,
      name: 'Observer seam',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    writer.sessionRepository.create(
      { id: sessionId, projectId, title: 'Observer seam', createdAt },
      {
        primaryAgentId: 'codex',
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 3,
        runningMessagePolicy: 'next_round',
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const pendingInputId = randomUUID()
    writer.drizzle
      .insert(conversationBodyInputs)
      .values({
        id: pendingInputId,
        sessionId,
        clientMessageId: randomUUID(),
        ownerKey: 'live-fixture-owner',
        purpose: 'input',
        createdAt,
        updatedAt: createdAt,
      })
      .run()
    writer.runtimePreparationRepository.saveSelectedExecutablePath('codex', '/owned/first-codex')
    observer = ReadonlyFixtureDatabase.open(fixture)
    const savedProjection = observer.drizzle
    expect(observer.runtimePreparationRepository.readSelectedExecutablePath('codex')).toBe(
      '/owned/first-codex',
    )

    // This commit occurs while the observer is already open, proving that readonly is not an immutable snapshot.
    writer.runtimePreparationRepository.saveSelectedExecutablePath('codex', '/owned/updated-codex')
    expect(observer.runtimePreparationRepository.readSelectedExecutablePath('codex')).toBe(
      '/owned/updated-codex',
    )
    const originalFiles = await databaseFiles(directory)
    expect(observer.conversationRepository.read(sessionId).messages).toEqual([])
    expect(
      observer.drizzle.query.conversationBodyInputs
        .findMany({ columns: { id: true }, limit: 2 })
        .sync(),
    ).toEqual([{ id: pendingInputId }])
    expect(await databaseFiles(directory)).toEqual(originalFiles)
    if (!hasUpdate(savedProjection)) throw new Error('Native Drizzle projection was unavailable')
    expect(() =>
      savedProjection.update(runtimeCliPaths).set({ executablePath: '/must-not-be-saved' }).run(),
    ).toThrow(/readonly/iu)
    expect(observer.runtimePreparationRepository.readSelectedExecutablePath('codex')).toBe(
      '/owned/updated-codex',
    )
    const messageId = randomUUID()
    writer.drizzle
      .insert(conversationMessages)
      .values({
        id: messageId,
        sessionId,
        role: 'user',
        content: 'Actual committed source text',
        state: 'complete',
        sequence: 1,
        createdAt,
        updatedAt: createdAt,
      })
      .run()
    const committedFiles = await databaseFiles(directory)
    expect(observer.conversationRepository.read(sessionId).messages).toMatchObject([
      { id: messageId, content: 'Actual committed source text' },
    ])
    observer.close()
    observer.close()
    expect(() => savedProjection.query.runtimeCliPaths.findMany({ limit: 2 }).sync()).toThrow(
      /closed/u,
    )
    expect(await databaseFiles(directory)).toEqual(committedFiles)
    await expect(
      PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder }),
    ).rejects.toMatchObject({ code: 'DATABASE_IN_USE' })
    writer.close()
    const reopened = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      expect(reopened.runtimePreparationRepository.readSelectedExecutablePath('codex')).toBe(
        '/owned/updated-codex',
      )
    } finally {
      reopened.close()
    }
  } finally {
    observer?.close()
    writer.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('readonly observation refuses missing, other-data, and linked database paths without creating data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-'))
  const fixture = { directory, databaseFile: join(directory, 'pact.sqlite') }
  try {
    expect(() => ReadonlyFixtureDatabase.open(fixture)).toThrow(/ENOENT|no such file/iu)
    expect(existsSync(fixture.databaseFile)).toBe(false)
    expect(existsSync(join(directory, '.pact-writer.sqlite'))).toBe(false)
    expect(() =>
      ReadonlyFixtureDatabase.open({ ...fixture, databaseFile: join(directory, 'other.sqlite') }),
    ).toThrow(/fixture database/u)
    const writer = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    writer.close()
    const originalFiles = await databaseFiles(directory)
    const linkFile = join(directory, 'linked.sqlite')
    await link(fixture.databaseFile, linkFile)
    expect(() => ReadonlyFixtureDatabase.open(fixture)).toThrow(/regular owned files/u)
    expect(await databaseFiles(directory)).toEqual(originalFiles)
    await rm(linkFile)
    const nested = join(directory, 'pact-runtime-e2e-nested')
    await mkdir(nested, { mode: 0o700 })
    expect(() =>
      ReadonlyFixtureDatabase.open({
        directory: nested,
        databaseFile: join(nested, 'pact.sqlite'),
      }),
    ).toThrow(/owned private runtime fixture/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'readonly observation refuses a symlink database without changing its target',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-'))
    const fixture = { directory, databaseFile: join(directory, 'pact.sqlite') }
    try {
      const writer = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      writer.close()
      const originalFiles = await databaseFiles(directory)
      const actualFile = join(directory, 'original.sqlite')
      await rename(fixture.databaseFile, actualFile)
      await symlink(actualFile, fixture.databaseFile)
      expect(() => ReadonlyFixtureDatabase.open(fixture)).toThrow(/regular owned files/u)
      await rm(fixture.databaseFile)
      await rename(actualFile, fixture.databaseFile)
      expect(await databaseFiles(directory)).toEqual(originalFiles)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
