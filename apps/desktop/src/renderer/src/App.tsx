import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import type {
  AppearanceSettingsUpdate,
  AppearanceSnapshot,
  AppearanceTheme,
  AnchoredComment,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  NativeNavigationIntent,
  NativeQuitState,
  ProjectCatalogState,
  RuntimeAgentId,
  RuntimePreparation,
  SessionSettingsEditorState,
  SessionCatalogChange,
  WindowMaterial,
  SkillSelection,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
} from '@pact/contracts'

import {
  MATERIAL_OPACITY_MAX,
  MATERIAL_OPACITY_MIN,
  NATIVE_METADATA_TIMEOUT_MS,
  NATIVE_RECENT_CANDIDATES,
} from '@pact/contracts'

import type { ProjectFileTarget } from './components/conversation/MessageMarkdown'
import type { SkillDocumentPanelState } from './components/conversation/SkillDocumentPanel'
import type { ProjectFilePanelState } from './components/project-file/ProjectFilePanel'
import type { WorkspaceChangesPanelState } from './components/project-file/WorkspaceChangesPanel'
import type { SessionCatalogCache } from './components/workspace/session-catalog-cache'
import type { SettingsPage } from './components/workspace/SettingsNavigation'

import {
  commentDraftSaveSucceeded,
  useConversation,
} from './components/conversation/useConversation'
import { NativeAttentionView } from './components/native-presence/NativeAttentionView'
import { NativeQuitConfirmation } from './components/native-presence/NativeQuitConfirmation'
import {
  RuntimeDegradedNotice,
  RuntimePreparationView,
} from './components/runtime-preparation/RuntimePreparationView'
import { AppearanceSettingsView } from './components/settings/appearance/AppearanceSettingsView'
import {
  DefaultSessionOnboardingView,
  DefaultSessionSettingsView,
} from './components/settings/session/DefaultSessionSettingsView'
import { useDefaultSessionSettings } from './components/settings/session/useDefaultSessionSettings'
import { AboutUpdatesView } from './components/settings/updates/AboutUpdatesView'
import { useAppUpdates } from './components/settings/updates/useAppUpdates'
import { APP_TOAST_DURATION_MS, AppToast, type AppToastTone } from './components/workspace/AppToast'
import { ArchiveConfirmation } from './components/workspace/ArchiveConfirmation'
import {
  ARCHIVE_RESULT_LIMIT,
  ArchiveNotice,
  type ArchiveAction,
  type ArchivedItem,
  type ArchiveResult,
} from './components/workspace/ArchiveNotice'
import { acceptSessionCatalogChange } from './components/workspace/session-catalog-cache'
import { useProjectCatalog } from './components/workspace/useProjectCatalog'
import { useSessionWorkspace } from './components/workspace/useSessionWorkspace'
import { WorkspaceView } from './components/workspace/WorkspaceView'
import {
  appearanceQueryKeys,
  foundationQueryKeys,
  projectCatalogQueryKeys,
  sessionWorkspaceQueryKeys,
  unwrapRpcResult,
} from './query-client'

function archiveItem(item: WorkspaceArchivePreview): ArchivedItem {
  return item.scope.kind === 'session'
    ? { kind: 'session', id: item.scope.sessionId, title: item.title, projectId: item.projectId }
    : { kind: 'project', id: item.scope.projectId, title: item.title }
}

interface NativeSessionOpening {
  sessionId: string
  openingId: string
  selectionEpoch: number
  deadline: number
}

interface NativeOpeningQueue {
  active: boolean
  inFlight?: NativeSessionOpening | undefined
  pending: NativeSessionOpening[]
}

