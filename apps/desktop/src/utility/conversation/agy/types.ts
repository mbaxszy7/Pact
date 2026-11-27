import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash } from 'node:crypto'

import type {
  AgentNativeForkBoundary,
  AgentNativeForkInput,
  AgentNativeForkInspection,
  AgentNativeForkSourceInput,
  AgentNativeForkWitness,
  AgentNativeInputProbeInput,
  AgentNativeRunProbeInput,
  AgentPromptImage,
  AgentSteerInput,
} from '@pact/agent-runtime'
import type {
  AgyRebuildInitializationWitness,
  NativeContextRebuildChunk,
  NativeInitializationWitness,
  NativeProbeResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
  SessionPermissionMode,
} from '@pact/contracts'

import type { LogicalIpcWorkerTraffic } from '../../../shared/logical-ipc-traffic'
import type {
  AgyAcpConnection,
  AgyAcpConnectionPool,
  AgyProcessFactory,
  AgyRequestPhysicalCompletion,
  AgySessionCloseFailureReason,
} from '../agy-acp-connection'
import type { AgyTrajectoryIdentityClientResult } from '../native-fork-files'
import type { AgySkillDiscoveryOptions } from '../native-skill-catalog'

import { AgentExecutionError } from '../agent-execution-error'
import { AGY_TRAJECTORY_ID_PATTERN } from '../agy-native-storage'
import { safeNativePermissionText } from '../native-permission-wait'

export const AGY_PROBE_TIMEOUT_MS = 4_000
export const AGY_PROBE_MAX_BYTES = 16 * 1024
export const AGY_MAX_TOOL_STATES = 64
export const AGY_MAX_TOOL_STATE_BYTES = 8 * 1024 * 1024
export const AGY_MAX_FOREGROUND_DEDUP_ID_CHARS = 512
export const AGY_MAX_FOREGROUND_DEDUP_ID_COUNT = 4_096
export const AGY_MAX_FOREGROUND_DEDUP_BYTES = 512 * 1024
export const AGY_MAX_REASONING_ITEMS = 64
export const AGY_MAX_REASONING_BYTES = 2 * 1024 * 1024
export const AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS = 4_096
export const AGY_SESSION_METADATA_UPDATES = new Set<string>([
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'usage_update',
])
export const AGY_MAX_STEERING_INPUTS = 63
export const AGY_SESSION_MODE_CACHE_LIMIT = 64
export const AGY_EVIDENCE_CACHE_LIMIT = 8
export const AGY_REBUILD_RECEIPT_LIMIT = 8
export const AGY_MCP_REQUEST_BYTES = 64 * 1024
export const AGY_MCP_MAX_CONCURRENT_REQUESTS = 4
export const AGY_MCP_REQUEST_TIMEOUT_MS = 10_000
export const AGY_PHYSICAL_SETTLEMENT_GRACE_MS = 1_500
export const AGY_PROGRESS_TOKEN_PATTERN = new RegExp(
  `^(${AGY_TRAJECTORY_ID_PATTERN.source.slice(1, -1)}):(\\d{1,9})$`,
  'u',
)

export const VALID_ACP_STOP_REASONS = new Set<string>([
  'end_turn',
  'stop_sequence',
  'cancelled',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'error',
])

export const AGY_PLAN_SUBMISSION_INSTRUCTIONS =
  'When a first or changed plan is decision complete and no necessary user choice remains, write the complete official Markdown plan once to your native artifact directory (<appDataDir>/brain/<sessionId>/implementation_plan.md) using write_file or edit_file with ArtifactMetadata, then end this turn immediately without modifying workspace files or implementing the plan. If the frozen official plan needs no change, use the explicit retention operation instead.'

export const AGY_READ_ONLY_STAGE_INSTRUCTIONS = [
  'Antigravity read-only stage rules (override general terminal or build habits):',
  '- Do NOT invoke run_command, terminal or shell commands (including git status, git diff, ls, or test runners), subagents, or exit_plan_mode. Pact denies terminal and workspace-write permissions in read-only stages (only <appDataDir>/brain/<sessionId>/*.md plan artifacts with ArtifactMetadata are permitted during active planning), and a denied permission in Antigravity immediately terminates your turn.',
  '- Inspect workspace files and frozen Pact sources strictly via read_file and read_collaboration_source. Label any runtime or test command you could not execute in this stage as Unverified.',
  '- Always write a non-empty natural-language response in your assistant message (never only in internal thoughts) before ending your turn so Pact has a complete visible report to settle.',
].join('\n')

