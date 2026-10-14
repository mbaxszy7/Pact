import { _electron as electron, test as baseTest, type ElectronApplication } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

import { within } from '../native/native-harness.js'

const probe = vi.hoisted(() => ({
  environmentGate: undefined as Promise<void> | undefined,
  ownerGate: undefined as Promise<void> | undefined,
  emptyGate: undefined as Promise<void> | undefined,
  startGate: undefined as Promise<void> | undefined,
  roots: [] as string[],
  owners: [] as Array<{ directory: string; released: number; reads: number; deadline?: number }>,
  rejectEmpty: false,
  nativeInitializeGate: undefined as Promise<void> | undefined,
  clients: [] as Array<{ initialized: boolean; released: boolean; closeCalls: number }>,
}))

vi.mock('../native/native-harness.js', async (original) => {
  const actual = await original<typeof import('../native/native-harness.js')>()
  return {
    ...actual,
    NativeRpc: class {
      private readonly record = { initialized: false, released: false, closeCalls: 0 }
      private closing: Promise<void> | undefined

      constructor(
        _executable: string,
        _cwd: string,
        _environment: NodeJS.ProcessEnv,
        _group: unknown,
        private readonly onReleased?: () => void,
      ) {
        probe.clients.push(this.record)
      }

      async initialize(): Promise<void> {
        await probe.nativeInitializeGate
        this.record.initialized = true
      }

      cleanupFacts(): { released: boolean } {
        return { released: this.record.released }
      }

      close(): Promise<void> {
        this.closing ??= Promise.resolve().then(() => {
          this.record.closeCalls++
          this.record.released = true
          this.onReleased?.()
          return undefined
        })
        return this.closing
      }
    },
  }
})

vi.mock('./provider-environment.js', async (original) => {
  const actual = await original<typeof import('./provider-environment.js')>()
  return {
    ...actual,
    prepareProviderEnvironment: async (
      ...args: Parameters<typeof actual.prepareProviderEnvironment>
    ) => {
      probe.roots.push(args[0])
      await probe.environmentGate
      // These admission cases exercise controlled Node/lifecycle targets, never
      // a real Provider. The loader's provenance checks have their own tests.
      return actual.prepareProviderEnvironment(args[0])
    },
  }
})

vi.mock('./windows-cli-launcher.js', async (original) => {
  const actual = await original<typeof import('./windows-cli-launcher.js')>()
  return {
    ...actual,
    writeWindowsObservedLauncher: async (root: string) => {
      const record: (typeof probe.owners)[number] = {
        directory: join(root, `controlled-job-${probe.owners.length}`),
        released: 0,
        reads: 0,
      }
      probe.owners.push(record)
      await mkdir(record.directory)
      await probe.ownerGate
      const generation = record.directory
      const empty = probe.rejectEmpty
        ? Promise.reject(new Error('Missing authenticated release receipt'))
        : (probe.emptyGate ?? Promise.resolve()).then(() => ({
            generation,
            active: 0 as const,
            exitCode: 0,
          }))
      void empty.catch(() => undefined)
      return {
        executablePath: process.execPath,
        directory: record.directory,
        generation,
        started: (probe.startGate ?? Promise.resolve()).then(() => ({
          generation,
          pid: process.pid,
        })),
        get empty() {
          record.reads++
          return empty
        },
        cancel: () => undefined,
        armStartup: (deadline: number) => {
          record.deadline = deadline
        },
        disposeControl: async () => {
          record.released++
        },
        diagnostic: () => ({ generation, stages: {} }),
      }
    },
  }
})

beforeEach(() => {
  vi.resetModules()
  probe.environmentGate = undefined
  probe.ownerGate = undefined
  probe.emptyGate = undefined
  probe.startGate = undefined
  probe.roots = []
  probe.owners = []
  probe.rejectEmpty = false
  probe.nativeInitializeGate = undefined
  probe.clients = []
})

