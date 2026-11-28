import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  CollaborationSession,
  CollaborationTask,
  CreateSideChatInput,
  CreateSideChatReceipt,
  RuntimeAgentId,
} from '@pact/contracts'

import { MAX_COMMENT_QUOTE_LENGTH, resolveMainChatSyncTarget } from '@pact/contracts'

import type { ComposerDocument } from '../components/conversation/composer-document'
import type { MessageTextSelection } from '../components/conversation/MessageSelectionSurface'
import type { ConversationFlow } from '../components/conversation/useConversation'
import type { AppToastTone } from '../components/workspace/AppToast'
import type { SessionWorkspaceFlow } from '../components/workspace/useSessionWorkspace'

import { useConversation } from '../components/conversation/useConversation'
import { initialSessionSettings } from '../components/settings/session/SessionSettingsFields'
import { useSideChats } from '../components/workspace/useSideChats'
import { unwrapRpcResult } from '../query-client'

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

export interface SideChatSettingsState {
  sideChatId?: string | undefined
  loading: boolean
  error?: string | undefined
  retryToken: number
}

export interface SideChatFlow {
  sideChats: ReturnType<typeof useSideChats>
  conversation: ConversationFlow
  sideChatVisible: boolean
  sideChatNavigationToken: number
  collaborationTask: CollaborationTask | null | undefined
  mainTargetAgentId: RuntimeAgentId | undefined
  sideChatSettingsState: SideChatSettingsState
  creatingSideChat: boolean
  sideChatHandoffKey: string | undefined
  setSideChatHandoffKey: React.Dispatch<React.SetStateAction<string | undefined>>
  retrySideChatSettings: (sideChatId: string) => void
  maybeDiscardEmptySideChat: (sideChatId: string) => boolean
  openSideChatsList: (options?: { clearOtherPanels?: boolean }) => void
  openSideChatDetail: (sideChatId: string, options?: { clearOtherPanels?: boolean }) => void
  openOriginSideChat: (sideChatId: string) => void
  backToSideChat: (() => void) | undefined
  openBtwSideChat: (draft: ComposerDocument) => Promise<boolean>
  askInSideChat: (selection: MessageTextSelection) => void
  createBlankSideChat: () => void
  resolveSideChatTitle: (sideChatId: string, fallbackTitle: string) => string
  hasLockedSideChatSettings: (sideChatId: string) => boolean
  resolveSideChatSession: (sideChatId: string) => CollaborationSession | undefined
  purgeSideChatCaches: (scope: { sessionId?: string; projectId?: string }) => void
  applyResolvedSideChat: (session: CollaborationSession) => void
}