export interface AgyRebuildSeedChunkRecord {
  chunk: NativeContextRebuildChunk
  resolvedImages?: ReadonlyMap<string, AgentPromptImage>
}

export interface AgyRebuildSeedWriteResult {
  seedHash: string
  chunkCount: number
  stepCount: number
  verifiedPrefixBytes: number
  verifiedPrefixSha256: string
  pbSha256?: string | undefined
  pbBytes?: number | undefined
  initializationWitness?: NativeInitializationWitness | undefined
}

export interface AgySteerConsumptionReceipt {
  consumed: boolean
  stepIdx?: number
  executionId?: string
}

export function buildAgyPactMcpServerName(runId: string): string {
  const digest = createHash('sha256').update(`pact-agy-mcp-server-v1:${runId}`).digest('hex')
  return `pact_peer_${digest.slice(0, 16)}`
}

export interface AgyCompletedPactPublishPlanCall {
  readonly serverName: string
  readonly callId?: string | undefined
  readonly progressToken?: string | undefined
  readonly stepId?: string | undefined
}

/**
 * Clean typed seam between `AgyAgentAdapter` (Modules 3, 4 & 6) and `@agy-storage` (Modules 7 & 8)
 * so cold SQLite/Protobuf inspection, zero-Turn Rebuild seeding, and cut-point Fork plug in cleanly.
 */
export interface AgyNativeStorageClient {
  inspectRun?(
    input: {
      appDataDir: string
      cwd: string
      nativeSessionId: string
      nativeTurnId?: string | undefined
      includePlan?: boolean | undefined
    },
    signal: AbortSignal,
  ): Promise<{
    exists: boolean
    terminalState?:
      | {
          executionId: string
          status: 'completed' | 'failed' | 'canceled' | 'running'
          plan?: { nativeId: string; text: string } | undefined
          planUnavailable?: true | undefined
          hasCompletedPactPublishPlan?: boolean | undefined
          completedPactPublishPlanCalls?: readonly AgyCompletedPactPublishPlanCall[] | undefined
          completedPactPublishPlanTokens?: readonly string[] | undefined
        }
      | undefined
  }>
  readTrajectoryIdentity?(
    input: {
      appDataDir: string
      cwd: string
      nativeSessionId: string
    },
    signal: AbortSignal,
  ): Promise<AgyTrajectoryIdentityClientResult>
  probeSessionStatus?(
    input: AgentNativeRunProbeInput & { appDataDir?: string | undefined },
    signal: AbortSignal,
  ): Promise<NativeProbeResult>
  probeInputReceipts?(
    input: AgentNativeInputProbeInput & { appDataDir?: string | undefined },
    signal: AbortSignal,
  ): Promise<readonly string[]>
  verifySteerConsumption?(
    input: {
      appDataDir: string
      cwd: string
      nativeSessionId: string
      nativeTurnId: string
      executionId?: string | undefined
      inputId: string
      minStepIdx?: number | undefined
    },
    signal: AbortSignal,
  ): Promise<AgySteerConsumptionReceipt>
  writeRebuildSeed?(
    input: {
      appDataDir: string
      cwd: string
      candidateSessionId: string
      sourceHash?: string | undefined
      chunks: AsyncIterable<AgyRebuildSeedChunkRecord>
    },
    signal: AbortSignal,
  ): Promise<AgyRebuildSeedWriteResult>
  confirmRebuildColdLoad?(
    input: {
      cwd: string
      appDataDir: string
      nativeSessionId: string
      sourceHash: string
      pbSha256: string
      pbBytes: number
      stepCount: 2
    },
    signal: AbortSignal,
  ): Promise<AgyRebuildInitializationWitness>
  inspectRebuildSeed?(
    input: {
      appDataDir: string
      cwd: string
      nativeSessionId: string
      sourceHash?: string | undefined
      chunks: AsyncIterable<NativeContextRebuildChunk>
    },
    signal: AbortSignal,
  ): Promise<{
    verified: boolean
    seedHash: string
    stepCount: number
    initializationWitness?: NativeInitializationWitness | undefined
  }>
  prepareFork?(
    input: AgentNativeForkSourceInput & { appDataDir: string },
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary>
  writeFork?(
    input: {
      appDataDir: string
      cwd: string
      candidateSessionId: string
      model: string | null
      effort: string | null
      permissionMode: SessionPermissionMode
      source: AgentNativeForkBoundary
      onCandidate?:
        | ((nativeSessionId: string, witness: AgentNativeForkWitness) => Promise<void>)
        | undefined
    },
    signal: AbortSignal,
  ): Promise<AgentNativeForkWitness>
  inspectFork?(
    input: AgentNativeForkInput & { appDataDir: string },
    signal: AbortSignal,
  ): Promise<
    AgentNativeForkInspection & {
      rawHash?: string | undefined
      rawBytes?: number | undefined
      rawRecords?: number | undefined
    }
  >
}

export interface OwnedAgyProbeProcess {
  child: ChildProcessWithoutNullStreams
  close?: (deadlineAt?: number) => Promise<void>
}

export interface AgyAgentAdapterOptions {
  executablePath?: string
  appDataDir?: string
  relativeAppDataDir?: string
  clientInfo?: { name: string; title?: string; version: string }
  idleTimeoutMs?: number
  connectionPool?: AgyAcpConnectionPool | undefined
  processFactory?: AgyProcessFactory
  probeProcessFactory?: (
    executablePath: string,
    args: readonly string[],
  ) => OwnedAgyProbeProcess | Promise<OwnedAgyProbeProcess>
  skillDiscoveryOptions?: AgySkillDiscoveryOptions
  storageClient?: AgyNativeStorageClient
  subscribeStoragePhysicalOperations?: (
    observer: (signal: AbortSignal, completion: Promise<void>) => void,
  ) => () => void
  ipcTraffic?: LogicalIpcWorkerTraffic
  /** Optional active-pair peer constraint when supplied by Session host. */
  peerTargetAgentId?: Exclude<RuntimeAgentId, 'agy'>
}

export interface SessionModeState {
  initialNonPlanModeId: string
  currentModeId: string
  enteredPlanModeByPact: boolean
}

export interface AcpConfigOptionEntry {
  id: string
  currentValue?: string | undefined
  options?: Array<{ value: string; name?: string | undefined }> | undefined
}

export interface AcpSessionDescriptor {
  sessionId: string
  currentModeId?: string | undefined
  availableModes?: string[] | undefined
  currentModelId?: string | undefined
  availableModels?: string[] | undefined
  configOptions: AcpConfigOptionEntry[]
}

export type NormalizedAcpToolStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export function normalizeAcpToolStatus(raw: unknown): NormalizedAcpToolStatus | undefined {
  if (typeof raw !== 'string') return undefined
  switch (raw) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw
    default:
      return undefined
  }
}

