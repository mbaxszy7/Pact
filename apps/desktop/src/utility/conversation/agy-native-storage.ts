import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  AgentPromptImage,
  AgyNativeForkCutMetadata,
  AgyRebuildInitializationWitness,
} from '@pact/agent-runtime'
import type { ConversationImage } from '@pact/contracts/images'

import {
  AGY_STORAGE_MAX_RECORDS,
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  agyRebuildInitializationWitnessSchema,
  buildBoundedNativePlanId,
  collaborationPublishPlanInputSchema,
  encodeBoundedCollaborationIdentity,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
  type NativeContextRebuildChunk,
} from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'
import {
  AgyNativeLoaderError,
  checkSameVolume,
  identitiesExactMatch,
  openAnchoredLockedSqliteView,
  publishCandidateAtomically,
  verifyCandidateEmptyUnlocked,
  type AgySqliteFileIdentity,
} from './agy-sqlite-file'
import {
  AgyHotRollbackJournalError,
  AgyIdentityBudgetExceededError,
  AgyIdentityFallbackError,
  AgyInvalidSqliteImageError,
  AgyOperationalStorageError,
  AgyStorageMissingError,
  AgyTransientIdentityChurnError,
  AgyUnexpectedEofError,
  MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
  MAX_FALLBACK_TABLE_DDL_BYTES,
  SQLITE_WAL_INDEX_HEADER_BYTES,
  assembleSqliteLeafPayload,
  assertIdentityNotCancelledOrExpired,
  decodeSqliteRecord,
  decodeSqliteRecordHeader,
  decodeSqliteVarint,
  isIdentityAbortOrTimeoutError,
  isOperationalFsError,
  isOperationalSqliteError,
  isSqliteBusyOrLockedError,
  isTransientFileLockError,
  withAgyReadImage,
  wrapOperationalStagingError,
  type AgyCommittedReadImage,
  type AgyPreScannedSqliteProof,
  type AgySchemaCatalogBudget,
  type AgyWalShrinkBudget,
} from './agy-sqlite-image'
import { projectCollaborationAnswer } from './collaboration-answer'
import { requireNativeImageReference } from './native-image-content'

export {
  AgyHotRollbackJournalError,
  AgyIdentityBudgetExceededError,
  AgyOperationalStorageError,
  AgyTransientIdentityChurnError,
  withAgyReadImage,
  type AgySchemaCatalogBudget,
  type AgyWalShrinkBudget,
}

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

const MAX_PROTOBUF_FIELD_NUMBER = (1 << 29) - 1
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
export const AGY_TRAJECTORY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/u
export function isValidAgyTrajectoryId(value: unknown): value is string {
  return typeof value === 'string' && AGY_TRAJECTORY_ID_PATTERN.test(value)
}
const SAFE_ID_PATTERN = AGY_TRAJECTORY_ID_PATTERN
const SAFE_UPLOAD_NAME_PATTERN = /^[0-9a-z_.-]{1,255}$/iu
const SAFE_SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,63}$/iu

const KNOWN_TRAJECTORY_TABLES = new Set([
  'trajectory_meta',
  'steps',
  'gen_metadata',
  'executor_metadata',
  'parent_references',
  'battle_mode_infos',
  'trajectory_metadata_blob',
])

const REQUIRED_TRAJECTORY_TABLES = [
  'trajectory_meta',
  'steps',
  'gen_metadata',
  'executor_metadata',
] as const

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function sha256CanonicalJson(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalJsonValue(value)))
}

function isInsideDirectory(root: string, target: string): boolean {
  const rel = relative(root, target)
  return (
    Boolean(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(rel)
  )
}

function quoteSqlIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER_PATTERN.test(identifier))
    throw new Error(`Invalid SQLite identifier in Antigravity schema: ${identifier.slice(0, 64)}.`)
  return `"${identifier}"`
}

export function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    throw new Error('Invalid UTF-8 string in Antigravity Protobuf field.')
  }
}

function readVarint(buffer: Buffer, start: number): { value: bigint; nextOffset: number } {
  let result = 0n
  let shift = 0n
  for (let index = 0; index < 10; index += 1) {
    const position = start + index
    if (position >= buffer.length)
      throw new Error('Truncated Protobuf varint in Antigravity record.')
    const byte = buffer[position]!
    if (index === 9 && byte > 0x01)
      throw new Error('Overflowing 64-bit Protobuf varint in Antigravity record.')
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, nextOffset: position + 1 }
    shift += 7n
  }
  throw new Error('Unterminated Protobuf varint in Antigravity record.')
}

function writeVarint(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error('Protobuf varint is outside unsigned 64-bit bounds.')
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Buffer.from(bytes)
}

function toSafeUint32(value: bigint, label: string): number {
  if (value < 0n || value > 0xffff_ffffn)
    throw new Error(`Invalid uint32 value in Antigravity ${label}.`)
  return Number(value)
}

function toSafeInt32(value: bigint, label: string): number {
  const signed = BigInt.asIntN(32, value)
  if (
    value > 0x7fff_ffffn &&
    !(value >= 0xffff_ffff_8000_0000n && value <= 0xffff_ffff_ffff_ffffn)
  ) {
    throw new Error(`Invalid int32 varint encoding in Antigravity ${label}.`)
  }
  return Number(signed)
}

export function decodeProtobufFields(buffer: Buffer): ProtobufWireField[] {
  const fields: ProtobufWireField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const fieldStart = offset
    const tagRead = readVarint(buffer, offset)
    offset = tagRead.nextOffset
    const wireType = Number(tagRead.value & 0x07n)
    const fieldNumberBig = tagRead.value >> 3n
    if (fieldNumberBig <= 0n || fieldNumberBig > BigInt(MAX_PROTOBUF_FIELD_NUMBER))
      throw new Error('Invalid Protobuf field number in Antigravity record.')
    const fieldNumber = Number(fieldNumberBig)
    if (wireType === PROTOBUF_WIRE_VARINT) {
      const valueRead = readVarint(buffer, offset)
      offset = valueRead.nextOffset
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_VARINT,
        varint: valueRead.value,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_FIXED64) {
      if (offset + 8 > buffer.length)
        throw new Error('Truncated Protobuf fixed64 field in Antigravity record.')
      const fixed64 = buffer.subarray(offset, offset + 8)
      offset += 8
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_FIXED64,
        fixed64,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_BYTES) {
      const lengthRead = readVarint(buffer, offset)
      offset = lengthRead.nextOffset
      if (lengthRead.value > BigInt(buffer.length - offset))
        throw new Error('Truncated Protobuf length-delimited field in Antigravity record.')
      const byteLength = Number(lengthRead.value)
      const bytes = buffer.subarray(offset, offset + byteLength)
      offset += byteLength
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_BYTES,
        bytes,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_FIXED32) {
      if (offset + 4 > buffer.length)
        throw new Error('Truncated Protobuf fixed32 field in Antigravity record.')
      const fixed32 = buffer.subarray(offset, offset + 4)
      offset += 4
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_FIXED32,
        fixed32,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else {
      throw new Error(`Unsupported Protobuf wire type (${wireType}) in Antigravity record.`)
    }
  }
  return fields
}

export function encodeProtobufFields(fields: readonly ProtobufWireField[]): Buffer {
  if (fields.length === 0) return Buffer.alloc(0)
  return Buffer.concat(fields.map((field) => field.rawBytes))
}

function assertValidFieldNumber(fieldNumber: number): void {
  if (
    !Number.isSafeInteger(fieldNumber) ||
    fieldNumber <= 0 ||
    fieldNumber > MAX_PROTOBUF_FIELD_NUMBER
  ) {
    throw new Error('Invalid Protobuf field number.')
  }
}

export function encodeVarintField(fieldNumber: number, value: bigint | number): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  const unsigned =
    typeof value === 'bigint'
      ? value < 0n
        ? BigInt.asUintN(64, value)
        : value
      : value < 0
        ? BigInt.asUintN(64, BigInt(value))
        : BigInt(value)
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_VARINT))
  const encoded = writeVarint(unsigned)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_VARINT,
    varint: unsigned,
    rawBytes: Buffer.concat([tag, encoded]),
  }
}

export function encodeBytesField(fieldNumber: number, payload: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_BYTES))
  const length = writeVarint(BigInt(payload.byteLength))
  const copied = Buffer.from(payload)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_BYTES,
    bytes: copied,
    rawBytes: Buffer.concat([tag, length, copied]),
  }
}

export function encodeStringField(fieldNumber: number, text: string): ProtobufWireField {
  return encodeBytesField(fieldNumber, Buffer.from(text, 'utf8'))
}

export function encodeFixed64Field(fieldNumber: number, fixed64: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  if (fixed64.byteLength !== 8) throw new Error('Protobuf fixed64 payload must be 8 bytes.')
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_FIXED64))
  const copied = Buffer.from(fixed64)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_FIXED64,
    fixed64: copied,
    rawBytes: Buffer.concat([tag, copied]),
  }
}

export function encodeFixed32Field(fieldNumber: number, fixed32: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  if (fixed32.byteLength !== 4) throw new Error('Protobuf fixed32 payload must be 4 bytes.')
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_FIXED32))
  const copied = Buffer.from(fixed32)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_FIXED32,
    fixed32: copied,
    rawBytes: Buffer.concat([tag, copied]),
  }
}

export function decodeRepeatedUint32(
  fields: readonly ProtobufWireField[],
  fieldNumber: number,
): number[] {
  const values: number[] = []
  for (const field of fields) {
    if (field.fieldNumber !== fieldNumber) continue
    if (field.wireType === PROTOBUF_WIRE_VARINT) {
      values.push(toSafeUint32(field.varint, `field ${fieldNumber}`))
    } else if (field.wireType === PROTOBUF_WIRE_BYTES) {
      let offset = 0
      while (offset < field.bytes.length) {
        const next = readVarint(field.bytes, offset)
        offset = next.nextOffset
        values.push(toSafeUint32(next.value, `packed field ${fieldNumber}`))
      }
    } else {
      throw new Error(`Invalid wire type for repeated uint32 field ${fieldNumber}.`)
    }
  }
  return values
}

function decodeTimestamp(buffer: Buffer): DecodedProtobufTimestamp {
  const fields = decodeProtobufFields(buffer)
  let seconds = 0n
  let nanos = 0
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid Timestamp.seconds wire type.')
      seconds = BigInt.asIntN(64, field.varint)
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid Timestamp.nanos wire type.')
      nanos = toSafeInt32(field.varint, 'Timestamp.nanos')
    }
  }
  return { seconds, nanos }
}

function encodeTimestamp(seconds: bigint, nanos = 0): Buffer {
  const fields: ProtobufWireField[] = []
  if (seconds !== 0n) fields.push(encodeVarintField(1, seconds))
  if (nanos !== 0) fields.push(encodeVarintField(2, nanos))
  return encodeProtobufFields(fields)
}

function decodeToolCall(buffer: Buffer): DecodedCortexToolCall {
  const fields = decodeProtobufFields(buffer)
  let id: string | undefined
  let name: string | undefined
  let argumentsJson: string | undefined
  for (const field of fields) {
    if (field.wireType !== PROTOBUF_WIRE_BYTES) continue
    if (field.fieldNumber === 1) id = decodeUtf8Strict(field.bytes)
    else if (field.fieldNumber === 2) name = decodeUtf8Strict(field.bytes)
    else if (field.fieldNumber === 3) argumentsJson = decodeUtf8Strict(field.bytes)
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(argumentsJson !== undefined ? { argumentsJson } : {}),
  }
}

export function decodeSourceTrajectoryStepInfo(buffer: Buffer): DecodedSourceTrajectoryStepInfo {
  const fields = decodeProtobufFields(buffer)
  let trajectoryId: string | undefined
  let stepIndex: number | undefined
  let metadataIndex: number | undefined
  let cascadeId: string | undefined
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid SourceTrajectoryStepInfo.trajectory_id wire type.')
      trajectoryId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid SourceTrajectoryStepInfo.step_index wire type.')
      stepIndex = toSafeUint32(field.varint, 'SourceTrajectoryStepInfo.step_index')
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid SourceTrajectoryStepInfo.metadata_index wire type.')
      metadataIndex = toSafeUint32(field.varint, 'SourceTrajectoryStepInfo.metadata_index')
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid SourceTrajectoryStepInfo.cascade_id wire type.')
      cascadeId = decodeUtf8Strict(field.bytes)
    }
  }
  return {
    ...(trajectoryId !== undefined ? { trajectoryId } : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    ...(metadataIndex !== undefined ? { metadataIndex } : {}),
    ...(cascadeId !== undefined ? { cascadeId } : {}),
  }
}

export function decodeCortexStepMetadata(buffer: Buffer): DecodedCortexStepMetadata {
  const fields = decodeProtobufFields(buffer)
  let createdAt: DecodedProtobufTimestamp | undefined
  let source: number | undefined
  let toolCall: DecodedCortexToolCall | undefined
  let modifiedToolCall: DecodedCortexToolCall | undefined
  let executionId: string | undefined
  let sourceTrajectoryStepInfo: DecodedSourceTrajectoryStepInfo | undefined
  let stepId: string | undefined
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.created_at wire type.')
      createdAt = decodeTimestamp(field.bytes)
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid CortexStepMetadata.source wire type.')
      source = toSafeInt32(field.varint, 'CortexStepMetadata.source')
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.tool_call wire type.')
      toolCall = decodeToolCall(field.bytes)
    } else if (field.fieldNumber === 12) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.execution_id wire type.')
      executionId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 20) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.source_trajectory_step_info wire type.')
      sourceTrajectoryStepInfo = decodeSourceTrajectoryStepInfo(field.bytes)
    } else if (field.fieldNumber === 29) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.modified_tool_call wire type.')
      modifiedToolCall = decodeToolCall(field.bytes)
    } else if (field.fieldNumber === 35) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.step_id wire type.')
      stepId = decodeUtf8Strict(field.bytes)
    }
  }
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
    ...(modifiedToolCall !== undefined ? { modifiedToolCall } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(sourceTrajectoryStepInfo !== undefined ? { sourceTrajectoryStepInfo } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
  }
}

export function encodeCortexStepMetadata(input: {
  createdAtSeconds: bigint
  createdAtNanos?: number
  source: number
  executionId: string
  trajectoryId: string
  stepIndex: number
  cascadeId: string
  stepId: string
}): Buffer {
  const sourceInfoFields: ProtobufWireField[] = [encodeStringField(1, input.trajectoryId)]
  if (input.stepIndex > 0) sourceInfoFields.push(encodeVarintField(2, input.stepIndex))
  sourceInfoFields.push(encodeStringField(4, input.cascadeId))
  const fields: ProtobufWireField[] = [
    encodeBytesField(1, encodeTimestamp(input.createdAtSeconds, input.createdAtNanos ?? 0)),
    encodeVarintField(3, input.source),
    encodeStringField(12, input.executionId),
    encodeBytesField(20, encodeProtobufFields(sourceInfoFields)),
    encodeStringField(35, input.stepId),
  ]
  return encodeProtobufFields(fields)
}

function remapSourceTrajectoryStepInfoBytes(
  buffer: Buffer,
  remap: Pick<
    AgyIdentityRemap,
    'sourceTrajectoryId' | 'targetTrajectoryId' | 'sourceCascadeId' | 'targetCascadeId'
  >,
  expectedStepIdx: number,
): Buffer {
  const fields = decodeProtobufFields(buffer)
  const decoded = decodeSourceTrajectoryStepInfo(buffer)
  if ((decoded.stepIndex ?? 0) !== expectedStepIdx) {
    throw new Error(
      `Antigravity step ${expectedStepIdx} has shifted source_trajectory_step_info index (${decoded.stepIndex ?? 0}); possible /compact prefix rewrite.`,
    )
  }
  if (decoded.trajectoryId && decoded.trajectoryId !== remap.sourceTrajectoryId) {
    throw new Error('Antigravity step metadata references an unclosed foreign trajectory_id.')
  }
  if (decoded.cascadeId && decoded.cascadeId !== remap.sourceCascadeId) {
    throw new Error('Antigravity step metadata references an unclosed foreign cascade_id.')
  }
  let changed = false
  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid SourceTrajectoryStepInfo.trajectory_id wire type.')
      const current = decodeUtf8Strict(field.bytes)
      if (current === remap.sourceTrajectoryId && current !== remap.targetTrajectoryId) {
        changed = true
        return encodeStringField(1, remap.targetTrajectoryId)
      }
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid SourceTrajectoryStepInfo.cascade_id wire type.')
      const current = decodeUtf8Strict(field.bytes)
      if (current === remap.sourceCascadeId && current !== remap.targetCascadeId) {
        changed = true
        return encodeStringField(4, remap.targetCascadeId)
      }
    }
    return field
  })
  return changed ? encodeProtobufFields(nextFields) : buffer
}

export function remapCortexStepMetadata(
  buffer: Buffer,
  remap: Pick<
    AgyIdentityRemap,
    'sourceTrajectoryId' | 'targetTrajectoryId' | 'sourceCascadeId' | 'targetCascadeId'
  >,
  expectedStepIdx: number,
): Buffer {
  if (buffer.length === 0) return buffer
  const fields = decodeProtobufFields(buffer)
  let changed = false
  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber === 20) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepMetadata.source_trajectory_step_info wire type.')
      const remapped = remapSourceTrajectoryStepInfoBytes(field.bytes, remap, expectedStepIdx)
      if (remapped !== field.bytes) {
        changed = true
        return encodeBytesField(20, remapped)
      }
    }
    return field
  })
  return changed ? encodeProtobufFields(nextFields) : buffer
}

function decodeMedia(buffer: Buffer): DecodedAgyMedia {
  const fields = decodeProtobufFields(buffer)
  let mimeType: string | undefined
  let inlineData: Buffer | undefined
  let uri: string | undefined
  for (const field of fields) {
    if (field.wireType !== PROTOBUF_WIRE_BYTES) continue
    if (field.fieldNumber === 1) mimeType = decodeUtf8Strict(field.bytes)
    else if (field.fieldNumber === 2) inlineData = Buffer.from(field.bytes)
    else if (field.fieldNumber === 5) uri = decodeUtf8Strict(field.bytes)
  }
  return {
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(inlineData !== undefined ? { inlineData } : {}),
    ...(uri !== undefined ? { uri } : {}),
  }
}

function decodeTextOrScopeItem(buffer: Buffer): string {
  const fields = decodeProtobufFields(buffer)
  const parts: string[] = []
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid TextOrScopeItem.text wire type.')
      parts.push(decodeUtf8Strict(field.bytes))
    }
  }
  return parts.join('')
}

function decodeUserInput(buffer: Buffer): DecodedCortexStepUserInput {
  const fields = decodeProtobufFields(buffer)
  let userResponse = ''
  const itemTexts: string[] = []
  const media: DecodedAgyMedia[] = []
  let clientMessageId: string | undefined
  for (const field of fields) {
    if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepUserInput.user_response wire type.')
      userResponse = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepUserInput.items wire type.')
      itemTexts.push(decodeTextOrScopeItem(field.bytes))
    } else if (field.fieldNumber === 9) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepUserInput.media wire type.')
      media.push(decodeMedia(field.bytes))
    } else if (field.fieldNumber === 19) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepUserInput.client_message_id wire type.')
      clientMessageId = decodeUtf8Strict(field.bytes)
    }
  }
  const itemsText = itemTexts.join('')
  const text = userResponse.length > 0 ? userResponse : itemsText
  return {
    userResponse,
    itemsText,
    text,
    media,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
  }
}

function decodePlannerResponse(buffer: Buffer): DecodedCortexStepPlannerResponse {
  const fields = decodeProtobufFields(buffer)
  let response = ''
  let thinking = ''
  let modifiedResponse = ''
  const toolCalls: DecodedCortexToolCall[] = []
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepPlannerResponse.response wire type.')
      response = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepPlannerResponse.thinking wire type.')
      thinking = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 7) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepPlannerResponse.tool_calls wire type.')
      toolCalls.push(decodeToolCall(field.bytes))
    } else if (field.fieldNumber === 8) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepPlannerResponse.modified_response wire type.')
      modifiedResponse = decodeUtf8Strict(field.bytes)
    }
  }
  const canonicalText = modifiedResponse.length > 0 ? modifiedResponse : response
  return { response, thinking, modifiedResponse, canonicalText, toolCalls }
}

function decodeKeyValueEntry(buffer: Buffer): { key: string; value: string } | undefined {
  const fields = decodeProtobufFields(buffer)
  let key: string | undefined
  let value = ''
  for (const field of fields) {
    if (field.wireType !== PROTOBUF_WIRE_BYTES) return undefined
    if (field.fieldNumber === 1) key = decodeUtf8Strict(field.bytes)
    else if (field.fieldNumber === 2) value = decodeUtf8Strict(field.bytes)
    else return undefined
  }
  if (key === undefined) return undefined
  return { key, value }
}

function decodeGenericStep(buffer: Buffer): { args: Map<string, string>; hasError: boolean } {
  const fields = decodeProtobufFields(buffer)
  const args = new Map<string, string>()
  let hasError = false
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === PROTOBUF_WIRE_BYTES) {
      const entry = decodeKeyValueEntry(field.bytes)
      if (entry) args.set(entry.key, entry.value)
    } else if (field.fieldNumber === 2 && field.wireType === PROTOBUF_WIRE_BYTES) {
      const resultFields = decodeProtobufFields(field.bytes)
      for (const rf of resultFields) {
        if (rf.fieldNumber === 9 && rf.wireType === PROTOBUF_WIRE_BYTES) {
          const toolResultFields = decodeProtobufFields(rf.bytes)
          for (const trf of toolResultFields) {
            if (
              trf.fieldNumber === 20 &&
              trf.wireType === PROTOBUF_WIRE_BYTES &&
              trf.bytes.length > 0
            ) {
              hasError = true
            }
          }
        }
      }
    }
  }
  return { args, hasError }
}

export function decodeAgyStep(buffer: Buffer): DecodedAgyStep {
  const fields = decodeProtobufFields(buffer)
  let type = 0
  let status = 0
  let metadata: DecodedCortexStepMetadata | undefined
  let hasError = false
  let hasSubtrajectoryField = false
  let hasCompaction = false
  let userInput: DecodedCortexStepUserInput | undefined
  let plannerResponse: DecodedCortexStepPlannerResponse | undefined
  let genericArgs: ReadonlyMap<string, string> | undefined
  let genericHasError = false
  let writeToFileUri: string | undefined

  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT) throw new Error('Invalid Step.type wire type.')
      type = toSafeInt32(field.varint, 'Step.type')
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT) throw new Error('Invalid Step.status wire type.')
      status = toSafeInt32(field.varint, 'Step.status')
    } else if (field.fieldNumber === 5) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid Step.metadata wire type.')
      metadata = decodeCortexStepMetadata(field.bytes)
    } else if (field.fieldNumber === 6) {
      hasSubtrajectoryField = true
    } else if (field.fieldNumber === 19) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid Step.user_input wire type.')
      userInput = decodeUserInput(field.bytes)
    } else if (field.fieldNumber === 20) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid Step.planner_response wire type.')
      plannerResponse = decodePlannerResponse(field.bytes)
    } else if (field.fieldNumber === 23 && field.wireType === PROTOBUF_WIRE_BYTES) {
      for (const wf of decodeProtobufFields(field.bytes)) {
        if (wf.fieldNumber === 1 && wf.wireType === PROTOBUF_WIRE_BYTES) {
          writeToFileUri = decodeUtf8Strict(wf.bytes)
        }
      }
    } else if (field.fieldNumber === 30 || field.fieldNumber === 111) {
      hasCompaction = true
    } else if (field.fieldNumber === 31) {
      if (field.wireType === PROTOBUF_WIRE_BYTES && field.bytes.length > 0) hasError = true
    } else if (field.fieldNumber === 140 && field.wireType === PROTOBUF_WIRE_BYTES) {
      const generic = decodeGenericStep(field.bytes)
      genericArgs = generic.args
      genericHasError = generic.hasError
    } else if (field.fieldNumber === 159 && field.wireType === PROTOBUF_WIRE_BYTES) {
      for (const gf of decodeProtobufFields(field.bytes)) {
        if (gf.fieldNumber === 11) hasCompaction = true
      }
    }
  }

  return {
    type,
    status,
    ...(metadata !== undefined ? { metadata } : {}),
    hasError,
    hasSubtrajectoryField,
    hasCompaction,
    ...(userInput !== undefined ? { userInput } : {}),
    ...(plannerResponse !== undefined ? { plannerResponse } : {}),
    ...(genericArgs !== undefined ? { genericArgs } : {}),
    genericHasError,
    ...(writeToFileUri !== undefined ? { writeToFileUri } : {}),
  }
}

export function encodeAgyUserInputStep(input: {
  metadata: Buffer
  text: string
  media?: readonly { mimeType: string; inlineData: Buffer; uri: string }[]
  clientMessageId?: string
}): Buffer {
  const itemPayload = encodeProtobufFields([encodeStringField(1, input.text)])
  const userFields: ProtobufWireField[] = [
    encodeStringField(2, input.text),
    encodeBytesField(3, itemPayload),
  ]
  for (const media of input.media ?? []) {
    const mediaFields: ProtobufWireField[] = [
      encodeStringField(1, media.mimeType),
      encodeBytesField(2, media.inlineData),
      encodeStringField(5, media.uri),
    ]
    userFields.push(encodeBytesField(9, encodeProtobufFields(mediaFields)))
  }
  if (input.clientMessageId) userFields.push(encodeStringField(19, input.clientMessageId))
  return encodeProtobufFields([
    encodeVarintField(1, CORTEX_STEP_TYPE_USER_INPUT),
    encodeVarintField(4, CORTEX_STEP_STATUS_DONE),
    encodeBytesField(5, input.metadata),
    encodeBytesField(19, encodeProtobufFields(userFields)),
  ])
}

export function encodeAgyPlannerResponseStep(input: {
  metadata: Buffer
  response: string
}): Buffer {
  const plannerPayload = encodeProtobufFields([encodeStringField(1, input.response)])
  return encodeProtobufFields([
    encodeVarintField(1, CORTEX_STEP_TYPE_PLANNER_RESPONSE),
    encodeVarintField(4, CORTEX_STEP_STATUS_DONE),
    encodeBytesField(5, input.metadata),
    encodeBytesField(20, plannerPayload),
  ])
}

function readExactBoundedBytesFromFd(fd: number, expectedBytes: number): Buffer {
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

function parseLocalFileUriOrPath(rawPathOrUri: string):
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

function collectAllowedAppDataRoots(
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

function verifySafeDirectoryChainIfPresent(
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

function readVerifiedUploadedMediaFile(
  canonicalAppDataDir: string,
  cascadeId: string,
  filePath: string,
  maxBytes: number,
): Buffer {
  const ancestorsBefore = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', cascadeId, '.user_uploaded'],
    'Antigravity uploaded media',
  )
  if (!ancestorsBefore.exists) {
    throw Object.assign(new Error('Referenced Antigravity uploaded media directory is missing.'), {
      code: 'ENOENT',
    })
  }
  const fileName = basename(filePath)
  const expectedPath = join(ancestorsBefore.canonicalDir, fileName)
  if (resolve(filePath) !== expectedPath) {
    throw new Error('Antigravity uploaded media file path escaped its session .user_uploaded root.')
  }
  const stat = lstatSync(expectedPath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Antigravity source uploaded media file is linked or unsupported.')
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity uploaded media exceeds 32 MiB budget.',
      false,
    )
  }
  const realFile = realpathSync(expectedPath)
  if (realFile !== expectedPath || !isInsideDirectory(ancestorsBefore.canonicalDir, realFile)) {
    throw new Error('Antigravity source uploaded media file escaped its session directory.')
  }
  const fd = openSync(expectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    const ancestorsAfterOpen = verifySafeDirectoryChainIfPresent(
      canonicalAppDataDir,
      ['brain', cascadeId, '.user_uploaded'],
      'Antigravity uploaded media',
    )
    if (
      !ancestorsAfterOpen.exists ||
      ancestorsAfterOpen.canonicalDir !== ancestorsBefore.canonicalDir ||
      !statsMatch(stat, opened) ||
      realpathSync(expectedPath) !== expectedPath
    ) {
      throw new Error('Antigravity source uploaded media changed while opening.')
    }
    const mediaBytes = readExactBoundedBytesFromFd(fd, Number(stat.size))
    const afterRead = fstatSync(fd, { bigint: true })
    if (BigInt(mediaBytes.byteLength) !== stat.size || !statsMatch(stat, afterRead)) {
      throw new Error('Antigravity source uploaded media changed while reading.')
    }
    return mediaBytes
  } finally {
    closeSync(fd)
  }
}

function parseMediaUriToUploadedFile(
  uri: string,
  canonicalAppDataDir: string,
  sourceCascadeId: string,
  targetCascadeId: string,
  configuredAppDataDir?: string,
): Omit<AgyMediaCopyPlan, 'inlineData'> | undefined {
  const parsedPath = parseLocalFileUriOrPath(uri)
  if (!parsedPath) return undefined
  const { rawPath, hasFileScheme } = parsedPath

  // Confinement check is purely lexical against authorized app-data roots BEFORE any FS call.
  const resolvedRaw = resolve(rawPath)
  const normalizedDir = dirname(resolvedRaw)
  const fileName = basename(resolvedRaw)
  const allowedRoots = collectAllowedAppDataRoots(canonicalAppDataDir, configuredAppDataDir)

  let matchedUploadedLexically = false
  let insideSourceBrainLexically = false
  for (const root of allowedRoots) {
    const brainRoot = join(root, 'brain', sourceCascadeId)
    const uploadedRoot = join(brainRoot, '.user_uploaded')
    if (normalizedDir === uploadedRoot) {
      matchedUploadedLexically = true
      break
    }
    if (resolvedRaw === brainRoot || isInsideDirectory(brainRoot, resolvedRaw)) {
      insideSourceBrainLexically = true
    }
  }

  if (!matchedUploadedLexically) {
    if (insideSourceBrainLexically) {
      throw new Error(
        'Antigravity step media references a non-upload path inside the source brain directory.',
      )
    }
    return undefined
  }

  // Always walk and lstat + realpath-verify canonicalAppDataDir/brain/<sourceCascadeId>/.user_uploaded.
  verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sourceCascadeId, '.user_uploaded'],
    'Antigravity uploaded media',
  )

  if (
    !SAFE_UPLOAD_NAME_PATTERN.test(fileName) ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new Error('Antigravity uploaded media filename is unsafe.')
  }
  const sourceFilePath = join(
    canonicalAppDataDir,
    'brain',
    sourceCascadeId,
    '.user_uploaded',
    fileName,
  )
  const targetFilePath = join(
    canonicalAppDataDir,
    'brain',
    targetCascadeId,
    '.user_uploaded',
    fileName,
  )
  const targetUri = hasFileScheme
    ? `file://${process.platform === 'win32' ? '/' : ''}${targetFilePath.replaceAll('\\', '/')}`
    : targetFilePath
  return { sourceUri: uri, targetUri, fileName, sourceFilePath, targetFilePath }
}

function remapUserInputBytes(
  buffer: Buffer,
  remap: AgyIdentityRemap,
): { buffer: Buffer; copiedMedia: AgyMediaCopyPlan[]; inlineImageBytes: number } {
  const fields = decodeProtobufFields(buffer)
  let changed = false
  let inlineImageBytes = 0
  const copiedMedia: AgyMediaCopyPlan[] = []

  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber !== 9) return field
    if (field.wireType !== PROTOBUF_WIRE_BYTES)
      throw new Error('Invalid CortexStepUserInput.media wire type.')
    const mediaFields = decodeProtobufFields(field.bytes)
    let inlineData: Buffer | undefined
    for (const mf of mediaFields) {
      if (mf.fieldNumber === 2 && mf.wireType === PROTOBUF_WIRE_BYTES) {
        inlineImageBytes += mf.bytes.byteLength
        inlineData = mf.bytes
      }
    }
    let mediaChanged = false
    const nextMediaFields = mediaFields.map((mf): ProtobufWireField => {
      if (mf.fieldNumber === 5) {
        if (mf.wireType !== PROTOBUF_WIRE_BYTES) throw new Error('Invalid Media.uri wire type.')
        const uri = decodeUtf8Strict(mf.bytes)
        const plan = parseMediaUriToUploadedFile(
          uri,
          remap.canonicalAppDataDir,
          remap.sourceCascadeId,
          remap.targetCascadeId,
          remap.configuredAppDataDir,
        )
        if (plan) {
          copiedMedia.push({
            ...plan,
            ...(inlineData !== undefined ? { inlineData } : {}),
          })
          if (plan.targetUri !== uri) {
            mediaChanged = true
            return encodeStringField(5, plan.targetUri)
          }
        }
      }
      return mf
    })
    if (!mediaChanged) return field
    changed = true
    return encodeBytesField(9, encodeProtobufFields(nextMediaFields))
  })

  return {
    buffer: changed ? encodeProtobufFields(nextFields) : buffer,
    copiedMedia,
    inlineImageBytes,
  }
}

export function remapAgyStep(
  buffer: Buffer,
  remap: AgyIdentityRemap,
  expectedStepIdx: number,
): { buffer: Buffer; copiedMedia: AgyMediaCopyPlan[]; inlineImageBytes: number } {
  const fields = decodeProtobufFields(buffer)
  let changed = false
  let inlineImageBytes = 0
  const copiedMedia: AgyMediaCopyPlan[] = []

  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber === 5) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid Step.metadata wire type.')
      const remappedMeta = remapCortexStepMetadata(field.bytes, remap, expectedStepIdx)
      if (remappedMeta !== field.bytes) {
        changed = true
        return encodeBytesField(5, remappedMeta)
      }
      return field
    }
    if (field.fieldNumber === 19) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid Step.user_input wire type.')
      const remappedUser = remapUserInputBytes(field.bytes, remap)
      inlineImageBytes += remappedUser.inlineImageBytes
      copiedMedia.push(...remappedUser.copiedMedia)
      if (remappedUser.buffer !== field.bytes) {
        changed = true
        return encodeBytesField(19, remappedUser.buffer)
      }
      return field
    }
    return field
  })

  return {
    buffer: changed ? encodeProtobufFields(nextFields) : buffer,
    copiedMedia,
    inlineImageBytes,
  }
}

export function decodeCortexStepGeneratorMetadata(buffer: Buffer): DecodedGenMetadata {
  const fields = decodeProtobufFields(buffer)
  const stepIndices = decodeRepeatedUint32(fields, 2)
  let executionId: string | undefined
  const customMetadata: Array<{ key: string; value: string }> = []
  let hasCompactionCheckpoint = false

  for (const field of fields) {
    if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepGeneratorMetadata.execution_id wire type.')
      executionId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepGeneratorMetadata.chat_model wire type.')
      const chatModelFields = decodeProtobufFields(field.bytes)
      for (const cmf of chatModelFields) {
        if (cmf.fieldNumber === 9 && cmf.wireType === PROTOBUF_WIRE_BYTES) {
          const startFields = decodeProtobufFields(cmf.bytes)
          const covered = decodeRepeatedUint32(startFields, 3)
          if (covered.length > 0) hasCompactionCheckpoint = true
          for (const sf of startFields) {
            if (
              sf.fieldNumber === 2 &&
              sf.wireType === PROTOBUF_WIRE_VARINT &&
              toSafeInt32(sf.varint, 'ChatStartMetadata.checkpoint_index') > 0
            ) {
              hasCompactionCheckpoint = true
            }
          }
        } else if (cmf.fieldNumber === 20 && cmf.wireType === PROTOBUF_WIRE_BYTES) {
          const entry = decodeKeyValueEntry(cmf.bytes)
          if (!entry) throw new Error('Invalid ChatModelMetadata.custom_metadata entry.')
          customMetadata.push(entry)
        }
      }
    } else if (field.fieldNumber === 20 && field.wireType === PROTOBUF_WIRE_BYTES) {
      const entry = decodeKeyValueEntry(field.bytes)
      if (!entry) throw new Error('Invalid CortexStepGeneratorMetadata.custom_metadata entry.')
      customMetadata.push(entry)
    }
  }

  return {
    ...(executionId !== undefined ? { executionId } : {}),
    stepIndices,
    customMetadata,
    hasCompactionCheckpoint,
  }
}

function remapCustomMetadataEntryBytes(
  buffer: Buffer,
  remap: Pick<
    AgyIdentityRemap,
    'sourceTrajectoryId' | 'targetTrajectoryId' | 'sourceCascadeId' | 'targetCascadeId'
  >,
): Buffer {
  const entry = decodeKeyValueEntry(buffer)
  if (!entry) throw new Error('Invalid custom_metadata entry in Antigravity gen_metadata.')
  if (entry.key === 'trajectory_id') {
    if (entry.value && entry.value !== remap.sourceTrajectoryId) {
      throw new Error('Antigravity gen_metadata references an unclosed foreign trajectory_id.')
    }
    if (entry.value === remap.sourceTrajectoryId && entry.value !== remap.targetTrajectoryId) {
      return encodeProtobufFields([
        encodeStringField(1, entry.key),
        encodeStringField(2, remap.targetTrajectoryId),
      ])
    }
  } else if (entry.key === 'cascade_id' || entry.key === 'root_cascade_id') {
    if (entry.value && entry.value !== remap.sourceCascadeId) {
      throw new Error(`Antigravity gen_metadata references an unclosed foreign ${entry.key}.`)
    }
    if (entry.value === remap.sourceCascadeId && entry.value !== remap.targetCascadeId) {
      return encodeProtobufFields([
        encodeStringField(1, entry.key),
        encodeStringField(2, remap.targetCascadeId),
      ])
    }
  }
  return buffer
}

