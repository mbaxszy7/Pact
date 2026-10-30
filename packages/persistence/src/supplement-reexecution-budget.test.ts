import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { FrozenExecutionEnvelope } from '@pact/contracts'

import type { PactDatabase } from './pact-database.js'

import {
  handoff,
  fingerprint,
  reacquireUnsentExtraTurnBudget,
  reserveBudget,
} from './conversation-scheduling.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentRuns,
  collaborationActionReceipts,
  relayDecisions,
  runExecutionInputs,
  runReexecutionOperations,
  schedulingBudgetCounters,
  schedulingBudgetReservations,
  schedulingRecoveryFaults,
} from './schema/index.js'

const databases = new Set<PactDatabase>()
afterEach(() => {
  for (const db of databases) db.close()
  databases.clear()
})

function beginManualAction(
  f: Awaited<ReturnType<typeof planRevisionFixture>>,
  action: 'execute' | 'respond',
) {
  const task = f.repo.collaboration(f.sessionId)!,
    clientMessageId = randomUUID(),
    settings = f.db.sessionRepository.find(f.sessionId)!.settings,
    prepared = f.repo.prepareCollaborationAction(
      { sessionId: f.sessionId, taskId: task.id, revision: task.revision, clientMessageId, action },
      settings,
    ),
    drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing action drafts')
  if (!prepared.next) throw Error('Missing prepared action transition')
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId,
    content: 'Perform the explicitly authorized workflow action.',
    commentIds: [],
    expectedCommentsRevision: drafts.commentsRevision,
    agentId: prepared.next.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: task.revision,
    collaboration: prepared.next,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }).run
}

