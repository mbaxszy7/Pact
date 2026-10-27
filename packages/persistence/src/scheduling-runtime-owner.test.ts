import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DecisionDarwinPhysicalWitness, SchedulingHandoff } from '@pact/contracts'

import { decisionFixture } from './decision-fixture.test-support.js'
import { copyLegacyDatabase } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import { schedulingEvaluations, schedulingRuntimeOwners } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const configurationFingerprint = 'a'.repeat(64)
const databases = new Set<PactDatabase>()
const directories: string[] = []

afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function fixture(filePath = ':memory:') {
  const result = await decisionFixture(filePath)
  databases.add(result.db)
  return result
}

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-scheduling-owner-'))
  directories.push(directory)
  return join(directory, 'pact.sqlite')
}

function probe(sessionId: string | null) {
  return {
    id: randomUUID(),
    sessionId,
    provider: 'codex' as const,
    model: 'gpt-6-luna',
    configurationFingerprint,
    deadlineAt: Date.now() + 15_000,
  }
}

function evaluation(handoff: SchedulingHandoff) {
  return { handoff, provider: 'codex' as const, model: 'gpt-6-luna', configurationFingerprint }
}

function reserveEvaluation(db: PactDatabase, handoff: SchedulingHandoff) {
  const reserved = db.conversationRepository.reserveEvaluation(evaluation(handoff))
  expect(reserved.status).toBe('reserved')
  if (reserved.status !== 'reserved') throw Error('Expected an evaluation reservation')
  return reserved.evaluation
}

function anotherProjectHandoff(db: PactDatabase) {
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Competing scheduling project',
    directoryPath: `/scheduling-owner-fixture/${projectId}`,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Competing scheduling session', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const { run } = db.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Independent scheduling handoff.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  db.conversationRepository.applyEvent(sessionId, run.id, {
    type: 'turn.completed',
    agentId: 'codex',
    turnId: 'competing-fixture-turn',
    outcome: 'failed',
  })
  return db.conversationRepository.recoveryHandoff({ kind: 'run', id: run.id })
}

// Repository facts only: no process is started or declared physically absent by this fixture.
function witness(): DecisionDarwinPhysicalWitness {
  const root = { pid: 4102, pgid: 4102, started: 'fixture-root-birth' }
  return {
    version: 1,
    platform: 'darwin',
    ownerId: randomUUID(),
    owner: { pid: 4101, started: 'fixture-owner-birth' },
    root,
    members: [root],
  }
}

function storedOwner(db: PactDatabase, id: string) {
  return db.drizzle
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
}

function storedEvaluation(db: PactDatabase, id: string) {
  return db.drizzle
    .select()
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.id, id))
    .get()
}