export function useSideChatFlow({
  selectedSessionIdRef,
  selectedMainSession,
  mainParentSessionId,
  sideChatVisible,
  previewActive = false,
  sideChatsListVisible,
  mainConversation,
  sessionSettingsOpen,
  waitForInterest,
  sideChatsOpen,
  setSideChatsOpen,
  activeSideChatId,
  setActiveSideChatId,
  previewBackToSideChatId,
  setPreviewBackToSideChatId,
  sessionWorkspace,
  userSelectionEpochRef,
  inspectorNavigationEpochRef,
  showWarning,
  showError,
  showToast,
  onClearPanelsForSideChat,
  onInspectorNavigate,
  onSelectParentSession,
}: {
  selectedSessionIdRef: React.RefObject<string | undefined>
  selectedMainSession: CollaborationSession | undefined
  mainParentSessionId: string | undefined
  sideChatVisible: boolean
  previewActive?: boolean | undefined
  sideChatsListVisible: boolean
  mainConversation: ConversationFlow
  sessionSettingsOpen: boolean
  waitForInterest: () => Promise<boolean>
  sideChatsOpen: boolean
  setSideChatsOpen: React.Dispatch<React.SetStateAction<boolean>>
  activeSideChatId: string | undefined
  setActiveSideChatId: React.Dispatch<React.SetStateAction<string | undefined>>
  previewBackToSideChatId: string | undefined
  setPreviewBackToSideChatId: React.Dispatch<React.SetStateAction<string | undefined>>
  sessionWorkspace: SessionWorkspaceFlow
  userSelectionEpochRef: React.RefObject<number>
  inspectorNavigationEpochRef: React.RefObject<number>
  showWarning: (message: string) => void
  showError: (message: string) => void
  showToast: (message: string, tone?: AppToastTone) => void
  onClearPanelsForSideChat: () => void
  onInspectorNavigate?: (() => void) | undefined
  onSelectParentSession: (sessionId: string, projectId: string) => void
}): SideChatFlow {
  const [sideChatSessionsById, setSideChatSessionsById] = useState<
    Record<string, CollaborationSession>
  >({})
  const [sideChatSettingsRetryToken, setSideChatSettingsRetryToken] = useState(0)
  const [settingsRequest, setSettingsRequest] = useState<{
    sideChatId: string | undefined
    requestSeq: number
  }>({
    sideChatId: activeSideChatId,
    requestSeq: activeSideChatId ? 1 : 0,
  })
  if (settingsRequest.sideChatId !== activeSideChatId) {
    setSettingsRequest((current) => ({
      sideChatId: activeSideChatId,
      requestSeq: activeSideChatId ? current.requestSeq + 1 : current.requestSeq,
    }))
  }
  const [sideChatSettingsResult, setSideChatSettingsResult] = useState<
    { sideChatId: string; requestSeq: number; error?: string | undefined } | undefined
  >()
  const [creatingSideChat, setCreatingSideChat] = useState(false)
  const [sideChatHandoffKey, setSideChatHandoffKey] = useState<string | undefined>()
  const [sideChatNavigationToken, setSideChatNavigationToken] = useState(0)
  const requestSideChatsFocus = useCallback((): void => {
    setSideChatNavigationToken((current) => current + 1)
  }, [])

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

  const createSideChatInFlightRef = useRef(false)
  const updateSideChatFromSessionRef = useRef<
    ((session: CollaborationSession) => void) | undefined
  >(undefined)

  const sideChats = useSideChats({
    parentSessionId: mainParentSessionId,
    listOpen: sideChatsListVisible,
  })

  const sideChatConversationId =
    activeSideChatId ?? (previewActive ? previewBackToSideChatId : undefined)
  const cachedSideChatForConversation = sideChatConversationId
    ? sideChatSessionsById[sideChatConversationId]
    : undefined
  const sideChatParentMismatch = Boolean(
    cachedSideChatForConversation &&
    selectedMainSession &&
    cachedSideChatForConversation.parentSessionId !== selectedMainSession.id,
  )
  const effectiveSideChatVisible = Boolean(
    sideChatVisible && mainParentSessionId && activeSideChatId && !sideChatParentMismatch,
  )
  const effectivePreviewActive = Boolean(
    previewActive && mainParentSessionId && sideChatConversationId && !sideChatParentMismatch,
  )

  const sideChatConversation = useConversation(
    sideChatConversationId,
    showWarning,
    effectiveSideChatVisible,
    showError,
    showToast,
    {
      disableAutoInterest: true,
      waitForInterest,
      projectionActive: effectivePreviewActive,
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

  const latestMainRun = mainConversation.history.window?.latestRun
  const mainCollaborationKey = `${latestMainRun?.id ?? ''}:${latestMainRun?.status ?? ''}:${
    latestMainRun && !['starting', 'running', 'recovering'].includes(latestMainRun.status)
      ? latestMainRun.updatedAt
      : ''
  }:${mainConversation.snapshot?.queue?.revision ?? ''}`

  const mainCollaborationQuery = useQuery({
    queryKey: [
      'conversation',
      mainParentSessionId ?? '',
      'collaboration',
      mainCollaborationKey,
    ] as const,
    enabled: Boolean(
      mainParentSessionId && ((sideChatsOpen && activeSideChatId) || sessionSettingsOpen),
    ),
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

  const activeParentTask =
    mainCollaborationQuery.data?.status === 'complete'
      ? undefined
      : (mainCollaborationQuery.data ?? undefined)
  const mainTargetAgentId = selectedMainSession
    ? resolveMainChatSyncTarget(selectedMainSession.settings.primaryAgentId, activeParentTask)
    : undefined

  const updateSideChatFromSession = sideChats.updateSideChatFromSession
  useLayoutEffect(() => {
    updateSideChatFromSessionRef.current = updateSideChatFromSession
  }, [updateSideChatFromSession])

  const sideChatSnapshotSession = sideChatConversation.snapshot?.session
  const currentSettingsRequestSeq = settingsRequest.requestSeq
  useEffect(() => {
    if (!activeSideChatId) return undefined
    let active = true
    const requestSeq = currentSettingsRequestSeq
    void window.pact
      .getSessionSettings(activeSideChatId)
      .then((result) => {
        if (!active) return undefined
        if (!result.ok) {
          setSideChatSettingsResult({
            sideChatId: activeSideChatId,
            requestSeq,
            error: result.error.message || 'Could not load side chat settings.',
          })
          return undefined
        }
        const loaded = result.value.session
        setSideChatSessionsById((current) => {
          const existing = current[loaded.id]
          const nextLoaded =
            existing && !existing.hasUnread && loaded.updatedAt <= existing.updatedAt
              ? { ...loaded, hasUnread: false }
              : loaded
          return upsertSideChatSessionMap(current, nextLoaded, protectedSideChatIdsRef.current)
        })
        setSideChatSettingsResult({
          sideChatId: activeSideChatId,
          requestSeq,
          error: undefined,
        })
        updateSideChatFromSession(loaded)
        return undefined
      })
      .catch((error: unknown) => {
        if (!active) return undefined
        setSideChatSettingsResult({
          sideChatId: activeSideChatId,
          requestSeq,
          error:
            error instanceof Error && error.message
              ? error.message
              : 'Could not load side chat settings.',
        })
        return undefined
      })
    return () => {
      active = false
    }
  }, [activeSideChatId, currentSettingsRequestSeq, updateSideChatFromSession])

  const settledSideChatSettings =
    Boolean(activeSideChatId) &&
    sideChatSettingsResult !== undefined &&
    sideChatSettingsResult.sideChatId === activeSideChatId &&
    sideChatSettingsResult.requestSeq === currentSettingsRequestSeq
  const sideChatSettingsState: SideChatSettingsState = {
    sideChatId: activeSideChatId,
    loading: Boolean(activeSideChatId) && !settledSideChatSettings,
    error: settledSideChatSettings ? sideChatSettingsResult?.error : undefined,
    retryToken: sideChatSettingsRetryToken,
  }

  useEffect(() => {
    if (!sideChatSnapshotSession) return
    setSideChatSessionsById((current) => {
      const existing = current[sideChatSnapshotSession.id]
      if (!existing) return current
      const resolvedHasUnread =
        !existing.hasUnread && sideChatSnapshotSession.updatedAt <= existing.updatedAt
          ? false
          : sideChatSnapshotSession.hasUnread
      const nextMerged: CollaborationSession = {
        ...existing,
        ...sideChatSnapshotSession,
        hasUnread: resolvedHasUnread,
      }
      if (
        existing.title === nextMerged.title &&
        existing.titleSource === nextMerged.titleSource &&
        existing.status === nextMerged.status &&
        existing.hasUnread === nextMerged.hasUnread &&
        existing.updatedAt === nextMerged.updatedAt
      ) {
        return current
      }
      return upsertSideChatSessionMap(current, nextMerged, protectedSideChatIdsRef.current)
    })
    updateSideChatFromSession(sideChatSnapshotSession)
  }, [sideChatSnapshotSession, updateSideChatFromSession])

  const latestStateRef = useRef({
    activeSideChatId,
    previewBackToSideChatId,
    sideChatConversation,
    sideChats,
    sideChatSessionsById,
    onClearPanelsForSideChat,
    onInspectorNavigate,
    onSelectParentSession,
    sessionWorkspaceCatalog: sessionWorkspace.catalog,
  })
  useLayoutEffect(() => {
    latestStateRef.current = {
      activeSideChatId,
      previewBackToSideChatId,
      sideChatConversation,
      sideChats,
      sideChatSessionsById,
      onClearPanelsForSideChat,
      onInspectorNavigate,
      onSelectParentSession,
      sessionWorkspaceCatalog: sessionWorkspace.catalog,
    }
  })

  const isUntouchedEmptySideChat = (sideChatId: string): boolean => {
    const latest = latestStateRef.current
    if (sideChatId !== latest.activeSideChatId) return false
    if (latest.sideChatConversation.sending) return false
    if (
      latest.sideChatConversation.composer.trim() ||
      latest.sideChatConversation.composerImages.length > 0 ||
      latest.sideChatConversation.composerSkills.length > 0 ||
      latest.sideChatConversation.composerMention ||
      latest.sideChatConversation.composerUserInformation ||
      latest.sideChatConversation.composerReturnedInputOperationId
    ) {
      return false
    }
    const snap =
      latest.sideChatConversation.snapshot?.session.id === sideChatId
        ? latest.sideChatConversation.snapshot
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
    const summary = latest.sideChats.items.find((item) => item.id === sideChatId)
    const cached = latest.sideChatSessionsById[sideChatId]
    const status = cached?.status ?? summary?.status
    return (
      status === 'draft' && !summary?.isRunning && !summary?.needsAttention && !summary?.previewText
    )
  }

  const maybeDiscardEmptySideChat = (sideChatId: string): boolean => {
    if (!isUntouchedEmptySideChat(sideChatId)) return false
    latestStateRef.current.sideChats.removeSideChat(sideChatId)
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
          latestStateRef.current.sideChats.refresh()
        }
        return undefined
      })
      .catch(() => {
        latestStateRef.current.sideChats.refresh()
      })
    return true
  }

  const openSideChatsList = (options?: { clearOtherPanels?: boolean }): void => {
    const latest = latestStateRef.current
    if (options?.clearOtherPanels) {
      latest.onClearPanelsForSideChat()
      setPreviewBackToSideChatId(undefined)
    }
    if (latest.activeSideChatId) maybeDiscardEmptySideChat(latest.activeSideChatId)
    setActiveSideChatId(undefined)
    setSideChatsOpen(true)
    latest.onInspectorNavigate?.()
    requestSideChatsFocus()
  }

  const openSideChatDetail = (
    sideChatId: string,
    options?: { clearOtherPanels?: boolean },
  ): void => {
    const latest = latestStateRef.current
    if (options?.clearOtherPanels) {
      latest.onClearPanelsForSideChat()
      setPreviewBackToSideChatId(undefined)
    }
    if (latest.activeSideChatId && latest.activeSideChatId !== sideChatId) {
      maybeDiscardEmptySideChat(latest.activeSideChatId)
    }
    setActiveSideChatId(sideChatId)
    setSideChatsOpen(true)
    latest.onInspectorNavigate?.()
    requestSideChatsFocus()
  }

  const openOriginSideChat = (sideChatId: string): void => {
    const selectionEpoch = userSelectionEpochRef.current
    const inspectorEpoch = inspectorNavigationEpochRef.current
    void (async () => {
      const local = latestStateRef.current.sideChatSessionsById[sideChatId]
      const summary = latestStateRef.current.sideChats.items.find((item) => item.id === sideChatId)
      let loaded = local
      if (!loaded) {
        const fetched = await window.pact.getSessionSettings(sideChatId).catch(() => undefined)
        if (
          selectionEpoch !== userSelectionEpochRef.current ||
          inspectorEpoch !== inspectorNavigationEpochRef.current
        )
          return
        if (fetched?.ok) {
          loaded = fetched.value.session
        }
      }
      const latest = latestStateRef.current
      const resolvedParentId = loaded?.parentSessionId ?? summary?.parentSessionId
      if (!resolvedParentId || loaded?.status === 'archived') {
        showWarning('The source side chat is no longer available.')
        return
      }
      if (resolvedParentId === selectedSessionIdRef.current) {
        if (loaded) {
          setSideChatSessionsById((current) =>
            upsertSideChatSessionMap(current, loaded, [sideChatId, latest.previewBackToSideChatId]),
          )
        }
        openSideChatDetail(sideChatId)
        return
      }
      const targetParent = latest.sessionWorkspaceCatalog?.sessions.find(
        (item) =>
          item.id === resolvedParentId && item.status !== 'archived' && !item.parentSessionId,
      )
      if (!targetParent) {
        showWarning('The parent Session for this side chat is archived or unavailable.')
        return
      }
      latest.onSelectParentSession(targetParent.id, targetParent.projectId)
      if (loaded) {
        setSideChatSessionsById((current) =>
          upsertSideChatSessionMap(current, loaded, [sideChatId]),
        )
      }
      setActiveSideChatId(sideChatId)
      setSideChatsOpen(true)
      latest.onInspectorNavigate?.()
      requestSideChatsFocus()
    })()
  }

  const backToSideChat = previewBackToSideChatId
    ? (): void => {
        const sideChatId = previewBackToSideChatId
        latestStateRef.current.onClearPanelsForSideChat()
        setPreviewBackToSideChatId(undefined)
        setActiveSideChatId(sideChatId)
        setSideChatsOpen(true)
        latestStateRef.current.onInspectorNavigate?.()
        requestSideChatsFocus()
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
    input: CreateSideChatInput,
  ): Promise<
    { kind: 'receipt'; receipt: CreateSideChatReceipt } | { kind: 'uncertain' } | { kind: 'failed' }
  > => {
    const existing = await window.pact
      .readCreateSideChatReceipt({ operationId: input.operationId })
      .catch(() => undefined)
    if (existing?.ok && existing.value) return { kind: 'receipt', receipt: existing.value }
    let result: Awaited<ReturnType<typeof window.pact.createSideChat>>
    try {
      result = await window.pact.createSideChat(input)
    } catch (error) {
      const receipt = await window.pact
        .readCreateSideChatReceipt({ operationId: input.operationId })
        .catch(() => undefined)
      if (receipt?.ok && receipt.value) return { kind: 'receipt', receipt: receipt.value }
      showError(
        error instanceof Error && error.message
          ? error.message
          : 'Side chat creation could not be confirmed.',
      )
      return { kind: 'uncertain' }
    }
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
      latestStateRef.current.sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
      let draftConflict = false
      const seeded = latestStateRef.current.sideChatConversation.seedComposerDraft(
        outcome.receipt.sideChat.id,
        draft,
        {
          onConflict: () => {
            draftConflict = true
          },
        },
      )
      setSideChatHandoffKey(operationId)
      openSideChatDetail(outcome.receipt.sideChat.id)
      if (!seeded) {
        showWarning(
          draftConflict
            ? 'Opened the side chat, but kept both drafts because the side chat already has text.'
            : 'Opened the side chat, but your main draft was kept because draft memory is full.',
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
        latestStateRef.current.sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
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
        latestStateRef.current.sideChats.applyCreatedSideChat(outcome.receipt.sideChat)
        setSideChatHandoffKey(operationId)
        openSideChatDetail(outcome.receipt.sideChat.id)
      } finally {
        createSideChatInFlightRef.current = false
        setCreatingSideChat(false)
      }
    })()
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

  const applyResolvedSideChat = (session: CollaborationSession): void => {
    setSideChatSessionsById((current) => upsertSideChatSessionMap(current, session, [session.id]))
    setPreviewBackToSideChatId(undefined)
    setActiveSideChatId(session.id)
    setSideChatsOpen(true)
    requestSideChatsFocus()
  }

  const resolveSideChatTitle = useCallback(
    (sideChatId: string, fallbackTitle: string): string => {
      if (sideChatSnapshotSession?.id === sideChatId) {
        return sideChatSnapshotSession.title
      }
      const cached = sideChatSessionsById[sideChatId]
      if (cached) return cached.title
      const summary = sideChats.items.find((item) => item.id === sideChatId)
      return summary?.title ?? fallbackTitle
    },
    [sideChatSnapshotSession, sideChatSessionsById, sideChats.items],
  )

  const hasLockedSideChatSettings = (sideChatId: string): boolean => {
    const cached = sideChatSessionsById[sideChatId]
    return Boolean(
      cached && (!selectedMainSession || cached.parentSessionId === selectedMainSession.id),
    )
  }

  const resolveSideChatSession = (sideChatId: string): CollaborationSession | undefined => {
    const live =
      sideChatConversation.snapshot?.session.id === sideChatId
        ? sideChatConversation.snapshot.session
        : undefined
    const cached = sideChatSessionsById[sideChatId]
    if (cached) {
      if (selectedMainSession && cached.parentSessionId !== selectedMainSession.id) {
        return undefined
      }
      return live ? { ...cached, ...live } : cached
    }
    if (!selectedMainSession) return undefined
    const summary = sideChats.items.find((item) => item.id === sideChatId)
    if (summary && summary.parentSessionId !== selectedMainSession.id) {
      return undefined
    }
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
      settings: initialSessionSettings,
      settingsRevision: 1,
      createdAt: summary?.createdAt ?? selectedMainSession.createdAt,
      updatedAt: summary?.updatedAt ?? selectedMainSession.updatedAt,
      ...(summary ? { sideChatOrigin: summary.origin } : {}),
    }
    return live ? { ...fallback, ...live } : fallback
  }

  const retrySideChatSettings = (_sideChatId: string): void => {
    setSideChatSettingsRetryToken((previous) => previous + 1)
    setSettingsRequest((current) => ({ ...current, requestSeq: current.requestSeq + 1 }))
  }

  return {
    sideChats,
    conversation: sideChatConversation,
    sideChatVisible: effectiveSideChatVisible,
    sideChatNavigationToken,
    collaborationTask: mainCollaborationQuery.data,
    mainTargetAgentId,
    sideChatSettingsState,
    creatingSideChat,
    sideChatHandoffKey,
    setSideChatHandoffKey,
    retrySideChatSettings,
    maybeDiscardEmptySideChat,
    openSideChatsList,
    openSideChatDetail,
    openOriginSideChat,
    backToSideChat,
    openBtwSideChat,
    askInSideChat,
    createBlankSideChat,
    resolveSideChatTitle,
    hasLockedSideChatSettings,
    resolveSideChatSession,
    purgeSideChatCaches,
    applyResolvedSideChat,
  }
}
