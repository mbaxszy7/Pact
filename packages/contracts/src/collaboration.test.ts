const randomUUID = () => crypto.randomUUID()
import { describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  bindCollaborationQuestions,
  collaborationAvailableActions,
  collaborationContinuationLimit,
  collaborationDecisionQuestionsSchema,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationInputResultSchema,
  collaborationNextStage,
  collaborationPlanAccepted,
  collaborationQuestionsSchema,
  collaborationReviewInputSchema,
  collaborationSourceReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceWireReadSchema,
  collaborationSourceWireResultSchema,
  collaborationSourceReadResultSchema,
  collaborationTaskSchema,
  collaborationViewSchema,
  collaborationMarkdownPageSchema,
  type CollaborationTask,
} from './collaboration.js'

const limits = { maxDiscussionRounds: 3, maxReviewCycles: 2, maxRepairAttempts: 2 }
const document = () => ({ id: randomUUID(), sha256: 'a'.repeat(64), bytes: 5, chars: 5 })
const plan = () => ({
  version: 1,
  sourceRunId: randomUUID(),
  sourceMessageId: randomUUID(),
  document: document(),
})
function task(fields: Partial<CollaborationTask> = {}): CollaborationTask {
  return collaborationTaskSchema.parse({
    protocol: 'native-workflow-v1',
    id: randomUUID(),
    sessionId: randomUUID(),
    kind: 'plan',
    revision: 0,
    owner: 'codex',
    reviewer: 'claude',
    task: 'Implement safe cancellation',
    taskMessageId: randomUUID(),
    stage: 'plan',
    actor: 'codex',
    status: 'waiting',
    automation: 'active',
    runId: randomUUID(),
    inputSequence: 0,
    handledInputSequence: 0,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
    ...fields,
  })
}
function accepted(): CollaborationTask {
  const ref = plan()
  return task({
    planVersion: 1,
    planReference: ref,
    planInputSequence: 0,
    review: {
      runId: randomUUID(),
      actor: 'claude',
      stage: 'plan_review',
      verdict: 'accepted',
      inputSequence: 0,
      planReference: ref,
      document: document(),
    },
    status: 'ready',
  })
}

