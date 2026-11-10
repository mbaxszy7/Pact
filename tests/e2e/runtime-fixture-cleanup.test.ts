import { _electron as electron, test as playwrightTest } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

import type { ProviderConfiguration } from './provider-environment.js'

import { quitPact } from './native-quit.js'

const failureProbe = vi.hoisted(() => ({
  missingReceipt: false,
  creation: false,
  clientCloseFails: false,
  clientReleasedError: false,
  root: '',
  clients: [] as Array<{ released: boolean; closeCalls: number }>,
  credentialDisposeFails: false,
  credentialStores: [] as Array<{ disposeCalls: number }>,
}))

beforeEach(() => {
  // Native clients and Electron apps below are controlled lifecycle objects with
  // no OS processes. Reset only this test file's module-scoped reservations.
  vi.resetModules()
  failureProbe.missingReceipt = false
  failureProbe.creation = false
  failureProbe.clientCloseFails = false
  failureProbe.clientReleasedError = false
  failureProbe.root = ''
  failureProbe.clients = []
  failureProbe.credentialDisposeFails = false
  failureProbe.credentialStores = []
})

vi.mock('../native/native-harness.js', async (original) => {
  const actual = await original<typeof import('../native/native-harness.js')>()
  return {
    ...actual,
    NativeRpc: class {
      static async create(
        executable: string,
        cwd: string,
        environment: NodeJS.ProcessEnv,
        options: { group?: unknown; onReleased?: () => void } = {},
      ) {
        return new this(executable, cwd, environment, options.group, options.onReleased)
      }
      private readonly record = { released: false, closeCalls: 0 }
      private closing: Promise<void> | undefined

      constructor(
        _executable: string,
        _cwd: string,
        _environment: NodeJS.ProcessEnv,
        _group: unknown,
        private readonly onReleased?: () => void,
      ) {
        failureProbe.clients.push(this.record)
      }

      async initialize(): Promise<void> {}

      cleanupFacts(): { released: boolean } {
        return { released: this.record.released }
      }

      close(): Promise<void> {
        this.closing ??= Promise.resolve().then(() => {
          this.record.closeCalls++
          if (failureProbe.clientCloseFails) throw new Error('Controlled Native close failure')
          this.record.released = true
          this.onReleased?.()
          if (failureProbe.clientReleasedError)
            throw new Error('Controlled observation failure after physical release')
          return undefined
        })
        return this.closing
      }
    },
  }
})

vi.mock('./mac-credential-store.js', async (original) => {
  const actual = await original<typeof import('./mac-credential-store.js')>()
  return {
    ...actual,
    MacCredentialStore: class {
      private readonly record = { disposeCalls: 0 }

      constructor() {
        failureProbe.credentialStores.push(this.record)
      }

      async prepare(): Promise<void> {}

      async install(): Promise<void> {}

      dispose(): Promise<void> {
        this.record.disposeCalls++
        return failureProbe.credentialDisposeFails
          ? Promise.reject(new Error('Native credential store release is unconfirmed'))
          : Promise.resolve()
      }
    },
  }
})

vi.mock('./provider-environment.js', async (original) => {
  const actual = await original<typeof import('./provider-environment.js')>()
  return {
    ...actual,
    loadProviderConfiguration: async () => configuration,
    prepareProviderEnvironment: (root: string) => {
      failureProbe.root = root
      return actual.prepareProviderEnvironment(root)
    },
  }
})
vi.mock('./native-transport-fault.js', () => ({
  writeNativeTransportFault: async (root: string) => {
    if (failureProbe.creation) throw new Error('Original creation failure controlled-secret')
    const factsPath = join(root, 'controlled-facts')
    await mkdir(factsPath)
    return {
      executablePath: process.execPath,
      factsPath,
      controlPath: join(root, 'controlled-control.json'),
    }
  },
}))
vi.mock('./windows-cli-launcher.js', async (original) => {
  const actual = await original<typeof import('./windows-cli-launcher.js')>()
  return {
    ...actual,
    writeWindowsObservedLauncher: async (root: string) => {
      const directory = join(root, 'controlled-job')
      await mkdir(directory)
      const empty = failureProbe.missingReceipt
        ? Promise.reject(new Error('Missing authenticated release receipt'))
        : Promise.resolve({ generation: 'controlled-job', active: 0 as const, exitCode: 0 })
      void empty.catch(() => undefined)
      return {
        executablePath: process.execPath,
        directory,
        generation: 'controlled-job',
        started: Promise.resolve({ generation: 'controlled-job', pid: process.pid }),
        empty,
        armStartup: () => undefined,
        cancel: () => undefined,
        disposeControl: async () => undefined,
        diagnostic: () => ({ generation: 'controlled-job', stages: {} }),
      }
    },
  }
})

