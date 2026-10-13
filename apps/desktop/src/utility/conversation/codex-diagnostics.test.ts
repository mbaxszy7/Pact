import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagnosticEventSchema, type DiagnosticEvent } from '@pact/contracts/diagnostics'

const capture = vi.hoisted(() => ({ events: [] as DiagnosticEvent[] }))
vi.mock('../../diagnostics/utility-log', () => ({
  recordDiagnostic: (event: DiagnosticEvent) => capture.events.push(event),
}))

import { executable, isolatedEnv, ownedRoot } from '../../../../../tests/native/native-harness.js'
import { CodexAppServerConnection } from './codex-app-server-connection'

const children = new Set<ChildProcessWithoutNullStreams>()
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }),
  )
  children.clear()
  capture.events.length = 0
})

/** Real process/framing seam, with synthetic protocol data and no provider/model. */
function protocolChild(
  reply: object | null,
  exitAfterRequest = false,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    let input = '';
    process.stdin.on('data', chunk => {
      input += chunk;
      while (input.includes('\\n')) {
        const cut = input.indexOf('\\n');
        const request = JSON.parse(input.slice(0, cut)); input = input.slice(cut + 1);
        if (${exitAfterRequest}) { process.exit(7); return; }
        const reply = ${JSON.stringify(reply)};
        if (reply) process.stdout.write(JSON.stringify({id: request.id, ...reply}) + '\\n');
      }
    });
  `,
    ],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.add(child)
  return child
}

function lastRequest(): DiagnosticEvent {
  return capture.events.findLast((event) => event.scope === 'request')!
}

describe('Codex diagnostic facts', () => {
  it('records a native rejection code and method without interpreting it as process exit or copying its message/data', async () => {
    const secret = 'fixture-private-token-and-message'
    const reply = { error: { code: -32600, message: secret, data: { Authorization: secret } } }
    const child = protocolChild(reply)
    const connection = new CodexAppServerConnection(child)
    try {
      const result = await connection.request(
        'thread/resume',
        { threadId: randomUUID(), secret },
        { timeoutMs: 2000 },
      )
      expect(result).toMatchObject(reply) // Product reply stays unchanged.
      const fact = lastRequest()
      expect(fact).toMatchObject({
        nativeMethod: 'thread/resume',
        nativeErrorCode: -32600,
        phase: 'blocked',
        failureSource: 'native_rpc_rejection',
        code: 'native_rpc_rejected',
        executorId: connection.executorId,
      })
      expect(diagnosticEventSchema.safeParse(fact).success).toBe(true)
      expect(JSON.stringify(capture.events)).not.toContain(secret)
      expect(capture.events.some((event) => event.failureSource === 'process_exit')).toBe(false)
      expect(connection.isOpen).toBe(true)
      expect(connection.diagnostics().pendingRequests).toBe(0)
    } finally {
      await connection.close()
    }
  })

  it.each(['credential-string', 2 ** 40, 1.5])(
    'omits an untrusted or non-integer error code %s',
    async (code) => {
      const child = protocolChild({ error: { code, message: 'private native payload' } })
      const connection = new CodexAppServerConnection(child)
      try {
        await connection.request('turn/start', { input: 'private prompt' }, { timeoutMs: 2000 })
        expect(lastRequest()).toMatchObject({
          phase: 'blocked',
          nativeMethod: 'turn/start',
          failureSource: 'native_rpc_rejection',
        })
        expect(lastRequest()).not.toHaveProperty('nativeErrorCode')
        expect(JSON.stringify(capture.events)).not.toContain('private')
      } finally {
        await connection.close()
      }
    },
  )

  it('distinguishes a deadline from a native refusal', async () => {
    const child = protocolChild(null)
    const connection = new CodexAppServerConnection(child)
    try {
      await expect(connection.request('thread/read', {}, { timeoutMs: 40 })).rejects.toMatchObject({
        kind: 'transient_transport',
      })
      expect(lastRequest()).toMatchObject({
        phase: 'timeout',
        code: 'TIMEOUT',
        failureSource: 'timeout',
        nativeMethod: 'thread/read',
      })
      expect(lastRequest()).not.toHaveProperty('nativeErrorCode')
      expect(connection.diagnostics().pendingRequests).toBe(0)
    } finally {
      await connection.close()
    }
  })

  it('distinguishes cancellation without claiming a process crash', async () => {
    const child = protocolChild(null)
    const connection = new CodexAppServerConnection(child)
    const controller = new AbortController()
    try {
      const pending = connection.request(
        'thread/read',
        {},
        { timeoutMs: 2000, signal: controller.signal },
      )
      const outcome = pending.catch((error: unknown) => error)
      controller.abort()
      await outcome
      expect(lastRequest()).toMatchObject({
        phase: 'interrupted',
        code: 'request_cancelled',
        failureSource: 'cancelled',
      })
      expect(connection.isOpen).toBe(true)
    } finally {
      await connection.close()
    }
  })

  it('records an actual process exit exactly once with its exit code and executor', async () => {
    const child = protocolChild(null, true)
    const connection = new CodexAppServerConnection(child)
    await expect(connection.request('thread/read', {}, { timeoutMs: 2000 })).rejects.toMatchObject({
      kind: 'agent_process_crash',
    })
    const exits = capture.events.filter(
      (event) => event.scope === 'process' && event.failureSource === 'process_exit',
    )
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({
      exitCode: 7,
      executorId: connection.executorId,
      pid: child.pid,
    })
    expect(lastRequest()).toMatchObject({ failureSource: 'process_exit' })
    await connection.close()
    expect(
      capture.events.filter(
        (event) => event.scope === 'process' && event.failureSource === 'process_exit',
      ),
    ).toHaveLength(1)
  })

  it('never logs arbitrary method strings and does not log streaming notifications', async () => {
    const child = protocolChild({ result: { body: 'private result' } })
    const connection = new CodexAppServerConnection(child)
    try {
      await connection.request('private-method-with-secret', {}, { timeoutMs: 2000 })
      expect(lastRequest()).toMatchObject({ nativeMethod: 'unrecognized', phase: 'completed' })
      expect(JSON.stringify(capture.events)).not.toContain('private')
      const before = capture.events.length
      const subscription = connection.subscribeBackground(() => true)
      child.stdout.emit(
        'data',
        Buffer.from(
          Array.from(
            { length: 1000 },
            () =>
              JSON.stringify({
                method: 'item/agentMessage/delta',
                params: { delta: 'private streamed text' },
              }) + '\n',
          ).join(''),
        ),
      )
      subscription()
      expect(capture.events).toHaveLength(before)
    } finally {
      await connection.close()
    }
  })
  it.runIf(process.env.PACT_DIAGNOSTIC_NATIVE_PROBE === '1')(
    'records a real installed Codex refusal with no model request or user Native data',
    async () => {
      const owned = await ownedRoot()
      let connection: CodexAppServerConnection | undefined
      try {
        const binary = await executable('codex', owned)
        const child = spawn(binary, ['app-server'], {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: owned.cwd,
          env: isolatedEnv(owned.root, owned.home),
        })
        children.add(child)
        connection = new CodexAppServerConnection(child)
        await connection.request(
          'initialize',
          { clientInfo: { name: 'pact', title: 'Pact owned diagnostic probe', version: '0.0.0' } },
          { timeoutMs: 5000 },
        )
        await connection.notify('initialized', {})
        const result = await connection.request(
          'thread/resume',
          { threadId: randomUUID() },
          { timeoutMs: 5000 },
        )
        const error = Reflect.get(result, 'error')
        expect(error && typeof error === 'object').toBe(true)
        const nativeCode = Reflect.get(error, 'code')
        expect(typeof nativeCode).toBe('number')
        console.info(
          '[diagnostic native probe]',
          JSON.stringify({
            nativeMethod: lastRequest().nativeMethod,
            nativeErrorCode: nativeCode,
            failureSource: lastRequest().failureSource,
          }),
        )
        expect(lastRequest()).toMatchObject({
          nativeMethod: 'thread/resume',
          nativeErrorCode: nativeCode,
          code: 'native_rpc_rejected',
          failureSource: 'native_rpc_rejection',
          phase: 'blocked',
        })
        expect(capture.events.some((event) => event.nativeMethod === 'turn/start')).toBe(false)
        expect(
          capture.events
            .filter((event) => event.scope === 'request')
            .every((event) => diagnosticEventSchema.safeParse(event).success),
        ).toBe(true)
      } finally {
        await connection?.close()
        await rm(owned.root, { recursive: true, force: true })
      }
    },
    15_000,
  )
})
