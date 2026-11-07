import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collaborationTaskSchema,
  type ConversationSendInput,
  type DefaultSessionSettings,
  type RuntimeAgentId,
  type WorkspaceArchivePreview,
  type WorkspaceArchiveScope,
  type WorkspaceArchiveTask,
} from '@pact/contracts'
/*
 * The fixture uses production migrations, catalog mutations and Run event interfaces.
 * Direct native-work inserts represent unavailable/old bindings at the persistence seam.
 */

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  agentEventJournal,
  collaborationInputs,
  conversationBodyInputs,
  conversationMessages,
  nativeAgentContexts,
  nativeForkIntents,
  nativeRebuildOperations,
  projects,
  schema,
  sessionCatalogRevisions,
  sessionForkOperations,
  sessions,
  workspaceArchiveOperations,
} from './schema/index.js'
import {
  WorkspaceArchiveConflictError,
  WorkspaceArchiveRepository,
  assertProjectAvailable,
  assertSessionAvailable,
  workspaceArchiveBlocked,
} from './workspace-archive-repository.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const createdAt = '2026-10-14T00:00:00.000Z'
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const databases = new Set<PactDatabase>()
const directories = new Set<string>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases) db.close()
  databases.clear()
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true })))
  directories.clear()
})

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  databases.add(db)
  const projectId = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Archive fixture',
    directoryPath: `/archive-fixture/${projectId}`,
    kind: 'directory',
    createdAt,
  })
  const sessionId = addSession(db, projectId, 'First Session')
  const siblingId = addSession(db, projectId, 'Sibling Session')
  return { db, projectId, sessionId, siblingId, archives: db.conversationRepository.archives }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function addSession(db: PactDatabase, projectId: string, title = 'Session'): string {
  const id = randomUUID()
  db.sessionRepository.create({ id, projectId, title, createdAt }, settings)
  return id
}

function preview(
  f: Fixture,
  scope: WorkspaceArchiveScope = { kind: 'session', sessionId: f.sessionId },
  tasks: WorkspaceArchiveTask[] = [],
): WorkspaceArchivePreview {
  const metadata = f.archives.context(scope)
  return {
    operationId: randomUUID(),
    scope,
    ...metadata,
    tasks,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  }
}

function claim(f: Fixture, p: WorkspaceArchivePreview, owner = 'utility-a') {
  f.archives.prepare(p, owner)
  return f.archives.claim(p.operationId, owner, p.tasks, [], () => {})
}

function start(f: Fixture, sessionId = f.sessionId) {
  const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
  if (drafts.scope !== 'drafts') throw new Error('Fixture drafts page mismatch')
  return f.db.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'A fixture task preserved by archive',
    expectedCommentsRevision: drafts.commentsRevision,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  }).run
}

function task(f: Fixture, run: ReturnType<typeof start>): WorkspaceArchiveTask {
  return {
    sessionId: run.sessionId,
    title: f.db.sessionRepository.find(run.sessionId)!.title,
    state: 'running',
    identity: run.id,
  }
}

function beginNative(f: Fixture, run: ReturnType<typeof start>) {
  const repo = f.db.conversationRepository
  repo.applyEvent(run.sessionId, run.id, {
    agentId: 'codex',
    type: 'session.started',
    nativeSessionId: `native-${run.id}`,
  })
  repo.applyEvent(run.sessionId, run.id, {
    agentId: 'codex',
    type: 'turn.started',
    turnId: `turn-${run.id}`,
  })
  repo.recordNativeEffects(run.id, 'pending')
}

function endNative(
  f: Fixture,
  run: ReturnType<typeof start>,
  outcome: 'interrupted' | 'completed' = 'interrupted',
) {
  f.db.conversationRepository.applyEvent(run.sessionId, run.id, {
    agentId: 'codex',
    type: 'text.completed',
    turnId: `turn-${run.id}`,
    outputId: `answer-${run.id}`,
    text: 'Original fixture output',
  })
  f.db.conversationRepository.applyEvent(run.sessionId, run.id, {
    agentId: 'codex',
    type: 'turn.completed',
    turnId: `turn-${run.id}`,
    outcome,
  })
}

function seedRun(f: Fixture, changes: Partial<typeof agentRuns.$inferInsert> = {}) {
  const id = randomUUID()
  f.db.drizzle
    .insert(agentRuns)
    .values({
      id,
      sessionId: f.sessionId,
      userMessageId: randomUUID(),
      agentId: 'codex',
      status: 'completed',
      attemptCount: 1,
      settingsRevision: 1,
      nativeEffectsState: 'settled',
      nativeOutcome: 'completed',
      dispatchPhase: 'ended',
      createdAt,
      updatedAt: createdAt,
      ...changes,
    })
    .run()
  return id
}

function settledRebuildCandidate(f: Fixture, agentId: RuntimeAgentId) {
  const repo = f.db.conversationRepository
  const id = randomUUID()
  const executorId = randomUUID()
  const nativeSessionId = `archive-candidate-${agentId}`
  f.db.drizzle
    .insert(nativeAgentContexts)
    .values({
      sessionId: f.sessionId,
      agentId,
      nativeSessionId: `archive-original-${agentId}`,
      bindingGeneration: 7,
      continuationState: 'recovery_required',
      state: 'unavailable',
      updatedAt: createdAt,
    })
    .run()
  repo.beginNativeRebuild({
    id,
    sessionId: f.sessionId,
    agentId,
    expectedGeneration: 7,
    abandon: false,
  })
  repo.freezeNativeRebuildSource(id, [])
  repo.markNativeRebuildDispatched(id, executorId)
  repo.recordNativeRebuildIdentity(id, nativeSessionId)
  repo.recordNativeRebuildWork(id, executorId, nativeSessionId, 'settled')
  repo.failNativeRebuild(id, 'Candidate initialization needs another explicit check')
  const witness =
    agentId === 'codex'
      ? {
          kind: 'codex_rollout_v1' as const,
          nativeSessionId,
          verifiedPrefixBytes: 1024,
          verifiedPrefixSha256: 'a'.repeat(64),
          recordCount: 2,
        }
      : undefined
  return { id, executorId, nativeSessionId, witness, agentId }
}

