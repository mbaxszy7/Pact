import { createHash } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  AgentPromptImage,
  AgyNativeForkCutMetadata,
  AgyRebuildInitializationWitness,
} from '@pact/agent-runtime'
import type { NativeContextRebuildChunk } from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import { wrapOperationalStagingError } from '../agy-sqlite-image'

export const AGY_TEXT_BUDGET_BYTES = 8 * 1024 * 1024

export const AGY_MAX_HISTORY_BYTES = 32 * 1024 * 1024

export const AGY_MAX_RECORDS = 10_000

export const AGY_MAX_REBUILD_CHUNKS = 4_096

export const AGY_SUMMARIES_BUSY_TIMEOUT_MS = 2_000

export const PROTOBUF_WIRE_VARINT = 0 as const

export const PROTOBUF_WIRE_FIXED64 = 1 as const

export const PROTOBUF_WIRE_BYTES = 2 as const

export const PROTOBUF_WIRE_FIXED32 = 5 as const

export const CORTEX_STEP_TYPE_USER_INPUT = 14

export const CORTEX_STEP_TYPE_PLANNER_RESPONSE = 15

export const CORTEX_STEP_TYPE_CHECKPOINT = 23

export const CORTEX_STEP_TYPE_BROWSER_SUBAGENT = 85

export const CORTEX_STEP_TYPE_CONVERSATION_HISTORY = 98

export const CORTEX_STEP_TYPE_INVOKE_SUBAGENT = 127

export const CORTEX_STEP_TYPE_GENERIC = 132

export const CORTEX_STEP_STATUS_PENDING = 1

export const CORTEX_STEP_STATUS_RUNNING = 2

export const CORTEX_STEP_STATUS_DONE = 3

export const CORTEX_STEP_STATUS_INVALID = 4

export const CORTEX_STEP_STATUS_CLEARED = 5

export const CORTEX_STEP_STATUS_CANCELED = 6

export const CORTEX_STEP_STATUS_ERROR = 7

export const CORTEX_STEP_STATUS_GENERATING = 8

export const CORTEX_STEP_STATUS_WAITING = 9

export const CORTEX_STEP_STATUS_QUEUED = 11

export const CORTEX_STEP_STATUS_INTERRUPTED = 12

export const EXECUTOR_TERMINATION_REASON_UNSPECIFIED = 0

export const EXECUTOR_TERMINATION_REASON_ERROR = 1

export const EXECUTOR_TERMINATION_REASON_USER_CANCELED = 2

export const EXECUTOR_TERMINATION_REASON_MAX_INVOCATIONS = 3

export const EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL = 4

export const EXECUTOR_TERMINATION_REASON_MAX_FORCED_INVOCATIONS = 6

export const EXECUTOR_TERMINATION_REASON_TERMINAL_STEP_TYPE = 8

export const EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK = 9

export const EXECUTOR_TERMINATION_REASON_INJECTED_RESPONSE = 10

export const EXECUTOR_TERMINATION_REASON_MAX_TOKEN_BUDGET_EXCEEDED = 11

export const MAX_PROTOBUF_FIELD_NUMBER = (1 << 29) - 1

export const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

export const AGY_TRAJECTORY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/u

export function isValidAgyTrajectoryId(value: unknown): value is string {
  return typeof value === 'string' && AGY_TRAJECTORY_ID_PATTERN.test(value)
}

export const SAFE_ID_PATTERN = AGY_TRAJECTORY_ID_PATTERN

export const SAFE_UPLOAD_NAME_PATTERN = /^[0-9a-z_.-]{1,255}$/iu

const SAFE_SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,63}$/iu

export const KNOWN_TRAJECTORY_TABLES = new Set([
  'trajectory_meta',
  'steps',
  'gen_metadata',
  'executor_metadata',
  'parent_references',
  'battle_mode_infos',
  'trajectory_metadata_blob',
])

