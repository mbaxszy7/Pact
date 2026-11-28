import { z } from 'zod'

import { anchoredCommentSummarySchema } from './anchored-comments.js'
import { sessionPermissionModeSchema } from './execution-settings.js'
import { conversationImageSchema } from './images.js'
import {
  agyNativeForkCutMetadataSchema,
  NATIVE_FORK_BYTES,
  NATIVE_FORK_RECORDS,
  NATIVE_FORK_WITNESS_BYTES,
  nativeForkBoundarySchema,
  nativeForkWitnessSchema,
} from './native-fork.js'

export const AGY_STORAGE_TEXT_BYTES = 8 * 1024 * 1024
export const AGY_STORAGE_HISTORY_BYTES = NATIVE_FORK_BYTES
export const AGY_STORAGE_MAX_RECORDS = NATIVE_FORK_RECORDS
export const AGY_STORAGE_WITNESS_BYTES = NATIVE_FORK_WITNESS_BYTES
export const AGY_STORAGE_MAX_PB_BYTES = 64 * 1024 * 1024
export const AGY_STORAGE_MAX_WORKING_BYTES = 128 * 1024 * 1024
export const AGY_STORAGE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const AGY_STORAGE_MAX_REBUILD_CHUNKS = 4_096
export const AGY_STORAGE_MAX_REASON_BYTES = 512
export const AGY_STORAGE_MAX_ERROR_BYTES = 2048

function utf8ByteLengthWithinLimit(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return false
  if (value.length * 3 <= maxBytes) return true
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          i += 1
        } else {
          bytes += 3
        }
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
    if (bytes > maxBytes) return false
  }
  return true
}

function addJsonStringBytes(value: string, used: number, maxBytes: number): number {
  let total = used + 2 // opening and closing quotes
  if (total > maxBytes) return total
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) {
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        total += 2
      } else if (code < 0x20) {
        total += 6
      } else {
        total += 1
      }
    } else if (code < 0x800) {
      total += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          total += 4
          i += 1
        } else {
          total += 6
        }
      } else {
        total += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      total += 6
    } else {
      total += 3
    }
    if (total > maxBytes) return total
  }
  return total
}

function addJsonValueBytes(value: unknown, used: number, maxBytes: number, depth: number): number {
  if (used > maxBytes || depth > 128) return maxBytes + 1
  if (value === null) return used + 4
  if (typeof value === 'string') return addJsonStringBytes(value, used, maxBytes)
  if (typeof value === 'number') {
    return used + (Number.isFinite(value) ? String(value).length : 4)
  }
  if (typeof value === 'boolean') return used + (value ? 4 : 5)
  if (typeof value === 'object') {
    const toJson: unknown = Reflect.get(value, 'toJSON')
    if (typeof toJson === 'function') {
      const normalized: unknown = Reflect.apply(toJson, value, [])
      if (
        normalized === undefined ||
        typeof normalized === 'function' ||
        typeof normalized === 'symbol'
      ) {
        return used + 4
      }
      return addJsonValueBytes(normalized, used, maxBytes, depth + 1)
    }
    if (Array.isArray(value)) {
      let total = used + 2 // []
      if (total > maxBytes) return total
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) total += 1 // ,
        const item: unknown = value[i]
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          total += 4
        } else {
          total = addJsonValueBytes(item, total, maxBytes, depth + 1)
        }
        if (total > maxBytes) return total
      }
      return total
    }
    let total = used + 2 // {}
    if (total > maxBytes) return total
    let first = true
    for (const [key, rawPropVal] of Object.entries(value)) {
      let propVal: unknown = rawPropVal
      if (propVal !== null && typeof propVal === 'object') {
        const propToJson: unknown = Reflect.get(propVal, 'toJSON')
        if (typeof propToJson === 'function') {
          propVal = Reflect.apply(propToJson, propVal, [])
        }
      }
      if (propVal === undefined || typeof propVal === 'function' || typeof propVal === 'symbol') {
        continue
      }
      if (!first) total += 1 // ,
      first = false
      total = addJsonStringBytes(key, total, maxBytes)
      if (total > maxBytes) return total
      total += 1 // :
      total = addJsonValueBytes(propVal, total, maxBytes, depth + 1)
      if (total > maxBytes) return total
    }
    return total
  }
  return used + 4
}

