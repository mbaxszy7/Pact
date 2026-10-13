import type { ConversationPatch, NormalizedAgentEvent } from '@pact/contracts'

import {
  CONVERSATION_STREAM_BATCH_BYTES,
  CONVERSATION_STREAM_BATCH_ITEMS,
  normalizedAgentEventSchema,
  conversationStreamDeltaKey,
} from '@pact/contracts'

type StreamDeltaEvent = Extract<
  NormalizedAgentEvent,
  { type: 'text.delta' | 'reasoning.summary.delta' }
>

export const DURABLE_STREAM_INTERVAL_MS = 250
export const VISIBLE_STREAM_INTERVAL_MS = 75

interface PendingDelta {
  event: StreamDeltaEvent
  bytes: number
  metadataBytes: number
}

export class StreamBufferLimitError extends Error {}

/** One Run's committed-only stream, with independent checkpoint/publication clocks. */
export class AgentStreamBuffer {
  private readonly pending = new Map<string, PendingDelta>()
  private readonly committed: { patch: ConversationPatch; bytes: number }[] = []
  private pendingBytes = 0
  private committedBytes = 0
  private durableTimer: ReturnType<typeof setTimeout> | undefined
  private visibleTimer: ReturnType<typeof setTimeout> | undefined
  private failed = false
  private closed = false
  private periodicCommits = 0
  private capacityCommits = 0
  private forcedCommits = 0

  constructor(
    private readonly commit: (events: readonly StreamDeltaEvent[]) => ConversationPatch,
    private readonly publish: (patch: ConversationPatch) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(event: StreamDeltaEvent): void {
    if (this.closed || this.failed) return
    if (!normalizedAgentEventSchema.safeParse(event).success) {
      if (!this.flush()) return
      this.fail(new Error('The Agent supplied invalid Delta metadata.'))
      return
    }
    // Large Native facts cross the existing stream budget as ordered small segments.
    for (let offset = 0; offset < event.text.length;) {
      let end = Math.min(event.text.length, offset + 8192)
      if (
        end < event.text.length &&
        event.text.charCodeAt(end - 1) >= 0xd800 &&
        event.text.charCodeAt(end - 1) <= 0xdbff &&
        event.text.charCodeAt(end) >= 0xdc00 &&
        event.text.charCodeAt(end) <= 0xdfff
      )
        end -= 1
      this.pushPart({ ...event, text: event.text.slice(offset, end) })
      if (this.closed || this.failed) return
      offset = end
    }
    if (!event.text.length) this.pushPart(event)
  }

  private pushPart(event: StreamDeltaEvent): void {
    const key = conversationStreamDeltaKey(event)
    const metadataBytes = Buffer.byteLength(JSON.stringify({ ...event, text: '' }), 'utf8')
    const textBytes = Buffer.byteLength(JSON.stringify(event.text), 'utf8') - 2
    const bytes = metadataBytes + textBytes
    if (bytes + 2 > CONVERSATION_STREAM_BATCH_BYTES) {
      if (!this.flush()) return
      this.fail(new StreamBufferLimitError('Agent Delta exceeds the bounded stream buffer.'))
      return
    }
    const previous = this.pending.get(key)
    const nextBytes =
      (previous?.bytes ?? 0) + textBytes + metadataBytes - (previous?.metadataBytes ?? 0)
    // JSON array framing costs one comma per existing key plus two brackets.
    if (
      (!previous && this.pending.size === CONVERSATION_STREAM_BATCH_ITEMS) ||
      this.pendingBytes -
        (previous?.bytes ?? 0) +
        nextBytes +
        this.pending.size +
        (previous ? 1 : 2) >
        CONVERSATION_STREAM_BATCH_BYTES
    ) {
      if (!this.checkpoint('capacity')) return
    }
    const current = this.pending.get(key)
    const combinedBytes =
      (current?.bytes ?? 0) + textBytes + metadataBytes - (current?.metadataBytes ?? 0)
    this.pendingBytes += combinedBytes - (current?.bytes ?? 0)
    this.pending.set(key, {
      event: current ? { ...event, text: current.event.text + event.text } : event,
      bytes: combinedBytes,
      metadataBytes,
    })
    // Never extend a checkpoint indefinitely when more Deltas arrive.
    this.durableTimer ??= setTimeout(() => {
      this.durableTimer = undefined
      this.checkpoint('periodic')
    }, DURABLE_STREAM_INTERVAL_MS)
  }

  flush(): boolean {
    if (!this.checkpoint('forced')) return false
    this.publishPending()
    return !this.failed
  }

  publishPending(): void {
    clearTimeout(this.visibleTimer)
    this.visibleTimer = undefined
    while (this.committed.length) {
      const entry = this.committed.shift()!
      this.committedBytes -= entry.bytes
      try {
        this.publish(entry.patch)
      } catch (error) {
        this.fail(error)
        return
      }
    }
  }

  dispose(): boolean {
    if (this.closed) return !this.failed
    const flushed = this.flush()
    this.closed = true
    this.clearDurableTimer()
    clearTimeout(this.visibleTimer)
    this.visibleTimer = undefined
    this.pending.clear()
    this.pendingBytes = 0
    this.committed.length = 0
    this.committedBytes = 0
    return flushed
  }

  diagnostics() {
    return {
      pendingItems: this.pending.size,
      pendingBytes: this.pending.size ? this.pendingBytes + this.pending.size + 1 : 0,
      publicationItems: this.committed.length,
      publicationBytes: this.committedBytes,
      timers: Number(this.durableTimer !== undefined) + Number(this.visibleTimer !== undefined),
      periodicCommits: this.periodicCommits,
      capacityCommits: this.capacityCommits,
      forcedCommits: this.forcedCommits,
    }
  }

  private checkpoint(reason: 'periodic' | 'capacity' | 'forced'): boolean {
    this.clearDurableTimer()
    if (this.failed) return false
    if (this.pending.size === 0) return true
    try {
      const patch = this.commit([...this.pending.values()].map((entry) => entry.event))
      // The callback returns only after its real transaction has committed.
      const bytes = Buffer.byteLength(JSON.stringify(patch), 'utf8')
      this.pending.clear()
      this.pendingBytes = 0
      if (reason === 'periodic') this.periodicCommits += 1
      else if (reason === 'capacity') this.capacityCommits += 1
      else this.forcedCommits += 1
      if (
        this.committed.length === CONVERSATION_STREAM_BATCH_ITEMS ||
        this.committedBytes + bytes > CONVERSATION_STREAM_BATCH_BYTES
      )
        this.publishPending()
      if (this.failed) return false
      this.committed.push({ patch, bytes })
      this.committedBytes += bytes
      this.visibleTimer ??= setTimeout(() => this.publishPending(), VISIBLE_STREAM_INTERVAL_MS)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.clearDurableTimer()
    clearTimeout(this.visibleTimer)
    this.visibleTimer = undefined
    this.onError(error)
  }

  private clearDurableTimer(): void {
    clearTimeout(this.durableTimer)
    this.durableTimer = undefined
  }
}
