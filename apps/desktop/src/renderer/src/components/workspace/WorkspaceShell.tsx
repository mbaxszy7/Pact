import { PanelLeft } from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
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
  onNavigationVisibilityChange?: ((visible: boolean) => void) | undefined
  workspace: ReactNode
  workspaceHeader?: ReactNode
  workspaceNotice?: ReactNode
  workspaceTitle?: string | null
  workspaceSubtitle?: string | null
  navigationAvailable?: boolean
  agentActionsEnabled?: boolean
  isSettingsView?: boolean
  nativePresentationSuspended?: boolean | undefined
  contextPanel?: ReactNode
  contextPanelOpen?: boolean | undefined
  onContextPanelOpenChange?: ((open: boolean) => void) | undefined
  contextPanelExpanded?: boolean | undefined
  contextPanelWidthLimited?: boolean | undefined
  contextPanelRestoreFocusRef?: React.RefObject<HTMLElement | null> | undefined
  showContextToggle?: boolean
  centerSheetManaged?: boolean | undefined
  initialState?: WorkspaceLayoutState
}

type WorkspaceViewport = 'wide' | 'compact' | 'narrow'

const wideNavigationDefaultSize = '23%'
const wideContextDefaultSize = '29%'
const SILK_OUT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const FLIP_DURATION_MS = 260
const REDUCED_FADE_MS = 100

const defaultLayoutState: WorkspaceLayoutState = {
  navigationPanel: 'open',
  contextPanel: 'open',
}

function availableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (
    !element?.isConnected ||
    element.matches(':disabled') ||
    element.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]') ||
    element.getClientRects().length === 0
  )
    return false
  const visibility = window.getComputedStyle(element).visibility
  return visibility !== 'hidden' && visibility !== 'collapse'
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
  if (!element) return
  if (currentWidth > 1) lastWidth.current = currentWidth
  if (lastWidth.current > 0) {
    element.style.setProperty('--workspace-panel-content-width', `${lastWidth.current}px`)
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function cancelActiveAnimations(element: HTMLElement | null): void {
  if (!element || typeof element.getAnimations !== 'function') return
  for (const animation of element.getAnimations()) {
    animation.cancel()
  }
}

function runSilkFlip(
  element: HTMLElement | null,
  keyframes: Keyframe[],
  reducedKeyframes?: Keyframe[],
): void {
  if (!element || typeof element.animate !== 'function') return
  cancelActiveAnimations(element)
  if (prefersReducedMotion()) {
    if (!reducedKeyframes) return
    element.animate(reducedKeyframes, {
      duration: REDUCED_FADE_MS,
      easing: 'ease-out',
    })
    return
  }
  element.animate(keyframes, {
    duration: FLIP_DURATION_MS,
    easing: SILK_OUT_EASING,
  })
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

function PrimaryPane({
  children,
  managed = false,
}: {
  children: ReactNode
  managed?: boolean | undefined
}): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Workspace">
      <div className={managed ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto'}>
        {children}
      </div>
    </section>
  )
}

export function WorkspaceShell({
  navigation,
  onNavigationVisibilityChange,
  workspace,
  workspaceHeader,
  workspaceNotice,
  workspaceTitle = 'Workspace shell fixture',
  workspaceSubtitle,
  navigationAvailable = true,
  agentActionsEnabled = true,
  isSettingsView = false,
  nativePresentationSuspended = false,
  contextPanel: providedContextPanel,
  contextPanelOpen,
  onContextPanelOpenChange,
  contextPanelExpanded = false,
  contextPanelWidthLimited = true,
  contextPanelRestoreFocusRef,
  showContextToggle = true,
  centerSheetManaged = false,
  initialState = defaultLayoutState,
}: WorkspaceShellProps): React.JSX.Element {
  const initialViewport = getWorkspaceViewport()
  const hasContextPanel = Boolean(providedContextPanel)
  const [layoutState, setLayoutState] = useState<WorkspaceLayoutState>(initialState)
  const [isContextOverlayRendered, setIsContextOverlayRendered] = useState(
    () =>
      hasContextPanel &&
      (contextPanelOpen ?? initialState.contextPanel === 'open') &&
      !isSettingsView &&
      initialViewport !== 'wide',
  )
  const [navigationPanelElement, setNavigationPanelElement] = useState<HTMLDivElement | null>(null)
  const [centerPanelElement, setCenterPanelElement] = useState<HTMLDivElement | null>(null)
  const [contextPanelElement, setContextPanelElement] = useState<HTMLDivElement | null>(null)
  const shellRef = useRef<HTMLElement>(null)
  const navigationPanelRef = usePanelRef()
  const contextPanelRef = usePanelRef()
  const openedWideNavigationPanelRef = useRef<HTMLDivElement | null>(null)
  const lastNavigationPanelWidthRef = useRef(0)
  const lastContextPanelWidthRef = useRef(0)
  const navigationToggleRef = useRef<HTMLButtonElement>(null)
  const toggleButtonRef = useRef<HTMLButtonElement>(null)
  const contextDialogRef = useRef<HTMLDialogElement>(null)
  const overlayExitTimerRef = useRef<number | undefined>(undefined)
  const contextFocusScrollPositionRef = useRef({ x: 0, y: 0 })
  const contextReturnFocusRef = useRef<HTMLElement | null>(null)
  const wasContextVisibleRef = useRef(false)
  const restoreNavigationToggleFocus = useRef(false)
  const hasCommittedNavRef = useRef(false)
  const hasCommittedContextRef = useRef(false)
  const skipNextFlipRef = useRef(false)

  const isNavigationOpen = layoutState.navigationPanel === 'open'
  const isNavigationVisible = navigationAvailable && isNavigationOpen
  const isContextOpen = contextPanelOpen ?? layoutState.contextPanel === 'open'
  const isContextVisible = hasContextPanel && isContextOpen && !isSettingsView
  const isContextExpanded = isContextVisible && contextPanelExpanded
  const isNavigationContentVisible = isNavigationVisible && !isContextExpanded

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

  // Sync navigation width directly to --pact-nav-px without triggering React re-renders during drag.
  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined
    const syncNavPx = (): void => {
      const width =
        navigationPanelElement && !isContextExpanded
          ? Math.round(navigationPanelElement.getBoundingClientRect().width)
          : 0
      shell.style.setProperty('--pact-nav-px', `${width}px`)
    }
    syncNavPx()
    if (!navigationPanelElement || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(syncNavPx)
    observer.observe(navigationPanelElement)
    return () => observer.disconnect()
  }, [navigationPanelElement, isContextExpanded])

  useEffect(() => {
    return () => {
      window.clearTimeout(overlayExitTimerRef.current)
      contextReturnFocusRef.current = null
    }
  }, [])

  // Target-first navigation geometry + interruptible FLIP translate3d (zero flex-grow reflow).
  useLayoutEffect(() => {
    const panel = navigationPanelRef.current
    if (!panel) return
    const shouldAnimate = hasCommittedNavRef.current && !skipNextFlipRef.current
    hasCommittedNavRef.current = true
    skipNextFlipRef.current = false

    const prevCenterLeft = shouldAnimate
      ? centerPanelElement?.getBoundingClientRect().left
      : undefined
    if (!isNavigationVisible) {
      const currentWidth =
        navigationPanelElement?.getBoundingClientRect().width || panel.getSize().inPixels
      freezePanelContent(navigationPanelElement, currentWidth, lastNavigationPanelWidthRef)
      panel.collapse()
    } else if (viewport === 'wide' && navigationPanelElement) {
      navigationPanelElement.style.removeProperty('--workspace-panel-content-width')
      const previousWidth =
        openedWideNavigationPanelRef.current === navigationPanelElement
          ? lastNavigationPanelWidthRef.current
          : 0
      openedWideNavigationPanelRef.current = navigationPanelElement
      if (panel.isCollapsed()) {
        // The panel may have mounted at zero before Projects arrived.
        panel.resize(previousWidth > 1 ? previousWidth : wideNavigationDefaultSize)
      } else {
        panel.expand()
      }
    } else {
      navigationPanelElement?.style.removeProperty('--workspace-panel-content-width')
      panel.expand()
    }

    if (!shouldAnimate) return
    if (centerPanelElement && prevCenterLeft !== undefined) {
      const nextCenterLeft = centerPanelElement.getBoundingClientRect().left
      const deltaX = prevCenterLeft - nextCenterLeft
      if (Math.abs(deltaX) > 1) {
        runSilkFlip(centerPanelElement, [
          { transform: `translate3d(${deltaX}px, 0, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ])
      }
    }
    if (isNavigationVisible && navigationPanelElement) {
      const content = navigationPanelElement.querySelector<HTMLElement>('.workspace-panel-content')
      runSilkFlip(
        content ?? navigationPanelElement,
        [
          { opacity: 0, transform: 'translate3d(-14px, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        [{ opacity: 0 }, { opacity: 1 }],
      )
    }
  }, [
    isNavigationVisible,
    navigationPanelElement,
    centerPanelElement,
    navigationPanelRef,
    viewport,
  ])

  // Target-first right ContextInspector geometry + interruptible FLIP translate3d.
  useLayoutEffect(() => {
    if (viewport !== 'wide') return
    const panel = contextPanelRef.current
    if (!panel) return
    const shouldAnimate = hasCommittedContextRef.current && !skipNextFlipRef.current
    hasCommittedContextRef.current = true
    skipNextFlipRef.current = false

    if (isContextVisible) {
      contextPanelElement?.style.removeProperty('--workspace-panel-content-width')
      if (panel.isCollapsed()) {
        const previousWidth = lastContextPanelWidthRef.current
        panel.resize(previousWidth > 1 ? previousWidth : wideContextDefaultSize)
      } else {
        panel.expand()
      }
    } else {
      const currentWidth =
        contextPanelElement?.getBoundingClientRect().width || panel.getSize().inPixels
      freezePanelContent(contextPanelElement, currentWidth, lastContextPanelWidthRef)
      panel.collapse()
    }

    if (!shouldAnimate) return
    if (isContextVisible && contextPanelElement) {
      runSilkFlip(
        contextPanelElement,
        [
          { opacity: 0.2, transform: 'translate3d(20px, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        [{ opacity: 0 }, { opacity: 1 }],
      )
    }
  }, [contextPanelRef, contextPanelElement, isContextVisible, viewport])

  useEffect(() => {
    if (isNavigationVisible || !restoreNavigationToggleFocus.current) return
    navigationToggleRef.current?.focus({ preventScroll: true })
    restoreNavigationToggleFocus.current = false
  }, [isNavigationVisible])

  useLayoutEffect(() => {
    if (isContextVisible && !wasContextVisibleRef.current) {
      const active = document.activeElement
      const declared = contextPanelRestoreFocusRef?.current ?? toggleButtonRef.current
      contextReturnFocusRef.current = availableFocusTarget(declared)
        ? declared
        : active instanceof HTMLElement &&
            !contextDialogRef.current?.contains(active) &&
            availableFocusTarget(active)
          ? active
          : null
    } else if (!isContextVisible && wasContextVisibleRef.current) {
      const target = contextReturnFocusRef.current
      contextReturnFocusRef.current = null
      const active = document.activeElement
      if (
        availableFocusTarget(target) &&
        (active === document.body ||
          active === document.documentElement ||
          contextDialogRef.current?.contains(active))
      )
        target.focus({ preventScroll: true })
    }
    wasContextVisibleRef.current = isContextVisible
  }, [isContextVisible, contextPanelRestoreFocusRef])

  useEffect(() => {
    if (!isContextVisible || !isContextOverlayRendered || isContextExpanded || viewport === 'wide')
      return undefined
    const { x, y } = contextFocusScrollPositionRef.current
    contextDialogRef.current?.focus({ preventScroll: true })
    const frame = window.requestAnimationFrame(() => window.scrollTo(x, y))
    return () => window.cancelAnimationFrame(frame)
  }, [isContextVisible, isContextOverlayRendered, isContextExpanded, viewport])

  const closeContext = (): void => {
    setLayoutState((state) => ({ ...state, contextPanel: 'closed' }))
    onContextPanelOpenChange?.(false)
  }
  const openContext = (): void => {
    setLayoutState((state) => ({ ...state, contextPanel: 'open' }))
    onContextPanelOpenChange?.(true)
  }
  const toggleContext = (): void => (isContextOpen ? closeContext() : openContext())

  // Cmd/Ctrl + J toggles the right ContextInspector cleanly.
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      isSettingsView ||
      !hasContextPanel ||
      nativePresentationSuspended ||
      Boolean(shellRef.current?.closest('[inert]')) ||
      Boolean(document.querySelector('dialog[open]'))
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'j'
    ) {
      event.preventDefault()
      toggleContext()
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handleGlobalShortcut(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const closeNavigation = (): void => {
    if (!navigationAvailable) return
    restoreNavigationToggleFocus.current = true
    setLayoutState((state) => ({ ...state, navigationPanel: 'closed' }))
  }
  const openNavigation = (): void => {
    if (!navigationAvailable) return
    setLayoutState((state) => ({ ...state, navigationPanel: 'open' }))
  }
  const toggleNavigation = (): void => (isNavigationOpen ? closeNavigation() : openNavigation())

  const syncPanelStateFromLayout = (
    panel: keyof WorkspaceLayoutState,
    layoutValue: number | undefined,
  ): void => {
    const nextState = (layoutValue ?? 0) <= 0.01 ? 'closed' : 'open'
    const nextOpen = nextState === 'open'

    setLayoutState((state) => {
      if (state[panel] === nextState) return state
      skipNextFlipRef.current = true
      if (panel === 'navigationPanel') restoreNavigationToggleFocus.current = nextState === 'closed'
      return { ...state, [panel]: nextState }
    })
    if (panel === 'contextPanel' && nextOpen !== isContextOpen) {
      onContextPanelOpenChange?.(nextOpen)
    }
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
  const handleContextKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeContext()
      return
    }

    if (event.key !== 'Tab') return

    const dialog = contextDialogRef.current
    if (!dialog) return
    const focusableElements = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element instanceof HTMLElement && element.tabIndex >= 0 && availableFocusTarget(element),
    )
    const firstFocusable = focusableElements.at(0)
    const lastFocusable = focusableElements.at(-1)
    if (!firstFocusable || !lastFocusable) {
      event.preventDefault()
      dialog.focus({ preventScroll: true })
      return
    }

    if (
      event.shiftKey &&
      (document.activeElement === firstFocusable || document.activeElement === dialog)
    ) {
      event.preventDefault()
      lastFocusable.focus({ preventScroll: true })
    } else if (
      !event.shiftKey &&
      (document.activeElement === lastFocusable || document.activeElement === dialog)
    ) {
      event.preventDefault()
      firstFocusable.focus({ preventScroll: true })
    }
  })

  useLayoutEffect(() => {
    const dialog = contextDialogRef.current
    if (
      !dialog ||
      !isContextVisible ||
      !isContextOverlayRendered ||
      isContextExpanded ||
      viewport === 'wide'
    )
      return undefined
    // Portal descendants share this DOM boundary even when their React ancestors
    // belong to the Transcript. The modal owner keeps one listener for this lifetime.
    const keydown = (event: KeyboardEvent): void => handleContextKeyDown(event)
    dialog.addEventListener('keydown', keydown)
    return () => dialog.removeEventListener('keydown', keydown)
  }, [isContextVisible, isContextOverlayRendered, isContextExpanded, viewport])

  const contextPanel = providedContextPanel ?? null
  const notifyNavigationVisibility = useEffectEvent((visible: boolean): void => {
    onNavigationVisibilityChange?.(visible)
  })
  useEffect(() => {
    notifyNavigationVisibility(isNavigationContentVisible)
  }, [isNavigationContentVisible])
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
        ref={shellRef}
        className="pact-silk-surface relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary"
        aria-label={workspaceTitle ? undefined : 'Pact workspace'}
        aria-labelledby={workspaceTitle ? 'workspace-title' : undefined}
        data-workspace-shell
        data-workspace-viewport={viewport}
        data-nav-open={isNavigationContentVisible ? 'true' : 'false'}
        data-agent-actions={agentActionsEnabled ? 'enabled' : 'disabled'}
      >
        <ShellHeader
          isContextOpen={isContextOpen}
          isNavigationOpen={isNavigationContentVisible}
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
        <Group
          className="workspace-layout relative min-h-0 min-w-0 flex-1"
          data-context-expanded={isContextExpanded}
          id="workspace-shell"
          onLayoutChanged={handleWideLayoutChanged}
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
        >
          <Panel
            className="workspace-panel-content min-w-0 overflow-hidden bg-transparent"
            collapsedSize="0%"
            collapsible
            data-open={isNavigationVisible}
            defaultSize={isNavigationVisible ? wideNavigationDefaultSize : '0%'}
            elementRef={setNavigationPanelElement}
            id="workspace-navigation"
            maxSize="30%"
            minSize="12rem"
            panelRef={navigationPanelRef}
            style={{ maxWidth: 'none' }}
          >
            <aside
              className="h-full overflow-auto"
              aria-hidden={!isNavigationContentVisible}
              aria-label="Navigation"
              inert={!isNavigationContentVisible}
            >
              {navigation}
            </aside>
          </Panel>
          <ResizeSeparator
            isVisible={isNavigationVisible && !isContextExpanded}
            label="Resize navigation"
          />
          <Panel
            className={centerSheetManaged ? 'min-w-0 bg-transparent' : 'workspace-sheet min-w-0'}
            data-center-sheets={centerSheetManaged ? 'true' : undefined}
            elementRef={setCenterPanelElement}
            id="workspace-center"
            minSize="24rem"
            aria-hidden={isContextExpanded}
            inert={isContextExpanded}
          >
            <PrimaryPane managed={centerSheetManaged}>{workspace}</PrimaryPane>
          </Panel>
          <ResizeSeparator
            isVisible={isContextVisible && !isContextExpanded}
            label="Resize context panel"
          />
          <Panel
            className="workspace-panel-content workspace-sheet min-w-0 overflow-hidden"
            collapsedSize="0%"
            collapsible
            data-open={isContextVisible}
            defaultSize={isContextVisible ? wideContextDefaultSize : '0%'}
            elementRef={setContextPanelElement}
            id="workspace-context"
            maxSize={contextPanelWidthLimited ? '42%' : undefined}
            minSize="18rem"
            panelRef={contextPanelRef}
            style={{ maxWidth: 'none' }}
          >
            <aside
              className="h-full overflow-hidden"
              aria-hidden={!isContextVisible}
              aria-label="Context panel"
              inert={!isContextVisible}
            >
              {contextPanel}
            </aside>
          </Panel>
        </Group>
      </section>
    )
  }

  return (
    <section
      ref={shellRef}
      className="pact-silk-surface relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary"
      aria-label={workspaceTitle ? undefined : 'Pact workspace'}
      aria-labelledby={workspaceTitle ? 'workspace-title' : undefined}
      data-workspace-shell
      data-workspace-viewport={viewport}
      data-nav-open={isNavigationContentVisible ? 'true' : 'false'}
      data-agent-actions={agentActionsEnabled ? 'enabled' : 'disabled'}
    >
      <ShellHeader
        isContextOpen={isContextOpen}
        isNavigationOpen={isNavigationContentVisible}
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
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Group
          className="workspace-layout h-full"
          id="workspace-constrained-shell"
          onLayoutChanged={handleConstrainedLayoutChanged}
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 28, fine: 16 }}
        >
          <Panel
            className="workspace-panel-content min-w-0 overflow-hidden bg-transparent"
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
              aria-hidden={!isNavigationContentVisible}
              aria-label="Navigation"
              inert={!isNavigationContentVisible}
            >
              {navigation}
            </aside>
          </Panel>
          <ResizeSeparator
            isVisible={isNavigationVisible && !isContextExpanded}
            label="Resize navigation"
          />
          <Panel
            className={centerSheetManaged ? 'min-w-0 bg-transparent' : 'workspace-sheet min-w-0'}
            data-center-sheets={centerSheetManaged ? 'true' : undefined}
            elementRef={setCenterPanelElement}
            id="workspace-center"
            minSize="24rem"
            aria-hidden={isContextExpanded}
            inert={isContextExpanded}
          >
            <PrimaryPane managed={centerSheetManaged}>{workspace}</PrimaryPane>
          </Panel>
        </Group>
        {isContextOverlayRendered && !isSettingsView ? (
          <div
            className="workspace-context-overlay absolute inset-0 z-10 overflow-hidden bg-canvas/55"
            data-open={isContextOpen}
            role="presentation"
          >
            <dialog
              className="workspace-context-dialog border-border bg-surface text-primary shadow-dialog"
              data-expanded={isContextExpanded}
              data-open={isContextOpen}
              aria-label="Context panel"
              aria-modal="true"
              inert={!isContextOpen}
              open
              ref={contextDialogRef}
            >
              {contextPanel}
            </dialog>
          </div>
        ) : null}
      </div>
    </section>
  )
}

interface ShellHeaderProps {
  isContextOpen: boolean
  isNavigationOpen: boolean
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
    <header className="pact-titlebar workspace-titlebar relative h-12 shrink-0 bg-canvas">
      <div className="pact-titlebar-content relative flex h-full min-w-0 items-center gap-group px-group">
        <div
          className="flex shrink-0 items-center"
          style={
            isNavigationOpen
              ? {
                  width:
                    'max(2rem, calc(var(--pact-nav-px, 0px) - env(titlebar-area-x, 0px) - var(--pact-space-group)))',
                }
              : undefined
          }
        >
          {showNavigationToggle ? (
            <button
              ref={navigationToggleRef}
              className="pact-pressable grid size-8 shrink-0 place-items-center rounded-xl text-secondary hover:bg-row-hover hover:text-primary"
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
            className="pact-pressable h-8 shrink-0 rounded-xl border border-border bg-surface-raised px-3 text-caption font-medium text-primary hover:bg-surface-muted"
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
