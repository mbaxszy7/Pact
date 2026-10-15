import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ConversationImage } from '@pact/contracts/images'

import { ImageThumbnail, useImageThumbnail } from './ConversationImages'
import { loadOriginalImage, type ImageResource } from './image-client'

/** Mounted slides own their reads and URLs; a transition retains at most two slides. */
function GalleryImage({
  sessionId,
  image,
  active,
  onReady,
}: {
  sessionId: string
  image: ConversationImage
  active: boolean
  onReady: (id: string) => void
}): React.JSX.Element {
  const thumbnail = useImageThumbnail(sessionId, image)
  const [attempt, setAttempt] = useState(0)
  const [original, setOriginal] = useState<{ url?: string; error?: string }>()
  const [loadedUrl, setLoadedUrl] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    let resource: ImageResource | undefined
    void loadOriginalImage(sessionId, image, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) loaded.release()
        else {
          resource = loaded
          setOriginal({ url: loaded.url })
        }
        return undefined
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setOriginal({
            error: error instanceof Error ? error.message : 'Image could not load.',
          })
      },
    )
    return () => {
      controller.abort()
      resource?.release()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry replaces this immutable slide's owned read.
  }, [sessionId, image, attempt])
  useEffect(() => {
    if (active && (loadedUrl || original?.error)) onReady(image.id)
  }, [active, loadedUrl, original?.error, image.id, onReady])
  return (
    <>
      {original?.error ? (
        <div
          role={active ? 'alert' : undefined}
          className="max-w-sm text-center text-body text-secondary"
        >
          <p>{original.error}</p>
          <button
            type="button"
            tabIndex={active ? 0 : -1}
            className="mt-3 rounded-control bg-surface-inverse px-4 py-2 text-inverse"
            onClick={() => {
              setOriginal(undefined)
              setAttempt((value) => value + 1)
            }}
          >
            Try again
          </button>
        </div>
      ) : original?.url || thumbnail.url ? (
        <img
          src={original?.url ?? thumbnail.url}
          alt={active ? image.name : ''}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          onLoad={(event) => setLoadedUrl(event.currentTarget.src)}
        />
      ) : (
        <div className="pact-image-loading h-full max-h-[60vh] w-full rounded-control bg-surface-muted" />
      )}
      {active && !original?.url && !original?.error ? (
        <output className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-control bg-surface px-3 py-1 text-caption text-secondary">
          Loading original…
        </output>
      ) : null}
    </>
  )
}

