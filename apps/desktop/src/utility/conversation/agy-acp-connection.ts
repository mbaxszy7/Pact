import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import type {
  ConfirmedUnsentBoundary,
  ConfirmedUnsentProof,
  RunEffectiveExecutionSettings,
  SessionPermissionMode,
} from '@pact/contracts'

import {
  diagnosticNativeMethodSchema,
  type DiagnosticEvent,
  type DiagnosticFailureSource,
} from '@pact/contracts/diagnostics'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../owned-process-group'
import {
  AgentExecutionError,
  NativeCapacityError,
  PermissionModeRejectedError,
} from './agent-execution-error'
import {
  NATIVE_FRAME_WRITE_CHUNK_BYTES,
  NativeFrameWriteError,
  writeNativeFrame,
} from './native-frame-writer'
import { encodeNativeJsonFrame, freezeNativeJsonFrame } from './native-json-encoder'
import { parseNativeJsonFrame } from './native-json-parser'
import { NativePermissionWait, safeNativePermissionText } from './native-permission-wait'
import {
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
  type NativeMemoryAllocator,
  type NativeMemoryReservation,
} from './native-working-memory'

export const AGY_MAX_FRAME_BYTES = NATIVE_OWNER_WORKING_BYTES / 8
export const AGY_QUEUE_HIGH_WATER_BYTES = 4 * 1024 * 1024
export const AGY_QUEUE_LOW_WATER_BYTES = 2 * 1024 * 1024
export const AGY_QUEUE_HARD_LIMIT_BYTES = 8 * 1024 * 1024
export const AGY_QUEUE_MESSAGE_LIMIT = 4_096
export const AGY_PENDING_REQUEST_LIMIT = 64
export const AGY_MAX_CONTEXTS = 8
export const AGY_OUTBOUND_DRAIN_TIMEOUT_MS = 10_000
export const AGY_INITIALIZATION_TIMEOUT_MS = 10_000
export const AGY_CONTROL_RPC_TIMEOUT_MS = 15_000
export const AGY_PROMPT_ACCEPT_TIMEOUT_MS = 30_000
export const AGY_IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000
export const AGY_SHUTDOWN_TIMEOUT_MS = 2_000
const AGY_FORCE_EXIT_TIMEOUT_MS = 1_000
export const AGY_STDERR_LIMIT_BYTES = 16 * 1024
const AGY_INLINE_ENCODING_MEMORY_BYTES = 256 * 1024
const AGY_PARSE_WORKSPACE_MULTIPLIER = 8
const AGY_FRAME_WORKSPACE_BYTES = 4 * NATIVE_FRAME_WRITE_CHUNK_BYTES

export type AgyPermissionScope = 'standard' | 'full'
export type AgyRequestPhysicalCompletion = 'reply' | 'not_sent' | 'connection_closed'

export interface AgyRequestOperation {
  readonly requestId: number
  result: Promise<object>
  /** Resolves strictly to `not_sent` only when zero bytes of this frame entered NativeFrameWriter. */
  physicalCompletion: Promise<AgyRequestPhysicalCompletion>
}

export interface AgyConnectionDiagnostics {
  pendingRequests: number
  pendingPhysicalRequests: number
  queuedMessages: number
  queuedInboundBytes: number
  queuedOutboundFrames: number
  queuedOutboundBytes: number
  waitingForNotification: boolean
  stdoutPaused: boolean
  open: boolean
}

export interface AgySessionNotificationStream {
  readonly sessionId: string
  shift(): object | undefined
  next(timeoutMs?: number, signal?: AbortSignal): Promise<object>
  close(): void
}

export interface AgyServerRequestOwnerHandle {
  updateSessionId(sessionId: string | undefined): void
  dispose(): void
}

interface RegisteredServerRequestOwner {
  readonly ownerId: string
  knownSessionId: string | undefined
  readonly handler: (message: object) => boolean
}

interface PendingRequest {
  diagnostic: DiagnosticEvent
  startedAt: number
  resolve: ((message: object) => void) | undefined
  reject: ((error: Error) => void) | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
  logicalSettled: boolean
  dispatched: boolean
  writeJoined: boolean
  replied: boolean
  physicalResolve: (result: AgyRequestPhysicalCompletion) => void
}

interface QueuedNotification {
  sessionId?: string | undefined
  message: object
  bytes: number
  reservation: NativeMemoryReservation
}

interface NotificationWaiter {
  resolve: (message: object) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
}

interface SessionNotificationConsumer {
  readonly sessionId: string
  readonly queue: Array<QueuedNotification | undefined>
  head: number
  waiter: NotificationWaiter | undefined
  closed: boolean
}

interface OutboundFrame {
  message: object
  expiresAt: number
  bytes?: Buffer | undefined
  heldBytes: number
  released: boolean
  reservation: NativeMemoryReservation
  controller: AbortController
  requestId?: number | undefined
  resolve: () => void
  reject: (error: Error) => void
  onDispatch?: (() => void) | undefined
  canDispatch?: (() => boolean) | undefined
  cancelBeforeWriteSignal?: AbortSignal | undefined
  physicalResolve?: (() => void) | undefined
}

function loopbackProxyExclusions(value: string | undefined): string {
  if (value !== undefined && (typeof value !== 'string' || value.includes('\0')))
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Invalid Antigravity proxy exclusions.',
      false,
    )
  const original = value ?? ''
  if (Buffer.byteLength(original) > 8192)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Antigravity proxy exclusions exceed 8 KiB.',
      false,
    )
  const entries = original.split(',')
  if (entries.length > 256)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Antigravity proxy exclusions exceed 256 entries.',
      false,
    )
  const excluded = new Set(entries.map((entry) => entry.trim().toLowerCase()))
  const missing = ['127.0.0.1', 'localhost'].filter((host) => !excluded.has(host))
  const result = missing.length ? original + (original ? ',' : '') + missing.join(',') : original
  if (Buffer.byteLength(result) > 8192 || result.split(',').length > 256)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Antigravity loopback exclusions exceed their capacity.',
      false,
    )
  return result
}

/** Child-only loopback exclusions so local Streamable HTTP MCP servers bypass ambient HTTP proxies. */
export function agyProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source }
  if (platform === 'win32') {
    const keys = Object.keys(environment)
      .filter((key) => key.toUpperCase() === 'NO_PROXY')
      .toSorted()
    const prior = keys.length ? environment[keys[0]!] : undefined
    for (const key of keys) delete environment[key]
    environment.NO_PROXY = loopbackProxyExclusions(prior)
  } else {
    environment.NO_PROXY = loopbackProxyExclusions(source.NO_PROXY ?? source.no_proxy)
    environment.no_proxy = loopbackProxyExclusions(source.no_proxy ?? source.NO_PROXY)
  }
  return environment
}

export function hashEffectiveExecutionSettings(settings: RunEffectiveExecutionSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex')
}

export interface AgyUnsentProofBindingInput {
  runId: string
  bindingGeneration: number
  nativeGeneration: string
  executorId: string
  nativeSessionId: string
  inputSha256: string
  appliedSettings: RunEffectiveExecutionSettings
  requestId: number
  physicalCompletion: AgyRequestPhysicalCompletion
}

/**
 * Issues an `agy_root_frame_not_written` proof ONLY when physical writer completion proves
 * zero bytes of `session/prompt` entered `NativeFrameWriter`, bound to
 * `(executorId, bindingGeneration, inputHash, appliedSettings)`.
 */
export function createAgyRootFrameNotWrittenProof(
  input: AgyUnsentProofBindingInput,
): { boundary: ConfirmedUnsentBoundary; proof: ConfirmedUnsentProof } | undefined {
  if (input.physicalCompletion !== 'not_sent') return undefined
  if (
    !Number.isSafeInteger(input.requestId) ||
    input.requestId < 0 ||
    !Number.isSafeInteger(input.bindingGeneration) ||
    input.bindingGeneration <= 0 ||
    !/^[a-f0-9]{64}$/u.test(input.inputSha256) ||
    !input.executorId ||
    input.executorId.length > 1024 ||
    !input.nativeSessionId ||
    input.nativeSessionId.length > 1024 ||
    input.appliedSettings.provider !== 'agy' ||
    input.appliedSettings.provenance !== 'agy_applied_settings'
  ) {
    return undefined
  }
  const boundary: ConfirmedUnsentBoundary = {
    kind: 'agy_root_frame_not_written',
    requestId: input.requestId,
  }
  const proof: ConfirmedUnsentProof = {
    version: 1,
    runId: input.runId,
    bindingGeneration: input.bindingGeneration,
    nativeGeneration: input.nativeGeneration,
    executorId: input.executorId,
    nativeSessionId: input.nativeSessionId,
    inputSha256: input.inputSha256,
    effectiveSettingsSha256: hashEffectiveExecutionSettings(input.appliedSettings),
    boundary,
  }
  if (Buffer.byteLength(JSON.stringify(proof), 'utf8') >= 4096) return undefined
  return { boundary, proof }
}

