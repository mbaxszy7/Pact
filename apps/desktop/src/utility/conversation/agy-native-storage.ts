import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  fstatSync,
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
  agyRebuildInitializationWitnessSchema,
  type NativeContextRebuildChunk,
} from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'
import { projectCollaborationAnswer } from './collaboration-answer'
import { requireNativeImageReference } from './native-image-content'

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
const SAFE_ID_PATTERN = /^[0-9a-z_.:-]{1,256}$/iu
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

function verifySafeDirectoryChainIfPresent(
  canonicalAppDataDir: string,
  relativeParts: readonly string[],
  label = 'Antigravity brain',
): { exists: true; canonicalDir: string } | { exists: false } {
  let cursor = canonicalAppDataDir
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
  }
  return { exists: true, canonicalDir: cursor }
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
    const mediaBytes = readFileSync(fd)
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
): Omit<AgyMediaCopyPlan, 'inlineData'> | undefined {
  if (!uri) return undefined
  const hasFileScheme = uri.startsWith('file://')
  let rawPath = uri
  if (hasFileScheme) {
    try {
      const parsed = new URL(uri)
      if (parsed.protocol !== 'file:') return undefined
      rawPath = decodeURIComponent(parsed.pathname)
      if (process.platform === 'win32' && /^\/[a-zA-Z]:\//u.test(rawPath)) {
        rawPath = rawPath.slice(1)
      }
    } catch {
      return undefined
    }
  }
  if (!isAbsolute(rawPath)) return undefined
  const resolvedRaw = resolve(rawPath)
  const sourceBrainRoot = join(canonicalAppDataDir, 'brain', sourceCascadeId)
  const sourceUploadedRoot = join(sourceBrainRoot, '.user_uploaded')
  const normalizedDir = dirname(resolvedRaw)
  const fileName = basename(resolvedRaw)

  // Always walk and lstat + realpath-verify brain/<sourceCascadeId>/.user_uploaded (never skipping when string-equal!).
  const verifiedAncestors = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sourceCascadeId, '.user_uploaded'],
    'Antigravity uploaded media',
  )

  let matchesSourceUploaded = false
  if (verifiedAncestors.exists) {
    try {
      const dirStat = lstatSync(dirname(rawPath), { bigint: true })
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        if (
          normalizedDir === sourceUploadedRoot ||
          isInsideDirectory(sourceBrainRoot, resolvedRaw)
        ) {
          throw new Error(
            'Antigravity uploaded media directory is a symbolic link or non-directory.',
          )
        }
        return undefined
      }
      const realDir = realpathSync(dirname(rawPath))
      matchesSourceUploaded = realDir === verifiedAncestors.canonicalDir
    } catch (error) {
      if (
        error instanceof Error &&
        Reflect.get(error, 'code') !== 'ENOENT' &&
        (normalizedDir === sourceUploadedRoot || isInsideDirectory(sourceBrainRoot, resolvedRaw))
      ) {
        throw error
      }
      matchesSourceUploaded = false
    }
  } else {
    matchesSourceUploaded = normalizedDir === sourceUploadedRoot
  }

  if (!matchesSourceUploaded) {
    if (isInsideDirectory(sourceBrainRoot, resolvedRaw) || resolvedRaw === sourceBrainRoot) {
      throw new Error(
        'Antigravity step media references a non-upload path inside the source brain directory.',
      )
    }
    return undefined
  }
  if (
    !SAFE_UPLOAD_NAME_PATTERN.test(fileName) ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new Error('Antigravity uploaded media filename is unsafe.')
  }
  const sourceFilePath = join(sourceUploadedRoot, fileName)
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

function resolveStorageRoot(storageRoot?: string): string {
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

class AgyHotRollbackJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgyHotRollbackJournalError'
  }
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

function assertNoRollbackJournal(dbPath: string, phase: 'before' | 'after'): void {
  const journalPath = `${dbPath}-journal`
  try {
    lstatSync(journalPath, { bigint: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return
    }
    throw error
  }
  throw new AgyHotRollbackJournalError(
    `Antigravity SQLite rollback journal (${basename(journalPath)}) is present ${phase} snapshot; trajectory state is unconfirmed.`,
  )
}

interface SqliteFileIdentitySnapshot {
  dbPath: string
  canonicalRoot: string
  canonicalDbPath: string
  dbStats: BigIntStats
  walStats: BigIntStats | null
  shmStats: BigIntStats | null
}

function captureOptionalSidefileStats(
  filePath: string,
  canonicalRoot: string,
  label: 'WAL' | 'SHM',
): BigIntStats | null {
  try {
    const stat = lstatSync(filePath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error(`Antigravity ${label} file is linked or unsupported.`)
    }
    const realSide = realpathSync(filePath)
    if (!isInsideDirectory(canonicalRoot, realSide)) {
      throw new Error(`Antigravity ${label} file escaped its storage root.`)
    }
    return stat
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

function captureOptionalWalStats(walPath: string, canonicalRoot: string): BigIntStats | null {
  return captureOptionalSidefileStats(walPath, canonicalRoot, 'WAL')
}

function captureSqliteIdentity(
  dbPath: string,
  canonicalRoot: string,
  maxBytes = AGY_MAX_HISTORY_BYTES * 2,
): SqliteFileIdentitySnapshot {
  assertNoRollbackJournal(dbPath, 'before')
  const before = lstatSync(dbPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('Antigravity trajectory database must be one ordinary non-linked file.')
  }
  const canonicalDbPath = realpathSync(dbPath)
  if (!isInsideDirectory(canonicalRoot, canonicalDbPath)) {
    throw new Error('Antigravity trajectory database escaped its effective storage root.')
  }
  const fd = openSync(dbPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(before, opened) || realpathSync(dbPath) !== canonicalDbPath) {
      throw new Error('Antigravity trajectory database identity changed while opening.')
    }
  } finally {
    closeSync(fd)
  }
  const walStats = captureOptionalSidefileStats(`${dbPath}-wal`, canonicalRoot, 'WAL')
  const shmStats = captureOptionalSidefileStats(`${dbPath}-shm`, canonicalRoot, 'SHM')
  assertNoRollbackJournal(dbPath, 'before')
  const totalBytes = before.size + (walStats?.size ?? 0n)
  if (totalBytes > BigInt(maxBytes)) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity trajectory database exceeds its read byte budget.',
      false,
    )
  }
  return { dbPath, canonicalRoot, canonicalDbPath, dbStats: before, walStats, shmStats }
}

