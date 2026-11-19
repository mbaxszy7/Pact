import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'

import type {
  AppearanceSettingsUpdate,
  AppearanceSnapshot,
  AppearanceTheme,
  AnchoredComment,
  CollaborationSession,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  NativeNavigationIntent,
  NativeQuitState,
  ProjectCatalogState,
  RuntimeAgentId,
  RuntimePreparation,
  SessionSettingsEditorState,
  SessionCatalogChange,
  SessionReminder as SessionReminderModel,
  SideChatSyncMainReceipt,
  WindowMaterial,
  SkillSelection,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
} from '@pact/contracts'

import {
  MATERIAL_OPACITY_MAX,
  MATERIAL_OPACITY_MIN,
  MAX_COMMENT_QUOTE_LENGTH,
  MESSAGE_ANCHOR_TEXT_BASIS,
  NATIVE_METADATA_TIMEOUT_MS,
  NATIVE_RECENT_CANDIDATES,
  resolveMainChatSyncTarget,
} from '@pact/contracts'

import type { ComposerDocument } from './components/conversation/composer-document'
import type { ProjectFileTarget } from './components/conversation/MessageMarkdown'
import type { MessageTextSelection } from './components/conversation/MessageSelectionSurface'
import type { SkillDocumentPanelState } from './components/conversation/SkillDocumentPanel'
import type { ProjectFilePanelState } from './components/project-file/ProjectFilePanel'
import type { WorkspaceChangesPanelState } from './components/project-file/WorkspaceChangesPanel'
import type { NavigationIntent } from './components/workspace/ProjectNavigation'
import type { SessionCatalogCache } from './components/workspace/session-catalog-cache'
import type { SettingsPage } from './components/workspace/SettingsNavigation'

import { ConversationView } from './components/conversation/ConversationView'
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
  DecisionSchedulingSettings,
  useSchedulingSettings,
} from './components/settings/scheduling/DecisionSchedulingSettings'
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
import { ConversationErrorBoundary } from './components/workspace/ConversationErrorBoundary'
import {
  acceptSessionCatalogChange,
  sessionScope,
} from './components/workspace/session-catalog-cache'
import { SessionReminder } from './components/workspace/SessionReminder'
import { SideChatsPanel } from './components/workspace/SideChatsPanel'
import { useProjectCatalog } from './components/workspace/useProjectCatalog'
import { useSessionWorkspace } from './components/workspace/useSessionWorkspace'
import { useActiveSessionInterest, useSideChats } from './components/workspace/useSideChats'
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

const MAX_CACHED_SIDE_CHAT_SESSIONS = 100
const MAX_PENDING_CREATE_SIDE_CHATS = 32

