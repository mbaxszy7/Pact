import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGY_STORAGE_MAX_WORKING_BYTES,
  agyStorageClosedEventSchema,
  agyStorageInitMessageSchema,
  agyStorageOpenResponseSchema,
} from '@pact/contracts'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakePort {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: unknown[] = []
    started = false
    closed = false

    on(event: string, listener: Listener): this {
      const list = this.handlers.get(event) ?? []
      list.push(listener)
      this.handlers.set(event, list)
      return this
    }

    start(): void {
      this.started = true
    }

    postMessage(message: unknown): void {
      this.posted.push(message)
    }

    close(): void {
      this.closed = true
    }

    listenerCount(event: string): number {
      return this.handlers.get(event)?.length ?? 0
    }
  }

  const alivePids = new Set<number>()
  let nextFakePid = 51_000

  class FakeUtilityProcess {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: Array<{ message: unknown; transfer?: unknown[] | undefined }> = []
    readonly stdout = { resume: vi.fn<() => void>() }
    readonly stderr = { resume: vi.fn<() => void>() }
    killed = false
    killCalls = 0
    exitOnKill = true
    keepPidAliveAfterExit = false
    pid: number | undefined

    constructor(assignPid = true) {
      if (assignPid) {
        this.pid = ++nextFakePid
        alivePids.add(this.pid)
      }
    }

    on(event: string, listener: Listener): this {
      const list = this.handlers.get(event) ?? []
      list.push(listener)
      this.handlers.set(event, list)
      return this
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }

    removeListener(event: string, listener: Listener): this {
      const list = this.handlers.get(event)
      if (list) {
        this.handlers.set(
          event,
          list.filter((entry) => entry !== listener),
        )
      }
      return this
    }

    postMessage(message: unknown, transfer?: unknown[]): void {
      this.posted.push({ message, transfer })
    }

    kill(): boolean {
      this.killed = true
      this.killCalls += 1
      if (this.exitOnKill) this.emit('exit', 0)
      return true
    }

    emit(event: string, ...args: unknown[]): void {
      if (event === 'exit' && !this.keepPidAliveAfterExit && this.pid !== undefined) {
        alivePids.delete(this.pid)
      }
      const list = this.handlers.get(event) ?? []
      if (event === 'error' && list.length === 0) {
        throw new Error(`Unhandled FakeUtilityProcess error event: ${String(args[0])}`)
      }
      for (const listener of list.slice()) listener(...args)
    }
  }

  const forkedChildren: FakeUtilityProcess[] = []
  const forkCalls: Array<{
    modulePath: string
    args: string[]
    options: { env?: Record<string, string> }
  }> = []
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  let throwOnFork = false
  let nextForkWithoutPid = false

  class FakeMessageChannelMain {
    readonly port1 = new FakePort()
    readonly port2 = new FakePort()
    constructor() {
      channels.push({ port1: this.port1, port2: this.port2 })
    }
  }

  return {
    FakePort,
    FakeUtilityProcess,
    FakeMessageChannelMain,
    alivePids,
    forkedChildren,
    forkCalls,
    channels,
    get throwOnFork() {
      return throwOnFork
    },
    set throwOnFork(value: boolean) {
      throwOnFork = value
    },
    get nextForkWithoutPid() {
      return nextForkWithoutPid
    },
    set nextForkWithoutPid(value: boolean) {
      nextForkWithoutPid = value
    },
  }
})

vi.mock('electron', () => ({
  MessageChannelMain: harness.FakeMessageChannelMain,
  utilityProcess: {
    fork: (modulePath: string, args: string[], options: { env?: Record<string, string> }) => {
      harness.forkCalls.push({ modulePath, args, options })
      if (harness.throwOnFork) throw new Error('Simulated fork failure')
      const assignPid = !harness.nextForkWithoutPid
      harness.nextForkWithoutPid = false
      const child = new harness.FakeUtilityProcess(assignPid)
      harness.forkedChildren.push(child)
      return child
    },
  },
}))

import { LogicalIpcTrafficCollector } from '../../shared/logical-ipc-traffic'
import { AgyStorageOperations } from './agy-storage-operations'

const makeJobKey = (generation = randomUUID()) => ({
  version: 1 as const,
  generation,
  requestId: randomUUID(),
})

