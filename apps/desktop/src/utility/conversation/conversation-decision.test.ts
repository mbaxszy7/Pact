/* oxlint-disable no-await-in-loop -- Dispose each actual DB owner before the next; microtask sequencing observes adoption/settlement. */
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

import type { DecisionInput, DecisionOutcome } from '@pact/contracts'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  instances: [] as { invoked: boolean }[],
  logical: undefined as undefined | Promise<DecisionOutcome>,
  physical: undefined as undefined | Promise<boolean>,
  afterResolve: undefined as undefined | (() => void),
  beforeReserve: undefined as undefined | (() => void),
  beforeDispatch: undefined as undefined | (() => void),
}))
vi.mock('./codex-decision-runtime.js', () => ({
  CodexDecisionRuntime: class {
    invoked = false
    usage: { inputTokens: number; outputTokens: number } | undefined
    constructor(
      readonly context: ConstructorParameters<
        typeof import('./codex-decision-runtime').CodexDecisionRuntime
      >[0],
    ) {
      native.instances.push(this)
    }
    async evaluateDecision(
      value: DecisionInput | import('./codex-decision-runtime').DecisionInputLoader,
      signal: AbortSignal,
    ) {
      try {
        const deadlineAt = this.context.deadlineAt ?? Date.now() + 15_000
        const input = typeof value === 'function' ? await value({ signal, deadlineAt }) : value
        native.beforeReserve?.()
        const reservation = this.context.reserve!(input, { deadlineAt })
        if (reservation !== 'reserved')
          return Promise.resolve({ kind: 'unavailable', reason: reservation })
        native.beforeDispatch?.()
        this.context.dispatch()
      } catch {
        return Promise.resolve({ kind: 'unavailable', reason: 'stale' })
      }
      this.invoked = true
      this.usage = { inputTokens: 17, outputTokens: 5 }
      const outcome: DecisionOutcome = {
        kind: 'recommendation',
        recommendation: { candidateId: 'wait', highlights: [] },
      }
      // Resolve before changing settings: the owner has not adopted its await result yet.
      const result = native.logical ?? Promise.resolve(outcome)
      native.afterResolve?.()
      return result
    }
    settlement() {
      return native.physical ?? Promise.resolve(true)
    }
    dispose() {
      return this.settlement()
    }
  },
}))
const owners: Array<{ flow: Conversation; db: Awaited<ReturnType<typeof decisionFixture>>['db'] }> =
  []
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.flow.dispose()
    owner.db.close()
  }
  native.instances.length = 0
  native.logical = undefined
  native.physical = undefined
  native.afterResolve = undefined
  native.beforeReserve = undefined
  native.beforeDispatch = undefined
})
async function fixture() {
  const f = await decisionFixture(),
    preparation = new RuntimePreparation(f.db.runtimePreparationRepository)
  const flow = new Conversation(
    f.repo,
    f.db.sessionRepository,
    f.db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(f.db.sessionRepository, f.db.projectCatalogRepository),
  )
  owners.push({ flow, db: f.db })
  return { ...f, flow }
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function beginArchive(f: Awaited<ReturnType<typeof fixture>>) {
  const operationId = randomUUID(),
    ownerId = randomUUID(),
    scope = { kind: 'project' as const, projectId: f.projectId }
  f.repo.archives.prepare(
    {
      operationId,
      scope,
      ...f.repo.archives.context(scope),
      tasks: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    ownerId,
  )
  return f.repo.archives.claim(operationId, ownerId, [], [], () => {})
}

it('uses the real Repository dispatch receipt, records actual usage and deduplicates the same fact without creating a business Run', async () => {
  const f = await fixture()
  const runs = f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)
  expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
    'recommendation',
  )
  await tick()
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
  expect(
    f.db.drizzle.get(sql`SELECT called,active,outcome,usage_json FROM scheduling_evaluations`),
  ).toEqual({
    called: 1,
    active: 0,
    outcome: 'completed',
    usage_json: '{"inputTokens":17,"outputTokens":5}',
  })
  expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
    kind: 'unavailable',
    reason: 'duplicate',
  })
  await tick()
  expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual(runs)
  expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
    count: 1,
  })
})
it.each(['enabled', 'selection'] as const)(
  'rejects a resolved result across %s ABA before owner adoption',
  async (field) => {
    const f = await fixture()
    native.afterResolve = () => {
      const old = f.repo.schedulingSettings()
      const changed = f.repo.saveSchedulingSettings({
        expectedRevision: old.revision,
        ...(field === 'enabled' ? { enabled: false } : { selection: null }),
      })
      f.repo.saveSchedulingSettings({
        expectedRevision: changed.revision,
        enabled: old.enabled,
        selection: old.selection,
      })
    }
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
    await tick()
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(f.db.drizzle.get(sql`SELECT outcome,called FROM scheduling_evaluations`)).toEqual({
      outcome: 'failed',
      called: 1,
    })
  },
)
it('keeps indicator-only changes independent from semantic freshness', async () => {
  const f = await fixture(),
    generation = f.repo.schedulingConfigurationGeneration()
  native.afterResolve = () =>
    f.repo.saveSchedulingSettings({
      expectedRevision: f.repo.schedulingSettings().revision,
      showIndicator: false,
    })
  expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
    'recommendation',
  )
  expect(f.repo.schedulingConfigurationGeneration()).toBe(generation)
})
it('returns logically while physical release is pending and keeps one App reservation without replay or refund', async () => {
  const f = await fixture()
  let release!: (value: boolean) => void
  native.physical = new Promise((resolve) => {
    release = resolve
  })
  native.logical = Promise.resolve({ kind: 'unavailable', reason: 'timeout' })
  expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
    kind: 'unavailable',
    reason: 'timeout',
  })
  expect(f.repo.activeEvaluation()).toMatchObject({ called: true, outcome: 'failed' })
  expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
    kind: 'unavailable',
    reason: 'busy',
  })
  expect(native.instances).toHaveLength(1)
  expect(() =>
    f.repo.settleEvaluation(f.repo.activeEvaluation()!.id, {
      outcome: 'not_sent',
      physicalReleased: true,
    }),
  ).toThrow('cannot be refunded')
  release(true)
  await tick()
  expect(f.repo.activeEvaluation()).toBeUndefined()
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
})

