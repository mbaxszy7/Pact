import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { AgentNativeForkWitness } from '@pact/agent-runtime'

import {
  agyStorageCancelRequestSchema,
  agyStorageChildToUtilityMessageSchema,
  agyStorageClosedEventSchema,
  agyStorageInitMessageSchema,
  agyStorageOpenRequestSchema,
  agyStorageOpenResponseSchema,
  agyStoragePortCandidateCommittedMessageSchema,
  agyStoragePortRequestMessageSchema,
  agyStoragePortResultAckMessageSchema,
  agyStorageRequestPayloadSchema,
  ipcTrafficMeasurementSchema,
  runFailureKindSchema,
  type AgyForkFileResultPayload,
  type AgyStorageAction,
  type AgyStorageCancelReason,
  type AgyStorageClosedEvent,
  type AgyStorageJobKey,
  type AgyStorageOpenRequest,
  type AgyStorageRequestByAction,
  type AgyStorageRequestPayload,
  type AgyStorageResultByAction,
} from '@pact/contracts'

import {
  logicalIpcMeasurement,
  type LogicalIpcWorkerTraffic,
} from '../../shared/logical-ipc-traffic'
import { AgentExecutionError } from './agent-execution-error'
import { NativeWorkingMemory, NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'

const MAX_IDENTITY_DEADLINE_MS = 3_000
const MAX_OPERATION_DEADLINE_MS = 10_000
const KILL_GRACE_MS = 2_000
const POST_RESULT_EXIT_GRACE_MS = 2_000
const POST_EXIT_PORT_DRAIN_MS = 50
const CANDIDATE_STAGING_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const
const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const OWNER_STAGING_LEAF_RE =
  /^\.pact-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/iu

const SAFE_NODE_CHILD_ENV_KEYS = [
  'ANTIGRAVITY_GEMINI_DIR',
  'PACT_AGY_APP_DATA_DIR',
  'PACT_AGY_NATIVE_MODE',
  'PACT_AGY_NATIVE_DIR',
  'PACT_AGY_PRIVATE_TEMP_DIR',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'PATH',
] as const

export interface AgyStorageControl {
  readonly signal: AbortSignal
  readonly deadlineAt: number
}

export interface AgyStorageHandle<T> {
  readonly result: Promise<T>
  readonly physical: Promise<void>
  cancel(): void
}

export interface AgyStorageJobPort {
  onMessage(listener: (message: unknown) => void): void
  postMessage(message: object): void
  close(): void
}

export interface AgyStorageOpenedSession {
  readonly port: AgyStorageJobPort
  readonly exited: Promise<AgyStorageClosedEvent>
  readonly pid?: number
  cancel(reason: AgyStorageCancelReason): void
}

export interface AgyStorageTransport {
  readonly generation: string
  open(request: AgyStorageOpenRequest): Promise<AgyStorageOpenedSession>
  dispose?(): void
}

export interface AgyStorageStartCallbacks {
  readonly onCandidate?: (
    candidateNativeSessionId: string,
    witness: AgentNativeForkWitness,
    candidate: AgyForkFileResultPayload | undefined,
  ) => Promise<void>
}

export interface AgyStorageRunnerOptions {
  readonly ipcTraffic?: LogicalIpcWorkerTraffic
  readonly transport?: AgyStorageTransport
  readonly onPhysicalOperation?: (signal: AbortSignal, physical: Promise<void>) => void
}

interface ElectronParentPortLike {
  postMessage(message: unknown): void
}

interface ElectronMessagePortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
  start(): void
  close(): void
}

interface PendingParentPortOpen {
  readonly jobKey: AgyStorageJobKey
  readonly resolve: (session: AgyStorageOpenedSession) => void
  readonly reject: (error: Error) => void
  readonly exited: Promise<AgyStorageClosedEvent>
  readonly resolveExited: (event: AgyStorageClosedEvent) => void
}

function formatJobKeyId(jobKey: AgyStorageJobKey): string {
  return `${jobKey.generation}:${jobKey.requestId}`
}

function sameJobKey(left: AgyStorageJobKey, right: AgyStorageJobKey): boolean {
  return (
    left.version === right.version &&
    left.generation === right.generation &&
    left.requestId === right.requestId
  )
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    )
  }
  return value
}

function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest('hex')
}

function buildSanitizedNodeChildEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PACT_AGY_STORAGE_CHILD: '1',
  }
  for (const key of SAFE_NODE_CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function resolveStorageRootForCleanup(storageRoot?: string): string | undefined {
  const explicit = storageRoot?.trim() || process.env['PACT_AGY_APP_DATA_DIR']?.trim()
  if (explicit) return isAbsolute(explicit) ? explicit : undefined
  const geminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']?.trim()
  if (geminiDir && isAbsolute(geminiDir)) {
    return resolve(join(geminiDir, 'antigravity-cli'))
  }
  const home = process.env['HOME']?.trim() || process.env['USERPROFILE']?.trim() || homedir()
  const fallback = resolve(join(home, '.gemini', 'antigravity-cli'))
  return isAbsolute(fallback) ? fallback : undefined
}

function maxDeadlineForAction(action: AgyStorageAction): number {
  return action === 'read-agy-trajectory-identity'
    ? MAX_IDENTITY_DEADLINE_MS
    : MAX_OPERATION_DEADLINE_MS
}

class UnknownStateOpenError extends Error {
  readonly code: string | undefined
  readonly exited: Promise<AgyStorageClosedEvent>

  constructor(message: string, exited: Promise<AgyStorageClosedEvent>, code?: string) {
    super(message)
    this.name = 'UnknownStateOpenError'
    this.code = code
    this.exited = exited
  }
}

function readUnknownStateExitPromise(error: unknown): Promise<AgyStorageClosedEvent> | undefined {
  if (error instanceof UnknownStateOpenError) return error.exited
  if (error instanceof Error) {
    const candidate: unknown = Reflect.get(error, 'exited')
    if (typeof candidate === 'object' && candidate !== null) {
      const thenFn: unknown = Reflect.get(candidate, 'then')
      if (typeof thenFn === 'function') {
        return new Promise<AgyStorageClosedEvent>((resolveExit, rejectExit) => {
          Reflect.apply(thenFn, candidate, [
            (value: unknown) => {
              const parsed = agyStorageClosedEventSchema.safeParse(value)
              if (parsed.success) resolveExit(parsed.data)
              else rejectExit(new Error('Invalid closed event from unknown-state open waiter.'))
            },
            rejectExit,
          ])
        })
      }
    }
  }
  return undefined
}

interface CandidateStagingSnapshot {
  readonly candidateDirIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined
  readonly preExistingSuffixes: ReadonlySet<string>
}

function snapshotCandidateStagingBeforeSend(
  storageRoot: string | undefined,
  candidateSessionId: string,
  stagingLeafName: string,
): CandidateStagingSnapshot {
  const preExistingSuffixes = new Set<string>()
  if (!STRICT_UUID_RE.test(candidateSessionId) || !OWNER_STAGING_LEAF_RE.test(stagingLeafName)) {
    for (const suffix of CANDIDATE_STAGING_SUFFIXES) preExistingSuffixes.add(suffix)
    return { candidateDirIdentity: undefined, preExistingSuffixes }
  }
  const root = resolveStorageRootForCleanup(storageRoot)
  if (!root) {
    return { candidateDirIdentity: undefined, preExistingSuffixes }
  }
  try {
    const rootStat = lstatSync(root, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { candidateDirIdentity: undefined, preExistingSuffixes }
    }
    const brainDir = join(root, 'brain')
    const brainStat = lstatSync(brainDir, { bigint: true })
    if (!brainStat.isDirectory() || brainStat.isSymbolicLink()) {
      return { candidateDirIdentity: undefined, preExistingSuffixes }
    }
    const candidateDir = join(brainDir, candidateSessionId)
    const candidateStat = lstatSync(candidateDir, { bigint: true })
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      return { candidateDirIdentity: undefined, preExistingSuffixes }
    }
    for (const suffix of CANDIDATE_STAGING_SUFFIXES) {
      const target = join(candidateDir, `${stagingLeafName}${suffix}`)
      try {
        lstatSync(target, { bigint: true })
        preExistingSuffixes.add(suffix)
      } catch {
        /* Expected absent before job starts. */
      }
    }
    return {
      candidateDirIdentity: { dev: candidateStat.dev, ino: candidateStat.ino },
      preExistingSuffixes,
    }
  } catch {
    return { candidateDirIdentity: undefined, preExistingSuffixes }
  }
}

function cleanupJobStagingArtifacts(
  storageRoot: string | undefined,
  candidateSessionId: string,
  stagingLeafName: string,
  snapshot: CandidateStagingSnapshot,
): void {
  if (!STRICT_UUID_RE.test(candidateSessionId) || !OWNER_STAGING_LEAF_RE.test(stagingLeafName)) {
    return
  }
  if (snapshot.preExistingSuffixes.has('')) {
    return
  }
  const root = resolveStorageRootForCleanup(storageRoot)
  if (!root) return
  try {
    const rootStat = lstatSync(root, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return
    const brainDir = join(root, 'brain')
    const brainStat = lstatSync(brainDir, { bigint: true })
    if (!brainStat.isDirectory() || brainStat.isSymbolicLink()) return
    const candidateDir = join(brainDir, candidateSessionId)
    const candidateStat = lstatSync(candidateDir, { bigint: true })
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return
    if (
      snapshot.candidateDirIdentity !== undefined &&
      (candidateStat.dev !== snapshot.candidateDirIdentity.dev ||
        candidateStat.ino !== snapshot.candidateDirIdentity.ino)
    ) {
      return
    }

    for (const suffix of CANDIDATE_STAGING_SUFFIXES) {
      if (snapshot.preExistingSuffixes.has(suffix)) continue
      const target = join(candidateDir, `${stagingLeafName}${suffix}`)
      try {
        const st = lstatSync(target, { bigint: true })
        if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1n) {
          unlinkSync(target)
        }
      } catch {
        /* File absent or already published/cleaned. */
      }
    }
  } catch {
    /* Best-effort staging cleanup after confirmed child exit. */
  }
}

function wrapElectronMessagePort(port: ElectronMessagePortLike): AgyStorageJobPort {
  const listeners = new Set<(event: { data: unknown }) => void>()
  port.start()
  return {
    onMessage(listener) {
      const wrapped = (event: { data: unknown }): void => listener(event.data)
      listeners.add(wrapped)
      port.on('message', wrapped)
    },
    postMessage(message) {
      port.postMessage(message)
    },
    close() {
      for (const wrapped of listeners) {
        port.removeListener('message', wrapped)
      }
      listeners.clear()
      try {
        port.close()
      } catch {
        /* Best-effort close. */
      }
    },
  }
}

/**
 * Utility-side transport backed by Main's `AgyStorageOperations` over `process.parentPort`.
 * Main brokers child startup and transfers one dedicated `MessagePort` per storage job.
 */
export class ElectronParentPortAgyStorageTransport implements AgyStorageTransport {
  readonly generation = randomUUID()
  private readonly pendingOpens = new Map<string, PendingParentPortOpen>()
  private readonly activeExits = new Map<
    string,
    {
      readonly jobKey: AgyStorageJobKey
      readonly resolve: (event: AgyStorageClosedEvent) => void
      cancelSent: boolean
    }
  >()
  private disposed = false

  constructor(private readonly parentPort: ElectronParentPortLike) {}

  open(request: AgyStorageOpenRequest): Promise<AgyStorageOpenedSession> {
    if (this.disposed) {
      return Promise.reject(new Error('Antigravity storage transport is disposed.'))
    }
    const parsed = agyStorageOpenRequestSchema.parse(request)
    const id = formatJobKeyId(parsed.jobKey)
    if (this.pendingOpens.has(id) || this.activeExits.has(id)) {
      return Promise.reject(new Error('Duplicate Antigravity storage job key.'))
    }
    const openDeferred = Promise.withResolvers<AgyStorageOpenedSession>()
    const exitDeferred = Promise.withResolvers<AgyStorageClosedEvent>()
    this.pendingOpens.set(id, {
      jobKey: parsed.jobKey,
      resolve: openDeferred.resolve,
      reject: openDeferred.reject,
      exited: exitDeferred.promise,
      resolveExited: exitDeferred.resolve,
    })
    try {
      this.parentPort.postMessage(parsed)
    } catch (error) {
      this.pendingOpens.delete(id)
      openDeferred.reject(
        error instanceof Error ? error : new Error('Failed to request Antigravity storage child.'),
      )
    }
    return openDeferred.promise
  }

