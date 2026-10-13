import type { Writable } from 'node:stream'

import { AgentExecutionError } from './agent-execution-error'

export const NATIVE_FRAME_WRITE_CHUNK_BYTES = 64 * 1024
export const NATIVE_FRAME_WRITE_DEADLINE_MS = 10_000

/** The owner closes its transport after a partially written frame; another RPC cannot follow it. */
export class NativeFrameWriteError extends AgentExecutionError {
  constructor(
    message: string,
    readonly possiblyWritten: boolean,
  ) {
    super(possiblyWritten ? 'transient_transport' : 'protocol_error', message, possiblyWritten)
  }
}

interface NativeFrameWriteOptions {
  signal?: AbortSignal
  cancelBeforeWriteSignal?: AbortSignal
  onFirstWrite: () => void
  canDispatch?: () => boolean
  deadlineMs?: number
}

/**
 * Writes one already encoded JSONL frame without interleaving or retaining its complete bytes.
 * The Connection owns serialization, admission, the source and the exclusive writer slot.
 * At most one <=64 KiB chunk and one pipe drain are pending. The deadline covers the whole frame.
 * User cancellation after the first write settles the request, while this physical frame finishes.
 * Only connection shutdown or the absolute write deadline interrupts an already started frame.
 */
export async function writeNativeFrame(
  sink: Writable,
  createSource: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  options: NativeFrameWriteOptions,
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? NATIVE_FRAME_WRITE_DEADLINE_MS
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new NativeFrameWriteError('The native frame deadline is invalid.', false)
  if (options.signal?.aborted || options.cancelBeforeWriteSignal?.aborted)
    throw new NativeFrameWriteError('The native frame was cancelled before writing.', false)

  const controller = new AbortController()
  let attemptedWrite = false
  let dispatching = false
  let lastByte: number | undefined
  let failure: NativeFrameWriteError | undefined
  const stop = (message: string): void => {
    failure ??= new NativeFrameWriteError(message, attemptedWrite)
    controller.abort()
  }
  const expired = setTimeout(
    () => stop('The native frame did not finish before its deadline.'),
    deadlineMs,
  )
  const aborted = (): void => stop('The native frame transport was closed.')
  const cancelBeforeWrite = (): void => {
    if (!attemptedWrite && !dispatching) stop('The native frame was cancelled before writing.')
  }
  const failed = (): void => stop('The native input pipe failed while writing a frame.')
  const closed = (): void => stop('The native input pipe closed while writing a frame.')
  options.signal?.addEventListener('abort', aborted, { once: true })
  options.cancelBeforeWriteSignal?.addEventListener('abort', cancelBeforeWrite, { once: true })
  sink.on('error', failed)
  sink.on('close', closed)

  const wait = async <T>(task: Promise<T>): Promise<T> => {
    if (failure) throw failure
    return new Promise<T>((resolve, reject) => {
      const interrupted = (): void => {
        cleanup()
        reject(
          failure ?? new NativeFrameWriteError('The native frame was interrupted.', attemptedWrite),
        )
      }
      const cleanup = (): void => controller.signal.removeEventListener('abort', interrupted)
      controller.signal.addEventListener('abort', interrupted, { once: true })
      if (controller.signal.aborted) interrupted()
      void task.then(
        (value) => {
          cleanup()
          if (failure) reject(failure)
          else resolve(value)
          return undefined
        },
        (error: unknown) => {
          cleanup()
          reject(error)
          return undefined
        },
      )
    })
  }
  let iterator: AsyncIterator<Uint8Array> | undefined
  let writeFailure: NativeFrameWriteError | undefined
  try {
    // Only our controlled Buffer/encoder factories cross this seam. The same signal
    // cancels source advancement when a physical write expires or the pipe closes.
    iterator = createSource(controller.signal)[Symbol.asyncIterator]()
    for (;;) {
      // One frame is ordered: advancing its source before drain would defeat pipe backpressure.
      // oxlint-disable-next-line no-await-in-loop
      const next = await wait(iterator.next())
      if (next.done) break
      const chunk = next.value
      if (chunk.byteLength > NATIVE_FRAME_WRITE_CHUNK_BYTES)
        throw new NativeFrameWriteError(
          'The native frame source exceeded its processing chunk.',
          attemptedWrite,
        )
      if (chunk.byteLength === 0) continue
      if (failure) throw failure
      if (!attemptedWrite) {
        if (options.canDispatch && !options.canDispatch())
          throw new NativeFrameWriteError('The native frame owner changed before writing.', false)
        if (sink.destroyed || sink.writableEnded)
          throw new NativeFrameWriteError('The native input pipe is unavailable.', false)
        // Commit possible delivery before calling the actual write; a write error is not a rejection ACK.
        // A cancellation triggered by this callback must not interrupt the frame, but a failed
        // durable callback still proves that no byte reached the pipe.
        dispatching = true
        try {
          options.onFirstWrite()
        } finally {
          dispatching = false
        }
        if (failure) throw failure
        attemptedWrite = true
      }
      lastByte = chunk.at(-1)
      let drained: (() => void) | undefined
      let drainWait: Promise<void> | undefined
      try {
        drainWait = new Promise<void>((resolve) => {
          drained = resolve
          sink.once('drain', drained)
        })
        if (!sink.write(chunk)) {
          // oxlint-disable-next-line no-await-in-loop -- The current frame retains the exclusive writer.
          await wait(drainWait)
        }
      } finally {
        if (drained) sink.off('drain', drained)
      }
    }
    if (!attemptedWrite || lastByte !== 0x0a)
      throw new NativeFrameWriteError(
        'The native frame did not contain a complete JSONL terminator.',
        attemptedWrite,
      )
  } catch (error) {
    writeFailure =
      error instanceof NativeFrameWriteError
        ? error
        : new NativeFrameWriteError('The native frame source or input pipe failed.', attemptedWrite)
  } finally {
    controller.abort()
    options.signal?.removeEventListener('abort', aborted)
    options.cancelBeforeWriteSignal?.removeEventListener('abort', cancelBeforeWrite)
    sink.off('error', failed)
    sink.off('close', closed)
    // Physical source cleanup belongs to the source owner even after logical cancellation.
    // The Connection must not reuse the writer while its source still has owned I/O pending.
    try {
      await iterator?.return?.()
    } catch {
      writeFailure ??= new NativeFrameWriteError(
        'The native frame source did not release its resources.',
        attemptedWrite,
      )
    }
    clearTimeout(expired)
  }
  if (writeFailure) throw writeFailure
}