const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'ascii')

function copyVerifiedFileToStaging(
  sourcePath: string,
  expectedCanonicalSource: string,
  expectedStats: BigIntStats,
  targetPath: string,
  patchWalHeaderToDelete: boolean,
): string {
  const srcFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(srcFd, { bigint: true })
    if (
      !statsMatch(expectedStats, opened) ||
      realpathSync(sourcePath) !== expectedCanonicalSource
    ) {
      throw new Error('Antigravity SQLite file changed while opening for staged snapshot.')
    }
    const dstFd = openSync(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const hasher = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let copied = 0n
    let firstChunk = true
    try {
      while (copied < expectedStats.size) {
        const toRead = Number(
          expectedStats.size - copied < BigInt(chunk.byteLength)
            ? expectedStats.size - copied
            : BigInt(chunk.byteLength),
        )
        const n = readSync(srcFd, chunk, 0, toRead, Number(copied))
        if (n <= 0) break
        const slice = chunk.subarray(0, n)
        hasher.update(slice)
        if (firstChunk) {
          firstChunk = false
          if (
            patchWalHeaderToDelete &&
            n >= 20 &&
            slice.subarray(0, 16).equals(SQLITE_HEADER_MAGIC) &&
            (slice[18] === 2 || slice[19] === 2)
          ) {
            const patched = Buffer.from(slice)
            patched[18] = 1
            patched[19] = 1
            writeAllSync(dstFd, patched, 0, n)
          } else {
            writeAllSync(dstFd, slice, 0, n)
          }
        } else {
          writeAllSync(dstFd, slice, 0, n)
        }
        copied += BigInt(n)
      }
      const dstStat = fstatSync(dstFd, { bigint: true })
      if (dstStat.size !== expectedStats.size) {
        throw new Error('Staged Antigravity SQLite copy byte length did not match expected size.')
      }
    } finally {
      closeSync(dstFd)
    }
    const afterFd = fstatSync(srcFd, { bigint: true })
    if (copied !== expectedStats.size || !statsMatch(expectedStats, afterFd)) {
      throw new Error('Antigravity SQLite file changed while copying staged snapshot.')
    }
    return hasher.digest('hex')
  } finally {
    closeSync(srcFd)
  }
}

function hashFileVerifiedReadOnly(
  sourcePath: string,
  expectedCanonicalSource: string,
  expectedStats: BigIntStats,
): string {
  const srcFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(srcFd, { bigint: true })
    if (
      !statsMatch(expectedStats, opened) ||
      realpathSync(sourcePath) !== expectedCanonicalSource
    ) {
      throw new Error('Antigravity SQLite file changed after staged snapshot.')
    }
    const hasher = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let offset = 0n
    while (offset < expectedStats.size) {
      const toRead = Number(
        expectedStats.size - offset < BigInt(chunk.byteLength)
          ? expectedStats.size - offset
          : BigInt(chunk.byteLength),
      )
      const n = readSync(srcFd, chunk, 0, toRead, Number(offset))
      if (n <= 0) break
      hasher.update(chunk.subarray(0, n))
      offset += BigInt(n)
    }
    const afterFd = fstatSync(srcFd, { bigint: true })
    if (offset !== expectedStats.size || !statsMatch(expectedStats, afterFd)) {
      throw new Error('Antigravity SQLite file changed during post-stage digest check.')
    }
    return hasher.digest('hex')
  } finally {
    closeSync(srcFd)
  }
}

/**
 * Stages `<sid>.db` (and `<sid>.db-wal` if present) into an isolated `0o700` temp directory
 * before opening SQLite so SQLite Unix VFS NEVER creates `-shm` or `-wal` sidefiles in `conversations/`.
 */
function resolveSnapshotParentTempDir(): string {
  if (activeAgyTempStagingRoot !== undefined) {
    if (!isAbsolute(activeAgyTempStagingRoot)) {
      throw new Error('Antigravity caller-owned temp staging directory must be an absolute path.')
    }
    const stat = lstatSync(activeAgyTempStagingRoot, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'Antigravity caller-owned temp staging directory must be a non-linked directory.',
      )
    }
    return activeAgyTempStagingRoot
  }
  return tmpdir()
}

function openReadOnlySqliteSnapshot(
  snapshot: SqliteFileIdentitySnapshot,
  originalStorageRoot: string,
): Database.Database {
  const tempDir = mkdtempSync(join(resolveSnapshotParentTempDir(), 'pact-agy-ro-'))
  chmodSync(tempDir, 0o700)
  try {
    const stagedDbPath = join(tempDir, 'snapshot.db')
    const hasActiveWal = snapshot.walStats !== null && snapshot.walStats.size > 0n
    const dbHash = copyVerifiedFileToStaging(
      snapshot.dbPath,
      snapshot.canonicalDbPath,
      snapshot.dbStats,
      stagedDbPath,
      !hasActiveWal,
    )
    let walHash: string | undefined
    let canonicalWalPath: string | undefined
    if (snapshot.walStats !== null) {
      const srcWalPath = `${snapshot.dbPath}-wal`
      canonicalWalPath = realpathSync(srcWalPath)
      walHash = copyVerifiedFileToStaging(
        srcWalPath,
        canonicalWalPath,
        snapshot.walStats,
        `${stagedDbPath}-wal`,
        false,
      )
    }

    assertSqliteIdentityUnchanged(snapshot, originalStorageRoot)
    // Verify pre/post digest consistency across `.db` and `.db-wal` so torn concurrent WAL/DB checkpoints cannot slip through!
    if (
      hashFileVerifiedReadOnly(snapshot.dbPath, snapshot.canonicalDbPath, snapshot.dbStats) !==
      dbHash
    ) {
      throw new Error('Antigravity SQLite database bytes changed while staging WAL snapshot.')
    }
    if (
      snapshot.walStats !== null &&
      canonicalWalPath !== undefined &&
      hashFileVerifiedReadOnly(`${snapshot.dbPath}-wal`, canonicalWalPath, snapshot.walStats) !==
        walHash
    ) {
      throw new Error('Antigravity SQLite WAL bytes changed while staging snapshot.')
    }
    assertSqliteIdentityUnchanged(snapshot, originalStorageRoot)

    // When `hasActiveWal` is true and `-shm` was missing, SQLite requires write access on our disposable
    // staged copy to recover the WAL without `SQLITE_READONLY_RECOVERY`; we then lock `query_only = ON`.
    const db = hasActiveWal
      ? new Database(stagedDbPath, { fileMustExist: true })
      : new Database(stagedDbPath, { readonly: true, fileMustExist: true })
    if (hasActiveWal) {
      db.pragma('query_only = ON')
    }
    const origClose = db.close.bind(db)
    let cleaned = false
    db.close = (): Database.Database => {
      try {
        return origClose()
      } finally {
        if (!cleaned) {
          cleaned = true
          try {
            rmSync(tempDir, { recursive: true, force: true })
          } catch {
            /* Best-effort cleanup of private temp snapshot directory. */
          }
        }
      }
    }
    return db
  } catch (error) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* Best-effort cleanup on failed open. */
    }
    throw error
  }
}

