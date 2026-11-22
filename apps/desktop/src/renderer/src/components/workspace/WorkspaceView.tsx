import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { SkillSelection } from '@pact/contracts'
import type {
  CollaborationSession,
  CollaborationTask,
  AnchoredComment,
  FileCommentAnchor,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  Project,
  RuntimePreparation,
  SessionSettingsEditorState,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SessionCatalogChange,
  ProjectNameChange,
  RpcResult,
  SchedulingState,
} from '@pact/contracts'

import type {
  CreateFileCommentOptions,
  WorkspaceChangesNavigationGuard,
  WorkspaceChangesNavigationTarget,
  WorkspaceProjectFilePanelState,
} from '../../app/useWorkspacePanels'
import type { ComposerDocument } from '../conversation/composer-document'
import type { ConversationViewProjection } from '../conversation/conversation-window'
import type { ProjectFileTarget } from '../conversation/MessageMarkdown'
import type { MessageTextSelection } from '../conversation/MessageSelectionSurface'
import type { SessionForkOpening } from '../conversation/SessionFork'
import type {
  CommentDraftSaveOutcome,
  ConversationComposerMention,
  ConversationHistoryControls,
  ConversationFlow,
} from '../conversation/useConversation'
import type { RelayDecisionPresentation } from '../scheduling/RelayDecisionCard'
import type { NavigationIntent } from './ProjectNavigation'
import type { SessionWorkspaceFlow } from './useSessionWorkspace'

import { nativeRecoveryTargets } from '../conversation/conversation-window'
import { ConversationView, type ConversationViewProps } from '../conversation/ConversationView'
import {
  SkillDocumentPanel,
  type SkillDocumentPanelState,
} from '../conversation/SkillDocumentPanel'
import { ProjectFilePanel } from '../project-file/ProjectFilePanel'
import {
  WorkspaceChangesPanel,
  type WorkspaceChangesPanelState,
} from '../project-file/WorkspaceChangesPanel'
import { SessionSettingsPanel } from '../settings/session/SessionSettingsPanel'
import { ContextInspector, type ContextInspectorTab } from './ContextInspector'
import { ConversationErrorBoundary } from './ConversationErrorBoundary'
import { ProjectNavigation } from './ProjectNavigation'
import { SessionCreationView } from './SessionCreationView'
import { SessionHeader } from './SessionHeader'
import { SettingsNavigation, type SettingsPage } from './SettingsNavigation'
import {
  SideChatsInspectorContext,
  SideChatsPanel,
  type SideChatsPanelProps,
} from './SideChatsPanel'
import { ProjectEmptyState, ProjectReadyState } from './WorkspaceEmptyStates'
import { WorkspaceShell } from './WorkspaceShell'

export interface ActiveWorkspaceDiffTarget {
  sessionId: string
  changeSetId: string
  path: string
}

const ConversationViewWithDiff: React.ComponentType<
  ConversationViewProps & { activeWorkspaceDiff?: ActiveWorkspaceDiffTarget | undefined }
> = ConversationView

