import type { QueryClient } from '@tanstack/react-query'

import type {
  CollaborationSession,
  SessionCatalogChange,
  SessionCatalogCursor,
  SessionCatalogPage,
  SessionGroupPage,
  SessionPage,
  SessionPageScope,
  SessionGroupMutation,
} from '@pact/contracts'

import { SESSION_CATALOG_PAGE_BYTES, SESSION_CATALOG_PAGE_ITEMS } from '@pact/contracts'

import { sessionWorkspaceQueryKeys } from '../../query-client'

export interface SessionCatalogCache {
  sessions: CollaborationSession[]
  navigation?: SessionNavigationCache
  projectPages: Record<string, { revision: number; nextCursor?: SessionCatalogCursor }>
}

export const UNGROUPED = { kind: 'ungrouped' } as const

type SessionWindow = Omit<SessionPage, 'sessions'> & {
  ids: string[]
  touched: number
  refresh?: boolean
}
type GroupWindow = SessionGroupPage & { touched: number }
export type NavigationProject = {
  hasGroups: boolean
  revision: number
  groups?: GroupWindow | undefined
  windows: Record<string, SessionWindow>
}

export interface SessionNavigationCache {
  projects: Record<string, NavigationProject>
  selectedId?: string | undefined
  recentId?: string | undefined
}

export function scopeKey(scope: SessionPageScope): string {
  return scope.kind === 'group' ? scope.groupId : 'ungrouped'
}

export function sessionScope(session: CollaborationSession): SessionPageScope {
  return session.groupId ? { kind: 'group', groupId: session.groupId } : UNGROUPED
}

export function emptyNavigationCatalog(): SessionCatalogCache & {
  navigation: SessionNavigationCache
} {
  return { sessions: [], projectPages: {}, navigation: { projects: {} } }
}

const CACHE_ITEMS = 20_000
const CACHE_BYTES = 20 * 1024 * 1024
const MAX_GROUP_WINDOWS = 20
const measuredSessions = new WeakMap<CollaborationSession, number>()

export function boundNavigation(
  cache: SessionCatalogCache & { navigation: SessionNavigationCache },
  visible: ReadonlySet<string>,
  protectedProject?: string,
): typeof cache {
  const { projects, selectedId, recentId } = cache.navigation
  const references = new Map<string, number>()
  const sizes = new Map<string, number>()
  const encoder = new TextEncoder()
  const size = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength
  for (const session of cache.sessions) {
    let bytes = measuredSessions.get(session)
    if (bytes === undefined) {
      bytes = size(session)
      measuredSessions.set(session, bytes)
    }
    sizes.set(session.id, bytes)
  }
  const selectedGroup = cache.sessions.find((session) => session.id === selectedId)?.groupId
  let items = Object.keys(projects).length
  let bytes = items * 112
  const retain = (id: string): void => {
    const count = references.get(id) ?? 0
    if (!count) {
      items++
      bytes += (sizes.get(id) ?? 0) + 1
    }
    references.set(id, count + 1)
  }
  const release = (id: string): void => {
    const count = references.get(id)
    if (count === 1) {
      references.delete(id)
      items--
      bytes -= (sizes.get(id) ?? 0) + 1
    } else if (count) references.set(id, count - 1)
  }
  if (selectedId) retain(selectedId)
  if (recentId) retain(recentId)
  const candidates: { priority: number; touched: number; remove: () => void }[] = []
  let groupWindows = 0
  for (const [projectId, project] of Object.entries(projects)) {
    const pinned = projectId === protectedProject
    const replace = (update: NavigationProject): void => {
      projects[projectId] = update
    }
    if (project.groups) {
      const groupWindow = project.groups
      const groupIds = new Set(groupWindow.groups.map((group) => group.id))
      const groupItems = 1 + groupWindow.groups.length
      const groupBytes = size(groupWindow)
      groupWindows++
      items += groupItems
      bytes += groupBytes
      if (!pinned && !visible.has(projectId) && !(selectedGroup && groupIds.has(selectedGroup))) {
        candidates.push({
          priority: 0,
          touched: groupWindow.touched,
          remove: () => {
            replace({ ...projects[projectId]!, groups: undefined })
            items -= groupItems
            bytes -= groupBytes
            groupWindows--
          },
        })
      }
    }
    for (const [key, window] of Object.entries(project.windows)) {
      const windowItems = 1 + window.ids.length
      const windowBytes = size(window)
      items += windowItems
      bytes += windowBytes
      for (const id of window.ids) retain(id)
      if (
        !pinned &&
        !visible.has(key === 'ungrouped' ? projectId : key) &&
        !(selectedId && window.ids.includes(selectedId))
      ) {
        candidates.push({
          priority: key === 'ungrouped' ? 2 : 1,
          touched: window.touched,
          remove: () => {
            const current = projects[projectId]!
            const windows = { ...current.windows }
            delete windows[key]
            replace({ ...current, windows })
            items -= windowItems
            bytes -= windowBytes
            for (const id of window.ids) release(id)
          },
        })
      }
    }
  }
  // One response is in flight at a time. Keep its maximum allocation inside the same budget.
  const overBudget = (): boolean =>
    items > CACHE_ITEMS || bytes > CACHE_BYTES - SESSION_CATALOG_PAGE_BYTES
  for (const candidate of candidates.toSorted(
    (a, b) => a.priority - b.priority || a.touched - b.touched,
  )) {
    if (!overBudget() && groupWindows <= MAX_GROUP_WINDOWS) break
    if (!overBudget() && candidate.priority !== 0) break
    candidate.remove()
  }
  if (overBudget() || groupWindows > MAX_GROUP_WINDOWS) {
    throw new Error('This navigation window exceeds Pact’s local display budget.')
  }
  return { ...cache, sessions: cache.sessions.filter((session) => references.has(session.id)) }
}