export function isEligibleAgyBackgroundReportId(id: string | undefined): id is string {
  return (
    id !== undefined &&
    id.length > 0 &&
    id.length <= AGY_MAX_FOREGROUND_DEDUP_ID_CHARS &&
    Buffer.byteLength(id, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
  )
}

export function classifyAgyCloseFailureDiagnostic(reason: AgySessionCloseFailureReason): {
  failureSource:
    | 'native_rpc_rejection'
    | 'transport_failure'
    | 'timeout'
    | 'cancelled'
    | 'classified_error'
  code:
    | 'native_rpc_rejected'
    | 'TIMEOUT'
    | 'request_cancelled'
    | 'AGENT_CAPACITY'
    | 'protocol_error'
    | 'transport_failure'
} {
  switch (reason) {
    case 'rpc_error':
      return { failureSource: 'native_rpc_rejection', code: 'native_rpc_rejected' }
    case 'timeout':
      return { failureSource: 'timeout', code: 'TIMEOUT' }
    case 'cancelled':
      return { failureSource: 'cancelled', code: 'request_cancelled' }
    case 'capacity':
      return { failureSource: 'classified_error', code: 'AGENT_CAPACITY' }
    case 'protocol_error':
      return { failureSource: 'transport_failure', code: 'protocol_error' }
    case 'transport_closed':
      return { failureSource: 'transport_failure', code: 'transport_failure' }
    default: {
      const exhaustive: never = reason
      throw new Error(`Unhandled AgySessionCloseFailureReason: ${String(exhaustive)}`)
    }
  }
}

export interface AgyToolState {
  toolCallId: string
  name: string
  explicitToolName?: string | undefined
  title: string
  status: NormalizedAcpToolStatus
  invalidStatus?: boolean | undefined
  progressToken?: string | undefined
  invalidProgressToken?: boolean | undefined
  toolIdentityConflicted?: boolean | undefined
  detail?: string | undefined
  args?: Record<string, unknown> | undefined
  argsBytes?: number | undefined
  rawInput?: Record<string, unknown> | undefined
  rawInputBytes?: number | undefined
  mergedArgs?: Record<string, unknown> | undefined
  mergedArgsBytes?: number | undefined
  argsConflicted?: boolean | undefined
  rawOutput?: unknown
  rawOutputBytes?: number | undefined
  content?: unknown[] | undefined
  contentBytes?: number | undefined
  locations?: unknown[] | undefined
  locationsBytes?: number | undefined
  reservedBytes: number
  startedEmitted: boolean
  completedEmitted: boolean
}

export interface AgySteerEntry {
  request: AgentSteerInput
  dispatched: boolean
  consumed: boolean
  stepIdx?: number | undefined
  executionId?: string | undefined
  candidateStepIdx?: number | undefined
  candidateExecutionId?: string | undefined
  settled: boolean
}

export interface StagedPreBindFrame {
  readonly frame: ValidatedAgyFrame
  readonly bytes: number
  readonly arrivedDuringForeignTurn: boolean
}

export interface ActiveAgyRun {
  readonly runId: string
  readonly sessionId: string
  readonly cwd: string
  nativeSessionId: string
  readonly nativeTurnId: string
  providerExecutionId: string | undefined
  rootStepIdx: number | undefined
  readonly resumedExistingSession: boolean
  readonly knownForeignExecutionIds: Set<string>
  foreignTurnActiveUntilRootBound: boolean
  readonly stagedPreBindNotifications: StagedPreBindFrame[]
  readonly bindingGeneration: number
  readonly nativeGeneration: string
  readonly executorId: string
  readonly connection: AgyAcpConnection
  readonly turnEpoch: number
  turnAccepted: boolean
  promptRpcCompleted: boolean
  promptReplyReceived: boolean
  replayingHistory: boolean
  foregroundReleased: boolean
  controlDrainActive?: boolean | undefined
  rootReleasing: boolean
  rootTerminal: boolean
  cancellationPending: boolean
  steeringInFlight: boolean
  readonly steeredInputs: Map<string, AgySteerEntry>
  readonly pendingSteerOperations: Set<Promise<void>>
  readonly rootExecutionWaiters: Set<() => void>
  readonly activeBackgroundTasks: Set<string>
  readonly backgroundTaskAliases: Map<string, string>
  readonly pendingLaunchToolCallIds: Set<string>
  readonly launchedCompletedToolCallIds: Set<string>
  backgroundUnconfirmed: boolean
  reportUnknown?: ((reason: string) => void) | undefined
  readonly observation: AbortController
  readonly retireSourceReader: (() => void) | undefined
  isSteerLeaseOpen: () => boolean
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | undefined
  method: string
  params?: unknown
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function awaitPhysicalCompletionBounded(
  physicalOutcome: Promise<AgyRequestPhysicalCompletion>,
  timeoutMs = AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
): Promise<AgyRequestPhysicalCompletion | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      physicalOutcome,
      new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const AGY_MAX_TOOL_JSON_DEPTH = 16
export const AGY_MAX_TOOL_JSON_NODES = 65_536
export const AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS = 50
export const AGY_MAX_PENDING_EVENTS = 2_048
export const AGY_MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024
export const AGY_MAX_STAGED_PRE_BIND_FRAMES = 256
export const AGY_MAX_STAGED_PRE_BIND_BYTES = 2 * 1024 * 1024
export const AGY_MAX_FOREIGN_EXECUTION_IDS = 256
export const AGY_MAX_FOREIGN_EXECUTION_ID_BYTES = 64 * 1024
export const AGY_MAX_POST_CUTOFF_BG_PENDING = 128
export const AGY_EVIDENCE_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const AGY_CONTROL_DRAIN_HANDOFF_MS = 120_000
export const AGY_MAX_POST_CUTOFF_BG_BYTES = 2 * 1024 * 1024
export const AGY_MCP_MAX_CONCURRENT_SOCKETS = 32
export const AGY_MCP_HEADERS_TIMEOUT_MS = 5_000
export const AGY_MCP_CLOSE_TIMEOUT_MS = 1_500

export function estimateJsonPayloadBytes(
  value: unknown,
  maxBytes = AGY_MAX_TOOL_STATE_BYTES,
  maxNodes = AGY_MAX_TOOL_JSON_NODES,
): number {
  if (value === undefined) return 0
  let total = 0
  let nodes = 0
  const charge = (delta: number): void => {
    total += delta
    if (total > maxBytes) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity in-flight tool call payloads exceeded the 8 MiB working-memory budget.',
        false,
      )
    }
  }
  const countNode = (delta = 1): void => {
    nodes += delta
    if (nodes > maxNodes) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity tool call payload exceeded maximum JSON node count.',
        false,
      )
    }
  }
  const visit = (node: unknown, depth: number): void => {
    countNode(1)
    if (node === undefined || node === null) {
      charge(8)
      return
    }
    if (typeof node === 'string') {
      charge(Buffer.byteLength(node, 'utf8') + 16)
      return
    }
    if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
      charge(16)
      return
    }
    if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
      charge(node.byteLength + 32)
      return
    }
    if (depth > AGY_MAX_TOOL_JSON_DEPTH) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity tool call payload exceeded maximum JSON nesting depth (16).',
        false,
      )
    }
    if (Array.isArray(node)) {
      charge(32 + node.length * 8)
      if (nodes + node.length > maxNodes) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity tool call payload exceeded maximum JSON node count.',
          false,
        )
      }
      for (let i = 0; i < node.length; i += 1) visit(node[i], depth + 1)
      return
    }
    if (isPlainObject(node)) {
      charge(48)
      for (const [k, v] of Object.entries(node)) {
        charge(Buffer.byteLength(k, 'utf8') + 16)
        visit(v, depth + 1)
      }
      return
    }
    charge(64)
  }
  visit(value, 0)
  return total
}