export function remapCortexStepGeneratorMetadata(
  buffer: Buffer,
  remap: Pick<
    AgyIdentityRemap,
    'sourceTrajectoryId' | 'targetTrajectoryId' | 'sourceCascadeId' | 'targetCascadeId'
  >,
): Buffer {
  if (buffer.length === 0) return buffer
  const fields = decodeProtobufFields(buffer)
  let changed = false
  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepGeneratorMetadata.chat_model wire type.')
      const chatFields = decodeProtobufFields(field.bytes)
      let chatChanged = false
      const nextChatFields = chatFields.map((cf): ProtobufWireField => {
        if (cf.fieldNumber === 20) {
          if (cf.wireType !== PROTOBUF_WIRE_BYTES)
            throw new Error('Invalid ChatModelMetadata.custom_metadata wire type.')
          const remappedEntry = remapCustomMetadataEntryBytes(cf.bytes, remap)
          if (remappedEntry !== cf.bytes) {
            chatChanged = true
            return encodeBytesField(20, remappedEntry)
          }
        }
        return cf
      })
      if (chatChanged) {
        changed = true
        return encodeBytesField(1, encodeProtobufFields(nextChatFields))
      }
      return field
    }
    if (field.fieldNumber === 20) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid CortexStepGeneratorMetadata.custom_metadata wire type.')
      const remappedEntry = remapCustomMetadataEntryBytes(field.bytes, remap)
      if (remappedEntry !== field.bytes) {
        changed = true
        return encodeBytesField(20, remappedEntry)
      }
    }
    return field
  })
  return changed ? encodeProtobufFields(nextFields) : buffer
}

export function decodeExecutorMetadata(buffer: Buffer): DecodedExecutorMetadata {
  const fields = decodeProtobufFields(buffer)
  let terminationReason = 0
  let numGeneratorInvocations = 0
  let lastStepIdx: number | undefined
  let executionId: string | undefined
  let executionError: string | undefined

  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid ExecutorMetadata.termination_reason wire type.')
      terminationReason = toSafeInt32(field.varint, 'ExecutorMetadata.termination_reason')
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid ExecutorMetadata.num_generator_invocations wire type.')
      numGeneratorInvocations = toSafeInt32(
        field.varint,
        'ExecutorMetadata.num_generator_invocations',
      )
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid ExecutorMetadata.last_step_idx wire type.')
      lastStepIdx = toSafeInt32(field.varint, 'ExecutorMetadata.last_step_idx')
    } else if (field.fieldNumber === 9) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid ExecutorMetadata.execution_id wire type.')
      executionId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 12) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES)
        throw new Error('Invalid ExecutorMetadata.execution_error wire type.')
      executionError = decodeUtf8Strict(field.bytes)
    }
  }

  return {
    terminationReason,
    numGeneratorInvocations,
    ...(lastStepIdx !== undefined ? { lastStepIdx } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(executionError !== undefined ? { executionError } : {}),
  }
}

export function encodeExecutorMetadata(input: {
  terminationReason: number
  numGeneratorInvocations: number
  lastStepIdx: number
  executionId: string
}): Buffer {
  const fields: ProtobufWireField[] = [encodeVarintField(1, input.terminationReason)]
  if (input.numGeneratorInvocations > 0)
    fields.push(encodeVarintField(2, input.numGeneratorInvocations))
  if (input.lastStepIdx > 0) fields.push(encodeVarintField(3, input.lastStepIdx))
  fields.push(encodeStringField(9, input.executionId))
  return encodeProtobufFields(fields)
}

export function decodeCortexTrajectoryMetadata(buffer: Buffer): DecodedTrajectoryMetadata {
  const fields = decodeProtobufFields(buffer)
  let parentConversationId: string | undefined
  let rootConversationId: string | undefined
  let hasSubagentSpec = false
  let isBattleModeFork = false
  let nestingDepth = 0

  for (const field of fields) {
    if (field.fieldNumber === 5 && field.wireType === PROTOBUF_WIRE_BYTES) {
      parentConversationId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 6 && field.wireType === PROTOBUF_WIRE_BYTES) {
      rootConversationId = decodeUtf8Strict(field.bytes)
    } else if (field.fieldNumber === 8) {
      hasSubagentSpec = true
    } else if (field.fieldNumber === 16 && field.wireType === PROTOBUF_WIRE_VARINT) {
      isBattleModeFork = field.varint !== 0n
    } else if (field.fieldNumber === 17 && field.wireType === PROTOBUF_WIRE_VARINT) {
      nestingDepth = toSafeInt32(field.varint, 'CortexTrajectoryMetadata.nesting_depth')
    }
  }

  return {
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(rootConversationId !== undefined ? { rootConversationId } : {}),
    hasSubagentSpec,
    isBattleModeFork,
    nestingDepth,
  }
}

export function remapCortexTrajectoryMetadata(
  buffer: Buffer,
  remap: Pick<AgyIdentityRemap, 'sourceCascadeId' | 'targetCascadeId'>,
): Buffer {
  if (buffer.length === 0) return buffer
  const fields = decodeProtobufFields(buffer)
  let changed = false
  const nextFields = fields.map((field): ProtobufWireField => {
    if (field.fieldNumber === 6 && field.wireType === PROTOBUF_WIRE_BYTES) {
      const current = decodeUtf8Strict(field.bytes)
      if (current === remap.sourceCascadeId && current !== remap.targetCascadeId) {
        changed = true
        return encodeStringField(6, remap.targetCascadeId)
      }
    }
    return field
  })
  return changed ? encodeProtobufFields(nextFields) : buffer
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

function assertValidSessionUuid(
  sessionId: string,
  label = 'Antigravity Native Session UUID',
): void {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ${label}.`)
  }
}

function statsMatch(left: BigIntStats, right: BigIntStats): boolean {
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

function writeAllSync(
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

function resolveSnapshotParentTempDir(): string {
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

interface CommittedSqliteSnapshotHandle {
  readonly db: Database.Database
  readonly proof: AgyPreScannedSqliteProof
  readonly fileIdentity: AgySqliteFileIdentity
  readonly walIdentity: AgySqliteFileIdentity | null
  readonly committedImageDigest: string
  readonly canonicalDbPath: string
  close(): void
}

function openCommittedSqliteSnapshot(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly parentSegments: readonly string[]
  readonly leafName: string
  readonly maxSnapshotBytes?: number
  readonly schemaCatalogBudget?: AgySchemaCatalogBudget
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): CommittedSqliteSnapshotHandle {
  const { rootDir, canonicalRoot, parentSegments, leafName } = input
  const maxSnapshotBytes = input.maxSnapshotBytes ?? AGY_MAX_HISTORY_BYTES * 2
  const canonicalDbPath = join(canonicalRoot, ...parentSegments, leafName)
  const materialized = withAgyReadImage(
    { rootDir, parentSegments, leafName },
    {
      maxSnapshotBytes,
      snapshotParentTempDir: resolveSnapshotParentTempDir(),
      ...(input.schemaCatalogBudget !== undefined
        ? { schemaCatalogBudget: input.schemaCatalogBudget }
        : {}),
    },
    {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    },
    (image) => {
      const snap = image.materializePrivateSnapshot({
        maxSnapshotBytes,
        snapshotParentTempDir: resolveSnapshotParentTempDir(),
        ...(input.schemaCatalogBudget !== undefined
          ? { schemaCatalogBudget: input.schemaCatalogBudget }
          : {}),
      })
      return {
        snap,
        fileIdentity: image.fileIdentity,
        walIdentity: image.walIdentity,
        committedImageDigest: image.committedImageDigest,
      }
    },
  )

  let db: Database.Database
  try {
    db = materialized.snap.openReadOnlyDatabase()
  } catch (error) {
    materialized.snap.cleanup()
    throw error
  }
  return {
    db,
    proof: materialized.snap.proof,
    fileIdentity: materialized.fileIdentity,
    walIdentity: materialized.walIdentity,
    committedImageDigest: materialized.committedImageDigest,
    canonicalDbPath,
    close: () => {
      db.close()
    },
  }
}

function assertAnchoredSourceUnchanged(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly parentSegments: readonly string[]
  readonly leafName: string
  readonly expectedIdentity: AgySqliteFileIdentity
  readonly expectedCommittedImageDigest: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): void {
  if (realpathSync(input.rootDir) !== input.canonicalRoot) {
    throw new Error('Antigravity storage root changed during inspection.')
  }
  withAgyReadImage(
    {
      rootDir: input.rootDir,
      parentSegments: input.parentSegments,
      leafName: input.leafName,
    },
    { maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES },
    {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    },
    (image) => {
      if (
        !identitiesExactMatch(image.fileIdentity, input.expectedIdentity) ||
        image.committedImageDigest !== input.expectedCommittedImageDigest
      ) {
        throw new Error('Antigravity trajectory database changed during inspection.')
      }
      image.verifyUnchanged()
    },
  )
}

/**
 * Verifies a closed zero-step empty candidate DB using the anchored native file module WITHOUT
 * ever opening a writable SQLite handle or creating sidefiles in `conversations/`.
 * If an active SQLite lock or uncleaned `-wal`/`-shm`/`-journal` remains, preserves the candidate
 * & original binding and throws an explicit `UNCERTAIN` error.
 */
function hasBlockingCandidateArtifacts(
  check: ReturnType<typeof verifyCandidateEmptyUnlocked>,
): boolean {
  if (check.hasActiveLock || check.hasJournal) return true
  if (check.hasWal && check.walByteLength !== 0) return true
  if (check.hasShm && !check.hasWal) return true
  return false
}

const STAGING_LEAF_NAME_PATTERN = /^\.pact-stage-[a-zA-Z0-9._-]{1,96}\.db$/u

function publishStagedCandidateOrThrow(input: {
  readonly canonicalRoot: string
  readonly candidateSessionId: string
  readonly stagedLeafName: string
  readonly expectedTargetIdentity: AgySqliteFileIdentity
  readonly expectedStagedIdentity: AgySqliteFileIdentity
}): void {
  const result = publishCandidateAtomically({
    rootDir: input.canonicalRoot,
    targetParentSegments: ['conversations'],
    targetLeafName: `${input.candidateSessionId}.db`,
    stagedParentSegments: ['brain', input.candidateSessionId],
    stagedLeafName: input.stagedLeafName,
    expectedTargetIdentity: input.expectedTargetIdentity,
    expectedStagedIdentity: input.expectedStagedIdentity,
  })
  if (result.status === 'published') {
    return
  }
  if (result.status === 'exdev') {
    throw Object.assign(
      new Error(
        `Antigravity candidate staging and conversations directories are on different volumes (${result.reason}).`,
      ),
      { code: 'EXDEV' },
    )
  }
  throw Object.assign(
    new Error(
      `Antigravity candidate database could not be safely published (${result.reason}); publication is UNCERTAIN.`,
    ),
    { code: 'UNCERTAIN' },
  )
}

function openCandidateShellSnapshotOrThrowUncertain(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly candidateSessionId: string
  readonly maxSnapshotBytes: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): CommittedSqliteSnapshotHandle {
  try {
    return openCommittedSqliteSnapshot({
      rootDir: input.rootDir,
      canonicalRoot: input.canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.candidateSessionId}.db`,
      maxSnapshotBytes: input.maxSnapshotBytes,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (
      error instanceof AgyTransientIdentityChurnError ||
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyInvalidSqliteImageError
    ) {
      let check: ReturnType<typeof verifyCandidateEmptyUnlocked> | undefined
      try {
        check = verifyCandidateEmptyUnlocked(
          input.canonicalRoot,
          ['conversations'],
          `${input.candidateSessionId}.db`,
        )
      } catch {
        check = undefined
      }
      if (check && hasBlockingCandidateArtifacts(check)) {
        throw Object.assign(
          new Error(
            'Antigravity candidate database retains an active lock or uncleaned WAL/SHM/journal sidefile; publication is UNCERTAIN.',
          ),
          { code: 'UNCERTAIN' },
        )
      }
    }
    throw error
  }
}

interface SameVolumeCandidateStage {
  readonly stagingPath: string
  readonly stagingLeafName: string
  readonly createdAnchoredIdentity: AgySqliteFileIdentity
  assertStagingBound(options?: { readonly expectedSize?: bigint }): BigIntStats
  fsyncVerifiedStaging(expectedSize: bigint): void
  assertAnchoredIdentityMatchesCreated(identity: AgySqliteFileIdentity, expectedSize: bigint): void
  cleanup(): void
}

/**
 * Allocates a same-volume private SQLite staging file under
 * `<canonicalRoot>/brain/<candidateSessionId>/.pact-stage-<uuid>.db` (`0o600`, `DELETE` journal mode)
 * and binds both the staging directory and exclusively created file identity across SQLite
 * initialization, mutation, verification, fsync, publication, and cleanup.
 */
function createSameVolumeCandidateStagingDb(
  canonicalRoot: string,
  candidateSessionId: string,
  requestedStagingLeafName?: string,
): SameVolumeCandidateStage {
  const stagingLeafName = requestedStagingLeafName ?? `.pact-stage-${randomUUID()}.db`
  if (!STAGING_LEAF_NAME_PATTERN.test(stagingLeafName)) {
    throw new Error('Invalid Antigravity candidate staging filename.')
  }
  const brainCandidatePath = join(canonicalRoot, 'brain', candidateSessionId)
  let existedBefore = false
  try {
    const st = lstatSync(brainCandidatePath, { bigint: true })
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error('Antigravity candidate brain staging directory is linked or invalid.')
    }
    existedBefore = true
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
      throw error
    }
  }
  const safeBrainDir = ensureSafeDirectoryChain(canonicalRoot, ['brain', candidateSessionId])
  const brainDirStat = lstatSync(safeBrainDir, { bigint: true })
  if (
    !brainDirStat.isDirectory() ||
    brainDirStat.isSymbolicLink() ||
    realpathSync(safeBrainDir) !== safeBrainDir
  ) {
    throw new Error('Antigravity candidate brain staging directory is linked or invalid.')
  }
  let brainDirFd: number | undefined
  if (process.platform !== 'win32') {
    brainDirFd = openSync(
      safeBrainDir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const pinnedDirStat = fstatSync(brainDirFd, { bigint: true })
    if (
      !pinnedDirStat.isDirectory() ||
      pinnedDirStat.dev !== brainDirStat.dev ||
      pinnedDirStat.ino !== brainDirStat.ino
    ) {
      closeSync(brainDirFd)
      brainDirFd = undefined
      throw new Error('Antigravity candidate brain staging directory changed while opening.')
    }
  }
  const closeBrainDirFd = (): void => {
    if (brainDirFd !== undefined) {
      try {
        closeSync(brainDirFd)
      } catch {
        /* Best-effort close of pinned staging directory handle. */
      }
      brainDirFd = undefined
    }
  }
  const removeEmptyBrainDirIfCreated = (): void => {
    if (!existedBefore) {
      try {
        rmdirSync(safeBrainDir)
      } catch {
        /* Candidate brain directory may legitimately hold uploaded media or receipts. */
      }
    }
  }

  let sameVolume: boolean
  try {
    sameVolume = checkSameVolume(canonicalRoot, ['conversations'], ['brain', candidateSessionId])
  } catch (error) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  if (!sameVolume) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw Object.assign(
      new Error(
        'Antigravity candidate brain staging directory and conversations directory are on different volumes.',
      ),
      { code: 'EXDEV' },
    )
  }

  const assertStagingDirUnchanged = (): void => {
    if (realpathSync(canonicalRoot) !== canonicalRoot) {
      throw new Error('Antigravity storage root changed during candidate staging.')
    }
    const currentDirStat = lstatSync(safeBrainDir, { bigint: true })
    if (
      !currentDirStat.isDirectory() ||
      currentDirStat.isSymbolicLink() ||
      currentDirStat.dev !== brainDirStat.dev ||
      currentDirStat.ino !== brainDirStat.ino ||
      realpathSync(safeBrainDir) !== safeBrainDir ||
      !isInsideDirectory(canonicalRoot, safeBrainDir)
    ) {
      throw new Error('Antigravity candidate brain staging directory changed during staging.')
    }
    if (brainDirFd !== undefined) {
      const pinnedDirStat = fstatSync(brainDirFd, { bigint: true })
      if (
        !pinnedDirStat.isDirectory() ||
        pinnedDirStat.dev !== brainDirStat.dev ||
        pinnedDirStat.ino !== brainDirStat.ino
      ) {
        throw new Error('Antigravity candidate pinned brain directory identity changed.')
      }
    }
  }

  const stagingPath = join(safeBrainDir, stagingLeafName)
  let fd: number
  try {
    assertStagingDirUnchanged()
    fd = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  let createdStat: BigIntStats
  try {
    createdStat = fstatSync(fd, { bigint: true })
    if (
      !createdStat.isFile() ||
      createdStat.nlink !== 1n ||
      createdStat.size !== 0n ||
      createdStat.dev !== brainDirStat.dev
    ) {
      throw new Error('Antigravity candidate staging descriptor identity is invalid.')
    }
    assertStagingDirUnchanged()
    const liveCreatedStat = lstatSync(stagingPath, { bigint: true })
    if (
      !liveCreatedStat.isFile() ||
      liveCreatedStat.isSymbolicLink() ||
      liveCreatedStat.nlink !== 1n ||
      liveCreatedStat.dev !== createdStat.dev ||
      liveCreatedStat.ino !== createdStat.ino ||
      realpathSync(stagingPath) !== stagingPath
    ) {
      throw new Error('Antigravity candidate staging path changed immediately after creation.')
    }
  } catch (error) {
    closeSync(fd)
    try {
      const current = lstatSync(stagingPath, { bigint: true })
      if (!current.isSymbolicLink() && current.dev === brainDirStat.dev) {
        unlinkSync(stagingPath)
      }
    } catch {
      /* Best-effort cleanup of failed staging creation. */
    }
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  closeSync(fd)

  let createdAnchoredIdentity: AgySqliteFileIdentity
  try {
    createdAnchoredIdentity = readAnchoredFileIdentity(
      canonicalRoot,
      ['brain', candidateSessionId],
      stagingLeafName,
    )
    if (
      createdAnchoredIdentity.size !== '0' ||
      (process.platform !== 'win32' &&
        (createdAnchoredIdentity.dev !== String(createdStat.dev) ||
          createdAnchoredIdentity.ino !== String(createdStat.ino)))
    ) {
      throw new Error('Antigravity candidate staging anchored identity mismatch after creation.')
    }
  } catch (error) {
    try {
      const current = lstatSync(stagingPath, { bigint: true })
      if (
        !current.isSymbolicLink() &&
        current.dev === createdStat.dev &&
        current.ino === createdStat.ino
      ) {
        unlinkSync(stagingPath)
      }
    } catch {
      /* Best-effort cleanup of unverified staging file. */
    }
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }

  const assertStagingBound = (options?: { readonly expectedSize?: bigint }): BigIntStats => {
    assertStagingDirUnchanged()
    const current = lstatSync(stagingPath, { bigint: true })
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== createdStat.dev ||
      current.ino !== createdStat.ino ||
      realpathSync(stagingPath) !== stagingPath
    ) {
      throw new Error('Antigravity candidate staging file identity drifted during staging.')
    }
    if (options?.expectedSize !== undefined && current.size !== options.expectedSize) {
      throw new Error('Antigravity candidate staging file size drifted during staging.')
    }
    return current
  }

  const fsyncVerifiedStaging = (expectedSize: bigint): void => {
    assertStagingBound({ expectedSize })
    const syncFd = openSync(stagingPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(syncFd, { bigint: true })
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== createdStat.dev ||
        opened.ino !== createdStat.ino ||
        opened.size !== expectedSize
      ) {
        throw new Error('Antigravity candidate staging file changed while opening for fsync.')
      }
      assertStagingBound({ expectedSize })
      fsyncSync(syncFd)
      const afterSync = fstatSync(syncFd, { bigint: true })
      if (
        !afterSync.isFile() ||
        afterSync.nlink !== 1n ||
        afterSync.dev !== createdStat.dev ||
        afterSync.ino !== createdStat.ino ||
        afterSync.size !== expectedSize
      ) {
        throw new Error('Antigravity candidate staging file changed during fsync.')
      }
    } finally {
      closeSync(syncFd)
    }
  }

  const assertAnchoredIdentityMatchesCreated = (
    identity: AgySqliteFileIdentity,
    expectedSize: bigint,
  ): void => {
    if (
      identity.dev !== createdAnchoredIdentity.dev ||
      identity.ino !== createdAnchoredIdentity.ino ||
      identity.size !== String(expectedSize)
    ) {
      throw new Error('Antigravity candidate staging anchored identity drifted before publication.')
    }
  }

  return {
    stagingPath,
    stagingLeafName,
    createdAnchoredIdentity,
    assertStagingBound,
    fsyncVerifiedStaging,
    assertAnchoredIdentityMatchesCreated,
    cleanup: () => {
      try {
        const current = lstatSync(stagingPath, { bigint: true })
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          current.dev === createdStat.dev &&
          current.ino === createdStat.ino
        ) {
          unlinkSync(stagingPath)
        }
      } catch {
        /* Staging file was already published or absent. */
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const sidePath = `${stagingPath}${suffix}`
          const sideStat = lstatSync(sidePath, { bigint: true })
          if (
            !sideStat.isSymbolicLink() &&
            sideStat.isFile() &&
            sideStat.nlink === 1n &&
            sideStat.dev === createdStat.dev
          ) {
            unlinkSync(sidePath)
          }
        } catch {
          /* Best-effort cleanup of verified staging sidefiles. */
        }
      }
      closeBrainDirFd()
      removeEmptyBrainDirIfCreated()
    },
  }
}

function readAnchoredFileIdentity(
  canonicalRoot: string,
  parentSegments: readonly string[],
  leafName: string,
): AgySqliteFileIdentity {
  const view = openAnchoredLockedSqliteView(canonicalRoot, parentSegments, leafName, {
    acquireSharedLock: false,
    openWal: false,
    openShm: false,
    checkJournal: false,
  })
  try {
    return view.fileIdentity
  } finally {
    view.close()
  }
}

function computePhysicalDbDigest(
  canonicalRoot: string,
  sessionId: string,
  originalStorageRoot: string,
  expectedFileIdentity?: AgySqliteFileIdentity,
  expectedWalIdentity?: AgySqliteFileIdentity | null,
): { rawHash: string; rawBytes: number } {
  if (realpathSync(originalStorageRoot) !== canonicalRoot) {
    throw new Error('Antigravity storage root changed during digest computation.')
  }
  const view = openAnchoredLockedSqliteView(canonicalRoot, ['conversations'], `${sessionId}.db`, {
    acquireSharedLock: true,
    openWal: true,
    openShm: true,
    checkJournal: true,
  })
  try {
    if (expectedFileIdentity && !identitiesExactMatch(view.fileIdentity, expectedFileIdentity)) {
      throw new Error('Antigravity database file changed while opening physical digest.')
    }
    if (expectedWalIdentity !== undefined) {
      const walMatches =
        (expectedWalIdentity === null && view.walIdentity === null) ||
        (expectedWalIdentity !== null &&
          view.walIdentity !== null &&
          identitiesExactMatch(view.walIdentity, expectedWalIdentity))
      if (!walMatches) {
        throw new Error('Antigravity WAL file changed while opening physical digest.')
      }
    }
    if (view.hasJournal) {
      throw new AgyHotRollbackJournalError(
        `Antigravity SQLite rollback journal (${sessionId}.db-journal) is present during physical digest.`,
      )
    }
    const readShmHeader = (): Buffer => {
      try {
        return view.readShmAt(0, SQLITE_WAL_INDEX_HEADER_BYTES)
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ERR_UNEXPECTED_EOF') {
          throw new AgyTransientIdentityChurnError(
            'Antigravity SQLite wal-index header truncated during physical digest.',
          )
        }
        throw error
      }
    }
    let shmBefore: Buffer | undefined
    if (view.hasShm) {
      if (view.shmByteLength < SQLITE_WAL_INDEX_HEADER_BYTES) {
        throw new AgyTransientIdentityChurnError(
          'Antigravity SQLite wal-index file is still initializing during physical digest.',
        )
      }
      shmBefore = readShmHeader()
    }
    const hasher = createHash('sha256')
    hasher.update('pact-agy-sqlite-physical-v1\0')
    let totalBytes = 0
    const chunkSize = 64 * 1024

    const hashStream = (
      targetBytes: number,
      readFn: (off: number, len: number) => Buffer,
    ): void => {
      if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
        throw new Error('Antigravity database file size exceeds safe integer bounds.')
      }
      let offset = 0
      while (offset < targetBytes) {
        const toRead = Math.min(chunkSize, targetBytes - offset)
        const buf = readFn(offset, toRead)
        offset += buf.byteLength
        totalBytes += buf.byteLength
        if (totalBytes > AGY_MAX_HISTORY_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity trajectory database exceeds its 32 MiB budget.',
            false,
          )
        }
        hasher.update(buf)
      }
      if (offset !== targetBytes) {
        throw new Error('Antigravity database read ended before expected EOF.')
      }
    }

    hasher.update('main\0')
    hashStream(view.byteLength, (off, len) => view.readAt(off, len))
    if (view.hasWal && view.walByteLength > 0) {
      hasher.update('\0wal\0')
      hashStream(view.walByteLength, (off, len) => view.readWalAt(off, len))
    }
    const verify = view.verifyUnchanged()
    if (!verify.unchanged) {
      if (verify.reason === 'journal_appeared') {
        throw new AgyHotRollbackJournalError(
          'Antigravity SQLite rollback journal appeared during physical digest.',
        )
      }
      throw new AgyTransientIdentityChurnError(
        `Antigravity database changed while computing physical digest (${verify.reason ?? 'unknown'}).`,
      )
    }
    if (shmBefore !== undefined) {
      const shmAfter = readShmHeader()
      if (!shmAfter.equals(shmBefore)) {
        throw new AgyTransientIdentityChurnError(
          'Antigravity SQLite wal-index header changed during physical digest.',
        )
      }
    }
    if (realpathSync(originalStorageRoot) !== canonicalRoot) {
      throw new Error('Antigravity storage root changed during digest computation.')
    }
    return { rawHash: hasher.digest('hex'), rawBytes: totalBytes }
  } finally {
    view.close()
  }
}

interface SqliteMasterRow {
  name: string
  type: string
  sql: string | null
}

interface ValidatedTrajectorySchema {
  tables: Map<string, SqliteMasterRow>
  indexes: SqliteMasterRow[]
  stepColumns: string[]
  stepPayloadColumn: 'step_payload' | 'data'
  hasStepFormatColumn: boolean
  genColumns: string[]
  execColumns: string[]
  metaColumns: string[]
  trajectoryId: string
  cascadeId: string
  stepFormat: number
  metaRow: Record<string, unknown>
  trajectoryMetadataRows: Array<Record<string, unknown>>
}

function requireBufferField(row: Record<string, unknown>, field: string): Buffer {
  const value = row[field]
  if (!Buffer.isBuffer(value)) {
    throw new Error(`Expected SQLite BLOB Buffer in column "${field}".`)
  }
  return value
}

function optionalBufferField(row: Record<string, unknown>, field: string): Buffer | null {
  const value = row[field]
  if (value === null || value === undefined) return null
  if (!Buffer.isBuffer(value)) {
    throw new Error(`Expected nullable SQLite BLOB Buffer in column "${field}".`)
  }
  return value
}

interface TableXColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
  hidden: number
}

function readTableColumns(db: Database.Database, tableName: string): string[] {
  const rows = db
    .prepare<[], TableXColumnInfo>(`PRAGMA table_xinfo(${quoteSqlIdentifier(tableName)})`)
    .all()
  const names: string[] = []
  for (const row of rows) {
    if (row.hidden !== 0) {
      throw new Error(
        `Unsupported generated or hidden column (${row.name}) in Antigravity table ${tableName}.`,
      )
    }
    quoteSqlIdentifier(row.name)
    names.push(row.name)
  }
  return names
}

function assertProofHasOrdinaryTables(
  proof: AgyPreScannedSqliteProof,
  requiredTables: readonly string[],
): void {
  for (const entry of proof.tables.values()) {
    if (entry.name.startsWith('sqlite_')) continue
    if (entry.isVirtual || entry.rootPage < 2) {
      throw new Error(`Unsupported virtual SQLite table (${entry.name}) in Antigravity trajectory.`)
    }
  }
  for (const tableName of requiredTables) {
    const entry = proof.tables.get(tableName)
    if (!entry || entry.isVirtual || entry.rootPage < 2) {
      throw new Error(`Missing required Antigravity table: ${tableName}.`)
    }
  }
}

function measureTableColumnsTotalBytes(
  db: Database.Database,
  tableName: string,
  columns: readonly string[],
  whereClause?: { readonly sql: string; readonly params: readonly unknown[] },
): number {
  if (columns.length === 0) return 0
  const expr = columns
    .map((col) => `COALESCE(octet_length(${quoteSqlIdentifier(col)}), 0)`)
    .join(' + ')
  const sql = whereClause
    ? `SELECT COALESCE(SUM(${expr}), 0) AS totalBytes FROM ${quoteSqlIdentifier(tableName)} WHERE ${whereClause.sql}`
    : `SELECT COALESCE(SUM(${expr}), 0) AS totalBytes FROM ${quoteSqlIdentifier(tableName)}`
  const stmt = db.prepare<unknown[], { totalBytes: number | bigint | null }>(sql)
  const row = whereClause ? stmt.get(...whereClause.params) : stmt.get()
  const raw = row?.totalBytes ?? 0
  const bytes = typeof raw === 'bigint' ? Number(raw) : raw
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return bytes
}

interface BoundedTableXInfoRow {
  name: string
  hidden: number
}

const MAX_FALLBACK_VDBE_OPS = 160
const ALLOWED_FALLBACK_SCALAR_FUNCTIONS = new Set(['typeof(1)', 'octet_length(1)'])
const ALLOWED_FALLBACK_AGG_FUNCTIONS = new Set(['count(0)', 'sum(1)', 'max(1)'])
const DISALLOWED_FALLBACK_VDBE_OPCODES = new Set([
  'Concat',
  'Cast',
  'Blob',
  'SorterOpen',
  'OpenEphemeral',
  'OpenAutoindex',
  'MakeRecord',
  'RealAffinity',
  'VOpen',
  'VFilter',
  'VColumn',
  'VNext',
  'VBegin',
  'VCreate',
  'VDestroy',
  'VUpdate',
  'VRename',
])
const CONDITIONAL_GUARD_JUMP_OPCODES = new Set(['Lt', 'Gt', 'Le', 'Ge', 'Ne'])
const SQLITE_OPFLAG_LENGTHARG = 0x40
const SQLITE_OPFLAG_TYPEOFARG = 0x80
const SQLITE_OPFLAG_BYTELENARG = SQLITE_OPFLAG_LENGTHARG | SQLITE_OPFLAG_TYPEOFARG

export interface SqliteExplainRow {
  readonly addr: number
  readonly opcode: string
  readonly p1: number
  readonly p2: number
  readonly p3: number
  readonly p4: unknown
  readonly p5: number
}

function quoteArbitrarySqlIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.length > 256 || hasNonPrintableAscii(identifier)) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity SQLite identifier exceeds safe bounded inspection rules.',
    )
  }
  return `"${identifier.replaceAll('"', '""')}"`
}

function readBoundedIdentityTableColumns(
  db: Database.Database,
  tableName: 'trajectory_meta' | 'steps',
  requiredColumns: readonly string[],
): Map<string, number> {
  const placeholders = requiredColumns.map(() => '?').join(', ')
  const rows = db
    .prepare<string[], BoundedTableXInfoRow>(
      `SELECT name, hidden FROM pragma_table_xinfo(?) WHERE hidden IN (0, 2, 3) AND name IN (${placeholders})`,
    )
    .all(tableName, ...requiredColumns)
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row.name, row.hidden)
  }
  return result
}

function findStoredTableColumnName(
  db: Database.Database,
  tableName: 'trajectory_meta' | 'steps',
  candidateName: string,
): string | undefined {
  const row = db
    .prepare<[string, string], BoundedTableXInfoRow>(
      `SELECT name, hidden FROM pragma_table_xinfo(?) WHERE hidden IN (0, 3) AND lower(name) = lower(?) LIMIT 1`,
    )
    .get(tableName, candidateName)
  return row?.name
}