function rebuildSnapshot(f: Fixture, candidate: ReturnType<typeof settledRebuildCandidate>) {
  const context = f.db.conversationRepository.nativeContext(f.sessionId, candidate.agentId)
  const operation = f.db.drizzle
    .select({
      stage: nativeRebuildOperations.stage,
      nativeWorkState: nativeRebuildOperations.nativeWorkState,
    })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, candidate.id))
    .get()
  return {
    binding: context
      ? {
          nativeSessionId: context.nativeSessionId,
          generation: context.bindingGeneration,
          continuationState: context.continuationState,
        }
      : null,
    operation,
    messages: f.db.drizzle
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .all(),
    runCount: f.db.drizzle.select().from(agentRuns).all().length,
    journalCount: f.db.drizzle.select().from(agentEventJournal).all().length,
  }
}

function archiveBarrier(
  f: Fixture,
  scope: WorkspaceArchiveScope,
  state: 'stopping' | 'unresolved' | 'archived',
) {
  const p = preview(f, scope)
  claim(f, p)
  if (state === 'unresolved')
    f.archives.fail(p.operationId, [], 'Archive outcome must be checked', true)
  if (state === 'archived')
    f.archives.finish(p.operationId, [], () =>
      scope.kind === 'session'
        ? f.db.sessionRepository.archive(scope.sessionId, p.operationId)
        : f.db.projectCatalogRepository.archive(scope.projectId, p.operationId),
    )
  return p
}

