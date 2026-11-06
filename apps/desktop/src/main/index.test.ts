import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, { listener: Listener; once: boolean }[]>()
  const add = (event: string, listener: Listener, once: boolean): void => {
    const entries = listeners.get(event) ?? []
    entries.push({ listener, once })
    listeners.set(event, entries)
  }
  const app = {
    isPackaged: false,
    dock: undefined as { setIcon: (icon: unknown) => void } | undefined,
    setName: vi.fn<(name: string) => void>(),
    setAppUserModelId: vi.fn<(id: string) => void>(),
    requestSingleInstanceLock: vi.fn<(launch?: unknown) => boolean>(() => true),
    releaseSingleInstanceLock: vi.fn<() => void>(),
    whenReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    quit: vi.fn<() => void>(),
    exit: vi.fn<(code?: number) => void>(),
    on(event: string, listener: Listener) {
      add(event, listener, false)
      return app
    },
    once(event: string, listener: Listener) {
      add(event, listener, true)
      return app
    },
    emit(event: string, ...args: unknown[]): boolean {
      const entries = [...(listeners.get(event) ?? [])]
      for (const entry of entries) {
        if (entry.once)
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((item) => item !== entry),
          )
        entry.listener(...args)
      }
      return entries.length > 0
    },
    removeAllListeners(): void {
      listeners.clear()
    },
  }
  const state = {
    requestQuit: Promise.withResolvers<boolean>(),
    shutdown: Promise.withResolvers<unknown>(),
    settlement: Promise.withResolvers<void>(),
    running: false,
    startOptions: undefined as { onExit?: () => void } | undefined,
  }
  const client = {
    start: vi.fn<(options: { onExit?: () => void }) => void>((options) => {
      state.startOptions = options
    }),
    waitUntilReady: vi.fn<() => Promise<{ ok: true; value: { ready: true } }>>(async () => ({
      ok: true as const,
      value: { ready: true as const },
    })),
    shutdown: vi.fn<() => Promise<unknown>>(() => state.shutdown.promise),
    settlement: vi.fn<() => Promise<void>>(() => state.settlement.promise),
    isRunning: vi.fn<() => boolean>(() => state.running),
    dispose: vi.fn<() => void>(),
  }
  const presence = {
    attachWindow: vi.fn<(...args: unknown[]) => void>(),
    show: vi.fn<() => void>(),
    start: vi.fn<() => void>(),
    requestQuit: vi.fn<() => Promise<boolean>>(() => state.requestQuit.promise),
    shutdownUnconfirmed: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    recoverStartup: vi.fn<() => Promise<boolean>>(async () => true),
  }
  const diagnostics = {
    record: vi.fn<(event: unknown) => void>(),
    attachUtility: vi.fn<(child: unknown) => void>(),
    acceptUtility: vi.fn<() => boolean>(() => false),
    createMenuItem: vi.fn<() => void>(),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  }
  const updates = {
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    openFromMenu: vi.fn<() => void>(),
  }
  const menu = {
    attachWindow: vi.fn<(...args: unknown[]) => void>(),
    dispose: vi.fn<() => void>(),
  }
  const appearance = {
    getWindowAppearance: vi.fn<() => object>(() => ({})),
    attachWindow: vi.fn<(...args: unknown[]) => void>(),
    refresh: vi.fn<() => Promise<{ ok: true; value: object }>>(async () => ({
      ok: true as const,
      value: {},
    })),
    dispose: vi.fn<() => void>(),
  }
  return { app, state, client, presence, diagnostics, updates, menu, appearance }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: vi.fn<() => void>(),
  dialog: {
    showMessageBox: vi.fn<() => Promise<unknown>>(),
    showErrorBox: vi.fn<() => void>(),
  },
  nativeTheme: {},
  shell: {
    showItemInFolder: vi.fn<(path: string) => void>(),
    openExternal: vi.fn<() => Promise<void>>(),
  },
}))
vi.mock('@electron-toolkit/utils', () => ({
  optimizer: { watchWindowShortcuts: vi.fn<(window: unknown) => void>() },
}))
vi.mock('../../build/icon-mac.png?asset', () => ({ default: 'icon-mac.png' }))
vi.mock('./app-protocol', () => ({ registerAppProtocol: vi.fn<(dir: string) => void>() }))
vi.mock('./application-identity', () => ({
  resolveApplicationIdentity: () => ({ name: 'Pact Test', appId: 'dev.pact.test' }),
  resolveNativeApplicationIdentity: (identity: { name: string; appId: string }) => ({
    ...identity,
    appId: 'dev.pact.test.native',
  }),
}))
vi.mock('./product-identity', () => ({
  readProductIdentity: () => ({ productName: 'Pact Test' }),
}))
vi.mock('./modules', () => ({
  registerDesktopModules: vi.fn<() => () => void>(() => () => undefined),
}))
vi.mock('./modules/app-updates', () => ({
  ApplicationUpdates: function () {
    return harness.updates
  },
}))
vi.mock('./modules/appearance/controller', () => ({
  createAppearanceController: () => harness.appearance,
}))
vi.mock('./modules/application-menu', () => ({
  ApplicationMenu: function () {
    return harness.menu
  },
}))
vi.mock('./modules/diagnostics', () => ({
  DiagnosticLogs: function () {
    return harness.diagnostics
  },
}))
vi.mock('./modules/native-presence', () => ({
  developmentNativeInvocation: () => 'none',
  nativeLaunchData: () => undefined,
  NativePresence: function () {
    return harness.presence
  },
}))
vi.mock('./package-smoke', () => ({
  completePackagedSmoke: vi.fn<() => void>(),
  completePackagedProductionPathProbe: vi.fn<() => boolean>(() => false),
  configurePackageSmokeUserData: vi.fn<() => void>(),
  isPackageSmoke: vi.fn<() => boolean>(() => false),
  observePackagedPageLoad: vi.fn<() => void>(),
}))
vi.mock('./renderer-trust', () => ({ createRendererTrust: () => ({}) }))
vi.mock('./utility-process/client', () => ({
  createUtilityProcessClient: () => harness.client,
}))
vi.mock('./utility-process/runtime-paths', () => ({
  configureApplicationProfile: vi.fn<() => void>(),
  resolveRuntimePaths: () => ({
    databaseFile: ':memory:',
    migrationsFolder: '/tmp/pact-index-test',
    workspaceStorageRoot: '/tmp/pact-index-test-ws',
  }),
}))
vi.mock('./window', () => ({ createMainWindow: vi.fn<() => object>(() => ({})) }))

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function boot(): Promise<void> {
  vi.resetModules()
  await import('./index.js')
  await vi.waitFor(() => {
    expect(harness.client.start).toHaveBeenCalledOnce()
    expect(harness.presence.start).toHaveBeenCalledOnce()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.app.removeAllListeners()
  harness.state.requestQuit = Promise.withResolvers<boolean>()
  harness.state.shutdown = Promise.withResolvers<unknown>()
  harness.state.settlement = Promise.withResolvers<void>()
  harness.state.running = false
  harness.state.startOptions = undefined
})

afterEach(() => {
  harness.app.removeAllListeners()
})

describe('Main quit composition', () => {
  it('fences final quit on the physical settlement across onExit and repeated quit routes', async () => {
    await boot()
    const { app, client, presence, diagnostics, updates, state } = harness
    const first = { preventDefault: vi.fn<() => void>() }
    app.emit('before-quit', first)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    state.requestQuit.resolve(true)
    await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledOnce())
    expect(updates.stop).toHaveBeenCalledOnce()
    state.running = false
    state.startOptions?.onExit?.()
    expect(client.settlement).toHaveBeenCalledOnce()
    await flush()
    expect(diagnostics.close).not.toHaveBeenCalled()
    expect(presence.dispose).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    state.shutdown.resolve({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'Utility exit unconfirmed.' },
    })
    const second = { preventDefault: vi.fn<() => void>() }
    app.emit('before-quit', second)
    state.startOptions?.onExit?.()
    await flush()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(client.settlement).toHaveBeenCalledOnce()
    expect(diagnostics.close).not.toHaveBeenCalled()
    expect(presence.dispose).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    state.settlement.resolve()
    await vi.waitFor(() => expect(diagnostics.close).toHaveBeenCalledOnce())
    expect(presence.dispose).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(diagnostics.close.mock.invocationCallOrder[0]!).toBeLessThan(
      presence.dispose.mock.invocationCallOrder[0]!,
    )
    expect(presence.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      app.quit.mock.invocationCallOrder[0]!,
    )
    const third = { preventDefault: vi.fn<() => void>() }
    app.emit('before-quit', third)
    expect(third.preventDefault).not.toHaveBeenCalled()
  })

  it('fences final quit when shutdown completes with the child no longer running', async () => {
    await boot()
    const { app, client, presence, diagnostics, state } = harness
    app.emit('before-quit', { preventDefault: vi.fn<() => void>() })
    state.requestQuit.resolve(true)
    await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledOnce())
    state.running = false
    state.shutdown.resolve({ ok: true, value: { flushed: true } })
    await flush()
    expect(client.settlement).toHaveBeenCalledOnce()
    expect(diagnostics.close).not.toHaveBeenCalled()
    expect(presence.dispose).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    state.settlement.resolve()
    await vi.waitFor(() => expect(diagnostics.close).toHaveBeenCalledOnce())
    expect(presence.dispose).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed shutdown and still fences the later onExit route', async () => {
    await boot()
    const { app, client, presence, diagnostics, state } = harness
    app.emit('before-quit', { preventDefault: vi.fn<() => void>() })
    state.requestQuit.resolve(true)
    await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledOnce())
    state.running = true
    state.shutdown.resolve({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'Utility exit unconfirmed.' },
    })
    await vi.waitFor(() => expect(presence.shutdownUnconfirmed).toHaveBeenCalledOnce())
    expect(diagnostics.close).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    state.running = false
    state.startOptions?.onExit?.()
    expect(client.settlement).toHaveBeenCalledOnce()
    await flush()
    expect(diagnostics.close).not.toHaveBeenCalled()
    state.settlement.resolve()
    await vi.waitFor(() => expect(diagnostics.close).toHaveBeenCalledOnce())
    expect(presence.dispose).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('runs no shutdown when the quit request is not accepted', async () => {
    await boot()
    const { app, client, presence, diagnostics, state } = harness
    const event = { preventDefault: vi.fn<() => void>() }
    app.emit('before-quit', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    state.requestQuit.resolve(false)
    await flush()
    await flush()
    expect(client.shutdown).not.toHaveBeenCalled()
    expect(presence.shutdownUnconfirmed).not.toHaveBeenCalled()
    expect(diagnostics.close).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })
})
