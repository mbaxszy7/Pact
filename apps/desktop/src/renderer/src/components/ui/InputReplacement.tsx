import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type Replacement = { key: string; content: ReactNode }

const EXIT_RETENTION_MS = 220

/**
 * One input location, two mutually exclusive interactive surfaces.
 * Keeps the ordinary editor mounted, retains outgoing content for 220 ms,
 * commits target height synchronously (zero per-frame height reflow),
 * animates panes via GPU translate3d/opacity/scale in CSS (`--ease-silk-out`),
 * and reports live height deltas via `onHeightDelta` so the transcript owner
 * compensates scroll strictly when sticking to bottom.
 * Admission and draft ownership belong to the caller.
 */
export function InputReplacement({
  replacement,
  onHeightDelta,
  children,
}: {
  replacement?: Replacement | undefined
  onHeightDelta?: ((delta: number) => void) | undefined
  children: ReactNode
}): React.JSX.Element {
  const [retained, setRetained] = useState(replacement)
  const root = useRef<HTMLDivElement>(null)
  const ordinary = useRef<HTMLDivElement>(null)
  const alternate = useRef<HTMLDivElement>(null)
  const lastHeight = useRef<number | undefined>(undefined)
  const focusOwner = useRef<'ordinary' | 'alternate' | undefined>(undefined)
  const active = Boolean(replacement)
  const mode = useRef(active)
  const modeKey = useRef(replacement?.key)

  const reportHeightDelta = useEffectEvent((delta: number): void => {
    onHeightDelta?.(delta)
  })

  useLayoutEffect(() => {
    if (replacement) {
      // oxlint-disable-next-line react-hooks/set-state-in-effect, react/set-state-in-effect -- Retain only the outgoing surface until its exit transition finishes.
      setRetained(replacement)
      return undefined
    }
    const timer = window.setTimeout(() => setRetained(undefined), EXIT_RETENTION_MS)
    return () => window.clearTimeout(timer)
  }, [replacement])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return undefined
    const activePanel = mode.current ? alternate.current : ordinary.current
    if (activePanel) {
      const initialHeight = activePanel.offsetHeight
      if (initialHeight > 0) lastHeight.current = initialHeight
    }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !element.contains(event.target))
        focusOwner.current = undefined
    }
    const blur = (): void => {
      focusOwner.current = undefined
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useLayoutEffect(() => {
    const previous = mode.current
    const previousKey = modeKey.current
    mode.current = active
    modeKey.current = replacement?.key

    const panel = active ? alternate.current : ordinary.current
    if (panel) {
      const nextHeight = panel.offsetHeight
      if (nextHeight > 0) {
        const prevHeight = lastHeight.current
        lastHeight.current = nextHeight
        if (prevHeight !== undefined && (previous !== active || previousKey !== replacement?.key)) {
          const delta = nextHeight - prevHeight
          if (Math.abs(delta) > 0.5) {
            reportHeightDelta(delta)
          }
        }
      }
    }

    if (previous === active && previousKey === replacement?.key) return
    const owner = focusOwner.current
    if (
      (active && owner !== 'ordinary' && owner !== 'alternate') ||
      (!active && owner !== 'alternate')
    )
      return
    if (!panel) return
    const targets = [
      ...panel.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea, input'),
      ...panel.querySelectorAll<HTMLElement>('button'),
    ]
    for (const target of targets) {
      if (
        target.matches(':disabled, [aria-disabled="true"]') ||
        target.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]') ||
        !target.getClientRects().length ||
        window.getComputedStyle(target).visibility === 'hidden'
      )
        continue
      target.focus({ preventScroll: true })
      if (document.activeElement === target || target.contains(document.activeElement)) return
    }
    // A status-only replacement still has an accessible focus destination.
    panel.tabIndex = -1
    panel.focus({ preventScroll: true })
  }, [active, replacement?.key])

  useLayoutEffect(() => {
    const panel = active ? alternate.current : ordinary.current
    if (!panel || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const nextHeight = panel.offsetHeight
      if (nextHeight <= 0) return
      const prevHeight = lastHeight.current
      lastHeight.current = nextHeight
      if (prevHeight === undefined) return
      const delta = nextHeight - prevHeight
      if (Math.abs(delta) > 0.5) {
        reportHeightDelta(delta)
      }
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [active])

  return (
    <div
      ref={root}
      className="input-replacement"
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          focusOwner.current = undefined
      }}
    >
      <div
        ref={ordinary}
        data-input-panel="ordinary"
        className="input-replacement-pane"
        data-active={!active}
        inert={active}
        aria-hidden={active}
        onFocusCapture={() => {
          focusOwner.current = 'ordinary'
        }}
      >
        {children}
      </div>
      <div
        ref={alternate}
        data-input-panel="alternate"
        className="input-replacement-pane"
        data-active={active}
        inert={!active}
        aria-hidden={!active}
        onFocusCapture={() => {
          focusOwner.current = 'alternate'
        }}
      >
        {replacement?.content ?? retained?.content}
      </div>
    </div>
  )
}
