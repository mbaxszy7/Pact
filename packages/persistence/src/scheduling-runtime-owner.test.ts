import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  DecisionDarwinPhysicalWitness,
  DecisionHttpOwner,
  SchedulingHandoff,
} from '@pact/contracts'

import { ensureHandoff } from './conversation-scheduling.js'
import {
  decisionFixture,
  seedHistoricalDecisionEvaluation,
} from './decision-fixture.test-support.js'
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

type Fixture = Awaited<ReturnType<typeof fixture>>

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-scheduling-owner-'))
  directories.push(directory)
  return join(directory, 'pact.sqlite')
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

function httpOwner(pid = process.pid): DecisionHttpOwner {
  return {
    version: 1,
    kind: 'http',
    utilityEpoch: randomUUID(),
    utilityPid: pid,
    requestId: randomUUID(),
  }
}

/** Directly seed a historical native probe owner; the removed producer no longer admits new work. */
function historicalProbe(
  f: Fixture,
  overrides: Partial<typeof schedulingRuntimeOwners.$inferInsert> = {},
) {
  const id = randomUUID()
  f.db.drizzle
    .insert(schedulingRuntimeOwners)
    .values({
      id,
      kind: 'probe',
      sessionId: null,
      provider: 'codex',
      model: 'gpt-6-luna',
      configurationFingerprint,
      physicalWitnessJson: null,
      nativeGeneration: 0,
      active: true,
      phase: 'cleanup_unconfirmed',
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 15_000).toISOString(),
      ...overrides,
    })
    .run()
  return id
}

function httpEvaluation(
  db: PactDatabase,
  handoff: SchedulingHandoff,
  owner: DecisionHttpOwner,
  sha: string,
) {
  return {
    handoff,
    configurationFingerprint: db.conversationRepository.schedulingConfigurationFingerprint(),
    inputSha256: sha,
    httpOwner: owner,
    deadlineAt: Date.now() + 15_000,
  }
}

