const randomUUID = () => crypto.randomUUID()
import { describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  collaborationActor,
  collaborationActionBasisSchema,
  collaborationActionInputSchema,
  bindCollaborationQuestions,
  collaborationAvailableActions,
  collaborationContinuationLimit,
  collaborationDecisionQuestionsSchema,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationInputResultSchema,
  collaborationNextStage,
  collaborationPlanAccepted,
  collaborationPlanRetentionAllowed,
  collaborationPlanRetentionInputSchema,
  collaborationPlanMode,
  collaborationQuestionsSchema,
  collaborationReviewInputSchema,
  CollaborationTransitionError,
  deriveCollaborationDecision,
  settleCollaborationStage,
  collaborationSourceReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceWireReadSchema,
  collaborationSourceWireResultSchema,
  collaborationSourceReadResultSchema,
  collaborationTaskSchema,
  defaultTaskStageRoles,
  initialTaskRoleCandidates,
  initialTaskRoleCandidateSchema,
  initialTaskRoleCandidateIdSchema,
  taskStageRolesSchema,
  collaborationInitialStage,
  collaborationViewSchema,
  collaborationMarkdownPageSchema,
  type CollaborationStageSettlement,
  type CollaborationTask,
  type CollaborationTransitionReason,
  type CollaborationTurnAuthorization,
} from './collaboration.js'

const limits = { maxDiscussionRounds: 3, maxReviewCycles: 2, maxRepairAttempts: 2 }
const document = () => ({ id: randomUUID(), sha256: 'a'.repeat(64), bytes: 5, chars: 5 })
const plan = () => ({
  version: 1,
  sourceRunId: randomUUID(),
  sourceMessageId: randomUUID(),
  document: document(),
})

it.each(['codex', 'claude'] as const)(
  'only the frozen %s owner may retain an existing plan',
  (owner) => {
    const current = task({
      owner,
      actor: owner,
      reviewer: owner === 'codex' ? 'claude' : 'codex',
      stage: 'reply',
      planReference: plan(),
      planVersion: 1,
    })
    current.authorization = {
      runId: current.runId,
      taskId: current.id,
      taskRevision: current.revision,
      stage: 'reply',
      actor: owner,
      inputSequence: current.inputSequence,
      planReference: current.planReference,
    }
    expect(collaborationPlanRetentionAllowed(current)).toBe(true)
    expect(collaborationPlanRetentionAllowed({ ...current, authorization: undefined })).toBe(false)
    expect(
      collaborationPlanRetentionAllowed(current, {
        ...current.authorization,
        planReference: undefined,
      }),
    ).toBe(false)
    expect(
      collaborationPlanRetentionAllowed(current, {
        ...current.authorization,
        actor: current.reviewer,
      }),
    ).toBe(false)
    expect(
      collaborationPlanRetentionAllowed(current, {
        ...current.authorization,
        inputSequence: current.inputSequence + 1,
      }),
    ).toBe(false)
    expect(
      collaborationPlanRetentionAllowed(current, { ...current.authorization, runId: randomUUID() }),
    ).toBe(false)
    expect(
      collaborationPlanRetentionAllowed(
        { ...current, stage: 'code_review' },
        { ...current.authorization, stage: 'code_review' },
      ),
    ).toBe(false)
  },
)