export const REQUIRED_TRAJECTORY_TABLES = [
  'trajectory_meta',
  'steps',
  'gen_metadata',
  'executor_metadata',
] as const

export type ProtobufWireField =
  | {
      readonly fieldNumber: number
      readonly wireType: typeof PROTOBUF_WIRE_VARINT
      readonly varint: bigint
      readonly rawBytes: Buffer
    }
  | {
      readonly fieldNumber: number
      readonly wireType: typeof PROTOBUF_WIRE_FIXED64
      readonly fixed64: Buffer
      readonly rawBytes: Buffer
    }
  | {
      readonly fieldNumber: number
      readonly wireType: typeof PROTOBUF_WIRE_BYTES
      readonly bytes: Buffer
      readonly rawBytes: Buffer
    }
  | {
      readonly fieldNumber: number
      readonly wireType: typeof PROTOBUF_WIRE_FIXED32
      readonly fixed32: Buffer
      readonly rawBytes: Buffer
    }

export interface DecodedProtobufTimestamp {
  seconds: bigint
  nanos: number
}

export interface DecodedSourceTrajectoryStepInfo {
  trajectoryId?: string
  stepIndex?: number
  metadataIndex?: number
  cascadeId?: string
}

export interface DecodedCortexToolCall {
  id?: string
  name?: string
  argumentsJson?: string
}

export interface DecodedCortexStepMetadata {
  createdAt?: DecodedProtobufTimestamp
  source?: number
  toolCall?: DecodedCortexToolCall
  modifiedToolCall?: DecodedCortexToolCall
  executionId?: string
  sourceTrajectoryStepInfo?: DecodedSourceTrajectoryStepInfo
  stepId?: string
}

export interface DecodedAgyMedia {
  mimeType?: string
  inlineData?: Buffer
  uri?: string
}

export interface DecodedCortexStepUserInput {
  userResponse: string
  itemsText: string
  text: string
  media: DecodedAgyMedia[]
  clientMessageId?: string
}

export interface DecodedCortexStepPlannerResponse {
  response: string
  thinking: string
  modifiedResponse: string
  canonicalText: string
  toolCalls: DecodedCortexToolCall[]
}

export interface DecodedAgyStep {
  type: number
  status: number
  metadata?: DecodedCortexStepMetadata
  hasError: boolean
  hasSubtrajectoryField: boolean
  hasCompaction: boolean
  userInput?: DecodedCortexStepUserInput
  plannerResponse?: DecodedCortexStepPlannerResponse
  genericArgs?: ReadonlyMap<string, string>
  genericHasError: boolean
  writeToFileUri?: string
}

export interface DecodedGenMetadata {
  executionId?: string
  stepIndices: number[]
  customMetadata: Array<{ key: string; value: string }>
  hasCompactionCheckpoint: boolean
}

export interface DecodedExecutorMetadata {
  terminationReason: number
  numGeneratorInvocations: number
  lastStepIdx?: number
  executionId?: string
  executionError?: string
}

export interface DecodedTrajectoryMetadata {
  parentConversationId?: string
  rootConversationId?: string
  hasSubagentSpec: boolean
  isBattleModeFork: boolean
  nestingDepth: number
}

export interface AgyIdentityRemap {
  sourceTrajectoryId: string
  targetTrajectoryId: string
  sourceCascadeId: string
  targetCascadeId: string
  canonicalAppDataDir: string
  configuredAppDataDir?: string
}

export interface AgyMediaCopyPlan {
  sourceUri: string
  targetUri: string
  fileName: string
  sourceFilePath: string
  targetFilePath: string
  inlineData?: Buffer
}

export type AgyRebuildSeedSpeaker = 'user' | 'claude' | 'codex' | 'agy'

