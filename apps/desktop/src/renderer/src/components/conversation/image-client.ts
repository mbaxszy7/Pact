import {
  IMAGE_IO_BYTES,
  IMAGE_ORIGINAL_WORK_BYTES,
  IMAGE_PREVIEW_PIXELS,
  IMAGE_PREVIEW_WORK_BYTES,
  type ConversationImage,
  type ImageWriteInput,
} from '@pact/contracts/images'

import { unwrapRpcResult } from '../../query-client'

const IMAGE_TIMEOUT_MS = 10_000
const PREVIEW_APP_BYTES = 768 * 1024 * 1024
const THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024
const THUMBNAIL_CACHE_ITEMS = 128
const thumbnailCache = new Map<
  string,
  { blob: Blob; url?: string | undefined; readers: number; expiresAt: number }
>()
let thumbnailBytes = 0
let workingBytes = 0
let activeThumbnailReads = 0
const thumbnailWaiters = new Set<() => void>()

export interface DraftImage {
  id: string
  name: string
  status: 'preparing' | 'ready' | 'failed'
  image?: ConversationImage | undefined
  error?: string | undefined
}

export interface ImageResource {
  url: string
  release(): void
}

function cancelled(signal: AbortSignal): void {
  signal.throwIfAborted()
}

/** One IPC await is cancellable even when an already delivered request must still settle. */
function wait<T>(request: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Image preparation was cancelled or took too long.'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void request.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) late?.(value)
        else resolve(value)
        return undefined
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

export function releaseDraftImage(sessionId: string, imageId: string): void {
  void window.pact
    .writeConversationImage({ type: 'release', sessionId, imageId })
    .catch(() => undefined)
}

/** File bytes are read and acknowledged in bounded segments, never one base64 string. */
export async function uploadConversationImage(
  sessionId: string,
  clientImageId: string,
  file: File,
  signal: AbortSignal,
): Promise<ConversationImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.')
  if (file.size > IMAGE_ORIGINAL_WORK_BYTES)
    throw new Error('This image needs too much memory to prepare. Choose a smaller image.')
  let imageId: string | undefined
  const write = (input: ImageWriteInput) =>
    wait(window.pact.writeConversationImage(input), signal, (reply) => {
      if (reply.ok) releaseDraftImage(sessionId, reply.value.imageId)
    }).then(unwrapRpcResult)
  try {
    const initial = await write({ type: 'begin', sessionId, clientImageId, name: file.name })
    imageId = initial.imageId
    if (initial.offset !== 0 || initial.ready)
      throw new Error('Image preparation returned an invalid source.')
    let offset = 0
    while (offset < file.size) {
      cancelled(signal)
      // File.slice holds a bounded view; arrayBuffer creates only this segment.
      const bytes = new Uint8Array(
        // oxlint-disable-next-line no-await-in-loop -- Every byte segment depends on the previous acknowledged offset.
        await wait(file.slice(offset, offset + IMAGE_IO_BYTES).arrayBuffer(), signal),
      )
      // oxlint-disable-next-line no-await-in-loop -- Segments share one cancelled/deadline owner.
      const state = await write({
        type: 'append',
        sessionId,
        imageId,
        offset,
        data: bytesToBase64(bytes),
      })
      offset += bytes.length
      if (state.imageId !== imageId || state.offset !== offset || state.ready)
        throw new Error('Image preparation did not acknowledge the complete segment.')
    }
    const sealed = await write({ type: 'seal', sessionId, imageId })
    cancelled(signal)
    if (
      !sealed.ready ||
      !sealed.image ||
      sealed.image.id !== imageId ||
      sealed.offset !== file.size
    )
      throw new Error('Image preparation did not finish. Your draft was kept.')
    return sealed.image
  } catch (error) {
    if (imageId) releaseDraftImage(sessionId, imageId)
    throw error
  }
}

