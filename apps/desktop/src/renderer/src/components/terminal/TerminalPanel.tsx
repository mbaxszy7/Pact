import { ChevronDown, Maximize2, Minimize2, Plus, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { MAX_TERMINALS_PER_PROJECT, type TerminalSummary } from '@pact/contracts'

import {
  attachTerminalViewToSlot,
  detachTerminalView,
  fitAndResizeTerminalView,
  focusTerminalView,
} from './terminal-view-cache'
import {
  clampTerminalHeight,
  DEFAULT_TERMINAL_HEIGHT,
  MIN_TERMINAL_HEIGHT,
  TERMINAL_SEPARATOR_GAP,
  type PendingCloseConfirmation,
  type ProjectTerminalUiState,
} from './useWorkspaceTerminals'

interface TerminalPanelProps {
  projectId: string
  active: boolean
  platform?: string | undefined
  workspaceContainerRef: React.RefObject<HTMLDivElement | null>
  terminals: TerminalSummary[]
  uiState: ProjectTerminalUiState
  busy: boolean
  error?: string | undefined
  inputError?: string | undefined
  pendingClose?: PendingCloseConfirmation | undefined
  onSelectTab: (terminalId: string) => void
  onCreateTab: () => void
  onRequestCloseTab: (terminalId: string) => void
  onConfirmCloseTab: () => void
  onCancelCloseTab: () => void
  onToggleMaximize: () => void
  onCollapse: () => void
  onHeightChange: (height: number) => void
  onInputError: (terminalId: string, message: string | undefined) => void
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function statusAriaLabel(terminal: TerminalSummary): string {
  if (terminal.state === 'starting') return 'starting'
  if (terminal.state === 'closing') return 'closing'
  if (terminal.state === 'unconfirmed') return 'cleanup unconfirmed'
  if (terminal.state === 'error') return 'error'
  if (terminal.state === 'exited') {
    return terminal.exitCode !== null && terminal.exitCode !== undefined
      ? `exited ${terminal.exitCode}`
      : 'exited'
  }
  return terminal.hasActiveChild ? `running ${terminal.foregroundCommand ?? 'command'}` : 'ready'
}

function statusDotClass(terminal: TerminalSummary): string {
  if (terminal.state === 'error' || terminal.state === 'unconfirmed') return 'bg-status-danger'
  if (terminal.state === 'closing') return 'bg-status-warning'
  if (terminal.state === 'exited') {
    return terminal.exitCode && terminal.exitCode !== 0 ? 'bg-status-warning' : 'bg-text-tertiary'
  }
  if (terminal.state === 'starting') return 'bg-status-info'
  return terminal.hasActiveChild ? 'bg-focus' : 'bg-status-ready'
}

export function TerminalPanel({
  projectId,
  active,
  platform,
  workspaceContainerRef,
  terminals,
  uiState,
  busy,
  error,
  inputError,
  pendingClose,
  onSelectTab,
  onCreateTab,
  onRequestCloseTab,
  onConfirmCloseTab,
  onCancelCloseTab,
  onToggleMaximize,
  onCollapse,
  onHeightChange,
  onInputError,
}: TerminalPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  const sheetFrameRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const cancelCloseBtnRef = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  const [containerHeight, setContainerHeight] = useState(() =>
    Math.max(400, window.innerHeight - 60),
  )

  const visible = active && uiState.open
  const [keepMountedForCollapse, setKeepMountedForCollapse] = useState(false)
  const [prevVisible, setPrevVisible] = useState(visible)
  if (visible !== prevVisible) {
    setPrevVisible(visible)
    setKeepMountedForCollapse(!visible)
  }
  const isShown = visible || keepMountedForCollapse

  const activeTerminal =
    terminals.find((item) => item.id === uiState.activeTerminalId) ?? terminals[0]
  const activeTerminalId = activeTerminal?.id

  const visibleRef = useRef(visible)
  const activeTerminalIdRef = useRef(activeTerminalId)
  const activeSummaryRef = useRef(activeTerminal)
  const onInputErrorRef = useRef(onInputError)
  const prevSnapshotRef = useRef<{
    visible: boolean
    maximized: boolean
    rect: DOMRect | null
    sheetRect: DOMRect | null
  }>({
    visible: false,
    maximized: false,
    rect: null,
    sheetRect: null,
  })
  const resizeRafRef = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    visibleRef.current = visible
    activeTerminalIdRef.current = activeTerminalId
    activeSummaryRef.current = activeTerminal
    onInputErrorRef.current = onInputError
  }, [visible, activeTerminalId, activeTerminal, onInputError])

  const clampedHeight = clampTerminalHeight(
    uiState.height || DEFAULT_TERMINAL_HEIGHT,
    containerHeight,
  )

  // Attach cached xterm view DOM cleanly into slot and subscribe ONLY while visible + active.
  useLayoutEffect(() => {
    const summary = activeSummaryRef.current
    if (!visible || !activeTerminalId || !summary) return undefined
    attachTerminalViewToSlot(summary, slotRef.current, platform, {
      onInputReady: () => {
        if (visibleRef.current && activeTerminalIdRef.current === activeTerminalId) {
          fitAndResizeTerminalView(activeTerminalId)
          focusTerminalView(activeTerminalId)
        }
      },
      onInputError: (message) => {
        onInputErrorRef.current(activeTerminalId, message)
      },
    })
    return () => {
      detachTerminalView(activeTerminalId)
    }
  }, [visible, activeTerminalId, platform])

  // Smooth height + opacity Open/Collapse and FLIP maximize transitions with zero post-fade flash.
  useLayoutEffect(() => {
    const el = panelRef.current
    const sheetEl = sheetFrameRef.current
    const prev = prevSnapshotRef.current
    const reduced = prefersReducedMotion()

    if (!el) {
      prevSnapshotRef.current = {
        visible,
        maximized: uiState.maximized,
        rect: null,
        sheetRect: null,
      }
      return undefined
    }

    const closedNow = prev.visible && !visible
    if (closedNow) {
      const startHeight = Math.max(
        0,
        Math.round(
          prev.rect?.height ??
            (prev.maximized ? containerHeight : clampedHeight + TERMINAL_SEPARATOR_GAP),
        ),
      )
      const innerStartHeight = Math.max(
        0,
        Math.round(
          prev.sheetRect?.height ??
            (prev.maximized ? startHeight : Math.max(0, startHeight - TERMINAL_SEPARATOR_GAP)),
        ),
      )
      el.getAnimations().forEach((a) => a.cancel())
      sheetEl?.getAnimations().forEach((a) => a.cancel())
      el.setAttribute('data-animating', 'true')
      if (sheetEl && innerStartHeight > 0) {
        sheetEl.animate(
          [
            { height: `${innerStartHeight}px`, flex: '0 0 auto' },
            { height: `${innerStartHeight}px`, flex: '0 0 auto' },
          ],
          { duration: reduced ? 100 : 220, fill: 'forwards' },
        )
      }
      const exitAnim = el.animate(
        reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { height: `${startHeight}px`, opacity: 1 },
              { height: '0px', opacity: 0 },
            ],
        {
          duration: reduced ? 100 : 220,
          easing: reduced ? 'ease-in' : 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        },
      )
      const finishCollapse = (): void => {
        if (!visibleRef.current) {
          setKeepMountedForCollapse(false)
        }
      }
      exitAnim.addEventListener('finish', finishCollapse, { once: true })
      exitAnim.addEventListener('cancel', finishCollapse, { once: true })
      prevSnapshotRef.current = {
        visible: false,
        maximized: uiState.maximized,
        rect: null,
        sheetRect: null,
      }
      return () => {
        exitAnim.removeEventListener('finish', finishCollapse)
        exitAnim.removeEventListener('cancel', finishCollapse)
      }
    }

    if (!visible) {
      if (!keepMountedForCollapse) {
        el.getAnimations().forEach((a) => a.cancel())
        sheetEl?.getAnimations().forEach((a) => a.cancel())
        el.setAttribute('data-animating', 'false')
      }
      prevSnapshotRef.current = {
        visible: false,
        maximized: uiState.maximized,
        rect: null,
        sheetRect: null,
      }
      return undefined
    }

    const openedNow = !prev.visible && visible
    const flippedLayout = prev.visible && prev.maximized !== uiState.maximized && prev.rect

    let anim: Animation | undefined
    if (openedNow) {
      const fromHeight = el.hidden ? 0 : Math.round(el.getBoundingClientRect().height)
      const fromOpacity = el.hidden ? 0 : Number.parseFloat(getComputedStyle(el).opacity || '0')
      const resolvedContainerHeight = workspaceContainerRef.current?.clientHeight || containerHeight
      const targetHeight = uiState.maximized
        ? resolvedContainerHeight
        : clampedHeight + TERMINAL_SEPARATOR_GAP
      const targetSheetHeight = uiState.maximized ? resolvedContainerHeight : clampedHeight

      el.getAnimations().forEach((a) => a.cancel())
      sheetEl?.getAnimations().forEach((a) => a.cancel())
      el.setAttribute('data-animating', 'true')
      if (sheetEl && targetSheetHeight > 0) {
        sheetEl.animate(
          [
            { height: `${targetSheetHeight}px`, flex: '0 0 auto' },
            { height: `${targetSheetHeight}px`, flex: '0 0 auto' },
          ],
          { duration: reduced ? 100 : 220 },
        )
      }
      // Focus immediately on open (<= 100 ms once ready), without waiting for the 220 ms animation.
      if (activeTerminalId) {
        fitAndResizeTerminalView(activeTerminalId)
        focusTerminalView(activeTerminalId)
      }
      anim = el.animate(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { height: `${fromHeight}px`, opacity: fromHeight > 0 ? fromOpacity : 0 },
              { height: `${targetHeight}px`, opacity: 1 },
            ],
        {
          duration: reduced ? 100 : 220,
          easing: reduced ? 'ease-out' : 'cubic-bezier(0.22, 1, 0.36, 1)',
        },
      )
    } else if (flippedLayout && prev.rect) {
      const targetEl = sheetEl ?? el
      const prevFlipRect = prev.sheetRect ?? prev.rect
      const afterRect = targetEl.getBoundingClientRect()
      if (afterRect.height > 0 && prevFlipRect.height > 0) {
        const dy = prevFlipRect.top - afterRect.top
        const sy = Math.max(0.2, Math.min(4, prevFlipRect.height / afterRect.height))
        el.getAnimations().forEach((a) => a.cancel())
        sheetEl?.getAnimations().forEach((a) => a.cancel())
        anim = targetEl.animate(
          reduced
            ? [{ opacity: 0.72 }, { opacity: 1 }]
            : [
                {
                  transformOrigin: 'top center',
                  transform: `translate3d(0, ${dy}px, 0) scaleY(${sy})`,
                },
                { transformOrigin: 'top center', transform: 'translate3d(0, 0, 0) scaleY(1)' },
              ],
          {
            duration: reduced ? 100 : 240,
            easing: reduced ? 'ease-out' : 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        )
      }
    }

    let settled = false
    const commitFit = (): void => {
      if (settled) return
      settled = true
      if (panelRef.current) {
        panelRef.current.setAttribute('data-animating', 'false')
      }
      sheetFrameRef.current?.getAnimations().forEach((a) => a.cancel())
      prevSnapshotRef.current = {
        visible,
        maximized: uiState.maximized,
        rect: panelRef.current?.getBoundingClientRect() ?? null,
        sheetRect: sheetFrameRef.current?.getBoundingClientRect() ?? null,
      }
      if (activeTerminalId && visibleRef.current) {
        fitAndResizeTerminalView(activeTerminalId)
      }
    }

    if (anim) {
      anim.addEventListener('finish', commitFit, { once: true })
      anim.addEventListener('cancel', commitFit, { once: true })
    } else {
      commitFit()
    }
    return () => {
      if (anim) {
        anim.removeEventListener('finish', commitFit)
        anim.removeEventListener('cancel', commitFit)
      }
    }
  }, [
    visible,
    keepMountedForCollapse,
    uiState.maximized,
    activeTerminalId,
    clampedHeight,
    containerHeight,
    workspaceContainerRef,
  ])

  // Track slot resize after separator drag or window resizing via rAF coalescing.
  useEffect(() => {
    const slot = slotRef.current
    if (!visible || !slot || !activeTerminalId) return undefined
    const scheduleFit = (): void => {
      if (resizeRafRef.current !== undefined) return
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = undefined
        if (panelRef.current?.getAttribute('data-animating') === 'true') return
        fitAndResizeTerminalView(activeTerminalId)
        if (panelRef.current) {
          prevSnapshotRef.current.rect = panelRef.current.getBoundingClientRect()
          prevSnapshotRef.current.sheetRect = sheetFrameRef.current?.getBoundingClientRect() ?? null
        }
      })
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(slot)
    return () => {
      observer.disconnect()
      if (resizeRafRef.current !== undefined) {
        window.cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = undefined
      }
    }
  }, [visible, activeTerminalId])

  // Track container dimensions cleanly and clamp height smoothly if window shrinks down to 720x520 minimum.
  useEffect(() => {
    const container = workspaceContainerRef.current
    if (!container) return undefined
    const syncContainer = (): void => {
      const h = container.clientHeight
      if (h > 0) {
        setContainerHeight(h)
        if (!uiState.maximized) {
          const next = clampTerminalHeight(uiState.height || DEFAULT_TERMINAL_HEIGHT, h)
          if (next !== uiState.height && uiState.height > 0) {
            onHeightChange(next)
          }
        }
      }
    }
    syncContainer()
    const observer = new ResizeObserver(syncContainer)
    observer.observe(container)
    return () => observer.disconnect()
  }, [workspaceContainerRef, uiState.height, uiState.maximized, onHeightChange])

  // Focus Cancel first when inline close confirmation opens, and dismiss on Escape cleanly.
  useEffect(() => {
    if (!pendingClose) return undefined
    window.requestAnimationFrame(() => cancelCloseBtnRef.current?.focus())
    const handleEsc = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelCloseTab()
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [pendingClose, onCancelCloseTab])

  const startPointerDrag = useCallback(
    (startEvent: React.PointerEvent<HTMLDivElement>) => {
      if (uiState.maximized) return
      startEvent.preventDefault()
      const container = workspaceContainerRef.current
      if (!container) return
      const startY = startEvent.clientY
      const startHeight = sheetFrameRef.current?.getBoundingClientRect().height ?? clampedHeight
      let latestHeight = startHeight
      let rafId: number | undefined
      setDragging(true)

      const flush = (): void => {
        rafId = undefined
        onHeightChange(clampTerminalHeight(latestHeight, container.clientHeight))
      }

      const onMove = (moveEvent: PointerEvent): void => {
        latestHeight = startHeight + (startY - moveEvent.clientY)
        rafId ??= window.requestAnimationFrame(flush)
      }
      const onUp = (): void => {
        if (rafId !== undefined) window.cancelAnimationFrame(rafId)
        flush()
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [clampedHeight, onHeightChange, uiState.maximized, workspaceContainerRef],
  )

  const handleSeparatorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (uiState.maximized) return
      const container = workspaceContainerRef.current
      if (!container) return
      const step = event.shiftKey ? 48 : 24
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        onHeightChange(clampTerminalHeight(clampedHeight + step, container.clientHeight))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        onHeightChange(clampTerminalHeight(clampedHeight - step, container.clientHeight))
      } else if (event.key === 'Home') {
        event.preventDefault()
        onHeightChange(clampTerminalHeight(MIN_TERMINAL_HEIGHT, container.clientHeight))
      } else if (event.key === 'End') {
        event.preventDefault()
        onHeightChange(clampTerminalHeight(container.clientHeight, container.clientHeight))
      }
    },
    [clampedHeight, onHeightChange, uiState.maximized, workspaceContainerRef],
  )

  const canAddMore = terminals.length < MAX_TERMINALS_PER_PROJECT
  const terminalStateError =
    activeTerminal?.state === 'error' ? activeTerminal.errorMessage : undefined
  const activeBannerError = inputError ?? terminalStateError ?? error

  return (
    <section
      ref={panelRef}
      className="pact-terminal-dock"
      data-project-id={projectId}
      data-maximized={uiState.maximized ? 'true' : 'false'}
      data-open={visible ? 'true' : 'false'}
      data-animating="false"
      hidden={!isShown}
      inert={!visible || undefined}
      aria-label="Project Terminal"
      style={
        uiState.maximized ? undefined : { height: `${clampedHeight + TERMINAL_SEPARATOR_GAP}px` }
      }
    >
      {!uiState.maximized ? (
        <div
          /* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- WAI-ARIA window splitter requires a focusable separator with aria-valuenow/min/max. */
          role="separator"
          tabIndex={visible ? 0 : -1}
          aria-orientation="horizontal"
          aria-label="Resize terminal height"
          aria-valuemin={MIN_TERMINAL_HEIGHT}
          aria-valuemax={Math.max(
            MIN_TERMINAL_HEIGHT,
            containerHeight - TERMINAL_SEPARATOR_GAP - 180,
          )}
          aria-valuenow={clampedHeight}
          className="pact-terminal-separator m-0 border-0"
          data-dragging={dragging ? 'true' : 'false'}
          onPointerDown={startPointerDrag}
          onKeyDown={handleSeparatorKeyDown}
        />
      ) : null}

      <div
        ref={sheetFrameRef}
        className="pact-terminal-sheet-frame"
        style={uiState.maximized ? undefined : { height: `${clampedHeight}px` }}
      >
        <div
          className="workspace-sheet pact-terminal-shell"
          data-maximized={uiState.maximized ? 'true' : 'false'}
        >
          <div className="pact-terminal-header">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <SquareTerminal
                aria-hidden="true"
                className="mr-0.5 size-3.5 shrink-0 text-tertiary"
                strokeWidth={1.75}
              />
              <div className="pact-terminal-tablist" role="tablist" aria-label="Terminal tabs">
                {terminals.map((tab, idx) => {
                  const isSelected = activeTerminal?.id === tab.id
                  return (
                    <div
                      key={tab.id}
                      role="presentation"
                      className="pact-terminal-tab-group"
                      data-active={isSelected ? 'true' : 'false'}
                    >
                      <button
                        type="button"
                        role="tab"
                        id={`terminal-tab-${tab.id}`}
                        aria-selected={isSelected}
                        aria-controls={`terminal-tabpanel-${projectId}`}
                        tabIndex={isSelected ? 0 : -1}
                        title={
                          tab.foregroundCommand
                            ? `${tab.title} — ${tab.foregroundCommand}`
                            : tab.title
                        }
                        className="pact-terminal-tab-trigger"
                        onClick={() => {
                          onSelectTab(tab.id)
                          focusTerminalView(tab.id)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowRight' && terminals.length > 1) {
                            event.preventDefault()
                            const next = terminals[(idx + 1) % terminals.length]!
                            onSelectTab(next.id)
                            document.getElementById(`terminal-tab-${next.id}`)?.focus()
                          } else if (event.key === 'ArrowLeft' && terminals.length > 1) {
                            event.preventDefault()
                            const prev = terminals[(idx - 1 + terminals.length) % terminals.length]!
                            onSelectTab(prev.id)
                            document.getElementById(`terminal-tab-${prev.id}`)?.focus()
                          }
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-pill ${statusDotClass(tab)}`}
                        />
                        <span className="truncate">{tab.title}</span>
                        {tab.state === 'exited' &&
                        tab.exitCode !== null &&
                        tab.exitCode !== undefined ? (
                          <span className="text-caption font-normal text-tertiary">
                            ({tab.exitCode})
                          </span>
                        ) : null}
                        <span className="sr-only">{statusAriaLabel(tab)}</span>
                      </button>
                      <button
                        type="button"
                        className="pact-terminal-tab-close"
                        aria-label={`Close ${tab.title}`}
                        title={`Close ${tab.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onRequestCloseTab(tab.id)
                        }}
                      >
                        <X aria-hidden="true" className="size-3" strokeWidth={2} />
                      </button>
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                className="pact-terminal-icon-btn"
                aria-label="New terminal"
                title={
                  canAddMore ? 'New terminal' : `Maximum ${MAX_TERMINALS_PER_PROJECT} tabs open`
                }
                disabled={busy || !canAddMore}
                onClick={onCreateTab}
              >
                <Plus aria-hidden="true" className="size-3.5" strokeWidth={1.9} />
              </button>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                className="pact-terminal-icon-btn"
                aria-label={uiState.maximized ? 'Restore terminal' : 'Maximize terminal'}
                aria-pressed={uiState.maximized}
                title={uiState.maximized ? 'Restore terminal' : 'Maximize terminal'}
                onClick={onToggleMaximize}
              >
                {uiState.maximized ? (
                  <Minimize2 aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <Maximize2 aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                )}
              </button>
              <button
                type="button"
                className="pact-terminal-icon-btn"
                aria-label="Hide terminal"
                title="Hide terminal (Ctrl+`)"
                onClick={onCollapse}
              >
                <ChevronDown aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {pendingClose ? (
            <div
              className="pact-terminal-confirm-strip"
              role="alertdialog"
              aria-label="Active process confirmation"
            >
              <span className="min-w-0 truncate">
                {pendingClose.foregroundCommand
                  ? `${pendingClose.title}: "${pendingClose.foregroundCommand}" is still active.`
                  : `${pendingClose.title} has an active subprocess running.`}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  ref={cancelCloseBtnRef}
                  type="button"
                  onClick={onCancelCloseTab}
                  className="h-6 cursor-pointer rounded-control border border-border bg-surface-raised px-2 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  Keep open
                </button>
                <button
                  type="button"
                  onClick={onConfirmCloseTab}
                  className="h-6 cursor-pointer rounded-control bg-danger px-2 text-caption font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  Close terminal
                </button>
              </span>
            </div>
          ) : null}

          {activeBannerError ? (
            <div className="pact-terminal-alert" role="alert">
              <span className="min-w-0 truncate text-danger">{activeBannerError}</span>
              {inputError && activeTerminalId ? (
                <button
                  type="button"
                  onClick={() => onInputError(activeTerminalId, undefined)}
                  className="h-5 shrink-0 cursor-pointer rounded-control px-1.5 text-caption font-medium text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}

          <div
            id={`terminal-tabpanel-${projectId}`}
            role="tabpanel"
            aria-labelledby={activeTerminal ? `terminal-tab-${activeTerminal.id}` : undefined}
            className="pact-terminal-viewport"
          >
            {activeTerminal ? (
              <div ref={slotRef} className="pact-terminal-slot" />
            ) : (
              <div className="flex h-full items-center justify-center text-caption text-secondary">
                {busy ? 'Starting shell…' : 'Open a terminal tab with +.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
