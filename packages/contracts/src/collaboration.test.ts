import { describe, expect, it } from 'vitest'

import {
  collaborationSourceReadSchema,
  collaborationTodoPageSchema,
  type CollaborationTodoDelta,
} from './collaboration-todos.js'
import {
  advanceCollaboration,
  collaborationActionSchema,
  collaborationEnvelopeSchema,
  collaborationOutputSchema,
  collaborationResultSchema,
  collaborationSubmittedPlan,
  collaborationSubmission,
  collaborationTaskSchema,
  collaborationViewSchema,
  otherAgent,
  prepareCollaborationSupplement,
  settleCollaboration,
  type CollaborationAction,
  type CollaborationResult,
  type CollaborationSettlementFacts,
  type CollaborationTask,
} from './collaboration.js'

const property = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') throw Error('Schema property is not an object')
  return Reflect.get(value, key)
}
function nativeObjectFields(value: unknown): Array<{ keys: string[]; required: unknown }> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nativeObjectFields)
  const properties = Reflect.get(value, 'properties')
  return [
    ...(properties && typeof properties === 'object'
      ? [{ keys: Object.keys(properties), required: Reflect.get(value, 'required') }]
      : []),
    ...Object.values(value).flatMap(nativeObjectFields),
  ]
}
const limits = { maxDiscussionRounds: 6, maxReviewCycles: 3, maxRepairAttempts: 3 }
const result = (fields: Partial<CollaborationResult> = {}): CollaborationResult =>
  collaborationResultSchema.parse({
    submission: 'stage_result',
    outcome: 'complete',
    summary: 'Checked current scope.',
    todoDeltas: [],
    inputResponses: [],
    ...fields,
  })
const delta = (fields: Partial<CollaborationTodoDelta> = {}): CollaborationTodoDelta => ({
  todoId: 'lifecycle',
  expectedRevision: 0,
  operation: 'create',
  kind: 'opinion',
  title: 'Release resources',
  detail: 'The request survives Stop.',
  recommendation: 'Dispose with the owner.',
  evidence: null,
  question: null,
  resolutionKind: null,
  reason: '',
  mergeTargetId: null,
  userSourceIds: [],
  evidenceRefs: [],
  ...fields,
})
const question: NonNullable<CollaborationTodoDelta['question']> = {
  id: 'scope',
  revision: 1,
  type: 'choice',
  question: 'Which scope should change?',
  reason: 'Implementation needs a clear target.',
  options: ['Current module', 'Current file'],
  recommended: 0,
  answerResolver: 'claude',
}
function task(fields: Partial<CollaborationTask> = {}): CollaborationTask {
  return collaborationTaskSchema.parse({
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    kind: 'plan',
    revision: 0,
    primary: 'codex',
    drafter: 'codex',
    implementer: 'claude',
    reviewer: 'codex',
    task: 'Make cancellation reliable.',
    taskMessageId: crypto.randomUUID(),
    stage: 'draft',
    actor: 'codex',
    status: 'running',
    runId: crypto.randomUUID(),
    planVersion: 0,
    discussionRounds: 0,
    discussionHalf: false,
    reviewCycles: 0,
    repairAttempts: 0,
    rereview: false,
    nextCycle: false,
    ...fields,
  })
}
// These are explicit Repository settlement premises, not evidence inferred from a report's verdict.
const facts = (
  fields: Partial<CollaborationSettlementFacts> = {},
): CollaborationSettlementFacts => ({
  ledgerRevision: 0,
  ledgerOpenCount: 0,
  ledgerAwaitingCount: 0,
  doneTodoCount: 0,
  unansweredCount: 0,
  questionPendingCount: 0,
  inputSequence: 0,
  processedWatermark: 0,
  ...fields,
})
const dispatch = (value: CollaborationTask, action: CollaborationAction, bounds = limits) => ({
  ...advanceCollaboration(value, action, bounds),
  runId: crypto.randomUUID(),
})
function draft(drafter: 'codex' | 'claude' = 'codex') {
  const current = task({ drafter, actor: drafter })
  const next = settleCollaboration(
    current,
    result({ submission: 'plan_submission', plan: 'Current plan' }),
  )
  return {
    ...next,
    planReference: {
      type: 'unchanged' as const,
      version: next.planVersion,
      sourceRunId: next.runId,
      sha256: 'a'.repeat(64),
    },
  }
}
function acceptedPlan(drafter: 'codex' | 'claude' = 'codex') {
  const current = draft(drafter)
  const review = dispatch(current, 'continue')
  return settleCollaboration(
    review,
    result({
      submission: drafter === 'codex' ? 'plan_review' : 'plan_adoption',
      ...(drafter === 'claude' ? { plan: current.planReference } : {}),
      reviewedPlan: current.planReference,
      verdict: 'accepted',
    }),
    facts({ acceptedReview: true }),
  )
}