export function ImageGallery({
  sessionId,
  images,
  initialId,
  onClose,
  suspended = false,
}: {
  sessionId: string
  images: readonly ConversationImage[]
  initialId: string
  onClose: () => void
  suspended?: boolean | undefined
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLElement | undefined>(undefined)
  const pausedFocusRef = useRef<HTMLElement | undefined>(undefined)
  const [index, setIndex] = useState(
    Math.max(
      0,
      images.findIndex((image) => image.id === initialId),
    ),
  )
  const [previousIndex, setPreviousIndex] = useState<number>()
  const [readyId, setReadyId] = useState<string>()
  const [direction, setDirection] = useState(1)
  const image = images[index]!
  const markReady = useCallback(
    (id: string): void => {
      if (id === image.id) setReadyId(id)
    },
    [image.id],
  )
  useEffect(() => {
    const element = dialog.current
    if (suspended) {
      element?.close()
      return undefined
    }
    if (!triggerRef.current && document.activeElement instanceof HTMLElement)
      triggerRef.current = document.activeElement
    element?.showModal()
    const focus = pausedFocusRef.current
    if (focus?.isConnected && element?.contains(focus)) focus.focus({ preventScroll: true })
    return () => {
      if (
        document.activeElement instanceof HTMLElement &&
        element?.contains(document.activeElement)
      )
        pausedFocusRef.current = document.activeElement
      element?.close()
    }
  }, [suspended])
  useEffect(() => {
    const focus = triggerRef
    return () => {
      const trigger = focus.current
      if (trigger?.isConnected && !trigger.closest('[inert]'))
        trigger.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (readyId !== image.id || previousIndex === undefined) return undefined
    const timer = window.setTimeout(() => setPreviousIndex(undefined), 180)
    return () => window.clearTimeout(timer)
  }, [readyId, image.id, previousIndex])
  const navigate = (next: number): void => {
    next = Math.max(0, Math.min(images.length - 1, next))
    if (next === index) return
    const focusedIndex = document.activeElement?.closest('[data-gallery-image-index]')
    const nextFilmStart = Math.max(0, Math.min(next - 4, images.length - 9))
    if (focusedIndex) {
      const focused = Number(focusedIndex.getAttribute('data-gallery-image-index'))
      if (focused < nextFilmStart || focused >= nextFilmStart + 9)
        closeButton.current?.focus({ preventScroll: true })
    }
    const outgoing = readyId === image.id ? index : previousIndex
    setPreviousIndex(outgoing === next ? undefined : outgoing)
    setReadyId(undefined)
    setDirection(next > index ? 1 : -1)
    setIndex(next)
  }
  const filmStart = Math.max(0, Math.min(index - 4, images.length - 9))
  const ready = readyId === image.id
  return createPortal(
    <dialog
      ref={dialog}
      className="pact-image-gallery bg-surface text-primary"
      aria-label="Image preview"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          navigate(index + (event.key === 'ArrowLeft' ? -1 : 1))
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium" title={image.name}>
              {image.name}
            </p>
            <p className="text-caption text-secondary" aria-live="polite" aria-atomic="true">
              {index + 1} / {images.length} <span className="mx-1.5">·</span> {image.width} ×{' '}
              {image.height}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              ref={closeButton}
              type="button"
              className="pact-image-control ml-1"
              aria-label="Close image preview"
              title="Close (Esc)"
              autoFocus
              onClick={onClose}
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </header>
        <div className="relative min-h-0 flex-1 bg-canvas">
          {[...(previousIndex === undefined ? [] : [previousIndex]), index].map((slideIndex) => {
            const active = slideIndex === index
            return (
              <div
                key={images[slideIndex]!.id}
                className="pact-image-slide absolute inset-0 flex items-center justify-center p-12"
                aria-hidden={!active}
                inert={!active}
                data-visible={active ? ready : !ready}
                data-direction={active ? direction : -direction}
              >
                <GalleryImage
                  sessionId={sessionId}
                  image={images[slideIndex]!}
                  active={active}
                  onReady={markReady}
                />
              </div>
            )
          })}
          {images.length > 1 ? (
            <>
              <button
                type="button"
                className="pact-image-control absolute left-3 top-1/2 -translate-y-1/2 bg-surface-raised"
                aria-label="Previous image"
                disabled={index === 0}
                onClick={() => navigate(index - 1)}
              >
                <ChevronLeft className="size-5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="pact-image-control absolute right-3 top-1/2 -translate-y-1/2 bg-surface-raised"
                aria-label="Next image"
                disabled={index === images.length - 1}
                onClick={() => navigate(index + 1)}
              >
                <ChevronRight className="size-5" strokeWidth={1.75} />
              </button>
            </>
          ) : null}
        </div>
        {images.length > 1 ? (
          <footer
            className="flex shrink-0 justify-center gap-2 overflow-x-auto border-t border-border px-4 py-3"
            aria-label="Image filmstrip"
          >
            {images.slice(filmStart, filmStart + 9).map((entry, offset) => (
              <div
                key={entry.id}
                data-gallery-image-index={filmStart + offset}
                className="size-12 shrink-0"
              >
                <ImageThumbnail
                  sessionId={sessionId}
                  image={entry}
                  name={entry.name}
                  selected={filmStart + offset === index}
                  onOpen={() => navigate(filmStart + offset)}
                />
              </div>
            ))}
          </footer>
        ) : null}
      </div>
    </dialog>,
    document.body,
  )
}
