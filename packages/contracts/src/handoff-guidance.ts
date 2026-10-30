import { z } from 'zod'

import {
  collaborationInputBatchReferenceSchema,
  collaborationPlanReferenceSchema,
} from './collaboration.js'
import {
  DECISION_SOURCES,
  decisionRecommendationSchema,
  type DecisionInput,
} from './decision-runtime.js'
import {
  planRevisionGuidanceSchema,
  planRevisionGuidanceSourceSchema,
} from './plan-revision-guidance.js'

export const HANDOFF_GUIDANCE_VERSION = 'handoff-guidance-v2'
export const HANDOFF_GUIDANCE_BYTES = 16 * 1024

const digest = z.string().regex(/^[a-f0-9]{64}$/u)

export const relaySourceRoleSchema = z.enum([
  'task',
  'input',
  'comment',
  'anchor',
  'anchor_target',
  'plan',
  'review',
  'prior_review',
  'owner_response',
  'execution',
  'review_scope',
  'user_decision',
])
export type RelaySourceRole = z.infer<typeof relaySourceRoleSchema>

/** Exact host-selected provenance is evidence, never a source-reading grant. */
export const relaySourceSchema = planRevisionGuidanceSourceSchema.extend({
  roles: z
    .array(relaySourceRoleSchema)
    .min(1)
    .max(12)
    .refine((roles) => new Set(roles).size === roles.length, 'Source roles must be unique.'),
})
export type RelaySource = z.infer<typeof relaySourceSchema>

export const relayWorkflowBasisV2Schema = z.strictObject({
  kind: z.literal('workflow'),
  task: z.strictObject({
    id: z.string().uuid(),
    inputSequence: z.number().int().nonnegative(),
  }),
  producerRunId: z.string().uuid(),
  plan: collaborationPlanReferenceSchema.nullable(),
  input: z.null(),
})

/** Ordinary input material has no workflow task, producer Run or Plan authority. */
export const relayBasisV2Schema = z.discriminatedUnion('kind', [
  relayWorkflowBasisV2Schema,
  z.strictObject({
    kind: z.literal('input'),
    task: z.null(),
    producerRunId: z.null(),
    plan: z.null(),
    input: z.strictObject({
      clientMessageId: z.string().uuid(),
      batch: collaborationInputBatchReferenceSchema,
    }),
  }),
])
export type RelayBasisV2 = z.infer<typeof relayBasisV2Schema>

export const workflowRelayCandidateIdSchema = z.enum([
  'continue_plan_review',
  'continue_plan_revision',
  'continue_code_review',
  'respond_to_code_review',
  'repair_code',
  'supplement_plan',
  'supplement_code_response',
])
export type WorkflowRelayCandidateId = z.infer<typeof workflowRelayCandidateIdSchema>

/** Count parsed v2 JSON, including nullable basis fields, without serializing another copy. */
function jsonBytesWithinBudget(value: object, limit: number): boolean {
  let bytes = 0,
    containers = 0
  const string = (text: string): void => {
    bytes += 2
    for (const character of text) {
      const code = character.codePointAt(0)!
      if (code === 34 || code === 92) bytes += 2
      else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
      else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
      if (bytes > limit) return
    }
  }
  const count = (item: unknown, depth: number): void => {
    if (bytes > limit) return
    if (typeof item === 'string') return string(item)
    if (item === null) {
      bytes += 4
      return
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      bytes += String(item).length
      return
    }
    if (!item || typeof item !== 'object' || depth > 8 || ++containers > 128) {
      bytes = limit + 1
      return
    }
    bytes += 2
    if (Array.isArray(item)) {
      if (item.length > DECISION_SOURCES) {
        bytes = limit + 1
        return
      }
      for (let index = 0; index < item.length && bytes <= limit; index++) {
        if (index) bytes++
        count(item[index], depth + 1)
      }
      return
    }
    let members = 0
    for (const [key, member] of Object.entries(item)) {
      if (member === undefined) continue
      if (members++) bytes++
      string(key)
      bytes++
      count(member, depth + 1)
      if (bytes > limit) return
    }
  }
  count(value, 1)
  return bytes <= limit
}

