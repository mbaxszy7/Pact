/* oxlint-disable no-await-in-loop, typescript/no-unsafe-type-assertion -- Protocol stubs model Node child-process stdio streams. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEffectiveExecutionSettings } from '@pact/contracts'

import { OwnedProcessGroup } from '../owned-process-group.js'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS,
  AGY_IDLE_CONNECTION_TIMEOUT_MS,
  AGY_MAX_CONTEXTS,
  AGY_MAX_FRAME_BYTES,
  AGY_PENDING_REQUEST_LIMIT,
  AGY_QUEUE_HIGH_WATER_BYTES,
  AGY_QUEUE_LOW_WATER_BYTES,
  AGY_SHUTDOWN_TIMEOUT_MS,
  AGY_STDERR_LIMIT_BYTES,
  AgyAcpConnection,
  AgyAcpConnectionPool,
  agyProcessEnvironment,
  classifyAgySessionCloseResponse,
  createAgyRootFrameNotWrittenProof,
  formatAndValidateAgyOwnedSpawnArgs,
  isSafeAbsoluteAgyGeminiDir,
  type AgyIngress,
  type AgyPermissionScope,
  type AgyPoolIdleRetirement,
  type AgyRequestPhysicalCompletion,
} from './agy-acp-connection.js'
import { collaborationSourceToolDescription } from './collaboration-prompt.js'
import { FrozenSourceReader } from './frozen-source-reader.js'
import { NATIVE_OWNER_WORKING_BYTES, NativeWorkingMemory } from './native-working-memory.js'

const parserSeam = vi.hoisted(() => ({
  intercept: undefined as
    | ((
        bytes: Buffer,
        signal: AbortSignal,
        observePhysicalCompletion?: (completion: Promise<void>) => void,
      ) => Promise<{ message: unknown; heldBytes: number }>)
    | undefined,
}))
vi.mock('./native-json-parser.js', async (original) => {
  const actual = await original<typeof import('./native-json-parser.js')>()
  return {
    ...actual,
    parseNativeJsonFrame: (
      bytes: Buffer,
      signal: AbortSignal,
      ipcTraffic?: Parameters<typeof actual.parseNativeJsonFrame>[2],
      observePhysicalCompletion?: Parameters<typeof actual.parseNativeJsonFrame>[3],
    ) =>
      parserSeam.intercept
        ? parserSeam.intercept(bytes, signal, observePhysicalCompletion)
        : actual.parseNativeJsonFrame(bytes, signal, ipcTraffic, observePhysicalCompletion),
  }
})

const initialAntigravityGeminiDir = process.env.ANTIGRAVITY_GEMINI_DIR
const tempDirs: string[] = []
beforeEach(() => {
  delete process.env.ANTIGRAVITY_GEMINI_DIR
})
afterEach(async () => {
  parserSeam.intercept = undefined
  vi.useRealTimers()
  delete process.env.ANTIGRAVITY_GEMINI_DIR
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
afterAll(() => {
  if (initialAntigravityGeminiDir === undefined) {
    delete process.env.ANTIGRAVITY_GEMINI_DIR
  } else {
    process.env.ANTIGRAVITY_GEMINI_DIR = initialAntigravityGeminiDir
  }
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
    endStdout() {
      stdout.end()
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
    emitExitOnly(code: number | null = 0, sig: NodeJS.Signals | null = null) {
      if (exitCode !== null || signalCode !== null) return
      exitCode = code
      signalCode = sig
      childRecord.exitCode = code
      childRecord.signalCode = sig
      emitter.emit('exit', code, sig)
    },
    emitCloseOnly(code: number | null = 0, sig: NodeJS.Signals | null = null) {
      if (exitCode === null && signalCode === null) {
        exitCode = code
        signalCode = sig
        childRecord.exitCode = code
        childRecord.signalCode = sig
      }
      blocked = false
      stdin.emit('drain')
      emitter.emit('close', code, sig)
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

describe('session/close positive confirmation and retiring connection state machine', () => {
  it('classifies session/close responses strictly (plain object result vs rpc_error vs protocol_error)', () => {
    expect(classifyAgySessionCloseResponse({ jsonrpc: '2.0', id: 1, result: {} })).toEqual({
      confirmed: true,
      result: {},
    })
    expect(
      classifyAgySessionCloseResponse({ jsonrpc: '2.0', id: 2, result: { closed: true } }),
    ).toEqual({
      confirmed: true,
      result: { closed: true },
    })

    const rpcErr = classifyAgySessionCloseResponse({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32_603, message: 'session close rejected' },
    })
    expect(rpcErr).toMatchObject({
      confirmed: false,
      reason: 'rpc_error',
      detail: 'session close rejected',
    })

    expect(
      classifyAgySessionCloseResponse({
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32_000 },
        result: {},
      }),
    ).toMatchObject({ confirmed: false, reason: 'protocol_error' })
    expect(classifyAgySessionCloseResponse({ jsonrpc: '2.0', id: 5, error: null })).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })
    expect(
      classifyAgySessionCloseResponse({ jsonrpc: '2.0', id: 5, error: 'not-an-object' }),
    ).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })

    for (const malformed of [
      { jsonrpc: '2.0', id: 6 },
      { jsonrpc: '2.0', id: 7, result: null },
      { jsonrpc: '2.0', id: 8, result: true },
      { jsonrpc: '2.0', id: 9, result: [] },
      { jsonrpc: '2.0', id: 10, result: 'ok' },
      null,
      undefined,
      [],
      'not-an-object',
    ]) {
      expect(classifyAgySessionCloseResponse(malformed)).toMatchObject({
        confirmed: false,
        reason: 'protocol_error',
      })
    }
  })

  it('reuses connection on confirmed { result: {} } and immediately retires on rpc_error or missing-result malformed reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-close-modes-'))
    tempDirs.push(root)
    let closeBehavior: 'ok' | 'rpc_error' | 'malformed' = 'ok'
    let spawnCount = 0

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        fake.onRequest((frame) => {
          if (frame.method === 'session/close') {
            if (closeBehavior === 'ok') {
              fake.send({ jsonrpc: '2.0', id: frame.id, result: {} })
            } else if (closeBehavior === 'rpc_error') {
              fake.send({
                jsonrpc: '2.0',
                id: frame.id,
                error: { code: -32_603, message: 'close failed' },
              })
            } else {
              fake.send({ jsonrpc: '2.0', id: frame.id })
            }
          }
        })
        return fake.child
      },
    })

    // 1. Confirmed `{ result: {} }` keeps connection active and reusable.
    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-ok-1',
    })
    const okRes = await lease1.closeSession('sid-ok')
    expect(okRes).toEqual({ confirmed: true, result: {} })
    expect(lease1.connection.isOpen).toBe(true)
    expect(pool.retiringCount).toBe(0)
    expect(pool.unconfirmedClosedSessionCount).toBe(0)

    const leaseReuse = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-ok-2',
    })
    expect(leaseReuse.connection).toBe(lease1.connection)
    expect(spawnCount).toBe(1)
    lease1.release()
    leaseReuse.release()

    // 2. JSON-RPC `error` immediately retires the entry; sibling stays undisturbed while new acquire spawns fresh connection.
    closeBehavior = 'rpc_error'
    const errLease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-err-1',
    })
    const errSibling = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-err-sibling',
    })
    const retiringConn1 = errLease1.connection
    expect(errSibling.connection).toBe(retiringConn1)

    const errRes = await errLease1.closeSession('sid-rpc-err')
    expect(errRes).toMatchObject({
      confirmed: false,
      reason: 'rpc_error',
      detail: 'close failed',
    })
    expect(pool.retiringCount).toBe(1)
    expect(pool.hasUnconfirmedClosedSession('sid-rpc-err')).toBe(true)
    expect(retiringConn1.isOpen).toBe(true)

    const freshAfterErr = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-fresh-after-err',
    })
    expect(freshAfterErr.connection).not.toBe(retiringConn1)
    expect(spawnCount).toBe(2)

    errLease1.release()
    expect(retiringConn1.isOpen).toBe(true)
    errSibling.release()
    await vi.waitFor(() => {
      expect(retiringConn1.isOpen).toBe(false)
      expect(pool.retiringCount).toBe(0)
    })

    // 3. Missing-result malformed reply `{ jsonrpc: '2.0', id }` immediately retires the entry.
    closeBehavior = 'malformed'
    const malConn = freshAfterErr.connection
    const malRes = await freshAfterErr.closeSession('sid-malformed')
    expect(malRes).toMatchObject({ confirmed: false, reason: 'protocol_error' })
    expect(pool.retiringCount).toBe(1)
    expect(pool.hasUnconfirmedClosedSession('sid-malformed')).toBe(true)

    const freshAfterMal = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-fresh-after-mal',
    })
    expect(freshAfterMal.connection).not.toBe(malConn)
    expect(spawnCount).toBe(3)

    freshAfterErr.release()
    await vi.waitFor(() => {
      expect(malConn.isOpen).toBe(false)
      expect(pool.retiringCount).toBe(0)
    })

    // 4. Transport closed mid-session/close returns `transport_closed` without throwing.
    const crashConn = freshAfterMal.connection
    const crashClosePromise = freshAfterMal.closeSession('sid-crash', { timeoutMs: 5_000 })
    await crashConn.close(new Error('Simulated transport drop'))
    const crashRes = await crashClosePromise
    expect(crashRes).toMatchObject({ confirmed: false, reason: 'transport_closed' })
    freshAfterMal.release()

    await pool.dispose()
  })

  it('stops allocating on hung session/close timeout, drains sibling lease and real physical work, then force-closes ignoring unanswered close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-hung-close-'))
    tempDirs.push(root)
    const fakes: Array<ReturnType<typeof fakeAcpChild>> = []

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const fake = fakeAcpChild()
        fakes.push(fake)
        return fake.child
      },
    })

    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-1',
    })
    const siblingLease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-sibling',
    })
    const conn1 = lease1.connection
    const fake1 = fakes[0]!
    expect(siblingLease.connection).toBe(conn1)

    // Never reply to `session/close` -> times out cleanly with `{ confirmed: false, reason: 'timeout' }`.
    const closeResult = await lease1.closeSession('sid-hung-forever', { timeoutMs: 30 })
    expect(closeResult).toMatchObject({ confirmed: false, reason: 'timeout' })
    expect(conn1.hasPendingPhysicalWork()).toBe(true)
    expect(conn1.hasActiveWorkExcludingUnconfirmedCloses()).toBe(false)
    expect(pool.retiringCount).toBe(1)
    expect(pool.activeLeaseCount).toBe(2)

    // New acquire MUST NOT reuse the retiring connection; it spawns a fresh connection immediately.
    const freshLease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-fresh',
    })
    expect(freshLease.connection).not.toBe(conn1)
    expect(fakes).toHaveLength(2)

    // Sibling lease on retiring connection continues unaffected, including an in-flight physical request.
    const siblingReq = siblingLease.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-sibling', prompt: [] },
      { timeoutMs: undefined },
    )
    await vi.waitFor(() => {
      expect(fake1.receivedFrames.some((f) => f.method === 'session/prompt')).toBe(true)
    })
    expect(conn1.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)

    // Release lease1 and abort sibling request logically while physical reply is still pending.
    lease1.release()
    expect(conn1.isOpen).toBe(true)

    const siblingAbort = new AbortController()
    const siblingBgOp = siblingLease.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-sibling-bg', prompt: [] },
      { timeoutMs: undefined, signal: siblingAbort.signal },
    )
    await vi.waitFor(() => {
      expect(
        fake1.receivedFrames.filter((f) => f.method === 'session/prompt').length,
      ).toBeGreaterThanOrEqual(2)
    })
    // Complete first sibling request normally.
    fake1.send({ jsonrpc: '2.0', id: siblingReq.requestId, result: { stopReason: 'end_turn' } })
    await expect(siblingReq.result).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })

    // Abort second request logically and release siblingLease; retiring connection waits for second request's physical reply!
    siblingAbort.abort()
    await expect(siblingBgOp.result).rejects.toThrow(/interrupted/u)
    siblingLease.release()
    expect(conn1.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)
    expect(conn1.isOpen).toBe(true)

    // Deliver physical reply for second request while `session/close` STILL NEVER replies -> immediate bounded shutdown!
    fake1.send({ jsonrpc: '2.0', id: siblingBgOp.requestId, result: { stopReason: 'cancelled' } })
    await siblingBgOp.physicalCompletion
    await vi.waitFor(() => {
      expect(conn1.isOpen).toBe(false)
      expect(pool.retiringCount).toBe(0)
    })

    // Fresh connection remains open and healthy.
    expect(freshLease.connection.isOpen).toBe(true)
    freshLease.release()
    await pool.dispose()
  })

  it('holds pool capacity slots for retiring connections until confirmed process exit and wakes capacity waiters upon exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-retire-cap-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 1 }, async (_, i) => {
        const d = join(root, `dir-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    const exitGates: Array<() => void> = []
    let spawnCount = 0
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        const exitGate = Promise.withResolvers<void>()
        exitGates.push(exitGate.resolve)
        return {
          child: fake.child,
          close: async () => {
            await exitGate.promise
            fake.child.kill('SIGTERM')
          },
        }
      },
    })

    // Fill all 16 slots with retiring connections whose physical process exits are gated on `exitGates`.
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      const lease = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-retire-${i}`,
      })
      // Compatibility interface `recordUnconfirmedSessionClose` also retires immediately.
      lease.recordUnconfirmedSessionClose(`sid-retire-${i}`)
      lease.release()
    }
    expect(spawnCount).toBe(AGY_MAX_CONTEXTS * 2)
    expect(pool.retiringCount).toBe(AGY_MAX_CONTEXTS * 2)
    expect(pool.activeLeaseCount).toBe(0)

    // 17th acquire MUST wait because all 16 slots are occupied by retiring connections whose processes have not exited!
    let settled17 = false
    const acquire17 = pool
      .acquire({
        cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-17',
      })
      .then((lease) => {
        settled17 = true
        return lease
      })

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(settled17).toBe(false)
    expect(spawnCount).toBe(AGY_MAX_CONTEXTS * 2)

    // Confirm physical exit of one retiring child -> frees 1 slot and immediately wakes waiter!
    exitGates[0]!()
    const lease17 = await acquire17
    expect(settled17).toBe(true)
    expect(spawnCount).toBe(AGY_MAX_CONTEXTS * 2 + 1)
    expect(pool.poolSnapshot().length + pool.unconfirmedClosingCount).toBe(AGY_MAX_CONTEXTS * 2)
    lease17.release()

    // Release all remaining exit gates and confirm pool.dispose() cleans up all retiring entries cleanly.
    for (const releaseGate of exitGates.slice(1)) releaseGate()
    await pool.dispose()
    expect(pool.retiringCount).toBe(0)
    expect(pool.poolSnapshot()).toHaveLength(0)
  })

  it('cleans up retiring entries with active leases and rejects capacity waiters on pool.dispose()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-retire-dispose-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 1 }, async (_, i) => {
        const d = join(root, `dispose-dir-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    const exitGates: Array<() => void> = []
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const fake = fakeAcpChild()
        const exitGate = Promise.withResolvers<void>()
        exitGates.push(exitGate.resolve)
        return {
          child: fake.child,
          close: async () => {
            await exitGate.promise
            fake.child.kill('SIGTERM')
          },
        }
      },
    })

    // Retire 15 connections whose close waits on exitGates, and keep 1 retiring connection with an active lease.
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2 - 1; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-disp-${i}`,
      })
      l.recordUnconfirmedSessionClose(`sid-disp-${i}`)
      l.release()
    }
    const activeLease = await pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2 - 1]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-active-retire',
    })
    const retiringConn = activeLease.connection
    activeLease.recordUnconfirmedSessionClose('sid-active-retire')
    expect(pool.retiringCount).toBe(AGY_MAX_CONTEXTS * 2)
    expect(retiringConn.isOpen).toBe(true)

    // Park a 17th acquire on capacityWaiters, then dispose the pool -> waiter rejects immediately and all retiring entries close!
    const parkedAcquire = pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-parked',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const disposePromise = pool.dispose()
    await expect(parkedAcquire).rejects.toThrow(/shutting down/u)
    for (const releaseGate of exitGates) releaseGate()
    await disposePromise
    expect(retiringConn.isOpen).toBe(false)
    expect(pool.retiringCount).toBe(0)
    expect(pool.unconfirmedClosedSessionCount).toBe(0)
  })

  it('enforces the 16-slot ceiling on same-key reacquire with a retained failed-generation lease, gates owned-group release separately from root close, and settles physicalCompletion after late verified release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-samekey-group-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 }, async (_, i) => {
        const d = join(root, `slot-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )
    const canon0 = await realpath(dirs[0]!)

    const otherExitGates: Array<() => void> = []
    let spawnCount = 0
    let gen0Fake!: ReturnType<typeof fakeAcpChild>
    let gen0GroupReleased = false
    const gen0GroupReleaseGate = Promise.withResolvers<void>()
    let gen0Spawned = false

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        spawnCount += 1
        const fake = fakeAcpChild()
        if (canonicalCwd === canon0 && !gen0Spawned) {
          gen0Spawned = true
          gen0Fake = fake
          return {
            child: fake.child,
            close: async () => {
              throw new Error('Simulated OwnedProcessGroup close timeout')
            },
            isReleased: () => gen0GroupReleased,
            whenReleased: () => gen0GroupReleaseGate.promise,
          }
        }
        const gate = Promise.withResolvers<void>()
        otherExitGates.push(gate.resolve)
        return {
          child: fake.child,
          close: async () => {
            await gate.promise
            fake.child.kill('SIGTERM')
          },
        }
      },
    })

    // Occupy slot 0 with a live lease and slots 1..15 with retiring connections gated on exit.
    const lease0 = await pool.acquire({
      cwd: dirs[0]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-slot-0',
    })
    const conn0 = lease0.connection
    for (let i = 1; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-slot-${i}`,
      })
      l.recordUnconfirmedSessionClose(`sid-slot-${i}`)
      l.release()
    }
    expect(spawnCount).toBe(16)
    expect(pool.occupiedProcessSlotCount).toBe(16)

    // Dispatch a physical request on conn0 whose reply never arrives, then fail conn0's close while lease0 is STILL retained!
    const dispatchedOp = conn0.requestOwned(
      'session/prompt',
      { sessionId: 'sid-slot-0', prompt: [] },
      { timeoutMs: undefined },
    )
    await vi.waitFor(() => {
      expect(gen0Fake.receivedFrames).toHaveLength(1)
    })
    let physicalResult: string | undefined
    void dispatchedOp.physicalCompletion.then((res) => {
      physicalResult = res
      return undefined
    })

    await expect(conn0.close(new Error('Simulated transport drop'))).rejects.toThrow(
      /OwnedProcessGroup close timeout/u,
    )
    await expect(dispatchedOp.result).rejects.toThrow(/Simulated transport drop/u)
    // Cached close rejection is preserved on repeated close() calls.
    await expect(conn0.close()).rejects.toThrow(/OwnedProcessGroup close timeout/u)

    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(1)
    })
    expect(pool.occupiedProcessSlotCount).toBe(16)
    expect(pool.activeLeaseCount).toBe(1)

    // Reacquiring the EXACT SAME key while lease0 is held MUST NOT bypass the 16-slot ceiling!
    let reacquired = false
    const reacquirePromise = pool
      .acquire({
        cwd: dirs[0]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-slot-0-replacement',
      })
      .then((lease) => {
        reacquired = true
        return lease
      })

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reacquired).toBe(false)
    expect(spawnCount).toBe(16)
    expect(pool.occupiedProcessSlotCount).toBe(16)
    expect(physicalResult).toBeUndefined()

    // Emit root child exit + close while owned group is STILL alive -> slot MUST stay charged and physicalCompletion MUST stay pending!
    gen0Fake.emitExitOnly(0, 'SIGTERM')
    gen0Fake.emitCloseOnly(0, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(conn0.hasProcessClosed).toBe(true)
    expect(conn0.isPhysicallyReleased).toBe(false)
    expect(pool.unconfirmedClosingCount).toBe(1)
    expect(pool.occupiedProcessSlotCount).toBe(16)
    expect(reacquired).toBe(false)
    expect(spawnCount).toBe(16)
    expect(physicalResult).toBeUndefined()

    // Now confirm owned-group release -> settles physicalCompletion, clears quarantine, frees slot, and wakes same-key reacquire!
    gen0GroupReleased = true
    gen0GroupReleaseGate.resolve()

    await expect(dispatchedOp.physicalCompletion).resolves.toBe('connection_closed')
    expect(physicalResult).toBe('connection_closed')
    const replacementLease = await reacquirePromise
    expect(reacquired).toBe(true)
    expect(replacementLease.connection).not.toBe(conn0)
    expect(spawnCount).toBe(17)
    expect(pool.unconfirmedClosingCount).toBe(0)
    expect(pool.occupiedProcessSlotCount).toBe(16)

    // Late closeSession on the old lease still marks unconfirmed session cleanly without reviving the old entry.
    const lateClose = await lease0.closeSession('sid-late-after-clear')
    expect(lateClose).toMatchObject({ confirmed: false, reason: 'transport_closed' })
    expect(pool.hasUnconfirmedClosedSession('sid-late-after-clear')).toBe(true)

    lease0.release()
    replacementLease.release()
    for (const releaseGate of otherExitGates) releaseGate()
    await pool.dispose()
    expect(pool.occupiedProcessSlotCount).toBe(0)
    expect(pool.retiringCount).toBe(0)
  })

  it('routes non-open entries whose root exited before close through managed shutdown rather than releasing their slot early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-nonopen-group-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 1 }, async (_, i) => {
        const d = join(root, `nonopen-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    const exitGates: Array<() => void> = []
    let targetFake!: ReturnType<typeof fakeAcpChild>
    let targetGroupReleased = false
    const targetGroupGate = Promise.withResolvers<void>()
    let targetCloseCalled = false
    let spawnCount = 0

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const idx = spawnCount
        spawnCount += 1
        const fake = fakeAcpChild()
        if (idx === 0) {
          targetFake = fake
          return {
            child: fake.child,
            close: async () => {
              targetCloseCalled = true
              await targetGroupGate.promise
              fake.emitCloseOnly(0, null)
            },
            isReleased: () => targetGroupReleased,
          }
        }
        const gate = Promise.withResolvers<void>()
        exitGates.push(gate.resolve)
        return {
          child: fake.child,
          close: async () => {
            await gate.promise
            fake.child.kill('SIGTERM')
          },
        }
      },
    })

    const targetLease = await pool.acquire({
      cwd: dirs[0]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-target',
    })
    for (let i = 1; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-other-${i}`,
      })
      l.recordUnconfirmedSessionClose(`sid-other-${i}`)
      l.release()
    }

    // Root exits (making `isOpen === false`) BEFORE `close` emits and BEFORE owned group releases!
    targetFake.emitExitOnly(0, null)
    expect(targetLease.connection.isOpen).toBe(false)
    targetLease.recordUnconfirmedSessionClose('sid-target')
    targetLease.release()

    // Entry MUST NOT be dropped early; managed close must run (after bounded exit drain while stdout stays open) and slot must remain occupied until group releases!
    expect(pool.occupiedProcessSlotCount).toBe(16)
    await vi.waitFor(
      () => {
        expect(targetCloseCalled).toBe(true)
      },
      { timeout: 2_500 },
    )
    expect(pool.occupiedProcessSlotCount).toBe(16)

    let acquired17 = false
    const acquire17 = pool
      .acquire({
        cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-17',
      })
      .then((lease) => {
        acquired17 = true
        return lease
      })

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(acquired17).toBe(false)
    expect(spawnCount).toBe(16)

    targetGroupReleased = true
    targetGroupGate.resolve()
    const lease17 = await acquire17
    expect(acquired17).toBe(true)
    expect(spawnCount).toBe(17)
    lease17.release()

    for (const releaseGate of exitGates) releaseGate()
    await pool.dispose()
  })

  it('expires session/close on an absolute deadline during sibling permissionWait for both closeSession and legacy recordUnconfirmedSessionClose, preserving sibling work and closing once drained', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-permwait-close-'))
    tempDirs.push(root)
    const dirA = join(root, 'path-a')
    const dirB = join(root, 'path-b')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })

    const fakesByKey = new Map<string, Array<ReturnType<typeof fakeAcpChild>>>()
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        const list = fakesByKey.get(canonicalCwd) ?? []
        list.push(fake)
        fakesByKey.set(canonicalCwd, list)
        return fake.child
      },
    })
    const canonA = await realpath(dirA)
    const canonB = await realpath(dirB)

    // --- Path A: lease.closeSession during active sibling permissionWait ---
    const leaseA1 = await pool.acquire({
      cwd: dirA,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-a1',
    })
    const siblingA = await pool.acquire({
      cwd: dirA,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-a-sibling',
    })
    const connA = leaseA1.connection
    const fakeA = fakesByKey.get(canonA)![0]!
    const endPermWaitA = connA.beginPermissionWait()

    // Sibling request with 100ms timeout stays paused while permissionWait is held.
    const siblingPromptA = siblingA.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-a-sibling', prompt: [] },
      { timeoutMs: 100 },
    )
    const closePromiseA = leaseA1.closeSession('sid-a-close', { timeoutMs: 50 })

    // Advance 200ms: closeSession MUST expire at 50ms despite permissionWait, while siblingPromptA stays alive!
    await vi.advanceTimersByTimeAsync(200)
    const closeResultA = await closePromiseA
    expect(closeResultA).toMatchObject({ confirmed: false, reason: 'timeout' })
    expect(pool.retiringCount).toBe(1)
    expect(connA.isOpen).toBe(true)
    expect(connA.hasPendingPhysicalWork()).toBe(true)
    expect(connA.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)

    // Fresh acquire on dirA spawns a new connection immediately.
    const freshA = await pool.acquire({
      cwd: dirA,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-a-fresh',
    })
    expect(freshA.connection).not.toBe(connA)
    freshA.release()

    // Release leaseA1 -> sibling work stays undisturbed until sibling finishes and releases!
    leaseA1.release()
    expect(connA.isOpen).toBe(true)
    endPermWaitA()
    fakeA.send({
      jsonrpc: '2.0',
      id: siblingPromptA.requestId,
      result: { stopReason: 'end_turn' },
    })
    await expect(siblingPromptA.result).resolves.toMatchObject({
      result: { stopReason: 'end_turn' },
    })
    siblingA.release()

    await vi.waitFor(() => {
      expect(connA.isOpen).toBe(false)
      expect(pool.retiringCount).toBe(0)
    })

    // --- Path B: legacy raw request('session/close') + lease.recordUnconfirmedSessionClose during permissionWait ---
    const leaseB1 = await pool.acquire({
      cwd: dirB,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-b1',
    })
    const siblingB = await pool.acquire({
      cwd: dirB,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-b-sibling',
    })
    const connB = leaseB1.connection
    const fakeB = fakesByKey.get(canonB)![0]!
    const endPermWaitB = connB.beginPermissionWait()

    const siblingPromptB = siblingB.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-b-sibling', prompt: [] },
      { timeoutMs: 100 },
    )
    const rawClosePromiseB = connB
      .request('session/close', { sessionId: 'sid-b-legacy-close' }, { timeoutMs: 50 })
      .then(
        () => 'ok' as const,
        (err: unknown) => err,
      )

    await vi.advanceTimersByTimeAsync(200)
    const rawCloseOutcome = await rawClosePromiseB
    expect(rawCloseOutcome).toBeInstanceOf(Error)
    expect(String(rawCloseOutcome)).toMatch(/did not answer session\/close/u)

    leaseB1.recordUnconfirmedSessionClose('sid-b-legacy-close')
    expect(pool.retiringCount).toBe(1)
    expect(connB.isOpen).toBe(true)
    expect(connB.hasPendingPhysicalWork()).toBe(true)
    expect(connB.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)

    leaseB1.release()
    expect(connB.isOpen).toBe(true)

    // Complete sibling prompt and release sibling lease -> legacy unanswered session/close MUST NOT block shutdown!
    endPermWaitB()
    fakeB.send({
      jsonrpc: '2.0',
      id: siblingPromptB.requestId,
      result: { stopReason: 'end_turn' },
    })
    await expect(siblingPromptB.result).resolves.toMatchObject({
      result: { stopReason: 'end_turn' },
    })
    siblingB.release()

    await vi.waitFor(() => {
      expect(connB.isOpen).toBe(false)
      expect(pool.retiringCount).toBe(0)
    })

    await pool.dispose()
  })

  it('rejects capacity waiters immediately, cleans all logical registrations despite a rejecting close in dispose(), surfaces the failure, and cleans up the unconfirmed physical owner on late release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-dispose-reject-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 1 }, async (_, i) => {
        const d = join(root, `disp-err-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    const exitGates: Array<() => void> = []
    let failingFake!: ReturnType<typeof fakeAcpChild>
    let failingGroupReleased = false
    const failingGroupGate = Promise.withResolvers<void>()
    let spawnIndex = 0

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const idx = spawnIndex
        spawnIndex += 1
        const fake = fakeAcpChild()
        if (idx === AGY_MAX_CONTEXTS * 2 - 2) {
          failingFake = fake
          return {
            child: fake.child,
            close: async () => {
              throw new Error('Simulated rejecting close during dispose')
            },
            isReleased: () => failingGroupReleased,
            whenReleased: () => failingGroupGate.promise,
          }
        }
        const gate = Promise.withResolvers<void>()
        exitGates.push(gate.resolve)
        return {
          child: fake.child,
          close: async () => {
            await gate.promise
            fake.child.kill('SIGTERM')
          },
        }
      },
    })

    // Fill 14 retiring closing slots, 1 rejecting-close leased slot, and 1 retiring leased slot (total 16).
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2 - 2; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-d-${i}`,
      })
      l.recordUnconfirmedSessionClose(`sid-d-${i}`)
      l.release()
    }
    const failingLease = await pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2 - 2]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-failing-close',
    })
    const failingOp = failingLease.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-failing-close', prompt: [] },
      { timeoutMs: undefined },
    )
    await vi.waitFor(() => {
      expect(failingFake.receivedFrames).toHaveLength(1)
    })

    const retiringLeased = await pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2 - 1]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-retiring-leased',
    })
    retiringLeased.recordUnconfirmedSessionClose('sid-retiring-leased')

    // Park a 17th acquire on capacityWaiters.
    const parkedAcquire = pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-parked-dispose',
    })
    await new Promise((resolve) => setTimeout(resolve, 25))

    // Dispose: parked waiter MUST reject immediately, all other closes MUST still join,
    // logical registrations MUST clear despite rejection, and error MUST surface!
    const disposePromise = pool.dispose()
    await expect(parkedAcquire).rejects.toThrow(/shutting down/u)

    for (const releaseGate of exitGates) releaseGate()
    await expect(disposePromise).rejects.toThrow(/Simulated rejecting close during dispose/u)
    await expect(failingOp.result).rejects.toThrow(/Antigravity pool disposed/u)

    // Logical state is completely cleared even while the old retiring lease hasn't been released yet.
    expect(pool.retiringCount).toBe(0)
    expect(pool.poolSnapshot()).toHaveLength(0)
    expect(pool.activeLeaseCount).toBe(0)
    expect(pool.unconfirmedClosedSessionCount).toBe(0)
    expect(retiringLeased.connection.isOpen).toBe(false)

    // Releasing the old leases post-dispose must not leave any stale logical registrations behind.
    retiringLeased.release()
    failingLease.release()
    expect(pool.retiringCount).toBe(0)
    expect(pool.poolSnapshot()).toHaveLength(0)

    // Only the independently tracked unconfirmed physical owner remains until verified late release!
    expect(pool.unconfirmedClosingCount).toBe(1)
    expect(pool.occupiedProcessSlotCount).toBe(1)

    failingFake.emitExitOnly(0, 'SIGKILL')
    failingFake.emitCloseOnly(0, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pool.unconfirmedClosingCount).toBe(1)

    failingGroupReleased = true
    failingGroupGate.resolve()
    await expect(failingOp.physicalCompletion).resolves.toBe('connection_closed')
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(0)
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
  })

  it('releases all reserved pool slots after pre-spawn config or env validation throws across 16 distinct keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-prespawn-leak-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 1 }, async (_, i) => {
        const d = join(root, `pre-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    // 1. Invalid `relativeAppDataDir` throws inside `buildAgySpawnArgs` on 16 distinct keys -> 0 slots leaked.
    const invalidDirPool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      relativeAppDataDir: '../escape',
      processFactory() {
        return fakeAcpChild().child
      },
    })
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      await expect(
        invalidDirPool.acquire({
          cwd: dirs[i]!,
          permissionScope: 'standard',
          permissionMode: 'ask',
          sessionId: `sess-bad-dir-${i}`,
        }),
      ).rejects.toThrow(/safe relative directory/u)
      expect(invalidDirPool.occupiedProcessSlotCount).toBe(0)
      expect(invalidDirPool.activeLeaseCount).toBe(0)
      expect(invalidDirPool.poolSnapshot()).toHaveLength(0)
    }
    await invalidDirPool.dispose()

    // 2. Oversized `NO_PROXY` throws inside `agyProcessEnvironment` on 16 distinct keys -> 0 slots leaked,
    //    then restoring valid env allows immediate acquire on key #17!
    const priorNoProxy = process.env.NO_PROXY
    const priorLowerNoProxy = process.env.no_proxy
    let spawnCount = 0
    const envPool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        return fakeAcpChild().child
      },
    })
    try {
      process.env.NO_PROXY = 'a'.repeat(9000)
      for (let i = 0; i < AGY_MAX_CONTEXTS * 2; i += 1) {
        await expect(
          envPool.acquire({
            cwd: dirs[i]!,
            permissionScope: 'standard',
            permissionMode: 'ask',
            sessionId: `sess-bad-env-${i}`,
          }),
        ).rejects.toThrow(/exceed 8 KiB/u)
        expect(envPool.occupiedProcessSlotCount).toBe(0)
        expect(envPool.activeLeaseCount).toBe(0)
        expect(envPool.poolSnapshot()).toHaveLength(0)
      }
      expect(spawnCount).toBe(0)

      if (priorNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = priorNoProxy
      if (priorLowerNoProxy === undefined) delete process.env.no_proxy
      else process.env.no_proxy = priorLowerNoProxy

      const healthyLease = await envPool.acquire({
        cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-healthy-17',
      })
      expect(spawnCount).toBe(1)
      expect(envPool.occupiedProcessSlotCount).toBe(1)
      healthyLease.release()
    } finally {
      if (priorNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = priorNoProxy
      if (priorLowerNoProxy === undefined) delete process.env.no_proxy
      else process.env.no_proxy = priorLowerNoProxy
      await envPool.dispose()
    }
  })

  it('enforces one shared absolute deadline across failed evictions with no late spawn and bounds processClosed waits', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-evict-deadline-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: AGY_MAX_CONTEXTS * 2 + 2 }, async (_, i) => {
        const d = join(root, `evict-${i}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    let spawnCount = 0
    const fakes: Array<ReturnType<typeof fakeAcpChild>> = []
    let evictionAttempts = 0
    let thirdEvictionSettled = false
    let fastDispose = false
    const firstEvictionStarted = Promise.withResolvers<void>()
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        fakes.push(fake)
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            if (fastDispose) {
              fake.child.kill('SIGTERM')
              return
            }
            const attempt = ++evictionAttempts
            if (attempt === 1) firstEvictionStarted.resolve()
            await new Promise<void>((resolve) => setTimeout(resolve, 6_000))
            if (attempt === 3) {
              thirdEvictionSettled = true
              fake.child.kill('SIGTERM')
              return
            }
            throw new Error(`Simulated slow failed eviction #${attempt}`)
          },
        }
      },
    })

    // Fill all 16 slots with 0-lease idle connections.
    for (let i = 0; i < AGY_MAX_CONTEXTS * 2; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-ev-${i}`,
      })
      l.release()
    }
    expect(spawnCount).toBe(16)
    expect(pool.occupiedProcessSlotCount).toBe(16)

    // 17th acquire spans multiple 6s evictions under one 15s absolute deadline:
    // Eviction #1 fails at 6s, #2 fails at 12s, #3 would finish at 18s -> MUST reject at 15s with no late spawn!
    const acquire17 = pool.acquire({
      cwd: dirs[AGY_MAX_CONTEXTS * 2]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-ev-17',
    })
    const outcome17 = acquire17.then(
      () => 'fulfilled' as const,
      (err: unknown) => err,
    )

    await firstEvictionStarted.promise
    await vi.advanceTimersByTimeAsync(6_000)
    expect(evictionAttempts).toBe(2)
    expect(spawnCount).toBe(16)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(evictionAttempts).toBe(3)
    expect(spawnCount).toBe(16)

    await vi.advanceTimersByTimeAsync(AGY_CONTROL_RPC_TIMEOUT_MS - 12_000 + 1)
    const err17 = await outcome17
    expect(err17).toBeInstanceOf(Error)
    expect(String(err17)).toMatch(/16-directory capacity/u)
    expect(spawnCount).toBe(16)

    // Even when eviction #3 finishes at 18s and frees a slot, no late spawn occurs for the expired acquire!
    await vi.advanceTimersByTimeAsync(4_000)
    expect(thirdEvictionSettled).toBe(true)
    expect(spawnCount).toBe(16)
    expect(pool.activeLeaseCount).toBe(0)

    // Also verify a bare child whose root exits while an inherited pipe holds stdio open bounds `close()`
    // rather than hanging forever, retains quarantine, and settles once `close` arrives late.
    const pipeFake = fakeAcpChild()
    pipeFake.child.kill = () => {
      pipeFake.emitExitOnly(0, 'SIGTERM')
      return true
    }
    const pipeConn = new AgyAcpConnection(pipeFake.child, root, 'standard')
    const pipeDispatched = Promise.withResolvers<void>()
    const pipeOp = pipeConn.requestOwned(
      'ping',
      {},
      { timeoutMs: undefined, onDispatch: () => pipeDispatched.resolve() },
    )
    const pipeResult = pipeOp.result.catch((err: unknown) => err)
    await pipeDispatched.promise
    let pipePhysical: string | undefined
    void pipeOp.physicalCompletion.then((res) => {
      pipePhysical = res
      return undefined
    })

    const closeTask = pipeConn.close(new Error('close with open inherited pipe')).then(
      () => 'closed' as const,
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(AGY_SHUTDOWN_TIMEOUT_MS + 1_001)
    const pipeCloseErr = await closeTask
    expect(pipeCloseErr).toBeInstanceOf(Error)
    expect(String(pipeCloseErr)).toMatch(/stdio did not close before its deadline/u)
    expect(await pipeResult).toBeInstanceOf(Error)
    expect(pipeConn.isPhysicallyReleased).toBe(false)
    expect(pipePhysical).toBeUndefined()

    // Once the inherited pipe closes late, physicalCompletion settles cleanly.
    pipeFake.emitCloseOnly(0, 'SIGTERM')
    await expect(pipeOp.physicalCompletion).resolves.toBe('connection_closed')
    await expect(pipeConn.whenPhysicallyReleased()).resolves.toBeUndefined()
    expect(pipeConn.isPhysicallyReleased).toBe(true)

    // Clean up pool without triggering hanging timers.
    fastDispose = true
    vi.useRealTimers()
    for (const fake of fakes) fake.child.kill('SIGKILL')
    await pool.dispose().catch(() => undefined)
  })

  it('ends lease reusability immediately on signal-only root exit (exitCode === null, signalCode === SIGKILL) while keeping the physical slot until group release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-sigkill-root-'))
    tempDirs.push(root)

    let firstFake!: ReturnType<typeof fakeAcpChild>
    let firstGroupReleased = false
    const firstCloseGate = Promise.withResolvers<void>()
    let spawnCount = 0

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        if (spawnCount === 1) {
          firstFake = fake
          return {
            child: fake.child,
            isOwnedGroup: true,
            close: async () => {
              await firstCloseGate.promise
              fake.emitCloseOnly(null, 'SIGKILL')
            },
            isReleased: () => firstGroupReleased,
          }
        }
        return fake.child
      },
    })

    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-sigkill-1',
    })
    const conn1 = lease1.connection
    expect(conn1.isOpen).toBe(true)

    // Root is killed by SIGKILL: exitCode stays null, signalCode is 'SIGKILL', and stdio 'close' has NOT fired yet.
    firstFake.emitExitOnly(null, 'SIGKILL')
    expect(firstFake.child.exitCode).toBeNull()
    expect(firstFake.child.signalCode).toBe('SIGKILL')
    expect(conn1.isOpen).toBe(false)
    expect(conn1.isProcessAlive).toBe(false)
    expect(conn1.hasProcessClosed).toBe(false)
    expect(pool.hasExecutor(conn1.executorId)).toBe(false)

    // Acquiring the same key MUST NOT reuse the dead generation; it spawns a fresh connection while slot 1 stays charged!
    const lease2 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-sigkill-2',
    })
    expect(lease2.connection).not.toBe(conn1)
    expect(spawnCount).toBe(2)
    expect(pool.occupiedProcessSlotCount).toBe(2)

    lease1.release()
    expect(pool.occupiedProcessSlotCount).toBe(2)

    // Confirm group release + close for dead generation -> slot drops to 1 (only lease2's connection).
    firstGroupReleased = true
    firstCloseGate.resolve()
    await vi.waitFor(
      () => {
        expect(pool.occupiedProcessSlotCount).toBe(1)
      },
      { timeout: 2_500 },
    )

    lease2.release()
    await pool.dispose()
  })

  it('honors notification-only whenReleased witnesses on both close success and failure, and retains failed owned-group slots without witnesses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-when-released-'))
    tempDirs.push(root)
    const dirSuccess = join(root, 'when-success')
    const dirFailure = join(root, 'when-failure')
    const dirNoWitness = join(root, 'group-no-witness')
    await Promise.all([
      mkdir(dirSuccess, { recursive: true }),
      mkdir(dirFailure, { recursive: true }),
      mkdir(dirNoWitness, { recursive: true }),
    ])
    const canonSuccess = await realpath(dirSuccess)
    const canonFailure = await realpath(dirFailure)

    const successGate = Promise.withResolvers<void>()
    const failureGate = Promise.withResolvers<void>()
    let failFake!: ReturnType<typeof fakeAcpChild>
    let noWitnessFake!: ReturnType<typeof fakeAcpChild>

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        if (canonicalCwd === canonSuccess) {
          return {
            child: fake.child,
            close: async () => {
              // Root closes and shutdown succeeds BEFORE whenReleased resolves!
              fake.child.kill('SIGTERM')
            },
            whenReleased: () => successGate.promise,
          }
        }
        if (canonicalCwd === canonFailure) {
          failFake = fake
          return {
            child: fake.child,
            close: async () => {
              throw new Error('Simulated close failure with whenReleased-only witness')
            },
            whenReleased: () => failureGate.promise,
          }
        }
        noWitnessFake = fake
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            throw new Error('Simulated failed owned group without witness')
          },
        }
      },
    })

    // 1. Success path with notification-only `whenReleased`: must NOT release early when root closes first.
    const successLease = await pool.acquire({
      cwd: dirSuccess,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-wr-ok',
    })
    const successDispatched = Promise.withResolvers<void>()
    const successOp = successLease.connection.requestOwned(
      'ping',
      {},
      { timeoutMs: undefined, onDispatch: () => successDispatched.resolve() },
    )
    const successOpResult = successOp.result.catch((err: unknown) => err)
    await successDispatched.promise
    let successPhysicalCount = 0
    void successOp.physicalCompletion.then(() => {
      successPhysicalCount += 1
      return undefined
    })
    await expect(successLease.connection.close(new Error('close success path'))).rejects.toThrow(
      /did not confirm release/u,
    )
    expect(await successOpResult).toBeInstanceOf(Error)
    expect(successLease.connection.hasProcessClosed).toBe(true)
    expect(successLease.connection.isPhysicallyReleased).toBe(false)
    expect(successPhysicalCount).toBe(0)
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(1)
    })

    successGate.resolve()
    await expect(successOp.physicalCompletion).resolves.toBe('connection_closed')
    expect(successPhysicalCount).toBe(1)
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(0)
    })
    successLease.release()

    // 2. Failure path with notification-only `whenReleased`: root closing alone must NOT release slot or settle physical work.
    const failureLease = await pool.acquire({
      cwd: dirFailure,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-wr-fail',
    })
    const failureDispatched = Promise.withResolvers<void>()
    const failureOp = failureLease.connection.requestOwned(
      'ping',
      {},
      { timeoutMs: undefined, onDispatch: () => failureDispatched.resolve() },
    )
    const failureOpResult = failureOp.result.catch((err: unknown) => err)
    await failureDispatched.promise
    let failurePhysicalCount = 0
    void failureOp.physicalCompletion.then(() => {
      failurePhysicalCount += 1
      return undefined
    })
    await expect(failureLease.connection.close(new Error('close fail path'))).rejects.toThrow(
      /whenReleased-only witness/u,
    )
    expect(await failureOpResult).toBeInstanceOf(Error)
    failFake.emitExitOnly(0, 'SIGTERM')
    failFake.emitCloseOnly(0, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(failureLease.connection.isPhysicallyReleased).toBe(false)
    expect(failurePhysicalCount).toBe(0)
    expect(pool.unconfirmedClosingCount).toBe(1)

    failureGate.resolve()
    await expect(failureOp.physicalCompletion).resolves.toBe('connection_closed')
    expect(failurePhysicalCount).toBe(1)
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(0)
    })
    failureLease.release()

    // 3. Failed owned group with NEITHER `isReleased` NOR `whenReleased`: must NOT downgrade to root-only release.
    const noWitnessLease = await pool.acquire({
      cwd: dirNoWitness,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-group-no-witness',
    })
    await expect(
      noWitnessLease.connection.close(new Error('close no-witness group')),
    ).rejects.toThrow(/without witness/u)
    noWitnessFake.emitExitOnly(0, 'SIGKILL')
    noWitnessFake.emitCloseOnly(0, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(noWitnessLease.connection.hasProcessClosed).toBe(true)
    expect(noWitnessLease.connection.isPhysicallyReleased).toBe(false)
    expect(pool.unconfirmedClosingCount).toBe(1)
    expect(pool.occupiedProcessSlotCount).toBe(1)
    noWitnessLease.release()

    await pool.dispose().catch(() => undefined)
  })

  it.skipIf(process.platform === 'win32')(
    'recovers a real OwnedProcessGroup after close timeout and settles pending physical requests exactly once',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pact-agy-real-group-late-'))
      tempDirs.push(root)
      const readyFlag = join(root, 'ready-helper')
      const releaseFlag = join(root, 'release-helper')
      const script = join(root, 'stub-acp.cjs')
      await writeFile(
        script,
        [
          "const { existsSync, writeFileSync } = require('node:fs')",
          "process.on('SIGTERM', () => {})",
          `writeFileSync(${JSON.stringify(readyFlag)}, 'ready')`,
          'process.stdin.resume()',
          `setInterval(() => { if (existsSync(${JSON.stringify(releaseFlag)})) process.exit(0) }, 15)`,
          'setTimeout(() => process.exit(0), 15000)',
        ].join('\n'),
      )

      let realGroup!: OwnedProcessGroup
      const pool = new AgyAcpConnectionPool({
        executablePath: process.execPath,
        processFactory(canonicalCwd) {
          realGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
          const child = realGroup.spawn(process.execPath, [script], { cwd: canonicalCwd })
          return {
            child,
            close: (deadlineAt) => realGroup.close(deadlineAt),
            physicalWitness: (ownerId) => realGroup.physicalWitness(ownerId),
            isOwnedGroup: true,
            isReleased: () => realGroup.released || realGroup.settledAfterCloseTimeout(),
          }
        },
      })

      const lease = await pool.acquire({
        cwd: root,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-real-late',
      })
      const realDispatched = Promise.withResolvers<void>()
      const op = lease.connection.requestOwned(
        'ping',
        {},
        { timeoutMs: undefined, onDispatch: () => realDispatched.resolve() },
      )
      const opResult = op.result.catch((err: unknown) => err)
      await realDispatched.promise
      let physicalSettled = 0
      void op.physicalCompletion.then(() => {
        physicalSettled += 1
        return undefined
      })

      // Wait until the real child process has registered its SIGTERM trap before capping shutdown.
      await vi.waitFor(
        () => {
          expect(existsSync(readyFlag)).toBe(true)
        },
        { timeout: 5_000 },
      )

      // Force a short shutdown deadline so the real OwnedProcessGroup close times out while the child is still alive.
      lease.connection.capShutdownDeadline(Date.now() + 60)
      await expect(lease.connection.close(new Error('short deadline'))).rejects.toThrow(/deadline/u)
      expect(String(await opResult)).toMatch(/short deadline/u)
      expect(realGroup.released).toBe(false)
      expect(physicalSettled).toBe(0)
      await vi.waitFor(() => {
        expect(pool.unconfirmedClosingCount).toBe(1)
      })
      lease.release()

      // Allow the real OS child process to exit -> real OwnedProcessGroup confirms ESRCH via
      // settledAfterCloseTimeout(), sets released = true, settles physicalCompletion exactly once,
      // and clears the pool quarantine slot!
      await writeFile(releaseFlag, 'go')
      await vi.waitFor(
        () => {
          lease.connection.recheckPhysicalRelease()
          expect(realGroup.released).toBe(true)
          expect(pool.unconfirmedClosingCount).toBe(0)
          expect(pool.occupiedProcessSlotCount).toBe(0)
        },
        { interval: 25, timeout: 5_000 },
      )
      await expect(op.physicalCompletion).resolves.toBe('connection_closed')
      expect(physicalSettled).toBe(1)
      await pool.dispose()
    },
    15_000,
  )

  it('excludes only the expired session/close when two same-session closes have different deadlines', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-dual-close-'))
    tempDirs.push(root)

    let fake!: ReturnType<typeof fakeAcpChild>
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        fake = fakeAcpChild()
        return fake.child
      },
    })

    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-dual-1',
    })
    const lease2 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-dual-2',
    })
    const conn = lease1.connection
    expect(lease2.connection).toBe(conn)

    const closeShort = lease1.closeSession('sid-shared', { timeoutMs: 50 })
    const closeLong = lease2.closeSession('sid-shared', { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.receivedFrames.filter((f) => f.method === 'session/close')).toHaveLength(2)
    const longCloseId = fake.receivedFrames[1]!.id

    // Advance 50ms (total 60ms): short close expires while long close for the exact same sessionId is still pending!
    await vi.advanceTimersByTimeAsync(50)
    await expect(closeShort).resolves.toMatchObject({ confirmed: false, reason: 'timeout' })
    expect(pool.retiringCount).toBe(1)
    expect(conn.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)

    // Releasing both leases MUST NOT preempt the still-in-flight second session/close!
    lease1.release()
    lease2.release()
    expect(conn.isOpen).toBe(true)
    expect(conn.hasActiveWorkExcludingUnconfirmedCloses()).toBe(true)

    // Reply ONLY to the long close (leaving the expired short close unanswered) ->
    // long close confirms and the retiring connection then closes cleanly!
    fake.send({ jsonrpc: '2.0', id: longCloseId, result: {} })
    await expect(closeLong).resolves.toEqual({ confirmed: true, result: {} })
    await vi.advanceTimersByTimeAsync(10)
    expect(conn.isOpen).toBe(false)
    expect(pool.retiringCount).toBe(0)

    await pool.dispose()
  })

  it('does not repopulate unconfirmedClosedSessions when a retained lease calls closeSession after pool.dispose()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-post-dispose-close-'))
    tempDirs.push(root)
    const dirHealthy = join(root, 'healthy')
    const dirQuarantined = join(root, 'quarantined')
    await Promise.all([
      mkdir(dirHealthy, { recursive: true }),
      mkdir(dirQuarantined, { recursive: true }),
    ])
    const canonQuarantined = await realpath(dirQuarantined)
    const quarantinedGate = Promise.withResolvers<void>()
    let quarantinedFake!: ReturnType<typeof fakeAcpChild>

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        if (canonicalCwd === canonQuarantined) {
          quarantinedFake = fake
          return {
            child: fake.child,
            close: async () => {
              throw new Error('Quarantined close failure')
            },
            whenReleased: () => quarantinedGate.promise,
          }
        }
        return fake.child
      },
    })

    const healthyLease = await pool.acquire({
      cwd: dirHealthy,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-post-dispose',
    })
    const quarantinedLease = await pool.acquire({
      cwd: dirQuarantined,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-quarantined',
    })

    await expect(pool.dispose()).rejects.toThrow(/Quarantined close failure/u)
    expect(pool.unconfirmedClosedSessionCount).toBe(0)
    expect(pool.unconfirmedClosingCount).toBe(1)

    // Calling closeSession and recordUnconfirmedSessionClose on retained leases after disposal
    // must NOT repopulate logical registrations while physical quarantine remains intact.
    const lateCloseResult = await healthyLease.closeSession('sid-after-dispose')
    expect(lateCloseResult).toMatchObject({ confirmed: false, reason: 'transport_closed' })
    healthyLease.recordUnconfirmedSessionClose('sid-after-dispose-direct')
    expect(pool.unconfirmedClosedSessionCount).toBe(0)
    expect(pool.hasUnconfirmedClosedSession('sid-after-dispose')).toBe(false)
    expect(pool.hasUnconfirmedClosedSession('sid-after-dispose-direct')).toBe(false)
    expect(pool.retiringCount).toBe(0)
    expect(pool.unconfirmedClosingCount).toBe(1)

    healthyLease.release()
    quarantinedLease.release()
    quarantinedFake.emitExitOnly(0, 'SIGTERM')
    quarantinedFake.emitCloseOnly(0, 'SIGTERM')
    quarantinedGate.resolve()
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(0)
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
  })

  it('delivers an already-received terminal frame still parsing on root exit during concurrent same-key acquire while holding the physical slot until group release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-exit-drain-parse-'))
    tempDirs.push(root)

    let firstFake!: ReturnType<typeof fakeAcpChild>
    let firstGroupReleased = false
    const firstCloseGate = Promise.withResolvers<void>()
    let spawnCount = 0

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        if (spawnCount === 1) {
          firstFake = fake
          return {
            child: fake.child,
            isOwnedGroup: true,
            close: async () => {
              await firstCloseGate.promise
              fake.emitCloseOnly(0, null)
            },
            isReleased: () => firstGroupReleased,
          }
        }
        return fake.child
      },
    })

    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-drain-1',
    })
    const conn1 = lease1.connection
    const dispatched = Promise.withResolvers<void>()
    const op = conn1.requestOwned(
      'session/prompt',
      { sessionId: 'sess-drain-1' },
      { timeoutMs: undefined, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise

    // Send a >256 KiB terminal JSON-RPC reply so it enters the asynchronous parser seam,
    // then immediately emit root exit BEFORE the parser resolves.
    const parserEntered = Promise.withResolvers<void>()
    const releaseParser = Promise.withResolvers<void>()
    let parserAborted = false
    parserSeam.intercept = async (bytes, signal, observePhysicalCompletion) => {
      const physical = Promise.withResolvers<void>()
      observePhysicalCompletion?.(physical.promise)
      parserEntered.resolve()
      const onAbort = (): void => {
        parserAborted = true
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await releaseParser.promise
        signal.throwIfAborted()
        const message: unknown = JSON.parse(bytes.toString('utf8'))
        return { message, heldBytes: bytes.length }
      } finally {
        signal.removeEventListener('abort', onAbort)
        physical.resolve()
      }
    }

    const largeText = 'Z'.repeat(300 * 1024)
    firstFake.send({
      jsonrpc: '2.0',
      id: op.requestId,
      result: { stopReason: 'end_turn', payload: largeText },
    })
    await parserEntered.promise
    firstFake.emitExitOnly(0, null)
    expect(conn1.isOpen).toBe(false)

    // Concurrently acquire the same key while the terminal reply is still being parsed.
    const lease2 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-drain-2',
    })
    expect(lease2.connection).not.toBe(conn1)
    expect(spawnCount).toBe(2)
    expect(parserAborted).toBe(false)

    // Allow the in-flight parser to finish -> original caller MUST receive the terminal reply!
    releaseParser.resolve()
    const reply = (await op.result) as { result?: { stopReason?: string; payload?: string } }
    expect(reply.result?.stopReason).toBe('end_turn')
    expect(reply.result?.payload).toBe(largeText)
    await expect(op.physicalCompletion).resolves.toBe('reply')

    // Physical slot for conn1 MUST remain held until owned group release + close complete.
    expect(pool.occupiedProcessSlotCount).toBe(2)
    lease1.release()
    expect(pool.occupiedProcessSlotCount).toBe(2)

    firstGroupReleased = true
    firstCloseGate.resolve()
    await vi.waitFor(
      () => {
        expect(pool.occupiedProcessSlotCount).toBe(1)
      },
      { timeout: 2_500 },
    )

    lease2.release()
    await pool.dispose()
  })

  it('ends logical waits within the bounded exit-drain deadline when root exits with open inherited pipes while retaining the physical slot until release', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-exit-open-pipes-'))
    tempDirs.push(root)

    let fake!: ReturnType<typeof fakeAcpChild>
    let groupReleased = false
    let closeCalls = 0
    const closeGate = Promise.withResolvers<void>()

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        fake = fakeAcpChild()
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            closeCalls += 1
            await closeGate.promise
            fake.emitCloseOnly(1, null)
          },
          isReleased: () => groupReleased,
        }
      },
    })

    const lease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-open-pipes',
    })
    const conn = lease.connection
    const stream = conn.openSessionStream('sess-open-pipes')
    const dispatched = Promise.withResolvers<void>()
    const promptOp = conn.requestOwned(
      'session/prompt',
      { sessionId: 'sess-open-pipes' },
      { timeoutMs: undefined, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise
    const promptErrorPromise = promptOp.result.catch((err: unknown) => err)
    const notifErrorPromise = stream.next(undefined).catch((err: unknown) => err)

    // Only root exits; inherited descendant holds stdout/stderr pipes open (no 'end' or 'close').
    fake.emitExitOnly(1, null)
    expect(conn.isOpen).toBe(false)
    expect(pool.occupiedProcessSlotCount).toBe(1)

    // Bounded exit-drain timer fires and ends both accepted-Turn logical waits without hanging forever.
    await vi.advanceTimersByTimeAsync(AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS + 10)
    const [promptErr, notifErr] = await Promise.all([promptErrorPromise, notifErrorPromise])
    expect(promptErr).toBeInstanceOf(Error)
    expect(notifErr).toBeInstanceOf(Error)
    expect(closeCalls).toBe(1)
    expect(conn.isPhysicallyReleased).toBe(false)
    expect(pool.occupiedProcessSlotCount).toBe(1)

    stream.close()
    lease.release()
    expect(pool.occupiedProcessSlotCount).toBe(1)

    groupReleased = true
    closeGate.resolve()
    await vi.waitFor(() => {
      expect(conn.isPhysicallyReleased).toBe(true)
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
    await expect(promptOp.physicalCompletion).resolves.toBe('connection_closed')
    await pool.dispose()
  })

  it('rejects responses for undispatched queued session/close frames and preserves cancelled, capacity, and protocol_error reasons without emitting timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-undispatched-close-'))
    tempDirs.push(root)

    // 1. Blocked prior frame: queued session/close MUST NOT accept an injected reply as confirmed or 'reply'.
    const blockedFake = fakeAcpChild({ blockWrites: true })
    const conn = new AgyAcpConnection(blockedFake.child, root, 'standard')
    const pingOp = conn.requestOwned('ping', {}, { timeoutMs: 5_000 })
    const pingErr = pingOp.result.catch((err: unknown) => err)
    // Frame 0 is now active and blocked in writeNativeFrame; Frame 1 (session/close) is queued & undispatched.
    const queuedCloseOp = conn.requestOwned(
      'session/close',
      { sessionId: 'sid-queued' },
      { timeoutMs: 5_000, exemptFromPermissionWait: true },
    )
    blockedFake.send({ jsonrpc: '2.0', id: queuedCloseOp.requestId, result: {} })
    await expect(queuedCloseOp.result).rejects.toThrow(/undispatched/iu)
    await expect(queuedCloseOp.physicalCompletion).resolves.toBe('not_sent')
    blockedFake.unblockWrite()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(blockedFake.receivedFrames.some((f) => f.method === 'session/close')).toBe(false)
    await conn.close(new Error('done'))
    await pingErr

    // Also verify via pool lease.closeSession: returns protocol_error (not confirmed) and retires entry.
    let poolBlockedFake!: ReturnType<typeof fakeAcpChild>
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        poolBlockedFake = fakeAcpChild({ blockWrites: true })
        return poolBlockedFake.child
      },
    })
    const leaseBlocked = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-queued-pool',
    })
    const priorReq = leaseBlocked.connection
      .requestOwned('ping', {}, { timeoutMs: 5_000 })
      .result.catch(() => undefined)
    // Next request ID is 1 (after ping id=0).
    const closeSessionPromise = leaseBlocked.closeSession('sid-queued-pool', { timeoutMs: 5_000 })
    poolBlockedFake.send({ jsonrpc: '2.0', id: 1, result: {} })
    const queuedCloseRes = await closeSessionPromise
    expect(queuedCloseRes).toMatchObject({ confirmed: false, reason: 'protocol_error' })
    expect(pool.retiringCount).toBe(1)
    poolBlockedFake.unblockWrite()
    await leaseBlocked.connection.close(new Error('cleanup'))
    await priorReq
    leaseBlocked.release()

    // 2. Dispatched mixed/malformed responses ({ result, error } and { error: null }) reject as protocol_error
    //    and immediately taint & close each connection so desynced connections are never reused.
    const mixedFake = fakeAcpChild()
    const mixedConn = new AgyAcpConnection(mixedFake.child, root, 'standard')
    mixedFake.onRequest((frame) => {
      if (frame.method === 'session/close') {
        mixedFake.send({ jsonrpc: '2.0', id: frame.id, result: {}, error: { code: -32_000 } })
      }
    })
    expect(await mixedConn.closeSession('mixed')).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })
    expect(mixedConn.isTainted).toBe(true)
    expect(mixedConn.isOpen).toBe(false)

    const nullErrFake = fakeAcpChild()
    const nullErrConn = new AgyAcpConnection(nullErrFake.child, root, 'standard')
    nullErrFake.onRequest((frame) => {
      if (frame.method === 'session/close') {
        nullErrFake.send({ jsonrpc: '2.0', id: frame.id, error: null })
      }
    })
    expect(await nullErrConn.closeSession('null-err')).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })
    expect(nullErrConn.isTainted).toBe(true)
    expect(nullErrConn.isOpen).toBe(false)

    // 3. Pre-aborted signal -> 'cancelled' (never 'timeout').
    const abortFake = fakeAcpChild()
    const abortConn = new AgyAcpConnection(abortFake.child, root, 'standard')
    const preAborted = new AbortController()
    preAborted.abort()
    expect(
      await abortConn.closeSession('sid-pre-aborted', {
        timeoutMs: 5_000,
        signal: preAborted.signal,
      }),
    ).toMatchObject({ confirmed: false, reason: 'cancelled' })

    // 4. Mid-flight signal abort -> 'cancelled' (never 'timeout').
    const midAbort = new AbortController()
    const midClose = abortConn.closeSession('sid-mid-abort', {
      timeoutMs: 5_000,
      signal: midAbort.signal,
    })
    midAbort.abort()
    expect(await midClose).toMatchObject({ confirmed: false, reason: 'cancelled' })

    // 5. Full pending request budget (64) -> 'capacity' (never 'timeout').
    const capFake = fakeAcpChild()
    const capConn = new AgyAcpConnection(capFake.child, root, 'standard')
    const fillers = Array.from({ length: AGY_PENDING_REQUEST_LIMIT }, (_, idx) =>
      capConn.requestOwned('ping', { idx }, { timeoutMs: undefined }).result.catch(() => undefined),
    )
    const capRes = await capConn.closeSession('sid-over-cap', { timeoutMs: 5_000 })
    expect(capRes).toMatchObject({ confirmed: false, reason: 'capacity' })

    await mixedConn.close(new Error('done'))
    await nullErrConn.close(new Error('done'))
    await abortConn.close(new Error('done'))
    await capConn.close(new Error('done'))
    await Promise.all(fillers)
    await pool.dispose()
  })

  it('keeps isOwnedGroup-only factories quarantined after root close and propagates quarantined close failure in disposeIfIdle without duplicate close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-group-quarantine-'))
    tempDirs.push(root)
    const dirNoClose = join(root, 'group-flag-only')
    const dirQuarantine = join(root, 'quarantine-dispose-if-idle')
    await Promise.all([
      mkdir(dirNoClose, { recursive: true }),
      mkdir(dirQuarantine, { recursive: true }),
    ])
    const canonNoClose = await realpath(dirNoClose)

    let closeAttempts = 0
    let quarantineReleased = false
    let quarantineFake!: ReturnType<typeof fakeAcpChild>

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        if (canonicalCwd === canonNoClose) {
          // Only `isOwnedGroup: true` — NO group close, NO isReleased, NO whenReleased.
          return {
            child: fake.child,
            isOwnedGroup: true,
          }
        }
        quarantineFake = fake
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            closeAttempts += 1
            throw new Error('Owned group close timed out with live descendants')
          },
          isReleased: () => quarantineReleased,
        }
      },
    })

    // 1. Bare `isOwnedGroup: true` without group close/witness MUST stay quarantined even after root closes.
    const noCloseLease = await pool.acquire({
      cwd: dirNoClose,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-flag-only',
    })
    await expect(noCloseLease.connection.close(new Error('close flag-only group'))).rejects.toThrow(
      /did not confirm release/u,
    )
    expect(noCloseLease.connection.hasProcessClosed).toBe(true)
    expect(noCloseLease.connection.isPhysicallyReleased).toBe(false)
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(1)
      expect(pool.occupiedProcessSlotCount).toBe(1)
    })
    noCloseLease.release()

    // 2. Last lease calling disposeIfIdle() after same-generation connection was quarantined propagates close error without re-closing.
    const qLease = await pool.acquire({
      cwd: dirQuarantine,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-q-last-lease',
    })
    await expect(qLease.connection.close(new Error('initial failure'))).rejects.toThrow(
      /live descendants/u,
    )
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(2)
    })
    expect(closeAttempts).toBe(1)

    // Entry connection and closing are now cleared, yet disposeIfIdle() MUST propagate the exact failure!
    await expect(qLease.disposeIfIdle()).rejects.toThrow(/live descendants/u)
    expect(closeAttempts).toBe(1)

    quarantineReleased = true
    quarantineFake.emitExitOnly(0, 'SIGKILL')
    quarantineFake.emitCloseOnly(0, 'SIGKILL')
    await vi.waitFor(() => {
      expect(pool.unconfirmedClosingCount).toBe(1)
    })

    await pool.dispose().catch(() => undefined)
  })

  it('propagates the exact pool.dispose(deadline) timestamp to a retiring connection whose last lease released in the same tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-same-tick-deadline-'))
    tempDirs.push(root)

    const observedDeadlines: Array<number | undefined> = []
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const fake = fakeAcpChild()
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async (deadlineAt) => {
            observedDeadlines.push(deadlineAt)
            fake.child.kill('SIGTERM')
          },
          isReleased: () => true,
        }
      },
    })

    const lease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-same-tick-retire',
    })
    lease.recordUnconfirmedSessionClose('sid-retire-same-tick')
    expect(pool.retiringCount).toBe(1)

    // Same tick: release() clears entry.connection and queues target.close in a microtask,
    // immediately followed by pool.dispose(exactDeadline).
    const exactDeadline = Date.now() + 321
    lease.release()
    await pool.dispose(exactDeadline)

    expect(observedDeadlines).toEqual([exactDeadline])
  })

  it('omits nested structured RPC error payloads from closeSession detail and verifies legacy Batch prompt arguments against FrozenSourceReader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-detail-and-batch-'))
    tempDirs.push(root)

    // 1. Nested structured RPC errors never leak markers via JSON.stringify into detail.
    const markerA = 'NON_SENSITIVE_MARKER_ALPHA_9911'
    const markerB = 'NON_SENSITIVE_MARKER_BETA_9922'
    const resWithCode = classifyAgySessionCloseResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_603, data: { nested: { token: markerA, note: markerA } } },
    })
    expect(resWithCode).toEqual({ confirmed: false, reason: 'rpc_error', detail: 'code -32603' })
    expect(resWithCode.confirmed ? '' : (resWithCode.detail ?? '')).not.toContain(markerA)

    const resWithoutCodeOrMessage = classifyAgySessionCloseResponse({
      jsonrpc: '2.0',
      id: 2,
      error: { data: { nested: { secret: markerB } } },
    })
    expect(resWithoutCodeOrMessage).toEqual({ confirmed: false, reason: 'rpc_error' })
    expect('detail' in resWithoutCodeOrMessage).toBe(false)

    const fake = fakeAcpChild()
    const conn = new AgyAcpConnection(fake.child, root, 'standard')
    fake.onRequest((frame) => {
      if (frame.method === 'session/close') {
        fake.send({
          jsonrpc: '2.0',
          id: frame.id,
          error: { data: { nested: { marker: markerB } } },
        })
      }
    })
    const liveCloseRes = await conn.closeSession('sid-nested-err')
    expect(liveCloseRes).toEqual({ confirmed: false, reason: 'rpc_error' })
    await conn.close(new Error('done'))

    // 2. Legacy Batch prompt wording explicitly pairs source: 'batch' with batchId and works against real FrozenSourceReader.
    expect(collaborationSourceToolDescription).toContain("source: 'batch'")
    expect(collaborationSourceToolDescription).toContain('batchId')
    expect(collaborationSourceToolDescription).toContain("source: 'document'")

    const runId = randomUUID()
    const grant = randomUUID()
    const batchId = randomUUID()
    const sessionId = randomUUID()
    const bodyDoc = {
      id: randomUUID(),
      sha256: createHash('sha256').update('Batch body').digest('hex'),
      bytes: Buffer.byteLength('Batch body', 'utf8'),
      chars: 'Batch body'.length,
    }
    const reader = new FrozenSourceReader(
      { runId, grant },
      sessionId,
      {
        collaborationDocumentRow: (_sid, doc) => ({
          projectionBasis: null,
          projectionPages: null,
          sourceRunId: runId,
          pendingReceiptId: null,
          id: doc.id,
          sessionId,
          clientMessageId: randomUUID(),
          ownerKey: runId,
          purpose: 'input' as const,
          bytes: doc.bytes,
          chars: doc.chars,
          parts: 1,
          sealed: true,
          hash: doc.sha256,
          committedMessageId: null,
          createdAt: '2026-11-21T00:00:00.000Z',
          updatedAt: '2026-11-21T00:00:00.000Z',
        }),
        sourceDocumentAuthorized: (_runId, doc) => doc.id === bodyDoc.id,
        readPage: () => {
          throw new Error('readPage should not be called for batch read')
        },
        readFrozenInputBatch: (_runId, requestedBatchId) => ({
          batch: {
            id: requestedBatchId,
            sessionId,
            sequence: 1,
            memberCount: 0,
            commentsRevision: 0,
            revision: 1,
          },
          body: bodyDoc,
          userInformation: undefined,
          clarificationAnswer: undefined,
          members: [],
          hasMore: false,
          nextOrdinal: 0,
        }),
        readWorkflowInputs: () => {
          throw new Error('readWorkflowInputs not expected')
        },
        readRunSources: () => {
          throw new Error('readRunSources not expected')
        },
        readCutoffSource: () => {
          throw new Error('readCutoffSource not expected')
        },
      },
      () => true,
      () => batchId,
    )

    // Calling with explicit legacy Batch pairing described by collaborationSourceToolDescription succeeds and returns source: 'batch'.
    const batchResult = reader.read({
      runId,
      grant,
      source: 'batch',
      batchId,
      offset: 0,
    })
    expect(batchResult.page.source).toBe('batch')
    expect(JSON.parse(batchResult.page.text)).toMatchObject({
      batch: { id: batchId, revision: 1 },
    })
    expect(batchResult.page.nextOffset).toBeNull()

    // Omitting `source` defaults to 'document' and fails without a document reference (confirming why explicit pairing is required).
    expect(() =>
      reader.read({
        runId,
        grant,
        batchId,
        offset: 0,
      }),
    ).toThrow(/document/iu)
  })
})

describe('AgyIngress ordered stream, exit-drain separation, invalid_reply tainting, and pool retirement', () => {
  it('orders server_request and session/update strictly by monotonic seq in the same stdout chunk and auto-cancels unconsumed server_requests on abandon/close', async () => {
    const fake = fakeAcpChild()
    const conn = new AgyAcpConnection(fake.child, '/tmp/proj-ordered', 'standard')
    const stream = conn.openSessionStream('sid-order', { ordered: true })

    // Deliver notification + permission request + notification + elicitation in ONE single stdout chunk while consumer is paused.
    const chunk =
      [
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-order',
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', toolName: 'bash' },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'perm-1',
          method: 'session/request_permission',
          params: { sessionId: 'sid-order', toolCall: { toolCallId: 'tc-1' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-order',
            update: { sessionUpdate: 'agent_message_chunk', text: 'after-perm' },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'elicit-1',
          method: 'elicitation/create',
          params: { sessionId: 'sid-order', message: 'Need input' },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 77,
          method: 'session/request_permission',
          params: { sessionId: 'sid-order', toolCall: { toolCallId: 'tc-2' } },
        }),
      ].join('\n') + '\n'
    fake.sendRaw(chunk)

    await vi.waitFor(() => {
      expect(conn.diagnostics().queuedMessages).toBe(5)
    })

    const first = (await stream.next()).value as AgyIngress
    const second = (await stream.next()).value as AgyIngress
    const third = (await stream.next()).value as AgyIngress

    expect(first.kind).toBe('notification')
    expect(second).toMatchObject({
      kind: 'server_request',
      rpcId: 'perm-1',
      method: 'session/request_permission',
    })
    expect(third.kind).toBe('notification')
    expect(first.seq).toBeLessThan(second.seq)
    expect(second.seq).toBeLessThan(third.seq)

    // Abandon while elicit-1 and perm 77 are still unconsumed -> auto-cancel replies MUST be written.
    stream.abandon()
    await vi.waitFor(() => {
      expect(fake.receivedFrames).toContainEqual({
        jsonrpc: '2.0',
        id: 'elicit-1',
        result: { action: 'cancel' },
      })
      expect(fake.receivedFrames).toContainEqual({
        jsonrpc: '2.0',
        id: 77,
        result: { outcome: { outcome: 'cancelled' } },
      })
    })
    expect(conn.diagnostics().queuedMessages).toBe(0)
    expect(conn.workingMemoryBytes).toBe(0)

    const doneIter = await stream.next()
    expect(doneIter).toEqual({ value: undefined, done: true })

    await conn.close(new Error('done'))
  })

  it('injects requestOwned({ replyTo }) reply frame strictly before subsequent chunks in the same stdout write even when paused', async () => {
    const fake = fakeAcpChild()
    const conn = new AgyAcpConnection(fake.child, '/tmp/proj-replyto', 'standard')
    const stream = conn.openSessionStream('sid-reply', { ordered: true })

    const dispatched = Promise.withResolvers<void>()
    const promptOp = conn.requestOwned(
      'session/prompt',
      { sessionId: 'sid-reply', prompt: [{ type: 'text', text: 'hello' }] },
      { timeoutMs: 5_000, replyTo: stream, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise

    // Foreign stream from a different connection is rejected before writing bytes.
    const otherFake = fakeAcpChild()
    const otherConn = new AgyAcpConnection(otherFake.child, '/tmp/proj-other', 'standard')
    const foreignOp = otherConn.requestOwned('ping', {}, { timeoutMs: 5_000, replyTo: stream })
    await expect(foreignOp.result).rejects.toThrow(/does not belong/u)
    await expect(foreignOp.physicalOutcome).resolves.toBe('not_sent')
    await otherConn.close(new Error('done'))

    // While consumer is completely paused, write foreground chunk + terminal RPC reply + background completion in ONE chunk.
    const singleChunk =
      [
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-reply',
            update: { sessionUpdate: 'agent_message_chunk', text: 'fg-tail' },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: promptOp.requestId,
          result: { stopReason: 'end_turn' },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-reply',
            update: { sessionUpdate: 'background_task_completed', taskId: 'bg-1' },
          },
        }),
      ].join('\n') + '\n'
    fake.sendRaw(singleChunk)

    const rpcResult = (await promptOp.result) as { result?: { stopReason?: string } }
    expect(rpcResult.result?.stopReason).toBe('end_turn')
    await expect(promptOp.physicalOutcome).resolves.toBe('reply')

    const items: AgyIngress[] = []
    for (let i = 0; i < 3; i += 1) {
      const next = await stream.next()
      expect(next.done).toBe(false)
      if (!next.done) items.push(next.value)
    }

    expect(items.map((item) => item.kind)).toEqual(['notification', 'reply', 'notification'])
    expect(items[0]!.seq).toBeLessThan(items[1]!.seq)
    expect(items[1]!.seq).toBeLessThan(items[2]!.seq)
    expect(items[1]).toMatchObject({
      kind: 'reply',
      requestId: promptOp.requestId,
      message: {
        jsonrpc: '2.0',
        id: promptOp.requestId,
        result: { stopReason: 'end_turn' },
      },
    })

    stream.abandon()
    await conn.close(new Error('done'))
  })

  it('drains buffered readableLength on Win32-style output.end() + immediate facade close, preserves queued trailing items after EOF, reports half-frame incomplete, and releases reservations only on drain or abandon', async () => {
    // 1. Win32 PassThrough order: large Frame 1 pauses stdout in async parser; Frame 2 (trailing notification)
    //    + Frame 3 (terminal reply) are written, output.end() is called, and facade 'close' fires immediately!
    const fake1 = fakeAcpChild()
    const conn1 = new AgyAcpConnection(fake1.child, '/tmp/proj-win32-drain', 'standard')
    const stream1 = conn1.openSessionStream('sid-win32', { ordered: true })
    const legacyStream1 = conn1.openSessionStream('sid-legacy')

    const dispatched = Promise.withResolvers<void>()
    const promptOp = conn1.requestOwned(
      'session/prompt',
      { sessionId: 'sid-win32' },
      { timeoutMs: undefined, replyTo: stream1, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise

    const parserEntered = Promise.withResolvers<void>()
    const releaseParser = Promise.withResolvers<void>()
    parserSeam.intercept = async (bytes, signal, observePhysicalCompletion) => {
      const physical = Promise.withResolvers<void>()
      observePhysicalCompletion?.(physical.promise)
      parserEntered.resolve()
      await releaseParser.promise
      signal.throwIfAborted()
      const message: unknown = JSON.parse(bytes.toString('utf8'))
      physical.resolve()
      return { message, heldBytes: bytes.length }
    }

    // >256 KiB Frame 1 enters async parser and pauses stdout.
    const bigPayload = 'A'.repeat(300 * 1024)
    fake1.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sid-win32', update: { text: bigPayload } },
    })
    await parserEntered.promise

    // While stdout is paused, write trailing notifications + terminal reply, end stdout, and emit facade close immediately.
    fake1.sendRaw(
      [
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'sid-win32', update: { text: 'trailing-after-close' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'sid-legacy', update: { text: 'legacy-trailing' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: promptOp.requestId,
          result: { stopReason: 'end_turn' },
        }),
      ].join('\n') + '\n',
    )
    fake1.endStdout()
    fake1.emitCloseOnly(0, null)

    // Release Frame 1 parser -> buffered unread bytes MUST be drained before sealing producer!
    releaseParser.resolve()
    const reply = (await promptOp.result) as { result?: { stopReason?: string } }
    expect(reply.result?.stopReason).toBe('end_turn')
    await expect(promptOp.physicalOutcome).resolves.toBe('reply')

    // Producer is now sealed, yet queued trailing items MUST still be preserved and hold working memory!
    await vi.waitFor(() => {
      expect(conn1.isOpen).toBe(false)
    })
    expect(conn1.workingMemoryBytes).toBeGreaterThan(0)

    // Legacy stream STILL shifts its queued trailing item after EOF!
    const legacyTail = legacyStream1.shift()
    expect(legacyTail).toMatchObject({ params: { update: { text: 'legacy-trailing' } } })
    expect(legacyStream1.shift()).toBeUndefined()
    legacyStream1.close()

    // Ordered stream drains all 3 frames in strict seq order and THEN delivers { kind: 'end', cause: 'eof', incomplete: false }.
    const drained: AgyIngress[] = []
    for await (const ingress of stream1) {
      drained.push(ingress)
    }
    expect(drained.map((d) => d.kind)).toEqual(['notification', 'notification', 'reply', 'end'])
    expect(drained[0]!.seq).toBeLessThan(drained[1]!.seq)
    expect(drained[1]!.seq).toBeLessThan(drained[2]!.seq)
    expect(drained[2]!.seq).toBeLessThan(drained[3]!.seq)
    expect(drained[3]).toMatchObject({ kind: 'end', cause: 'eof', incomplete: false })
    expect(conn1.workingMemoryBytes).toBe(0)
    await conn1.close(new Error('done'))

    // 2. Half-frame at EOF reports incomplete: true AND unconsumed reservations release ONLY on explicit abandon().
    const fake2 = fakeAcpChild()
    const conn2 = new AgyAcpConnection(fake2.child, '/tmp/proj-half-frame', 'standard')
    const stream2 = conn2.openSessionStream('sid-half', { ordered: true })
    fake2.sendRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-half', update: { text: 'complete-1' } },
      }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'sid-half', update: { text: 'complete-2' } },
        }) +
        '\n' +
        '{"jsonrpc":"2.0","method":"session/update","params":{"truncated":true',
    )
    fake2.endStdout()
    fake2.emitExitOnly(0, null)
    fake2.emitCloseOnly(0, null)

    await vi.waitFor(() => {
      expect(conn2.isOpen).toBe(false)
      expect(conn2.diagnostics().queuedMessages).toBe(2)
    })
    const heldBeforeAbandon = conn2.workingMemoryBytes
    expect(heldBeforeAbandon).toBeGreaterThan(0)
    // Shift 1 item, then explicitly abandon the second item -> remaining reservation MUST release to 0.
    expect(stream2.shift()?.kind).toBe('notification')
    expect(conn2.workingMemoryBytes).toBeGreaterThan(0)
    stream2.abandon()
    expect(conn2.workingMemoryBytes).toBe(0)
    expect(conn2.diagnostics().queuedMessages).toBe(0)
    await conn2.close(new Error('done'))

    // Verify full drain after half-frame EOF delivers end { cause: 'eof', incomplete: true }.
    const fake3 = fakeAcpChild()
    const conn3 = new AgyAcpConnection(fake3.child, '/tmp/proj-half-drain', 'standard')
    const stream3 = conn3.openSessionStream('sid-half-drain', { ordered: true })
    fake3.sendRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-half-drain', update: { text: 'only-complete' } },
      }) + '\n{"partial":1',
    )
    fake3.endStdout()
    fake3.emitExitOnly(0, null)
    fake3.emitCloseOnly(0, null)

    const items3: AgyIngress[] = []
    for await (const ingress of stream3) {
      items3.push(ingress)
    }
    expect(items3.map((i) => i.kind)).toEqual(['notification', 'end'])
    expect(items3[1]).toMatchObject({ kind: 'end', cause: 'eof', incomplete: true })
    expect(conn3.workingMemoryBytes).toBe(0)
    await conn3.close(new Error('done'))

    // 3. Exit-drain deadline expires with half-frame on open inherited pipe -> end { cause: 'deadline', incomplete: true }.
    vi.useFakeTimers()
    const fake4 = fakeAcpChild()
    const conn4 = new AgyAcpConnection(fake4.child, '/tmp/proj-deadline-half', 'standard')
    const stream4 = conn4.openSessionStream('sid-deadline', { ordered: true })
    fake4.sendRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-deadline', update: { text: 'before-hang' } },
      }) + '\n{"unterminated":',
    )
    fake4.emitExitOnly(1, null)
    await vi.advanceTimersByTimeAsync(AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS + 10)
    const first4 = stream4.shift()
    expect(first4?.kind).toBe('notification')
    const end4 = stream4.shift()
    expect(end4).toMatchObject({ kind: 'end', cause: 'deadline', incomplete: true })
    expect(conn4.workingMemoryBytes).toBe(0)
    fake4.emitCloseOnly(1, null)
    await conn4.close(new Error('done'))
  })

  it('settles malformed or wrong-version JSON-RPC replies as invalid_reply, immediately taints/retires the pooled connection, ignores unknown IDs, and reports NativeCapacityError as capacity in closeSession', async () => {
    // 1. classifyAgySessionCloseResponse strictly requires jsonrpc === '2.0'.
    expect(classifyAgySessionCloseResponse({ id: 1, result: {} })).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })
    expect(classifyAgySessionCloseResponse({ jsonrpc: '1.0', id: 1, result: {} })).toMatchObject({
      confirmed: false,
      reason: 'protocol_error',
    })

    // 2. Pooled ordinary RPC receiving mixed { result, error } or wrong jsonrpc settles invalid_reply and retires/closes connection.
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-invalid-reply-'))
    tempDirs.push(root)
    let spawnCount = 0
    const fakes: Array<ReturnType<typeof fakeAcpChild>> = []

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        fakes.push(fake)
        return fake.child
      },
    })

    // Case A: wrong jsonrpc version ('1.0') on session/set_mode + unknown ID frame before it (must not ACK!).
    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-bad-ver',
    })
    const conn1 = lease1.connection
    const dispatched1 = Promise.withResolvers<void>()
    const op1 = conn1.requestOwned(
      'session/set_mode',
      { sessionId: 'sess-bad-ver', modeId: 'ask' },
      { timeoutMs: 5_000, onDispatch: () => dispatched1.resolve() },
    )
    await dispatched1.promise

    // Unknown ID must NEVER settle op1 or taint conn1.
    fakes[0]!.send({ jsonrpc: '2.0', id: 99_999, result: {} })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(conn1.isOpen).toBe(true)
    expect(conn1.isTainted).toBe(false)

    // Wrong jsonrpc version matching op1.requestId -> protocol_error + invalid_reply + immediate taint/retirement!
    fakes[0]!.send({ jsonrpc: '1.0', id: op1.requestId, result: {} })
    await expect(op1.result).rejects.toThrow(/jsonrpc/iu)
    const outcome1: AgyRequestPhysicalCompletion = await op1.physicalOutcome
    expect(outcome1).toBe('invalid_reply')
    await expect(op1.physicalCompletion).resolves.toBe('connection_closed')
    expect(conn1.isTainted).toBe(true)
    expect(conn1.isOpen).toBe(false)
    expect(pool.retiringCount).toBe(1)

    // New requests on the tainted connection MUST be rejected immediately.
    const rejectedNew = conn1.requestOwned('ping', {}, { timeoutMs: 5_000 })
    await expect(rejectedNew.result).rejects.toThrow(/jsonrpc/iu)
    await expect(rejectedNew.physicalOutcome).resolves.toBe('not_sent')

    // New acquire MUST spawn a fresh connection and NEVER reuse the tainted one.
    const lease2 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-fresh-after-taint',
    })
    expect(lease2.connection).not.toBe(conn1)
    expect(spawnCount).toBe(2)

    // Releasing lease1 closes the tainted connection cleanly and frees its slot.
    lease1.release()
    await vi.waitFor(() => {
      expect(pool.retiringCount).toBe(0)
      expect(pool.occupiedProcessSlotCount).toBe(1)
    })

    // Case B: mixed { result, error } on session/new settles invalid_reply and retires connection.
    const conn2 = lease2.connection
    const dispatched2 = Promise.withResolvers<void>()
    const op2 = conn2.requestOwned(
      'session/new',
      { cwd: root, mcpServers: [] },
      { timeoutMs: 5_000, onDispatch: () => dispatched2.resolve() },
    )
    await dispatched2.promise
    fakes[1]!.send({ jsonrpc: '2.0', id: op2.requestId, result: {}, error: { code: -32_000 } })
    await expect(op2.result).rejects.toThrow(/both result and error/iu)
    await expect(op2.physicalOutcome).resolves.toBe('invalid_reply')
    expect(conn2.isTainted).toBe(true)
    lease2.release()
    await vi.waitFor(() => {
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })

    // 3. Full business working memory causes closeSession to classify NativeCapacityError as reason: 'capacity'.
    const leaseCap = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-mem-cap',
    })
    const hogs = Array.from({ length: 4 }, () =>
      new NativeWorkingMemory('business').reserve(NATIVE_OWNER_WORKING_BYTES),
    )
    try {
      const capCloseRes = await leaseCap.connection.closeSession('sess-mem-cap')
      expect(capCloseRes).toMatchObject({ confirmed: false, reason: 'capacity' })
    } finally {
      for (const hog of hogs) hog.release()
    }
    leaseCap.release()
    await pool.dispose()
  })

  it('atomically retires healthy idle-timer pools via tryRetireIdle while blocking on busy work and keeping occupiedProcessSlotCount tied to physical exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-try-retire-idle-'))
    tempDirs.push(root)

    // 1. Busy checks: active lease, initializing, pending RPC, session owner, full access ref -> all return { kind: 'busy' }.
    let closeGate = Promise.withResolvers<void>()
    const poolBusy = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const fake = fakeAcpChild()
        fake.onRequest((frame) => {
          if (frame.method === 'initialize') {
            // Defer initialize response to test initializing busy state.
            void closeGate.promise.then(() => {
              fake.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
              return undefined
            })
          }
        })
        return fake.child
      },
    })

    const leaseA = await poolBusy.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-busy-1',
    })
    // Active lease -> busy.
    expect(poolBusy.tryRetireIdle()).toEqual({ kind: 'busy' })

    // Initializing in progress (even if lease released early) -> busy.
    const initPromise = leaseA.ensureInitialized(new AbortController().signal)
    expect(poolBusy.tryRetireIdle()).toEqual({ kind: 'busy' })
    closeGate.resolve()
    await initPromise

    // Active serverRequestOwner while lease released -> busy.
    const ownerHandle = leaseA.connection.registerServerRequestOwner({
      ownerId: 'owner-1',
      knownSessionId: 'sess-busy-1',
      handler: () => false,
    })
    leaseA.release()
    expect(poolBusy.tryRetireIdle()).toEqual({ kind: 'busy' })
    ownerHandle.dispose()

    // Active background listener -> busy.
    const unsubBg = leaseA.connection.subscribeBackground(() => false)
    expect(poolBusy.tryRetireIdle()).toEqual({ kind: 'busy' })
    unsubBg()

    // Active Full access ref -> busy even when lease released.
    const fullLease = await poolBusy.acquire({
      cwd: root,
      permissionScope: 'full',
      permissionMode: 'full',
      sessionId: 'sess-full-ref',
    })
    expect(poolBusy.tryRetireIdle()).toEqual({ kind: 'busy' })
    fullLease.release()
    await poolBusy.retireFullAccess({ sessionId: 'sess-full-ref', cwd: root })

    // 2. Healthy settled connection holding ONLY the 5-minute idleTimer -> tryRetireIdle() atomically seals & retires!
    const exitGate = Promise.withResolvers<void>()
    const poolIdle = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        const fake = fakeAcpChild()
        fake.onRequest((frame) => {
          if (frame.method === 'initialize') {
            fake.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          }
        })
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            await exitGate.promise
            fake.child.kill('SIGTERM')
          },
          isReleased: () => true,
        }
      },
    })

    const idleLease = await poolIdle.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-idle-timer',
    })
    await idleLease.ensureInitialized(new AbortController().signal)
    idleLease.release()
    await vi.waitFor(() => {
      expect(idleLease.connection.hasPendingPhysicalWork()).toBe(false)
    })
    expect(poolIdle.occupiedProcessSlotCount).toBe(1)

    const retirement: AgyPoolIdleRetirement = poolIdle.tryRetireIdle()
    expect(retirement.kind).toBe('retiring')
    // Pool MUST be synchronously sealed against new acquire immediately!
    await expect(
      poolIdle.acquire({
        cwd: root,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-after-seal',
      }),
    ).rejects.toThrow(/shutting down/iu)
    // occupiedProcessSlotCount MUST remain 1 until physical exit actually finishes!
    expect(poolIdle.occupiedProcessSlotCount).toBe(1)
    // Second tryRetireIdle while closing returns busy.
    expect(poolIdle.tryRetireIdle()).toEqual({ kind: 'busy' })

    exitGate.resolve()
    if (retirement.kind === 'retiring') {
      await retirement.physical
    }
    expect(poolIdle.occupiedProcessSlotCount).toBe(0)

    await poolBusy.dispose()
  })

  it('validates dispose(deadline), converges cleanly after a first dispose timeout once late physical exit arrives without duplicate kills, and wakes pool waiters on late OwnedAgyProcess.whenReleased', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-dispose-converge-'))
    tempDirs.push(root)

    // 1. Invalid deadline 0 or negative rejects WITHOUT poisoning shutdownDeadlineAt; dispose(undefined) then succeeds!
    const poolValid = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory: () => fakeAcpChild().child,
    })
    const leaseValid = await poolValid.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-valid-deadline',
    })
    expect(() => poolValid.capShutdownDeadline(0)).toThrow(/Invalid Antigravity shutdown deadline/u)
    await expect(poolValid.dispose(0)).rejects.toThrow(/Invalid Antigravity shutdown deadline/u)
    await expect(poolValid.dispose(-5)).rejects.toThrow(/Invalid Antigravity shutdown deadline/u)
    leaseValid.release()
    await expect(poolValid.dispose(undefined)).resolves.toBeUndefined()
    expect(poolValid.occupiedProcessSlotCount).toBe(0)

    // 2. First dispose() times out -> retries while still unreleased reject WITHOUT duplicate kill ->
    //    late physical exit + whenReleased() -> subsequent dispose() converges cleanly!
    let closeCalls = 0
    let fakeLate!: ReturnType<typeof fakeAcpChild>
    const lateReleaseGate = Promise.withResolvers<void>()
    let lateReleased = false
    const poolRetry = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        fakeLate = fakeAcpChild()
        return {
          child: fakeLate.child,
          isOwnedGroup: true,
          close: async () => {
            closeCalls += 1
            throw new Error('Initial physical group close timed out')
          },
          isReleased: () => lateReleased,
          whenReleased: () => lateReleaseGate.promise,
        }
      },
    })

    const leaseLate = await poolRetry.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-late-converge',
    })
    leaseLate.release()

    // Concurrent dispose calls coalesce onto one attempt.
    const d1 = poolRetry.dispose(Date.now() + 500)
    const d2 = poolRetry.dispose(Date.now() + 250)
    expect(d1).toBe(d2)
    await expect(d1).rejects.toThrow(/Initial physical group close timed out/u)
    expect(closeCalls).toBe(1)
    expect(poolRetry.occupiedProcessSlotCount).toBe(1)
    expect(poolRetry.unconfirmedClosingCount).toBe(1)

    // Pool stays permanently sealed against new acquire.
    await expect(
      poolRetry.acquire({
        cwd: root,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-post-dispose',
      }),
    ).rejects.toThrow(/shutting down/iu)

    // Retrying dispose while STILL unreleased surfaces the error WITHOUT spawning a duplicate kill.
    await expect(poolRetry.dispose()).rejects.toThrow(/Initial physical group close timed out/u)
    expect(closeCalls).toBe(1)

    // Now late physical exit + whenReleased() confirm release -> slot clears and next dispose() converges cleanly!
    lateReleased = true
    fakeLate.emitExitOnly(0, 'SIGKILL')
    fakeLate.emitCloseOnly(0, 'SIGKILL')
    lateReleaseGate.resolve()
    await vi.waitFor(() => {
      expect(poolRetry.unconfirmedClosingCount).toBe(0)
      expect(poolRetry.occupiedProcessSlotCount).toBe(0)
    })
    await expect(poolRetry.dispose()).resolves.toBeUndefined()
    expect(closeCalls).toBe(1)

    // 3. Late OwnedAgyProcess.whenReleased frees a quarantined slot at the 16-slot cap and wakes a blocked acquire waiter.
    const dirs = await Promise.all(
      Array.from({ length: 17 }, async (_, idx) => {
        const dir = join(root, `slot-${idx}`)
        await mkdir(dir, { recursive: true })
        return realpath(dir)
      }),
    )
    const firstSlotGate = Promise.withResolvers<void>()
    let firstSlotFake!: ReturnType<typeof fakeAcpChild>
    const poolCap = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        if (canonicalCwd === dirs[0]) {
          firstSlotFake = fake
          return {
            child: fake.child,
            isOwnedGroup: true,
            close: async () => {
              fake.emitExitOnly(0, 'SIGTERM')
              fake.emitCloseOnly(0, 'SIGTERM')
              throw new Error('Slot 0 close timed out pending whenReleased')
            },
            whenReleased: () => firstSlotGate.promise,
          }
        }
        return fake.child
      },
    })

    // Fill 16 slots: slot 0 quarantined via unconfirmed close, slots 1..15 holding active serverRequestOwners so none are evictable.
    const slot0Lease = await poolCap.acquire({
      cwd: dirs[0]!,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'slot-0',
    })
    await expect(slot0Lease.connection.close(new Error('quarantine slot 0'))).rejects.toThrow(
      /Slot 0 close timed out/u,
    )
    slot0Lease.release()
    await vi.waitFor(() => {
      expect(poolCap.unconfirmedClosingCount).toBe(1)
    })

    const heldOwners: Array<{ dispose: () => void }> = []
    for (let i = 1; i < 16; i += 1) {
      const l = await poolCap.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `slot-${i}`,
      })
      heldOwners.push(
        l.connection.registerServerRequestOwner({
          ownerId: `owner-${i}`,
          knownSessionId: `slot-${i}`,
          handler: () => false,
        }),
      )
      l.release()
    }
    expect(poolCap.occupiedProcessSlotCount).toBe(16)

    // 17th directory blocks waiting for capacity until slot 0's late whenReleased resolves!
    let acquired17 = false
    const acquire17 = poolCap
      .acquire({
        cwd: dirs[16]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'slot-16',
      })
      .then((lease) => {
        acquired17 = true
        return lease
      })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(acquired17).toBe(false)
    expect(firstSlotFake.child.exitCode).toBe(0)

    firstSlotGate.resolve()
    const lease17 = await acquire17
    expect(acquired17).toBe(true)
    expect(poolCap.unconfirmedClosingCount).toBe(0)
    lease17.release()
    for (const owner of heldOwners) owner.dispose()
    await poolCap.dispose()
  })

  it('enforces ownership-first server request routing, routes unscoped elicitations into the sole owner ordered stream with real seq, passes real seq to pre-stream handlers, and rejects duplicate session owners', async () => {
    // 1. Pre-stream setup: sole owner with knownSessionId undefined receives real positive seq.
    const fake1 = fakeAcpChild()
    const conn1 = new AgyAcpConnection(fake1.child, '/tmp/proj-owner-order', 'standard')
    const directCalls: Array<{ id: unknown; seq: number | undefined }> = []
    const owner1 = conn1.registerServerRequestOwner({
      ownerId: 'run:pre-stream',
      knownSessionId: undefined,
      handler: (message, seq) => {
        directCalls.push({ id: Reflect.get(message, 'id'), seq })
        return true
      },
    })
    fake1.send({
      jsonrpc: '2.0',
      id: 'elicit-pre',
      method: 'elicitation/create',
      params: { message: 'pre-stream' },
    })
    await vi.waitFor(() => {
      expect(directCalls).toHaveLength(1)
    })
    expect(directCalls[0]!.id).toBe('elicit-pre')
    expect(directCalls[0]!.seq).toBeGreaterThan(0)

    // 2. Once sole owner binds knownSessionId and opens ordered stream, unscoped elicitation arriving
    //    after prompt reply enters the ordered stream with real seq > reply.seq (never bypassing stream!).
    owner1.updateSessionId('sid-sole')
    const stream1 = conn1.openSessionStream('sid-sole', { ordered: true })
    const dispatched = Promise.withResolvers<void>()
    const promptOp = conn1.requestOwned(
      'session/prompt',
      { sessionId: 'sid-sole', prompt: [{ type: 'text', text: 'hi' }] },
      { timeoutMs: 5_000, replyTo: stream1, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise
    fake1.sendRaw(
      [
        JSON.stringify({
          jsonrpc: '2.0',
          id: promptOp.requestId,
          result: { stopReason: 'end_turn' },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'elicit-post-reply',
          method: 'elicitation/create',
          params: { message: 'too late' },
        }),
      ].join('\n') + '\n',
    )
    await expect(promptOp.result).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    const first = await stream1.nextIngress(1_000)
    const second = await stream1.nextIngress(1_000)
    expect(first).toMatchObject({ kind: 'reply', requestId: promptOp.requestId })
    expect(second).toMatchObject({
      kind: 'server_request',
      rpcId: 'elicit-post-reply',
      method: 'elicitation/create',
    })
    expect(second.seq).toBeGreaterThan(first.seq)
    // Direct callback MUST NOT have been invoked once the ordered stream was active.
    expect(directCalls).toHaveLength(1)

    // 3. Duplicate owners matching the same sessionId MUST reject with -32601 BEFORE entering the ordered stream.
    const dupCalls: unknown[] = []
    const ownerDup = conn1.registerServerRequestOwner({
      ownerId: 'run:dup',
      knownSessionId: 'sid-sole',
      handler: (message) => {
        dupCalls.push(message)
        return true
      },
    })
    fake1.send({
      jsonrpc: '2.0',
      id: 'perm-ambiguous',
      method: 'session/request_permission',
      params: { sessionId: 'sid-sole', toolCall: { toolCallId: 'tc-dup' } },
    })
    await vi.waitFor(() => {
      expect(fake1.receivedFrames).toContainEqual(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 'perm-ambiguous',
          error: expect.objectContaining({ code: -32_601 }),
        }),
      )
    })
    expect(stream1.shift()).toBeUndefined()
    expect(directCalls).toHaveLength(1)
    expect(dupCalls).toHaveLength(0)

    ownerDup.dispose()
    owner1.dispose()
    stream1.abandon()
    await conn1.close(new Error('done'))
  })

  it('preserves trailing partial frames between nextIngress calls during exit drain and skips unowned respondError when stdin is closed so later replies in the same chunk deliver', async () => {
    // 1. Half-frame buffered between two nextIngress calls while same-key acquire triggers close on old connection.
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-exit-drain-tail-'))
    tempDirs.push(root)
    let spawnCount = 0
    const fakes: Array<ReturnType<typeof fakeAcpChild>> = []
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        spawnCount += 1
        const fake = fakeAcpChild()
        fakes.push(fake)
        return fake.child
      },
    })
    const lease1 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-tail-1',
    })
    const stream1 = lease1.connection.openSessionStream('sid-tail', { ordered: true })
    const frame1 = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-tail',
        update: { sessionUpdate: 'agent_message_chunk', text: 'first' },
      },
    })
    const frame2 = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-tail',
        update: { sessionUpdate: 'agent_message_chunk', text: 'second' },
      },
    })
    // Deliver frame1 + first half of frame2, then root exits while consumer is processing frame1 (not inside nextIngress).
    fakes[0]!.sendRaw(`${frame1}\n${frame2.slice(0, 20)}`)
    const item1 = await stream1.nextIngress(1_000)
    expect(item1).toMatchObject({ kind: 'notification' })

    // Root exits with zero pending RPCs and no active nextIngress waiter; concurrent same-key acquire requests close on old conn.
    fakes[0]!.emitExitOnly(0, null)
    const lease2 = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-tail-2',
    })
    expect(lease2.connection).not.toBe(lease1.connection)
    expect(spawnCount).toBe(2)

    // Complete second half of frame2 and close stdout -> frame2 MUST deliver cleanly followed by EOF end!
    fakes[0]!.sendRaw(`${frame2.slice(20)}\n`)
    fakes[0]!.endStdout()
    const item2 = await stream1.nextIngress(1_000)
    expect(item2).toMatchObject({
      kind: 'notification',
      message: { params: { update: { text: 'second' } } },
    })
    const endItem = await stream1.nextIngress(1_000)
    expect(endItem).toMatchObject({ kind: 'end', cause: 'eof', incomplete: false })

    stream1.abandon()
    lease1.release()
    lease2.release()
    fakes[0]!.emitCloseOnly(0, null)
    await pool.dispose()

    // 2. Exit drain chunk with an unowned server request BEFORE a valid terminal RPC reply MUST deliver the reply.
    const fake2 = fakeAcpChild()
    const conn2 = new AgyAcpConnection(fake2.child, '/tmp/proj-exit-unowned', 'standard')
    const stream2 = conn2.openSessionStream('sid-unowned', { ordered: true })
    const dispatched = Promise.withResolvers<void>()
    const op = conn2.requestOwned(
      'session/prompt',
      { sessionId: 'sid-unowned', prompt: [{ type: 'text', text: 'finish' }] },
      { timeoutMs: 5_000, replyTo: stream2, onDispatch: () => dispatched.resolve() },
    )
    await dispatched.promise

    // Root exits first (`exitRecorded === true`, `isOpen === false`), then trailing chunk carries unowned request + valid reply.
    fake2.emitExitOnly(0, null)
    fake2.sendRaw(
      [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'orphan-req',
          method: 'session/request_permission',
          params: { sessionId: 'sid-unknown' },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: op.requestId,
          result: { stopReason: 'end_turn' },
        }),
      ].join('\n') + '\n',
    )
    fake2.endStdout()

    await expect(op.result).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    const replyIngress = await stream2.nextIngress(1_000)
    expect(replyIngress).toMatchObject({ kind: 'reply', requestId: op.requestId })
    const end2 = await stream2.nextIngress(1_000)
    expect(end2).toMatchObject({ kind: 'end', cause: 'eof', incomplete: false })

    stream2.abandon()
    fake2.emitCloseOnly(0, null)
    await conn2.close(new Error('done'))
  })

  it('freezes first matching RPC reply state (reply vs invalid_reply) while writer drain is pending and immediately unblocks sibling runs on taint while holding physical slot', async () => {
    // 1. Order A (malformed first, valid second while writer drain pending) & Order B (valid first, malformed second).
    const fakeA = fakeAcpChild()
    const connA = new AgyAcpConnection(fakeA.child, '/tmp/proj-freeze-a', 'standard')
    const streamA = connA.openSessionStream('sid-freeze-a', { ordered: true })
    fakeA.blockWrite()
    const dispatchedA = Promise.withResolvers<void>()
    const opA = connA.requestOwned(
      'session/prompt',
      { sessionId: 'sid-freeze-a', prompt: [{ type: 'text', text: 'a' }] },
      { timeoutMs: 5_000, replyTo: streamA, onDispatch: () => dispatchedA.resolve() },
    )
    await dispatchedA.promise
    // Deliver malformed reply followed immediately by a valid reply for the SAME id before writer drain finishes.
    fakeA.sendRaw(
      [
        JSON.stringify({ jsonrpc: '2.0', id: opA.requestId, result: {}, error: { code: -1 } }),
        JSON.stringify({ jsonrpc: '2.0', id: opA.requestId, result: { stopReason: 'end_turn' } }),
      ].join('\n') + '\n',
    )
    await expect(opA.result).rejects.toThrow(/both result and error/iu)
    fakeA.unblockWrite()
    await expect(opA.physicalOutcome).resolves.toBe('invalid_reply')
    // Valid second reply MUST NOT have entered the ordered stream.
    const nextA = await streamA.nextIngress(1_000)
    expect(nextA.kind).toBe('end')
    streamA.abandon()
    await connA.close(new Error('done'))

    const fakeB = fakeAcpChild()
    const connB = new AgyAcpConnection(fakeB.child, '/tmp/proj-freeze-b', 'standard')
    const streamB = connB.openSessionStream('sid-freeze-b', { ordered: true })
    fakeB.blockWrite()
    const dispatchedB = Promise.withResolvers<void>()
    const opB = connB.requestOwned(
      'session/prompt',
      { sessionId: 'sid-freeze-b', prompt: [{ type: 'text', text: 'b' }] },
      { timeoutMs: 5_000, replyTo: streamB, onDispatch: () => dispatchedB.resolve() },
    )
    await dispatchedB.promise
    // Deliver valid reply first, then malformed reply with the SAME id before writer drain completes.
    fakeB.sendRaw(
      [
        JSON.stringify({ jsonrpc: '2.0', id: opB.requestId, result: { stopReason: 'end_turn' } }),
        JSON.stringify({ jsonrpc: '1.0', id: opB.requestId }),
      ].join('\n') + '\n',
    )
    await expect(opB.result).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    fakeB.unblockWrite()
    await expect(opB.physicalOutcome).resolves.toBe('reply')
    expect(connB.isTainted).toBe(false)
    expect(connB.isOpen).toBe(true)
    const replyB = await streamB.nextIngress(1_000)
    expect(replyB).toMatchObject({ kind: 'reply', requestId: opB.requestId })
    streamB.abandon()
    await connB.close(new Error('done'))

    // 2. Shared pooled connection: Run A malformed reply taints conn -> immediately closes so sibling Run B unblocks while slot remains held until group releases.
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-taint-sibling-'))
    tempDirs.push(root)
    const groupReleaseGate = Promise.withResolvers<void>()
    let groupReleased = false
    let sharedFake!: ReturnType<typeof fakeAcpChild>
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        sharedFake = fakeAcpChild()
        return {
          child: sharedFake.child,
          isOwnedGroup: true,
          close: async () => {
            await groupReleaseGate.promise
            sharedFake.child.kill('SIGTERM')
          },
          isReleased: () => groupReleased,
        }
      },
    })
    const leaseA = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-run-a',
    })
    const leaseB = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-run-b',
    })
    expect(leaseA.connection).toBe(leaseB.connection)

    const streamRunB = leaseB.connection.openSessionStream('sid-run-b', { ordered: true })
    const dispA = Promise.withResolvers<void>()
    const dispB = Promise.withResolvers<void>()
    const opRunA = leaseA.connection.requestOwned(
      'session/set_mode',
      { sessionId: 'sid-run-a', modeId: 'ask' },
      { timeoutMs: 5_000, onDispatch: () => dispA.resolve() },
    )
    const opRunB = leaseB.connection.requestOwned(
      'session/prompt',
      { sessionId: 'sid-run-b', prompt: [{ type: 'text', text: 'wait-perm' }] },
      { timeoutMs: undefined, replyTo: streamRunB, onDispatch: () => dispB.resolve() },
    )
    await Promise.all([dispA.promise, dispB.promise])
    const waitRunB = streamRunB.nextIngress(undefined)

    // Run A receives malformed reply -> taints and triggers immediate idempotent close even though leaseB is still held!
    sharedFake.send({ jsonrpc: '1.0', id: opRunA.requestId, result: {} })
    await expect(opRunA.result).rejects.toThrow(/jsonrpc/iu)
    await expect(opRunB.result).rejects.toThrow(/jsonrpc/iu)
    await expect(waitRunB).resolves.toMatchObject({ kind: 'end', cause: 'transport' })

    // Physical slot MUST remain charged until owned group actually releases.
    expect(pool.occupiedProcessSlotCount).toBe(1)
    streamRunB.abandon()
    leaseA.release()
    leaseB.release()
    expect(pool.occupiedProcessSlotCount).toBe(1)

    groupReleased = true
    groupReleaseGate.resolve()
    await vi.waitFor(() => {
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
    await pool.dispose()
  })

  it('tightens an already-started shutdown wait including parserCompletion to an earlier caller deadline without double-killing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-tighten-parser-'))
    tempDirs.push(root)
    let closeCalls = 0
    const parserEntered = Promise.withResolvers<void>()
    const releaseParser = Promise.withResolvers<void>()
    let fake!: ReturnType<typeof fakeAcpChild>

    parserSeam.intercept = async (_bytes, _signal, observePhysicalCompletion) => {
      const physical = Promise.withResolvers<void>()
      observePhysicalCompletion?.(physical.promise)
      parserEntered.resolve()
      await releaseParser.promise
      physical.resolve()
      return { message: { jsonrpc: '2.0', method: 'noop' }, heldBytes: 16 }
    }

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        fake = fakeAcpChild()
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            closeCalls += 1
            fake.child.kill('SIGTERM')
          },
          isReleased: () => true,
        }
      },
    })

    const lease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-parser-tight',
    })
    const conn = lease.connection
    // Trigger an in-flight large-frame parserCompletion that outlives child close.
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-parser-tight', payload: 'P'.repeat(300 * 1024) },
    })
    await parserEntered.promise

    // Start close WITHOUT a tight deadline; child closes immediately, leaving finalizePhysicalRequestsOnVerifiedClose blocked on parserCompletion.
    const startedClose = conn.close(new Error('idle close'))
    await vi.waitFor(() => {
      expect(closeCalls).toBe(1)
      expect(conn.hasObservedPhysicalRelease()).toBe(true)
    })
    expect(conn.isPhysicallyReleased).toBe(false)

    // Quit arrives with a tighter 50ms deadline -> MUST tighten the already-started shutdown wait without double-killing!
    const quitDeadline = Date.now() + 50
    const disposeErr = await pool.dispose(quitDeadline).catch((error: unknown) => error)
    expect(disposeErr).toMatchObject({
      code: 'unconfirmed_process',
      retryable: true,
    })
    await expect(startedClose).rejects.toMatchObject({
      code: 'unconfirmed_process',
      retryable: true,
    })
    expect(closeCalls).toBe(1)
    expect(conn.isPhysicallyReleased).toBe(false)
    expect(pool.occupiedProcessSlotCount).toBe(1)

    // Once the single parserCompletion finishes, physical finalizer resolves and slot drops to 0 without a second kill.
    releaseParser.resolve()
    await vi.waitFor(() => {
      expect(conn.isPhysicallyReleased).toBe(true)
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
    await expect(pool.dispose()).resolves.toBeUndefined()
    expect(closeCalls).toBe(1)
    lease.release()
  })

  it('keeps connections alive across the 5-minute idle timer while owners or listeners remain and wakes waiting acquires when the last owner unregisters', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-owner-idle-wake-'))
    tempDirs.push(root)
    const dirs = await Promise.all(
      Array.from({ length: 17 }, async (_, idx) => {
        const d = join(root, `dir-${idx}`)
        await mkdir(d, { recursive: true })
        return d
      }),
    )

    let spawnCount = 0
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      idleTimeoutMs: AGY_IDLE_CONNECTION_TIMEOUT_MS,
      processFactory() {
        spawnCount += 1
        return fakeAcpChild().child
      },
    })

    // Fill all 16 slots with 0-lease connections, each pinned by either a serverRequestOwner or background listener.
    const unregisters: Array<() => void> = []
    const conns: AgyAcpConnection[] = []
    for (let i = 0; i < 16; i += 1) {
      const l = await pool.acquire({
        cwd: dirs[i]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: `sess-pin-${i}`,
      })
      conns.push(l.connection)
      if (i % 2 === 0) {
        const owner = l.connection.registerServerRequestOwner({
          ownerId: `owner-${i}`,
          knownSessionId: `sid-pin-${i}`,
          handler: () => true,
        })
        unregisters.push(() => owner.dispose())
      } else {
        unregisters.push(l.connection.subscribeBackground(() => false))
      }
      l.release()
    }
    expect(pool.occupiedProcessSlotCount).toBe(16)

    // Advance past 5-minute idle timeout -> NONE of the owner/listener-pinned connections may close!
    await vi.advanceTimersByTimeAsync(AGY_IDLE_CONNECTION_TIMEOUT_MS + 10_000)
    expect(pool.occupiedProcessSlotCount).toBe(16)
    expect(conns.every((c) => c.isOpen)).toBe(true)

    // 17th acquire blocks at capacity because all 16 have active owners/listeners.
    let acquired17 = false
    const acquire17 = pool
      .acquire({
        cwd: dirs[16]!,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-pin-16',
      })
      .then((lease) => {
        acquired17 = true
        return lease
      })
    await vi.advanceTimersByTimeAsync(200)
    expect(acquired17).toBe(false)

    // Unregistering the last owner on slot 0 MUST immediately wake acquire17 and evict slot 0!
    unregisters[0]!()
    const lease17 = await acquire17
    expect(acquired17).toBe(true)
    expect(conns[0]!.isOpen).toBe(false)
    expect(spawnCount).toBe(17)

    // Also verify unregistering the last background listener re-arms the 5-minute idle timer.
    unregisters[1]!()
    await vi.advanceTimersByTimeAsync(AGY_IDLE_CONNECTION_TIMEOUT_MS + 10)
    expect(conns[1]!.isOpen).toBe(false)

    lease17.release()
    for (const unreg of unregisters.slice(2)) unreg()
    await pool.dispose()
  })

  it('uses event-driven whenReleased without 25ms interval polling on quarantined Windows owners and bounds POSIX release probing to active waiters', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-no-poll-'))
    tempDirs.push(root)
    const dirWin = join(root, 'win-quarantine')
    const dirPosix = join(root, 'posix-quarantine')
    await Promise.all([mkdir(dirWin, { recursive: true }), mkdir(dirPosix, { recursive: true })])
    const canonWin = await realpath(dirWin)

    let winProbeCalls = 0
    let posixProbeCalls = 0
    let posixReleased = false
    const neverResolvingWinGate = Promise.withResolvers<void>()
    let posixFake!: ReturnType<typeof fakeAcpChild>

    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory(canonicalCwd) {
        const fake = fakeAcpChild()
        if (canonicalCwd === canonWin) {
          return {
            child: fake.child,
            isOwnedGroup: true,
            close: async () => {
              fake.emitExitOnly(1, null)
              fake.emitCloseOnly(1, null)
              throw Object.assign(new Error('Windows verify permanently failed'), {
                code: 'unconfirmed_process',
                retryable: true,
              })
            },
            isReleased: () => {
              winProbeCalls += 1
              return false
            },
            whenReleased: () => neverResolvingWinGate.promise,
            needsReleaseProbe: false,
          }
        }
        posixFake = fake
        return {
          child: fake.child,
          isOwnedGroup: true,
          close: async () => {
            fake.emitExitOnly(0, 'SIGTERM')
            fake.emitCloseOnly(0, 'SIGTERM')
            throw Object.assign(new Error('POSIX group still alive'), {
              code: 'unconfirmed_process',
              retryable: true,
            })
          },
          isReleased: () => {
            posixProbeCalls += 1
            return posixReleased
          },
          needsReleaseProbe: true,
        }
      },
    })

    const winLease = await pool.acquire({
      cwd: dirWin,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-win-q',
    })
    await expect(winLease.connection.close(new Error('close win'))).rejects.toThrow(
      /Windows verify permanently failed/u,
    )
    winLease.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.unconfirmedClosingCount).toBe(1)
    const winCallsAfterQuarantine = winProbeCalls

    // Advance 2 seconds: quarantined Windows owner MUST NOT run any 25ms interval polling!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(winProbeCalls).toBe(winCallsAfterQuarantine)
    expect(vi.getTimerCount()).toBe(0)
    expect(pool.occupiedProcessSlotCount).toBe(1)

    // Quarantine a POSIX owner too: while idle (no active capacity/shutdown waiters), ZERO polling timers run!
    const posixLease = await pool.acquire({
      cwd: dirPosix,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-posix-q',
    })
    await expect(posixLease.connection.close(new Error('close posix'))).rejects.toThrow(
      /POSIX group still alive/u,
    )
    posixLease.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.unconfirmedClosingCount).toBe(2)
    const posixCallsIdleStart = posixProbeCalls
    await vi.advanceTimersByTimeAsync(2_000)
    expect(posixProbeCalls).toBe(posixCallsIdleStart)
    expect(vi.getTimerCount()).toBe(0)

    // Once POSIX group actually exits, on-demand dispose recheck clears its slot while Windows slot stays quarantined cleanly.
    posixReleased = true
    expect(posixFake.child.exitCode).toBe(0)
    const disposeErr = await pool.dispose(Date.now() + 100).catch((error: unknown) => error)
    expect(disposeErr).toBeInstanceOf(Error)
    expect(pool.unconfirmedClosingCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains abandon() server-request cancellations sequentially under backpressure and closes/retires cleanly when memory capacity is exhausted', async () => {
    // 1. Sequential backpressure succeeds when remaining memory fits 1 cancel frame (~256 KiB) at a time
    //    even though simultaneous enqueueing of 6 cancels (~1.5 MiB) would exceed the 128 MiB cap.
    const fake1 = fakeAcpChild()
    const conn1 = new AgyAcpConnection(fake1.child, '/tmp/proj-abandon-bp', 'standard')
    const stream1 = conn1.openSessionStream('sid-bp', { ordered: true })
    const batchChunk =
      Array.from({ length: 6 }, (_, idx) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: `perm-bp-${idx}`,
          method: 'session/request_permission',
          params: { sessionId: 'sid-bp', toolCall: { toolCallId: `tc-${idx}` } },
        }),
      ).join('\n') + '\n'
    fake1.sendRaw(batchChunk)
    await vi.waitFor(() => {
      expect(conn1.diagnostics().queuedMessages).toBe(6)
    })

    // Hold almost all of the 128 MiB working memory, leaving room for ~1 outbound frame (512 KiB).
    const headroom = 512 * 1024
    const held1 = conn1.reserveWorkingMemory(
      NATIVE_OWNER_WORKING_BYTES - conn1.workingMemoryBytes - headroom,
    )
    stream1.abandon()
    await vi.waitFor(() => {
      for (let idx = 0; idx < 6; idx += 1) {
        expect(fake1.receivedFrames).toContainEqual({
          jsonrpc: '2.0',
          id: `perm-bp-${idx}`,
          result: { outcome: { outcome: 'cancelled' } },
        })
      }
    })
    expect(conn1.isOpen).toBe(true)
    held1.release()
    await conn1.close(new Error('done'))

    // 2. When memory is exhausted so even 1 cancel cannot be enqueued, abandon() triggers idempotent close & physical retirement.
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-abandon-oom-'))
    tempDirs.push(root)
    const pool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      processFactory() {
        return fakeAcpChild().child
      },
    })
    const lease = await pool.acquire({
      cwd: root,
      permissionScope: 'standard',
      permissionMode: 'ask',
      sessionId: 'sess-abandon-oom',
    })
    const conn2 = lease.connection
    const stream2 = conn2.openSessionStream('sid-oom', { ordered: true })
    // Queue 2 unconsumed server requests via the child's stdout.
    const child2 = Reflect.get(conn2, 'child') as ChildProcessWithoutNullStreams
    child2.stdout.emit(
      'data',
      Buffer.from(
        [
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-oom-1',
            method: 'session/request_permission',
            params: { sessionId: 'sid-oom', toolCall: { toolCallId: 'tc-oom-1' } },
          }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'elicit-oom-2',
            method: 'elicitation/create',
            params: { sessionId: 'sid-oom', message: 'need input' },
          }),
        ].join('\n') + '\n',
      ),
    )
    await vi.waitFor(() => {
      expect(conn2.diagnostics().queuedMessages).toBe(2)
    })

    // Exhaust working memory so even a single cancel frame (~256 KiB) cannot be reserved.
    const held2 = conn2.reserveWorkingMemory(NATIVE_OWNER_WORKING_BYTES - conn2.workingMemoryBytes)
    stream2.abandon()

    await vi.waitFor(() => {
      expect(conn2.isTainted).toBe(true)
      expect(conn2.isOpen).toBe(false)
    })
    held2.release()
    lease.release()
    await vi.waitFor(() => {
      expect(pool.occupiedProcessSlotCount).toBe(0)
    })
    await pool.dispose()
  })

  it('activates stdout backpressure hysteresis when a serverRequestOwner is backed by an active ordered sessionStream, while keeping unstreamed owners unpaused', async () => {
    const fake = fakeAcpChild()
    const connection = new AgyAcpConnection(fake.child, '/tmp/proj-owner-bp', 'standard')
    const stream = connection.openSessionStream('sid-streamed', { ordered: true })

    // Initially registered with an unstreamed knownSessionId (direct owner) -> stdout stays unpaused even past high-water!
    const owner = connection.registerServerRequestOwner({
      ownerId: 'owner-run-1',
      knownSessionId: 'sid-unstreamed',
      handler: () => true,
    })

    const chunk128KiB = 'b'.repeat(128 * 1024)
    const countToHighWater = Math.ceil(AGY_QUEUE_HIGH_WATER_BYTES / (128 * 1024)) + 1
    for (let i = 0; i < countToHighWater; i += 1) {
      fake.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-streamed', text: chunk128KiB },
      })
    }

    await vi.waitFor(() => {
      expect(connection.diagnostics().queuedInboundBytes).toBeGreaterThanOrEqual(
        AGY_QUEUE_HIGH_WATER_BYTES,
      )
    })
    expect(connection.diagnostics().stdoutPaused).toBe(false)

    // Updating the owner to the active ordered sessionStream switches it off the direct path and pauses stdout!
    owner.updateSessionId('sid-streamed')
    expect(connection.diagnostics().stdoutPaused).toBe(true)

    // Draining queued frames below low-water resumes stdout cleanly.
    while (connection.diagnostics().queuedInboundBytes > AGY_QUEUE_LOW_WATER_BYTES) {
      await stream.nextIngress(1_000)
    }
    await vi.waitFor(() => {
      expect(connection.diagnostics().stdoutPaused).toBe(false)
    })

    // Also verify opening the ordered stream AFTER registering the owner updates stdout pause immediately.
    const lateOwner = connection.registerServerRequestOwner({
      ownerId: 'owner-run-2',
      knownSessionId: 'sid-late-stream',
      handler: () => true,
    })
    // Push queued bytes past high-water again (still unstreamed due to lateOwner) -> stdout remains unpaused.
    for (let i = 0; i < countToHighWater; i += 1) {
      fake.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sid-streamed', text: chunk128KiB },
      })
    }
    await vi.waitFor(() => {
      expect(connection.diagnostics().queuedInboundBytes).toBeGreaterThanOrEqual(
        AGY_QUEUE_HIGH_WATER_BYTES,
      )
    })
    expect(connection.diagnostics().stdoutPaused).toBe(false)

    const lateStream = connection.openSessionStream('sid-late-stream', { ordered: true })
    expect(connection.diagnostics().stdoutPaused).toBe(true)

    while (connection.diagnostics().queuedInboundBytes > AGY_QUEUE_LOW_WATER_BYTES) {
      const shifted = stream.shift()
      if (!shifted) break
    }
    await vi.waitFor(() => {
      expect(connection.diagnostics().stdoutPaused).toBe(false)
    })

    lateOwner.dispose()
    owner.dispose()
    lateStream.abandon()
    stream.abandon()
    await connection.close(new Error('done'))
  })

  it('forwards --gemini-dir from ANTIGRAVITY_GEMINI_DIR or explicit options.geminiDir, leaks zero slots on invalid paths, and validates POSIX and Windows .cmd spawn arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-gemini-flag-'))
    tempDirs.push(root)
    const projectDir = join(root, 'proj')
    const envGeminiDir = join(root, 'env-gemini-home')
    const explicitGeminiDir = join(root, 'explicit-gemini-home')
    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(envGeminiDir, { recursive: true }),
      mkdir(explicitGeminiDir, { recursive: true }),
    ])

    const priorGeminiDir = process.env.ANTIGRAVITY_GEMINI_DIR
    const recordedArgs: string[][] = []
    const createOkPool = (geminiDir?: string) =>
      new AgyAcpConnectionPool({
        executablePath: '/usr/local/bin/agy',
        ...(geminiDir !== undefined ? { geminiDir } : {}),
        processFactory(_cwd, args) {
          recordedArgs.push([...args])
          const fake = fakeAcpChild()
          fake.onRequest((frame) => {
            if (frame.method === 'initialize') {
              fake.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
            }
          })
          return fake.child
        },
      })

    try {
      // 1. Unset or relative ANTIGRAVITY_GEMINI_DIR omits --gemini-dir cleanly.
      delete process.env.ANTIGRAVITY_GEMINI_DIR
      const unsetPool = createOkPool()
      const unsetLease = await unsetPool.acquire({
        cwd: projectDir,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-unset',
      })
      unsetLease.release()
      await unsetPool.dispose()

      process.env.ANTIGRAVITY_GEMINI_DIR = 'relative/gemini'
      const relEnvPool = createOkPool()
      const relEnvLease = await relEnvPool.acquire({
        cwd: projectDir,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-rel-env',
      })
      relEnvLease.release()
      await relEnvPool.dispose()

      // 2. Absolute ANTIGRAVITY_GEMINI_DIR resolves and forwards --gemini-dir.
      process.env.ANTIGRAVITY_GEMINI_DIR = ` ${envGeminiDir}/./nested/.. `
      const absEnvPool = createOkPool()
      const absEnvLease = await absEnvPool.acquire({
        cwd: projectDir,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-abs-env',
      })
      absEnvLease.release()
      await absEnvPool.dispose()

      // 3. Explicit options.geminiDir overrides ANTIGRAVITY_GEMINI_DIR.
      const explicitPool = createOkPool(explicitGeminiDir)
      const explicitLease = await explicitPool.acquire({
        cwd: projectDir,
        permissionScope: 'full',
        permissionMode: 'full',
        sessionId: 'sess-explicit',
      })
      explicitLease.release()
      await explicitPool.dispose()

      expect(recordedArgs).toEqual([
        ['acp', '--process-per-session', '--disable-telemetry'],
        ['acp', '--process-per-session', '--disable-telemetry'],
        ['acp', '--process-per-session', '--disable-telemetry', '--gemini-dir', envGeminiDir],
        [
          'acp',
          '--process-per-session',
          '--disable-telemetry',
          '--gemini-dir',
          explicitGeminiDir,
          '--dangerously-skip-permissions',
        ],
      ])

      // 4. Invalid options.geminiDir rejects with protocol_error and leaks 0 pool slots.
      for (const badDir of [
        'relative/dir',
        '/tmp/bad\npath',
        '/tmp/bad\x00nul',
        '/' + 'a'.repeat(5000),
      ]) {
        const badPool = createOkPool(badDir)
        await expect(
          badPool.acquire({
            cwd: projectDir,
            permissionScope: 'standard',
            permissionMode: 'ask',
            sessionId: 'sess-bad-gemini',
          }),
        ).rejects.toMatchObject({ kind: 'protocol_error' })
        expect(badPool.occupiedProcessSlotCount).toBe(0)
        expect(badPool.activeLeaseCount).toBe(0)
        expect(badPool.poolSnapshot()).toHaveLength(0)
        await badPool.dispose()
      }

      // 5. Control-character or oversized ANTIGRAVITY_GEMINI_DIR fails closed with protocol_error.
      process.env.ANTIGRAVITY_GEMINI_DIR = '/tmp/evil\ngemini'
      const badEnvPool = createOkPool()
      await expect(
        badEnvPool.acquire({
          cwd: projectDir,
          permissionScope: 'standard',
          permissionMode: 'ask',
          sessionId: 'sess-bad-env-ctrl',
        }),
      ).rejects.toMatchObject({ kind: 'protocol_error' })
      expect(badEnvPool.occupiedProcessSlotCount).toBe(0)
      await badEnvPool.dispose()

      process.env.ANTIGRAVITY_GEMINI_DIR = '/' + 'b'.repeat(5000)
      const overEnvPool = createOkPool()
      await expect(
        overEnvPool.acquire({
          cwd: projectDir,
          permissionScope: 'standard',
          permissionMode: 'ask',
          sessionId: 'sess-over-env',
        }),
      ).rejects.toMatchObject({ kind: 'protocol_error' })
      expect(overEnvPool.occupiedProcessSlotCount).toBe(0)
      await overEnvPool.dispose()
    } finally {
      if (priorGeminiDir === undefined) delete process.env.ANTIGRAVITY_GEMINI_DIR
      else process.env.ANTIGRAVITY_GEMINI_DIR = priorGeminiDir
    }

    // 6. Cross-platform spawn validation: POSIX & Windows .cmd quoting + cmd.exe SystemRoot enforcement.
    expect(
      formatAndValidateAgyOwnedSpawnArgs(
        '/usr/local/bin/agy',
        ['acp', '--process-per-session', '--disable-telemetry', '--gemini-dir', envGeminiDir],
        'darwin',
        {},
      ),
    ).toEqual({
      target: '/usr/local/bin/agy',
      spawnArgs: [
        'acp',
        '--process-per-session',
        '--disable-telemetry',
        '--gemini-dir',
        envGeminiDir,
      ],
      isWindowsCommand: false,
    })

    expect(
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\Program Files\\agy-auth-bin\\agy.cmd',
        [
          'acp',
          '--process-per-session',
          '--disable-telemetry',
          '--gemini-dir',
          'C:\\Users\\Alice Smith\\gemini-home',
        ],
        'win32',
        { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Evil\\cmd.exe' },
      ),
    ).toEqual({
      target: 'C:\\Windows\\System32\\cmd.exe',
      spawnArgs: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\agy-auth-bin\\agy.cmd" acp --process-per-session --disable-telemetry --gemini-dir "C:\\Users\\Alice Smith\\gemini-home""',
      ],
      isWindowsCommand: true,
    })

    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy&calc.cmd',
        ['acp', '--process-per-session', '--disable-telemetry'],
        'win32',
        { SystemRoot: 'C:\\Windows' },
      ),
    ).toThrow(/Unsafe Antigravity executable path/u)

    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy.cmd',
        ['acp', '--process-per-session', '--disable-telemetry', '--gemini-dir', 'C:\\tmp\\a&calc'],
        'win32',
        { SystemRoot: 'C:\\Windows' },
      ),
    ).toThrow(/Unsafe Antigravity storage path/u)

    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy.cmd',
        ['acp', '--process-per-session', '--disable-telemetry', '--unexpected', 'value'],
        'win32',
        { SystemRoot: 'C:\\Windows' },
      ),
    ).toThrow(/Unsafe Antigravity launch arguments/u)

    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy.cmd',
        ['acp', '--process-per-session', '--disable-telemetry'],
        'win32',
        { ComSpec: 'C:\\Evil\\cmd.exe' },
      ),
    ).toThrow(/Trusted Windows command interpreter could not be confirmed/u)

    // 7. Cross-platform geminiDir syntax rejection & Windows cmd.exe disk-identity enforcement.
    expect(isSafeAbsoluteAgyGeminiDir('/Users/alice/.gemini', 'darwin')).toBe(true)
    expect(isSafeAbsoluteAgyGeminiDir('C:\\Users\\Alice\\.gemini', 'darwin')).toBe(false)
    expect(isSafeAbsoluteAgyGeminiDir('C:\\Users\\Alice\\.gemini', 'linux')).toBe(false)
    expect(isSafeAbsoluteAgyGeminiDir('C:\\Users\\Alice\\.gemini', 'win32')).toBe(true)
    expect(isSafeAbsoluteAgyGeminiDir('/Users/alice/.gemini', 'win32')).toBe(false)

    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        '/usr/local/bin/agy',
        [
          'acp',
          '--process-per-session',
          '--disable-telemetry',
          '--gemini-dir',
          'C:\\bad\\on\\posix',
        ],
        'darwin',
        {},
      ),
    ).toThrow(/Unsafe Antigravity launch arguments/u)
    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy.exe',
        [
          'acp',
          '--process-per-session',
          '--disable-telemetry',
          '--gemini-dir',
          '/posix/on/windows',
        ],
        'win32',
        {},
      ),
    ).toThrow(/Unsafe Antigravity launch arguments/u)
    expect(() =>
      formatAndValidateAgyOwnedSpawnArgs(
        'C:\\bin\\agy.cmd',
        ['acp', '--process-per-session', '--disable-telemetry'],
        'win32',
        { SystemRoot: 'C:\\Windows' },
        {
          lstat: () => {
            throw new Error('simulated symlink/missing SystemRoot')
          },
        },
      ),
    ).toThrow(/Trusted Windows command interpreter could not be confirmed/u)

    const crossPlatformPool = new AgyAcpConnectionPool({
      executablePath: '/usr/local/bin/agy',
      geminiDir: 'C:\\windows-style-on-posix',
      processFactory: () => {
        throw new Error('should not spawn on invalid platform geminiDir')
      },
    })
    await expect(
      crossPlatformPool.acquire({
        cwd: projectDir,
        permissionScope: 'standard',
        permissionMode: 'ask',
        sessionId: 'sess-cross-platform',
      }),
    ).rejects.toMatchObject({ kind: 'protocol_error' })
    expect(crossPlatformPool.occupiedProcessSlotCount).toBe(0)
    expect(crossPlatformPool.activeLeaseCount).toBe(0)
    await crossPlatformPool.dispose()
  })
})