interface WorkspaceViewProps {
  runtimePreparation?: RuntimePreparation | undefined
  onForkSessionCreated: (
    change: SessionCatalogChange,
    enter: boolean,
    opening?: SessionForkOpening,
  ) => void
  onForkSessionStarted?: (() => SessionForkOpening) | undefined
  nativePresentationSuspended?: boolean | undefined
  platform?: string | undefined
  onSaveSessionPermission: (input: SessionPermissionSaveInput) => Promise<boolean>
  onSaveSessionSpeed: (input: SessionSpeedSaveInput) => Promise<boolean>
  projects: Project[]
  sessions: CollaborationSession[]
  sessionWorkspace: SessionWorkspaceFlow
  navigationIntent?: NavigationIntent | undefined
  loading: boolean
  sessionsLoading: boolean
  adding: boolean
  creatingSession: boolean
  savingSessionSettings: boolean
  renamingSessionId?: string | undefined
  archivingSessionId?: string | undefined
  archivingProjectId?: string | undefined
  renamingProjectId?: string | undefined
  error?: string | undefined
  sessionError?: string | undefined
  updateAvailable?: boolean
  settingsPage: SettingsPage
  schedulingState?: SchedulingState | undefined
  relayDecision?: RelayDecisionPresentation | undefined
  settingsView?: ReactNode
  runtimeNotice?: ReactNode
  archiveNotice?: ReactNode
  toastNotice?: ReactNode
  sessionReminderNotice?: ReactNode
  agentActionsEnabled: boolean
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  selectedSessionId?: string | undefined
  selectedProjectId?: string | undefined
  creatingProjectId?: string | undefined
  creatingGroupId?: string | undefined
  creationEditorState?: DefaultSessionSettingsEditorState | undefined
  creationLoading: boolean
  sessionSettingsEditorState?: SessionSettingsEditorState | undefined
  sessionSettingsLoading: boolean
  sessionSettingsOpen: boolean
  sessionSettingsNavigationToken?: number | undefined
  collaborationTask?: CollaborationTask | null | undefined
  sideChatsOpen?: boolean | undefined
  sideChatNavigationToken?: number | undefined
  changesNavigationToken?: number | undefined
  fileNavigationToken?: number | undefined
  inspectorNavigationEpoch?: number | undefined
  overlayCloseToken?: number | undefined
  sideChatActiveCount?: number | undefined
  sideChatAttentionCount?: number | undefined
  sideChatUnreadCount?: number | undefined
  sideChatsPanel?: ReactNode | undefined
  onInspectorStateChange?:
    | ((state: { open: boolean; activeTab: ContextInspectorTab }) => void)
    | undefined
  onInspectorNavigate?: (() => void) | undefined
  onRegisterChangesNavigationGuard?:
    | ((guard: WorkspaceChangesNavigationGuard | undefined) => void)
    | undefined
  onConfirmExternalWorkspaceChanges?:
    | ((target: WorkspaceChangesNavigationTarget) => void)
    | undefined
  onFocusChangesTab?: (() => void) | undefined
  onOpenSideChats?: (() => void) | undefined
  onBackToSideChat?: (() => void) | undefined
  onOpenBtwSideChat?: ((draft: ComposerDocument) => Promise<boolean>) | undefined
  onAskInSideChat?: ((selection: MessageTextSelection) => void) | undefined
  onOpenSideChat?: ((sideChatId: string) => void) | undefined
  resolveSideChatTitle?: ((sideChatId: string, fallbackTitle: string) => string) | undefined
  projectFilePanel?: WorkspaceProjectFilePanelState | undefined
  projectFileSessionId?: string | undefined
  workspaceChangesPanel?: WorkspaceChangesPanelState | undefined
  projectFilePanelExpanded: boolean
  conversation?: ConversationViewProjection | undefined
  sideChatConversation?: ConversationViewProjection | undefined
  conversationVisible: boolean
  conversationHistory: ConversationHistoryControls
  choosingConversationImages?: boolean | undefined
  conversationComposerImages?: ConversationFlow['composerImages'] | undefined
  onAddConversationImages?: ConversationFlow['addComposerImages'] | undefined
  onChooseConversationImages?: ConversationFlow['chooseComposerImages'] | undefined
  onRemoveConversationImage?: ConversationFlow['removeComposerImage'] | undefined
  conversationComposer: string
  conversationComposerMention?: ConversationComposerMention | undefined
  conversationComposerRoute?: import('../conversation/composer-document').ComposerDocument['route']
  conversationComposerReturnedInputOperationId?: string | undefined
  conversationComposerUserInformation?:
    | import('@pact/contracts').UserInformationDeclaration
    | undefined
  conversationComposerRevision?: number | undefined
  onClearSubmittedConversationDraft?: ((expectedRevision: number) => void) | undefined
  conversationLoading: boolean
  sendingMessage: boolean
  stoppingMessage: boolean
  conversationError?: string | undefined
  onAddProject: () => void
  onArchiveProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => Promise<RpcResult<ProjectNameChange>>
  onRetry: () => void
  onRetrySessions: () => void
  onOpenSettings: (page: Exclude<SettingsPage, null>) => void
  onBackToApp: () => void
  onStartSession: (projectId: string, groupId?: string) => void
  onCancelSessionCreation: () => void
  onCreateSession: (projectId: string, settings: DefaultSessionSettings) => void
  onSelectSession: (sessionId: string) => void
  onOpenSessionSettings: (sessionId: string) => void
  onSessionSettingsOpenChange: (open: boolean) => void
  onRetrySessionSettings: (sessionId: string) => void
  onSaveSessionSettings: (sessionId: string, settings: DefaultSessionSettings) => void
  onArchiveSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  onSendMessage: ConversationFlow['send']
  onSaveCommentDraft: ConversationFlow['saveCommentDraft']
  onRemoveCommentDraft: (commentId: string) => Promise<boolean>
  onOpenComment: (comment: AnchoredComment) => void
  onNotice: (message: string) => void
  onConversationComposerChange: (value: string) => void
  onConversationComposerDocumentChange: (value: ComposerDocument) => void
  onOpenSkillDocument: (skill: SkillSelection) => void
  skillDocumentPanel?: SkillDocumentPanelState | undefined
  onRetrySkillDocument: () => void
  conversationComposerSkills: SkillSelection[]
  onConversationComposerSkillsChange: (skills: SkillSelection[]) => void
  onConversationComposerMentionChange: (value: ConversationComposerMention | undefined) => void
  onCreateFileComment: (
    anchor: FileCommentAnchor,
    body: string,
    options?: CreateFileCommentOptions,
  ) => Promise<CommentDraftSaveOutcome>
  messageNavigation?:
    | {
        navigationId?: string
        messageId: string
        startOffset: number
        endOffset: number
        textBasis?: import('@pact/contracts').MessageCommentAnchor['textBasis']
        plan?: import('@pact/contracts').MessageCommentAnchor['plan']
        report?: import('@pact/contracts').MessageCommentAnchor['report']
      }
    | undefined
  onStopRun: ConversationFlow['stop']
  onRebuildNativeContext: ConversationFlow['rebuildNativeContext']
  onCheckNativeContext: ConversationFlow['checkNativeContext']
  onAcceptPeerProposal: (proposalId: string) => Promise<boolean>
  onDismissPeerProposal: (proposalId: string) => Promise<boolean>
  onUndoWorkspaceChanges: (changeSetId: string) => Promise<boolean>
  onUndoWorkspaceFile?: ((changeSetId: string, path: string) => Promise<boolean>) | undefined
  activeWorkspaceDiff?: ActiveWorkspaceDiffTarget | undefined
  activeWorkspaceFilePath?: string | undefined
  onRespondNativeInput: (input: import('@pact/contracts').NativeInputRespond) => Promise<boolean>
  nativeInputDrafts: ConversationFlow['nativeInputDrafts']
  onNativeInputDraftChange: ConversationFlow['setNativeInputDraft']
  onRespondNativePermission: (
    operationId: string,
    permissionId: string,
    decision: import('@pact/contracts').NativePermissionDecision,
  ) => Promise<boolean>
  onOpenWorkspaceChanges: (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
    sessionId?: string,
  ) => void
  onPrepareWorkspaceChanges: () => number
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onProjectFilePanelExpandedChange: (expanded: boolean) => void
  onRetryProjectFile: () => void
}

interface InspectorSyncSignals {
  sessionId: string
  hasChanges: boolean
  changesNavigationToken: number | undefined
  changesFallbackSignal: string
  hasFile: boolean
  fileNavigationToken: number | undefined
  fileFallbackSignal: string
  sideChats: boolean
  sideChatNavigationToken: number
  settings: boolean
  sessionSettingsNavigationToken: number
  overlayCloseToken: number
}

