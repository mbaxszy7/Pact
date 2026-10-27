import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  type CollaborationAction,
  type RelayDecisionAnswer,
} from '@pact/contracts'

import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentRuns,
  collaborationActionReceipts,
  relayDecisions,
  schedulingBudgetReservations,
  schedulingEvaluations,
} from './schema/index.js'

const fixtures: Awaited<ReturnType<typeof planRevisionFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})
type Workflow = Awaited<ReturnType<typeof planRevisionFixture>>

function start(f: Workflow, action: CollaborationAction = 'continue') {
  const task = f.repo.collaboration(f.sessionId)!,
    session = f.db.sessionRepository.find(f.sessionId)!,
    clientMessageId = randomUUID(),
    prepared =
      action === 'execute' || action === 'respond' || action === 'repair'
        ? f.repo.prepareCollaborationAction(
            {
              sessionId: f.sessionId,
              taskId: task.id,
              revision: task.revision,
              clientMessageId,
              action,
            },
            session.settings,
          )
        : undefined,
    next = prepared?.next ?? advanceCollaboration(task, action, session.settings)
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId,
    content: 'Continue the exact authorized workflow.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: next.actor,
    settingsRevision: session.settingsRevision,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: task.revision,
    collaboration: next,
    schedulingHandoff: prepared?.handoff ?? f.repo.workflowHandoff(task, next.actor),
    ...(prepared ? { collaborationActionReceiptId: prepared.receipt.id } : {}),
  }).run
}

async function workflow(
  options: { repairLimit?: number; reviewLimit?: number; priorRepair?: boolean } = {},
) {
  const f = await planRevisionFixture()
  fixtures.push(f)
  const revision = f.repo.beginRun(f.admission()).run
  f.finish(revision.id, { plan: 'Complete accepted implementation and cancellation scope.' })
  const acceptedPlan = f.repo.beginRun(f.admission()).run
  f.finish(acceptedPlan.id, { verdict: 'accepted' })
  const current = f.db.sessionRepository.find(f.sessionId)!
  f.db.sessionRepository.saveSettings(f.sessionId, {
    ...current.settings,
    ...(options.repairLimit === undefined ? {} : { maxRepairAttempts: options.repairLimit }),
    ...(options.reviewLimit === undefined ? {} : { maxReviewCycles: options.reviewLimit }),
  })
  const implementation = start(f, 'execute')
  f.finish(implementation.id, { answer: 'Implemented the exact accepted cancellation scope.' })
  const firstReview = start(f)
  f.finish(firstReview.id, {
    verdict: 'changes_requested',
    answer: 'Cancellation still needs its owned cleanup path.',
  })
  const response = start(f, options.priorRepair ? 'repair' : 'respond')
  f.finish(response.id, { answer: 'Complete response to the original cancellation finding.' })
  const review = start(f)
  f.finish(review.id, {
    verdict: 'changes_requested',
    answer: 'The second complete review identifies the same concrete cleanup correction.',
  })
  const task = f.repo.collaboration(f.sessionId)!,
    handoff = f.repo.workflowHandoff(task, task.owner)
  return { ...f, implementation, firstReview, response, review, task, handoff }
}

async function evaluated() {
  const f = await workflow(),
    deadlineAt = Date.now() + 15_000
  expect(f.repo.relayRepairOpportunity(f.handoff)).toMatchObject({
    kind: 'repair',
    taskId: f.task.id,
    afterRunId: f.review.id,
    actor: f.task.owner,
    returnActor: f.task.reviewer,
    budgetAvailable: true,
  })
  const material = await f.repo.readRelayWorkflowDecisionSources(
    f.handoff,
    [
      {
        id: 'propose_repair',
        description:
          'Request one scoped repair of the concrete current review finding, then return to the fixed reviewer.',
      },
    ],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff: f.handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    deadlineAt,
    inputSha256: material.inputSha256,
  })
  if (reserved.status !== 'reserved') throw Error('Expected the one current evaluation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'propose_repair',
  })
  const proposal = {
    handoff: f.handoff,
    kind: 'repair' as const,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason:
      'Repair the owned cancellation cleanup identified by both complete current-scope reviews.',
    sourceIds: material.sources.map((entry) => entry.id),
  }
  return { ...f, material, proposal }
}

async function proposed() {
  const f = await evaluated(),
    card = f.repo.proposeRelayWorkflowAction(f.proposal)
  const answer: RelayDecisionAnswer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  }
  return { ...f, card, answer }
}
type Proposed = Awaited<ReturnType<typeof proposed>>

function confirmedAdmission(f: Proposed) {
  const accepted = f.repo.answerRelaySchedulingDecision(f.answer)
  if (!('receiptId' in accepted) || !accepted.receiptId)
    throw Error('Missing the confirmed exact repair receipt')
  const prepared = f.repo.preparedRelayWorkflowAction(accepted.receiptId),
    session = f.db.sessionRepository.find(f.sessionId)!
  return {
    accepted,
    prepared,
    input: {
      sessionId: f.sessionId,
      clientMessageId: f.answer.clientOperationId,
      content: 'Perform the one exact approved cleanup repair.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: prepared.next.actor,
      settingsRevision: session.settingsRevision,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: prepared.task.revision,
      collaboration: prepared.next,
      schedulingHandoff: prepared.handoff,
      collaborationActionReceiptId: prepared.receipt.id,
    },
  }
}

