import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type {
  CollaborationSession,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  Project,
  SessionCatalogCursor,
  SessionCatalogPage,
  SessionSettingsEditorState,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
} from '@pact/contracts'

import { SESSION_CATALOG_PAGE_ITEMS } from '@pact/contracts'

import { sessionWorkspaceQueryKeys, unwrapRpcResult } from '../../query-client'
import {
  acceptSessionCatalogChange,
  mergeSessionCatalogPage,
  mergeSessionCatalogPages,
  patchCatalogSession,
  type SessionCatalogCache,
} from './session-catalog-cache'

const MAX_CATALOG_CACHE_ITEMS = 20_000
const MAX_CATALOG_CACHE_BYTES = 20 * 1024 * 1024
const MAX_CATALOG_PROJECTS = 1_000
const INITIAL_CATALOG_BATCH_ITEMS = 20
const INITIAL_CATALOG_BATCH_MS = 100
const MAX_LOAD_MORE_PAGES = Math.ceil(MAX_CATALOG_CACHE_ITEMS / SESSION_CATALOG_PAGE_ITEMS) + 1
const MAX_PAGE_RESTARTS = 2
const INITIAL_CATALOG_DEADLINE_MS = 30_000
const LOAD_MORE_DEADLINE_MS = 10_000

function checkCatalogPage(page: SessionCatalogPage, projectId: string): void {
  if (
    page.projectId !== projectId ||
    page.sessions.length > SESSION_CATALOG_PAGE_ITEMS ||
    page.sessions.some(
      (session) => session.projectId !== projectId || session.status === 'archived',
    )
  ) {
    throw new Error('The Session Catalog sent an invalid page.')
  }
  if (page.nextCursor && page.sessions.length === 0) {
    throw new Error('The Session Catalog did not advance its cursor.')
  }
  if (page.nextCursor) {
    const last = page.sessions.at(-1)
    if (
      page.nextCursor.projectId !== projectId ||
      page.nextCursor.revision !== page.revision ||
      page.nextCursor.id !== last?.id ||
      page.nextCursor.createdAt !== last?.createdAt
    ) {
      throw new Error('The Session Catalog returned an invalid cursor.')
    }
  }
  for (let index = 1; index < page.sessions.length; index += 1) {
    const previous = page.sessions[index - 1]
    const current = page.sessions[index]
    if (!previous || !current) continue
    if (
      previous.createdAt < current.createdAt ||
      (previous.createdAt === current.createdAt && previous.id <= current.id)
    ) {
      throw new Error('The Session Catalog returned duplicate or unordered Sessions.')
    }
  }
}

function checkCatalogCache(cache: SessionCatalogCache): void {
  if (cache.sessions.length > MAX_CATALOG_CACHE_ITEMS) {
    throw new Error('The Session Catalog exceeds Pact’s local display limit.')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(cache.sessions)).byteLength
  if (bytes > MAX_CATALOG_CACHE_BYTES) {
    throw new Error('The Session Catalog exceeds Pact’s local display limit.')
  }
}

type CollectedSessions =
  | { kind: 'revision-changed' }
  | {
      kind: 'collected'
      sessions: CollaborationSession[]
      cursor: SessionCatalogCursor | undefined
      revision: number
    }

