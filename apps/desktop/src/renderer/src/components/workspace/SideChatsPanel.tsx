import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, MessagesSquare, Plus, RefreshCw, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { SideChatSummary } from '@pact/contracts'

import type { useSideChats } from './useSideChats'

import { SideChatStage } from './SideChatStage'

export const SIDE_CHAT_ROW_HEIGHT = 84
const DEFAULT_VIEWPORT_HEIGHT = 672
const MAX_DOM_ROWS = 100

type SideChatsController = ReturnType<typeof useSideChats>

type VirtualListRow =
  | { kind: 'top-boundary'; key: string }
  | { kind: 'item'; key: string; item: SideChatSummary; itemIndex: number }
  | { kind: 'bottom-boundary'; key: string }

export const SideChatsInspectorContext = createContext(false)

export interface SideChatsPanelProps {
  parentSessionId: string
  activeSideChatId?: string | undefined
  activeSideChatTitle?: string | undefined
  sideChats: SideChatsController
  panelOpen: boolean
  embeddedInInspector?: boolean | undefined
  creatingSideChat?: boolean | undefined
  onNewSideChat?: (() => void) | undefined
  onSelectSideChat: (sideChatId: string) => void
  onBackToList: () => void
  onClose: () => void
  renderDetail: (sideChatId: string) => ReactNode
}

function formatSideChatTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (diffSeconds < 45) return 'Just now'
  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

