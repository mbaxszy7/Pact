/* oxlint-disable no-await-in-loop -- Each fixture closes its Conversation before SQLite; bounded microtask drains observe physical settlement. */
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DecisionCapability, RpcResult, SchedulingState } from '@pact/contracts'

import { SCHEDULING_CAPABILITY_TTL_MS } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

type RuntimeContext = ConstructorParameters<
  typeof import('./codex-decision-runtime').CodexDecisionRuntime
>[0]
const native = vi.hoisted(() => ({
  instances: [] as Array<{
    context: RuntimeContext
    ownerAtConstruction: unknown
    probeCalls: number
    signal?: AbortSignal | undefined
  }>,
  logical: undefined as Promise<DecisionCapability> | undefined,
  physical: undefined as Promise<boolean> | undefined,
  inspectOwner: undefined as (() => unknown) | undefined,
}))
vi.mock('./codex-decision-runtime.js', () => ({
  CodexDecisionRuntime: class {
    probeCalls = 0
    signal: AbortSignal | undefined
    readonly ownerAtConstruction: unknown
    constructor(readonly context: RuntimeContext) {
      this.ownerAtConstruction = native.inspectOwner?.()
      native.instances.push(this)
    }
    probeAdmission(signal?: AbortSignal) {
      this.probeCalls += 1
      this.signal = signal
      return native.logical ?? Promise.resolve(supported())
    }
    settlement() {
      return native.physical ?? Promise.resolve(true)
    }
    dispose() {
      return this.settlement()
    }
  },
}))

const owners: Array<{ flow: Conversation; db: PactDatabase }> = []
const settlePending: Array<() => void> = []
afterEach(async () => {
  for (const settle of settlePending.splice(0)) settle()
  for (const owner of owners.splice(0)) {
    await owner.flow.dispose()
    owner.db.close()
  }
  native.instances.length = 0
  native.logical = undefined
  native.physical = undefined
  native.inspectOwner = undefined
  vi.restoreAllMocks()
})

function supported(): DecisionCapability {
  return {
    provider: 'codex',
    modelId: 'gpt-6-luna',
    status: 'supported',
    supported: true,
    reason: 'supported',
    configurationFingerprint: 'a'.repeat(64),
    checkedAt: new Date().toISOString(),
    physicalReleased: true,
  }
}

function deferred<T>(cleanupValue: T) {
  const result = Promise.withResolvers<T>()
  settlePending.push(() => result.resolve(cleanupValue))
  return result
}

function attach(db: PactDatabase) {
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  const executable = vi.spyOn(preparation, 'findRecoveryExecutable')
  const readiness = vi.spyOn(preparation, 'inspectReadiness')
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  owners.push({ flow, db })
  native.inspectOwner = () => db.conversationRepository.activeSchedulingRuntimeOwner()
  return { flow, preparation, executable, readiness }
}

async function fixture() {
  const f = await decisionFixture()
  const sessionId = randomUUID()
  f.db.sessionRepository.create(
    {
      id: sessionId,
      projectId: f.projectId,
      title: 'Idle scheduling context',
      createdAt: new Date().toISOString(),
    },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  return { ...f, ...attach(f.db), sessionId }
}

function state(result: RpcResult<SchedulingState>) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error(`Scheduling state unavailable: ${result.error.code}`)
  return result.value
}