function assertSqliteIdentityUnchanged(
  snapshot: SqliteFileIdentitySnapshot,
  originalStorageRoot: string,
): void {
  if (realpathSync(originalStorageRoot) !== snapshot.canonicalRoot) {
    throw new Error('Antigravity storage root changed during inspection.')
  }
  const currentDb = lstatSync(snapshot.dbPath, { bigint: true })
  if (
    !currentDb.isFile() ||
    currentDb.isSymbolicLink() ||
    currentDb.nlink !== 1n ||
    !statsMatch(snapshot.dbStats, currentDb) ||
    realpathSync(snapshot.dbPath) !== snapshot.canonicalDbPath
  ) {
    throw new Error('Antigravity trajectory database changed during inspection.')
  }
  const currentWal = captureOptionalSidefileStats(
    `${snapshot.dbPath}-wal`,
    snapshot.canonicalRoot,
    'WAL',
  )
  const currentShm = captureOptionalSidefileStats(
    `${snapshot.dbPath}-shm`,
    snapshot.canonicalRoot,
    'SHM',
  )
  if (snapshot.walStats === null) {
    if (currentWal !== null) {
      throw new Error('Antigravity trajectory WAL appeared during inspection.')
    }
  } else if (currentWal === null || !statsMatch(snapshot.walStats, currentWal)) {
    throw new Error('Antigravity trajectory WAL changed during inspection.')
  }
  if (snapshot.shmStats === null && currentShm !== null) {
    throw new Error('Antigravity trajectory SHM appeared during inspection.')
  }
  assertNoRollbackJournal(snapshot.dbPath, 'after')
}

function computePhysicalDbDigest(
  dbPath: string,
  canonicalRoot: string,
  originalStorageRoot: string,
): { rawHash: string; rawBytes: number } {
  const snapshot = captureSqliteIdentity(dbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  const hasher = createHash('sha256')
  hasher.update('pact-agy-sqlite-physical-v1\0')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let totalBytes = 0

  const hashFile = (filePath: string, expectedSize: bigint): void => {
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (!opened.isFile() || opened.size !== expectedSize) {
        throw new Error('Antigravity database file size changed while hashing.')
      }
      let offset = 0
      const target = Number(expectedSize)
      while (offset < target) {
        const toRead = Math.min(chunk.length, target - offset)
        const bytesRead = readSync(fd, chunk, 0, toRead, offset)
        if (bytesRead <= 0) break
        offset += bytesRead
        totalBytes += bytesRead
        if (totalBytes > AGY_MAX_HISTORY_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity trajectory database exceeds its 32 MiB budget.',
            false,
          )
        }
        hasher.update(chunk.subarray(0, bytesRead))
      }
      if (offset !== target) {
        throw new Error('Antigravity database read ended before expected EOF.')
      }
    } finally {
      closeSync(fd)
    }
  }

  hasher.update('main\0')
  hashFile(dbPath, snapshot.dbStats.size)
  if (snapshot.walStats && snapshot.walStats.size > 0n) {
    hasher.update('\0wal\0')
    hashFile(`${dbPath}-wal`, snapshot.walStats.size)
  }
  assertSqliteIdentityUnchanged(snapshot, originalStorageRoot)
  return { rawHash: hasher.digest('hex'), rawBytes: totalBytes }
}

interface SqliteMasterRow {
  name: string
  type: string
  sql: string | null
}

interface TableColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
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

