import { useCallback, useRef, useState, type ReactNode } from 'react'

import type { SkillSelection } from '@pact/contracts'
import type {
  CollaborationSession,
  AnchoredComment,
  FileCommentAnchor,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  Project,
  ConversationSendInput,
  SessionSettingsEditorState,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SessionCatalogChange,
  ProjectNameChange,
  RpcResult,
} from '@pact/contracts'

import type { ComposerDocument } from '../conversation/composer-document'
import type { ConversationViewProjection } from '../conversation/conversation-window'
import type { ProjectFileTarget } from '../conversation/MessageMarkdown'
import type { SessionForkOpening } from '../conversation/SessionFork'
import type {
  ConversationComposerMention,
  ConversationHistoryControls,
  ConversationFlow,
} from '../conversation/useConversation'
import type { SessionCatalogCache } from './session-catalog-cache'

import { nativeRecoveryTargets } from '../conversation/conversation-window'
import { ConversationView } from '../conversation/ConversationView'
import {
  SkillDocumentPanel,
  type SkillDocumentPanelState,
} from '../conversation/SkillDocumentPanel'
import { ProjectFilePanel, type ProjectFilePanelState } from '../project-file/ProjectFilePanel'
import {
  WorkspaceChangesPanel,
  type WorkspaceChangesPanelState,
} from '../project-file/WorkspaceChangesPanel'
import { SessionSettingsPanel } from '../settings/session/SessionSettingsPanel'
import { ConversationErrorBoundary } from './ConversationErrorBoundary'
import { ProjectNavigation } from './ProjectNavigation'
import { SessionCreationView } from './SessionCreationView'
import { SessionHeader } from './SessionHeader'
import { SettingsNavigation, type SettingsPage } from './SettingsNavigation'
import { ProjectEmptyState, ProjectReadyState } from './WorkspaceEmptyStates'
import { WorkspaceShell } from './WorkspaceShell'

