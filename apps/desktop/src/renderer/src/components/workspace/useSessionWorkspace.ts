import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  CollaborationSession,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  Project,
  RpcResult,
  SessionCatalogChange,
  SessionSettingsEditorState,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SessionGroupPage,
  SessionGroupPageInput,
  SessionGroupDetail,
  SessionGroupDetailInput,
  SessionMembership,
  SessionMembershipInput,
  SessionPage,
  SessionPageInput,
  LocateSessionNavigationInput,
  CreateSessionGroupInput,
  UpdateSessionGroupInput,
  MoveSessionGroupInput,
  DissolveSessionGroupInput,
  SetSessionGroupInput,
  SessionGroupMutation,
} from '@pact/contracts'

import { RpcError, sessionWorkspaceQueryKeys, unwrapRpcResult } from '../../query-client'
import {
  acceptSessionCatalogChange,
  applyGroupReceipt,
  boundNavigation,
  emptyNavigationCatalog,
  installNavigationPages,
  patchCatalogSession,
  scopeKey,
  UNGROUPED,
  type SessionCatalogCache,
} from './session-catalog-cache'

const MAX_CATALOG_PROJECTS = 1_000
const INITIAL_CATALOG_BATCH_ITEMS = 20
const INITIAL_CATALOG_BATCH_MS = 100
const INITIAL_CATALOG_DEADLINE_MS = 30_000
const LOAD_MORE_DEADLINE_MS = 10_000

type ReadPriority = 'startup' | 'visible' | 'explicit'
type QueuedRead = { run: () => void; cancel: () => void }

function navigationReader() {
  let active: { key: string; result: Promise<unknown> } | undefined
  let next: QueuedRead | undefined
  return {
    read<T>(key: string, priority: ReadPriority, read: () => Promise<T>): Promise<T | undefined> {
      // Identical keys are created by the same typed bridge operation.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      if (active?.key === key) return active.result as Promise<T>
      if (active && (priority === 'visible' || (next && priority === 'startup')))
        return Promise.resolve(undefined)
      if (active && next) next.cancel()
      return new Promise<T | undefined>((resolve, reject) => {
        const run = (): void => {
          const result = Promise.resolve().then(read)
          active = { key, result }
          void result.then(resolve, reject).finally(() => {
            active = undefined
            const queued = next
            next = undefined
            queued?.run()
          })
        }
        if (active) next = { run, cancel: () => resolve(undefined) }
        else run()
      })
    },
    cancel(): void {
      next?.cancel()
      next = undefined
    },
  }
}

const membership = async ({
  projectId,
  sessionId,
}: SessionMembershipInput): Promise<SessionMembership> =>
  unwrapRpcResult(await window.pact.getSessionMembership({ projectId, sessionId }))
const groupDetail = async (input: SessionGroupDetailInput): Promise<SessionGroupDetail> =>
  unwrapRpcResult(await window.pact.getSessionGroup(input))

