import { ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { NativeWorkingMemory } from './conversation/native-working-memory.js'
import { WindowsOwnedProcess } from './win32-owned-process-group.js'

const seam = vi.hoisted(() => ({ spawn: undefined as (() => ChildProcess) | undefined }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      seam.spawn ? seam.spawn() : actual.spawn(...args),
  }
})
afterEach(() => {
  seam.spawn = undefined
})

// The actual OS no-PID error and a controlled startup ordering seam exercise
// the product facade. Neither supplies a fabricated Windows Job receipt.
it.each([
  'actual OS rejection',
  'control unavailable before delayed OS error',
  'admitted helper error',
])('preserves only proven OS spawn errors: %s', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-windows-startup-')))
  const memory = new NativeWorkingMemory('business')
  const observed = Object.assign(new Error('Controlled OS rejection'), { code: 'ENOENT' })
  if (mode !== 'actual OS rejection')
    seam.spawn = () => {
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
        receiptDirectory: join(root, 'receipts'),
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
    expect(await readdir(join(root, 'receipts'))).toEqual([])
  } finally {
    await owner.close(Date.now() + 2000)
    await rm(root, { recursive: true, force: true })
  }
})