interface WorkspaceViewProps {
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
  sessionProjectPages: SessionCatalogCache['projectPages']
  loading: boolean
  sessionsLoading: boolean
  loadingMoreProjectId?: string | undefined
  loadMoreErrors: Record<string, string>
  adding: boolean
  creatingSession: boolean
  savingSessionSettings: boolean
  renamingSessionId?: string | undefined
  archivingSessionId?: string | undefined
  archivingProjectId?: string | undefined
  renamingProjectId?: string | undefined
  error?: string | undefined
  sessionError?: string | undefined
  settingsPage: SettingsPage
  settingsView?: ReactNode
  runtimeNotice?: ReactNode
  archiveNotice?: ReactNode
  toastNotice?: ReactNode
  agentActionsEnabled: boolean
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  selectedSessionId?: string | undefined
  selectedProjectId?: string | undefined
  creatingProjectId?: string | undefined
  creationEditorState?: DefaultSessionSettingsEditorState | undefined
  creationLoading: boolean
  sessionSettingsEditorState?: SessionSettingsEditorState | undefined
  sessionSettingsLoading: boolean
  sessionSettingsOpen: boolean
  projectFilePanel?: ProjectFilePanelState | undefined
  workspaceChangesPanel?: WorkspaceChangesPanelState | undefined
  projectFilePanelExpanded: boolean
  conversation?: ConversationViewProjection | undefined
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
  conversationLoading: boolean
  sendingMessage: boolean
  stoppingMessage: boolean
  conversationError?: string | undefined
  onAddProject: () => void
  onArchiveProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => Promise<RpcResult<ProjectNameChange>>
  onRetry: () => void
  onRetrySessions: () => void
  onLoadMoreSessions: (projectId: string) => Promise<number>
  onOpenSettings: (page: Exclude<SettingsPage, null>) => void
  onBackToApp: () => void
  onStartSession: (projectId: string) => void
  onCancelSessionCreation: () => void
  onCreateSession: (projectId: string, settings: DefaultSessionSettings) => void
  onSelectSession: (sessionId: string) => void
  onOpenSessionSettings: (sessionId: string) => void
  onSessionSettingsOpenChange: (open: boolean) => void
  onRetrySessionSettings: (sessionId: string) => void
  onSaveSessionSettings: (sessionId: string, settings: DefaultSessionSettings) => void
  onArchiveSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  onSendMessage: (
    content: string,
    commentIds: string[],
    route?: NonNullable<ConversationSendInput['route']>,
    skills?: SkillSelection[],
    planningAction?: ConversationSendInput['planningAction'],
  ) => Promise<boolean>
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
  onCreateFileComment: (anchor: FileCommentAnchor, body: string) => Promise<boolean>
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
  todoNavigation?:
    | {
        taskId: string
        todoId: string
        todoRevision: number
        navigationId: string
        selection?: import('@pact/contracts').TodoCommentAnchor['selection']
      }
    | undefined
  onStopRun: () => Promise<boolean>
  onRebuildNativeContext: ConversationFlow['rebuildNativeContext']
  onCheckNativeContext: ConversationFlow['checkNativeContext']
  onAcceptPeerProposal: (proposalId: string) => Promise<boolean>
  onDismissPeerProposal: (proposalId: string) => Promise<boolean>
  onUndoWorkspaceChanges: (changeSetId: string) => Promise<boolean>
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
  ) => void
  onPrepareWorkspaceChanges: () => number
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onProjectFilePanelExpandedChange: (expanded: boolean) => void
  onRetryProjectFile: () => void
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
  const [planPane, setPlanPane] = useState<{ sessionId: string; taskId: string; open: boolean }>()
  const [planHost, setPlanHost] = useState<HTMLDivElement | null>(null)
  const planRestoreFocusRef = useRef<HTMLButtonElement>(null)
  const sessionSettingsFocusRef = useRef<HTMLButtonElement>(null)
  const planAvailable = Boolean(selectedSession && planPane?.sessionId === selectedSession.id)
  const planOpen = Boolean(planAvailable && planPane?.open && !props.sessionSettingsOpen)
  const acceptPlanTask = useCallback((sessionId: string, taskId?: string): void => {
    setPlanPane((current) =>
      taskId
        ? current?.sessionId === sessionId && current.taskId === taskId
          ? current
          : { sessionId, taskId, open: true }
        : current?.sessionId === sessionId
          ? undefined
          : current,
    )
  }, [])
  const onSessionSettingsOpenChange = props.onSessionSettingsOpenChange
  const openPlan = useCallback((): void => {
    onSessionSettingsOpenChange(false)
    setPlanPane((current) => (current ? { ...current, open: true } : current))
  }, [onSessionSettingsOpenChange])
  const closePlan = useCallback(
    (): void => setPlanPane((current) => (current ? { ...current, open: false } : current)),
    [],
  )

  return (
    <WorkspaceShell
      workspaceTitle={null}
      workspaceSubtitle={null}
      navigationAvailable={Boolean(props.settingsPage || props.projects.length > 0)}
      initialState={{ navigationPanel: 'open', contextPanel: 'closed' }}
      navigation={
        props.settingsPage ? (
          <SettingsNavigation
            settingsPage={props.settingsPage}
            onBackToApp={props.onBackToApp}
            onOpenSettings={props.onOpenSettings}
          />
        ) : (
          <ProjectNavigation
            projects={props.projects}
            sessions={props.sessions}
            projectPages={props.sessionProjectPages}
            loading={props.loading || props.sessionsLoading}
            loadingMoreProjectId={props.loadingMoreProjectId}
            loadMoreErrors={props.loadMoreErrors}
            error={selectedSession ? props.sessionError : undefined}
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
            onLoadMoreSessions={props.onLoadMoreSessions}
            onStartSession={props.onStartSession}
            onSelectSession={props.onSelectSession}
            onArchiveSession={props.onArchiveSession}
          />
        )
      }
      workspaceHeader={
        selectedSession && !props.settingsPage && !creatingProject ? (
          <SessionHeader
            session={selectedSession}
            projectName={selectedProject?.name}
            saving={props.renamingSessionId === selectedSession.id}
            onSave={(title) => props.onRenameSession(selectedSession.id, title)}
            onOpenSettings={() => props.onOpenSessionSettings(selectedSession.id)}
            settingsButtonRef={sessionSettingsFocusRef}
          />
        ) : undefined
      }
      workspaceNotice={
        <>
          {props.runtimeNotice}
          {props.archiveNotice}
          {props.toastNotice}
        </>
      }
      agentActionsEnabled={props.agentActionsEnabled}
      isSettingsView={Boolean(props.settingsPage)}
      contextPanelOpen={props.sessionSettingsOpen || planOpen}
      contextPanelExpanded={props.projectFilePanelExpanded}
      contextPanelRestoreFocusRef={
        planOpen
          ? planRestoreFocusRef
          : props.sessionSettingsOpen &&
              !props.projectFilePanel &&
              !props.skillDocumentPanel &&
              !props.workspaceChangesPanel
            ? sessionSettingsFocusRef
            : undefined
      }
      onContextPanelOpenChange={(open) => {
        if (props.sessionSettingsOpen) props.onSessionSettingsOpenChange(open)
        else if (planAvailable)
          setPlanPane((current) =>
            current && current.open !== open ? { ...current, open } : current,
          )
      }}
      showContextToggle={false}
      contextPanel={
        props.sessionSettingsOpen ? (
          contextPanel(props, selectedSession)
        ) : planAvailable ? (
          <div ref={setPlanHost} className="h-full min-h-0" />
        ) : undefined
      }
      workspace={
        <WorkspaceContent
          props={props}
          selectedSession={selectedSession}
          creatingProject={creatingProject}
          activeProject={activeProject}
          planPane={{
            host: planHost,
            available: planAvailable,
            open: planOpen,
            onAvailable: acceptPlanTask,
            onOpen: openPlan,
            onClose: closePlan,
            restoreFocusRef: planRestoreFocusRef,
          }}
        />
      }
    />
  )
}