const makeOpenRequest = (
  overrides: Partial<{
    jobKey: ReturnType<typeof makeJobKey>
    action: 'read-agy-trajectory-identity' | 'inspect-agy-run' | 'fork'
    deadlineAt: number
    workingBytes: number
  }> = {},
) => ({
  type: 'agy-storage.open.request' as const,
  jobKey: overrides.jobKey ?? makeJobKey(),
  action: overrides.action ?? ('inspect-agy-run' as const),
  deadlineAt: overrides.deadlineAt ?? Date.now() + 10_000,
  workingBytes: overrides.workingBytes ?? AGY_STORAGE_MAX_WORKING_BYTES,
})

let killSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  harness.throwOnFork = false
  harness.nextForkWithoutPid = false
  harness.alivePids.clear()
  harness.forkedChildren.length = 0
  harness.forkCalls.length = 0
  harness.channels.length = 0
  killSpy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (!harness.alivePids.has(pid)) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }
        return true
      }
      return true
    })
})

afterEach(() => {
  harness.alivePids.clear()
  for (const child of harness.forkedChildren.splice(0)) {
    child.keepPidAliveAfterExit = false
    child.emit('exit', 0)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AgyStorageOperations', () => {
  it('forks an isolated child, plumbs dedicated MessageChannelMain ports with zero Main message listeners, and emits closed.event only after physical exit', async () => {
    const ops = new AgyStorageOperations('/app/utility/agy-storage-child.js')
    const traffic = new LogicalIpcTrafficCollector('main-utility', randomUUID())
    ops.configureTraffic(traffic)

    const utility = new harness.FakeUtilityProcess()
    const req = makeOpenRequest()

    expect(ops.receive(utility, req, () => true)).toBe(true)
    expect(harness.forkedChildren).toHaveLength(1)
    expect(harness.channels).toHaveLength(1)
    expect(ops.activeCount).toBe(1)

    const child = harness.forkedChildren[0]!
    const { port1, port2 } = harness.channels[0]!
    child.emit('spawn')

    // Child receives init (with bound action & deadlineAt) + port2; Utility receives open.response ok:true + port1.
    expect(child.posted).toHaveLength(1)
    expect(child.posted[0]).toEqual({
      message: {
        type: 'init',
        jobKey: req.jobKey,
        action: req.action,
        deadlineAt: req.deadlineAt,
      },
      transfer: [port2],
    })
    expect(utility.posted).toHaveLength(1)
    expect(agyStorageOpenResponseSchema.parse(utility.posted[0]!.message)).toEqual({
      type: 'agy-storage.open.response',
      ok: true,
      jobKey: req.jobKey,
    })
    expect(utility.posted[0]!.transfer).toEqual([port1])

    // Main NEVER listens on either MessagePort (zero business bytes relayed through Main).
    expect(port1.listenerCount('message')).toBe(0)
    expect(port2.listenerCount('message')).toBe(0)
    expect(child.handlers.get('message') ?? []).toHaveLength(0)

    // Physical exit emits agy-storage.closed.event and releases slot accounting.
    child.emit('exit', 0)
    expect(ops.activeCount).toBe(0)
    expect(ops.activeWorkingBytes()).toBe(0)
    expect(utility.posted).toHaveLength(2)
    expect(agyStorageClosedEventSchema.parse(utility.posted[1]!.message)).toEqual({
      type: 'agy-storage.closed.event',
      jobKey: req.jobKey,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    })

    // Control traffic was recorded strictly in the control lane with zero business bytes.
    const snapshot = traffic.snapshot()
    expect(snapshot.complete).toBe(true)
    const utilityToMain = snapshot.counters.find((c) => c.category === 'utility-main.control')!
    const mainToUtility = snapshot.counters.find((c) => c.category === 'main-utility.control')!
    expect(utilityToMain.control.messages).toBe(1)
    expect(utilityToMain.business.messages).toBe(0)
    expect(mainToUtility.control.messages).toBe(2)
    expect(mainToUtility.business.messages).toBe(0)
  })

  it('enforces deadlineAt by killing the child, escalating to SIGKILL on hang, and emitting closed.event only after physical exit', async () => {
    vi.useFakeTimers()
    const ops = new AgyStorageOperations('/app/utility/agy-storage-child.js')
    const utility = new harness.FakeUtilityProcess()
    const generation = randomUUID()

    // Already expired deadline is rejected before any fork.
    const expired = makeOpenRequest({ jobKey: makeJobKey(generation), deadlineAt: Date.now() - 1 })
    ops.receive(utility, expired, () => true)
    expect(harness.forkedChildren).toHaveLength(0)
    expect(utility.posted[0]!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'TIMEOUT',
    })

    // Live job exceeding deadlineAt kills child, keeps slot until real exit, then emits timedOut:true.
    const req = makeOpenRequest({ jobKey: makeJobKey(generation), deadlineAt: Date.now() + 3_000 })
    ops.receive(utility, req, () => true)
    const child = harness.forkedChildren[0]!
    child.exitOnKill = false
    child.emit('spawn')
    expect(utility.posted).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killed).toBe(true)
    expect(ops.activeCount).toBe(1)
    expect(utility.posted).toHaveLength(2) // No premature closed.event!

    // Grace period retries owned child.kill() (never raw process.kill(pid, SIGKILL)) while holding slot until exit.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.killCalls).toBe(2)
    expect(killSpy).not.toHaveBeenCalled()
    expect(ops.activeCount).toBe(1)
    expect(utility.posted).toHaveLength(2)

    // Physical exit releases slot and delivers closed.event with timedOut: true.
    child.emit('exit', 137)
    expect(ops.activeCount).toBe(0)
    expect(utility.posted).toHaveLength(3)
    expect(agyStorageClosedEventSchema.parse(utility.posted[2]!.message)).toEqual({
      type: 'agy-storage.closed.event',
      jobKey: req.jobKey,
      exitCode: 137,
      signal: null,
      timedOut: true,
      cancelled: false,
    })
  })

  it('kills the child on cancel.request and emits closed.event only after physical exit', () => {
    const ops = new AgyStorageOperations('/app/utility/agy-storage-child.js')
    const utility = new harness.FakeUtilityProcess()
    const otherUtility = new harness.FakeUtilityProcess()
    const req = makeOpenRequest()

    ops.receive(utility, req, () => true)
    const child = harness.forkedChildren[0]!
    child.exitOnKill = false
    child.emit('spawn')

    // Unrelated Utility source cannot cancel another Utility's job.
    ops.receive(
      otherUtility,
      { type: 'agy-storage.cancel.request', jobKey: req.jobKey, reason: 'aborted' },
      () => true,
    )
    expect(child.killed).toBe(false)

    // Owning Utility cancel kills child, waits for exit before emitting closed.event.
    ops.receive(
      utility,
      { type: 'agy-storage.cancel.request', jobKey: req.jobKey, reason: 'aborted' },
      () => true,
    )
    expect(child.killed).toBe(true)
    expect(ops.activeCount).toBe(1)
    expect(utility.posted).toHaveLength(1)

    child.emit('exit', 15)
    expect(ops.activeCount).toBe(0)
    expect(utility.posted).toHaveLength(2)
    expect(agyStorageClosedEventSchema.parse(utility.posted[1]!.message)).toEqual({
      type: 'agy-storage.closed.event',
      jobKey: req.jobKey,
      exitCode: 15,
      signal: null,
      timedOut: false,
      cancelled: true,
    })
  })

  it('enforces generation isolation, preserves slot accounting for stopping previous-generation children, and never forwards stale events', async () => {
    const ops = new AgyStorageOperations('/app/utility/agy-storage-child.js', { maxWorkers: 2 })
    const gen1 = randomUUID()
    const gen2 = randomUUID()
    const oldUtility = new harness.FakeUtilityProcess()
    const newUtility = new harness.FakeUtilityProcess()
    let activeUtility = oldUtility

    const req1 = makeOpenRequest({ jobKey: makeJobKey(gen1) })
    ops.receive(oldUtility, req1, () => activeUtility === oldUtility)
    const oldChild = harness.forkedChildren[0]!
    oldChild.exitOnKill = false
    oldChild.emit('spawn')

    // Switching generation on the same active Utility is rejected with GENERATION_MISMATCH.
    const mismatched = makeOpenRequest({ jobKey: makeJobKey(randomUUID()) })
    ops.receive(oldUtility, mismatched, () => activeUtility === oldUtility)
    expect(oldUtility.posted.at(-1)!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'GENERATION_MISMATCH',
    })

    // Utility generation replacement: cancelSource kills oldChild, retains slot until exit!
    activeUtility = newUtility
    ops.cancelSource(oldUtility)
    expect(oldChild.killed).toBe(true)
    expect(ops.activeCount).toBe(1)

    // New Utility reusing the retired generation is rejected.
    ops.receive(
      newUtility,
      makeOpenRequest({ jobKey: makeJobKey(gen1) }),
      () => activeUtility === newUtility,
    )
    expect(newUtility.posted[0]!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'GENERATION_MISMATCH',
    })

    // New Utility with fresh gen2 gets the 2nd remaining slot; 3rd request hits CAPACITY_EXCEEDED
    // because oldChild still holds slot #1 until its physical exit is confirmed!
    const req2 = makeOpenRequest({ jobKey: makeJobKey(gen2) })
    ops.receive(newUtility, req2, () => activeUtility === newUtility)
    const newChild = harness.forkedChildren[1]!
    newChild.emit('spawn')
    expect(ops.activeCount).toBe(2)

    const req3 = makeOpenRequest({ jobKey: makeJobKey(gen2) })
    ops.receive(newUtility, req3, () => activeUtility === newUtility)
    expect(newUtility.posted.at(-1)!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'CAPACITY_EXCEEDED',
    })

    // When oldChild finally exits, NO closed.event is delivered to oldUtility or newUtility,
    // and its slot is freed so req3's retry succeeds!
    const oldPostedBeforeExit = oldUtility.posted.length
    const newPostedBeforeExit = newUtility.posted.length
    oldChild.emit('exit', 0)
    expect(ops.activeCount).toBe(1)
    expect(oldUtility.posted.length).toBe(oldPostedBeforeExit)
    expect(newUtility.posted.length).toBe(newPostedBeforeExit)

    const req4 = makeOpenRequest({ jobKey: makeJobKey(gen2) })
    ops.receive(newUtility, req4, () => activeUtility === newUtility)
    expect(harness.forkedChildren).toHaveLength(3)
    harness.forkedChildren[2]!.emit('spawn')
    expect(ops.activeCount).toBe(2)

    await ops.dispose()
    expect(ops.activeCount).toBe(0)
  })

  it('caps maxWorkers at 8, charges 128 MiB per child regardless of peer workingBytes, caps deadlines by action, and always passes non-empty sanitized env', async () => {
    vi.useFakeTimers()
    const ops = new AgyStorageOperations('/app/out/main/utility/agy-storage-child.js', {
      maxWorkers: 16,
    })
    const utility = new harness.FakeUtilityProcess()
    const generation = randomUUID()

    // Identity request claiming 1 byte & 60s deadline is charged 128 MiB and capped at 3s.
    const idReq = makeOpenRequest({
      jobKey: makeJobKey(generation),
      action: 'read-agy-trajectory-identity',
      workingBytes: 1,
      deadlineAt: Date.now() + 60_000,
    })
    ops.receive(utility, idReq, () => true)
    expect(ops.activeWorkingBytes()).toBe(AGY_STORAGE_MAX_WORKING_BYTES)
    const idChild = harness.forkedChildren[0]!
    idChild.exitOnKill = false
    idChild.emit('spawn')

    // Verify sanitized child env is ALWAYS non-empty with fixed native mode/dir markers.
    const env = harness.forkCalls[0]!.options.env
    expect(env).toBeDefined()
    expect(env!['PACT_AGY_STORAGE_CHILD']).toBe('1')
    expect(env!['PACT_AGY_NATIVE_MODE']).toBe('development')
    expect(env!['PACT_AGY_NATIVE_DIR']).toContain('native')

    // Identity job times out at 3s (not 60s).
    await vi.advanceTimersByTimeAsync(2_999)
    expect(idChild.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(idChild.killed).toBe(true)
    idChild.emit('exit', 137)
    expect(ops.activeCount).toBe(0)

    // Non-identity action claiming 60s deadline is capped at 10s, and 9th concurrent worker hits CAPACITY_EXCEEDED.
    for (let i = 0; i < 8; i += 1) {
      ops.receive(
        utility,
        makeOpenRequest({
          jobKey: makeJobKey(generation),
          action: 'inspect-agy-run',
          workingBytes: 1,
          deadlineAt: Date.now() + 60_000,
        }),
        () => true,
      )
      const c = harness.forkedChildren[harness.forkedChildren.length - 1]!
      c.exitOnKill = false
      c.emit('spawn')
    }
    expect(ops.activeCount).toBe(8)
    expect(ops.activeWorkingBytes()).toBe(8 * AGY_STORAGE_MAX_WORKING_BYTES)

    ops.receive(
      utility,
      makeOpenRequest({
        jobKey: makeJobKey(generation),
        action: 'inspect-agy-run',
        workingBytes: 1,
        deadlineAt: Date.now() + 60_000,
      }),
      () => true,
    )
    expect(utility.posted.at(-1)!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'CAPACITY_EXCEEDED',
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(harness.forkedChildren[1]!.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.forkedChildren[1]!.killed).toBe(true)

    for (const c of harness.forkedChildren.slice(1)) c.emit('exit', 0)
    expect(ops.activeCount).toBe(0)
  })

  it('catches createChannel failures, handles child error events without crashing Main, handles unstarted timeouts with late spawn safely, and never signals raw PIDs after exit', async () => {
    vi.useFakeTimers()
    const utility = new harness.FakeUtilityProcess()
    const generation = randomUUID()

    // 1. createChannel throw returns SPAWN_FAILED without throwing or leaking a slot.
    const failingChannelOps = new AgyStorageOperations('/app/utility/agy-storage-child.js', {
      createChannel: () => {
        throw new Error('EMFILE')
      },
    })
    expect(
      failingChannelOps.receive(
        utility,
        makeOpenRequest({ jobKey: makeJobKey(generation) }),
        () => true,
      ),
    ).toBe(true)
    expect(failingChannelOps.activeCount).toBe(0)
    expect(utility.posted.at(-1)!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      code: 'SPAWN_FAILED',
    })

    const ops = new AgyStorageOperations('/app/utility/agy-storage-child.js')

    // 2. Startup timeout while !spawned sends logical TIMEOUT immediately, keeps physical slot
    //    until child exit settles, and immediately kills late spawn without transferring ports.
    harness.nextForkWithoutPid = true
    const unstartedReq = makeOpenRequest({
      jobKey: makeJobKey(generation),
      deadlineAt: Date.now() + 1_000,
    })
    ops.receive(utility, unstartedReq, () => true)
    const unstartedChild = harness.forkedChildren[0]!
    unstartedChild.exitOnKill = false
    expect(unstartedChild.pid).toBeUndefined()
    expect(ops.activeCount).toBe(1)

    let settled = false
    const settlePromise = ops.settlement().then((ok) => {
      settled = ok
      return ok
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(utility.posted.at(-1)!.message).toMatchObject({
      type: 'agy-storage.open.response',
      ok: false,
      jobKey: unstartedReq.jobKey,
      code: 'TIMEOUT',
    })
    // Physical tracking remains active until child.once('exit') confirms termination!
    expect(ops.activeCount).toBe(1)
    expect(settled).toBe(false)

    // Grace period retries owned child.kill() without prematurely releasing the slot.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ops.activeCount).toBe(1)
    expect(settled).toBe(false)

    // Late spawn fires: must immediately call owned child.kill() and NEVER post init or open ok:true.
    const postedBeforeLateSpawn = utility.posted.length
    const killsBeforeLateSpawn = unstartedChild.killCalls
    unstartedChild.emit('spawn')
    expect(unstartedChild.killCalls).toBe(killsBeforeLateSpawn + 1)
    expect(unstartedChild.posted).toHaveLength(0)
    expect(utility.posted).toHaveLength(postedBeforeLateSpawn)
    expect(ops.activeCount).toBe(1)

    // Exit finally settles physical tracking without duplicate open error or spurious closed.event.
    unstartedChild.emit('exit', 1)
    expect(ops.activeCount).toBe(0)
    await expect(settlePromise).resolves.toBe(true)
    expect(utility.posted).toHaveLength(postedBeforeLateSpawn)
    expect(killSpy).not.toHaveBeenCalled()

    // 3. Child `error` event (V8 fatal) is handled safely without unhandled EventEmitter crash.
    const errReq = makeOpenRequest({ jobKey: makeJobKey(generation) })
    ops.receive(utility, errReq, () => true)
    const errChild = harness.forkedChildren[1]!
    errChild.exitOnKill = false
    errChild.emit('spawn')
    expect(() => errChild.emit('error', 'FatalError', 'v8', 'raw-report')).not.toThrow()
    expect(errChild.killed).toBe(true)
    errChild.emit('exit', 1)
    expect(ops.activeCount).toBe(0)

    // 4. PID reuse safety: even if numeric PID remains alive in OS after child emits `exit`,
    //    Main settles directly from owned child `exit` and NEVER polls or SIGKILLs the raw PID!
    const reusedReq = makeOpenRequest({ jobKey: makeJobKey(generation) })
    ops.receive(utility, reusedReq, () => true)
    const reusedChild = harness.forkedChildren[2]!
    reusedChild.keepPidAliveAfterExit = true
    reusedChild.emit('spawn')
    const postedBeforeExit = utility.posted.length

    reusedChild.emit('exit', 0)
    expect(ops.activeCount).toBe(0)
    expect(utility.posted).toHaveLength(postedBeforeExit + 1)
    expect(agyStorageClosedEventSchema.parse(utility.posted.at(-1)!.message)).toMatchObject({
      type: 'agy-storage.closed.event',
      jobKey: reusedReq.jobKey,
      exitCode: 0,
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('enforces authoritative packaged mode and refuses launch-env downgrade or native dir redirection', () => {
    const prevMode = process.env['PACT_AGY_NATIVE_MODE']
    const prevDir = process.env['PACT_AGY_NATIVE_DIR']
    const prevTemp = process.env['PACT_AGY_PRIVATE_TEMP_DIR']
    const prevResources: unknown = Reflect.get(process, 'resourcesPath')
    try {
      process.env['PACT_AGY_NATIVE_MODE'] = 'development'
      process.env['PACT_AGY_NATIVE_DIR'] = '/tmp/untrusted-native'
      process.env['PACT_AGY_PRIVATE_TEMP_DIR'] = '/tmp/untrusted-temp'
      Reflect.set(process, 'resourcesPath', '/Applications/Pact.app/Contents/Resources')

      const packagedOps = new AgyStorageOperations(
        '/Applications/Pact.app/Contents/Resources/app.asar/out/main/utility/agy-storage-child.js',
        {
          isPackaged: true,
          nativeMode: 'development',
        },
      )
      const utility = new harness.FakeUtilityProcess()
      const req = makeOpenRequest({
        deadlineAt: Date.now() + 60_000,
        action: 'read-agy-trajectory-identity',
      })
      packagedOps.receive(utility, req, () => true)

      const env = harness.forkCalls[0]!.options.env!
      expect(env['PACT_AGY_NATIVE_MODE']).toBe('packaged')
      expect(env['PACT_AGY_NATIVE_DIR']).toBe('/Applications/Pact.app/Contents/Resources/native')
      expect(env['PACT_AGY_PRIVATE_TEMP_DIR']).toBeUndefined()

      // Verify init message carries clamped deadline (3s for identity, not 60s) and exact action.
      const child = harness.forkedChildren[0]!
      child.emit('spawn')
      const initMsg = agyStorageInitMessageSchema.parse(child.posted[0]!.message)
      expect(initMsg.type).toBe('init')
      expect(initMsg.action).toBe('read-agy-trajectory-identity')
      expect(initMsg.deadlineAt).toBeLessThan(req.deadlineAt)
      child.emit('exit', 0)
    } finally {
      if (prevMode === undefined) delete process.env['PACT_AGY_NATIVE_MODE']
      else process.env['PACT_AGY_NATIVE_MODE'] = prevMode
      if (prevDir === undefined) delete process.env['PACT_AGY_NATIVE_DIR']
      else process.env['PACT_AGY_NATIVE_DIR'] = prevDir
      if (prevTemp === undefined) delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
      else process.env['PACT_AGY_PRIVATE_TEMP_DIR'] = prevTemp
      if (prevResources === undefined) Reflect.deleteProperty(process, 'resourcesPath')
      else Reflect.set(process, 'resourcesPath', prevResources)
    }
  })
})