describe('Relay repair decisions through the original workflow owner', () => {
  it('has no repair grant or extra allowance before confirmation, then admits one normal Repair and its fixed review', async () => {
    const f = await proposed(),
      before = f.repo.collaboration(f.sessionId)!,
      count = f.db.drizzle.select().from(agentRuns).all().length
    expect(f.card.request).toMatchObject({
      category: 'new_authorization',
      operation: {
        kind: 'repair',
        taskId: before.id,
        afterRunId: f.review.id,
        actor: before.owner,
        returnActor: before.reviewer,
      },
    })
    expect(f.repo.relayWorkflowUserGrants(f.handoff, f.material.snapshot)).toEqual({})
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.decisionId, f.card.decisionId))
        .all(),
    ).toEqual([])
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(0)
    const { accepted, prepared, input } = confirmedAdmission(f)
    expect(prepared.next).toMatchObject({
      stage: 'repair',
      actor: before.owner,
      repairAttempts: 1,
      reviewCycles: before.reviewCycles,
    })
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    const repaired = f.repo.beginRun(input)
    expect(f.repo.beginRun(input)).toMatchObject({ created: false, run: { id: repaired.run.id } })
    const auth = f.repo.collaborationTurnAuthorization(repaired.run.id)!
    expect(auth).toMatchObject({
      stage: 'repair',
      actor: before.owner,
      reviewScopeRef: before.reviewScopeRef,
      userAuthority: {
        receiptId: prepared.receipt.id,
        rootReceiptId: prepared.receipt.id,
        purpose: 'action',
      },
    })
    expect(auth.userAuthority?.returnActor).toBeUndefined()
    expect(auth.relayWorkRef).toBeDefined()
    const approved: unknown = JSON.parse(f.readDocument(auth.relayWorkRef!))
    expect(approved).toMatchObject({
      responsibility: f.proposal.reason,
      operation: { kind: 'repair', scopeFingerprint: f.material.sourceFingerprint },
    })
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, prepared.receipt.id))
        .get(),
    ).toMatchObject({
      action: 'repair',
      state: 'bound',
      boundRunId: repaired.run.id,
      reviewState: null,
      reviewRunId: null,
    })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      stage: 'repair',
      repairAttempts: 1,
      reviewCycles: 2,
    })
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)).toMatchObject({
      extraCodeTurns: 1,
      extraPlanTurns: 0,
      evaluationCalls: 1,
    })
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([
      expect.objectContaining({ budget: 'extra_code_turn', authorizationId: prepared.receipt.id }),
    ])
    for (const source of f.material.sources)
      expect(f.repo.sourceDocumentAuthorized(repaired.run.id, source.document)).toBe(true)
    f.finish(repaired.run.id, { answer: 'The exact approved cancellation cleanup is repaired.' })
    const review = start(f)
    expect(review.agentId).toBe(before.reviewer)
    expect(review.collaboration?.stage).toBe('code_review')
    f.finish(review.id, { verdict: 'accepted' })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      id: before.id,
      status: 'complete',
      repairAttempts: 1,
      reviewCycles: 3,
    })
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(count + 2)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
    expect(f.repo.answerRelaySchedulingDecision(f.answer)).toEqual({
      created: false,
      result: { ...accepted.result, runId: repaired.run.id },
    })
    expect(() =>
      f.repo.answerRelaySchedulingDecision({ ...f.answer, clientOperationId: randomUUID() }),
    ).toThrow('different answer')
    expect(f.db.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  it.each(['repair', 'respond'] as const)(
    'lets an already-acquired manual %s receipt win against delayed advice',
    async (action) => {
      const f = await evaluated(),
        task = f.repo.collaboration(f.sessionId)!,
        settings = f.db.sessionRepository.find(f.sessionId)!.settings
      const manual = f.repo.prepareCollaborationAction(
        {
          sessionId: f.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: randomUUID(),
          action,
        },
        settings,
      )
      expect(manual.handoff?.id).toBe(f.handoff.id)
      expect(f.repo.relayRepairOpportunity(f.handoff)).toBeUndefined()
      expect(() => f.repo.proposeRelayWorkflowAction(f.proposal)).toThrow('no longer current')
      expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
      expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
      expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(0)
    },
  )

  it('lets a concrete manual Repair supersede an unanswered suggestion without consuming its auxiliary allowance', async () => {
    const f = await proposed(),
      task = f.repo.collaboration(f.sessionId)!,
      settings = f.db.sessionRepository.find(f.sessionId)!.settings
    const manual = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: randomUUID(),
        action: 'repair',
      },
      settings,
    )
    expect(manual.receipt.action).toBe('repair')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.db.drizzle.select().from(relayDecisions).get()).toMatchObject({
      state: 'cancelled',
      active: false,
      answerNonce: null,
    })
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(
      'no longer awaiting an answer',
    )
  })

  it.each([
    { label: 'ordinary repair limit', options: { repairLimit: 1, priorRepair: true } },
    { label: 'fixed reviewer return limit', options: { reviewLimit: 2 } },
  ])('does not offer extra work after the $label is exhausted', async ({ options }) => {
    const f = await workflow(options)
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      reviewCycles: 2,
      repairAttempts: options.priorRepair ? 1 : 0,
      review: { verdict: 'changes_requested' },
    })
    expect(f.repo.relaySupplementOpportunity(f.handoff)?.kind).toBe(
      options.priorRepair ? 'supplement_code_response' : undefined,
    )
    expect(f.repo.relayRepairOpportunity(f.handoff)).toBeUndefined()
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)).toBeUndefined()
  })

  it('rejects the old review scope after the host workflow facts change and leaves both counters untouched', async () => {
    const f = await proposed(),
      before = f.repo.collaboration(f.sessionId)!
    f.repo.setCollaborationState({
      ...before,
      revision: before.revision + 1,
      reviewScopeRef: before.taskDocument,
    })
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow('handoff facts changed')
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.decisionId, f.card.decisionId))
        .all(),
    ).toEqual([])
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(0)
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraCodeTurns).toBe(0)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })
})