function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(null)
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const updateVisibility = (): void => setDocumentVisible(!document.hidden)
    const refreshRuntime = (): void => {
      if (document.hidden) return
      void queryClient.refetchQueries(
        { queryKey: foundationQueryKeys.runtimePreparation, exact: true },
        { cancelRefetch: false },
      )
    }
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('focus', refreshRuntime)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('focus', refreshRuntime)
    }
  }, [queryClient])
  const [preview, setPreview] = useState<Omit<AppearanceSettingsUpdate, 'expectedRevision'> | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [isRuntimePreparationOpen, setIsRuntimePreparationOpen] = useState(false)
  const [showFirstUseDefaults, setShowFirstUseDefaults] = useState(false)
  const [choosingAgent, setChoosingAgent] = useState<RuntimeAgentId | undefined>()
  const [saveError, setSaveError] = useState<string | undefined>()
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>()
  const [nativeAttentionOpen, setNativeAttentionOpen] = useState(false)
  const [nativeQuitState, setNativeQuitState] = useState<NativeQuitState | null>(null)
  const userSelectionEpoch = useRef(0)
  const nativeNavigationRequest = useRef(0)
  const nativeNavigationIntent = useRef<NativeNavigationIntent | undefined>(undefined)
  const acknowledgedNativeNavigation = useRef<string | undefined>(undefined)
  const nativeQuitFocus = useRef<HTMLElement | undefined>(undefined)
  const nativeQuitOperation = useRef<string | undefined>(undefined)
  const nativeOpeningQueue = useRef<NativeOpeningQueue>({ active: true, pending: [] })
  const [todoNavigation, setTodoNavigation] = useState<{
    sessionId: string
    taskId: string
    todoId: string
    todoRevision: number
    navigationId: string
    selection?: import('@pact/contracts').TodoCommentAnchor['selection']
  }>()
  const [messageNavigation, setMessageNavigation] = useState<
    | {
        sessionId: string
        navigationId: string
        messageId: string
        startOffset: number
        endOffset: number
        textBasis?: import('@pact/contracts').MessageCommentAnchor['textBasis']
        plan?: import('@pact/contracts').MessageCommentAnchor['plan']
        report?: import('@pact/contracts').MessageCommentAnchor['report']
      }
    | undefined
  >()
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const [creatingProjectId, setCreatingProjectId] = useState<string | undefined>()
  const [creationEditorState, setCreationEditorState] = useState<
    DefaultSessionSettingsEditorState | undefined
  >()
  const [creationLoading, setCreationLoading] = useState(false)
  const [sessionSettingsEditorState, setSessionSettingsEditorState] = useState<
    SessionSettingsEditorState | undefined
  >()
  const [sessionSettingsLoading, setSessionSettingsLoading] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  const [projectFilePanel, setProjectFilePanel] = useState<ProjectFilePanelState | undefined>()
  const [workspaceChangesPanel, setWorkspaceChangesPanel] = useState<WorkspaceChangesPanelState>()
  const [projectFilePanelExpanded, setProjectFilePanelExpanded] = useState(false)
  const [archiveResults, setArchiveResults] = useState<ArchiveResult[]>([])
  const archiveResultsRef = useRef<ArchiveResult[]>([])
  const [archiveAction, setArchiveAction] = useState<ArchiveAction>()
  const [archiveResultId, setArchiveResultId] = useState<string>()
  const [archivePreview, setArchivePreview] = useState<WorkspaceArchivePreview>()
  const [archiveReceipt, setArchiveReceipt] = useState<WorkspaceArchiveReceipt>()
  const [archiveError, setArchiveError] = useState<string>()
  const [archiveStopping, setArchiveStopping] = useState(false)
  const archiveBusyRef = useRef(false)
  const archiveStoppingRef = useRef(false)
  const [toast, setToast] = useState<
    { id: number; message: string; tone: AppToastTone } | undefined
  >()
  const savingRef = useRef(false)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const pendingOpacityRef = useRef<number | undefined>(undefined)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const projectFileRequestRef = useRef(0)
  const skillDocumentRequest = useRef<string | undefined>(undefined)
  const [skillDocumentPanel, setSkillDocumentPanel] = useState<SkillDocumentPanelState>()
  const invalidateContextRead = (): number => {
    const request = skillDocumentRequest.current
    skillDocumentRequest.current = undefined
    if (request) void window.pact.cancelSkillDocument(request).catch(() => undefined)
    setSkillDocumentPanel(undefined)
    return ++projectFileRequestRef.current
  }
  useEffect(
    () => () => {
      if (skillDocumentRequest.current)
        void window.pact.cancelSkillDocument(skillDocumentRequest.current).catch(() => undefined)
    },
    [],
  )
  const appInfoQuery = useQuery({
    queryKey: foundationQueryKeys.appInfo,
    queryFn: async () => unwrapRpcResult(await window.pact.getAppInfo()),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const runtimePreparationQuery = useQuery({
    queryKey: foundationQueryKeys.runtimePreparation,
    queryFn: async () => unwrapRpcResult(await window.pact.getRuntimePreparation()),
    retry: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: documentVisible ? 60_000 : false,
  })
  const defaultSessionSettings = useDefaultSessionSettings(
    showFirstUseDefaults || settingsPage === 'session-defaults',
  )
  const projectCatalog = useProjectCatalog(runtimePreparationQuery.data?.firstUse === false)
  const sessionWorkspace = useSessionWorkspace(
    runtimePreparationQuery.data?.firstUse === false,
    projectCatalog.catalog?.projects,
  )
  const showToast = useCallback((message: string, tone: AppToastTone = 'info'): void => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToast({ id: Date.now(), message, tone })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = undefined
      setToast(undefined)
    }, APP_TOAST_DURATION_MS[tone])
  }, [])
  const showWarning = useCallback(
    (message: string): void => showToast(message, 'warning'),
    [showToast],
  )
  const showError = useCallback((message: string): void => showToast(message, 'error'), [showToast])
  const dismissToast = useCallback((): void => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = undefined
    setToast(undefined)
  }, [])
  const acknowledgeNativeNavigation = useCallback((navigationId: string): void => {
    if (nativeNavigationIntent.current?.navigationId !== navigationId) return
    nativeNavigationIntent.current = undefined
    acknowledgedNativeNavigation.current = navigationId
    // ACK is bounded to the current intent. An uncertain ACK is not retried:
    // its stable opening ID also prevents a later redelivery from reordering MRU.
    void window.pact.acknowledgeNativeNavigation({ navigationId }).catch(() => undefined)
  }, [])
  const beginUserSelection = useCallback((): number => {
    nativeNavigationRequest.current++
    const intent = nativeNavigationIntent.current
    if (intent) acknowledgeNativeNavigation(intent.navigationId)
    return ++userSelectionEpoch.current
  }, [acknowledgeNativeNavigation])
  const recordSessionOpened = useCallback(
    (sessionId: string, openingId: string): void => {
      const owner = nativeOpeningQueue.current
      if (!owner.active || owner.inFlight?.openingId === openingId) return
      if (owner.pending.some((item) => item.openingId === openingId)) return
      // Only the latest uncommitted visit to the same Session is needed. The
      // durable Utility receipt, rather than this queue, owns saved MRU order.
      owner.pending = owner.pending.filter((item) => item.sessionId !== sessionId)
      if (owner.pending.length >= NATIVE_RECENT_CANDIDATES) {
        showWarning('This Session was not added to your recent list. You can keep reading it.')
        return
      }
      owner.pending.push({
        sessionId,
        openingId,
        selectionEpoch: userSelectionEpoch.current,
        deadline: performance.now() + NATIVE_METADATA_TIMEOUT_MS,
      })
      owner.pending.sort((left, right) => left.selectionEpoch - right.selectionEpoch)
      const drain = (): void => {
        if (!owner.active) {
          owner.pending = []
          return
        }
        if (owner.inFlight) return
        const next = owner.pending.shift()
        if (!next) return
        if (performance.now() >= next.deadline) {
          showWarning(
            'A Session was not added to your recent list. Open it again to update the list.',
          )
          drain()
          return
        }
        owner.inFlight = next
        void window.pact
          .recordNativeSessionOpened({ sessionId: next.sessionId, openingId: next.openingId })
          .then((result) => {
            if (owner.active && !result.ok)
              showWarning('Could not confirm the recent Session list. Your Session is still open.')
            return undefined
          })
          .catch(() => {
            if (owner.active)
              showWarning('Could not confirm the recent Session list. Your Session is still open.')
          })
          .finally(() => {
            owner.inFlight = undefined
            drain()
          })
      }
      drain()
    },
    [showWarning],
  )
  useEffect(() => {
    const owner = nativeOpeningQueue.current
    owner.active = true
    return () => {
      owner.active = false
      owner.pending = []
    }
  }, [])
  useEffect(
    () => () => {
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    },
    [],
  )
  useEffect(() => {
    let active = true
    let notified = false
    const receive = (status: import('@pact/contracts').DiagnosticStatus): void => {
      if (active && !notified && status.state === 'unavailable') {
        notified = true
        showWarning('Logs could not be saved. You can continue using Pact.')
      }
    }
    const remove = window.pact.onDiagnosticStatusChanged?.(receive)
    void window.pact
      .getDiagnosticStatus?.()
      .then(receive)
      .catch(() => undefined)
    const onError = (): void => window.pact.reportRendererFault?.('error')
    const onRejection = (): void => window.pact.reportRendererFault?.('rejection')
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      active = false
      remove?.()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [showWarning])
  const conversationVisible =
    documentVisible &&
    !settingsPage &&
    !creatingProjectId &&
    !nativeAttentionOpen &&
    !nativeQuitState &&
    !isRuntimePreparationOpen &&
    !showFirstUseDefaults
  const conversation = useConversation(
    selectedSessionId,
    showWarning,
    conversationVisible,
    showError,
    showToast,
  )
  const selectedChangesRevision =
    workspaceChangesPanel &&
    conversation.snapshot &&
    workspaceChangesPanel.sessionId === selectedSessionId &&
    conversation.snapshot.sessionId === selectedSessionId
      ? conversation.snapshot.runs.find(
          (run) => run.workspaceChanges?.id === workspaceChangesPanel?.changeSetId,
        )?.workspaceChanges?.revision
      : undefined
  useEffect(() => {
    if (selectedChangesRevision === undefined) return
    setWorkspaceChangesPanel((current) =>
      current &&
      current.sessionId === selectedSessionId &&
      current.changeSetId === workspaceChangesPanel?.changeSetId &&
      selectedChangesRevision > (current.revision ?? 0)
        ? { ...current, revision: selectedChangesRevision }
        : current,
    )
  }, [selectedChangesRevision, selectedSessionId, workspaceChangesPanel?.changeSetId])
  const appearanceQuery = useQuery({
    queryKey: appearanceQueryKeys.settings,
    queryFn: async () => {
      const loaded = unwrapRpcResult(await window.pact.getAppearanceSettings())
      const published = queryClient.getQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings)
      return published && published.requested.revision > loaded.requested.revision
        ? published
        : loaded
    },
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    return window.pact.onAppearanceSettingsChanged((snapshot) => {
      queryClient.setQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings, (previous) =>
        !previous ||
        snapshot.requested.revision > previous.requested.revision ||
        (snapshot.requested.revision === previous.requested.revision &&
          snapshot.projectionVersion > previous.projectionVersion)
          ? snapshot
          : previous,
      )
    })
  }, [queryClient])

  const snapshot = appearanceQuery.data
  const settings = snapshot?.requested
    ? {
        ...snapshot.requested,
        theme: preview?.theme ?? snapshot.requested.theme,
        windowMaterial: preview?.windowMaterial ?? snapshot.requested.windowMaterial,
        materialOpacity: preview?.materialOpacity ?? snapshot.requested.materialOpacity,
      }
    : undefined

  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  useEffect(() => {
    const root = document.documentElement
    const material = snapshot?.effective.windowMaterial ?? 'solid'
    root.dataset.material = material
    const opacity = settings?.materialOpacity ?? 85
    const coverage =
      (opacity - MATERIAL_OPACITY_MIN) / (MATERIAL_OPACITY_MAX - MATERIAL_OPACITY_MIN)
    const alpha = (minimum: number, maximum: number): string =>
      `${Math.round((minimum + coverage * (maximum - minimum)) * 1000) / 1000}`
    root.style.setProperty('--pact-material-navigation-alpha', alpha(0.55, 0.9))
    root.style.setProperty('--pact-material-chat-alpha', alpha(0.72, 0.97))
    root.style.setProperty('--pact-material-code-alpha', alpha(0.94, 0.99))
    root.style.setProperty('--pact-material-message-alpha', alpha(0.86, 0.96))
  }, [settings?.materialOpacity, snapshot?.effective.windowMaterial])

  const acceptSnapshot = (next: AppearanceSnapshot): void => {
    queryClient.setQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings, (previous) =>
      !previous ||
      next.requested.revision > previous.requested.revision ||
      (next.requested.revision === previous.requested.revision &&
        next.projectionVersion > previous.projectionVersion)
        ? next
        : previous,
    )
  }

  const save = async (
    kind: 'update' | 'reset',
    update?: Omit<AppearanceSettingsUpdate, 'expectedRevision'>,
  ): Promise<void> => {
    const committedSnapshot =
      queryClient.getQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings) ?? snapshot
    if (!committedSnapshot || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(undefined)
    setPreview(
      kind === 'reset'
        ? { theme: 'system', windowMaterial: 'system', materialOpacity: 85 }
        : (update ?? null),
    )

    try {
      const result =
        kind === 'reset'
          ? await window.pact.resetAppearanceSettings({
              expectedRevision: committedSnapshot.requested.revision,
            })
          : await window.pact.updateAppearanceSettings({
              expectedRevision: committedSnapshot.requested.revision,
              ...update,
            })

      if (result.ok) {
        acceptSnapshot(result.value)
      } else {
        if (result.error.code === 'UNCERTAIN') {
          setSaveError('Couldn’t confirm the change. Checking the saved setting.')
        } else if (result.error.code === 'CONFLICT') {
          setSaveError('Appearance changed in another window. Showing the latest setting.')
        } else {
          setSaveError('Couldn’t save. Your previous setting has been restored.')
        }
        await appearanceQuery.refetch()
      }
    } catch {
      setSaveError('Couldn’t connect. Your previous setting is still in use.')
      await appearanceQuery.refetch()
    } finally {
      setPreview(null)
      setSaving(false)
      savingRef.current = false
      const pendingOpacity = pendingOpacityRef.current
      pendingOpacityRef.current = undefined
      if (pendingOpacity !== undefined) void save('update', { materialOpacity: pendingOpacity })
    }
  }

  const saveMaterialOpacity = (materialOpacity: number): void => {
    if (savingRef.current) {
      pendingOpacityRef.current = materialOpacity
      return
    }
    void save('update', { materialOpacity })
  }

  const updates = useAppUpdates(
    () => {
      setNativeAttentionOpen(false)
      setSettingsPage('updates')
    },
    showToast,
    !toast && !nativeQuitState && runtimePreparationQuery.data?.firstUse === false,
  )
  const aboutUpdatesView = (
    <AboutUpdatesView
      appInfo={appInfoQuery.data}
      state={updates.state}
      busy={updates.busy}
      error={updates.error}
      onCheck={() => void updates.check()}
      onRetry={() => void updates.retry()}
      onAutoCheckChange={(value) => void updates.setAutoCheck(value)}
    />
  )
  const appInfo = appInfoQuery.data
  const showWorkspace = (): void => {
    beginUserSelection()
    setNativeAttentionOpen(false)
    setSettingsPage(null)
  }
  const backToWorkspace = (): void => {
    showWorkspace()
    window.requestAnimationFrame(() => {
      const restoredContext = document.querySelector<HTMLDialogElement>(
        '.workspace-context-dialog[open]',
      )
      if (restoredContext) restoredContext.focus({ preventScroll: true })
      else settingsButtonRef.current?.focus({ preventScroll: true })
    })
  }

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
  const allAgentsReady = preparation?.agents.every((agent) => agent.state === 'ready') ?? false
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

  const startSessionCreation = async (projectId: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    setNativeAttentionOpen(false)
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setSettingsPage(null)
    setSelectedSessionId(undefined)
    setSelectedProjectId(projectId)
    setCreatingProjectId(projectId)
    setCreationEditorState(undefined)
    setSessionSettingsOpen(false)
    setProjectFilePanel(undefined)
    setProjectFilePanelExpanded(false)
    setCreationLoading(true)
    try {
      const prepared = await sessionWorkspace.prepareCreation(projectId)
      if (selectionEpoch === userSelectionEpoch.current) setCreationEditorState(prepared)
    } finally {
      if (selectionEpoch === userSelectionEpoch.current) setCreationLoading(false)
    }
  }

  const createSession = async (
    projectId: string,
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    const openingId = crypto.randomUUID()
    const created = await sessionWorkspace.create(projectId, nextSettings)
    if (!created || selectionEpoch !== userSelectionEpoch.current) return
    setCreatingProjectId(undefined)
    setCreationEditorState(undefined)
    setSelectedProjectId(projectId)
    setSelectedSessionId(created.id)
    recordSessionOpened(created.id, openingId)
  }

  const selectSession = (
    sessionId: string,
    options?: { projectId?: string; openingId?: string; native?: boolean },
  ): void => {
    if (!options?.native) beginUserSelection()
    setNativeAttentionOpen(false)
    setWorkspaceChangesPanel(undefined)
    invalidateContextRead()
    setSettingsPage(null)
    setCreatingProjectId(undefined)
    setCreationEditorState(undefined)
    setCreationLoading(false)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setProjectFilePanel(undefined)
    setProjectFilePanelExpanded(false)
    const session = sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId)
    setSelectedProjectId(options?.projectId ?? session?.projectId)
    setSelectedSessionId(sessionId)
    setMessageNavigation(undefined)
    recordSessionOpened(sessionId, options?.openingId ?? crypto.randomUUID())
  }

  const enterResolvedSession = (change: SessionCatalogChange, openingId: string): void => {
    acceptSessionCatalogChange(queryClient, change)
    const accepted = queryClient
      .getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
      ?.sessions.find((session) => session.id === change.session.id)
    const projects = queryClient.getQueryData<ProjectCatalogState>(projectCatalogQueryKeys.catalog)
    if (
      !accepted ||
      accepted.status === 'archived' ||
      (projects && !projects.projects.some((project) => project.id === accepted.projectId))
    ) {
      showWarning('This Session is no longer available. Open its Project to review its status.')
      return
    }
    selectSession(accepted.id, {
      projectId: accepted.projectId,
      openingId,
      native: true,
    })
  }
  const acceptNativeSession = useEffectEvent(enterResolvedSession)
  const showNativeAttention = useEffectEvent((): void => setNativeAttentionOpen(true))
  useEffect(() => {
    let active = true
    let changed = false
    let resolving = false
    let pending:
      | {
          intent: Extract<NativeNavigationIntent, { kind: 'session' }>
          requestId: number
          selectionEpoch: number
        }
      | undefined
    const drain = (): void => {
      if (!active || resolving || !pending) return
      const { intent, requestId, selectionEpoch } = pending
      pending = undefined
      const current = (): boolean =>
        active &&
        nativeNavigationRequest.current === requestId &&
        userSelectionEpoch.current === selectionEpoch &&
        nativeNavigationIntent.current?.navigationId === intent.navigationId
      if (!current()) return
      resolving = true
      void window.pact
        .resolveNativeSession({ sessionId: intent.sessionId })
        .then((result) => {
          if (!current()) return undefined
          if (result.ok) acceptNativeSession(result.value, intent.navigationId)
          else showWarning(result.error.message)
          acknowledgeNativeNavigation(intent.navigationId)
          return undefined
        })
        .catch(() => {
          if (!current()) return
          showWarning('Could not open this Session. Try its shortcut again to check its status.')
          acknowledgeNativeNavigation(intent.navigationId)
        })
        .finally(() => {
          resolving = false
          drain()
        })
    }
    const receive = (intent: NativeNavigationIntent): void => {
      changed = true
      if (
        !active ||
        intent.navigationId === nativeNavigationIntent.current?.navigationId ||
        intent.navigationId === acknowledgedNativeNavigation.current
      )
        return
      nativeNavigationIntent.current = intent
      const requestId = ++nativeNavigationRequest.current
      const selectionEpoch = ++userSelectionEpoch.current
      if (intent.kind === 'attention') {
        pending = undefined
        showNativeAttention()
        acknowledgeNativeNavigation(intent.navigationId)
        return
      }
      pending = { intent, requestId, selectionEpoch }
      drain()
    }
    const remove = window.pact.onNativeNavigationChanged(receive)
    const readSelectionEpoch = userSelectionEpoch.current
    void window.pact
      .getNativeNavigation()
      .then((result) => {
        if (active && !changed && result.ok && result.value) {
          if (readSelectionEpoch === userSelectionEpoch.current) receive(result.value)
          else {
            nativeNavigationIntent.current = result.value
            acknowledgeNativeNavigation(result.value.navigationId)
          }
        }
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
      pending = undefined
      remove()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- This is a request generation, not a rendered node; invalidate the current asynchronous resolve on disposal.
      nativeNavigationRequest.current++
      nativeNavigationIntent.current = undefined
    }
  }, [acknowledgeNativeNavigation, showWarning])

  useEffect(() => {
    let active = true
    let changed = false
    const receive = (state: NativeQuitState | null): void => {
      changed = true
      if (!active) return
      if (state && state.operationId !== nativeQuitOperation.current) {
        nativeQuitOperation.current = state.operationId
        beginUserSelection()
      }
      if (state && !nativeQuitFocus.current && document.activeElement instanceof HTMLElement)
        nativeQuitFocus.current = document.activeElement
      if (!state) {
        nativeQuitOperation.current = undefined
        const focus = nativeQuitFocus.current
        nativeQuitFocus.current = undefined
        window.requestAnimationFrame(() => {
          const modal = document.querySelector('dialog:modal')
          if (
            active &&
            focus?.isConnected &&
            !focus.closest('[inert]') &&
            (!modal || (focus && modal.contains(focus)))
          )
            focus.focus({ preventScroll: true })
        })
      }
      setNativeQuitState(state)
    }
    const remove = window.pact.onNativeQuitStateChanged(receive)
    void window.pact
      .getNativeQuitState()
      .then((result) => {
        if (active && !changed && result.ok) receive(result.value)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
      remove()
    }
  }, [beginUserSelection])

  const openAttentionSession = async (sessionId: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    const requestId = ++nativeNavigationRequest.current
    const openingId = crypto.randomUUID()
    try {
      const result = await window.pact.resolveNativeSession({ sessionId })
      if (
        selectionEpoch !== userSelectionEpoch.current ||
        requestId !== nativeNavigationRequest.current
      )
        return
      if (!result.ok) {
        showWarning(result.error.message)
        return
      }
      enterResolvedSession(result.value, openingId)
    } catch {
      if (
        selectionEpoch === userSelectionEpoch.current &&
        requestId === nativeNavigationRequest.current
      )
        showWarning('Could not open this Session. Try again to check its status.')
    }
  }

  const openSessionSettings = async (sessionId: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsLoading(true)
    setSessionSettingsOpen(true)
    setProjectFilePanelExpanded(false)
    try {
      const editor = await sessionWorkspace.loadSettings(sessionId)
      if (selectionEpoch === userSelectionEpoch.current) setSessionSettingsEditorState(editor)
    } finally {
      if (selectionEpoch === userSelectionEpoch.current) setSessionSettingsLoading(false)
    }
  }

  const readProjectFile = async (sessionId: string, target: ProjectFileTarget): Promise<void> => {
    setWorkspaceChangesPanel(undefined)
    const requestId = invalidateContextRead()
    const commentNavigation = Boolean(target.commentId)
    if (commentNavigation) {
      setSessionSettingsOpen(false)
      setProjectFilePanel(undefined)
    } else {
      setSessionSettingsOpen(true)
      setProjectFilePanel({ target, loading: true })
    }
    try {
      const {
        commentId: _commentId,
        endColumn: _endColumn,
        expectedContentHash,
        quote: _quote,
        startColumn: _startColumn,
        ...input
      } = target
      const result = await window.pact.readProjectFile({ sessionId, ...input })
      if (requestId !== projectFileRequestRef.current) return
      if (!result.ok) {
        if (commentNavigation) {
          showToast('Comment source is unavailable.', 'error')
          return
        }
        setProjectFilePanel({ target, loading: false, error: result.error.message })
        return
      }
      if (expectedContentHash && result.value.contentHash !== expectedContentHash) {
        if (commentNavigation) {
          showToast('Comment source has changed.', 'warning')
          return
        }
        setProjectFilePanel({
          target,
          loading: false,
          error: 'This file no longer matches the requested version.',
        })
        return
      }
      setSessionSettingsOpen(true)
      setProjectFilePanel({ target, file: result.value, loading: false })
    } catch {
      if (requestId !== projectFileRequestRef.current) return
      if (commentNavigation) {
        showToast('Comment source is unavailable.', 'error')
        return
      }
      setProjectFilePanel({
        target,
        loading: false,
        error: 'Pact could not connect to the file reader.',
      })
    }
  }

  const readSkillDocument = async (
    sessionId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ): Promise<void> => {
    const epoch = invalidateContextRead(),
      requestId = crypto.randomUUID()
    skillDocumentRequest.current = requestId
    setProjectFilePanel(undefined)
    setWorkspaceChangesPanel(undefined)
    setSessionSettingsOpen(true)
    setSkillDocumentPanel({ sessionId, skill, loading: true })
    try {
      const result = await window.pact.readSkillDocument({
        sessionId,
        agentId: skill.agentId,
        skillId: skill.id,
        requestId,
      })
      if (epoch !== projectFileRequestRef.current) return
      setSkillDocumentPanel(
        result.ok
          ? { sessionId, skill, loading: false, document: result.value }
          : { sessionId, skill, loading: false, error: result.error.message },
      )
    } catch {
      if (epoch === projectFileRequestRef.current)
        setSkillDocumentPanel({
          sessionId,
          skill,
          loading: false,
          error: 'Pact could not read this Skill document.',
        })
    } finally {
      if (skillDocumentRequest.current === requestId) skillDocumentRequest.current = undefined
    }
  }

  const openProjectFile = (target: ProjectFileTarget): void => {
    if (!selectedSessionId) return
    void readProjectFile(selectedSessionId, target)
  }

  const openWorkspaceChanges = (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ): void => {
    if (!selectedSessionId) return
    if (expectedGeneration !== undefined && expectedGeneration !== projectFileRequestRef.current)
      return
    invalidateContextRead()
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    const observedRevision =
      conversation.snapshot?.sessionId === selectedSessionId
        ? conversation.snapshot.runs.find((run) => run.workspaceChanges?.id === changeSetId)
            ?.workspaceChanges?.revision
        : undefined
    setWorkspaceChangesPanel((current) => ({
      sessionId: selectedSessionId,
      changeSetId,
      path,
      revision:
        Math.max(
          revision ?? 0,
          observedRevision ?? 0,
          current?.sessionId === selectedSessionId && current.changeSetId === changeSetId
            ? (current.revision ?? 0)
            : 0,
        ) || undefined,
    }))
    setSessionSettingsOpen(true)
  }

  const openSentComment = (comment: AnchoredComment): void => {
    if (!selectedSessionId) return
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsOpen(false)
    const requestedSessionId = selectedSessionId
    const requestId = invalidateContextRead()
    void (async () => {
      const resolved = await window.pact.resolveCommentSource(requestedSessionId, comment.id)
      if (requestId !== projectFileRequestRef.current) return
      if (!resolved.ok) {
        showToast('Comment source is unavailable.', 'error')
        return
      }
      if (resolved.value.status !== 'resolved') {
        showToast(
          resolved.value.status === 'outdated'
            ? 'Comment source has changed.'
            : 'Comment location is unavailable.',
          'warning',
        )
        return
      }
      const anchor = resolved.value.anchor
      if (anchor.type === 'todo') {
        setTodoNavigation({
          sessionId: requestedSessionId,
          taskId: anchor.taskId,
          todoId: anchor.todoId,
          todoRevision: anchor.todoRevision,
          navigationId: crypto.randomUUID(),
          ...(anchor.selection ? { selection: anchor.selection } : {}),
        })
        return
      }
      if (anchor.type === 'file') {
        void readProjectFile(requestedSessionId, {
          path: anchor.path,
          lineStart: anchor.startLine,
          lineEnd: anchor.endLine,
          startColumn: anchor.startColumn,
          endColumn: anchor.endColumn,
          expectedContentHash: anchor.contentHash,
          commentId: comment.id,
          quote: anchor.quote,
        })
        return
      }
      setMessageNavigation({
        sessionId: requestedSessionId,
        navigationId: crypto.randomUUID(),
        messageId: anchor.messageId,
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        textBasis: anchor.textBasis,
        ...(anchor.plan ? { plan: anchor.plan } : {}),
        ...(anchor.report ? { report: anchor.report } : {}),
      })
    })()
  }

  const createFileComment = async (
    anchor: import('@pact/contracts').FileCommentAnchor,
    body: string,
  ): Promise<boolean> => {
    if (!selectedSessionId) return false
    return commentDraftSaveSucceeded(
      await conversation.saveCommentDraft({
        mode: 'create',
        sessionId: selectedSessionId,
        commentId: crypto.randomUUID(),
        body,
        anchor,
      }),
    )
  }

  const retryProjectFile = (): void => {
    if (!selectedSessionId || !projectFilePanel) return
    void readProjectFile(selectedSessionId, projectFilePanel.target)
  }

  const saveSessionSettings = async (
    sessionId: string,
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    const selectionEpoch = userSelectionEpoch.current
    const editor = await sessionWorkspace.saveSettings(sessionId, nextSettings)
    if (editor && selectionEpoch === userSelectionEpoch.current)
      setSessionSettingsEditorState(editor)
  }

  const archiveSession = async (
    sessionId: string,
    operationId?: string,
    prepared?: WorkspaceArchivePreview,
  ): Promise<boolean> => {
    const selectionEpoch = userSelectionEpoch.current
    const session =
      sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId) ??
      (prepared?.scope.kind === 'session' && prepared.scope.sessionId === sessionId
        ? { id: sessionId, title: prepared.title, projectId: prepared.projectId }
        : undefined)
    if (!session || !(await sessionWorkspace.archive(sessionId, operationId))) return false
    if (selectionEpoch !== userSelectionEpoch.current) return true

    if (selectedSessionId === sessionId) {
      setWorkspaceChangesPanel(undefined)
      setSelectedSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setProjectFilePanel(undefined)
      setProjectFilePanelExpanded(false)
    }
    setSelectedProjectId(session.projectId)
    return true
  }

  const archiveProject = async (
    projectId: string,
    operationId?: string,
    prepared?: WorkspaceArchivePreview,
  ): Promise<boolean> => {
    const selectionEpoch = userSelectionEpoch.current
    const project =
      projectCatalog.catalog?.projects.find((item) => item.id === projectId) ??
      (prepared?.scope.kind === 'project' && prepared.scope.projectId === projectId
        ? { id: projectId, name: prepared.title }
        : undefined)
    if (!project || !(await projectCatalog.archive(projectId, operationId))) return false
    if (selectionEpoch !== userSelectionEpoch.current) return true

    const selectedSession = sessionWorkspace.catalog?.sessions.find(
      (session) => session.id === selectedSessionId,
    )
    if (selectedSession?.projectId === projectId) {
      setWorkspaceChangesPanel(undefined)
      setSelectedSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setProjectFilePanel(undefined)
      setProjectFilePanelExpanded(false)
    }
    if (creatingProjectId === projectId) {
      setCreatingProjectId(undefined)
      setCreationEditorState(undefined)
    }
    if (selectedProjectId === projectId) setSelectedProjectId(undefined)
    return true
  }

  const completeArchive = (item: WorkspaceArchivePreview): Promise<boolean> =>
    item.scope.kind === 'session'
      ? archiveSession(item.scope.sessionId, item.operationId, item)
      : archiveProject(item.scope.projectId, item.operationId, item)

  // This ref is the synchronous admission view of the same App-owned result projection.
  const updateArchiveResults = (update: (current: ArchiveResult[]) => ArchiveResult[]): void => {
    const next = update(archiveResultsRef.current)
    archiveResultsRef.current = next
    setArchiveResults(next)
  }

  const recordArchiveResult = (result: ArchiveResult): void => {
    updateArchiveResults((current) => {
      const previous = current.find((item) => item.id === result.id)
      return previous
        ? current.map((item) => (item.id === result.id ? result : item))
        : [result, ...current]
    })
  }

  const setArchiveActionError = (id: string, message?: string): void => {
    updateArchiveResults((current) =>
      current.map((result) => {
        if (result.id !== id) return result
        const { actionError: _previous, ...rest } = result
        return message ? { ...rest, actionError: message } : rest
      }),
    )
  }

  const acceptArchiveReceipt = async (
    id: string,
    item: WorkspaceArchivePreview,
    receipt: WorkspaceArchiveReceipt,
    inDialog: boolean,
  ): Promise<void> => {
    const receiptTarget =
      receipt.preview.scope.kind === 'session'
        ? receipt.preview.scope.sessionId
        : receipt.preview.scope.projectId
    const target = item.scope.kind === 'session' ? item.scope.sessionId : item.scope.projectId
    if (
      receipt.preview.operationId !== item.operationId ||
      receipt.preview.scope.kind !== item.scope.kind ||
      receiptTarget !== target
    )
      throw new Error('The archive receipt did not match this operation.')
    const state =
      receipt.state === 'archived'
        ? 'archived'
        : receipt.state === 'unresolved' || receipt.state === 'stopping'
          ? 'unresolved'
          : 'failed'
    const message =
      receipt.message ??
      (state === 'unresolved'
        ? 'The archive result is not confirmed. Check this operation before trying again.'
        : state === 'failed'
          ? 'This item has not been archived. Its tasks changed or the confirmation expired. Review again before archiving.'
          : undefined)
    recordArchiveResult({
      id,
      item: archiveItem(item),
      state,
      preview: item,
      receipt,
      ...(message ? { message } : {}),
    })
    if (state === 'archived') {
      // Only durable success permits this idempotent catalog read; it never repeats Stop.
      if (!(await completeArchive(item))) {
        setArchiveActionError(
          id,
          'Archived, but the workspace could not refresh. Reload the workspace to show its saved state.',
        )
        sessionWorkspace.retry()
        projectCatalog.retry()
      }
      if (inDialog) {
        setArchivePreview(undefined)
        archiveBusyRef.current = false
      }
    } else if (inDialog) {
      setArchiveReceipt(receipt)
      setArchiveError(message)
    }
  }

  const runArchive = async (id: string, item: WorkspaceArchivePreview): Promise<void> => {
    if (archiveStoppingRef.current) return
    archiveStoppingRef.current = true
    setArchiveStopping(true)
    setArchiveAction({ id, kind: 'archiving' })
    setArchiveError(undefined)
    try {
      if (await completeArchive(item)) {
        recordArchiveResult({ id, item: archiveItem(item), state: 'archived', preview: item })
        setArchivePreview(undefined)
        archiveBusyRef.current = false
      } else {
        const receipt = unwrapRpcResult(
          await window.pact.readWorkspaceArchive({ operationId: item.operationId }),
        )
        await acceptArchiveReceipt(id, item, receipt, true)
      }
    } catch {
      const message =
        'The archive result could not be confirmed. Check its status before trying again.'
      recordArchiveResult({
        id,
        item: archiveItem(item),
        state: 'unresolved',
        preview: item,
        message,
      })
      setArchiveError(message)
      // An unknown outcome stays read-only even when no durable receipt was returned.
      setArchiveReceipt(undefined)
    } finally {
      archiveStoppingRef.current = false
      setArchiveStopping(false)
      setArchiveAction(undefined)
    }
  }

  const closeArchive = (): void => {
    if (archiveStoppingRef.current) return
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (
      archivePreview &&
      result?.state !== 'unresolved' &&
      (!archiveReceipt || archiveReceipt.state === 'prepared')
    )
      void window.pact
        .cancelWorkspaceArchive({ operationId: archivePreview.operationId })
        .catch(() => undefined)
    setArchivePreview(undefined)
    setArchiveReceipt(undefined)
    setArchiveError(undefined)
    setArchiveResultId(undefined)
    archiveBusyRef.current = false
  }

  const checkArchiveResult = async (result: ArchiveResult, inDialog = false): Promise<void> => {
    if ((!inDialog && archiveBusyRef.current) || archiveStoppingRef.current || !result.preview)
      return
    archiveStoppingRef.current = true
    archiveBusyRef.current = true
    setArchiveAction({ id: result.id, kind: 'checking' })
    setArchiveActionError(result.id)
    if (inDialog) setArchiveStopping(true)
    try {
      const receipt = unwrapRpcResult(
        await window.pact.readWorkspaceArchive({ operationId: result.preview.operationId }),
      )
      await acceptArchiveReceipt(result.id, result.preview, receipt, inDialog)
    } catch {
      const message =
        'Could not check this archive. Try Check status again; its result is still unconfirmed.'
      setArchiveActionError(result.id, message)
      if (inDialog) setArchiveError(message)
    } finally {
      archiveStoppingRef.current = false
      setArchiveAction(undefined)
      if (inDialog) setArchiveStopping(false)
      else archiveBusyRef.current = false
    }
  }

  const requestArchive = async (scope: WorkspaceArchiveScope, resultId?: string): Promise<void> => {
    if (archiveBusyRef.current) return
    const targetId = scope.kind === 'session' ? scope.sessionId : scope.projectId
    const existing = archiveResultsRef.current.find(
      (result) => result.item.kind === scope.kind && result.item.id === targetId,
    )
    if (existing?.state === 'unresolved') {
      await checkArchiveResult(existing)
      return
    }
    if (existing?.state === 'archived') {
      showWarning('This item is already archived. Use Undo to restore it first.')
      return
    }
    if (!existing && archiveResultsRef.current.length >= ARCHIVE_RESULT_LIMIT) {
      showWarning('Review or dismiss some archive results before archiving more items.')
      return
    }
    const id = existing?.id ?? resultId ?? crypto.randomUUID()
    const fallback: ArchivedItem | undefined =
      scope.kind === 'session'
        ? (() => {
            const session = sessionWorkspace.catalog?.sessions.find(
              (item) => item.id === scope.sessionId,
            )
            return session
              ? {
                  kind: 'session' as const,
                  id: session.id,
                  title: session.title,
                  projectId: session.projectId,
                }
              : undefined
          })()
        : (() => {
            const project = projectCatalog.catalog?.projects.find(
              (item) => item.id === scope.projectId,
            )
            return project
              ? { kind: 'project' as const, id: project.id, title: project.name }
              : undefined
          })()
    if (fallback && fallback.title.length > 4096) {
      showError('This item name exceeds the archive display limit. Rename it before archiving.')
      return
    }
    archiveBusyRef.current = true
    setArchiveResultId(id)
    setArchiveAction({ id, kind: 'preparing' })
    setArchiveReceipt(undefined)
    setArchiveError(undefined)
    try {
      const prepared = unwrapRpcResult(
        await window.pact.prepareWorkspaceArchive({ operationId: crypto.randomUUID(), scope }),
      )
      setArchivePreview(prepared)
      if (prepared.blockedReason)
        recordArchiveResult({
          id,
          item: archiveItem(prepared),
          state: 'failed',
          preview: prepared,
          message: prepared.blockedReason,
        })
      else if (!prepared.tasks.length) await runArchive(id, prepared)
    } catch (error) {
      const message =
        error instanceof Error && error.message.length <= 2048
          ? error.message
          : 'Could not prepare this archive. Review the item and try again.'
      if (fallback || existing)
        recordArchiveResult({ id, item: fallback ?? existing!.item, state: 'failed', message })
      else showError(message)
      setArchivePreview(undefined)
      archiveBusyRef.current = false
    } finally {
      setArchiveAction(undefined)
    }
  }

  const confirmArchive = async (): Promise<void> => {
    if (!archivePreview || archiveStoppingRef.current || !archiveResultId) return
    await runArchive(archiveResultId, archivePreview)
  }

  const checkArchive = async (): Promise<void> => {
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (result) await checkArchiveResult(result, true)
  }

  const reviewArchive = (): void => {
    if (!archivePreview || archiveStoppingRef.current) return
    const scope = archivePreview.scope
    const id = archiveResultId
    closeArchive()
    void requestArchive(scope, id)
  }

  const dismissArchiveResults = (id?: string): void => {
    if (archiveBusyRef.current) return
    updateArchiveResults((current) =>
      current.filter(
        (result) => result.state === 'unresolved' || (id !== undefined && result.id !== id),
      ),
    )
    if (!archiveResultsRef.current.length) settingsButtonRef.current?.focus()
  }

  const restoreArchived = async (result: ArchiveResult): Promise<void> => {
    if (
      archiveBusyRef.current ||
      result.state !== 'archived' ||
      !archiveResultsRef.current.some((item) => item.id === result.id)
    )
      return
    const item = result.item
    if (
      item.kind === 'session' &&
      !projectCatalog.catalog?.projects.some((project) => project.id === item.projectId)
    ) {
      setArchiveActionError(
        result.id,
        'Restore or re-add its Project first, then undo this Session archive.',
      )
      return
    }
    const selectionEpoch = beginUserSelection()
    const openingId = crypto.randomUUID()
    archiveBusyRef.current = true
    setArchiveAction({ id: result.id, kind: 'restoring' })
    setArchiveActionError(result.id)
    try {
      const restored =
        item.kind === 'session'
          ? await sessionWorkspace.restore(item.id)
          : await projectCatalog.restore(item.id)
      if (!restored) {
        setArchiveActionError(
          result.id,
          'Could not confirm the restore. Try Undo again to check its saved state.',
        )
        return
      }
      updateArchiveResults((current) => current.filter((entry) => entry.id !== result.id))
      if (selectionEpoch !== userSelectionEpoch.current) return
      invalidateContextRead()
      setWorkspaceChangesPanel(undefined)
      setProjectFilePanel(undefined)
      setSessionSettingsOpen(false)
      setSettingsPage(null)
      if (item.kind === 'session') {
        selectSession(item.id, { projectId: item.projectId, openingId, native: true })
      } else {
        setSelectedProjectId(item.id)
        setSelectedSessionId(undefined)
      }
      if (!archiveResultsRef.current.length) settingsButtonRef.current?.focus()
    } catch {
      setArchiveActionError(
        result.id,
        'Could not confirm the restore. Try Undo again to check its saved state.',
      )
    } finally {
      archiveBusyRef.current = false
      setArchiveAction(undefined)
    }
  }

  const toastNotice = toast ? (
    <AppToast key={toast.id} message={toast.message} tone={toast.tone} onDismiss={dismissToast} />
  ) : undefined
  const quitConfirmation = nativeQuitState ? (
    <NativeQuitConfirmation key={nativeQuitState.operationId} state={nativeQuitState} />
  ) : null

  if (
    settingsPage !== 'updates' &&
    (!preparation || (preparation.firstUse && !showFirstUseDefaults) || isRuntimePreparationOpen)
  ) {
    return (
      <>
        <RuntimePreparationView
          preparation={preparation}
          loading={runtimePreparationQuery.isFetching}
          choosingAgent={choosingAgent}
          error={preparationError}
          canReturnToWorkspace={Boolean(preparation && !preparation.firstUse)}
          onBack={() => setIsRuntimePreparationOpen(false)}
          onRetry={() => void runtimePreparationQuery.refetch()}
          onContinue={() => {
            if (preparation?.firstUse) setShowFirstUseDefaults(true)
            else setIsRuntimePreparationOpen(false)
          }}
          onChooseExecutable={(agentId) => void chooseRuntimeExecutable(agentId)}
        />
        {toastNotice}
        {quitConfirmation}
      </>
    )
  }

  if (settingsPage !== 'updates' && preparation?.firstUse && showFirstUseDefaults) {
    return (
      <>
        <DefaultSessionOnboardingView
          editorState={defaultSessionSettings.editorState}
          loading={defaultSessionSettings.loading}
          saving={defaultSessionSettings.saving}
          saveError={defaultSessionSettings.saveError}
          loadError={defaultSessionSettings.loadError}
          onRetry={() => defaultSessionSettings.retry()}
          onSave={(nextSettings) => void saveDefaultSessionSettings(nextSettings)}
        />
        {toastNotice}
        {quitConfirmation}
      </>
    )
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        className="h-full min-h-0"
        inert={nativeAttentionOpen || Boolean(nativeQuitState)}
        aria-hidden={nativeAttentionOpen || undefined}
        style={{ visibility: nativeAttentionOpen ? 'hidden' : 'visible' }}
      >
        <WorkspaceView
          onForkSessionStarted={() => ({
            selectionEpoch: beginUserSelection(),
            openingId: crypto.randomUUID(),
          })}
          nativePresentationSuspended={nativeAttentionOpen || Boolean(nativeQuitState)}
          platform={appInfo?.platform}
          onForkSessionCreated={(change, enter, opening) => {
            acceptSessionCatalogChange(queryClient, change)
            if (enter && opening?.selectionEpoch === userSelectionEpoch.current)
              selectSession(change.session.id, {
                projectId: change.session.projectId,
                openingId: opening.openingId,
              })
          }}
          onSaveSessionPermission={(input) => sessionWorkspace.savePermission(input)}
          onSaveSessionSpeed={(input) => sessionWorkspace.saveSpeed(input)}
          projects={projectCatalog.catalog?.projects ?? []}
          sessions={sessionWorkspace.catalog?.sessions ?? []}
          sessionProjectPages={sessionWorkspace.catalog?.projectPages ?? {}}
          loading={projectCatalog.loading}
          sessionsLoading={sessionWorkspace.loading}
          loadingMoreProjectId={sessionWorkspace.loadingMoreProjectId}
          loadMoreErrors={sessionWorkspace.loadMoreErrors}
          adding={projectCatalog.adding}
          creatingSession={sessionWorkspace.creating}
          savingSessionSettings={sessionWorkspace.savingSettings}
          renamingSessionId={sessionWorkspace.renamingSessionId}
          archivingSessionId={sessionWorkspace.archivingSessionId}
          archivingProjectId={projectCatalog.archivingProjectId}
          renamingProjectId={projectCatalog.renamingProjectId}
          error={projectCatalog.error}
          sessionError={sessionWorkspace.error}
          updateAvailable={updates.state?.updateAvailable ?? false}
          settingsPage={settingsPage}
          onOpenSettings={(page) => {
            beginUserSelection()
            setNativeAttentionOpen(false)
            invalidateContextRead()
            setWorkspaceChangesPanel(undefined)
            setProjectFilePanel(undefined)
            setSessionSettingsOpen(false)
            setSettingsPage(page)
          }}
          onBackToApp={backToWorkspace}
          onAddProject={() => void projectCatalog.chooseAndAdd()}
          onArchiveProject={(projectId) => void requestArchive({ kind: 'project', projectId })}
          onRenameProject={(projectId, name) => projectCatalog.rename(projectId, name)}
          onRetry={() => projectCatalog.retry()}
          onRetrySessions={() => sessionWorkspace.retry()}
          onLoadMoreSessions={(projectId) => sessionWorkspace.loadMore(projectId)}
          selectedSessionId={selectedSessionId}
          selectedProjectId={selectedProjectId}
          creatingProjectId={creatingProjectId}
          creationEditorState={creationEditorState}
          creationLoading={creationLoading}
          sessionSettingsEditorState={sessionSettingsEditorState}
          sessionSettingsLoading={sessionSettingsLoading}
          sessionSettingsOpen={sessionSettingsOpen}
          projectFilePanel={projectFilePanel}
          workspaceChangesPanel={
            workspaceChangesPanel?.sessionId === selectedSessionId
              ? workspaceChangesPanel
              : undefined
          }
          projectFilePanelExpanded={projectFilePanelExpanded}
          conversation={conversation.snapshot}
          conversationVisible={conversationVisible}
          conversationHistory={conversation.history}
          conversationComposer={conversation.composer}
          conversationComposerImages={conversation.composerImages}
          choosingConversationImages={conversation.choosingImages}
          onAddConversationImages={conversation.addComposerImages}
          onChooseConversationImages={conversation.chooseComposerImages}
          onRemoveConversationImage={conversation.removeComposerImage}
          conversationComposerSkills={conversation.composerSkills}
          onConversationComposerSkillsChange={(values) => conversation.setComposerSkills(values)}
          conversationComposerMention={conversation.composerMention}
          conversationComposerRoute={conversation.composerRoute}
          conversationComposerReturnedInputOperationId={
            conversation.composerReturnedInputOperationId
          }
          conversationLoading={conversation.loading}
          sendingMessage={conversation.sending}
          stoppingMessage={conversation.stopping}
          conversationError={conversation.error}
          messageNavigation={
            messageNavigation?.sessionId === selectedSessionId ? messageNavigation : undefined
          }
          todoNavigation={
            todoNavigation?.sessionId === selectedSessionId ? todoNavigation : undefined
          }
          onSessionSettingsOpenChange={(open) => {
            setSessionSettingsOpen(open)
            if (!open) {
              invalidateContextRead()
              setWorkspaceChangesPanel(undefined)
              setProjectFilePanel(undefined)
              setProjectFilePanelExpanded(false)
            }
          }}
          onStartSession={(projectId) => void startSessionCreation(projectId)}
          onCancelSessionCreation={() => {
            beginUserSelection()
            setCreatingProjectId(undefined)
            setCreationEditorState(undefined)
          }}
          onCreateSession={(projectId, nextSettings) => void createSession(projectId, nextSettings)}
          onSelectSession={selectSession}
          onOpenSessionSettings={(sessionId) => void openSessionSettings(sessionId)}
          onRetrySessionSettings={(sessionId) => void openSessionSettings(sessionId)}
          onSaveSessionSettings={(sessionId, nextSettings) =>
            void saveSessionSettings(sessionId, nextSettings)
          }
          onArchiveSession={(sessionId) => void requestArchive({ kind: 'session', sessionId })}
          onRenameSession={(sessionId, title) => sessionWorkspace.rename(sessionId, title)}
          onSendMessage={(content, commentIds, route, skills) =>
            conversation.send(content, commentIds, route, skills)
          }
          onSaveCommentDraft={(input) => conversation.saveCommentDraft(input)}
          onRemoveCommentDraft={(commentId) => conversation.removeCommentDraft(commentId)}
          onOpenComment={openSentComment}
          onNotice={showWarning}
          onConversationComposerChange={(value) => conversation.setComposer(value)}
          onConversationComposerDocumentChange={(value) => conversation.setComposerDocument(value)}
          onOpenSkillDocument={(skill) => {
            if (selectedSessionId) void readSkillDocument(selectedSessionId, skill)
          }}
          skillDocumentPanel={skillDocumentPanel}
          onRetrySkillDocument={() => {
            if (skillDocumentPanel)
              void readSkillDocument(skillDocumentPanel.sessionId, skillDocumentPanel.skill)
          }}
          onConversationComposerMentionChange={(value) => conversation.setComposerMention(value)}
          onCreateFileComment={createFileComment}
          onStopRun={() => conversation.stop()}
          onRebuildNativeContext={(agentId, options) =>
            conversation.rebuildNativeContext(agentId, options)
          }
          onCheckNativeContext={(agentId) => conversation.checkNativeContext(agentId)}
          onAcceptPeerProposal={(proposalId) => conversation.acceptPeerProposal(proposalId)}
          onDismissPeerProposal={(proposalId) => conversation.dismissPeerProposal(proposalId)}
          onRespondNativePermission={(operationId, permissionId, decision) =>
            conversation.respondNativePermission(operationId, permissionId, decision)
          }
          onRespondNativeInput={(input) => conversation.respondNativeInput(input)}
          nativeInputDrafts={conversation.nativeInputDrafts}
          onNativeInputDraftChange={conversation.setNativeInputDraft}
          onUndoWorkspaceChanges={async (changeSetId) => {
            try {
              return await conversation.undoWorkspaceChanges(changeSetId)
            } catch {
              showError('Pact could not undo these changes.')
              return false
            }
          }}
          onOpenWorkspaceChanges={openWorkspaceChanges}
          onPrepareWorkspaceChanges={invalidateContextRead}
          onOpenProjectFile={openProjectFile}
          onProjectFilePanelExpandedChange={setProjectFilePanelExpanded}
          onRetryProjectFile={retryProjectFile}
          archiveNotice={
            <>
              {archiveResults.length ? (
                <ArchiveNotice
                  results={archiveResults}
                  action={archiveAction}
                  blocked={Boolean(archivePreview || archiveAction)}
                  onUndo={(result) => void restoreArchived(result)}
                  onCheck={(result) => void checkArchiveResult(result)}
                  onReview={(result) =>
                    void requestArchive(
                      result.preview?.scope ??
                        (result.item.kind === 'session'
                          ? { kind: 'session', sessionId: result.item.id }
                          : { kind: 'project', projectId: result.item.id }),
                      result.id,
                    )
                  }
                  onDismiss={dismissArchiveResults}
                />
              ) : null}
              {archivePreview && !nativeQuitState && !nativeAttentionOpen ? (
                <ArchiveConfirmation
                  preview={archivePreview}
                  busy={archiveStopping}
                  {...(archiveReceipt ? { receipt: archiveReceipt } : {})}
                  {...(archiveError ? { error: archiveError } : {})}
                  uncertain={archiveResults.some(
                    (result) => result.id === archiveResultId && result.state === 'unresolved',
                  )}
                  onCancel={closeArchive}
                  onConfirm={() => void confirmArchive()}
                  onCheck={() => void checkArchive()}
                  onReview={reviewArchive}
                />
              ) : null}
            </>
          }
          toastNotice={toastNotice}
          settingsButtonRef={settingsButtonRef}
          agentActionsEnabled={allAgentsReady}
          runtimeNotice={
            allAgentsReady || !preparation ? undefined : (
              <RuntimeDegradedNotice
                preparation={preparation}
                onReview={() => {
                  invalidateContextRead()
                  setWorkspaceChangesPanel(undefined)
                  setSessionSettingsOpen(false)
                  setIsRuntimePreparationOpen(true)
                }}
                onRetry={() => void runtimePreparationQuery.refetch()}
              />
            )
          }
          settingsView={
            settingsPage === 'updates' ? (
              aboutUpdatesView
            ) : settingsPage === 'appearance' ? (
              <AppearanceSettingsView
                settings={settings}
                effective={snapshot?.effective}
                loading={appearanceQuery.isPending}
                saving={saving}
                loadError={appearanceQuery.error?.message}
                saveError={saveError}
                onThemeChange={(theme: AppearanceTheme) => void save('update', { theme })}
                onMaterialChange={(windowMaterial: WindowMaterial) =>
                  void save('update', { windowMaterial })
                }
                onMaterialOpacityPreview={(materialOpacity) => setPreview({ materialOpacity })}
                onMaterialOpacityCommit={saveMaterialOpacity}
                onReset={() => void save('reset')}
                onRetry={() => void appearanceQuery.refetch()}
                platform={appInfo?.platform}
              />
            ) : settingsPage === 'session-defaults' ? (
              <DefaultSessionSettingsView
                key={
                  defaultSessionSettings.editorState?.current?.updatedAt ?? 'default-session-new'
                }
                editorState={defaultSessionSettings.editorState}
                loading={defaultSessionSettings.loading}
                saving={defaultSessionSettings.saving}
                saveError={defaultSessionSettings.saveError}
                loadError={defaultSessionSettings.loadError}
                firstUse={false}
                onRetry={() => defaultSessionSettings.retry()}
                onSave={(nextSettings) => void saveDefaultSessionSettings(nextSettings)}
              />
            ) : undefined
          }
        />
      </div>
      {nativeAttentionOpen ? (
        <>
          <NativeAttentionView onBack={backToWorkspace} onOpenSession={openAttentionSession} />
          {toastNotice}
        </>
      ) : null}
      {quitConfirmation}
    </div>
  )
}

export default App
