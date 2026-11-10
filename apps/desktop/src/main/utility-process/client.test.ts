import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  conversationSendInputSchema,
  utilityRequestSchema,
  utilityResponseSchema,
} from '@pact/contracts'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeUtilityProcess {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: unknown[] = []
    throwOnPost = false
    killed = false
    exitOnKill = true
    killCount = 0

    on(event: string, listener: Listener): this {
      const listeners = this.handlers.get(event) ?? []
      listeners.push(listener)
      this.handlers.set(event, listeners)
      return this
    }

    postMessage(message: unknown): void {
      if (this.throwOnPost) throw new Error('post failed')
      this.posted.push(message)
    }

    removeListener(event: string, listener: Listener): this {
      const listeners = this.handlers.get(event)
      if (!listeners) return this
      this.handlers.set(
        event,
        listeners.filter((registered) => registered !== listener),
      )
      return this
    }

    off(event: string, listener: Listener): this {
      return this.removeListener(event, listener)
    }

    once(event: string, listener: Listener): this {
      const receive: Listener = (...args) => {
        this.removeListener(event, receive)
        listener(...args)
      }
      return this.on(event, receive)
    }

    listenerCount(event: string): number {
      return this.handlers.get(event)?.length ?? 0
    }

    kill(): boolean {
      this.killed = true
      this.killCount += 1
      if (this.exitOnKill) this.emit('exit', 0)
      return true
    }

    emit(event: string, ...args: unknown[]): void {
      // oxlint-disable-next-line unicorn/no-useless-spread -- Preserve the current emission while listeners unregister during an exit callback.
      for (const listener of [...(this.handlers.get(event) ?? [])]) listener(...args)
    }
  }

  const children: InstanceType<typeof FakeUtilityProcess>[] = []
  const storage = {
    isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
    encryptStringAsync: vi.fn<(key: string) => Promise<Buffer>>(),
    decryptStringAsync:
      vi.fn<(cipher: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  }
  return { FakeUtilityProcess, children, storage }
})

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: {
    fork: () => {
      const child = new harness.FakeUtilityProcess()
      harness.children.push(child)
      return child
    },
  },
  safeStorage: harness.storage,
}))

import type { UtilityProcessStartOptions } from './client.js'

import { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import {
  createAppearanceController,
  type NativeThemeSource,
} from '../modules/appearance/controller.js'
import { createUtilityProcessClient } from './client.js'

const startOptions = {
  databaseFile: ':memory:',
  migrationsFolder: '/tmp/pact-migrations',
}

describe('Relay RPC deadlines without automatic resend', () => {
  it.each([
    {
      name: 'settings read',
      deadline: 5_000,
      code: 'TIMEOUT',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.getSchedulingSettings(),
    },
    {
      name: 'intent save',
      deadline: 5_000,
      code: 'TIMEOUT',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.saveSchedulingSettings({ expectedRevision: 0, enabled: true }),
    },
    {
      name: 'activity read',
      deadline: 5_000,
      code: 'TIMEOUT',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.readSchedulingActivity({}),
    },
    {
      name: 'state read',
      deadline: 5_000,
      code: 'TIMEOUT',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.getSchedulingState({}),
    },
    {
      name: 'credential remove',
      deadline: 5_000,
      code: 'UNCERTAIN',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.removeRelayApiKey({
          nonce: randomUUID(),
          expectedRevision: 0,
          deadlineAt: Date.now() + 5000,
        }),
    },
    {
      name: 'credential receipt read',
      deadline: 5_000,
      code: 'TIMEOUT',
      invoke: (client: ReturnType<typeof createUtilityProcessClient>) =>
        client.readRelayCredentialReceipt(randomUUID()),
    },
  ])(
    'retains $deadline ms for $name and sends once on uncertain delivery',
    async ({ deadline, code, invoke }) => {
      vi.useFakeTimers()
      const client = createUtilityProcessClient()
      client.start(startOptions)
      const child = harness.children.at(-1)!
      child.emit('message', { type: 'runtime.ready.event' })
      let settled = false
      const operation = invoke(client).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(settled).toBe(false)
      expect(child.posted).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await operation).toMatchObject({ ok: false, error: { code } })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(child.posted).toHaveLength(1)
      client.dispose()
    },
  )
})

