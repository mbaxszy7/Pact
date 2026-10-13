import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LOG_DEBUG_MS,
  LOG_PRODUCER_ITEMS,
  type DiagnosticPacket,
} from '@pact/contracts/diagnostics'

import { DiagnosticProducer } from './producer'

const identity = {
  launchId: randomUUID(),
  appVersion: '0.0.0',
  pid: process.pid,
  process: 'main' as const,
}
afterEach(() => vi.useRealTimers())

describe('Diagnostic admission and lifecycle', () => {
  it('expires Debug, reserves error credits and reports overflow without retaining more than 64 records', () => {
    vi.useFakeTimers()
    const sent: DiagnosticPacket[] = []
    const producer = new DiagnosticProducer(identity, (packet) => sent.push(packet))
    producer.record({ operation: 'ipc', phase: 'completed', level: 'debug' })
    expect(sent).toHaveLength(0)
    producer.setDebug(Date.now() + LOG_DEBUG_MS)
    for (let i = 0; i < 100; i++)
      producer.record({ operation: 'ipc', phase: 'completed', level: 'debug' })
    expect(producer.diagnostics()).toMatchObject({ pending: LOG_PRODUCER_ITEMS - 16, dropped: 52 })
    for (let i = 0; i < 100; i++)
      producer.record({ operation: 'process', phase: 'failed', level: 'error' })
    expect(producer.diagnostics().pending).toBe(LOG_PRODUCER_ITEMS)
    for (const packet of sent) if (packet.type === 'diagnostic.record') producer.settle(packet.id)
    producer.record({ operation: 'app', phase: 'ready' })
    expect(
      sent.some(
        (packet) =>
          packet.type === 'diagnostic.record' &&
          packet.record.phase === 'dropped' &&
          packet.record.count === 136,
      ),
    ).toBe(true)
    const count = sent.length
    vi.advanceTimersByTime(LOG_DEBUG_MS)
    producer.record({ operation: 'ipc', phase: 'completed', level: 'debug' })
    expect(sent).toHaveLength(count)
    producer.dispose()
    expect(producer.diagnostics().pending).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the original overflow count when its summary cannot be written', () => {
    const sent: DiagnosticPacket[] = []
    const producer = new DiagnosticProducer(identity, (packet) => sent.push(packet))
    for (let i = 0; i < 100; i++) producer.record({ operation: 'app', phase: 'ready' })
    expect(producer.diagnostics().dropped).toBe(52)
    for (const packet of sent) if (packet.type === 'diagnostic.record') producer.settle(packet.id)
    producer.record({ operation: 'app', phase: 'ready' })
    const summary = sent.findLast(
      (packet) => packet.type === 'diagnostic.record' && packet.record.phase === 'dropped',
    )
    if (!summary || summary.type !== 'diagnostic.record')
      throw new Error('Expected admitted drop summary')
    expect(summary.record.count).toBe(52)
    producer.settle(summary.id, false)
    expect(producer.diagnostics().dropped).toBe(52)
    producer.record({ operation: 'app', phase: 'ready' })
    const summaries = sent.filter(
      (packet) => packet.type === 'diagnostic.record' && packet.record.phase === 'dropped',
    )
    expect(summaries).toHaveLength(2)
    producer.dispose()
  })

  it('rejects arbitrary payloads and remains usable after a transport failure', () => {
    const sent: DiagnosticPacket[] = []
    let failed = true
    const producer = new DiagnosticProducer(identity, (packet) => {
      if (failed) throw new Error('transport unavailable')
      sent.push(packet)
    })
    producer.record({ operation: 'app', phase: 'started' })
    expect(producer.diagnostics()).toEqual({ pending: 0, dropped: 1 })
    failed = false
    producer.record({ operation: 'app', phase: 'ready' })
    expect(
      sent.some(
        (packet) =>
          packet.type === 'diagnostic.record' &&
          packet.record.phase === 'dropped' &&
          packet.record.count === 1,
      ),
    ).toBe(true)
    producer.dispose()
  })

  it('settles shutdown only after admitted records settle, or disposal, and stops new admission', async () => {
    const sent: DiagnosticPacket[] = []
    const producer = new DiagnosticProducer(identity, (packet) => sent.push(packet))
    producer.record({ operation: 'app', phase: 'started' })
    let closed = false
    const firstClose = producer.close()
    expect(producer.close()).toBe(firstClose)
    const closing = firstClose.then(() => {
      closed = true
      return undefined
    })
    producer.record({ operation: 'app', phase: 'ready' })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(sent).toHaveLength(1)
    producer.dispose()
    await closing
    expect(producer.diagnostics().pending).toBe(0)
  })
})