export interface SessionWorkspaceFlow {
  savePermission(input: SessionPermissionSaveInput): Promise<boolean>
  saveSpeed(input: SessionSpeedSaveInput): Promise<boolean>
  catalog: SessionCatalogCache | undefined
  loading: boolean
  creating: boolean
  writingOrganization: boolean
  checkingWrite: boolean
  savingSettings: boolean
  renamingSessionId: string | undefined
  archivingSessionId: string | undefined
  restoringSessionId: string | undefined
  error: string | undefined
  retry(): void
  setVisibleWindows(keys: ReadonlySet<string>): void
  retainSelected(sessionId: string | undefined): void
  loadPage(input: SessionPageInput, automatic?: boolean): Promise<boolean>
  loadGroups(input: SessionGroupPageInput, automatic?: boolean): Promise<boolean>
  browseGroups(input: SessionGroupPageInput): Promise<SessionGroupPage>
  locate(input: LocateSessionNavigationInput, current?: () => boolean): Promise<boolean>
  createGroup(
    input: Omit<CreateSessionGroupInput, 'expectedRevision'>,
  ): Promise<SessionGroupMutation | undefined>
  updateGroup(
    input: Omit<UpdateSessionGroupInput, 'expectedRevision'>,
  ): Promise<SessionGroupMutation | undefined>
  moveGroup(
    input: Omit<MoveSessionGroupInput, 'expectedRevision'>,
  ): Promise<SessionGroupMutation | undefined>
  dissolveGroup(
    input: Omit<DissolveSessionGroupInput, 'expectedRevision'>,
  ): Promise<SessionGroupMutation | undefined>
  setGroup(
    input: Omit<SetSessionGroupInput, 'expectedRevision'>,
  ): Promise<SessionGroupMutation | undefined>
  prepareCreation(projectId: string): Promise<DefaultSessionSettingsEditorState | undefined>
  create(
    projectId: string,
    settings: DefaultSessionSettings,
    groupId?: string,
  ): Promise<CollaborationSession | undefined>
  rename(sessionId: string, title: string): Promise<boolean>
  archive(sessionId: string, operationId?: string): Promise<boolean>
  restore(sessionId: string): Promise<CollaborationSession | undefined>
  setSidebarHidden(sessionId: string, hidden: boolean): Promise<CollaborationSession>
  loadSettings(sessionId: string): Promise<SessionSettingsEditorState | undefined>
  saveSettings(
    sessionId: string,
    settings: DefaultSessionSettings,
  ): Promise<SessionSettingsEditorState | undefined>
}

