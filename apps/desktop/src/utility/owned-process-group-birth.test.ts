import type {
  ExecFileException,
  ExecFileOptionsWithStringEncoding,
  ChildProcessWithoutNullStreams,
} from 'node:child_process'

import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const observation = vi.hoisted(() => ({
  reads: 0,
  held: false,
  freshBad: false,
  firstBad: false,
  rootPid: 0,
  heldDelayMs: 0,
  freshDelayMs: 0,
  oldError: false,
  release: undefined as ((row: string) => void) | undefined,
  firstReady: undefined as (() => void) | undefined,
  rows: [] as Array<{ read: number; root: string | undefined }>,
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const read = file === '/bin/ps' ? ++observation.reads : 0
      return actual.execFile(file, args, options, (error, output, stderr) => {
        const change = (value: string): string =>
          value
            .split('\n')
            .map((line) => {
              const match = /^(\s*\d+\s+\d+\s+)(\d+)(\s+.+)$/u.exec(line)
              return Number(/^\s*(\d+)/u.exec(line)?.[1]) === observation.rootPid && match
                ? `${match[1]}1${match[3]}`
                : line
            })
            .join('\n')
        const deliver = (value: string): void => {
          if (file === '/bin/ps')
            observation.rows.push({
              read,
              root: value
                .split('\n')
                .find((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]) === observation.rootPid),
            })
          callback(error, value, stderr)
        }
        if (read === 1 && observation.held && !error) {
          observation.release = (row) => {
            const without = output
              .split('\n')
              .filter((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]) !== observation.rootPid)
              .join('\n')
            const replaced = without.trimEnd() + '\n' + row + '\n'
            const value = observation.firstBad ? change(replaced) : replaced
            if (observation.oldError)
              callback(new Error('Controlled earlier OS observation failure'), '', '')
            else if (observation.heldDelayMs)
              setTimeout(() => deliver(value), observation.heldDelayMs)
            else deliver(value)
          }
          observation.firstReady?.()
        } else {
          const value =
            (read >= 2 && observation.freshBad) || (read === 1 && observation.firstBad)
              ? change(output)
              : output
          if (observation.freshDelayMs) setTimeout(() => deliver(value), observation.freshDelayMs)
          else deliver(value)
        }
      })
    },
  }
})
import { OwnedProcessGroup, OwnedProcessIdentityError } from './owned-process-group'

const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }> = []
const owners: OwnedProcessGroup[] = []
const ownedChildren = new Map<OwnedProcessGroup, ChildProcessWithoutNullStreams>()
const releaseFixtureGates = new Set<() => void>()
beforeEach(() =>
  Object.assign(observation, {
    reads: 0,
    held: false,
    freshBad: false,
    firstBad: false,
    rootPid: 0,
    heldDelayMs: 0,
    freshDelayMs: 0,
    oldError: false,
    release: undefined,
    firstReady: undefined,
    rows: [],
  }),
)
afterEach(async () => {
  for (const { child } of children) child.stdin.end()
  // A timing assertion can fail before the test releases its deliberately held
  // callbacks. Teardown must not leave that observation blocking the next test.
  observation.release?.('')
  for (const release of releaseFixtureGates) release()
  releaseFixtureGates.clear()
  await Promise.allSettled(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(children.splice(0).map((value) => value.closed))
  ownedChildren.clear()
  vi.restoreAllMocks()
})
const program =
  "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));setTimeout(()=>process.exit(0),10000)"
function stdinOwner(): OwnedProcessGroup {
  const owner = new OwnedProcessGroup({
    onCloseInput: () => {
      ownedChildren.get(owner)?.stdin.end()
    },
  })
  return owner
}
function start(owner: OwnedProcessGroup, source = program): ChildProcessWithoutNullStreams {
  owners.push(owner)
  const child = owner.spawn(process.execPath, ['-e', source])
  ownedChildren.set(owner, child)
  child.stdout.resume()
  child.stderr.resume()
  children.push({ child, closed: once(child, 'close') })
  return child
}
function safeSignals() {
  const originalKill = process.kill.bind(process)
  return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0 && !children.some((value) => value.child.pid === Math.abs(pid)))
      throw new Error('A signal outside the private test children was suppressed.')
    return originalKill(pid, signal)
  })
}
function rootRow(pid: number): string {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 256 * 1024,
  }).trim()
}
function gone(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ESRCH') return true
    throw error
  }
}