it.each([
  { body: false, responseAt: 23_000 },
  { body: true, responseAt: 33_000 },
])(
  'keeps Send pending through 12 seconds and accepts its correlated response at $responseAt ms (sealed body: $body)',
  async ({ body, responseAt }) => {
    vi.useFakeTimers()
    const client = createUtilityProcessClient()
    let operation: ReturnType<typeof client.sendConversationMessage> | undefined
    try {
      client.start(startOptions)
      const child = harness.children.at(-1)!
      child.emit('message', { type: 'runtime.ready.event' })
      const sessionId = crypto.randomUUID()
      const input = conversationSendInputSchema.parse({
        sessionId,
        clientMessageId: crypto.randomUUID(),
        ...(body
          ? { inputId: crypto.randomUUID(), content: '' }
          : { content: 'Send after bounded Relay advice and normal business preparation.' }),
        expectedCommentsRevision: 1,
        commentIds: [crypto.randomUUID()],
        routeIntent: 'implicit',
        composerRevision: 1,
      })
      const startedAt = Date.now()
      let completion: unknown
      operation = client.sendConversationMessage(input).then((result) => {
        completion = { afterMs: Date.now() - startedAt, result }
        return result
      })
      const expected = {
        ok: true,
        value: {
          version: 'conversation-patch-v1',
          sessionId,
          observation: { incarnation: crypto.randomUUID(), sequence: 1 },
          session: {
            id: sessionId,
            title: 'Delayed Send',
            titleSource: 'user',
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            updatedAt: new Date().toISOString(),
          },
          messages: [],
          runs: [],
          activities: [],
          activityStates: [],
        },
      }
      const response = utilityResponseSchema.parse({
        type: 'conversation.patch.response',
        requestId: postedRequest(child).requestId,
        result: expected,
      })
      await vi.advanceTimersByTimeAsync(11_999)
      expect(completion).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect.soft(completion, 'Send must remain pending at 12 seconds').toBeUndefined()
      // Preserve the independent body-read, advice and business preparation bounds.
      await vi.advanceTimersByTimeAsync(responseAt - 12_000)
      child.emit('message', response)
      await expect(operation).resolves.toEqual(expected)
      expect(child.posted).toHaveLength(1)
    } finally {
      client.dispose()
      await operation
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  },
)

afterEach(() => {
  // Simulated children always deliver physical exit before a test releases the transport fixture.
  for (const child of harness.children.splice(0)) child.emit('exit', 0)
  vi.useRealTimers()
})

function postedRequest(child: (typeof harness.children)[number], index = 0): { requestId: string } {
  const request = child.posted[index]
  if (
    !request ||
    typeof request !== 'object' ||
    !('requestId' in request) ||
    typeof request.requestId !== 'string'
  ) {
    throw new Error('Expected a utility request.')
  }
  return { requestId: request.requestId }
}

function shutdownAck(child: (typeof harness.children)[number], index = 0): void {
  child.emit('message', {
    type: 'runtime.shutdown.response',
    requestId: postedRequest(child, index).requestId,
    result: { ok: true, value: { flushed: true } },
  })
}

async function turn(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('Utility startup readiness and quit delivery', () => {
  for (const timing of ['before-wait', 'during-wait'] as const) {
    it(`preserves a fatal startup failure ${timing} without another readiness timeout`, async () => {
      vi.useFakeTimers()
      const runtime = createUtilityProcessClient()
      const onStartupFailed =
        vi.fn<(failure: import('@pact/contracts').RuntimeStartupFailure) => void>()
      runtime.start({ ...startOptions, onStartupFailed })
      const child = harness.children.at(-1)!
      const waiting = timing === 'during-wait' ? runtime.waitUntilReady() : undefined
      const failure = {
        type: 'runtime.startup-failed.event',
        failureId: crypto.randomUUID(),
        stage: 'persistence',
        code: 'DATABASE_INCOMPATIBLE',
        reason: 'migration-history-diverged',
        dataFilePath: '/fixture/pact.sqlite',
      }
      child.emit('message', failure)
      await expect(waiting ?? runtime.waitUntilReady()).resolves.toMatchObject({
        ok: false,
        error: { code: 'DATABASE_INCOMPATIBLE' },
      })
      await expect(runtime.waitUntilReady()).resolves.toMatchObject({
        ok: false,
        error: { code: 'DATABASE_INCOMPATIBLE' },
      })
      expect(onStartupFailed).toHaveBeenCalledOnce()
      expect(child.posted).toContainEqual({
        type: 'runtime.startup-failed.ack',
        failureId: failure.failureId,
      })
      expect(vi.getTimerCount()).toBe(0)
      runtime.dispose()
    })
  }
  it('waits for cold readiness before the first Appearance RPC, retaining the ordinary read deadline', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    const theme: NativeThemeSource = {
      themeSource: 'system',
      shouldUseDarkColors: true,
      prefersReducedTransparency: false,
      shouldUseHighContrastColors: false,
      inForcedColorsMode: false,
      on: () => undefined,
      removeListener: () => undefined,
    }
    const appearance = createAppearanceController(runtime, theme)
    const load = async () => {
      const ready = await runtime.waitUntilReady()
      if (!ready.ok) return ready
      return appearance.refresh()
    }
    const loaded = load()
    await vi.advanceTimersByTimeAsync(2_634)
    expect(child.posted).toHaveLength(0)
    child.emit('message', { type: 'runtime.ready.event' })
    await turn()
    expect(child.posted).toHaveLength(1)
    child.emit('message', {
      type: 'appearance.response',
      requestId: postedRequest(child).requestId,
      result: {
        ok: true,
        value: { theme: 'dark', windowMaterial: 'translucent', materialOpacity: 97, revision: 4 },
      },
    })
    await expect(loaded).resolves.toMatchObject({
      ok: true,
      value: { requested: { windowMaterial: 'translucent', revision: 4 } },
    })
    const read = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(read).resolves.toMatchObject({
      kind: 'unknown-delivery',
      error: { code: 'TIMEOUT' },
    })
    appearance.dispose()
    runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one wait, counts from fork, retains the child after timeout, and never auto-retries', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    await vi.advanceTimersByTimeAsync(3_000)
    const waiting = runtime.waitUntilReady()
    expect(runtime.waitUntilReady()).toBe(waiting)
    child.emit('message', { type: 'runtime.ready.event', unexpected: true })
    await vi.advanceTimersByTimeAsync(6_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    expect(child.killed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    child.emit('message', { type: 'runtime.ready.event' })
    child.emit('message', { type: 'runtime.ready.event' })
    expect(child.posted).toHaveLength(0)
    await expect(runtime.waitUntilReady()).resolves.toEqual({ ok: true, value: { ready: true } })
    runtime.dispose()
  })

  it('settles on exit/dispose and fences ready events from an older child', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const old = harness.children.at(-1)!
    const first = runtime.waitUntilReady()
    old.emit('exit', 1)
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
    runtime.start(startOptions)
    const next = runtime.waitUntilReady()
    old.emit('message', { type: 'runtime.ready.event' })
    expect(vi.getTimerCount()).toBe(1)
    runtime.dispose()
    await expect(next).resolves.toMatchObject({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels startup waiting when shutdown begins and ignores late readiness', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    const waiting = runtime.waitUntilReady()
    const closing = runtime.shutdown()
    child.emit('message', { type: 'runtime.ready.event' })
    await expect(waiting).resolves.toMatchObject({ ok: false })
    await expect(runtime.waitUntilReady()).resolves.toMatchObject({ ok: false })
    shutdownAck(child)
    await closing
    expect(vi.getTimerCount()).toBe(0)
  })

  it('proves pre-ready preparation was not sent and never replays it after readiness', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    await expect(
      runtime.prepareNativeQuit({ operationId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ kind: 'not-sent' })
    expect(child.posted).toHaveLength(0)
    child.emit('message', { type: 'runtime.ready.event' })
    expect(child.posted).toHaveLength(0)
    child.throwOnPost = true
    await expect(
      runtime.prepareNativeQuit({ operationId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ kind: 'not-sent' })
    runtime.dispose()
  })

  it('keeps sent preparation timeout uncertain and requires a separately acknowledged cancellation', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.emit('message', { type: 'runtime.ready.event' })
    const operationId = crypto.randomUUID()
    const preparing = runtime.prepareNativeQuit({ operationId })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(preparing).resolves.toMatchObject({
      kind: 'attempted',
      result: { ok: false, error: { code: 'UNCERTAIN' } },
    })
    const cancelled = runtime.cancelNativeQuit({ operationId })
    child.emit('message', {
      type: 'native-quit.cancel.response',
      requestId: postedRequest(child, 1).requestId,
      result: { ok: true, value: { operationId, cancelled: true } },
    })
    await expect(cancelled).resolves.toEqual({ ok: true, value: { operationId, cancelled: true } })
    runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

function fixture(measure: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'pact-ipc-test-'))
  vi.stubEnv('NODE_ENV', measure ? 'test' : 'production')
  vi.stubEnv('PACT_E2E_IPC_NONCE', measure ? 'a'.repeat(64) : '')
  vi.stubEnv('PACT_E2E_ROOT', measure ? root : '')
  const runtime = createUtilityProcessClient()
  const options = { databaseFile: join(root, 'pact.sqlite'), migrationsFolder: root }
  runtime.start(options)
  return {
    runtime,
    options,
    cleanup: () => {
      runtime.dispose()
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
async function observedHealth(
  runtime: ReturnType<typeof createUtilityProcessClient>,
  child: (typeof harness.children)[number],
) {
  const pending = runtime.getHealth()
  const packet = postedRequest(child, child.posted.length - 1)
  child.emit(
    'message',
    structuredClone({
      type: 'runtime.health.response',
      requestId: packet.requestId,
      health: {
        status: 'ready',
        database: 'ready',
        pid: 100,
        checkedAt: new Date().toISOString(),
      },
    }),
  )
  const result = await pending
  if (!result.ok) throw new Error('Expected health response.')
  return result.value
}

describe('Utility transport logical IPC observation', () => {
  it('leaves ordinary production health unchanged without isolated fixture configuration', async () => {
    const { runtime, cleanup } = fixture(false)
    try {
      const result = await observedHealth(runtime, harness.children.at(-1)!)
      expect(result.ipcTraffic).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('counts every delivered request/reply once, separates health and keeps missing Worker coverage', async () => {
    const { runtime, cleanup } = fixture(true)
    try {
      const child = harness.children.at(-1)!
      const pending = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
      const response = {
        type: 'appearance.response',
        requestId: postedRequest(child).requestId,
        result: {
          ok: true,
          value: { theme: 'system', windowMaterial: 'system', materialOpacity: 85, revision: 0 },
        },
      }
      child.emit('message', structuredClone(response))
      await expect(pending).resolves.toMatchObject({ kind: 'response' })
      const current = await observedHealth(runtime, child)
      const owner = current.ipcTraffic?.owners[0]
      expect(owner?.complete).toBe(true)
      expect(
        owner?.counters.find((row) => row.category === 'main-utility.request')?.business,
      ).toMatchObject({
        messages: 1,
        totalBytes: Buffer.byteLength(JSON.stringify(child.posted[0])),
      })
      expect(
        owner?.counters.find((row) => row.category === 'utility-main.reply')?.business,
      ).toMatchObject({
        messages: 1,
        totalBytes: Buffer.byteLength(JSON.stringify(response)),
      })
      expect(
        owner?.counters.find((row) => row.category === 'main-utility.request')?.control.messages,
      ).toBe(1)
      expect(
        owner?.counters.find((row) => row.category === 'utility-main.reply')?.control.messages,
      ).toBe(1)
      expect(current.ipcTraffic?.complete).toBe(false)
      expect(current.ipcTraffic?.uncovered).toContain('main-utility-diagnostic-control')
      expect(current.ipcTraffic?.uncovered).toContain('utility-native-json-worker')
    } finally {
      cleanup()
    }
  })

  it('observes invalid and late cloned replies without changing existing correlation behavior', async () => {
    const { runtime, cleanup } = fixture(true)
    try {
      const child = harness.children.at(-1)!
      child.emit('message', { unrecognized: true })
      const pending = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
      const response = {
        type: 'appearance.response',
        requestId: postedRequest(child).requestId,
        result: {
          ok: true,
          value: { theme: 'system', windowMaterial: 'system', materialOpacity: 85, revision: 0 },
        },
        extra: new Date(0),
      }
      child.emit('message', structuredClone(response))
      await expect(pending).resolves.toMatchObject({ kind: 'response' })
      child.emit('message', structuredClone({ ...response, extra: undefined }))
      const owner = (await observedHealth(runtime, child)).ipcTraffic?.owners[0]
      expect(owner?.issues).toContain('unvalidated_message')
      expect(owner?.issues).toContain('unsupported_prototype')
      expect(
        owner?.counters.find((row) => row.category === 'utility-main.reply')?.business,
      ).toMatchObject({ messages: 2, incompleteMessages: 1 })
    } finally {
      cleanup()
    }
  })

  it('advances a Utility restart epoch without losing cumulative Main counters', async () => {
    const { runtime, options, cleanup } = fixture(true)
    try {
      const previousChild = harness.children.at(-1)!
      const before = (await observedHealth(runtime, previousChild)).ipcTraffic?.owners[0]
      previousChild.emit('exit', 0)
      runtime.start(options)
      const after = (await observedHealth(runtime, harness.children.at(-1)!)).ipcTraffic?.owners[0]
      expect(after?.epoch).toBe(before?.epoch)
      expect(after?.transportEpoch).toBe(2)
      expect(
        after?.counters.find((row) => row.category === 'main-utility.request')?.control.messages,
      ).toBe(2)
    } finally {
      cleanup()
    }
  })

  it('keeps a failed post not-sent and marks its observation incomplete', async () => {
    const { runtime, cleanup } = fixture(true)
    try {
      const child = harness.children.at(-1)!
      child.throwOnPost = true
      await expect(
        runtime.request({ type: 'appearance.get.request' }, 'appearance.response'),
      ).resolves.toMatchObject({ kind: 'not-sent' })
      child.throwOnPost = false
      const owner = (await observedHealth(runtime, child)).ipcTraffic?.owners[0]
      expect(owner?.issues).toContain('transport_error')
      expect(
        owner?.counters.find((row) => row.category === 'main-utility.request')?.business.messages,
      ).toBe(0)
    } finally {
      cleanup()
    }
  })
})

describe('UtilityProcessClient', () => {
  it('awaits a successful shutdown ACK once, blocks new work and settles remaining requests', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const child = harness.children.at(-1)!
      const pending = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
      const startedAt = Date.now()
      const shutdown = runtime.shutdown()
      expect(runtime.shutdown()).toBe(shutdown)
      expect(child.killed).toBe(false)
      const request = postedRequest(child, 1)
      await expect(runtime.getHealth()).resolves.toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE' },
      })
      expect(child.posted).toHaveLength(2)
      child.emit('message', {
        type: 'runtime.shutdown.response',
        requestId: request.requestId,
        result: { ok: true, value: { flushed: true } },
      })
      await expect(shutdown).resolves.toEqual({ ok: true, value: { flushed: true } })
      await expect(pending).resolves.toMatchObject({ kind: 'unknown-delivery' })
      expect(child.posted[1]).toMatchObject({
        type: 'runtime.shutdown.request',
        flushDeadlineAt: startedAt + 4_000,
      })
      expect(child.killed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each(['timeout', 'failed-ack', 'exit'] as const)(
    'disposes the runtime after %s instead of leaving shutdown pending',
    async (failure) => {
      vi.useFakeTimers()
      try {
        const runtime = createUtilityProcessClient()
        runtime.start(startOptions)
        const child = harness.children.at(-1)!
        const shutdown = runtime.shutdown()
        const request = postedRequest(child)
        if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5_000)
        else if (failure === 'exit') child.emit('exit', 1)
        else
          child.emit('message', {
            type: 'runtime.shutdown.response',
            requestId: request.requestId,
            result: { ok: false, error: { code: 'INTERNAL', message: 'flush failed' } },
          })
        await expect(shutdown).resolves.toMatchObject({ ok: false })
        // An already exited child needs no kill; both other paths force disposal.
        expect(child.killed).toBe(failure !== 'exit')
        await expect(runtime.getHealth()).resolves.toMatchObject({
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE' },
        })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('waits for the ACK child to actually exit, keeping shutdown single-flight and new work blocked', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const originalChildren = harness.children.length
    const settled = vi.fn<(result: Awaited<ReturnType<typeof runtime.shutdown>>) => void>()
    const shutdown = runtime.shutdown()
    void shutdown.then(settled)
    shutdownAck(child)
    await turn()
    expect(settled).not.toHaveBeenCalled()
    expect(child.killed).toBe(true)
    expect(runtime.shutdown()).toBe(shutdown)
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(originalChildren)
    await expect(runtime.getHealth()).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
    expect(child.posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).not.toHaveBeenCalled()
    child.emit('exit', 0)
    await expect(shutdown).resolves.toEqual({ ok: true, value: { flushed: true } })
    expect(settled).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    runtime.dispose()
    expect(child.killCount).toBe(1)
  })

  it('returns UNCERTAIN at the existing 5s deadline when kill has no exit receipt and never starts a replacement', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const originalChildren = harness.children.length
    const settled = vi.fn<(result: Awaited<ReturnType<typeof runtime.shutdown>>) => void>()
    const shutdown = runtime.shutdown()
    void shutdown.then(settled)
    shutdownAck(child)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).not.toHaveBeenCalled()
    expect(child.killed).toBe(true)
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(originalChildren)
    await vi.advanceTimersByTimeAsync(1)
    await expect(shutdown).resolves.toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } })
    expect(vi.getTimerCount()).toBe(0)
    runtime.start(startOptions)
    runtime.dispose()
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(originalChildren)
    await expect(
      runtime.request({ type: 'appearance.get.request' }, 'appearance.response'),
    ).resolves.toMatchObject({ kind: 'not-sent' })
    expect(child.posted).toHaveLength(1)
  })

  it('spends only the remaining part of the same 5s deadline on exit after a late ACK', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const startedAt = Date.now()
    const shutdown = runtime.shutdown()
    await vi.advanceTimersByTimeAsync(3_900)
    expect(runtime.shutdown()).toBe(shutdown)
    expect(child.posted).toHaveLength(1)
    expect(child.killed).toBe(false)
    shutdownAck(child)
    await turn()
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_100)
    await expect(shutdown).resolves.toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } })
    expect(child.posted[0]).toMatchObject({
      type: 'runtime.shutdown.request',
      flushDeadlineAt: startedAt + 4_000,
    })
    expect(vi.getTimerCount()).toBe(0)
    runtime.start(startOptions)
    expect(harness.children.at(-1)).toBe(child)
  })

  it('forces termination after the 4s ACK reserve and succeeds only on actual exit confirmation', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const settled = vi.fn<(result: Awaited<ReturnType<typeof runtime.shutdown>>) => void>()
    const shutdown = runtime.shutdown()
    void shutdown.then(settled)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.killed).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    child.emit('exit', 1)
    await expect(shutdown).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the failed ACK while waiting for actual exit', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const settled = vi.fn<(result: Awaited<ReturnType<typeof runtime.shutdown>>) => void>()
    const shutdown = runtime.shutdown()
    void shutdown.then(settled)
    child.emit('message', {
      type: 'runtime.shutdown.response',
      requestId: postedRequest(child).requestId,
      result: { ok: false, error: { code: 'INTERNAL', message: 'flush failed' } },
    })
    await turn()
    expect(settled).not.toHaveBeenCalled()
    child.emit('exit', 0)
    await expect(shutdown).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'flush failed' },
    })
    expect(child.killed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not treat a correlated non-shutdown response as the shutdown ACK', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    const settled = vi.fn<(result: Awaited<ReturnType<typeof runtime.shutdown>>) => void>()
    const shutdown = runtime.shutdown()
    void shutdown.then(settled)
    child.emit('message', {
      type: 'runtime.health.response',
      requestId: postedRequest(child).requestId,
      health: { status: 'ready', database: 'ready', pid: 42, checkedAt: new Date().toISOString() },
    })
    await turn()
    expect(settled).not.toHaveBeenCalled()
    expect(child.killed).toBe(false)
    shutdownAck(child)
    await expect(shutdown).resolves.toEqual({ ok: true, value: { flushed: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose retains the child identity until physical exit and cannot release capacity early', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const originalChildren = harness.children.length
    const pending = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
    runtime.dispose()
    await expect(pending).resolves.toMatchObject({ kind: 'unknown-delivery' })
    expect(child.killed).toBe(true)
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(originalChildren)
    await expect(
      runtime.request({ type: 'appearance.get.request' }, 'appearance.response'),
    ).resolves.toMatchObject({ kind: 'not-sent' })
    expect(child.posted).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    child.emit('exit', 0)
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(originalChildren + 1)
    const replacement = harness.children.at(-1)!
    expect(replacement).not.toBe(child)
    runtime.dispose()
    expect(replacement.killed).toBe(true)
  })

  it('late exit releases an unresolved shutdown child, with no lingering wait listeners or timers', async () => {
    vi.useFakeTimers()
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    child.exitOnKill = false
    const initialExitListeners = child.listenerCount('exit')
    const shutdown = runtime.shutdown()
    shutdownAck(child)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(shutdown).resolves.toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } })
    expect(child.listenerCount('exit')).toBeLessThanOrEqual(initialExitListeners)
    expect(vi.getTimerCount()).toBe(0)
    child.emit('exit', 0)
    // Release is observable through admission of a replacement only after its predecessor exits.
    const childrenBeforeRestart = harness.children.length
    runtime.start(startOptions)
    expect(harness.children).toHaveLength(childrenBeforeRestart + 1)
    const replacement = harness.children.at(-1)!
    const health = runtime.getHealth()
    const replacementRequest = postedRequest(replacement)
    child.emit('message', {
      type: 'runtime.health.response',
      requestId: replacementRequest.requestId,
      health: { status: 'ready', database: 'ready', pid: 1, checkedAt: new Date().toISOString() },
    })
    child.emit('exit', 99)
    replacement.emit('message', {
      type: 'runtime.health.response',
      requestId: replacementRequest.requestId,
      health: { status: 'ready', database: 'ready', pid: 42, checkedAt: new Date().toISOString() },
    })
    await expect(health).resolves.toMatchObject({ ok: true, value: { pid: 42 } })
    expect(vi.getTimerCount()).toBe(0)
    runtime.dispose()
  })
  it('correlates concurrent responses and ignores a response with the wrong expected kind', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)
    if (!child) throw new Error('Utility child was not created.')

    const health = runtime.getHealth()
    const appearance = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
    const healthRequest = postedRequest(child)
    const appearanceRequest = postedRequest(child, 1)

    child.emit('message', {
      type: 'appearance.response',
      requestId: healthRequest.requestId,
      result: {
        ok: true,
        value: { theme: 'system', windowMaterial: 'system', materialOpacity: 85, revision: 0 },
      },
    })
    child.emit('message', {
      type: 'appearance.response',
      requestId: appearanceRequest.requestId,
      result: {
        ok: true,
        value: { theme: 'dark', windowMaterial: 'solid', materialOpacity: 85, revision: 1 },
      },
    })
    child.emit('message', {
      type: 'runtime.health.response',
      requestId: healthRequest.requestId,
      health: {
        status: 'ready',
        database: 'ready',
        pid: 42,
        checkedAt: new Date().toISOString(),
      },
    })

    await expect(appearance).resolves.toMatchObject({
      kind: 'response',
      response: { type: 'appearance.response', result: { ok: true, value: { revision: 1 } } },
    })
    await expect(health).resolves.toMatchObject({ ok: true, value: { pid: 42 } })
    runtime.dispose()
  })

  it('preserves an ambiguous delivery when a child exits after receiving a mutation', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)
    if (!child) throw new Error('Utility child was not created.')

    const update = runtime.request(
      { type: 'appearance.update.request', input: { expectedRevision: 0, theme: 'dark' } },
      'appearance.response',
    )
    child.emit('exit', 1)

    await expect(update).resolves.toMatchObject({
      kind: 'unknown-delivery',
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
  })

  it('settles a request that was never posted as definitely not sent', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)
    if (!child) throw new Error('Utility child was not created.')
    child.throwOnPost = true

    await expect(
      runtime.request({ type: 'appearance.get.request' }, 'appearance.response'),
    ).resolves.toMatchObject({
      kind: 'not-sent',
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
    runtime.dispose()
  })

  it('ignores malformed, uncorrelated, duplicate, and late responses', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)
    if (!child) throw new Error('Utility child was not created.')

    const health = runtime.getHealth()
    const request = postedRequest(child)
    const response = {
      type: 'runtime.health.response',
      requestId: request.requestId,
      health: {
        status: 'ready',
        database: 'ready',
        pid: 42,
        checkedAt: new Date().toISOString(),
      },
    }

    child.emit('message', { type: 'runtime.health.response', requestId: 'not-a-uuid' })
    child.emit('message', {
      ...response,
      requestId: '00000000-0000-4000-8000-000000000000',
    })
    child.emit('message', response)

    await expect(health).resolves.toMatchObject({ ok: true, value: { pid: 42 } })
    child.emit('message', response)
    runtime.dispose()
    child.emit('message', response)

    await expect(runtime.getHealth()).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
  })

  it('treats timeout and disposal after a post as unknown delivery', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const child = harness.children.at(-1)
      if (!child) throw new Error('Utility child was not created.')

      const timedOut = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(timedOut).resolves.toMatchObject({
        kind: 'unknown-delivery',
        error: { code: 'TIMEOUT' },
      })

      const disposed = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
      runtime.dispose()
      await expect(disposed).resolves.toMatchObject({
        kind: 'unknown-delivery',
        error: { code: 'RUNTIME_UNAVAILABLE' },
      })
      expect(child.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale-child messages and reports an unanswered accepted request as ambiguous', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const firstChild = harness.children.at(-1)
      if (!firstChild) throw new Error('Utility child was not created.')

      const lostHealth = runtime.getHealth()
      firstChild.emit('exit', 1)
      await expect(lostHealth).resolves.toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE' },
      })

      runtime.start(startOptions)
      const replacementChild = harness.children.at(-1)
      if (!replacementChild || replacementChild === firstChild) {
        throw new Error('Replacement utility child was not created.')
      }
      const health = runtime.getHealth()
      const replacementRequest = postedRequest(replacementChild)
      firstChild.emit('exit', 99)
      firstChild.emit('message', {
        type: 'runtime.health.response',
        requestId: replacementRequest.requestId,
        health: {
          status: 'ready',
          database: 'ready',
          pid: 1,
          checkedAt: new Date().toISOString(),
        },
      })
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(health).resolves.toMatchObject({
        ok: false,
        error: { code: 'TIMEOUT' },
      })
      runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Relay credential mutation delivery', () => {
  it('reports a sent remove unanswered at 5s as UNCERTAIN, never resends, and keeps the explicit receipt read', async () => {
    vi.useFakeTimers()
    const client = createUtilityProcessClient()
    try {
      client.start(startOptions)
      const child = harness.children.at(-1)!
      child.emit('message', { type: 'runtime.ready.event' })
      const nonce = randomUUID()
      let settled = false
      const removed = client
        .removeRelayApiKey({ nonce, expectedRevision: 1, deadlineAt: Date.now() + 5_000 })
        .then((result) => {
          settled = true
          return result
        })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      expect(child.posted).toHaveLength(1)
      const packet = utilityRequestSchema.parse(child.posted[0])
      if (packet.type !== 'relay.credential.write.request')
        throw new Error(`Unexpected packet type ${packet.type}`)
      expect(packet.input).toMatchObject({
        operation: 'remove',
        nonce,
        expectedRevision: 1,
      })
      await vi.advanceTimersByTimeAsync(1)
      await expect(removed).resolves.toEqual({
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'The key change could not be confirmed. Check its status.',
        },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(child.posted).toHaveLength(1)
      const read = client.readRelayCredentialReceipt(nonce)
      await vi.waitFor(() => expect(child.posted).toHaveLength(2))
      const receipt = utilityRequestSchema.parse(child.posted[1])
      expect(receipt).toMatchObject({
        type: 'relay.credential.receipt.read.request',
        input: { nonce },
      })
      child.emit('message', {
        type: 'relay.credential.receipt.read.response',
        requestId: receipt.requestId,
        result: {
          ok: true,
          value: { nonce, operation: 'remove', revision: 2, configured: false },
        },
      })
      await expect(read).resolves.toEqual({
        ok: true,
        value: { nonce, operation: 'remove', revision: 2, configured: false },
      })
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['exit', 'dispose'] as const)(
    'reports a sent remove lost to child %s as UNCERTAIN',
    async (lost) => {
      const client = createUtilityProcessClient()
      client.start(startOptions)
      const child = harness.children.at(-1)!
      child.emit('message', { type: 'runtime.ready.event' })
      const nonce = randomUUID()
      const removed = client.removeRelayApiKey({
        nonce,
        expectedRevision: 1,
        deadlineAt: Date.now() + 5_000,
      })
      expect(child.posted).toHaveLength(1)
      if (lost === 'exit') child.emit('exit', 1)
      else client.dispose()
      await expect(removed).resolves.toEqual({
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'The key change could not be confirmed. Check its status.',
        },
      })
      client.dispose()
    },
  )

  it.each([
    {
      name: 'a runtime that never started',
      arrange: (client: ReturnType<typeof createUtilityProcessClient>) => {
        void client
      },
      deadlineAt: () => Date.now() + 5_000,
      posted: 0,
    },
    {
      name: 'an already expired deadline',
      arrange: (client: ReturnType<typeof createUtilityProcessClient>) => {
        client.start(startOptions)
      },
      deadlineAt: () => Date.now() - 1,
      posted: 0,
    },
    {
      name: 'a post failure before any send',
      arrange: (client: ReturnType<typeof createUtilityProcessClient>) => {
        client.start(startOptions)
        harness.children.at(-1)!.throwOnPost = true
      },
      deadlineAt: () => Date.now() + 5_000,
      posted: 0,
    },
  ])(
    'keeps $name deterministically unavailable without inventing uncertainty',
    async ({ arrange, deadlineAt, posted }) => {
      const client = createUtilityProcessClient()
      arrange(client)
      const child = harness.children.at(-1)
      await expect(
        client.removeRelayApiKey({
          nonce: randomUUID(),
          expectedRevision: 1,
          deadlineAt: deadlineAt(),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } })
      expect(child?.posted ?? []).toHaveLength(posted)
      client.dispose()
    },
  )

  it('returns an acknowledged VALIDATION unchanged', async () => {
    const client = createUtilityProcessClient()
    client.start(startOptions)
    const child = harness.children.at(-1)!
    child.emit('message', { type: 'runtime.ready.event' })
    const nonce = randomUUID()
    const removed = client.removeRelayApiKey({
      nonce,
      expectedRevision: 1,
      deadlineAt: Date.now() + 5_000,
    })
    expect(child.posted).toHaveLength(1)
    child.emit('message', {
      type: 'relay.credential.write.response',
      requestId: postedRequest(child).requestId,
      result: {
        ok: false,
        error: { code: 'VALIDATION', message: 'revision mismatch' },
      },
    })
    await expect(removed).resolves.toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'revision mismatch' },
    })
    client.dispose()
  })

  it('keeps a save requested after the child exited deterministically unavailable', async () => {
    const client = createUtilityProcessClient()
    client.start(startOptions)
    const child = harness.children.at(-1)!
    child.emit('message', { type: 'runtime.ready.event' })
    child.emit('exit', 1)
    await expect(
      client.saveRelayApiKey({
        nonce: randomUUID(),
        expectedRevision: 0,
        deadlineAt: Date.now() + 5_000,
        key: IPC_KEY,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } })
    expect(child.posted).toHaveLength(0)
    client.dispose()
  })
})

