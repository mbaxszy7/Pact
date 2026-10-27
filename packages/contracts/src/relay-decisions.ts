import { z } from 'zod'

import { collaborationDocumentSchema } from './collaboration-documents.js'
import { schedulingHandoffSchema } from './scheduling.js'

export const RELAY_DECISION_BYTES = 4 * 1024
const uuid = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const text = (limit: number) => z.string().trim().min(1).max(limit)
const withinRecordBudget = (value: unknown): boolean =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength < RELAY_DECISION_BYTES

/** Distinct from native request IDs and the Agent's collaboration question identity. */
export const relayDecisionReferenceSchema = z.strictObject({
  sessionId: uuid,
  decisionId: uuid,
  revision: z.number().int().nonnegative(),
})
export type RelayDecisionReference = z.infer<typeof relayDecisionReferenceSchema>

export const relaySupplementOperationSchema = z.strictObject({
  kind: z.enum(['supplement_plan', 'supplement_code_response']),
  taskId: uuid,
  afterRunId: uuid,
  actor: z.enum(['codex', 'claude']),
  returnActor: z.enum(['codex', 'claude']),
  scopeFingerprint: digest,
})
export const relayRebuildOperationSchema = z.strictObject({
  kind: z.literal('rebuild_native_context'),
  agentId: z.enum(['codex', 'claude']),
  expectedGeneration: z.number().int().positive(),
  expectedNativeSessionId: text(1024).nullable(),
  expectedRunId: uuid.nullable(),
  expectedRebuildId: uuid.nullable(),
  abandonOldWork: z.boolean(),
})
export const relayRepairOperationSchema = relaySupplementOperationSchema.extend({
  kind: z.literal('repair'),
})
const schedulingFieldSchema = z.strictObject({
  fieldId: uuid,
  prompt: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => Boolean(value.trim())),
  input: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('single'),
      options: z
        .array(
          z.strictObject({
            id: uuid,
            label: z
              .string()
              .min(1)
              .max(160)
              .refine((value) => Boolean(value.trim())),
          }),
        )
        .min(2)
        .max(6),
    }),
    z.strictObject({ kind: z.literal('text'), maxLength: z.number().int().min(1).max(1024) }),
  ]),
})

/**
 * A current host-admitted scheduling decision, never raw model output or an authority grant.
 * Necessary information requires an existing typed host consumer; this schema alone opens none.
 */
export const relaySchedulingDecisionSchema = relayDecisionReferenceSchema
  .extend({
    version: z.literal('relay-decision-v2'),
    handoffId: digest,
    title: text(160),
    reason: text(512),
    consequence: text(512),
    sources: z
      .array(z.strictObject({ id: text(160), label: text(96) }))
      .min(1)
      .max(12),
    request: z.discriminatedUnion('category', [
      z.strictObject({
        category: z.literal('arrangement_change'),
        operation: relayRebuildOperationSchema,
      }),
      z.strictObject({
        category: z.literal('new_authorization'),
        operation: z.discriminatedUnion('kind', [
          relaySupplementOperationSchema,
          relayRepairOperationSchema,
        ]),
      }),
      z.strictObject({
        category: z.literal('necessary_information'),
        consumer: z.strictObject({
          kind: z.literal('prepared_input_clarification'),
          batchId: uuid,
          clientMessageId: uuid,
          requestFingerprint: digest,
          sourceFingerprint: digest,
          defaultAgentId: z.enum(['codex', 'claude']),
          declaredFieldId: uuid.optional(),
        }),
        field: schedulingFieldSchema,
      }),
    ]),
  })
  .refine(withinRecordBudget, 'The complete Relay decision exceeds its metadata budget.')
export type RelaySchedulingDecision = z.infer<typeof relaySchedulingDecisionSchema>

export const relayDecisionAnswerSchema = z
  .strictObject({
    reference: relayDecisionReferenceSchema,
    clientOperationId: uuid,
    answer: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('confirm') }),
      z.strictObject({ kind: z.literal('cancel') }),
      z.strictObject({ kind: z.literal('selection'), fieldId: uuid, optionId: uuid }),
      z.strictObject({
        kind: z.literal('text'),
        fieldId: uuid,
        text: z
          .string()
          .min(1)
          .max(1024)
          .refine((value) => Boolean(value.trim())),
      }),
    ]),
  })
  .refine(withinRecordBudget, 'The complete Relay answer exceeds its metadata budget.')