it.skipIf(process.platform === 'win32').each([
  { firstBad: true, freshBad: false, accepted: true },
  { firstBad: false, freshBad: true, accepted: false },
  { firstBad: true, freshBad: true, accepted: false },
  { firstBad: false, freshBad: false, accepted: true },
])(
  'excludes every pre-spawn observation regardless of whether its row looks valid: $firstBad/$freshBad',
  async ({ firstBad, freshBad, accepted }) => {
    const ready = Promise.withResolvers<void>()
    Object.assign(observation, { held: true, firstBad, freshBad, firstReady: ready.resolve })
    const first = stdinOwner(),
      second = stdinOwner()
    const a = start(first)
    await ready.promise
    const b = start(second)
    observation.rootPid = b.pid!
    const actualRow = rootRow(b.pid!)
    const signals = safeSignals()
    const result = second.observe().then(
      () => undefined,
      (error: unknown) => error,
    )
    observation.release!(actualRow)
    const error = await result
    expect(error instanceof OwnedProcessIdentityError).toBe(!accepted)
    // A valid birth needs its two observations plus observe()'s separate live check.
    expect(observation.reads).toBe(accepted ? 3 : 2)
    expect(
      observation.rows
        .filter((row) => row.root)
        .map((row) => row.read)
        .slice(0, 2),
    ).toEqual([1, 2])
    expect(
      signals.mock.calls.filter(
        ([pid, signal]) => (pid === -b.pid! || pid === 1 || pid === -1) && signal !== 0,
      ),
    ).toEqual([])
    const closing = second.close()
    expect(second.close()).toBe(closing)
    const released = await closing.then(
      () => true,
      () => false,
    )
    expect(released).toBe(accepted)
    // Rejected identity cleanup closes input; it never signals the unknown group.
    expect(
      signals.mock.calls.filter(
        ([pid, signal]) => (pid === -b.pid! || pid === 1 || pid === -1) && signal !== 0,
      ).length > 0,
    ).toBe(accepted)
    await children[1]!.closed
    expect(gone(b.pid!)).toBe(true)
    observation.freshBad = false
    await first.close()
    await children[0]!.closed
    expect(gone(a.pid!)).toBe(true)
  },
)

it.skipIf(process.platform === 'win32')(
  'never retries a failed fresh birth observation until it happens to succeed',
  async () => {
    observation.firstBad = true
    const owner = stdinOwner(),
      child = start(owner)
    observation.rootPid = child.pid!
    const signals = safeSignals()
    const result = await owner.observe().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(OwnedProcessIdentityError)
    expect(observation.reads).toBe(1)
    observation.firstBad = false
    await expect(owner.close()).rejects.toBeInstanceOf(OwnedProcessIdentityError)
    expect(
      signals.mock.calls.filter(([pid, signal]) => pid === -child.pid! && signal !== 0),
    ).toEqual([])
    await children[0]!.closed
    expect(gone(child.pid!)).toBe(true)
  },
)

it.skipIf(process.platform === 'win32').each(['close', 'abort', 'already_closed'] as const)(
  'joins the same fixed birth work during %s without signalling stale identities',
  async (mode) => {
    const ready = Promise.withResolvers<void>(),
      controller = new AbortController()
    Object.assign(observation, { held: true, firstBad: true, firstReady: ready.resolve })
    const first = stdinOwner()
    start(first)
    await ready.promise
    let inputCloses = 0,
      secondChild: ChildProcessWithoutNullStreams
    const second = new OwnedProcessGroup({
      signal: controller.signal,
      onCloseInput: () => {
        inputCloses++
        secondChild.stdin.end()
      },
    })
    secondChild = start(second)
    observation.rootPid = secondChild.pid!
    const row = rootRow(secondChild.pid!),
      signals = safeSignals()
    if (mode === 'already_closed') {
      secondChild.stdin.end()
      await children[1]!.closed
    }
    if (mode === 'abort') controller.abort()
    const began = Date.now(),
      closing = second.close()
    expect(second.close()).toBe(closing)
    const noEarlySignal = signals.mock.calls.filter(
      ([pid, signal]) => pid === -secondChild.pid! && signal !== 0,
    )
    observation.release!(row)
    await closing
    await children[1]!.closed
    expect(noEarlySignal).toEqual([])
    expect(inputCloses).toBe(1)
    expect(second.released).toBe(true)
    expect(gone(secondChild.pid!)).toBe(true)
    expect(Date.now() - began).toBeLessThan(4000)
    expect(observation.reads).toBeLessThanOrEqual(3)
    observation.freshBad = false
    await first.close()
    await children[0]!.closed
  },
)

it.skipIf(process.platform === 'win32')(
  'keeps pending birth and signal observations within the original cleanup deadline',
  async () => {
    const ready = Promise.withResolvers<void>()
    Object.assign(observation, { held: true, firstBad: true, firstReady: ready.resolve })
    const first = stdinOwner()
    start(first)
    await ready.promise
    const second = stdinOwner(),
      child = start(second)
    observation.rootPid = child.pid!
    const row = rootRow(child.pid!)
    Object.assign(observation, { heldDelayMs: 900, freshDelayMs: 900 })
    const started = Date.now(),
      closing = second.close()
    observation.release!(row)
    await closing
    await children[1]!.closed
    expect(second.released).toBe(true)
    expect(gone(child.pid!)).toBe(true)
    expect(observation.reads).toBe(3)
    expect(Date.now() - started).toBeLessThan(4000)
    observation.freshDelayMs = 0
    await first.close()
    await children[0]!.closed
  },
)

