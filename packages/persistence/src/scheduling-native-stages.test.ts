/* oxlint-disable vitest/no-conditional-expect -- Probe and evaluation have different mandatory native stage obligations. */
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DecisionNativeStage, DecisionWindowsPhysicalWitness } from '@pact/contracts'

import { decisionPhysicalWitnessSchema } from '@pact/contracts'

import { decisionFixture } from './decision-fixture.test-support.js'
import { PactDatabase } from './pact-database.js'
import {
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
  f.repo.saveSchedulingSettings({
    expectedRevision: f.repo.schedulingSettings().revision,
    selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'claude-haiku-5-5' },
  })
  return f
}

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-native-stage-'))
  directories.push(directory)
  return join(directory, 'pact.sqlite')
}

function probeInput(sessionId: string | null) {
  return {
    id: randomUUID(),
    sessionId,
    provider: 'claude' as const,
    model: 'claude-haiku-5-5',
    configurationFingerprint,
    deadlineAt: Date.now() + 15_000,
  }
}

function reserveProbe(f: Fixture, sessionId: string | null = null) {
  const input = probeInput(sessionId)
  expect(f.repo.reserveSchedulingProbe(input)).toBe(true)
  return input.id
}

function reserveEvaluation(f: Fixture) {
  const result = f.repo.reserveEvaluation({
    handoff: f.input.handoff,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    configurationFingerprint,
  })
  expect(result.status).toBe('reserved')
  if (result.status !== 'reserved') throw Error('Expected an evaluation reservation')
  return result.evaluation.id
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

function begin(
  f: Fixture,
  id: string,
  stage: DecisionNativeStage,
  expectedGeneration: number,
  previousWitness: DecisionWindowsPhysicalWitness | null,
) {
  return f.repo.beginSchedulingNativeStage(id, {
    expectedGeneration,
    stage,
    previousWitness,
    previousPhysicalReleased: true,
  })
}

function record(f: Fixture, id: string, nativeGeneration: number) {
  const witness = windowsWitness()
  f.repo.recordSchedulingRuntimeWitness(id, { nativeGeneration, witness })
  return witness
}

describe('Windows tool-disabled native context', () => {
  it('cannot authorize inference from a pre-launch allocation', async () => {
    const f = await fixture(),
      id = reserveEvaluation(f),
      witness = windowsWitness()
    expect(begin(f, id, 'native_context', 0, null)).toBe(1)
    const allocated = decisionPhysicalWitnessSchema.parse({
      version: witness.version,
      platform: witness.platform,
      ownerId: witness.ownerId,
      generation: witness.generation,
      protocolVersion: witness.protocolVersion,
      phase: 'allocated',
      owner: witness.owner,
      receipt: witness.receipt,
    })
    f.repo.recordSchedulingRuntimeWitness(id, { nativeGeneration: 1, witness: allocated })
    expect(() =>
      f.repo.recordEvaluationPhysicalWitness(id, {
        witness: allocated,
        nativeGeneration: 1,
        configurationFingerprint,
      }),
    ).toThrow(/inference stage/u)
    f.repo.recordSchedulingRuntimeWitness(id, { nativeGeneration: 1, witness })
    f.repo.recordEvaluationPhysicalWitness(id, {
      nativeGeneration: 1,
      witness,
      configurationFingerprint,
    })
    expect(f.repo.dispatchEvaluation(id).created).toBe(true)
  })

  it('binds one inference generation to its Windows witness and closes the original admission', async () => {
    const f = await fixture(),
      id = reserveEvaluation(f)
    expect(begin(f, id, 'native_context', 0, null)).toBe(1)
    const witness = record(f, id, 1)
    f.repo.recordEvaluationPhysicalWitness(id, {
      witness,
      nativeGeneration: 1,
      configurationFingerprint,
    })
    expect(f.repo.dispatchEvaluation(id).created).toBe(true)
    expect(() => begin(f, id, 'host_metadata', 1, witness)).toThrow(/stage order/u)
    f.repo.completeSchedulingRuntimePhysical(id, {
      nativeGeneration: 1,
      witness,
      completed: true,
      candidateId: 'wait',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
  })

  it('does not admit a tool-disabled context for Codex or a Darwin physical witness', async () => {
    const f = await fixture(),
      id = reserveEvaluation(f)
    expect(begin(f, id, 'native_context', 0, null)).toBe(1)
    const darwin = {
      version: 1,
      platform: 'darwin',
      ownerId: randomUUID(),
      owner: { pid: 5101, started: 'owned-owner' },
      root: { pid: 5102, pgid: 5102, started: 'owned-root' },
      members: [{ pid: 5102, pgid: 5102, started: 'owned-root' }],
    }
    expect(() =>
      f.repo.recordSchedulingRuntimeWitness(id, {
        nativeGeneration: 1,
        witness: decisionPhysicalWitnessSchema.parse(darwin),
      }),
    ).toThrow(/Windows Claude/u)
    f.repo.completeSchedulingRuntimePhysical(id, {
      nativeGeneration: 1,
      witness: null,
      completed: false,
      candidateId: null,
    })
    f.repo.saveSchedulingSettings({
      expectedRevision: f.repo.schedulingSettings().revision,
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
    })
    const probe = probeInput(null)
    expect(
      f.repo.reserveSchedulingProbe({ ...probe, provider: 'codex', model: 'gpt-6-luna' }),
    ).toBe(true)
    expect(() => begin(f, probe.id, 'native_context', 0, null)).toThrow(/initial native stage/u)
  })
})

function receipts(db: PactDatabase) {
  return db.drizzle
    .select()
    .from(schedulingPhysicalReceipts)
    .orderBy(schedulingPhysicalReceipts.nativeGeneration)
    .all()
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

function completeHostProbe(f: Fixture) {
  const id = reserveProbe(f)
  expect(begin(f, id, 'host_metadata', 0, null)).toBe(1)
  const witness = record(f, id, 1)
  f.repo.settleSchedulingProbe(id, true)
  return { id, witness }
}

describe('Durable scheduling native stages and passive physical receipts', () => {
  it.each(['probe', 'evaluation'] as const)(
    'keeps the Codex %s in its exact serial native stages and original lease',
    async (kind) => {
      const f = await fixture()
      f.repo.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
      })
      let id: string
      if (kind === 'probe') {
        id = randomUUID()
        expect(
          f.repo.reserveSchedulingProbe({
            ...probeInput(f.sessionId),
            id,
            provider: 'codex',
            model: 'gpt-6-luna',
          }),
        ).toBe(true)
      } else {
        const reserved = f.repo.reserveEvaluation({
          handoff: f.input.handoff,
          provider: 'codex',
          model: 'gpt-6-luna',
          configurationFingerprint,
        })
        if (reserved.status !== 'reserved') throw Error('Expected Codex evaluation')
        id = reserved.evaluation.id
      }
      const original = f.repo.activeSchedulingRuntimeOwner()!
      expect(begin(f, id, 'host_metadata', 0, null)).toBe(1)
      const first = record(f, id, 1)
      expect(() => begin(f, id, 'project_metadata', 1, first)).toThrow('stage order')
      expect(begin(f, id, 'guarded_context', 1, first)).toBe(2)
      const inference = record(f, id, 2)
      if (kind === 'evaluation') {
        expect(f.repo.dispatchEvaluation(id).created).toBe(true)
        expect(begin(f, id, 'project_verification', 2, inference)).toBe(3)
        record(f, id, 3)
      } else {
        expect(() => begin(f, id, 'project_verification', 2, inference)).toThrow('stage order')
      }
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        id,
        active: true,
        deadline: original.deadline,
        nativeGeneration: kind === 'evaluation' ? 3 : 2,
      })
      expect(f.repo.reserveSchedulingProbe(probeInput(null))).toBe(false)
      if (kind === 'evaluation')
        f.repo.settleEvaluation(id, { outcome: 'completed', physicalReleased: true })
      else f.repo.settleSchedulingProbe(id, true)
      expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    },
  )
  it('keeps one evaluation admission through all four stages and retains every unacknowledged receipt', async () => {
    const f = await fixture()
    const id = reserveEvaluation(f)
    const originalOwner = f.repo.activeSchedulingRuntimeOwner()!
    const stages = [
      'host_metadata',
      'project_metadata',
      'guarded_context',
      'project_verification',
    ] as const
    const witnesses: DecisionWindowsPhysicalWitness[] = []
    let dispatched = false
    for (const [index, stage] of stages.entries()) {
      const previousEvaluation = storedEvaluation(f.db, id)
      expect(begin(f, id, stage, index, witnesses[index - 1] ?? null)).toBe(index + 1)
      expect(f.repo.activeSchedulingRuntimeOwner()).toEqual({
        ...originalOwner,
        nativeGeneration: index + 1,
        nativeStage: stage,
        phase: 'preparing',
        physicalWitnessJson: null,
      })
      expect(storedEvaluation(f.db, id)).toEqual(previousEvaluation)
      expect(receipts(f.db)).toHaveLength(index)
      expect(f.repo.reserveSchedulingProbe(probeInput(null))).toBe(false)
      const witness = windowsWitness()
      witnesses.push(witness)
      if (stage === 'guarded_context') {
        f.repo.recordEvaluationPhysicalWitness(id, {
          witness,
          nativeGeneration: index + 1,
          configurationFingerprint,
        })
        dispatched = f.repo.dispatchEvaluation(id).created
      } else f.repo.recordSchedulingRuntimeWitness(id, { witness, nativeGeneration: index + 1 })
    }
    expect(dispatched).toBe(true)
    const verificationOwner = f.repo.activeSchedulingRuntimeOwner()!
    const inferenceJson = JSON.stringify(witnesses[2])
    expect(verificationOwner).toMatchObject({
      nativeGeneration: 4,
      nativeStage: 'project_verification',
      deadline: originalOwner.deadline,
      active: true,
    })
    expect(storedEvaluation(f.db, id)).toMatchObject({
      called: true,
      physicalWitnessJson: inferenceJson,
      deadline: originalOwner.deadline,
      active: true,
    })
    expect(f.repo.activeEvaluation()?.physicalWitnessJson).toBe(
      verificationOwner.physicalWitnessJson,
    )
    expect(() => begin(f, id, 'host_metadata', 4, witnesses[3]!)).toThrow('no longer eligible')
    expect(() =>
      f.repo.recordEvaluationPhysicalWitness(id, {
        witness: witnesses[3]!,
        nativeGeneration: 4,
        configurationFingerprint,
      }),
    ).toThrow('Only the inference stage')

    f.repo.settleEvaluation(id, {
      outcome: 'completed',
      physicalReleased: false,
      usage: { inputTokens: 31, outputTokens: 7 },
    })
    expect(receipts(f.db)).toHaveLength(3)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      active: true,
      phase: 'cleanup_unconfirmed',
    })
    expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, inferenceJson, 3)).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, verificationOwner.physicalWitnessJson!, 3),
    ).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, verificationOwner.physicalWitnessJson!),
    ).toBe(false)
    expect(
      f.repo.settleSchedulingOwnerAfterPhysicalProof(id, verificationOwner.physicalWitnessJson!, 4),
    ).toBe(true)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(storedEvaluation(f.db, id)).toMatchObject({
      active: false,
      called: true,
      outcome: 'completed',
      physicalWitnessJson: inferenceJson,
      usageJson: '{"inputTokens":31,"outputTokens":7}',
    })
    expect(
      receipts(f.db).map((row) => ({
        receiptId: row.receiptId,
        runtimeOwnerId: row.runtimeOwnerId,
        nativeGeneration: row.nativeGeneration,
        witnessJson: row.witnessJson,
        state: row.state,
      })),
    ).toEqual(
      witnesses.map((witness, index) => ({
        receiptId: witness.receipt.id,
        runtimeOwnerId: id,
        nativeGeneration: index + 1,
        witnessJson: JSON.stringify(witness),
        state: 'pending',
      })),
    )
    expect(
      receipts(f.db).every(
        (row) =>
          row.entryBytes <= 2 * 1024 &&
          row.entryBytes >= Buffer.byteLength(JSON.stringify({ ...row, state: 'retiring' })),
      ),
    ).toBe(true)
    expect(receipts(f.db).reduce((sum, row) => sum + row.entryBytes, 0)).toBeLessThanOrEqual(
      64 * 1024,
    )
    expect(() => begin(f, id, 'host_metadata', 0, null)).toThrow('no longer eligible')
    reserveProbe(f)
    expect(receipts(f.db)).toHaveLength(4)
    expect(storedOwner(f.db, id)).toMatchObject({ active: false, phase: 'released' })
  })

  it.each(['global', 'project'] as const)(
    'uses the exact %s probe stage sequence without an evaluation verification stage',
    async (scope) => {
      const f = await fixture()
      const id = reserveProbe(f, scope === 'global' ? null : f.sessionId)
      const stages: DecisionNativeStage[] =
        scope === 'global'
          ? ['host_metadata', 'guarded_context']
          : ['host_metadata', 'project_metadata', 'guarded_context']
      let previous: DecisionWindowsPhysicalWitness | null = null
      for (const [index, stage] of stages.entries()) {
        expect(begin(f, id, stage, index, previous)).toBe(index + 1)
        previous = record(f, id, index + 1)
      }
      const owner = f.repo.activeSchedulingRuntimeOwner()!
      expect(() => begin(f, id, 'project_verification', stages.length, previous)).toThrow(
        'stage order',
      )
      expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(owner)
      expect(f.repo.activeEvaluation()).toBeUndefined()
      f.repo.settleSchedulingProbe(id, true)
      expect(receipts(f.db)).toHaveLength(stages.length)
      expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
      expect(() =>
        f.repo.recordSchedulingRuntimeWitness(id, {
          nativeGeneration: stages.length,
          witness: previous!,
        }),
      ).toThrow('unavailable')
    },
  )

  it('rejects duplicate, reordered, stale and unconfirmed callbacks without changing the current stage', async () => {
    const f = await fixture()
    expect(() => begin(f, randomUUID(), 'host_metadata', 0, null)).toThrow('no longer eligible')
    const id = reserveProbe(f)
    const reserved = f.repo.activeSchedulingRuntimeOwner()
    expect(() => begin(f, id, 'guarded_context', 0, null)).toThrow('initial native stage')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(reserved)
    expect(begin(f, id, 'host_metadata', 0, null)).toBe(1)
    const first = record(f, id, 1)
    const running = f.repo.activeSchedulingRuntimeOwner()
    expect(() => begin(f, id, 'host_metadata', 0, null)).toThrow('no longer eligible')
    expect(() => begin(f, id, 'host_metadata', 1, first)).toThrow('stage order')
    expect(() =>
      f.repo.beginSchedulingNativeStage(id, {
        expectedGeneration: 1,
        stage: 'guarded_context',
        previousWitness: first,
        previousPhysicalReleased: false,
      }),
    ).toThrow('no longer eligible')
    expect(() => begin(f, id, 'guarded_context', 1, windowsWitness())).toThrow(
      'physically confirmed',
    )
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(running)
    expect(receipts(f.db)).toEqual([])
    expect(begin(f, id, 'guarded_context', 1, first)).toBe(2)
    const preparing = f.repo.activeSchedulingRuntimeOwner()
    expect(() =>
      f.repo.recordSchedulingRuntimeWitness(id, { witness: first, nativeGeneration: 1 }),
    ).toThrow('older physical stage')
    expect(() =>
      f.repo.recordSchedulingRuntimeWitness(id, { witness: windowsWitness(), nativeGeneration: 3 }),
    ).toThrow('older physical stage')
    expect(() => f.repo.recordSchedulingRuntimeWitness(id, { witness: windowsWitness() })).toThrow(
      'older physical stage',
    )
    expect(() => begin(f, id, 'guarded_context', 2, null)).toThrow('physically confirmed')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(preparing)
    expect(receipts(f.db)).toHaveLength(1)
    record(f, id, 2)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      nativeGeneration: 2,
      phase: 'running',
    })
  })

  it.each(['cancelled', 'expired'] as const)(
    'does not allocate another stage after its owner is %s',
    async (reason) => {
      const f = await fixture()
      const id = reserveProbe(f)
      begin(f, id, 'host_metadata', 0, null)
      const witness = record(f, id, 1)
      if (reason === 'cancelled') f.repo.settleSchedulingProbe(id, false)
      else
        vi.spyOn(Date, 'now').mockReturnValue(
          Date.parse(f.repo.activeSchedulingRuntimeOwner()!.deadline) + 1,
        )
      const before = f.repo.activeSchedulingRuntimeOwner()
      expect(() => begin(f, id, 'guarded_context', 1, witness)).toThrow('no longer eligible')
      expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
      expect(receipts(f.db)).toEqual([])
      f.repo.recordSchedulingRuntimeWitness(id, { witness, nativeGeneration: 1 })
      expect(f.repo.activeSchedulingRuntimeOwner()?.phase).toBe(
        reason === 'cancelled' ? 'cleanup_unconfirmed' : 'running',
      )
      expect(f.repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), 1)).toBe(
        true,
      )
      expect(receipts(f.db)).toHaveLength(1)
    },
  )

  it.each(['probe', 'evaluation'] as const)(
    'keeps an unknown preparing %s blocking across restart and rejects proof for its previous stage',
    async (kind) => {
      const filePath = await databaseFile()
      const f = await fixture(filePath)
      const id = kind === 'probe' ? reserveProbe(f, f.sessionId) : reserveEvaluation(f)
      begin(f, id, 'host_metadata', 0, null)
      const previous = record(f, id, 1)
      begin(f, id, 'project_metadata', 1, previous)
      const before = f.repo.activeSchedulingRuntimeOwner()
      const retained = receipts(f.db)
      f.db.close()
      databases.delete(f.db)
      const db = await PactDatabase.open({ filePath, migrationsFolder })
      databases.add(db)
      const repo = db.conversationRepository
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
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
      expect(() =>
        repo.recordSchedulingRuntimeWitness(id, { nativeGeneration: 1, witness: previous }),
      ).toThrow('older physical stage')
      expect(() =>
        repo.beginSchedulingNativeStage(id, {
          expectedGeneration: 2,
          stage: 'guarded_context',
          previousWitness: null,
          previousPhysicalReleased: true,
        }),
      ).toThrow('physically confirmed')
      expect(repo.reserveSchedulingProbe(probeInput(null))).toBe(false)
      expect(
        repo.reserveEvaluation({
          handoff: f.input.handoff,
          provider: 'claude',
          model: 'claude-haiku-5-5',
          configurationFingerprint,
        }).status,
      ).toBe(kind === 'evaluation' ? 'duplicate' : 'busy')
      expect(repo.activeSchedulingRuntimeOwner()).toEqual(before)
    },
  )

  it('replays committed receipt retirement after restart and deletes only an exact retiring acknowledgement', async () => {
    const filePath = await databaseFile()
    const f = await fixture(filePath)
    const id = reserveProbe(f)
    begin(f, id, 'host_metadata', 0, null)
    const firstWitness = record(f, id, 1)
    begin(f, id, 'guarded_context', 1, firstWitness)
    record(f, id, 2)
    f.repo.settleSchedulingProbe(id, true)
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

  it('admits new work while passive receipts retain the old probe, then prunes only after acknowledgement', async () => {
    const f = await fixture()
    const first = completeHostProbe(f)
    const next = reserveProbe(f)
    expect(f.repo.activeSchedulingRuntimeOwner()?.id).toBe(next)
    expect(storedOwner(f.db, first.id)).toMatchObject({ active: false })
    const receipt = f.repo.claimSchedulingPhysicalReceipt()!
    f.repo.settleSchedulingProbe(next, true)
    const whileRetiring = reserveProbe(f)
    expect(storedOwner(f.db, first.id)).toMatchObject({ active: false })
    expect(receipts(f.db)).toMatchObject([{ receiptId: receipt.receiptId, state: 'retiring' }])
    expect(
      f.repo.acknowledgeSchedulingPhysicalReceipt(receipt.receiptId, receipt.witnessJson),
    ).toBe(true)
    expect(f.repo.activeSchedulingRuntimeOwner()?.id).toBe(whileRetiring)
    f.repo.settleSchedulingProbe(whileRetiring, true)
    reserveProbe(f)
    expect(storedOwner(f.db, first.id)).toBeUndefined()
    expect(storedOwner(f.db, next)).toBeUndefined()
    expect(storedOwner(f.db, whileRetiring)).toBeUndefined()
    expect(receipts(f.db)).toEqual([])
  })

  it('accounts for the current Windows witness and next allocation and refuses a thirty-third retained receipt atomically', async () => {
    const f = await fixture()
    for (let count = 0; count < 30; count++) completeHostProbe(f)
    expect(receipts(f.db)).toHaveLength(30)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(true)
    const id = reserveProbe(f)
    begin(f, id, 'host_metadata', 0, null)
    const first = record(f, id, 1)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(true)
    begin(f, id, 'guarded_context', 1, first)
    expect(receipts(f.db)).toHaveLength(31)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(true)
    record(f, id, 2)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)
    f.repo.settleSchedulingProbe(id, true)
    expect(receipts(f.db)).toHaveLength(32)
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)

    // An unexpected already-allocated witness must remain owned even if its caller missed preflight.
    const overflow = reserveProbe(f)
    begin(f, overflow, 'host_metadata', 0, null)
    const witness = record(f, overflow, 1)
    const before = f.repo.activeSchedulingRuntimeOwner()
    expect(() => begin(f, overflow, 'guarded_context', 1, witness)).toThrow(
      'receipt budget is full',
    )
    expect(() => f.repo.settleSchedulingProbe(overflow, true)).toThrow('receipt budget is full')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(receipts(f.db)).toHaveLength(32)
    f.repo.settleSchedulingProbe(overflow, false)
    expect(receipts(f.db)).toHaveLength(32)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      active: true,
      phase: 'cleanup_unconfirmed',
    })
  })

  it('fails closed when persisted byte accounting is exhausted even with fewer than 32 receipts', async () => {
    const f = await fixture()
    completeHostProbe(f)
    // Exercise corrupt/oversized durable accounting separately from valid bounded native records.
    f.db.drizzle
      .update(schedulingPhysicalReceipts)
      .set({ entryBytes: 64 * 1024 })
      .run()
    expect(f.repo.schedulingPhysicalReceiptCapacityAvailable()).toBe(false)
    expect(() => f.repo.claimSchedulingPhysicalReceipt()).toThrow('metadata is invalid')
    const id = reserveProbe(f)
    begin(f, id, 'host_metadata', 0, null)
    record(f, id, 1)
    const before = f.repo.activeSchedulingRuntimeOwner()
    expect(() => f.repo.settleSchedulingProbe(id, true)).toThrow('receipt budget is full')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
    expect(receipts(f.db)).toHaveLength(1)
  })

  it.each(['receipt append', 'generation update'] as const)(
    'rolls back the entire stage transition when %s fails',
    async (failure) => {
      const f = await fixture()
      const id = reserveProbe(f, f.sessionId)
      begin(f, id, 'host_metadata', 0, null)
      const previous = record(f, id, 1)
      const before = f.repo.activeSchedulingRuntimeOwner()
      f.db.drizzle.run(
        failure === 'receipt append'
          ? sql`CREATE TEMP TRIGGER fail_native_transition BEFORE INSERT ON scheduling_physical_receipts BEGIN SELECT RAISE(ABORT,'fixture stage transaction failure'); END`
          : sql`CREATE TEMP TRIGGER fail_native_transition BEFORE UPDATE OF native_generation ON scheduling_runtime_owners BEGIN SELECT RAISE(ABORT,'fixture stage transaction failure'); END`,
      )
      expect(() => begin(f, id, 'project_metadata', 1, previous)).toThrow(
        'fixture stage transaction failure',
      )
      expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
      expect(receipts(f.db)).toEqual([])
      f.db.drizzle.run(sql`DROP TRIGGER fail_native_transition`)
      expect(begin(f, id, 'project_metadata', 1, previous)).toBe(2)
      expect(receipts(f.db)).toHaveLength(1)
    },
  )

  it('keeps the evaluation and physical owner active if its final receipt cannot commit', async () => {
    const f = await fixture()
    const id = reserveEvaluation(f)
    begin(f, id, 'host_metadata', 0, null)
    const host = record(f, id, 1)
    begin(f, id, 'project_metadata', 1, host)
    const project = record(f, id, 2)
    begin(f, id, 'guarded_context', 2, project)
    f.repo.recordEvaluationPhysicalWitness(id, {
      nativeGeneration: 3,
      witness: windowsWitness(),
      configurationFingerprint,
    })
    f.repo.dispatchEvaluation(id)
    f.repo.settleEvaluation(id, {
      outcome: 'failed',
      physicalReleased: false,
      usage: { inputTokens: 19, outputTokens: 2 },
    })
    const owner = f.repo.activeSchedulingRuntimeOwner()
    const evaluation = storedEvaluation(f.db, id)
    const before = receipts(f.db)
    f.db.drizzle.run(
      sql`CREATE TEMP TRIGGER fail_final_receipt BEFORE INSERT ON scheduling_physical_receipts BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END`,
    )
    expect(() =>
      f.repo.settleEvaluation(id, { outcome: 'failed', physicalReleased: true }),
    ).toThrow('fixture final receipt failure')
    expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(owner)
    expect(storedEvaluation(f.db, id)).toEqual(evaluation)
    expect(receipts(f.db)).toEqual(before)
    f.db.drizzle.run(sql`DROP TRIGGER fail_final_receipt`)
    f.repo.settleEvaluation(id, { outcome: 'failed', physicalReleased: true })
    expect(receipts(f.db)).toHaveLength(3)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
  })
})