describe('Pact collaboration through the phase Interface', () => {
  it.each(['codex', 'claude'] as const)(
    'starts the peer duty for a %s draft and adopts its exact unchanged source',
    (drafter) => {
      const current = draft(drafter)
      expect(current.discussionRounds).toBe(0)
      const review = dispatch(current, 'continue')
      expect(review.actor).toBe(otherAgent(drafter))
      expect(collaborationSubmission(review)).toBe(
        drafter === 'codex' ? 'plan_review' : 'plan_adoption',
      )
      const ready = acceptedPlan(drafter)
      expect(ready).toMatchObject({ status: 'ready', planVersion: 1 })
      expect(dispatch(ready, 'execute')).toMatchObject({
        stage: 'implement',
        actor: 'claude',
        approvedPlanVersion: 1,
        repairAttempts: 0,
      })
    },
  )

  it('requires Secondary confirmation of a Primary revision without an initial redraft', () => {
    const current = draft('claude')
    const adoption = dispatch(current, 'continue')
    const revised = settleCollaboration(
      adoption,
      result({ submission: 'plan_adoption', plan: 'Revised full plan' }),
    )
    expect(revised).toMatchObject({ status: 'waiting', planAuthor: 'codex', planVersion: 2 })
    expect(() => dispatch(revised, 'execute')).toThrow(/accepted/)
    expect(() =>
      settleCollaboration(
        adoption,
        result({ submission: 'plan_adoption', plan: 'Revised full plan', verdict: 'accepted' }),
      ),
    ).toThrow(/peer review/)
    const exact = {
      type: 'unchanged' as const,
      version: 2,
      sourceRunId: revised.runId,
      sha256: 'b'.repeat(64),
    }
    const peer = dispatch({ ...revised, planReference: exact }, 'continue')
    expect(peer.actor).toBe('claude')
    expect(() =>
      settleCollaboration(
        peer,
        result({
          submission: 'plan_review',
          plan: 'Secondary replacement',
          reviewedPlan: exact,
          verdict: 'accepted',
        }),
        facts({ acceptedReview: true }),
      ),
    ).toThrow(/cannot publish/)
    expect(
      settleCollaboration(
        peer,
        result({ submission: 'plan_review', reviewedPlan: exact, verdict: 'accepted' }),
        facts({ acceptedReview: true }),
      ).status,
    ).toBe('ready')
  })

  it('counts another peer review of a Primary-authored new plan as another discussion round', () => {
    const current = draft()
    const reviewed = settleCollaboration(
      dispatch(current, 'continue'),
      result({
        submission: 'plan_review',
        reviewedPlan: current.planReference,
        verdict: 'changes_requested',
        todoDeltas: [delta()],
      }),
      facts({ ledgerRevision: 1, ledgerOpenCount: 1 }),
    )
    const revised = settleCollaboration(
      dispatch(reviewed, 'continue'),
      result({
        submission: 'plan_submission',
        plan: 'Revised full plan',
      }),
      facts({ ledgerRevision: 1, ledgerOpenCount: 1 }),
    )
    expect(revised.discussionRounds).toBe(1)
    expect(dispatch(revised, 'continue')).toMatchObject({ actor: 'claude', discussionRounds: 2 })
  })

  it('keeps the exact failed duty and restores a proved-unsent discussion reservation on retry', () => {
    const failed = task({
      stage: 'discuss',
      status: 'failed',
      discussionRounds: 0,
      discussionHalf: true,
      releasedReservation: true,
      actor: 'claude',
      duty: 'plan_review',
      plan: 'Current plan',
      planAuthor: 'codex',
      planVersion: 1,
    })
    expect(dispatch(failed, 'retry', { ...limits, maxDiscussionRounds: 1 })).toMatchObject({
      actor: 'claude',
      duty: 'plan_review',
      discussionRounds: 1,
    })
    expect(
      dispatch({ ...failed, discussionRounds: 1, releasedReservation: false }, 'retry', {
        ...limits,
        maxDiscussionRounds: 1,
      }).discussionRounds,
    ).toBe(1)
  })

  it.each(['waiting', 'paused', 'failed'] as const)('rejects execute from %s', (status) => {
    expect(() =>
      dispatch(task({ status, stage: 'review', plan: 'v1', planVersion: 1 }), 'execute'),
    ).toThrow(/.+/)
  })

  it('finishes build only after an independent Review and counts repair plus rereview as one cycle', () => {
    const implementation = settleCollaboration(
      task({
        kind: 'build',
        stage: 'implement',
        actor: 'codex',
        implementer: 'codex',
        reviewer: 'claude',
      }),
      result(),
    )
    const reviewer = dispatch(implementation, 'continue')
    expect(reviewer).toMatchObject({ stage: 'review', actor: 'claude', reviewCycles: 1 })
    const requested = settleCollaboration(
      reviewer,
      result({
        submission: 'code_review',
        verdict: 'changes_requested',
        todoDeltas: [delta()],
      }),
      facts({ ledgerRevision: 1, ledgerOpenCount: 1 }),
    )
    const repair = dispatch(requested, 'repair')
    expect(repair).toMatchObject({
      stage: 'repair',
      actor: 'codex',
      repairAttempts: 1,
      reviewCycles: 1,
    })
    const proposed = settleCollaboration(
      repair,
      result({
        todoDeltas: [
          delta({
            operation: 'propose_resolution',
            expectedRevision: 1,
            resolutionKind: 'resolved',
            reason: 'Released the pending request.',
          }),
        ],
      }),
      facts({ ledgerRevision: 2, ledgerAwaitingCount: 1 }),
    )
    expect(proposed.status).toBe('waiting')
    const rereview = dispatch(proposed, 'continue')
    expect(rereview).toMatchObject({
      stage: 'review',
      actor: 'claude',
      reviewCycles: 1,
      rereview: true,
    })
    expect(
      settleCollaboration(
        rereview,
        result({ submission: 'code_review', verdict: 'accepted' }),
        facts({ ledgerRevision: 3, doneTodoCount: 1, acceptedReview: true }),
      ).status,
    ).toBe('complete')
  })

  it('reserves a new cycle only when a failed rereview requires another explicit response or repair', () => {
    const first = task({
      kind: 'build',
      stage: 'review',
      status: 'waiting',
      actor: 'claude',
      reviewer: 'claude',
      implementer: 'codex',
      reviewCycles: 1,
      ledgerOpenCount: 1,
    })
    const repair = dispatch(first, 'repair')
    expect(repair).toMatchObject({ reviewCycles: 1, repairAttempts: 1 })
    const proposed = settleCollaboration(repair, result(), facts({ ledgerAwaitingCount: 1 }))
    const rereview = dispatch(proposed, 'continue')
    expect(rereview).toMatchObject({ reviewCycles: 1, rereview: true })
    const remaining = settleCollaboration(
      rereview,
      result({ submission: 'code_review', verdict: 'changes_requested' }),
      facts({ ledgerOpenCount: 1 }),
    )
    expect(remaining).toMatchObject({ status: 'waiting', reviewCycles: 1, nextCycle: true })
    expect(() => dispatch(remaining, 'repair', { ...limits, maxReviewCycles: 1 })).toThrow(/limit/)
    expect(() => dispatch(remaining, 'respond', { ...limits, maxReviewCycles: 1 })).toThrow(/limit/)
    const nextRepair = dispatch(remaining, 'repair')
    expect(nextRepair).toMatchObject({ reviewCycles: 2, repairAttempts: 2, nextCycle: false })
    const nextResponse = dispatch(remaining, 'respond')
    expect(nextResponse).toMatchObject({ reviewCycles: 2, repairAttempts: 1, nextCycle: false })
    const handled = settleCollaboration(nextResponse, result(), facts({ ledgerAwaitingCount: 1 }))
    expect(dispatch(handled, 'continue')).toMatchObject({ reviewCycles: 2, rereview: true })
  })

  it('keeps a not-adopted proposal awaiting independent confirmation', () => {
    const reviewed = task({
      kind: 'review',
      stage: 'review',
      status: 'waiting',
      ledgerOpenCount: 1,
      reviewCycles: 1,
    })
    const response = dispatch(reviewed, 'respond')
    expect(response).toMatchObject({ stage: 'respond', actor: 'claude', repairAttempts: 0 })
    const proposed = settleCollaboration(
      response,
      result({
        todoDeltas: [
          delta({
            operation: 'propose_resolution',
            expectedRevision: 1,
            resolutionKind: 'not_adopted',
            reason: 'The request belongs to the existing owner.',
          }),
        ],
      }),
      facts({ ledgerRevision: 2, ledgerAwaitingCount: 1 }),
    )
    expect(proposed.status).toBe('waiting')
    const confirmed = settleCollaboration(
      dispatch(proposed, 'continue'),
      result({ submission: 'code_review', verdict: 'accepted' }),
      facts({ ledgerRevision: 3, doneTodoCount: 1, acceptedReview: true }),
    )
    expect(confirmed.status).toBe('complete')
  })

  it('allows the already reserved rereview after limits lower but rejects a new repair reservation', () => {
    const repaired = task({
      kind: 'build',
      stage: 'repair',
      status: 'waiting',
      reviewCycles: 2,
      repairAttempts: 2,
    })
    const lowered = { ...limits, maxReviewCycles: 1, maxRepairAttempts: 1 }
    expect(dispatch(repaired, 'continue', lowered).reviewCycles).toBe(2)
    expect(() =>
      dispatch(task({ ...repaired, stage: 'review', ledgerOpenCount: 1 }), 'repair', lowered),
    ).toThrow(/limit/)
  })

  it('ordinary readonly supplements preserve a due rereview and its existing cycle', () => {
    const repaired = task({
      kind: 'build',
      stage: 'repair',
      actor: 'codex',
      implementer: 'codex',
      reviewer: 'claude',
      status: 'waiting',
      reviewCycles: 1,
      repairAttempts: 1,
      ledgerAwaitingCount: 1,
    })
    let current = repaired
    for (let i = 0; i < 2; i++) {
      const supplement = prepareCollaborationSupplement(current, 'codex', limits)
      expect(supplement).toMatchObject({
        stage: 'supplement',
        duty: 'stage_result',
        reviewCycles: 1,
        repairAttempts: 1,
      })
      current = settleCollaboration(supplement, result(), facts({ ledgerAwaitingCount: 1 }))
    }
    expect(dispatch(current, 'continue', { ...limits, maxReviewCycles: 1 })).toMatchObject({
      stage: 'review',
      actor: 'claude',
      rereview: true,
      reviewCycles: 1,
    })
  })

  it('routes answers directly to the original non-Primary implementer without a clarify/answer hop', () => {
    const stopped = settleCollaboration(
      task({ kind: 'build', stage: 'implement', actor: 'claude', implementer: 'claude' }),
      result({
        outcome: 'needs_user',
        todoDeltas: [delta({ todoId: 'scope', kind: 'decision', question })],
      }),
      facts({ ledgerRevision: 1, ledgerOpenCount: 1, unansweredCount: 1, questionPendingCount: 1 }),
    )
    const answer = prepareCollaborationSupplement(stopped, 'claude', limits)
    expect(answer).toMatchObject({
      stage: 'supplement',
      actor: 'claude',
      duty: 'stage_result',
      resumePhase: { stage: 'implement', actor: 'claude', workPending: true },
    })
    expect(collaborationActionSchema.safeParse('answer').success).toBe(false)
    const handled = settleCollaboration(
      answer,
      result(),
      facts({ ledgerRevision: 2, doneTodoCount: 1 }),
    )
    expect(handled.status).toBe('waiting')
    expect(dispatch(handled, 'continue')).toMatchObject({
      stage: 'implement',
      actor: 'claude',
      repairAttempts: 0,
      resumePhase: undefined,
    })
  })

  it('cannot resume writing until the necessary question is actually concluded', () => {
    const pending = task({
      kind: 'build',
      stage: 'supplement',
      status: 'waiting',
      actor: 'claude',
      resumePhase: { stage: 'implement', actor: 'claude', status: 'questions', workPending: true },
      unansweredCount: 0,
      questionPendingCount: 1,
    })
    expect(() => dispatch(pending, 'continue')).toThrow(/required user questions/)
    expect(() =>
      dispatch(task({ ...pending, stage: 'review', ledgerOpenCount: 1 }), 'repair'),
    ).toThrow(/.+/)
  })

  it('a Primary supplement revising a ready Secondary draft invalidates the old review', () => {
    const ready = acceptedPlan('claude')
    const changed = settleCollaboration(
      prepareCollaborationSupplement(ready, 'codex', limits),
      result({ submission: 'plan_submission', plan: 'New source' }),
    )
    expect(changed).toMatchObject({
      status: 'waiting',
      planVersion: 2,
      approvedPlanVersion: undefined,
      reviewedPlan: undefined,
    })
    expect(dispatch(changed, 'continue').actor).toBe('claude')
  })

  it('coalesces only the frozen reviewer duty and keeps readonly answer turns outside review cycle counting', () => {
    const current = task({
      kind: 'review',
      stage: 'review',
      actor: 'codex',
      reviewer: 'codex',
      status: 'questions',
      reviewCycles: 1,
      unansweredCount: 1,
    })
    expect(prepareCollaborationSupplement(current, 'codex', limits)).toMatchObject({
      stage: 'review',
      actor: 'codex',
      duty: 'code_review',
      reviewCycles: 1,
    })
    expect(prepareCollaborationSupplement(current, 'claude', limits)).toMatchObject({
      stage: 'supplement',
      actor: 'claude',
      duty: 'stage_result',
      reviewCycles: 1,
    })
  })

  it('preserves ready state across Not now/resume without creating a Turn', () => {
    const ready = acceptedPlan()
    const paused = advanceCollaboration(ready, 'pause', limits)
    expect(() => dispatch(paused, 'execute')).toThrow(/.+/)
    expect(advanceCollaboration(paused, 'resume', limits)).toMatchObject({
      status: 'ready',
      runId: ready.runId,
    })
  })

  it('a received update after clean Review requires a genuine new review and preserves history', () => {
    const complete = task({
      kind: 'build',
      stage: 'review',
      status: 'complete',
      actor: 'claude',
      implementer: 'codex',
      reviewer: 'claude',
      reviewCycles: 1,
    })
    const handled = settleCollaboration(
      prepareCollaborationSupplement(complete, 'codex', limits),
      result(),
      facts({ inputSequence: 1, processedWatermark: 1 }),
    )
    expect(handled.status).toBe('waiting')
    expect(dispatch(handled, 'continue')).toMatchObject({
      stage: 'review',
      actor: 'claude',
      reviewCycles: 2,
    })
  })

  it('an explicitly retried repair keeps the same Todo identities and reserves the next repair attempt', () => {
    const failed = task({
      kind: 'build',
      stage: 'repair',
      status: 'failed',
      repairAttempts: 1,
      reviewCycles: 1,
      ledgerOpenCount: 1,
      priorResult: result({ todoDeltas: [delta()] }),
    })
    const retry = dispatch(failed, 'retry')
    expect(retry).toMatchObject({
      stage: 'repair',
      repairAttempts: 2,
      priorResult: { todoDeltas: [delta()] },
    })
    expect(
      settleCollaboration(retry, result(), facts({ ledgerOpenCount: 1 })).ledgerOpenCount,
    ).toBe(1)
  })

  it.each(['blocked', 'paused'] as const)(
    'a %s formal review never accepts the scope',
    (outcome) => {
      const review = task({ kind: 'review', stage: 'review', reviewCycles: 1 })
      expect(
        settleCollaboration(
          review,
          result({ submission: 'code_review', verdict: 'incomplete', outcome }),
        ).status,
      ).toBe(outcome === 'blocked' ? 'failed' : 'paused')
      expect(() =>
        settleCollaboration(
          review,
          result({ submission: 'code_review', verdict: 'accepted', outcome }),
          facts({ acceptedReview: true }),
        ),
      ).toThrow(/acceptance/)
    },
  )
})

