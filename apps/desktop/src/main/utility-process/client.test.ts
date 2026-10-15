import { afterEach, describe, expect, it, vi } from 'vitest'

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
  return { FakeUtilityProcess, children }
})

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new harness.FakeUtilityProcess()
      harness.children.push(child)
      return child
    },
  },
}))

import {
  createAppearanceController,
  type NativeThemeSource,
} from '../modules/appearance/controller.js'
import { createUtilityProcessClient } from './client.js'

const startOptions = {
  databaseFile: ':memory:',
  migrationsFolder: '/tmp/pact-migrations',
}

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

describe('Utility startup readiness and quit delivery', () => {
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

describe('UtilityProcessClient', () => {
  it('awaits a successful shutdown ACK once, blocks new work and settles remaining requests', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const child = harness.children.at(-1)!
      const pending = runtime.request({ type: 'appearance.get.request' }, 'appearance.response')
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
    const shutdown = runtime.shutdown()
    await vi.advanceTimersByTimeAsync(3_900)
    expect(child.killed).toBe(false)
    shutdownAck(child)
    await turn()
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_100)
    await expect(shutdown).resolves.toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } })
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
