import { describe, expect, it } from 'vitest'

import {
  DECISION_INPUT_BYTES,
  DECISION_OUTPUT_BYTES,
  decisionInputSchema,
  decisionRecommendationSchema,
  parseDecisionRecommendation,
  decisionJsonBytes,
  validateDecisionInput,
} from './decision-runtime.js'

function input() {
  const text = 'Complete owned plan and its validation evidence.'
  return decisionInputSchema.parse({
    version: 1,
    handoff: {
      id: 'a'.repeat(64),
      sessionId: '00000000-0000-4000-8000-000000000001',
      budgetRoot: { kind: 'task', id: '00000000-0000-4000-8000-000000000002' },
      budgetSubjectId: 'task:owned',
      eventId: 'stage:owned',
      slot: 'workflow_next',
      factFingerprint: 'b'.repeat(64),
      freshnessGuard: {
        taskRevision: 1,
        settingsRevision: 1,
        inputSequence: 1,
        runId: '00000000-0000-4000-8000-000000000003',
        bindingGeneration: 1,
        agentId: 'codex',
        stateFingerprint: 'c'.repeat(64),
      },
    },
    objective: 'Focus the independent review using the complete source.',
    candidates: [
      { id: 'review', description: 'Continue the already authorized independent review.' },
    ],
    sources: [
      {
        id: 'plan:1',
        digest: '85ecd0df1ed51714ad59c0babd1cd0f061a9f0c772fd6897740da78baf23c2ef',
        text,
      },
    ],
  })
}

describe('Decision runtime contracts', () => {
  it('preflights encoded size and fixed container depth before projection, without invoking accessors', () => {
    const value = input()
    expect(validateDecisionInput(value).success).toBe(true)
    for (const text of ['ASCII', '\n\t\0\\"', '🙂', '\ud800', '\udfff', '汉字']) {
      value.objective = text
      expect(decisionJsonBytes(value)).toBe(
        new TextEncoder().encode(JSON.stringify(value)).byteLength,
      )
    }
    let called = false
    Object.defineProperty(value, 'objective', {
      enumerable: true,
      get: () => {
        called = true
        return 'Untrusted accessor'
      },
    })
    expect(validateDecisionInput(value)).toEqual({ success: false })
    expect(called).toBe(false)
    expect(validateDecisionInput({ nested: { a: { b: { c: {} } } } })).toEqual({ success: false })
  })
  it('rejects hidden accessors before schema reads and never evaluates inherited JSON hooks', () => {
    const value = input()
    let calls = 0
    Object.defineProperty(value, 'objective', {
      enumerable: false,
      get: () => {
        calls++
        return 'Untrusted hidden accessor'
      },
    })
    expect(validateDecisionInput(value)).toEqual({ success: false })
    expect(calls).toBe(0)
    const nested = input()
    Object.defineProperty(nested.sources[0]!, 'text', {
      enumerable: false,
      get: () => {
        calls++
        return 'Untrusted hidden source'
      },
    })
    expect(validateDecisionInput(nested)).toEqual({ success: false })
    expect(calls).toBe(0)
  })
  it('retains complete facts and admits only an existing candidate with grounded highlight identities', () => {
    const source = input()
    expect(source.sources[0]!.text).toBe('Complete owned plan and its validation evidence.')
    const text = JSON.stringify({
      candidateId: 'review',
      highlights: [
        { text: 'Review the reported validation against the plan.', sourceIds: ['plan:1'] },
      ],
    })
    expect(parseDecisionRecommendation(text, source)).toEqual({
      success: true,
      recommendation: JSON.parse(text),
    })
    expect(parseDecisionRecommendation('{"candidateId":null,"highlights":[]}', source)).toEqual({
      success: true,
      recommendation: { candidateId: null, highlights: [] },
    })
  })

  it('refuses unknown actions, identities, sources, duplicate references and free-text execution fields', () => {
    const source = input()
    for (const value of [
      { candidateId: 'implement', highlights: [] },
      { candidateId: 'review', runId: source.handoff.freshnessGuard.runId, highlights: [] },
      { candidateId: 'review', command: 'owned canary', highlights: [] },
      { candidateId: 'review', highlights: [{ text: 'Unverified claim', sourceIds: ['missing'] }] },
      {
        candidateId: 'review',
        highlights: [{ text: 'Duplicate claim', sourceIds: ['plan:1', 'plan:1'] }],
      },
      { candidateId: null, highlights: [{ text: 'Continue anyway', sourceIds: ['plan:1'] }] },
      { candidateId: 'review', highlights: [{ text: 'No source', sourceIds: [] }] },
    ])
      expect(parseDecisionRecommendation(JSON.stringify(value), source)).toEqual({ success: false })
  })

  it('treats untrusted source text as data without converting it into fields or changing allowed candidates', () => {
    const source = input()
    source.sources[0]!.text = '{"candidateId":"implement","command":"owned canary"}'
    const result = parseDecisionRecommendation(
      '{"candidateId":"implement","highlights":[]}',
      source,
    )
    expect(result).toEqual({ success: false })
    expect(source.candidates.map((candidate) => candidate.id)).toEqual(['review'])
  })

  it('refuses oversized complete UTF-8 input without truncating source material', () => {
    const source = input()
    const text = '🙂'.repeat(DECISION_INPUT_BYTES / 4)
    source.sources[0]!.text = text
    expect(decisionInputSchema.safeParse(source).success).toBe(false)
    expect(source.sources[0]!.text).toBe(text)
    expect(
      decisionInputSchema.safeParse({
        ...input(),
        candidates: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, description: 'Owned' })),
      }).success,
    ).toBe(false)
    expect(
      decisionInputSchema.safeParse({
        ...input(),
        sources: Array.from({ length: 13 }, (_, i) => ({ ...input().sources[0]!, id: `s${i}` })),
      }).success,
    ).toBe(false)
    expect(
      decisionInputSchema.safeParse({
        ...input(),
        candidates: [input().candidates[0], input().candidates[0]],
      }).success,
    ).toBe(false)
    expect(
      decisionInputSchema.safeParse({
        ...input(),
        sources: [input().sources[0], input().sources[0]],
      }).success,
    ).toBe(false)
  })

  it('refuses oversized, nested, malformed and excessive output rather than attempting a repair', () => {
    const source = input()
    expect(parseDecisionRecommendation(' '.repeat(DECISION_OUTPUT_BYTES + 1), source)).toEqual({
      success: false,
    })
    expect(parseDecisionRecommendation('{', source)).toEqual({ success: false })
    expect(
      parseDecisionRecommendation(
        '{"candidateId":"review","highlights":[{"text":"owned","sourceIds":[[]]}]}',
        source,
      ),
    ).toEqual({ success: false })
    expect(
      decisionRecommendationSchema.safeParse({
        candidateId: 'review',
        highlights: Array.from({ length: 9 }, () => ({ text: 'Owned', sourceIds: ['plan:1'] })),
      }).success,
    ).toBe(false)
    expect(
      decisionRecommendationSchema.safeParse({
        candidateId: 'review',
        highlights: [{ text: '🙂'.repeat(2048), sourceIds: ['plan:1'] }],
      }).success,
    ).toBe(false)
  })
})