describe('required plan and frozen settlement', () => {
  it('requires exact duty and a Repository-proved review rather than trusting accepted prose', () => {
    const current = draft()
    const peer = dispatch(current, 'continue')
    const report = result({
      submission: 'plan_review',
      reviewedPlan: current.planReference,
      verdict: 'accepted',
    })
    expect(() => settleCollaboration(task(), result())).toThrow(/frozen duty/)
    expect(() => settleCollaboration(peer, report)).toThrow(/acceptance/)
    expect(() => settleCollaboration(peer, report, facts({ acceptedReview: false }))).toThrow(
      /acceptance/,
    )
    expect(() =>
      settleCollaboration(
        peer,
        result({ submission: 'plan_review', reviewedPlan: current.planReference }),
      ),
    ).toThrow(/verdict/)
    expect(() =>
      settleCollaboration(
        task({ kind: 'build', stage: 'implement' }),
        result({ verdict: 'accepted' }),
      ),
    ).toThrow(/cannot claim/)
  })

  it.each(['needs_user', 'paused', 'blocked'] as const)(
    'publishes a complete provisional plan before %s',
    (outcome) => {
      const report = result({
        submission: 'plan_submission',
        outcome,
        plan: 'Known scope and unresolved decisions.',
      })
      const next = settleCollaboration(task(), report)
      expect(next.plan).toBe(report.plan)
      expect(next.planVersion).toBe(1)
      expect(() =>
        settleCollaboration(task(), result({ submission: 'plan_submission', outcome })),
      ).toThrow(/complete plan/)
    },
  )

  it('requires the exact unchanged version, source Run and hash and a frozen code scope', () => {
    const current = draft()
    const peer = dispatch(current, 'continue')
    const ref = current.planReference
    const report = result({ submission: 'plan_review', reviewedPlan: ref, verdict: 'accepted' })
    const next = settleCollaboration(peer, report, facts({ acceptedReview: true }))
    expect(next.status).toBe('ready')
    expect(collaborationSubmittedPlan(peer, { ...report, plan: ref })).toBe(current.plan)
    for (const bad of [
      { ...ref, version: 2 },
      { ...ref, sourceRunId: crypto.randomUUID() },
      { ...ref, sha256: 'b'.repeat(64) },
    ])
      expect(() =>
        settleCollaboration(
          peer,
          { ...report, reviewedPlan: bad },
          facts({ acceptedReview: true }),
        ),
      ).toThrow(/reference/)
    const scope = { id: crypto.randomUUID(), sha256: 'b'.repeat(64), bytes: 20, chars: 20 }
    const reviewed = task({ kind: 'review', stage: 'review' })
    reviewed.authorization = {
      runId: reviewed.runId,
      taskId: reviewed.id,
      actor: reviewed.actor,
      duty: 'code_review',
      basePlanRef: null,
      baseTodoRevision: 0,
      inputWatermark: 0,
      inputSequence: 0,
      inputBatchId: null,
      inputBatchRef: null,
      basis: null,
      requiredInputScopeRef: null,
      effectiveDecisionIndexRef: null,
      todoIdentityIndexRef: null,
      reviewScopeRef: scope,
    }
    expect(() =>
      settleCollaboration(
        reviewed,
        result({
          submission: 'code_review',
          verdict: 'accepted',
          reviewScopeRef: { ...scope, id: crypto.randomUUID() },
        }),
        facts({ acceptedReview: true }),
      ),
    ).toThrow(/frozen scope/)
  })

  it.each([
    { ledgerOpenCount: 1 },
    { ledgerAwaitingCount: 1 },
    { unansweredCount: 1 },
    { inputSequence: 3, processedWatermark: 1 },
  ])('full ledger or continuous watermark blocks acceptance: %j', (unresolved) => {
    const current = draft()
    expect(() =>
      settleCollaboration(
        dispatch(current, 'continue'),
        result({
          submission: 'plan_review',
          reviewedPlan: current.planReference,
          verdict: 'accepted',
          todoDeltas: [],
          inputResponses: [],
        }),
        facts({ acceptedReview: true, doneTodoCount: 19, ...unresolved }),
      ),
    ).toThrow(/acceptance/)
  })

  it('retained Done history does not block ready and late input prevents a frozen review becoming current approval', () => {
    const current = draft()
    const report = result({
      submission: 'plan_review',
      reviewedPlan: current.planReference,
      verdict: 'accepted',
    })
    const peer = dispatch(current, 'continue')
    expect(
      settleCollaboration(
        peer,
        report,
        facts({ acceptedReview: true, ledgerRevision: 19, doneTodoCount: 19 }),
      ).status,
    ).toBe('ready')
    const late = settleCollaboration(
      peer,
      report,
      facts({
        acceptedReview: true,
        reviewInputSequence: 1,
        inputSequence: 2,
        processedWatermark: 1,
      }),
    )
    expect(late.status).toBe('waiting')
    expect(late.reviewedInputWatermark).toBe(1)
  })

  it('keeps document-backed plans authoritative and invalidates acceptance only when content changes', () => {
    const source = { id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 60000, chars: 20000 }
    const ref = {
      type: 'unchanged' as const,
      version: 1,
      sourceRunId: crypto.randomUUID(),
      sha256: source.sha256,
    }
    const ready = task({
      status: 'ready',
      stage: 'discuss',
      actor: 'claude',
      planDocument: source,
      planReference: ref,
      planVersion: 1,
      planAuthor: 'codex',
      reviewedPlan: ref,
    })
    expect(dispatch(ready, 'execute').approvedPlanVersion).toBe(1)
    const same = settleCollaboration(
      { ...ready, actor: 'codex', status: 'running' },
      result({ submission: 'plan_submission', plan: ref }),
    )
    expect(same.planVersion).toBe(1)
    expect(same.reviewedPlan).toEqual(ref)
    const changed = settleCollaboration(
      { ...ready, actor: 'codex', status: 'running' },
      result({ submission: 'plan_submission', plan: 'Revised full plan' }),
    )
    expect(changed.planVersion).toBe(2)
    expect(changed.reviewedPlan).toBeUndefined()
    expect(changed.approvedPlanVersion).toBeUndefined()
  })
})

