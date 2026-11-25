import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

import { NativeWorkingMemory } from './conversation/native-working-memory.js'
import { OwnedProcessGroup } from './owned-process-group.js'
import { WINDOWS_OWNER_WORKSPACE_BYTES, WindowsOwnedProcess } from './win32-owned-process-group.js'

const seam = vi.hoisted(() => ({
  spawn: undefined as
    | ((
        command: string,
        args?: readonly string[],
        options?: SpawnOptions,
      ) => ChildProcess | undefined)
    | undefined,
  onReceiptOpen: undefined as ((handle: FileHandle, path: string) => FileHandle) | undefined,
  failReceiptOpen: undefined as (() => Error) | undefined,
  beforeReceiptLstat: undefined as ((path: string) => Promise<void> | void) | undefined,
  unlinkCalls: 0,
}))
function isSpawnOptions(
  value: readonly string[] | SpawnOptions | undefined,
): value is SpawnOptions {
  return value !== undefined && !Array.isArray(value)
}

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const second = args[1]
      const argList = Array.isArray(second) ? second : undefined
      const rawOptions = Array.isArray(second) ? args[2] : second
      const mocked = seam.spawn?.(
        args[0],
        argList,
        isSpawnOptions(rawOptions) ? rawOptions : undefined,
      )
      return mocked ?? actual.spawn(...args)
    },
  }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const pathText = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (seam.beforeReceiptLstat && pathText.endsWith('.receipt')) {
        await seam.beforeReceiptLstat(pathText)
      }
      return actual.lstat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const pathText = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (seam.failReceiptOpen && pathText.endsWith('.receipt')) {
        throw seam.failReceiptOpen()
      }
      const handle = await actual.open(...args)
      if (seam.onReceiptOpen && pathText.endsWith('.receipt')) {
        return seam.onReceiptOpen(handle, pathText)
      }
      return handle
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      seam.unlinkCalls += 1
      return actual.unlink(...args)
    },
  }
})
afterEach(() => {
  seam.spawn = undefined
  seam.onReceiptOpen = undefined
  seam.failReceiptOpen = undefined
  seam.beforeReceiptLstat = undefined
  seam.unlinkCalls = 0
  vi.useRealTimers()
})

// The actual OS no-PID error and a controlled startup ordering seam exercise
// the product facade. Neither supplies a fabricated Windows Job receipt.
it.each([
  'actual OS rejection',
  'control unavailable before delayed OS error',
  'admitted helper error',
])('preserves only proven OS spawn errors: %s', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-startup-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const observed = Object.assign(new Error('Controlled OS rejection'), { code: 'ENOENT' })
  let openedReceiptFd: number | undefined
  let abortAllocatedFd: unknown
  let receiptClosedBeforeAbort = false
  let receiptClosed = false

  seam.onReceiptOpen = (handle) => {
    openedReceiptFd = handle.fd
    const actualClose = handle.close.bind(handle)
    handle.close = async () => {
      receiptClosed = true
      await actualClose()
    }
    return handle
  }

  seam.spawn = (_command, args, options) => {
    const helperMode = args?.[0]
    if (helperMode === 'abort-allocated') {
      receiptClosedBeforeAbort = receiptClosed
      abortAllocatedFd = Array.isArray(options?.stdio) ? options.stdio[4] : undefined
      const helper = new ChildProcess()
      const control = createControlPipe(() => {
        void (async () => {
          const entries = await readdir(receiptsDir)
          await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
          control.pushFrame(Buffer.from([17, 1]))
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })()
      })
      Object.defineProperty(helper, 'pid', { value: 4322 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    if (mode === 'actual OS rejection') return undefined
    const helper = new ChildProcess()
    Object.defineProperty(helper, 'stdio', { value: [] })
    if (mode === 'admitted helper error') Object.defineProperty(helper, 'pid', { value: 4321 })
    setImmediate(() => {
      if (mode === 'admitted helper error') helper.emit('spawn')
      helper.emit('error', observed)
      helper.emit('close', 1, null)
    })
    return helper
  }
  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    { cwd: join(root, 'missing') },
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )
  const errors: Error[] = [],
    spawned = vi.fn<() => void>(),
    exited = vi.fn<() => void>()
  const failure = new Promise<Error>((resolve) => owner.child.once('error', resolve))
  owner.child.on('error', (error) => errors.push(error))
  owner.child.on('spawn', spawned)
  owner.child.on('exit', exited)
  try {
    const error = await failure
    await owner.close(Date.now() + 2000)
    expect(Reflect.get(error, 'code')).toBe(mode === 'admitted helper error' ? undefined : 'ENOENT')
    expect(error.message === 'Windows process ownership could not be confirmed.').toBe(
      mode === 'admitted helper error',
    )
    expect(errors).toHaveLength(1)
    expect(spawned).not.toHaveBeenCalled()
    expect(exited).not.toHaveBeenCalled()
    expect(owner.child.pid).toBeUndefined()
    expect(owner.child.exitCode).toBeNull()
    expect(owner.released).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(receiptClosedBeforeAbort).toBe(false)
    expect(abortAllocatedFd).toBe(openedReceiptFd)
    expect(receiptClosed).toBe(true)
    expect(await readdir(receiptsDir)).toEqual([])
  } finally {
    await owner.close(Date.now() + 2000)
    await rm(root, { recursive: true, force: true })
  }
})

function framePayload(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length)
  out.writeUInt32LE(payload.length, 0)
  payload.copy(out, 4)
  return out
}

