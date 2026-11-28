import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { lstatSync, realpathSync } from 'node:fs'

import { createHash } from 'node:crypto'
import { posix as posixPath, win32 as win32Path } from 'node:path'

import type {
  ConfirmedUnsentBoundary,
  ConfirmedUnsentProof,
  RunEffectiveExecutionSettings,
  SessionPermissionMode,
} from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import type { LogicalIpcWorkerTraffic } from '../../../shared/logical-ipc-traffic'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAcpConnection } from './connection'

import {
  isUnsafeWindowsCmdPath,
  resolveTrustedWindowsCmdExe,
} from '../../runtime-preparation/agy-acp-probe'
import { AgentExecutionError } from '../agent-execution-error'
import { NATIVE_FRAME_WRITE_CHUNK_BYTES } from '../native-frame-writer'
import { safeNativePermissionText } from '../native-permission-wait'
import { NATIVE_OWNER_WORKING_BYTES } from '../native-working-memory'

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
export const AGY_FORCE_EXIT_TIMEOUT_MS = 1_000
export const AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS = 1_000
export const AGY_STDERR_LIMIT_BYTES = 16 * 1024
export const AGY_INLINE_ENCODING_MEMORY_BYTES = 256 * 1024
export const AGY_PARSE_WORKSPACE_MULTIPLIER = 8
export const AGY_FRAME_WORKSPACE_BYTES = 4 * NATIVE_FRAME_WRITE_CHUNK_BYTES

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

export type RequestFailureReason = Exclude<AgySessionCloseFailureReason, 'rpc_error'>
export const requestFailureReasons = new WeakMap<Error, RequestFailureReason>()

export function tagRequestFailure<T extends Error>(error: T, reason: RequestFailureReason): T {
  requestFailureReasons.set(error, reason)
  return error
}