// Only disposal mechanics use controlled close receipts; no provider/business result is claimed.
const configuration: ProviderConfiguration = {
  claudePath: process.execPath,
  codexPath: process.execPath,
  models: { claude: null, codex: null },
  configurationFingerprint: 'controlled-cleanup',
  sourceHashes: [],
  redact: (text) => text.replaceAll('controlled-secret', '<redacted>'),
  assertSourceIntegrity: async () => undefined,
}

function controlledQuitApp(code: number, alreadyClosed: boolean) {
  const child = { pid: 1337, exitCode: alreadyClosed ? code : null, signalCode: null }
  const app = Object.assign(new EventEmitter(), {
    process: () => child,
    firstWindow: async () => ({
      isClosed: () => child.exitCode !== null,
      getByRole: () => ({
        waitFor: async () => {
          throw new Error('Controlled window closed')
        },
      }),
    }),
    waitForEvent: () => new Promise<void>((done) => app.once('close', done)),
    evaluate: async () => {
      child.exitCode = code
      app.emit('close')
    },
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled lifecycle boundaries verify diagnostics, not Windows kernel behavior.
  return app as unknown as Awaited<ReturnType<typeof electron.launch>>
}

function quitConfirmationRace() {
  const closed = Promise.withResolvers<void>()
  const clicked = Promise.withResolvers<void>()
  const child: { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    pid: 1337,
    exitCode: null,
    signalCode: null,
  }
  const click = vi.fn<() => Promise<void>>(() => clicked.promise)
  const evaluate = vi.fn<() => Promise<void>>(async () => undefined)
  const app = {
    process: () => child,
    firstWindow: async () => ({
      isClosed: () => child.exitCode !== null || child.signalCode !== null,
      getByRole: () => ({ waitFor: async () => undefined, click }),
    }),
    waitForEvent: () => closed.promise,
    evaluate,
  }
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Replay independent UI and physical-close events at the helper's Electron boundary.
    app: app as unknown as Awaited<ReturnType<typeof electron.launch>>,
    click,
    evaluate,
    clicked,
    closed,
    close(signal: NodeJS.Signals | null = null) {
      child.exitCode = signal ? null : 0
      child.signalCode = signal
      closed.resolve()
    },
  }
}

it.each(['close-first', 'click-error-first'] as const)(
  'accepts confirmed natural exit when the quit button disappears: %s',
  async (order) => {
    const f = quitConfirmationRace()
    const result = quitPact(f.app)
    const settled = result.then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(f.click).toHaveBeenCalledOnce())
    if (order === 'close-first') f.close()
    f.clicked.reject(new Error('The quit button detached during click'))
    if (order === 'click-error-first') {
      await Promise.resolve()
      f.close()
    }
    expect(await settled).toBeUndefined()
    await quitPact(f.app)
    expect(f.evaluate).toHaveBeenCalledOnce()
  },
)

it('keeps a failed quit click fatal when physical exit is not confirmed', async () => {
  const f = quitConfirmationRace()
  const failure = new Error('The exit control could not be clicked')
  const result = quitPact(f.app).catch((error: unknown) => error)
  await vi.waitFor(() => expect(f.click).toHaveBeenCalledOnce())
  f.clicked.reject(failure)
  await Promise.resolve()
  f.closed.reject(new Error('Physical exit was not observed before its deadline'))
  expect(await result).toBe(failure)
})