export function serializedByteLengthWithinLimit(value: unknown, maxBytes: number): boolean {
  return addJsonValueBytes(value, 0, maxBytes, 0) <= maxBytes
}

const sha256Hex = z.string().regex(/^[a-f\d]{64}$/u)
const nativeId = z.string().min(1).max(1024)
const pathString = z.string().min(1).max(4096)
const stagingLeafNameSchema = z.string().regex(/^\.pact-stage-[a-zA-Z0-9._-]{1,96}\.db$/u)
const trajectoryIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/u)
const nativeInputIdsSchema = z
  .array(nativeId)
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length, 'Native input IDs must be unique.')

const boundedText = (maxBytes: number, label: string) =>
  z
    .string()
    .refine((value) => utf8ByteLengthWithinLimit(value, maxBytes), `${label} exceeds byte limit.`)

export const AGY_STORAGE_ACTIONS = [
  'read-agy-trajectory-identity',
  'inspect-agy-run',
  'exists',
  'prepare',
  'read',
  'inspect',
  'fork',
  'rebuild_seed',
  'verify-agy-seed',
  'confirm-agy-rebuild-cold-load',
] as const

export const agyStorageActionSchema = z.enum(AGY_STORAGE_ACTIONS)
export type AgyStorageAction = z.infer<typeof agyStorageActionSchema>

export const agyStorageJobKeySchema = z.strictObject({
  version: z.literal(1),
  generation: z.uuid(),
  requestId: z.uuid(),
})
export type AgyStorageJobKey = z.infer<typeof agyStorageJobKeySchema>

export const agyRebuildInitializationWitnessSchema = z.strictObject({
  kind: z.literal('agy_rebuild_v1'),
  nativeSessionId: nativeId,
  pbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pbBytes: z.number().int().positive().max(AGY_STORAGE_MAX_PB_BYTES),
  stepCount: z.literal(2),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  coldLoadVerifiedAt: z.string().datetime(),
})
export type AgyRebuildInitializationWitness = z.infer<typeof agyRebuildInitializationWitnessSchema>

export const agyStorageOpenErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'CAPACITY_EXCEEDED',
  'SPAWN_FAILED',
  'GENERATION_MISMATCH',
  'DISPOSED',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL',
])
export type AgyStorageOpenErrorCode = z.infer<typeof agyStorageOpenErrorCodeSchema>

export const agyStorageCancelReasonSchema = z.enum([
  'aborted',
  'timeout',
  'disposed',
  'protocol_error',
  'generation_changed',
  'candidate_commit_failed',
])
export type AgyStorageCancelReason = z.infer<typeof agyStorageCancelReasonSchema>

export const agyStorageOpenRequestSchema = z.strictObject({
  type: z.literal('agy-storage.open.request'),
  jobKey: agyStorageJobKeySchema,
  action: agyStorageActionSchema,
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workingBytes: z.number().int().positive().max(AGY_STORAGE_MAX_WORKING_BYTES),
})
export type AgyStorageOpenRequest = z.infer<typeof agyStorageOpenRequestSchema>

export const agyStorageOpenOkResponseSchema = z.strictObject({
  type: z.literal('agy-storage.open.response'),
  ok: z.literal(true),
  jobKey: agyStorageJobKeySchema,
})

export const agyStorageOpenErrorResponseSchema = z.strictObject({
  type: z.literal('agy-storage.open.response'),
  ok: z.literal(false),
  jobKey: agyStorageJobKeySchema,
  code: agyStorageOpenErrorCodeSchema,
  message: z.string().min(1).max(1024),
})

export const agyStorageOpenResponseSchema = z.discriminatedUnion('ok', [
  agyStorageOpenOkResponseSchema,
  agyStorageOpenErrorResponseSchema,
])
export type AgyStorageOpenResponse = z.infer<typeof agyStorageOpenResponseSchema>

export const agyStorageCancelRequestSchema = z.strictObject({
  type: z.literal('agy-storage.cancel.request'),
  jobKey: agyStorageJobKeySchema,
  reason: agyStorageCancelReasonSchema,
})
export type AgyStorageCancelRequest = z.infer<typeof agyStorageCancelRequestSchema>