export type RelayDecisionAnswer = z.infer<typeof relayDecisionAnswerSchema>

/** Shape validity never establishes freshness, necessity, permission or dispatch eligibility. */
export function relayAnswerMatchesDecision(
  decision: RelaySchedulingDecision,
  input: RelayDecisionAnswer,
): boolean {
  const { reference, answer } = input
  if (
    reference.sessionId !== decision.sessionId ||
    reference.decisionId !== decision.decisionId ||
    reference.revision !== decision.revision
  )
    return false
  if (answer.kind === 'cancel') return true
  if (decision.request.category !== 'necessary_information') return answer.kind === 'confirm'
  const field = decision.request.field
  if (answer.kind !== 'text' && answer.kind !== 'selection') return false
  if (answer.fieldId !== field.fieldId) return false
  return field.input.kind === 'single'
    ? answer.kind === 'selection' &&
        field.input.options.some((option) => option.id === answer.optionId)
    : answer.kind === 'text' && answer.text.length <= field.input.maxLength
}

/** Accepted before the inference deadline; user waiting holds no native inference reservation. */
export const relaySchedulingDecisionProofSchema = z
  .strictObject({
    version: z.literal('relay-decision-proof-v2'),
    card: relaySchedulingDecisionSchema,
    handoff: schedulingHandoffSchema,
    configurationGeneration: z.number().int().nonnegative(),
    evaluationId: uuid,
    inputSha256: digest,
    sourceFingerprint: digest,
    candidateId: text(160),
    operationFingerprint: digest,
    executionFingerprint: digest,
    informationEvidence: z
      .strictObject({
        kind: z.enum(['user_reserved_choice', 'user_supplied_value']),
        sourceId: text(160),
        sourceSha256: digest,
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        fieldId: uuid.optional(),
        declarationDocument: collaborationDocumentSchema.optional(),
      })
      .refine(
        (value) =>
          value.fieldId
            ? value.declarationDocument !== undefined && value.end >= value.start
            : value.declarationDocument === undefined && value.end > value.start,
        'Legacy quote evidence is nonempty; a new field requires its independent declaration.',
      )
      .optional(),
  })
  .refine(
    (value) =>
      (value.card.request.category === 'necessary_information') ===
      Boolean(value.informationEvidence),
    'Necessary information requires its exact current user-source evidence.',
  )
  .refine(withinRecordBudget, 'The complete Relay proof exceeds its metadata budget.')
export type RelaySchedulingDecisionProof = z.infer<typeof relaySchedulingDecisionProofSchema>

/** Deterministic native recovery facts never masquerade as a model evaluation. */
export const relayNativeRecoveryProofSchema = z
  .strictObject({
    version: z.literal('relay-native-recovery-proof-v1'),
    card: relaySchedulingDecisionSchema.refine(
      (card) => card.request.category === 'arrangement_change',
    ),
    configurationGeneration: z.number().int().nonnegative(),
    utilityEpoch: uuid,
    originFaultId: uuid.optional(),
    scopeFingerprint: digest,
  })
  .refine(withinRecordBudget, 'The complete native recovery proof exceeds its metadata budget.')
export type RelayNativeRecoveryProof = z.infer<typeof relayNativeRecoveryProofSchema>

export const relayDecisionReceiptReadSchema = z.strictObject({
  sessionId: uuid,
  decisionId: uuid,
  clientOperationId: uuid,
})
export type RelayDecisionReceiptRead = z.infer<typeof relayDecisionReceiptReadSchema>
export const relayDecisionReceiptSchema = z.strictObject({
  sessionId: uuid,
  decisionId: uuid,
  clientOperationId: uuid,
  disposition: z.enum(['confirmed', 'cancelled', 'discarded']),
  runId: uuid.nullable(),
  rebuildId: uuid.nullable(),
})
export type RelayDecisionReceipt = z.infer<typeof relayDecisionReceiptSchema>
