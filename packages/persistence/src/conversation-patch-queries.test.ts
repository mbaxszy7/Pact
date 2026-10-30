import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { createQueueFixture } from './conversation-queue.test-helper.js'
import { agentRuns, nativeAgentContexts, sessions } from './schema/index.js'

function hotQuery(source: string): string | undefined {
  if (source.startsWith('select "id", "project_id"') && source.includes('from "sessions" where'))
    return 'session'
  if (
    source.includes('from "agent_runs"') &&
    source.includes(
      'where ("agent_runs"."session_id" = ? and "agent_runs"."control_disposition" <> ?',
    )
  )
    return 'latest-run'
  if (
    source.includes('from "conversation_messages"') &&
    source.includes('max(') &&
    source.includes('"is_visible"')
  )
    return 'unread'
  if (
    source.includes('from "collaboration_inputs"') &&
    source.includes('order by') &&
    !source.includes('NOT EXISTS')
  )
    return 'received-input'
  return undefined
}

function queueInput(sessionId: string) {
  return { sessionId, operationId: randomUUID(), expectedRevision: 0, enabled: true }
}

it('reuses bounded Patch query compilation while executing every current database read', async () => {
  const f = await createQueueFixture()
  try {
    const client: unknown = Reflect.get(f.db.drizzle, '$client')
    if (!(client instanceof Database)) throw Error('Missing real SQLite driver')
    const prepare = vi.spyOn(client, 'prepare')
    const input = queueInput(f.sessionId)
    f.repo.setConversationQueueEnabled(input)
    const warmCalls = prepare.mock.calls.length
    f.db.sessionRepository.rename(f.sessionId, 'Current title after compilation')
    const afterRename = prepare.mock.calls.length
    for (let i = 0; i < 3; i++) {
      const patch = f.repo.setConversationQueueEnabled(input)
      expect(patch.session.title).toBe('Current title after compilation')
      expect(patch.queue?.enabled).toBe(true)
      expect(patch.latestRunId).toBeUndefined()
    }
    const coldKinds = new Set(
      prepare.mock.calls
        .slice(0, warmCalls)
        .map(([source]) => hotQuery(source))
        .filter(Boolean),
    )
    expect(coldKinds).toEqual(new Set(['latest-run', 'received-input', 'session', 'unread']))
    expect(
      prepare.mock.calls
        .slice(afterRename)
        .map(([source]) => hotQuery(source))
        .filter(Boolean),
    ).toEqual([])
    for (const [source] of prepare.mock.calls.filter(([value]) => hotQuery(value)))
      expect(Buffer.byteLength(source)).toBeLessThanOrEqual(8192)
  } finally {
    vi.restoreAllMocks()
    f.close()
  }
})