export function estimateNormalizedEventBytes(event: NormalizedAgentEvent): number {
  let bytes = 160
  const visit = (val: unknown, depth: number): void => {
    if (val === null || val === undefined || depth > 6) return
    if (typeof val === 'string') {
      bytes += Buffer.byteLength(val, 'utf8') * 2 + 16
      return
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      bytes += 16
      return
    }
    if (Array.isArray(val)) {
      bytes += 32
      for (const item of val) {
        visit(item, depth + 1)
      }
      return
    }
    if (typeof val === 'object') {
      bytes += 48
      for (const [k, v] of Object.entries(val)) {
        bytes += Buffer.byteLength(k, 'utf8') + 16
        visit(v, depth + 1)
      }
    }
  }
  visit(event, 0)
  return bytes
}

export function extractUserChunkPactIdentity(update: Record<string, unknown>): {
  text?: string | undefined
  pactRunId?: string | undefined
} {
  const content = isPlainObject(update.content) ? update.content : undefined
  const rawText = (content ? asString(content.text) : undefined) ?? asString(update.text)
  if (!rawText) return {}
  let pactRunId: string | undefined
  const candidates: string[] = []
  const lastJsonLine = rawText.lastIndexOf('\n{"')
  candidates.push(lastJsonLine >= 0 ? rawText.slice(lastJsonLine + 1).trim() : rawText.trim())
  const headerIdx = rawText.lastIndexOf('Pact context (JSON reference data;')
  if (headerIdx >= 0) {
    const lineStart = rawText.indexOf('\n', headerIdx)
    if (lineStart >= 0) {
      const lineEnd = rawText.indexOf('\n', lineStart + 1)
      const ctxLine = (
        lineEnd >= 0 ? rawText.slice(lineStart + 1, lineEnd) : rawText.slice(lineStart + 1)
      ).trim()
      if (ctxLine.startsWith('{')) candidates.push(ctxLine)
    }
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isPlainObject(parsed) && typeof parsed.pactRunId === 'string' && parsed.pactRunId) {
        pactRunId = parsed.pactRunId
        break
      }
    } catch {
      // Ignore non-JSON user prose.
    }
  }
  return { text: rawText, ...(pactRunId ? { pactRunId } : {}) }
}

