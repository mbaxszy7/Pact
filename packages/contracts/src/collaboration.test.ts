const randomUUID = () => crypto.randomUUID()
import { describe, expect, it } from 'vitest'

import {
  advanceAutomaticCollaboration,
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

it('enters open collaboration on execute and disables Phase 1 auto-advancement', () => {
  const ready = accepted()
  const executing = advanceCollaboration(ready, 'execute', limits)
  expect(executing).toMatchObject({
    stage: 'implement',
    actor: 'codex',
    openMode: true,
    lastCodeActor: 'codex',
    status: 'running',
  })
  const stoppedOpen = {
    ...executing,
    status: 'failed' as const,
    automation: 'paused' as const,
    pauseReason: 'stopped' as const,
  }
  expect(collaborationNextStage(stoppedOpen)).toBeUndefined()
  expect(collaborationAvailableActions(stoppedOpen)).toEqual(['retry'])
  expect(() => advanceAutomaticCollaboration(stoppedOpen, limits)).toThrow(/Open collaboration/)
  expect(advanceCollaboration(stoppedOpen, 'retry', limits)).toMatchObject({
    stage: 'implement',
    actor: 'codex',
    status: 'running',
    automation: 'active',
    openMode: true,
  })
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
  'blocks open execution or review while input or plan basis has %s',
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
    expect(collaborationPlanAccepted(current)).toBe(false)
    expect(
      change === 'pending' || change === 'decision' ? collaborationAvailableActions(current) : [],
    ).toEqual([])
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

it('resumes a paused Phase 1 planning stage explicitly', () => {
  const pausedPlan = task({
    automation: 'paused',
    pauseReason: 'stopped',
    stage: 'plan',
    status: 'waiting',
  })
  expect(collaborationNextStage(pausedPlan)).toBe('plan')
  expect(collaborationAvailableActions(pausedPlan)).toEqual(['resume'])
  expect(advanceCollaboration(pausedPlan, 'resume', limits)).toMatchObject({
    stage: 'plan',
    automation: 'active',
    status: 'running',
  })
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

function autoTransitionReason(current: CollaborationTask): CollaborationTransitionReason {
  try {
    advanceAutomaticCollaboration(current, limits)
  } catch (error) {
    if (error instanceof CollaborationTransitionError) return error.reason
    throw error
  }
  throw new Error('Expected an automatic collaboration transition failure.')
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
      name: 'failed collaborate turn in open mode',
      current: () =>
        task({
          openMode: true,
          stage: 'collaborate',
          status: 'failed',
          codeRunId: randomUUID(),
          lastCodeActor: 'claude',
        }),
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['retry'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'open mode changes_requested code review',
      current: () => {
        const reviewRunId = randomUUID()
        return task({
          kind: 'build',
          openMode: true,
          stage: 'code_review',
          status: 'waiting',
          runId: reviewRunId,
          codeRunId: randomUUID(),
          lastCodeActor: 'claude',
          review: {
            runId: reviewRunId,
            actor: 'codex',
            stage: 'code_review',
            verdict: 'changes_requested',
            inputSequence: 0,
            document: document(),
          },
        })
      },
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['fix'],
        continuationLimit: undefined,
      },
    },
    {
      name: 'open mode unreviewed code and unreviewed Plan v2 (code newest)',
      current: () => {
        const runId = randomUUID()
        return task({
          openMode: true,
          stage: 'collaborate',
          status: 'waiting',
          runId,
          codeRunId: runId,
          lastCodeActor: 'codex',
          unreviewedCodeActor: 'codex',
          unreviewedPlanActor: 'codex',
          planVersion: 2,
          planReference: { ...plan(), version: 2, sourceRunId: randomUUID() },
        })
      },
      expected: {
        inputGate: undefined,
        nextStage: undefined,
        nextActor: undefined,
        availableActions: ['review_code', 'review_plan'],
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
      name: 'plan_not_accepted',
      reason: 'plan_not_accepted' as const,
      action: 'execute' as const,
      current: () => task({ planReference: plan(), planInputSequence: 0, planVersion: 1 }),
      message: 'not ready for implementation',
    },
    {
      name: 'review_not_current',
      reason: 'review_not_current' as const,
      action: 'fix' as const,
      current: () => task({ kind: 'build', openMode: true }),
      message: 'no review requesting changes',
    },
    {
      name: 'recovery_only',
      reason: 'recovery_only' as const,
      action: 'recover_plan' as const,
      current: () => accepted(),
      message: 'original source',
    },
    {
      name: 'recorded_control_action',
      reason: 'recorded_control_action' as const,
      action: 'swap_code_roles' as const,
      current: () => accepted(),
      message: 'recorded control action',
    },
  ])('reports a typed $name transition failure with its display text', (fixture) => {
    const current = fixture.current()
    const original = structuredClone(current)
    expect(() => advanceCollaboration(current, fixture.action, limits)).toThrow(fixture.message)
    expect(transitionReason(current, fixture.action)).toEqual({ kind: fixture.reason })
    expect(current).toEqual(original)
  })

  it('rejects automatic advancement for input_pending, paused, open mode, and Phase 1 no_next_step', () => {
    const pending = task({
      inputProcessing: { pending: { inputId: randomUUID(), inputSequence: 0 } },
    })
    expect(autoTransitionReason(pending)).toEqual({ kind: 'input_pending' })
    expect(autoTransitionReason(task({ automation: 'paused', pauseReason: 'stopped' }))).toEqual({
      kind: 'paused',
    })
    expect(autoTransitionReason(accepted())).toEqual({ kind: 'no_next_step' })
    expect(autoTransitionReason(task({ kind: 'build', openMode: true }))).toEqual({
      kind: 'no_next_step',
    })
  })

  it('reports the exact exhausted Phase 1 plan_review allowance', () => {
    const current = task({
      planReference: plan(),
      planInputSequence: 0,
      planVersion: 1,
      discussionRounds: limits.maxDiscussionRounds,
    })
    expect(autoTransitionReason(current)).toEqual({
      kind: 'limit',
      limit: {
        stage: 'plan_review',
        used: limits.maxDiscussionRounds,
        maximum: limits.maxDiscussionRounds,
      },
    })
  })
})

describe('native workflow authorization and progression', () => {
  it('projects the Phase 1 plan_review limit and unlocks on limit increase without losing discussionRounds', () => {
    const current = task({
      planReference: plan(),
      planInputSequence: 0,
      planVersion: 1,
      discussionRounds: limits.maxDiscussionRounds,
      automation: 'paused',
      pauseReason: 'limit',
    })
    const original = structuredClone(current)
    expect(collaborationContinuationLimit(current, limits)).toMatchObject({ stage: 'plan_review' })
    expect(deriveCollaborationDecision(current, limits).availableActions).toEqual(['execute'])
    expect(() =>
      advanceAutomaticCollaboration({ ...current, automation: 'active' }, limits),
    ).toThrow(/limit/)
    const raised = { ...limits, maxDiscussionRounds: limits.maxDiscussionRounds + 1 }
    expect(collaborationContinuationLimit(current, raised)).toBeUndefined()
    expect(
      advanceAutomaticCollaboration({ ...current, automation: 'active' }, raised),
    ).toMatchObject({
      stage: 'plan_review',
      status: 'running',
      discussionRounds: limits.maxDiscussionRounds + 1,
    })
    expect(current).toEqual(original)
  })
  it('keeps Phase 1 planning read-only until explicit Implement plan enters open mode', () => {
    expect(collaborationNextStage(task())).toBe('plan')
    const planned = task({ planReference: plan(), planInputSequence: 0, planVersion: 1 })
    const review = advanceAutomaticCollaboration(planned, limits)
    expect(review).toMatchObject({
      stage: 'plan_review',
      actor: 'claude',
      discussionRounds: 1,
      status: 'running',
    })
    expect(planned.discussionRounds).toBe(0)
    expect(() => advanceCollaboration(planned, 'execute', limits)).toThrow(
      /not ready for implementation/,
    )
    const ready = accepted()
    expect(collaborationAvailableActions(ready)).toEqual(['execute'])
    expect(collaborationNextStage(ready)).toBeUndefined()
    expect(() => advanceAutomaticCollaboration(ready, limits)).toThrow(/no next/)
    expect(advanceCollaboration(ready, 'execute', limits)).toMatchObject({
      stage: 'implement',
      actor: 'codex',
      openMode: true,
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
  it('resumes paused Phase 1 planning without skipping plan review', () => {
    const waitingPlan = task({
      automation: 'paused',
      pauseReason: 'stopped',
      revision: 1,
    })
    expect(waitingPlan).toMatchObject({ automation: 'paused', pauseReason: 'stopped', revision: 1 })
    expect(advanceCollaboration(waitingPlan, 'resume', limits)).toMatchObject({
      status: 'running',
      automation: 'active',
      stage: 'plan',
      discussionRounds: 0,
    })
    expect(() => advanceCollaboration(accepted(), 'recover_plan', limits)).toThrow(
      /original source/,
    )
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
  it('offers Fix issues in open mode for code_review and plan_review changes_requested', () => {
    const codeReview = task({
      kind: 'build',
      openMode: true,
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
    codeReview.runId = codeReview.review!.runId
    expect(collaborationAvailableActions(codeReview)).toEqual(['fix'])
    expect(advanceCollaboration(codeReview, 'fix', limits)).toMatchObject({
      stage: 'collaborate',
      actor: 'codex',
      repairAttempts: 1,
      lastCodeActor: 'codex',
      openMode: true,
    })

    const planReview = task({
      openMode: true,
      stage: 'plan_review',
      planVersion: 2,
      planReference: { ...plan(), version: 2 },
      review: {
        runId: randomUUID(),
        actor: 'codex',
        stage: 'plan_review',
        verdict: 'changes_requested',
        inputSequence: 0,
        document: document(),
      },
    })
    planReview.runId = planReview.review!.runId
    expect(collaborationAvailableActions(planReview)).toEqual(['fix'])
    expect(advanceCollaboration(planReview, 'fix', limits)).toMatchObject({
      stage: 'collaborate',
      actor: 'claude',
      repairAttempts: 0,
      openMode: true,
    })
  })
  it('allows Phase 1 execute when discussionRounds reaches limit and rejects complete tasks', () => {
    const ready = accepted()
    const atLimit = { ...ready, review: undefined, discussionRounds: limits.maxDiscussionRounds }
    expect(deriveCollaborationDecision(atLimit, limits).availableActions).toEqual(['execute'])
    expect(advanceCollaboration(atLimit, 'execute', limits)).toMatchObject({
      stage: 'implement',
      openMode: true,
    })
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

  it('settles interrupted work and open-mode turns cleanly without auto-chaining', () => {
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
    expect(next.openMode).toBe(true)
    expect(next.repairAttempts).toBe(1)
    expect(next.pendingWork).toBeUndefined()
    expect(next.nextStage).toBeUndefined()
    expect(next.pauseReason).toBe('stopped')
  })

  it('refunds a proven-unsent repair reservation without fabricating open-mode pendingWork', () => {
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
    expect(next.pendingWork).toBeUndefined()
    expect(next.nextStage).toBeUndefined()
  })

  it('settles an interrupted respond turn as paused without scheduling nextStage', () => {
    const current = task({
      kind: 'build',
      stage: 'respond',
      status: 'running',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    const next = settlePure(current, {
      kind: 'interrupted',
      authorization: turnAuthorization(current, 'respond'),
      stopped: false,
      unstarted: false,
      failed: false,
      ended: true,
      effectsSettled: true,
      completeResponse: true,
      notice: '',
    })
    expect(next).toMatchObject({
      status: 'failed',
      automation: 'paused',
      pauseReason: 'failure',
      notice: '',
      reviewCycles: 1,
      repairAttempts: 1,
    })
    expect(next.nextStage).toBeUndefined()
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
    ['source' as const, 'Complete response source is unavailable.'],
    ['effects' as const, 'Turn side effects did not settle.'],
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
    expect(next).toMatchObject({ status: 'waiting', nextStage: undefined })
  })

  it('settles a current accepted code review for a build task as complete', () => {
    const current = task({ kind: 'build', openMode: true, stage: 'code_review' })
    const next = settlePure(current, {
      kind: 'review',
      authorization: turnAuthorization(current, 'code_review'),
      verdict: 'accepted',
      verdictConflict: false,
      supersededInput: false,
      document: document(),
    })
    expect(next).toMatchObject({ status: 'complete', nextStage: undefined })
  })

  it('keeps an accepted plan review waiting in open mode and resets automation', () => {
    const current = task({
      openMode: true,
      stage: 'plan_review',
      automation: 'paused',
      pauseReason: 'failure',
      planVersion: 2,
      planReference: { ...plan(), version: 2 },
      unreviewedPlanActor: 'codex',
    })
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
      nextStage: undefined,
      automation: 'active',
      pauseReason: undefined,
      unreviewedPlanActor: undefined,
    })
  })

  it('carries a needs_user decision without releasing newer pending input', () => {
    const current = task({
      kind: 'build',
      inputSequence: 1,
      unreviewedCodeActor: 'codex',
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
      nextStage: undefined,
      unreviewedCodeActor: 'codex',
      inputProcessing: {
        pending: current.inputProcessing?.pending,
        decision,
      },
      notice: undefined,
    })
  })

  it.each([
    [false, 'The review did not provide a complete conclusion.'],
    [true, 'The review returned conflicting conclusions.'],
  ])(
    'pauses an incomplete review with conflict=%s and preserves unreviewed flags',
    (verdictConflict, notice) => {
      const current = task({ kind: 'build', openMode: true, unreviewedCodeActor: 'codex' })
      const next = settlePure(current, {
        kind: 'review',
        authorization: turnAuthorization(current, 'code_review'),
        verdict: 'incomplete',
        verdictConflict,
        supersededInput: false,
      })
      expect(next).toMatchObject({
        status: 'failed',
        nextStage: undefined,
        automation: 'paused',
        pauseReason: 'failure',
        unreviewedCodeActor: 'codex',
        notice,
      })
    },
  )

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
      notice: undefined,
    })
  })

  it('clears the flat unchanged basis and sets openMode on verified work completion', () => {
    const unchangedRunId = randomUUID()
    const current = task({
      kind: 'build',
      inputSequence: 1,
      automation: 'paused',
      pauseReason: 'failure',
      unreviewedPlanActor: 'codex',
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
      openMode: true,
      automation: 'active',
      pauseReason: undefined,
      status: 'waiting',
      nextStage: undefined,
      codeRunId: auth.runId,
      unreviewedCodeActor: auth.actor,
      unreviewedPlanActor: 'codex',
      inputProcessing: {
        settled: { runId: unchangedRunId, inputSequence: 1 },
      },
    })
  })

  it('preserves newer pending input, resets paused automation, and keeps unreviewedPlanActor on collaborate settlement', () => {
    const current = task({
      openMode: true,
      stage: 'collaborate',
      inputSequence: 2,
      automation: 'paused',
      pauseReason: 'failure',
      unreviewedPlanActor: 'claude',
      inputProcessing: {
        pending: { inputId: randomUUID(), inputSequence: 2 },
      },
    })
    const auth = turnAuthorization(current, 'collaborate', { inputSequence: 1 })
    const settled = settlePure(current, {
      kind: 'collaborate',
      authorization: auth,
      hasCodeChanges: true,
      hasPublishedPlan: false,
    })
    expect(settled).toMatchObject({
      status: 'waiting',
      automation: 'active',
      pauseReason: undefined,
      unreviewedCodeActor: auth.actor,
      unreviewedPlanActor: 'claude',
      inputProcessing: {
        pending: current.inputProcessing?.pending,
        settled: { runId: auth.runId, inputSequence: 1 },
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
        notice: undefined,
      },
    ],
    [
      'input_unconfirmed',
      { kind: 'input_unconfirmed' as const },
      {
        status: 'failed' as const,
        notice: 'Your reply could not be confirmed.',
      },
    ],
    [
      'input_plan_withdrawn',
      { kind: 'input_plan_withdrawn' as const },
      {
        status: 'failed' as const,
        notice: 'A later message was withdrawn.',
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
      for (const action of ['resume', 'execute', 'fix', 'retry'] as const)
        expect(() => advanceCollaboration(current, action, limits)).toThrow(
          /Reply to the questions/,
        )
      expect(() => advanceAutomaticCollaboration(current, limits)).toThrow(
        gate === 'processing' ? /still working/ : /Continue collaboration/,
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
        for (const action of ['resume', 'execute', 'fix', 'retry'] as const)
          expect(() => advanceCollaboration(current, action, limits)).toThrow(/Reply/)
        expect(() => advanceAutomaticCollaboration(current, limits)).toThrow(
          /Continue collaboration/,
        )
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
