/* oxlint-disable no-await-in-loop -- Serial owner joins and fixture disposal close SQLite owners sequentially. */
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcResult, SchedulingState } from '@pact/contracts'

import { decisionPhysicalWitnessSchema } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import {
  decisionFixture,
  seedHistoricalDecisionEvaluation,
} from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { schedulingRuntimeOwners } from '../../../../../packages/persistence/src/schema/index.js'
import { OwnedProcessGroup } from '../owned-process-group.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { Conversation } from './conversation.js'

const api = vi.hoisted(() => ({ constructions: 0 }))
vi.mock('./openai-decision-runtime.js', () => ({
  OpenAIDecisionRuntime: function () {
    api.constructions++
    throw Error('Historical cleanup must not construct a decision model')
  },
}))

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const databases = new Set<PactDatabase>()
const flows: Conversation[] = []
const directories: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const flow of flows.splice(0)) await flow.dispose()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  for (const db of databases) {
    db.close()
    databases.delete(db)
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
  const constructions = api.constructions
  api.constructions = 0
  if (constructions !== 0) throw Error('Historical cleanup constructed a decision model')
})

function windowsWitness() {
  return decisionPhysicalWitnessSchema.parse({
    version: 2,
    platform: 'win32',
    ownerId: randomUUID(),
    generation: randomUUID(),
    protocolVersion: 1,
    phase: 'contained',
    owner: { pid: 6101, creationFileTime: '133700000000000001' },
    bridge: { pid: 6102, creationFileTime: '133700000000000002' },
    root: { pid: 6103, creationFileTime: '133700000000000003' },
    receipt: { id: randomUUID(), volumeSerial: 'b'.repeat(16), fileId: 'c'.repeat(32) },
    atomicJob: true,
    noBreakaway: true,
  })
}

function darwinWitness() {
  const root = { pid: 6202, started: 'fixture-root-birth', pgid: 6202 }
  return decisionPhysicalWitnessSchema.parse({
    version: 1,
    platform: 'darwin',
    ownerId: randomUUID(),
    owner: { pid: 6201, started: 'fixture-owner-birth' },
    root,
    members: [root],
  })
}

function syntheticWindows() {
  // Host-branch simulation only; no Windows process, handle or file is touched.
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  return vi.spyOn(OwnedProcessGroup, 'cleanupPhysicalReceipt').mockResolvedValue('removed')
}

async function databaseFixture(filePath = ':memory:') {
  const f = await decisionFixture(filePath)
  databases.add(f.db)
  return f
}

function attach(db: PactDatabase) {
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue('/owned-fixture/claude')
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
  )
  flows.push(flow)
  return flow
}

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-historical-cleanup-'))
  directories.push(directory)
  return join(directory, 'pact.sqlite')
}

async function reopen(db: PactDatabase, filePath: string) {
  db.close()
  databases.delete(db)
  const reopened = await PactDatabase.open({ filePath, migrationsFolder })
  databases.add(reopened)
  return reopened
}

function state(result: RpcResult<SchedulingState>) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error(`Scheduling state unavailable: ${result.error.code}`)
  return result.value
}

async function tick() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function deferred<T>(cleanupValue: T) {
  const result = Promise.withResolvers<T>()
  releases.push(() => result.resolve(cleanupValue))
  return result
}