describe('native workflow authorization and progression', () => {
  it.each(['plan_review', 'code_review', 'repair'] as const)(
    'projects the same %s limit that prevents a new stage and preserves consumed counts',
    (stage) => {
      const current =
        stage === 'plan_review'
          ? task({
              planReference: plan(),
              planInputSequence: 0,
              planVersion: 1,
              discussionRounds: limits.maxDiscussionRounds,
            })
          : task({
              kind: 'build',
              nextStage: stage,
              reviewCycles: limits.maxReviewCycles,
              repairAttempts: limits.maxRepairAttempts,
              ...(stage === 'repair'
                ? {
                    pendingWork: {
                      stage: 'repair' as const,
                      runId: randomUUID(),
                      inputSequence: 0,
                      repairReservationReleased: true,
                    },
                  }
                : {}),
            })
      current.automation = 'paused'
      current.pauseReason = 'limit'
      const original = structuredClone(current)
      expect(collaborationContinuationLimit(current, limits)).toMatchObject({ stage })
      const resumed = advanceCollaboration(current, 'resume', limits)
      expect(() => advanceCollaboration(resumed, 'continue', limits)).toThrow(/limit/)
      const raised = {
        ...limits,
        ...(stage === 'plan_review'
          ? { maxDiscussionRounds: limits.maxDiscussionRounds + 1 }
          : stage === 'code_review'
            ? { maxReviewCycles: limits.maxReviewCycles + 1 }
            : { maxRepairAttempts: limits.maxRepairAttempts + 1 }),
      }
      expect(collaborationContinuationLimit(current, raised)).toBeUndefined()
      expect(
        advanceCollaboration(advanceCollaboration(current, 'resume', raised), 'continue', raised),
      ).toMatchObject({ stage, status: 'running' })
      expect(current).toEqual(original)
    },
  )
  it('does not block an already reserved repair or active work at the repair limit', () => {
    const current = task({
      kind: 'build',
      repairAttempts: limits.maxRepairAttempts,
      automation: 'paused',
      pauseReason: 'limit',
      pendingWork: { stage: 'repair', runId: randomUUID(), inputSequence: 0 },
    })
    expect(collaborationContinuationLimit(current, limits)).toBeUndefined()
    const resumed = advanceCollaboration(current, 'resume', limits)
    const next = advanceCollaboration(resumed, 'continue', limits)
    expect(next.repairAttempts).toBe(limits.maxRepairAttempts)
    expect(collaborationContinuationLimit(next, limits)).toBeUndefined()
  })
  it('keeps planning and review read-only until explicit execution', () => {
    expect(collaborationNextStage(task())).toBe('plan')
    const planned = task({ planReference: plan(), planInputSequence: 0, planVersion: 1 })
    const review = advanceCollaboration(planned, 'continue', limits)
    expect(review).toMatchObject({
      stage: 'plan_review',
      actor: 'claude',
      discussionRounds: 1,
      status: 'running',
    })
    expect(planned.discussionRounds).toBe(0)
    expect(() => advanceCollaboration(planned, 'execute', limits)).toThrow(/not been accepted/)
    const ready = accepted()
    expect(collaborationAvailableActions(ready)).toEqual(['execute', 'pause'])
    expect(collaborationNextStage(ready)).toBeUndefined()
    expect(() => advanceCollaboration(ready, 'continue', limits)).toThrow(/no next/)
    expect(advanceCollaboration(ready, 'execute', limits)).toMatchObject({
      stage: 'implement',
      actor: 'codex',
    })
  })
  it('requires exact plan, reviewer, input basis and a cleared input gate', () => {
    const ready = accepted()
    expect(collaborationPlanAccepted(ready)).toBe(true)
    for (const changed of [
      { inputSequence: 1 },
      { planInputSequence: 1 },
      { review: { ...ready.review!, actor: 'codex' as const } },
      { review: { ...ready.review!, verdict: 'changes_requested' as const } },
      { planReference: { ...ready.planReference!, version: 2 } },
      {
        planReference: {
          ...ready.planReference!,
          document: { ...ready.planReference!.document, sha256: 'b'.repeat(64) },
        },
      },
      { inputProcessing: { decision: { runId: randomUUID(), inputSequence: 0 } } },
    ])
      expect(collaborationPlanAccepted({ ...ready, ...changed })).toBe(false)
  })
  it('resumes paused facts without dispatching a write or consuming another reservation', () => {
    const ready = accepted(),
      paused = advanceCollaboration(ready, 'pause', limits)
    expect(paused).toMatchObject({ automation: 'paused', pauseReason: 'user', revision: 1 })
    expect(() => advanceCollaboration(paused, 'execute', limits)).toThrow(/Continue collaboration/)
    expect(advanceCollaboration(paused, 'resume', limits)).toMatchObject({
      status: 'ready',
      automation: 'active',
      stage: 'plan',
      discussionRounds: 0,
    })
    expect(() => advanceCollaboration(ready, 'recover_plan', limits)).toThrow(/original source/)
  })
  it('requires an explicit repair action for current code review findings', () => {
    const current = task({
      kind: 'build',
      stage: 'code_review',
      review: {
        runId: randomUUID(),
        actor: 'claude',
        stage: 'code_review',
        verdict: 'changes_requested',
        inputSequence: 0,
        document: document(),
      },
    })
    expect(collaborationAvailableActions(current)).toEqual(['respond', 'repair', 'pause'])
    expect(advanceCollaboration(current, 'respond', limits)).toMatchObject({
      stage: 'respond',
      actor: 'codex',
      repairAttempts: 0,
    })
    expect(advanceCollaboration(current, 'repair', limits)).toMatchObject({
      stage: 'repair',
      actor: 'codex',
      repairAttempts: 1,
    })
    expect(() => advanceCollaboration({ ...current, inputSequence: 1 }, 'repair', limits)).toThrow(
      /no current/,
    )
    expect(() =>
      advanceCollaboration(
        { ...current, nextStage: 'repair', review: undefined },
        'continue',
        limits,
      ),
    ).toThrow(/explicit authorization/)
  })
  it.each(['plan_review', 'code_review', 'repair'] as const)(
    'enforces the %s reservation budget',
    (stage) => {
      const ready = accepted()
      const base =
        stage === 'plan_review'
          ? { ...ready, review: undefined, discussionRounds: 3 }
          : task({
              kind: 'build',
              nextStage: stage,
              reviewCycles: 2,
              repairAttempts: 2,
              review: {
                runId: randomUUID(),
                actor: 'claude',
                stage: 'code_review',
                verdict: 'changes_requested',
                inputSequence: 0,
                document: document(),
              },
            })
      expect(() =>
        advanceCollaboration(base, stage === 'repair' ? 'repair' : 'continue', limits),
      ).toThrow(/limit/)
    },
  )
  it('retains authorized interrupted work and re-reserves only proven-unsent repairs', () => {
    const pending = task({
      kind: 'build',
      repairAttempts: 1,
      pendingWork: { stage: 'repair', runId: randomUUID(), inputSequence: 0 },
    })
    expect(advanceCollaboration(pending, 'continue', limits)).toMatchObject({
      stage: 'repair',
      repairAttempts: 1,
    })
    expect(
      advanceCollaboration(
        { ...pending, pendingWork: { ...pending.pendingWork!, repairReservationReleased: true } },
        'continue',
        limits,
      ).repairAttempts,
    ).toBe(2)
    expect(collaborationAvailableActions(task({ status: 'complete' }))).toEqual([])
    expect(() => advanceCollaboration(task({ status: 'complete' }), 'resume', limits)).toThrow(
      /already complete/,
    )
  })
})