function SideChatsListView({
  parentSessionId,
  sideChats,
  scrollTopsRef,
  revealAllowed,
  embeddedInInspector = false,
  creatingSideChat = false,
  onInitialRevealDone,
  onNewSideChat,
  onSelectSideChat,
  onClose,
}: {
  parentSessionId: string
  sideChats: SideChatsController
  scrollTopsRef: React.RefObject<Map<string, number>>
  revealAllowed: boolean
  embeddedInInspector?: boolean | undefined
  creatingSideChat?: boolean | undefined
  onInitialRevealDone: () => void
  onNewSideChat?: (() => void) | undefined
  onSelectSideChat: (sideChatId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT)
  const [staggerActive, setStaggerActive] = useState(false)
  const [revealedSessionId, setRevealedSessionId] = useState<string>('')

  if (
    revealAllowed &&
    sideChats.items.length > 0 &&
    revealedSessionId !== parentSessionId &&
    !staggerActive
  ) {
    setRevealedSessionId(parentSessionId)
    setStaggerActive(true)
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const targetTop = scrollTopsRef.current.get(parentSessionId) ?? 0
    if (targetTop > 0) {
      element.scrollTop = targetTop
    }
    setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT_HEIGHT)
  }, [parentSessionId, scrollTopsRef])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height
      if (nextHeight && nextHeight > 0) {
        setViewportHeight(nextHeight)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!staggerActive) return undefined
    const timer = window.setTimeout(() => {
      setStaggerActive(false)
      onInitialRevealDone()
    }, 260)
    return () => window.clearTimeout(timer)
  }, [onInitialRevealDone, staggerActive])

  const rows = useMemo<VirtualListRow[]>(() => {
    const list: VirtualListRow[] = []
    if (sideChats.hasMoreNewer) {
      list.push({ kind: 'top-boundary', key: 'boundary:newer' })
    }
    for (let index = 0; index < sideChats.items.length; index++) {
      const item = sideChats.items[index]!
      list.push({ kind: 'item', key: item.id, item, itemIndex: index })
    }
    if (sideChats.hasMoreOlder) {
      list.push({ kind: 'bottom-boundary', key: 'boundary:older' })
    }
    return list
  }, [sideChats.hasMoreNewer, sideChats.hasMoreOlder, sideChats.items])

  const maxMountedRows = Math.min(
    MAX_DOM_ROWS,
    Math.ceil((viewportHeight || DEFAULT_VIEWPORT_HEIGHT) / SIDE_CHAT_ROW_HEIGHT) + 12,
  )

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => SIDE_CHAT_ROW_HEIGHT,
    overscan: 6,
    useFlushSync: false,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      return indexes.length > maxMountedRows ? indexes.slice(0, maxMountedRows) : indexes
    },
  })

  const consumeHeadDelta = sideChats.consumeHeadDelta
  const scrollAnchorRef = useRef<{
    parentSessionId: string
    itemId: string
    offsetInRow: number
  }>(undefined)

  const recordScrollAnchor = useCallback(
    (scrollTop: number, currentRows: readonly VirtualListRow[]) => {
      if (scrollTop <= 0) {
        scrollAnchorRef.current = undefined
        return
      }
      const approxIndex = Math.min(
        currentRows.length - 1,
        Math.max(0, Math.floor(scrollTop / SIDE_CHAT_ROW_HEIGHT)),
      )
      const row = currentRows[approxIndex]
      if (row?.kind === 'item') {
        scrollAnchorRef.current = {
          parentSessionId,
          itemId: row.item.id,
          offsetInRow: scrollTop - approxIndex * SIDE_CHAT_ROW_HEIGHT,
        }
      }
    },
    [parentSessionId],
  )

  useLayoutEffect(() => {
    const element = scrollRef.current
    const rowDelta = consumeHeadDelta()
    if (!element) return
    const savedAnchor =
      scrollAnchorRef.current?.parentSessionId === parentSessionId
        ? scrollAnchorRef.current
        : undefined
    if (savedAnchor && element.scrollTop > 0) {
      const anchoredIndex = rows.findIndex(
        (row) => row.kind === 'item' && row.item.id === savedAnchor.itemId,
      )
      if (anchoredIndex >= 0) {
        const nextTop = Math.max(0, anchoredIndex * SIDE_CHAT_ROW_HEIGHT + savedAnchor.offsetInRow)
        if (Math.abs(nextTop - element.scrollTop) >= 1) {
          element.scrollTop = nextTop
          scrollTopsRef.current.set(parentSessionId, nextTop)
        }
        recordScrollAnchor(element.scrollTop, rows)
        return
      }
    }
    if (rowDelta !== 0 && element.scrollTop > 0) {
      const nextTop = Math.max(0, element.scrollTop + rowDelta * SIDE_CHAT_ROW_HEIGHT)
      element.scrollTop = nextTop
      scrollTopsRef.current.set(parentSessionId, nextTop)
    }
    recordScrollAnchor(element.scrollTop, rows)
  }, [consumeHeadDelta, parentSessionId, recordScrollAnchor, rows, scrollTopsRef])

  const virtualItems = virtualizer.getVirtualItems()
  const firstIndex = virtualItems[0]?.index ?? 0
  const lastIndex = virtualItems.at(-1)?.index ?? -1

  useEffect(() => {
    if (rows.length === 0) return
    if (
      sideChats.hasMoreOlder &&
      !sideChats.olderError &&
      !sideChats.loadingMoreOlder &&
      lastIndex >= rows.length - 3
    ) {
      sideChats.loadOlder()
    }
    if (
      sideChats.hasMoreNewer &&
      !sideChats.newerError &&
      !sideChats.loadingMoreNewer &&
      firstIndex <= 2
    ) {
      sideChats.loadNewer()
    }
  }, [
    firstIndex,
    lastIndex,
    rows.length,
    sideChats,
    sideChats.hasMoreNewer,
    sideChats.hasMoreOlder,
    sideChats.loadingMoreNewer,
    sideChats.loadingMoreOlder,
    sideChats.newerError,
    sideChats.olderError,
  ])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {embeddedInInspector ? (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border/70 px-2.5 py-1.5">
          {onNewSideChat ? (
            <button
              type="button"
              disabled={creatingSideChat}
              className="pact-pressable inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-caption font-medium text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
              aria-label="New side chat"
              title="New side chat"
              onClick={onNewSideChat}
            >
              <Plus aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span>New side chat</span>
            </button>
          ) : null}
          <button
            type="button"
            className="pact-pressable inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            aria-label="Close side chats"
            title="Close side chats"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ) : (
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <MessagesSquare
              aria-hidden="true"
              className="size-4 shrink-0 text-secondary"
              strokeWidth={1.75}
            />
            <h2 className="truncate text-body font-medium text-primary">Side chats</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onNewSideChat ? (
              <button
                type="button"
                disabled={creatingSideChat}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                aria-label="New side chat"
                title="New side chat"
                onClick={onNewSideChat}
              >
                <Plus aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              aria-label="Close side chats"
              title="Close side chats"
              onClick={onClose}
            >
              <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </header>
      )}

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2"
        onScroll={(event) => {
          const nextTop = event.currentTarget.scrollTop
          scrollTopsRef.current.set(parentSessionId, nextTop)
          recordScrollAnchor(nextTop, rows)
          if (staggerActive) {
            setStaggerActive(false)
            onInitialRevealDone()
          }
        }}
      >
        {sideChats.loadingInitial && sideChats.items.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center px-4 text-center text-caption text-secondary">
            Loading side chats...
          </div>
        ) : sideChats.initialError && sideChats.items.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-caption text-secondary">{sideChats.initialError}</p>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-caption font-medium text-primary transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              onClick={sideChats.retryInitial}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              Retry
            </button>
          </div>
        ) : sideChats.initialized && sideChats.items.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1.5 px-6 text-center">
            <MessagesSquare
              aria-hidden="true"
              className="mb-1 size-5 text-tertiary"
              strokeWidth={1.75}
            />
            <p className="text-body font-medium text-primary">No side chats yet</p>
            <p className="text-caption text-secondary">
              Use /btw in the composer or select text in the main chat to start one.
            </p>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) return null

              if (row.kind === 'top-boundary' || row.kind === 'bottom-boundary') {
                const isOlder = row.kind === 'bottom-boundary'
                const error = isOlder ? sideChats.olderError : sideChats.newerError
                const onRetry = isOlder ? sideChats.loadOlder : sideChats.loadNewer
                return (
                  <div
                    key={row.key}
                    data-side-chat-boundary={isOlder ? 'older' : 'newer'}
                    className="absolute left-0 top-0 flex h-[84px] w-full items-center justify-between gap-2 px-3"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {error ? (
                      <>
                        <span className="min-w-0 truncate text-caption text-secondary">
                          {error}
                        </span>
                        <button
                          type="button"
                          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          onClick={onRetry}
                        >
                          <RefreshCw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                          Retry
                        </button>
                      </>
                    ) : (
                      <span className="text-caption text-tertiary">
                        Loading {isOlder ? 'older' : 'newer'} side chats...
                      </span>
                    )}
                  </div>
                )
              }

              const { item, itemIndex } = row
              const preview = item.previewText ?? item.anchorQuotePreview ?? 'Started with /btw'
              const timestamp = formatSideChatTime(item.updatedAt || item.createdAt)
              const staggerDelayMs = staggerActive ? Math.min(itemIndex * 18, 90) : undefined
              const rowStyle =
                staggerDelayMs !== undefined ? { animationDelay: `${staggerDelayMs}ms` } : undefined

              return (
                <div
                  key={row.key}
                  data-side-chat-row={item.id}
                  className="absolute left-0 top-0 h-[84px] w-full py-0.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    className={
                      staggerDelayMs !== undefined ? 'pact-side-chat-row-enter h-full' : 'h-full'
                    }
                    style={rowStyle}
                  >
                    <button
                      type="button"
                      className="group flex h-full w-full flex-col justify-center gap-1 rounded-card border border-transparent px-3 text-left transition-colors hover:border-border/70 hover:bg-surface-muted/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                      onClick={() => onSelectSideChat(item.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-body font-medium text-primary">
                          {item.title}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {item.needsAttention ? (
                            <span className="pact-badge-pop inline-flex items-center rounded-pill border border-status-warning/40 bg-status-warning-muted px-1.5 py-0.5 text-caption font-medium leading-none text-status-warning-foreground">
                              Needs attention
                            </span>
                          ) : item.isRunning ? (
                            <span className="pact-badge-pop inline-flex items-center rounded-pill border border-status-info/40 bg-status-info-muted px-1.5 py-0.5 text-caption font-medium leading-none text-status-info-foreground">
                              Running
                            </span>
                          ) : item.hasUnread ? (
                            <output
                              className="pact-badge-pop grid size-4 shrink-0 place-items-center"
                              aria-label="New reply"
                              title="New reply"
                            >
                              <span aria-hidden="true" className="size-1.5 rounded-pill bg-focus" />
                            </output>
                          ) : null}
                          <ChevronRight
                            aria-hidden="true"
                            className="pact-side-chat-chevron size-4 shrink-0 text-tertiary group-hover:text-secondary"
                            strokeWidth={1.75}
                          />
                        </div>
                      </div>
                      <p className="truncate text-caption text-secondary">{preview}</p>
                      <div className="flex items-center gap-1.5 text-caption text-tertiary">
                        <span>{item.origin === 'btw' ? '/btw' : 'Selection'}</span>
                        {timestamp ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{timestamp}</span>
                          </>
                        ) : null}
                      </div>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Right-pane Side Chats container owning list/detail navigation, saved list scrollTop,
 * bounded virtualized list rendering, and locked detail header without settings controls.
 */