function extractNotificationSessionId(message: object): string | undefined {
  const params = Reflect.get(message, 'params')
  if (!params || typeof params !== 'object') return undefined
  const candidate = Reflect.get(params, 'sessionId') ?? Reflect.get(params, 'session_id')
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
    ? candidate
    : undefined
}

function extractServerRequestSessionId(message: object): string | undefined {
  const params = Reflect.get(message, 'params')
  if (!params || typeof params !== 'object') return undefined
  const direct = Reflect.get(params, 'sessionId') ?? Reflect.get(params, 'session_id')
  if (typeof direct === 'string' && direct.length > 0 && direct.length <= 1024) {
    return direct
  }
  const meta = Reflect.get(params, '_meta')
  if (!meta || typeof meta !== 'object') return undefined
  const metaCandidate =
    Reflect.get(meta, 'antigravity.google/root_conversation_id') ??
    Reflect.get(meta, 'antigravity.google/conversation_id') ??
    Reflect.get(meta, 'conversation_id')
  return typeof metaCandidate === 'string' &&
    metaCandidate.length > 0 &&
    metaCandidate.length <= 1024
    ? metaCandidate
    : undefined
}

export class AgyAcpConnection {
  readonly executorId = randomUUID()
  private readonly memory: NativeMemoryAllocator
  private readonly inboundController = new AbortController()
  private frameReservation: NativeMemoryReservation | undefined
  private inboundProcessing = false
  private activeInboundReservation: NativeMemoryReservation | undefined
  private frameDeadline: ReturnType<typeof setTimeout> | undefined
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly backgroundListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestOwners = new Map<string, RegisteredServerRequestOwner>()
  private readonly sessionConsumers = new Map<string, SessionNotificationConsumer>()
  private readonly permissionWait = new NativePermissionWait()
  private readonly notificationQueue: Array<QueuedNotification | undefined> = []
  private readonly outboundQueue: Array<OutboundFrame | undefined> = []
  private notificationHead = 0
  private outboundHead = 0
  private notificationWaiter: NotificationWaiter | undefined
  private frameChunks: Buffer[] = []
  private receiveTask: Promise<void> | undefined
  private parserCompletion: Promise<void> | undefined
  private outboundWriteTask: Promise<void> | undefined
  private readonly processClosed: Promise<void>
  private frameBytes = 0
  private queuedInboundBytes = 0
  private queuedInboundCount = 0
  private queuedOutboundBytes = 0
  private nextRequestId = 0
  private writing = false
  private activeOutboundFrame: OutboundFrame | undefined
  private stdoutPaused = false
  private notificationQueuePaused = false
  private closed = false
  private shutdownPromise: Promise<void> | undefined
  private shutdownDeadlineAt: number | undefined
  private closeError: Error | undefined
  private exitRecorded = false
  private observedCloseError: Error | undefined
  private rawStderr = ''
  private stderrBytes = 0

  private readonly receive = (chunk: Buffer): void => {
    this.inboundProcessing = true
    this.updateStdoutPause()
    const task = this.receiveChunk(chunk)
      .catch((error: unknown) => {
        void this.close(
          error instanceof Error ? error : new Error('Native ACP frame read failed.'),
        ).catch(() => undefined)
      })
      .finally(() => {
        this.inboundProcessing = false
        if (this.observedCloseError) {
          this.fail(this.observedCloseError, 'process_exit')
          void this.close(this.observedCloseError).catch(() => undefined)
        }
        this.updateStdoutPause()
      })
    this.receiveTask = task
  }

  private readonly receiveError = (chunk: Buffer): void => {
    const remaining = AGY_STDERR_LIMIT_BYTES - this.stderrBytes
    if (remaining <= 0) return
    const bounded = chunk.subarray(0, remaining)
    this.stderrBytes += bounded.length
    // Sanitize immediately on retention so credentials, tokens, or auth URLs never stay in memory.
    this.rawStderr = safeNativePermissionText(
      this.rawStderr + bounded.toString('utf8'),
      AGY_STDERR_LIMIT_BYTES,
    )
  }

  private readonly exited = (code: number | null): void => {
    this.recordExit(code)
    const error = new AgentExecutionError(
      'agent_process_crash',
      this.stderrText || 'Antigravity ACP server exited.',
      true,
    )
    if (this.inboundProcessing) this.observedCloseError = error
    else {
      this.fail(error, 'process_exit')
      void this.close(error).catch(() => undefined)
    }
  }

