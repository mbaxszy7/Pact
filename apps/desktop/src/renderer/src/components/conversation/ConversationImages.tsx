import { ChevronLeft, ChevronRight, Image as ImageIcon, RotateCcw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ConversationImage } from '@pact/contracts/images'

import { loadImageThumbnail, type DraftImage, type ImageResource } from './image-client'

export function useImageThumbnail(
  sessionId: string,
  image: ConversationImage | undefined,
): {
  url?: string | undefined
  error?: string | undefined
  retry(): void
} {
  const [value, setValue] = useState<{ key: string; url?: string; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const key = image ? `${sessionId}:${image.id}:${image.sha256}` : ''
  useEffect(() => {
    if (!image) return undefined
    const controller = new AbortController()
    let resource: ImageResource | undefined
    void loadImageThumbnail(sessionId, image, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) loaded.release()
        else {
          resource = loaded
          setValue({ key, url: loaded.url })
        }
        return undefined
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setValue({
            key,
            error: error instanceof Error ? error.message : 'Preview could not load.',
          })
      },
    )
    return () => {
      controller.abort()
      resource?.release()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry is an explicit read generation even when the image identity is unchanged.
  }, [sessionId, image, key, attempt])
  return {
    url: value?.key === key ? value.url : undefined,
    error: value?.key === key ? value.error : undefined,
    retry: () => setAttempt((current) => current + 1),
  }
}

export function ImageThumbnail({
  sessionId,
  image,
  name,
  preparing = false,
  error,
  onOpen,
  onRemove,
  disabled = false,
  selected = false,
}: {
  sessionId: string
  image?: ConversationImage | undefined
  name: string
  preparing?: boolean
  error?: string | undefined
  onOpen?: (() => void) | undefined
  onRemove?: (() => void) | undefined
  disabled?: boolean
  selected?: boolean
}): React.JSX.Element {
  const thumbnail = useImageThumbnail(sessionId, image)
  const problem = error ?? thumbnail.error
  return (
    <div className="group/image relative h-full w-full min-w-0">
      <button
        type="button"
        className={`pact-image-thumbnail relative grid h-full w-full overflow-hidden rounded-control bg-surface-muted ${selected ? 'ring-2 ring-focus ring-offset-2 ring-offset-surface' : ''}`}
        aria-label={
          preparing
            ? `Preparing ${name}`
            : problem && !image
              ? `${name}: ${problem}`
              : `Preview ${name}`
        }
        aria-busy={preparing || Boolean(image && !thumbnail.url && !thumbnail.error)}
        disabled={preparing || !image}
        title={problem ?? name}
        onClick={() => {
          if (image && onOpen) onOpen()
          else if (image && thumbnail.error) thumbnail.retry()
        }}
      >
        {thumbnail.url ? (
          <img
            src={thumbnail.url}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className={`grid h-full w-full place-items-center text-tertiary ${preparing || !problem ? 'pact-image-loading' : ''}`}
          >
            {image && thumbnail.error ? (
              <RotateCcw aria-hidden="true" className="size-4" strokeWidth={1.75} />
            ) : (
              <ImageIcon aria-hidden="true" className="size-5" strokeWidth={1.75} />
            )}
          </span>
        )}
        {preparing ? (
          <span className="absolute inset-x-0 bottom-0 bg-surface-raised/95 px-1 py-1 text-[10px] font-medium text-secondary">
            Preparing…
          </span>
        ) : null}
        {error ? (
          <span className="absolute inset-x-0 bottom-0 bg-surface-raised/95 px-1 py-1 text-[10px] font-medium text-danger">
            Couldn’t add
          </span>
        ) : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="pact-image-remove absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-surface-raised text-secondary hover:text-primary disabled:opacity-40"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          onClick={onRemove}
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  )
}

interface ScrollNavState {
  overflows: boolean
  canScrollLeft: boolean
  canScrollRight: boolean
}

const EMPTY_SCROLL_NAV: ScrollNavState = {
  overflows: false,
  canScrollLeft: false,
  canScrollRight: false,
}

const SCROLL_OVERFLOW_EPSILON = 1

function readScrollNav(node: HTMLDivElement): ScrollNavState {
  const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth)
  if (maxScrollLeft <= SCROLL_OVERFLOW_EPSILON) return EMPTY_SCROLL_NAV
  return {
    overflows: true,
    canScrollLeft: node.scrollLeft > SCROLL_OVERFLOW_EPSILON,
    canScrollRight: maxScrollLeft - node.scrollLeft > SCROLL_OVERFLOW_EPSILON,
  }
}