it('does not turn a forced exit during quit confirmation into successful cleanup', async () => {
  const f = quitConfirmationRace()
  const result = quitPact(f.app).then(
    () => false,
    () => true,
  )
  await vi.waitFor(() => expect(f.click).toHaveBeenCalledOnce())
  f.close('SIGTERM')
  f.clicked.reject(new Error('The quit button detached during click'))
  expect(await result).toBe(true)
})

it.each([true, false])(
  'keeps wrapper exit 1 fatal and records both observation phases; already closed=%s',
  async (alreadyClosed) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const { closeRealWorkspace } = await import('./real-harness.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const app = controlledQuitApp(1, alreadyClosed)
    let disposed = false
    const dispose = fixture.dispose.bind(fixture)
    vi.spyOn(fixture, 'dispose').mockImplementation(async () => {
      await dispose()
      disposed = true
    })
    vi.spyOn(fixture, 'appJobDiagnostic').mockImplementation(() => ({
      generation: 'same-generation',
      stages: disposed ? { started: 1, empty: 2 } : { started: 1 },
      firstFailure: 'controlled-secret',
      ...(disposed
        ? {
            lastActive: 0,
            exitCode: 0,
            rootExit: {
              pid: 1338,
              exitCode: 0,
              natural: true,
              elapsedMs: 20,
              active: 0,
              members: [],
              membersIncomplete: false,
            },
          }
        : {}),
    }))
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(closeRealWorkspace({ app, fixture })).rejects.toThrow('toBe')
      expect(disposed).toBe(true)
      await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(output).toHaveBeenCalledTimes(2)
      const text = JSON.stringify(output.mock.calls)
      expect(text).toContain('before-dispose')
      expect(text).toContain('after-dispose')
      expect(text).toContain('rootExit')
      expect(text).not.toContain('controlled-secret')
      expect(text).not.toContain(fixture.directory)
      const records = output.mock.calls.map(([, bytes]) => JSON.parse(String(bytes)))
      expect(records.map((record) => record.wrapper.exitCode)).toEqual([1, 1])
      expect(records.map((record) => record.job.generation)).toEqual([
        'same-generation',
        'same-generation',
      ])
      expect(records[0].job.rootExit).toBeUndefined()
      expect(records[1].job.rootExit.exitCode).toBe(0)
    } finally {
      output.mockRestore()
      await dispose()
    }
  },
)

it.each(['unavailable', 'overflow'] as const)(
  'a diagnostic %s cannot mask the original exit assertion or prevent cleanup',
  async (status) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const { closeRealWorkspace } = await import('./real-harness.js')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    vi.spyOn(fixture, 'appJobDiagnostic').mockImplementation(() => {
      if (status === 'unavailable') throw new Error('controlled-secret')
      return { generation: 'x'.repeat(16 * 1024), stages: {} }
    })
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        closeRealWorkspace({ app: controlledQuitApp(1, true), fixture }),
      ).rejects.toThrow('toBe')
      await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(output).toHaveBeenCalledTimes(2)
      expect(output.mock.calls.every(([, bytes]) => String(bytes).includes(status))).toBe(true)
      expect(JSON.stringify(output.mock.calls)).not.toContain('controlled-secret')
      expect(Buffer.byteLength(JSON.stringify(output.mock.calls))).toBeLessThan(16 * 1024)
    } finally {
      output.mockRestore()
      await fixture.dispose()
    }
  },
)

it('successful quit emits no failure observations', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  const { closeRealWorkspace } = await import('./real-harness.js')
  const fixture = await createRuntimeFixture({ mode: 'ui' })
  const read = vi.spyOn(fixture, 'appJobDiagnostic')
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    await closeRealWorkspace({ app: controlledQuitApp(0, true), fixture })
    expect(output).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  } finally {
    output.mockRestore()
    await fixture.dispose()
  }
})

