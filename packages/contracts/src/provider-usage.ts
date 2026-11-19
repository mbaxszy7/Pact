import { z } from 'zod'

export const PROVIDER_USAGE_SNAPSHOT_BYTES = 8 * 1024
export const MAX_PROVIDER_USAGE_POOLS = 4

export const providerUsageProviderSchema = z.enum(['claude', 'codex', 'agy'])
export type ProviderUsageProvider = z.infer<typeof providerUsageProviderSchema>

export const providerUsageStatusSchema = z.enum([
  'idle',
  'loading',
  'ready',
  'partial',
  'stale',
  'unauthenticated',
  'not_applicable',
  'unsupported',
  'unavailable',
  'busy',
  'cancelling',
  'close_unconfirmed',
])
export type ProviderUsageStatus = z.infer<typeof providerUsageStatusSchema>

export const providerUsageWindowSchema = z.strictObject({
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.iso.datetime().nullable(),
})
export type ProviderUsageWindow = z.infer<typeof providerUsageWindowSchema>

export const providerUsagePoolSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  fiveHour: providerUsageWindowSchema.nullable(),
  sevenDay: providerUsageWindowSchema.nullable(),
})
export type ProviderUsagePool = z.infer<typeof providerUsagePoolSchema>

export const providerUsageSnapshotSchema = z
  .strictObject({
    provider: providerUsageProviderSchema,
    revision: z.number().int().nonnegative(),
    status: providerUsageStatusSchema,
    fiveHour: providerUsageWindowSchema.nullable(),
    sevenDay: providerUsageWindowSchema.nullable(),
    pools: z.array(providerUsagePoolSchema).min(1).max(MAX_PROVIDER_USAGE_POOLS).optional(),
    checkedAt: z.iso.datetime().nullable(),
    cooldownUntil: z.iso.datetime().nullable(),
    identityConfirmed: z.boolean(),
    message: z.string().min(1).max(240).optional(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= PROVIDER_USAGE_SNAPSHOT_BYTES,
    'Provider usage snapshot exceeds its byte limit.',
  )
export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>

export const providerUsageReadInputSchema = z.strictObject({
  provider: providerUsageProviderSchema,
})
export type ProviderUsageReadInput = z.infer<typeof providerUsageReadInputSchema>

export const providerUsageRefreshInputSchema = z.strictObject({
  provider: providerUsageProviderSchema,
  requestId: z.string().uuid(),
})
export type ProviderUsageRefreshInput = z.infer<typeof providerUsageRefreshInputSchema>

export const providerUsageCancelInputSchema = z.strictObject({
  provider: providerUsageProviderSchema,
  requestId: z.string().uuid(),
})
export type ProviderUsageCancelInput = z.infer<typeof providerUsageCancelInputSchema>

export const providerUsageCancelResultSchema = z.strictObject({
  cancelled: z.boolean(),
  settled: z.boolean(),
})
export type ProviderUsageCancelResult = z.infer<typeof providerUsageCancelResultSchema>

export const providerUsageUtilityRefreshInputSchema = z.strictObject({
  ownerId: z.string().uuid(),
  provider: providerUsageProviderSchema,
  requestId: z.string().uuid(),
})
export type ProviderUsageUtilityRefreshInput = z.infer<
  typeof providerUsageUtilityRefreshInputSchema
>

export const providerUsageUtilityCancelInputSchema = z.strictObject({
  ownerId: z.string().uuid(),
  provider: providerUsageProviderSchema,
  requestId: z.string().uuid(),
})
export type ProviderUsageUtilityCancelInput = z.infer<typeof providerUsageUtilityCancelInputSchema>

export const providerUsageReleaseOwnerInputSchema = z.strictObject({
  ownerId: z.string().uuid(),
})
export type ProviderUsageReleaseOwnerInput = z.infer<typeof providerUsageReleaseOwnerInputSchema>

export const providerUsageReadyResultSchema = z.strictObject({
  ready: z.literal(true),
})
export type ProviderUsageReadyResult = z.infer<typeof providerUsageReadyResultSchema>