function contextPanel(
  props: WorkspaceViewProps,
  selectedSession: CollaborationSession | undefined,
): ReactNode {
  if (!selectedSession || props.settingsPage) return undefined
  const nativeRecoveryLocked = nativeRecoveryTargets(props.conversation).length > 0
  if (props.skillDocumentPanel)
    return (
      <SkillDocumentPanel
        state={props.skillDocumentPanel}
        expanded={props.projectFilePanelExpanded}
        onExpandedChange={props.onProjectFilePanelExpandedChange}
        onClose={() => props.onSessionSettingsOpenChange(false)}
        onRetry={props.onRetrySkillDocument}
      />
    )
  if (props.workspaceChangesPanel) {
    return (
      <WorkspaceChangesPanel
        key={`${props.workspaceChangesPanel.sessionId}:${props.workspaceChangesPanel.changeSetId}:${props.workspaceChangesPanel.path}`}
        state={props.workspaceChangesPanel}
        expanded={props.projectFilePanelExpanded}
        onClose={() => props.onSessionSettingsOpenChange(false)}
        onExpandedChange={props.onProjectFilePanelExpandedChange}
      />
    )
  }
  if (props.projectFilePanel) {
    return (
      <ProjectFilePanel
        state={props.projectFilePanel}
        expanded={props.projectFilePanelExpanded}
        onClose={() => props.onSessionSettingsOpenChange(false)}
        onExpandedChange={props.onProjectFilePanelExpandedChange}
        onRetry={props.onRetryProjectFile}
        onCreateComment={props.onCreateFileComment}
        commentingDisabled={nativeRecoveryLocked}
      />
    )
  }
  return (
    <SessionSettingsPanel
      key={`${selectedSession.id}-${props.sessionSettingsEditorState?.session.settingsRevision ?? 'loading'}`}
      editorState={props.sessionSettingsEditorState}
      loading={props.sessionSettingsLoading}
      saving={props.savingSessionSettings}
      error={props.sessionError}
      onClose={() => props.onSessionSettingsOpenChange(false)}
      onRetry={() => props.onRetrySessionSettings(selectedSession.id)}
      onSave={(settings) => props.onSaveSessionSettings(selectedSession.id, settings)}
    />
  )
}

function WorkspaceContent({
  props,
  selectedSession,
  creatingProject,
  activeProject,
  planPane,
}: {
  props: WorkspaceViewProps
  selectedSession: CollaborationSession | undefined
  creatingProject: Project | undefined
  activeProject: Project | undefined
  planPane: {
    host: HTMLElement | null
    available: boolean
    open: boolean
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
        loading={props.creationLoading}
        creating={props.creatingSession}
        error={props.sessionError}
        onCancel={props.onCancelSessionCreation}
        onRetry={() => props.onStartSession(creatingProject.id)}
        onCreate={(settings) => props.onCreateSession(creatingProject.id, settings)}
        onOpenAppDefaults={() => props.onOpenSettings('session-defaults')}
      />
    )
  }
  if (selectedSession) {
    return (
      <div className="relative h-full min-h-0 overflow-hidden">
        {props.settingsPage ? (
          <div className="absolute inset-0 overflow-auto">{props.settingsView}</div>
        ) : null}
        <div
          className="h-full"
          style={{ visibility: props.settingsPage ? 'hidden' : 'visible' }}
          inert={Boolean(props.settingsPage)}
        >
          <ConversationErrorBoundary key={selectedSession.id}>
            <ConversationView
              planPanelHost={planPane.host}
              planPanelOpen={planPane.open}
              planAvailable={planPane.available}
              planRestoreFocusRef={planPane.restoreFocusRef}
              todoNavigation={props.todoNavigation}
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
      adding={props.adding}
      error={props.error}
      onAddProject={props.onAddProject}
      onOpenSettings={props.onOpenSettings}
      onRetry={props.onRetry}
      settingsButtonRef={props.settingsButtonRef}
    />
  )
}