function reservePreview(image: ConversationImage): () => void {
  // Include binary assembly, Blob copy, decoded pixels and thumbnail canvas. This is a
  // work admission estimate, not a promise about the browser's complete heap/RSS.
  const bytes = image.bytes * 2 + image.width * image.height * 4 + 2 * 1024 * 1024
  if (
    image.bytes > IMAGE_ORIGINAL_WORK_BYTES ||
    image.width * image.height > IMAGE_PREVIEW_PIXELS ||
    bytes > IMAGE_PREVIEW_WORK_BYTES ||
    workingBytes + bytes > PREVIEW_APP_BYTES
  )
    throw new Error(
      'This image needs too much memory to preview. Close another preview and try again.',
    )
  workingBytes += bytes
  let released = false
  return () => {
    if (released) return
    released = true
    workingBytes -= bytes
  }
}

async function readOriginal(
  sessionId: string,
  image: ConversationImage,
  signal: AbortSignal,
): Promise<Blob> {
  const bytes = new Uint8Array(image.bytes)
  let offset = 0
  while (offset < bytes.length) {
    cancelled(signal)
    const part = unwrapRpcResult(
      // oxlint-disable-next-line no-await-in-loop -- The validated source supplies the next binary offset.
      await wait(
        window.pact.readConversationImage({
          sessionId,
          imageId: image.id,
          offset,
          variant: 'original',
        }),
        signal,
      ),
    )
    const binary = atob(part.data)
    if (
      part.imageId !== image.id ||
      part.offset !== offset ||
      part.totalBytes !== image.bytes ||
      part.mediaType !== image.mediaType ||
      binary.length > IMAGE_IO_BYTES ||
      part.nextOffset !== offset + binary.length ||
      !binary.length ||
      part.nextOffset > bytes.length ||
      part.hasMore !== part.nextOffset < bytes.length
    )
      throw new Error('The saved image could not be read completely. Try again.')
    for (let index = 0; index < binary.length; index += 1)
      bytes[offset + index] = binary.charCodeAt(index)
    offset = part.nextOffset
  }
  cancelled(signal)
  return new Blob([bytes], { type: image.mediaType })
}

function deadlineSignal(signal: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const owner = new AbortController()
  const abort = () => owner.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) owner.abort()
  const timer = window.setTimeout(abort, IMAGE_TIMEOUT_MS)
  return {
    signal: owner.signal,
    dispose: () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    },
  }
}

export async function loadOriginalImage(
  sessionId: string,
  image: ConversationImage,
  signal: AbortSignal,
): Promise<ImageResource> {
  const release = reservePreview(image)
  const owner = deadlineSignal(signal)
  try {
    const blob = await readOriginal(sessionId, image, owner.signal)
    const url = URL.createObjectURL(blob)
    return {
      url,
      release: () => {
        URL.revokeObjectURL(url)
        release()
      },
    }
  } catch (error) {
    release()
    throw error
  } finally {
    owner.dispose()
  }
}

function acquireThumbnail(key: string): ImageResource | undefined {
  const entry = thumbnailCache.get(key)
  if (!entry) return undefined
  if (!entry.readers && entry.expiresAt < Date.now()) {
    thumbnailCache.delete(key)
    thumbnailBytes -= entry.blob.size
    return undefined
  }
  entry.expiresAt = Date.now() + 5 * 60_000
  // Map insertion order is the LRU order. URLs exist only while mounted readers own them.
  thumbnailCache.delete(key)
  thumbnailCache.set(key, entry)
  entry.readers += 1
  entry.url ??= URL.createObjectURL(entry.blob)
  let released = false
  return {
    url: entry.url,
    release: () => {
      if (released) return
      released = true
      entry.readers -= 1
      if (!entry.readers && entry.url) {
        URL.revokeObjectURL(entry.url)
        entry.url = undefined
      }
    },
  }
}

