import { PanelLeft } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Group,
  type Layout,
  type LayoutChangedMeta,
  Panel,
  Separator,
  usePanelRef,
} from 'react-resizable-panels'

export interface WorkspaceLayoutState {
  navigationPanel: 'open' | 'closed'
  contextPanel: 'open' | 'closed'
}

export interface WorkspaceShellProps {
  navigation: ReactNode
  workspace: ReactNode
  workspaceHeader?: ReactNode
  workspaceNotice?: ReactNode
  workspaceTitle?: string | null
  workspaceSubtitle?: string | null
  navigationAvailable?: boolean
  agentActionsEnabled?: boolean
  isSettingsView?: boolean
  contextPanel?: ReactNode
  contextPanelOpen?: boolean | undefined
  onContextPanelOpenChange?: ((open: boolean) => void) | undefined
  contextPanelExpanded?: boolean | undefined
  showContextToggle?: boolean
  initialState?: WorkspaceLayoutState
}

type WorkspaceViewport = 'wide' | 'compact' | 'narrow'

const defaultLayoutState: WorkspaceLayoutState = {
  navigationPanel: 'open',
  contextPanel: 'open',
}

function getWorkspaceViewport(): WorkspaceViewport {
  if (window.matchMedia('(min-width: 1100px)').matches) return 'wide'
  if (window.matchMedia('(min-width: 860px)').matches) return 'compact'
  return 'narrow'
}

function freezePanelContent(
  element: HTMLDivElement | null,
  currentWidth: number,
  lastWidth: React.RefObject<number>,
): void {
  if (!element || element.style.getPropertyValue('--workspace-panel-content-width')) return
  if (currentWidth > 1) lastWidth.current = currentWidth
  if (lastWidth.current > 0) {
    element.style.setProperty('--workspace-panel-content-width', `${lastWidth.current}px`)
  }
}

function useWorkspaceViewport(): WorkspaceViewport {
  const [viewport, setViewport] = useState<WorkspaceViewport>(getWorkspaceViewport)

  useEffect(() => {
    const queries = [
      window.matchMedia('(min-width: 1100px)'),
      window.matchMedia('(min-width: 860px)'),
    ]
    const updateViewport = (): void => {
      setViewport(getWorkspaceViewport())
    }

    queries.forEach((query) => query.addEventListener('change', updateViewport))
    return () => queries.forEach((query) => query.removeEventListener('change', updateViewport))
  }, [])

  return viewport
}

function ResizeSeparator({
  isVisible,
  label,
}: {
  isVisible: boolean
  label: string
}): React.JSX.Element {
  return (
    <Separator
      className="workspace-separator"
      data-open={isVisible}
      disabled={!isVisible}
      aria-label={label}
    />
  )
}

function PrimaryPane({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Workspace">
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  )
}