describe('Conversation historical decision cleanup through public operations', () => {
  it('bounds duplicate waiting by its original 15-second deadline while restart proof stays single-flight and disposal joins it', async () => {
    const filePath = await databaseFile()
    const f = await databaseFixture(filePath)
    // A real historical native evaluation whose physical proof is unknown at restart.
    const id = seedHistoricalDecisionEvaluation(f.db, f.input, darwinWitness())
    const db = await reopen(f.db, filePath)
    const retainedOwner = db.conversationRepository.activeSchedulingRuntimeOwner()
    expect(retainedOwner?.id).toBe(id)
    const proof = deferred(true)
    const prove = vi
      .spyOn(OwnedProcessGroup, 'provePhysicalRelease')
      .mockImplementation(() => proof.promise)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const flow = attach(db)
    const repo = db.conversationRepository
    let returned = false
    const duplicate = flow
      .evaluateDecision(f.input, new AbortController().signal)
      .then((result) => {
        returned = true
        return result
      })
    await tick()
    expect(prove).toHaveBeenCalledTimes(1)
    expect(state(flow.getSchedulingState({})).activity.decision.status).toBe('cleanup_unconfirmed')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(returned).toBe(false)
    expect(repo.activeSchedulingRuntimeOwner()).toEqual(retainedOwner)
    await vi.advanceTimersByTimeAsync(1)
    expect(await duplicate).toEqual({ kind: 'unavailable', reason: 'duplicate' })
    // The retained owner is still held while the physical proof is pending.
    expect(repo.activeSchedulingRuntimeOwner()).toEqual(retainedOwner)
    expect(prove).toHaveBeenCalledTimes(1)
    expect(api.constructions).toBe(0)
    let disposed = false
    const disposing = flow.dispose().then(() => {
      disposed = true
      return undefined
    })
    await tick()
    expect(disposed).toBe(false)
    proof.resolve(true)
    await disposing
    expect(repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(db.drizzle.get(sql`SELECT called,active,outcome FROM scheduling_evaluations`)).toEqual({
      called: 1,
      active: 0,
      outcome: 'failed',
    })
    expect(repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
  })

  it('keeps restarted passive-receipt retirement single-flight and visible until the existing helper closes', async () => {
    const filePath = await databaseFile()
    const f = await databaseFixture(filePath)
    const repo = f.db.conversationRepository
    // FOUR closed historical global probes keep the multi-receipt drain obligation.
    for (let index = 0; index < 4; index++) {
      const witness = windowsWitness(),
        id = randomUUID(),
        createdAt = new Date().toISOString()
      f.db.drizzle
        .insert(schedulingRuntimeOwners)
        .values({
          id,
          kind: 'probe',
          sessionId: null,
          provider: 'claude',
          model: 'claude-haiku-5-5',
          configurationFingerprint: 'a'.repeat(64),
          nativeGeneration: 1,
          nativeStage: 'host_metadata',
          physicalWitnessJson: JSON.stringify(witness),
          active: true,
          phase: 'cleanup_unconfirmed',
          createdAt,
          deadline: new Date(Date.now() + 15000).toISOString(),
        })
        .run()
      // Metadata-only trusted-repository proof creates the actual pending receipt.
      expect(repo.settleSchedulingOwnerAfterPhysicalProof(id, JSON.stringify(witness), 1)).toBe(
        true,
      )
    }
    const reopened = await reopen(f.db, filePath)
    const helper = deferred<'already_absent'>('already_absent')
    const cleanup = syntheticWindows().mockImplementation(() => helper.promise)
    const flow = attach(reopened)
    await tick()
    // The first helper stays pending; later receipts wait for its physical completion.
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(reopened.conversationRepository.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(state(flow.getSchedulingState({})).activity.decision).toMatchObject({
      status: 'cleanup_unconfirmed',
      sessionId: null,
    })
    expect(state(flow.getSchedulingState({})).activity.decision.status).toBe('cleanup_unconfirmed')
    expect(cleanup).toHaveBeenCalledTimes(1)
    // A new fact stays blocked while the passive receipts are draining.
    expect(await flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'busy',
    })
    expect(api.constructions).toBe(0)
    expect(flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: true,
      value: { state: 'confirmation_required', activeCount: 1, sessions: [] },
    })
    let disposed = false
    const disposing = flow.dispose().then(() => {
      disposed = true
      return undefined
    })
    await tick()
    expect(disposed).toBe(false)
    helper.resolve('already_absent')
    await disposing
    expect(cleanup).toHaveBeenCalledTimes(4)
    expect(reopened.conversationRepository.hasSchedulingPhysicalReceipts()).toBe(false)
    expect(state(flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
  })
})
