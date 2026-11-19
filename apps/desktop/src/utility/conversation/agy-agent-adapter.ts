import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  agentPromptImageGroups,
  type AgentAdapter,
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
  collaborationSourceNativeReadSchema,
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
  AgyAcpConnection,
  AgyAcpConnectionPool,
  createAgyRootFrameNotWrittenProof,
  type AgyPoolLease,
  type AgyProcessFactory,
  type AgyServerRequestOwnerHandle,
  type AgySessionNotificationStream,
} from './agy-acp-connection'
import { resolveAgyAppDataDir } from './agy-native-storage'
import { mergeWorkflowInput, mergeWorkflowReview } from './collaboration-answer'
import {
  collaborationInputResultAllowed,
  collaborationInputResultDescription,
  collaborationInputResultReceiptText,
  collaborationInstructions,
  collaborationPlanRetentionReceiptText,
  collaborationReadOnly,
  collaborationReviewMode,
  collaborationSourceToolDescription,
  frozenSourceInstructions,
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
const AGY_MAX_REASONING_ITEMS = 64
const AGY_MAX_REASONING_BYTES = 2 * 1024 * 1024
const AGY_MAX_STEERING_INPUTS = 63
const AGY_SESSION_MODE_CACHE_LIMIT = 64
const AGY_EVIDENCE_CACHE_LIMIT = 8
const AGY_REBUILD_RECEIPT_LIMIT = 8
const AGY_MCP_REQUEST_BYTES = 64 * 1024
const AGY_MCP_MAX_CONCURRENT_REQUESTS = 4
const AGY_MCP_REQUEST_TIMEOUT_MS = 10_000
const AGY_PHYSICAL_SETTLEMENT_GRACE_MS = 1_500
const AGY_PROGRESS_TOKEN_PATTERN = /^([A-Za-z0-9_.:-]{1,256}):(\d{1,9})$/u

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

/**
 * Clean typed seam between `AgyAgentAdapter` (Modules 3, 4 & 6) and `@agy-storage` (Modules 7 & 8)
 * so cold SQLite/Protobuf inspection, zero-Turn Rebuild seeding, and cut-point Fork plug in cleanly.
 */
export interface AgyNativeStorageClient {
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

interface AgyToolState {
  toolCallId: string
  name: string
  title: string
  status: string
  progressToken?: string | undefined
  detail?: string | undefined
  args?: Record<string, unknown> | undefined
  rawInput?: Record<string, unknown> | undefined
  rawOutput?: unknown
  content?: unknown[] | undefined
  locations?: unknown[] | undefined
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
  readonly stagedPreBindNotifications: object[]
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
  physicalCompletion: Promise<'reply' | 'not_sent' | 'connection_closed'>,
  timeoutMs = AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
): Promise<'reply' | 'not_sent' | 'connection_closed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      physicalCompletion,
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
const AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS = 50

function estimateJsonPayloadBytes(value: unknown, maxBytes = AGY_MAX_TOOL_STATE_BYTES): number {
  let total = 0
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
  const visit = (node: unknown, depth: number): void => {
    if (node === undefined || node === null) return
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
      charge(32)
      for (const item of node) visit(item, depth + 1)
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

function findRejectOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    const kind = asString(option.kind)
    if (
      optionId &&
      optionId.length <= 80 &&
      (kind === 'reject_once' || optionId === 'deny' || optionId === 'reject_once')
    ) {
      return optionId
    }
  }
  return undefined
}

function findAllowOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    const kind = asString(option.kind)
    if (!optionId || optionId.length > 80) continue
    // NEVER auto-select or expose `allow_always` as session-scoped because Antigravity persists it globally.
    if (kind === 'allow_always' || optionId === 'allow_always') continue
    if (kind === 'allow_once' || optionId === 'allow' || optionId === 'allow_once') {
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

async function readBoundedMarkdownArtifact(filePath: string, signal: AbortSignal): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size <= 0n ||
      info.size > BigInt(COLLABORATION_PUBLISHED_PLAN_MAX_BYTES)
    ) {
      throw new Error('Brain plan artifact is missing or exceeds the published plan limit.')
    }
    const bytes = await handle.readFile({ signal })
    if (bytes.byteLength > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
      throw new Error('Brain plan artifact exceeds the published plan limit.')
    }
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

interface StagedMcpCallOutcome {
  progressToken: string
  kind:
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
    | { type: 'publish_plan'; markdown: string }
}

interface AgyMcpServerConfig {
  runId: string
  getNativeSessionId: () => string | undefined
  getExecutorId: () => string
  getRootStepIdx: () => number | undefined
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
  onStagedOutcome: (outcome: StagedMcpCallOutcome) => void
}

/**
 * Per-Run loopback Streamable HTTP MCP server enforcing Antigravity's four-tuple root verification:
 * 1. `_meta['antigravity.google/root_conversation_id'] === activeRoot.nativeSessionId` AND
 *    `_meta['antigravity.google/conversation_id'] === activeRoot.nativeSessionId`
 * 2. Valid `_meta.progressToken` correlated with bound root `tool_call` tokens or structured root trajectory steps
 * 3. Active `(executorId, bindingGeneration, runId)` after root prompt start and before root settlement
 * 4. Exact `progressToken` or `toolCallId` root `tool_call` completion in `session/update` before promoting state.
 */
class AgyRunMcpServer {
  readonly serverName = `pact_peer_${randomUUID().replaceAll('-', '')}`
  private readonly token = randomUUID().replaceAll('-', '')
  private http: HttpServer | undefined
  private activeRequests = 0
  private activeSourceReads = 0
  private peerRecorded = false
  private titleStaged = false
  private readonly openPlanChunks: Buffer[] = []
  private openPlanBytes = 0
  private openPlanCompleted: string | undefined
  private readonly boundToolCallTokens = new Set<string>()
  private pinnedTrajectoryId: string | undefined
  readonly allowedToolNames = new Set<string>()

  constructor(private readonly config: AgyMcpServerConfig) {
    if (config.sourceReader || config.legacySourceReader) {
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
    if (collaborationOpenPlanPublishAllowed(config.workflow, config.authorization)) {
      this.allowedToolNames.add('publish_plan')
    }
  }

  get hasTools(): boolean {
    return this.allowedToolNames.size > 0
  }

  pinRootTrajectoryId(trajectoryId: string): void {
    if (!trajectoryId || trajectoryId.length > 256) return
    if (this.pinnedTrajectoryId === undefined) {
      this.pinnedTrajectoryId = trajectoryId
    }
  }

  bindToolCallToken(token: string): void {
    if (!token || token.length > 512) return
    if (this.boundToolCallTokens.size >= 256 && !this.boundToolCallTokens.has(token)) {
      const oldest = this.boundToolCallTokens.values().next().value
      if (oldest !== undefined) this.boundToolCallTokens.delete(oldest)
    }
    this.boundToolCallTokens.add(token)
    const structured = AGY_PROGRESS_TOKEN_PATTERN.exec(token)
    if (structured?.[1]) {
      this.pinRootTrajectoryId(structured[1])
    }
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

  async close(): Promise<void> {
    const server = this.http
    this.http = undefined
    if (!server) return
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
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
      let rpc: McpJsonRpcRequest
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
        response.writeHead(202).end()
        settle()
        return
      }
      try {
        const result = this.dispatchRpc(rpc)
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
    })
  }

  private replyJson(response: ServerResponse, body: object): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.byteLength),
      })
      .end(payload)
  }

  private dispatchRpc(rpc: McpJsonRpcRequest): object {
    if (rpc.method === 'initialize') {
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: '1.0.0' },
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

  private describeTools(): object[] {
    const tools: object[] = []
    if (this.allowedToolNames.has('read_collaboration_source')) {
      tools.push({
        name: 'read_collaboration_source',
        description: collaborationSourceToolDescription,
        inputSchema: { type: 'object', additionalProperties: true },
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
      const targetEnum = this.config.peerTargetAgentId
        ? [this.config.peerTargetAgentId]
        : ['claude', 'codex']
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
          'Submit this root independent review conclusion after its complete natural-language report.',
        inputSchema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: ['accepted', 'changes_requested', 'needs_user', 'incomplete'],
            },
            questions: { type: 'array' },
          },
          required: ['verdict'],
          additionalProperties: false,
        },
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

  private verifyFourTupleRoot(
    toolName: string,
    meta: unknown,
  ): { ok: true; nativeSessionId: string; progressToken: string } | { ok: false; error: string } {
    const expectedSessionId = this.config.getNativeSessionId()
    const executorId = this.config.getExecutorId()
    const current =
      toolName === 'read_collaboration_source'
        ? this.config.isSourceCurrent()
        : this.config.isRootCurrent()
    if (
      !current ||
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
    const agyConvId = asString(meta['antigravity.google/conversation_id'])
    const legacyConvId = asString(meta.conversation_id)
    if (!rootConvId || rootConvId !== expectedSessionId) {
      return {
        ok: false,
        error: 'The MCP call root_conversation_id does not match the active Antigravity session.',
      }
    }
    if (
      !agyConvId ||
      agyConvId !== expectedSessionId ||
      (legacyConvId !== undefined && legacyConvId !== expectedSessionId)
    ) {
      return {
        ok: false,
        error: 'Delegated subagent conversations cannot invoke root-scoped Pact tools.',
      }
    }
    const rawProgressToken = meta.progressToken
    const normalizedToken =
      typeof rawProgressToken === 'string' &&
      rawProgressToken.length > 0 &&
      rawProgressToken.length <= 512
        ? rawProgressToken
        : typeof rawProgressToken === 'number' && Number.isSafeInteger(rawProgressToken)
          ? String(rawProgressToken)
          : undefined
    if (!normalizedToken) {
      return {
        ok: false,
        error: 'Missing or invalid Antigravity MCP progressToken.',
      }
    }
    if (!this.boundToolCallTokens.has(normalizedToken)) {
      const structured = AGY_PROGRESS_TOKEN_PATTERN.exec(normalizedToken)
      if (!structured) {
        return {
          ok: false,
          error:
            'Antigravity MCP progressToken must match an active root tool call or structured <trajectoryId>:<stepIdx> token.',
        }
      }
      const trajectoryId = structured[1]!
      const stepIdx = Number(structured[2]!)
      const minStepIdx = this.config.getRootStepIdx() ?? 0
      if (!Number.isSafeInteger(stepIdx) || stepIdx < minStepIdx) {
        return {
          ok: false,
          error: 'Antigravity MCP progressToken precedes the active root Turn step boundary.',
        }
      }
      if (this.pinnedTrajectoryId === undefined || trajectoryId !== this.pinnedTrajectoryId) {
        return {
          ok: false,
          error:
            'Antigravity MCP progressToken does not match an ACP-authenticated root trajectory.',
        }
      }
    }
    return { ok: true, nativeSessionId: expectedSessionId, progressToken: normalizedToken }
  }

  private callTool(params: unknown): object {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      return this.toolError('Invalid MCP tool call parameters.')
    }
    const toolName = params.name
    if (!this.allowedToolNames.has(toolName)) {
      return this.toolError(`Tool ${toolName} is not authorized for this turn.`)
    }
    const auth = this.verifyFourTupleRoot(toolName, Reflect.get(params, '_meta'))
    if (!auth.ok) {
      return this.toolError(auth.error)
    }
    const rawArgs = params.arguments ?? {}

    if (toolName === 'read_collaboration_source') {
      if (!this.config.sourceGrant) {
        return this.toolError('No source capability is bound to this root.')
      }
      if (this.activeSourceReads >= 2) {
        return this.toolError('Concurrent source reads exceeded the per-root limit.')
      }
      this.activeSourceReads += 1
      try {
        const nativeReq = collaborationSourceNativeReadSchema.safeParse(rawArgs)
        const page =
          nativeReq.success && this.config.sourceReader
            ? readNativeFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                this.config.sourceReader,
                { threadId: auth.nativeSessionId, turnId: this.config.runId },
              )
            : readFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                this.config.sourceReader,
                this.config.legacySourceReader,
              )
        const serialized = JSON.stringify(page)
        if (Buffer.byteLength(serialized, 'utf8') > COLLABORATION_PAGE_BYTES * 2) {
          return this.toolError('Source page exceeded its bounded transport size.')
        }
        return { content: [{ type: 'text', text: serialized }] }
      } catch (error) {
        const message =
          error instanceof NativeSourceReadFailure || error instanceof Error
            ? error.message
            : 'Source read failed.'
        return this.toolError(safeNativePermissionText(message, 512))
      } finally {
        this.activeSourceReads = Math.max(0, this.activeSourceReads - 1)
      }
    }

    if (toolName === 'publish_session_title') {
      if (this.titleStaged) {
        return this.toolError('A session title was already submitted in this turn.')
      }
      const parsed = sessionTitleInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return this.toolError('Invalid Session title.')
      }
      this.titleStaged = true
      this.config.onStagedOutcome({
        progressToken: auth.progressToken,
        kind: { type: 'title', title: parsed.data.title },
      })
      return {
        content: [{ type: 'text', text: 'Title validated. Continue your substantive answer.' }],
      }
    }

    if (toolName === 'request_peer_assistance') {
      if (this.peerRecorded) {
        return this.toolError('This answer already has a peer request.')
      }
      const parsed = peerRequestToolInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return this.toolError('Peer request arguments are invalid.')
      }
      const target = parsed.data.target
      if (target === 'agy') {
        return this.toolError('An Agent can only request the other Pact Agent.')
      }
      if (this.config.peerTargetAgentId && target !== this.config.peerTargetAgentId) {
        return this.toolError('An Agent can only request the active peer Agent in this session.')
      }
      this.peerRecorded = true
      this.config.onStagedOutcome({
        progressToken: auth.progressToken,
        kind: {
          type: 'peer',
          targetAgentId: target,
          proposalKind: parsed.data.kind,
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        },
      })
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
        return this.toolError('This turn is not authorized to submit a review verdict.')
      }
      const parsed = collaborationReviewInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return this.toolError('Invalid review verdict payload.')
      }
      this.config.onStagedOutcome({
        progressToken: auth.progressToken,
        kind: { type: 'review', observation: parsed.data },
      })
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
        return this.toolError('This root is not authorized to submit that input result.')
      }
      this.config.onStagedOutcome({
        progressToken: auth.progressToken,
        kind: { type: 'input_result', observation: parsed.data },
      })
      return { content: [{ type: 'text', text: collaborationInputResultReceiptText }] }
    }

    if (toolName === 'retain_current_plan') {
      if (
        !this.config.isPlanRetentionCurrent() ||
        !collaborationPlanRetentionInputSchema.safeParse(rawArgs).success
      ) {
        return this.toolError(
          'Plan retention is unavailable because the plan was modified or retention arguments were invalid.',
        )
      }
      this.config.onStagedOutcome({
        progressToken: auth.progressToken,
        kind: { type: 'retain_plan' },
      })
      return { content: [{ type: 'text', text: collaborationPlanRetentionReceiptText }] }
    }

    if (toolName === 'publish_plan') {
      if (this.openPlanCompleted !== undefined) {
        return this.toolError('A published Plan has already been finalized in this root turn.')
      }
      const parsed = collaborationPublishPlanInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return this.toolError('Invalid publish_plan payload.')
      }
      const chunkBytes = Buffer.from(parsed.data.text, 'utf8')
      if (chunkBytes.byteLength > COLLABORATION_PLAN_CHUNK_BYTES) {
        return this.toolError('Plan chunk exceeds 48 KiB UTF-8 limit.')
      }
      const expectedOffset = this.openPlanBytes
      const offset = parsed.data.offset ?? 0
      if (offset !== expectedOffset) {
        return this.toolError(`Expected byte offset ${expectedOffset}, received ${offset}.`)
      }
      if (this.openPlanBytes + chunkBytes.byteLength > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
        return this.toolError('Published Plan exceeds maximum byte capacity.')
      }
      this.openPlanChunks.push(chunkBytes)
      this.openPlanBytes += chunkBytes.byteLength
      const complete = parsed.data.complete ?? parsed.data.offset === undefined
      if (complete) {
        const markdown = Buffer.concat(this.openPlanChunks, this.openPlanBytes).toString('utf8')
        if (!markdown.trim()) {
          return this.toolError('Published Plan Markdown cannot be empty.')
        }
        this.openPlanCompleted = markdown
        this.config.onStagedOutcome({
          progressToken: auth.progressToken,
          kind: { type: 'publish_plan', markdown },
        })
      }
      return {
        content: [
          {
            type: 'text',
            text: complete
              ? 'Updated Plan staged. Pact will publish it once this root turn completes.'
              : `Accepted Plan chunk (${this.openPlanBytes} bytes).`,
          },
        ],
      }
    }

    return this.toolError('Unsupported Pact MCP tool.')
  }

  private toolError(message: string): object {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    }
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
  private skillCatalogListener: (() => void) | undefined
  private nextTurnEpoch = 1
  private disposed = false

  constructor(private readonly options: AgyAgentAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? 'agy'
    this.primaryAppDataDir = options.appDataDir
      ? resolvePath(options.appDataDir)
      : options.relativeAppDataDir
        ? resolvePath(join(homedir(), '.gemini', options.relativeAppDataDir))
        : resolveAgyAppDataDir(process.env)
    const fallbackDir = resolvePath(join(homedir(), '.gemini', 'antigravity'))
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

  retireFullAccess(options: { sessionId?: string; cwd?: string } = {}): Promise<void> {
    return this.pool.retireFullAccess(options)
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.skillCatalogListener = listener
  }

  async discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    return discoverAgySkills(cwd, this.executablePath, signal, this.options.skillDiscoveryOptions)
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
    let unresolvedBrainPlanWrite = false
    let latestBrainPlanCandidate: { nativeId: string; text: string } | undefined
    let brainPlanCaptureFailed = false

    const stagedMcpOutcomes = new Map<string, StagedMcpCallOutcome['kind']>()
    let sourceRetired = false
    const retireSourceReader = (): void => {
      if (sourceRetired) return
      sourceRetired = true
      input.collaborationSourceReader?.retire()
    }

    let resolvedSessionId: string | undefined = input.nativeSessionId
    let activeExecutorId = this.pool.executorId
    let rootFirstByteWritten = false
    let promptEnteredTransport = false
    let rootConfirmedNotSent = false
    let promptReplyReceived = false
    let userCancelRequested = false
    let rootTerminal = false
    let rootReleasing = false
    let foregroundReleased = false

    const mcpServer = new AgyRunMcpServer({
      runId: input.runId,
      getNativeSessionId: () => resolvedSessionId,
      getExecutorId: () => activeExecutorId,
      getRootStepIdx: () => activeRun?.rootStepIdx,
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
      isPlanRetentionCurrent: () => !brainPlanTouched && !unresolvedBrainPlanWrite,
      onStagedOutcome: ({ progressToken, kind }) => {
        if (stagedMcpOutcomes.size < 64) {
          stagedMcpOutcomes.set(progressToken, kind)
        }
      },
    })

    let lease: AgyPoolLease | undefined
    let sessionStream: AgySessionNotificationStream | undefined
    let promptMemoryReservation: NativeMemoryReservation | undefined
    let toolStateMemoryReservation: NativeMemoryReservation | undefined
    let serverRequestOwner: AgyServerRequestOwnerHandle | undefined
    let unsubscribeBackground: (() => void) | undefined
    let activeRun: ActiveAgyRun | undefined
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined
    const promptRpcAbort = new AbortController()
    const observation = new AbortController()
    const interactionControllers = new Set<AbortController>()
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

    try {
      // Re-verify explicit /skill selections before acquiring or dispatching to native process.
      if (input.promptEnvelope.skillInvocation) {
        const hasAgySkill = input.promptEnvelope.skillInvocation.bindings.some(
          (b) => b.agentId === 'agy',
        )
        if (hasAgySkill) {
          const catalog = await this.discoverSkills(input.cwd, signal)
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
        signal,
      })
      const connection = lease.connection
      activeExecutorId = connection.executorId
      input.recordExecutor?.(activeExecutorId)

      await lease.ensureInitialized(signal)

      // Event queue fed by server-request interactions (approval / question) and session updates.
      // Registered BEFORE `session/new` / `session/load` on the shared `AgyAcpConnection` owner registry
      // so init-phase forms/elicitation reach the exact owner without cross-session interference.
      const pendingEvents: NormalizedAgentEvent[] = []
      let wakeEventLoop: (() => void) | undefined
      const notifyEventLoop = (): void => {
        const wake = wakeEventLoop
        wakeEventLoop = undefined
        wake?.()
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

      serverRequestOwner = connection.registerServerRequestOwner({
        ownerId: `run:${input.runId}`,
        knownSessionId: resolvedSessionId,
        handler: (message) => {
          const method = asString(Reflect.get(message, 'method'))
          const rpcId = Reflect.get(message, 'id')
          if (
            (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
            !method ||
            (method !== 'session/request_permission' && method !== 'elicitation/create')
          ) {
            return false
          }
          const rawParams = Reflect.get(message, 'params')
          const params = isPlainObject(rawParams) ? rawParams : {}

          // Only count as model Turn acceptance AFTER the root prompt has actually dispatched!
          if (activeRun && rootFirstByteWritten && !activeRun.turnAccepted && !rootTerminal) {
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
            pendingEvents.push({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
            notifyEventLoop()
          }

          if (method === 'session/request_permission') {
            void this.handlePermissionRequest({
              connection,
              rpcId,
              params,
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
              pushEvent: (ev) => {
                pendingEvents.push(ev)
                notifyEventLoop()
              },
              signal,
            })
            return true
          }

          void this.handleElicitationRequest({
            connection,
            rpcId,
            params,
            input,
            activeRun,
            askOnlyStage,
            readOnlyNonInteractive:
              readOnlyStage &&
              !planModeStage &&
              (authorization?.stage ?? workflow?.stage) !== 'reply',
            permissionWait,
            interactionControllers,
            pushEvent: (ev) => {
              pendingEvents.push(ev)
              notifyEventLoop()
            },
            signal,
          })
          return true
        },
      })

      // Establish or load the ACP session, concurrently draining replay notifications and yielding
      // any init-phase interaction events so neither transport queues nor elicitation waits block.
      let replayingHistory = false
      let descriptor: AcpSessionDescriptor
      if (input.nativeSessionId) {
        resolvedSessionId = input.nativeSessionId
        replayingHistory = true
        sessionStream = connection.openSessionStream(input.nativeSessionId)
        let replayConfigOptions: AcpConfigOptionEntry[] | undefined
        const loadReq = connection.request(
          'session/load',
          {
            sessionId: input.nativeSessionId,
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
          },
          { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
        )
        const loadResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: loadReq,
          stream: sessionStream,
          pendingEvents,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: (replayed) => {
            this.observeSessionTitleFromNotification(replayed, input.nativeSessionId!, input)
            const notifiedOptions = this.extractConfigOptionsFromNotification(replayed)
            if (notifiedOptions) replayConfigOptions = notifiedOptions
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
          { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
        )
        const newResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: newReq,
          stream: undefined,
          pendingEvents,
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
        serverRequestOwner.updateSessionId(resolvedSessionId)
        sessionStream = connection.openSessionStream(resolvedSessionId)
        // Drain any initial metadata updates (`available_commands_update` / `config_option_update`).
        while (true) {
          const initialNote = sessionStream.shift()
          if (!initialNote) break
          this.observeSessionTitleFromNotification(initialNote, resolvedSessionId, input)
          const notifiedOptions = this.extractConfigOptionsFromNotification(initialNote)
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
        readOnlyStage,
        permissionMode: effectivePermissionMode,
        signal,
      })

      // Confirm applied model & thought_level via `session/set_config_option` (keeping speed: 'native').
      const appliedModelAndEffort = await this.configureModelAndEffortBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionStream,
        onMetadataNotification: (note) => {
          this.observeSessionTitleFromNotification(note, resolvedSessionId!, input)
        },
        requestedModel: input.model,
        requestedEffort: input.effort,
        signal,
      })

      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!
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
      const sourceForm: AgentSourceReadForm = input.collaborationSourceReader
        ? 'sourceReference'
        : 'legacy'
      const navigate = input.collaborationSourceReader
        ? (target: Parameters<AgentCollaborationSourceReader['navigation']>[0]) =>
            input.collaborationSourceReader!.navigation(target, sourceForm)
        : undefined
      const navigateCutoff = cutoffSourceNavigator(input.collaborationSourceReader, sourceForm)

      for (const group of agentPromptImageGroups(currentEnvelope)) {
        images.push(...group.images)
      }
      promptMemoryReservation = connection.reserveWorkingMemory(
        64 * 1024 + nativeImagePreparationBytes(images),
      )
      toolStateMemoryReservation = connection.reserveWorkingMemory(0)
      const promptBlocks = await agyPromptInput(currentEnvelope, signal, navigate, navigateCutoff, {
        pactRunId: input.runId,
      })

      const systemAppendParts: string[] = []
      if (workflow) {
        systemAppendParts.push(collaborationInstructions(workflow, authorization))
        if (planModeStage) {
          systemAppendParts.push(AGY_PLAN_SUBMISSION_INSTRUCTIONS)
        }
      } else {
        if (mcpServer.allowedToolNames.has('request_peer_assistance')) {
          systemAppendParts.push(PEER_ASSISTANCE_INSTRUCTIONS)
        }
        if (mcpServer.allowedToolNames.has('read_collaboration_source')) {
          systemAppendParts.push(frozenSourceInstructions)
        }
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

      // Post-turn background listener for attributable, deduplicable out-of-turn completion updates.
      const seenForegroundMessageIds = new Set<string>()
      const reportedBackgroundMessageIds = new Set<string>()
      let observedBackgroundTask = false

      unsubscribeBackground = connection.subscribeBackground((message) => {
        if (
          !rootTerminal ||
          replayingHistory ||
          asString(Reflect.get(message, 'method')) !== 'session/update'
        ) {
          return false
        }
        const params = Reflect.get(message, 'params')
        if (!isPlainObject(params)) return false
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== resolvedSessionId) return false
        // If a newer foreground Run has taken over this nativeSessionId, yield to that Run.
        for (const other of this.activeRuns.values()) {
          if (
            other !== activeRun &&
            other.nativeSessionId === resolvedSessionId &&
            !other.rootTerminal
          ) {
            return false
          }
        }
        const update = params.update
        if (!isPlainObject(update)) return true
        void this.handlePostTurnBackgroundUpdate({
          update,
          input,
          activeRun: activeRun!,
          observedBackgroundTask,
          canSettleEffects: () => !unknownEffectsReported,
          seenForegroundMessageIds,
          reportedBackgroundMessageIds,
        })
        return true
      })

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

      // Dispatch `session/prompt`.
      let rootWithheldByGuard = false
      const promptParams: Record<string, unknown> = {
        sessionId: resolvedSessionId,
        prompt: promptBlocks,
        ...(systemAppend
          ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } }
          : {}),
      }

      promptEnteredTransport = true
      const promptOp = connection.requestOwned('session/prompt', promptParams, {
        timeoutMs: undefined,
        signal: promptRpcAbort.signal,
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

      let promptSettled = false
      let promptResponse: object | undefined
      let promptError: Error | undefined
      void promptOp.result.then(
        (res) => {
          promptResponse = res
          promptSettled = true
          promptReplyReceived = true
          if (activeRun) {
            activeRun.promptReplyReceived = true
            const resErr = Reflect.get(res, 'error')
            const resObj = Reflect.get(res, 'result')
            if (!resErr && isPlainObject(resObj)) {
              const sr = asString(resObj.stopReason)?.trim()
              const execId = asString(resObj.executionId ?? resObj.execution_id)
              if (
                sr &&
                VALID_ACP_STOP_REASONS.has(sr) &&
                execId &&
                !activeRun.providerExecutionId
              ) {
                this.bindRootExecutionId(activeRun, input, execId)
              }
            }
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (cancelGraceTimer !== undefined) {
            clearTimeout(cancelGraceTimer)
            cancelGraceTimer = undefined
          }
          notifyEventLoop()
          return undefined
        },
        (err: unknown) => {
          promptError = err instanceof Error ? err : new Error(String(err))
          promptSettled = true
          promptReplyReceived = true
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (cancelGraceTimer !== undefined) {
            clearTimeout(cancelGraceTimer)
            cancelGraceTimer = undefined
          }
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

      type StreamNextOutcome = { kind: 'note' } | { kind: 'error'; error: Error }
      let pendingNextNote: Promise<StreamNextOutcome> | undefined
      const waiterNotes: object[] = []
      let waiterError: Error | undefined

      const projectNote = (notification: object): Generator<NormalizedAgentEvent> =>
        this.projectSessionNotification({
          notification,
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
          setUnresolvedBrainPlanWrite: (v) => {
            unresolvedBrainPlanWrite = v
          },
          onBrainPlanCaptured: (candidate) => {
            latestBrainPlanCandidate = candidate
            brainPlanCaptureFailed = false
            input.recordWorkflowPlan?.(candidate)
          },
          onBrainPlanCaptureFailed: () => {
            brainPlanCaptureFailed = true
            latestBrainPlanCandidate = undefined
            input.recordWorkflowPlanUnavailable?.()
          },
          stagedMcpOutcomes,
          onReviewAccepted: (obs) => {
            reviewResult = mergeWorkflowReview(reviewResult, obs)
            input.recordWorkflowReview?.(reviewResult)
          },
          onInputResultAccepted: (obs) => {
            inputResult = mergeWorkflowInput(inputResult, obs)
            input.recordWorkflowInputResult?.(inputResult)
          },
          onPlanRetainedAccepted: () => {
            if (!brainPlanTouched && !unresolvedBrainPlanWrite) {
              planRetained = true
            }
          },
          onOpenPlanPublished: (plan) => {
            publishedOpenPlan = plan
            input.recordWorkflowPlan?.(plan)
          },
          getSessionTitleEmitted: () => sessionTitleEmitted,
          markSessionTitleEmitted: () => {
            sessionTitleEmitted = true
          },
          seenForegroundMessageIds,
          onObservedBackgroundTask: () => {
            observedBackgroundTask = true
          },
          reportUnknown,
          observeFiles,
          signal,
        })

      function* drainStagedPreBindNotes(): Generator<NormalizedAgentEvent> {
        const boundExecId = activeRun!.providerExecutionId
        if (!boundExecId || activeRun!.stagedPreBindNotifications.length === 0) return
        const queued = activeRun!.stagedPreBindNotifications.splice(0)
        for (const staged of queued) {
          const params = Reflect.get(staged, 'params')
          const update = isPlainObject(params) ? params.update : undefined
          const stagedExecId = isPlainObject(update)
            ? asString(update.executionId ?? update.execution_id)
            : undefined
          if (stagedExecId !== undefined && stagedExecId !== boundExecId) {
            continue
          }
          yield* projectNote(staged)
        }
      }

      const admitAndProjectNote = function* (
        self: AgyAgentAdapter,
        notification: object,
      ): Generator<NormalizedAgentEvent> {
        if (activeRun!.providerExecutionId && activeRun!.stagedPreBindNotifications.length > 0) {
          yield* drainStagedPreBindNotes()
        }
        const method = asString(Reflect.get(notification, 'method'))
        if (method !== 'session/update') return
        const params = Reflect.get(notification, 'params')
        const update = isPlainObject(params) ? params.update : undefined
        if (!isPlainObject(update)) return
        const sessionUpdate = asString(update.sessionUpdate)
        if (!sessionUpdate) return

        const updateMeta = Reflect.get(update, '_meta')
        const steerId =
          sessionUpdate === 'user_message_chunk'
            ? (asString(update.pactSteerInputId) ??
              (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
            : undefined
        const updateExecId = asString(update.executionId ?? update.execution_id)

        // Drop updates carrying a known foreign execution_id immediately.
        if (updateExecId && activeRun!.knownForeignExecutionIds.has(updateExecId)) {
          return
        }

        // Once root `providerExecutionId` is bound, strictly drop any update carrying a different `execution_id`!
        if (activeRun!.providerExecutionId !== undefined) {
          if (updateExecId !== undefined && updateExecId !== activeRun!.providerExecutionId) {
            return
          }
          yield* projectNote(notification)
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
          yield* projectNote(notification)
          return
        }

        // Before root `providerExecutionId` is bound:
        if (sessionUpdate === 'user_message_chunk') {
          if (steerId) {
            yield* projectNote(notification)
            return
          }
          const chunkIdentity = extractUserChunkPactIdentity(update)
          const expectedPromptContent = currentEnvelope.message.content.trim()
          const matchesRootPrompt =
            chunkIdentity.pactRunId === input.runId ||
            (chunkIdentity.pactRunId === undefined &&
              expectedPromptContent.length > 0 &&
              chunkIdentity.text !== undefined &&
              chunkIdentity.text.includes(expectedPromptContent))
          if (matchesRootPrompt) {
            activeRun!.foreignTurnActiveUntilRootBound = false
            if (updateExecId) {
              self.bindRootExecutionId(activeRun!, input, updateExecId)
              yield* drainStagedPreBindNotes()
            }
            yield* projectNote(notification)
            return
          }
          // Foreign user_message_chunk on the session!
          if (updateExecId) {
            activeRun!.knownForeignExecutionIds.add(updateExecId)
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
          yield* projectNote(notification)
          return
        }

        if (updateExecId !== undefined || activeRun!.foreignTurnActiveUntilRootBound) {
          if (activeRun!.stagedPreBindNotifications.length >= 256) {
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity emitted too many unattributed updates before binding root execution_id.',
              false,
            )
          }
          activeRun!.stagedPreBindNotifications.push(notification)
          return
        }

        yield* projectNote(notification)
      }

      try {
        while (true) {
          while (pendingEvents.length > 0) {
            yield pendingEvents.shift()!
          }
          if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
            for (const ev of drainStagedPreBindNotes()) {
              yield ev
            }
          }
          if (waiterNotes.length > 0) {
            while (waiterNotes.length > 0) {
              for (const ev of admitAndProjectNote(this, waiterNotes.shift()!)) {
                yield ev
              }
            }
            continue
          }
          if (promptSettled) {
            // Flush one microtask tick so any notification that resolved `sessionStream.next()`
            // in the same stdout chunk before `session/prompt` settled pushes into `waiterNotes`.
            // oxlint-disable-next-line no-await-in-loop -- Single microtask flush on prompt settlement.
            await Promise.resolve()
            // Drain any remaining notifications queued before `session/prompt` resolved.
            while (true) {
              const trailing = waiterNotes.shift() ?? sessionStream.shift()
              if (!trailing) break
              for (const ev of admitAndProjectNote(this, trailing)) {
                yield ev
              }
            }
            if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
              for (const ev of drainStagedPreBindNotes()) {
                yield ev
              }
            }
            while (pendingEvents.length > 0) {
              yield pendingEvents.shift()!
            }
            break
          }
          if (waiterError) {
            const err = waiterError
            waiterError = undefined
            // Silence / acceptance deadline or disconnect expired before prompt reply!
            if (!activeRun.turnAccepted && connection.isOpen) {
              void connection
                .notify('session/cancel', { sessionId: resolvedSessionId }, {})
                .catch(() => undefined)
            }
            promptRpcAbort.abort()
            promptError ??= err
            break
          }

          const acceptTimeoutMs = activeRun.turnAccepted ? undefined : AGY_PROMPT_ACCEPT_TIMEOUT_MS
          const wakeupPromise = new Promise<'wakeup'>((resolveWake) => {
            wakeEventLoop = () => resolveWake('wakeup')
          })
          if (!pendingNextNote) {
            const created = sessionStream.next(acceptTimeoutMs, promptRpcAbort.signal).then(
              (note): StreamNextOutcome => {
                waiterNotes.push(note)
                if (pendingNextNote === created) pendingNextNote = undefined
                return { kind: 'note' }
              },
              (err: unknown): StreamNextOutcome => {
                const error = err instanceof Error ? err : new Error(String(err))
                waiterError ??= error
                if (pendingNextNote === created) pendingNextNote = undefined
                return { kind: 'error', error }
              },
            )
            pendingNextNote = created
          }

          // oxlint-disable-next-line no-await-in-loop -- Turn stream processes ordered notifications one by one.
          await Promise.race([wakeupPromise, pendingNextNote])
        }

        // Fence steer dispatch BEFORE releasing the root Turn, and verify any dispatched steer receipts.
        rootReleasing = true
        activeRun.rootReleasing = true
        signal.removeEventListener('abort', onCallerAbort)
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }

        if (promptError) {
          promptRpcAbort.abort()
          const physical = await awaitPhysicalCompletionBounded(promptOp.physicalCompletion)
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

        const rpcError = promptResponse ? Reflect.get(promptResponse, 'error') : undefined
        const rpcResult = promptResponse ? Reflect.get(promptResponse, 'result') : undefined
        if (rpcError || !isPlainObject(rpcResult)) {
          reportUnknown('Antigravity returned an invalid session/prompt response.')
          throw new AgentExecutionError(
            'protocol_error',
            rpcError
              ? safeNativePermissionText(JSON.stringify(rpcError), 240)
              : 'Antigravity returned an invalid session/prompt result.',
            false,
          )
        }

        const rawStopReason = asString(rpcResult.stopReason)?.trim()
        if (!rawStopReason || !VALID_ACP_STOP_REASONS.has(rawStopReason)) {
          reportUnknown('Antigravity returned a session/prompt result without a valid stopReason.')
          throw new AgentExecutionError(
            'protocol_error',
            rawStopReason
              ? `Antigravity returned an unrecognized session/prompt stopReason "${safeNativePermissionText(rawStopReason, 80)}".`
              : 'Antigravity returned a session/prompt result without a stopReason.',
            false,
          )
        }
        const stopReason = rawStopReason

        const respExecId = asString(rpcResult.executionId ?? rpcResult.execution_id)
        if (respExecId) {
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
        activeRun.stagedPreBindNotifications.length = 0

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

        // If an incomplete brain plan write never settled, read or mark unavailable.
        if (planModeStage && latestBrainPlanCandidate === undefined && !brainPlanCaptureFailed) {
          const fallbackArtifactPath = join(
            this.primaryAppDataDir,
            'brain',
            resolvedSessionId,
            'implementation_plan.md',
          )
          if (brainPlanTouched && !unresolvedBrainPlanWrite) {
            const diskText = await readBoundedMarkdownArtifact(
              fallbackArtifactPath,
              postReplyCheckSignal,
            ).catch(() => undefined)
            if (diskText?.trim()) {
              latestBrainPlanCandidate = {
                nativeId: `${resolvedSessionId}:implementation_plan`,
                text: diskText,
              }
              input.recordWorkflowPlan?.(latestBrainPlanCandidate)
            }
          }
        }

        await recordingTail
        await input.waitForRootOutput?.()

        const finalSnapshot = answer.finalize()
        if (finalSnapshot !== undefined) {
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

        // Promote collaboration artifacts ONLY after normal root completion & settlement (`B6`).
        if (outcome === 'completed' && !unknownEffectsReported) {
          if (planModeStage) {
            if (unresolvedBrainPlanWrite || brainPlanCaptureFailed) {
              input.recordWorkflowPlanUnavailable?.()
            } else if (latestBrainPlanCandidate) {
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
                nativeId: `${resolvedSessionId}:retained`,
                sha256: planDoc.sha256,
                bytes: planDoc.bytes,
                chars: planDoc.chars,
                confirmation: 'native_root_settled_v1',
              })
            }
          } else if (publishedOpenPlan) {
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

        this.recordEvidence(
          input,
          resolvedSessionId,
          activeExecutorId,
          {
            kind: 'ended',
            source: 'live_terminal',
            outcome,
            ...(answer.text
              ? {
                  output: {
                    outputId: answer.outputId,
                    text: answer.text,
                    completeness: outcome === 'completed' ? 'complete' : 'partial',
                    ...(outcome === 'completed' && latestBrainPlanCandidate
                      ? { plan: latestBrainPlanCandidate }
                      : {}),
                    ...(outcome === 'completed' && reviewResult
                      ? { reviewVerdict: reviewResult.verdict, reviewResult }
                      : {}),
                    ...(outcome === 'completed' && inputResult
                      ? { inputOutcome: inputResult.outcome, inputResult }
                      : {}),
                  },
                }
              : {}),
          },
          activeRun.nativeTurnId,
        )

        if (
          !unknownEffectsReported &&
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
      } finally {
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
      this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      await recordingTail.catch(() => undefined)
      const confirmedZeroBytesSent =
        (!promptEnteredTransport && !rootFirstByteWritten) || rootConfirmedNotSent
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
      if (cancelGraceTimer !== undefined) {
        clearTimeout(cancelGraceTimer)
        cancelGraceTimer = undefined
      }
      promptRpcAbort.abort()
      foregroundReleased = true
      if (activeRun) {
        activeRun.foregroundReleased = true
        this.notifyRootExecutionWaiters(activeRun)
      }
      this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      promptMemoryReservation?.release()
      toolStateMemoryReservation?.release()
      for (const ctrl of interactionControllers) ctrl.abort()
      interactionControllers.clear()
      serverRequestOwner?.dispose()
      sessionStream?.close()
      if (!activeRun || activeRun.activeBackgroundTasks.size === 0) {
        unsubscribeBackground?.()
        retireSourceReader()
        observation.abort()
        if (activeRun) this.activeRuns.delete(input.runId)
        await mcpServer.close().catch(() => undefined)
        lease?.release()
      } else {
        // Keep background listener & lease until active background tasks settle or pool disposes.
        const retainedRun = activeRun
        const retainedLease = lease
        const cleanupRetained = (): void => {
          unsubscribeBackground?.()
          retireSourceReader()
          this.activeRuns.delete(input.runId)
          void mcpServer.close().catch(() => undefined)
          retainedLease?.release()
        }
        retainedRun.observation.signal.addEventListener('abort', cleanupRetained, { once: true })
      }
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
        const physical = await awaitPhysicalCompletionBounded(op.physicalCompletion)
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
        (!input.executorId || cached.identity.executorId === input.executorId)
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
        candidateSessionId = await this.allocateZeroTurnSessionShell(
          lease.connection,
          lease.canonicalCwd,
          signal,
          (allocatedId) => controlOwner?.updateSessionId(allocatedId),
        )
        await input.onNativeSessionCreated?.(candidateSessionId)
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
      await this.verifyZeroTurnSessionLoad(
        lease.connection,
        lease.canonicalCwd,
        candidateSessionId,
        signal,
        {
          expectReplaySteps: written.stepCount > 0,
          forbidToolUpdates: true,
        },
      )
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
        state: candidateSessionId ? 'unknown' : 'settled',
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
        candidateSessionId = await this.allocateZeroTurnSessionShell(
          lease.connection,
          lease.canonicalCwd,
          signal,
          (allocatedId) => controlOwner?.updateSessionId(allocatedId),
        )
        await input.onCandidate(candidateSessionId)
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
      await this.verifyZeroTurnSessionLoad(
        lease.connection,
        lease.canonicalCwd,
        candidateSessionId,
        signal,
        {
          expectReplaySteps: (witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
          forbidToolUpdates: false,
        },
      )
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
        state: candidateSessionId ? 'unknown' : 'settled',
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
      await this.verifyZeroTurnSessionLoad(
        lease.connection,
        lease.canonicalCwd,
        input.nativeSessionId,
        signal,
        {
          expectReplaySteps:
            (input.witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
          forbidToolUpdates: false,
        },
      )
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

  async dispose(shutdown?: AgentShutdownSettlement): Promise<void> {
    if (this.ownsPool && shutdown?.flushDeadlineAt !== undefined) {
      this.pool.capShutdownDeadline(shutdown.flushDeadlineAt)
    }
    if (shutdown?.foregroundSettlement) {
      const remaining = Math.max(0, shutdown.flushDeadlineAt - Date.now())
      await Promise.race([
        shutdown.foregroundSettlement,
        new Promise<void>((r) => setTimeout(r, remaining)),
      ]).catch(() => undefined)
    }
    this.disposed = true
    this.unsubscribePoolPhysicalOps()
    this.nativeChecks.cancel()
    for (const run of this.activeRuns.values()) {
      this.notifyRootExecutionWaiters(run)
      run.observation.abort()
    }
    this.activeRuns.clear()
    this.sessionModes.clear()
    this.nativeRebuildReceipts.clear()
    this.nativeEvidence.clear()
    this.evidenceCacheWork.release()
    await Promise.all([
      this.nativeChecks.join().catch(() => undefined),
      ...(this.ownsPool ? [this.pool.dispose(shutdown?.flushDeadlineAt)] : []),
    ])
  }

  private async allocateZeroTurnSessionShell(
    connection: AgyAcpConnection,
    canonicalCwd: string,
    signal: AbortSignal,
    onSessionAllocated?: (sessionId: string) => void,
  ): Promise<string> {
    const newResp = await connection.request(
      'session/new',
      { cwd: canonicalCwd, mcpServers: [] },
      { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
    )
    const newError = Reflect.get(newResp, 'error')
    const newResult = Reflect.get(newResp, 'result')
    if (newError || !isPlainObject(newResult)) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    const descriptor = parseAcpSessionDescriptor(newResult)
    onSessionAllocated?.(descriptor.sessionId)
    const closeResp = await connection.request(
      'session/close',
      { sessionId: descriptor.sessionId },
      { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
    )
    if (Reflect.get(closeResp, 'error')) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to close the zero-Turn session shell cleanly.',
        false,
      )
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

    const ownerHandle = connection.registerServerRequestOwner({
      ownerId,
      knownSessionId: currentSessionId,
      handler: (message) => {
        const method = asString(Reflect.get(message, 'method'))
        const rpcId = Reflect.get(message, 'id')
        if (
          (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
          !method ||
          (method !== 'session/request_permission' && method !== 'elicitation/create')
        ) {
          return false
        }
        const rawParams = Reflect.get(message, 'params')
        const reqParams = isPlainObject(rawParams) ? rawParams : {}

        if (method === 'session/request_permission') {
          void (async () => {
            if (permissionMode === 'full') {
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
      },
    })

    return {
      updateSessionId: (sessionId) => {
        currentSessionId = sessionId
        ownerHandle.updateSessionId(sessionId)
      },
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
    connection: AgyAcpConnection,
    canonicalCwd: string,
    sessionId: string,
    signal: AbortSignal,
    options: { expectReplaySteps?: boolean; forbidToolUpdates?: boolean } = {},
  ): Promise<void> {
    const stream = connection.openSessionStream(sessionId)
    let sawUserChunk = false
    let sawAgentChunk = false
    let sawForbiddenExecutionUpdate = false

    const observeReplayItem = (item: object): void => {
      const params = Reflect.get(item, 'params')
      const update = isPlainObject(params) ? params.update : undefined
      if (!isPlainObject(update)) return
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

    try {
      const loadReq = connection.request(
        'session/load',
        { sessionId, cwd: canonicalCwd, mcpServers: [] },
        { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
      )
      const loadResp = await this.runWithConcurrentReplayDrain(loadReq, stream, observeReplayItem)
      const loadError = Reflect.get(loadResp, 'error')
      const loadResult = Reflect.get(loadResp, 'result')
      if (loadError || !isPlainObject(loadResult)) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load verification failed.',
          false,
        )
      }
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
      const closeResp = await connection.request(
        'session/close',
        { sessionId },
        { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
      )
      if (Reflect.get(closeResp, 'error')) {
        throw new AgentExecutionError(
          'protocol_error',
          'Antigravity failed to close verified cold session.',
          false,
        )
      }
    } finally {
      stream.close()
    }
  }

  private async runWithConcurrentReplayDrain<TResult>(
    requestPromise: Promise<TResult>,
    stream: AgySessionNotificationStream,
    onNotification: (notification: object) => void,
  ): Promise<TResult> {
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: TResult } | { ok: false; error: unknown } | undefined
    } = {
      settled: false,
      outcome: undefined,
    }

    const tracked = requestPromise.then(
      (value) => {
        drainState.settled = true
        drainState.outcome = { ok: true, value }
        drainAbort.abort()
        return undefined
      },
      (error: unknown) => {
        drainState.settled = true
        drainState.outcome = { ok: false, error }
        drainAbort.abort()
        return undefined
      },
    )

    const drainBuffered = (): void => {
      while (true) {
        const item = stream.shift()
        if (!item) break
        onNotification(item)
      }
    }

    try {
      while (!drainState.settled) {
        drainBuffered()
        if (drainState.settled) break
        // oxlint-disable-next-line no-await-in-loop -- Continuous O(1) drain while `session/load` streams replay.
        const nextNote = await stream
          .next(undefined, drainAbort.signal)
          .then((note) => ({ hasNote: true as const, note }))
          .catch(() => ({ hasNote: false as const }))
        if (nextNote.hasNote) {
          onNotification(nextNote.note)
        }
        drainBuffered()
      }
      await tracked
      await Promise.resolve()
      drainBuffered()
    } finally {
      drainAbort.abort()
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
    stream: AgySessionNotificationStream | undefined
    pendingEvents: NormalizedAgentEvent[]
    setWakeup: (fn: (() => void) | undefined) => void
    onNotification: (notification: object) => void
  }): AsyncGenerator<NormalizedAgentEvent, TResult, void> {
    const { requestPromise, stream, pendingEvents, setWakeup, onNotification } = params
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: TResult } | { ok: false; error: unknown } | undefined
    } = {
      settled: false,
      outcome: undefined,
    }
    let wakeLocal: (() => void) | undefined

    const triggerWake = (): void => {
      const fn = wakeLocal
      wakeLocal = undefined
      fn?.()
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
      while (true) {
        const item = stream.shift()
        if (!item) break
        onNotification(item)
      }
    }

    let pendingStreamNext: Promise<void> | undefined
    try {
      while (!drainState.settled) {
        drainBuffered()
        while (pendingEvents.length > 0) {
          yield pendingEvents.shift()!
        }
        if (drainState.settled) break

        const wakePromise = new Promise<void>((resolveWake) => {
          wakeLocal = resolveWake
          setWakeup(() => {
            setWakeup(undefined)
            triggerWake()
          })
        })

        if (stream && !pendingStreamNext) {
          const created = stream
            .next(undefined, drainAbort.signal)
            .then((note) => {
              onNotification(note)
              if (pendingStreamNext === created) pendingStreamNext = undefined
              return undefined
            })
            .catch(() => {
              if (pendingStreamNext === created) pendingStreamNext = undefined
            })
          pendingStreamNext = created
        }

        // oxlint-disable-next-line no-await-in-loop -- Concurrent init-event yield and replay drain.
        await Promise.race(pendingStreamNext ? [wakePromise, pendingStreamNext] : [wakePromise])
      }

      await tracked
      await Promise.resolve()
      drainBuffered()
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!
      }
    } finally {
      setWakeup(undefined)
      drainAbort.abort()
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
  ): Promise<void> {
    const response = await connection.request(
      'session/set_mode',
      { sessionId, modeId },
      { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
    )
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
    readOnlyStage: boolean
    permissionMode: SessionPermissionMode
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionState,
      readOnlyStage,
      permissionMode,
      signal,
    } = params

    if (readOnlyStage) {
      if (descriptor.availableModes && !descriptor.availableModes.includes('plan')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not advertise native Plan mode required for read-only collaboration stages.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'plan', signal)
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
      await this.setAndConfirmSessionMode(connection, sessionId, 'default', signal)
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
      await this.setAndConfirmSessionMode(connection, sessionId, 'auto', signal)
      sessionState.currentModeId = 'auto'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'native' || permissionMode === 'full') {
      if (needsPlanRetirement) {
        const restoreMode = sessionState.initialNonPlanModeId || 'default'
        await this.setAndConfirmSessionMode(connection, sessionId, restoreMode, signal)
        sessionState.currentModeId = restoreMode
        sessionState.enteredPlanModeByPact = false
      }
    }
  }

  private async configureModelAndEffortBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionStream: AgySessionNotificationStream | undefined
    onMetadataNotification: (notification: object) => void
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
      requestedModel,
      requestedEffort,
      signal,
    } = params
    let configOptions = descriptor.configOptions
    let currentModelId = descriptor.currentModelId

    const drainNotifiedConfigOptions = async (): Promise<AcpConfigOptionEntry[] | undefined> => {
      if (!sessionStream) return undefined
      await Promise.resolve()
      let latest: AcpConfigOptionEntry[] | undefined
      while (true) {
        const note = sessionStream.shift()
        if (!note) break
        onMetadataNotification(note)
        const parsed = this.extractConfigOptionsFromNotification(note)
        if (parsed) latest = parsed
      }
      return latest
    }

    const findOption = (id: string): AcpConfigOptionEntry | undefined =>
      configOptions.find((entry) => entry.id === id)

    let derivedEffortFromModelVariant: string | undefined

    if (requestedModel !== null) {
      const modelOption = findOption('model')
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
            signal,
          })
        }
        currentModelId = requestedModel
      } else if (descriptor.availableModels?.includes(requestedModel)) {
        if (descriptor.currentModelId !== requestedModel) {
          // Invalidate stale `configOptions` from the prior model immediately on model change.
          configOptions = []
        }
        const setModelReq = connection.request(
          'session/set_model',
          { sessionId, modelId: requestedModel },
          { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
        )
        let notifiedDuringSetModel: AcpConfigOptionEntry[] | undefined
        const setModelResp = sessionStream
          ? await this.runWithConcurrentReplayDrain(setModelReq, sessionStream, (note) => {
              onMetadataNotification(note)
              const parsed = this.extractConfigOptionsFromNotification(note)
              if (parsed) notifiedDuringSetModel = parsed
            })
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
        const replyHasOptions = Array.isArray(Reflect.get(res, 'configOptions'))
        const replyOptions = replyHasOptions
          ? parseConfigOptions(Reflect.get(res, 'configOptions'))
          : undefined
        const trailingNotified = await drainNotifiedConfigOptions()
        let mergedUpdated = trailingNotified ?? notifiedDuringSetModel ?? replyOptions
        if (mergedUpdated === undefined && sessionStream) {
          mergedUpdated = await this.awaitPostReplyConfigOptionUpdate(
            sessionStream,
            onMetadataNotification,
            signal,
          )
        }
        if (mergedUpdated !== undefined) {
          configOptions = mergedUpdated
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

    const trailingBeforeEffort = await drainNotifiedConfigOptions()
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
    const finalThoughtOption = findOption('thought_level')
    const modelKnown =
      requestedModel !== null ||
      finalModelOption?.currentValue !== undefined ||
      currentModelId !== undefined
    const effortKnown =
      effectiveRequestedEffort !== null ||
      finalThoughtOption?.currentValue !== undefined ||
      (configOptions.length > 0 && !finalThoughtOption)
    const resolvedModel =
      requestedModel ?? finalModelOption?.currentValue ?? currentModelId ?? 'agy-default'
    const resolvedEffort =
      effectiveRequestedEffort !== null
        ? effectiveRequestedEffort
        : (finalThoughtOption?.currentValue ?? null)

    return { model: resolvedModel, effort: resolvedEffort, effortKnown: modelKnown && effortKnown }
  }

  private async awaitPostReplyConfigOptionUpdate(
    sessionStream: AgySessionNotificationStream,
    onMetadataNotification: (notification: object) => void,
    signal: AbortSignal,
    windowMs = AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
  ): Promise<AcpConfigOptionEntry[] | undefined> {
    const deadlineAt = Date.now() + windowMs
    let latest: AcpConfigOptionEntry[] | undefined
    while (true) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        onMetadataNotification(buffered)
        const parsed = this.extractConfigOptionsFromNotification(buffered)
        if (parsed) latest = parsed
      }
      if (latest !== undefined) return latest
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) return undefined
      // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
      const nextNote = await sessionStream.next(remainingMs, signal).catch(() => undefined)
      if (!nextNote) {
        signal.throwIfAborted()
        return undefined
      }
      onMetadataNotification(nextNote)
      const parsed = this.extractConfigOptionsFromNotification(nextNote)
      if (parsed) latest = parsed
    }
  }

  private async setConfigOptionAndConfirm(params: {
    connection: AgyAcpConnection
    sessionId: string
    configId: 'model' | 'thought_level'
    value: string
    sessionStream: AgySessionNotificationStream | undefined
    onMetadataNotification: (notification: object) => void
    signal: AbortSignal
  }): Promise<AcpConfigOptionEntry[]> {
    const {
      connection,
      sessionId,
      configId,
      value,
      sessionStream,
      onMetadataNotification,
      signal,
    } = params
    const requestPromise = connection.request(
      'session/set_config_option',
      { sessionId, configId, value },
      { timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS, signal },
    )
    let notifiedOptions: AcpConfigOptionEntry[] | undefined
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(requestPromise, sessionStream, (note) => {
          onMetadataNotification(note)
          const parsed = this.extractConfigOptionsFromNotification(note)
          if (parsed) notifiedOptions = parsed
        })
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
    const replyHasOptions = Array.isArray(Reflect.get(result, 'configOptions'))
    const replyOptions = replyHasOptions
      ? parseConfigOptions(Reflect.get(result, 'configOptions'))
      : undefined
    let postReplyOptions: AcpConfigOptionEntry[] | undefined
    if (notifiedOptions === undefined && replyOptions === undefined && sessionStream) {
      postReplyOptions = await this.awaitPostReplyConfigOptionUpdate(
        sessionStream,
        onMetadataNotification,
        signal,
      )
    }
    const updated = postReplyOptions ?? notifiedOptions ?? replyOptions ?? []
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
    rpcId: string | number
    params: Record<string, unknown>
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
      rpcId,
      params,
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

    // 1. Full access (`requirements.md:519`): explicitly deny ANY residual `session/request_permission`
    // BEFORE any Pact MCP tool-name auto-allow and without surfacing a user approval card!
    if (!readOnlyStage && permissionMode === 'full') {
      const rejectOnce = findRejectOnceOptionId(params.options)
      const payload = rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
        : { outcome: { outcome: 'cancelled' } }
      await connection.respond(rpcId, payload).catch(() => undefined)
      return
    }

    const toolCall = isPlainObject(params.toolCall) ? params.toolCall : {}
    const toolName = asString(toolCall.name) ?? ''
    const expectedSessionId = activeRun?.nativeSessionId ?? getSessionId()
    const rawPermMeta = Reflect.get(params, '_meta')
    const rawToolMeta = Reflect.get(toolCall, '_meta')
    const permConvId = isPlainObject(rawPermMeta)
      ? asString(rawPermMeta['antigravity.google/conversation_id'] ?? rawPermMeta.conversation_id)
      : undefined
    const permRootConvId = isPlainObject(rawPermMeta)
      ? asString(rawPermMeta['antigravity.google/root_conversation_id'])
      : undefined
    const toolConvId = isPlainObject(rawToolMeta)
      ? asString(rawToolMeta['antigravity.google/conversation_id'] ?? rawToolMeta.conversation_id)
      : undefined
    const hasForeignMeta =
      expectedSessionId !== undefined &&
      ((permConvId !== undefined && permConvId !== expectedSessionId) ||
        (permRootConvId !== undefined && permRootConvId !== expectedSessionId) ||
        (toolConvId !== undefined && toolConvId !== expectedSessionId))

    // 2. Auto-allow ONLY verified current-root Pact MCP tools matching this Run's active allowed list.
    if (
      activeRun &&
      !activeRun.rootTerminal &&
      !signal.aborted &&
      !hasForeignMeta &&
      mcpServer.isAuthorizedMcpToolCallName(toolName)
    ) {
      const rawPt =
        toolCall.progressToken ??
        (isPlainObject(rawToolMeta) ? rawToolMeta.progressToken : undefined) ??
        (isPlainObject(rawPermMeta) ? rawPermMeta.progressToken : undefined)
      if (typeof rawPt === 'string' && rawPt.length > 0) {
        mcpServer.bindToolCallToken(rawPt)
      } else if (typeof rawPt === 'number' && Number.isSafeInteger(rawPt)) {
        mcpServer.bindToolCallToken(String(rawPt))
      }
      const tcId = asString(toolCall.toolCallId ?? toolCall.id)
      if (tcId) mcpServer.bindToolCallToken(tcId)

      const allowOnce = findAllowOnceOptionId(params.options)
      if (allowOnce) {
        await connection
          .respond(rpcId, { outcome: { outcome: 'selected', optionId: allowOnce } })
          .catch(() => undefined)
        return
      }
    }

    // 3. Read-Only Ironclad Wall (`B4`): deterministically reject ALL workspace file/command/other
    // permission requests using `reject_once` / `deny` (NEVER `options[0]`!).
    if (readOnlyStage) {
      const rejectOnce = findRejectOnceOptionId(params.options)
      const payload = rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
        : { outcome: { outcome: 'cancelled' } }
      await connection.respond(rpcId, payload).catch(() => undefined)
      return
    }

    // 4. Interactive user approval (`native`, `ask`, or `auto` classifier escalation).
    if (!input.requestPermission || getActiveCount() >= NATIVE_PERMISSION_REQUESTS) {
      const rejectOnce = findRejectOnceOptionId(params.options)
      const payload = rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
        : { outcome: { outcome: 'cancelled' } }
      await connection.respond(rpcId, payload).catch(() => undefined)
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
        ? !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen
        : true)

    let card: ReturnType<typeof buildAgyPermissionCard>
    try {
      card = buildAgyPermissionCard(params, cwd)
    } catch {
      const rejectOnce = findRejectOnceOptionId(params.options)
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

    adjustActiveCount(1)
    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    pushEvent({
      agentId: 'agy',
      type: 'interaction.requested',
      turnId: input.runId,
      requestId: String(rpcId),
      category: 'approval',
    })

    try {
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
    rpcId: string | number
    params: Record<string, unknown>
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
      rpcId,
      params,
      input,
      activeRun,
      askOnlyStage,
      readOnlyNonInteractive,
      permissionWait,
      interactionControllers,
      pushEvent,
      signal,
    } = context

    if (!input.requestUserInput || askOnlyStage || readOnlyNonInteractive) {
      await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
      return
    }

    let uiRequest: NativeUserInputRequest
    try {
      uiRequest = agyElicitationRequest(params)
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
        ? !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen
        : true)

    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    pushEvent({
      agentId: 'agy',
      type: 'interaction.requested',
      turnId: input.runId,
      requestId: String(rpcId),
      category: 'question',
    })

    try {
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
    notification: object
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
    setUnresolvedBrainPlanWrite: (unresolved: boolean) => void
    onBrainPlanCaptured: (plan: { nativeId: string; text: string }) => void
    onBrainPlanCaptureFailed: () => void
    stagedMcpOutcomes: Map<string, StagedMcpCallOutcome['kind']>
    onReviewAccepted: (obs: CollaborationReviewObservation) => void
    onInputResultAccepted: (obs: CollaborationInputObservation) => void
    onPlanRetainedAccepted: () => void
    onOpenPlanPublished: (plan: { nativeId: string; text: string }) => void
    getSessionTitleEmitted: () => boolean
    markSessionTitleEmitted: () => void
    seenForegroundMessageIds: Set<string>
    onObservedBackgroundTask: () => void
    reportUnknown: (reason: string) => void
    observeFiles: (evidence: Parameters<typeof recordNativeChanges>[1]) => void
    signal: AbortSignal
  }): Generator<NormalizedAgentEvent> {
    const { notification, input, activeRun } = context
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return
    const params = Reflect.get(notification, 'params')
    if (!isPlainObject(params)) return
    const update = params.update
    if (!isPlainObject(update)) return

    const sessionUpdate = asString(update.sessionUpdate)
    if (!sessionUpdate) return

    const updateMeta = Reflect.get(update, '_meta')
    const steerId =
      sessionUpdate === 'user_message_chunk'
        ? (asString(update.pactSteerInputId) ??
          (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
        : undefined

    const updateExecId = asString(update.executionId ?? update.execution_id)
    const updateStepIdx = update.stepIdx ?? update.step_idx
    const updateTrajectoryId =
      asString(update.trajectoryId ?? update.trajectory_id) ??
      (isPlainObject(updateMeta)
        ? asString(updateMeta.trajectoryId ?? updateMeta.trajectory_id)
        : undefined)

    // Bind `rootStepIdx` and trusted root trajectory ID ONLY from verified non-steer root updates!
    if (!steerId) {
      if (
        typeof updateStepIdx === 'number' &&
        Number.isSafeInteger(updateStepIdx) &&
        activeRun.rootStepIdx === undefined
      ) {
        activeRun.rootStepIdx = updateStepIdx
      }
      if (updateTrajectoryId) {
        context.mcpServer.pinRootTrajectoryId(updateTrajectoryId)
      }
    }

    const msgIdentity = asString(update.messageId ?? update.stepId ?? update.toolCallId)
    if (msgIdentity && context.seenForegroundMessageIds.size < 4096) {
      context.seenForegroundMessageIds.add(msgIdentity)
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
          yield { agentId: 'agy', type: 'session.title.updated', title }
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
      yield { agentId: 'agy', type: 'turn.started', turnId: input.runId }
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
      yield {
        agentId: 'agy',
        type: 'reasoning.summary.delta',
        turnId: input.runId,
        activityId,
        text: delta,
      }
      return
    }

    if (sessionUpdate === 'agent_message_chunk') {
      const content = isPlainObject(update.content) ? update.content : undefined
      const text = content && content.type === 'text' ? asString(content.text) : undefined
      if (!text) return
      const itemId = `msg:${context.getMessageIndex()}`
      const delta = context.answer.append(itemId, text)
      if (delta) {
        yield {
          agentId: 'agy',
          type: 'text.delta',
          turnId: input.runId,
          outputId: context.answer.outputId,
          text: delta,
        }
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
          yield {
            agentId: 'agy',
            type: 'reasoning.summary.completed',
            turnId: input.runId,
            activityId: `${input.runId}:thought:${currentThoughtKey}`,
            text: priorThought,
          }
          context.reasoningItems.delete(currentThoughtKey)
          context.bumpThoughtIndex()
        }
      }

      const toolCallId = asString(update.toolCallId ?? update.id)
      if (!toolCallId || toolCallId.length > 1024) return
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
        state = {
          toolCallId,
          name: (asString(update.name) ?? asString(update.kind) ?? 'tool').slice(0, 120),
          title: (asString(update.title) ?? asString(update.name) ?? 'Tool').slice(0, 160),
          status: asString(update.status) ?? 'pending',
          reservedBytes: 0,
          startedEmitted: false,
          completedEmitted: false,
        }
        context.tools.set(toolCallId, state)
      } else {
        if (asString(update.name)) state.name = asString(update.name)!.slice(0, 120)
        if (asString(update.title)) state.title = asString(update.title)!.slice(0, 160)
        if (asString(update.status)) state.status = asString(update.status)!
      }

      const rawProgressToken =
        update.progressToken ?? (isPlainObject(updateMeta) ? updateMeta.progressToken : undefined)
      if (typeof rawProgressToken === 'string' && rawProgressToken.length > 0) {
        const ptBytes = Buffer.byteLength(rawProgressToken, 'utf8')
        if (ptBytes > AGY_MAX_TOOL_STATE_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity tool progressToken exceeded the 8 MiB working-memory budget.',
            false,
          )
        }
        state.progressToken = rawProgressToken
      } else if (typeof rawProgressToken === 'number' && Number.isSafeInteger(rawProgressToken)) {
        state.progressToken = String(rawProgressToken)
      }

      if (state.progressToken) {
        const structuredPt = AGY_PROGRESS_TOKEN_PATTERN.exec(state.progressToken)
        if (structuredPt?.[1]) {
          context.mcpServer.pinRootTrajectoryId(structuredPt[1])
        }
      }

      if (context.mcpServer.isAuthorizedMcpToolCallName(state.name)) {
        if (state.progressToken) context.mcpServer.bindToolCallToken(state.progressToken)
        context.mcpServer.bindToolCallToken(state.toolCallId)
      }

      if (!state.completedEmitted) {
        if (isPlainObject(update.args)) state.args = update.args
        if (isPlainObject(update.rawInput)) state.rawInput = update.rawInput
        if ('rawOutput' in update) state.rawOutput = update.rawOutput
        if (Array.isArray(update.content)) state.content = update.content
        if (Array.isArray(update.locations)) state.locations = update.locations
        const headerBytes =
          64 +
          Buffer.byteLength(state.toolCallId, 'utf8') +
          Buffer.byteLength(state.name, 'utf8') +
          Buffer.byteLength(state.title, 'utf8') +
          (state.progressToken ? Buffer.byteLength(state.progressToken, 'utf8') + 16 : 0)
        const payloadBytes =
          headerBytes +
          estimateJsonPayloadBytes(state.args) +
          estimateJsonPayloadBytes(state.rawInput) +
          estimateJsonPayloadBytes(state.rawOutput) +
          estimateJsonPayloadBytes(state.content) +
          estimateJsonPayloadBytes(state.locations)
        context.resizeToolStateBytes(state, payloadBytes)
      }

      const effectiveArgs = state.args ?? state.rawInput
      if (effectiveArgs) {
        const targetPath = asString(effectiveArgs.Path ?? effectiveArgs.path)
        const command = asString(effectiveArgs.CommandLine ?? effectiveArgs.command)
        if (targetPath) state.detail = AgentActivityDetail.projectPath(targetPath, context.cwd)
        else if (command) state.detail = AgentActivityDetail.redact(command)
      }

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
      // Strictly verify that any extracted diff path matches the authenticated `effectiveArgs.Path`!
      if (
        !state.completedEmitted &&
        context.planModeStage &&
        (state.name === 'write_file' || state.name === 'edit_file')
      ) {
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
          if (state.status !== 'completed' && state.status !== 'failed') {
            context.setUnresolvedBrainPlanWrite(true)
          } else if (state.status === 'failed') {
            context.setUnresolvedBrainPlanWrite(false)
            context.onBrainPlanCaptureFailed()
          } else if (state.status === 'completed') {
            context.setUnresolvedBrainPlanWrite(false)
            if (!argIsBrainPlan || !argPath || !hasValidArtifactMetadata(effectiveArgs)) {
              context.onBrainPlanCaptureFailed()
            } else if (diffBlocks.length > 1) {
              context.onBrainPlanCaptureFailed()
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
                state.name === 'write_file' &&
                effectiveArgs?.Append !== true &&
                typeof effectiveArgs?.Content === 'string'
              ) {
                candidateText = effectiveArgs.Content
              }
              if (
                !pathMismatch &&
                candidateText &&
                candidateText.trim().length > 0 &&
                Buffer.byteLength(candidateText, 'utf8') <= COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
              ) {
                context.onBrainPlanCaptured({
                  nativeId: `${activeRun.nativeSessionId}:${state.toolCallId}`,
                  text: candidateText,
                })
              } else {
                context.onBrainPlanCaptureFailed()
              }
            }
          }
        }
      }

      if (!state.startedEmitted) {
        state.startedEmitted = true
        yield {
          agentId: 'agy',
          type: 'tool.started',
          turnId: input.runId,
          toolCallId: state.toolCallId,
          toolName: state.name,
          title: state.title,
          ...(state.detail ? { detail: state.detail } : {}),
        }
      }

      if (!state.completedEmitted && (state.status === 'completed' || state.status === 'failed')) {
        state.completedEmitted = true

        // Promote staged Pact MCP tool outcomes ONLY by exact `progressToken` or matching `toolCallId`!
        const authorizedMcp = context.mcpServer.isAuthorizedMcpToolCallName(state.name)
        if (authorizedMcp && state.status === 'completed') {
          let staged: StagedMcpCallOutcome['kind'] | undefined
          if (state.progressToken !== undefined) {
            const candidate = context.stagedMcpOutcomes.get(state.progressToken)
            if (candidate && this.stagedOutcomeMatchesTool(candidate, authorizedMcp.tool)) {
              staged = candidate
              context.stagedMcpOutcomes.delete(state.progressToken)
            }
          } else {
            const byToolCallId = context.stagedMcpOutcomes.get(state.toolCallId)
            if (byToolCallId && this.stagedOutcomeMatchesTool(byToolCallId, authorizedMcp.tool)) {
              staged = byToolCallId
              context.stagedMcpOutcomes.delete(state.toolCallId)
            }
          }

          if (staged) {
            if (staged.type === 'title' && !context.getSessionTitleEmitted()) {
              context.markSessionTitleEmitted()
              yield {
                agentId: 'agy',
                type: 'session.title.updated',
                title: staged.title,
              }
            } else if (staged.type === 'peer') {
              yield {
                agentId: 'agy',
                type: 'peer.assistance.requested',
                turnId: input.runId,
                proposalId: randomUUID(),
                targetAgentId: staged.targetAgentId,
                kind: staged.proposalKind,
                ...(staged.reason ? { reason: staged.reason } : {}),
              }
            } else if (staged.type === 'review') {
              context.onReviewAccepted(staged.observation)
            } else if (staged.type === 'input_result') {
              context.onInputResultAccepted(staged.observation)
            } else if (staged.type === 'retain_plan') {
              context.onPlanRetainedAccepted()
            } else if (staged.type === 'publish_plan') {
              context.onOpenPlanPublished({
                nativeId: `${activeRun.nativeSessionId}:${state.toolCallId}`,
                text: staged.markdown,
              })
            }
          }
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

        // Immediately release heavy tool payload fields (`args`, `rawInput`, `rawOutput`, `content`, `locations`)
        // on completion while preserving compact dedup metadata!
        state.args = undefined
        state.rawInput = undefined
        state.rawOutput = undefined
        state.content = undefined
        state.locations = undefined
        context.resizeToolStateBytes(state, 0)

        yield {
          agentId: 'agy',
          type: 'tool.completed',
          turnId: input.runId,
          toolCallId: state.toolCallId,
          toolName: state.name,
          title: state.title,
          ...(state.detail ? { detail: state.detail } : {}),
          outcome: state.status === 'completed' ? 'completed' : 'failed',
        }
      }
      return
    }

    yield {
      agentId: 'agy',
      type: 'unrecognized',
      nativeType: sessionUpdate.slice(0, 120),
      turnId: input.runId,
    }
  }

  private stagedOutcomeMatchesTool(outcome: StagedMcpCallOutcome['kind'], tool: string): boolean {
    const expectedType =
      tool === 'publish_session_title'
        ? 'title'
        : tool === 'request_peer_assistance'
          ? 'peer'
          : tool === 'submit_review'
            ? 'review'
            : tool === 'submit_input_result'
              ? 'input_result'
              : tool === 'retain_current_plan'
                ? 'retain_plan'
                : tool === 'publish_plan'
                  ? 'publish_plan'
                  : undefined
    return expectedType !== undefined && outcome.type === expectedType
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
    update: Record<string, unknown>
    input: AgentRunInput
    activeRun: ActiveAgyRun
    observedBackgroundTask: boolean
    canSettleEffects: () => boolean
    seenForegroundMessageIds: Set<string>
    reportedBackgroundMessageIds: Set<string>
  }): Promise<void> {
    const {
      update,
      input,
      activeRun,
      observedBackgroundTask,
      canSettleEffects,
      seenForegroundMessageIds,
      reportedBackgroundMessageIds,
    } = context

    const sessionUpdate = asString(update.sessionUpdate)
    const status = asString(update.status)
    const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
    const taskId =
      asString(update.taskId ?? update.backgroundTaskId) ??
      (rawOutput ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId) : undefined)
    const toolCallId = asString(update.toolCallId ?? update.id)

    try {
      if (observedBackgroundTask && input.recordBackgroundReport) {
        // Never fabricate background reports from cancel ACKs, empty chunks, or foreground messages!
        const isOutOfTurnCompletion =
          (sessionUpdate === 'agent_message_chunk' && update.outOfTurn === true) ||
          sessionUpdate === 'background_task_completed' ||
          (sessionUpdate === 'tool_call_update' &&
            status === 'completed' &&
            update.outOfTurn === true)

        if (isOutOfTurnCompletion) {
          const explicitMsgId = asString(update.messageId ?? update.stepId)
          const fallbackId =
            sessionUpdate === 'background_task_completed' ? (taskId ?? toolCallId) : toolCallId
          const nativeMessageId =
            explicitMsgId ??
            (sessionUpdate === 'background_task_completed' && fallbackId
              ? `bg-task-completed:${fallbackId}`
              : fallbackId)

          if (
            nativeMessageId &&
            nativeMessageId.length <= 512 &&
            !seenForegroundMessageIds.has(nativeMessageId) &&
            !reportedBackgroundMessageIds.has(nativeMessageId)
          ) {
            const rawText = isPlainObject(update.content)
              ? asString(update.content.text)
              : asString(update.text ?? update.summary)
            if (rawText && /\S/u.test(rawText) && reportedBackgroundMessageIds.size < 64) {
              reportedBackgroundMessageIds.add(nativeMessageId)
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
    } finally {
      // Settle tracked background task completion states and release observer/lease immediately when all settle!
      const isTerminalTaskUpdate =
        sessionUpdate === 'background_task_completed' ||
        (sessionUpdate === 'tool_call_update' &&
          (status === 'completed' || status === 'failed' || status === 'cancelled'))
      if (isTerminalTaskUpdate) {
        const settledAny = this.settleBackgroundTaskByAlias(activeRun, input, [taskId, toolCallId])
        if (settledAny && activeRun.activeBackgroundTasks.size === 0) {
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
  ): AcpConfigOptionEntry[] | undefined {
    if (asString(Reflect.get(notification, 'method')) !== 'session/update') return undefined
    const params = Reflect.get(notification, 'params')
    const update = isPlainObject(params) ? params.update : undefined
    if (!isPlainObject(update) || update.sessionUpdate !== 'config_option_update') return undefined
    const raw = update.configOptions ?? update.options
    if (!Array.isArray(raw)) return undefined
    return parseConfigOptions(raw)
  }

  private observeSessionTitleFromNotification(
    notification: object,
    sessionId: string,
    input: Pick<AgentRunInput, 'observeNativeTitle'>,
  ): void {
    if (asString(Reflect.get(notification, 'method')) !== 'session/update') return
    const params = Reflect.get(notification, 'params')
    const update = isPlainObject(params) ? params.update : undefined
    if (!isPlainObject(update) || update.sessionUpdate !== 'session_info_update') return
    const title = asString(update.title)?.trim()
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
