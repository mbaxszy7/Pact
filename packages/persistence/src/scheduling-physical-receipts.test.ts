import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  DecisionHttpOwner,
  DecisionWindowsPhysicalWitness,
  SchedulingHandoff,
} from '@pact/contracts'

import { decisionPhysicalWitnessSchema } from '@pact/contracts'

import {
  decisionFixture,
  seedHistoricalDecisionEvaluation,
} from './decision-fixture.test-support.js'
import { PactDatabase } from './pact-database.js'
import {
  schedulingBudgetCounters,
  schedulingEvaluations,
  schedulingPhysicalReceipts,
  schedulingRuntimeOwners,
} from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const configurationFingerprint = 'a'.repeat(64)
const databases = new Set<PactDatabase>()
const directories: string[] = []
type Fixture = Awaited<ReturnType<typeof fixture>>

afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases) database.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function fixture(filePath = ':memory:') {
  const f = await decisionFixture(filePath)
  databases.add(f.db)
  return f
}

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-physical-receipt-'))
  directories.push(directory)
  return join(directory, 'pact.sqlite')
}

// These are schema-valid database facts. No native processes or receipt files are created.
function windowsWitness(): DecisionWindowsPhysicalWitness {
  const witness = decisionPhysicalWitnessSchema.parse({
    version: 2,
    platform: 'win32',
    ownerId: randomUUID(),
    generation: randomUUID(),
    protocolVersion: 1,
    phase: 'contained',
    owner: { pid: 5101, creationFileTime: '133700000000000001' },
    bridge: { pid: 5102, creationFileTime: '133700000000000002' },
    root: { pid: 5103, creationFileTime: '133700000000000003' },
    receipt: { id: randomUUID(), volumeSerial: 'b'.repeat(16), fileId: 'c'.repeat(32) },
    atomicJob: true,
    noBreakaway: true,
  })
  if (witness.platform !== 'win32') throw Error('Expected a Windows witness')
  return witness
}

/** Directly seed a historical native probe owner; the removed producer no longer admits new work. */
function historicalProbe(
  f: Fixture,
  overrides: Partial<typeof schedulingRuntimeOwners.$inferInsert> = {},
) {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  f.db.drizzle
    .insert(schedulingRuntimeOwners)
    .values({
      id,
      kind: 'probe',
      sessionId: null,
      provider: 'claude',
      model: 'claude-haiku-5-5',
      configurationFingerprint,
      physicalWitnessJson: null,
      nativeGeneration: 0,
      active: true,
      phase: 'cleanup_unconfirmed',
      createdAt,
      deadline: new Date(Date.now() + 15_000).toISOString(),
      ...overrides,
    })
    .run()
  return id
}

/** Directly seed a passive durable physical receipt against an owned row. */
function pendingReceipt(
  f: Fixture,
  runtimeOwnerId: string,
  witness: DecisionWindowsPhysicalWitness,
  nativeGeneration: number,
  state: 'pending' | 'retiring' = 'pending',
) {
  f.db.drizzle
    .insert(schedulingPhysicalReceipts)
    .values({
      receiptId: witness.receipt.id,
      runtimeOwnerId,
      nativeGeneration,
      witnessJson: JSON.stringify(witness),
      state,
      entryBytes: Buffer.byteLength(
        JSON.stringify({
          receiptId: witness.receipt.id,
          runtimeOwnerId,
          nativeGeneration,
          witnessJson: JSON.stringify(witness),
          state: 'retiring',
          entryBytes: 2048,
        }),
      ),
    })
    .run()
  return witness.receipt.id
}

/** Historical probe with a recorded current witness, closed by the real physical-proof path. */
function closeHistoricalProbe(f: Fixture, witness = windowsWitness(), generation = 1) {
  const id = historicalProbe(f, {
    nativeGeneration: generation,
    physicalWitnessJson: JSON.stringify(witness),
    phase: 'cleanup_unconfirmed',
  })
  expect(
    f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), generation),
  ).toBe(true)
  return id
}

