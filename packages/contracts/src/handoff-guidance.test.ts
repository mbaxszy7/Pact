import { describe, expect, it } from 'vitest'

import {
  DECISION_HIGHLIGHT_BYTES,
  HANDOFF_GUIDANCE_BYTES,
  HANDOFF_GUIDANCE_VERSION,
  handoffGuidanceProposalSchema,
  handoffGuidanceSchema,
  handoffGuidanceV2Schema,
  planRevisionGuidanceSchema,
  relayBasisV2Schema,
  relaySourceRoleSchema,
  relaySourceSchema,
  workflowRelayCandidateIdSchema,
  type HandoffGuidanceProposal,
  type HandoffGuidanceV2,
  type PlanRevisionGuidance,
  type RelaySource,
} from './index.js'

const uuid = (index = 1) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

function source(index: number, roles: RelaySource['roles']): RelaySource {
  return {
    id: `s${index}`,
    roles,
    document: { id: uuid(index + 1), sha256: 'a'.repeat(64), bytes: 5, chars: 5 },
    evaluatedSha256: 'b'.repeat(64),
  }
}

function guidance(withPlan = false): HandoffGuidanceV2 {
  return {
    version: HANDOFF_GUIDANCE_VERSION,
    evaluationId: uuid(20),
    handoffId: 'c'.repeat(64),
    inputSha256: 'd'.repeat(64),
    sourceFingerprint: 'e'.repeat(64),
    basis: {
      kind: 'workflow',
      task: { id: uuid(21), inputSequence: 0 },
      producerRunId: uuid(22),
      plan: withPlan
        ? {
            version: 1,
            sourceRunId: uuid(23),
            sourceMessageId: uuid(24),
            document: source(2, ['plan']).document,
          }
        : null,
      input: null,
    },
    candidateId: 'continue_code_review',
    sources: [
      source(0, ['task', 'input']),
      source(1, ['execution', 'review_scope']),
      ...(withPlan ? [source(2, ['plan'])] : []),
    ],
    highlights: [{ text: 'Check the complete execution evidence.', sourceIds: ['s0', 's1'] }],
  }
}

function proposal(): HandoffGuidanceProposal {
  return {
    guidance: guidance(true),
    configurationGeneration: 0,
    configurationFingerprint: 'f'.repeat(64),
    deadlineAt: Number.MAX_SAFE_INTEGER,
  }
}

