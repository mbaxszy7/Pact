import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { PactDatabase } from './pact-database.js'

import { decisionFixture } from './decision-fixture.test-support.js'
import { schedulingRecoveryFaults } from './schema/index.js'

const databases = new Set<PactDatabase>()
afterEach(() => {
  for (const db of databases) db.close()
  databases.clear()
})

async function fixture() {
  const f = await decisionFixture()
  databases.add(f.db)
  f.repo.beginSchedulingRecoveryEpoch(randomUUID())
  return f
}

function fault(f: Awaited<ReturnType<typeof fixture>>) {
  f.repo.failRun(f.first.run.id, 'transient_transport', 'Original observed transport failure.')
  f.repo.armSchedulingRecoveryFaults(f.sessionId)
  const [candidate] = f.repo.takeSchedulingRecoveryFaults()
  if (!candidate) throw new Error('Missing original recovery fault')
  return candidate
}

describe('durable automatic recovery admission', () => {
  it('records the original fault in its business transaction and consumes noisy facts once', async () => {
    const f = await fixture(),
      candidate = fault(f)
    const before = f.db.drizzle
      .select()
      .from(schedulingRecoveryFaults)
      .where(eq(schedulingRecoveryFaults.id, candidate.fault.id))
      .get()!
    expect(before).toMatchObject({
      runId: f.first.run.id,
      originSequence: expect.any(Number),
      pending: false,
      consideredFingerprint: candidate.node.factFingerprint,
    })
    f.repo.observationUnavailable(
      f.first.run.id,
      'A different timeout description is not new native evidence.',
    )
    f.repo.refreshSchedulingRecoveryFacts(f.sessionId)
    expect(f.repo.takeSchedulingRecoveryFaults()).toEqual([])
    expect(
      f.db.drizzle
        .select()
        .from(schedulingRecoveryFaults)
        .where(eq(schedulingRecoveryFaults.id, before.id))
        .get(),
    ).toMatchObject({
      originSequence: before.originSequence,
      utilityEpoch: before.utilityEpoch,
      configurationGeneration: before.configurationGeneration,
    })
  })

  it('does not replay an old fault after configuration ABA or a new Utility epoch', async () => {
    const f = await fixture(),
      candidate = fault(f)
    f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
    f.repo.saveSchedulingSettings({ expectedRevision: 2, enabled: true })
    f.repo.observationUnavailable(f.first.run.id, 'Repeated original failure.')
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    expect(f.repo.takeSchedulingRecoveryFaults()).toEqual([])
    expect(
      f.repo.reserveSchedulingRecoveryCheck(candidate.fault.id, candidate.node, process.pid),
    ).toBeUndefined()
    f.repo.beginSchedulingRecoveryEpoch(randomUUID())
    f.repo.observationUnavailable(f.first.run.id, 'A restart is not a new failure origin.')
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    expect(f.repo.takeSchedulingRecoveryFaults()).toEqual([])
  })

  it('holds the original budget and sole App lease across logical failure until physical completion', async () => {
    const f = await fixture(),
      candidate = fault(f)
    const attempt = f.repo.reserveSchedulingRecoveryCheck(
      candidate.fault.id,
      candidate.node,
      process.pid,
    )!
    expect(attempt).toBeDefined()
    f.repo.startSchedulingRecoveryCheck(attempt.id)
    f.repo.settleSchedulingRecoveryCheck(attempt.id, { ok: false, physicalReleased: false })
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: attempt.id,
      kind: 'check',
      phase: 'cleanup_unconfirmed',
      active: true,
    })
    expect(f.repo.schedulingBudget(candidate.node.budgetSubjectId)?.automaticChecks).toBe(1)
    expect(
      f.repo.reserveEvaluation({
        handoff: candidate.node,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint: 'a'.repeat(64),
      }).status,
    ).toBe('busy')
    f.repo.settleSchedulingRecoveryCheck(attempt.id, { ok: false, physicalReleased: true })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.schedulingBudget(candidate.node.budgetSubjectId)?.automaticChecks).toBe(1)
    f.repo.settleSchedulingRecoveryCheck(attempt.id, { ok: true, physicalReleased: true })
    expect(f.repo.schedulingBudget(candidate.node.budgetSubjectId)?.automaticChecks).toBe(1)
    expect(
      f.repo.reserveSchedulingRecoveryCheck(candidate.fault.id, candidate.node, process.pid),
    ).toBeUndefined()
  })

  it('refunds only an attempt that never began physical preparation, without requeueing the fact', async () => {
    const f = await fixture(),
      candidate = fault(f)
    const attempt = f.repo.reserveSchedulingRecoveryCheck(
      candidate.fault.id,
      candidate.node,
      process.pid,
    )!
    f.repo.settleSchedulingRecoveryCheck(attempt.id, { ok: false, physicalReleased: true })
    expect(f.repo.schedulingBudget(candidate.node.budgetSubjectId)?.automaticChecks).toBe(0)
    expect(f.repo.schedulingRecoveryAttempt(attempt.id)).toMatchObject({
      result: 'not_sent',
      started: false,
      physicalReleased: true,
    })
    expect(f.repo.takeSchedulingRecoveryFaults()).toEqual([])
    expect(
      f.repo.reserveSchedulingRecoveryCheck(candidate.fault.id, candidate.node, process.pid),
    ).toBeUndefined()
  })

  it('preserves stopped-user authority and never creates a new origin for a late failure', async () => {
    const f = await fixture()
    f.repo.failRun(f.first.run.id, 'user_stopped', 'Stopped by the user.', true)
    f.repo.observationUnavailable(f.first.run.id, 'Late observer failure after Stop.')
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    expect(f.repo.takeSchedulingRecoveryFaults()).toEqual([])
  })
})
