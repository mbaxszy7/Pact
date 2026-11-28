import type Database from 'better-sqlite3'

import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { AgentExecutionError } from '../agent-execution-error'
import {
  AGY_MAX_HISTORY_BYTES,
  AGY_TEXT_BUDGET_BYTES,
  type AgyIdentityRemap,
  type AgyMediaCopyPlan,
  collectAllowedAppDataRoots,
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  type DecodedAgyMedia,
  type DecodedAgyStep,
  type DecodedCortexStepMetadata,
  type DecodedCortexStepPlannerResponse,
  type DecodedCortexStepUserInput,
  type DecodedCortexToolCall,
  type DecodedExecutorMetadata,
  type DecodedGenMetadata,
  type DecodedProtobufTimestamp,
  type DecodedSourceTrajectoryStepInfo,
  type DecodedTrajectoryMetadata,
  isInsideDirectory,
  isPlainObject,
  MAX_PROTOBUF_FIELD_NUMBER,
  parseLocalFileUriOrPath,
  PROTOBUF_WIRE_BYTES,
  PROTOBUF_WIRE_FIXED32,
  PROTOBUF_WIRE_FIXED64,
  PROTOBUF_WIRE_VARINT,
  type ProtobufWireField,
  readExactBoundedBytesFromFd,
  SAFE_ID_PATTERN,
  SAFE_UPLOAD_NAME_PATTERN,
  statsMatch,
  UUID_PATTERN,
  verifySafeDirectoryChainIfPresent,
} from './constants-and-types'
import {
  decodeProtobufFields,
  decodeRepeatedUint32,
  decodeTimestamp,
  decodeUtf8Strict,
  encodeBytesField,
  encodeProtobufFields,
  encodeStringField,
  encodeTimestamp,
  encodeVarintField,
  readVarint,
  toSafeInt32,
  toSafeUint32,
} from './protobuf-wire'

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

export function readVerifiedUploadedMediaFile(
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

export function parseMediaUriToUploadedFile(
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

export function extractPactPromptIdentity(userText: string): ExtractedPactPromptIdentity {
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

export function assertCompatibleStepRowFormat(
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

export function extractEffectiveStepMetadata(
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
export function readBoundedStepMetadataAndUserIdentity(
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
