import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DefaultSessionSettings, RpcResult } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  runningMessagePolicy: 'next_round',
  maxDiscussionRounds: 3,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const owners: Array<{ db: PactDatabase; flow: Conversation }> = []
const directories: string[] = []

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID(),
    createdAt = '2026-10-15T00:00:00.000Z'
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Native metadata',
    directoryPath: `/native-metadata-${projectId}`,
    kind: 'directory',
    createdAt,
  })
  const sessionIds = Array.from({ length: 7 }, (_, index) => {
    const id = randomUUID()
    db.sessionRepository.create({ id, projectId, title: `Session ${index}`, createdAt }, settings)
    return id
  })
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    new RuntimePreparation(db.runtimePreparationRepository),
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  owners.push({ db, flow })
  await flow.initializeNativePresence()
  return { db, flow, projectId, sessionIds }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const results = await Promise.allSettled(
    owners.splice(0).map(async (owner) => {
      try {
        await owner.flow.dispose()
      } finally {
        if (owner.db.isHealthy()) owner.db.close()
      }
    }),
  )
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

describe('Native metadata and quit through production owners', () => {
  it('returns the most recent five explicit openings, treats duplicate opening IDs idempotently and persists them across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-native-metadata-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath)
    for (const sessionId of f.sessionIds)
      f.db.sessionRepository.recordNativeOpened({ sessionId, openingId: randomUUID() })
    const opening = { sessionId: f.sessionIds[0]!, openingId: randomUUID() }
    expect(f.db.sessionRepository.recordNativeOpened(opening)).toBe(true)
    expect(f.db.sessionRepository.recordNativeOpened(opening)).toBe(false)
    const expected = [f.sessionIds[0], ...f.sessionIds.slice(3).toReversed()]
    expect(value(f.flow.getNativePresence()).recent.map((row) => row.sessionId)).toEqual(expected)
    expect(f.db.conversationRepository.diagnostics().completeReads).toBe(0)
    await f.flow.dispose()
    f.db.close()
    const reopened = await PactDatabase.open({ filePath, migrationsFolder })
    try {
      expect(reopened.sessionRepository.nativeQuitRecent().map((row) => row.sessionId)).toEqual(
        expected,
      )
    } finally {
      reopened.close()
    }
  })

  it('keeps taskbar removal separate from tray history and excludes archived Projects and Sessions', async () => {
    const f = await fixture(),
      sessionId = f.sessionIds[0]!
    f.db.sessionRepository.recordNativeOpened({ sessionId, openingId: randomUUID() })
    f.db.sessionRepository.updateNativeJumpListSuppression({
      removedSessionIds: [sessionId],
      clearedSessionIds: [],
    })
    expect(value(f.flow.getNativePresence()).recent).toMatchObject([
      { sessionId, jumpListSuppressed: true },
    ])
    f.db.sessionRepository.recordNativeOpened({ sessionId, openingId: randomUUID() })
    expect(f.db.sessionRepository.findNativeRow(sessionId)?.jumpListSuppressed).toBe(false)
    f.db.projectCatalogRepository.archive(f.projectId)
    expect(value(f.flow.getNativePresence()).recent).toEqual([])
    expect(() => f.db.sessionRepository.resolveNativeSession(sessionId)).toThrow(/archived/)
    f.db.projectCatalogRepository.restore(f.projectId)
    f.db.sessionRepository.archive(sessionId)
    expect(value(f.flow.getNativePresence()).recent).toEqual([])
  })

  it('seals only a known idle preparation, shares its result and allows explicit cancellation', async () => {
    const f = await fixture(),
      input = { operationId: randomUUID() }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const read = vi.spyOn(f.db.conversationRepository, 'nativeQuitUnsettled')
    const result = f.flow.prepareNativeQuit(input)
    expect(result).toMatchObject({ ok: true, value: { state: 'idle_prepared', activeCount: 0 } })
    expect(f.flow.prepareNativeQuit(input)).toBe(result)
    expect(read).toHaveBeenCalledOnce()
    expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    })
    expect(f.flow.cancelNativeQuit({ operationId: randomUUID() }).ok).toBe(false)
    expect(f.flow.cancelNativeQuit(input).ok).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['session-metadata', 'unsettled-work'] as const)(
    'retains a cancellable uncertain owner when %s fails, without retrying its query or extending TTL',
    async (stage) => {
      const f = await fixture(),
        input = { operationId: randomUUID() }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const read =
        stage === 'session-metadata'
          ? vi.spyOn(f.db.sessionRepository, 'findNativeRow').mockImplementation(() => {
              throw new Error('Controlled metadata failure.')
            })
          : vi.spyOn(f.db.conversationRepository, 'nativeQuitUnsettled').mockImplementation(() => {
              throw new Error('Controlled metadata failure.')
            })
      if (stage === 'session-metadata') {
        vi.spyOn(f.db.conversationRepository, 'nativeQuitUnsettled').mockReturnValue({
          count: 1,
          sessionIds: [f.sessionIds[0]!],
        })
      }
      const failed = f.flow.prepareNativeQuit(input)
      expect(failed).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } })
      expect(f.flow.prepareNativeQuit(input)).toBe(failed)
      expect(read).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(f.flow.prepareNativeQuit(input)).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      expect(f.flow.cancelNativeQuit(input).ok).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('keeps unresolved native work in the confirmation group and clears the quit timer on disposal', async () => {
    const f = await fixture(),
      input = { operationId: randomUUID() }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(f.db.conversationRepository, 'nativeQuitUnsettled').mockReturnValue({
      count: 1,
      sessionIds: [f.sessionIds[0]!],
    })
    expect(f.flow.prepareNativeQuit(input)).toMatchObject({
      ok: true,
      value: {
        state: 'confirmation_required',
        activeCount: 1,
        sessions: [{ sessionId: f.sessionIds[0] }],
      },
    })
    expect(vi.getTimerCount()).toBe(1)
    await f.flow.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