function upsertSideChatSessionMap(
  current: Record<string, CollaborationSession>,
  session: CollaborationSession,
  protectedIds: readonly (string | undefined)[],
): Record<string, CollaborationSession> {
  const next = { ...current }
  delete next[session.id]
  next[session.id] = session
  const keys = Object.keys(next)
  if (keys.length <= MAX_CACHED_SIDE_CHAT_SESSIONS) return next
  const protectedSet = new Set(protectedIds.filter((id): id is string => Boolean(id)))
  let overflow = keys.length - MAX_CACHED_SIDE_CHAT_SESSIONS
  for (const key of keys) {
    if (overflow <= 0) break
    if (key !== session.id && !protectedSet.has(key)) {
      delete next[key]
      overflow -= 1
    }
  }
  return next
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
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const updateVisibility = (): void => setDocumentVisible(!document.hidden)
    const updateFocus = (): void => setWindowFocused(document.hasFocus())
    const refreshRuntime = (): void => {
      if (document.hidden) return
      void queryClient.refetchQueries(
        { queryKey: foundationQueryKeys.runtimePreparation, exact: true },
        { cancelRefetch: false },
      )
    }
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('focus', updateFocus)
    window.addEventListener('blur', updateFocus)
    window.addEventListener('focus', refreshRuntime)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('focus', updateFocus)
      window.removeEventListener('blur', updateFocus)
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
  const [messageNavigation, setMessageNavigation] = useState<
    | {
        sessionId: string
        navigationId: string
        messageId: string
        queuedOperationId?: string | undefined
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
  const [sideChatsOpen, setSideChatsOpen] = useState(false)
  const [activeSideChatId, setActiveSideChatId] = useState<string | undefined>()
  const [sideChatSessionsById, setSideChatSessionsById] = useState<
    Record<string, CollaborationSession>
  >({})
  const [previewBackToSideChatId, setPreviewBackToSideChatId] = useState<string | undefined>()
  const [creatingSideChat, setCreatingSideChat] = useState(false)
  const [sideChatHandoffKey, setSideChatHandoffKey] = useState<string | undefined>()
  const protectedSideChatIdsRef = useRef<readonly (string | undefined)[]>([])
  useLayoutEffect(() => {
    protectedSideChatIdsRef.current = [activeSideChatId, previewBackToSideChatId]
  }, [activeSideChatId, previewBackToSideChatId])
  const pendingCreateSideChatRef = useRef(
    new Map<string, { operationId: string; parentSessionId: string; signature?: string }>(),
  )
  useEffect(() => {
    const pendingCreates = pendingCreateSideChatRef.current
    return () => {
      pendingCreates.clear()
    }
  }, [])
  const viewSourceTimerRef = useRef<number | undefined>(undefined)
  const createSideChatInFlightRef = useRef(false)
  const selectedSessionIdRef = useRef<string | undefined>(selectedSessionId)
  useLayoutEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])
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
  const [sessionReminder, setSessionReminder] = useState<
    { current: SessionReminderModel; pending: number } | undefined
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
      window.clearTimeout(viewSourceTimerRef.current)
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
  const [utilityRecovery, setUtilityRecovery] = useState(0)
  const sessionWorkspace = useSessionWorkspace(
    runtimePreparationQuery.data?.firstUse === false,
    projectCatalog.catalog?.projects,
    () => setUtilityRecovery((current) => current + 1),
  )
  const retainSelectedNavigation = useEffectEvent((id: string | undefined) => {
    sessionWorkspace.retainSelected(id)
  })
  useEffect(() => {
    retainSelectedNavigation(selectedSessionId)
  }, [selectedSessionId])
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
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent>()
  const requestSessionLocation = (projectId: string, sessionId: string): void => {
    setNavigationIntent({ projectId, sessionId, focus: false })
  }
  const beginUserSelection = useCallback((): number => {
    setNavigationIntent(undefined)
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
        showWarning('Couldn’t update your recent sessions list.')
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
          showWarning('Couldn’t update your recent sessions list.')
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
    const remove = window.pact.onSessionReminderChanged?.((state) => {
      setSessionReminder(
        state.current ? { current: state.current, pending: state.pending } : undefined,
      )
    })
    return () => remove?.()
  }, [])
  const viewSessionReminder = useCallback(
    (reminder: SessionReminderModel): void => {
      void window.pact
        .viewSessionReminder({ id: reminder.id })
        .then((result) => {
          if (!result.ok) showWarning(result.error.message)
          return undefined
        })
        .catch(() => showWarning('Couldn’t open this session. Open it from the sidebar.'))
    },
    [showWarning],
  )
  const dismissSessionReminder = useCallback((reminder: SessionReminderModel): void => {
    void window.pact.dismissSessionReminder({ id: reminder.id }).catch(() => undefined)
  }, [])
  useEffect(() => {
    let active = true
    let notified = false
    const receive = (status: import('@pact/contracts').DiagnosticStatus): void => {
      if (active && !notified && status.state === 'unavailable') {
        notified = true
        showWarning('Diagnostic logs couldn’t be saved. Pact will keep running normally.')
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
  useEffect(() => {
    const reminder = sessionReminder?.current
    if (!reminder || reminder.summary) return
    if (selectedSessionId !== reminder.sessionId || !conversationVisible || !windowFocused) return
    dismissSessionReminder(reminder)
  }, [
    conversationVisible,
    dismissSessionReminder,
    selectedSessionId,
    sessionReminder,
    windowFocused,
  ])
  const schedulingSettings = useSchedulingSettings(
    runtimePreparationQuery.data?.firstUse === false &&
      documentVisible &&
      !nativeAttentionOpen &&
      !nativeQuitState &&
      !isRuntimePreparationOpen &&
      !showFirstUseDefaults &&
      (settingsPage === 'decision-scheduling' || (!settingsPage && !creatingProjectId)),
    selectedSessionId,
    settingsPage === 'decision-scheduling',
  )
  const selectedMainSession = sessionWorkspace.catalog?.sessions.find(
    (session) => session.id === selectedSessionId && session.status !== 'archived',
  )
  const mainParentSessionId =
    selectedMainSession && !selectedMainSession.parentSessionId ? selectedMainSession.id : undefined
  const sideChats = useSideChats({
    parentSessionId: mainParentSessionId,
    listOpen: sideChatsOpen && !activeSideChatId,
  })
  const sideChatVisible = conversationVisible && sideChatsOpen && Boolean(activeSideChatId)
  const mainInterest = useActiveSessionInterest(
    [selectedSessionId, sideChatsOpen ? activeSideChatId : undefined],
    conversationVisible && Boolean(selectedSessionId),
    utilityRecovery,
  )
  const conversation = useConversation(
    selectedSessionId,
    showWarning,
    conversationVisible,
    showError,
    showToast,
    { disableAutoInterest: true, waitForInterest: mainInterest.waitForReady },
  )
  const updateSideChatFromSessionRef = useRef<
    ((session: CollaborationSession) => void) | undefined
  >(undefined)
  const sideChatConversation = useConversation(
    activeSideChatId,
    showWarning,
    sideChatVisible,
    showError,
    showToast,
    {
      disableAutoInterest: true,
      waitForInterest: mainInterest.waitForReady,
      onSessionRead: (session) => {
        setSideChatSessionsById((current) => {
          const existing = current[session.id]
          if (!existing || existing.hasUnread === session.hasUnread) return current
          return { ...current, [session.id]: { ...existing, hasUnread: session.hasUnread } }
        })
        updateSideChatFromSessionRef.current?.(session)
      },
    },
  )
  const latestMainRun = conversation.history.window?.latestRun
  const mainCollaborationKey = `${latestMainRun?.id ?? ''}:${latestMainRun?.status ?? ''}:${
    latestMainRun && !['starting', 'running', 'recovering'].includes(latestMainRun.status)
      ? latestMainRun.updatedAt
      : ''
  }:${conversation.snapshot?.queue?.revision ?? ''}`
  const mainCollaborationQuery = useQuery({
    queryKey: [
      'conversation',
      mainParentSessionId ?? '',
      'collaboration',
      mainCollaborationKey,
    ] as const,
    enabled: Boolean(mainParentSessionId && sideChatsOpen && activeSideChatId),
    queryFn: async () => {
      const response = unwrapRpcResult(
        await window.pact.getConversation({
          scope: 'collaboration',
          sessionId: mainParentSessionId!,
          projection: 'current',
        }),
      )
      return response.scope === 'collaboration' ? (response.view.task ?? null) : null
    },
    staleTime: 0,
  })
  const mainTargetAgentId = selectedMainSession
    ? resolveMainChatSyncTarget(
        selectedMainSession.settings.primaryAgentId,
        mainCollaborationQuery.data ?? undefined,
      )
    : undefined
  const updateSideChatFromSession = sideChats.updateSideChatFromSession
  useLayoutEffect(() => {
    updateSideChatFromSessionRef.current = updateSideChatFromSession
  }, [updateSideChatFromSession])
  const sideChatSnapshotSession = sideChatConversation.snapshot?.session
  useEffect(() => {
    if (!activeSideChatId) return undefined
    let active = true
    void window.pact
      .getSessionSettings(activeSideChatId)
      .then((result) => {
        if (!active || !result.ok) return undefined
        const loaded = result.value.session
        setSideChatSessionsById((current) =>
          upsertSideChatSessionMap(current, loaded, protectedSideChatIdsRef.current),
        )
        updateSideChatFromSession(loaded)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [activeSideChatId, updateSideChatFromSession])
  useEffect(() => {
    if (!sideChatSnapshotSession) return
    const existing = sideChatSessionsById[sideChatSnapshotSession.id]
    const nextMerged = existing ? { ...existing, ...sideChatSnapshotSession } : undefined
    if (
      nextMerged &&
      (existing?.title !== sideChatSnapshotSession.title ||
        existing?.titleSource !== sideChatSnapshotSession.titleSource ||
        existing?.status !== sideChatSnapshotSession.status ||
        existing?.updatedAt !== sideChatSnapshotSession.updatedAt)
    ) {
      setSideChatSessionsById((current) =>
        upsertSideChatSessionMap(current, nextMerged, protectedSideChatIdsRef.current),
      )
    }
    updateSideChatFromSession(nextMerged ?? sideChatSnapshotSession)
  }, [sideChatSessionsById, sideChatSnapshotSession, updateSideChatFromSession])
  const refreshAfterUtilityRecovery = useEffectEvent(() => {
    void runtimePreparationQuery.refetch()
    conversation.history.retryRead()
    if (activeSideChatId) sideChatConversation.history.retryRead()
  })
  useEffect(() => {
    if (utilityRecovery > 0) refreshAfterUtilityRecovery()
  }, [utilityRecovery])
  const selectedChangesSnapshot =
    workspaceChangesPanel &&
    sideChatConversation.snapshot &&
    workspaceChangesPanel.sessionId === activeSideChatId &&
    sideChatConversation.snapshot.sessionId === activeSideChatId
      ? sideChatConversation.snapshot
      : workspaceChangesPanel &&
          conversation.snapshot &&
          workspaceChangesPanel.sessionId === selectedSessionId &&
          conversation.snapshot.sessionId === selectedSessionId
        ? conversation.snapshot
        : undefined
  const selectedChangesRevision = selectedChangesSnapshot
    ? selectedChangesSnapshot.runs.find(
        (run) => run.workspaceChanges?.id === workspaceChangesPanel?.changeSetId,
      )?.workspaceChanges?.revision
    : undefined
  useEffect(() => {
    if (selectedChangesRevision === undefined) return
    setWorkspaceChangesPanel((current) =>
      current &&
      (current.sessionId === selectedSessionId || current.sessionId === activeSideChatId) &&
      current.changeSetId === workspaceChangesPanel?.changeSetId &&
      selectedChangesRevision > (current.revision ?? 0)
        ? { ...current, revision: selectedChangesRevision }
        : current,
    )
  }, [
    activeSideChatId,
    selectedChangesRevision,
    selectedSessionId,
    workspaceChangesPanel?.changeSetId,
  ])
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
    !toast &&
      !sessionReminder &&
      !nativeQuitState &&
      runtimePreparationQuery.data?.firstUse === false,
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

  const startSessionCreation = async (projectId: string, groupId?: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    setNativeAttentionOpen(false)
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setSettingsPage(null)
    setSelectedSessionId(undefined)
    setSelectedProjectId(projectId)
    setCreatingProjectId(projectId)
    setCreatingGroupId(groupId)
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
    const created = await sessionWorkspace.create(projectId, nextSettings, creatingGroupId)
    if (!created || created.status === 'archived') return
    const currentProjects = queryClient.getQueryData<ProjectCatalogState>(
      projectCatalogQueryKeys.catalog,
    )
    if (!currentProjects?.projects.some((project) => project.id === projectId)) return
    if (selectionEpoch !== userSelectionEpoch.current) {
      void sessionWorkspace
        .loadPage({ projectId, scope: sessionScope(created) })
        .catch(() => undefined)
      return
    }
    setCreatingProjectId(undefined)
    setCreatingGroupId(undefined)
    setCreationEditorState(undefined)
    setSelectedProjectId(projectId)
    sessionWorkspace.retainSelected(created.id)
    setSelectedSessionId(created.id)
    requestSessionLocation(projectId, created.id)
    recordSessionOpened(created.id, openingId)
  }

  const selectSession = (
    sessionId: string,
    options?: {
      projectId?: string
      openingId?: string
      native?: boolean
      sidebarHidden?: boolean | undefined
      skipOpenedRecord?: boolean
    },
  ): void => {
    if (!options?.native) beginUserSelection()
    setNativeAttentionOpen(false)
    setWorkspaceChangesPanel(undefined)
    invalidateContextRead()
    setSettingsPage(null)
    setCreatingProjectId(undefined)
    setCreatingGroupId(undefined)
    setCreationEditorState(undefined)
    setCreationLoading(false)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    if (activeSideChatId && !previewBackToSideChatId) {
      maybeDiscardEmptySideChatRef.current?.(activeSideChatId)
    }
    setSideChatsOpen(false)
    setActiveSideChatId(undefined)
    setPreviewBackToSideChatId(undefined)
    setSideChatHandoffKey(undefined)
    setProjectFilePanel(undefined)
    setProjectFilePanelExpanded(false)
    const session = sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId)
    const projectId = options?.projectId ?? session?.projectId
    setSelectedProjectId(projectId)
    sessionWorkspace.retainSelected(sessionId)
    setSelectedSessionId(sessionId)
    setMessageNavigation(undefined)
    if (options?.projectId && !options.sidebarHidden)
      requestSessionLocation(options.projectId, sessionId)
    if (!options?.skipOpenedRecord) {
      recordSessionOpened(sessionId, options?.openingId ?? crypto.randomUUID())
    }
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
    if (preparation && !preparation.firstUse) setIsRuntimePreparationOpen(false)
    selectSession(accepted.id, {
      projectId: accepted.projectId,
      openingId,
      native: true,
      sidebarHidden: accepted.sidebarHidden,
      skipOpenedRecord: Boolean(change.resolvedSideChat),
    })
    if (change.resolvedSideChat && change.resolvedSideChat.status !== 'archived') {
      const resolvedSideChat = change.resolvedSideChat
      setSideChatSessionsById((current) =>
        upsertSideChatSessionMap(current, resolvedSideChat, [resolvedSideChat.id]),
      )
      setPreviewBackToSideChatId(undefined)
      setActiveSideChatId(resolvedSideChat.id)
      setSideChatsOpen(true)
    }
  }
  const acceptNativeSession = useEffectEvent(enterResolvedSession)
  const showNativeAttention = useEffectEvent((): void => setNativeAttentionOpen(true))
  const showNativeWorkspace = useEffectEvent(backToWorkspace)
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
      if (intent.kind === 'workspace') {
        pending = undefined
        showNativeWorkspace()
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
    if (activeSideChatId) {
      maybeDiscardEmptySideChatRef.current?.(activeSideChatId)
    }
    setSideChatsOpen(false)
    setPreviewBackToSideChatId(undefined)
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
    if (activeSideChatId) maybeDiscardEmptySideChat(activeSideChatId)
    setActiveSideChatId(undefined)
    setSideChatsOpen(false)
    setPreviewBackToSideChatId(undefined)
    void readProjectFile(selectedSessionId, target)
  }

  const openWorkspaceChanges = (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
    targetSessionId?: string,
  ): void => {
    if (targetSessionId && targetSessionId !== selectedSessionId) {
      openSideChatWorkspaceChanges(targetSessionId, changeSetId, path, expectedGeneration, revision)
      return
    }
    if (!selectedSessionId) return
    if (expectedGeneration !== undefined && expectedGeneration !== projectFileRequestRef.current)
      return
    if (activeSideChatId) maybeDiscardEmptySideChat(activeSideChatId)
    setActiveSideChatId(undefined)
    setSideChatsOpen(false)
    setPreviewBackToSideChatId(undefined)
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

  const isUntouchedEmptySideChat = (sideChatId: string): boolean => {
    if (sideChatConversation.sending && activeSideChatId === sideChatId) return false
    if (activeSideChatId === sideChatId) {
      if (
        sideChatConversation.composer.trim() ||
        sideChatConversation.composerImages.length > 0 ||
        sideChatConversation.composerSkills.length > 0 ||
        sideChatConversation.composerMention
      ) {
        return false
      }
      const snap =
        sideChatConversation.snapshot?.session.id === sideChatId
          ? sideChatConversation.snapshot
          : undefined
      if (snap) {
        if (
          snap.session.status !== 'draft' ||
          snap.messages.length > 0 ||
          snap.runs.length > 0 ||
          Boolean(snap.queue?.input) ||
          Boolean(snap.queue?.returnedInput)
        ) {
          return false
        }
        if (
          snap.draftComments.some(
            (comment) => comment.body.trim().length > 0 || comment.anchor.type !== 'cutoff_message',
          )
        ) {
          return false
        }
        return true
      }
    }
    const summary = sideChats.items.find((item) => item.id === sideChatId)
    const cached = sideChatSessionsById[sideChatId]
    const status = cached?.status ?? summary?.status
    return (
      status === 'draft' && !summary?.isRunning && !summary?.needsAttention && !summary?.previewText
    )
  }

  const maybeDiscardEmptySideChat = (sideChatId: string): boolean => {
    if (!isUntouchedEmptySideChat(sideChatId)) return false
    sideChats.removeSideChat(sideChatId)
    setSideChatSessionsById((current) => {
      if (!(sideChatId in current)) return current
      const next = { ...current }
      delete next[sideChatId]
      return next
    })
    void window.pact
      .discardEmptySideChat({ sideChatId })
      .then((result) => {
        if (!result.ok || !result.value.discarded) {
          sideChats.refresh()
        }
        return undefined
      })
      .catch(() => {
        sideChats.refresh()
      })
    return true
  }
  const maybeDiscardEmptySideChatRef = useRef<((sideChatId: string) => boolean) | undefined>(
    undefined,
  )
  useLayoutEffect(() => {
    maybeDiscardEmptySideChatRef.current = maybeDiscardEmptySideChat
  })

  const openSideChatsList = (): void => {
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setPreviewBackToSideChatId(undefined)
    if (activeSideChatId) maybeDiscardEmptySideChat(activeSideChatId)
    setActiveSideChatId(undefined)
    setSideChatsOpen(true)
    setProjectFilePanelExpanded(false)
  }

  const openSideChatDetail = (sideChatId: string): void => {
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setPreviewBackToSideChatId(undefined)
    if (activeSideChatId && activeSideChatId !== sideChatId) {
      maybeDiscardEmptySideChat(activeSideChatId)
    }
    setActiveSideChatId(sideChatId)
    setSideChatsOpen(true)
    setProjectFilePanelExpanded(false)
  }

  const openOriginSideChat = (sideChatId: string): void => {
    const selectionEpoch = userSelectionEpoch.current
    void (async () => {
      const local = sideChatSessionsById[sideChatId]
      const summary = sideChats.items.find((item) => item.id === sideChatId)
      let loaded = local
      if (!loaded) {
        const fetched = await window.pact.getSessionSettings(sideChatId).catch(() => undefined)
        if (selectionEpoch !== userSelectionEpoch.current) return
        if (fetched?.ok) {
          loaded = fetched.value.session
        }
      }
      const resolvedParentId = loaded?.parentSessionId ?? summary?.parentSessionId
      if (!resolvedParentId || loaded?.status === 'archived') {
        showWarning('The source side chat is no longer available.')
        return
      }
      if (resolvedParentId === selectedSessionIdRef.current) {
        if (loaded) {
          setSideChatSessionsById((current) =>
            upsertSideChatSessionMap(current, loaded, [sideChatId, previewBackToSideChatId]),
          )
        }
        openSideChatDetail(sideChatId)
        return
      }
      const targetParent = sessionWorkspace.catalog?.sessions.find(
        (item) =>
          item.id === resolvedParentId && item.status !== 'archived' && !item.parentSessionId,
      )
      if (!targetParent) {
        showWarning('The parent Session for this side chat is archived or unavailable.')
        return
      }
      selectSession(targetParent.id, { projectId: targetParent.projectId })
      if (loaded) {
        setSideChatSessionsById((current) =>
          upsertSideChatSessionMap(current, loaded, [sideChatId]),
        )
      }
      setActiveSideChatId(sideChatId)
      setSideChatsOpen(true)
    })()
  }

  const openSideChatProjectFile = (target: ProjectFileTarget, sideChatId: string): void => {
    setSessionSettingsOpen(false)
    setSideChatsOpen(true)
    setPreviewBackToSideChatId(sideChatId)
    void readProjectFile(sideChatId, target)
  }

  const openSideChatSkillDocument = (
    sideChatId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ): void => {
    setSessionSettingsOpen(false)
    setSideChatsOpen(true)
    setPreviewBackToSideChatId(sideChatId)
    void readSkillDocument(sideChatId, skill)
  }

  const openSideChatWorkspaceChanges = (
    sideChatId: string,
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ): void => {
    if (expectedGeneration !== undefined && expectedGeneration !== projectFileRequestRef.current)
      return
    invalidateContextRead()
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setSideChatsOpen(true)
    setPreviewBackToSideChatId(sideChatId)
    const observedRevision =
      sideChatConversation.snapshot?.sessionId === sideChatId
        ? sideChatConversation.snapshot.runs.find((run) => run.workspaceChanges?.id === changeSetId)
            ?.workspaceChanges?.revision
        : undefined
    setWorkspaceChangesPanel((current) => ({
      sessionId: sideChatId,
      changeSetId,
      path,
      revision:
        Math.max(
          revision ?? 0,
          observedRevision ?? 0,
          current?.sessionId === sideChatId && current.changeSetId === changeSetId
            ? (current.revision ?? 0)
            : 0,
        ) || undefined,
    }))
  }

  const backToSideChat = previewBackToSideChatId
    ? (): void => {
        const sideChatId = previewBackToSideChatId
        invalidateContextRead()
        setWorkspaceChangesPanel(undefined)
        setProjectFilePanel(undefined)
        setPreviewBackToSideChatId(undefined)
        setProjectFilePanelExpanded(false)
        setSessionSettingsOpen(false)
        setActiveSideChatId(sideChatId)
        setSideChatsOpen(true)
      }
    : undefined

  const rememberPendingCreateSideChat = (
    key: string,
    entry: { operationId: string; parentSessionId: string; signature?: string },
  ): void => {
    const store = pendingCreateSideChatRef.current
    if (!store.has(key) && store.size >= MAX_PENDING_CREATE_SIDE_CHATS) {
      return
    }
    store.set(key, entry)
  }

  const ensurePendingCreateSideChatCapacity = async (key: string): Promise<boolean> => {
    const store = pendingCreateSideChatRef.current
    if (store.has(key) || store.size < MAX_PENDING_CREATE_SIDE_CHATS) return true
    for (const [candidateKey, candidateEntry] of store.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Probe oldest pending side-chat creations before refusing a 33rd unverified slot.
      const probe = await window.pact
        .readCreateSideChatReceipt({ operationId: candidateEntry.operationId })
        .catch(() => undefined)
      if (!probe?.ok) continue
      if (probe.value && selectedSessionIdRef.current === candidateEntry.parentSessionId) {
        sideChats.applyCreatedSideChat(probe.value.sideChat)
      }
      if (store.get(candidateKey) === candidateEntry) {
        store.delete(candidateKey)
      }
      return true
    }
    showError(
      'Too many side chats have unconfirmed creations waiting for verification. Retry or wait for one to finish.',
    )
    return false
  }

  const createSideChatWithReceipt = async (
    input: import('@pact/contracts').CreateSideChatInput,
  ): Promise<
    | { kind: 'receipt'; receipt: import('@pact/contracts').CreateSideChatReceipt }
    | { kind: 'uncertain' }
    | { kind: 'failed' }
  > => {
    const existing = await window.pact
      .readCreateSideChatReceipt({ operationId: input.operationId })
      .catch(() => undefined)
    if (existing?.ok && existing.value) return { kind: 'receipt', receipt: existing.value }
    const result = await window.pact.createSideChat(input)
    if (result.ok) return { kind: 'receipt', receipt: result.value }
    if (result.error.code === 'TIMEOUT' || result.error.code === 'UNCERTAIN') {
      const receipt = await window.pact
        .readCreateSideChatReceipt({ operationId: input.operationId })
        .catch(() => undefined)
      if (receipt?.ok && receipt.value) return { kind: 'receipt', receipt: receipt.value }
      showError(result.error.message || 'Side chat creation could not be confirmed.')
      return { kind: 'uncertain' }
    }
    showError(result.error.message || 'Side chat could not be created.')
    return { kind: 'failed' }
  }

  const openBtwSideChat = async (draft: ComposerDocument): Promise<boolean> => {
    const parentSessionId = selectedSessionIdRef.current
    if (!parentSessionId || createSideChatInFlightRef.current) return false
    createSideChatInFlightRef.current = true
    const pendingKey = `btw:${parentSessionId}`
    const signature = JSON.stringify({
      text: draft.text,
      skills: draft.skills,
      mention: draft.mention,
      route: draft.route,
    })
    const preserved = pendingCreateSideChatRef.current.get(pendingKey)
    let operationId: string
    try {
      if (preserved && preserved.signature === signature) {
        operationId = preserved.operationId
      } else {
        if (preserved) {
          const prior = await window.pact
            .readCreateSideChatReceipt({ operationId: preserved.operationId })
            .catch(() => undefined)
          if (!prior?.ok) {
            showError(
              prior?.error.message ||
                'Could not verify whether your previous side chat finished creating. Try again.',
            )
            return false
          }
          if (prior.value && selectedSessionIdRef.current === parentSessionId) {
            sideChats.applyCreatedSideChat(prior.value.sideChat)
          }
          if (pendingCreateSideChatRef.current.get(pendingKey) === preserved) {
            pendingCreateSideChatRef.current.delete(pendingKey)
          }
        }
        if (!(await ensurePendingCreateSideChatCapacity(pendingKey))) {
          return false
        }
        operationId = crypto.randomUUID()
      }
      const outcome = await createSideChatWithReceipt({
        origin: 'btw',
        operationId,
        parentSessionId,
      })
      if (outcome.kind === 'uncertain') {
        rememberPendingCreateSideChat(pendingKey, { operationId, parentSessionId, signature })
        return false
      }
      if (pendingCreateSideChatRef.current.get(pendingKey)?.operationId === operationId) {
        pendingCreateSideChatRef.current.delete(pendingKey)
      }
      if (outcome.kind === 'failed' || selectedSessionIdRef.current !== parentSessionId) {
        return false
      }
      sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
      const seeded = sideChatConversation.seedComposerDraft(outcome.receipt.sideChat.id, draft)
      setSideChatHandoffKey(operationId)
      openSideChatDetail(outcome.receipt.sideChat.id)
      if (!seeded) {
        showWarning(
          'Opened the side chat, but your main draft was kept because draft memory is full.',
        )
        return false
      }
      return true
    } finally {
      createSideChatInFlightRef.current = false
    }
  }

  const askInSideChat = (selection: MessageTextSelection): void => {
    const parentSessionId = selectedSessionIdRef.current
    if (!parentSessionId || createSideChatInFlightRef.current) return
    const quote = selection.quote.slice(0, MAX_COMMENT_QUOTE_LENGTH)
    if (!quote.trim()) return
    const endOffset = Math.max(
      selection.startOffset + 1,
      Math.min(selection.endOffset, selection.startOffset + quote.length),
    )
    const pendingKey = `selection:${parentSessionId}:${selection.messageId}:${selection.startOffset}:${endOffset}:${quote}`
    const operationId =
      pendingCreateSideChatRef.current.get(pendingKey)?.operationId ?? crypto.randomUUID()
    createSideChatInFlightRef.current = true
    void (async () => {
      try {
        if (!(await ensurePendingCreateSideChatCapacity(pendingKey))) return
        const outcome = await createSideChatWithReceipt({
          origin: 'selection',
          operationId,
          parentSessionId,
          messageId: selection.messageId,
          quote,
          startOffset: selection.startOffset,
          endOffset,
        })
        if (outcome.kind === 'uncertain') {
          rememberPendingCreateSideChat(pendingKey, { operationId, parentSessionId })
          return
        }
        if (pendingCreateSideChatRef.current.get(pendingKey)?.operationId === operationId) {
          pendingCreateSideChatRef.current.delete(pendingKey)
        }
        if (outcome.kind === 'failed' || selectedSessionIdRef.current !== parentSessionId) {
          return
        }
        sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
        setSideChatHandoffKey(operationId)
        openSideChatDetail(outcome.receipt.sideChat.id)
      } finally {
        createSideChatInFlightRef.current = false
      }
    })()
  }

  const createBlankSideChat = (): void => {
    const parentSessionId = selectedSessionIdRef.current
    if (!parentSessionId || createSideChatInFlightRef.current) return
    const pendingKey = `blank:${parentSessionId}`
    const operationId =
      pendingCreateSideChatRef.current.get(pendingKey)?.operationId ?? crypto.randomUUID()
    createSideChatInFlightRef.current = true
    setCreatingSideChat(true)
    void (async () => {
      try {
        if (!(await ensurePendingCreateSideChatCapacity(pendingKey))) return
        const outcome = await createSideChatWithReceipt({
          origin: 'btw',
          operationId,
          parentSessionId,
        })
        if (outcome.kind === 'uncertain') {
          rememberPendingCreateSideChat(pendingKey, { operationId, parentSessionId })
          return
        }
        if (pendingCreateSideChatRef.current.get(pendingKey)?.operationId === operationId) {
          pendingCreateSideChatRef.current.delete(pendingKey)
        }
        if (outcome.kind === 'failed' || selectedSessionIdRef.current !== parentSessionId) {
          return
        }
        sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
        setSideChatHandoffKey(operationId)
        openSideChatDetail(outcome.receipt.sideChat.id)
      } finally {
        createSideChatInFlightRef.current = false
        setCreatingSideChat(false)
      }
    })()
  }

  const navigateMainMessageTarget = (
    parentSessionId: string,
    target: {
      messageId: string
      queuedOperationId?: string | undefined
      startOffset: number
      endOffset: number
      textBasis?: import('@pact/contracts').MessageCommentAnchor['textBasis'] | undefined
    },
  ): void => {
    window.clearTimeout(viewSourceTimerRef.current)
    const isOverlayModal = typeof window !== 'undefined' && window.innerWidth < 1100
    const applyNavigation = (): void => {
      if (selectedSessionIdRef.current !== parentSessionId) return
      setMessageNavigation({
        sessionId: parentSessionId,
        navigationId: crypto.randomUUID(),
        messageId: target.messageId,
        ...(target.queuedOperationId ? { queuedOperationId: target.queuedOperationId } : {}),
        startOffset: target.startOffset,
        endOffset: target.endOffset,
        textBasis: target.textBasis ?? 'plain-visible-v1',
      })
    }
    if (isOverlayModal) {
      setSideChatsOpen(false)
      setSessionSettingsOpen(false)
      setPreviewBackToSideChatId(undefined)
      invalidateContextRead()
      setWorkspaceChangesPanel(undefined)
      setProjectFilePanel(undefined)
      viewSourceTimerRef.current = window.setTimeout(() => {
        viewSourceTimerRef.current = undefined
        applyNavigation()
      }, 160)
      return
    }
    applyNavigation()
  }

  const viewSyncedMainMessage = (receipt: SideChatSyncMainReceipt): void => {
    if (!selectedSessionId || selectedSessionId !== receipt.parentSessionId) return
    if (receipt.mainMessageId) {
      navigateMainMessageTarget(receipt.parentSessionId, {
        messageId: receipt.mainMessageId,
        startOffset: 0,
        endOffset: 0,
      })
      return
    }
    if (receipt.disposition === 'queued' && receipt.queuedOperationId) {
      navigateMainMessageTarget(receipt.parentSessionId, {
        messageId: receipt.queuedOperationId,
        queuedOperationId: receipt.queuedOperationId,
        startOffset: 0,
        endOffset: 0,
      })
    }
  }

  const openSentComment = (comment: AnchoredComment): void => {
    if (!selectedSessionId) return
    if (comment.anchor.type === 'unavailable') {
      showToast(`Source unavailable. ${comment.anchor.reason}`, 'warning')
      return
    }
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsOpen(false)
    const requestedSessionId = comment.sessionId
    const requestId = invalidateContextRead()
    void (async () => {
      const resolved = await window.pact.resolveCommentSource(requestedSessionId, comment.id)
      if (requestId !== projectFileRequestRef.current) return
      if (!resolved.ok) {
        showToast('Comment source is unavailable.', 'error')
        return
      }
      if (resolved.value.status !== 'resolved') {
        if (resolved.value.status === 'outdated') {
          const snippet = resolved.value.quote.trim().slice(0, 120)
          const suffix = resolved.value.quote.trim().length > 120 ? '…' : ''
          showToast(
            snippet
              ? `${resolved.value.reason} Quoted text: "${snippet}${suffix}"`
              : resolved.value.reason,
            'warning',
          )
        } else {
          showToast(resolved.value.reason || 'Comment location is unavailable.', 'warning')
        }
        return
      }
      const anchor = resolved.value.anchor
      if (anchor.type === 'unavailable') {
        showToast(`Source unavailable. ${anchor.reason}`, 'warning')
        return
      }
      if (anchor.type === 'file') {
        if (requestedSessionId !== selectedSessionId) {
          setSideChatsOpen(true)
          setPreviewBackToSideChatId(requestedSessionId)
        } else {
          setSideChatsOpen(false)
          setPreviewBackToSideChatId(undefined)
        }
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
      if (anchor.type === 'cutoff_message') {
        if (anchor.sourceSessionId === selectedSessionId) {
          navigateMainMessageTarget(anchor.sourceSessionId, {
            messageId: anchor.messageId,
            startOffset: anchor.startOffset,
            endOffset: anchor.endOffset,
            textBasis: anchor.textBasis ?? MESSAGE_ANCHOR_TEXT_BASIS,
          })
          return
        }
        openSideChatDetail(anchor.sourceSessionId)
        setMessageNavigation({
          sessionId: anchor.sourceSessionId,
          navigationId: crypto.randomUUID(),
          messageId: anchor.messageId,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
          textBasis: anchor.textBasis ?? MESSAGE_ANCHOR_TEXT_BASIS,
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
    const targetSessionId = previewBackToSideChatId ?? selectedSessionId
    if (!targetSessionId) return false
    const draftOwner =
      previewBackToSideChatId && targetSessionId === previewBackToSideChatId
        ? sideChatConversation
        : conversation
    return commentDraftSaveSucceeded(
      await draftOwner.saveCommentDraft({
        mode: 'create',
        sessionId: targetSessionId,
        commentId: crypto.randomUUID(),
        body,
        anchor,
      }),
    )
  }

  const retryProjectFile = (): void => {
    const targetSessionId = previewBackToSideChatId ?? selectedSessionId
    if (!targetSessionId || !projectFilePanel) return
    void readProjectFile(targetSessionId, projectFilePanel.target)
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

  const purgeSideChatCaches = (scope: { sessionId?: string; projectId?: string }): void => {
    const projectParentIds = scope.projectId
      ? new Set(
          (sessionWorkspace.catalog?.sessions ?? [])
            .filter((item) => item.projectId === scope.projectId)
            .map((item) => item.id),
        )
      : undefined
    setSideChatSessionsById((current) => {
      let changed = false
      const next: Record<string, CollaborationSession> = {}
      for (const [id, entry] of Object.entries(current)) {
        const matchesProject = Boolean(scope.projectId && entry.projectId === scope.projectId)
        const matchesSession = Boolean(
          scope.sessionId && (id === scope.sessionId || entry.parentSessionId === scope.sessionId),
        )
        if (matchesProject || matchesSession) {
          changed = true
          if (entry.parentSessionId) projectParentIds?.add(entry.parentSessionId)
          continue
        }
        next[id] = entry
      }
      return changed ? next : current
    })
    for (const [key, entry] of pendingCreateSideChatRef.current.entries()) {
      if (
        (scope.sessionId && entry.parentSessionId === scope.sessionId) ||
        (projectParentIds && projectParentIds.has(entry.parentSessionId))
      ) {
        pendingCreateSideChatRef.current.delete(key)
      }
    }
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
    purgeSideChatCaches({ sessionId })
    if (selectionEpoch !== userSelectionEpoch.current) return true

    if (selectedSessionId === sessionId) {
      setWorkspaceChangesPanel(undefined)
      setSelectedSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setSideChatsOpen(false)
      setActiveSideChatId(undefined)
      setPreviewBackToSideChatId(undefined)
      setSideChatHandoffKey(undefined)
      setProjectFilePanel(undefined)
      setProjectFilePanelExpanded(false)
    } else if (activeSideChatId === sessionId || previewBackToSideChatId === sessionId) {
      if (activeSideChatId === sessionId) setActiveSideChatId(undefined)
      if (previewBackToSideChatId === sessionId) setPreviewBackToSideChatId(undefined)
      setSideChatHandoffKey(undefined)
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
    purgeSideChatCaches({ projectId })
    if (selectionEpoch !== userSelectionEpoch.current) return true

    const selectedSession = sessionWorkspace.catalog?.sessions.find(
      (session) => session.id === selectedSessionId,
    )
    if (selectedSession?.projectId === projectId) {
      setWorkspaceChangesPanel(undefined)
      setSelectedSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setSideChatsOpen(false)
      setActiveSideChatId(undefined)
      setPreviewBackToSideChatId(undefined)
      setSideChatHandoffKey(undefined)
      setProjectFilePanel(undefined)
      setProjectFilePanelExpanded(false)
    }
    if (creatingProjectId === projectId) {
      beginUserSelection()
      setCreatingProjectId(undefined)
      setCreatingGroupId(undefined)
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
        ? 'Couldn’t confirm whether archiving finished. Check its status before trying again.'
        : state === 'failed'
          ? 'Not archived. Tasks changed or this confirmation expired—review again.'
          : undefined)
    const sidebarRemoved = archiveResultsRef.current.find(
      (entry) => entry.id === id,
    )?.sidebarRemoved
    recordArchiveResult({
      id,
      item: archiveItem(item),
      state,
      preview: item,
      receipt,
      ...(state !== 'archived' && sidebarRemoved ? { sidebarRemoved } : {}),
      ...(message ? { message } : {}),
    })
    if (state === 'archived') {
      // Only durable success permits this idempotent catalog read; it never repeats Stop.
      if (!(await completeArchive(item))) {
        setArchiveActionError(id, 'Archived, but the sidebar couldn’t refresh. Reload to update.')
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
        'Couldn’t confirm whether archiving finished. Check its status before trying again.'
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
      const message = 'Couldn’t check status. Try Check status again.'
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
      showWarning('Already archived. Click Undo to restore it first.')
      return
    }
    if (existing?.sidebarRemoved) {
      showWarning('Already removed from the sidebar. Click Undo to bring it back.')
      return
    }
    if (!existing && archiveResultsRef.current.length >= ARCHIVE_RESULT_LIMIT) {
      showWarning('Dismiss or review older archive results before archiving more items.')
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
      showError('This name is too long to archive. Rename it first.')
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
          : 'Couldn’t prepare archive. Review the item and try again.'
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

  const removeFromSidebar = async (): Promise<void> => {
    const scope = archivePreview?.scope
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (
      scope?.kind !== 'session' ||
      !result ||
      result.state === 'archived' ||
      result.sidebarRemoved ||
      archiveStoppingRef.current
    )
      return
    archiveStoppingRef.current = true
    setArchiveStopping(true)
    setArchiveAction({ id: result.id, kind: 'removing' })
    let removed = false
    try {
      await sessionWorkspace.setSidebarHidden(scope.sessionId, true)
      updateArchiveResults((current) => [
        { ...result, sidebarRemoved: true },
        ...current.filter((entry) => entry.id !== result.id),
      ])
      removed = true
    } catch {
      setArchiveError(
        'Could not confirm removal from the sidebar. Try again to check the saved state.',
      )
    } finally {
      archiveStoppingRef.current = false
      setArchiveStopping(false)
      setArchiveAction(undefined)
    }
    if (removed) closeArchive()
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
      (result.state !== 'archived' && !result.sidebarRemoved) ||
      !archiveResultsRef.current.some((item) => item.id === result.id)
    )
      return
    const item = result.item
    const restoreError = result.sidebarRemoved
      ? 'Could not confirm that the Session is back in the sidebar. Try Undo again.'
      : 'Could not confirm the restore. Try Undo again to check its saved state.'
    if (
      item.kind === 'session' &&
      !projectCatalog.catalog?.projects.some((project) => project.id === item.projectId)
    ) {
      setArchiveActionError(result.id, 'Restore or re-add its Project first, then try Undo again.')
      return
    }
    const selectionEpoch =
      item.kind === 'project' ? beginUserSelection() : userSelectionEpoch.current
    archiveBusyRef.current = true
    setArchiveAction({ id: result.id, kind: 'restoring' })
    setArchiveActionError(result.id)
    try {
      const restored =
        item.kind === 'session'
          ? result.sidebarRemoved
            ? await sessionWorkspace.setSidebarHidden(item.id, false)
            : await sessionWorkspace.restore(item.id)
          : await projectCatalog.restore(item.id)
      if (!restored) {
        setArchiveActionError(result.id, restoreError)
        return
      }
      updateArchiveResults((current) =>
        current.flatMap((entry) => {
          if (entry.id !== result.id) return [entry]
          if (entry.state !== 'unresolved') return []
          const { sidebarRemoved: _removed, ...archive } = entry
          return [archive]
        }),
      )
      if (selectionEpoch !== userSelectionEpoch.current) return
      if (item.kind === 'session') {
        requestSessionLocation(item.projectId, item.id)
      } else {
        invalidateContextRead()
        setWorkspaceChangesPanel(undefined)
        setProjectFilePanel(undefined)
        setSessionSettingsOpen(false)
        setSettingsPage(null)
        setSelectedProjectId(item.id)
        setSelectedSessionId(undefined)
      }
      if (!archiveResultsRef.current.length) settingsButtonRef.current?.focus()
    } catch {
      setArchiveActionError(result.id, restoreError)
    } finally {
      archiveBusyRef.current = false
      setArchiveAction(undefined)
    }
  }

  const toastNotice = toast ? (
    <AppToast key={toast.id} message={toast.message} tone={toast.tone} onDismiss={dismissToast} />
  ) : undefined
  const currentReminder = sessionReminder?.current
  const sessionReminderNotice =
    currentReminder &&
    documentVisible &&
    windowFocused &&
    !toast &&
    !nativeQuitState &&
    !(selectedSessionId === currentReminder.sessionId && conversationVisible) ? (
      <SessionReminder
        key={currentReminder.id}
        reminder={currentReminder}
        pendingCount={sessionReminder?.pending ?? 1}
        aboveComposer={Boolean(selectedSessionId) && conversationVisible && !nativeAttentionOpen}
        onView={() => viewSessionReminder(currentReminder)}
        onDismiss={() => dismissSessionReminder(currentReminder)}
      />
    ) : undefined
  const quitConfirmation = nativeQuitState ? (
    <NativeQuitConfirmation key={nativeQuitState.operationId} state={nativeQuitState} />
  ) : null

  const resolveSideChatTitle = useCallback(
    (sideChatId: string, fallbackTitle: string): string => {
      if (sideChatConversation.snapshot?.session.id === sideChatId) {
        return sideChatConversation.snapshot.session.title
      }
      const cached = sideChatSessionsById[sideChatId]
      if (cached) return cached.title
      const summary = sideChats.items.find((item) => item.id === sideChatId)
      return summary?.title ?? fallbackTitle
    },
    [sideChatConversation.snapshot?.session, sideChatSessionsById, sideChats.items],
  )

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
        {!preparation?.firstUse ? sessionReminderNotice : null}
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

  const resolveSideChatSession = (sideChatId: string): CollaborationSession | undefined => {
    const live =
      sideChatConversation.snapshot?.session.id === sideChatId
        ? sideChatConversation.snapshot.session
        : undefined
    const cached = sideChatSessionsById[sideChatId]
    if (cached && (!selectedMainSession || cached.parentSessionId === selectedMainSession.id)) {
      return live ? { ...cached, ...live } : cached
    }
    if (!selectedMainSession) return undefined
    const summary = sideChats.items.find((item) => item.id === sideChatId)
    const fallback: CollaborationSession = {
      id: sideChatId,
      projectId: summary?.projectId ?? selectedMainSession.projectId,
      parentSessionId: selectedMainSession.id,
      title: summary?.title ?? 'New side chat',
      titleSource: 'placeholder',
      status: summary?.status ?? 'idle',
      activity: {
        state: summary?.needsAttention
          ? 'waiting_for_user'
          : summary?.isRunning
            ? 'agent_working'
            : 'idle',
      },
      hasUnread: false,
      settings: selectedMainSession.settings,
      settingsRevision: selectedMainSession.settingsRevision,
      createdAt: summary?.createdAt ?? selectedMainSession.createdAt,
      updatedAt: summary?.updatedAt ?? selectedMainSession.updatedAt,
      ...(summary ? { sideChatOrigin: summary.origin } : {}),
    }
    return live ? { ...fallback, ...live } : fallback
  }
  const activeSideChatSession = activeSideChatId
    ? resolveSideChatSession(activeSideChatId)
    : undefined

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
            if (enter && opening?.selectionEpoch === userSelectionEpoch.current) {
              selectSession(change.session.id, {
                projectId: change.session.projectId,
                openingId: opening.openingId,
              })
            } else {
              void sessionWorkspace
                .loadPage({
                  projectId: change.session.projectId,
                  scope: sessionScope(change.session),
                })
                .catch(() => undefined)
            }
          }}
          onSaveSessionPermission={(input) => sessionWorkspace.savePermission(input)}
          onSaveSessionSpeed={(input) => sessionWorkspace.saveSpeed(input)}
          projects={projectCatalog.catalog?.projects ?? []}
          sessions={sessionWorkspace.catalog?.sessions ?? []}
          sessionWorkspace={sessionWorkspace}
          navigationIntent={navigationIntent}
          loading={projectCatalog.loading}
          sessionsLoading={sessionWorkspace.loading}
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
          schedulingState={schedulingSettings.state}
          onOpenSettings={(page) => {
            beginUserSelection()
            setNativeAttentionOpen(false)
            invalidateContextRead()
            setWorkspaceChangesPanel(undefined)
            setProjectFilePanel(undefined)
            setSessionSettingsOpen(false)
            setSideChatsOpen(false)
            setPreviewBackToSideChatId(undefined)
            setSettingsPage(page)
          }}
          onBackToApp={backToWorkspace}
          onAddProject={() => void projectCatalog.chooseAndAdd()}
          onArchiveProject={(projectId) => void requestArchive({ kind: 'project', projectId })}
          onRenameProject={(projectId, name) => projectCatalog.rename(projectId, name)}
          onRetry={() => projectCatalog.retry()}
          onRetrySessions={() => sessionWorkspace.retry()}
          selectedSessionId={selectedSessionId}
          selectedProjectId={selectedProjectId}
          creatingProjectId={creatingProjectId}
          creatingGroupId={creatingGroupId}
          creationEditorState={creationEditorState}
          creationLoading={creationLoading}
          sessionSettingsEditorState={sessionSettingsEditorState}
          sessionSettingsLoading={sessionSettingsLoading}
          sessionSettingsOpen={sessionSettingsOpen}
          sideChatsOpen={sideChatsOpen}
          sideChatActiveCount={sideChats.activeCount}
          sideChatAttentionCount={sideChats.attentionCount}
          sideChatUnreadCount={sideChats.unreadCount}
          onOpenSideChats={mainParentSessionId ? openSideChatsList : undefined}
          onBackToSideChat={backToSideChat}
          onOpenBtwSideChat={mainParentSessionId ? openBtwSideChat : undefined}
          onAskInSideChat={mainParentSessionId ? askInSideChat : undefined}
          onOpenSideChat={mainParentSessionId ? openOriginSideChat : undefined}
          resolveSideChatTitle={mainParentSessionId ? resolveSideChatTitle : undefined}
          sideChatsPanel={
            mainParentSessionId ? (
              <SideChatsPanel
                parentSessionId={mainParentSessionId}
                activeSideChatId={activeSideChatId}
                activeSideChatTitle={activeSideChatSession?.title}
                sideChats={sideChats}
                panelOpen={sideChatsOpen && !previewBackToSideChatId}
                creatingSideChat={creatingSideChat}
                onNewSideChat={createBlankSideChat}
                onSelectSideChat={(sideChatId) => openSideChatDetail(sideChatId)}
                onBackToList={() => {
                  if (activeSideChatId) maybeDiscardEmptySideChat(activeSideChatId)
                  setActiveSideChatId(undefined)
                }}
                onClose={() => {
                  invalidateContextRead()
                  setWorkspaceChangesPanel(undefined)
                  setProjectFilePanel(undefined)
                  setProjectFilePanelExpanded(false)
                  setPreviewBackToSideChatId(undefined)
                  setSessionSettingsOpen(false)
                  if (activeSideChatId && maybeDiscardEmptySideChat(activeSideChatId)) {
                    setActiveSideChatId(undefined)
                  }
                  setSideChatsOpen(false)
                }}
                renderDetail={(sideChatId) => {
                  const sideSession = resolveSideChatSession(sideChatId)
                  if (!sideSession || sideSession.parentSessionId !== mainParentSessionId) {
                    return null
                  }
                  return (
                    <ConversationErrorBoundary key={sideChatId}>
                      <ConversationView
                        nativePresentationSuspended={
                          nativeAttentionOpen || Boolean(nativeQuitState)
                        }
                        platform={appInfo?.platform}
                        session={sideSession}
                        schedulingState={schedulingSettings.state}
                        visible={sideChatVisible && sideChatId === activeSideChatId}
                        snapshot={sideChatConversation.snapshot}
                        history={sideChatConversation.history}
                        composer={sideChatConversation.composer}
                        composerImages={sideChatConversation.composerImages}
                        choosingImages={sideChatConversation.choosingImages}
                        onAddComposerImages={sideChatConversation.addComposerImages}
                        onChooseComposerImages={sideChatConversation.chooseComposerImages}
                        onRemoveComposerImage={sideChatConversation.removeComposerImage}
                        onComposerChange={(value) => sideChatConversation.setComposer(value)}
                        onComposerDocumentChange={(value) =>
                          sideChatConversation.setComposerDocument(value)
                        }
                        onOpenSkillDocument={(skill) =>
                          openSideChatSkillDocument(sideChatId, skill)
                        }
                        composerSkills={sideChatConversation.composerSkills}
                        onComposerSkillsChange={(values) =>
                          sideChatConversation.setComposerSkills(values)
                        }
                        composerMention={sideChatConversation.composerMention}
                        composerRoute={sideChatConversation.composerRoute}
                        composerReturnedInputOperationId={
                          sideChatConversation.composerReturnedInputOperationId
                        }
                        composerUserInformation={sideChatConversation.composerUserInformation}
                        composerRevision={sideChatConversation.composerRevision}
                        onClearSubmittedDraft={(expectedRevision) =>
                          sideChatConversation.clearSubmittedComposerDraft(
                            sideChatId,
                            expectedRevision,
                          )
                        }
                        handoffArriveKey={
                          sideChatId === activeSideChatId ? sideChatHandoffKey : undefined
                        }
                        mainTargetAgentId={mainTargetAgentId}
                        onSyncToMain={sideChatConversation.syncToMain}
                        onViewMainMessage={viewSyncedMainMessage}
                        onComposerMentionChange={(value) =>
                          sideChatConversation.setComposerMention(value)
                        }
                        loading={sideChatConversation.loading}
                        sending={sideChatConversation.sending}
                        stopping={sideChatConversation.stopping}
                        agentActionsEnabled={allAgentsReady && sideSession.status !== 'archived'}
                        error={sideChatConversation.error}
                        onSend={(...args) => sideChatConversation.send(...args)}
                        onSaveCommentDraft={(input) => sideChatConversation.saveCommentDraft(input)}
                        onRemoveCommentDraft={(commentId) =>
                          sideChatConversation.removeCommentDraft(commentId)
                        }
                        onOpenComment={openSentComment}
                        onNotice={showWarning}
                        onStop={(background) => sideChatConversation.stop(background)}
                        onRebuildNativeContext={(agentId, options) =>
                          sideChatConversation.rebuildNativeContext(agentId, options)
                        }
                        onCheckNativeContext={(agentId, runId) =>
                          sideChatConversation.checkNativeContext(agentId, runId)
                        }
                        onAcceptPeerProposal={(proposalId) =>
                          sideChatConversation.acceptPeerProposal(proposalId)
                        }
                        onDismissPeerProposal={(proposalId) =>
                          sideChatConversation.dismissPeerProposal(proposalId)
                        }
                        onUndoWorkspaceChanges={async (changeSetId) => {
                          try {
                            return await sideChatConversation.undoWorkspaceChanges(changeSetId)
                          } catch {
                            showError('Pact could not undo these changes.')
                            return false
                          }
                        }}
                        onRespondNativePermission={(operationId, permissionId, decision) =>
                          sideChatConversation.respondNativePermission(
                            operationId,
                            permissionId,
                            decision,
                          )
                        }
                        onRespondNativeInput={(input) =>
                          sideChatConversation.respondNativeInput(input)
                        }
                        nativeInputDrafts={sideChatConversation.nativeInputDrafts}
                        onNativeInputDraftChange={sideChatConversation.setNativeInputDraft}
                        onOpenWorkspaceChanges={(changeSetId, path, expectedGeneration, revision) =>
                          openSideChatWorkspaceChanges(
                            sideChatId,
                            changeSetId,
                            path,
                            expectedGeneration,
                            revision,
                          )
                        }
                        onPrepareWorkspaceChanges={invalidateContextRead}
                        onOpenProjectFile={(target) => openSideChatProjectFile(target, sideChatId)}
                        messageNavigation={
                          messageNavigation?.sessionId === sideChatId
                            ? messageNavigation
                            : undefined
                        }
                      />
                    </ConversationErrorBoundary>
                  )
                }}
              />
            ) : undefined
          }
          projectFilePanel={projectFilePanel}
          workspaceChangesPanel={
            workspaceChangesPanel?.sessionId === selectedSessionId ||
            (activeSideChatId && workspaceChangesPanel?.sessionId === activeSideChatId)
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
          conversationComposerUserInformation={conversation.composerUserInformation}
          conversationComposerRevision={conversation.composerRevision}
          onClearSubmittedConversationDraft={(expectedRevision) => {
            if (selectedSessionId) {
              conversation.clearSubmittedComposerDraft(selectedSessionId, expectedRevision)
            }
          }}
          conversationLoading={conversation.loading}
          sendingMessage={conversation.sending}
          stoppingMessage={conversation.stopping}
          conversationError={conversation.error}
          messageNavigation={
            messageNavigation?.sessionId === selectedSessionId ? messageNavigation : undefined
          }
          onSessionSettingsOpenChange={(open) => {
            setSessionSettingsOpen(open)
            if (!open) {
              invalidateContextRead()
              setWorkspaceChangesPanel(undefined)
              setProjectFilePanel(undefined)
              setProjectFilePanelExpanded(false)
              setPreviewBackToSideChatId(undefined)
              setSideChatsOpen(false)
            }
          }}
          onStartSession={(projectId, groupId) => void startSessionCreation(projectId, groupId)}
          onCancelSessionCreation={() => {
            beginUserSelection()
            setCreatingProjectId(undefined)
            setCreatingGroupId(undefined)
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
          onSendMessage={(...args) => conversation.send(...args)}
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
          onStopRun={(background) => conversation.stop(background)}
          onRebuildNativeContext={(agentId, options) =>
            conversation.rebuildNativeContext(agentId, options)
          }
          onCheckNativeContext={(agentId, runId) => conversation.checkNativeContext(agentId, runId)}
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
                  {...(archivePreview.scope.kind === 'session'
                    ? { onRemove: () => void removeFromSidebar() }
                    : {})}
                  removing={archiveAction?.kind === 'removing'}
                />
              ) : null}
            </>
          }
          toastNotice={toastNotice}
          sessionReminderNotice={sessionReminderNotice}
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
            settingsPage === 'decision-scheduling' ? (
              <DecisionSchedulingSettings state={schedulingSettings} />
            ) : settingsPage === 'updates' ? (
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
          {sessionReminderNotice}
          {toastNotice}
        </>
      ) : null}
      {quitConfirmation}
    </div>
  )
}

export default App