export function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

export function parseSemverParts(raw: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(raw)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(actual: string, minimum: string): number {
  const left = parseSemverParts(actual)
  const right = parseSemverParts(minimum)
  if (!left || !right) return -1
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1
  }
  return 0
}

export const AGY_MCP_CORRELATION_WAIT_MS = 150
export const AGY_MCP_MAX_ACTIVE_ACP_CALLS = 256
export const AGY_MCP_MAX_CONSUMED_TOKENS = 4_096
export const AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES = 2_048
export const AGY_MCP_MAX_CORRELATION_BYTES = 256 * 1024
export const AGY_MCP_MAX_TOOL_CALL_ID_BYTES = 1_024
export const AGY_MCP_MAX_PROGRESS_TOKEN_BYTES = 300
export const AGY_MCP_MAX_FINGERPRINT_KEYS = 64
export const AGY_MCP_MAX_FINGERPRINT_BYTES = 8 * 1024
export const AGY_MCP_TERMINAL_STUB_BYTES = 128
export const AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES = 96
export const AGY_STRICT_STEP_INDEX_PATTERN = /^(0|[1-9]\d{0,8})$/u

export interface CanonicalProgressToken {
  readonly canonical: string
  readonly structured?: {
    readonly trajectoryId: string
    readonly stepIdx: number
    readonly hasLeadingZeros: boolean
  }
}

