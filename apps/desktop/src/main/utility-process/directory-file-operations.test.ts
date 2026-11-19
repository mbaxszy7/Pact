import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  directoryFileOperationInputSchema,
  type DirectoryFileOperationInput,
} from '@pact/contracts'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeDirectoryChild {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: unknown[] = []
    readonly stdout = { resume: vi.fn<() => void>() }
    readonly stderr = { resume: vi.fn<() => void>() }
    killed = false
    exitOnKill = true
    pid = 4242
    on(event: string, listener: Listener): this {
      const entries = this.handlers.get(event) ?? []
      entries.push(listener)
      this.handlers.set(event, entries)
      return this
    }
    once(event: string, listener: Listener): this {
      const receive: Listener = (...args) => {
        this.removeListener(event, receive)
        listener(...args)
      }
      return this.on(event, receive)
    }
    removeListener(event: string, listener: Listener): this {
      const entries = this.handlers.get(event)
      if (entries)
        this.handlers.set(
          event,
          entries.filter((e) => e !== listener),
        )
      return this
    }
    postMessage(message: unknown): void {
      this.posted.push(message)
    }
    kill(): boolean {
      this.killed = true
      if (this.exitOnKill) this.emit('exit', 0)
      return true
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of (this.handlers.get(event) ?? []).slice()) listener(...args)
    }
  }
  const children: FakeDirectoryChild[] = []
  return { FakeDirectoryChild, children }
})

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new harness.FakeDirectoryChild()
      harness.children.push(child)
      return child
    },
  },
}))

import { DirectoryFileOperations } from './directory-file-operations'

const operation = (input: Record<string, unknown> = {}): DirectoryFileOperationInput =>
  directoryFileOperationInputSchema.parse({
    operation: 'preview',
    rootPath: '/',
    rootDevice: '1',
    rootInode: '2',
    directories: ['project'],
    name: 'file.md',
    deadlineAt: Date.now() + 5_000,
    ...input,
  })

const success = { ok: true as const, existed: true, hash: null, bytes: 1, mode: 0o644 }

const spawn = (child: (typeof harness.children)[number]): void => {
  child.emit('spawn')
}

let killSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
})

afterEach(() => {
  for (const child of harness.children.splice(0)) child.emit('exit', 0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('DirectoryFileOperations', () => {
  it('delivers a preview result only after the worker physically exits', async () => {
    const owner = new DirectoryFileOperations('/worker.js')
    const run = owner.execute(operation())
    const child = harness.children.at(-1)!
    spawn(child)
    expect(child.posted).toHaveLength(1)
    const settled = vi.fn<() => void>()
    void run.then(() => settled())
    child.emit('message', success)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    child.emit('exit', 0)
    await expect(run).resolves.toEqual(success)
    expect(settled).toHaveBeenCalledOnce()
  })

  it('caps admission at five owned workers and closes admission on dispose', async () => {
    vi.useFakeTimers()
    const owner = new DirectoryFileOperations('/worker.js')
    const runs = []
    for (let index = 0; index < 5; index += 1) {
      runs.push(owner.execute(operation()))
      spawn(harness.children.at(-1)!)
    }
    await expect(owner.execute(operation())).resolves.toMatchObject({
      ok: false,
      code: 'IO',
      message: 'All five protected directory workers are busy.',
    })
    const disposal = owner.dispose()
    await expect(owner.execute(operation())).resolves.toMatchObject({
      ok: false,
      code: 'CANCELLED',
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await disposal
    await Promise.all(runs)
  })

  it('rejects an already expired preview deadline before any fork', async () => {
    const owner = new DirectoryFileOperations('/worker.js')
    await expect(owner.execute(operation({ deadlineAt: Date.now() - 1 }))).resolves.toEqual({
      ok: false,
      code: 'CANCELLED',
      message: 'File preview timed out.',
    })
    expect(harness.children).toHaveLength(0)
  })

  it('uses the remaining preview deadline instead of the mutation bound', async () => {
    vi.useFakeTimers()
    const owner = new DirectoryFileOperations('/worker.js')
    const run = owner.execute(operation({ deadlineAt: Date.now() + 1_000 }))
    spawn(harness.children.at(-1)!)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(run).resolves.toMatchObject({
      ok: false,
      code: 'CANCELLED',
      message: 'The protected directory operation exceeded its deadline.',
    })
  })

  it('retains an unconfirmed worker slot after logical cancellation and settlement joins only on real exit', async () => {
    vi.useFakeTimers()
    const owner = new DirectoryFileOperations('/worker.js')
    const run = owner.execute(operation())
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    spawn(child)
    const joined = vi.fn<() => void>()
    const settlement = owner.settlement().then(() => joined())
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(run).resolves.toMatchObject({ ok: false, code: 'IO' })
    expect(joined).not.toHaveBeenCalled()
    await expect(owner.execute(operation())).resolves.toMatchObject({
      ok: false,
      code: 'IO',
      message: 'A previous file worker has not confirmed exit. This Project remains blocked.',
    })
    child.emit('exit', 0)
    await settlement
    expect(joined).toHaveBeenCalledOnce()
  })

  it('leaves no timers and never signals a real process when the killed child exits synchronously', async () => {
    vi.useFakeTimers()
    const owner = new DirectoryFileOperations('/worker.js')
    const run = owner.execute(operation())
    const child = harness.children.at(-1)!
    spawn(child)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(run).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(killSpy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves settlement immediately when no workers remain', async () => {
    const owner = new DirectoryFileOperations('/worker.js')
    await expect(owner.settlement()).resolves.toBeUndefined()
  })
})