export function verifyBoundedFallbackVdbeOps(
  ops: readonly SqliteExplainRow[],
  options?: { readonly allowGuardedVirtualEval?: boolean },
): void {
  if (ops.length === 0 || ops.length > MAX_FALLBACK_VDBE_OPS) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity fallback SQLite query plan exceeded bounded instruction limit.',
    )
  }
  const verifiedGuardRanges: Array<{
    readonly cursor: number
    readonly colIdx: number
    readonly fromAddr: number
    readonly untilAddr: number
  }> = []

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!
    if (DISALLOWED_FALLBACK_VDBE_OPCODES.has(op.opcode)) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity fallback SQLite query plan uses unbounded opcode (${op.opcode}).`,
      )
    }
    if (op.opcode === 'Function' || op.opcode === 'PureFunc') {
      if (typeof op.p4 !== 'string' || !ALLOWED_FALLBACK_SCALAR_FUNCTIONS.has(op.p4)) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan invokes an unbounded scalar function.',
        )
      }
      const isOctetLength = op.p4 === 'octet_length(1)'
      const argReg = op.p2
      const prev = i > 0 ? ops[i - 1] : undefined
      let provenMetadataOnly = false
      let metadataSource: { readonly cursor: number; readonly colIdx: number } | undefined

      const columnFlagsProven = (p5: number): boolean =>
        isOctetLength
          ? (p5 & SQLITE_OPFLAG_BYTELENARG) === SQLITE_OPFLAG_BYTELENARG
          : (p5 & SQLITE_OPFLAG_TYPEOFARG) === SQLITE_OPFLAG_TYPEOFARG

      if (prev && prev.opcode === 'Rowid' && prev.p2 === argReg) {
        provenMetadataOnly = true
      } else if (
        prev &&
        prev.opcode === 'Column' &&
        prev.p3 === argReg &&
        columnFlagsProven(prev.p5)
      ) {
        provenMetadataOnly = true
        metadataSource = { cursor: prev.p1, colIdx: prev.p2 }
      } else if (
        options?.allowGuardedVirtualEval &&
        i >= 3 &&
        prev &&
        prev.opcode === 'Affinity' &&
        prev.p1 === argReg &&
        prev.p2 === 1
      ) {
        const producer = ops[i - 2]!
        const guardNullRow = ops[i - 3]!
        if (producer.opcode === 'Rowid' && producer.p2 === argReg) {
          provenMetadataOnly = true
        } else if (
          producer.opcode === 'Column' &&
          producer.p3 === argReg &&
          guardNullRow.opcode === 'IfNullRow' &&
          guardNullRow.p1 === producer.p1 &&
          guardNullRow.p2 === op.addr &&
          verifiedGuardRanges.some(
            (range) =>
              range.cursor === producer.p1 &&
              range.colIdx === producer.p2 &&
              range.fromAddr < guardNullRow.addr &&
              range.untilAddr > op.addr,
          )
        ) {
          provenMetadataOnly = true
        }
      }

      if (!provenMetadataOnly) {
        throw new AgyIdentityBudgetExceededError(
          `Antigravity fallback SQLite query plan cannot prove metadata-only column access before ${op.p4}.`,
        )
      }

      if (metadataSource !== undefined) {
        for (let j = i + 1; j < Math.min(ops.length, i + 4); j += 1) {
          const jumpOp = ops[j]!
          if (!CONDITIONAL_GUARD_JUMP_OPCODES.has(jumpOp.opcode)) break
          if (jumpOp.p2 > op.addr) {
            verifiedGuardRanges.push({
              cursor: metadataSource.cursor,
              colIdx: metadataSource.colIdx,
              fromAddr: op.addr,
              untilAddr: jumpOp.p2,
            })
          }
        }
      }
    } else if (op.opcode === 'AggStep' || op.opcode === 'AggStep1' || op.opcode === 'AggFinal') {
      if (typeof op.p4 !== 'string' || !ALLOWED_FALLBACK_AGG_FUNCTIONS.has(op.p4)) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan invokes an unbounded aggregate function.',
        )
      }
    } else if (op.opcode === 'String8') {
      if (typeof op.p4 === 'string' && Buffer.byteLength(op.p4, 'utf8') > 1024) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan embeds an oversized string literal.',
        )
      }
    }
  }
}

function readBoundedExplainOps(db: Database.Database, sql: string): SqliteExplainRow[] {
  const stmt = db.prepare<[], SqliteExplainRow>(`EXPLAIN ${sql}`)
  const ops: SqliteExplainRow[] = []
  for (const op of stmt.iterate()) {
    ops.push(op)
    if (ops.length > MAX_FALLBACK_VDBE_OPS) {
      break
    }
  }
  return ops
}

function assertBoundedFallbackQueryPlan(
  db: Database.Database,
  sql: string,
  options?: { readonly allowGuardedVirtualEval?: boolean },
): void {
  const ops = readBoundedExplainOps(db, sql)
  verifyBoundedFallbackVdbeOps(ops, options)
}

function validateTrajectoryDatabase(
  db: Database.Database,
  expectedSessionId: string,
  proof?: AgyPreScannedSqliteProof,
): ValidatedTrajectorySchema {
  if (proof) {
    assertProofHasOrdinaryTables(proof, REQUIRED_TRAJECTORY_TABLES)
  }

  const masterRows = db
    .prepare<[], SqliteMasterRow & { rootpage: number }>(
      `SELECT name, type, rootpage, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND substr(name, 1, 7) != 'sqlite_' ORDER BY type DESC, name ASC`,
    )
    .all()

  const tables = new Map<string, SqliteMasterRow>()
  const indexes: SqliteMasterRow[] = []
  for (const row of masterRows) {
    if (row.type === 'view' || row.type === 'trigger') {
      throw new Error(`Unsupported SQLite ${row.type} (${row.name}) in Antigravity trajectory.`)
    }
    if (row.type === 'table') {
      if (row.rootpage === 0 || (row.sql && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(row.sql))) {
        throw new Error(`Unsupported virtual SQLite table (${row.name}) in Antigravity trajectory.`)
      }
      quoteSqlIdentifier(row.name)
      tables.set(row.name, row)
    } else if (row.type === 'index' && row.sql) {
      indexes.push(row)
    }
  }

  for (const required of REQUIRED_TRAJECTORY_TABLES) {
    if (!tables.has(required)) {
      throw new Error(`Missing required Antigravity table: ${required}.`)
    }
  }

  for (const tableName of tables.keys()) {
    if (KNOWN_TRAJECTORY_TABLES.has(tableName)) continue
    const countRow = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(tableName)}`,
      )
      .get()
    if (!countRow || countRow.count > 0) {
      throw new Error(
        `Unsupported non-empty Antigravity table (${tableName}) prevents safe trajectory closure.`,
      )
    }
  }

  for (const closedEmptyTable of ['parent_references', 'battle_mode_infos'] as const) {
    if (!tables.has(closedEmptyTable)) continue
    const countRow = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(closedEmptyTable)}`,
      )
      .get()
    if (!countRow || countRow.count > 0) {
      throw new Error(
        `Antigravity trajectory has unclosed rows in ${closedEmptyTable}; failing closed.`,
      )
    }
  }

  const metaColumns = readTableColumns(db, 'trajectory_meta')
  if (!metaColumns.includes('trajectory_id') || !metaColumns.includes('cascade_id')) {
    throw new Error('Antigravity trajectory_meta is missing trajectory_id or cascade_id columns.')
  }
  const metaRowCount = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "trajectory_meta"')
    .get()
  if (!metaRowCount || metaRowCount.count !== 1) {
    throw new Error('Antigravity trajectory_meta must contain exactly one row.')
  }
  if (measureTableColumnsTotalBytes(db, 'trajectory_meta', metaColumns) > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity trajectory_meta exceeds 8 MiB.',
      false,
    )
  }
  const metaSelectList = metaColumns.map(quoteSqlIdentifier).join(', ')
  const metaRows = db
    .prepare<[], Record<string, unknown>>(`SELECT ${metaSelectList} FROM "trajectory_meta" LIMIT 2`)
    .all()
  if (metaRows.length !== 1) {
    throw new Error('Antigravity trajectory_meta must contain exactly one row.')
  }
  const metaRow = metaRows[0]!
  const trajectoryId = metaRow['trajectory_id']
  const cascadeId = metaRow['cascade_id']
  const rawStepFormat = metaRow['step_format'] ?? 0
  if (
    typeof trajectoryId !== 'string' ||
    !SAFE_ID_PATTERN.test(trajectoryId) ||
    typeof cascadeId !== 'string' ||
    cascadeId !== expectedSessionId ||
    typeof rawStepFormat !== 'number' ||
    !Number.isSafeInteger(rawStepFormat) ||
    rawStepFormat !== 0
  ) {
    throw new Error('Antigravity trajectory_meta identity or step_format is incompatible.')
  }

  const stepColumns = readTableColumns(db, 'steps')
  for (const requiredCol of ['idx', 'step_type', 'status', 'has_subtrajectory', 'metadata']) {
    if (!stepColumns.includes(requiredCol)) {
      throw new Error(`Antigravity steps table is missing required column: ${requiredCol}.`)
    }
  }
  const stepPayloadColumn: 'step_payload' | 'data' | undefined = stepColumns.includes(
    'step_payload',
  )
    ? 'step_payload'
    : stepColumns.includes('data')
      ? 'data'
      : undefined
  if (!stepPayloadColumn) {
    throw new Error('Antigravity steps table is missing required column: step_payload.')
  }
  const hasStepFormatColumn = stepColumns.includes('step_format')
  const genColumns = readTableColumns(db, 'gen_metadata')
  for (const requiredCol of ['idx', 'data']) {
    if (!genColumns.includes(requiredCol)) {
      throw new Error(`Antigravity gen_metadata table is missing required column: ${requiredCol}.`)
    }
  }
  const execColumns = readTableColumns(db, 'executor_metadata')
  for (const requiredCol of ['idx', 'data']) {
    if (!execColumns.includes(requiredCol)) {
      throw new Error(
        `Antigravity executor_metadata table is missing required column: ${requiredCol}.`,
      )
    }
  }

  let trajectoryMetadataRows: Array<Record<string, unknown>> = []
  if (tables.has('trajectory_metadata_blob')) {
    const blobColumns = readTableColumns(db, 'trajectory_metadata_blob')
    const blobCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "trajectory_metadata_blob"')
      .get()
    if (blobCountRow && blobCountRow.count > 1) {
      throw new Error('Antigravity trajectory_metadata_blob has multiple rows.')
    }
    if (blobCountRow && blobCountRow.count === 1) {
      if (
        measureTableColumnsTotalBytes(db, 'trajectory_metadata_blob', blobColumns) >
        AGY_TEXT_BUDGET_BYTES
      ) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity trajectory_metadata_blob exceeds 8 MiB.',
          false,
        )
      }
      const blobSelectList = blobColumns.map(quoteSqlIdentifier).join(', ')
      trajectoryMetadataRows = db
        .prepare<[], Record<string, unknown>>(
          `SELECT ${blobSelectList} FROM "trajectory_metadata_blob" LIMIT 2`,
        )
        .all()
    }
    if (trajectoryMetadataRows.length > 1) {
      throw new Error('Antigravity trajectory_metadata_blob has multiple rows.')
    }
    if (trajectoryMetadataRows.length === 1) {
      const dataBlob = trajectoryMetadataRows[0]!['data']
      if (dataBlob != null) {
        if (!Buffer.isBuffer(dataBlob)) {
          throw new Error('Antigravity trajectory_metadata_blob.data must be a BLOB.')
        }
        if (dataBlob.length > AGY_TEXT_BUDGET_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity trajectory_metadata_blob exceeds 8 MiB.',
            false,
          )
        }
        const decodedMeta = decodeCortexTrajectoryMetadata(dataBlob)
        if (
          (decodedMeta.parentConversationId && decodedMeta.parentConversationId.length > 0) ||
          decodedMeta.hasSubagentSpec ||
          decodedMeta.isBattleModeFork ||
          decodedMeta.nestingDepth !== 0 ||
          (decodedMeta.rootConversationId &&
            decodedMeta.rootConversationId.length > 0 &&
            decodedMeta.rootConversationId !== expectedSessionId)
        ) {
          throw new Error(
            'Antigravity trajectory_metadata_blob contains unclosed parent, battle, or subagent lineage.',
          )
        }
      }
    }
  }

  return {
    tables,
    indexes,
    stepColumns,
    stepPayloadColumn,
    hasStepFormatColumn,
    genColumns,
    execColumns,
    metaColumns,
    trajectoryId,
    cascadeId,
    stepFormat: rawStepFormat,
    metaRow,
    trajectoryMetadataRows,
  }
}

interface ExtractedPactPromptIdentity {
  messageId?: string
  pactRunId?: string
}

function parsePactPromptContextCandidate(
  candidate: string,
): ExtractedPactPromptIdentity | undefined {
  if (!candidate.startsWith('{') || candidate.length > AGY_TEXT_BUDGET_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (!isPlainObject(parsed) || parsed['version'] !== 'pact-agent-prompt-v1') return undefined
    const rawMsgId = parsed['messageId']
    const rawRunId = parsed['pactRunId']
    const messageId =
      typeof rawMsgId === 'string' && UUID_PATTERN.test(rawMsgId) ? rawMsgId : undefined
    const pactRunId =
      typeof rawRunId === 'string' && SAFE_ID_PATTERN.test(rawRunId) ? rawRunId : undefined
    if (rawRunId !== undefined && pactRunId === undefined) return undefined
    if (!messageId && !pactRunId) return undefined
    return {
      ...(messageId ? { messageId } : {}),
      ...(pactRunId ? { pactRunId } : {}),
    }
  } catch {
    return undefined
  }
}

function extractPactPromptIdentity(userText: string): ExtractedPactPromptIdentity {
  const candidates: string[] = []
  const markerIndex = userText.lastIndexOf('\n{"')
  candidates.push(markerIndex >= 0 ? userText.slice(markerIndex + 1).trim() : userText.trim())

  const contextHeaderIndex = userText.lastIndexOf('Pact context (JSON reference data;')
  if (contextHeaderIndex >= 0) {
    const lineStart = userText.indexOf('\n', contextHeaderIndex)
    if (lineStart >= 0) {
      const lineEnd = userText.indexOf('\n', lineStart + 1)
      const contextLine = (
        lineEnd >= 0 ? userText.slice(lineStart + 1, lineEnd) : userText.slice(lineStart + 1)
      ).trim()
      if (contextLine.startsWith('{') && !candidates.includes(contextLine)) {
        candidates.push(contextLine)
      }
    }
  }

  let messageId: string | undefined
  let pactRunId: string | undefined
  for (const candidate of candidates) {
    const parsed = parsePactPromptContextCandidate(candidate)
    if (!parsed) continue
    if (parsed.messageId) {
      if (messageId && messageId !== parsed.messageId) {
        throw new Error('Antigravity user input contains conflicting Pact messageId envelopes.')
      }
      messageId = parsed.messageId
    }
    if (parsed.pactRunId) {
      if (pactRunId && pactRunId !== parsed.pactRunId) {
        throw new Error('Antigravity user input contains conflicting Pact pactRunId envelopes.')
      }
      pactRunId = parsed.pactRunId
    }
  }

  return {
    ...(messageId ? { messageId } : {}),
    ...(pactRunId ? { pactRunId } : {}),
  }
}

function assertCompatibleStepRowFormat(
  stepFormatValue: unknown,
  hasStepFormatColumn: boolean,
  stepIdx: number,
): void {
  if (!hasStepFormatColumn) return
  if (
    typeof stepFormatValue !== 'number' ||
    !Number.isSafeInteger(stepFormatValue) ||
    stepFormatValue !== 0
  ) {
    throw new Error(
      `Antigravity step ${stepIdx} has unsupported step_format (${String(stepFormatValue)}).`,
    )
  }
}

function extractEffectiveStepMetadata(
  rowMetadata: Buffer | null,
  decodedStep: DecodedAgyStep,
): DecodedCortexStepMetadata {
  const columnMeta =
    rowMetadata && rowMetadata.length > 0 ? decodeCortexStepMetadata(rowMetadata) : undefined
  const stepMeta = decodedStep.metadata
  if (!columnMeta && !stepMeta) {
    throw new Error('Antigravity step is missing CortexStepMetadata.')
  }
  if (
    columnMeta?.executionId &&
    stepMeta?.executionId &&
    columnMeta.executionId !== stepMeta.executionId
  ) {
    throw new Error('Antigravity step column metadata and payload metadata execution_id disagree.')
  }
  if (columnMeta?.stepId && stepMeta?.stepId && columnMeta.stepId !== stepMeta.stepId) {
    throw new Error('Antigravity step column metadata and payload metadata step_id disagree.')
  }
  const executionId = columnMeta?.executionId ?? stepMeta?.executionId
  const stepId = columnMeta?.stepId ?? stepMeta?.stepId
  const sourceTrajectoryStepInfo =
    columnMeta?.sourceTrajectoryStepInfo ?? stepMeta?.sourceTrajectoryStepInfo
  const toolCall = stepMeta?.toolCall ?? columnMeta?.toolCall
  const modifiedToolCall = stepMeta?.modifiedToolCall ?? columnMeta?.modifiedToolCall
  const createdAt = columnMeta?.createdAt ?? stepMeta?.createdAt
  const source = columnMeta?.source ?? stepMeta?.source
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    ...(sourceTrajectoryStepInfo !== undefined ? { sourceTrajectoryStepInfo } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
    ...(modifiedToolCall !== undefined ? { modifiedToolCall } : {}),
  }
}

interface ParsedArtifactStepOp {
  stepIndex: number
  executionId: string
  nativeId: string
  toolName: 'write_file' | 'edit_file'
  filePath: string
  hasArtifactMetadata: boolean
  completed: boolean
  content?: string
  append?: boolean
  target?: string
  replacement?: string
}

function resolveBrainMarkdownPath(
  rawPathOrUri: string,
  canonicalAppDataDir: string,
  sessionId: string,
  configuredAppDataDir?: string,
): string | undefined {
  const parsedPath = parseLocalFileUriOrPath(rawPathOrUri)
  if (!parsedPath) return undefined
  const resolvedCandidate = resolve(parsedPath.rawPath)
  const dir = dirname(resolvedCandidate)
  const name = basename(resolvedCandidate)
  if (
    !name.toLowerCase().endsWith('.md') ||
    name.startsWith('.') ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    return undefined
  }
  const allowedRoots = collectAllowedAppDataRoots(canonicalAppDataDir, configuredAppDataDir)
  const matchesSessionBrainLexically = allowedRoots.some(
    (root) => dir === join(root, 'brain', sessionId),
  )
  if (!matchesSessionBrainLexically) {
    return undefined
  }
  // Always walk and lstat + realpath-verify brain/<sessionId> (never skipping via lexical shortcut).
  const verifiedBrain = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sessionId],
    'Antigravity brain',
  )
  if (!verifiedBrain.exists) return undefined
  return join(verifiedBrain.canonicalDir, name)
}

function parseArtifactOperationFromStep(
  stepIndex: number,
  rowStatus: number,
  decodedStep: DecodedAgyStep,
  meta: DecodedCortexStepMetadata,
  canonicalAppDataDir: string,
  sessionId: string,
  configuredAppDataDir?: string,
): ParsedArtifactStepOp | undefined {
  const call = meta.modifiedToolCall ?? meta.toolCall
  let toolName: string | undefined = call?.name
  let argsRecord: Record<string, unknown> | undefined

  if (call?.argumentsJson) {
    try {
      const parsed: unknown = JSON.parse(call.argumentsJson)
      if (isPlainObject(parsed)) argsRecord = parsed
    } catch {
      return undefined
    }
  } else if (decodedStep.genericArgs && decodedStep.genericArgs.size > 0) {
    const entries: Record<string, unknown> = {}
    for (const [key, value] of decodedStep.genericArgs) {
      entries[key] = value
    }
    if ('Content' in entries || 'content' in entries) toolName ??= 'write_file'
    else if ('Replacement' in entries || 'Target' in entries) toolName ??= 'edit_file'
    argsRecord = entries
  }

  if (toolName !== 'write_file' && toolName !== 'edit_file') return undefined
  const rawPath =
    (typeof argsRecord?.['Path'] === 'string' ? argsRecord['Path'] : undefined) ??
    (typeof argsRecord?.['path'] === 'string' ? argsRecord['path'] : undefined) ??
    (typeof argsRecord?.['TargetFile'] === 'string' ? argsRecord['TargetFile'] : undefined) ??
    (typeof argsRecord?.['targetFile'] === 'string' ? argsRecord['targetFile'] : undefined) ??
    decodedStep.writeToFileUri
  if (!rawPath) return undefined

  const resolvedBrainMd = resolveBrainMarkdownPath(
    rawPath,
    canonicalAppDataDir,
    sessionId,
    configuredAppDataDir,
  )
  if (!resolvedBrainMd) return undefined

  const rawArtifactMeta =
    argsRecord?.['ArtifactMetadata'] ??
    argsRecord?.['artifactMetadata'] ??
    argsRecord?.['artifact_metadata']
  let hasArtifactMetadata = isPlainObject(rawArtifactMeta)
  if (
    !hasArtifactMetadata &&
    typeof rawArtifactMeta === 'string' &&
    rawArtifactMeta.trim().startsWith('{')
  ) {
    try {
      hasArtifactMetadata = isPlainObject(JSON.parse(rawArtifactMeta))
    } catch {
      hasArtifactMetadata = false
    }
  }

  const completed =
    rowStatus === CORTEX_STEP_STATUS_DONE &&
    decodedStep.status === CORTEX_STEP_STATUS_DONE &&
    !decodedStep.hasError &&
    !decodedStep.genericHasError

  const rawPlanSuffixId = call?.id || meta.stepId || `step:${stepIndex}`
  const nativeId = buildBoundedNativePlanId(sessionId, rawPlanSuffixId)
  const content =
    typeof argsRecord?.['Content'] === 'string'
      ? argsRecord['Content']
      : typeof argsRecord?.['content'] === 'string'
        ? argsRecord['content']
        : undefined
  const append =
    argsRecord?.['Append'] === true ||
    argsRecord?.['append'] === true ||
    argsRecord?.['Append'] === 'true'
  const target =
    typeof argsRecord?.['Target'] === 'string'
      ? argsRecord['Target']
      : typeof argsRecord?.['target'] === 'string'
        ? argsRecord['target']
        : typeof argsRecord?.['TargetContent'] === 'string'
          ? argsRecord['TargetContent']
          : typeof argsRecord?.['targetContent'] === 'string'
            ? argsRecord['targetContent']
            : undefined
  const replacement =
    typeof argsRecord?.['Replacement'] === 'string'
      ? argsRecord['Replacement']
      : typeof argsRecord?.['replacement'] === 'string'
        ? argsRecord['replacement']
        : typeof argsRecord?.['ReplacementContent'] === 'string'
          ? argsRecord['ReplacementContent']
          : typeof argsRecord?.['replacementContent'] === 'string'
            ? argsRecord['replacementContent']
            : undefined

  return {
    stepIndex,
    executionId: meta.executionId ?? '',
    nativeId,
    toolName,
    filePath: resolvedBrainMd,
    hasArtifactMetadata,
    completed,
    ...(content !== undefined ? { content } : {}),
    ...(append ? { append: true } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  }
}

function readVerifiedBrainMarkdownFile(
  filePath: string,
  canonicalAppDataDir: string,
  sessionId: string,
): string {
  const verifiedBrainBefore = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sessionId],
    'Antigravity brain',
  )
  if (!verifiedBrainBefore.exists) {
    throw Object.assign(new Error('Antigravity session brain directory is missing.'), {
      code: 'ENOENT',
    })
  }
  const leafName = basename(filePath)
  const expectedPath = join(verifiedBrainBefore.canonicalDir, leafName)
  if (
    resolve(filePath) !== expectedPath ||
    leafName === '.' ||
    leafName === '..' ||
    leafName.includes('/') ||
    leafName.includes('\\')
  ) {
    throw new Error('Antigravity plan artifact escaped its pinned session brain directory.')
  }
  const before = lstatSync(expectedPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('Antigravity plan artifact is linked or not an ordinary file.')
  }
  if (before.size > BigInt(AGY_TEXT_BUDGET_BYTES)) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity plan artifact exceeds its 8 MiB read budget.',
      false,
    )
  }
  const canonicalPath = realpathSync(expectedPath)
  if (
    canonicalPath !== expectedPath ||
    !isInsideDirectory(verifiedBrainBefore.canonicalDir, canonicalPath)
  ) {
    throw new Error('Antigravity plan artifact escaped its pinned session brain directory.')
  }
  const fd = openSync(expectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    const verifiedBrainAfter = verifySafeDirectoryChainIfPresent(
      canonicalAppDataDir,
      ['brain', sessionId],
      'Antigravity brain',
    )
    if (
      !verifiedBrainAfter.exists ||
      verifiedBrainAfter.canonicalDir !== verifiedBrainBefore.canonicalDir ||
      verifiedBrainAfter.stat.dev !== verifiedBrainBefore.stat.dev ||
      verifiedBrainAfter.stat.ino !== verifiedBrainBefore.stat.ino ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !statsMatch(before, opened) ||
      realpathSync(expectedPath) !== expectedPath
    ) {
      throw new Error('Antigravity plan artifact changed while opening.')
    }
    const bytes = readExactBoundedBytesFromFd(fd, Number(opened.size))
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(expectedPath, { bigint: true })
    if (
      BigInt(bytes.byteLength) !== before.size ||
      !statsMatch(before, after) ||
      !statsMatch(before, namedAfter)
    ) {
      throw new Error('Antigravity plan artifact changed during inspection.')
    }
    return decodeUtf8Strict(bytes)
  } finally {
    closeSync(fd)
  }
}

function evaluateColdPlanArtifact(
  ops: readonly ParsedArtifactStepOp[],
  targetExecutionId: string,
  canonicalAppDataDir: string,
  sessionId: string,
): { plan?: { nativeId: string; text: string }; planUnavailable?: true } {
  const boundPaths = new Set<string>()
  const simulatedBodies = new Map<string, { text: string; byteLength: number; complete: boolean }>()

  const targetOps: ParsedArtifactStepOp[] = []
  const postTargetTouchedPaths = new Set<string>()
  let seenTargetExecution = false

  for (const op of ops) {
    const isTarget = op.executionId === targetExecutionId
    if (isTarget) seenTargetExecution = true

    const bindsArtifact =
      op.hasArtifactMetadata ||
      boundPaths.has(op.filePath) ||
      (op.toolName === 'edit_file' &&
        basename(op.filePath).toLowerCase() === 'implementation_plan.md')
    if (!bindsArtifact) continue
    boundPaths.add(op.filePath)

    if (seenTargetExecution && !isTarget) {
      postTargetTouchedPaths.add(op.filePath)
      continue
    }

    if (isTarget) targetOps.push(op)

    if (!op.completed) {
      simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      continue
    }

    if (op.toolName === 'write_file') {
      if (op.content === undefined) {
        simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      } else if (op.append) {
        const previous = simulatedBodies.get(op.filePath)
        const contentBytes = Buffer.byteLength(op.content, 'utf8')
        if (
          !previous ||
          !previous.complete ||
          previous.byteLength + contentBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
        ) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          const nextText = `${previous.text}${op.content}`
          const nextBytes = Buffer.byteLength(nextText, 'utf8')
          if (nextBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
            simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
          } else {
            simulatedBodies.set(op.filePath, {
              text: nextText,
              byteLength: nextBytes,
              complete: true,
            })
          }
        }
      } else {
        const contentBytes = Buffer.byteLength(op.content, 'utf8')
        if (contentBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          simulatedBodies.set(op.filePath, {
            text: op.content,
            byteLength: contentBytes,
            complete: true,
          })
        }
      }
    } else {
      const previous = simulatedBodies.get(op.filePath)
      if (!previous || !previous.complete || !op.target || op.replacement === undefined) {
        simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      } else {
        let matchCount = 0
        let searchFrom = 0
        for (;;) {
          const found = previous.text.indexOf(op.target, searchFrom)
          if (found < 0) break
          matchCount += 1
          searchFrom = found + op.target.length
        }
        const targetBytes = Buffer.byteLength(op.target, 'utf8')
        const replacementBytes = Buffer.byteLength(op.replacement, 'utf8')
        const projectedBytes = previous.byteLength + matchCount * (replacementBytes - targetBytes)
        if (
          matchCount === 0 ||
          projectedBytes < 0 ||
          projectedBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
        ) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          const literalReplacement = op.replacement
          const nextText = previous.text.replaceAll(op.target, () => literalReplacement)
          const nextBytes = Buffer.byteLength(nextText, 'utf8')
          if (nextBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
            simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
          } else {
            simulatedBodies.set(op.filePath, {
              text: nextText,
              byteLength: nextBytes,
              complete: true,
            })
          }
        }
      }
    }
  }

  if (targetOps.length === 0) return {}
  if (targetOps.some((op) => !op.completed)) return { planUnavailable: true }

  const distinctTargetPaths = new Set(targetOps.map((op) => op.filePath))
  if (distinctTargetPaths.size !== 1) return { planUnavailable: true }

  const lastOp = targetOps.at(-1)!
  if (postTargetTouchedPaths.has(lastOp.filePath)) return { planUnavailable: true }

  // Require a completely replayable baseline (no partial/substring or empty-replacement bypass).
  const simulated = simulatedBodies.get(lastOp.filePath)
  if (!simulated?.complete || simulated.byteLength > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
    return { planUnavailable: true }
  }

  let diskText: string
  try {
    diskText = readVerifiedBrainMarkdownFile(lastOp.filePath, canonicalAppDataDir, sessionId)
  } catch {
    return { planUnavailable: true }
  }
  if (
    !diskText ||
    Buffer.byteLength(diskText, 'utf8') > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES ||
    diskText !== simulated.text
  ) {
    return { planUnavailable: true }
  }

  return { plan: { nativeId: lastOp.nativeId, text: diskText } }
}

const PACT_PUBLISH_PLAN_NAME_RE =
  /^(?:mcp_(pact_peer_[a-f0-9]{16,32})_|mcp__(pact_peer_[a-f0-9]{16,32})__|(pact_peer_[a-f0-9]{16,32})\/)publish_plan$/u
const MAX_PACT_PUBLISH_PLAN_RAW_ID_BYTES = 1024

function normalizePublishPlanRawId(raw: unknown): string | undefined {
  const normalized =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number' && Number.isSafeInteger(raw)
        ? String(raw)
        : ''
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > MAX_PACT_PUBLISH_PLAN_RAW_ID_BYTES
  ) {
    return undefined
  }
  return normalized
}

function extractCompletedPactPublishPlanStepCall(
  meta: DecodedCortexStepMetadata,
  rowStatus: number,
  decodedStep: DecodedAgyStep,
  columnPayloadMatches: boolean,
): { readonly call: AgyCompletedPactPublishPlanCall; readonly legacyTokens: string[] } | undefined {
  if (
    !columnPayloadMatches ||
    rowStatus !== CORTEX_STEP_STATUS_DONE ||
    decodedStep.status !== CORTEX_STEP_STATUS_DONE ||
    decodedStep.hasError ||
    decodedStep.genericHasError
  ) {
    return undefined
  }
  const call = meta.modifiedToolCall ?? meta.toolCall
  if (!call?.name) {
    return undefined
  }
  const nameMatch = PACT_PUBLISH_PLAN_NAME_RE.exec(call.name)
  const serverName = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3]
  if (!serverName) {
    return undefined
  }
  if (!call.argumentsJson) {
    return undefined
  }
  let argsRecord: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson)
    if (!isPlainObject(parsed)) return undefined
    argsRecord = parsed
  } catch {
    return undefined
  }
  const nestedMeta = argsRecord['_meta']
  const { _meta: _ignoredMeta, ...toolArgs } = argsRecord
  const parsedArgs = collaborationPublishPlanInputSchema.safeParse(toolArgs)
  if (!parsedArgs.success) {
    return undefined
  }
  const complete = parsedArgs.data.complete ?? parsedArgs.data.offset === undefined
  if (!complete) {
    return undefined
  }

  const rawCallId = normalizePublishPlanRawId(call.id)
  const rawProgressToken = isPlainObject(nestedMeta)
    ? normalizePublishPlanRawId(nestedMeta['progressToken'])
    : undefined
  const rawStepId = normalizePublishPlanRawId(meta.stepId)

  const callId =
    rawCallId !== undefined ? encodeBoundedOpenPlanCallKey(`call:${rawCallId}`) : undefined
  const progressToken =
    rawProgressToken !== undefined
      ? encodeBoundedOpenPlanProgressToken(rawProgressToken)
      : undefined
  const stepId = rawStepId !== undefined ? encodeBoundedCollaborationIdentity(rawStepId) : undefined

  const legacyTokens: string[] = []
  const pushLegacyToken = (token: string | undefined): void => {
    if (!token || legacyTokens.includes(token)) return
    legacyTokens.push(token)
  }
  if (rawCallId !== undefined) {
    pushLegacyToken(rawCallId.length <= 256 ? rawCallId : callId)
  }
  pushLegacyToken(progressToken)
  pushLegacyToken(stepId)

  return {
    call: {
      serverName,
      ...(callId !== undefined ? { callId } : {}),
      ...(progressToken !== undefined ? { progressToken } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    },
    legacyTokens,
  }
}

export function inspectAgyTrajectory(input: AgyColdInspectionInput): AgyColdInspectionResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  assertValidSessionUuid(input.nativeSessionId)
  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const defaultPath = join(configuredRoot, 'conversations', `${input.nativeSessionId}.db`)

  let canonicalRoot: string
  try {
    const rootStat = lstatSync(configuredRoot, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Antigravity native storage root must be an ordinary directory.')
    }
    canonicalRoot = realpathSync(configuredRoot)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return {
        exists: false,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: configuredRoot,
        nativePath: defaultPath,
        stepCount: 0,
      }
    }
    throw error
  }

  const dbPath = join(canonicalRoot, 'conversations', `${input.nativeSessionId}.db`)
  let snapshotHandle: CommittedSqliteSnapshotHandle
  try {
    snapshotHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (error instanceof AgyStorageMissingError) {
      return {
        exists: false,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: canonicalRoot,
        nativePath: dbPath,
        stepCount: 0,
      }
    }
    if (
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyTransientIdentityChurnError
    ) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: canonicalRoot,
        nativePath: dbPath,
        stepCount: 0,
      }
    }
    throw error
  }
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)

    const counts = db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!

    if (counts.stepCount + counts.genCount + counts.execCount > AGY_MAX_RECORDS) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity trajectory exceeds its 10,000-record inspection budget.',
        false,
      )
    }

    if (!input.nativeTurnId) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    if (!SAFE_ID_PATTERN.test(input.nativeTurnId)) {
      throw new Error('Invalid Antigravity execution_id.')
    }

    // Enforce executor_metadata BLOB budget BEFORE hydration, while streaming steps
    // per-execution instead of charging all historical turns against the 8 MiB text budget.
    const preflightExecBytes = measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightExecBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity executor_metadata exceeds read budget.',
        false,
      )
    }

    let totalExecBytes = 0
    const execStmt = db.prepare<[], { idx: number; data: Buffer }>(
      'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
    )
    const execByExecutionId = new Map<string, DecodedExecutorMetadata>()
    for (const row of execStmt.iterate()) {
      if (!Buffer.isBuffer(row.data)) throw new Error('Invalid executor_metadata.data BLOB.')
      totalExecBytes += row.data.byteLength
      if (totalExecBytes > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity executor_metadata exceeds read budget.',
          false,
        )
      }
      const decoded = decodeExecutorMetadata(row.data)
      if (decoded.executionId) {
        if (execByExecutionId.has(decoded.executionId)) {
          throw new Error('Duplicate executor_metadata rows found for execution_id.')
        }
        execByExecutionId.set(decoded.executionId, decoded)
      }
    }

    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const headerSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, metadata, typeof(${stepPayloadSql}) AS payload_type, LENGTH(${stepPayloadSql}) AS payload_len, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, metadata, typeof(${stepPayloadSql}) AS payload_type, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" ORDER BY idx ASC`
    const headerStmt = db.prepare<
      [],
      {
        idx: number
        step_type: number
        status: number
        metadata: Buffer | null
        payload_type: string
        payload_len: number | null
        step_format?: unknown
      }
    >(headerSelectSql)

    const fullStepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" WHERE idx = ?`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" WHERE idx = ?`
    const fullStepByIdxStmt = db.prepare<
      [number],
      {
        idx: number
        step_type: number
        status: number
        has_subtrajectory: number
        metadata: Buffer | null
        step_blob: Buffer | null
        step_format?: unknown
      }
    >(fullStepSelectSql)

    const artifactOps: ParsedArtifactStepOp[] = []
    let retainedArtifactOpBytes = 0
    const seenStepExecutionIds = new Set<string>()
    const stepExecutionIds: Array<string | undefined> = []
    const stepPayloadLengths: number[] = []
    const rootUserSeenExecutions = new Set<string>()
    const pactRunMatchedExecutions = new Set<string>()

    let expectedIdx = 0
    for (const row of headerStmt.iterate()) {
      if ((expectedIdx & 0x3f) === 0) {
        assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      }
      if (row.idx !== expectedIdx) {
        throw new Error('Antigravity steps table has a non-contiguous step index gap.')
      }
      assertCompatibleStepRowFormat(row.step_format, schema.hasStepFormatColumn, row.idx)
      if (
        row.payload_type !== 'blob' ||
        typeof row.payload_len !== 'number' ||
        row.payload_len < 0
      ) {
        throw new Error(
          `Antigravity step ${row.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
        )
      }
      if ((row.metadata?.byteLength ?? 0) > AGY_TEXT_BUDGET_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
          false,
        )
      }

      const columnMeta =
        row.metadata && row.metadata.length > 0 ? decodeCortexStepMetadata(row.metadata) : undefined
      const isUserInput = row.step_type === CORTEX_STEP_TYPE_USER_INPUT
      const needsPayloadMeta = !columnMeta?.executionId

      let execId: string | undefined
      if (isUserInput || needsPayloadMeta) {
        if (row.payload_len > AGY_MAX_HISTORY_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity steps exceed the 32 MiB history budget.',
            false,
          )
        }
        const bounded =
          row.payload_len > 0
            ? readBoundedStepMetadataAndUserIdentity(
                db,
                stepPayloadSql,
                row.idx,
                row.payload_len,
                isUserInput,
                { bytes: AGY_TEXT_BUDGET_BYTES },
              )
            : {}
        const payloadMeta = bounded.payloadMeta
        if (!columnMeta && !payloadMeta) {
          throw new Error('Antigravity step is missing CortexStepMetadata.')
        }
        if (
          columnMeta?.executionId &&
          payloadMeta?.executionId &&
          columnMeta.executionId !== payloadMeta.executionId
        ) {
          throw new Error(
            'Antigravity step column metadata and payload metadata execution_id disagree.',
          )
        }
        if (columnMeta?.stepId && payloadMeta?.stepId && columnMeta.stepId !== payloadMeta.stepId) {
          throw new Error('Antigravity step column metadata and payload metadata step_id disagree.')
        }
        execId = columnMeta?.executionId ?? payloadMeta?.executionId
        if (
          isUserInput &&
          bounded.stepType === CORTEX_STEP_TYPE_USER_INPUT &&
          bounded.hasUserInput
        ) {
          const pactRunId = bounded.userIdentity?.pactRunId
          if (execId && !rootUserSeenExecutions.has(execId)) {
            rootUserSeenExecutions.add(execId)
            if (pactRunId === input.nativeTurnId) {
              pactRunMatchedExecutions.add(execId)
            }
          } else if (execId && pactRunId === input.nativeTurnId) {
            throw new Error('Antigravity non-root user input unexpectedly carries root pactRunId.')
          }
        }
      } else {
        execId = columnMeta.executionId
      }

      stepExecutionIds.push(execId)
      stepPayloadLengths.push(row.payload_len)
      if (execId) {
        seenStepExecutionIds.add(execId)
      }

      if (input.includePlan) {
        const colCall = columnMeta?.modifiedToolCall ?? columnMeta?.toolCall
        let isPlanCandidate = false
        if (colCall !== undefined) {
          if (colCall.name === 'write_file' || colCall.name === 'edit_file') {
            if (!colCall.argumentsJson) {
              isPlanCandidate = true
            } else {
              let parsedArgs: unknown
              try {
                parsedArgs = JSON.parse(colCall.argumentsJson)
              } catch {
                parsedArgs = undefined
              }
              if (isPlainObject(parsedArgs)) {
                const rawPath =
                  (typeof parsedArgs['Path'] === 'string' ? parsedArgs['Path'] : undefined) ??
                  (typeof parsedArgs['path'] === 'string' ? parsedArgs['path'] : undefined) ??
                  (typeof parsedArgs['TargetFile'] === 'string'
                    ? parsedArgs['TargetFile']
                    : undefined) ??
                  (typeof parsedArgs['targetFile'] === 'string'
                    ? parsedArgs['targetFile']
                    : undefined)
                isPlanCandidate =
                  rawPath === undefined ||
                  resolveBrainMarkdownPath(
                    rawPath,
                    canonicalRoot,
                    input.nativeSessionId,
                    configuredRoot,
                  ) !== undefined
              }
            }
          }
        } else {
          isPlanCandidate =
            row.step_type !== CORTEX_STEP_TYPE_USER_INPUT &&
            row.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE
        }
        if (isPlanCandidate) {
          if (row.payload_len > AGY_MAX_HISTORY_BYTES) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity steps exceed the 32 MiB history budget.',
              false,
            )
          }
          const fullRow = fullStepByIdxStmt.get(row.idx)
          if (!fullRow || !Buffer.isBuffer(fullRow.step_blob)) {
            throw new Error(
              `Antigravity step ${row.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
            )
          }
          const decodedStep = decodeAgyStep(fullRow.step_blob)
          let stepImageBytes = 0
          if (decodedStep.userInput) {
            for (const media of decodedStep.userInput.media) {
              stepImageBytes += media.inlineData?.byteLength ?? 0
            }
          }
          if (
            fullRow.step_blob.byteLength + (fullRow.metadata?.byteLength ?? 0) - stepImageBytes >
            AGY_TEXT_BUDGET_BYTES
          ) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
              false,
            )
          }
          const columnPayloadMatches =
            decodedStep.type === fullRow.step_type && decodedStep.status === fullRow.status
          const meta = extractEffectiveStepMetadata(fullRow.metadata, decodedStep)
          if (columnPayloadMatches) {
            const parsedOp = parseArtifactOperationFromStep(
              fullRow.idx,
              fullRow.status,
              decodedStep,
              meta,
              canonicalRoot,
              input.nativeSessionId,
              configuredRoot,
            )
            if (parsedOp) {
              retainedArtifactOpBytes +=
                Buffer.byteLength(parsedOp.executionId, 'utf8') +
                Buffer.byteLength(parsedOp.nativeId, 'utf8') +
                Buffer.byteLength(parsedOp.filePath, 'utf8') +
                Buffer.byteLength(parsedOp.content ?? '', 'utf8') +
                Buffer.byteLength(parsedOp.target ?? '', 'utf8') +
                Buffer.byteLength(parsedOp.replacement ?? '', 'utf8') +
                128
              if (retainedArtifactOpBytes > AGY_TEXT_BUDGET_BYTES) {
                throw new AgentExecutionError(
                  'response_too_large',
                  'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
                  false,
                )
              }
              artifactOps.push(parsedOp)
            }
          }
        }
      }

      expectedIdx += 1
    }

    if (pactRunMatchedExecutions.size > 1) {
      throw new Error('Multiple Antigravity executions match pactRunId; failing closed.')
    }
    const directExecMatch =
      execByExecutionId.has(input.nativeTurnId) || seenStepExecutionIds.has(input.nativeTurnId)
        ? input.nativeTurnId
        : undefined
    const pactRunExecMatch =
      pactRunMatchedExecutions.size === 1 ? [...pactRunMatchedExecutions][0] : undefined
    if (directExecMatch && pactRunExecMatch && directExecMatch !== pactRunExecMatch) {
      throw new Error(
        'Antigravity trajectory has conflicting direct execution_id and pactRunId matches.',
      )
    }
    const resolvedExecutionId = directExecMatch ?? pactRunExecMatch

    if (!resolvedExecutionId) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const matchedExec = execByExecutionId.get(resolvedExecutionId)
    const lastStepIdx = matchedExec?.lastStepIdx
    const targetStepIndices: number[] = []
    for (let idx = 0; idx < expectedIdx; idx += 1) {
      if (stepExecutionIds[idx] === resolvedExecutionId || idx === lastStepIdx) {
        targetStepIndices.push(idx)
      }
    }

    const consumedInputs: AgyConsumedInputReceipt[] = []
    const plannerItems: Array<{ id: string; text: string }> = []
    let retainedPlannerBytes = 0
    let hasCompletedPactPublishPlan = false
    const completedPactPublishPlanTokens: string[] = []
    const completedPactPublishPlanCalls: AgyCompletedPactPublishPlanCall[] = []
    let seenExecutionSteps = 0
    let maxSeenExecutionStepIdx = -1
    let hasActiveStep = false
    let hasCanceledStep = false
    let hasFailedCoreStep = false
    let hasMetadataContradiction = false
    let lastStepSummary:
      | {
          readonly columnPayloadMatches: boolean
          readonly executionId: string | undefined
          readonly status: number
          readonly decodedStatus: number
          readonly hasError: boolean
          readonly genericHasError: boolean
        }
      | undefined

    for (let pos = 0; pos < targetStepIndices.length; pos += 1) {
      if ((pos & 0x3f) === 0) {
        assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      }
      const idx = targetStepIndices[pos]!
      const payloadLen = stepPayloadLengths[idx] ?? 0
      if (payloadLen > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity steps exceed the 32 MiB history budget.',
          false,
        )
      }
      const fullRow = fullStepByIdxStmt.get(idx)
      if (!fullRow || !Buffer.isBuffer(fullRow.step_blob)) {
        throw new Error(`Antigravity step ${idx} is missing its ${schema.stepPayloadColumn} BLOB.`)
      }
      const decodedStep = decodeAgyStep(fullRow.step_blob)
      let stepImageBytes = 0
      if (decodedStep.userInput) {
        for (const media of decodedStep.userInput.media) {
          stepImageBytes += media.inlineData?.byteLength ?? 0
        }
      }
      if (
        fullRow.step_blob.byteLength + (fullRow.metadata?.byteLength ?? 0) - stepImageBytes >
        AGY_TEXT_BUDGET_BYTES
      ) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
          false,
        )
      }
      const columnPayloadMatches =
        decodedStep.type === fullRow.step_type && decodedStep.status === fullRow.status
      const meta = extractEffectiveStepMetadata(fullRow.metadata, decodedStep)

      if (idx === lastStepIdx) {
        lastStepSummary = {
          columnPayloadMatches,
          executionId: meta.executionId,
          status: fullRow.status,
          decodedStatus: decodedStep.status,
          hasError: decodedStep.hasError,
          genericHasError: decodedStep.genericHasError,
        }
      }
      if (meta.executionId !== resolvedExecutionId) continue

      seenExecutionSteps += 1
      if (fullRow.idx > maxSeenExecutionStepIdx) maxSeenExecutionStepIdx = fullRow.idx

      const publishPlanEntry = extractCompletedPactPublishPlanStepCall(
        meta,
        fullRow.status,
        decodedStep,
        columnPayloadMatches,
      )
      if (publishPlanEntry !== undefined) {
        hasCompletedPactPublishPlan = true
        const existingCallIdx = completedPactPublishPlanCalls.findIndex(
          (entry) =>
            entry.serverName === publishPlanEntry.call.serverName &&
            entry.callId === publishPlanEntry.call.callId &&
            entry.progressToken === publishPlanEntry.call.progressToken &&
            entry.stepId === publishPlanEntry.call.stepId,
        )
        if (existingCallIdx >= 0) {
          completedPactPublishPlanCalls.splice(existingCallIdx, 1)
        }
        completedPactPublishPlanCalls.push(publishPlanEntry.call)
        if (completedPactPublishPlanCalls.length > 256) {
          completedPactPublishPlanCalls.splice(0, completedPactPublishPlanCalls.length - 256)
        }
        for (const token of publishPlanEntry.legacyTokens) {
          const existingIdx = completedPactPublishPlanTokens.indexOf(token)
          if (existingIdx >= 0) {
            completedPactPublishPlanTokens.splice(existingIdx, 1)
          }
          completedPactPublishPlanTokens.push(token)
        }
        if (completedPactPublishPlanTokens.length > 256) {
          completedPactPublishPlanTokens.splice(0, completedPactPublishPlanTokens.length - 256)
        }
      }

      if (!columnPayloadMatches) {
        hasMetadataContradiction = true
        hasActiveStep = true
      }

      if (
        [
          CORTEX_STEP_STATUS_PENDING,
          CORTEX_STEP_STATUS_RUNNING,
          CORTEX_STEP_STATUS_GENERATING,
          CORTEX_STEP_STATUS_WAITING,
          CORTEX_STEP_STATUS_QUEUED,
        ].includes(fullRow.status)
      ) {
        hasActiveStep = true
      } else if (
        fullRow.status === CORTEX_STEP_STATUS_CANCELED ||
        fullRow.status === CORTEX_STEP_STATUS_INTERRUPTED
      ) {
        hasCanceledStep = true
      } else if (
        (fullRow.step_type === CORTEX_STEP_TYPE_USER_INPUT ||
          fullRow.step_type === CORTEX_STEP_TYPE_PLANNER_RESPONSE) &&
        (fullRow.status === CORTEX_STEP_STATUS_ERROR ||
          fullRow.status === CORTEX_STEP_STATUS_INVALID ||
          decodedStep.hasError)
      ) {
        hasFailedCoreStep = true
      }

      if (
        columnPayloadMatches &&
        fullRow.step_type === CORTEX_STEP_TYPE_USER_INPUT &&
        fullRow.status === CORTEX_STEP_STATUS_DONE &&
        decodedStep.userInput
      ) {
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        consumedInputs.push({
          stepIndex: fullRow.idx,
          ...(meta.stepId ? { stepId: meta.stepId } : {}),
          ...(decodedStep.userInput.clientMessageId
            ? { clientMessageId: decodedStep.userInput.clientMessageId }
            : {}),
          ...(pactIdentity.messageId ? { pactMessageId: pactIdentity.messageId } : {}),
          ...(pactIdentity.pactRunId ? { pactRunId: pactIdentity.pactRunId } : {}),
          textSha256: sha256Hex(decodedStep.userInput.text),
        })
      } else if (
        fullRow.step_type === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        decodedStep.type === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        decodedStep.plannerResponse &&
        decodedStep.plannerResponse.canonicalText.length > 0 &&
        fullRow.status !== CORTEX_STEP_STATUS_INVALID &&
        decodedStep.status !== CORTEX_STEP_STATUS_INVALID
      ) {
        retainedPlannerBytes +=
          Buffer.byteLength(decodedStep.plannerResponse.canonicalText, 'utf8') + 128
        if (retainedPlannerBytes > AGY_TEXT_BUDGET_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
            false,
          )
        }
        plannerItems.push({
          id: meta.stepId ?? `step:${fullRow.idx}`,
          text: decodedStep.plannerResponse.canonicalText,
        })
      }
    }

    if (!matchedExec && seenExecutionSteps === 0) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const storedTerminalComplete =
      !hasMetadataContradiction &&
      seenExecutionSteps > 0 &&
      consumedInputs.length > 0 &&
      lastStepIdx !== undefined &&
      lastStepSummary !== undefined &&
      lastStepSummary.columnPayloadMatches &&
      lastStepSummary.executionId === resolvedExecutionId &&
      maxSeenExecutionStepIdx === lastStepIdx &&
      lastStepSummary.status === CORTEX_STEP_STATUS_DONE &&
      lastStepSummary.decodedStatus === CORTEX_STEP_STATUS_DONE &&
      !lastStepSummary.hasError &&
      !lastStepSummary.genericHasError

    let status: 'completed' | 'failed' | 'canceled' | 'running'
    if (hasMetadataContradiction) {
      status = 'running'
    } else if (
      !matchedExec ||
      matchedExec.terminationReason === EXECUTOR_TERMINATION_REASON_UNSPECIFIED
    ) {
      status = hasCanceledStep ? 'canceled' : hasFailedCoreStep ? 'failed' : 'running'
    } else if (matchedExec.terminationReason === EXECUTOR_TERMINATION_REASON_USER_CANCELED) {
      status = 'canceled'
    } else if (
      [
        EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
        EXECUTOR_TERMINATION_REASON_TERMINAL_STEP_TYPE,
        EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK,
        EXECUTOR_TERMINATION_REASON_INJECTED_RESPONSE,
      ].includes(matchedExec.terminationReason) &&
      !matchedExec.executionError &&
      !hasCanceledStep &&
      !hasFailedCoreStep
    ) {
      status = !hasActiveStep && storedTerminalComplete ? 'completed' : 'running'
    } else {
      status = 'failed'
    }

    const answer = projectCollaborationAnswer(plannerItems)
    const responseHash = sha256Hex(answer)
    const planOutcome = input.includePlan
      ? evaluateColdPlanArtifact(
          artifactOps,
          resolvedExecutionId,
          canonicalRoot,
          input.nativeSessionId,
        )
      : {}

    const consumedInputStepIds = consumedInputs.map(
      (entry) =>
        entry.stepId ??
        entry.clientMessageId ??
        entry.pactMessageId ??
        entry.pactRunId ??
        `step:${entry.stepIndex}`,
    )

    return {
      exists: true,
      nativeSessionId: input.nativeSessionId,
      trajectoryId: schema.trajectoryId,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      stepCount: counts.stepCount,
      terminalState: {
        executionId: resolvedExecutionId,
        status,
        ...(matchedExec !== undefined ? { terminationReason: matchedExec.terminationReason } : {}),
        ...(matchedExec?.lastStepIdx !== undefined ? { lastStepIdx: matchedExec.lastStepIdx } : {}),
        consumedInputStepIds,
        consumedInputs,
        answer,
        responseHash,
        ...(planOutcome.plan ? { plan: planOutcome.plan } : {}),
        ...(planOutcome.planUnavailable ? { planUnavailable: true } : {}),
        ...(hasCompletedPactPublishPlan
          ? {
              hasCompletedPactPublishPlan: true,
              completedPactPublishPlanTokens,
              completedPactPublishPlanCalls,
            }
          : {}),
      },
    }
  } finally {
    snapshotHandle.close()
  }
}

export function serializeAgyRebuildSeed(input: {
  rebuildId: string
  sourceHash?: string
  chunks: readonly AgyRebuildSeedChunk[]
}): {
  expectedUserText: string
  expectedAssistantText: string
  seedHash: string
  chunkCount: number
  seedExecutionId: string
  userStepId: string
  assistantStepId: string
} {
  if (!UUID_PATTERN.test(input.rebuildId)) {
    throw new Error('Invalid Antigravity rebuildId UUID.')
  }
  if (input.chunks.length > AGY_MAX_REBUILD_CHUNKS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild source exceeds the 4,096-chunk limit.',
      false,
    )
  }
  const hasImages = input.chunks.some((chunk) => chunk.kind === 'image')
  const manifest = JSON.stringify({
    pactContext: true,
    formatVersion: hasImages ? 'pact-agy-context-v2' : 'pact-agy-context-v1',
    pactRebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { pactSourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })
  if (Buffer.byteLength(manifest, 'utf8') > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild seed manifest exceeds the 8 MiB text budget; no history was truncated.',
      false,
    )
  }
  const seedHash = sha256Hex(manifest)
  const expectedAssistantText = 'No response requested.'
  const deriveUuid = (domain: string): string => {
    const hex = sha256Hex(`${input.rebuildId}:${domain}:${seedHash}`)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return {
    expectedUserText: manifest,
    expectedAssistantText,
    seedHash,
    chunkCount: input.chunks.length,
    seedExecutionId: deriveUuid('agy-seed-exec'),
    userStepId: deriveUuid('agy-seed-user-step'),
    assistantStepId: deriveUuid('agy-seed-assistant-step'),
  }
}

function readVerifiedImmutableImage(image: AgentPromptImage): Buffer {
  const before = lstatSync(image.path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== BigInt(image.bytes)
  ) {
    throw new AgentExecutionError('protocol_error', 'The saved Pact image is unavailable.', false)
  }
  const fd = openSync(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(before, opened)) {
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(image.path, { bigint: true })
    if (
      bytes.byteLength !== image.bytes ||
      !statsMatch(before, after) ||
      !statsMatch(before, namedAfter) ||
      sha256Hex(bytes) !== image.sha256
    ) {
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function ensureSafeDirectoryChain(
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

function deterministicMediaStagingLeafName(targetLeafName: string, expectedSha256: string): string {
  return `.pact-media-${sha256Hex(`${targetLeafName}\0${expectedSha256}`).slice(0, 32)}.tmp`
}

function readExactVerifiedSha256FromPath(
  filePath: string,
  expectedStat: {
    readonly dev: bigint
    readonly ino: bigint
    readonly size: bigint
    readonly nlink: bigint
  },
  expectedByteLength: number,
  expectedSha256: string,
): boolean {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== expectedStat.dev ||
      opened.ino !== expectedStat.ino ||
      opened.size !== expectedStat.size ||
      opened.nlink !== expectedStat.nlink
    ) {
      return false
    }
    const content = readExactBoundedBytesFromFd(fd, expectedByteLength)
    const afterRead = fstatSync(fd, { bigint: true })
    if (
      !statsMatch(opened, afterRead) ||
      afterRead.nlink !== expectedStat.nlink ||
      content.byteLength !== expectedByteLength
    ) {
      return false
    }
    return sha256Hex(content) === expectedSha256
  } finally {
    closeSync(fd)
  }
}

function writeIdempotentPrivateFile(
  targetPath: string,
  canonicalAppDataDir: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  const parentDir = dirname(targetPath)
  const parentBefore = lstatSync(parentDir, { bigint: true })
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('Antigravity uploaded media parent directory is linked or invalid.')
  }
  const canonicalParent = realpathSync(parentDir)
  if (canonicalParent !== parentDir || !isInsideDirectory(canonicalAppDataDir, canonicalParent)) {
    throw new Error('Antigravity uploaded media parent directory escaped its storage root.')
  }

  let parentDirFd: number | undefined
  if (process.platform !== 'win32') {
    parentDirFd = openSync(
      canonicalParent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const pinnedDirStat = fstatSync(parentDirFd, { bigint: true })
    if (
      !pinnedDirStat.isDirectory() ||
      pinnedDirStat.dev !== parentBefore.dev ||
      pinnedDirStat.ino !== parentBefore.ino
    ) {
      closeSync(parentDirFd)
      throw new Error('Antigravity uploaded media parent directory changed while opening.')
    }
  }

  const assertParentUnchanged = (phase: string): void => {
    const parentNow = lstatSync(canonicalParent, { bigint: true })
    if (
      !parentNow.isDirectory() ||
      parentNow.isSymbolicLink() ||
      parentNow.dev !== parentBefore.dev ||
      parentNow.ino !== parentBefore.ino ||
      realpathSync(canonicalParent) !== canonicalParent ||
      !isInsideDirectory(canonicalAppDataDir, canonicalParent)
    ) {
      throw new Error(`Antigravity uploaded media parent directory changed ${phase}.`)
    }
    if (parentDirFd !== undefined) {
      const pinnedDirStat = fstatSync(parentDirFd, { bigint: true })
      if (
        !pinnedDirStat.isDirectory() ||
        pinnedDirStat.dev !== parentBefore.dev ||
        pinnedDirStat.ino !== parentBefore.ino
      ) {
        throw new Error(`Antigravity uploaded media pinned parent directory changed ${phase}.`)
      }
    }
  }

  const targetLeaf = basename(targetPath)
  const tmpPath = join(
    canonicalParent,
    deterministicMediaStagingLeafName(targetLeaf, expectedSha256),
  )
  let tmpCreated = false
  let stageStat: BigIntStats | undefined
  let existed = false
  try {
    // Deterministic crash recovery: if a prior attempt crashed between linkSync and unlinkSync
    // (leaving target + deterministic staging file at nlink === 2 with identical inode, size, and
    // sha256) or right before linkSync (verified exact-digest nlink === 1 staging file), recover
    // cleanly without ever deleting an unrelated file.
    let existingTmpStat: BigIntStats | undefined
    try {
      existingTmpStat = lstatSync(tmpPath, { bigint: true })
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
        throw error
      }
    }

    if (existingTmpStat !== undefined) {
      assertParentUnchanged('during crash recovery')
      if (
        !existingTmpStat.isFile() ||
        existingTmpStat.isSymbolicLink() ||
        realpathSync(tmpPath) !== tmpPath
      ) {
        throw new Error(
          'Refusing to overwrite or delete unverified entry at Antigravity media staging path.',
        )
      }
      let existingTargetStat: BigIntStats | undefined
      try {
        existingTargetStat = lstatSync(targetPath, { bigint: true })
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
          throw error
        }
      }

      if (
        existingTargetStat !== undefined &&
        existingTargetStat.isFile() &&
        !existingTargetStat.isSymbolicLink() &&
        existingTargetStat.nlink === 2n &&
        existingTmpStat.nlink === 2n &&
        existingTargetStat.dev === existingTmpStat.dev &&
        existingTargetStat.ino === existingTmpStat.ino &&
        existingTargetStat.size === BigInt(bytes.byteLength) &&
        realpathSync(targetPath) === targetPath &&
        readExactVerifiedSha256FromPath(
          targetPath,
          existingTargetStat,
          bytes.byteLength,
          expectedSha256,
        ) &&
        readExactVerifiedSha256FromPath(tmpPath, existingTmpStat, bytes.byteLength, expectedSha256)
      ) {
        assertParentUnchanged('before unlinking recovered media staging link')
        const tmpBeforeUnlink = lstatSync(tmpPath, { bigint: true })
        if (
          tmpBeforeUnlink.isSymbolicLink() ||
          !tmpBeforeUnlink.isFile() ||
          tmpBeforeUnlink.nlink !== 2n ||
          tmpBeforeUnlink.dev !== existingTmpStat.dev ||
          tmpBeforeUnlink.ino !== existingTmpStat.ino
        ) {
          throw new Error('Antigravity media staging link changed during crash recovery.')
        }
        unlinkSync(tmpPath)
        if (parentDirFd !== undefined) {
          fsyncSync(parentDirFd)
        }
        const targetAfterRecovery = lstatSync(targetPath, { bigint: true })
        if (
          targetAfterRecovery.isSymbolicLink() ||
          !targetAfterRecovery.isFile() ||
          targetAfterRecovery.nlink !== 1n ||
          targetAfterRecovery.dev !== existingTargetStat.dev ||
          targetAfterRecovery.ino !== existingTargetStat.ino ||
          targetAfterRecovery.size !== existingTargetStat.size
        ) {
          throw new Error('Antigravity media target did not settle to single link after recovery.')
        }
        return
      }

      if (
        existingTargetStat === undefined &&
        existingTmpStat.nlink === 1n &&
        existingTmpStat.size === BigInt(bytes.byteLength) &&
        readExactVerifiedSha256FromPath(tmpPath, existingTmpStat, bytes.byteLength, expectedSha256)
      ) {
        const recoverSyncFd = openSync(tmpPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
        try {
          const opened = fstatSync(recoverSyncFd, { bigint: true })
          if (
            !opened.isFile() ||
            opened.nlink !== 1n ||
            opened.dev !== existingTmpStat.dev ||
            opened.ino !== existingTmpStat.ino ||
            opened.size !== existingTmpStat.size
          ) {
            throw new Error('Antigravity recovered media staging file changed before fsync.')
          }
          fsyncSync(recoverSyncFd)
        } finally {
          closeSync(recoverSyncFd)
        }
        assertParentUnchanged('before publishing recovered media staging file')
        let linkedRecovered = false
        try {
          linkSync(tmpPath, targetPath)
          linkedRecovered = true
        } catch (error) {
          const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
          if (code === 'EEXIST') {
            existed = true
          } else {
            throw Object.assign(
              new Error(
                `Atomic no-replace publication for Antigravity media is unavailable (${String(code ?? 'unknown')}).`,
              ),
              { code: typeof code === 'string' ? code : 'EIO' },
            )
          }
        }
        if (linkedRecovered) {
          const linkedTargetStat = lstatSync(targetPath, { bigint: true })
          if (
            linkedTargetStat.isSymbolicLink() ||
            !linkedTargetStat.isFile() ||
            linkedTargetStat.dev !== existingTmpStat.dev ||
            linkedTargetStat.ino !== existingTmpStat.ino ||
            linkedTargetStat.size !== existingTmpStat.size
          ) {
            throw new Error('Antigravity recovered media target identity mismatch after link.')
          }
          unlinkSync(tmpPath)
          if (parentDirFd !== undefined) {
            fsyncSync(parentDirFd)
          }
          return
        }
      } else {
        throw new Error(
          'Refusing to overwrite or delete unverified file at Antigravity media staging path.',
        )
      }
    }

    if (!existed) {
      assertParentUnchanged('before creating media staging file')
      const fd = openSync(
        tmpPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      tmpCreated = true
      let writtenStat: BigIntStats
      try {
        stageStat = fstatSync(fd, { bigint: true })
        if (
          !stageStat.isFile() ||
          stageStat.nlink !== 1n ||
          stageStat.size !== 0n ||
          stageStat.dev !== parentBefore.dev
        ) {
          throw new Error('Antigravity uploaded media staging descriptor identity is invalid.')
        }
        assertParentUnchanged('before write')
        const liveStageStat = lstatSync(tmpPath, { bigint: true })
        if (
          liveStageStat.isSymbolicLink() ||
          !liveStageStat.isFile() ||
          liveStageStat.nlink !== 1n ||
          liveStageStat.dev !== stageStat.dev ||
          liveStageStat.ino !== stageStat.ino ||
          realpathSync(tmpPath) !== tmpPath
        ) {
          throw new Error('Antigravity uploaded media staging path changed before write.')
        }
        writeAllSync(fd, bytes, 0, bytes.byteLength)
        writtenStat = fstatSync(fd, { bigint: true })
        if (
          writtenStat.dev !== stageStat.dev ||
          writtenStat.ino !== stageStat.ino ||
          writtenStat.size !== BigInt(bytes.byteLength)
        ) {
          throw new Error('Antigravity private file byte length did not match expected size.')
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }

      assertParentUnchanged('before publish')
      const prePublishStageStat = lstatSync(tmpPath, { bigint: true })
      if (
        prePublishStageStat.isSymbolicLink() ||
        !prePublishStageStat.isFile() ||
        prePublishStageStat.nlink !== 1n ||
        prePublishStageStat.dev !== writtenStat.dev ||
        prePublishStageStat.ino !== writtenStat.ino ||
        prePublishStageStat.size !== writtenStat.size
      ) {
        throw new Error('Antigravity uploaded media staging file changed before atomic publish.')
      }

      let linkedFresh = false
      try {
        linkSync(tmpPath, targetPath)
        linkedFresh = true
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
        if (code === 'EEXIST') {
          existed = true
        } else {
          throw Object.assign(
            new Error(
              `Atomic no-replace publication for Antigravity media is unavailable (${String(code ?? 'unknown')}).`,
            ),
            { code: typeof code === 'string' ? code : 'EIO' },
          )
        }
      }
      if (linkedFresh) {
        const publishedStat = lstatSync(targetPath, { bigint: true })
        if (
          publishedStat.isSymbolicLink() ||
          !publishedStat.isFile() ||
          publishedStat.dev !== writtenStat.dev ||
          publishedStat.ino !== writtenStat.ino ||
          publishedStat.size !== writtenStat.size
        ) {
          throw new Error('Antigravity uploaded media published target identity mismatch.')
        }
        unlinkSync(tmpPath)
        tmpCreated = false
        if (parentDirFd !== undefined) {
          fsyncSync(parentDirFd)
        }
        return
      }
    }
  } finally {
    if (tmpCreated && stageStat) {
      try {
        const currentTmp = lstatSync(tmpPath, { bigint: true })
        if (
          !currentTmp.isSymbolicLink() &&
          currentTmp.isFile() &&
          currentTmp.dev === stageStat.dev &&
          currentTmp.ino === stageStat.ino
        ) {
          unlinkSync(tmpPath)
        }
      } catch {
        /* Best-effort cleanup of owned temp media file. */
      }
    }
    if (parentDirFd !== undefined) {
      try {
        closeSync(parentDirFd)
      } catch {
        /* Best-effort close of pinned media parent directory handle. */
      }
    }
  }

  if (!existed) return
  const existingFd = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(existingFd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error('Existing Antigravity uploaded media target is linked or unsupported.')
    }
    const parentAfter = lstatSync(canonicalParent, { bigint: true })
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      !isInsideDirectory(canonicalParent, realpathSync(targetPath))
    ) {
      throw new Error('Existing Antigravity uploaded media target escaped its storage root.')
    }
    if (opened.size !== BigInt(bytes.byteLength)) {
      throw new Error(
        'Existing Antigravity uploaded media target differs from its expected content.',
      )
    }
    const currentBytes = readExactBoundedBytesFromFd(existingFd, bytes.byteLength)
    const afterRead = fstatSync(existingFd, { bigint: true })
    if (
      !statsMatch(opened, afterRead) ||
      currentBytes.byteLength !== bytes.byteLength ||
      sha256Hex(currentBytes) !== expectedSha256
    ) {
      throw new Error(
        'Existing Antigravity uploaded media target differs from its expected content.',
      )
    }
  } finally {
    closeSync(existingFd)
  }
}

function fsyncDirectoryBestEffort(dirPath: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dirPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function validateFreshTrajectorySummaryBlob(
  rawSummary: Buffer,
  expectedSessionId: string,
  expectedTrajectoryId?: string,
): void {
  if (rawSummary.byteLength > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity conversation_summaries.raw_summary exceeds 8 MiB.',
      false,
    )
  }
  const fields = decodeProtobufFields(rawSummary)
  let sawTrajectoryId = false
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error('Antigravity TrajectorySummary.summary (field 1) wire type is invalid.')
      }
      if (field.bytes.byteLength > 0) {
        throw new Error(
          'Antigravity candidate raw_summary already carries a non-empty summary title.',
        )
      }
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT) {
        throw new Error('Antigravity TrajectorySummary.step_count (field 2) wire type is invalid.')
      }
      if (field.varint !== 0n) {
        throw new Error('Antigravity candidate raw_summary already carries non-zero step_count.')
      }
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error(
          'Antigravity TrajectorySummary.trajectory_id (field 4) wire type is invalid.',
        )
      }
      const summaryTrajectoryId = decodeUtf8Strict(field.bytes)
      if (!SAFE_ID_PATTERN.test(summaryTrajectoryId)) {
        throw new Error('Antigravity candidate raw_summary has an invalid trajectory_id.')
      }
      if (expectedTrajectoryId !== undefined && summaryTrajectoryId !== expectedTrajectoryId) {
        throw new Error(
          'Antigravity candidate raw_summary trajectory_id disagrees with trajectory_meta.',
        )
      }
      sawTrajectoryId = true
    } else if (field.fieldNumber === 17) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error(
          'Antigravity TrajectorySummary.trajectory_metadata (field 17) wire type is invalid.',
        )
      }
      const decodedMeta = decodeCortexTrajectoryMetadata(field.bytes)
      if (
        (decodedMeta.parentConversationId && decodedMeta.parentConversationId.length > 0) ||
        decodedMeta.hasSubagentSpec ||
        decodedMeta.isBattleModeFork ||
        decodedMeta.nestingDepth !== 0 ||
        (decodedMeta.rootConversationId &&
          decodedMeta.rootConversationId.length > 0 &&
          decodedMeta.rootConversationId !== expectedSessionId)
      ) {
        throw new Error(
          'Antigravity candidate raw_summary metadata contains unclosed parent or subagent lineage.',
        )
      }
    }
  }
  if (expectedTrajectoryId !== undefined && !sawTrajectoryId) {
    throw new Error('Antigravity candidate raw_summary is missing trajectory_id (field 4).')
  }
}

function verifySummaryRowExistsReadOnly(
  canonicalAppDataDir: string,
  sessionId: string,
  requireEmptyFreshSummary: boolean,
  expectedTrajectoryId?: string,
): { stepCount: number } {
  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: canonicalAppDataDir,
    canonicalRoot: canonicalAppDataDir,
    parentSegments: [],
    leafName: 'conversation_summaries.db',
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
  })
  const db = snapshotHandle.db
  try {
    assertProofHasOrdinaryTables(snapshotHandle.proof, ['conversation_summaries'])
    const cols = readTableColumns(db, 'conversation_summaries')
    if (!cols.includes('conversation_id') || !cols.includes('step_count')) {
      throw new Error('Antigravity conversation_summaries table is missing required columns.')
    }
    const selectColsList = [
      'conversation_id',
      'step_count',
      ...(cols.includes('title') ? ['title'] : []),
      ...(cols.includes('raw_summary') ? ['raw_summary'] : []),
      ...(cols.includes('parent_conversation_id') ? ['parent_conversation_id'] : []),
    ]
    if (
      measureTableColumnsTotalBytes(db, 'conversation_summaries', selectColsList, {
        sql: '"conversation_id" = ?',
        params: [sessionId],
      }) > AGY_TEXT_BUDGET_BYTES
    ) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity conversation_summaries row exceeds 8 MiB.',
        false,
      )
    }
    const selectCols = selectColsList.map(quoteSqlIdentifier).join(', ')
    const row = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT ${selectCols} FROM "conversation_summaries" WHERE "conversation_id" = ?`,
      )
      .get(sessionId)
    if (!row) {
      throw new Error(
        'Antigravity candidate session is not registered in conversation_summaries.db.',
      )
    }
    const stepCount = row['step_count']
    if (typeof stepCount !== 'number' || !Number.isSafeInteger(stepCount) || stepCount < 0) {
      throw new Error('Antigravity conversation_summaries.step_count is invalid.')
    }
    if (
      typeof row['parent_conversation_id'] === 'string' &&
      row['parent_conversation_id'].length > 0
    ) {
      throw new Error('Antigravity candidate summary row has unexpected parent_conversation_id.')
    }
    if (requireEmptyFreshSummary) {
      if (stepCount !== 0) {
        throw new Error('Antigravity candidate summary row is not a fresh zero-Turn shell.')
      }
      if (typeof row['title'] === 'string' && row['title'].length > 0) {
        throw new Error('Antigravity candidate summary row already carries a non-empty title.')
      }
      const rawSummary = row['raw_summary']
      if (rawSummary !== null && rawSummary !== undefined) {
        if (!Buffer.isBuffer(rawSummary)) {
          throw new Error('Antigravity candidate raw_summary must be a BLOB.')
        }
        if (rawSummary.byteLength > 0) {
          validateFreshTrajectorySummaryBlob(rawSummary, sessionId, expectedTrajectoryId)
        }
      }
    }
    return { stepCount }
  } finally {
    snapshotHandle.close()
  }
}

