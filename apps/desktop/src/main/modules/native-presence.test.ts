import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS, type NativePresenceSnapshot, type NativeSessionRow } from '@pact/contracts'

import type { UtilityProcessClient } from '../utility-process/client.js'

import { resolveApplicationIdentity } from '../application-identity.js'
import { createRendererTrust, type TrustedIpcEvent } from '../renderer-trust.js'
import { NativePresence, developmentNativeInvocation, nativeLaunchData } from './native-presence.js'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: TrustedIpcEvent, input?: unknown) => unknown>(),
  appEvents: new Map<string, (...args: unknown[]) => void>(),
  templates: [] as MenuItemConstructorOptions[][],
  trays: [] as Array<
    EventEmitter & { destroy: ReturnType<typeof vi.fn>; popUpContextMenu: ReturnType<typeof vi.fn> }
  >,
  dialog: vi.fn<() => Promise<{ response: number }>>(),
  quit: vi.fn<() => void>(),
  setJumpList: vi.fn<() => string>(() => 'ok'),
  template: vi.fn<(value: boolean) => void>(),
  ready: vi.fn<() => Promise<void>>(),
  getAppPath: () => 'C:/pact-presence-fixture',
  packaged: true,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return harness.packaged
    },
    getAppPath: () => harness.getAppPath(),
    getPath: () => 'C:/pact-presence-fixture',
    quit: () => harness.quit(),
    whenReady: () => harness.ready(),
    on: (event: string, listener: (...args: unknown[]) => void) =>
      harness.appEvents.set(event, listener),
    removeListener: (event: string) => harness.appEvents.delete(event),
    setJumpList: (..._args: unknown[]) => harness.setJumpList(),
    getJumpListSettings: () => ({ removedItems: [] }),
    dock: { setMenu: vi.fn<() => void>() },
  },
  ipcMain: {
    handle: (channel: string, listener: (event: TrustedIpcEvent, input?: unknown) => unknown) =>
      harness.handlers.set(channel, listener),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
  Menu: {
    buildFromTemplate: (items: MenuItemConstructorOptions[]) => {
      harness.templates.push(items)
      return { items }
    },
  },
  nativeImage: {
    createFromPath: () => ({
      addRepresentation: vi.fn<() => void>(),
      setTemplateImage: harness.template,
    }),
  },
  powerMonitor: { on: vi.fn<() => void>(), removeListener: vi.fn<() => void>() },
  Tray: function () {
    const tray = Object.assign(new EventEmitter(), {
      setToolTip: vi.fn<() => void>(),
      destroy: vi.fn<() => void>(),
      popUpContextMenu: vi.fn<() => void>(),
    })
    harness.trays.push(tray)
    return tray
  },
  dialog: { showMessageBox: () => harness.dialog() },
}))
vi.mock('node:fs', () => ({
  readFileSync: () => Buffer.from('template'),
  realpathSync: (value: string) => value,
  statSync: () => ({ size: 1, isDirectory: () => true, isFile: () => true }),
}))
vi.mock('../../../build/icon.ico?asset', () => ({ default: 'icon.ico' }))
vi.mock('../../../build/tray.ico?asset', () => ({ default: 'tray.ico' }))
vi.mock('../../../build/trayTemplate.png?asset', () => ({ default: 'trayTemplate.png' }))
vi.mock('../../../build/trayTemplate@2x.png?asset', () => ({ default: 'trayTemplate@2x.png' }))
// Packaged identity selection has its own tests; native presence receives a resolved identity.
vi.mock('../application-identity.js', () => ({
  resolveApplicationIdentity: () => ({
    kind: 'production-ci',
    name: 'Pact',
    appId: 'com.pact.desktop',
    packageName: '@pact/desktop',
    profileDirectory: 'Pact',
  }),
}))

const owners: NativePresence[] = []
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  harness.packaged = true
  harness.dialog.mockReset()
  harness.quit.mockClear()
  harness.templates.length = 0
  harness.trays.length = 0
  harness.setJumpList.mockClear()
  harness.template.mockClear()
  harness.ready.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  vi.restoreAllMocks()
})

function row(title: string, state: NativeSessionRow['state'] = 'idle'): NativeSessionRow {
  return {
    sessionId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title,
    projectName: 'Project',
    state,
    unread: false,
    jumpListSuppressed: false,
    jumpListRemovalObserved: false,
  }
}