  consume(data: unknown, ports?: readonly ElectronMessagePortLike[]): boolean {
    if (
      typeof data !== 'object' ||
      data === null ||
      !('type' in data) ||
      typeof data.type !== 'string' ||
      !data.type.startsWith('agy-storage.')
    ) {
      return false
    }

    if (data.type === 'agy-storage.open.response') {
      const parsed = agyStorageOpenResponseSchema.safeParse(data)
      if (!parsed.success) return true
      const id = formatJobKeyId(parsed.data.jobKey)
      const pending = this.pendingOpens.get(id)
      if (!pending) {
        const active = this.activeExits.get(id)
        if (parsed.data.ok) {
          if (ports?.[0]) {
            try {
              ports[0].close()
            } catch {
              /* Ignore stale port. */
            }
          }
          if (!active || !active.cancelSent) {
            if (active) active.cancelSent = true
            this.sendCancel(parsed.data.jobKey, 'disposed')
          }
        } else if (active) {
          // Main confirmed pre-spawn rejection after pending-open dispose; no closed.event will follow.
          this.activeExits.delete(id)
          active.resolve(
            agyStorageClosedEventSchema.parse({
              type: 'agy-storage.closed.event',
              jobKey: parsed.data.jobKey,
              exitCode: null,
              signal: null,
              timedOut: parsed.data.code === 'TIMEOUT',
              cancelled: true,
            }),
          )
        }
        return true
      }
      this.pendingOpens.delete(id)
      if (!parsed.data.ok) {
        const err = Object.assign(new Error(parsed.data.message), { code: parsed.data.code })
        pending.reject(err)
        return true
      }
      const transferred = ports?.[0]
      if (!transferred) {
        // Main reported ok:true so a child may already be running; retain exit tracking until closed.event!
        this.activeExits.set(id, {
          jobKey: parsed.data.jobKey,
          resolve: pending.resolveExited,
          cancelSent: true,
        })
        this.sendCancel(parsed.data.jobKey, 'protocol_error')
        pending.reject(
          new UnknownStateOpenError(
            'Antigravity storage open response omitted its MessagePort.',
            pending.exited,
            'PROTOCOL_ERROR',
          ),
        )
        return true
      }
      const exitRecord = {
        jobKey: parsed.data.jobKey,
        resolve: pending.resolveExited,
        cancelSent: false,
      }
      this.activeExits.set(id, exitRecord)
      pending.resolve({
        port: wrapElectronMessagePort(transferred),
        exited: pending.exited,
        cancel: (reason) => {
          if (exitRecord.cancelSent) return
          exitRecord.cancelSent = true
          this.sendCancel(parsed.data.jobKey, reason)
        },
      })
      return true
    }

    if (data.type === 'agy-storage.closed.event') {
      const parsed = agyStorageClosedEventSchema.safeParse(data)
      if (!parsed.success) return true
      const id = formatJobKeyId(parsed.data.jobKey)
      const active = this.activeExits.get(id)
      if (active) {
        this.activeExits.delete(id)
        active.resolve(parsed.data)
      }
      return true
    }

    return true
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pendingOpens) {
      this.pendingOpens.delete(id)
      // Retain exit waiter until Main sends either closed.event or pre-spawn open.response ok:false.
      this.activeExits.set(id, {
        jobKey: pending.jobKey,
        resolve: pending.resolveExited,
        cancelSent: true,
      })
      this.sendCancel(pending.jobKey, 'disposed')
      pending.reject(
        new UnknownStateOpenError(
          'Antigravity storage transport is closing.',
          pending.exited,
          'DISPOSED',
        ),
      )
    }
    for (const active of this.activeExits.values()) {
      if (!active.cancelSent) {
        active.cancelSent = true
        this.sendCancel(active.jobKey, 'disposed')
      }
    }
  }

  private sendCancel(jobKey: AgyStorageJobKey, reason: AgyStorageCancelReason): void {
    try {
      this.parentPort.postMessage(
        agyStorageCancelRequestSchema.parse({
          type: 'agy-storage.cancel.request',
          jobKey,
          reason,
        }),
      )
    } catch {
      /* Parent port may already be closed during process exit. */
    }
  }
}

export interface NodeChildProcessAgyStorageStats {
  live: number
  started: number
  lastPid: number | undefined
}

const nodeChildStats: NodeChildProcessAgyStorageStats = {
  live: 0,
  started: 0,
  lastPid: undefined,
}

let configuredDefaultTransport: AgyStorageTransport | undefined
let configuredChildScriptForTesting: string | undefined

export function configureDefaultAgyStorageTransport(
  transport: AgyStorageTransport | undefined,
): void {
  configuredDefaultTransport = transport
}

export function configureAgyStorageChildScriptForTesting(scriptPath: string | undefined): void {
  configuredChildScriptForTesting = scriptPath
}

export function getNodeAgyStorageChildStatsForTesting(): Readonly<NodeChildProcessAgyStorageStats> {
  return { ...nodeChildStats }
}

function resolveDefaultNodeChildScriptPath(): string {
  if (configuredChildScriptForTesting) return configuredChildScriptForTesting
  const candidates: string[] = []
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    candidates.push(join(__dirname, 'agy-storage-child.js'))
    candidates.push(join(__dirname, '../agy-storage-child.js'))
    candidates.push(resolve(__dirname, '../../../out/main/utility/agy-storage-child.js'))
  }
  candidates.push(resolve(process.cwd(), 'apps/desktop/out/main/utility/agy-storage-child.js'))
  candidates.push(resolve(process.cwd(), 'out/main/utility/agy-storage-child.js'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Unable to locate bundled agy-storage-child.js; build @pact/desktop or configure a test bundle.',
  )
}

