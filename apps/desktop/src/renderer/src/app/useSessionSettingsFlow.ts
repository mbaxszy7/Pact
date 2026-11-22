import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import type {
  AppInfo,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  ProjectCatalogState,
  RuntimeAgentId,
  RuntimePreparation,
  SessionSettingsEditorState,
} from '@pact/contracts'

import type { SettingsPage } from '../components/workspace/SettingsNavigation'
import type { SessionWorkspaceFlow } from '../components/workspace/useSessionWorkspace'

import { useDefaultSessionSettings } from '../components/settings/session/useDefaultSessionSettings'
import { sessionScope } from '../components/workspace/session-catalog-cache'
import { foundationQueryKeys, projectCatalogQueryKeys, unwrapRpcResult } from '../query-client'

export interface RuntimePreparationFlow {
  appInfo: AppInfo | undefined
  preparation: RuntimePreparation | undefined
  loading: boolean
  preparationError: string | undefined
  readyAgentSet: Set<RuntimeAgentId>
  isRuntimePreparationOpen: boolean
  setIsRuntimePreparationOpen: React.Dispatch<React.SetStateAction<boolean>>
  showFirstUseDefaults: boolean
  setShowFirstUseDefaults: React.Dispatch<React.SetStateAction<boolean>>
  choosingAgent: RuntimeAgentId | undefined
  chooseRuntimeExecutable: (agentId: RuntimeAgentId) => Promise<void>
  refetchRuntimePreparation: () => Promise<unknown>
  defaultSessionSettings: ReturnType<typeof useDefaultSessionSettings>
  saveDefaultSessionSettings: (nextSettings: DefaultSessionSettings) => Promise<void>
}

