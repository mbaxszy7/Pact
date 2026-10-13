import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AppearanceSettingsUpdate,
  AppearanceSnapshot,
  AppearanceTheme,
  AnchoredComment,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  RuntimeAgentId,
  RuntimePreparation,
  SessionSettingsEditorState,
  WindowMaterial,
  SkillSelection,
} from '@pact/contracts'

import { MATERIAL_OPACITY_MAX, MATERIAL_OPACITY_MIN } from '@pact/contracts'

import type { ProjectFileTarget } from './components/conversation/MessageMarkdown'
import type { SkillDocumentPanelState } from './components/conversation/SkillDocumentPanel'
import type { ProjectFilePanelState } from './components/project-file/ProjectFilePanel'
import type { WorkspaceChangesPanelState } from './components/project-file/WorkspaceChangesPanel'
import type { SettingsPage } from './components/workspace/SettingsNavigation'

import {
  commentDraftSaveSucceeded,
  useConversation,
} from './components/conversation/useConversation'
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
import { APP_TOAST_DURATION_MS, AppToast, type AppToastTone } from './components/workspace/AppToast'
import { ArchiveNotice, type ArchivedItem } from './components/workspace/ArchiveNotice'
import { acceptSessionCatalogChange } from './components/workspace/session-catalog-cache'
import { useProjectCatalog } from './components/workspace/useProjectCatalog'
import { useSessionWorkspace } from './components/workspace/useSessionWorkspace'
import { WorkspaceView } from './components/workspace/WorkspaceView'
import { appearanceQueryKeys, foundationQueryKeys, unwrapRpcResult } from './query-client'