/**
 * Isolated OS child-process transport using Node `child_process.fork` for Vitest and
 * non-Electron native-harness execution. Each job runs in its own real OS PID.
 */
export class NodeChildProcessAgyStorageTransport implements AgyStorageTransport {
  readonly generation = randomUUID()
  private readonly activeChildren = new Set<ChildProcess>()
  private disposed = false

  constructor(private readonly scriptPathProvider?: () => string) {}

  open(request: AgyStorageOpenRequest): Promise<AgyStorageOpenedSession> {
    if (this.disposed) {
      return Promise.reject(new Error('Antigravity storage transport is disposed.'))
    }
    const parsed = agyStorageOpenRequestSchema.parse(request)
    const remainingMs = parsed.deadlineAt - Date.now()
    if (remainingMs <= 0) {
      return Promise.reject(
        Object.assign(new Error('Antigravity storage request deadline already expired.'), {
          code: 'TIMEOUT',
        }),
      )
    }

    let scriptPath: string
    try {
      scriptPath = this.scriptPathProvider
        ? this.scriptPathProvider()
        : resolveDefaultNodeChildScriptPath()
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Failed to locate storage child script.'),
      )
    }

    let child: ChildProcess
    try {
      child = fork(scriptPath, [], {
        execArgv: [],
        env: buildSanitizedNodeChildEnv(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Failed to fork Antigravity storage child.'),
      )
    }

    child.stderr?.resume()
    this.activeChildren.add(child)
    nodeChildStats.live += 1
    nodeChildStats.started += 1
    nodeChildStats.lastPid = child.pid

    let exited = false
    let hasPid = typeof child.pid === 'number' && child.pid > 0
    let stopping = false
    let timedOut = false
    let cancelled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const exitDeferred = Promise.withResolvers<AgyStorageClosedEvent>()

    const stopChild = (markTimedOut: boolean, markCancelled: boolean): void => {
      if (markTimedOut) timedOut = true
      if (markCancelled) cancelled = true
      if (exited || stopping) return
      stopping = true
      clearTimeout(deadlineTimer)
      try {
        if (child.connected) {
          child.send({ type: 'cancel', jobKey: parsed.jobKey })
        }
      } catch {
        /* Proceed to OS kill. */
      }
      try {
        child.kill('SIGTERM')
      } catch {
        /* Already exited. */
      }
      if (exited) return
      forceTimer = setTimeout(() => {
        forceTimer = undefined
        if (!exited) {
          if (!hasPid && child.pid === undefined) {
            onChildExit(null, null)
            return
          }
          try {
            child.kill('SIGKILL')
          } catch {
            /* Already exited. */
          }
        }
      }, KILL_GRACE_MS)
      forceTimer.unref()
    }

    const deadlineTimer = setTimeout(() => {
      stopChild(true, false)
    }, remainingMs)
    deadlineTimer.unref()

    const listeners = new Set<(message: unknown) => void>()
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exited) return
      exited = true
      clearTimeout(deadlineTimer)
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer)
        forceTimer = undefined
      }
      this.activeChildren.delete(child)
      nodeChildStats.live = Math.max(0, nodeChildStats.live - 1)
      for (const listener of listeners) {
        child.off('message', listener)
      }
      listeners.clear()
      exitDeferred.resolve(
        agyStorageClosedEventSchema.parse({
          type: 'agy-storage.closed.event',
          jobKey: parsed.jobKey,
          exitCode: typeof code === 'number' && Number.isSafeInteger(code) ? code : null,
          signal: typeof signal === 'string' && signal.length > 0 ? signal : null,
          timedOut,
          cancelled,
        }),
      )
    }

    child.once('spawn', () => {
      hasPid = true
      if (child.pid !== undefined) {
        nodeChildStats.lastPid = child.pid
      }
    })
    child.once('exit', onChildExit)
    child.once('error', () => {
      if (exited) return
      if (!hasPid && child.pid === undefined) {
        cancelled = true
        onChildExit(null, null)
      } else {
        stopChild(false, true)
      }
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!exited && !hasPid && child.pid === undefined) {
        onChildExit(code, signal)
      }
    })

    try {
      child.send(
        agyStorageInitMessageSchema.parse({
          type: 'init',
          jobKey: parsed.jobKey,
          action: parsed.action,
          deadlineAt: parsed.deadlineAt,
        }),
      )
    } catch {
      stopChild(false, true)
    }

    const port: AgyStorageJobPort = {
      onMessage(listener) {
        listeners.add(listener)
        child.on('message', listener)
      },
      postMessage(message) {
        if (exited || !child.connected) {
          throw new Error('Antigravity storage child IPC channel is closed.')
        }
        child.send(message)
      },
      close() {
        for (const listener of listeners) {
          child.off('message', listener)
        }
        listeners.clear()
        try {
          if (child.connected) child.disconnect()
        } catch {
          /* Best-effort disconnect. */
        }
      },
    }

    return Promise.resolve({
      port,
      exited: exitDeferred.promise,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      cancel: (reason) => stopChild(reason === 'timeout', reason !== 'timeout'),
    })
  }

  dispose(): void {
    this.disposed = true
    for (const child of this.activeChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* Best-effort kill. */
      }
    }
  }
}

function createAbortError(): AgentExecutionError {
  return new AgentExecutionError(
    'runtime_incompatible',
    'Native Fork file inspection was cancelled; possible writes remain unconfirmed.',
    false,
  )
}

function createTimeoutError(): AgentExecutionError {
  return new AgentExecutionError(
    'runtime_incompatible',
    'Native Fork file operation exceeded its deadline; possible writes remain unconfirmed.',
    false,
  )
}

interface TrackedActiveJob {
  cancel(reason: AgyStorageCancelReason): void
  readonly physical: Promise<void>
}

/**
 * Utility-side runner for isolated single-operation Antigravity storage jobs.
 *
 * Reserves 128 MiB (`NATIVE_OWNER_WORKING_BYTES`) working memory, installs exit/cancel/cleanup/
 * `physical` settlement BEFORE notifying physical operation observers (so observer throws still
 * cancel and reap the child PID), enforces `deadlineAt`, and settles `physical` + releases memory
 * reservation ONLY after confirmed physical child exit, in-flight callbacks, and staging cleanup.
 */