function fixture(snapshot: Partial<NativePresenceSnapshot> = {}) {
  const value: NativePresenceSnapshot = {
    version: { incarnation: crypto.randomUUID(), revision: 1 },
    running: [],
    attention: [],
    attentionTotal: 0,
    recent: [],
    ...snapshot,
  }
  const utility = {
    isRunning: vi.fn<() => boolean>(() => true),
    getNativePresence: vi.fn<UtilityProcessClient['getNativePresence']>(async () => ({
      ok: true,
      value,
    })),
    subscribeNativePresence: vi.fn<UtilityProcessClient['subscribeNativePresence']>(() =>
      vi.fn<() => void>(),
    ),
    subscribeNativeQuitRecent: vi.fn<UtilityProcessClient['subscribeNativeQuitRecent']>(() =>
      vi.fn<() => void>(),
    ),
    updateNativeJumpListSuppression: vi.fn<UtilityProcessClient['updateNativeJumpListSuppression']>(
      async () => ({ ok: true, value: { updated: true } }),
    ),
    prepareNativeQuit: vi.fn<UtilityProcessClient['prepareNativeQuit']>(
      async ({ operationId }) => ({
        kind: 'attempted',
        result: {
          ok: true,
          value: { operationId, state: 'idle_prepared', activeCount: 0, sessions: [] },
        },
      }),
    ),
    cancelNativeQuit: vi.fn<UtilityProcessClient['cancelNativeQuit']>(async ({ operationId }) => ({
      ok: true,
      value: { operationId, cancelled: true },
    })),
    resolveNativeSession: vi.fn<UtilityProcessClient['resolveNativeSession']>(),
  }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: { url: 'app://bundle/index.html' },
      getURL: () => 'app://bundle/index.html',
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn<(channel: string, value: unknown) => void>(),
    }),
  })
  const presentation = { show: vi.fn<() => void>(), hide: vi.fn<() => void>() }
  const trust = createRendererTrust({ isPackaged: true })
  trust.registerWindow(window)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The Electron boundary uses only this controlled native-window surface.
  const nativeWindow = window as unknown as BrowserWindow
  const create = vi.fn<() => BrowserWindow>(() => nativeWindow)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture implements every Utility operation consumed by NativePresence.
  const client = utility as unknown as UtilityProcessClient
  const owner = new NativePresence(resolveApplicationIdentity(), client, trust, create, undefined)
  owners.push(owner)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (channel: string, input?: unknown) => {
    const handler = harness.handlers.get(channel)
    if (!handler) throw new Error('Missing named native handler')
    return handler(event, input)
  }
  return {
    owner,
    utility,
    window,
    presentation,
    create,
    event,
    invoke,
    attach: () => owner.attachWindow(nativeWindow, presentation),
  }
}

