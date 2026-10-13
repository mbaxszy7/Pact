import { isAbsolute } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import {
  diagnosticPacketSchema,
  diagnosticEventSchema,
  LOG_RECORD_BYTES,
  LOG_WORKER_ITEMS,
  LOG_RETRY_MS,
  LOG_MAINTENANCE_MS,
  type DiagnosticPacket,
} from '@pact/contracts/diagnostics'

import { FileLog } from './file-log'

if (
  !parentPort ||
  !workerData ||
  typeof workerData.directory !== 'string' ||
  !isAbsolute(workerData.directory) ||
  !Number.isInteger(workerData.pid)
)
  throw new Error('Invalid diagnostic worker configuration.')
const port = parentPort
const file = new FileLog(workerData.directory, workerData.pid)
const queue: Extract<DiagnosticPacket, { type: 'diagnostic.record' }>[] = []
let running = false
let closing = false
let initialized = false
let retryAt = 0
let state: 'ready' | 'unavailable' | undefined
let failedCode: import('@pact/contracts/diagnostics').DiagnosticEvent['code']

function publish(next: 'ready' | 'unavailable'): void {
  if (state === next) return
  state = next
  port.postMessage({ type: 'diagnostic.state', state: next } satisfies DiagnosticPacket)
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  port.postMessage({ type: 'diagnostic.busy', busy: true } satisfies DiagnosticPacket)
  try {
    while (queue.length) {
      const packet = queue[0]!
      let written = false
      try {
        if (Date.now() < retryAt) throw new Error('Backoff')
        if (!initialized) {
          // oxlint-disable-next-line no-await-in-loop -- One serial filesystem writer.
          const incomplete = await file.initialize()
          if (incomplete) {
            // oxlint-disable-next-line no-await-in-loop -- One bounded summary, never historical body replay.
            await file.append(
              `${JSON.stringify({ ...packet.record, operation: 'app', phase: 'interrupted', level: 'warn', count: incomplete })}\n`,
            )
          }
          initialized = true
        }
        if (failedCode) {
          // oxlint-disable-next-line no-await-in-loop -- Persist only the allowlisted I/O classification after recovery.
          await file.append(
            `${JSON.stringify({ ...packet.record, identity: { ...packet.record.identity, process: 'main', pid: workerData.pid }, operation: 'app', phase: 'failed', level: 'warn', code: failedCode })}\n`,
          )
          failedCode = undefined
        }
        // oxlint-disable-next-line no-await-in-loop
        await file.append(`${JSON.stringify(packet.record)}\n`)
        written = true
        publish('ready')
      } catch (error) {
        if (Date.now() >= retryAt) {
          const candidate = diagnosticEventSchema.shape.code.safeParse(
            error instanceof Error ? (Reflect.get(error, 'code') ?? error.message) : undefined,
          )
          failedCode = candidate.success && candidate.data ? candidate.data : 'EIO'
          retryAt = Date.now() + LOG_RETRY_MS
        }
        initialized = false
        // oxlint-disable-next-line no-await-in-loop
        await file.close().catch(() => undefined)
        publish('unavailable')
      } finally {
        queue.shift()
        port.postMessage({
          type: 'diagnostic.ack',
          id: packet.id,
          written,
        } satisfies DiagnosticPacket)
      }
    }
  } finally {
    running = false
    port.postMessage({ type: 'diagnostic.busy', busy: false } satisfies DiagnosticPacket)
    if (closing) {
      await file.close().catch(() => undefined)
      port.postMessage({ type: 'diagnostic.closed' } satisfies DiagnosticPacket)
      port.close()
    }
  }
}

const maintenance = setInterval(() => {
  if (running || closing || !initialized || Date.now() < retryAt) return
  running = true
  port.postMessage({ type: 'diagnostic.busy', busy: true } satisfies DiagnosticPacket)
  void file
    .maintain()
    .catch(() => {
      initialized = false
      retryAt = Date.now() + LOG_RETRY_MS
      publish('unavailable')
    })
    .finally(() => {
      running = false
      port.postMessage({ type: 'diagnostic.busy', busy: false } satisfies DiagnosticPacket)
      void drain()
    })
}, LOG_MAINTENANCE_MS)
maintenance.unref()

port.on('message', (input: unknown) => {
  const parsed = diagnosticPacketSchema.safeParse(input)
  if (!parsed.success) return
  const packet = parsed.data
  if (packet.type === 'diagnostic.close') {
    closing = true
    clearInterval(maintenance)
    void drain()
  } else if (packet.type === 'diagnostic.record') {
    if (
      closing ||
      queue.length >= LOG_WORKER_ITEMS ||
      Buffer.byteLength(JSON.stringify(packet.record)) + 1 > LOG_RECORD_BYTES
    ) {
      port.postMessage({
        type: 'diagnostic.ack',
        id: packet.id,
        written: false,
      } satisfies DiagnosticPacket)
      return
    }
    queue.push(packet)
    void drain()
  }
})