export class AgyStorageRunner {
  private readonly activeJobs = new Set<TrackedActiveJob>()
  private readonly physicalObservers = new Set<
    (signal: AbortSignal, physical: Promise<void>) => void
  >()
  private readonly fallbackNodeTransport = new NodeChildProcessAgyStorageTransport()
  private disposed = false

  constructor(private readonly options: AgyStorageRunnerOptions = {}) {}

  get active(): boolean {
    return this.activeJobs.size > 0
  }

  addPhysicalOperationObserver(
    observer: (signal: AbortSignal, physical: Promise<void>) => void,
  ): () => void {
    this.physicalObservers.add(observer)
    return () => {
      this.physicalObservers.delete(observer)
    }
  }

  start<K extends AgyStorageAction>(
    request: AgyStorageRequestByAction[K],
    control: AgyStorageControl,
    callbacks?: AgyStorageStartCallbacks,
  ): AgyStorageHandle<AgyStorageResultByAction[K]> {
    const parsedRequest = agyStorageRequestPayloadSchema.safeParse(request)
    if (!parsedRequest.success) {
      return {
        result: Promise.reject(
          new Error(`Invalid Antigravity storage request: ${parsedRequest.error.message}`),
        ),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }
    if (!Number.isSafeInteger(control.deadlineAt) || control.deadlineAt <= 0) {
      return {
        result: Promise.reject(new Error('Invalid Antigravity storage deadline.')),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }
    if (this.disposed || control.signal.aborted) {
      return {
        result: Promise.reject(createAbortError()),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }
    const now = Date.now()
    const initialRemainingMs = Math.min(
      maxDeadlineForAction(parsedRequest.data.action),
      control.deadlineAt - now,
    )
    if (initialRemainingMs <= 0) {
      return {
        result: Promise.reject(createTimeoutError()),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }
    const effectiveDeadlineAt = now + initialRemainingMs

    if (
      parsedRequest.data.action === 'fork' &&
      parsedRequest.data.awaitCandidateCommit &&
      !callbacks?.onCandidate
    ) {
      return {
        result: Promise.reject(
          new Error('Antigravity Fork awaitCandidateCommit requires an onCandidate callback.'),
        ),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }

    const requiresCandidateHandshake =
      parsedRequest.data.action === 'fork' &&
      (parsedRequest.data.awaitCandidateCommit === true || Boolean(callbacks?.onCandidate))

    const transport = this.resolveTransport()
    const jobKey: AgyStorageJobKey = {
      version: 1,
      generation: transport.generation,
      requestId: randomUUID(),
    }
    const traffic = this.options.ipcTraffic?.collector('utility-native-fork')

    let reservation: ReturnType<NativeWorkingMemory['reserve']> | undefined
    let tempStagingDir: string | undefined
    const cleanupTempStagingDir = (): void => {
      if (!tempStagingDir) return
      const dir = tempStagingDir
      tempStagingDir = undefined
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Best-effort cleanup of caller-owned staging directory after confirmed child exit. */
      }
    }

    // Generate stagingLeafName exclusively inside the job owner; never trust external names for cleanup.
    const ownerStagingLeafName = `.pact-stage-${jobKey.requestId}.db`
    const candidateStagingCleanup:
      | {
          readonly storageRoot: string | undefined
          readonly candidateSessionId: string
          readonly stagingLeafName: string
        }
      | undefined =
      parsedRequest.data.action === 'fork' &&
      STRICT_UUID_RE.test(parsedRequest.data.candidateNativeSessionId)
        ? {
            storageRoot: parsedRequest.data.storageRoot,
            candidateSessionId: parsedRequest.data.candidateNativeSessionId,
            stagingLeafName: ownerStagingLeafName,
          }
        : parsedRequest.data.action === 'rebuild_seed' &&
            STRICT_UUID_RE.test(parsedRequest.data.nativeSessionId)
          ? {
              storageRoot: parsedRequest.data.storageRoot,
              candidateSessionId: parsedRequest.data.nativeSessionId,
              stagingLeafName: ownerStagingLeafName,
            }
          : undefined

    try {
      reservation = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
      if (!parsedRequest.data.tempStagingDir) {
        tempStagingDir = mkdtempSync(join(tmpdir(), 'pact-agy-stage-'))
        chmodSync(tempStagingDir, 0o700)
      }
    } catch (error) {
      cleanupTempStagingDir()
      reservation?.release()
      reservation = undefined
      return {
        result: Promise.reject(error instanceof Error ? error : new Error(String(error))),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }

    const baseEffectiveInput: AgyStorageRequestPayload =
      parsedRequest.data.action === 'fork'
        ? {
            ...parsedRequest.data,
            awaitCandidateCommit: requiresCandidateHandshake,
            ...(tempStagingDir ? { tempStagingDir } : {}),
            ...(candidateStagingCleanup
              ? { stagingLeafName: candidateStagingCleanup.stagingLeafName }
              : {}),
          }
        : parsedRequest.data.action === 'rebuild_seed'
          ? {
              ...parsedRequest.data,
              ...(tempStagingDir ? { tempStagingDir } : {}),
              ...(candidateStagingCleanup
                ? { stagingLeafName: candidateStagingCleanup.stagingLeafName }
                : {}),
            }
          : tempStagingDir
            ? { ...parsedRequest.data, tempStagingDir }
            : parsedRequest.data
    const effectiveInput: AgyStorageRequestPayload = baseEffectiveInput

    // Validate the COMPLETE wire request (including 16 MiB aggregate cap) BEFORE transport.open
    // so an invalid/oversized payload NEVER spawns a child process.
    let wireRequest: ReturnType<typeof agyStoragePortRequestMessageSchema.parse>
    try {
      wireRequest = agyStoragePortRequestMessageSchema.parse({
        type: 'request',
        jobKey,
        deadlineAt: effectiveDeadlineAt,
        input: effectiveInput,
        ...(traffic ? { measure: true } : {}),
      })
    } catch (wireError) {
      cleanupTempStagingDir()
      reservation?.release()
      reservation = undefined
      return {
        result: Promise.reject(
          wireError instanceof Error ? wireError : new Error(String(wireError)),
        ),
        physical: Promise.resolve(),
        cancel: () => undefined,
      }
    }

    const resultDeferred = Promise.withResolvers<AgyStorageResultByAction[K]>()
    const physicalDeferred = Promise.withResolvers<void>()

    const requiresForkHandshake = requiresCandidateHandshake
    type ForkHandshakeState =
      | 'awaiting_candidate'
      | 'candidate_received'
      | 'witness_committed'
      | 'ack_sent'
      | 'result_received'
    let forkState: ForkHandshakeState = 'awaiting_candidate'
    let committedCandidate:
      | {
          readonly candidateNativeSessionId: string
          readonly witnessDigest: string
          readonly witness: AgentNativeForkWitness
        }
      | undefined

    let resultSettled = false
    let physicallySettled = false
    let childExited = false
    let postExitDrainPending = false
    let candidateInFlight = false
    let cancelled = false
    let cancelReason: AgyStorageCancelReason = 'aborted'
    let cleanupAuthorized = false
    let candidateStagingSnapshot: CandidateStagingSnapshot | undefined
    let openedSession: AgyStorageOpenedSession | undefined
    let settleTrafficTransport: (() => void) | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let exitGuardTimer: ReturnType<typeof setTimeout> | undefined
    let postExitDrainTimer: ReturnType<typeof setTimeout> | undefined

    const resolveResult = (value: AgyStorageResultByAction[K]): void => {
      if (resultSettled) return
      resultSettled = true
      resultDeferred.resolve(value)
    }

    const rejectResult = (error: unknown): void => {
      if (resultSettled) return
      resultSettled = true
      resultDeferred.reject(error)
    }

    const clearTimersAndSignals = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }
      if (exitGuardTimer !== undefined) {
        clearTimeout(exitGuardTimer)
        exitGuardTimer = undefined
      }
      if (postExitDrainTimer !== undefined) {
        clearTimeout(postExitDrainTimer)
        postExitDrainTimer = undefined
      }
      control.signal.removeEventListener('abort', onSignalAbort)
    }

    const settlePhysical = (): void => {
      if (physicallySettled || !childExited || candidateInFlight || postExitDrainPending) return
      physicallySettled = true
      clearTimersAndSignals()
      try {
        openedSession?.port.close()
      } catch {
        /* Best-effort close. */
      }
      if (cleanupAuthorized && candidateStagingCleanup && candidateStagingSnapshot) {
        cleanupJobStagingArtifacts(
          candidateStagingCleanup.storageRoot,
          candidateStagingCleanup.candidateSessionId,
          candidateStagingCleanup.stagingLeafName,
          candidateStagingSnapshot,
        )
      }
      cleanupTempStagingDir()
      reservation?.release()
      reservation = undefined
      const settleTransport = settleTrafficTransport
      settleTrafficTransport = undefined
      settleTransport?.()
      this.activeJobs.delete(trackedJob)
      physicalDeferred.resolve()
    }

    const cancelJob = (reason: AgyStorageCancelReason, rejectionError?: unknown): void => {
      if (!cancelled) {
        cancelled = true
        cancelReason = reason
      }
      if (postExitDrainTimer !== undefined) {
        clearTimeout(postExitDrainTimer)
        postExitDrainTimer = undefined
      }
      postExitDrainPending = false
      if (rejectionError !== undefined) {
        rejectResult(rejectionError)
      } else if (reason === 'timeout') {
        rejectResult(createTimeoutError())
      } else {
        rejectResult(createAbortError())
      }
      if (openedSession) {
        try {
          openedSession.port.close()
        } catch {
          /* Best-effort close. */
        }
        openedSession.cancel(reason)
      }
      settlePhysical()
    }

    const onSignalAbort = (): void => {
      cancelJob('aborted', createAbortError())
    }

    const trackedJob: TrackedActiveJob = {
      cancel: (reason) => cancelJob(reason),
      physical: physicalDeferred.promise,
    }
    this.activeJobs.add(trackedJob)

    control.signal.addEventListener('abort', onSignalAbort, { once: true })
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined
      cancelJob('timeout', createTimeoutError())
    }, initialRemainingMs)

    const armPostResultExitGuard = (session: AgyStorageOpenedSession): void => {
      if (childExited || exitGuardTimer !== undefined) return
      const guardMs = Math.min(
        POST_RESULT_EXIT_GRACE_MS,
        Math.max(200, effectiveDeadlineAt - Date.now()),
      )
      exitGuardTimer = setTimeout(() => {
        exitGuardTimer = undefined
        if (!childExited) {
          session.cancel('aborted')
        }
      }, guardMs)
      exitGuardTimer.unref?.()
    }

    const sendResultAck = (session: AgyStorageOpenedSession | undefined): void => {
      if (!session || childExited) return
      const ack = agyStoragePortResultAckMessageSchema.parse({
        type: 'result_ack',
        jobKey,
      })
      const ackMeasurement = traffic ? logicalIpcMeasurement(ack) : undefined
      try {
        session.port.postMessage(ack)
        if (traffic && ackMeasurement) {
          traffic.recordMeasurement('utility-native-fork.control', 'control', ackMeasurement)
        }
      } catch {
        /* Child may already have closed its port. */
      }
    }

    const onSessionExit = (closedEvent?: AgyStorageClosedEvent): void => {
      childExited = true
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }
      if (exitGuardTimer !== undefined) {
        clearTimeout(exitGuardTimer)
        exitGuardTimer = undefined
      }
      control.signal.removeEventListener('abort', onSignalAbort)

      if (resultSettled) {
        settlePhysical()
        return
      }
      if (closedEvent?.timedOut) {
        rejectResult(createTimeoutError())
        settlePhysical()
        return
      }
      if (closedEvent?.cancelled || cancelled) {
        rejectResult(createAbortError())
        settlePhysical()
        return
      }

      // Main's `closed.event` can race slightly ahead of a terminal `result` queued on the
      // dedicated job MessagePort. Drain the port for a bounded window before declaring missing result.
      postExitDrainPending = true
      postExitDrainTimer = setTimeout(() => {
        postExitDrainTimer = undefined
        postExitDrainPending = false
        if (!resultSettled) {
          rejectResult(
            new Error(
              `Antigravity storage process ended without a result (${closedEvent?.exitCode ?? 'unknown'}).`,
            ),
          )
        }
        settlePhysical()
      }, POST_EXIT_PORT_DRAIN_MS)
      postExitDrainTimer.unref?.()
    }

    const onPortMessage = (raw: unknown): void => {
      let sanitized = raw
      if (traffic) {
        const rawMeasurement =
          raw !== null && typeof raw === 'object' ? Reflect.get(raw, 'ipcMeasurement') : undefined
        const measured = ipcTrafficMeasurementSchema.safeParse(rawMeasurement)
        if (measured.success) {
          traffic.recordMeasurement('native-fork-utility.reply', 'business', measured.data)
        } else {
          traffic.invalidate('unvalidated_message')
        }
      }
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        sanitized = Object.fromEntries(
          Object.entries(raw).filter(([key]) => key !== 'ipcMeasurement'),
        )
      }
      if (resultSettled || cancelled) return

      const parsed = agyStorageChildToUtilityMessageSchema.safeParse(sanitized)
      if (!parsed.success || !sameJobKey(parsed.data.jobKey, jobKey)) {
        cancelJob(
          'protocol_error',
          new Error('Invalid Antigravity storage child response message.'),
        )
        return
      }

      const msg = parsed.data
      if (msg.type === 'candidate') {
        const typedInput: AgyStorageRequestPayload = effectiveInput
        if (
          typedInput.action !== 'fork' ||
          !callbacks?.onCandidate ||
          forkState !== 'awaiting_candidate' ||
          msg.candidateNativeSessionId !== typedInput.candidateNativeSessionId ||
          msg.witnessDigest !== sha256CanonicalJson(msg.witness)
        ) {
          cancelJob(
            'protocol_error',
            new Error('Invalid or mismatched Antigravity Fork candidate handshake message.'),
          )
          return
        }
        if (
          msg.candidate !== undefined &&
          (msg.candidate.nativeSessionId !== msg.candidateNativeSessionId ||
            msg.candidate.prefixHash !== msg.witness.candidatePrefixHash ||
            msg.candidate.nativeCutId !== msg.witness.sourceCutId ||
            (msg.witness.candidateTrajectoryId !== undefined &&
              msg.candidate.trajectoryId !== msg.witness.candidateTrajectoryId) ||
            (msg.witness.cutStepIdx !== undefined &&
              msg.candidate.cutStep !== msg.witness.cutStepIdx))
        ) {
          cancelJob(
            'protocol_error',
            new Error('Antigravity Fork candidate payload disagrees with candidate witness.'),
          )
          return
        }
        forkState = 'candidate_received'
        candidateInFlight = true
        void Promise.resolve()
          .then(() =>
            callbacks.onCandidate!(msg.candidateNativeSessionId, msg.witness, msg.candidate),
          )
          .then(() => {
            forkState = 'witness_committed'
            committedCandidate = {
              candidateNativeSessionId: msg.candidateNativeSessionId,
              witnessDigest: msg.witnessDigest,
              witness: msg.witness,
            }
            if (
              resultSettled ||
              cancelled ||
              this.disposed ||
              control.signal.aborted ||
              Date.now() >= effectiveDeadlineAt ||
              !openedSession
            ) {
              return undefined
            }
            const ack = agyStoragePortCandidateCommittedMessageSchema.parse({
              type: 'candidate_committed',
              jobKey,
              candidateNativeSessionId: msg.candidateNativeSessionId,
              witnessDigest: msg.witnessDigest,
              committed: true,
            })
            const ackMeasurement = traffic ? logicalIpcMeasurement(ack) : undefined
            try {
              openedSession.port.postMessage(ack)
              forkState = 'ack_sent'
              if (traffic && ackMeasurement) {
                traffic.recordMeasurement('utility-native-fork.control', 'business', ackMeasurement)
              }
            } catch (postError) {
              traffic?.invalidate('transport_error')
              cancelJob('protocol_error', postError)
            }
            return undefined
          })
          .catch((candidateError: unknown) => {
            if (openedSession && !childExited) {
              try {
                const rejectAck = agyStoragePortCandidateCommittedMessageSchema.parse({
                  type: 'candidate_committed',
                  jobKey,
                  candidateNativeSessionId: msg.candidateNativeSessionId,
                  witnessDigest: msg.witnessDigest,
                  committed: false,
                })
                openedSession.port.postMessage(rejectAck)
              } catch {
                /* Best-effort NACK before OS kill. */
              }
            }
            cancelJob('candidate_commit_failed', candidateError)
          })
          .finally(() => {
            candidateInFlight = false
            settlePhysical()
          })
        return
      }

      if (msg.type === 'result') {
        if (msg.action !== request.action) {
          cancelJob(
            'protocol_error',
            new Error('Antigravity storage child returned a result for the wrong action.'),
          )
          return
        }
        if (requiresForkHandshake) {
          if (forkState !== 'ack_sent' || !committedCandidate || msg.action !== 'fork') {
            cancelJob(
              'protocol_error',
              new Error(
                'Antigravity Fork result arrived before candidate witness commit ACK completed.',
              ),
            )
            return
          }
          const finalFork = msg.result
          const expectedWitness = committedCandidate.witness
          const idMapMatches =
            finalFork.idMap.length === expectedWitness.idMap.length &&
            finalFork.idMap.every(
              ([left, right], index) =>
                left === expectedWitness.idMap[index]?.[0] &&
                right === expectedWitness.idMap[index]?.[1],
            )
          if (
            finalFork.nativeSessionId !== committedCandidate.candidateNativeSessionId ||
            finalFork.prefixHash !== expectedWitness.candidatePrefixHash ||
            finalFork.nativeCutId !== expectedWitness.sourceCutId ||
            (expectedWitness.candidatePrefixRecords !== undefined &&
              finalFork.rawRecords !== expectedWitness.candidatePrefixRecords) ||
            (expectedWitness.candidateTrajectoryId !== undefined &&
              finalFork.trajectoryId !== expectedWitness.candidateTrajectoryId) ||
            (expectedWitness.cutStepIdx !== undefined &&
              finalFork.cutStep !== expectedWitness.cutStepIdx) ||
            !idMapMatches
          ) {
            cancelJob(
              'protocol_error',
              new Error(
                'Antigravity Fork final result disagrees with committed candidate witness.',
              ),
            )
            return
          }
          forkState = 'result_received'
        }
        if (postExitDrainTimer !== undefined) {
          clearTimeout(postExitDrainTimer)
          postExitDrainTimer = undefined
        }
        postExitDrainPending = false
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Action discriminant was verified equal to request.action and validated by agyStoragePortResultMessageSchema.
        resolveResult(msg.result as AgyStorageResultByAction[K])
        sendResultAck(openedSession)
        if (childExited) {
          settlePhysical()
        } else if (openedSession) {
          armPostResultExitGuard(openedSession)
        }
        return
      }

      // msg.type === 'error'
      if (msg.code === 'EEXIST') {
        // Never unlink a pre-existing staging entry after an O_EXCL creation collision.
        cleanupAuthorized = false
      }
      if (postExitDrainTimer !== undefined) {
        clearTimeout(postExitDrainTimer)
        postExitDrainTimer = undefined
      }
      postExitDrainPending = false
      const parsedKind = runFailureKindSchema.safeParse(msg.errorKind)
      const kind = parsedKind.success ? parsedKind.data : 'protocol_error'
      rejectResult(
        Object.assign(
          new AgentExecutionError(kind, msg.message, false),
          msg.code !== undefined ? { code: msg.code } : {},
        ),
      )
      sendResultAck(openedSession)
      if (childExited) {
        settlePhysical()
      } else if (openedSession) {
        armPostResultExitGuard(openedSession)
      }
    }

