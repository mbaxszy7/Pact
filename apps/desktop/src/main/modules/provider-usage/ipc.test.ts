import type { BrowserWindow } from 'electron'

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS, type ProviderUsageSnapshot, type RpcResult } from '@pact/contracts'

import type { UtilityProcessClient } from '../../utility-process/client.js'

import { createRendererTrust, type TrustedIpcEvent } from '../../renderer-trust.js'
import { registerProviderUsageIpcHandlers } from './ipc.js'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: TrustedIpcEvent, input?: unknown) => unknown>(),
  windows: new Map<object, unknown>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: object) => harness.windows.get(sender),
  },
  ipcMain: {
    handle: (channel: string, listener: (event: TrustedIpcEvent, input?: unknown) => unknown) =>
      harness.handlers.set(channel, listener),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}))

function makeSnapshot(provider: 'codex' | 'claude' | 'agy'): ProviderUsageSnapshot {
  return {
    provider,
    revision: 1,
    status: 'ready',
    fiveHour: { usedPercent: 20, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    sevenDay: null,
    checkedAt: new Date().toISOString(),
    cooldownUntil: null,
    identityConfirmed: true,
  }
}

function createFixture() {
  const trust = createRendererTrust({ isPackaged: true })
  const disposers: Array<() => void> = []

  const getProviderUsage = vi.fn<UtilityProcessClient['getProviderUsage']>(
    async ({ provider }) => ({
      ok: true,
      value: makeSnapshot(provider),
    }),
  )
  const refreshProviderUsage = vi.fn<UtilityProcessClient['refreshProviderUsage']>(
    async ({ provider }) => ({ ok: true, value: makeSnapshot(provider) }),
  )
  const cancelProviderUsage = vi.fn<UtilityProcessClient['cancelProviderUsage']>(async () => ({
    ok: true,
    value: { cancelled: true, settled: true },
  }))
  const releaseProviderUsageOwner = vi.fn<UtilityProcessClient['releaseProviderUsageOwner']>(
    async () => ({ ok: true, value: { ready: true } }),
  )

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test double implements the UtilityProcessClient provider-usage surface.
  const utilityClient = {
    getProviderUsage,
    refreshProviderUsage,
    cancelProviderUsage,
    releaseProviderUsageOwner,
  } as unknown as UtilityProcessClient

  const disposeIpc = registerProviderUsageIpcHandlers(trust, utilityClient)
  disposers.push(disposeIpc)

  const createSender = () => {
    const windowEvents = new EventEmitter()
    let destroyed = false
    const sender = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'app://bundle/index.html' },
      getURL: () => 'app://bundle/index.html',
      isDestroyed: () => destroyed,
      destroy() {
        destroyed = true
      },
    })
    const hostWindow = Object.assign(windowEvents, {
      webContents: sender,
      isDestroyed: () => false,
    })
    harness.windows.set(sender, hostWindow)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled BrowserWindow test surface.
    disposers.push(trust.registerWindow(hostWindow as unknown as BrowserWindow))
    return {
      sender,
      hostWindow,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled WebContents event seam.
      event: { sender, senderFrame: sender.mainFrame } as unknown as TrustedIpcEvent,
    }
  }

  return {
    getProviderUsage,
    refreshProviderUsage,
    cancelProviderUsage,
    releaseProviderUsageOwner,
    createSender,
    invoke(channel: string, event: TrustedIpcEvent, raw: unknown) {
      const handler = harness.handlers.get(channel)
      if (!handler) throw new Error(`Missing handler for ${channel}`)
      return handler(event, raw)
    },
    dispose() {
      for (const d of disposers.splice(0).toReversed()) d()
    },
  }
}

