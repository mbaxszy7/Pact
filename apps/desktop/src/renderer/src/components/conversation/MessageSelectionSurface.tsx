import { MessageCirclePlus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import {
  selectedTextRange,
  projectionBoundaryOffset,
  drawMountedProjectionIntersection,
  clearProjectionHighlight,
  isProjectionHighlightOwned,
} from './message-selection'

export interface MessageTextSelection {
  messageId: string
  startOffset: number
  endOffset: number
  quote: string
}

export interface DocumentSelectionRange {
  startOffset: number
  endOffset: number
}

export interface DocumentSelectionAdapter {
  sourceKey: string
  windowRevision: number
  viewport: React.RefObject<HTMLDivElement | null>
  reveal?: (DocumentSelectionRange & { id: string }) | undefined
  onRevealApplied?: ((id: string) => void) | undefined
  resolveRange: (range: DocumentSelectionRange, signal: AbortSignal) => Promise<string>
  scrollViewport: (top: number) => void
  moveViewport: (target: 'previous' | 'next' | number, signal: AbortSignal) => Promise<void>
}

interface MessageSelectionSurfaceProps {
  children: ReactNode
  messageId?: string | undefined
  onCreateComment?: ((selection: MessageTextSelection) => void) | undefined
  documentSelection?: DocumentSelectionAdapter | undefined
}

export function MessageSelectionSurface(props: MessageSelectionSurfaceProps): React.JSX.Element {
  return props.documentSelection ? (
    <DocumentSelectionSurface {...props} documentSelection={props.documentSelection} />
  ) : (
    <NativeMessageSelectionSurface {...props} />
  )
}

type LogicalSelection = {
  revision: number
  anchor: number
  focus: number
  origin: 'user' | 'source'
  phase: 'dragging' | 'verifying' | 'ready' | 'invalid'
  quote: string
  coverageStart: number
  coverage: Uint8Array
  error?: string | undefined
  movementFailed?: boolean
}

const rangeOf = (value: LogicalSelection): DocumentSelectionRange => ({
  startOffset: Math.min(value.anchor, value.focus),
  endOffset: Math.max(value.anchor, value.focus),
})

function DocumentSelectionSurface({
  children,
  messageId,
  onCreateComment,
  documentSelection: adapter,
}: MessageSelectionSurfaceProps & {
  documentSelection: DocumentSelectionAdapter
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const logical = useRef<LogicalSelection | undefined>(undefined)
  const identity = useRef({})
  const revision = useRef(0)
  const [revealRetry, setRevealRetry] = useState(0)
  const work = useRef<AbortController | undefined>(undefined)
  const latest = useRef({ adapter, onCreateComment, messageId })
  const [view, setView] = useState<{
    revision: number
    phase: LogicalSelection['phase']
    error?: string | undefined
    left: number
    top: number
  }>()
  useLayoutEffect(() => {
    latest.current = { adapter, onCreateComment, messageId }
  })
  const publish = (): void => {
    const value = logical.current
    const host = hostRef.current
    if (!value || !host) {
      setView(undefined)
      return
    }
    const selection = window.getSelection()
    const rect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : host.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const viewportRect =
      latest.current.adapter.viewport.current?.getBoundingClientRect() ?? hostRect
    setView({
      revision: value.revision,
      phase: value.phase,
      error: value.error,
      left: Math.max(8, Math.min(rect.left - hostRect.left, host.clientWidth - 136)),
      top: Math.max(
        viewportRect.top - hostRect.top + 8,
        Math.min(rect.bottom - hostRect.top + 8, viewportRect.bottom - hostRect.top - 40),
      ),
    })
  }
  const clear = (): void => {
    work.current?.abort()
    work.current = undefined
    logical.current = undefined
    revision.current++
    clearProjectionHighlight(identity.current)
    setView(undefined)
  }
  const coverage = (): void => {
    const value = logical.current
    const host = hostRef.current
    if (!value || !host || value.origin !== 'user') return
    const { startOffset: start, endOffset: end } = rangeOf(value)
    if (end - start > 20_000) {
      value.coverage = new Uint8Array(0)
      value.coverageStart = start
      value.phase = 'invalid'
      value.error = 'Select at most 20,000 characters for one Comment.'
      return
    }
    const marks = new Uint8Array(end - start)
    const overlapStart = Math.max(start, value.coverageStart)
    const overlapEnd = Math.min(end, value.coverageStart + value.coverage.length)
    if (overlapEnd > overlapStart)
      marks.set(
        value.coverage.subarray(
          overlapStart - value.coverageStart,
          overlapEnd - value.coverageStart,
        ),
        overlapStart - start,
      )
    for (const span of host.querySelectorAll<HTMLElement>(
      '[data-pact-projection-start], [data-pact-source-start]',
    )) {
      const original = span.dataset.pactProjectionStart !== undefined
      const from = Number(span.dataset.pactProjectionStart ?? span.dataset.pactSourceStart)
      const to = Number(span.dataset.pactProjectionEnd ?? span.dataset.pactSourceEnd)
      const low = Math.max(start, from),
        high = Math.min(end, to)
      if (high > low) marks.fill(original ? 1 : 2, low - start, high - start)
    }
    value.coverageStart = start
    value.coverage = marks
  }
  const paint = (): void => {
    const value = logical.current
    const host = hostRef.current
    if (!value || !host) return
    const range = rangeOf(value)
    drawMountedProjectionIntersection(
      host,
      range.startOffset,
      range.endOffset,
      identity.current,
      value.origin === 'source',
    )
  }
  const verify = async (): Promise<void> => {
    const value = logical.current
    if (!value || value.movementFailed) return
    const range = rangeOf(value)
    coverage()
    if (range.endOffset <= range.startOffset) {
      clear()
      return
    }
    if (
      range.endOffset - range.startOffset > 20_000 ||
      (value.origin === 'user' && value.coverage.some((mark) => mark !== 1))
    ) {
      value.phase = 'invalid'
      value.error =
        value.error ??
        'This selection includes text that cannot be quoted. Select original text only.'
      publish()
      return
    }
    work.current?.abort()
    const controller = new AbortController()
    work.current = controller
    value.phase = 'verifying'
    value.quote = ''
    publish()
    try {
      const quote = await latest.current.adapter.resolveRange(range, controller.signal)
      if (controller.signal.aborted || logical.current !== value) return
      if (quote.length !== range.endOffset - range.startOffset)
        throw new Error('The complete selection could not be verified.')
      value.quote = quote
      value.phase = 'ready'
      value.error = undefined
      paint()
      publish()
    } catch (error) {
      if (controller.signal.aborted || logical.current !== value) return
      value.phase = 'invalid'
      value.error = error instanceof Error ? error.message : 'The selection could not be verified.'
      publish()
    }
  }
  const caretAt = (x: number, y: number): number | undefined => {
    const host = hostRef.current
    if (!host) return undefined
    const caret = document.caretRangeFromPoint(x, y)
    if (!caret || !host.contains(caret.startContainer)) return undefined
    return projectionBoundaryOffset(host, caret.startContainer, caret.startOffset, 'start')
  }
  const begin = (
    anchor: number,
    focus = anchor,
    origin: 'user' | 'source' = 'user',
  ): LogicalSelection => {
    work.current?.abort()
    const value: LogicalSelection = {
      revision: ++revision.current,
      anchor,
      focus,
      origin,
      phase: 'dragging',
      quote: '',
      coverageStart: Math.min(anchor, focus),
      coverage: new Uint8Array(0),
    }
    logical.current = value
    coverage()
    return value
  }
  const actions = useRef({ clear, coverage, paint, publish, verify, caretAt, begin })
  useLayoutEffect(() => {
    actions.current = { clear, coverage, paint, publish, verify, caretAt, begin }
  })
  useLayoutEffect(() => {
    coverage()
    paint()
    publish()
    // A commit redraws the mounted intersection, never the original scroll destination.
  }, [adapter.windowRevision])
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let frame: number | undefined
    let dragging = false
    let dragged = false
    let moving = false
    let point = { x: 0, y: 0 }
    let movement: AbortController | undefined
    const tick = (): void => {
      frame = undefined
      if (!dragging) return
      const value = logical.current
      const root = latest.current.adapter.viewport.current
      if (!value || !root) return
      const rect = root.getBoundingClientRect()
      const focus = actions.current.caretAt(
        Math.max(rect.left + 8, Math.min(point.x, rect.right - 8)),
        Math.max(rect.top + 4, Math.min(point.y, rect.bottom - 4)),
      )
      if (focus !== undefined) {
        value.focus = focus
        actions.current.coverage()
        actions.current.paint()
      }
      const direction =
        point.y < rect.top + 32 ? 'previous' : point.y > rect.bottom - 32 ? 'next' : undefined
      if (direction) {
        latest.current.adapter.scrollViewport(root.scrollTop + (direction === 'next' ? 12 : -12))
        const atEdge =
          direction === 'next'
            ? root.scrollHeight - root.scrollTop - root.clientHeight < 40
            : root.scrollTop < 40
        if (atEdge && !moving) {
          const spans = [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')]
          const edge = direction === 'next' ? spans.at(-1) : spans[0]
          if (edge) {
            value.focus = Number(
              direction === 'next'
                ? edge.dataset.pactProjectionEnd
                : edge.dataset.pactProjectionStart,
            )
            actions.current.coverage()
            actions.current.paint()
          }
          moving = true
          movement = new AbortController()
          void latest.current.adapter
            .moveViewport(direction, movement.signal)
            .catch(() => {
              if (movement?.signal.aborted || logical.current !== value) return
              dragging = false
              if (frame !== undefined) cancelAnimationFrame(frame)
              frame = undefined
              value.phase = 'invalid'
              value.movementFailed = true
              value.error = 'Document loading failed. Retry loading, then select the text again.'
              actions.current.publish()
            })
            .finally(() => {
              moving = false
            })
        }
        frame = requestAnimationFrame(tick)
      }
    }
    const down = (event: PointerEvent): void => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest('button,a,input,textarea,select')
      )
        return
      const offset = actions.current.caretAt(event.clientX, event.clientY)
      if (offset === undefined) return
      event.preventDefault()
      actions.current.begin(offset)
      dragging = true
      dragged = false
      point = { x: event.clientX, y: event.clientY }
      host.focus({ preventScroll: true })
      const caret = document.caretRangeFromPoint(event.clientX, event.clientY)
      const browser = window.getSelection()
      if (caret && browser) {
        browser.removeAllRanges()
        browser.addRange(caret)
        if (event.detail >= 2) {
          const granularity = event.detail === 2 ? 'word' : 'lineboundary'
          browser.modify('move', 'backward', granularity)
          browser.modify('extend', 'forward', granularity)
          const selected = selectedTextRange(host, browser)
          if (selected) actions.current.begin(selected.startOffset, selected.endOffset)
        }
      }
    }
    const move = (event: PointerEvent): void => {
      if (!dragging) return
      dragged = true
      point = { x: event.clientX, y: event.clientY }
      if (frame === undefined) frame = requestAnimationFrame(tick)
    }
    const up = (): void => {
      if (!dragging) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (dragged) tick()
      dragging = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      movement?.abort()
      const browser = window.getSelection()
      const selected = browser ? selectedTextRange(host, browser) : undefined
      if (logical.current?.anchor === logical.current?.focus && selected)
        actions.current.begin(selected.startOffset, selected.endOffset)
      void actions.current.verify()
    }
    const cancel = (): void => {
      dragging = false
      movement?.abort()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      actions.current.clear()
    }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !host.contains(event.target)) cancel()
    }
    const changed = (): void => {
      if (dragging || moving || !logical.current) return
      const selection = window.getSelection()
      if (
        selection?.rangeCount &&
        !host.contains(selection.getRangeAt(0).commonAncestorContainer) &&
        !isProjectionHighlightOwned()
      )
        cancel()
    }
    const copy = (event: ClipboardEvent): void => {
      const value = logical.current
      if (value?.phase !== 'ready' || value.origin !== 'user') return
      event.clipboardData?.setData('text/plain', value.quote)
      event.preventDefault()
    }
    host.addEventListener('pointerdown', down)
    host.addEventListener('copy', copy)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('selectionchange', changed)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      host.removeEventListener('pointerdown', down)
      host.removeEventListener('copy', copy)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('selectionchange', changed)
      window.removeEventListener('blur', cancel)
    }
  }, [adapter.sourceKey])
  useEffect(() => {
    const reveal = adapter.reveal
    if (!reveal) return undefined
    const controller = new AbortController()
    const value = begin(reveal.startOffset, reveal.endOffset, 'source')
    void (async () => {
      await verify()
      if (controller.signal.aborted || logical.current !== value || value.phase !== 'ready') return
      await latest.current.adapter.moveViewport(reveal.startOffset, controller.signal)
      if (controller.signal.aborted || logical.current !== value) return
      const host = hostRef.current
      const start =
        host &&
        [
          ...host.querySelectorAll<HTMLElement>(
            '[data-pact-projection-start], [data-pact-source-start]',
          ),
        ].find((span) => {
          const from = Number(span.dataset.pactProjectionStart ?? span.dataset.pactSourceStart)
          const to = Number(span.dataset.pactProjectionEnd ?? span.dataset.pactSourceEnd)
          return from <= reveal.startOffset && to > reveal.startOffset
        })
      if (!start) throw new Error('The original selection position is unavailable.')
      const text = start.firstChild
      if (!(text instanceof Text) || !text.length)
        throw new Error('The original selection position is unavailable.')
      const offset =
        start.dataset.pactProjectionStart === undefined
          ? 0
          : reveal.startOffset - Number(start.dataset.pactProjectionStart)
      const position = document.createRange()
      position.setStart(text, offset)
      position.setEnd(text, Math.min(text.length, offset + 1))
      const root = latest.current.adapter.viewport.current
      if (!root) throw new Error('The document viewport is unavailable.')
      const bounds = root.getBoundingClientRect()
      latest.current.adapter.scrollViewport(
        root.scrollTop + position.getBoundingClientRect().top - bounds.top - root.clientHeight / 2,
      )
      const located = position.getBoundingClientRect()
      if (located.bottom <= bounds.top || located.top >= bounds.bottom)
        throw new Error('The original selection position is outside the viewport.')
      paint()
      latest.current.adapter.onRevealApplied?.(reveal.id)
    })().catch((error: unknown) => {
      if (!controller.signal.aborted && logical.current === value) {
        value.phase = 'invalid'
        value.error = String(error)
        publish()
      }
    })
    return () => {
      controller.abort()
      work.current?.abort()
    }
    // A repeated source navigation has a fresh id; ordinary window commits never replay it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter.sourceKey, adapter.reveal?.id, revealRetry])
  const keyboard = async (event: React.KeyboardEvent<HTMLDivElement>): Promise<void> => {
    if (event.key === 'Escape') {
      clear()
      return
    }
    if (
      !event.shiftKey ||
      ![
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(event.key) ||
      event.target instanceof HTMLButtonElement
    )
      return
    const host = hostRef.current
    const selection = window.getSelection()
    if (!host || !selection) return
    let value = logical.current
    if (!value || value.origin === 'source') {
      if (!selection.anchorNode || !host.contains(selection.anchorNode)) return
      const anchor = projectionBoundaryOffset(
        host,
        selection.anchorNode,
        selection.anchorOffset,
        'start',
      )
      if (anchor === undefined) return
      value = begin(anchor)
    }
    event.preventDefault()
    work.current?.abort()
    const controller = new AbortController()
    work.current = controller
    value.revision = ++revision.current
    value.phase = 'dragging'
    value.quote = ''
    const active = value
    const forward = ['ArrowRight', 'ArrowDown', 'End', 'PageDown'].includes(event.key)
    const direction = forward ? 'forward' : 'backward'
    const granularity = ['Home', 'End'].includes(event.key)
      ? 'lineboundary'
      : ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)
        ? 'line'
        : event.ctrlKey || event.altKey
          ? 'word'
          : 'character'
    const placeCaret = (): boolean => {
      const span = [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')].find(
        (entry) =>
          Number(entry.dataset.pactProjectionStart) <= active.focus &&
          Number(entry.dataset.pactProjectionEnd) >= active.focus,
      )
      if (!(span?.firstChild instanceof Text)) return false
      selection.collapse(span.firstChild, active.focus - Number(span.dataset.pactProjectionStart))
      return true
    }
    const step = (): number | undefined => {
      if (!placeCaret()) return undefined
      selection.modify('move', direction, granularity)
      if (!selection.focusNode) return undefined
      return projectionBoundaryOffset(host, selection.focusNode, selection.focusOffset, 'start')
    }
    try {
      let next: number | undefined
      const root = latest.current.adapter.viewport.current
      if (root && ['PageUp', 'PageDown'].includes(event.key) && placeCaret()) {
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        const viewportRect = root.getBoundingClientRect()
        const y = Math.max(viewportRect.top + 8, Math.min(rect.top, viewportRect.bottom - 8))
        const oldTop = root.scrollTop
        latest.current.adapter.scrollViewport(
          root.scrollTop + (forward ? 1 : -1) * root.clientHeight,
        )
        if (oldTop === root.scrollTop) {
          const spans = [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')]
          const edge = forward ? spans.at(-1) : spans[0]
          if (edge) {
            active.focus = Number(
              forward ? edge.dataset.pactProjectionEnd : edge.dataset.pactProjectionStart,
            )
            coverage()
          }
          await latest.current.adapter.moveViewport(
            forward ? 'next' : 'previous',
            controller.signal,
          )
          if (controller.signal.aborted || logical.current !== active) return
        }
        next = caretAt(rect.left, y)
      } else next = step()
      if (next === undefined || next === active.focus) {
        coverage()
        await latest.current.adapter.moveViewport(forward ? 'next' : 'previous', controller.signal)
        if (controller.signal.aborted || logical.current !== active) return
        next = step()
      }
      if (next !== undefined) active.focus = next
      coverage()
      paint()
      await verify()
    } catch (error) {
      if (!controller.signal.aborted && logical.current === active) {
        active.phase = 'invalid'
        active.error = String(error)
        publish()
      }
    }
  }
  return (
    // oxlint-disable jsx-a11y/prefer-tag-over-role -- Read-only rich text retains its Markdown structure and native selection.
    <div
      ref={hostRef}
      tabIndex={0}
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      aria-label="Plan text"
      className="relative min-w-0 break-words text-body leading-relaxed text-primary outline-none"
      onKeyDown={(event) => {
        void keyboard(event)
      }}
    >
      <div data-pact-message-content>{children}</div>
      {view &&
      logical.current?.origin === 'user' &&
      view.phase === 'ready' &&
      onCreateComment &&
      messageId ? (
        <button
          ref={actionRef}
          type="button"
          className="absolute z-10 inline-flex h-8 w-32 items-center justify-center gap-1.5 rounded-control bg-surface-raised px-2.5 text-caption font-medium text-primary shadow-sm hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
          style={{ left: view.left, top: view.top }}
          aria-label="Comment on selected text"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const value = logical.current
            if (!value || value.revision !== view.revision || value.phase !== 'ready') return
            onCreateComment({ messageId, ...rangeOf(value), quote: value.quote })
            clear()
          }}
        >
          <MessageCirclePlus aria-hidden="true" className="size-4 shrink-0" /> Add comment
        </button>
      ) : null}
      {view?.phase === 'verifying' ? (
        <output className="block text-caption text-secondary">Checking selection…</output>
      ) : null}
      {view?.phase === 'invalid' && view.error ? (
        <div className="text-caption text-secondary">
          <output className="block">{view.error}</output>
          {!logical.current?.movementFailed ? (
            <button
              type="button"
              className="mt-2 underline"
              onClick={() => {
                if (logical.current?.origin === 'source') setRevealRetry((value) => value + 1)
                else void verify()
              }}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// oxlint-enable jsx-a11y/prefer-tag-over-role

/** One Comment-selection interaction for normal Markdown Messages. */
function NativeMessageSelectionSurface({
  children,
  messageId,
  onCreateComment,
}: MessageSelectionSurfaceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const cancelPendingSelectionCaptureRef = useRef<(() => void) | undefined>(undefined)
  const [selection, setSelection] = useState<
    | {
        startOffset: number
        endOffset: number
        quote: string
        left: number
        top: number
      }
    | undefined
  >()

  const captureSelection = (): void => {
    if (!hostRef.current || !messageId || !onCreateComment) return
    const browserSelection = window.getSelection()
    if (!browserSelection || browserSelection.rangeCount !== 1) {
      setSelection(undefined)
      return
    }
    const selected = selectedTextRange(hostRef.current, browserSelection)
    if (!selected) {
      setSelection(undefined)
      return
    }
    const range = browserSelection.getRangeAt(0)
    const rects = [...range.getClientRects()]
    const rect = rects.at(-1) ?? range.getBoundingClientRect()
    const hostRect = hostRef.current.getBoundingClientRect()
    const actionWidth = 128
    const actionHeight = 32
    const gap = 8
    const centeredLeft = rect.left - hostRect.left + rect.width / 2 - actionWidth / 2
    const preferredTop = rect.top - hostRect.top - actionHeight - gap
    setSelection({
      ...selected,
      left: Math.max(gap, Math.min(centeredLeft, hostRef.current.clientWidth - actionWidth - gap)),
      top: preferredTop >= 0 ? preferredTop : rect.bottom - hostRect.top + gap,
    })
  }

  const beginSelectionCapture = (target: EventTarget | null, button: number): void => {
    if (button !== 0 || (target instanceof Node && actionRef.current?.contains(target))) return
    cancelPendingSelectionCaptureRef.current?.()
    const finish = (): void => {
      cancel()
      captureSelection()
    }
    const cancel = (): void => {
      document.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', cancel)
      if (cancelPendingSelectionCaptureRef.current === cancel) {
        cancelPendingSelectionCaptureRef.current = undefined
      }
    }
    cancelPendingSelectionCaptureRef.current = cancel
    document.addEventListener('mouseup', finish, { once: true })
    window.addEventListener('blur', cancel, { once: true })
  }

  useEffect(
    () => () => {
      cancelPendingSelectionCaptureRef.current?.()
    },
    [],
  )

  useEffect(() => {
    if (!selection) return undefined
    const dismiss = (): void => setSelection(undefined)
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && actionRef.current?.contains(target)) return
      dismiss()
    }
    const handleSelectionChange = (): void => {
      const browserSelection = window.getSelection()
      if (!browserSelection || browserSelection.rangeCount !== 1 || browserSelection.isCollapsed) {
        dismiss()
        return
      }
      const host = hostRef.current
      if (!host?.contains(browserSelection.getRangeAt(0).commonAncestorContainer)) dismiss()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', dismiss)
    }
  }, [selection])

  return (
    // Text selection only offers the action; saving still requires an explicit click.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={hostRef}
      className="relative min-w-0 break-words text-body leading-relaxed text-primary"
      onMouseDown={(event) => beginSelectionCapture(event.target, event.button)}
      onKeyUp={captureSelection}
    >
      <div data-pact-message-content>{children}</div>
      {selection && messageId && onCreateComment ? (
        <button
          ref={actionRef}
          className="absolute z-10 inline-flex h-8 w-32 items-center justify-center gap-1.5 whitespace-nowrap rounded-control bg-surface-inverse px-2.5 text-caption font-medium text-inverse shadow-popover transition-[filter] duration-150 ease-out-pact hover:brightness-95 active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          style={{ left: selection.left, top: selection.top }}
          aria-label="Comment on selected text"
          title="Comment on selected text"
          onMouseDown={(event) => event.preventDefault()}
          onMouseUp={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={() => {
            onCreateComment({
              messageId,
              startOffset: selection.startOffset,
              endOffset: selection.endOffset,
              quote: selection.quote,
            })
            setSelection(undefined)
          }}
        >
          <MessageCirclePlus aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
          Add comment
        </button>
      ) : null}
    </div>
  )
}
