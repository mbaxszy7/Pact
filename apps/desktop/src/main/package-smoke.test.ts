import type { BrowserWindow } from 'electron'

import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SqliteFinal } from '@pact/contracts'

const harness = vi.hoisted(() => ({
  finalWrite: undefined as ((signal: AbortSignal | undefined) => Promise<void>) | undefined,
  afterStartupClose: undefined as (() => void) | undefined,
  blockPhase: undefined as 'lstat' | 'read' | 'close' | undefined,
  enterBlocked: undefined as (() => void) | undefined,
  blocked: undefined as Promise<void> | undefined,
  appendSwitch: vi.fn<(name: string, value: string) => void>(),
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isReady: () => false,
    commandLine: { appendSwitch: harness.appendSwitch },
    quit: vi.fn<() => void>(),
    exit: vi.fn<(code: number) => void>(),
  },
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (harness.blockPhase === 'lstat') {
        harness.enterBlocked?.()
        await harness.blocked
      }
      return actual.lstat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (typeof args[0] === 'string' && args[0].endsWith('.sqlite-final')) {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async (data, options) => {
          const signal = options && typeof options === 'object' ? options.signal : undefined
          if (harness.finalWrite) return harness.finalWrite(signal)
          return write(data, options)
        }
      }
      if (
        harness.afterStartupClose &&
        typeof args[0] === 'string' &&
        args[0].endsWith('receipt.json')
      ) {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          harness.afterStartupClose?.()
        }
      }
      if (typeof args[0] === 'string' && args[0].endsWith('receipt.json')) {
        const read = handle.read.bind(handle)
        // Hold only scheduling; the genuine descriptor retains its original read arguments and result.
        handle.read = (async (...values: Parameters<typeof handle.read>) => {
          if (harness.blockPhase === 'read') {
            harness.enterBlocked?.()
            await harness.blocked
          }
          return Reflect.apply(read, handle, values)
        }) as typeof handle.read
        const close = handle.close.bind(handle)
        handle.close = async () => {
          if (harness.blockPhase === 'close') {
            harness.enterBlocked?.()
            await harness.blocked
          }
          await close()
        }
      }
      return handle
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [file, , options] = args
      if (harness.finalWrite && typeof file === 'string' && file.endsWith('.sqlite-final')) {
        const signal: unknown =
          options && typeof options === 'object' ? Reflect.get(options, 'signal') : undefined
        return harness.finalWrite(signal instanceof AbortSignal ? signal : undefined)
      }
      return actual.writeFile(...args)
    },
  }
})
vi.mock('./product-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./product-identity')>()
  return {
    ...actual,
    readProductIdentity: () => ({
      smokeProtocolVersion: 2 as const,
      channel: 'stable' as const,
      productName: 'Pact' as const,
      appId: 'com.pact.desktop' as const,
      version: '0.1.0',
      sourceSha: 'a'.repeat(40),
      buildNumber: '1',
    }),
  }
})

let owner: typeof import('./package-smoke') | undefined
let root: string
const ownedRoots: string[] = []
const failure = 'Packaged soak final SQLite receipt could not be written.'

function finalReceipt(complete = true): SqliteFinal {
  return {
    schemaVersion: 1,
    scope: 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1',
    observerEpoch: '00000000-0000-4000-8000-000000000001',
    observerPid: 41001,
    recordWatermark: 0,
    acknowledgedThrough: 0,
    pageSequence: 0,
    tailRecords: [],
    counters: {
      operations: 0,
      transactions: 0,
      rowsReturned: 0,
      totalMs: 0,
      maxMs: 0,
      planOverflow: false,
      unsupportedOperations: false,
    },
    databaseClosed: complete,
    writerClosed: complete,
    collectionDisposed: complete,
  }
}

