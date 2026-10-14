import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS, IPC_TRAFFIC_UNIT, type DesktopBridge } from '@pact/contracts'

import {
  LogicalIpcTrafficCollector,
  logicalIpcTrafficSnapshot,
} from '../shared/logical-ipc-traffic.js'

const harness = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  emitter: undefined as EventEmitter | undefined,
}))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const emitter = new Emitter()
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
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        const callbacks = harness.handlers.get(channel) ?? new Set()
        callbacks.add(listener)
        harness.handlers.set(channel, callbacks)
        emitter.on(channel, listener)
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        harness.handlers.get(channel)?.delete(listener)
        emitter.removeListener(channel, listener)
      },
    },
  }
})

const epoch = '00000000-0000-4000-8000-000000000001'
function health() {
  return {
    ok: true,
    value: {
      status: 'ready',
      database: 'ready',
      pid: 100,
      checkedAt: new Date().toISOString(),
      ipcTraffic: logicalIpcTrafficSnapshot(
        new LogicalIpcTrafficCollector('main-utility', epoch).snapshot(),
      ),
    },
  }
}
function exposedBridge(): DesktopBridge {
  const bridge = harness.bridge
  if (!bridge) throw new Error('Named bridge was not exposed.')
  return bridge
}
async function load(measure: boolean, contextIsolated = true) {
  vi.resetModules()
  harness.handlers.clear()
  harness.emitter?.removeAllListeners()
  harness.invoke.mockReset()
  harness.send.mockReset()
  harness.bridge = undefined
  vi.stubEnv('PACT_SOAK_NONCE', measure ? 'a'.repeat(64) : '')
  vi.stubEnv('PACT_E2E_ROOT', measure ? '/isolated-fixture' : '')
  vi.stubGlobal('process', { ...process, contextIsolated })
  const unload: (() => void)[] = []
  vi.stubGlobal('addEventListener', (_event: string, listener: () => void) => {
    unload.push(listener)
  })
  harness.invoke.mockImplementation(async (channel) =>
    channel === IPC_CHANNELS.runtimeHealth
      ? structuredClone(health())
      : { ok: true, value: { ready: true } },
  )
  await import('./index.js')
  return { bridge: exposedBridge(), unload }
}
function emit(channel: string, value: unknown) {
  const cloned: unknown = structuredClone(value)
  harness.emitter?.emit(channel, {}, cloned)
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Preload logical IPC observation at named bridge seams', () => {
  it('accepts current typed local observations and rejects older units without generic IPC', async () => {
    const { bridge } = await load(true)
    const observe: unknown = Reflect.get(bridge, 'observeMonacoWorkerTraffic')
    if (typeof observe !== 'function') throw new Error('Missing fixture-only local observation.')
    Reflect.apply(observe, undefined, [{ type: 'created', unit: IPC_TRAFFIC_UNIT }])
    const message = {
      type: 'message',
      unit: IPC_TRAFFIC_UNIT,
      category: 'renderer-monaco.request',
      measurement: { complete: true, jsonBytes: 38, binaryBytes: 0, totalBytes: 38 },
    }
    Reflect.apply(observe, undefined, [message])
    Reflect.apply(observe, undefined, [
      { ...message, unit: 'json-utf8-null-binary-skeleton-plus-visible-binary-bytes' },
    ])
    Reflect.apply(observe, undefined, [{ ...message, unit: undefined }])
    expect(harness.invoke).not.toHaveBeenCalled()
    expect(harness.send).not.toHaveBeenCalled()
    const result = await bridge.getRuntimeHealth()
    if (!result.ok) throw new Error('Missing measured health.')
    const owner = result.value.ipcTraffic?.owners.find((value) => value.owner === 'renderer-monaco')
    expect(owner?.issues).toEqual(['cleanup_unavailable', 'unvalidated_message'])
    expect(owner?.counters[0]?.business).toMatchObject({
      messages: 1,
      incompleteMessages: 0,
      totalBytes: 38,
    })
    expect(owner?.activeTransports).toBe(1)
  })
  it.each([false, true])(
    'preserves independent duplicate callback subscriptions (measurement %s)',
    async (measure) => {
      const { bridge } = await load(measure)
      const listener = vi.fn<() => void>()
      const first = bridge.onDiagnosticStatusChanged?.(listener)
      const second = bridge.onDiagnosticStatusChanged?.(listener)
      const payload = { state: 'ready', dropped: 0, debugUntil: 0 }
      emit(IPC_CHANNELS.diagnosticChanged, payload)
      expect(listener).toHaveBeenCalledTimes(2)
      first?.()
      emit(IPC_CHANNELS.diagnosticChanged, payload)
      expect(listener).toHaveBeenCalledTimes(3)
      second?.()
    },
  )
  it.each([false, true])(
    'keeps genuine EventEmitter dispatch snapshots during reentrant changes (measurement %s)',
    async (measure) => {
      const { bridge } = await load(measure)
      const added = vi.fn<() => void>()
      const removed = vi.fn<() => void>()
      let removeSecond: (() => void) | undefined
      let removeAdded: (() => void) | undefined
      bridge.onDiagnosticStatusChanged?.(() => {
        removeSecond?.()
        removeAdded ??= bridge.onDiagnosticStatusChanged?.(added)
      })
      removeSecond = bridge.onDiagnosticStatusChanged?.(removed)
      const payload = { state: 'ready', dropped: 0, debugUntil: 0 }
      emit(IPC_CHANNELS.diagnosticChanged, payload)
      expect(removed).toHaveBeenCalledTimes(1)
      expect(added).not.toHaveBeenCalled()
      emit(IPC_CHANNELS.diagnosticChanged, payload)
      expect(removed).toHaveBeenCalledTimes(1)
      expect(added).toHaveBeenCalledTimes(1)
      removeAdded?.()
    },
  )
  it('retains the context isolation hard gate before registering observation taps', async () => {
    await expect(load(true, false)).rejects.toThrow('Pact requires context isolation')
    expect(harness.handlers.size).toBe(0)
    expect(harness.bridge).toBeUndefined()
  })
  it('does not create soak taps/stats in ordinary production and preserves subscription cleanup', async () => {
    const { bridge, unload } = await load(false)
    expect(harness.handlers.size).toBe(0)
    const listener = vi.fn<() => void>()
    const remove = bridge.onDiagnosticStatusChanged?.(listener)
    emit(IPC_CHANNELS.diagnosticChanged, { state: 'ready', dropped: 0, debugUntil: 0 })
    expect(listener).toHaveBeenCalledTimes(1)
    remove?.()
    expect(harness.handlers.get(IPC_CHANNELS.diagnosticChanged)?.size).toBe(0)
    expect(unload).toHaveLength(0)
  })

  it('counts one real event before two consumers, including events without consumers; separates probes', async () => {
    const { bridge, unload } = await load(true)
    const first = vi.fn<() => void>(),
      second = vi.fn<() => void>()
    const removeFirst = bridge.onDiagnosticStatusChanged?.(first)
    const removeSecond = bridge.onDiagnosticStatusChanged?.(second)
    expect(harness.handlers.get(IPC_CHANNELS.diagnosticChanged)?.size).toBe(3)
    const payload = { state: 'ready', dropped: 0, debugUntil: 0 }
    emit(IPC_CHANNELS.diagnosticChanged, payload)
    removeFirst?.()
    removeSecond?.()
    emit(IPC_CHANNELS.diagnosticChanged, payload)
    await bridge.getProjectCatalog()
    bridge.reportRendererFault?.('view')
    const result = await bridge.getRuntimeHealth()
    if (!result.ok) throw new Error('Missing health.')
    const owner = result.value.ipcTraffic?.owners.find((value) => value.owner === 'renderer-bridge')
    expect(owner?.complete).toBe(true)
    expect(
      owner?.counters.find((row) => row.category === 'main-renderer.event')?.control.messages,
    ).toBe(2)
    expect(
      owner?.counters.find((row) => row.category === 'renderer-main.invoke')?.business.messages,
    ).toBe(1)
    expect(
      owner?.counters.find((row) => row.category === 'renderer-main.invoke')?.control.messages,
    ).toBe(1)
    expect(
      owner?.counters.find((row) => row.category === 'renderer-main.send')?.control.messages,
    ).toBe(1)
    expect(result.value.ipcTraffic?.complete).toBe(false)
    expect(result.value.ipcTraffic?.uncovered).toContain('main-directory-worker')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unload[0]?.()
    expect([...harness.handlers.values()].every((set) => set.size === 0)).toBe(true)
  })

  it('marks malformed/unknown cloned event data sticky incomplete without changing consumers', async () => {
    const { bridge } = await load(true)
    const listener = vi.fn<() => void>()
    bridge.onDiagnosticStatusChanged?.(listener)
    emit(IPC_CHANNELS.diagnosticChanged, { state: 'invalid', dropped: 0, debugUntil: 0 })
    emit(IPC_CHANNELS.diagnosticChanged, { state: 'ready', dropped: 0, debugUntil: 0 })
    const appearance = vi.fn<() => void>()
    bridge.onAppearanceSettingsChanged(appearance)
    emit(IPC_CHANNELS.appearanceChanged, {
      requested: { theme: 'system', windowMaterial: 'system', materialOpacity: 85, revision: 0 },
      effective: { theme: 'light', windowMaterial: 'solid', revision: 0 },
      projectionVersion: 0,
      extra: new Date(0),
    })
    const result = await bridge.getRuntimeHealth()
    if (!result.ok) throw new Error('Missing health.')
    const owner = result.value.ipcTraffic?.owners.find((value) => value.owner === 'renderer-bridge')
    expect(owner?.complete).toBe(false)
    expect(owner?.issues).toContain('unvalidated_message')
    expect(owner?.issues).toContain('unsupported_prototype')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(appearance).toHaveBeenCalledTimes(1)
  })

  it('retains invoke rejection and records a blocking transport observation', async () => {
    const { bridge } = await load(true)
    harness.invoke.mockRejectedValueOnce(new Error('Existing transport failure'))
    await expect(bridge.getProjectCatalog()).rejects.toThrow('Existing transport failure')
    const result = await bridge.getRuntimeHealth()
    if (!result.ok) throw new Error('Missing health.')
    expect(
      result.value.ipcTraffic?.owners.find((owner) => owner.owner === 'renderer-bridge')?.issues,
    ).toContain('transport_error')
  })
})
