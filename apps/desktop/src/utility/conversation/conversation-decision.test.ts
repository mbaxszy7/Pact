/* oxlint-disable no-await-in-loop -- Dispose each actual DB owner before the next; microtask sequencing observes adoption/settlement. */
import { sql } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

import type {
  DecisionInput,
  DecisionRemoteOutcome,
  DecisionSelectionOutcome,
} from '@pact/contracts'

import { decisionHttpOwnerSchema, OPENAI_DECISION_MODEL } from '@pact/contracts'

import type { DecisionInputLoader } from './decision-runtime.js'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { Conversation } from './conversation.js'

type OpenAIContext = ConstructorParameters<
  typeof import('./openai-decision-runtime').OpenAIDecisionRuntime
>[0]

const api = vi.hoisted(() => ({
  instances: [] as { invoked: boolean }[],
  logical: undefined as undefined | Promise<DecisionSelectionOutcome>,
  physical: undefined as undefined | Promise<boolean>,
  afterResolve: undefined as undefined | (() => void),
  beforeReserve: undefined as undefined | (() => void),
  beforeDispatch: undefined as undefined | (() => void),
}))
vi.mock('./openai-decision-runtime.js', () => ({
  OpenAIDecisionRuntime: class {
    readonly provider = 'openai'
    readonly modelId = OPENAI_DECISION_MODEL
    invoked = false
    usage: { inputTokens: number; outputTokens: number } | undefined
    private remoteOutcome: DecisionRemoteOutcome = 'not_sent'
    private physicallyReleased = false
    constructor(readonly context: OpenAIContext) {
      api.instances.push(this)
    }
    async evaluateDecision(
      value: DecisionInput | DecisionInputLoader,
      signal: AbortSignal,
    ): Promise<DecisionSelectionOutcome> {
      try {
        const deadlineAt = this.context.deadlineAt
        const input = typeof value === 'function' ? await value({ signal, deadlineAt }) : value
        api.beforeReserve?.()
        const reservation = this.context.reserve(input, { deadlineAt })
        if (reservation !== 'reserved') return { kind: 'unavailable', reason: reservation }
        if (!(await this.context.credential({ signal, deadlineAt })))
          return { kind: 'unavailable', reason: 'runtime_unavailable' }
        api.beforeDispatch?.()
        this.context.dispatch()
      } catch {
        return { kind: 'unavailable', reason: 'stale' }
      }
      this.invoked = true
      this.remoteOutcome = 'unknown'
      const outcome: DecisionSelectionOutcome = await (api.logical ??
        Promise.resolve({ kind: 'selection', selection: { candidateId: 'wait' } }))
      if (outcome.kind === 'selection') {
        this.remoteOutcome = 'responded'
        this.usage = { inputTokens: 17, outputTokens: 5 }
      }
      api.afterResolve?.()
      return outcome
    }
    diagnostics() {
      return {
        remoteOutcome: this.remoteOutcome,
        working: {
          heldBytes: 0,
          highWaterBytes: 0,
          items: 0,
          released: this.physicallyReleased,
        },
      }
    }
    settlement() {
      return (api.physical ?? Promise.resolve(true)).then((released) => {
        this.physicallyReleased = released
        return released
      })
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
  api.instances.length = 0
  api.logical = undefined
  api.physical = undefined
  api.afterResolve = undefined
  api.beforeReserve = undefined
  api.beforeDispatch = undefined
})
async function fixture() {
  const f = await decisionFixture(),
    preparation = new RuntimePreparation(f.db.runtimePreparationRepository)
  const flow = new Conversation(
    f.repo,
    f.db.sessionRepository,
    f.db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(
      f.db.sessionRepository,
      f.db.projectCatalogRepository,
      runDirectoryWorker,
    ),
    undefined,
    undefined,
    undefined,
    () => 'OWNED_LOOPBACK_CREDENTIAL',
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
  const outcome = await f.flow.evaluateDecision(f.input, new AbortController().signal)
  expect(outcome).toMatchObject({ kind: 'selection', selection: { candidateId: 'wait' } })
  if (outcome.kind !== 'selection') throw new Error('Missing admitted selection receipt')
  const persisted = f.db.drizzle.get<{ id: string }>(sql`SELECT id FROM scheduling_evaluations`)
  if (!persisted) throw new Error('Missing durable evaluation receipt')
  expect(outcome.evaluationReceipt).toMatchObject({
    evaluationId: persisted.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
  })
  await tick()
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
  expect(
    f.db.drizzle.get(
      sql`SELECT provider,called,active,outcome,remote_outcome,selected_candidate_id,usage_json FROM scheduling_evaluations`,
    ),
  ).toEqual({
    provider: 'openai',
    called: 1,
    active: 0,
    outcome: 'completed',
    remote_outcome: 'responded',
    selected_candidate_id: 'wait',
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
it.each(['enabled', 'credential'] as const)(
  'rejects a resolved result across %s ABA before owner adoption',
  async (field) => {
    const f = await fixture()
    api.afterResolve = () => {
      const old = f.repo.schedulingSettings()
      if (field === 'enabled') {
        const changed = f.repo.saveSchedulingSettings({
          expectedRevision: old.revision,
          enabled: false,
        })
        f.repo.saveSchedulingSettings({
          expectedRevision: changed.revision,
          enabled: old.enabled,
        })
      } else {
        const stored = f.repo.readRelayCredential()
        f.repo.writeRelayCredential({
          operation: 'save',
          nonce: randomUUID(),
          expectedRevision: stored.revision,
          deadlineAt: Date.now() + 5000,
          ciphertext: stored.ciphertext!,
        })
        const changed = f.repo.readRelayCredential()
        f.repo.writeRelayCredential({
          operation: 'save',
          nonce: randomUUID(),
          expectedRevision: changed.revision,
          deadlineAt: Date.now() + 5000,
          ciphertext: stored.ciphertext!,
        })
      }
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
  api.afterResolve = () =>
    f.repo.saveSchedulingSettings({
      expectedRevision: f.repo.schedulingSettings().revision,
      showIndicator: false,
    })
  expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
    'selection',
  )
  expect(f.repo.schedulingConfigurationGeneration()).toBe(generation)
})

it('returns logically while physical release is pending and keeps one App reservation without replay or refund', async () => {
  const f = await fixture()
  let release!: (value: boolean) => void
  api.physical = new Promise((resolve) => {
    release = resolve
  })
  api.logical = Promise.resolve({ kind: 'unavailable', reason: 'timeout' })
  try {
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    })
    expect(f.repo.activeEvaluation()).toMatchObject({ called: true, outcome: 'failed' })
    expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'busy',
    })
    expect(api.instances).toHaveLength(1)
    const { evaluationId, httpOwnerJson } = f.repo.activeSchedulingRuntimeOwner()!
    if (!evaluationId || !httpOwnerJson) throw new Error('Missing exact HTTP owner')
    const httpOwner = decisionHttpOwnerSchema.parse(JSON.parse(httpOwnerJson))
    expect(() =>
      f.repo.settleEvaluation(evaluationId, {
        outcome: 'not_sent',
        physicalReleased: true,
        httpOwner,
        remoteOutcome: 'unknown',
      }),
    ).toThrow('cannot be refunded')
  } finally {
    release(true)
    await tick()
  }
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
  expect(api.instances).toHaveLength(0)
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
})

it.each(['project', 'session', 'archive-in-progress'] as const)(
  'refuses decisions for an unavailable %s before allocating an HTTP owner',
  async (scope) => {
    const f = await fixture()
    if (scope === 'project') f.db.projectCatalogRepository.archive(f.projectId)
    else if (scope === 'session') f.db.sessionRepository.archive(f.sessionId)
    else beginArchive(f)
    expect((await f.flow.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
      'unavailable',
    )
    expect(api.instances).toHaveLength(0)
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  },
)

it.each(['quit', 'archive'] as const)(
  'rechecks %s after asynchronous recovery and before HTTP owner admission',
  async (change) => {
    const f = await fixture()
    const deciding = f.flow.evaluateDecision(f.input, new AbortController().signal)
    if (change === 'quit') f.flow.prepareNativeQuit({ operationId: randomUUID() })
    else beginArchive(f)
    expect((await deciding).kind).toBe('unavailable')
    expect(api.instances).toHaveLength(0)
    expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  },
)

it.each(['reserve', 'dispatch'] as const)(
  'rechecks an archive barrier at the %s trust seam without recording an invocation',
  async (stage) => {
    const f = await fixture()
    if (stage === 'reserve')
      api.beforeReserve = () => {
        beginArchive(f)
      }
    else
      api.beforeDispatch = () => {
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
  'rejects a resolved selection when %s becomes unavailable before adoption',
  async (scope) => {
    const f = await fixture()
    api.afterResolve = () => {
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
  api.beforeReserve = () => {
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
    'selection',
  )
})

it('keeps physical auxiliary work visible to Quit and blocks only its Archive scope until release', async () => {
  const f = await fixture(),
    physical = Promise.withResolvers<boolean>()
  api.physical = physical.promise
  api.logical = Promise.resolve({ kind: 'unavailable', reason: 'timeout' })
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

it('includes an unknown durable HTTP owner after Conversation reconstruction without replay or release', async () => {
  const f = await fixture()
  const httpOwner = {
    version: 1,
    kind: 'http',
    utilityEpoch: randomUUID(),
    utilityPid: process.pid,
    requestId: randomUUID(),
  } as const
  const reservation = f.repo.reserveEvaluation({
    handoff: f.input.handoff,
    configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
    inputSha256: createHash('sha256').update(JSON.stringify(f.input)).digest('hex'),
    deadlineAt: Date.now() + 15000,
    httpOwner,
  })
  if (reservation.status !== 'reserved') throw new Error('Missing owned reservation')
  f.repo.dispatchEvaluation(reservation.evaluation.id, httpOwner)
  await f.flow.dispose()
  const reopened = new Conversation(
    f.repo,
    f.db.sessionRepository,
    f.db.projectCatalogRepository,
    new RuntimePreparation(f.db.runtimePreparationRepository),
    new ProjectFileReader(
      f.db.sessionRepository,
      f.db.projectCatalogRepository,
      runDirectoryWorker,
    ),
    undefined,
    undefined,
    undefined,
    () => 'OWNED_LOOPBACK_CREDENTIAL',
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
  })
  expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
    httpOwnerJson: JSON.stringify(httpOwner),
    physicalWitnessJson: null,
  })
  expect(f.db.drizzle.get(sql`SELECT remote_outcome FROM scheduling_evaluations`)).toEqual({
    remote_outcome: 'unknown',
  })
  expect(api.instances.every((instance) => !instance.invoked)).toBe(true)
  expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
})

const bounded = async <T>(work: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Owned child did not settle')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function ownedHttpUtility() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    shell: false,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  const ready = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      const pid = child.pid
      if (typeof pid !== 'number' || pid <= 0) reject(Error('Owned child has no PID'))
      else resolve(pid)
    })
  })
  return {
    pid: () => bounded(ready, 5000),
    close: () => {
      child.stdin?.end()
      return bounded(closed, 5000)
    },
    dispose: async () => {
      child.stdin?.end()
      try {
        await bounded(closed, 2000)
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null) throw error
        child.kill('SIGKILL') // only this owned child, failure-path timeout only
        await bounded(closed, 2000)
      }
    },
  }
}

it(
  'releases a dispatched HTTP owner only after the actual child process exits naturally',
  { timeout: 10_000 },
  async () => {
    const f = await fixture()
    const utility = ownedHttpUtility()
    try {
      const pid = await utility.pid()
      const httpOwner = {
        version: 1,
        kind: 'http',
        utilityEpoch: randomUUID(),
        utilityPid: pid,
        requestId: randomUUID(),
      } as const
      const reservation = f.repo.reserveEvaluation({
        handoff: f.input.handoff,
        configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
        inputSha256: createHash('sha256').update(JSON.stringify(f.input)).digest('hex'),
        deadlineAt: Date.now() + 15000,
        httpOwner,
      })
      if (reservation.status !== 'reserved') throw new Error('Missing owned reservation')
      f.repo.dispatchEvaluation(reservation.evaluation.id, httpOwner)
      // A still-alive owner stays a durable duplicate with the owner retained.
      expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'duplicate',
      })
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
        httpOwnerJson: JSON.stringify(httpOwner),
        active: true,
      })
      expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
      expect(api.instances).toHaveLength(0)
      const exit = await utility.close()
      expect(exit).toEqual({ code: 0, signal: null })
      // The next same-fact evaluation triggers the real OS-absence recovery.
      expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'duplicate',
      })
      await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
      expect(
        f.db.drizzle.get(
          sql`SELECT called,active,outcome,remote_outcome FROM scheduling_evaluations`,
        ),
      ).toEqual({ called: 1, active: 0, outcome: 'failed', remote_outcome: 'unknown' })
      expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
      expect(api.instances).toHaveLength(0)
    } finally {
      await utility.dispose()
    }
  },
)