it('retention accepts only an empty intent and no model-selected plan identity', () => {
  expect(collaborationPlanRetentionInputSchema.safeParse({}).success).toBe(true)
  for (const value of [
    null,
    [],
    { planId: randomUUID() },
    { version: 1 },
    { sha256: 'a'.repeat(64) },
    { processed: true },
  ])
    expect(collaborationPlanRetentionInputSchema.safeParse(value).success).toBe(false)
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
function interruptedPlanImplementation() {
  const current = accepted()
  const replyRunId = randomUUID()
  Object.assign(current, {
    rolePolicy: 'split-stages-v1',
    stage: 'reply',
    actor: 'claude',
    status: 'waiting',
    automation: 'paused',
    pauseReason: 'stopped',
    runId: replyRunId,
    inputSequence: 2,
    handledInputSequence: 2,
    inputProcessing: { settled: { runId: replyRunId, inputSequence: 2 } },
    pendingWork: {
      stage: 'implement',
      runId: randomUUID(),
      inputSequence: 0,
      planReference: current.planReference,
    },
    nextStage: 'plan',
  })
  return collaborationTaskSchema.parse(current)
}

it('continues interrupted plan implementation after a processed status reply', () => {
  const current = interruptedPlanImplementation()
  expect(collaborationNextStage(current)).toBe('implement')
  const next = advanceCollaboration(
    advanceCollaboration(current, 'resume', limits),
    'continue',
    limits,
  )
  expect(next).toMatchObject({ stage: 'implement', actor: 'claude', repairAttempts: 0 })
})

it.each(['codex', 'claude'] as const)(
  'keeps the %s reply read-only outside native Plan mode after implementation stopped',
  (actor) => {
    const current = { ...interruptedPlanImplementation(), actor }
    expect(collaborationActor(current, 'reply')).toBe('claude')
    expect(collaborationPlanMode(current)).toBe(false)
  },
)

it.each(['pending', 'decision', 'changed_plan'] as const)(
  'does not resume an interrupted implementation with %s',
  (change) => {
    const current = interruptedPlanImplementation()
    if (change === 'pending')
      current.inputProcessing = {
        pending: { inputId: randomUUID(), inputSequence: current.inputSequence },
      }
    else if (change === 'decision')
      current.inputProcessing = {
        decision: { runId: current.runId, inputSequence: current.inputSequence },
      }
    else current.planReference = { ...current.planReference!, version: 2, document: document() }
    expect(collaborationNextStage(current)).not.toBe('implement')
    expect(collaborationPlanAccepted(current)).toBe(false)
  },
)

it('preserves historical native Plan replies while new read-only replies cannot publish a Plan', () => {
  const current = interruptedPlanImplementation()
  const authorization = {
    runId: current.runId,
    taskId: current.id,
    taskRevision: current.revision,
    actor: current.owner,
    stage: 'reply' as const,
    inputSequence: current.inputSequence,
  }
  expect(collaborationPlanMode(current, authorization)).toBe(true)
  expect(collaborationPlanMode(current, { ...authorization, replyMode: 'read_only' })).toBe(false)
  expect(collaborationPlanMode(current, { ...authorization, replyMode: 'plan' })).toBe(true)
  expect(
    collaborationPlanMode(current, { ...authorization, replyMode: 'plan', actor: 'claude' }),
  ).toBe(false)
})

it('reviews a genuinely retained Plan before continuing its unfinished implementation', () => {
  const current = interruptedPlanImplementation()
  current.planInputSequence = current.inputSequence
  expect(collaborationNextStage(current)).toBe('plan_review')
})

it('recovers the unfinished implementation after a historical mistaken planning Run was stopped', () => {
  const current = interruptedPlanImplementation()
  current.stage = 'plan'
  current.actor = current.owner
  current.status = 'failed'
  current.runId = randomUUID()
  expect(collaborationNextStage(current)).toBe('implement')
})

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

function turnAuthorization<T extends CollaborationTurnAuthorization['stage']>(
  current: CollaborationTask,
  stage: T,
  fields: Partial<CollaborationTurnAuthorization> = {},
): CollaborationTurnAuthorization & { stage: T } {
  return {
    runId: randomUUID(),
    taskId: current.id,
    taskRevision: current.revision,
    actor: collaborationActor(current, stage),
    inputSequence: current.inputSequence,
    ...(current.planReference ? { planReference: current.planReference } : {}),
    ...fields,
    stage,
  }
}

function settlePure(
  current: CollaborationTask,
  settlement: CollaborationStageSettlement,
): CollaborationTask {
  const original = structuredClone(current)
  const next = settleCollaborationStage(current, settlement)
  expect(current).toEqual(original)
  expect(next.revision).toBe(current.revision)
  return next
}

function transitionReason(
  current: CollaborationTask,
  action: Parameters<typeof advanceCollaboration>[1],
): CollaborationTransitionReason {
  try {
    advanceCollaboration(current, action, limits)
  } catch (error) {
    if (error instanceof CollaborationTransitionError) return error.reason
    throw error
  }
  throw new Error('Expected a collaboration transition failure.')
}

describe('shared workflow decisions and typed transitions', () => {
  it.each([
    {
      name: 'accepted Plan',
      current: () => accepted(),
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['execute'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'failed Respond with an unchanged changes_requested review',
      current: () => {
        const current = accepted()
        current.codeRunId = randomUUID()
        current.stage = 'respond'
        current.status = 'failed'
        current.review = {
          runId: randomUUID(),
          actor: 'claude',
          stage: 'code_review',
          verdict: 'changes_requested',
          inputSequence: 0,
          document: document(),
        }
        return current
      },
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['retry', 'revise_plan'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'stopped Respond with an unchanged changes_requested review',
      current: () => {
        const current = accepted()
        current.codeRunId = randomUUID()
        current.stage = 'respond'
        current.status = 'failed'
        current.automation = 'paused'
        current.pauseReason = 'stopped'
        current.review = {
          runId: randomUUID(),
          actor: 'claude',
          stage: 'code_review',
          verdict: 'changes_requested',
          inputSequence: 0,
          document: document(),
        }
        return current
      },
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['resume', 'revise_plan'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'pending authorized repair',
      current: () => {
        const current = accepted()
        current.codeRunId = randomUUID()
        current.status = 'waiting'
        current.review = undefined
        current.pendingWork = {
          stage: 'repair',
          runId: randomUUID(),
          inputSequence: 0,
        }
        return current
      },
      expected: {
        inputGate: undefined,
        nextStage: 'repair',
        nextActor: 'codex',
        availableActions: ['continue', 'revise_plan'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'newer unanswered input',
      current: () => {
        const current = accepted()
        current.inputSequence = 1
        current.stage = 'reply'
        current.status = 'waiting'
        current.inputProcessing = {
          pending: { inputId: randomUUID(), inputSequence: 1 },
        }
        return current
      },
      expected: {
        inputGate: 'queued',
        nextStage: undefined,
        nextActor: undefined,
        availableActions: [],
        continuationLimit: undefined,
      },
    },
    {
      name: 'completed task',
      current: () => ({ ...accepted(), status: 'complete' as const }),
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: [],
        continuationLimit: undefined,
      },
    },
  ])('derives one exact decision for $name', ({ current, expected }) => {
    const before = current()
    const original = structuredClone(before)
    expect(deriveCollaborationDecision(before, limits)).toEqual(expected)
    expect(before).toEqual(original)
  })

  it.each([
    {
      name: 'input_pending',
      reason: 'input_pending' as const,
      action: 'continue' as const,
      current: () =>
        task({
          inputProcessing: { pending: { inputId: randomUUID(), inputSequence: 0 } },
        }),
      message: 'Reply to the questions',
    },
    {
      name: 'paused',
      reason: 'paused' as const,
      action: 'execute' as const,
      current: () => {
        const current = accepted()
        current.automation = 'paused'
        return current
      },
      message: 'Continue collaboration',
    },
    {
      name: 'plan_not_accepted',
      reason: 'plan_not_accepted' as const,
      action: 'execute' as const,
      current: () => task({ planReference: plan(), planInputSequence: 0, planVersion: 1 }),
      message: 'not been accepted',
    },
    {
      name: 'no_next_step',
      reason: 'no_next_step' as const,
      action: 'continue' as const,
      current: () => accepted(),
      message: 'no next automatic step',
    },
    {
      name: 'write_authorization_required',
      reason: 'write_authorization_required' as const,
      action: 'continue' as const,
      current: () => task({ kind: 'build', nextStage: 'implement' }),
      message: 'explicit authorization',
    },
  ])('reports a typed $name transition failure with its display text', (fixture) => {
    const current = fixture.current()
    const original = structuredClone(current)
    expect(() => advanceCollaboration(current, fixture.action, limits)).toThrow(fixture.message)
    expect(transitionReason(current, fixture.action)).toEqual({ kind: fixture.reason })
    expect(current).toEqual(original)
  })

  it.each(['plan_review', 'code_review', 'repair'] as const)(
    'reports the exact exhausted %s allowance',
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
      expect(transitionReason(current, 'continue')).toEqual({
        kind: 'limit',
        limit: {
          stage,
          used:
            stage === 'plan_review'
              ? limits.maxDiscussionRounds
              : stage === 'code_review'
                ? limits.maxReviewCycles
                : limits.maxRepairAttempts,
          maximum:
            stage === 'plan_review'
              ? limits.maxDiscussionRounds
              : stage === 'code_review'
                ? limits.maxReviewCycles
                : limits.maxRepairAttempts,
        },
      })
    },
  )
})

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
    expect(collaborationAvailableActions(ready)).toEqual(['execute'])
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
      paused = collaborationTaskSchema.parse({
        ...ready,
        automation: 'paused',
        pauseReason: 'stopped',
        revision: ready.revision + 1,
      })
    expect(paused).toMatchObject({ automation: 'paused', pauseReason: 'stopped', revision: 1 })
    expect(() => advanceCollaboration(paused, 'execute', limits)).toThrow(/Continue collaboration/)
    expect(advanceCollaboration(paused, 'resume', limits)).toMatchObject({
      status: 'ready',
      automation: 'active',
      stage: 'plan',
      discussionRounds: 0,
    })
    expect(() => advanceCollaboration(ready, 'recover_plan', limits)).toThrow(/original source/)
  })
  it('rejects the retired standalone Pause action', () => {
    expect(
      collaborationActionInputSchema.safeParse({
        sessionId: randomUUID(),
        taskId: randomUUID(),
        revision: 0,
        clientMessageId: randomUUID(),
        action: 'pause',
      }).success,
    ).toBe(false)
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
    expect(collaborationAvailableActions(current)).toEqual(['respond', 'repair'])
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

describe('pure verified stage and input settlement', () => {
  it('keeps a failed Respond review without scheduling a replay', () => {
    const current = task({
      kind: 'build',
      stage: 'respond',
      status: 'running',
      review: {
        runId: randomUUID(),
        actor: 'claude',
        stage: 'code_review',
        verdict: 'changes_requested',
        inputSequence: 0,
        document: document(),
      },
    })
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: turnAuthorization(current, 'respond'),
      stopped: false,
      unstarted: false,
      failed: true,
      ended: true,
      effectsSettled: true,
      completeResponse: true,
    })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      review: current.review,
    })
    expect(next.nextStage).toBeUndefined()
  })

  it('retains an interrupted started repair without refunding its reservation', () => {
    const current = task({
      kind: 'build',
      stage: 'repair',
      status: 'running',
      repairAttempts: 1,
    })
    const auth = turnAuthorization(current, 'repair')
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: auth,
      stopped: true,
      unstarted: false,
      failed: false,
      ended: true,
      effectsSettled: true,
      completeResponse: false,
      reservation: 'repairAttempts',
    })
    expect(next.repairAttempts).toBe(1)
    expect(next.pendingWork).toEqual({
      stage: 'repair',
      runId: auth.runId,
      inputSequence: auth.inputSequence,
    })
    expect(next.pauseReason).toBe('stopped')
  })

  it('refunds a proven-unsent repair once and marks its released reservation', () => {
    const current = task({
      kind: 'build',
      stage: 'repair',
      status: 'running',
      repairAttempts: 1,
    })
    const auth = turnAuthorization(current, 'repair')
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: auth,
      stopped: false,
      unstarted: true,
      failed: true,
      ended: false,
      effectsSettled: true,
      completeResponse: false,
      reservation: 'repairAttempts',
    })
    expect(next.repairAttempts).toBe(0)
    expect(next.pendingWork).toEqual({
      stage: 'repair',
      runId: auth.runId,
      inputSequence: auth.inputSequence,
      repairReservationReleased: true,
    })
  })

  it('returns a physically ended complete supplemental response to code review', () => {
    const current = task({
      kind: 'build',
      stage: 'respond',
      status: 'running',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: turnAuthorization(current, 'respond', {
        userAuthority: {
          receiptId: randomUUID(),
          rootReceiptId: randomUUID(),
          purpose: 'supplement_code_response',
        },
      }),
      stopped: false,
      unstarted: false,
      failed: false,
      ended: true,
      effectsSettled: true,
      completeResponse: true,
      supplementReviewState: 'fulfilled',
      notice: '',
    })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      nextStage: 'code_review',
      notice: '',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    expect(next.pendingWork).toBeUndefined()
  })

  it('does not fabricate pending implementation work from a physically ended completed turn', () => {
    const current = task({
      kind: 'build',
      stage: 'implement',
      status: 'running',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: turnAuthorization(current, 'implement'),
      stopped: false,
      unstarted: false,
      failed: false,
      ended: true,
      effectsSettled: true,
      completeResponse: true,
    })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    expect(next.nextStage).toBeUndefined()
    expect(next.pendingWork).toBeUndefined()
  })

  it.each([
    ['source' as const, 'The native Turn ended, but its complete response source is unavailable.'],
    [
      'effects' as const,
      'The native Turn ended, but its side effects are not settled. Check the original execution before continuing.',
    ],
  ])('pauses with the exact %s failure notice', (reason, notice) => {
    const next = settlePure(task(), { kind: 'unavailable', reason })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      notice,
    })
  })

  it('does not let a stale accepted review complete newer input', () => {
    const current = task({ kind: 'build', inputSequence: 1 })
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'code_review', { inputSequence: 0 }),
      verdict: 'accepted',
      verdictConflict: false,
      supersededInput: false,
      document: document(),
    })
    expect(next).toMatchObject({ status: 'waiting', nextStage: 'code_review' })
  })

  it('keeps an accepted review waiting while a Plan revision exists', () => {
    const current = task({
      kind: 'build',
      planRevision: {
        requestRunId: randomUUID(),
        inputSequence: 0,
        writeRunId: randomUUID(),
        planReference: plan(),
      },
    })
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'code_review'),
      verdict: 'accepted',
      verdictConflict: false,
      supersededInput: false,
      document: document(),
    })
    expect(next).toMatchObject({ status: 'waiting', nextStage: undefined })
  })

  it('resumes retained pending work after its exact accepted Plan review', () => {
    const current = accepted()
    current.status = 'waiting'
    current.pendingWork = {
      stage: 'implement',
      runId: randomUUID(),
      inputSequence: 0,
      planReference: current.planReference,
    }
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'plan_review'),
      verdict: 'accepted',
      verdictConflict: false,
      supersededInput: false,
      document: document(),
    })
    expect(next).toMatchObject({
      status: 'waiting',
      nextStage: 'implement',
      pendingWork: current.pendingWork,
    })
  })

  it('carries a needs_user decision without releasing newer pending input', () => {
    const current = task({
      kind: 'build',
      inputSequence: 1,
      inputProcessing: {
        pending: { inputId: randomUUID(), inputSequence: 1 },
      },
    })
    const decision = {
      runId: randomUUID(),
      inputSequence: 0,
      actor: 'claude' as const,
    }
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'code_review', { inputSequence: 0 }),
      verdict: 'needs_user',
      verdictConflict: false,
      supersededInput: true,
      document: document(),
      decision,
    })
    expect(next).toMatchObject({
      status: 'questions',
      nextStage: 'code_review',
      inputProcessing: {
        pending: current.inputProcessing?.pending,
        decision,
      },
      notice: 'The review needs your decision before collaboration can continue.',
    })
  })

  it.each([
    [false, 'The review did not provide a complete conclusion. Start a new review to continue.'],
    [true, 'The review returned conflicting conclusions. Start a new review to continue.'],
  ])('pauses an incomplete review with conflict=%s', (verdictConflict, notice) => {
    const current = task({ kind: 'build' })
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'code_review'),
      verdict: 'incomplete',
      verdictConflict,
      supersededInput: false,
    })
    expect(next).toMatchObject({
      status: 'failed',
      nextStage: 'code_review',
      automation: 'paused',
      pauseReason: 'failure',
      notice,
    })
  })

  it('applies pure input processing without clearing an existing pause', () => {
    const current = task({
      status: 'waiting',
      automation: 'paused',
      pauseReason: 'user',
      inputProcessing: {
        pending: { inputId: randomUUID(), inputSequence: 0 },
      },
    })
    const runId = randomUUID()
    const next = settlePure(current, {
      kind: 'input_processed',
      runId,
      inputSequence: 0,
    })
    expect(next).toMatchObject({
      status: 'waiting',
      automation: 'paused',
      pauseReason: 'user',
      inputProcessing: { settled: { runId, inputSequence: 0 } },
      notice: 'Your reply has been processed. Continue collaboration when you are ready.',
    })
  })

  it('clears the flat unchanged basis on verified business completion', () => {
    const unchangedRunId = randomUUID()
    const current = task({
      kind: 'build',
      inputSequence: 1,
      inputProcessing: {
        settled: {
          runId: unchangedRunId,
          inputSequence: 1,
          unchanged: {
            inputSequence: 0,
            settled: { runId: unchangedRunId, inputSequence: 0 },
          },
        },
      },
    })
    const auth = turnAuthorization(current, 'implement')
    const next = settlePure(current, { kind: 'work', authorization: auth })
    expect(next).toMatchObject({
      status: 'waiting',
      nextStage: 'code_review',
      codeRunId: auth.runId,
      inputProcessing: {
        settled: { runId: unchangedRunId, inputSequence: 1 },
      },
    })
  })

  it.each([
    ['exact retained Plan reference', true],
    ['hash-only Plan reference', false],
  ] as const)('promotes an unchanged Plan only for an %s', (_name, exact) => {
    const ref = plan()
    const current = task({
      inputSequence: 2,
      planVersion: 1,
      planReference: ref,
      planInputSequence: 0,
      inputProcessing: {
        settled: {
          runId: randomUUID(),
          inputSequence: 2,
          unchanged: { inputSequence: 0 },
        },
      },
    })
    const authRef = exact
      ? ref
      : { ...ref, sourceRunId: randomUUID(), sourceMessageId: randomUUID() }
    const auth = turnAuthorization(current, 'plan_review', { planReference: authRef })
    const next = settlePure(current, {
      kind: 'review',
      authorization: auth,
      verdict: 'accepted',
      verdictConflict: false,
      supersededInput: false,
      document: document(),
    })
    expect(next.planInputSequence).toBe(exact ? 2 : 0)
    expect(next.inputProcessing?.settled).toEqual({
      runId: current.inputProcessing!.settled!.runId,
      inputSequence: 2,
    })
  })

  it('keeps review control coverage while clearing the control input', () => {
    const coverage = {
      kind: 'repair_role_request' as const,
      reviewRunId: randomUUID(),
      reviewInputSequence: 0,
      report: document(),
      scope: document(),
      producerRunId: randomUUID(),
      priorInputSequence: 0,
      inputSequence: 1,
      inputId: randomUUID(),
      inputDigest: 'a'.repeat(64),
    }
    const current = task({
      inputSequence: 1,
      reviewControlCoverage: coverage,
      inputProcessing: {
        pending: { inputId: randomUUID(), inputSequence: 1 },
      },
    })
    const next = settlePure(current, { kind: 'input_control', inputSequence: 1 })
    expect(next).toMatchObject({
      reviewControlCoverage: coverage,
      inputProcessing: {},
      handledInputSequence: 1,
      status: 'waiting',
      nextStage: undefined,
    })
  })

  it.each([
    [
      'input_needs_user',
      {
        kind: 'input_needs_user' as const,
        decision: { runId: randomUUID(), inputSequence: 0 },
      },
      {
        status: 'questions' as const,
        notice: 'More input is needed. Read the response and reply in the message box.',
      },
    ],
    [
      'input_unconfirmed',
      { kind: 'input_unconfirmed' as const },
      {
        status: 'failed' as const,
        notice:
          'Your reply has not been confirmed as processed. Check the response or recovery notice before sending a follow-up.',
      },
    ],
    [
      'input_plan_withdrawn',
      { kind: 'input_plan_withdrawn' as const },
      {
        status: 'failed' as const,
        notice:
          'A later message was withdrawn. Send a follow-up to confirm the current plan before continuing.',
      },
    ],
  ])('applies %s with its exact lifecycle state', (_name, settlement, expected) => {
    const latestUserMessageId = randomUUID()
    const current = task({
      stage: 'reply',
      status: 'failed',
      automation: 'paused',
      pauseReason: 'stopped',
      latestUserMessageId,
    })
    const next = settlePure(current, settlement)
    expect(next).toMatchObject(expected)
    expect(next.inputProcessing).toEqual(
      settlement.kind === 'input_needs_user'
        ? { decision: settlement.decision }
        : settlement.kind === 'input_unconfirmed'
          ? { pending: { inputId: latestUserMessageId, inputSequence: 0 } }
          : current.inputProcessing,
    )
  })

  it('normalizes a legacy failed reply before preserving unconfirmed input state', () => {
    const latestUserMessageId = randomUUID()
    const current = task({
      stage: 'reply',
      status: 'failed',
      handledInputSequence: 0,
      inputSequence: 0,
      latestUserMessageId,
    })
    const next = settlePure(current, { kind: 'input_unconfirmed' })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      inputProcessing: {
        pending: { inputId: latestUserMessageId, inputSequence: 0 },
      },
    })
    expect(collaborationInputGate(next)).toBe('incomplete')
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