export function WorkspaceShell({
  navigation,
  workspace,
  workspaceHeader,
  workspaceNotice,
  workspaceTitle = 'Workspace shell fixture',
  workspaceSubtitle,
  navigationAvailable = true,
  agentActionsEnabled = true,
  isSettingsView = false,
  contextPanel: providedContextPanel,
  contextPanelOpen,
  onContextPanelOpenChange,
  contextPanelExpanded = false,
  showContextToggle = true,
  initialState = defaultLayoutState,
}: WorkspaceShellProps): React.JSX.Element {
  const initialViewport = getWorkspaceViewport()
  const hasContextPanel = Boolean(providedContextPanel)
  const [layoutState, setLayoutState] = useState<WorkspaceLayoutState>(initialState)
  const [isLayoutAnimating, setIsLayoutAnimating] = useState(false)
  const [isContextOverlayRendered, setIsContextOverlayRendered] = useState(
    () =>
      hasContextPanel &&
      (contextPanelOpen ?? initialState.contextPanel === 'open') &&
      !isSettingsView &&
      initialViewport !== 'wide',
  )
  const [navigationHeaderWidth, setNavigationHeaderWidth] = useState(0)
  const [navigationPanelElement, setNavigationPanelElement] = useState<HTMLDivElement | null>(null)
  const [contextPanelElement, setContextPanelElement] = useState<HTMLDivElement | null>(null)
  const navigationPanelRef = usePanelRef()
  const contextPanelRef = usePanelRef()
  const lastNavigationPanelWidthRef = useRef(0)
  const lastContextPanelWidthRef = useRef(0)
  const navigationToggleRef = useRef<HTMLButtonElement>(null)
  const toggleButtonRef = useRef<HTMLButtonElement>(null)
  const contextDialogRef = useRef<HTMLDialogElement>(null)
  const layoutAnimationTimerRef = useRef<number | undefined>(undefined)
  const overlayExitTimerRef = useRef<number | undefined>(undefined)
  const contextFocusScrollPositionRef = useRef({ x: 0, y: 0 })
  const restoreNavigationToggleFocus = useRef(false)
  const restoreToggleFocus = useRef(false)
  const isNavigationOpen = layoutState.navigationPanel === 'open'
  const isNavigationVisible = navigationAvailable && isNavigationOpen
  const isContextOpen = contextPanelOpen ?? layoutState.contextPanel === 'open'
  const isContextVisible = hasContextPanel && isContextOpen && !isSettingsView
  const isContextExpanded = isContextVisible && contextPanelExpanded
  const effectiveNavigationHeaderWidth =
    navigationPanelElement && !isContextExpanded ? navigationHeaderWidth : 0

  const viewport = useWorkspaceViewport()
  const canRenderContextOverlay = hasContextPanel && !isSettingsView && viewport !== 'wide'

  // Mount controlled opens before committing children; the retained state only
  // keeps an already mounted overlay alive for its existing exit transition.
  if (canRenderContextOverlay && isContextVisible && !isContextOverlayRendered) {
    setIsContextOverlayRendered(true)
  } else if (!canRenderContextOverlay && isContextOverlayRendered) {
    setIsContextOverlayRendered(false)
  }

  useLayoutEffect(() => {
    window.clearTimeout(overlayExitTimerRef.current)
    overlayExitTimerRef.current = undefined
    if (canRenderContextOverlay && isContextVisible) {
      contextFocusScrollPositionRef.current = { x: window.scrollX, y: window.scrollY }
    } else if (canRenderContextOverlay && isContextOverlayRendered) {
      overlayExitTimerRef.current = window.setTimeout(() => {
        setIsContextOverlayRendered(false)
      }, 180)
    }
    return () => window.clearTimeout(overlayExitTimerRef.current)
  }, [canRenderContextOverlay, isContextOverlayRendered, isContextVisible])

  useLayoutEffect(() => {
    let observer: ResizeObserver | undefined
    if (navigationPanelElement) {
      const syncWidth = (): void =>
        setNavigationHeaderWidth(navigationPanelElement.getBoundingClientRect().width)
      syncWidth()
      observer = new ResizeObserver(syncWidth)
      observer.observe(navigationPanelElement)
    }
    return () => observer?.disconnect()
  }, [navigationPanelElement])

  useEffect(() => {
    return () => {
      window.clearTimeout(layoutAnimationTimerRef.current)
      window.clearTimeout(overlayExitTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (isNavigationVisible) navigationPanelRef.current?.expand()
    else navigationPanelRef.current?.collapse()
  }, [isNavigationVisible, navigationPanelRef])

  useEffect(() => {
    if (viewport !== 'wide') return
    if (isContextVisible) contextPanelRef.current?.expand()
    else contextPanelRef.current?.collapse()
  }, [contextPanelRef, isContextVisible, viewport])

  useEffect(() => {
    if (isNavigationVisible || !restoreNavigationToggleFocus.current) return
    navigationToggleRef.current?.focus({ preventScroll: true })
    restoreNavigationToggleFocus.current = false
  }, [isNavigationVisible])

  useEffect(() => {
    if (isContextOpen || !restoreToggleFocus.current) return
    toggleButtonRef.current?.focus({ preventScroll: true })
    restoreToggleFocus.current = false
  }, [isContextOpen])

  useEffect(() => {
    if (!isContextVisible || !isContextOverlayRendered || viewport === 'wide') return
    const { x, y } = contextFocusScrollPositionRef.current
    contextDialogRef.current?.focus({ preventScroll: true })
    window.requestAnimationFrame(() => window.scrollTo(x, y))
  }, [isContextVisible, isContextOverlayRendered, viewport])

  const beginLayoutAnimation = (panel: 'navigation' | 'context'): void => {
    if (panel === 'navigation') {
      freezePanelContent(
        navigationPanelElement,
        navigationPanelRef.current?.getSize().inPixels ?? 0,
        lastNavigationPanelWidthRef,
      )
    } else {
      freezePanelContent(
        contextPanelElement,
        contextPanelRef.current?.getSize().inPixels ?? 0,
        lastContextPanelWidthRef,
      )
    }

    window.clearTimeout(layoutAnimationTimerRef.current)
    setIsLayoutAnimating(true)
    layoutAnimationTimerRef.current = window.setTimeout(() => {
      setIsLayoutAnimating(false)
      navigationPanelElement?.style.removeProperty('--workspace-panel-content-width')
      contextPanelElement?.style.removeProperty('--workspace-panel-content-width')
    }, 240)
  }

  const closeContext = (): void => {
    beginLayoutAnimation('context')
    restoreToggleFocus.current = true
    setLayoutState((state) => ({ ...state, contextPanel: 'closed' }))
    onContextPanelOpenChange?.(false)
  }
  const openContext = (): void => {
    beginLayoutAnimation('context')
    setLayoutState((state) => ({ ...state, contextPanel: 'open' }))
    onContextPanelOpenChange?.(true)
  }
  const toggleContext = (): void => (isContextOpen ? closeContext() : openContext())
  const closeNavigation = (): void => {
    if (!navigationAvailable) return
    beginLayoutAnimation('navigation')
    restoreNavigationToggleFocus.current = true
    setLayoutState((state) => ({ ...state, navigationPanel: 'closed' }))
  }
  const openNavigation = (): void => {
    if (!navigationAvailable) return
    beginLayoutAnimation('navigation')
    setLayoutState((state) => ({ ...state, navigationPanel: 'open' }))
  }
  const toggleNavigation = (): void => (isNavigationOpen ? closeNavigation() : openNavigation())
  const syncPanelStateFromLayout = (
    panel: keyof WorkspaceLayoutState,
    layoutValue: number | undefined,
  ): void => {
    const nextState = (layoutValue ?? 0) <= 0.01 ? 'closed' : 'open'

    setLayoutState((state) => {
      if (state[panel] === nextState) return state
      if (panel === 'navigationPanel') restoreNavigationToggleFocus.current = nextState === 'closed'
      else restoreToggleFocus.current = nextState === 'closed'
      return { ...state, [panel]: nextState }
    })
    if (panel === 'contextPanel') onContextPanelOpenChange?.(nextState === 'open')
  }
  const handleWideLayoutChanged = (layout: Layout, meta: LayoutChangedMeta): void => {
    if (!meta.isUserInteraction) return
    const navigationWidth = navigationPanelRef.current?.getSize().inPixels ?? 0
    const contextWidth = contextPanelRef.current?.getSize().inPixels ?? 0
    if (navigationWidth > 1) lastNavigationPanelWidthRef.current = navigationWidth
    if (contextWidth > 1) lastContextPanelWidthRef.current = contextWidth
    if (navigationAvailable) {
      syncPanelStateFromLayout('navigationPanel', layout['workspace-navigation'])
    }
    if (!isSettingsView) syncPanelStateFromLayout('contextPanel', layout['workspace-context'])
  }
  const handleConstrainedLayoutChanged = (layout: Layout, meta: LayoutChangedMeta): void => {
    if (!meta.isUserInteraction) return
    const navigationWidth = navigationPanelRef.current?.getSize().inPixels ?? 0
    if (navigationWidth > 1) lastNavigationPanelWidthRef.current = navigationWidth
    if (navigationAvailable) {
      syncPanelStateFromLayout('navigationPanel', layout['workspace-navigation'])
    }
  }
  const handleContextKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeContext()
      return
    }

    if (event.key !== 'Tab') return

    const focusableElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    const firstFocusable = focusableElements.at(0)
    const lastFocusable = focusableElements.at(-1)
    if (!firstFocusable || !lastFocusable) return

    if (
      event.shiftKey &&
      (document.activeElement === firstFocusable || document.activeElement === event.currentTarget)
    ) {
      event.preventDefault()
      lastFocusable.focus()
    } else if (
      !event.shiftKey &&
      (document.activeElement === lastFocusable || document.activeElement === event.currentTarget)
    ) {
      event.preventDefault()
      firstFocusable.focus()
    }
  }
  const contextPanel = providedContextPanel ?? null
  const contextToggleLabel = isContextOpen ? 'Close context panel' : 'Open context panel'
  const navigationToggleLabel = isNavigationVisible
    ? 'Hide navigation panel'
    : 'Show navigation panel'
  const shellSubtitle =
    workspaceSubtitle === undefined
      ? viewport === 'wide'
        ? 'Resizable surfaces only — fixture behavior remains local.'
        : 'Fixture-only shell with contextual overlay.'
      : workspaceSubtitle

  if (viewport === 'wide') {
    return (
      <section
        className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary"
        aria-label={workspaceTitle ? undefined : 'Pact workspace'}
        aria-labelledby={workspaceTitle ? 'workspace-title' : undefined}
        data-workspace-shell
        data-workspace-viewport={viewport}
        data-agent-actions={agentActionsEnabled ? 'enabled' : 'disabled'}
      >
        <ShellHeader
          isContextOpen={isContextOpen}
          isNavigationOpen={isNavigationVisible}
          navigationHeaderWidth={effectiveNavigationHeaderWidth}
          contextLabel={contextToggleLabel}
          navigationLabel={navigationToggleLabel}
          onToggleContext={toggleContext}
          onToggleNavigation={toggleNavigation}
          contextToggleRef={toggleButtonRef}
          navigationToggleRef={navigationToggleRef}
          showContextToggle={showContextToggle && hasContextPanel && !isSettingsView}
          showNavigationToggle={navigationAvailable}
          workspaceHeader={workspaceHeader}
          title={workspaceTitle}
          subtitle={shellSubtitle}
        />
        {workspaceNotice}
        {isContextExpanded ? (
          <div className="workspace-context-expanded min-h-0 flex-1 overflow-hidden bg-surface-raised">
            {contextPanel}
          </div>
        ) : (
          <Group
            className="workspace-layout min-h-0 min-w-0 flex-1 bg-surface"
            data-animating={isLayoutAnimating}
            id="workspace-shell"
            onLayoutChanged={handleWideLayoutChanged}
            orientation="horizontal"
            resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
          >
            <Panel
              className="workspace-panel-content min-w-0 overflow-hidden bg-surface-muted"
              collapsedSize="0%"
              collapsible
              data-open={isNavigationVisible}
              defaultSize={isNavigationVisible ? '21%' : '0%'}
              elementRef={setNavigationPanelElement}
              id="workspace-navigation"
              maxSize="30%"
              minSize="12rem"
              panelRef={navigationPanelRef}
              style={{ maxWidth: 'none' }}
            >
              <aside
                className="h-full overflow-auto"
                aria-hidden={!isNavigationVisible}
                aria-label="Navigation"
                inert={!isNavigationVisible}
              >
                {navigation}
              </aside>
            </Panel>
            <ResizeSeparator isVisible={isNavigationVisible} label="Resize navigation" />
            <Panel className="min-w-0 bg-surface" id="workspace-center" minSize="24rem">
              <PrimaryPane>{workspace}</PrimaryPane>
            </Panel>
            <ResizeSeparator isVisible={isContextVisible} label="Resize context panel" />
            <Panel
              className="workspace-panel-content min-w-0 overflow-hidden bg-surface-raised"
              collapsedSize="0%"
              collapsible
              data-open={isContextVisible}
              defaultSize="27%"
              elementRef={setContextPanelElement}
              id="workspace-context"
              maxSize="36%"
              minSize="18rem"
              panelRef={contextPanelRef}
              style={{ maxWidth: 'none' }}
            >
              <aside
                className="h-full overflow-auto"
                aria-hidden={!isContextVisible}
                aria-label="Context panel"
                inert={!isContextVisible}
              >
                {contextPanel}
              </aside>
            </Panel>
          </Group>
        )}
      </section>
    )
  }

  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary"
      aria-label={workspaceTitle ? undefined : 'Pact workspace'}
      aria-labelledby={workspaceTitle ? 'workspace-title' : undefined}
      data-workspace-shell
      data-workspace-viewport={viewport}
      data-agent-actions={agentActionsEnabled ? 'enabled' : 'disabled'}
    >
      <ShellHeader
        isContextOpen={isContextOpen}
        isNavigationOpen={isNavigationVisible}
        navigationHeaderWidth={effectiveNavigationHeaderWidth}
        contextLabel={contextToggleLabel}
        navigationLabel={navigationToggleLabel}
        onToggleContext={toggleContext}
        onToggleNavigation={toggleNavigation}
        contextToggleRef={toggleButtonRef}
        navigationToggleRef={navigationToggleRef}
        showContextToggle={showContextToggle && hasContextPanel && !isSettingsView}
        showNavigationToggle={navigationAvailable}
        workspaceHeader={workspaceHeader}
        title={workspaceTitle}
        subtitle={shellSubtitle}
      />
      {workspaceNotice}
      {isContextExpanded ? (
        <div className="workspace-context-expanded min-h-0 flex-1 overflow-hidden bg-surface-raised">
          {contextPanel}
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-surface">
          <Group
            className="workspace-layout h-full"
            data-animating={isLayoutAnimating}
            id="workspace-constrained-shell"
            onLayoutChanged={handleConstrainedLayoutChanged}
            orientation="horizontal"
            resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
          >
            <Panel
              className="workspace-panel-content min-w-0 overflow-hidden bg-surface-muted"
              collapsedSize="0%"
              collapsible
              data-open={isNavigationVisible}
              defaultSize={isNavigationVisible ? '28%' : '0%'}
              elementRef={setNavigationPanelElement}
              id="workspace-navigation"
              maxSize="34%"
              minSize="12rem"
              panelRef={navigationPanelRef}
              style={{ maxWidth: 'none' }}
            >
              <aside
                className="h-full overflow-auto"
                aria-hidden={!isNavigationVisible}
                aria-label="Navigation"
                inert={!isNavigationVisible}
              >
                {navigation}
              </aside>
            </Panel>
            <ResizeSeparator isVisible={isNavigationVisible} label="Resize navigation" />
            <Panel className="min-w-0 bg-surface" id="workspace-center" minSize="24rem">
              <PrimaryPane>{workspace}</PrimaryPane>
            </Panel>
          </Group>
          {isContextOverlayRendered && !isSettingsView ? (
            <div
              className="workspace-context-overlay absolute inset-0 z-10 overflow-hidden bg-canvas/55"
              data-open={isContextOpen}
              role="presentation"
            >
              <dialog
                className="workspace-context-dialog border-border bg-surface-raised text-primary shadow-dialog"
                data-open={isContextOpen}
                aria-label="Context panel"
                aria-modal="true"
                inert={!isContextOpen}
                onKeyDown={handleContextKeyDown}
                open
                ref={contextDialogRef}
              >
                {contextPanel}
              </dialog>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

interface ShellHeaderProps {
  isContextOpen: boolean
  isNavigationOpen: boolean
  navigationHeaderWidth: number
  contextLabel: string
  navigationLabel: string
  onToggleContext: () => void
  onToggleNavigation: () => void
  contextToggleRef: React.RefObject<HTMLButtonElement | null>
  navigationToggleRef: React.RefObject<HTMLButtonElement | null>
  showContextToggle: boolean
  showNavigationToggle: boolean
  workspaceHeader?: ReactNode
  title: string | null
  subtitle: string | null
}

function ShellHeader({
  isContextOpen,
  isNavigationOpen,
  navigationHeaderWidth,
  contextLabel,
  navigationLabel,
  onToggleContext,
  onToggleNavigation,
  contextToggleRef,
  navigationToggleRef,
  showContextToggle,
  showNavigationToggle,
  workspaceHeader,
  title,
  subtitle,
}: ShellHeaderProps): React.JSX.Element {
  const fallbackHeader =
    title || subtitle ? (
      <div className="min-w-0">
        {title ? (
          <h1 id="workspace-title" className="truncate text-body font-medium tracking-[-0.015em]">
            {title}
          </h1>
        ) : null}
        {subtitle ? <p className="truncate text-caption text-secondary">{subtitle}</p> : null}
      </div>
    ) : null

  return (
    <header className="pact-titlebar workspace-titlebar relative h-12 shrink-0 bg-surface">
      <div
        aria-hidden="true"
        className="workspace-titlebar-chat absolute inset-y-0 right-0 border-b border-border bg-surface"
        style={{ left: `${navigationHeaderWidth}px` }}
      />
      <div
        aria-hidden="true"
        className="workspace-titlebar-navigation absolute inset-y-0 left-0 bg-surface-muted"
        style={{ width: `${navigationHeaderWidth}px` }}
      />
      {navigationHeaderWidth > 0 ? (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 z-10 w-px bg-border"
          style={{ left: `${navigationHeaderWidth}px` }}
        />
      ) : null}
      <div className="pact-titlebar-content relative flex h-full min-w-0 items-center gap-group px-group">
        <div
          className="flex shrink-0 items-center"
          style={
            isNavigationOpen
              ? {
                  width: `max(2rem, calc(${navigationHeaderWidth}px - env(titlebar-area-x, 0px) - var(--pact-space-group)))`,
                }
              : undefined
          }
        >
          {showNavigationToggle ? (
            <button
              ref={navigationToggleRef}
              className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
              type="button"
              aria-expanded={isNavigationOpen}
              aria-label={navigationLabel}
              title={navigationLabel}
              onClick={onToggleNavigation}
            >
              <PanelLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">{workspaceHeader ?? fallbackHeader}</div>
        {showContextToggle ? (
          <button
            ref={contextToggleRef}
            className="h-8 shrink-0 rounded-control border border-border bg-surface-raised px-3 text-caption font-medium text-primary hover:bg-surface-muted"
            type="button"
            aria-expanded={isContextOpen}
            onClick={onToggleContext}
          >
            {contextLabel}
          </button>
        ) : null}
      </div>
    </header>
  )
}
