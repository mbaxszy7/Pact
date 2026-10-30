import { z } from 'zod'

export const NATIVE_FORK_RECORDS = 10_000
export const NATIVE_FORK_BYTES = 32 * 1024 * 1024
export const NATIVE_FORK_WITNESS_BYTES = 1024 * 1024
const nativeId = z.string().min(1).max(1024)
const hash = z.string().regex(/^[a-f\d]{64}$/u)

/** Private Utility/Adapter facts. Raw native transcripts never cross DesktopBridge. */
export const nativeForkBoundarySchema = z.strictObject({
  nativeSessionId: nativeId,
  nativeCutId: nativeId,
  nativeTurnId: nativeId,
  bindingGeneration: z.number().int().positive(),
  throughSequence: z.number().int().nonnegative(),
  deliveryCursor: z.number().int().nonnegative(),
  prefixHash: hash,
  prefixRecords: z.number().int().positive().max(NATIVE_FORK_RECORDS),
  prefixBytes: z.number().int().positive().max(NATIVE_FORK_BYTES),
})
export type AgentNativeForkBoundary = z.infer<typeof nativeForkBoundarySchema>

export const nativeForkWitnessSchema = z
  .strictObject({
    version: z.literal('pact-native-fork-v1'),
    sourceNativeSessionId: nativeId,
    nativeSessionId: nativeId,
    sourceCutId: nativeId,
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
export type AgentNativeForkWitness = z.infer<typeof nativeForkWitnessSchema>
