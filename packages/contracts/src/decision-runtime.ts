import { z } from 'zod'

import { schedulingHandoffSchema } from './scheduling.js'

export const DECISION_INPUT_BYTES = 128 * 1024
export const DECISION_OUTPUT_BYTES = 16 * 1024
export const DECISION_HIGHLIGHT_BYTES = 8 * 1024
export const DECISION_WORKING_BYTES = 16 * 1024 * 1024
export const DECISION_DEADLINE_MS = 15_000
export const DECISION_CANCEL_TARGET_MS = 2_000
export const DECISION_CLEANUP_TARGET_MS = 4_000
export const DECISION_CANDIDATES = 8
export const DECISION_SOURCES = 12
export const DECISION_HIGHLIGHTS = 8
export const DECISION_SCHEMA_DEPTH = 4
export const DECISION_PHYSICAL_RECEIPT_ITEMS = 32
export const DECISION_PHYSICAL_RECEIPT_BYTES = 64 * 1024
export const decisionNativeStageSchema = z.enum([
  'host_metadata',
  'project_metadata',
  'guarded_context',
  'project_verification',
])
export type DecisionNativeStage = z.infer<typeof decisionNativeStageSchema>

export const decisionCapabilityReasonSchema = z.enum([
  'supported',
  'busy',
  'timeout',
  'cancelled',
  'stale',
  'unsupported_platform',
  'unsupported_provider',
  'unsupported_network',
  'unsupported_authentication',
  'unsupported_protocol',
  'project_authentication_differs',
  'executable_unavailable',
  'model_unavailable',
  'model_metadata_invalid',
  'model_effort_unavailable',
  'catalog_limit',
  'unavailable',
  'cleanup_unconfirmed',
])
export type DecisionCapabilityReason = z.infer<typeof decisionCapabilityReasonSchema>

/** A completed zero-inference inspection of native compatibility, never future dispatch authority. */
export const decisionCapabilitySchema = z
  .strictObject({
    provider: z.enum(['codex', 'claude']),
    modelId: z.string().min(1).max(256),
    status: z.enum(['supported', 'unavailable']),
    supported: z.boolean(),
    reason: decisionCapabilityReasonSchema,
    configurationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    checkedAt: z.string().datetime(),
    physicalReleased: z.boolean(),
  })
  .refine(
    (value) =>
      value.supported === (value.status === 'supported') &&
      (value.supported
        ? value.reason === 'supported' &&
          value.configurationFingerprint !== null &&
          value.physicalReleased
        : value.reason !== 'supported'),
    'Supported native compatibility requires complete evidence and confirmed physical release.',
  )
export type DecisionCapability = z.infer<typeof decisionCapabilitySchema>

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.:-]+$/u)
/** Counts without allocating an encoded/stringified copy of complete necessary material. */
function stringBytes(text: string, limit: number, quoted: boolean): number {
  let total = quoted ? 2 : 0
  for (let i = 0; i < text.length && total <= limit; i++) {
    const code = text.charCodeAt(i)
    if (quoted && (code === 34 || code === 92)) total += 2
    else if (quoted && code < 32) total += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      total += 4
      i++
    } else if (code >= 0xd800 && code <= 0xdfff) total += quoted ? 6 : 3
    else total += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
  }
  return total
}