export function createUnconfirmedProcessError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause !== undefined ? { cause } : undefined), {
    code: 'unconfirmed_process' as const,
    retryable: true as const,
  })
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function validateJsonRpcResponse(message: object): string | undefined {
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

export function formatCloseErrorDetail(value: unknown): string | undefined {
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

export interface RegisteredServerRequestOwner {
  readonly ownerId: string
  knownSessionId: string | undefined
  readonly handler: (message: object, seq?: number) => boolean
}

export interface PendingRequest {
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

export interface QueuedIngressItem {
  sessionId?: string | undefined
  ingress: Exclude<AgyIngress, { kind: 'end' }>
  bytes: number
  reservation: NativeMemoryReservation
}

export interface NotificationWaiter {
  resolve: (message: object) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
}

export interface IngressWaiter {
  resolve: (item: AgyIngress) => void
  reject: (error: Error) => void
  resolveOnAbandon?: (() => void) | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
}

export interface SessionNotificationConsumer {
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

export interface OutboundFrame {
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

export function loopbackProxyExclusions(value: string | undefined): string {
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

export function extractNotificationSessionId(message: object): string | undefined {
  const params = Reflect.get(message, 'params')
  if (!params || typeof params !== 'object') return undefined
  const candidate = Reflect.get(params, 'sessionId') ?? Reflect.get(params, 'session_id')
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
    ? candidate
    : undefined
}

export function extractServerRequestSessionId(message: object): string | undefined {
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

export function extractCloseSessionId(method: string, params: object): string | undefined {
  if (method !== 'session/close') return undefined
  const candidate = Reflect.get(params, 'sessionId') ?? Reflect.get(params, 'session_id')
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
    ? candidate
    : undefined
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

export interface PooledConnectionEntry {
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

export class DisposedSpawnCloseError extends Error {
  constructor(readonly closeCause: unknown) {
    super('Antigravity process spawned during disposal failed to confirm close.', {
      cause: closeCause,
    })
  }
}

export interface PoolCapacityWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal | undefined
  onAbort?: (() => void) | undefined
}

const MAX_AGY_GEMINI_DIR_BYTES = 4096
const WINDOWS_ABSOLUTE_GEMINI_DIR_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u

export function hasAsciiControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

export function isSafeAbsoluteAgyGeminiDir(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_AGY_GEMINI_DIR_BYTES ||
    hasAsciiControlChar(value)
  ) {
    return false
  }
  return platform === 'win32'
    ? WINDOWS_ABSOLUTE_GEMINI_DIR_PATTERN.test(value)
    : posixPath.isAbsolute(value)
}

export function assertSafeAgyGeminiDir(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isSafeAbsoluteAgyGeminiDir(value, platform)) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity --gemini-dir override must be a safe absolute path.',
      false,
    )
  }
  return platform === 'win32' ? win32Path.resolve(value) : posixPath.resolve(value)
}

export function resolveConfiguredAgyGeminiDir(
  env: NodeJS.ProcessEnv,
  explicitGeminiDir?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (explicitGeminiDir !== undefined) {
    return assertSafeAgyGeminiDir(explicitGeminiDir.trim(), platform)
  }
  const raw = env['ANTIGRAVITY_GEMINI_DIR']?.trim()
  if (!raw) {
    return undefined
  }
  if (hasAsciiControlChar(raw) || Buffer.byteLength(raw, 'utf8') > MAX_AGY_GEMINI_DIR_BYTES) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity --gemini-dir override must be a safe absolute path.',
      false,
    )
  }
  if (
    !(platform === 'win32'
      ? WINDOWS_ABSOLUTE_GEMINI_DIR_PATTERN.test(raw)
      : posixPath.isAbsolute(raw))
  ) {
    return undefined
  }
  return assertSafeAgyGeminiDir(raw, platform)
}

export function isSafeRelativeAgyAppDataDir(value: string): boolean {
  return Boolean(
    value &&
    value.length <= 128 &&
    !value.includes('..') &&
    !/[/\\&|<>^%!"\r\n\s]/u.test(value) &&
    /^[a-z0-9._-]+$/iu.test(value),
  )
}

export interface AgyAcpConnectionPoolOptions {
  executablePath: string
  clientInfo?: { name: string; title?: string; version: string } | undefined
  relativeAppDataDir?: string | undefined
  geminiDir?: string | undefined
  idleTimeoutMs?: number | undefined
  processFactory?: AgyProcessFactory | undefined
  ipcTraffic?: LogicalIpcWorkerTraffic | undefined
  observePhysicalOperation?: (
    signal: AbortSignal | undefined,
    physicalCompletion: Promise<unknown>,
  ) => void
}

export function buildAgySpawnArgs(
  permissionScope: AgyPermissionScope,
  relativeAppDataDir: string | undefined,
  geminiDir?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args = ['acp', '--process-per-session', '--disable-telemetry']
  if (geminiDir !== undefined) {
    args.push('--gemini-dir', assertSafeAgyGeminiDir(geminiDir, platform))
  }
  if (relativeAppDataDir !== undefined) {
    if (!isSafeRelativeAgyAppDataDir(relativeAppDataDir)) {
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

export function formatAndValidateAgyOwnedSpawnArgs(
  executablePath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options?: { readonly lstat?: typeof lstatSync; readonly realpath?: typeof realpathSync },
): { target: string; spawnArgs: string[]; isWindowsCommand: boolean } {
  const isWindowsCommand = platform === 'win32' && /\.cmd$/iu.test(executablePath)
  if (isWindowsCommand && isUnsafeWindowsCmdPath(executablePath)) {
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Unsafe Antigravity executable path.',
      false,
    )
  }
  if (args[0] !== 'acp') {
    throw new AgentExecutionError('protocol_error', 'Unsafe Antigravity launch arguments.', false)
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (
      arg === '--process-per-session' ||
      arg === '--disable-telemetry' ||
      arg === '--dangerously-skip-permissions'
    ) {
      continue
    }
    if (arg === '--app-data-dir') {
      const next = args[index + 1]
      if (!next || !isSafeRelativeAgyAppDataDir(next)) {
        throw new AgentExecutionError(
          'protocol_error',
          'Unsafe Antigravity launch arguments.',
          false,
        )
      }
      index += 1
      continue
    }
    if (arg === '--gemini-dir') {
      const next = args[index + 1]
      if (next === undefined || !isSafeAbsoluteAgyGeminiDir(next, platform)) {
        throw new AgentExecutionError(
          'protocol_error',
          'Unsafe Antigravity launch arguments.',
          false,
        )
      }
      if (isWindowsCommand && isUnsafeWindowsCmdPath(next)) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Unsafe Antigravity storage path.',
          false,
        )
      }
      index += 1
      continue
    }
    throw new AgentExecutionError('protocol_error', 'Unsafe Antigravity launch arguments.', false)
  }
  if (isWindowsCommand) {
    const target = resolveTrustedWindowsCmdExe(env, { platform, ...options })
    if (!target) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Trusted Windows command interpreter could not be confirmed.',
        false,
      )
    }
    const renderedArgs = args
      .map((arg, index) => (index > 0 && args[index - 1] === '--gemini-dir' ? `"${arg}"` : arg))
      .join(' ')
    return {
      target,
      spawnArgs: ['/d', '/s', '/c', `""${executablePath}" ${renderedArgs}"`],
      isWindowsCommand: true,
    }
  }
  return {
    target: executablePath,
    spawnArgs: [...args],
    isWindowsCommand: false,
  }
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
