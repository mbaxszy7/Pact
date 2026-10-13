import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import type { CollaborationSession, SessionCatalogCursor } from '@pact/contracts'

import { sessionWorkspaceQueryKeys } from '../../query-client'
import {
  acceptSessionCatalogChange,
  mergeSessionCatalogPage,
  mergeSessionCatalogPages,
  patchCatalogSession,
  type SessionCatalogCache,
} from './session-catalog-cache'

const projectId = '00000000-0000-4000-8000-000000000001'
const settings: CollaborationSession['settings'] = {
  primaryAgentId: 'codex',
  agents: {
    claude: { model: null, effort: null },
    codex: { model: null, effort: null },
  },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

function session(index: number): CollaborationSession {
  const createdAt = new Date(Date.parse('2026-09-24T00:00:00.000Z') + index).toISOString()
  return {
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    projectId,
    title: `Session ${index}`,
    titleSource: 'user',
    status: 'idle',
    activity: { state: 'idle' },
    hasUnread: false,
    settings,
    settingsRevision: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

function cursor(last: CollaborationSession, revision: number): SessionCatalogCursor {
  return { projectId, revision, createdAt: last.createdAt, id: last.id }
}

function cached(sessions: CollaborationSession[], revision = 1): SessionCatalogCache {
  const last = sessions.at(-1)
  return {
    sessions,
    projectPages: {
      [projectId]: {
        revision,
        ...(last ? { nextCursor: cursor(last, revision) } : {}),
      },
    },
  }
}

describe('Session Catalog cache', () => {
  it('merges pages by Session id and creation order without accepting an older revision', () => {
    const older = session(1)
    const newer = session(2)
    const initial = cached([newer], 2)
    const merged = mergeSessionCatalogPage(initial, {
      kind: 'page',
      projectId,
      revision: 2,
      sessions: [older, { ...newer, title: 'Updated' }],
    })
    expect(merged.sessions.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: newer.id, title: 'Updated' },
      { id: older.id, title: older.title },
    ])
    expect(
      mergeSessionCatalogPage(merged, {
        kind: 'page',
        projectId,
        revision: 1,
        sessions: [session(3)],
      }),
    ).toBe(merged)
  })

  it('publishes several Project first pages with one sorted cache merge', () => {
    const otherProjectId = '00000000-0000-4000-8000-000000000002'
    const first = session(1)
    const second = { ...session(2), projectId: otherProjectId }
    const merged = mergeSessionCatalogPages(undefined, [
      { kind: 'page', projectId, revision: 3, sessions: [first] },
      { kind: 'page', projectId: otherProjectId, revision: 3, sessions: [second] },
    ])
    expect(merged.sessions.map(({ id }) => id)).toEqual([second.id, first.id])
    expect(merged.projectPages).toEqual({
      [projectId]: { revision: 3 },
      [otherProjectId]: { revision: 3 },
    })
  })

  it('keeps a loaded five-row window after a new Session enters at the front', () => {
    const rows = [4, 3, 2, 1, 0].map(session)
    const added = session(5)
    const queryClient = new QueryClient()
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, cached(rows))
    acceptSessionCatalogChange(queryClient, { kind: 'change', revision: 2, session: added })
    const next = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
    expect(next?.sessions.map(({ id }) => id)).toEqual([
      added.id,
      rows[0]?.id,
      rows[1]?.id,
      rows[2]?.id,
      rows[3]?.id,
    ])
    expect(next?.projectPages[projectId]?.nextCursor).toEqual(cursor(rows[3]!, 2))
  })

  it('adds to a partial page, updates an existing row, and removes an archived row', () => {
    const rows = [session(2), session(1)]
    const queryClient = new QueryClient()
    queryClient.setQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog, {
      sessions: rows,
      projectPages: { [projectId]: { revision: 1 } },
    })
    const added = session(3)
    acceptSessionCatalogChange(queryClient, { kind: 'change', revision: 2, session: added })
    acceptSessionCatalogChange(queryClient, {
      kind: 'change',
      revision: 3,
      session: { ...rows[0]!, title: 'Renamed' },
    })
    acceptSessionCatalogChange(queryClient, {
      kind: 'change',
      revision: 4,
      session: { ...rows[1]!, status: 'archived' },
    })
    const next = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
    expect(next?.sessions.map(({ title }) => title)).toEqual(['Session 3', 'Renamed'])
    expect(next?.projectPages[projectId]).toEqual({ revision: 4 })
  })

  it('ignores an old receipt and patches only changed Snapshot fields', () => {
    const row = session(1)
    const queryClient = new QueryClient()
    const initial = cached([row], 2)
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, initial)
    acceptSessionCatalogChange(queryClient, {
      kind: 'change',
      revision: 1,
      session: { ...row, title: 'Stale' },
    })
    expect(queryClient.getQueryData(sessionWorkspaceQueryKeys.catalog)).toBe(initial)
    patchCatalogSession(queryClient, { id: row.id, title: row.title })
    expect(queryClient.getQueryData(sessionWorkspaceQueryKeys.catalog)).toBe(initial)
    patchCatalogSession(queryClient, { id: row.id, title: 'Snapshot title' })
    expect(
      queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)?.sessions[0],
    ).toMatchObject({ title: 'Snapshot title', settingsRevision: 1 })
  })

  it('does not republish the Catalog for a stream timestamp and equivalent Activity', () => {
    const row = session(1)
    const queryClient = new QueryClient()
    const initial = cached([row])
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, initial)
    let cacheUpdates = 0
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated') cacheUpdates += 1
    })

    patchCatalogSession(queryClient, {
      id: row.id,
      title: row.title,
      titleSource: row.titleSource,
      status: row.status,
      activity: { state: 'idle' },
      hasUnread: row.hasUnread,
      updatedAt: new Date(Date.parse(row.updatedAt) + 1).toISOString(),
    })
    unsubscribe()

    expect(queryClient.getQueryData(sessionWorkspaceQueryKeys.catalog)).toBe(initial)
    expect(cacheUpdates).toBe(0)
  })

  it('publishes a changed Activity state or attempt count exactly once per change', () => {
    const row = session(1)
    const queryClient = new QueryClient()
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, cached([row]))
    let cacheUpdates = 0
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated') cacheUpdates += 1
    })

    patchCatalogSession(queryClient, {
      id: row.id,
      activity: { state: 'recovering', agentId: 'codex', attemptCount: 1 },
    })
    expect(cacheUpdates).toBe(1)
    patchCatalogSession(queryClient, {
      id: row.id,
      activity: { state: 'recovering', agentId: 'codex', attemptCount: 1 },
      updatedAt: '2026-09-24T00:00:01.000Z',
    })
    expect(cacheUpdates).toBe(1)
    patchCatalogSession(queryClient, {
      id: row.id,
      activity: { state: 'recovering', agentId: 'codex', attemptCount: 2 },
    })
    unsubscribe()

    expect(cacheUpdates).toBe(2)
    expect(
      queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)?.sessions[0]
        ?.activity,
    ).toEqual({ state: 'recovering', agentId: 'codex', attemptCount: 2 })
  })
})