it('reads current Session, generation, unread and queue facts across rollback and connection reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-patch-queries-'))
  const f = await createQueueFixture(join(directory, 'pact.sqlite'))
  try {
    const firstSession = f.db.sessionRepository.find(f.sessionId)!
    const otherId = randomUUID()
    f.db.sessionRepository.create(
      {
        id: otherId,
        projectId: firstSession.projectId,
        title: 'Other Session',
        createdAt: firstSession.createdAt,
      },
      firstSession.settings,
    )
    const primary = queueInput(f.sessionId),
      other = queueInput(otherId)
    f.repo.setConversationQueueEnabled(primary)
    f.repo.setConversationQueueEnabled(other)
    const first = f.root()
    f.finish(first)
    const latest = f.root()
    f.db.drizzle
      .update(agentRuns)
      .set({ createdAt: first.createdAt })
      .where(eq(agentRuns.sessionId, f.sessionId))
      .run()
    const queued = f.queue(latest, 'Current queued body')
    expect(f.repo.receivedCollaborationInput(f.sessionId)?.id).toBe(queued.inputId)
    expect(f.repo.receivedCollaborationInput(otherId)).toBeUndefined()
    const read = () => f.repo.setConversationQueueEnabled(primary)
    expect(read()).toMatchObject({
      latestRunId: latest.id,
      session: { hasUnread: true },
      queue: { input: { id: queued.inputId } },
    })
    expect(f.repo.setConversationQueueEnabled(other)).toMatchObject({
      session: { id: otherId, title: 'Other Session', hasUnread: false },
      queue: { input: null },
    })
    const rollback = new Error('Controlled rollback')
    expect(() =>
      f.db.drizzle.transaction((tx) => {
        tx.update(sessions)
          .set({ title: 'Uncommitted title', titleSource: 'user', queueEnabled: false })
          .where(eq(sessions.id, f.sessionId))
          .run()
        tx.update(nativeAgentContexts)
          .set({ bindingGeneration: 2 })
          .where(eq(nativeAgentContexts.sessionId, f.sessionId))
          .run()
        expect(read()).toMatchObject({
          session: { title: 'Uncommitted title' },
          queue: { enabled: false },
        })
        expect(read().latestRunId).toBeUndefined()
        throw rollback
      }),
    ).toThrow(rollback)
    expect(read()).toMatchObject({
      latestRunId: latest.id,
      session: { title: 'Queue regression' },
      queue: { enabled: true },
    })
    f.db.drizzle
      .update(agentRuns)
      .set({ controlDisposition: 'abandoned' })
      .where(eq(agentRuns.id, latest.id))
      .run()
    expect(read().latestRunId).toBe(first.id)
    f.db.drizzle
      .update(agentRuns)
      .set({ controlDisposition: 'retained', forkSourceRunId: first.id })
      .where(eq(agentRuns.id, latest.id))
      .run()
    expect(read().latestRunId).toBe(first.id)
    f.db.drizzle
      .update(agentRuns)
      .set({ forkSourceRunId: null })
      .where(eq(agentRuns.id, latest.id))
      .run()
    expect(read().latestRunId).toBe(latest.id)
    f.repo.removeQueuedConversationMessage(queued)
    expect(f.repo.receivedCollaborationInput(f.sessionId)).toBeUndefined()
    expect(f.repo.receivedCollaborationInput(f.sessionId, true)?.id).toBe(queued.inputId)
    f.db.sessionRepository.markRead(f.sessionId, 1_000_000)
    expect(read().session.hasUnread).toBe(false)
    await f.reopen()
    expect(read()).toMatchObject({
      latestRunId: latest.id,
      session: { title: 'Queue regression', hasUnread: false },
    })
    expect(f.repo.receivedCollaborationInput(f.sessionId)).toBeUndefined()
    expect(f.repo.setConversationQueueEnabled(other).session.id).toBe(otherId)
  } finally {
    f.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('projects the complete latest Agent Run after atomic identity selection without changing legacy filters', async () => {
  const f = await createQueueFixture()
  try {
    const session = f.db.sessionRepository.find(f.sessionId)!
    const otherSessionId = randomUUID()
    f.db.sessionRepository.create(
      {
        id: otherSessionId,
        projectId: session.projectId,
        title: 'Other latest Run',
        createdAt: session.createdAt,
      },
      session.settings,
    )
    const createdAt = '2026-10-01T00:00:00.000Z'
    const insert = (
      sessionId: string,
      agentId: 'codex' | 'claude',
      id = randomUUID(),
      forkSourceRunId?: string,
    ) => {
      f.db.drizzle
        .insert(agentRuns)
        .values({
          id,
          sessionId,
          agentId,
          userMessageId: randomUUID(),
          status: 'completed',
          attemptCount: 1,
          settingsRevision: 1,
          createdAt,
          updatedAt: createdAt,
          ...(forkSourceRunId ? { forkSourceRunId } : {}),
        })
        .run()
      return id
    }
    const first = insert(f.sessionId, 'codex', 'ffffffff-ffff-4fff-bfff-ffffffffffff')
    const latest = insert(f.sessionId, 'codex', '00000000-0000-4000-8000-000000000001')
    insert(f.sessionId, 'codex', randomUUID(), latest)
    const peer = insert(f.sessionId, 'claude')
    const other = insert(otherSessionId, 'codex')
    const check = (sessionId: string, agentId: 'codex' | 'claude', id: string) =>
      expect(f.repo.latestAgentRun(sessionId, agentId)).toEqual(f.repo.findRun(id))
    check(f.sessionId, 'codex', latest)
    check(f.sessionId, 'claude', peer)
    check(otherSessionId, 'codex', other)
    expect(f.repo.latestAgentRun(otherSessionId, 'claude')).toBeUndefined()
    expect(f.repo.latestAgentRun(randomUUID(), 'codex')).toBeUndefined()
    f.db.drizzle
      .update(agentRuns)
      .set({ controlDisposition: 'abandoned' })
      .where(eq(agentRuns.id, latest))
      .run()
    // The no-generation legacy lookup includes abandoned rows; generation-aware callers differ.
    check(f.sessionId, 'codex', latest)
    f.db.drizzle
      .update(agentRuns)
      .set({ createdAt: '2026-10-02T00:00:00.000Z' })
      .where(eq(agentRuns.id, first))
      .run()
    check(f.sessionId, 'codex', first)
    f.db.drizzle
      .update(agentRuns)
      .set({ workspaceChangesJson: '{invalid' })
      .where(eq(agentRuns.id, first))
      .run()
    expect(() => f.repo.findRun(first)).toThrow(SyntaxError)
    expect(() => f.repo.latestAgentRun(f.sessionId, 'codex')).toThrow(SyntaxError)
  } finally {
    f.close()
  }
})