describe('Workspace archive through durable repository interfaces', () => {
  it('prepares and cancels without changing tasks, output, catalog revision or admission', async () => {
    const f = await fixture()
    const run = start(f)
    beginNative(f, run)
    const beforeRun = f.db.conversationRepository.findRun(run.id)
    const beforeSession = f.db.sessionRepository.find(f.sessionId)
    const beforeMessages = f.db.drizzle.select().from(conversationMessages).all()
    const beforeRevision = f.db.drizzle.select().from(sessionCatalogRevisions).get()
    const p = preview(f, undefined, [task(f, run)])
    f.archives.prepare(p, 'utility-a')
    expect(f.archives.read(p.operationId)).toMatchObject({ state: 'prepared', tasks: [] })
    expect(f.archives.blocksSession(f.sessionId)).toBe(false)
    expect(f.archives.cancel(p.operationId).state).toBe('cancelled')
    expect(f.db.conversationRepository.findRun(run.id)).toEqual(beforeRun)
    expect(f.db.sessionRepository.find(f.sessionId)).toEqual(beforeSession)
    expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual(beforeMessages)
    expect(f.db.drizzle.select().from(sessionCatalogRevisions).get()).toEqual(beforeRevision)
    expect(() => f.archives.claim(p.operationId, 'utility-a', p.tasks, [run.id], () => {})).toThrow(
      /confirmation expired/,
    )
  })

  it('replaces only the same owner preview and keeps operation nonce scope immutable', async () => {
    const f = await fixture()
    const first = preview(f)
    const otherOwner = preview(f, { kind: 'session', sessionId: f.siblingId })
    f.archives.prepare(first, 'utility-a')
    f.archives.prepare(otherOwner, 'utility-b')
    const next = preview(f, { kind: 'project', projectId: f.projectId })
    f.archives.prepare(next, 'utility-a')
    expect(f.archives.read(first.operationId)?.state).toBe('cancelled')
    expect(f.archives.read(otherOwner.operationId)?.state).toBe('prepared')
    expect(f.archives.prepare({ ...next, title: 'Changed display title' }, 'utility-a')).toEqual(
      next,
    )
    expect(() => f.archives.prepare({ ...next, scope: first.scope }, 'utility-a')).toThrow(
      /another item/,
    )
  })

  it.each(['expired', 'wrong owner', 'blocked', 'changed task'] as const)(
    'refuses %s confirmation before retirement or Stop effects',
    async (reason) => {
      const f = await fixture()
      const p = preview(f, undefined, [
        {
          sessionId: f.sessionId,
          title: 'First Session',
          state: 'preparing',
          identity: 'prepare:1',
        },
      ])
      if (reason === 'expired') p.expiresAt = new Date(Date.now() - 1).toISOString()
      if (reason === 'blocked') p.blockedReason = 'A detached native operation must finish first.'
      f.archives.prepare(p, 'utility-a')
      const retire = vi.fn<() => void>()
      const current =
        reason === 'changed task' ? [{ ...p.tasks[0]!, identity: 'prepare:2' }] : p.tasks
      expect(() =>
        f.archives.claim(
          p.operationId,
          reason === 'wrong owner' ? 'utility-b' : 'utility-a',
          current,
          [],
          retire,
        ),
      ).toThrow(WorkspaceArchiveConflictError)
      expect(retire).not.toHaveBeenCalled()
      expect(f.archives.read(p.operationId)?.state).toBe('prepared')
      expect(f.archives.blocksSession(f.sessionId)).toBe(false)
      expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
    },
  )

  it('accepts captured tasks that naturally ended but refuses new Session identities', async () => {
    const f = await fixture()
    const p = preview(f, { kind: 'project', projectId: f.projectId }, [
      { sessionId: f.sessionId, title: 'First Session', state: 'preparing', identity: 'prepare:1' },
    ])
    f.archives.prepare(p, 'utility-a')
    expect(() =>
      f.archives.claim(
        p.operationId,
        'utility-a',
        [{ ...p.tasks[0]!, sessionId: f.siblingId }],
        [],
        () => {},
      ),
    ).toThrow(/tasks changed/)
    expect(f.archives.claim(p.operationId, 'utility-a', [], [], () => {}).state).toBe('stopping')
    expect(f.archives.cancel(p.operationId).state).toBe('stopping')
  })

  it('fences one Session while permitting sibling Runs and new sibling Sessions', async () => {
    const f = await fixture()
    const p = preview(f)
    claim(f, p)
    expect(() => start(f)).toThrow(WorkspaceArchiveConflictError)
    expect(() => f.db.sessionRepository.archive(f.sessionId)).toThrow(/settling/)
    expect(() => f.db.sessionRepository.restore(f.sessionId)).toThrow(/settling/)
    expect(() => f.db.projectCatalogRepository.archive(f.projectId)).toThrow(/settling/)
    expect(() =>
      f.db.conversationRepository.beginNativeRebuild({
        id: randomUUID(),
        sessionId: f.sessionId,
        agentId: 'codex',
        expectedGeneration: 1,
        abandon: false,
      }),
    ).toThrow(WorkspaceArchiveConflictError)
    expect(f.archives.blocksSession(f.siblingId)).toBe(false)
    expect(() => assertProjectAvailable(f.db.drizzle, f.projectId)).not.toThrow()
    expect(start(f, f.siblingId).sessionId).toBe(f.siblingId)
    expect(addSession(f.db, f.projectId)).toBeTypeOf('string')
    const overlap = preview(f, { kind: 'project', projectId: f.projectId })
    f.archives.prepare(overlap, 'utility-b')
    expect(() => f.archives.claim(overlap.operationId, 'utility-b', [], [], () => {})).toThrow(
      WorkspaceArchiveConflictError,
    )
    expect(f.archives.read(p.operationId)?.state).toBe('stopping')
  })

  it('fences an entire Project without blocking another Project', async () => {
    const f = await fixture()
    const p = preview(f, { kind: 'project', projectId: f.projectId })
    claim(f, p)
    expect(() => start(f)).toThrow(WorkspaceArchiveConflictError)
    expect(() => start(f, f.siblingId)).toThrow(WorkspaceArchiveConflictError)
    expect(() => addSession(f.db, f.projectId)).toThrow(WorkspaceArchiveConflictError)
    expect(() => f.db.projectCatalogRepository.restore(f.projectId)).toThrow(/settling/)
    const existing = f.db.projectCatalogRepository.find(f.projectId)!
    expect(() => f.db.projectCatalogRepository.add(existing)).toThrow(/settling/)
    const otherId = randomUUID()
    f.db.projectCatalogRepository.add({
      ...existing,
      id: otherId,
      directoryPath: `/archive-fixture/${otherId}`,
    })
    const otherSession = addSession(f.db, otherId)
    expect(start(f, otherSession).sessionId).toBe(otherSession)
    expect(() => assertSessionAvailable(f.db.drizzle, f.sessionId, true)).toThrow(
      WorkspaceArchiveConflictError,
    )
  })

  it('rolls back both the scope fence and pending-route retirement on callback failure', async () => {
    const f = await fixture()
    const run = f.db.conversationRepository.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'An @all fixture task',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      route: { type: 'all' },
    }).run
    beginNative(f, run)
    endNative(f, run, 'completed')
    f.db.conversationRepository.recordNativeEffects(run.id, 'settled')
    const before = f.db.conversationRepository.pendingRoutedContinuations({
      kind: 'session',
      sessionId: f.sessionId,
    })
    const beforeJournal = f.db.drizzle.select().from(agentEventJournal).all()
    expect(before).toHaveLength(1)
    const p = preview(f, undefined, [{ ...task(f, run), state: 'continuing' }])
    f.archives.prepare(p, 'utility-a')
    expect(() =>
      f.archives.claim(p.operationId, 'utility-a', p.tasks, [], () => {
        f.db.conversationRepository.cancelPendingRoutedContinuation(f.sessionId, 'archive_fixture')
        throw new Error('Injected retirement failure')
      }),
    ).toThrow('Injected retirement failure')
    expect(f.archives.read(p.operationId)?.state).toBe('prepared')
    expect(f.archives.blocksSession(f.sessionId)).toBe(false)
    expect(f.db.conversationRepository.pendingRoutedContinuations(p.scope)).toEqual(before)
    expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual(beforeJournal)
    f.archives.claim(p.operationId, 'utility-a', p.tasks, [], () => {
      f.db.conversationRepository.cancelPendingRoutedContinuation(f.sessionId, 'archive_fixture')
    })
    expect(f.archives.read(p.operationId)?.state).toBe('stopping')
    expect(f.db.conversationRepository.pendingRoutedContinuations(p.scope)).toHaveLength(0)
  })

  it('waits for native outcome and physical effects after claiming only an owned Run', async () => {
    const f = await fixture()
    const run = start(f)
    beginNative(f, run)
    const p = preview(f, undefined, [task(f, run)])
    f.archives.prepare(p, 'utility-a')
    const retire = vi.fn<() => void>()
    expect(() => f.archives.claim(p.operationId, 'utility-a', p.tasks, [], retire)).toThrow(
      /Other native work/,
    )
    expect(retire).not.toHaveBeenCalled()
    f.archives.claim(p.operationId, 'utility-a', p.tasks, [run.id], retire)
    const commit = vi.fn<() => ReturnType<Fixture['db']['sessionRepository']['archive']>>(() =>
      f.db.sessionRepository.archive(f.sessionId, p.operationId),
    )
    expect(() => f.archives.finish(p.operationId, [], commit)).toThrow(/not been confirmed ended/)
    endNative(f, run)
    expect(f.db.conversationRepository.findRun(run.id)?.nativeOutcome).toBe('interrupted')
    expect(() => f.archives.finish(p.operationId, [], commit)).toThrow(/not been confirmed ended/)
    expect(commit).not.toHaveBeenCalled()
    f.db.conversationRepository.recordNativeEffects(run.id, 'settled')
    f.archives.finish(p.operationId, [{ sessionId: f.sessionId, outcome: 'stopped' }], commit)
    expect(commit).toHaveBeenCalledOnce()
    f.archives.fail(p.operationId, [], 'Late failure callback', true)
    f.archives.recover('utility-b')
    f.archives.releaseResolved(p.operationId)
    expect(f.archives.cancel(p.operationId).state).toBe('archived')
    expect(f.archives.read(p.operationId)).toMatchObject({
      state: 'archived',
      tasks: [{ sessionId: f.sessionId, outcome: 'stopped' }],
    })
    expect(f.db.sessionRepository.find(f.sessionId)?.status).toBe('archived')
    const output = f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.runId, run.id))
      .all()
    expect(output.some((message) => message.content === 'Original fixture output')).toBe(true)
    expect(() => f.archives.finish(p.operationId, [], commit)).toThrow(
      WorkspaceArchiveConflictError,
    )
    expect(commit).toHaveBeenCalledOnce()
  })

  it('rolls back archive metadata, revision and receipt if the final commit fails', async () => {
    const f = await fixture()
    const p = preview(f)
    claim(f, p)
    const beforeRevision = f.db.drizzle.select().from(sessionCatalogRevisions).get()
    expect(() =>
      f.archives.finish(p.operationId, [], () => {
        f.db.sessionRepository.archive(f.sessionId, p.operationId)
        throw new Error('Injected finalization failure')
      }),
    ).toThrow('Injected finalization failure')
    expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
    expect(f.db.drizzle.select().from(sessionCatalogRevisions).get()).toEqual(beforeRevision)
    expect(f.archives.read(p.operationId)?.state).toBe('stopping')
    f.archives.finish(p.operationId, [], () =>
      f.db.sessionRepository.archive(f.sessionId, p.operationId),
    )
    expect(f.archives.read(p.operationId)?.state).toBe('archived')
    expect(
      f.db.sessionRepository.readPage(f.projectId).sessions.map((session) => session.id),
    ).toEqual([f.siblingId])
  })

  it('archives and restores Project visibility without cascading independent Session archive state', async () => {
    const f = await fixture()
    f.db.sessionRepository.archive(f.sessionId)
    const p = preview(f, { kind: 'project', projectId: f.projectId })
    claim(f, p)
    f.archives.finish(p.operationId, [], () =>
      f.db.projectCatalogRepository.archive(f.projectId, p.operationId),
    )
    expect(f.db.projectCatalogRepository.read().projects).toHaveLength(0)
    expect(f.archives.read(p.operationId)?.state).toBe('archived')
    expect(f.db.sessionRepository.find(f.sessionId)?.status).toBe('archived')
    expect(f.db.sessionRepository.find(f.siblingId)?.archivedAt).toBeUndefined()
    expect(() => start(f, f.siblingId)).toThrow(WorkspaceArchiveConflictError)
    const archivedProject = f.db.projectCatalogRepository.find(f.projectId)!
    f.db.projectCatalogRepository.add({
      ...archivedProject,
      id: randomUUID(),
      name: 'Attempted replacement',
    })
    expect(f.db.projectCatalogRepository.read().projects).toMatchObject([
      { id: f.projectId, name: 'Archive fixture' },
    ])
    expect(f.db.sessionRepository.find(f.sessionId)?.status).toBe('archived')
    expect(start(f, f.siblingId).sessionId).toBe(f.siblingId)
  })

  it('keeps unresolved barriers until actual effects settle, then releases without archiving or replay', async () => {
    const f = await fixture()
    const run = start(f)
    beginNative(f, run)
    const p = preview(f, undefined, [task(f, run)])
    f.archives.prepare(p, 'utility-a')
    f.archives.claim(p.operationId, 'utility-a', p.tasks, [run.id], () => {})
    endNative(f, run)
    f.archives.fail(
      p.operationId,
      [{ sessionId: f.sessionId, outcome: 'unresolved' }],
      'Stop effects not confirmed',
      true,
    )
    f.archives.releaseResolved(p.operationId)
    expect(f.archives.read(p.operationId)?.state).toBe('unresolved')
    expect(() => start(f)).toThrow(WorkspaceArchiveConflictError)
    expect(() => f.db.sessionRepository.restore(f.sessionId)).toThrow(/settling/)
    expect(() => assertSessionAvailable(f.db.drizzle, f.sessionId, true)).not.toThrow()
    expect(f.archives.unresolvedOperations(p.scope)).toEqual([p.operationId])
    f.db.conversationRepository.recordNativeEffects(run.id, 'settled')
    const beforeMessages = f.db.drizzle.select().from(conversationMessages).all()
    f.archives.releaseResolved(p.operationId)
    expect(f.archives.read(p.operationId)).toMatchObject({
      state: 'not_archived',
      tasks: [{ outcome: 'finished' }],
    })
    expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
    expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual(beforeMessages)
    expect(f.archives.blocksSession(f.sessionId)).toBe(false)
    const retire = vi.fn<() => void>()
    expect(() => f.archives.claim(p.operationId, 'utility-a', p.tasks, [run.id], retire)).toThrow(
      WorkspaceArchiveConflictError,
    )
    expect(retire).not.toHaveBeenCalled()
    expect(start(f).sessionId).toBe(f.sessionId)
  })

  it('leaves a partially failed Project unarchived and preserves individual outcomes', async () => {
    const f = await fixture()
    const p = preview(f, { kind: 'project', projectId: f.projectId }, [
      { sessionId: f.sessionId, title: 'First Session', state: 'preparing', identity: 'prepare:1' },
      {
        sessionId: f.siblingId,
        title: 'Sibling Session',
        state: 'preparing',
        identity: 'prepare:2',
      },
    ])
    claim(f, p)
    const outcomes = [
      { sessionId: f.sessionId, outcome: 'stopped' as const },
      { sessionId: f.siblingId, outcome: 'failed' as const },
    ]
    f.archives.fail(p.operationId, outcomes, 'Second task failed to stop', false)
    expect(f.archives.read(p.operationId)).toMatchObject({ state: 'not_archived', tasks: outcomes })
    expect(f.db.projectCatalogRepository.find(f.projectId)?.archivedAt).toBeUndefined()
    expect(f.archives.blocksSession(f.sessionId)).toBe(false)
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(0)
  })

  it('recovers durable stopping receipts after a real database close/reopen without replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-workspace-archive-restart-'))
    directories.add(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath)
    const p = preview(f)
    claim(f, p)
    const other = preview(f, { kind: 'session', sessionId: f.siblingId })
    claim(f, other, 'utility-b')
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(reopened)
    const archives = reopened.conversationRepository.archives
    archives.recover('utility-b')
    expect(archives.read(p.operationId)?.state).toBe('unresolved')
    expect(archives.read(other.operationId)?.state).toBe('stopping')
    expect(reopened.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
    expect(reopened.drizzle.select().from(agentRuns).all()).toHaveLength(0)
    expect(archives.blocksSession(f.sessionId)).toBe(true)
    archives.releaseResolved(p.operationId)
    expect(archives.read(p.operationId)?.state).toBe('not_archived')
    expect(archives.blocksSession(f.sessionId)).toBe(false)
    expect(archives.blocksSession(f.siblingId)).toBe(true)
  })

  it('preserves archived metadata across late Run status events and restores without restarting', async () => {
    const f = await fixture()
    const run = start(f)
    beginNative(f, run)
    endNative(f, run)
    f.db.conversationRepository.recordNativeEffects(run.id, 'settled')
    f.db.sessionRepository.archive(f.sessionId)
    const archivedAt = f.db.sessionRepository.find(f.sessionId)?.archivedAt
    f.db.conversationRepository.applyArchivedEvent(f.sessionId, run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: `turn-${run.id}`,
      outcome: 'completed',
    })
    // An already queued legacy status write cannot revive visibility or new work.
    f.db.drizzle
      .update(sessions)
      .set({ status: 'completed' })
      .where(eq(sessions.id, f.sessionId))
      .run()
    expect(f.db.sessionRepository.find(f.sessionId)).toMatchObject({
      status: 'archived',
      archivedAt,
    })
    expect(
      f.db.sessionRepository
        .readPage(f.projectId)
        .sessions.some((session) => session.id === f.sessionId),
    ).toBe(false)
    expect(() => start(f)).toThrow(WorkspaceArchiveConflictError)
    const runs = f.db.drizzle.select().from(agentRuns).all()
    const messages = f.db.drizzle.select().from(conversationMessages).all()
    f.db.sessionRepository.restore(f.sessionId)
    expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
    expect(
      f.db.sessionRepository
        .readPage(f.projectId)
        .sessions.some((session) => session.id === f.sessionId),
    ).toBe(true)
    expect(f.db.drizzle.select().from(agentRuns).all()).toEqual(runs)
    expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual(messages)
  })

  it.each(['session', 'project'] as const)(
    'refuses received input through the primary repository transaction under a %s barrier',
    async (kind) => {
      const f = await fixture()
      const repo = f.db.conversationRepository
      const clientMessageId = randomUUID()
      const initial = collaborationTaskSchema.parse({
        id: randomUUID(),
        sessionId: f.sessionId,
        kind: 'plan',
        revision: 0,
        protocol: 'native-workflow-v1',
        owner: 'codex',
        reviewer: 'claude',
        automation: 'active',
        inputSequence: 0,
        handledInputSequence: 0,
        task: 'Archive fence fixture',
        taskMessageId: clientMessageId,
        stage: 'plan',
        actor: 'codex',
        status: 'running',
        runId: clientMessageId,
        planVersion: 0,
        discussionRounds: 0,
        reviewCycles: 0,
        repairAttempts: 0,
      })
      const run = repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId,
        content: '/plan Archive fence fixture',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        collaboration: initial,
      }).run
      const drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Fixture drafts page mismatch')
      const send: ConversationSendInput = {
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Unreceived draft must survive the archive barrier',
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        route: { type: 'primary' },
      }
      const owner = 'archive-fence-input-owner'
      const body = repo.writeConversationInput(
        { type: 'begin', sessionId: f.sessionId, clientMessageId: send.clientMessageId },
        owner,
      )
      repo.writeConversationInput(
        {
          type: 'append',
          sessionId: f.sessionId,
          inputId: body.inputId,
          offset: 0,
          text: send.content,
        },
        owner,
      )
      repo.writeConversationInput(
        { type: 'seal', sessionId: f.sessionId, inputId: body.inputId },
        owner,
      )
      const p = preview(
        f,
        kind === 'session' ? { kind, sessionId: f.sessionId } : { kind, projectId: f.projectId },
        [task(f, run)],
      )
      f.archives.prepare(p, 'utility-a')
      f.archives.claim(p.operationId, 'utility-a', p.tasks, [run.id], () => {})
      const beforeBody = f.db.drizzle.select().from(conversationBodyInputs).all()
      const beforeJournal = f.db.drizzle.select().from(agentEventJournal).all()
      expect(() =>
        repo.receiveCollaborationInput(send, body.inputId, 'codex', 'immediate_safe_point', owner),
      ).toThrow(WorkspaceArchiveConflictError)
      f.archives.fail(
        p.operationId,
        [{ sessionId: f.sessionId, outcome: 'unresolved' }],
        'Native work uncertain',
        true,
      )
      expect(() =>
        repo.receiveCollaborationInput(send, body.inputId, 'codex', 'immediate_safe_point', owner),
      ).toThrow(WorkspaceArchiveConflictError)
      expect(f.db.drizzle.select().from(collaborationInputs).all()).toHaveLength(0)
      expect(f.db.drizzle.select().from(conversationBodyInputs).all()).toEqual(beforeBody)
      expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual(beforeJournal)
    },
  )

  it('refuses oversized previews and corrupt receipts instead of truncating facts', async () => {
    const f = await fixture()
    const p = preview(f)
    const oversized = {
      ...p,
      title: '界'.repeat(4096),
      tasks: Array.from({ length: 5 }, () => ({
        sessionId: f.sessionId,
        title: '界'.repeat(120),
        state: 'preparing' as const,
        identity: '界'.repeat(512),
      })),
    }
    expect(() => f.archives.prepare(oversized, 'utility-a')).toThrow(/preview is too large/)
    expect(f.archives.read(p.operationId)).toBeUndefined()
    expect(() =>
      f.archives.prepare({ ...p, tasks: [...oversized.tasks, oversized.tasks[0]!] }, 'utility-a'),
    ).toThrow(/Too big/)
    f.archives.prepare(p, 'utility-a')
    f.db.drizzle
      .update(workspaceArchiveOperations)
      .set({ resultsJson: JSON.stringify('x'.repeat(32 * 1024)) })
      .where(eq(workspaceArchiveOperations.id, p.operationId))
      .run()
    expect(() => f.archives.read(p.operationId)).toThrow(/exceeds its read budget/)
    expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
  })

  it('refuses a Project recovery list beyond five receipts while keeping individual checks available', async () => {
    const f = await fixture()
    for (let i = 0; i < 6; i++) {
      const sessionId = addSession(f.db, f.projectId)
      const p = preview(f, { kind: 'session', sessionId })
      claim(f, p, `historical-utility-${i}`)
      f.archives.fail(p.operationId, [], 'Historical unresolved archive', true)
      expect(f.archives.unresolvedOperations(p.scope)).toEqual([p.operationId])
    }
    expect(() =>
      f.archives.unresolvedOperations({ kind: 'project', projectId: f.projectId }),
    ).toThrow(/individually before archiving/)
  })
})