export const agyStorageClosedEventSchema = z.strictObject({
  type: z.literal('agy-storage.closed.event'),
  jobKey: agyStorageJobKeySchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(64).nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
})
export type AgyStorageClosedEvent = z.infer<typeof agyStorageClosedEventSchema>

export const agyStorageInitMessageSchema = z.strictObject({
  type: z.literal('init'),
  jobKey: agyStorageJobKeySchema,
  action: agyStorageActionSchema,
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export type AgyStorageInitMessage = z.infer<typeof agyStorageInitMessageSchema>

export const agyStorageControlMessageSchema = z.union([
  agyStorageOpenRequestSchema,
  agyStorageOpenOkResponseSchema,
  agyStorageOpenErrorResponseSchema,
  agyStorageCancelRequestSchema,
  agyStorageClosedEventSchema,
])
export type AgyStorageControlMessage = z.infer<typeof agyStorageControlMessageSchema>

export const agyStorageRebuildChunkSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    messageId: z.uuid(),
    sequence: z.number().int().nonnegative(),
    image: conversationImageSchema,
  }),
  z.strictObject({
    kind: z.literal('message'),
    messageId: z.uuid(),
    sequence: z.number().int().nonnegative(),
    speaker: z.enum(['user', 'claude', 'codex', 'agy']),
    state: z.enum(['complete', 'incomplete']),
    part: z.number().int().nonnegative(),
    final: z.boolean(),
    content: z.string().max(64 * 1024),
  }),
  z.strictObject({
    kind: z.literal('comment'),
    messageId: z.uuid(),
    sequence: z.number().int().nonnegative(),
    comment: anchoredCommentSummarySchema,
  }),
])
export type AgyStorageRebuildChunk = z.infer<typeof agyStorageRebuildChunkSchema>

export const agyStoragePromptImageSchema = conversationImageSchema.extend({
  path: pathString,
})
export type AgyStoragePromptImage = z.infer<typeof agyStoragePromptImageSchema>