function fullSources(): RelaySource[] {
  return Array.from({ length: 12 }, (_, index) => ({
    ...source(index, relaySourceRoleSchema.options),
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

function padHighlightToBytes(value: object, highlight: { text: string }, target: number): void {
  highlight.text = '中文🙂"\\\n\b\t\f\r\u0000\ud800'
  const remaining = target - bytes(value)
  expect(remaining).toBeGreaterThanOrEqual(0)
  highlight.text += 'x'.repeat(remaining)
  expect(bytes(value)).toBe(target)
}

describe('Handoff guidance versioned contracts', () => {
  it.each(workflowRelayCandidateIdSchema.options)(
    'round-trips %s without inventing a Plan for code workflows',
    (candidateId) => {
      const value = { ...guidance(), candidateId }
      expect(handoffGuidanceV2Schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
      expect(handoffGuidanceSchema.parse(value)).toEqual(value)
      expect(handoffGuidanceSchema.parse(guidance(true))).toEqual(guidance(true))
    },
  )

  it('preserves the v1 reader and historical evaluation digests without migrating its shape', () => {
    const value: PlanRevisionGuidance = {
      version: 'plan-revision-guidance-v1',
      evaluationId: uuid(20),
      handoffId: 'b'.repeat(64),
      inputSha256: 'c'.repeat(64),
      sourceFingerprint: 'd'.repeat(64),
      taskId: uuid(21),
      inputSequence: 0,
      planVersion: 1,
      candidateId: 'continue_plan_revision',
      sources: [
        { ...source(0, ['task']), roles: ['task'] },
        { ...source(1, ['plan']), roles: ['plan'] },
        { ...source(2, ['review']), roles: ['review'] },
      ],
      highlights: [{ text: 'Check the original review.', sourceIds: ['s2'] }],
    }
    const serialized = JSON.stringify(value)
    expect(JSON.stringify(handoffGuidanceSchema.parse(JSON.parse(serialized)))).toBe(serialized)
    expect(handoffGuidanceSchema.parse(value)).toEqual(planRevisionGuidanceSchema.parse(value))
    expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(false)
    expect(
      handoffGuidanceProposalSchema.safeParse({ ...proposal(), guidance: value }).success,
    ).toBe(false)
    expect(planRevisionGuidanceSchema.safeParse(guidance()).success).toBe(false)
  })

  it('accepts task-free ordinary input material but never persists it as workflow guidance', () => {
    const basis = {
      kind: 'input',
      task: null,
      producerRunId: null,
      plan: null,
      input: {
        clientMessageId: uuid(25),
        batch: { id: uuid(26), revision: 0, memberCount: 1 },
      },
    }
    expect(relayBasisV2Schema.parse(basis)).toEqual(basis)
    expect(handoffGuidanceV2Schema.safeParse({ ...guidance(), basis }).success).toBe(false)
    for (const fields of [
      { kind: 'workflow' },
      { task: { id: uuid(), inputSequence: 0 } },
      { producerRunId: uuid() },
      { plan: guidance(true).basis.plan },
      { input: null },
      { input: { ...basis.input, authority: true } },
    ])
      expect(relayBasisV2Schema.safeParse({ ...basis, ...fields }).success).toBe(false)
  })

  it('rejects forged or incomplete workflow basis and unknown versions or candidates', () => {
    const value = guidance()
    for (const fields of [
      { task: null },
      { task: { id: uuid(), inputSequence: -1 } },
      { task: { id: uuid(), inputSequence: 0.5 } },
      { task: { id: uuid(), inputSequence: 0, authorization: uuid() } },
      { producerRunId: null },
      { producerRunId: 'invalid' },
      { plan: undefined },
      { input: { clientMessageId: uuid(), batch: { id: uuid(), revision: 0, memberCount: 0 } } },
    ])
      expect(
        handoffGuidanceV2Schema.safeParse({ ...value, basis: { ...value.basis, ...fields } })
          .success,
      ).toBe(false)
    for (const fields of [
      { version: undefined },
      { version: 'handoff-guidance-v3' },
      { version: 'plan-revision-guidance-v2' },
      { candidateId: 'route_send' },
      { candidateId: 'implement' },
      { candidateId: null },
      { evaluationId: 'invalid' },
      { handoffId: uuid() },
      { inputSha256: 'invalid' },
      { sourceFingerprint: 'invalid' },
    ])
      expect(handoffGuidanceSchema.safeParse({ ...value, ...fields }).success).toBe(false)
  })

  it('requires a task role and Plan role coverage exactly when a frozen Plan exists', () => {
    const value = guidance()
    for (const sources of [[], [source(0, ['execution'])], [source(0, ['task', 'plan'])]])
      expect(handoffGuidanceV2Schema.safeParse({ ...value, sources }).success).toBe(false)
    expect(
      handoffGuidanceV2Schema.safeParse({ ...guidance(true), sources: value.sources }).success,
    ).toBe(false)
    expect(handoffGuidanceV2Schema.safeParse(guidance(true)).success).toBe(true)
  })

  it('bounds canonical source identities, provenance and the complete expanded role vocabulary', () => {
    expect(fullSources().every((entry) => relaySourceSchema.safeParse(entry).success)).toBe(true)
    const value = source(0, ['task'])
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
      { planVersion: 0 },
      { inputBatchRef: { id: uuid(), revision: -1, memberCount: 0 } },
    ])
      expect(relaySourceSchema.safeParse({ ...value, ...fields }).success).toBe(false)
    expect(
      handoffGuidanceV2Schema.safeParse({
        ...guidance(true),
        sources: [...fullSources(), source(0, ['input'])],
      }).success,
    ).toBe(false)
    expect(
      handoffGuidanceV2Schema.safeParse({
        ...guidance(),
        sources: [source(0, ['task']), source(0, ['execution'])],
      }).success,
    ).toBe(false)
  })

  it('requires one to eight grounded highlights with unique existing source identities', () => {
    const value = guidance()
    for (const highlights of [
      [],
      [{ text: '', sourceIds: ['s0'] }],
      [{ text: 'Missing reference', sourceIds: [] }],
      [{ text: 'Foreign reference', sourceIds: ['s2'] }],
      [{ text: 'Repeated reference', sourceIds: ['s0', 's0'] }],
      Array.from({ length: 9 }, () => ({ text: 'Too many highlights', sourceIds: ['s0'] })),
    ])
      expect(handoffGuidanceV2Schema.safeParse({ ...value, highlights }).success).toBe(false)
    expect(
      handoffGuidanceV2Schema.safeParse({
        ...value,
        highlights: Array.from({ length: 8 }, () => ({ text: 'Checked focus', sourceIds: ['s0'] })),
      }).success,
    ).toBe(true)
  })

  it('rejects authority and other unknown fields throughout the proposal', () => {
    const value = proposal()
    const original = value.guidance.sources[0]!
    for (const guidanceFields of [
      { runId: uuid() },
      { command: 'implement' },
      { basis: { ...value.guidance.basis, grant: uuid() } },
      {
        basis: { ...value.guidance.basis, plan: { ...value.guidance.basis.plan, approved: true } },
      },
      { sources: [{ ...original, sourceMessageId: uuid() }, ...value.guidance.sources.slice(1)] },
      { sources: [{ ...original, grant: uuid() }, ...value.guidance.sources.slice(1)] },
      {
        sources: [
          { ...original, document: { ...original.document, body: 'hidden' } },
          ...value.guidance.sources.slice(1),
        ],
      },
      {
        sources: [
          {
            ...original,
            inputBatchRef: { id: uuid(), revision: 0, memberCount: 1, grant: uuid() },
          },
          ...value.guidance.sources.slice(1),
        ],
      },
      { highlights: [{ text: 'Unknown permission', sourceIds: ['s0'], approved: true }] },
    ])
      expect(
        handoffGuidanceProposalSchema.safeParse({
          ...value,
          guidance: { ...value.guidance, ...guidanceFields },
        }).success,
      ).toBe(false)
    expect(handoffGuidanceProposalSchema.safeParse({ ...value, runId: uuid() }).success).toBe(false)
  })

  it('counts the complete escaped UTF-8 highlights at the exact 8 KiB boundary', () => {
    const value = guidance()
    padHighlightToBytes(value.highlights, value.highlights[0]!, DECISION_HIGHLIGHT_BYTES)
    expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(true)
    value.highlights[0]!.text += 'x'
    expect(bytes(value.highlights)).toBe(DECISION_HIGHLIGHT_BYTES + 1)
    expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(false)
    value.highlights[0]!.text = '🙂'.repeat(2048)
    expect(value.highlights[0]!.text.length).toBeLessThan(DECISION_HIGHLIGHT_BYTES)
    expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(false)
  })

  it.each([false, true])(
    'counts complete guidance including nullable basis at exactly 16 KiB, withPlan=%s',
    (withPlan) => {
      const value = guidance(withPlan)
      value.sources = fullSources()
      if (!withPlan)
        for (const entry of value.sources)
          entry.roles = entry.roles.filter((role) => role !== 'plan')
      padHighlightToBytes(value, value.highlights[0]!, HANDOFF_GUIDANCE_BYTES)
      expect(bytes(value.highlights)).toBeLessThanOrEqual(DECISION_HIGHLIGHT_BYTES)
      expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(true)
      value.highlights[0]!.text += 'x'
      expect(handoffGuidanceV2Schema.safeParse(value).success).toBe(false)
    },
  )

  it('bounds the complete proposal separately from its otherwise valid nested guidance', () => {
    const value = proposal()
    value.guidance.sources = fullSources()
    padHighlightToBytes(value, value.guidance.highlights[0]!, HANDOFF_GUIDANCE_BYTES)
    expect(bytes(value.guidance.highlights)).toBeLessThanOrEqual(DECISION_HIGHLIGHT_BYTES)
    expect(handoffGuidanceProposalSchema.safeParse(value).success).toBe(true)
    value.guidance.highlights[0]!.text += 'x'
    expect(bytes(value)).toBe(HANDOFF_GUIDANCE_BYTES + 1)
    expect(handoffGuidanceV2Schema.safeParse(value.guidance).success).toBe(true)
    expect(handoffGuidanceProposalSchema.safeParse(value).success).toBe(false)
  })

  it('requires finite nonnegative safe integer freshness scalars', () => {
    const value = proposal()
    for (const fields of [
      { configurationGeneration: -1 },
      { configurationGeneration: 0.5 },
      { configurationGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { configurationFingerprint: 'unknown' },
      { deadlineAt: -1 },
      { deadlineAt: 0.5 },
      { deadlineAt: Number.MAX_SAFE_INTEGER + 1 },
      { deadlineAt: Number.POSITIVE_INFINITY },
    ])
      expect(handoffGuidanceProposalSchema.safeParse({ ...value, ...fields }).success).toBe(false)
  })
})
