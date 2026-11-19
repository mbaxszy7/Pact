import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type ProviderUsageSnapshot,
  type SessionNotificationEvent,
  utilityRequestSchema,
} from '@pact/contracts'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeUtilityProcess {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: unknown[] = []
    on(event: string, listener: Listener): this {
      const listeners = this.handlers.get(event) ?? []
      listeners.push(listener)
      this.handlers.set(event, listeners)
      return this
    }
    postMessage(message: unknown): void {
      this.posted.push(message)
    }
    removeListener(event: string, listener: Listener): this {
      const listeners = this.handlers.get(event)
      if (!listeners) return this
      this.handlers.set(
        event,
        listeners.filter((item) => item !== listener),
      )
      return this
    }
    off(event: string, listener: Listener): this {
      return this.removeListener(event, listener)
    }
    once(event: string, listener: Listener): this {
      const wrap: Listener = (...args) => {
        this.removeListener(event, wrap)
        listener(...args)
      }
      return this.on(event, wrap)
    }
    kill(): boolean {
      this.emit('exit', 0)
      return true
    }
    emit(event: string, ...args: unknown[]): void {
      const listeners = this.handlers.get(event)
      if (!listeners) return
      for (const listener of Array.from(listeners)) listener(...args)
    }
  }
  return { FakeUtilityProcess, children: [] as FakeUtilityProcess[] }
})

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: {
    fork: () => {
      const child = new harness.FakeUtilityProcess()
      harness.children.push(child)
      return child
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    encryptStringAsync: vi.fn<() => Promise<Buffer>>(),
    decryptStringAsync: vi.fn<() => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  },
}))

import { createUtilityProcessClient } from './client.js'

afterEach(() => {
  harness.children.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ElectronUtilityProcessClient Module 1 & 2 transport', () => {
  it('forwards session.notification.event to subscribers and clears listeners on dispose', () => {
    const client = createUtilityProcessClient()
    client.start({ databaseFile: ':memory:', migrationsFolder: '/tmp/migrations' })
    const child = harness.children.at(-1)!
    child.emit('message', { type: 'runtime.ready.event' })

    const events: SessionNotificationEvent[] = []
    const unsub = client.subscribeSessionNotifications?.((event) => events.push(event))
    const evt: SessionNotificationEvent = {
      kind: 'raise',
      id: 'evt-1',
      sessionId: randomUUID(),
      sessionTitle: 'Session',
      agentId: 'codex',
      category: 'completed',
      priority: 1,
      createdAt: new Date().toISOString(),
    }
    child.emit('message', { type: 'session.notification.event', event: evt })
    expect(events).toEqual([evt])

    unsub?.()
    child.emit('message', { type: 'session.notification.event', event: { ...evt, id: 'evt-2' } })
    expect(events).toHaveLength(1)

    client.subscribeSessionNotifications?.((event) => events.push(event))
    client.dispose()
    child.emit('message', { type: 'session.notification.event', event: { ...evt, id: 'evt-3' } })
    expect(events).toHaveLength(1)
  })

  it('sends schema-valid provider usage get/refresh/cancel/release-owner requests and correlates responses', async () => {
    const client = createUtilityProcessClient()
    client.start({ databaseFile: ':memory:', migrationsFolder: '/tmp/migrations' })
    const child = harness.children.at(-1)!
    child.emit('message', { type: 'runtime.ready.event' })

    const ownerId = randomUUID()
    const requestId = randomUUID()
    const snapshot: ProviderUsageSnapshot = {
      provider: 'codex',
      revision: 1,
      status: 'ready',
      fiveHour: { usedPercent: 25, resetsAt: new Date().toISOString() },
      sevenDay: null,
      checkedAt: new Date().toISOString(),
      cooldownUntil: null,
      identityConfirmed: true,
    }

    const getPromise = client.getProviderUsage({ provider: 'codex' })
    const getPosted = utilityRequestSchema.parse(child.posted.at(-1))
    expect(getPosted.type).toBe('provider-usage.get.request')
    child.emit('message', {
      type: 'provider-usage.snapshot.response',
      requestId: getPosted.requestId,
      result: { ok: true, value: snapshot },
    })
    await expect(getPromise).resolves.toEqual({ ok: true, value: snapshot })

    const refreshPromise = client.refreshProviderUsage({
      ownerId,
      provider: 'codex',
      requestId,
    })
    const refreshPosted = utilityRequestSchema.parse(child.posted.at(-1))
    expect(refreshPosted.type).toBe('provider-usage.refresh.request')
    child.emit('message', {
      type: 'provider-usage.snapshot.response',
      requestId: refreshPosted.requestId,
      result: { ok: true, value: snapshot },
    })
    await expect(refreshPromise).resolves.toEqual({ ok: true, value: snapshot })

    const cancelPromise = client.cancelProviderUsage({
      ownerId,
      provider: 'codex',
      requestId,
    })
    const cancelPosted = utilityRequestSchema.parse(child.posted.at(-1))
    expect(cancelPosted.type).toBe('provider-usage.cancel.request')
    child.emit('message', {
      type: 'provider-usage.cancel.response',
      requestId: cancelPosted.requestId,
      result: { ok: true, value: { cancelled: true, settled: true } },
    })
    await expect(cancelPromise).resolves.toEqual({
      ok: true,
      value: { cancelled: true, settled: true },
    })

    const releasePromise = client.releaseProviderUsageOwner(ownerId)
    const releasePosted = utilityRequestSchema.parse(child.posted.at(-1))
    expect(releasePosted.type).toBe('provider-usage.release-owner.request')
    child.emit('message', {
      type: 'provider-usage.release-owner.response',
      requestId: releasePosted.requestId,
      result: { ok: true, value: { ready: true } },
    })
    await expect(releasePromise).resolves.toEqual({ ok: true, value: { ready: true } })

    client.dispose()
  })
})