async function originalSupplement(kind: 'supplement_plan' | 'repair' = 'supplement_plan') {
  const f = await planRevisionFixture()
  databases.add(f.db)
  const epoch = randomUUID()
  f.repo.beginSchedulingRecoveryEpoch(epoch)
  const firstResponse = f.repo.beginRun(f.admission()).run
  f.finish(firstResponse.id, { plan: 'First revised Plan.' })
  const review = f.repo.beginRun(f.admission()).run
  f.finish(review.id, {
    verdict: kind === 'repair' ? 'accepted' : 'changes_requested',
    answer: 'The complete fixed review of the current Plan.',
  })
  if (kind === 'repair') {
    const implementation = beginManualAction(f, 'execute')
    f.finish(implementation.id, { answer: 'Complete implementation within the accepted scope.' })
    const codeReview = f.repo.beginRun(f.admission()).run
    f.finish(codeReview.id, {
      verdict: 'changes_requested',
      answer: 'The first full code review requires cancellation repair.',
    })
    const response = beginManualAction(f, 'respond')
    f.finish(response.id, { answer: 'The original author’s complete read-only response.' })
    const repeated = f.repo.beginRun(f.admission()).run
    f.finish(repeated.id, {
      verdict: 'changes_requested',
      answer: 'The second full review still requires the exact cancellation repair.',
    })
  } else {
    const response = f.repo.beginRun(f.admission()).run
    f.finish(response.id, { plan: 'The current complete Plan before the extra clarification.' })
  }
  const task = f.repo.collaboration(f.sessionId)!,
    originalHandoff = f.repo.workflowHandoff(task, task.owner),
    deadlineAt = Date.now() + 15_000
  const material = await f.repo.readRelayWorkflowDecisionSources(
    originalHandoff,
    [
      {
        id: kind === 'repair' ? 'propose_repair' : 'propose_supplement_plan',
        description:
          kind === 'repair'
            ? 'Request one exact authorized repair before the fixed review.'
            : 'Request one original read-only clarification.',
      },
    ],
    { signal: new AbortController().signal, deadlineAt },
  )
  const evaluation = f.repo.reserveEvaluation({
    handoff: originalHandoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    inputSha256: material.inputSha256,
    deadlineAt,
  })
  if (evaluation.status !== 'reserved') throw Error('Missing evaluation')
  f.repo.dispatchEvaluation(evaluation.evaluation.id)
  f.repo.settleEvaluation(evaluation.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: kind === 'repair' ? 'propose_repair' : 'propose_supplement_plan',
  })
  const card = f.repo.proposeRelayWorkflowAction({
    handoff: originalHandoff,
    kind,
    evaluationId: evaluation.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason:
      kind === 'repair'
        ? 'Repair only the exact cancellation defect reported by the complete fixed review.'
        : 'Clarify the original cancellation evidence in one read-only Turn.',
    sourceIds: [material.sources[0]!.id],
  })
  const answer = f.repo.answerRelaySchedulingDecision({
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: 0 },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  })
  if (!('receiptId' in answer) || !answer.receiptId) throw Error('Missing original user grant')
  const prepared = f.repo.preparedRelayWorkflowAction(answer.receiptId),
    content =
      kind === 'repair'
        ? 'Perform only the exact separately approved repair.'
        : 'Perform only the exact approved read-only Plan clarification.'
  const original = f.repo.beginRun({
    sessionId: f.sessionId,
    commentIds: [],
    expectedCommentsRevision: 0,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    clientMessageId: prepared.receipt.clientNonce,
    content,
    collaboration: prepared.next,
    agentId: prepared.next.actor,
    expectedCollaborationRevision: prepared.task.revision,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }).run
  const nativeGeneration = randomUUID(),
    executorId = randomUUID(),
    nativeSessionId = 'fixture-codex'
  f.repo.recordExecutor(original.id, executorId)
  f.repo.applyEvent(f.sessionId, original.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId,
  })
  f.repo.setContinuation(f.sessionId, 'codex', 'ready')
  const inputBatchRef = f.repo.inputBatchForRun(original.id),
    authorization = f.repo.collaborationTurnAuthorization(original.id)!,
    envelope: FrozenExecutionEnvelope = {
      version: 'pact-agent-prompt-v1',
      sessionId: f.sessionId,
      message: { id: original.userMessageId, content },
      comments: [],
      collaboration: f.repo.collaborationPromptState(f.repo.collaboration(f.sessionId)!),
      collaborationAuthorization: authorization,
      ...(inputBatchRef ? { inputBatchRef } : {}),
    }
  const captured = await f.repo.captureExecutionInput({
    runId: original.id,
    nativeGeneration,
    requested: {
      provider: 'codex',
      model: null,
      effort: null,
      speed: 'standard',
      permissionMode: 'native',
    },
    source: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(envelope))
    })(),
    signal: new AbortController().signal,
  })
  if (!captured) throw Error('Missing original frozen execution input')
  f.repo.recordEffectiveExecutionSettings(
    original.id,
    nativeGeneration,
    {
      version: 1,
      provider: 'codex',
      model: 'original-effective-model',
      effort: { known: true, value: null },
      speed: 'standard',
      permissionMode: 'native',
      configurationSha256: 'b'.repeat(64),
      provenance: 'codex_thread_configuration',
    },
    { executorId, nativeSessionId },
  )
  f.repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
  f.repo.recordConfirmedUnsent(
    original.id,
    nativeGeneration,
    { kind: 'codex_root_frame_not_written', requestId: 7 },
    { executorId, nativeSessionId },
  )
  f.repo.failRun(
    original.id,
    'transient_transport',
    'The exact original root frame was not written.',
  )
  f.repo.recordNativeEffects(original.id, 'not_dispatched')
  f.repo.finishCollaboration(original.id, false)
  f.repo.armSchedulingRecoveryFaults(f.sessionId)
  const candidate = f.repo
    .takeSchedulingRecoveryFaults()
    .find((entry) => entry.fault.runId === original.id)
  if (!candidate) throw Error('Missing original stable fault')
  const grant = f.db.drizzle
    .select()
    .from(collaborationActionReceipts)
    .where(eq(collaborationActionReceipts.id, prepared.receipt.id))
    .get()!
  if (!grant.budgetReservationId) throw Error('Missing refunded original allowance')
  const budget = f.db.drizzle
    .select()
    .from(schedulingBudgetReservations)
    .where(eq(schedulingBudgetReservations.id, grant.budgetReservationId))
    .get()!
  expect(grant).toMatchObject({
    state: 'not_sent',
    active: false,
    reviewState: kind === 'repair' ? null : 'not_required',
  })
  expect(budget).toMatchObject({ state: 'not_sent', replacesReservationId: null })
  expect(f.repo.schedulingBudget(originalHandoff.budgetSubjectId)).toMatchObject({
    extraPlanTurns: 0,
    extraCodeTurns: 0,
  })
  return { ...f, original, grant, budget, candidate, epoch, envelope }
}