it.skipIf(process.platform !== 'win32')(
  'keeps an original window error ahead of cleanup failure without a raw cause',
  async () => {
    const { launchRealWorkspace } = await import('./real-harness.js')
    const app = Object.assign(new EventEmitter(), {
      close: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('controlled cleanup failure')),
      firstWindow: async () => {
        throw new Error('Original window failure controlled-secret')
      },
      evaluate: async () => process.pid,
    })
    const launch = vi
      .spyOn(electron, 'launch')
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled lifecycle object; no Electron process is created.
      .mockResolvedValue(app as unknown as Awaited<ReturnType<typeof electron.launch>>)
    try {
      const result = await launchRealWorkspace('controlled-launch-failure').catch(
        (error: unknown) => error,
      )
      expect(result).toBeInstanceOf(Error)
      if (!(result instanceof Error)) throw new Error('Expected original launch error')
      expect(result.message).toContain(
        'Original window failure <redacted>; cleanup: Electron did not acknowledge shutdown',
      )
      expect(result.message).not.toContain('controlled-secret')
      expect(result.cause).toBeUndefined()
    } finally {
      launch.mockRestore()
      await rm(failureProbe.root, { recursive: true, force: true })
    }
  },
)

it('keeps an original creation error ahead of source-integrity cleanup failure', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  failureProbe.creation = true
  try {
    await expect(
      createRuntimeFixture({
        mode: 'real',
        configuration: {
          ...configuration,
          assertSourceIntegrity: async () => {
            throw new Error('controlled-secret')
          },
        },
        transportFault: 'hold-initialization',
      }),
    ).rejects.toThrow(
      'Original creation failure <redacted>; cleanup: An original provider configuration changed during the test',
    )
    await expect(stat(failureProbe.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    failureProbe.creation = false
  }
})

it.skipIf(process.platform !== 'win32').each(['app-close', 'job-receipt'] as const)(
  'keeps private files and the same failed disposal when %s is unconfirmed',
  async (failureKind) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    failureProbe.missingReceipt = failureKind === 'job-receipt'
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const marker = join(fixture.directory, 'private-marker')
    const failure = new Error('controlled close failure')
    const close = vi.fn<() => Promise<void>>()
    if (failureKind === 'app-close') close.mockRejectedValue(failure)
    else close.mockResolvedValue(undefined)
    const expectedFailure =
      failureKind === 'app-close'
        ? 'Electron did not acknowledge shutdown'
        : 'Missing authenticated release receipt'
    const app = Object.assign(new EventEmitter(), {
      close,
      firstWindow: async () => ({}),
      evaluate: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(process.pid)
        .mockResolvedValueOnce({
          userData: join(fixture.directory, 'electron-profile'),
          sessionData: join(fixture.directory, 'electron-session'),
          temp: join(fixture.directory, 'tmp'),
        })
        .mockResolvedValue(undefined),
    })
    const launch = vi
      .spyOn(electron, 'launch')
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This controlled app implements only the lifecycle interface exercised by fixture.launch/dispose.
      .mockResolvedValue(app as unknown as Awaited<ReturnType<typeof electron.launch>>)
    try {
      await writeFile(marker, 'owned private evidence')
      await fixture.launch()
      const disposal = fixture.dispose()
      await expect(disposal).rejects.toThrow(expectedFailure)
      expect(fixture.dispose()).toBe(disposal)
      await expect(fixture.dispose()).rejects.toThrow(expectedFailure)
      expect(close).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('owned private evidence')
      await expect(fixture.launch()).rejects.toThrow('disposed')
    } finally {
      failureProbe.missingReceipt = false
      launch.mockRestore()
      // There were no OS processes in this controlled fixture.
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'retains an unpublished initial candidate after independent Job release without fabricating closure',
  async () => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const output = await mkdtemp(join(tmpdir(), 'pact-cleanup-evidence-'))
    const attach = vi.fn<ReturnType<typeof playwrightTest.info>['attach']>()
    const info = vi.spyOn(playwrightTest, 'info').mockReturnValue(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the artifact sink is replaced; real fixture disposal is exercised.
      {
        outputPath: (name: string) => join(output, name),
        attach,
      } as unknown as ReturnType<typeof playwrightTest.info>,
    )
    const fixture = await createRuntimeFixture({
      mode: 'real',
      configuration,
      transportFault: 'hold-initialization',
    })
    try {
      await fixture.runNativeCommand('codex', ['-e', ''])
      const fact = { relayPid: 1, closed: false, entries: [], forwardedTurns: 0 }
      await writeFile(
        join(fixture.directory, 'controlled-facts', '1.json.tmp'),
        JSON.stringify(fact),
      )
      await fixture.dispose()
      expect(attach).toHaveBeenCalledOnce()
      const names = await readdir(output)
      expect(names).toHaveLength(1)
      expect(JSON.parse(await readFile(join(output, names[0]!), 'utf8'))).toEqual({
        physicalRelease: 'authenticated-fixture-jobs-empty',
        facts: [],
        unpublished: [{ source: '1.json.tmp', state: 'unpublished', fact }],
      })
      await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      info.mockRestore()
      await rm(output, { recursive: true, force: true })
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it
  .skipIf(process.platform !== 'win32')
  .each(['unclosed', 'invalid', 'unpublished-invalid', 'oversized'] as const)(
  'preserves private evidence when transport facts are %s',
  async (state) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({
      mode: 'real',
      configuration,
      transportFault: 'hold-initialization',
    })
    const path = join(
      fixture.directory,
      'controlled-facts',
      state === 'unpublished-invalid' || state === 'oversized' ? '1.json.tmp' : '1.json',
    )
    const body =
      state === 'oversized'
        ? JSON.stringify('x'.repeat(64 * 1024))
        : state === 'invalid' || state === 'unpublished-invalid'
          ? '{'
          : JSON.stringify({ relayPid: 1, closed: false, entries: [], forwardedTurns: 0 })
    try {
      await writeFile(path, body)
      await expect(fixture.dispose()).rejects.toThrow(
        state === 'unclosed'
          ? 'Actual Native transport child did not close before cleanup'
          : 'Actual Native transport closure facts could not be read',
      )
      expect(await readFile(path, 'utf8')).toBe(body)
      expect((await stat(fixture.codexHome)).isDirectory()).toBe(true)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
  10_000,
)

it('removes the private directory after confirmed closure and remains idempotent', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  const fixture = await createRuntimeFixture({ mode: 'ui' })
  const disposal = fixture.dispose()
  await disposal
  expect(fixture.dispose()).toBe(disposal)
  await expect(readdir(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['app', 'native-client'] as const)(
  'retains private evidence and the same failed disposal for an unconfirmed %s on every platform',
  async (kind) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({ mode: 'real', configuration })
    const marker = join(fixture.directory, 'private-marker')
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Controlled close failure'))
    const evaluate = vi.fn<() => Promise<unknown>>()
    if (process.platform === 'win32') evaluate.mockResolvedValueOnce(process.pid)
    evaluate
      .mockResolvedValueOnce({
        userData: join(fixture.directory, 'electron-profile'),
        sessionData: join(fixture.directory, 'electron-session'),
        temp: join(fixture.directory, 'tmp'),
      })
      .mockResolvedValue(undefined)
    const app = Object.assign(new EventEmitter(), {
      close,
      firstWindow: async () => ({}),
      evaluate,
    })
    const launch = vi
      .spyOn(electron, 'launch')
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- No Electron process exists; the real fixture owns a controlled close failure.
      .mockResolvedValue(app as unknown as Awaited<ReturnType<typeof electron.launch>>)
    try {
      await writeFile(marker, 'private evidence retained until physical release')
      if (kind === 'app') await fixture.launch()
      else {
        failureProbe.clientCloseFails = true
        await fixture.openCodexClient()
      }
      const disposal = fixture.dispose()
      const expected =
        kind === 'app'
          ? 'Electron did not acknowledge shutdown'
          : 'Owned Native client did not close'
      await expect(disposal).rejects.toThrow(expected)
      expect(fixture.dispose()).toBe(disposal)
      await expect(fixture.dispose()).rejects.toThrow(expected)
      expect(await readFile(marker, 'utf8')).toBe(
        'private evidence retained until physical release',
      )
      expect((await stat(fixture.codexHome)).isDirectory()).toBe(true)
      await expect(fixture.launch()).rejects.toThrow('disposed')
      await expect(fixture.openCodexClient()).rejects.toThrow('disposed')
      await expect(fixture.runNativeCommand('codex', ['--version'])).rejects.toThrow('disposed')
      expect(close).toHaveBeenCalledTimes(kind === 'app' ? 1 : 0)
      expect(failureProbe.clients).toEqual(
        kind === 'native-client' ? [{ released: false, closeCalls: 1 }] : [],
      )
    } finally {
      launch.mockRestore()
      // Controlled close objects own no OS processes. Failed production cleanup
      // remains observable above; only this test's private fake files are removed.
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
)

it('removes confirmed Native storage while preserving its cached observation error', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  failureProbe.clientReleasedError = true
  const fixture = await createRuntimeFixture({ mode: 'real', configuration })
  try {
    await fixture.openCodexClient()
    const disposal = fixture.dispose()
    await expect(disposal).rejects.toThrow('Owned Native client did not close')
    expect(fixture.dispose()).toBe(disposal)
    expect(failureProbe.clients).toEqual([{ released: true, closeCalls: 1 }])
    await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    // This Native object never starts an OS process; a failed assertion must not
    // leave the controlled private fixture on disk.
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('keeps all eight fixture reservations occupied after unconfirmed Native client release', async () => {
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  failureProbe.clientCloseFails = true
  const fixtures = []
  try {
    // oxlint-disable no-await-in-loop -- Fill the actual admission slots with separately failed controlled cleanup owners.
    for (let index = 0; index < 8; index++) {
      const fixture = await createRuntimeFixture({ mode: 'real', configuration })
      fixtures.push(fixture)
      await fixture.openCodexClient()
      await expect(fixture.dispose()).rejects.toThrow('Owned Native client did not close')
      expect((await stat(fixture.directory)).isDirectory()).toBe(true)
    }
    // oxlint-enable no-await-in-loop
    await expect(createRuntimeFixture({ mode: 'real', configuration })).rejects.toThrow(
      'at most eight fixtures',
    )
    expect(failureProbe.clients).toHaveLength(8)
    expect(
      failureProbe.clients.every((client) => !client.released && client.closeCalls === 1),
    ).toBe(true)
  } finally {
    // These mocked clients have never spawned a process. No real unconfirmed path is removed.
    await Promise.all(
      fixtures.map((fixture) => rm(fixture.directory, { recursive: true, force: true })),
    )
  }
})

it
  .skipIf(process.platform === 'win32')
  .each(['tmp-only', 'invalid', 'unpublished-invalid'] as const)(
  'does not infer POSIX transport closure from an empty published set with %s evidence',
  async (kind) => {
    const { createRuntimeFixture } = await import('./runtime-fixture.js')
    const fixture = await createRuntimeFixture({
      mode: 'real',
      configuration,
      transportFault: 'hold-initialization',
    })
    const path = join(
      fixture.directory,
      'controlled-facts',
      kind === 'invalid' ? '1.json' : '1.json.tmp',
    )
    const body =
      kind === 'tmp-only'
        ? JSON.stringify({ relayPid: 1, closed: false, entries: [], forwardedTurns: 0 })
        : '{'
    try {
      await writeFile(path, body)
      const disposal = fixture.dispose()
      await expect(disposal).rejects.toThrow(/transport.*(?:clos|fact)/iu)
      expect(fixture.dispose()).toBe(disposal)
      expect(await readFile(path, 'utf8')).toBe(body)
      expect((await stat(fixture.codexHome)).isDirectory()).toBe(true)
    } finally {
      // writeNativeTransportFault is a file-only mock here; no relay/CLI was started.
      await rm(fixture.directory, { recursive: true, force: true })
    }
  },
  10_000,
)

it('retains the directory and fixture reservation when native credential release fails', async () => {
  if (process.platform !== 'darwin') return
  const { createRuntimeFixture } = await import('./runtime-fixture.js')
  failureProbe.credentialDisposeFails = true
  const fixture = await createRuntimeFixture({
    mode: 'ui',
    nativeCredentialStore: true,
  })
  const retainers: Array<{ dispose(): Promise<void> }> = []
  try {
    expect(failureProbe.credentialStores).toHaveLength(1)
    await expect(fixture.dispose()).rejects.toThrow(/unconfirmed|retained/u)
    expect(failureProbe.credentialStores[0]?.disposeCalls).toBe(1)
    // An unconfirmed release retains the directory and the fixture reservation.
    expect((await stat(fixture.directory)).isDirectory()).toBe(true)
    for (let index = 0; index < 7; index++)
      // oxlint-disable-next-line no-await-in-loop -- Sequential reservations own the capacity count.
      retainers.push(await createRuntimeFixture({ mode: 'ui' }))
    await expect(createRuntimeFixture({ mode: 'ui' })).rejects.toThrow('eight')
  } finally {
    failureProbe.credentialDisposeFails = false
    for (const retainer of retainers)
      // oxlint-disable-next-line no-await-in-loop -- Each retainer must settle before manual cleanup.
      await retainer.dispose().catch(() => undefined)
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('releases a definite owned store after a cancelled create without a second delete', async () => {
  if (process.platform !== 'darwin') return
  const { MacCredentialStore } = await vi.importActual<typeof import('./mac-credential-store.js')>(
    './mac-credential-store.js',
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-')))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    let createGate!: (result: { exitCode: number; stdout: string; stderr: string }) => void
    const calls: string[][] = []
    const store = new MacCredentialStore({
      directory: root,
      environment: { HOME: home },
      isCurrent: () => true,
      run: (executable, args) => {
        calls.push([executable, ...args])
        if (args[0] === 'create')
          return new Promise<{ exitCode: number; stdout: string; stderr: string }>((done) => {
            createGate = done
          })
        if (args[0] === 'delete')
          return Promise.resolve({ exitCode: 0, stdout: '{"ok":true,"deleted":true}', stderr: '' })
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
      },
    })
    const preparing = store.prepare()
    await vi.waitFor(() => {
      expect(calls.some((call) => call[1] === 'create')).toBe(true)
    })
    const disposal = store.dispose()
    createGate({ exitCode: 0, stdout: '{"ok":true,"created":true}', stderr: '' })
    await expect(preparing).rejects.toThrow(/disposing|owner/u)
    await disposal
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(1)
    await store.dispose()
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains an unrecognised create receipt without any delete or retry', async () => {
  if (process.platform !== 'darwin') return
  const { MacCredentialStore } = await vi.importActual<typeof import('./mac-credential-store.js')>(
    './mac-credential-store.js',
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-')))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const calls: string[][] = []
    const store = new MacCredentialStore({
      directory: root,
      environment: { HOME: home },
      isCurrent: () => true,
      run: (executable, args) => {
        calls.push([executable, ...args])
        if (args[0] === 'create')
          return Promise.resolve({ exitCode: 0, stdout: 'not-json', stderr: '' })
        if (args[0] === 'delete')
          return Promise.resolve({ exitCode: 0, stdout: '{"ok":true,"deleted":true}', stderr: '' })
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
      },
    })
    await expect(store.prepare()).rejects.toThrow('unrecognised')
    await expect(store.dispose()).rejects.toThrow('unconfirmed')
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(0)
    await expect(store.dispose()).rejects.toThrow('unconfirmed')
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains a failed release even when the cleanup reply is shaped like success', async () => {
  if (process.platform !== 'darwin') return
  const { MacCredentialStore } = await vi.importActual<typeof import('./mac-credential-store.js')>(
    './mac-credential-store.js',
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-')))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const calls: string[][] = []
    const store = new MacCredentialStore({
      directory: root,
      environment: { HOME: home },
      isCurrent: () => true,
      run: (executable, args) => {
        calls.push([executable, ...args])
        if (args[0] === 'create')
          return Promise.resolve({
            exitCode: 2,
            stdout: '{"ok":false,"stage":"private-preferences","status":-1,"created":true}',
            stderr: '',
          })
        if (args[0] === 'delete')
          return Promise.resolve({
            exitCode: 1,
            stdout: '{"ok":true,"deleted":true}',
            stderr: '',
          })
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
      },
    })
    await expect(store.prepare()).rejects.toThrow('private-preferences')
    await expect(store.dispose()).rejects.toThrow('unconfirmed')
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(1)
    await expect(store.dispose()).rejects.toThrow('unconfirmed')
    expect(calls.filter((call) => call[1] === 'delete')).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