const agyStorageReadIdentityRequestSchema = z.strictObject({
  action: z.literal('read-agy-trajectory-identity'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  tempStagingDir: pathString.optional(),
})

const agyStorageExistsRequestSchema = z.strictObject({
  action: z.literal('exists'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  tempStagingDir: pathString.optional(),
})

const agyStorageInspectRunRequestSchema = z.strictObject({
  action: z.literal('inspect-agy-run'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  nativeTurnId: nativeId.optional(),
  nativeInputIds: nativeInputIdsSchema.optional(),
  includePlan: z.boolean().optional(),
  tempStagingDir: pathString.optional(),
})

const agyStoragePrepareRequestSchema = z.strictObject({
  action: z.literal('prepare'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  nativeTurnId: nativeId.optional(),
  nativeInputIds: nativeInputIdsSchema.optional(),
  responseHash: sha256Hex.optional(),
  lastDispatchedPhase: z.enum(['fork', 'initialize']).optional(),
  source: nativeForkBoundarySchema.optional(),
  tempStagingDir: pathString.optional(),
})

const agyStorageReadRequestSchema = z.strictObject({
  action: z.literal('read'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  nativeTurnId: nativeId.optional(),
  nativeInputIds: nativeInputIdsSchema.optional(),
  responseHash: sha256Hex.optional(),
  lastDispatchedPhase: z.enum(['fork', 'initialize']).optional(),
  source: nativeForkBoundarySchema.optional(),
  witness: nativeForkWitnessSchema.optional(),
  tempStagingDir: pathString.optional(),
})

const agyStorageInspectRequestSchema = z.strictObject({
  action: z.literal('inspect'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  nativeTurnId: nativeId.optional(),
  nativeInputIds: nativeInputIdsSchema.optional(),
  responseHash: sha256Hex.optional(),
  lastDispatchedPhase: z.enum(['fork', 'initialize']).optional(),
  source: nativeForkBoundarySchema.optional(),
  witness: nativeForkWitnessSchema.optional(),
  tempStagingDir: pathString.optional(),
})

const agyStorageForkRequestSchema = z.strictObject({
  action: z.literal('fork'),
  cwd: pathString,
  nativeSessionId: nativeId,
  candidateNativeSessionId: z.uuid(),
  storageRoot: pathString.optional(),
  nativeTurnId: nativeId.optional(),
  nativeInputIds: nativeInputIdsSchema.optional(),
  responseHash: sha256Hex.optional(),
  lastDispatchedPhase: z.enum(['fork', 'initialize']).optional(),
  source: nativeForkBoundarySchema,
  awaitCandidateCommit: z.boolean().optional(),
  model: z.string().max(256).nullable().optional(),
  effort: z.string().max(256).nullable().optional(),
  permissionMode: sessionPermissionModeSchema.optional(),
  tempStagingDir: pathString.optional(),
  stagingLeafName: stagingLeafNameSchema.optional(),
})

const agyStorageRebuildSeedRequestSchema = z
  .strictObject({
    action: z.literal('rebuild_seed'),
    cwd: pathString,
    nativeSessionId: z.uuid(),
    storageRoot: pathString.optional(),
    rebuildId: z.uuid(),
    sourceHash: sha256Hex.optional(),
    rebuildChunks: z.array(agyStorageRebuildChunkSchema).max(AGY_STORAGE_MAX_REBUILD_CHUNKS),
    rebuildImages: z
      .array(agyStoragePromptImageSchema)
      .max(AGY_STORAGE_MAX_REBUILD_CHUNKS)
      .optional(),
    tempStagingDir: pathString.optional(),
    stagingLeafName: stagingLeafNameSchema.optional(),
  })
  .refine(
    (value) => serializedByteLengthWithinLimit(value.rebuildChunks, AGY_STORAGE_TEXT_BYTES),
    'Antigravity rebuild chunks exceed 8 MiB.',
  )

const agyStorageVerifySeedRequestSchema = z
  .strictObject({
    action: z.literal('verify-agy-seed'),
    cwd: pathString,
    nativeSessionId: nativeId,
    storageRoot: pathString.optional(),
    rebuildId: z.uuid(),
    sourceHash: sha256Hex.optional(),
    rebuildChunks: z.array(agyStorageRebuildChunkSchema).max(AGY_STORAGE_MAX_REBUILD_CHUNKS),
    rebuildImages: z
      .array(agyStoragePromptImageSchema)
      .max(AGY_STORAGE_MAX_REBUILD_CHUNKS)
      .optional(),
    expectedSeedHash: sha256Hex.optional(),
    expectedTrajectoryId: trajectoryIdSchema.optional(),
    expectedPbSha256: sha256Hex.optional(),
    expectedPbBytes: z.number().int().positive().max(AGY_STORAGE_MAX_PB_BYTES).optional(),
    expectedVerifiedPrefixSha256: sha256Hex.optional(),
    expectedVerifiedPrefixBytes: z
      .number()
      .int()
      .positive()
      .max(AGY_STORAGE_HISTORY_BYTES)
      .optional(),
    expectedRecordCount: z.number().int().positive().max(AGY_STORAGE_MAX_RECORDS).optional(),
    rejectAdditionalWork: z.boolean().optional(),
    tempStagingDir: pathString.optional(),
  })
  .refine(
    (value) => serializedByteLengthWithinLimit(value.rebuildChunks, AGY_STORAGE_TEXT_BYTES),
    'Antigravity rebuild chunks exceed 8 MiB.',
  )

const agyStorageConfirmColdLoadRequestSchema = z.strictObject({
  action: z.literal('confirm-agy-rebuild-cold-load'),
  cwd: pathString,
  nativeSessionId: nativeId,
  storageRoot: pathString.optional(),
  appDataDir: pathString.optional(),
  sourceHash: sha256Hex,
  pbSha256: sha256Hex,
  pbBytes: z.number().int().positive().max(AGY_STORAGE_MAX_PB_BYTES),
  stepCount: z.literal(2),
  tempStagingDir: pathString.optional(),
})

export const agyStorageRequestPayloadSchema = z.discriminatedUnion('action', [
  agyStorageReadIdentityRequestSchema,
  agyStorageInspectRunRequestSchema,
  agyStorageExistsRequestSchema,
  agyStoragePrepareRequestSchema,
  agyStorageReadRequestSchema,
  agyStorageInspectRequestSchema,
  agyStorageForkRequestSchema,
  agyStorageRebuildSeedRequestSchema,
  agyStorageVerifySeedRequestSchema,
  agyStorageConfirmColdLoadRequestSchema,
])
export type AgyStorageRequestPayload = z.infer<typeof agyStorageRequestPayloadSchema>

export const agyTrajectoryIdentityResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    nativeSessionId: nativeId,
    status: z.literal('ok'),
    trajectoryId: trajectoryIdSchema,
    stepCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    nativeSessionId: nativeId,
    status: z.enum(['no_storage_root', 'missing', 'transient_churn', 'invalid', 'budget_exceeded']),
    reason: z
      .string()
      .min(1)
      .refine(
        (value) => utf8ByteLengthWithinLimit(value, AGY_STORAGE_MAX_REASON_BYTES),
        'Reason exceeds 512 bytes.',
      )
      .optional(),
  }),
])
export type AgyTrajectoryIdentityResultPayload = z.infer<typeof agyTrajectoryIdentityResultSchema>

export const agySessionExistsResultSchema = z.strictObject({
  nativeSessionId: nativeId,
  exists: z.boolean(),
})
export type AgySessionExistsResultPayload = z.infer<typeof agySessionExistsResultSchema>

export const agyConsumedInputReceiptSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative().max(AGY_STORAGE_MAX_RECORDS),
  stepId: nativeId.optional(),
  clientMessageId: nativeId.optional(),
  pactMessageId: nativeId.optional(),
  pactRunId: nativeId.optional(),
  textSha256: sha256Hex,
})
export type AgyConsumedInputReceiptPayload = z.infer<typeof agyConsumedInputReceiptSchema>