function inputSha256(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function reserveHttpEvaluation(db: PactDatabase, input: ReturnType<typeof httpEvaluation>) {
  const reserved = db.conversationRepository.reserveEvaluation(input)
  expect(reserved.status).toBe('reserved')
  if (reserved.status !== 'reserved') throw Error('Expected an HTTP evaluation reservation')
  return reserved.evaluation
}

describe('App-wide scheduling physical owner', () => {
  it.each(['global', 'project'] as const)(
    '%s probe excludes new HTTP evaluations until physical release',
    async (scope) => {
      const f = await fixture()
      const nativeWitness = witness()
      const id = historicalProbe(f, {
        sessionId: scope === 'global' ? null : f.sessionId,
        physicalWitnessJson: JSON.stringify(nativeWitness),
      })
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id,
        kind: 'probe',
        evaluationId: null,
        active: true,
        phase: 'cleanup_unconfirmed',
        physicalWitnessJson: JSON.stringify(nativeWitness),
      })
      expect(f.repo.activeEvaluation()).toBeUndefined()
      const owner = httpOwner()
      expect(
        f.repo.reserveEvaluation(httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)))
          .status,
      ).toBe('busy')
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
      expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, 'null')).toBe(false)
      expect(
        f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(nativeWitness)),
      ).toBe(true)
      expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
      expect(storedOwner(f.db, id)).toMatchObject({ active: false, phase: 'released' })
      const admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, httpOwner(), inputSha256(f.input)),
      )
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id: admitted.id,
        kind: 'evaluation',
        evaluationId: admitted.id,
      })
      expect(f.repo.activeEvaluation()).toMatchObject({ id: admitted.id })
    },
  )

  it('evaluation cleanup blocks global and other-project HTTP evaluations', async () => {
    const f = await fixture()
    const competing = anotherProjectHandoff(f.db)
    const owner = httpOwner()
    const admitted = reserveHttpEvaluation(
      f.db,
      httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
    )
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: admitted.id,
      kind: 'evaluation',
      sessionId: f.sessionId,
      evaluationId: admitted.id,
    })
    const competingSha = inputSha256({ ...f.input, handoff: competing })
    expect(
      f.repo.reserveEvaluation(httpEvaluation(f.db, competing, httpOwner(), competingSha)).status,
    ).toBe('busy')

    f.repo.dispatchEvaluation(admitted.id, owner)
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'failed',
      physicalReleased: false,
      httpOwner: owner,
      remoteOutcome: 'responded',
    })
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
    expect(
      f.repo.reserveEvaluation(httpEvaluation(f.db, competing, httpOwner(), competingSha)).status,
    ).toBe('busy')
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(f.db, f.input.handoff, httpOwner(), inputSha256(f.input)),
      ).status,
    ).toBe('duplicate')

    f.repo.settleEvaluation(admitted.id, {
      outcome: 'failed',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'responded',
    })
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
    expect(
      f.repo.reserveEvaluation(httpEvaluation(f.db, competing, httpOwner(), competingSha)).status,
    ).toBe('reserved')
  })

  it('requires the exact current historical probe witness and retains missing or stale proof', async () => {
    const f = await fixture()
    const firstWitness = witness()
    const expanded = {
      ...firstWitness,
      members: [
        ...firstWitness.members,
        { pid: 4103, pgid: 4102, started: 'fixture-descendant-birth' },
      ],
    }
    // A historical witness change is durable metadata; the stale one never matches later proof.
    const id = historicalProbe(f, {
      configurationFingerprint: 'b'.repeat(64),
      physicalWitnessJson: JSON.stringify(expanded),
    })
    for (const missing of ['', 'null', '{}'])
      expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, missing)).toBe(false)
    expect(f.repo.activeSchedulingRuntimeOwner()?.id).toBe(id)

    const current = f.repo.activeSchedulingRuntimeOwner()!
    expect(current).toMatchObject({
      configurationFingerprint: 'b'.repeat(64),
      phase: 'cleanup_unconfirmed',
    })
    expect(JSON.parse(current.physicalWitnessJson!)).toEqual(expanded)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(firstWitness))).toBe(
      false,
    )
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(randomUUID(), current.physicalWitnessJson!),
    ).toBe(false)
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(current)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, current.physicalWitnessJson!)).toBe(
      true,
    )
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, current.physicalWitnessJson!)).toBe(
      false,
    )
    const released = f.repo.reserveEvaluation(
      httpEvaluation(f.db, f.input.handoff, httpOwner(), inputSha256(f.input)),
    )
    expect(released.status).toBe('reserved')
  })

  it('releases the evaluation projection together with matching physical-owner proof', async () => {
    const f = await fixture()
    const nativeWitness = witness()
    const id = seedHistoricalDecisionEvaluation(f.db, f.input, nativeWitness)
    f.db.drizzle
      .update(schedulingEvaluations)
      .set({ outcome: 'completed' })
      .where(eq(schedulingEvaluations.id, id))
      .run()
    const witnessJson = f.repo.activeSchedulingRuntimeOwner()!.physicalWitnessJson!
    expect(JSON.parse(witnessJson)).toEqual(nativeWitness)
    expect(f.repo.activeEvaluation()).toMatchObject({
      id,
      outcome: 'completed',
      physicalWitnessJson: witnessJson,
    })
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, '{}')).toBe(false)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, witnessJson)).toBe(true)
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(storedEvaluation(f.db, id)).toMatchObject({
      active: false,
      outcome: 'completed',
      called: true,
      usageJson: JSON.stringify({ inputTokens: 17, outputTokens: 5 }),
    })
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(storedOwner(f.db, id)).toMatchObject({ active: false, phase: 'released' })
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(f.db, f.input.handoff, httpOwner(), inputSha256(f.input)),
      ).status,
    ).toBe('duplicate')
    const competing = anotherProjectHandoff(f.db)
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('reserved')
  })

  it('rolls back evaluation admission if its physical reservation cannot be persisted', async () => {
    const f = await fixture()
    f.db.drizzle.run(sql`CREATE TEMP TRIGGER reject_scheduling_owner
      BEFORE INSERT ON scheduling_runtime_owners
      BEGIN SELECT RAISE(ABORT, 'fixture physical reservation failure'); END`)
    const owner = httpOwner()
    expect(() =>
      f.repo.reserveEvaluation(httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input))),
    ).toThrow('fixture physical reservation failure')
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.decisionEvaluationReceipt(f.input.handoff)).toBeUndefined()
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    f.db.drizzle.run(sql`DROP TRIGGER reject_scheduling_owner`)
    reserveHttpEvaluation(f.db, httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)))
  })

  it('rolls back physical release if the evaluation projection cannot be settled', async () => {
    const f = await fixture()
    const owner = httpOwner()
    const admitted = reserveHttpEvaluation(
      f.db,
      httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
    )
    const before = f.repo.activeSchedulingRuntimeOwner()
    f.db.drizzle.run(sql`CREATE TEMP TRIGGER reject_evaluation_release
      BEFORE UPDATE OF active ON scheduling_evaluations WHEN NEW.active = 0
      BEGIN SELECT RAISE(ABORT, 'fixture evaluation settlement failure'); END`)
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'not_sent',
        physicalReleased: true,
        httpOwner: owner,
        remoteOutcome: 'not_sent',
      }),
    ).toThrow('fixture evaluation settlement failure')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(storedEvaluation(f.db, admitted.id)).toEqual(admitted)
    const competing = anotherProjectHandoff(f.db)
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('busy')
    f.db.drizzle.run(sql`DROP TRIGGER reject_evaluation_release`)
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'not_sent',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'not_sent',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
  })

  it.each(['probe', 'evaluation'] as const)(
    'retains a %s without a witness across a real database close and reopen',
    async (kind) => {
      const filePath = await databaseFile()
      const f = await fixture(filePath)
      if (kind === 'probe') historicalProbe(f, { physicalWitnessJson: null })
      else {
        // Historical native evaluation whose witness never reached the durable row.
        const id = seedHistoricalDecisionEvaluation(f.db, f.input, witness())
        for (const table of [schedulingEvaluations, schedulingRuntimeOwners])
          f.db.drizzle
            .update(table)
            .set({ physicalWitnessJson: null })
            .where(eq(table.id, id))
            .run()
      }
      const before = f.repo.activeSchedulingRuntimeOwner()!
      expect(before.physicalWitnessJson).toBeNull()
      f.db.close()
      databases.delete(f.db)

      const reopened = await PactDatabase.open({ filePath, migrationsFolder })
      databases.add(reopened)
      const repo = reopened.conversationRepository
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(before.id, 'null')).toBe(false)
      const competing = anotherProjectHandoff(reopened)
      expect(
        repo.reserveEvaluation(
          httpEvaluation(
            reopened,
            competing,
            httpOwner(),
            inputSha256({ ...f.input, handoff: competing }),
          ),
        ).status,
      ).toBe('busy')
      expect(repo.activeEvaluation()?.id).toBe(kind === 'evaluation' ? before.id : undefined)
      expect(repo.activeEvaluation()?.physicalWitnessJson).toBe(
        kind === 'evaluation' ? null : undefined,
      )
      expect(repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(
        kind === 'evaluation' ? 1 : 0,
      )
      expect(
        repo.reserveEvaluation(
          httpEvaluation(reopened, f.input.handoff, httpOwner(), inputSha256(f.input)),
        ).status,
      ).toBe(kind === 'evaluation' ? 'duplicate' : 'busy')
    },
  )

  it.each([false, true])(
    'migrates the complete 0077 history with active evaluation witness=%s without losing admission facts',
    async (withWitness) => {
      const f = await fixture()
      // Historical inactive eval: direct complete record, never called, no owner.
      const inactiveId = randomUUID()
      const inactiveHandoff = f.input.handoff
      ensureHandoff(f.db.drizzle, inactiveHandoff)
      f.db.drizzle
        .insert(schedulingEvaluations)
        .values({
          id: inactiveId,
          sessionId: inactiveHandoff.sessionId,
          handoffId: inactiveHandoff.id,
          budgetSubjectId: inactiveHandoff.budgetSubjectId,
          factFingerprint: inactiveHandoff.factFingerprint,
          provider: 'codex',
          model: 'gpt-6-luna',
          configurationFingerprint,
          handoffJson: JSON.stringify(inactiveHandoff),
          active: false,
          called: false,
          outcome: 'not_sent',
          createdAt: new Date().toISOString(),
          deadline: new Date(Date.now() + 15_000).toISOString(),
        })
        .run()
      const competing = anotherProjectHandoff(f.db)
      const activeInput = { ...f.input, handoff: competing }
      const activeId = seedHistoricalDecisionEvaluation(f.db, activeInput, witness())
      const active = {
        id: activeId,
        sessionId: competing.sessionId,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint,
        createdAt: storedEvaluation(f.db, activeId)!.createdAt,
        deadline: storedEvaluation(f.db, activeId)!.deadline,
      }
      if (!withWitness) {
        f.db.drizzle
          .update(schedulingEvaluations)
          .set({ physicalWitnessJson: null })
          .where(eq(schedulingEvaluations.id, active.id))
          .run()
        f.db.drizzle
          .update(schedulingRuntimeOwners)
          .set({ physicalWitnessJson: null })
          .where(eq(schedulingRuntimeOwners.id, active.id))
          .run()
      }
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
          Object.assign({}, row, {
            input_sha256: null,
            selected_candidate_id: null,
            remote_outcome: null,
          }),
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
      expect(storedOwner(upgraded, inactiveId)).toBeUndefined()
      expect(repo.activeEvaluation()).toMatchObject({ id: active.id, called: true })
      const third = anotherProjectHandoff(upgraded)
      expect(
        repo.reserveEvaluation(
          httpEvaluation(upgraded, third, httpOwner(), inputSha256({ ...f.input, handoff: third })),
        ).status,
      ).toBe('busy')
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
      const resumed = repo.reserveEvaluation(
        httpEvaluation(upgraded, third, httpOwner(), inputSha256({ ...f.input, handoff: third })),
      )
      expect(resumed.status).toBe(withWitness ? 'reserved' : 'busy')
      expect(repo.activeSchedulingRuntimeOwner()?.id).toBe(
        withWitness
          ? resumed.status === 'reserved'
            ? resumed.evaluation.id
            : undefined
          : active.id,
      )
    },
  )
})

