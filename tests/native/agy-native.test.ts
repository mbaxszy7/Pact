import type { Socket } from 'node:net'

import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import {
  agyRebuildInitializationWitnessSchema,
  nativeForkBoundarySchema,
  nativeForkWitnessSchema,
  type NativeContextRebuildChunk,
} from '../../packages/contracts/src/index.js'
import { writeWindowsNodeLauncher } from '../e2e/windows-cli-launcher.js'
import {
  buildAdapters,
  cleanupNativeFixture,
  copyIsolatedAgyAuthConfig,
  desktopRoot,
  executable,
  hash,
  isolatedAgyAllowlistEnv,
  isUnsafeWindowsCmdPath,
  ownedRoot,
  parseSupportedAgySemver,
  requireExplicitAgyAuthDir,
  verifyAgyMinimumVersion,
  type AdapterBundle,
  type ForkInput,
  type Witness,
} from './native-harness.js'

interface SqliteStatement {
  all: (...params: unknown[]) => Array<Record<string, unknown>>
  get: (...params: unknown[]) => Record<string, unknown> | undefined
  run: (...params: unknown[]) => { changes: number }
}

interface SqliteDb {
  pragma: (sql: string) => unknown
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

type SqliteConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDb

const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Trusted desktop better-sqlite3 constructor for read-only/isolated fixture assertions.
const SqliteDatabase = desktopRequire('better-sqlite3') as SqliteConstructor

interface AgyStorageExports {
  CORTEX_STEP_TYPE_USER_INPUT: number
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: number
  CORTEX_STEP_STATUS_DONE: number
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL: number
  encodeCortexStepMetadata: (input: {
    createdAtSeconds: bigint
    createdAtNanos?: number
    source: number
    executionId: string
    trajectoryId: string
    stepIndex: number
    cascadeId: string
    stepId: string
  }) => Buffer
  encodeAgyUserInputStep: (input: {
    metadata: Buffer
    text: string
    clientMessageId?: string
  }) => Buffer
  encodeAgyPlannerResponseStep: (input: { metadata: Buffer; response: string }) => Buffer
  encodeExecutorMetadata: (input: {
    terminationReason: number
    numGeneratorInvocations: number
    lastStepIdx: number
    executionId: string
  }) => Buffer
  encodeProtobufFields: (fields: readonly unknown[]) => Buffer
  encodeStringField: (fieldNumber: number, text: string) => unknown
  encodeVarintField: (fieldNumber: number, value: bigint | number) => unknown
  encodeBytesField: (fieldNumber: number, payload: Buffer) => unknown
  decodeAgyStep: (buffer: Buffer) => {
    type: number
    status: number
    metadata?: {
      executionId?: string
      stepId?: string
      sourceTrajectoryStepInfo?: {
        trajectoryId?: string
        stepIndex?: number
        cascadeId?: string
      }
    }
    userInput?: { text: string }
    plannerResponse?: { canonicalText: string }
  }
}

interface ZeroTurnLoopbackGuard {
  readonly url: string
  readonly requestCount: number
  close: () => Promise<void>
}

async function createZeroTurnLoopbackGuard(): Promise<ZeroTurnLoopbackGuard> {
  let count = 0
  const sockets = new Set<Socket>()
  const server = createServer((_req, res) => {
    count += 1
    res.writeHead(500, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: { message: 'Zero-turn native fixture forbids model calls.' } }))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Zero-turn loopback guard did not bind an IPv4 port.')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return count
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

function isolatedAgyEnv(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  guardUrl: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...isolatedAgyAllowlistEnv(owned.root, sourceEnv),
    GEMINI_API_KEY: 'OWNED_LOOPBACK_ONLY',
    GOOGLE_GEMINI_BASE_URL: guardUrl,
  }
}

async function runAllCleanupSteps(steps: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
  let firstError: unknown
  for (const step of steps) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Cleanup steps execute in deterministic order even if an earlier step rejects.
      await step()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) {
    throw firstError
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function assertConversationsDirHygiene(conversationsDir: string): Promise<void> {
  const entries = await readdir(conversationsDir)
  for (const entry of entries) {
    expect(entry).toMatch(/^[0-9a-f-]+\.db(?:-wal|-shm)?$/iu)
  }
}

async function withTempReadonlySqlite<T>(
  dbPath: string,
  scratchParent: string,
  readFn: (db: SqliteDb) => T,
): Promise<T> {
  const snapshotDir = await mkdtemp(join(scratchParent, 'sqlite-ro-'))
  try {
    const copiedDbPath = join(snapshotDir, 'snapshot.db')
    await copyFile(dbPath, copiedDbPath)
    for (const suffix of ['-wal', '-shm']) {
      // oxlint-disable-next-line no-await-in-loop -- Copy optional SQLite sidecars sequentially before opening read-only.
      if (await pathExists(`${dbPath}${suffix}`)) {
        // oxlint-disable-next-line no-await-in-loop -- Bounded SQLite sidecar copy.
        await copyFile(`${dbPath}${suffix}`, `${copiedDbPath}${suffix}`)
      }
    }
    const db = new SqliteDatabase(copiedDbPath, { readonly: true, fileMustExist: true })
    try {
      return readFn(db)
    } finally {
      db.close()
    }
  } finally {
    await rm(snapshotDir, { recursive: true, force: true })
  }
}

let bundle: AdapterBundle
let buildOwned: Awaited<ReturnType<typeof ownedRoot>> | undefined
let agyExecutable: string
let fixtureOwnersReleased = true

async function finishFixture(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  options: Parameters<typeof cleanupNativeFixture>[1] = {},
): Promise<void> {
  try {
    await cleanupNativeFixture(owned, options)
  } catch (error) {
    fixtureOwnersReleased = false
    throw error
  }
}

async function bootstrapIsolatedAgyAuth(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
): Promise<object> {
  const signal = AbortSignal.timeout(15_000)
  const spawned = await owned.processes.spawnOwnedAsync(
    agyExecutable,
    ['acp', '--process-per-session', '--disable-telemetry'],
    { cwd: owned.cwd, env, shell: false, windowsHide: true },
    deadlineAt,
  )
  const connection = new bundle.AgyAcpConnection(
    spawned.child,
    owned.cwd,
    'standard',
    undefined,
    () => spawned.close(),
  )
  try {
    const initReply = await connection.request(
      'initialize',
      {
        protocolVersion: 1,
        capabilities: { elicitation: { form: {} } },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
        clientInfo: { name: 'pact', title: 'Pact Native Gate', version: '0.4.0' },
      },
      { timeoutMs: 10_000, signal },
    )
    expect(Reflect.get(initReply, 'error')).toBeUndefined()
    const initResult: unknown = Reflect.get(initReply, 'result')
    if (!initResult || typeof initResult !== 'object') {
      throw new Error('Antigravity ACP initialize did not return an object.')
    }

    const authReply = await connection.request(
      'authenticate',
      { methodId: 'gemini-api-key' },
      { timeoutMs: 10_000, signal },
    )
    expect(Reflect.get(authReply, 'error')).toBeUndefined()
    return initResult
  } finally {
    await connection.close(new Error('Bootstrap isolated Antigravity auth completed.'))
  }
}

async function allocateRealZeroTurnSessionShell(
  pool: InstanceType<AdapterBundle['AgyAcpConnectionPool']>,
  cwd: string,
  signal: AbortSignal,
): Promise<{ sessionId: string; canonicalCwd: string }> {
  const lease = await pool.acquire({
    cwd,
    permissionScope: 'standard',
    permissionMode: 'ask',
    readOnly: true,
    signal,
  })
  try {
    await lease.ensureInitialized(signal)
    const created = await lease.connection.request(
      'session/new',
      { cwd: lease.canonicalCwd, mcpServers: [] },
      { timeoutMs: 15_000, signal },
    )
    expect(Reflect.get(created, 'error')).toBeUndefined()
    const resultObj: unknown = Reflect.get(created, 'result')
    if (!resultObj || typeof resultObj !== 'object') {
      throw new Error('Real agy session/new did not return a result object.')
    }
    const sessionId = Reflect.get(resultObj, 'sessionId')
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Real agy session/new did not return a sessionId.')
    }
    const closed = await lease.connection.request(
      'session/close',
      { sessionId },
      { timeoutMs: 15_000, signal },
    )
    expect(Reflect.get(closed, 'error')).toBeUndefined()
    return { sessionId, canonicalCwd: lease.canonicalCwd }
  } finally {
    await lease.disposeIfIdle()
  }
}

beforeAll(async () => {
  const setupDeadlineAt = performance.now() + 60_000
  const owned = await ownedRoot()
  buildOwned = owned
  agyExecutable = await executable('agy', owned, setupDeadlineAt)
  bundle = await buildAdapters(owned.root)
}, 60_000)

afterAll(async () => {
  if (!fixtureOwnersReleased) {
    throw new Error('Native adapter bundle retained while fixture cleanup is unconfirmed')
  }
  if (buildOwned) await finishFixture(buildOwned)
})

it('completes ACP initialize (clientInfo), zero-Turn session/new + session/load + session/close, and non-empty TrajectorySummary SQLite creation without model calls', async () => {
  vi.stubEnv('PACT_HOST_ENV_SENTINEL', 'DO_NOT_LEAK')
  const owned = await ownedRoot()
  const guard = await createZeroTurnLoopbackGuard()
  let pool: InstanceType<AdapterBundle['AgyAcpConnectionPool']> | undefined
  const observedSentinelLeaks: boolean[] = []
  try {
    const deadlineAt = performance.now() + 45_000
    const env = isolatedAgyEnv(owned, guard.url, process.env)
    expect(env['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
    const signal = AbortSignal.timeout(20_000)

    const bootstrapInit = await bootstrapIsolatedAgyAuth(owned, env, deadlineAt)
    expect(Reflect.get(bootstrapInit, 'protocolVersion')).toBe(1)

    pool = new bundle.AgyAcpConnectionPool({
      executablePath: agyExecutable,
      clientInfo: { name: 'pact', title: 'Pact Native Gate', version: '0.4.0' },
      processFactory: (
        canonicalCwd: string,
        args: readonly string[],
        _scope: 'standard' | 'full',
      ) => {
        observedSentinelLeaks.push(Object.hasOwn(env, 'PACT_HOST_ENV_SENTINEL'))
        return owned.processes.spawnOwnedAsync(
          agyExecutable,
          args,
          { cwd: canonicalCwd, env, shell: false, windowsHide: true },
          deadlineAt,
        )
      },
    })

    const lease = await pool.acquire({
      cwd: owned.cwd,
      permissionScope: 'standard',
      permissionMode: 'ask',
      readOnly: true,
      signal,
    })
    let sessionId = ''
    try {
      const initResult = await lease.ensureInitialized(signal)
      expect(Reflect.get(initResult, 'protocolVersion')).toBe(1)
      const agentInfo: unknown = Reflect.get(initResult, 'agentInfo')
      expect(agentInfo && typeof agentInfo === 'object').toBe(true)

      const newReply = await lease.connection.request(
        'session/new',
        { cwd: lease.canonicalCwd, mcpServers: [] },
        { timeoutMs: 15_000, signal },
      )
      expect(Reflect.get(newReply, 'error')).toBeUndefined()
      const newResult: unknown = Reflect.get(newReply, 'result')
      expect(newResult && typeof newResult === 'object').toBe(true)
      const createdId: unknown =
        newResult && typeof newResult === 'object' ? Reflect.get(newResult, 'sessionId') : undefined
      expect(typeof createdId).toBe('string')
      sessionId = String(createdId)
      expect(sessionId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)

      const closeFirst = await lease.connection.request(
        'session/close',
        { sessionId },
        { timeoutMs: 15_000, signal },
      )
      expect(Reflect.get(closeFirst, 'error')).toBeUndefined()

      const stream = lease.connection.openSessionStream(sessionId)
      try {
        const loadReply = await lease.connection.request(
          'session/load',
          { sessionId, cwd: lease.canonicalCwd, mcpServers: [] },
          { timeoutMs: 15_000, signal },
        )
        expect(Reflect.get(loadReply, 'error')).toBeUndefined()
        while (stream.shift()) {
          /* Drain zero-turn replay metadata notifications. */
        }
        const closeLoaded = await lease.connection.request(
          'session/close',
          { sessionId },
          { timeoutMs: 15_000, signal },
        )
        expect(Reflect.get(closeLoaded, 'error')).toBeUndefined()
      } finally {
        stream.close()
      }
    } finally {
      await lease.disposeIfIdle()
    }

    const agyRoot = join(owned.root, '.gemini', 'antigravity-cli')
    const sessionDbPath = join(agyRoot, 'conversations', `${sessionId}.db`)
    const summariesDbPath = join(agyRoot, 'conversation_summaries.db')

    const trajectoryFacts = await withTempReadonlySqlite(sessionDbPath, owned.root, (db) => {
      const meta = db
        .prepare('SELECT trajectory_id, cascade_id FROM "trajectory_meta" LIMIT 2')
        .all()
      const steps = db.prepare('SELECT COUNT(*) AS count FROM "steps"').get()
      return {
        metaCount: meta.length,
        cascadeId: meta[0]?.['cascade_id'],
        trajectoryId: meta[0]?.['trajectory_id'],
        stepCount: Number(steps?.['count'] ?? -1),
      }
    })
    expect(trajectoryFacts.metaCount).toBe(1)
    expect(trajectoryFacts.cascadeId).toBe(sessionId)
    expect(typeof trajectoryFacts.trajectoryId).toBe('string')
    expect(trajectoryFacts.stepCount).toBe(0)

    const summaryFacts = await withTempReadonlySqlite(summariesDbPath, owned.root, (db) => {
      const cols = db
        .prepare('PRAGMA table_info("conversation_summaries")')
        .all()
        .map((row) => String(row['name']))
      const blobCol = cols.find((col) =>
        ['raw_summary', 'summary', 'data', 'trajectory_summary'].includes(col),
      )
      const row = db
        .prepare('SELECT * FROM "conversation_summaries" WHERE "conversation_id" = ?')
        .get(sessionId)
      const rawBlob = blobCol && row ? row[blobCol] : undefined
      return {
        found: Boolean(row),
        stepCount: Number(row?.['step_count'] ?? -1),
        blobBytes: Buffer.isBuffer(rawBlob) ? rawBlob.byteLength : 0,
      }
    })
    expect(summaryFacts.found).toBe(true)
    expect(summaryFacts.stepCount).toBe(0)
    expect(summaryFacts.blobBytes).toBeGreaterThan(0)
    expect(observedSentinelLeaks).toEqual([false])
    expect(guard.requestCount).toBe(0)
  } finally {
    await runAllCleanupSteps([
      async () => {
        vi.unstubAllEnvs()
      },
      async () => pool?.dispose(),
      async () => guard.close(),
      async () => finishFixture(owned),
    ])
  }
})

it('verifies production AgyAgentAdapter zero-Turn Rebuild seed and cold-load verification receipt (negative and positive)', async () => {
  vi.stubEnv('PACT_HOST_ENV_SENTINEL', 'DO_NOT_LEAK')
  const owned = await ownedRoot()
  const guard = await createZeroTurnLoopbackGuard()
  let forkFiles: InstanceType<AdapterBundle['NativeForkFiles']> | undefined
  let shellPool: InstanceType<AdapterBundle['AgyAcpConnectionPool']> | undefined
  const adaptersToDispose: Array<{ dispose: () => Promise<void> }> = []
  try {
    const deadlineAt = performance.now() + 50_000
    const env = isolatedAgyEnv(owned, guard.url, process.env)
    expect(env['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
    const signal = AbortSignal.timeout(25_000)
    await bootstrapIsolatedAgyAuth(owned, env, deadlineAt)

    const agyAppDataDir = join(owned.root, '.gemini', 'antigravity-cli')
    const nativeIdentity = bundle.getAgySqliteFileModuleIdentity()
    expect(nativeIdentity).toMatchObject({
      version: 1,
      platform: process.platform,
      architecture: process.arch,
    })
    expect(nativeIdentity.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
    const childStatsBefore = bundle.getNodeAgyStorageChildStatsForTesting()
    forkFiles = new bundle.NativeForkFiles()
    const storageClient = bundle.createAgyNativeStorageClient(forkFiles, agyAppDataDir)

    const processFactory = (
      canonicalCwd: string,
      args: readonly string[],
      _scope: 'standard' | 'full',
    ) => {
      expect(env['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
      return owned.processes.spawnOwnedAsync(
        agyExecutable,
        args,
        { cwd: canonicalCwd, env, shell: false, windowsHide: true },
        deadlineAt,
      )
    }

    shellPool = new bundle.AgyAcpConnectionPool({
      executablePath: agyExecutable,
      clientInfo: { name: 'pact', title: 'Pact Native Gate', version: '0.4.0' },
      processFactory,
    })

    const rebuildChunks: NativeContextRebuildChunk[] = [
      {
        kind: 'message',
        messageId: randomUUID(),
        sequence: 1,
        speaker: 'user',
        state: 'complete',
        part: 0,
        final: true,
        content: 'Keep AGY_NATIVE_REBUILD_USER_FACT across zero-turn rebuild.',
      },
      {
        kind: 'message',
        messageId: randomUUID(),
        sequence: 2,
        speaker: 'claude',
        state: 'complete',
        part: 0,
        final: true,
        content: 'Peer context AGY_NATIVE_REBUILD_PEER_FACT confirmed.',
      },
    ]
    const sourceHash = hash(JSON.stringify(rebuildChunks))
    const chunkStream = async function* (): AsyncIterable<NativeContextRebuildChunk> {
      yield* rebuildChunks
    }

    // 1. Negative check: writeRebuildSeed alone (without cold session/load + confirmRebuildColdLoad)
    // must NOT create .pact-rebuild-verified-v1.json and MUST fail cold inspectRebuildSeed!
    const { sessionId: unverifiedSid, canonicalCwd } = await allocateRealZeroTurnSessionShell(
      shellPool,
      owned.cwd,
      signal,
    )
    const writtenOnly = await storageClient.writeRebuildSeed(
      {
        appDataDir: agyAppDataDir,
        cwd: canonicalCwd,
        candidateSessionId: unverifiedSid,
        sourceHash,
        chunks: (async function* () {
          for (const chunk of rebuildChunks) yield { chunk }
        })(),
      },
      signal,
    )
    expect(writtenOnly.stepCount).toBe(2)

    const unverifiedReceiptPath = join(
      agyAppDataDir,
      'brain',
      unverifiedSid,
      '.pact-rebuild-verified-v1.json',
    )
    expect(await pathExists(unverifiedReceiptPath)).toBe(false)

    const inspectedBeforeConfirm = await storageClient.inspectRebuildSeed(
      {
        appDataDir: agyAppDataDir,
        cwd: canonicalCwd,
        nativeSessionId: unverifiedSid,
        sourceHash,
        chunks: chunkStream(),
      },
      signal,
    )
    expect(inspectedBeforeConfirm.verified).toBe(false)

    expect(typeof storageClient.confirmRebuildColdLoad).toBe('function')
    expect(typeof writtenOnly.pbSha256).toBe('string')
    expect(typeof writtenOnly.pbBytes).toBe('number')
    const confirmedWitness = await storageClient.confirmRebuildColdLoad!(
      {
        cwd: canonicalCwd,
        appDataDir: agyAppDataDir,
        nativeSessionId: unverifiedSid,
        sourceHash,
        pbSha256: writtenOnly.pbSha256!,
        pbBytes: writtenOnly.pbBytes!,
        stepCount: 2,
      },
      signal,
    )
    const parsedConfirmed = agyRebuildInitializationWitnessSchema.parse(confirmedWitness)
    expect(parsedConfirmed.nativeSessionId).toBe(unverifiedSid)
    expect(parsedConfirmed.sourceHash).toBe(sourceHash)
    expect(parsedConfirmed.stepCount).toBe(2)
    expect(await pathExists(unverifiedReceiptPath)).toBe(true)

    const inspectedAfterConfirm = await storageClient.inspectRebuildSeed(
      {
        appDataDir: agyAppDataDir,
        cwd: canonicalCwd,
        nativeSessionId: unverifiedSid,
        sourceHash,
        chunks: chunkStream(),
      },
      signal,
    )
    expect(inspectedAfterConfirm.verified).toBe(true)

    const inspectedWrongSource = await storageClient.inspectRebuildSeed(
      {
        appDataDir: agyAppDataDir,
        cwd: canonicalCwd,
        nativeSessionId: unverifiedSid,
        sourceHash: hash('mismatched-source-hash'),
        chunks: chunkStream(),
      },
      signal,
    )
    expect(inspectedWrongSource.verified).toBe(false)

    // 2. Full production AgyAgentAdapter.rebuildNativeContext end-to-end zero-Turn verification:
    const adapter = new bundle.AgyAgentAdapter({
      executablePath: agyExecutable,
      appDataDir: agyAppDataDir,
      processFactory,
      storageClient,
    })
    adaptersToDispose.push(adapter)

    const rebuildId = randomUUID()
    const sessionId = randomUUID()
    const rebuilt = await adapter.rebuildNativeContext(
      {
        rebuildId,
        sessionId,
        cwd: owned.cwd,
        model: null,
        effort: null,
        permissionMode: 'ask',
        sourceHash,
      },
      chunkStream(),
      signal,
    )
    expect(rebuilt.nativeSessionId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
    const parsedWitness = agyRebuildInitializationWitnessSchema.parse(rebuilt.initializationWitness)
    expect(parsedWitness.nativeSessionId).toBe(rebuilt.nativeSessionId)
    expect(parsedWitness.sourceHash).toBe(sourceHash)
    expect(parsedWitness.stepCount).toBe(2)

    const rebuiltReceiptPath = join(
      agyAppDataDir,
      'brain',
      rebuilt.nativeSessionId,
      '.pact-rebuild-verified-v1.json',
    )
    const receiptStat = await lstat(rebuiltReceiptPath)
    expect(receiptStat.isFile()).toBe(true)
    const nonPrivateBits = process.platform === 'win32' ? 0 : receiptStat.mode & 0o077
    expect(nonPrivateBits).toBe(0)

    // Cold adapter instance (no in-memory receipt cache) proves cold readback readiness:
    const coldAdapter = new bundle.AgyAgentAdapter({
      executablePath: agyExecutable,
      appDataDir: agyAppDataDir,
      processFactory,
      storageClient,
    })
    adaptersToDispose.push(coldAdapter)

    const readyProbe = await coldAdapter.probeNativeStatus(
      {
        target: 'initialized_binding',
        sessionId,
        agentId: 'agy',
        requestId: 'probe-rebuild-ready',
        cwd: owned.cwd,
        model: null,
        effort: null,
        nativeSessionId: rebuilt.nativeSessionId,
        bindingGeneration: 2,
        confirmedInitialization: {
          rebuildId,
          sourceHash,
          witness: parsedWitness,
        },
        source: chunkStream(),
      },
      signal,
    )
    expect(readyProbe.kind).toBe('binding_ready')

    // Removing the cold-load verification receipt forces cold readback to fail closed:
    await rm(rebuiltReceiptPath, { force: true })
    const coldAdapterMissingReceipt = new bundle.AgyAgentAdapter({
      executablePath: agyExecutable,
      appDataDir: agyAppDataDir,
      processFactory,
      storageClient,
    })
    adaptersToDispose.push(coldAdapterMissingReceipt)

    const missingReceiptProbe = await coldAdapterMissingReceipt.probeNativeStatus(
      {
        target: 'initialized_binding',
        sessionId,
        agentId: 'agy',
        requestId: 'probe-rebuild-missing-receipt',
        cwd: owned.cwd,
        model: null,
        effort: null,
        nativeSessionId: rebuilt.nativeSessionId,
        bindingGeneration: 2,
        confirmedInitialization: {
          rebuildId,
          sourceHash,
          witness: parsedWitness,
        },
        source: chunkStream(),
      },
      signal,
    )
    expect(missingReceiptProbe.kind).toBe('no_evidence')
    expect(guard.requestCount).toBe(0)
    await assertConversationsDirHygiene(join(agyAppDataDir, 'conversations'))
    const childStatsAfter = bundle.getNodeAgyStorageChildStatsForTesting()
    expect(childStatsAfter.started).toBeGreaterThan(childStatsBefore.started)
    expect(childStatsAfter.lastPid).toBeDefined()
    expect(childStatsAfter.lastPid).not.toBe(process.pid)
    expect(childStatsAfter.live).toBe(0)
  } finally {
    await runAllCleanupSteps([
      async () => {
        vi.unstubAllEnvs()
      },
      async () => shellPool?.dispose(),
      async () => forkFiles?.dispose(),
      async () => guard.close(),
      async () => finishFixture(owned, { adapters: adaptersToDispose }),
    ])
  }
})

it('prepares and executes an execution_id-closed SQLite Fork boundary with cold session/load verification and post-cut exclusion', async () => {
  vi.stubEnv('PACT_HOST_ENV_SENTINEL', 'DO_NOT_LEAK')
  const owned = await ownedRoot()
  const guard = await createZeroTurnLoopbackGuard()
  let forkFiles: InstanceType<AdapterBundle['NativeForkFiles']> | undefined
  let shellPool: InstanceType<AdapterBundle['AgyAcpConnectionPool']> | undefined
  const adaptersToDispose: Array<{ dispose: () => Promise<void> }> = []
  try {
    const deadlineAt = performance.now() + 50_000
    const env = isolatedAgyEnv(owned, guard.url, process.env)
    expect(env['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
    const signal = AbortSignal.timeout(25_000)
    await bootstrapIsolatedAgyAuth(owned, env, deadlineAt)

    const agyAppDataDir = join(owned.root, '.gemini', 'antigravity-cli')
    const nativeIdentity = bundle.getAgySqliteFileModuleIdentity()
    expect(nativeIdentity).toMatchObject({
      version: 1,
      platform: process.platform,
      architecture: process.arch,
    })
    expect(nativeIdentity.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
    const childStatsBefore = bundle.getNodeAgyStorageChildStatsForTesting()
    forkFiles = new bundle.NativeForkFiles()
    const storageClient = bundle.createAgyNativeStorageClient(forkFiles, agyAppDataDir)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Production storage helpers exported from buildAdapters.
    const storage = bundle.agyNativeStorage as unknown as AgyStorageExports

    const processFactory = (
      canonicalCwd: string,
      args: readonly string[],
      _scope: 'standard' | 'full',
    ) => {
      expect(env['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
      return owned.processes.spawnOwnedAsync(
        agyExecutable,
        args,
        { cwd: canonicalCwd, env, shell: false, windowsHide: true },
        deadlineAt,
      )
    }

    shellPool = new bundle.AgyAcpConnectionPool({
      executablePath: agyExecutable,
      clientInfo: { name: 'pact', title: 'Pact Native Gate', version: '0.4.0' },
      processFactory,
    })

    const { sessionId: sourceSid, canonicalCwd } = await allocateRealZeroTurnSessionShell(
      shellPool,
      owned.cwd,
      signal,
    )

    const sourceDbPath = join(agyAppDataDir, 'conversations', `${sourceSid}.db`)
    const summariesDbPath = join(agyAppDataDir, 'conversation_summaries.db')

    const execId1 = randomUUID()
    const execId2 = randomUUID()
    const userStepId1 = randomUUID()
    const assistantStepId1 = randomUUID()
    const userStepId2 = randomUUID()
    const assistantStepId2 = randomUUID()
    const turn1Prompt = 'Inspect AGY_FORK_PREFIX_PROMPT_OK.'
    const turn1Answer = 'Verified AGY_FORK_PREFIX_ANSWER_OK.'
    const turn2Prompt = 'Mutate AGY_FORK_POST_CUT_PROMPT_EXCLUDED.'
    const turn2Answer = 'Post-cut AGY_FORK_POST_CUT_ANSWER_EXCLUDED.'

    let sourceTrajectoryId = ''
    const sourceDb = new SqliteDatabase(sourceDbPath, { fileMustExist: true })
    try {
      const metaRow = sourceDb.prepare('SELECT trajectory_id FROM "trajectory_meta" LIMIT 1').get()
      const rawSourceTrajectoryId = metaRow?.['trajectory_id']
      sourceTrajectoryId = typeof rawSourceTrajectoryId === 'string' ? rawSourceTrajectoryId : ''
      expect(sourceTrajectoryId.length).toBeGreaterThan(0)

      const stepCols = new Set(
        sourceDb
          .prepare('PRAGMA table_info("steps")')
          .all()
          .map((row) => (typeof row['name'] === 'string' ? row['name'] : '')),
      )
      const payloadCol = stepCols.has('step_payload') ? 'step_payload' : 'data'
      const hasStepFormat = stepCols.has('step_format')
      const hasStepSize = stepCols.has('size')
      const genCols = new Set(
        sourceDb
          .prepare('PRAGMA table_info("gen_metadata")')
          .all()
          .map((row) => (typeof row['name'] === 'string' ? row['name'] : '')),
      )
      const hasGenSize = genCols.has('size')
      const execCols = new Set(
        sourceDb
          .prepare('PRAGMA table_info("executor_metadata")')
          .all()
          .map((row) => (typeof row['name'] === 'string' ? row['name'] : '')),
      )
      const hasExecSize = execCols.has('size')

      const buildGenBlob = (executionId: string, stepIndices: readonly number[]): Buffer => {
        const trajectoryKv = storage.encodeProtobufFields([
          storage.encodeStringField(1, 'trajectory_id'),
          storage.encodeStringField(2, sourceTrajectoryId),
        ])
        const cascadeKv = storage.encodeProtobufFields([
          storage.encodeStringField(1, 'cascade_id'),
          storage.encodeStringField(2, sourceSid),
        ])
        return storage.encodeProtobufFields([
          ...stepIndices.map((idx) => storage.encodeVarintField(2, idx)),
          storage.encodeStringField(4, executionId),
          storage.encodeBytesField(20, trajectoryKv),
          storage.encodeBytesField(20, cascadeKv),
        ])
      }

      const step0Meta = storage.encodeCortexStepMetadata({
        createdAtSeconds: 1_700_000_100n,
        source: 1,
        executionId: execId1,
        trajectoryId: sourceTrajectoryId,
        stepIndex: 0,
        cascadeId: sourceSid,
        stepId: userStepId1,
      })
      const step0Blob = storage.encodeAgyUserInputStep({
        metadata: step0Meta,
        text: turn1Prompt,
        clientMessageId: userStepId1,
      })
      const step1Meta = storage.encodeCortexStepMetadata({
        createdAtSeconds: 1_700_000_101n,
        source: 2,
        executionId: execId1,
        trajectoryId: sourceTrajectoryId,
        stepIndex: 1,
        cascadeId: sourceSid,
        stepId: assistantStepId1,
      })
      const step1Blob = storage.encodeAgyPlannerResponseStep({
        metadata: step1Meta,
        response: turn1Answer,
      })
      const step2Meta = storage.encodeCortexStepMetadata({
        createdAtSeconds: 1_700_000_200n,
        source: 1,
        executionId: execId2,
        trajectoryId: sourceTrajectoryId,
        stepIndex: 2,
        cascadeId: sourceSid,
        stepId: userStepId2,
      })
      const step2Blob = storage.encodeAgyUserInputStep({
        metadata: step2Meta,
        text: turn2Prompt,
        clientMessageId: userStepId2,
      })
      const step3Meta = storage.encodeCortexStepMetadata({
        createdAtSeconds: 1_700_000_201n,
        source: 2,
        executionId: execId2,
        trajectoryId: sourceTrajectoryId,
        stepIndex: 3,
        cascadeId: sourceSid,
        stepId: assistantStepId2,
      })
      const step3Blob = storage.encodeAgyPlannerResponseStep({
        metadata: step3Meta,
        response: turn2Answer,
      })

      const gen0Blob = buildGenBlob(execId1, [0, 1])
      const gen1Blob = buildGenBlob(execId2, [2, 3])
      const exec0Blob = storage.encodeExecutorMetadata({
        terminationReason: storage.EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
        numGeneratorInvocations: 1,
        lastStepIdx: 1,
        executionId: execId1,
      })
      const exec1Blob = storage.encodeExecutorMetadata({
        terminationReason: storage.EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
        numGeneratorInvocations: 1,
        lastStepIdx: 3,
        executionId: execId2,
      })

      const insertStepCols = [
        'idx',
        'step_type',
        'status',
        'has_subtrajectory',
        'metadata',
        payloadCol,
        ...(hasStepFormat ? ['step_format'] : []),
        ...(hasStepSize ? ['size'] : []),
      ]
      const insertStep = sourceDb.prepare(
        `INSERT INTO "steps" (${insertStepCols.map((c) => `"${c}"`).join(', ')}) VALUES (${insertStepCols.map(() => '?').join(', ')})`,
      )
      const insertGenCols = ['idx', 'data', ...(hasGenSize ? ['size'] : [])]
      const insertGen = sourceDb.prepare(
        `INSERT INTO "gen_metadata" (${insertGenCols.map((c) => `"${c}"`).join(', ')}) VALUES (${insertGenCols.map(() => '?').join(', ')})`,
      )
      const insertExecCols = ['idx', 'data', ...(hasExecSize ? ['size'] : [])]
      const insertExec = sourceDb.prepare(
        `INSERT INTO "executor_metadata" (${insertExecCols.map((c) => `"${c}"`).join(', ')}) VALUES (${insertExecCols.map(() => '?').join(', ')})`,
      )

      sourceDb.exec('BEGIN IMMEDIATE')
      for (const [idx, type, meta, blob] of [
        [0, storage.CORTEX_STEP_TYPE_USER_INPUT, step0Meta, step0Blob],
        [1, storage.CORTEX_STEP_TYPE_PLANNER_RESPONSE, step1Meta, step1Blob],
        [2, storage.CORTEX_STEP_TYPE_USER_INPUT, step2Meta, step2Blob],
        [3, storage.CORTEX_STEP_TYPE_PLANNER_RESPONSE, step3Meta, step3Blob],
      ] as const) {
        insertStep.run(
          idx,
          type,
          storage.CORTEX_STEP_STATUS_DONE,
          0,
          meta,
          blob,
          ...(hasStepFormat ? [0] : []),
          ...(hasStepSize ? [blob.byteLength] : []),
        )
      }
      insertGen.run(0, gen0Blob, ...(hasGenSize ? [gen0Blob.byteLength] : []))
      insertGen.run(1, gen1Blob, ...(hasGenSize ? [gen1Blob.byteLength] : []))
      insertExec.run(0, exec0Blob, ...(hasExecSize ? [exec0Blob.byteLength] : []))
      insertExec.run(1, exec1Blob, ...(hasExecSize ? [exec1Blob.byteLength] : []))
      sourceDb.exec('COMMIT')
      sourceDb.pragma('wal_checkpoint(TRUNCATE)')
      sourceDb.pragma('journal_mode = DELETE')
    } finally {
      sourceDb.close()
    }

    const summariesDb = new SqliteDatabase(summariesDbPath, { fileMustExist: true })
    try {
      const cols = summariesDb
        .prepare('PRAGMA table_info("conversation_summaries")')
        .all()
        .map((row) => String(row['name']))
      if (cols.includes('last_user_input_step_index')) {
        summariesDb
          .prepare(
            'UPDATE "conversation_summaries" SET "step_count" = 4, "last_user_input_step_index" = 2 WHERE "conversation_id" = ?',
          )
          .run(sourceSid)
      } else {
        summariesDb
          .prepare(
            'UPDATE "conversation_summaries" SET "step_count" = 4 WHERE "conversation_id" = ?',
          )
          .run(sourceSid)
      }
      summariesDb.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      summariesDb.close()
    }

    const adapter = new bundle.AgyAgentAdapter({
      executablePath: agyExecutable,
      appDataDir: agyAppDataDir,
      processFactory,
      storageClient,
    })
    adaptersToDispose.push(adapter)

    // Prepare execution_id-closed Fork boundary at Turn 1 (excluding Turn 2):
    const boundary = await adapter.prepareNativeFork(
      {
        cwd: canonicalCwd,
        nativeSessionId: sourceSid,
        nativeTurnId: execId1,
        runId: 'pact-run-turn-1',
        bindingGeneration: 1,
        throughSequence: 2,
        deliveryCursor: 0,
        responseHash: hash(turn1Answer),
      },
      signal,
    )
    const parsedBoundary = nativeForkBoundarySchema.parse(boundary)
    expect(parsedBoundary.provider).toBe('agy')
    expect(parsedBoundary.nativeCutId).toBe(execId1)
    expect(parsedBoundary.agyCut?.cutStepIdx).toBe(1)
    expect(parsedBoundary.agyCut?.genMetadataCount).toBe(1)
    expect(parsedBoundary.agyCut?.executorMetadataCount).toBe(1)

    // Wrong responseHash must fail closed:
    await expect(
      adapter.prepareNativeFork(
        {
          cwd: canonicalCwd,
          nativeSessionId: sourceSid,
          nativeTurnId: execId1,
          runId: 'pact-run-turn-1',
          bindingGeneration: 1,
          throughSequence: 2,
          deliveryCursor: 0,
          responseHash: hash('tampered-answer'),
        },
        signal,
      ),
    ).rejects.toThrow(/planner response does not match/iu)

    const candidateRecords: Array<{ id: string; witness?: Witness }> = []
    const baseForkInput: ForkInput = {
      operationId: `fork-op-${randomUUID()}`,
      sessionId: 'pact-child-session-1',
      cwd: canonicalCwd,
      source: boundary,
      model: null,
      effort: null,
      permissionMode: 'ask',
      onDispatched: async () => undefined,
      onCandidate: async (id, witness) => {
        candidateRecords.push({ id, ...(witness ? { witness } : {}) })
      },
      reportNativeWork: () => undefined,
    }

    const forked = await adapter.forkNativeContext(baseForkInput, signal)
    expect(forked.nativeSessionId).not.toBe(sourceSid)
    expect(forked.nativeSessionId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
    const parsedWitness = nativeForkWitnessSchema.parse(forked.witness)
    expect(parsedWitness.provider).toBe('agy')
    expect(parsedWitness.sourceNativeSessionId).toBe(sourceSid)
    expect(parsedWitness.sourceCutId).toBe(execId1)
    expect(parsedWitness.initializedAt).toBeTruthy()
    expect(candidateRecords.length).toBeGreaterThanOrEqual(2)

    const inspected = await adapter.inspectNativeFork(
      {
        ...baseForkInput,
        nativeSessionId: forked.nativeSessionId,
        witness: forked.witness,
      },
      signal,
    )
    expect(inspected.kind).toBe('verified')

    const reinitialized = await adapter.initializeNativeFork(
      {
        ...baseForkInput,
        lastDispatchedPhase: 'initialize',
        nativeSessionId: forked.nativeSessionId,
        witness: forked.witness,
      },
      signal,
    )
    expect(reinitialized.nativeSessionId).toBe(forked.nativeSessionId)

    const childDbPath = join(agyAppDataDir, 'conversations', `${forked.nativeSessionId}.db`)
    const childFacts = await withTempReadonlySqlite(childDbPath, owned.root, (db) => {
      const meta = db
        .prepare('SELECT trajectory_id, cascade_id FROM "trajectory_meta" LIMIT 1')
        .get()
      const stepCols = db
        .prepare('PRAGMA table_info("steps")')
        .all()
        .map((row) => String(row['name']))
      const payloadCol = stepCols.includes('step_payload') ? 'step_payload' : 'data'
      const rows = db
        .prepare(
          `SELECT idx, step_type, status, "${payloadCol}" AS payload FROM "steps" ORDER BY idx ASC`,
        )
        .all()
      const genCount = Number(
        db.prepare('SELECT COUNT(*) AS count FROM "gen_metadata"').get()?.['count'] ?? -1,
      )
      const execCount = Number(
        db.prepare('SELECT COUNT(*) AS count FROM "executor_metadata"').get()?.['count'] ?? -1,
      )
      const decoded = rows.map((row) => {
        const payload = row['payload']
        if (!Buffer.isBuffer(payload)) throw new Error('Child step payload is not a Buffer.')
        return storage.decodeAgyStep(payload)
      })
      const rawTexts = rows.map((row) => {
        const payload = row['payload']
        if (!Buffer.isBuffer(payload)) throw new Error('Child step payload is not a Buffer.')
        return payload.toString('utf8')
      })
      const rawTrajectoryId = meta?.['trajectory_id']
      const rawCascadeId = meta?.['cascade_id']
      return {
        trajectoryId: typeof rawTrajectoryId === 'string' ? rawTrajectoryId : '',
        cascadeId: typeof rawCascadeId === 'string' ? rawCascadeId : '',
        rowCount: rows.length,
        genCount,
        execCount,
        decoded,
        serializedText: rawTexts.join('\n'),
      }
    })

    expect(childFacts.cascadeId).toBe(forked.nativeSessionId)
    expect(childFacts.trajectoryId).not.toBe(sourceTrajectoryId)
    expect(childFacts.rowCount).toBe(2)
    expect(childFacts.genCount).toBe(1)
    expect(childFacts.execCount).toBe(1)
    expect(childFacts.decoded[0]?.userInput?.text).toBe(turn1Prompt)
    expect(childFacts.decoded[1]?.plannerResponse?.canonicalText).toBe(turn1Answer)
    expect(childFacts.decoded[0]?.metadata?.sourceTrajectoryStepInfo?.cascadeId).toBe(
      forked.nativeSessionId,
    )
    expect(childFacts.decoded[0]?.metadata?.sourceTrajectoryStepInfo?.trajectoryId).toBe(
      childFacts.trajectoryId,
    )
    expect(childFacts.serializedText).not.toContain('AGY_FORK_POST_CUT_PROMPT_EXCLUDED')
    expect(childFacts.serializedText).not.toContain('AGY_FORK_POST_CUT_ANSWER_EXCLUDED')

    const sourceStepsAfterFork = await withTempReadonlySqlite(sourceDbPath, owned.root, (db) => {
      return Number(db.prepare('SELECT COUNT(*) AS count FROM "steps"').get()?.['count'] ?? -1)
    })
    expect(sourceStepsAfterFork).toBe(4)

    const summaryCounts = await withTempReadonlySqlite(summariesDbPath, owned.root, (db) => {
      const childRow = db
        .prepare(
          'SELECT step_count FROM "conversation_summaries" WHERE "conversation_id" = ? LIMIT 1',
        )
        .get(forked.nativeSessionId)
      return {
        childStepCount: Number(childRow?.['step_count'] ?? -1),
      }
    })
    expect(summaryCounts.childStepCount).toBe(2)
    expect(guard.requestCount).toBe(0)
    await assertConversationsDirHygiene(join(agyAppDataDir, 'conversations'))

    // Verify real N-API v8 agy-sqlite-file anchored SHARED lock & isolated child PID accounting:
    const lockedView = bundle.openAnchoredLockedSqliteView(
      agyAppDataDir,
      ['conversations'],
      `${forked.nativeSessionId}.db`,
      { acquireSharedLock: true, openWal: true, openShm: true, checkJournal: true },
    )
    try {
      expect(lockedView.sharedLockHeld).toBe(true)
      expect(lockedView.byteLength).toBeGreaterThanOrEqual(100)
      expect(lockedView.readAt(0, 16).toString('ascii')).toBe('SQLite format 3\0')
      expect(lockedView.verifyUnchanged().unchanged).toBe(true)
    } finally {
      lockedView.close()
    }
    expect(bundle.getOpenAgySqliteViewCountForTesting()).toBe(0)

    const forkChildStatsAfter = bundle.getNodeAgyStorageChildStatsForTesting()
    expect(forkChildStatsAfter.started).toBeGreaterThan(childStatsBefore.started)
    expect(forkChildStatsAfter.lastPid).toBeDefined()
    expect(forkChildStatsAfter.lastPid).not.toBe(process.pid)
    expect(forkChildStatsAfter.live).toBe(0)
  } finally {
    await runAllCleanupSteps([
      async () => {
        vi.unstubAllEnvs()
      },
      async () => shellPool?.dispose(),
      async () => forkFiles?.dispose(),
      async () => guard.close(),
      async () => finishFixture(owned, { adapters: adaptersToDispose }),
    ])
  }
})

it('enforces explicit PACT_E2E_AGY_AUTH_DIR isolation without reading host HOME and rejects unsafe Windows .cmd paths', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pact-agy-native-precheck-'))
  const sentinelHome = join(tempRoot, 'sentinel-host-home')
  const readableHostHome = join(tempRoot, 'readable-host-home')
  const isolatedHome = join(tempRoot, 'isolated-home')
  const authDir = join(tempRoot, 'explicit-auth')
  await mkdir(sentinelHome, { recursive: true, mode: 0o700 })
  await mkdir(join(readableHostHome, '.gemini', 'antigravity-cli'), {
    recursive: true,
    mode: 0o700,
  })
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
  await mkdir(authDir, { recursive: true, mode: 0o700 })
  await chmod(authDir, 0o700)
  if (process.platform !== 'win32') {
    await chmod(sentinelHome, 0o000)
  }
  try {
    const allowlisted = isolatedAgyAllowlistEnv(isolatedHome, {
      PATH: process.env.PATH,
      PACT_HOST_ENV_SENTINEL: 'DO_NOT_LEAK',
      OPENAI_API_KEY: 'synthetic-openai-host-key',
      ANTHROPIC_API_KEY: 'synthetic-anthropic-host-key',
      GEMINI_API_KEY: 'synthetic-gemini-host-key',
    })
    expect(allowlisted['PACT_HOST_ENV_SENTINEL']).toBeUndefined()
    expect(allowlisted['OPENAI_API_KEY']).toBeUndefined()
    expect(allowlisted['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(allowlisted['GEMINI_API_KEY']).toBeUndefined()
    expect(allowlisted['HOME']).toBe(isolatedHome)
    expect(allowlisted['ANTIGRAVITY_GEMINI_DIR']).toBe(join(isolatedHome, '.gemini'))

    expect(parseSupportedAgySemver('agy version 1.5.9')).toEqual({
      status: 'supported',
      version: '1.5.9',
    })
    expect(parseSupportedAgySemver('agy version 1.5.9+build1')).toEqual({
      status: 'supported',
      version: '1.5.9+build1',
    })
    expect(parseSupportedAgySemver('agy version 1.5.9-rc.1')).toEqual({
      status: 'outdated',
      version: '1.5.9-rc.1',
    })
    expect(parseSupportedAgySemver('agy version 1.5.8')).toEqual({
      status: 'outdated',
      version: '1.5.8',
    })
    expect(parseSupportedAgySemver('agy version 1.5.13', '1.5.13')).toEqual({
      status: 'supported',
      version: '1.5.13',
    })
    expect(parseSupportedAgySemver('agy version 1.5.12', '1.5.13')).toEqual({
      status: 'outdated',
      version: '1.5.12',
    })

    const writeVersionCli = async (name: string, versionOutput: string): Promise<string> => {
      const script = join(tempRoot, `${name}.mjs`)
      await writeFile(script, `process.stdout.write(${JSON.stringify(versionOutput)})\n`, {
        mode: 0o600,
      })
      if (process.platform === 'win32') {
        return writeWindowsNodeLauncher(tempRoot, name, [script])
      }
      const bin = join(tempRoot, name)
      const quotedNode = process.execPath.replace(/'/gu, "'\\''")
      const quotedScript = script.replace(/'/gu, "'\\''")
      await writeFile(bin, `#!/bin/sh\nexec '${quotedNode}' '${quotedScript}' "$@"\n`, {
        mode: 0o755,
      })
      await chmod(bin, 0o755)
      return bin
    }

    const prereleaseCli = await writeVersionCli('agy-rc', 'agy version 1.5.9-rc.1\n')
    const buildMetaCli = await writeVersionCli('agy-build', 'agy version 1.5.9+build1\n')
    await expect(
      verifyAgyMinimumVersion(
        prereleaseCli,
        { PATH: process.env.PATH, PACT_HOST_ENV_SENTINEL: 'DO_NOT_LEAK' },
        { cwd: isolatedHome, isolatedRoot: isolatedHome },
      ),
    ).rejects.toThrow(/older than required 1\.5\.9/iu)
    await expect(
      verifyAgyMinimumVersion(
        buildMetaCli,
        { PATH: process.env.PATH, PACT_HOST_ENV_SENTINEL: 'DO_NOT_LEAK' },
        { cwd: isolatedHome, isolatedRoot: isolatedHome },
      ),
    ).resolves.toBe('1.5.9+build1')

    expect(() =>
      requireExplicitAgyAuthDir({
        HOME: sentinelHome,
        USERPROFILE: sentinelHome,
      }),
    ).toThrow(/requires explicit PACT_E2E_AGY_AUTH_DIR/u)

    await expect(
      copyIsolatedAgyAuthConfig(isolatedHome, {
        HOME: sentinelHome,
        USERPROFILE: sentinelHome,
      }),
    ).rejects.toThrow(/requires explicit PACT_E2E_AGY_AUTH_DIR/u)

    // Direct forbidden host paths fail before touching sentinelHome (even when sentinelHome is 0o000):
    const sentinelAppData = join(tempRoot, 'sentinel-appdata')
    for (const forbiddenAuthDir of [
      join(sentinelHome, '.gemini'),
      join(sentinelHome, '.gemini', 'antigravity-cli'),
      join(sentinelHome, 'Library', 'Application Support', 'antigravity'),
      join(sentinelHome, 'Library', 'Keychains'),
      join(sentinelHome, '.config', 'antigravity'),
      join(sentinelAppData, 'antigravity'),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Verify each forbidden host directory class independently.
      await expect(
        copyIsolatedAgyAuthConfig(isolatedHome, {
          HOME: sentinelHome,
          USERPROFILE: sentinelHome,
          APPDATA: sentinelAppData,
          PACT_E2E_AGY_AUTH_DIR: forbiddenAuthDir,
        }),
      ).rejects.toThrow(/outside host Antigravity and keychain locations/u)
    }

    const authPayload = JSON.stringify({
      installation: 'isolated-fixture-only',
      access_token: 'fixture-access-token-value-12345',
    })
    const sourceAuthFile = join(authDir, 'installation_id')
    await writeFile(sourceAuthFile, authPayload, { mode: 0o600 })
    await chmod(sourceAuthFile, 0o600)

    // Symlinked auth directories (both pointing to valid private dir and pointing to host .gemini)
    // must be rejected immediately by lstat BEFORE realpath!
    const symlinkToValidAuth = join(tempRoot, 'symlink-valid-auth')
    const symlinkToHostGemini = join(tempRoot, 'symlink-host-gemini')
    await symlink(authDir, symlinkToValidAuth, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(
      join(readableHostHome, '.gemini', 'antigravity-cli'),
      symlinkToHostGemini,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(
      copyIsolatedAgyAuthConfig(isolatedHome, {
        HOME: sentinelHome,
        USERPROFILE: sentinelHome,
        PACT_E2E_AGY_AUTH_DIR: symlinkToValidAuth,
      }),
    ).rejects.toThrow(/symbolic link|non-symlink|0o700/iu)
    await expect(
      copyIsolatedAgyAuthConfig(isolatedHome, {
        HOME: readableHostHome,
        USERPROFILE: readableHostHome,
        PACT_E2E_AGY_AUTH_DIR: symlinkToHostGemini,
      }),
    ).rejects.toThrow(/symbolic link|outside host Antigravity/iu)

    if (process.platform === 'darwin') {
      const appSupportSubdir = join(authDir, 'app-support')
      await mkdir(appSupportSubdir, { recursive: true, mode: 0o700 })
      await chmod(appSupportSubdir, 0o700)
      const macScopeFile = join(appSupportSubdir, 'credential-user-scope')
      await writeFile(macScopeFile, 'fixture-scope-secret-999', { mode: 0o600 })
      await chmod(macScopeFile, 0o600)
    }

    const manifest = await copyIsolatedAgyAuthConfig(isolatedHome, {
      HOME: sentinelHome,
      USERPROFILE: sentinelHome,
      PACT_E2E_AGY_AUTH_DIR: authDir,
    })
    await expect(manifest.assertSourceIntegrity()).resolves.toBeUndefined()
    expect(manifest.redact('leaked fixture-access-token-value-12345 and Bearer abc.def')).toBe(
      'leaked [REDACTED] and Bearer [REDACTED]',
    )

    expect(isUnsafeWindowsCmdPath('C:\\Tools\\agy.cmd')).toBe(false)
    expect(isUnsafeWindowsCmdPath('C:\\Tools\\bad&calc\\agy.cmd')).toBe(true)
    await expect(
      verifyAgyMinimumVersion(
        'C:\\Tools\\bad&calc\\agy.cmd',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32',
      ),
    ).rejects.toThrow('Unsafe Windows native probe arguments')
  } finally {
    if (process.platform !== 'win32') {
      await chmod(sentinelHome, 0o700).catch(() => undefined)
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