export function SideChatsPanel({
  parentSessionId,
  activeSideChatId,
  activeSideChatTitle,
  sideChats,
  panelOpen,
  embeddedInInspector,
  creatingSideChat,
  onNewSideChat,
  onSelectSideChat,
  onBackToList,
  onClose,
  renderDetail,
}: SideChatsPanelProps): React.JSX.Element {
  const inInspectorContext = useContext(SideChatsInspectorContext)
  const isEmbedded = embeddedInInspector ?? inInspectorContext
  const scrollTopsRef = useRef(new Map<string, number>())
  const [revealState, setRevealState] = useState({
    parentSessionId,
    panelOpen,
    pending: true,
  })

  if (revealState.parentSessionId !== parentSessionId || (!revealState.panelOpen && panelOpen)) {
    setRevealState({ parentSessionId, panelOpen, pending: true })
  } else if (revealState.panelOpen !== panelOpen) {
    setRevealState((current) => ({ ...current, panelOpen, pending: !panelOpen || current.pending }))
  }

  const markRevealDone = useCallback(() => {
    setRevealState((current) => (current.pending ? { ...current, pending: false } : current))
  }, [])

  const stageKey = activeSideChatId ? `detail:${activeSideChatId}` : 'list'
  const depth = activeSideChatId ? 1 : 0

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Side chats">
      <SideChatStage stageKey={stageKey} depth={depth}>
        {activeSideChatId ? (
          <div className="flex h-full min-h-0 flex-col">
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-control px-2 text-caption font-medium text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                aria-label="Back to side chats"
                onClick={onBackToList}
              >
                <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
                Side chats
              </button>
              <h2
                className="min-w-0 flex-1 truncate text-center text-caption font-medium text-primary"
                title={activeSideChatTitle ?? 'New side chat'}
              >
                {activeSideChatTitle ?? 'New side chat'}
              </h2>
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                aria-label="Close side chats"
                title="Close side chats"
                onClick={onClose}
              >
                <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">{renderDetail(activeSideChatId)}</div>
          </div>
        ) : (
          <SideChatsListView
            key={parentSessionId}
            parentSessionId={parentSessionId}
            sideChats={sideChats}
            scrollTopsRef={scrollTopsRef}
            revealAllowed={panelOpen && revealState.pending}
            embeddedInInspector={isEmbedded}
            creatingSideChat={creatingSideChat}
            onInitialRevealDone={markRevealDone}
            onNewSideChat={onNewSideChat}
            onSelectSideChat={(id) => {
              markRevealDone()
              onSelectSideChat(id)
            }}
            onClose={onClose}
          />
        )}
      </SideChatStage>
    </section>
  )
}