function ensureSummaryStepCountCas(
  canonicalAppDataDir: string,
  sessionId: string,
  stepCount: number,
  lastUserInputStepIndex: number,
  expectedTrajectoryId?: string,
): void {
  const summariesPath = join(canonicalAppDataDir, 'conversation_summaries.db')
  const stat = lstatSync(summariesPath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Antigravity conversation_summaries.db must be an ordinary non-linked file.')
  }
  const canonicalSummariesPath = realpathSync(summariesPath)
  if (!isInsideDirectory(canonicalAppDataDir, canonicalSummariesPath)) {
    throw new Error('Antigravity conversation_summaries.db escaped its storage root.')
  }
  const db = new Database(canonicalSummariesPath, {
    fileMustExist: true,
    timeout: AGY_SUMMARIES_BUSY_TIMEOUT_MS,
  })
  try {
    db.pragma(`busy_timeout = ${AGY_SUMMARIES_BUSY_TIMEOUT_MS}`)
    const summaryTableRow = db
      .prepare<[], { rootpage: number; sql: string | null }>(
        `SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries' LIMIT 1`,
      )
      .get()
    if (
      !summaryTableRow ||
      summaryTableRow.rootpage < 2 ||
      (summaryTableRow.sql && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(summaryTableRow.sql))
    ) {
      throw new Error('Antigravity conversation_summaries is missing or not an ordinary table.')
    }
    const cols = readTableColumns(db, 'conversation_summaries')
    if (!cols.includes('conversation_id') || !cols.includes('step_count')) {
      throw new Error('Antigravity conversation_summaries table is missing required columns.')
    }
    const hasTitle = cols.includes('title')
    const hasRawSummary = cols.includes('raw_summary')
    const hasParent = cols.includes('parent_conversation_id')
    const hasLastUserStep = cols.includes('last_user_input_step_index')
    const selectCols = [
      'conversation_id',
      'step_count',
      ...(hasTitle ? ['title'] : []),
      ...(hasRawSummary ? ['raw_summary'] : []),
      ...(hasParent ? ['parent_conversation_id'] : []),
      ...(hasLastUserStep ? ['last_user_input_step_index'] : []),
    ]
      .map(quoteSqlIdentifier)
      .join(', ')

    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare<[string], Record<string, unknown>>(
          `SELECT ${selectCols} FROM "conversation_summaries" WHERE "conversation_id" = ?`,
        )
        .get(sessionId)
      if (!row) {
        throw new Error(
          'Antigravity candidate session disappeared from conversation_summaries.db before commit.',
        )
      }
      const currentStepCount = row['step_count']
      if (
        typeof currentStepCount !== 'number' ||
        !Number.isSafeInteger(currentStepCount) ||
        currentStepCount < 0
      ) {
        throw new Error('Antigravity conversation_summaries.step_count is invalid.')
      }
      if (
        hasParent &&
        typeof row['parent_conversation_id'] === 'string' &&
        row['parent_conversation_id'].length > 0
      ) {
        throw new Error('Antigravity candidate summary row has unexpected parent_conversation_id.')
      }
      const currentTitle = hasTitle ? row['title'] : undefined
      if (typeof currentTitle === 'string' && currentTitle.length > 0) {
        throw new Error(
          'Antigravity candidate summary row already carries a title from external native progress.',
        )
      }
      const rawSummary = hasRawSummary ? row['raw_summary'] : null
      if (rawSummary !== null && rawSummary !== undefined) {
        if (!Buffer.isBuffer(rawSummary)) {
          throw new Error('Antigravity candidate raw_summary must be a BLOB.')
        }
        if (rawSummary.byteLength > 0) {
          validateFreshTrajectorySummaryBlob(rawSummary, sessionId, expectedTrajectoryId)
        }
      }

      // Idempotent re-entry: already synchronized to the exact expected state with no external title/parent.
      if (
        currentStepCount === stepCount &&
        (!hasLastUserStep || row['last_user_input_step_index'] === lastUserInputStepIndex)
      ) {
        db.exec('COMMIT')
        return
      }

      if (currentStepCount !== 0) {
        throw new Error(
          'Antigravity candidate summary row advanced externally; refusing to overwrite native progress.',
        )
      }

      const whereClauses: string[] = ['"conversation_id" = ?', '"step_count" = 0']
      const whereParams: unknown[] = [sessionId]
      if (hasTitle) {
        whereClauses.push('("title" IS NULL OR "title" = \'\')')
      }
      if (hasParent) {
        whereClauses.push('("parent_conversation_id" IS NULL OR "parent_conversation_id" = \'\')')
      }
      if (hasRawSummary) {
        if (rawSummary === null || rawSummary === undefined) {
          whereClauses.push('"raw_summary" IS NULL')
        } else {
          whereClauses.push('"raw_summary" = ?')
          whereParams.push(rawSummary)
        }
      }

      const result = hasLastUserStep
        ? db
            .prepare(
              `UPDATE "conversation_summaries" SET "step_count" = ?, "last_user_input_step_index" = ? WHERE ${whereClauses.join(' AND ')}`,
            )
            .run(stepCount, lastUserInputStepIndex, ...whereParams)
        : db
            .prepare(
              `UPDATE "conversation_summaries" SET "step_count" = ? WHERE ${whereClauses.join(' AND ')}`,
            )
            .run(stepCount, ...whereParams)
      if (result.changes !== 1) {
        throw new Error('Antigravity candidate summary CAS failed due to concurrent modification.')
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

function initializeStagingFromShell(
  stagingDb: Database.Database,
  shellDb: Database.Database,
  shellSchema: ValidatedTrajectorySchema,
): void {
  const pageSize = Number(shellDb.pragma('page_size', { simple: true }) || 32768)
  const userVersion = Number(shellDb.pragma('user_version', { simple: true }) || 0)
  stagingDb.pragma(`page_size = ${pageSize}`)
  stagingDb.pragma('journal_mode = DELETE')
  stagingDb.pragma('synchronous = FULL')
  if (userVersion > 0) stagingDb.pragma(`user_version = ${userVersion}`)

  stagingDb.exec('BEGIN IMMEDIATE')
  try {
    for (const table of shellSchema.tables.values()) {
      if (!table.sql) throw new Error(`Missing DDL for table ${table.name} in candidate shell.`)
      stagingDb.exec(table.sql)
    }
    for (const idx of shellSchema.indexes) {
      if (idx.sql) stagingDb.exec(idx.sql)
    }

    const metaCols = shellSchema.metaColumns
    const metaPlaceholders = metaCols.map(() => '?').join(', ')
    stagingDb
      .prepare(
        `INSERT INTO "trajectory_meta" (${metaCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${metaPlaceholders})`,
      )
      .run(...metaCols.map((col) => shellSchema.metaRow[col] ?? null))

    if (
      shellSchema.tables.has('trajectory_metadata_blob') &&
      shellSchema.trajectoryMetadataRows.length > 0
    ) {
      const blobCols = readTableColumns(shellDb, 'trajectory_metadata_blob')
      const blobPlaceholders = blobCols.map(() => '?').join(', ')
      const insertBlob = stagingDb.prepare(
        `INSERT INTO "trajectory_metadata_blob" (${blobCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${blobPlaceholders})`,
      )
      for (const row of shellSchema.trajectoryMetadataRows) {
        insertBlob.run(...blobCols.map((col) => row[col] ?? null))
      }
    }
    stagingDb.exec('COMMIT')
  } catch (error) {
    if (stagingDb.inTransaction) stagingDb.exec('ROLLBACK')
    throw error
  }
}

function verifySqliteIntegrityOk(db: Database.Database): void {
  const rows: unknown = db.pragma('integrity_check')
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !isPlainObject(rows[0]) ||
    rows[0]['integrity_check'] !== 'ok'
  ) {
    throw new Error('Antigravity staging SQLite database failed PRAGMA integrity_check.')
  }
}

function measureOpenSqliteExpectedBytes(db: Database.Database): bigint {
  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
  const pageSize = Number(db.pragma('page_size', { simple: true }) || 0)
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0
  ) {
    throw new Error('Antigravity staged SQLite database has invalid page geometry.')
  }
  return BigInt(pageCount) * BigInt(pageSize)
}

const AGY_REBUILD_RECEIPT_FILENAME = '.pact-rebuild-verified-v1.json'
const AGY_REBUILD_RECEIPT_MAX_BYTES = 16 * 1024

function readRebuildColdLoadReceiptIfPresent(
  canonicalRoot: string,
  nativeSessionId: string,
  expected: {
    sourceHash?: string | undefined
    pbSha256: string
    pbBytes: number
  },
): AgyRebuildInitializationWitness | undefined {
  const brainChain = verifySafeDirectoryChainIfPresent(
    canonicalRoot,
    ['brain', nativeSessionId],
    'Antigravity rebuild receipt',
  )
  if (!brainChain.exists) return undefined
  const receiptPath = join(brainChain.canonicalDir, AGY_REBUILD_RECEIPT_FILENAME)
  let stat: BigIntStats
  try {
    stat = lstatSync(receiptPath, { bigint: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Antigravity rebuild cold-load verification receipt is linked or unsupported.')
  }
  if (stat.size <= 0n || stat.size > BigInt(AGY_REBUILD_RECEIPT_MAX_BYTES)) {
    throw new Error('Antigravity rebuild cold-load verification receipt size is invalid.')
  }
  const realReceipt = realpathSync(receiptPath)
  if (realReceipt !== receiptPath || !isInsideDirectory(brainChain.canonicalDir, realReceipt)) {
    throw new Error('Antigravity rebuild cold-load verification receipt escaped its session brain.')
  }
  let rawText: string
  const fd = openSync(receiptPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(stat, opened) || realpathSync(receiptPath) !== receiptPath) {
      throw new Error('Antigravity rebuild cold-load verification receipt changed while opening.')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (BigInt(bytes.byteLength) !== stat.size || !statsMatch(stat, after)) {
      throw new Error('Antigravity rebuild cold-load verification receipt changed while reading.')
    }
    rawText = decodeUtf8Strict(bytes)
  } finally {
    closeSync(fd)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawText)
  } catch {
    throw new Error('Antigravity rebuild cold-load verification receipt is not valid JSON.')
  }
  if (
    !isPlainObject(parsedJson) ||
    parsedJson['version'] !== 'pact-agy-rebuild-verified-v1' ||
    parsedJson['nativeSessionId'] !== nativeSessionId ||
    parsedJson['pbSha256'] !== expected.pbSha256 ||
    parsedJson['pbBytes'] !== expected.pbBytes ||
    parsedJson['stepCount'] !== 2 ||
    typeof parsedJson['sourceHash'] !== 'string' ||
    (expected.sourceHash !== undefined && parsedJson['sourceHash'] !== expected.sourceHash) ||
    typeof parsedJson['coldLoadVerifiedAt'] !== 'string'
  ) {
    throw new Error('Antigravity rebuild cold-load verification receipt does not match seed state.')
  }

  return agyRebuildInitializationWitnessSchema.parse({
    kind: 'agy_rebuild_v1',
    nativeSessionId,
    pbSha256: expected.pbSha256,
    pbBytes: expected.pbBytes,
    stepCount: 2,
    sourceHash: parsedJson['sourceHash'],
    coldLoadVerifiedAt: parsedJson['coldLoadVerifiedAt'],
  })
}

export function confirmAgyRebuildColdLoad(
  input: AgyConfirmRebuildColdLoadInput,
): AgyRebuildInitializationWitness {
  assertValidSessionUuid(input.nativeSessionId)
  if (!/^[a-f0-9]{64}$/u.test(input.sourceHash)) {
    throw new Error('Invalid Antigravity rebuild sourceHash.')
  }
  if (!/^[a-f0-9]{64}$/u.test(input.pbSha256)) {
    throw new Error('Invalid Antigravity rebuild pbSha256.')
  }
  if (
    typeof input.pbBytes !== 'number' ||
    !Number.isSafeInteger(input.pbBytes) ||
    input.pbBytes <= 0 ||
    input.pbBytes > 64 * 1024 * 1024 ||
    input.stepCount !== 2
  ) {
    throw new Error('Invalid Antigravity rebuild cold-load confirmation parameters.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot ?? input.appDataDir)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${input.nativeSessionId}.db`,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)
    const preflightBytes =
      measureTableColumnsTotalBytes(db, 'steps', ['metadata', schema.stepPayloadColumn]) +
      measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild database exceeds the 32 MiB history budget.',
        false,
      )
    }
    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const stepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" ORDER BY idx ASC`
    const stepRows = db
      .prepare<
        [],
        {
          idx: number
          step_type: number
          status: number
          has_subtrajectory: number
          metadata: Buffer | null
          step_blob: Buffer | null
          step_format?: unknown
        }
      >(stepSelectSql)
      .all()
    const genCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
      .get()!
    const execRows = db
      .prepare<[], { idx: number; data: Buffer }>(
        'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
      )
      .all()

    if (stepRows.length !== 2 || genCountRow.count !== 0 || execRows.length !== 1) {
      throw new Error(
        'Additional native work prevents an initialization-only Antigravity rebuild confirmation.',
      )
    }
    const userRow = stepRows[0]!
    const assistantRow = stepRows[1]!
    const exec0 = execRows[0]!
    assertCompatibleStepRowFormat(userRow.step_format, schema.hasStepFormatColumn, 0)
    assertCompatibleStepRowFormat(assistantRow.step_format, schema.hasStepFormatColumn, 1)
    if (
      userRow.idx !== 0 ||
      userRow.step_type !== CORTEX_STEP_TYPE_USER_INPUT ||
      userRow.status !== CORTEX_STEP_STATUS_DONE ||
      userRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(userRow.step_blob) ||
      assistantRow.idx !== 1 ||
      assistantRow.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE ||
      assistantRow.status !== CORTEX_STEP_STATUS_DONE ||
      assistantRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(assistantRow.step_blob) ||
      exec0.idx !== 0 ||
      !Buffer.isBuffer(exec0.data)
    ) {
      throw new Error('Antigravity rebuild seeded step headers do not match expected structure.')
    }

    const decodedUser = decodeAgyStep(userRow.step_blob)
    const decodedExec0 = decodeExecutorMetadata(exec0.data)
    if (
      !decodedUser.userInput ||
      decodedExec0.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
      decodedExec0.numGeneratorInvocations !== 0 ||
      decodedExec0.lastStepIdx !== 1
    ) {
      throw new Error('Antigravity rebuild seed payload structure is invalid.')
    }

    let parsedManifest: unknown
    try {
      parsedManifest = JSON.parse(decodedUser.userInput.text)
    } catch {
      throw new Error('Antigravity rebuild user seed text is not a valid Pact manifest.')
    }
    if (
      !isPlainObject(parsedManifest) ||
      parsedManifest['pactContext'] !== true ||
      parsedManifest['pactSourceHash'] !== input.sourceHash
    ) {
      throw new Error('Antigravity rebuild seed pactSourceHash does not match expected sourceHash.')
    }

    const actualPbBytes =
      userRow.step_blob.byteLength + assistantRow.step_blob.byteLength + exec0.data.byteLength
    const actualPbSha256 = createHash('sha256')
      .update('pact-agy-seed-pb-v1\0')
      .update(userRow.step_blob)
      .update('\0')
      .update(assistantRow.step_blob)
      .update('\0')
      .update(exec0.data)
      .digest('hex')
    if (actualPbBytes !== input.pbBytes || actualPbSha256 !== input.pbSha256) {
      throw new Error('Antigravity rebuild Protobuf seed digest mismatch during cold-load confirm.')
    }

    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
    if (summary.stepCount !== 2) {
      throw new Error('Antigravity conversation_summaries.step_count is not synchronized.')
    }
  } finally {
    snapshotHandle.close()
  }

  const existingReceipt = readRebuildColdLoadReceiptIfPresent(
    canonicalRoot,
    input.nativeSessionId,
    {
      sourceHash: input.sourceHash,
      pbSha256: input.pbSha256,
      pbBytes: input.pbBytes,
    },
  )
  if (existingReceipt) return existingReceipt

  const brainSessionDir = ensureSafeDirectoryChain(canonicalRoot, ['brain', input.nativeSessionId])
  const receiptPath = join(brainSessionDir, AGY_REBUILD_RECEIPT_FILENAME)
  try {
    const existingStat = lstatSync(receiptPath, { bigint: true })
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error('Existing Antigravity rebuild receipt path is a symlink or non-file.')
    }
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }

  const coldLoadVerifiedAt = new Date().toISOString()
  const receiptPayload = JSON.stringify({
    version: 'pact-agy-rebuild-verified-v1',
    nativeSessionId: input.nativeSessionId,
    sourceHash: input.sourceHash,
    pbSha256: input.pbSha256,
    pbBytes: input.pbBytes,
    stepCount: 2 as const,
    coldLoadVerifiedAt,
  })
  const tmpReceiptPath = `${receiptPath}.tmp-${randomUUID()}`
  try {
    const fd = openSync(
      tmpReceiptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      writeFileSync(fd, receiptPayload, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpReceiptPath, receiptPath)
    fsyncDirectoryBestEffort(brainSessionDir)
  } finally {
    try {
      rmSync(tmpReceiptPath, { force: true })
    } catch {
      /* Best-effort temp receipt cleanup. */
    }
  }

  return agyRebuildInitializationWitnessSchema.parse({
    kind: 'agy_rebuild_v1',
    nativeSessionId: input.nativeSessionId,
    pbSha256: input.pbSha256,
    pbBytes: input.pbBytes,
    stepCount: 2,
    sourceHash: input.sourceHash,
    coldLoadVerifiedAt,
  })
}

function verifyAgyRebuildSeedInternal(
  input: AgyRebuildSeedVerificationInput,
  options: {
    requireNoAdditionalWork: boolean
    requireColdLoadReceipt: boolean
    checkSummarySynchronized: boolean
    omitWitness?: boolean
  },
): AgyRebuildSeedResult {
  assertValidSessionUuid(input.nativeSessionId)
  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const serialized = serializeAgyRebuildSeed({
    rebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })
  if (input.expectedSeedHash && serialized.seedHash !== input.expectedSeedHash) {
    throw new Error('Antigravity rebuild seed manifest hash mismatch.')
  }

  const imageChunks = input.chunks.filter(
    (chunk): chunk is Extract<AgyRebuildSeedChunk, { kind: 'image' }> => chunk.kind === 'image',
  )

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${input.nativeSessionId}.db`,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)
    if (input.expectedTrajectoryId && schema.trajectoryId !== input.expectedTrajectoryId) {
      throw new Error('Antigravity rebuild trajectory_id changed.')
    }
    const preflightSeedBytes =
      measureTableColumnsTotalBytes(db, 'steps', ['metadata', schema.stepPayloadColumn]) +
      measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightSeedBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild database exceeds the 32 MiB history budget.',
        false,
      )
    }

    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const stepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" ORDER BY idx ASC`
    const stepRows = db
      .prepare<
        [],
        {
          idx: number
          step_type: number
          status: number
          has_subtrajectory: number
          metadata: Buffer | null
          step_blob: Buffer | null
          step_format?: unknown
        }
      >(stepSelectSql)
      .all()
    const genCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
      .get()!
    const execRows = db
      .prepare<[], { idx: number; data: Buffer }>(
        'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
      )
      .all()

    if (stepRows.length < 2 || execRows.length < 1) {
      throw new Error('Antigravity rebuild candidate does not contain the complete seeded steps.')
    }
    if (options.requireNoAdditionalWork) {
      if (stepRows.length !== 2 || genCountRow.count !== 0 || execRows.length !== 1) {
        throw new Error(
          'Additional native work prevents an initialization-only Antigravity rebuild confirmation.',
        )
      }
    }

    const userRow = stepRows[0]!
    const assistantRow = stepRows[1]!
    assertCompatibleStepRowFormat(userRow.step_format, schema.hasStepFormatColumn, 0)
    assertCompatibleStepRowFormat(assistantRow.step_format, schema.hasStepFormatColumn, 1)
    if (
      userRow.idx !== 0 ||
      userRow.step_type !== CORTEX_STEP_TYPE_USER_INPUT ||
      userRow.status !== CORTEX_STEP_STATUS_DONE ||
      userRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(userRow.step_blob) ||
      assistantRow.idx !== 1 ||
      assistantRow.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE ||
      assistantRow.status !== CORTEX_STEP_STATUS_DONE ||
      assistantRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(assistantRow.step_blob)
    ) {
      throw new Error('Antigravity rebuild seeded step headers do not match expected structure.')
    }

    const decodedUser = decodeAgyStep(userRow.step_blob)
    const decodedAssistant = decodeAgyStep(assistantRow.step_blob)
    const userMeta = extractEffectiveStepMetadata(userRow.metadata, decodedUser)
    const assistantMeta = extractEffectiveStepMetadata(assistantRow.metadata, decodedAssistant)

    if (
      !decodedUser.userInput ||
      decodedUser.userInput.userResponse !== serialized.expectedUserText ||
      decodedUser.userInput.itemsText !== serialized.expectedUserText ||
      sha256Hex(decodedUser.userInput.text) !== serialized.seedHash ||
      userMeta.executionId !== serialized.seedExecutionId ||
      userMeta.stepId !== serialized.userStepId ||
      userMeta.sourceTrajectoryStepInfo?.trajectoryId !== schema.trajectoryId ||
      userMeta.sourceTrajectoryStepInfo?.cascadeId !== input.nativeSessionId ||
      (userMeta.sourceTrajectoryStepInfo?.stepIndex ?? 0) !== 0
    ) {
      throw new Error(
        'Antigravity rebuild user seed step did not preserve complete source content.',
      )
    }

    if (decodedUser.userInput.media.length !== imageChunks.length) {
      throw new Error('Antigravity rebuild media count does not match image chunk manifest.')
    }
    for (const [imgIdx, imgChunk] of imageChunks.entries()) {
      const media = decodedUser.userInput.media[imgIdx]!
      if (
        media.mimeType !== imgChunk.image.mediaType ||
        !media.inlineData ||
        media.inlineData.byteLength !== imgChunk.image.bytes ||
        sha256Hex(media.inlineData) !== imgChunk.image.sha256 ||
        !media.uri
      ) {
        throw new Error('Antigravity rebuild inline media does not match immutable image digest.')
      }
      const plan = parseMediaUriToUploadedFile(
        media.uri,
        canonicalRoot,
        input.nativeSessionId,
        input.nativeSessionId,
        configuredRoot,
      )
      if (!plan) {
        throw new Error('Antigravity rebuild media URI is outside candidate .user_uploaded.')
      }
      const diskBytes = readVerifiedUploadedMediaFile(
        canonicalRoot,
        input.nativeSessionId,
        plan.sourceFilePath,
        AGY_MAX_HISTORY_BYTES,
      )
      if (
        diskBytes.byteLength !== imgChunk.image.bytes ||
        sha256Hex(diskBytes) !== imgChunk.image.sha256
      ) {
        throw new Error('Antigravity rebuild uploaded media file digest mismatch.')
      }
    }

    if (
      !decodedAssistant.plannerResponse ||
      decodedAssistant.plannerResponse.canonicalText !== serialized.expectedAssistantText ||
      assistantMeta.executionId !== serialized.seedExecutionId ||
      assistantMeta.stepId !== serialized.assistantStepId ||
      assistantMeta.sourceTrajectoryStepInfo?.trajectoryId !== schema.trajectoryId ||
      assistantMeta.sourceTrajectoryStepInfo?.cascadeId !== input.nativeSessionId ||
      assistantMeta.sourceTrajectoryStepInfo?.stepIndex !== 1
    ) {
      throw new Error('Antigravity rebuild assistant acknowledgement step mismatch.')
    }

    const exec0 = execRows[0]!
    if (exec0.idx !== 0 || !Buffer.isBuffer(exec0.data)) {
      throw new Error('Antigravity rebuild executor_metadata[0] is missing.')
    }
    const decodedExec0 = decodeExecutorMetadata(exec0.data)
    if (
      decodedExec0.executionId !== serialized.seedExecutionId ||
      decodedExec0.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
      decodedExec0.numGeneratorInvocations !== 0 ||
      decodedExec0.lastStepIdx !== 1
    ) {
      throw new Error('Antigravity rebuild executor_metadata[0] linkage mismatch.')
    }

    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })

    if (options.checkSummarySynchronized) {
      const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
      if (options.requireNoAdditionalWork ? summary.stepCount !== 2 : summary.stepCount < 2) {
        throw new Error('Antigravity conversation_summaries.step_count is not synchronized.')
      }
    }

    const pbBytes =
      userRow.step_blob.byteLength + assistantRow.step_blob.byteLength + exec0.data.byteLength
    const pbSha256 = createHash('sha256')
      .update('pact-agy-seed-pb-v1\0')
      .update(userRow.step_blob)
      .update('\0')
      .update(assistantRow.step_blob)
      .update('\0')
      .update(exec0.data)
      .digest('hex')
    if (
      (input.expectedPbSha256 && pbSha256 !== input.expectedPbSha256) ||
      (input.expectedPbBytes !== undefined && pbBytes !== input.expectedPbBytes)
    ) {
      throw new Error('Antigravity rebuild Protobuf seed digest mismatch.')
    }

    const physical = computePhysicalDbDigest(
      canonicalRoot,
      input.nativeSessionId,
      configuredRoot,
      snapshotHandle.fileIdentity,
      snapshotHandle.walIdentity,
    )
    const recordCount = stepRows.length + genCountRow.count + execRows.length
    if (
      options.requireNoAdditionalWork &&
      ((input.expectedVerifiedPrefixSha256 &&
        physical.rawHash !== input.expectedVerifiedPrefixSha256) ||
        (input.expectedVerifiedPrefixBytes !== undefined &&
          physical.rawBytes !== input.expectedVerifiedPrefixBytes) ||
        (input.expectedRecordCount !== undefined && recordCount !== input.expectedRecordCount))
    ) {
      throw new Error('Antigravity rebuild physical database prefix changed after initialization.')
    }

    let initializationWitness: AgyRebuildInitializationWitness | undefined
    if (!options.omitWitness) {
      initializationWitness = readRebuildColdLoadReceiptIfPresent(
        canonicalRoot,
        input.nativeSessionId,
        {
          sourceHash: input.sourceHash,
          pbSha256,
          pbBytes,
        },
      )
      if (options.requireColdLoadReceipt && !initializationWitness) {
        throw new Error(
          'Antigravity rebuild cold-load verification receipt (.pact-rebuild-verified-v1.json) is missing.',
        )
      }
    }

    return {
      nativeSessionId: input.nativeSessionId,
      trajectoryId: schema.trajectoryId,
      seedHash: serialized.seedHash,
      chunkCount: serialized.chunkCount,
      stepCount: 2,
      pbSha256,
      pbBytes,
      verifiedPrefixBytes: physical.rawBytes,
      verifiedPrefixSha256: physical.rawHash,
      recordCount,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      ...(initializationWitness ? { initializationWitness } : {}),
    }
  } finally {
    snapshotHandle.close()
  }
}

