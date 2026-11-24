import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'

import type {
  AppearanceTheme,
  ProjectCatalogState,
  SessionCatalogChange,
  WindowMaterial,
} from '@pact/contracts'

import type { WorkspaceChangesPanelState } from './components/project-file/WorkspaceChangesPanel'
import type { ContextInspectorTab } from './components/workspace/ContextInspector'
import type { SessionCatalogCache } from './components/workspace/session-catalog-cache'
import type { SettingsPage } from './components/workspace/SettingsNavigation'

import { requiredAgentsForSession } from './app/session-issues'
import { SideChatDetailView } from './app/SideChatDetailView'
import { useAppearanceSettings } from './app/useAppearanceSettings'
import { useAppNotifications, useAutoDismissSessionReminder } from './app/useAppNotifications'
import { useArchiveFlow } from './app/useArchiveFlow'
import { useNativeNavigation, useWindowPresence } from './app/useNativePresenceFlow'
import { useRuntimePreparationFlow, useSessionSettingsFlow } from './app/useSessionSettingsFlow'
import { useSideChatFlow } from './app/useSideChatFlow'
import { useWorkspacePanels } from './app/useWorkspacePanels'
import { useConversation } from './components/conversation/useConversation'
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
import { AboutUpdatesView } from './components/settings/updates/AboutUpdatesView'
import { useAppUpdates } from './components/settings/updates/useAppUpdates'
import { AppToast } from './components/workspace/AppToast'
import { ArchiveConfirmation } from './components/workspace/ArchiveConfirmation'
import { ArchiveNotice } from './components/workspace/ArchiveNotice'
import {
  acceptSessionCatalogChange,
  sessionScope,
} from './components/workspace/session-catalog-cache'
import { SessionReminder } from './components/workspace/SessionReminder'
import { SideChatsPanel } from './components/workspace/SideChatsPanel'
import { useProjectCatalog } from './components/workspace/useProjectCatalog'
import { useSessionWorkspace } from './components/workspace/useSessionWorkspace'
import { useActiveSessionInterest } from './components/workspace/useSideChats'
import { WorkspaceView } from './components/workspace/WorkspaceView'
import { projectCatalogQueryKeys, sessionWorkspaceQueryKeys } from './query-client'

export {
  isBlockingSessionIssuePhase,
  isRequiredSessionIssue,
  requiredAgentsForSession,
} from './app/session-issues'

