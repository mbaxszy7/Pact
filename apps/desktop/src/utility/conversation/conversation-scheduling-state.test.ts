import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PactDatabase } from '@pact/persistence'

import { schedulingStateSchema } from '@pact/contracts'

import type { WorkflowNativeState } from './relay-workflow-fixture.test-support.js'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { Conversation } from './conversation.js'
import { enableWorkflowRelay } from './relay-workflow-fixture.test-support.js'

type Credential = NonNullable<ConstructorParameters<typeof Conversation>[8]>

const api = vi.hoisted(() => ({
  inputs: [] as WorkflowNativeState['inputs'],
  reviews: [] as WorkflowNativeState['reviews'],
  decisions: [] as WorkflowNativeState['decisions'],
  candidate: undefined as WorkflowNativeState['candidate'],
  interruptNextWrite: false,
  loseObservation: false,
  rebuilds: [] as string[],
  sourceReads: [] as WorkflowNativeState['sourceReads'],
}))
vi.mock('./openai-decision-runtime.js', async () => {
  const { workflowDecisionRuntime } = await import('./relay-workflow-fixture.test-support.js')
  return { OpenAIDecisionRuntime: workflowDecisionRuntime(api) }
})

const owners: Array<{ flow: Conversation; db: PactDatabase }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const owner of owners.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- Each owner closes physical work before its database.
    await owner.flow.dispose()
    owner.db.close()
  }
  api.inputs.length = 0
  api.reviews.length = 0
  api.decisions.length = 0
  api.candidate = undefined
  api.interruptNextWrite = false
  api.loseObservation = false
  api.rebuilds.length = 0
  api.sourceReads.length = 0
})

async function fixture(credential: Credential = () => 'OWNED_WORKFLOW_CREDENTIAL') {
  const f = await decisionFixture()
  const { flow, findExecutable, readiness } = attach(f.db, credential)
  enableWorkflowRelay(f.db)
  return { ...f, flow, findExecutable, readiness }
}

function attach(db: PactDatabase, credential: Credential) {
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  const findExecutable = vi
    .spyOn(preparation, 'findRecoveryExecutable')
    .mockResolvedValue(process.execPath)
  const readiness = vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: new Date().toISOString(),
        },
        {
          agentId: 'claude',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: new Date().toISOString(),
        },
      ],
    },
  })
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
    undefined,
    undefined,
    undefined,
    credential,
  )
  owners.push({ flow, db })
  return { flow, findExecutable, readiness }
}