function gate(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, resolve: release }
}

function controlledApp(root: string): ElectronApplication {
  const evaluate = vi.fn<() => Promise<unknown>>()
  if (process.platform === 'win32') evaluate.mockResolvedValueOnce(process.pid)
  evaluate
    .mockResolvedValueOnce({
      userData: join(root, 'electron-profile'),
      sessionData: join(root, 'electron-session'),
      temp: join(root, 'tmp'),
    })
    .mockResolvedValue(undefined)
  const app = Object.assign(new EventEmitter(), {
    firstWindow: async () => ({}),
    close: async () => {
      app.emit('close')
    },
    evaluate,
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled lifecycle object; no Electron process is created.
  return app as unknown as ElectronApplication
}

it.skipIf(process.platform !== 'win32')(
  'does not reset the thirty-second deadline after Electron launch while waiting for its start receipt',
  async () => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const held = gate()
    probe.startGate = held.promise
    let time = performance.now()
    const began = time
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time)
    const launch = vi.spyOn(electron, 'launch').mockImplementation(async () => {
      time += 29_995
      return controlledApp(fixture.directory)
    })
    const operation = fixture.launch().catch((error: unknown) => error)
    try {
      const outcome = await within(
        operation,
        1000,
        'Start receipt incorrectly received a fresh deadline',
      )
      expect(outcome instanceof Error && outcome.message).toContain(
        'start receipt exceeded caller deadline',
      )
      expect(launch.mock.calls[0]?.[0]?.timeout).toBe(30_000)
      expect(probe.owners[0]?.deadline).toBe(began + 30_000)
    } finally {
      held.resolve()
      await operation
      clock.mockRestore()
      await fixture.dispose()
      launch.mockRestore()
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'handles a dispatched Main identity request when dispatch crosses the startup deadline',
  async () => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let time = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time)
    const app = controlledApp(fixture.directory)
    let rejectPid!: (error: Error) => void
    const pid = new Promise<number>((_done, reject) => {
      rejectPid = reject
    })
    // A plain method preserves an unhandled rejection; Vitest mocks observe returned promises.
    Reflect.set(app, 'evaluate', () => {
      time += 2
      return pid
    })
    const originalClose = app.close.bind(app)
    const close = vi.spyOn(app, 'close').mockImplementation(async () => {
      rejectPid(new Error('Controlled abandoned Main identity request'))
      await originalClose()
    })
    const launch = vi.spyOn(electron, 'launch').mockImplementation(async () => {
      time += 29_999
      return app
    })
    const unhandled: unknown[] = []
    const observe = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', observe)
    try {
      await expect(fixture.launch()).rejects.toThrow('caller startup deadline')
      await new Promise<void>((done) => setImmediate(done))
      expect(unhandled).toEqual([])
      expect(close).toHaveBeenCalledOnce()
    } finally {
      process.off('unhandledRejection', observe)
      clock.mockRestore()
      await fixture.dispose()
      launch.mockRestore()
      close.mockRestore()
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'teardown still releases ready fixtures when another construction exceeds its drain deadline',
  async () => {
    let hook:
      | ((input: { browserName: string }, use: () => Promise<void>) => Promise<void>)
      | undefined
    const originalExtend = baseTest.extend.bind(baseTest)
    const extend = vi.spyOn(baseTest, 'extend').mockImplementation((fixtures) => {
      const descriptor: unknown = Reflect.get(fixtures, 'runtimeOwnership')
      if (Array.isArray(descriptor) && typeof descriptor[0] === 'function') {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Capture the actual fixture hook through Playwright's public extension boundary.
        hook = descriptor[0] as NonNullable<typeof hook>
      }
      return originalExtend(fixtures)
    })
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    extend.mockRestore()
    const ready = await createRuntimeFixture({ mode: 'ui' })
    const launch = vi
      .spyOn(electron, 'launch')
      .mockImplementation(async () => controlledApp(ready.directory))
    await ready.launch()
    const held = gate()
    probe.environmentGate = held.promise
    const pending = createRuntimeFixture({ mode: 'ui' }).catch((error: unknown) => error)
    try {
      await expect.poll(() => probe.roots.length).toBe(2)
      if (!hook) throw new Error('Fixture teardown hook unavailable')
      vi.useFakeTimers()
      const teardown = hook({ browserName: 'chromium' }, async () => undefined).catch(
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(30_001)
      vi.useRealTimers()
      const outcome = await teardown
      expect(outcome instanceof Error && outcome.message).toContain(
        'Fixture construction did not settle',
      )
      await expect(stat(ready.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(probe.roots[1]!)).isDirectory()).toBe(true)
      held.resolve()
      const late = await pending
      expect(late).toBeInstanceOf(Error)
      expect(launch).toHaveBeenCalledOnce()
      expect(probe.owners).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      held.resolve()
      const remaining = await pending
      await ready.dispose()
      if (
        remaining &&
        typeof remaining === 'object' &&
        'dispose' in remaining &&
        typeof remaining.dispose === 'function'
      )
        await remaining.dispose()
      launch.mockRestore()
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'settles a command and disposal through one generation release',
  async () => {
    const held = gate()
    probe.emptyGate = held.promise
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const command = fixture.runNativeCommand('codex', ['-e', ''])
    try {
      await expect.poll(() => probe.owners[0]?.reads).toBe(1)
      const disposal = fixture.dispose()
      held.resolve()
      await Promise.all([command, disposal])
      expect(probe.owners[0]).toMatchObject({ reads: 1, released: 1 })
      await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      held.resolve()
      await command.catch(() => undefined)
      await fixture.dispose().catch(() => undefined)
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it.each([false, true])(
  'drains a late Electron app before disposal settles (close fails: %s)',
  async (closeFails) => {
    const held = gate()
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const app = controlledApp(fixture.directory)
    const close = vi.spyOn(app, 'close')
    if (closeFails) close.mockRejectedValue(new Error('Controlled late close failure'))
    const launch = vi.spyOn(electron, 'launch').mockImplementation(async () => {
      await held.promise
      return app
    })
    const operation = fixture.launch().catch((error: unknown) => error)
    try {
      await expect.poll(() => launch.mock.calls.length).toBe(1)
      let settled = false
      const disposal = fixture.dispose().then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          throw error
        },
      )
      void disposal.catch(() => undefined)
      await new Promise<void>((done) => setTimeout(done, 50))
      expect(settled).toBe(false)
      held.resolve()
      await expect(operation).resolves.toBeInstanceOf(Error)
      const outcome = await disposal.then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
      )
      expect(outcome.includes('Late Electron launch did not acknowledge shutdown')).toBe(closeFails)
      expect(
        await stat(fixture.directory).then(
          (value) => value.isDirectory(),
          () => false,
        ),
      ).toBe(closeFails)
      expect(close).toHaveBeenCalledOnce()
      expect(probe.owners[0]?.released ?? 0).toBe(process.platform === 'win32' ? 1 : 0)
    } finally {
      held.resolve()
      await operation
      await fixture.dispose().catch(() => undefined)
      launch.mockRestore()
      close.mockRestore()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it('reserves all eight fixture slots before asynchronous construction', async () => {
  const held = gate()
  probe.environmentGate = held.promise
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  let rejected = 0
  const attempts = Array.from({ length: 9 }, () =>
    createRuntimeFixture({ mode: 'ui' }).catch(() => {
      rejected++
      return undefined
    }),
  )
  try {
    await expect.poll(() => probe.roots.length + rejected).toBe(9)
    expect(probe.roots).toHaveLength(8)
    expect(rejected).toBe(1)
  } finally {
    held.resolve()
    const fixtures = await Promise.all(attempts)
    await Promise.all(fixtures.map((fixture) => fixture?.dispose() ?? Promise.resolve()))
  }
})

it.skipIf(process.platform !== 'win32')(
  'reserves the app slot before launcher construction',
  async () => {
    const held = gate()
    probe.ownerGate = held.promise
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const launch = vi
      .spyOn(electron, 'launch')
      .mockImplementation(async () => controlledApp(fixture.directory))
    const first = fixture.launch()
    let secondRejected = false
    const second = fixture.launch().catch(() => {
      secondRejected = true
    })
    try {
      await expect.poll(() => probe.owners.length + Number(secondRejected)).toBe(2)
      expect(probe.owners).toHaveLength(1)
      expect(secondRejected).toBe(true)
    } finally {
      held.resolve()
      await Promise.allSettled([first, second])
      await fixture.dispose()
      launch.mockRestore()
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'keeps two unconfirmed command slots occupied',
  async () => {
    probe.rejectEmpty = true
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    try {
      await expect(fixture.runNativeCommand('codex', ['-e', ''])).rejects.toThrow(
        'Missing authenticated',
      )
      await expect(fixture.runNativeCommand('codex', ['-e', ''])).rejects.toThrow(
        'Missing authenticated',
      )
      await expect(fixture.runNativeCommand('codex', ['-e', ''])).rejects.toThrow(
        'capacity exceeded',
      )
      expect(probe.owners).toHaveLength(2)
    } finally {
      await fixture.dispose().catch(() => undefined)
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'win32').each(['app', 'command'] as const)(
  'disposal drains a pending %s constructor and never launches its prepared target',
  async (kind) => {
    const held = gate()
    probe.ownerGate = held.promise
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const launch = vi
      .spyOn(electron, 'launch')
      .mockImplementation(async () => controlledApp(fixture.directory))
    const operation = (
      kind === 'app' ? fixture.launch() : fixture.runNativeCommand('codex', ['-e', ''])
    ).catch((error: unknown) => error)
    let disposed = false
    try {
      await expect.poll(() => probe.owners.length).toBe(1)
      const disposal = fixture.dispose().then(() => {
        disposed = true
        return undefined
      })
      await new Promise<void>((done) => setTimeout(done, 50))
      expect(disposed).toBe(false)
      expect((await stat(fixture.directory)).isDirectory()).toBe(true)
      held.resolve()
      await expect(operation).resolves.toBeInstanceOf(Error)
      await disposal
      expect(launch).not.toHaveBeenCalled()
      expect(probe.owners[0]?.released).toBe(1)
      await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      held.resolve()
      await operation
      await fixture.dispose().catch(() => undefined)
      launch.mockRestore()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it('drains a pending Native initialization before releasing its fixture and rejects the late client', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  const held = gate()
  probe.nativeInitializeGate = held.promise
  const fixture = await createRuntimeFixture({
    mode: 'real',
    configuration: {
      claudePath: process.execPath,
      codexPath: process.execPath,
      models: { claude: null, codex: null },
      configurationFingerprint: 'controlled-admission',
      sourceHashes: [],
      redact: (text) => text,
      assertSourceIntegrity: async () => undefined,
    },
  })
  const marker = join(fixture.directory, 'initializing-native-marker')
  await writeFile(marker, 'pending initialization owns private storage')
  const operation = fixture.openCodexClient().catch((error: unknown) => error)
  try {
    await expect.poll(() => probe.clients.length).toBe(1)
    let settled = false
    const disposal = fixture.dispose()
    void disposal.then(
      () => {
        settled = true
        return undefined
      },
      () => {
        settled = true
        return undefined
      },
    )
    await new Promise<void>((done) => setImmediate(done))
    expect(settled).toBe(false)
    expect(await readFile(marker, 'utf8')).toBe('pending initialization owns private storage')
    held.resolve()
    await expect(operation).resolves.toBeInstanceOf(Error)
    await disposal
    expect(fixture.dispose()).toBe(disposal)
    expect(probe.clients).toEqual([{ initialized: true, released: true, closeCalls: 1 }])
    await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    held.resolve()
    await operation
    await fixture.dispose().catch(() => undefined)
    // The Native client is a lifecycle-only fake with no child process.
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('drains an admitted real Node command before deleting its fixture on every platform', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  const fixture = await createRuntimeFixture({
    mode: 'real',
    configuration: {
      claudePath: process.execPath,
      codexPath: process.execPath,
      models: { claude: null, codex: null },
      configurationFingerprint: 'controlled-node-command',
      sourceHashes: [],
      redact: (text) => text,
      assertSourceIntegrity: async () => undefined,
    },
  })
  const control = await mkdtemp(join(tmpdir(), 'pact-command-lifecycle-'))
  const readyPath = join(control, 'ready')
  const releasePath = join(control, 'release')
  const marker = join(fixture.directory, 'pending-command-marker')
  await writeFile(marker, 'real command still owns private storage')
  const command = fixture.runNativeCommand('codex', [
    '-e',
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.stdout.write('command-drained'); } }, 10);`,
  ])
  try {
    await expect
      .poll(() =>
        stat(readyPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    let settled = false
    const disposal = fixture.dispose()
    void disposal.then(
      () => {
        settled = true
        return undefined
      },
      () => {
        settled = true
        return undefined
      },
    )
    await new Promise<void>((done) => setImmediate(done))
    expect(settled).toBe(false)
    expect(await readFile(marker, 'utf8')).toBe('real command still owns private storage')
    await writeFile(releasePath, 'release')
    await expect(command).resolves.toMatchObject({ exitCode: 0, stdout: 'command-drained' })
    await disposal
    expect(fixture.dispose()).toBe(disposal)
    await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await writeFile(releasePath, 'release')
    await command.catch(() => undefined)
    await fixture.dispose().catch(() => undefined)
    // The real Node command has settled and creates no helper processes.
    await rm(control, { recursive: true, force: true })
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('bounds three pending fixture operations and drains both client constructors and the app', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  const held = gate()
  probe.nativeInitializeGate = held.promise
  const fixture = await createRuntimeFixture({
    mode: 'real',
    configuration: {
      claudePath: process.execPath,
      codexPath: process.execPath,
      models: { claude: null, codex: null },
      configurationFingerprint: 'controlled-pending-capacity',
      sourceHashes: [],
      redact: (text) => text,
      assertSourceIntegrity: async () => undefined,
    },
  })
  const launch = vi.spyOn(electron, 'launch').mockImplementation(async () => {
    await held.promise
    return controlledApp(fixture.directory)
  })
  const operations = [fixture.launch(), fixture.openCodexClient(), fixture.openCodexClient()].map(
    (operation) => operation.catch((error: unknown) => error),
  )
  try {
    await expect.poll(() => probe.clients.length + launch.mock.calls.length).toBe(3)
    await expect(fixture.runNativeCommand('codex', ['--version'])).rejects.toThrow('capacity')
    expect(probe.clients).toHaveLength(2)
    expect(launch).toHaveBeenCalledOnce()
    const disposal = fixture.dispose()
    let settled = false
    void disposal.then(
      () => {
        settled = true
        return undefined
      },
      () => {
        settled = true
        return undefined
      },
    )
    await new Promise<void>((done) => setImmediate(done))
    expect(settled).toBe(false)
    expect((await stat(fixture.directory)).isDirectory()).toBe(true)
    held.resolve()
    const outcomes = await Promise.all(operations)
    expect(outcomes.every((outcome) => outcome instanceof Error)).toBe(true)
    await disposal
    expect(probe.clients.every((client) => client.released && client.closeCalls === 1)).toBe(true)
    await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    held.resolve()
    await Promise.all(operations)
    await fixture.dispose().catch(() => undefined)
    launch.mockRestore()
    // Controlled clients and Electron targets own no OS processes.
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