describe('Utility client physical settlement', () => {
  it('resolves immediately when no child and no OS work remain', async () => {
    const client = createUtilityProcessClient()
    await expect(client.settlement()).resolves.toBeUndefined()
  })

  it('waits only for the running child when no OS work is pending', async () => {
    const client = createUtilityProcessClient()
    client.start(startOptions)
    const child = harness.children.at(-1)!
    const joined = vi.fn<() => void>()
    const settleJoin = client.settlement().then(() => joined())
    await flush()
    expect(joined).not.toHaveBeenCalled()
    child.emit('exit', 0)
    await settleJoin
    expect(joined).toHaveBeenCalledOnce()
    client.dispose()
  })
})

const IPC_KEY = 'OWNED_IPC_CREDENTIAL'
const IPC_CIPHER = Buffer.from('owned encrypted IPC bytes')

function diagnostics() {
  const spy = vi.fn<NonNullable<UtilityProcessStartOptions['diagnostics']>['record']>()
  return {
    identity: {
      launchId: randomUUID(),
      appVersion: '0.0.0',
      process: 'main' as const,
      pid: process.pid,
    },
    record: spy,
    attachUtility: vi.fn<NonNullable<UtilityProcessStartOptions['diagnostics']>['attachUtility']>(),
    acceptUtility: vi
      .fn<NonNullable<UtilityProcessStartOptions['diagnostics']>['acceptUtility']>()
      .mockReturnValue(false),
  } satisfies NonNullable<UtilityProcessStartOptions['diagnostics']>
}