it('refuses decisions after an idle Quit preparation seals new work', async () => {
  const f = await fixture()
  expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
    ok: true,
    value: { state: 'idle_prepared', activeCount: 0 },
  })
  expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
    'unavailable',
  )
  expect(native.instances).toHaveLength(0)
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
})

it.each(['project', 'session', 'archive-in-progress'] as const)(
  'refuses decisions for an unavailable %s before allocating a native owner',
  async (scope) => {
    const f = await fixture()
    if (scope === 'project') f.db.projectCatalogRepository.archive(f.projectId)
    else if (scope === 'session') f.db.sessionRepository.archive(f.sessionId)
    else beginArchive(f)
    expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
      'unavailable',
    )
    expect(native.instances).toHaveLength(0)
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  },
)

it.each(['quit', 'archive'] as const)(
  'rechecks %s after asynchronous recovery and before native admission',
  async (change) => {
    const f = await fixture()
    const deciding = f.flow.evaluateDecision(f.input, new AbortController().signal)
    if (change === 'quit') f.flow.prepareNativeQuit({ operationId: randomUUID() })
    else beginArchive(f)
    expect((await deciding).kind).toBe('unavailable')
    expect(native.instances).toHaveLength(0)
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  },
)

it.each(['reserve', 'dispatch'] as const)(
  'rechecks an archive barrier at the %s trust seam without recording an invocation',
  async (stage) => {
    const f = await fixture()
    if (stage === 'reserve')
      native.beforeReserve = () => {
        beginArchive(f)
      }
    else
      native.beforeDispatch = () => {
        beginArchive(f)
      }
    expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
      'unavailable',
    )
    await tick()
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(
      f.db.drizzle.get(sql`SELECT coalesce(sum(called),0) AS called FROM scheduling_evaluations`),
    ).toEqual({ called: 0 })
  },
)

it.each(['project', 'session', 'archive-in-progress'] as const)(
  'rejects a resolved recommendation when %s becomes unavailable before adoption',
  async (scope) => {
    const f = await fixture()
    native.afterResolve = () => {
      if (scope === 'project') f.db.projectCatalogRepository.archive(f.projectId)
      else if (scope === 'session') f.db.sessionRepository.archive(f.sessionId)
      else beginArchive(f)
    }
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
    await tick()
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(f.repo.activeEvaluation()).toBeUndefined()
  },
)

it('includes a preparing auxiliary owner in Quit and Archive before its durable reservation exists', async () => {
  const f = await fixture()
  native.beforeReserve = () => {
    expect(f.repo.activeEvaluation()).toBeUndefined()
    expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: true,
      value: {
        state: 'confirmation_required',
        activeCount: 1,
        sessions: [{ sessionId: f.sessionId }],
      },
    })
    expect(
      f.flow.prepareWorkspaceArchive({
        operationId: randomUUID(),
        scope: { kind: 'project', projectId: f.projectId },
      }),
    ).toMatchObject({
      ok: true,
      value: { blockedReason: expect.any(String) },
    })
  }
  expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
    'recommendation',
  )
})

