import { _electron as electron, test as playwrightTest } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

import type { ProviderConfiguration } from './provider-environment.js'

const failureProbe = vi.hoisted(() => ({
  missingReceipt: false,
  creation: false,
  clientCloseFails: false,
  clientReleasedError: false,
  root: '',
  clients: [] as Array<{ released: boolean; closeCalls: number }>,
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
})

vi.mock('../native/native-harness.js', async (original) => {
  const actual = await original<typeof import('../native/native-harness.js')>()
  return {
    ...actual,
    NativeRpc: class {
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