function httpOwner(): DecisionHttpOwner {
  return {
    version: 1,
    kind: 'http',
    utilityEpoch: randomUUID(),
    utilityPid: process.pid,
    requestId: randomUUID(),
  }
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

function receipts(db: PactDatabase) {
  return db.drizzle.select().from(schedulingPhysicalReceipts).all()
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

describe('Durable scheduling physical receipts', () => {
  it.each(['probe', 'evaluation'] as const)(
    'keeps an unknown preparing %s blocking across restart and rejects proof for its previous stage',
    async (kind) => {
      const filePath = await databaseFile()
      const f = await fixture(filePath)
      const previous = windowsWitness()
      const owner = {
        nativeGeneration: 2,
        nativeStage: 'project_metadata' as const,
        physicalWitnessJson: null,
        phase: 'preparing' as const,
      }
      const id =
        kind === 'probe'
          ? historicalProbe(f, { sessionId: f.sessionId, ...owner })
          : seedHistoricalDecisionEvaluation(f.db, f.input, previous)
      if (kind === 'evaluation') {
        // A preparing-stage evaluation never reached inference: uncalled, no usage, no budget call.
        f.db.drizzle
          .update(schedulingEvaluations)
          .set({
            called: false,
            outcome: 'reserved',
            physicalWitnessJson: null,
            usageJson: null,
          })
          .where(eq(schedulingEvaluations.id, id))
          .run()
        f.db.drizzle
          .update(schedulingRuntimeOwners)
          .set(owner)
          .where(eq(schedulingRuntimeOwners.id, id))
          .run()
        f.db.drizzle
          .update(schedulingBudgetCounters)
          .set({ evaluationCalls: 0 })
          .where(eq(schedulingBudgetCounters.subjectId, f.input.handoff.budgetSubjectId))
          .run()
      }
      pendingReceipt(f, id, previous, 1)
      const before = f.repo.activeSchedulingRuntimeOwner()
      const beforeEvaluation = storedEvaluation(f.db, id)
      const retained = receipts(f.db)
      f.db.close()
      databases.delete(f.db)
      const db = await PactDatabase.open({ filePath, migrationsFolder })
      databases.add(db)
      const repo = db.conversationRepository
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
      expect(storedEvaluation(db, id)).toEqual(beforeEvaluation)
      expect(repo.activeSchedulingRuntimeOwner()).toMatchObject({
        phase: 'preparing',
        nativeGeneration: 2,
        physicalWitnessJson: null,
        active: true,
      })
      expect(receipts(db)).toEqual(retained)
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(previous), 1)).toBe(
        false,
      )
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(previous), 2)).toBe(
        false,
      )
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(id, 'null', 2)).toBe(false)
      expect(storedEvaluation(db, id)?.called).toBe(kind === 'evaluation' ? false : undefined)
      expect(repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
      const sha = createHash('sha256').update(JSON.stringify(f.input)).digest('hex')
      expect(
        repo.reserveEvaluation(httpEvaluation(db, f.input.handoff, httpOwner(), sha)).status,
      ).toBe(kind === 'evaluation' ? 'duplicate' : 'busy')
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
    },
  )

  it('replays committed receipt retirement after restart and deletes only an exact retiring acknowledgement', async () => {
    const filePath = await databaseFile()
    const f = await fixture(filePath)
    const firstWitness = windowsWitness(),
      secondWitness = windowsWitness()
    const id = historicalProbe(f, {
      nativeGeneration: 2,
      nativeStage: 'guarded_context',
      physicalWitnessJson: JSON.stringify(secondWitness),
      phase: 'cleanup_unconfirmed',
    })
    pendingReceipt(f, id, firstWitness, 1)
    // The real proof path must append the current generation's own receipt.
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(secondWitness), 2),
    ).toBe(true)
    const pending = receipts(f.db)
    expect(pending).toHaveLength(2)
    expect(
      f.repo.acknowledgeSchedulingPhysicalReceipt(pending[0]!.receiptId, pending[0]!.witnessJson),
    ).toBe(false)
    const claimed = f.repo.claimSchedulingPhysicalReceipt()!
    expect(claimed).toMatchObject({ state: 'retiring', witness: JSON.parse(claimed.witnessJson) })
    expect(receipts(f.db).find((row) => row.receiptId === claimed.receiptId)?.state).toBe(
      'retiring',
    )
    expect(f.repo.acknowledgeSchedulingPhysicalReceipt(claimed.receiptId, '{}')).toBe(false)
    expect(f.repo.acknowledgeSchedulingPhysicalReceipt(randomUUID(), claimed.witnessJson)).toBe(
      false,
    )
    // A crash after the native file deletion but before ACK has this same durable state.
    // Filesystem absence and deletion are exercised separately at the native boundary.
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(db)
    const repo = db.conversationRepository
    expect(repo.claimSchedulingPhysicalReceipt()).toEqual(claimed)
    expect(repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(repo.acknowledgeSchedulingPhysicalReceipt(claimed.receiptId, claimed.witnessJson)).toBe(
      true,
    )
    expect(repo.acknowledgeSchedulingPhysicalReceipt(claimed.receiptId, claimed.witnessJson)).toBe(
      false,
    )
    const next = repo.claimSchedulingPhysicalReceipt(claimed.receiptId)!
    expect(next.receiptId > claimed.receiptId).toBe(true)
    expect(next.state).toBe('retiring')
    expect(repo.acknowledgeSchedulingPhysicalReceipt(next.receiptId, next.witnessJson)).toBe(true)
    expect(repo.claimSchedulingPhysicalReceipt()).toBeUndefined()
    expect(receipts(db)).toEqual([])
  })

  it('admits new HTTP work while passive receipts retain the old probe, then deletes only the acknowledged receipt', async () => {
    const f = await fixture()
    const first = closeHistoricalProbe(f)
    expect(storedOwner(f.db, first)).toMatchObject({ active: false })
    const receipt = f.repo.claimSchedulingPhysicalReceipt()!
    expect(receipt).toMatchObject({ state: 'retiring' })
    // The passive old receipt never occupies current HTTP admission.
    const owner = httpOwner()
    const reserved = f.repo.reserveEvaluation(
      httpEvaluation(
        f.db,
        f.input.handoff,
        owner,
        createHash('sha256').update(JSON.stringify(f.input)).digest('hex'),
      ),
    )
    if (reserved.status !== 'reserved') throw Error('Expected an HTTP reservation')
    expect(f.repo.activeSchedulingRuntimeOwner()?.id).not.toBe(first)
    f.repo.dispatchEvaluation(reserved.evaluation.id, owner)
    expect(
      f.repo.acknowledgeSchedulingPhysicalReceipt(receipt.receiptId, receipt.witnessJson),
    ).toBe(true)
    // The acknowledged old receipt never touched the still-active HTTP owner.
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      evaluationId: reserved.evaluation.id,
      phase: 'running',
    })
    expect(receipts(f.db)).toEqual([])
    f.repo.settleEvaluation(reserved.evaluation.id, {
      outcome: 'failed',
      physicalReleased: true,
      httpOwner: owner,
      remoteOutcome: 'unknown',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    // Historical inactive probe metadata is a closed finite set; ACK deletes only the receipt.
    expect(storedOwner(f.db, first)).toMatchObject({ active: false })
  })

  it('accounts for the current Windows witness and next allocation and refuses a thirty-third retained receipt atomically', async () => {
    const f = await fixture()
    for (let count = 0; count < 30; count++) closeHistoricalProbe(f)
    expect(receipts(f.db)).toHaveLength(30)
    // The 31st ACTIVE owner with a current witness still admits the next allocation.
    const witness31 = windowsWitness()
    const thirtyFirst = historicalProbe(f, {
      nativeGeneration: 1,
      physicalWitnessJson: JSON.stringify(witness31),
      phase: 'cleanup_unconfirmed',
    })
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(true)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(thirtyFirst, JSON.stringify(witness31), 1),
    ).toBe(true)
    expect(receipts(f.db)).toHaveLength(31)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(true)
    // The 32nd ACTIVE owner has no capacity for the next allocation but still proves its own.
    const witness32 = windowsWitness()
    const thirtySecond = historicalProbe(f, {
      nativeGeneration: 1,
      physicalWitnessJson: JSON.stringify(witness32),
      phase: 'cleanup_unconfirmed',
    })
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(thirtySecond, JSON.stringify(witness32), 1),
    ).toBe(true)
    expect(receipts(f.db)).toHaveLength(32)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)

    // An already-allocated historical witness must remain owned when its receipt append hits the budget.
    const witness = windowsWitness()
    const overflow = historicalProbe(f, {
      nativeGeneration: 1,
      physicalWitnessJson: JSON.stringify(witness),
      phase: 'cleanup_unconfirmed',
    })
    const before = f.repo.activeSchedulingRuntimeOwner()
    expect(() =>
      f.repo.settleSchedulingOwnerAfterPhysicalProof(overflow, JSON.stringify(witness), 1),
    ).toThrow('receipt budget is full')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(receipts(f.db)).toHaveLength(32)
  })

  it('fails closed when persisted byte accounting is exhausted even with fewer than 32 receipts', async () => {
    const f = await fixture()
    closeHistoricalProbe(f)
    // Exercise corrupt/oversized durable accounting separately from valid bounded records.
    f.db.drizzle
      .update(schedulingPhysicalReceipts)
      .set({ entryBytes: 64 * 1024 })
      .run()
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)
    expect(() => f.repo.claimSchedulingPhysicalReceipt()).toThrow('metadata is invalid')
    const witness = windowsWitness()
    const id = historicalProbe(f, {
      nativeGeneration: 1,
      physicalWitnessJson: JSON.stringify(witness),
      phase: 'cleanup_unconfirmed',
    })
    const before = f.repo.activeSchedulingRuntimeOwner()
    expect(() =>
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), 1),
    ).toThrow('receipt budget is full')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(receipts(f.db)).toHaveLength(1)
  })

  it('keeps the evaluation and physical owner active if its final receipt cannot commit', async () => {
    const f = await fixture()
    const witness = windowsWitness()
    const id = seedHistoricalDecisionEvaluation(f.db, f.input, witness)
    f.db.drizzle
      .update(schedulingRuntimeOwners)
      .set({ nativeGeneration: 3 })
      .where(eq(schedulingRuntimeOwners.id, id))
      .run()
    pendingReceipt(f, id, windowsWitness(), 1)
    pendingReceipt(f, id, windowsWitness(), 2)
    const owner = f.repo.activeSchedulingRuntimeOwner()
    const evaluation = storedEvaluation(f.db, id)
    const before = receipts(f.db)
    f.db.drizzle.run(
      sql`CREATE TEMP TRIGGER fail_final_receipt BEFORE INSERT ON scheduling_physical_receipts BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END`,
    )
    expect(() =>
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), 3),
    ).toThrow('fixture final receipt failure')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(owner)
    expect(storedEvaluation(f.db, id)).toEqual(evaluation)
    expect(receipts(f.db)).toEqual(before)
    f.db.drizzle.run(sql`DROP TRIGGER fail_final_receipt`)
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), 3)).toBe(
      true,
    )
    expect(receipts(f.db)).toHaveLength(3)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
  })
})