async function thumbnailSlot(signal: AbortSignal): Promise<() => void> {
  // oxlint-disable-next-line no-unmodified-loop-condition -- Other readers release this module-owned semaphore across the awaited capacity signal.
  while (activeThumbnailReads >= 4) {
    if (thumbnailWaiters.size >= 64) throw new Error('Preview is busy. Click to retry.')
    // oxlint-disable-next-line no-await-in-loop -- Capacity is granted only after another bounded read settles.
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener('abort', abort)
        thumbnailWaiters.delete(resume)
        resolve()
      }
      const abort = () => {
        thumbnailWaiters.delete(resume)
        reject(new Error('Image preview was cancelled.'))
      }
      thumbnailWaiters.add(resume)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  cancelled(signal)
  activeThumbnailReads += 1
  return () => {
    activeThumbnailReads -= 1
    thumbnailWaiters.values().next().value?.()
  }
}

/** Utility owns thumbnail decoding; Renderer reads only the bounded derived image. */
export async function loadImageThumbnail(
  sessionId: string,
  image: ConversationImage,
  signal: AbortSignal,
): Promise<ImageResource> {
  const key = `${sessionId}:${image.id}:${image.sha256}`
  const cached = acquireThumbnail(key)
  if (cached) return cached
  const owner = deadlineSignal(signal)
  let releaseSlot: (() => void) | undefined
  try {
    releaseSlot = await thumbnailSlot(owner.signal)
    const first = unwrapRpcResult(
      await wait(
        window.pact.readConversationImage({
          sessionId,
          imageId: image.id,
          offset: 0,
          variant: 'thumbnail',
        }),
        owner.signal,
      ),
    )
    if (first.totalBytes <= 0 || first.totalBytes > 2 * 1024 * 1024)
      throw new Error('Image thumbnail could not be prepared.')
    const bytes = new Uint8Array(first.totalBytes)
    let part = first,
      offset = 0
    while (true) {
      const binary = atob(part.data)
      if (
        part.imageId !== image.id ||
        part.offset !== offset ||
        !binary.length ||
        binary.length > IMAGE_IO_BYTES ||
        part.totalBytes !== bytes.length ||
        part.mediaType !== first.mediaType ||
        part.nextOffset !== offset + binary.length ||
        part.nextOffset > bytes.length ||
        part.hasMore !== part.nextOffset < bytes.length
      )
        throw new Error('Image thumbnail could not be read. Click to retry.')
      for (let index = 0; index < binary.length; index += 1)
        bytes[offset + index] = binary.charCodeAt(index)
      offset = part.nextOffset
      if (!part.hasMore) break
      part = unwrapRpcResult(
        // oxlint-disable-next-line no-await-in-loop -- Thumbnail segments are ordered under one ten-second read owner.
        await wait(
          window.pact.readConversationImage({
            sessionId,
            imageId: image.id,
            offset,
            variant: 'thumbnail',
          }),
          owner.signal,
        ),
      )
    }
    cancelled(owner.signal)
    const raced = acquireThumbnail(key)
    if (raced) return raced
    const thumbnail = new Blob([bytes], { type: first.mediaType })
    while (
      thumbnailCache.size >= THUMBNAIL_CACHE_ITEMS ||
      thumbnailBytes + thumbnail.size > THUMBNAIL_CACHE_BYTES
    ) {
      const oldest = [...thumbnailCache.entries()].find(([, value]) => value.readers === 0)
      if (!oldest) throw new Error('Preview is busy. Close another preview and try again.')
      thumbnailCache.delete(oldest[0])
      thumbnailBytes -= oldest[1].blob.size
    }
    thumbnailCache.set(key, { blob: thumbnail, readers: 0, expiresAt: Date.now() + 5 * 60_000 })
    thumbnailBytes += thumbnail.size
    return acquireThumbnail(key)!
  } finally {
    owner.dispose()
    releaseSlot?.()
  }
}
