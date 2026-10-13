import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { collaborationTaskSchema } from '@pact/contracts'

import {
  collaborationResultEvent,
  projectCollaborationAnswer,
  readCollaborationAnswer,
  readSubmittedCollaborationReport,
} from './collaboration-answer'
import { opinionDelta } from './collaboration-fixture.test-support'

const envelope = () => ({
  version: 'pact-collaboration-envelope-v5',
  answer: 'The natural argument.',
  result: {
    submission: 'plan_submission',
    outcome: 'complete',
    summary: 'Inspected.',
    plan: '1. Preserve cancellation ownership.\n2. Verify restart.',
    reviewedPlan: null,
    verdict: null,
    reviewScopeRef: null,
    todoDeltas: [opinionDelta('owner')],
    inputResponses: [],
  },
})
const task = collaborationTaskSchema.parse({
  id: '003b4d7b-47b5-4d7f-9820-5066e0b889ff',
  sessionId: '6a4b8f8b-de86-47ec-b4ae-bdc59cf31e1b',
  taskMessageId: '37874366-cdbe-4252-bbef-24774f052f12',
  runId: '8df1de3f-595d-4c77-af5c-21f86158eb41',
  task: 'Inspect ownership',
  kind: 'plan',
  revision: 0,
  primary: 'codex',
  drafter: 'codex',
  implementer: 'claude',
  reviewer: 'codex',
  actor: 'codex',
  stage: 'draft',
  status: 'running',
  planVersion: 0,
  discussionRounds: 0,
  discussionHalf: false,
  reviewCycles: 0,
  repairAttempts: 0,
  rereview: false,
  nextCycle: false,
})

describe('Formal collaboration carrier and natural answer separation', () => {
  it('normalizes native null fields without changing natural answer bytes', () => {
    const source = envelope(),
      answer = readCollaborationAnswer(source)!
    expect(answer).toBe(source.answer)
    expect(createHash('sha256').update(answer).digest('hex')).toBe(
      createHash('sha256').update(source.answer).digest('hex'),
    )
    expect(readSubmittedCollaborationReport(source, 'collaboration_envelope_v5')).toMatchObject({
      submission: 'plan_submission',
      reviewedPlan: undefined,
      verdict: undefined,
      reviewScopeRef: undefined,
      todoDeltas: [opinionDelta('owner')],
    })
  })
  it('keeps invalid formal material private while reporting the failed submission', () => {
    const source = { ...envelope(), result: { ...envelope().result, submission: 'wrong' } }
    expect(readCollaborationAnswer(source)).toBe(source.answer)
    expect(readSubmittedCollaborationReport(source, 'collaboration_envelope_v5')).toBeUndefined()
    expect(collaborationResultEvent(source, task, 'turn')).toMatchObject({
      type: 'collaboration.result_incomplete',
      reason: 'invalid',
    })
    expect(
      projectCollaborationAnswer(
        [{ id: 'final', text: JSON.stringify(source) }],
        'collaboration_envelope_v5',
      ),
    ).toBe(source.answer)
  })
  it('uses only the root final carrier and keeps ordinary commentary as the missing-result fallback', () => {
    const source = envelope()
    expect(
      projectCollaborationAnswer(
        [
          { id: 'note', text: 'I checked the source.', phase: 'commentary' },
          { id: 'final', text: JSON.stringify(source), phase: 'final_answer' },
        ],
        'collaboration_envelope_v5',
      ),
    ).toBe(source.answer)
    expect(
      projectCollaborationAnswer(
        [
          { id: 'note', text: 'Investigation stopped.', phase: 'commentary' },
          { id: 'final', text: JSON.stringify({ version: source.version, result: source.result }) },
        ],
        'collaboration_envelope_v5',
      ),
    ).toBe('Investigation stopped.')
    expect(
      projectCollaborationAnswer(
        [{ id: 'final', text: JSON.stringify(source) }],
        'collaboration_envelope_v5',
        null,
      ),
    ).toBe('')
  })
  it('accepts a complete report beyond former aggregate, plan and opinion-count gates', () => {
    const source = envelope()
    source.result.plan = '完整计划\n'.repeat(10_000)
    source.result.todoDeltas = Array.from({ length: 40 }, (_, index) =>
      opinionDelta(`opinion-${index}`, {
        detail: 'Complete checked evidence. '.repeat(200),
      }),
    )
    const result = readSubmittedCollaborationReport(source, 'collaboration_envelope_v5')!
    expect(result.plan).toBe(source.result.plan)
    expect(result.todoDeltas).toHaveLength(40)
    expect(readCollaborationAnswer(source)).toBe(source.answer)
  })
  it('rejects obsolete v4 submissions while preserving their natural answer bytes', () => {
    const source = { ...envelope(), version: 'pact-collaboration-envelope-v4' }
    expect(readSubmittedCollaborationReport(source, 'collaboration_envelope_v5')).toBeUndefined()
    expect(collaborationResultEvent(source, task, 'turn')).toMatchObject({
      type: 'collaboration.result_incomplete',
      reason: 'invalid',
    })
    expect(readCollaborationAnswer(source)).toBe(source.answer)
  })
})