it.each(['codex', 'claude'] as const)(
  'freezes split stage roles independently of provider: %s Primary',
  (primary) => {
    const secondary = primary === 'codex' ? 'claude' : 'codex'
    const current = task({
      owner: primary,
      reviewer: secondary,
      actor: primary,
      rolePolicy: 'split-stages-v1',
    })
    const stages = ['plan', 'plan_review', 'implement', 'code_review', 'respond', 'repair'] as const
    expect(stages.map((stage) => collaborationActor(current, stage))).toEqual([
      primary,
      secondary,
      secondary,
      primary,
      secondary,
      secondary,
    ])
    const legacy = { ...current, rolePolicy: undefined }
    expect(stages.map((stage) => collaborationActor(legacy, stage))).toEqual([
      primary,
      secondary,
      primary,
      secondary,
      primary,
      primary,
    ])
    const ready: CollaborationTask = {
      ...accepted(),
      owner: primary,
      reviewer: secondary,
      rolePolicy: 'split-stages-v1' as const,
    }
    ready.review = { ...ready.review!, actor: secondary }
    expect(advanceCollaboration(ready, 'execute', limits).actor).toBe(secondary)
    expect(
      collaborationPlanAccepted({ ...ready, review: { ...ready.review, actor: primary } }),
    ).toBe(false)
    expect(collaborationTaskSchema.safeParse({ ...current, reviewer: primary }).success).toBe(false)
  },
)