export function verifyAgyRebuildSeed(input: AgyRebuildSeedVerificationInput): AgyRebuildSeedResult {
  return verifyAgyRebuildSeedInternal(input, {
    requireNoAdditionalWork: input.rejectAdditionalWork !== false,
    requireColdLoadReceipt: input.rejectAdditionalWork === true,
    checkSummarySynchronized: true,
  })
}

export function writeAgyRebuildSeed(input: AgyRebuildSeedInput): AgyRebuildSeedResult {
  assertValidSessionUuid(input.nativeSessionId)
  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)
  const conversationsDir = join(canonicalRoot, 'conversations')
  const convStat = lstatSync(conversationsDir, { bigint: true })
  if (!convStat.isDirectory() || convStat.isSymbolicLink()) {
    throw new Error('Antigravity conversations directory must be an ordinary directory.')
  }

  const serialized = serializeAgyRebuildSeed({
    rebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })

  const imageChunks = input.chunks.filter(
    (chunk): chunk is Extract<AgyRebuildSeedChunk, { kind: 'image' }> => chunk.kind === 'image',
  )
  const providedImages = input.images ?? []
  if (imageChunks.length > 0 && providedImages.length < imageChunks.length) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity rebuild image sources are incomplete.',
      false,
    )
  }

  let imageById = new Map<string, AgentPromptImage>()
  for (const img of providedImages) imageById.set(img.id, img)

  const userTextBytes = Buffer.byteLength(serialized.expectedUserText, 'utf8')
  const assistantTextBytes = Buffer.byteLength(serialized.expectedAssistantText, 'utf8')
  // Preflight accounts for BOTH user_response and items (2x expectedUserText) plus assistant text & images.
  if (userTextBytes * 2 + assistantTextBytes > AGY_MAX_HISTORY_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild encoded text exceeds the 32 MiB history budget.',
      false,
    )
  }

  let totalMediaBytes = 0
  const verifiedMediaPayloads: Array<{
    chunkImage: ConversationImage
    bytes: Buffer
    ext: string
  }> = []
  for (const imgChunk of imageChunks) {
    const resolved = imageById.get(imgChunk.image.id)
    if (!resolved) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity rebuild image source is missing.',
        false,
      )
    }
    requireNativeImageReference(resolved, imgChunk.image)
    const bytes = readVerifiedImmutableImage(resolved)
    totalMediaBytes += bytes.byteLength
    if (userTextBytes * 2 + assistantTextBytes + totalMediaBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild text and images exceed the 32 MiB history budget.',
        false,
      )
    }
    const ext =
      imgChunk.image.mediaType === 'image/png'
        ? 'png'
        : imgChunk.image.mediaType === 'image/jpeg'
          ? 'jpg'
          : 'webp'
    verifiedMediaPayloads.push({ chunkImage: imgChunk.image, bytes, ext })
  }

  const shellHandle = openCandidateShellSnapshotOrThrowUncertain({
    rootDir: configuredRoot,
    canonicalRoot,
    candidateSessionId: input.nativeSessionId,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const shellIdentity = shellHandle.fileIdentity
  let alreadySeeded = false
  let shellSchema: ValidatedTrajectorySchema
  try {
    shellSchema = validateTrajectoryDatabase(
      shellHandle.db,
      input.nativeSessionId,
      shellHandle.proof,
    )
    const counts = shellHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!

    if (counts.stepCount === 2 && counts.genCount === 0 && counts.execCount === 1) {
      alreadySeeded = true
    } else if (counts.stepCount !== 0 || counts.genCount !== 0 || counts.execCount !== 0) {
      throw new Error('Antigravity rebuild candidate database is not an empty zero-Turn shell.')
    }
  } finally {
    shellHandle.close()
  }

  if (alreadySeeded) {
    // Read-only verify candidate seed content FIRST before touching conversation_summaries!
    verifyAgyRebuildSeedInternal(
      {
        ...input,
        expectedSeedHash: serialized.seedHash,
        expectedTrajectoryId: shellSchema.trajectoryId,
      },
      {
        requireNoAdditionalWork: true,
        requireColdLoadReceipt: false,
        checkSummarySynchronized: false,
        omitWitness: true,
      },
    )
    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    ensureSummaryStepCountCas(canonicalRoot, input.nativeSessionId, 2, 0, shellSchema.trajectoryId)
    return verifyAgyRebuildSeedInternal(
      {
        ...input,
        expectedSeedHash: serialized.seedHash,
        expectedTrajectoryId: shellSchema.trajectoryId,
      },
      {
        requireNoAdditionalWork: true,
        requireColdLoadReceipt: false,
        checkSummarySynchronized: true,
        omitWitness: true,
      },
    )
  }

  verifySummaryRowExistsReadOnly(
    canonicalRoot,
    input.nativeSessionId,
    true,
    shellSchema.trajectoryId,
  )

  const expectedUploadedDir = join(canonicalRoot, 'brain', input.nativeSessionId, '.user_uploaded')
  const plannedMediaItems: Array<{
    mimeType: string
    inlineData: Buffer
    uri: string
    fileName: string
    sha256: string
  }> = verifiedMediaPayloads.map((item, idx) => {
    const fileName = `${idx}-${item.chunkImage.id}.${item.ext}`
    const targetMediaPath = join(expectedUploadedDir, fileName)
    return {
      mimeType: item.chunkImage.mediaType,
      inlineData: item.bytes,
      uri: targetMediaPath,
      fileName,
      sha256: item.chunkImage.sha256,
    }
  })

  // Pre-encode exact Protobuf payloads (including BOTH user_response and items) BEFORE writing media or staging SQLite!
  const seedTimestampSec = 1_700_000_000n
  const userMetadata = encodeCortexStepMetadata({
    createdAtSeconds: seedTimestampSec,
    source: 1,
    executionId: serialized.seedExecutionId,
    trajectoryId: shellSchema.trajectoryId,
    stepIndex: 0,
    cascadeId: input.nativeSessionId,
    stepId: serialized.userStepId,
  })
  const userData = encodeAgyUserInputStep({
    metadata: userMetadata,
    text: serialized.expectedUserText,
    media: plannedMediaItems,
  })
  const assistantMetadata = encodeCortexStepMetadata({
    createdAtSeconds: seedTimestampSec,
    createdAtNanos: 1_000_000,
    source: 2,
    executionId: serialized.seedExecutionId,
    trajectoryId: shellSchema.trajectoryId,
    stepIndex: 1,
    cascadeId: input.nativeSessionId,
    stepId: serialized.assistantStepId,
  })
  const assistantData = encodeAgyPlannerResponseStep({
    metadata: assistantMetadata,
    response: serialized.expectedAssistantText,
  })
  const execData = encodeExecutorMetadata({
    terminationReason: EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
    numGeneratorInvocations: 0,
    lastStepIdx: 1,
    executionId: serialized.seedExecutionId,
  })
  const encodedTotalBytes =
    userMetadata.byteLength +
    userData.byteLength +
    assistantMetadata.byteLength +
    assistantData.byteLength +
    execData.byteLength
  if (encodedTotalBytes > AGY_MAX_HISTORY_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild encoded Protobuf payload exceeds the 32 MiB history budget.',
      false,
    )
  }

  // Verify same-volume staging (conversations vs brain/<sid>) BEFORE writing any uploaded media!
  const sameVolumeStage = createSameVolumeCandidateStagingDb(
    canonicalRoot,
    input.nativeSessionId,
    input.stagingLeafName,
  )
  const stagingPath = sameVolumeStage.stagingPath
  let expectedStagedIdentity: AgySqliteFileIdentity

  try {
    if (plannedMediaItems.length > 0) {
      const uploadedDir = ensureSafeDirectoryChain(canonicalRoot, [
        'brain',
        input.nativeSessionId,
        '.user_uploaded',
      ])
      for (const item of plannedMediaItems) {
        const targetMediaPath = join(uploadedDir, item.fileName)
        writeIdempotentPrivateFile(targetMediaPath, canonicalRoot, item.inlineData, item.sha256)
      }
      fsyncDirectoryBestEffort(uploadedDir)
    }

    let expectedDbBytes: bigint
    const reopenShellHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertStagingBound({ expectedSize: 0n })
      const stagingDb = new Database(stagingPath, { fileMustExist: true })
      try {
        sameVolumeStage.assertStagingBound({ expectedSize: 0n })
        initializeStagingFromShell(stagingDb, reopenShellHandle.db, shellSchema)

        stagingDb.exec('BEGIN IMMEDIATE')
        try {
          const hasStepSize = shellSchema.stepColumns.includes('size')
          const hasStepFormat = shellSchema.hasStepFormatColumn
          const insertStepCols = [
            'idx',
            'step_type',
            'status',
            'has_subtrajectory',
            'metadata',
            shellSchema.stepPayloadColumn,
            ...(hasStepFormat ? ['step_format'] : []),
            ...(hasStepSize ? ['size'] : []),
          ]
          const insertStep = stagingDb.prepare(
            `INSERT INTO "steps" (${insertStepCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${insertStepCols.map(() => '?').join(', ')})`,
          )
          insertStep.run(
            0,
            CORTEX_STEP_TYPE_USER_INPUT,
            CORTEX_STEP_STATUS_DONE,
            0,
            userMetadata,
            userData,
            ...(hasStepFormat ? [0] : []),
            ...(hasStepSize ? [userData.byteLength] : []),
          )
          insertStep.run(
            1,
            CORTEX_STEP_TYPE_PLANNER_RESPONSE,
            CORTEX_STEP_STATUS_DONE,
            0,
            assistantMetadata,
            assistantData,
            ...(hasStepFormat ? [0] : []),
            ...(hasStepSize ? [assistantData.byteLength] : []),
          )

          const hasExecSize = shellSchema.execColumns.includes('size')
          const insertExecCols = ['idx', 'data', ...(hasExecSize ? ['size'] : [])]
          stagingDb
            .prepare(
              `INSERT INTO "executor_metadata" (${insertExecCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${insertExecCols.map(() => '?').join(', ')})`,
            )
            .run(0, execData, ...(hasExecSize ? [execData.byteLength] : []))

          stagingDb.exec('COMMIT')
        } catch (error) {
          if (stagingDb.inTransaction) stagingDb.exec('ROLLBACK')
          throw error
        }

        verifySqliteIntegrityOk(stagingDb)
        expectedDbBytes = measureOpenSqliteExpectedBytes(stagingDb)
        sameVolumeStage.assertStagingBound({ expectedSize: expectedDbBytes })
      } finally {
        stagingDb.close()
      }
    } finally {
      reopenShellHandle.close()
    }

    if (expectedDbBytes > BigInt(AGY_MAX_HISTORY_BYTES)) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild staged SQLite database exceeds the 32 MiB history budget.',
        false,
      )
    }
    sameVolumeStage.fsyncVerifiedStaging(expectedDbBytes)

    // Pin expectedStagedIdentity directly from an anchored, locked, integrity-checked snapshot of
    // the exact inode we created (zero stale pathname re-stat drift after SQLite closes).
    const stagedSnapshot = openCommittedSqliteSnapshot({
      rootDir: canonicalRoot,
      canonicalRoot,
      parentSegments: ['brain', input.nativeSessionId],
      leafName: sameVolumeStage.stagingLeafName,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertAnchoredIdentityMatchesCreated(
        stagedSnapshot.fileIdentity,
        expectedDbBytes,
      )
      verifySqliteIntegrityOk(stagedSnapshot.db)
      const stagedSchema = validateTrajectoryDatabase(
        stagedSnapshot.db,
        input.nativeSessionId,
        stagedSnapshot.proof,
      )
      if (stagedSchema.trajectoryId !== shellSchema.trajectoryId) {
        throw new Error('Antigravity rebuild staged trajectoryId disagrees with candidate shell.')
      }
      const stagedCounts = stagedSnapshot.db
        .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
          `SELECT
            (SELECT COUNT(*) FROM "steps") AS stepCount,
            (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
            (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
        )
        .get()!
      if (
        stagedCounts.stepCount !== 2 ||
        stagedCounts.genCount !== 0 ||
        stagedCounts.execCount !== 1
      ) {
        throw new Error('Antigravity rebuild staged database row count failed verification.')
      }
      expectedStagedIdentity = stagedSnapshot.fileIdentity
    } finally {
      stagedSnapshot.close()
    }

    const stagedView = openAnchoredLockedSqliteView(
      canonicalRoot,
      ['brain', input.nativeSessionId],
      sameVolumeStage.stagingLeafName,
      { acquireSharedLock: true, openWal: true, openShm: true, checkJournal: true },
    )
    try {
      if (
        stagedView.hasWal ||
        stagedView.hasShm ||
        stagedView.hasJournal ||
        !identitiesExactMatch(stagedView.fileIdentity, expectedStagedIdentity)
      ) {
        throw new Error(
          'Antigravity rebuild staged database changed or acquired sidefiles before publication.',
        )
      }
    } finally {
      stagedView.close()
    }

    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    publishStagedCandidateOrThrow({
      canonicalRoot,
      candidateSessionId: input.nativeSessionId,
      stagedLeafName: sameVolumeStage.stagingLeafName,
      expectedTargetIdentity: shellIdentity,
      expectedStagedIdentity,
    })
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    sameVolumeStage.cleanup()
  }

  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const publishedIdentity = readAnchoredFileIdentity(
    canonicalRoot,
    ['conversations'],
    `${input.nativeSessionId}.db`,
  )
  if (
    publishedIdentity.dev !== expectedStagedIdentity.dev ||
    publishedIdentity.ino !== expectedStagedIdentity.ino ||
    publishedIdentity.size !== expectedStagedIdentity.size ||
    publishedIdentity.mtimeNs !== expectedStagedIdentity.mtimeNs
  ) {
    throw Object.assign(
      new Error('Antigravity rebuild published candidate database changed after atomic rename.'),
      { code: 'UNCERTAIN' },
    )
  }
  ensureSummaryStepCountCas(canonicalRoot, input.nativeSessionId, 2, 0, shellSchema.trajectoryId)

  return verifyAgyRebuildSeedInternal(
    {
      ...input,
      expectedSeedHash: serialized.seedHash,
      expectedTrajectoryId: shellSchema.trajectoryId,
    },
    {
      requireNoAdditionalWork: true,
      requireColdLoadReceipt: false,
      checkSummarySynchronized: true,
      omitWitness: true,
    },
  )
}

interface DerivedAgyPrefix {
  schema: ValidatedTrajectorySchema
  canonicalRoot: string
  canonicalDbPath: string
  resolvedExecutionId: string
  cutStep: number
  cutGenIdx: number
  cutExecIdx: number
  lastUserStepIdx: number
  prefixMediaCount: number
  mediaDigestsByFileName: ReadonlyMap<string, { byteLength: number; sha256: string }>
  prefixExecutionIds: string[]
  stepPrefixRows: Array<Record<string, unknown>>
  genPrefixRows: Array<Record<string, unknown>>
  execPrefixRows: Array<Record<string, unknown>>
  prefixHash: string
  prefixBytes: number
  prefixRecords: number
  idMap: Array<[string, string]>
}

function buildAgyForkCutMetadata(
  trajectoryId: string,
  executionId: string,
  derived: Pick<
    DerivedAgyPrefix,
    'cutStep' | 'genPrefixRows' | 'execPrefixRows' | 'prefixMediaCount'
  >,
): AgyNativeForkCutMetadata {
  return {
    version: 'pact-agy-fork-cut-v1',
    trajectoryId,
    executionId,
    cutStepIdx: derived.cutStep,
    genMetadataCount: derived.genPrefixRows.length,
    executorMetadataCount: derived.execPrefixRows.length,
    mediaCount: derived.prefixMediaCount,
  }
}

const BOUNDED_STEP_META_MAX_BYTES = 256 * 1024
const BOUNDED_USER_TAIL_BYTES = 128 * 1024

function decodeUtf8TailWindow(slice: Buffer, truncatedPrefix: boolean): string {
  let start = 0
  if (truncatedPrefix) {
    while (start < slice.length && start < 4 && (slice[start]! & 0xc0) === 0x80) {
      start += 1
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(slice.subarray(start))
}

/**
 * Walks top-level Protobuf wire tags of `steps[idx].<stepPayloadColumn>` via SQLite `SUBSTR`
 * without loading multi-MiB post-cut user text, inline images, or planner responses into memory.
 */
function readBoundedStepMetadataAndUserIdentity(
  db: Database.Database,
  stepPayloadSql: string,
  idx: number,
  totalBlobLen: number,
  wantUserIdentity: boolean,
  remainingLargeUserTextBudget: { bytes: number },
): {
  stepType?: number | undefined
  hasUserInput?: boolean | undefined
  payloadMeta?: DecodedCortexStepMetadata | undefined
  userIdentity?: ExtractedPactPromptIdentity | undefined
} {
  if (
    !Number.isSafeInteger(totalBlobLen) ||
    totalBlobLen <= 0 ||
    totalBlobLen > AGY_MAX_HISTORY_BYTES
  ) {
    throw new Error(`Antigravity step ${idx} has invalid or oversized step_payload length.`)
  }
  const substrStmt = db.prepare<[number, number, number], { chunk: Buffer | null }>(
    `SELECT SUBSTR(${stepPayloadSql}, ?, ?) AS chunk FROM "steps" WHERE idx = ?`,
  )
  const readSlice = (zeroOffset: number, len: number): Buffer => {
    if (len <= 0) return Buffer.alloc(0)
    const row = substrStmt.get(zeroOffset + 1, len, idx)
    if (!row || !Buffer.isBuffer(row.chunk) || row.chunk.byteLength !== len) {
      throw new Error(`Antigravity step ${idx} step_payload slice could not be read.`)
    }
    return row.chunk
  }

  let stepType: number | undefined
  let hasUserInput = false
  let payloadMeta: DecodedCortexStepMetadata | undefined
  let userIdentity: ExtractedPactPromptIdentity | undefined
  let pos = 0

  while (pos < totalBlobLen) {
    const headerWindow = readSlice(pos, Math.min(32, totalBlobLen - pos))
    const tagRead = readVarint(headerWindow, 0)
    const wireType = Number(tagRead.value & 0x07n)
    const fieldNumberBig = tagRead.value >> 3n
    if (fieldNumberBig <= 0n || fieldNumberBig > BigInt(MAX_PROTOBUF_FIELD_NUMBER)) {
      throw new Error(`Invalid Protobuf field number in Antigravity step ${idx}.`)
    }
    const fieldNumber = Number(fieldNumberBig)

    if (wireType === PROTOBUF_WIRE_VARINT) {
      const valRead = readVarint(headerWindow, tagRead.nextOffset)
      if (fieldNumber === 1) {
        stepType = toSafeInt32(valRead.value, 'Step.type')
      }
      pos += valRead.nextOffset
    } else if (wireType === PROTOBUF_WIRE_FIXED64) {
      if (pos + tagRead.nextOffset + 8 > totalBlobLen) {
        throw new Error(`Truncated fixed64 in Antigravity step ${idx}.`)
      }
      pos += tagRead.nextOffset + 8
    } else if (wireType === PROTOBUF_WIRE_FIXED32) {
      if (pos + tagRead.nextOffset + 4 > totalBlobLen) {
        throw new Error(`Truncated fixed32 in Antigravity step ${idx}.`)
      }
      pos += tagRead.nextOffset + 4
    } else if (wireType === PROTOBUF_WIRE_BYTES) {
      const lenRead = readVarint(headerWindow, tagRead.nextOffset)
      const byteLen = Number(lenRead.value)
      const dataStart = pos + lenRead.nextOffset
      if (byteLen < 0 || dataStart + byteLen > totalBlobLen) {
        throw new Error(`Truncated length-delimited field in Antigravity step ${idx}.`)
      }
      if (fieldNumber === 5) {
        if (byteLen > BOUNDED_STEP_META_MAX_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            `Antigravity step ${idx} metadata exceeds 256 KiB bound.`,
            false,
          )
        }
        payloadMeta = decodeCortexStepMetadata(readSlice(dataStart, byteLen))
      } else if (fieldNumber === 19) {
        hasUserInput = true
        if (wantUserIdentity && byteLen > 0) {
          let innerPos = dataStart
          const innerEnd = dataStart + byteLen
          let userResponseTail: string | undefined
          let userResponseFullRange: { offset: number; length: number } | undefined
          const smallItemTexts: string[] = []
          const largeItemRanges: Array<{ offset: number; length: number }> = []
          while (innerPos < innerEnd) {
            const innerWin = readSlice(innerPos, Math.min(32, innerEnd - innerPos))
            const iTag = readVarint(innerWin, 0)
            const iWire = Number(iTag.value & 0x07n)
            const iFieldBig = iTag.value >> 3n
            if (iFieldBig <= 0n || iFieldBig > BigInt(MAX_PROTOBUF_FIELD_NUMBER)) {
              throw new Error(`Invalid nested Protobuf field in Antigravity user step ${idx}.`)
            }
            const iField = Number(iFieldBig)
            if (iWire === PROTOBUF_WIRE_VARINT) {
              const iVal = readVarint(innerWin, iTag.nextOffset)
              innerPos += iVal.nextOffset
            } else if (iWire === PROTOBUF_WIRE_FIXED64) {
              if (innerPos + iTag.nextOffset + 8 > innerEnd) {
                throw new Error(`Truncated nested fixed64 in Antigravity user step ${idx}.`)
              }
              innerPos += iTag.nextOffset + 8
            } else if (iWire === PROTOBUF_WIRE_FIXED32) {
              if (innerPos + iTag.nextOffset + 4 > innerEnd) {
                throw new Error(`Truncated nested fixed32 in Antigravity user step ${idx}.`)
              }
              innerPos += iTag.nextOffset + 4
            } else if (iWire === PROTOBUF_WIRE_BYTES) {
              const iLenRead = readVarint(innerWin, iTag.nextOffset)
              const iLen = Number(iLenRead.value)
              const iDataStart = innerPos + iLenRead.nextOffset
              if (iLen < 0 || iDataStart + iLen > innerEnd) {
                throw new Error(`Truncated nested bytes in Antigravity user step ${idx}.`)
              }
              if (iField === 2 && iLen > 0) {
                const tailLen = Math.min(iLen, BOUNDED_USER_TAIL_BYTES)
                const tailSlice = readSlice(iDataStart + (iLen - tailLen), tailLen)
                userResponseTail = decodeUtf8TailWindow(tailSlice, iLen > tailLen)
                if (iLen > tailLen) {
                  userResponseFullRange = { offset: iDataStart, length: iLen }
                }
              } else if (iField === 3 && iLen > 0) {
                if (iLen <= BOUNDED_USER_TAIL_BYTES) {
                  smallItemTexts.push(decodeTextOrScopeItem(readSlice(iDataStart, iLen)))
                } else {
                  largeItemRanges.push({ offset: iDataStart, length: iLen })
                }
              }
              // Note: field 9 (`media`, inline images) is skipped in O(1) without reading bytes!
              innerPos = iDataStart + iLen
            } else {
              throw new Error(`Unsupported nested wire type (${iWire}) in Antigravity step ${idx}.`)
            }
          }
          const candidateText =
            userResponseTail && userResponseTail.length > 0
              ? userResponseTail
              : smallItemTexts.join('')
          if (candidateText.length > 0) {
            userIdentity = extractPactPromptIdentity(candidateText)
          }
          if (
            !userIdentity?.pactRunId &&
            (userResponseFullRange !== undefined || largeItemRanges.length > 0)
          ) {
            if (userResponseFullRange !== undefined) {
              // Only read full >128 KiB user text when within the 8 MiB prefix budget; post-cut >8 MiB steps
              // cannot belong to any valid Fork prefix and are skipped without loading into memory.
              if (
                userResponseFullRange.length <= AGY_TEXT_BUDGET_BYTES &&
                remainingLargeUserTextBudget.bytes >= userResponseFullRange.length
              ) {
                remainingLargeUserTextBudget.bytes -= userResponseFullRange.length
                const fullText = decodeUtf8Strict(
                  readSlice(userResponseFullRange.offset, userResponseFullRange.length),
                )
                userIdentity = extractPactPromptIdentity(fullText)
              }
            } else {
              const totalItemBytes = largeItemRanges.reduce((acc, r) => acc + r.length, 0)
              if (
                totalItemBytes <= AGY_TEXT_BUDGET_BYTES &&
                remainingLargeUserTextBudget.bytes >= totalItemBytes
              ) {
                remainingLargeUserTextBudget.bytes -= totalItemBytes
                const mergedItems = [
                  ...smallItemTexts,
                  ...largeItemRanges.map((r) =>
                    decodeTextOrScopeItem(readSlice(r.offset, r.length)),
                  ),
                ].join('')
                if (mergedItems.length > 0) {
                  userIdentity = extractPactPromptIdentity(mergedItems)
                }
              }
            }
          }
        }
      }
      pos = dataStart + byteLen
    } else {
      throw new Error(`Unsupported Protobuf wire type (${wireType}) in Antigravity step ${idx}.`)
    }
  }

  return {
    ...(stepType !== undefined ? { stepType } : {}),
    ...(hasUserInput ? { hasUserInput } : {}),
    ...(payloadMeta !== undefined ? { payloadMeta } : {}),
    ...(userIdentity !== undefined ? { userIdentity } : {}),
  }
}

function canonicalColumnValueDigest(
  row: Record<string, unknown>,
  colName: string,
): {
  digest: unknown
  extraBytes: number
} {
  const val = row[colName]
  if (val === undefined || val === null) {
    return { digest: null, extraBytes: 0 }
  }
  if (Buffer.isBuffer(val)) {
    return {
      digest: { type: 'blob', byteLength: val.byteLength, sha256: sha256Hex(val) },
      extraBytes: val.byteLength,
    }
  }
  if (typeof val === 'string') {
    const byteLength = Buffer.byteLength(val, 'utf8')
    return {
      digest: { type: 'text', byteLength, sha256: sha256Hex(val) },
      extraBytes: byteLength,
    }
  }
  if (typeof val === 'number') {
    return { digest: { type: 'number', value: val }, extraBytes: 0 }
  }
  if (typeof val === 'bigint') {
    return { digest: { type: 'bigint', value: val.toString() }, extraBytes: 0 }
  }
  throw new Error(`Unsupported SQLite value type for Antigravity step column (${colName}).`)
}

function resolveVerifiedForkMedia(
  canonicalRoot: string,
  sessionId: string,
  plan: AgyMediaCopyPlan,
  requireExternalPresent: boolean,
): { bytes: Buffer; sha256: string; hadExternalFile: boolean } {
  try {
    const externalBytes = readVerifiedUploadedMediaFile(
      canonicalRoot,
      sessionId,
      plan.sourceFilePath,
      AGY_MAX_HISTORY_BYTES,
    )
    const externalSha256 = sha256Hex(externalBytes)
    if (plan.inlineData !== undefined && plan.inlineData.byteLength > 0) {
      if (
        externalBytes.byteLength !== plan.inlineData.byteLength ||
        externalSha256 !== sha256Hex(plan.inlineData)
      ) {
        throw new Error(
          'Antigravity step inline media and external .user_uploaded media bytes disagree.',
        )
      }
    }
    return { bytes: externalBytes, sha256: externalSha256, hadExternalFile: true }
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      if (requireExternalPresent || !plan.inlineData || plan.inlineData.byteLength === 0) {
        throw new Error('Referenced Antigravity uploaded media file is missing.', {
          cause: error,
        })
      }
      const inlineCopy = Buffer.from(plan.inlineData)
      return { bytes: inlineCopy, sha256: sha256Hex(inlineCopy), hadExternalFile: false }
    }
    throw error
  }
}

function deriveVerifiedAgyPrefix(
  db: Database.Database,
  sessionId: string,
  canonicalRoot: string,
  canonicalDbPath: string,
  nativeTurnId: string,
  options: {
    nativeInputIds?: readonly string[]
    responseHash?: string
    requireNoPostCutRows?: boolean
    proof?: AgyPreScannedSqliteProof
    configuredRoot?: string
  },
): DerivedAgyPrefix {
  if (!SAFE_ID_PATTERN.test(nativeTurnId)) {
    throw new Error('Invalid Antigravity nativeTurnId (execution_id).')
  }

  const schema = validateTrajectoryDatabase(db, sessionId, options.proof)

  const execCountRow = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "executor_metadata"')
    .get()
  if (execCountRow && execCountRow.count > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds 10,000 records.',
      false,
    )
  }
  if (
    measureTableColumnsTotalBytes(db, 'executor_metadata', schema.execColumns) >
    AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds the 32 MiB history budget.',
      false,
    )
  }
  const execSelectList = schema.execColumns.map(quoteSqlIdentifier).join(', ')
  const execRows = db
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${execSelectList} FROM "executor_metadata" ORDER BY idx ASC LIMIT ?`,
    )
    .all(AGY_MAX_RECORDS + 1)
  if (execRows.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds 10,000 records.',
      false,
    )
  }

  const decodedExecRows: Array<{ expectedIdx: number; decoded: DecodedExecutorMetadata }> = []
  let hasDirectExecMatch = false
  for (const [expectedIdx, row] of execRows.entries()) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity executor_metadata has non-contiguous idx values.')
    }
    const data = row['data']
    if (!Buffer.isBuffer(data)) {
      throw new Error('Antigravity executor_metadata.data must be a BLOB.')
    }
    const decoded = decodeExecutorMetadata(data)
    if (!decoded.executionId || !SAFE_ID_PATTERN.test(decoded.executionId)) {
      throw new Error('Antigravity executor_metadata row is missing a valid execution_id.')
    }
    if (decoded.executionId === nativeTurnId) {
      hasDirectExecMatch = true
    }
    decodedExecRows.push({ expectedIdx, decoded })
  }

  const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
  const userHeaderSelectSql = schema.hasStepFormatColumn
    ? `SELECT idx, status, metadata, LENGTH(${stepPayloadSql}) AS blob_len, step_format FROM "steps" WHERE step_type = ? ORDER BY idx ASC LIMIT ?`
    : `SELECT idx, status, metadata, LENGTH(${stepPayloadSql}) AS blob_len FROM "steps" WHERE step_type = ? ORDER BY idx ASC LIMIT ?`
  const userHeaderStmt = db.prepare<
    [number, number],
    {
      idx: number
      status: number
      metadata: Buffer | null
      blob_len: number | null
      step_format?: unknown
    }
  >(userHeaderSelectSql)

  const rootUserSeenExecutions = new Set<string>()
  const pactRunMatchedExecutions = new Set<string>()
  const remainingLargeUserTextBudget = { bytes: AGY_TEXT_BUDGET_BYTES }
  let seenUserRowCount = 0
  for (const uRow of userHeaderStmt.iterate(CORTEX_STEP_TYPE_USER_INPUT, AGY_MAX_RECORDS + 1)) {
    seenUserRowCount += 1
    if (seenUserRowCount > AGY_MAX_RECORDS) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity user input steps exceed 10,000 records.',
        false,
      )
    }
    assertCompatibleStepRowFormat(uRow.step_format, schema.hasStepFormatColumn, uRow.idx)
    if (
      typeof uRow.blob_len !== 'number' ||
      uRow.blob_len <= 0 ||
      uRow.blob_len > AGY_MAX_HISTORY_BYTES
    ) {
      throw new Error(
        `Antigravity user input step ${uRow.idx} has missing or oversized ${schema.stepPayloadColumn} BLOB.`,
      )
    }
    const colMeta =
      uRow.metadata && uRow.metadata.length > 0
        ? decodeCortexStepMetadata(uRow.metadata)
        : undefined
    const bounded = readBoundedStepMetadataAndUserIdentity(
      db,
      stepPayloadSql,
      uRow.idx,
      uRow.blob_len,
      uRow.status === CORTEX_STEP_STATUS_DONE,
      remainingLargeUserTextBudget,
    )
    if (
      colMeta?.executionId &&
      bounded.payloadMeta?.executionId &&
      colMeta.executionId !== bounded.payloadMeta.executionId
    ) {
      throw new Error(
        'Antigravity step column metadata and payload metadata execution_id disagree.',
      )
    }
    const execId = colMeta?.executionId ?? bounded.payloadMeta?.executionId
    if (uRow.status === CORTEX_STEP_STATUS_DONE && execId) {
      const pactRunId = bounded.userIdentity?.pactRunId
      if (!rootUserSeenExecutions.has(execId)) {
        rootUserSeenExecutions.add(execId)
        if (pactRunId === nativeTurnId) {
          pactRunMatchedExecutions.add(execId)
        }
      } else if (pactRunId === nativeTurnId) {
        throw new Error('Antigravity non-root user input unexpectedly carries root pactRunId.')
      }
    }
  }

  if (pactRunMatchedExecutions.size > 1) {
    throw new Error('Multiple Antigravity executions match pactRunId; failing closed.')
  }
  const directExecMatch = hasDirectExecMatch ? nativeTurnId : undefined
  const pactRunExecMatch =
    pactRunMatchedExecutions.size === 1 ? [...pactRunMatchedExecutions][0] : undefined
  if (directExecMatch && pactRunExecMatch && directExecMatch !== pactRunExecMatch) {
    throw new Error(
      'Antigravity trajectory has conflicting direct execution_id and pactRunId matches.',
    )
  }
  const resolvedExecutionId = directExecMatch ?? pactRunExecMatch
  if (!resolvedExecutionId) {
    throw new Error('Antigravity trajectory has no completed execution matching nativeTurnId.')
  }

  let cutExecIdx = -1
  let cutStep = -1
  let targetExecDecoded: DecodedExecutorMetadata | undefined
  const prefixExecutionIds: string[] = []
  const prefixExecutionSet = new Set<string>()
  let prevLastStep = -1

  for (const { expectedIdx, decoded } of decodedExecRows) {
    if (cutExecIdx < 0) {
      if (prefixExecutionSet.has(decoded.executionId!)) {
        throw new Error('Antigravity executor_metadata contains duplicate execution_id in prefix.')
      }
      if (decoded.terminationReason === EXECUTOR_TERMINATION_REASON_UNSPECIFIED) {
        throw new Error('Antigravity prefix contains an unfinished execution.')
      }
      const rowLastStep = decoded.lastStepIdx ?? 0
      if (rowLastStep <= prevLastStep) {
        throw new Error('Antigravity executor_metadata last_step_idx is not strictly increasing.')
      }
      prevLastStep = rowLastStep
      prefixExecutionIds.push(decoded.executionId!)
      prefixExecutionSet.add(decoded.executionId!)

      if (decoded.executionId === resolvedExecutionId) {
        if (
          decoded.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
          Boolean(decoded.executionError)
        ) {
          throw new Error(
            'Antigravity selected Fork Turn did not complete with normal termination_reason = 4.',
          )
        }
        if (decoded.lastStepIdx === undefined || decoded.lastStepIdx < 1) {
          throw new Error('Antigravity selected Fork Turn has an invalid last_step_idx.')
        }
        cutExecIdx = expectedIdx
        cutStep = decoded.lastStepIdx
        targetExecDecoded = decoded
      }
    } else {
      if (options.requireNoPostCutRows) {
        throw new Error(
          'Antigravity Fork candidate contains extra executor_metadata rows after its frozen cutoff.',
        )
      }
      if (prefixExecutionSet.has(decoded.executionId!)) {
        throw new Error('Antigravity post-cut executor_metadata reuses a prefix execution_id.')
      }
      if ((decoded.lastStepIdx ?? 0) <= cutStep) {
        throw new Error(
          'Antigravity post-cut executor_metadata references a step at or before cutStep.',
        )
      }
    }
  }

  if (cutExecIdx < 0 || cutStep < 1 || !targetExecDecoded) {
    throw new Error('Antigravity trajectory has no completed execution matching nativeTurnId.')
  }
  if (cutStep + 1 > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity trajectory prefix exceeds the 10,000-record budget.',
      false,
    )
  }

  const genCountRow = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
    .get()
  if (genCountRow && genCountRow.count > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds 10,000 records.',
      false,
    )
  }
  if (
    measureTableColumnsTotalBytes(db, 'gen_metadata', schema.genColumns) > AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds the 32 MiB history budget.',
      false,
    )
  }
  const genSelectList = schema.genColumns.map(quoteSqlIdentifier).join(', ')
  const genRows = db
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${genSelectList} FROM "gen_metadata" ORDER BY idx ASC LIMIT ?`,
    )
    .all(AGY_MAX_RECORDS + 1)
  if (genRows.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds 10,000 records.',
      false,
    )
  }

  let cutGenIdx = -1
  let postCutGenStarted = false
  let targetGenCount = 0
  const genExpectedStepOwner = new Map<number, string>()

  for (const [expectedIdx, row] of genRows.entries()) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity gen_metadata has non-contiguous idx values.')
    }
    const data = row['data']
    if (!Buffer.isBuffer(data)) {
      throw new Error('Antigravity gen_metadata.data must be a BLOB.')
    }
    const decoded = decodeCortexStepGeneratorMetadata(data)
    if (!decoded.executionId || !SAFE_ID_PATTERN.test(decoded.executionId)) {
      throw new Error('Antigravity gen_metadata row is missing a valid execution_id.')
    }

    const inPrefix = prefixExecutionSet.has(decoded.executionId)
    if (inPrefix) {
      if (postCutGenStarted) {
        throw new Error('Antigravity gen_metadata interleaves prefix and post-cut executions.')
      }
      if (decoded.hasCompactionCheckpoint) {
        throw new Error(
          'Antigravity gen_metadata indicates /compact checkpoint coverage in prefix.',
        )
      }
      for (const entry of decoded.customMetadata) {
        if (entry.key === 'trajectory_id' && entry.value && entry.value !== schema.trajectoryId) {
          throw new Error('Antigravity gen_metadata has mismatched trajectory_id.')
        }
        if (
          (entry.key === 'cascade_id' || entry.key === 'root_cascade_id') &&
          entry.value &&
          entry.value !== sessionId
        ) {
          throw new Error(`Antigravity gen_metadata has mismatched ${entry.key}.`)
        }
      }
      for (const sIdx of decoded.stepIndices) {
        if (sIdx < 0 || sIdx > cutStep) {
          throw new Error('Antigravity prefix gen_metadata references a step_index beyond cutStep.')
        }
        genExpectedStepOwner.set(sIdx, decoded.executionId)
      }
      if (decoded.executionId === resolvedExecutionId) targetGenCount += 1
      cutGenIdx = expectedIdx
    } else {
      if (options.requireNoPostCutRows) {
        throw new Error(
          'Antigravity Fork candidate contains extra gen_metadata rows after its frozen cutoff.',
        )
      }
      postCutGenStarted = true
      for (const sIdx of decoded.stepIndices) {
        if (sIdx <= cutStep) {
          throw new Error(
            'Antigravity post-cut gen_metadata references a step_index inside the prefix.',
          )
        }
      }
    }
  }

  if (
    targetExecDecoded.numGeneratorInvocations > 0 &&
    targetGenCount !== targetExecDecoded.numGeneratorInvocations
  ) {
    throw new Error(
      'Antigravity gen_metadata invocation count does not match executor_metadata.num_generator_invocations.',
    )
  }

  const totalStepBounds = db
    .prepare<[], { minIdx: number | null; maxIdx: number | null; count: number }>(
      'SELECT MIN(idx) AS minIdx, MAX(idx) AS maxIdx, COUNT(*) AS count FROM "steps"',
    )
    .get()!
  if (
    totalStepBounds.count <= 0 ||
    totalStepBounds.minIdx !== 0 ||
    totalStepBounds.maxIdx === null ||
    totalStepBounds.maxIdx < cutStep
  ) {
    throw new Error('Antigravity steps table bounds are incomplete or missing 0..cutStep.')
  }
  if (
    options.requireNoPostCutRows &&
    (totalStepBounds.maxIdx > cutStep || totalStepBounds.count !== cutStep + 1)
  ) {
    throw new Error('Antigravity Fork candidate contains extra steps after its frozen cutoff.')
  }

  if (totalStepBounds.maxIdx > cutStep) {
    const postCutHeaderSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, LENGTH(${stepPayloadSql}) AS payload_len, step_format FROM "steps" WHERE idx > ? ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" WHERE idx > ? ORDER BY idx ASC`
    const postCutHeaderStmt = db.prepare<
      [number],
      {
        idx: number
        step_type: number
        status: number
        has_subtrajectory: number
        metadata: Buffer | null
        payload_len: number | null
        step_format?: unknown
      }
    >(postCutHeaderSelectSql)
    let checkedHeaders = 0
    for (const rawHeader of postCutHeaderStmt.iterate(cutStep)) {
      checkedHeaders += 1
      if (checkedHeaders > AGY_MAX_RECORDS * 10) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity post-cut header verification exceeded safety bound.',
          false,
        )
      }
      assertCompatibleStepRowFormat(
        rawHeader.step_format,
        schema.hasStepFormatColumn,
        rawHeader.idx,
      )
      if (
        typeof rawHeader.payload_len !== 'number' ||
        rawHeader.payload_len <= 0 ||
        rawHeader.payload_len > AGY_MAX_HISTORY_BYTES
      ) {
        throw new Error(
          `Antigravity post-cut step ${rawHeader.idx} is missing verifiable step_payload attribution.`,
        )
      }
      const columnMeta =
        rawHeader.metadata && rawHeader.metadata.length > 0
          ? decodeCortexStepMetadata(rawHeader.metadata)
          : undefined
      const boundedPost = readBoundedStepMetadataAndUserIdentity(
        db,
        stepPayloadSql,
        rawHeader.idx,
        rawHeader.payload_len,
        false,
        { bytes: 0 },
      )
      if (
        columnMeta?.executionId &&
        boundedPost.payloadMeta?.executionId &&
        columnMeta.executionId !== boundedPost.payloadMeta.executionId
      ) {
        throw new Error(
          'Antigravity post-cut step column metadata and payload metadata execution_id disagree.',
        )
      }
      const effectivePostExecId = columnMeta?.executionId ?? boundedPost.payloadMeta?.executionId
      if (!effectivePostExecId || !SAFE_ID_PATTERN.test(effectivePostExecId)) {
        throw new Error(
          `Antigravity post-cut step ${rawHeader.idx} is missing verifiable execution_id attribution.`,
        )
      }
      if (prefixExecutionSet.has(effectivePostExecId)) {
        throw new Error(
          'Antigravity post-cut step carries an execution_id belonging to the frozen prefix.',
        )
      }
    }
  }

  // Stream LENGTH checks on 0..cutStep first so oversized BLOBs fail before allocation!
  const prefixLengthStmt = db.prepare<
    [number],
    { idx: number; meta_len: number | null; payload_len: number | null }
  >(
    `SELECT idx, LENGTH(metadata) AS meta_len, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" WHERE idx >= 0 AND idx <= ? ORDER BY idx ASC`,
  )
  let checkedPrefixCount = 0
  for (const lenRow of prefixLengthStmt.iterate(cutStep)) {
    if (lenRow.idx !== checkedPrefixCount) {
      throw new Error(
        'Antigravity steps prefix 0..cutStep has missing step indices (gap detected).',
      )
    }
    if ((lenRow.meta_len ?? 0) > AGY_TEXT_BUDGET_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork step metadata exceeds the 8 MiB budget.',
        false,
      )
    }
    if (typeof lenRow.payload_len !== 'number' || lenRow.payload_len <= 0) {
      throw new Error(
        `Antigravity step ${lenRow.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
      )
    }
    if (lenRow.payload_len > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork prefix exceeds the 32 MiB history budget.',
        false,
      )
    }
    checkedPrefixCount += 1
  }
  if (checkedPrefixCount !== cutStep + 1) {
    throw new Error('Antigravity steps prefix 0..cutStep has missing step indices (gap detected).')
  }

  const genPrefixRows = cutGenIdx >= 0 ? genRows.slice(0, cutGenIdx + 1) : []
  const execPrefixRows = execRows.slice(0, cutExecIdx + 1)
  const prefixRecords = checkedPrefixCount + genPrefixRows.length + execPrefixRows.length
  if (prefixRecords > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity closed Fork prefix exceeds the 10,000-record budget.',
      false,
    )
  }

  const normalizeRemap: AgyIdentityRemap = {
    sourceTrajectoryId: schema.trajectoryId,
    targetTrajectoryId: '$trajectory',
    sourceCascadeId: sessionId,
    targetCascadeId: '$cascade',
    canonicalAppDataDir: canonicalRoot,
    ...(options.configuredRoot !== undefined
      ? { configuredAppDataDir: options.configuredRoot }
      : {}),
  }

  let prefixBytes = 0
  let prefixImageBytes = 0
  let prefixMediaCount = 0
  let maxSeenExecRank = 0
  let lastUserStepIdx = -1
  let targetSectionStarted = false
  const execRankMap = new Map(prefixExecutionIds.map((id, rank) => [id, rank]))

  const targetUserSteps: AgyConsumedInputReceipt[] = []
  const prefixInputIdentityCandidates: string[] = []
  const targetPlannerItems: Array<{ id: string; text: string }> = []
  const stepPrefixRows: Array<Record<string, unknown>> = []
  const normalizedStepsDigest: Array<Record<string, unknown>> = []
  const mediaDigestsByFileName = new Map<string, { byteLength: number; sha256: string }>()
  const extraNonStandardCols = schema.stepColumns.filter(
    (col) =>
      ![
        'idx',
        'step_type',
        'status',
        'has_subtrajectory',
        'metadata',
        schema.stepPayloadColumn,
        'step_format',
        'size',
        'error_details',
        'permissions',
        'task_details',
        'render_info',
      ].includes(col),
  )

  if (
    measureTableColumnsTotalBytes(db, 'steps', schema.stepColumns, {
      sql: 'idx >= 0 AND idx <= ?',
      params: [cutStep],
    }) > AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork prefix exceeds the 32 MiB history budget.',
      false,
    )
  }
  const stepPrefixSelectList = schema.stepColumns.map(quoteSqlIdentifier).join(', ')
  const stepPrefixStmt = db.prepare<[number], Record<string, unknown>>(
    `SELECT ${stepPrefixSelectList} FROM "steps" WHERE idx >= 0 AND idx <= ? ORDER BY idx ASC`,
  )
  let expectedIdx = 0
  for (const row of stepPrefixStmt.iterate(cutStep)) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity steps prefix 0..cutStep has a step index gap.')
    }
    const stepType = row['step_type']
    const status = row['status']
    const hasSubtrajectory = row['has_subtrajectory']
    const rawMeta = optionalBufferField(row, 'metadata')
    assertCompatibleStepRowFormat(row['step_format'], schema.hasStepFormatColumn, expectedIdx)
    const rawData = row[schema.stepPayloadColumn]

    if (typeof stepType !== 'number' || typeof status !== 'number' || !Buffer.isBuffer(rawData)) {
      throw new Error(`Antigravity step ${expectedIdx} has invalid column types.`)
    }
    if (
      hasSubtrajectory !== 0 &&
      hasSubtrajectory !== false &&
      hasSubtrajectory !== null &&
      hasSubtrajectory !== undefined
    ) {
      throw new Error(`Antigravity step ${expectedIdx} has an unclosed subtrajectory.`)
    }
    if (status === CORTEX_STEP_STATUS_CLEARED) {
      throw new Error(
        `Antigravity step ${expectedIdx} has status CLEARED; /compact prefix rewrite rejected.`,
      )
    }
    if (
      stepType === CORTEX_STEP_TYPE_CHECKPOINT ||
      stepType === CORTEX_STEP_TYPE_CONVERSATION_HISTORY
    ) {
      throw new Error(
        `Antigravity step ${expectedIdx} is a compaction/history step; /compact prefix rejected.`,
      )
    }
    if (
      stepType === CORTEX_STEP_TYPE_INVOKE_SUBAGENT ||
      stepType === CORTEX_STEP_TYPE_BROWSER_SUBAGENT
    ) {
      throw new Error(`Antigravity step ${expectedIdx} invokes a subagent; failing closed.`)
    }

    const decodedStep = decodeAgyStep(rawData)
    if (decodedStep.type !== stepType || decodedStep.status !== status) {
      throw new Error(`Antigravity step ${expectedIdx} header columns disagree with Step payload.`)
    }
    if (decodedStep.hasSubtrajectoryField) {
      throw new Error(`Antigravity step ${expectedIdx} payload embeds an unclosed subtrajectory.`)
    }
    if (decodedStep.hasCompaction) {
      throw new Error(
        `Antigravity step ${expectedIdx} payload contains compaction data; /compact rejected.`,
      )
    }

    const meta = extractEffectiveStepMetadata(rawMeta, decodedStep)
    if (!meta.executionId || !execRankMap.has(meta.executionId)) {
      throw new Error(
        `Antigravity step ${expectedIdx} carries an unknown or post-cut execution_id.`,
      )
    }
    const rank = execRankMap.get(meta.executionId)!
    if (rank < maxSeenExecRank) {
      throw new Error(
        `Antigravity step ${expectedIdx} rewrites an earlier prefix position out of execution order.`,
      )
    }
    maxSeenExecRank = rank

    const expectedGenOwner = genExpectedStepOwner.get(expectedIdx)
    if (expectedGenOwner !== undefined && expectedGenOwner !== meta.executionId) {
      throw new Error(
        `Antigravity step ${expectedIdx} execution_id disagrees with gen_metadata.step_indices.`,
      )
    }

    if (stepType === CORTEX_STEP_TYPE_USER_INPUT) {
      lastUserStepIdx = expectedIdx
      if (decodedStep.userInput) prefixMediaCount += decodedStep.userInput.media.length
      if (status === CORTEX_STEP_STATUS_DONE && decodedStep.userInput) {
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        for (const candidateId of [
          meta.stepId,
          decodedStep.userInput.clientMessageId,
          pactIdentity.messageId,
          pactIdentity.pactRunId,
        ]) {
          if (candidateId && candidateId.length > 0 && candidateId.length <= 1024) {
            prefixInputIdentityCandidates.push(candidateId)
          }
        }
      }
    }

    const normalizedMeta = rawMeta
      ? remapCortexStepMetadata(rawMeta, normalizeRemap, expectedIdx)
      : Buffer.alloc(0)
    const normalizedStep = remapAgyStep(rawData, normalizeRemap, expectedIdx)

    const hasSubDigest = canonicalColumnValueDigest(row, 'has_subtrajectory')
    const errorDetailsDigest = canonicalColumnValueDigest(row, 'error_details')
    const permissionsDigest = canonicalColumnValueDigest(row, 'permissions')
    const taskDetailsDigest = canonicalColumnValueDigest(row, 'task_details')
    const renderInfoDigest = canonicalColumnValueDigest(row, 'render_info')
    const extraColumnDigests: Record<string, unknown> = {}
    let extraColumnBytes =
      errorDetailsDigest.extraBytes +
      permissionsDigest.extraBytes +
      taskDetailsDigest.extraBytes +
      renderInfoDigest.extraBytes
    for (const col of extraNonStandardCols) {
      const colRes = canonicalColumnValueDigest(row, col)
      if (colRes.digest !== null) {
        extraColumnDigests[col] = colRes.digest
        extraColumnBytes += colRes.extraBytes
      }
    }

    const stepMediaDigest: Array<{
      targetUri: string
      fileName: string
      byteLength: number
      sha256: string
    }> = []
    for (const plan of normalizedStep.copiedMedia) {
      const verifiedMedia = resolveVerifiedForkMedia(
        canonicalRoot,
        sessionId,
        plan,
        Boolean(options.requireNoPostCutRows),
      )
      const prevDigest = mediaDigestsByFileName.get(plan.fileName)
      if (
        prevDigest &&
        (prevDigest.byteLength !== verifiedMedia.bytes.byteLength ||
          prevDigest.sha256 !== verifiedMedia.sha256)
      ) {
        throw new Error(
          'Antigravity Fork uploaded media digest changed across steps in the same prefix.',
        )
      }
      mediaDigestsByFileName.set(plan.fileName, {
        byteLength: verifiedMedia.bytes.byteLength,
        sha256: verifiedMedia.sha256,
      })
      if (!plan.inlineData || plan.inlineData.byteLength === 0) {
        prefixBytes += verifiedMedia.bytes.byteLength
        prefixImageBytes += verifiedMedia.bytes.byteLength
      }
      stepMediaDigest.push({
        targetUri: plan.targetUri,
        fileName: plan.fileName,
        byteLength: verifiedMedia.bytes.byteLength,
        sha256: verifiedMedia.sha256,
      })
    }

    prefixBytes += normalizedMeta.byteLength + normalizedStep.buffer.byteLength + extraColumnBytes
    prefixImageBytes += normalizedStep.inlineImageBytes
    if (prefixBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork prefix exceeds the 32 MiB history budget.',
        false,
      )
    }
    if (prefixBytes - prefixImageBytes > AGY_TEXT_BUDGET_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork text/metadata prefix exceeds the 8 MiB budget.',
        false,
      )
    }

    normalizedStepsDigest.push({
      idx: expectedIdx,
      stepType,
      status,
      hasSubtrajectory: hasSubDigest.digest,
      stepFormat: schema.hasStepFormatColumn ? row['step_format'] : 0,
      errorDetails: errorDetailsDigest.digest,
      permissions: permissionsDigest.digest,
      taskDetails: taskDetailsDigest.digest,
      renderInfo: renderInfoDigest.digest,
      ...(Object.keys(extraColumnDigests).length > 0 ? { extraColumns: extraColumnDigests } : {}),
      metaBytes: normalizedMeta.byteLength,
      metaSha256: sha256Hex(normalizedMeta),
      dataBytes: normalizedStep.buffer.byteLength,
      dataSha256: sha256Hex(normalizedStep.buffer),
      media: stepMediaDigest,
    })

    if (meta.executionId === resolvedExecutionId) {
      targetSectionStarted = true
      if (
        [
          CORTEX_STEP_STATUS_PENDING,
          CORTEX_STEP_STATUS_RUNNING,
          CORTEX_STEP_STATUS_GENERATING,
          CORTEX_STEP_STATUS_WAITING,
          CORTEX_STEP_STATUS_QUEUED,
          CORTEX_STEP_STATUS_CANCELED,
          CORTEX_STEP_STATUS_INTERRUPTED,
        ].includes(status)
      ) {
        throw new Error(
          `Antigravity selected Turn step ${expectedIdx} is not in a settled terminal state.`,
        )
      }
      if (stepType === CORTEX_STEP_TYPE_USER_INPUT) {
        if (status !== CORTEX_STEP_STATUS_DONE || !decodedStep.userInput || decodedStep.hasError) {
          throw new Error(`Antigravity selected Turn user input step ${expectedIdx} is incomplete.`)
        }
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        targetUserSteps.push({
          stepIndex: expectedIdx,
          ...(meta.stepId ? { stepId: meta.stepId } : {}),
          ...(decodedStep.userInput.clientMessageId
            ? { clientMessageId: decodedStep.userInput.clientMessageId }
            : {}),
          ...(pactIdentity.messageId ? { pactMessageId: pactIdentity.messageId } : {}),
          ...(pactIdentity.pactRunId ? { pactRunId: pactIdentity.pactRunId } : {}),
          textSha256: sha256Hex(decodedStep.userInput.text),
        })
      } else if (stepType === CORTEX_STEP_TYPE_PLANNER_RESPONSE) {
        if (
          status !== CORTEX_STEP_STATUS_DONE ||
          !decodedStep.plannerResponse ||
          decodedStep.hasError
        ) {
          throw new Error(
            `Antigravity selected Turn planner response step ${expectedIdx} is incomplete.`,
          )
        }
        if (decodedStep.plannerResponse.canonicalText.length > 0) {
          targetPlannerItems.push({
            id: meta.stepId ?? `step:${expectedIdx}`,
            text: decodedStep.plannerResponse.canonicalText,
          })
        }
      }
    } else if (targetSectionStarted) {
      throw new Error('Antigravity selected Turn steps are not contiguous through cutStep.')
    }

    stepPrefixRows.push(row)
    expectedIdx += 1
  }

  if (targetUserSteps.length < 1) {
    throw new Error('Antigravity selected Turn contains no consumed CortexStepUserInput.')
  }

  if (options.nativeInputIds !== undefined) {
    if (options.nativeInputIds.length !== targetUserSteps.length) {
      throw new Error(
        `Antigravity consumed input count (${targetUserSteps.length}) does not match expected nativeInputIds (${options.nativeInputIds.length}).`,
      )
    }
    for (const [inputOrdinal, expectedId] of options.nativeInputIds.entries()) {
      const actual = targetUserSteps[inputOrdinal]!
      const matchesRootTurnId =
        inputOrdinal === 0 &&
        (expectedId === actual.pactRunId ||
          (!actual.pactRunId && expectedId === resolvedExecutionId))
      const matchesStepIdentity =
        expectedId === actual.stepId ||
        expectedId === actual.clientMessageId ||
        expectedId === actual.pactMessageId
      if (!matchesRootTurnId && !matchesStepIdentity) {
        throw new Error(
          `Antigravity consumed input at ordinal ${inputOrdinal} does not match expected nativeInputIds.`,
        )
      }
    }
  } else if (targetUserSteps.length !== 1 && !options.requireNoPostCutRows) {
    throw new Error(
      'Antigravity Turn consumed multiple Steer inputs without explicit nativeInputIds authorization.',
    )
  }

  if (options.responseHash !== undefined) {
    const canonicalAnswer = projectCollaborationAnswer(targetPlannerItems)
    if (sha256Hex(canonicalAnswer) !== options.responseHash) {
      throw new Error(
        'Antigravity complete native planner response does not match the selected Pact answer.',
      )
    }
  }

  const normalizedGenDigest = genPrefixRows.map((row, genIdx) => {
    const rawData = requireBufferField(row, 'data')
    const normalized = remapCortexStepGeneratorMetadata(rawData, normalizeRemap)
    prefixBytes += normalized.byteLength
    return { idx: genIdx, dataSha256: sha256Hex(normalized) }
  })

  const normalizedExecDigest = execPrefixRows.map((row, execIdx) => {
    const rawData = requireBufferField(row, 'data')
    prefixBytes += rawData.byteLength
    return { idx: execIdx, dataSha256: sha256Hex(rawData) }
  })

  if (
    prefixBytes > AGY_MAX_HISTORY_BYTES ||
    prefixBytes - prefixImageBytes > AGY_TEXT_BUDGET_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork prefix metadata exceeds its byte budget.',
      false,
    )
  }

  const prefixHash = sha256CanonicalJson({
    domain: 'agy-native-prefix-v1',
    cutStep,
    cutGenIdx,
    cutExecIdx,
    steps: normalizedStepsDigest,
    genMetadata: normalizedGenDigest,
    executorMetadata: normalizedExecDigest,
  })

  const seenIdMapKeys = new Set<string>()
  const idMap: Array<[string, string]> = []
  for (const id of [...prefixExecutionIds, ...prefixInputIdentityCandidates]) {
    if (!id || id.length > 1024 || seenIdMapKeys.has(id)) continue
    seenIdMapKeys.add(id)
    idMap.push([id, id])
  }
  if (idMap.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork identity map exceeds the 10,000-record budget.',
      false,
    )
  }

  return {
    schema,
    canonicalRoot,
    canonicalDbPath,
    resolvedExecutionId,
    cutStep,
    cutGenIdx,
    cutExecIdx,
    lastUserStepIdx,
    prefixMediaCount,
    mediaDigestsByFileName,
    prefixExecutionIds,
    stepPrefixRows,
    genPrefixRows,
    execPrefixRows,
    prefixHash,
    prefixBytes: Math.max(1, prefixBytes),
    prefixRecords,
    idMap,
  }
}

export function prepareAgyFork(input: AgyForkInput): AgyForkOperationResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const sourceSessionId = input.source?.nativeSessionId ?? input.nativeSessionId
  const nativeTurnId = input.source?.nativeTurnId ?? input.nativeTurnId
  const effectiveInputIds = input.nativeInputIds ?? input.source?.nativeInputIds
  assertValidSessionUuid(sourceSessionId, 'Antigravity source Session UUID')
  if (!nativeTurnId) {
    throw new Error('Antigravity Fork preparation requires nativeTurnId (execution_id).')
  }
  if (!input.source && !input.responseHash) {
    throw new Error('Antigravity Fork preparation requires expected responseHash.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${sourceSessionId}.db`,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  try {
    const derived = deriveVerifiedAgyPrefix(
      snapshotHandle.db,
      sourceSessionId,
      canonicalRoot,
      snapshotHandle.canonicalDbPath,
      nativeTurnId,
      {
        proof: snapshotHandle.proof,
        configuredRoot,
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })

    if (
      input.source &&
      (input.source.nativeCutId !== derived.resolvedExecutionId ||
        input.source.prefixHash !== derived.prefixHash ||
        (input.source.agyCut !== undefined &&
          (input.source.agyCut.trajectoryId !== derived.schema.trajectoryId ||
            input.source.agyCut.executionId !== derived.resolvedExecutionId ||
            input.source.agyCut.cutStepIdx !== derived.cutStep)))
    ) {
      throw new Error('Prepared Antigravity native prefix changed before Fork.')
    }

    return {
      nativeSessionId: sourceSessionId,
      nativeCutId: derived.resolvedExecutionId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: '',
      rawBytes: 0,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: derived.schema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: buildAgyForkCutMetadata(
        derived.schema.trajectoryId,
        derived.resolvedExecutionId,
        derived,
      ),
    }
  } finally {
    snapshotHandle.close()
  }
}

export function inspectAgyFork(input: AgyForkInput): AgyForkOperationResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const witness = input.witness
  if (!witness || witness.nativeSessionId !== input.nativeSessionId || !witness.idMap.length) {
    throw new Error('Antigravity Fork witness is missing.')
  }
  assertValidSessionUuid(input.nativeSessionId, 'Antigravity candidate Session UUID')
  assertValidSessionUuid(witness.sourceNativeSessionId, 'Antigravity source Session UUID')

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)
  if (witness.nativeStorageRoot && canonicalRoot !== witness.nativeStorageRoot) {
    throw new Error('The effective Antigravity native storage root changed.')
  }

  const checkSourceStillValid = (): void => {
    if (!input.source) return
    prepareAgyFork({
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      cwd: input.cwd,
      nativeSessionId: input.source.nativeSessionId,
      nativeTurnId: input.source.nativeTurnId,
      source: input.source,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  }

  let snapshotHandle: CommittedSqliteSnapshotHandle
  try {
    snapshotHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (error instanceof AgyStorageMissingError) {
      if (input.lastDispatchedPhase === 'fork' && input.source) {
        checkSourceStillValid()
        throw Object.assign(
          new Error(
            'The recorded Antigravity Fork candidate database is absent; the original source cut remains intact.',
          ),
          { code: 'native_file_fork_candidate_missing' },
        )
      }
      throw new Error('Antigravity Fork candidate database does not exist.', { cause: error })
    }
    throw error
  }
  if (witness.nativePath && snapshotHandle.canonicalDbPath !== witness.nativePath) {
    snapshotHandle.close()
    throw new Error('The recorded Antigravity native Fork path changed.')
  }

  let derived: DerivedAgyPrefix
  try {
    // Proof-first table verification BEFORE preparing ANY SQL on business tables!
    assertProofHasOrdinaryTables(snapshotHandle.proof, REQUIRED_TRAJECTORY_TABLES)
    const counts = snapshotHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!
    if (counts.stepCount === 0 && counts.genCount === 0 && counts.execCount === 0) {
      validateTrajectoryDatabase(snapshotHandle.db, input.nativeSessionId, snapshotHandle.proof)
      assertAnchoredSourceUnchanged({
        rootDir: configuredRoot,
        canonicalRoot,
        parentSegments: ['conversations'],
        leafName: `${input.nativeSessionId}.db`,
        expectedIdentity: snapshotHandle.fileIdentity,
        expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      })
      if (input.lastDispatchedPhase === 'fork' && input.source) {
        checkSourceStillValid()
        assertAnchoredSourceUnchanged({
          rootDir: configuredRoot,
          canonicalRoot,
          parentSegments: ['conversations'],
          leafName: `${input.nativeSessionId}.db`,
          expectedIdentity: snapshotHandle.fileIdentity,
          expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
        })
        throw Object.assign(
          new Error(
            'Antigravity Fork candidate is still an unpopulated zero-Turn shell; the original source cut remains intact.',
          ),
          { code: 'native_file_fork_candidate_missing' },
        )
      }
      throw new Error(
        'Antigravity Fork candidate is still an unpopulated zero-Turn shell; publication did not complete.',
      )
    }
    const inspectInputIds = input.nativeInputIds ?? input.source?.nativeInputIds
    derived = deriveVerifiedAgyPrefix(
      snapshotHandle.db,
      input.nativeSessionId,
      canonicalRoot,
      snapshotHandle.canonicalDbPath,
      witness.sourceCutId,
      {
        proof: snapshotHandle.proof,
        configuredRoot,
        requireNoPostCutRows: true,
        ...(inspectInputIds !== undefined ? { nativeInputIds: inspectInputIds } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
    })
  } finally {
    snapshotHandle.close()
  }

  if (
    derived.prefixHash !== witness.candidatePrefixHash ||
    derived.prefixHash !== witness.sourcePrefixHash ||
    (input.source && derived.prefixHash !== input.source.prefixHash)
  ) {
    throw new Error('Antigravity Fork prefix hash differs from its frozen witness.')
  }
  if (JSON.stringify(derived.idMap) !== JSON.stringify(witness.idMap)) {
    throw new Error('Antigravity Fork execution_id map differs from its witness.')
  }
  if (
    witness.candidatePrefixRecords !== undefined &&
    derived.prefixRecords !== witness.candidatePrefixRecords
  ) {
    throw new Error('Antigravity Fork candidate record count differs from its witness.')
  }
  if (witness.cutStepIdx !== undefined && derived.cutStep !== witness.cutStepIdx) {
    throw new Error('Antigravity Fork candidate cutStepIdx differs from its witness.')
  }
  if (
    witness.candidateTrajectoryId !== undefined &&
    derived.schema.trajectoryId !== witness.candidateTrajectoryId
  ) {
    throw new Error('Antigravity Fork candidate trajectory_id differs from its witness.')
  }
  if (
    witness.agyCut !== undefined &&
    (witness.agyCut.cutStepIdx !== derived.cutStep ||
      witness.agyCut.executionId !== witness.sourceCutId)
  ) {
    throw new Error('Antigravity Fork candidate agyCut metadata differs from its witness.')
  }

  const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
  if (summary.stepCount !== derived.cutStep + 1) {
    if (summary.stepCount === 0 && input.lastDispatchedPhase === 'fork' && input.source) {
      checkSourceStillValid()
      assertAnchoredSourceUnchanged({
        rootDir: configuredRoot,
        canonicalRoot,
        parentSegments: ['conversations'],
        leafName: `${input.nativeSessionId}.db`,
        expectedIdentity: snapshotHandle.fileIdentity,
        expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      })
      throw Object.assign(
        new Error(
          'Antigravity Fork candidate summary step_count is still zero; continue Fork to finalize publication.',
        ),
        { code: 'native_file_fork_candidate_missing' },
      )
    }
    throw new Error('Antigravity Fork candidate summary step_count is not synchronized.')
  }

  const physical = computePhysicalDbDigest(
    canonicalRoot,
    input.nativeSessionId,
    configuredRoot,
    snapshotHandle.fileIdentity,
    snapshotHandle.walIdentity,
  )
  const initializedVerified =
    Boolean(witness.initializedAt) &&
    physical.rawHash === witness.initializedPrefixHash &&
    physical.rawBytes === witness.initializedPrefixBytes &&
    derived.prefixRecords === witness.initializedPrefixRecords

  return {
    initializedVerified,
    nativeSessionId: input.nativeSessionId,
    nativeCutId: witness.sourceCutId,
    prefixHash: derived.prefixHash,
    prefixBytes: derived.prefixBytes,
    prefixRecords: derived.prefixRecords,
    idMap: derived.idMap,
    rawHash: physical.rawHash,
    rawBytes: physical.rawBytes,
    rawRecords: derived.prefixRecords,
    nativeStorageRoot: canonicalRoot,
    nativePath: snapshotHandle.canonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(derived.schema.trajectoryId, witness.sourceCutId, derived),
  }
}

export async function executeAgyFork(
  input: AgyForkInput,
  onBeforeAtomicPublish?: (candidate: AgyForkOperationResult) => Promise<void> | void,
): Promise<AgyForkOperationResult> {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const beforePublishHook = onBeforeAtomicPublish ?? input.beforePublish
  if (!input.source) {
    throw new Error('Antigravity Fork execution requires a prepared AgentNativeForkBoundary.')
  }
  const sourceSessionId = input.source.nativeSessionId
  const candidateSessionId =
    input.candidateNativeSessionId ??
    (input.nativeSessionId !== sourceSessionId ? input.nativeSessionId : undefined)
  if (!candidateSessionId) {
    throw new Error(
      'Antigravity Fork requires a pre-allocated zero-Turn candidate nativeSessionId.',
    )
  }
  if (
    input.candidateNativeSessionId &&
    input.nativeSessionId !== sourceSessionId &&
    input.nativeSessionId !== candidateSessionId
  ) {
    throw new Error('Antigravity Fork nativeSessionId disagrees with source and candidate IDs.')
  }
  assertValidSessionUuid(sourceSessionId, 'Antigravity source Session UUID')
  assertValidSessionUuid(candidateSessionId, 'Antigravity candidate Session UUID')
  if (candidateSessionId === sourceSessionId) {
    throw new Error('Antigravity Fork candidate Session UUID must differ from source Session UUID.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)
  const conversationsDir = join(canonicalRoot, 'conversations')
  const convStat = lstatSync(conversationsDir, { bigint: true })
  if (!convStat.isDirectory() || convStat.isSymbolicLink()) {
    throw new Error('Antigravity conversations directory must be an ordinary directory.')
  }

  const sourceHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${sourceSessionId}.db`,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const sourceIdentity = sourceHandle.fileIdentity
  const sourceCommittedImageDigest = sourceHandle.committedImageDigest
  const effectiveInputIds = input.nativeInputIds ?? input.source.nativeInputIds
  let derived: DerivedAgyPrefix
  try {
    derived = deriveVerifiedAgyPrefix(
      sourceHandle.db,
      sourceSessionId,
      canonicalRoot,
      sourceHandle.canonicalDbPath,
      input.source.nativeTurnId,
      {
        proof: sourceHandle.proof,
        configuredRoot,
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: sourceIdentity,
      expectedCommittedImageDigest: sourceCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } finally {
    sourceHandle.close()
  }

  if (
    derived.prefixHash !== input.source.prefixHash ||
    input.source.nativeCutId !== derived.resolvedExecutionId ||
    (input.source.agyCut !== undefined &&
      (input.source.agyCut.trajectoryId !== derived.schema.trajectoryId ||
        input.source.agyCut.executionId !== derived.resolvedExecutionId ||
        input.source.agyCut.cutStepIdx !== derived.cutStep))
  ) {
    throw new Error('Prepared Antigravity native prefix changed before Fork.')
  }

  const shellHandle = openCandidateShellSnapshotOrThrowUncertain({
    rootDir: configuredRoot,
    canonicalRoot,
    candidateSessionId,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const shellIdentity = shellHandle.fileIdentity
  const shellWalIdentity = shellHandle.walIdentity
  const shellCommittedImageDigest = shellHandle.committedImageDigest
  const shellCanonicalDbPath = shellHandle.canonicalDbPath
  let shellSchema: ValidatedTrajectorySchema
  let candidateAlreadyPopulated = false
  try {
    shellSchema = validateTrajectoryDatabase(shellHandle.db, candidateSessionId, shellHandle.proof)
    const counts = shellHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!
    if (
      counts.stepCount === derived.cutStep + 1 &&
      counts.genCount === derived.genPrefixRows.length &&
      counts.execCount === derived.execPrefixRows.length
    ) {
      const existingDerived = deriveVerifiedAgyPrefix(
        shellHandle.db,
        candidateSessionId,
        canonicalRoot,
        shellCanonicalDbPath,
        input.source.nativeCutId,
        {
          proof: shellHandle.proof,
          configuredRoot,
          requireNoPostCutRows: true,
          ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        },
      )
      if (
        existingDerived.prefixHash === derived.prefixHash &&
        JSON.stringify(existingDerived.idMap) === JSON.stringify(derived.idMap)
      ) {
        candidateAlreadyPopulated = true
      } else {
        throw new Error('Antigravity Fork candidate database already contains foreign history.')
      }
    } else if (counts.stepCount !== 0 || counts.genCount !== 0 || counts.execCount !== 0) {
      throw new Error('Antigravity Fork candidate database is not a clean zero-Turn shell.')
    }
  } finally {
    shellHandle.close()
  }

  if (candidateAlreadyPopulated) {
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      expectedIdentity: shellIdentity,
      expectedCommittedImageDigest: shellCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    const physical = computePhysicalDbDigest(
      canonicalRoot,
      candidateSessionId,
      configuredRoot,
      shellIdentity,
      shellWalIdentity,
    )
    const completedResult: AgyForkOperationResult = {
      nativeSessionId: candidateSessionId,
      nativeCutId: input.source.nativeCutId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: physical.rawHash,
      rawBytes: physical.rawBytes,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: shellCanonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: shellSchema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
    }
    // Always await witness commit acknowledgement BEFORE mutating conversation_summaries.db!
    if (beforePublishHook) await beforePublishHook(completedResult)
    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      expectedIdentity: shellIdentity,
      expectedCommittedImageDigest: shellCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    ensureSummaryStepCountCas(
      canonicalRoot,
      candidateSessionId,
      derived.cutStep + 1,
      derived.lastUserStepIdx,
      shellSchema.trajectoryId,
    )
    return completedResult
  }

  verifySummaryRowExistsReadOnly(canonicalRoot, candidateSessionId, true, shellSchema.trajectoryId)

  for (const col of derived.schema.stepColumns) {
    if (!shellSchema.stepColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell steps table lacks source column (${col}); failing closed.`,
      )
    }
  }
  for (const col of derived.schema.genColumns) {
    if (!shellSchema.genColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell gen_metadata table lacks source column (${col}); failing closed.`,
      )
    }
  }
  for (const col of derived.schema.execColumns) {
    if (!shellSchema.execColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell executor_metadata table lacks source column (${col}); failing closed.`,
      )
    }
  }

  const remap: AgyIdentityRemap = {
    sourceTrajectoryId: derived.schema.trajectoryId,
    targetTrajectoryId: shellSchema.trajectoryId,
    sourceCascadeId: sourceSessionId,
    targetCascadeId: candidateSessionId,
    canonicalAppDataDir: canonicalRoot,
    configuredAppDataDir: configuredRoot,
  }

  const mediaCopies: Array<{ plan: AgyMediaCopyPlan; bytes: Buffer; sha256: string }> = []
  const seenTargetMediaPaths = new Set<string>()
  let copiedMediaBytes = 0

  const remappedSteps = derived.stepPrefixRows.map((row, stepIdx): Record<string, unknown> => {
    const rawMeta = optionalBufferField(row, 'metadata')
    const rawData = requireBufferField(row, derived.schema.stepPayloadColumn)
    const nextMeta = rawMeta ? remapCortexStepMetadata(rawMeta, remap, stepIdx) : null
    const nextStep = remapAgyStep(rawData, remap, stepIdx)

    for (const plan of nextStep.copiedMedia) {
      if (seenTargetMediaPaths.has(plan.targetFilePath)) continue
      seenTargetMediaPaths.add(plan.targetFilePath)

      const verifiedMedia = resolveVerifiedForkMedia(canonicalRoot, sourceSessionId, plan, false)
      const expectedMedia = derived.mediaDigestsByFileName.get(plan.fileName)
      if (
        !expectedMedia ||
        verifiedMedia.bytes.byteLength !== expectedMedia.byteLength ||
        verifiedMedia.sha256 !== expectedMedia.sha256
      ) {
        throw new Error(
          'Antigravity source uploaded media changed between prefix verification and Fork copy.',
        )
      }
      copiedMediaBytes += verifiedMedia.bytes.byteLength
      if (copiedMediaBytes > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity Fork uploaded media exceeds the 32 MiB history budget.',
          false,
        )
      }
      mediaCopies.push({ plan, bytes: verifiedMedia.bytes, sha256: verifiedMedia.sha256 })
    }

    return {
      ...row,
      metadata: nextMeta,
      [shellSchema.stepPayloadColumn]: nextStep.buffer,
      ...(shellSchema.hasStepFormatColumn ? { step_format: 0 } : {}),
      ...(shellSchema.stepColumns.includes('size') ? { size: nextStep.buffer.byteLength } : {}),
    }
  })

  const remappedGens = derived.genPrefixRows.map((row): Record<string, unknown> => {
    const rawData = requireBufferField(row, 'data')
    const nextData = remapCortexStepGeneratorMetadata(rawData, remap)
    return {
      ...row,
      data: nextData,
      ...(shellSchema.genColumns.includes('size') ? { size: nextData.byteLength } : {}),
    }
  })

  // Verifies same-volume staging (conversations vs brain/<candidateSessionId>) BEFORE any media writes or beforePublishHook!
  const sameVolumeStage = createSameVolumeCandidateStagingDb(
    canonicalRoot,
    candidateSessionId,
    input.stagingLeafName,
  )
  const stagingPath = sameVolumeStage.stagingPath
  let expectedStagedIdentity: AgySqliteFileIdentity
  let stagedPhysical: { rawHash: string; rawBytes: number }

  try {
    let expectedDbBytes: bigint
    const reopenShellHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertStagingBound({ expectedSize: 0n })
      const stagingDb = new Database(stagingPath, { fileMustExist: true })
      try {
        sameVolumeStage.assertStagingBound({ expectedSize: 0n })
        initializeStagingFromShell(stagingDb, reopenShellHandle.db, shellSchema)

        if (
          shellSchema.tables.has('trajectory_metadata_blob') &&
          shellSchema.trajectoryMetadataRows.length === 0 &&
          derived.schema.trajectoryMetadataRows.length === 1
        ) {
          const srcBlobRow = derived.schema.trajectoryMetadataRows[0]!
          const srcBlob = srcBlobRow['data']
          if (Buffer.isBuffer(srcBlob)) {
            const remappedBlob = remapCortexTrajectoryMetadata(srcBlob, remap)
            const blobCols = readTableColumns(stagingDb, 'trajectory_metadata_blob')
            const nextBlobRow: Record<string, unknown> = { ...srcBlobRow, data: remappedBlob }
            stagingDb
              .prepare(
                `INSERT INTO "trajectory_metadata_blob" (${blobCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${blobCols.map(() => '?').join(', ')})`,
              )
              .run(...blobCols.map((col) => nextBlobRow[col] ?? null))
          }
        }

        stagingDb.exec('BEGIN IMMEDIATE')
        try {
          const stepCols = shellSchema.stepColumns
          const insertStep = stagingDb.prepare(
            `INSERT INTO "steps" (${stepCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${stepCols.map(() => '?').join(', ')})`,
          )
          for (const row of remappedSteps) {
            insertStep.run(...stepCols.map((col) => row[col] ?? null))
          }

          if (remappedGens.length > 0) {
            const genCols = shellSchema.genColumns
            const insertGen = stagingDb.prepare(
              `INSERT INTO "gen_metadata" (${genCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${genCols.map(() => '?').join(', ')})`,
            )
            for (const row of remappedGens) {
              insertGen.run(...genCols.map((col) => row[col] ?? null))
            }
          }

          const execCols = shellSchema.execColumns
          const insertExec = stagingDb.prepare(
            `INSERT INTO "executor_metadata" (${execCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${execCols.map(() => '?').join(', ')})`,
          )
          for (const row of derived.execPrefixRows) {
            insertExec.run(...execCols.map((col) => row[col] ?? null))
          }

          stagingDb.exec('COMMIT')
        } catch (error) {
          if (stagingDb.inTransaction) stagingDb.exec('ROLLBACK')
          throw error
        }

        verifySqliteIntegrityOk(stagingDb)
        expectedDbBytes = measureOpenSqliteExpectedBytes(stagingDb)
        sameVolumeStage.assertStagingBound({ expectedSize: expectedDbBytes })
      } finally {
        stagingDb.close()
      }
    } finally {
      reopenShellHandle.close()
    }

    if (expectedDbBytes > BigInt(AGY_MAX_HISTORY_BYTES)) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork staged SQLite database exceeds the 32 MiB history budget.',
        false,
      )
    }
    sameVolumeStage.fsyncVerifiedStaging(expectedDbBytes)

    const candidateCutMeta = buildAgyForkCutMetadata(
      shellSchema.trajectoryId,
      input.source.nativeCutId,
      derived,
    )
    const prePublishCandidate: AgyForkOperationResult = {
      nativeSessionId: candidateSessionId,
      nativeCutId: input.source.nativeCutId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: '',
      rawBytes: 0,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: shellCanonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: shellSchema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: candidateCutMeta,
    }

    if (mediaCopies.length > 0) {
      const uploadedDir = ensureSafeDirectoryChain(canonicalRoot, [
        'brain',
        candidateSessionId,
        '.user_uploaded',
      ])
      for (const item of mediaCopies) {
        writeIdempotentPrivateFile(item.plan.targetFilePath, canonicalRoot, item.bytes, item.sha256)
        const copiedBytes = readVerifiedUploadedMediaFile(
          canonicalRoot,
          candidateSessionId,
          item.plan.targetFilePath,
          AGY_MAX_HISTORY_BYTES,
        )
        const expectedMedia = derived.mediaDigestsByFileName.get(item.plan.fileName)
        if (
          !expectedMedia ||
          copiedBytes.byteLength !== expectedMedia.byteLength ||
          sha256Hex(copiedBytes) !== expectedMedia.sha256
        ) {
          throw new Error(
            'Antigravity copied candidate uploaded media failed frozen digest verification.',
          )
        }
      }
      fsyncDirectoryBestEffort(uploadedDir)
    }

    // Verify staged candidate DB produces the exact frozen normalized prefixHash AND pin its fileIdentity before publishing!
    const stagedSnapshot = openCommittedSqliteSnapshot({
      rootDir: canonicalRoot,
      canonicalRoot,
      parentSegments: ['brain', candidateSessionId],
      leafName: sameVolumeStage.stagingLeafName,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertAnchoredIdentityMatchesCreated(
        stagedSnapshot.fileIdentity,
        expectedDbBytes,
      )
      const stagedDerived = deriveVerifiedAgyPrefix(
        stagedSnapshot.db,
        candidateSessionId,
        canonicalRoot,
        stagedSnapshot.canonicalDbPath,
        input.source.nativeCutId,
        {
          proof: stagedSnapshot.proof,
          configuredRoot,
          requireNoPostCutRows: true,
          ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        },
      )
      if (stagedDerived.prefixHash !== derived.prefixHash) {
        throw new Error(
          'Antigravity Fork staged candidate prefixHash disagrees with frozen source prefixHash.',
        )
      }
      expectedStagedIdentity = stagedSnapshot.fileIdentity
    } finally {
      stagedSnapshot.close()
    }

    // Compute pinned staged physical digest before rename so post-publish physical digest is strictly bound.
    const stagedView = openAnchoredLockedSqliteView(
      canonicalRoot,
      ['brain', candidateSessionId],
      sameVolumeStage.stagingLeafName,
      { acquireSharedLock: true, openWal: true, openShm: true, checkJournal: true },
    )
    try {
      if (
        stagedView.hasWal ||
        stagedView.hasShm ||
        stagedView.hasJournal ||
        !identitiesExactMatch(stagedView.fileIdentity, expectedStagedIdentity)
      ) {
        throw new Error('Antigravity Fork staged database changed before publication.')
      }
      const stagedHasher = createHash('sha256')
      stagedHasher.update('pact-agy-sqlite-physical-v1\0')
      stagedHasher.update('main\0')
      let offset = 0
      while (offset < stagedView.byteLength) {
        const chunk = stagedView.readAt(offset, Math.min(64 * 1024, stagedView.byteLength - offset))
        offset += chunk.byteLength
        stagedHasher.update(chunk)
      }
      const verify = stagedView.verifyUnchanged()
      if (!verify.unchanged) {
        throw new Error('Antigravity Fork staged database changed during digest verification.')
      }
      stagedPhysical = { rawHash: stagedHasher.digest('hex'), rawBytes: stagedView.byteLength }
    } finally {
      stagedView.close()
    }

    if (beforePublishHook) {
      await beforePublishHook(prePublishCandidate)
    }

    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: sourceIdentity,
      expectedCommittedImageDigest: sourceCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    publishStagedCandidateOrThrow({
      canonicalRoot,
      candidateSessionId,
      stagedLeafName: sameVolumeStage.stagingLeafName,
      expectedTargetIdentity: shellIdentity,
      expectedStagedIdentity,
    })
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    sameVolumeStage.cleanup()
  }

  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  // Verify the published file is the exact renamed staged inode (dev/ino/size/mtimeNs; rename may update ctimeNs)
  // and bind computePhysicalDbDigest strictly to that published identity + exact staged rawHash/rawBytes
  // BEFORE advancing the summary CAS!
  const publishedIdentity = readAnchoredFileIdentity(
    canonicalRoot,
    ['conversations'],
    `${candidateSessionId}.db`,
  )
  if (
    publishedIdentity.dev !== expectedStagedIdentity.dev ||
    publishedIdentity.ino !== expectedStagedIdentity.ino ||
    publishedIdentity.size !== expectedStagedIdentity.size ||
    publishedIdentity.mtimeNs !== expectedStagedIdentity.mtimeNs
  ) {
    throw Object.assign(
      new Error('Antigravity Fork published candidate database changed after atomic rename.'),
      { code: 'UNCERTAIN' },
    )
  }
  const physical = computePhysicalDbDigest(
    canonicalRoot,
    candidateSessionId,
    configuredRoot,
    publishedIdentity,
    null,
  )
  if (
    physical.rawHash !== stagedPhysical.rawHash ||
    physical.rawBytes !== stagedPhysical.rawBytes
  ) {
    throw Object.assign(
      new Error('Antigravity Fork published candidate digest disagrees with verified staging.'),
      { code: 'UNCERTAIN' },
    )
  }
  ensureSummaryStepCountCas(
    canonicalRoot,
    candidateSessionId,
    derived.cutStep + 1,
    derived.lastUserStepIdx,
    shellSchema.trajectoryId,
  )
  return {
    nativeSessionId: candidateSessionId,
    nativeCutId: input.source.nativeCutId,
    prefixHash: derived.prefixHash,
    prefixBytes: derived.prefixBytes,
    prefixRecords: derived.prefixRecords,
    idMap: derived.idMap,
    rawHash: physical.rawHash,
    rawBytes: physical.rawBytes,
    rawRecords: derived.prefixRecords,
    nativeStorageRoot: canonicalRoot,
    nativePath: shellCanonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: shellSchema.trajectoryId,
    sourceTrajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
  }
}

