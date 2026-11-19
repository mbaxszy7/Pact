import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  CONVERSATION_ACTIVE_SESSIONS_PER_VIEWER,
  SIDE_CHAT_LIST_PAGE_BYTES,
  SIDE_CHAT_LIST_PAGE_ITEMS,
  SIDE_CHAT_LIST_RESIDENT_BYTES,
  SIDE_CHAT_LIST_RESIDENT_ITEMS,
  type CollaborationSession,
  type ConversationPatch,
  type ListSideChatsPage,
  type SideChatCursor,
  type SideChatSummary,
} from '@pact/contracts'

const SIDE_CHAT_READ_TIMEOUT_MS = 5_000
const textEncoder = new TextEncoder()

function summaryByteSize(item: SideChatSummary): number {
  return textEncoder.encode(JSON.stringify(item)).byteLength + 1
}

function pageWithinByteLimit(page: ListSideChatsPage): boolean {
  return textEncoder.encode(JSON.stringify(page)).byteLength <= SIDE_CHAT_LIST_PAGE_BYTES
}

function compareSideChatOrder(a: SideChatSummary, b: SideChatSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
  if (a.id !== b.id) return a.id > b.id ? -1 : 1
  return 0
}

function cursorFromSummary(item: SideChatSummary | undefined): SideChatCursor | null {
  return item ? { createdAt: item.createdAt, id: item.id } : null
}

function isRunningStatus(session: Pick<ConversationPatch['session'], 'activity'>): boolean {
  return session.activity.state === 'agent_working' || session.activity.state === 'recovering'
}

function isAttentionSession(
  session: Pick<ConversationPatch['session'], 'status' | 'activity'>,
): boolean {
  return session.status === 'waiting_for_user' || session.activity.state === 'waiting_for_user'
}

function trimSurrogateSafePreview(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text
  const boundary = text.charCodeAt(maxUnits - 1)
  const end = boundary >= 0xd800 && boundary <= 0xdbff ? maxUnits - 1 : maxUnits
  return text.slice(0, end)
}

interface SideChatWindowState {
  parentSessionId: string | undefined
  items: SideChatSummary[]
  bytes: number
  nextCursor: SideChatCursor | null
  prevCursor: SideChatCursor | null
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  activeCount: number
  attentionCount: number
  unreadCount: number
  initialized: boolean
  loadingInitial: boolean
  loadingMoreOlder: boolean
  loadingMoreNewer: boolean
  initialError?: string | undefined
  olderError?: string | undefined
  newerError?: string | undefined
}

const emptyState = (parentSessionId: string | undefined): SideChatWindowState => ({
  parentSessionId,
  items: [],
  bytes: 2,
  nextCursor: null,
  prevCursor: null,
  hasMoreOlder: false,
  hasMoreNewer: false,
  activeCount: 0,
  attentionCount: 0,
  unreadCount: 0,
  initialized: false,
  loadingInitial: false,
  loadingMoreOlder: false,
  loadingMoreNewer: false,
})

function totalSummaryBytes(items: readonly SideChatSummary[]): number {
  return items.reduce((sum, item) => sum + summaryByteSize(item), 2)
}

function trimResidentWindow(
  items: SideChatSummary[],
  trimFrom: 'head' | 'tail',
): { items: SideChatSummary[]; bytes: number; trimmedCount: number } {
  const next = [...items]
  let bytes = totalSummaryBytes(next)
  let trimmedCount = 0
  while (
    next.length > 0 &&
    (next.length > SIDE_CHAT_LIST_RESIDENT_ITEMS || bytes > SIDE_CHAT_LIST_RESIDENT_BYTES)
  ) {
    const removed = trimFrom === 'head' ? next.shift() : next.pop()
    if (!removed) break
    bytes -= summaryByteSize(removed)
    trimmedCount += 1
  }
  return { items: next, bytes, trimmedCount }
}

function mergeOrderedUnique(
  existing: readonly SideChatSummary[],
  incoming: readonly SideChatSummary[],
): SideChatSummary[] {
  const byId = new Map<string, SideChatSummary>()
  for (const item of existing) byId.set(item.id, item)
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].toSorted(compareSideChatOrder)
}

