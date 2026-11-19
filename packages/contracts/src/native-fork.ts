import { z } from 'zod'

export const NATIVE_FORK_RECORDS = 10_000
export const NATIVE_FORK_BYTES = 32 * 1024 * 1024
export const NATIVE_FORK_WITNESS_BYTES = 1024 * 1024
const nativeId = z.string().min(1).max(1024)
const hash = z.string().regex(/^[a-f\d]{64}$/u)

export const agyNativeForkCutMetadataSchema = z.strictObject({
  version: z.literal('pact-agy-fork-cut-v1'),
  trajectoryId: nativeId,
  executionId: nativeId,
  cutStepIdx: z.number().int().nonnegative().max(NATIVE_FORK_RECORDS),
  genMetadataCount: z.number().int().nonnegative().max(NATIVE_FORK_RECORDS).optional(),
  executorMetadataCount: z.number().int().nonnegative().max(NATIVE_FORK_RECORDS).optional(),
  mediaCount: z.number().int().nonnegative().max(NATIVE_FORK_RECORDS).optional(),
})
export type AgyNativeForkCutMetadata = z.infer<typeof agyNativeForkCutMetadataSchema>

/** Private Utility/Adapter facts. Raw native transcripts never cross DesktopBridge. */
export const nativeForkBoundarySchema = z
  .strictObject({
    provider: z.enum(['claude', 'codex', 'agy']).optional(),
    nativeSessionId: nativeId,
    nativeCutId: nativeId,
    nativeTurnId: nativeId,
    nativeInputIds: z
      .array(nativeId)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, 'Native input IDs must be unique.')
      .optional(),
    agyCut: agyNativeForkCutMetadataSchema.optional(),
    bindingGeneration: z.number().int().positive(),
    throughSequence: z.number().int().nonnegative(),
    deliveryCursor: z.number().int().nonnegative(),
    prefixHash: hash,
    prefixRecords: z.number().int().positive().max(NATIVE_FORK_RECORDS),
    prefixBytes: z.number().int().positive().max(NATIVE_FORK_BYTES),
  })
  .refine(
    (value) => (value.provider === 'agy') === (value.agyCut !== undefined),
    'Antigravity fork boundaries require agyCut metadata and non-Antigravity boundaries forbid it.',
  )
export type AgentNativeForkBoundary = z.infer<typeof nativeForkBoundarySchema>

export const nativeForkWitnessSchema = z
  .strictObject({
    version: z.literal('pact-native-fork-v1'),
    provider: z.enum(['claude', 'codex', 'agy']).optional(),
    sourceNativeSessionId: nativeId,
    nativeSessionId: nativeId,
    sourceCutId: nativeId,
    sourceTrajectoryId: nativeId.optional(),
    candidateTrajectoryId: nativeId.optional(),
    cutStepIdx: z.number().int().nonnegative().max(NATIVE_FORK_RECORDS).optional(),
    agyCut: agyNativeForkCutMetadataSchema.optional(),
    sourcePrefixHash: hash,
    candidatePrefixHash: hash,
    candidatePrefixRecords: z.number().int().positive().max(NATIVE_FORK_RECORDS).optional(),
    nativeStorageRoot: z.string().min(1).max(4096).optional(),
    nativeProjectKey: z.string().min(1).max(256).optional(),
    nativeProjectDevice: z.string().min(1).max(64).optional(),
    nativeProjectInode: z.string().min(1).max(64).optional(),
    nativePath: z.string().min(1).max(4096).optional(),
    configurationGeneration: hash.optional(),
    idMap: z.array(z.tuple([nativeId, nativeId])).max(NATIVE_FORK_RECORDS),
    initializedAt: z.string().datetime().optional(),
    initializedPrefixHash: hash.optional(),
    initializedPrefixBytes: z.number().int().positive().max(NATIVE_FORK_BYTES).optional(),
    initializedPrefixRecords: z.number().int().positive().max(NATIVE_FORK_RECORDS).optional(),
    model: z.string().max(256).nullable(),
    effort: z.string().max(256).nullable(),
    permissionMode: z.enum(['native', 'ask', 'auto', 'full']),
  })
  .refine(
    (value) =>
      new Set(value.idMap.map(([id]) => id)).size === value.idMap.length &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= NATIVE_FORK_WITNESS_BYTES,
    'Native fork witness exceeds its unique-id or byte limit.',
  )
  .refine(
    (value) =>
      value.provider === 'agy'
        ? value.agyCut !== undefined &&
          value.sourceTrajectoryId !== undefined &&
          value.candidateTrajectoryId !== undefined &&
          value.cutStepIdx !== undefined &&
          value.cutStepIdx === value.agyCut.cutStepIdx
        : value.agyCut === undefined,
    'Antigravity fork witnesses require matching agyCut and trajectory metadata, while non-Antigravity witnesses forbid agyCut.',
  )
export type AgentNativeForkWitness = z.infer<typeof nativeForkWitnessSchema>