    const openRequest = agyStorageOpenRequestSchema.parse({
      type: 'agy-storage.open.request',
      jobKey,
      action: effectiveInput.action,
      deadlineAt: effectiveDeadlineAt,
      workingBytes: NATIVE_OWNER_WORKING_BYTES,
    })

    void transport.open(openRequest).then(
      (session) => {
        try {
          // Install ALL exit/cancel/cleanup wiring BEFORE notifying observers or sending requests.
          openedSession = session
          settleTrafficTransport = traffic?.beginTransport()
          session.exited.then(
            (closedEvent) => onSessionExit(closedEvent),
            () => onSessionExit(undefined),
          )
          session.port.onMessage(onPortMessage)

          if (cancelled || this.disposed || control.signal.aborted) {
            cancelJob(cancelled ? cancelReason : 'aborted')
            return undefined
          }

          try {
            this.notifyPhysicalObservers(control.signal, physicalDeferred.promise)
          } catch (observerError) {
            cancelJob('aborted', observerError)
            return undefined
          }

          if (cancelled || this.disposed || control.signal.aborted) {
            cancelJob(cancelled ? cancelReason : 'aborted')
            return undefined
          }

          if (candidateStagingCleanup) {
            candidateStagingSnapshot = snapshotCandidateStagingBeforeSend(
              candidateStagingCleanup.storageRoot,
              candidateStagingCleanup.candidateSessionId,
              candidateStagingCleanup.stagingLeafName,
            )
          }

          const initMeasurement = traffic ? logicalIpcMeasurement(wireRequest) : undefined
          try {
            session.port.postMessage(wireRequest)
            if (candidateStagingSnapshot && !candidateStagingSnapshot.preExistingSuffixes.has('')) {
              cleanupAuthorized = true
            }
            if (traffic && initMeasurement) {
              traffic.recordMeasurement('utility-native-fork.init', 'business', initMeasurement)
            }
          } catch (postError) {
            traffic?.invalidate('transport_error')
            cancelJob('protocol_error', postError)
          }
        } catch (setupError) {
          // NEVER mark childExited = true after transport.open succeeded: cancel and await real exit.
          cancelJob('protocol_error', setupError)
        }
        return undefined
      },
      (openError: unknown) => {
        const pendingExit = readUnknownStateExitPromise(openError)
        const errCode = openError instanceof Error ? Reflect.get(openError, 'code') : undefined
        if (errCode === 'TIMEOUT') {
          rejectResult(createTimeoutError())
        } else if (cancelled || errCode === 'CANCELLED' || errCode === 'DISPOSED') {
          rejectResult(createAbortError())
        } else {
          rejectResult(openError)
        }
        if (pendingExit) {
          // Unknown-state open failure (missing transferred port or pending-open dispose):
          // retain active job & memory reservation until Main confirms physical exit!
          try {
            this.notifyPhysicalObservers(control.signal, physicalDeferred.promise)
          } catch {
            /* Already awaiting confirmed exit. */
          }
          pendingExit.then(
            (closedEvent) => onSessionExit(closedEvent),
            () => onSessionExit(undefined),
          )
          return undefined
        }
        childExited = true
        settlePhysical()
        return undefined
      },
    )

