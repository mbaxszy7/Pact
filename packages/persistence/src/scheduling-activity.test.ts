import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { PactDatabase } from './pact-database.js'

import { createQueueFixture } from './conversation-queue.test-helper.js'
import { decisionFixture } from './decision-fixture.test-support.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import { schedulingActivity, schedulingEvaluations } from './schema/index.js'

const databases = new Set<PactDatabase>()
afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
})

async function decision() {
  const f = await decisionFixture()
  databases.add(f.db)
  return f
}

async function nativeProposal(withOrigin = false) {
  const f = await createQueueFixture()
  databases.add(f.db)
  const run = f.root(true)
  if (!withOrigin) {
    f.repo.observationUnavailable(run.id, 'The original native observer disconnected.')
    f.repo.recordNativeEffects(run.id, 'pending')
    f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
  }
  f.repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  f.repo.beginSchedulingRecoveryEpoch(randomUUID())
  let origin: { faultId: string; attemptId: string } | undefined
  if (withOrigin) {
    f.repo.observationUnavailable(run.id, 'The original native observer disconnected.')
    f.repo.recordNativeEffects(run.id, 'pending')
    f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    const candidate = f.repo.takeSchedulingRecoveryFaults()[0]
    if (!candidate) throw Error('Missing native recovery fault')
    const check = f.repo.reserveSchedulingRecoveryCheck(
      candidate.fault.id,
      candidate.node,
      process.pid,
    )
    if (!check) throw Error('Missing native check reservation')
    f.repo.startSchedulingRecoveryCheck(check.id)
    f.repo.settleSchedulingRecoveryCheck(check.id, { ok: false, physicalReleased: true })
    origin = { faultId: candidate.fault.id, attemptId: check.id }
  }
  expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex', origin?.faultId)).toBe(true)
  const card = f.repo.relaySchedulingDecision(f.sessionId)!
  const answer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' as const },
  }
  return { ...f, run, card, answer, origin }
}

async function proposal() {
  const f = await planRevisionFixture()
  databases.add(f.db)
  const response = f.repo.beginRun(f.admission()).run
  f.finish(response.id, { plan: 'First revised Plan.' })
  const review = f.repo.beginRun(f.admission()).run
  f.finish(review.id, {
    verdict: 'changes_requested',
    answer: 'The complete second review requests cancellation evidence.',
  })
  const revised = f.repo.beginRun(f.admission()).run
  f.finish(revised.id, { plan: 'Current Plan with the original cancellation boundary.' })
  const handoff = f.admission().schedulingHandoff,
    deadlineAt = Date.now() + 15_000
  const material = await f.repo.readRelayWorkflowDecisionSources(
    handoff,
    [{ id: 'propose_supplement_plan', description: 'Request one read-only clarification.' }],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    inputSha256: material.inputSha256,
    deadlineAt,
  })
  if (reserved.status !== 'reserved') throw Error('Missing evaluation reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'propose_supplement_plan',
  })
  const card = f.repo.proposeRelayWorkflowAction({
    handoff,
    kind: 'supplement_plan',
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason: 'Clarify the original cancellation boundary against the complete review.',
    sourceIds: [material.sources[0]!.id],
  })
  const answer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' as const },
  }
  const confirm = () => {
    const accepted = f.repo.answerRelaySchedulingDecision(answer)
    if (!('receiptId' in accepted) || !accepted.receiptId)
      throw Error('Missing confirmation receipt')
    return f.repo.preparedRelayWorkflowAction(accepted.receiptId)
  }
  return { ...f, handoff, card, answer, confirm, evaluationId: reserved.evaluation.id }
}

function beginExtra(f: Awaited<ReturnType<typeof proposal>>) {
  const prepared = f.confirm()
  return f.repo.beginRun({
    ...f.admission(),
    clientMessageId: prepared.receipt.clientNonce,
    content: 'Perform only the approved read-only clarification.',
    collaboration: prepared.next,
    agentId: prepared.next.actor,
    expectedCollaborationRevision: prepared.task.revision,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }).run
}