describe('HTTP evaluation physical owner', () => {
  it('reserves one HTTP request owner without a native witness and blocks all competitors', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      sha = inputSha256(f.input),
      competing = anotherProjectHandoff(f.db)
    const admitted = reserveHttpEvaluation(f.db, httpEvaluation(f.db, f.input.handoff, owner, sha))
    expect(admitted).toMatchObject({
      id: owner.requestId,
      provider: 'openai',
      model: 'gpt-6-luna',
      inputSha256: sha,
      remoteOutcome: 'not_sent',
      called: false,
      outcome: 'reserved',
      physicalWitnessJson: null,
    })
    expect(storedOwner(f.db, admitted.id)).toMatchObject({
      kind: 'evaluation',
      evaluationId: admitted.id,
      provider: 'openai',
      phase: 'reserved',
      physicalWitnessJson: null,
      nativeStage: null,
      nativeGeneration: 0,
      httpOwnerJson: JSON.stringify(owner),
    })
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('busy')
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('busy')
    const duplicate = f.repo.reserveEvaluation(httpEvaluation(f.db, f.input.handoff, owner, sha))
    expect(duplicate.status).toBe('duplicate')
    if (duplicate.status !== 'duplicate') throw Error('Expected the original HTTP evaluation')
    expect(duplicate.evaluation.id).toBe(admitted.id)
    f.repo.dispatchEvaluation(admitted.id, owner)
    expect(f.repo.readSchedulingActivity({}).rows).toContainEqual(
      expect.objectContaining({ provider: 'openai' }),
    )
  })

  it('refuses malformed HTTP reservations without a durable row', async () => {
    const f = await fixture(),
      owner = httpOwner(),
      sha = inputSha256(f.input)
    const malformed: [unknown, string | RegExp][] = [
      [
        { ...httpEvaluation(f.db, f.input.handoff, owner, sha), inputSha256: undefined },
        'The complete evaluation input identity is invalid.',
      ],
      [
        { ...httpEvaluation(f.db, f.input.handoff, owner, sha), httpOwner: undefined },
        /Invalid input/u,
      ],
      [
        {
          ...httpEvaluation(f.db, f.input.handoff, owner, sha),
          httpOwner: { ...owner, requestId: 'not-a-uuid' },
        },
        /Invalid UUID/u,
      ],
      [
        {
          ...httpEvaluation(f.db, f.input.handoff, owner, sha),
          configurationFingerprint: 'f'.repeat(64),
        },
        'An exact configuration identity is required.',
      ],
      [
        { ...httpEvaluation(f.db, f.input.handoff, owner, sha), deadlineAt: Date.now() - 1 },
        'The evaluation deadline is unavailable.',
      ],
      [
        { ...httpEvaluation(f.db, f.input.handoff, owner, sha), deadlineAt: Date.now() + 30_000 },
        'The evaluation deadline is unavailable.',
      ],
      [
        { ...httpEvaluation(f.db, f.input.handoff, owner, sha), deadlineAt: NaN },
        'The evaluation deadline is unavailable.',
      ],
      [
        {
          ...httpEvaluation(f.db, f.input.handoff, owner, sha),
          httpOwner: { ...owner, utilityPid: 2_147_483_648 },
        },
        /Too big/u,
      ],
      // An old native-shaped request missing the new HTTP fields also rejects.
      [
        {
          handoff: f.input.handoff,
          provider: 'codex',
          model: 'gpt-6-luna',
          configurationFingerprint,
        },
        /Invalid input/u,
      ],
    ]
    for (const [value, expected] of malformed)
      expect(() =>
        // oxlint-disable-next-line typescript/unbound-method -- Reflect bypasses typing only at the deliberate invalid boundary.
        Reflect.apply(f.repo.reserveEvaluation, f.repo, [value]),
      ).toThrow(expected)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
  })

  it('dispatches only the exact bound HTTP owner and counts it once', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    for (const wrong of [
      { ...owner, utilityEpoch: randomUUID() },
      { ...owner, utilityPid: owner.utilityPid + 1 },
      { ...owner, requestId: randomUUID() },
    ])
      expect(() => f.repo.dispatchEvaluation(admitted.id, wrong)).toThrow(
        'The HTTP physical owner identity changed.',
      )
    expect(() =>
      // oxlint-disable-next-line typescript/unbound-method -- Reflect bypasses typing only for the intentional missing-owner negative.
      Reflect.apply(f.repo.dispatchEvaluation, f.repo, [admitted.id, undefined]),
    ).toThrow(/Invalid input/u)
    expect(f.repo.schedulingBudget(admitted.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
    expect(f.repo.dispatchEvaluation(admitted.id, owner).created).toBe(true)
    expect(f.repo.schedulingBudget(admitted.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      called: true,
      outcome: 'possibly_sent',
      remoteOutcome: 'unknown',
    })
    expect(storedOwner(f.db, admitted.id)).toMatchObject({ phase: 'running', active: true })
    const again = f.repo.dispatchEvaluation(admitted.id, owner)
    expect(again.created).toBe(false)
    expect(f.repo.schedulingBudget(admitted.budgetSubjectId)?.evaluationCalls).toBe(1)
    // Identity is validated even on the duplicate readback.
    expect(() =>
      f.repo.dispatchEvaluation(admitted.id, { ...owner, utilityEpoch: randomUUID() }),
    ).toThrow('The HTTP physical owner identity changed.')
    expect(() =>
      // oxlint-disable-next-line typescript/unbound-method -- Reflect bypasses typing only for the intentional missing-owner negative.
      Reflect.apply(f.repo.dispatchEvaluation, f.repo, [admitted.id, undefined]),
    ).toThrow(/Invalid input/u)
  })

  it('enforces remote-outcome monotonicity and terminal rules through HTTP settlement', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    // A missing proof never settles, and native proofs never settle HTTP.
    expect(() =>
      // oxlint-disable-next-line typescript/unbound-method -- Reflect bypasses typing only for the intentional missing-proof negative.
      Reflect.apply(f.repo.settleEvaluation, f.repo, [
        admitted.id,
        { outcome: 'not_sent', physicalReleased: true },
      ]),
    ).toThrow(/Invalid input/u)
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'not_sent',
        physicalReleased: true,
        httpOwner: httpOwner(),
        remoteOutcome: 'not_sent',
      }),
    ).toThrow('The evaluation owner proof does not match.')
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, 'null')).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, JSON.stringify(witness())),
    ).toBe(false)
    // An uncalled HTTP evaluation settles only not_sent.
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'failed',
        physicalReleased: true,
        httpOwner: owner,
        remoteOutcome: 'not_sent',
      }),
    ).toThrow('Record the evaluation invocation before settling its result.')
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'not_sent',
        physicalReleased: true,
        httpOwner: owner,
        remoteOutcome: 'unknown',
      }),
    ).toThrow('The evaluation remote outcome cannot regress.')
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'not_sent',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'not_sent',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      outcome: 'not_sent',
      remoteOutcome: 'not_sent',
      active: false,
    })
  })

  it('retains unknown delivery until exact physical settlement and forbids regression', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      competing = anotherProjectHandoff(f.db),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    f.repo.dispatchEvaluation(admitted.id, owner)
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'failed',
        physicalReleased: false,
        httpOwner: owner,
        remoteOutcome: 'not_sent',
      }),
    ).toThrow('The evaluation remote outcome cannot regress.')
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'completed',
        physicalReleased: false,
        httpOwner: owner,
        remoteOutcome: 'unknown',
      }),
    ).toThrow('The evaluation remote outcome cannot regress.')
    // Local failure with still-unknown delivery retains the physical owner.
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'failed',
      physicalReleased: false,
      httpOwner: owner,
      remoteOutcome: 'unknown',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: admitted.id,
      phase: 'cleanup_unconfirmed',
    })
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('busy')
    // Unknown may still learn a valid response before release.
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'failed',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'responded',
      usage: { inputTokens: 21, outputTokens: 7 },
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      outcome: 'failed',
      remoteOutcome: 'responded',
      usageJson: JSON.stringify({ inputTokens: 21, outputTokens: 7 }),
      active: false,
    })
    // The same fact remains a durable duplicate; a new distinct fact may reserve.
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(f.db, f.input.handoff, httpOwner(), inputSha256(f.input)),
      ).status,
    ).toBe('duplicate')
    expect(
      f.repo.reserveEvaluation(
        httpEvaluation(
          f.db,
          competing,
          httpOwner(),
          inputSha256({ ...f.input, handoff: competing }),
        ),
      ).status,
    ).toBe('reserved')
  })

  it('accepts a completed HTTP settlement only with a responded proof', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    f.repo.dispatchEvaluation(admitted.id, owner)
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'completed',
      physicalReleased: false,
      selectedCandidateId: 'wait',
      usage: { inputTokens: 9, outputTokens: 3 },
      httpOwner: owner,
      remoteOutcome: 'responded',
    })
    // Responded cannot regress to unknown.
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'completed',
        physicalReleased: true,
        httpOwner: owner,
        remoteOutcome: 'unknown',
      }),
    ).toThrow('The evaluation remote outcome cannot regress.')
    // A settled candidate cannot be replaced.
    expect(() =>
      f.repo.settleEvaluation(admitted.id, {
        outcome: 'completed',
        physicalReleased: true,
        selectedCandidateId: 'other',
        httpOwner: owner,
        remoteOutcome: 'responded',
      }),
    ).toThrow('A settled decision candidate cannot be replaced.')
    f.repo.settleEvaluation(admitted.id, {
      outcome: 'completed',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'responded',
    })
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      outcome: 'completed',
      selectedCandidateId: 'wait',
      remoteOutcome: 'responded',
      usageJson: JSON.stringify({ inputTokens: 9, outputTokens: 3 }),
      active: false,
    })
  })

  it('never lets native or foreign physical proof mutate or release an HTTP owner', async () => {
    const f = await fixture()
    const owner = httpOwner(),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    f.repo.dispatchEvaluation(admitted.id, owner)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, 'null')).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(admitted.id, JSON.stringify(witness())),
    ).toBe(false)
    expect(f.repo.settleSchedulingHttpOwnerAfterExit(admitted.id, JSON.stringify(owner))).toBe(true)
    expect(storedEvaluation(f.db, admitted.id)).toMatchObject({
      outcome: 'failed',
      remoteOutcome: 'unknown',
      called: true,
      active: false,
    })
    // A stale proof cannot release a different live owner.
    const different = anotherProjectHandoff(f.db)
    const replacement = reserveHttpEvaluation(
      f.db,
      httpEvaluation(f.db, different, httpOwner(), inputSha256({ ...f.input, handoff: different })),
    )
    expect(f.repo.settleSchedulingHttpOwnerAfterExit(replacement.id, JSON.stringify(owner))).toBe(
      false,
    )
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({ id: replacement.id })
    expect(f.repo.settleSchedulingHttpOwnerAfterExit(admitted.id, JSON.stringify(owner))).toBe(
      false,
    )
  })

  // Repository identity alone does not prove OS process absence; the actual spawned-child
  // absence check belongs to the Conversation reconstruction seam.
  it('retains an unknown HTTP owner across reopen until exact post-exit proof', async () => {
    const filePath = await databaseFile()
    const f = await fixture(filePath)
    const owner = httpOwner(),
      admitted = reserveHttpEvaluation(
        f.db,
        httpEvaluation(f.db, f.input.handoff, owner, inputSha256(f.input)),
      )
    f.repo.dispatchEvaluation(admitted.id, owner)
    const before = f.repo.activeSchedulingRuntimeOwner()!
    f.db.close()
    databases.delete(f.db)

    const reopened = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(reopened)
    const repo = reopened.conversationRepository
    expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(storedEvaluation(reopened, admitted.id)).toMatchObject({
      called: true,
      outcome: 'possibly_sent',
      remoteOutcome: 'unknown',
    })
    expect(repo.schedulingBudget(admitted.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(
      repo.settleSchedulingHttpOwnerAfterExit(
        admitted.id,
        JSON.stringify({ ...owner, utilityPid: 1 }),
      ),
    ).toBe(false)
    expect(repo.settleSchedulingHttpOwnerAfterExit(admitted.id, '{}')).toBe(false)
    expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(repo.settleSchedulingHttpOwnerAfterExit(admitted.id, JSON.stringify(owner))).toBe(true)
    expect(repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(storedEvaluation(reopened, admitted.id)).toMatchObject({
      called: true,
      outcome: 'failed',
      remoteOutcome: 'unknown',
      active: false,
    })
    expect(repo.schedulingBudget(admitted.budgetSubjectId)?.evaluationCalls).toBe(1)
    // An old proof cannot release a replacement owner.
    const replacement = anotherProjectHandoff(reopened)
    expect(
      repo.reserveEvaluation(
        httpEvaluation(
          reopened,
          replacement,
          httpOwner(),
          inputSha256({ ...f.input, handoff: replacement }),
        ),
      ).status,
    ).toBe('reserved')
    expect(repo.settleSchedulingHttpOwnerAfterExit(admitted.id, JSON.stringify(owner))).toBe(false)
  })

  it('migrates native 0097 history forward with HTTP columns NULL and admission intact', async () => {
    const f = await fixture()
    // Inactive historical eval: direct complete record, never called, no owner.
    ensureHandoff(f.db.drizzle, f.input.handoff)
    f.db.drizzle
      .insert(schedulingEvaluations)
      .values({
        id: randomUUID(),
        sessionId: f.input.handoff.sessionId,
        handoffId: f.input.handoff.id,
        budgetSubjectId: f.input.handoff.budgetSubjectId,
        factFingerprint: f.input.handoff.factFingerprint,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint,
        handoffJson: JSON.stringify(f.input.handoff),
        active: false,
        called: false,
        outcome: 'not_sent',
        createdAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 15_000).toISOString(),
      })
      .run()
    const competing = anotherProjectHandoff(f.db)
    const active = {
      id: seedHistoricalDecisionEvaluation(f.db, { ...f.input, handoff: competing }, witness()),
    }
    f.db.drizzle
      .update(schedulingEvaluations)
      .set({ usageJson: JSON.stringify({ inputTokens: 31, outputTokens: 4 }) })
      .where(eq(schedulingEvaluations.id, active.id))
      .run()
    const filePath = await databaseFile()
    copyLegacyDatabase(f.db, filePath, migrationsFolder, 97)
    const reopened = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(reopened)
    const repo = reopened.conversationRepository
    expect(
      reopened.drizzle.get<{
        missing: number
      }>(
        sql`SELECT count(*) AS missing FROM scheduling_evaluations WHERE remote_outcome IS NOT NULL`,
      ),
    ).toEqual({ missing: 0 })
    expect(
      reopened.drizzle.get<{ missing: number }>(
        sql`SELECT count(*) AS missing FROM scheduling_runtime_owners WHERE http_owner_json IS NOT NULL`,
      ),
    ).toEqual({ missing: 0 })
    const owner = repo.activeSchedulingRuntimeOwner()!
    expect(owner).toMatchObject({
      id: active.id,
      kind: 'evaluation',
      phase: 'cleanup_unconfirmed',
      httpOwnerJson: null,
    })
    expect(repo.activeEvaluation()).toMatchObject({
      id: active.id,
      called: true,
      outcome: 'failed',
    })
    expect(storedEvaluation(reopened, active.id)).toMatchObject({
      usageJson: JSON.stringify({ inputTokens: 31, outputTokens: 4 }),
      remoteOutcome: null,
    })
    // The retained native owner is not declared safe by the migration.
    const fresh = anotherProjectHandoff(reopened)
    expect(
      repo.reserveEvaluation(
        httpEvaluation(reopened, fresh, httpOwner(), inputSha256({ ...f.input, handoff: fresh })),
      ).status,
    ).toBe('busy')
    expect(repo.settleSchedulingHttpOwnerAfterExit(active.id, JSON.stringify(httpOwner()))).toBe(
      false,
    )
  })
})