function sameScrollNav(left: ScrollNavState, right: ScrollNavState): boolean {
  return (
    left.overflows === right.overflows &&
    left.canScrollLeft === right.canScrollLeft &&
    left.canScrollRight === right.canScrollRight
  )
}

/** Horizontal windowing keeps at most sixteen image nodes mounted per strip. */
export function ConversationImages({
  sessionId,
  images,
  onOpen,
  onRemove,
  disabled = false,
  draft = false,
}: {
  sessionId: string
  images: readonly DraftImage[]
  onOpen: (image: ConversationImage) => void
  onRemove?: ((id: string) => void) | undefined
  disabled?: boolean
  draft?: boolean
}): React.JSX.Element | null {
  const scroll = useRef<HTMLDivElement>(null)
  const [start, setStart] = useState(0)
  const [scrollNav, setScrollNav] = useState<ScrollNavState>(EMPTY_SCROLL_NAV)
  const step = draft ? 92 : 116

  useLayoutEffect(() => {
    const node = scroll.current
    if (!node || !images.length) {
      setScrollNav((prev) => (sameScrollNav(prev, EMPTY_SCROLL_NAV) ? prev : EMPTY_SCROLL_NAV))
      return undefined
    }
    const sync = () => {
      const nextNav = readScrollNav(node)
      setScrollNav((prev) => (sameScrollNav(prev, nextNav) ? prev : nextNav))
      const nextStart = Math.max(0, Math.floor(node.scrollLeft / step) - 1)
      setStart((prev) => (prev === nextStart ? prev : nextStart))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => observer.disconnect()
  }, [images.length, step])

  if (!images.length) return null
  const beginning = Math.max(0, Math.min(start, Math.max(0, images.length - 1)))
  const visible = images.slice(beginning, beginning + 16)
  const showArrows = images.length > 1 && scrollNav.overflows
  const showFooter = images.length > 3 || showArrows
  const move = (direction: number) =>
    scroll.current?.scrollBy({ left: direction * step * 3, behavior: 'smooth' })
  return (
    <div className={`min-w-0 ${draft ? 'mb-3' : 'mt-3'}`}>
      <div className="relative">
        <div
          ref={scroll}
          className="overflow-x-auto pb-1 pt-1"
          aria-label={draft ? 'Attached images' : 'Message images'}
          onScroll={(event) => {
            const node = event.currentTarget
            const nextStart = Math.max(0, Math.floor(node.scrollLeft / step) - 1)
            setStart((prev) => (prev === nextStart ? prev : nextStart))
            const nextNav = readScrollNav(node)
            setScrollNav((prev) => (sameScrollNav(prev, nextNav) ? prev : nextNav))
          }}
        >
          <div
            className="relative"
            style={{ width: Math.max(0, images.length * step - 8), height: draft ? 99 : 123 }}
          >
            {visible.map((entry, index) => (
              <div
                key={entry.id}
                className="absolute top-0"
                style={{ left: (beginning + index) * step, width: step - 8 }}
              >
                <div style={{ height: step - 8 }}>
                  <ImageThumbnail
                    sessionId={sessionId}
                    image={entry.image}
                    name={entry.name}
                    preparing={entry.status === 'preparing'}
                    error={entry.error}
                    disabled={disabled}
                    onOpen={entry.image ? () => onOpen(entry.image!) : undefined}
                    onRemove={onRemove ? () => onRemove(entry.id) : undefined}
                  />
                </div>
                <p
                  className="mt-1 truncate px-0.5 text-[11px] leading-4 text-secondary"
                  title={entry.name}
                >
                  {entry.name}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showFooter ? (
        <div className="mt-0.5 flex items-center justify-between text-caption text-secondary">
          <span>{images.length} images</span>
          {showArrows ? (
            <div className="flex gap-1">
              <button
                type="button"
                className="grid size-7 cursor-pointer place-items-center rounded-control enabled:hover:bg-surface-muted enabled:hover:text-primary disabled:cursor-default disabled:opacity-35"
                aria-label="Previous images"
                disabled={!scrollNav.canScrollLeft}
                onClick={() => move(-1)}
              >
                <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="grid size-7 cursor-pointer place-items-center rounded-control enabled:hover:bg-surface-muted enabled:hover:text-primary disabled:cursor-default disabled:opacity-35"
                aria-label="Next images"
                disabled={!scrollNav.canScrollRight}
                onClick={() => move(1)}
              >
                <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