describe('App-wide scheduling physical owner', () => {
  it.each(['global', 'project'] as const)(
    '%s probe excludes other probes and evaluations until physical release',
    async (scope) => {
      const f = await fixture()
      const input = probe(scope === 'global' ? null : f.sessionId)
      expect(f.repo.reserveSchedulingProbe(input)).toBe(true)
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id: input.id,
        kind: 'probe',
        sessionId: input.sessionId,
        evaluationId: null,
        active: true,
        phase: 'reserved',
        physicalWitnessJson: null,
      })
      expect(f.repo.activeEvaluation()).toBeUndefined()
      expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(false)
      expect(f.repo.reserveSchedulingProbe(probe(f.sessionId))).toBe(false)
      expect(f.repo.reserveEvaluation(evaluation(f.input.handoff)).status).toBe('busy')
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])

      f.repo.settleSchedulingProbe(input.id, false)
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id: input.id,
        active: true,
        phase: 'cleanup_unconfirmed',
        settledAt: null,
      })
      expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(false)
      expect(f.repo.reserveSchedulingProbe(probe(f.sessionId))).toBe(false)
      expect(f.repo.reserveEvaluation(evaluation(f.input.handoff)).status).toBe('busy')

      f.repo.settleSchedulingProbe(input.id, true)
      expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
      expect(storedOwner(f.db, input.id)).toMatchObject({
        active: false,
        phase: 'released',
        settledAt: expect.any(String),
      })
      const admitted = reserveEvaluation(f.db, f.input.handoff)
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id: admitted.id,
        kind: 'evaluation',
        evaluationId: admitted.id,
      })
      expect(f.repo.activeEvaluation()).toMatchObject({ id: admitted.id })
    },
  )

  it('evaluation cleanup blocks global and other-project probes and evaluations', async () => {
    const f = await fixture()
    const competing = anotherProjectHandoff(f.db)
    const admitted = reserveEvaluation(f.db, f.input.handoff)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: admitted.id,
      kind: 'evaluation',
      sessionId: f.sessionId,
      evaluationId: admitted.id,
    })
    expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(false)
    expect(f.repo.reserveSchedulingProbe(probe(competing.sessionId))).toBe(false)
    expect(f.repo.reserveEvaluation(evaluation(competing)).status).toBe('busy')

    f.repo.dispatchEvaluation(admitted.id)
    f.repo.settleEvaluation(admitted.id, { outcome: 'failed', physicalReleased: false })
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: admitted.id,
      phase: 'cleanup_unconfirmed',
      active: true,
      settledAt: null,
    })
    expect(f.repo.activeEvaluation()).toMatchObject({
      id: admitted.id,
      called: true,
      outcome: 'failed',
    })
    expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(false)
    expect(f.repo.reserveSchedulingProbe(probe(competing.sessionId))).toBe(false)
    expect(f.repo.reserveEvaluation(evaluation(competing)).status).toBe('busy')
    expect(f.repo.reserveEvaluation(evaluation(f.input.handoff)).status).toBe('duplicate')

    f.repo.settleEvaluation(admitted.id, { outcome: 'failed', physicalReleased: true })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      active: false,
      called: true,
      outcome: 'failed',
      settledAt: expect.any(String),
    })
    expect(storedOwner(f.db, admitted.id)).toMatchObject({
      active: false,
      phase: 'released',
      settledAt: expect.any(String),
    })
    expect(f.repo.reserveSchedulingProbe(probe(competing.sessionId))).toBe(true)
  })

  it('requires the exact current probe witness and retains missing or stale proof', async () => {
    const f = await fixture()
    const input = probe(null)
    expect(f.repo.reserveSchedulingProbe(input)).toBe(true)
    for (const missing of ['', 'null', '{}'])
      expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(input.id, missing)).toBe(false)
    expect(f.repo.activeSchedulingRuntimeOwner()?.id).toBe(input.id)

    const firstWitness = witness()
    f.repo.recordSchedulingRuntimeWitness(input.id, { witness: firstWitness })
    const firstJson = f.repo.activeSchedulingRuntimeOwner()!.physicalWitnessJson!
    const expanded = {
      ...firstWitness,
      members: [
        ...firstWitness.members,
        { pid: 4103, pgid: 4102, started: 'fixture-descendant-birth' },
      ],
    }
    f.repo.recordSchedulingRuntimeWitness(input.id, {
      witness: expanded,
      configurationFingerprint: 'b'.repeat(64),
    })
    f.repo.settleSchedulingProbe(input.id, false)
    const current = f.repo.activeSchedulingRuntimeOwner()!
    expect(current).toMatchObject({
      configurationFingerprint: 'b'.repeat(64),
      phase: 'cleanup_unconfirmed',
    })
    expect(JSON.parse(current.physicalWitnessJson!)).toEqual(expanded)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(input.id, firstJson)).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(randomUUID(), current.physicalWitnessJson!),
    ).toBe(false)
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(current)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(input.id, current.physicalWitnessJson!),
    ).toBe(true)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(input.id, current.physicalWitnessJson!),
    ).toBe(false)
    expect(f.repo.reserveSchedulingProbe(probe(f.sessionId))).toBe(true)
  })

  it('releases the evaluation projection together with matching physical-owner proof', async () => {
    const f = await fixture()
    const admitted = reserveEvaluation(f.db, f.input.handoff)
    f.repo.dispatchEvaluation(admitted.id)
    const physicalWitness = witness()
    f.repo.recordEvaluationPhysicalWitness(admitted.id, {
      witness: physicalWitness,
      configurationFingerprint,
    })
    f.repo.settleEvaluation(admitted.id, { outcome: 'completed', physicalReleased: false })
    const witnessJson = f.repo.activeSchedulingRuntimeOwner()!.physicalWitnessJson!
    expect(JSON.parse(witnessJson)).toEqual(physicalWitness)
    expect(f.repo.activeEvaluation()).toMatchObject({
      id: admitted.id,
      outcome: 'completed',
      physicalWitnessJson: witnessJson,
    })
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, '{}')).toBe(false)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, witnessJson)).toBe(true)
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      active: false,
      outcome: 'completed',
      called: true,
    })
    expect(storedOwner(f.db, admitted.id)).toMatchObject({ active: false, phase: 'released' })
    expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(true)
  })

  it('rolls back evaluation admission if its physical reservation cannot be persisted', async () => {
    const f = await fixture()
    f.db.drizzle.run(sql`CREATE TEMP TRIGGER reject_scheduling_owner
      BEFORE INSERT ON scheduling_runtime_owners
      BEGIN SELECT RAISE(ABORT, 'fixture physical reservation failure'); END`)
    expect(() => f.repo.reserveEvaluation(evaluation(f.input.handoff))).toThrow(
      'fixture physical reservation failure',
    )
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.decisionEvaluationReceipt(f.input.handoff)).toBeUndefined()
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    f.db.drizzle.run(sql`DROP TRIGGER reject_scheduling_owner`)
    reserveEvaluation(f.db, f.input.handoff)
  })

  it('rolls back physical release if the evaluation projection cannot be settled', async () => {
    const f = await fixture()
    const admitted = reserveEvaluation(f.db, f.input.handoff)
    const before = f.repo.activeSchedulingRuntimeOwner()
    f.db.drizzle.run(sql`CREATE TEMP TRIGGER reject_evaluation_release
      BEFORE UPDATE OF active ON scheduling_evaluations WHEN NEW.active = 0
      BEGIN SELECT RAISE(ABORT, 'fixture evaluation settlement failure'); END`)
    expect(() =>
      f.repo.settleEvaluation(admitted.id, { outcome: 'not_sent', physicalReleased: true }),
    ).toThrow('fixture evaluation settlement failure')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(storedEvaluation(f.db, admitted.id)).toEqual(admitted)
    expect(f.repo.reserveSchedulingProbe(probe(null))).toBe(false)
    f.db.drizzle.run(sql`DROP TRIGGER reject_evaluation_release`)
    f.repo.settleEvaluation(admitted.id, { outcome: 'not_sent', physicalReleased: true })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
  })

  it.each(['probe', 'evaluation'] as const)(
    'retains a %s without a witness across a real database close and reopen',
    async (kind) => {
      const filePath = await databaseFile()
      const f = await fixture(filePath)
      if (kind === 'probe') f.repo.reserveSchedulingProbe(probe(null))
      else reserveEvaluation(f.db, f.input.handoff)
      const before = f.repo.activeSchedulingRuntimeOwner()!
      expect(before.physicalWitnessJson).toBeNull()
      f.db.close()
      databases.delete(f.db)

      const reopened = await PactDatabase.open({ filePath, migrationsFolder })
      databases.add(reopened)
      const repo = reopened.conversationRepository
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(before.id, 'null')).toBe(false)
      expect(repo.reserveSchedulingProbe(probe(null))).toBe(false)
      expect(repo.reserveSchedulingProbe(probe(f.sessionId))).toBe(false)
      expect(repo.reserveEvaluation(evaluation(anotherProjectHandoff(reopened))).status).toBe(
        'busy',
      )
      expect(repo.activeEvaluation()?.id).toBe(kind === 'evaluation' ? before.id : undefined)
      expect(repo.activeEvaluation()?.physicalWitnessJson).toBe(
        kind === 'evaluation' ? null : undefined,
      )
      expect(repo.reserveEvaluation(evaluation(f.input.handoff)).status).toBe(
        kind === 'evaluation' ? 'duplicate' : 'busy',
      )
    },
  )

  it.each([false, true])(
    'migrates the complete 0077 history with active evaluation witness=%s without losing admission facts',
    async (withWitness) => {
      const f = await fixture()
      const inactive = reserveEvaluation(f.db, f.input.handoff)
      f.repo.settleEvaluation(inactive.id, { outcome: 'not_sent', physicalReleased: true })
      const active = reserveEvaluation(f.db, anotherProjectHandoff(f.db))
      f.repo.dispatchEvaluation(active.id)
      if (withWitness)
        f.repo.recordEvaluationPhysicalWitness(active.id, {
          witness: witness(),
          configurationFingerprint,
        })
      const filePath = await databaseFile()
      copyLegacyDatabase(f.db, filePath, migrationsFolder, 77)
      const legacy = new Database(filePath, { readonly: true })
      let evaluations: Record<string, unknown>[], history: unknown[]
      try {
        evaluations = legacy
          .prepare<[], Record<string, unknown>>('SELECT * FROM scheduling_evaluations ORDER BY id')
          .all()
        history = legacy.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
        expect(history).toHaveLength(78)
        expect(
          legacy
            .prepare("SELECT name FROM sqlite_master WHERE name='scheduling_runtime_owners'")
            .get(),
        ).toBeUndefined()
      } finally {
        legacy.close()
      }

      const upgraded = await PactDatabase.open({ filePath, migrationsFolder })
      databases.add(upgraded)
      const repo = upgraded.conversationRepository
      expect(upgraded.drizzle.all(sql`SELECT * FROM scheduling_evaluations ORDER BY id`)).toEqual(
        evaluations.map((row) =>
          Object.assign({}, row, { input_sha256: null, selected_candidate_id: null }),
        ),
      )
      expect(
        upgraded.drizzle
          .all(sql`SELECT * FROM __drizzle_migrations ORDER BY id`)
          .slice(0, history.length),
      ).toEqual(history)
      const owner = repo.activeSchedulingRuntimeOwner()!
      expect(owner).toMatchObject({
        id: active.id,
        kind: 'evaluation',
        evaluationId: active.id,
        sessionId: active.sessionId,
        provider: active.provider,
        model: active.model,
        configurationFingerprint: active.configurationFingerprint,
        physicalWitnessJson: storedEvaluation(f.db, active.id)!.physicalWitnessJson,
        active: true,
        phase: 'cleanup_unconfirmed',
        createdAt: active.createdAt,
        deadline: active.deadline,
      })
      expect(storedOwner(upgraded, inactive.id)).toBeUndefined()
      expect(repo.activeEvaluation()).toMatchObject({ id: active.id, called: true })
      expect(repo.reserveSchedulingProbe(probe(null))).toBe(false)
      expect(repo.reserveSchedulingProbe(probe(f.sessionId))).toBe(false)
      expect(repo.reserveEvaluation(evaluation(anotherProjectHandoff(upgraded))).status).toBe(
        'busy',
      )
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(active.id, 'null')).toBe(false)
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(owner)
      expect(
        repo.settleSchedulingOwnerAfterPhysicalProof(
          active.id,
          owner.physicalWitnessJson ?? 'null',
        ),
      ).toBe(withWitness)
      expect(repo.activeEvaluation()?.id).toBe(withWitness ? undefined : active.id)
      expect(repo.activeEvaluation()?.physicalWitnessJson).toBe(withWitness ? undefined : null)
      expect(repo.reserveSchedulingProbe(probe(null))).toBe(withWitness)
    },
  )
})