export const agyColdInspectionResultSchema = z
  .strictObject({
    exists: z.boolean(),
    nativeSessionId: nativeId,
    trajectoryId: trajectoryIdSchema.optional(),
    nativeStorageRoot: pathString,
    nativePath: pathString,
    stepCount: z.number().int().nonnegative().max(AGY_STORAGE_MAX_RECORDS),
    terminalState: z
      .strictObject({
        executionId: z.string().min(1).max(256),
        status: z.enum(['completed', 'failed', 'canceled', 'running']),
        terminationReason: z.number().int().optional(),
        lastStepIdx: z.number().int().nonnegative().max(AGY_STORAGE_MAX_RECORDS).optional(),
        consumedInputStepIds: z.array(nativeId).max(AGY_STORAGE_MAX_RECORDS),
        consumedInputs: z.array(agyConsumedInputReceiptSchema).max(AGY_STORAGE_MAX_RECORDS),
        answer: boundedText(AGY_STORAGE_TEXT_BYTES, 'Antigravity answer'),
        responseHash: sha256Hex,
        plan: z
          .strictObject({
            nativeId,
            text: boundedText(AGY_STORAGE_TEXT_BYTES, 'Antigravity plan'),
          })
          .optional(),
        planUnavailable: z.literal(true).optional(),
        hasCompletedPactPublishPlan: z.boolean().optional(),
        completedPactPublishPlanTokens: z.array(nativeId).max(256).optional(),
        completedPactPublishPlanCalls: z
          .array(
            z.strictObject({
              serverName: z.string().min(1).max(128),
              callId: z.string().min(1).max(256).optional(),
              progressToken: z.string().min(1).max(256).optional(),
              stepId: z.string().min(1).max(256).optional(),
            }),
          )
          .max(256)
          .optional(),
      })
      .refine(
        (state) => !(state.plan !== undefined && state.planUnavailable === true),
        'Antigravity cold inspection cannot report both a plan and planUnavailable.',
      )
      .optional(),
  })
  .refine(
    (value) => serializedByteLengthWithinLimit(value, AGY_STORAGE_MAX_MESSAGE_BYTES),
    'Antigravity cold inspection result exceeds 16 MiB message cap.',
  )
export type AgyColdInspectionResultPayload = z.infer<typeof agyColdInspectionResultSchema>