describe('durable Relay activity facts', () => {
  it('retains the exact original fault row across a host decision and late native-check completion', async () => {
    const f = await nativeProposal(true)
    expect(f.origin).toBeDefined()
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([
      expect.objectContaining({
        id: f.origin!.faultId,
        reason: 'native_rebuild',
        suggestionState: 'awaiting_user',
        action: 'rebuild_native_context',
        called: false,
        provider: null,
        model: null,
      }),
    ])
    f.repo.answerRelaySchedulingDecision(f.answer)
    f.repo.settleSchedulingRecoveryCheck(f.origin!.attemptId, { ok: false, physicalReleased: true })
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([
      expect.objectContaining({
        id: f.origin!.faultId,
        reason: 'native_rebuild',
        suggestionState: 'adopted',
        action: 'rebuild_native_context',
        actionResult: 'reserved',
        called: false,
        provider: null,
        model: null,
      }),
    ])
    expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it('records a host rebuild request, exact native dispatch and witnessed completion without inventing model inference or business completion', async () => {
    const f = await nativeProposal(),
      before = f.repo.readSchedulingActivity({}).rows[0]!
    expect(before).toMatchObject({
      id: f.card.decisionId,
      reason: 'native_rebuild',
      called: false,
      provider: null,
      model: null,
      suggestion: null,
      suggestionState: 'awaiting_user',
      action: 'rebuild_native_context',
      actionResult: null,
    })
    f.repo.answerRelaySchedulingDecision(f.answer)
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      suggestionState: 'adopted',
      actionResult: 'reserved',
    })
    const id = f.answer.clientOperationId,
      executorId = randomUUID(),
      nativeSessionId = randomUUID()
    f.repo.freezeNativeRebuildSource(id, [])
    f.repo.markNativeRebuildDispatched(id, executorId)
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      actionResult: 'dispatched',
      physicalUnconfirmed: true,
    })
    f.repo.recordNativeRebuildIdentity(id, nativeSessionId)
    f.repo.completeNativeRebuild(id, nativeSessionId, executorId, {
      kind: 'codex_rollout_v1',
      nativeSessionId,
      verifiedPrefixBytes: 100,
      verifiedPrefixSha256: 'a'.repeat(64),
      recordCount: 2,
    })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      reason: 'native_rebuild',
      actionResult: 'completed',
      originalUnconfirmed: true,
      physicalUnconfirmed: true,
      called: false,
      provider: null,
      model: null,
    })
    expect(f.repo.findRun(f.run.id)).toMatchObject({
      nativeEffectsState: 'pending',
      controlDisposition: 'abandoned',
    })
    expect(f.repo.findRun(f.run.id)?.nativeOutcome).toBeUndefined()
    expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it('keeps cancelled host rebuilds distinct from stopping the original native work', async () => {
    const f = await nativeProposal(),
      original = f.repo.findRun(f.run.id)
    f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.card.decisionId,
      reason: 'native_rebuild',
      suggestionState: 'discarded',
      action: 'rebuild_native_context',
      actionResult: 'cancelled',
      called: false,
      provider: null,
      model: null,
    })
    expect(f.repo.findRun(f.run.id)).toEqual(original)
    expect(f.repo.nativeIssueMetadata(f.sessionId).agents).toHaveLength(1)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM native_rebuild_operations`)).toEqual({
      count: 0,
    })
  })

  it.each(['preparing', 'creating'] as const)(
    'reprojects a %s native rebuild through the real cold-restart transaction',
    async (stage) => {
      const f = await nativeProposal()
      f.repo.answerRelaySchedulingDecision(f.answer)
      if (stage === 'creating') {
        f.repo.freezeNativeRebuildSource(f.answer.clientOperationId, [])
        f.repo.markNativeRebuildDispatched(f.answer.clientOperationId, randomUUID())
      }
      const id = f.repo.readSchedulingActivity({}).rows[0]!.id
      f.repo.recoverInterruptedRuns()
      expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
        id,
        action: 'rebuild_native_context',
        actionResult: stage === 'preparing' ? 'failed' : 'unconfirmed',
        called: false,
        provider: null,
        model: null,
      })
      expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    },
  )

  it('attributes the exact historical model only after actual invocation and retains logical failure separately from physical release', async () => {
    const f = await decision()
    const reserved = f.repo.reserveEvaluation({
      handoff: f.input.handoff,
      provider: 'codex',
      model: 'gpt-6-luna',
      configurationFingerprint: 'a'.repeat(64),
    })
    if (reserved.status !== 'reserved') throw Error('Missing evaluation reservation')
    const before = f.repo.readSchedulingActivity({}).rows[0]!
    expect(before).toMatchObject({
      id: reserved.evaluation.id,
      called: false,
      provider: null,
      model: null,
      result: 'reserved',
    })
    f.repo.dispatchEvaluation(reserved.evaluation.id)
    f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'failed', physicalReleased: false })
    expect(
      f.db.drizzle
        .select()
        .from(schedulingActivity)
        .where(eq(schedulingActivity.id, before.id))
        .get(),
    ).toMatchObject({ unresolved: true })
    f.repo.saveSchedulingSettings({
      expectedRevision: 1,
      selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'claude-haiku-5-5' },
    })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      called: true,
      provider: 'codex',
      model: 'gpt-6-luna',
      result: 'failed',
      physicalUnconfirmed: true,
    })
    f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'failed', physicalReleased: true })
    expect(
      f.db.drizzle
        .select()
        .from(schedulingActivity)
        .where(eq(schedulingActivity.id, before.id))
        .get(),
    ).toMatchObject({ unresolved: false })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      result: 'failed',
      physicalUnconfirmed: false,
    })
    expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
  })

  it('separates a model proposal, user acceptance, actual dispatch and complete business output in the same stable row', async () => {
    const f = await proposal()
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.evaluationId,
      suggestionState: 'awaiting_user',
      action: 'supplement_plan',
      actionResult: null,
      result: 'completed',
    })
    const extra = beginExtra(f)
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.evaluationId,
      suggestionState: 'adopted',
      action: 'supplement_plan',
      actionResult: 'reserved',
    })
    f.repo.recordDispatch(extra.id, 'possibly_sent', 'fixture-codex')
    expect(f.repo.readSchedulingActivity({}).rows[0]?.actionResult).toBe('dispatched')
    f.finish(extra.id, {
      plan: 'Completed approved clarification.',
      answer: 'The complete exact author response.',
    })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.evaluationId,
      actionResult: 'completed',
      called: true,
      model: 'gpt-6-luna',
    })
    expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })

  it('keeps a terminal native receipt unconfirmed until the actual sealed visible answer is restored', async () => {
    const f = await proposal(),
      extra = beginExtra(f),
      nativeSessionId = 'fixture-codex',
      nativeTurnId = `turn-${extra.id}`
    f.repo.applyEvent(f.sessionId, extra.id, {
      type: 'session.started',
      agentId: 'codex',
      nativeSessionId,
    })
    f.repo.applyEvent(f.sessionId, extra.id, {
      type: 'turn.started',
      agentId: 'codex',
      turnId: nativeTurnId,
    })
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId: f.sessionId,
        agentId: 'codex',
        requestId: extra.id,
        runId: extra.id,
        nativeSessionId,
        nativeTurnId,
        bindingGeneration: extra.bindingGeneration ?? 1,
      },
    })
    f.repo.recordNativeEffects(extra.id, 'settled')
    f.repo.settleKnownNativeEnding(extra.id)
    expect(f.repo.hasCompleteResponse(extra.id)).toBe(false)
    expect(f.repo.readSchedulingActivity({}).rows[0]?.actionResult).toBe('unconfirmed')
    await f.repo.recordNativeOutputComplete(
      extra.id,
      {
        outputId: `recovered-${extra.id}`,
        text: 'The complete canonical response restored from native evidence.',
        completeness: 'complete',
      },
      new AbortController().signal,
    )
    expect(f.repo.hasCompleteResponse(extra.id)).toBe(true)
    expect(f.repo.readSchedulingActivity({}).rows[0]?.actionResult).toBe('completed')
  })

  it('records cancellation as discarded advice and keeps unrelated original native work intact', async () => {
    const f = await proposal()
    f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.evaluationId,
      suggestionState: 'discarded',
      actionResult: 'cancelled',
      physicalUnconfirmed: false,
    })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      automation: 'paused',
      pauseReason: 'user',
    })
    expect(f.db.drizzle.select().from(schedulingActivity).get()?.unresolved).toBe(false)
  })

  it('records the actual default review after unused advice is discarded, without relabeling it as an extra authorized Turn', async () => {
    const f = await proposal()
    f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
    const review = f.repo.beginRun(f.admission()).run
    expect(review.agentId).toBe('claude')
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: f.evaluationId,
      suggestionState: 'fallback',
      action: 'plan_review',
      actionResult: 'reserved',
    })
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraPlanTurns).toBe(0)
    f.finish(review.id, { verdict: 'accepted' })
    expect(f.repo.readSchedulingActivity({}).rows[0]?.actionResult).toBe('completed')
  })

  it('groups native-check preparation, logical failure and physical completion by the original fault without claiming a model call', async () => {
    const f = await decision()
    f.repo.beginSchedulingRecoveryEpoch(randomUUID())
    f.repo.failRun(f.first.run.id, 'transient_transport', 'Controlled original transport failure.')
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    const [candidate] = f.repo.takeSchedulingRecoveryFaults()
    if (!candidate) throw Error('Missing original fault')
    const check = f.repo.reserveSchedulingRecoveryCheck(
      candidate.fault.id,
      candidate.node,
      process.pid,
    )!
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: candidate.fault.id,
      reason: 'native_check',
      actionResult: 'reserved',
      called: false,
      provider: null,
      model: null,
    })
    f.repo.startSchedulingRecoveryCheck(check.id)
    f.repo.settleSchedulingRecoveryCheck(check.id, { ok: false, physicalReleased: false })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: candidate.fault.id,
      result: 'failed',
      physicalUnconfirmed: true,
      called: false,
    })
    f.repo.settleSchedulingRecoveryCheck(check.id, { ok: false, physicalReleased: true })
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: candidate.fault.id,
      result: 'failed',
      physicalUnconfirmed: false,
      called: false,
    })
    expect(f.db.drizzle.select().from(schedulingActivity).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it('retains old unresolved user and physical obligations without retaining resolved activity or deleting source evidence', async () => {
    const f = await proposal(),
      before = f.repo.readSchedulingActivity({}).rows[0]!,
      old = new Date(Date.now() - 45 * 86400_000).toISOString()
    f.db.drizzle
      .update(schedulingActivity)
      .set({ activityAt: old })
      .where(eq(schedulingActivity.id, before.id))
      .run()
    expect(f.repo.readSchedulingActivity({}).rows[0]).toMatchObject({
      id: before.id,
      suggestionState: 'awaiting_user',
    })
    f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } })
    f.db.drizzle
      .update(schedulingActivity)
      .set({ activityAt: old })
      .where(eq(schedulingActivity.id, before.id))
      .run()
    expect(f.repo.readSchedulingActivity({}).rows).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM relay_decisions`)).toEqual({
      count: 1,
    })
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })
})