async function fixture(nested = false) {
  const parent = nested ? join(root, 'control') : root
  if (nested) mkdirSync(parent, { mode: 0o700 })
  const receipt = join(parent, 'receipt.json')
  vi.stubEnv('PACT_E2E_ROOT', root)
  vi.stubEnv('PACT_SOAK_RECEIPT_FILE', receipt)
  vi.stubEnv('PACT_SOAK_NONCE', 'a'.repeat(64))
  vi.stubEnv('PACT_SOAK_CDP_PORT', '41001')
  owner = await import('./package-smoke')
  owner.configurePackagedSoakInspection()
  const target = {
    targetInfo: { targetId: 'isolated-target', type: 'page', url: 'app://bundle/index.html' },
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This Electron test double supplies only the window identity/debugger operations exercised by the real receipt owner.
  const window = {
    id: 1,
    webContents: {
      id: 2,
      getURL: () => 'app://bundle/index.html',
      debugger: {
        attach: () => undefined,
        sendCommand: async () => target,
        isAttached: () => true,
        detach: () => undefined,
      },
    },
  } as unknown as BrowserWindow
  await owner.writePackagedSoakReceipt(window, Promise.resolve())
  return { owner, receipt, parent }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  harness.finalWrite = undefined
  harness.afterStartupClose = undefined
  harness.blockPhase = undefined
  harness.blocked = undefined
  harness.enterBlocked = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pact-sqlite-final-test-')))
  ownedRoots.push(root)
})
afterEach(async () => {
  await owner?.disposePackagedSoakInspection()
  owner = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of ownedRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Packaged fixture SQLite final receipt owner', () => {
  it('leaves ordinary launches unchanged when the inspection fixture is not configured', async () => {
    vi.stubEnv('PACT_SOAK_RECEIPT_FILE', undefined)
    vi.stubEnv('PACT_SOAK_NONCE', undefined)
    vi.stubEnv('PACT_SOAK_CDP_PORT', undefined)
    owner = await import('./package-smoke')
    owner.configurePackagedSoakInspection()
    await expect(owner.writePackagedSoakSqliteFinal(undefined)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([true, false])(
    'writes the actual %s final facts to a separate identity-bound regular private file',
    async (complete) => {
      const f = await fixture()
      const startup = await readFile(f.receipt, 'utf8')
      const final = finalReceipt(complete)
      await f.owner.writePackagedSoakSqliteFinal(final)
      const file = `${f.receipt}.sqlite-final`
      const bytes = await readFile(file, 'utf8')
      const contents: unknown = JSON.parse(bytes)
      expect(contents).toEqual({
        schemaVersion: 1,
        nonce: 'a'.repeat(64),
        mainPid: process.pid,
        utilityPid: 41001,
        sourceSha: 'a'.repeat(40),
        version: '0.1.0',
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        sqliteFinal: final,
      })
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(32 * 1024)
      const info = await lstat(file)
      expect(info.isFile()).toBe(true)
      expect(info.isSymbolicLink()).toBe(false)
      expect(info.nlink).toBe(1)
      expect(process.platform === 'win32' || (info.mode & 0o777) === 0o600).toBe(true)
      expect(await readFile(f.receipt, 'utf8')).toBe(startup)
    },
  )

  it('requires a final receipt and never overwrites a previous one', async () => {
    const f = await fixture()
    await expect(f.owner.writePackagedSoakSqliteFinal(undefined)).rejects.toThrow(failure)
    await f.owner.writePackagedSoakSqliteFinal(finalReceipt())
    const original = await readFile(`${f.receipt}.sqlite-final`, 'utf8')
    await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt(false))).rejects.toThrow(failure)
    expect(await readFile(`${f.receipt}.sqlite-final`, 'utf8')).toBe(original)
  })

  it('rejects changed startup identity without publishing a tail receipt', async () => {
    const f = await fixture()
    await writeFile(f.receipt, '{}\n')
    await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt())).rejects.toThrow(failure)
    await expect(lstat(`${f.receipt}.sqlite-final`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a parent replaced by a symbolic link before writing', async () => {
    const f = await fixture(true)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pact-sqlite-final-outside-')))
    ownedRoots.push(outside)
    renameSync(f.parent, join(root, 'preserved-control'))
    symlinkSync(outside, f.parent, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt())).rejects.toThrow(failure)
    await expect(lstat(join(outside, 'receipt.json.sqlite-final'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a replaced regular parent even when its startup bytes are copied unchanged', async () => {
    const f = await fixture(true)
    const original = join(root, 'original-control')
    renameSync(f.parent, original)
    mkdirSync(f.parent, { mode: 0o700 })
    copyFileSync(join(original, 'receipt.json'), f.receipt)
    await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt())).rejects.toThrow(failure)
    await expect(lstat(`${f.receipt}.sqlite-final`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never writes the nonce through a parent changed after reading the startup receipt', async () => {
    const f = await fixture(true)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pact-final-late-outside-')))
    ownedRoots.push(outside)
    harness.afterStartupClose = () => {
      harness.afterStartupClose = undefined
      renameSync(f.parent, join(root, 'original-control'))
      symlinkSync(outside, f.parent, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt())).rejects.toThrow(failure)
    const outsideBytes = await readFile(join(outside, 'receipt.json.sqlite-final'), 'utf8').catch(
      (error: unknown) => {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return ''
        throw error
      },
    )
    expect(outsideBytes).toBe('')
  })

  it('blocks a schema-valid payload that exceeds the independent 32-KiB receipt bound', async () => {
    const f = await fixture()
    const final = finalReceipt()
    final.recordWatermark = 1
    final.tailRecords = [
      {
        recordSequence: 1,
        schemaVersion: 0,
        sqlSha256: 'a'.repeat(64),
        details: Array.from({ length: 64 }, () => 'x'.repeat(512)),
      },
    ]
    await expect(f.owner.writePackagedSoakSqliteFinal(final)).rejects.toThrow(failure)
    await expect(lstat(`${f.receipt}.sqlite-final`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts a blocked receipt write at five seconds and reports only a fixed error', async () => {
    const f = await fixture()
    let beginWrite: (() => void) | undefined
    const writeEntered = new Promise<void>((resolve) => {
      beginWrite = resolve
    })
    harness.finalWrite = (signal) =>
      new Promise((_, reject) => {
        if (!signal) throw new Error('Missing bounded write signal.')
        beginWrite?.()
        signal.addEventListener('abort', () => reject(new Error('private-path-canary')), {
          once: true,
        })
      })
    const pending = f.owner.writePackagedSoakSqliteFinal(finalReceipt())
    let rejection: unknown
    const checked = pending.catch((error: unknown) => {
      rejection = error
    })
    await writeEntered
    await vi.advanceTimersByTimeAsync(5000)
    await checked
    expect(rejection).toEqual(new Error(failure))
    // An empty exclusive file is the still-owned publication reservation; it is
    // not a valid receipt and contains none of the private payload.
    expect(await readFile(`${f.receipt}.sqlite-final`, 'utf8')).toBe('')
  })

  it.each(['lstat', 'read', 'close'] as const)(
    'bounds a stalled %s without later publishing or reusing its owner',
    async (phase) => {
      const f = await fixture()
      let entered!: () => void, release!: () => void
      const atOperation = new Promise<void>((resolve) => {
        entered = resolve
      })
      harness.blockPhase = phase
      harness.enterBlocked = entered
      harness.blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      let outcome: unknown
      const pending = f.owner
        .writePackagedSoakSqliteFinal(finalReceipt())
        .catch((error: unknown) => {
          outcome = error
        })
      try {
        await atOperation
        await vi.advanceTimersByTimeAsync(5000)
        expect(outcome).toEqual(new Error(failure))
        await expect(f.owner.writePackagedSoakSqliteFinal(finalReceipt())).rejects.toThrow(failure)
      } finally {
        harness.blockPhase = undefined
        release()
        await pending
        await f.owner.disposePackagedSoakInspection()
      }
      await expect(lstat(`${f.receipt}.sqlite-final`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('does not attach an earlier disposal to a later stalled final publication', async () => {
    const f = await fixture()
    let enterStop!: () => void,
      releaseStop!: () => void,
      enterFinal!: () => void,
      releaseFinal!: () => void
    const stopEntered = new Promise<void>((resolve) => {
      enterStop = resolve
    })
    harness.blockPhase = 'lstat'
    harness.enterBlocked = enterStop
    harness.blocked = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    await vi.advanceTimersByTimeAsync(250)
    await stopEntered
    let disposalSettled = false
    const disposal = f.owner.disposePackagedSoakInspection().then(() => {
      disposalSettled = true
      return undefined
    })
    const finalEntered = new Promise<void>((resolve) => {
      enterFinal = resolve
    })
    harness.enterBlocked = enterFinal
    harness.blocked = new Promise<void>((resolve) => {
      releaseFinal = resolve
    })
    let outcome: unknown
    const publication = f.owner
      .writePackagedSoakSqliteFinal(finalReceipt())
      .catch((error: unknown) => {
        outcome = error
      })
    try {
      await finalEntered
      releaseStop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(outcome).toEqual(new Error(failure))
      expect(disposalSettled).toBe(true)
    } finally {
      harness.blockPhase = undefined
      releaseStop()
      releaseFinal()
      await Promise.all([disposal, publication])
      await f.owner.disposePackagedSoakInspection()
    }
    await expect(lstat(`${f.receipt}.sqlite-final`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
