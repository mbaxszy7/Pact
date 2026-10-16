import assert from 'node:assert/strict'
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getEventListeners, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OwnedProcessGroup, OwnedProcessIdentityError } from './owned-process-group'

interface ProcessIdentity {
  pid: number
  groupId: number
  state: string
  started: string
}

interface Fixture {
  directory: string
  owner: OwnedProcessGroup
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  identities: ProcessIdentity[]
}

const fixtures: Fixture[] = []
const directories: string[] = []

// These are private test processes. Their only external effects are two readiness files.
// Helpers remain in the root's process group and never access Provider configuration.
const fixtureProgram = String.raw`
const { spawn } = require('node:child_process')
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [mode, directory] = process.argv.slice(2)
const record = (name) => writeFileSync(join(directory, name + '.json'), JSON.stringify({ pid: process.pid }))
const keepAlive = () => setInterval(() => {}, 1000)
if (mode === 'helper' || mode === 'held-helper') {
  process.on('SIGTERM', () => { if (mode === 'held-helper') record('term') })
  record('helper')
  if (mode === 'held-helper') {
    setInterval(() => { if (existsSync(join(directory, 'release'))) process.exit(0) }, 10)
    setTimeout(() => process.exit(5), 15000)
  } else keepAlive()
} else {
  const startHelper = (ready, helperMode = 'helper') => {
    spawn(process.execPath, [__filename, helperMode, directory], { stdio: 'ignore', shell: false })
    const check = setInterval(() => {
      if (!existsSync(join(directory, 'helper.json'))) return
      clearInterval(check)
      ready()
    }, 5)
  }
  if (mode === 'stubborn') process.on('SIGTERM', () => {})
  if (mode === 'late-helper') {
    process.once('SIGTERM', () => setTimeout(() => startHelper(() => {}), 40))
    process.on('SIGTERM', () => {})
  }
  process.stdin.resume()
  if (mode === 'late-held-helper') process.stdin.once('end', () => {
    startHelper(() => process.exit(0), 'held-helper')
  })
  if (mode === 'eof') process.stdin.once('end', () => {
    writeFileSync(join(directory, 'eof.json'), JSON.stringify({ ended: true }))
    process.exit(0)
  })
  if (mode === 'orphan-helper' || mode === 'stubborn') startHelper(() => record('root'))
  else record('root')
  keepAlive()
}
`

function readIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const line = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line)
    return match
      ? { pid: Number(match[1]), groupId: Number(match[2]), state: match[3]!, started: match[4]! }
      : undefined
  } catch {
    return undefined
  }
}

function groupGone(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return false
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ESRCH') return true
    throw error
  }
}

