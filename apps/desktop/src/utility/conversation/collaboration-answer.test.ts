import { describe, expect, it } from 'vitest'

import {
  mergeWorkflowInput,
  mergeWorkflowReview,
  projectCollaborationAnswer,
  readWorkflowReview,
} from './collaboration-answer'

const questions = [
  {
    prompt: 'Which scope?',
    selection: 'single' as const,
    options: [{ label: 'Local' }, { label: 'Shared' }],
  },
]

describe('Native workflow answer and metadata', () => {
  it('preserves complete natural text in order, including JSON-looking prose and long plans', () => {
    const plan = '完整计划\n'.repeat(10000)
    const json = '{"version":"pact-collaboration-envelope-v5","answer":"literal"}'
    expect(
      projectCollaborationAnswer([
        { id: 'empty', text: '' },
        { id: 'note', text: 'Checked source.', phase: 'commentary' },
        { id: 'plan', text: plan },
        { id: 'final', text: json, phase: 'final_answer' },
      ]),
    ).toBe(`Checked source.\n\n${plan}\n\n${json}`)
  })
  it('validates review metadata without extracting authority from prose', () => {
    expect(readWorkflowReview({ verdict: 'accepted' })).toEqual({ verdict: 'accepted' })
    expect(readWorkflowReview({ verdict: 'needs_user', questions })).toEqual({
      verdict: 'needs_user',
      questions,
    })
    expect(readWorkflowReview({ verdict: 'accepted', questions })).toBeUndefined()
    expect(readWorkflowReview({ verdict: 'needs_user' })).toBeUndefined()
    expect(readWorkflowReview({ verdict: 'accepted', runId: 'model-selected' })).toBeUndefined()
    expect(readWorkflowReview('accepted')).toBeUndefined()
  })
  it('accepts duplicate review receipts but makes conflicting verdicts or questions permanently incomplete', () => {
    const value = { verdict: 'needs_user' as const, questions }
    expect(mergeWorkflowReview(undefined, value)).toEqual(value)
    expect(mergeWorkflowReview(value, structuredClone(value))).toEqual(value)
    const conflict = mergeWorkflowReview(value, {
      ...value,
      questions: [{ ...questions[0]!, prompt: 'Other scope?' }],
    })
    expect(conflict).toEqual({ verdict: 'incomplete' })
    expect(mergeWorkflowReview(conflict, { verdict: 'accepted' })).toEqual({
      verdict: 'incomplete',
    })
  })
  it('does not let a later successful input receipt erase contradictory processing evidence', () => {
    const value = { outcome: 'needs_user' as const, questions }
    expect(mergeWorkflowInput(undefined, value)).toEqual(value)
    expect(mergeWorkflowInput(value, structuredClone(value))).toEqual(value)
    const conflict = mergeWorkflowInput(value, { outcome: 'processed' })
    expect(conflict).toEqual({ outcome: 'incomplete' })
    expect(mergeWorkflowInput(conflict, { outcome: 'processed' })).toEqual({
      outcome: 'incomplete',
    })
  })
})