function isTransientAgySnapshotChurn(error: unknown): boolean {
  if (error instanceof AgyHotRollbackJournalError) return true
  if (error instanceof AgyTransientIdentityChurnError) return true
  if (isTransientFileLockError(error)) return true
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('changed while') ||
    error.message.includes('changed after') ||
    error.message.includes('changed during') ||
    error.message.includes('did not match expected size')
  )
}

export type AgyTrajectoryIdentityResult =
  | {
      readonly status: 'ok'
      readonly trajectoryId: string
      readonly stepCount: number
    }
  | {
      readonly status:
        | 'no_storage_root'
        | 'missing'
        | 'transient_churn'
        | 'invalid'
        | 'budget_exceeded'
      readonly reason?: string
    }

const MAX_IDENTITY_REASON_BYTES = 512
const FALLBACK_STEP_SCAN_CHECK_INTERVAL = 256

function boundIdentityReason(reason: string): string {
  const trimmed = reason.trim()
  if (!trimmed) return 'Antigravity trajectory identity read exceeded its budget.'
  const encoded = Buffer.from(trimmed, 'utf8')
  if (encoded.byteLength <= MAX_IDENTITY_REASON_BYTES) return trimmed
  let end = trimmed.length
  while (end > 0 && Buffer.byteLength(trimmed.slice(0, end), 'utf8') > MAX_IDENTITY_REASON_BYTES) {
    end -= 1
  }
  return trimmed.slice(0, end)
}