  private readonly processExited = (code: number | null): void => this.recordExit(code)

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly canonicalCwd: string,
    readonly permissionScope: AgyPermissionScope,
    private readonly onClosed?: () => void,
    private readonly closeOwnedProcess?: (deadlineAt?: number) => Promise<void>,
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    private readonly isLifetimeCurrent?: () => boolean,
    private readonly observePhysicalOperation?: (
      signal: AbortSignal | undefined,
      physicalCompletion: Promise<unknown>,
    ) => void,
    private readonly onPhysicalWorkIdle?: () => void,
  ) {
    this.processClosed = new Promise((resolve) => child.once('close', () => resolve()))
    this.memory = new NativeWorkingMemory()
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'started',
      executorId: this.executorId,
      agentId: 'agy',
      ...(child.pid ? { pid: child.pid } : {}),
    })
    child.stdout.on('data', this.receive)
    child.stderr.on('data', this.receiveError)
    child.once('exit', this.processExited)
    child.once('close', this.exited)
  }

  get isOpen(): boolean {
    return !this.closed && this.child.exitCode === null
  }

  get isProcessAlive(): boolean {
    return !this.exitRecorded && this.child.exitCode === null
  }

  whenProcessExited(): Promise<void> {
    return this.processClosed
  }

  get totalActiveOrInitializingOwners(): number {
    return this.serverRequestOwners.size
  }

  get stderrText(): string {
    return safeNativePermissionText(this.rawStderr.trim(), AGY_STDERR_LIMIT_BYTES)
  }

  hasPendingPhysicalWork(): boolean {
    return (
      this.pendingRequests.size > 0 ||
      this.writing ||
      this.outboundQueue.length > this.outboundHead ||
      this.sessionConsumers.size > 0
    )
  }

  reserveWorkingMemory(bytes: number): NativeMemoryReservation {
    return this.memory.reserve(bytes)
  }

  diagnostics(): AgyConnectionDiagnostics {
    const waitingSessionConsumer = [...this.sessionConsumers.values()].some((c) =>
      Boolean(c.waiter),
    )
    return {
      pendingRequests: [...this.pendingRequests.values()].filter(
        (request) => !request.logicalSettled,
      ).length,
      pendingPhysicalRequests: this.pendingRequests.size,
      queuedMessages: this.queuedInboundCount,
      queuedInboundBytes: this.queuedInboundBytes,
      queuedOutboundFrames: this.outboundQueue.length - this.outboundHead,
      queuedOutboundBytes: this.queuedOutboundBytes,
      waitingForNotification: Boolean(this.notificationWaiter) || waitingSessionConsumer,
      stdoutPaused: this.stdoutPaused,
      open: this.isOpen,
    }
  }

  request(
    method: string,
    params: object,
    options: {
      timeoutMs: number | undefined
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
    },
  ): Promise<object> {
    return this.requestOwned(method, params, options).result
  }

  requestOwned(
    method: string,
    params: object,
    options: {
      timeoutMs: number | undefined
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
    },
  ): AgyRequestOperation {
    const id = this.nextRequestId
    this.nextRequestId += 1

    if (options.signal?.aborted) {
      return {
        requestId: id,
        result: Promise.reject(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
      }
    }
    if (this.pendingRequests.size >= AGY_PENDING_REQUEST_LIMIT) {
      return {
        requestId: id,
        result: Promise.reject(
          new AgentExecutionError(
            'protocol_error',
            'Antigravity exceeded Pact’s pending request budget.',
            false,
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
      }
    }

    let physicalResolve!: PendingRequest['physicalResolve']
    const physicalCompletion = new Promise<AgyRequestPhysicalCompletion>((resolve) => {
      physicalResolve = resolve
    })
    this.observePhysicalOperation?.(options.signal, physicalCompletion)

    const response = new Promise<object>((resolve, reject) => {
      const expired = (): void => {
        this.settleRequest(
          id,
          new AgentExecutionError(
            'transient_transport',
            `Antigravity did not answer ${method} before its deadline.`,
            true,
          ),
          undefined,
          'timeout',
        )
      }
      const methodName = diagnosticNativeMethodSchema.safeParse(method)
      const pending: PendingRequest = {
        startedAt: Date.now(),
        diagnostic: {
          operation: 'process',
          scope: 'request',
          phase: 'started',
          level: 'debug',
          agentId: 'agy',
          operationId: randomUUID(),
          executorId: this.executorId,
          nativeMethod: methodName.success ? methodName.data : 'unrecognized',
        },
        resolve,
        reject,
        timeout: undefined,
        signal: options.signal,
        logicalSettled: false,
        dispatched: false,
        writeJoined: false,
        replied: false,
        physicalResolve,
      }
      const arm = (): void => {
        clearTimeout(pending.timeout)
        pending.timeout =
          this.permissionWait.waiting || options.timeoutMs === undefined
            ? undefined
            : setTimeout(expired, options.timeoutMs)
      }
      pending.pauseCleanup = this.permissionWait.subscribe(arm)
      arm()
      if (options.signal) {
        pending.abort = (): void => {
          this.settleRequest(
            id,
            new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
            undefined,
            'cancelled',
          )
        }
        options.signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.pendingRequests.set(id, pending)
      this.updateStdoutPause()
      recordDiagnostic(pending.diagnostic)
    })

    const writing = this.enqueue(
      { jsonrpc: '2.0', method, id, params },
      {
        requestId: id,
        onDispatch: () => {
          const pending = this.pendingRequests.get(id)
          options.onDispatch?.()
          if (pending) pending.dispatched = true
        },
        canDispatch: options.canDispatch,
      },
    )
    void writing.catch((error: unknown) => {
      this.settleRequest(id, error instanceof Error ? error : new Error(String(error)))
    })
    return { requestId: id, result: response, physicalCompletion }
  }

  async notify(
    method: string,
    params: object,
    options: { signal?: AbortSignal | undefined; canDispatch?: (() => boolean) | undefined } = {},
  ): Promise<void> {
    await this.enqueue(
      { jsonrpc: '2.0', method, params },
      { canDispatch: options.canDispatch, cancelBeforeWriteSignal: options.signal },
    )
  }

  async respond(id: string | number, result: object): Promise<void> {
    if (
      (typeof id === 'string' && id.length > 1024) ||
      (typeof id === 'number' && !Number.isSafeInteger(id))
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned an invalid request identity.',
        false,
      )
    }
    await this.enqueue({ jsonrpc: '2.0', id, result }, {})
  }

  async respondError(id: string | number, message: string, code = -32_601): Promise<void> {
    if (
      (typeof id === 'string' && id.length > 1024) ||
      (typeof id === 'number' && !Number.isSafeInteger(id))
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned an invalid request identity.',
        false,
      )
    }
    await this.enqueue(
      {
        jsonrpc: '2.0',
        id,
        error: { code, message: safeNativePermissionText(message, 1024) },
      },
      {},
    )
  }

  subscribeBackground(listener: (message: object) => boolean): () => void {
    if (this.backgroundListeners.size >= 9)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity background observers.',
        false,
      )
    this.backgroundListeners.add(listener)
    return () => this.backgroundListeners.delete(listener)
  }

  subscribeServerRequests(listener: (message: object) => boolean): () => void {
    if (this.serverRequestListeners.size >= 8)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity server request handlers.',
        false,
      )
    this.serverRequestListeners.add(listener)
    this.updateStdoutPause()
    return () => {
      this.serverRequestListeners.delete(listener)
      this.updateStdoutPause()
    }
  }

  registerServerRequestOwner(input: {
    ownerId: string
    knownSessionId?: string | undefined
    handler: (message: object) => boolean
  }): AgyServerRequestOwnerHandle {
    if (!input.ownerId || input.ownerId.length > 1024) {
      throw new AgentExecutionError(
        'protocol_error',
        'Invalid Antigravity server request owner identity.',
        false,
      )
    }
    if (
      !this.serverRequestOwners.has(input.ownerId) &&
      this.serverRequestOwners.size >= AGY_MAX_CONTEXTS * 2
    ) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity server request owners.',
        false,
      )
    }
    const entry: RegisteredServerRequestOwner = {
      ownerId: input.ownerId,
      knownSessionId: input.knownSessionId,
      handler: input.handler,
    }
    this.serverRequestOwners.set(input.ownerId, entry)
    this.updateStdoutPause()
    return {
      updateSessionId: (sessionId: string | undefined) => {
        entry.knownSessionId = sessionId
      },
      dispose: () => {
        if (this.serverRequestOwners.get(input.ownerId) === entry) {
          this.serverRequestOwners.delete(input.ownerId)
          this.updateStdoutPause()
        }
      },
    }
  }

  beginPermissionWait(): () => void {
    return this.permissionWait.begin()
  }

  /**
   * Opens a dedicated notification consumer for one ACP `sessionId` so concurrent sessions
   * (e.g. main chat + Side Chat sharing the same project CWD pool) never collide.
   */
  openSessionStream(sessionId: string): AgySessionNotificationStream {
    if (!sessionId || sessionId.length > 1024)
      throw new AgentExecutionError('protocol_error', 'Invalid ACP session identity.', false)
    if (this.sessionConsumers.has(sessionId))
      throw new AgentExecutionError(
        'protocol_error',
        'This ACP session already has an active notification stream.',
        false,
      )
    if (this.sessionConsumers.size >= AGY_MAX_CONTEXTS)
      throw new NativeCapacityError('Antigravity session stream capacity is full.')

    const consumer: SessionNotificationConsumer = {
      sessionId,
      queue: [],
      head: 0,
      waiter: undefined,
      closed: false,
    }
    // Transfer any early notifications for this exact sessionId that arrived during session/new or session/load.
    for (let i = this.notificationHead; i < this.notificationQueue.length; i += 1) {
      const entry = this.notificationQueue[i]
      if (!entry || entry.sessionId !== sessionId) continue
      this.notificationQueue[i] = undefined
      consumer.queue.push(entry)
    }
    const remaining = this.notificationQueue
      .slice(this.notificationHead)
      .filter((entry): entry is QueuedNotification => entry !== undefined)
    this.notificationQueue.splice(0, this.notificationQueue.length, ...remaining)
    this.notificationHead = 0
    this.sessionConsumers.set(sessionId, consumer)

    return {
      sessionId,
      shift: () => {
        if (consumer.closed) return undefined
        const queued = consumer.queue[consumer.head]
        if (!queued) return undefined
        consumer.queue[consumer.head] = undefined
        consumer.head += 1
        this.queuedInboundBytes -= queued.bytes
        this.queuedInboundCount -= 1
        queued.reservation.release()
        if (consumer.head >= 512 && consumer.head * 2 >= consumer.queue.length) {
          consumer.queue.splice(0, consumer.head)
          consumer.head = 0
        }
        this.resumeStdoutIfNeeded()
        return queued.message
      },
      next: (timeoutMs?: number, signal?: AbortSignal) =>
        this.nextSessionNotification(consumer, timeoutMs, signal),
      close: () => {
        if (consumer.closed) return
        consumer.closed = true
        if (this.sessionConsumers.get(sessionId) === consumer) {
          this.sessionConsumers.delete(sessionId)
        }
        if (consumer.waiter) {
          const waiter = consumer.waiter
          consumer.waiter = undefined
          this.cleanupNotificationWaiter(waiter)
          waiter.reject(
            new AgentExecutionError('agent_process_crash', 'Session stream closed.', false),
          )
        }
        for (let i = consumer.head; i < consumer.queue.length; i += 1) {
          const item = consumer.queue[i]
          if (!item) continue
          consumer.queue[i] = undefined
          this.queuedInboundBytes -= item.bytes
          this.queuedInboundCount -= 1
          item.reservation.release()
        }
        consumer.queue.length = 0
        consumer.head = 0
        this.updateStdoutPause()
        this.notifyPhysicalWorkIdleIfSettled()
      },
    }
  }

  nextNotification(timeoutMs: number | undefined, signal?: AbortSignal): Promise<object> {
    if (signal?.aborted) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.notificationQueue[this.notificationHead]
    if (queued) {
      this.notificationQueue[this.notificationHead] = undefined
      this.notificationHead += 1
      this.queuedInboundBytes -= queued.bytes
      this.queuedInboundCount -= 1
      queued.reservation.release()
      this.compactNotificationQueue()
      this.resumeStdoutIfNeeded()
      return Promise.resolve(queued.message)
    }
    if (!this.isOpen) {
      return Promise.reject(this.closeError ?? new Error('Antigravity ACP server is unavailable.'))
    }
    if (this.notificationWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity has more than one global notification consumer.',
          false,
        ),
      )
    }
    return this.createWaiter(
      timeoutMs,
      signal,
      (waiter) => {
        this.notificationWaiter = waiter
      },
      () => {
        this.settleNotificationWaiter(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity produced no progress before the deadline.',
            true,
          ),
        )
      },
      () => {
        this.settleNotificationWaiter(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  private nextSessionNotification(
    consumer: SessionNotificationConsumer,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<object> {
    if (signal?.aborted || consumer.closed) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = consumer.queue[consumer.head]
    if (queued) {
      consumer.queue[consumer.head] = undefined
      consumer.head += 1
      this.queuedInboundBytes -= queued.bytes
      this.queuedInboundCount -= 1
      queued.reservation.release()
      if (consumer.head >= 512 && consumer.head * 2 >= consumer.queue.length) {
        consumer.queue.splice(0, consumer.head)
        consumer.head = 0
      }
      this.resumeStdoutIfNeeded()
      return Promise.resolve(queued.message)
    }
    if (!this.isOpen) {
      return Promise.reject(this.closeError ?? new Error('Antigravity ACP server is unavailable.'))
    }
    if (consumer.waiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return this.createWaiter(
      timeoutMs,
      signal,
      (waiter) => {
        consumer.waiter = waiter
      },
      () => {
        const waiter = consumer.waiter
        if (!waiter) return
        consumer.waiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.reject(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity did not accept or advance the session before its deadline.',
            true,
          ),
        )
      },
      () => {
        const waiter = consumer.waiter
        if (!waiter) return
        consumer.waiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  private createWaiter(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    install: (waiter: NotificationWaiter) => void,
    onExpired: () => void,
    onAborted: () => void,
  ): Promise<object> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = { resolve, reject, timeout: undefined, signal }
      const arm = (): void => {
        clearTimeout(waiter.timeout)
        waiter.timeout =
          this.permissionWait.waiting || timeoutMs === undefined
            ? undefined
            : setTimeout(onExpired, timeoutMs)
      }
      waiter.pauseCleanup = this.permissionWait.subscribe(arm)
      arm()
      if (signal) {
        waiter.abort = onAborted
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      install(waiter)
    })
  }

  capShutdownDeadline(deadlineAt: number): void {
    if (this.shutdownPromise) return
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)
      throw new Error('Invalid Antigravity shutdown deadline.')
    this.shutdownDeadlineAt = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
  }

  async close(error = new Error('Antigravity ACP connection closed.')): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // oxlint-disable-next-line promise/no-promise-in-callback -- Publish completion before onClosed can reenter.
    const completion = Promise.withResolvers<void>()
    this.shutdownPromise = completion.promise
    if (!this.closed) this.fail(error)
    // oxlint-disable-next-line promise/no-promise-in-callback -- close accepts an Error, not a callback.
    void (async () => {
      await this.shutdown()
      await this.processClosed
      await this.outboundWriteTask
      await this.receiveTask
      await this.parserCompletion
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id)
        pending.physicalResolve('connection_closed')
      }
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async receiveChunk(chunk: Buffer): Promise<void> {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.subarray(offset, end)
      if (fragment.length > 0) {
        if (!this.frameDeadline) {
          this.frameDeadline = setTimeout(() => {
            void this.close(
              new AgentExecutionError(
                'protocol_error',
                'Native ACP JSONL framing exceeded its ten-second deadline.',
                false,
              ),
            ).catch(() => undefined)
          }, 10_000)
        }
        this.frameBytes += fragment.length
        if (this.frameBytes > AGY_MAX_FRAME_BYTES) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Antigravity ACP frame exceeded the 16 MiB single-frame bound.',
            false,
          )
        }
        this.frameReservation ??= this.memory.reserve(AGY_FRAME_WORKSPACE_BYTES)
        this.frameReservation.resize(
          AGY_FRAME_WORKSPACE_BYTES + this.frameBytes * AGY_PARSE_WORKSPACE_MULTIPLIER,
        )
        this.frameChunks.push(fragment)
      }
      if (newline === -1) return
      const frame = Buffer.concat(this.frameChunks, this.frameBytes)
      this.frameChunks = []
      this.frameBytes = 0
      const reservation = this.frameReservation ?? this.memory.reserve(AGY_FRAME_WORKSPACE_BYTES)
      this.frameReservation = undefined
      this.activeInboundReservation = reservation
      try {
        // oxlint-disable-next-line no-await-in-loop -- One logical JSONL frame at a time with stdout backpressure.
        await this.receiveFrame(frame, reservation)
      } finally {
        if (this.activeInboundReservation === reservation) this.activeInboundReservation = undefined
        clearTimeout(this.frameDeadline)
        this.frameDeadline = undefined
      }
      if (this.closed) return
      offset = newline + 1
    }
  }

  private async receiveFrame(
    rawFrame: Buffer,
    reservation: NativeMemoryReservation,
  ): Promise<void> {
    let retained = false
    let parserPhysical: Promise<void> | undefined
    try {
      const wireBytes = rawFrame.length + 1
      const frame = rawFrame.at(-1) === 0x0d ? rawFrame.subarray(0, -1) : rawFrame
      if (frame.length === 0) return
      let message: unknown
      let heldBytes: number
      if (frame.length <= AGY_INLINE_ENCODING_MEMORY_BYTES) {
        message = JSON.parse(this.decoder.decode(frame))
        heldBytes = freezeNativeJsonFrame(message)
      } else {
        const parsed = await parseNativeJsonFrame(
          frame,
          this.inboundController.signal,
          this.ipcTraffic,
          (completion) => {
            parserPhysical = completion
            this.parserCompletion = completion
          },
        )
        message = parsed.message
        heldBytes = parsed.heldBytes
      }
      if (this.closed || !message || typeof message !== 'object') return
      reservation.resize(Math.max(reservation.bytes, heldBytes))

      const id = Reflect.get(message, 'id')
      if (
        typeof Reflect.get(message, 'method') !== 'string' &&
        typeof id === 'number' &&
        this.pendingRequests.has(id)
      ) {
        this.settleRequest(id, undefined, message)
        return
      }
      if (Object.hasOwn(message, 'id') && typeof Reflect.get(message, 'method') !== 'string') return

      for (const listener of this.backgroundListeners) {
        if (listener(message)) return
      }

      if (Object.hasOwn(message, 'id') && typeof Reflect.get(message, 'method') === 'string') {
        if (this.serverRequestOwners.size > 0) {
          const reqSessionId = extractServerRequestSessionId(message)
          if (reqSessionId !== undefined) {
            // Deliver ONLY to the unique registered owner whose knownSessionId matches reqSessionId;
            // never let an initializing owner (`knownSessionId === undefined`) claim another session's request!
            let matchedOwner: RegisteredServerRequestOwner | undefined
            let matchedCount = 0
            for (const owner of this.serverRequestOwners.values()) {
              if (owner.knownSessionId !== undefined && owner.knownSessionId === reqSessionId) {
                matchedOwner = owner
                matchedCount += 1
              }
            }
            if (matchedCount === 1 && matchedOwner?.handler(message)) {
              return
            }
          } else if (this.serverRequestOwners.size === 1) {
            // Unscoped request without sessionId: deliver ONLY when exactly 1 owner is active/initializing across the entire connection!
            const soleOwner = this.serverRequestOwners.values().next().value
            if (soleOwner?.handler(message)) {
              return
            }
          }
          if (typeof id === 'string' || typeof id === 'number') {
            await this.respondError(id, 'No active session handler accepted this ACP request.')
          }
          return
        }
        for (const listener of this.serverRequestListeners) {
          if (listener(message)) return
        }
        if (typeof id === 'string' || typeof id === 'number') {
          await this.respondError(id, 'No active session handler accepted this ACP request.')
        }
        return
      }

      const sessionId = extractNotificationSessionId(message)
      const sessionConsumer = sessionId ? this.sessionConsumers.get(sessionId) : undefined
      if (sessionConsumer && !sessionConsumer.closed) {
        if (sessionConsumer.waiter) {
          const waiter = sessionConsumer.waiter
          sessionConsumer.waiter = undefined
          this.cleanupNotificationWaiter(waiter)
          waiter.resolve(message)
          return
        }
        this.admitQueuedNotification(wireBytes, heldBytes, reservation)
        sessionConsumer.queue.push({ sessionId, message, bytes: wireBytes, reservation })
        retained = true
        this.updateStdoutPause()
        return
      }

      if (this.notificationWaiter) {
        const waiter = this.notificationWaiter
        this.notificationWaiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.resolve(message)
        return
      }

      this.admitQueuedNotification(wireBytes, heldBytes, reservation)
      this.notificationQueue.push({ sessionId, message, bytes: wireBytes, reservation })
      retained = true
      this.updateStdoutPause()
    } finally {
      if (!retained) {
        if (parserPhysical) {
          const completion = parserPhysical
          void completion.then(() => {
            reservation.release()
            if (this.parserCompletion === completion) this.parserCompletion = undefined
            return undefined
          })
        } else {
          reservation.release()
        }
      }
    }
  }

  private admitQueuedNotification(
    wireBytes: number,
    heldBytes: number,
    reservation: NativeMemoryReservation,
  ): void {
    if (
      this.queuedInboundCount + 1 > AGY_QUEUE_MESSAGE_LIMIT ||
      this.queuedInboundBytes + wireBytes > AGY_QUEUE_HARD_LIMIT_BYTES
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity notification queue exceeded its 8 MiB / 4096-item capacity.',
        false,
      )
    }
    reservation.resize(heldBytes)
    this.queuedInboundBytes += wireBytes
    this.queuedInboundCount += 1
  }

  private settleRequest(
    id: number,
    error?: Error,
    message?: object,
    failureSource: DiagnosticFailureSource = 'transport_failure',
  ): void {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    if (message) pending.replied = true
    if (pending.logicalSettled) {
      this.completePhysicalRequest(id, pending)
      return
    }
    pending.logicalSettled = true
    const rpcError = message && Reflect.get(message, 'error')
    const candidate =
      rpcError && typeof rpcError === 'object' ? Reflect.get(rpcError, 'code') : undefined
    const nativeErrorCode =
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= -0x80000000 &&
      candidate <= 0x7fffffff
        ? candidate
        : undefined
    recordDiagnostic({
      ...pending.diagnostic,
      phase: rpcError
        ? 'blocked'
        : error
          ? failureSource === 'timeout'
            ? 'timeout'
            : failureSource === 'cancelled'
              ? 'interrupted'
              : 'failed'
          : 'completed',
      level: rpcError || error ? 'warn' : 'debug',
      durationMs: Date.now() - pending.startedAt,
      ...(rpcError
        ? { failureSource: 'native_rpc_rejection', code: 'native_rpc_rejected' }
        : error
          ? {
              failureSource,
              code:
                failureSource === 'timeout'
                  ? 'TIMEOUT'
                  : failureSource === 'cancelled'
                    ? 'request_cancelled'
                    : failureSource === 'process_exit'
                      ? 'agent_process_crash'
                      : 'transport_failure',
            }
          : {}),
      ...(nativeErrorCode === undefined ? {} : { nativeErrorCode }),
    })
    clearTimeout(pending.timeout)
    pending.pauseCleanup?.()
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort)
    this.updateStdoutPause()
    if (error) pending.reject?.(error)
    else if (message) pending.resolve?.(message)
    pending.resolve = undefined
    pending.reject = undefined
    pending.signal = undefined
    pending.abort = undefined
    pending.pauseCleanup = undefined
    pending.timeout = undefined
    this.completePhysicalRequest(id, pending)
  }

  private finishRequestWrite(id: number | undefined): void {
    if (id === undefined) return
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    pending.writeJoined = true
    if (pending.logicalSettled) this.completePhysicalRequest(id, pending)
  }

  private completePhysicalRequest(id: number, pending: PendingRequest): void {
    if (!pending.logicalSettled || !pending.writeJoined || (!pending.replied && pending.dispatched))
      return
    if (this.pendingRequests.get(id) !== pending) return
    this.pendingRequests.delete(id)
    pending.physicalResolve(pending.replied ? 'reply' : 'not_sent')
    this.updateStdoutPause()
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private notifyPhysicalWorkIdleIfSettled(): void {
    if (!this.closed && !this.hasPendingPhysicalWork()) {
      this.onPhysicalWorkIdle?.()
    }
  }

  private settleNotificationWaiter(error: Error): void {
    const waiter = this.notificationWaiter
    if (!waiter) return
    this.notificationWaiter = undefined
    this.cleanupNotificationWaiter(waiter)
    waiter.reject(error)
  }

  private cleanupNotificationWaiter(waiter: NotificationWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private resumeStdoutIfNeeded(): void {
    this.updateStdoutPause()
  }

  private updateStdoutPause(): void {
    const canWaitForConsumer =
      this.pendingRequests.size === 0 &&
      this.serverRequestListeners.size === 0 &&
      this.serverRequestOwners.size === 0
    const queued = this.queuedInboundCount
    this.notificationQueuePaused =
      !this.closed &&
      (this.notificationQueuePaused
        ? this.queuedInboundBytes > AGY_QUEUE_LOW_WATER_BYTES ||
          queued >= AGY_QUEUE_MESSAGE_LIMIT / 2
        : this.queuedInboundBytes >= AGY_QUEUE_HIGH_WATER_BYTES ||
          queued >= AGY_QUEUE_MESSAGE_LIMIT / 2)
    const shouldPause =
      !this.closed &&
      (this.inboundProcessing || (canWaitForConsumer && this.notificationQueuePaused))
    if (shouldPause === this.stdoutPaused) return
    this.stdoutPaused = shouldPause
    if (shouldPause) this.child.stdout.pause()
    else this.child.stdout.resume()
  }

  private enqueue(
    message: object,
    options: {
      requestId?: number | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
      cancelBeforeWriteSignal?: AbortSignal | undefined
    },
  ): Promise<void> {
    if (!this.isOpen) {
      this.finishRequestWrite(options.requestId)
      return Promise.reject(this.closeError ?? new Error('Antigravity ACP server is unavailable.'))
    }
    let heldBytes: number
    let bytes: Buffer | undefined
    let reservation: NativeMemoryReservation
    try {
      heldBytes = freezeNativeJsonFrame(message)
      if (heldBytes <= AGY_INLINE_ENCODING_MEMORY_BYTES) {
        bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
        heldBytes += bytes.length * 3
      }
      heldBytes += AGY_FRAME_WORKSPACE_BYTES
      reservation = this.memory.reserve(heldBytes)
    } catch (error) {
      this.finishRequestWrite(options.requestId)
      return Promise.reject(error)
    }
    if (this.outboundQueue.length - this.outboundHead >= AGY_QUEUE_MESSAGE_LIMIT) {
      reservation.release()
      this.finishRequestWrite(options.requestId)
      return Promise.reject(
        new AgentExecutionError(
          'runtime_incompatible',
          'Native ACP request preparation capacity is full. This frame was not written.',
          false,
        ),
      )
    }
    this.queuedOutboundBytes += heldBytes
    return new Promise((resolve, reject) => {
      const physical = options.requestId === undefined ? Promise.withResolvers<void>() : undefined
      if (physical)
        this.observePhysicalOperation?.(options.cancelBeforeWriteSignal, physical.promise)
      this.outboundQueue.push({
        message,
        expiresAt: Date.now() + AGY_OUTBOUND_DRAIN_TIMEOUT_MS,
        bytes,
        heldBytes,
        released: false,
        reservation,
        controller: new AbortController(),
        resolve,
        reject,
        physicalResolve: physical?.resolve,
        ...options,
      })
      this.pumpOutbound()
    })
  }

  private pumpOutbound(): void {
    if (this.writing || this.closed) return
    const frame = this.outboundQueue[this.outboundHead]
    if (!frame) return
    if (frame.expiresAt <= Date.now()) {
      this.finishOutbound(
        frame,
        new NativeFrameWriteError('Native ACP frame expired before writing.', false),
      )
      this.pumpOutbound()
      return
    }
    if (
      frame.requestId !== undefined &&
      (!this.pendingRequests.has(frame.requestId) ||
        this.pendingRequests.get(frame.requestId)?.logicalSettled)
    ) {
      this.finishOutbound(frame, new Error('Antigravity request expired before dispatch.'))
      this.pumpOutbound()
      return
    }
    this.writing = true
    this.activeOutboundFrame = frame
    const signal =
      frame.cancelBeforeWriteSignal ?? this.pendingRequests.get(frame.requestId ?? -1)?.signal
    const writeSignal = frame.controller.signal
    const source = (physicalSignal: AbortSignal): AsyncIterable<Uint8Array> =>
      frame.bytes
        ? (async function* (): AsyncIterable<Uint8Array> {
            for (
              let offset = 0;
              offset < frame.bytes!.length;
              offset += NATIVE_FRAME_WRITE_CHUNK_BYTES
            ) {
              physicalSignal.throwIfAborted()
              yield frame.bytes!.subarray(offset, offset + NATIVE_FRAME_WRITE_CHUNK_BYTES)
            }
          })()
        : encodeNativeJsonFrame(frame.message, physicalSignal)

    const writing = writeNativeFrame(this.child.stdin, source, {
      signal: writeSignal,
      ...(signal ? { cancelBeforeWriteSignal: signal } : {}),
      onFirstWrite: () => frame.onDispatch?.(),
      canDispatch: () =>
        this.isOpen &&
        (this.isLifetimeCurrent?.() ?? true) &&
        (frame.requestId === undefined ||
          (this.pendingRequests.has(frame.requestId) &&
            !this.pendingRequests.get(frame.requestId)?.logicalSettled)) &&
        (frame.canDispatch?.() ?? true),
      deadlineMs: Math.max(1, frame.expiresAt - Date.now()),
    }).then(
      () => {
        this.finishOutbound(frame)
        this.pumpOutbound()
        return undefined
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Native ACP frame write failed.')
        this.finishOutbound(frame, failure)
        if (error instanceof NativeFrameWriteError && error.possiblyWritten)
          void this.close(failure).catch(() => undefined)
        else this.pumpOutbound()
        return undefined
      },
    )
    this.outboundWriteTask = writing
  }

  private releaseOutbound(frame: OutboundFrame): void {
    if (frame.released) return
    frame.released = true
    this.queuedOutboundBytes -= frame.heldBytes
    frame.reservation.release()
  }

  private finishOutbound(frame: OutboundFrame, error?: Error): void {
    this.releaseOutbound(frame)
    this.finishRequestWrite(frame.requestId)
    frame.physicalResolve?.()
    if (this.activeOutboundFrame === frame) this.activeOutboundFrame = undefined
    if (this.outboundQueue[this.outboundHead] !== frame) return
    this.outboundQueue[this.outboundHead] = undefined
    this.outboundHead += 1
    this.writing = false
    this.compactOutboundQueue()
    if (error) frame.reject(error)
    else frame.resolve()
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private recordExit(code: number | null): void {
    if (this.exitRecorded) return
    this.exitRecorded = true
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'closed',
      level: this.closed ? 'info' : 'error',
      agentId: 'agy',
      executorId: this.executorId,
      failureSource: 'process_exit',
      ...(this.child.pid ? { pid: this.child.pid } : {}),
      ...(code === null ? {} : { exitCode: code }),
      ...(this.closed ? {} : { code: 'agent_process_crash' }),
    })
  }

  private fail(error: Error, failureSource: DiagnosticFailureSource = 'transport_failure'): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    this.child.stdout.removeListener('data', this.receive)
    this.child.stderr.removeListener('data', this.receiveError)
    this.child.removeListener('exit', this.processExited)
    this.child.removeListener('close', this.exited)
    this.activeOutboundFrame?.controller.abort()
    this.inboundController.abort()
    this.frameReservation?.release()
    this.frameReservation = undefined
    clearTimeout(this.frameDeadline)
    this.frameDeadline = undefined
    for (const id of this.pendingRequests.keys())
      this.settleRequest(id, error, undefined, failureSource)
    this.settleNotificationWaiter(error)
    for (const consumer of this.sessionConsumers.values()) {
      consumer.closed = true
      if (consumer.waiter) {
        const waiter = consumer.waiter
        consumer.waiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.reject(error)
      }
      for (const item of consumer.queue) item?.reservation.release()
      consumer.queue.length = 0
      consumer.head = 0
    }
    this.sessionConsumers.clear()
    for (let index = this.outboundHead; index < this.outboundQueue.length; index += 1) {
      const frame = this.outboundQueue[index]
      if (frame) {
        if (frame !== this.activeOutboundFrame) {
          this.releaseOutbound(frame)
          this.finishRequestWrite(frame.requestId)
          frame.physicalResolve?.()
        }
        frame.reject(error)
      }
    }
    this.outboundQueue.length = 0
    this.outboundHead = 0
    for (const queued of this.notificationQueue) queued?.reservation.release()
    this.notificationQueue.length = 0
    this.backgroundListeners.clear()
    this.serverRequestListeners.clear()
    this.serverRequestOwners.clear()
    this.notificationHead = 0
    this.frameChunks = []
    this.frameBytes = 0
    this.queuedInboundBytes = 0
    this.queuedInboundCount = 0
    this.notificationQueuePaused = false
    this.writing = false
    if (this.stdoutPaused) this.child.stdout.resume()
    this.stdoutPaused = false
    this.onClosed?.()
  }

  private compactNotificationQueue(): void {
    if (this.notificationHead < 1_024 || this.notificationHead * 2 < this.notificationQueue.length)
      return
    this.notificationQueue.splice(0, this.notificationHead)
    this.notificationHead = 0
  }

  private compactOutboundQueue(): void {
    if (this.outboundHead < 1_024 || this.outboundHead * 2 < this.outboundQueue.length) return
    this.outboundQueue.splice(0, this.outboundHead)
    this.outboundHead = 0
  }

  private async shutdown(): Promise<void> {
    if (this.closeOwnedProcess) {
      await this.closeOwnedProcess(this.shutdownDeadlineAt)
      this.recordExit(this.child.exitCode)
      return
    }
    if (this.child.exitCode !== null || this.child.signalCode != null) {
      this.recordExit(this.child.exitCode)
      return
    }
    const remaining = (): number =>
      this.shutdownDeadlineAt === undefined ? Infinity : this.shutdownDeadlineAt - Date.now()
    if (remaining() <= 0) throw new Error('Antigravity shutdown exceeded its existing deadline.')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let forceTimeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timeout)
        clearTimeout(forceTimeout)
        this.child.removeListener('exit', finish)
        return true
      }
      const finish = (code: number | null): void => {
        this.recordExit(code)
        if (cleanup()) resolve()
      }
      const fail = (error: unknown): void => {
        if (cleanup()) reject(error instanceof Error ? error : new Error(String(error)))
      }
      const timeout = setTimeout(
        () => {
          if (remaining() <= 0) {
            fail(new Error('Antigravity shutdown exceeded its existing deadline.'))
            return
          }
          try {
            this.child.kill('SIGKILL')
          } catch (error) {
            fail(error)
            return
          }
          forceTimeout = setTimeout(
            () => {
              fail(new Error('Antigravity process did not exit after SIGKILL.'))
            },
            Math.min(AGY_FORCE_EXIT_TIMEOUT_MS, Math.max(1, remaining())),
          )
        },
        Math.min(AGY_SHUTDOWN_TIMEOUT_MS, Math.max(1, remaining())),
      )
      this.child.once('exit', finish)
      try {
        this.child.stdin.end()
        this.child.kill()
      } catch (error) {
        fail(error)
      }
    })
  }
}

