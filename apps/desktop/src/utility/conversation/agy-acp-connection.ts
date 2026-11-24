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
export const AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS = 30_000
export const AGY_PROMPT_ACCEPT_TIMEOUT_MS = 30_000
export const AGY_IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000
export const AGY_SHUTDOWN_TIMEOUT_MS = 2_000
const AGY_FORCE_EXIT_TIMEOUT_MS = 1_000
export const AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS = 1_000
export const AGY_STDERR_LIMIT_BYTES = 16 * 1024
const AGY_INLINE_ENCODING_MEMORY_BYTES = 256 * 1024
const AGY_PARSE_WORKSPACE_MULTIPLIER = 8
const AGY_FRAME_WORKSPACE_BYTES = 4 * NATIVE_FRAME_WRITE_CHUNK_BYTES

export type AgyPermissionScope = 'standard' | 'full'
export type AgyLegacyRequestPhysicalCompletion = 'reply' | 'not_sent' | 'connection_closed'
export type AgyRequestPhysicalCompletion =
  | 'reply'
  | 'invalid_reply'
  | 'not_sent'
  | 'connection_closed'

export type AgyIngress =
  | {
      readonly kind: 'notification'
      readonly seq: number
      readonly message: Record<string, unknown>
    }
  | {
      readonly kind: 'server_request'
      readonly seq: number
      readonly rpcId: string | number
      readonly method: string
      readonly message: Record<string, unknown>
    }
  | {
      readonly kind: 'reply'
      readonly seq: number
      readonly requestId: number
      readonly message: Record<string, unknown>
    }
  | {
      readonly kind: 'end'
      readonly seq: number
      readonly cause: 'eof' | 'transport' | 'deadline'
      readonly incomplete: boolean
      readonly detail?: string
    }

export type AgyPoolIdleRetirement =
  | { readonly kind: 'busy' }
  | { readonly kind: 'retiring'; readonly physical: Promise<void> }

export type PoolRetirement = AgyPoolIdleRetirement

export type AgySessionCloseFailureReason =
  | 'rpc_error'
  | 'timeout'
  | 'transport_closed'
  | 'cancelled'
  | 'capacity'
  | 'protocol_error'

export type AgySessionCloseResult =
  | { readonly confirmed: true; readonly result: Record<string, unknown> }
  | {
      readonly confirmed: false
      readonly reason: AgySessionCloseFailureReason
      readonly detail?: string
    }

type RequestFailureReason = Exclude<AgySessionCloseFailureReason, 'rpc_error'>
const requestFailureReasons = new WeakMap<Error, RequestFailureReason>()

function tagRequestFailure<T extends Error>(error: T, reason: RequestFailureReason): T {
  requestFailureReasons.set(error, reason)
  return error
}

function createUnconfirmedProcessError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause !== undefined ? { cause } : undefined), {
    code: 'unconfirmed_process' as const,
    retryable: true as const,
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function validateJsonRpcResponse(message: object): string | undefined {
  if (!isPlainObject(message)) {
    return 'Antigravity JSON-RPC response was not a plain JSON object.'
  }
  if (Reflect.get(message, 'jsonrpc') !== '2.0') {
    return 'Antigravity JSON-RPC response had an invalid or missing jsonrpc version.'
  }
  const hasResult = Object.hasOwn(message, 'result') && Reflect.get(message, 'result') !== undefined
  const hasError = Object.hasOwn(message, 'error') && Reflect.get(message, 'error') !== undefined
  if (hasResult && hasError) {
    return 'Antigravity JSON-RPC response contained both result and error.'
  }
  if (!hasResult && !hasError) {
    return 'Antigravity JSON-RPC response contained neither result nor error.'
  }
  if (hasError && !isPlainObject(Reflect.get(message, 'error'))) {
    return 'Antigravity JSON-RPC error field was not a plain JSON object.'
  }
  return undefined
}

function formatCloseErrorDetail(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = safeNativePermissionText(value.trim(), 512)
    return trimmed || undefined
  }
  if (value instanceof Error) {
    const trimmed = safeNativePermissionText(value.message.trim(), 512)
    return trimmed || undefined
  }
  if (isPlainObject(value)) {
    const message = Reflect.get(value, 'message')
    if (typeof message === 'string') {
      const trimmed = safeNativePermissionText(message.trim(), 512)
      if (trimmed) return trimmed
    }
    const code = Reflect.get(value, 'code')
    if (typeof code === 'number' && Number.isSafeInteger(code)) {
      return `code ${code}`
    }
    if (
      typeof code === 'string' &&
      code.length > 0 &&
      code.length <= 48 &&
      /^(?:-?[0-9]{1,10}|[A-Za-z][A-Za-z0-9_.:]{0,47})$/u.test(code)
    ) {
      const sanitized = safeNativePermissionText(code, 48)
      if (sanitized) return `code ${sanitized}`
    }
  }
  return undefined
}

