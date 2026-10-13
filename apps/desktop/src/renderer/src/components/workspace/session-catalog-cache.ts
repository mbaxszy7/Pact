import type { QueryClient } from '@tanstack/react-query'

import type {
  CollaborationSession,
  SessionCatalogChange,
  SessionCatalogCursor,
  SessionCatalogPage,
} from '@pact/contracts'

import { SESSION_CATALOG_PAGE_ITEMS } from '@pact/contracts'

import { sessionWorkspaceQueryKeys } from '../../query-client'

export interface SessionCatalogCache {
  sessions: CollaborationSession[]
  projectPages: Record<string, { revision: number; nextCursor?: SessionCatalogCursor }>
}

function byCreation(left: CollaborationSession, right: CollaborationSession): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}

function sessionFromCatalogSnapshot(
  incoming: CollaborationSession,
  existing: CollaborationSession | undefined,
  revision: number,
  knownRevision: number | undefined,
): CollaborationSession {
  if (!existing) return incoming
  if (incoming.updatedAt < existing.updatedAt) return existing
  if (
    incoming.updatedAt === existing.updatedAt &&
    knownRevision !== undefined &&
    revision <= knownRevision &&
    incoming.status !== 'archived' &&
    incoming.settingsRevision <= existing.settingsRevision
  ) {
    // Equal-time/equal-revision reads cannot supersede live Run facts. Keep
    // other receipt fields (such as unread), while actual Run Patches still
    // settle activity and real Archive/settings changes remain accepted.
    return { ...incoming, activity: existing.activity, status: existing.status }
  }
  return incoming
}

export function mergeSessionCatalogPage(
  current: SessionCatalogCache | undefined,
  page: SessionCatalogPage,
): SessionCatalogCache {
  return mergeSessionCatalogPages(current, [page])
}

export function mergeSessionCatalogPages(
  current: SessionCatalogCache | undefined,
  pages: SessionCatalogPage[],
): SessionCatalogCache {
  const byId = new Map<string, CollaborationSession>()
  for (const session of current?.sessions ?? []) byId.set(session.id, session)
  const projectPages = { ...current?.projectPages }
  let accepted = false
  for (const page of pages) {
    const previousPage = projectPages[page.projectId]
    if (previousPage && previousPage.revision > page.revision) continue
    accepted = true
    for (const session of page.sessions) {
      const existing = byId.get(session.id)
      // A Catalog read may have started before a live Run Patch. Its global
      // Catalog revision does not order that Session's streaming activity.
      byId.set(
        session.id,
        sessionFromCatalogSnapshot(session, existing, page.revision, previousPage?.revision),
      )
    }
    projectPages[page.projectId] = {
      revision: page.revision,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }
  if (!accepted && current) return current
  return {
    sessions: [...byId.values()].toSorted(byCreation),
    projectPages,
  }
}

export function patchCatalogSession(
  queryClient: QueryClient,
  patch: Pick<CollaborationSession, 'id'> & Partial<CollaborationSession>,
): void {
  const current = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
  if (!current) return
  const index = current.sessions.findIndex((session) => session.id === patch.id)
  if (index < 0) return
  const existing = current.sessions[index]
  if (!existing) return
  if (patch.updatedAt && patch.updatedAt < existing.updatedAt) return
  const activity = patch.activity
  const activityUnchanged =
    !activity ||
    (existing.activity.state === activity.state &&
      existing.activity.agentId === activity.agentId &&
      existing.activity.attemptCount === activity.attemptCount)
  if (
    activityUnchanged &&
    Object.entries(patch).every(
      ([key, value]) =>
        // Stream timestamps do not affect Sidebar display or Catalog order.
        key === 'updatedAt' || key === 'activity' || Reflect.get(existing, key) === value,
    )
  ) {
    return
  }
  const sessions = current.sessions.slice()
  sessions[index] = { ...existing, ...patch }
  queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, { ...current, sessions })
}

export function acceptSessionCatalogChange(
  queryClient: QueryClient,
  change: SessionCatalogChange,
): void {
  const current = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
  if (!current) {
    queryClient.setQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog, {
      sessions: change.session.status === 'archived' ? [] : [change.session],
      projectPages: {},
    })
    void queryClient.invalidateQueries({ queryKey: sessionWorkspaceQueryKeys.catalog })
    return
  }
  const projectPage = current.projectPages[change.session.projectId]
  if (projectPage && change.revision < projectPage.revision) return
  const existing = current.sessions.find((session) => session.id === change.session.id)
  if (existing && change.session.updatedAt < existing.updatedAt) return
  const snapshot = sessionFromCatalogSnapshot(
    change.session,
    existing,
    change.revision,
    projectPage?.revision,
  )
  const other = current.sessions.filter((session) => session.id !== change.session.id)
  let nextSessions =
    snapshot.status === 'archived' ? other : [...other, snapshot].toSorted(byCreation)
  let nextCursor = projectPage?.nextCursor
  const existingProjectSessions = current.sessions.filter(
    (session) => session.projectId === change.session.projectId,
  )
  if (
    projectPage &&
    change.session.status !== 'archived' &&
    !existingProjectSessions.some((session) => session.id === change.session.id) &&
    existingProjectSessions.length >= SESSION_CATALOG_PAGE_ITEMS
  ) {
    // A newly created/restored Session can enter an already loaded window. Keep the
    // same visible depth and move its keyset boundary back to the last visible row.
    // The next Load more then adds exactly five unseen Sessions instead of skipping one.
    const sortedProject = nextSessions.filter(
      (session) => session.projectId === change.session.projectId,
    )
    const newPosition = sortedProject.findIndex((session) => session.id === change.session.id)
    if (newPosition >= 0 && newPosition < existingProjectSessions.length) {
      const lastIncluded = sortedProject[existingProjectSessions.length - 1]
      const removedIds = new Set(
        sortedProject.slice(existingProjectSessions.length).map((session) => session.id),
      )
      nextSessions = nextSessions.filter((session) => !removedIds.has(session.id))
      if (lastIncluded) {
        nextCursor = {
          projectId: change.session.projectId,
          revision: change.revision,
          createdAt: lastIncluded.createdAt,
          id: lastIncluded.id,
        }
      }
    }
  }
  queryClient.setQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog, {
    sessions: nextSessions,
    projectPages: {
      ...current.projectPages,
      ...(projectPage
        ? {
            [change.session.projectId]: {
              revision: change.revision,
              ...(nextCursor ? { nextCursor: { ...nextCursor, revision: change.revision } } : {}),
            },
          }
        : {}),
    },
  })
  if (!projectPage) {
    void queryClient.invalidateQueries({ queryKey: sessionWorkspaceQueryKeys.catalog })
  }
}
