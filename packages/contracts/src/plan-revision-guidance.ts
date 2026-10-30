import { z } from 'zod'

import {
  collaborationDocumentSchema,
  collaborationInputBatchReferenceSchema,
} from './collaboration-documents.js'
import {
  DECISION_SOURCES,
  decisionRecommendationSchema,
  type DecisionInput,
  type DecisionOutcome,
} from './decision-runtime.js'

export const PLAN_REVISION_GUIDANCE_VERSION = 'plan-revision-guidance-v1'
export const PLAN_REVISION_GUIDANCE_BYTES = 16 * 1024

const digest = z.string().regex(/^[a-f0-9]{64}$/u)

export const planRevisionGuidanceSourceSchema = z.strictObject({
  id: z.string().regex(/^s(?:[0-9]|1[01])$/u),
  roles: z
    .array(z.enum(['task', 'input', 'comment', 'anchor', 'anchor_target', 'plan', 'review']))
    .min(1)
    .max(7)
    .refine((roles) => new Set(roles).size === roles.length, 'Source roles must be unique.'),
  document: collaborationDocumentSchema,
  /** Historical evaluated bytes remain unchanged when Fork remaps the document reference. */
  evaluatedSha256: digest,
  sourceRunId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  memberId: z.string().uuid().optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
  inputSequence: z.number().int().nonnegative().optional(),
  planVersion: z.number().int().positive().optional(),
})
export type PlanRevisionGuidanceSource = z.infer<typeof planRevisionGuidanceSourceSchema>

/** Count strictly parsed JSON without serializing a copy or applying the shallower model depth. */
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

/** Advice is immutable source evidence. It contains neither execution permission nor a Run. */
export const planRevisionGuidanceSchema = z
  .strictObject({
    version: z.literal(PLAN_REVISION_GUIDANCE_VERSION),
    evaluationId: z.string().uuid(),
    handoffId: digest,
    inputSha256: digest,
    sourceFingerprint: digest,
    taskId: z.string().uuid(),
    inputSequence: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    candidateId: z.literal('continue_plan_revision'),
    sources: z.array(planRevisionGuidanceSourceSchema).min(1).max(DECISION_SOURCES),
    highlights: decisionRecommendationSchema.shape.highlights.min(1),
  })
  .superRefine((value, context) => {
    const sourceIds = new Set(value.sources.map((source) => source.id))
    if (sourceIds.size !== value.sources.length)
      context.addIssue({ code: 'custom', message: 'Guidance source identities must be unique.' })
    const roles = new Set(value.sources.flatMap((source) => source.roles))
    if ((['task', 'plan', 'review'] as const).some((role) => !roles.has(role)))
      context.addIssue({
        code: 'custom',
        message: 'Guidance requires task, plan and review sources.',
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
    if (!jsonBytesWithinBudget(value, PLAN_REVISION_GUIDANCE_BYTES))
      context.addIssue({
        code: 'custom',
        message: 'The complete guidance exceeds its byte budget.',
      })
  })
export type PlanRevisionGuidance = z.infer<typeof planRevisionGuidanceSchema>

/** Ephemeral adoption proposal; freshness scalars grant no authority to dispatch a Run. */
export const planRevisionGuidanceProposalSchema = z
  .strictObject({
    guidance: planRevisionGuidanceSchema,
    configurationGeneration: z.number().int().nonnegative(),
    configurationFingerprint: digest,
    deadlineAt: z.number().int().nonnegative(),
  })
  .refine(
    (value) => jsonBytesWithinBudget(value, PLAN_REVISION_GUIDANCE_BYTES),
    'The complete guidance proposal exceeds its byte budget.',
  )
export type PlanRevisionGuidanceProposal = z.infer<typeof planRevisionGuidanceProposalSchema>

export type PlanRevisionDecisionMaterial = {
  input: DecisionInput
  sources: PlanRevisionGuidanceSource[]
  inputSha256: string
  sourceFingerprint: string
  taskId: string
  inputSequence: number
  planVersion: number
}

export type DecisionEvaluationReceipt = {
  evaluationId: string
  handoffId: string
  configurationGeneration: number
  configurationFingerprint: string
  deadlineAt: number
}

/** Host result only; the model recommendation schema does not accept receipt identities. */
export type DecisionEvaluationOutcome =
  | Extract<DecisionOutcome, { kind: 'unavailable' }>
  | (Extract<DecisionOutcome, { kind: 'recommendation' }> & {
      evaluationReceipt: DecisionEvaluationReceipt
    })
