/* oxlint-disable no-await-in-loop -- Controlled native stages and fixture disposal join serial owners before closing SQLite. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  DecisionCapability,
  DecisionInput,
  DecisionNativeStage,
  DecisionOutcome,
  DecisionPhysicalWitness,
  RpcResult,
  SchedulingState,
} from '@pact/contracts'

import { decisionPhysicalWitnessSchema } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import type { ClaudeDecisionRuntimeContext } from './claude-decision-runtime.js'
import type { DecisionInputLoader } from './decision-runtime.js'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { schedulingEvaluations } from '../../../../../packages/persistence/src/schema/index.js'
import { OwnedProcessGroup } from '../owned-process-group.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'
import { NativeWorkingMemory } from './native-working-memory.js'

const native = vi.hoisted(() => ({ instances: [] as ControlledRuntime[], codexConstructions: 0 }))
vi.mock('./claude-decision-runtime.js', () => ({
  ClaudeDecisionRuntime: function (context: ClaudeDecisionRuntimeContext) {
    return new ControlledRuntime(context)
  },
}))
vi.mock('./codex-decision-runtime.js', () => ({
  CodexDecisionRuntime: function () {
    native.codexConstructions += 1
    throw Error('The saved Claude selection must not construct Codex.')
  },
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const databases = new Set<PactDatabase>()
const flows: Conversation[] = []
const directories: string[] = []
const releases: Array<() => void> = []
const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const fingerprint = 'a'.repeat(64)
const recommendation: DecisionOutcome = {
  kind: 'recommendation',
  recommendation: { candidateId: 'wait', highlights: [] },
}
const cancelled: DecisionOutcome = { kind: 'unavailable', reason: 'cancelled' }

// A controlled native boundary, not evidence that real Claude startup-policy admission exists.
class ControlledRuntime {
  readonly ready = Promise.withResolvers<void>()
  readonly logical = Promise.withResolvers<DecisionOutcome>()
  readonly probeLogical = Promise.withResolvers<DecisionCapability>()
  readonly physical = Promise.withResolvers<boolean>()
  readonly memory = new NativeWorkingMemory('decision')
  invoked = false
  usage = { inputTokens: 17, outputTokens: 5 }
  generation = 0
  witness: DecisionPhysicalWitness | null = null
  private completion: Promise<void> | undefined
  private abort = () => {
    this.logical.resolve(cancelled)
    this.probeLogical.resolve(capability('cancelled', false))
  }
  private signal: AbortSignal | undefined

  constructor(readonly context: ClaudeDecisionRuntimeContext) {
    native.instances.push(this)
  }

  probeAdmission(signal?: AbortSignal) {
    this.signal = signal
    signal?.addEventListener('abort', this.abort, { once: true })
    this.ready.resolve()
    return this.probeLogical.promise
  }

  async evaluateDecision(value: DecisionInput | DecisionInputLoader, signal: AbortSignal) {
    this.signal = signal
    signal.addEventListener('abort', this.abort, { once: true })
    const input =
      typeof value === 'function'
        ? await value({ signal, deadlineAt: this.context.deadlineAt! })
        : value
    const reservation = this.context.reserve!(input, { deadlineAt: this.context.deadlineAt! })
    if (reservation !== 'reserved') return { kind: 'unavailable' as const, reason: reservation }
    this.ready.resolve()
    return this.logical.promise
  }

  beginStage(stage: DecisionNativeStage) {
    this.generation = this.context.beginNativeStage({
      expectedGeneration: this.generation,
      stage,
      previousWitness: this.witness,
      previousPhysicalReleased: true,
    })
    this.witness = null
    return this.generation
  }

  async publishWitness(witness: DecisionPhysicalWitness) {
    await this.context.physicalPrepared({ nativeGeneration: this.generation, witness })
    this.witness = witness
  }

  dispatch() {
    if (!this.witness) throw Error('The fixture inference witness is missing.')
    this.context.prepared({
      nativeGeneration: this.generation,
      witness: this.witness,
      configurationFingerprint: fingerprint,
    })
    this.context.dispatch()
    this.invoked = true
  }

  complete(outcome?: DecisionOutcome) {
    this.completion ??= (async () => {
      await this.context.physicalCompletion!({
        memory: this.memory,
        deadlineAt: Date.now() + 4_000,
        nativeGeneration: this.generation,
        witness: this.witness,
        ...(outcome ? { outcome, usage: this.usage } : {}),
      })
      this.signal?.removeEventListener('abort', this.abort)
      this.physical.resolve(true)
    })()
    return this.completion
  }

  settlement() {
    return this.physical.promise
  }
  dispose() {
    this.abort()
    return this.settlement()
  }
  diagnostics() {
    return {
      phase: 'fixture',
      failure: undefined,
      refusalCode: undefined,
      working: { heldBytes: 0, highWaterBytes: 0, items: 0, released: false },
    }
  }
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const runtime of native.instances) {
    runtime.logical.resolve(cancelled)
    runtime.probeLogical.resolve(capability('cancelled', false))
    await runtime.complete(cancelled)
  }
  for (const flow of flows.splice(0)) await flow.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platformDescriptor)
  for (const db of databases) db.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
  native.instances.length = 0
  native.codexConstructions = 0
})

function deferred<T>(cleanupValue: T) {
  const result = Promise.withResolvers<T>()
  releases.push(() => result.resolve(cleanupValue))
  return result
}

function capability(
  reason: 'unsupported_protocol' | 'cancelled',
  physicalReleased: boolean,
): DecisionCapability {
  return {
    provider: 'claude',
    modelId: 'claude-haiku-5-5',
    status: 'unavailable',
    supported: false,
    reason,
    configurationFingerprint: null,
    checkedAt: new Date().toISOString(),
    physicalReleased,
  }
}

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
  f.repo.saveSchedulingSettings({
    expectedRevision: f.repo.schedulingSettings().revision,
    selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'claude-haiku-5-5' },
  })
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
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  flows.push(flow)
  return flow
}

async function fixture() {
  const f = await databaseFixture()
  return { ...f, flow: attach(f.db) }
}

async function databaseFile() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-native-lifecycle-'))
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

async function runtimeReady() {
  await vi.waitFor(() => expect(native.instances).toHaveLength(1))
  const runtime = native.instances[0]!
  await runtime.ready.promise
  return runtime
}

async function tick() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function evaluation(db: PactDatabase) {
  return db.drizzle.select().from(schedulingEvaluations).get()!
}

async function advanceThroughInference(runtime: ControlledRuntime) {
  for (const stage of ['host_metadata', 'project_metadata', 'guarded_context'] as const) {
    runtime.beginStage(stage)
    await runtime.publishWitness(windowsWitness())
  }
  runtime.dispatch()
}

describe('Conversation native lifecycle callbacks through public operations', () => {
  it('routes the saved Claude provider to its runtime without inventing startup-policy admission', async () => {
    const f = await fixture()
    const refreshing = f.flow.refreshSchedulingState({})
    const runtime = await runtimeReady()
    expect(runtime.context.modelId).toBe('claude-haiku-5-5')
    expect(runtime.context).not.toHaveProperty('startupPolicyAdmission')
    expect(runtime.context).not.toHaveProperty('cwd')
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      kind: 'probe',
      provider: 'claude',
      sessionId: null,
    })
    expect(native.codexConstructions).toBe(0)
    await runtime.complete()
    runtime.probeLogical.resolve(capability('unsupported_protocol', true))
    expect(state(await refreshing).host).toMatchObject({
      status: 'unavailable',
      capability: { provider: 'claude', reason: 'unsupported_protocol' },
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(native.instances).toHaveLength(1)
  })

  it.each([false, true])(
    'preserves completed inference when physical completion precedes logical return, later cancellation=%s',
    async (cancelAfterPhysical) => {
      const f = await fixture()
      const cleanup = syntheticWindows()
      const controller = new AbortController()
      let logicalReturned = false
      const pending = f.flow.evaluateDecision(f.input, controller.signal).then((result) => {
        logicalReturned = true
        return result
      })
      const runtime = await runtimeReady()
      const reserved = f.repo.activeSchedulingRuntimeOwner()!
      const witnesses: DecisionPhysicalWitness[] = []
      const stages = [
        'host_metadata',
        'project_metadata',
        'guarded_context',
        'project_verification',
      ] as const
      for (const [index, stage] of stages.entries()) {
        const generation = runtime.beginStage(stage)
        expect(generation).toBe(index + 1)
        expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
          id: reserved.id,
          nativeGeneration: generation,
          nativeStage: stage,
          phase: 'preparing',
          physicalWitnessJson: null,
          deadline: reserved.deadline,
        })
        const witness = windowsWitness()
        witnesses.push(witness)
        await runtime.publishWitness(witness)
        expect(f.repo.activeSchedulingRuntimeOwner()?.physicalWitnessJson).toBe(
          JSON.stringify(witness),
        )
        if (stage === 'guarded_context') runtime.dispatch()
      }
      expect(runtime.context).not.toHaveProperty('startupPolicyAdmission')
      expect(evaluation(f.db).physicalWitnessJson).toBe(JSON.stringify(witnesses[2]))
      expect(f.repo.activeEvaluation()?.physicalWitnessJson).toBe(JSON.stringify(witnesses[3]))
      await runtime.complete(recommendation)
      const completed = evaluation(f.db)
      expect(logicalReturned).toBe(false)
      expect(completed).toMatchObject({
        active: false,
        called: true,
        outcome: 'completed',
        selectedCandidateId: 'wait',
        usageJson: '{"inputTokens":17,"outputTokens":5}',
      })
      expect(cleanup).toHaveBeenCalledTimes(4)
      if (cancelAfterPhysical) controller.abort()
      runtime.logical.resolve(recommendation)
      expect(await pending).toMatchObject(
        cancelAfterPhysical ? { kind: 'unavailable', reason: 'stale' } : recommendation,
      )
      await tick()
      expect(evaluation(f.db)).toEqual(completed)
      expect(state(f.flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
    },
  )

  it('keeps state, Quit and admission occupied after database release until the receipt helper and disposal join', async () => {
    const f = await fixture()
    const helper = deferred<'removed'>('removed')
    const cleanup = syntheticWindows().mockImplementationOnce(() => helper.promise)
    const pending = f.flow.evaluateDecision(f.input, new AbortController().signal)
    const runtime = await runtimeReady()
    await advanceThroughInference(runtime)
    runtime.beginStage('project_verification')
    await runtime.publishWitness(windowsWitness())
    runtime.logical.resolve(recommendation)
    expect(await pending).toMatchObject(recommendation)
    const releasing = runtime.complete(recommendation)
    await tick()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(state(f.flow.getSchedulingState({})).activity.decision).toMatchObject({
      status: 'cleanup_unconfirmed',
      sessionId: f.sessionId,
    })
    expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: true,
      value: { state: 'confirmation_required', activeCount: 1 },
    })
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'busy',
    })
    expect(state(await f.flow.refreshSchedulingState({})).activity.decision.status).toBe(
      'cleanup_unconfirmed',
    )
    expect(native.instances).toHaveLength(1)
    let disposed = false
    const disposing = f.flow.dispose().then(() => {
      disposed = true
      return undefined
    })
    await tick()
    expect(disposed).toBe(false)
    helper.resolve('removed')
    await releasing
    await disposing
    expect(cleanup).toHaveBeenCalledTimes(4)
    expect(f.repo.hasSchedulingPhysicalReceipts()).toBe(false)
    expect(state(f.flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
  })

  it('keeps cancellation terminal when a later native completion reports a recommendation', async () => {
    const f = await fixture()
    syntheticWindows()
    const controller = new AbortController()
    const pending = f.flow.evaluateDecision(f.input, controller.signal)
    const runtime = await runtimeReady()
    await advanceThroughInference(runtime)
    controller.abort()
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    expect(evaluation(f.db)).toMatchObject({
      active: true,
      called: true,
      outcome: 'failed',
      selectedCandidateId: null,
    })
    await runtime.complete(recommendation)
    await tick()
    const terminal = evaluation(f.db)
    expect(terminal).toMatchObject({
      active: false,
      called: true,
      outcome: 'failed',
      selectedCandidateId: null,
    })
    await runtime.context.physicalCompletion!({
      memory: runtime.memory,
      deadlineAt: Date.now() + 4_000,
      nativeGeneration: runtime.generation,
      witness: runtime.witness,
      outcome: recommendation,
      usage: { inputTokens: 99, outputTokens: 99 },
    })
    expect(evaluation(f.db)).toEqual(terminal)
    expect(state(f.flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
  })

  it('bounds duplicate waiting by its original 15-second deadline while restart proof stays single-flight and disposal joins it', async () => {
    const filePath = await databaseFile()
    const f = await databaseFixture(filePath)
    const reserved = f.repo.reserveEvaluation({
      handoff: f.input.handoff,
      provider: 'claude',
      model: 'claude-haiku-5-5',
      configurationFingerprint: fingerprint,
    })
    if (reserved.status !== 'reserved') throw Error('Expected a restart evaluation receipt.')
    f.repo.dispatchEvaluation(reserved.evaluation.id)
    f.repo.recordEvaluationPhysicalWitness(reserved.evaluation.id, {
      witness: darwinWitness(),
      configurationFingerprint: fingerprint,
    })
    const db = await reopen(f.db, filePath)
    const proof = deferred(true)
    const prove = vi
      .spyOn(OwnedProcessGroup, 'provePhysicalRelease')
      .mockImplementation(() => proof.promise)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const flow = attach(db)
    let returned = false
    const duplicate = flow
      .evaluateDecision(f.input, new AbortController().signal)
      .then((result) => {
        returned = true
        return result
      })
    await tick()
    expect(prove).toHaveBeenCalledTimes(1)
    expect(state(await flow.refreshSchedulingState({})).activity.decision.status).toBe(
      'cleanup_unconfirmed',
    )
    await vi.advanceTimersByTimeAsync(14_999)
    expect(returned).toBe(false)
    expect(db.conversationRepository.activeSchedulingRuntimeOwner()?.id).toBe(
      reserved.evaluation.id,
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(await duplicate).toEqual({ kind: 'unavailable', reason: 'duplicate' })
    expect(db.conversationRepository.activeSchedulingRuntimeOwner()?.id).toBe(
      reserved.evaluation.id,
    )
    expect(state(await flow.refreshSchedulingState({})).activity.decision.status).toBe(
      'cleanup_unconfirmed',
    )
    expect(prove).toHaveBeenCalledTimes(1)
    expect(native.instances).toHaveLength(0)
    let disposed = false
    const disposing = flow.dispose().then(() => {
      disposed = true
      return undefined
    })
    await tick()
    expect(disposed).toBe(false)
    proof.resolve(true)
    await disposing
    expect(db.conversationRepository.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(evaluation(db)).toMatchObject({ called: true, outcome: 'failed', active: false })
  })

  it('keeps restarted passive-receipt retirement single-flight and visible until the existing helper closes', async () => {
    const filePath = await databaseFile()
    const f = await databaseFixture(filePath)
    const id = randomUUID()
    expect(
      f.repo.reserveSchedulingProbe({
        id,
        sessionId: null,
        provider: 'claude',
        model: 'claude-haiku-5-5',
        configurationFingerprint: fingerprint,
        deadlineAt: Date.now() + 15_000,
      }),
    ).toBe(true)
    f.repo.recordSchedulingRuntimeWitness(id, { witness: windowsWitness() })
    f.repo.settleSchedulingProbe(id, true)
    const db = await reopen(f.db, filePath)
    const helper = deferred<'already_absent'>('already_absent')
    const cleanup = syntheticWindows().mockImplementation(() => helper.promise)
    const flow = attach(db)
    await tick()
    expect(db.conversationRepository.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(state(flow.getSchedulingState({})).activity.decision).toMatchObject({
      status: 'cleanup_unconfirmed',
      sessionId: null,
    })
    expect(state(await flow.refreshSchedulingState({})).activity.decision.status).toBe(
      'cleanup_unconfirmed',
    )
    expect(await flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'busy',
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(native.instances).toHaveLength(0)
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
    expect(db.conversationRepository.hasSchedulingPhysicalReceipts()).toBe(false)
    expect(state(flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
  })
})
