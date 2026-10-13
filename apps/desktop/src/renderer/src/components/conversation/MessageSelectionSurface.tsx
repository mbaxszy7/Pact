import { MessageCirclePlus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { selectedTextRange } from './message-selection'

export interface MessageTextSelection {
  messageId: string
  startOffset: number
  endOffset: number
  quote: string
}

interface MessageSelectionSurfaceProps {
  children: ReactNode
  messageId?: string | undefined
  onCreateComment?: ((selection: MessageTextSelection) => void) | undefined
}

/** One Comment-selection interaction for normal Markdown Messages. */
export function MessageSelectionSurface({
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
          className="absolute z-10 inline-flex h-8 w-32 items-center justify-center gap-1.5 whitespace-nowrap rounded-control bg-surface-raised px-2.5 text-caption font-medium text-primary shadow-sm transition-colors duration-150 ease-out-pact hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
