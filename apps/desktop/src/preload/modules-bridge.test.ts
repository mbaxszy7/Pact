import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  IPC_CHANNELS,
  type DesktopBridge,
  type ProviderUsageSnapshot,
  type SessionReminderState,
} from '@pact/contracts'

const harness = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  emitter: undefined as NodeJS.EventEmitter | undefined,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const emitter = new EventEmitter()
  harness.emitter = emitter
  return {
    contextBridge: {
      exposeInMainWorld: (_name: string, bridge: DesktopBridge) => {
        harness.bridge = bridge
      },
    },
    ipcRenderer: {
      invoke: harness.invoke,
      send: harness.send,
      on: (channel: string, listener: (...args: unknown[]) => void) =>
        emitter.on(channel, listener),
      removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
        emitter.removeListener(channel, listener),
    },
  }
})

async function loadBridge(): Promise<DesktopBridge> {
  vi.resetModules()
  harness.emitter?.removeAllListeners()
  harness.invoke.mockReset()
  harness.send.mockReset()
  harness.bridge = undefined
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubGlobal('process', { ...process, contextIsolated: true })
  await import('./index.js')
  if (!harness.bridge) throw new Error('DesktopBridge was not exposed.')
  return harness.bridge
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Preload bridge for SessionNotifications and ProviderUsage', () => {
  it('validates reminder subscriptions and view/dismiss invocations against @pact/contracts', async () => {
    const bridge = await loadBridge()
    const received: SessionReminderState[] = []
    const unsubscribe = bridge.onSessionReminderChanged((state) => received.push(state))

    const validState: SessionReminderState = {
      revision: 1,
      pending: 1,
      current: {
        id: 'rem-1',
        sessionId: randomUUID(),
        sessionTitle: 'Demo',
        agentId: 'codex',
        category: 'needs_input',
        priority: 3,
        createdAt: new Date().toISOString(),
      },
    }
    harness.emitter?.emit(IPC_CHANNELS.sessionReminderChanged, {}, validState)
    // Invalid cloned payloads are dropped silently by eventSubscription.
    harness.emitter?.emit(
      IPC_CHANNELS.sessionReminderChanged,
      {},
      { revision: -1, current: null, pending: 0 },
    )
    expect(received).toEqual([validState])

    unsubscribe()
    harness.emitter?.emit(IPC_CHANNELS.sessionReminderChanged, {}, { ...validState, revision: 2 })
    expect(received).toHaveLength(1)

    harness.invoke.mockResolvedValue({ ok: true, value: { accepted: true } })
    await expect(bridge.viewSessionReminder({ id: 'rem-1' })).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    expect(harness.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sessionReminderView, {
      id: 'rem-1',
    })

    await expect(bridge.dismissSessionReminder({ id: 'rem-1' })).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    expect(harness.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sessionReminderDismiss, {
      id: 'rem-1',
    })

    await expect(bridge.viewSessionReminder({ id: '' })).rejects.toThrow(/Too small|>=1/u)
  })

  it('validates provider usage read, refresh, and cancel invocations and outputs', async () => {
    const bridge = await loadBridge()
    const snapshot: ProviderUsageSnapshot = {
      provider: 'claude',
      revision: 3,
      status: 'partial',
      fiveHour: { usedPercent: 45, resetsAt: new Date().toISOString() },
      sevenDay: null,
      checkedAt: new Date().toISOString(),
      cooldownUntil: null,
      identityConfirmed: true,
    }
    harness.invoke
      .mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce({ ok: true, value: { cancelled: true, settled: true } })

    const requestId = randomUUID()
    await expect(bridge.getProviderUsage({ provider: 'claude' })).resolves.toEqual({
      ok: true,
      value: snapshot,
    })
    await expect(bridge.refreshProviderUsage({ provider: 'claude', requestId })).resolves.toEqual({
      ok: true,
      value: snapshot,
    })
    await expect(bridge.cancelProviderUsage({ provider: 'claude', requestId })).resolves.toEqual({
      ok: true,
      value: { cancelled: true, settled: true },
    })

    expect(harness.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.providerUsageGet,
      IPC_CHANNELS.providerUsageRefresh,
      IPC_CHANNELS.providerUsageCancel,
    ])

    await expect(
      bridge.refreshProviderUsage({ provider: 'claude', requestId: 'not-a-uuid' }),
    ).rejects.toThrow(/Invalid UUID/u)
  })
})
