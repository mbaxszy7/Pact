import { z } from 'zod'

/** Host-owned facts, never model-selected dispatch identities or authorization. */
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const schedulingBudgetRootSchema = z.strictObject({
  kind: z.enum(['task', 'input']),
  id: z.string().uuid(),
})
export const schedulingFaultSchema = z.strictObject({
  kind: z.enum(['run', 'queue', 'rebuild']),
  id: z.string().uuid(),
})
const runFreshnessGuardSchema = z.strictObject({
  taskRevision: z.number().int().nonnegative().nullable(),
  settingsRevision: z.number().int().nonnegative(),
  inputSequence: z.number().int().nonnegative(),
  runId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  agentId: z.enum(['codex', 'claude']),
  /** Includes complete source identities, authorization, pause and interaction facts. */
  stateFingerprint: digest,
})
/** A frozen input has no Message, Run, recipient or native binding yet. */
const preparedInputFreshnessGuardSchema = z.strictObject({
  kind: z.literal('prepared_input'),
  batchId: z.string().uuid(),
  taskRevision: z.null(),
  settingsRevision: z.number().int().nonnegative(),
  inputSequence: z.number().int().nonnegative(),
  runId: z.null(),
  bindingGeneration: z.null(),
  agentId: z.null(),
  stateFingerprint: digest,
})
export const schedulingFreshnessGuardSchema = z.union([
  runFreshnessGuardSchema,
  preparedInputFreshnessGuardSchema,
])
export const schedulingHandoffSchema = z
  .strictObject({
    id: digest,
    sessionId: z.string().uuid(),
    budgetRoot: schedulingBudgetRootSchema,
    budgetSubjectId: z.string().min(1).max(80),
    fault: schedulingFaultSchema.optional(),
    eventId: z.string().min(1).max(160),
    slot: z.enum([
      'workflow_next',
      'input_dispatch',
      'native_check',
      'queue_check',
      'rebuild_check',
      'confirmed_resend',
    ]),
    factFingerprint: digest,
    freshnessGuard: schedulingFreshnessGuardSchema,
  })
  .superRefine((value, context) => {
    if (
      value.freshnessGuard.runId === null &&
      (value.slot !== 'input_dispatch' ||
        value.budgetRoot.kind !== 'input' ||
        value.fault ||
        value.eventId !== value.budgetRoot.id)
    )
      context.addIssue({
        code: 'custom',
        message: 'A prepared input can only own its original input dispatch.',
      })
  })
export type SchedulingBudgetRoot = z.infer<typeof schedulingBudgetRootSchema>
export type SchedulingFault = z.infer<typeof schedulingFaultSchema>
export type SchedulingFreshnessGuard = z.infer<typeof schedulingFreshnessGuardSchema>
export type SchedulingHandoff = z.infer<typeof schedulingHandoffSchema>

export const schedulingBudgetSchema = z.enum([
  'extra_plan_turn',
  'extra_code_turn',
  'automatic_check',
  'automatic_resend',
])
export type SchedulingBudget = z.infer<typeof schedulingBudgetSchema>
export const schedulingUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
})
export type SchedulingUsage = z.infer<typeof schedulingUsageSchema>