function createControlPipe(onFrame: (frame: Buffer) => void): {
  stream: Duplex
  pushFrame: (payload: Buffer) => void
} {
  let pending = Buffer.alloc(0)
  const stream = new Duplex({
    read() {
      // Data is pushed explicitly by pushFrame.
    },
    write(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4) {
        const len = pending.readUInt32LE(0)
        if (pending.length < 4 + len) break
        const frame = pending.subarray(4, 4 + len)
        pending = pending.subarray(4 + len)
        onFrame(frame)
      }
      callback()
    },
  })
  return {
    stream,
    pushFrame(payload: Buffer) {
      stream.push(framePayload(payload))
    },
  }
}

it('completes late Windows prepare cleanup after close timeout once the helper finally closes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-late-prepare-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const prepareStarted = Promise.withResolvers<ChildProcess>()
  const modes: string[] = []
  let openedReceiptFd: number | undefined
  let abortAllocatedFd: unknown
  let receiptClosedAtAbort = false
  let receiptClosed = false

  seam.onReceiptOpen = (handle) => {
    openedReceiptFd = handle.fd
    const actualClose = handle.close.bind(handle)
    handle.close = async () => {
      receiptClosed = true
      await actualClose()
    }
    return handle
  }

  seam.spawn = (_command, args, options) => {
    const mode = args?.[0] ?? ''
    modes.push(mode)
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        // Intentionally ignore the prepare request so close(deadline) times out first.
      })
      Object.defineProperty(helper, 'pid', { value: 4410 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => {
        helper.emit('spawn')
        prepareStarted.resolve(helper)
      })
      return helper
    }
    if (mode === 'abort-allocated') {
      receiptClosedAtAbort = receiptClosed
      abortAllocatedFd = Array.isArray(options?.stdio) ? options.stdio[4] : undefined
      const control = createControlPipe(() => {
        void (async () => {
          const entries = await readdir(receiptsDir)
          await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
          control.pushFrame(Buffer.from([17, 1]))
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })()
      })
      Object.defineProperty(helper, 'pid', { value: 4411 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  try {
    const prepareHelper = await prepareStarted.promise
    await expect(owner.close(Date.now() + 40)).rejects.toThrow(
      /Windows process ownership could not be confirmed/u,
    )
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Helper closes late after the bounded close deadline expired.
    Object.defineProperty(prepareHelper, 'exitCode', { value: 1, configurable: true })
    prepareHelper.emit('close', 1, null)

    await vi.waitFor(() => {
      expect(owner.released).toBe(true)
    })
    expect(modes).toEqual(['prepare', 'abort-allocated'])
    expect(receiptClosedAtAbort).toBe(false)
    expect(abortAllocatedFd).toBe(openedReceiptFd)
    expect(receiptClosed).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(await readdir(receiptsDir)).toEqual([])
  } finally {
    await owner.close(Date.now() + 2000).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('completes late Windows run verification, receipt retirement, facade close, and memory release after close timeout', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-late-run-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const modes: string[] = []
  let runHelper: ChildProcess | undefined
  let stopObserved = false

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    modes.push(mode)
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        const reply = Buffer.alloc(37)
        reply[0] = 11
        reply.writeUInt32LE(process.pid, 1)
        reply.writeBigUInt64LE(12345n, 5)
        reply.writeBigUInt64LE(0x1122334455667788n, 13)
        Buffer.alloc(16, 0xab).copy(reply, 21)
        control.pushFrame(reply)
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4510 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'run') {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      helper.stdin = stdin
      helper.stdout = stdout
      helper.stderr = stderr
      const control = createControlPipe((frame) => {
        if (frame[0] === 1) {
          const reply = Buffer.alloc(25)
          reply[0] = 12
          reply.writeUInt32LE(4520, 1)
          reply.writeBigUInt64LE(22222n, 5)
          reply.writeUInt32LE(5520, 13)
          reply.writeBigUInt64LE(33333n, 17)
          control.pushFrame(reply)
        } else if (frame[0] === 3) {
          stopObserved = true
          // Do not exit before owner.close(deadline) times out.
        }
      })
      Object.defineProperty(helper, 'pid', { value: 4520 })
      Object.defineProperty(helper, 'stdio', {
        value: [stdin, stdout, stderr, control.stream, null],
      })
      runHelper = helper
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'verify') {
      const control = createControlPipe(() => {
        control.pushFrame(Buffer.from([15, 1]))
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4530 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'retire') {
      const control = createControlPipe(() => {
        void (async () => {
          const entries = await readdir(receiptsDir)
          await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
          control.pushFrame(Buffer.from([17, 1]))
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })()
      })
      Object.defineProperty(helper, 'pid', { value: 4540 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  const spawned = new Promise<void>((resolve) => owner.child.once('spawn', resolve))
  let facadeClosed = false
  owner.child.once('close', () => {
    facadeClosed = true
  })

  try {
    await spawned
    expect(owner.child.pid).toBe(5520)
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Write the 256-byte flushed receipt that the run bridge produces before exiting.
    const receiptEntries = await readdir(receiptsDir)
    expect(receiptEntries).toHaveLength(1)
    await writeFile(join(receiptsDir, receiptEntries[0]!), Buffer.alloc(256, 0x5a))

    // Close times out while run helper is still alive.
    await expect(owner.close(Date.now() + 40)).rejects.toThrow(
      /Windows process ownership could not be confirmed/u,
    )
    expect(stopObserved).toBe(true)
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Run helper later closes without emitting frame 13 -> background late finalizer
    // verifies the flushed receipt, closes the receipt handle, retires it, closes facade,
    // releases memory, and flips owner.released to true.
    expect(runHelper).toBeDefined()
    Object.defineProperty(runHelper!, 'exitCode', { value: 0, configurable: true })
    runHelper!.emit('close', 0, null)

    await vi.waitFor(() => {
      expect(owner.released).toBe(true)
    })
    expect(modes).toEqual(['prepare', 'run', 'verify', 'retire'])
    expect(facadeClosed).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(await readdir(receiptsDir)).toEqual([])
  } finally {
    await owner.close(Date.now() + 2000).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('reports close timeout when receipt.close() lags after empty Job exit, then retires receipt once and releases resources when handle closes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-late-receipt-close-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const modes: string[] = []
  let retireCalls = 0
  let receiptCloseCalls = 0
  const receiptCloseStarted = Promise.withResolvers<void>()
  const releaseReceiptClose = Promise.withResolvers<void>()

  seam.onReceiptOpen = (handle) => {
    const actualClose = handle.close.bind(handle)
    handle.close = async () => {
      receiptCloseCalls += 1
      receiptCloseStarted.resolve()
      await releaseReceiptClose.promise
      await actualClose()
    }
    return handle
  }

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    modes.push(mode)
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        const reply = Buffer.alloc(37)
        reply[0] = 11
        reply.writeUInt32LE(process.pid, 1)
        reply.writeBigUInt64LE(12345n, 5)
        reply.writeBigUInt64LE(0x1122334455667788n, 13)
        Buffer.alloc(16, 0xab).copy(reply, 21)
        control.pushFrame(reply)
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4610 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'run') {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      helper.stdin = stdin
      helper.stdout = stdout
      helper.stderr = stderr
      const control = createControlPipe((frame) => {
        if (frame[0] === 1) {
          const reply = Buffer.alloc(25)
          reply[0] = 12
          reply.writeUInt32LE(4620, 1)
          reply.writeBigUInt64LE(22222n, 5)
          reply.writeUInt32LE(5620, 13)
          reply.writeBigUInt64LE(33333n, 17)
          control.pushFrame(reply)
        } else if (frame[0] === 3) {
          // Helper reports empty Job (frame 13) and exits promptly BEFORE receipt.close() runs.
          const rootExit = Buffer.alloc(5)
          rootExit[0] = 14
          rootExit.writeUInt32LE(0, 1)
          const empty = Buffer.alloc(5)
          empty[0] = 13
          empty.writeUInt32LE(0, 1)
          control.pushFrame(rootExit)
          control.pushFrame(empty)
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })
        }
      })
      Object.defineProperty(helper, 'pid', { value: 4620 })
      Object.defineProperty(helper, 'stdio', {
        value: [stdin, stdout, stderr, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'retire') {
      retireCalls += 1
      const control = createControlPipe(() => {
        void (async () => {
          const entries = await readdir(receiptsDir)
          await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
          control.pushFrame(Buffer.from([17, 1]))
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })()
      })
      Object.defineProperty(helper, 'pid', { value: 4640 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  const spawned = new Promise<void>((resolve) => owner.child.once('spawn', resolve))
  let facadeClosed = false
  owner.child.once('close', () => {
    facadeClosed = true
  })

  try {
    await spawned
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Caller times out strictly because receipt.close() is delayed after empty Job exit.
    await expect(owner.close(Date.now() + 40)).rejects.toThrow(
      /Windows process ownership could not be confirmed/u,
    )
    await receiptCloseStarted.promise
    expect(receiptCloseCalls).toBe(1)
    expect(retireCalls).toBe(0)
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Unblock the single in-flight receipt.close() -> background finalizer resumes,
    // retires the receipt exactly once, closes the facade, flips released, and frees 1 MiB.
    releaseReceiptClose.resolve()

    await vi.waitFor(() => {
      expect(owner.released).toBe(true)
    })
    expect(modes).toEqual(['prepare', 'run', 'retire'])
    expect(receiptCloseCalls).toBe(1)
    expect(retireCalls).toBe(1)
    expect(facadeClosed).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(await readdir(receiptsDir)).toEqual([])
  } finally {
    releaseReceiptClose.resolve()
    await owner.close(Date.now() + 2000).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('stays quarantined when post-close Windows verification fails to confirm empty Job', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-verify-fail-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const modes: string[] = []

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    modes.push(mode)
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        const reply = Buffer.alloc(37)
        reply[0] = 11
        reply.writeUInt32LE(process.pid, 1)
        reply.writeBigUInt64LE(12345n, 5)
        reply.writeBigUInt64LE(0x1122334455667788n, 13)
        Buffer.alloc(16, 0xab).copy(reply, 21)
        control.pushFrame(reply)
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4710 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'run') {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      helper.stdin = stdin
      helper.stdout = stdout
      helper.stderr = stderr
      const control = createControlPipe((frame) => {
        if (frame[0] === 1) {
          const reply = Buffer.alloc(25)
          reply[0] = 12
          reply.writeUInt32LE(4720, 1)
          reply.writeBigUInt64LE(22222n, 5)
          reply.writeUInt32LE(5720, 13)
          reply.writeBigUInt64LE(33333n, 17)
          control.pushFrame(reply)
        } else if (frame[0] === 3) {
          // Exits WITHOUT emitting empty-Job frame 13.
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
            helper.emit('close', 1, null)
          })
        }
      })
      Object.defineProperty(helper, 'pid', { value: 4720 })
      Object.defineProperty(helper, 'stdio', {
        value: [stdin, stdout, stderr, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    if (mode === 'verify') {
      const control = createControlPipe(() => {
        // Explicit verification failure (not empty).
        control.pushFrame(Buffer.from([15, 0]))
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4730 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }

    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  const spawned = new Promise<void>((resolve) => owner.child.once('spawn', resolve))
  try {
    await spawned
    const receiptEntries = await readdir(receiptsDir)
    await writeFile(join(receiptsDir, receiptEntries[0]!), Buffer.alloc(256, 0x5a))

    await expect(owner.close(Date.now() + 1000)).rejects.toThrow(
      /Windows process ownership could not be confirmed/u,
    )
    expect(modes).toEqual(['prepare', 'run', 'verify'])
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { label: 'removed', code: 1 },
  { label: 'already_absent', code: 2 },
] as const)(
  'converges late retire ($label) after close(deadline) and step deadline expire, releases 1 MiB once, and notifies OwnedProcessGroup.whenReleased()',
  async ({ code }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-late-retire-')))
    const receiptsDir = join(root, 'receipts')
    const memory = new NativeWorkingMemory('business')
    const modes: string[] = []
    const retireReceived = Promise.withResolvers<void>()
    let retireHelper: ChildProcess | undefined
    let retireControl: ReturnType<typeof createControlPipe> | undefined
    let retireCount = 0

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    seam.spawn = (_command, args) => {
      const mode = args?.[0] ?? ''
      modes.push(mode)
      const helper = new ChildProcess()
      if (mode === 'prepare') {
        const control = createControlPipe(() => {
          const reply = Buffer.alloc(37)
          reply[0] = 11
          reply.writeUInt32LE(process.pid, 1)
          reply.writeBigUInt64LE(12345n, 5)
          reply.writeBigUInt64LE(0x1122334455667788n, 13)
          Buffer.alloc(16, 0xab).copy(reply, 21)
          control.pushFrame(reply)
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })
        })
        Object.defineProperty(helper, 'pid', { value: 4810 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }

      if (mode === 'run') {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        helper.stdin = stdin
        helper.stdout = stdout
        helper.stderr = stderr
        const control = createControlPipe((frame) => {
          if (frame[0] === 1) {
            const reply = Buffer.alloc(25)
            reply[0] = 12
            reply.writeUInt32LE(4820, 1)
            reply.writeBigUInt64LE(22222n, 5)
            reply.writeUInt32LE(5820, 13)
            reply.writeBigUInt64LE(33333n, 17)
            control.pushFrame(reply)
          } else if (frame[0] === 3) {
            const rootExit = Buffer.alloc(5)
            rootExit[0] = 14
            rootExit.writeUInt32LE(0, 1)
            const empty = Buffer.alloc(5)
            empty[0] = 13
            empty.writeUInt32LE(0, 1)
            control.pushFrame(rootExit)
            control.pushFrame(empty)
            setImmediate(() => {
              Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
              helper.emit('close', 0, null)
            })
          }
        })
        Object.defineProperty(helper, 'pid', { value: 4820 })
        Object.defineProperty(helper, 'stdio', {
          value: [stdin, stdout, stderr, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }

      if (mode === 'retire') {
        retireCount += 1
        retireControl = createControlPipe(() => {
          retireReceived.resolve()
        })
        retireHelper = helper
        Object.defineProperty(helper, 'pid', { value: 4830 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, retireControl.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }

      throw new Error(`Unexpected Windows bridge mode: ${mode}`)
    }

    const releaseSpy = vi.spyOn(memory, 'reserve')
    let reservationReleaseCount = 0
    releaseSpy.mockImplementation((bytes) => {
      const reservation = NativeWorkingMemory.prototype.reserve.call(memory, bytes)
      const actualRelease = reservation.release.bind(reservation)
      reservation.release = () => {
        reservationReleaseCount += 1
        actualRelease()
      }
      return reservation
    })

    const group = new OwnedProcessGroup({
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    })
    const observerCalls = vi.fn<() => void>()
    const throwingObserver = vi.fn<() => void>(() => {
      throw new Error('Observer error must not prevent convergence')
    })
    group.onReleased(throwingObserver)
    group.onReleased(observerCalls)
    let whenReleasedSettled = false
    const releasedPromise = group.whenReleased().then(() => {
      whenReleasedSettled = true
      return undefined
    })

    try {
      const child = group.spawn(process.execPath, [])
      await new Promise<void>((resolve) => child.once('spawn', resolve))
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const closing = group.close(Date.now() + 40)
      const closingError = closing.then(
        () => undefined,
        (error: unknown) => error,
      )
      await retireReceived.promise
      expect(retireCount).toBe(1)

      // Advance past caller's 40ms close deadline -> caller observes timeout.
      await vi.advanceTimersByTimeAsync(45)
      expect(await closingError).toEqual(
        expect.objectContaining({
          message: 'Windows process ownership could not be confirmed.',
        }),
      )
      expect(group.released).toBe(false)
      expect(group.settledAfterCloseTimeout()).toBe(false)
      expect(whenReleasedSettled).toBe(false)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

      // Also advance past retire's own 4000ms step deadline BEFORE retire helper responds/exits.
      await vi.advanceTimersByTimeAsync(4_500)
      expect(group.released).toBe(false)
      expect(whenReleasedSettled).toBe(false)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

      // Now retire helper settles late: replies [17, code], exits 0, and closes control pipe.
      retireControl!.pushFrame(Buffer.from([17, code]))
      Object.defineProperty(retireHelper!, 'exitCode', { value: 0, configurable: true })
      retireHelper!.emit('close', 0, null)

      await releasedPromise
      expect(whenReleasedSettled).toBe(true)
      expect(group.released).toBe(true)
      expect(group.settledAfterCloseTimeout()).toBe(true)
      expect(throwingObserver).toHaveBeenCalledOnce()
      expect(observerCalls).toHaveBeenCalledOnce()
      expect(memory.bytes).toBe(0)
      expect(reservationReleaseCount).toBe(1)
      expect(modes).toEqual(['prepare', 'run', 'retire'])
      // Original caller's rejected close() promise must remain unchanged.
      expect(group.close()).toBe(closing)
      await expect(group.close()).rejects.toThrow(
        /Windows process ownership could not be confirmed/u,
      )
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      releaseSpy.mockRestore()
      if (retireHelper && retireHelper.exitCode === null) {
        Object.defineProperty(retireHelper, 'exitCode', { value: 1, configurable: true })
        retireHelper.emit('close', 1, null)
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('invokes abort-allocated via fd 4 before receipt.close() on pre-witness failure with zero raw unlink calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-abort-alloc-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const events: string[] = []
  let openedFd: number | undefined
  let inheritedFd: unknown

  seam.onReceiptOpen = (handle) => {
    openedFd = handle.fd
    events.push('receipt:open')
    const actualClose = handle.close.bind(handle)
    handle.close = async () => {
      events.push('receipt:close')
      await actualClose()
    }
    return handle
  }

  seam.spawn = (_command, args, options) => {
    const mode = args?.[0] ?? ''
    events.push(`spawn:${mode}`)
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        // Fail prepare before frame 11 so no witness is ever established.
        Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
        helper.emit('close', 1, null)
      })
      Object.defineProperty(helper, 'pid', { value: 4910 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    if (mode === 'abort-allocated') {
      inheritedFd = Array.isArray(options?.stdio) ? options.stdio[4] : undefined
      const control = createControlPipe(() => {
        events.push('abort-allocated:reply')
        control.pushFrame(Buffer.from([17, 1]))
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 4911 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  try {
    await new Promise<void>((resolve) => owner.child.once('error', () => resolve()))
    await owner.close(Date.now() + 2000)
    await owner.whenReleased()
    expect(owner.released).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(inheritedFd).toBe(openedFd)
    expect(seam.unlinkCalls).toBe(0)
    expect(events).toEqual([
      'receipt:open',
      'spawn:prepare',
      'spawn:abort-allocated',
      'abort-allocated:reply',
      'receipt:close',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('releases cleanly without spawning abort-allocated when receipt allocation never succeeded', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-no-alloc-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const spawnedModes: string[] = []

  seam.failReceiptOpen = () => Object.assign(new Error('Simulated EACCES'), { code: 'EACCES' })
  seam.spawn = (_command, args) => {
    spawnedModes.push(args?.[0] ?? '')
    throw new Error('No helper may spawn when receipt allocation failed.')
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  try {
    await new Promise<void>((resolve) => owner.child.once('error', () => resolve()))
    await owner.close(Date.now() + 2000)
    await owner.whenReleased()
    expect(owner.released).toBe(true)
    expect(memory.bytes).toBe(0)
    expect(spawnedModes).toEqual([])
    expect(seam.unlinkCalls).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['unverified-abort', 'receipt-close-failure'] as const)(
  'retains 1 MiB reservation when pre-witness cleanup fails via %s',
  async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-abort-fail-')))
    const receiptsDir = join(root, 'receipts')
    const memory = new NativeWorkingMemory('business')
    let realHandle: FileHandle | undefined

    seam.onReceiptOpen = (handle) => {
      realHandle = handle
      const actualClose = handle.close.bind(handle)
      if (scenario === 'receipt-close-failure') {
        handle.close = async () => {
          await actualClose()
          throw new Error('Simulated OS handle close failure')
        }
      }
      return handle
    }

    seam.spawn = (_command, args) => {
      const mode = args?.[0] ?? ''
      const helper = new ChildProcess()
      if (mode === 'prepare') {
        const control = createControlPipe(() => {
          Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
          helper.emit('close', 1, null)
        })
        Object.defineProperty(helper, 'pid', { value: 5010 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }
      if (mode === 'abort-allocated') {
        const control = createControlPipe(() => {
          if (scenario === 'unverified-abort') {
            control.pushFrame(Buffer.from([17, 0]))
            setImmediate(() => {
              Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
              helper.emit('close', 1, null)
            })
          } else {
            control.pushFrame(Buffer.from([17, 1]))
            setImmediate(() => {
              Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
              helper.emit('close', 0, null)
            })
          }
        })
        Object.defineProperty(helper, 'pid', { value: 5011 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }
      throw new Error(`Unexpected Windows bridge mode: ${mode}`)
    }

    const owner = new WindowsOwnedProcess(
      process.execPath,
      [],
      {},
      {
        windows: {
          windowsBridgeExecutable: await realpath(process.execPath),
          receiptDirectory: receiptsDir,
        },
        memory,
      },
    )
    let released = false
    void owner.whenReleased().then(() => {
      released = true
      return undefined
    })

    try {
      await new Promise<void>((resolve) => owner.child.once('error', () => resolve()))
      await expect(owner.close(Date.now() + 2000)).rejects.toThrow(
        /Windows process ownership could not be confirmed|Simulated OS handle close failure/u,
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(owner.released).toBe(false)
      expect(released).toBe(false)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
    } finally {
      if (realHandle && realHandle.fd >= 0) await realHandle.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('converges late abort-allocated handle deletion after close(deadline) and step deadline expire', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-late-abort-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  const abortReceived = Promise.withResolvers<void>()
  let abortHelper: ChildProcess | undefined
  let abortControl: ReturnType<typeof createControlPipe> | undefined
  let receiptClosed = false

  seam.onReceiptOpen = (handle) => {
    const actualClose = handle.close.bind(handle)
    handle.close = async () => {
      receiptClosed = true
      await actualClose()
    }
    return handle
  }

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
        helper.emit('close', 1, null)
      })
      Object.defineProperty(helper, 'pid', { value: 5110 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    if (mode === 'abort-allocated') {
      abortControl = createControlPipe(() => {
        abortReceived.resolve()
      })
      abortHelper = helper
      Object.defineProperty(helper, 'pid', { value: 5111 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, abortControl.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )
  let releasedNotified = false
  const releasedPromise = owner.whenReleased().then(() => {
    releasedNotified = true
    return undefined
  })

  try {
    await new Promise<void>((resolve) => owner.child.once('error', () => resolve()))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const closing = owner.close(Date.now() + 40)
    const closingError = closing.then(
      () => undefined,
      (error: unknown) => error,
    )
    await abortReceived.promise

    await vi.advanceTimersByTimeAsync(45)
    expect(await closingError).toEqual(
      expect.objectContaining({
        message: 'Windows process ownership could not be confirmed.',
      }),
    )
    expect(owner.released).toBe(false)
    expect(receiptClosed).toBe(false)
    expect(releasedNotified).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    // Advance past abort-allocated's 4000ms step timer before it replies.
    await vi.advanceTimersByTimeAsync(4_500)
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)

    abortControl!.pushFrame(Buffer.from([17, 1]))
    Object.defineProperty(abortHelper!, 'exitCode', { value: 0, configurable: true })
    abortHelper!.emit('close', 0, null)

    await releasedPromise
    expect(releasedNotified).toBe(true)
    expect(receiptClosed).toBe(true)
    expect(owner.released).toBe(true)
    expect(memory.bytes).toBe(0)
  } finally {
    vi.useRealTimers()
    if (abortHelper && abortHelper.exitCode === null) {
      Object.defineProperty(abortHelper, 'exitCode', { value: 1, configurable: true })
      abortHelper.emit('close', 1, null)
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('never treats retire exit code 0 without a matching frame 17 as confirmed release', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-retire-no-frame-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        const reply = Buffer.alloc(37)
        reply[0] = 11
        reply.writeUInt32LE(process.pid, 1)
        reply.writeBigUInt64LE(12345n, 5)
        reply.writeBigUInt64LE(0x1122334455667788n, 13)
        Buffer.alloc(16, 0xab).copy(reply, 21)
        control.pushFrame(reply)
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 5210 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    if (mode === 'run') {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      helper.stdin = stdin
      helper.stdout = stdout
      helper.stderr = stderr
      const control = createControlPipe((frame) => {
        if (frame[0] === 1) {
          const reply = Buffer.alloc(25)
          reply[0] = 12
          reply.writeUInt32LE(5220, 1)
          reply.writeBigUInt64LE(22222n, 5)
          reply.writeUInt32LE(6220, 13)
          reply.writeBigUInt64LE(33333n, 17)
          control.pushFrame(reply)
        } else if (frame[0] === 3) {
          const rootExit = Buffer.alloc(5)
          rootExit[0] = 14
          rootExit.writeUInt32LE(0, 1)
          const empty = Buffer.alloc(5)
          empty[0] = 13
          empty.writeUInt32LE(0, 1)
          control.pushFrame(rootExit)
          control.pushFrame(empty)
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })
        }
      })
      Object.defineProperty(helper, 'pid', { value: 5220 })
      Object.defineProperty(helper, 'stdio', {
        value: [stdin, stdout, stderr, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    if (mode === 'retire') {
      const control = createControlPipe(() => {
        // Exits 0 WITHOUT pushing frame [17, 1] or [17, 2].
        setImmediate(() => {
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })
      })
      Object.defineProperty(helper, 'pid', { value: 5230 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  try {
    await new Promise<void>((resolve) => owner.child.once('spawn', resolve))
    await expect(owner.close(Date.now() + 2000)).rejects.toMatchObject({
      message: 'Windows process ownership could not be confirmed.',
      code: 'unconfirmed_process',
      retryable: true,
    })
    expect(owner.released).toBe(false)
    expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['cancelled-before-start-frame', 'encoding-failed-before-start-frame'] as const)(
  'cleans up allocated Windows receipt without verify or quarantine when run helper fails before START frame (%s)',
  async (scenario) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), `pact-windows-pre-start-${scenario}-`)),
    )
    const receiptsDir = join(root, 'receipts')
    const memory = new NativeWorkingMemory('business')
    const modes: string[] = []
    const runFrames: number[] = []
    const runStarted = Promise.withResolvers<ChildProcess>()
    let runControlEnded = false

    seam.spawn = (_command, args) => {
      const mode = args?.[0] ?? ''
      modes.push(mode)
      const helper = new ChildProcess()
      if (mode === 'prepare') {
        const control = createControlPipe(() => {
          const reply = Buffer.alloc(37)
          reply[0] = 11
          reply.writeUInt32LE(process.pid, 1)
          reply.writeBigUInt64LE(12345n, 5)
          reply.writeBigUInt64LE(0x1122334455667788n, 13)
          Buffer.alloc(16, 0xab).copy(reply, 21)
          control.pushFrame(reply)
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })
        })
        Object.defineProperty(helper, 'pid', { value: 5310 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }

      if (mode === 'run') {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        helper.stdin = stdin
        helper.stdout = stdout
        helper.stderr = stderr
        const control = createControlPipe((frame) => {
          runFrames.push(frame[0] ?? -1)
        })
        control.stream.once('finish', () => {
          runControlEnded = true
          setImmediate(() => {
            Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true })
            helper.emit('close', 1, null)
          })
        })
        Object.defineProperty(helper, 'pid', { value: 5320 })
        Object.defineProperty(helper, 'stdio', {
          value: [stdin, stdout, stderr, control.stream, null],
        })
        if (scenario === 'cancelled-before-start-frame') {
          // Hold helper.startup until caller cancels before START can be written.
          runStarted.resolve(helper)
        } else {
          setImmediate(() => {
            helper.emit('spawn')
            runStarted.resolve(helper)
          })
        }
        return helper
      }

      if (mode === 'retire') {
        const control = createControlPipe(() => {
          void (async () => {
            const entries = await readdir(receiptsDir)
            await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
            control.pushFrame(Buffer.from([17, 1]))
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })()
        })
        Object.defineProperty(helper, 'pid', { value: 5330 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }

      throw new Error(`Unexpected Windows bridge mode: ${mode}`)
    }

    const args = scenario === 'encoding-failed-before-start-frame' ? ['x'.repeat(40_000)] : []
    const owner = new WindowsOwnedProcess(
      process.execPath,
      args,
      {},
      {
        windows: {
          windowsBridgeExecutable: await realpath(process.execPath),
          receiptDirectory: receiptsDir,
        },
        memory,
      },
    )

    try {
      const runHelper = await runStarted.promise
      if (scenario === 'cancelled-before-start-frame') {
        const closing = owner.close(Date.now() + 2_000)
        // Simulate delayed spawn event arriving only after cancellation closed the control pipe.
        setImmediate(() => runHelper.emit('spawn'))
        await closing
      } else {
        await new Promise<void>((resolve) => owner.child.once('error', () => resolve()))
        await owner.close(Date.now() + 2_000)
      }

      // MUST NEVER send STOP (frame 3) as first frame, MUST NOT call verify, MUST retire receipt and release cleanly.
      expect(runFrames).toEqual([])
      expect(runControlEnded).toBe(true)
      expect(modes).toEqual(['prepare', 'run', 'retire'])
      expect(owner.released).toBe(true)
      await owner.whenReleased()
      expect(memory.bytes).toBe(0)
      expect(await readdir(receiptsDir)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('tags WindowsOwnedProcess.close(deadline) timeout errors with code unconfirmed_process and retryable true', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-unconfirmed-code-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  let prepareHelper: ChildProcess | undefined
  const prepareStarted = Promise.withResolvers<void>()

  seam.spawn = (_command, args) => {
    const mode = args?.[0] ?? ''
    const helper = new ChildProcess()
    if (mode === 'prepare') {
      const control = createControlPipe(() => {
        // Hold without replying so close(deadline) times out.
      })
      Object.defineProperty(helper, 'pid', { value: 5410 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      prepareHelper = helper
      setImmediate(() => {
        helper.emit('spawn')
        prepareStarted.resolve()
      })
      return helper
    }
    if (mode === 'abort-allocated') {
      const control = createControlPipe(() => {
        void (async () => {
          const entries = await readdir(receiptsDir)
          await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
          control.pushFrame(Buffer.from([17, 1]))
          Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
          helper.emit('close', 0, null)
        })()
      })
      Object.defineProperty(helper, 'pid', { value: 5411 })
      Object.defineProperty(helper, 'stdio', {
        value: [null, null, null, control.stream, null],
      })
      setImmediate(() => helper.emit('spawn'))
      return helper
    }
    throw new Error(`Unexpected Windows bridge mode: ${mode}`)
  }

  const owner = new WindowsOwnedProcess(
    process.execPath,
    [],
    {},
    {
      windows: {
        windowsBridgeExecutable: await realpath(process.execPath),
        receiptDirectory: receiptsDir,
      },
      memory,
    },
  )

  try {
    await prepareStarted.promise
    await expect(owner.close(Date.now() + 30)).rejects.toMatchObject({
      message: 'Windows process ownership could not be confirmed.',
      code: 'unconfirmed_process',
      retryable: true,
    })
    Object.defineProperty(prepareHelper!, 'exitCode', { value: 1, configurable: true })
    prepareHelper!.emit('close', 1, null)
    await owner.whenReleased()
    expect(memory.bytes).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('tolerates concurrent receipt retirement (ENOENT on lstat) during allocateReceipt while still rejecting non-ENOENT errors', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-receipt-race-')))
  const receiptsDir = join(root, 'receipts')
  const memory = new NativeWorkingMemory('business')
  await mkdir(receiptsDir, { recursive: true })

  try {
    const priorReceiptPath = join(receiptsDir, `${randomUUID()}.receipt`)
    await writeFile(priorReceiptPath, '')

    let retiredOnce = false
    seam.beforeReceiptLstat = async (pathText) => {
      if (!retiredOnce && pathText === priorReceiptPath) {
        retiredOnce = true
        await unlink(priorReceiptPath)
      }
    }

    let prepareHelper: ChildProcess | undefined
    const prepareStarted = Promise.withResolvers<void>()
    seam.spawn = (_command, args) => {
      const mode = args?.[0] ?? ''
      const helper = new ChildProcess()
      if (mode === 'prepare') {
        const control = createControlPipe(() => {
          // Hold until test drives owner.close().
        })
        Object.defineProperty(helper, 'pid', { value: 6410 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        prepareHelper = helper
        setImmediate(() => {
          helper.emit('spawn')
          prepareStarted.resolve()
        })
        return helper
      }
      if (mode === 'abort-allocated') {
        const control = createControlPipe(() => {
          void (async () => {
            const entries = await readdir(receiptsDir)
            await Promise.all(entries.map((entry) => unlink(join(receiptsDir, entry))))
            control.pushFrame(Buffer.from([17, 1]))
            Object.defineProperty(helper, 'exitCode', { value: 0, configurable: true })
            helper.emit('close', 0, null)
          })()
        })
        Object.defineProperty(helper, 'pid', { value: 6411 })
        Object.defineProperty(helper, 'stdio', {
          value: [null, null, null, control.stream, null],
        })
        setImmediate(() => helper.emit('spawn'))
        return helper
      }
      throw new Error(`Unexpected Windows bridge mode: ${mode}`)
    }

    const owner = new WindowsOwnedProcess(
      process.execPath,
      [],
      {},
      {
        windows: {
          windowsBridgeExecutable: await realpath(process.execPath),
          receiptDirectory: receiptsDir,
        },
        memory,
      },
    )

    await prepareStarted.promise
    expect(retiredOnce).toBe(true)

    const closeTask = owner.close(Date.now() + 5_000)
    Object.defineProperty(prepareHelper!, 'exitCode', { value: 1, configurable: true })
    prepareHelper!.emit('close', 1, null)
    await closeTask
    await owner.whenReleased()
    expect(memory.bytes).toBe(0)
    expect(await readdir(receiptsDir)).toEqual([])

    // Phase 2: non-ENOENT lstat failure on an existing receipt must still fail startup cleanly.
    const existingReceipt = join(receiptsDir, `${randomUUID()}.receipt`)
    await writeFile(existingReceipt, '')
    seam.spawn = () => {
      throw new Error('helper should not spawn when receipt scan throws non-ENOENT')
    }
    seam.beforeReceiptLstat = (pathText) => {
      if (pathText === existingReceipt) {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      }
    }

    const erroredOwner = new WindowsOwnedProcess(
      process.execPath,
      [],
      {},
      {
        windows: {
          windowsBridgeExecutable: await realpath(process.execPath),
          receiptDirectory: receiptsDir,
        },
        memory,
      },
    )
    const childError = await new Promise<Error>((resolveError) => {
      erroredOwner.child.once('error', resolveError)
    })
    expect(childError).toBeInstanceOf(Error)
    await erroredOwner.close(Date.now() + 5_000)
    await erroredOwner.whenReleased()
    expect(erroredOwner.released).toBe(true)
    expect(memory.bytes).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
