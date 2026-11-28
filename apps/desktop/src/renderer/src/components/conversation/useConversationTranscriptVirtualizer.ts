import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
  type WheelEvent,
} from 'react'

import type { AgentRun, ConversationDisplayOrder, MessageCommentAnchor } from '@pact/contracts'

import {
  compareConversationDisplayOrder,
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_WINDOW_MESSAGES,
  conversationMessageOrder,
} from '@pact/contracts'

import type { ConversationViewProjection } from './conversation-window'
import type { ConversationTranscriptRow } from './EditorialMessageItem'
import type { ConversationHistoryControls } from './useConversation'
import type { ConversationMessageNavigation } from './useConversationPlanPreview'

import {
  hasRecordingWarning,
  hasVisibleChanges,
  OLDER_HISTORY_SCROLL_THRESHOLD,
  TRANSCRIPT_OVERSCAN,
} from './conversation-view-helpers'
import { conversationWindowStartOrder, isRunResponseComplete } from './conversation-window'
import {
  clearProjectionHighlight,
  focusProjectionRange,
  isProjectionHighlightOwned,
  planSelectionSource,
  pulseMessageTarget,
  reportSelectionSource,
  reportSourceSelector,
  selectedTextRange,
} from './message-selection'

export interface UseConversationTranscriptVirtualizerOptions {
  readonly visible: boolean
  readonly loading: boolean
  readonly snapshot: ConversationViewProjection | undefined
  readonly history: ConversationHistoryControls
  readonly activeRun: AgentRun | undefined
  readonly activeRunHasMessage: boolean
  readonly runsById: ReadonlyMap<string, AgentRun>
  readonly activityOwnerMessageByRun: ReadonlyMap<string, string>
  readonly queuedInputId: string | undefined
  readonly messageNavigation: ConversationMessageNavigation | undefined
  readonly dismissedNavigation: ConversationMessageNavigation | undefined
  readonly dismissCommentNavigation: () => void
  readonly isNavigationApplied: (navigation: ConversationMessageNavigation) => boolean
  readonly markNavigationApplied: (navigation: ConversationMessageNavigation) => void
}

/**
 * Cohesive hook owning the virtualized transcript rows, measurement pruning, scroll intent,
 * stick-to-bottom behavior, prepend anchoring, reading-position & selection protection,
 * gap resync/restoration, comment navigation scrolling, and message copy feedback.
 */