beforeEach(() => {
  harness.handlers.clear()
  harness.windows.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderUsage IPC handler', () => {
  it('validates payloads, enforces frame trust, and binds one stable ownerId per document', async () => {
    const f = createFixture()
    try {
      const { event } = f.createSender()

      // Non-main frame rejected.
      expect(() =>
        f.invoke(
          IPC_CHANNELS.providerUsageGet,
          { ...event, senderFrame: { url: 'app://bundle/index.html' } },
          { provider: 'codex' },
        ),
      ).toThrow('Rejected IPC request from a non-main frame.')

      // Validation errors rejected before hitting utilityClient.
      expect(f.invoke(IPC_CHANNELS.providerUsageGet, event, { provider: 'other' })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' },
      })
      await expect(
        f.invoke(IPC_CHANNELS.providerUsageRefresh, event, { provider: 'codex', requestId: 'bad' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
      expect(
        f.invoke(IPC_CHANNELS.providerUsageCancel, event, { provider: 'claude', requestId: 'bad' }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })

      // Valid get / refresh / cancel share one ownerId.
      await expect(
        f.invoke(IPC_CHANNELS.providerUsageGet, event, { provider: 'codex' }),
      ).resolves.toMatchObject({ ok: true, value: { provider: 'codex', status: 'ready' } })

      const req1 = randomUUID()
      const req2 = randomUUID()
      await f.invoke(IPC_CHANNELS.providerUsageRefresh, event, {
        provider: 'codex',
        requestId: req1,
      })
      await f.invoke(IPC_CHANNELS.providerUsageRefresh, event, {
        provider: 'claude',
        requestId: req2,
      })
      const ownerId = f.refreshProviderUsage.mock.calls[0]![0].ownerId
      expect(f.refreshProviderUsage.mock.calls[1]![0].ownerId).toBe(ownerId)

      await f.invoke(IPC_CHANNELS.providerUsageCancel, event, {
        provider: 'codex',
        requestId: req1,
      })
      expect(f.cancelProviderUsage).toHaveBeenCalledWith({
        ownerId,
        provider: 'codex',
        requestId: req1,
      })
    } finally {
      f.dispose()
    }
  })

  it('cancels active probes on window hide, minimize, and unresponsive', async () => {
    const f = createFixture()
    try {
      const { hostWindow, event } = f.createSender()
      for (const windowEvent of ['hide', 'minimize', 'unresponsive'] as const) {
        const pending = Promise.withResolvers<RpcResult<ProviderUsageSnapshot>>()
        f.refreshProviderUsage.mockReturnValueOnce(pending.promise)
        const requestId = randomUUID()
        const inFlight = f.invoke(IPC_CHANNELS.providerUsageRefresh, event, {
          provider: 'codex',
          requestId,
        })
        hostWindow.emit(windowEvent)
        expect(f.cancelProviderUsage).toHaveBeenLastCalledWith({
          ownerId: expect.any(String),
          provider: 'codex',
          requestId,
        })
        pending.resolve({
          ok: true,
          value: {
            provider: 'codex',
            revision: 1,
            status: 'idle',
            fiveHour: null,
            sevenDay: null,
            checkedAt: null,
            cooldownUntil: null,
            identityConfirmed: false,
          },
        })
        // oxlint-disable-next-line no-await-in-loop -- Observe each sequential window lifecycle cancellation one at a time.
        await inFlight
      }
      expect(f.cancelProviderUsage).toHaveBeenCalledTimes(3)
    } finally {
      f.dispose()
    }
  })

  it('releases owner on main-frame navigation and process loss, rejects post-release resolution, and cleans up handlers', async () => {
    const f = createFixture()
    try {
      const { sender, event } = f.createSender()
      const pending = Promise.withResolvers<RpcResult<ProviderUsageSnapshot>>()
      f.refreshProviderUsage.mockReturnValueOnce(pending.promise)
      const reqId = randomUUID()
      const inFlight = f.invoke(IPC_CHANNELS.providerUsageRefresh, event, {
        provider: 'claude',
        requestId: reqId,
      })

      // Subframe and in-place navigations do NOT release the owner.
      sender.emit('did-start-navigation', {}, 'app://bundle/sub.html', false, false)
      sender.emit('did-start-navigation', {}, 'app://bundle/index.html#tab', true, true)
      expect(f.releaseProviderUsageOwner).not.toHaveBeenCalled()

      // Main-frame non-in-place navigation releases the owner immediately.
      sender.emit('did-start-navigation', {}, 'app://bundle/other.html', false, true)
      expect(f.releaseProviderUsageOwner).toHaveBeenCalledTimes(1)

      pending.resolve({
        ok: true,
        value: {
          provider: 'claude',
          revision: 1,
          status: 'ready',
          fiveHour: { usedPercent: 10, resetsAt: null },
          sevenDay: null,
          checkedAt: new Date().toISOString(),
          cooldownUntil: null,
          identityConfirmed: true,
        },
      })
      await expect(inFlight).resolves.toEqual({
        ok: false,
        error: { code: 'CONFLICT', message: 'Usage check was cancelled.' },
      })

      // A second sender releases cleanly when render-process-gone fires.
      const second = f.createSender()
      await f.invoke(IPC_CHANNELS.providerUsageRefresh, second.event, {
        provider: 'codex',
        requestId: randomUUID(),
      })
      second.sender.emit('render-process-gone')
      expect(f.releaseProviderUsageOwner).toHaveBeenCalledTimes(2)

      f.dispose()
      expect(harness.handlers.size).toBe(0)
    } finally {
      f.dispose()
    }
  })
})
