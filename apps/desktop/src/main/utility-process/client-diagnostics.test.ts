import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagnosticEventSchema, type DiagnosticEvent } from '@pact/contracts/diagnostics'

const harness = vi.hoisted(() => {
  class Child {
    readonly pid = 123
    readonly posted: Record<string, unknown>[] = []
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }
    postMessage(message: Record<string, unknown>): void {
      this.posted.push(message)
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
    kill(): void {}
  }
  return { Child, children: [] as Child[] }
})
vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new harness.Child()
      harness.children.push(child)
      return child
    },
  },
}))

import { createUtilityProcessClient } from './client'

afterEach(() => {
  vi.useRealTimers()
  harness.children.length = 0
})

function start() {
  const events: DiagnosticEvent[] = []
  const diagnostics = {
    identity: {
      process: 'main' as const,
      pid: process.pid,
      launchId: randomUUID(),
      appVersion: '0.0.0',
    },
    record: (event: DiagnosticEvent) => {
      events.push(diagnosticEventSchema.parse(event))
    },
    attachUtility: () => undefined,
    acceptUtility: () => false,
  }
  const client = createUtilityProcessClient()
  client.start({
    databaseFile: ':memory:',
    migrationsFolder: '/private/fixture/migrations',
    diagnostics,
  })
  return { client, events, child: harness.children.at(-1)! }
}

describe('Main request diagnostic names', () => {
  it('pairs a named successful request using the existing transport ID', async () => {
    const { client, child, events } = start()
    try {
      const result = client.request(
        { type: 'runtime.shutdown.request' },
        'runtime.shutdown.response',
      )
      const requestId = child.posted[0]!.requestId
      child.emit('message', {
        type: 'runtime.shutdown.response',
        requestId,
        result: { ok: true, value: { flushed: true } },
      })
      await expect(result).resolves.toMatchObject({ kind: 'response' })
      const requestEvents = events.filter((event) => event.operationId === requestId)
      expect(requestEvents.map((event) => event.phase)).toEqual(['started', 'completed'])
      expect(
        requestEvents.every(
          (event) => event.requestType === 'runtime.shutdown.request' && event.scope === 'request',
        ),
      ).toBe(true)
    } finally {
      client.dispose()
    }
  })

  it('identifies the exact timed-out operation without copying its payload', async () => {
    vi.useFakeTimers()
    const { client, child, events } = start()
    try {
      const sessionId = randomUUID(),
        runId = randomUUID()
      const pending = client.request(
        { type: 'conversation.retry.request', input: { sessionId, runId, intent: 'inspect' } },
        'conversation.patch.response',
        20,
      )
      await vi.advanceTimersByTimeAsync(20)
      await expect(pending).resolves.toMatchObject({
        kind: 'unknown-delivery',
        error: { code: 'TIMEOUT' },
      })
      expect(events.at(-1)).toMatchObject({
        requestType: 'conversation.retry.request',
        phase: 'unknown_delivery',
        code: 'TIMEOUT',
        sessionId,
        runId,
        operationId: child.posted[0]!.requestId,
        durationMs: 20,
      })
      expect(events.at(-1)).not.toHaveProperty('input')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
    }
  })
})
