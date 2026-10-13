import {
  diagnosticIdentitySchema,
  diagnosticPacketSchema,
  type DiagnosticEvent,
} from '@pact/contracts/diagnostics'

import { DiagnosticProducer } from './producer'

const port = process.parentPort
let producer: DiagnosticProducer | undefined
if (port && process.argv[6]) {
  try {
    const identity = diagnosticIdentitySchema.parse({
      ...JSON.parse(process.argv[6]),
      process: 'utility',
      pid: process.pid,
    })
    producer = new DiagnosticProducer(identity, (packet) => port.postMessage(packet))
  } catch {
    /* Diagnostics are optional and never prevent Utility bootstrap. */
  }
}

export function recordDiagnostic(event: DiagnosticEvent): void {
  producer?.record(event)
}

export function receiveDiagnostic(input: unknown): boolean {
  const parsed = diagnosticPacketSchema.safeParse(input)
  if (!parsed.success) return false
  if (parsed.data.type === 'diagnostic.ack') producer?.settle(parsed.data.id, parsed.data.written)
  else if (parsed.data.type === 'diagnostic.debug') producer?.setDebug(parsed.data.until)
  return true
}

// ParentPort preserves record-before-shutdown-reply order. Main owns the only
// filesystem drain deadline; Utility must not add a second two-second wait.
export function closeDiagnostics(): void {
  recordDiagnostic({ operation: 'utility', phase: 'closed' })
  producer?.dispose()
}

port?.on('message', (event) => {
  receiveDiagnostic(event.data)
})
