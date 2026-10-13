import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DefaultSessionSettings, WorkspaceFileChange } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Workspace',
    kind: 'directory',
    directoryPath: '/fixture',
    createdAt,
  })
  db.sessionRepository.create({ id: sessionId, projectId, title: 'Workspace', createdAt }, settings)
  const run = db.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Edit',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  }).run
  const repo = db.workspaceChangesRepository
  repo.begin({
    runId: run.id,
    sessionId,
    projectId,
    agentId: 'codex',
    root: '/fixture',
    rootDevice: '1',
    rootInode: '2',
    stagingRoot: '/private-fixture',
  })
  return { db, repo, run, sessionId, projectId }
}
function version(content: string) {
  return {
    hash: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    mode: 0o644,
  }
}
function file(path: string, before: string, after: string): WorkspaceFileChange {
  return {
    path,
    previousPath: null,
    kind: 'modified',
    before: version(before),
    after: version(after),
    beforeAvailable: true,
    afterAvailable: true,
    modeKnown: false,
    undoStrategy: 'three_way',
    additions: 1,
    deletions: 1,
    hidden: false,
    reason: null,
  }
}

function record(f: Awaited<ReturnType<typeof fixture>>, changes: WorkspaceFileChange[]) {
  for (const change of changes) {
    for (const blob of [change.before, change.after, ...(change.patchVersions ?? [])]) {
      if (blob.hash) f.repo.recordBlob(blob.hash, blob.bytes)
    }
  }
  return f.repo.recordFiles(f.run.id, changes)
}

describe('Workspace change evidence durability', () => {
  it('increments revision for same-count body mutations and rejects stale publication rather than clearing pending projection', async () => {
    const f = await fixture()
    try {
      const first = file('src/review.ts', 'original', 'intermediate')
      record(f, [first])
      const stale = f.repo.summary(f.run.id)
      record(f, [file(first.path, 'intermediate', 'replacement')])
      const current = f.repo.summary(f.run.id)
      if (stale.revision === undefined || current.revision === undefined)
        throw new Error('Persisted workspace summaries require a revision.')
      expect(current.revision).toBeGreaterThan(stale.revision)
      expect([current.fileCount, current.additions, current.deletions]).toEqual([
        stale.fileCount,
        stale.additions,
        stale.deletions,
      ])
      expect(() => f.db.conversationRepository.recordWorkspaceChanges(stale)).toThrow(
        'changed before publication',
      )
      expect(f.repo.recoverableSets().map((set) => set.id)).toContain(f.run.id)
      f.db.conversationRepository.recordWorkspaceChanges(current)
      expect(f.db.conversationRepository.findRun(f.run.id)?.workspaceChanges).toMatchObject({
        revision: current.revision,
      })
      const finalized = f.repo.finalize(f.run.id)
      if (finalized.revision === undefined)
        throw new Error('Finalized workspace summaries require a revision.')
      expect(finalized.revision).toBeGreaterThan(current.revision)
      f.db.conversationRepository.recordWorkspaceChanges(finalized)
      expect(f.repo.recoverableSets()).toEqual([])
    } finally {
      f.db.close()
    }
  })
  it('keeps one relative file entry with the first native before, last after and recorded patches', async () => {
    const f = await fixture()
    try {
      const first = file('src/deep/review.ts', 'original', 'intermediate'),
        second = file(first.path, 'intermediate', 'final')
      first.patchVersions = [version('first patch')]
      second.patchVersions = [version('second patch')]
      record(f, [first])
      record(f, [second])
      expect(f.repo.finalize(f.run.id)).toMatchObject({
        state: 'ready',
        fileCount: 1,
        additions: 1,
        deletions: 1,
      })
      expect(f.repo.readPage({ changeSetId: f.run.id }).files).toMatchObject([
        {
          path: first.path,
          before: first.before,
          after: second.after,
          patchVersions: [version('first patch'), version('second patch')],
        },
      ])
      expect(() => f.repo.recordFiles(f.run.id, [second])).toThrow('Finalized workspace versions')
    } finally {
      f.db.close()
    }
  })

  it('never turns an unknown original into known absence or enables Undo after later complete evidence', async () => {
    const f = await fixture()
    try {
      const first = file('src/review.ts', '', 'intermediate')
      first.before = { hash: null, bytes: 0, mode: 0 }
      first.beforeAvailable = false
      first.undoStrategy = 'unavailable'
      record(f, [first])
      record(f, [file(first.path, 'intermediate', 'final')])
      const summary = f.repo.finalize(f.run.id)
      expect(summary).toMatchObject({
        state: 'mixed',
        fileCount: 1,
        countsAvailable: false,
        undoUnavailableReason: expect.stringContaining('unavailable'),
      })
      expect(f.repo.file(f.run.id, first.path)).toMatchObject({
        before: first.before,
        beforeAvailable: false,
        undoStrategy: 'unavailable',
        additions: null,
        deletions: null,
      })
    } finally {
      f.db.close()
    }
  })

  it('preserves interrupted recording evidence on reopen while disabling an unconfirmed final endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-workspace-recording-'))
    let db: PactDatabase | undefined
    try {
      const filePath = join(directory, 'pact.sqlite'),
        f = await fixture(filePath)
      db = f.db
      const recorded = file('src/review.ts', 'original', 'last confirmed')
      recorded.patchVersions = [version('native patch')]
      record(f, [recorded])
      db.conversationRepository.recordNativeEffects(f.run.id, 'pending')
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      db.conversationRepository.recoverInterruptedRuns()
      const repo = db.workspaceChangesRepository
      expect(repo.recoverInterruptedRecording(f.run.id)).toMatchObject({
        state: 'mixed',
        fileCount: 1,
      })
      expect(repo.file(f.run.id, recorded.path)).toMatchObject({
        before: recorded.before,
        after: recorded.after,
        afterAvailable: false,
        undoStrategy: 'unavailable',
        patchVersions: recorded.patchVersions,
      })
      expect(repo.finalize(f.run.id).state).toBe('mixed')
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })

  it('retains immutable intent attribution and atomically completes one Undo without double-counting storage', async () => {
    const f = await fixture()
    try {
      record(f, [file('review.ts', 'original', 'final')])
      f.repo.finalize(f.run.id)
      const intent = {
        id: randomUUID(),
        changeSetId: f.run.id,
        kind: 'undo' as const,
        payload: { root: '/fixture', files: [] },
        retainedBytes: 10,
      }
      f.repo.intent(intent)
      const bytes = f.repo.blobBytes()
      f.repo.intent(intent)
      expect(f.repo.blobBytes()).toBe(bytes)
      expect(() => f.repo.intent({ ...intent, payload: { root: '/foreign', files: [] } })).toThrow(
        'cannot be replaced',
      )
      expect(f.repo.pendingIntents()).toHaveLength(1)
      expect(f.repo.completeUndo(intent.id, f.run.id).state).toBe('undone')
      expect(f.repo.completeUndo(intent.id, f.run.id).state).toBe('undone')
      expect(f.repo.pendingIntents()).toEqual([])
      expect(f.repo.findIntent(intent.id)).toMatchObject({
        status: 'applied',
        payload: intent.payload,
        retainedBytes: 10,
      })
      expect(() => f.repo.completeIntent(intent.id, 'recovery_required')).toThrow(
        'cannot be reopened',
      )
    } finally {
      f.db.close()
    }
  })
})