export function WorkspaceView(props: WorkspaceViewProps): React.JSX.Element {
  const selectedSession = props.sessions.find(
    (session) => session.id === props.selectedSessionId && session.status !== 'archived',
  )
  const selectedProject = props.projects.find(
    (project) => project.id === selectedSession?.projectId,
  )
  const creatingProject = props.projects.find((project) => project.id === props.creatingProjectId)
  const activeProject =
    props.projects.find((project) => project.id === props.selectedProjectId) ??
    selectedProject ??
    props.projects.at(0)

  const [planPane, setPlanPane] = useState<{
    sessionId: string
    taskId: string
    open: boolean
    expanded: boolean
  }>()
  const [planHost, setPlanHost] = useState<HTMLDivElement | null>(null)
  const [requestedTab, setRequestedTab] = useState<ContextInspectorTab>('plan')
  const [sideChatsMountedSessionId, setSideChatsMountedSessionId] = useState<string | undefined>()

  const planRestoreFocusRef = useRef<HTMLButtonElement>(null)
  const sessionSettingsFocusRef = useRef<HTMLButtonElement>(null)
  const sideChatsButtonRef = useRef<HTMLButtonElement>(null)
  const showCurrentPlanHandlerRef = useRef<(() => void) | undefined>(undefined)
  const registerShowCurrentPlan = useCallback((fn: (() => void) | undefined): void => {
    showCurrentPlanHandlerRef.current = fn
  }, [])
  const sideChatsHostRef = useRef<HTMLDivElement>(null)
  const prePreviewFocusRef = useRef<HTMLElement | null>(null)
  const wasPreviewOpenRef = useRef(false)

  const sessionId = selectedSession?.id ?? ''
  const previewOpen = Boolean(
    props.skillDocumentPanel || props.workspaceChangesPanel || props.projectFilePanel,
  )
  const hasSideChatsTab = Boolean(
    selectedSession && !selectedSession.parentSessionId && props.sideChatsPanel,
  )
  const planAvailable = Boolean(selectedSession && planPane?.sessionId === selectedSession.id)
  const rightContextOpen = props.sessionSettingsOpen || Boolean(props.sideChatsOpen) || previewOpen

  // Track external panel arrivals synchronously during render so the sliding-pill tab follows immediately.
  const hasChangesPanel = Boolean(props.workspaceChangesPanel)
  const hasFilePanel = Boolean(props.skillDocumentPanel || props.projectFilePanel)
  const changesNavigationToken = props.changesNavigationToken
  const fileNavigationToken = props.fileNavigationToken
  const changesFallbackSignal =
    changesNavigationToken === undefined && props.workspaceChangesPanel
      ? `${props.workspaceChangesPanel.sessionId}:${props.workspaceChangesPanel.changeSetId}:${props.workspaceChangesPanel.path}`
      : ''
  const fileFallbackSignal =
    fileNavigationToken === undefined
      ? props.skillDocumentPanel
        ? `skill:${props.skillDocumentPanel.sessionId}:${props.skillDocumentPanel.skill.id}`
        : props.projectFilePanel
          ? `file:${props.projectFilePanel.target.path}:${props.projectFilePanel.target.lineStart ?? ''}:${props.projectFilePanel.target.lineEnd ?? ''}`
          : ''
      : ''
  const sideChatNavigationToken = props.sideChatNavigationToken ?? 0
  const sessionSettingsNavigationToken = props.sessionSettingsNavigationToken ?? 0
  const overlayCloseToken = props.overlayCloseToken ?? 0
  const [prevSignals, setPrevSignals] = useState<InspectorSyncSignals>({
    sessionId,
    hasChanges: hasChangesPanel,
    changesNavigationToken,
    changesFallbackSignal,
    hasFile: hasFilePanel,
    fileNavigationToken,
    fileFallbackSignal,
    sideChats: Boolean(props.sideChatsOpen),
    sideChatNavigationToken,
    settings: props.sessionSettingsOpen,
    sessionSettingsNavigationToken,
    overlayCloseToken,
  })

  if (
    prevSignals.sessionId !== sessionId ||
    prevSignals.hasChanges !== hasChangesPanel ||
    prevSignals.changesNavigationToken !== changesNavigationToken ||
    prevSignals.changesFallbackSignal !== changesFallbackSignal ||
    prevSignals.hasFile !== hasFilePanel ||
    prevSignals.fileNavigationToken !== fileNavigationToken ||
    prevSignals.fileFallbackSignal !== fileFallbackSignal ||
    prevSignals.sideChats !== Boolean(props.sideChatsOpen) ||
    prevSignals.sideChatNavigationToken !== sideChatNavigationToken ||
    prevSignals.settings !== props.sessionSettingsOpen ||
    prevSignals.sessionSettingsNavigationToken !== sessionSettingsNavigationToken ||
    prevSignals.overlayCloseToken !== overlayCloseToken
  ) {
    const sessionChanged = prevSignals.sessionId !== sessionId
    const changesRequested =
      hasChangesPanel &&
      (changesNavigationToken !== undefined
        ? prevSignals.changesNavigationToken !== changesNavigationToken ||
          !prevSignals.hasChanges ||
          sessionChanged
        : Boolean(
            changesFallbackSignal && changesFallbackSignal !== prevSignals.changesFallbackSignal,
          ))
    const fileRequested =
      hasFilePanel &&
      (fileNavigationToken !== undefined
        ? prevSignals.fileNavigationToken !== fileNavigationToken ||
          !prevSignals.hasFile ||
          sessionChanged
        : Boolean(fileFallbackSignal && fileFallbackSignal !== prevSignals.fileFallbackSignal))
    const sideChatRequested =
      prevSignals.sideChatNavigationToken !== sideChatNavigationToken ||
      !prevSignals.sideChats ||
      sessionChanged
    const settingsRequested =
      prevSignals.sessionSettingsNavigationToken !== sessionSettingsNavigationToken ||
      !prevSignals.settings ||
      sessionChanged
    const overlayClosed = prevSignals.overlayCloseToken !== overlayCloseToken
    setPrevSignals({
      sessionId,
      hasChanges: hasChangesPanel,
      changesNavigationToken,
      changesFallbackSignal,
      hasFile: hasFilePanel,
      fileNavigationToken,
      fileFallbackSignal,
      sideChats: Boolean(props.sideChatsOpen),
      sideChatNavigationToken,
      settings: props.sessionSettingsOpen,
      sessionSettingsNavigationToken,
      overlayCloseToken,
    })
    if (sessionChanged) {
      setSideChatsMountedSessionId(props.sideChatsOpen && sessionId ? sessionId : undefined)
    }
    if (overlayClosed) {
      setPlanPane((current) => (current ? { ...current, open: false, expanded: false } : current))
    }
    if (changesRequested) {
      setRequestedTab('changes')
    } else if (fileRequested) {
      setRequestedTab('file')
    } else if (props.sideChatsOpen && sideChatRequested) {
      setRequestedTab('sidechats')
      if (sessionId) setSideChatsMountedSessionId(sessionId)
    } else if (props.sessionSettingsOpen && settingsRequested) {
      setRequestedTab('settings')
    } else if (
      !hasChangesPanel &&
      !hasFilePanel &&
      (prevSignals.hasChanges || prevSignals.hasFile) &&
      props.sideChatsOpen
    ) {
      setRequestedTab('sidechats')
    }
  }

  if (props.sideChatsOpen && sessionId && sideChatsMountedSessionId !== sessionId) {
    setSideChatsMountedSessionId(sessionId)
  }

  useEffect(() => {
    if (previewOpen && !wasPreviewOpenRef.current) {
      const active = document.activeElement
      prePreviewFocusRef.current =
        active instanceof HTMLElement && sideChatsHostRef.current?.contains(active) ? active : null
    } else if (!previewOpen && wasPreviewOpenRef.current && props.sideChatsOpen) {
      const target =
        prePreviewFocusRef.current?.isConnected &&
        sideChatsHostRef.current?.contains(prePreviewFocusRef.current)
          ? prePreviewFocusRef.current
          : sideChatsHostRef.current?.querySelector<HTMLElement>(
              'textarea, [contenteditable="true"], button:not([disabled])',
            )
      target?.focus()
      prePreviewFocusRef.current = null
    }
    wasPreviewOpenRef.current = previewOpen
  }, [previewOpen, props.sideChatsOpen])

  const activePlanVersion =
    props.collaborationTask &&
    !props.collaborationTask.ending &&
    props.collaborationTask.planVersion > 0
      ? props.collaborationTask.planVersion
      : undefined

  const availableTabIds = useMemo<ContextInspectorTab[]>(() => {
    if (!selectedSession || props.settingsPage) return []
    const ids: ContextInspectorTab[] = []
    if (planAvailable) ids.push('plan')
    if (hasSideChatsTab) ids.push('sidechats')
    if (props.workspaceChangesPanel) ids.push('changes')
    if (props.projectFilePanel || props.skillDocumentPanel) ids.push('file')
    if (props.sessionSettingsOpen) ids.push('settings')
    return ids
  }, [
    selectedSession,
    props.settingsPage,
    planAvailable,
    hasSideChatsTab,
    props.workspaceChangesPanel,
    props.projectFilePanel,
    props.skillDocumentPanel,
    props.sessionSettingsOpen,
  ])

  const effectiveActiveTab: ContextInspectorTab = useMemo(() => {
    if (availableTabIds.includes(requestedTab)) return requestedTab
    if (props.skillDocumentPanel || props.projectFilePanel) return 'file'
    if (props.workspaceChangesPanel) return 'changes'
    if (props.sessionSettingsOpen) return 'settings'
    if (props.sideChatsOpen && hasSideChatsTab) return 'sidechats'
    if (planAvailable) return 'plan'
    return availableTabIds[0] ?? 'sidechats'
  }, [
    availableTabIds,
    requestedTab,
    props.skillDocumentPanel,
    props.projectFilePanel,
    props.workspaceChangesPanel,
    props.sessionSettingsOpen,
    props.sideChatsOpen,
    hasSideChatsTab,
    planAvailable,
  ])

  const planOpen = Boolean(planAvailable && planPane?.open)
  const isInspectorOpen = Boolean(
    selectedSession && !props.settingsPage && (rightContextOpen || planOpen),
  )
  const isPlanActive = isInspectorOpen && effectiveActiveTab === 'plan'
  const sideChatsMounted = Boolean(
    hasSideChatsTab &&
    selectedSession &&
    (sideChatsMountedSessionId === selectedSession.id ||
      props.sideChatsOpen ||
      (isInspectorOpen && effectiveActiveTab === 'sidechats')),
  )

  const { onInspectorStateChange } = props
  useLayoutEffect(() => {
    onInspectorStateChange?.({ open: isInspectorOpen, activeTab: effectiveActiveTab })
  }, [isInspectorOpen, effectiveActiveTab, onInspectorStateChange])

  const acceptedPlanTaskRef = useRef<{ sessionId: string; taskId: string } | undefined>(undefined)
  const rightContextOpenRef = useRef(rightContextOpen)
  useEffect(() => {
    rightContextOpenRef.current = rightContextOpen
  }, [rightContextOpen])

  const acceptPlanTask = useCallback((nextSessionId: string, taskId?: string): void => {
    if (!taskId) {
      if (acceptedPlanTaskRef.current?.sessionId === nextSessionId) {
        acceptedPlanTaskRef.current = undefined
      }
      setPlanPane((current) => (current?.sessionId === nextSessionId ? undefined : current))
      return
    }
    const previous = acceptedPlanTaskRef.current
    if (previous?.sessionId === nextSessionId && previous.taskId === taskId) {
      return
    }
    acceptedPlanTaskRef.current = { sessionId: nextSessionId, taskId }
    setPlanPane((current) =>
      current?.sessionId === nextSessionId && current.taskId === taskId
        ? current
        : { sessionId: nextSessionId, taskId, open: true, expanded: false },
    )
    if (!rightContextOpenRef.current) {
      setRequestedTab('plan')
    }
  }, [])

  const openPlan = useCallback((): void => {
    setPlanPane((current) => (current ? { ...current, open: true } : current))
    setRequestedTab('plan')
  }, [])

  const setPlanExpanded = useCallback((expanded: boolean): void => {
    setPlanPane((current) => (current ? { ...current, expanded } : current))
  }, [])

  const {
    onSessionSettingsOpenChange,
    onOpenSideChats,
    onOpenSessionSettings,
    onInspectorNavigate,
    sessionSettingsEditorState,
    sessionSettingsLoading,
    settingsPage,
    sideChatsOpen,
  } = props

  const closeInspector = useCallback((): void => {
    setPlanPane((current) => (current ? { ...current, open: false, expanded: false } : current))
    onInspectorNavigate?.()
    onInspectorStateChange?.({ open: false, activeTab: effectiveActiveTab })
    onSessionSettingsOpenChange(false)
  }, [onSessionSettingsOpenChange, onInspectorNavigate, onInspectorStateChange, effectiveActiveTab])

  const openInspector = useCallback((): void => {
    if (!selectedSession || settingsPage) return
    onInspectorNavigate?.()
    if (planAvailable && (requestedTab === 'plan' || !hasSideChatsTab)) {
      setPlanPane((current) => (current ? { ...current, open: true } : current))
      setRequestedTab('plan')
      onInspectorStateChange?.({ open: true, activeTab: 'plan' })
      return
    }
    if (hasSideChatsTab) {
      setSideChatsMountedSessionId(selectedSession.id)
      setRequestedTab('sidechats')
      onInspectorStateChange?.({ open: true, activeTab: 'sidechats' })
      if (!sideChatsOpen) onOpenSideChats?.()
      return
    }
    if (planAvailable) {
      setPlanPane((current) => (current ? { ...current, open: true } : current))
      setRequestedTab('plan')
      onInspectorStateChange?.({ open: true, activeTab: 'plan' })
      return
    }
    onOpenSessionSettings(selectedSession.id)
  }, [
    selectedSession,
    settingsPage,
    planAvailable,
    requestedTab,
    hasSideChatsTab,
    sideChatsOpen,
    onOpenSideChats,
    onOpenSessionSettings,
    onInspectorNavigate,
    onInspectorStateChange,
  ])

  const handleSelectInspectorTab = useCallback(
    (tab: ContextInspectorTab): void => {
      setRequestedTab(tab)
      onInspectorNavigate?.()
      onInspectorStateChange?.({ open: true, activeTab: tab })
      if (tab === 'sidechats' && selectedSession) {
        setSideChatsMountedSessionId(selectedSession.id)
        if (!sideChatsOpen) onOpenSideChats?.()
      } else if (tab === 'plan') {
        setPlanPane((current) => (current ? { ...current, open: true } : current))
      } else if (
        tab === 'settings' &&
        selectedSession &&
        !sessionSettingsEditorState &&
        !sessionSettingsLoading
      ) {
        onOpenSessionSettings(selectedSession.id)
      }
    },
    [
      selectedSession,
      sideChatsOpen,
      onOpenSideChats,
      onOpenSessionSettings,
      sessionSettingsEditorState,
      sessionSettingsLoading,
      onInspectorNavigate,
      onInspectorStateChange,
    ],
  )

  const navigationAvailable = Boolean(props.settingsPage || props.projects.length > 0)
  const [navigationVisible, setNavigationVisible] = useState(navigationAvailable)

  const isSessionNativeRecoveryLocked = (ownerSessionId: string | undefined): boolean => {
    if (!ownerSessionId) return false
    if (props.sideChatConversation?.sessionId === ownerSessionId) {
      return nativeRecoveryTargets(props.sideChatConversation).length > 0
    }
    if (props.conversation?.sessionId === ownerSessionId) {
      return nativeRecoveryTargets(props.conversation).length > 0
    }
    return false
  }
  const isSideChatPreview = Boolean(props.sideChatsOpen && props.onBackToSideChat)

  let changesPanelNode: ReactNode
  let changesStageKey: string | undefined
  if (selectedSession && !props.settingsPage && props.workspaceChangesPanel) {
    const state = props.workspaceChangesPanel
    if (isSideChatPreview) {
      changesStageKey = `changes:${state.sessionId}:${state.changeSetId}`
    }
    changesPanelNode = (
      <WorkspaceChangesPanel
        key={`${state.sessionId}:${state.changeSetId}`}
        state={state}
        expanded={props.projectFilePanelExpanded}
        onClose={closeInspector}
        onBackToSideChat={props.onBackToSideChat}
        onExpandedChange={props.onProjectFilePanelExpandedChange}
        onSelectFile={(path) =>
          props.onOpenWorkspaceChanges(
            state.changeSetId,
            path,
            undefined,
            state.revision,
            state.sessionId,
          )
        }
        onUndoFile={props.onUndoWorkspaceFile}
        navigationEpoch={props.inspectorNavigationEpoch}
        onRegisterNavigationGuard={props.onRegisterChangesNavigationGuard}
        onConfirmExternalNavigation={props.onConfirmExternalWorkspaceChanges}
        onFocusChanges={props.onFocusChangesTab}
        onCreateComment={props.onCreateFileComment}
        commentingDisabled={isSessionNativeRecoveryLocked(state.sessionId)}
      />
    )
  }

  let filePanelNode: ReactNode
  let fileStageKey: string | undefined
  if (selectedSession && !props.settingsPage) {
    if (props.skillDocumentPanel) {
      if (isSideChatPreview) {
        fileStageKey = `skill:${props.skillDocumentPanel.sessionId}:${props.skillDocumentPanel.skill.id}`
      }
      filePanelNode = (
        <SkillDocumentPanel
          state={props.skillDocumentPanel}
          expanded={props.projectFilePanelExpanded}
          onExpandedChange={props.onProjectFilePanelExpandedChange}
          onClose={closeInspector}
          onBackToSideChat={props.onBackToSideChat}
          onRetry={props.onRetrySkillDocument}
        />
      )
    } else if (props.projectFilePanel) {
      if (isSideChatPreview) {
        fileStageKey = `file:${props.projectFilePanel.target.path}`
      }
      filePanelNode = (
        <ProjectFilePanel
          state={props.projectFilePanel}
          expanded={props.projectFilePanelExpanded}
          onClose={closeInspector}
          onBackToSideChat={props.onBackToSideChat}
          onExpandedChange={props.onProjectFilePanelExpandedChange}
          onRetry={props.onRetryProjectFile}
          onCreateComment={props.onCreateFileComment}
          commentingDisabled={isSessionNativeRecoveryLocked(
            props.projectFileSessionId ?? selectedSession.id,
          )}
        />
      )
    }
  }

  const settingsPanelNode =
    selectedSession && !props.settingsPage && props.sessionSettingsOpen ? (
      <SessionSettingsPanel
        key={`${selectedSession.id}-${props.sessionSettingsEditorState?.session.settingsRevision ?? 'loading'}`}
        editorState={props.sessionSettingsEditorState}
        runtimePreparation={props.runtimePreparation}
        conversation={
          props.conversation && props.collaborationTask !== undefined
            ? { ...props.conversation, collaborationTask: props.collaborationTask }
            : props.conversation
        }
        loading={props.sessionSettingsLoading}
        saving={props.savingSessionSettings}
        error={props.sessionError}
        onClose={closeInspector}
        onRetry={() => props.onRetrySessionSettings(selectedSession.id)}
        onSave={(settings) => props.onSaveSessionSettings(selectedSession.id, settings)}
      />
    ) : undefined

  const embeddedSideChatsPanel = useMemo<ReactNode>(() => {
    if (!props.sideChatsPanel) return undefined
    if (
      isValidElement<SideChatsPanelProps>(props.sideChatsPanel) &&
      props.sideChatsPanel.type === SideChatsPanel
    ) {
      return cloneElement(props.sideChatsPanel, {
        embeddedInInspector: props.sideChatsPanel.props.embeddedInInspector ?? false,
        onClose: closeInspector,
      })
    }
    return (
      <SideChatsInspectorContext.Provider value={false}>
        {props.sideChatsPanel}
      </SideChatsInspectorContext.Provider>
    )
  }, [props.sideChatsPanel, closeInspector])

  const canRenderInspector = Boolean(
    selectedSession && !props.settingsPage && (availableTabIds.length > 0 || isInspectorOpen),
  )

  return (
    <WorkspaceShell
      workspaceTitle={null}
      workspaceSubtitle={null}
      navigationAvailable={navigationAvailable}
      initialState={{ navigationPanel: 'open', contextPanel: 'closed' }}
      onNavigationVisibilityChange={setNavigationVisible}
      navigation={
        props.settingsPage ? (
          <SettingsNavigation
            updateAvailable={props.updateAvailable ?? false}
            settingsPage={props.settingsPage}
            onBackToApp={props.onBackToApp}
            onOpenSettings={props.onOpenSettings}
          />
        ) : (
          <ProjectNavigation
            updateAvailable={props.updateAvailable ?? false}
            navigationVisible={
              navigationAvailable && navigationVisible && !props.nativePresentationSuspended
            }
            projects={props.projects}
            sessions={props.sessions}
            workspace={props.sessionWorkspace}
            navigationIntent={props.navigationIntent}
            loading={props.loading || props.sessionsLoading}
            error={props.sessionError}
            adding={props.adding}
            archivingProjectId={props.archivingProjectId}
            renamingProjectId={props.renamingProjectId}
            archivingSessionId={props.archivingSessionId}
            selectedSessionId={props.selectedSessionId}
            settingsButtonRef={props.settingsButtonRef}
            onAddProject={props.onAddProject}
            onArchiveProject={props.onArchiveProject}
            onRenameProject={props.onRenameProject}
            onOpenSettings={props.onOpenSettings}
            onRetrySessions={props.onRetrySessions}
            onStartSession={props.onStartSession}
            onSelectSession={props.onSelectSession}
            onArchiveSession={props.onArchiveSession}
          />
        )
      }
      workspaceHeader={
        selectedSession && !props.settingsPage && !creatingProject ? (
          <div className="flex h-full min-w-0 items-center gap-group">
            <div className="min-w-0 flex-1">
              <SessionHeader
                session={selectedSession}
                collaborationTask={props.collaborationTask}
                projectName={selectedProject?.name}
                saving={props.renamingSessionId === selectedSession.id}
                onSave={(title) => props.onRenameSession(selectedSession.id, title)}
                settingsOpen={isInspectorOpen && effectiveActiveTab === 'settings'}
                onOpenSettings={() => {
                  if (isInspectorOpen && effectiveActiveTab === 'settings') closeInspector()
                  else if (props.sessionSettingsOpen) handleSelectInspectorTab('settings')
                  else props.onOpenSessionSettings(selectedSession.id)
                }}
                settingsButtonRef={sessionSettingsFocusRef}
                planAvailable={planAvailable}
                planOpen={isPlanActive}
                planVersion={activePlanVersion}
                onTogglePlan={() => {
                  if (isPlanActive) closeInspector()
                  else if (showCurrentPlanHandlerRef.current) showCurrentPlanHandlerRef.current()
                  else handleSelectInspectorTab('plan')
                }}
                planButtonRef={planRestoreFocusRef}
                changesAvailable={Boolean(props.workspaceChangesPanel)}
                changesOpen={isInspectorOpen && effectiveActiveTab === 'changes'}
                onToggleChanges={() => {
                  if (isInspectorOpen && effectiveActiveTab === 'changes') closeInspector()
                  else handleSelectInspectorTab('changes')
                }}
                fileAvailable={Boolean(props.projectFilePanel || props.skillDocumentPanel)}
                fileOpen={isInspectorOpen && effectiveActiveTab === 'file'}
                fileLabel={props.skillDocumentPanel ? 'Skill' : 'File'}
                onToggleFile={() => {
                  if (isInspectorOpen && effectiveActiveTab === 'file') closeInspector()
                  else handleSelectInspectorTab('file')
                }}
                sideChatsOpen={isInspectorOpen && effectiveActiveTab === 'sidechats'}
                sideChatActiveCount={props.sideChatActiveCount}
                sideChatAttentionCount={props.sideChatAttentionCount}
                sideChatUnreadCount={props.sideChatUnreadCount}
                onOpenSideChats={
                  props.onOpenSideChats
                    ? () => {
                        if (isInspectorOpen && effectiveActiveTab === 'sidechats') closeInspector()
                        else handleSelectInspectorTab('sidechats')
                      }
                    : undefined
                }
                sideChatsButtonRef={sideChatsButtonRef}
              />
            </div>
          </div>
        ) : undefined
      }
      workspaceNotice={
        <>
          {props.runtimeNotice}
          {props.archiveNotice}
          {props.sessionReminderNotice}
          {props.toastNotice}
        </>
      }
      agentActionsEnabled={props.agentActionsEnabled}
      isSettingsView={Boolean(props.settingsPage)}
      nativePresentationSuspended={props.nativePresentationSuspended}
      contextPanelOpen={isInspectorOpen}
      contextPanelExpanded={
        isPlanActive
          ? planPane?.expanded
          : effectiveActiveTab === 'file' || effectiveActiveTab === 'changes'
            ? props.projectFilePanelExpanded
            : false
      }
      contextPanelWidthLimited={!isPlanActive}
      contextPanelRestoreFocusRef={
        isPlanActive
          ? planRestoreFocusRef
          : effectiveActiveTab === 'sidechats'
            ? sideChatsButtonRef
            : effectiveActiveTab === 'settings'
              ? sessionSettingsFocusRef
              : undefined
      }
      onContextPanelOpenChange={(open) => {
        if (open === isInspectorOpen) return
        if (open) openInspector()
        else closeInspector()
      }}
      showContextToggle={false}
      contextPanel={
        canRenderInspector ? (
          <ContextInspector
            activeTab={effectiveActiveTab}
            planAvailable={planAvailable}
            onPlanHostRef={setPlanHost}
            sideChatsMounted={sideChatsMounted}
            sideChatsHostRef={sideChatsHostRef}
            sideChatsPanel={embeddedSideChatsPanel}
            changesPanel={changesPanelNode}
            filePanel={filePanelNode}
            settingsPanel={settingsPanelNode}
            changesStageKey={changesStageKey}
            fileStageKey={fileStageKey}
          />
        ) : undefined
      }
      workspace={
        <WorkspaceContent
          props={props}
          selectedSession={selectedSession}
          creatingProject={creatingProject}
          activeProject={activeProject}
          isChangesActive={isInspectorOpen && effectiveActiveTab === 'changes'}
          onRegisterShowCurrentPlan={registerShowCurrentPlan}
          planPane={{
            host: planHost,
            available: planAvailable,
            open: isPlanActive,
            expanded: Boolean(isPlanActive && planPane?.expanded),
            onExpandedChange: setPlanExpanded,
            onAvailable: acceptPlanTask,
            onOpen: openPlan,
            onClose: closeInspector,
            restoreFocusRef: planRestoreFocusRef,
          }}
        />
      }
    />
  )
}