describe('question and input processing boundaries', () => {
  const questions = [
    {
      prompt: 'Which scope?',
      selection: 'single' as const,
      options: [{ label: 'Current' }, { label: 'All' }],
    },
  ]
  it('requires explicit bounded questions only for needs_user', () => {
    expect(
      collaborationReviewInputSchema.parse({ verdict: 'needs_user', questions }).questions,
    ).toEqual(questions)
    expect(
      collaborationInputResultSchema.parse({ outcome: 'needs_user', questions }).questions,
    ).toEqual(questions)
    for (const value of [{ verdict: 'needs_user' }, { verdict: 'accepted', questions }])
      expect(collaborationReviewInputSchema.safeParse(value).success).toBe(false)
    for (const value of [
      { outcome: 'needs_user' },
      { outcome: 'processed', questions },
      { outcome: 'incomplete' },
    ])
      expect(collaborationInputResultSchema.safeParse(value).success).toBe(false)
    for (const value of [
      [],
      Array(4).fill(questions[0]),
      [{ ...questions[0], options: [{ label: 'Only' }] }],
      [{ ...questions[0], prompt: 'x'.repeat(2049) }],
      Array.from({ length: 3 }, () => ({ ...questions[0], prompt: '界'.repeat(2000) })),
    ])
      expect(collaborationQuestionsSchema.safeParse(value).success).toBe(false)
  })
  it('binds ordered host identities and rejects reordered question or option identities', () => {
    const bound = bindCollaborationQuestions(questions)!
    expect(bound).toEqual([
      {
        ...questions[0],
        id: 'q1',
        options: [
          { id: 'o1', label: 'Current' },
          { id: 'o2', label: 'All' },
        ],
      },
    ])
    expect(collaborationDecisionQuestionsSchema.safeParse(bound).success).toBe(true)
    expect(
      collaborationDecisionQuestionsSchema.safeParse([{ ...bound[0], id: 'q2' }]).success,
    ).toBe(false)
    expect(
      collaborationDecisionQuestionsSchema.safeParse([
        { ...bound[0], options: bound[0]!.options!.toReversed() },
      ]).success,
    ).toBe(false)
  })
  it.each(['needs_reply', 'queued', 'processing', 'incomplete'] as const)(
    'blocks all progression while input is %s',
    (gate) => {
      const current = task({
        automation: 'paused',
        status: gate === 'processing' ? 'running' : gate === 'incomplete' ? 'failed' : 'waiting',
        stage: gate === 'processing' ? 'reply' : 'plan',
        inputProcessing:
          gate === 'needs_reply'
            ? { decision: { runId: randomUUID(), inputSequence: 0 } }
            : { pending: { inputId: randomUUID(), inputSequence: 1 } },
      })
      expect(collaborationInputGate(current)).toBe(gate)
      expect(collaborationNextStage(current)).toBeUndefined()
      expect(collaborationAvailableActions(current)).toEqual([])
      for (const action of ['resume', 'continue', 'execute', 'repair', 'retry'] as const)
        expect(() => advanceCollaboration(current, action, limits)).toThrow(
          /Reply to the questions/,
        )
    },
  )
  it('preserves legacy unresolved decisions until processed and respects explicit cleared state', () => {
    const old = task({ status: 'questions', sourceMessageId: randomUUID() })
    expect(collaborationInputProcessing(old).decision).toMatchObject({
      runId: old.runId,
      messageId: old.sourceMessageId,
    })
    expect(collaborationInputGate({ ...old, inputProcessing: {} })).toBeUndefined()
    const reply = task({ stage: 'reply', status: 'failed', inputSequence: 1 })
    expect(collaborationInputProcessing(reply).pending).toEqual({
      inputId: reply.taskMessageId,
      inputSequence: 1,
    })
  })
})