function idleSession(f: Awaited<ReturnType<typeof fixture>>) {
  const sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  f.db.sessionRepository.create(
    { id: sessionId, projectId: f.projectId, title: 'Idle session', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  return sessionId
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function records(db: PactDatabase) {
  return db.drizzle.get(
    sql`SELECT (SELECT count(*) FROM scheduling_evaluations) AS evaluations,(SELECT count(*) FROM scheduling_runtime_owners) AS owners,(SELECT count(*) FROM agent_runs) AS runs`,
  )
}

describe('Conversation scheduling observations and HTTP admission', () => {
  it('reads global and Session state without invoking the credential or provider', async () => {
    const credential = vi.fn<Credential>(() => 'OWNED_WORKFLOW_CREDENTIAL')
    const f = await fixture(credential)
    const before = records(f.db)
    const global = f.flow.getSchedulingState({})
    expect(global.ok).toBe(true)
    if (!global.ok) throw Error('Missing global scheduling state')
    schedulingStateSchema.parse(global.value)
    expect(Object.keys(global.value)).not.toContain('host')
    expect(Object.keys(global.value)).not.toContain('models')
    expect(global.value.connection).toEqual({
      status: 'unconfirmed',
      checkedAt: null,
      expiresAt: null,
    })
    expect(global.value.context).toBeNull()
    expect(global.value.activity.decision).toEqual({ status: 'idle' })
    const serialized = JSON.stringify(global.value)
    expect(serialized).not.toContain('OWNED_WORKFLOW_CREDENTIAL')
    expect(serialized).not.toContain('ciphertext')
    expect(serialized).not.toContain(f.repo.readRelayCredential().ciphertext!)
    // Repeated reads across a real microtask tick still trigger no provider work.
    const second = f.flow.getSchedulingState({})
    expect(second).toEqual(global)
    const idle = idleSession(f)
    const contextual = f.flow.getSchedulingState({ sessionId: idle })
    expect(contextual.ok).toBe(true)
    if (!contextual.ok) throw Error('Missing contextual scheduling state')
    expect(contextual.value.context).toMatchObject({
      sessionId: idle,
      eligibility: 'unconfirmed',
    })
    const unknown = f.flow.getSchedulingState({ sessionId: randomUUID() })
    expect(unknown.ok).toBe(false)
    await tick()
    expect(credential).toHaveBeenCalledTimes(0)
    expect(f.findExecutable).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
    expect(api.decisions).toHaveLength(0)
    expect(records(f.db)).toEqual(before)
  })

  it('reports disabled then key_required precedence through public mutations only', async () => {
    const credential = vi.fn<Credential>(() => 'OWNED_WORKFLOW_CREDENTIAL')
    const f = await fixture(credential)
    const repo = f.db.conversationRepository
    await f.flow.saveSchedulingSettings({
      expectedRevision: repo.schedulingSettings().revision,
      enabled: false,
    })
    const idle = idleSession(f)
    const disabled = f.flow.getSchedulingState({ sessionId: idle })
    expect(disabled.ok).toBe(true)
    if (!disabled.ok) throw Error('Missing disabled state')
    expect(disabled.value.context?.eligibility).toBe('disabled')
    const rev = repo.schedulingSettings().revision
    await f.flow.saveSchedulingSettings({ expectedRevision: rev, enabled: true })
    await f.flow.writeRelayCredential({
      operation: 'remove',
      nonce: randomUUID(),
      expectedRevision: repo.readRelayCredential().revision,
      deadlineAt: Date.now() + 5000,
    })
    const required = f.flow.getSchedulingState({ sessionId: idle })
    expect(required.ok).toBe(true)
    if (!required.ok) throw Error('Missing key_required state')
    expect(required.value.context?.eligibility).toBe('key_required')
    expect(credential).not.toHaveBeenCalled()
    expect(api.decisions).toHaveLength(0)
  })

  it('observes one real evaluation with exact connection metadata, indicator freshness and TTL', async () => {
    const credential = vi.fn<Credential>(() => 'OWNED_WORKFLOW_CREDENTIAL')
    const f = await fixture(credential)
    const outcome = await f.flow.evaluateDecision(f.input, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'selection' })
    await vi.waitFor(() => expect(f.repo.activeEvaluation()).toBeUndefined())
    const observed = f.flow.getSchedulingState({})
    expect(observed.ok).toBe(true)
    if (!observed.ok) throw Error('Missing observed state')
    expect(observed.value.connection).toMatchObject({ status: 'available' })
    const before = observed.value.connection
    const generation = f.repo.schedulingConfigurationGeneration()
    await f.flow.saveSchedulingSettings({
      expectedRevision: f.repo.schedulingSettings().revision,
      showIndicator: false,
    })
    expect(f.repo.schedulingConfigurationGeneration()).toBe(generation)
    const indicator = f.flow.getSchedulingState({})
    expect(indicator.ok).toBe(true)
    if (!indicator.ok) throw Error('Missing indicator state')
    expect(indicator.value.connection).toEqual(before)
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockImplementation(() => Date.parse(before.expiresAt!) + 1)
      const stale = f.flow.getSchedulingState({})
      expect(stale.ok).toBe(true)
      if (!stale.ok) throw Error('Missing stale state')
      expect(stale.value.connection).toMatchObject({
        status: 'stale',
        checkedAt: before.checkedAt,
        expiresAt: before.expiresAt,
      })
      const idle = idleSession(f)
      const contextual = f.flow.getSchedulingState({ sessionId: idle })
      expect(contextual.ok).toBe(true)
      if (!contextual.ok) throw Error('Missing stale context')
      expect(contextual.value.context?.eligibility).toBe('unconfirmed')
      expect(api.decisions).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
    expect(credential).toHaveBeenCalledTimes(1)
    expect(f.findExecutable).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
  })

  it.each(['enabled', 'credential'] as const)(
    'clears the recorded observation back to unconfirmed on a public %s change',
    async (field) => {
      const f = await fixture()
      await f.flow.evaluateDecision(f.input, new AbortController().signal)
      await vi.waitFor(() => expect(f.repo.activeEvaluation()).toBeUndefined())
      const repo = f.db.conversationRepository
      const generation = repo.schedulingConfigurationGeneration(),
        originalCipher = repo.readRelayCredential().ciphertext
      if (field === 'enabled') {
        await f.flow.saveSchedulingSettings({
          expectedRevision: repo.schedulingSettings().revision,
          enabled: false,
        })
        await f.flow.saveSchedulingSettings({
          expectedRevision: repo.schedulingSettings().revision,
          enabled: true,
        })
      } else {
        const stored = repo.readRelayCredential()
        for (const attempt of [1, 2]) {
          // oxlint-disable-next-line no-await-in-loop -- Each sequential write bumps the credential revision for the next.
          const roundTrip = await f.flow.writeRelayCredential({
            operation: 'save',
            nonce: randomUUID(),
            expectedRevision: repo.readRelayCredential().revision,
            deadlineAt: Date.now() + 5000,
            ciphertext: stored.ciphertext!,
          })
          if (!roundTrip.ok) throw Error(`Same-ciphertext save ${attempt} must be accepted`)
        }
      }
      expect(repo.readRelayCredential().ciphertext).toBe(originalCipher)
      const state = f.flow.getSchedulingState({})
      expect(state.ok).toBe(true)
      if (!state.ok) throw Error('Missing cleared state')
      expect(state.value.connection).toEqual({
        status: 'unconfirmed',
        checkedAt: null,
        expiresAt: null,
      })
      expect(repo.schedulingConfigurationGeneration()).toBe(generation + 2)
      expect(api.decisions).toHaveLength(1)
    },
  )

  it('marks the observation stale on a direct persistence generation change without notification', async () => {
    const f = await fixture()
    await f.flow.evaluateDecision(f.input, new AbortController().signal)
    await vi.waitFor(() => expect(f.repo.activeEvaluation()).toBeUndefined())
    const observed = f.flow.getSchedulingState({})
    expect(observed.ok).toBe(true)
    if (!observed.ok) throw Error('Missing observed state')
    const repo = f.db.conversationRepository
    const bypassed = repo.saveSchedulingSettings({
      expectedRevision: repo.schedulingSettings().revision,
      enabled: false,
    })
    repo.saveSchedulingSettings({ expectedRevision: bypassed.revision, enabled: true })
    const stale = f.flow.getSchedulingState({})
    expect(stale.ok).toBe(true)
    if (!stale.ok) throw Error('Missing stale state')
    expect(stale.value.connection).toMatchObject({
      status: 'stale',
      checkedAt: observed.value.connection.checkedAt,
      expiresAt: observed.value.connection.expiresAt,
    })
    expect(api.decisions).toHaveLength(1)
  })

  it('reports live preparation while the credential is deferred, then settles idle', async () => {
    const deferred = Promise.withResolvers<string>()
    const credential = vi.fn<Credential>(() => deferred.promise)
    const f = await fixture(credential)
    const evaluating = f.flow.evaluateDecision(f.input, new AbortController().signal)
    try {
      await vi.waitFor(() =>
        expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({ phase: 'reserved' }),
      )
      const live = f.flow.getSchedulingState({})
      expect(live.ok).toBe(true)
      if (!live.ok) throw Error('Missing live state')
      expect(live.value.activity.decision).toMatchObject({ status: 'evaluating' })
      const idle = idleSession(f)
      const contextual = f.flow.getSchedulingState({ sessionId: idle })
      expect(contextual.ok).toBe(true)
      if (!contextual.ok) throw Error('Missing live context')
      expect(contextual.value.context?.eligibility).toBe('busy')
    } finally {
      deferred.resolve('OWNED_WORKFLOW_CREDENTIAL')
    }
    await evaluating
    await vi.waitFor(() => expect(f.repo.activeEvaluation()).toBeUndefined())
    const settled = f.flow.getSchedulingState({})
    expect(settled.ok).toBe(true)
    if (!settled.ok) throw Error('Missing settled state')
    expect(settled.value.activity.decision).toEqual({ status: 'idle' })
    expect(settled.value.connection.status).toBe('available')
    expect(credential).toHaveBeenCalledTimes(1)
    expect(f.findExecutable).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
  })
})