export function installNavigationPages(
  current: SessionCatalogCache | undefined,
  pages: { page: SessionPage; direction?: 'newer' | 'older' | undefined }[],
  groupPage?: SessionGroupPage,
): SessionCatalogCache & { navigation: SessionNavigationCache } {
  const cache = current?.navigation ? current : emptyNavigationCatalog()
  const navigation = { ...cache.navigation!, projects: { ...cache.navigation!.projects } }
  const entities = new Map(cache.sessions.map((session) => [session.id, session]))
  for (const { page, direction } of pages) {
    const project = navigation.projects[page.projectId] ?? {
      hasGroups: page.hasGroups,
      revision: page.groupRevision,
      windows: {},
    }
    if (project.revision > page.groupRevision) continue
    const key = scopeKey(page.scope)
    const previous = project.windows[key]
    if (previous && previous.revision > page.revision) continue
    const ids = page.sessions.map((session) => session.id)
    for (const session of page.sessions) {
      const existing = entities.get(session.id)
      const next =
        existing && existing.updatedAt === session.updatedAt
          ? { ...session, activity: existing.activity, status: existing.status }
          : sessionFromCatalogSnapshot(session, existing, page.revision, previous?.revision)
      // Organization revision governs membership independently of Session timestamps.
      entities.set(session.id, { ...next, groupId: session.groupId })
    }
    const merge = previous && direction && previous.revision === page.revision
    const { sessions: _sessions, ...metadata } = page
    const window: SessionWindow = {
      ...metadata,
      ids: merge
        ? [
            ...new Set(
              direction === 'older' ? [...previous.ids, ...ids] : [...ids, ...previous.ids],
            ),
          ]
        : ids,
      ...(merge && direction === 'older' ? { previousCursor: previous.previousCursor } : {}),
      ...(merge && direction === 'newer' ? { nextCursor: previous.nextCursor } : {}),
      touched: performance.now(),
    }
    navigation.projects[page.projectId] = {
      ...project,
      revision: page.groupRevision,
      hasGroups: page.hasGroups,
      windows: { ...project.windows, [key]: window },
    }
  }
  if (groupPage) {
    const project = navigation.projects[groupPage.projectId] ?? {
      hasGroups: false,
      revision: 0,
      windows: {},
    }
    if (groupPage.revision >= project.revision) {
      navigation.projects[groupPage.projectId] = {
        ...project,
        hasGroups: groupPage.groups.length > 0,
        revision: groupPage.revision,
        groups: { ...groupPage, touched: performance.now() },
      }
    }
  }
  return { ...cache, sessions: [...entities.values()], navigation }
}