async function readSideChatsWithTimeout(
  input: Parameters<Window['pact']['listSideChats']>[0],
  onStart?: (underlying: Promise<unknown>) => void,
): Promise<ListSideChatsPage> {
  let timer: number | undefined
  const ipcPromise = window.pact.listSideChats(input)
  onStart?.(ipcPromise)
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        reject(new Error('Couldn’t load side chats in time. Try again.'))
      }, SIDE_CHAT_READ_TIMEOUT_MS)
    })
    const result = await Promise.race([ipcPromise, timeout])
    if (!result.ok) {
      throw new Error(result.error.message || 'Side chats could not be loaded.')
    }
    if (!pageWithinByteLimit(result.value)) {
      throw new Error('Side chat response exceeded its page byte budget.')
    }
    return result.value
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

/**
 * Publishes up to two visible active conversation session IDs (`main` + optional `sideChat`)
 * from one owner so dual Conversation hooks never clobber conversation interest.
 */
export function useActiveSessionInterest(
  sessionIds: readonly (string | undefined)[],
  visible: boolean,
  resetGeneration = 0,
): {
  waitForReady: () => Promise<boolean>
  error: string | undefined
} {
  const generationRef = useRef(0)
  const publishedKeyRef = useRef<string | undefined>(undefined)
  const pendingRef = useRef<{ key: string; promise: Promise<boolean> } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const unique: string[] = []
  if (visible) {
    for (const candidate of sessionIds) {
      if (!candidate || unique.includes(candidate)) continue
      unique.push(candidate)
      if (unique.length >= CONVERSATION_ACTIVE_SESSIONS_PER_VIEWER) break
    }
  }
  const key = visible ? unique.join(',') : ''
  const effectiveKey = `${key}#${resetGeneration}`
  const desiredTarget: string | string[] | null =
    unique.length === 0 ? null : unique.length === 1 ? unique[0]! : unique
  const targetRef = useRef<string | string[] | null>(desiredTarget)
  useLayoutEffect(() => {
    targetRef.current = desiredTarget
  }, [desiredTarget])

  const dispatchInterest = useCallback(
    (targetKey: string, target: string | string[] | null): Promise<boolean> => {
      const generation = ++generationRef.current
      const promise = window.pact
        .setConversationInterest(target, generation)
        .then((result) => {
          if (generationRef.current !== generation) return false
          if (result.ok) {
            publishedKeyRef.current = targetKey
            setError(undefined)
            return true
          }
          publishedKeyRef.current = undefined
          setError(result.error.message)
          return false
        })
        .catch((caught: unknown) => {
          if (generationRef.current !== generation) return false
          publishedKeyRef.current = undefined
          setError(
            caught instanceof Error ? caught.message : 'Could not subscribe to active sessions.',
          )
          return false
        })
        .finally(() => {
          if (pendingRef.current?.promise === promise) {
            pendingRef.current = undefined
          }
        })
      pendingRef.current = { key: targetKey, promise }
      return promise
    },
    [],
  )

  useLayoutEffect(() => {
    if (publishedKeyRef.current === effectiveKey) return
    publishedKeyRef.current = undefined
    if (pendingRef.current?.key === effectiveKey) return
    void dispatchInterest(effectiveKey, targetRef.current)
  }, [dispatchInterest, effectiveKey])

  useEffect(
    () => () => {
      publishedKeyRef.current = undefined
      pendingRef.current = undefined
      void window.pact.setConversationInterest(null, ++generationRef.current).catch(() => undefined)
    },
    [],
  )

  const waitForReady = useCallback(async (): Promise<boolean> => {
    if (!visible) return true
    if (publishedKeyRef.current === effectiveKey && !pendingRef.current) return true
    if (pendingRef.current && pendingRef.current.key === effectiveKey) {
      return pendingRef.current.promise
    }
    return dispatchInterest(effectiveKey, targetRef.current)
  }, [dispatchInterest, effectiveKey, visible])

  return { waitForReady, error }
}