export const agyForkFileResultSchema = z
  .strictObject({
    nativeSessionId: nativeId,
    nativeCutId: nativeId,
    prefixHash: sha256Hex,
    prefixBytes: z.number().int().positive().max(AGY_STORAGE_HISTORY_BYTES),
    prefixRecords: z.number().int().positive().max(AGY_STORAGE_MAX_RECORDS),
    idMap: z.array(z.tuple([nativeId, nativeId])).max(AGY_STORAGE_MAX_RECORDS),
    rawHash: z.union([z.literal(''), sha256Hex]),
    rawBytes: z.number().int().nonnegative().max(AGY_STORAGE_HISTORY_BYTES),
    rawRecords: z.number().int().nonnegative().max(AGY_STORAGE_MAX_RECORDS),
    nativeStorageRoot: pathString.optional(),
    nativePath: pathString.optional(),
    initializedVerified: z.boolean().optional(),
    nativeProjectKey: z.string().min(1).max(256).optional(),
    nativeProjectDevice: z.string().min(1).max(64).optional(),
    nativeProjectInode: z.string().min(1).max(64).optional(),
    cutStep: z.number().int().nonnegative().max(AGY_STORAGE_MAX_RECORDS).optional(),
    trajectoryId: trajectoryIdSchema.optional(),
    sourceTrajectoryId: trajectoryIdSchema.optional(),
    agyCut: agyNativeForkCutMetadataSchema.optional(),
  })
  .refine(
    (value) =>
      new Set(value.idMap.map(([left]) => left)).size === value.idMap.length &&
      new Set(value.idMap.map(([, right]) => right)).size === value.idMap.length &&
      serializedByteLengthWithinLimit(value, AGY_STORAGE_WITNESS_BYTES),
    'Antigravity fork result exceeds unique-id or 1 MiB witness limit.',
  )
export type AgyForkFileResultPayload = z.infer<typeof agyForkFileResultSchema>

export const agyRebuildSeedResultSchema = z
  .strictObject({
    nativeSessionId: nativeId,
    trajectoryId: trajectoryIdSchema,
    seedHash: sha256Hex,
    chunkCount: z.number().int().nonnegative().max(AGY_STORAGE_MAX_REBUILD_CHUNKS),
    stepCount: z.literal(2),
    pbSha256: sha256Hex,
    pbBytes: z.number().int().positive().max(AGY_STORAGE_MAX_PB_BYTES),
    verifiedPrefixBytes: z.number().int().positive().max(AGY_STORAGE_HISTORY_BYTES),
    verifiedPrefixSha256: sha256Hex,
    recordCount: z.number().int().positive().max(AGY_STORAGE_MAX_RECORDS),
    nativeStorageRoot: pathString,
    nativePath: pathString,
    initializationWitness: agyRebuildInitializationWitnessSchema.optional(),
  })
  .refine(
    (value) => serializedByteLengthWithinLimit(value, AGY_STORAGE_WITNESS_BYTES),
    'Antigravity rebuild seed result exceeds 1 MiB witness limit.',
  )
export type AgyRebuildSeedResultPayload = z.infer<typeof agyRebuildSeedResultSchema>

export const agyStorageResultSchemaByAction = {
  'read-agy-trajectory-identity': agyTrajectoryIdentityResultSchema,
  'inspect-agy-run': agyColdInspectionResultSchema,
  exists: agySessionExistsResultSchema,
  prepare: agyForkFileResultSchema,
  read: agyForkFileResultSchema,
  inspect: agyForkFileResultSchema,
  fork: agyForkFileResultSchema,
  rebuild_seed: agyRebuildSeedResultSchema,
  'verify-agy-seed': agyRebuildSeedResultSchema,
  'confirm-agy-rebuild-cold-load': agyRebuildInitializationWitnessSchema,
} as const satisfies Record<AgyStorageAction, z.ZodType>

export type AgyStorageRequestByAction = {
  [Action in AgyStorageAction]: Extract<AgyStorageRequestPayload, { action: Action }>
}

export type AgyStorageResultByAction = {
  [Action in AgyStorageAction]: z.infer<(typeof agyStorageResultSchemaByAction)[Action]>
}

export const agyStoragePortRequestMessageSchema = z
  .strictObject({
    type: z.literal('request'),
    jobKey: agyStorageJobKeySchema,
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    input: agyStorageRequestPayloadSchema,
    measure: z.boolean().optional(),
  })
  .refine(
    (value) => serializedByteLengthWithinLimit(value, AGY_STORAGE_MAX_MESSAGE_BYTES),
    'Antigravity storage port request exceeds 16 MiB message cap.',
  )
export type AgyStoragePortRequestMessage = z.infer<typeof agyStoragePortRequestMessageSchema>