it('keeps physical auxiliary work visible to Quit and blocks only its Archive scope until release', async () => {
  const f = await fixture(),
    physical = Promise.withResolvers<boolean>()
  native.physical = physical.promise
  native.logical = Promise.resolve({ kind: 'unavailable', reason: 'timeout' })
  try {
    await f.flow.evaluateDecision(f.input, new AbortController().signal)
    expect(f.repo.activeEvaluation()).toMatchObject({ called: true })
    expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
      ok: true,
      value: {
        state: 'confirmation_required',
        activeCount: 1,
        sessions: [{ sessionId: f.sessionId }],
      },
    })
    const scope = { kind: 'project' as const, projectId: f.projectId }
    expect(f.flow.prepareWorkspaceArchive({ operationId: randomUUID(), scope })).toMatchObject({
      ok: true,
      value: { blockedReason: expect.any(String) },
    })
    const commit = vi.fn<(id: string) => { ok: true; value: unknown }>((id) => ({
      ok: true,
      value: f.db.projectCatalogRepository.archive(f.projectId, id),
    }))
    expect(
      (
        await f.flow.archiveWorkspace(scope, undefined, commit, () => ({
          ok: true,
          value: undefined,
        }))
      ).ok,
    ).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(f.db.projectCatalogRepository.find(f.projectId)?.archivedAt).toBeUndefined()
    const unrelated = randomUUID()
    f.db.projectCatalogRepository.add({
      id: unrelated,
      name: 'Other project',
      directoryPath: '/other-decision-fixture',
      kind: 'directory',
      createdAt: new Date().toISOString(),
    })
    const other = f.flow.prepareWorkspaceArchive({
      operationId: randomUUID(),
      scope: { kind: 'project', projectId: unrelated },
    })
    expect(other).toMatchObject({ ok: true, value: { tasks: [] } })
    if (!other.ok) throw new Error('Missing unrelated archive preview')
    expect(other.value.blockedReason).toBeUndefined()
  } finally {
    physical.resolve(true)
    await tick()
  }
  const ready = f.flow.prepareWorkspaceArchive({
    operationId: randomUUID(),
    scope: { kind: 'project', projectId: f.projectId },
  })
  expect(ready).toMatchObject({ ok: true, value: { tasks: [] } })
  if (!ready.ok) throw new Error('Missing released archive preview')
  expect(ready.value.blockedReason).toBeUndefined()
  expect(
    (
      await f.flow.archiveWorkspace(
        { kind: 'project', projectId: f.projectId },
        undefined,
        (id) => ({ ok: true, value: f.db.projectCatalogRepository.archive(f.projectId, id) }),
        () => ({ ok: true, value: f.db.projectCatalogRepository.read() }),
      )
    ).ok,
  ).toBe(true)
  expect(f.flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
    ok: true,
    value: { state: 'idle_prepared', activeCount: 0 },
  })
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
})

it('includes an unknown durable auxiliary owner after Conversation reconstruction without replay or release', async () => {
  const f = await fixture()
  const reservation = f.repo.reserveEvaluation({
    handoff: f.input.handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
  })
  if (reservation.status !== 'reserved') throw new Error('Missing owned reservation')
  f.repo.dispatchEvaluation(reservation.evaluation.id)
  await f.flow.dispose()
  const reopened = new Conversation(
    f.repo,
    f.db.sessionRepository,
    f.db.projectCatalogRepository,
    new RuntimePreparation(f.db.runtimePreparationRepository),
    new ProjectFileReader(f.db.sessionRepository, f.db.projectCatalogRepository),
  )
  owners.find((owner) => owner.flow === f.flow)!.flow = reopened
  expect(reopened.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
    ok: true,
    value: {
      state: 'confirmation_required',
      activeCount: 1,
      sessions: [{ sessionId: f.sessionId }],
    },
  })
  expect(
    reopened.prepareWorkspaceArchive({
      operationId: randomUUID(),
      scope: { kind: 'session', sessionId: f.sessionId },
    }),
  ).toMatchObject({
    ok: true,
    value: { blockedReason: expect.any(String) },
  })
  expect(await reopened.evaluateDecision(f.input, new AbortController().signal)).toEqual({
    kind: 'unavailable',
    reason: 'duplicate',
  })
  await tick()
  expect(f.repo.activeEvaluation()).toMatchObject({
    id: reservation.evaluation.id,
    called: true,
    physicalWitnessJson: null,
  })
  expect(native.instances.every((instance) => !instance.invoked)).toBe(true)
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
})