/** Adopted workflow focus is immutable evidence; ordinary routing only retains its receipt. */
export const handoffGuidanceV2Schema = z
  .strictObject({
    version: z.literal(HANDOFF_GUIDANCE_VERSION),
    evaluationId: z.string().uuid(),
    handoffId: digest,
    inputSha256: digest,
    sourceFingerprint: digest,
    basis: relayWorkflowBasisV2Schema,
    candidateId: workflowRelayCandidateIdSchema,
    sources: z.array(relaySourceSchema).min(1).max(DECISION_SOURCES),
    highlights: decisionRecommendationSchema.shape.highlights.min(1),
  })
  .superRefine((value, context) => {
    const sourceIds = new Set(value.sources.map((source) => source.id))
    if (sourceIds.size !== value.sources.length)
      context.addIssue({ code: 'custom', message: 'Guidance source identities must be unique.' })
    const roles = new Set(value.sources.flatMap((source) => source.roles))
    if (!roles.has('task'))
      context.addIssue({ code: 'custom', message: 'Workflow guidance requires a task source.' })
    if (roles.has('plan') !== (value.basis.plan !== null))
      context.addIssue({
        code: 'custom',
        message: 'Guidance Plan sources must match the presence of its frozen Plan basis.',
      })
    if (
      !decisionRecommendationSchema.safeParse({
        candidateId: value.candidateId,
        highlights: value.highlights,
      }).success
    )
      context.addIssue({
        code: 'custom',
        message: 'Guidance highlights exceed recommendation rules.',
      })
    if (
      value.highlights.some((highlight) =>
        highlight.sourceIds.some((sourceId) => !sourceIds.has(sourceId)),
      )
    )
      context.addIssue({ code: 'custom', message: 'Guidance highlights require supplied sources.' })
    if (!jsonBytesWithinBudget(value, HANDOFF_GUIDANCE_BYTES))
      context.addIssue({
        code: 'custom',
        message: 'The complete guidance exceeds its byte budget.',
      })
  })
export type HandoffGuidanceV2 = z.infer<typeof handoffGuidanceV2Schema>

/** Historical readers preserve v1 validation and reject every unknown guidance version. */
export const handoffGuidanceSchema = z.union([planRevisionGuidanceSchema, handoffGuidanceV2Schema])
export type HandoffGuidance = z.infer<typeof handoffGuidanceSchema>

/** Ephemeral v2 adoption proposal; the host must independently verify freshness and scope. */
export const handoffGuidanceProposalSchema = z
  .strictObject({
    guidance: handoffGuidanceV2Schema,
    configurationGeneration: z.number().int().nonnegative(),
    configurationFingerprint: digest,
    deadlineAt: z.number().int().nonnegative(),
  })
  .refine(
    (value) => jsonBytesWithinBudget(value, HANDOFF_GUIDANCE_BYTES),
    'The complete guidance proposal exceeds its byte budget.',
  )
export type HandoffGuidanceProposal = z.infer<typeof handoffGuidanceProposalSchema>

/** Ordinary routing retains only the selected recipient's receipt, never unadopted model prose. */
export const inputRoutingProposalSchema = z.strictObject({
  version: z.literal('input-routing-v1'),
  evaluationId: z.string().uuid(),
  handoffId: digest,
  inputSha256: digest,
  sourceFingerprint: digest,
  candidateId: z.enum(['route_codex', 'route_claude']),
  configurationGeneration: z.number().int().nonnegative(),
  configurationFingerprint: digest,
  deadlineAt: z.number().int().nonnegative(),
})
export type InputRoutingProposal = z.infer<typeof inputRoutingProposalSchema>

/** Durable ordinary-Send receipt metadata; no model prose or native credentials. */
export const preparedInputMetadataSchema = z.strictObject({
  version: z.literal('prepared-input-v1'),
  ownerId: z.string().uuid(),
  requestFingerprint: digest,
  inputId: z.string().uuid().nullable(),
  routeSpecified: z.boolean(),
  defaultAgentId: z.enum(['claude', 'codex']),
  allowedAgentIds: z
    .array(z.enum(['claude', 'codex']))
    .min(1)
    .max(2),
  routeIntent: z.literal('implicit'),
  composerRevision: z.number().int().nonnegative(),
  settingsRevision: z.number().int().nonnegative(),
  sourceFingerprint: digest,
  cancellationReason: z.enum(['cancelled', 'preparation_failed', 'restarted']).optional(),
})
export type PreparedInputMetadata = z.infer<typeof preparedInputMetadataSchema>

export type RelayDecisionMaterial = {
  input: DecisionInput
  basis: RelayBasisV2
  sources: RelaySource[]
  inputSha256: string
  sourceFingerprint: string
}