export function decisionJsonBytes(root: unknown, limit = DECISION_INPUT_BYTES): number {
  let total = 0,
    containers = 0
  const count = (value: unknown, depth: number): void => {
    if (total > limit) return
    if (typeof value === 'string') {
      total += stringBytes(value, limit - total, true)
      return
    }
    if (value === null) {
      total += 4
      return
    }
    if (typeof value === 'boolean') {
      total += value ? 4 : 5
      return
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += String(value).length
      return
    }
    if (!value || typeof value !== 'object' || depth > DECISION_SCHEMA_DEPTH || ++containers > 64)
      throw Error('Invalid decision JSON')
    const array = Array.isArray(value)
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      throw Error('Invalid decision JSON')
    if (array && value.length > DECISION_SOURCES) throw Error('Invalid decision JSON')
    let members = 0,
      encodedMembers = 0
    total += 2
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue
      if (++members > 16) throw Error('Invalid decision JSON')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
        throw Error('Invalid decision JSON')
      if (
        array &&
        (!Number.isSafeInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= value.length ||
          String(Number(key)) !== key)
      )
        throw Error('Invalid decision JSON')
      if (descriptor.value === undefined && !array) continue
      if (encodedMembers++) total++
      if (!array) total += stringBytes(key, limit - total, true) + 1
      count(descriptor.value, depth + 1)
      if (total > limit) return
    }
    if (array && members !== value.length) throw Error('Invalid decision JSON')
  }
  try {
    count(root, 1)
    return total
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Complete source text is admitted or refused together; these bounds never shorten it. */
export const decisionInputSchema = z
  .strictObject({
    version: z.literal(1),
    handoff: schedulingHandoffSchema,
    objective: z.string().min(1).max(DECISION_INPUT_BYTES),
    candidates: z
      .array(
        z.strictObject({
          id,
          description: z.string().min(1).max(DECISION_INPUT_BYTES),
        }),
      )
      .min(1)
      .max(DECISION_CANDIDATES),
    sources: z
      .array(
        z.strictObject({
          id,
          digest: z.string().regex(/^[a-f0-9]{64}$/u),
          text: z.string().max(DECISION_INPUT_BYTES),
        }),
      )
      .max(DECISION_SOURCES),
  })
  .superRefine((value, context) => {
    if (decisionJsonBytes(value) > DECISION_INPUT_BYTES)
      context.addIssue({
        code: 'custom',
        message: 'The complete decision input exceeds its byte budget.',
      })
    if (
      new Set(value.candidates.map((candidate) => candidate.id)).size !== value.candidates.length ||
      new Set(value.sources.map((source) => source.id)).size !== value.sources.length
    )
      context.addIssue({ code: 'custom', message: 'Decision identities must be unique.' })
  })
export type DecisionInput = z.infer<typeof decisionInputSchema>

/** Runtime entry point: reject excessive material before schema projection or serialization. */
export function validateDecisionInput(
  value: unknown,
): { success: true; input: DecisionInput } | { success: false } {
  if (decisionJsonBytes(value) > DECISION_INPUT_BYTES) return { success: false }
  const parsed = decisionInputSchema.safeParse(value)
  return parsed.success ? { success: true, input: parsed.data } : { success: false }
}

/** Select an existing host-admitted user field; the model cannot create its question. */
export const decisionInformationSchema = z.strictObject({ fieldId: z.string().uuid() })
export type DecisionInformation = z.infer<typeof decisionInformationSchema>

/** A candidate ID is only a suggestion. It never carries a Run, operation or authorization. */
export const decisionRecommendationSchema = z
  .strictObject({
    candidateId: id.nullable(),
    information: decisionInformationSchema.optional(),
    highlights: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(DECISION_HIGHLIGHT_BYTES),
          sourceIds: z.array(id).min(1).max(DECISION_SOURCES),
        }),
      )
      .max(DECISION_HIGHLIGHTS),
  })
  .superRefine((value, context) => {
    if (
      decisionJsonBytes(value, DECISION_OUTPUT_BYTES) > DECISION_OUTPUT_BYTES ||
      decisionJsonBytes(value.highlights, DECISION_HIGHLIGHT_BYTES) > DECISION_HIGHLIGHT_BYTES
    )
      context.addIssue({
        code: 'custom',
        message: 'The decision recommendation exceeds its byte budget.',
      })
    if (
      (value.candidateId === 'clarify_prepared_input') !== (value.information !== undefined) ||
      (value.information && value.highlights.length)
    )
      context.addIssue({
        code: 'custom',
        message: 'Only the admitted information candidate can carry one necessary question.',
      })
    if (value.candidateId === null && value.highlights.length)
      context.addIssue({
        code: 'custom',
        message: 'An undecided result cannot carry a handoff recommendation.',
      })
    if (
      value.highlights.some(
        (highlight) => new Set(highlight.sourceIds).size !== highlight.sourceIds.length,
      )
    )
      context.addIssue({ code: 'custom', message: 'A highlight cannot repeat a source identity.' })
  })
export type DecisionRecommendation = z.infer<typeof decisionRecommendationSchema>

export type DecisionOutcome =
  | { kind: 'recommendation'; recommendation: DecisionRecommendation }
  | {
      kind: 'unavailable'
      reason:
        | 'disabled'
        | 'busy'
        | 'duplicate'
        | 'invalid_input'
        | 'invalid_output'
        | 'cancelled'
        | 'timeout'
        | 'stale'
        | 'runtime_unavailable'
    }

export {
  decisionPhysicalWitnessSchema,
  decisionPhysicalWitnessExtends,
  type DecisionPhysicalWitness,
  type DecisionDarwinPhysicalWitness,
  type DecisionWindowsPhysicalWitness,
} from './decision-physical-witness.js'

/** Parse untrusted model text without exporting raw parser errors or accepting free-text commands. */
export function parseDecisionRecommendation(
  text: string,
  input: DecisionInput,
): { success: true; recommendation: DecisionRecommendation } | { success: false } {
  if (stringBytes(text, DECISION_OUTPUT_BYTES, false) > DECISION_OUTPUT_BYTES)
    return { success: false }
  try {
    const parsed = decisionRecommendationSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return { success: false }
    const recommendation = parsed.data
    if (
      recommendation.candidateId !== null &&
      !input.candidates.some((candidate) => candidate.id === recommendation.candidateId)
    )
      return { success: false }
    const sources = new Set(input.sources.map((source) => source.id))
    if (
      recommendation.highlights.some((highlight) =>
        highlight.sourceIds.some((source) => !sources.has(source)),
      )
    )
      return { success: false }
    return { success: true, recommendation }
  } catch {
    return { success: false }
  }
}