export type AgyRebuildSeedChunk =
  | NativeContextRebuildChunk
  | {
      kind: 'message'
      messageId: string
      sequence: number
      speaker: AgyRebuildSeedSpeaker
      state: 'complete' | 'incomplete'
      part: number
      final: boolean
      content: string
    }
  | {
      kind: 'comment'
      messageId: string
      sequence: number
      comment: Extract<NativeContextRebuildChunk, { kind: 'comment' }>['comment']
    }
  | {
      kind: 'image'
      messageId: string
      sequence: number
      image: ConversationImage
    }

export interface AgyRebuildSeedInput {
  storageRoot?: string
  cwd: string
  nativeSessionId: string
  rebuildId: string
  sourceHash?: string
  chunks: readonly AgyRebuildSeedChunk[]
  images?: readonly AgentPromptImage[]
  stagingLeafName?: string
  signal?: AbortSignal
  deadlineAt?: number
}

export interface AgyRebuildSeedVerificationInput extends AgyRebuildSeedInput {
  expectedSeedHash?: string
  expectedTrajectoryId?: string
  expectedPbSha256?: string
  expectedPbBytes?: number
  expectedVerifiedPrefixSha256?: string
  expectedVerifiedPrefixBytes?: number
  expectedRecordCount?: number
  rejectAdditionalWork?: boolean
}

export interface AgyRebuildSeedResult {
  nativeSessionId: string
  trajectoryId: string
  seedHash: string
  chunkCount: number
  stepCount: number
  pbSha256: string
  pbBytes: number
  verifiedPrefixBytes: number
  verifiedPrefixSha256: string
  recordCount: number
  nativeStorageRoot: string
  nativePath: string
  initializationWitness?: AgyRebuildInitializationWitness
}

export interface AgyConfirmRebuildColdLoadInput {
  cwd: string
  storageRoot?: string | undefined
  appDataDir?: string | undefined
  nativeSessionId: string
  sourceHash: string
  pbSha256: string
  pbBytes: number
  stepCount: 2
  signal?: AbortSignal
  deadlineAt?: number
}

export interface AgyConsumedInputReceipt {
  stepIndex: number
  stepId?: string
  clientMessageId?: string
  pactMessageId?: string
  pactRunId?: string
  textSha256: string
}

export interface AgyColdInspectionInput {
  storageRoot?: string
  cwd: string
  nativeSessionId: string
  nativeTurnId?: string
  nativeInputIds?: readonly string[]
  includePlan?: boolean
  signal?: AbortSignal
  deadlineAt?: number
}

export interface AgyCompletedPactPublishPlanCall {
  readonly serverName: string
  readonly callId?: string
  readonly progressToken?: string
  readonly stepId?: string
}

export interface AgyColdInspectionResult {
  exists: boolean
  nativeSessionId: string
  trajectoryId?: string
  nativeStorageRoot: string
  nativePath: string
  stepCount: number
  terminalState?: {
    executionId: string
    status: 'completed' | 'failed' | 'canceled' | 'running'
    terminationReason?: number
    lastStepIdx?: number
    consumedInputStepIds: string[]
    consumedInputs: AgyConsumedInputReceipt[]
    answer: string
    responseHash: string
    plan?: { nativeId: string; text: string }
    planUnavailable?: true
    hasCompletedPactPublishPlan?: boolean
    completedPactPublishPlanTokens?: readonly string[]
    completedPactPublishPlanCalls?: readonly AgyCompletedPactPublishPlanCall[]
  }
}

export interface AgyForkOperationResult {
  nativeSessionId: string
  nativeCutId: string
  prefixHash: string
  prefixBytes: number
  prefixRecords: number
  idMap: Array<[string, string]>
  rawHash: string
  rawBytes: number
  rawRecords: number
  nativeStorageRoot: string
  nativePath: string
  initializedVerified?: boolean
  cutStep: number
  trajectoryId: string
  sourceTrajectoryId?: string
  agyCut: AgyNativeForkCutMetadata
}