describe('Workspace archive durable native-work admission', () => {
  it.each([
    ['session', 'codex', 'stopping'],
    ['project', 'codex', 'stopping'],
    ['session', 'claude', 'stopping'],
    ['project', 'claude', 'stopping'],
    ['session', 'codex', 'unresolved'],
    ['project', 'codex', 'unresolved'],
    ['session', 'claude', 'unresolved'],
    ['project', 'claude', 'unresolved'],
    ['session', 'codex', 'archived'],
    ['project', 'codex', 'archived'],
    ['session', 'claude', 'archived'],
    ['project', 'claude', 'archived'],
  ] as const)(
    'fences settled unconfirmed Rebuild activation for %s/%s when archive is %s',
    async (kind, agentId, archiveState) => {
      const f = await fixture()
      const repo = f.db.conversationRepository
      const candidate = settledRebuildCandidate(f, agentId)
      const scope: WorkspaceArchiveScope =
        kind === 'session' ? { kind, sessionId: f.sessionId } : { kind, projectId: f.projectId }
      expect(f.archives.hasNativeWork(scope)).toBe(false)
      expect(repo.nativeRebuildOperation(candidate.id)?.stage).toBe('unconfirmed')
      const p = archiveBarrier(f, scope, archiveState)
      const before = rebuildSnapshot(f, candidate)
      const observation = (() => {
        try {
          const patch = repo.completeNativeRebuild(
            candidate.id,
            candidate.nativeSessionId,
            candidate.executorId,
            candidate.witness,
          )
          return {
            kind: 'returned',
            patchMessageCount: patch.messages.length,
            after: rebuildSnapshot(f, candidate),
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error
          return {
            kind: 'conflict',
            errorClass: error.constructor.name,
            message: error.message,
            after: rebuildSnapshot(f, candidate),
          }
        }
      })()
      expect(observation).toEqual({
        kind: 'conflict',
        errorClass: 'WorkspaceArchiveConflictError',
        message: expect.stringContaining(
          archiveState === 'archived' && kind === 'session'
            ? 'Session is archived'
            : 'being archived',
        ),
        after: before,
      })
      expect(f.archives.read(p.operationId)?.state).toBe(archiveState)
    },
  )

  it.each([
    ['session', 'codex', 'stopping'],
    ['project', 'codex', 'stopping'],
    ['session', 'claude', 'stopping'],
    ['project', 'claude', 'stopping'],
    ['session', 'codex', 'unresolved'],
    ['project', 'codex', 'unresolved'],
    ['session', 'claude', 'unresolved'],
    ['project', 'claude', 'unresolved'],
    ['session', 'codex', 'archived'],
    ['project', 'codex', 'archived'],
    ['session', 'claude', 'archived'],
    ['project', 'claude', 'archived'],
  ] as const)(
    'reads a completed Rebuild receipt for %s/%s when archive is %s without activating or writing',
    async (kind, agentId, archiveState) => {
      const f = await fixture()
      const repo = f.db.conversationRepository
      const candidate = settledRebuildCandidate(f, agentId)
      repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        candidate.executorId,
        candidate.witness,
      )
      const scope: WorkspaceArchiveScope =
        kind === 'session' ? { kind, sessionId: f.sessionId } : { kind, projectId: f.projectId }
      const p = archiveBarrier(f, scope, archiveState)
      const before = rebuildSnapshot(f, candidate)
      const patch = repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        candidate.executorId,
        candidate.witness,
      )
      expect(patch.messages).toEqual([])
      expect(rebuildSnapshot(f, candidate)).toEqual(before)
      expect(before.binding).toMatchObject({
        nativeSessionId: candidate.nativeSessionId,
        generation: 8,
      })
      expect(before.runCount).toBe(0)
      expect(f.archives.read(p.operationId)?.state).toBe(archiveState)
    },
  )

  it.each([
    ['session', 'codex', 'cancelled'],
    ['project', 'codex', 'cancelled'],
    ['session', 'claude', 'cancelled'],
    ['project', 'claude', 'cancelled'],
    ['session', 'codex', 'released'],
    ['project', 'codex', 'released'],
    ['session', 'claude', 'released'],
    ['project', 'claude', 'released'],
  ] as const)(
    'permits explicit Rebuild activation for %s/%s after archive is %s',
    async (kind, agentId, result) => {
      const f = await fixture()
      const repo = f.db.conversationRepository
      const candidate = settledRebuildCandidate(f, agentId)
      const scope: WorkspaceArchiveScope =
        kind === 'session' ? { kind, sessionId: f.sessionId } : { kind, projectId: f.projectId }
      const p = preview(f, scope)
      f.archives.prepare(p, 'utility-a')
      const before = rebuildSnapshot(f, candidate)
      let blockedActivation = 'not_checked'
      let workBeforeRelease = f.archives.hasNativeWork(scope)
      if (result === 'cancelled') {
        f.archives.cancel(p.operationId)
      } else {
        f.archives.claim(p.operationId, 'utility-a', [], [], () => {})
        f.archives.fail(
          p.operationId,
          [],
          'Native effects were not confirmed at archive deadline',
          true,
        )
        try {
          repo.completeNativeRebuild(
            candidate.id,
            candidate.nativeSessionId,
            candidate.executorId,
            candidate.witness,
          )
          blockedActivation = 'returned'
        } catch (error) {
          if (!(error instanceof Error)) throw error
          blockedActivation = error.constructor.name
        }
        workBeforeRelease = f.archives.hasNativeWork(scope)
        f.archives.releaseResolved(p.operationId)
      }
      expect(blockedActivation).toBe(
        result === 'released' ? 'WorkspaceArchiveConflictError' : 'not_checked',
      )
      expect(workBeforeRelease).toBe(false)
      expect(f.archives.read(p.operationId)?.state).toBe(
        result === 'released' ? 'not_archived' : 'cancelled',
      )
      // Cancellation/status reconciliation changes neither binding nor candidate automatically.
      expect(rebuildSnapshot(f, candidate)).toEqual(before)
      const patch = repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        candidate.executorId,
        candidate.witness,
      )
      expect(patch.messages).toHaveLength(1)
      const after = rebuildSnapshot(f, candidate)
      expect(after.binding).toMatchObject({
        nativeSessionId: candidate.nativeSessionId,
        generation: 8,
        continuationState: 'ready',
      })
      expect(after.operation).toEqual({ stage: 'completed', nativeWorkState: 'settled' })
      expect(after.messages).toHaveLength(before.messages.length + 1)
      expect(after.journalCount).toBe(before.journalCount + 1)
      expect(after.runCount).toBe(0)
      expect(f.db.sessionRepository.find(f.sessionId)?.archivedAt).toBeUndefined()
      expect(f.db.projectCatalogRepository.find(f.projectId)?.archivedAt).toBeUndefined()
    },
  )

  it.each([
    ['active retained Run', { status: 'running', nativeOutcome: null }],
    [
      'old abandoned pending effects',
      { controlDisposition: 'abandoned', bindingGeneration: 1, nativeEffectsState: 'pending' },
    ],
    [
      'old abandoned unknown effects',
      { controlDisposition: 'abandoned', bindingGeneration: 1, nativeEffectsState: 'unknown' },
    ],
    [
      'possibly sent without outcome',
      { status: 'failed', dispatchPhase: 'possibly_sent', nativeOutcome: null },
    ],
    [
      'accepted without outcome',
      { status: 'interrupted', dispatchPhase: 'accepted', nativeOutcome: null },
    ],
    ['ended without outcome', { status: 'completed', dispatchPhase: 'ended', nativeOutcome: null }],
  ] satisfies [string, Partial<typeof agentRuns.$inferInsert>][])(
    'refuses %s even when current captured tasks are empty',
    async (_name, changes) => {
      const f = await fixture()
      seedRun(f, changes)
      expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.sessionId })).toBe(true)
      expect(f.archives.hasNativeWork({ kind: 'project', projectId: f.projectId })).toBe(true)
      expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.siblingId })).toBe(false)
      const p = preview(f)
      f.archives.prepare(p, 'utility-a')
      const retire = vi.fn<() => void>()
      expect(() => f.archives.claim(p.operationId, 'utility-a', [], [], retire)).toThrow(
        /Other native work/,
      )
      expect(retire).not.toHaveBeenCalled()
      expect(() => f.db.sessionRepository.archive(f.sessionId)).toThrow(/not been confirmed ended/)
    },
  )

  it('ignores settled history and inherited Fork Run records while retaining actual old effects', async () => {
    const f = await fixture()
    seedRun(f)
    seedRun(f, {
      controlDisposition: 'abandoned',
      status: 'running',
      nativeOutcome: null,
      nativeEffectsState: 'not_dispatched',
      dispatchPhase: 'not_sent',
    })
    seedRun(f, {
      forkSourceRunId: randomUUID(),
      status: 'running',
      nativeOutcome: null,
      nativeEffectsState: 'unknown',
    })
    expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.sessionId })).toBe(false)
    const pendingId = seedRun(f, { nativeEffectsState: 'unknown', controlDisposition: 'abandoned' })
    expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.sessionId })).toBe(true)
    f.db.conversationRepository.recordNativeEffects(pendingId, 'settled')
    expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.sessionId })).toBe(false)
  })

  it.each(['responding', 'waiting_user'] as const)(
    'refuses a %s context with no owned foreground Run',
    async (continuationState) => {
      const f = await fixture()
      f.db.drizzle
        .insert(nativeAgentContexts)
        .values({
          sessionId: f.sessionId,
          agentId: 'codex',
          nativeSessionId: 'fixture-native-context',
          bindingGeneration: 3,
          continuationState,
          state: 'active',
          updatedAt: createdAt,
        })
        .run()
      const p = preview(f)
      f.archives.prepare(p, 'utility-a')
      expect(() => f.archives.claim(p.operationId, 'utility-a', [], [], () => {})).toThrow(
        /Other native work/,
      )
      expect(() => f.db.projectCatalogRepository.archive(f.projectId)).toThrow(
        /not been confirmed ended/,
      )
    },
  )

  it.each(['pending', 'unknown'] as const)(
    'refuses %s Rebuild work across old binding generations',
    async (nativeWorkState) => {
      const f = await fixture()
      f.db.drizzle
        .insert(nativeRebuildOperations)
        .values({
          id: randomUUID(),
          sessionId: f.sessionId,
          agentId: 'codex',
          oldGeneration: 1,
          abandon: true,
          stage: 'superseded',
          nativeWorkState,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.sessionId })).toBe(true)
      expect(f.archives.hasNativeWork({ kind: 'project', projectId: f.projectId })).toBe(true)
      expect(() => f.db.sessionRepository.archive(f.sessionId)).toThrow(/not been confirmed ended/)
    },
  )

  it.each(['pending', 'unknown'] as const)(
    'refuses %s Fork work for both source and target Projects',
    async (nativeWorkState) => {
      const f = await fixture()
      const targetProjectId = randomUUID()
      f.db.projectCatalogRepository.add({
        id: targetProjectId,
        name: 'Fork target fixture',
        directoryPath: `/archive-fixture/${targetProjectId}`,
        kind: 'directory',
        createdAt,
      })
      const targetId = addSession(f.db, targetProjectId)
      const operationId = randomUUID()
      f.db.drizzle
        .insert(sessionForkOperations)
        .values({
          id: operationId,
          sessionId: targetId,
          sourceSessionId: f.sessionId,
          sourceMessageId: randomUUID(),
          sourceSequence: 0,
          sourceRevision: 'fixture-source-revision',
          settingsRevision: 1,
          fullConsentJson: '{}',
          createdAt,
        })
        .run()
      f.db.drizzle
        .insert(nativeForkIntents)
        .values({
          operationId,
          agentId: 'codex',
          sourceJson: '{}',
          state: 'unconfirmed',
          nativeWorkState,
          updatedAt: createdAt,
        })
        .run()
      for (const scope of [
        { kind: 'session', sessionId: f.sessionId },
        { kind: 'session', sessionId: targetId },
        { kind: 'project', projectId: f.projectId },
        { kind: 'project', projectId: targetProjectId },
      ] satisfies WorkspaceArchiveScope[])
        expect(f.archives.hasNativeWork(scope)).toBe(true)
      expect(f.archives.hasNativeWork({ kind: 'session', sessionId: f.siblingId })).toBe(false)
      expect(() => f.db.sessionRepository.archive(f.sessionId)).toThrow(/not been confirmed ended/)
      expect(() => f.db.sessionRepository.archive(targetId)).toThrow(/not been confirmed ended/)
      f.db.drizzle
        .update(nativeForkIntents)
        .set({ nativeWorkState: 'settled' })
        .where(eq(nativeForkIntents.operationId, operationId))
        .run()
      expect(f.archives.hasNativeWork({ kind: 'project', projectId: f.projectId })).toBe(false)
      expect(f.archives.hasNativeWork({ kind: 'project', projectId: targetProjectId })).toBe(false)
    },
  )

  it('uses bounded indexed production receipt and native-work queries with 10x unrelated history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-workspace-archive-plan-'))
    directories.add(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath)
    const p = preview(f)
    claim(f, p)
    f.archives.fail(p.operationId, [], 'Fixture unresolved state', true)
    const sqlite = new Database(filePath)
    const queries: { query: string; params: unknown[] }[] = []
    try {
      const traced = drizzle(sqlite, {
        schema,
        logger: {
          logQuery: (query, params) => {
            if (queries.length >= 32)
              throw new Error('Archive fixture query capture exceeds its bound')
            queries.push({ query, params })
          },
        },
      })
      const archives = new WorkspaceArchiveRepository(traced)
      const explain = () => {
        queries.length = 0
        expect(archives.hasNativeWork({ kind: 'project', projectId: f.projectId })).toBe(false)
        expect(archives.unresolvedOperations(p.scope)).toEqual([p.operationId])
        expect(workspaceArchiveBlocked(traced, f.projectId, f.sessionId)).toBe(true)
        expect(archives.read(p.operationId)?.state).toBe('unresolved')
        archives.prepare(preview(f, { kind: 'session', sessionId: f.siblingId }), 'utility-plan')
        archives.recover('utility-plan')
        return queries
          .filter(({ query }) => /^(select|update) /u.test(query))
          .map(({ query, params }) => ({
            query,
            plan: sqlite
              .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
              .all(...params)
              .map((row) => row.detail),
          }))
      }
      const seedUnrelated = (count: number) => {
        const unrelatedProjectId = randomUUID()
        f.db.drizzle
          .insert(projects)
          .values({
            id: unrelatedProjectId,
            name: 'Unrelated SQL history',
            directoryPath: `/archive-fixture/${unrelatedProjectId}`,
            kind: 'directory',
            createdAt,
          })
          .run()
        f.db.drizzle.transaction(() => {
          for (let i = 0; i < count; i++) {
            const sessionId = randomUUID()
            f.db.drizzle
              .insert(sessions)
              .values({
                id: sessionId,
                projectId: unrelatedProjectId,
                title: 'Unrelated',
                status: 'idle',
                settingsRevision: 1,
                createdAt,
                updatedAt: createdAt,
              })
              .run()
            seedRun(f, { sessionId })
            const operationId = randomUUID()
            f.db.drizzle
              .insert(workspaceArchiveOperations)
              .values({
                id: operationId,
                projectId: unrelatedProjectId,
                sessionId,
                ownerId: 'historical-utility',
                state: 'archived',
                previewJson: JSON.stringify({
                  operationId,
                  scope: { kind: 'session', sessionId },
                  title: 'Unrelated restored Session',
                  projectId: unrelatedProjectId,
                  tasks: [],
                  expiresAt: new Date(Date.now() + 120_000).toISOString(),
                }),
                createdAt,
                updatedAt: createdAt,
              })
              .run()
          }
        })
      }
      seedUnrelated(100)
      const before = explain()
      seedUnrelated(900)
      const after = explain()
      expect(after).toEqual(before)
      const native = after.find(({ query }) => query.includes('native_rebuild_operations'))!
      expect(
        native.plan.some((detail) => detail.includes('sessions_project_native_work_idx')),
      ).toBe(true)
      expect(native.plan.some((detail) => /SCAN (r|n|f|i)\b/u.test(detail))).toBe(false)
      const fences = after.filter(
        ({ query }) =>
          query.includes('workspace_archive_operations') &&
          query.startsWith('select ') &&
          !query.includes('where "workspace_archive_operations"."id" ='),
      )
      expect(fences.length).toBeGreaterThanOrEqual(2)
      expect(
        fences.every(({ plan }) =>
          plan.some((detail) => detail.includes('workspace_archive_scope_active_idx')),
        ),
      ).toBe(true)
      const owner = after.find(
        ({ query }) =>
          query.startsWith('update "workspace_archive_operations"') &&
          query.includes('"owner_id" ='),
      )!
      expect(
        owner.plan.some((detail) => detail.includes('workspace_archive_owner_prepared_idx')),
      ).toBe(true)
      const recovery = after.find(
        ({ query }) =>
          query.startsWith('update "workspace_archive_operations"') &&
          query.includes('"owner_id" <>'),
      )!
      expect(
        recovery.plan.some((detail) => detail.includes('workspace_archive_scope_active_idx')),
      ).toBe(true)
    } finally {
      sqlite.close()
    }
  })
})
