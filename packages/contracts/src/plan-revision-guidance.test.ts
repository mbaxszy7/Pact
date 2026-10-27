import { describe, expect, it } from 'vitest'

import {
  DECISION_HIGHLIGHT_BYTES,
  PLAN_REVISION_GUIDANCE_BYTES,
  PLAN_REVISION_GUIDANCE_VERSION,
  decisionRecommendationSchema,
  planRevisionGuidanceProposalSchema,
  planRevisionGuidanceSchema,
  planRevisionGuidanceSourceSchema,
  type DecisionEvaluationOutcome,
  type PlanRevisionGuidance,
  type PlanRevisionGuidanceProposal,
  type PlanRevisionGuidanceSource,
} from './index.js'

const uuid = (index = 1) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

function source(
  index: number,
  roles: PlanRevisionGuidanceSource['roles'],
): PlanRevisionGuidanceSource {
  return {
    id: `s${index}`,
    roles,
    document: { id: uuid(index + 1), sha256: 'a'.repeat(64), bytes: 5, chars: 5 },
    evaluatedSha256: 'a'.repeat(64),
  }
}

function guidance(): PlanRevisionGuidance {
  return {
    version: PLAN_REVISION_GUIDANCE_VERSION,
    evaluationId: uuid(20),
    handoffId: 'b'.repeat(64),
    inputSha256: 'c'.repeat(64),
    sourceFingerprint: 'd'.repeat(64),
    taskId: uuid(21),
    inputSequence: 0,
    planVersion: 1,
    candidateId: 'continue_plan_revision',
    sources: [source(0, ['task']), source(1, ['plan']), source(2, ['review'])],
    highlights: [{ text: 'Verify the original review against the plan.', sourceIds: ['s1', 's2'] }],
  }
}

function proposal(): PlanRevisionGuidanceProposal {
  return {
    guidance: guidance(),
    configurationGeneration: 0,
    configurationFingerprint: 'e'.repeat(64),
    deadlineAt: Number.MAX_SAFE_INTEGER,
  }
}

function fullSources(): PlanRevisionGuidanceSource[] {
  return Array.from({ length: 12 }, (_, index) => ({
    ...source(index, ['task', 'input', 'comment', 'anchor', 'anchor_target', 'plan', 'review']),
    document: {
      ...source(index, ['task']).document,
      bytes: Number.MAX_SAFE_INTEGER,
      chars: Number.MAX_SAFE_INTEGER,
    },
    sourceRunId: uuid(30 + index),
    messageId: uuid(50 + index),
    memberId: uuid(70 + index),
    inputBatchRef: {
      id: uuid(90 + index),
      revision: Number.MAX_SAFE_INTEGER,
      memberCount: Number.MAX_SAFE_INTEGER,
    },
    inputSequence: Number.MAX_SAFE_INTEGER,
    planVersion: Number.MAX_SAFE_INTEGER,
  }))
}

function padHighlightToBytes(
  value: object,
  highlight: { text: string },
  targetBytes: number,
): void {
  highlight.text = '汉字🙂\ud800\udfff\n\t\0"\\'
  const remaining = targetBytes - bytes(value)
  expect(remaining).toBeGreaterThanOrEqual(0)
  highlight.text += 'x'.repeat(remaining)
  expect(bytes(value)).toBe(targetBytes)
}

