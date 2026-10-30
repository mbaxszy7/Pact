import { z } from 'zod'

import { decisionCapabilitySchema } from './decision-runtime.js'

export const SCHEDULING_ACTIVITY_PAGE_ITEMS = 25
export const SCHEDULING_ACTIVITY_PAGE_BYTES = 128 * 1024
export const SCHEDULING_ACTIVITY_RESIDENT_ITEMS = 100
export const SCHEDULING_ACTIVITY_RESIDENT_BYTES = 400 * 1024
export const SCHEDULING_ACTIVITY_TIMEOUT_MS = 5_000
export const SCHEDULING_CAPABILITY_TTL_MS = 60_000
export const SCHEDULING_CAPABILITY_RESIDENT_BYTES = 8 * 1024
export const SCHEDULING_STATE_REFRESH_TIMEOUT_MS = 20_000
export const SCHEDULING_USAGE_NOTICE =
  "Decision requests send necessary task context through your selected Codex or Claude Code runtime and consume your account's usage allowance or incur charges under its billing terms."
export const schedulingChangedSchema = z.strictObject({ changed: z.literal(true) })

export const schedulingModelSelectionSchema = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('codex_luna'),
    provider: z.literal('codex'),
    modelId: z.literal('gpt-6-luna'),
  }),
  z.strictObject({
    target: z.literal('claude_haiku_5_5'),
    provider: z.literal('claude'),
    modelId: z.string().regex(/^claude-haiku-5-5(?:-\d{8})?$/u),
  }),
])
export type SchedulingModelSelection = z.infer<typeof schedulingModelSelectionSchema>
export const schedulingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  selection: schedulingModelSelectionSchema.nullable(),
  showIndicator: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
})
export type SchedulingSettings = z.infer<typeof schedulingSettingsSchema>

export const schedulingStateInputSchema = z.strictObject({
  sessionId: z.string().uuid().optional(),
})
export type SchedulingStateInput = z.infer<typeof schedulingStateInputSchema>

const capabilityObservationSchema = z
  .strictObject({
    status: z.enum(['unconfirmed', 'supported', 'unavailable', 'stale']),
    capability: decisionCapabilitySchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
  })
  .refine((value) =>
    value.status === 'unconfirmed'
      ? value.capability === null && value.expiresAt === null
      : value.capability !== null &&
        value.expiresAt !== null &&
        (value.status === 'stale' || value.status === value.capability.status),
  )
export const schedulingEligibilitySchema = z.enum([
  'available',
  'disabled',
  'model_required',
  'unconfirmed',
  'unavailable',
  'busy',
  'archived',
  'paused',
  'input_pending',
  'native_interaction',
  'recovery_required',
])
export type SchedulingEligibility = z.infer<typeof schedulingEligibilitySchema>

const decisionActivitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({
    status: z.enum(['inspecting', 'evaluating', 'cleanup_unconfirmed']),
    operationId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
  }),
])
const checkActivitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({
    status: z.enum(['checking', 'cleanup_unconfirmed']),
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
])

/** Disposable host observations. Neither preferences nor cached compatibility authorize a Run. */
export const schedulingStateSchema = z.strictObject({
  settings: schedulingSettingsSchema,
  configurationGeneration: z.number().int().nonnegative(),
  host: capabilityObservationSchema,
  context: z
    .strictObject({
      sessionId: z.string().uuid(),
      observation: capabilityObservationSchema,
      eligibility: schedulingEligibilitySchema,
    })
    .nullable(),
  activity: z.strictObject({ decision: decisionActivitySchema, check: checkActivitySchema }),
})
export type SchedulingState = z.infer<typeof schedulingStateSchema>
export const schedulingSettingsSaveSchema = z.strictObject({
  catalogIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  selection: schedulingModelSelectionSchema.nullable().optional(),
  showIndicator: z.boolean().optional(),
})
export type SchedulingSettingsSave = z.infer<typeof schedulingSettingsSaveSchema>
export const schedulingModelAvailabilitySchema = z.strictObject({
  target: z.enum(['codex_luna', 'claude_haiku_5_5']),
  status: z.enum(['found', 'not_found', 'unconfirmed']),
  selection: schedulingModelSelectionSchema.nullable(),
  checkedAt: z.string().datetime(),
})
export const schedulingModelsSchema = z.strictObject({
  catalogIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
  models: z.array(schedulingModelAvailabilitySchema).length(2),
})
export type SchedulingModels = z.infer<typeof schedulingModelsSchema>
export const schedulingActivityCursorSchema = z.strictObject({
  asOf: z.string().datetime(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
})
export const schedulingActivityReadSchema = z.strictObject({
  direction: z.enum(['older', 'newer']).optional(),
  cursor: schedulingActivityCursorSchema.optional(),
})
export type SchedulingActivityRead = z.infer<typeof schedulingActivityReadSchema>
export const schedulingActivitySuggestionStateSchema = z.enum([
  'none',
  'suggested',
  'awaiting_user',
  'adopted',
  'discarded',
  'fallback',
])
export type SchedulingActivitySuggestionState = z.infer<
  typeof schedulingActivitySuggestionStateSchema
>
export const schedulingActivityActionSchema = z.enum([
  'plan_review',
  'plan_revision',
  'implementation',
  'code_review',
  'respond',
  'repair',
  'reply',
  'route_codex',
  'route_claude',
  'clarify_prepared_input',
  'supplement_plan',
  'supplement_code_response',
  'native_check',
  'queue_check',
  'rebuild_check',
  'confirmed_resend',
  'rebuild_native_context',
])
export type SchedulingActivityAction = z.infer<typeof schedulingActivityActionSchema>
export const schedulingActivityActionResultSchema = z.enum([
  'reserved',
  'dispatched',
  'completed',
  'failed',
  'not_sent',
  'unconfirmed',
  'cancelled',
  'superseded',
])
export type SchedulingActivityActionResult = z.infer<typeof schedulingActivityActionResultSchema>
export const schedulingActivityRowSchema = z.strictObject({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  project: z.string().max(512),
  session: z.string().max(512),
  provider: z.enum(['codex', 'claude']).nullable(),
  model: z.string().max(256).nullable(),
  reason: z.enum([
    'workflow',
    'input',
    'native_check',
    'queue_check',
    'rebuild_check',
    'native_rebuild',
    'confirmed_resend',
  ]),
  result: z.enum(['reserved', 'possibly_sent', 'completed', 'failed', 'not_sent']),
  called: z.boolean(),
  physicalUnconfirmed: z.boolean(),
  suggestion: z.string().max(1024).nullable(),
  suggestionState: schedulingActivitySuggestionStateSchema.optional(),
  action: schedulingActivityActionSchema.nullable().optional(),
  actionResult: schedulingActivityActionResultSchema.nullable().optional(),
  originalUnconfirmed: z.boolean().optional(),
})
export type SchedulingActivityRow = z.infer<typeof schedulingActivityRowSchema>
export const schedulingActivityPageSchema = z
  .strictObject({
    asOf: z.string().datetime(),
    rows: z.array(schedulingActivityRowSchema).max(SCHEDULING_ACTIVITY_PAGE_ITEMS),
    nextCursor: schedulingActivityCursorSchema.nullable(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= SCHEDULING_ACTIVITY_PAGE_BYTES,
  )
export type SchedulingActivityPage = z.infer<typeof schedulingActivityPageSchema>