export function applyGroupReceipt(
  cache: SessionCatalogCache & { navigation: SessionNavigationCache },
  projectId: string,
  receipt: SessionGroupMutation,
  reloadGroups: boolean,
): typeof cache {
  const project = cache.navigation.projects[projectId]
  if (!project || project.revision > receipt.revision) return cache
  const windows = { ...project.windows }
  const { sourceScope, targetScope, dissolvedGroupId } = receipt
  if (receipt.session && sourceScope && targetScope) {
    const key = scopeKey(sourceScope)
    const destinationKey = scopeKey(targetScope)
    const source = windows[key]
    if (source && key !== destinationKey && source.groupRevision < receipt.revision)
      windows[key] = {
        ...source,
        ids: source.ids.filter((id) => id !== receipt.session?.id),
        ...(source.nextCursor || source.previousCursor ? { refresh: true } : {}),
      }
    const destination = windows[destinationKey]
    if (destination && destination.groupRevision < receipt.revision)
      windows[destinationKey] = { ...destination, refresh: true }
  } else if (dissolvedGroupId && targetScope?.kind === 'ungrouped') {
    delete windows.ungrouped
  }
  if (dissolvedGroupId) delete windows[dissolvedGroupId]

  let groups = project.groups
  let hasGroups = project.hasGroups || Boolean(receipt.group)
  if (groups) {
    const removed = groups.groups.find((group) => group.id === dissolvedGroupId)
    const remaining: GroupWindow['groups'] = []
    for (const group of groups.groups) {
      if (group.id === dissolvedGroupId) continue
      if (!reloadGroups && group.id === receipt.group?.id) {
        remaining.push(receipt.group)
        continue
      }
      const position =
        removed && group.position > removed.position ? group.position - 1 : group.position
      const collapsed =
        receipt.session && targetScope?.kind === 'group' && group.id === targetScope.groupId
          ? false
          : group.collapsed
      remaining.push(
        position === group.position && collapsed === group.collapsed
          ? group
          : { ...group, position, collapsed },
      )
    }
    if (removed && !remaining.length) {
      if (groups.revision === project.revision && receipt.revision === project.revision + 1)
        hasGroups = Boolean(groups.previousCursor || groups.nextCursor)
      groups = undefined
    } else if (
      (!reloadGroups || removed) &&
      groups.revision === project.revision &&
      receipt.revision <= project.revision + 1 &&
      (!dissolvedGroupId || removed)
    ) {
      // A deletion shrinks a contiguous page. Re-anchor at the surviving
      // boundaries, keeping the known pages on either side reachable.
      const first = remaining[0]
      const last = remaining.at(-1)
      groups = {
        ...groups,
        groups: remaining,
        revision: receipt.revision,
        previousCursor:
          groups.previousCursor && first
            ? {
                ...groups.previousCursor,
                revision: receipt.revision,
                id: first.id,
                position: first.position,
              }
            : undefined,
        nextCursor:
          groups.nextCursor && last
            ? {
                ...groups.nextCursor,
                revision: receipt.revision,
                id: last.id,
                position: last.position,
              }
            : undefined,
      }
    } else {
      // Keep the visible rows in place until the requested group window
      // arrives. Their old cursors still fence against a reordered page.
      groups = { ...groups, groups: remaining }
    }
  }
  const sessions = cache.sessions.map((session) => {
    if (session.projectId !== projectId) return session
    if (session.id === receipt.session?.id) return { ...session, groupId: receipt.session.groupId }
    if (receipt.dissolvedGroupId && session.groupId === receipt.dissolvedGroupId)
      return { ...session, groupId: null }
    return session
  })
  return {
    ...cache,
    sessions,
    navigation: {
      ...cache.navigation,
      projects: {
        ...cache.navigation.projects,
        [projectId]: {
          ...project,
          revision: receipt.revision,
          windows,
          groups,
          hasGroups,
        },
      },
    },
  }
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
  const cached = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
  const current =
    cached?.navigation && change.dissolvedGroupId && change.groupRevision !== undefined
      ? applyGroupReceipt(
          { ...cached, navigation: cached.navigation },
          change.session.projectId,
          {
            kind: 'group-change',
            revision: change.groupRevision,
            dissolvedGroupId: change.dissolvedGroupId,
          },
          false,
        )
      : cached
  if (current?.navigation) {
    const incoming = change.session
    const existing = current.sessions.find((session) => session.id === incoming.id)
    const project = current.navigation.projects[incoming.projectId]
    const key = change.dissolvedGroupId ?? scopeKey(sessionScope(existing ?? incoming))
    const window = project?.windows[key]
    const currentOrganization =
      change.groupRevision !== undefined && (!project || change.groupRevision >= project.revision)
    if (!currentOrganization) {
      if (window && change.revision < window.revision) return
      if (existing && existing.updatedAt > incoming.updatedAt) return
    }
    const snapshot = sessionFromCatalogSnapshot(
      incoming,
      existing,
      change.revision,
      window?.revision,
    )
    // Scoped pages and organization receipts own membership and sidebar visibility.
    const organization = currentOrganization ? incoming : (existing ?? incoming)
    const session = {
      ...snapshot,
      groupId: organization.groupId,
      sidebarHidden: organization.sidebarHidden,
    }
    const sessions = current.sessions.filter((item) => item.id !== session.id)
    if (session.status !== 'archived') sessions.push(session)
    const navigation = { ...current.navigation, projects: { ...current.navigation.projects } }
    if (project && change.groupRevision !== undefined && change.groupRevision > project.revision) {
      navigation.projects[incoming.projectId] = { ...project, revision: change.groupRevision }
    }
    if (project && window && (session.status === 'archived' || session.sidebarHidden)) {
      navigation.projects[incoming.projectId] = {
        ...navigation.projects[incoming.projectId]!,
        windows: {
          ...project.windows,
          [key]: {
            ...window,
            ids: window.ids.filter((id) => id !== session.id),
            ...(window.revision < change.revision && (window.nextCursor || window.previousCursor)
              ? { refresh: true }
              : {}),
          },
        },
      }
    }
    if (!existing && session.status !== 'archived') navigation.recentId = session.id
    // Session receipts update facts. Only scoped reads add navigation references.
    const previousRecent = current.navigation.recentId
    if (
      previousRecent &&
      previousRecent !== navigation.recentId &&
      previousRecent !== navigation.selectedId &&
      !Object.values(navigation.projects).some((value) =>
        Object.values(value.windows).some((scope) => scope.ids.includes(previousRecent)),
      )
    ) {
      const index = sessions.findIndex((item) => item.id === previousRecent)
      if (index >= 0) sessions.splice(index, 1)
    }
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, {
      ...current,
      sessions,
      navigation,
    })
    return
  }
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
