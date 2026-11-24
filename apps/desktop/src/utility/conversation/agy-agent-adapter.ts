import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Socket as NetSocket } from 'node:net'

import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  agentPromptImageGroups,
  resolveAgentCollaborationSourceCapability,
  type AgentAdapter,
  type AgentCollaborationSourceCapability,
  type AgentCollaborationSourceReader,
  type AgentNativeCheckContext,
  type AgentNativeCheckOperation,
  type AgentNativeContextRebuildInput,
  type AgentNativeContextRebuildResult,
  type AgentNativeForkBoundary,
  type AgentNativeForkInput,
  type AgentNativeForkInspection,
  type AgentNativeForkResult,
  type AgentNativeForkSourceInput,
  type AgentNativeForkWitness,
  type AgentNativeInitializedBindingProbeInput,
  type AgentNativeInputProbeInput,
  type AgentNativeProbeInput,
  type AgentNativeRunProbeInput,
  type AgentOpenPlanFinalIntent,
  type AgentProbeResult,
  type AgentPromptImage,
  type AgentRunInput,
  type AgentShutdownSettlement,
  type AgentSourceReadForm,
  type AgentSteerInput,
  type AgentSteerResult,
} from '@pact/agent-runtime'
import {
  COLLABORATION_PAGE_BYTES,
  COLLABORATION_PLAN_CHUNK_BYTES,
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  buildBoundedNativePlanId,
  codexCollaborationSourceWireReadSchema,
  collaborationActor,
  collaborationAskMode,
  collaborationInputOutcomeAllowed,
  collaborationInputResultSchema,
  collaborationOpenPlanPublishAllowed,
  collaborationPlanMode,
  collaborationPlanRetentionAllowed,
  collaborationPlanRetentionInputSchema,
  collaborationPublishPlanInputSchema,
  collaborationReviewInputSchema,
  collaborationSourceAnyReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceWireReadSchema,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
  NATIVE_PERMISSION_REQUESTS,
  nativeBackgroundReportIdentitySchema,
  nativeInputDetailsSchema,
  nativeInputValueSchema,
  nativePermissionRequestSchema,
  peerRequestToolInputSchema,
  RUNTIME_MINIMUM_VERSIONS,
  sessionTitleInputSchema,
  type AgyRebuildInitializationWitness,
  type CollaborationInputObservation,
  type CollaborationReviewObservation,
  type CollaborationSourceReadResult,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type NativeContextRebuildChunk,
  type NativeEvidenceIdentity,
  type NativeInitializationWitness,
  type NativeInputField,
  type NativePermissionRequest,
  type NativeProbeResult,
  type NativeUserInputRequest,
  type NormalizedAgentEvent,
  type RunEffectiveExecutionSettings,
  type RuntimeAgentId,
  type SessionPermissionMode,
  type SkillBinding,
} from '@pact/contracts'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import type { AgyTrajectoryIdentityClientResult } from './native-fork-files'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../owned-process-group'
import { AgentActivityDetail } from './agent-activity-detail'
import { AgentAnswerAssembler } from './agent-answer-assembler'
import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  NativeInputWithheldError,
  PermissionModeRejectedError,
} from './agent-execution-error'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_MAX_CONTEXTS,
  AGY_PROMPT_ACCEPT_TIMEOUT_MS,
  AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
  AgyAcpConnection,
  AgyAcpConnectionPool,
  createAgyRootFrameNotWrittenProof,
  type AgyIngress,
  type AgyOrderedSessionStream,
  type AgyPoolLease,
  type AgyProcessFactory,
  type AgyRequestPhysicalCompletion,
  type AgyServerRequestOwnerHandle,
  type AgySessionCloseFailureReason,
} from './agy-acp-connection'
import {
  AGY_TRAJECTORY_ID_PATTERN,
  isValidAgyTrajectoryId,
  resolveAgyAppDataDir,
} from './agy-native-storage'
import { mergeWorkflowInput, mergeWorkflowReview } from './collaboration-answer'
import {
  buildCollaborationSourceToolDescription,
  buildSourceInstructions,
  collaborationInputResultAllowed,
  collaborationInputResultDescription,
  collaborationInputResultReceiptText,
  collaborationInstructions,
  collaborationPlanRetentionReceiptText,
  collaborationReadOnly,
  collaborationReviewMode,
} from './collaboration-prompt'
import {
  cutoffSourceNavigator,
  NativeSourceReadFailure,
  readFrozenSourceTool,
  readNativeFrozenSourceTool,
} from './frozen-source-reader'
import { NativeCheckOperation } from './native-check-operation'
import {
  AgyRoundEffectsTracker,
  isAgyBrainArtifactPath,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from './native-file-changes'
import { NativeForkFiles } from './native-fork-files'
import {
  agyPromptInput,
  nativeImagePreparationBytes,
  requireNativeImageReference,
} from './native-image-content'
import {
  nativeApprovalDisplayFits,
  NativePermissionWait,
  safeNativePermissionText,
} from './native-permission-wait'
import {
  AgySkillProbeOwner,
  bindAgySkillSelections,
  discoverAgySkills,
  type AgySkillDiscoveryOptions,
} from './native-skill-catalog'
import { NativeWorkingMemory, type NativeMemoryReservation } from './native-working-memory'
import {
  PEER_ASSISTANCE_INSTRUCTIONS,
  PEER_ASSISTANCE_RECORDED_RESULT,
  PEER_ASSISTANCE_TOOL_DESCRIPTION,
} from './peer-assistance-policy'

const AGY_PROBE_TIMEOUT_MS = 4_000
const AGY_PROBE_MAX_BYTES = 16 * 1024
const AGY_MAX_TOOL_STATES = 64
const AGY_MAX_TOOL_STATE_BYTES = 8 * 1024 * 1024
const AGY_MAX_FOREGROUND_DEDUP_ID_CHARS = 512
const AGY_MAX_FOREGROUND_DEDUP_ID_COUNT = 4_096
const AGY_MAX_FOREGROUND_DEDUP_BYTES = 512 * 1024
const AGY_MAX_REASONING_ITEMS = 64
const AGY_MAX_REASONING_BYTES = 2 * 1024 * 1024
const AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS = 4_096
const AGY_SESSION_METADATA_UPDATES = new Set<string>([
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'usage_update',
])
const AGY_MAX_STEERING_INPUTS = 63
const AGY_SESSION_MODE_CACHE_LIMIT = 64
const AGY_EVIDENCE_CACHE_LIMIT = 8
const AGY_REBUILD_RECEIPT_LIMIT = 8
const AGY_MCP_REQUEST_BYTES = 64 * 1024
const AGY_MCP_MAX_CONCURRENT_REQUESTS = 4
const AGY_MCP_REQUEST_TIMEOUT_MS = 10_000
const AGY_PHYSICAL_SETTLEMENT_GRACE_MS = 1_500
const AGY_PROGRESS_TOKEN_PATTERN = new RegExp(
  `^(${AGY_TRAJECTORY_ID_PATTERN.source.slice(1, -1)}):(\\d{1,9})$`,
  'u',
)

const VALID_ACP_STOP_REASONS = new Set<string>([
  'end_turn',
  'stop_sequence',
  'cancelled',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'error',
])

const AGY_PLAN_SUBMISSION_INSTRUCTIONS =
  'When a first or changed plan is decision complete and no necessary user choice remains, write the complete official Markdown plan once to your native artifact directory (<appDataDir>/brain/<sessionId>/implementation_plan.md) using write_file or edit_file with ArtifactMetadata, then end this turn immediately without modifying workspace files or implementing the plan. If the frozen official plan needs no change, use the explicit retention operation instead.'

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

interface SessionModeState {
  initialNonPlanModeId: string
  currentModeId: string
  enteredPlanModeByPact: boolean
}

interface AcpConfigOptionEntry {
  id: string
  currentValue?: string | undefined
  options?: Array<{ value: string; name?: string | undefined }> | undefined
}

interface AcpSessionDescriptor {
  sessionId: string
  currentModeId?: string | undefined
  availableModes?: string[] | undefined
  currentModelId?: string | undefined
  availableModels?: string[] | undefined
  configOptions: AcpConfigOptionEntry[]
}

type NormalizedAcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

function normalizeAcpToolStatus(raw: unknown): NormalizedAcpToolStatus | undefined {
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

function isEligibleAgyBackgroundReportId(id: string | undefined): id is string {
  return (
    id !== undefined &&
    id.length > 0 &&
    id.length <= AGY_MAX_FOREGROUND_DEDUP_ID_CHARS &&
    Buffer.byteLength(id, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
  )
}

function classifyAgyCloseFailureDiagnostic(reason: AgySessionCloseFailureReason): {
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

interface AgyToolState {
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

interface AgySteerEntry {
  request: AgentSteerInput
  dispatched: boolean
  consumed: boolean
  stepIdx?: number | undefined
  executionId?: string | undefined
  candidateStepIdx?: number | undefined
  candidateExecutionId?: string | undefined
  settled: boolean
}

interface StagedPreBindFrame {
  readonly frame: ValidatedAgyFrame
  readonly bytes: number
  readonly arrivedDuringForeignTurn: boolean
}

interface ActiveAgyRun {
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
  promptReplyReceived: boolean
  foregroundReleased: boolean
  rootReleasing: boolean
  rootTerminal: boolean
  cancellationPending: boolean
  steeringInFlight: boolean
  readonly steeredInputs: Map<string, AgySteerEntry>
  readonly pendingSteerOperations: Set<Promise<void>>
  readonly rootExecutionWaiters: Set<() => void>
  readonly activeBackgroundTasks: Set<string>
  readonly backgroundTaskAliases: Map<string, string>
  backgroundUnconfirmed: boolean
  readonly observation: AbortController
  readonly retireSourceReader: (() => void) | undefined
  isSteerLeaseOpen: () => boolean
}

interface McpJsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | undefined
  method: string
  params?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function awaitPhysicalCompletionBounded(
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

const AGY_MAX_TOOL_JSON_DEPTH = 16
const AGY_MAX_TOOL_JSON_NODES = 65_536
const AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS = 50
const AGY_MAX_PENDING_EVENTS = 2_048
const AGY_MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024
const AGY_MAX_STAGED_PRE_BIND_FRAMES = 256
const AGY_MAX_STAGED_PRE_BIND_BYTES = 2 * 1024 * 1024
const AGY_MAX_FOREIGN_EXECUTION_IDS = 256
const AGY_MAX_FOREIGN_EXECUTION_ID_BYTES = 64 * 1024
const AGY_MAX_POST_CUTOFF_BG_PENDING = 128
const AGY_MAX_POST_CUTOFF_BG_BYTES = 2 * 1024 * 1024
const AGY_MCP_MAX_CONCURRENT_SOCKETS = 32
const AGY_MCP_HEADERS_TIMEOUT_MS = 5_000
const AGY_MCP_CLOSE_TIMEOUT_MS = 1_500

function estimateJsonPayloadBytes(
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

function estimateNormalizedEventBytes(event: NormalizedAgentEvent): number {
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

function extractUserChunkPactIdentity(update: Record<string, unknown>): {
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

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

function parseSemverParts(raw: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(raw)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(actual: string, minimum: string): number {
  const left = parseSemverParts(actual)
  const right = parseSemverParts(minimum)
  if (!left || !right) return -1
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1
  }
  return 0
}

function parseAcpSessionDescriptor(
  result: object,
  fallbackSessionId?: string,
): AcpSessionDescriptor {
  const sessionId = asString(Reflect.get(result, 'sessionId')) ?? fallbackSessionId
  if (!sessionId || sessionId.length > 1024) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity ACP server did not return a valid sessionId.',
      false,
    )
  }
  const modesRaw = Reflect.get(result, 'modes')
  const currentModeId = isPlainObject(modesRaw) ? asString(modesRaw.currentModeId) : undefined
  const availableModes =
    isPlainObject(modesRaw) && Array.isArray(modesRaw.availableModes)
      ? modesRaw.availableModes
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.id ?? entry.modeId)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const modelsRaw = Reflect.get(result, 'models')
  const currentModelId = isPlainObject(modelsRaw) ? asString(modelsRaw.currentModelId) : undefined
  const availableModels =
    isPlainObject(modelsRaw) && Array.isArray(modelsRaw.availableModels)
      ? modelsRaw.availableModels
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.modelId ?? entry.id)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const configOptions = parseConfigOptions(Reflect.get(result, 'configOptions'))
  return {
    sessionId,
    currentModeId,
    availableModes,
    currentModelId,
    availableModels,
    configOptions,
  }
}

function parseConfigOptions(raw: unknown): AcpConfigOptionEntry[] {
  if (!Array.isArray(raw) || raw.length > 32) return []
  const entries: AcpConfigOptionEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = asString(item.id ?? item.configId)
    if (!id) continue
    const currentValue = asString(item.currentValue ?? item.value)
    const rawOptions = Array.isArray(item.options) ? item.options : undefined
    const options =
      rawOptions && rawOptions.length <= 128
        ? rawOptions
            .map((opt) => {
              if (!isPlainObject(opt)) return undefined
              const val = asString(opt.value ?? opt.id)
              if (!val) return undefined
              const mapped: { value: string; name?: string | undefined } = { value: val }
              const optName = asString(opt.name)
              if (optName) mapped.name = optName
              return mapped
            })
            .filter((opt): opt is { value: string; name?: string | undefined } => opt !== undefined)
        : undefined
    entries.push({ id, currentValue, options })
  }
  return entries
}

function collectAmbiguousPermissionOptionIds(options: readonly unknown[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId) continue
    if (seen.has(optionId)) {
      duplicates.add(optionId)
    } else {
      seen.add(optionId)
    }
  }
  return duplicates
}

function findRejectOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      if (rawKind === 'reject_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'deny' || optionId === 'reject_once') {
      return optionId
    }
  }
  return undefined
}

function findAllowOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      // NEVER auto-select or expose `allow_always` as session-scoped because Antigravity persists it globally.
      if (rawKind === 'allow_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'allow_always') continue
    if (optionId === 'allow' || optionId === 'allow_once') {
      return optionId
    }
  }
  return undefined
}

function buildAgyPermissionCard(
  params: Record<string, unknown>,
  cwd: string,
): {
  request: Omit<NativePermissionRequest, 'id' | 'createdAt'>
  responses: Map<string, object>
} {
  const toolCall = isPlainObject(params.toolCall) ? params.toolCall : {}
  const toolName = asString(toolCall.name) ?? asString(toolCall.title) ?? 'tool'
  const rawTitle = asString(toolCall.title) ?? `Antigravity wants to run ${toolName}`
  const title = safeNativePermissionText(rawTitle, 240) || 'Antigravity permission request'

  const args = isPlainObject(toolCall.args)
    ? toolCall.args
    : isPlainObject(toolCall.rawInput)
      ? toolCall.rawInput
      : undefined
  const detailLines: string[] = [`Tool: ${toolName}`]
  if (args) {
    const command = asString(args.CommandLine ?? args.command)
    const targetPath = asString(args.Path ?? args.path ?? args.file_path ?? args.filePath)
    if (command) detailLines.push(`Command: ${command}`)
    if (targetPath) {
      const displayPath = isAbsolute(targetPath)
        ? relative(cwd, targetPath) || basename(targetPath)
        : targetPath
      detailLines.push(`Path: ${displayPath}`)
    }
  }
  const rawDetail = detailLines.join('\n')
  const detailComplete = nativeApprovalDisplayFits(rawDetail, 2048)
  const detail = safeNativePermissionText(rawDetail, 2048)

  const allowOnceOptionId = detailComplete ? findAllowOnceOptionId(params.options) : undefined
  const rejectOnceOptionId = findRejectOnceOptionId(params.options)

  const actions: NonNullable<NativePermissionRequest['actions']> = []
  const responses = new Map<string, object>()

  if (allowOnceOptionId) {
    actions.push({
      id: 'agy-allow-once',
      label: 'Allow once',
      kind: 'allow',
    })
    responses.set('agy-allow-once', {
      outcome: { outcome: 'selected', optionId: allowOnceOptionId },
    })
  }
  if (rejectOnceOptionId) {
    actions.push({
      id: 'agy-reject-once',
      label: 'Decline and continue',
      kind: 'decline',
    })
    responses.set('agy-reject-once', {
      outcome: { outcome: 'selected', optionId: rejectOnceOptionId },
    })
  }
  actions.push({
    id: 'agy-cancel',
    label: 'Cancel this turn',
    kind: 'cancel',
  })
  responses.set('agy-cancel', { outcome: { outcome: 'cancelled' } })

  // Validate against public contract budget; never expose `allow_always` (`kind: 'rule'`).
  nativePermissionRequestSchema.parse({
    id: randomUUID(),
    kind: 'approval',
    title,
    detail,
    actions,
    defaultToNo: true,
    createdAt: new Date().toISOString(),
  })

  return {
    request: {
      kind: 'approval',
      title,
      detail,
      actions,
      defaultToNo: true,
    },
    responses,
  }
}

function choicesFromAgySchema(
  schema: Record<string, unknown>,
): NonNullable<NativeInputField['options']> | undefined {
  const source = schema.enum ?? schema.oneOf ?? schema.anyOf
  if (source === undefined) return undefined
  if (!Array.isArray(source) || source.length === 0 || source.length > 64) {
    throw new Error('The native Antigravity enum schema is unsupported.')
  }
  const choices = source.map((entry, index) => {
    const value = isPlainObject(entry) ? entry.const : entry
    if (typeof value !== 'string') {
      throw new Error('Only string selectable values can be represented faithfully.')
    }
    const label =
      isPlainObject(entry) && typeof entry.title === 'string'
        ? entry.title
        : Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === 'string'
          ? schema.enumNames[index]
          : value
    const choice: NonNullable<NativeInputField['options']>[number] = { value, label }
    if (isPlainObject(entry) && typeof entry.description === 'string') {
      choice.description = entry.description
    }
    return choice
  })
  if (new Set(choices.map((c) => c.value)).size !== choices.length) {
    throw new Error('Duplicate native selectable values are unsupported.')
  }
  return choices
}

function parseAgyFormField(id: string, raw: unknown, required: boolean): NativeInputField {
  if (
    !isPlainObject(raw) ||
    '$ref' in raw ||
    '$defs' in raw ||
    'allOf' in raw ||
    'not' in raw ||
    'if' in raw ||
    'then' in raw ||
    'else' in raw
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const title = typeof raw.title === 'string' && raw.title ? raw.title : id
  if (
    raw.writeOnly === true ||
    raw.format === 'password' ||
    /(?:^|[ _-])(?:password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|cookie)(?:$|[ _-])/iu.test(
      `${id} ${title}`,
    )
  ) {
    throw new Error(
      'Authentication credentials must be entered in the native browser flow, not a Pact form.',
    )
  }
  let type: NativeInputField['type']
  let choices: NativeInputField['options']
  if (raw.type === 'array') {
    if (
      !isPlainObject(raw.items) ||
      (raw.items.type !== undefined && raw.items.type !== 'string') ||
      '$ref' in raw.items
    ) {
      throw new Error('Only string selection arrays are supported by the native form UI.')
    }
    choices = choicesFromAgySchema(raw.items)
    if (!choices) throw new Error('A native array field must supply selectable options.')
    type = 'multi-select'
  } else {
    choices = choicesFromAgySchema(raw)
    type = choices
      ? 'select'
      : raw.type === 'string'
        ? 'text'
        : raw.type === 'number'
          ? 'number'
          : raw.type === 'integer'
            ? 'integer'
            : raw.type === 'boolean'
              ? 'boolean'
              : (() => {
                  throw new Error('This native Antigravity form field type is unsupported.')
                })()
  }
  const constraints = [
    typeof raw.minimum === 'number' ? `Minimum: ${raw.minimum}` : undefined,
    typeof raw.maximum === 'number' ? `Maximum: ${raw.maximum}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const description = [
    typeof raw.description === 'string' ? raw.description : undefined,
    constraints || undefined,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    id,
    label: title,
    ...(description ? { description } : {}),
    type,
    required,
    ...(raw.allowOther === true ? { allowOther: true } : {}),
    ...(choices ? { options: choices } : {}),
    ...('default' in raw ? { default: nativeInputValueSchema.parse(raw.default) } : {}),
  }
}

export function agyElicitationRequest(params: Record<string, unknown>): NativeUserInputRequest {
  const mode = params.mode ?? 'form'
  const server = typeof params.serverName === 'string' && params.serverName ? params.serverName : ''
  const defaultTitle = server ? `Antigravity · ${server}` : 'Antigravity needs your input'
  const title = safeNativePermissionText(
    typeof params.title === 'string' && params.title ? params.title : defaultTitle,
    240,
  )
  const message = typeof params.message === 'string' ? params.message : ''

  if (mode === 'url') {
    const url = asString(params.url)
    if (!url) throw new Error('Native authorization URL is unavailable.')
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('The native authorization URL is unsupported.')
    }
    const publicDetails = nativeInputDetailsSchema.parse({
      kind: 'url',
      title,
      message: safeNativePermissionText(message, 8192),
      fields: [],
      url,
    })
    return publicDetails
  }

  if (typeof mode !== 'string' || mode !== 'form') {
    throw new Error('This native Antigravity elicitation mode is unsupported.')
  }
  const schema = params.requestedSchema
  if (
    !isPlainObject(schema) ||
    schema.type !== 'object' ||
    !isPlainObject(schema.properties) ||
    '$ref' in schema ||
    '$defs' in schema ||
    'allOf' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const required = schema.required ?? []
  const properties = schema.properties
  if (
    !Array.isArray(required) ||
    !required.every((key) => typeof key === 'string') ||
    Object.keys(properties).length === 0 ||
    Object.keys(properties).length > 32
  ) {
    throw new Error('The native Antigravity form field list is unsupported.')
  }
  if (required.some((key) => !Object.hasOwn(properties, key))) {
    throw new Error('The native Antigravity form requires an undeclared field.')
  }
  const fields = Object.entries(properties).map(([id, field]) =>
    parseAgyFormField(id, field, required.includes(id)),
  )
  const publicDetails = nativeInputDetailsSchema.parse({
    kind: 'form',
    title,
    message: safeNativePermissionText(message, 8192),
    fields,
  })
  return {
    ...publicDetails,
    requestedSchema: schema,
  }
}

function hasValidArtifactMetadata(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false
  const meta = args.ArtifactMetadata ?? args.artifactMetadata
  if (!isPlainObject(meta)) return false
  return Object.keys(meta).length > 0
}

function isMarkdownBrainPlanArtifact(
  rawPath: string,
  cwd: string,
  appDataDirs: readonly string[],
  nativeSessionId: string,
): boolean {
  if (!rawPath.toLowerCase().endsWith('.md')) return false
  return appDataDirs.some((dir) => isAgyBrainArtifactPath(rawPath, cwd, dir, nativeSessionId))
}

const AGY_MCP_CORRELATION_WAIT_MS = 150
const AGY_MCP_MAX_ACTIVE_ACP_CALLS = 256
const AGY_MCP_MAX_CONSUMED_TOKENS = 4_096
const AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES = 2_048
const AGY_MCP_MAX_CORRELATION_BYTES = 256 * 1024
const AGY_MCP_MAX_TOOL_CALL_ID_BYTES = 1_024
const AGY_MCP_MAX_PROGRESS_TOKEN_BYTES = 300
const AGY_MCP_MAX_FINGERPRINT_KEYS = 64
const AGY_MCP_MAX_FINGERPRINT_BYTES = 8 * 1024
const AGY_MCP_TERMINAL_STUB_BYTES = 128
const AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES = 96
const AGY_STRICT_STEP_INDEX_PATTERN = /^(0|[1-9]\d{0,8})$/u

interface CanonicalProgressToken {
  readonly canonical: string
  readonly structured?: {
    readonly trajectoryId: string
    readonly stepIdx: number
    readonly hasLeadingZeros: boolean
  }
}

interface StructuredProgressToken {
  readonly canonical: string
  readonly structured: {
    readonly trajectoryId: string
    readonly stepIdx: number
    readonly hasLeadingZeros: false
  }
}

function hashCallIdDigest(toolCallId: string): string {
  return createHash('sha256').update(toolCallId, 'utf8').digest('hex')
}

function canonicalizeProgressToken(raw: unknown): CanonicalProgressToken | undefined {
  const rawStr =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isSafeInteger(raw)
        ? String(raw)
        : undefined
  if (
    !rawStr ||
    rawStr.length === 0 ||
    Buffer.byteLength(rawStr, 'utf8') > AGY_MCP_MAX_PROGRESS_TOKEN_BYTES
  ) {
    return undefined
  }
  const match = AGY_PROGRESS_TOKEN_PATTERN.exec(rawStr)
  if (!match) {
    return { canonical: rawStr }
  }
  const trajectoryId = match[1]!
  const digits = match[2]!
  const stepIdx = Number(digits)
  if (!isValidAgyTrajectoryId(trajectoryId) || !Number.isSafeInteger(stepIdx) || stepIdx < 0) {
    return undefined
  }
  const hasLeadingZeros = !AGY_STRICT_STEP_INDEX_PATTERN.test(digits)
  return {
    canonical: `${trajectoryId}:${stepIdx}`,
    structured: {
      trajectoryId,
      stepIdx,
      hasLeadingZeros,
    },
  }
}

function parseRootProgressToken(raw: unknown): StructuredProgressToken | undefined {
  const parsed = canonicalizeProgressToken(raw)
  if (
    !parsed ||
    !parsed.structured ||
    parsed.structured.hasLeadingZeros ||
    !isValidAgyTrajectoryId(parsed.structured.trajectoryId)
  ) {
    return undefined
  }
  return {
    canonical: parsed.canonical,
    structured: {
      trajectoryId: parsed.structured.trajectoryId,
      stepIdx: parsed.structured.stepIdx,
      hasLeadingZeros: false,
    },
  }
}

const PACT_SEMANTIC_ARG_KEYS = new Set([
  'verdict',
  'questions',
  'outcome',
  'title',
  'target',
  'kind',
  'reason',
  'text',
  'offset',
  'complete',
  'source',
  'part',
  'document',
  'batchId',
  'cutoffId',
  'messageId',
  'commentId',
  'sourceReference',
  'ordinal',
  'context',
  'runId',
  'grant',
])

const AGY_CANONICAL_HASH_MAX_DEPTH = 12
const AGY_CANONICAL_HASH_MAX_NODES = 16_384

function updateCanonicalJsonHash(
  hasher: ReturnType<typeof createHash>,
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: AGY_CANONICAL_HASH_MAX_NODES },
): boolean {
  if (depth > AGY_CANONICAL_HASH_MAX_DEPTH || budget.remaining <= 0) {
    return false
  }
  budget.remaining -= 1
  if (value === null || typeof value !== 'object') {
    hasher.update(JSON.stringify(value) ?? 'null')
    return true
  }
  if (Array.isArray(value)) {
    hasher.update('[')
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) hasher.update(',')
      if (!updateCanonicalJsonHash(hasher, value[i], depth + 1, budget)) {
        return false
      }
    }
    hasher.update(']')
    return true
  }
  const entries: Array<[string, unknown]> = []
  let seenKeys = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    seenKeys += 1
    if (seenKeys > budget.remaining) {
      budget.remaining = -1
      return false
    }
    const entryVal: unknown = Reflect.get(value, key)
    if (entryVal !== undefined) {
      entries.push([key, entryVal])
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  hasher.update('{')
  for (let i = 0; i < entries.length; i += 1) {
    const [key, entryVal] = entries[i]!
    if (i > 0) hasher.update(',')
    hasher.update(JSON.stringify(key))
    hasher.update(':')
    if (!updateCanonicalJsonHash(hasher, entryVal, depth + 1, budget)) {
      return false
    }
  }
  hasher.update('}')
  return true
}

function computeFullDigestFromKeyDigests(keyDigests: ReadonlyMap<string, string>): string {
  const sorted = [...keyDigests.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const hasher = createHash('sha256')
  hasher.update('{')
  for (let i = 0; i < sorted.length; i += 1) {
    const [key, digest] = sorted[i]!
    if (i > 0) hasher.update(',')
    hasher.update(JSON.stringify(key))
    hasher.update(':')
    hasher.update(digest)
  }
  hasher.update('}')
  return hasher.digest('hex')
}

interface CompactArgsFingerprint {
  readonly fullDigest: string
  readonly keyDigests: ReadonlyMap<string, string>
  readonly approxBytes: number
}

function buildCompactArgsFingerprint(
  rawRecord: Record<string, unknown>,
  stripToolSummary: boolean,
): CompactArgsFingerprint | undefined {
  const filtered: Array<[string, unknown]> = []
  let inspectedKeys = 0
  for (const key in rawRecord) {
    if (!Object.hasOwn(rawRecord, key)) continue
    inspectedKeys += 1
    if (inspectedKeys > AGY_CANONICAL_HASH_MAX_NODES) return undefined
    const val = rawRecord[key]
    if (val === undefined) continue
    if (stripToolSummary && key === 'toolSummary') continue
    if (key.length > 128) return undefined
    filtered.push([key, val])
    if (filtered.length > AGY_MCP_MAX_FINGERPRINT_KEYS) return undefined
  }
  const keyDigests = new Map<string, string>()
  let approxBytes = 128
  const budget = { remaining: AGY_CANONICAL_HASH_MAX_NODES }
  for (const [key, val] of filtered) {
    const hasher = createHash('sha256')
    if (!updateCanonicalJsonHash(hasher, val, 0, budget)) {
      return undefined
    }
    const digest = hasher.digest('hex')
    keyDigests.set(key, digest)
    approxBytes += Buffer.byteLength(key, 'utf8') + digest.length + 32
    if (approxBytes > AGY_MCP_MAX_FINGERPRINT_BYTES) return undefined
  }
  const fullDigest = computeFullDigestFromKeyDigests(keyDigests)
  return { fullDigest, keyDigests, approxBytes }
}

function mergeArgsFingerprints(
  existing: CompactArgsFingerprint | undefined,
  incoming: CompactArgsFingerprint | undefined,
):
  | { readonly kind: 'ok'; readonly fingerprint: CompactArgsFingerprint | undefined }
  | { readonly kind: 'conflict' } {
  if (incoming === undefined) return { kind: 'ok', fingerprint: existing }
  if (existing === undefined) return { kind: 'ok', fingerprint: incoming }
  if (fingerprintsConflict(existing, incoming)) return { kind: 'conflict' }
  if (incoming.keyDigests.size === 0) {
    // Summary-only update retains all previously observed semantic keys!
    return { kind: 'ok', fingerprint: existing }
  }
  if (existing.keyDigests.size === 0) {
    return { kind: 'ok', fingerprint: incoming }
  }
  const merged = new Map<string, string>(existing.keyDigests)
  let approxBytes = existing.approxBytes
  for (const [key, digest] of incoming.keyDigests) {
    if (!merged.has(key)) {
      merged.set(key, digest)
      if (merged.size > AGY_MCP_MAX_FINGERPRINT_KEYS) return { kind: 'conflict' }
      approxBytes += Buffer.byteLength(key, 'utf8') + digest.length + 32
      if (approxBytes > AGY_MCP_MAX_FINGERPRINT_BYTES) return { kind: 'conflict' }
    }
  }
  return {
    kind: 'ok',
    fingerprint: {
      fullDigest: computeFullDigestFromKeyDigests(merged),
      keyDigests: merged,
      approxBytes,
    },
  }
}

function mergePlainArgsRecords(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): { readonly kind: 'ok'; readonly args: Record<string, unknown> } | { readonly kind: 'conflict' } {
  if (!existing) return { kind: 'ok', args: { ...incoming } }
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (key === 'toolSummary') {
      merged[key] = value
      continue
    }
    if (Object.hasOwn(existing, key) && existing[key] !== undefined) {
      if (!isDeepStrictEqual(existing[key], value)) {
        return { kind: 'conflict' }
      }
    } else {
      merged[key] = value
    }
  }
  return { kind: 'ok', args: merged }
}

function compareArgsFingerprints(
  acp: CompactArgsFingerprint | undefined,
  http: CompactArgsFingerprint,
): 'exact' | 'subset' | 'missing_acp_args' | 'mismatch' {
  if (acp === undefined) return 'missing_acp_args'
  if (acp.fullDigest === http.fullDigest) return 'exact'
  for (const [key, httpDigest] of http.keyDigests) {
    if (acp.keyDigests.get(key) !== httpDigest) {
      return 'mismatch'
    }
  }
  for (const key of acp.keyDigests.keys()) {
    if (!http.keyDigests.has(key) && PACT_SEMANTIC_ARG_KEYS.has(key)) {
      return 'mismatch'
    }
  }
  return 'subset'
}

function fingerprintsConflict(a: CompactArgsFingerprint, b: CompactArgsFingerprint): boolean {
  for (const [key, hashA] of a.keyDigests) {
    const hashB = b.keyDigests.get(key)
    if (hashB !== undefined && hashB !== hashA) {
      return true
    }
  }
  return false
}

function resolveFrameArgsEvidence(
  frameArgs: Record<string, unknown> | undefined,
  frameRawInput: Record<string, unknown> | undefined,
):
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'present'
      readonly args: Record<string, unknown>
      readonly fingerprint: CompactArgsFingerprint
    } {
  if (frameArgs === undefined && frameRawInput === undefined) {
    return { kind: 'none' }
  }
  if (frameArgs !== undefined && frameRawInput === undefined) {
    const fpArgs = buildCompactArgsFingerprint(frameArgs, true)
    return fpArgs ? { kind: 'present', args: frameArgs, fingerprint: fpArgs } : { kind: 'conflict' }
  }
  if (frameArgs === undefined && frameRawInput !== undefined) {
    const fpRaw = buildCompactArgsFingerprint(frameRawInput, true)
    return fpRaw
      ? { kind: 'present', args: frameRawInput, fingerprint: fpRaw }
      : { kind: 'conflict' }
  }
  const fpArgs = buildCompactArgsFingerprint(frameArgs!, true)
  const fpRaw = buildCompactArgsFingerprint(frameRawInput!, true)
  if (!fpArgs || !fpRaw || fingerprintsConflict(fpArgs, fpRaw)) {
    return { kind: 'conflict' }
  }
  if (fpArgs.keyDigests.size > 0 && fpRaw.keyDigests.size > 0) {
    if (fpArgs.keyDigests.size !== fpRaw.keyDigests.size) {
      return { kind: 'conflict' }
    }
    for (const [key, digest] of fpArgs.keyDigests) {
      if (fpRaw.keyDigests.get(key) !== digest) {
        return { kind: 'conflict' }
      }
    }
  }
  const merged = { ...frameRawInput!, ...frameArgs! }
  const mergedFp = mergeArgsFingerprints(fpRaw, fpArgs)
  return mergedFp.kind === 'ok' && mergedFp.fingerprint
    ? { kind: 'present', args: merged, fingerprint: mergedFp.fingerprint }
    : { kind: 'conflict' }
}

const TRAJECTORY_IDENTITY_KEYS = [
  'trajectoryId',
  'trajectory_id',
  'antigravity.google/trajectory_id',
  'root_trajectory_id',
  'antigravity.google/root_trajectory_id',
] as const

const STEP_INDEX_KEYS = ['stepIdx', 'step_idx'] as const

const SESSION_IDENTITY_KEYS = [
  'sessionId',
  'session_id',
  'antigravity.google/conversation_id',
  'conversation_id',
  'antigravity.google/root_conversation_id',
  'root_conversation_id',
] as const

const EXECUTION_IDENTITY_KEYS = ['executionId', 'execution_id'] as const

function extractSuppliedTrajectoryAndStepEvidence(
  containers: ReadonlyArray<Record<string, unknown> | undefined>,
): {
  readonly trajectoryId?: string
  readonly stepIdx?: number
  readonly contradicted: boolean
} {
  let trajectoryId: string | undefined
  let stepIdx: number | undefined
  let contradicted = false

  for (const container of containers) {
    if (!container) continue
    for (const key of TRAJECTORY_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || !isValidAgyTrajectoryId(raw)) {
        contradicted = true
        continue
      }
      if (trajectoryId !== undefined && trajectoryId !== raw) {
        contradicted = true
      } else {
        trajectoryId = raw
      }
    }
    for (const key of STEP_INDEX_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        contradicted = true
        continue
      }
      if (stepIdx !== undefined && stepIdx !== raw) {
        contradicted = true
      } else {
        stepIdx = raw
      }
    }
  }

  return {
    ...(trajectoryId !== undefined ? { trajectoryId } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    contradicted,
  }
}

interface ValidatedAgyTokenEvidence {
  readonly suppliedCount: number
  readonly allCanonicalTokens: readonly string[]
  readonly hasInvalidToken: boolean
  readonly hasConflictingTokens: boolean
  readonly resolvedToken?: CanonicalProgressToken | undefined
}

interface ValidatedAgyFrame {
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

function validateAgyFrame(
  ingress: Extract<AgyIngress, { kind: 'notification' | 'server_request' }>,
  expectedSessionId: string | undefined,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedAgyFrame {
  const message = ingress.message
  const method =
    ingress.kind === 'server_request'
      ? ingress.method
      : (asString(Reflect.get(message, 'method')) ?? '')
  const rawParams = Reflect.get(message, 'params')
  const params = isPlainObject(rawParams) ? rawParams : {}
  const rawParamsMeta = Reflect.get(params, '_meta')
  const paramsMeta = isPlainObject(rawParamsMeta) ? rawParamsMeta : undefined

  const isUpdate = ingress.kind === 'notification' && method === 'session/update'
  const isPermission = ingress.kind === 'server_request' && method === 'session/request_permission'
  const rawPayload = isUpdate
    ? Reflect.get(params, 'update')
    : isPermission
      ? Reflect.get(params, 'toolCall')
      : undefined
  const payload = isPlainObject(rawPayload) ? rawPayload : undefined
  const rawPayloadMeta = payload ? Reflect.get(payload, '_meta') : undefined
  const payloadMeta = isPlainObject(rawPayloadMeta) ? rawPayloadMeta : undefined
  const sessionUpdate = isUpdate && payload ? asString(payload.sessionUpdate) : undefined

  // 1. Full forensic session/root conversation identity check across params, payload, and _meta.
  let sawMatchingSessionId = false
  let sawForeignSessionId = false
  let sawMalformedSessionId = false
  if (rawParamsMeta !== undefined && !isPlainObject(rawParamsMeta)) {
    sawMalformedSessionId = true
  }
  if (payload && rawPayloadMeta !== undefined && !isPlainObject(rawPayloadMeta)) {
    sawMalformedSessionId = true
  }
  const suppliedSessionIds: string[] = []
  const sessionContainers: Array<Record<string, unknown> | undefined> = [
    params,
    paramsMeta,
    payload,
    payloadMeta,
  ]
  for (const container of sessionContainers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        sawMalformedSessionId = true
        continue
      }
      suppliedSessionIds.push(raw)
      if (expectedSessionId !== undefined) {
        if (raw === expectedSessionId) {
          sawMatchingSessionId = true
        } else {
          sawForeignSessionId = true
        }
      }
    }
  }
  for (let i = 1; i < suppliedSessionIds.length; i += 1) {
    if (suppliedSessionIds[i] !== suppliedSessionIds[0]) {
      sawMalformedSessionId = true
    }
  }
  const sessionAttribution: ValidatedAgyFrame['sessionAttribution'] = sawMalformedSessionId
    ? 'invalid_or_conflicting'
    : sawForeignSessionId && !sawMatchingSessionId
      ? 'pure_foreign'
      : sawForeignSessionId && sawMatchingSessionId
        ? 'invalid_or_conflicting'
        : sawMatchingSessionId
          ? 'matching'
          : 'absent'
  const isAttributableToCurrentSession =
    sessionAttribution === 'matching' || sessionAttribution === 'absent'
  const hasForeignOrInvalidSessionMeta =
    sessionAttribution === 'pure_foreign' || sessionAttribution === 'invalid_or_conflicting'

  // 2. Execution ID forensic extraction.
  let executionId: string | undefined
  let executionIdInvalid = false
  for (const container of [payload, payloadMeta, params, paramsMeta]) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        executionIdInvalid = true
        continue
      }
      if (executionId !== undefined && executionId !== raw) {
        executionIdInvalid = true
      } else {
        executionId = raw
      }
    }
  }

  // 3. Trajectory ID & Step Index forensic extraction across all containers.
  const trajStep = extractSuppliedTrajectoryAndStepEvidence([
    payload,
    payloadMeta,
    params,
    paramsMeta,
  ])

  // 4. Progress tokens: inspect EVERY container slot (never short-circuit with `??`)!
  const allCanonicalTokens: string[] = []
  let suppliedCount = 0
  let hasInvalidToken = false
  let hasConflictingTokens = false
  let firstParsedToken: CanonicalProgressToken | undefined
  for (const container of [payload, payloadMeta, params, paramsMeta]) {
    if (!container || !Object.hasOwn(container, 'progressToken')) continue
    const rawPt = container.progressToken
    if (rawPt === undefined) continue
    suppliedCount += 1
    const parsedPt = canonicalizeProgressToken(rawPt)
    if (!parsedPt) {
      hasInvalidToken = true
      continue
    }
    if (!allCanonicalTokens.includes(parsedPt.canonical)) {
      allCanonicalTokens.push(parsedPt.canonical)
    }
    if (parsedPt.structured?.hasLeadingZeros) {
      hasInvalidToken = true
    }
    if (firstParsedToken === undefined) {
      firstParsedToken = parsedPt
    } else if (firstParsedToken.canonical !== parsedPt.canonical) {
      hasConflictingTokens = true
    }
  }
  const resolvedToken =
    !hasInvalidToken && !hasConflictingTokens && firstParsedToken !== undefined
      ? firstParsedToken
      : undefined

  // 5. Intra-frame root consistency + pinned trajectory / minStepIdx check (BEFORE any pinning!).
  let rootEvidenceContradicted =
    trajStep.contradicted || executionIdInvalid || hasInvalidToken || hasConflictingTokens
  if (trajStep.trajectoryId !== undefined && pinnedTrajectory !== undefined) {
    if (trajStep.trajectoryId !== pinnedTrajectory) {
      rootEvidenceContradicted = true
    }
  }
  if (trajStep.stepIdx !== undefined && minStepIdx !== undefined) {
    if (trajStep.stepIdx < minStepIdx) {
      rootEvidenceContradicted = true
    }
  }
  if (resolvedToken?.structured) {
    if (
      trajStep.trajectoryId !== undefined &&
      resolvedToken.structured.trajectoryId !== trajStep.trajectoryId
    ) {
      rootEvidenceContradicted = true
    }
    if (trajStep.stepIdx !== undefined && resolvedToken.structured.stepIdx !== trajStep.stepIdx) {
      rootEvidenceContradicted = true
    }
    if (
      pinnedTrajectory !== undefined &&
      resolvedToken.structured.trajectoryId !== pinnedTrajectory
    ) {
      rootEvidenceContradicted = true
    }
    if (minStepIdx !== undefined && resolvedToken.structured.stepIdx < minStepIdx) {
      rootEvidenceContradicted = true
    }
  }
  // Even when a token is conflicted/leading-zero, check if any normalizable structured token conflicts
  // with trajectory/step to ensure full intra-frame contradiction detection.
  if (hasConflictingTokens || hasInvalidToken) {
    rootEvidenceContradicted = true
  }

  // 6. Tool call ID extraction.
  let toolCallId: string | undefined
  let toolCallIdInvalid = false
  if (payload) {
    const hasToolCallIdField =
      Object.hasOwn(payload, 'toolCallId') && payload.toolCallId !== undefined
    const hasIdField = Object.hasOwn(payload, 'id') && payload.id !== undefined
    const rawTcId = hasToolCallIdField ? payload.toolCallId : hasIdField ? payload.id : undefined
    if (rawTcId !== undefined) {
      if (
        typeof rawTcId !== 'string' ||
        rawTcId.length === 0 ||
        Buffer.byteLength(rawTcId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        toolCallIdInvalid = true
      } else {
        toolCallId = rawTcId
      }
    }
    if (
      hasToolCallIdField &&
      hasIdField &&
      typeof payload.toolCallId === 'string' &&
      typeof payload.id === 'string' &&
      payload.toolCallId !== payload.id
    ) {
      toolCallIdInvalid = true
    }
  }

  // 7. Exact explicit tool name (strictly payload.name; NEVER display-only payload.kind!).
  let explicitToolName: string | undefined
  let explicitToolNameInvalid = false
  if (payload && Object.hasOwn(payload, 'name') && payload.name !== undefined) {
    if (typeof payload.name !== 'string' || payload.name.length === 0) {
      explicitToolNameInvalid = true
    } else {
      explicitToolName = payload.name.slice(0, 120)
    }
  }

  // 8. Tool status (checked on BOTH session/update AND session/request_permission!).
  const statusPresent = Boolean(
    payload && Object.hasOwn(payload, 'status') && payload.status !== undefined,
  )
  const status = statusPresent ? normalizeAcpToolStatus(payload!.status) : undefined
  const statusInvalid = statusPresent && status === undefined

  // 9. Args / rawInput forensic extraction (distinguish absent vs plain object vs explicit non-object!).
  const rawArgsPresent = Boolean(
    payload && Object.hasOwn(payload, 'args') && payload.args !== undefined,
  )
  const rawInputPresent = Boolean(
    payload && Object.hasOwn(payload, 'rawInput') && payload.rawInput !== undefined,
  )
  const frameArgs = rawArgsPresent && isPlainObject(payload!.args) ? payload!.args : undefined
  const frameRawInput =
    rawInputPresent && isPlainObject(payload!.rawInput) ? payload!.rawInput : undefined
  let argsEvidence: ValidatedAgyFrame['argsEvidence']
  if ((rawArgsPresent && !frameArgs) || (rawInputPresent && !frameRawInput)) {
    argsEvidence = { kind: 'invalid_or_conflict' }
  } else {
    const resolved = resolveFrameArgsEvidence(frameArgs, frameRawInput)
    argsEvidence =
      resolved.kind === 'none'
        ? { kind: 'absent' }
        : resolved.kind === 'present'
          ? { kind: 'present', args: resolved.args, fingerprint: resolved.fingerprint }
          : { kind: 'invalid_or_conflict' }
  }

  return {
    seq: ingress.seq,
    kind: ingress.kind,
    method,
    ...(ingress.kind === 'server_request' ? { rpcId: ingress.rpcId } : {}),
    message,
    params,
    payload,
    ...(sessionUpdate !== undefined ? { sessionUpdate } : {}),
    sessionAttribution,
    isAttributableToCurrentSession,
    hasForeignOrInvalidSessionMeta,
    ...(executionId !== undefined ? { executionId } : {}),
    executionIdInvalid,
    ...(trajStep.trajectoryId !== undefined ? { trajectoryId: trajStep.trajectoryId } : {}),
    ...(trajStep.stepIdx !== undefined ? { stepIdx: trajStep.stepIdx } : {}),
    rootEvidenceContradicted,
    tokens: {
      suppliedCount,
      allCanonicalTokens,
      hasInvalidToken,
      hasConflictingTokens,
      ...(resolvedToken !== undefined ? { resolvedToken } : {}),
    },
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    toolCallIdInvalid,
    ...(explicitToolName !== undefined ? { explicitToolName } : {}),
    explicitToolNameInvalid,
    ...(status !== undefined ? { status } : {}),
    statusPresent,
    statusInvalid,
    argsEvidence,
    rawArgsPresent,
    rawInputPresent,
    ...(frameArgs !== undefined ? { frameArgs } : {}),
    ...(frameRawInput !== undefined ? { frameRawInput } : {}),
  }
}

/**
 * Single-pass root-boundary recheck for staged pre-bind frames: reuses the already-validated
 * identity fields and argument fingerprint without re-parsing or re-hashing the raw frame.
 */
function recheckValidatedFrameAgainstRootBoundary(
  validated: ValidatedAgyFrame,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedAgyFrame {
  if (validated.rootEvidenceContradicted) return validated
  let contradicted = false
  if (
    validated.trajectoryId !== undefined &&
    pinnedTrajectory !== undefined &&
    validated.trajectoryId !== pinnedTrajectory
  ) {
    contradicted = true
  }
  if (
    validated.stepIdx !== undefined &&
    minStepIdx !== undefined &&
    validated.stepIdx < minStepIdx
  ) {
    contradicted = true
  }
  const structured = validated.tokens.resolvedToken?.structured
  if (structured) {
    if (pinnedTrajectory !== undefined && structured.trajectoryId !== pinnedTrajectory) {
      contradicted = true
    }
    if (minStepIdx !== undefined && structured.stepIdx < minStepIdx) {
      contradicted = true
    }
  }
  if (!contradicted) return validated
  return { ...validated, rootEvidenceContradicted: true }
}

type ParsedAgyPromptTerminalReply =
  | {
      readonly ok: true
      readonly stopReason: string
      readonly executionId?: string | undefined
    }
  | {
      readonly ok: false
      readonly reason: string
      readonly message: string
    }

const AGY_MAX_EXECUTION_ID_BYTES = 256

function parseAgyPromptTerminalReply(
  res: object | undefined,
  expectedSessionId: string | undefined,
): ParsedAgyPromptTerminalReply {
  const rpcError = res ? Reflect.get(res, 'error') : undefined
  const rpcResult = res ? Reflect.get(res, 'result') : undefined
  if (rpcError || !isPlainObject(rpcResult)) {
    return {
      ok: false,
      reason: 'Antigravity returned an invalid session/prompt response.',
      message: rpcError
        ? safeNativePermissionText(JSON.stringify(rpcError), 240)
        : 'Antigravity returned an invalid session/prompt result.',
    }
  }
  const rawStopReason = asString(rpcResult.stopReason)?.trim()
  if (!rawStopReason || !VALID_ACP_STOP_REASONS.has(rawStopReason)) {
    return {
      ok: false,
      reason: 'Antigravity returned a session/prompt result without a valid stopReason.',
      message: rawStopReason
        ? `Antigravity returned an unrecognized session/prompt stopReason "${safeNativePermissionText(rawStopReason, 80)}".`
        : 'Antigravity returned a session/prompt result without a stopReason.',
    }
  }
  const rawMeta: unknown = Object.hasOwn(rpcResult, '_meta')
    ? Reflect.get(rpcResult, '_meta')
    : undefined
  if (rawMeta !== undefined && !isPlainObject(rawMeta)) {
    return {
      ok: false,
      reason: 'Antigravity returned a session/prompt result with malformed _meta.',
      message: 'Antigravity returned a session/prompt result with malformed _meta.',
    }
  }
  const containers: Array<Record<string, unknown> | undefined> = [
    rpcResult,
    isPlainObject(rawMeta) ? rawMeta : undefined,
  ]
  let seenSessionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return {
          ok: false,
          reason: 'Antigravity returned a session/prompt result with invalid session identity.',
          message: 'Antigravity returned a session/prompt result with invalid session identity.',
        }
      }
      if (expectedSessionId !== undefined && raw !== expectedSessionId) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result for a different native session identity.',
          message:
            'Antigravity returned a session/prompt result for a different native session identity.',
        }
      }
      if (seenSessionId !== undefined && seenSessionId !== raw) {
        return {
          ok: false,
          reason: 'Antigravity returned a session/prompt result with conflicting session aliases.',
          message: 'Antigravity returned a session/prompt result with conflicting session aliases.',
        }
      }
      seenSessionId = raw
    }
  }
  let executionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        Buffer.byteLength(raw, 'utf8') > AGY_MAX_EXECUTION_ID_BYTES
      ) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result with an invalid or oversized execution_id.',
          message:
            'Antigravity returned a session/prompt result with an invalid or oversized execution_id.',
        }
      }
      if (executionId !== undefined && executionId !== raw) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result with conflicting executionId / execution_id aliases.',
          message:
            'Antigravity returned a session/prompt result with conflicting executionId / execution_id aliases.',
        }
      }
      executionId = raw
    }
  }
  return {
    ok: true,
    stopReason: rawStopReason,
    ...(executionId !== undefined ? { executionId } : {}),
  }
}

interface ValidatedBackgroundOwnership {
  readonly valid: boolean
  readonly executionId?: string | undefined
  readonly trajectoryId?: string | undefined
  readonly stepIdx?: number | undefined
}

function validateBackgroundUpdateForRun(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
  trackedRun: ActiveAgyRun,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedBackgroundOwnership {
  const rawParamsMeta: unknown = Object.hasOwn(params, '_meta')
    ? Reflect.get(params, '_meta')
    : undefined
  const rawUpdateMeta: unknown = Object.hasOwn(update, '_meta')
    ? Reflect.get(update, '_meta')
    : undefined
  if (
    (rawParamsMeta !== undefined && !isPlainObject(rawParamsMeta)) ||
    (rawUpdateMeta !== undefined && !isPlainObject(rawUpdateMeta))
  ) {
    return { valid: false }
  }
  const paramsMeta = isPlainObject(rawParamsMeta) ? rawParamsMeta : undefined
  const updateMeta = isPlainObject(rawUpdateMeta) ? rawUpdateMeta : undefined
  const containers = [update, updateMeta, params, paramsMeta]
  for (const container of containers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        raw !== trackedRun.nativeSessionId
      ) {
        return { valid: false }
      }
    }
  }
  let executionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        Buffer.byteLength(raw, 'utf8') > AGY_MAX_EXECUTION_ID_BYTES
      ) {
        return { valid: false }
      }
      if (executionId !== undefined && executionId !== raw) {
        return { valid: false }
      }
      executionId = raw
    }
  }
  if (executionId !== undefined) {
    if (trackedRun.knownForeignExecutionIds.has(executionId)) {
      return { valid: false }
    }
    if (
      trackedRun.providerExecutionId !== undefined &&
      executionId !== trackedRun.providerExecutionId
    ) {
      return { valid: false }
    }
  }
  const trajStep = extractSuppliedTrajectoryAndStepEvidence(containers)
  if (trajStep.contradicted) {
    return { valid: false }
  }
  if (
    trajStep.trajectoryId !== undefined &&
    pinnedTrajectory !== undefined &&
    trajStep.trajectoryId !== pinnedTrajectory
  ) {
    return { valid: false }
  }
  if (trajStep.stepIdx !== undefined && minStepIdx !== undefined && trajStep.stepIdx < minStepIdx) {
    return { valid: false }
  }

  // Validate progressToken under the exact same rules as foreground frames.
  let firstParsedToken: CanonicalProgressToken | undefined
  for (const container of containers) {
    if (!container || !Object.hasOwn(container, 'progressToken')) continue
    const rawPt = container.progressToken
    if (rawPt === undefined) continue
    const parsedPt = canonicalizeProgressToken(rawPt)
    if (!parsedPt || parsedPt.structured?.hasLeadingZeros) {
      return { valid: false }
    }
    if (firstParsedToken === undefined) {
      firstParsedToken = parsedPt
    } else if (firstParsedToken.canonical !== parsedPt.canonical) {
      return { valid: false }
    }
  }
  if (firstParsedToken?.structured) {
    if (
      trajStep.trajectoryId !== undefined &&
      firstParsedToken.structured.trajectoryId !== trajStep.trajectoryId
    ) {
      return { valid: false }
    }
    if (
      trajStep.stepIdx !== undefined &&
      firstParsedToken.structured.stepIdx !== trajStep.stepIdx
    ) {
      return { valid: false }
    }
    if (
      pinnedTrajectory !== undefined &&
      firstParsedToken.structured.trajectoryId !== pinnedTrajectory
    ) {
      return { valid: false }
    }
    if (minStepIdx !== undefined && firstParsedToken.structured.stepIdx < minStepIdx) {
      return { valid: false }
    }
  }

  const effectiveTrajectoryId = trajStep.trajectoryId ?? firstParsedToken?.structured?.trajectoryId
  const effectiveStepIdx = trajStep.stepIdx ?? firstParsedToken?.structured?.stepIdx
  return {
    valid: true,
    ...(executionId !== undefined ? { executionId } : {}),
    ...(effectiveTrajectoryId !== undefined ? { trajectoryId: effectiveTrajectoryId } : {}),
    ...(effectiveStepIdx !== undefined ? { stepIdx: effectiveStepIdx } : {}),
  }
}

interface CompactPostCutoffBackgroundRecord {
  readonly ownership: {
    readonly executionId?: string | undefined
    readonly trajectoryId?: string | undefined
    readonly stepIdx?: number | undefined
  }
  readonly sessionUpdate: string
  readonly status?: string | undefined
  readonly outOfTurn: boolean
  readonly taskId?: string | undefined
  readonly toolCallId?: string | undefined
  readonly explicitMsgId?: string | undefined
  readonly rawText?: string | undefined
}

function buildCompactPostCutoffBackgroundRecord(
  update: Record<string, unknown>,
  ownership: ValidatedBackgroundOwnership,
): CompactPostCutoffBackgroundRecord | undefined {
  const sessionUpdate = asString(update.sessionUpdate)
  if (!sessionUpdate) return undefined
  const status = asString(update.status)
  const outOfTurn = update.outOfTurn === true
  const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
  const taskId =
    asString(update.taskId ?? update.backgroundTaskId) ??
    (rawOutput ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId) : undefined)
  const toolCallId = asString(update.toolCallId ?? update.id)
  const explicitMsgId = asString(update.messageId ?? update.stepId)
  const isOutOfTurnCompletion =
    (sessionUpdate === 'agent_message_chunk' && outOfTurn) ||
    sessionUpdate === 'background_task_completed' ||
    (sessionUpdate === 'tool_call_update' && status === 'completed' && outOfTurn)
  const rawText = isOutOfTurnCompletion
    ? isPlainObject(update.content)
      ? asString(update.content.text)
      : asString(update.text ?? update.summary)
    : undefined
  return {
    ownership: {
      ...(ownership.executionId !== undefined ? { executionId: ownership.executionId } : {}),
      ...(ownership.trajectoryId !== undefined ? { trajectoryId: ownership.trajectoryId } : {}),
      ...(ownership.stepIdx !== undefined ? { stepIdx: ownership.stepIdx } : {}),
    },
    sessionUpdate,
    ...(status !== undefined ? { status } : {}),
    outOfTurn,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(explicitMsgId !== undefined ? { explicitMsgId } : {}),
    ...(rawText !== undefined ? { rawText } : {}),
  }
}

function estimateCompactBackgroundRecordBytes(record: CompactPostCutoffBackgroundRecord): number {
  let bytes = 256
  const charge = (val: string | undefined): void => {
    if (val !== undefined) bytes += Buffer.byteLength(val, 'utf8') * 2 + 16
  }
  charge(record.ownership.executionId)
  charge(record.ownership.trajectoryId)
  charge(record.sessionUpdate)
  charge(record.status)
  charge(record.taskId)
  charge(record.toolCallId)
  charge(record.explicitMsgId)
  charge(record.rawText)
  return bytes
}

type AcpMcpCallLifecycle = 'open' | 'completed' | 'failed' | 'revoked'

interface ActiveAcpMcpCall {
  readonly toolCallId: string
  readonly toolName: string
  lifecycle: AcpMcpCallLifecycle
  sawPreTerminal: boolean
  promoted?: boolean | undefined
  trajectoryId?: string | undefined
  stepIdx?: number | undefined
  argsFingerprint: CompactArgsFingerprint | undefined
  explicitProgressToken: string | undefined
  correlatedProgressToken: string | undefined
  claimedViaTokenless?: boolean | undefined
  claimedHttpArgsFingerprint: CompactArgsFingerprint | undefined
}

type TokenLedgerEntry =
  | { readonly kind: 'in_flight_http' }
  | { readonly kind: 'non_mcp' }
  | { readonly kind: 'claimed'; ownerKey: string }
  | { readonly kind: 'consumed' }

interface ProvisionalTokenOwner {
  readonly toolName: string
  readonly httpFingerprint: CompactArgsFingerprint
}

type StagedMcpOutcomeKind =
  | { type: 'title'; title: string }
  | {
      type: 'peer'
      targetAgentId: Exclude<RuntimeAgentId, 'agy'>
      proposalKind: 'supplement' | 'fact_check' | 'challenge' | 'review'
      reason?: string | undefined
    }
  | { type: 'review'; observation: CollaborationReviewObservation }
  | { type: 'input_result'; observation: CollaborationInputObservation }
  | { type: 'retain_plan' }
  | { type: 'publish_plan_chunk'; offset: number; byteLength: number; complete: boolean }

interface StagedMcpOutcomeRecord {
  ownerKey: string
  readonly progressToken: string
  readonly httpFingerprint: CompactArgsFingerprint
  readonly kind: StagedMcpOutcomeKind
  readonly payloadBytes: number
}

type PromotedMcpOutcome =
  | { type: 'title'; title: string }
  | {
      type: 'peer'
      targetAgentId: Exclude<RuntimeAgentId, 'agy'>
      proposalKind: 'supplement' | 'fact_check' | 'challenge' | 'review'
      reason?: string | undefined
    }
  | { type: 'review'; observation: CollaborationReviewObservation }
  | { type: 'input_result'; observation: CollaborationInputObservation }
  | { type: 'retain_plan' }
  | { type: 'publish_plan'; markdown: string; finalToolCallId: string }
  | { type: 'publish_plan_failed'; reason: string }

function computePlanConversionWorkspaceBytes(totalPlanBytes: number): number {
  // Budget temporary merged UTF-8 buffer (`totalPlanBytes`) + worst-case UTF-16 decoded string (`totalPlanBytes * 2`) + header.
  return totalPlanBytes + totalPlanBytes * 2 + 64
}

function computeRetainedPlanTextBytes(text: string): number {
  return text.length * 2 + 64
}

interface PendingPlanChunk {
  ownerKey: string
  readonly offset: number
  readonly bytes: Buffer
  readonly hasNonWhitespace: boolean
  readonly complete: boolean
  confirmed: boolean
  confirmedToolCallId?: string | undefined
  invalidated: boolean
}

function estimateStagedOutcomePayloadBytes(kind: StagedMcpOutcomeKind): number {
  switch (kind.type) {
    case 'title':
      return Buffer.byteLength(kind.title, 'utf8') + 32
    case 'peer':
      return (
        Buffer.byteLength(kind.targetAgentId, 'utf8') +
        Buffer.byteLength(kind.proposalKind, 'utf8') +
        (kind.reason ? Buffer.byteLength(kind.reason, 'utf8') : 0) +
        48
      )
    case 'review':
    case 'input_result':
      return Buffer.byteLength(JSON.stringify(kind.observation), 'utf8') + 32
    case 'retain_plan':
    case 'publish_plan_chunk':
      return 48
    default:
      return 48
  }
}

type AcpToolCallAdmissionResult = 'admitted' | 'already_retired' | 'rejected_capacity'

type RootProofCheckResult = 'ok' | 'wait' | { readonly kind: 'reject'; readonly error: string }

type HttpClaimAttempt =
  | { readonly kind: 'claimed'; readonly ownerKey: string }
  | { readonly kind: 'wait' }
  | { readonly kind: 'reject'; readonly error: string }

/**
 * Cohesive per-Run MCP call correlation state machine.
 * Owns canonical `tokenLedger`, irreversible `ActiveAcpMcpCall` lifecycles with bounded retired
 * call tombstones, provisional `token:<pt>` -> `call:<id>` atomic migration, staged outcomes,
 * plan chunk reassembly, and strict admit-before-insert correlation/plan byte reservation accounting.
 */
class McpCallCorrelator {
  private closed = false
  private revoked = false
  private tokenCapacityExhausted = false
  private correlatorCapacityExhausted = false
  private tokenlessCorrelationCompromised = false
  private pinnedTrajectoryId: string | undefined
  private trajectoryIdSource: 'acp' | 'storage_db' | undefined
  private hostMinStepIdx: number | undefined
  private allowLazyStorageDbPin = true

  private readonly activeAcpToolCalls = new Map<string, ActiveAcpMcpCall>()
  private readonly retiredCallIdDigests = new Set<string>()
  private readonly tokenLedger = new Map<string, TokenLedgerEntry>()
  private readonly inFlightHttpFingerprints = new Map<string, number>()
  private readonly provisionalTokenOwners = new Map<string, ProvisionalTokenOwner>()
  private readonly stagedOutcomes = new Map<string, StagedMcpOutcomeRecord>()
  private readonly activeCallWaiters = new Set<() => void>()
  private wakeBatchDepth = 0
  private wakePending = false
  private recomputingProvisionalDepth = 0

  private titleConfirmed = false
  private pendingTitleOwner: string | undefined
  private peerConfirmed = false
  private pendingPeerOwner: string | undefined
  private openPlanFinalized = false
  private acknowledgedFinalOpenPlan = false
  private readonly confirmedPlanChunks: Buffer[] = []
  private confirmedPlanBytes = 0
  private confirmedPlanHasNonWhitespace = false
  private planConversionWorkspaceBytes = 0
  private pendingTransferredPlanBytes = 0
  private readonly pendingPlanChunks: PendingPlanChunk[] = []

  constructor(
    private readonly reserveCorrelationBytes?: (nextBytes: number) => boolean,
    private readonly getMinRootStepIdx?: () => number | undefined,
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  get isRevoked(): boolean {
    return this.revoked
  }

  get isTokenCapacityExhausted(): boolean {
    return this.tokenCapacityExhausted
  }

  get pinnedTrajectory(): string | undefined {
    return this.pinnedTrajectoryId
  }

  get pinnedTrajectorySource(): 'acp' | 'storage_db' | undefined {
    return this.trajectoryIdSource
  }

  get minHostStepIdx(): number | undefined {
    return this.hostMinStepIdx
  }

  get canLazyPinStorageDb(): boolean {
    return this.allowLazyStorageDbPin
  }

  get isTitleSlotTaken(): boolean {
    return this.titleConfirmed || this.pendingTitleOwner !== undefined
  }

  get isPeerSlotTaken(): boolean {
    return this.peerConfirmed || this.pendingPeerOwner !== undefined
  }

  get isOpenPlanFinalizedOrPendingFinal(): boolean {
    return (
      this.openPlanFinalized ||
      this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.complete)
    )
  }

  get hasAcknowledgedFinalOpenPlan(): boolean {
    return this.acknowledgedFinalOpenPlan
  }

  private effectiveMinStepIdx(): number | undefined {
    return this.getMinRootStepIdx?.() ?? this.hostMinStepIdx
  }

  private validatesAgainstRootEvidence(
    trajectoryId: string | undefined,
    stepIdx: number | undefined,
    parsedPt: CanonicalProgressToken | undefined,
  ): boolean {
    const minStepIdx = this.effectiveMinStepIdx()
    if (trajectoryId !== undefined) {
      if (!isValidAgyTrajectoryId(trajectoryId)) return false
      if (this.pinnedTrajectoryId !== undefined && trajectoryId !== this.pinnedTrajectoryId) {
        return false
      }
    }
    if (stepIdx !== undefined) {
      if (!Number.isSafeInteger(stepIdx) || stepIdx < 0) return false
      if (minStepIdx !== undefined && stepIdx < minStepIdx) {
        return false
      }
    }
    if (parsedPt?.structured) {
      if (parsedPt.structured.hasLeadingZeros) return false
      if (
        this.pinnedTrajectoryId !== undefined &&
        parsedPt.structured.trajectoryId !== this.pinnedTrajectoryId
      ) {
        return false
      }
      if (trajectoryId !== undefined && parsedPt.structured.trajectoryId !== trajectoryId) {
        return false
      }
      if (minStepIdx !== undefined && parsedPt.structured.stepIdx < minStepIdx) {
        return false
      }
      if (stepIdx !== undefined && parsedPt.structured.stepIdx !== stepIdx) {
        return false
      }
    }
    return true
  }

  get pendingPlanChunkCount(): number {
    return this.pendingPlanChunks.length
  }

  get confirmedPlanByteCount(): number {
    return this.confirmedPlanBytes
  }

  disallowLazyStorageDbPin(): void {
    this.allowLazyStorageDbPin = false
  }

  notifyRootProofUpdated(): void {
    this.wakeAllWaiters()
  }

  clearPendingTransferredPlanBytes(): void {
    if (this.pendingTransferredPlanBytes === 0) return
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
  }

  pinHostTrajectoryId(trajectoryId: string, stepCount?: number): void {
    if (!isValidAgyTrajectoryId(trajectoryId)) return
    let updated = false
    if (this.pinnedTrajectoryId === undefined) {
      this.pinnedTrajectoryId = trajectoryId
      this.trajectoryIdSource = 'storage_db'
      updated = true
    }
    if (stepCount !== undefined && this.hostMinStepIdx === undefined) {
      this.hostMinStepIdx = stepCount
      updated = true
    }
    if (updated) {
      this.wakeAllWaiters()
    }
  }

  pinRootTrajectoryId(trajectoryId: string): void {
    if (!isValidAgyTrajectoryId(trajectoryId)) return
    if (this.pinnedTrajectoryId === undefined) {
      this.pinnedTrajectoryId = trajectoryId
      this.trajectoryIdSource = 'acp'
      this.wakeAllWaiters()
    }
  }

  pendingPlanBufferBytes(): number {
    let total = 0
    for (const chunk of this.pendingPlanChunks) {
      if (!chunk.invalidated) total += chunk.bytes.byteLength
    }
    return total
  }

  hasNonWhitespacePlanContent(extraHasNonWhitespace: boolean): boolean {
    if (extraHasNonWhitespace || this.confirmedPlanHasNonWhitespace) {
      return true
    }
    return this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.hasNonWhitespace)
  }

  private matchesCallRootEvidence(entry: ActiveAcpMcpCall, canonicalPt: string): boolean {
    const parsed = canonicalizeProgressToken(canonicalPt)
    if (!parsed?.structured) return true
    if (entry.trajectoryId !== undefined && parsed.structured.trajectoryId !== entry.trajectoryId) {
      return false
    }
    if (entry.stepIdx !== undefined && parsed.structured.stepIdx !== entry.stepIdx) {
      return false
    }
    return true
  }

  lookupVerifiedCallToolName(toolCallId: string): string | undefined {
    return this.activeAcpToolCalls.get(toolCallId)?.toolName
  }

  private computeAcpCallBytes(entry: ActiveAcpMcpCall): number {
    let bytes =
      AGY_MCP_TERMINAL_STUB_BYTES +
      Buffer.byteLength(entry.toolCallId, 'utf8') +
      (entry.trajectoryId ? Buffer.byteLength(entry.trajectoryId, 'utf8') + 16 : 0) +
      (entry.stepIdx !== undefined ? 16 : 0) +
      (entry.explicitProgressToken
        ? Buffer.byteLength(entry.explicitProgressToken, 'utf8') + 16
        : 0) +
      (entry.correlatedProgressToken
        ? Buffer.byteLength(entry.correlatedProgressToken, 'utf8') + 16
        : 0)
    if (entry.lifecycle === 'open') {
      bytes +=
        (entry.argsFingerprint?.approxBytes ?? 0) +
        (entry.claimedHttpArgsFingerprint?.approxBytes ?? 0)
    }
    return bytes
  }

  computeCorrelationHeldBytes(): {
    metadataBytes: number
    planBufferBytes: number
    extraPlanBytes: number
    totalBytes: number
  } {
    let metadataBytes = this.retiredCallIdDigests.size * AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES
    for (const entry of this.activeAcpToolCalls.values()) {
      metadataBytes += this.computeAcpCallBytes(entry)
    }
    for (const [token, ledgerEntry] of this.tokenLedger) {
      metadataBytes += Buffer.byteLength(token, 'utf8') + 32
      if (ledgerEntry.kind === 'claimed') {
        metadataBytes += Buffer.byteLength(ledgerEntry.ownerKey, 'utf8') + 16
      }
    }
    for (const inFlightBytes of this.inFlightHttpFingerprints.values()) {
      metadataBytes += inFlightBytes
    }
    for (const [token, prov] of this.provisionalTokenOwners) {
      metadataBytes += Buffer.byteLength(token, 'utf8') + prov.httpFingerprint.approxBytes + 32
    }
    for (const [ownerKey, rec] of this.stagedOutcomes) {
      metadataBytes +=
        Buffer.byteLength(ownerKey, 'utf8') +
        Buffer.byteLength(rec.progressToken, 'utf8') +
        rec.httpFingerprint.approxBytes +
        rec.payloadBytes +
        32
    }
    let planBufferBytes = 0
    for (const chunk of this.pendingPlanChunks) {
      if (!chunk.invalidated) {
        metadataBytes +=
          Buffer.byteLength(chunk.ownerKey, 'utf8') +
          (chunk.confirmedToolCallId ? Buffer.byteLength(chunk.confirmedToolCallId, 'utf8') : 0) +
          48
        planBufferBytes += chunk.bytes.byteLength
      }
    }
    for (const buf of this.confirmedPlanChunks) {
      planBufferBytes += buf.byteLength
    }
    const extraPlanBytes = this.planConversionWorkspaceBytes + this.pendingTransferredPlanBytes
    return {
      metadataBytes,
      planBufferBytes,
      extraPlanBytes,
      totalBytes: metadataBytes + planBufferBytes + extraPlanBytes,
    }
  }

  private tryAdmitBytes(
    nextMetadataBytes: number,
    nextPlanBufferBytes: number,
    nextExtraPlanBytes = this.planConversionWorkspaceBytes + this.pendingTransferredPlanBytes,
  ): boolean {
    if (
      nextMetadataBytes > AGY_MCP_MAX_CORRELATION_BYTES ||
      nextPlanBufferBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
    ) {
      return false
    }
    const nextTotal = nextMetadataBytes + nextPlanBufferBytes + nextExtraPlanBytes
    if (this.reserveCorrelationBytes && !this.reserveCorrelationBytes(nextTotal)) {
      return false
    }
    return true
  }

  private syncReservationAfterShrink(): void {
    const { totalBytes } = this.computeCorrelationHeldBytes()
    this.reserveCorrelationBytes?.(totalBytes)
  }

  beginWakeBatch(): void {
    this.wakeBatchDepth += 1
  }

  endWakeBatch(): void {
    if (this.wakeBatchDepth > 0) {
      this.wakeBatchDepth -= 1
    }
    if (this.wakeBatchDepth === 0 && this.wakePending) {
      this.wakePending = false
      this.wakeAllWaiters()
    }
  }

  private wakeAllWaiters(): void {
    if (this.wakeBatchDepth > 0) {
      this.wakePending = true
      return
    }
    for (const wake of Array.from(this.activeCallWaiters)) {
      wake()
    }
  }

  private invalidateToken(canonicalToken: string): void {
    const prev = this.tokenLedger.get(canonicalToken)
    if (prev?.kind === 'claimed') {
      const prevOwner = prev.ownerKey
      this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      this.revokeOwner(prevOwner)
    } else if (prev?.kind === 'in_flight_http') {
      this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      this.provisionalTokenOwners.delete(canonicalToken)
      this.syncReservationAfterShrink()
    } else if (prev?.kind === 'non_mcp' || prev?.kind === 'consumed') {
      this.provisionalTokenOwners.delete(canonicalToken)
      this.syncReservationAfterShrink()
    } else {
      if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
        this.tokenCapacityExhausted = true
      } else {
        const current = this.computeCorrelationHeldBytes()
        const delta = Buffer.byteLength(canonicalToken, 'utf8') + 32
        if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
          this.tokenCapacityExhausted = true
        } else {
          this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
        }
      }
    }
    for (const entry of Array.from(this.activeAcpToolCalls.values())) {
      if (
        entry.explicitProgressToken === canonicalToken ||
        entry.correlatedProgressToken === canonicalToken
      ) {
        this.retireCallId(entry.toolCallId)
      }
    }
  }

  private markExplicitTokenConsumed(canonicalToken: string): void {
    const prev = this.tokenLedger.get(canonicalToken)
    if (prev !== undefined) {
      if (prev.kind === 'in_flight_http') {
        this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      }
      return
    }
    if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
      this.tokenCapacityExhausted = true
      return
    }
    const current = this.computeCorrelationHeldBytes()
    const delta = Buffer.byteLength(canonicalToken, 'utf8') + 32
    if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
      this.tokenCapacityExhausted = true
      return
    }
    this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
  }

  private retireCallId(toolCallId: string): void {
    const digest = hashCallIdDigest(toolCallId)
    const existing = this.activeAcpToolCalls.get(toolCallId)
    if (existing) {
      const explicitPt = existing.explicitProgressToken
      const retiredToolName = existing.toolName
      this.cancelStagedOwner(`call:${toolCallId}`)
      this.activeAcpToolCalls.delete(toolCallId)
      if (!this.retiredCallIdDigests.has(digest)) {
        if (this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES) {
          this.correlatorCapacityExhausted = true
          this.tokenlessCorrelationCompromised = true
        } else {
          // Deleting `existing` freed >= AGY_MCP_TERMINAL_STUB_BYTES + 1 (> tombstone bytes).
          this.retiredCallIdDigests.add(digest)
        }
      }
      this.syncReservationAfterShrink()
      if (explicitPt !== undefined) {
        this.markExplicitTokenConsumed(explicitPt)
      }
      this.recomputeProvisionalMigrationsForTool(retiredToolName)
      return
    }
    if (this.retiredCallIdDigests.has(digest)) {
      return
    }
    if (this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES) {
      this.correlatorCapacityExhausted = true
      this.tokenlessCorrelationCompromised = true
      return
    }
    const current = this.computeCorrelationHeldBytes()
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES,
        current.planBufferBytes,
      )
    ) {
      this.correlatorCapacityExhausted = true
      this.tokenlessCorrelationCompromised = true
      return
    }
    this.retiredCallIdDigests.add(digest)
  }

  private evictTerminalCallIfNeeded(): boolean {
    if (this.activeAcpToolCalls.size < AGY_MCP_MAX_ACTIVE_ACP_CALLS) return true
    for (const [key, candidate] of this.activeAcpToolCalls) {
      if (candidate.lifecycle === 'open') continue
      const ownerKey = `call:${candidate.toolCallId}`
      if (this.stagedOutcomes.has(ownerKey)) continue
      const digest = hashCallIdDigest(candidate.toolCallId)
      if (
        !this.retiredCallIdDigests.has(digest) &&
        this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES
      ) {
        this.correlatorCapacityExhausted = true
        this.tokenlessCorrelationCompromised = true
        return false
      }
      if (candidate.correlatedProgressToken !== undefined) {
        const ledger = this.tokenLedger.get(candidate.correlatedProgressToken)
        if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
          this.tokenLedger.set(candidate.correlatedProgressToken, { kind: 'consumed' })
        }
      }
      const explicitPt = candidate.explicitProgressToken
      this.activeAcpToolCalls.delete(key)
      this.retiredCallIdDigests.add(digest)
      this.syncReservationAfterShrink()
      if (explicitPt !== undefined) {
        this.markExplicitTokenConsumed(explicitPt)
      }
      return true
    }
    return false
  }

  private markClaimedTokenConsumedForOwner(ownerKey: string, knownToken?: string): void {
    if (knownToken !== undefined) {
      const ledger = this.tokenLedger.get(knownToken)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
        this.tokenLedger.set(knownToken, { kind: 'consumed' })
      }
      this.provisionalTokenOwners.delete(knownToken)
      return
    }
    if (ownerKey.startsWith('token:')) {
      const pt = ownerKey.slice('token:'.length)
      const ledger = this.tokenLedger.get(pt)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
        this.tokenLedger.set(pt, { kind: 'consumed' })
      }
      this.provisionalTokenOwners.delete(pt)
      return
    }
    if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      const call = this.activeAcpToolCalls.get(tcId)
      if (call?.correlatedProgressToken !== undefined) {
        const ledger = this.tokenLedger.get(call.correlatedProgressToken)
        if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
          this.tokenLedger.set(call.correlatedProgressToken, { kind: 'consumed' })
        }
      }
    }
  }

  private cancelStagedOwner(ownerKey: string): void {
    const staged = this.stagedOutcomes.get(ownerKey)
    this.stagedOutcomes.delete(ownerKey)
    if (this.pendingTitleOwner === ownerKey) {
      this.pendingTitleOwner = undefined
    }
    if (this.pendingPeerOwner === ownerKey) {
      this.pendingPeerOwner = undefined
    }
    this.markClaimedTokenConsumedForOwner(ownerKey, staged?.progressToken)
    const failedChunkIdx = this.pendingPlanChunks.findIndex(
      (chunk) => chunk.ownerKey === ownerKey && !chunk.invalidated,
    )
    if (failedChunkIdx >= 0) {
      const failedOffset = this.pendingPlanChunks[failedChunkIdx]!.offset
      let cancelledFinalChunk = false
      for (let i = this.pendingPlanChunks.length - 1; i >= 0; i -= 1) {
        const candidate = this.pendingPlanChunks[i]!
        if (candidate.ownerKey === ownerKey || candidate.offset >= failedOffset) {
          if (candidate.complete) {
            cancelledFinalChunk = true
          }
          candidate.invalidated = true
          const depStaged = this.stagedOutcomes.get(candidate.ownerKey)
          this.stagedOutcomes.delete(candidate.ownerKey)
          this.markClaimedTokenConsumedForOwner(candidate.ownerKey, depStaged?.progressToken)
          this.pendingPlanChunks.splice(i, 1)
        }
      }
      if (cancelledFinalChunk) {
        this.planConversionWorkspaceBytes = 0
      }
    }
    this.syncReservationAfterShrink()
  }

  private revokeOwner(ownerKey: string): void {
    if (ownerKey.startsWith('call:')) {
      this.retireCallId(ownerKey.slice('call:'.length))
      return
    }
    if (ownerKey.startsWith('token:')) {
      this.provisionalTokenOwners.delete(ownerKey.slice('token:'.length))
    }
    this.cancelStagedOwner(ownerKey)
  }

  private migrateProvisionalTokenOwner(
    canonicalPt: string,
    targetCall: ActiveAcpMcpCall,
  ): 'migrated' | 'rejected_capacity' | 'invalid_ledger' {
    const provisional = this.provisionalTokenOwners.get(canonicalPt)
    if (!provisional) return 'invalid_ledger'
    const oldOwnerKey = `token:${canonicalPt}`
    const newOwnerKey = `call:${targetCall.toolCallId}`
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind !== 'claimed' || ledger.ownerKey !== oldOwnerKey) {
      this.provisionalTokenOwners.delete(canonicalPt)
      this.syncReservationAfterShrink()
      return 'invalid_ledger'
    }

    const tokenBytes = Buffer.byteLength(canonicalPt, 'utf8')
    const oldOwnerBytes = Buffer.byteLength(oldOwnerKey, 'utf8')
    const newOwnerBytes = Buffer.byteLength(newOwnerKey, 'utf8')
    const ownerDiff = newOwnerBytes - oldOwnerBytes
    const matchingChunks = this.pendingPlanChunks.filter(
      (chunk) => !chunk.invalidated && chunk.ownerKey === oldOwnerKey,
    ).length
    const hasStaged = this.stagedOutcomes.has(oldOwnerKey)
    const metadataDelta =
      -(tokenBytes + provisional.httpFingerprint.approxBytes + 32) +
      (tokenBytes + 16 + provisional.httpFingerprint.approxBytes) +
      ownerDiff +
      (hasStaged ? ownerDiff : 0) +
      matchingChunks * ownerDiff

    const current = this.computeCorrelationHeldBytes()
    if (!this.tryAdmitBytes(current.metadataBytes + metadataDelta, current.planBufferBytes)) {
      this.revokeOwner(oldOwnerKey)
      this.retireCallId(targetCall.toolCallId)
      return 'rejected_capacity'
    }

    this.provisionalTokenOwners.delete(canonicalPt)
    targetCall.correlatedProgressToken = canonicalPt
    targetCall.claimedViaTokenless = targetCall.explicitProgressToken !== canonicalPt
    targetCall.claimedHttpArgsFingerprint = provisional.httpFingerprint
    this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey: newOwnerKey })

    const staged = this.stagedOutcomes.get(oldOwnerKey)
    if (staged) {
      this.stagedOutcomes.delete(oldOwnerKey)
      staged.ownerKey = newOwnerKey
      this.stagedOutcomes.set(newOwnerKey, staged)
    }
    if (this.pendingTitleOwner === oldOwnerKey) {
      this.pendingTitleOwner = newOwnerKey
    }
    if (this.pendingPeerOwner === oldOwnerKey) {
      this.pendingPeerOwner = newOwnerKey
    }
    for (const chunk of this.pendingPlanChunks) {
      if (chunk.ownerKey === oldOwnerKey) {
        chunk.ownerKey = newOwnerKey
      }
    }
    return 'migrated'
  }

  private recomputeProvisionalMigrationsForTool(toolName: string): void {
    if (this.provisionalTokenOwners.size === 0 || this.recomputingProvisionalDepth > 0) return
    this.recomputingProvisionalDepth += 1
    try {
      let progressed = true
      let iterations = 0
      while (progressed && this.provisionalTokenOwners.size > 0 && iterations < 16) {
        progressed = false
        iterations += 1
        for (const candidate of Array.from(this.activeAcpToolCalls.values())) {
          if (
            candidate.toolName !== toolName ||
            candidate.lifecycle !== 'open' ||
            candidate.correlatedProgressToken !== undefined
          ) {
            continue
          }
          const beforeToken = candidate.correlatedProgressToken
          this.tryMigrateProvisionalToOpenCall(candidate)
          if (candidate.correlatedProgressToken !== beforeToken) {
            progressed = true
          }
        }
      }
    } finally {
      this.recomputingProvisionalDepth -= 1
    }
  }

  private tryMigrateProvisionalToOpenCall(
    entry: ActiveAcpMcpCall,
  ): 'ok' | 'already_retired' | 'rejected_capacity' {
    if (
      entry.lifecycle !== 'open' ||
      entry.correlatedProgressToken !== undefined ||
      this.provisionalTokenOwners.size === 0
    ) {
      return 'ok'
    }
    if (entry.explicitProgressToken !== undefined) {
      const prov = this.provisionalTokenOwners.get(entry.explicitProgressToken)
      if (!prov) return 'ok'
      const conflict =
        prov.toolName !== entry.toolName ||
        !this.matchesCallRootEvidence(entry, entry.explicitProgressToken) ||
        (entry.argsFingerprint !== undefined &&
          compareArgsFingerprints(entry.argsFingerprint, prov.httpFingerprint) === 'mismatch')
      if (conflict) {
        this.revokeOwner(`token:${entry.explicitProgressToken}`)
        this.retireCallId(entry.toolCallId)
        return 'already_retired'
      }
      const migrated = this.migrateProvisionalTokenOwner(entry.explicitProgressToken, entry)
      return migrated === 'rejected_capacity' ? 'rejected_capacity' : 'ok'
    }
    if (
      this.tokenlessCorrelationCompromised ||
      this.correlatorCapacityExhausted ||
      this.tokenCapacityExhausted ||
      entry.argsFingerprint === undefined
    ) {
      return 'ok'
    }
    const compatibleProvisionals: string[] = []
    for (const [pt, prov] of this.provisionalTokenOwners) {
      if (prov.toolName !== entry.toolName) continue
      const ledger = this.tokenLedger.get(pt)
      if (ledger?.kind !== 'claimed' || ledger.ownerKey !== `token:${pt}`) continue
      if (!this.matchesCallRootEvidence(entry, pt)) continue
      const verdict = compareArgsFingerprints(entry.argsFingerprint, prov.httpFingerprint)
      if (verdict === 'exact' || verdict === 'subset') {
        compatibleProvisionals.push(pt)
      }
    }
    if (compatibleProvisionals.length === 1) {
      const pt = compatibleProvisionals[0]!
      const prov = this.provisionalTokenOwners.get(pt)
      if (!prov) return 'ok'
      let compatibleCalls = 0
      let missingArgsCount = 0
      for (const other of this.activeAcpToolCalls.values()) {
        if (
          other.toolName !== prov.toolName ||
          other.lifecycle !== 'open' ||
          other.correlatedProgressToken !== undefined
        ) {
          continue
        }
        if (!this.matchesCallRootEvidence(other, pt)) {
          continue
        }
        if (other.explicitProgressToken !== undefined) {
          if (other.explicitProgressToken === pt && other.toolCallId !== entry.toolCallId) {
            return 'ok'
          }
          if (other.explicitProgressToken !== pt) {
            continue
          }
        }
        const verdict = compareArgsFingerprints(other.argsFingerprint, prov.httpFingerprint)
        if (verdict === 'exact' || verdict === 'subset') {
          compatibleCalls += 1
        } else if (verdict === 'missing_acp_args') {
          missingArgsCount += 1
        }
      }
      if (compatibleCalls === 1 && missingArgsCount === 0) {
        const migrated = this.migrateProvisionalTokenOwner(pt, entry)
        return migrated === 'rejected_capacity' ? 'rejected_capacity' : 'ok'
      }
    }
    return 'ok'
  }

  observeNonMcpProgressToken(rawToken: unknown): void {
    if (this.closed) return
    const parsed = canonicalizeProgressToken(rawToken)
    if (!parsed) return
    const canonical = parsed.canonical
    const prev = this.tokenLedger.get(canonical)
    if (prev?.kind === 'claimed') {
      const prevOwner = prev.ownerKey
      this.tokenLedger.set(canonical, { kind: 'non_mcp' })
      this.revokeOwner(prevOwner)
    } else if (prev === undefined) {
      if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
        this.tokenCapacityExhausted = true
      } else {
        const current = this.computeCorrelationHeldBytes()
        const delta = Buffer.byteLength(canonical, 'utf8') + 32
        if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
          this.tokenCapacityExhausted = true
        } else {
          this.tokenLedger.set(canonical, { kind: 'non_mcp' })
        }
      }
    } else {
      this.tokenLedger.set(canonical, { kind: 'non_mcp' })
      this.syncReservationAfterShrink()
    }
    this.wakeAllWaiters()
  }

  observeNonPactCall(toolCallId: string | undefined, allCanonicalTokens: readonly string[]): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      for (const token of allCanonicalTokens) {
        this.observeNonMcpProgressToken(token)
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeDisputedTokens(
    toolCallId: string | undefined,
    allCanonicalTokens: readonly string[],
  ): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      for (const token of allCanonicalTokens) {
        const parsedPt = canonicalizeProgressToken(token)
        if (parsedPt) {
          this.invalidateToken(parsedPt.canonical)
        }
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeAcpToolCall(toolCallId?: string, rawProgressToken?: unknown): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      if (rawProgressToken !== undefined) {
        const parsedPt = canonicalizeProgressToken(rawProgressToken)
        if (parsedPt) {
          this.invalidateToken(parsedPt.canonical)
        }
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeIfKnownMcpCall(toolCallId: string, rawProgressToken?: unknown): void {
    if (this.closed) return
    if (
      toolCallId.length === 0 ||
      Buffer.byteLength(toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      return
    }
    if (!this.activeAcpToolCalls.has(toolCallId)) {
      return
    }
    this.revokeAcpToolCall(toolCallId, rawProgressToken)
  }

  observeAcpToolCall(entry: {
    toolCallId: string
    toolName: string
    status: string
    invalidStatus?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    invalidArgs?: boolean | undefined
    progressToken?: unknown
    disputedTokens?: readonly string[] | undefined
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
  }): AcpToolCallAdmissionResult {
    if (this.closed) return 'rejected_capacity'
    if (
      entry.toolCallId.length === 0 ||
      Buffer.byteLength(entry.toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      if (entry.disputedTokens && entry.disputedTokens.length > 0) {
        this.revokeDisputedTokens(undefined, entry.disputedTokens)
      }
      return 'already_retired'
    }

    const invalidateAllDisputed = (extraToken?: string): void => {
      if (extraToken !== undefined) {
        this.invalidateToken(extraToken)
      }
      if (entry.disputedTokens) {
        for (const disputed of entry.disputedTokens) {
          if (disputed !== extraToken) {
            this.invalidateToken(disputed)
          }
        }
      }
    }

    this.beginWakeBatch()
    try {
      const digest = hashCallIdDigest(entry.toolCallId)
      if (this.retiredCallIdDigests.has(digest)) {
        if (
          entry.rootEvidenceContradicted ||
          entry.invalidProgressToken ||
          entry.invalidArgs ||
          entry.invalidStatus
        ) {
          invalidateAllDisputed()
        }
        return 'already_retired'
      }

      const existing = this.activeAcpToolCalls.get(entry.toolCallId)
      // Terminal states (`completed | failed | revoked`) are strictly irreversible!
      if (existing && existing.lifecycle !== 'open') {
        return 'already_retired'
      }

      // S1-#4: Conflicting tool identity on an established MCP call immediately revokes it!
      if (existing && existing.toolName !== entry.toolName) {
        this.retireCallId(entry.toolCallId)
        const parsedPt =
          entry.progressToken !== undefined
            ? canonicalizeProgressToken(entry.progressToken)
            : undefined
        invalidateAllDisputed(parsedPt?.canonical)
        this.wakeAllWaiters()
        return 'already_retired'
      }

      let incomingCanonicalPt: string | undefined
      let parsedPt: CanonicalProgressToken | undefined
      let shouldRevoke =
        entry.invalidProgressToken === true ||
        entry.invalidStatus === true ||
        entry.invalidArgs === true ||
        entry.rootEvidenceContradicted === true
      let invalidateContestedToken = shouldRevoke
      if (entry.progressToken !== undefined) {
        parsedPt = canonicalizeProgressToken(entry.progressToken)
        if (!parsedPt) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else {
          incomingCanonicalPt = parsedPt.canonical
          if (parsedPt.structured?.hasLeadingZeros) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
        }
      }

      const normalizedStatus = normalizeAcpToolStatus(entry.status)
      if (!normalizedStatus) {
        shouldRevoke = true
        invalidateContestedToken = true
      }

      if (!this.validatesAgainstRootEvidence(entry.trajectoryId, entry.stepIdx, parsedPt)) {
        shouldRevoke = true
        invalidateContestedToken = true
      }

      // Monotonic trajectoryId and stepIdx retention & cross-frame consistency (even when tokenless!).
      const resolvedTrajectoryId =
        entry.trajectoryId ??
        (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros
          ? parsedPt.structured.trajectoryId
          : undefined)
      const resolvedStepIdx =
        entry.stepIdx ??
        (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros
          ? parsedPt.structured.stepIdx
          : undefined)
      if (
        existing?.trajectoryId !== undefined &&
        resolvedTrajectoryId !== undefined &&
        existing.trajectoryId !== resolvedTrajectoryId
      ) {
        shouldRevoke = true
        invalidateContestedToken = true
      }
      if (
        existing?.stepIdx !== undefined &&
        resolvedStepIdx !== undefined &&
        existing.stepIdx !== resolvedStepIdx
      ) {
        shouldRevoke = true
        invalidateContestedToken = true
      }
      const nextTrajectoryId = existing?.trajectoryId ?? resolvedTrajectoryId
      const nextStepIdx = existing?.stepIdx ?? resolvedStepIdx
      if (existing?.correlatedProgressToken !== undefined) {
        const claimedPt = canonicalizeProgressToken(existing.correlatedProgressToken)
        if (claimedPt?.structured) {
          if (
            nextTrajectoryId !== undefined &&
            claimedPt.structured.trajectoryId !== nextTrajectoryId
          ) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
          if (nextStepIdx !== undefined && claimedPt.structured.stepIdx !== nextStepIdx) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
        }
      }

      if (!existing && this.correlatorCapacityExhausted) {
        this.tokenlessCorrelationCompromised = true
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      const nextLifecycle: AcpMcpCallLifecycle =
        normalizedStatus === 'completed'
          ? 'completed'
          : normalizedStatus === 'failed' || normalizedStatus === 'cancelled'
            ? 'failed'
            : 'open'

      // Monotonic per-key argsFingerprint merge (summary-only updates keep existing semantic keys!).
      let mergedFp: CompactArgsFingerprint | undefined = existing?.argsFingerprint
      if (entry.argsFingerprint !== undefined || entry.args !== undefined) {
        const incomingFp =
          entry.argsFingerprint ??
          (entry.args !== undefined ? buildCompactArgsFingerprint(entry.args, true) : undefined)
        if (!incomingFp) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else {
          const merged = mergeArgsFingerprints(existing?.argsFingerprint, incomingFp)
          if (merged.kind === 'conflict') {
            shouldRevoke = true
            invalidateContestedToken = true
          } else {
            mergedFp = merged.fingerprint
            if (
              existing?.claimedHttpArgsFingerprint !== undefined &&
              mergedFp !== undefined &&
              compareArgsFingerprints(mergedFp, existing.claimedHttpArgsFingerprint) === 'mismatch'
            ) {
              shouldRevoke = true
              invalidateContestedToken = true
            }
          }
        }
      }

      let explicitToken = existing?.explicitProgressToken
      const conflictingCallsToRetire: string[] = []
      if (incomingCanonicalPt !== undefined) {
        const conflictingCalls = [...this.activeAcpToolCalls.values()].filter(
          (other) =>
            other.toolCallId !== entry.toolCallId &&
            (other.explicitProgressToken === incomingCanonicalPt ||
              other.correlatedProgressToken === incomingCanonicalPt),
        )
        if (conflictingCalls.length > 0) {
          shouldRevoke = true
          invalidateContestedToken = true
          for (const other of conflictingCalls) {
            conflictingCallsToRetire.push(other.toolCallId)
          }
        }
        if (this.tokenLedger.get(incomingCanonicalPt)?.kind === 'non_mcp') {
          shouldRevoke = true
        } else if (
          existing?.correlatedProgressToken !== undefined &&
          existing.correlatedProgressToken !== incomingCanonicalPt
        ) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else if (explicitToken === undefined) {
          if (conflictingCalls.length === 0 && !shouldRevoke) {
            explicitToken = incomingCanonicalPt
          }
        } else if (explicitToken !== incomingCanonicalPt) {
          shouldRevoke = true
          invalidateContestedToken = true
        }
      }

      if (shouldRevoke) {
        for (const otherId of conflictingCallsToRetire) {
          this.retireCallId(otherId)
        }
        this.retireCallId(entry.toolCallId)
        if (invalidateContestedToken) {
          invalidateAllDisputed(incomingCanonicalPt)
        }
        this.wakeAllWaiters()
        return 'already_retired'
      }

      if (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros) {
        this.pinRootTrajectoryId(parsedPt.structured.trajectoryId)
      }

      if (!existing && !this.evictTerminalCallIfNeeded()) {
        this.tokenlessCorrelationCompromised = true
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      const isTerminal = nextLifecycle !== 'open'
      // Before committing a `completed` terminal on an unclaimed open call, discharge any unique
      // surviving provisional match onto this call using its monotonically merged evidence!
      if (
        nextLifecycle === 'completed' &&
        existing !== undefined &&
        existing.lifecycle === 'open' &&
        existing.correlatedProgressToken === undefined &&
        this.provisionalTokenOwners.size > 0
      ) {
        existing.trajectoryId = nextTrajectoryId
        existing.stepIdx = nextStepIdx
        existing.explicitProgressToken = explicitToken
        existing.argsFingerprint = mergedFp
        const preTermMigration = this.tryMigrateProvisionalToOpenCall(existing)
        if (preTermMigration !== 'ok') {
          this.wakeAllWaiters()
          return preTermMigration
        }
      }

      const candidate: ActiveAcpMcpCall = {
        toolCallId: entry.toolCallId,
        toolName: existing?.toolName ?? entry.toolName,
        lifecycle: nextLifecycle,
        sawPreTerminal: (existing?.sawPreTerminal ?? false) || !isTerminal,
        ...(nextTrajectoryId !== undefined ? { trajectoryId: nextTrajectoryId } : {}),
        ...(nextStepIdx !== undefined ? { stepIdx: nextStepIdx } : {}),
        argsFingerprint: !isTerminal ? mergedFp : undefined,
        explicitProgressToken: explicitToken,
        correlatedProgressToken: existing?.correlatedProgressToken,
        ...(existing?.claimedViaTokenless !== undefined
          ? { claimedViaTokenless: existing.claimedViaTokenless }
          : {}),
        claimedHttpArgsFingerprint: !isTerminal ? existing?.claimedHttpArgsFingerprint : undefined,
      }

      const current = this.computeCorrelationHeldBytes()
      const oldEntryBytes = existing ? this.computeAcpCallBytes(existing) : 0
      const newEntryBytes = this.computeAcpCallBytes(candidate)
      const nextMetadataBytes = current.metadataBytes - oldEntryBytes + newEntryBytes
      if (!this.tryAdmitBytes(nextMetadataBytes, current.planBufferBytes)) {
        this.tokenlessCorrelationCompromised = true
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      this.activeAcpToolCalls.set(entry.toolCallId, candidate)
      let admissionResult: AcpToolCallAdmissionResult = 'admitted'
      if (nextLifecycle === 'failed') {
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        admissionResult = 'already_retired'
      } else if (nextLifecycle === 'open') {
        const migration = this.tryMigrateProvisionalToOpenCall(candidate)
        if (migration !== 'ok') {
          admissionResult = migration
        }
        this.recomputeProvisionalMigrationsForTool(candidate.toolName)
      }

      this.wakeAllWaiters()
      return admissionResult
    } finally {
      this.endWakeBatch()
    }
  }

  beginInFlightToken(
    canonicalPt: string,
    httpFingerprint: CompactArgsFingerprint,
  ): { ok: true } | { ok: false; error: string } {
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const existing = this.tokenLedger.get(canonicalPt)
    if (existing?.kind === 'non_mcp') {
      return {
        ok: false,
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (existing !== undefined) {
      return {
        ok: false,
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }
    if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
      this.tokenCapacityExhausted = true
      this.wakeAllWaiters()
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const inFlightBytes = httpFingerprint.approxBytes + 64
    const ledgerBytes = Buffer.byteLength(canonicalPt, 'utf8') + 32
    const current = this.computeCorrelationHeldBytes()
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + ledgerBytes + inFlightBytes,
        current.planBufferBytes,
      )
    ) {
      return {
        ok: false,
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }
    this.tokenLedger.set(canonicalPt, { kind: 'in_flight_http' })
    this.inFlightHttpFingerprints.set(canonicalPt, inFlightBytes)
    return { ok: true }
  }

  releaseInFlightToken(canonicalPt: string): void {
    let changed = this.inFlightHttpFingerprints.delete(canonicalPt)
    const existing = this.tokenLedger.get(canonicalPt)
    if (existing?.kind === 'in_flight_http') {
      this.tokenLedger.delete(canonicalPt)
      changed = true
    }
    if (changed) {
      this.syncReservationAfterShrink()
    }
  }

  private findExplicitEntryForToken(canonicalPt: string): ActiveAcpMcpCall | undefined {
    for (const entry of this.activeAcpToolCalls.values()) {
      if (entry.explicitProgressToken === canonicalPt) return entry
    }
    return undefined
  }

  private tryClaimForHttp(
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    canonicalPt: string,
    allowExplicitMissingArgs: boolean,
    checkRootProof: () => RootProofCheckResult,
  ): HttpClaimAttempt {
    if (this.closed || this.revoked) {
      return { kind: 'reject', error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind === 'non_mcp') {
      return {
        kind: 'reject',
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (ledger?.kind !== 'in_flight_http') {
      return {
        kind: 'reject',
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }
    const rootProof = checkRootProof()
    if (rootProof !== 'ok') {
      return rootProof === 'wait' ? { kind: 'wait' } : rootProof
    }

    const explicitEntry = this.findExplicitEntryForToken(canonicalPt)
    if (explicitEntry !== undefined) {
      if (
        explicitEntry.lifecycle !== 'open' ||
        explicitEntry.toolName !== toolName ||
        explicitEntry.correlatedProgressToken !== undefined ||
        !this.matchesCallRootEvidence(explicitEntry, canonicalPt)
      ) {
        return {
          kind: 'reject',
          error: 'Antigravity MCP explicit progressToken does not match an active call.',
        }
      }
      const verdict = compareArgsFingerprints(explicitEntry.argsFingerprint, httpFingerprint)
      if (verdict === 'mismatch') {
        return {
          kind: 'reject',
          error: 'Antigravity MCP arguments conflict with the ACP-authorized tool call.',
        }
      }
      if (verdict === 'missing_acp_args') {
        if (!allowExplicitMissingArgs || toolName === 'read_collaboration_source') {
          return { kind: 'wait' }
        }
      }
      return this.commitCallClaim(explicitEntry, canonicalPt, httpFingerprint)
    }

    if (this.tokenlessCorrelationCompromised) {
      return {
        kind: 'reject',
        error:
          'Antigravity MCP tokenless call correlation is unavailable after capacity saturation.',
      }
    }

    const unclaimed = [...this.activeAcpToolCalls.values()].filter(
      (entry) =>
        entry.toolName === toolName &&
        entry.lifecycle === 'open' &&
        entry.correlatedProgressToken === undefined &&
        (entry.explicitProgressToken === undefined ||
          entry.explicitProgressToken === canonicalPt) &&
        this.matchesCallRootEvidence(entry, canonicalPt),
    )
    if (unclaimed.length === 0) return { kind: 'wait' }

    const exactMatches: ActiveAcpMcpCall[] = []
    const subsetMatches: ActiveAcpMcpCall[] = []
    let missingArgsCount = 0
    for (const entry of unclaimed) {
      const verdict = compareArgsFingerprints(entry.argsFingerprint, httpFingerprint)
      if (verdict === 'exact') {
        exactMatches.push(entry)
      } else if (verdict === 'subset') {
        subsetMatches.push(entry)
      } else if (verdict === 'missing_acp_args') {
        missingArgsCount += 1
      }
    }

    const compatible = [...exactMatches, ...subsetMatches]
    if (compatible.length > 1) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP call matches multiple ambiguous ACP root tool calls.',
      }
    }
    if (missingArgsCount > 0 || compatible.length !== 1) {
      return { kind: 'wait' }
    }
    return this.commitCallClaim(compatible[0]!, canonicalPt, httpFingerprint)
  }

  private commitCallClaim(
    chosen: ActiveAcpMcpCall,
    canonicalPt: string,
    httpFingerprint: CompactArgsFingerprint,
  ): HttpClaimAttempt {
    const ownerKey = `call:${chosen.toolCallId}`
    const releasedInFlight = this.inFlightHttpFingerprints.get(canonicalPt) ?? 0
    const deltaMetadata =
      -releasedInFlight +
      Buffer.byteLength(canonicalPt, 'utf8') +
      16 +
      httpFingerprint.approxBytes +
      Buffer.byteLength(ownerKey, 'utf8') +
      16
    const current = this.computeCorrelationHeldBytes()
    if (!this.tryAdmitBytes(current.metadataBytes + deltaMetadata, current.planBufferBytes)) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }
    this.inFlightHttpFingerprints.delete(canonicalPt)
    chosen.correlatedProgressToken = canonicalPt
    chosen.claimedViaTokenless = chosen.explicitProgressToken !== canonicalPt
    chosen.claimedHttpArgsFingerprint = httpFingerprint
    this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey })
    return { kind: 'claimed', ownerKey }
  }

  private hasBlockingPreTerminalCall(toolName: string): boolean {
    for (const entry of this.activeAcpToolCalls.values()) {
      if (
        entry.sawPreTerminal &&
        entry.lifecycle === 'open' &&
        entry.correlatedProgressToken === undefined &&
        (entry.explicitProgressToken === undefined || entry.toolName === toolName)
      ) {
        return true
      }
    }
    return false
  }

  async claimOrWaitForHttp(
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    canonicalPt: string,
    isCurrent: () => boolean,
    checkRootProof: () => RootProofCheckResult,
    timeoutMs = AGY_MCP_CORRELATION_WAIT_MS,
  ): Promise<{ ok: true; ownerKey: string } | { ok: false; error: string }> {
    const immediate = this.tryClaimForHttp(
      toolName,
      httpFingerprint,
      canonicalPt,
      false,
      checkRootProof,
    )
    if (immediate.kind === 'claimed') {
      return { ok: true, ownerKey: immediate.ownerKey }
    }
    if (immediate.kind === 'reject') {
      return { ok: false, error: immediate.error }
    }
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }

    const waitOutcome = await new Promise<HttpClaimAttempt>((resolveWait) => {
      let settled = false
      const cleanup = (timer: ReturnType<typeof setTimeout>): void => {
        clearTimeout(timer)
        this.activeCallWaiters.delete(onSignal)
      }
      const finish = (outcome: HttpClaimAttempt, timer: ReturnType<typeof setTimeout>): void => {
        if (settled) return
        settled = true
        cleanup(timer)
        resolveWait(outcome)
      }
      const timer = setTimeout(
        () => {
          if (this.closed || this.revoked || !isCurrent()) {
            finish(
              {
                kind: 'reject',
                error: 'This Pact tool capability belongs to a retired root turn.',
              },
              timer,
            )
            return
          }
          const finalCheck = this.tryClaimForHttp(
            toolName,
            httpFingerprint,
            canonicalPt,
            toolName !== 'read_collaboration_source',
            checkRootProof,
          )
          finish(finalCheck, timer)
        },
        Math.max(0, timeoutMs),
      )
      const onSignal = (): void => {
        if (this.closed || this.revoked || !isCurrent()) {
          finish(
            { kind: 'reject', error: 'This Pact tool capability belongs to a retired root turn.' },
            timer,
          )
          return
        }
        const check = this.tryClaimForHttp(
          toolName,
          httpFingerprint,
          canonicalPt,
          false,
          checkRootProof,
        )
        if (check.kind === 'claimed' || check.kind === 'reject') {
          finish(check, timer)
        }
      }
      this.activeCallWaiters.add(onSignal)
    })

    if (waitOutcome.kind === 'claimed') {
      return { ok: true, ownerKey: waitOutcome.ownerKey }
    }
    if (waitOutcome.kind === 'reject') {
      return { ok: false, error: waitOutcome.error }
    }
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }

    // Re-check terminal token dispositions & capacity BEFORE missing positive root proof.
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind === 'non_mcp') {
      return {
        ok: false,
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (ledger?.kind !== 'in_flight_http') {
      return {
        ok: false,
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }

    const finalRootProof = checkRootProof()
    if (finalRootProof !== 'ok') {
      return {
        ok: false,
        error:
          finalRootProof === 'wait'
            ? 'Antigravity MCP progressToken does not match an ACP-authenticated root trajectory or step boundary.'
            : finalRootProof.error,
      }
    }

    // Only ACP-pinned non-source tools with no blocking pre-terminal ACP call may stage provisionally
    // as `token:<canonicalPt>`, and they atomically migrate to `call:<id>` if a late `in_progress` arrives.
    if (
      this.trajectoryIdSource === 'acp' &&
      toolName !== 'read_collaboration_source' &&
      !this.tokenlessCorrelationCompromised &&
      !this.hasBlockingPreTerminalCall(toolName)
    ) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const releasedInFlight = this.inFlightHttpFingerprints.get(canonicalPt) ?? 0
      const deltaMetadata =
        -releasedInFlight +
        Buffer.byteLength(canonicalPt, 'utf8') +
        httpFingerprint.approxBytes +
        32 +
        Buffer.byteLength(tokenOwnerKey, 'utf8') +
        16
      const current = this.computeCorrelationHeldBytes()
      if (!this.tryAdmitBytes(current.metadataBytes + deltaMetadata, current.planBufferBytes)) {
        return {
          ok: false,
          error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
        }
      }
      this.inFlightHttpFingerprints.delete(canonicalPt)
      this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey: tokenOwnerKey })
      this.provisionalTokenOwners.set(canonicalPt, { toolName, httpFingerprint })
      return { ok: true, ownerKey: tokenOwnerKey }
    }

    return {
      ok: false,
      error: 'Antigravity MCP call does not match an active ACP-authenticated root tool call.',
    }
  }

  revalidateLiveClaim(
    canonicalToken: string,
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    isCurrent: () => boolean,
  ): { ok: true; ownerKey: string } | { ok: false; error: string } {
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (this.correlatorCapacityExhausted || this.tokenCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalToken)
    if (ledger?.kind !== 'claimed') {
      return {
        ok: false,
        error: 'Antigravity MCP claim was revoked or superseded before execution.',
      }
    }
    const ownerKey = ledger.ownerKey
    if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      if (this.retiredCallIdDigests.has(hashCallIdDigest(tcId))) {
        return {
          ok: false,
          error: 'Antigravity MCP claim was revoked before execution.',
        }
      }
      const entry = this.activeAcpToolCalls.get(tcId)
      if (
        !entry ||
        entry.lifecycle !== 'open' ||
        entry.toolName !== toolName ||
        entry.correlatedProgressToken !== canonicalToken ||
        !this.matchesCallRootEvidence(entry, canonicalToken) ||
        (entry.explicitProgressToken !== undefined &&
          entry.explicitProgressToken !== canonicalToken) ||
        (entry.explicitProgressToken === undefined && this.tokenlessCorrelationCompromised) ||
        entry.claimedHttpArgsFingerprint?.fullDigest !== httpFingerprint.fullDigest ||
        (entry.argsFingerprint !== undefined &&
          compareArgsFingerprints(entry.argsFingerprint, httpFingerprint) === 'mismatch')
      ) {
        return {
          ok: false,
          error: 'Antigravity MCP claim is no longer valid for this active tool call.',
        }
      }
      return { ok: true, ownerKey }
    }
    if (ownerKey === `token:${canonicalToken}`) {
      const prov = this.provisionalTokenOwners.get(canonicalToken)
      if (
        !prov ||
        prov.toolName !== toolName ||
        prov.httpFingerprint.fullDigest !== httpFingerprint.fullDigest ||
        this.trajectoryIdSource !== 'acp' ||
        this.tokenlessCorrelationCompromised ||
        toolName === 'read_collaboration_source'
      ) {
        return {
          ok: false,
          error: 'Antigravity MCP provisional claim is no longer valid.',
        }
      }
      return { ok: true, ownerKey }
    }
    return {
      ok: false,
      error: 'Antigravity MCP claim owner is invalid.',
    }
  }

  consumeRejectedClaim(canonicalToken: string): void {
    const ledger = this.tokenLedger.get(canonicalToken)
    if (ledger?.kind !== 'claimed') return
    const ownerKey = ledger.ownerKey
    if (this.stagedOutcomes.has(ownerKey)) return
    this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
    if (ownerKey === `token:${canonicalToken}`) {
      this.provisionalTokenOwners.delete(canonicalToken)
    } else if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      const call = this.activeAcpToolCalls.get(tcId)
      if (call?.correlatedProgressToken === canonicalToken) {
        this.retireCallId(tcId)
      }
    }
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  stageOutcome(
    auth: { progressToken: string; httpFingerprint: CompactArgsFingerprint },
    toolName: string,
    kind: StagedMcpOutcomeKind,
    isCurrent: () => boolean,
    planChunk?: { offset: number; bytes: Buffer; hasNonWhitespace: boolean; complete: boolean },
  ): { ok: true; ownerKey: string } | { ok: false; error: string } {
    const live = this.revalidateLiveClaim(
      auth.progressToken,
      toolName,
      auth.httpFingerprint,
      isCurrent,
    )
    if (!live.ok) {
      return live
    }
    const ownerKey = live.ownerKey
    if (
      this.stagedOutcomes.size >= 64 ||
      this.stagedOutcomes.has(ownerKey) ||
      (planChunk && this.pendingPlanChunks.length >= 64)
    ) {
      return { ok: false, error: 'Too many pending Pact MCP outcomes in this turn.' }
    }
    if (kind.type === 'title' && this.isTitleSlotTaken) {
      return { ok: false, error: 'A session title was already submitted in this turn.' }
    }
    if (kind.type === 'peer' && this.isPeerSlotTaken) {
      return { ok: false, error: 'This answer already has a peer request.' }
    }
    if (kind.type === 'publish_plan_chunk' && this.isOpenPlanFinalizedOrPendingFinal) {
      return { ok: false, error: 'A published Plan has already been finalized in this root turn.' }
    }

    const payloadBytes = estimateStagedOutcomePayloadBytes(kind)
    const stagedMetaBytes =
      Buffer.byteLength(ownerKey, 'utf8') +
      Buffer.byteLength(auth.progressToken, 'utf8') +
      auth.httpFingerprint.approxBytes +
      payloadBytes +
      32
    const chunkMetaBytes = planChunk ? Buffer.byteLength(ownerKey, 'utf8') + 48 : 0
    const chunkBufBytes = planChunk ? planChunk.bytes.byteLength : 0
    const current = this.computeCorrelationHeldBytes()
    const nextPlanBufferBytes = current.planBufferBytes + chunkBufBytes
    const nextConversionWorkspaceBytes = planChunk?.complete
      ? computePlanConversionWorkspaceBytes(nextPlanBufferBytes)
      : this.planConversionWorkspaceBytes
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + stagedMetaBytes + chunkMetaBytes,
        nextPlanBufferBytes,
        nextConversionWorkspaceBytes + this.pendingTransferredPlanBytes,
      )
    ) {
      return {
        ok: false,
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }

    const record: StagedMcpOutcomeRecord = {
      ownerKey,
      progressToken: auth.progressToken,
      httpFingerprint: auth.httpFingerprint,
      kind,
      payloadBytes,
    }
    this.stagedOutcomes.set(ownerKey, record)
    if (planChunk) {
      if (planChunk.complete) {
        this.planConversionWorkspaceBytes = nextConversionWorkspaceBytes
        this.acknowledgedFinalOpenPlan = true
      }
      this.pendingPlanChunks.push({
        ownerKey,
        offset: planChunk.offset,
        bytes: planChunk.bytes,
        hasNonWhitespace: planChunk.hasNonWhitespace,
        complete: planChunk.complete,
        confirmed: false,
        invalidated: false,
      })
    }
    if (kind.type === 'title') {
      this.pendingTitleOwner = ownerKey
    } else if (kind.type === 'peer') {
      this.pendingPeerOwner = ownerKey
    }
    return { ok: true, ownerKey }
  }

  assembleCandidateOpenPlanMarkdown(finalOwnerKey: string): string | undefined {
    // Require EVERY preceding contributing chunk to be ACP-confirmed before accepting a durable
    // final intent so unconfirmed prefix bytes can never be promoted during cold recovery.
    const activePending = this.pendingPlanChunks.filter((chunk) => !chunk.invalidated)
    const finalChunk = activePending.find(
      (chunk) => chunk.ownerKey === finalOwnerKey && chunk.complete,
    )
    if (!finalChunk) return undefined
    if (
      activePending.some((chunk) => chunk !== finalChunk && !chunk.confirmed) ||
      finalChunk.offset !== this.confirmedPlanBytes
    ) {
      return undefined
    }
    const orderedParts: Buffer[] = [...this.confirmedPlanChunks, finalChunk.bytes]
    const totalBytes = this.confirmedPlanBytes + finalChunk.bytes.byteLength
    if (totalBytes <= 0 || totalBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
      return undefined
    }
    const markdown = Buffer.concat(orderedParts, totalBytes).toString('utf8')
    return markdown.trim().length > 0 ? markdown : undefined
  }

  rollbackFailedFinalOpenPlanIntent(ownerKey: string, canonicalToken: string): void {
    this.cancelStagedOwner(ownerKey)
    if (
      !this.openPlanFinalized &&
      !this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.complete)
    ) {
      this.acknowledgedFinalOpenPlan = false
    }
    this.consumeRejectedClaim(canonicalToken)
  }

  private resolvePromotableOwnerKey(info: {
    toolCallId: string
    toolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): string | undefined {
    if (this.revoked || this.closed || info.receivedAfterPromptReply) return undefined
    if (
      info.toolCallId.length === 0 ||
      Buffer.byteLength(info.toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      return undefined
    }
    if (this.retiredCallIdDigests.has(hashCallIdDigest(info.toolCallId))) {
      return undefined
    }
    if (this.correlatorCapacityExhausted || this.tokenCapacityExhausted) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    if (info.invalidProgressToken || info.rootEvidenceContradicted) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    let canonicalPt: string | undefined
    let parsedPt: CanonicalProgressToken | undefined
    if (info.progressToken !== undefined) {
      parsedPt = canonicalizeProgressToken(info.progressToken)
      if (!parsedPt || parsedPt.structured?.hasLeadingZeros) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      canonicalPt = parsedPt.canonical
    }
    if (!this.validatesAgainstRootEvidence(info.trajectoryId, info.stepIdx, parsedPt)) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    const entry = this.activeAcpToolCalls.get(info.toolCallId)
    // S1-#2: Require the current terminal transition to have been admitted into activeAcpToolCalls,
    // never already promoted, and strictly bound to the admitted toolName.
    if (
      !entry ||
      entry.lifecycle !== 'completed' ||
      entry.promoted === true ||
      entry.toolName !== info.toolName
    ) {
      return undefined
    }
    if (entry.correlatedProgressToken !== undefined) {
      const callOwnerKey = `call:${info.toolCallId}`
      const ledger = this.tokenLedger.get(entry.correlatedProgressToken)
      if (ledger?.kind !== 'claimed' || ledger.ownerKey !== callOwnerKey) {
        return undefined
      }
      if (
        (entry.explicitProgressToken === undefined || entry.claimedViaTokenless) &&
        this.tokenlessCorrelationCompromised
      ) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      if (
        !this.matchesCallRootEvidence(entry, entry.correlatedProgressToken) ||
        (entry.explicitProgressToken !== undefined &&
          entry.explicitProgressToken !== entry.correlatedProgressToken) ||
        (canonicalPt !== undefined && canonicalPt !== entry.correlatedProgressToken)
      ) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      return callOwnerKey
    }
    if (
      !entry.sawPreTerminal &&
      canonicalPt !== undefined &&
      entry.explicitProgressToken === canonicalPt &&
      this.trajectoryIdSource === 'acp' &&
      !this.tokenlessCorrelationCompromised &&
      this.matchesCallRootEvidence(entry, canonicalPt)
    ) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const ledger = this.tokenLedger.get(canonicalPt)
      const prov = this.provisionalTokenOwners.get(canonicalPt)
      if (
        ledger?.kind === 'claimed' &&
        ledger.ownerKey === tokenOwnerKey &&
        prov !== undefined &&
        prov.toolName === entry.toolName
      ) {
        return tokenOwnerKey
      }
    }
    return undefined
  }

  promoteCompletedAcpToolCall(info: {
    toolCallId: string
    toolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): PromotedMcpOutcome | undefined {
    const ownerKey = this.resolvePromotableOwnerKey({
      toolCallId: info.toolCallId,
      toolName: info.toolName,
      progressToken: info.progressToken,
      invalidProgressToken: info.invalidProgressToken,
      trajectoryId: info.trajectoryId,
      stepIdx: info.stepIdx,
      rootEvidenceContradicted: info.rootEvidenceContradicted,
      receivedAfterPromptReply: info.receivedAfterPromptReply,
    })
    if (!ownerKey) return undefined
    const entry = this.activeAcpToolCalls.get(info.toolCallId)
    if (entry) {
      entry.promoted = true
    }
    const staged = this.stagedOutcomes.get(ownerKey)
    this.stagedOutcomes.delete(ownerKey)
    if (!staged) {
      this.markClaimedTokenConsumedForOwner(ownerKey)
      this.syncReservationAfterShrink()
      return undefined
    }

    if (info.argsFingerprint !== undefined || info.args !== undefined) {
      const incomingFp =
        info.argsFingerprint ??
        (info.args !== undefined ? buildCompactArgsFingerprint(info.args, true) : undefined)
      if (
        !incomingFp ||
        compareArgsFingerprints(incomingFp, staged.httpFingerprint) === 'mismatch'
      ) {
        this.cancelStagedOwner(ownerKey)
        return undefined
      }
    }

    this.markClaimedTokenConsumedForOwner(ownerKey, staged.progressToken)
    const kind = staged.kind
    let promoted: PromotedMcpOutcome | undefined
    if (kind.type === 'title') {
      if (this.pendingTitleOwner === ownerKey) this.pendingTitleOwner = undefined
      if (!this.titleConfirmed && info.toolName === 'publish_session_title') {
        this.titleConfirmed = true
        promoted = kind
      }
    } else if (kind.type === 'peer') {
      if (this.pendingPeerOwner === ownerKey) this.pendingPeerOwner = undefined
      if (!this.peerConfirmed && info.toolName === 'request_peer_assistance') {
        this.peerConfirmed = true
        promoted = kind
      }
    } else if (kind.type === 'review') {
      promoted = info.toolName === 'submit_review' ? kind : undefined
    } else if (kind.type === 'input_result') {
      promoted = info.toolName === 'submit_input_result' ? kind : undefined
    } else if (kind.type === 'retain_plan') {
      promoted = info.toolName === 'retain_current_plan' ? kind : undefined
    } else if (kind.type === 'publish_plan_chunk') {
      if (info.toolName === 'publish_plan') {
        const chunk = this.pendingPlanChunks.find((c) => c.ownerKey === ownerKey && !c.invalidated)
        if (chunk && chunk.offset === kind.offset) {
          if (chunk.complete) {
            const idBytes = Buffer.byteLength(info.toolCallId, 'utf8')
            const current = this.computeCorrelationHeldBytes()
            if (!this.tryAdmitBytes(current.metadataBytes + idBytes, current.planBufferBytes)) {
              this.cancelStagedOwner(ownerKey)
              this.openPlanFinalized = true
              this.syncReservationAfterShrink()
              return {
                type: 'publish_plan_failed',
                reason:
                  'Antigravity open plan metadata budget exceeded while confirming final chunk.',
              }
            }
            chunk.confirmedToolCallId = info.toolCallId
          }
          chunk.confirmed = true
          promoted = this.flushConfirmedPlanChunks()
        }
      }
    }
    this.syncReservationAfterShrink()
    return promoted
  }

  private flushConfirmedPlanChunks(): PromotedMcpOutcome | undefined {
    if (this.openPlanFinalized) return undefined
    while (this.pendingPlanChunks.length > 0) {
      const head = this.pendingPlanChunks[0]!
      if (head.invalidated || !head.confirmed || head.offset !== this.confirmedPlanBytes) {
        break
      }
      this.pendingPlanChunks.shift()
      this.confirmedPlanChunks.push(head.bytes)
      this.confirmedPlanBytes += head.bytes.byteLength
      if (head.hasNonWhitespace) {
        this.confirmedPlanHasNonWhitespace = true
      }
      if (head.complete) {
        const finalToolCallId = head.confirmedToolCallId
        if (!this.confirmedPlanHasNonWhitespace || !finalToolCallId) {
          this.confirmedPlanChunks.length = 0
          this.confirmedPlanBytes = 0
          this.confirmedPlanHasNonWhitespace = false
          this.planConversionWorkspaceBytes = 0
          this.openPlanFinalized = true
          this.syncReservationAfterShrink()
          return {
            type: 'publish_plan_failed',
            reason: 'Antigravity open plan finalization lacked non-empty confirmed content.',
          }
        }
        const workspaceBytes = computePlanConversionWorkspaceBytes(this.confirmedPlanBytes)
        if (workspaceBytes > this.planConversionWorkspaceBytes) {
          const current = this.computeCorrelationHeldBytes()
          if (
            !this.tryAdmitBytes(
              current.metadataBytes,
              current.planBufferBytes,
              workspaceBytes + this.pendingTransferredPlanBytes,
            )
          ) {
            this.confirmedPlanChunks.length = 0
            this.confirmedPlanBytes = 0
            this.confirmedPlanHasNonWhitespace = false
            this.planConversionWorkspaceBytes = 0
            this.openPlanFinalized = true
            this.syncReservationAfterShrink()
            return {
              type: 'publish_plan_failed',
              reason: 'Antigravity open plan conversion exceeded shared working-memory budget.',
            }
          }
          this.planConversionWorkspaceBytes = workspaceBytes
        }
        const markdown = Buffer.concat(this.confirmedPlanChunks, this.confirmedPlanBytes).toString(
          'utf8',
        )
        this.confirmedPlanChunks.length = 0
        this.confirmedPlanBytes = 0
        this.confirmedPlanHasNonWhitespace = false
        this.planConversionWorkspaceBytes = 0
        if (!markdown.trim()) {
          this.openPlanFinalized = true
          this.syncReservationAfterShrink()
          return {
            type: 'publish_plan_failed',
            reason: 'Antigravity open plan decoded to empty Markdown.',
          }
        }
        this.pendingTransferredPlanBytes = computeRetainedPlanTextBytes(markdown)
        this.syncReservationAfterShrink()
        this.openPlanFinalized = true
        return { type: 'publish_plan', markdown, finalToolCallId }
      }
    }
    return undefined
  }

  failAcpToolCall(info: { toolCallId: string; toolName: string; progressToken?: unknown }): void {
    this.retireCallId(info.toolCallId)
    const parsedPt =
      info.progressToken !== undefined ? canonicalizeProgressToken(info.progressToken) : undefined
    const canonicalPt = parsedPt?.canonical
    if (canonicalPt !== undefined) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const ledger = this.tokenLedger.get(canonicalPt)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === tokenOwnerKey) {
        this.cancelStagedOwner(tokenOwnerKey)
      }
    }
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  revokeRun(): void {
    this.revoked = true
    this.pendingTitleOwner = undefined
    this.pendingPeerOwner = undefined
    this.provisionalTokenOwners.clear()
    this.stagedOutcomes.clear()
    this.pendingPlanChunks.length = 0
    this.confirmedPlanHasNonWhitespace = false
    this.planConversionWorkspaceBytes = 0
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  close(): void {
    this.closed = true
    this.revoked = true
    this.wakeAllWaiters()
    this.activeCallWaiters.clear()
    this.activeAcpToolCalls.clear()
    this.retiredCallIdDigests.clear()
    this.tokenLedger.clear()
    this.inFlightHttpFingerprints.clear()
    this.provisionalTokenOwners.clear()
    this.stagedOutcomes.clear()
    this.pendingTitleOwner = undefined
    this.pendingPeerOwner = undefined
    this.pendingPlanChunks.length = 0
    this.confirmedPlanChunks.length = 0
    this.confirmedPlanBytes = 0
    this.confirmedPlanHasNonWhitespace = false
    this.planConversionWorkspaceBytes = 0
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
  }
}

interface AgyMcpServerConfig {
  runId: string
  getNativeSessionId: () => string | undefined
  getExecutorId: () => string
  getExecutionId?: () => string | undefined
  getRootStepIdx: () => number | undefined
  hasZeroTurnStepBoundary: () => boolean
  tryLoadHostTrajectoryId?: () => Promise<
    { readonly trajectoryId: string; readonly stepCount: number } | undefined
  >
  bindingGeneration: number
  isRootCurrent: () => boolean
  isSourceCurrent: () => boolean
  workflow: CollaborationTask | undefined
  authorization: CollaborationTurnAuthorization | undefined
  requestSessionTitle: boolean
  peerAssistanceAllowed: boolean
  peerTargetAgentId: Exclude<RuntimeAgentId, 'agy'> | undefined
  sourceGrant: { runId: string; grant: string } | undefined
  sourceReader: AgentCollaborationSourceReader | undefined
  legacySourceReader: ((input: unknown) => CollaborationSourceReadResult) | undefined
  isPlanRetentionCurrent: () => boolean
  recordOpenPlanFinalIntent?: ((intent: AgentOpenPlanFinalIntent) => boolean | void) | undefined
  reserveCorrelationBytes?: (nextBytes: number) => boolean
}

/**
 * Per-Run loopback Streamable HTTP MCP server enforcing Antigravity's four-tuple root verification:
 * 1. `_meta['antigravity.google/root_conversation_id'] === activeRoot.nativeSessionId` AND
 *    `_meta['antigravity.google/conversation_id'] === activeRoot.nativeSessionId`
 * 2. Valid monotonic one-shot `_meta.progressToken` strictly owned 1-to-1 by one root trajectory/step & call
 * 3. Active `(executorId, bindingGeneration, runId)` after root prompt start and before root settlement
 * 4. Exact owner-keyed `tool_call` completion in `session/update` with matching args before promoting state.
 */
class AgyRunMcpServer {
  readonly serverName: string
  private readonly token = randomUUID().replaceAll('-', '')
  private http: HttpServer | undefined
  private readonly activeSockets = new Set<NetSocket>()
  private httpClosed = false
  private activeRequests = 0
  private activeSourceReads = 0
  private readonly correlator: McpCallCorrelator
  readonly sourceCapability: AgentCollaborationSourceCapability
  readonly allowedToolNames = new Set<string>()

  constructor(private readonly config: AgyMcpServerConfig) {
    this.serverName = buildAgyPactMcpServerName(config.runId)
    this.correlator = new McpCallCorrelator(
      config.reserveCorrelationBytes,
      () => config.getRootStepIdx() ?? (config.hasZeroTurnStepBoundary() ? 0 : undefined),
    )
    this.sourceCapability = resolveAgentCollaborationSourceCapability({
      readCollaborationSourcePart: config.legacySourceReader,
      collaborationSourceReader: config.sourceReader,
    })
    if (this.sourceCapability.tier !== 'none') {
      this.allowedToolNames.add('read_collaboration_source')
    }
    if (config.requestSessionTitle) {
      this.allowedToolNames.add('publish_session_title')
    }
    if (config.peerAssistanceAllowed && !config.workflow) {
      this.allowedToolNames.add('request_peer_assistance')
    }
    if (collaborationReviewMode(config.workflow, config.authorization)) {
      this.allowedToolNames.add('submit_review')
    }
    if (collaborationInputResultAllowed(config.workflow, config.authorization)) {
      this.allowedToolNames.add('submit_input_result')
    }
    if (collaborationPlanRetentionAllowed(config.workflow, config.authorization)) {
      this.allowedToolNames.add('retain_current_plan')
    }
    if (
      collaborationOpenPlanPublishAllowed(config.workflow, config.authorization) &&
      typeof config.recordOpenPlanFinalIntent === 'function'
    ) {
      this.allowedToolNames.add('publish_plan')
    }
  }

  get hasTools(): boolean {
    return this.allowedToolNames.size > 0
  }

  get hasAcknowledgedFinalOpenPlan(): boolean {
    return this.correlator.hasAcknowledgedFinalOpenPlan
  }

  get pinnedTrajectory(): string | undefined {
    return this.correlator.pinnedTrajectory
  }

  get minStepIdx(): number | undefined {
    return (
      this.config.getRootStepIdx() ??
      this.correlator.minHostStepIdx ??
      (this.config.hasZeroTurnStepBoundary() ? 0 : undefined)
    )
  }

  isRootActive(): boolean {
    return !this.correlator.isClosed && !this.correlator.isRevoked && this.config.isRootCurrent()
  }

  disallowLazyStorageDbPin(): void {
    this.correlator.disallowLazyStorageDbPin()
  }

  beginWakeBatch(): void {
    this.correlator.beginWakeBatch()
  }

  endWakeBatch(): void {
    this.correlator.endWakeBatch()
  }

  notifyRootProofUpdated(): void {
    this.correlator.notifyRootProofUpdated()
  }

  clearPendingTransferredPlanBytes(): void {
    this.correlator.clearPendingTransferredPlanBytes()
  }

  revokeRun(): void {
    this.correlator.revokeRun()
  }

  observeNonMcpProgressToken(token: unknown): void {
    this.correlator.observeNonMcpProgressToken(token)
  }

  pinHostTrajectoryId(trajectoryId: string, stepCount?: number): void {
    this.correlator.pinHostTrajectoryId(trajectoryId, stepCount)
  }

  pinRootTrajectoryId(trajectoryId: string): void {
    this.correlator.pinRootTrajectoryId(trajectoryId)
  }

  lookupVerifiedCallToolName(toolCallId: string): string | undefined {
    const tool = this.correlator.lookupVerifiedCallToolName(toolCallId)
    return tool !== undefined ? `mcp_${this.serverName}_${tool}` : undefined
  }

  observeNonPactCall(toolCallId: string | undefined, allCanonicalTokens: readonly string[]): void {
    this.correlator.observeNonPactCall(toolCallId, allCanonicalTokens)
  }

  revokeDisputedTokens(
    toolCallId: string | undefined,
    allCanonicalTokens: readonly string[],
  ): void {
    this.correlator.revokeDisputedTokens(toolCallId, allCanonicalTokens)
  }

  revokeAcpToolCall(toolCallId?: string, rawProgressToken?: unknown): void {
    this.correlator.revokeAcpToolCall(toolCallId, rawProgressToken)
  }

  revokeIfKnownMcpCall(toolCallId: string, rawProgressToken?: unknown): void {
    this.correlator.revokeIfKnownMcpCall(toolCallId, rawProgressToken)
  }

  observeAcpToolCall(entry: {
    toolCallId: string
    rawToolName: string
    status: string
    invalidStatus?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    invalidArgs?: boolean | undefined
    progressToken?: unknown
    disputedTokens?: readonly string[] | undefined
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
  }): AcpToolCallAdmissionResult {
    const authorized = this.isAuthorizedMcpToolCallName(entry.rawToolName)
    if (!authorized) {
      const tokens: string[] = [...(entry.disputedTokens ?? [])]
      if (entry.progressToken !== undefined) {
        const parsed = canonicalizeProgressToken(entry.progressToken)
        if (parsed && !tokens.includes(parsed.canonical)) {
          tokens.push(parsed.canonical)
        }
      }
      this.correlator.observeNonPactCall(entry.toolCallId, tokens)
      return 'already_retired'
    }
    return this.correlator.observeAcpToolCall({
      toolCallId: entry.toolCallId,
      toolName: authorized.tool,
      status: entry.status,
      ...(entry.invalidStatus !== undefined ? { invalidStatus: entry.invalidStatus } : {}),
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      ...(entry.argsFingerprint !== undefined ? { argsFingerprint: entry.argsFingerprint } : {}),
      ...(entry.invalidArgs !== undefined ? { invalidArgs: entry.invalidArgs } : {}),
      ...(entry.progressToken !== undefined ? { progressToken: entry.progressToken } : {}),
      ...(entry.disputedTokens !== undefined ? { disputedTokens: entry.disputedTokens } : {}),
      ...(entry.invalidProgressToken !== undefined
        ? { invalidProgressToken: entry.invalidProgressToken }
        : {}),
      ...(entry.trajectoryId !== undefined ? { trajectoryId: entry.trajectoryId } : {}),
      ...(entry.stepIdx !== undefined ? { stepIdx: entry.stepIdx } : {}),
      ...(entry.rootEvidenceContradicted !== undefined
        ? { rootEvidenceContradicted: entry.rootEvidenceContradicted }
        : {}),
    })
  }

  promoteCompletedAcpToolCall(info: {
    toolCallId: string
    rawToolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): PromotedMcpOutcome | undefined {
    const authorized = this.isAuthorizedMcpToolCallName(info.rawToolName)
    if (!authorized) return undefined
    return this.correlator.promoteCompletedAcpToolCall({
      toolCallId: info.toolCallId,
      toolName: authorized.tool,
      ...(info.progressToken !== undefined ? { progressToken: info.progressToken } : {}),
      ...(info.invalidProgressToken !== undefined
        ? { invalidProgressToken: info.invalidProgressToken }
        : {}),
      ...(info.args !== undefined ? { args: info.args } : {}),
      ...(info.argsFingerprint !== undefined ? { argsFingerprint: info.argsFingerprint } : {}),
      ...(info.trajectoryId !== undefined ? { trajectoryId: info.trajectoryId } : {}),
      ...(info.stepIdx !== undefined ? { stepIdx: info.stepIdx } : {}),
      ...(info.rootEvidenceContradicted !== undefined
        ? { rootEvidenceContradicted: info.rootEvidenceContradicted }
        : {}),
      ...(info.receivedAfterPromptReply !== undefined
        ? { receivedAfterPromptReply: info.receivedAfterPromptReply }
        : {}),
    })
  }

  failAcpToolCall(info: {
    toolCallId: string
    rawToolName: string
    progressToken?: unknown
  }): void {
    const authorized = this.isAuthorizedMcpToolCallName(info.rawToolName)
    if (!authorized) return
    this.correlator.failAcpToolCall({
      toolCallId: info.toolCallId,
      toolName: authorized.tool,
      ...(info.progressToken !== undefined ? { progressToken: info.progressToken } : {}),
    })
  }

  private peerTargetEnum(): ReadonlyArray<Exclude<RuntimeAgentId, 'agy'>> {
    return this.config.peerTargetAgentId ? [this.config.peerTargetAgentId] : ['claude', 'codex']
  }

  formatToolUsageInstructions(): string {
    const contracts: string[] = []
    const prefix = `mcp_${this.serverName}_`
    if (this.allowedToolNames.has('read_collaboration_source')) {
      const legacyForm =
        '{ runId: uuid, grant: uuid, source: "document"|"batch"|"inputs"|"handoff_sources"|"cutoff", offset: integer, document?: object, batchId?: uuid, cutoffId?: uuid, part?: "catalog"|"message"|"comments"|"comment", messageId?: uuid, commentId?: uuid }'
      const sourceRefForm = '{ sourceReference: string, offset: integer }'
      const nativeRootForm =
        '{ context: "native-root-v1", source: "document"|"batch"|"root_batch"|"root_document"|"inputs"|"handoff_sources"|"cutoff", offset: integer, part?: "body"|"user_information"|"clarification_answer"|"comment"|"catalog"|"message"|"comments", ordinal?: integer, document?: object, batchId?: uuid, cutoffId?: uuid, messageId?: uuid, commentId?: uuid }'
      const supportedForms: string[] = []
      if (this.sourceCapability.sourceReference) supportedForms.push(sourceRefForm)
      if (this.sourceCapability.nativeRoot) supportedForms.push(nativeRootForm)
      if (this.sourceCapability.legacy) supportedForms.push(legacyForm)
      contracts.push(`${prefix}read_collaboration_source(${supportedForms.join(' | ')})`)
    }
    if (this.allowedToolNames.has('publish_session_title')) {
      contracts.push(`${prefix}publish_session_title({ title: string(1..120) })`)
    }
    if (this.allowedToolNames.has('request_peer_assistance')) {
      const targetUnion = this.peerTargetEnum()
        .map((target) => JSON.stringify(target))
        .join('|')
      contracts.push(
        `${prefix}request_peer_assistance({ target: ${targetUnion}, kind: "supplement"|"fact_check"|"challenge"|"review", reason? })`,
      )
    }
    if (this.allowedToolNames.has('submit_review')) {
      contracts.push(
        `${prefix}submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete", questions?: [{ prompt: string, selection: "single"|"multiple", options?: [{ label: string, description?: string }] }] })`,
      )
    }
    if (this.allowedToolNames.has('submit_input_result')) {
      contracts.push(
        `${prefix}submit_input_result({ outcome: "processed"|"needs_user"|"explanation_only", questions?: [{ prompt: string, selection: "single"|"multiple", options?: [{ label: string, description?: string }] }] })`,
      )
    }
    if (this.allowedToolNames.has('retain_current_plan')) {
      contracts.push(`${prefix}retain_current_plan({})`)
    }
    if (this.allowedToolNames.has('publish_plan')) {
      contracts.push(
        `${prefix}publish_plan({ text: string, offset?: integer, complete?: boolean })`,
      )
    }
    return `Registered Pact MCP tools on "${this.serverName}": ${contracts.join('; ')}. Call these MCP tools directly using the contracts above; never call read_file on <appDataDir>/mcp paths or run shell commands to inspect MCP directories.`
  }

  isAuthorizedMcpToolCallName(rawToolName: string): { tool: string } | undefined {
    const underscorePrefix = `mcp_${this.serverName}_`
    const slashPrefix = `${this.serverName}/`
    const doubleUnderscorePrefix = `mcp__${this.serverName}__`
    const suffix = rawToolName.startsWith(underscorePrefix)
      ? rawToolName.slice(underscorePrefix.length)
      : rawToolName.startsWith(doubleUnderscorePrefix)
        ? rawToolName.slice(doubleUnderscorePrefix.length)
        : rawToolName.startsWith(slashPrefix)
          ? rawToolName.slice(slashPrefix.length)
          : undefined
    if (!suffix || !this.allowedToolNames.has(suffix)) return undefined
    return { tool: suffix }
  }

  async start(): Promise<{ type: 'http'; name: string; url: string; headers: never[] }> {
    const server = createServer((req, res) => {
      this.handleHttp(req, res)
    })
    server.headersTimeout = AGY_MCP_HEADERS_TIMEOUT_MS
    server.requestTimeout = AGY_MCP_REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = 2_000
    server.on('connection', (socket) => {
      if (this.httpClosed || this.activeSockets.size >= AGY_MCP_MAX_CONCURRENT_SOCKETS) {
        socket.destroy()
        return
      }
      this.activeSockets.add(socket)
      socket.setTimeout(AGY_MCP_REQUEST_TIMEOUT_MS, () => {
        socket.destroy()
      })
      socket.once('close', () => {
        this.activeSockets.delete(socket)
      })
    })
    this.http = server
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Could not bind loopback Pact MCP server for Antigravity.',
        false,
      )
    }
    return {
      type: 'http',
      name: this.serverName,
      url: `http://127.0.0.1:${address.port}/${this.token}`,
      headers: [],
    }
  }

  async close(deadlineMs = AGY_MCP_CLOSE_TIMEOUT_MS): Promise<void> {
    this.httpClosed = true
    this.correlator.close()
    const server = this.http
    this.http = undefined
    if (!server) return
    server.closeIdleConnections?.()
    for (const socket of this.activeSockets) {
      socket.destroy()
    }
    this.activeSockets.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolveClose) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveClose()
      }
      const timer = setTimeout(
        () => {
          for (const socket of this.activeSockets) {
            socket.destroy()
          }
          this.activeSockets.clear()
          server.closeAllConnections?.()
          finish()
        },
        Math.max(50, deadlineMs),
      )
      timer.unref?.()
      server.close(() => finish())
    })
  }

  private handleHttp(request: import('node:http').IncomingMessage, response: ServerResponse): void {
    if (request.url !== `/${this.token}`) {
      response.writeHead(404).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const declaredBytes = Number(request.headers['content-length'] ?? 0)
    if (!Number.isFinite(declaredBytes) || declaredBytes > AGY_MCP_REQUEST_BYTES) {
      response.writeHead(413).end()
      return
    }
    if (this.activeRequests >= AGY_MCP_MAX_CONCURRENT_REQUESTS) {
      response.writeHead(429).end()
      return
    }
    this.activeRequests += 1
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
    const timeout = setTimeout(() => request.destroy(), AGY_MCP_REQUEST_TIMEOUT_MS)
    let processing = false
    request.once('close', () => {
      if (!processing && !request.complete) settle()
    })
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > AGY_MCP_REQUEST_BYTES) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      processing = true
      void (async () => {
        let rpc: McpJsonRpcRequest
        try {
          const decodedBody = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          )
          const parsed: unknown = JSON.parse(decodedBody)
          if (
            !isPlainObject(parsed) ||
            parsed.jsonrpc !== '2.0' ||
            typeof parsed.method !== 'string'
          ) {
            throw new Error('Invalid MCP request.')
          }
          const rawId = parsed.id
          let validId: string | number | undefined
          if ('id' in parsed) {
            if (typeof rawId !== 'string' && typeof rawId !== 'number') {
              throw new Error('Invalid MCP request ID.')
            }
            validId = rawId
          }
          rpc = {
            jsonrpc: '2.0',
            method: parsed.method,
            ...(validId !== undefined ? { id: validId } : {}),
            ...('params' in parsed ? { params: parsed.params } : {}),
          }
        } catch {
          this.replyJson(response, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32_700, message: 'Invalid MCP request.' },
          })
          settle()
          return
        }
        if (rpc.id === undefined) {
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(202).end()
          }
          settle()
          return
        }
        try {
          const result = await this.dispatchRpc(rpc)
          this.replyJson(response, { jsonrpc: '2.0', id: rpc.id, result })
        } catch (error) {
          this.replyJson(response, {
            jsonrpc: '2.0',
            id: rpc.id,
            error: {
              code: -32_602,
              message: safeNativePermissionText(
                error instanceof Error ? error.message : 'MCP tool invocation failed.',
                512,
              ),
            },
          })
        } finally {
          settle()
        }
      })()
    })
  }

  private replyJson(response: ServerResponse, body: object): void {
    if (response.destroyed || response.writableEnded) return
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.byteLength),
      })
      .end(payload)
  }

  private async dispatchRpc(rpc: McpJsonRpcRequest): Promise<object> {
    if (rpc.method === 'initialize') {
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: '1.0.0' },
        instructions: this.formatToolUsageInstructions(),
      }
    }
    if (rpc.method === 'ping') {
      return {}
    }
    if (rpc.method === 'tools/list') {
      return { tools: this.describeTools() }
    }
    if (rpc.method === 'tools/call') {
      return this.callTool(rpc.params)
    }
    throw new Error(`Unsupported MCP method: ${rpc.method}`)
  }

  private buildSourceToolInputSchema(): object {
    const cap = this.sourceCapability
    if (cap.nativeRoot && cap.sourceReference && cap.legacy) {
      return codexCollaborationSourceWireReadSchema.toJSONSchema()
    }
    if (!cap.nativeRoot && cap.sourceReference && cap.legacy) {
      return collaborationSourceWireReadSchema.toJSONSchema()
    }
    const sourceRefOnlySchema: Record<string, unknown> = {
      type: 'object',
      properties: {
        sourceReference: { type: 'string', minLength: 1, maxLength: 2048 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['sourceReference', 'offset'],
      additionalProperties: false,
    }
    if (cap.sourceReference && !cap.nativeRoot && !cap.legacy) {
      return sourceRefOnlySchema
    }
    if (cap.nativeRoot && !cap.sourceReference && !cap.legacy) {
      return collaborationSourceNativeReadSchema.toJSONSchema()
    }
    if (cap.legacy && !cap.sourceReference && !cap.nativeRoot) {
      return collaborationSourceAnyReadSchema.toJSONSchema()
    }
    const variants: object[] = []
    if (cap.sourceReference) variants.push(sourceRefOnlySchema)
    if (cap.nativeRoot) {
      const { $schema: _ignoredNativeSchema, ...nativeVariant } =
        collaborationSourceNativeReadSchema.toJSONSchema() as Record<string, unknown>
      variants.push(nativeVariant)
    }
    if (cap.legacy) {
      const { $schema: _ignoredLegacySchema, ...legacyVariant } =
        collaborationSourceAnyReadSchema.toJSONSchema() as Record<string, unknown>
      variants.push(legacyVariant)
    }
    return { anyOf: variants }
  }

  private describeTools(): object[] {
    const tools: object[] = []
    if (this.allowedToolNames.has('read_collaboration_source')) {
      const inputSchema = this.buildSourceToolInputSchema()
      tools.push({
        name: 'read_collaboration_source',
        description: buildCollaborationSourceToolDescription(this.sourceCapability),
        inputSchema,
      })
    }
    if (this.allowedToolNames.has('publish_session_title')) {
      tools.push({
        name: 'publish_session_title',
        description:
          'Supply a concise title during this same root Turn; never starts another model or edits the project.',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string', minLength: 1, maxLength: 120 } },
          required: ['title'],
          additionalProperties: false,
        },
      })
    }
    if (this.allowedToolNames.has('request_peer_assistance')) {
      const targetEnum = [...this.peerTargetEnum()]
      tools.push({
        name: 'request_peer_assistance',
        description: PEER_ASSISTANCE_TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: targetEnum },
            kind: {
              type: 'string',
              enum: ['supplement', 'fact_check', 'challenge', 'review'],
            },
            reason: { type: 'string', maxLength: 240 },
          },
          required: ['target', 'kind'],
          additionalProperties: false,
        },
      })
    }
    if (this.allowedToolNames.has('submit_review')) {
      tools.push({
        name: 'submit_review',
        description:
          'Submit the current independent review conclusion after writing its natural-language report. needs_user requires 1 to 3 explicit questions with selection ("single"|"multiple") and optional options ([{ label, description? }]); other verdicts must omit questions. Only the current root reviewer can submit; this never starts another turn or permits project edits.',
        inputSchema: collaborationReviewInputSchema.toJSONSchema(),
      })
    }
    if (this.allowedToolNames.has('submit_input_result')) {
      tools.push({
        name: 'submit_input_result',
        description: collaborationInputResultDescription,
        inputSchema: collaborationInputResultSchema.toJSONSchema(),
      })
    }
    if (this.allowedToolNames.has('retain_current_plan')) {
      tools.push({
        name: 'retain_current_plan',
        description:
          'Explicitly retain the existing frozen official plan when no plan text change is needed.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
    }
    if (this.allowedToolNames.has('publish_plan')) {
      tools.push({
        name: 'publish_plan',
        description:
          'Publish an updated Plan Markdown version in open collaboration mode (<= 48 KiB UTF-8 per chunk).',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            complete: { type: 'boolean' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      })
    }
    return tools
  }

  private async verifyFourTupleRoot(
    toolName: string,
    rawArgs: unknown,
    meta: unknown,
  ): Promise<
    | {
        ok: true
        nativeSessionId: string
        progressToken: string
        ownerKey: string
        httpFingerprint: CompactArgsFingerprint
      }
    | { ok: false; error: string }
  > {
    const expectedSessionId = this.config.getNativeSessionId()
    const executorId = this.config.getExecutorId()
    const isCurrent = (): boolean =>
      toolName === 'read_collaboration_source'
        ? this.config.isSourceCurrent()
        : this.config.isRootCurrent()
    if (
      this.correlator.isClosed ||
      this.correlator.isRevoked ||
      !isCurrent() ||
      !expectedSessionId ||
      !executorId ||
      this.config.bindingGeneration <= 0 ||
      !this.config.runId
    ) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (!isPlainObject(meta)) {
      return { ok: false, error: 'Missing Antigravity MCP _meta root authentication.' }
    }
    const rootConvId = asString(meta['antigravity.google/root_conversation_id'])
    const rawLegacyRootConvId = Object.hasOwn(meta, 'root_conversation_id')
      ? meta.root_conversation_id
      : undefined
    const agyConvId = asString(meta['antigravity.google/conversation_id'])
    const rawLegacyConvId = Object.hasOwn(meta, 'conversation_id')
      ? meta.conversation_id
      : undefined
    if (
      !rootConvId ||
      rootConvId !== expectedSessionId ||
      (rawLegacyRootConvId !== undefined && rawLegacyRootConvId !== expectedSessionId)
    ) {
      return {
        ok: false,
        error: 'The MCP call root_conversation_id does not match the active Antigravity session.',
      }
    }
    if (
      !agyConvId ||
      agyConvId !== expectedSessionId ||
      (rawLegacyConvId !== undefined && rawLegacyConvId !== expectedSessionId)
    ) {
      return {
        ok: false,
        error: 'Delegated subagent conversations cannot invoke root-scoped Pact tools.',
      }
    }
    const parsedPt = parseRootProgressToken(meta.progressToken)
    if (!parsedPt) {
      return {
        ok: false,
        error:
          'Missing or invalid structured <trajectoryId>:<stepIdx> Antigravity MCP progressToken.',
      }
    }
    const canonicalPt = parsedPt.canonical
    const { trajectoryId, stepIdx } = parsedPt.structured

    const httpFingerprint = buildCompactArgsFingerprint(
      isPlainObject(rawArgs) ? rawArgs : {},
      false,
    )
    if (!httpFingerprint) {
      return {
        ok: false,
        error: 'Antigravity MCP arguments exceed structured correlation limits.',
      }
    }

    const inFlightAdmission = this.correlator.beginInFlightToken(canonicalPt, httpFingerprint)
    if (!inFlightAdmission.ok) {
      return inFlightAdmission
    }
    try {
      const deadlineAt = Date.now() + AGY_MCP_CORRELATION_WAIT_MS
      const hasProvenBoundary =
        this.config.getRootStepIdx() !== undefined ||
        this.correlator.minHostStepIdx !== undefined ||
        this.config.hasZeroTurnStepBoundary()
      if (
        this.correlator.pinnedTrajectory === undefined &&
        hasProvenBoundary &&
        this.correlator.canLazyPinStorageDb
      ) {
        const hostIdentity = await this.config.tryLoadHostTrajectoryId?.()
        if (this.correlator.isClosed || this.correlator.isRevoked || !isCurrent()) {
          return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
        }
        if (hostIdentity) {
          this.correlator.pinHostTrajectoryId(hostIdentity.trajectoryId, undefined)
        }
      }

      const checkRootProof = (): RootProofCheckResult => {
        const minStepIdx =
          this.config.getRootStepIdx() ??
          this.correlator.minHostStepIdx ??
          (this.config.hasZeroTurnStepBoundary() ? 0 : undefined)
        if (minStepIdx !== undefined && (!Number.isSafeInteger(stepIdx) || stepIdx < minStepIdx)) {
          return {
            kind: 'reject',
            error: 'Antigravity MCP progressToken precedes the active root Turn step boundary.',
          }
        }
        if (
          this.correlator.pinnedTrajectory !== undefined &&
          trajectoryId !== this.correlator.pinnedTrajectory
        ) {
          return {
            kind: 'reject',
            error:
              'Antigravity MCP progressToken does not match an ACP-authenticated root trajectory.',
          }
        }
        if (minStepIdx === undefined || this.correlator.pinnedTrajectory === undefined) {
          return 'wait'
        }
        return 'ok'
      }

      const claimed = await this.correlator.claimOrWaitForHttp(
        toolName,
        httpFingerprint,
        canonicalPt,
        isCurrent,
        checkRootProof,
        Math.max(0, deadlineAt - Date.now()),
      )
      if (!claimed.ok) {
        return claimed
      }
      return {
        ok: true,
        nativeSessionId: expectedSessionId,
        progressToken: canonicalPt,
        ownerKey: claimed.ownerKey,
        httpFingerprint,
      }
    } finally {
      this.correlator.releaseInFlightToken(canonicalPt)
    }
  }

  private async callTool(params: unknown): Promise<object> {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      return this.toolError('Invalid MCP tool call parameters.')
    }
    const toolName = params.name
    if (!this.allowedToolNames.has(toolName)) {
      return this.toolError(`Tool ${toolName} is not authorized for this turn.`)
    }
    const rawArgs = params.arguments ?? {}
    const auth = await this.verifyFourTupleRoot(toolName, rawArgs, Reflect.get(params, '_meta'))
    if (!auth.ok) {
      return this.toolError(auth.error)
    }
    const rejectClaimedTool = (message: string): object => {
      this.correlator.consumeRejectedClaim(auth.progressToken)
      return this.toolError(message)
    }
    const isCurrent = (): boolean =>
      toolName === 'read_collaboration_source'
        ? this.config.isSourceCurrent()
        : this.config.isRootCurrent()
    const liveClaim = this.correlator.revalidateLiveClaim(
      auth.progressToken,
      toolName,
      auth.httpFingerprint,
      isCurrent,
    )
    if (!liveClaim.ok) {
      return rejectClaimedTool(liveClaim.error)
    }

    if (toolName === 'read_collaboration_source') {
      if (!this.config.sourceGrant) {
        return rejectClaimedTool('No source capability is bound to this root.')
      }
      if (this.activeSourceReads >= 2) {
        return rejectClaimedTool('Concurrent source reads exceeded the per-root limit.')
      }
      this.activeSourceReads += 1
      try {
        const nativeReq = collaborationSourceNativeReadSchema.safeParse(rawArgs)
        if (nativeReq.success && !this.sourceCapability.nativeRoot) {
          return rejectClaimedTool(
            'Native-root source reads are not supported by this source reader.',
          )
        }
        const hasSourceRefArg = isPlainObject(rawArgs) && 'sourceReference' in rawArgs
        if (!nativeReq.success && hasSourceRefArg && !this.sourceCapability.sourceReference) {
          return rejectClaimedTool(
            'Source-reference reads are not supported by this source reader.',
          )
        }
        if (!nativeReq.success && !hasSourceRefArg && !this.sourceCapability.legacy) {
          return rejectClaimedTool('Legacy source reads are not supported by this source reader.')
        }
        const page =
          nativeReq.success && this.sourceCapability.nativeRoot && this.config.sourceReader
            ? readNativeFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                this.config.sourceReader,
                { threadId: auth.nativeSessionId, turnId: this.config.runId },
              )
            : readFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                hasSourceRefArg
                  ? this.sourceCapability.sourceReference
                    ? this.config.sourceReader
                    : undefined
                  : this.sourceCapability.legacy
                    ? this.config.sourceReader
                    : undefined,
                !hasSourceRefArg && this.sourceCapability.legacy
                  ? this.config.legacySourceReader
                  : undefined,
              )
        const serialized = JSON.stringify(page)
        if (Buffer.byteLength(serialized, 'utf8') > COLLABORATION_PAGE_BYTES * 2) {
          return rejectClaimedTool('Source page exceeded its bounded transport size.')
        }
        return { content: [{ type: 'text', text: serialized }] }
      } catch (error) {
        const message =
          error instanceof NativeSourceReadFailure || error instanceof Error
            ? error.message
            : 'Source read failed.'
        return rejectClaimedTool(safeNativePermissionText(message, 512))
      } finally {
        this.activeSourceReads = Math.max(0, this.activeSourceReads - 1)
      }
    }

    if (toolName === 'publish_session_title') {
      if (this.correlator.isTitleSlotTaken) {
        return rejectClaimedTool('A session title was already submitted in this turn.')
      }
      const parsed = sessionTitleInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid Session title.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'title', title: parsed.data.title },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return {
        content: [{ type: 'text', text: 'Title validated. Continue your substantive answer.' }],
      }
    }

    if (toolName === 'request_peer_assistance') {
      if (this.correlator.isPeerSlotTaken) {
        return rejectClaimedTool('This answer already has a peer request.')
      }
      const parsed = peerRequestToolInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Peer request arguments are invalid.')
      }
      const target = parsed.data.target
      if (target === 'agy') {
        return rejectClaimedTool('An Agent can only request the other Pact Agent.')
      }
      if (this.config.peerTargetAgentId && target !== this.config.peerTargetAgentId) {
        return rejectClaimedTool('An Agent can only request the active peer Agent in this session.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        {
          type: 'peer',
          targetAgentId: target,
          proposalKind: parsed.data.kind,
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: PEER_ASSISTANCE_RECORDED_RESULT }] }
    }

    if (toolName === 'submit_review') {
      const task = this.config.workflow
      const authorization = this.config.authorization
      const stage = authorization?.stage ?? task?.stage
      const actor = authorization?.actor ?? task?.actor
      if (
        !task ||
        !stage ||
        !['plan_review', 'code_review'].includes(stage) ||
        actor !== collaborationActor(task, stage)
      ) {
        return rejectClaimedTool('This turn is not authorized to submit a review verdict.')
      }
      const parsed = collaborationReviewInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid review verdict payload.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'review', observation: parsed.data },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Verdict validated. Include a non-empty natural-language review report in your assistant response before ending this root turn; Pact will bind it after normal completion.',
          },
        ],
      }
    }

    if (toolName === 'submit_input_result') {
      const task = this.config.workflow
      const authorization = this.config.authorization
      const parsed = collaborationInputResultSchema.safeParse(rawArgs)
      if (
        !task ||
        !parsed.success ||
        !collaborationInputOutcomeAllowed(task, authorization, parsed.data.outcome)
      ) {
        return rejectClaimedTool('This root is not authorized to submit that input result.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'input_result', observation: parsed.data },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: collaborationInputResultReceiptText }] }
    }

    if (toolName === 'retain_current_plan') {
      if (
        !this.config.isPlanRetentionCurrent() ||
        !collaborationPlanRetentionInputSchema.safeParse(rawArgs).success
      ) {
        return rejectClaimedTool(
          'Plan retention is unavailable because the plan was modified or retention arguments were invalid.',
        )
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'retain_plan' },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: collaborationPlanRetentionReceiptText }] }
    }

    if (toolName === 'publish_plan') {
      if (this.correlator.isOpenPlanFinalizedOrPendingFinal) {
        return rejectClaimedTool('A published Plan has already been finalized in this root turn.')
      }
      const parsed = collaborationPublishPlanInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid publish_plan payload.')
      }
      const chunkBytes = Buffer.from(parsed.data.text, 'utf8')
      if (chunkBytes.byteLength > COLLABORATION_PLAN_CHUNK_BYTES) {
        return rejectClaimedTool('Plan chunk exceeds 48 KiB UTF-8 limit.')
      }
      const expectedOffset =
        this.correlator.confirmedPlanByteCount + this.correlator.pendingPlanBufferBytes()
      const offset = parsed.data.offset ?? 0
      if (offset !== expectedOffset) {
        return rejectClaimedTool(`Expected byte offset ${expectedOffset}, received ${offset}.`)
      }
      const nextTotalBytes = expectedOffset + chunkBytes.byteLength
      if (nextTotalBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
        return rejectClaimedTool('Published Plan exceeds maximum byte capacity.')
      }
      const complete = parsed.data.complete ?? parsed.data.offset === undefined
      if (!complete && chunkBytes.byteLength === 0) {
        return rejectClaimedTool('Non-final Plan chunk cannot be empty.')
      }
      if (this.correlator.pendingPlanChunkCount >= 64) {
        return rejectClaimedTool('Too many pending Plan chunks in this turn.')
      }
      const chunkHasNonWhitespace = /\S/u.test(parsed.data.text)
      if (complete && !this.correlator.hasNonWhitespacePlanContent(chunkHasNonWhitespace)) {
        return rejectClaimedTool('Published Plan Markdown cannot be empty.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        {
          type: 'publish_plan_chunk',
          offset,
          byteLength: chunkBytes.byteLength,
          complete,
        },
        isCurrent,
        { offset, bytes: chunkBytes, hasNonWhitespace: chunkHasNonWhitespace, complete },
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      if (complete) {
        const candidateMarkdown = this.correlator.assembleCandidateOpenPlanMarkdown(staged.ownerKey)
        if (!candidateMarkdown) {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            'All preceding Plan chunks must complete before finalizing publish_plan.',
          )
        }
        if (typeof this.config.recordOpenPlanFinalIntent !== 'function') {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            'Open-mode plan publication requires a configured durable intent persistence callback.',
          )
        }
        const executionId = this.config.getExecutionId?.()
        const boundedCallKey = encodeBoundedOpenPlanCallKey(staged.ownerKey)
        const boundedProgressToken = encodeBoundedOpenPlanProgressToken(auth.progressToken)
        const nativePlanId = staged.ownerKey.startsWith('call:')
          ? buildBoundedNativePlanId(auth.nativeSessionId, staged.ownerKey.slice('call:'.length))
          : undefined
        try {
          const persisted = this.config.recordOpenPlanFinalIntent({
            ...(executionId ? { executionId } : {}),
            callKey: boundedCallKey,
            progressToken: boundedProgressToken,
            ...(nativePlanId ? { nativePlanId } : {}),
            candidateMarkdown,
          })
          if (persisted !== true) {
            throw new Error('Open-mode plan publish intent persistence was rejected.')
          }
        } catch (error) {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            safeNativePermissionText(
              error instanceof Error
                ? error.message
                : 'Failed to persist open-mode plan publish intent.',
              512,
            ),
          )
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: complete
              ? 'Updated Plan staged. Pact will publish it once this root turn completes.'
              : `Accepted Plan chunk (${nextTotalBytes} bytes).`,
          },
        ],
      }
    }

    return rejectClaimedTool('Unsupported Pact MCP tool.')
  }

  private toolError(message: string): object {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    }
  }
}

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
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

function classifyIdentityWorkerError(
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

function identityStatusPriority(
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

export class AgyAgentAdapter implements AgentAdapter {
  readonly id = 'agy' as const
  private readonly executablePath: string
  private readonly appDataDirs: readonly string[]
  private readonly primaryAppDataDir: string
  private readonly pool: AgyAcpConnectionPool
  private readonly ownsPool: boolean
  private readonly unsubscribePoolPhysicalOps: () => void
  private readonly unsubscribeStoragePhysicalOps: (() => void) | undefined
  private readonly nativeChecks: NativeCheckOperation
  private readonly evidenceCacheWork = new NativeWorkingMemory().reserve(0)
  private readonly nativeEvidence = new Map<string, NativeProbeResult>()
  private readonly sessionModes = new Map<string, SessionModeState>()
  private readonly nativeRebuildReceipts = new Map<
    string,
    {
      nativeSessionId: string
      sourceHash?: string | undefined
      seedHash: string
      cwd: string
      executorId: string
      initializationWitness?: NativeInitializationWitness | undefined
    }
  >()
  private readonly activeRuns = new Map<string, ActiveAgyRun>()
  private readonly ownedRunHandles = new Set<{
    readonly runId: string
    readonly cancel: () => void
    readonly closeZeroInputSession: (deadlineAt?: number) => Promise<void>
    readonly forceCleanup: () => Promise<void>
    readonly finalized: Promise<void>
  }>()
  private readonly skillProbeOwner = new AgySkillProbeOwner()
  private ownedForkFiles: NativeForkFiles | undefined
  private readonly activeOwnedForkFiles = new Set<NativeForkFiles>()
  private disposalPromise: Promise<void> | undefined
  private skillCatalogListener: (() => void) | undefined
  private nextTurnEpoch = 1
  private disposed = false

  private getOwnedForkFiles(): NativeForkFiles {
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (!this.ownedForkFiles) {
      this.ownedForkFiles = new NativeForkFiles(this.options.ipcTraffic)
      this.activeOwnedForkFiles.add(this.ownedForkFiles)
    }
    return this.ownedForkFiles
  }

  constructor(private readonly options: AgyAgentAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? 'agy'
    this.primaryAppDataDir = options.appDataDir
      ? resolvePath(options.appDataDir)
      : options.relativeAppDataDir
        ? resolvePath(join(homedir(), '.gemini', options.relativeAppDataDir))
        : resolveAgyAppDataDir(process.env)
    const explicitGeminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']?.trim()
    const geminiBaseDir =
      explicitGeminiDir && isAbsolute(explicitGeminiDir)
        ? resolvePath(explicitGeminiDir)
        : join(homedir(), '.gemini')
    const fallbackDir = resolvePath(join(geminiBaseDir, 'antigravity'))
    this.appDataDirs =
      options.appDataDir || options.relativeAppDataDir || this.primaryAppDataDir === fallbackDir
        ? [this.primaryAppDataDir]
        : [this.primaryAppDataDir, fallbackDir]

    this.nativeChecks = new NativeCheckOperation(() => !this.disposed)
    if (options.connectionPool) {
      this.pool = options.connectionPool
      this.ownsPool = false
    } else {
      this.pool = new AgyAcpConnectionPool({
        executablePath: this.executablePath,
        clientInfo: options.clientInfo,
        relativeAppDataDir: options.relativeAppDataDir,
        idleTimeoutMs: options.idleTimeoutMs,
        processFactory: options.processFactory,
        ipcTraffic: options.ipcTraffic,
      })
      this.ownsPool = true
    }
    this.unsubscribePoolPhysicalOps = this.pool.subscribePhysicalOperations(
      (signal, physicalCompletion) => {
        this.nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )
    this.unsubscribeStoragePhysicalOps = options.subscribeStoragePhysicalOperations?.(
      (signal, physicalCompletion) => {
        this.nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )
  }

  get executorId(): string {
    return this.pool.executorId
  }

  hasExecutor(executorId: string): boolean {
    return this.pool.hasExecutor(executorId)
  }

  poolSnapshot() {
    return this.pool.poolSnapshot()
  }

  get unconfirmedClosedSessionCount(): number {
    return this.pool.unconfirmedClosedSessionCount
  }

  hasUnconfirmedClosedSession(sessionId: string): boolean {
    return this.pool.hasUnconfirmedClosedSession(sessionId)
  }

  retireFullAccess(options: { sessionId?: string; cwd?: string } = {}): Promise<void> {
    return this.pool.retireFullAccess(options)
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.skillCatalogListener = listener
  }

  async discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    return discoverAgySkills(cwd, this.executablePath, signal, {
      ...this.options.skillDiscoveryOptions,
      probeOwner: this.options.skillDiscoveryOptions?.probeOwner ?? this.skillProbeOwner,
    })
  }

  preflightPrompt(input: AgentRunInput): void {
    if (input.promptEnvelope.skillInvocation) {
      for (const binding of input.promptEnvelope.skillInvocation.bindings) {
        if (binding.agentId === 'agy' && !binding.name) {
          throw new AgentExecutionError(
            'protocol_error',
            'Invalid Antigravity Skill binding.',
            false,
          )
        }
      }
    }
  }

  retireSourceGrant(owner: { runId: string; grant: string }): void {
    const active = this.activeRuns.get(owner.runId)
    if (active) {
      active.retireSourceReader?.()
    }
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    if (runId !== undefined) {
      const run = this.activeRuns.get(runId)
      if (!run) return false
      return run.backgroundUnconfirmed || run.activeBackgroundTasks.size > 0
    }
    for (const run of this.activeRuns.values()) {
      if (run.backgroundUnconfirmed || run.activeBackgroundTasks.size > 0) return true
    }
    return false
  }

  backgroundWork(runId: string, executorId: string): 'working' | 'stoppable' | undefined {
    const run = this.activeRuns.get(runId)
    if (!run || run.executorId !== executorId) return undefined
    if (run.backgroundUnconfirmed) return 'working'
    if (run.activeBackgroundTasks.size > 0) return 'stoppable'
    return undefined
  }

  async stopBackgroundWork(runId: string, executorId: string, signal: AbortSignal): Promise<void> {
    const run = this.activeRuns.get(runId)
    if (!run || run.executorId !== executorId || !run.connection.isOpen) return
    await run.connection.notify('session/cancel', { sessionId: run.nativeSessionId }, { signal })
  }

  async probe(signal?: AbortSignal): Promise<AgentProbeResult> {
    const effectiveSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)
    if (effectiveSignal.aborted) {
      return { id: 'agy', available: false, reason: 'Antigravity version check was cancelled.' }
    }

    let owned: OwnedAgyProbeProcess | undefined
    try {
      const args = ['--version'] as const
      if (this.options.probeProcessFactory) {
        const supplied = this.options.probeProcessFactory(this.executablePath, args)
        owned = 'then' in supplied ? await supplied : supplied
      } else {
        const isWinCmd = process.platform === 'win32' && /\.cmd$/iu.test(this.executablePath)
        if (isWinCmd && /[&|<>^%!"\r\n]/u.test(this.executablePath)) {
          return { id: 'agy', available: false, reason: 'Unsafe Antigravity executable path.' }
        }
        const group = new OwnedProcessGroup()
        const target = isWinCmd ? (process.env.ComSpec ?? 'cmd.exe') : this.executablePath
        const spawnArgs = isWinCmd
          ? ['/d', '/s', '/c', `""${this.executablePath}" --version"`]
          : ['--version']
        const child = group.spawn(target, spawnArgs, {
          windowsHide: true,
          windowsVerbatimArguments: isWinCmd,
        })
        owned = { child, close: (deadline) => group.close(deadline) }
      }

      const output = await new Promise<{ code: number | null; text: string }>(
        (resolveOut, rejectOut) => {
          let settled = false
          let bytes = 0
          const chunks: Buffer[] = []
          const finish = (code: number | null, err?: Error): void => {
            if (settled) return
            settled = true
            effectiveSignal.removeEventListener('abort', onAbort)
            owned!.child.stdout.off('data', onData)
            owned!.child.stderr.off('data', onData)
            owned!.child.off('error', onError)
            owned!.child.off('close', onClose)
            if (err) rejectOut(err)
            else resolveOut({ code, text: Buffer.concat(chunks, bytes).toString('utf8') })
          }
          const onAbort = (): void => finish(null, new Error('Antigravity probe timed out.'))
          const onData = (chunk: Buffer): void => {
            const remaining = AGY_PROBE_MAX_BYTES - bytes
            if (remaining <= 0) return
            const slice = chunk.subarray(0, remaining)
            bytes += slice.length
            chunks.push(slice)
          }
          const onError = (err: Error): void => finish(null, err)
          const onClose = (code: number | null): void => finish(code)

          effectiveSignal.addEventListener('abort', onAbort, { once: true })
          owned!.child.stdout.on('data', onData)
          owned!.child.stderr.on('data', onData)
          owned!.child.once('error', onError)
          owned!.child.once('close', onClose)
          owned!.child.stdin.end()
        },
      )

      const versionMatch = /(\d+\.\d+\.\d+)/u.exec(output.text)
      const version = versionMatch?.[1]
      if (output.code !== 0 || !version) {
        return {
          id: 'agy',
          available: false,
          ...(version ? { version } : {}),
          reason: 'Antigravity CLI did not report a valid version.',
        }
      }
      const minVersion = RUNTIME_MINIMUM_VERSIONS.agy
      if (compareSemver(version, minVersion) < 0) {
        return {
          id: 'agy',
          available: false,
          version,
          reason: `Antigravity ${version} is older than required ${minVersion}.`,
        }
      }
      return { id: 'agy', available: true, version }
    } catch (error) {
      return {
        id: 'agy',
        available: false,
        reason: safeNativePermissionText(
          error instanceof Error ? error.message : 'Antigravity CLI is unavailable.',
          240,
        ),
      }
    } finally {
      if (owned?.close) {
        await owned.close(Date.now() + 1_000).catch(() => undefined)
      } else if (owned && owned.child.exitCode === null) {
        try {
          owned.child.kill('SIGKILL')
        } catch {
          // Ignore concurrent exit.
        }
      }
    }
  }

  async *run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    signal.throwIfAborted()
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (this.activeRuns.size >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError(
        'Antigravity has too many active native contexts. Wait for one to settle; no new task was submitted.',
      )
    }

    const workflow = input.promptEnvelope.collaboration
    const authorization = input.promptEnvelope.collaborationAuthorization ?? workflow?.authorization
    const readOnlyStage = collaborationReadOnly(workflow, authorization)
    const planModeStage = collaborationPlanMode(workflow, authorization)
    const askOnlyStage = Boolean(workflow && collaborationAskMode(workflow, authorization))
    const effectivePermissionMode: SessionPermissionMode = input.permissionMode ?? 'native'
    const permissionScope =
      !readOnlyStage && effectivePermissionMode === 'full' ? 'full' : 'standard'

    let brainPlanTouched = false
    const activeBrainPlanOpCallIds = new Set<string>()
    const hasUnresolvedBrainPlanWrite = (): boolean => activeBrainPlanOpCallIds.size > 0
    let latestBrainPlanCandidate: { nativeId: string; text: string } | undefined
    let brainPlanReadbackRequired = false
    let brainPlanCaptureFailed = false
    let unresolvedPreBindOutput = false

    let sourceRetired = false
    const retireSourceReader = (): void => {
      if (sourceRetired) return
      sourceRetired = true
      input.collaborationSourceReader?.retire()
    }

    let resolvedSessionId: string | undefined = input.nativeSessionId
    let createdFreshSession = false
    let activeExecutorId = this.pool.executorId
    let rootFirstByteWritten = false
    let promptEnteredTransport = false
    let rootConfirmedNotSent = false
    const isConfirmedZeroBytesSent = (): boolean =>
      (!promptEnteredTransport && !rootFirstByteWritten) || rootConfirmedNotSent
    let promptReplyReceived = false
    let userCancelRequested = false
    let rootTerminal = false
    let rootReleasing = false
    let foregroundReleased = false

    let lease: AgyPoolLease | undefined
    let sessionStream: AgyOrderedSessionStream | undefined
    let promptMemoryReservation: NativeMemoryReservation | undefined
    let toolStateMemoryReservation: NativeMemoryReservation | undefined
    let foregroundDedupMemoryReservation: NativeMemoryReservation | undefined
    let mcpCorrelationMemoryReservation: NativeMemoryReservation | undefined
    let publishedPlanMemoryReservation: NativeMemoryReservation | undefined
    let pendingEventsMemoryReservation: NativeMemoryReservation | undefined
    let stagedPreBindMemoryReservation: NativeMemoryReservation | undefined
    let foreignExecIdsMemoryReservation: NativeMemoryReservation | undefined
    let postCutoffBgMemoryReservation: NativeMemoryReservation | undefined
    let serverRequestOwner: AgyServerRequestOwnerHandle | undefined
    let unsubscribeBackground: (() => void) | undefined
    let activeRun: ActiveAgyRun | undefined
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined
    let promptSettled = false
    const promptRpcAbort = new AbortController()
    const runDisposeAbort = new AbortController()
    const runSignal = AbortSignal.any([signal, runDisposeAbort.signal])
    const observation = new AbortController()
    const runFinalizer = Promise.withResolvers<void>()
    let stopStreamPump: (() => void) | undefined
    let stopPrePromptDrain: ((drainRemaining?: boolean) => Promise<void>) | undefined
    let handoffOrderedStreamToBackground: (() => void) | undefined

    const loadHostTrajectoryIdentity = async (
      loadSignal: AbortSignal,
    ): Promise<AgyTrajectoryIdentityClientResult> => {
      if (!resolvedSessionId) return { status: 'missing' }
      let bestNonOk: Exclude<AgyTrajectoryIdentityClientResult, { status: 'ok' }> | undefined
      for (const appDataDir of this.appDataDirs) {
        if (this.disposed || observation.signal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        loadSignal.throwIfAborted()
        let identity: AgyTrajectoryIdentityClientResult | undefined
        for (let busyAttempt = 0; busyAttempt < 4; busyAttempt += 1) {
          if (this.disposed || observation.signal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          try {
            if (this.options.storageClient?.readTrajectoryIdentity) {
              // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when shared fork worker is momentarily busy.
              identity = await this.options.storageClient.readTrajectoryIdentity(
                {
                  appDataDir,
                  cwd: lease?.canonicalCwd ?? input.cwd,
                  nativeSessionId: resolvedSessionId,
                },
                loadSignal,
              )
            } else {
              // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when standalone adapter fork worker is momentarily busy.
              const workerRes = await this.getOwnedForkFiles().readAgyTrajectoryIdentity(
                {
                  cwd: lease?.canonicalCwd ?? input.cwd,
                  storageRoot: appDataDir,
                  nativeSessionId: resolvedSessionId,
                },
                loadSignal,
              )
              identity =
                workerRes.status === 'ok'
                  ? {
                      status: 'ok',
                      trajectoryId: workerRes.trajectoryId,
                      stepCount: workerRes.stepCount,
                    }
                  : {
                      status: workerRes.status,
                      ...(workerRes.reason !== undefined ? { reason: workerRes.reason } : {}),
                    }
            }
            break
          } catch (error) {
            if (signal.aborted) throw error
            if (this.disposed || observation.signal.aborted) {
              throw new AgentExecutionError(
                'agent_process_crash',
                'Antigravity is shutting down.',
                false,
              )
            }
            if (loadSignal.aborted) {
              return {
                status: 'timeout',
                reason: 'Antigravity trajectory identity inspection exceeded its deadline.',
              }
            }
            if (
              busyAttempt < 3 &&
              error instanceof Error &&
              error.message.includes('already active')
            ) {
              // oxlint-disable-next-line no-await-in-loop -- Bounded 15ms retry for active storage worker.
              await delayAbortable(15, loadSignal)
              continue
            }
            identity = classifyIdentityWorkerError(error)
            break
          }
        }
        const resolvedIdentity: AgyTrajectoryIdentityClientResult = identity ?? {
          status: 'timeout',
          reason: 'Antigravity trajectory identity worker remained busy.',
        }
        if (resolvedIdentity.status === 'ok') return resolvedIdentity
        if (
          resolvedIdentity.status === 'invalid' ||
          resolvedIdentity.status === 'budget_exceeded'
        ) {
          return resolvedIdentity
        }
        if (
          !bestNonOk ||
          identityStatusPriority(resolvedIdentity.status) > identityStatusPriority(bestNonOk.status)
        ) {
          bestNonOk = resolvedIdentity
        }
      }
      return bestNonOk ?? { status: 'no_storage_root' }
    }

    const loadHostTrajectoryIdentityBeforePrompt = async (
      loadSignal: AbortSignal,
    ): Promise<AgyTrajectoryIdentityClientResult> => {
      const backoffMs = [25, 50, 100, 200]
      let latest: AgyTrajectoryIdentityClientResult = { status: 'no_storage_root' }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (signal.aborted) signal.throwIfAborted()
        if (this.disposed || observation.signal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        if (loadSignal.aborted) {
          return {
            status: 'timeout',
            reason: 'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
          }
        }
        try {
          // oxlint-disable-next-line no-await-in-loop -- Bounded backoff retry strictly for transient WAL churn before prompt.
          latest = await loadHostTrajectoryIdentity(loadSignal)
        } catch (error) {
          if (signal.aborted) throw error
          if (this.disposed || observation.signal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (loadSignal.aborted) {
            return {
              status: 'timeout',
              reason:
                'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
            }
          }
          return classifyIdentityWorkerError(error)
        }
        if (latest.status !== 'transient_churn') return latest
        if (attempt < backoffMs.length) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Bounded backoff delay before retrying transient WAL churn.
            await delayAbortable(backoffMs[attempt]!, loadSignal)
          } catch (error) {
            if (signal.aborted) throw error
            if (this.disposed || observation.signal.aborted) {
              throw new AgentExecutionError(
                'agent_process_crash',
                'Antigravity is shutting down.',
                false,
              )
            }
            return loadSignal.aborted
              ? {
                  status: 'timeout',
                  reason:
                    'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
                }
              : latest
          }
        }
      }
      return latest
    }

    const mcpServer = new AgyRunMcpServer({
      runId: input.runId,
      getNativeSessionId: () => resolvedSessionId,
      getExecutorId: () => activeExecutorId,
      getExecutionId: () => activeRun?.providerExecutionId,
      getRootStepIdx: () => activeRun?.rootStepIdx,
      hasZeroTurnStepBoundary: () => createdFreshSession,
      tryLoadHostTrajectoryId: async () => {
        const res = await loadHostTrajectoryIdentity(
          AbortSignal.any([observation.signal, AbortSignal.timeout(500)]),
        ).catch(() => ({ status: 'transient_churn' as const }))
        return res.status === 'ok'
          ? { trajectoryId: res.trajectoryId, stepCount: res.stepCount }
          : undefined
      },
      bindingGeneration: input.bindingGeneration ?? 1,
      isRootCurrent: () =>
        !this.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !rootReleasing &&
        !foregroundReleased &&
        !signal.aborted,
      isSourceCurrent: () =>
        !this.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !sourceRetired &&
        !signal.aborted,
      workflow,
      authorization,
      requestSessionTitle: input.promptEnvelope.requestSessionTitle === true,
      peerAssistanceAllowed: !workflow && input.peerAssistanceAllowed !== false,
      peerTargetAgentId: this.options.peerTargetAgentId,
      sourceGrant: input.promptEnvelope.sourceGrant,
      sourceReader: input.collaborationSourceReader,
      legacySourceReader: input.readCollaborationSourcePart,
      isPlanRetentionCurrent: () => !brainPlanTouched && !hasUnresolvedBrainPlanWrite(),
      recordOpenPlanFinalIntent: input.recordOpenPlanFinalIntent,
      reserveCorrelationBytes: (nextBytes) => {
        if (!mcpCorrelationMemoryReservation) return true
        try {
          mcpCorrelationMemoryReservation.resize(nextBytes)
          return true
        } catch {
          return false
        }
      },
    })

    const interactionControllers = new Set<AbortController>()
    const abortOutstandingInteractions = (): void => {
      for (const ctrl of interactionControllers) {
        ctrl.abort()
      }
      interactionControllers.clear()
    }
    const recordings = new Set<Promise<void>>()
    let recordingTail = Promise.resolve()
    let unknownEffectsReported = false
    let unknownEffectsReason: string | undefined

    const reportUnknown = (reason: string): void => {
      if (unknownEffectsReported) return
      unknownEffectsReported = true
      unknownEffectsReason = reason
      nativeFileChangesSettled(input, 'unknown', reason)
    }

    const recordHostBeforeRootStart = (): void => {
      if (resolvedSessionId && input.recovery) {
        input.recovery.recordConfirmedUnsent(
          { kind: 'host_before_root_start' },
          { executorId: activeExecutorId, nativeSessionId: resolvedSessionId },
        )
      }
    }

    let zeroInputClosePromise: Promise<void> | undefined
    const closeZeroInputSessionOnce = (deadlineAt?: number): Promise<void> => {
      if (zeroInputClosePromise) return zeroInputClosePromise
      if (
        !createdFreshSession ||
        !resolvedSessionId ||
        !isConfirmedZeroBytesSent() ||
        !lease?.connection.isOpen
      ) {
        return Promise.resolve()
      }
      const timeoutMs = deadlineAt !== undefined ? Math.min(1_500, deadlineAt - Date.now()) : 1_500
      if (timeoutMs <= 0) {
        return Promise.resolve()
      }
      const targetSessionId = resolvedSessionId
      const targetLease = lease
      zeroInputClosePromise = (async () => {
        const closeRes = await targetLease.closeSession(targetSessionId, { timeoutMs })
        if (closeRes.confirmed) {
          this.sessionModes.delete(targetSessionId)
        } else {
          const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            sessionId: input.sessionId,
            runId: input.runId,
            agentId: 'agy',
            executorId: activeExecutorId,
            nativeMethod: 'session/close',
            failureSource: closeDiag.failureSource,
            code: closeDiag.code,
          })
        }
      })()
      return zeroInputClosePromise
    }

    let emergencyCleanedUp = false
    let finalizationPromise: Promise<void> | undefined
    const finalizeRun = (options: { emergency: boolean }): Promise<void> => {
      if (options.emergency) {
        emergencyCleanedUp = true
      }
      if (finalizationPromise) {
        return finalizationPromise
      }
      finalizationPromise = (async () => {
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        promptRpcAbort.abort()
        await stopPrePromptDrain?.(false).catch(() => undefined)
        stopStreamPump?.()
        foregroundReleased = true
        if (options.emergency || emergencyCleanedUp) {
          rootTerminal = true
        }
        if (activeRun) {
          activeRun.foregroundReleased = true
          if (options.emergency || emergencyCleanedUp) {
            activeRun.rootTerminal = true
          }
          this.notifyRootExecutionWaiters(activeRun)
        }
        if (
          (options.emergency || emergencyCleanedUp) &&
          !unknownEffectsReported &&
          !isConfirmedZeroBytesSent()
        ) {
          reportUnknown(
            'Antigravity adapter disposed before native Turn cleanup could be confirmed.',
          )
        }
        this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
        // Root Turn has ended: unconditionally revoke and close MCP server synchronously before releasing its reservation.
        mcpServer.revokeRun()
        await mcpServer.close().catch(() => undefined)
        mcpCorrelationMemoryReservation?.release()
        mcpCorrelationMemoryReservation = undefined
        publishedPlanMemoryReservation?.release()
        publishedPlanMemoryReservation = undefined
        promptMemoryReservation?.release()
        promptMemoryReservation = undefined
        toolStateMemoryReservation?.release()
        toolStateMemoryReservation = undefined
        pendingEventsMemoryReservation?.release()
        pendingEventsMemoryReservation = undefined
        stagedPreBindMemoryReservation?.release()
        stagedPreBindMemoryReservation = undefined
        foreignExecIdsMemoryReservation?.release()
        foreignExecIdsMemoryReservation = undefined
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        if (!options.emergency && !emergencyCleanedUp) {
          await closeZeroInputSessionOnce().catch(() => undefined)
        }
        serverRequestOwner?.dispose()
        serverRequestOwner = undefined
        if (
          !options.emergency &&
          !emergencyCleanedUp &&
          !this.disposed &&
          activeRun &&
          activeRun.activeBackgroundTasks.size > 0
        ) {
          handoffOrderedStreamToBackground?.()
          sessionStream?.close()
          sessionStream = undefined
          // Keep background listener & lease until active background tasks settle or pool disposes.
          const retainedRun = activeRun
          const retainedLease = lease
          lease = undefined
          let retainedCleaned = false
          const cleanupRetained = (): void => {
            if (retainedCleaned) return
            retainedCleaned = true
            unsubscribeBackground?.()
            unsubscribeBackground = undefined
            foregroundDedupMemoryReservation?.release()
            foregroundDedupMemoryReservation = undefined
            postCutoffBgMemoryReservation?.release()
            postCutoffBgMemoryReservation = undefined
            retireSourceReader()
            this.activeRuns.delete(input.runId)
            retainedLease?.release()
          }
          if (retainedRun.observation.signal.aborted || this.disposed || emergencyCleanedUp) {
            cleanupRetained()
          } else {
            retainedRun.observation.signal.addEventListener('abort', cleanupRetained, {
              once: true,
            })
          }
        } else {
          sessionStream?.close()
          sessionStream = undefined
          unsubscribeBackground?.()
          unsubscribeBackground = undefined
          foregroundDedupMemoryReservation?.release()
          foregroundDedupMemoryReservation = undefined
          postCutoffBgMemoryReservation?.release()
          postCutoffBgMemoryReservation = undefined
          retireSourceReader()
          observation.abort()
          if (activeRun) this.activeRuns.delete(input.runId)
          lease?.release()
          lease = undefined
        }
        this.ownedRunHandles.delete(runHandle)
        runFinalizer.resolve()
      })()
      return finalizationPromise
    }

    const runHandle = {
      runId: input.runId,
      cancel: (): void => {
        runDisposeAbort.abort(
          new AgentExecutionError(
            'agent_process_crash',
            'Antigravity adapter is shutting down.',
            false,
          ),
        )
        observation.abort()
        if (activeRun) {
          this.notifyRootExecutionWaiters(activeRun)
        }
        for (const ctrl of interactionControllers) ctrl.abort()
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        if (
          rootFirstByteWritten &&
          !promptSettled &&
          !rootTerminal &&
          resolvedSessionId &&
          lease?.connection.isOpen
        ) {
          void lease.connection
            .notify('session/cancel', { sessionId: resolvedSessionId }, {})
            .catch(() => undefined)
        }
        promptRpcAbort.abort()
      },
      closeZeroInputSession: (deadlineAt?: number): Promise<void> =>
        closeZeroInputSessionOnce(deadlineAt),
      forceCleanup: (): Promise<void> => finalizeRun({ emergency: true }),
      finalized: runFinalizer.promise,
    }
    this.ownedRunHandles.add(runHandle)

    try {
      // Re-verify explicit /skill selections before acquiring or dispatching to native process.
      if (input.promptEnvelope.skillInvocation) {
        const hasAgySkill = input.promptEnvelope.skillInvocation.bindings.some(
          (b) => b.agentId === 'agy',
        )
        if (hasAgySkill) {
          const catalog = await this.discoverSkills(input.cwd, runSignal)
          bindAgySkillSelections(input.promptEnvelope.skillInvocation.bindings, catalog)
        }
      }

      const mcpDescriptor = mcpServer.hasTools ? await mcpServer.start() : undefined

      lease = await this.pool.acquire({
        cwd: input.cwd,
        permissionScope,
        permissionMode: effectivePermissionMode,
        readOnly: readOnlyStage,
        sessionId: input.sessionId,
        signal: runSignal,
      })
      const connection = lease.connection
      activeExecutorId = connection.executorId
      input.recordExecutor?.(activeExecutorId)

      await lease.ensureInitialized(runSignal)

      // Event queue fed by ordered server-request interactions (approval / question) and session updates.
      pendingEventsMemoryReservation = connection.reserveWorkingMemory(0)
      const pendingEvents: Array<{ readonly event: NormalizedAgentEvent; readonly bytes: number }> =
        []
      let pendingEventsBytes = 0
      let wakeEventLoop: (() => void) | undefined
      let wakePumpForBackpressure: (() => void) | undefined
      const notifyEventLoop = (): void => {
        const wake = wakeEventLoop
        wakeEventLoop = undefined
        wake?.()
      }
      const notifyPumpForBackpressure = (): void => {
        const wake = wakePumpForBackpressure
        wakePumpForBackpressure = undefined
        wake?.()
      }
      const isPendingEventsAtSoftCap = (): boolean =>
        pendingEvents.length >= AGY_MAX_PENDING_EVENTS ||
        pendingEventsBytes >= AGY_MAX_PENDING_EVENT_BYTES
      const pushPendingEvent = (ev: NormalizedAgentEvent): void => {
        const evBytes = estimateNormalizedEventBytes(ev)
        const nextBytes = pendingEventsBytes + evBytes
        if (
          pendingEvents.length >= AGY_MAX_PENDING_EVENTS * 2 ||
          nextBytes > AGY_MAX_PENDING_EVENT_BYTES * 2
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity pending event queue exceeded working-memory budget.',
            false,
          )
        }
        pendingEventsMemoryReservation?.resize(nextBytes)
        pendingEventsBytes = nextBytes
        pendingEvents.push({ event: ev, bytes: evBytes })
        notifyEventLoop()
      }
      const shiftPendingEvent = (): NormalizedAgentEvent | undefined => {
        const entry = pendingEvents.shift()
        if (!entry) return undefined
        pendingEventsBytes = Math.max(0, pendingEventsBytes - entry.bytes)
        pendingEventsMemoryReservation?.resize(pendingEventsBytes)
        if (!isPendingEventsAtSoftCap()) {
          notifyPumpForBackpressure()
        }
        return entry.event
      }
      const clearPendingEvents = (): void => {
        pendingEvents.length = 0
        pendingEventsBytes = 0
        pendingEventsMemoryReservation?.resize(0)
        notifyPumpForBackpressure()
      }

      const permissionWait = new NativePermissionWait()
      let activePermissionRequests = 0
      const releaseWaitObserver = permissionWait.subscribe(() => {
        if (activeRun?.turnAccepted && !rootTerminal && resolvedSessionId) {
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            {
              kind: permissionWait.waiting ? 'waiting_user' : 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
        }
      })
      observation.signal.addEventListener('abort', releaseWaitObserver, { once: true })

      let replayingHistory = false
      let promptCutoffSeq: number | undefined

      const isUnscopedDuringForeignTurn = (validated: ValidatedAgyFrame): boolean =>
        Boolean(
          activeRun &&
          activeRun.providerExecutionId === undefined &&
          activeRun.foreignTurnActiveUntilRootBound &&
          validated.executionId === undefined,
        )

      const isServerRequestIdentityContradicted = (validated: ValidatedAgyFrame): boolean =>
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        isUnscopedDuringForeignTurn(validated) ||
        (validated.executionId !== undefined &&
          activeRun?.providerExecutionId !== undefined &&
          validated.executionId !== activeRun.providerExecutionId) ||
        (validated.executionId !== undefined &&
          Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))

      const handleOrderedServerRequest = (
        req: Extract<AgyIngress, { kind: 'server_request' }>,
      ): boolean => {
        const { method, rpcId, message } = req
        if (method !== 'session/request_permission' && method !== 'elicitation/create') {
          void connection
            .respondError(rpcId, 'Unsupported Antigravity ACP server request.', -32_601)
            .catch(() => undefined)
          return false
        }
        const rawParams = Reflect.get(message, 'params')
        const paramsObjectValid = isPlainObject(rawParams)
        const params = paramsObjectValid ? rawParams : {}

        if (
          activeRun?.promptReplyReceived ||
          (promptCutoffSeq !== undefined && req.seq > promptCutoffSeq)
        ) {
          if (method === 'session/request_permission') {
            const rejectOnce = findRejectOnceOptionId(params.options)
            void connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
          } else {
            void connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
          return true
        }

        // Validate session, execution, trajectory/step, tokens, and operation-specific payload
        // BEFORE recording acceptance, showing an interaction, or granting permission!
        const validated = validateAgyFrame(
          req,
          resolvedSessionId,
          mcpServer.pinnedTrajectory,
          mcpServer.minStepIdx,
        )
        const unscopedForeign = isUnscopedDuringForeignTurn(validated)
        const identityContradicted = isServerRequestIdentityContradicted(validated)
        const permRequestInvalid =
          method === 'session/request_permission' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens ||
            validated.toolCallIdInvalid ||
            validated.argsEvidence.kind === 'invalid_or_conflict' ||
            (validated.statusPresent &&
              (validated.statusInvalid ||
                validated.status === 'completed' ||
                validated.status === 'failed' ||
                validated.status === 'cancelled')))
        const elicitRequestInvalid =
          method === 'elicitation/create' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens)

        let preBuiltPermissionCard: ReturnType<typeof buildAgyPermissionCard> | undefined
        let permissionCardValid = false
        if (method === 'session/request_permission' && !permRequestInvalid) {
          try {
            preBuiltPermissionCard = buildAgyPermissionCard(params, lease!.canonicalCwd)
            permissionCardValid = true
          } catch {
            permissionCardValid = false
          }
        }

        let preParsedElicitationRequest: NativeUserInputRequest | undefined
        let elicitationPayloadValid = false
        let elicitationParseErrorMessage: string | undefined
        if (method === 'elicitation/create' && !elicitRequestInvalid) {
          try {
            preParsedElicitationRequest = agyElicitationRequest(params)
            elicitationPayloadValid = true
          } catch (error) {
            elicitationPayloadValid = false
            elicitationParseErrorMessage =
              error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.'
          }
        }

        const requestValidForAcceptance =
          method === 'session/request_permission'
            ? !permRequestInvalid && permissionCardValid
            : !elicitRequestInvalid && elicitationPayloadValid

        // Only count as model Turn acceptance AFTER the root prompt has dispatched AND BOTH
        // attributable frame identity and operation-specific payload validation succeed!
        if (
          requestValidForAcceptance &&
          activeRun &&
          rootFirstByteWritten &&
          !activeRun.turnAccepted &&
          !activeRun.promptReplyReceived &&
          !rootTerminal &&
          !replayingHistory
        ) {
          activeRun.turnAccepted = true
          input.recordDispatch?.('accepted', activeRun.nativeSessionId, activeExecutorId)
          this.recordEvidence(
            input,
            activeRun.nativeSessionId,
            activeExecutorId,
            {
              kind: 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
          pushPendingEvent({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
        }

        if (method === 'session/request_permission') {
          this.handlePermissionRequest({
            connection,
            validated,
            rpcId,
            params,
            paramsObjectValid,
            unscopedDuringForeignTurn: unscopedForeign,
            preBuiltCard: preBuiltPermissionCard,
            cwd: lease!.canonicalCwd,
            input,
            activeRun,
            getSessionId: () => resolvedSessionId,
            mcpServer,
            readOnlyStage,
            permissionMode: effectivePermissionMode,
            permissionWait,
            getActiveCount: () => activePermissionRequests,
            adjustActiveCount: (delta) => {
              activePermissionRequests += delta
            },
            interactionControllers,
            pushEvent: pushPendingEvent,
            signal,
          }).catch(() => undefined)
          return true
        }

        if (!elicitRequestInvalid && !elicitationPayloadValid) {
          void connection
            .respondError(
              rpcId,
              elicitationParseErrorMessage ?? 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return true
        }

        this.handleElicitationRequest({
          connection,
          validated,
          rpcId,
          params,
          paramsObjectValid,
          unscopedDuringForeignTurn: unscopedForeign,
          preParsedRequest: preParsedElicitationRequest,
          input,
          activeRun,
          askOnlyStage,
          readOnlyNonInteractive:
            readOnlyStage &&
            !planModeStage &&
            (authorization?.stage ?? workflow?.stage) !== 'reply',
          permissionWait,
          interactionControllers,
          pushEvent: pushPendingEvent,
          signal,
        }).catch(() => undefined)
        return true
      }

      // Register this Run in the connection's server-request owner registry for its full lifetime so
      // concurrent sessions sharing one connection properly reject ambiguous unscoped requests (-32601),
      // while session-scoped requests are routed in strict stdout order via `openSessionStream({ ordered: true })`.
      serverRequestOwner = connection.registerServerRequestOwner({
        ownerId: `run:${input.runId}`,
        knownSessionId: resolvedSessionId,
        handler: (message, seq?: number) => {
          const method = asString(Reflect.get(message, 'method'))
          const rpcId = Reflect.get(message, 'id')
          if (
            (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
            !method ||
            (method !== 'session/request_permission' && method !== 'elicitation/create') ||
            !isPlainObject(message)
          ) {
            return false
          }
          const effectiveSeq = seq ?? (promptCutoffSeq !== undefined ? promptCutoffSeq + 1 : 0)
          return handleOrderedServerRequest({
            kind: 'server_request',
            seq: effectiveSeq,
            rpcId,
            method,
            message,
          })
        },
      })

      const prePromptReplayedToolCallIds = new Set<string>()
      const observePrePromptNotification = (note: object, targetSessionId: string): void => {
        this.observeSessionTitleFromNotification(note, targetSessionId, input)
        if (!isPlainObject(note) || asString(Reflect.get(note, 'method')) !== 'session/update') {
          return
        }
        const params = Reflect.get(note, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== undefined && sid !== targetSessionId) return
        const update = params.update
        if (!isPlainObject(update)) return
        const sessionUpdate = asString(update.sessionUpdate)
        if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return
        const toolCallId = asString(update.toolCallId ?? update.id)
        if (!toolCallId || toolCallId.length > 1024) return
        if (!prePromptReplayedToolCallIds.has(toolCallId)) {
          if (prePromptReplayedToolCallIds.size >= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS) {
            const oldest = prePromptReplayedToolCallIds.values().next().value
            if (oldest !== undefined) prePromptReplayedToolCallIds.delete(oldest)
          }
          prePromptReplayedToolCallIds.add(toolCallId)
        }
      }

      let descriptor: AcpSessionDescriptor
      if (input.nativeSessionId) {
        resolvedSessionId = input.nativeSessionId
        replayingHistory = true
        sessionStream = connection.openSessionStream(input.nativeSessionId, { ordered: true })
        let replayConfigOptions: AcpConfigOptionEntry[] | undefined
        const loadOp = connection.requestOwned(
          'session/load',
          {
            sessionId: input.nativeSessionId,
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
          },
          {
            timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
            signal: runSignal,
            replyTo: sessionStream,
          },
        )
        const loadResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: loadOp.result,
          requestId: loadOp.requestId,
          stream: sessionStream,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: (replayed) => {
            observePrePromptNotification(replayed, input.nativeSessionId!)
            const notifiedOptions = this.extractConfigOptionsFromNotification(
              replayed,
              input.nativeSessionId,
            )
            if (notifiedOptions) replayConfigOptions = notifiedOptions
          },
          onServerRequest: (req) => {
            handleOrderedServerRequest(req)
          },
        })
        const loadError = Reflect.get(loadResp, 'error')
        const loadResult = Reflect.get(loadResp, 'result')
        if (loadError || !isPlainObject(loadResult)) {
          throw new AgentExecutionError(
            'context_resume_failed',
            loadError
              ? safeNativePermissionText(JSON.stringify(loadError), 240)
              : 'Antigravity could not load the saved native session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(loadResult, input.nativeSessionId)
        if (descriptor.configOptions.length === 0 && replayConfigOptions) {
          descriptor.configOptions = replayConfigOptions
        }
        replayingHistory = false
      } else {
        const newReq = connection.request(
          'session/new',
          {
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
          },
          { timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS, signal: runSignal },
        )
        const newResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: newReq,
          stream: undefined,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: () => undefined,
        })
        const newError = Reflect.get(newResp, 'error')
        const newResult = Reflect.get(newResp, 'result')
        if (newError || !isPlainObject(newResult)) {
          throw new AgentExecutionError(
            'protocol_error',
            newError
              ? safeNativePermissionText(JSON.stringify(newError), 240)
              : 'Antigravity ACP server did not create a session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(newResult)
        resolvedSessionId = descriptor.sessionId
        createdFreshSession = true
        serverRequestOwner.updateSessionId(resolvedSessionId)
        sessionStream = connection.openSessionStream(resolvedSessionId, { ordered: true })
        // Drain any initial metadata updates or early server requests (`available_commands_update` / `config_option_update`).
        while (true) {
          const initialItem = sessionStream.shift()
          if (!initialItem) break
          if (initialItem.kind === 'server_request') {
            handleOrderedServerRequest(initialItem)
            continue
          }
          if (initialItem.kind !== 'notification') continue
          observePrePromptNotification(initialItem.message, resolvedSessionId)
          const notifiedOptions = this.extractConfigOptionsFromNotification(
            initialItem.message,
            resolvedSessionId,
          )
          if (notifiedOptions) descriptor.configOptions = notifiedOptions
        }
      }

      const sessionState = this.rememberSessionModeState(
        resolvedSessionId,
        descriptor.currentModeId,
      )

      // Enforce permission & read-only mode transitions BEFORE preparing or writing `session/prompt`.
      await this.configureSessionModeBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionState,
        sessionStream,
        onMetadataNotification: (note) => {
          observePrePromptNotification(note, resolvedSessionId!)
        },
        onServerRequest: (req) => {
          handleOrderedServerRequest(req)
        },
        readOnlyStage,
        permissionMode: effectivePermissionMode,
        signal: runSignal,
      })

      // Confirm applied model & thought_level via `session/set_config_option` (keeping speed: 'native').
      const appliedModelAndEffort = await this.configureModelAndEffortBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionStream,
        onMetadataNotification: (note) => {
          observePrePromptNotification(note, resolvedSessionId!)
        },
        onServerRequest: (req) => {
          handleOrderedServerRequest(req)
        },
        requestedModel: input.model,
        requestedEffort: input.effort,
        signal: runSignal,
      })

      let prePromptStreamEnd: Extract<AgyIngress, { kind: 'end' }> | undefined
      const handlePrePromptIngressItem = (item: AgyIngress): boolean => {
        if (item.kind === 'end') {
          prePromptStreamEnd ??= item
          return false
        }
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return true
        }
        if (item.kind === 'notification') {
          observePrePromptNotification(item.message, resolvedSessionId!)
        }
        return true
      }
      const drainPrePromptBuffered = (): void => {
        if (!sessionStream || prePromptStreamEnd) return
        while (true) {
          const item = sessionStream.shift()
          if (!item) break
          if (!handlePrePromptIngressItem(item)) break
        }
      }
      let prePromptDrainAbort: AbortController | undefined
      let prePromptDrainTask: Promise<void> | undefined
      stopPrePromptDrain = async (drainRemaining = true): Promise<void> => {
        const abort = prePromptDrainAbort
        const task = prePromptDrainTask
        prePromptDrainAbort = undefined
        prePromptDrainTask = undefined
        abort?.abort()
        if (task) {
          await task.catch(() => undefined)
        }
        if (drainRemaining) {
          drainPrePromptBuffered()
        }
      }
      if (sessionStream) {
        const activePrePromptStream = sessionStream
        const drainAbort = new AbortController()
        prePromptDrainAbort = drainAbort
        prePromptDrainTask = (async () => {
          while (!drainAbort.signal.aborted && !prePromptStreamEnd) {
            drainPrePromptBuffered()
            if (drainAbort.signal.aborted || prePromptStreamEnd) break
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Drain trailing session/load replay continuously across pre-prompt setup.
              nextItem = await activePrePromptStream.nextIngress(undefined, drainAbort.signal)
            } catch (err) {
              if (drainAbort.signal.aborted) break
              prePromptStreamEnd ??= {
                kind: 'end',
                seq: 0,
                cause: 'transport',
                incomplete: true,
                detail: err instanceof Error ? err.message : String(err),
              }
              break
            }
            handlePrePromptIngressItem(nextItem)
          }
        })()
      }
      const throwIfPrePromptStreamClosed = async (): Promise<void> => {
        if (!prePromptStreamEnd && connection.isOpen) return
        await stopPrePromptDrain?.(false)
        recordHostBeforeRootStart()
        input.recordDispatch?.('rejected', resolvedSessionId, activeExecutorId)
        if (connection.closeReason instanceof AgentExecutionError) {
          throw connection.closeReason
        }
        throw new AgentExecutionError(
          prePromptStreamEnd?.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
          prePromptStreamEnd?.detail ??
            connection.closeReason?.message ??
            'Antigravity ACP connection closed before prompt dispatch.',
          prePromptStreamEnd?.cause === 'deadline',
        )
      }

      let earlyEvent = shiftPendingEvent()
      while (earlyEvent !== undefined) {
        yield earlyEvent
        earlyEvent = shiftPendingEvent()
      }

      const appliedSettings = this.buildEffectiveExecutionSettings(
        appliedModelAndEffort.model,
        appliedModelAndEffort.effort,
        appliedModelAndEffort.effortKnown,
        effectivePermissionMode,
      )

      if (input.recovery) {
        if (appliedSettings) {
          input.recovery.recordEffectiveSettings(appliedSettings, {
            executorId: activeExecutorId,
            nativeSessionId: resolvedSessionId,
          })
        }
        if (input.recovery.expected) {
          const exp = input.recovery.expected
          if (
            !appliedSettings ||
            exp.executorId !== activeExecutorId ||
            exp.nativeSessionId !== resolvedSessionId ||
            !isDeepStrictEqual(exp.settings, appliedSettings)
          ) {
            recordHostBeforeRootStart()
            throw new NativeInputWithheldError(
              'Antigravity replacement settings or executor differed from the expected recovery binding.',
            )
          }
        }
      }

      // Prepare prompt content with Cutoff serialization & verified ACP images.
      const images: AgentPromptImage[] = []
      const currentEnvelope = input.currentPromptEnvelope?.() ?? input.promptEnvelope
      const sourceForm: AgentSourceReadForm | undefined = mcpServer.sourceCapability.sourceReference
        ? 'sourceReference'
        : mcpServer.sourceCapability.nativeRoot
          ? 'nativeRoot'
          : mcpServer.sourceCapability.legacy
            ? 'legacy'
            : undefined
      const navigate =
        input.collaborationSourceReader && sourceForm !== undefined
          ? (target: Parameters<AgentCollaborationSourceReader['navigation']>[0]) =>
              input.collaborationSourceReader!.navigation(target, sourceForm)
          : undefined
      const navigateCutoff =
        sourceForm !== undefined
          ? cutoffSourceNavigator(input.collaborationSourceReader, sourceForm)
          : undefined

      for (const group of agentPromptImageGroups(currentEnvelope)) {
        images.push(...group.images)
      }
      promptMemoryReservation = connection.reserveWorkingMemory(
        64 * 1024 + nativeImagePreparationBytes(images),
      )
      toolStateMemoryReservation = connection.reserveWorkingMemory(0)
      foregroundDedupMemoryReservation = connection.reserveWorkingMemory(0)
      mcpCorrelationMemoryReservation = connection.reserveWorkingMemory(0)
      publishedPlanMemoryReservation = connection.reserveWorkingMemory(0)
      stagedPreBindMemoryReservation = connection.reserveWorkingMemory(0)
      foreignExecIdsMemoryReservation = connection.reserveWorkingMemory(0)
      postCutoffBgMemoryReservation = connection.reserveWorkingMemory(0)
      const promptBlocks = await agyPromptInput(
        currentEnvelope,
        runSignal,
        navigate,
        navigateCutoff,
        {
          pactRunId: input.runId,
        },
      )
      const expectedFullPromptText = promptBlocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      const systemAppendParts: string[] = []
      if (workflow) {
        systemAppendParts.push(
          collaborationInstructions(workflow, authorization, mcpServer.sourceCapability),
        )
        if (planModeStage) {
          systemAppendParts.push(AGY_PLAN_SUBMISSION_INSTRUCTIONS)
        }
      } else {
        if (mcpServer.allowedToolNames.has('request_peer_assistance')) {
          systemAppendParts.push(PEER_ASSISTANCE_INSTRUCTIONS)
        }
        if (mcpServer.allowedToolNames.has('read_collaboration_source')) {
          systemAppendParts.push(buildSourceInstructions(mcpServer.sourceCapability))
        }
      }
      if (mcpServer.hasTools) {
        systemAppendParts.push(mcpServer.formatToolUsageInstructions())
      }
      const systemAppend = systemAppendParts.filter(Boolean).join('\n\n')

      const turnEpoch = this.nextTurnEpoch++
      const roundTracker = new AgyRoundEffectsTracker(
        lease.canonicalCwd,
        mcpServer.serverName,
        this.primaryAppDataDir,
        resolvedSessionId,
      )

      const knownForeignExecutionIds = new Set<string>()
      for (const other of this.activeRuns.values()) {
        if (
          other.nativeSessionId === resolvedSessionId &&
          !other.rootTerminal &&
          other.providerExecutionId !== undefined
        ) {
          knownForeignExecutionIds.add(other.providerExecutionId)
        }
      }
      activeRun = {
        runId: input.runId,
        sessionId: input.sessionId,
        cwd: lease.canonicalCwd,
        nativeSessionId: resolvedSessionId,
        nativeTurnId: input.runId,
        providerExecutionId: undefined,
        rootStepIdx: undefined,
        resumedExistingSession: Boolean(input.nativeSessionId),
        knownForeignExecutionIds,
        foreignTurnActiveUntilRootBound: false,
        stagedPreBindNotifications: [],
        bindingGeneration: input.bindingGeneration ?? 1,
        nativeGeneration: input.nativeGeneration ?? input.runId,
        executorId: activeExecutorId,
        connection,
        turnEpoch,
        turnAccepted: false,
        promptReplyReceived: false,
        foregroundReleased: false,
        rootReleasing: false,
        rootTerminal: false,
        cancellationPending: false,
        steeringInFlight: false,
        steeredInputs: new Map(),
        pendingSteerOperations: new Set(),
        rootExecutionWaiters: new Set(),
        activeBackgroundTasks: new Set(),
        backgroundTaskAliases: new Map(),
        backgroundUnconfirmed: false,
        observation,
        retireSourceReader,
        isSteerLeaseOpen: () =>
          !this.disposed &&
          !promptReplyReceived &&
          !activeRun!.promptReplyReceived &&
          !rootTerminal &&
          !rootReleasing &&
          !foregroundReleased &&
          !activeRun!.cancellationPending &&
          activeRun!.turnAccepted &&
          connection.isOpen,
      }
      this.activeRuns.set(input.runId, activeRun)

      if (mcpServer.hasTools) {
        const hostTrajectory = await loadHostTrajectoryIdentityBeforePrompt(
          AbortSignal.any([runSignal, observation.signal, AbortSignal.timeout(2_500)]),
        )
        if (hostTrajectory.status === 'ok') {
          mcpServer.pinHostTrajectoryId(hostTrajectory.trajectoryId, hostTrajectory.stepCount)
          if (activeRun.rootStepIdx === undefined) {
            activeRun.rootStepIdx = hostTrajectory.stepCount
          }
        } else if (hostTrajectory.status === 'invalid') {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
            hostTrajectory.reason ??
              'Antigravity trajectory storage metadata is invalid or corrupted.',
            false,
          )
        } else if (
          hostTrajectory.status === 'budget_exceeded' ||
          hostTrajectory.status === 'worker_error'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'runtime_incompatible',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'budget_exceeded'
                ? 'Antigravity trajectory storage exceeded the bounded identity read budget.'
                : 'Antigravity trajectory identity worker failed before prompt dispatch.'),
            false,
          )
        } else if (
          hostTrajectory.status === 'transient_churn' ||
          hostTrajectory.status === 'timeout'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'transient_transport',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'timeout'
                ? 'Antigravity trajectory identity inspection timed out before prompt dispatch.'
                : 'Antigravity trajectory storage remained unstable before prompt dispatch.'),
            true,
          )
        } else if (hostTrajectory.status === 'missing') {
          if (activeRun.rootStepIdx === undefined) {
            recordHostBeforeRootStart()
            throw new AgentExecutionError(
              input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
              hostTrajectory.reason ??
                (input.nativeSessionId
                  ? 'Antigravity trajectory database for the resumed session is missing before prompt dispatch.'
                  : 'Antigravity trajectory database for the new session is missing before prompt dispatch.'),
              false,
            )
          }
        } else if (hostTrajectory.status === 'no_storage_root') {
          mcpServer.disallowLazyStorageDbPin()
        }
      }

      await throwIfPrePromptStreamClosed()

      yield {
        agentId: 'agy',
        type: 'session.started',
        nativeSessionId: resolvedSessionId,
      }
      yield {
        agentId: 'agy',
        type: 'run.model.resolved',
        model: appliedModelAndEffort.model,
        effort: appliedModelAndEffort.effort,
      }
      const requestedSpeed = input.speed ?? 'native'
      yield {
        agentId: 'agy',
        type: 'run.speed.resolved',
        requested: requestedSpeed,
        ...(requestedSpeed !== 'native'
          ? {
              detail:
                'Antigravity does not expose native speed controls; continuing at native provider speed.',
            }
          : {}),
      }

      input.reportNativeEffects?.({
        runId: input.runId,
        generation: activeRun.nativeGeneration,
        state: 'pending',
      })

      // Post-turn background listener & dedup state for attributable out-of-turn completion updates.
      const seenForegroundMessageIds = new Set<string>()
      let seenForegroundMessageIdBytes = 0
      let foregroundDedupIncomplete = false
      let omittedForegroundIdLacksTrustedStep = false
      let maxForegroundStepIdx: number | undefined
      const recordSeenForegroundMessageId = (
        msgIdentity: string,
        trustedStepIdx?: number,
      ): void => {
        if (!isEligibleAgyBackgroundReportId(msgIdentity)) {
          return
        }
        if (seenForegroundMessageIds.has(msgIdentity)) return
        const markOmitted = (): void => {
          foregroundDedupIncomplete = true
          if (trustedStepIdx === undefined) {
            omittedForegroundIdLacksTrustedStep = true
          }
        }
        if (seenForegroundMessageIds.size >= AGY_MAX_FOREGROUND_DEDUP_ID_COUNT) {
          markOmitted()
          return
        }
        const entryBytes = msgIdentity.length * 2 + 32
        if (seenForegroundMessageIdBytes + entryBytes > AGY_MAX_FOREGROUND_DEDUP_BYTES) {
          markOmitted()
          return
        }
        if (foregroundDedupMemoryReservation) {
          try {
            foregroundDedupMemoryReservation.resize(seenForegroundMessageIdBytes + entryBytes)
          } catch {
            markOmitted()
            return
          }
        }
        seenForegroundMessageIds.add(msgIdentity)
        seenForegroundMessageIdBytes += entryBytes
      }
      const recordForegroundStepIdx = (stepIdx: number): void => {
        if (maxForegroundStepIdx === undefined || stepIdx > maxForegroundStepIdx) {
          maxForegroundStepIdx = stepIdx
        }
      }
      const reportedBackgroundMessageIds = new Set<string>()
      let observedBackgroundTask = false
      let postCutoffBackgroundTail = Promise.resolve()
      let postCutoffBgQueuedCount = 0
      let postCutoffBgQueuedBytes = 0

      const enqueuePostCutoffBackgroundUpdate = (
        params: Record<string, unknown>,
        update: Record<string, unknown>,
        preValidatedOwnership?: ValidatedBackgroundOwnership,
      ): void => {
        if (!activeRun) return
        const ownership =
          preValidatedOwnership ??
          validateBackgroundUpdateForRun(
            params,
            update,
            activeRun,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
        if (!ownership.valid) return
        const record = buildCompactPostCutoffBackgroundRecord(update, ownership)
        if (!record) return
        const recordBytes = estimateCompactBackgroundRecordBytes(record)
        const nextBytes = postCutoffBgQueuedBytes + recordBytes
        if (
          postCutoffBgQueuedCount >= AGY_MAX_POST_CUTOFF_BG_PENDING ||
          nextBytes > AGY_MAX_POST_CUTOFF_BG_BYTES
        ) {
          activeRun.backgroundUnconfirmed = true
          reportUnknown(
            'Antigravity post-cutoff background update queue exceeded working-memory budget; coverage is incomplete.',
          )
          return
        }
        try {
          postCutoffBgMemoryReservation?.resize(nextBytes)
        } catch {
          activeRun.backgroundUnconfirmed = true
          reportUnknown(
            'Antigravity post-cutoff background update queue exceeded shared working-memory budget; coverage is incomplete.',
          )
          return
        }
        postCutoffBgQueuedCount += 1
        postCutoffBgQueuedBytes = nextBytes
        postCutoffBackgroundTail = postCutoffBackgroundTail
          .then(() =>
            this.handlePostTurnBackgroundUpdate({
              record,
              input,
              activeRun: activeRun!,
              observedBackgroundTask,
              canSettleEffects: () => !unknownEffectsReported,
              isRootTerminal: () => rootTerminal,
              seenForegroundMessageIds,
              isForegroundDedupIncomplete: () => foregroundDedupIncomplete,
              hasOmittedForegroundIdWithoutStep: () => omittedForegroundIdLacksTrustedStep,
              getMaxForegroundStepIdx: () => maxForegroundStepIdx,
              getPinnedTrajectory: () => mcpServer.pinnedTrajectory,
              getMinStepIdx: () => mcpServer.minStepIdx,
              reportedBackgroundMessageIds,
              reportUnknown,
            }),
          )
          .catch(() => undefined)
          .finally(() => {
            postCutoffBgQueuedCount = Math.max(0, postCutoffBgQueuedCount - 1)
            postCutoffBgQueuedBytes = Math.max(0, postCutoffBgQueuedBytes - recordBytes)
            postCutoffBgMemoryReservation?.resize(postCutoffBgQueuedBytes)
          })
      }

      // Abort handler: distinguishes pre-write abort (`not_sent`) from post-write `session/cancel`
      // with a bounded settlement window for a real native `{ stopReason: 'cancelled' }` reply.
      const onCallerAbort = (): void => {
        if (rootTerminal) return
        userCancelRequested = true
        if (activeRun) activeRun.cancellationPending = true
        for (const ctrl of interactionControllers) ctrl.abort()
        if (!rootFirstByteWritten) {
          promptRpcAbort.abort()
          return
        }
        if (promptSettled) return
        void connection.notify('session/cancel', { sessionId: resolvedSessionId }, {}).catch(() => {
          if (!rootTerminal) {
            reportUnknown(
              'Native Antigravity cancellation could not be confirmed; observation remains active.',
            )
          }
        })
        if (cancelGraceTimer === undefined) {
          cancelGraceTimer = setTimeout(() => {
            cancelGraceTimer = undefined
            promptRpcAbort.abort()
          }, AGY_PHYSICAL_SETTLEMENT_GRACE_MS)
          cancelGraceTimer.unref?.()
        }
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      if (signal.aborted) {
        onCallerAbort()
      }

      // Dispatch `session/prompt` with ordered reply delivery (`replyTo: sessionStream`).
      let rootWithheldByGuard = false
      const promptParams: Record<string, unknown> = {
        sessionId: resolvedSessionId,
        prompt: promptBlocks,
        ...(systemAppend
          ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } }
          : {}),
      }

      await stopPrePromptDrain(true)
      await throwIfPrePromptStreamClosed()

      promptEnteredTransport = true
      const promptOp = connection.requestOwned('session/prompt', promptParams, {
        timeoutMs: undefined,
        signal: promptRpcAbort.signal,
        replyTo: sessionStream,
        canDispatch: () => {
          if (this.disposed || signal.aborted || userCancelRequested) return false
          if (input.recovery?.canDispatch && !input.recovery.canDispatch()) {
            rootWithheldByGuard = true
            return false
          }
          return true
        },
        onDispatch: () => {
          rootFirstByteWritten = true
          promptMemoryReservation?.release()
          promptMemoryReservation = undefined
          input.recordDispatch?.('possibly_sent', resolvedSessionId, activeExecutorId)
        },
      })

      let promptResponse: object | undefined
      let parsedPromptTerminalReply: ParsedAgyPromptTerminalReply | undefined
      let promptRpcResolvedResponse: object | undefined
      let promptError: Error | undefined
      let pumpError: Error | undefined
      let streamEnded = false
      const pumpAbort = new AbortController()
      stopStreamPump = (): void => {
        pumpAbort.abort()
      }

      const settlePromptFromResponse = (res: object): void => {
        promptResponse = res
        parsedPromptTerminalReply = parseAgyPromptTerminalReply(res, resolvedSessionId)
        promptSettled = true
        promptReplyReceived = true
        abortOutstandingInteractions()
        if (activeRun) {
          activeRun.promptReplyReceived = true
          if (
            parsedPromptTerminalReply.ok &&
            parsedPromptTerminalReply.executionId &&
            !activeRun.providerExecutionId &&
            !activeRun.knownForeignExecutionIds.has(parsedPromptTerminalReply.executionId)
          ) {
            this.bindRootExecutionId(activeRun, input, parsedPromptTerminalReply.executionId)
          }
          this.notifyRootExecutionWaiters(activeRun)
        }
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        notifyEventLoop()
      }

      void promptOp.result.then(
        (res) => {
          promptRpcResolvedResponse = res
          // Normal path waits for the ordered `{ kind: 'reply', seq }` ingress frame on `sessionStream`
          // so all notifications with `seq < cutoffSeq` are guaranteed pre-cutoff.
          // If the stream already ended before delivering the reply frame, settle immediately.
          if (streamEnded && !promptSettled) {
            settlePromptFromResponse(res)
          }
          return undefined
        },
        (err: unknown) => {
          promptError ??= err instanceof Error ? err : new Error(String(err))
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (cancelGraceTimer !== undefined) {
            clearTimeout(cancelGraceTimer)
            cancelGraceTimer = undefined
          }
          pumpAbort.abort()
          notifyEventLoop()
          return undefined
        },
      )

      const answer = new AgentAnswerAssembler(input.runId)
      const tools = new Map<string, AgyToolState>()
      let totalToolStateBytes = 0
      const resizeToolStateBytes = (state: AgyToolState, nextBytes: number): void => {
        const clamped = Math.max(0, nextBytes)
        const delta = clamped - state.reservedBytes
        if (delta === 0) return
        if (totalToolStateBytes + delta > AGY_MAX_TOOL_STATE_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity in-flight tool call payloads exceeded the 8 MiB working-memory budget.',
            false,
          )
        }
        totalToolStateBytes = Math.max(0, totalToolStateBytes + delta)
        state.reservedBytes = clamped
        toolStateMemoryReservation?.resize(totalToolStateBytes)
      }
      const reasoningItems = new Map<string, string>()
      let reasoningBytes = 0
      let currentMessageIndex = 0
      let currentThoughtIndex = 0
      let reviewResult: CollaborationReviewObservation | undefined
      let inputResult: CollaborationInputObservation | undefined
      let planRetained = false
      let publishedOpenPlan: { nativeId: string; text: string } | undefined
      let openPlanPublishFailed = false
      let openPlanUnavailableRecorded = false
      let sessionTitleEmitted = false

      const observeFiles = (evidence: Parameters<typeof recordNativeChanges>[1]): void => {
        if (recordings.size >= 8) {
          nativeEffectsUncertain(
            input,
            'Native Antigravity file observation exceeded its bounded recording queue.',
            'recorded_files',
          )
          reportUnknown('Native file recording queue exceeded capacity.')
          return
        }
        const task = recordingTail.then(() =>
          recordNativeChanges(input, evidence, observation.signal),
        )
        recordingTail = task
        recordings.add(task)
        void task.finally(() => recordings.delete(task))
      }

      const projectValidatedFrame = (
        validated: ValidatedAgyFrame,
      ): Generator<NormalizedAgentEvent> => {
        const receivedAfterPromptReply =
          promptCutoffSeq !== undefined && validated.seq > promptCutoffSeq
        return this.projectSessionNotification({
          validated,
          receivedAfterPromptReply,
          input,
          activeRun: activeRun!,
          cwd: lease!.canonicalCwd,
          mcpServer,
          roundTracker,
          answer,
          tools,
          resizeToolStateBytes,
          reasoningItems,
          getReasoningBytes: () => reasoningBytes,
          setReasoningBytes: (v) => {
            reasoningBytes = v
          },
          getMessageIndex: () => currentMessageIndex,
          bumpMessageIndex: () => {
            currentMessageIndex += 1
          },
          getThoughtIndex: () => currentThoughtIndex,
          bumpThoughtIndex: () => {
            currentThoughtIndex += 1
          },
          planModeStage,
          onBrainPlanTouched: () => {
            brainPlanTouched = true
          },
          onBrainPlanOpStarted: (callId) => {
            // Invalidate any prior Plan candidate as soon as a subsequent Plan mutation begins so
            // deferred readback or the newer body is always obtained before publication.
            latestBrainPlanCandidate = undefined
            if (activeBrainPlanOpCallIds.size > 0) {
              // Overlapping Phase-1 Plan ops MUST verify final disk body via storage readback.
              brainPlanReadbackRequired = true
            }
            activeBrainPlanOpCallIds.add(callId)
          },
          onBrainPlanDeferredReadback: (callId) => {
            activeBrainPlanOpCallIds.delete(callId)
            latestBrainPlanCandidate = undefined
            brainPlanReadbackRequired = true
          },
          onBrainPlanCaptured: (callId, candidate) => {
            activeBrainPlanOpCallIds.delete(callId)
            if (activeBrainPlanOpCallIds.size === 0 && !brainPlanReadbackRequired) {
              latestBrainPlanCandidate = candidate
              brainPlanCaptureFailed = false
              input.recordWorkflowPlan?.(candidate)
            } else {
              // Another concurrent Plan op was in flight or readback was already latched; defer to verified storage readback.
              brainPlanReadbackRequired = true
              latestBrainPlanCandidate = undefined
            }
          },
          onBrainPlanCaptureFailed: (callId) => {
            if (callId !== undefined) activeBrainPlanOpCallIds.delete(callId)
            brainPlanCaptureFailed = true
            latestBrainPlanCandidate = undefined
            input.recordWorkflowPlanUnavailable?.()
          },
          onReviewAccepted: (obs) => {
            reviewResult = mergeWorkflowReview(reviewResult, obs)
            input.recordWorkflowReview?.(reviewResult)
          },
          onInputResultAccepted: (obs) => {
            inputResult = mergeWorkflowInput(inputResult, obs)
            input.recordWorkflowInputResult?.(inputResult)
          },
          onPlanRetainedAccepted: () => {
            if (!brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
              planRetained = true
            }
          },
          onOpenPlanPublished: (plan) => {
            try {
              publishedPlanMemoryReservation?.resize(
                computeRetainedPlanTextBytes(plan.text) + plan.nativeId.length * 2,
              )
              publishedOpenPlan = plan
              openPlanPublishFailed = false
              openPlanUnavailableRecorded = false
              input.recordWorkflowPlan?.(plan)
            } catch {
              openPlanPublishFailed = true
              publishedOpenPlan = undefined
              if (!openPlanUnavailableRecorded) {
                openPlanUnavailableRecorded = true
                input.recordWorkflowPlanUnavailable?.()
              }
            } finally {
              mcpServer.clearPendingTransferredPlanBytes()
            }
          },
          onOpenPlanPublishFailed: () => {
            openPlanPublishFailed = true
            publishedOpenPlan = undefined
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.recordWorkflowPlanUnavailable?.()
            }
          },
          getSessionTitleEmitted: () => sessionTitleEmitted,
          markSessionTitleEmitted: () => {
            sessionTitleEmitted = true
          },
          recordSeenForegroundMessageId,
          recordForegroundStepIdx,
          onObservedBackgroundTask: () => {
            observedBackgroundTask = true
          },
          reportUnknown,
          observeFiles,
          signal,
        })
      }

      let stagedPreBindBytes = 0
      let foreignExecIdsBytes = 0
      const addKnownForeignExecutionId = (execId: string): void => {
        if (activeRun!.knownForeignExecutionIds.has(execId)) return
        const entryBytes = Buffer.byteLength(execId, 'utf8') + 32
        const nextBytes = foreignExecIdsBytes + entryBytes
        if (
          activeRun!.knownForeignExecutionIds.size >= AGY_MAX_FOREIGN_EXECUTION_IDS ||
          nextBytes > AGY_MAX_FOREIGN_EXECUTION_ID_BYTES
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity foreign execution tracking exceeded working-memory budget.',
            false,
          )
        }
        foreignExecIdsMemoryReservation?.resize(nextBytes)
        foreignExecIdsBytes = nextBytes
        activeRun!.knownForeignExecutionIds.add(execId)
      }
      const clearStagedPreBindNotifications = (): void => {
        activeRun!.stagedPreBindNotifications.length = 0
        stagedPreBindBytes = 0
        stagedPreBindMemoryReservation?.resize(0)
      }

      function* drainStagedPreBindNotes(): Generator<NormalizedAgentEvent> {
        const boundExecId = activeRun!.providerExecutionId
        if (!boundExecId || activeRun!.stagedPreBindNotifications.length === 0) return
        const queued = activeRun!.stagedPreBindNotifications.splice(0)
        stagedPreBindBytes = 0
        stagedPreBindMemoryReservation?.resize(0)
        for (const staged of queued) {
          // Retain arrival-time attribution: execution-less frames observed while a foreign turn
          // was active, or frames carrying a different execution_id, never replay into this root.
          if (staged.frame.executionId !== boundExecId) {
            continue
          }
          if (staged.arrivedDuringForeignTurn && staged.frame.executionId === undefined) {
            continue
          }
          const rechecked = recheckValidatedFrameAgainstRootBoundary(
            staged.frame,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          yield* projectValidatedFrame(rechecked)
        }
      }

      const admitAndProjectValidatedFrame = function* (
        self: AgyAgentAdapter,
        validated: ValidatedAgyFrame,
      ): Generator<NormalizedAgentEvent> {
        if (activeRun!.providerExecutionId && activeRun!.stagedPreBindNotifications.length > 0) {
          yield* drainStagedPreBindNotes()
        }
        if (validated.method !== 'session/update') {
          return
        }
        const update = validated.payload
        const sessionUpdate = validated.sessionUpdate
        if (!update || !sessionUpdate) return

        const updateExecId = validated.executionId
        // Run contradiction guard BEFORE any execution binding, foreign-ID insertion,
        // staged-frame drain, or projection! Retain ONLY negative MCP revocation for disputed frames.
        const frameRootContradictsPinned =
          validated.hasForeignOrInvalidSessionMeta ||
          validated.executionIdInvalid ||
          validated.rootEvidenceContradicted ||
          (updateExecId !== undefined &&
            activeRun!.providerExecutionId !== undefined &&
            updateExecId !== activeRun!.providerExecutionId) ||
          (updateExecId !== undefined && activeRun!.knownForeignExecutionIds.has(updateExecId))
        if (frameRootContradictsPinned || !validated.isAttributableToCurrentSession) {
          if (
            validated.sessionAttribution !== 'pure_foreign' &&
            (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
          ) {
            const disputedTokens = validated.tokens.allCanonicalTokens
            const tcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
            if (tcId !== undefined || disputedTokens.length > 0) {
              mcpServer.revokeDisputedTokens(tcId, disputedTokens)
            }
          }
          return
        }

        if (
          activeRun!.resumedExistingSession &&
          (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') &&
          !validated.toolCallIdInvalid &&
          validated.toolCallId !== undefined &&
          prePromptReplayedToolCallIds.has(validated.toolCallId)
        ) {
          return
        }

        const updateMeta = Reflect.get(update, '_meta')
        const steerId =
          sessionUpdate === 'user_message_chunk'
            ? (asString(update.pactSteerInputId) ??
              (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
            : undefined

        // Once root `providerExecutionId` is bound, strictly drop any update carrying a different `execution_id`!
        if (activeRun!.providerExecutionId !== undefined) {
          if (updateExecId !== undefined && updateExecId !== activeRun!.providerExecutionId) {
            return
          }
          yield* projectValidatedFrame(validated)
          return
        }

        // Session-level metadata updates without conflicting execution_id pass through safely.
        if (
          (sessionUpdate === 'available_commands_update' ||
            sessionUpdate === 'current_mode_update' ||
            sessionUpdate === 'config_option_update' ||
            sessionUpdate === 'usage_update') &&
          updateExecId === undefined
        ) {
          yield* projectValidatedFrame(validated)
          return
        }

        // Before root `providerExecutionId` is bound:
        if (sessionUpdate === 'user_message_chunk') {
          if (steerId) {
            yield* projectValidatedFrame(validated)
            return
          }
          const chunkIdentity = extractUserChunkPactIdentity(update)
          const normalizedChunkText = chunkIdentity.text?.trim()
          const expectedPromptContent = currentEnvelope.message.content.trim()
          // Bind root execution strictly from exact host run receipt (`pactRunId === input.runId`)
          // or exact normalized full prompt proof — never substring `.includes(...)`!
          const hasExactHostRunReceipt = chunkIdentity.pactRunId === input.runId
          const hasExactFullPromptProof =
            chunkIdentity.pactRunId === undefined &&
            normalizedChunkText !== undefined &&
            expectedFullPromptText.length > 0 &&
            normalizedChunkText === expectedFullPromptText
          const hasExactPlainPromptProof =
            updateExecId === undefined &&
            chunkIdentity.pactRunId === undefined &&
            normalizedChunkText !== undefined &&
            expectedPromptContent.length > 0 &&
            normalizedChunkText === expectedPromptContent
          const matchesRootPrompt =
            hasExactHostRunReceipt || hasExactFullPromptProof || hasExactPlainPromptProof
          if (matchesRootPrompt) {
            activeRun!.foreignTurnActiveUntilRootBound = false
            if (updateExecId && (hasExactHostRunReceipt || hasExactFullPromptProof)) {
              self.bindRootExecutionId(activeRun!, input, updateExecId)
              yield* drainStagedPreBindNotes()
            }
            yield* projectValidatedFrame(validated)
            return
          }
          // Foreign user_message_chunk on the session!
          if (updateExecId) {
            addKnownForeignExecutionId(updateExecId)
          }
          activeRun!.foreignTurnActiveUntilRootBound = true
          return
        }

        const hasConcurrentRun = self.hasOtherActiveRunOnSession(activeRun!)
        const canBindFromInitialUpdate =
          updateExecId !== undefined &&
          !activeRun!.resumedExistingSession &&
          activeRun!.steeredInputs.size === 0 &&
          !activeRun!.foreignTurnActiveUntilRootBound &&
          !hasConcurrentRun

        if (canBindFromInitialUpdate) {
          self.bindRootExecutionId(activeRun!, input, updateExecId)
          yield* drainStagedPreBindNotes()
          yield* projectValidatedFrame(validated)
          return
        }

        // Execution-less frames arriving while a foreign turn is active belong to the foreign turn
        // and must NEVER be replayed into our subsequently bound root.
        if (activeRun!.foreignTurnActiveUntilRootBound && updateExecId === undefined) {
          return
        }

        if (updateExecId !== undefined) {
          const frameBytes = estimateJsonPayloadBytes(
            validated.message,
            AGY_MAX_STAGED_PRE_BIND_BYTES,
          )
          const nextStagedBytes = stagedPreBindBytes + frameBytes
          if (
            activeRun!.stagedPreBindNotifications.length >= AGY_MAX_STAGED_PRE_BIND_FRAMES ||
            nextStagedBytes > AGY_MAX_STAGED_PRE_BIND_BYTES
          ) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity pre-bind staged updates exceeded working-memory budget.',
              false,
            )
          }
          stagedPreBindMemoryReservation?.resize(nextStagedBytes)
          stagedPreBindBytes = nextStagedBytes
          activeRun!.stagedPreBindNotifications.push({
            frame: validated,
            bytes: frameBytes,
            arrivedDuringForeignTurn: activeRun!.foreignTurnActiveUntilRootBound,
          })
          return
        }

        yield* projectValidatedFrame(validated)
      }

      const routePostCutoffIngress = (item: AgyIngress): void => {
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return
        }
        if (item.kind !== 'notification') return
        if (asString(Reflect.get(item.message, 'method')) !== 'session/update') return
        const params = Reflect.get(item.message, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== resolvedSessionId || !isPlainObject(params.update)) return
        enqueuePostCutoffBackgroundUpdate(params, params.update)
      }

      const dispatchOrderedIngress = (item: AgyIngress): void => {
        if (item.kind === 'end') {
          streamEnded = true
          if (promptCutoffSeq === undefined) {
            if (promptRpcResolvedResponse && !promptSettled) {
              settlePromptFromResponse(promptRpcResolvedResponse)
            } else if (!promptError) {
              if (!activeRun!.turnAccepted && connection.isOpen) {
                void connection
                  .notify('session/cancel', { sessionId: resolvedSessionId! }, {})
                  .catch(() => undefined)
              }
              promptError ??= new AgentExecutionError(
                item.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
                item.detail ?? 'Antigravity session stream ended before prompt settlement.',
                item.cause === 'deadline',
              )
              promptSettled = true
              promptReplyReceived = true
              abortOutstandingInteractions()
              if (activeRun) {
                activeRun.promptReplyReceived = true
                this.notifyRootExecutionWaiters(activeRun)
              }
              promptRpcAbort.abort()
              notifyEventLoop()
            }
          }
          return
        }

        if (item.kind === 'reply') {
          if (item.requestId === promptOp.requestId && promptCutoffSeq === undefined) {
            promptCutoffSeq = item.seq
            settlePromptFromResponse(item.message)
          }
          return
        }

        // Strict stdout-order post-cutoff routing: even while foreground is still yielding or
        // awaiting `waitForRootOutput()` / `recordingTail`, post-cutoff updates flow immediately
        // into the serialized background observer without blocking or contaminating foreground state.
        if (promptCutoffSeq !== undefined) {
          routePostCutoffIngress(item)
          return
        }

        // Pre-cutoff ordered frame (`item.seq < promptCutoffSeq`).
        mcpServer.beginWakeBatch()
        try {
          if (item.kind === 'server_request') {
            handleOrderedServerRequest(item)
            return
          }
          if (!rootFirstByteWritten && item.kind === 'notification') {
            const method = asString(Reflect.get(item.message, 'method'))
            const params = Reflect.get(item.message, 'params')
            const update = isPlainObject(params) ? Reflect.get(params, 'update') : undefined
            const sessionUpdate = isPlainObject(update) ? asString(update.sessionUpdate) : undefined
            if (
              method === 'session/update' &&
              (!sessionUpdate || !AGY_SESSION_METADATA_UPDATES.has(sessionUpdate))
            ) {
              if (resolvedSessionId !== undefined) {
                observePrePromptNotification(item.message, resolvedSessionId)
              }
              return
            }
          }
          const validated = validateAgyFrame(
            item,
            resolvedSessionId,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          for (const ev of admitAndProjectValidatedFrame(this, validated)) {
            pushPendingEvent(ev)
          }
        } finally {
          mcpServer.endWakeBatch()
        }
      }

      // Zero-gap handoff from `orderedStream` to `subscribeBackground` when retaining background tasks:
      // 1. Arm `subscribeBackground` FIRST (so no subsequent stdout frame can slip through).
      // 2. Synchronously drain all buffered post-cutoff frames from `sessionStream.shift()`.
      // 3. Close `sessionStream`.
      handoffOrderedStreamToBackground = (): void => {
        if (!activeRun || unsubscribeBackground) return
        const trackedRun = activeRun
        const trackedSessionId = resolvedSessionId!
        unsubscribeBackground = connection.subscribeBackground((message) => {
          if (asString(Reflect.get(message, 'method')) !== 'session/update') {
            return false
          }
          const params = Reflect.get(message, 'params')
          if (!isPlainObject(params)) return false
          const sid = asString(params.sessionId ?? params.session_id)
          if (sid !== trackedSessionId) return false
          const update = params.update
          if (!isPlainObject(update)) return false

          // Explicitly different execution, session, trajectory, step lower bound, or progressToken
          // ALWAYS vetoes alias matches!
          const ownership = validateBackgroundUpdateForRun(
            params,
            update,
            trackedRun,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          if (!ownership.valid) {
            return false
          }

          let hasNewerActiveRun = false
          for (const other of this.activeRuns.values()) {
            if (
              other !== trackedRun &&
              other.nativeSessionId === trackedSessionId &&
              !other.rootTerminal
            ) {
              hasNewerActiveRun = true
              break
            }
          }
          if (hasNewerActiveRun) {
            // Even after a newer foreground Run starts on the same nativeSessionId, allow the older
            // retained Run to consume updates ONLY when validated owner matches AND aliases/execution match.
            const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
            const taskId =
              asString(update.taskId ?? update.backgroundTaskId) ??
              (rawOutput ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId) : undefined)
            const toolCallId = asString(update.toolCallId ?? update.id)
            const execId = ownership.executionId
            const explicitlyOwnedByOldRun =
              (taskId !== undefined &&
                (trackedRun.backgroundTaskAliases.has(taskId) ||
                  trackedRun.activeBackgroundTasks.has(taskId))) ||
              (toolCallId !== undefined &&
                (trackedRun.backgroundTaskAliases.has(toolCallId) ||
                  trackedRun.activeBackgroundTasks.has(toolCallId))) ||
              (execId !== undefined &&
                trackedRun.providerExecutionId !== undefined &&
                execId === trackedRun.providerExecutionId)
            if (!explicitlyOwnedByOldRun) {
              return false
            }
          }
          enqueuePostCutoffBackgroundUpdate(params, update, ownership)
          return true
        })

        if (sessionStream) {
          while (true) {
            const buffered = sessionStream.shift()
            if (!buffered) break
            if (promptCutoffSeq !== undefined && buffered.seq <= promptCutoffSeq) continue
            routePostCutoffIngress(buffered)
          }
          sessionStream.close()
          sessionStream = undefined
        }
      }

      // Continuous async frame pump over `sessionStream` with bounded backpressure on `pendingEvents`.
      const isPumpActive = (): boolean =>
        !pumpAbort.signal.aborted && !streamEnded && sessionStream !== undefined
      void (async () => {
        try {
          while (isPumpActive()) {
            if (isPendingEventsAtSoftCap() && promptCutoffSeq === undefined) {
              // oxlint-disable-next-line no-await-in-loop -- Apply backpressure to ordered stream when generator consumer lags.
              await new Promise<void>((resolveDrain) => {
                wakePumpForBackpressure = resolveDrain
                if (!isPumpActive() || !isPendingEventsAtSoftCap()) {
                  wakePumpForBackpressure = undefined
                  resolveDrain()
                }
              })
              if (!isPumpActive()) break
            }
            let drainedAny = false
            const canDrainPendingIngress = (): boolean =>
              !isPendingEventsAtSoftCap() || promptCutoffSeq !== undefined
            while (isPumpActive() && canDrainPendingIngress()) {
              const buffered = sessionStream?.shift()
              if (!buffered) break
              drainedAny = true
              dispatchOrderedIngress(buffered)
            }
            if (!isPumpActive() || !sessionStream) break
            if (drainedAny) continue
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Continuous ordered ingress pump independent of generator yield backpressure.
              nextItem = await sessionStream.nextIngress(undefined, pumpAbort.signal)
            } catch (waitErr) {
              if (pumpAbort.signal.aborted) break
              const err = waitErr instanceof Error ? waitErr : new Error(String(waitErr))
              if (promptCutoffSeq === undefined) {
                if (!activeRun.turnAccepted && connection.isOpen) {
                  void connection
                    .notify('session/cancel', { sessionId: resolvedSessionId }, {})
                    .catch(() => undefined)
                }
                promptError ??= err
                promptSettled = true
                promptReplyReceived = true
                abortOutstandingInteractions()
                if (activeRun) {
                  activeRun.promptReplyReceived = true
                  this.notifyRootExecutionWaiters(activeRun)
                }
                promptRpcAbort.abort()
                notifyEventLoop()
              }
              break
            }
            dispatchOrderedIngress(nextItem)
          }
        } catch (err) {
          pumpError ??= err instanceof Error ? err : new Error(String(err))
          promptError ??= pumpError
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.notifyRootExecutionWaiters(activeRun)
          }
          promptRpcAbort.abort()
          notifyEventLoop()
        }
      })()

      try {
        while (true) {
          while (pendingEvents.length > 0) {
            const nextEv = shiftPendingEvent()
            if (nextEv) yield nextEv
          }
          if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
            for (const ev of drainStagedPreBindNotes()) {
              yield ev
            }
          }
          if (promptSettled) {
            while (pendingEvents.length > 0) {
              const nextEv = shiftPendingEvent()
              if (nextEv) yield nextEv
            }
            if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
              for (const ev of drainStagedPreBindNotes()) {
                yield ev
              }
            }
            break
          }
          // oxlint-disable-next-line no-await-in-loop -- Generator yields events as the independent frame pump pushes them.
          await new Promise<void>((resolveWake) => {
            wakeEventLoop = resolveWake
          })
        }

        // Fence steer dispatch BEFORE releasing the root Turn, and verify any dispatched steer receipts.
        rootReleasing = true
        activeRun.rootReleasing = true
        signal.removeEventListener('abort', onCallerAbort)
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }

        if (pumpError) {
          promptError = pumpError
        }
        if (promptError) {
          promptRpcAbort.abort()
          const physical = await awaitPhysicalCompletionBounded(promptOp.physicalOutcome)
          if (physical === 'not_sent' && !rootFirstByteWritten) {
            rootConfirmedNotSent = true
            input.recordDispatch?.('rejected', resolvedSessionId, activeExecutorId)
            if (input.recovery && appliedSettings) {
              const unsent = createAgyRootFrameNotWrittenProof({
                runId: input.runId,
                bindingGeneration: input.bindingGeneration ?? 1,
                nativeGeneration: input.nativeGeneration ?? input.runId,
                executorId: activeExecutorId,
                nativeSessionId: resolvedSessionId,
                inputSha256: input.recovery.inputSha256,
                appliedSettings,
                requestId: promptOp.requestId,
                physicalCompletion: physical,
              })
              if (unsent) {
                input.recovery.recordConfirmedUnsent(unsent.boundary, {
                  executorId: activeExecutorId,
                  nativeSessionId: resolvedSessionId,
                })
              }
            }
            if (rootWithheldByGuard) {
              throw new NativeInputWithheldError(
                'Antigravity root prompt was withheld by the recovery dispatch guard before any byte was written.',
              )
            }
          } else if (physical === 'invalid_reply') {
            reportUnknown(
              'Antigravity received an invalid session/prompt response after request bytes were written.',
            )
          } else {
            reportUnknown(
              userCancelRequested
                ? 'Antigravity cancellation did not receive a confirmed native terminal settlement.'
                : !activeRun.turnAccepted
                  ? 'Antigravity prompt write started without Turn acceptance confirmation.'
                  : 'Antigravity Turn ended without confirmed native terminal settlement.',
            )
          }
          throw promptError
        }

        const parsedTerminal =
          parsedPromptTerminalReply ??
          parseAgyPromptTerminalReply(promptResponse, resolvedSessionId)
        if (!parsedTerminal.ok) {
          reportUnknown(parsedTerminal.reason)
          throw new AgentExecutionError('protocol_error', parsedTerminal.message, false)
        }
        const stopReason = parsedTerminal.stopReason
        const respExecId = parsedTerminal.executionId
        if (respExecId) {
          if (activeRun.knownForeignExecutionIds.has(respExecId)) {
            reportUnknown(
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
              false,
            )
          }
          if (activeRun.providerExecutionId && activeRun.providerExecutionId !== respExecId) {
            reportUnknown(
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
              false,
            )
          }
          this.bindRootExecutionId(activeRun, input, respExecId)
        }
        this.notifyRootExecutionWaiters(activeRun)

        if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
          for (const ev of drainStagedPreBindNotes()) {
            yield ev
          }
        }
        if (!activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
          const hasSubstantiveUnresolved = activeRun.stagedPreBindNotifications.some((staged) => {
            const execId = staged.frame.executionId
            if (execId !== undefined && activeRun!.knownForeignExecutionIds.has(execId)) {
              return false
            }
            if (staged.arrivedDuringForeignTurn) return false
            const kind = staged.frame.sessionUpdate
            return (
              kind === 'agent_message_chunk' ||
              kind === 'agent_thought_chunk' ||
              kind === 'tool_call' ||
              kind === 'tool_call_update' ||
              kind === 'background_task_completed'
            )
          })
          if (hasSubstantiveUnresolved) {
            unresolvedPreBindOutput = true
            reportUnknown(
              'Antigravity terminal reply completed without binding execution_id for staged updates; output completeness cannot be confirmed.',
            )
          }
        }
        clearStagedPreBindNotifications()

        if (!activeRun.turnAccepted) {
          activeRun.turnAccepted = true
          input.recordDispatch?.('accepted', resolvedSessionId, activeExecutorId)
          yield { agentId: 'agy', type: 'turn.started', turnId: input.runId }
        }

        if (activeRun.pendingSteerOperations.size > 0) {
          await Promise.allSettled(activeRun.pendingSteerOperations)
        }

        const postReplyCheckSignal = stopReason === 'cancelled' ? signal : observation.signal

        // Verify any in-Turn steer writes before releasing the root Turn (`B8`).
        await this.verifySteerReceiptsBeforeRootRelease(
          activeRun,
          input,
          reportUnknown,
          postReplyCheckSignal,
        )

        // Complete any open reasoning items.
        for (const [idxKey, text] of reasoningItems) {
          if (text) {
            yield {
              agentId: 'agy',
              type: 'reasoning.summary.completed',
              turnId: input.runId,
              activityId: `${input.runId}:thought:${idxKey}`,
              text,
            }
          }
        }
        reasoningItems.clear()

        // If a brain plan write was touched and did not capture inline (or readback was latched due to
        // overlapping ops / deferred edit readback), inspect through the isolated storage client
        // (NEVER direct Utility `fs.open`!) for the SAME execution.
        if (
          planModeStage &&
          (latestBrainPlanCandidate === undefined || brainPlanReadbackRequired) &&
          !brainPlanCaptureFailed
        ) {
          if (brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
            const inspected = this.options.storageClient?.inspectRun
              ? await this.options.storageClient
                  .inspectRun(
                    {
                      appDataDir: this.primaryAppDataDir,
                      cwd: lease.canonicalCwd,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
              : await this.getOwnedForkFiles()
                  .inspectAgyRun(
                    {
                      cwd: lease.canonicalCwd,
                      storageRoot: this.primaryAppDataDir,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
            const terminal = inspected?.exists ? inspected.terminalState : undefined
            const matchesExecution =
              terminal !== undefined &&
              !terminal.planUnavailable &&
              (activeRun.providerExecutionId === undefined ||
                terminal.executionId === activeRun.providerExecutionId)
            if (matchesExecution && terminal.plan?.text.trim()) {
              latestBrainPlanCandidate = {
                nativeId:
                  terminal.plan.nativeId ||
                  buildBoundedNativePlanId(resolvedSessionId, 'implementation_plan'),
                text: terminal.plan.text,
              }
              brainPlanReadbackRequired = false
              input.recordWorkflowPlan?.(latestBrainPlanCandidate)
            } else {
              brainPlanCaptureFailed = true
              latestBrainPlanCandidate = undefined
              input.recordWorkflowPlanUnavailable?.()
            }
          }
        }

        await recordingTail
        await input.waitForRootOutput?.()
        await postCutoffBackgroundTail

        const finalSnapshot = answer.finalize()
        if (finalSnapshot !== undefined && !unresolvedPreBindOutput) {
          yield {
            agentId: 'agy',
            type: 'text.completed',
            turnId: input.runId,
            outputId: answer.outputId,
            text: finalSnapshot,
          }
        }

        // Preserve verified native `stopReason` (`end_turn` -> `completed`) even if Stop (`signal.aborted`)
        // arrived late while draining foreground output!
        const outcome: 'completed' | 'interrupted' | 'failed' =
          stopReason === 'cancelled'
            ? 'interrupted'
            : stopReason === 'end_turn' || stopReason === 'stop_sequence'
              ? 'completed'
              : 'failed'

        // Record negative plan unavailability OUTSIDE `!unknownEffectsReported` so recovery is never
        // suppressed when an open-mode final `publish_plan` was acknowledged without confirmed ACP promotion
        // or when a Phase-1 brain plan write failed.
        if (outcome === 'completed') {
          if (planModeStage) {
            if (
              hasUnresolvedBrainPlanWrite() ||
              brainPlanCaptureFailed ||
              brainPlanReadbackRequired
            ) {
              input.recordWorkflowPlanUnavailable?.()
            }
          } else if (
            openPlanPublishFailed ||
            (mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan)
          ) {
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.recordWorkflowPlanUnavailable?.()
            }
          }
        }

        // Promote collaboration artifacts ONLY after normal root completion & settlement (`B6`).
        if (outcome === 'completed' && !unknownEffectsReported && !unresolvedPreBindOutput) {
          if (planModeStage) {
            if (
              !hasUnresolvedBrainPlanWrite() &&
              !brainPlanCaptureFailed &&
              !brainPlanReadbackRequired
            ) {
              if (latestBrainPlanCandidate) {
                yield {
                  agentId: 'agy',
                  type: 'collaboration.plan',
                  turnId: input.runId,
                  nativeId: latestBrainPlanCandidate.nativeId,
                  text: latestBrainPlanCandidate.text,
                }
              } else if (planRetained && authorization?.planReference) {
                const planDoc = authorization.planReference.document
                input.recordWorkflowPlanRetained?.({
                  nativeId: buildBoundedNativePlanId(resolvedSessionId, 'retained'),
                  sha256: planDoc.sha256,
                  bytes: planDoc.bytes,
                  chars: planDoc.chars,
                  confirmation: 'native_root_settled_v1',
                })
              }
            }
          } else if (
            !openPlanPublishFailed &&
            !(mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan) &&
            publishedOpenPlan
          ) {
            yield {
              agentId: 'agy',
              type: 'collaboration.plan',
              turnId: input.runId,
              nativeId: publishedOpenPlan.nativeId,
              text: publishedOpenPlan.text,
            }
          }
          if (reviewResult) {
            yield {
              agentId: 'agy',
              type: 'collaboration.review',
              turnId: input.runId,
              verdict: reviewResult.verdict,
              ...(reviewResult.questions ? { questions: reviewResult.questions } : {}),
            }
          }
        }

        rootTerminal = true
        activeRun.rootTerminal = true

        const settledPlan = latestBrainPlanCandidate ?? publishedOpenPlan
        const outputCompleteness: 'complete' | 'partial' =
          outcome === 'completed' && !unresolvedPreBindOutput ? 'complete' : 'partial'
        const terminalEvidence: Parameters<AgyAgentAdapter['recordEvidence']>[3] = {
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          ...(answer.text || (outcome === 'completed' && !unresolvedPreBindOutput && settledPlan)
            ? {
                output: {
                  outputId: answer.outputId,
                  text: answer.text,
                  completeness: outputCompleteness,
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && settledPlan
                    ? { plan: settledPlan }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && reviewResult
                    ? { reviewVerdict: reviewResult.verdict, reviewResult }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && inputResult
                    ? { inputOutcome: inputResult.outcome, inputResult }
                    : {}),
                },
              }
            : {}),
        }

        if (unresolvedPreBindOutput && outcome === 'completed') {
          // When unresolved substantive pre-bind frames remain after emitting a visible prefix,
          // emit `turn.completed { outcome: 'failed' }` (without `text.completed`) so SQLite marks
          // the truncated prefix `incomplete`, then record the independently verified native
          // outcome with `completeness: 'partial'` so `nativeOutcome` stays preserved.
          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome: 'failed',
          }
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )
        } else {
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )

          if (
            !unknownEffectsReported &&
            !unresolvedPreBindOutput &&
            !activeRun.backgroundUnconfirmed &&
            activeRun.activeBackgroundTasks.size === 0
          ) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }

          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome,
          }
        }
      } finally {
        clearPendingEvents()
        clearStagedPreBindNotifications()
        prePromptReplayedToolCallIds.clear()
        answer.dispose()
      }
    } catch (error) {
      rootTerminal = true
      if (activeRun) {
        activeRun.rootTerminal = true
        this.notifyRootExecutionWaiters(activeRun)
      }
      if (cancelGraceTimer !== undefined) {
        clearTimeout(cancelGraceTimer)
        cancelGraceTimer = undefined
      }
      promptRpcAbort.abort()
      await stopPrePromptDrain?.(false).catch(() => undefined)
      stopStreamPump?.()
      this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      await recordingTail.catch(() => undefined)
      const confirmedZeroBytesSent = isConfirmedZeroBytesSent()
      if (!unknownEffectsReported) {
        if (confirmedZeroBytesSent) {
          if (activeRun) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }
        } else {
          reportUnknown(
            unknownEffectsReason ??
              'Antigravity failed before its native Turn effects could be confirmed.',
          )
        }
      }
      throw error
    } finally {
      await finalizeRun({ emergency: false })
    }
  }

  async steer(steerInput: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult> {
    if (signal.aborted || this.disposed) {
      return { status: 'rejected', reason: 'Antigravity steer request was cancelled.' }
    }
    const activeRun = this.activeRuns.get(steerInput.runId)
    if (
      !activeRun ||
      !activeRun.isSteerLeaseOpen() ||
      activeRun.steeringInFlight ||
      activeRun.nativeSessionId !== steerInput.nativeSessionId ||
      activeRun.bindingGeneration !== steerInput.bindingGeneration ||
      activeRun.nativeGeneration !== steerInput.nativeGeneration ||
      (steerInput.nativeTurnId !== activeRun.nativeTurnId &&
        steerInput.nativeTurnId !== steerInput.runId)
    ) {
      return {
        status: 'rejected',
        reason: 'The Antigravity root Turn lease is not active for steering.',
      }
    }
    if (activeRun.steeredInputs.size >= AGY_MAX_STEERING_INPUTS) {
      return {
        status: 'rejected',
        reason: 'Antigravity reached the maximum in-Turn steer input limit (63).',
      }
    }

    // Re-verify explicit /skill selections before steering.
    if (steerInput.promptEnvelope.skillInvocation) {
      const hasAgySkill = steerInput.promptEnvelope.skillInvocation.bindings.some(
        (b) => b.agentId === 'agy',
      )
      if (hasAgySkill) {
        try {
          const catalog = await this.discoverSkills(activeRun.connection.canonicalCwd, signal)
          bindAgySkillSelections(steerInput.promptEnvelope.skillInvocation.bindings, catalog)
        } catch (error) {
          return {
            status: 'rejected',
            reason: error instanceof Error ? error.message : 'Selected Skill is unavailable.',
          }
        }
      }
    }

    const images: AgentPromptImage[] = []
    for (const group of agentPromptImageGroups(steerInput.promptEnvelope)) {
      images.push(...group.images)
    }
    let reservation: NativeMemoryReservation | undefined
    activeRun.steeringInFlight = true
    const entry: AgySteerEntry = {
      request: steerInput,
      dispatched: false,
      consumed: false,
      settled: false,
    }
    activeRun.steeredInputs.set(steerInput.inputId, entry)

    let releaseSteerSettlement: (() => void) | undefined
    const steerSettlement = new Promise<void>((resolveSteer) => {
      releaseSteerSettlement = resolveSteer
    })
    activeRun.pendingSteerOperations.add(steerSettlement)

    try {
      reservation = activeRun.connection.reserveWorkingMemory(
        32 * 1024 + nativeImagePreparationBytes(images),
      )
      const promptBlocks = await agyPromptInput(steerInput.promptEnvelope, signal)
      if (!activeRun.isSteerLeaseOpen()) {
        activeRun.steeredInputs.delete(steerInput.inputId)
        return {
          status: 'rejected',
          reason: 'The Antigravity root Turn closed before steer dispatch.',
        }
      }

      const op = activeRun.connection.requestOwned(
        'session/prompt',
        {
          sessionId: activeRun.nativeSessionId,
          prompt: promptBlocks,
          _meta: { pactSteerInputId: steerInput.inputId },
        },
        {
          timeoutMs: AGY_PROMPT_ACCEPT_TIMEOUT_MS,
          signal,
          canDispatch: () => !this.disposed && !signal.aborted && activeRun.isSteerLeaseOpen(),
          onDispatch: () => {
            entry.dispatched = true
            reservation?.release()
            reservation = undefined
            steerInput.recordDispatch('possibly_sent')
          },
        },
      )

      let rpcResponse: object | undefined
      let rpcFailure: Error | undefined
      try {
        rpcResponse = await op.result
      } catch (err) {
        rpcFailure = err instanceof Error ? err : new Error(String(err))
      }

      if (rpcFailure) {
        const physical = await awaitPhysicalCompletionBounded(op.physicalOutcome)
        if (physical === 'not_sent' && !entry.dispatched) {
          entry.settled = true
          activeRun.steeredInputs.delete(steerInput.inputId)
          steerInput.recordDispatch('rejected')
          return { status: 'rejected', reason: rpcFailure.message }
        }
        // Frame bytes crossed into NativeFrameWriter without an in-Turn receipt -> unconfirmed!
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer frame was written without a confirmed in-Turn consumption receipt.',
          false,
        )
      }

      const rpcError = rpcResponse ? Reflect.get(rpcResponse, 'error') : undefined
      const rpcResult = rpcResponse ? Reflect.get(rpcResponse, 'result') : undefined
      if (rpcError || !isPlainObject(rpcResult)) {
        if (!entry.dispatched) {
          entry.settled = true
          activeRun.steeredInputs.delete(steerInput.inputId)
          steerInput.recordDispatch('rejected')
          return { status: 'rejected', reason: 'Antigravity rejected the steer request.' }
        }
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity rejected or closed steer after dispatch without confirming receipt.',
          false,
        )
      }

      // Stage in-Turn consumption receipt (`step_idx` + `execution_id`); NEVER bind `activeRun.executionId`
      // from a Steer RPC reply when `!activeRun.executionId`!
      const resultStepIdx = Reflect.get(rpcResult, 'stepIdx') ?? Reflect.get(rpcResult, 'step_idx')
      const resultExecId = asString(
        Reflect.get(rpcResult, 'executionId') ?? Reflect.get(rpcResult, 'execution_id'),
      )
      if (
        typeof resultStepIdx === 'number' &&
        Number.isSafeInteger(resultStepIdx) &&
        resultStepIdx >= 0 &&
        resultExecId
      ) {
        entry.candidateStepIdx = resultStepIdx
        entry.candidateExecutionId = resultExecId
      }

      if (!entry.consumed && !activeRun.rootTerminal && activeRun.providerExecutionId) {
        this.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
      }

      if (
        !entry.consumed &&
        this.options.storageClient?.verifySteerConsumption &&
        !activeRun.rootTerminal
      ) {
        const verified = await this.options.storageClient.verifySteerConsumption(
          {
            appDataDir: this.primaryAppDataDir,
            cwd: activeRun.cwd,
            nativeSessionId: activeRun.nativeSessionId,
            nativeTurnId: activeRun.runId,
            executionId: activeRun.providerExecutionId,
            inputId: steerInput.inputId,
            minStepIdx: activeRun.rootStepIdx,
          },
          signal,
        )
        if (verified.consumed && verified.executionId !== undefined) {
          if (!activeRun.providerExecutionId) {
            activeRun.providerExecutionId = verified.executionId
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (
            verified.executionId === activeRun.providerExecutionId &&
            (entry.candidateExecutionId === undefined ||
              entry.candidateExecutionId === activeRun.providerExecutionId) &&
            typeof verified.stepIdx === 'number' &&
            this.isValidSteerStepOrder(activeRun, steerInput.inputId, verified.stepIdx)
          ) {
            entry.stepIdx = verified.stepIdx
            entry.executionId = verified.executionId
            entry.consumed = true
          }
        }
      }

      // If Steer replied early before independent root `providerExecutionId` arrived, wait boundedly for root binding.
      if (
        !entry.consumed &&
        !activeRun.providerExecutionId &&
        entry.candidateExecutionId !== undefined &&
        !activeRun.rootReleasing &&
        !activeRun.rootTerminal
      ) {
        await this.waitForRootExecutionBinding(activeRun, signal)
        if (!activeRun.rootTerminal && activeRun.providerExecutionId) {
          this.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
        }
      }

      if (
        !entry.consumed ||
        activeRun.rootTerminal ||
        !activeRun.providerExecutionId ||
        entry.executionId !== activeRun.providerExecutionId
      ) {
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer crossed the root Turn boundary without an in-Turn (step_idx, execution_id) consumption receipt.',
          false,
        )
      }

      entry.settled = true
      steerInput.recordDispatch('accepted')
      steerInput.recordConsumption(steerInput.inputId)
      return { status: 'accepted' }
    } finally {
      reservation?.release()
      activeRun.steeringInFlight = false
      activeRun.pendingSteerOperations.delete(steerSettlement)
      releaseSteerSettlement?.()
    }
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeStatus(input, checkSignal),
      context,
    )
  }

  async probeNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    signal.throwIfAborted()
    if (input.target === 'initialized_binding') {
      return this.probeInitializedBinding(input, signal)
    }

    const identity = this.toEvidenceIdentity(input)
    if (input.runId) {
      const live = this.activeRuns.get(input.runId)
      const cached = this.nativeEvidence.get(this.evidenceKey(input.runId, input.nativeSessionId))
      if (
        live &&
        live.nativeSessionId === input.nativeSessionId &&
        (!input.executorId || live.executorId === input.executorId) &&
        !live.rootTerminal
      ) {
        if (cached && (cached.kind === 'running' || cached.kind === 'waiting_user')) {
          return {
            ...cached,
            identity: {
              ...cached.identity,
              requestId: input.requestId,
            },
          }
        }
        return {
          kind: 'running',
          identity: {
            ...identity,
            executorId: live.executorId,
            nativeTurnId: live.nativeTurnId,
          },
          source: 'live_runtime',
        }
      }
      if (
        cached &&
        cached.kind === 'ended' &&
        (!input.executorId || cached.identity.executorId === input.executorId) &&
        !(input.inspectMissingPlan && !cached.output?.plan)
      ) {
        return {
          ...cached,
          identity: {
            ...cached.identity,
            requestId: input.requestId,
          },
        }
      }
    }

    if (input.confirmedTerminal && !input.inspectMissingPlan) {
      return {
        ...input.confirmedTerminal,
        identity: {
          ...input.confirmedTerminal.identity,
          requestId: input.requestId,
        },
      }
    }

    if (this.options.storageClient?.probeSessionStatus) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const probed = await this.options.storageClient.probeSessionStatus(
        {
          ...input,
          appDataDir: this.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      return {
        ...probed,
        identity: {
          ...probed.identity,
          ...identity,
          ...((identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId)
            ? {
                nativeTurnId:
                  identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId,
              }
            : {}),
        },
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Cold Antigravity SQLite trajectory inspection is not configured on this Adapter.',
    }
  }

  private async probeInitializedBinding(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    const identity = this.toEvidenceIdentity(input)
    if (this.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId,
          sourceHash: input.confirmedInitialization.sourceHash,
          chunks: input.source,
        },
        signal,
      )
      if (inspected.verified && inspected.initializationWitness) {
        return {
          kind: 'binding_ready',
          identity,
          source: 'completed_initialization_readback',
          rebuildId: input.confirmedInitialization.rebuildId,
          sourceHash: input.confirmedInitialization.sourceHash,
          witness: inspected.initializationWitness,
        }
      }
      this.nativeRebuildReceipts.delete(input.confirmedInitialization.rebuildId)
      return {
        kind: 'no_evidence',
        identity,
        reason: 'Antigravity rebuild binding could not be verified from cold readback.',
      }
    }

    const receipt = this.nativeRebuildReceipts.get(input.confirmedInitialization.rebuildId)
    if (
      receipt &&
      receipt.nativeSessionId === input.nativeSessionId &&
      Boolean(receipt.initializationWitness) &&
      (!receipt.sourceHash || receipt.sourceHash === input.confirmedInitialization.sourceHash)
    ) {
      return {
        kind: 'binding_ready',
        identity,
        source: 'completed_initialization_readback',
        rebuildId: input.confirmedInitialization.rebuildId,
        sourceHash: input.confirmedInitialization.sourceHash,
        witness: receipt.initializationWitness!,
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Antigravity rebuild binding could not be verified from cold readback.',
    }
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeInputs(input, checkSignal),
      context,
    )
  }

  async probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (input.unresolvedInputIds.length === 0) return
    if (input.unresolvedInputIds.length > 64) {
      throw new AgentExecutionError(
        'protocol_error',
        'Too many unresolved Antigravity steer input candidates.',
        false,
      )
    }
    if (input.runId) {
      const live = this.activeRuns.get(input.runId)
      if (live) {
        for (const id of input.unresolvedInputIds) {
          if (live.steeredInputs.get(id)?.consumed) {
            input.recordConsumption(id)
          }
        }
      }
    }
    if (this.options.storageClient?.probeInputReceipts) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const consumed = await this.options.storageClient.probeInputReceipts(
        {
          ...input,
          appDataDir: this.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      const allowed = new Set(input.unresolvedInputIds)
      for (const id of consumed) {
        if (allowed.has(id)) input.recordConsumption(id)
      }
    }
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.inspectNativeRebuild(input, source, checkSignal),
      context,
    )
  }

  async inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    signal.throwIfAborted()
    const receipt = this.nativeRebuildReceipts.get(input.rebuildId)
    const targetSessionId = input.nativeSessionId ?? receipt?.nativeSessionId
    if (targetSessionId && this.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: targetSessionId,
          sourceHash: input.sourceHash,
          chunks: source,
        },
        signal,
      )
      if (inspected.verified && (!input.sourceHash || Boolean(inspected.initializationWitness))) {
        return {
          nativeSessionId: targetSessionId,
          ...(inspected.initializationWitness
            ? { initializationWitness: inspected.initializationWitness }
            : {}),
        }
      }
      this.nativeRebuildReceipts.delete(input.rebuildId)
      return undefined
    }
    if (
      receipt &&
      (!input.nativeSessionId || receipt.nativeSessionId === input.nativeSessionId) &&
      (!input.sourceHash ||
        (receipt.sourceHash === input.sourceHash && Boolean(receipt.initializationWitness)))
    ) {
      return {
        nativeSessionId: receipt.nativeSessionId,
        ...(receipt.initializationWitness
          ? { initializationWitness: receipt.initializationWitness }
          : {}),
      }
    }
    return undefined
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.writeRebuildSeed) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity zero-Turn Rebuild storage writer is not configured.',
        false,
      )
    }

    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode ?? 'ask',
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `rebuild:${input.rebuildId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode ?? 'ask',
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      if (!candidateSessionId) {
        await input.onNativeCreationDispatched?.(executorId)
        candidateSessionId = await this.allocateZeroTurnSessionShell(lease, signal, {
          onCreationDispatched: () => {
            creationPossiblyDelivered = true
          },
          onCreationRejectedByServer: () => {
            creationPossiblyDelivered = false
          },
          onSessionAllocated: async (allocatedId) => {
            candidateSessionId = allocatedId
            controlOwner?.updateSessionId(allocatedId)
            await input.onNativeSessionCreated?.(allocatedId)
          },
        })
      }

      const resolveImage = input.resolveImage
      const bufferedChunks: NativeContextRebuildChunk[] = []
      const resolvedRecords: AgyRebuildSeedChunkRecord[] = []
      for await (const chunk of source) {
        signal.throwIfAborted()
        bufferedChunks.push(chunk)
        const resolvedImages = new Map<string, AgentPromptImage>()
        if (resolveImage && chunk.kind === 'image') {
          const resolved = await resolveImage(chunk.image.id, signal)
          requireNativeImageReference(resolved, chunk.image)
          resolvedImages.set(chunk.image.id, resolved)
        }
        resolvedRecords.push({ chunk, resolvedImages })
      }

      const written = await this.options.storageClient.writeRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
          chunks: (async function* () {
            yield* resolvedRecords
          })(),
        },
        signal,
      )

      // Cold `session/load` + `session/close` verification (0 model invocations!).
      await this.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: written.stepCount > 0,
        forbidToolUpdates: true,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      // Seal cold-load verification receipt ONLY AFTER zero-Turn `session/load` + `session/close` succeeds!
      let finalWitness: NativeInitializationWitness | undefined
      if (this.options.storageClient.confirmRebuildColdLoad) {
        if (!input.sourceHash) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity zero-Turn Rebuild cold-load confirmation requires a sourceHash.',
            false,
          )
        }
        const pbSha256 = written.pbSha256 ?? written.verifiedPrefixSha256
        const pbBytes = written.pbBytes ?? written.verifiedPrefixBytes
        if (written.stepCount !== 2 || !pbSha256 || pbBytes <= 0) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity zero-Turn Rebuild seed did not produce a valid 2-step payload.',
            false,
          )
        }
        finalWitness = await this.options.storageClient.confirmRebuildColdLoad(
          {
            cwd: lease.canonicalCwd,
            appDataDir: this.primaryAppDataDir,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            pbSha256,
            pbBytes,
            stepCount: 2,
          },
          signal,
        )
      }

      if (this.options.storageClient.inspectRebuildSeed) {
        const postLoad = await this.options.storageClient.inspectRebuildSeed(
          {
            appDataDir: this.primaryAppDataDir,
            cwd: lease.canonicalCwd,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            chunks: (async function* () {
              yield* bufferedChunks
            })(),
          },
          signal,
        )
        if (!postLoad.verified) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity rebuild seed failed post-load cold verification.',
            false,
          )
        }
        finalWitness = postLoad.initializationWitness ?? finalWitness
      }

      this.rememberRebuildReceipt(input.rebuildId, {
        nativeSessionId: candidateSessionId,
        sourceHash: input.sourceHash,
        seedHash: written.seedHash,
        cwd: lease.canonicalCwd,
        executorId,
        initializationWitness: finalWitness,
      })
      input.reportNativeWork?.({
        executorId,
        nativeSessionId: candidateSessionId,
        state: 'settled',
      })
      return {
        nativeSessionId: candidateSessionId,
        ...(finalWitness ? { initializationWitness: finalWitness } : {}),
      }
    } catch (error) {
      input.reportNativeWork?.({
        executorId,
        ...(candidateSessionId ? { nativeSessionId: candidateSessionId } : {}),
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.prepareFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    return this.options.storageClient.prepareFork(
      { ...input, appDataDir: this.primaryAppDataDir },
      signal,
    )
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.inspectFork) {
      return {
        kind: 'missing',
        reason: 'Antigravity native Fork storage engine is not configured.',
      }
    }
    return this.options.storageClient.inspectFork(
      { ...input, appDataDir: this.primaryAppDataDir },
      signal,
    )
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.writeFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork:${input.operationId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      if (!candidateSessionId) {
        candidateSessionId = await this.allocateZeroTurnSessionShell(lease, signal, {
          onCreationDispatched: () => {
            creationPossiblyDelivered = true
          },
          onCreationRejectedByServer: () => {
            creationPossiblyDelivered = false
          },
          onSessionAllocated: async (allocatedId) => {
            candidateSessionId = allocatedId
            controlOwner?.updateSessionId(allocatedId)
            await input.onCandidate(allocatedId)
          },
        })
      }
      const witness = await this.options.storageClient.writeFork(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          source: input.source,
          onCandidate: input.onCandidate,
        },
        signal,
      )
      await input.onCandidate(candidateSessionId, witness)

      // Cold `session/load` + `session/close` verification with zero model input.
      await this.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: (witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        candidateSessionId,
        witness,
        signal,
      )
      await input.onCandidate(candidateSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: candidateSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({
        executorId,
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!input.nativeSessionId || !input.witness) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity Fork initialization requires an existing verified candidate and witness.',
        false,
      )
    }
    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork-init:${input.operationId}:${randomUUID()}`,
        initialSessionId: input.nativeSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      await this.verifyZeroTurnSessionLoad(lease, input.nativeSessionId, signal, {
        expectReplaySteps: (input.witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        input.nativeSessionId,
        input.witness,
        signal,
      )
      await input.onCandidate(input.nativeSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: input.nativeSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({ executorId, state: 'unknown' })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async closeZeroInputSessions(deadlineAt?: number): Promise<void> {
    const ownedRuns = [...this.ownedRunHandles]
    if (ownedRuns.length === 0) return
    await Promise.allSettled(ownedRuns.map((handle) => handle.closeZeroInputSession(deadlineAt)))
  }

  async dispose(shutdown?: AgentShutdownSettlement): Promise<void> {
    if (this.ownsPool && shutdown?.flushDeadlineAt !== undefined) {
      this.pool.capShutdownDeadline(shutdown.flushDeadlineAt)
    }
    if (this.disposalPromise) {
      return this.disposalPromise
    }
    const runDisposal = (async () => {
      if (shutdown?.foregroundSettlement) {
        const remaining = Math.max(0, shutdown.flushDeadlineAt - Date.now())
        await Promise.race([
          shutdown.foregroundSettlement,
          new Promise<void>((r) => setTimeout(r, remaining)),
        ]).catch(() => undefined)
      }
      this.disposed = true
      this.unsubscribePoolPhysicalOps()
      this.unsubscribeStoragePhysicalOps?.()
      this.nativeChecks.cancel()
      const ownedRuns = [...this.ownedRunHandles]
      for (const handle of ownedRuns) {
        handle.cancel()
      }
      // Give any confirmed zero-byte fresh sessions their single bounded `session/close` chance
      // BEFORE tearing down the ACP connection pool or releasing their leases.
      if (ownedRuns.length > 0) {
        await Promise.allSettled(
          ownedRuns.map((handle) => handle.closeZeroInputSession(shutdown?.flushDeadlineAt)),
        )
      }
      for (const run of this.activeRuns.values()) {
        this.notifyRootExecutionWaiters(run)
        run.observation.abort()
      }
      this.activeRuns.clear()
      this.sessionModes.clear()
      this.nativeRebuildReceipts.clear()
      this.nativeEvidence.clear()
      this.evidenceCacheWork.release()
      const joinOwnedRuns = async (): Promise<void> => {
        if (ownedRuns.length === 0) return
        const waitMs =
          shutdown?.flushDeadlineAt !== undefined
            ? Math.max(0, shutdown.flushDeadlineAt - Date.now())
            : AGY_PHYSICAL_SETTLEMENT_GRACE_MS
        let settledInTime = false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.allSettled(ownedRuns.map((handle) => handle.finalized)).then(() => {
              settledInTime = true
              return undefined
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs)
              timer.unref?.()
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (!settledInTime) {
          const lingering = ownedRuns.filter((handle) => this.ownedRunHandles.has(handle))
          await Promise.allSettled(lingering.map((handle) => handle.forceCleanup()))
          if (lingering.length > 0 && shutdown?.flushDeadlineAt !== undefined) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity adapter disposal timed out waiting for active Run finalization.',
              false,
            )
          }
        }
      }
      const ownedForksToDispose = [...this.activeOwnedForkFiles]
      this.ownedForkFiles = undefined
      const results = await Promise.allSettled([
        joinOwnedRuns(),
        this.nativeChecks.join().catch(() => undefined),
        this.skillProbeOwner.dispose(shutdown?.flushDeadlineAt),
        ...ownedForksToDispose.map(async (forkFiles) => {
          await forkFiles.dispose(shutdown?.flushDeadlineAt)
          this.activeOwnedForkFiles.delete(forkFiles)
        }),
        ...(this.ownsPool ? [this.pool.dispose(shutdown?.flushDeadlineAt)] : []),
      ])
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (firstFailure) {
        throw firstFailure.reason
      }
    })()
    const trackedDisposal = runDisposal.catch((error: unknown) => {
      if (this.disposalPromise === trackedDisposal) {
        this.disposalPromise = undefined
      }
      throw error
    })
    this.disposalPromise = trackedDisposal
    return trackedDisposal
  }

  private async allocateZeroTurnSessionShell(
    lease: AgyPoolLease,
    signal: AbortSignal,
    options: {
      onSessionAllocated?: (sessionId: string) => void | Promise<void>
      onCreationDispatched?: () => void
      onCreationRejectedByServer?: () => void
    } = {},
  ): Promise<string> {
    let creationDispatched = false
    const newOp = lease.connection.requestOwned(
      'session/new',
      { cwd: lease.canonicalCwd, mcpServers: [] },
      {
        timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
        signal,
        canDispatch: () => !signal.aborted && !this.disposed,
        onDispatch: () => {
          creationDispatched = true
          options.onCreationDispatched?.()
        },
      },
    )
    let newResp: object
    try {
      newResp = await newOp.result
    } catch (error) {
      if (!creationDispatched) {
        const physical = await Promise.race([
          newOp.physicalOutcome,
          new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
        ])
        if (physical !== 'not_sent') {
          options.onCreationDispatched?.()
        }
      }
      throw error
    }
    const hasResultField = Object.hasOwn(newResp, 'result')
    const hasErrorField = Object.hasOwn(newResp, 'error')
    const newError = hasErrorField ? Reflect.get(newResp, 'error') : undefined
    const newResult = hasResultField ? Reflect.get(newResp, 'result') : undefined
    if (hasErrorField) {
      const isValidatedRejection =
        !hasResultField &&
        isPlainObject(newError) &&
        typeof newError.code === 'number' &&
        Number.isSafeInteger(newError.code) &&
        typeof newError.message === 'string'
      if (isValidatedRejection) {
        options.onCreationRejectedByServer?.()
      } else {
        options.onCreationDispatched?.()
      }
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    if (!isPlainObject(newResult)) {
      options.onCreationDispatched?.()
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    const descriptor = parseAcpSessionDescriptor(newResult)
    let callbackFailed = false
    let callbackError: unknown
    try {
      await options.onSessionAllocated?.(descriptor.sessionId)
    } catch (err) {
      callbackFailed = true
      callbackError = err
    }
    const callerAborted = signal.aborted
    const cleanupOnly = callbackFailed || callerAborted
    const closeRes = await lease.closeSession(descriptor.sessionId, {
      timeoutMs: cleanupOnly
        ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
        : AGY_CONTROL_RPC_TIMEOUT_MS,
    })
    if (closeRes.confirmed) {
      this.sessionModes.delete(descriptor.sessionId)
    } else {
      const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
      if (!cleanupOnly) {
        throw new AgentExecutionError(
          'protocol_error',
          'Antigravity failed to close the zero-Turn session shell cleanly.',
          false,
        )
      }
    }
    if (callbackFailed) {
      throw callbackError
    }
    if (callerAborted) {
      signal.throwIfAborted()
    }
    return descriptor.sessionId
  }

  private registerControlOperationServerRequests(params: {
    connection: AgyAcpConnection
    ownerId: string
    initialSessionId: string | undefined
    cwd: string
    permissionMode: SessionPermissionMode
    requestPermission: AgentRunInput['requestPermission']
    requestUserInput: AgentRunInput['requestUserInput']
    signal: AbortSignal
  }): {
    updateSessionId: (sessionId: string | undefined) => void
    handleServerRequest: (message: object) => boolean
    dispose: () => void
  } {
    const {
      connection,
      ownerId,
      initialSessionId,
      cwd,
      permissionMode,
      requestPermission,
      requestUserInput,
      signal,
    } = params
    let currentSessionId = initialSessionId
    let activePermissionRequests = 0
    let ownerDisposed = false
    const permissionWait = new NativePermissionWait()
    const interactionControllers = new Set<AbortController>()

    const isFenceCurrent = (): boolean =>
      !this.disposed && !ownerDisposed && !signal.aborted && connection.isOpen

    const handleServerRequest = (message: object, seq = 0): boolean => {
      const method = asString(Reflect.get(message, 'method'))
      const rpcId = Reflect.get(message, 'id')
      if (
        (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
        !method ||
        (method !== 'session/request_permission' && method !== 'elicitation/create') ||
        !isPlainObject(message)
      ) {
        return false
      }
      const rawParams = Reflect.get(message, 'params')
      const paramsObjectValid = isPlainObject(rawParams)
      const reqParams = paramsObjectValid ? rawParams : {}

      // Validate control-operation requests with the same frame identity validator against the
      // expected control session identity before reaching approval or elicitation callbacks!
      const validated = validateAgyFrame(
        {
          kind: 'server_request',
          seq,
          method,
          rpcId,
          message,
        },
        currentSessionId,
        undefined,
        undefined,
      )
      const controlIdentityInvalid =
        !paramsObjectValid ||
        !validated.isAttributableToCurrentSession ||
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        validated.tokens.hasInvalidToken ||
        validated.tokens.hasConflictingTokens

      if (method === 'session/request_permission') {
        const permFrameInvalid =
          controlIdentityInvalid ||
          validated.toolCallIdInvalid ||
          validated.argsEvidence.kind === 'invalid_or_conflict' ||
          (validated.statusPresent &&
            (validated.statusInvalid ||
              validated.status === 'completed' ||
              validated.status === 'failed' ||
              validated.status === 'cancelled'))
        void (async () => {
          if (permFrameInvalid || permissionMode === 'full') {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          if (!requestPermission || activePermissionRequests >= NATIVE_PERMISSION_REQUESTS) {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          let card: ReturnType<typeof buildAgyPermissionCard>
          try {
            card = buildAgyPermissionCard(reqParams, cwd)
          } catch {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          activePermissionRequests += 1
          const endConnectionWait = connection.beginPermissionWait()
          const endLocalWait = permissionWait.begin()
          const interactionAbort = new AbortController()
          interactionControllers.add(interactionAbort)
          try {
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
            const permWork = requestPermission(card.request, combinedSignal)
            void permWork.catch(() => undefined)
            const decisionId = await NativePermissionWait.decision(permWork, combinedSignal)
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const mappedResponse = card.responses.get(decisionId) ?? {
              outcome: { outcome: 'cancelled' },
            }
            await connection.respond(rpcId, mappedResponse)
            if (decisionId === 'agy-cancel' && currentSessionId) {
              await connection
                .notify('session/cancel', { sessionId: currentSessionId }, {})
                .catch(() => undefined)
            }
          } catch {
            if (connection.isOpen) {
              await connection
                .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                .catch(() => undefined)
            }
          } finally {
            interactionControllers.delete(interactionAbort)
            endLocalWait()
            endConnectionWait()
            activePermissionRequests = Math.max(0, activePermissionRequests - 1)
          }
        })()
        return true
      }

      void (async () => {
        if (controlIdentityInvalid) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          return
        }
        if (!requestUserInput) {
          await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
          return
        }
        let uiRequest: NativeUserInputRequest
        try {
          uiRequest = agyElicitationRequest(reqParams)
        } catch (error) {
          await connection
            .respondError(
              rpcId,
              error instanceof Error
                ? error.message
                : 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return
        }
        const endConnectionWait = connection.beginPermissionWait()
        const endLocalWait = permissionWait.begin()
        const interactionAbort = new AbortController()
        interactionControllers.add(interactionAbort)
        try {
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
          const userWork = requestUserInput(uiRequest, combinedSignal)
          void userWork.catch(() => undefined)
          const decision = await NativePermissionWait.decision(userWork, combinedSignal)
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          if (decision.action === 'accept') {
            await connection.respond(
              rpcId,
              uiRequest.kind === 'url'
                ? { action: 'accept' }
                : { action: 'accept', content: decision.values ?? {} },
            )
          } else {
            await connection.respond(rpcId, { action: decision.action })
          }
        } catch {
          if (connection.isOpen) {
            await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
        } finally {
          interactionControllers.delete(interactionAbort)
          endLocalWait()
          endConnectionWait()
        }
      })()
      return true
    }

    const ownerHandle = connection.registerServerRequestOwner({
      ownerId,
      knownSessionId: currentSessionId,
      handler: handleServerRequest,
    })

    return {
      updateSessionId: (sessionId) => {
        currentSessionId = sessionId
        ownerHandle.updateSessionId(sessionId)
      },
      handleServerRequest,
      dispose: () => {
        if (ownerDisposed) return
        ownerDisposed = true
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        ownerHandle.dispose()
      },
    }
  }

  private async sealPostLoadForkWitness(
    input: AgentNativeForkInput,
    canonicalCwd: string,
    candidateSessionId: string,
    baseWitness: AgentNativeForkWitness,
    signal: AbortSignal,
  ): Promise<AgentNativeForkWitness> {
    const provisional: AgentNativeForkWitness = {
      ...baseWitness,
      initializedAt: baseWitness.initializedAt ?? new Date().toISOString(),
      initializedPrefixHash: baseWitness.initializedPrefixHash ?? baseWitness.candidatePrefixHash,
      ...(baseWitness.initializedPrefixBytes !== undefined
        ? { initializedPrefixBytes: baseWitness.initializedPrefixBytes }
        : {}),
      initializedPrefixRecords:
        baseWitness.initializedPrefixRecords ?? baseWitness.candidatePrefixRecords,
    }
    if (!this.options.storageClient?.inspectFork) {
      return provisional
    }
    const postLoad = await this.options.storageClient.inspectFork(
      {
        ...input,
        cwd: canonicalCwd,
        nativeSessionId: candidateSessionId,
        witness: provisional,
        appDataDir: this.primaryAppDataDir,
      },
      signal,
    )
    if (postLoad.kind !== 'verified') {
      throw new AgentExecutionError(
        'context_resume_failed',
        `Antigravity Fork failed post-load physical inspection: ${postLoad.reason}`,
        false,
      )
    }
    const mergedBase = postLoad.result.witness ?? provisional
    return {
      ...mergedBase,
      initializedAt: mergedBase.initializedAt ?? provisional.initializedAt!,
      initializedPrefixHash:
        postLoad.rawHash ?? mergedBase.initializedPrefixHash ?? mergedBase.candidatePrefixHash,
      ...(postLoad.rawBytes !== undefined
        ? { initializedPrefixBytes: postLoad.rawBytes }
        : mergedBase.initializedPrefixBytes !== undefined
          ? { initializedPrefixBytes: mergedBase.initializedPrefixBytes }
          : {}),
      initializedPrefixRecords:
        postLoad.rawRecords ??
        mergedBase.initializedPrefixRecords ??
        mergedBase.candidatePrefixRecords,
    }
  }

  private async verifyZeroTurnSessionLoad(
    lease: AgyPoolLease,
    sessionId: string,
    signal: AbortSignal,
    options: {
      expectReplaySteps?: boolean
      forbidToolUpdates?: boolean
      onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void
    } = {},
  ): Promise<void> {
    const connection = lease.connection
    const canonicalCwd = lease.canonicalCwd
    const stream = connection.openSessionStream(sessionId, { ordered: true })
    let sawObservedReplay = false
    let sawUserChunk = false
    let sawAgentChunk = false
    let sawForbiddenExecutionUpdate = false

    const observeReplayItem = (item: object): void => {
      const method = asString(Reflect.get(item, 'method'))
      if (method !== 'session/update') return
      const params = Reflect.get(item, 'params')
      if (!isPlainObject(params)) return
      const sid = asString(params.sessionId ?? params.session_id)
      if (sid !== undefined && sid !== sessionId) return
      const update = params.update
      if (!isPlainObject(update)) return
      sawObservedReplay = true
      const kind = asString(update.sessionUpdate)
      if (kind === 'user_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawUserChunk = true
      } else if (kind === 'agent_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawAgentChunk = true
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const status = asString(update.status)
        if (
          options.forbidToolUpdates ||
          status === 'pending' ||
          status === 'in_progress' ||
          status === 'running'
        ) {
          sawForbiddenExecutionUpdate = true
        }
      }
    }

    let sessionLoaded = false
    let loadPossiblyDispatched = false
    let loadRejectedByServer = false
    let sessionClosed = false

    const recordCloseFailureDiagnostic = (reason: AgySessionCloseFailureReason) => {
      const closeDiag = classifyAgyCloseFailureDiagnostic(reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
    }

    let loadOp: ReturnType<AgyAcpConnection['requestOwned']> | undefined
    try {
      loadOp = connection.requestOwned(
        'session/load',
        { sessionId, cwd: canonicalCwd, mcpServers: [] },
        {
          timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
          signal,
          replyTo: stream,
          canDispatch: () => !signal.aborted && !this.disposed,
          onDispatch: () => {
            loadPossiblyDispatched = true
          },
        },
      )
      const loadResp = await this.runWithConcurrentReplayDrain(
        loadOp.result,
        stream,
        observeReplayItem,
        undefined,
        loadOp.requestId,
        options.onServerRequest,
      )
      const hasLoadResult = Object.hasOwn(loadResp, 'result')
      const hasLoadError = Object.hasOwn(loadResp, 'error')
      const loadError = hasLoadError ? Reflect.get(loadResp, 'error') : undefined
      const loadResult = hasLoadResult ? Reflect.get(loadResp, 'result') : undefined
      if (hasLoadError || !isPlainObject(loadResult)) {
        if (
          hasLoadError &&
          !hasLoadResult &&
          isPlainObject(loadError) &&
          typeof loadError.code === 'number' &&
          Number.isSafeInteger(loadError.code) &&
          typeof loadError.message === 'string'
        ) {
          loadRejectedByServer = true
        }
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load verification failed.',
          false,
        )
      }
      sessionLoaded = true
      if (sawForbiddenExecutionUpdate) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load unexpectedly emitted live tool execution updates.',
          false,
        )
      }
      if (options.expectReplaySteps && (!sawUserChunk || !sawAgentChunk)) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load did not replay the expected user and assistant chunks.',
          false,
        )
      }
      const callerAborted = signal.aborted
      sessionClosed = true
      const closeRes = await lease.closeSession(sessionId, {
        timeoutMs: callerAborted
          ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
          : AGY_CONTROL_RPC_TIMEOUT_MS,
      })
      if (closeRes.confirmed) {
        this.sessionModes.delete(sessionId)
      } else {
        recordCloseFailureDiagnostic(closeRes.reason)
        if (!callerAborted) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity failed to close verified cold session.',
            false,
          )
        }
      }
      if (callerAborted) {
        signal.throwIfAborted()
      }
    } finally {
      try {
        if (!loadPossiblyDispatched && loadOp && !loadRejectedByServer && !sawObservedReplay) {
          const physical = await Promise.race([
            loadOp.physicalOutcome,
            new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
          ])
          if (physical !== 'not_sent') {
            loadPossiblyDispatched = true
          }
        }
        const mayBeLoaded =
          sessionLoaded || sawObservedReplay || (loadPossiblyDispatched && !loadRejectedByServer)
        if (mayBeLoaded && !sessionClosed) {
          sessionClosed = true
          const cleanupClose = await lease.closeSession(sessionId, {
            timeoutMs: Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500),
          })
          if (cleanupClose.confirmed) {
            this.sessionModes.delete(sessionId)
          } else {
            recordCloseFailureDiagnostic(cleanupClose.reason)
          }
        }
      } catch {
        // Preserve the original replay verification or cancellation error.
      } finally {
        stream.close()
      }
    }
  }

  private async runWithConcurrentReplayDrain(
    requestPromise: Promise<object>,
    stream: AgyOrderedSessionStream,
    onNotification: (notification: object) => void,
    onReply?: (value: object) => void,
    requestId?: number,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
  ): Promise<object> {
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: object } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          try {
            onReply?.(item.message)
          } catch (error) {
            recordObserverFailure(error)
            throw error
          }
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const drainBuffered = (): void => {
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    const tracked = (async () => {
      try {
        const value = await requestPromise
        try {
          drainBuffered()
          if (!drainState.replyObserved && !drainState.observerFailed) {
            drainState.replyObserved = true
            onReply?.(value)
          }
        } catch (error) {
          recordObserverFailure(error)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: true, value }
          drainAbort.abort()
        }
      } catch (error) {
        try {
          drainBuffered()
        } catch (obsError) {
          recordObserverFailure(obsError)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: false, error }
          drainAbort.abort()
        }
      }
    })()

    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break
        let nextItem: AgyIngress | undefined
        try {
          // oxlint-disable-next-line no-await-in-loop -- Continuous O(1) ordered drain while RPC is in flight.
          nextItem = await stream.nextIngress(undefined, drainAbort.signal)
        } catch (waitError) {
          if (drainAbort.signal.aborted) {
            break
          }
          throw waitError
        }
        if (nextItem !== undefined) {
          handleIngressItem(nextItem)
        }
        drainBuffered()
      }
      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
      }
    } finally {
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Session load ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  private async *awaitControlRpcWithConcurrentDrain<TResult>(params: {
    requestPromise: Promise<TResult>
    requestId?: number | undefined
    stream: AgyOrderedSessionStream | undefined
    shiftPendingEvent: () => NormalizedAgentEvent | undefined
    setWakeup: (fn: (() => void) | undefined) => void
    onNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
  }): AsyncGenerator<NormalizedAgentEvent, TResult, void> {
    const {
      requestPromise,
      requestId,
      stream,
      shiftPendingEvent,
      setWakeup,
      onNotification,
      onServerRequest,
    } = params
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: TResult } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }
    let wakeLocal: (() => void) | undefined

    const triggerWake = (): void => {
      const fn = wakeLocal
      wakeLocal = undefined
      fn?.()
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
      triggerWake()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const tracked = requestPromise.then(
      (value) => {
        drainState.settled = true
        drainState.outcome = { ok: true, value }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
      (error: unknown) => {
        drainState.settled = true
        drainState.outcome = { ok: false, error }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
    )

    const drainBuffered = (): void => {
      if (!stream) return
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    let pendingStreamNext: Promise<void> | undefined
    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break

        const wakePromise = new Promise<void>((resolveWake) => {
          wakeLocal = resolveWake
          setWakeup(() => {
            setWakeup(undefined)
            triggerWake()
          })
        })

        if (stream && !pendingStreamNext) {
          const created = stream
            .nextIngress(undefined, drainAbort.signal)
            .then(
              (item) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                handleIngressItem(item)
                return undefined
              },
              (waitError: unknown) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                if (!drainAbort.signal.aborted) {
                  recordObserverFailure(waitError)
                }
                return undefined
              },
            )
            .catch((obsError: unknown) => {
              recordObserverFailure(obsError)
            })
          pendingStreamNext = created
        }

        // oxlint-disable-next-line no-await-in-loop -- Concurrent init-event yield and ordered replay drain.
        await Promise.race(pendingStreamNext ? [wakePromise, pendingStreamNext] : [wakePromise])
      }

      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
      }
    } finally {
      setWakeup(undefined)
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Control RPC ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  private rememberSessionModeState(
    sessionId: string,
    reportedModeId: string | undefined,
  ): SessionModeState {
    const existing = this.sessionModes.get(sessionId)
    if (existing) {
      if (reportedModeId) existing.currentModeId = reportedModeId
      this.sessionModes.delete(sessionId)
      this.sessionModes.set(sessionId, existing)
      return existing
    }
    if (this.sessionModes.size >= AGY_SESSION_MODE_CACHE_LIMIT) {
      const oldestKey = this.sessionModes.keys().next().value
      if (oldestKey !== undefined) this.sessionModes.delete(oldestKey)
    }
    const currentModeId = reportedModeId ?? 'default'
    const initialNonPlanModeId = currentModeId !== 'plan' ? currentModeId : 'default'
    const state: SessionModeState = {
      initialNonPlanModeId,
      currentModeId,
      enteredPlanModeByPact: false,
    }
    this.sessionModes.set(sessionId, state)
    return state
  }

  private async setAndConfirmSessionMode(
    connection: AgyAcpConnection,
    sessionId: string,
    modeId: string,
    signal: AbortSignal,
    options?: {
      sessionStream?: AgyOrderedSessionStream | undefined
      onMetadataNotification?: ((notification: object) => void) | undefined
      onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    },
  ): Promise<void> {
    const sessionStream = options?.sessionStream
    const op = connection.requestOwned(
      'session/set_mode',
      { sessionId, modeId },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          op.result,
          sessionStream,
          (note) => options?.onMetadataNotification?.(note),
          undefined,
          op.requestId,
          options?.onServerRequest,
        )
      : await op.result
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new PermissionModeRejectedError(
        `Antigravity rejected permission mode "${modeId}"${
          error ? `: ${safeNativePermissionText(JSON.stringify(error), 200)}` : '.'
        }`,
      )
    }
  }

  private async configureSessionModeBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionState: SessionModeState
    sessionStream?: AgyOrderedSessionStream | undefined
    onMetadataNotification?: ((notification: object) => void) | undefined
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    readOnlyStage: boolean
    permissionMode: SessionPermissionMode
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionState,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      readOnlyStage,
      permissionMode,
      signal,
    } = params
    const drainOptions = { sessionStream, onMetadataNotification, onServerRequest }

    if (readOnlyStage) {
      if (descriptor.availableModes && !descriptor.availableModes.includes('plan')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not advertise native Plan mode required for read-only collaboration stages.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'plan', signal, drainOptions)
      sessionState.currentModeId = 'plan'
      sessionState.enteredPlanModeByPact = true
      return
    }

    // Non-read-only stage: ALWAYS retire stale `plan` mode explicitly before any prompt!
    const needsPlanRetirement =
      sessionState.enteredPlanModeByPact ||
      sessionState.currentModeId === 'plan' ||
      descriptor.currentModeId === 'plan'

    if (permissionMode === 'ask') {
      await this.setAndConfirmSessionMode(connection, sessionId, 'default', signal, drainOptions)
      sessionState.currentModeId = 'default'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'auto') {
      if (descriptor.availableModes && !descriptor.availableModes.includes('auto')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not offer Auto permission mode for this session.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'auto', signal, drainOptions)
      sessionState.currentModeId = 'auto'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'native' || permissionMode === 'full') {
      if (needsPlanRetirement) {
        const restoreMode = sessionState.initialNonPlanModeId || 'default'
        await this.setAndConfirmSessionMode(
          connection,
          sessionId,
          restoreMode,
          signal,
          drainOptions,
        )
        sessionState.currentModeId = restoreMode
        sessionState.enteredPlanModeByPact = false
      }
    }
  }

  private async configureModelAndEffortBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    requestedModel: string | null
    requestedEffort: string | null
    signal: AbortSignal
  }): Promise<{ model: string; effort: string | null; effortKnown: boolean }> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      requestedModel,
      requestedEffort,
      signal,
    } = params
    let configOptions = descriptor.configOptions
    let currentModelId = descriptor.currentModelId

    const drainNotifiedConfigOptions = async (
      accept?: (options: AcpConfigOptionEntry[]) => boolean,
    ): Promise<AcpConfigOptionEntry[] | undefined> => {
      if (!sessionStream) return undefined
      await Promise.resolve()
      let latest: AcpConfigOptionEntry[] | undefined
      while (true) {
        const item = sessionStream.shift()
        if (!item) break
        if (item.kind === 'server_request') {
          onServerRequest?.(item)
          continue
        }
        if (item.kind !== 'notification') continue
        onMetadataNotification(item.message)
        const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
        if (parsed && (!accept || accept(parsed))) latest = parsed
      }
      return latest
    }

    const findOption = (id: string): AcpConfigOptionEntry | undefined =>
      configOptions.find((entry) => entry.id === id)

    const initialModelOption = findOption('model')
    const declaredModelFamilies = initialModelOption?.options?.map((opt) => opt.value)
    const concreteModelMatches = (actualModelId: string): boolean => {
      if (requestedModel === null) return true
      return actualModelId === requestedModel
    }
    const isFamilyPrefixOf = (family: string, concrete: string): boolean =>
      declaredModelFamilies !== undefined &&
      declaredModelFamilies.length > 0 &&
      declaredModelFamilies.includes(family) &&
      concrete.startsWith(`${family}-`)
    const configFamilyMatchesRequested = (actualValue: string): boolean => {
      if (requestedModel === null) return true
      if (actualValue === requestedModel) return true
      return isFamilyPrefixOf(actualValue, requestedModel)
    }
    const priorModelId = descriptor.currentModelId ?? initialModelOption?.currentValue
    const didSwitchModel = requestedModel !== null && priorModelId !== requestedModel
    const isAmbiguousSharedFamilyUpdate = (notifiedModel: string): boolean =>
      didSwitchModel &&
      requestedModel !== null &&
      priorModelId !== undefined &&
      notifiedModel !== requestedModel &&
      isFamilyPrefixOf(notifiedModel, requestedModel) &&
      isFamilyPrefixOf(notifiedModel, priorModelId)
    const modelAttribution = {
      didSwitchModel,
      requestedModel,
      priorModelId,
      declaredModelFamilies,
      configFamilyMatchesRequested,
      isAmbiguousSharedFamilyUpdate,
    }

    let derivedEffortFromModelVariant: string | undefined

    if (requestedModel !== null) {
      const modelOption = initialModelOption
      const matchesConfigFamily =
        modelOption?.options?.some((opt) => opt.value === requestedModel) ?? false

      if (
        matchesConfigFamily ||
        (modelOption && !descriptor.availableModels?.includes(requestedModel))
      ) {
        let targetFamily = requestedModel
        if (
          modelOption?.options &&
          !modelOption.options.some((opt) => opt.value === requestedModel)
        ) {
          // Check whether `requestedModel` is a `<family>-<thought_level>` composite ID from `models.availableModels`.
          const matchedFamily = modelOption.options
            .map((opt) => opt.value)
            .toSorted((a, b) => b.length - a.length)
            .find((family) => requestedModel.startsWith(`${family}-`))
          if (!matchedFamily) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity does not offer model "${requestedModel}".`,
              false,
            )
          }
          targetFamily = matchedFamily
          derivedEffortFromModelVariant = requestedModel.slice(matchedFamily.length + 1)
        }
        if (modelOption?.currentValue !== targetFamily) {
          // Invalidate stale model-dependent `configOptions` BEFORE applying new model.
          configOptions = []
          configOptions = await this.setConfigOptionAndConfirm({
            connection,
            sessionId,
            configId: 'model',
            value: targetFamily,
            sessionStream,
            onMetadataNotification,
            onServerRequest,
            modelAttribution,
            signal,
          })
        }
        currentModelId = requestedModel
      } else if (descriptor.availableModels?.includes(requestedModel)) {
        const classifySetModelOptions = (
          options: AcpConfigOptionEntry[],
        ): 'match' | 'stale_prior' | 'unattributed_during_switch' | 'conflict' => {
          const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
          if (notifiedModel === undefined) {
            if (didSwitchModel) {
              return 'unattributed_during_switch'
            }
            return 'match'
          }
          if (isAmbiguousSharedFamilyUpdate(notifiedModel)) {
            return 'unattributed_during_switch'
          }
          if (configFamilyMatchesRequested(notifiedModel)) {
            return 'match'
          }
          if (
            priorModelId !== undefined &&
            (notifiedModel === priorModelId || isFamilyPrefixOf(notifiedModel, priorModelId))
          ) {
            return 'stale_prior'
          }
          return 'conflict'
        }
        if (
          didSwitchModel ||
          (modelOption?.currentValue !== undefined &&
            !configFamilyMatchesRequested(modelOption.currentValue))
        ) {
          // Invalidate stale `configOptions` from the prior model immediately on model change.
          configOptions = []
        }
        await drainNotifiedConfigOptions()
        const setModelOp = connection.requestOwned(
          'session/set_model',
          { sessionId, modelId: requestedModel },
          {
            timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
            signal,
            ...(sessionStream ? { replyTo: sessionStream } : {}),
          },
        )
        const setModelReq = setModelOp.result
        const setModelTrack: {
          matched: AcpConfigOptionEntry[] | undefined
          conflictModel: string | undefined
          replyError: AgentExecutionError | undefined
          replyHadOptions: boolean
        } = {
          matched: undefined,
          conflictModel: undefined,
          replyError: undefined,
          replyHadOptions: false,
        }
        const recordSetModelOptions = (parsed: AcpConfigOptionEntry[]): void => {
          const verdict = classifySetModelOptions(parsed)
          if (verdict === 'match') {
            setModelTrack.matched = parsed
            setModelTrack.conflictModel = undefined
          } else if (verdict === 'conflict') {
            setModelTrack.matched = undefined
            setModelTrack.conflictModel =
              parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
          }
        }
        const observeSetModelReply = (resp: object): void => {
          const rErr = Reflect.get(resp, 'error')
          const rRes = Reflect.get(resp, 'result')
          if (rErr || !isPlainObject(rRes)) return
          if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
          const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
          setModelTrack.replyHadOptions = true
          const replyOptModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
          if (replyOptModel !== undefined && !configFamilyMatchesRequested(replyOptModel)) {
            setModelTrack.replyError = new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${replyOptModel}" for requested "${requestedModel}".`,
              false,
            )
            return
          }
          setModelTrack.matched = parsedReply
          setModelTrack.conflictModel = undefined
        }
        const setModelResp = sessionStream
          ? await this.runWithConcurrentReplayDrain(
              setModelReq,
              sessionStream,
              (note) => {
                onMetadataNotification(note)
                const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
                if (parsed) recordSetModelOptions(parsed)
              },
              observeSetModelReply,
              setModelOp.requestId,
              onServerRequest,
            )
          : await setModelReq
        const err = Reflect.get(setModelResp, 'error')
        const res = Reflect.get(setModelResp, 'result')
        if (err || !isPlainObject(res)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity rejected model "${requestedModel}".`,
            false,
          )
        }
        if (!sessionStream) {
          observeSetModelReply(setModelResp)
        }
        const replyReportedModel = asString(
          Reflect.get(res, 'modelId') ?? Reflect.get(res, 'currentModelId'),
        )
        if (replyReportedModel !== undefined && !concreteModelMatches(replyReportedModel)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyReportedModel}" for requested "${requestedModel}".`,
            false,
          )
        }
        if (setModelTrack.replyError) {
          throw setModelTrack.replyError
        }
        const throwIfSetModelConflict = (): void => {
          if (setModelTrack.conflictModel !== undefined) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${setModelTrack.conflictModel}" for requested "${requestedModel}".`,
              false,
            )
          }
        }
        throwIfSetModelConflict()
        if (sessionStream) {
          await Promise.resolve()
          while (true) {
            const item = sessionStream.shift()
            if (!item) break
            if (item.kind === 'server_request') {
              onServerRequest?.(item)
              continue
            }
            if (item.kind !== 'notification') continue
            onMetadataNotification(item.message)
            const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
            if (parsed) recordSetModelOptions(parsed)
          }
        }
        throwIfSetModelConflict()
        if (setModelTrack.replyHadOptions) {
          configOptions = setModelTrack.matched ?? []
        } else {
          let confirmedUpdated = setModelTrack.matched
          if (confirmedUpdated === undefined && sessionStream) {
            const awaited = await this.awaitPostReplyConfigOptionUpdate(
              sessionStream,
              onMetadataNotification,
              signal,
              AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
              (opts) => {
                const verdict = classifySetModelOptions(opts)
                return verdict === 'match' || verdict === 'conflict'
              },
              onServerRequest,
              sessionId,
            )
            if (awaited !== undefined) {
              if (classifySetModelOptions(awaited) === 'conflict') {
                const actualModel =
                  awaited.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
                throw new AgentExecutionError(
                  'runtime_incompatible',
                  `Antigravity silently substituted model="${actualModel}" for requested "${requestedModel}".`,
                  false,
                )
              }
              confirmedUpdated = awaited
            }
          }
          if (confirmedUpdated !== undefined) {
            configOptions = confirmedUpdated
          }
        }
        currentModelId = requestedModel
      } else if (!modelOption && !descriptor.availableModels) {
        configOptions = []
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'model',
          value: requestedModel,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
        currentModelId = requestedModel
      } else {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity does not offer model "${requestedModel}".`,
          false,
        )
      }
    }

    const trailingBeforeEffort = await drainNotifiedConfigOptions((options) => {
      const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
      if (notifiedModel === undefined) {
        if (didSwitchModel) return false
        return !(
          requestedModel !== null &&
          initialModelOption !== undefined &&
          configOptions.length === 0
        )
      }
      if (requestedModel !== null) {
        if (isAmbiguousSharedFamilyUpdate(notifiedModel)) return false
        if (configFamilyMatchesRequested(notifiedModel)) return true
        const currentFamily = findOption('model')?.currentValue
        if (
          priorModelId !== undefined &&
          (notifiedModel === priorModelId ||
            (declaredModelFamilies !== undefined &&
              declaredModelFamilies.length > 0 &&
              declaredModelFamilies.includes(notifiedModel) &&
              priorModelId.startsWith(`${notifiedModel}-`))) &&
          currentFamily !== priorModelId
        ) {
          return false
        }
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${notifiedModel}" for requested "${requestedModel}".`,
          false,
        )
      }
      return true
    })
    if (trailingBeforeEffort !== undefined) {
      configOptions = trailingBeforeEffort
    }

    const effectiveRequestedEffort = requestedEffort ?? derivedEffortFromModelVariant ?? null
    if (effectiveRequestedEffort !== null) {
      const thoughtOption = findOption('thought_level')
      if (configOptions.length > 0 && !thoughtOption) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model "${requestedModel ?? currentModelId ?? 'default'}" does not expose thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (
        thoughtOption?.options &&
        !thoughtOption.options.some((opt) => opt.value === effectiveRequestedEffort)
      ) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model does not support thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (!thoughtOption || thoughtOption.currentValue !== effectiveRequestedEffort) {
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'thought_level',
          value: effectiveRequestedEffort,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
      }
      const confirmedThought = findOption('thought_level')
      if (!confirmedThought || confirmedThought.currentValue !== effectiveRequestedEffort) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity did not confirm thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
    }

    const finalModelOption = findOption('model')
    if (
      requestedModel !== null &&
      finalModelOption?.currentValue !== undefined &&
      !configFamilyMatchesRequested(finalModelOption.currentValue)
    ) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${finalModelOption.currentValue}" for requested "${requestedModel}".`,
        false,
      )
    }
    const finalThoughtOption = findOption('thought_level')
    const modelKnown =
      requestedModel !== null ||
      finalModelOption?.currentValue !== undefined ||
      currentModelId !== undefined
    const effortKnown =
      effectiveRequestedEffort !== null ||
      (configOptions.length > 0 &&
        (finalThoughtOption?.currentValue !== undefined || !finalThoughtOption))
    const resolvedModel =
      requestedModel ?? finalModelOption?.currentValue ?? currentModelId ?? 'agy-default'
    const resolvedEffort =
      effectiveRequestedEffort !== null
        ? effectiveRequestedEffort
        : (finalThoughtOption?.currentValue ?? null)

    return { model: resolvedModel, effort: resolvedEffort, effortKnown: modelKnown && effortKnown }
  }

  private async awaitPostReplyConfigOptionUpdate(
    sessionStream: AgyOrderedSessionStream,
    onMetadataNotification: (notification: object) => void,
    signal: AbortSignal,
    windowMs = AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
    matches?: (options: AcpConfigOptionEntry[]) => boolean,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
    sessionId?: string,
  ): Promise<AcpConfigOptionEntry[] | undefined> {
    const deadlineAt = Date.now() + windowMs
    let latest: AcpConfigOptionEntry[] | undefined
    while (true) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind === 'end') return matches ? undefined : latest
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) {
          latest = parsed
          if (!matches || matches(parsed)) return parsed
        }
      }
      if (latest !== undefined && !matches) return latest
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) return matches ? undefined : latest
      // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
      const nextItem = await sessionStream.nextIngress(remainingMs, signal).catch(() => undefined)
      if (!nextItem) {
        signal.throwIfAborted()
        return matches ? undefined : latest
      }
      if (nextItem.kind === 'server_request') {
        onServerRequest?.(nextItem)
        continue
      }
      if (nextItem.kind === 'end') return matches ? undefined : latest
      if (nextItem.kind !== 'notification') continue
      onMetadataNotification(nextItem.message)
      const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
      if (parsed) {
        latest = parsed
        if (!matches || matches(parsed)) return parsed
      }
    }
  }

  private async setConfigOptionAndConfirm(params: {
    connection: AgyAcpConnection
    sessionId: string
    configId: 'model' | 'thought_level'
    value: string
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    modelAttribution?: {
      didSwitchModel: boolean
      requestedModel: string | null
      priorModelId: string | undefined
      declaredModelFamilies: readonly string[] | undefined
      configFamilyMatchesRequested: (actualValue: string) => boolean
      isAmbiguousSharedFamilyUpdate: (notifiedModel: string) => boolean
    }
    signal: AbortSignal
  }): Promise<AcpConfigOptionEntry[]> {
    const {
      connection,
      sessionId,
      configId,
      value,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      modelAttribution,
      signal,
    } = params
    if (sessionStream) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
      }
    }
    const isStalePriorModel = (notifiedModel: string): boolean => {
      if (!modelAttribution?.priorModelId) return false
      return (
        notifiedModel === modelAttribution.priorModelId ||
        (modelAttribution.declaredModelFamilies !== undefined &&
          modelAttribution.declaredModelFamilies.length > 0 &&
          modelAttribution.declaredModelFamilies.includes(notifiedModel) &&
          modelAttribution.priorModelId.startsWith(`${notifiedModel}-`))
      )
    }
    const classifyAsyncOptions = (
      options: AcpConfigOptionEntry[],
    ): 'match' | 'other_attributed' | 'ignore' | 'conflict' => {
      if (modelAttribution) {
        const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
        if (notifiedModel === undefined) {
          if (modelAttribution.didSwitchModel || configId === 'model') {
            return 'ignore'
          }
        } else if (modelAttribution.isAmbiguousSharedFamilyUpdate(notifiedModel)) {
          // Same-family variant switch: family-only async notifications cannot confirm either
          // `model` OR model-dependent `thought_level`!
          return 'ignore'
        } else if (
          modelAttribution.requestedModel !== null &&
          !modelAttribution.configFamilyMatchesRequested(notifiedModel)
        ) {
          return isStalePriorModel(notifiedModel) ? 'ignore' : 'conflict'
        }
      }
      return options.find((opt) => opt.id === configId)?.currentValue === value
        ? 'match'
        : 'other_attributed'
    }
    const setOptionOp = connection.requestOwned(
      'session/set_config_option',
      { sessionId, configId, value },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const requestPromise = setOptionOp.result
    let latestAttributedOptions: AcpConfigOptionEntry[] | undefined
    let latestAttributedMatched = false
    let conflictModelDuringSet: string | undefined
    let replyError: AgentExecutionError | undefined
    let replyHadOptions = false
    const observeAsyncConfigOptions = (parsed: AcpConfigOptionEntry[]): void => {
      const verdict = classifyAsyncOptions(parsed)
      if (verdict === 'conflict') {
        conflictModelDuringSet = parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
        latestAttributedOptions = undefined
        latestAttributedMatched = false
      } else if (verdict === 'match') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = true
      } else if (verdict === 'other_attributed') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = false
      }
    }
    const observeReplyOptions = (resp: object): void => {
      const rErr = Reflect.get(resp, 'error')
      const rRes = Reflect.get(resp, 'result')
      if (rErr || !isPlainObject(rRes)) return
      if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
      const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
      replyHadOptions = true
      if (modelAttribution && modelAttribution.requestedModel !== null) {
        const replyModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
        if (
          replyModel !== undefined &&
          !modelAttribution.configFamilyMatchesRequested(replyModel)
        ) {
          replyError = new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyModel}" for requested "${modelAttribution.requestedModel}".`,
            false,
          )
          return
        }
      }
      conflictModelDuringSet = undefined
      latestAttributedOptions = parsedReply
      latestAttributedMatched =
        parsedReply.find((opt) => opt.id === configId)?.currentValue === value
    }
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          requestPromise,
          sessionStream,
          (note) => {
            onMetadataNotification(note)
            const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          },
          observeReplyOptions,
          setOptionOp.requestId,
          onServerRequest,
        )
      : await requestPromise
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity rejected ${configId}="${value}".`,
        false,
      )
    }
    if (!sessionStream) {
      observeReplyOptions(response)
    }
    if (replyError) {
      throw replyError
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    if (sessionStream) {
      await Promise.resolve()
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) observeAsyncConfigOptions(parsed)
      }
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    let updated: AcpConfigOptionEntry[]
    if (replyHadOptions) {
      updated = latestAttributedOptions ?? []
    } else {
      if (!latestAttributedMatched && sessionStream) {
        const deadlineAt = Date.now() + AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS
        while (true) {
          let sawEnd = false
          while (true) {
            const buffered = sessionStream.shift()
            if (!buffered) break
            if (buffered.kind === 'server_request') {
              onServerRequest?.(buffered)
              continue
            }
            if (buffered.kind === 'end') {
              sawEnd = true
              break
            }
            if (buffered.kind !== 'notification') continue
            onMetadataNotification(buffered.message)
            const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          }
          if (sawEnd || conflictModelDuringSet !== undefined || latestAttributedMatched) break
          const remainingMs = deadlineAt - Date.now()
          if (remainingMs <= 0) break
          // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
          const nextItem = await sessionStream
            .nextIngress(remainingMs, signal)
            .catch(() => undefined)
          if (!nextItem) {
            signal.throwIfAborted()
            break
          }
          if (nextItem.kind === 'server_request') {
            onServerRequest?.(nextItem)
            continue
          }
          if (nextItem.kind === 'end') break
          if (nextItem.kind !== 'notification') continue
          onMetadataNotification(nextItem.message)
          const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
          if (parsed) observeAsyncConfigOptions(parsed)
        }
      }
      if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
          false,
        )
      }
      updated = latestAttributedOptions ?? []
    }
    const confirmed = updated.find((opt) => opt.id === configId)
    if (confirmed && confirmed.currentValue !== undefined && confirmed.currentValue !== value) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted ${configId}="${confirmed.currentValue}" for requested "${value}".`,
        false,
      )
    }
    if (configId === 'thought_level' && (!confirmed || confirmed.currentValue !== value)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity did not confirm thought_level="${value}".`,
        false,
      )
    }
    return updated
  }

  private buildEffectiveExecutionSettings(
    model: string,
    effort: string | null,
    effortKnown: boolean,
    permissionMode: SessionPermissionMode,
  ): RunEffectiveExecutionSettings | undefined {
    if (!effortKnown) {
      return undefined
    }
    const configurationSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          provider: 'agy',
          model,
          effort,
          speed: 'native',
          permissionMode,
        }),
      )
      .digest('hex')

    return {
      version: 1,
      provider: 'agy',
      model,
      effort: { known: true, value: effort },
      speed: 'native',
      permissionMode,
      configurationSha256,
      provenance: 'agy_applied_settings',
    }
  }

  private async handlePermissionRequest(context: {
    connection: AgyAcpConnection
    validated: ValidatedAgyFrame
    rpcId: string | number
    params: Record<string, unknown>
    paramsObjectValid: boolean
    unscopedDuringForeignTurn: boolean
    preBuiltCard: ReturnType<typeof buildAgyPermissionCard> | undefined
    cwd: string
    input: AgentRunInput
    activeRun: ActiveAgyRun | undefined
    getSessionId: () => string | undefined
    mcpServer: AgyRunMcpServer
    readOnlyStage: boolean
    permissionMode: SessionPermissionMode
    permissionWait: NativePermissionWait
    getActiveCount: () => number
    adjustActiveCount: (delta: number) => void
    interactionControllers: Set<AbortController>
    pushEvent: (event: NormalizedAgentEvent) => void
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      validated,
      rpcId,
      params,
      paramsObjectValid,
      unscopedDuringForeignTurn,
      preBuiltCard,
      cwd,
      input,
      activeRun,
      getSessionId,
      mcpServer,
      readOnlyStage,
      permissionMode,
      permissionWait,
      getActiveCount,
      adjustActiveCount,
      interactionControllers,
      pushEvent,
      signal,
    } = context

    const mayRevokeCurrentSessionMcp = validated.sessionAttribution !== 'pure_foreign'
    const hasForeignOrInvalidMeta = validated.hasForeignOrInvalidSessionMeta
    const executionContradicted =
      validated.executionIdInvalid ||
      unscopedDuringForeignTurn ||
      (validated.executionId !== undefined &&
        activeRun?.providerExecutionId !== undefined &&
        validated.executionId !== activeRun.providerExecutionId) ||
      (validated.executionId !== undefined &&
        Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))
    const validTcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
    const inheritedName =
      validated.explicitToolName === undefined &&
      !validated.explicitToolNameInvalid &&
      validTcId !== undefined
        ? mcpServer.lookupVerifiedCallToolName(validTcId)
        : undefined
    const exactToolName = validated.explicitToolName ?? inheritedName ?? ''
    const isAuthorizedPactTool =
      !validated.explicitToolNameInvalid &&
      Boolean(mcpServer.isAuthorizedMcpToolCallName(exactToolName))
    const disputedTokens = validated.tokens.allCanonicalTokens
    const resolvedPt = validated.tokens.resolvedToken
    const hasTerminalOrInvalidPermStatus =
      validated.statusPresent &&
      (validated.statusInvalid ||
        validated.status === 'completed' ||
        validated.status === 'failed' ||
        validated.status === 'cancelled')
    const hasInvalidOrContradictedPermFrame =
      !paramsObjectValid ||
      hasForeignOrInvalidMeta ||
      executionContradicted ||
      validated.rootEvidenceContradicted ||
      validated.tokens.hasInvalidToken ||
      validated.tokens.hasConflictingTokens ||
      validated.toolCallIdInvalid ||
      hasTerminalOrInvalidPermStatus ||
      validated.argsEvidence.kind === 'invalid_or_conflict'

    const recordNegativeNonPactDecision = (): void => {
      if (!mayRevokeCurrentSessionMcp) return
      mcpServer.observeNonPactCall(validTcId, disputedTokens)
    }

    const denyPermission = async (): Promise<void> => {
      const rejectOnce = findRejectOnceOptionId(params.options)
      const payload = rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
        : { outcome: { outcome: 'cancelled' } }
      await connection.respond(rpcId, payload).catch(() => undefined)
    }

    // 1. Full access (`requirements.md:519`): explicitly deny ANY residual `session/request_permission`
    // BEFORE any Pact MCP tool-name auto-allow and without surfacing a user approval card!
    // Record refusal of both call ID and all supplied progressTokens BEFORE sending the negative reply.
    if (!readOnlyStage && permissionMode === 'full') {
      if (mayRevokeCurrentSessionMcp) {
        if (isAuthorizedPactTool) {
          mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        } else {
          recordNegativeNonPactDecision()
        }
      }
      await denyPermission()
      return
    }

    // 2. Record non-Pact call ID & token ownership before replying (independent of activeRun or prior admission).
    if (!isAuthorizedPactTool) {
      recordNegativeNonPactDecision()
    }

    // Reject contradictory, malformed, foreign-execution, terminal-status, or invalid-token
    // permission requests for BOTH Pact and non-Pact tools BEFORE auto-approval or approval cards!
    if (hasInvalidOrContradictedPermFrame) {
      if (mayRevokeCurrentSessionMcp && isAuthorizedPactTool) {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
      }
      await denyPermission()
      return
    }

    // Auto-allow ONLY verified current-root Pact MCP tools matching this Run's active allowed list.
    if (
      activeRun &&
      !activeRun.promptReplyReceived &&
      mcpServer.isRootActive() &&
      !signal.aborted &&
      !hasInvalidOrContradictedPermFrame &&
      isAuthorizedPactTool
    ) {
      const allowOnce = findAllowOnceOptionId(params.options)
      if (!allowOnce || validTcId === undefined) {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        await denyPermission()
        return
      }
      const admission = mcpServer.observeAcpToolCall({
        toolCallId: validTcId,
        rawToolName: exactToolName,
        status: validated.status ?? 'pending',
        ...(validated.argsEvidence.kind === 'present'
          ? {
              args: validated.argsEvidence.args,
              argsFingerprint: validated.argsEvidence.fingerprint,
            }
          : {}),
        ...(resolvedPt !== undefined ? { progressToken: resolvedPt.canonical } : {}),
        ...(disputedTokens.length > 0 ? { disputedTokens } : {}),
        ...(validated.trajectoryId !== undefined ? { trajectoryId: validated.trajectoryId } : {}),
        ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
      })
      if (admission !== 'admitted') {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        await denyPermission()
        return
      }
      // Pin root trajectory/step ONLY after full frame validation AND correlator admission succeeded!
      if (validated.trajectoryId !== undefined) {
        mcpServer.pinRootTrajectoryId(validated.trajectoryId)
      } else if (resolvedPt?.structured && !resolvedPt.structured.hasLeadingZeros) {
        mcpServer.pinRootTrajectoryId(resolvedPt.structured.trajectoryId)
      }
      await connection
        .respond(rpcId, { outcome: { outcome: 'selected', optionId: allowOnce } })
        .catch(() => undefined)
      return
    }
    if (mayRevokeCurrentSessionMcp && isAuthorizedPactTool) {
      mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
    }

    // 3. Read-Only Ironclad Wall (`B4`): deterministically reject ALL workspace/read_file/command/other
    // permission requests using `reject_once` / `deny` (NEVER `options[0]`!).
    if (readOnlyStage) {
      await denyPermission()
      return
    }

    // 4. Interactive user approval (`native`, `ask`, or `auto` classifier escalation).
    if (!input.requestPermission || getActiveCount() >= NATIVE_PERMISSION_REQUESTS) {
      await denyPermission()
      return
    }

    const fenceEpoch = activeRun?.turnEpoch
    const fenceExecutor = activeRun?.executorId
    const fenceGen = activeRun?.bindingGeneration
    const isFenceCurrent = (): boolean =>
      !this.disposed &&
      !signal.aborted &&
      connection.isOpen &&
      (activeRun
        ? !activeRun.promptReplyReceived &&
          !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen &&
          !(
            validated.executionId !== undefined &&
            activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId
          )
        : true)

    let card: ReturnType<typeof buildAgyPermissionCard>
    try {
      card = preBuiltCard ?? buildAgyPermissionCard(params, cwd)
    } catch {
      await denyPermission()
      return
    }

    adjustActiveCount(1)
    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    try {
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection
            .respond(rpcId, { outcome: { outcome: 'cancelled' } })
            .catch(() => undefined)
        }
        return
      }
      pushEvent({
        agentId: 'agy',
        type: 'interaction.requested',
        turnId: input.runId,
        requestId: String(rpcId),
        category: 'approval',
      })
      const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
      const permWork = input.requestPermission(card.request, combinedSignal)
      void permWork.catch(() => undefined)
      const decisionId = await NativePermissionWait.decision(permWork, combinedSignal)
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection
            .respond(rpcId, { outcome: { outcome: 'cancelled' } })
            .catch(() => undefined)
        }
        return
      }
      const mappedResponse = card.responses.get(decisionId) ?? {
        outcome: { outcome: 'cancelled' },
      }
      await connection.respond(rpcId, mappedResponse)
      if (decisionId === 'agy-cancel') {
        const cancelSessionId = activeRun?.nativeSessionId ?? getSessionId()
        if (cancelSessionId) {
          await connection
            .notify('session/cancel', { sessionId: cancelSessionId }, {})
            .catch(() => undefined)
        }
      }
    } catch {
      if (connection.isOpen) {
        await connection
          .respond(rpcId, { outcome: { outcome: 'cancelled' } })
          .catch(() => undefined)
      }
    } finally {
      interactionControllers.delete(interactionAbort)
      endLocalWait()
      endConnectionWait()
      adjustActiveCount(-1)
    }
  }

  private async handleElicitationRequest(context: {
    connection: AgyAcpConnection
    validated: ValidatedAgyFrame
    rpcId: string | number
    params: Record<string, unknown>
    paramsObjectValid: boolean
    unscopedDuringForeignTurn: boolean
    preParsedRequest: NativeUserInputRequest | undefined
    input: AgentRunInput
    activeRun: ActiveAgyRun | undefined
    askOnlyStage: boolean
    readOnlyNonInteractive: boolean
    permissionWait: NativePermissionWait
    interactionControllers: Set<AbortController>
    pushEvent: (event: NormalizedAgentEvent) => void
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      validated,
      rpcId,
      params,
      paramsObjectValid,
      unscopedDuringForeignTurn,
      preParsedRequest,
      input,
      activeRun,
      askOnlyStage,
      readOnlyNonInteractive,
      permissionWait,
      interactionControllers,
      pushEvent,
      signal,
    } = context

    // Reject foreign, malformed, or root-contradicting elicitation requests before prompting the user.
    const executionContradicted =
      validated.executionIdInvalid ||
      unscopedDuringForeignTurn ||
      (validated.executionId !== undefined &&
        activeRun !== undefined &&
        (activeRun.knownForeignExecutionIds.has(validated.executionId) ||
          (activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId)))
    if (
      !paramsObjectValid ||
      executionContradicted ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.rootEvidenceContradicted ||
      validated.tokens.hasInvalidToken ||
      validated.tokens.hasConflictingTokens
    ) {
      await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
      return
    }

    if (!input.requestUserInput || askOnlyStage || readOnlyNonInteractive) {
      await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
      return
    }

    let uiRequest: NativeUserInputRequest
    try {
      uiRequest = preParsedRequest ?? agyElicitationRequest(params)
    } catch (error) {
      await connection
        .respondError(
          rpcId,
          error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.',
          -32_602,
        )
        .catch(() => undefined)
      return
    }

    const fenceEpoch = activeRun?.turnEpoch
    const fenceExecutor = activeRun?.executorId
    const fenceGen = activeRun?.bindingGeneration
    const isFenceCurrent = (): boolean =>
      !this.disposed &&
      !signal.aborted &&
      connection.isOpen &&
      (activeRun
        ? !activeRun.promptReplyReceived &&
          !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen &&
          !(
            validated.executionId !== undefined &&
            activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId
          )
        : true)

    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    try {
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
        }
        return
      }
      pushEvent({
        agentId: 'agy',
        type: 'interaction.requested',
        turnId: input.runId,
        requestId: String(rpcId),
        category: 'question',
      })
      const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
      const userWork = input.requestUserInput(uiRequest, combinedSignal)
      void userWork.catch(() => undefined)
      const decision = await NativePermissionWait.decision(userWork, combinedSignal)
      // Never replay a late answer into a retired or replacement Turn (`B5`).
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
        }
        return
      }
      if (decision.action === 'accept') {
        await connection.respond(
          rpcId,
          uiRequest.kind === 'url'
            ? { action: 'accept' }
            : { action: 'accept', content: decision.values ?? {} },
        )
      } else {
        await connection.respond(rpcId, { action: decision.action })
      }
    } catch {
      if (connection.isOpen) {
        await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
      }
    } finally {
      interactionControllers.delete(interactionAbort)
      endLocalWait()
      endConnectionWait()
    }
  }

  private *projectSessionNotification(context: {
    validated: ValidatedAgyFrame
    receivedAfterPromptReply: boolean
    input: AgentRunInput
    activeRun: ActiveAgyRun
    cwd: string
    mcpServer: AgyRunMcpServer
    roundTracker: AgyRoundEffectsTracker
    answer: AgentAnswerAssembler
    tools: Map<string, AgyToolState>
    resizeToolStateBytes: (state: AgyToolState, nextBytes: number) => void
    reasoningItems: Map<string, string>
    getReasoningBytes: () => number
    setReasoningBytes: (bytes: number) => void
    getMessageIndex: () => number
    bumpMessageIndex: () => void
    getThoughtIndex: () => number
    bumpThoughtIndex: () => void
    planModeStage: boolean
    onBrainPlanTouched: () => void
    onBrainPlanOpStarted: (callId: string) => void
    onBrainPlanDeferredReadback: (callId: string) => void
    onBrainPlanCaptured: (callId: string, plan: { nativeId: string; text: string }) => void
    onBrainPlanCaptureFailed: (callId?: string) => void
    onReviewAccepted: (obs: CollaborationReviewObservation) => void
    onInputResultAccepted: (obs: CollaborationInputObservation) => void
    onPlanRetainedAccepted: () => void
    onOpenPlanPublished: (plan: { nativeId: string; text: string }) => void
    onOpenPlanPublishFailed: () => void
    getSessionTitleEmitted: () => boolean
    markSessionTitleEmitted: () => void
    recordSeenForegroundMessageId: (msgIdentity: string, trustedStepIdx?: number) => void
    recordForegroundStepIdx: (stepIdx: number) => void
    onObservedBackgroundTask: () => void
    reportUnknown: (reason: string) => void
    observeFiles: (evidence: Parameters<typeof recordNativeChanges>[1]) => void
    signal: AbortSignal
  }): Generator<NormalizedAgentEvent> {
    const emitted: NormalizedAgentEvent[] = []
    const processFrame = (): void => {
      const { validated, input, activeRun } = context
      if (validated.method !== 'session/update') return
      if (validated.sessionAttribution === 'pure_foreign') return
      const update = validated.payload
      if (!update) return
      const sessionUpdate = validated.sessionUpdate
      if (!sessionUpdate) return

      const updateMeta = Reflect.get(update, '_meta')
      const steerId =
        sessionUpdate === 'user_message_chunk'
          ? (asString(update.pactSteerInputId) ??
            (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
          : undefined

      const updateExecId = validated.executionId
      const updateStepIdx = update.stepIdx ?? update.step_idx
      const frameRootContradictsPinned =
        !validated.isAttributableToCurrentSession ||
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        (updateExecId !== undefined &&
          activeRun.providerExecutionId !== undefined &&
          updateExecId !== activeRun.providerExecutionId) ||
        (updateExecId !== undefined && activeRun.knownForeignExecutionIds.has(updateExecId))
      const frameCanPinRoot =
        !steerId &&
        !context.receivedAfterPromptReply &&
        !frameRootContradictsPinned &&
        !validated.tokens.hasInvalidToken &&
        !validated.tokens.hasConflictingTokens

      // Allow contradictory frames to revoke disputed MCP evidence ONLY; never project text,
      // record steer consumption, update session metadata/activity, or settle work!
      if (frameRootContradictsPinned) {
        if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
          const disputedTokens = validated.tokens.allCanonicalTokens
          const tcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
          if (tcId !== undefined || disputedTokens.length > 0) {
            context.mcpServer.revokeDisputedTokens(tcId, disputedTokens)
          }
        }
        return
      }

      const trustedStepIdx =
        frameCanPinRoot && validated.stepIdx !== undefined ? validated.stepIdx : undefined

      // Bind `rootStepIdx` and trusted root trajectory ID ONLY after full intra-frame validation passes!
      if (frameCanPinRoot) {
        if (validated.stepIdx !== undefined) {
          context.recordForegroundStepIdx(validated.stepIdx)
          if (activeRun.rootStepIdx === undefined) {
            activeRun.rootStepIdx = validated.stepIdx
            context.mcpServer.notifyRootProofUpdated()
          }
        }
        if (validated.trajectoryId !== undefined) {
          context.mcpServer.pinRootTrajectoryId(validated.trajectoryId)
        } else if (
          validated.tokens.resolvedToken?.structured &&
          !validated.tokens.resolvedToken.structured.hasLeadingZeros
        ) {
          context.mcpServer.pinRootTrajectoryId(
            validated.tokens.resolvedToken.structured.trajectoryId,
          )
        }
      }

      const msgIdentity = asString(update.messageId ?? update.stepId ?? update.toolCallId)
      if (msgIdentity) {
        context.recordSeenForegroundMessageId(msgIdentity, trustedStepIdx)
      }

      if (sessionUpdate === 'session_info_update') {
        const title = asString(update.title)?.trim()
        if (title && title.length <= 120) {
          input.observeNativeTitle?.(activeRun.nativeSessionId, title)
          if (
            !context.getSessionTitleEmitted() &&
            sessionTitleInputSchema.safeParse({ title }).success
          ) {
            context.markSessionTitleEmitted()
            emitted.push({ agentId: 'agy', type: 'session.title.updated', title })
          }
        }
        return
      }

      if (sessionUpdate === 'available_commands_update') {
        this.skillCatalogListener?.()
        return
      }

      if (sessionUpdate === 'current_mode_update') {
        const nextMode = asString(update.currentModeId ?? update.modeId)
        if (nextMode) {
          const modeState = this.sessionModes.get(activeRun.nativeSessionId)
          if (modeState) modeState.currentModeId = nextMode
        }
        return
      }

      if (sessionUpdate === 'user_message_chunk') {
        // Correlate in-Turn steer consumption receipt if echoed on the live stream!
        if (
          steerId &&
          typeof updateStepIdx === 'number' &&
          Number.isSafeInteger(updateStepIdx) &&
          updateStepIdx >= 0 &&
          updateExecId
        ) {
          const steerEntry = activeRun.steeredInputs.get(steerId)
          if (steerEntry && !steerEntry.consumed) {
            steerEntry.candidateStepIdx = updateStepIdx
            steerEntry.candidateExecutionId = updateExecId
            if (activeRun.providerExecutionId) {
              if (this.tryPromoteStagedSteerCandidate(activeRun, steerId, steerEntry)) {
                input.recordInputConsumption?.(steerId, {
                  nativeSessionId: activeRun.nativeSessionId,
                  nativeTurnId: activeRun.nativeTurnId,
                  executorId: activeRun.executorId,
                })
              }
            }
          }
        }
        return
      }

      if (sessionUpdate === 'background_task_completed') {
        const completedTaskId = asString(update.taskId ?? update.backgroundTaskId)
        const completedToolCallId = asString(update.toolCallId ?? update.id)
        this.settleBackgroundTaskByAlias(activeRun, input, [completedTaskId, completedToolCallId])
        return
      }

      if (sessionUpdate === 'usage_update' || sessionUpdate === 'config_option_update') {
        return
      }

      // First substantive model/tool activity confirms Turn acceptance.
      if (!activeRun.turnAccepted) {
        activeRun.turnAccepted = true
        input.recordDispatch?.('accepted', activeRun.nativeSessionId, activeRun.executorId)
        this.recordEvidence(
          input,
          activeRun.nativeSessionId,
          activeRun.executorId,
          {
            kind: 'running',
            source: 'live_runtime',
          },
          activeRun.nativeTurnId,
        )
        emitted.push({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
      }

      if (sessionUpdate === 'agent_thought_chunk') {
        const content = isPlainObject(update.content) ? update.content : undefined
        const delta = content && content.type === 'text' ? asString(content.text) : undefined
        if (!delta) return
        const key = String(context.getThoughtIndex())
        const prev = context.reasoningItems.get(key) ?? ''
        const addedBytes = Buffer.byteLength(delta, 'utf8')
        if (
          (!context.reasoningItems.has(key) &&
            context.reasoningItems.size >= AGY_MAX_REASONING_ITEMS) ||
          context.getReasoningBytes() + addedBytes > AGY_MAX_REASONING_BYTES
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity reasoning summary exceeded the 2 MiB / 64-item budget.',
            false,
          )
        }
        context.setReasoningBytes(context.getReasoningBytes() + addedBytes)
        context.reasoningItems.set(key, prev + delta)
        const activityId = `${input.runId}:thought:${key}`
        emitted.push({
          agentId: 'agy',
          type: 'reasoning.summary.delta',
          turnId: input.runId,
          activityId,
          text: delta,
        })
        return
      }

      if (sessionUpdate === 'agent_message_chunk') {
        if (context.receivedAfterPromptReply) return
        const content = isPlainObject(update.content) ? update.content : undefined
        const text = content && content.type === 'text' ? asString(content.text) : undefined
        if (!text) return
        const itemId = `msg:${context.getMessageIndex()}`
        const delta = context.answer.append(itemId, text)
        if (delta) {
          emitted.push({
            agentId: 'agy',
            type: 'text.delta',
            turnId: input.runId,
            outputId: context.answer.outputId,
            text: delta,
          })
        }
        return
      }

      if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
        // Bump message & thought item indices across tool boundaries so multi-segment answers separate cleanly.
        if (sessionUpdate === 'tool_call') {
          const currentMsgKey = `msg:${context.getMessageIndex()}`
          if (context.answer.text.length > 0 && currentMsgKey) {
            context.bumpMessageIndex()
          }
          const currentThoughtKey = String(context.getThoughtIndex())
          const priorThought = context.reasoningItems.get(currentThoughtKey)
          if (priorThought) {
            emitted.push({
              agentId: 'agy',
              type: 'reasoning.summary.completed',
              turnId: input.runId,
              activityId: `${input.runId}:thought:${currentThoughtKey}`,
              text: priorThought,
            })
            context.reasoningItems.delete(currentThoughtKey)
            context.bumpThoughtIndex()
          }
        }

        const disputedTokens = validated.tokens.allCanonicalTokens
        const resolvedPt = validated.tokens.resolvedToken
        const toolCallId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
        if (!toolCallId) {
          if (disputedTokens.length > 0) {
            const rawToolName = validated.explicitToolName ?? ''
            if (
              validated.explicitToolNameInvalid ||
              !context.mcpServer.isAuthorizedMcpToolCallName(rawToolName)
            ) {
              context.mcpServer.observeNonPactCall(undefined, disputedTokens)
            } else {
              context.mcpServer.revokeDisputedTokens(undefined, disputedTokens)
            }
          }
          return
        }
        const hasExplicitStatus = validated.statusPresent
        const normalizedIncomingStatus = validated.status
        const incomingStatusInvalid = validated.statusInvalid

        let state = context.tools.get(toolCallId)
        if (!state) {
          if (context.tools.size >= AGY_MAX_TOOL_STATES) {
            // Evict oldest completed tool state to stay within <= 64 active items.
            for (const [k, existing] of context.tools) {
              if (existing.completedEmitted) {
                context.resizeToolStateBytes(existing, 0)
                context.tools.delete(k)
                break
              }
            }
          }
          if (context.tools.size >= AGY_MAX_TOOL_STATES) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity exceeded the 64-item concurrent tool call budget.',
              false,
            )
          }
          const inheritedExplicitName =
            validated.explicitToolName === undefined && !validated.explicitToolNameInvalid
              ? context.mcpServer.lookupVerifiedCallToolName(toolCallId)
              : undefined
          const initialExplicitName = validated.explicitToolName ?? inheritedExplicitName
          state = {
            toolCallId,
            // Display name may fall back to `update.kind`; authorization STRICTLY uses `explicitToolName`!
            name: initialExplicitName ?? asString(update.kind)?.slice(0, 120) ?? 'tool',
            ...(initialExplicitName !== undefined ? { explicitToolName: initialExplicitName } : {}),
            ...(validated.explicitToolNameInvalid ? { toolIdentityConflicted: true } : {}),
            title: (asString(update.title) ?? initialExplicitName ?? 'Tool').slice(0, 160),
            status: normalizedIncomingStatus ?? 'pending',
            ...(incomingStatusInvalid ? { invalidStatus: true } : {}),
            reservedBytes: 0,
            startedEmitted: false,
            completedEmitted: false,
          }
          context.tools.set(toolCallId, state)
        } else {
          if (validated.explicitToolNameInvalid) {
            context.mcpServer.revokeDisputedTokens(
              state.toolCallId,
              state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
            )
            state.toolIdentityConflicted = true
          } else if (validated.explicitToolName !== undefined) {
            const incomingName = validated.explicitToolName
            if (state.explicitToolName !== undefined && incomingName !== state.explicitToolName) {
              context.mcpServer.revokeDisputedTokens(
                state.toolCallId,
                state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
              )
              state.toolIdentityConflicted = true
            } else if (state.explicitToolName === undefined) {
              state.explicitToolName = incomingName
            }
            state.name = incomingName
          }
          if (asString(update.title)) state.title = asString(update.title)!.slice(0, 160)
          if (hasExplicitStatus) {
            if (normalizedIncomingStatus !== undefined) {
              state.status = normalizedIncomingStatus
            } else {
              state.invalidStatus = true
            }
          }
        }

        const verifiedAuthToolName = state.explicitToolName ?? ''
        const isAuthorizedPactTool =
          !state.toolIdentityConflicted &&
          Boolean(context.mcpServer.isAuthorizedMcpToolCallName(verifiedAuthToolName))

        if (validated.tokens.suppliedCount > 0) {
          if (
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens ||
            !resolvedPt
          ) {
            state.invalidProgressToken = true
            state.progressToken = undefined
            if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
              context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
            } else {
              context.mcpServer.revokeDisputedTokens(state.toolCallId, disputedTokens)
            }
          } else {
            if (state.progressToken !== undefined && state.progressToken !== resolvedPt.canonical) {
              state.invalidProgressToken = true
              context.mcpServer.revokeDisputedTokens(state.toolCallId, [
                state.progressToken,
                resolvedPt.canonical,
              ])
              state.progressToken = undefined
            } else if (!state.invalidProgressToken) {
              state.progressToken = resolvedPt.canonical
            }
            if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
              context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
            }
          }
        } else if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
          // Explicit non-Pact call without progressToken MUST still register negative ownership on its call ID!
          context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
        }

        const computeCompactToolStateBytes = (): number =>
          64 +
          Buffer.byteLength(state.toolCallId, 'utf8') +
          Buffer.byteLength(state.name, 'utf8') +
          Buffer.byteLength(state.title, 'utf8') +
          Buffer.byteLength(state.status, 'utf8') +
          (state.detail ? Buffer.byteLength(state.detail, 'utf8') + 16 : 0) +
          (state.progressToken ? Buffer.byteLength(state.progressToken, 'utf8') + 16 : 0)

        const computeToolStateBytes = (extraBytes = 0): number =>
          computeCompactToolStateBytes() +
          extraBytes +
          (state.argsBytes ?? 0) +
          (state.rawInputBytes ?? 0) +
          (state.mergedArgsBytes ?? 0) +
          (state.rawOutputBytes ?? 0) +
          (state.contentBytes ?? 0) +
          (state.locationsBytes ?? 0)

        const frameArgs = validated.frameArgs
        const frameRawInput = validated.frameRawInput
        const frameArgsEvidence = validated.argsEvidence

        let acpAdmission: AcpToolCallAdmissionResult = 'already_retired'
        if (!state.completedEmitted) {
          if (frameArgsEvidence.kind === 'invalid_or_conflict') {
            state.argsConflicted = true
          } else if (frameArgsEvidence.kind === 'present') {
            const merged = mergePlainArgsRecords(state.mergedArgs, frameArgsEvidence.args)
            if (merged.kind === 'conflict') {
              state.argsConflicted = true
            } else {
              state.mergedArgs = merged.args
              state.mergedArgsBytes = estimateJsonPayloadBytes(state.mergedArgs)
            }
          }
          if (frameArgs) {
            state.args = frameArgs
            state.argsBytes = estimateJsonPayloadBytes(state.args)
          }
          if (frameRawInput) {
            state.rawInput = frameRawInput
            state.rawInputBytes = estimateJsonPayloadBytes(state.rawInput)
          }
          if ('rawOutput' in update) {
            state.rawOutput = update.rawOutput
            state.rawOutputBytes = estimateJsonPayloadBytes(state.rawOutput)
          }
          if (Array.isArray(update.content)) {
            state.content = update.content
            state.contentBytes = estimateJsonPayloadBytes(state.content)
          }
          if (Array.isArray(update.locations)) {
            state.locations = update.locations
            state.locationsBytes = estimateJsonPayloadBytes(state.locations)
          }
          const effectiveArgsForDetail =
            state.mergedArgs ?? frameArgs ?? frameRawInput ?? state.args ?? state.rawInput
          if (effectiveArgsForDetail) {
            const targetPath = asString(effectiveArgsForDetail.Path ?? effectiveArgsForDetail.path)
            const command = asString(
              effectiveArgsForDetail.CommandLine ?? effectiveArgsForDetail.command,
            )
            if (targetPath) state.detail = AgentActivityDetail.projectPath(targetPath, context.cwd)
            else if (command) state.detail = AgentActivityDetail.redact(command)
          }
          context.resizeToolStateBytes(state, computeToolStateBytes())
          if (state.toolIdentityConflicted) {
            context.mcpServer.revokeDisputedTokens(
              state.toolCallId,
              state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
            )
          } else if (!context.receivedAfterPromptReply) {
            if (verifiedAuthToolName.length > 0) {
              acpAdmission = context.mcpServer.observeAcpToolCall({
                toolCallId: state.toolCallId,
                rawToolName: verifiedAuthToolName,
                status: state.status,
                ...(state.invalidStatus || incomingStatusInvalid ? { invalidStatus: true } : {}),
                ...(frameArgsEvidence.kind === 'present'
                  ? {
                      args: frameArgsEvidence.args,
                      argsFingerprint: frameArgsEvidence.fingerprint,
                    }
                  : {}),
                ...(frameArgsEvidence.kind === 'invalid_or_conflict' || state.argsConflicted
                  ? { invalidArgs: true }
                  : {}),
                ...(resolvedPt !== undefined
                  ? { progressToken: resolvedPt.canonical }
                  : state.progressToken !== undefined
                    ? { progressToken: state.progressToken }
                    : {}),
                ...(disputedTokens.length > 0 ? { disputedTokens } : {}),
                ...(state.invalidProgressToken ||
                validated.tokens.hasInvalidToken ||
                validated.tokens.hasConflictingTokens
                  ? { invalidProgressToken: true }
                  : {}),
                ...(validated.trajectoryId !== undefined
                  ? { trajectoryId: validated.trajectoryId }
                  : {}),
                ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
                ...(frameRootContradictsPinned ? { rootEvidenceContradicted: true } : {}),
              })
            } else if (
              frameRootContradictsPinned ||
              state.invalidProgressToken ||
              state.argsConflicted ||
              incomingStatusInvalid
            ) {
              context.mcpServer.revokeDisputedTokens(state.toolCallId, disputedTokens)
            }
          }
        }

        const effectiveArgs = state.mergedArgs ?? state.args ?? state.rawInput

        // Detect and correlate background task launches (`toolCallId` <-> `rawOutput.taskId`).
        const spawnedTaskId = isPlainObject(state.rawOutput)
          ? asString(state.rawOutput.taskId ?? state.rawOutput.backgroundTaskId)
          : undefined
        if (
          (state.name === 'run_command' && effectiveArgs?.IsDaemon === true) ||
          state.name === 'schedule' ||
          Boolean(spawnedTaskId) ||
          activeRun.backgroundTaskAliases.has(state.toolCallId)
        ) {
          this.trackBackgroundTaskLaunch(
            activeRun,
            input,
            state.toolCallId,
            spawnedTaskId,
            state.status,
            context.onObservedBackgroundTask,
            context.reportUnknown,
          )
        }

        // Observe Phase-1 Brain Plan writes (`<appDataDir>/brain/<sessionId>/*.md` with `ArtifactMetadata`).
        // Consumes the SAME single-pass validated frame (pre-cutoff, current-root-attributed, exact
        // `write_file`/`edit_file`, monotonically merged args, matching diff path, completed terminal).
        const isExactBrainPlanTool =
          !state.toolIdentityConflicted &&
          (state.explicitToolName === 'write_file' || state.explicitToolName === 'edit_file')
        if (!state.completedEmitted && context.planModeStage && isExactBrainPlanTool) {
          const argPath = effectiveArgs
            ? asString(effectiveArgs.Path ?? effectiveArgs.path)
            : undefined
          const diffBlocks = Array.isArray(state.content)
            ? state.content.filter(
                (c): c is Record<string, unknown> => isPlainObject(c) && c.type === 'diff',
              )
            : []
          const argIsBrainPlan =
            argPath !== undefined &&
            isMarkdownBrainPlanArtifact(
              argPath,
              context.cwd,
              this.appDataDirs,
              activeRun.nativeSessionId,
            )
          const anyDiffIsBrainPlan = diffBlocks.some((d) => {
            const dp = asString(d.path)
            return (
              dp !== undefined &&
              isMarkdownBrainPlanArtifact(
                dp,
                context.cwd,
                this.appDataDirs,
                activeRun.nativeSessionId,
              )
            )
          })

          if (argIsBrainPlan || anyDiffIsBrainPlan) {
            context.onBrainPlanTouched()
            const frameInvalidForPlan =
              context.receivedAfterPromptReply ||
              frameRootContradictsPinned ||
              state.argsConflicted === true ||
              frameArgsEvidence.kind === 'invalid_or_conflict' ||
              state.invalidStatus === true ||
              incomingStatusInvalid ||
              state.invalidProgressToken === true
            if (frameInvalidForPlan) {
              context.onBrainPlanCaptureFailed(state.toolCallId)
            } else if (
              state.status !== 'completed' &&
              state.status !== 'failed' &&
              state.status !== 'cancelled'
            ) {
              context.onBrainPlanOpStarted(state.toolCallId)
            } else if (state.status === 'failed' || state.status === 'cancelled') {
              context.onBrainPlanCaptureFailed(state.toolCallId)
            } else if (state.status === 'completed') {
              if (
                !argIsBrainPlan ||
                !argPath ||
                !effectiveArgs ||
                !hasValidArtifactMetadata(effectiveArgs)
              ) {
                context.onBrainPlanCaptureFailed(state.toolCallId)
              } else if (diffBlocks.length > 1) {
                context.onBrainPlanCaptureFailed(state.toolCallId)
              } else {
                const expectedPlanPath = resolvePath(context.cwd, argPath)
                let candidateText: string | undefined
                let pathMismatch = false
                if (diffBlocks.length === 1) {
                  const diffBlock = diffBlocks[0]!
                  const rawDiffPath = asString(diffBlock.path)
                  if (
                    !rawDiffPath ||
                    resolvePath(context.cwd, rawDiffPath) !== expectedPlanPath ||
                    typeof diffBlock.newText !== 'string'
                  ) {
                    pathMismatch = true
                  } else {
                    candidateText = diffBlock.newText
                  }
                } else if (
                  state.explicitToolName === 'write_file' &&
                  effectiveArgs.Append !== true &&
                  typeof effectiveArgs.Content === 'string'
                ) {
                  candidateText = effectiveArgs.Content
                }
                if (
                  !pathMismatch &&
                  candidateText &&
                  candidateText.trim().length > 0 &&
                  Buffer.byteLength(candidateText, 'utf8') <= COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
                ) {
                  context.onBrainPlanCaptured(state.toolCallId, {
                    nativeId: buildBoundedNativePlanId(activeRun.nativeSessionId, state.toolCallId),
                    text: candidateText,
                  })
                } else if (state.explicitToolName === 'edit_file' && diffBlocks.length === 0) {
                  // `edit_file` without inline full `newText` diff block invalidates any earlier
                  // candidate so terminal cold `storageClient.inspectRun(..., { includePlan: true })`
                  // always reads back the updated post-edit body.
                  context.onBrainPlanDeferredReadback(state.toolCallId)
                } else {
                  context.onBrainPlanCaptureFailed(state.toolCallId)
                }
              }
            }
          }
        }

        if (!state.startedEmitted) {
          state.startedEmitted = true
          emitted.push({
            agentId: 'agy',
            type: 'tool.started',
            turnId: input.runId,
            toolCallId: state.toolCallId,
            toolName: state.name,
            title: state.title,
            ...(state.detail ? { detail: state.detail } : {}),
          })
        }

        const isTerminalToolStatus =
          state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled'
        if (!state.completedEmitted && isTerminalToolStatus) {
          state.completedEmitted = true

          // Promote staged Pact MCP tool outcomes strictly when this terminal transition was admitted.
          if (
            !context.receivedAfterPromptReply &&
            state.status === 'completed' &&
            !state.invalidStatus &&
            !incomingStatusInvalid &&
            !state.invalidProgressToken &&
            !state.toolIdentityConflicted &&
            !state.argsConflicted &&
            frameArgsEvidence.kind !== 'invalid_or_conflict' &&
            !frameRootContradictsPinned &&
            verifiedAuthToolName.length > 0 &&
            acpAdmission === 'admitted'
          ) {
            const promoted = context.mcpServer.promoteCompletedAcpToolCall({
              toolCallId: state.toolCallId,
              rawToolName: verifiedAuthToolName,
              ...(resolvedPt !== undefined
                ? { progressToken: resolvedPt.canonical }
                : state.progressToken !== undefined
                  ? { progressToken: state.progressToken }
                  : {}),
              ...(state.invalidProgressToken ? { invalidProgressToken: true } : {}),
              ...(frameArgsEvidence.kind === 'present'
                ? {
                    args: frameArgsEvidence.args,
                    argsFingerprint: frameArgsEvidence.fingerprint,
                  }
                : {}),
              ...(validated.trajectoryId !== undefined
                ? { trajectoryId: validated.trajectoryId }
                : {}),
              ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
              ...(frameRootContradictsPinned ? { rootEvidenceContradicted: true } : {}),
              receivedAfterPromptReply: context.receivedAfterPromptReply,
            })
            if (promoted) {
              if (promoted.type === 'title' && !context.getSessionTitleEmitted()) {
                context.markSessionTitleEmitted()
                emitted.push({
                  agentId: 'agy',
                  type: 'session.title.updated',
                  title: promoted.title,
                })
              } else if (promoted.type === 'peer') {
                emitted.push({
                  agentId: 'agy',
                  type: 'peer.assistance.requested',
                  turnId: input.runId,
                  proposalId: randomUUID(),
                  targetAgentId: promoted.targetAgentId,
                  kind: promoted.proposalKind,
                  ...(promoted.reason ? { reason: promoted.reason } : {}),
                })
              } else if (promoted.type === 'review') {
                context.onReviewAccepted(promoted.observation)
              } else if (promoted.type === 'input_result') {
                context.onInputResultAccepted(promoted.observation)
              } else if (promoted.type === 'retain_plan') {
                context.onPlanRetainedAccepted()
              } else if (promoted.type === 'publish_plan') {
                context.onOpenPlanPublished({
                  nativeId: buildBoundedNativePlanId(
                    activeRun.nativeSessionId,
                    promoted.finalToolCallId,
                  ),
                  text: promoted.markdown,
                })
              } else if (promoted.type === 'publish_plan_failed') {
                context.onOpenPlanPublishFailed()
              }
            }
          } else if (
            state.status !== 'completed' ||
            state.invalidProgressToken ||
            state.toolIdentityConflicted ||
            state.argsConflicted
          ) {
            context.mcpServer.failAcpToolCall({
              toolCallId: state.toolCallId,
              rawToolName: verifiedAuthToolName || state.name,
              ...(state.progressToken !== undefined ? { progressToken: state.progressToken } : {}),
            })
          }

          // File change & round command/tool uncertainty classification (`B9` / Module 6).
          const mergedItem = {
            name: state.name,
            status: state.status,
            args: state.args,
            rawInput: state.rawInput,
            rawOutput: state.rawOutput,
            content: state.content,
            locations: state.locations,
          }
          if (
            state.name === 'write_file' ||
            state.name === 'edit_file' ||
            state.name === 'delete_file' ||
            state.name === 'remove_file' ||
            state.name === 'move_file' ||
            state.name === 'rename_file'
          ) {
            const fileEvidence = context.roundTracker.observeFileTool(mergedItem)
            fileEvidence.changes = fileEvidence.changes.map((change, index) => ({
              ...change,
              operationId: `${state.toolCallId}:${index}`,
            }))
            if (fileEvidence.changes.length > 0 || fileEvidence.uncertain) {
              context.observeFiles(fileEvidence)
            }
          } else {
            const nonFile = context.roundTracker.observeNonFileTool(mergedItem)
            if (nonFile.uncertain && nonFile.reason) {
              nativeEffectsUncertain(input, nonFile.reason, nonFile.scope)
            }
          }

          // Immediately release heavy tool payload fields and progressToken on completion while
          // keeping retained compact dedup metadata accurately charged until eviction!
          state.args = undefined
          state.argsBytes = 0
          state.rawInput = undefined
          state.rawInputBytes = 0
          state.mergedArgs = undefined
          state.mergedArgsBytes = 0
          state.rawOutput = undefined
          state.rawOutputBytes = 0
          state.content = undefined
          state.contentBytes = 0
          state.locations = undefined
          state.locationsBytes = 0
          state.progressToken = undefined
          context.resizeToolStateBytes(state, computeCompactToolStateBytes())

          emitted.push({
            agentId: 'agy',
            type: 'tool.completed',
            turnId: input.runId,
            toolCallId: state.toolCallId,
            toolName: state.name,
            title: state.title,
            ...(state.detail ? { detail: state.detail } : {}),
            outcome: state.status === 'completed' ? 'completed' : 'failed',
          })
        }
        return
      }

      emitted.push({
        agentId: 'agy',
        type: 'unrecognized',
        nativeType: sessionUpdate.slice(0, 120),
        turnId: input.runId,
      })
    }

    context.mcpServer.beginWakeBatch()
    try {
      processFrame()
    } finally {
      context.mcpServer.endWakeBatch()
    }
    yield* emitted
  }

  private bindRootExecutionId(
    activeRun: ActiveAgyRun,
    input: AgentRunInput,
    executionId: string,
  ): void {
    if (!executionId || activeRun.providerExecutionId) return
    activeRun.providerExecutionId = executionId
    for (const [steerId, entry] of activeRun.steeredInputs) {
      if (!entry.consumed && this.tryPromoteStagedSteerCandidate(activeRun, steerId, entry)) {
        input.recordInputConsumption?.(steerId, {
          nativeSessionId: activeRun.nativeSessionId,
          nativeTurnId: activeRun.nativeTurnId,
          executorId: activeRun.executorId,
        })
      }
    }
    this.notifyRootExecutionWaiters(activeRun)
  }

  private notifyRootExecutionWaiters(activeRun: ActiveAgyRun): void {
    for (const notify of activeRun.rootExecutionWaiters) {
      notify()
    }
    activeRun.rootExecutionWaiters.clear()
  }

  private async waitForRootExecutionBinding(
    activeRun: ActiveAgyRun,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      activeRun.providerExecutionId ||
      activeRun.promptReplyReceived ||
      activeRun.rootReleasing ||
      activeRun.rootTerminal ||
      signal.aborted
    ) {
      return
    }
    await new Promise<void>((resolveWait) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        activeRun.rootExecutionWaiters.delete(finish)
        resolveWait()
      }
      const timer = setTimeout(finish, AGY_PROMPT_ACCEPT_TIMEOUT_MS)
      timer.unref?.()
      signal.addEventListener('abort', finish, { once: true })
      activeRun.rootExecutionWaiters.add(finish)
    })
  }

  private isValidSteerStepOrder(
    activeRun: ActiveAgyRun,
    steerInputId: string,
    candidateStepIdx: number,
  ): boolean {
    if (!Number.isSafeInteger(candidateStepIdx) || candidateStepIdx < 0) return false
    const minRootStep = activeRun.rootStepIdx ?? 0
    if (candidateStepIdx <= minRootStep) return false

    let sawCurrent = false
    for (const [id, existing] of activeRun.steeredInputs) {
      if (id === steerInputId) {
        sawCurrent = true
        continue
      }
      if (!existing.consumed || existing.stepIdx === undefined) continue
      if (!sawCurrent && candidateStepIdx <= existing.stepIdx) {
        return false
      }
      if (sawCurrent && candidateStepIdx >= existing.stepIdx) {
        return false
      }
    }
    return true
  }

  private tryPromoteStagedSteerCandidate(
    activeRun: ActiveAgyRun,
    steerInputId: string,
    entry: AgySteerEntry,
  ): boolean {
    if (entry.consumed) return true
    if (
      !activeRun.providerExecutionId ||
      entry.candidateExecutionId === undefined ||
      entry.candidateStepIdx === undefined
    ) {
      return false
    }
    if (entry.candidateExecutionId !== activeRun.providerExecutionId) {
      return false
    }
    if (!this.isValidSteerStepOrder(activeRun, steerInputId, entry.candidateStepIdx)) {
      return false
    }
    entry.stepIdx = entry.candidateStepIdx
    entry.executionId = entry.candidateExecutionId
    entry.consumed = true
    return true
  }

  private async verifySteerReceiptsBeforeRootRelease(
    activeRun: ActiveAgyRun,
    input: AgentRunInput,
    reportUnknown: (reason: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let previousStepIdx = activeRun.rootStepIdx ?? 0
    for (const [inputId, entry] of activeRun.steeredInputs) {
      if (!entry.dispatched) continue
      if (!entry.consumed && activeRun.providerExecutionId) {
        if (this.tryPromoteStagedSteerCandidate(activeRun, inputId, entry)) {
          input.recordInputConsumption?.(inputId, {
            nativeSessionId: activeRun.nativeSessionId,
            nativeTurnId: activeRun.nativeTurnId,
            executorId: activeRun.executorId,
          })
        }
      }
      if (!entry.consumed && this.options.storageClient?.verifySteerConsumption) {
        // oxlint-disable-next-line no-await-in-loop -- Bounded in-Turn steer verification before root release.
        const receipt = await this.options.storageClient
          .verifySteerConsumption(
            {
              appDataDir: this.primaryAppDataDir,
              cwd: activeRun.cwd,
              nativeSessionId: activeRun.nativeSessionId,
              nativeTurnId: activeRun.runId,
              executionId: activeRun.providerExecutionId,
              inputId,
              minStepIdx: previousStepIdx,
            },
            signal,
          )
          .catch((): AgySteerConsumptionReceipt => ({ consumed: false }))
        if (receipt.consumed && receipt.executionId !== undefined) {
          if (!activeRun.providerExecutionId) {
            this.bindRootExecutionId(activeRun, input, receipt.executionId)
          }
          if (
            receipt.executionId === activeRun.providerExecutionId &&
            (entry.candidateExecutionId === undefined ||
              entry.candidateExecutionId === activeRun.providerExecutionId) &&
            typeof receipt.stepIdx === 'number' &&
            receipt.stepIdx > previousStepIdx
          ) {
            entry.stepIdx = receipt.stepIdx
            entry.executionId = receipt.executionId
            entry.consumed = true
            input.recordInputConsumption?.(inputId, {
              nativeSessionId: activeRun.nativeSessionId,
              nativeTurnId: activeRun.nativeTurnId,
              executorId: activeRun.executorId,
            })
          }
        }
      }
      if (
        !entry.consumed ||
        !activeRun.providerExecutionId ||
        entry.executionId !== activeRun.providerExecutionId ||
        typeof entry.stepIdx !== 'number' ||
        entry.stepIdx <= previousStepIdx
      ) {
        reportUnknown(
          'A steered Antigravity message crossed the root Turn boundary without an in-Turn consumption receipt.',
        )
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer write crossed the Turn boundary without an in-Turn consumption receipt.',
          false,
        )
      }
      previousStepIdx = entry.stepIdx
    }
  }

  private trackBackgroundTaskLaunch(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'backgroundWorkChanged'>,
    toolCallId: string,
    spawnedTaskId: string | undefined,
    status: string,
    onObservedBackgroundTask: () => void,
    reportUnknown?: (reason: string) => void,
  ): void {
    const existingCanonical =
      activeRun.backgroundTaskAliases.get(toolCallId) ??
      (spawnedTaskId ? activeRun.backgroundTaskAliases.get(spawnedTaskId) : undefined)

    if ((status === 'failed' || status === 'cancelled') && !spawnedTaskId) {
      if (existingCanonical) {
        this.settleBackgroundTaskByAlias(activeRun, input, [toolCallId])
      }
      return
    }

    onObservedBackgroundTask()
    const canonicalKey = existingCanonical ?? spawnedTaskId ?? toolCallId
    let changed = false
    if (!existingCanonical) {
      if (activeRun.activeBackgroundTasks.size >= 64) {
        if (!activeRun.backgroundUnconfirmed) {
          activeRun.backgroundUnconfirmed = true
          reportUnknown?.(
            'Antigravity exceeded the 64-task active background tracking budget; background effects remain unconfirmed.',
          )
          input.backgroundWorkChanged?.()
        }
        return
      }
      activeRun.activeBackgroundTasks.add(canonicalKey)
      changed = true
    }
    if (activeRun.backgroundTaskAliases.size < 256) {
      activeRun.backgroundTaskAliases.set(toolCallId, canonicalKey)
      if (spawnedTaskId) {
        activeRun.backgroundTaskAliases.set(spawnedTaskId, canonicalKey)
      }
    }
    if (changed) {
      input.backgroundWorkChanged?.()
    }
  }

  private settleBackgroundTaskByAlias(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'backgroundWorkChanged'>,
    ids: readonly (string | undefined)[],
  ): boolean {
    let canonicalKey: string | undefined
    for (const id of ids) {
      if (!id) continue
      const mapped = activeRun.backgroundTaskAliases.get(id)
      if (mapped) {
        canonicalKey = mapped
        break
      }
      if (activeRun.activeBackgroundTasks.has(id)) {
        canonicalKey = id
        break
      }
    }
    if (!canonicalKey) return false
    const removed = activeRun.activeBackgroundTasks.delete(canonicalKey)
    for (const [alias, target] of activeRun.backgroundTaskAliases) {
      if (target === canonicalKey) {
        activeRun.backgroundTaskAliases.delete(alias)
      }
    }
    if (removed) {
      input.backgroundWorkChanged?.()
    }
    return removed
  }

  private async handlePostTurnBackgroundUpdate(context: {
    record: CompactPostCutoffBackgroundRecord
    input: AgentRunInput
    activeRun: ActiveAgyRun
    observedBackgroundTask: boolean
    canSettleEffects: () => boolean
    isRootTerminal: () => boolean
    seenForegroundMessageIds: Set<string>
    isForegroundDedupIncomplete: () => boolean
    hasOmittedForegroundIdWithoutStep: () => boolean
    getMaxForegroundStepIdx: () => number | undefined
    getPinnedTrajectory: () => string | undefined
    getMinStepIdx: () => number | undefined
    reportedBackgroundMessageIds: Set<string>
    reportUnknown: (reason: string) => void
  }): Promise<void> {
    const {
      record,
      input,
      activeRun,
      observedBackgroundTask,
      canSettleEffects,
      isRootTerminal,
      seenForegroundMessageIds,
      isForegroundDedupIncomplete,
      hasOmittedForegroundIdWithoutStep,
      getMaxForegroundStepIdx,
      getPinnedTrajectory,
      getMinStepIdx,
      reportedBackgroundMessageIds,
      reportUnknown,
    } = context

    // Re-check validated owner evidence against the run's latest execution, pinned trajectory,
    // and step lower bound BEFORE BOTH report persistence and task settlement!
    const pinnedTrajectory = getPinnedTrajectory()
    const minStepIdx = getMinStepIdx()
    const { ownership } = record
    if (
      ownership.executionId !== undefined &&
      (activeRun.knownForeignExecutionIds.has(ownership.executionId) ||
        (activeRun.providerExecutionId !== undefined &&
          ownership.executionId !== activeRun.providerExecutionId))
    ) {
      return
    }
    if (
      ownership.trajectoryId !== undefined &&
      pinnedTrajectory !== undefined &&
      ownership.trajectoryId !== pinnedTrajectory
    ) {
      return
    }
    if (
      ownership.stepIdx !== undefined &&
      minStepIdx !== undefined &&
      ownership.stepIdx < minStepIdx
    ) {
      return
    }

    const { sessionUpdate, status, outOfTurn, taskId, toolCallId, explicitMsgId, rawText } = record

    try {
      if (observedBackgroundTask && input.recordBackgroundReport) {
        // Never fabricate background reports from cancel ACKs, empty chunks, or foreground messages!
        const isOutOfTurnCompletion =
          (sessionUpdate === 'agent_message_chunk' && outOfTurn) ||
          sessionUpdate === 'background_task_completed' ||
          (sessionUpdate === 'tool_call_update' && status === 'completed' && outOfTurn)

        if (isOutOfTurnCompletion) {
          const fallbackId =
            sessionUpdate === 'background_task_completed' ? (taskId ?? toolCallId) : toolCallId
          const nativeMessageId =
            explicitMsgId ??
            (sessionUpdate === 'background_task_completed' && fallbackId
              ? `bg-task-completed:${fallbackId}`
              : fallbackId)

          const bgStepIdx = ownership.stepIdx
          const bgSameTrajectory =
            ownership.trajectoryId === undefined ||
            pinnedTrajectory === undefined ||
            ownership.trajectoryId === pinnedTrajectory
          const maxFgStepIdx = getMaxForegroundStepIdx()
          // Only when ALL omitted foreground dedup IDs had trusted same-trajectory stepIdx can
          // `bgStepIdx > maxFgStepIdx` prove novelty!
          const dedupCanProveNovelty =
            !isForegroundDedupIncomplete() ||
            (!hasOmittedForegroundIdWithoutStep() &&
              bgSameTrajectory &&
              bgStepIdx !== undefined &&
              maxFgStepIdx !== undefined &&
              bgStepIdx > maxFgStepIdx)

          if (
            isEligibleAgyBackgroundReportId(nativeMessageId) &&
            dedupCanProveNovelty &&
            !seenForegroundMessageIds.has(nativeMessageId) &&
            !reportedBackgroundMessageIds.has(nativeMessageId)
          ) {
            if (rawText && /\S/u.test(rawText)) {
              const frameId = deterministicUuid(
                `agy-bg:${input.runId}:${activeRun.nativeSessionId}:${activeRun.executorId}:${nativeMessageId}`,
              )
              const identity = nativeBackgroundReportIdentitySchema.parse({
                agentId: 'agy',
                runId: input.runId,
                nativeSessionId: activeRun.nativeSessionId,
                nativeTurnId: activeRun.nativeTurnId,
                bindingGeneration: activeRun.bindingGeneration,
                executorId: activeRun.executorId,
                frameId,
                nativeMessageId,
              })

              if (reportedBackgroundMessageIds.size >= 64) {
                activeRun.backgroundUnconfirmed = true
                input.recordBackgroundReportUnavailable?.(identity)
                reportUnknown(
                  'Antigravity background report tracking reached the 64-report per-run cap; coverage is incomplete.',
                )
              } else {
                reportedBackgroundMessageIds.add(nativeMessageId)
                let reservation: NativeMemoryReservation | undefined
                try {
                  const byteLength = Buffer.byteLength(rawText, 'utf8')
                  reservation = activeRun.connection.reserveWorkingMemory(
                    4096 + rawText.length * 10 + byteLength * 2,
                  )
                  await input.recordBackgroundReport({ ...identity, text: rawText })
                } catch (error) {
                  if (input.recordBackgroundReportUnavailable) {
                    input.recordBackgroundReportUnavailable(identity)
                  } else {
                    recordDiagnostic({
                      operation: 'native_check',
                      phase: 'failed',
                      level: 'warn',
                      scope: 'run',
                      sessionId: input.sessionId,
                      runId: input.runId,
                      agentId: 'agy',
                      runtimeBoundary: 'archive',
                      code: classifyAgentError(error).kind,
                    })
                  }
                } finally {
                  reservation?.release()
                }
              }
            }
          }
        }
      }
    } finally {
      // Settle tracked background task completion states and release observer/lease immediately when all settle!
      const isTerminalTaskUpdate =
        sessionUpdate === 'background_task_completed' ||
        (sessionUpdate === 'tool_call_update' &&
          (status === 'completed' || status === 'failed' || status === 'cancelled'))
      if (isTerminalTaskUpdate) {
        const settledAny = this.settleBackgroundTaskByAlias(activeRun, input, [taskId, toolCallId])
        if (settledAny && activeRun.activeBackgroundTasks.size === 0 && isRootTerminal()) {
          if (!activeRun.backgroundUnconfirmed && canSettleEffects()) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }
          activeRun.observation.abort()
        }
      }
    }
  }

  private extractConfigOptionsFromNotification(
    notification: object,
    expectedSessionId?: string,
  ): AcpConfigOptionEntry[] | undefined {
    if (!isPlainObject(notification)) return undefined
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return undefined
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      expectedSessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'config_option_update' ||
      !validated.payload
    ) {
      return undefined
    }
    const raw = validated.payload.configOptions ?? validated.payload.options
    if (!Array.isArray(raw)) return undefined
    return parseConfigOptions(raw)
  }

  private observeSessionTitleFromNotification(
    notification: object,
    sessionId: string,
    input: Pick<AgentRunInput, 'observeNativeTitle'>,
  ): void {
    if (!isPlainObject(notification)) return
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      sessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'session_info_update' ||
      !validated.payload
    ) {
      return
    }
    const title = asString(validated.payload.title)?.trim()
    if (title && title.length <= 120) {
      input.observeNativeTitle?.(sessionId, title)
    }
  }

  private hasOtherActiveRunOnSession(activeRun: ActiveAgyRun): boolean {
    for (const other of this.activeRuns.values()) {
      if (
        other !== activeRun &&
        other.nativeSessionId === activeRun.nativeSessionId &&
        !other.rootTerminal
      ) {
        return true
      }
    }
    return false
  }

  private evidenceKey(runId: string, nativeSessionId: string): string {
    return `${runId}\0${nativeSessionId}`
  }

  private toEvidenceIdentity(
    input: Pick<
      NativeEvidenceIdentity,
      | 'sessionId'
      | 'agentId'
      | 'runId'
      | 'requestId'
      | 'nativeSessionId'
      | 'nativeTurnId'
      | 'bindingGeneration'
      | 'executorId'
    >,
  ): NativeEvidenceIdentity {
    return {
      sessionId: input.sessionId,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId } : {}),
      requestId: input.requestId,
      nativeSessionId: input.nativeSessionId,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      bindingGeneration: input.bindingGeneration,
      ...(input.executorId ? { executorId: input.executorId } : {}),
    }
  }

  private invalidateNonTerminalEvidence(runId: string, nativeSessionId: string | undefined): void {
    if (!nativeSessionId) return
    const key = this.evidenceKey(runId, nativeSessionId)
    const existing = this.nativeEvidence.get(key)
    if (!existing || existing.kind === 'ended') return
    this.nativeEvidence.delete(key)
    this.resizeEvidenceCacheWork()
  }

  private resizeEvidenceCacheWork(): void {
    let totalBytes = 0
    for (const item of this.nativeEvidence.values()) {
      totalBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') * 2 + 256
    }
    this.evidenceCacheWork.resize(totalBytes)
  }

  private recordEvidence(
    input: AgentRunInput,
    nativeSessionId: string,
    executorId: string,
    fact:
      | { kind: 'running' | 'waiting_user'; source: 'live_runtime' }
      | {
          kind: 'ended'
          source: 'live_terminal'
          outcome: 'completed' | 'failed' | 'interrupted'
          output?: Extract<NativeProbeResult, { kind: 'ended' }>['output']
        }
      | { kind: 'no_evidence'; reason: string },
    nativeTurnId = input.runId,
  ): void {
    const identity: NativeEvidenceIdentity = {
      sessionId: input.sessionId,
      agentId: 'agy',
      runId: input.runId,
      requestId: input.runId,
      nativeSessionId,
      nativeTurnId,
      bindingGeneration: input.bindingGeneration ?? 1,
      executorId,
    }
    const probeResult: NativeProbeResult =
      fact.kind === 'ended'
        ? {
            kind: 'ended',
            identity,
            source: fact.source,
            outcome: fact.outcome,
            ...(fact.output ? { output: fact.output } : {}),
          }
        : fact.kind === 'no_evidence'
          ? {
              kind: 'no_evidence',
              identity,
              reason: fact.reason,
            }
          : {
              kind: fact.kind,
              identity,
              source: fact.source,
            }

    const key = this.evidenceKey(input.runId, nativeSessionId)
    this.nativeEvidence.delete(key)
    if (this.nativeEvidence.size >= AGY_EVIDENCE_CACHE_LIMIT) {
      const oldest = this.nativeEvidence.keys().next().value
      if (oldest !== undefined) this.nativeEvidence.delete(oldest)
    }
    this.nativeEvidence.set(key, probeResult)
    this.resizeEvidenceCacheWork()
    input.recordNativeEvidence?.(probeResult)
  }

  private rememberRebuildReceipt(
    rebuildId: string,
    receipt: {
      nativeSessionId: string
      sourceHash?: string | undefined
      seedHash: string
      cwd: string
      executorId: string
      initializationWitness?: NativeInitializationWitness | undefined
    },
  ): void {
    this.nativeRebuildReceipts.delete(rebuildId)
    if (this.nativeRebuildReceipts.size >= AGY_REBUILD_RECEIPT_LIMIT) {
      const oldest = this.nativeRebuildReceipts.keys().next().value
      if (oldest !== undefined) this.nativeRebuildReceipts.delete(oldest)
    }
    this.nativeRebuildReceipts.set(rebuildId, receipt)
  }
}