export function useConversationTranscriptVirtualizer(
  options: UseConversationTranscriptVirtualizerOptions,
) {
  const {
    visible,
    loading,
    snapshot,
    history,
    activeRun,
    activeRunHasMessage,
    runsById,
    activityOwnerMessageByRun,
    queuedInputId,
    messageNavigation,
    dismissedNavigation,
    dismissCommentNavigation,
    isNavigationApplied,
    markNavigationApplied,
  } = options

  const gapRetryRef = useRef<{ mode: 'around'; messageId: string } | { mode: 'latest' }>({
    mode: 'latest',
  })
  const [copyFeedback, setCopyFeedback] = useState<
    { messageId: string; result: 'copying' | 'copied' | 'failed' } | undefined
  >(undefined)
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined)
  const copyRequestGenerationRef = useRef(0)
  const copyActiveRef = useRef(true)
  const transcriptRef = useRef<HTMLElement>(null)
  const transcriptContentRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLOListElement>(null)
  const [listOffset, setListOffset] = useState(24)
  const [selectionMessageIds, setSelectionMessageIds] = useState<string[]>([])
  const [selectionPlan, setSelectionPlan] = useState<MessageCommentAnchor['plan']>()
  const [selectionReport, setSelectionReport] = useState<MessageCommentAnchor['report']>()
  const [restorationReport, setRestorationReport] = useState<MessageCommentAnchor['report']>()
  const [restorationPlan, setRestorationPlan] = useState<MessageCommentAnchor['plan']>()
  const [restorationMessageIds, setRestorationMessageIds] = useState<string[]>([])
  const [requestedResponseId, setRequestedResponseId] = useState<string>()
  const [focusedRowKey, setFocusedRowKey] = useState<string>()
  const olderRequestedRef = useRef(false)
  const scrollIntentRef = useRef<'older' | 'newer' | 'drag' | 'start' | undefined>(undefined)
  const lastScrollRef = useRef({ top: 0, backward: false })
  const historyReadDirectionRef = useRef<'older' | 'latest'>('older')
  const prependAnchorRef = useRef<
    { messageId: string; top: number; beforeDisplay: ConversationDisplayOrder } | undefined
  >(undefined)
  const focusAfterPageRef = useRef<'latest' | undefined>(undefined)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const messagesRef = useRef(snapshot?.messages)
  const queueDockRef = useRef<HTMLDivElement>(null)
  const appliedGapResyncRef = useRef(0)
  const gapRestoreRef = useRef<
    | {
        messageId: string
        top: number
        plan?: MessageCommentAnchor['plan']
        report?: MessageCommentAnchor['report']
        selection?: {
          messageId?: string
          startOffset: number
          endOffset: number
          highlight?: boolean
          plan?: MessageCommentAnchor['plan']
          report?: MessageCommentAnchor['report']
        }
      }
    | undefined
  >(undefined)
  const stickToBottomRef = useRef(true)
  const wasVisibleRef = useRef(visible)

  useLayoutEffect(() => {
    messagesRef.current = snapshot?.messages
  }, [snapshot?.messages])

  const scrollVersion = `${snapshot?.messages.at(-1)?.id ?? ''}:${snapshot?.messages.length ?? 0}:${snapshot?.activities.length ?? 0}:${snapshot?.runs.length ?? 0}:${loading}`
  const residentMessages = snapshot?.messages
  const navigationMessage = messageNavigation
    ? residentMessages?.find((message) => message.id === messageNavigation.messageId)
    : undefined

  const historyLoadingPage = history.loadingPage
  const hasOlderHistory = history.window?.hasOlder
  const hasNewerHistory = Boolean(
    history.window &&
    (history.window.hasNewer ||
      (history.window.latestCompleteAssistantSequence ?? -1) >
        (residentMessages?.reduce(
          (latest, message) => Math.max(latest, conversationMessageOrder(message).sequence),
          -1,
        ) ?? -1)),
  )
  const ensureMessage = history.ensureMessage
  const recoverFromGap = history.recoverFromGap
  const loadLatestForGap = history.recoverLatest ?? history.loadLatest
  const historyLoading = history.loadingPage
  const gapRecoveryPending = history.gapRecoveryPending
  const historyResyncToken = history.historyResyncToken
  const protectReading = history.protectReading

  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLElement | null): void => {
      if (element) messageRefs.current.set(messageId, element)
      else messageRefs.current.delete(messageId)
    },
    [],
  )

  const visibleReadingSource = useCallback(():
    | {
        messageId: string
        element: HTMLElement
        plan?: MessageCommentAnchor['plan']
      }
    | undefined => {
    const transcript = transcriptRef.current
    if (!transcript) return undefined
    const viewport = transcript.getBoundingClientRect()
    const visibleElement = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    }
    let first:
      | { messageId: string; element: HTMLElement; plan?: MessageCommentAnchor['plan'] }
      | undefined
    const consider = (candidate: NonNullable<typeof first>): void => {
      if (!visibleElement(candidate.element)) return
      if (
        !first ||
        first.element.compareDocumentPosition(candidate.element) & Node.DOCUMENT_POSITION_PRECEDING
      )
        first = candidate
    }
    for (const message of messagesRef.current ?? []) {
      const element = messageRefs.current.get(message.id)
      if (element) consider({ messageId: message.id, element })
    }
    for (const document of transcript.querySelectorAll<HTMLElement>('[data-pact-plan-run-id]')) {
      const plan = planSelectionSource(document)
      const messageId = document.dataset.pactPlanMessageId
      const element = document.closest<HTMLElement>('.pact-review-card')
      if (plan && messageId && element) consider({ messageId, element, plan })
    }
    return first
  }, [])

  const readingPositionLost = history.readingPositionLost
  const hasProtectedSelection = useCallback((): boolean => {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const messageId = (
      anchor instanceof HTMLElement ? anchor : anchor?.parentElement
    )?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    return Boolean(
      selection &&
      !selection.isCollapsed &&
      transcriptRef.current?.contains(selection.anchorNode) &&
      messagesRef.current?.find((message) => message.id === messageId)?.state !== 'streaming' &&
      !isProjectionHighlightOwned(),
    )
  }, [])

  const clearOffscreenOrdinarySelection = useCallback((): void => {
    const selection = window.getSelection()
    const transcript = transcriptRef.current
    if (
      !selection ||
      selection.isCollapsed ||
      !transcript?.contains(selection.anchorNode) ||
      isProjectionHighlightOwned()
    )
      return
    const anchor = selection.anchorNode
    const selectedMessageId = (
      anchor instanceof HTMLElement ? anchor : anchor?.parentElement
    )?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const selectedIds = selectionMessageIds.length
      ? selectionMessageIds
      : selectedMessageId
        ? [selectedMessageId]
        : []
    const viewport = transcript.getBoundingClientRect()
    const selectedRows = selectionPlan
      ? [transcript.querySelector<HTMLElement>(`[data-pact-plan-run-id="${selectionPlan.runId}"]`)]
      : selectedIds.map((id) => messageRefs.current.get(id))
    const offscreen = selectedRows.some((row) => {
      if (!row) return true
      const rect = row.getBoundingClientRect()
      return rect.bottom <= viewport.top || rect.top >= viewport.bottom
    })
    if (!offscreen) return
    const restore = gapRestoreRef.current
    if (restore?.selection) {
      gapRestoreRef.current = {
        messageId: restore.messageId,
        top: restore.top,
        ...(restore.plan ? { plan: restore.plan } : {}),
      }
      setRestorationMessageIds([restore.messageId])
    }
    selection.removeAllRanges()
    setSelectionMessageIds([])
  }, [selectionMessageIds, selectionPlan])

  const snapshotFoldGuard = useCallback(
    (): boolean =>
      visible &&
      stickToBottomRef.current &&
      !hasProtectedSelection() &&
      !history.gapRecoveryPending &&
      !Object.values(history.window?.messageMeta ?? {}).some((meta) => meta.bodyResync),
    [visible, hasProtectedSelection, history.gapRecoveryPending, history.window?.messageMeta],
  )
  useLayoutEffect(() => {
    history.setSnapshotFoldGuard?.(snapshotFoldGuard)
    return () => history.setSnapshotFoldGuard?.(undefined)
  }, [history, snapshotFoldGuard])

  const collapseCompletedOutput = useCallback(() => {
    const runId = history.window?.preserveRunId
    if (!runId) return
    const run = runsById.get(runId)
    if (
      !run?.outputSnapshots?.settled ||
      history.loadingPage ||
      history.pageError ||
      !snapshotFoldGuard()
    )
      return
    const canonical = snapshot?.messages.find(
      (message) => message.runId === run.id && message.outputSnapshot?.canonical,
    )
    if (!canonical || canonical.state !== 'complete') return
    void history.collapseEarlierResponses?.(run.id)
  }, [history, runsById, snapshotFoldGuard, snapshot?.messages])
  useEffect(collapseCompletedOutput, [collapseCompletedOutput])

  const rows = useMemo<ConversationTranscriptRow[]>(() => {
    const messages = (snapshot?.messages ?? []).filter(
      (message) =>
        message.role !== 'assistant' ||
        message.content.trim() ||
        history.window?.messageMeta[message.id]?.oversized ||
        history.window?.messageMeta[message.id]?.hasComments ||
        Boolean(
          message.runId &&
          (hasVisibleChanges(runsById.get(message.runId)) ||
            runsById.get(message.runId)?.collaboration),
        ),
    )
    const result: ConversationTranscriptRow[] = messages.map((message) => ({
      key:
        message.outputSnapshot && message.outputSnapshot.ordinal > 0
          ? `message:${message.id}`
          : history.window?.sourceMessageId === message.id
            ? `source:${message.id}`
            : message.replyToMessageId
              ? `reply:${message.replyToMessageId}:${message.agentId ?? 'unknown'}:${message.runId ?? 'unknown'}`
              : `message:${message.id}`,
      message,
      run: undefined,
      context: undefined,
    }))
    for (const context of history.window?.runContexts ?? []) {
      const run = runsById.get(context.runId)
      if (run && !isRunResponseComplete(run))
        result.push({ key: `run-context:${context.runId}`, message: undefined, run, context })
    }
    result.sort((left, right) =>
      compareConversationDisplayOrder(
        left.message ? conversationMessageOrder(left.message) : left.context!.order,
        right.message ? conversationMessageOrder(right.message) : right.context!.order,
      ),
    )
    const artifactGroups = history.window?.runArtifacts ?? []
    const latestArtifactIds = new Set(artifactGroups.map((group) => group.latestRunId))
    for (const run of snapshot?.runs ?? []) {
      if ((!hasVisibleChanges(run) && !hasRecordingWarning(run)) || !latestArtifactIds.has(run.id))
        continue
      const replyIndex = result.findIndex(
        (row) =>
          row.message?.replyToMessageId === run.userMessageId &&
          row.message.agentId === run.agentId &&
          row.message.outputSnapshot?.canonical !== false,
      )
      if (run.outputSnapshots?.count && replyIndex < 0) continue
      const userIndex =
        replyIndex >= 0
          ? replyIndex
          : result.findIndex(
              (row) =>
                row.message?.id === run.userMessageId ||
                row.message?.replyToMessageId === run.userMessageId,
            )
      if (userIndex < 0) continue
      let index = userIndex + 1
      while (index < result.length) {
        const next = result[index]!
        if (
          next.message?.replyToMessageId !== run.userMessageId &&
          next.run?.userMessageId !== run.userMessageId
        )
          break
        const nextRun =
          next.run ?? (next.message?.runId ? runsById.get(next.message.runId) : undefined)
        if (nextRun && nextRun.createdAt > run.createdAt) break
        index += 1
      }
      result.splice(index, 0, { key: `changes:${run.id}`, message: undefined, run })
    }
    for (const run of snapshot?.runs ?? []) {
      if (
        !run.collaboration ||
        ['starting', 'running', 'recovering'].includes(run.status) ||
        result.some(
          (row) =>
            row.run?.id === run.id ||
            (row.message?.role === 'assistant' && row.message.runId === run.id),
        )
      )
        continue
      const userIndex = result.findIndex((row) => row.message?.id === run.userMessageId)
      if (userIndex >= 0)
        result.splice(userIndex + 1, 0, {
          key: `reply:${run.userMessageId}:${run.agentId}:${run.id}`,
          message: undefined,
          run,
        })
    }
    if (
      activeRun &&
      !activeRunHasMessage &&
      !result.some((row) => row.context?.runId === activeRun.id)
    )
      result.push({
        key: `reply:${activeRun.userMessageId}:${activeRun.agentId}:${activeRun.id}`,
        message: undefined,
        run: activeRun,
      })
    return result
  }, [
    snapshot?.messages,
    history.window?.messageMeta,
    history.window?.sourceMessageId,
    activeRun,
    activeRunHasMessage,
    snapshot?.runs,
    history.window?.runArtifacts,
    history.window?.runContexts,
    runsById,
  ])

  const rowKeySignature = useMemo(() => rows.map((row) => row.key).join('\0'), [rows])
  const rowKeys = useMemo(
    () => (rowKeySignature ? rowKeySignature.split('\0') : []),
    [rowKeySignature],
  )
  const getRowKey = useCallback((index: number) => rowKeys[index]!, [rowKeys])
  const pinnedIndexes = useMemo(() => {
    const ids = new Set(selectionMessageIds)
    const workLogRunId = history.window?.activityView?.manual
      ? history.window.activityView.runId
      : undefined
    const workLogComplete = isRunResponseComplete(
      workLogRunId ? runsById.get(workLogRunId) : undefined,
    )
    const planRunId =
      selectionPlan?.runId ??
      selectionReport?.runId ??
      restorationReport?.runId ??
      restorationPlan?.runId ??
      (messageNavigation && dismissedNavigation !== messageNavigation
        ? (messageNavigation.plan?.runId ?? messageNavigation.report?.runId)
        : undefined)
    for (const id of restorationMessageIds) ids.add(id)
    if (messageNavigation && dismissedNavigation !== messageNavigation)
      ids.add(messageNavigation.messageId)
    return rows.flatMap((row, index) =>
      row.key === focusedRowKey ||
      (row.message && ids.has(row.message.id)) ||
      Boolean(
        planRunId &&
        !row.context &&
        row.message?.outputSnapshot?.canonical !== false &&
        (row.run?.id === planRunId || row.message?.runId === planRunId),
      ) ||
      Boolean(
        workLogRunId &&
        (workLogComplete
          ? row.message?.id === activityOwnerMessageByRun.get(workLogRunId)
          : row.context?.runId === workLogRunId ||
            (!history.window?.runContexts?.some((context) => context.runId === workLogRunId) &&
              (row.run?.id === workLogRunId ||
                row.message?.id === activityOwnerMessageByRun.get(workLogRunId)))),
      )
        ? [index]
        : [],
    )
  }, [
    selectionMessageIds,
    selectionPlan,
    selectionReport,
    restorationReport,
    restorationPlan,
    restorationMessageIds,
    focusedRowKey,
    messageNavigation,
    dismissedNavigation,
    rows,
    history.window?.activityView,
    history.window?.runContexts,
    activityOwnerMessageByRun,
    runsById,
  ])

  // oxlint-disable-next-line react/incompatible-library -- The transcript viewport owner consumes this mutable instance directly, never through memoized props.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => 180,
    getItemKey: getRowKey,
    overscan: TRANSCRIPT_OVERSCAN,
    useFlushSync: true,
    measureElement: (element, entry) =>
      entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height,
    scrollMargin: listOffset,
    rangeExtractor: useCallback(
      (range) => {
        const indexes = new Set(pinnedIndexes.slice(0, CONVERSATION_WINDOW_MESSAGES))
        for (const index of defaultRangeExtractor(range)) {
          if (indexes.size >= CONVERSATION_WINDOW_MESSAGES) break
          indexes.add(index)
        }
        return [...indexes].toSorted((a, b) => a - b)
      },
      [pinnedIndexes],
    ),
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (scrollIntentRef.current === 'start') return false
    const top = transcriptRef.current?.scrollTop ?? instance.scrollOffset ?? 0
    return instance.itemSizeCache.has(item.key) ? item.end <= top : item.start < top
  }
  const virtualRows = virtualizer.getVirtualItems()
  const isViewportCommitted = useCallback(
    (transcript: HTMLElement): boolean => {
      if (Math.abs((virtualizer.scrollOffset ?? 0) - transcript.scrollTop) > 1) return false
      const current = virtualizer.getVirtualItems()
      return (
        current.length === virtualRows.length &&
        current.every((item, index) => {
          const rendered = virtualRows[index]!
          return (
            item.index === rendered.index &&
            item.key === rendered.key &&
            item.start === rendered.start &&
            item.size === rendered.size
          )
        })
      )
    },
    [virtualizer, virtualRows],
  )
  const mountedRowKeys = virtualRows.map((row) => row.key).join(':')
  const retainedRowKeys = useMemo(() => new Set(rowKeys), [rowKeys])
  const pruneMeasurements = useCallback(() => {
    for (const key of virtualizer.itemSizeCache.keys()) {
      if (!retainedRowKeys.has(String(key))) virtualizer.itemSizeCache.delete(key)
    }
  }, [virtualizer, retainedRowKeys])
  const measureRow = useCallback(
    (element: HTMLLIElement | null) => {
      if (element) pruneMeasurements()
      virtualizer.measureElement(element)
    },
    [virtualizer, pruneMeasurements],
  )
  useLayoutEffect(() => {
    pruneMeasurements()
  }, [pruneMeasurements])
  const cancelPrepend = useCallback(() => {
    if (!prependAnchorRef.current) return
    prependAnchorRef.current = undefined
    setRestorationMessageIds([])
  }, [])

  useEffect(() => {
    const protectSelection = (): void => {
      const selection = window.getSelection()
      const transcript = transcriptRef.current
      const ids: string[] = []
      let plan: MessageCommentAnchor['plan']
      let report: MessageCommentAnchor['report']
      if (selection && !selection.isCollapsed && selection.rangeCount === 1 && transcript) {
        const range = selection.getRangeAt(0)
        if (transcript.contains(range.commonAncestorContainer)) {
          const node = range.commonAncestorContainer
          const host = (
            node instanceof HTMLElement ? node : node.parentElement
          )?.closest<HTMLElement>('[data-pact-message-content]')
          if (host) {
            plan = planSelectionSource(host)
            report = reportSelectionSource(host)
          }
          for (const [id, row] of messageRefs.current) {
            if (
              messagesRef.current?.find((message) => message.id === id)?.state !== 'streaming' &&
              range.intersectsNode(row)
            )
              if (!ids.includes(id)) ids.push(id)
          }
        }
      }
      setSelectionMessageIds((previous) =>
        previous.length === ids.length && previous.every((id, index) => id === ids[index])
          ? previous
          : ids,
      )
      setSelectionPlan((previous) =>
        previous?.runId === plan?.runId && previous?.version === plan?.version ? previous : plan,
      )
      if (ids.length > 0) {
        stickToBottomRef.current = false
        scrollIntentRef.current = undefined
      }
      setSelectionReport((previous) =>
        JSON.stringify(previous) === JSON.stringify(report) ? previous : report,
      )
    }
    document.addEventListener('selectionchange', protectSelection)
    return () => document.removeEventListener('selectionchange', protectSelection)
  }, [])

  useEffect(() => {
    if (historyResyncToken === 0) {
      appliedGapResyncRef.current = 0
      gapRestoreRef.current = undefined
      gapRetryRef.current = { mode: 'latest' }
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
    }
  }, [historyResyncToken])

  useLayoutEffect(() => {
    const element = transcriptRef.current
    if (visible && scrollVersion && element && stickToBottomRef.current)
      element.scrollTop = element.scrollHeight
  }, [scrollVersion, visible, mountedRowKeys])

  useLayoutEffect(() => {
    if (wasVisibleRef.current === visible) return
    wasVisibleRef.current = visible
    if (visible) return
    cancelPrepend()
    const transcript = transcriptRef.current
    const selection = window.getSelection()
    const host =
      selection?.anchorNode instanceof HTMLElement
        ? selection.anchorNode.closest<HTMLElement>('[data-pact-message-content]')
        : selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-pact-message-content]')
    const selectedId = host?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const plan = host ? planSelectionSource(host) : undefined
    const report = host ? reportSelectionSource(host) : undefined
    const selected =
      snapshot?.messages.find((message) => message.id === selectedId)?.state !== 'streaming' &&
      selection &&
      !selection.isCollapsed &&
      host &&
      transcript?.contains(host)
        ? selectedTextRange(host, selection, CONVERSATION_MARKDOWN_BYTES)
        : undefined
    const anchor = visibleReadingSource()
    const row = anchor?.element
    if (!anchor || !row || (stickToBottomRef.current && !selected)) {
      protectReading(undefined)
      return
    }
    gapRestoreRef.current = {
      messageId: anchor.messageId,
      top: row.getBoundingClientRect().top,
      ...(anchor.plan ? { plan: anchor.plan } : {}),
      ...(selected && selectedId
        ? {
            selection: {
              messageId: selectedId,
              highlight: isProjectionHighlightOwned(),
              startOffset: selected.startOffset,
              endOffset: selected.endOffset,
              ...(plan ? { plan } : {}),
              ...(report ? { report } : {}),
            },
          }
        : {}),
    }
    setRestorationMessageIds([anchor.messageId, ...(selected && selectedId ? [selectedId] : [])])
    setRestorationPlan(anchor.plan ?? (selected ? plan : undefined))
    setRestorationReport(selected ? report : undefined)
    protectReading(anchor.messageId)
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
  }, [protectReading, snapshot?.messages, visible, cancelPrepend, visibleReadingSource])

  useLayoutEffect(() => {
    if (!residentMessages) return undefined
    const anchor = prependAnchorRef.current
    if (!anchor) return undefined
    const oldest = history.window ? conversationWindowStartOrder(history.window) : undefined
    if (!oldest || compareConversationDisplayOrder(oldest, anchor.beforeDisplay) >= 0)
      return undefined
    const message = messageRefs.current.get(anchor.messageId)
    const transcript = transcriptRef.current
    if (!transcript) return undefined
    if (!message) {
      const index = rows.findIndex((row) => row.message?.id === anchor.messageId)
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' })
      else {
        prependAnchorRef.current = undefined
        setRestorationMessageIds([])
      }
      return undefined
    }
    virtualizer.scrollToOffset(
      transcript.scrollTop + message.getBoundingClientRect().top - anchor.top,
    )
    const frame = requestAnimationFrame(() => {
      if (
        prependAnchorRef.current !== anchor ||
        !message.isConnected ||
        !isViewportCommitted(transcript) ||
        Math.abs(message.getBoundingClientRect().top - anchor.top) > 2
      )
        return undefined
      prependAnchorRef.current = undefined
      setRestorationMessageIds([])
      return undefined
    })
    return () => cancelAnimationFrame(frame)
  }, [residentMessages, history.window, rows, virtualizer, virtualRows, isViewportCommitted])

  useLayoutEffect(() => {
    const restore = gapRestoreRef.current
    const transcript = transcriptRef.current
    if (
      !visible ||
      loading ||
      !snapshot?.messages ||
      !transcript ||
      historyLoading ||
      gapRecoveryPending
    )
      return undefined
    if (!restore && !readingPositionLost) return undefined
    const message = restore?.plan
      ? transcript
          .querySelector<HTMLElement>(`[data-pact-plan-run-id="${restore.plan.runId}"]`)
          ?.closest<HTMLElement>('.pact-review-card')
      : restore
        ? messageRefs.current.get(restore.messageId)
        : undefined
    if (restore?.plan && !message && !readingPositionLost) return undefined
    if (restore && !message && !readingPositionLost) {
      const index = rows.findIndex((row) => row.message?.id === restore.messageId)
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'start' })
        return undefined
      }
    }
    if (!message || readingPositionLost) {
      gapRestoreRef.current = undefined
      setRestorationMessageIds([])
      gapRetryRef.current = { mode: 'latest' }
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      protectReading(undefined)
      stickToBottomRef.current = true
      transcript.scrollTop = transcript.scrollHeight
      if (!readingPositionLost) void loadLatestForGap()
      return undefined
    }
    if (!restore) return undefined
    const selectionMessage = restore.selection?.messageId
      ? messageRefs.current.get(restore.selection.messageId)
      : message
    if (
      restore.selection?.messageId &&
      !selectionMessage &&
      !restore.selection.plan &&
      !restore.selection.report
    ) {
      const index = rows.findIndex((row) => row.message?.id === restore.selection!.messageId)
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'start' })
        return undefined
      }
      gapRestoreRef.current = {
        messageId: restore.messageId,
        top: restore.top,
        ...(restore.plan ? { plan: restore.plan } : {}),
      }
      setRestorationMessageIds([restore.messageId])
      setSelectionMessageIds([])
      const currentSelection = window.getSelection()
      if (transcript.contains(currentSelection?.anchorNode ?? null))
        currentSelection?.removeAllRanges()
      return undefined
    }
    virtualizer.scrollToOffset(
      transcript.scrollTop + message.getBoundingClientRect().top - restore.top,
    )
    const content = restore.selection?.plan
      ? transcript.querySelector<HTMLElement>(
          `[data-pact-plan-run-id="${restore.selection.plan.runId}"] [data-pact-message-content]`,
        )
      : restore.selection?.report
        ? transcript.querySelector<HTMLElement>(
            `${reportSourceSelector(restore.selection.report)} [data-pact-message-content]`,
          )
        : selectionMessage?.querySelector<HTMLElement>('[data-pact-message-content]')
    const frame = requestAnimationFrame(() => {
      if (
        gapRestoreRef.current !== restore ||
        !wasVisibleRef.current ||
        !message.isConnected ||
        !isViewportCommitted(transcript) ||
        Math.abs(message.getBoundingClientRect().top - restore.top) > 2
      )
        return undefined
      if (restore.selection) {
        if (
          !content?.isConnected ||
          !focusProjectionRange(
            content,
            restore.selection.startOffset,
            restore.selection.endOffset,
            { scroll: false, highlight: restore.selection.highlight ?? false },
          )
        )
          return undefined
        setSelectionMessageIds([restore.selection.messageId ?? restore.messageId])
      }
      gapRestoreRef.current = undefined
      setRestorationMessageIds([])
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      return undefined
    })
    return () => cancelAnimationFrame(frame)
  }, [
    visible,
    loading,
    snapshot?.messages,
    historyLoading,
    gapRecoveryPending,
    protectReading,
    readingPositionLost,
    loadLatestForGap,
    rows,
    virtualizer,
    virtualRows,
    isViewportCommitted,
    messageNavigation,
  ])

  useEffect(() => {
    const token = historyResyncToken
    if (!visible || !token || token === appliedGapResyncRef.current || historyLoading) return
    appliedGapResyncRef.current = token
    cancelPrepend()
    scrollIntentRef.current = undefined
    const transcript = transcriptRef.current
    const firstVisible = visibleReadingSource()
    if (!firstVisible || !transcript) {
      gapRetryRef.current = { mode: 'latest' }
      gapRestoreRef.current = undefined
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      protectReading(undefined)
      stickToBottomRef.current = true
      if (transcript) transcript.scrollTop = transcript.scrollHeight
      void loadLatestForGap()
      return
    }
    const row = firstVisible.element
    if (!row) return
    const selection = window.getSelection()
    const selectionHost = (() => {
      if (!selection || selection.rangeCount !== 1) return undefined
      const node = selection.getRangeAt(0).commonAncestorContainer
      return (
        (node instanceof HTMLElement
          ? node.closest<HTMLElement>('[data-pact-message-content]')
          : node.parentElement?.closest<HTMLElement>('[data-pact-message-content]')) ?? undefined
      )
    })()
    const selectedMessageId =
      selectionHost?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const plan = selectionHost ? planSelectionSource(selectionHost) : undefined
    const report = selectionHost ? reportSelectionSource(selectionHost) : undefined
    const selected =
      selectedMessageId &&
      snapshot?.messages.find((message) => message.id === selectedMessageId)?.state !==
        'streaming' &&
      selection &&
      selectionHost
        ? selectedTextRange(selectionHost, selection, CONVERSATION_MARKDOWN_BYTES)
        : undefined
    gapRestoreRef.current = {
      messageId: firstVisible.messageId,
      top: row.getBoundingClientRect().top,
      ...(firstVisible.plan ? { plan: firstVisible.plan } : {}),
      ...(selected && selectedMessageId
        ? {
            selection: {
              messageId: selectedMessageId,
              startOffset: selected.startOffset,
              endOffset: selected.endOffset,
              highlight: isProjectionHighlightOwned(),
              ...(plan ? { plan } : {}),
              ...(report ? { report } : {}),
            },
          }
        : {}),
    }
    setRestorationMessageIds([
      firstVisible.messageId,
      ...(selected && selectedMessageId ? [selectedMessageId] : []),
    ])
    setRestorationPlan(firstVisible.plan ?? (selected ? plan : undefined))
    setRestorationReport(selected ? report : undefined)
    gapRetryRef.current = { mode: 'around', messageId: firstVisible.messageId }
    stickToBottomRef.current = false
    void recoverFromGap(firstVisible.messageId)
  }, [
    historyResyncToken,
    visible,
    historyLoading,
    recoverFromGap,
    loadLatestForGap,
    protectReading,
    snapshot?.messages,
    visibleReadingSource,
    cancelPrepend,
  ])

  useEffect(() => {
    if (historyLoadingPage || !focusAfterPageRef.current) return
    const direction = focusAfterPageRef.current
    focusAfterPageRef.current = undefined
    if (direction === 'latest' && !hasNewerHistory) {
      const last = residentMessages?.findLast((message) => message.role !== 'system')
      if (last) messageRefs.current.get(last.id)?.focus({ preventScroll: true })
    }
  }, [historyLoadingPage, hasNewerHistory, residentMessages])

  useLayoutEffect(() => {
    const content = transcriptContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const transcript = transcriptRef.current
      const list = messageListRef.current
      if (transcript && list)
        setListOffset(
          list.getBoundingClientRect().top -
            transcript.getBoundingClientRect().top +
            transcript.scrollTop,
        )
      if (transcript && !document.hidden && stickToBottomRef.current)
        transcript.scrollTop = transcript.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !messageNavigation || dismissedNavigation === messageNavigation)
      return undefined
    if (isNavigationApplied(messageNavigation)) return undefined
    if (messageNavigation.plan) return undefined
    cancelPrepend()
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
    gapRestoreRef.current = undefined
    setRestorationMessageIds([])
    setRestorationPlan(undefined)
    setRestorationReport(undefined)
    if (
      messageNavigation.queuedOperationId &&
      queuedInputId === messageNavigation.queuedOperationId
    ) {
      const dock = queueDockRef.current
      if (!dock) return undefined
      const focusDock = (): void => {
        dock.scrollIntoView({ behavior: 'smooth', block: 'center' })
        pulseMessageTarget(dock)
        markNavigationApplied(messageNavigation)
      }
      const frame = requestAnimationFrame(focusDock)
      return () => cancelAnimationFrame(frame)
    }
    void ensureMessage(messageNavigation.messageId)
    if (history.window?.sourceMessageId !== messageNavigation.messageId) return undefined
    if (messageNavigation.plan || messageNavigation.report) return undefined
    const message = navigationMessage
      ? messageRefs.current.get(messageNavigation.messageId)
      : undefined
    if (!message && navigationMessage) {
      const index = rows.findIndex((row) => row.message?.id === messageNavigation.messageId)
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
      return undefined
    }
    if (message) {
      stickToBottomRef.current = false
      const focus = (): boolean => {
        if (hasProtectedSelection()) return false
        if (
          focusProjectionRange(
            message,
            messageNavigation.startOffset,
            messageNavigation.endOffset,
            { scroll: false },
          )
        ) {
          const transcript = transcriptRef.current
          const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
          if (transcript && range) {
            virtualizer.scrollToOffset(
              transcript.scrollTop +
                range.top -
                transcript.getBoundingClientRect().top -
                transcript.clientHeight / 2 +
                range.height / 2,
              { behavior: 'smooth' },
            )
          }
          markNavigationApplied(messageNavigation)
          return true
        }
        if (messageNavigation.textBasis === 'plain-visible-v1') {
          const transcript = transcriptRef.current
          const rect = message.getBoundingClientRect()
          if (transcript && rect.height > 0) {
            virtualizer.scrollToOffset(
              transcript.scrollTop +
                rect.top -
                transcript.getBoundingClientRect().top -
                transcript.clientHeight / 2 +
                rect.height / 2,
              { behavior: 'smooth' },
            )
          }
          pulseMessageTarget(message)
          markNavigationApplied(messageNavigation)
          return true
        }
        return false
      }
      const frame = focus() ? undefined : requestAnimationFrame(() => void focus())
      return () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
      }
    }
    return undefined
  }, [
    ensureMessage,
    dismissedNavigation,
    hasProtectedSelection,
    messageNavigation,
    queuedInputId,
    history.window?.sourceMessageId,
    visible,
    navigationMessage,
    mountedRowKeys,
    rows,
    virtualizer,
    cancelPrepend,
    isNavigationApplied,
    markNavigationApplied,
  ])

  useEffect(() => clearProjectionHighlight, [messageNavigation, dismissedNavigation])

  useLayoutEffect(() => {
    if (!requestedResponseId || !visible) return
    const index = rows.findIndex((row) => row.message?.id === requestedResponseId)
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    const element = messageRefs.current.get(requestedResponseId)
    if (!element) return
    element.focus({ preventScroll: true })
    setRequestedResponseId(undefined)
    setRestorationMessageIds([])
  }, [requestedResponseId, visible, rows, mountedRowKeys, virtualizer])

  useEffect(() => {
    copyActiveRef.current = true
    return () => {
      copyActiveRef.current = false
      copyRequestGenerationRef.current += 1
      if (copyFeedbackTimerRef.current !== undefined) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const copyMessage = useCallback(async (messageId: string, content: string): Promise<void> => {
    const generation = ++copyRequestGenerationRef.current
    if (copyFeedbackTimerRef.current !== undefined) clearTimeout(copyFeedbackTimerRef.current)
    setCopyFeedback({ messageId, result: 'copying' })
    let result: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      result = 'failed'
    }
    if (!copyActiveRef.current || generation !== copyRequestGenerationRef.current) return
    setCopyFeedback({ messageId, result })
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = undefined
      setCopyFeedback(undefined)
    }, 2_000)
  }, [])

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      snapshot &&
      snapshot.messages.length + (history.window?.runContexts?.length ?? 0) >=
        CONVERSATION_WINDOW_MESSAGES &&
      hasProtectedSelection()
    ) {
      return
    }
    if (olderRequestedRef.current || history.loadingPage || !hasOlderHistory) return
    const transcript = transcriptRef.current
    const firstVisible = snapshot?.messages.find((message) => {
      const row = messageRefs.current.get(message.id)
      return (
        row &&
        transcript &&
        row.getBoundingClientRect().bottom > transcript.getBoundingClientRect().top &&
        row.getBoundingClientRect().top < transcript.getBoundingClientRect().bottom
      )
    })
    const element = firstVisible ? messageRefs.current.get(firstVisible.id) : undefined
    if (!firstVisible || !element) return
    olderRequestedRef.current = true
    scrollIntentRef.current = undefined
    historyReadDirectionRef.current = 'older'
    stickToBottomRef.current = false
    if (firstVisible && element) {
      prependAnchorRef.current = {
        messageId: firstVisible.id,
        top: element.getBoundingClientRect().top,
        beforeDisplay: conversationWindowStartOrder(history.window!)!,
      }
      setRestorationMessageIds([firstVisible.id])
    }
    try {
      await history.loadOlder()
    } finally {
      olderRequestedRef.current = false
    }
  }, [snapshot, history, hasProtectedSelection, hasOlderHistory])

  const loadLatest = useCallback(async (): Promise<void> => {
    setRequestedResponseId(undefined)
    gapRestoreRef.current = undefined
    setRestorationPlan(undefined)
    setRestorationReport(undefined)
    cancelPrepend()
    setRestorationMessageIds([])
    dismissCommentNavigation()
    const currentSelection = window.getSelection()
    if (transcriptRef.current?.contains(currentSelection?.anchorNode ?? null))
      currentSelection?.removeAllRanges()
    setSelectionMessageIds([])
    protectReading(undefined)
    historyReadDirectionRef.current = 'latest'
    stickToBottomRef.current = true
    scrollIntentRef.current = undefined
    focusAfterPageRef.current = 'latest'
    await history.loadLatest()
  }, [cancelPrepend, dismissCommentNavigation, history, protectReading])

  const requestOlderAtTop = useCallback(
    (scrollTop: number): void => {
      if (
        visible &&
        !loading &&
        !history.pageError &&
        !history.loadingPage &&
        !gapRecoveryPending &&
        scrollTop < OLDER_HISTORY_SCROLL_THRESHOLD
      )
        void loadOlder()
    },
    [visible, loading, history.pageError, history.loadingPage, gapRecoveryPending, loadOlder],
  )
  useLayoutEffect(() => {
    const intent = scrollIntentRef.current
    const transcript = transcriptRef.current
    if (transcript && (intent === 'older' || (intent === 'drag' && lastScrollRef.current.backward)))
      requestOlderAtTop(transcript.scrollTop)
  }, [virtualRows, requestOlderAtTop])

  const handlePlanReady = useCallback(
    (host: HTMLElement, onApplied?: () => void): (() => void) | undefined => {
      if (!visible || gapRecoveryPending || historyLoading || loading) return undefined
      const reveal = (): boolean => {
        const restore = gapRestoreRef.current
        const content = host.querySelector<HTMLElement>('[data-pact-message-content]')
        if (!content?.isConnected) return false
        const matches = (source: {
          plan?: MessageCommentAnchor['plan']
          report?: MessageCommentAnchor['report']
        }): boolean => {
          if (source.plan) return source.plan.runId === host.dataset.pactPlanRunId
          if (source.report) {
            const actual = reportSelectionSource(host)
            return actual?.runId === source.report.runId
          }
          return false
        }
        if (restore?.selection && matches(restore.selection)) {
          const transcript = transcriptRef.current
          const row =
            restore.plan || restore.report
              ? host.closest<HTMLElement>('.pact-review-card')
              : messageRefs.current.get(restore.messageId)
          if (
            !transcript ||
            !row ||
            !isViewportCommitted(transcript) ||
            Math.abs(row.getBoundingClientRect().top - restore.top) > 2
          )
            return false
          if (
            !focusProjectionRange(
              content,
              restore.selection.startOffset,
              restore.selection.endOffset,
              { scroll: false, highlight: restore.selection.highlight ?? false },
            )
          )
            return false
          gapRestoreRef.current = undefined
          setRestorationMessageIds([])
          setRestorationPlan(undefined)
          setRestorationReport(undefined)
          return true
        }
        if (
          (!messageNavigation?.plan && !messageNavigation?.report) ||
          dismissedNavigation === messageNavigation ||
          isNavigationApplied(messageNavigation)
        )
          return true
        if (
          !matches(messageNavigation) ||
          history.window?.sourceMessageId !== messageNavigation.messageId ||
          hasProtectedSelection()
        )
          return false
        if (
          !focusProjectionRange(
            content,
            messageNavigation.startOffset,
            messageNavigation.endOffset,
            { scroll: false },
          )
        )
          return false
        const transcript = transcriptRef.current
        const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
        if (transcript && range)
          virtualizer.scrollToOffset(
            transcript.scrollTop +
              range.top -
              transcript.getBoundingClientRect().top -
              transcript.clientHeight / 2 +
              range.height / 2,
            { behavior: 'smooth' },
          )
        markNavigationApplied(messageNavigation)
        return true
      }
      const frame = requestAnimationFrame(() => {
        if (reveal()) onApplied?.()
      })
      return () => {
        cancelAnimationFrame(frame)
      }
    },
    [
      visible,
      gapRecoveryPending,
      historyLoading,
      loading,
      messageNavigation,
      dismissedNavigation,
      history.window?.sourceMessageId,
      hasProtectedSelection,
      isViewportCommitted,
      virtualizer,
      isNavigationApplied,
      markNavigationApplied,
    ],
  )

  const revealReport =
    messageNavigation && dismissedNavigation !== messageNavigation
      ? messageNavigation.report
      : restorationReport
  const revealReportRequestId =
    messageNavigation && dismissedNavigation !== messageNavigation
      ? messageNavigation.navigationId
      : `restore:${gapRecoveryPending ?? ''}:${gapRestoreRef.current?.messageId ?? ''}`
  const revealReportOffset =
    gapRestoreRef.current?.selection?.startOffset ?? messageNavigation?.startOffset

  const beginDetailRead = useCallback((): void => {
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
  }, [])

  const viewSavedResponse = useCallback(
    (messageId: string): void => {
      cancelPrepend()
      stickToBottomRef.current = false
      scrollIntentRef.current = undefined
      setRequestedResponseId(messageId)
      setRestorationMessageIds([messageId])
      void history.ensureMessage(messageId)
    },
    [cancelPrepend, history],
  )

  const handleInputHeightDelta = useCallback(
    (delta: number): void => {
      if (!visible || !stickToBottomRef.current || hasProtectedSelection()) return
      const selection = window.getSelection()
      if (
        selection &&
        !selection.isCollapsed &&
        transcriptRef.current?.contains(selection.anchorNode) &&
        !isProjectionHighlightOwned()
      ) {
        return
      }
      const transcript = transcriptRef.current
      if (!transcript || !Number.isFinite(delta) || Math.abs(delta) <= 0.5) return
      scrollIntentRef.current = undefined
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight)
    },
    [hasProtectedSelection, visible],
  )

  const resetScrollForSubmit = useCallback((): void => {
    stickToBottomRef.current = true
    cancelPrepend()
    scrollIntentRef.current = undefined
  }, [cancelPrepend])

  const handleTranscriptFocusCapture = useCallback((event: FocusEvent<HTMLElement>): void => {
    const row = event.target.closest<HTMLElement>('[data-pact-row-key]')
    setFocusedRowKey(row?.dataset.pactRowKey)
  }, [])

  const handleTranscriptBlurCapture = useCallback((event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRowKey(undefined)
  }, [])

  const handleTranscriptPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      cancelPrepend()
      scrollIntentRef.current =
        event.target === event.currentTarget || event.pointerType === 'touch' ? 'drag' : undefined
    },
    [cancelPrepend],
  )

  const handleTranscriptWheel = useCallback(
    (event: WheelEvent<HTMLElement>): void => {
      cancelPrepend()
      scrollIntentRef.current = event.deltaY < 0 ? 'older' : 'newer'
      if (scrollIntentRef.current === 'older') {
        stickToBottomRef.current = false
        requestOlderAtTop(event.currentTarget.scrollTop)
      }
    },
    [cancelPrepend, requestOlderAtTop],
  )

  const handleTranscriptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.target !== event.currentTarget) return
      cancelPrepend()
      scrollIntentRef.current =
        event.key === 'Home'
          ? 'start'
          : ['PageUp', 'ArrowUp'].includes(event.key)
            ? 'older'
            : ['End', 'PageDown', 'ArrowDown'].includes(event.key)
              ? 'newer'
              : undefined
      if (scrollIntentRef.current === 'older' || scrollIntentRef.current === 'start') {
        stickToBottomRef.current = false
        requestOlderAtTop(event.currentTarget.scrollTop)
      }
    },
    [cancelPrepend, requestOlderAtTop],
  )

  const handleTranscriptScroll = useCallback(
    (event: UIEvent<HTMLElement>): void => {
      const element = event.currentTarget
      const scrollingUp = element.scrollTop < lastScrollRef.current.top
      lastScrollRef.current = { top: element.scrollTop, backward: scrollingUp }
      clearOffscreenOrdinarySelection()
      const intent = scrollIntentRef.current
      if (intent === 'older' || intent === 'start' || (intent === 'drag' && scrollingUp))
        stickToBottomRef.current = false
      else if (intent === 'newer' || intent === 'drag')
        stickToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 36
      if (stickToBottomRef.current && !hasProtectedSelection()) {
        protectReading(undefined)
        collapseCompletedOutput()
      }
      if ((intent === 'older' || intent === 'start' || intent === 'drag') && scrollingUp)
        requestOlderAtTop(element.scrollTop)
    },
    [
      clearOffscreenOrdinarySelection,
      collapseCompletedOutput,
      hasProtectedSelection,
      protectReading,
      requestOlderAtTop,
    ],
  )

  const handleRetryHistoryPage = useCallback((): void => {
    if (!history.gapRecoveryPending) {
      if (historyReadDirectionRef.current === 'latest') void loadLatest()
      else void loadOlder()
      return
    }
    const retry = gapRetryRef.current
    if (retry.mode === 'around') void history.recoverFromGap(retry.messageId)
    else void loadLatestForGap()
  }, [history, loadLatest, loadLatestForGap, loadOlder])

  return {
    transcriptRef,
    transcriptContentRef,
    messageListRef,
    queueDockRef,
    listOffset,
    rows,
    virtualizer,
    virtualRows,
    measureRow,
    hasOlderHistory,
    hasNewerHistory,
    copyFeedback,
    revealReport,
    revealReportRequestId,
    revealReportOffset,
    registerMessageElement,
    copyMessage,
    loadLatest,
    handlePlanReady,
    beginDetailRead,
    viewSavedResponse,
    handleInputHeightDelta,
    resetScrollForSubmit,
    handleTranscriptFocusCapture,
    handleTranscriptBlurCapture,
    handleTranscriptPointerDown,
    handleTranscriptWheel,
    handleTranscriptKeyDown,
    handleTranscriptScroll,
    handleRetryHistoryPage,
  }
}
