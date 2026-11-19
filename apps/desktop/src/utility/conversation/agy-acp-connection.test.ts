/* oxlint-disable no-await-in-loop, typescript/no-unsafe-type-assertion -- Protocol stubs model Node child-process stdio streams. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEffectiveExecutionSettings } from '@pact/contracts'

import {
  AGY_IDLE_CONNECTION_TIMEOUT_MS,
  AGY_MAX_CONTEXTS,
  AGY_MAX_FRAME_BYTES,
  AGY_PENDING_REQUEST_LIMIT,
  AGY_QUEUE_HIGH_WATER_BYTES,
  AGY_QUEUE_LOW_WATER_BYTES,
  AGY_STDERR_LIMIT_BYTES,
  AgyAcpConnection,
  AgyAcpConnectionPool,
  agyProcessEnvironment,
  createAgyRootFrameNotWrittenProof,
  type AgyPermissionScope,
} from './agy-acp-connection.js'

const tempDirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeAcpChild(options: { blockWrites?: boolean } = {}) {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const receivedFrames: Record<string, unknown>[] = []
  let stdinRemainder = ''
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let blocked = Boolean(options.blockWrites)
  let onRequestHandler: ((frame: Record<string, unknown>) => void) | undefined

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdinRemainder += chunk.toString('utf8')
      let newline = stdinRemainder.indexOf('\n')
      while (newline !== -1) {
        const line = stdinRemainder.slice(0, newline).trim()
        stdinRemainder = stdinRemainder.slice(newline + 1)
        if (line) {
          const parsed = JSON.parse(line) as Record<string, unknown>
          receivedFrames.push(parsed)
          onRequestHandler?.(parsed)
        }
        newline = stdinRemainder.indexOf('\n')
      }
      callback()
    },
  })
  const rawStdinWrite = stdin.write.bind(stdin)
  stdin.write = ((chunk: Buffer) => {
    const accepted = rawStdinWrite(chunk)
    return blocked ? false : accepted
  }) as typeof stdin.write

  const childRecord = Object.assign(emitter, {
    pid: 42_420,
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(sig: NodeJS.Signals = 'SIGTERM') {
      if (exitCode !== null || signalCode !== null) return true
      signalCode = sig
      exitCode = 0
      childRecord.signalCode = sig
      childRecord.exitCode = 0
      blocked = false
      stdin.emit('drain')
      emitter.emit('exit', 0, sig)
      emitter.emit('close', 0, sig)
      return true
    },
  })
  const child = childRecord as unknown as ChildProcessWithoutNullStreams

  return {
    child,
    receivedFrames,
    send(payload: object) {
      stdout.write(`${JSON.stringify(payload)}\n`)
    },
    sendRaw(raw: Buffer | string) {
      stdout.write(raw)
    },
    sendStderr(raw: string) {
      stderr.write(raw)
    },
    onRequest(handler: (frame: Record<string, unknown>) => void) {
      onRequestHandler = handler
    },
    unblockWrite() {
      blocked = false
      stdin.emit('drain')
    },
    blockWrite() {
      blocked = true
    },
  }
}

function makeAgyEffectiveSettings(
  permissionMode: RunEffectiveExecutionSettings['permissionMode'] = 'ask',
): RunEffectiveExecutionSettings {
  const configurationSha256 = createHash('sha256')
    .update(JSON.stringify({ provider: 'agy', model: 'gemini-4-carbon', permissionMode }))
    .digest('hex')
  return {
    version: 1,
    provider: 'agy',
    model: 'gemini-4-carbon',
    effort: { known: true, value: 'high' },
    speed: 'native',
    permissionMode,
    configurationSha256,
    provenance: 'agy_applied_settings',
  }
}

describe('AgyAcpConnectionPool lifecycle, CWD canonicalization, and Full access isolation', () => {
  it('pools strictly by (canonicalProjectDir, permissionScope) with exact CLI flags and clientInfo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-pool-'))
    tempDirs.push(root)
    const projectA = join(root, 'project-a')
    const projectASymlink = join(root, 'project-a-link')
    const projectB = join(root, 'project-b')
    await mkdir(projectA, { recursive: true })
    await mkdir(projectB, { recursive: true })
    await symlink(projectA, projectASymlink)
    const canonicalA = await realpath(projectA)

    const spawns: Array<{
      canonicalCwd: string
      args: readonly string[]
      scope: AgyPermissionScope
      env: NodeJS.ProcessEnv
    }> = []

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      clientInfo: { name: 'pact', title: 'Pact', version: '0.5.0' },
      processFactory(canonicalCwd, args, scope, env) {
        spawns.push({ canonicalCwd, args, scope, env })
        const fake = fakeAcpChild()
        fake.onRequest((frame) => {
          if (frame.method === 'initialize') {
            expect(frame.params).toEqual({
              protocolVersion: 1,
              capabilities: { elicitation: { form: {} } },
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                elicitation: { form: {} },
              },
              clientInfo: { name: 'pact', title: 'Pact', version: '0.5.0' },
            })
            fake.send({
              jsonrpc: '2.0',
              id: frame.id,
              result: { protocolVersion: 1, agentInfo: { name: 'agy', version: '1.5.11' } },
            })
          }
        })
        return fake.child
      },
    })

    const signal = new AbortController().signal
    const leaseA1 = await pool.acquire({
      cwd: projectA,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-main',
      signal,
    })
    await leaseA1.ensureInitialized(signal)

    // Symlink to projectA reuses the exact same 'standard' connection!
    const leaseA2 = await pool.acquire({
      cwd: projectASymlink,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-side',
      signal,
    })
    expect(leaseA2.connection).toBe(leaseA1.connection)
    expect(leaseA2.canonicalCwd).toBe(canonicalA)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      canonicalCwd: canonicalA,
      args: ['acp', '--process-per-session', '--disable-telemetry'],
      scope: 'standard',
    })
    expect(spawns[0]?.env.NO_PROXY).toContain('127.0.0.1')
    expect(spawns[0]?.env.NO_PROXY).toContain('localhost')

    // Different project directory spawns a distinct connection!
    const leaseB = await pool.acquire({
      cwd: projectB,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-b',
      signal,
    })
    expect(leaseB.connection).not.toBe(leaseA1.connection)
    expect(spawns).toHaveLength(2)

    leaseA1.release()
    leaseA2.release()
    leaseB.release()
    await pool.dispose()
  })

  it('forbids full pool on read-only stages or non-full modes, ref-counts sibling Side Chats, and drains on exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-full-'))
    tempDirs.push(root)
    const spawns: Array<{ scope: AgyPermissionScope; args: readonly string[] }> = []

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(_cwd, args, scope) {
        spawns.push({ scope, args })
        const fake = fakeAcpChild()
        fake.onRequest((frame) => {
          if (frame.method === 'initialize') {
            fake.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          }
        })
        return fake.child
      },
    })

    // Reject full scope for readOnly stages and non-full permission modes!
    await expect(
      pool.acquire({
        cwd: root,
        permissionScope: 'full',
        permissionMode: 'full',
        readOnly: true,
        sessionId: 'main-session',
      }),
    ).rejects.toThrow(/cannot be used for read-only stages/u)

    for (const mode of ['native', 'ask', 'auto'] as const) {
      await expect(
        pool.acquire({
          cwd: root,
          permissionScope: 'full',
          permissionMode: mode,
          readOnly: false,
          sessionId: 'main-session',
        }),
      ).rejects.toThrow(/non-Full permission modes/u)
    }
    expect(spawns).toHaveLength(0)

    // Acquire Full access for both main-session and side-chat-1 in the same project.
    const mainFull = await pool.acquire({
      cwd: root,
      permissionScope: 'full',
      permissionMode: 'full',
      sessionId: 'main-session',
    })
    const sideFull = await pool.acquire({
      cwd: root,
      permissionScope: 'full',
      permissionMode: 'full',
      sessionId: 'side-chat-1',
    })
    expect(mainFull.connection).toBe(sideFull.connection)
    expect(spawns).toEqual([
      {
        scope: 'full',
        args: [
          'acp',
          '--process-per-session',
          '--disable-telemetry',
          '--dangerously-skip-permissions',
        ],
      },
    ])

    // Main session finishes and switches away from Full access -> 'ask' while side-chat-1 is still active!
    mainFull.release()
    await pool.retireFullAccess({ sessionId: 'main-session', cwd: root })
    // Sibling Side Chat's Full connection MUST remain alive while side-chat-1 holds Full access!
    expect(sideFull.connection.isOpen).toBe(true)

    // Now retire side-chat-1 while its lease is still running: connection drains until sideFull releases, then closes immediately!
    await pool.retireFullAccess({ sessionId: 'side-chat-1', cwd: root })
    expect(sideFull.connection.isOpen).toBe(true)

    sideFull.release()
    await vi.waitFor(() => {
      expect(sideFull.connection.isOpen).toBe(false)
    })

    await pool.dispose()
  })

  it('reaps settled standard connections after 5 minutes idle and enforces the 8-context ceiling', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-reaper-'))
    tempDirs.push(root)

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        return fakeAcpChild().child
      },
    })

    const leases = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS }, (_, idx) =>
        pool.acquire({
          cwd: root,
          permissionScope: 'standard',
          permissionMode: 'ask',
          sessionId: `sess-${idx}`,
        }),
      ),
    )
    await expect(
      pool.acquire({
        cwd: root,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-overflow',
      }),
    ).rejects.toThrow(/too many active native contexts/u)

    const conn = leases[0]!.connection
    for (const l of leases) l.release()
    expect(conn.isOpen).toBe(true)

    await vi.advanceTimersByTimeAsync(AGY_IDLE_CONNECTION_TIMEOUT_MS - 1_000)
    expect(conn.isOpen).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(conn.isOpen).toBe(false)

    await pool.dispose()
  })

  it('reserves the 8-lease ceiling synchronously before await realpath and releases failed reservations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-sync-cap-'))
    tempDirs.push(root)

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        return fakeAcpChild().child
      },
    })

    // Fire 9 concurrent acquire() calls synchronously on an empty pool!
    const attempts = Array.from({ length: AGY_MAX_CONTEXTS + 1 }, (_, idx) =>
      pool.acquire({
        cwd: root,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `concurrent-${idx}`,
      }),
    )
    const settled = await Promise.allSettled(attempts)
    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<Awaited<(typeof attempts)[number]>> =>
        r.status === 'fulfilled',
    )
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled).toHaveLength(AGY_MAX_CONTEXTS)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toMatch(/too many active native contexts/u)
    expect(pool.activeLeaseCount).toBe(AGY_MAX_CONTEXTS)

    // Release 1 lease, then verify a failing realpath releases its synchronous slot cleanly!
    fulfilled[0]!.value.release()
    await expect(
      pool.acquire({
        cwd: join(root, 'does-not-exist'),
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'missing-cwd',
      }),
    ).rejects.toThrow(/ENOENT/u)
    expect(pool.activeLeaseCount).toBe(AGY_MAX_CONTEXTS - 1)

    const replacement = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'replacement',
    })
    expect(pool.activeLeaseCount).toBe(AGY_MAX_CONTEXTS)

    replacement.release()
    for (const item of fulfilled.slice(1)) item.value.release()
    await pool.dispose()
  })

  it('closes retired Full connections and arms idle reaper as soon as pendingPhysicalRequests drains to empty', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-phys-drain-'))
    tempDirs.push(root)

    let fullFake!: ReturnType<typeof fakeAcpChild>
    let standardFake!: ReturnType<typeof fakeAcpChild>
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(_cwd, _args, scope) {
        const fake = fakeAcpChild()
        if (scope === 'full') fullFake = fake
        else standardFake = fake
        return fake.child
      },
    })

    // 1. Retired Full connection with an in-flight physical request closes promptly when physical reply arrives!
    const fullLease = await pool.acquire({
      cwd: root,
      permissionScope: 'full',
      permissionMode: 'full',
      sessionId: 'sess-full',
    })
    const reqAbort = new AbortController()
    const op = fullLease.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-f', prompt: [] },
      { timeoutMs: undefined, signal: reqAbort.signal },
    )
    await vi.waitFor(() => {
      expect(fullFake.receivedFrames).toHaveLength(1)
    })
    // Abort logical request while physical reply is still outstanding, release lease, and retire Full access!
    reqAbort.abort()
    await expect(op.result).rejects.toThrow(/interrupted/u)
    fullLease.release()
    await pool.retireFullAccess({ sessionId: 'sess-full', cwd: root })
    expect(fullLease.connection.hasPendingPhysicalWork()).toBe(true)
    expect(fullLease.connection.isOpen).toBe(true)

    // Deliver late RPC reply -> physical request completes -> retired Full connection closes immediately!
    fullFake.send({ jsonrpc: '2.0', id: op.requestId, result: { stopReason: 'cancelled' } })
    await op.physicalCompletion
    await vi.waitFor(() => {
      expect(fullLease.connection.isOpen).toBe(false)
    })

    // 2. Standard connection released while physical request is pending arms its 5-minute idle timer once reply arrives!
    const stdLease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-std',
    })
    const stdAbort = new AbortController()
    const stdOp = stdLease.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-s', prompt: [] },
      { timeoutMs: undefined, signal: stdAbort.signal },
    )
    await vi.waitFor(() => {
      expect(standardFake.receivedFrames).toHaveLength(1)
    })
    stdAbort.abort()
    await expect(stdOp.result).rejects.toThrow(/interrupted/u)
    stdLease.release()
    expect(stdLease.connection.hasPendingPhysicalWork()).toBe(true)

    standardFake.send({ jsonrpc: '2.0', id: stdOp.requestId, result: { stopReason: 'cancelled' } })
    await stdOp.physicalCompletion
    expect(stdLease.connection.hasPendingPhysicalWork()).toBe(false)
    expect(stdLease.connection.isOpen).toBe(true)

    await vi.advanceTimersByTimeAsync(AGY_IDLE_CONNECTION_TIMEOUT_MS + 1_000)
    expect(stdLease.connection.isOpen).toBe(false)

    await pool.dispose()
  })
})

describe('AgyAcpConnection multiplexing, backpressure, bounds, and unsent proof', () => {
  it('routes concurrent session/update streams independently for main chat and Side Chat', async () => {
    const fake = fakeAcpChild()
    const connection = new AgyAcpConnection(fake.child, '/tmp/proj', 'standard')

    const mainStream = connection.openSessionStream('sid-main')
    const sideStream = connection.openSessionStream('sid-side')

    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-side',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'from-side' },
        },
      },
    })
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-main',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'from-main' },
        },
      },
    })

    const mainMsg = await mainStream.next(1_000)
    const sideMsg = await sideStream.next(1_000)
    expect(Reflect.get(Reflect.get(mainMsg, 'params') as object, 'sessionId')).toBe('sid-main')
    expect(Reflect.get(Reflect.get(sideMsg, 'params') as object, 'sessionId')).toBe('sid-side')

    mainStream.close()
    sideStream.close()
    await connection.close()
  })

  it('applies stdout pause/resume hysteresis, caps stderr at 16 KiB with redaction, and rejects >16 MiB frames or >64 pending RPCs', async () => {
    const fake = fakeAcpChild()
    const connection = new AgyAcpConnection(fake.child, '/tmp/proj', 'standard')

    // Redacts credentials in stderr and caps at 16 KiB.
    fake.sendStderr(
      `Authorization: Bearer secret-jwt-token-12345\n--api-key=super_secret_key\n${'x'.repeat(AGY_STDERR_LIMIT_BYTES + 4096)}`,
    )
    expect(connection.stderrText).toContain('[redacted]')
    expect(connection.stderrText).not.toContain('secret-jwt-token-12345')
    expect(connection.stderrText).not.toContain('super_secret_key')
    expect(Buffer.byteLength(connection.stderrText, 'utf8')).toBeLessThanOrEqual(
      AGY_STDERR_LIMIT_BYTES,
    )

    // Backpressure hysteresis: push notifications above 4 MiB high-water mark while idle -> pauses stdout; drain below 2 MiB -> resumes!
    const payloadChunk = 'a'.repeat(128 * 1024)
    const countToHighWater = Math.ceil(AGY_QUEUE_HIGH_WATER_BYTES / (128 * 1024)) + 1
    for (let i = 0; i < countToHighWater; i += 1) {
      fake.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-bp', text: payloadChunk },
      })
    }
    await vi.waitFor(() => {
      expect(connection.diagnostics().queuedInboundBytes).toBeGreaterThanOrEqual(
        AGY_QUEUE_HIGH_WATER_BYTES,
      )
      expect(connection.diagnostics().stdoutPaused).toBe(true)
    })

    while (connection.diagnostics().queuedInboundBytes > AGY_QUEUE_LOW_WATER_BYTES) {
      await connection.nextNotification(1_000)
    }
    await vi.waitFor(() => {
      expect(connection.diagnostics().stdoutPaused).toBe(false)
    })
    while (connection.diagnostics().queuedMessages > 0) {
      await connection.nextNotification(1_000)
    }

    // Pending RPC ceiling = 64.
    const ops = Array.from({ length: AGY_PENDING_REQUEST_LIMIT }, (_, i) =>
      connection.requestOwned('ping', { i }, { timeoutMs: undefined }),
    )
    const overflow = connection.requestOwned('ping', { overflow: true }, { timeoutMs: undefined })
    await expect(overflow.result).rejects.toThrow(/pending request budget/u)
    await expect(overflow.physicalCompletion).resolves.toBe('not_sent')

    for (let id = 0; id < ops.length; id += 1) {
      fake.send({ jsonrpc: '2.0', id, result: {} })
    }
    await Promise.all(ops.map((op) => op.result))

    // Single-frame > 16 MiB closes connection deterministically.
    fake.sendRaw(Buffer.alloc(AGY_MAX_FRAME_BYTES + 64, 0x61))
    await vi.waitFor(() => {
      expect(connection.isOpen).toBe(false)
    })
  })

  it('issues agy_root_frame_not_written ONLY when failure occurs strictly before the first byte enters NativeFrameWriter', async () => {
    const fake = fakeAcpChild({ blockWrites: true })
    const connection = new AgyAcpConnection(fake.child, '/tmp/proj', 'standard')
    const settings = makeAgyEffectiveSettings('ask')
    const runId = randomUUID()
    const nativeGeneration = randomUUID()
    const inputSha256 = createHash('sha256').update('prompt-bytes').digest('hex')

    // Occupy writer with an initial frame so the queued prompt has NOT entered NativeFrameWriter yet.
    const blocker = connection.requestOwned('initialize', {}, { timeoutMs: undefined })
    await vi.waitFor(() => {
      expect(fake.receivedFrames).toHaveLength(1)
    })

    const promptAbort = new AbortController()
    const queuedPrompt = connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-1', prompt: [{ type: 'text', text: 'hello' }] },
      { timeoutMs: undefined, signal: promptAbort.signal },
    )

    // Abort BEFORE blocker write finishes -> zero bytes of `session/prompt` entered NativeFrameWriter!
    promptAbort.abort()
    fake.unblockWrite()
    fake.send({ jsonrpc: '2.0', id: blocker.requestId, result: {} })
    await blocker.result

    await expect(queuedPrompt.result).rejects.toThrow(/interrupted/u)
    const notSentPhysical = await queuedPrompt.physicalCompletion
    expect(notSentPhysical).toBe('not_sent')
    expect(fake.receivedFrames.some((f) => f.method === 'session/prompt')).toBe(false)

    const validProof = createAgyRootFrameNotWrittenProof({
      runId,
      bindingGeneration: 1,
      nativeGeneration,
      executorId: connection.executorId,
      nativeSessionId: 'sid-1',
      inputSha256,
      appliedSettings: settings,
      requestId: queuedPrompt.requestId,
      physicalCompletion: notSentPhysical,
    })
    expect(validProof?.boundary).toEqual({
      kind: 'agy_root_frame_not_written',
      requestId: queuedPrompt.requestId,
    })

    // Now let a prompt actually write its first bytes and then close/fail before reply -> MUST NOT issue proof!
    const dispatchedPrompt = connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-1', prompt: [{ type: 'text', text: 'sent' }] },
      { timeoutMs: undefined },
    )
    await vi.waitFor(() => {
      expect(fake.receivedFrames.some((f) => f.method === 'session/prompt')).toBe(true)
    })
    fake.unblockWrite()
    fake.child.kill('SIGKILL')

    await expect(dispatchedPrompt.result).rejects.toThrow(/exited|closed/u)
    const closedPhysical = await dispatchedPrompt.physicalCompletion
    expect(closedPhysical).toBe('connection_closed')
    expect(
      createAgyRootFrameNotWrittenProof({
        runId,
        bindingGeneration: 1,
        nativeGeneration,
        executorId: connection.executorId,
        nativeSessionId: 'sid-1',
        inputSha256,
        appliedSettings: settings,
        requestId: dispatchedPrompt.requestId,
        physicalCompletion: closedPhysical,
      }),
    ).toBeUndefined()
  })

  it('merges child-only loopback NO_PROXY exclusions safely across POSIX and Windows', () => {
    const posix = agyProcessEnvironment({ NO_PROXY: 'corp.internal' }, 'darwin')
    expect(posix.NO_PROXY).toBe('corp.internal,127.0.0.1,localhost')
    expect(posix.no_proxy).toBe('corp.internal,127.0.0.1,localhost')

    const win = agyProcessEnvironment({ no_proxy: '127.0.0.1' }, 'win32')
    expect(win.NO_PROXY).toBe('127.0.0.1,localhost')
    expect('no_proxy' in win).toBe(false)
  })

  it('routes server requests strictly via connection owner registry across Main, Side Chat, and initializing owners', async () => {
    const fake = fakeAcpChild()
    const connection = new AgyAcpConnection(fake.child, '/tmp/proj', 'standard')
    const mainHandled: string[] = []
    const initHandled: string[] = []

    const mainOwner = connection.registerServerRequestOwner({
      ownerId: 'run:main',
      knownSessionId: 'sid-main',
      handler: (msg) => {
        const id = String(Reflect.get(msg, 'id'))
        mainHandled.push(id)
        void connection.respond(id, { ok: 'main' })
        return true
      },
    })
    const initOwner = connection.registerServerRequestOwner({
      ownerId: 'run:side-init',
      knownSessionId: undefined,
      handler: (msg) => {
        const id = String(Reflect.get(msg, 'id'))
        initHandled.push(id)
        void connection.respond(id, { ok: 'init' })
        return true
      },
    })
    expect(connection.totalActiveOrInitializingOwners).toBe(2)

    // 1. Session-tagged request for `sid-main` delivers ONLY to `mainOwner` (initializing owner with `knownSessionId === undefined` never claims it!).
    fake.send({
      jsonrpc: '2.0',
      id: 'req-main-1',
      method: 'session/request_permission',
      params: { sessionId: 'sid-main' },
    })
    // 2. Session-tagged request for unknown `sid-other` is NOT claimed by `initOwner` -> rejected!
    fake.send({
      jsonrpc: '2.0',
      id: 'req-other-2',
      method: 'session/request_permission',
      params: { sessionId: 'sid-other' },
    })
    // 3. Unscoped request without `sessionId` while 2 owners exist -> rejected!
    fake.send({
      jsonrpc: '2.0',
      id: 'req-unscoped-multi',
      method: 'elicitation/create',
      params: {},
    })

    await vi.waitFor(() => {
      expect(fake.receivedFrames.length).toBeGreaterThanOrEqual(3)
    })
    expect(mainHandled).toEqual(['req-main-1'])
    expect(initHandled).toEqual([])
    expect(fake.receivedFrames.find((f) => f.id === 'req-other-2')?.error).toBeDefined()
    expect(fake.receivedFrames.find((f) => f.id === 'req-unscoped-multi')?.error).toBeDefined()

    // 4. Once `mainOwner` disposes (`totalActiveOrInitializingOwners === 1`), unscoped init request delivers to `initOwner`!
    mainOwner.dispose()
    expect(connection.totalActiveOrInitializingOwners).toBe(1)
    fake.send({
      jsonrpc: '2.0',
      id: 'req-unscoped-sole',
      method: 'elicitation/create',
      params: {},
    })
    await vi.waitFor(() => {
      expect(initHandled).toEqual(['req-unscoped-sole'])
    })

    // 5. Updating `knownSessionId` binds `initOwner` to `sid-side`.
    initOwner.updateSessionId('sid-side')
    fake.send({
      jsonrpc: '2.0',
      id: 'req-side-5',
      method: 'session/request_permission',
      params: { sessionId: 'sid-side' },
    })
    await vi.waitFor(() => {
      expect(initHandled).toEqual(['req-unscoped-sole', 'req-side-5'])
    })

    initOwner.dispose()
    await connection.close()
  })

  it('tracks hasExecutor, retains unconfirmedClosingConnections until physical exit, and evicts 0-lease idle connections at the 16-entry pool cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-cap-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: 17 }, async (_, i) => {
        const d = join(root, `proj-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    const childrenByCwd = new Map<string, ReturnType<typeof fakeAcpChild>>()
    let failCloseForCwd: string | undefined
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory: (canonicalCwd) => {
        const stub = fakeAcpChild()
        stub.onRequest((frame) => {
          if (frame.method === 'initialize') {
            stub.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          }
        })
        childrenByCwd.set(canonicalCwd, stub)
        return {
          child: stub.child,
          close: async () => {
            if (failCloseForCwd && canonicalCwd === failCloseForCwd) {
              throw new Error('Simulated hung Full-access child exit timeout')
            }
            stub.child.kill('SIGTERM')
          },
        }
      },
    })

    // Fill 16 distinct directories and release their leases so all 16 are 0-lease idle open connections.
    const executors: string[] = []
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      const lease = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: i === 0 ? 'full' : 'standard',
        permissionMode: i === 0 ? 'full' : 'ask',
        sessionId: `sess-${i}`,
      })
      executors.push(lease.connection.executorId)
      expect(pool.hasExecutor(lease.connection.executorId)).toBe(true)
      lease.release()
    }
    expect(pool.poolSnapshot()).toHaveLength(16)

    // Failing physical close on `retireFullAccess` retains the connection in `unconfirmedClosingConnections` until exit!
    const canon0 = await realpath(dirs[0]!)
    failCloseForCwd = canon0
    await expect(pool.retireFullAccess({ sessionId: 'sess-0', cwd: dirs[0]! })).rejects.toThrow(
      /hung Full-access/u,
    )
    expect(pool.hasExecutor(executors[0]!)).toBe(false)
    expect(pool.unconfirmedClosingCount).toBe(1)

    // Acquiring 17th directory evicts one of the 15 remaining 0-lease idle connections so total stays <= 16!
    failCloseForCwd = undefined
    const lease17 = await pool.acquire({
      cwd: dirs[16]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
    })
    expect(pool.hasExecutor(lease17.connection.executorId)).toBe(true)
    expect(pool.hasExecutor(executors[1]!)).toBe(false)
    expect(pool.poolSnapshot().length + pool.unconfirmedClosingCount).toBe(16)
    lease17.release()

    // Once the hung process physically exits, `unconfirmedClosingCount` drops back to 0!
    childrenByCwd.get(canon0)!.child.kill('SIGKILL')
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(0)
    })

    await pool.dispose()
    expect(pool.hasExecutor(lease17.connection.executorId)).toBe(false)
  })
})
