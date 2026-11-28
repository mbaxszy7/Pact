import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  AnchoredComment,
  FileCommentAnchor,
  MessageCommentAnchor,
  SessionSettingsEditorState,
  SideChatSyncMainReceipt,
  SkillSelection,
} from '@pact/contracts'

import { MESSAGE_ANCHOR_TEXT_BASIS } from '@pact/contracts'

import type { ProjectFileTarget } from '../components/conversation/MessageMarkdown'
import type { SkillDocumentPanelState } from '../components/conversation/SkillDocumentPanel'
import type {
  CommentDraftSaveOutcome,
  ConversationFlow,
} from '../components/conversation/useConversation'
import type { ProjectFilePanelState } from '../components/project-file/ProjectFilePanel'
import type { WorkspaceChangesPanelState } from '../components/project-file/WorkspaceChangesPanel'
import type { AppToastTone } from '../components/workspace/AppToast'

export interface WorkspaceProjectFilePanelState extends ProjectFilePanelState {
  requestId?: number | undefined
}

export interface WorkspaceChangesNavigationTarget {
  sessionId: string
  changeSetId: string
  path: string
  revision?: number | undefined
  expectedGeneration?: number | undefined
}

export type WorkspaceChangesNavigationGuard = (target: WorkspaceChangesNavigationTarget) => boolean

export interface MessageNavigationState {
  sessionId: string
  navigationId: string
  messageId: string
  queuedOperationId?: string | undefined
  startOffset: number
  endOffset: number
  textBasis?: MessageCommentAnchor['textBasis']
  plan?: MessageCommentAnchor['plan']
  report?: MessageCommentAnchor['report']
}

export interface CreateFileCommentOptions {
  commentId?: string | undefined
  sessionId?: string | undefined
  requestId?: string | undefined
  mode?: 'create' | 'edit' | undefined
}

export interface WorkspacePanelsFlow {
  projectFilePanel: WorkspaceProjectFilePanelState | undefined
  projectFileSessionId: string | undefined
  workspaceChangesPanel: WorkspaceChangesPanelState | undefined
  visibleWorkspaceChangesPanel: WorkspaceChangesPanelState | undefined
  changesNavigationToken: number
  fileNavigationToken: number
  projectFilePanelExpanded: boolean
  setProjectFilePanelExpanded: React.Dispatch<React.SetStateAction<boolean>>
  skillDocumentPanel: SkillDocumentPanelState | undefined
  messageNavigation: MessageNavigationState | undefined
  setMessageNavigation: React.Dispatch<React.SetStateAction<MessageNavigationState | undefined>>
  overlayCloseToken: number
  invalidateContextRead: () => number
  clearContextPanels: (options?: { clearMessageNavigation?: boolean }) => void
  clearWorkspaceChangesPanel: () => void
  focusChangesTab: () => void
  registerChangesNavigationGuard: (guard: WorkspaceChangesNavigationGuard | undefined) => void
  confirmExternalWorkspaceChanges: (target: WorkspaceChangesNavigationTarget) => void
  readSkillDocument: (
    sessionId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ) => Promise<void>
  openProjectFile: (target: ProjectFileTarget) => void
  openWorkspaceChanges: (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
    targetSessionId?: string,
  ) => void
  openSideChatProjectFile: (target: ProjectFileTarget, sideChatId: string) => void
  openSideChatSkillDocument: (
    sideChatId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ) => void
  openSideChatWorkspaceChanges: (
    sideChatId: string,
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ) => void
  viewSyncedMainMessage: (receipt: SideChatSyncMainReceipt) => void
  openSentComment: (comment: AnchoredComment) => void
  createFileComment: (
    anchor: FileCommentAnchor,
    body: string,
    options?: CreateFileCommentOptions,
  ) => Promise<CommentDraftSaveOutcome>
  retryProjectFile: () => void
}