describe('v5 trust and transport boundaries', () => {
  it('requires every native object property and non-null plans only for the publishing duty', () => {
    const schema = collaborationOutputSchema(task())
    const fields = nativeObjectFields(schema)
    expect(fields.length).toBeGreaterThan(1)
    for (const field of fields) expect(field.required).toEqual(field.keys)
    const shape = property(property(schema, 'properties'), 'result')
    const plan = property(property(shape, 'properties'), 'plan')
    expect(property(plan, 'type')).toBe('string')
    expect(property(plan, 'minLength')).toBe(1)
    const current = draft()
    const review = collaborationOutputSchema(dispatch(current, 'continue'))
    const report = property(property(review, 'properties'), 'result')
    expect(property(property(property(report, 'properties'), 'plan'), 'type')).toBe('null')
    expect(
      property(
        property(property(property(report, 'properties'), 'reviewedPlan'), 'properties'),
        'sha256',
      ),
    ).toEqual({ type: 'string', const: current.planReference.sha256 })
  })

  it('keeps full UTF-8 report bodies and 80 deltas while bounding a disposable projection', () => {
    const full = result({
      submission: 'plan_submission',
      plan: '界😀'.repeat(20_000),
      summary: 'Summary '.repeat(1000),
      todoDeltas: Array.from({ length: 80 }, (_, i) =>
        delta({
          todoId: `distinct-${i}`,
          detail: 'Escaped "text"\\ and UTF-8 界😀. '.repeat(1000),
        }),
      ),
    })
    expect(full.todoDeltas).toHaveLength(80)
    expect(full.plan).toBe('界😀'.repeat(20_000))
    expect(() => collaborationViewSchema.parse({ task: task({ result: full }) })).toThrow(/.+/)
    const carrier = {
      version: 'pact-collaboration-envelope-v5',
      answer: 'The full plan was submitted.',
      result: { ...full, reviewedPlan: null, reviewScopeRef: null, verdict: null },
    }
    expect(collaborationEnvelopeSchema.parse(carrier).result).toEqual(full)
    expect(() =>
      collaborationEnvelopeSchema.parse({ ...carrier, version: 'pact-collaboration-envelope-v4' }),
    ).toThrow(/version/)
  })

  it('rejects legacy carriers, duplicate Todo mutations and duplicate exact Batch members', () => {
    expect(() =>
      collaborationResultSchema.parse({
        ...result(),
        feedback: [],
        questions: [],
        commentResponses: [],
      }),
    ).toThrow(/Unrecognized keys/)
    expect(() => result({ todoDeltas: [delta(), delta()] })).toThrow(/once/)
    const response = {
      batchId: crypto.randomUUID(),
      memberId: '$body',
      disposition: 'resolved' as const,
      reason: 'Applied the scope update.',
      todoId: null,
    }
    expect(() => result({ inputResponses: [response, response] })).toThrow(/unique/)
    expect(
      result({ inputResponses: [response, { ...response, batchId: crypto.randomUUID() }] })
        .inputResponses,
    ).toHaveLength(2)
  })

  it('validates question kind, choices and recommendations without synthetic text-question choices', () => {
    const ask = delta({ kind: 'decision', question })
    expect(result({ todoDeltas: [ask] }).todoDeltas[0]?.question?.answerResolver).toBe('claude')
    for (const invalid of [
      { ...question, recommended: 2 },
      { ...question, options: ['Same', 'Same'] },
      { ...question, options: ['One'] },
    ])
      expect(() => result({ todoDeltas: [{ ...ask, question: invalid }] })).toThrow(/.+/)
    expect(() => result({ todoDeltas: [delta({ kind: 'decision' })] })).toThrow(
      /question definition/,
    )
    expect(() => result({ todoDeltas: [delta({ kind: 'information', question })] })).toThrow(
      /matching Todo kind/,
    )
    const text = { ...question, type: 'text' as const, options: [], recommended: null }
    expect(
      result({ todoDeltas: [delta({ kind: 'information', question: text })] }).todoDeltas,
    ).toHaveLength(1)
    expect(() =>
      result({
        todoDeltas: [delta({ kind: 'information', question: { ...text, options: ['Synthetic'] } })],
      }),
    ).toThrow(/artificial choices/)
    expect(() =>
      result({
        todoDeltas: Array.from({ length: 4 }, (_, i) =>
          delta({
            todoId: `question-${i}`,
            kind: 'decision',
            question: { ...question, id: `question-${i}` },
          }),
        ),
      }),
    ).toThrow(/at most three/)
  })

  it('requires new Todo revision zero and reasons on every proposed, confirmed or reopened resolution', () => {
    expect(() => result({ todoDeltas: [delta({ expectedRevision: 1 })] })).toThrow(/revision zero/)
    for (const operation of ['propose_resolution', 'confirm', 'reopen'] as const)
      expect(() =>
        result({ todoDeltas: [delta({ operation, expectedRevision: 1, reason: ' ' })] }),
      ).toThrow(/reason/)
  })

  it('requires the exact source capability and limits Todo pages by item count and bytes', () => {
    const read = {
      runId: crypto.randomUUID(),
      grant: crypto.randomUUID(),
      source: 'todos',
      taskId: crypto.randomUUID(),
      revision: 1,
      offset: 0,
    }
    expect(collaborationSourceReadSchema.parse(read).grant).toBe(read.grant)
    expect(() => collaborationSourceReadSchema.parse({ ...read, grant: undefined })).toThrow(/.+/)
    const item = {
      taskId: read.taskId,
      id: 'lifecycle',
      revision: 1,
      kind: 'opinion',
      status: 'open',
      title: 'Release resources',
      author: 'codex',
      answerResolver: null,
      needsUserAnswer: false,
      question: null,
      resolutionKind: null,
      resolutionReasonPreview: '',
      document: { id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 30, chars: 30 },
      sourceRunId: read.runId,
      sourceMessageId: crypto.randomUUID(),
    }
    const page = {
      taskId: read.taskId,
      ledgerRevision: 1,
      group: 'active',
      items: [item],
      offset: 0,
      nextOffset: null,
      activeCount: 1,
      doneCount: 19,
    }
    expect(collaborationTodoPageSchema.parse(page).items).toHaveLength(1)
    expect(() =>
      collaborationTodoPageSchema.parse({ ...page, items: Array.from({ length: 25 }, () => item) }),
    ).toThrow(/.+/)
    expect(() =>
      collaborationTodoPageSchema.parse({
        ...page,
        items: [{ ...item, title: '界'.repeat(20000) }],
      }),
    ).toThrow(/byte budget/)
  })
})
