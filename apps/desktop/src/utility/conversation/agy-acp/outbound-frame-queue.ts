import type { Writable } from 'node:stream'

import type { NativeWorkingMemory, NativeMemoryReservation } from '../native-working-memory'
import type { OutboundFrame } from './protocol'

import { AgentExecutionError } from '../agent-execution-error'
import {
  NATIVE_FRAME_WRITE_CHUNK_BYTES,
  NativeFrameWriteError,
  writeNativeFrame,
} from '../native-frame-writer'
import { encodeNativeJsonFrame, freezeNativeJsonFrame } from '../native-json-encoder'
import {
  AGY_FRAME_WORKSPACE_BYTES,
  AGY_INLINE_ENCODING_MEMORY_BYTES,
  AGY_OUTBOUND_DRAIN_TIMEOUT_MS,
  AGY_QUEUE_MESSAGE_LIMIT,
  tagRequestFailure,
} from './protocol'

export interface AgyOutboundQueueHost {
  readonly stdin: Writable
  readonly memory: NativeWorkingMemory
  isOpen(): boolean
  isClosed(): boolean
  isLifetimeCurrent(): boolean
  getUnavailableError(): Error
  isRequestActiveForWrite(requestId: number): boolean
  getRequestSignal(requestId: number): AbortSignal | undefined
  onFinishRequestWrite(requestId: number | undefined): void
  onObservePhysicalOperation?(
    signal: AbortSignal | undefined,
    physicalCompletion: Promise<unknown>,
  ): void
  onPossiblyWrittenWriteFailure(error: Error): void
  onIdleCheck(): void
}

/**
 * Exclusive bounded FIFO writer for Antigravity ACP stdin frames.
 * Owns outbound frame reservations, 10s whole-frame expiration, abort-before-write
 * cancellation, and write-task joining on connection close.
 */
export class AgyOutboundFrameQueue {
  private readonly queue: Array<OutboundFrame | undefined> = []
  private head = 0
  private writing = false
  private activeFrame: OutboundFrame | undefined
  private queuedBytes = 0
  private writeTask: Promise<void> | undefined

  constructor(private readonly host: AgyOutboundQueueHost) {}

  get hasPendingWork(): boolean {
    return this.writing || this.queue.length > this.head
  }

  get queuedFrameCount(): number {
    return this.queue.length - this.head
  }

  get queuedOutboundBytes(): number {
    return this.queuedBytes
  }

  get currentWriteTask(): Promise<void> | undefined {
    return this.writeTask
  }

  enqueue(
    message: object,
    options: {
      requestId?: number | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
      cancelBeforeWriteSignal?: AbortSignal | undefined
    },
  ): Promise<void> {
    if (!this.host.isOpen()) {
      this.host.onFinishRequestWrite(options.requestId)
      return Promise.reject(this.host.getUnavailableError())
    }
    let heldBytes: number
    let bytes: Buffer | undefined
    let reservation: NativeMemoryReservation
    try {
      heldBytes = freezeNativeJsonFrame(message)
      if (heldBytes <= AGY_INLINE_ENCODING_MEMORY_BYTES) {
        bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
        heldBytes += bytes.length * 3
      }
      heldBytes += AGY_FRAME_WORKSPACE_BYTES
      reservation = this.host.memory.reserve(heldBytes)
    } catch (error) {
      this.host.onFinishRequestWrite(options.requestId)
      return Promise.reject(error)
    }
    if (this.queue.length - this.head >= AGY_QUEUE_MESSAGE_LIMIT) {
      reservation.release()
      this.host.onFinishRequestWrite(options.requestId)
      return Promise.reject(
        tagRequestFailure(
          new AgentExecutionError(
            'runtime_incompatible',
            'Native ACP request preparation capacity is full. This frame was not written.',
            false,
          ),
          'capacity',
        ),
      )
    }
    this.queuedBytes += heldBytes
    return new Promise((resolve, reject) => {
      const physical = options.requestId === undefined ? Promise.withResolvers<void>() : undefined
      if (physical) {
        this.host.onObservePhysicalOperation?.(options.cancelBeforeWriteSignal, physical.promise)
      }
      this.queue.push({
        message,
        expiresAt: Date.now() + AGY_OUTBOUND_DRAIN_TIMEOUT_MS,
        bytes,
        heldBytes,
        released: false,
        reservation,
        controller: new AbortController(),
        resolve,
        reject,
        physicalResolve: physical?.resolve,
        ...options,
      })
      this.pump()
    })
  }

