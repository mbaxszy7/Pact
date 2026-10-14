import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/* oxlint-disable no-await-in-loop, typescript/no-unsafe-type-assertion -- Protocol stubs intentionally model Node child-process streams. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CODEX_MAX_FRAME_BYTES,
  CODEX_OUTBOUND_DRAIN_TIMEOUT_MS,
  CODEX_QUEUE_HIGH_WATER_BYTES,
  CODEX_QUEUE_LOW_WATER_BYTES,
  CodexAppServerConnection,
} from './codex-app-server-connection.js'
import { NATIVE_OWNER_WORKING_BYTES } from './native-working-memory.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('Codex App Server connection budgets', () => {
  it.each(['lifetime', 'notification-abort'] as const)(
    'keeps a queued %s frame unwritten after its owner stops under real stream backpressure',
    async (mode) => {
      const child = fakeChild(),
        methods: unknown[] = []
      child.onRequest((request) => {
        methods.push(Reflect.get(request, 'method'))
        if (Reflect.has(request, 'id'))
          child.stdout.write(`${JSON.stringify({ id: Reflect.get(request, 'id'), result: {} })}\n`)
      })
      const write = child.stdin.write.bind(child.stdin)
      let blocked = true,
        current = true
      child.stdin.write = ((bytes: Buffer) => {
        const accepted = write(bytes)
        return blocked ? false : accepted
      }) as typeof child.stdin.write
      const connection = new CodexAppServerConnection(
        child.process,
        undefined,
        undefined,
        undefined,
        () => current,
      )
      const controller = new AbortController()
      try {
        await connection.request('block', {}, { timeoutMs: 1000 })
        const queued =
          mode === 'lifetime'
            ? connection.request('thread/read', {}, { timeoutMs: 1000 })
            : connection.notify('initialized', {}, { signal: controller.signal })
        const outcome = queued.catch((error: unknown) => error)
        if (mode === 'lifetime') current = false
        else controller.abort()
        blocked = false
        child.stdin.emit('drain')
        expect(await outcome).toBeInstanceOf(Error)
        expect(methods).toEqual(['block'])
        current = true
        await connection.request('ping', {}, { timeoutMs: 1000 })
        expect(methods).toEqual(['block', 'ping'])
        await vi.waitFor(() =>
          expect(connection.diagnostics()).toMatchObject({
            pendingRequests: 0,
            queuedOutboundFrames: 0,
            queuedOutboundBytes: 0,
          }),
        )
      } finally {
        await connection.close()
      }
    },
  )

  it.each(['stale', 'throws'] as const)(
    'rejects %s metadata at actual dispatch after backpressure and keeps normal RPC usable',
    async (fence) => {
      const child = fakeChild()
      const methods: unknown[] = []
      child.onRequest((request) => {
        methods.push(Reflect.get(request, 'method'))
        child.stdout.write(`${JSON.stringify({ id: Reflect.get(request, 'id'), result: {} })}\n`)
      })
      const write = child.stdin.write.bind(child.stdin)
      let blocked = true
      child.stdin.write = ((bytes: Buffer) => {
        const accepted = write(bytes)
        return blocked ? false : accepted
      }) as typeof child.stdin.write
      const connection = new CodexAppServerConnection(child.process)
      try {
        await connection.request('block', {}, { timeoutMs: 1000 })
        let current = true
        const dispatched = vi.fn<() => void>()
        const metadata = connection.request(
          'thread/name/set',
          {},
          {
            timeoutMs: 1000,
            onDispatch: dispatched,
            canDispatch: () => {
              if (fence === 'throws') throw new Error('Fixture ownership read failed')
              return current
            },
          },
        )
        const outcome = metadata.catch((error: unknown) => error)
        current = false
        blocked = false
        child.stdin.emit('drain')
        expect(await outcome).toBeInstanceOf(Error)
        expect(dispatched).not.toHaveBeenCalled()
        await connection.request('ping', {}, { timeoutMs: 1000 })
        expect(methods).toEqual(['block', 'ping'])
        await vi.waitFor(() =>
          expect(connection.diagnostics()).toMatchObject({
            open: true,
            pendingRequests: 0,
            queuedOutboundFrames: 0,
            queuedOutboundBytes: 0,
          }),
        )
      } finally {
        await connection.close()
      }
    },
  )

  it('decodes split UTF-8 frames and routes responses without queueing them', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    child.onRequest((request) => {
      const response = Buffer.from(
        `${JSON.stringify({ id: Reflect.get(request, 'id'), result: { title: '你好' } })}\n`,
      )
      const split = response.indexOf(Buffer.from('你')) + 1
      child.stdout.write(response.subarray(0, split))
      child.stdout.write(response.subarray(split))
    })

    await expect(connection.request('thread/read', {}, { timeoutMs: 100 })).resolves.toMatchObject({
      result: { title: '你好' },
    })
    expect(connection.diagnostics()).toMatchObject({ pendingRequests: 0, queuedMessages: 0 })
    await connection.close()
  })

  it('rejects unframed input when its parse workspace exceeds the owner working capacity', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    const notification = connection.nextNotification(60_000)

    child.stdout.write(Buffer.alloc(CODEX_MAX_FRAME_BYTES + 1, 0x61))

    await expect(notification).rejects.toMatchObject({ kind: 'runtime_incompatible' })
    expect(connection.diagnostics()).toMatchObject({ open: false, queuedInboundBytes: 0 })
    await connection.close()
  })

  it('pauses above the inbound high-water mark and resumes below the low-water mark', async () => {
    const child = fakeChild()
    const pause = vi.spyOn(child.stdout, 'pause')
    const resume = vi.spyOn(child.stdout, 'resume')
    const connection = new CodexAppServerConnection(child.process)
    // Inline frames keep this queue test independent of the packaged parser Worker.
    const payload = 'x'.repeat(128 * 1024)
    const frame = `${JSON.stringify({ method: 'progress', params: { payload } })}\n`
    const highWaterMessages = Math.ceil(CODEX_QUEUE_HIGH_WATER_BYTES / Buffer.byteLength(frame))

    for (let index = 0; index <= highWaterMessages; index += 1) {
      child.stdout.write(frame)
    }

    await vi.waitFor(() =>
      expect(connection.diagnostics()).toMatchObject({
        stdoutPaused: true,
        queuedMessages: highWaterMessages,
      }),
    )
    expect(pause).toHaveBeenCalled()
    for (let index = 0; index < highWaterMessages; index += 1)
      await connection.nextNotification(100)
    await vi.waitFor(() => expect(connection.diagnostics().stdoutPaused).toBe(false))
    expect(resume).toHaveBeenCalled()
    await connection.close()
  })

  it('reads an RPC ACK behind a paused queue and restores its existing mid-water pause', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    child.onRequest((request) => {
      child.stdout.write(
        `${JSON.stringify({ id: Reflect.get(request, 'id'), result: { acknowledged: true } })}\n`,
      )
    })
    try {
      const queuedMessages = await pauseAtMidWater(child, connection)
      await expect(connection.request('ping', {}, { timeoutMs: 1000 })).resolves.toMatchObject({
        result: { acknowledged: true },
      })
      await vi.waitFor(() =>
        expect(connection.diagnostics()).toMatchObject({
          pendingRequests: 0,
          queuedMessages,
          stdoutPaused: true,
          open: true,
        }),
      )
    } finally {
      await connection.close()
    }
  })

  it.each(['cancelled', 'deadline'] as const)(
    'restores the existing mid-water queue pause when a dispatched RPC is %s',
    async (mode) => {
      const child = fakeChild()
      const connection = new CodexAppServerConnection(child.process)
      const controller = new AbortController()
      const dispatched = Promise.withResolvers<void>()
      child.onRequest(() => dispatched.resolve())
      try {
        const queuedMessages = await pauseAtMidWater(child, connection)
        const request = connection.request(
          'ping',
          {},
          {
            timeoutMs: mode === 'deadline' ? 20 : 1000,
            signal: controller.signal,
          },
        )
        const outcome = request.catch((error: unknown) => error)
        await dispatched.promise
        expect(connection.diagnostics()).toMatchObject({ pendingRequests: 1, stdoutPaused: false })
        if (mode === 'cancelled') controller.abort()
        expect(await outcome).toMatchObject({
          kind: mode === 'cancelled' ? 'agent_process_crash' : 'transient_transport',
        })
        await vi.waitFor(() =>
          expect(connection.diagnostics()).toMatchObject({
            pendingRequests: 0,
            queuedMessages,
            stdoutPaused: true,
            open: true,
          }),
        )
      } finally {
        controller.abort()
        await connection.close()
      }
    },
  )

  it('allows a native control request past a paused queue and restores pause on subscription cleanup', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    const control = vi.fn<(message: object) => boolean>(() => true)
    let unsubscribe: (() => void) | undefined
    try {
      const queuedMessages = await pauseAtMidWater(child, connection)
      unsubscribe = connection.subscribeServerRequests(control)
      child.stdout.write(
        `${JSON.stringify({ id: 'approval-1', method: 'permission/request', params: {} })}\n`,
      )
      await vi.waitFor(() =>
        expect(control).toHaveBeenCalledExactlyOnceWith({
          id: 'approval-1',
          method: 'permission/request',
          params: {},
        }),
      )
      await vi.waitFor(() =>
        expect(connection.diagnostics()).toMatchObject({
          queuedMessages,
          stdoutPaused: false,
          open: true,
        }),
      )
      unsubscribe()
      unsubscribe = undefined
      expect(connection.diagnostics()).toMatchObject({ queuedMessages, stdoutPaused: true })
    } finally {
      unsubscribe?.()
      await connection.close()
    }
  })

  it('settles silent RPC and blocked stdin deadlines without retaining waiters', async () => {
    vi.useFakeTimers()
    const silentChild = fakeChild()
    const silent = new CodexAppServerConnection(silentChild.process)
    const unanswered = silent.request('initialize', {}, { timeoutMs: 20 })
    const unansweredOutcome = unanswered.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await unansweredOutcome).toMatchObject({ kind: 'transient_transport' })
    expect(silent.diagnostics().pendingRequests).toBe(0)
    const silentClose = silent.close()
    await vi.runAllTimersAsync()
    await silentClose

    const blockedChild = fakeChild({ blockWrites: true })
    const blocked = new CodexAppServerConnection(blockedChild.process)
    const request = blocked.request('turn/start', {}, { timeoutMs: 60_000 })
    const blockedOutcome = request.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CODEX_OUTBOUND_DRAIN_TIMEOUT_MS)
    expect(await blockedOutcome).toMatchObject({ kind: 'transient_transport' })
    expect(blocked.diagnostics()).toMatchObject({ pendingRequests: 0, queuedOutboundFrames: 0 })
    await vi.runAllTimersAsync()
    await blocked.close()
  })

  it('does not confirm shutdown while a child ignores both termination signals', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    Object.assign(child.process, { kill: () => true })
    const connection = new CodexAppServerConnection(child.process)
    const closing = connection.close()
    const outcome = closing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await outcome).toMatchObject({ message: 'Codex process did not exit after SIGKILL.' })
  })

  it('ignores a late duplicate response after its request deadline', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    let requestId: number | undefined
    child.onRequest((request) => {
      const id = Reflect.get(request, 'id')
      if (typeof id === 'number') requestId = id
    })
    const connection = new CodexAppServerConnection(child.process)
    const request = connection.request('turn/start', {}, { timeoutMs: 20 })
    const outcome = request.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await outcome).toMatchObject({ kind: 'transient_transport' })

    child.stdout.write(`${JSON.stringify({ id: requestId, result: { turn: { id: 'late' } } })}\n`)
    expect(connection.diagnostics()).toMatchObject({ pendingRequests: 0, queuedMessages: 0 })
    const closing = connection.close()
    await vi.runAllTimersAsync()
    await closing
  })

  it('does not dispatch a request whose signal was already aborted', async () => {
    const child = fakeChild()
    let dispatched = false
    child.onRequest(() => {
      dispatched = true
    })
    const connection = new CodexAppServerConnection(child.process)
    const controller = new AbortController()
    controller.abort()

    await expect(
      connection.request('turn/start', {}, { timeoutMs: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'agent_process_crash' })
    expect(dispatched).toBe(false)
    expect(connection.diagnostics().pendingRequests).toBe(0)
    await connection.close()
  })

  it('retains and drains a received chunk above the old queue byte ceiling within working capacity', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    const payload = 'x'.repeat(128 * 1024)
    const chunk = Buffer.concat(
      Array.from({ length: 65 }, () =>
        Buffer.from(`${JSON.stringify({ method: 'progress', params: { payload } })}\n`),
      ),
    )

    child.stdout.write(chunk)

    await vi.waitFor(() =>
      expect(connection.diagnostics()).toMatchObject({
        open: true,
        queuedMessages: 65,
      }),
    )
    for (let index = 0; index < 65; index += 1)
      await expect(connection.nextNotification(100)).resolves.toMatchObject({
        method: 'progress',
        params: { payload },
      })
    expect(connection.diagnostics()).toMatchObject({ queuedMessages: 0, queuedInboundBytes: 0 })
    await connection.close()
  })

  it('closes when queued facts and the next parse workspace exceed the owner working capacity', async () => {
    const child = fakeChild()
    const connection = new CodexAppServerConnection(child.process)
    const held = connection.reserveWorkingMemory(
      NATIVE_OWNER_WORKING_BYTES - CODEX_MAX_FRAME_BYTES / 2,
    )
    const payload = 'x'.repeat(128 * 1024)
    const chunk = Buffer.concat(
      Array.from({ length: 40 }, () =>
        Buffer.from(`${JSON.stringify({ method: 'progress', params: { payload } })}\n`),
      ),
    )
    try {
      child.stdout.write(chunk)
      await vi.waitFor(() =>
        expect(connection.diagnostics()).toMatchObject({
          open: false,
          queuedMessages: 0,
          queuedInboundBytes: 0,
        }),
      )
    } finally {
      held.release()
      await connection.close()
    }
  })

  it('returns owned request and queue resources to baseline across 100 cycles', async () => {
    for (let index = 0; index < 100; index += 1) {
      const child = fakeChild()
      const connection = new CodexAppServerConnection(child.process)
      let expectedOutcome = 'success'
      let actualOutcome = 'success'
      if (index % 3 === 0) {
        child.onRequest((request) => {
          child.stdout.write(
            `${JSON.stringify({ id: Reflect.get(request, 'id'), result: { index } })}\n`,
          )
        })
        await connection.request('ping', {}, { timeoutMs: 100 })
      } else if (index % 3 === 1) {
        expectedOutcome = 'agent_process_crash'
        const controller = new AbortController()
        const request = connection.request(
          'ping',
          {},
          { timeoutMs: 100, signal: controller.signal },
        )
        const outcome = request.catch((error: unknown) => error)
        controller.abort()
        actualOutcome = failureKind(await outcome)
      } else {
        expectedOutcome = 'transient_transport'
        const request = connection.request('ping', {}, { timeoutMs: 1 })
        actualOutcome = failureKind(await request.catch((error: unknown) => error))
      }
      await connection.close()
      expect(actualOutcome).toBe(expectedOutcome)
      await vi.waitFor(() =>
        expect(connection.diagnostics()).toMatchObject({
          pendingRequests: 0,
          queuedMessages: 0,
          queuedInboundBytes: 0,
          queuedOutboundFrames: 0,
          queuedOutboundBytes: 0,
          waitingForNotification: false,
          open: false,
        }),
      )
    }
  })
})

async function pauseAtMidWater(
  child: ReturnType<typeof fakeChild>,
  connection: CodexAppServerConnection,
): Promise<number> {
  const frame = `${JSON.stringify({ method: 'progress', params: { payload: 'x'.repeat(128 * 1024) } })}\n`
  const highWaterMessages = Math.ceil(CODEX_QUEUE_HIGH_WATER_BYTES / Buffer.byteLength(frame))
  for (let index = 0; index < highWaterMessages; index += 1) child.stdout.write(frame)
  await vi.waitFor(() =>
    expect(connection.diagnostics()).toMatchObject({
      queuedMessages: highWaterMessages,
      stdoutPaused: true,
    }),
  )
  for (let index = 0; index < 8; index += 1) await connection.nextNotification(100)
  const state = connection.diagnostics()
  expect(state.queuedInboundBytes).toBeGreaterThan(CODEX_QUEUE_LOW_WATER_BYTES)
  expect(state.queuedInboundBytes).toBeLessThan(CODEX_QUEUE_HIGH_WATER_BYTES)
  expect(state.stdoutPaused).toBe(true)
  return highWaterMessages - 8
}

function fakeChild(options: { blockWrites?: boolean } = {}): {
  process: ChildProcessWithoutNullStreams
  stdin: PassThrough
  stdout: PassThrough
  onRequest: (listener: (request: object) => void) => void
} {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let requestListener: ((request: object) => void) | undefined
  let input = ''
  if (options.blockWrites) {
    stdin.write = (() => false) as typeof stdin.write
  } else {
    stdin.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      while (input.includes('\n')) {
        const newline = input.indexOf('\n')
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        requestListener?.(JSON.parse(line) as object)
      }
    })
  }
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: () => {
      queueMicrotask(() => {
        Object.assign(process, { exitCode: 0 })
        process.emit('exit', 0, null)
        process.emit('close', 0, null)
      })
      return true
    },
  })
  return {
    process,
    stdin,
    stdout,
    onRequest: (listener) => {
      requestListener = listener
    },
  }
}

function failureKind(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const kind = Reflect.get(error, 'kind')
  return typeof kind === 'string' ? kind : 'unknown'
}
