import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type Replacement = { key: string; content: ReactNode }

/**
 * One input location, two mutually exclusive interactive surfaces.
 * Keeps the ordinary editor mounted, retains outgoing content for 220 ms, and owns
 * two observed panels, one height animation and one cancellable exit timer.
 * Admission and draft ownership belong to the caller.
 */
export function InputReplacement({
  replacement,
  children,
}: {
  replacement?: Replacement | undefined
  children: ReactNode
}): React.JSX.Element {
  const [retained, setRetained] = useState(replacement)
  const root = useRef<HTMLDivElement>(null)
  const ordinary = useRef<HTMLDivElement>(null)
  const alternate = useRef<HTMLDivElement>(null)
  const height = useRef<number | undefined>(undefined)
  const animation = useRef<Animation | undefined>(undefined)
  const focusOwner = useRef<'ordinary' | 'alternate' | undefined>(undefined)
  const active = Boolean(replacement)
  const mode = useRef(active)
  const modeKey = useRef(replacement?.key)
  const measureCurrent = useRef<(() => void) | undefined>(undefined)

  useLayoutEffect(() => {
    if (replacement) {
      // oxlint-disable-next-line react-hooks/set-state-in-effect, react/set-state-in-effect -- Retain only the outgoing surface until its exit animation finishes.
      setRetained(replacement)
      return undefined
    }
    const timer = window.setTimeout(() => setRetained(undefined), 220)
    return () => window.clearTimeout(timer)
  }, [replacement])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return undefined
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const measure = (): void => {
      const panel = mode.current ? alternate.current : ordinary.current
      if (!panel) return
      const next = panel.getBoundingClientRect().height
      if (height.current === next) return
      const previous = animation.current ? element.getBoundingClientRect().height : height.current
      height.current = next
      animation.current?.cancel()
      animation.current = undefined
      delete element.dataset.transitioning
      if (previous === undefined || media.matches) return
      const transition = element.animate([{ height: `${previous}px` }, { height: `${next}px` }], {
        duration: 220,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      })
      animation.current = transition
      element.dataset.transitioning = 'true'
      transition.onfinish = () => {
        if (animation.current === transition) {
          animation.current = undefined
          delete element.dataset.transitioning
        }
      }
    }
    measureCurrent.current = measure
    const observer = new ResizeObserver(measure)
    if (ordinary.current) observer.observe(ordinary.current)
    if (alternate.current) observer.observe(alternate.current)
    const reduce = (): void => {
      if (media.matches) {
        animation.current?.cancel()
        animation.current = undefined
        delete element.dataset.transitioning
      }
    }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !element.contains(event.target))
        focusOwner.current = undefined
    }
    const blur = (): void => {
      focusOwner.current = undefined
    }
    media.addEventListener('change', reduce)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    measure()
    return () => {
      observer.disconnect()
      measureCurrent.current = undefined
      animation.current?.cancel()
      animation.current = undefined
      delete element.dataset.transitioning
      media.removeEventListener('change', reduce)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useLayoutEffect(() => {
    const previous = mode.current
    const previousKey = modeKey.current
    mode.current = active
    modeKey.current = replacement?.key
    measureCurrent.current?.()
    if (previous === active && previousKey === replacement?.key) return
    const owner = focusOwner.current
    if (
      (active && owner !== 'ordinary' && owner !== 'alternate') ||
      (!active && owner !== 'alternate')
    )
      return
    const panel = active ? alternate.current : ordinary.current
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