export interface StructuredProgressToken {
  readonly canonical: string
  readonly structured: {
    readonly trajectoryId: string
    readonly stepIdx: number
    readonly hasLeadingZeros: false
  }
}

export interface CompactArgsFingerprint {
  readonly fullDigest: string
  readonly keyDigests: ReadonlyMap<string, string>
  readonly approxBytes: number
}

export interface ValidatedAgyTokenEvidence {
  readonly suppliedCount: number
  readonly allCanonicalTokens: readonly string[]
  readonly hasInvalidToken: boolean
  readonly hasConflictingTokens: boolean
  readonly resolvedToken?: CanonicalProgressToken | undefined
}

export interface ValidatedAgyFrame {
  readonly seq: number
  readonly kind: 'notification' | 'server_request'
  readonly method: string
  readonly rpcId?: string | number | undefined
  readonly message: Record<string, unknown>
  readonly params: Record<string, unknown>
  readonly payload: Record<string, unknown> | undefined
  readonly sessionUpdate?: string | undefined
  readonly sessionAttribution: 'matching' | 'absent' | 'pure_foreign' | 'invalid_or_conflicting'
  readonly isAttributableToCurrentSession: boolean
  readonly hasForeignOrInvalidSessionMeta: boolean
  readonly executionId?: string | undefined
  readonly executionIdInvalid: boolean
  readonly trajectoryId?: string | undefined
  readonly stepIdx?: number | undefined
  readonly rootEvidenceContradicted: boolean
  readonly tokens: ValidatedAgyTokenEvidence
  readonly toolCallId?: string | undefined
  readonly toolCallIdInvalid: boolean
  readonly explicitToolName?: string | undefined
  readonly explicitToolNameInvalid: boolean
  readonly status?: NormalizedAcpToolStatus | undefined
  readonly statusPresent: boolean
  readonly statusInvalid: boolean
  readonly argsEvidence:
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'present'
        readonly args: Record<string, unknown>
        readonly fingerprint: CompactArgsFingerprint
      }
    | { readonly kind: 'invalid_or_conflict' }
  readonly rawArgsPresent: boolean
  readonly rawInputPresent: boolean
  readonly frameArgs?: Record<string, unknown> | undefined
  readonly frameRawInput?: Record<string, unknown> | undefined
}

export function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error('Operation was cancelled.'),
    )
  }
  return new Promise<void>((resolveWait, rejectWait) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectWait(
        signal.reason instanceof Error ? signal.reason : new Error('Operation was cancelled.'),
      )
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function classifyIdentityWorkerError(
  error: unknown,
): Extract<AgyTrajectoryIdentityClientResult, { status: 'timeout' | 'worker_error' }> {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const reason = safeNativePermissionText(rawMessage.trim(), 512) || undefined
  const isTimeout =
    (error instanceof Error && error.name === 'TimeoutError') ||
    /\b(?:timeout|timed out|deadline|already active)\b/iu.test(rawMessage)
  return {
    status: isTimeout ? 'timeout' : 'worker_error',
    ...(reason !== undefined ? { reason } : {}),
  }
}

export function identityStatusPriority(
  status: Exclude<AgyTrajectoryIdentityClientResult['status'], 'ok'>,
): number {
  switch (status) {
    case 'invalid':
      return 6
    case 'budget_exceeded':
      return 5
    case 'worker_error':
      return 4
    case 'timeout':
      return 3
    case 'transient_churn':
      return 2
    case 'missing':
      return 1
    case 'no_storage_root':
      return 0
    default:
      return 0
  }
}