async function readReadyPid(directory: string, name: string): Promise<number> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- One readiness file is polled under a fixed three-second deadline.
      const record: unknown = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
      if (typeof record === 'object' && record !== null) {
        const pid: unknown = Reflect.get(record, 'pid')
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) return pid
      }
    } catch (error) {
      // Opening the private readiness file can precede its writer's JSON bytes.
      // An incomplete record is not ready; every other I/O error stays fatal.
      if (
        !(error instanceof SyntaxError) &&
        (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT')
      )
        throw error
    }
    // oxlint-disable-next-line no-await-in-loop -- The bounded readiness poll yields between observations.
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Owned process fixture did not publish ${name} readiness.`)
}

async function createFixture(
  mode = 'normal',
  options: ConstructorParameters<typeof OwnedProcessGroup>[0] = {},
  childSignal?: AbortSignal,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-catalog-process-'))
  directories.push(directory)
  const program = join(directory, 'owned-probe.cjs')
  await writeFile(program, fixtureProgram)
  const owner = new OwnedProcessGroup(options)
  const child = owner.spawn(process.execPath, [program, mode, directory], {
    cwd: directory,
    ...(childSignal ? { signal: childSignal } : {}),
  })
  child.stdout.resume()
  child.stderr.resume()
  const fixture: Fixture = {
    directory,
    owner,
    child,
    closed: new Promise<void>((resolve) => child.once('close', () => resolve())),
    identities: [],
  }
  fixtures.push(fixture)
  const pid = await readReadyPid(directory, 'root')
  expect(pid).toBe(child.pid)
  if (process.platform !== 'win32') {
    const identity = readIdentity(pid)
    assert(identity, 'The owned fixture root must have a live POSIX identity.')
    assert.equal(identity.groupId, pid, 'The fixture must establish its own process group.')
    fixture.identities.push(identity)
    if (mode === 'orphan-helper' || mode === 'stubborn') await captureHelper(fixture)
  }
  expect(owner.released).toBe(false)
  return fixture
}

async function captureHelper(fixture: Fixture): Promise<ProcessIdentity> {
  const pid = await readReadyPid(fixture.directory, 'helper')
  const identity = readIdentity(pid)
  expect(identity).toBeDefined()
  expect(identity!.groupId).toBe(fixture.child.pid)
  fixture.identities.push(identity!)
  return identity!
}

async function expectReleased(fixture: Fixture): Promise<void> {
  await fixture.closed
  expect(fixture.owner.released).toBe(true)
  if (process.platform !== 'win32') {
    assert(groupGone(fixture.child.pid!), 'Release requires ESRCH for the original process group.')
    for (const identity of fixture.identities)
      assert.equal(
        readIdentity(identity.pid),
        undefined,
        'Every recorded fixture process must be gone.',
      )
  }
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      try {
        await fixture.owner.close()
      } catch {
        // A failed assertion must not leave the fixture alive. Signal only a group with a
        // still-matching identity captured from this private child/helper, never a name.
        if (process.platform === 'win32') {
          if (fixture.child.exitCode === null && fixture.child.signalCode === null)
            fixture.child.kill()
        } else {
          const anchor = fixture.identities.find((identity) => {
            const current = readIdentity(identity.pid)
            return (
              current?.started === identity.started &&
              current.groupId === identity.groupId &&
              !current.state.startsWith('Z')
            )
          })
          if (anchor) process.kill(-anchor.groupId, 'SIGKILL')
        }
      }
      await fixture.closed
    }),
  )
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
}

describe('Owned physical process groups', () => {
  it('preserves immutable capture facts and the first cleanup observation without changing the error', () => {
    const capture = {
      reason: 'missing' as const,
      initialPresent: false,
      refreshed: true,
      captureExited: false,
      captureClosed: false,
    }
    const failure = new OwnedProcessIdentityError(capture)
    expect(failure.message).toBe('The owned process did not establish its owned group.')
    expect(failure.diagnostic).toBeUndefined()
    capture.captureClosed = true
    failure.observeCleanup({
      cleanupExited: false,
      cleanupClosed: false,
      pidZero: 'success',
      groupZero: 'success',
    })
    failure.observeCleanup({
      cleanupExited: true,
      cleanupClosed: true,
      pidZero: 'ESRCH',
      groupZero: 'ESRCH',
    })
    expect(failure.diagnostic).toEqual({
      ...capture,
      captureClosed: false,
      cleanupExited: false,
      cleanupClosed: false,
      pidZero: 'success',
      groupZero: 'success',
    })
    expect(Object.isFrozen(failure.diagnostic)).toBe(true)
  })

  it('waits for a complete readiness record without accepting a partially written JSON file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-catalog-readiness-'))
    directories.push(directory)
    const path = join(directory, 'root.json')
    await writeFile(path, '')
    const observed = Promise.withResolvers<void>()
    const parse = JSON.parse
    const observer = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === '') observed.resolve()
      return parse(text, reviver)
    })
    try {
      const ready = readReadyPid(directory, 'root').then(
        (pid) => ({ pid }),
        (error: unknown) => ({ error }),
      )
      // Release the writer only after the reader actually saw the empty file.
      await observed.promise
      await writeFile(path, JSON.stringify({ pid: process.pid }))
      expect(await ready).toEqual({ pid: process.pid })
    } finally {
      observer.mockRestore()
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'keeps Windows input close exactly once after a synchronous failure',
    async () => {
      const closeInput = vi.fn<() => void>(() => {
        throw new Error('input close failed')
      })
      const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
      const closing = owner.close()
      expect(owner.close()).toBe(closing)
      await expect(closing).rejects.toThrow('input close failed')
      expect(closeInput).toHaveBeenCalledOnce()
      expect(owner.released).toBe(false)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'allows Windows EOF to settle before forced termination and releases its input listener',
    async () => {
      const closeInput = vi.fn<() => void>()
      const fixture = await createFixture('eof', { onCloseInput: closeInput })
      expect(fixture.child.stdin.listenerCount('error')).toBe(1)
      const closing = fixture.owner.close()
      expect(fixture.owner.close()).toBe(closing)
      await closing
      await expectReleased(fixture)
      expect(fixture.child.exitCode).toBe(0)
      expect(JSON.parse(await readFile(join(fixture.directory, 'eof.json'), 'utf8'))).toEqual({
        ended: true,
      })
      expect(closeInput).toHaveBeenCalledOnce()
      expect(fixture.child.stdin.listenerCount('error')).toBe(0)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'releases an already closed short-lived root without signalling a missed identity',
    async () => {
      for (let index = 0; index < 3; index++) {
        const closeInput = vi.fn<() => void>()
        const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
        const child = owner.spawn('/usr/bin/true', [])
        // oxlint-disable-next-line no-await-in-loop -- Each root is completely reaped before the next private process starts.
        await once(child, 'close')
        // oxlint-disable-next-line no-await-in-loop -- The observable cleanup gate follows that root's actual close.
        await expect(owner.close()).resolves.toBeUndefined()
        expect(owner.released).toBe(true)
        expect(() => process.kill(-child.pid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        )
        expect(closeInput).toHaveBeenCalledOnce()
      }
    },
  )
  it('awaits child close before reporting an idle probe released', async () => {
    const closeInput = vi.fn<() => void>()
    const fixture = await createFixture('normal', { onCloseInput: closeInput })
    await fixture.owner.close()
    expect(closeInput).toHaveBeenCalledOnce()
    await expectReleased(fixture)
  })

  it.skipIf(process.platform === 'win32')(
    'waits for actual absence when a closed root leaves a previously unobserved helper',
    async () => {
      let fixture: Fixture
      const closeInput = vi.fn<() => Promise<void>>(async () => {
        await writeFile(join(fixture.directory, 'release'), '')
      })
      fixture = await createFixture('late-held-helper', { onCloseInput: closeInput })
      await fixture.owner.observe()
      fixture.child.stdin.end()
      await captureHelper(fixture)
      await fixture.closed
      expect(groupGone(fixture.child.pid!)).toBe(false)
      await fixture.owner.close()
      await expectReleased(fixture)
      expect(closeInput).toHaveBeenCalledOnce()
      await expect(readFile(join(fixture.directory, 'term.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'retains a cached failure when an unverified helper outlives the original cleanup deadline',
    async () => {
      const closeInput = vi.fn<() => void>()
      const fixture = await createFixture('late-held-helper', { onCloseInput: closeInput })
      await fixture.owner.observe()
      fixture.child.stdin.end()
      const helper = await captureHelper(fixture)
      await fixture.closed
      const began = performance.now()
      const closing = fixture.owner.close()
      const failure = await closing.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(performance.now() - began).toBeGreaterThanOrEqual(3900)
      expect(fixture.owner.released).toBe(false)
      expect(fixture.owner.close()).toBe(closing)
      expect(readIdentity(helper.pid)).toMatchObject({
        groupId: helper.groupId,
        started: helper.started,
      })
      await expect(readFile(join(fixture.directory, 'term.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await writeFile(join(fixture.directory, 'release'), '')
      await expect.poll(() => groupGone(fixture.child.pid!)).toBe(true)
      expect(fixture.owner.released).toBe(false)
      expect(fixture.owner.close()).toBe(closing)
      await expect(fixture.owner.close()).rejects.toBe(failure)
      expect(closeInput).toHaveBeenCalledOnce()
    },
  )

  it('releases the bounded startup observation timer when its owner closes', async () => {
    const scope = new AsyncLocalStorage<symbol>(),
      token = Symbol('owned timer fixture')
    const timers = new Set<number>()
    let created = 0,
      overflow = false
    const observer = createHook({
      init(id, type) {
        if (type !== 'Timeout' || scope.getStore() !== token) return
        created++
        if (timers.size >= 128) overflow = true
        else timers.add(id)
      },
      destroy(id) {
        timers.delete(id)
      },
    }).enable()
    try {
      await scope.run(token, async () => {
        const fixture = await createFixture('normal', { startupObservationMs: 2_000 })
        await fixture.owner.close()
        await expectReleased(fixture)
      })
      // Node delivers timer destruction after clearTimeout. The observation
      // belongs only to this call chain, so ambient expiry cannot hide a leak.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(created).toBeGreaterThan(0)
      expect(overflow).toBe(false)
      expect(timers.size).toBe(0)
    } finally {
      observer.disable()
      scope.disable()
    }
  })

  it('keeps concurrently spawned catalog scopes in separate owned groups', async () => {
    const [first, second] = await Promise.all([createFixture(), createFixture()])
    expect(first.child.pid).not.toBe(second.child.pid)
    await Promise.all([first.owner.close(), second.owner.close()])
    await Promise.all([expectReleased(first), expectReleased(second)])
  })

  it.skipIf(process.platform === 'win32')(
    'releases a same-group helper born after the first close signal',
    async () => {
      const fixture = await createFixture('late-helper')
      const closing = fixture.owner.close()
      const helper = await captureHelper(fixture)
      expect(fixture.owner.released).toBe(false)
      expect(readIdentity(helper.pid)).toBeDefined()
      await closing
      await expectReleased(fixture)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not report release when the CLI closes before its TERM-resistant helper',
    async () => {
      const fixture = await createFixture('orphan-helper')
      const helper = fixture.identities[1]!
      const closing = fixture.owner.close()
      await fixture.closed
      expect(fixture.owner.released).toBe(false)
      expect(readIdentity(helper.pid)).toBeDefined()
      await closing
      await expectReleased(fixture)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'escalates shutdown for a root and helper that both ignore TERM',
    async () => {
      const fixture = await createFixture('stubborn')
      await fixture.owner.close()
      expect(fixture.child.signalCode).toBe('SIGKILL')
      await expectReleased(fixture)
    },
  )

  it('refuses to start a child after the owning signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const closeInput = vi.fn<() => void>()
    const owner = new OwnedProcessGroup({ signal: controller.signal, onCloseInput: closeInput })
    expect(() => owner.spawn(process.execPath, ['-e', 'process.exit(99)'], {})).toThrow(
      'cannot start another child',
    )
    await owner.close()
    expect(owner.released).toBe(true)
    expect(closeInput).toHaveBeenCalledOnce()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('closes a running child when its owning signal aborts', async () => {
    const controller = new AbortController()
    const closeInput = vi.fn<() => void>()
    const fixture = await createFixture('normal', {
      signal: controller.signal,
      onCloseInput: closeInput,
    })
    controller.abort()
    await vi.waitFor(() => expect(fixture.owner.released).toBe(true), {
      timeout: 4000,
      interval: 20,
    })
    await expectReleased(fixture)
    await fixture.owner.close()
    expect(closeInput).toHaveBeenCalledOnce()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('honors the SDK spawn signal without losing physical ownership', async () => {
    const controller = new AbortController()
    const fixture = await createFixture('normal', {}, controller.signal)
    controller.abort()
    await fixture.owner.close()
    await expectReleased(fixture)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('settles concurrent and repeated close once and releases cancellation listeners and timers', async () => {
    const controller = new AbortController()
    const closeInput = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve()
    })
    const fixture = await createFixture('normal', {
      signal: controller.signal,
      onCloseInput: closeInput,
    })
    const timersBeforeClose = timeoutCount()
    await Promise.all([fixture.owner.close(), fixture.owner.close(), fixture.owner.close()])
    await fixture.owner.close()
    controller.abort()
    await fixture.owner.close()
    expect(closeInput).toHaveBeenCalledOnce()
    await expectReleased(fixture)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(fixture.child.listenerCount('close')).toBe(0)
    expect(fixture.child.listenerCount('error')).toBe(0)
    expect(timeoutCount()).toBeLessThanOrEqual(timersBeforeClose)
  })
})
