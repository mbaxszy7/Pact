import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  relayNativeRecoveryProofSchema,
  relaySchedulingDecisionSchema,
  type RelayDecisionAnswer,
} from '@pact/contracts'

import { createQueueFixture } from './conversation-queue.test-helper.js'
import {
  agentEventJournal,
  agentRuns,
  collaborationActionReceipts,
  nativeRebuildOperations,
  relayDecisions,
  schedulingEvaluations,
  schedulingRuntimeOwners,
} from './schema/index.js'

const fixtures: Awaited<ReturnType<typeof createQueueFixture>>[] = [],
  directories: string[] = []
afterEach(async () => {
  for (const value of fixtures.splice(0)) value.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(
  returnedInput = false,
  effects: 'pending' | 'unknown' = 'pending',
  filePath = ':memory:',
) {
  const f = await createQueueFixture(filePath)
  fixtures.push(f)
  const run = f.root(true)
  if (returnedInput) {
    f.comment(run, 'Preserve this complete returned Comment.')
    const request = f.queue(run, 'Returned input must remain unsent, including its final line.')
    f.repo.returnQueuedConversationMessage({ ...request, phase: 'return' })
  }
  f.repo.observationUnavailable(run.id, 'The original observer disconnected.')
  f.repo.recordNativeEffects(run.id, effects)
  f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
  f.repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  f.repo.beginSchedulingRecoveryEpoch(randomUUID())
  expect(f.repo.nativeIssueMetadata(f.sessionId).agents).toEqual([
    expect.objectContaining({
      agentId: 'codex',
      action: 'rebuild',
      generation: run.bindingGeneration,
      nativeSessionId: run.nativeSessionId,
      runId: run.id,
      abandon: true,
    }),
  ])
  return {
    ...f,
    run,
    get db() {
      return f.db
    },
    get repo() {
      return f.repo
    },
  }
}

async function proposed(
  returnedInput = false,
  effects: 'pending' | 'unknown' = 'pending',
  filePath = ':memory:',
) {
  const f = await fixture(returnedInput, effects, filePath)
  expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(true)
  const card = relaySchedulingDecisionSchema.parse(f.repo.relaySchedulingDecision(f.sessionId))
  const answer: RelayDecisionAnswer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  }
  return {
    ...f,
    card,
    answer,
    get db() {
      return f.db
    },
    get repo() {
      return f.repo
    },
  }
}
type Fixture = Awaited<ReturnType<typeof proposed>>

function decision(f: Fixture) {
  return f.db.drizzle
    .select()
    .from(relayDecisions)
    .where(eq(relayDecisions.id, f.card.decisionId))
    .get()!
}

function beginOtherRebuild(f: Fixture) {
  const id = randomUUID()
  f.repo.beginNativeRebuild({
    id,
    sessionId: f.sessionId,
    agentId: 'codex',
    expectedGeneration: f.run.bindingGeneration,
    abandon: true,
  })
  f.repo.freezeNativeRebuildSource(id, [])
  f.repo.markNativeRebuildDispatched(id, randomUUID())
  return id
}

describe('host-originated Relay native recovery decisions', () => {
  it('rejects a new confirmation nonce that already belongs to a previous native rebuild', async () => {
    const f = await fixture(),
      oldId = randomUUID()
    f.repo.beginNativeRebuild({
      id: oldId,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: true,
    })
    f.repo.failNativeRebuild(oldId, 'An earlier operation failed before native creation.')
    expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(true)
    const card = relaySchedulingDecisionSchema.parse(f.repo.relaySchedulingDecision(f.sessionId))
    const before = f.db.drizzle
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, oldId))
      .get()
    expect(() =>
      f.repo.answerRelaySchedulingDecision({
        reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
        clientOperationId: oldId,
        answer: { kind: 'confirm' },
      }),
    ).toThrow(/already|different|existing/u)
    expect(
      f.db.drizzle
        .select()
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, oldId))
        .get(),
    ).toEqual(before)
    expect(f.repo.relaySchedulingDecision(f.sessionId)?.decisionId).toBe(card.decisionId)
  })
  it('projects one exact rebuild card from real native facts without an evaluation, user grant or native dispatch', async () => {
    const f = await fixture(),
      before = f.repo.findRun(f.run.id),
      context = f.repo.nativeContext(f.sessionId, 'codex'),
      issues = f.repo.nativeIssueMetadata(f.sessionId)
    expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(true)
    expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(false)
    const card = relaySchedulingDecisionSchema.parse(f.repo.relaySchedulingDecision(f.sessionId))
    expect(card).toMatchObject({
      version: 'relay-decision-v2',
      request: {
        category: 'arrangement_change',
        operation: {
          kind: 'rebuild_native_context',
          agentId: 'codex',
          expectedGeneration: f.run.bindingGeneration,
          expectedNativeSessionId: f.run.nativeSessionId,
          expectedRunId: f.run.id,
          expectedRebuildId: null,
          abandonOldWork: true,
        },
      },
    })
    const rows = f.db.drizzle.select().from(relayDecisions).all()
    expect(rows).toHaveLength(1)
    const proof = relayNativeRecoveryProofSchema.parse(JSON.parse(rows[0]!.proofJson))
    expect(proof).toMatchObject({ version: 'relay-native-recovery-proof-v1', card })
    expect(Object.hasOwn(proof, 'evaluationId')).toBe(false)
    expect(
      relayNativeRecoveryProofSchema.safeParse({ ...proof, evaluationId: randomUUID() }).success,
    ).toBe(false)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    expect(f.db.drizzle.select().from(schedulingRuntimeOwners).all()).toEqual([])
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual([])
    expect(f.repo.findRun(f.run.id)).toEqual(before)
    expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(context)
    expect(f.repo.nativeIssueMetadata(f.sessionId)).toEqual(issues)
  })

  it.each(['pending', 'unknown'] as const)(
    'keeps the original issue, %s native effects and returned input after Cancel, including configuration ABA',
    async (effects) => {
      const f = await proposed(true, effects),
        issues = f.repo.nativeIssueMetadata(f.sessionId),
        run = f.repo.findRun(f.run.id),
        queue = f.repo.queueState(f.sessionId),
        comments = f.drafts(),
        cancel: RelayDecisionAnswer = { ...f.answer, answer: { kind: 'cancel' } }
      expect(queue.returnedInput).toMatchObject({ state: 'pending' })
      expect(f.repo.answerRelaySchedulingDecision(cancel)).toMatchObject({
        created: true,
        result: { disposition: 'cancelled', rebuildId: null, runId: null },
      })
      expect(f.repo.answerRelaySchedulingDecision(cancel)).toMatchObject({ created: false })
      expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(f.repo.nativeIssueMetadata(f.sessionId)).toEqual(issues)
      expect(f.repo.findRun(f.run.id)).toEqual(run)
      expect(f.repo.findRun(f.run.id)?.nativeEffectsState).toBe(effects)
      expect(f.repo.queueState(f.sessionId)).toEqual(queue)
      expect(f.drafts()).toEqual(comments)
      expect(f.repo.projectHasNativeWork(f.db.sessionRepository.find(f.sessionId)!.projectId)).toBe(
        true,
      )
      expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(false)
      f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
      f.repo.saveSchedulingSettings({ expectedRevision: 2, enabled: true })
      expect(f.repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(false)
      expect(f.db.drizzle.select().from(relayDecisions).all()).toHaveLength(1)
      expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual([])
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
      expect(f.repo.queueState(f.sessionId)).toEqual(queue)
    },
  )

  it('atomically binds one native operation to the answer nonce and returns its original receipt after a lost acknowledgement', async () => {
    const f = await proposed(true),
      queue = f.repo.queueState(f.sessionId),
      run = f.repo.findRun(f.run.id),
      beforeCount = f.db.drizzle.select().from(agentRuns).all().length
    const accepted = f.repo.answerRelaySchedulingDecision(f.answer)
    expect(accepted).toMatchObject({
      created: true,
      nativeRebuild: { agentId: 'codex', operationId: f.answer.clientOperationId },
      result: {
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
        disposition: 'confirmed',
        rebuildId: f.answer.clientOperationId,
        runId: null,
      },
    })
    const operations = f.db.drizzle.select().from(nativeRebuildOperations).all()
    expect(operations).toEqual([
      expect.objectContaining({
        id: f.answer.clientOperationId,
        sessionId: f.sessionId,
        agentId: 'codex',
        oldGeneration: f.run.bindingGeneration,
        oldNativeSessionId: f.run.nativeSessionId,
        oldRunId: f.run.id,
        abandon: true,
        stage: 'preparing',
        nativeWorkState: 'not_dispatched',
        provisionalNativeSessionId: null,
      }),
    ])
    expect(
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
      }),
    ).toEqual(accepted.result)
    expect(f.repo.answerRelaySchedulingDecision(f.answer)).toEqual({
      result: accepted.result,
      created: false,
    })
    for (const changed of [
      { ...f.answer, clientOperationId: randomUUID() },
      { ...f.answer, answer: { kind: 'cancel' as const } },
      { ...f.answer, reference: { ...f.answer.reference, revision: f.card.revision + 1 } },
    ])
      expect(() => f.repo.answerRelaySchedulingDecision(changed)).toThrow('different answer')
    expect(
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: randomUUID(),
      }),
    ).toBeUndefined()
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual(operations)
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(beforeCount)
    expect(f.repo.findRun(f.run.id)).toEqual(run)
    expect(f.repo.queueState(f.sessionId)).toEqual(queue)
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(
      f.db.drizzle
        .select()
        .from(agentEventJournal)
        .where(eq(agentEventJournal.eventType, 'scheduling.native_recovery_answered'))
        .all(),
    ).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    expect(f.db.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  it('reads the original confirmation after reopening SQLite and never re-dispatches its unstarted native creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-relay-rebuild-receipt-'))
    directories.push(directory)
    const f = await proposed(true, 'unknown', join(directory, 'pact.sqlite')),
      accepted = f.repo.answerRelaySchedulingDecision(f.answer),
      returnedInput = f.repo.queueState(f.sessionId).returnedInput
    await f.reopen()
    f.repo.recoverInterruptedRuns()
    f.repo.beginSchedulingRecoveryEpoch(randomUUID())
    expect(f.repo.nativeRebuildOperation(f.answer.clientOperationId)).toMatchObject({
      stage: 'failed',
    })
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual([
      expect.objectContaining({
        id: f.answer.clientOperationId,
        nativeWorkState: 'not_dispatched',
        provisionalNativeSessionId: null,
      }),
    ])
    expect(
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
      }),
    ).toEqual(accepted.result)
    expect(f.repo.answerRelaySchedulingDecision(f.answer)).toEqual({
      result: accepted.result,
      created: false,
    })
    expect(f.repo.queueState(f.sessionId).returnedInput).toEqual(returnedInput)
    expect(f.repo.findRun(f.run.id)?.nativeEffectsState).toBe('unknown')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it('rejects a mismatched revision or information answer before changing the native operation or answer', async () => {
    const f = await proposed(),
      before = decision(f),
      context = f.repo.nativeContext(f.sessionId, 'codex')
    for (const invalid of [
      { ...f.answer, reference: { ...f.answer.reference, revision: f.card.revision + 1 } },
      {
        ...f.answer,
        answer: {
          kind: 'text' as const,
          fieldId: randomUUID(),
          text: 'A text field cannot authorize this arrangement.',
        },
      },
    ])
      expect(() => f.repo.answerRelaySchedulingDecision(invalid)).toThrow('does not match')
    expect(decision(f)).toEqual(before)
    expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(context)
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual([])
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(f.card)
  })

  const changes: Array<{ label: string; retired?: boolean; mutate: (f: Fixture) => void }> = [
    {
      label: 'configuration ABA',
      retired: true,
      mutate(f) {
        f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
        f.repo.saveSchedulingSettings({ expectedRevision: 2, enabled: true })
      },
    },
    {
      label: 'Utility epoch',
      mutate(f) {
        f.repo.beginSchedulingRecoveryEpoch(randomUUID())
      },
    },
    {
      label: 'native generation',
      mutate(f) {
        const id = beginOtherRebuild(f),
          nativeSessionId = randomUUID()
        f.repo.recordNativeRebuildIdentity(id, nativeSessionId)
        f.repo.completeNativeRebuild(id, nativeSessionId, undefined, {
          kind: 'codex_rollout_v1',
          nativeSessionId,
          verifiedPrefixBytes: 100,
          verifiedPrefixSha256: 'a'.repeat(64),
          recordCount: 2,
        })
        f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
        expect(f.repo.nativeIssueMetadata(f.sessionId).agents[0]?.generation).toBe(
          f.run.bindingGeneration + 1,
        )
      },
    },
    {
      label: 'current Run identity',
      mutate(f) {
        // Seed a concurrently committed retained Run in the same generation. This changes only
        // the source fact under test; its input and binding come from the real primary Run.
        const original = f.db.drizzle
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, f.run.id))
          .get()!
        const id = randomUUID()
        f.db.drizzle
          .insert(agentRuns)
          .values({
            ...original,
            id,
            createdAt: new Date(Date.parse(original.createdAt) + 1).toISOString(),
          })
          .run()
        expect(f.repo.nativeIssueMetadata(f.sessionId).agents[0]?.runId).toBe(id)
      },
    },
    {
      label: 'unconfirmed candidate',
      mutate(f) {
        const id = beginOtherRebuild(f)
        f.repo.failNativeRebuild(id, 'The separate creation acknowledgement was lost.')
        expect(f.repo.nativeIssueMetadata(f.sessionId).agents[0]).toMatchObject({
          action: 'rebuild',
          rebuildId: id,
          previousCreationUnconfirmed: true,
        })
      },
    },
    {
      label: 'Task authority',
      retired: true,
      mutate: (f) => {
        f.repo.pauseCollaboration(f.sessionId)
      },
    },
    {
      label: 'Session settings',
      mutate(f) {
        const current = f.db.sessionRepository.find(f.sessionId)!
        f.db.sessionRepository.saveSettings(f.sessionId, {
          ...current.settings,
          agents: { ...current.settings.agents, codex: { model: 'new-model', effort: 'high' } },
        })
      },
    },
    {
      label: 'queue revision',
      mutate(f) {
        const queue = f.repo.queueState(f.sessionId)
        f.repo.setConversationQueueEnabled({
          sessionId: f.sessionId,
          operationId: randomUUID(),
          expectedRevision: queue.revision,
          enabled: !queue.enabled,
        })
      },
    },
  ]
  it.each(changes)(
    'invalidates the original answer after $label changes',
    async ({ mutate, retired = false }) => {
      const f = await proposed()
      mutate(f)
      const operations = f.db.drizzle.select().from(nativeRebuildOperations).all()
      expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow('no longer current')
      expect(decision(f)).toMatchObject({
        state: retired ? 'invalid' : 'awaiting_answer',
        active: !retired,
        answerNonce: null,
        resultJson: null,
      })
      expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual(operations)
      expect(f.repo.discardStaleRelaySchedulingDecision(f.sessionId)).toBe(!retired)
      expect(decision(f)).toMatchObject({ state: 'invalid', active: false })
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    },
  )

  it('rolls the native operation and answer back together when the final durable journal write fails', async () => {
    const f = await proposed(true),
      before = decision(f),
      context = f.repo.nativeContext(f.sessionId, 'codex'),
      run = f.repo.findRun(f.run.id),
      queue = f.repo.queueState(f.sessionId),
      journal = f.db.drizzle.select().from(agentEventJournal).all()
    f.db.drizzle
      .run(sql`CREATE TRIGGER reject_native_recovery_answer BEFORE INSERT ON agent_event_journal
      WHEN NEW.event_type='scheduling.native_recovery_answered'
      BEGIN SELECT RAISE(ABORT, 'owned final recovery write failure'); END`)
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(
      'owned final recovery write failure',
    )
    expect(decision(f)).toEqual(before)
    expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(context)
    expect(f.repo.findRun(f.run.id)).toEqual(run)
    expect(f.repo.queueState(f.sessionId)).toEqual(queue)
    expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual(journal)
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toEqual([])
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(f.card)
    expect(
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
      }),
    ).toBeUndefined()
    expect(f.db.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
})
