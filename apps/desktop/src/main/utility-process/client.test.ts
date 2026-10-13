import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeUtilityProcess {
    readonly handlers = new Map<string, Listener[]>()
    readonly posted: unknown[] = []
    throwOnPost = false
    killed = false

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

    kill(): void {
      this.killed = true
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.handlers.get(event) ?? []) listener(...args)
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

import { createUtilityProcessClient } from './client.js'

const startOptions = {
  databaseFile: ':memory:',
  migrationsFolder: '/tmp/pact-migrations',
}

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