describe('bounded source transport without full document truncation', () => {
  it('requires host grants and rejects oversize physical source/view pages', () => {
    const request = { runId: randomUUID(), grant: randomUUID(), document: document(), offset: 0 }
    expect(collaborationSourceReadSchema.parse(request).source).toBe('document')
    expect(collaborationSourceReadSchema.safeParse({ ...request, grant: undefined }).success).toBe(
      false,
    )
    expect(
      collaborationSourceReadResultSchema.safeParse({
        source: 'document',
        text: '界'.repeat(20000),
        offset: 0,
        nextOffset: null,
      }).success,
    ).toBe(false)
    expect(
      collaborationViewSchema.safeParse({ task: task({ task: 'x'.repeat(50000) }) }).success,
    ).toBe(false)
    expect(collaborationTaskSchema.parse(task({ task: 'x'.repeat(50000) })).task.length).toBe(50000)
  })
  it('rejects unsafe or overdeep Markdown trees while allowing ordinary content', () => {
    const page = {
      ordinal: 0,
      visibleStart: 0,
      visibleEnd: 4,
      visibleText: 'text',
      tree: { type: 'root', children: [{ type: 'text', value: 'text' }] },
    }
    expect(collaborationMarkdownPageSchema.safeParse(page).success).toBe(true)
    expect(
      collaborationMarkdownPageSchema.safeParse({
        ...page,
        tree: { type: 'element', tagName: 'script' },
      }).success,
    ).toBe(false)
    expect(
      collaborationMarkdownPageSchema.safeParse({
        ...page,
        tree: { type: 'element', tagName: 'p', properties: { onclick: 'bad' } },
      }).success,
    ).toBe(false)
    expect(
      collaborationMarkdownPageSchema.safeParse({
        ...page,
        tree: {
          type: 'root',
          children: Array.from({ length: 513 }, () => ({ type: 'text', value: 'a' })),
        },
      }).success,
    ).toBe(false)
  })
})