describe('plan revision guidance contracts', () => {
  it('round trips standard source references and retains historical evaluated hashes after Fork', () => {
    const value = proposal()
    value.guidance.sources = fullSources()
    const original = value.guidance.sources[0]!
    original.document.sha256 = 'f'.repeat(64)
    expect(planRevisionGuidanceProposalSchema.parse(value)).toEqual(value)
    expect(original.evaluatedSha256).toBe('a'.repeat(64))
    expect(planRevisionGuidanceSourceSchema.parse(original)).toEqual(original)
  })

  it('requires stable source identities, deduplicated known roles and standard metadata', () => {
    const valid = source(0, ['task', 'plan', 'review'])
    for (const fields of [
      { id: 's12' },
      { id: 's01' },
      { id: 's-1' },
      { roles: [] },
      { roles: ['task', 'task'] },
      { roles: ['authorization'] },
      { evaluatedSha256: 'invalid' },
      { sourceRunId: 'invalid' },
      { messageId: 'invalid' },
      { memberId: '$body' },
      { inputSequence: -1 },
      { inputSequence: 0.5 },
      { planVersion: 0 },
      { inputBatchRef: { id: uuid(), revision: -1, memberCount: 0 } },
    ])
      expect(planRevisionGuidanceSourceSchema.safeParse({ ...valid, ...fields }).success).toBe(
        false,
      )
    expect(planRevisionGuidanceSourceSchema.safeParse(source(11, ['input'])).success).toBe(true)
    expect(planRevisionGuidanceSourceSchema.parse(source(3, ['anchor_target']))).toEqual(
      source(3, ['anchor_target']),
    )
  })

  it('requires the exact version and candidate, complete role coverage and unique supplied sources', () => {
    const valid = guidance()
    for (const fields of [
      { version: 'plan-revision-guidance-v2' },
      { version: undefined },
      { candidateId: 'implement' },
      { inputSequence: -1 },
      { planVersion: 0 },
      { sources: [] },
      { sources: [source(0, ['task']), source(1, ['plan'])] },
      { sources: [source(0, ['task', 'plan']), source(0, ['review'])] },
      { sources: [...fullSources(), source(0, ['input'])] },
    ])
      expect(planRevisionGuidanceSchema.safeParse({ ...valid, ...fields }).success).toBe(false)
  })

  it('grounds every nonempty recommendation highlight in unique existing source references', () => {
    const valid = guidance()
    for (const highlights of [
      [],
      [{ text: '', sourceIds: ['s0'] }],
      [{ text: 'Missing reference', sourceIds: [] }],
      [{ text: 'Foreign reference', sourceIds: ['s3'] }],
      [{ text: 'Repeated reference', sourceIds: ['s1', 's1'] }],
      Array.from({ length: 9 }, () => ({ text: 'Too many highlights', sourceIds: ['s0'] })),
    ])
      expect(planRevisionGuidanceSchema.safeParse({ ...valid, highlights }).success).toBe(false)
    expect(
      planRevisionGuidanceSchema.safeParse({
        ...valid,
        highlights: Array.from({ length: 8 }, () => ({ text: 'Checked focus', sourceIds: ['s0'] })),
      }).success,
    ).toBe(true)
  })

  it('rejects unknown fields at every persisted and proposal boundary, including authority fields', () => {
    const valid = proposal()
    const originalSource = valid.guidance.sources[0]!
    for (const value of [
      { ...valid, runId: uuid() },
      { ...valid, handoff: {} },
      { ...valid, guidance: { ...valid.guidance, command: 'implement' } },
      {
        ...valid,
        guidance: {
          ...valid.guidance,
          sources: [{ ...originalSource, grant: uuid() }, ...valid.guidance.sources.slice(1)],
        },
      },
      {
        ...valid,
        guidance: {
          ...valid.guidance,
          sources: [
            { ...originalSource, document: { ...originalSource.document, body: 'hidden' } },
            ...valid.guidance.sources.slice(1),
          ],
        },
      },
      {
        ...valid,
        guidance: {
          ...valid.guidance,
          sources: [
            {
              ...originalSource,
              inputBatchRef: { id: uuid(), revision: 0, memberCount: 1, grant: uuid() },
            },
            ...valid.guidance.sources.slice(1),
          ],
        },
      },
      {
        ...valid,
        guidance: {
          ...valid.guidance,
          highlights: [{ text: 'Unknown permission', sourceIds: ['s0'], approved: true }],
        },
      },
    ])
      expect(planRevisionGuidanceProposalSchema.safeParse(value).success).toBe(false)
  })

  it('preserves the complete 8 KiB highlight JSON budget with escaped and multibyte text', () => {
    const value = guidance()
    padHighlightToBytes(value.highlights, value.highlights[0]!, DECISION_HIGHLIGHT_BYTES)
    expect(planRevisionGuidanceSchema.safeParse(value).success).toBe(true)
    value.highlights[0]!.text += 'x'
    expect(bytes(value.highlights)).toBe(DECISION_HIGHLIGHT_BYTES + 1)
    expect(planRevisionGuidanceSchema.safeParse(value).success).toBe(false)
    value.highlights[0]!.text = '🙂'.repeat(2048)
    expect(value.highlights[0]!.text.length).toBeLessThan(DECISION_HIGHLIGHT_BYTES)
    expect(planRevisionGuidanceSchema.safeParse(value).success).toBe(false)
  })

  it('accepts the complete guidance at 16 KiB and refuses one extra encoded byte', () => {
    const value = guidance()
    value.sources = fullSources()
    padHighlightToBytes(value, value.highlights[0]!, PLAN_REVISION_GUIDANCE_BYTES)
    expect(bytes(value.highlights)).toBeLessThanOrEqual(DECISION_HIGHLIGHT_BYTES)
    expect(planRevisionGuidanceSchema.safeParse(value).success).toBe(true)
    value.highlights[0]!.text += 'x'
    expect(planRevisionGuidanceSchema.safeParse(value).success).toBe(false)
  })

  it('bounds the whole deeper proposal separately from otherwise valid guidance', () => {
    const value = proposal()
    value.guidance.sources = fullSources()
    padHighlightToBytes(value, value.guidance.highlights[0]!, PLAN_REVISION_GUIDANCE_BYTES)
    expect(bytes(value.guidance.highlights)).toBeLessThanOrEqual(DECISION_HIGHLIGHT_BYTES)
    expect(planRevisionGuidanceProposalSchema.safeParse(value).success).toBe(true)
    value.guidance.highlights[0]!.text += 'x'
    expect(bytes(value)).toBe(PLAN_REVISION_GUIDANCE_BYTES + 1)
    expect(planRevisionGuidanceSchema.safeParse(value.guidance).success).toBe(true)
    expect(planRevisionGuidanceProposalSchema.safeParse(value).success).toBe(false)
  })

  it('keeps host receipts separate from model recommendation output and rejects unsafe freshness', () => {
    const valid = proposal()
    for (const fields of [
      { configurationGeneration: -1 },
      { configurationGeneration: 0.5 },
      { configurationFingerprint: 'unknown' },
      { deadlineAt: -1 },
      { deadlineAt: 0.5 },
      { deadlineAt: Number.MAX_SAFE_INTEGER + 1 },
      { deadlineAt: Number.POSITIVE_INFINITY },
    ])
      expect(planRevisionGuidanceProposalSchema.safeParse({ ...valid, ...fields }).success).toBe(
        false,
      )
    const result: DecisionEvaluationOutcome = {
      kind: 'recommendation',
      recommendation: {
        candidateId: valid.guidance.candidateId,
        highlights: valid.guidance.highlights,
      },
      evaluationReceipt: {
        evaluationId: valid.guidance.evaluationId,
        handoffId: valid.guidance.handoffId,
        configurationGeneration: valid.configurationGeneration,
        configurationFingerprint: valid.configurationFingerprint,
        deadlineAt: valid.deadlineAt,
      },
    }
    expect(decisionRecommendationSchema.safeParse(result.recommendation).success).toBe(true)
    expect(
      decisionRecommendationSchema.safeParse({
        ...result.recommendation,
        evaluationReceipt: result.evaluationReceipt,
      }).success,
    ).toBe(false)
  })
})