/** Continuous, bidirectional keyset-cursor side chat list bounded to 100 items / 256 KiB. */
export function useSideChats({
  parentSessionId,
  listOpen,
}: {
  parentSessionId: string | undefined
  listOpen: boolean
}) {
  const [trackedParent, setTrackedParent] = useState(parentSessionId)
  const [state, setState] = useState<SideChatWindowState>(() =>
    parentSessionId
      ? { ...emptyState(parentSessionId), loadingInitial: true }
      : emptyState(undefined),
  )

  if (trackedParent !== parentSessionId) {
    setTrackedParent(parentSessionId)
    setState(
      parentSessionId
        ? { ...emptyState(parentSessionId), loadingInitial: true }
        : emptyState(undefined),
    )
  }

  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const parentRef = useRef(parentSessionId)
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)
  const queuedReadRef = useRef<
    | {
        targetParentId: string
        mode: 'initial' | 'older' | 'newer' | 'refresh_counts'
        cursor?: SideChatCursor | undefined
      }
    | undefined
  >(undefined)
  const headDeltaRowsRef = useRef(0)
  const previousOpenRef = useRef(listOpen)
  const runReadRef = useRef<
    | ((
        targetParentId: string,
        mode: 'initial' | 'older' | 'newer' | 'refresh_counts',
        cursor?: SideChatCursor,
      ) => Promise<void>)
    | undefined
  >(undefined)

  const runRead = useCallback(
    async (
      targetParentId: string,
      mode: 'initial' | 'older' | 'newer' | 'refresh_counts',
      cursor?: SideChatCursor,
    ): Promise<void> => {
      if (inFlightRef.current) {
        queuedReadRef.current = { targetParentId, mode, cursor }
        return
      }
      inFlightRef.current = true
      let nextParentId = targetParentId
      let nextMode = mode
      let nextCursor = cursor

      try {
        // Coalesce pending refreshes iteratively so only one underlying IPC request chain is in flight.
        while (true) {
          const generation = generationRef.current

          try {
            // oxlint-disable-next-line no-await-in-loop -- Bounded single-flight reader with coalesced refresh loop.
            const page = await readSideChatsWithTimeout({
              parentSessionId: nextParentId,
              limit: SIDE_CHAT_LIST_PAGE_ITEMS,
              ...(nextCursor ? { cursor: nextCursor } : {}),
              direction: nextMode === 'newer' ? 'newer' : 'older',
            })

            let refreshCollected = page.items
            let refreshLastPage = page
            if (
              nextMode === 'refresh_counts' &&
              !stateRef.current.hasMoreNewer &&
              stateRef.current.items.length > SIDE_CHAT_LIST_PAGE_ITEMS
            ) {
              const initialIds = new Set(stateRef.current.items.map((item) => item.id))
              let overlaps =
                !refreshLastPage.hasMoreOlder ||
                refreshCollected.some((item) => initialIds.has(item.id))
              for (
                let bridge = 0;
                bridge < 2 &&
                !overlaps &&
                refreshLastPage.hasMoreOlder &&
                refreshLastPage.nextCursor;
                bridge += 1
              ) {
                if (parentRef.current !== nextParentId || generation !== generationRef.current)
                  break
                // oxlint-disable-next-line no-await-in-loop -- At most two bounded bridge pages to close a refresh gap.
                const nextBridge = await readSideChatsWithTimeout({
                  parentSessionId: nextParentId,
                  limit: SIDE_CHAT_LIST_PAGE_ITEMS,
                  cursor: refreshLastPage.nextCursor,
                  direction: 'older',
                })
                refreshCollected = mergeOrderedUnique(refreshCollected, nextBridge.items)
                refreshLastPage = nextBridge
                overlaps =
                  !refreshLastPage.hasMoreOlder ||
                  refreshCollected.some((item) => initialIds.has(item.id))
              }
            }

            if (parentRef.current === nextParentId && generation === generationRef.current) {
              setState((current) => {
                if (current.parentSessionId !== nextParentId) return current

                if (nextMode === 'initial' || nextMode === 'refresh_counts') {
                  if (nextMode === 'refresh_counts' && current.hasMoreNewer) {
                    return {
                      ...current,
                      activeCount: page.activeCount,
                      attentionCount: page.attentionCount,
                      unreadCount: page.unreadCount,
                    }
                  }
                  const currentIds = new Set(current.items.map((item) => item.id))
                  const overlapsCurrent =
                    !refreshLastPage.hasMoreOlder ||
                    refreshCollected.some((item) => currentIds.has(item.id))
                  const preservedTail =
                    nextMode === 'refresh_counts' &&
                    current.items.length > SIDE_CHAT_LIST_PAGE_ITEMS &&
                    overlapsCurrent
                  const merged = preservedTail
                    ? mergeOrderedUnique(current.items, refreshCollected)
                    : [...refreshCollected].toSorted(compareSideChatOrder)
                  const trimmed = trimResidentWindow(merged, 'tail')
                  const didTrimTail = trimmed.trimmedCount > 0
                  return {
                    parentSessionId: nextParentId,
                    items: trimmed.items,
                    bytes: trimmed.bytes,
                    nextCursor: didTrimTail
                      ? cursorFromSummary(trimmed.items.at(-1))
                      : preservedTail
                        ? current.nextCursor
                        : refreshLastPage.nextCursor,
                    prevCursor: current.hasMoreNewer ? cursorFromSummary(trimmed.items[0]) : null,
                    hasMoreOlder:
                      didTrimTail ||
                      (preservedTail ? current.hasMoreOlder : refreshLastPage.hasMoreOlder),
                    hasMoreNewer:
                      nextMode === 'refresh_counts' ? current.hasMoreNewer : page.hasMoreNewer,
                    activeCount: refreshLastPage.activeCount,
                    attentionCount: refreshLastPage.attentionCount,
                    unreadCount: refreshLastPage.unreadCount,
                    initialized: true,
                    loadingInitial: false,
                    loadingMoreOlder: false,
                    loadingMoreNewer: false,
                  }
                }

                if (nextMode === 'older') {
                  const previousIds = new Set(current.items.map((item) => item.id))
                  const merged = mergeOrderedUnique(current.items, page.items)
                  const trimmed = trimResidentWindow(merged, 'head')
                  if (trimmed.trimmedCount > 0) {
                    headDeltaRowsRef.current -= trimmed.trimmedCount
                  }
                  const evictedHead = trimmed.trimmedCount > 0 || current.hasMoreNewer
                  const noNewItems = page.items.every((item) => previousIds.has(item.id))
                  return {
                    ...current,
                    items: trimmed.items,
                    bytes: trimmed.bytes,
                    nextCursor: page.nextCursor ?? cursorFromSummary(trimmed.items.at(-1)),
                    prevCursor: evictedHead ? cursorFromSummary(trimmed.items[0]) : null,
                    hasMoreOlder: noNewItems ? false : page.hasMoreOlder,
                    hasMoreNewer: evictedHead,
                    activeCount: page.activeCount,
                    attentionCount: page.attentionCount,
                    unreadCount: page.unreadCount,
                    loadingMoreOlder: false,
                    olderError: undefined,
                  }
                }

                const previousIds = new Set(current.items.map((item) => item.id))
                const insertedCount = page.items.filter((item) => !previousIds.has(item.id)).length
                const merged = mergeOrderedUnique(current.items, page.items)
                const trimmed = trimResidentWindow(merged, 'tail')
                if (insertedCount > 0) {
                  headDeltaRowsRef.current += insertedCount
                }
                const evictedTail = trimmed.trimmedCount > 0 || current.hasMoreOlder
                const reachedTop = !page.hasMoreNewer || insertedCount === 0
                return {
                  ...current,
                  items: trimmed.items,
                  bytes: trimmed.bytes,
                  nextCursor: evictedTail ? cursorFromSummary(trimmed.items.at(-1)) : null,
                  prevCursor: reachedTop
                    ? null
                    : (page.prevCursor ?? cursorFromSummary(trimmed.items[0])),
                  hasMoreOlder: evictedTail,
                  hasMoreNewer: !reachedTop,
                  activeCount: page.activeCount,
                  attentionCount: page.attentionCount,
                  unreadCount: page.unreadCount,
                  loadingMoreNewer: false,
                  newerError: undefined,
                }
              })
            }
          } catch (error) {
            if (parentRef.current === nextParentId && generation === generationRef.current) {
              const message =
                error instanceof Error
                  ? error.message
                  : 'Side chats could not be loaded. Try again.'
              setState((current) => {
                if (current.parentSessionId !== nextParentId) return current
                if (nextMode === 'initial') {
                  return { ...current, loadingInitial: false, initialError: message }
                }
                if (nextMode === 'older') {
                  return { ...current, loadingMoreOlder: false, olderError: message }
                }
                if (nextMode === 'newer') {
                  return { ...current, loadingMoreNewer: false, newerError: message }
                }
                return current
              })
            }
          }
          const queued = queuedReadRef.current
          if (queued && queued.targetParentId === parentRef.current) {
            queuedReadRef.current = undefined
            nextParentId = queued.targetParentId
            nextMode =
              queued.mode === 'refresh_counts' && !stateRef.current.initialized
                ? 'initial'
                : queued.mode
            nextCursor = queued.cursor
            continue
          }
          break
        }
      } finally {
        inFlightRef.current = false
      }
    },
    [],
  )

  useLayoutEffect(() => {
    runReadRef.current = runRead
  }, [runRead])

  useEffect(() => {
    parentRef.current = parentSessionId
    generationRef.current += 1
    queuedReadRef.current = undefined
    headDeltaRowsRef.current = 0
    if (!parentSessionId) return
    void runRead(parentSessionId, 'initial')
  }, [parentSessionId, runRead])

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = listOpen
    if (!listOpen || wasOpen || !parentSessionId) return
    const current = stateRef.current
    if (current.parentSessionId !== parentSessionId) return
    if (!current.initialized || current.initialError) {
      void runRead(parentSessionId, 'initial')
    } else {
      void runRead(parentSessionId, 'refresh_counts')
    }
  }, [listOpen, parentSessionId, runRead])

  const loadOlder = useCallback((): void => {
    const current = stateRef.current
    if (
      !current.parentSessionId ||
      !current.hasMoreOlder ||
      !current.nextCursor ||
      current.loadingInitial ||
      current.loadingMoreOlder ||
      current.loadingMoreNewer
    ) {
      return
    }
    setState((prev) =>
      prev.parentSessionId === current.parentSessionId
        ? { ...prev, loadingMoreOlder: true, olderError: undefined }
        : prev,
    )
    void runRead(current.parentSessionId, 'older', current.nextCursor)
  }, [runRead])

  const loadNewer = useCallback((): void => {
    const current = stateRef.current
    if (
      !current.parentSessionId ||
      !current.hasMoreNewer ||
      !current.prevCursor ||
      current.loadingInitial ||
      current.loadingMoreOlder ||
      current.loadingMoreNewer
    ) {
      return
    }
    setState((prev) =>
      prev.parentSessionId === current.parentSessionId
        ? { ...prev, loadingMoreNewer: true, newerError: undefined }
        : prev,
    )
    void runRead(current.parentSessionId, 'newer', current.prevCursor)
  }, [runRead])

  const retryInitial = useCallback((): void => {
    const target = parentRef.current
    if (!target) return
    generationRef.current += 1
    queuedReadRef.current = undefined
    setState((prev) =>
      prev.parentSessionId === target
        ? {
            ...prev,
            loadingInitial: true,
            initialError: undefined,
            olderError: undefined,
            newerError: undefined,
          }
        : prev,
    )
    void runRead(target, 'initial')
  }, [runRead])

  const refresh = useCallback((): void => {
    if (!parentRef.current) return
    const current = stateRef.current
    void runRead(
      parentRef.current,
      current.initialized && !current.initialError ? 'refresh_counts' : 'initial',
    )
  }, [runRead])

  const applyCreatedSideChat = useCallback((summary: SideChatSummary): void => {
    setState((current) => {
      if (current.parentSessionId !== summary.parentSessionId) return current
      const existing = current.items.find((item) => item.id === summary.id)
      const activeDelta =
        (summary.isRunning || summary.needsAttention ? 1 : 0) -
        (existing && (existing.isRunning || existing.needsAttention) ? 1 : 0)
      const attentionDelta = (summary.needsAttention ? 1 : 0) - (existing?.needsAttention ? 1 : 0)
      const unreadDelta = (summary.hasUnread ? 1 : 0) - (existing?.hasUnread ? 1 : 0)

      if (current.hasMoreNewer && !existing) {
        return {
          ...current,
          activeCount: Math.max(0, current.activeCount + activeDelta),
          attentionCount: Math.max(0, current.attentionCount + attentionDelta),
          unreadCount: Math.max(0, current.unreadCount + unreadDelta),
        }
      }

      const merged = mergeOrderedUnique(current.items, [summary])
      const trimmed = trimResidentWindow(merged, 'tail')
      const didTrimTail = trimmed.trimmedCount > 0 || current.hasMoreOlder
      return {
        ...current,
        items: trimmed.items,
        bytes: trimmed.bytes,
        nextCursor: didTrimTail ? cursorFromSummary(trimmed.items.at(-1)) : current.nextCursor,
        hasMoreOlder: didTrimTail,
        activeCount: Math.max(0, current.activeCount + activeDelta),
        attentionCount: Math.max(0, current.attentionCount + attentionDelta),
        unreadCount: Math.max(0, current.unreadCount + unreadDelta),
        initialized: true,
      }
    })
  }, [])

  const removeSideChat = useCallback((sideChatId: string): void => {
    setState((current) => {
      const removed = current.items.find((item) => item.id === sideChatId)
      if (!removed) return current
      const nextItems = current.items.filter((item) => item.id !== sideChatId)
      return {
        ...current,
        items: nextItems,
        bytes: totalSummaryBytes(nextItems),
        nextCursor: current.hasMoreOlder ? cursorFromSummary(nextItems.at(-1)) : null,
        prevCursor: current.hasMoreNewer ? cursorFromSummary(nextItems[0]) : null,
        activeCount: Math.max(
          0,
          current.activeCount - (removed.isRunning || removed.needsAttention ? 1 : 0),
        ),
        attentionCount: Math.max(0, current.attentionCount - (removed.needsAttention ? 1 : 0)),
        unreadCount: Math.max(0, current.unreadCount - (removed.hasUnread ? 1 : 0)),
      }
    })
    const currentParentId = parentRef.current
    if (
      currentParentId &&
      stateRef.current.parentSessionId === currentParentId &&
      stateRef.current.hasMoreOlder
    ) {
      void runReadRef.current?.(currentParentId, 'refresh_counts')
    }
  }, [])

  const updateSideChatFromSession = useCallback(
    (
      session:
        | CollaborationSession
        | (ConversationPatch['session'] & { parentSessionId?: string | null }),
      previewText?: string,
    ): void => {
      const explicitParentId = 'parentSessionId' in session ? session.parentSessionId : undefined
      if (explicitParentId === null) return
      setState((current) => {
        if (explicitParentId && current.parentSessionId !== explicitParentId) return current
        const nextRunning = isRunningStatus(session)
        const nextAttention = isAttentionSession(session)
        const index = current.items.findIndex((item) => item.id === session.id)
        if (index === -1) return current

        const existing = current.items[index]!
        const nextHasUnread = 'hasUnread' in session ? session.hasUnread : existing.hasUnread
        const nextPreview = previewText ?? existing.previewText
        const updated: SideChatSummary = {
          ...existing,
          title: session.title,
          status: session.status,
          isRunning: nextRunning,
          needsAttention: nextAttention,
          hasUnread: nextHasUnread,
          previewText: nextPreview,
          updatedAt: session.updatedAt,
        }
        if (
          existing.title === updated.title &&
          existing.status === updated.status &&
          existing.isRunning === updated.isRunning &&
          existing.needsAttention === updated.needsAttention &&
          existing.hasUnread === updated.hasUnread &&
          existing.previewText === updated.previewText &&
          existing.updatedAt === updated.updatedAt
        ) {
          return current
        }

        const nextItems = current.items.map((item) => (item.id === session.id ? updated : item))
        const trimmed = trimResidentWindow(nextItems, 'tail')
        const activeDelta =
          (nextRunning || nextAttention ? 1 : 0) -
          (existing.isRunning || existing.needsAttention ? 1 : 0)
        const attentionDelta = (nextAttention ? 1 : 0) - (existing.needsAttention ? 1 : 0)
        const unreadDelta = (nextHasUnread ? 1 : 0) - (existing.hasUnread ? 1 : 0)

        return {
          ...current,
          items: trimmed.items,
          bytes: trimmed.bytes,
          nextCursor:
            trimmed.trimmedCount > 0 ? cursorFromSummary(trimmed.items.at(-1)) : current.nextCursor,
          hasMoreOlder: current.hasMoreOlder || trimmed.trimmedCount > 0,
          activeCount: Math.max(0, current.activeCount + activeDelta),
          attentionCount: Math.max(0, current.attentionCount + attentionDelta),
          unreadCount: Math.max(0, current.unreadCount + unreadDelta),
        }
      })
    },
    [],
  )

  useEffect(() => {
    let presenceTimer: number | undefined
    const scheduleRefresh = (): void => {
      const targetParentId = parentRef.current
      if (!targetParentId || presenceTimer !== undefined) return
      presenceTimer = window.setTimeout(() => {
        presenceTimer = undefined
        const currentParentId = parentRef.current
        if (
          currentParentId &&
          stateRef.current.parentSessionId === currentParentId &&
          stateRef.current.initialized &&
          !stateRef.current.initialError
        ) {
          void runReadRef.current?.(currentParentId, 'refresh_counts')
        }
      }, 120)
    }
    const removeConversation = window.pact?.onConversationChanged?.((patch) => {
      const session = patch.session
      if (session.id === parentRef.current) return
      if (stateRef.current.items.some((item) => item.id === session.id)) {
        const latestText = patch.messages
          .toReversed()
          .map((change) =>
            change.mode === 'replace' && !change.message.historicalBackgroundReport
              ? change.text?.trim()
              : undefined,
          )
          .find((text): text is string => Boolean(text))
        const collapsed = latestText?.replace(/\s+/gu, ' ').trim()
        const normalizedPreview = collapsed ? trimSurrogateSafePreview(collapsed, 240) : undefined
        updateSideChatFromSession(session, normalizedPreview)
      }
    })
    const removePresence = window.pact?.onNativePresenceChanged?.(() => {
      scheduleRefresh()
    })
    return () => {
      if (presenceTimer !== undefined) window.clearTimeout(presenceTimer)
      removeConversation?.()
      removePresence?.()
    }
  }, [updateSideChatFromSession])

  const consumeHeadDelta = useCallback((): number => {
    const delta = headDeltaRowsRef.current
    headDeltaRowsRef.current = 0
    return delta
  }, [])

  return {
    items: state.items,
    residentBytes: state.bytes,
    hasMoreOlder: state.hasMoreOlder,
    hasMoreNewer: state.hasMoreNewer,
    activeCount: state.activeCount,
    attentionCount: state.attentionCount,
    unreadCount: state.unreadCount,
    initialized: state.initialized,
    loadingInitial: state.loadingInitial,
    loadingMoreOlder: state.loadingMoreOlder,
    loadingMoreNewer: state.loadingMoreNewer,
    initialError: state.initialError,
    olderError: state.olderError,
    newerError: state.newerError,
    loadOlder,
    loadNewer,
    retryInitial,
    refresh,
    applyCreatedSideChat,
    removeSideChat,
    updateSideChatFromSession,
    consumeHeadDelta,
  }
}