describe.skipIf(!['darwin', 'win32'].includes(process.platform))(
  'Relay credential wiring through the actual main crypto owner',
  () => {
    beforeEach(() => {
      for (const mock of [
        harness.storage.isAsyncEncryptionAvailable,
        harness.storage.encryptStringAsync,
        harness.storage.decryptStringAsync,
      ])
        mock.mockReset()
      harness.storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
      harness.storage.encryptStringAsync.mockResolvedValue(IPC_CIPHER)
      harness.storage.decryptStringAsync.mockResolvedValue({
        result: IPC_KEY,
        shouldReEncrypt: false,
      })
    })
    it('encrypts the public key before the generic Utility write and resolves the receipt', async () => {
      const diag = diagnostics()
      const client = createUtilityProcessClient()
      try {
        client.start({ ...startOptions, diagnostics: diag })
        const child = harness.children.at(-1)!
        child.emit('message', { type: 'runtime.ready.event' })
        const nonce = randomUUID(),
          deadlineAt = Date.now() + 5000
        const saved = client.saveRelayApiKey({
          nonce,
          expectedRevision: 0,
          deadlineAt,
          key: IPC_KEY,
        })
        await vi.waitFor(() => expect(child.posted).toHaveLength(1))
        const packet = utilityRequestSchema.parse(child.posted[0])
        if (packet.type !== 'relay.credential.write.request')
          throw new Error(`Unexpected packet type ${packet.type}`)
        expect(packet.input).toEqual({
          operation: 'save',
          nonce,
          expectedRevision: 0,
          deadlineAt,
          ciphertext: IPC_CIPHER.toString('base64'),
        })
        expect(harness.storage.encryptStringAsync).toHaveBeenCalledExactlyOnceWith(IPC_KEY)
        child.emit('message', {
          type: 'relay.credential.write.response',
          requestId: packet.requestId,
          result: {
            ok: true,
            value: { nonce, operation: 'save', revision: 1, configured: true },
          },
        })
        await expect(saved).resolves.toEqual({
          ok: true,
          value: { nonce, operation: 'save', revision: 1, configured: true },
        })
        // The plaintext key never reaches a posted packet; diagnostics see neither value.
        for (const posted of child.posted) expect(JSON.stringify(posted)).not.toContain(IPC_KEY)
        for (const call of diag.record.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(IPC_KEY)
          expect(JSON.stringify(call)).not.toContain(IPC_CIPHER.toString('base64'))
        }
      } finally {
        client.dispose()
      }
    })

    it('reveals through two generic reads with plaintext only in the typed reply', async () => {
      const diag = diagnostics()
      const client = createUtilityProcessClient()
      try {
        client.start({ ...startOptions, diagnostics: diag })
        const child = harness.children.at(-1)!
        child.emit('message', { type: 'runtime.ready.event' })
        const revealed = client.revealRelayApiKey({
          expectedRevision: 1,
          deadlineAt: Date.now() + 5000,
        })
        await vi.waitFor(() => expect(child.posted).toHaveLength(1))
        const first = utilityRequestSchema.parse(child.posted[0])
        if (first.type !== 'relay.credential.read.request')
          throw new Error(`Unexpected packet type ${first.type}`)
        expect(first.input.expectedRevision).toBe(1)
        expect('key' in first.input || 'ciphertext' in first.input).toBe(false)
        child.emit('message', {
          type: 'relay.credential.read.response',
          requestId: first.requestId,
          result: { ok: true, value: { revision: 1, ciphertext: IPC_CIPHER.toString('base64') } },
        })
        await vi.waitFor(() => expect(child.posted).toHaveLength(2))
        const second = utilityRequestSchema.parse(child.posted[1])
        if (second.type !== 'relay.credential.read.request')
          throw new Error(`Unexpected packet type ${second.type}`)
        child.emit('message', {
          type: 'relay.credential.read.response',
          requestId: second.requestId,
          result: { ok: true, value: { revision: 1, ciphertext: IPC_CIPHER.toString('base64') } },
        })
        await expect(revealed).resolves.toEqual({
          ok: true,
          value: { revision: 1, key: IPC_KEY },
        })
        // Plaintext never reaches a posted packet or a diagnostic record.
        for (const posted of child.posted) expect(JSON.stringify(posted)).not.toContain(IPC_KEY)
        for (const call of diag.record.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(IPC_KEY)
          expect(JSON.stringify(call)).not.toContain(IPC_CIPHER.toString('base64'))
        }
      } finally {
        client.dispose()
      }
    })

    it('does not resend an uncertain encrypted write and requires an explicit receipt read', async () => {
      vi.useFakeTimers()
      harness.storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
      harness.storage.encryptStringAsync.mockResolvedValue(IPC_CIPHER)
      const client = createUtilityProcessClient()
      try {
        client.start(startOptions)
        const child = harness.children.at(-1)!
        child.emit('message', { type: 'runtime.ready.event' })
        const nonce = randomUUID(),
          deadlineAt = Date.now() + 5000
        let settled = false
        const saved = client
          .saveRelayApiKey({ nonce, expectedRevision: 0, deadlineAt, key: IPC_KEY })
          .then((result) => {
            settled = true
            return result
          })
        await vi.advanceTimersByTimeAsync(4999)
        expect(settled).toBe(false)
        expect(child.posted).toHaveLength(1)
        const first = utilityRequestSchema.parse(child.posted[0])
        if (first.type !== 'relay.credential.write.request')
          throw new Error(`Unexpected packet type ${first.type}`)
        expect(first.input).toEqual({
          operation: 'save',
          nonce,
          expectedRevision: 0,
          deadlineAt,
          ciphertext: IPC_CIPHER.toString('base64'),
        })
        expect(JSON.stringify(first)).not.toContain(IPC_KEY)
        await vi.advanceTimersByTimeAsync(1)
        await expect(saved).resolves.toMatchObject({
          ok: false,
          error: { code: 'UNCERTAIN' },
        })
        expect(settled).toBe(true)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(child.posted).toHaveLength(1)
        const read = client.readRelayCredentialReceipt(nonce)
        await vi.waitFor(() => expect(child.posted).toHaveLength(2))
        const packet = utilityRequestSchema.parse(child.posted[1])
        expect(packet).toMatchObject({
          type: 'relay.credential.receipt.read.request',
          input: { nonce },
        })
        child.emit('message', {
          type: 'relay.credential.receipt.read.response',
          requestId: packet.requestId,
          result: {
            ok: true,
            value: { nonce, operation: 'save', revision: 1, configured: true },
          },
        })
        await expect(read).resolves.toEqual({
          ok: true,
          value: { nonce, operation: 'save', revision: 1, configured: true },
        })
      } finally {
        try {
          client.dispose()
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      }
    })

    it('binds the private decrypt source to the current Utility and bypasses generic traffic', async () => {
      const first = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
      let calls = 0
      harness.storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
      harness.storage.decryptStringAsync.mockImplementation(() => {
        calls += 1
        return calls === 1
          ? first.promise
          : Promise.resolve({ result: IPC_KEY, shouldReEncrypt: false })
      })
      const traffic = new LogicalIpcWorkerTraffic(['main-utility', 'main-directory'], randomUUID())
      const record = vi.spyOn(traffic.collector('main-utility')!, 'record')
      const diag = diagnostics()
      const client = createUtilityProcessClient()
      try {
        client.start({ ...startOptions, diagnostics: diag, traffic })
        const child = harness.children.at(-1)!
        child.emit('message', { type: 'runtime.ready.event' })
        record.mockClear()
        diag.acceptUtility.mockClear()
        const requestId = randomUUID()
        child.emit('message', {
          type: 'relay.credential.decrypt.request',
          requestId,
          deadlineAt: Date.now() + 5000,
          ciphertext: IPC_CIPHER.toString('base64'),
        })
        await vi.waitFor(() => expect(harness.storage.decryptStringAsync).toHaveBeenCalledTimes(1))
        // Private packets never reach generic traffic accounting or utility acceptance.
        expect(record).not.toHaveBeenCalled()
        expect(diag.acceptUtility).not.toHaveBeenCalled()
        const oldPosted = [...child.posted]
        child.emit('exit', 0)
        client.start({ ...startOptions, diagnostics: diag, traffic })
        const next = harness.children.at(-1)!
        next.emit('message', { type: 'runtime.ready.event' })
        record.mockClear()
        diag.acceptUtility.mockClear()
        const busyId = randomUUID()
        next.emit('message', {
          type: 'relay.credential.decrypt.request',
          requestId: busyId,
          deadlineAt: Date.now() + 5000,
          ciphertext: IPC_CIPHER.toString('base64'),
        })
        await vi.waitFor(() => expect(next.posted).toHaveLength(1))
        // The old child's outstanding native decrypt keeps the new source busy.
        expect(next.posted[0]).toEqual({
          type: 'relay.credential.decrypt.response',
          requestId: busyId,
          result: { ok: false, reason: 'busy' },
        })
        expect(harness.storage.decryptStringAsync).toHaveBeenCalledTimes(1)
        first.resolve({ result: IPC_KEY, shouldReEncrypt: false })
        await new Promise((resolve) => setImmediate(resolve))
        // No plaintext was delivered to the exited child.
        expect(child.posted).toEqual(oldPosted)
        // The current source's explicit new request gets the positive private reply.
        const requestId2 = randomUUID()
        next.emit('message', {
          type: 'relay.credential.decrypt.request',
          requestId: requestId2,
          deadlineAt: Date.now() + 5000,
          ciphertext: IPC_CIPHER.toString('base64'),
        })
        await vi.waitFor(() => expect(next.posted).toHaveLength(2))
        expect(next.posted[1]).toEqual({
          type: 'relay.credential.decrypt.response',
          requestId: requestId2,
          result: { ok: true, key: IPC_KEY },
        })
        expect(harness.storage.decryptStringAsync).toHaveBeenCalledTimes(2)
        expect(record).not.toHaveBeenCalled()
        expect(diag.acceptUtility).not.toHaveBeenCalled()
        // A malformed private packet is consumed without forwarding or logging.
        next.emit('message', { type: 'relay.credential.decrypt.request', key: IPC_KEY })
        await vi.waitFor(() => expect(harness.storage.decryptStringAsync).toHaveBeenCalledTimes(2))
        for (const call of diag.record.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(IPC_KEY)
          expect(JSON.stringify(call)).not.toContain(IPC_CIPHER.toString('base64'))
        }
        expect(record).not.toHaveBeenCalled()
        expect(diag.acceptUtility).not.toHaveBeenCalled()
      } finally {
        first.resolve({ result: IPC_KEY, shouldReEncrypt: false })
        await new Promise((resolve) => setImmediate(resolve))
        client.dispose()
        record.mockRestore()
      }
    })

    it('reports shutdown UNCERTAIN at 5s while hung OS work still fences the physical join', async () => {
      vi.useFakeTimers()
      const cryptoWork = Promise.withResolvers<boolean>()
      harness.storage.isAsyncEncryptionAvailable.mockImplementation(() => cryptoWork.promise)
      const client = createUtilityProcessClient()
      try {
        client.start(startOptions)
        const child = harness.children.at(-1)!
        child.exitOnKill = false
        child.emit('message', { type: 'runtime.ready.event' })
        const baseline = child.listenerCount('exit')
        const saved = client.saveRelayApiKey({
          nonce: randomUUID(),
          expectedRevision: 0,
          deadlineAt: Date.now() + 5_000,
          key: IPC_KEY,
        })
        await vi.waitFor(() =>
          expect(harness.storage.isAsyncEncryptionAvailable).toHaveBeenCalledOnce(),
        )
        const shutdown = client.shutdown()
        const joined = vi.fn<() => void>()
        const settleJoin = client.settlement().then(() => joined())
        shutdownAck(child)
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(shutdown).resolves.toMatchObject({
          ok: false,
          error: { code: 'UNCERTAIN' },
        })
        await expect(saved).resolves.toMatchObject({ ok: false })
        expect(joined).not.toHaveBeenCalled()
        child.emit('exit', 0)
        await turn()
        expect(joined).not.toHaveBeenCalled()
        cryptoWork.resolve(true)
        await settleJoin
        expect(joined).toHaveBeenCalledOnce()
        for (const posted of child.posted) {
          const text = JSON.stringify(posted)
          expect(text).not.toContain('relay.credential.write.request')
          expect(text).not.toContain(IPC_KEY)
          expect(text).not.toContain(IPC_CIPHER.toString('base64'))
        }
        expect(child.listenerCount('exit')).toBe(baseline)
      } finally {
        cryptoWork.resolve(true)
        client.dispose()
        vi.useRealTimers()
      }
    })

    it.each(['crypto-first', 'exit-first'] as const)(
      'fences the physical join on both hung OS work and child exit (%s)',
      async (order) => {
        const cryptoWork = Promise.withResolvers<boolean>()
        harness.storage.isAsyncEncryptionAvailable.mockImplementation(() => cryptoWork.promise)
        const client = createUtilityProcessClient()
        try {
          client.start(startOptions)
          const child = harness.children.at(-1)!
          child.exitOnKill = false
          child.emit('message', { type: 'runtime.ready.event' })
          const saved = client.saveRelayApiKey({
            nonce: randomUUID(),
            expectedRevision: 0,
            deadlineAt: Date.now() + 5_000,
            key: IPC_KEY,
          })
          await vi.waitFor(() =>
            expect(harness.storage.isAsyncEncryptionAvailable).toHaveBeenCalledOnce(),
          )
          const shutdown = client.shutdown()
          const joined = vi.fn<() => void>()
          const settleJoin = client.settlement().then(() => joined())
          shutdownAck(child)
          await flush()
          expect(joined).not.toHaveBeenCalled()
          if (order === 'crypto-first') {
            cryptoWork.resolve(true)
            await saved
          } else {
            child.emit('exit', 0)
          }
          await flush()
          expect(joined).not.toHaveBeenCalled()
          if (order === 'crypto-first') child.emit('exit', 0)
          else cryptoWork.resolve(true)
          await settleJoin
          expect(joined).toHaveBeenCalledOnce()
          await expect(shutdown).resolves.toEqual({ ok: true, value: { flushed: true } })
        } finally {
          cryptoWork.resolve(true)
          client.dispose()
        }
      },
    )
  },
)