  dropQueuedRequestFrame(requestId: number, error: Error): void {
    for (let index = this.head; index < this.queue.length; index += 1) {
      const frame = this.queue[index]
      if (!frame || frame.requestId !== requestId) continue
      if (frame === this.activeFrame) return
      this.queue.splice(index, 1)
      this.release(frame)
      this.host.onFinishRequestWrite(frame.requestId)
      frame.physicalResolve?.()
      frame.reject(error)
      this.host.onIdleCheck()
      return
    }
  }

  abortActive(): void {
    this.activeFrame?.controller.abort()
  }

  failAll(error: Error): void {
    this.activeFrame?.controller.abort()
    for (let index = this.head; index < this.queue.length; index += 1) {
      const frame = this.queue[index]
      if (!frame) continue
      if (frame !== this.activeFrame) {
        this.release(frame)
        this.host.onFinishRequestWrite(frame.requestId)
        frame.physicalResolve?.()
      }
      frame.reject(error)
    }
    this.queue.length = 0
    this.head = 0
    this.writing = false
  }

  private pump(): void {
    if (this.writing || this.host.isClosed()) return
    const frame = this.queue[this.head]
    if (!frame) return
    if (frame.expiresAt <= Date.now()) {
      this.finish(
        frame,
        new NativeFrameWriteError('Native ACP frame expired before writing.', false),
      )
      this.pump()
      return
    }
    if (frame.requestId !== undefined && !this.host.isRequestActiveForWrite(frame.requestId)) {
      this.finish(frame, new Error('Antigravity request expired before dispatch.'))
      this.pump()
      return
    }
    this.writing = true
    this.activeFrame = frame
    const signal =
      frame.cancelBeforeWriteSignal ??
      (frame.requestId !== undefined ? this.host.getRequestSignal(frame.requestId) : undefined)
    const writeSignal = frame.controller.signal
    const source = (physicalSignal: AbortSignal): AsyncIterable<Uint8Array> =>
      frame.bytes
        ? (async function* (): AsyncIterable<Uint8Array> {
            for (
              let offset = 0;
              offset < frame.bytes!.length;
              offset += NATIVE_FRAME_WRITE_CHUNK_BYTES
            ) {
              physicalSignal.throwIfAborted()
              yield frame.bytes!.subarray(offset, offset + NATIVE_FRAME_WRITE_CHUNK_BYTES)
            }
          })()
        : encodeNativeJsonFrame(frame.message, physicalSignal)

    const writing = writeNativeFrame(this.host.stdin, source, {
      signal: writeSignal,
      ...(signal ? { cancelBeforeWriteSignal: signal } : {}),
      onFirstWrite: () => frame.onDispatch?.(),
      canDispatch: () =>
        this.host.isOpen() &&
        this.host.isLifetimeCurrent() &&
        (frame.requestId === undefined || this.host.isRequestActiveForWrite(frame.requestId)) &&
        (frame.canDispatch?.() ?? true),
      deadlineMs: Math.max(1, frame.expiresAt - Date.now()),
    }).then(
      () => {
        this.finish(frame)
        this.pump()
        return undefined
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Native ACP frame write failed.')
        this.finish(frame, failure)
        if (error instanceof NativeFrameWriteError && error.possiblyWritten) {
          this.host.onPossiblyWrittenWriteFailure(failure)
        } else {
          this.pump()
        }
        return undefined
      },
    )
    this.writeTask = writing
  }

  private release(frame: OutboundFrame): void {
    if (frame.released) return
    frame.released = true
    this.queuedBytes -= frame.heldBytes
    frame.reservation.release()
  }

  private finish(frame: OutboundFrame, error?: Error): void {
    this.release(frame)
    this.host.onFinishRequestWrite(frame.requestId)
    frame.physicalResolve?.()
    if (this.activeFrame === frame) this.activeFrame = undefined
    if (this.queue[this.head] !== frame) return
    this.queue[this.head] = undefined
    this.head += 1
    this.writing = false
    this.compact()
    if (error) frame.reject(error)
    else frame.resolve()
    this.host.onIdleCheck()
  }

  private compact(): void {
    if (this.head < 1_024 || this.head * 2 < this.queue.length) return
    this.queue.splice(0, this.head)
    this.head = 0
  }
}