export interface AgyForkInput {
  storageRoot?: string
  cwd: string
  nativeSessionId: string
  candidateNativeSessionId?: string
  nativeTurnId?: string
  nativeInputIds?: readonly string[]
  responseHash?: string
  lastDispatchedPhase?: 'fork' | 'initialize'
  source?: AgentNativeForkBoundary
  witness?: AgentNativeForkWitness
  stagingLeafName?: string
  signal?: AbortSignal
  deadlineAt?: number
  beforePublish?: (candidate: AgyForkOperationResult) => Promise<void> | void
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalJsonValue(value)))
}

export function isInsideDirectory(root: string, target: string): boolean {
  const rel = relative(root, target)
  return (
    Boolean(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(rel)
  )
}

export function quoteSqlIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER_PATTERN.test(identifier))
    throw new Error(`Invalid SQLite identifier in Antigravity schema: ${identifier.slice(0, 64)}.`)
  return `"${identifier}"`
}

export function readExactBoundedBytesFromFd(fd: number, expectedBytes: number): Buffer {
  const buf = Buffer.allocUnsafe(expectedBytes)
  let totalRead = 0
  while (totalRead < expectedBytes) {
    const n = readSync(fd, buf, totalRead, expectedBytes - totalRead, totalRead)
    if (n <= 0) {
      throw new Error('Unexpected EOF while reading bounded Antigravity file.')
    }
    totalRead += n
  }
  const extraProbe = Buffer.allocUnsafe(1)
  const extraRead = readSync(fd, extraProbe, 0, 1, expectedBytes)
  if (extraRead !== 0) {
    throw new Error('Antigravity file grew beyond its verified byte length during read.')
  }
  return buf
}

export function parseLocalFileUriOrPath(rawPathOrUri: string):
  | {
      readonly rawPath: string
      readonly hasFileScheme: boolean
    }
  | undefined {
  if (!rawPathOrUri || rawPathOrUri.includes('\0')) return undefined
  const lower = rawPathOrUri.toLowerCase()
  const hasFileScheme = lower.startsWith('file://')
  let rawPath = rawPathOrUri
  if (hasFileScheme) {
    try {
      const parsed = new URL(rawPathOrUri)
      if (parsed.protocol !== 'file:') return undefined
      if (
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.port !== '' ||
        (parsed.hostname !== '' && parsed.hostname.toLowerCase() !== 'localhost')
      ) {
        return undefined
      }
      rawPath = decodeURIComponent(parsed.pathname)
      if (rawPath.includes('\0')) return undefined
      if (process.platform === 'win32' && /^\/[a-zA-Z]:\//u.test(rawPath)) {
        rawPath = rawPath.slice(1)
      }
    } catch {
      return undefined
    }
  } else if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(rawPathOrUri) &&
    !/^[a-zA-Z]:[\\/]/u.test(rawPathOrUri)
  ) {
    return undefined
  }

  // Reject UNC, remote share, and Windows extended/device paths BEFORE any filesystem call.
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    return undefined
  }
  if (!isAbsolute(rawPath)) return undefined
  return { rawPath, hasFileScheme }
}

export function collectAllowedAppDataRoots(
  canonicalAppDataDir: string,
  configuredAppDataDir?: string,
): string[] {
  const roots = new Set<string>([canonicalAppDataDir])
  if (configuredAppDataDir && isAbsolute(configuredAppDataDir)) {
    roots.add(resolve(configuredAppDataDir))
  }
  if (
    process.platform === 'darwin' &&
    (canonicalAppDataDir.startsWith('/private/var/') ||
      canonicalAppDataDir.startsWith('/private/tmp/'))
  ) {
    roots.add(canonicalAppDataDir.slice('/private'.length))
  }
  return [...roots]
}