function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>()
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const [sideChatsOpen, setSideChatsOpen] = useState(false)
  const [activeSideChatId, setActiveSideChatId] = useState<string | undefined>()
  const [previewBackToSideChatId, setPreviewBackToSideChatId] = useState<string | undefined>()
  const [workspaceChangesPanel, setWorkspaceChangesPanel] = useState<WorkspaceChangesPanelState>()
  const [projectFileSessionId, setProjectFileSessionId] = useState<string | undefined>()
  const [inspectorState, setInspectorState] = useState<
    { open: boolean; activeTab: ContextInspectorTab } | undefined
  >()
  const [utilityRecovery, setUtilityRecovery] = useState(0)
  const inspectorNavigationEpochRef = useRef(0)
  const [inspectorNavigationEpoch, setInspectorNavigationEpoch] = useState(0)
  const bumpInspectorNavigationEpoch = useCallback((): void => {
    inspectorNavigationEpochRef.current += 1
    setInspectorNavigationEpoch(inspectorNavigationEpochRef.current)
  }, [])
  const waitForInterestRef = useRef<() => Promise<boolean>>(async () => true)
  const waitForInterest = useCallback((): Promise<boolean> => waitForInterestRef.current(), [])

  const handleInspectorStateChange = useCallback(
    (next: { open: boolean; activeTab: ContextInspectorTab }): void => {
      setInspectorState((current) =>
        current && current.open === next.open && current.activeTab === next.activeTab
          ? current
          : next,
      )
    },
    [],
  )

  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const selectedSessionIdRef = useRef<string | undefined>(selectedSessionId)
  useLayoutEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  const notifications = useAppNotifications()
  const appearance = useAppearanceSettings()
  const presence = useWindowPresence({ showWarning: notifications.showWarning })
  const runtime = useRuntimePreparationFlow({
    documentVisible: presence.documentVisible,
    settingsPage,
  })
  const projectCatalog = useProjectCatalog(runtime.preparation?.firstUse === false)
  const sessionWorkspace = useSessionWorkspace(
    runtime.preparation?.firstUse === false,
    projectCatalog.catalog?.projects,
    () => setUtilityRecovery((current) => current + 1),
  )

  const retainSelectedNavigation = useEffectEvent((id: string | undefined) => {
    sessionWorkspace.retainSelected(id)
  })
  useEffect(() => {
    retainSelectedNavigation(selectedSessionId)
  }, [selectedSessionId])

  const prepareCreationRef = useRef<() => void>(() => undefined)
  const prepareSessionSettingsRef = useRef<() => void>(() => undefined)
  const clearPanelsForSideChatRef = useRef<() => void>(() => undefined)
  const selectParentSessionRef = useRef<(sessionId: string, projectId: string) => void>(
    () => undefined,
  )

  const sessionSettings = useSessionSettingsFlow({
    sessionWorkspace,
    userSelectionEpochRef: presence.userSelectionEpochRef,
    beginUserSelection: presence.beginUserSelection,
    requestSessionLocation: presence.requestSessionLocation,
    recordSessionOpened: presence.recordSessionOpened,
    setSelectedProjectId,
    setSelectedSessionId,
    setSettingsPage,
    setNativeAttentionOpen: presence.setNativeAttentionOpen,
    onPrepareCreation: () => prepareCreationRef.current(),
    onPrepareSessionSettings: () => prepareSessionSettingsRef.current(),
  })

  const conversationVisible =
    presence.documentVisible &&
    !settingsPage &&
    !sessionSettings.creatingProjectId &&
    !presence.nativeAttentionOpen &&
    !presence.nativeQuitState &&
    !runtime.isRuntimePreparationOpen &&
    !runtime.showFirstUseDefaults

  useAutoDismissSessionReminder({
    sessionReminder: notifications.sessionReminder,
    selectedSessionId,
    conversationVisible,
    windowFocused: presence.windowFocused,
    dismissSessionReminder: notifications.dismissSessionReminder,
  })

  const schedulingSettings = useSchedulingSettings(
    runtime.preparation?.firstUse === false &&
      presence.documentVisible &&
      !presence.nativeAttentionOpen &&
      !presence.nativeQuitState &&
      !runtime.isRuntimePreparationOpen &&
      !runtime.showFirstUseDefaults &&
      (settingsPage === 'decision-scheduling' ||
        (!settingsPage && !sessionSettings.creatingProjectId)),
    selectedSessionId,
    settingsPage === 'decision-scheduling',
  )

  const selectedMainSession = sessionWorkspace.catalog?.sessions.find(
    (session) => session.id === selectedSessionId && session.status !== 'archived',
  )
  const mainParentSessionId =
    selectedMainSession && !selectedMainSession.parentSessionId ? selectedMainSession.id : undefined

  const sideChatsTabVisible = inspectorState
    ? inspectorState.open && inspectorState.activeTab === 'sidechats'
    : sideChatsOpen && !previewBackToSideChatId
  const changesTabVisible = inspectorState
    ? inspectorState.open && inspectorState.activeTab === 'changes'
    : Boolean(workspaceChangesPanel)
  const fileTabVisible = inspectorState
    ? inspectorState.open && inspectorState.activeTab === 'file'
    : Boolean(projectFileSessionId)
  const rawSideChatPreviewVisible = Boolean(
    previewBackToSideChatId &&
    ((changesTabVisible && workspaceChangesPanel?.sessionId === previewBackToSideChatId) ||
      (fileTabVisible && projectFileSessionId === previewBackToSideChatId)),
  )

  const conversation = useConversation(
    selectedSessionId,
    notifications.showWarning,
    conversationVisible,
    notifications.showError,
    notifications.showToast,
    { disableAutoInterest: true, waitForInterest },
  )

  const sideChatFlow = useSideChatFlow({
    selectedSessionIdRef,
    selectedMainSession,
    mainParentSessionId,
    sideChatVisible: Boolean(
      conversationVisible && sideChatsOpen && sideChatsTabVisible && activeSideChatId,
    ),
    previewActive: conversationVisible && rawSideChatPreviewVisible,
    sideChatsListVisible: sideChatsOpen && sideChatsTabVisible && !activeSideChatId,
    mainConversation: conversation,
    sessionSettingsOpen: sessionSettings.sessionSettingsOpen,
    waitForInterest,
    sideChatsOpen,
    setSideChatsOpen,
    activeSideChatId,
    setActiveSideChatId,
    previewBackToSideChatId,
    setPreviewBackToSideChatId,
    sessionWorkspace,
    userSelectionEpochRef: presence.userSelectionEpochRef,
    inspectorNavigationEpochRef,
    showWarning: notifications.showWarning,
    showError: notifications.showError,
    showToast: notifications.showToast,
    onClearPanelsForSideChat: () => clearPanelsForSideChatRef.current(),
    onInspectorNavigate: bumpInspectorNavigationEpoch,
    onSelectParentSession: (sessionId, projectId) =>
      selectParentSessionRef.current(sessionId, projectId),
  })

  const panels = useWorkspacePanels({
    selectedSessionId,
    selectedSessionIdRef,
    activeSideChatId,
    previewBackToSideChatId,
    workspaceChangesPanel,
    setWorkspaceChangesPanel,
    projectFileSessionId,
    setProjectFileSessionId,
    changesTabVisible: conversationVisible && changesTabVisible,
    waitForInterest,
    utilityRecovery,
    onInspectorNavigate: bumpInspectorNavigationEpoch,
    conversation,
    sideChatConversation: sideChatFlow.conversation,
    setSessionSettingsOpen: sessionSettings.setSessionSettingsOpen,
    setSessionSettingsEditorState: sessionSettings.setSessionSettingsEditorState,
    setSideChatsOpen,
    setActiveSideChatId,
    setPreviewBackToSideChatId,
    maybeDiscardEmptySideChat: sideChatFlow.maybeDiscardEmptySideChat,
    openSideChatDetail: sideChatFlow.openSideChatDetail,
    showToast: notifications.showToast,
  })

  const activeSideChatSession = activeSideChatId
    ? sideChatFlow.resolveSideChatSession(activeSideChatId)
    : undefined
  const previewSideChatSession = previewBackToSideChatId
    ? sideChatFlow.resolveSideChatSession(previewBackToSideChatId)
    : undefined
  const activeSideChatDetailVisibleId =
    conversationVisible &&
    sideChatsOpen &&
    sideChatsTabVisible &&
    activeSideChatId &&
    activeSideChatSession &&
    activeSideChatSession.parentSessionId === mainParentSessionId
      ? activeSideChatId
      : undefined
  const sideChatPreviewVisible = inspectorState
    ? inspectorState.open &&
      ((inspectorState.activeTab === 'changes' &&
        Boolean(
          previewBackToSideChatId &&
          panels.visibleWorkspaceChangesPanel?.sessionId === previewBackToSideChatId,
        )) ||
        (inspectorState.activeTab === 'file' &&
          Boolean(
            previewBackToSideChatId && panels.projectFileSessionId === previewBackToSideChatId,
          )))
    : Boolean(
        previewBackToSideChatId &&
        (panels.visibleWorkspaceChangesPanel?.sessionId === previewBackToSideChatId ||
          panels.projectFileSessionId === previewBackToSideChatId),
      )
  const sideChatPreviewSubscriptionId =
    conversationVisible &&
    sideChatPreviewVisible &&
    previewBackToSideChatId &&
    previewSideChatSession &&
    previewSideChatSession.parentSessionId === mainParentSessionId
      ? previewBackToSideChatId
      : undefined
  const subscribedSideChatId = activeSideChatDetailVisibleId ?? sideChatPreviewSubscriptionId

  const mainInterest = useActiveSessionInterest(
    [selectedSessionId, subscribedSideChatId],
    conversationVisible && Boolean(selectedSessionId),
    utilityRecovery,
  )
  useLayoutEffect(() => {
    waitForInterestRef.current = mainInterest.waitForReady
  }, [mainInterest.waitForReady])

  const refreshAfterUtilityRecovery = useEffectEvent(() => {
    void runtime.refetchRuntimePreparation()
    conversation.history.retryRead()
    if (activeSideChatId) sideChatFlow.conversation.history.retryRead()
  })
  useEffect(() => {
    if (utilityRecovery > 0) refreshAfterUtilityRecovery()
  }, [utilityRecovery])

  const exitNoticeCheckedRef = useRef(false)
  useEffect(() => {
    if (exitNoticeCheckedRef.current || !runtime.preparation || runtime.preparation.firstUse) {
      return
    }
    exitNoticeCheckedRef.current = true
    void window.pact
      .consumeTerminalLastExitNotice?.()
      .then((result) => {
        if (!result?.ok || !result.value) return undefined
        const { unconfirmedCount } = result.value
        notifications.showWarning(
          `${unconfirmedCount} background ${unconfirmedCount === 1 ? 'terminal session' : 'terminal sessions'} may not have finished closing before the previous exit.`,
        )
        return undefined
      })
      .catch(() => undefined)
  }, [runtime.preparation, notifications])

  const updates = useAppUpdates(
    () => {
      presence.setNativeAttentionOpen(false)
      setSettingsPage('updates')
    },
    notifications.showToast,
    !notifications.toast &&
      !notifications.sessionReminder &&
      !presence.nativeQuitState &&
      runtime.preparation?.firstUse === false,
  )

  const showWorkspace = (): void => {
    presence.beginUserSelection()
    presence.setNativeAttentionOpen(false)
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
    if (!options?.native) presence.beginUserSelection()
    bumpInspectorNavigationEpoch()
    presence.setNativeAttentionOpen(false)
    panels.clearContextPanels({ clearMessageNavigation: true })
    setSettingsPage(null)
    sessionSettings.clearCreationState()
    sessionSettings.clearSessionSettingsState()
    if (activeSideChatId && !previewBackToSideChatId) {
      sideChatFlow.maybeDiscardEmptySideChat(activeSideChatId)
    }
    setSideChatsOpen(false)
    setActiveSideChatId(undefined)
    setPreviewBackToSideChatId(undefined)
    sideChatFlow.setSideChatHandoffKey(undefined)
    const session = sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId)
    const projectId = options?.projectId ?? session?.projectId
    setSelectedProjectId(projectId)
    sessionWorkspace.retainSelected(sessionId)
    setSelectedSessionId(sessionId)
    if (options?.projectId && !options.sidebarHidden)
      presence.requestSessionLocation(options.projectId, sessionId)
    if (!options?.skipOpenedRecord) {
      presence.recordSessionOpened(sessionId, options?.openingId ?? crypto.randomUUID())
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
      notifications.showWarning(
        'This Session is no longer available. Open its Project to review its status.',
      )
      return
    }
    if (runtime.preparation && !runtime.preparation.firstUse)
      runtime.setIsRuntimePreparationOpen(false)
    selectSession(accepted.id, {
      projectId: accepted.projectId,
      openingId,
      native: true,
      sidebarHidden: accepted.sidebarHidden,
      skipOpenedRecord: Boolean(change.resolvedSideChat),
    })
    if (change.resolvedSideChat && change.resolvedSideChat.status !== 'archived') {
      sideChatFlow.applyResolvedSideChat(change.resolvedSideChat)
    }
  }

  useLayoutEffect(() => {
    prepareCreationRef.current = () => {
      bumpInspectorNavigationEpoch()
      panels.clearContextPanels()
      if (activeSideChatId) {
        sideChatFlow.maybeDiscardEmptySideChat(activeSideChatId)
      }
      setActiveSideChatId(undefined)
      setSideChatsOpen(false)
      setPreviewBackToSideChatId(undefined)
      sideChatFlow.setSideChatHandoffKey(undefined)
    }
    prepareSessionSettingsRef.current = () => {
      bumpInspectorNavigationEpoch()
      panels.clearContextPanels()
      if (activeSideChatId) {
        sideChatFlow.maybeDiscardEmptySideChat(activeSideChatId)
      }
      setSideChatsOpen(false)
      setPreviewBackToSideChatId(undefined)
    }
    clearPanelsForSideChatRef.current = () => {
      panels.clearContextPanels()
      sessionSettings.clearSessionSettingsState()
    }
    selectParentSessionRef.current = (sessionId, projectId) => {
      selectSession(sessionId, { projectId })
    }
  })

  const { openAttentionSession } = useNativeNavigation({
    presence,
    showWarning: notifications.showWarning,
    onEnterResolvedSession: enterResolvedSession,
    onBackToWorkspace: backToWorkspace,
  })

  const clearSelectedSessionState = (): void => {
    bumpInspectorNavigationEpoch()
    panels.clearContextPanels()
    setSelectedSessionId(undefined)
    sessionSettings.clearSessionSettingsState()
    setSideChatsOpen(false)
    setActiveSideChatId(undefined)
    setPreviewBackToSideChatId(undefined)
    sideChatFlow.setSideChatHandoffKey(undefined)
  }

  const archive = useArchiveFlow({
    projectCatalog,
    sessionWorkspace,
    userSelectionEpochRef: presence.userSelectionEpochRef,
    beginUserSelection: presence.beginUserSelection,
    requestSessionLocation: presence.requestSessionLocation,
    settingsButtonRef,
    showWarning: notifications.showWarning,
    showError: notifications.showError,
    purgeSideChatCaches: sideChatFlow.purgeSideChatCaches,
    onSessionArchived: (sessionId, projectId) => {
      if (selectedSessionIdRef.current === sessionId) {
        clearSelectedSessionState()
      } else if (activeSideChatId === sessionId || previewBackToSideChatId === sessionId) {
        if (activeSideChatId === sessionId) setActiveSideChatId(undefined)
        if (previewBackToSideChatId === sessionId) setPreviewBackToSideChatId(undefined)
        sideChatFlow.setSideChatHandoffKey(undefined)
      }
      setSelectedProjectId(projectId)
    },
    onProjectArchived: (projectId) => {
      void import('./components/terminal/terminal-view-cache')
        .then((module) => module.disposeProjectTerminalViews(projectId))
        .catch(() => undefined)
      const selectedSession = sessionWorkspace.catalog?.sessions.find(
        (session) => session.id === selectedSessionIdRef.current,
      )
      if (selectedSession?.projectId === projectId) {
        clearSelectedSessionState()
      }
      if (sessionSettings.creatingProjectId === projectId) {
        sessionSettings.cancelSessionCreation()
      }
      if (selectedProjectId === projectId) setSelectedProjectId(undefined)
    },
    onProjectRestored: (projectId) => {
      panels.clearContextPanels()
      sessionSettings.setSessionSettingsOpen(false)
      setSettingsPage(null)
      setSelectedProjectId(projectId)
      setSelectedSessionId(undefined)
    },
  })

  const undoMainWorkspaceChanges = async (changeSetId: string, path?: string): Promise<boolean> => {
    try {
      return await conversation.undoWorkspaceChanges(changeSetId, path)
    } catch {
      notifications.showError('Pact could not undo these changes.')
      return false
    }
  }

  const undoSideChatWorkspaceChanges = async (
    changeSetId: string,
    path?: string,
  ): Promise<boolean> => {
    try {
      return await sideChatFlow.conversation.undoWorkspaceChanges(changeSetId, path)
    } catch {
      notifications.showError('Pact could not undo these changes.')
      return false
    }
  }

  const undoWorkspaceFile = async (changeSetId: string, path: string): Promise<boolean> => {
    if (
      activeSideChatId &&
      panels.visibleWorkspaceChangesPanel?.sessionId === activeSideChatId &&
      panels.visibleWorkspaceChangesPanel.changeSetId === changeSetId
    ) {
      return undoSideChatWorkspaceChanges(changeSetId, path)
    }
    return undoMainWorkspaceChanges(changeSetId, path)
  }

  const toastNotice = notifications.toast ? (
    <AppToast
      key={notifications.toast.id}
      message={notifications.toast.message}
      tone={notifications.toast.tone}
      onDismiss={notifications.dismissToast}
    />
  ) : undefined
  const currentReminder = notifications.sessionReminder?.current
  const sessionReminderNotice =
    currentReminder &&
    presence.documentVisible &&
    presence.windowFocused &&
    !notifications.toast &&
    !presence.nativeQuitState &&
    !(selectedSessionId === currentReminder.sessionId && conversationVisible) ? (
      <SessionReminder
        key={currentReminder.id}
        reminder={currentReminder}
        pendingCount={notifications.sessionReminder?.pending ?? 1}
        aboveComposer={
          Boolean(selectedSessionId) && conversationVisible && !presence.nativeAttentionOpen
        }
        onView={() => notifications.viewSessionReminder(currentReminder)}
        onDismiss={() => notifications.dismissSessionReminder(currentReminder)}
      />
    ) : undefined
  const quitConfirmation = presence.nativeQuitState ? (
    <NativeQuitConfirmation
      key={presence.nativeQuitState.operationId}
      state={presence.nativeQuitState}
    />
  ) : null

  const { preparation, readyAgentSet } = runtime

  if (
    settingsPage !== 'updates' &&
    (!preparation ||
      (preparation.firstUse && !runtime.showFirstUseDefaults) ||
      runtime.isRuntimePreparationOpen)
  ) {
    return (
      <>
        <RuntimePreparationView
          preparation={preparation}
          loading={runtime.loading}
          choosingAgent={runtime.choosingAgent}
          error={runtime.preparationError}
          canReturnToWorkspace={Boolean(preparation && !preparation.firstUse)}
          onBack={() => runtime.setIsRuntimePreparationOpen(false)}
          onRetry={() => void runtime.refetchRuntimePreparation()}
          onContinue={() => {
            if (preparation?.firstUse) runtime.setShowFirstUseDefaults(true)
            else runtime.setIsRuntimePreparationOpen(false)
          }}
          onChooseExecutable={(agentId) => void runtime.chooseRuntimeExecutable(agentId)}
        />
        {!preparation?.firstUse ? sessionReminderNotice : null}
        {toastNotice}
        {quitConfirmation}
      </>
    )
  }

  if (settingsPage !== 'updates' && preparation?.firstUse && runtime.showFirstUseDefaults) {
    return (
      <>
        <DefaultSessionOnboardingView
          editorState={runtime.defaultSessionSettings.editorState}
          runtimePreparation={preparation}
          loading={runtime.defaultSessionSettings.loading}
          saving={runtime.defaultSessionSettings.saving}
          saveError={runtime.defaultSessionSettings.saveError}
          loadError={runtime.defaultSessionSettings.loadError}
          onRetry={() => runtime.defaultSessionSettings.retry()}
          onSave={(nextSettings) => void runtime.saveDefaultSessionSettings(nextSettings)}
        />
        {toastNotice}
        {quitConfirmation}
      </>
    )
  }

  const activeSideChatHasLockedSettings = activeSideChatId
    ? sideChatFlow.hasLockedSideChatSettings(activeSideChatId)
    : false
  const mainRequiredAgents = selectedMainSession
    ? requiredAgentsForSession(selectedMainSession, conversation.snapshot?.sessionIssues)
    : undefined
  const activeSideChatRequiredAgents =
    activeSideChatDetailVisibleId && activeSideChatSession && activeSideChatHasLockedSettings
      ? requiredAgentsForSession(
          activeSideChatSession,
          sideChatFlow.conversation.snapshot?.session.id === activeSideChatSession.id
            ? sideChatFlow.conversation.snapshot.sessionIssues
            : undefined,
        )
      : undefined
  const activeWorkspaceDiff =
    changesTabVisible && panels.visibleWorkspaceChangesPanel
      ? {
          sessionId: panels.visibleWorkspaceChangesPanel.sessionId,
          changeSetId: panels.visibleWorkspaceChangesPanel.changeSetId,
          path: panels.visibleWorkspaceChangesPanel.path,
        }
      : undefined
  const closeRightContext = (): void => {
    bumpInspectorNavigationEpoch()
    panels.clearContextPanels()
    setPreviewBackToSideChatId(undefined)
    sessionSettings.setSessionSettingsOpen(false)
    if (activeSideChatId && sideChatFlow.maybeDiscardEmptySideChat(activeSideChatId)) {
      setActiveSideChatId(undefined)
    }
    setSideChatsOpen(false)
  }
  const relevantWorkspaceAgents = mainRequiredAgents
    ? [...new Set([...mainRequiredAgents, ...(activeSideChatRequiredAgents ?? [])])]
    : undefined
  const mainActionsEnabled = Boolean(
    preparation &&
    (mainRequiredAgents
      ? mainRequiredAgents.every((agentId) => readyAgentSet.has(agentId))
      : readyAgentSet.size >= 2),
  )
  const showRuntimeNotice = Boolean(
    preparation &&
    (relevantWorkspaceAgents
      ? relevantWorkspaceAgents.some((agentId) => !readyAgentSet.has(agentId))
      : readyAgentSet.size < 2),
  )

  return (
    <div className="relative h-full min-h-0">
      <div
        className="h-full min-h-0"
        inert={presence.nativeAttentionOpen || Boolean(presence.nativeQuitState)}
        aria-hidden={presence.nativeAttentionOpen || undefined}
        style={{ visibility: presence.nativeAttentionOpen ? 'hidden' : 'visible' }}
      >
        <WorkspaceView
          runtimePreparation={preparation}
          onForkSessionStarted={() => ({
            selectionEpoch: presence.beginUserSelection(),
            openingId: crypto.randomUUID(),
          })}
          nativePresentationSuspended={
            presence.nativeAttentionOpen || Boolean(presence.nativeQuitState)
          }
          platform={runtime.appInfo?.platform}
          onForkSessionCreated={(change, enter, opening) => {
            acceptSessionCatalogChange(queryClient, change)
            if (enter && opening?.selectionEpoch === presence.userSelectionEpochRef.current) {
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
          navigationIntent={presence.navigationIntent}
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
            presence.beginUserSelection()
            bumpInspectorNavigationEpoch()
            presence.setNativeAttentionOpen(false)
            panels.clearContextPanels()
            sessionSettings.setSessionSettingsOpen(false)
            setSideChatsOpen(false)
            setPreviewBackToSideChatId(undefined)
            setSettingsPage(page)
          }}
          onBackToApp={backToWorkspace}
          onAddProject={() => void projectCatalog.chooseAndAdd()}
          onArchiveProject={(projectId) =>
            void archive.requestArchive({ kind: 'project', projectId })
          }
          onRenameProject={(projectId, name) => projectCatalog.rename(projectId, name)}
          onRetry={() => projectCatalog.retry()}
          onRetrySessions={() => sessionWorkspace.retry()}
          selectedSessionId={selectedSessionId}
          selectedProjectId={selectedProjectId}
          creatingProjectId={sessionSettings.creatingProjectId}
          creatingGroupId={sessionSettings.creatingGroupId}
          creationEditorState={sessionSettings.creationEditorState}
          creationLoading={sessionSettings.creationLoading}
          sessionSettingsEditorState={sessionSettings.sessionSettingsEditorState}
          sessionSettingsLoading={sessionSettings.sessionSettingsLoading}
          sessionSettingsOpen={sessionSettings.sessionSettingsOpen}
          sessionSettingsNavigationToken={sessionSettings.sessionSettingsNavigationToken}
          collaborationTask={sideChatFlow.collaborationTask}
          sideChatsOpen={sideChatsOpen}
          sideChatNavigationToken={sideChatFlow.sideChatNavigationToken}
          changesNavigationToken={panels.changesNavigationToken}
          fileNavigationToken={panels.fileNavigationToken}
          inspectorNavigationEpoch={inspectorNavigationEpoch}
          overlayCloseToken={panels.overlayCloseToken}
          sideChatActiveCount={sideChatFlow.sideChats.activeCount}
          sideChatAttentionCount={sideChatFlow.sideChats.attentionCount}
          sideChatUnreadCount={sideChatFlow.sideChats.unreadCount}
          onInspectorStateChange={handleInspectorStateChange}
          onInspectorNavigate={bumpInspectorNavigationEpoch}
          onRegisterChangesNavigationGuard={panels.registerChangesNavigationGuard}
          onConfirmExternalWorkspaceChanges={panels.confirmExternalWorkspaceChanges}
          onFocusChangesTab={panels.focusChangesTab}
          onOpenSideChats={mainParentSessionId ? () => sideChatFlow.openSideChatsList() : undefined}
          onBackToSideChat={sideChatFlow.backToSideChat}
          onOpenBtwSideChat={mainParentSessionId ? sideChatFlow.openBtwSideChat : undefined}
          onAskInSideChat={mainParentSessionId ? sideChatFlow.askInSideChat : undefined}
          onOpenSideChat={mainParentSessionId ? sideChatFlow.openOriginSideChat : undefined}
          resolveSideChatTitle={mainParentSessionId ? sideChatFlow.resolveSideChatTitle : undefined}
          sideChatsPanel={
            mainParentSessionId ? (
              <SideChatsPanel
                parentSessionId={mainParentSessionId}
                activeSideChatId={activeSideChatId}
                activeSideChatTitle={activeSideChatSession?.title}
                sideChats={sideChatFlow.sideChats}
                panelOpen={sideChatsOpen && sideChatsTabVisible}
                creatingSideChat={sideChatFlow.creatingSideChat}
                onNewSideChat={sideChatFlow.createBlankSideChat}
                onSelectSideChat={(sideChatId) => sideChatFlow.openSideChatDetail(sideChatId)}
                onBackToList={() => {
                  if (activeSideChatId) sideChatFlow.maybeDiscardEmptySideChat(activeSideChatId)
                  panels.invalidateContextRead()
                  setActiveSideChatId(undefined)
                }}
                onClose={closeRightContext}
                renderDetail={(sideChatId) => (
                  <SideChatDetailView
                    sideChatId={sideChatId}
                    mainParentSessionId={mainParentSessionId}
                    activeSideChatId={activeSideChatId}
                    sideSession={sideChatFlow.resolveSideChatSession(sideChatId)}
                    lockedSettingsLoaded={sideChatFlow.hasLockedSideChatSettings(sideChatId)}
                    sideChatSettingsState={sideChatFlow.sideChatSettingsState}
                    onRetrySideChatSettings={sideChatFlow.retrySideChatSettings}
                    sideChatConversation={sideChatFlow.conversation}
                    sideChatVisible={sideChatFlow.sideChatVisible}
                    sideChatHandoffKey={sideChatFlow.sideChatHandoffKey}
                    mainTargetAgentId={sideChatFlow.mainTargetAgentId}
                    mainActionsEnabled={mainActionsEnabled}
                    preparation={preparation}
                    readyAgentSet={readyAgentSet}
                    nativePresentationSuspended={
                      presence.nativeAttentionOpen || Boolean(presence.nativeQuitState)
                    }
                    platform={runtime.appInfo?.platform}
                    schedulingState={schedulingSettings.state}
                    messageNavigation={panels.messageNavigation}
                    onViewMainMessage={panels.viewSyncedMainMessage}
                    onOpenComment={panels.openSentComment}
                    onNotice={notifications.showWarning}
                    onOpenSkillDocument={panels.openSideChatSkillDocument}
                    onOpenWorkspaceChanges={panels.openSideChatWorkspaceChanges}
                    onPrepareWorkspaceChanges={panels.invalidateContextRead}
                    onOpenProjectFile={panels.openSideChatProjectFile}
                    onUndoWorkspaceChanges={undoSideChatWorkspaceChanges}
                    onUndoWorkspaceFile={(changeSetId, path) =>
                      undoSideChatWorkspaceChanges(changeSetId, path)
                    }
                    activeWorkspaceDiff={activeWorkspaceDiff}
                    activeWorkspaceFilePath={
                      changesTabVisible &&
                      activeSideChatId &&
                      panels.visibleWorkspaceChangesPanel?.sessionId === activeSideChatId
                        ? panels.visibleWorkspaceChangesPanel.path
                        : undefined
                    }
                  />
                )}
              />
            ) : undefined
          }
          projectFilePanel={panels.projectFilePanel}
          projectFileSessionId={panels.projectFileSessionId}
          workspaceChangesPanel={panels.visibleWorkspaceChangesPanel}
          activeWorkspaceDiff={activeWorkspaceDiff}
          activeWorkspaceFilePath={
            changesTabVisible &&
            selectedSessionId &&
            panels.visibleWorkspaceChangesPanel?.sessionId === selectedSessionId
              ? panels.visibleWorkspaceChangesPanel.path
              : undefined
          }
          projectFilePanelExpanded={panels.projectFilePanelExpanded}
          conversation={conversation.snapshot}
          sideChatConversation={sideChatFlow.conversation.snapshot}
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
            panels.messageNavigation?.sessionId === selectedSessionId
              ? panels.messageNavigation
              : undefined
          }
          onSessionSettingsOpenChange={(open) => {
            if (!open) {
              closeRightContext()
            } else {
              sessionSettings.setSessionSettingsOpen(true)
            }
          }}
          onStartSession={(projectId, groupId) =>
            void sessionSettings.startSessionCreation(projectId, groupId)
          }
          onCancelSessionCreation={sessionSettings.cancelSessionCreation}
          onCreateSession={(projectId, nextSettings) =>
            void sessionSettings.createSession(projectId, nextSettings)
          }
          onSelectSession={selectSession}
          onOpenSessionSettings={(sessionId) => void sessionSettings.openSessionSettings(sessionId)}
          onRetrySessionSettings={(sessionId) =>
            void sessionSettings.openSessionSettings(sessionId)
          }
          onSaveSessionSettings={(sessionId, nextSettings) =>
            void sessionSettings.saveSessionSettings(sessionId, nextSettings)
          }
          onArchiveSession={(sessionId) =>
            void archive.requestArchive({ kind: 'session', sessionId })
          }
          onRenameSession={(sessionId, title) => sessionWorkspace.rename(sessionId, title)}
          onSendMessage={(...args) => conversation.send(...args)}
          onSaveCommentDraft={(input) => conversation.saveCommentDraft(input)}
          onRemoveCommentDraft={(commentId) => conversation.removeCommentDraft(commentId)}
          onOpenComment={panels.openSentComment}
          onNotice={notifications.showWarning}
          onConversationComposerChange={(value) => conversation.setComposer(value)}
          onConversationComposerDocumentChange={(value) => conversation.setComposerDocument(value)}
          onOpenSkillDocument={(skill) => {
            if (selectedSessionId) void panels.readSkillDocument(selectedSessionId, skill)
          }}
          skillDocumentPanel={panels.skillDocumentPanel}
          onRetrySkillDocument={() => {
            if (panels.skillDocumentPanel)
              void panels.readSkillDocument(
                panels.skillDocumentPanel.sessionId,
                panels.skillDocumentPanel.skill,
              )
          }}
          onConversationComposerMentionChange={(value) => conversation.setComposerMention(value)}
          onCreateFileComment={panels.createFileComment}
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
          onUndoWorkspaceChanges={undoMainWorkspaceChanges}
          onUndoWorkspaceFile={undoWorkspaceFile}
          onOpenWorkspaceChanges={panels.openWorkspaceChanges}
          onPrepareWorkspaceChanges={panels.invalidateContextRead}
          onOpenProjectFile={panels.openProjectFile}
          onProjectFilePanelExpandedChange={panels.setProjectFilePanelExpanded}
          onRetryProjectFile={panels.retryProjectFile}
          archiveNotice={
            <>
              {archive.archiveResults.length ? (
                <ArchiveNotice
                  results={archive.archiveResults}
                  action={archive.archiveAction}
                  blocked={Boolean(archive.archivePreview || archive.archiveAction)}
                  onUndo={(result) => void archive.restoreArchived(result)}
                  onCheck={(result) => void archive.checkArchiveResult(result)}
                  onReview={(result) =>
                    void archive.requestArchive(
                      result.preview?.scope ??
                        (result.item.kind === 'session'
                          ? { kind: 'session', sessionId: result.item.id }
                          : { kind: 'project', projectId: result.item.id }),
                      result.id,
                    )
                  }
                  onDismiss={archive.dismissArchiveResults}
                />
              ) : null}
              {archive.archivePreview &&
              !presence.nativeQuitState &&
              !presence.nativeAttentionOpen ? (
                <ArchiveConfirmation
                  preview={archive.archivePreview}
                  busy={archive.archiveStopping}
                  {...(archive.archiveReceipt ? { receipt: archive.archiveReceipt } : {})}
                  {...(archive.archiveError ? { error: archive.archiveError } : {})}
                  uncertain={archive.archiveResults.some(
                    (result) =>
                      result.id === archive.archiveResultId && result.state === 'unresolved',
                  )}
                  onCancel={archive.closeArchive}
                  onConfirm={() => void archive.confirmArchive()}
                  onCheck={() => void archive.checkArchive()}
                  onReview={archive.reviewArchive}
                  {...(archive.archivePreview.scope.kind === 'session'
                    ? { onRemove: () => void archive.removeFromSidebar() }
                    : {})}
                  removing={archive.archiveAction?.kind === 'removing'}
                />
              ) : null}
            </>
          }
          toastNotice={toastNotice}
          sessionReminderNotice={sessionReminderNotice}
          settingsButtonRef={settingsButtonRef}
          agentActionsEnabled={mainActionsEnabled}
          runtimeNotice={
            !showRuntimeNotice || !preparation ? undefined : (
              <RuntimeDegradedNotice
                preparation={preparation}
                relevantAgentIds={relevantWorkspaceAgents}
                onReview={() => {
                  panels.invalidateContextRead()
                  panels.clearWorkspaceChangesPanel()
                  sessionSettings.setSessionSettingsOpen(false)
                  runtime.setIsRuntimePreparationOpen(true)
                }}
                onRetry={() => void runtime.refetchRuntimePreparation()}
              />
            )
          }
          settingsView={
            settingsPage === 'decision-scheduling' ? (
              <DecisionSchedulingSettings state={schedulingSettings} />
            ) : settingsPage === 'updates' ? (
              <AboutUpdatesView
                appInfo={runtime.appInfo}
                state={updates.state}
                busy={updates.busy}
                error={updates.error}
                onCheck={() => void updates.check()}
                onRetry={() => void updates.retry()}
                onAutoCheckChange={(value) => void updates.setAutoCheck(value)}
              />
            ) : settingsPage === 'appearance' ? (
              <AppearanceSettingsView
                settings={appearance.settings}
                effective={appearance.snapshot?.effective}
                loading={appearance.loading}
                saving={appearance.saving}
                loadError={appearance.loadError}
                saveError={appearance.saveError}
                onThemeChange={(theme: AppearanceTheme) =>
                  void appearance.save('update', { theme })
                }
                onMaterialChange={(windowMaterial: WindowMaterial) =>
                  void appearance.save('update', { windowMaterial })
                }
                onMaterialOpacityPreview={(materialOpacity) =>
                  appearance.setPreview({ materialOpacity })
                }
                onMaterialOpacityCommit={appearance.saveMaterialOpacity}
                onReset={() => void appearance.save('reset')}
                onRetry={appearance.retry}
                platform={runtime.appInfo?.platform}
              />
            ) : settingsPage === 'session-defaults' ? (
              <DefaultSessionSettingsView
                key={
                  runtime.defaultSessionSettings.editorState?.current?.updatedAt ??
                  'default-session-new'
                }
                editorState={runtime.defaultSessionSettings.editorState}
                runtimePreparation={preparation}
                loading={runtime.defaultSessionSettings.loading}
                saving={runtime.defaultSessionSettings.saving}
                saveError={runtime.defaultSessionSettings.saveError}
                loadError={runtime.defaultSessionSettings.loadError}
                firstUse={false}
                onRetry={() => runtime.defaultSessionSettings.retry()}
                onSave={(nextSettings) => void runtime.saveDefaultSessionSettings(nextSettings)}
              />
            ) : undefined
          }
        />
      </div>
      {presence.nativeAttentionOpen ? (
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