function WorkspaceContent({
  props,
  selectedSession,
  creatingProject,
  activeProject,
  isChangesActive,
  onRegisterShowCurrentPlan,
  planPane,
}: {
  props: WorkspaceViewProps
  selectedSession: CollaborationSession | undefined
  creatingProject: Project | undefined
  activeProject: Project | undefined
  isChangesActive: boolean
  onRegisterShowCurrentPlan: (fn: (() => void) | undefined) => void
  planPane: {
    host: HTMLElement | null
    available: boolean
    open: boolean
    expanded: boolean
    onExpandedChange: (expanded: boolean) => void
    onAvailable: (sessionId: string, taskId?: string) => void
    onOpen: () => void
    onClose: () => void
    restoreFocusRef: React.RefObject<HTMLButtonElement | null>
  }
}): ReactNode {
  if (props.settingsPage && props.settingsView && (!selectedSession || creatingProject))
    return props.settingsView
  if (creatingProject) {
    return (
      <SessionCreationView
        key={creatingProject.id}
        project={creatingProject}
        editorState={props.creationEditorState}
        runtimePreparation={props.runtimePreparation}
        loading={props.creationLoading}
        creating={props.creatingSession}
        error={props.sessionError}
        onCancel={props.onCancelSessionCreation}
        onRetry={() => props.onStartSession(creatingProject.id, props.creatingGroupId)}
        onCreate={(settings) => props.onCreateSession(creatingProject.id, settings)}
        onOpenAppDefaults={() => props.onOpenSettings('session-defaults')}
      />
    )
  }
  if (selectedSession) {
    const resolvedActiveWorkspaceDiff = isChangesActive
      ? (props.activeWorkspaceDiff ??
        (props.workspaceChangesPanel
          ? {
              sessionId: props.workspaceChangesPanel.sessionId,
              changeSetId: props.workspaceChangesPanel.changeSetId,
              path: props.workspaceChangesPanel.path,
            }
          : undefined))
      : undefined
    return (
      <div className="relative h-full min-h-0 overflow-hidden">
        {props.settingsPage ? (
          <div className="absolute inset-0 overflow-auto">{props.settingsView}</div>
        ) : null}
        <div
          className="h-full"
          style={{ opacity: props.settingsPage ? 0 : 1 }}
          inert={Boolean(props.settingsPage)}
        >
          <ConversationErrorBoundary key={selectedSession.id}>
            <ConversationViewWithDiff
              planPanelHost={planPane.host}
              planPanelOpen={planPane.open}
              planPanelExpanded={planPane.expanded}
              onPlanPanelExpandedChange={planPane.onExpandedChange}
              planAvailable={planPane.available}
              planRestoreFocusRef={planPane.restoreFocusRef}
              showPlanHeaderButton={false}
              onRegisterShowCurrentPlan={onRegisterShowCurrentPlan}
              onPlanAvailable={planPane.onAvailable}
              onOpenPlan={planPane.onOpen}
              onClosePlan={planPane.onClose}
              onForkSessionCreated={props.onForkSessionCreated}
              onForkSessionStarted={props.onForkSessionStarted}
              nativePresentationSuspended={props.nativePresentationSuspended}
              platform={props.platform}
              onSaveSessionPermission={props.onSaveSessionPermission}
              onSaveSessionSpeed={props.onSaveSessionSpeed}
              sessionSettingsSaving={props.savingSessionSettings}
              session={selectedSession}
              schedulingState={props.schedulingState}
              relayDecision={props.relayDecision}
              onOpenRelaySettings={() => props.onOpenSettings('decision-scheduling')}
              onOpenSessionSettings={() => props.onOpenSessionSettings(selectedSession.id)}
              visible={props.conversationVisible}
              snapshot={props.conversation}
              history={props.conversationHistory}
              composer={props.conversationComposer}
              composerImages={props.conversationComposerImages}
              choosingImages={props.choosingConversationImages}
              onAddComposerImages={props.onAddConversationImages}
              onChooseComposerImages={props.onChooseConversationImages}
              onRemoveComposerImage={props.onRemoveConversationImage}
              onComposerChange={props.onConversationComposerChange}
              onComposerDocumentChange={props.onConversationComposerDocumentChange}
              onOpenSkillDocument={props.onOpenSkillDocument}
              composerSkills={props.conversationComposerSkills}
              onComposerSkillsChange={props.onConversationComposerSkillsChange}
              composerMention={props.conversationComposerMention}
              composerRoute={props.conversationComposerRoute}
              composerReturnedInputOperationId={props.conversationComposerReturnedInputOperationId}
              composerUserInformation={props.conversationComposerUserInformation}
              composerRevision={props.conversationComposerRevision}
              onClearSubmittedDraft={props.onClearSubmittedConversationDraft}
              onOpenBtwSideChat={props.onOpenBtwSideChat}
              onAskInSideChat={props.onAskInSideChat}
              onOpenSideChat={props.onOpenSideChat}
              resolveSideChatTitle={props.resolveSideChatTitle}
              onComposerMentionChange={props.onConversationComposerMentionChange}
              loading={props.conversationLoading}
              sending={props.sendingMessage}
              stopping={props.stoppingMessage}
              agentActionsEnabled={props.agentActionsEnabled}
              error={props.conversationError}
              onSend={props.onSendMessage}
              onSaveCommentDraft={props.onSaveCommentDraft}
              onRemoveCommentDraft={props.onRemoveCommentDraft}
              onStop={props.onStopRun}
              onRebuildNativeContext={props.onRebuildNativeContext}
              onCheckNativeContext={props.onCheckNativeContext}
              onAcceptPeerProposal={props.onAcceptPeerProposal}
              onDismissPeerProposal={props.onDismissPeerProposal}
              onUndoWorkspaceChanges={props.onUndoWorkspaceChanges}
              onUndoWorkspaceFile={props.onUndoWorkspaceFile}
              activeWorkspaceDiff={resolvedActiveWorkspaceDiff}
              activeWorkspaceFilePath={
                isChangesActive
                  ? (props.activeWorkspaceFilePath ??
                    (props.workspaceChangesPanel?.sessionId === selectedSession.id
                      ? props.workspaceChangesPanel.path
                      : undefined))
                  : undefined
              }
              onRespondNativePermission={props.onRespondNativePermission}
              onRespondNativeInput={props.onRespondNativeInput}
              nativeInputDrafts={props.nativeInputDrafts}
              onNativeInputDraftChange={props.onNativeInputDraftChange}
              onOpenWorkspaceChanges={props.onOpenWorkspaceChanges}
              onPrepareWorkspaceChanges={props.onPrepareWorkspaceChanges}
              onOpenProjectFile={props.onOpenProjectFile}
              onOpenComment={props.onOpenComment}
              onNotice={props.onNotice}
              messageNavigation={props.messageNavigation}
            />
          </ConversationErrorBoundary>
        </div>
      </div>
    )
  }
  if (props.loading && props.projects.length === 0) {
    return (
      <main
        className="flex min-h-full items-center justify-center gap-group text-body text-secondary"
        aria-busy="true"
      >
        <span className="primary-action-spinner" aria-hidden="true" /> Loading projects
      </main>
    )
  }
  if (activeProject) {
    return (
      <ProjectReadyState
        project={activeProject}
        error={props.sessionError}
        onCreate={() => props.onStartSession(activeProject.id)}
        onRetry={props.onRetrySessions}
      />
    )
  }
  return (
    <ProjectEmptyState
      updateAvailable={props.updateAvailable ?? false}
      adding={props.adding}
      error={props.error}
      onAddProject={props.onAddProject}
      onOpenSettings={props.onOpenSettings}
      onRetry={props.onRetry}
      settingsButtonRef={props.settingsButtonRef}
    />
  )
}