describe('failed reply settlement identity', () => {
  it.each(['missing', 'wrong-run', 'old-input'] as const)(
    'requires positive exact settlement for %s evidence',
    (kind) => {
      const current = task({
        stage: 'reply',
        status: 'failed',
        automation: 'paused',
        inputSequence: 2,
        inputProcessing: {},
      })
      if (kind !== 'missing')
        current.inputProcessing = {
          settled: {
            runId: kind === 'wrong-run' ? randomUUID() : current.runId,
            inputSequence: kind === 'old-input' ? 1 : 2,
          },
        }
      expect(collaborationInputGate(current)).toBe('incomplete')
      {
        expect(collaborationAvailableActions(current)).toEqual([])
        for (const action of ['resume', 'continue', 'execute', 'retry'] as const)
          expect(() => advanceCollaboration(current, action, limits)).toThrow(/Reply/)
      }
    },
  )
})

it('allows a failed reply gate to clear only for its exact settled run and input', () => {
  const current = task({ stage: 'reply', status: 'failed', automation: 'paused', inputSequence: 2 })
  current.inputProcessing = { settled: { runId: current.runId, inputSequence: 2 } }
  expect(collaborationInputGate(current)).toBeUndefined()
})

it('native source selection is explicit and cannot carry model-supplied caller authority', () => {
  const request = { context: 'native-root-v1', source: 'batch', batchId: randomUUID(), offset: 0 }
  expect(collaborationSourceNativeReadSchema.safeParse(request).success).toBe(true)
  expect(collaborationSourceWireReadSchema.safeParse(request).success).toBe(false)
  for (const extra of [
    { runId: randomUUID() },
    { grant: randomUUID() },
    { sourceReference: 'p1.private' },
    { _meta: { threadId: 'forged' } },
  ])
    expect(collaborationSourceNativeReadSchema.safeParse({ ...request, ...extra }).success).toBe(
      false,
    )
  expect(
    collaborationSourceNativeReadSchema.safeParse({ ...request, source: undefined }).success,
  ).toBe(false)
  const page = {
    source: 'batch',
    text: '{}',
    offset: 0,
    nextOffset: null,
    binding: {
      submitted: 'nativeRoot',
      callerRunId: randomUUID(),
      grantSha256: 'a'.repeat(64),
      referenceSha256: null,
    },
  }
  expect(collaborationSourceWireResultSchema.safeParse(page).success).toBe(false)
  const bound = {
    ...page,
    binding: { ...page.binding, nativeRoot: { threadId: 'thread', turnId: 'turn' } },
  }
  expect(collaborationSourceWireResultSchema.safeParse(bound).success).toBe(true)
  expect(
    collaborationSourceWireResultSchema.safeParse({
      ...bound,
      binding: { ...bound.binding, submitted: 'legacy' },
    }).success,
  ).toBe(false)
})

it('native root_batch is an exclusive transport-bound original-input selection', () => {
  const request = { context: 'native-root-v1', source: 'root_batch', offset: 0 }
  expect(collaborationSourceNativeReadSchema.parse(request)).toEqual(request)
  expect(collaborationSourceWireReadSchema.safeParse(request).success).toBe(false)
  expect(
    collaborationSourceReadSchema.safeParse({
      ...request,
      runId: randomUUID(),
      grant: randomUUID(),
    }).success,
  ).toBe(false)
  for (const extra of [
    { batchId: randomUUID() },
    { document: { id: randomUUID(), sha256: 'a'.repeat(64), bytes: 1, chars: 1 } },
    { runId: randomUUID() },
    { grant: randomUUID() },
    { sourceReference: 'p1.invalid' },
  ])
    expect(collaborationSourceNativeReadSchema.safeParse({ ...request, ...extra }).success).toBe(
      false,
    )
})