async function operationFixture(kind: 'supplement_plan' | 'repair' = 'supplement_plan') {
  const f = await originalSupplement(kind),
    operationId = randomUUID(),
    replacementId = randomUUID()
  const node = handoff({
    ...f.candidate.node,
    slot: 'confirmed_resend',
    eventId: `${f.original.id}:confirmed_unsent`,
    factFingerprint: fingerprint([
      f.candidate.node.factFingerprint,
      f.repo.executionInput(f.original.id)!.proof,
    ]),
  })
  f.db.drizzle.transaction((transaction) => {
    const reserved = reserveBudget(transaction, { handoff: node, budget: 'automatic_resend' })
    if (reserved.status !== 'reserved') throw Error('Missing real resend reservation')
    const original = transaction
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, f.original.id))
      .get()!
    transaction
      .insert(agentRuns)
      .values({
        ...original,
        id: replacementId,
        status: 'starting',
        dispatchPhase: 'not_sent',
        nativeEffectsState: 'not_dispatched',
        nativeOutcome: null,
        nativeTurnId: null,
        failureKind: null,
        failureMessage: null,
        reexecutedFromRunId: original.id,
        reexecutionOperationId: operationId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()
    transaction
      .insert(runReexecutionOperations)
      .values({
        id: operationId,
        faultId: f.candidate.fault.id,
        originalRunId: f.original.id,
        replacementRunId: replacementId,
        budgetReservationId: reserved.reservation.id,
        handoffJson: JSON.stringify(node),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()
  })
  const reacquire = () =>
    f.db.drizzle.transaction((transaction) =>
      reacquireUnsentExtraTurnBudget(transaction, f.budget.id, operationId),
    )
  return { ...f, operationId, replacementId, reacquire }
}

describe('refunded supplemental allowance during exact unsent reexecution', () => {
  it('reacquires only the proven-unsent Relay repair allowance while preserving ordinary action authority and fixed code review', async () => {
    const f = await originalSupplement('repair'),
      before = f.repo.collaboration(f.sessionId)!
    expect(f.repo.collaborationTurnAuthorization(f.original.id)?.userAuthority).toEqual({
      receiptId: f.grant.id,
      rootReceiptId: f.grant.rootReceiptId,
      purpose: 'action',
    })
    expect(f.budget.budget).toBe('extra_code_turn')
    const replacement = f.repo.beginConfirmedUnsentReexecution({
        operationId: randomUUID(),
        faultId: f.candidate.fault.id,
        handoff: f.repo.recoveryHandoff({ kind: 'run', id: f.original.id }),
      }),
      grant = f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, f.grant.id))
        .get()!,
      budget = f.db.drizzle
        .select()
        .from(schedulingBudgetReservations)
        .where(eq(schedulingBudgetReservations.id, grant.budgetReservationId!))
        .get()!
    expect(grant).toMatchObject({
      action: 'repair',
      state: 'bound',
      boundRunId: replacement.run.id,
      reviewState: null,
      reviewRunId: null,
      handoffId: f.grant.handoffId,
    })
    expect(budget).toMatchObject({
      budget: 'extra_code_turn',
      handoffId: f.budget.handoffId,
      authorizationId: f.grant.id,
      replacesReservationId: f.budget.id,
    })
    expect(f.repo.collaborationTurnAuthorization(replacement.run.id)?.userAuthority).toEqual({
      receiptId: f.grant.id,
      rootReceiptId: f.grant.rootReceiptId,
      purpose: 'action',
    })
    expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(before.repairAttempts + 1)
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)).toMatchObject({
      extraPlanTurns: 0,
      extraCodeTurns: 1,
    })
    f.finish(replacement.run.id, {
      answer: 'The exact repair completed with complete native output.',
    })
    const review = f.repo.beginRun(f.admission()).run
    expect(review.collaboration?.stage).toBe('code_review')
    expect(review.agentId).toBe('claude')
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraCodeTurns).toBe(1)
  })

  it.each(['legacy', 'nonce', 'operation'] as const)(
    'refuses unsent repair reacquisition after %s provenance changes without spending code allowance',
    async (change) => {
      const f = await operationFixture('repair'),
        decision = f.db.drizzle
          .select()
          .from(relayDecisions)
          .where(eq(relayDecisions.id, f.grant.decisionId!))
          .get()!
      f.db.drizzle
        .update(relayDecisions)
        .set(
          change === 'legacy'
            ? { formatVersion: 1 }
            : change === 'nonce'
              ? { answerNonce: randomUUID() }
              : {
                  proofJson: JSON.stringify({
                    ...JSON.parse(decision.proofJson),
                    operationFingerprint: 'f'.repeat(64),
                  }),
                },
        )
        .where(eq(relayDecisions.id, decision.id))
        .run()
      expect(f.reacquire).toThrow('no longer eligible')
      expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraCodeTurns).toBe(0)
      expect(
        f.db.drizzle
          .select()
          .from(schedulingBudgetReservations)
          .where(eq(schedulingBudgetReservations.replacesReservationId, f.budget.id))
          .all(),
      ).toEqual([])
    },
  )

  it('creates one linked allowance with the original handoff and authorization, without reopening the user decision', async () => {
    const f = await operationFixture(),
      decision = f.db.drizzle.select().from(relayDecisions).get(),
      replacement = f.reacquire()
    expect(replacement).toMatchObject({
      handoffId: f.budget.handoffId,
      authorizationId: f.grant.id,
      budgetSubjectId: f.budget.budgetSubjectId,
      budget: 'extra_plan_turn',
      faultSubjectId: null,
      replacesReservationId: f.budget.id,
      state: 'reserved',
    })
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraPlanTurns).toBe(1)
    expect(f.db.drizzle.select().from(relayDecisions).get()).toEqual(decision)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).get()).toEqual(f.grant)
    expect(f.reacquire()).toEqual(replacement)
    expect(() =>
      f.db.drizzle.transaction((transaction) =>
        reacquireUnsentExtraTurnBudget(transaction, f.budget.id, randomUUID()),
      ),
    ).toThrow('no longer eligible')
    expect(() =>
      f.db.drizzle.transaction((transaction) =>
        reacquireUnsentExtraTurnBudget(transaction, replacement.id, f.operationId),
      ),
    ).toThrow('no longer eligible')
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraPlanTurns).toBe(1)
    expect(
      f.db.drizzle.get(
        sql`SELECT count(*) AS count FROM agent_event_journal WHERE event_type='scheduling.extra_turn_budget_reacquired'`,
      ),
    ).toEqual({ count: 1 })
    expect(
      f.db.drizzle
        .select()
        .from(schedulingBudgetReservations)
        .where(eq(schedulingBudgetReservations.id, f.budget.id))
        .get(),
    ).toEqual(f.budget)
  })

  it.each(['possibly_sent', 'settled'] as const)(
    'refuses an already charged %s original allowance without incrementing again',
    async (state) => {
      const f = await operationFixture()
      f.db.drizzle
        .update(schedulingBudgetReservations)
        .set({ state })
        .where(eq(schedulingBudgetReservations.id, f.budget.id))
        .run()
      expect(f.reacquire).toThrow('no longer eligible')
      expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraPlanTurns).toBe(0)
      expect(
        f.db.drizzle
          .select()
          .from(schedulingBudgetReservations)
          .where(eq(schedulingBudgetReservations.replacesReservationId, f.budget.id))
          .all(),
      ).toEqual([])
    },
  )

  it.each(['input-proof', 'epoch', 'actor', 'exhausted'] as const)(
    'rejects changed %s authority at the accounting seam',
    async (mutation) => {
      const f = await operationFixture()
      if (mutation === 'input-proof')
        f.db.drizzle
          .update(runExecutionInputs)
          .set({
            proofJson: JSON.stringify({
              ...f.repo.executionInput(f.original.id)!.proof,
              inputSha256: 'f'.repeat(64),
            }),
          })
          .where(eq(runExecutionInputs.runId, f.original.id))
          .run()
      if (mutation === 'epoch')
        f.db.drizzle
          .update(schedulingRecoveryFaults)
          .set({ utilityEpoch: randomUUID() })
          .where(eq(schedulingRecoveryFaults.id, f.candidate.fault.id))
          .run()
      if (mutation === 'actor')
        f.db.drizzle
          .update(collaborationActionReceipts)
          .set({ actor: 'claude' })
          .where(eq(collaborationActionReceipts.id, f.grant.id))
          .run()
      if (mutation === 'exhausted')
        f.db.drizzle
          .update(schedulingBudgetCounters)
          .set({ extraPlanTurns: 1 })
          .where(eq(schedulingBudgetCounters.subjectId, f.budget.budgetSubjectId))
          .run()
      const before = f.repo.schedulingBudget(f.budget.budgetSubjectId)
      expect(f.reacquire).toThrow('no longer eligible')
      expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)).toEqual(before)
      expect(
        f.db.drizzle
          .select()
          .from(schedulingBudgetReservations)
          .where(eq(schedulingBudgetReservations.replacesReservationId, f.budget.id))
          .all(),
      ).toEqual([])
    },
  )

  it('rolls back the new reservation and increment after a late Journal error in the existing transaction', async () => {
    const f = await operationFixture(),
      before = f.repo.schedulingBudget(f.budget.budgetSubjectId)
    f.db.drizzle.run(
      sql`CREATE TRIGGER reject_reacquisition BEFORE INSERT ON agent_event_journal WHEN NEW.event_type='scheduling.extra_turn_budget_reacquired' BEGIN SELECT RAISE(ABORT,'owned reacquisition failure'); END`,
    )
    expect(f.reacquire).toThrow('owned reacquisition failure')
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)).toEqual(before)
    expect(
      f.db.drizzle
        .select()
        .from(schedulingBudgetReservations)
        .where(eq(schedulingBudgetReservations.replacesReservationId, f.budget.id))
        .all(),
    ).toEqual([])
  })

  it('allows the actual Repository replacement to retain mandatory review authority with the linked original handoff', async () => {
    const f = await originalSupplement()
    const replacement = f.repo.beginConfirmedUnsentReexecution({
      operationId: randomUUID(),
      faultId: f.candidate.fault.id,
      handoff: f.repo.recoveryHandoff({ kind: 'run', id: f.original.id }),
    })
    const grant = f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, f.grant.id))
      .get()!
    expect(grant).toMatchObject({
      boundRunId: replacement.run.id,
      reviewState: 'pending',
      handoffId: f.grant.handoffId,
      state: 'bound',
    })
    const reservation = f.db.drizzle
      .select()
      .from(schedulingBudgetReservations)
      .where(eq(schedulingBudgetReservations.id, grant.budgetReservationId!))
      .get()!
    expect(reservation).toMatchObject({
      replacesReservationId: f.budget.id,
      handoffId: f.grant.handoffId,
      authorizationId: f.grant.id,
    })
    f.finish(replacement.run.id, { plan: 'The exact completed replacement Plan clarification.' })
    const review = f.repo.beginRun(f.admission()).run
    expect(review.collaboration?.stage).toBe('plan_review')
    expect(review.agentId).toBe('claude')
    expect(f.repo.schedulingBudget(f.budget.budgetSubjectId)?.extraPlanTurns).toBe(1)
  })
})