export function useRuntimePreparationFlow({
  documentVisible,
  settingsPage,
}: {
  documentVisible: boolean
  settingsPage: SettingsPage
}): RuntimePreparationFlow {
  const queryClient = useQueryClient()
  const [isRuntimePreparationOpen, setIsRuntimePreparationOpen] = useState(false)
  const [showFirstUseDefaults, setShowFirstUseDefaults] = useState(false)
  const [choosingAgent, setChoosingAgent] = useState<RuntimeAgentId | undefined>()
  const forceNextRuntimeRefreshRef = useRef(false)

  const appInfoQuery = useQuery({
    queryKey: foundationQueryKeys.appInfo,
    queryFn: async () => unwrapRpcResult(await window.pact.getAppInfo()),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const runtimePreparationQuery = useQuery({
    queryKey: foundationQueryKeys.runtimePreparation,
    queryFn: async () => {
      const forceRefresh = forceNextRuntimeRefreshRef.current
      forceNextRuntimeRefreshRef.current = false
      return unwrapRpcResult(
        forceRefresh
          ? await window.pact.getRuntimePreparation({ forceRefresh: true })
          : await window.pact.getRuntimePreparation(),
      )
    },
    retry: 0,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: documentVisible ? 60_000 : false,
  })

  const defaultSessionSettings = useDefaultSessionSettings(
    showFirstUseDefaults || settingsPage === 'session-defaults',
  )

  const chooseRuntimeExecutable = async (agentId: RuntimeAgentId): Promise<void> => {
    if (choosingAgent) return
    setChoosingAgent(agentId)
    try {
      const result = await window.pact.chooseRuntimeExecutable(agentId)
      if (result.ok) {
        queryClient.setQueryData<RuntimePreparation>(
          foundationQueryKeys.runtimePreparation,
          result.value,
        )
      } else {
        await runtimePreparationQuery.refetch()
      }
    } finally {
      setChoosingAgent(undefined)
    }
  }

  const preparation = runtimePreparationQuery.data
  const readyAgentSet = new Set<RuntimeAgentId>(
    preparation?.agents.filter((agent) => agent.state === 'ready').map((agent) => agent.agentId) ??
      [],
  )
  const preparationError =
    runtimePreparationQuery.error instanceof Error
      ? runtimePreparationQuery.error.message
      : undefined

  const saveDefaultSessionSettings = async (
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    if (!(await defaultSessionSettings.save(nextSettings))) return
    if (preparation?.firstUse) {
      await runtimePreparationQuery.refetch()
      setShowFirstUseDefaults(false)
    }
  }

  return {
    appInfo: appInfoQuery.data,
    preparation,
    loading: runtimePreparationQuery.isFetching,
    preparationError,
    readyAgentSet,
    isRuntimePreparationOpen,
    setIsRuntimePreparationOpen,
    showFirstUseDefaults,
    setShowFirstUseDefaults,
    choosingAgent,
    chooseRuntimeExecutable,
    refetchRuntimePreparation: () => {
      forceNextRuntimeRefreshRef.current = true
      return runtimePreparationQuery.refetch()
    },
    defaultSessionSettings,
    saveDefaultSessionSettings,
  }
}

export interface SessionSettingsFlow {
  creatingProjectId: string | undefined
  creatingGroupId: string | undefined
  creationEditorState: DefaultSessionSettingsEditorState | undefined
  creationLoading: boolean
  sessionSettingsEditorState: SessionSettingsEditorState | undefined
  setSessionSettingsEditorState: React.Dispatch<
    React.SetStateAction<SessionSettingsEditorState | undefined>
  >
  sessionSettingsLoading: boolean
  sessionSettingsOpen: boolean
  sessionSettingsNavigationToken: number
  setSessionSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  startSessionCreation: (projectId: string, groupId?: string) => Promise<void>
  cancelSessionCreation: () => void
  createSession: (projectId: string, nextSettings: DefaultSessionSettings) => Promise<void>
  openSessionSettings: (sessionId: string) => Promise<void>
  saveSessionSettings: (sessionId: string, nextSettings: DefaultSessionSettings) => Promise<void>
  clearCreationState: () => void
  clearSessionSettingsState: () => void
}

export function useSessionSettingsFlow({
  sessionWorkspace,
  userSelectionEpochRef,
  beginUserSelection,
  requestSessionLocation,
  recordSessionOpened,
  setSelectedProjectId,
  setSelectedSessionId,
  setSettingsPage,
  setNativeAttentionOpen,
  onPrepareCreation,
  onPrepareSessionSettings,
}: {
  sessionWorkspace: SessionWorkspaceFlow
  userSelectionEpochRef: React.RefObject<number>
  beginUserSelection: () => number
  requestSessionLocation: (projectId: string, sessionId: string) => void
  recordSessionOpened: (sessionId: string, openingId: string) => void
  setSelectedProjectId: React.Dispatch<React.SetStateAction<string | undefined>>
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | undefined>>
  setSettingsPage: React.Dispatch<React.SetStateAction<SettingsPage>>
  setNativeAttentionOpen: React.Dispatch<React.SetStateAction<boolean>>
  onPrepareCreation: () => void
  onPrepareSessionSettings: () => void
}): SessionSettingsFlow {
  const queryClient = useQueryClient()
  const [creatingProjectId, setCreatingProjectId] = useState<string | undefined>()
  const [creatingGroupId, setCreatingGroupId] = useState<string | undefined>()
  const [creationEditorState, setCreationEditorState] = useState<
    DefaultSessionSettingsEditorState | undefined
  >()
  const [creationLoading, setCreationLoading] = useState(false)
  const [sessionSettingsEditorState, setSessionSettingsEditorState] = useState<
    SessionSettingsEditorState | undefined
  >()
  const [sessionSettingsLoading, setSessionSettingsLoading] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  const [sessionSettingsNavigationToken, setSessionSettingsNavigationToken] = useState(0)

  const clearCreationState = (): void => {
    setCreatingProjectId(undefined)
    setCreatingGroupId(undefined)
    setCreationEditorState(undefined)
    setCreationLoading(false)
  }

  const clearSessionSettingsState = (): void => {
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
  }

  const startSessionCreation = async (projectId: string, groupId?: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    setNativeAttentionOpen(false)
    onPrepareCreation()
    setSettingsPage(null)
    setSelectedSessionId(undefined)
    setSelectedProjectId(projectId)
    setCreatingProjectId(projectId)
    setCreatingGroupId(groupId)
    setCreationEditorState(undefined)
    setSessionSettingsOpen(false)
    setCreationLoading(true)
    try {
      const prepared = await sessionWorkspace.prepareCreation(projectId)
      if (selectionEpoch === userSelectionEpochRef.current) setCreationEditorState(prepared)
    } finally {
      if (selectionEpoch === userSelectionEpochRef.current) setCreationLoading(false)
    }
  }

  const cancelSessionCreation = (): void => {
    beginUserSelection()
    setCreatingProjectId(undefined)
    setCreatingGroupId(undefined)
    setCreationEditorState(undefined)
  }

  const createSession = async (
    projectId: string,
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    const openingId = crypto.randomUUID()
    const created = await sessionWorkspace.create(projectId, nextSettings, creatingGroupId)
    if (!created || created.status === 'archived') return
    const currentProjects = queryClient.getQueryData<ProjectCatalogState>(
      projectCatalogQueryKeys.catalog,
    )
    if (!currentProjects?.projects.some((project) => project.id === projectId)) return
    if (selectionEpoch !== userSelectionEpochRef.current) {
      void sessionWorkspace
        .loadPage({ projectId, scope: sessionScope(created) })
        .catch(() => undefined)
      return
    }
    setCreatingProjectId(undefined)
    setCreatingGroupId(undefined)
    setCreationEditorState(undefined)
    onPrepareCreation()
    setSelectedProjectId(projectId)
    sessionWorkspace.retainSelected(created.id)
    setSelectedSessionId(created.id)
    requestSessionLocation(projectId, created.id)
    recordSessionOpened(created.id, openingId)
  }

  const openSessionSettings = async (sessionId: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    onPrepareSessionSettings()
    setSessionSettingsEditorState(undefined)
    setSessionSettingsLoading(true)
    setSessionSettingsOpen(true)
    setSessionSettingsNavigationToken((current) => current + 1)
    try {
      const editor = await sessionWorkspace.loadSettings(sessionId)
      if (selectionEpoch === userSelectionEpochRef.current) setSessionSettingsEditorState(editor)
    } finally {
      if (selectionEpoch === userSelectionEpochRef.current) setSessionSettingsLoading(false)
    }
  }

  const saveSessionSettings = async (
    sessionId: string,
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    const selectionEpoch = userSelectionEpochRef.current
    const editor = await sessionWorkspace.saveSettings(sessionId, nextSettings)
    if (editor && selectionEpoch === userSelectionEpochRef.current)
      setSessionSettingsEditorState(editor)
  }

  return {
    creatingProjectId,
    creatingGroupId,
    creationEditorState,
    creationLoading,
    sessionSettingsEditorState,
    setSessionSettingsEditorState,
    sessionSettingsLoading,
    sessionSettingsOpen,
    sessionSettingsNavigationToken,
    setSessionSettingsOpen,
    startSessionCreation,
    cancelSessionCreation,
    createSession,
    openSessionSettings,
    saveSessionSettings,
    clearCreationState,
    clearSessionSettingsState,
  }
}
