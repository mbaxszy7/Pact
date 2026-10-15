import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { SqliteFinal } from '@pact/contracts'

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeUtilityProcess {
    pid: number | undefined
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

function fixture(measure: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'pact-ipc-test-'))
  vi.stubEnv('PACT_SOAK_NONCE', measure ? 'a'.repeat(64) : '')
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
  it('leaves ordinary production health unchanged without isolated soak configuration', async () => {
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
  it('transfers a bounded health ACK and returns its validation error without disposing the runtime', async () => {
    const runtime = createUtilityProcessClient()
    runtime.start(startOptions)
    const child = harness.children.at(-1)!
    const input = {
      sqlitePlans: {
        ack: {
          observerEpoch: '00000000-0000-4000-8000-000000000001',
          pageSequence: 1,
          payloadDigest: 'a'.repeat(64),
        },
      },
    }
    try {
      const pending = runtime.getHealth(input)
      expect(child.posted.at(-1)).toMatchObject({ type: 'runtime.health.request', input })
      const error = {
        code: 'VALIDATION',
        message: 'The runtime health observation could not be read.',
      }
      child.emit('message', {
        type: 'runtime.health.response',
        requestId: postedRequest(child).requestId,
        error,
      })
      await expect(pending).resolves.toEqual({ ok: false, error })
      expect(child.killed).toBe(false)
      expect(await observedHealth(runtime, child)).toMatchObject({
        status: 'ready',
        database: 'ready',
      })
    } finally {
      runtime.dispose()
    }
  })

  it.each([true, false])(
    'preserves final SQLite metadata on a %s flush result from the bound Utility',
    async (success) => {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const child = harness.children.at(-1)!
      child.pid = 41001
      const final: SqliteFinal = {
        schemaVersion: 1,
        scope: 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1',
        observerEpoch: '00000000-0000-4000-8000-000000000001',
        observerPid: child.pid,
        recordWatermark: 0,
        acknowledgedThrough: 0,
        pageSequence: 0,
        tailRecords: [],
        counters: {
          operations: 0,
          transactions: 0,
          rowsReturned: 0,
          totalMs: 0,
          maxMs: 0,
          planOverflow: false,
          unsupportedOperations: false,
        },
        databaseClosed: success,
        writerClosed: success,
        collectionDisposed: true,
      }
      const result = success
        ? { ok: true as const, value: { flushed: true as const } }
        : {
            ok: false as const,
            error: { code: 'INTERNAL' as const, message: 'Flush did not finish.' },
          }
      const pending = runtime.shutdown()
      child.emit('message', {
        type: 'runtime.shutdown.response',
        requestId: postedRequest(child).requestId,
        result,
        sqliteFinal: final,
      })
      await expect(pending).resolves.toEqual({ ...result, sqliteFinal: final })
      expect(child.killed).toBe(true)
    },
  )

  it.each([undefined, 41002])(
    'drops a final receipt when the request-bound Utility PID is %s',
    async (pid) => {
      const runtime = createUtilityProcessClient()
      runtime.start(startOptions)
      const child = harness.children.at(-1)!
      child.pid = pid
      const result = { ok: true as const, value: { flushed: true as const } }
      const pending = runtime.shutdown()
      child.emit('message', {
        type: 'runtime.shutdown.response',
        requestId: postedRequest(child).requestId,
        result,
        sqliteFinal: {
          schemaVersion: 1,
          scope: 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1',
          observerEpoch: '00000000-0000-4000-8000-000000000001',
          observerPid: 41001,
          recordWatermark: 0,
          acknowledgedThrough: 0,
          pageSequence: 0,
          tailRecords: [],
          counters: {
            operations: 0,
            transactions: 0,
            rowsReturned: 0,
            totalMs: 0,
            maxMs: 0,
            planOverflow: false,
            unsupportedOperations: false,
          },
          databaseClosed: true,
          writerClosed: true,
          collectionDisposed: true,
        },
      })
      await expect(pending).resolves.toEqual(result)
    },
  )

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