it.skipIf(process.platform === 'win32')(
  'bounds the final KILL identity observation and never signals after the cleanup deadline',
  async () => {
    const ready = Promise.withResolvers<void>()
    Object.assign(observation, { held: true, firstBad: true, firstReady: ready.resolve })
    const first = stdinOwner()
    start(first)
    await ready.promise
    const second = stdinOwner(),
      child = start(
        second,
        "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{});setTimeout(()=>process.exit(0),5500);process.stdout.write('ready')",
      )
    await once(child.stdout, 'data')
    observation.rootPid = child.pid!
    const row = rootRow(child.pid!),
      signals = safeSignals(),
      signalTimes: number[] = []
    const originalKill = signals.getMockImplementation()!
    signals.mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal !== 0) signalTimes.push(Date.now())
      return originalKill(pid, signal)
    })
    Object.assign(observation, { heldDelayMs: 950, freshDelayMs: 950 })
    const started = Date.now(),
      closing = second.close()
    observation.release!(row)
    await closing.catch(() => undefined)
    const elapsed = Date.now() - started,
      released = second.released
    // The private child self-exits if its verified KILL cannot fit the deadline.
    await children[1]!.closed
    expect(gone(child.pid!)).toBe(true)
    expect({ elapsed, released, signals: signalTimes.map((at) => at - started) }).toEqual({
      elapsed: expect.any(Number),
      released: false,
      signals: [expect.any(Number)],
    })
    expect(elapsed).toBeLessThan(4050)
    expect(signalTimes.every((at) => at - started < 4000)).toBe(true)
    observation.freshDelayMs = 0
    await first.close()
    await children[0]!.closed
  },
  12_000,
)

it.skipIf(process.platform === 'win32')(
  'does not refresh or establish ownership after the closing root observation times out',
  async () => {
    const ready = Promise.withResolvers<void>()
    Object.assign(observation, { held: true, firstBad: true, firstReady: ready.resolve })
    const first = stdinOwner()
    start(first)
    await ready.promise
    const second = stdinOwner(),
      child = start(second)
    observation.rootPid = child.pid!
    const row = rootRow(child.pid!),
      signals = safeSignals(),
      started = Date.now(),
      closing = second.close()
    expect(second.close()).toBe(closing)
    await expect(closing).rejects.toThrow(/deadline/u)
    expect(Date.now() - started).toBeLessThan(4050)
    await children[1]!.closed
    observation.release!(row)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(observation.reads).toBe(1)
    expect(second.released).toBe(false)
    expect(
      signals.mock.calls.filter(([pid, signal]) => pid === -child.pid! && signal !== 0),
    ).toEqual([])
    expect(gone(child.pid!)).toBe(true)
    await first.close()
    await children[0]!.closed
  },
  10_000,
)

it.skipIf(process.platform === 'win32')(
  'retains an unsettled input-close task without late release or duplicate EOF',
  async () => {
    const pending = Promise.withResolvers<void>(),
      childReady = Promise.withResolvers<void>()
    releaseFixtureGates.add(pending.resolve)
    let closes = 0
    const owner = new OwnedProcessGroup({
        onCloseInput: () => {
          closes++
          return pending.promise
        },
      }),
      child = start(owner)
    child.once('spawn', childReady.resolve)
    await childReady.promise
    const started = Date.now(),
      closing = owner.close()
    expect(owner.close()).toBe(closing)
    await expect(closing).rejects.toThrow(/deadline/u)
    expect(Date.now() - started).toBeLessThan(4050)
    await children[0]!.closed
    expect(gone(child.pid!)).toBe(true)
    expect(owner.released).toBe(false)
    pending.resolve()
    await pending.promise
    expect(owner.close()).toBe(closing)
    await expect(owner.close()).rejects.toThrow(/deadline/u)
    expect(closes).toBe(1)
    expect(owner.released).toBe(false)
  },
  10_000,
)

it.skipIf(process.platform === 'win32')(
  'does not start a live observation after a pre-close continuation crosses the same deadline',
  async () => {
    const owner = stdinOwner(),
      child = start(owner)
    await owner.observe()
    const reads = observation.reads,
      observing = owner.observe().catch((error: unknown) => error),
      closing = owner.close(),
      now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000)
    await expect(closing).rejects.toThrow(/deadline/u)
    expect(await observing).toBeInstanceOf(Error)
    expect(observation.reads).toBe(reads)
    expect(owner.released).toBe(false)
    await children[0]!.closed
    expect(gone(child.pid!)).toBe(true)
  },
)

it.skipIf(process.platform === 'win32')(
  'preserves an earlier OS observation error without converting it into an inspection retry',
  async () => {
    const ready = Promise.withResolvers<void>()
    Object.assign(observation, { held: true, oldError: true, firstReady: ready.resolve })
    const first = stdinOwner()
    start(first)
    await ready.promise
    const second = stdinOwner(),
      child = start(second)
    observation.rootPid = child.pid!
    const signals = safeSignals(),
      reading = second.observe().catch((error: unknown) => error)
    observation.release!(rootRow(child.pid!))
    expect(await reading).toBeInstanceOf(Error)
    expect(observation.reads).toBe(1)
    await second.close().catch(() => undefined)
    expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    await children[1]!.closed
    expect(gone(child.pid!)).toBe(true)
    await first.close().catch(() => undefined)
    await children[0]!.closed
  },
)