function unquoteSqlIdent(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replaceAll('""', '"')
    }
    if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
      return trimmed.slice(1, -1).replaceAll('``', '`')
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

const QUOTED_SQL_IDENT_SOURCE = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\])'
const UNQUOTED_SQL_IDENT_SOURCE = '[a-z_][a-z0-9_$]*(?=$|[\\s,()])'
const SQL_IDENT_PATTERN_SOURCE = `(?:${QUOTED_SQL_IDENT_SOURCE}|${UNQUOTED_SQL_IDENT_SOURCE})`
const QUOTED_LEADING_SQL_IDENT_RE = new RegExp(`^${QUOTED_SQL_IDENT_SOURCE}`, 'u')
const UNQUOTED_LEADING_SQL_IDENT_RE = /^[a-z_][a-z0-9_$]*/iu
const TABLE_PK_CONSTRAINT_RE = new RegExp(
  `^(?:CONSTRAINT\\s+${SQL_IDENT_PATTERN_SOURCE}\\s+)?PRIMARY\\s+KEY\\s*\\(([^)]+)\\)(?:\\s+ON\\s+CONFLICT\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?$`,
  'iu',
)
const SINGLE_PK_COLUMN_RE = new RegExp(`^(${SQL_IDENT_PATTERN_SOURCE})(?:\\s+ASC)?$`, 'iu')
const COLUMN_CONSTRAINT_STARTERS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
])
const TABLE_CONSTRAINT_STARTERS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])

interface LexedSqlToken {
  readonly raw: string
  readonly quoted: boolean
  readonly value: string
  readonly nextOffset: number
}

function lexLeadingSqlToken(text: string): LexedSqlToken | undefined {
  if (text.length === 0) return undefined
  const first = text[0]!
  if (first === '"' || first === '`' || first === '[') {
    const match = QUOTED_LEADING_SQL_IDENT_RE.exec(text)
    if (!match) return undefined
    const raw = match[0]
    const nextChar = text[raw.length]
    if (nextChar !== undefined && !/[\s,()]/u.test(nextChar)) {
      return undefined
    }
    return {
      raw,
      quoted: true,
      value: unquoteSqlIdent(raw),
      nextOffset: raw.length,
    }
  }
  const match = UNQUOTED_LEADING_SQL_IDENT_RE.exec(text)
  if (!match) return undefined
  const raw = match[0]
  const nextChar = text[raw.length]
  if (nextChar !== undefined && !/[\s,()]/u.test(nextChar)) {
    return undefined
  }
  return {
    raw,
    quoted: false,
    value: raw,
    nextOffset: raw.length,
  }
}

function splitCreateTableBodyParts(
  strippedSql: string,
): { readonly parts: string[]; readonly trailing: string } | undefined {
  const openParen = strippedSql.indexOf('(')
  if (openParen < 0) return undefined
  let depth = 0
  let closeParen = -1
  let k = openParen
  const parts: string[] = []
  let partStart = openParen + 1
  while (k < strippedSql.length) {
    const ch = strippedSql[k]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      k += 1
      while (k < strippedSql.length) {
        if (strippedSql[k] === quote) {
          if (strippedSql[k + 1] === quote) k += 2
          else {
            k += 1
            break
          }
        } else {
          k += 1
        }
      }
      continue
    }
    if (ch === '[') {
      k += 1
      while (k < strippedSql.length && strippedSql[k] !== ']') k += 1
      k += 1
      continue
    }
    if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        parts.push(strippedSql.slice(partStart, k))
        closeParen = k
        break
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(strippedSql.slice(partStart, k))
      partStart = k + 1
    }
    k += 1
  }
  if (closeParen < 0) return undefined
  return { parts, trailing: strippedSql.slice(closeParen + 1).trim() }
}