it('preserves legacy action bases and validates only the supported split role marker', () => {
  const current = task()
  const basis = {
    handoff: {
      id: 'a'.repeat(64),
      sessionId: current.sessionId,
      budgetRoot: { kind: 'task', id: current.id },
      budgetSubjectId: `task:${current.id}`,
      eventId: current.runId,
      slot: 'workflow_next',
      factFingerprint: 'b'.repeat(64),
      freshnessGuard: {
        taskRevision: 0,
        settingsRevision: 1,
        inputSequence: 0,
        runId: current.runId,
        bindingGeneration: 1,
        agentId: 'claude',
        stateFingerprint: 'c'.repeat(64),
      },
    },
    taskId: current.id,
    inputSequence: 0,
    stage: 'implement',
    actor: 'claude',
    planReference: null,
    review: null,
    reviewScopeRef: null,
    previousRunId: null,
    actorBinding: {
      generation: 1,
      nativeSessionId: null,
      continuationState: null,
      permissions: 'd'.repeat(64),
    },
  }
  expect(collaborationActionBasisSchema.parse(basis)).toEqual(basis)
  expect(collaborationActionBasisSchema.parse({ ...basis, rolePolicy: 'split-stages-v1' })).toEqual(
    { ...basis, rolePolicy: 'split-stages-v1' },
  )
  expect(
    collaborationActionBasisSchema.safeParse({ ...basis, rolePolicy: 'unverified' }).success,
  ).toBe(false)
  expect(collaborationActionBasisSchema.safeParse({ ...basis, implementer: 'codex' }).success).toBe(
    false,
  )
})

