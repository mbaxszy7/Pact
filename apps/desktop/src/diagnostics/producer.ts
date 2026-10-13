import { randomUUID } from 'node:crypto'

import {
  diagnosticRecordSchema,
  LOG_PRODUCER_ITEMS,
  LOG_RECORD_BYTES,
  LOG_DEBUG_MS,
  type DiagnosticEvent,
  type DiagnosticIdentity,
  type DiagnosticPacket,
} from '@pact/contracts/diagnostics'

/** Credits stay occupied until actual settlement; expiry does not free a stuck transport. */
export class DiagnosticProducer {
  private readonly pending = new Map<string, number>()
  private dropped = 0
  private debugUntil = 0
  private closing = false
  private drain: (() => void) | undefined
  private closeTask: Promise<void> | undefined

  constructor(
    private readonly identity: DiagnosticIdentity,
    private readonly send: (packet: DiagnosticPacket) => void,
  ) {}

  setDebug(until: number): void {
    this.debugUntil = Math.min(until, Date.now() + LOG_DEBUG_MS)
  }

  record(event: DiagnosticEvent): void {
    if (this.closing || (event.level === 'debug' && Date.now() >= this.debugUntil)) return
    // Reserve sixteen credits for faults; never pause a business caller.
    const limit = event.level === 'error' ? LOG_PRODUCER_ITEMS : LOG_PRODUCER_ITEMS - 16
    if (this.pending.size >= limit) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1)
      return
    }
    if (this.dropped && this.pending.size < Math.min(limit, LOG_PRODUCER_ITEMS - 16) - 1) {
      const count = this.dropped
      this.dropped = 0
      this.enqueue({ operation: 'queue', phase: 'dropped', level: 'warn', count }, count)
    }
    this.enqueue(event)
  }

  private enqueue(event: DiagnosticEvent, summaryCount = 0): void {
    const parsed = diagnosticRecordSchema.safeParse({
      ...event,
      timestamp: new Date().toISOString(),
      identity: this.identity,
    })
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) + 1 > LOG_RECORD_BYTES) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + (summaryCount || 1))
      return
    }
    const id = randomUUID()
    this.pending.set(id, summaryCount)
    try {
      this.send({ type: 'diagnostic.record', id, record: parsed.data })
    } catch {
      this.settle(id, false)
      if (!summaryCount) this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1)
    }
  }

  settle(id: string, written = true): void {
    const summaryCount = this.pending.get(id)
    if (summaryCount === undefined) return
    this.pending.delete(id)
    if (!written && summaryCount)
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + summaryCount)
    if (this.pending.size === 0) this.drain?.()
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closing = true
    if (this.pending.size === 0) return (this.closeTask = Promise.resolve())
    this.closeTask = new Promise((resolve) => {
      this.drain = resolve
    })
    return this.closeTask
  }

  dispose(): void {
    this.closing = true
    this.pending.clear()
    this.drain?.()
    this.drain = undefined
  }

  diagnostics(): { pending: number; dropped: number } {
    return { pending: this.pending.size, dropped: this.dropped }
  }
}