export function useSessionWorkspace(
  enabled: boolean,
  projects: Project[] | undefined,
  onUtilityRecovered: () => void,
): SessionWorkspaceFlow {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const settingsMutationPending = useRef(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | undefined>()
  const [archivingSessionId, setArchivingSessionId] = useState<string | undefined>()
  const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [writingOrganization, setWritingOrganization] = useState(false)
  const [checkingWrite, setCheckingWrite] = useState(false)
  const [reader] = useState(navigationReader)
  const visible = useRef<ReadonlySet<string>>(new Set())
  const writePending = useRef(false)
  const checkWrite = useRef<(() => void) | undefined>(undefined)
  const projectSignatureRef = useRef<string | undefined>(undefined)
  const projectSignature = projects?.map((project) => project.id).join(':')
  const activeProjects = useRef(new Set<string>())
  useLayoutEffect(() => {
    activeProjects.current = new Set(projects?.map((project) => project.id))
  }, [projects])
  const getCache = () =>
    queryClient.getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
  const publish = (
    cache: SessionCatalogCache & { navigation: NonNullable<SessionCatalogCache['navigation']> },
    projectId?: string,
  ): SessionCatalogCache => {
    const next = boundNavigation(cache, visible.current, projectId)
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, next)
    return next
  }
  const catalogQuery = useQuery({
    queryKey: sessionWorkspaceQueryKeys.catalog,
    queryFn: async ({ signal }) => {
      if ((projects?.length ?? 0) > MAX_CATALOG_PROJECTS)
        throw new Error('Too many Projects to load.')
      const start = performance.now()
      const cached = getCache()
      const cache = cached?.navigation ? cached : emptyNavigationCatalog()
      const projectIds = new Set(projects?.map((project) => project.id))
      const known = Object.fromEntries(
        Object.entries(cache.navigation!.projects).filter(([id]) => projectIds.has(id)),
      )
      let snapshot = publish({
        ...cache,
        navigation: { ...cache.navigation!, projects: known },
      })
      const pending: { page: SessionPage }[] = []
      let publishedAt = start
      const flush = (): void => {
        if (!pending.length) return
        snapshot = publish(installNavigationPages(getCache(), pending.splice(0)))
        publishedAt = performance.now()
      }
      try {
        for (const project of projects ?? []) {
          if (signal.aborted) break
          if (known[project.id]?.windows.ungrouped) continue
          const input = { projectId: project.id, scope: UNGROUPED }
          let result: RpcResult<SessionPage> | undefined
          while (!signal.aborted && !result) {
            if (performance.now() - start >= INITIAL_CATALOG_DEADLINE_MS) {
              throw new Error('Session navigation loading timed out. Retry to continue.')
            }
            // The physical slot is shared with explicit requests during startup.
            // oxlint-disable-next-line eslint/no-await-in-loop
            result = await reader.read(JSON.stringify(input), 'startup', () =>
              window.pact.getSessionPage(input),
            )
            if (!result && !signal.aborted) {
              // One queued explicit read may briefly own admission.
              // oxlint-disable-next-line eslint/no-await-in-loop
              await new Promise<void>((resolve) => window.setTimeout(resolve, 16))
            }
          }
          if (signal.aborted || !result) break
          if (performance.now() - start >= INITIAL_CATALOG_DEADLINE_MS)
            throw new Error('Session navigation loading timed out. Retry to continue.')
          pending.push({ page: unwrapRpcResult(result) })
          if (
            pending.length >= INITIAL_CATALOG_BATCH_ITEMS ||
            performance.now() - publishedAt >= INITIAL_CATALOG_BATCH_MS
          )
            flush()
        }
      } finally {
        if (!signal.aborted) flush()
      }
      return getCache() ?? snapshot
    },
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

  useEffect(() => () => reader.cancel(), [reader])

  const readPage = async <T>(
    input: { projectId: string },
    priority: ReadPriority,
    key: string,
    read: () => Promise<RpcResult<T>>,
  ): Promise<T | undefined> => {
    if (!activeProjects.current.has(input.projectId)) return undefined
    const value = await reader.read(key, priority, read)
    if (!value || !activeProjects.current.has(input.projectId)) return undefined
    return unwrapRpcResult(value)
  }

  const loadPage = async (input: SessionPageInput, automatic = false): Promise<boolean> => {
    let request = input
    const deadline = performance.now() + LOAD_MORE_DEADLINE_MS
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const page = await readPage(
          request,
          automatic ? 'visible' : 'explicit',
          JSON.stringify(request),
          () => window.pact.getSessionPage(request),
        )
        if (!page) return false
        if (performance.now() >= deadline) throw new Error('Loading Sessions timed out.')
        const current = getCache()
        const existing = current?.navigation?.projects[input.projectId]
        if (existing && existing.revision > page.groupRevision)
          throw new RpcError({ code: 'CONFLICT', message: 'Session groups changed while loading.' })
        publish(
          installNavigationPages(current, [{ page, direction: request.cursor?.direction }]),
          input.projectId,
        )
        return true
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== 'CONFLICT' || attempt === 2) throw error
        request = { projectId: input.projectId, scope: input.scope }
      }
    }
    return false
  }

  const loadGroups = async (input: SessionGroupPageInput, automatic = false): Promise<boolean> => {
    let request = input
    const deadline = performance.now() + LOAD_MORE_DEADLINE_MS
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const groups = await readPage(
          request,
          automatic ? 'visible' : 'explicit',
          JSON.stringify({ groups: request }),
          () => window.pact.getSessionGroups(request),
        )
        if (!groups) return false
        if (performance.now() >= deadline) throw new Error('Loading groups timed out.')
        const current = getCache()
        const project = current?.navigation?.projects[input.projectId]
        if (project && project.revision > groups.revision)
          throw new RpcError({ code: 'CONFLICT', message: 'Session groups changed while loading.' })
        publish(installNavigationPages(current, [], groups), input.projectId)
        return true
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== 'CONFLICT' || attempt === 2) throw error
        request = { projectId: input.projectId }
      }
    }
    return false
  }

  const locate = async (
    input: LocateSessionNavigationInput,
    current = () => true,
  ): Promise<boolean> => {
    const deadline = performance.now() + LOAD_MORE_DEADLINE_MS
    for (let attempt = 0; attempt <= 2; attempt++) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const located = await readPage(input, 'explicit', JSON.stringify({ locate: input }), () =>
        window.pact.locateSessionNavigation(input),
      )
      if (!current()) return false
      if (
        !located ||
        !located.membership.exists ||
        located.membership.archived ||
        !located.sessions.some((session) => session.id === input.sessionId)
      )
        throw new Error('The Session could not be located.')
      if (performance.now() >= deadline) throw new Error('Locating the Session timed out.')
      const cache = getCache()
      const project = cache?.navigation?.projects[input.projectId]
      const { groupId, revision } = located.membership
      const scope = groupId ? ({ kind: 'group', groupId } as const) : UNGROUPED
      if (
        (project && project.revision > revision) ||
        (project?.windows[scopeKey(scope)]?.revision ?? -1) > located.catalogRevision
      )
        continue
      publish(
        installNavigationPages(
          cache,
          [
            {
              page: {
                kind: 'page',
                projectId: input.projectId,
                scope,
                groupRevision: revision,
                revision: located.catalogRevision,
                sessions: located.sessions,
                hasGroups: located.hasGroups,
                nextCursor: located.nextCursor,
                previousCursor: located.previousCursor,
              },
            },
          ],
          groupId
            ? {
                kind: 'groups',
                projectId: input.projectId,
                revision,
                groups: located.groups,
                nextCursor: located.nextGroupCursor,
                previousCursor: located.previousGroupCursor,
              }
            : undefined,
        ),
        input.projectId,
      )
      return true
    }
    throw new Error('The Session changed while locating it. Try again.')
  }

  const retainSelected = (sessionId: string | undefined): void => {
    const cache = getCache()
    if (!cache || cache.navigation?.selectedId === sessionId) return
    const navigation = cache.navigation ?? emptyNavigationCatalog().navigation
    queryClient.setQueryData(sessionWorkspaceQueryKeys.catalog, {
      ...cache,
      navigation: { ...navigation, selectedId: sessionId },
    })
  }

  const waitForReadback = <T>(readback: () => Promise<T | undefined>): Promise<T> =>
    new Promise<T>((resolve) => {
      let checking = false
      let recoverRuntime = false
      const check = (): void => {
        if (checking) return
        checking = true
        const inspect = async (): Promise<T | undefined> => {
          if (recoverRuntime) {
            unwrapRpcResult(await window.pact.recoverSessionOrganization())
            onUtilityRecovered()
          }
          recoverRuntime = false
          return readback()
        }
        void inspect()
          .then(
            (value) => {
              if (value === undefined) {
                setCheckingWrite(true)
                setActionError(
                  'The save result is pending. Check the saved state before another change.',
                )
              } else {
                checkWrite.current = undefined
                setCheckingWrite(false)
                setActionError(undefined)
                resolve(value)
              }
              return undefined
            },
            (failure: unknown) => {
              setCheckingWrite(true)
              recoverRuntime = failure instanceof RpcError && failure.code === 'RUNTIME_UNAVAILABLE'
              setActionError(
                recoverRuntime
                  ? 'Pact’s local runtime stopped. Check saved state to recover it and inspect the write.'
                  : 'The save could not be confirmed. Check the saved state before another change.',
              )
            },
          )
          .finally(() => {
            checking = false
          })
      }
      checkWrite.current = check
      check()
    })

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
    groupId?: string,
  ): Promise<CollaborationSession | undefined> => {
    if (writePending.current) return undefined
    writePending.current = true
    setCreating(true)
    setActionError(undefined)
    const sessionId = crypto.randomUUID()
    try {
      const expectedGroupRevision = groupId
        ? getCache()?.navigation?.projects[projectId]?.revision
        : undefined
      if (groupId && expectedGroupRevision === undefined)
        throw new Error('Load the group before creating a Session.')
      const result = await window.pact.createSession({
        projectId,
        sessionId,
        settings,
        groupId,
        expectedGroupRevision,
      })
      let change: SessionCatalogChange
      if (result.ok) change = result.value
      else {
        if (result.error.code !== 'UNCERTAIN' && result.error.code !== 'CONFLICT')
          throw new RpcError(result.error)
        const state = await waitForReadback(async () => {
          const value = unwrapRpcResult(
            await window.pact.getSessionCreationState({ projectId, sessionId }),
          )
          return value.state === 'pending' ? undefined : value
        })
        if (state.state !== 'present') {
          if (groupId && result.error.code === 'CONFLICT')
            await loadGroups({ projectId, aroundGroupId: groupId }).catch(() => false)
          throw new RpcError(result.error)
        }
        if (state.session.id !== sessionId || state.session.projectId !== projectId)
          throw new Error('The saved Session does not match the requested identity.')
        change = {
          kind: 'change',
          revision: state.catalogRevision,
          groupRevision: state.revision,
          session: state.session,
        }
      }
      acceptSessionCatalogChange(queryClient, change)
      return change.session
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be created.')
      return undefined
    } finally {
      writePending.current = false
      setCreating(false)
    }
  }

  const writeGroup = async (
    projectId: string,
    send: (revision: number) => Promise<RpcResult<SessionGroupMutation>>,
    reconcile: (revision: number) => Promise<SessionGroupMutation | null | undefined>,
    reloadGroups = false,
  ): Promise<SessionGroupMutation | undefined> => {
    if (writePending.current) return undefined
    writePending.current = true
    setWritingOrganization(true)
    setActionError(undefined)
    try {
      let revision = getCache()?.navigation?.projects[projectId]?.revision
      if (revision === undefined) {
        await loadPage({ projectId, scope: UNGROUPED })
        revision = getCache()?.navigation?.projects[projectId]?.revision
      }
      if (revision === undefined) throw new Error('The Project’s organization is still loading.')
      const result = await send(revision)
      let change: SessionGroupMutation
      if (result.ok) change = result.value
      else if (result.error.code === 'UNCERTAIN') {
        const settled = await waitForReadback(() => reconcile(revision))
        if (!settled) {
          await loadGroups({ projectId })
          throw new RpcError(result.error)
        }
        change = settled
      } else {
        if (result.error.code === 'CONFLICT') await loadGroups({ projectId })
        throw new RpcError(result.error)
      }
      const cache = getCache()
      if (cache?.navigation && activeProjects.current.has(projectId)) {
        const next = applyGroupReceipt(
          { ...cache, navigation: cache.navigation },
          projectId,
          change,
          reloadGroups,
        )
        publish(next, projectId)
      }
      return change
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'The organization change could not be saved.',
      )
      return undefined
    } finally {
      writePending.current = false
      setWritingOrganization(false)
    }
  }

  const createGroup = (input: Omit<CreateSessionGroupInput, 'expectedRevision'>) =>
    writeGroup(
      input.projectId,
      (expectedRevision) => window.pact.createSessionGroup({ ...input, expectedRevision }),
      async () => {
        const detail = await groupDetail({ projectId: input.projectId, groupId: input.groupId })
        if (!detail.exists) return null
        const existing = input.sessionId
          ? getCache()?.sessions.find((session) => session.id === input.sessionId)
          : undefined
        const state = input.sessionId
          ? await membership({ projectId: input.projectId, sessionId: input.sessionId })
          : undefined
        if (state && (!state.exists || state.groupId !== input.groupId)) return null
        return {
          kind: 'group-change',
          revision: detail.revision,
          group: detail.group,
          ...(existing
            ? {
                session: { ...existing, groupId: input.groupId },
                sourceScope: UNGROUPED,
                targetScope: { kind: 'group', groupId: input.groupId } as const,
              }
            : {}),
        }
      },
      true,
    )

  const updateGroup = (input: Omit<UpdateSessionGroupInput, 'expectedRevision'>) =>
    writeGroup(
      input.projectId,
      (expectedRevision) => window.pact.updateSessionGroup({ ...input, expectedRevision }),
      async () => {
        const detail = await groupDetail({ projectId: input.projectId, groupId: input.groupId })
        if (
          !detail.exists ||
          (input.name !== undefined && detail.group.name !== input.name) ||
          (input.color !== undefined && detail.group.color !== input.color) ||
          (input.collapsed !== undefined && detail.group.collapsed !== input.collapsed)
        )
          return null
        return { kind: 'group-change', revision: detail.revision, group: detail.group }
      },
    )

  const moveGroup = (input: Omit<MoveSessionGroupInput, 'expectedRevision'>) => {
    let previous: number | undefined
    return writeGroup(
      input.projectId,
      async (expectedRevision) => {
        const page = getCache()?.navigation?.projects[input.projectId]?.groups
        previous = page?.groups.find((group) => group.id === input.groupId)?.position
        if (page?.revision !== expectedRevision || previous === undefined)
          return {
            ok: false,
            error: { code: 'CONFLICT', message: 'The group list changed. Try again.' },
          }
        return window.pact.moveSessionGroup({ ...input, expectedRevision })
      },
      async (revision) => {
        const detail = await groupDetail({ projectId: input.projectId, groupId: input.groupId })
        if (!detail.exists || detail.revision <= revision) return null
        if (
          input.targetGroupId &&
          (input.placement === 'before' ? detail.nextGroupId : detail.previousGroupId) !==
            input.targetGroupId
        )
          return null
        if (
          input.direction &&
          (previous === undefined ||
            detail.group.position !== previous + (input.direction === 'up' ? -1 : 1))
        )
          return null
        return { kind: 'group-change', revision: detail.revision, group: detail.group }
      },
      true,
    )
  }

  const dissolveGroup = (input: Omit<DissolveSessionGroupInput, 'expectedRevision'>) =>
    writeGroup(
      input.projectId,
      (expectedRevision) => window.pact.dissolveSessionGroup({ ...input, expectedRevision }),
      async () => {
        const detail = await groupDetail({ projectId: input.projectId, groupId: input.groupId })
        return detail.exists
          ? null
          : {
              kind: 'group-change',
              revision: detail.revision,
              dissolvedGroupId: input.groupId,
              sourceScope: { kind: 'group', groupId: input.groupId },
              targetScope: UNGROUPED,
            }
      },
      true,
    )

  const setGroup = (input: Omit<SetSessionGroupInput, 'expectedRevision'>) => {
    const previous = getCache()?.sessions.find((session) => session.id === input.sessionId)
    return writeGroup(
      input.projectId,
      (expectedRevision) => window.pact.setSessionGroup({ ...input, expectedRevision }),
      async () => {
        if (!previous) return null
        const sourceGroupId = previous.groupId
        const source =
          sourceGroupId && sourceGroupId !== input.groupId
            ? await groupDetail({ projectId: input.projectId, groupId: sourceGroupId })
            : undefined
        const state = await membership(input)
        if (!state.exists || state.groupId !== input.groupId) return null
        const placement = input.placement
        if (
          placement &&
          (placement.kind === 'first'
            ? state.groupPosition !== 0
            : (placement.kind === 'before' ? state.nextSessionId : state.previousSessionId) !==
              placement.sessionId)
        )
          return null
        if (source && source.revision !== state.revision) return undefined
        return {
          kind: 'group-change',
          revision: state.revision,
          dissolvedGroupId: source?.exists === false ? (sourceGroupId ?? undefined) : undefined,
          session: { ...previous, groupId: state.groupId },
          sourceScope: previous.groupId ? { kind: 'group', groupId: previous.groupId } : UNGROUPED,
          targetScope: state.groupId ? { kind: 'group', groupId: state.groupId } : UNGROUPED,
        }
      },
    )
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

  const restore = async (sessionId: string): Promise<CollaborationSession | undefined> => {
    if (restoringSessionId) return undefined
    setRestoringSessionId(sessionId)
    setActionError(undefined)
    try {
      const change = unwrapRpcResult(await window.pact.restoreSession(sessionId))
      acceptSessionCatalogChange(queryClient, change)
      return change.session
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be restored.')
      return undefined
    } finally {
      setRestoringSessionId(undefined)
    }
  }

  const setSidebarHidden = async (
    sessionId: string,
    hidden: boolean,
  ): Promise<CollaborationSession> => {
    if (writePending.current) throw new Error('Another Session organization change is pending.')
    writePending.current = true
    setWritingOrganization(true)
    const read = async (): Promise<SessionCatalogChange> =>
      unwrapRpcResult(await window.pact.resolveNativeSession({ sessionId }))
    const matches = (change: SessionCatalogChange): boolean =>
      change.session.id === sessionId && Boolean(change.session.sidebarHidden) === hidden
    try {
      // A fresh read also settles the previous attempt before the user can retry a write.
      let change = await read()
      if (change.session.id !== sessionId) throw new Error('The Session could not be verified.')
      const priorGroupId =
        change.session.groupId ??
        getCache()?.sessions.find((item) => item.id === sessionId)?.groupId
      if (!matches(change)) {
        const saved = await window.pact.setSessionSidebarHidden({ sessionId, hidden })
        if (!saved.ok && saved.error.code === 'UNCERTAIN') {
          change = await read()
          if (!matches(change)) throw new RpcError(saved.error)
        } else {
          change = unwrapRpcResult(saved)
        }
      }
      if (!matches(change)) throw new Error('The saved sidebar visibility could not be verified.')
      if (hidden && priorGroupId && !change.session.groupId && !change.dissolvedGroupId) {
        const prior = await groupDetail({
          projectId: change.session.projectId,
          groupId: priorGroupId,
        })
        if (prior.revision !== change.groupRevision)
          throw new Error('The saved Session group could not be verified.')
        if (!prior.exists) change = { ...change, dissolvedGroupId: priorGroupId }
      }
      acceptSessionCatalogChange(queryClient, change)
      return change.session
    } finally {
      writePending.current = false
      setWritingOrganization(false)
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
      const { primaryAgentId, agents, maxDiscussionRounds, maxReviewCycles, maxRepairAttempts } =
        settings
      const saved = unwrapRpcResult(
        await window.pact.saveSessionSettings({
          sessionId,
          settings: {
            primaryAgentId,
            agents,
            maxDiscussionRounds,
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
    creating,
    writingOrganization,
    checkingWrite,
    savingSettings,
    renamingSessionId,
    archivingSessionId,
    restoringSessionId,
    error: actionError ?? catalogQuery.error?.message,
    retry: () => {
      if (checkWrite.current) checkWrite.current()
      else {
        setActionError(undefined)
        void catalogQuery.refetch()
      }
    },
    setVisibleWindows: (keys) => {
      visible.current = keys
    },
    retainSelected,
    loadPage,
    loadGroups,
    browseGroups: async (input) => {
      try {
        const groups = await readPage(
          input,
          'explicit',
          JSON.stringify({ browseGroups: input }),
          () => window.pact.getSessionGroups(input),
        )
        if (groups) return groups
      } catch (error) {
        if (input.cursor && error instanceof RpcError && error.code === 'CONFLICT') {
          const fresh = { projectId: input.projectId }
          const groups = await readPage(
            fresh,
            'explicit',
            JSON.stringify({ browseGroups: fresh }),
            () => window.pact.getSessionGroups(fresh),
          )
          if (groups) return groups
        }
        throw error
      }
      throw new Error('The navigation reader is busy. Try again.')
    },
    locate,
    createGroup,
    updateGroup,
    moveGroup,
    dissolveGroup,
    setGroup,
    prepareCreation,
    create,
    rename,
    archive,
    restore,
    setSidebarHidden,
    loadSettings,
    saveSettings,
  }
}