function readTableColumns(db: Database.Database, tableName: string): string[] {
  const rows = db
    .prepare<[], TableColumnInfo>(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
    .all()
  const names = rows.map((row) => row.name)
  for (const name of names) quoteSqlIdentifier(name)
  return names
}

function validateTrajectoryDatabase(
  db: Database.Database,
  expectedSessionId: string,
): ValidatedTrajectorySchema {
  const masterRows = db
    .prepare<[], SqliteMasterRow>(
      `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name ASC`,
    )
    .all()

  const tables = new Map<string, SqliteMasterRow>()
  const indexes: SqliteMasterRow[] = []
  for (const row of masterRows) {
    if (row.type === 'view' || row.type === 'trigger') {
      throw new Error(`Unsupported SQLite ${row.type} (${row.name}) in Antigravity trajectory.`)
    }
    if (row.type === 'table') {
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
  const metaRows = db
    .prepare<[], Record<string, unknown>>('SELECT * FROM "trajectory_meta" LIMIT 2')
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
    trajectoryMetadataRows = db
      .prepare<[], Record<string, unknown>>('SELECT * FROM "trajectory_metadata_blob" LIMIT 2')
      .all()
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
): string | undefined {
  if (!rawPathOrUri) return undefined
  let candidatePath = rawPathOrUri
  if (candidatePath.startsWith('file://')) {
    try {
      const url = new URL(candidatePath)
      if (url.protocol !== 'file:') return undefined
      candidatePath = decodeURIComponent(url.pathname)
      if (process.platform === 'win32' && /^\/[a-zA-Z]:\//u.test(candidatePath)) {
        candidatePath = candidatePath.slice(1)
      }
    } catch {
      return undefined
    }
  }
  if (!isAbsolute(candidatePath)) return undefined
  const brainDir = join(canonicalAppDataDir, 'brain', sessionId)
  const dir = dirname(candidatePath)
  const name = basename(candidatePath)
  if (!name.toLowerCase().endsWith('.md') || name.startsWith('.') || name.length > 255) {
    return undefined
  }
  let inBrainDir = dir === brainDir
  if (!inBrainDir) {
    try {
      inBrainDir = realpathSync(dir) === brainDir
    } catch {
      inBrainDir = false
    }
  }
  return inBrainDir ? join(brainDir, name) : undefined
}

function parseArtifactOperationFromStep(
  stepIndex: number,
  rowStatus: number,
  decodedStep: DecodedAgyStep,
  meta: DecodedCortexStepMetadata,
  canonicalAppDataDir: string,
  sessionId: string,
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
    decodedStep.writeToFileUri
  if (!rawPath) return undefined

  const resolvedBrainMd = resolveBrainMarkdownPath(rawPath, canonicalAppDataDir, sessionId)
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

  const nativeId = call?.id || meta.stepId || `step:${stepIndex}`
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
        : undefined
  const replacement =
    typeof argsRecord?.['Replacement'] === 'string'
      ? argsRecord['Replacement']
      : typeof argsRecord?.['replacement'] === 'string'
        ? argsRecord['replacement']
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

function readVerifiedBrainMarkdownFile(filePath: string, canonicalAppDataDir: string): string {
  const before = lstatSync(filePath, { bigint: true })
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
  const canonicalPath = realpathSync(filePath)
  if (!isInsideDirectory(canonicalAppDataDir, canonicalPath)) {
    throw new Error('Antigravity plan artifact escaped its storage root.')
  }
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(before, opened) || realpathSync(filePath) !== canonicalPath) {
      throw new Error('Antigravity plan artifact changed while opening.')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(filePath, { bigint: true })
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
): { plan?: { nativeId: string; text: string }; planUnavailable?: true } {
  const boundPaths = new Set<string>()
  const simulatedBodies = new Map<string, { text: string; complete: boolean }>()

  const targetOps: ParsedArtifactStepOp[] = []
  const postTargetTouchedPaths = new Set<string>()
  let seenTargetExecution = false

  for (const op of ops) {
    const isTarget = op.executionId === targetExecutionId
    if (isTarget) seenTargetExecution = true

    const bindsArtifact = op.hasArtifactMetadata || boundPaths.has(op.filePath)
    if (!bindsArtifact) continue
    boundPaths.add(op.filePath)

    if (seenTargetExecution && !isTarget) {
      postTargetTouchedPaths.add(op.filePath)
      continue
    }

    if (isTarget) targetOps.push(op)

    if (!op.completed) {
      simulatedBodies.set(op.filePath, { text: '', complete: false })
      continue
    }

    if (op.toolName === 'write_file') {
      if (op.content === undefined) {
        simulatedBodies.set(op.filePath, { text: '', complete: false })
      } else if (op.append) {
        const previous = simulatedBodies.get(op.filePath)
        if (!previous || !previous.complete) {
          simulatedBodies.set(op.filePath, { text: '', complete: false })
        } else {
          simulatedBodies.set(op.filePath, {
            text: `${previous.text}${op.content}`,
            complete: true,
          })
        }
      } else {
        simulatedBodies.set(op.filePath, { text: op.content, complete: true })
      }
    } else {
      const previous = simulatedBodies.get(op.filePath)
      if (
        !previous ||
        !previous.complete ||
        !op.target ||
        op.replacement === undefined ||
        !previous.text.includes(op.target)
      ) {
        simulatedBodies.set(op.filePath, { text: '', complete: false })
      } else {
        simulatedBodies.set(op.filePath, {
          text: previous.text.replaceAll(op.target, op.replacement),
          complete: true,
        })
      }
    }
  }

  if (targetOps.length === 0) return {}
  if (targetOps.some((op) => !op.completed)) return { planUnavailable: true }

  const distinctTargetPaths = new Set(targetOps.map((op) => op.filePath))
  if (distinctTargetPaths.size !== 1) return { planUnavailable: true }

  const lastOp = targetOps.at(-1)!
  if (postTargetTouchedPaths.has(lastOp.filePath)) return { planUnavailable: true }

  let diskText: string
  try {
    diskText = readVerifiedBrainMarkdownFile(lastOp.filePath, canonicalAppDataDir)
  } catch {
    return { planUnavailable: true }
  }
  if (!diskText) return { planUnavailable: true }

  const simulated = simulatedBodies.get(lastOp.filePath)
  if (simulated?.complete) {
    if (diskText !== simulated.text) return { planUnavailable: true }
  } else if (
    lastOp.toolName === 'edit_file' &&
    lastOp.replacement &&
    !diskText.includes(lastOp.replacement)
  ) {
    return { planUnavailable: true }
  }

  return { plan: { nativeId: lastOp.nativeId, text: diskText } }
}

export function inspectAgyTrajectory(input: AgyColdInspectionInput): AgyColdInspectionResult {
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
  try {
    lstatSync(dbPath, { bigint: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return {
        exists: false,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: canonicalRoot,
        nativePath: dbPath,
        stepCount: 0,
      }
    }
    throw error
  }

  let snapshot: SqliteFileIdentitySnapshot
  let db: Database.Database
  try {
    snapshot = captureSqliteIdentity(dbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
    db = openReadOnlySqliteSnapshot(snapshot, configuredRoot)
  } catch (error) {
    if (error instanceof AgyHotRollbackJournalError) {
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
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId)

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
      assertSqliteIdentityUnchanged(snapshot, configuredRoot)
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshot.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    if (!SAFE_ID_PATTERN.test(input.nativeTurnId)) {
      throw new Error('Invalid Antigravity execution_id.')
    }

    let totalBlobBytes = 0
    let imageBytes = 0
    const execRows = db
      .prepare<[], { idx: number; data: Buffer }>(
        'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
      )
      .all()
    const execByExecutionId = new Map<string, DecodedExecutorMetadata>()
    for (const row of execRows) {
      if (!Buffer.isBuffer(row.data)) throw new Error('Invalid executor_metadata.data BLOB.')
      totalBlobBytes += row.data.byteLength
      if (totalBlobBytes > AGY_MAX_HISTORY_BYTES) {
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

    const artifactOps: ParsedArtifactStepOp[] = []
    const seenStepExecutionIds = new Set<string>()
    const rootUserSeenExecutions = new Set<string>()
    const pactRunMatchedExecutions = new Set<string>()
    const inspectedSteps: Array<{
      idx: number
      stepType: number
      status: number
      columnPayloadMatches: boolean
      decodedStep: DecodedAgyStep
      meta: DecodedCortexStepMetadata
      pactIdentity?: ExtractedPactPromptIdentity
    }> = []

    for (const [expectedIdx, row] of stepRows.entries()) {
      if (row.idx !== expectedIdx) {
        throw new Error('Antigravity steps table has a non-contiguous step index gap.')
      }
      assertCompatibleStepRowFormat(row.step_format, schema.hasStepFormatColumn, row.idx)
      if (!Buffer.isBuffer(row.step_blob)) {
        throw new Error(
          `Antigravity step ${row.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
        )
      }
      totalBlobBytes += row.step_blob.byteLength + (row.metadata?.byteLength ?? 0)
      const decodedStep = decodeAgyStep(row.step_blob)
      const columnPayloadMatches =
        decodedStep.type === row.step_type && decodedStep.status === row.status
      if (decodedStep.userInput) {
        for (const media of decodedStep.userInput.media) {
          imageBytes += media.inlineData?.byteLength ?? 0
        }
      }
      if (totalBlobBytes > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity steps exceed the 32 MiB history budget.',
          false,
        )
      }
      if (totalBlobBytes - imageBytes > AGY_TEXT_BUDGET_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
          false,
        )
      }

      const meta = extractEffectiveStepMetadata(row.metadata, decodedStep)
      if (meta.executionId) {
        seenStepExecutionIds.add(meta.executionId)
      }
      if (input.includePlan && columnPayloadMatches) {
        const parsedOp = parseArtifactOperationFromStep(
          row.idx,
          row.status,
          decodedStep,
          meta,
          canonicalRoot,
          input.nativeSessionId,
        )
        if (parsedOp) artifactOps.push(parsedOp)
      }

      let pactIdentity: ExtractedPactPromptIdentity | undefined
      if (
        row.step_type === CORTEX_STEP_TYPE_USER_INPUT &&
        decodedStep.type === CORTEX_STEP_TYPE_USER_INPUT &&
        decodedStep.userInput
      ) {
        pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        if (meta.executionId && !rootUserSeenExecutions.has(meta.executionId)) {
          rootUserSeenExecutions.add(meta.executionId)
          if (pactIdentity.pactRunId === input.nativeTurnId) {
            pactRunMatchedExecutions.add(meta.executionId)
          }
        } else if (meta.executionId && pactIdentity.pactRunId === input.nativeTurnId) {
          throw new Error('Antigravity non-root user input unexpectedly carries root pactRunId.')
        }
      }

      inspectedSteps.push({
        idx: row.idx,
        stepType: row.step_type,
        status: row.status,
        columnPayloadMatches,
        decodedStep,
        meta,
        ...(pactIdentity ? { pactIdentity } : {}),
      })
    }

    try {
      assertSqliteIdentityUnchanged(snapshot, configuredRoot)
    } catch (error) {
      if (error instanceof AgyHotRollbackJournalError) {
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
        nativePath: snapshot.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const matchedExec = execByExecutionId.get(resolvedExecutionId)
    const consumedInputs: AgyConsumedInputReceipt[] = []
    const plannerItems: Array<{ id: string; text: string }> = []
    let seenExecutionSteps = 0
    let maxSeenExecutionStepIdx = -1
    let hasActiveStep = false
    let hasCanceledStep = false
    let hasFailedCoreStep = false
    let hasMetadataContradiction = false

    for (const step of inspectedSteps) {
      if (step.meta.executionId !== resolvedExecutionId) continue
      seenExecutionSteps += 1
      if (step.idx > maxSeenExecutionStepIdx) maxSeenExecutionStepIdx = step.idx

      if (!step.columnPayloadMatches) {
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
        ].includes(step.status)
      ) {
        hasActiveStep = true
      } else if (
        step.status === CORTEX_STEP_STATUS_CANCELED ||
        step.status === CORTEX_STEP_STATUS_INTERRUPTED
      ) {
        hasCanceledStep = true
      } else if (
        (step.stepType === CORTEX_STEP_TYPE_USER_INPUT ||
          step.stepType === CORTEX_STEP_TYPE_PLANNER_RESPONSE) &&
        (step.status === CORTEX_STEP_STATUS_ERROR ||
          step.status === CORTEX_STEP_STATUS_INVALID ||
          step.decodedStep.hasError)
      ) {
        hasFailedCoreStep = true
      }

      if (
        step.columnPayloadMatches &&
        step.stepType === CORTEX_STEP_TYPE_USER_INPUT &&
        step.status === CORTEX_STEP_STATUS_DONE &&
        step.decodedStep.userInput
      ) {
        consumedInputs.push({
          stepIndex: step.idx,
          ...(step.meta.stepId ? { stepId: step.meta.stepId } : {}),
          ...(step.decodedStep.userInput.clientMessageId
            ? { clientMessageId: step.decodedStep.userInput.clientMessageId }
            : {}),
          ...(step.pactIdentity?.messageId ? { pactMessageId: step.pactIdentity.messageId } : {}),
          ...(step.pactIdentity?.pactRunId ? { pactRunId: step.pactIdentity.pactRunId } : {}),
          textSha256: sha256Hex(step.decodedStep.userInput.text),
        })
      } else if (
        step.stepType === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        step.decodedStep.type === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        step.decodedStep.plannerResponse &&
        step.decodedStep.plannerResponse.canonicalText.length > 0 &&
        step.status !== CORTEX_STEP_STATUS_INVALID &&
        step.decodedStep.status !== CORTEX_STEP_STATUS_INVALID
      ) {
        plannerItems.push({
          id: step.meta.stepId ?? `step:${step.idx}`,
          text: step.decodedStep.plannerResponse.canonicalText,
        })
      }
    }

    if (!matchedExec && seenExecutionSteps === 0) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshot.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const lastStepRow =
      matchedExec?.lastStepIdx !== undefined ? inspectedSteps[matchedExec.lastStepIdx] : undefined
    const storedTerminalComplete =
      !hasMetadataContradiction &&
      seenExecutionSteps > 0 &&
      consumedInputs.length > 0 &&
      matchedExec?.lastStepIdx !== undefined &&
      lastStepRow !== undefined &&
      lastStepRow.columnPayloadMatches &&
      lastStepRow.meta.executionId === resolvedExecutionId &&
      maxSeenExecutionStepIdx === matchedExec.lastStepIdx &&
      lastStepRow.status === CORTEX_STEP_STATUS_DONE &&
      lastStepRow.decodedStep.status === CORTEX_STEP_STATUS_DONE &&
      !lastStepRow.decodedStep.hasError &&
      !lastStepRow.decodedStep.genericHasError

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
      ? evaluateColdPlanArtifact(artifactOps, resolvedExecutionId, canonicalRoot)
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
      nativePath: snapshot.canonicalDbPath,
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
      },
    }
  } finally {
    db.close()
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

function writeIdempotentPrivateFile(
  targetPath: string,
  canonicalAppDataDir: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  try {
    const fd = openSync(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      writeAllSync(fd, bytes, 0, bytes.byteLength)
      if (fstatSync(fd, { bigint: true }).size !== BigInt(bytes.byteLength)) {
        throw new Error('Antigravity private file byte length did not match expected size.')
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'EEXIST') throw error
  }
  const existing = lstatSync(targetPath, { bigint: true })
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n) {
    throw new Error('Existing Antigravity uploaded media target is linked or unsupported.')
  }
  if (!isInsideDirectory(canonicalAppDataDir, realpathSync(targetPath))) {
    throw new Error('Existing Antigravity uploaded media target escaped its storage root.')
  }
  const currentBytes = readFileSync(targetPath)
  if (currentBytes.byteLength !== bytes.byteLength || sha256Hex(currentBytes) !== expectedSha256) {
    throw new Error('Existing Antigravity uploaded media target differs from its expected content.')
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
  const summariesPath = join(canonicalAppDataDir, 'conversation_summaries.db')
  const snapshot = captureSqliteIdentity(summariesPath, canonicalAppDataDir, AGY_MAX_HISTORY_BYTES)
  const db = openReadOnlySqliteSnapshot(snapshot, canonicalAppDataDir)
  try {
    const cols = readTableColumns(db, 'conversation_summaries')
    if (!cols.includes('conversation_id') || !cols.includes('step_count')) {
      throw new Error('Antigravity conversation_summaries table is missing required columns.')
    }
    const selectCols = [
      'conversation_id',
      'step_count',
      ...(cols.includes('title') ? ['title'] : []),
      ...(cols.includes('raw_summary') ? ['raw_summary'] : []),
      ...(cols.includes('parent_conversation_id') ? ['parent_conversation_id'] : []),
    ]
      .map(quoteSqlIdentifier)
      .join(', ')
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
    assertSqliteIdentityUnchanged(snapshot, canonicalAppDataDir)
    return { stepCount }
  } finally {
    db.close()
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

function clearEmptyShellWalBeforePublish(
  candidateDbPath: string,
  canonicalAppDataDir: string,
): void {
  const hasWal = captureOptionalWalStats(`${candidateDbPath}-wal`, canonicalAppDataDir) !== null
  let hasShm = false
  try {
    lstatSync(`${candidateDbPath}-shm`, { bigint: true })
    hasShm = true
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }
  if (!hasWal && !hasShm) return

  const shellDb = new Database(candidateDbPath, { fileMustExist: true, timeout: 0 })
  try {
    const countRow = shellDb
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "steps"')
      .get()!
    if (countRow.count !== 0) {
      throw new Error('Antigravity candidate database changed before atomic publication.')
    }
    shellDb.pragma('wal_checkpoint(TRUNCATE)')
    shellDb.pragma('journal_mode = DELETE')
  } finally {
    shellDb.close()
  }
  if (captureOptionalWalStats(`${candidateDbPath}-wal`, canonicalAppDataDir) !== null) {
    throw new Error('Antigravity candidate WAL could not be cleared before atomic publication.')
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

function removeStagingArtifactsBestEffort(stagingPath: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      rmSync(`${stagingPath}${suffix}`, { force: true })
    } catch {
      /* Cleanup best effort on error path. */
    }
  }
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
  const dbPath = join(canonicalRoot, 'conversations', `${input.nativeSessionId}.db`)

  const snapshot = captureSqliteIdentity(dbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  const db = openReadOnlySqliteSnapshot(snapshot, configuredRoot)
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId)
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

    assertSqliteIdentityUnchanged(snapshot, configuredRoot)
    const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
    if (summary.stepCount !== 2) {
      throw new Error('Antigravity conversation_summaries.step_count is not synchronized.')
    }
  } finally {
    db.close()
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
  const tmpReceiptPath = `${receiptPath}.tmp-${randomBytes(12).toString('hex')}`
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
  const dbPath = join(canonicalRoot, 'conversations', `${input.nativeSessionId}.db`)

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

  const snapshot = captureSqliteIdentity(dbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  const db = openReadOnlySqliteSnapshot(snapshot, configuredRoot)
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId)
    if (input.expectedTrajectoryId && schema.trajectoryId !== input.expectedTrajectoryId) {
      throw new Error('Antigravity rebuild trajectory_id changed.')
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

    assertSqliteIdentityUnchanged(snapshot, configuredRoot)

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

    const physical = computePhysicalDbDigest(dbPath, canonicalRoot, configuredRoot)
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
      nativePath: snapshot.canonicalDbPath,
      ...(initializationWitness ? { initializationWitness } : {}),
    }
  } finally {
    db.close()
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
  const candidateDbPath = join(conversationsDir, `${input.nativeSessionId}.db`)

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
    if (
      Buffer.byteLength(serialized.expectedUserText, 'utf8') + totalMediaBytes >
      AGY_MAX_HISTORY_BYTES
    ) {
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

  const shellSnapshot = captureSqliteIdentity(candidateDbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  let alreadySeeded = false
  let shellSchema: ValidatedTrajectorySchema
  const shellDb = openReadOnlySqliteSnapshot(shellSnapshot, configuredRoot)
  try {
    shellSchema = validateTrajectoryDatabase(shellDb, input.nativeSessionId)
    const counts = shellDb
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
    shellDb.close()
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

  const mediaItems: Array<{ mimeType: string; inlineData: Buffer; uri: string }> = []
  if (verifiedMediaPayloads.length > 0) {
    const uploadedDir = ensureSafeDirectoryChain(canonicalRoot, [
      'brain',
      input.nativeSessionId,
      '.user_uploaded',
    ])
    for (const [idx, item] of verifiedMediaPayloads.entries()) {
      const fileName = `${idx}-${item.chunkImage.id}.${item.ext}`
      const targetMediaPath = join(uploadedDir, fileName)
      writeIdempotentPrivateFile(targetMediaPath, canonicalRoot, item.bytes, item.chunkImage.sha256)
      mediaItems.push({
        mimeType: item.chunkImage.mediaType,
        inlineData: item.bytes,
        uri: targetMediaPath,
      })
    }
    fsyncDirectoryBestEffort(uploadedDir)
  }

  const nonce = randomBytes(12).toString('hex')
  const stagingPath = join(conversationsDir, `${input.nativeSessionId}.db.staging-${nonce}`)
  const stagingFd = openSync(
    stagingPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  closeSync(stagingFd)

  try {
    const reopenShellDb = openReadOnlySqliteSnapshot(shellSnapshot, configuredRoot)
    const stagingDb = new Database(stagingPath, { fileMustExist: true })
    try {
      initializeStagingFromShell(stagingDb, reopenShellDb, shellSchema)

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
        media: mediaItems,
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
    } finally {
      stagingDb.close()
      reopenShellDb.close()
    }

    const syncFd = openSync(stagingPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      fsyncSync(syncFd)
    } finally {
      closeSync(syncFd)
    }

    assertSqliteIdentityUnchanged(shellSnapshot, configuredRoot)
    clearEmptyShellWalBeforePublish(candidateDbPath, canonicalRoot)
    renameSync(stagingPath, candidateDbPath)
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    removeStagingArtifactsBestEffort(stagingPath)
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
      } else if (wantUserIdentity && fieldNumber === 19 && byteLen > 0) {
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
                ...largeItemRanges.map((r) => decodeTextOrScopeItem(readSlice(r.offset, r.length))),
              ].join('')
              if (mergedItems.length > 0) {
                userIdentity = extractPactPromptIdentity(mergedItems)
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
  },
): DerivedAgyPrefix {
  if (!SAFE_ID_PATTERN.test(nativeTurnId)) {
    throw new Error('Invalid Antigravity nativeTurnId (execution_id).')
  }

  const schema = validateTrajectoryDatabase(db, sessionId)

  const execRows = db
    .prepare<[number], Record<string, unknown>>(
      'SELECT * FROM "executor_metadata" ORDER BY idx ASC LIMIT ?',
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

  const genRows = db
    .prepare<[number], Record<string, unknown>>(
      'SELECT * FROM "gen_metadata" ORDER BY idx ASC LIMIT ?',
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

  const stepPrefixStmt = db.prepare<[number], Record<string, unknown>>(
    'SELECT * FROM "steps" WHERE idx >= 0 AND idx <= ? ORDER BY idx ASC',
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
  const sourceDbPath = join(canonicalRoot, 'conversations', `${sourceSessionId}.db`)

  const snapshot = captureSqliteIdentity(sourceDbPath, canonicalRoot)
  const db = openReadOnlySqliteSnapshot(snapshot, configuredRoot)
  try {
    const derived = deriveVerifiedAgyPrefix(
      db,
      sourceSessionId,
      canonicalRoot,
      snapshot.canonicalDbPath,
      nativeTurnId,
      {
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertSqliteIdentityUnchanged(snapshot, configuredRoot)

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
      nativePath: snapshot.canonicalDbPath,
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
    db.close()
  }
}

export function inspectAgyFork(input: AgyForkInput): AgyForkOperationResult {
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

  const candidateDbPath = join(canonicalRoot, 'conversations', `${input.nativeSessionId}.db`)
  const checkSourceStillValid = (): void => {
    if (!input.source) return
    prepareAgyFork({
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      cwd: input.cwd,
      nativeSessionId: input.source.nativeSessionId,
      nativeTurnId: input.source.nativeTurnId,
      source: input.source,
    })
  }

  let candidateExists = true
  try {
    lstatSync(candidateDbPath, { bigint: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      candidateExists = false
    } else {
      throw error
    }
  }

  if (!candidateExists) {
    if (input.lastDispatchedPhase === 'fork' && input.source) {
      checkSourceStillValid()
      throw Object.assign(
        new Error(
          'The recorded Antigravity Fork candidate database is absent; the original source cut remains intact.',
        ),
        { code: 'native_file_fork_candidate_missing' },
      )
    }
    throw new Error('Antigravity Fork candidate database does not exist.')
  }

  const snapshot = captureSqliteIdentity(candidateDbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  if (witness.nativePath && snapshot.canonicalDbPath !== witness.nativePath) {
    throw new Error('The recorded Antigravity native Fork path changed.')
  }

  const db = openReadOnlySqliteSnapshot(snapshot, configuredRoot)
  let derived: DerivedAgyPrefix
  try {
    const counts = db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!
    if (counts.stepCount === 0 && counts.genCount === 0 && counts.execCount === 0) {
      validateTrajectoryDatabase(db, input.nativeSessionId)
      assertSqliteIdentityUnchanged(snapshot, configuredRoot)
      if (input.lastDispatchedPhase === 'fork' && input.source) {
        checkSourceStillValid()
        assertSqliteIdentityUnchanged(snapshot, configuredRoot)
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
      db,
      input.nativeSessionId,
      canonicalRoot,
      snapshot.canonicalDbPath,
      witness.sourceCutId,
      {
        requireNoPostCutRows: true,
        ...(inspectInputIds !== undefined ? { nativeInputIds: inspectInputIds } : {}),
      },
    )
    assertSqliteIdentityUnchanged(snapshot, configuredRoot)
  } finally {
    db.close()
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
      assertSqliteIdentityUnchanged(snapshot, configuredRoot)
      throw Object.assign(
        new Error(
          'Antigravity Fork candidate summary step_count is still zero; continue Fork to finalize publication.',
        ),
        { code: 'native_file_fork_candidate_missing' },
      )
    }
    throw new Error('Antigravity Fork candidate summary step_count is not synchronized.')
  }

  const physical = computePhysicalDbDigest(candidateDbPath, canonicalRoot, configuredRoot)
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
    nativePath: snapshot.canonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(derived.schema.trajectoryId, witness.sourceCutId, derived),
  }
}

export async function executeAgyFork(
  input: AgyForkInput,
  onBeforeAtomicPublish?: (candidate: AgyForkOperationResult) => Promise<void>,
): Promise<AgyForkOperationResult> {
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

  const sourceDbPath = join(conversationsDir, `${sourceSessionId}.db`)
  const candidateDbPath = join(conversationsDir, `${candidateSessionId}.db`)

  const sourceSnapshot = captureSqliteIdentity(sourceDbPath, canonicalRoot)
  const effectiveInputIds = input.nativeInputIds ?? input.source.nativeInputIds
  let derived: DerivedAgyPrefix
  const sourceDb = openReadOnlySqliteSnapshot(sourceSnapshot, configuredRoot)
  try {
    derived = deriveVerifiedAgyPrefix(
      sourceDb,
      sourceSessionId,
      canonicalRoot,
      sourceSnapshot.canonicalDbPath,
      input.source.nativeTurnId,
      {
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertSqliteIdentityUnchanged(sourceSnapshot, configuredRoot)
  } finally {
    sourceDb.close()
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

  const shellSnapshot = captureSqliteIdentity(candidateDbPath, canonicalRoot, AGY_MAX_HISTORY_BYTES)
  let shellSchema: ValidatedTrajectorySchema
  let candidateAlreadyPopulated = false
  const shellDb = openReadOnlySqliteSnapshot(shellSnapshot, configuredRoot)
  try {
    shellSchema = validateTrajectoryDatabase(shellDb, candidateSessionId)
    const counts = shellDb
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
        shellDb,
        candidateSessionId,
        canonicalRoot,
        shellSnapshot.canonicalDbPath,
        input.source.nativeCutId,
        {
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
    shellDb.close()
  }

  if (candidateAlreadyPopulated) {
    ensureSummaryStepCountCas(
      canonicalRoot,
      candidateSessionId,
      derived.cutStep + 1,
      derived.lastUserStepIdx,
      shellSchema.trajectoryId,
    )
    const physical = computePhysicalDbDigest(candidateDbPath, canonicalRoot, configuredRoot)
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
      nativePath: shellSnapshot.canonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: shellSchema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
    }
    if (onBeforeAtomicPublish) await onBeforeAtomicPublish(completedResult)
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

  const nonce = randomBytes(12).toString('hex')
  const stagingPath = join(conversationsDir, `${candidateSessionId}.db.staging-${nonce}`)
  const stagingFd = openSync(
    stagingPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  closeSync(stagingFd)

  try {
    const reopenShellDb = openReadOnlySqliteSnapshot(shellSnapshot, configuredRoot)
    const stagingDb = new Database(stagingPath, { fileMustExist: true })
    try {
      initializeStagingFromShell(stagingDb, reopenShellDb, shellSchema)

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
    } finally {
      stagingDb.close()
      reopenShellDb.close()
    }

    const syncFd = openSync(stagingPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      fsyncSync(syncFd)
    } finally {
      closeSync(syncFd)
    }

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
      nativePath: shellSnapshot.canonicalDbPath,
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

    // Verify staged candidate DB produces the exact frozen normalized prefixHash before publishing!
    const stagedReadOnlyDb = new Database(stagingPath, { readonly: true, fileMustExist: true })
    try {
      const stagedDerived = deriveVerifiedAgyPrefix(
        stagedReadOnlyDb,
        candidateSessionId,
        canonicalRoot,
        stagingPath,
        input.source.nativeCutId,
        {
          requireNoPostCutRows: true,
          ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        },
      )
      if (stagedDerived.prefixHash !== derived.prefixHash) {
        throw new Error(
          'Antigravity Fork staged candidate prefixHash disagrees with frozen source prefixHash.',
        )
      }
    } finally {
      stagedReadOnlyDb.close()
    }

    if (onBeforeAtomicPublish) {
      await onBeforeAtomicPublish(prePublishCandidate)
    }

    assertSqliteIdentityUnchanged(sourceSnapshot, configuredRoot)
    assertSqliteIdentityUnchanged(shellSnapshot, configuredRoot)
    clearEmptyShellWalBeforePublish(candidateDbPath, canonicalRoot)
    renameSync(stagingPath, candidateDbPath)
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    removeStagingArtifactsBestEffort(stagingPath)
  }

  ensureSummaryStepCountCas(
    canonicalRoot,
    candidateSessionId,
    derived.cutStep + 1,
    derived.lastUserStepIdx,
    shellSchema.trajectoryId,
  )

  const physical = computePhysicalDbDigest(candidateDbPath, canonicalRoot, configuredRoot)
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
    nativePath: shellSnapshot.canonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: shellSchema.trajectoryId,
    sourceTrajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
  }
}