export function verifySafeDirectoryChainIfPresent(
  canonicalAppDataDir: string,
  relativeParts: readonly string[],
  label = 'Antigravity brain',
): { exists: true; canonicalDir: string; stat: BigIntStats } | { exists: false } {
  let cursor = canonicalAppDataDir
  let lastStat: BigIntStats | undefined
  for (const segment of relativeParts) {
    cursor = join(cursor, segment)
    let stat: BigIntStats
    try {
      stat = lstatSync(cursor, { bigint: true })
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
        return { exists: false }
      }
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} directory path contains a symbolic link or non-directory.`)
    }
    const realCursor = realpathSync(cursor)
    if (realCursor !== cursor || !isInsideDirectory(canonicalAppDataDir, realCursor)) {
      throw new Error(`${label} directory escaped its storage root.`)
    }
    lastStat = stat
  }
  return {
    exists: true,
    canonicalDir: cursor,
    stat: lastStat ?? lstatSync(cursor, { bigint: true }),
  }
}

export function resolveAgyAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const geminiDir = env['ANTIGRAVITY_GEMINI_DIR']?.trim()
  if (geminiDir && isAbsolute(geminiDir)) {
    return resolve(join(geminiDir, 'antigravity-cli'))
  }
  const home = env['HOME']?.trim() || env['USERPROFILE']?.trim() || homedir()
  return resolve(join(home, '.gemini', 'antigravity-cli'))
}

export function resolveStorageRoot(storageRoot?: string): string {
  const configured =
    storageRoot?.trim() ||
    process.env['PACT_AGY_APP_DATA_DIR']?.trim() ||
    resolveAgyAppDataDir(process.env)
  if (!isAbsolute(configured)) {
    throw new Error(
      'The configured Antigravity native storage root is not absolute; its scope cannot be verified.',
    )
  }
  return configured
}

export function assertValidSessionUuid(
  sessionId: string,
  label = 'Antigravity Native Session UUID',
): void {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ${label}.`)
  }
}

export function statsMatch(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

let activeAgyTempStagingRoot: string | undefined

export async function withAgyTempStagingRoot<T>(
  tempStagingDir: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = activeAgyTempStagingRoot
  activeAgyTempStagingRoot = tempStagingDir
  try {
    return await fn()
  } finally {
    activeAgyTempStagingRoot = previous
  }
}

export function writeAllSync(
  fd: number,
  buffer: Buffer,
  offset = 0,
  length = buffer.byteLength - offset,
): void {
  let writtenTotal = 0
  while (writtenTotal < length) {
    const written = writeSync(fd, buffer, offset + writtenTotal, length - writtenTotal)
    if (written <= 0) {
      throw new Error('Short or zero-byte write while staging Antigravity file.')
    }
    writtenTotal += written
  }
}

export function resolveSnapshotParentTempDir(): string {
  if (activeAgyTempStagingRoot !== undefined) {
    if (!isAbsolute(activeAgyTempStagingRoot)) {
      throw new Error('Antigravity caller-owned temp staging directory must be an absolute path.')
    }
    let stat: BigIntStats
    try {
      stat = lstatSync(activeAgyTempStagingRoot, { bigint: true })
    } catch (error) {
      throw wrapOperationalStagingError(
        error,
        'Failed to access Antigravity caller-owned temp staging directory',
      )
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'Antigravity caller-owned temp staging directory must be a non-linked directory.',
      )
    }
    return activeAgyTempStagingRoot
  }
  return tmpdir()
}

export function ensureSafeDirectoryChain(
  canonicalAppDataDir: string,
  relativeParts: readonly string[],
): string {
  let cursor = canonicalAppDataDir
  for (const segment of relativeParts) {
    cursor = join(cursor, segment)
    mkdirSync(cursor, { recursive: true, mode: 0o700 })
    const stat = lstatSync(cursor, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Antigravity brain directory path contains a symbolic link or non-directory.')
    }
    if (!isInsideDirectory(canonicalAppDataDir, realpathSync(cursor))) {
      throw new Error('Antigravity brain directory escaped its storage root.')
    }
  }
  return cursor
}

export function fsyncDirectoryBestEffort(dirPath: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dirPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
