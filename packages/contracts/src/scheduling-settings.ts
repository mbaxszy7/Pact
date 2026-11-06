import { z } from 'zod'

import { OPENAI_DECISION_MODEL } from './decision-runtime.js'

export const SCHEDULING_ACTIVITY_PAGE_ITEMS = 25
export const SCHEDULING_ACTIVITY_PAGE_BYTES = 128 * 1024
export const SCHEDULING_ACTIVITY_RESIDENT_ITEMS = 100
export const SCHEDULING_ACTIVITY_RESIDENT_BYTES = 400 * 1024
export const SCHEDULING_ACTIVITY_TIMEOUT_MS = 5_000
export const SCHEDULING_CAPABILITY_TTL_MS = 60_000
export const SCHEDULING_CAPABILITY_RESIDENT_BYTES = 8 * 1024
export const SCHEDULING_STATE_REFRESH_TIMEOUT_MS = 20_000
export const SCHEDULING_USAGE_NOTICE =
  'Sends relevant task context to OpenAI. Usage is billed to your API account.'
export const schedulingChangedSchema = z.strictObject({ changed: z.literal(true) })

export const schedulingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z.literal('openai'),
  model: z.literal(OPENAI_DECISION_MODEL),
  credential: z.strictObject({
    configured: z.boolean(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  showIndicator: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
})
export type SchedulingSettings = z.infer<typeof schedulingSettingsSchema>

export const schedulingStateInputSchema = z.strictObject({
  sessionId: z.string().uuid().optional(),
})
export type SchedulingStateInput = z.infer<typeof schedulingStateInputSchema>

export const decisionConnectionSchema = z.strictObject({
  status: z.enum(['unconfirmed', 'available', 'unavailable', 'stale']),
  checkedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
})
export type DecisionConnection = z.infer<typeof decisionConnectionSchema>
export const schedulingEligibilitySchema = z.enum([
  'available',
  'disabled',
  'key_required',
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
  connection: decisionConnectionSchema,
  context: z
    .strictObject({
      sessionId: z.string().uuid(),
      eligibility: schedulingEligibilitySchema,
    })
    .nullable(),
  activity: z.strictObject({ decision: decisionActivitySchema, check: checkActivitySchema }),
})
export type SchedulingState = z.infer<typeof schedulingStateSchema>
export const schedulingSettingsSaveSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  showIndicator: z.boolean().optional(),
})
export type SchedulingSettingsSave = z.infer<typeof schedulingSettingsSaveSchema>
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
  'reassign_roles',
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
  provider: z.enum(['codex', 'claude', 'openai']).nullable(),
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