describe('Native presence core behavior', () => {
  it('hides on close, restores on tray click, navigates a recent Session without starting work, and disposes shell resources', async () => {
    const recent = row('Recent & local')
    const f = fixture({ recent: [recent] })
    f.attach()
    f.owner.start()
    await vi.waitFor(() =>
      expect(
        harness.templates.at(-1)?.some((item) => item.label === 'Recent && local — Project'),
      ).toBe(true),
    )
    const preventDefault = vi.fn<() => void>()
    f.window.emit('close', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.presentation.hide).toHaveBeenCalledOnce()
    harness.trays[0]!.emit('click')
    expect(f.presentation.show).toHaveBeenCalledOnce()
    const recentItem = harness.templates
      .at(-1)!
      .find((item) => item.label === 'Recent && local — Project')!
    if (!recentItem.click) throw new Error('Recent Session action is missing.')
    Reflect.apply(recentItem.click, undefined, [])
    expect(f.invoke(IPC_CHANNELS.nativeNavigationGet)).toMatchObject({
      ok: true,
      value: { kind: 'session', sessionId: recent.sessionId },
    })
    expect(f.utility.prepareNativeQuit).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    f.owner.dispose()
    expect(harness.trays[0]!.destroy).toHaveBeenCalledOnce()
    expect(harness.handlers.size).toBe(0)
  })

  it('deduplicates attention/running/recent groups and retains the taskbar and Exit entries', async () => {
    const running = row('Running', 'running'),
      attention = row('Approval', 'approval')
    const f = fixture({
      attention: [attention],
      attentionTotal: 1,
      running: [running],
      recent: [running, row('Recent')],
    })
    f.attach()
    f.owner.start()
    await vi.waitFor(() =>
      expect(harness.templates.at(-1)?.some((item) => item.label === 'Recent sessions')).toBe(true),
    )
    expect(
      harness.templates.at(-1)!.filter((item) => item.label === 'Running — Project'),
    ).toHaveLength(1)
    expect(harness.setJumpList).toHaveBeenCalled()
    const exit = harness.templates.at(-1)!.find((item) => item.label === 'Exit')!
    if (!exit.click) throw new Error('Exit action is missing.')
    Reflect.apply(exit.click, undefined, [])
    expect(harness.quit).toHaveBeenCalledOnce()
  })

  it('uses macOS Template artwork and a Dock menu', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const f = fixture()
    f.attach()
    f.owner.start()
    await vi.waitFor(() => expect(f.utility.getNativePresence).toHaveBeenCalledOnce())
    expect(harness.template).toHaveBeenCalledWith(true)
    harness.trays[0]!.emit('click')
    expect(f.presentation.show).toHaveBeenCalledOnce()
    harness.trays[0]!.emit('right-click')
    expect(harness.trays[0]!.popUpContextMenu).toHaveBeenCalledOnce()
  })

  it('uses the ready Pact document for unknown work and awaits cancellation acknowledgement', async () => {
    const f = fixture()
    f.attach()
    f.owner.start()
    f.invoke(IPC_CHANNELS.nativeQuitGet)
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'attempted',
      result: { ok: false, error: { code: 'UNCERTAIN', message: 'Lost preparation ACK.' } },
    })
    const ack =
      Promise.withResolvers<Awaited<ReturnType<UtilityProcessClient['cancelNativeQuit']>>>()
    f.utility.cancelNativeQuit.mockReturnValue(ack.promise)
    const pending = f.owner.requestQuit()
    await vi.waitFor(() =>
      expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({
        ok: true,
        value: { phase: 'confirming', unknown: true },
      }),
    )
    const operationId = f.utility.prepareNativeQuit.mock.calls[0]![0].operationId
    const cancelled = f.invoke(IPC_CHANNELS.nativeQuitRespond, { operationId, decision: 'cancel' })
    expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({ value: { phase: 'cancelling' } })
    expect(harness.dialog).not.toHaveBeenCalled()
    ack.resolve({ ok: true, value: { operationId, cancelled: true } })
    await expect(cancelled).resolves.toMatchObject({ ok: true })
    await expect(pending).resolves.toBe(false)
    expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toEqual({ ok: true, value: null })
  })

  it.each(['failed-load', 'crash', 'unresponsive'] as const)(
    'falls back when the Pact document becomes unavailable through %s',
    async (reason) => {
      const f = fixture()
      f.attach()
      f.owner.start()
      f.invoke(IPC_CHANNELS.nativeQuitGet)
      f.utility.prepareNativeQuit.mockResolvedValue({
        kind: 'not-sent',
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
      })
      harness.dialog.mockResolvedValue({ response: 0 })
      if (reason === 'failed-load')
        f.window.webContents.emit(
          'did-fail-load',
          {},
          -6,
          'Missing',
          'app://bundle/missing.html',
          true,
        )
      else if (reason === 'crash') f.window.webContents.emit('render-process-gone')
      else f.window.emit('unresponsive')
      await expect(f.owner.requestQuit()).resolves.toBe(false)
      expect(harness.dialog).toHaveBeenCalledOnce()
    },
  )

  it('keeps the existing Pact document eligible after aborted or subframe navigation', async () => {
    const f = fixture()
    f.attach()
    f.owner.start()
    f.invoke(IPC_CHANNELS.nativeQuitGet)
    f.window.webContents.emit('did-fail-load', {}, -3, 'Aborted', 'app://bundle/next.html', true)
    f.window.webContents.emit('did-fail-load', {}, -6, 'Missing', 'app://bundle/frame.html', false)
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
    })
    const pending = f.owner.requestQuit()
    await vi.waitFor(() =>
      expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({
        value: { phase: 'confirming' },
      }),
    )
    expect(harness.dialog).not.toHaveBeenCalled()
    const operationId = f.utility.prepareNativeQuit.mock.calls[0]![0].operationId
    await f.invoke(IPC_CHANNELS.nativeQuitRespond, { operationId, decision: 'cancel' })
    await expect(pending).resolves.toBe(false)
  })

  it('returns failed native cancellation to the recovered Pact document without a second dialog', async () => {
    const f = fixture()
    f.attach()
    f.owner.start()
    f.invoke(IPC_CHANNELS.nativeQuitGet)
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'attempted',
      result: { ok: false, error: { code: 'UNCERTAIN', message: 'Lost ACK.' } },
    })
    const dialogResult = Promise.withResolvers<{ response: number }>()
    const ack =
      Promise.withResolvers<Awaited<ReturnType<UtilityProcessClient['cancelNativeQuit']>>>()
    harness.dialog.mockReturnValue(dialogResult.promise)
    f.utility.cancelNativeQuit.mockReturnValue(ack.promise)
    f.window.emit('unresponsive')
    const pending = f.owner.requestQuit()
    await vi.waitFor(() => expect(harness.dialog).toHaveBeenCalledOnce())
    dialogResult.resolve({ response: 0 })
    await vi.waitFor(() => expect(f.utility.cancelNativeQuit).toHaveBeenCalledOnce())
    f.window.emit('responsive')
    ack.resolve({ ok: false, error: { code: 'TIMEOUT', message: 'No cancel ACK.' } })
    await vi.waitFor(() =>
      expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({
        value: {
          phase: 'confirming',
          message: expect.stringContaining('could not confirm cancellation'),
        },
      }),
    )
    expect(harness.dialog).toHaveBeenCalledOnce()
    const operationId = f.utility.prepareNativeQuit.mock.calls[0]![0].operationId
    await f.invoke(IPC_CHANNELS.nativeQuitRespond, { operationId, decision: 'exit' })
    await expect(pending).resolves.toBe(true)
  })

  it('does not let a stale native dialog decide a newer quit operation', async () => {
    const f = fixture()
    f.attach()
    f.owner.start()
    f.invoke(IPC_CHANNELS.nativeQuitGet)
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
    })
    const dialogResult = Promise.withResolvers<{ response: number }>()
    harness.dialog.mockReturnValue(dialogResult.promise)
    f.window.emit('unresponsive')
    const first = f.owner.requestQuit()
    await vi.waitFor(() => expect(harness.dialog).toHaveBeenCalledOnce())
    f.window.emit('responsive')
    const firstId = f.utility.prepareNativeQuit.mock.calls[0]![0].operationId
    await f.invoke(IPC_CHANNELS.nativeQuitRespond, { operationId: firstId, decision: 'cancel' })
    await expect(first).resolves.toBe(false)
    const second = f.owner.requestQuit()
    const secondId = f.utility.prepareNativeQuit.mock.calls[1]![0].operationId
    await vi.waitFor(() =>
      expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({
        value: { operationId: secondId, phase: 'confirming' },
      }),
    )
    dialogResult.resolve({ response: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.invoke(IPC_CHANNELS.nativeQuitGet)).toMatchObject({
      value: { operationId: secondId, phase: 'confirming' },
    })
    await f.invoke(IPC_CHANNELS.nativeQuitRespond, { operationId: secondId, decision: 'cancel' })
    await expect(second).resolves.toBe(false)
    expect(harness.dialog).toHaveBeenCalledOnce()
  })

  it('waits for application readiness and retries failed startup presentation only on an explicit Show', async () => {
    const f = fixture()
    const ready = Promise.withResolvers<void>()
    harness.ready.mockReturnValue(ready.promise)
    harness.dialog
      .mockRejectedValueOnce(new Error('Presentation failed'))
      .mockResolvedValue({ response: 0 })
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
    })
    const pending = f.owner.requestQuit()
    await Promise.resolve()
    expect(harness.dialog).not.toHaveBeenCalled()
    ready.resolve()
    await vi.waitFor(() => expect(harness.dialog).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(harness.dialog).toHaveBeenCalledOnce()
    f.owner.show()
    await expect(pending).resolves.toBe(false)
    expect(harness.dialog).toHaveBeenCalledTimes(2)
  })

  it('releases window listeners on replacement and never recreates a window during accepted exit', async () => {
    const f = fixture()
    for (let index = 0; index < 50; index += 1) f.attach()
    expect(f.window.listenerCount('close')).toBe(1)
    expect(f.window.webContents.listenerCount('did-navigate')).toBe(1)
    f.owner.start()
    await expect(f.owner.requestQuit()).resolves.toBe(true)
    f.window.emit('closed')
    f.owner.show()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.window.listenerCount('close')).toBe(0)
    expect(f.window.webContents.eventNames()).toEqual([])
  })

  it('detaches from captured contents after the native window has been destroyed', () => {
    const f = fixture()
    const contents = f.window.webContents
    f.attach()
    Object.defineProperty(f.window, 'webContents', {
      get: () => {
        throw new Error('Object has been destroyed')
      },
    })
    expect(() => f.window.emit('closed')).not.toThrow()
    expect(contents.eventNames()).toEqual([])
  })

  it('rejects untrusted native IPC and an acknowledgement for another navigation', () => {
    const f = fixture()
    const handler = harness.handlers.get(IPC_CHANNELS.nativeSessionResolve)!
    expect(() =>
      handler(
        { ...f.event, senderFrame: { url: 'app://bundle/index.html' } },
        { sessionId: crypto.randomUUID() },
      ),
    ).toThrow(/non-main frame/)
    f.owner.navigate(crypto.randomUUID())
    expect(
      f.invoke(IPC_CHANNELS.nativeNavigationAck, { navigationId: crypto.randomUUID() }),
    ).toMatchObject({ ok: false })
  })

  it('cancels a definitely unsent startup quit locally and shares repeated quit requests', async () => {
    const f = fixture()
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
    })
    harness.dialog.mockResolvedValue({ response: 0 })
    const pending = f.owner.requestQuit()
    expect(f.owner.requestQuit()).toBe(pending)
    await expect(pending).resolves.toBe(false)
    expect(f.utility.prepareNativeQuit).toHaveBeenCalledOnce()
    expect(f.utility.cancelNativeQuit).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('requires a remote cancellation ACK after attempted delivery and permits explicit cancellation retry', async () => {
    const f = fixture()
    f.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'attempted',
      result: { ok: false, error: { code: 'UNCERTAIN', message: 'Lost ACK.' } },
    })
    f.utility.cancelNativeQuit.mockResolvedValueOnce({
      ok: false,
      error: { code: 'TIMEOUT', message: 'Lost cancel ACK.' },
    })
    harness.dialog.mockResolvedValue({ response: 0 })
    await expect(f.owner.requestQuit()).resolves.toBe(false)
    expect(f.utility.cancelNativeQuit).toHaveBeenCalledTimes(2)
    expect(harness.dialog).toHaveBeenCalledTimes(2)
  })

  it('exits idle work without confirmation, while unknown work needs an explicit Exit choice', async () => {
    const f = fixture()
    await expect(f.owner.requestQuit()).resolves.toBe(true)
    expect(harness.dialog).not.toHaveBeenCalled()
    f.owner.dispose()
    const unknown = fixture()
    unknown.utility.prepareNativeQuit.mockResolvedValue({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Not ready.' },
    })
    harness.dialog.mockResolvedValue({ response: 1 })
    await expect(unknown.owner.requestQuit()).resolves.toBe(true)
    expect(harness.dialog).toHaveBeenCalledOnce()
    unknown.owner.shutdownUnconfirmed()
    await vi.waitFor(() => expect(harness.dialog).toHaveBeenCalledTimes(2))
  })

  it('validates native launch input and keeps development taskbar invocation scoped to its identity', () => {
    const identity = resolveApplicationIdentity(),
      sessionId = crypto.randomUUID()
    expect(nativeLaunchData(identity, [`--pact-session=${sessionId}`])).toMatchObject({
      sessionId,
      appId: identity.appId,
    })
    expect(nativeLaunchData(identity, ['--pact-session=../../private'])).toBeUndefined()
    expect(
      nativeLaunchData(identity, [`--pact-session=${sessionId}`, `--pact-session=${sessionId}`]),
    ).toBeUndefined()
    harness.packaged = false
    expect(developmentNativeInvocation(identity, ['--pact-dev-native=wrong-profile'])).toBe(
      'rejected',
    )
  })
})