function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(null)
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const updateVisibility = (): void => setDocumentVisible(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  const [preview, setPreview] = useState<Omit<AppearanceSettingsUpdate, 'expectedRevision'> | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [isRuntimePreparationOpen, setIsRuntimePreparationOpen] = useState(false)
  const [showFirstUseDefaults, setShowFirstUseDefaults] = useState(false)
  const [choosingAgent, setChoosingAgent] = useState<RuntimeAgentId | undefined>()
  const [saveError, setSaveError] = useState<string | undefined>()
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>()
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
  const [archiveNotice, setArchiveNotice] = useState<ArchivedItem | undefined>()
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
    // oxlint-disable-next-line react/set-state-in-effect -- Persist the monotonic IPC revision when its Run projection advances; reader mode/path remain user-owned.
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

  const appInfo = appInfoQuery.data
  const showWorkspace = (): void => setSettingsPage(null)
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
      setCreationEditorState(prepared)
    } finally {
      setCreationLoading(false)
    }
  }

  const createSession = async (
    projectId: string,
    nextSettings: DefaultSessionSettings,
  ): Promise<void> => {
    const created = await sessionWorkspace.create(projectId, nextSettings)
    if (!created) return
    setCreatingProjectId(undefined)
    setCreationEditorState(undefined)
    setSelectedProjectId(projectId)
    setSelectedSessionId(created.id)
  }

  const selectSession = (sessionId: string): void => {
    setWorkspaceChangesPanel(undefined)
    invalidateContextRead()
    setSettingsPage(null)
    setCreatingProjectId(undefined)
    setCreationEditorState(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setProjectFilePanel(undefined)
    setProjectFilePanelExpanded(false)
    const session = sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId)
    setSelectedProjectId(session?.projectId)
    setSelectedSessionId(sessionId)
    setMessageNavigation(undefined)
  }

  const openSessionSettings = async (sessionId: string): Promise<void> => {
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsLoading(true)
    setSessionSettingsOpen(true)
    setProjectFilePanelExpanded(false)
    try {
      setSessionSettingsEditorState(await sessionWorkspace.loadSettings(sessionId))
    } finally {
      setSessionSettingsLoading(false)
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
    const editor = await sessionWorkspace.saveSettings(sessionId, nextSettings)
    if (editor) setSessionSettingsEditorState(editor)
  }

  const archiveSession = async (sessionId: string): Promise<void> => {
    const session = sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId)
    if (!session || !(await sessionWorkspace.archive(sessionId))) return

    if (selectedSessionId === sessionId) {
      setWorkspaceChangesPanel(undefined)
      setSelectedSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setProjectFilePanel(undefined)
      setProjectFilePanelExpanded(false)
    }
    setSelectedProjectId(session.projectId)
    setArchiveNotice({
      kind: 'session',
      id: session.id,
      title: session.title,
      projectId: session.projectId,
    })
  }

  const archiveProject = async (projectId: string): Promise<void> => {
    const project = projectCatalog.catalog?.projects.find((item) => item.id === projectId)
    if (!project || !(await projectCatalog.archive(projectId))) return

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
    setArchiveNotice({ kind: 'project', id: project.id, title: project.name })
  }

  const restoreArchived = async (item: ArchivedItem): Promise<void> => {
    const restored =
      item.kind === 'session'
        ? await sessionWorkspace.restore(item.id)
        : await projectCatalog.restore(item.id)
    if (!restored) return

    setArchiveNotice(undefined)
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setSessionSettingsOpen(false)
    setSettingsPage(null)
    if (item.kind === 'session') {
      setSelectedProjectId(item.projectId)
      setSelectedSessionId(item.id)
    } else {
      setSelectedProjectId(item.id)
      setSelectedSessionId(undefined)
    }
  }

  const toastNotice = toast ? (
    <AppToast key={toast.id} message={toast.message} tone={toast.tone} onDismiss={dismissToast} />
  ) : undefined

  if (!preparation || (preparation.firstUse && !showFirstUseDefaults) || isRuntimePreparationOpen) {
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
      </>
    )
  }

  if (preparation?.firstUse && showFirstUseDefaults) {
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
      </>
    )
  }

  return (
    <WorkspaceView
      onForkSessionCreated={(change, enter) => {
        acceptSessionCatalogChange(queryClient, change)
        if (enter) selectSession(change.session.id)
      }}
      onSaveSessionPermission={(input) => sessionWorkspace.savePermission(input)}
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
      settingsPage={settingsPage}
      onOpenSettings={(page) => {
        invalidateContextRead()
        setWorkspaceChangesPanel(undefined)
        setProjectFilePanel(undefined)
        setSessionSettingsOpen(false)
        setSettingsPage(page)
      }}
      onBackToApp={backToWorkspace}
      onAddProject={() => void projectCatalog.chooseAndAdd()}
      onArchiveProject={(projectId) => void archiveProject(projectId)}
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
        workspaceChangesPanel?.sessionId === selectedSessionId ? workspaceChangesPanel : undefined
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
      conversationComposerReturnedInputOperationId={conversation.composerReturnedInputOperationId}
      conversationLoading={conversation.loading}
      sendingMessage={conversation.sending}
      stoppingMessage={conversation.stopping}
      conversationError={conversation.error}
      messageNavigation={
        messageNavigation?.sessionId === selectedSessionId ? messageNavigation : undefined
      }
      todoNavigation={todoNavigation?.sessionId === selectedSessionId ? todoNavigation : undefined}
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
      onArchiveSession={(sessionId) => void archiveSession(sessionId)}
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
        archiveNotice ? (
          <ArchiveNotice
            item={archiveNotice}
            restoring={
              archiveNotice.kind === 'session'
                ? sessionWorkspace.restoringSessionId === archiveNotice.id
                : projectCatalog.restoringProjectId === archiveNotice.id
            }
            onUndo={() => void restoreArchived(archiveNotice)}
            onDismiss={() => setArchiveNotice(undefined)}
          />
        ) : undefined
      }
      toastNotice={toastNotice}
      settingsButtonRef={settingsButtonRef}
      agentActionsEnabled={allAgentsReady}
      runtimeNotice={
        allAgentsReady ? undefined : (
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
        settingsPage === 'appearance' ? (
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
            key={defaultSessionSettings.editorState?.current?.updatedAt ?? 'default-session-new'}
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
  )
}

export default App