    return {
      result: resultDeferred.promise,
      physical: physicalDeferred.promise,
      cancel: () => cancelJob('aborted', createAbortError()),
    }
  }

  async dispose(deadlineAt?: number): Promise<void> {
    this.disposed = true
    const current = [...this.activeJobs]
    for (const job of current) {
      job.cancel('disposed')
    }
    if (current.length === 0) return
    const allSettled = Promise.all(current.map((job) => job.physical)).then(() => true)
    if (deadlineAt === undefined) {
      await allSettled
      return
    }
    const remainingMs = Math.max(0, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const confirmed = await Promise.race([
      allSettled,
      new Promise<boolean>((resolveTimer) => {
        timer = setTimeout(() => resolveTimer(false), remainingMs)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (!confirmed) {
      throw Object.assign(
        new Error(
          'Antigravity isolated storage child process did not confirm exit before deadline.',
        ),
        { code: 'unconfirmed_process' },
      )
    }
  }

  private resolveTransport(): AgyStorageTransport {
    return this.options.transport ?? configuredDefaultTransport ?? this.fallbackNodeTransport
  }

  private notifyPhysicalObservers(signal: AbortSignal, physical: Promise<void>): void {
    this.options.onPhysicalOperation?.(signal, physical)
    for (const observer of this.physicalObservers) {
      observer(signal, physical)
    }
  }
}