async function collectFiveUnseenSessions(
  projectId: string,
  initialCursor: SessionCatalogCursor | undefined,
  seen: Set<string>,
  deadline: number,
  signal: AbortSignal,
): Promise<CollectedSessions> {
  const sessions: CollaborationSession[] = []
  let cursor = initialCursor
  let revision: number | undefined
  for (let pageIndex = 0; pageIndex < MAX_LOAD_MORE_PAGES; pageIndex += 1) {
    if (signal.aborted) throw new Error('Session Catalog loading was cancelled.')
    if (performance.now() >= deadline) throw new Error('Loading more Sessions timed out.')
    // Rebase may have to pass already visible rows, but each keyset read is sequential.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const result = await window.pact.getSessionCatalog(projectId, cursor)
    if (signal.aborted) throw new Error('Session Catalog loading was cancelled.')
    if (performance.now() >= deadline) throw new Error('Loading more Sessions timed out.')
    if (!result.ok) {
      if (result.error.code === 'CONFLICT') return { kind: 'revision-changed' }
      throw new Error(result.error.message)
    }
    const page = result.value
    checkCatalogPage(page, projectId)
    if (
      cursor &&
      page.nextCursor?.createdAt === cursor.createdAt &&
      page.nextCursor.id === cursor.id
    ) {
      throw new Error('The Session Catalog did not advance its cursor.')
    }
    if (revision !== undefined && revision !== page.revision) {
      return { kind: 'revision-changed' }
    }
    revision = page.revision
    let stoppedAt: CollaborationSession | undefined
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
      if (sessions.length === SESSION_CATALOG_PAGE_ITEMS) {
        stoppedAt = session
        break
      }
    }
    if (stoppedAt) {
      const lastInPage = page.sessions.at(-1)?.id === stoppedAt.id
      cursor =
        lastInPage && !page.nextCursor
          ? undefined
          : {
              projectId,
              revision: page.revision,
              createdAt: stoppedAt.createdAt,
              id: stoppedAt.id,
            }
      break
    }
    cursor = page.nextCursor
    if (!cursor) break
    if (pageIndex === MAX_LOAD_MORE_PAGES - 1) {
      throw new Error('Too many Session pages were needed to load more.')
    }
  }
  if (revision === undefined) throw new Error('Session Catalog did not return a page.')
  return { kind: 'collected', sessions, cursor, revision }
}

async function readInitialCatalog(
  queryClient: QueryClient,
  projects: Project[],
  signal: AbortSignal,
): Promise<SessionCatalogCache> {
  if (projects.length > MAX_CATALOG_PROJECTS) {
    throw new Error('There are too many Projects to load safely.')
  }
  const deadline = performance.now() + INITIAL_CATALOG_DEADLINE_MS
  const projectIds = new Set(projects.map((project) => project.id))
  const previous = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
  let cache: SessionCatalogCache = {
    sessions: (previous?.sessions ?? []).filter((session) => projectIds.has(session.projectId)),
    projectPages: Object.fromEntries(
      Object.entries(previous?.projectPages ?? {}).filter(([id]) => projectIds.has(id)),
    ),
  }
  let pendingPages: SessionCatalogPage[] = []
  let lastPublish = performance.now()
  const publish = (): void => {
    if (pendingPages.length === 0) return
    const latest = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
    const base = latest
      ? {
          sessions: latest.sessions.filter((session) => projectIds.has(session.projectId)),
          projectPages: Object.fromEntries(
            Object.entries(latest.projectPages).filter(([id]) => projectIds.has(id)),
          ),
        }
      : cache
    cache = mergeSessionCatalogPages(base, pendingPages)
    checkCatalogCache(cache)
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, cache)
    pendingPages = []
    lastPublish = performance.now()
  }
  for (const project of projects) {
    if (signal.aborted) throw new Error('Session Catalog loading was cancelled.')
    if (performance.now() >= deadline) {
      throw new Error('Session Catalog loading timed out. Retry to continue.')
    }
    if (cache.projectPages[project.id]) continue
    // Each Project owns its first five; do not fetch unseen history at startup.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const result = await window.pact.getSessionCatalog(project.id)
    if (signal.aborted) throw new Error('Session Catalog loading was cancelled.')
    if (performance.now() >= deadline) {
      throw new Error('Session Catalog loading timed out. Retry to continue.')
    }
    if (!result.ok) throw new Error(result.error.message)
    checkCatalogPage(result.value, project.id)
    pendingPages.push(result.value)
    if (
      pendingPages.length >= INITIAL_CATALOG_BATCH_ITEMS ||
      performance.now() - lastPublish >= INITIAL_CATALOG_BATCH_MS
    ) {
      publish()
    }
  }
  publish()
  return cache
}