async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('Conversation scheduling observations and physical admission', () => {
  it('joins a cancelled pre-construction probe during shutdown without starting native work', async () => {
    const f = await fixture()
    const refreshing = f.flow.refreshSchedulingState({})
    expect(f.repo.activeSchedulingRuntimeOwner()?.kind).toBe('probe')
    await f.flow.dispose()
    await refreshing
    expect(native.instances).toHaveLength(0)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
  })

  it('reads global and Session state without constructing or probing a native runtime', async () => {
    const f = await fixture()
    const global = state(f.flow.getSchedulingState({}))
    const contextual = state(f.flow.getSchedulingState({ sessionId: f.sessionId }))
    expect(global).toMatchObject({
      settings: { enabled: true, showIndicator: true },
      host: { status: 'unconfirmed', capability: null, expiresAt: null },
      context: null,
      activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
    })
    expect(contextual.context).toEqual({
      sessionId: f.sessionId,
      observation: { status: 'unconfirmed', capability: null, expiresAt: null },
      eligibility: 'unconfirmed',
    })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(native.instances).toHaveLength(0)
    expect(f.executable).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
  })

  it('persists the global probe before native construction and keeps host inspection free of a Project cwd', async () => {
    const f = await fixture()
    const runs = f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)
    const refreshing = f.flow.refreshSchedulingState({})
    const reserved = f.repo.activeSchedulingRuntimeOwner()!
    expect(reserved).toMatchObject({
      kind: 'probe',
      sessionId: null,
      active: true,
      phase: 'reserved',
    })
    expect(native.instances).toHaveLength(0)
    const global = state(await refreshing)
    expect(native.instances).toHaveLength(1)
    expect(native.instances[0]!.ownerAtConstruction).toEqual(reserved)
    expect(native.instances[0]!.context).not.toHaveProperty('cwd')
    expect(native.instances[0]!.probeCalls).toBe(1)
    expect(() => native.instances[0]!.context.dispatch()).toThrow('cannot dispatch a Turn')
    expect(global.host).toMatchObject({ status: 'supported', capability: { supported: true } })
    expect(global.activity.decision).toEqual({ status: 'idle' })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual(runs)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 0,
    })
    expect(
      state(f.flow.getSchedulingState({ sessionId: f.sessionId })).context?.observation.status,
    ).toBe('unconfirmed')

    const contextual = state(await f.flow.refreshSchedulingState({ sessionId: f.sessionId }))
    expect(native.instances).toHaveLength(2)
    expect(native.instances[1]!.context.cwd).toBe('/decision-fixture')
    expect(contextual.host).toEqual(global.host)
    expect(contextual.context).toMatchObject({
      sessionId: f.sessionId,
      observation: { status: 'supported' },
      eligibility: 'available',
    })
  })

  it('joins the same refresh key and reports a competing scope as busy without constructing another runtime', async () => {
    const f = await fixture()
    const capability = deferred(supported())
    native.logical = capability.promise
    const first = f.flow.refreshSchedulingState({})
    const second = f.flow.refreshSchedulingState({})
    await tick()
    expect(native.instances).toHaveLength(1)
    expect(native.instances[0]!.probeCalls).toBe(1)
    const busy = state(await f.flow.refreshSchedulingState({ sessionId: f.sessionId }))
    expect(busy.context?.eligibility).toBe('busy')
    expect(busy.context?.observation.status).toBe('unconfirmed')
    expect(busy.activity.decision).toMatchObject({ status: 'inspecting', sessionId: null })
    expect(native.instances).toHaveLength(1)
    capability.resolve(supported())
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(state(results[0]).host.status).toBe('supported')
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
  })

  it('discards an in-flight capability across configuration ABA even when the saved values return to their originals', async () => {
    const f = await fixture()
    const capability = deferred(supported())
    native.logical = capability.promise
    const before = f.repo.schedulingSettings()
    const generation = f.repo.schedulingConfigurationGeneration()
    const refreshing = f.flow.refreshSchedulingState({})
    await tick()
    expect(
      await f.flow.saveSchedulingSettings({ expectedRevision: before.revision, enabled: false }),
    ).toMatchObject({ ok: true })
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        enabled: true,
      }),
    ).toMatchObject({ ok: true })
    expect(f.repo.schedulingSettings()).toMatchObject({
      enabled: before.enabled,
      selection: before.selection,
    })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(generation + 2)
    expect(native.instances[0]!.signal?.aborted).toBe(true)
    capability.resolve(supported())
    const result = state(await refreshing)
    expect(result.host).toEqual({ status: 'unconfirmed', capability: null, expiresAt: null })
    expect(result.activity.decision).toEqual({ status: 'idle' })
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(native.instances).toHaveLength(1)
  })

  it('retains in-flight and cached capabilities across indicator-only settings changes', async () => {
    const f = await fixture()
    const capability = deferred(supported())
    native.logical = capability.promise
    const generation = f.repo.schedulingConfigurationGeneration()
    const refreshing = f.flow.refreshSchedulingState({})
    await tick()
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        showIndicator: false,
      }),
    ).toMatchObject({ ok: true })
    expect(native.instances[0]!.signal?.aborted).toBe(false)
    capability.resolve(supported())
    const result = state(await refreshing)
    expect(result.host.status).toBe('supported')
    expect(result.settings.showIndicator).toBe(false)
    expect(f.repo.schedulingConfigurationGeneration()).toBe(generation)
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        showIndicator: true,
      }),
    ).toMatchObject({ ok: true })
    expect(state(f.flow.getSchedulingState({})).host).toEqual(result.host)
    expect(native.instances).toHaveLength(1)
  })

  it('marks expired compatibility stale on read without starting native work', async () => {
    const f = await fixture()
    const initial = state(await f.flow.refreshSchedulingState({}))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SCHEDULING_CAPABILITY_TTL_MS + 1)
    const current = state(f.flow.getSchedulingState({}))
    expect(current.host).toEqual({ ...initial.host, status: 'stale' })
    expect(native.instances).toHaveLength(1)
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
  })

  it('returns a logical timeout while physical cleanup still excludes probes and evaluations', async () => {
    const f = await fixture()
    const release = deferred(true)
    native.physical = release.promise
    native.logical = Promise.resolve({
      ...supported(),
      status: 'unavailable',
      supported: false,
      reason: 'timeout',
      physicalReleased: false,
    })
    const result = state(await f.flow.refreshSchedulingState({}))
    expect(result.host).toMatchObject({
      status: 'unavailable',
      capability: { reason: 'timeout', physicalReleased: false },
    })
    expect(result.activity.decision).toMatchObject({
      status: 'cleanup_unconfirmed',
      sessionId: null,
    })
    const owner = f.repo.activeSchedulingRuntimeOwner()!
    expect(owner).toMatchObject({
      kind: 'probe',
      active: true,
      phase: 'cleanup_unconfirmed',
      settledAt: null,
    })
    const blocked = state(await f.flow.refreshSchedulingState({ sessionId: f.sessionId }))
    expect(blocked.context?.eligibility).toBe('busy')
    expect(blocked.activity.decision).toEqual(result.activity.decision)
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'busy',
    })
    expect(native.instances).toHaveLength(1)
    expect(f.repo.activeEvaluation()).toBeUndefined()
    release.resolve(true)
    await tick()
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(state(f.flow.getSchedulingState({})).activity.decision).toEqual({ status: 'idle' })
  })

  it('requires Quit confirmation for a global probe when the database has no Session', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
    })
    db.conversationRepository.saveSchedulingSettings({
      expectedRevision: 0,
      enabled: true,
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
    })
    const { flow } = attach(db)
    const capability = deferred(supported())
    native.logical = capability.promise
    const refreshing = flow.refreshSchedulingState({})
    await tick()
    expect(db.drizzle.get(sql`SELECT count(*) AS count FROM sessions`)).toEqual({ count: 0 })
    const operationId = randomUUID()
    expect(flow.prepareNativeQuit({ operationId })).toEqual({
      ok: true,
      value: { operationId, state: 'confirmation_required', activeCount: 1, sessions: [] },
    })
    capability.resolve(supported())
    expect(state(await refreshing).activity.decision).toEqual({ status: 'idle' })
    expect(flow.cancelNativeQuit({ operationId })).toMatchObject({ ok: true })
    expect(flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: true,
      value: { state: 'idle_prepared', activeCount: 0, sessions: [] },
    })
  })
})