describe('explicit initial stage roles', () => {
  it.each([
    ['plan', 'planAuthor'],
    ['plan_review', 'planReviewer'],
    ['implement', 'codeAuthor'],
    ['respond', 'codeAuthor'],
    ['repair', 'codeAuthor'],
    ['code_review', 'codeReviewer'],
  ] as const)('resolves %s through the selected %s role', (stage, role) => {
    const roles = {
      version: 'task-stage-roles-v1' as const,
      revision: 0 as const,
      planAuthor: 'claude' as const,
      planReviewer: 'codex' as const,
      codeAuthor: 'claude' as const,
      codeReviewer: 'codex' as const,
    }
    const assigned = task({
      rolePolicy: 'split-stages-v1',
      owner: 'codex',
      reviewer: 'claude',
      stageRoles: roles,
    })
    expect(collaborationActor(assigned, stage)).toBe(roles[role])
  })

  it.each([
    { kind: 'plan' as const, codeRunId: undefined, expected: 'claude' },
    { kind: 'plan' as const, codeRunId: randomUUID(), expected: 'codex' },
    { kind: 'build' as const, codeRunId: randomUUID(), expected: 'codex' },
    { kind: 'review' as const, codeRunId: randomUUID(), expected: 'claude' },
  ])(
    'resolves reply through the correct role for kind=$kind with codeRunId=$codeRunId',
    ({ kind, codeRunId, expected }) => {
      const roles = {
        version: 'task-stage-roles-v1' as const,
        revision: 0 as const,
        planAuthor: 'claude' as const,
        planReviewer: 'codex' as const,
        codeAuthor: 'codex' as const,
        codeReviewer: 'claude' as const,
      }
      const assigned = task({
        kind,
        rolePolicy: 'split-stages-v1',
        owner: 'codex',
        reviewer: 'claude',
        stageRoles: roles,
        codeRunId,
      })
      expect(collaborationActor(assigned, 'reply')).toBe(expected)
    },
  )

  it('rejects same-author reviewer, unknown actors, extra fields and unbound roles', () => {
    const valid = defaultTaskStageRoles('codex')
    expect(taskStageRolesSchema.safeParse(valid).success).toBe(true)
    for (const value of [
      { ...valid, planReviewer: valid.planAuthor },
      { ...valid, codeAuthor: 'gpt' },
      { ...valid, extra: 'field' },
      { ...valid, revision: -1 },
      { ...valid, revision: 0.5 },
      { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, permission: 'write' },
    ])
      expect(taskStageRolesSchema.safeParse(value).success).toBe(false)
    expect(taskStageRolesSchema.safeParse({ ...valid, revision: 1 }).success).toBe(true)
    const assigned = task({ rolePolicy: 'split-stages-v1', stageRoles: valid })
    expect(collaborationTaskSchema.safeParse(assigned).success).toBe(true)
    expect(collaborationTaskSchema.safeParse({ ...assigned, rolePolicy: undefined }).success).toBe(
      false,
    )
    expect(collaborationTaskSchema.safeParse({ ...assigned, stageRoles: undefined }).success).toBe(
      true,
    )
  })

  it('freezes revision-0 metadata and emits only non-default candidates', () => {
    const planCandidates = initialTaskRoleCandidates('plan', 'codex')
    expect(planCandidates).toHaveLength(3)
    for (const candidate of planCandidates) {
      expect(initialTaskRoleCandidateSchema.parse(candidate)).toEqual(candidate)
      expect(candidate.roles).not.toEqual(defaultTaskStageRoles('codex'))
      expect(candidate.id).toBe(`roles_${candidate.roles.planAuthor}_${candidate.roles.codeAuthor}`)
      expect(
        initialTaskRoleCandidateSchema.safeParse({
          ...candidate,
          roles: { ...candidate.roles, revision: 1 },
        }).success,
      ).toBe(false)
    }
    expect(initialTaskRoleCandidates('build', 'codex')).toHaveLength(1)
    expect(initialTaskRoleCandidates('review', 'claude')).toHaveLength(1)
    expect(initialTaskRoleCandidateIdSchema.safeParse('roles_codex_codex').success).toBe(true)
    expect(initialTaskRoleCandidateIdSchema.safeParse('route_codex').success).toBe(false)
    expect(collaborationInitialStage('plan')).toBe('plan')
    expect(collaborationInitialStage('build')).toBe('implement')
    expect(collaborationInitialStage('review')).toBe('code_review')
  })
})