export function classifyAgySessionCloseResponse(response: unknown): AgySessionCloseResult {
  if (!isPlainObject(response)) {
    return {
      confirmed: false,
      reason: 'protocol_error',
      detail: 'Antigravity session/close response was not a plain JSON object.',
    }
  }
  const malformedReason = validateJsonRpcResponse(response)
  if (malformedReason !== undefined) {
    return {
      confirmed: false,
      reason: 'protocol_error',
      detail: malformedReason,
    }
  }
  const rpcError = Reflect.get(response, 'error')
  if (rpcError !== undefined) {
    const detail = formatCloseErrorDetail(rpcError)
    return {
      confirmed: false,
      reason: 'rpc_error',
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  const result = Reflect.get(response, 'result')
  if (isPlainObject(result)) {
    return { confirmed: true, result }
  }
  return {
    confirmed: false,
    reason: 'protocol_error',
    detail: 'Antigravity session/close response did not contain a plain object result.',
  }
}

export interface AgyRequestOperation {
  readonly requestId: number
  result: Promise<object>
  /** Resolves strictly to `not_sent` only when zero bytes of this frame entered NativeFrameWriter.
   * Maps `invalid_reply` to `connection_closed` for Wave-2 caller compatibility; inspect `physicalOutcome` for exact settlement.
   */
  physicalCompletion: Promise<AgyLegacyRequestPhysicalCompletion>
  /** Exact physical settlement including `invalid_reply` when a dispatched request receives a malformed reply. */
  physicalOutcome: Promise<AgyRequestPhysicalCompletion>
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
  abandon(): void
}

export interface AgyOrderedSessionStream extends AsyncIterableIterator<AgyIngress> {
  readonly sessionId: string
  shift(): AgyIngress | undefined
  nextIngress(timeoutMs?: number, signal?: AbortSignal): Promise<AgyIngress>
  close(): void
  abandon(): void
  [Symbol.asyncIterator](): AgyOrderedSessionStream
}

export interface AgyServerRequestOwnerHandle {
  updateSessionId(sessionId: string | undefined): void
  dispose(): void
}

interface RegisteredServerRequestOwner {
  readonly ownerId: string
  knownSessionId: string | undefined
  readonly handler: (message: object, seq?: number) => boolean
}

interface PendingRequest {
  readonly method: string
  readonly closeSessionId?: string | undefined
  readonly replyConsumer?: SessionNotificationConsumer | undefined
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
  replyTerminal: 'reply' | 'invalid_reply' | undefined
  physicalResolve: (result: AgyRequestPhysicalCompletion) => void
}

interface QueuedIngressItem {
  sessionId?: string | undefined
  ingress: Exclude<AgyIngress, { kind: 'end' }>
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

interface IngressWaiter {
  resolve: (item: AgyIngress) => void
  reject: (error: Error) => void
  resolveOnAbandon?: (() => void) | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
}

interface SessionNotificationConsumer {
  readonly sessionId: string
  readonly ordered: boolean
  readonly queue: Array<QueuedIngressItem | undefined>
  head: number
  waiter: NotificationWaiter | undefined
  ingressWaiter: IngressWaiter | undefined
  producerSealed: boolean
  endItem: Extract<AgyIngress, { kind: 'end' }> | undefined
  endDelivered: boolean
  endError: Error | undefined
  abandoned: boolean
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

function extractCloseSessionId(method: string, params: object): string | undefined {
  if (method !== 'session/close') return undefined
  const candidate = Reflect.get(params, 'sessionId') ?? Reflect.get(params, 'session_id')
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
    ? candidate
    : undefined
}

export class AgyAcpConnection {
  readonly executorId = randomUUID()
  private readonly memory: NativeWorkingMemory
  private readonly inboundController = new AbortController()
  private frameReservation: NativeMemoryReservation | undefined
  private inboundProcessing = false
  private activeInboundReservation: NativeMemoryReservation | undefined
  private frameDeadline: ReturnType<typeof setTimeout> | undefined
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly unconfirmedCloseRequestIds = new Set<number>()
  private readonly backgroundListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestOwners = new Map<string, RegisteredServerRequestOwner>()
  private readonly sessionConsumers = new Map<string, SessionNotificationConsumer>()
  private readonly streamHandleToConsumer = new WeakMap<object, SessionNotificationConsumer>()
  private readonly permissionWait = new NativePermissionWait()
  private readonly notificationQueue: Array<QueuedIngressItem | undefined> = []
  private readonly outboundQueue: Array<OutboundFrame | undefined> = []
  private notificationHead = 0
  private outboundHead = 0
  private notificationWaiter: NotificationWaiter | undefined
  private frameChunks: Buffer[] = []
  private receiveTask: Promise<void> | undefined
  private parserCompletion: Promise<void> | undefined
  private outboundWriteTask: Promise<void> | undefined
  private readonly processClosed: Promise<void>
  private readonly physicalReleaseDeferred = Promise.withResolvers<void>()
  private physicalFinalizationPromise: Promise<void> | undefined
  private shutdownTask: Promise<void> | undefined
  private readonly shutdownDeadlineListeners = new Set<(deadlineAt: number) => void>()
  private readonly pendingServerRequestCancels: Array<
    { readonly rpcId: string | number; readonly method: string } | undefined
  > = []
  private pendingServerRequestCancelsHead = 0
  private drainingServerRequestCancels = false
  private shutdownSucceeded = false
  private groupCloseSucceeded = false
  private shutdownStarted = false
  private shutdownAttemptSettled = false
  private closeInFlight = false
  private physicalReleaseObserved = false
  private physicalReleaseFinalized = false
  private ownerReleaseListenerStarted = false
  private ownerReleaseNotified = false
  private lateReleaseWatchStarted = false
  private frameBytes = 0
  private queuedInboundBytes = 0
  private queuedInboundCount = 0
  private queuedOutboundBytes = 0
  private nextRequestId = 0
  private nextInboundSeq = 0
  private writing = false
  private activeOutboundFrame: OutboundFrame | undefined
  private stdoutPaused = false
  private notificationQueuePaused = false
  private closed = false
  private tainted = false
  private taintError: Error | undefined
  private shutdownPromise: Promise<void> | undefined
  private shutdownDeadlineAt: number | undefined
  private closeError: Error | undefined
  private exitRecorded = false
  private processHasClosed = false
  private stdoutEnded = false
  private exitDrainPending = false
  private exitDrainDeadlineAt: number | undefined
  private exitDrainTimer: ReturnType<typeof setTimeout> | undefined
  private exitDrainDeferred: PromiseWithResolvers<void> | undefined
  private rawStderr = ''
  private stderrBytes = 0

  private readonly receive = (chunk: Buffer): void => {
    this.inboundProcessing = true
    this.updateStdoutPause()
    const task = this.receiveChunk(chunk)
      .catch((error: unknown) => {
        const frameError =
          error instanceof Error ? error : new Error('Native ACP frame read failed.')
        this.fail(frameError, 'transport_failure', {
          cause: 'transport',
          incomplete: true,
          detail: formatCloseErrorDetail(frameError),
        })
        void this.close(frameError).catch(() => undefined)
      })
      .finally(() => {
        this.inboundProcessing = false
        this.updateStdoutPause()
        if (this.exitDrainPending) {
          this.maybeCompleteExitDrain()
        }
      })
    this.receiveTask = task
  }

  private readonly onStdoutEnded = (): void => {
    this.stdoutEnded = true
    if (this.closed) return
    if (this.exitDrainPending) {
      this.maybeCompleteExitDrain()
    } else {
      this.beginExitInboundDrain()
    }
  }

  private readonly onStdoutError = (rawFailure: unknown): void => {
    const streamError =
      rawFailure instanceof Error ? rawFailure : new Error('Native ACP stdout read failed.')
    this.fail(streamError, 'transport_failure', {
      cause: 'transport',
      incomplete: true,
      detail: formatCloseErrorDetail(streamError),
    })
    void this.close(streamError).catch(() => undefined)
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
    this.processHasClosed = true
    // Do NOT force stdoutEnded here: unread buffered stdout bytes may still sit inside
    // child.stdout (e.g. Win32 PassThrough output.end() immediately followed by facade close).
    this.recordExit(code)
    if (this.closed) return
    if (!this.exitDrainPending) {
      this.beginExitInboundDrain()
    } else {
      this.maybeCompleteExitDrain()
    }
  }

  private readonly processExited = (code: number | null): void => {
    this.recordExit(code)
    if (!this.closed) {
      this.beginExitInboundDrain()
    }
  }

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
    private readonly isProcessOwnerReleased?: () => boolean,
    private readonly whenProcessOwnerReleased?: () => Promise<void>,
    private readonly ownsProcessGroup = false,
    private readonly onTainted?: (error: Error) => void,
    private readonly needsOwnerReleaseProbe = Boolean(
      isProcessOwnerReleased && !whenProcessOwnerReleased,
    ),
  ) {
    this.processClosed = new Promise((resolve) =>
      child.once('close', () => {
        this.processHasClosed = true
        resolve()
      }),
    )
    this.memory = new NativeWorkingMemory()
    this.ensureOwnerReleaseListener()
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'started',
      executorId: this.executorId,
      agentId: 'agy',
      ...(child.pid ? { pid: child.pid } : {}),
    })
    child.stdout.on('data', this.receive)
    child.stdout.once('end', this.onStdoutEnded)
    child.stdout.once('error', this.onStdoutError)
    child.stderr.on('data', this.receiveError)
    child.once('exit', this.processExited)
    child.once('close', this.exited)
  }

  get isOpen(): boolean {
    return (
      !this.closed &&
      !this.tainted &&
      !this.exitRecorded &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
  }

  get isTainted(): boolean {
    return this.tainted
  }

  get taintReason(): Error | undefined {
    return this.taintError
  }

  get closeReason(): Error | undefined {
    return this.taintError ?? this.closeError
  }

  get workingMemoryBytes(): number {
    return this.memory.bytes
  }

  get isProcessAlive(): boolean {
    return !this.exitRecorded && this.child.exitCode === null && this.child.signalCode === null
  }

  get hasProcessClosed(): boolean {
    return this.processHasClosed
  }

  get isPhysicallyReleased(): boolean {
    return this.physicalReleaseFinalized
  }

  hasObservedPhysicalRelease(): boolean {
    return this.physicalReleaseObserved
  }

  isCloseInFlight(): boolean {
    return this.closeInFlight
  }

  whenProcessExited(): Promise<void> {
    return this.processClosed
  }

  whenPhysicallyReleased(): Promise<void> {
    return this.physicalReleaseDeferred.promise
  }

  existingClosePromise(): Promise<void> | undefined {
    return this.shutdownPromise
  }

  supportsReleaseProbe(): boolean {
    return Boolean(this.isProcessOwnerReleased && this.needsOwnerReleaseProbe)
  }

  private isOwnerReleaseConfirmed(): boolean {
    if (this.isProcessOwnerReleased && !this.isProcessOwnerReleased()) return false
    if (this.whenProcessOwnerReleased && !this.ownerReleaseNotified) return false
    if (this.ownsProcessGroup) {
      const hasExplicitWitness = Boolean(
        this.isProcessOwnerReleased || this.whenProcessOwnerReleased,
      )
      if (!this.groupCloseSucceeded && !hasExplicitWitness) {
        return false
      }
    }
    return true
  }

  recheckPhysicalRelease(): boolean {
    if (this.physicalReleaseObserved) return true
    if (!this.shutdownAttemptSettled || !this.processHasClosed) return false
    if (!this.isOwnerReleaseConfirmed()) return false
    this.markPhysicalReleaseVerified()
    return true
  }

  markUnconfirmedCloseRequests(sessionId: string): void {
    let added = false
    for (const [id, pending] of this.pendingRequests) {
      if (
        pending.method === 'session/close' &&
        pending.logicalSettled &&
        pending.replyTerminal !== 'reply' &&
        pending.closeSessionId === sessionId
      ) {
        if (!this.unconfirmedCloseRequestIds.has(id)) {
          this.unconfirmedCloseRequestIds.add(id)
          added = true
        }
      }
    }
    if (added) {
      this.notifyPhysicalWorkIdleIfSettled()
    }
  }

  get totalActiveOrInitializingOwners(): number {
    return this.serverRequestOwners.size
  }

  hasActiveSessionOwners(): boolean {
    return (
      this.serverRequestOwners.size > 0 ||
      this.serverRequestListeners.size > 0 ||
      this.backgroundListeners.size > 0 ||
      Boolean(this.notificationWaiter)
    )
  }

  get stderrText(): string {
    return safeNativePermissionText(this.rawStderr.trim(), AGY_STDERR_LIMIT_BYTES)
  }

  hasPendingPhysicalWork(): boolean {
    return (
      this.pendingRequests.size > 0 ||
      this.writing ||
      this.outboundQueue.length > this.outboundHead ||
      this.sessionConsumers.size > 0 ||
      this.drainingServerRequestCancels ||
      this.pendingServerRequestCancelsHead < this.pendingServerRequestCancels.length
    )
  }

  hasActiveWorkExcludingUnconfirmedCloses(): boolean {
    if (
      this.writing ||
      this.outboundQueue.length > this.outboundHead ||
      this.sessionConsumers.size > 0 ||
      this.drainingServerRequestCancels ||
      this.pendingServerRequestCancelsHead < this.pendingServerRequestCancels.length
    ) {
      return true
    }
    for (const id of this.pendingRequests.keys()) {
      if (!this.unconfirmedCloseRequestIds.has(id)) return true
    }
    return false
  }

  async closeSession(
    sessionId: string,
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<AgySessionCloseResult> {
    if (options.signal?.aborted) {
      return {
        confirmed: false,
        reason: 'cancelled',
        detail: 'Antigravity was interrupted.',
      }
    }
    if (!this.isOpen) {
      const detail = formatCloseErrorDetail(
        this.taintError ?? this.closeError ?? 'Antigravity ACP connection is closed.',
      )
      return {
        confirmed: false,
        reason: 'transport_closed',
        ...(detail !== undefined ? { detail } : {}),
      }
    }
    const timeoutMs = options.timeoutMs ?? AGY_CONTROL_RPC_TIMEOUT_MS
    const op = this.requestOwned(
      'session/close',
      { sessionId },
      { timeoutMs, signal: options.signal, exemptFromPermissionWait: true },
    )
    try {
      const response = await op.result
      return classifyAgySessionCloseResponse(response)
    } catch (error) {
      if (this.pendingRequests.has(op.requestId)) {
        this.unconfirmedCloseRequestIds.add(op.requestId)
        this.notifyPhysicalWorkIdleIfSettled()
      }
      const detail = formatCloseErrorDetail(error)
      const tagged = error instanceof Error ? requestFailureReasons.get(error) : undefined
      const reason: RequestFailureReason =
        tagged ??
        (error instanceof NativeCapacityError
          ? 'capacity'
          : error instanceof AgentExecutionError && error.kind === 'protocol_error'
            ? 'protocol_error'
            : 'transport_closed')
      return {
        confirmed: false,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      }
    }
  }

  reserveWorkingMemory(bytes: number): NativeMemoryReservation {
    return this.memory.reserve(bytes)
  }

  diagnostics(): AgyConnectionDiagnostics {
    const waitingSessionConsumer = [...this.sessionConsumers.values()].some((c) =>
      Boolean(c.waiter || c.ingressWaiter),
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
      exemptFromPermissionWait?: boolean | undefined
      replyTo?: AgyOrderedSessionStream | AgySessionNotificationStream | undefined
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
      exemptFromPermissionWait?: boolean | undefined
      replyTo?: AgyOrderedSessionStream | AgySessionNotificationStream | undefined
    },
  ): AgyRequestOperation {
    const id = this.nextRequestId
    this.nextRequestId += 1

    if (options.signal?.aborted) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
            'cancelled',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }
    const replyConsumer =
      options.replyTo !== undefined ? this.streamHandleToConsumer.get(options.replyTo) : undefined
    if (options.replyTo !== undefined && !replyConsumer) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity replyTo stream does not belong to this ACP connection.',
              false,
            ),
            'protocol_error',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }
    if (this.pendingRequests.size >= AGY_PENDING_REQUEST_LIMIT) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity exceeded Pact’s pending request budget.',
              false,
            ),
            'capacity',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }

    let physicalResolve!: PendingRequest['physicalResolve']
    const physicalOutcome = new Promise<AgyRequestPhysicalCompletion>((resolve) => {
      physicalResolve = resolve
    })
    const physicalCompletion: Promise<AgyLegacyRequestPhysicalCompletion> = physicalOutcome.then(
      (outcome) => (outcome === 'invalid_reply' ? 'connection_closed' : outcome),
    )
    this.observePhysicalOperation?.(options.signal, physicalOutcome)

    const exemptFromPermissionWait = options.exemptFromPermissionWait ?? method === 'session/close'
    const closeSessionId = extractCloseSessionId(method, params)

    const response = new Promise<object>((resolve, reject) => {
      const expired = (): void => {
        this.settleRequest(
          id,
          tagRequestFailure(
            new AgentExecutionError(
              'transient_transport',
              `Antigravity did not answer ${method} before its deadline.`,
              true,
            ),
            'timeout',
          ),
          undefined,
          'timeout',
        )
      }
      const methodName = diagnosticNativeMethodSchema.safeParse(method)
      const pending: PendingRequest = {
        method,
        closeSessionId,
        replyConsumer,
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
        replyTerminal: undefined,
        physicalResolve,
      }
      if (exemptFromPermissionWait) {
        if (options.timeoutMs !== undefined) {
          pending.timeout = setTimeout(expired, options.timeoutMs)
        }
      } else {
        const arm = (): void => {
          clearTimeout(pending.timeout)
          pending.timeout =
            this.permissionWait.waiting || options.timeoutMs === undefined
              ? undefined
              : setTimeout(expired, options.timeoutMs)
        }
        pending.pauseCleanup = this.permissionWait.subscribe(arm)
        arm()
      }
      if (options.signal) {
        pending.abort = (): void => {
          this.settleRequest(
            id,
            tagRequestFailure(
              new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
              'cancelled',
            ),
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
    return { requestId: id, result: response, physicalCompletion, physicalOutcome }
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
    return () => {
      if (this.backgroundListeners.delete(listener)) {
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
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
      if (this.serverRequestListeners.delete(listener)) {
        this.updateStdoutPause()
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
  }

  registerServerRequestOwner(input: {
    ownerId: string
    knownSessionId?: string | undefined
    handler: (message: object, seq?: number) => boolean
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
        this.updateStdoutPause()
      },
      dispose: () => {
        if (this.serverRequestOwners.get(input.ownerId) === entry) {
          this.serverRequestOwners.delete(input.ownerId)
          this.updateStdoutPause()
          this.notifyPhysicalWorkIdleIfSettled()
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
  openSessionStream(sessionId: string): AgySessionNotificationStream
  openSessionStream(sessionId: string, options: { readonly ordered: true }): AgyOrderedSessionStream
  openSessionStream(
    sessionId: string,
    options?: { readonly ordered?: false | undefined },
  ): AgySessionNotificationStream
  openSessionStream(
    sessionId: string,
    options?: { readonly ordered?: boolean | undefined },
  ): AgySessionNotificationStream | AgyOrderedSessionStream {
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

    const ordered = options?.ordered === true
    const consumer: SessionNotificationConsumer = {
      sessionId,
      ordered,
      queue: [],
      head: 0,
      waiter: undefined,
      ingressWaiter: undefined,
      producerSealed: false,
      endItem: undefined,
      endDelivered: false,
      endError: undefined,
      abandoned: false,
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
      .filter((entry): entry is QueuedIngressItem => entry !== undefined)
    this.notificationQueue.splice(0, this.notificationQueue.length, ...remaining)
    this.notificationHead = 0

    if (this.closed) {
      this.sealConsumerProducer(
        consumer,
        'transport',
        true,
        formatCloseErrorDetail(this.closeError ?? 'Antigravity ACP server is unavailable.'),
        this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
    } else {
      this.sessionConsumers.set(sessionId, consumer)
      this.updateStdoutPause()
    }

    const abandon = (): void => {
      this.abandonSessionConsumer(consumer)
    }

    if (ordered) {
      const stream: AgyOrderedSessionStream = {
        sessionId,
        shift: () => this.shiftSessionIngress(consumer),
        nextIngress: (timeoutMs?: number, signal?: AbortSignal) =>
          this.nextSessionIngress(consumer, timeoutMs, signal),
        next: () => this.nextOrderedIteratorResult(consumer),
        return: () => {
          abandon()
          return Promise.resolve({ value: undefined, done: true })
        },
        close: abandon,
        abandon,
        [Symbol.asyncIterator]() {
          return stream
        },
      }
      this.streamHandleToConsumer.set(stream, consumer)
      return stream
    }

    const legacyStream: AgySessionNotificationStream = {
      sessionId,
      shift: () => {
        const item = this.shiftQueuedConsumerItem(consumer)
        return item ? item.ingress.message : undefined
      },
      next: (timeoutMs?: number, signal?: AbortSignal) =>
        this.nextSessionNotification(consumer, timeoutMs, signal),
      close: abandon,
      abandon,
    }
    this.streamHandleToConsumer.set(legacyStream, consumer)
    return legacyStream
  }

  private shiftQueuedConsumerItem(
    consumer: SessionNotificationConsumer,
  ): QueuedIngressItem | undefined {
    if (consumer.abandoned) return undefined
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
    return queued
  }

  private shiftSessionIngress(consumer: SessionNotificationConsumer): AgyIngress | undefined {
    if (consumer.abandoned) return undefined
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) return queued.ingress
    if (consumer.producerSealed && !consumer.endDelivered && consumer.endItem) {
      consumer.endDelivered = true
      return consumer.endItem
    }
    return undefined
  }

  private sendUnconsumedServerRequestCancel(rpcId: string | number, method: string): Promise<void> {
    if (method === 'session/request_permission') {
      return this.respond(rpcId, { outcome: { outcome: 'cancelled' } })
    }
    if (method === 'elicitation/create') {
      return this.respond(rpcId, { action: 'cancel' })
    }
    return this.respondError(
      rpcId,
      'Antigravity session stream closed before handling request.',
      -32_000,
    )
  }

  private drainPendingServerRequestCancels(): void {
    if (this.drainingServerRequestCancels) return
    if (this.pendingServerRequestCancelsHead >= this.pendingServerRequestCancels.length) {
      this.pendingServerRequestCancels.length = 0
      this.pendingServerRequestCancelsHead = 0
      return
    }
    this.drainingServerRequestCancels = true
    const drain = (async () => {
      try {
        while (this.pendingServerRequestCancelsHead < this.pendingServerRequestCancels.length) {
          if (!this.isOpen) {
            const closeReason =
              this.taintError ??
              this.closeError ??
              new Error(
                'Antigravity ACP connection closed before cancelling unconsumed server requests.',
              )
            if (!this.closed) {
              void this.close(closeReason).catch(() => undefined)
            }
            return
          }
          const next = this.pendingServerRequestCancels[this.pendingServerRequestCancelsHead]!
          try {
            // oxlint-disable-next-line no-await-in-loop -- Drain unconsumed server-request cancellations one frame at a time under outbound memory backpressure.
            await this.sendUnconsumedServerRequestCancel(next.rpcId, next.method)
            this.pendingServerRequestCancels[this.pendingServerRequestCancelsHead] = undefined
            this.pendingServerRequestCancelsHead += 1
          } catch (error: unknown) {
            // Keep remaining uncancelled request IDs recorded and deterministically retire/close
            // the connection so the peer never hangs waiting on a dropped request ID.
            const cancelError =
              error instanceof Error
                ? error
                : new Error('Antigravity failed to cancel unconsumed server request.')
            this.taint(cancelError)
            if (!this.closed) {
              void this.close(cancelError).catch(() => undefined)
            }
            return
          }
        }
      } finally {
        if (this.pendingServerRequestCancelsHead >= this.pendingServerRequestCancels.length) {
          this.pendingServerRequestCancels.length = 0
          this.pendingServerRequestCancelsHead = 0
        }
        this.drainingServerRequestCancels = false
        this.notifyPhysicalWorkIdleIfSettled()
      }
    })()
    void drain.catch(() => undefined)
  }

  private abandonSessionConsumer(consumer: SessionNotificationConsumer): void {
    if (consumer.abandoned) return
    consumer.abandoned = true
    if (this.sessionConsumers.get(consumer.sessionId) === consumer) {
      this.sessionConsumers.delete(consumer.sessionId)
    }
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      this.cleanupNotificationWaiter(waiter)
      waiter.reject(new AgentExecutionError('agent_process_crash', 'Session stream closed.', false))
    }
    if (consumer.ingressWaiter) {
      const waiter = consumer.ingressWaiter
      consumer.ingressWaiter = undefined
      this.cleanupIngressWaiter(waiter)
      if (waiter.resolveOnAbandon) {
        waiter.resolveOnAbandon()
      } else {
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Session stream closed.', false),
        )
      }
    }
    const pendingCancels: Array<{ readonly rpcId: string | number; readonly method: string }> = []
    for (let i = consumer.head; i < consumer.queue.length; i += 1) {
      const item = consumer.queue[i]
      if (!item) continue
      consumer.queue[i] = undefined
      if (item.ingress.kind === 'server_request') {
        pendingCancels.push({ rpcId: item.ingress.rpcId, method: item.ingress.method })
      }
      this.queuedInboundBytes -= item.bytes
      this.queuedInboundCount -= 1
      item.reservation.release()
    }
    consumer.queue.length = 0
    consumer.head = 0
    if (pendingCancels.length > 0 && !this.closed) {
      for (const entry of pendingCancels) {
        this.pendingServerRequestCancels.push(entry)
      }
      this.drainPendingServerRequestCancels()
    }
    this.updateStdoutPause()
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private sealConsumerProducer(
    consumer: SessionNotificationConsumer,
    cause: 'eof' | 'transport' | 'deadline',
    incomplete: boolean,
    detail: string | undefined,
    error: Error,
  ): void {
    if (consumer.abandoned || consumer.producerSealed) return
    consumer.producerSealed = true
    this.updateStdoutPause()
    const endItem: Extract<AgyIngress, { kind: 'end' }> = {
      kind: 'end',
      seq: ++this.nextInboundSeq,
      cause,
      incomplete,
      ...(detail !== undefined ? { detail } : {}),
    }
    consumer.endItem = endItem
    consumer.endError = error
    const hasQueued =
      consumer.head < consumer.queue.length && consumer.queue[consumer.head] !== undefined
    if (hasQueued) {
      return
    }
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      consumer.endDelivered = true
      this.cleanupNotificationWaiter(waiter)
      waiter.reject(error)
    }
    if (consumer.ingressWaiter) {
      const waiter = consumer.ingressWaiter
      consumer.ingressWaiter = undefined
      consumer.endDelivered = true
      this.cleanupIngressWaiter(waiter)
      waiter.resolve(endItem)
    }
  }

  private enqueueSessionIngress(
    consumer: SessionNotificationConsumer,
    ingress: Exclude<AgyIngress, { kind: 'end' }>,
    wireBytes: number,
    heldBytes: number,
    reservation: NativeMemoryReservation,
  ): boolean {
    if (consumer.ordered) {
      if (consumer.ingressWaiter) {
        const waiter = consumer.ingressWaiter
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.resolve(ingress)
        return false
      }
      this.admitQueuedNotification(wireBytes, heldBytes, reservation)
      consumer.queue.push({
        sessionId: consumer.sessionId,
        ingress,
        bytes: wireBytes,
        reservation,
      })
      this.updateStdoutPause()
      return true
    }
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      this.cleanupNotificationWaiter(waiter)
      waiter.resolve(ingress.message)
      return false
    }
    this.admitQueuedNotification(wireBytes, heldBytes, reservation)
    consumer.queue.push({
      sessionId: consumer.sessionId,
      ingress,
      bytes: wireBytes,
      reservation,
    })
    this.updateStdoutPause()
    return true
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
      return Promise.resolve(queued.ingress.message)
    }
    if (!this.isOpen && !this.exitDrainPending) {
      return Promise.reject(
        this.taintError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
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
    if (signal?.aborted || consumer.abandoned) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) {
      return Promise.resolve(queued.ingress.message)
    }
    if (consumer.producerSealed) {
      consumer.endDelivered = true
      return Promise.reject(
        consumer.endError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
    }
    if (this.closed) {
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

  private nextSessionIngress(
    consumer: SessionNotificationConsumer,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<AgyIngress> {
    if (signal?.aborted || consumer.abandoned) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) {
      return Promise.resolve(queued.ingress)
    }
    if (consumer.producerSealed) {
      if (!consumer.endDelivered && consumer.endItem) {
        consumer.endDelivered = true
        return Promise.resolve(consumer.endItem)
      }
      return Promise.reject(
        consumer.endError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
    }
    if (consumer.ingressWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return this.createIngressWaiter(
      timeoutMs,
      signal,
      undefined,
      (waiter) => {
        consumer.ingressWaiter = waiter
      },
      () => {
        const waiter = consumer.ingressWaiter
        if (!waiter) return
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.reject(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity did not accept or advance the session before its deadline.',
            true,
          ),
        )
      },
      () => {
        const waiter = consumer.ingressWaiter
        if (!waiter) return
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  private nextOrderedIteratorResult(
    consumer: SessionNotificationConsumer,
  ): Promise<IteratorResult<AgyIngress, void>> {
    if (consumer.abandoned) {
      return Promise.resolve({ value: undefined, done: true })
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) {
      return Promise.resolve({ value: queued.ingress, done: false })
    }
    if (consumer.producerSealed) {
      if (!consumer.endDelivered && consumer.endItem) {
        consumer.endDelivered = true
        return Promise.resolve({ value: consumer.endItem, done: false })
      }
      return Promise.resolve({ value: undefined, done: true })
    }
    if (consumer.ingressWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return new Promise<IteratorResult<AgyIngress, void>>((resolveIter, rejectIter) => {
      const waiter: IngressWaiter = {
        resolve: (item) => resolveIter({ value: item, done: false }),
        reject: rejectIter,
        resolveOnAbandon: () => resolveIter({ value: undefined, done: true }),
        timeout: undefined,
      }
      consumer.ingressWaiter = waiter
    })
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

  private createIngressWaiter(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    resolveOnAbandon: (() => void) | undefined,
    install: (waiter: IngressWaiter) => void,
    onExpired: () => void,
    onAborted: () => void,
  ): Promise<AgyIngress> {
    return new Promise((resolve, reject) => {
      const waiter: IngressWaiter = {
        resolve,
        reject,
        resolveOnAbandon,
        timeout: undefined,
        signal,
      }
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

  private cleanupIngressWaiter(waiter: IngressWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  capShutdownDeadline(deadlineAt: number): void {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)
      throw new Error('Invalid Antigravity shutdown deadline.')
    const next = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
    if (this.shutdownDeadlineAt !== undefined && next >= this.shutdownDeadlineAt) return
    this.shutdownDeadlineAt = next
    if (this.exitDrainPending) {
      this.tightenExitDrainDeadline(next)
    }
    for (const listener of Array.from(this.shutdownDeadlineListeners)) {
      listener(next)
    }
  }

  private raceWithShutdownDeadline<T>(
    work: Promise<T>,
    fallbackDeadlineAt: number | undefined,
    timeoutMessage: string,
  ): Promise<T> {
    const effectiveDeadline = (): number | undefined => {
      if (fallbackDeadlineAt === undefined) return this.shutdownDeadlineAt
      if (this.shutdownDeadlineAt === undefined) return fallbackDeadlineAt
      return Math.min(fallbackDeadlineAt, this.shutdownDeadlineAt)
    }
    const initial = effectiveDeadline()
    if (initial !== undefined && initial <= Date.now()) {
      return Promise.reject(createUnconfirmedProcessError(timeoutMessage))
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        timer = undefined
        this.shutdownDeadlineListeners.delete(rearm)
      }
      const finishResolve = (value: T): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const finishReject = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const rearm = (): void => {
        if (settled) return
        clearTimeout(timer)
        timer = undefined
        const deadline = effectiveDeadline()
        if (deadline === undefined) return
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
          return
        }
        timer = setTimeout(() => {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
        }, remainingMs)
      }
      this.shutdownDeadlineListeners.add(rearm)
      rearm()
      void work.then(finishResolve, finishReject)
    })
  }

  private hasBufferedStdout(): boolean {
    if (this.stdoutEnded) return false
    const stdout = this.child.stdout as NodeJS.ReadableStream & {
      readableLength?: number
      writableLength?: number
      writableEnded?: boolean
    }
    if ((stdout.readableLength ?? 0) > 0) return true
    if ((stdout.writableLength ?? 0) > 0) return true
    if (stdout.writableEnded === true) return true
    return false
  }

  private beginExitInboundDrain(): void {
    if (this.closed || this.exitDrainPending) return
    this.exitDrainPending = true
    this.exitDrainDeferred ??= Promise.withResolvers<void>()
    const boundedDeadline = Math.min(
      this.shutdownDeadlineAt ?? Infinity,
      Date.now() + AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS,
    )
    this.exitDrainDeadlineAt = boundedDeadline
    this.updateStdoutPause()
    this.armExitDrainTimer()
    this.maybeCompleteExitDrain()
  }

  private tightenExitDrainDeadline(deadlineAt: number): void {
    if (!this.exitDrainPending) return
    const nextDeadline = Math.min(this.exitDrainDeadlineAt ?? deadlineAt, deadlineAt)
    if (this.exitDrainDeadlineAt !== undefined && nextDeadline >= this.exitDrainDeadlineAt) return
    this.exitDrainDeadlineAt = nextDeadline
    this.armExitDrainTimer()
  }

  private armExitDrainTimer(): void {
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    if (!this.exitDrainPending || this.exitDrainDeadlineAt === undefined) return
    const remainingMs = this.exitDrainDeadlineAt - Date.now()
    if (remainingMs <= 0) {
      this.completeExitDrain('deadline')
      return
    }
    this.exitDrainTimer = setTimeout(() => {
      this.exitDrainTimer = undefined
      this.completeExitDrain('deadline')
    }, remainingMs)
  }

  private maybeCompleteExitDrain(): void {
    if (!this.exitDrainPending || this.closed) return
    if (this.inboundProcessing) return
    if (this.hasBufferedStdout()) {
      this.updateStdoutPause()
      return
    }
    if (this.stdoutEnded || this.processHasClosed) {
      this.completeExitDrain('eof')
    }
  }

  private completeExitDrain(cause: 'eof' | 'deadline' | 'transport'): void {
    if (!this.exitDrainPending) return
    const incomplete =
      cause === 'deadline'
        ? this.frameBytes > 0 ||
          this.hasBufferedStdout() ||
          this.inboundProcessing ||
          !this.stdoutEnded
        : cause === 'eof'
          ? this.frameBytes > 0
          : true
    const detail =
      cause === 'deadline'
        ? 'Antigravity ACP exit inbound drain deadline expired.'
        : cause === 'eof' && incomplete
          ? 'Antigravity ACP stdout ended with an incomplete frame.'
          : this.stderrText || undefined
    this.exitDrainPending = false
    this.exitDrainDeadlineAt = undefined
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    const deferred = this.exitDrainDeferred
    this.exitDrainDeferred = undefined
    const error = new AgentExecutionError(
      'agent_process_crash',
      this.stderrText || 'Antigravity ACP server exited.',
      true,
    )
    if (!this.closed) {
      this.fail(error, 'process_exit', {
        cause,
        incomplete,
        ...(detail !== undefined ? { detail } : {}),
      })
    }
    deferred?.resolve()
    if (!this.shutdownPromise) {
      void this.close(error).catch(() => undefined)
    }
  }

  async close(error = new Error('Antigravity ACP connection closed.')): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // oxlint-disable-next-line promise/no-promise-in-callback -- Publish completion before onClosed can reenter.
    const completion = Promise.withResolvers<void>()
    this.shutdownPromise = completion.promise
    if (!this.closed) {
      if (this.exitDrainPending) {
        this.maybeCompleteExitDrain()
        if (this.exitDrainPending && this.exitDrainDeferred) {
          // oxlint-disable-next-line promise/no-promise-in-callback -- close accepts an Error, not a callback.
          void this.exitDrainDeferred.promise
            .then(() => {
              if (!this.closed) {
                this.fail(error, 'process_exit', {
                  cause: 'transport',
                  incomplete:
                    this.frameBytes > 0 ||
                    this.hasBufferedStdout() ||
                    this.inboundProcessing ||
                    !this.stdoutEnded,
                  detail: formatCloseErrorDetail(error),
                })
              }
              return this.performClose()
            })
            .then(completion.resolve, completion.reject)
          return completion.promise
        }
      }
      if (!this.closed) {
        this.fail(error, 'transport_failure', {
          cause: 'transport',
          incomplete:
            this.frameBytes > 0 ||
            this.hasBufferedStdout() ||
            this.inboundProcessing ||
            !this.stdoutEnded,
          detail: formatCloseErrorDetail(error),
        })
      }
    }
    // oxlint-disable-next-line promise/no-promise-in-callback -- close accepts an Error, not a callback.
    void this.performClose().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async performClose(): Promise<void> {
    this.shutdownStarted = true
    this.closeInFlight = true
    const closeDeadlineAt =
      this.shutdownDeadlineAt ??
      Date.now() +
        (this.closeOwnedProcess ? 4_000 : AGY_SHUTDOWN_TIMEOUT_MS + AGY_FORCE_EXIT_TIMEOUT_MS)
    try {
      this.shutdownTask ??= this.shutdown().then(
        () => {
          this.shutdownSucceeded = true
          this.shutdownAttemptSettled = true
          this.recheckPhysicalRelease()
          return undefined
        },
        (shutdownError: unknown) => {
          this.shutdownAttemptSettled = true
          this.startWatchingLatePhysicalRelease()
          throw shutdownError
        },
      )
      void this.shutdownTask.catch(() => undefined)
      try {
        await this.raceWithShutdownDeadline(
          this.shutdownTask,
          this.closeOwnedProcess ? undefined : closeDeadlineAt,
          'Antigravity shutdown exceeded its existing deadline.',
        )
      } catch (shutdownError) {
        this.startWatchingLatePhysicalRelease()
        throw shutdownError
      }
      try {
        await this.waitForProcessClosed(closeDeadlineAt)
      } catch (closeWaitError) {
        this.startWatchingLatePhysicalRelease()
        throw closeWaitError
      }
      this.ensureOwnerReleaseListener()
      if (this.whenProcessOwnerReleased && !this.ownerReleaseNotified) {
        await Promise.resolve()
      }
      if (!this.isOwnerReleaseConfirmed()) {
        this.startWatchingLatePhysicalRelease()
        throw createUnconfirmedProcessError(
          'Antigravity owned process scope did not confirm release.',
        )
      }
      this.markPhysicalReleaseVerified()
      await this.raceWithShutdownDeadline(
        this.finalizePhysicalRequestsOnVerifiedClose(),
        undefined,
        'Antigravity physical close finalization did not finish before its deadline.',
      )
    } finally {
      this.closeInFlight = false
    }
  }

  private async waitForProcessClosed(deadlineAt: number): Promise<void> {
    if (this.processHasClosed) return
    await this.raceWithShutdownDeadline(
      this.processClosed,
      deadlineAt,
      'Antigravity process stdio did not close before its deadline.',
    )
  }

  private ensureOwnerReleaseListener(): void {
    if (this.ownerReleaseListenerStarted || !this.whenProcessOwnerReleased) return
    this.ownerReleaseListenerStarted = true
    let notification: Promise<void>
    try {
      notification = Promise.resolve(this.whenProcessOwnerReleased())
    } catch {
      return
    }
    void notification.then(
      () => {
        this.ownerReleaseNotified = true
        this.recheckPhysicalRelease()
        return undefined
      },
      () => undefined,
    )
  }

  private startWatchingLatePhysicalRelease(): void {
    if (this.lateReleaseWatchStarted || this.physicalReleaseObserved) return
    this.lateReleaseWatchStarted = true
    void this.processClosed.then(() => {
      this.recheckPhysicalRelease()
      return undefined
    })
    this.ensureOwnerReleaseListener()
    this.recheckPhysicalRelease()
  }

  private markPhysicalReleaseVerified(): void {
    if (this.physicalReleaseObserved) return
    this.physicalReleaseObserved = true
    void this.finalizePhysicalRequestsOnVerifiedClose()
  }

  private finalizePhysicalRequestsOnVerifiedClose(): Promise<void> {
    this.physicalFinalizationPromise ??= (async () => {
      await this.processClosed
      await Promise.allSettled([this.outboundWriteTask, this.receiveTask, this.parserCompletion])
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id)
        this.unconfirmedCloseRequestIds.delete(id)
        pending.physicalResolve(pending.replyTerminal ?? 'connection_closed')
      }
      this.unconfirmedCloseRequestIds.clear()
      this.physicalReleaseFinalized = true
      this.physicalReleaseDeferred.resolve()
    })()
    return this.physicalFinalizationPromise
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
      if (this.closed || !isPlainObject(message)) return
      reservation.resize(Math.max(reservation.bytes, heldBytes))
      const seq = ++this.nextInboundSeq
      const recordMessage = message

      const id = Reflect.get(message, 'id')
      const method = Reflect.get(message, 'method')
      if (typeof method !== 'string' && typeof id === 'number' && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!
        // Freeze terminal reply state (`reply` vs `invalid_reply`) on the FIRST matching response frame
        // so late duplicate frames arriving before writer drain cannot overwrite outcome or enter streams.
        if (pending.replyTerminal !== undefined) {
          return
        }
        if (!pending.dispatched) {
          const protocolError = tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity returned a response for an undispatched ACP request.',
              false,
            ),
            'protocol_error',
          )
          this.settleRequest(id, protocolError, undefined, 'transport_failure')
          this.dropQueuedRequestFrame(id, protocolError)
          return
        }
        const malformedReason = validateJsonRpcResponse(message)
        if (malformedReason !== undefined) {
          pending.replyTerminal = 'invalid_reply'
          const protocolError = tagRequestFailure(
            new AgentExecutionError('protocol_error', malformedReason, false),
            'protocol_error',
          )
          if (!pending.logicalSettled) {
            this.settleRequest(id, protocolError, undefined, 'transport_failure')
          } else {
            this.completePhysicalRequest(id, pending)
          }
          this.taint(protocolError)
          return
        }
        pending.replyTerminal = 'reply'
        if (
          pending.replyConsumer &&
          pending.replyConsumer.ordered &&
          !pending.replyConsumer.abandoned &&
          !pending.replyConsumer.producerSealed
        ) {
          const replyIngress: Exclude<AgyIngress, { kind: 'end' }> = {
            kind: 'reply',
            seq,
            requestId: id,
            message: recordMessage,
          }
          retained = this.enqueueSessionIngress(
            pending.replyConsumer,
            replyIngress,
            wireBytes,
            heldBytes,
            reservation,
          )
        }
        this.settleRequest(id, undefined, message)
        return
      }
      if (Object.hasOwn(message, 'id') && typeof method !== 'string') return

      if (Object.hasOwn(message, 'id') && typeof method === 'string') {
        const rpcId = typeof id === 'string' || typeof id === 'number' ? id : undefined
        const reqSessionId = extractServerRequestSessionId(message)
        const getActiveOrderedConsumer = (
          sessionId: string | undefined,
        ): SessionNotificationConsumer | undefined => {
          if (sessionId === undefined) return undefined
          const consumer = this.sessionConsumers.get(sessionId)
          return consumer && consumer.ordered && !consumer.abandoned && !consumer.producerSealed
            ? consumer
            : undefined
        }
        const enqueueOrderedServerRequest = (consumer: SessionNotificationConsumer): boolean => {
          if (rpcId === undefined) return false
          const serverReqIngress: Exclude<AgyIngress, { kind: 'end' }> = {
            kind: 'server_request',
            seq,
            rpcId,
            method,
            message: recordMessage,
          }
          retained = this.enqueueSessionIngress(
            consumer,
            serverReqIngress,
            wireBytes,
            heldBytes,
            reservation,
          )
          return true
        }

        // Resolve unique ownership BEFORE enqueuing into any ordered stream or invoking a direct handler.
        if (reqSessionId !== undefined) {
          let matchedOwner: RegisteredServerRequestOwner | undefined
          let matchedCount = 0
          for (const owner of this.serverRequestOwners.values()) {
            if (owner.knownSessionId !== undefined && owner.knownSessionId === reqSessionId) {
              matchedOwner = owner
              matchedCount += 1
            }
          }
          if (matchedCount > 1) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'Ambiguous active session owners for this ACP request.',
              )
            }
            return
          }
          const orderedConsumer = getActiveOrderedConsumer(reqSessionId)
          if (orderedConsumer && enqueueOrderedServerRequest(orderedConsumer)) {
            return
          }
          if (matchedCount === 1 && matchedOwner?.handler(message, seq)) {
            return
          }
          if (this.serverRequestOwners.size > 0) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
        } else {
          if (this.serverRequestOwners.size > 1) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
          if (this.serverRequestOwners.size === 1) {
            const soleOwner = this.serverRequestOwners.values().next().value!
            const activeOrdered = [...this.sessionConsumers.values()].filter(
              (c) => c.ordered && !c.abandoned && !c.producerSealed,
            )
            const otherOrderedExists = activeOrdered.some(
              (c) => c.sessionId !== soleOwner.knownSessionId,
            )
            if (otherOrderedExists) {
              if (rpcId !== undefined) {
                await this.respondServerRequestErrorIfOpen(
                  rpcId,
                  'No active session handler accepted this ACP request.',
                )
              }
              return
            }
            const soleOrdered = getActiveOrderedConsumer(soleOwner.knownSessionId)
            if (soleOrdered && enqueueOrderedServerRequest(soleOrdered)) {
              return
            }
            if (soleOwner.handler(message, seq)) {
              return
            }
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
          if (this.serverRequestListeners.size === 0) {
            const activeOrdered = [...this.sessionConsumers.values()].filter(
              (c) => c.ordered && !c.abandoned && !c.producerSealed,
            )
            if (activeOrdered.length === 1 && enqueueOrderedServerRequest(activeOrdered[0]!)) {
              return
            }
          }
        }

        for (const listener of this.serverRequestListeners) {
          if (listener(message)) return
        }
        if (rpcId !== undefined) {
          await this.respondServerRequestErrorIfOpen(
            rpcId,
            'No active session handler accepted this ACP request.',
          )
        }
        return
      }

      for (const listener of this.backgroundListeners) {
        if (listener(message)) return
      }

      const notificationIngress: Exclude<AgyIngress, { kind: 'end' }> = {
        kind: 'notification',
        seq,
        message: recordMessage,
      }
      const sessionId = extractNotificationSessionId(message)
      const sessionConsumer = sessionId ? this.sessionConsumers.get(sessionId) : undefined
      if (sessionConsumer && !sessionConsumer.abandoned && !sessionConsumer.producerSealed) {
        retained = this.enqueueSessionIngress(
          sessionConsumer,
          notificationIngress,
          wireBytes,
          heldBytes,
          reservation,
        )
        return
      }

      if (this.notificationWaiter) {
        const waiter = this.notificationWaiter
        this.notificationWaiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.resolve(message)
        this.notifyPhysicalWorkIdleIfSettled()
        return
      }

      this.admitQueuedNotification(wireBytes, heldBytes, reservation)
      this.notificationQueue.push({
        sessionId,
        ingress: notificationIngress,
        bytes: wireBytes,
        reservation,
      })
      retained = true
      this.updateStdoutPause()
    } finally {
      if (parserPhysical) {
        const completion = parserPhysical
        void completion.then(() => {
          if (!retained) reservation.release()
          if (this.parserCompletion === completion) this.parserCompletion = undefined
          return undefined
        })
      } else if (!retained) {
        reservation.release()
      }
    }
  }

  private async respondServerRequestErrorIfOpen(
    rpcId: string | number,
    message: string,
    code = -32_601,
  ): Promise<void> {
    // During post-exit inbound drain, stdin is already closed; skip outbound error writes
    // so subsequent buffered reply frames in the same chunk continue to be parsed and delivered.
    if (this.exitRecorded && !this.isOpen) {
      return
    }
    await this.respondError(rpcId, message, code)
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
    if (error && pending.method === 'session/close' && this.pendingRequests.get(id) === pending) {
      if (!this.unconfirmedCloseRequestIds.has(id)) {
        this.unconfirmedCloseRequestIds.add(id)
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
  }

  private finishRequestWrite(id: number | undefined): void {
    if (id === undefined) return
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    pending.writeJoined = true
    if (pending.logicalSettled) this.completePhysicalRequest(id, pending)
  }

  private taint(reason: Error): void {
    if (this.tainted) return
    this.tainted = true
    this.taintError = reason
    this.onTainted?.(reason)
    // Outbound cannot deliver replies or cancellations once tainted; immediately trigger
    // idempotent close so any active leased runs on this connection unblock deterministically
    // while retaining the physical process slot until confirmed release.
    if (!this.closed) {
      void this.close(reason).catch(() => undefined)
    }
  }

  private completePhysicalRequest(id: number, pending: PendingRequest): void {
    if (
      !pending.logicalSettled ||
      !pending.writeJoined ||
      (pending.replyTerminal === undefined && pending.dispatched)
    )
      return
    if (this.pendingRequests.get(id) !== pending) return
    this.pendingRequests.delete(id)
    this.unconfirmedCloseRequestIds.delete(id)
    const outcome: AgyRequestPhysicalCompletion = pending.replyTerminal ?? 'not_sent'
    pending.physicalResolve(outcome)
    this.updateStdoutPause()
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private notifyPhysicalWorkIdleIfSettled(): void {
    if (!this.closed && !this.hasActiveWorkExcludingUnconfirmedCloses()) {
      this.onPhysicalWorkIdle?.()
    }
  }

  private settleNotificationWaiter(error: Error): void {
    const waiter = this.notificationWaiter
    if (!waiter) return
    this.notificationWaiter = undefined
    this.cleanupNotificationWaiter(waiter)
    waiter.reject(error)
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private cleanupNotificationWaiter(waiter: NotificationWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private resumeStdoutIfNeeded(): void {
    this.updateStdoutPause()
  }

  private hasDirectServerRequestOwner(): boolean {
    for (const owner of this.serverRequestOwners.values()) {
      const consumer =
        owner.knownSessionId !== undefined
          ? this.sessionConsumers.get(owner.knownSessionId)
          : undefined
      const routedViaOrderedStream = Boolean(
        consumer && consumer.ordered && !consumer.abandoned && !consumer.producerSealed,
      )
      if (!routedViaOrderedStream) return true
    }
    return false
  }

  private updateStdoutPause(): void {
    const canWaitForConsumer =
      this.pendingRequests.size === 0 &&
      this.serverRequestListeners.size === 0 &&
      !this.hasDirectServerRequestOwner()
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
      (this.inboundProcessing ||
        (!this.exitDrainPending && canWaitForConsumer && this.notificationQueuePaused))
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
      return Promise.reject(
        this.taintError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
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
        tagRequestFailure(
          new AgentExecutionError(
            'runtime_incompatible',
            'Native ACP request preparation capacity is full. This frame was not written.',
            false,
          ),
          'capacity',
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

  private dropQueuedRequestFrame(requestId: number, error: Error): void {
    for (let index = this.outboundHead; index < this.outboundQueue.length; index += 1) {
      const frame = this.outboundQueue[index]
      if (!frame || frame.requestId !== requestId) continue
      if (frame === this.activeOutboundFrame) return
      this.outboundQueue.splice(index, 1)
      this.releaseOutbound(frame)
      this.finishRequestWrite(frame.requestId)
      frame.physicalResolve?.()
      frame.reject(error)
      this.notifyPhysicalWorkIdleIfSettled()
      return
    }
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

  private fail(
    error: Error,
    failureSource: DiagnosticFailureSource = 'transport_failure',
    endMeta?: {
      readonly cause: 'eof' | 'transport' | 'deadline'
      readonly incomplete: boolean
      readonly detail?: string | undefined
    },
  ): void {
    if (this.closed) return
    const effectiveEndCause = endMeta?.cause ?? 'transport'
    const effectiveIncomplete =
      endMeta?.incomplete ??
      (this.frameBytes > 0 ||
        this.hasBufferedStdout() ||
        this.inboundProcessing ||
        !this.stdoutEnded)
    const effectiveDetail = endMeta?.detail ?? formatCloseErrorDetail(error)
    this.closed = true
    this.closeError = error
    this.exitDrainPending = false
    this.exitDrainDeadlineAt = undefined
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    const exitDrainDeferred = this.exitDrainDeferred
    this.exitDrainDeferred = undefined
    this.child.stdout.removeListener('data', this.receive)
    this.child.stdout.removeListener('end', this.onStdoutEnded)
    this.child.stdout.removeListener('error', this.onStdoutError)
    this.child.stderr.removeListener('data', this.receiveError)
    this.child.removeListener('exit', this.processExited)
    this.child.removeListener('close', this.exited)
    this.pendingServerRequestCancels.length = 0
    this.pendingServerRequestCancelsHead = 0
    this.activeOutboundFrame?.controller.abort()
    this.inboundController.abort()
    this.frameReservation?.release()
    this.frameReservation = undefined
    clearTimeout(this.frameDeadline)
    this.frameDeadline = undefined
    for (const id of this.pendingRequests.keys())
      this.settleRequest(id, error, undefined, failureSource)
    this.settleNotificationWaiter(error)
    // Seal the producer side of every active session consumer WITHOUT wiping already-queued
    // trailing items or releasing their reservations early; consumers drain queued items first
    // and receive `{ kind: 'end', ... }` only after the queue empties (or release on `abandon()`).
    for (const consumer of this.sessionConsumers.values()) {
      this.sealConsumerProducer(
        consumer,
        effectiveEndCause,
        effectiveIncomplete,
        effectiveDetail,
        error,
      )
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
    for (let i = this.notificationHead; i < this.notificationQueue.length; i += 1) {
      const queued = this.notificationQueue[i]
      if (!queued) continue
      this.notificationQueue[i] = undefined
      this.queuedInboundBytes -= queued.bytes
      this.queuedInboundCount -= 1
      queued.reservation.release()
    }
    this.notificationQueue.length = 0
    this.backgroundListeners.clear()
    this.serverRequestListeners.clear()
    this.serverRequestOwners.clear()
    this.notificationHead = 0
    this.frameChunks = []
    this.frameBytes = 0
    this.notificationQueuePaused = false
    this.writing = false
    if (this.stdoutPaused) this.child.stdout.resume()
    this.stdoutPaused = false
    exitDrainDeferred?.resolve()
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
      this.groupCloseSucceeded = true
      this.recordExit(this.child.exitCode)
      return
    }
    if (this.child.exitCode !== null || this.child.signalCode != null) {
      this.recordExit(this.child.exitCode)
      return
    }
    const remaining = (): number =>
      this.shutdownDeadlineAt === undefined ? Infinity : this.shutdownDeadlineAt - Date.now()
    if (remaining() <= 0)
      throw createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let forceTimeout: ReturnType<typeof setTimeout> | undefined
      let escalated = false
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timeout)
        clearTimeout(forceTimeout)
        this.shutdownDeadlineListeners.delete(onDeadlineTightened)
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
      const escalate = (): void => {
        if (settled || escalated) return
        escalated = true
        clearTimeout(timeout)
        if (remaining() <= 0) {
          fail(
            createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.'),
          )
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
            fail(createUnconfirmedProcessError('Antigravity process did not exit after SIGKILL.'))
          },
          Math.min(AGY_FORCE_EXIT_TIMEOUT_MS, Math.max(1, remaining())),
        )
      }
      let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
        escalate,
        Math.min(AGY_SHUTDOWN_TIMEOUT_MS, Math.max(1, remaining())),
      )
      const onDeadlineTightened = (): void => {
        if (settled) return
        if (!escalated) {
          clearTimeout(timeout)
          const rem = remaining()
          if (rem <= 0) {
            escalate()
          } else {
            timeout = setTimeout(escalate, Math.min(AGY_SHUTDOWN_TIMEOUT_MS, rem))
          }
        } else {
          clearTimeout(forceTimeout)
          const rem = remaining()
          if (rem <= 0) {
            fail(
              createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.'),
            )
          } else {
            forceTimeout = setTimeout(
              () => {
                fail(
                  createUnconfirmedProcessError('Antigravity process did not exit after SIGKILL.'),
                )
              },
              Math.min(AGY_FORCE_EXIT_TIMEOUT_MS, rem),
            )
          }
        }
      }
      this.shutdownDeadlineListeners.add(onDeadlineTightened)
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
  /** True when the underlying owner manages a process group rather than a bare child process. */
  isOwnedGroup?: boolean
  /** Reports whether the underlying process owner (e.g. OwnedProcessGroup) has confirmed full release. */
  isReleased?: () => boolean
  /** Optional notification resolving once the underlying process owner confirms full release. */
  whenReleased?: () => Promise<void>
  /** True when late release requires bounded active-waiter probing (e.g. POSIX PGID ESRCH) rather than event-only notification. */
  needsReleaseProbe?: boolean
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
  closeSession(
    sessionId: string,
    options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<AgySessionCloseResult>
  recordUnconfirmedSessionClose(sessionId: string): void
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
  /** The single connection generation ever spawned for this entry (preserved across clear for late closeSession). */
  ownedConnection: AgyAcpConnection | undefined
  /** True while this entry holds a reserved physical process slot before spawn finishes. */
  processSlotReserved: boolean
  starting: Promise<AgyAcpConnection> | undefined
  closing: Promise<void> | undefined
  initializing: Promise<object> | undefined
  initializedResult: object | undefined
  readonly activeLeases: Set<symbol>
  /** Sessions currently authorized to retain Full access in this canonical directory. */
  readonly fullAccessSessions: Set<string>
  /** Bounded set of sessions whose `session/close` failed or timed out on this connection. */
  readonly unconfirmedClosedSessions: Set<string>
  /** Set when Full access was retired while active leases were still draining. */
  drainingFullAccess: boolean
  /** Set when any unconfirmed session/close or failed generation retired this entry from new lease allocation. */
  retiring: boolean
  /** Set when a zero-Turn cold check requested immediate close once pending physical work drains. */
  closeWhenIdle: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

class DisposedSpawnCloseError extends Error {
  constructor(readonly closeCause: unknown) {
    super('Antigravity process spawned during disposal failed to confirm close.', {
      cause: closeCause,
    })
  }
}

interface PoolCapacityWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal | undefined
  onAbort?: (() => void) | undefined
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
  private readonly retiringEntries = new Set<PooledConnectionEntry>()
  private readonly unconfirmedClosedSessions = new Set<string>()
  private readonly pendingLeaseReservations = new Set<symbol>()
  private readonly capacityWaiters = new Set<PoolCapacityWaiter>()
  private readonly physicalOperationListeners = new Set<
    (signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>) => void
  >()
  private readonly closingTasks = new Set<Promise<void>>()
  private readonly activeClosingConnections = new Set<AgyAcpConnection>()
  private readonly unconfirmedClosingConnections = new Set<AgyAcpConnection>()
  private readonly shutdownDeadlineListeners = new Set<(deadlineAt: number) => void>()
  private boundedUnconfirmedProbeTimer: ReturnType<typeof setInterval> | undefined
  private activeShutdownWaiters = 0
  private disposed = false
  private activeDisposal: Promise<void> | undefined
  private disposalSettledCleanly = false
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
    for (const entry of this.retiringEntries) {
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
    for (const entry of this.retiringEntries) {
      if (entry.connection?.isOpen && entry.connection.executorId === executorId) {
        return true
      }
    }
    return false
  }

  get unconfirmedClosingCount(): number {
    return this.unconfirmedClosingConnections.size
  }

  get retiringCount(): number {
    return this.retiringEntries.size
  }

  get unconfirmedClosedSessionCount(): number {
    return this.unconfirmedClosedSessions.size
  }

  hasUnconfirmedClosedSession(sessionId: string): boolean {
    return this.unconfirmedClosedSessions.has(sessionId)
  }

  get activeLeaseCount(): number {
    let total = this.pendingLeaseReservations.size
    for (const entry of this.entries.values()) total += entry.activeLeases.size
    for (const entry of this.retiringEntries) total += entry.activeLeases.size
    return total
  }

  private hasPhysicalSlot(entry: PooledConnectionEntry): boolean {
    return Boolean(entry.connection || entry.starting || entry.processSlotReserved)
  }

  get occupiedProcessSlotCount(): number {
    let count = this.unconfirmedClosingConnections.size
    for (const conn of this.activeClosingConnections) {
      if (!this.unconfirmedClosingConnections.has(conn)) count += 1
    }
    for (const entry of this.entries.values()) {
      if (this.hasPhysicalSlot(entry)) count += 1
    }
    for (const entry of this.retiringEntries) {
      if (this.hasPhysicalSlot(entry)) count += 1
    }
    return count
  }

  private isReusableEntry(entry: PooledConnectionEntry): boolean {
    return (
      !entry.retiring &&
      !entry.closing &&
      (Boolean(entry.connection?.isOpen) || Boolean(entry.starting) || entry.processSlotReserved)
    )
  }

  private detachNonReusableEntry(entry: PooledConnectionEntry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    entry.retiring = true
    if (entry.connection && !entry.closing) {
      if (!this.disposed) this.retiringEntries.add(entry)
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity ACP connection closed.'),
        entry.connection,
      ).catch(() => undefined)
      return
    }
    if (entry.activeLeases.size > 0 || this.hasPhysicalSlot(entry) || Boolean(entry.closing)) {
      if (!this.disposed) this.retiringEntries.add(entry)
    } else {
      this.retiringEntries.delete(entry)
    }
  }

  private removeEntry(entry: PooledConnectionEntry): void {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    this.retiringEntries.delete(entry)
  }

  private recheckUnconfirmedClosings(): void {
    for (const conn of this.unconfirmedClosingConnections) {
      conn.recheckPhysicalRelease()
      if (conn.isPhysicallyReleased) {
        this.unconfirmedClosingConnections.delete(conn)
      }
    }
    this.updateBoundedUnconfirmedProbe()
  }

  private hasProbeableUnconfirmedClosings(): boolean {
    for (const conn of this.unconfirmedClosingConnections) {
      if (conn.supportsReleaseProbe()) return true
    }
    return false
  }

  private updateBoundedUnconfirmedProbe(): void {
    const shouldProbe =
      (this.capacityWaiters.size > 0 || this.activeShutdownWaiters > 0) &&
      this.hasProbeableUnconfirmedClosings()
    if (!shouldProbe) {
      if (this.boundedUnconfirmedProbeTimer) {
        clearInterval(this.boundedUnconfirmedProbeTimer)
        this.boundedUnconfirmedProbeTimer = undefined
      }
      return
    }
    if (this.boundedUnconfirmedProbeTimer) return
    this.boundedUnconfirmedProbeTimer = setInterval(() => {
      this.recheckUnconfirmedClosings()
    }, 25)
    this.boundedUnconfirmedProbeTimer.unref?.()
  }

  private quarantineUnconfirmedConnection(target: AgyAcpConnection): void {
    if (target.isPhysicallyReleased || this.unconfirmedClosingConnections.has(target)) return
    this.unconfirmedClosingConnections.add(target)
    this.updateBoundedUnconfirmedProbe()
    void target.whenPhysicallyReleased().finally(() => {
      if (this.unconfirmedClosingConnections.delete(target)) {
        this.updateBoundedUnconfirmedProbe()
        this.notifyCapacityWaiters()
      }
    })
  }

  poolSnapshot(): Array<{
    canonicalCwd: string
    permissionScope: AgyPermissionScope
    open: boolean
    activeLeases: number
    fullAccessSessions: number
    drainingFullAccess: boolean
    retiring: boolean
  }> {
    return [...this.entries.values(), ...this.retiringEntries].map((entry) => ({
      canonicalCwd: entry.canonicalCwd,
      permissionScope: entry.permissionScope,
      open: Boolean(entry.connection?.isOpen),
      activeLeases: entry.activeLeases.size,
      fullAccessSessions: entry.fullAccessSessions.size,
      drainingFullAccess: entry.drainingFullAccess,
      retiring: entry.retiring,
    }))
  }

  async acquire(input: AgyPoolAcquireInput): Promise<AgyPoolLease> {
    input.signal?.throwIfAborted()
    if (this.disposed || this.activeDisposal) {
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
    let capacityDeadlineAt: number | undefined
    try {
      canonicalCwd = await realpath(input.cwd)
      input.signal?.throwIfAborted()
      if (this.disposed || this.activeDisposal) {
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
      if (entry && !this.isReusableEntry(entry)) {
        this.detachNonReusableEntry(entry)
        entry = undefined
      }
      if (!entry) {
        capacityDeadlineAt = Date.now() + AGY_CONTROL_RPC_TIMEOUT_MS
        this.recheckUnconfirmedClosings()
        this.evictSettledEntries()
        while (!entry && this.occupiedProcessSlotCount >= AGY_MAX_CONTEXTS * 2) {
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (Date.now() >= capacityDeadlineAt) {
            throw new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            )
          }
          const candidate = this.findEvictableEntry()
          if (candidate) {
            const eviction = this.closeEntryConnection(
              candidate,
              new Error(
                candidate.connection?.isOpen
                  ? 'Antigravity idle connection evicted at pool capacity.'
                  : 'Antigravity closed connection finalized at pool capacity.',
              ),
            ).catch(() => undefined)
            // oxlint-disable-next-line no-await-in-loop -- Physically closes one 0-lease idle or dead connection under the shared admission deadline.
            await this.waitForCapacityOrTask(eviction, input.signal, capacityDeadlineAt)
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Waits until a retiring/closing process confirms release or an active entry becomes idle.
            await this.waitForCapacitySlot(input.signal, capacityDeadlineAt)
          }
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          this.recheckUnconfirmedClosings()
          this.evictSettledEntries()
          const existing = this.entries.get(key)
          if (existing && this.isReusableEntry(existing)) {
            entry = existing
          } else if (existing) {
            this.detachNonReusableEntry(existing)
          }
        }
        if (!entry) {
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (Date.now() >= capacityDeadlineAt) {
            throw new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            )
          }
          entry = {
            key,
            canonicalCwd,
            permissionScope: input.permissionScope,
            connection: undefined,
            ownedConnection: undefined,
            processSlotReserved: true,
            starting: undefined,
            closing: undefined,
            initializing: undefined,
            initializedResult: undefined,
            activeLeases: new Set(),
            fullAccessSessions: new Set(),
            unconfirmedClosedSessions: new Set(),
            drainingFullAccess: false,
            retiring: false,
            closeWhenIdle: false,
            idleTimer: undefined,
          }
          this.entries.set(key, entry)
        }
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
      const connection = await this.ensureEntryConnection(
        pooledEntry,
        input.signal,
        capacityDeadlineAt,
      )
      input.signal?.throwIfAborted()
      return {
        connection,
        canonicalCwd,
        permissionScope: input.permissionScope,
        ensureInitialized: (signal) => this.initializeEntry(pooledEntry, connection, signal),
        closeSession: async (sessionId, options) => {
          const result = await connection.closeSession(sessionId, options)
          if (!result.confirmed) {
            this.recordUnconfirmedClosedSession(pooledEntry, connection, sessionId)
          }
          return result
        },
        recordUnconfirmedSessionClose: (sessionId: string) => {
          this.recordUnconfirmedClosedSession(pooledEntry, connection, sessionId)
        },
        disposeIfIdle: async () => {
          release()
          if (pooledEntry.activeLeases.size > 0) return
          if (pooledEntry.connection === connection) {
            const hasActiveWork = pooledEntry.retiring
              ? connection.hasActiveWorkExcludingUnconfirmedCloses()
              : connection.hasPendingPhysicalWork()
            if (!hasActiveWork) {
              await this.closeEntryConnection(
                pooledEntry,
                new Error(
                  pooledEntry.retiring
                    ? 'Antigravity ACP retiring connection drained and closed.'
                    : 'Antigravity cold verification session settled.',
                ),
                connection,
              )
            } else {
              pooledEntry.closeWhenIdle = true
            }
          } else if (pooledEntry.closing) {
            await pooledEntry.closing
          } else if (pooledEntry.ownedConnection === connection) {
            connection.recheckPhysicalRelease()
            if (!connection.isPhysicallyReleased) {
              const existingClose = connection.existingClosePromise()
              if (existingClose) {
                await existingClose
              } else {
                await this.closeEntryConnection(
                  pooledEntry,
                  new Error('Antigravity ACP connection did not confirm physical release.'),
                  connection,
                )
              }
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
    for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
      if (entry.permissionScope !== 'full') continue
      if (targetCanonical && entry.canonicalCwd !== targetCanonical) continue
      if (options.sessionId) {
        entry.fullAccessSessions.delete(options.sessionId)
      } else {
        entry.fullAccessSessions.clear()
      }
      if (entry.fullAccessSessions.size === 0) {
        entry.drainingFullAccess = true
        const hasActiveWork = entry.retiring
          ? Boolean(entry.connection?.hasActiveWorkExcludingUnconfirmedCloses())
          : Boolean(entry.connection?.hasPendingPhysicalWork())
        if (entry.activeLeases.size === 0 && (!hasActiveWork || !entry.connection?.isOpen)) {
          if (entry.connection) {
            closings.push(
              this.closeEntryConnection(
                entry,
                new Error('Antigravity Full access connection retired after draining.'),
              ),
            )
          } else if (entry.closing) {
            closings.push(entry.closing)
          }
        }
      }
    }
    if (closings.length > 0) await Promise.all(closings)
  }

  capShutdownDeadline(deadlineAt: number): void {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
      throw new Error('Invalid Antigravity shutdown deadline.')
    }
    const next = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
    const tightened = this.shutdownDeadlineAt === undefined || next < this.shutdownDeadlineAt
    this.shutdownDeadlineAt = next
    for (const entry of this.entries.values()) {
      entry.connection?.capShutdownDeadline(this.shutdownDeadlineAt)
      if (entry.ownedConnection && entry.ownedConnection !== entry.connection) {
        entry.ownedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
    }
    for (const entry of this.retiringEntries) {
      entry.connection?.capShutdownDeadline(this.shutdownDeadlineAt)
      if (entry.ownedConnection && entry.ownedConnection !== entry.connection) {
        entry.ownedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
    }
    for (const conn of this.activeClosingConnections) {
      conn.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    for (const conn of this.unconfirmedClosingConnections) {
      conn.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    if (tightened) {
      for (const listener of Array.from(this.shutdownDeadlineListeners)) {
        listener(next)
      }
    }
  }

  private awaitSettledWithShutdownDeadline<T>(
    tasks: Promise<T>[],
    timeoutMessage: string,
  ): Promise<PromiseSettledResult<T>[]> {
    if (tasks.length === 0) return Promise.resolve([])
    const allSettled = Promise.allSettled(tasks)
    if (this.shutdownDeadlineAt !== undefined && this.shutdownDeadlineAt <= Date.now()) {
      return Promise.reject(createUnconfirmedProcessError(timeoutMessage))
    }
    return new Promise<PromiseSettledResult<T>[]>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        timer = undefined
        this.shutdownDeadlineListeners.delete(rearm)
      }
      const finishResolve = (results: PromiseSettledResult<T>[]): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(results)
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const rearm = (): void => {
        if (settled) return
        clearTimeout(timer)
        timer = undefined
        if (this.shutdownDeadlineAt === undefined) return
        const remainingMs = this.shutdownDeadlineAt - Date.now()
        if (remainingMs <= 0) {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
          return
        }
        timer = setTimeout(() => {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
        }, remainingMs)
      }
      this.shutdownDeadlineListeners.add(rearm)
      rearm()
      void allSettled.then(finishResolve)
    })
  }

  /**
   * Synchronously checks whether this entire pool is idle (allowing healthy settled connections
   * holding only the 5-minute `idleTimer`), and atomically seals against new `acquire()` calls
   * before initiating physical shutdown while keeping `occupiedProcessSlotCount` tied to actual exit.
   */
  tryRetireIdle(deadlineAt?: number): AgyPoolIdleRetirement {
    if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) {
      throw new Error('Invalid Antigravity shutdown deadline.')
    }
    this.recheckUnconfirmedClosings()
    this.evictSettledEntries()
    if (
      this.disposed ||
      this.activeDisposal ||
      this.activeLeaseCount > 0 ||
      this.unconfirmedClosingConnections.size > 0 ||
      this.activeClosingConnections.size > 0 ||
      this.retiringEntries.size > 0 ||
      this.closingTasks.size > 0
    ) {
      return { kind: 'busy' }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.activeLeases.size > 0 ||
        entry.starting !== undefined ||
        entry.initializing !== undefined ||
        entry.processSlotReserved ||
        entry.closing !== undefined ||
        entry.retiring ||
        entry.drainingFullAccess ||
        entry.fullAccessSessions.size > 0
      ) {
        return { kind: 'busy' }
      }
      if (
        entry.connection &&
        (!entry.connection.isOpen ||
          entry.connection.hasPendingPhysicalWork() ||
          entry.connection.hasActiveSessionOwners())
      ) {
        return { kind: 'busy' }
      }
    }
    // Atomically seal against new `acquire()` calls before initiating physical close.
    const physical = this.dispose(deadlineAt)
    return { kind: 'retiring', physical }
  }

  retireIdleCandidate(deadlineAt?: number): AgyPoolIdleRetirement {
    return this.tryRetireIdle(deadlineAt)
  }

  dispose(flushDeadlineAt?: number): Promise<void> {
    if (
      flushDeadlineAt !== undefined &&
      (!Number.isSafeInteger(flushDeadlineAt) || flushDeadlineAt <= 0)
    ) {
      return Promise.reject(new Error('Invalid Antigravity shutdown deadline.'))
    }
    if (flushDeadlineAt !== undefined) this.capShutdownDeadline(flushDeadlineAt)
    this.disposed = true
    this.rejectAllCapacityWaiters(
      new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
    )
    if (this.activeDisposal) return this.activeDisposal
    if (this.disposalSettledCleanly) {
      this.recheckUnconfirmedClosings()
      if (
        this.occupiedProcessSlotCount === 0 &&
        this.closingTasks.size === 0 &&
        this.unconfirmedClosingConnections.size === 0
      ) {
        return Promise.resolve()
      }
      this.disposalSettledCleanly = false
    }

    const attempt = (async () => {
      this.recheckUnconfirmedClosings()
      if (this.unconfirmedClosingConnections.size > 0) {
        await Promise.resolve()
        this.recheckUnconfirmedClosings()
      }
      const tasks: Promise<void>[] = []
      const seenTasks = new Set<Promise<void>>()
      const pushTask = (task: Promise<void>): void => {
        if (seenTasks.has(task)) return
        seenTasks.add(task)
        tasks.push(task)
      }
      for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        entry.processSlotReserved = false
        if (entry.starting) {
          const startingTask = entry.starting
          pushTask(
            startingTask.then(
              (conn) =>
                this.closeEntryConnection(entry, new Error('Antigravity pool disposed.'), conn),
              (spawnError: unknown) => {
                if (spawnError instanceof DisposedSpawnCloseError) throw spawnError.closeCause
              },
            ),
          )
        } else if (entry.connection) {
          pushTask(this.closeEntryConnection(entry, new Error('Antigravity pool disposed.')))
        } else if (entry.closing) {
          pushTask(entry.closing)
        }
      }
      for (const closing of this.closingTasks) {
        pushTask(closing)
      }
      for (const unconfirmed of this.unconfirmedClosingConnections) {
        unconfirmed.recheckPhysicalRelease()
        if (unconfirmed.isPhysicallyReleased) {
          this.unconfirmedClosingConnections.delete(unconfirmed)
          continue
        }
        const existingClose = unconfirmed.existingClosePromise()
        if (!existingClose) {
          pushTask(unconfirmed.close(new Error('Antigravity pool disposed.')))
        } else if (unconfirmed.isCloseInFlight()) {
          pushTask(existingClose)
        } else if (unconfirmed.hasObservedPhysicalRelease()) {
          pushTask(unconfirmed.whenPhysicallyReleased())
        } else {
          // Prior close timed out/failed and process has still not confirmed physical release:
          // surface the prior failure without spawning a duplicate kill or extending deadlines.
          pushTask(existingClose)
        }
      }

      let firstError: unknown
      let hasError = false
      this.activeShutdownWaiters += 1
      this.updateBoundedUnconfirmedProbe()
      try {
        const settled = await this.awaitSettledWithShutdownDeadline(
          tasks,
          'Antigravity pool disposal did not confirm physical release before its deadline.',
        )
        for (const result of settled) {
          if (result.status === 'rejected' && !hasError) {
            hasError = true
            firstError = result.reason
          }
        }
      } finally {
        this.activeShutdownWaiters -= 1
        for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
          clearTimeout(entry.idleTimer)
          entry.idleTimer = undefined
          entry.processSlotReserved = false
        }
        this.entries.clear()
        this.retiringEntries.clear()
        this.unconfirmedClosedSessions.clear()
        this.pendingLeaseReservations.clear()
        this.physicalOperationListeners.clear()
        this.rejectAllCapacityWaiters(
          new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
        )
        this.recheckUnconfirmedClosings()
      }
      if (hasError) {
        throw firstError instanceof Error ? firstError : new Error(String(firstError))
      }
      if (
        this.unconfirmedClosingConnections.size > 0 ||
        this.closingTasks.size > 0 ||
        this.occupiedProcessSlotCount > 0
      ) {
        throw createUnconfirmedProcessError(
          'Antigravity connection pool still has unconfirmed process slots.',
        )
      }
      this.disposalSettledCleanly = true
    })().finally(() => {
      if (this.activeDisposal === attempt) {
        this.activeDisposal = undefined
      }
    })
    this.activeDisposal = attempt
    return attempt
  }

  private recordUnconfirmedClosedSession(
    entry: PooledConnectionEntry,
    connection: AgyAcpConnection,
    sessionId: string,
  ): void {
    if (this.disposed) return
    if (sessionId && sessionId.length <= 1024) {
      if (
        this.unconfirmedClosedSessions.size >= 64 &&
        !this.unconfirmedClosedSessions.has(sessionId)
      ) {
        const oldest = this.unconfirmedClosedSessions.values().next().value
        if (oldest !== undefined) this.unconfirmedClosedSessions.delete(oldest)
      }
      this.unconfirmedClosedSessions.add(sessionId)
    }
    connection.markUnconfirmedCloseRequests(sessionId)
    if (entry.connection !== connection && entry.ownedConnection !== connection) return
    if (entry.unconfirmedClosedSessions.size < 64) {
      entry.unconfirmedClosedSessions.add(sessionId)
    }
    this.markEntryRetiring(entry)
  }

  private markEntryRetiring(entry: PooledConnectionEntry): void {
    if (this.disposed) return
    if (!entry.retiring) {
      entry.retiring = true
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      if (entry.activeLeases.size > 0 || this.hasPhysicalSlot(entry)) {
        this.retiringEntries.add(entry)
      }
    }
    this.onEntryUpdated(entry)
  }

  private notifyCapacityWaiters(): void {
    if (this.capacityWaiters.size === 0) return
    const waiters = Array.from(this.capacityWaiters)
    for (const waiter of waiters) {
      this.removeCapacityWaiter(waiter)
      waiter.resolve()
    }
  }

  private rejectAllCapacityWaiters(error: Error): void {
    if (this.capacityWaiters.size === 0) return
    const waiters = Array.from(this.capacityWaiters)
    for (const waiter of waiters) {
      this.removeCapacityWaiter(waiter)
      waiter.reject(error)
    }
  }

  private removeCapacityWaiter(waiter: PoolCapacityWaiter): void {
    this.capacityWaiters.delete(waiter)
    clearTimeout(waiter.timeout)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    this.updateBoundedUnconfirmedProbe()
  }

  private waitForCapacitySlot(signal: AbortSignal | undefined, deadlineAt: number): Promise<void> {
    return this.waitForCapacityOrTask(undefined, signal, deadlineAt)
  }

  private waitForCapacityOrTask(
    task: Promise<void> | undefined,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<void> {
    if (this.disposed || this.activeDisposal) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
      )
    }
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0 || this.capacityWaiters.size >= AGY_MAX_CONTEXTS) {
      return Promise.reject(
        new NativeCapacityError(
          'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
        ),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PoolCapacityWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeCapacityWaiter(waiter)
          reject(
            new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            ),
          )
        }, remainingMs),
        signal,
      }
      if (signal) {
        waiter.onAbort = () => {
          this.removeCapacityWaiter(waiter)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new AgentExecutionError(
                  'agent_process_crash',
                  'Antigravity was interrupted.',
                  false,
                ),
          )
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.capacityWaiters.add(waiter)
      this.updateBoundedUnconfirmedProbe()
      if (task) {
        const wake = (): void => {
          if (!this.capacityWaiters.has(waiter)) return
          this.removeCapacityWaiter(waiter)
          waiter.resolve()
        }
        void task.then(wake, wake)
      }
    })
  }

  private async ensureEntryConnection(
    entry: PooledConnectionEntry,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<AgyAcpConnection> {
    if (this.disposed || this.activeDisposal) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      this.retiringEntries.delete(entry)
      this.notifyCapacityWaiters()
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (entry.connection?.isOpen) return entry.connection
    if (entry.starting) return entry.starting
    if (!entry.processSlotReserved || entry.ownedConnection || entry.closing || entry.retiring) {
      throw new AgentExecutionError(
        'agent_process_crash',
        'Antigravity ACP connection generation is no longer active.',
        true,
      )
    }

    const task = this.spawnEntryConnection(entry, signal, deadlineAt).finally(() => {
      if (entry.starting === task) entry.starting = undefined
    })
    entry.starting = task
    return task
  }

  private async spawnEntryConnection(
    entry: PooledConnectionEntry,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<AgyAcpConnection> {
    let owned: OwnedAgyProcess
    try {
      signal?.throwIfAborted()
      if (this.disposed || this.activeDisposal) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new NativeCapacityError(
          'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
        )
      }
      const args = buildAgySpawnArgs(entry.permissionScope, this.options.relativeAppDataDir)
      const env = agyProcessEnvironment()
      owned = this.options.processFactory
        ? await this.spawnInjected(entry.canonicalCwd, args, entry.permissionScope, env)
        : this.spawnOwnedGroup(entry.canonicalCwd, args, env)
    } catch (error) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      this.retiringEntries.delete(entry)
      this.notifyCapacityWaiters()
      throw error
    }

    const ownsProcessGroup = Boolean(owned.isOwnedGroup || owned.physicalWitness)

    if (this.disposed) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      const disposedConnection = new AgyAcpConnection(
        owned.child,
        entry.canonicalCwd,
        entry.permissionScope,
        undefined,
        owned.close,
        this.options.ipcTraffic,
        () => false,
        undefined,
        undefined,
        owned.isReleased,
        owned.whenReleased,
        ownsProcessGroup,
        undefined,
        owned.needsReleaseProbe,
      )
      if (this.shutdownDeadlineAt !== undefined) {
        disposedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
      this.activeClosingConnections.add(disposedConnection)
      try {
        await disposedConnection.close(new Error('Antigravity is shutting down.'))
      } catch (closeError) {
        if (!disposedConnection.isPhysicallyReleased) {
          this.quarantineUnconfirmedConnection(disposedConnection)
        }
        throw new DisposedSpawnCloseError(closeError)
      } finally {
        this.activeClosingConnections.delete(disposedConnection)
      }
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
        ).catch(() => undefined)
      },
      owned.close,
      this.options.ipcTraffic,
      () => !this.disposed,
      (opSignal, physicalCompletion) => {
        for (const listener of this.physicalOperationListeners) {
          listener(opSignal, physicalCompletion)
        }
      },
      () => {
        if (entry.connection === connection) {
          this.onEntryUpdated(entry)
        }
      },
      owned.isReleased,
      owned.whenReleased,
      ownsProcessGroup,
      (reason) => {
        if (entry.connection === connection || entry.ownedConnection === connection) {
          this.markEntryRetiring(entry)
          void this.closeEntryConnection(entry, reason, connection).catch(() => undefined)
        }
      },
      owned.needsReleaseProbe,
    )
    if (this.shutdownDeadlineAt !== undefined) {
      connection.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    entry.connection = connection
    entry.ownedConnection = connection
    entry.processSlotReserved = false
    entry.initializing = undefined
    entry.initializedResult = undefined
    entry.unconfirmedClosedSessions.clear()
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
    return 'child' in supplied ? supplied : { child: supplied, isOwnedGroup: false }
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
      isOwnedGroup: true,
      isReleased:
        process.platform === 'win32'
          ? () => processGroup.released
          : () => processGroup.released || processGroup.settledAfterCloseTimeout(),
      whenReleased: () => processGroup.whenReleased(),
      needsReleaseProbe: process.platform !== 'win32',
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
    })().finally(() => {
      if (entry.initializing === task) {
        entry.initializing = undefined
      }
    })
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
    if (!connection) {
      if (!entry.starting && !entry.closing && !entry.processSlotReserved) {
        this.removeEntry(entry)
        this.notifyCapacityWaiters()
      }
      return
    }
    if (!connection.isOpen) {
      if (!entry.closing) {
        void this.closeEntryConnection(
          entry,
          connection.taintReason ?? new Error('Antigravity ACP connection closed.'),
          connection,
        ).catch(() => undefined)
      }
      return
    }
    if (entry.retiring) {
      if (connection.hasActiveWorkExcludingUnconfirmedCloses()) return
      entry.closeWhenIdle = false
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity ACP retiring connection drained and closed.'),
        connection,
      ).catch(() => undefined)
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
      ).catch(() => undefined)
      return
    }

    if (connection.hasActiveSessionOwners()) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      return
    }

    this.notifyCapacityWaiters()

    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (
        !entry.retiring &&
        entry.activeLeases.size === 0 &&
        entry.connection === connection &&
        !connection.hasPendingPhysicalWork() &&
        !connection.hasActiveSessionOwners()
      ) {
        void this.closeEntryConnection(
          entry,
          new Error('Antigravity ACP connection closed after five minutes idle.'),
          connection,
        ).catch(() => undefined)
      }
    }, this.idleTimeoutMs)
  }

  private evictSettledEntries(): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        !entry.connection &&
        !entry.processSlotReserved
      ) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        this.entries.delete(key)
      }
    }
    for (const entry of this.retiringEntries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        !entry.connection &&
        !entry.processSlotReserved
      ) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        this.retiringEntries.delete(entry)
      }
    }
  }

  private findEvictableEntry(): PooledConnectionEntry | undefined {
    for (const entry of [...this.retiringEntries, ...this.entries.values()]) {
      if (!entry.starting && !entry.closing && entry.connection && !entry.connection.isOpen) {
        return entry
      }
    }
    for (const entry of this.retiringEntries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        entry.connection?.isOpen &&
        !entry.connection.hasActiveWorkExcludingUnconfirmedCloses()
      ) {
        return entry
      }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.initializing &&
        !entry.closing &&
        !entry.drainingFullAccess &&
        entry.fullAccessSessions.size === 0 &&
        entry.connection?.isOpen &&
        !entry.connection.hasPendingPhysicalWork() &&
        !entry.connection.hasActiveSessionOwners()
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
    entry.retiring = true
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    if (!this.disposed) {
      this.retiringEntries.add(entry)
    }
    if (entry.connection === target) {
      entry.connection = undefined
      entry.initializing = undefined
      entry.initializedResult = undefined
      entry.unconfirmedClosedSessions.clear()
    }
    entry.processSlotReserved = false
    this.activeClosingConnections.add(target)
    if (this.shutdownDeadlineAt !== undefined) {
      target.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    const closing: Promise<void> = Promise.resolve().then(async () => {
      try {
        if (this.shutdownDeadlineAt !== undefined) {
          target.capShutdownDeadline(this.shutdownDeadlineAt)
        }
        await target.close(error)
      } catch (closeError: unknown) {
        if (!target.isPhysicallyReleased) {
          this.quarantineUnconfirmedConnection(target)
        }
        throw closeError
      } finally {
        this.activeClosingConnections.delete(target)
        this.closingTasks.delete(closing)
        if (entry.closing === closing) entry.closing = undefined
        if (
          entry.activeLeases.size === 0 &&
          !entry.connection &&
          !entry.starting &&
          !entry.processSlotReserved
        ) {
          this.removeEntry(entry)
        }
        if (this.occupiedProcessSlotCount < AGY_MAX_CONTEXTS * 2 || this.findEvictableEntry()) {
          this.notifyCapacityWaiters()
        }
      }
    })
    entry.closing = closing
    this.closingTasks.add(closing)
    return closing
  }
}