export interface SessionWorkspaceFlow {
  savePermission(input: SessionPermissionSaveInput): Promise<boolean>
  saveSpeed(input: SessionSpeedSaveInput): Promise<boolean>
  catalog: SessionCatalogCache | undefined
  loading: boolean
  loadingMoreProjectId: string | undefined
  loadMoreErrors: Record<string, string>
  creating: boolean
  savingSettings: boolean
  renamingSessionId: string | undefined
  archivingSessionId: string | undefined
  restoringSessionId: string | undefined
  error: string | undefined
  retry(): void
  loadMore(projectId: string): Promise<number>
  prepareCreation(projectId: string): Promise<DefaultSessionSettingsEditorState | undefined>
  create(
    projectId: string,
    settings: DefaultSessionSettings,
  ): Promise<CollaborationSession | undefined>
  rename(sessionId: string, title: string): Promise<boolean>
  archive(sessionId: string, operationId?: string): Promise<boolean>
  restore(sessionId: string): Promise<boolean>
  loadSettings(sessionId: string): Promise<SessionSettingsEditorState | undefined>
  saveSettings(
    sessionId: string,
    settings: DefaultSessionSettings,
  ): Promise<SessionSettingsEditorState | undefined>
}

export function useSessionWorkspace(
  enabled: boolean,
  projects: Project[] | undefined,
): SessionWorkspaceFlow {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const settingsMutationPending = useRef(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | undefined>()
  const [archivingSessionId, setArchivingSessionId] = useState<string | undefined>()
  const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [loadingMoreProjectId, setLoadingMoreProjectId] = useState<string | undefined>()
  const [loadMoreErrors, setLoadMoreErrors] = useState<Record<string, string>>({})
  const loadMoreControllerRef = useRef<AbortController | undefined>(undefined)
  const projectSignatureRef = useRef<string | undefined>(undefined)
  const projectSignature = projects?.map((project) => project.id).join(':')
  const catalogQuery = useQuery({
    queryKey: sessionWorkspaceQueryKeys.catalog,
    queryFn: ({ signal }) => readInitialCatalog(queryClient, projects ?? [], signal),
    enabled: enabled && projects !== undefined,
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    if (!enabled || !projects || projectSignature === undefined) return
    const previous = projectSignatureRef.current
    projectSignatureRef.current = projectSignature
    if (previous !== undefined && previous !== projectSignature) void catalogQuery.refetch()
  }, [catalogQuery, enabled, projectSignature, projects])

  useEffect(() => () => loadMoreControllerRef.current?.abort(), [])

  const loadMore = async (projectId: string): Promise<number> => {
    if (loadMoreControllerRef.current) return 0
    const cache = queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
    const state = cache?.projectPages[projectId]
    if (!state?.nextCursor) return 0
    const abortController = new AbortController()
    loadMoreControllerRef.current = abortController
    const deadline = performance.now() + LOAD_MORE_DEADLINE_MS
    setLoadingMoreProjectId(projectId)
    setLoadMoreErrors((current) => ({ ...current, [projectId]: '' }))
    try {
      for (let attempt = 0; attempt <= MAX_PAGE_RESTARTS; attempt += 1) {
        const loaded = queryClient.getQueryData<SessionCatalogCache>(
          sessionWorkspaceQueryKeys.catalog,
        )
        const seen = new Set(
          loaded?.sessions
            .filter((session) => session.projectId === projectId)
            .map((session) => session.id),
        )
        // A revision change restarts this bounded attempt from the first page.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const collected = await collectFiveUnseenSessions(
          projectId,
          attempt === 0 ? state.nextCursor : undefined,
          seen,
          deadline,
          abortController.signal,
        )
        if (collected.kind === 'revision-changed') continue // Rebase from the first page.
        const current = queryClient.getQueryData<SessionCatalogCache>(
          sessionWorkspaceQueryKeys.catalog,
        )
        const latestRevision = current?.projectPages[projectId]?.revision
        // A local mutation receipt arrived during the fetch; collect against its new revision.
        if (latestRevision !== undefined && latestRevision > collected.revision) continue
        const next = mergeSessionCatalogPage(current, {
          kind: 'page',
          projectId,
          revision: collected.revision,
          sessions: collected.sessions,
          ...(collected.cursor ? { nextCursor: collected.cursor } : {}),
        })
        checkCatalogCache(next)
        queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, next)
        return collected.sessions.length
      }
      throw new Error('Sessions changed while loading. Try again.')
    } catch (error) {
      if (abortController.signal.aborted) return 0
      setLoadMoreErrors((current) => ({
        ...current,
        [projectId]: error instanceof Error ? error.message : 'Could not load more Sessions.',
      }))
      return 0
    } finally {
      if (loadMoreControllerRef.current === abortController) {
        loadMoreControllerRef.current = undefined
      }
      if (!abortController.signal.aborted) setLoadingMoreProjectId(undefined)
    }
  }

  const prepareCreation = async (
    projectId: string,
  ): Promise<DefaultSessionSettingsEditorState | undefined> => {
    setActionError(undefined)
    try {
      const prepared = unwrapRpcResult(await window.pact.prepareSessionCreation(projectId))
      queryClient.setQueryData(sessionWorkspaceQueryKeys.creation(projectId), prepared)
      return prepared
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Session settings could not be loaded.',
      )
      return undefined
    }
  }

  const create = async (
    projectId: string,
    settings: DefaultSessionSettings,
  ): Promise<CollaborationSession | undefined> => {
    if (creating) return undefined
    setCreating(true)
    setActionError(undefined)
    try {
      const change = unwrapRpcResult(await window.pact.createSession({ projectId, settings }))
      acceptSessionCatalogChange(queryClient, change)
      return change.session
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be created.')
      return undefined
    } finally {
      setCreating(false)
    }
  }

  const loadSettings = async (
    sessionId: string,
  ): Promise<SessionSettingsEditorState | undefined> => {
    setActionError(undefined)
    try {
      const editor = unwrapRpcResult(await window.pact.getSessionSettings(sessionId))
      queryClient.setQueryData(sessionWorkspaceQueryKeys.settings(sessionId), editor)
      return editor
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Session settings could not be loaded.',
      )
      return undefined
    }
  }

  const rename = async (sessionId: string, title: string): Promise<boolean> => {
    if (renamingSessionId) return false
    setRenamingSessionId(sessionId)
    setActionError(undefined)
    try {
      const change = unwrapRpcResult(await window.pact.renameSession({ sessionId, title }))
      acceptSessionCatalogChange(queryClient, change)
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be renamed.')
      return false
    } finally {
      setRenamingSessionId(undefined)
    }
  }

  const archive = async (sessionId: string, operationId?: string): Promise<boolean> => {
    if (archivingSessionId) return false
    setArchivingSessionId(sessionId)
    setActionError(undefined)
    try {
      let result = await window.pact.archiveSession(sessionId, operationId)
      if (!result.ok && result.error.code === 'UNCERTAIN' && operationId) {
        const receipt = await window.pact.readWorkspaceArchive({ operationId })
        // Only a durable success permits the same-nonce catalog read, never another Stop.
        if (receipt.ok && receipt.value.state === 'archived')
          result = await window.pact.archiveSession(sessionId, operationId)
      }
      const change = unwrapRpcResult(result)
      acceptSessionCatalogChange(queryClient, change)
      queryClient.removeQueries({ queryKey: sessionWorkspaceQueryKeys.settings(sessionId) })
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be archived.')
      return false
    } finally {
      setArchivingSessionId(undefined)
    }
  }

  const restore = async (sessionId: string): Promise<boolean> => {
    if (restoringSessionId) return false
    setRestoringSessionId(sessionId)
    setActionError(undefined)
    try {
      const change = unwrapRpcResult(await window.pact.restoreSession(sessionId))
      acceptSessionCatalogChange(queryClient, change)
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be restored.')
      return false
    } finally {
      setRestoringSessionId(undefined)
    }
  }

  const saveSettings = async (
    sessionId: string,
    settings: DefaultSessionSettings,
  ): Promise<SessionSettingsEditorState | undefined> => {
    if (settingsMutationPending.current) return undefined
    settingsMutationPending.current = true
    setSavingSettings(true)
    setActionError(undefined)
    try {
      // Session projections also carry permissions; only this operation's model/workflow fields cross its contract.
      const {
        primaryAgentId,
        agents,
        maxDiscussionRounds,
        runningMessagePolicy,
        maxReviewCycles,
        maxRepairAttempts,
      } = settings
      const saved = unwrapRpcResult(
        await window.pact.saveSessionSettings({
          sessionId,
          settings: {
            primaryAgentId,
            agents,
            maxDiscussionRounds,
            runningMessagePolicy,
            maxReviewCycles,
            maxRepairAttempts,
          },
        }),
      )
      const editor: SessionSettingsEditorState = {
        session: saved.catalogChange.session,
        modelCatalogs: saved.modelCatalogs,
      }
      queryClient.setQueryData(sessionWorkspaceQueryKeys.settings(sessionId), editor)
      acceptSessionCatalogChange(queryClient, saved.catalogChange)
      return editor
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Session settings could not be saved.',
      )
      return undefined
    } finally {
      settingsMutationPending.current = false
      setSavingSettings(false)
    }
  }

  const saveAgentSetting = async (
    input: SessionPermissionSaveInput | SessionSpeedSaveInput,
  ): Promise<boolean> => {
    if (settingsMutationPending.current) return false
    settingsMutationPending.current = true
    setSavingSettings(true)
    setActionError(undefined)
    try {
      const saved = unwrapRpcResult(
        await ('speed' in input
          ? window.pact.saveSessionSpeed(input)
          : window.pact.saveSessionPermission(input)),
      )
      acceptSessionCatalogChange(queryClient, saved)
      queryClient.setQueryData<SessionSettingsEditorState>(
        sessionWorkspaceQueryKeys.settings(input.sessionId),
        (previous) => (previous ? { ...previous, session: saved.session } : undefined),
      )
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Agent settings could not be saved.')
      // A lost reply may follow a committed setting. Read this exact Session back;
      // initial Catalog loading skips loaded Projects and can omit the affected Session.
      try {
        const editor = unwrapRpcResult(await window.pact.getSessionSettings(input.sessionId))
        if (editor.session.id !== input.sessionId)
          throw new Error('Agent settings readback returned another Session.', { cause: error })
        patchCatalogSession(queryClient, {
          id: editor.session.id,
          settings: editor.session.settings,
          settingsRevision: editor.session.settingsRevision,
          updatedAt: editor.session.updatedAt,
        })
        queryClient.setQueryData(sessionWorkspaceQueryKeys.settings(input.sessionId), editor)
      } catch {
        // Keep the original failure visible; never resend an uncertain mutation.
      }
      return false
    } finally {
      settingsMutationPending.current = false
      setSavingSettings(false)
    }
  }

  return {
    catalog: catalogQuery.data,
    savePermission: saveAgentSetting,
    saveSpeed: saveAgentSetting,
    loading: catalogQuery.isFetching,
    loadingMoreProjectId,
    loadMoreErrors,
    creating,
    savingSettings,
    renamingSessionId,
    archivingSessionId,
    restoringSessionId,
    error: actionError ?? catalogQuery.error?.message,
    retry: () => {
      setActionError(undefined)
      void catalogQuery.refetch()
    },
    loadMore,
    prepareCreation,
    create,
    rename,
    archive,
    restore,
    loadSettings,
    saveSettings,
  }
}