export function useWorkspacePanels({
  selectedSessionId,
  selectedSessionIdRef,
  activeSideChatId,
  previewBackToSideChatId,
  workspaceChangesPanel,
  setWorkspaceChangesPanel,
  projectFileSessionId,
  setProjectFileSessionId,
  changesTabVisible = false,
  waitForInterest,
  utilityRecovery = 0,
  onInspectorNavigate,
  conversation,
  sideChatConversation,
  setSessionSettingsOpen,
  setSessionSettingsEditorState,
  setSideChatsOpen,
  setActiveSideChatId,
  setPreviewBackToSideChatId,
  maybeDiscardEmptySideChat,
  openSideChatDetail,
  showToast,
}: {
  selectedSessionId: string | undefined
  selectedSessionIdRef: React.RefObject<string | undefined>
  activeSideChatId: string | undefined
  previewBackToSideChatId: string | undefined
  workspaceChangesPanel: WorkspaceChangesPanelState | undefined
  setWorkspaceChangesPanel: React.Dispatch<
    React.SetStateAction<WorkspaceChangesPanelState | undefined>
  >
  projectFileSessionId: string | undefined
  setProjectFileSessionId: React.Dispatch<React.SetStateAction<string | undefined>>
  changesTabVisible?: boolean | undefined
  waitForInterest?: (() => Promise<boolean>) | undefined
  utilityRecovery?: number | undefined
  onInspectorNavigate?: (() => void) | undefined
  conversation: ConversationFlow
  sideChatConversation: ConversationFlow
  setSessionSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSessionSettingsEditorState: React.Dispatch<
    React.SetStateAction<SessionSettingsEditorState | undefined>
  >
  setSideChatsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setActiveSideChatId: React.Dispatch<React.SetStateAction<string | undefined>>
  setPreviewBackToSideChatId: React.Dispatch<React.SetStateAction<string | undefined>>
  maybeDiscardEmptySideChat: (sideChatId: string) => boolean
  openSideChatDetail: (sideChatId: string) => void
  showToast: (message: string, tone?: AppToastTone) => void
}): WorkspacePanelsFlow {
  const [projectFilePanel, setProjectFilePanel] = useState<
    WorkspaceProjectFilePanelState | undefined
  >()
  const [projectFilePanelExpanded, setProjectFilePanelExpanded] = useState(false)
  const [skillDocumentPanel, setSkillDocumentPanel] = useState<SkillDocumentPanelState>()
  const [messageNavigation, setMessageNavigation] = useState<MessageNavigationState | undefined>()
  const [overlayCloseToken, setOverlayCloseToken] = useState(0)
  const [changesNavigationToken, setChangesNavigationToken] = useState(0)
  const [fileNavigationToken, setFileNavigationToken] = useState(0)

  const projectFileRequestRef = useRef(0)
  const skillDocumentRequestRef = useRef<string | undefined>(undefined)
  const viewSourceTimerRef = useRef<number | undefined>(undefined)
  const changesNavigationGuardRef = useRef<WorkspaceChangesNavigationGuard | undefined>(undefined)
  const workspaceChangesPanelRef = useRef(workspaceChangesPanel)
  const waitForInterestRef = useRef(waitForInterest)
  const onInspectorNavigateRef = useRef(onInspectorNavigate)
  useLayoutEffect(() => {
    workspaceChangesPanelRef.current = workspaceChangesPanel
    waitForInterestRef.current = waitForInterest
    onInspectorNavigateRef.current = onInspectorNavigate
  }, [workspaceChangesPanel, waitForInterest, onInspectorNavigate])

  const registerChangesNavigationGuard = useCallback(
    (guard: WorkspaceChangesNavigationGuard | undefined): void => {
      changesNavigationGuardRef.current = guard
    },
    [],
  )

  const focusChangesTab = useCallback((): void => {
    setChangesNavigationToken((current) => current + 1)
  }, [])

  const invalidateContextRead = (): number => {
    const request = skillDocumentRequestRef.current
    skillDocumentRequestRef.current = undefined
    if (request) void window.pact.cancelSkillDocument(request).catch(() => undefined)
    setSkillDocumentPanel(undefined)
    return ++projectFileRequestRef.current
  }

  useEffect(
    () => () => {
      if (skillDocumentRequestRef.current)
        void window.pact.cancelSkillDocument(skillDocumentRequestRef.current).catch(() => undefined)
      window.clearTimeout(viewSourceTimerRef.current)
    },
    [],
  )

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

  if (
    workspaceChangesPanel &&
    selectedChangesRevision !== undefined &&
    selectedChangesRevision > (workspaceChangesPanel.revision ?? 0)
  ) {
    setWorkspaceChangesPanel((current) =>
      current &&
      current.sessionId === workspaceChangesPanel.sessionId &&
      current.changeSetId === workspaceChangesPanel.changeSetId &&
      selectedChangesRevision > (current.revision ?? 0)
        ? { ...current, revision: selectedChangesRevision }
        : current,
    )
  }

  const activeChangesSessionId = workspaceChangesPanel?.sessionId
  const activeChangesSetId = workspaceChangesPanel?.changeSetId
  useEffect(() => {
    if (!activeChangesSessionId || !activeChangesSetId) return undefined
    return window.pact?.onConversationChanged?.((patch) => {
      if (patch.sessionId !== activeChangesSessionId) return
      let maxRevision = 0
      for (const run of patch.runs) {
        if (
          run.workspaceChanges?.id === activeChangesSetId &&
          run.workspaceChanges.revision !== undefined
        ) {
          maxRevision = Math.max(maxRevision, run.workspaceChanges.revision)
        }
      }
      if (maxRevision <= 0) return
      setWorkspaceChangesPanel((current) =>
        current &&
        current.sessionId === activeChangesSessionId &&
        current.changeSetId === activeChangesSetId &&
        maxRevision > (current.revision ?? 0)
          ? { ...current, revision: maxRevision }
          : current,
      )
    })
  }, [activeChangesSessionId, activeChangesSetId, setWorkspaceChangesPanel])

  const prevChangesTabVisibleRef = useRef(changesTabVisible)
  const prevUtilityRecoveryRef = useRef(utilityRecovery)
  useEffect(() => {
    const visibleNow = changesTabVisible
    const wasVisible = prevChangesTabVisibleRef.current
    prevChangesTabVisibleRef.current = visibleNow
    const recoveryIncremented = utilityRecovery > prevUtilityRecoveryRef.current
    prevUtilityRecoveryRef.current = utilityRecovery

    if (!activeChangesSessionId || !activeChangesSetId) return undefined
    let cancelled = false
    let inFlight = false
    const runRefresh = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        if (waitForInterestRef.current) {
          const ready = await waitForInterestRef.current()
          if (cancelled || !ready) return
        }
        const result = await window.pact?.readWorkspaceChanges?.({
          changeSetId: activeChangesSetId,
        })
        if (cancelled || !result?.ok) return
        const { changeSet } = result.value
        if (changeSet.id !== activeChangesSetId || changeSet.sessionId !== activeChangesSessionId) {
          return
        }
        const nextRevision = changeSet.revision ?? 0
        setWorkspaceChangesPanel((current) =>
          current &&
          current.sessionId === activeChangesSessionId &&
          current.changeSetId === activeChangesSetId &&
          nextRevision > (current.revision ?? 0)
            ? { ...current, revision: Math.max(current.revision ?? 0, nextRevision) }
            : current,
        )
      } catch {
        // Bounded best-effort metadata refresh; ignore transient read failures.
      } finally {
        inFlight = false
      }
    }

    if ((visibleNow && !wasVisible) || recoveryIncremented) {
      void runRefresh()
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && visibleNow) {
        void runRefresh()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    activeChangesSessionId,
    activeChangesSetId,
    changesTabVisible,
    utilityRecovery,
    setWorkspaceChangesPanel,
  ])

  const visibleWorkspaceChangesPanel = useMemo(() => {
    const visible =
      workspaceChangesPanel?.sessionId === selectedSessionId ||
      (activeSideChatId && workspaceChangesPanel?.sessionId === activeSideChatId)
        ? workspaceChangesPanel
        : undefined
    if (!visible || selectedChangesRevision === undefined) return visible
    if (selectedChangesRevision <= (visible.revision ?? 0)) return visible
    return { ...visible, revision: selectedChangesRevision }
  }, [activeSideChatId, selectedChangesRevision, selectedSessionId, workspaceChangesPanel])

  const clearContextPanels = (options?: { clearMessageNavigation?: boolean }): void => {
    invalidateContextRead()
    setWorkspaceChangesPanel(undefined)
    setProjectFilePanel(undefined)
    setProjectFileSessionId(undefined)
    setProjectFilePanelExpanded(false)
    if (options?.clearMessageNavigation) setMessageNavigation(undefined)
  }

  const clearWorkspaceChangesPanel = (): void => {
    setWorkspaceChangesPanel(undefined)
  }

  const readProjectFile = async (sessionId: string, target: ProjectFileTarget): Promise<void> => {
    setWorkspaceChangesPanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    const requestId = invalidateContextRead()
    const commentNavigation = Boolean(target.commentId)
    if (commentNavigation) {
      setProjectFilePanel(undefined)
      setProjectFileSessionId(undefined)
    } else {
      setProjectFileSessionId(sessionId)
      setProjectFilePanel({ target, requestId, loading: true })
      onInspectorNavigateRef.current?.()
      setFileNavigationToken((current) => current + 1)
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
        setProjectFileSessionId(sessionId)
        setProjectFilePanel({ target, requestId, loading: false, error: result.error.message })
        return
      }
      if (expectedContentHash && result.value.contentHash !== expectedContentHash) {
        if (commentNavigation) {
          showToast('Comment source has changed.', 'warning')
          return
        }
        setProjectFileSessionId(sessionId)
        setProjectFilePanel({
          target,
          requestId,
          loading: false,
          error: 'This file no longer matches the requested version.',
        })
        return
      }
      setProjectFileSessionId(sessionId)
      setProjectFilePanel({ target, requestId, file: result.value, loading: false })
      if (commentNavigation) {
        onInspectorNavigateRef.current?.()
        setFileNavigationToken((current) => current + 1)
      }
    } catch {
      if (requestId !== projectFileRequestRef.current) return
      if (commentNavigation) {
        showToast('Comment source is unavailable.', 'error')
        return
      }
      setProjectFileSessionId(sessionId)
      setProjectFilePanel({
        target,
        requestId,
        loading: false,
        error: 'Pact could not connect to the file reader.',
      })
    }
  }

  const readSkillDocument = async (
    sessionId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ): Promise<void> => {
    const epoch = invalidateContextRead()
    const requestId = crypto.randomUUID()
    skillDocumentRequestRef.current = requestId
    setProjectFilePanel(undefined)
    setProjectFileSessionId(undefined)
    setWorkspaceChangesPanel(undefined)
    setSessionSettingsEditorState(undefined)
    setSessionSettingsOpen(false)
    setSkillDocumentPanel({ sessionId, skill, loading: true })
    onInspectorNavigateRef.current?.()
    setFileNavigationToken((current) => current + 1)
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
      if (skillDocumentRequestRef.current === requestId) skillDocumentRequestRef.current = undefined
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

  const applyWorkspaceChangesTarget = (
    target: WorkspaceChangesNavigationTarget,
    isSideChatTarget: boolean,
  ): void => {
    if (isSideChatTarget) {
      invalidateContextRead()
      setProjectFilePanel(undefined)
      setProjectFileSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      setSideChatsOpen(true)
      setPreviewBackToSideChatId(target.sessionId)
      const observedRevision =
        sideChatConversation.snapshot?.sessionId === target.sessionId
          ? sideChatConversation.snapshot.runs.find(
              (run) => run.workspaceChanges?.id === target.changeSetId,
            )?.workspaceChanges?.revision
          : undefined
      setWorkspaceChangesPanel((current) => ({
        sessionId: target.sessionId,
        changeSetId: target.changeSetId,
        path: target.path,
        revision:
          Math.max(
            target.revision ?? 0,
            observedRevision ?? 0,
            current?.sessionId === target.sessionId && current.changeSetId === target.changeSetId
              ? (current.revision ?? 0)
              : 0,
          ) || undefined,
      }))
    } else {
      if (activeSideChatId) maybeDiscardEmptySideChat(activeSideChatId)
      setActiveSideChatId(undefined)
      setSideChatsOpen(false)
      setPreviewBackToSideChatId(undefined)
      invalidateContextRead()
      setProjectFilePanel(undefined)
      setProjectFileSessionId(undefined)
      setSessionSettingsEditorState(undefined)
      setSessionSettingsOpen(false)
      const observedRevision =
        conversation.snapshot?.sessionId === target.sessionId
          ? conversation.snapshot.runs.find(
              (run) => run.workspaceChanges?.id === target.changeSetId,
            )?.workspaceChanges?.revision
          : undefined
      setWorkspaceChangesPanel((current) => ({
        sessionId: target.sessionId,
        changeSetId: target.changeSetId,
        path: target.path,
        revision:
          Math.max(
            target.revision ?? 0,
            observedRevision ?? 0,
            current?.sessionId === target.sessionId && current.changeSetId === target.changeSetId
              ? (current.revision ?? 0)
              : 0,
          ) || undefined,
      }))
    }
    onInspectorNavigateRef.current?.()
    setChangesNavigationToken((current) => current + 1)
  }

  const shouldBlockWorkspaceChangesSwitch = (target: WorkspaceChangesNavigationTarget): boolean => {
    const current = workspaceChangesPanelRef.current
    if (!current) return false
    const switching =
      current.sessionId !== target.sessionId ||
      current.changeSetId !== target.changeSetId ||
      current.path !== target.path
    if (!switching) return false
    return Boolean(changesNavigationGuardRef.current?.(target))
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
    const target: WorkspaceChangesNavigationTarget = {
      sessionId: sideChatId,
      changeSetId,
      path,
      revision,
      expectedGeneration,
    }
    if (shouldBlockWorkspaceChangesSwitch(target)) return
    applyWorkspaceChangesTarget(target, true)
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
    const target: WorkspaceChangesNavigationTarget = {
      sessionId: selectedSessionId,
      changeSetId,
      path,
      revision,
      expectedGeneration,
    }
    if (shouldBlockWorkspaceChangesSwitch(target)) return
    applyWorkspaceChangesTarget(target, false)
  }

  const confirmExternalWorkspaceChanges = (target: WorkspaceChangesNavigationTarget): void => {
    if (!selectedSessionId) return
    const isSideChatTarget = target.sessionId !== selectedSessionId
    applyWorkspaceChangesTarget(target, isSideChatTarget)
  }

  const navigateMainMessageTarget = (
    parentSessionId: string,
    target: {
      messageId: string
      queuedOperationId?: string | undefined
      startOffset: number
      endOffset: number
      textBasis?: MessageCommentAnchor['textBasis'] | undefined
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
      setProjectFileSessionId(undefined)
      setOverlayCloseToken((current) => current + 1)
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
    setProjectFileSessionId(undefined)
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
    anchor: FileCommentAnchor,
    body: string,
    options?: CreateFileCommentOptions,
  ): Promise<CommentDraftSaveOutcome> => {
    const targetSessionId = options?.sessionId ?? previewBackToSideChatId ?? selectedSessionId
    if (!targetSessionId) return false
    const draftOwner =
      targetSessionId !== selectedSessionId &&
      (targetSessionId === activeSideChatId || targetSessionId === previewBackToSideChatId)
        ? sideChatConversation
        : conversation
    const commentId = options?.commentId ?? crypto.randomUUID()
    const requestPart = options?.requestId ? { requestId: options.requestId } : {}
    if (options?.mode === 'edit') {
      return draftOwner.saveCommentDraft({
        mode: 'edit',
        ...requestPart,
        sessionId: targetSessionId,
        commentId,
        body,
      })
    }
    return draftOwner.saveCommentDraft({
      mode: 'create',
      ...requestPart,
      sessionId: targetSessionId,
      commentId,
      body,
      anchor,
    })
  }

  const retryProjectFile = (): void => {
    const targetSessionId = projectFileSessionId ?? previewBackToSideChatId ?? selectedSessionId
    if (!targetSessionId || !projectFilePanel) return
    void readProjectFile(targetSessionId, projectFilePanel.target)
  }

  return {
    projectFilePanel,
    projectFileSessionId,
    workspaceChangesPanel,
    visibleWorkspaceChangesPanel,
    changesNavigationToken,
    fileNavigationToken,
    projectFilePanelExpanded,
    setProjectFilePanelExpanded,
    skillDocumentPanel,
    messageNavigation,
    setMessageNavigation,
    overlayCloseToken,
    invalidateContextRead,
    clearContextPanels,
    clearWorkspaceChangesPanel,
    focusChangesTab,
    registerChangesNavigationGuard,
    confirmExternalWorkspaceChanges,
    readSkillDocument,
    openProjectFile,
    openWorkspaceChanges,
    openSideChatProjectFile,
    openSideChatSkillDocument,
    openSideChatWorkspaceChanges,
    viewSyncedMainMessage,
    openSentComment,
    createFileComment,
    retryProjectFile,
  }
}