export type OwnedAgyProcess = {
  child: ChildProcessWithoutNullStreams
  close?: (deadlineAt?: number) => Promise<void>
  physicalWitness?: (ownerId: string) => Promise<import('@pact/contracts').DecisionPhysicalWitness>
}

export type AgyProcessFactory = (
  canonicalCwd: string,
  args: readonly string[],
  permissionScope: AgyPermissionScope,
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams | OwnedAgyProcess | Promise<OwnedAgyProcess>

export interface AgyPoolLease {
  readonly connection: AgyAcpConnection
  readonly canonicalCwd: string
  readonly permissionScope: AgyPermissionScope
  ensureInitialized(signal: AbortSignal): Promise<object>
  /** Releases this lease and closes the underlying process if no other active lease holds it. */
  disposeIfIdle(): Promise<void>
  release(): void
}

export interface AgyPoolAcquireInput {
  cwd: string
  permissionScope: AgyPermissionScope
  permissionMode?: SessionPermissionMode | undefined
  readOnly?: boolean | undefined
  sessionId?: string | undefined
  signal?: AbortSignal | undefined
}

interface PooledConnectionEntry {
  readonly key: string
  readonly canonicalCwd: string
  readonly permissionScope: AgyPermissionScope
  connection: AgyAcpConnection | undefined
  starting: Promise<AgyAcpConnection> | undefined
  closing: Promise<void> | undefined
  initializing: Promise<object> | undefined
  initializedResult: object | undefined
  readonly activeLeases: Set<symbol>
  /** Sessions currently authorized to retain Full access in this canonical directory. */
  readonly fullAccessSessions: Set<string>
  /** Set when Full access was retired while active leases were still draining. */
  drainingFullAccess: boolean
  /** Set when a zero-Turn cold check requested immediate close once pending physical work drains. */
  closeWhenIdle: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

export interface AgyAcpConnectionPoolOptions {
  executablePath: string
  clientInfo?: { name: string; title?: string; version: string } | undefined
  relativeAppDataDir?: string | undefined
  idleTimeoutMs?: number | undefined
  processFactory?: AgyProcessFactory | undefined
  ipcTraffic?: LogicalIpcWorkerTraffic | undefined
  observePhysicalOperation?: (
    signal: AbortSignal | undefined,
    physicalCompletion: Promise<unknown>,
  ) => void
}

function buildAgySpawnArgs(
  permissionScope: AgyPermissionScope,
  relativeAppDataDir: string | undefined,
): string[] {
  const args = ['acp', '--process-per-session', '--disable-telemetry']
  if (relativeAppDataDir !== undefined) {
    if (
      !relativeAppDataDir ||
      relativeAppDataDir.length > 128 ||
      relativeAppDataDir.includes('..') ||
      /[/\\&|<>^%!"\r\n\s]/u.test(relativeAppDataDir) ||
      !/^[a-z0-9._-]+$/iu.test(relativeAppDataDir)
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity --app-data-dir override must be a safe relative directory name.',
        false,
      )
    }
    args.push('--app-data-dir', relativeAppDataDir)
  }
  if (permissionScope === 'full') {
    args.push('--dangerously-skip-permissions')
  }
  return args
}

/**
 * Pools `agy acp --process-per-session --disable-telemetry` connections strictly by
 * `(canonicalProjectDir, permissionScope: 'standard' | 'full')`.
 *
 * - `'full'` adds `--dangerously-skip-permissions`, is ref-counted across active runs
 *   (including sibling Side Chats), and is NEVER usable for `'native' | 'ask' | 'auto'`
 *   or any `collaborationReadOnly` stage.
 * - Leaving or retiring `'full'` drains active runs and immediately closes idle `'full'` processes.
 * - Settled connections close after the 5-minute idle reaper.
 */
export class AgyAcpConnectionPool {
  private readonly entries = new Map<string, PooledConnectionEntry>()
  private readonly pendingLeaseReservations = new Set<symbol>()
  private readonly physicalOperationListeners = new Set<
    (signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>) => void
  >()
  private readonly closingTasks = new Set<Promise<void>>()
  private readonly unconfirmedClosingConnections = new Set<AgyAcpConnection>()
  private disposed = false
  private disposal: Promise<void> | undefined
  private shutdownDeadlineAt: number | undefined
  private latestExecutorId = randomUUID()
  private readonly idleTimeoutMs: number
  private readonly clientInfo: { name: string; title: string; version: string }

  constructor(private readonly options: AgyAcpConnectionPoolOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? AGY_IDLE_CONNECTION_TIMEOUT_MS
    this.clientInfo = {
      name: options.clientInfo?.name ?? 'pact',
      title: options.clientInfo?.title ?? 'Pact',
      version: options.clientInfo?.version ?? '0.4.0',
    }
    if (options.observePhysicalOperation) {
      this.physicalOperationListeners.add(options.observePhysicalOperation)
    }
  }

  subscribePhysicalOperations(
    listener: (signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>) => void,
  ): () => void {
    this.physicalOperationListeners.add(listener)
    return () => {
      this.physicalOperationListeners.delete(listener)
    }
  }

  get executorId(): string {
    for (const entry of this.entries.values()) {
      if (entry.connection?.isOpen) return entry.connection.executorId
    }
    return this.latestExecutorId
  }

  hasExecutor(executorId: string): boolean {
    if (!executorId) return false
    for (const entry of this.entries.values()) {
      if (entry.connection?.isOpen && entry.connection.executorId === executorId) {
        return true
      }
    }
    return false
  }

  get unconfirmedClosingCount(): number {
    return this.unconfirmedClosingConnections.size
  }

  get activeLeaseCount(): number {
    let total = this.pendingLeaseReservations.size
    for (const entry of this.entries.values()) total += entry.activeLeases.size
    return total
  }

  poolSnapshot(): Array<{
    canonicalCwd: string
    permissionScope: AgyPermissionScope
    open: boolean
    activeLeases: number
    fullAccessSessions: number
    drainingFullAccess: boolean
  }> {
    return [...this.entries.values()].map((entry) => ({
      canonicalCwd: entry.canonicalCwd,
      permissionScope: entry.permissionScope,
      open: Boolean(entry.connection?.isOpen),
      activeLeases: entry.activeLeases.size,
      fullAccessSessions: entry.fullAccessSessions.size,
      drainingFullAccess: entry.drainingFullAccess,
    }))
  }

  async acquire(input: AgyPoolAcquireInput): Promise<AgyPoolLease> {
    input.signal?.throwIfAborted()
    if (this.disposed || this.disposal) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (input.permissionScope === 'full') {
      if (input.readOnly === true || input.permissionMode !== 'full') {
        throw new PermissionModeRejectedError(
          'Antigravity Full access process pool cannot be used for read-only stages or non-Full permission modes.',
        )
      }
    }
    if (this.activeLeaseCount >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError(
        'Antigravity has too many active native contexts. Wait for one to settle; no new task was submitted.',
      )
    }

    const leaseToken = Symbol('agy-pool-lease')
    this.pendingLeaseReservations.add(leaseToken)

    let canonicalCwd: string
    let pooledEntry: PooledConnectionEntry
    try {
      canonicalCwd = await realpath(input.cwd)
      input.signal?.throwIfAborted()
      if (this.disposed || this.disposal) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }

      // If a non-read-only Run enters `'native' | 'ask' | 'auto'`, that session has left `'full'`!
      if (
        input.permissionScope === 'standard' &&
        input.readOnly !== true &&
        input.sessionId !== undefined
      ) {
        await this.retireFullAccess({ sessionId: input.sessionId, canonicalCwd })
      }

      const key = `${canonicalCwd}\0${input.permissionScope}`
      let entry = this.entries.get(key)
      if (!entry) {
        this.evictSettledEntries()
        while (
          this.entries.size + this.unconfirmedClosingConnections.size >=
          AGY_MAX_CONTEXTS * 2
        ) {
          const idleCandidate = this.findEvictableIdleEntry()
          if (!idleCandidate) {
            throw new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            )
          }
          // oxlint-disable-next-line no-await-in-loop -- Physically closes one 0-lease idle connection before admitting the 17th directory.
          await this.closeEntryConnection(
            idleCandidate,
            new Error('Antigravity idle connection evicted at pool capacity.'),
          )
          input.signal?.throwIfAborted()
          if (this.disposed || this.disposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
        }
        entry = {
          key,
          canonicalCwd,
          permissionScope: input.permissionScope,
          connection: undefined,
          starting: undefined,
          closing: undefined,
          initializing: undefined,
          initializedResult: undefined,
          activeLeases: new Set(),
          fullAccessSessions: new Set(),
          drainingFullAccess: false,
          closeWhenIdle: false,
          idleTimer: undefined,
        }
        this.entries.set(key, entry)
      }

      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      entry.closeWhenIdle = false

      if (input.permissionScope === 'full') {
        entry.drainingFullAccess = false
        if (input.sessionId) entry.fullAccessSessions.add(input.sessionId)
      }

      pooledEntry = entry
      this.pendingLeaseReservations.delete(leaseToken)
      pooledEntry.activeLeases.add(leaseToken)
    } catch (error) {
      this.pendingLeaseReservations.delete(leaseToken)
      throw error
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      pooledEntry.activeLeases.delete(leaseToken)
      this.onEntryUpdated(pooledEntry)
    }

    try {
      const connection = await this.ensureEntryConnection(pooledEntry)
      input.signal?.throwIfAborted()
      return {
        connection,
        canonicalCwd,
        permissionScope: input.permissionScope,
        ensureInitialized: (signal) => this.initializeEntry(pooledEntry, connection, signal),
        disposeIfIdle: async () => {
          release()
          if (pooledEntry.connection === connection && pooledEntry.activeLeases.size === 0) {
            if (!connection.hasPendingPhysicalWork()) {
              await this.closeEntryConnection(
                pooledEntry,
                new Error('Antigravity cold verification session settled.'),
                connection,
              )
            } else {
              pooledEntry.closeWhenIdle = true
            }
          }
        },
        release,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Retires Full access for a specific `sessionId` (or all sessions in `cwd`), draining
   * any active sibling runs and immediately closing idle `'full'` connections.
   */
  async retireFullAccess(
    options: { sessionId?: string; cwd?: string; canonicalCwd?: string } = {},
  ): Promise<void> {
    let targetCanonical = options.canonicalCwd
    if (!targetCanonical && options.cwd) {
      try {
        targetCanonical = await realpath(options.cwd)
      } catch {
        targetCanonical = options.cwd
      }
    }
    const closings: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      if (entry.permissionScope !== 'full') continue
      if (targetCanonical && entry.canonicalCwd !== targetCanonical) continue
      if (options.sessionId) {
        entry.fullAccessSessions.delete(options.sessionId)
      } else {
        entry.fullAccessSessions.clear()
      }
      if (entry.fullAccessSessions.size === 0) {
        entry.drainingFullAccess = true
        if (entry.activeLeases.size === 0 && !entry.connection?.hasPendingPhysicalWork()) {
          closings.push(
            this.closeEntryConnection(
              entry,
              new Error('Antigravity Full access connection retired after draining.'),
            ),
          )
        }
      }
    }
    if (closings.length > 0) await Promise.all(closings)
  }

  capShutdownDeadline(deadlineAt: number): void {
    this.shutdownDeadlineAt = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
    for (const entry of this.entries.values()) {
      entry.connection?.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    for (const conn of this.unconfirmedClosingConnections) {
      conn.capShutdownDeadline(this.shutdownDeadlineAt)
    }
  }

  dispose(flushDeadlineAt?: number): Promise<void> {
    if (flushDeadlineAt !== undefined) this.capShutdownDeadline(flushDeadlineAt)
    this.disposed = true
    this.disposal ??= (async () => {
      const tasks: Promise<void>[] = []
      for (const entry of this.entries.values()) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        if (entry.starting) {
          tasks.push(
            entry.starting
              .then((conn) => conn.close(new Error('Antigravity pool disposed.')))
              .catch(() => undefined),
          )
        }
        if (entry.connection) {
          tasks.push(this.closeEntryConnection(entry, new Error('Antigravity pool disposed.')))
        } else if (entry.closing) {
          tasks.push(entry.closing)
        }
      }
      for (const unconfirmed of this.unconfirmedClosingConnections) {
        tasks.push(unconfirmed.close(new Error('Antigravity pool disposed.')))
      }
      await Promise.all([...tasks, ...this.closingTasks])
      this.entries.clear()
      this.pendingLeaseReservations.clear()
      this.physicalOperationListeners.clear()
    })()
    return this.disposal
  }

  private async ensureEntryConnection(entry: PooledConnectionEntry): Promise<AgyAcpConnection> {
    if (entry.closing) await entry.closing
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (entry.connection?.isOpen) return entry.connection
    if (entry.starting) return entry.starting

    const task = this.spawnEntryConnection(entry).finally(() => {
      if (entry.starting === task) entry.starting = undefined
    })
    entry.starting = task
    return task
  }

  private async spawnEntryConnection(entry: PooledConnectionEntry): Promise<AgyAcpConnection> {
    const args = buildAgySpawnArgs(entry.permissionScope, this.options.relativeAppDataDir)
    const env = agyProcessEnvironment()
    const owned = this.options.processFactory
      ? await this.spawnInjected(entry.canonicalCwd, args, entry.permissionScope, env)
      : this.spawnOwnedGroup(entry.canonicalCwd, args, env)

    if (this.disposed) {
      if (owned.close) await owned.close(this.shutdownDeadlineAt)
      else owned.child.kill('SIGKILL')
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }

    const connection = new AgyAcpConnection(
      owned.child,
      entry.canonicalCwd,
      entry.permissionScope,
      () => {
        if (entry.connection === connection) {
          entry.connection = undefined
          entry.initializing = undefined
          entry.initializedResult = undefined
        }
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        void this.closeEntryConnection(
          entry,
          new Error('Antigravity ACP connection closed.'),
          connection,
        )
      },
      owned.close,
      this.options.ipcTraffic,
      () => !this.disposed,
      (signal, physicalCompletion) => {
        for (const listener of this.physicalOperationListeners) {
          listener(signal, physicalCompletion)
        }
      },
      () => {
        if (entry.connection === connection) {
          this.onEntryUpdated(entry)
        }
      },
    )
    if (this.shutdownDeadlineAt !== undefined) {
      connection.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    entry.connection = connection
    entry.initializing = undefined
    entry.initializedResult = undefined
    this.latestExecutorId = connection.executorId
    return connection
  }

  private async spawnInjected(
    canonicalCwd: string,
    args: readonly string[],
    permissionScope: AgyPermissionScope,
    env: NodeJS.ProcessEnv,
  ): Promise<OwnedAgyProcess> {
    const supplied = await this.options.processFactory!(canonicalCwd, args, permissionScope, env)
    return 'child' in supplied ? supplied : { child: supplied }
  }

  private spawnOwnedGroup(
    canonicalCwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): OwnedAgyProcess {
    const executablePath = this.options.executablePath
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
    if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Unsafe Antigravity executable path.',
        false,
      )
    }
    if (args.some((arg) => !/^(?:acp|--[a-z0-9-]+|[a-z0-9._-]+)$/iu.test(arg))) {
      throw new AgentExecutionError('protocol_error', 'Unsafe Antigravity launch arguments.', false)
    }
    const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath
    const spawnArgs = isWindowsCommand
      ? ['/d', '/s', '/c', `""${executablePath}" ${args.join(' ')}"`]
      : [...args]
    const processGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
    const child = processGroup.spawn(target, spawnArgs, {
      cwd: canonicalCwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: isWindowsCommand,
    })
    return {
      child,
      close: (deadlineAt) => processGroup.close(deadlineAt),
      physicalWitness: (ownerId) => processGroup.physicalWitness(ownerId),
    }
  }

  private initializeEntry(
    entry: PooledConnectionEntry,
    connection: AgyAcpConnection,
    signal: AbortSignal,
  ): Promise<object> {
    if (entry.connection === connection && entry.initializedResult) {
      return Promise.resolve(entry.initializedResult)
    }
    if (entry.connection === connection && entry.initializing) {
      return entry.initializing
    }
    const task = (async () => {
      try {
        const response = await connection.request(
          'initialize',
          {
            protocolVersion: 1,
            capabilities: { elicitation: { form: {} } },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              elicitation: { form: {} },
            },
            clientInfo: this.clientInfo,
          },
          { timeoutMs: AGY_INITIALIZATION_TIMEOUT_MS, signal },
        )
        const error = Reflect.get(response, 'error')
        const result = Reflect.get(response, 'result')
        if (error || !result || typeof result !== 'object') {
          throw new AgentExecutionError(
            'protocol_error',
            error
              ? JSON.stringify(error)
              : 'Antigravity ACP server did not acknowledge initialize.',
            false,
          )
        }
        if (entry.connection === connection) {
          entry.initializedResult = result
        }
        return result
      } catch (error) {
        if (entry.connection === connection) {
          entry.initializing = undefined
          entry.initializedResult = undefined
          await this.closeEntryConnection(
            entry,
            error instanceof Error ? error : new Error('Antigravity initialization failed.'),
            connection,
          )
        }
        throw error
      }
    })()
    entry.initializing = task
    return task
  }

  private onEntryUpdated(entry: PooledConnectionEntry): void {
    if (this.disposed) return
    if (entry.activeLeases.size > 0) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      entry.closeWhenIdle = false
      return
    }
    const connection = entry.connection
    if (!connection || !connection.isOpen) {
      if (!entry.starting && !entry.closing) this.entries.delete(entry.key)
      return
    }
    if (connection.hasPendingPhysicalWork()) return

    if (
      (entry.permissionScope === 'full' &&
        (entry.drainingFullAccess || entry.fullAccessSessions.size === 0)) ||
      entry.closeWhenIdle
    ) {
      entry.closeWhenIdle = false
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity Full access connection drained and closed.'),
        connection,
      )
      return
    }

    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (
        entry.activeLeases.size === 0 &&
        entry.connection === connection &&
        !connection.hasPendingPhysicalWork()
      ) {
        void this.closeEntryConnection(
          entry,
          new Error('Antigravity ACP connection closed after five minutes idle.'),
          connection,
        )
      }
    }, this.idleTimeoutMs)
  }

  private evictSettledEntries(): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        !entry.connection?.isOpen
      ) {
        clearTimeout(entry.idleTimer)
        this.entries.delete(key)
      }
    }
  }

  private findEvictableIdleEntry(): PooledConnectionEntry | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        entry.connection?.isOpen &&
        !entry.connection.hasPendingPhysicalWork() &&
        entry.connection.totalActiveOrInitializingOwners === 0
      ) {
        return entry
      }
    }
    return undefined
  }

  private closeEntryConnection(
    entry: PooledConnectionEntry,
    error: Error,
    target = entry.connection,
  ): Promise<void> {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (entry.closing) return entry.closing
    if (!target) return Promise.resolve()
    if (entry.connection === target) {
      entry.connection = undefined
      entry.initializing = undefined
      entry.initializedResult = undefined
    }
    const closing = Promise.resolve()
      .then(() => target.close(error))
      .catch((closeError: unknown) => {
        if (target.isProcessAlive) {
          this.unconfirmedClosingConnections.add(target)
          void target.whenProcessExited().finally(() => {
            this.unconfirmedClosingConnections.delete(target)
          })
        }
        throw closeError
      })
      .finally(() => {
        this.closingTasks.delete(closing)
        if (entry.closing === closing) entry.closing = undefined
        if (entry.activeLeases.size === 0 && !entry.connection && !entry.starting) {
          this.entries.delete(entry.key)
        }
      })
    entry.closing = closing
    this.closingTasks.add(closing)
    return closing
  }
}