it.each(['eperm', 'malformed'] as const)(
  'retains a live dispatched HTTP owner when absence cannot be proven (%s)',
  { timeout: 10_000 },
  async (kind) => {
    const f = await fixture()
    const utility = ownedHttpUtility()
    try {
      const pid = await utility.pid()
      const httpOwner = {
        version: 1,
        kind: 'http',
        utilityEpoch: randomUUID(),
        utilityPid: pid,
        requestId: randomUUID(),
      } as const
      const reservation = f.repo.reserveEvaluation({
        handoff: f.input.handoff,
        configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
        inputSha256: createHash('sha256').update(JSON.stringify(f.input)).digest('hex'),
        deadlineAt: Date.now() + 15000,
        httpOwner,
      })
      if (reservation.status !== 'reserved') throw new Error('Missing owned reservation')
      f.repo.dispatchEvaluation(reservation.evaluation.id, httpOwner)
      const originalKill = process.kill.bind(process)
      const killSpy = vi.spyOn(process, 'kill')
      try {
        if (kind === 'eperm')
          killSpy.mockImplementation((target: number, signal?: string | number) => {
            if (target === pid && signal === 0)
              throw Object.assign(new Error('Owned probe blocked'), { code: 'EPERM' })
            return signal === undefined ? originalKill(target) : originalKill(target, signal)
          })
        else
          f.db.drizzle.run(
            sql`UPDATE scheduling_runtime_owners SET http_owner_json = '{}' WHERE id = ${reservation.evaluation.id}`,
          )
        const before = f.repo.activeSchedulingRuntimeOwner()
        expect(await f.flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
          kind: 'unavailable',
          reason: 'duplicate',
        })
        // Unproven absence or a malformed owner byte keeps the exact stored row.
        expect(f.repo.activeSchedulingRuntimeOwner()).toEqual(before)
        expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
        expect(api.instances).toHaveLength(0)
        // Malformed rows never reach the OS probe; EPERM proves the probe actually ran.
        expect(killSpy.mock.calls).toEqual(kind === 'eperm' ? [[pid, 0]] : [])
      } finally {
        killSpy.mockRestore()
      }
    } finally {
      await utility.dispose()
    }
  },
)