export const agyStoragePortResultMessageSchema = z
  .discriminatedUnion('action', [
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('read-agy-trajectory-identity'),
      result: agyTrajectoryIdentityResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('inspect-agy-run'),
      result: agyColdInspectionResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('exists'),
      result: agySessionExistsResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('prepare'),
      result: agyForkFileResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('read'),
      result: agyForkFileResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('inspect'),
      result: agyForkFileResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('fork'),
      result: agyForkFileResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('rebuild_seed'),
      result: agyRebuildSeedResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('verify-agy-seed'),
      result: agyRebuildSeedResultSchema,
    }),
    z.strictObject({
      type: z.literal('result'),
      jobKey: agyStorageJobKeySchema,
      action: z.literal('confirm-agy-rebuild-cold-load'),
      result: agyRebuildInitializationWitnessSchema,
    }),
  ])
  .refine(
    (value) => serializedByteLengthWithinLimit(value, AGY_STORAGE_MAX_MESSAGE_BYTES),
    'Antigravity storage port result exceeds 16 MiB message cap.',
  )
export type AgyStoragePortResultMessage = z.infer<typeof agyStoragePortResultMessageSchema>

export const agyStoragePortErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  jobKey: agyStorageJobKeySchema,
  message: z
    .string()
    .min(1)
    .refine(
      (value) => utf8ByteLengthWithinLimit(value, AGY_STORAGE_MAX_ERROR_BYTES),
      'Error message exceeds 2048 bytes.',
    ),
  code: z.string().min(1).max(128).optional(),
  errorKind: z.string().min(1).max(128).optional(),
})
export type AgyStoragePortErrorMessage = z.infer<typeof agyStoragePortErrorMessageSchema>

export const agyStoragePortCandidateMessageSchema = z
  .strictObject({
    type: z.literal('candidate'),
    jobKey: agyStorageJobKeySchema,
    candidateNativeSessionId: z.uuid(),
    witnessDigest: sha256Hex,
    witness: nativeForkWitnessSchema,
    candidate: agyForkFileResultSchema.optional(),
  })
  .refine(
    (value) =>
      value.witness.provider === 'agy' &&
      value.witness.nativeSessionId === value.candidateNativeSessionId &&
      (value.candidate === undefined ||
        value.candidate.nativeSessionId === value.candidateNativeSessionId) &&
      serializedByteLengthWithinLimit(value, AGY_STORAGE_MAX_MESSAGE_BYTES),
    'Fork candidate witness must match candidateNativeSessionId for provider agy within budget.',
  )
export type AgyStoragePortCandidateMessage = z.infer<typeof agyStoragePortCandidateMessageSchema>

export const agyStoragePortCandidateCommittedMessageSchema = z.strictObject({
  type: z.literal('candidate_committed'),
  jobKey: agyStorageJobKeySchema,
  candidateNativeSessionId: z.uuid(),
  witnessDigest: sha256Hex,
  committed: z.boolean(),
})
export type AgyStoragePortCandidateCommittedMessage = z.infer<
  typeof agyStoragePortCandidateCommittedMessageSchema
>

export const agyStoragePortResultAckMessageSchema = z.strictObject({
  type: z.literal('result_ack'),
  jobKey: agyStorageJobKeySchema,
})
export type AgyStoragePortResultAckMessage = z.infer<typeof agyStoragePortResultAckMessageSchema>

export const agyStorageUtilityToChildMessageSchema = z.union([
  agyStoragePortRequestMessageSchema,
  agyStoragePortCandidateCommittedMessageSchema,
  agyStoragePortResultAckMessageSchema,
])
export type AgyStorageUtilityToChildMessage = z.infer<typeof agyStorageUtilityToChildMessageSchema>

export const agyStorageChildToUtilityMessageSchema = z.union([
  agyStoragePortResultMessageSchema,
  agyStoragePortErrorMessageSchema,
  agyStoragePortCandidateMessageSchema,
])
export type AgyStorageChildToUtilityMessage = z.infer<typeof agyStorageChildToUtilityMessageSchema>

export const agyStoragePortMessageSchema = z.union([
  agyStoragePortRequestMessageSchema,
  agyStoragePortResultMessageSchema,
  agyStoragePortErrorMessageSchema,
  agyStoragePortCandidateMessageSchema,
  agyStoragePortCandidateCommittedMessageSchema,
  agyStoragePortResultAckMessageSchema,
])
export type AgyStoragePortMessage = z.infer<typeof agyStoragePortMessageSchema>