function extractVirtualColumnDirectSourceAlias(
  tableSql: string,
  targetColumnName: string,
): string | undefined {
  const { cleaned } = stripSqlCommentsAndMaskQuotes(tableSql)
  const split = splitCreateTableBodyParts(cleaned)
  if (!split) return undefined
  for (const rawPart of split.parts) {
    const item = rawPart.trim()
    if (!item) continue
    const colTok = lexLeadingSqlToken(item)
    if (!colTok) continue
    if (!colTok.quoted && TABLE_CONSTRAINT_STARTERS.has(colTok.value.toUpperCase())) {
      continue
    }
    if (colTok.value.toLowerCase() !== targetColumnName.toLowerCase()) {
      continue
    }
    const rest = item.slice(colTok.nextOffset)
    let depth = 0
    let i = 0
    while (i < rest.length) {
      const ch = rest[i]!
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        i += 1
        while (i < rest.length) {
          if (rest[i] === quote) {
            if (rest[i + 1] === quote) i += 2
            else {
              i += 1
              break
            }
          } else {
            i += 1
          }
        }
        continue
      }
      if (ch === '[') {
        i += 1
        while (i < rest.length && rest[i] !== ']') i += 1
        i += 1
        continue
      }
      if (ch === '(') {
        depth += 1
        i += 1
        continue
      }
      if (ch === ')') {
        depth = Math.max(0, depth - 1)
        i += 1
        continue
      }
      if (depth === 0 && /[a-z_]/iu.test(ch)) {
        const start = i
        while (i < rest.length && /[a-z0-9_$]/iu.test(rest[i]!)) i += 1
        if (rest.slice(start, i).toUpperCase() === 'AS') {
          let j = i
          while (j < rest.length && /\s/u.test(rest[j]!)) j += 1
          if (rest[j] !== '(') continue
          let exprDepth = 0
          let exprEnd = -1
          for (let m = j; m < rest.length; m += 1) {
            const ech = rest[m]!
            if (ech === "'" || ech === '"' || ech === '`') {
              const eq = ech
              m += 1
              while (m < rest.length) {
                if (rest[m] === eq) {
                  if (rest[m + 1] === eq) m += 2
                  else break
                } else {
                  m += 1
                }
              }
              continue
            }
            if (ech === '[') {
              m += 1
              while (m < rest.length && rest[m] !== ']') m += 1
              continue
            }
            if (ech === '(') exprDepth += 1
            else if (ech === ')') {
              exprDepth -= 1
              if (exprDepth === 0) {
                exprEnd = m
                break
              }
            }
          }
          if (exprEnd < 0) return undefined
          let inner = rest.slice(j + 1, exprEnd).trim()
          while (inner.startsWith('(') && inner.endsWith(')')) {
            // Strip redundant outer parens only if they wrap the entire expression.
            let pDepth = 0
            let wrapsAll = true
            for (let p = 0; p < inner.length; p += 1) {
              const pch = inner[p]!
              if (pch === '(') pDepth += 1
              else if (pch === ')') {
                pDepth -= 1
                if (pDepth === 0 && p < inner.length - 1) {
                  wrapsAll = false
                  break
                }
              }
            }
            if (!wrapsAll) break
            inner = inner.slice(1, -1).trim()
          }
          const aliasTok = lexLeadingSqlToken(inner)
          if (!aliasTok || inner.slice(aliasTok.nextOffset).trim().length > 0) {
            return undefined
          }
          return aliasTok.value
        }
        continue
      }
      i += 1
    }
    return undefined
  }
  return undefined
}

function stripSqlCommentsAndMaskQuotes(sql: string): { cleaned: string; unquoted: string } {
  let cleaned = ''
  let unquoted = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i += 1
      cleaned += ' '
      unquoted += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      cleaned += ' '
      unquoted += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      cleaned += ch
      unquoted += ' '
      i += 1
      while (i < sql.length) {
        const qch = sql[i]!
        cleaned += qch
        i += 1
        if (qch === quote) {
          if (sql[i] === quote) {
            cleaned += sql[i]!
            i += 1
          } else {
            break
          }
        }
      }
      unquoted += ' '
      continue
    }
    if (ch === '[') {
      cleaned += ch
      unquoted += ' '
      i += 1
      while (i < sql.length) {
        const bch = sql[i]!
        cleaned += bch
        i += 1
        if (bch === ']') break
      }
      unquoted += ' '
      continue
    }
    cleaned += ch
    unquoted += ch
    i += 1
  }
  return { cleaned, unquoted }
}

function splitColumnTypeAndConstraints(rest: string): {
  typeText: string
  constraintsText: string
} {
  let depth = 0
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < rest.length) {
        if (rest[i] === quote) {
          if (rest[i + 1] === quote) i += 2
          else {
            i += 1
            break
          }
        } else {
          i += 1
        }
      }
      continue
    }
    if (ch === '[') {
      i += 1
      while (i < rest.length && rest[i] !== ']') i += 1
      i += 1
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (depth === 0 && /[a-z_]/iu.test(ch)) {
      const start = i
      while (i < rest.length && /[a-z0-9_$]/iu.test(rest[i]!)) i += 1
      const word = rest.slice(start, i).toUpperCase()
      if (COLUMN_CONSTRAINT_STARTERS.has(word)) {
        return {
          typeText: rest.slice(0, start).trim(),
          constraintsText: rest.slice(start).trim(),
        }
      }
      continue
    }
    i += 1
  }
  return { typeText: rest.trim(), constraintsText: '' }
}

function hasOnlyWhitelistedIntegerConstraints(
  constraintsText: string,
  allowPrimaryKey: boolean,
): boolean {
  let remaining = constraintsText.trim()
  while (remaining.length > 0) {
    const pkMatch = allowPrimaryKey
      ? /^PRIMARY\s+KEY(?:\s+ASC)?(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?:\s+AUTOINCREMENT)?(?=\s|$)/iu.exec(
          remaining,
        )
      : null
    if (pkMatch) {
      remaining = remaining.slice(pkMatch[0].length).trim()
      continue
    }
    const notNullMatch =
      /^NOT\s+NULL(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?=\s|$)/iu.exec(
        remaining,
      )
    if (notNullMatch) {
      remaining = remaining.slice(notNullMatch[0].length).trim()
      continue
    }
    const uniqueMatch =
      /^UNIQUE(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?=\s|$)/iu.exec(
        remaining,
      )
    if (uniqueMatch) {
      remaining = remaining.slice(uniqueMatch[0].length).trim()
      continue
    }
    return false
  }
  return true
}

function hasNonAsciiCodeUnit(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true
  }
  return false
}

function hasNonPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return true
  }
  return false
}

function parseCreateTableDdl(
  sql: string,
): { columns: string[]; rowidAliasCol: string | undefined } | undefined {
  const { cleaned: stripped, unquoted } = stripSqlCommentsAndMaskQuotes(sql)
  if (
    hasNonAsciiCodeUnit(unquoted) ||
    /\bVIRTUAL\s+TABLE\b/iu.test(unquoted) ||
    /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b[\s\S]*\bAS\s+SELECT\b/iu.test(unquoted) ||
    /\b(?:WITHOUT\s+ROWID|VIRTUAL|GENERATED|STORED)\b/iu.test(unquoted) ||
    /\bAS\s*\(/iu.test(unquoted)
  ) {
    return undefined
  }

  const split = splitCreateTableBodyParts(stripped)
  if (!split || split.trailing.length > 0) {
    return undefined
  }
  const { parts } = split

  const columns: string[] = []
  const colNameByLower = new Map<string, string>()
  const exactIntegerForTablePk = new Map<string, boolean>()
  const nonExactIntegerCols = new Set<string>()
  let inlineRowidCol: string | undefined
  let tablePkCol: string | undefined
  let pkCount = 0

  const handleTablePrimaryKeyConstraint = (constraintText: string): boolean => {
    const pkMatch = TABLE_PK_CONSTRAINT_RE.exec(constraintText)
    if (!pkMatch) return false
    pkCount += 1
    if (pkCount > 1) return false
    const pkExpr = pkMatch[1]!.trim()
    if (pkExpr.includes(',') || /\bDESC\b/iu.test(pkExpr)) {
      return false
    }
    const singleCol = SINGLE_PK_COLUMN_RE.exec(pkExpr)
    if (!singleCol) return false
    tablePkCol = unquoteSqlIdent(singleCol[1]!)
    return true
  }

  for (const rawPart of parts) {
    const item = rawPart.trim()
    if (!item) return undefined
    const leadingTok = lexLeadingSqlToken(item)
    if (!leadingTok) return undefined

    if (!leadingTok.quoted && TABLE_CONSTRAINT_STARTERS.has(leadingTok.value.toUpperCase())) {
      const keyword = leadingTok.value.toUpperCase()
      let constraintHead = keyword
      let afterHead = item.slice(leadingTok.nextOffset).trim()
      if (keyword === 'CONSTRAINT') {
        const nameTok = lexLeadingSqlToken(afterHead)
        if (!nameTok) return undefined
        const afterName = afterHead.slice(nameTok.nextOffset).trim()
        const bodyKwTok = lexLeadingSqlToken(afterName)
        if (!bodyKwTok || bodyKwTok.quoted) return undefined
        constraintHead = bodyKwTok.value.toUpperCase()
        afterHead = afterName.slice(bodyKwTok.nextOffset).trim()
      }
      if (constraintHead === 'PRIMARY') {
        const keyTok = lexLeadingSqlToken(afterHead)
        if (!keyTok || keyTok.quoted || keyTok.value.toUpperCase() !== 'KEY') return undefined
        if (!handleTablePrimaryKeyConstraint(item)) return undefined
        continue
      }
      if (constraintHead === 'UNIQUE' || constraintHead === 'CHECK') {
        if (!afterHead.startsWith('(')) return undefined
        continue
      }
      if (constraintHead === 'FOREIGN') {
        const keyTok = lexLeadingSqlToken(afterHead)
        if (!keyTok || keyTok.quoted || keyTok.value.toUpperCase() !== 'KEY') return undefined
        const afterKey = afterHead.slice(keyTok.nextOffset).trim()
        if (!afterKey.startsWith('(')) return undefined
        continue
      }
      return undefined
    }

    const colName = leadingTok.value
    if (!colName || hasNonPrintableAscii(colName)) return undefined
    const colKey = colName.toLowerCase()
    if (colNameByLower.has(colKey)) return undefined
    colNameByLower.set(colKey, colName)
    columns.push(colName)

    const rest = item.slice(leadingTok.nextOffset).trim()
    const { typeText, constraintsText } = splitColumnTypeAndConstraints(rest)
    const constraintsUnquoted = stripSqlCommentsAndMaskQuotes(constraintsText).unquoted
    if (/(?:REAL|FLOA|DOUB)/iu.test(typeText)) {
      return undefined
    }
    const isExactIntegerType = /^INTEGER$/iu.test(typeText)
    const isIntegerLikeType = /^INT(?:EGER|\b)/iu.test(typeText)

    if (/\bPRIMARY\s+KEY\b/iu.test(constraintsUnquoted)) {
      pkCount += 1
      if (pkCount > 1) return undefined
      if (/\bPRIMARY\s+KEY\s+DESC\b/iu.test(constraintsUnquoted)) {
        return undefined
      }
      if (isExactIntegerType) {
        if (!hasOnlyWhitelistedIntegerConstraints(constraintsText, true)) {
          return undefined
        }
        inlineRowidCol = colName
      } else if (isIntegerLikeType) {
        // Non-exact single-token INTEGER primary key (e.g. `INTEGER VARYING PRIMARY KEY`, `INT PRIMARY KEY`).
        return undefined
      }
    } else if (isExactIntegerType) {
      exactIntegerForTablePk.set(
        colKey,
        hasOnlyWhitelistedIntegerConstraints(constraintsText, false),
      )
    } else if (isIntegerLikeType) {
      nonExactIntegerCols.add(colKey)
    }
  }

  let rowidAliasCol: string | undefined
  if (pkCount === 1) {
    if (inlineRowidCol !== undefined) {
      rowidAliasCol = inlineRowidCol
    } else if (tablePkCol !== undefined) {
      const pkKey = tablePkCol.toLowerCase()
      const canonicalCol = colNameByLower.get(pkKey)
      if (!canonicalCol) return undefined
      if (nonExactIntegerCols.has(pkKey)) return undefined
      if (exactIntegerForTablePk.get(pkKey) === true) {
        rowidAliasCol = canonicalCol
      }
    }
  }
  return { columns, rowidAliasCol }
}

function queryBoundedIdentityFromOpenSqlite(
  db: Database.Database,
  expectedSessionId: string,
  proof: AgyPreScannedSqliteProof,
  options?: {
    readonly signal?: AbortSignal
    readonly deadlineAt?: number
    readonly maxTableDdlBytes?: number
  },
):
  | { readonly kind: 'ok'; readonly trajectoryId: string; readonly stepCount: number }
  | { readonly kind: 'invalid' } {
  const signal = options?.signal
  const deadlineAt = options?.deadlineAt
  const maxTableDdlBytes = options?.maxTableDdlBytes ?? MAX_FALLBACK_TABLE_DDL_BYTES
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)

  // Prove BOTH target tables are ordinary storage tables from the pre-scan proof BEFORE any
  // `pragma_table_xinfo` or SQL prepare, blocking virtual-table `xConnect` side-reads (e.g. FTS5).
  const metaEntry = proof.tables.get('trajectory_meta')
  const stepsEntry = proof.tables.get('steps')
  if (
    !metaEntry ||
    !stepsEntry ||
    metaEntry.isVirtual ||
    stepsEntry.isVirtual ||
    metaEntry.rootPage < 2 ||
    stepsEntry.rootPage < 2
  ) {
    return { kind: 'invalid' }
  }
  if (
    Buffer.byteLength(metaEntry.sql, 'utf8') > maxTableDdlBytes ||
    Buffer.byteLength(stepsEntry.sql, 'utf8') > maxTableDdlBytes
  ) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity table DDL exceeds bounded schema inspection limit.',
    )
  }

  const metaColHidden = readBoundedIdentityTableColumns(db, 'trajectory_meta', [
    'trajectory_id',
    'cascade_id',
  ])
  const stepColHidden = readBoundedIdentityTableColumns(db, 'steps', ['idx'])
  const trajectoryHidden = metaColHidden.get('trajectory_id')
  const cascadeHidden = metaColHidden.get('cascade_id')
  const idxHidden = stepColHidden.get('idx')
  if (trajectoryHidden === undefined || cascadeHidden === undefined || idxHidden === undefined) {
    return { kind: 'invalid' }
  }

  const resolveBoundedVirtualSource = (
    tableName: 'trajectory_meta' | 'steps',
    colName: string,
  ): string => {
    const entry = proof.tables.get(tableName)
    if (!entry || entry.isVirtual || !entry.sql) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} cannot be bounded safely.`,
      )
    }
    const aliasTarget = extractVirtualColumnDirectSourceAlias(entry.sql, colName)
    if (!aliasTarget) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} expression cannot be bounded safely within memory limits.`,
      )
    }
    const storedName = findStoredTableColumnName(db, tableName, aliasTarget)
    if (!storedName) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} does not map to a bounded stored column.`,
      )
    }
    return quoteArbitrarySqlIdentifier(storedName)
  }

  const buildBoundedTextIdentityProjection = (
    colName: 'trajectory_id' | 'cascade_id',
    aliasPrefix: 'trajectory' | 'cascade',
    hidden: number,
  ): string => {
    const quotedCol = `"${colName}"`
    if (hidden === 2) {
      const quotedSource = resolveBoundedVirtualSource('trajectory_meta', colName)
      return `
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
          THEN typeof(${quotedCol})
          ELSE NULL
        END AS ${aliasPrefix}Type,
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
          THEN octet_length(${quotedCol})
          ELSE NULL
        END AS ${aliasPrefix}ByteLength,
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
            AND typeof(${quotedCol}) = 'text'
            AND octet_length(${quotedCol}) BETWEEN 1 AND 1024
          THEN ${quotedCol}
          ELSE NULL
        END AS ${aliasPrefix}Id`
    }
    return `
      typeof(${quotedCol}) AS ${aliasPrefix}Type,
      octet_length(${quotedCol}) AS ${aliasPrefix}ByteLength,
      CASE
        WHEN typeof(${quotedCol}) = 'text'
          AND octet_length(${quotedCol}) BETWEEN 1 AND 1024
        THEN ${quotedCol}
        ELSE NULL
      END AS ${aliasPrefix}Id`
  }

  const metaQuerySql = `SELECT
    ${buildBoundedTextIdentityProjection('trajectory_id', 'trajectory', trajectoryHidden)},
    ${buildBoundedTextIdentityProjection('cascade_id', 'cascade', cascadeHidden)}
  FROM "trajectory_meta" NOT INDEXED
  LIMIT 2`
  assertBoundedFallbackQueryPlan(db, metaQuerySql, {
    allowGuardedVirtualEval: trajectoryHidden === 2 || cascadeHidden === 2,
  })
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)
  const metaRows = db
    .prepare<
      [],
      {
        trajectoryType: unknown
        trajectoryByteLength: unknown
        trajectoryId: unknown
        cascadeType: unknown
        cascadeByteLength: unknown
        cascadeId: unknown
      }
    >(metaQuerySql)
    .all()
  if (metaRows.length !== 1) {
    return { kind: 'invalid' }
  }
  const row = metaRows[0]!
  const trajectoryId = row.trajectoryId
  const cascadeId = row.cascadeId
  if (
    row.trajectoryType !== 'text' ||
    row.cascadeType !== 'text' ||
    typeof row.trajectoryByteLength !== 'number' ||
    typeof row.cascadeByteLength !== 'number' ||
    !isValidAgyTrajectoryId(trajectoryId) ||
    cascadeId !== expectedSessionId
  ) {
    return { kind: 'invalid' }
  }

  if (idxHidden === 0) {
    const probeOps = readBoundedExplainOps(db, `SELECT "idx" FROM "steps" NOT INDEXED LIMIT 1`)
    const isProvenRowidAlias =
      probeOps.length <= MAX_FALLBACK_VDBE_OPS &&
      probeOps.some((op) => op.opcode === 'Rowid') &&
      probeOps.every(
        (op) => op.opcode !== 'Column' && !DISALLOWED_FALLBACK_VDBE_OPCODES.has(op.opcode),
      )
    if (isProvenRowidAlias) {
      const minSql = `SELECT "idx" AS idxVal FROM "steps" ORDER BY "idx" ASC LIMIT 1`
      const maxSql = `SELECT "idx" AS idxVal FROM "steps" ORDER BY "idx" DESC LIMIT 1`
      assertBoundedFallbackQueryPlan(db, minSql)
      assertBoundedFallbackQueryPlan(db, maxSql)
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
      const minStmt = db.prepare<[], { idxVal: unknown }>(minSql)
      minStmt.safeIntegers(true)
      const minRow = minStmt.get()
      if (!minRow) {
        return { kind: 'ok', trajectoryId, stepCount: 0 }
      }
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
      const maxStmt = db.prepare<[], { idxVal: unknown }>(maxSql)
      maxStmt.safeIntegers(true)
      const maxRow = maxStmt.get()
      if (
        !maxRow ||
        typeof minRow.idxVal !== 'bigint' ||
        typeof maxRow.idxVal !== 'bigint' ||
        minRow.idxVal < 0n ||
        maxRow.idxVal < 0n ||
        maxRow.idxVal >= BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'ok',
        trajectoryId,
        stepCount: Number(maxRow.idxVal) + 1,
      }
    }
  }

  const stepQuerySql =
    idxHidden === 2
      ? (() => {
          const quotedSource = resolveBoundedVirtualSource('steps', 'idx')
          const safeSourceGuard = `(typeof(${quotedSource}) = 'integer' OR typeof(${quotedSource}) = 'real' OR (typeof(${quotedSource}) = 'text' AND octet_length(${quotedSource}) BETWEEN 1 AND 32))`
          return `SELECT
            CASE
              WHEN typeof(${quotedSource}) IN ('text', 'blob') AND octet_length(${quotedSource}) > 32
              THEN 1
              ELSE 0
            END AS oversized,
            CASE
              WHEN ${safeSourceGuard}
              THEN typeof("idx")
              ELSE NULL
            END AS idxType,
            CASE
              WHEN ${safeSourceGuard} AND typeof("idx") = 'integer'
              THEN "idx"
              ELSE NULL
            END AS idxVal
          FROM "steps" NOT INDEXED`
        })()
      : `SELECT
          0 AS oversized,
          typeof("idx") AS idxType,
          CASE WHEN typeof("idx") = 'integer' THEN "idx" ELSE NULL END AS idxVal
        FROM "steps" NOT INDEXED`
  assertBoundedFallbackQueryPlan(db, stepQuerySql, {
    allowGuardedVirtualEval: idxHidden === 2,
  })
  const stepStmt = db.prepare<[], { oversized: unknown; idxType: unknown; idxVal: unknown }>(
    stepQuerySql,
  )
  stepStmt.safeIntegers(true)

  let rowCount = 0
  let maxIdx: bigint | undefined
  for (const stepRow of stepStmt.iterate()) {
    if (rowCount % FALLBACK_STEP_SCAN_CHECK_INTERVAL === 0) {
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
    }
    rowCount += 1
    if (rowCount > AGY_STORAGE_MAX_RECORDS) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity fallback steps scan exceeded the ${AGY_STORAGE_MAX_RECORDS}-row record budget.`,
      )
    }
    if (stepRow.oversized === 1n || stepRow.oversized === 1) {
      throw new AgyIdentityBudgetExceededError(
        'Antigravity VIRTUAL steps.idx source value exceeded bounded evaluation size.',
      )
    }
    if (
      stepRow.idxType !== 'integer' ||
      typeof stepRow.idxVal !== 'bigint' ||
      stepRow.idxVal < 0n ||
      stepRow.idxVal >= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return { kind: 'invalid' }
    }
    if (maxIdx === undefined || stepRow.idxVal > maxIdx) {
      maxIdx = stepRow.idxVal
    }
  }
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)
  if (rowCount === 0) {
    return { kind: 'ok', trajectoryId, stepCount: 0 }
  }
  if (maxIdx === undefined) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'ok',
    trajectoryId,
    stepCount: Number(maxIdx) + 1,
  }
}

type FastIdentityImageOutcome =
  | { readonly kind: 'ok'; readonly trajectoryId: string; readonly stepCount: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'fallback' }

function readFastIdentityFromCommittedImage(
  image: AgyCommittedReadImage,
  expectedSessionId: string,
  schemaCatalogBudget?: AgySchemaCatalogBudget,
): FastIdentityImageOutcome {
  const usableSize = image.usableSize
  const readPage = (pageNo: number): Buffer => image.readPage(pageNo)

  const returnInvalidIfStable = (): FastIdentityImageOutcome => {
    image.verifyUnchanged({ includeAccessedPages: true })
    return { kind: 'invalid' }
  }

  // Always pre-scan sqlite_schema + sqlite_stat1/4 within budget BEFORE fast decode or fallback!
  const catalog = image.preScanCatalog(schemaCatalogBudget)
  const metaEntry = catalog.tables.get('trajectory_meta')
  const stepsEntry = catalog.tables.get('steps')
  if (!metaEntry || !stepsEntry) {
    return returnInvalidIfStable()
  }
  if (
    metaEntry.isVirtual ||
    stepsEntry.isVirtual ||
    metaEntry.rootPage < 2 ||
    stepsEntry.rootPage < 2
  ) {
    return returnInvalidIfStable()
  }

  const textEncoding = image.effectivePage1.readUInt32BE(56)
  if (textEncoding !== 1) {
    return { kind: 'fallback' }
  }

  const metaDdl = parseCreateTableDdl(metaEntry.sql)
  const stepsDdl = parseCreateTableDdl(stepsEntry.sql)
  if (!metaDdl || !stepsDdl) {
    return { kind: 'fallback' }
  }
  const trajColIdx = metaDdl.columns.indexOf('trajectory_id')
  const cascadeColIdx = metaDdl.columns.indexOf('cascade_id')
  if (trajColIdx < 0 || cascadeColIdx < 0) {
    return returnInvalidIfStable()
  }
  const stepsIdxCol = stepsDdl.columns.indexOf('idx')
  if (stepsIdxCol < 0) {
    return returnInvalidIfStable()
  }

  const assembleLeafPayload = (
    pageBuf: Buffer,
    payloadStart: number,
    payloadLen: number,
    maxPrefixBytes?: number,
  ): Buffer =>
    assembleSqliteLeafPayload(
      readPage,
      usableSize,
      pageBuf,
      payloadStart,
      payloadLen,
      maxPrefixBytes,
    )

  const collectTableRows = (
    rootPageNo: number,
    maxRows: number,
    neededColumns: number,
  ):
    | {
        kind: 'ok'
        rows: Array<{ rowId: bigint; serialTypes: bigint[]; values: unknown[] }>
        truncated: boolean
      }
    | { kind: 'fallback' } => {
    const rows: Array<{ rowId: bigint; serialTypes: bigint[]; values: unknown[] }> = []
    const visited = new Set<number>()
    const stack: number[] = [rootPageNo]
    let truncated = false
    while (stack.length > 0) {
      const pageNo = stack.pop()!
      if (visited.has(pageNo)) throw new Error('SQLite B-tree cycle detected.')
      visited.add(pageNo)
      const page = readPage(pageNo)
      const bhdr = pageNo === 1 ? 100 : 0
      const pageType = page[bhdr]!
      const cellCount = page.readUInt16BE(bhdr + 3)
      if (pageType === 0x05) {
        const rightChild = page.readUInt32BE(bhdr + 8)
        const ptrBase = bhdr + 12
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite interior cell pointer array out of bounds.')
        }
        stack.push(rightChild)
        for (let c = cellCount - 1; c >= 0; c -= 1) {
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
            throw new Error('SQLite interior cell offset out of bounds.')
          }
          stack.push(page.readUInt32BE(cellOff))
        }
      } else if (pageType === 0x0d) {
        const ptrBase = bhdr + 8
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite leaf cell pointer array out of bounds.')
        }
        for (let c = 0; c < cellCount; c += 1) {
          if (rows.length >= maxRows) {
            truncated = true
            break
          }
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
            throw new Error('SQLite leaf cell offset out of bounds.')
          }
          const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
          const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
          const payloadLen = Number(lenDec.value)
          if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
            throw new Error('Invalid SQLite leaf payload length.')
          }
          const payload = assembleLeafPayload(page, rowIdDec.nextOffset, payloadLen)
          const decoded = decodeSqliteRecord(payload, neededColumns)
          rows.push({ rowId: rowIdDec.value, ...decoded })
        }
        if (truncated) break
      } else {
        return { kind: 'fallback' }
      }
    }
    return { kind: 'ok', rows, truncated }
  }

  const readExtremeRowId = (
    rootPageNo: number,
    side: 'min' | 'max',
    idxColIndex: number,
  ):
    | { kind: 'empty' }
    | { kind: 'row'; rowId: bigint; idxSerialType: bigint }
    | { kind: 'fallback' } => {
    const visited = new Set<number>()
    const walk = (
      pageNo: number,
    ):
      | { kind: 'empty' }
      | { kind: 'row'; rowId: bigint; idxSerialType: bigint }
      | { kind: 'fallback' } => {
      if (visited.has(pageNo)) throw new Error('SQLite B-tree cycle detected.')
      visited.add(pageNo)
      const page = readPage(pageNo)
      const bhdr = pageNo === 1 ? 100 : 0
      const pageType = page[bhdr]!
      const cellCount = page.readUInt16BE(bhdr + 3)
      if (pageType === 0x0d) {
        if (cellCount === 0) return { kind: 'empty' }
        const ptrBase = bhdr + 8
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite leaf cell pointers out of bounds.')
        }
        const cellIndex = side === 'min' ? 0 : cellCount - 1
        const cellOff = page.readUInt16BE(ptrBase + cellIndex * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
          throw new Error('SQLite leaf cell offset out of bounds.')
        }
        const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
        const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
        const payloadLen = Number(lenDec.value)
        if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
          throw new Error('Invalid SQLite leaf payload length.')
        }
        const payloadPrefix = assembleLeafPayload(page, rowIdDec.nextOffset, payloadLen, 4096)
        const serialTypes = decodeSqliteRecordHeader(payloadPrefix, payloadLen, idxColIndex)
        const idxSerialType = serialTypes[idxColIndex]
        if (idxSerialType === undefined) {
          return { kind: 'fallback' }
        }
        return { kind: 'row', rowId: rowIdDec.value, idxSerialType }
      }
      if (pageType === 0x05) {
        const rightChild = page.readUInt32BE(bhdr + 8)
        const ptrBase = bhdr + 12
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite interior cell pointers out of bounds.')
        }
        const childPages: number[] = []
        for (let c = 0; c < cellCount; c += 1) {
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
            throw new Error('SQLite interior cell offset out of bounds.')
          }
          childPages.push(page.readUInt32BE(cellOff))
        }
        childPages.push(rightChild)
        const start = side === 'min' ? 0 : childPages.length - 1
        const step = side === 'min' ? 1 : -1
        for (let idx = start; idx >= 0 && idx < childPages.length; idx += step) {
          const res = walk(childPages[idx]!)
          if (res.kind !== 'empty') return res
        }
        return { kind: 'empty' }
      }
      return { kind: 'fallback' }
    }
    return walk(rootPageNo)
  }

  let trajectoryId: string
  let stepCount: number
  try {
    const metaRowsRes = collectTableRows(
      metaEntry.rootPage,
      2,
      Math.max(trajColIdx, cascadeColIdx) + 1,
    )
    if (metaRowsRes.kind === 'fallback') return { kind: 'fallback' }
    if (metaRowsRes.rows.length !== 1) {
      return returnInvalidIfStable()
    }
    const metaRow = metaRowsRes.rows[0]!
    if (metaDdl.rowidAliasCol === 'trajectory_id' || metaDdl.rowidAliasCol === 'cascade_id') {
      return { kind: 'fallback' }
    }
    if (metaRow.serialTypes.length <= trajColIdx || metaRow.serialTypes.length <= cascadeColIdx) {
      return { kind: 'fallback' }
    }
    const rawTrajectoryId = metaRow.values[trajColIdx]
    const cascadeId = metaRow.values[cascadeColIdx]
    if (!isValidAgyTrajectoryId(rawTrajectoryId) || cascadeId !== expectedSessionId) {
      return returnInvalidIfStable()
    }
    trajectoryId = rawTrajectoryId

    if (stepsDdl.rowidAliasCol !== 'idx') {
      const emptyProbe = collectTableRows(stepsEntry.rootPage, 1, 0)
      if (emptyProbe.kind === 'fallback') return { kind: 'fallback' }
      if (emptyProbe.rows.length === 0) {
        stepCount = 0
      } else {
        return { kind: 'fallback' }
      }
    } else {
      const minRes = readExtremeRowId(stepsEntry.rootPage, 'min', stepsIdxCol)
      if (minRes.kind === 'fallback') return { kind: 'fallback' }
      if (minRes.kind === 'empty') {
        stepCount = 0
      } else {
        const maxRes = readExtremeRowId(stepsEntry.rootPage, 'max', stepsIdxCol)
        if (maxRes.kind !== 'row') {
          if (maxRes.kind === 'fallback') return { kind: 'fallback' }
          throw new AgyTransientIdentityChurnError('B-tree extreme rowId mismatch.')
        }
        if (minRes.idxSerialType !== 0n || maxRes.idxSerialType !== 0n) {
          return { kind: 'fallback' }
        }
        if (
          minRes.rowId < 0n ||
          maxRes.rowId < 0n ||
          maxRes.rowId >= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          return returnInvalidIfStable()
        }
        stepCount = Number(maxRes.rowId) + 1
      }
    }
  } catch (error) {
    if (error instanceof AgyIdentityFallbackError) {
      return { kind: 'fallback' }
    }
    if (
      error instanceof AgyIdentityBudgetExceededError ||
      error instanceof AgyTransientIdentityChurnError ||
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyOperationalStorageError ||
      isOperationalFsError(error) ||
      isIdentityAbortOrTimeoutError(error)
    ) {
      throw error
    }
    // Re-verify source stability before classifying any decode failure as `invalid`.
    image.verifyUnchanged({ includeAccessedPages: true })
    if (error instanceof AgyUnexpectedEofError) {
      throw new AgyTransientIdentityChurnError(
        'SQLite file experienced unexpected EOF during bounded read.',
      )
    }
    throw error
  }

  image.verifyUnchanged({ includeAccessedPages: true })
  return { kind: 'ok', trajectoryId, stepCount }
}

/**
 * Safely reads the host-assigned `trajectory_id` and committed step count from an
 * Antigravity session SQLite database via the single unified anchored `withAgyReadImage`
 * view — acquiring SQLite-VFS-compatible SHARED lock before reading page 1, NEVER creating
 * `-wal` or `-shm` sidefiles in `conversations/`, and NEVER opening `new Database(sourcePath)`.
 */
export function readAgyTrajectoryIdentityDetailed(input: {
  readonly appDataDir: string
  readonly nativeSessionId: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly schemaCatalogBudget?: AgySchemaCatalogBudget
  readonly walShrinkBudget?: AgyWalShrinkBudget
}): AgyTrajectoryIdentityResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  if (
    !isValidAgyTrajectoryId(input.nativeSessionId) ||
    input.nativeSessionId === 'conversation_summaries' ||
    !isAbsolute(input.appDataDir)
  ) {
    return { status: 'invalid' }
  }
  const configuredRoot = resolve(input.appDataDir)
  let dbObservedPresent = false

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: Database.Database | undefined
    try {
      assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      const imageOutcome = withAgyReadImage(
        {
          rootDir: configuredRoot,
          parentSegments: ['conversations'],
          leafName: `${input.nativeSessionId}.db`,
        },
        {
          maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
          snapshotParentTempDir: resolveSnapshotParentTempDir(),
          ...(input.schemaCatalogBudget !== undefined
            ? { schemaCatalogBudget: input.schemaCatalogBudget }
            : {}),
          ...(input.walShrinkBudget !== undefined
            ? { walShrinkBudget: input.walShrinkBudget }
            : {}),
        },
        {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
          onLeafObserved: () => {
            dbObservedPresent = true
          },
        },
        (image) => {
          dbObservedPresent = true
          const fast = readFastIdentityFromCommittedImage(
            image,
            input.nativeSessionId,
            input.schemaCatalogBudget,
          )
          if (fast.kind === 'ok' || fast.kind === 'invalid') {
            return fast
          }
          const snapshot = image.materializePrivateSnapshot({
            maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
            snapshotParentTempDir: resolveSnapshotParentTempDir(),
            ...(input.schemaCatalogBudget !== undefined
              ? { schemaCatalogBudget: input.schemaCatalogBudget }
              : {}),
          })
          return { kind: 'materialized' as const, snapshot }
        },
      )

      if (imageOutcome.kind === 'ok') {
        return {
          status: 'ok',
          trajectoryId: imageOutcome.trajectoryId,
          stepCount: imageOutcome.stepCount,
        }
      }
      if (imageOutcome.kind === 'invalid') {
        return { status: 'invalid' }
      }

      const { snapshot } = imageOutcome
      try {
        db = snapshot.openReadOnlyDatabase()
      } catch (openError) {
        snapshot.cleanup()
        throw openError
      }
      const queried = queryBoundedIdentityFromOpenSqlite(
        db,
        input.nativeSessionId,
        snapshot.proof,
        {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
          ...(input.schemaCatalogBudget?.maxItemSqlBytes !== undefined
            ? { maxTableDdlBytes: input.schemaCatalogBudget.maxItemSqlBytes }
            : {}),
        },
      )
      if (queried.kind === 'invalid') {
        return { status: 'invalid' }
      }
      return {
        status: 'ok',
        trajectoryId: queried.trajectoryId,
        stepCount: queried.stepCount,
      }
    } catch (error) {
      if (
        (typeof AgyNativeLoaderError === 'function' && error instanceof AgyNativeLoaderError) ||
        (error instanceof Error &&
          (error.name === 'AgyNativeLoaderError' ||
            Reflect.get(error, 'code') === 'EAGY_NATIVE_LOADER')) ||
        error instanceof AgyOperationalStorageError ||
        isOperationalFsError(error) ||
        isOperationalSqliteError(error) ||
        isIdentityAbortOrTimeoutError(error)
      ) {
        throw error
      }
      if (
        error instanceof AgyIdentityBudgetExceededError ||
        (error instanceof AgentExecutionError && error.kind === 'response_too_large')
      ) {
        return {
          status: 'budget_exceeded',
          reason: boundIdentityReason(error.message),
        }
      }
      if (error instanceof AgyStorageMissingError) {
        if (error.stage === 'root' || error.stage === 'parent') {
          return { status: 'no_storage_root' }
        }
        if (!dbObservedPresent) {
          return { status: 'missing' }
        }
        if (attempt < 2) continue
        return { status: 'transient_churn' }
      }
      if (error instanceof AgyInvalidSqliteImageError) {
        return { status: 'invalid' }
      }
      const isTransient =
        isTransientAgySnapshotChurn(error) ||
        isSqliteBusyOrLockedError(error) ||
        error instanceof AgyUnexpectedEofError
      const attemptTransientReason =
        isTransient && error instanceof AgyTransientIdentityChurnError ? error.reason : undefined
      if (isTransient) {
        if (attempt < 2) continue
        return {
          status: 'transient_churn',
          ...(attemptTransientReason !== undefined
            ? { reason: boundIdentityReason(attemptTransientReason) }
            : {}),
        }
      }
      return { status: 'invalid' }
    } finally {
      try {
        db?.close()
      } catch {
        /* Best-effort close on read-only staged snapshot. */
      }
    }
  }
  return { status: 'invalid' }
}

export function readAgyTrajectoryIdentity(input: {
  readonly appDataDir: string
  readonly nativeSessionId: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): { readonly trajectoryId: string; readonly stepCount: number } | undefined {
  const res = readAgyTrajectoryIdentityDetailed(input)
  return res.status === 'ok'
    ? { trajectoryId: res.trajectoryId, stepCount: res.stepCount }
    : undefined
}
