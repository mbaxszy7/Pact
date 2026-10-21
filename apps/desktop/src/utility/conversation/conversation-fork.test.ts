import { eq } from 'drizzle-orm'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { AgentNativeForkInput, AgentNativeForkSourceInput } from '@pact/agent-runtime'
import type {
  AgentNativeForkWitness,
  DefaultSessionSettings,
  RuntimeAgentId,
} from '@pact/contracts'

import { PactDatabase, agentRuns, conversationMessages } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  hold: false,
  failCodex: false,
  preparing: [] as AgentNativeForkSourceInput[],
  forking: [] as AgentNativeForkInput[],
  modelCalls: 0,
  initializeCalls: 0,
  pending: new Map<RuntimeAgentId, () => void>(),
  beforeDispatch: undefined as ((input: AgentNativeForkInput) => void) | undefined,
}))
function evidence(input: AgentNativeForkInput, agentId: RuntimeAgentId): AgentNativeForkWitness {
  return {
    version: 'pact-native-fork-v1',
    sourceNativeSessionId: input.source.nativeSessionId,
    nativeSessionId: `child-${agentId}`,
    sourceCutId: input.source.nativeCutId,
    sourcePrefixHash: input.source.prefixHash,
    candidatePrefixHash: input.source.prefixHash,
    idMap: [[input.source.nativeTurnId, input.source.nativeTurnId]],
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    initializedAt: new Date().toISOString(),
    initializedPrefixHash: input.source.prefixHash,
    initializedPrefixBytes: 100,
    initializedPrefixRecords: 2,
  }
}
class NativeBoundary {
  constructor(readonly id: RuntimeAgentId) {}
  async prepareNativeFork(input: AgentNativeForkSourceInput) {
    native.preparing.push(input)
    return {
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      nativeCutId: input.nativeTurnId,
      bindingGeneration: input.bindingGeneration,
      throughSequence: input.throughSequence,
      deliveryCursor: input.deliveryCursor,
      prefixHash: createHash('sha256').update(input.nativeSessionId).digest('hex'),
      prefixRecords: 2,
      prefixBytes: 100,
    }
  }
  async forkNativeContext(input: AgentNativeForkInput, signal: AbortSignal) {
    native.forking.push(input)
    native.beforeDispatch?.(input)
    const executorId = randomUUID()
    await input.onDispatched(executorId)
    input.reportNativeWork({ executorId, state: 'unknown' })
    signal.throwIfAborted()
    if (native.hold)
      await new Promise<void>((resolveHold, reject) => {
        const abort = () => {
          native.pending.delete(this.id)
          reject(signal.reason)
        }
        native.pending.set(this.id, () => {
          signal.removeEventListener('abort', abort)
          native.pending.delete(this.id)
          resolveHold()
        })
        signal.addEventListener('abort', abort, { once: true })
      })
    signal.throwIfAborted()
    input.reportNativeWork({ executorId, state: 'settled' })
    if (native.failCodex && this.id === 'codex')
      throw new Error('Fork acknowledgement lost before candidate identity')
    const witness = evidence(input, this.id)
    await input.onCandidate(witness.nativeSessionId, witness)
    return { nativeSessionId: witness.nativeSessionId, witness }
  }
  async inspectNativeFork(input: AgentNativeForkInput) {
    if (!input.nativeSessionId)
      return { kind: 'unconfirmed' as const, reason: 'Original candidate identity is unknown.' }
    return {
      kind: 'verified' as const,
      ready: true,
      workSettled: true,
      result: {
        nativeSessionId: evidence(input, this.id).nativeSessionId,
        witness: evidence(input, this.id),
      },
    }
  }
  async initializeNativeFork(input: AgentNativeForkInput) {
    native.initializeCalls += 1
    return {
      nativeSessionId: evidence(input, this.id).nativeSessionId,
      witness: evidence(input, this.id),
    }
  }
  run() {
    native.modelCalls += 1
    throw new Error('Fork must never dispatch a model task')
  }
  async dispose() {
    return undefined
  }
}
vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: function ClaudeFixture() {
    return new NativeBoundary('claude')
  },
}))
vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: function CodexFixture() {
    return new NativeBoundary('codex')
  },
}))
const owned: Array<{ db: PactDatabase; flow: Conversation }> = []
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (item) => {
      await item.flow.dispose()
      item.db.close()
    }),
  )
  native.hold = false
  native.failCodex = false
  native.preparing = []
  native.forking = []
  native.modelCalls = 0
  native.initializeCalls = 0
  native.pending.clear()
  native.beforeDispatch = undefined
  vi.restoreAllMocks()
})
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 3,

  maxReviewCycles: 2,
  maxRepairAttempts: 2,
}
async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    sourceId = randomUUID(),
    now = new Date().toISOString()
  const messageIds = Array.from({ length: 4 }, () => randomUUID()),
    runIds = [randomUUID(), randomUUID()]
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Fork',
    directoryPath: '/owned/fork',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sourceId, projectId, title: 'Source', createdAt: now },
    settings,
  )
  for (const [index, agentId] of (['claude', 'codex'] as const).entries())
    db.drizzle
      .insert(agentRuns)
      .values({
        id: runIds[index]!,
        sessionId: sourceId,
        userMessageId: messageIds[index * 2]!,
        agentId,
        status: 'completed',
        attemptCount: 1,
        settingsRevision: 1,
        model: null,
        effort: null,
        nativeSessionId: `source-${agentId}`,
        nativeTurnId: runIds[index]!,
        nativeOutcome: 'completed',
        nativeEffectsState: 'settled',
        dispatchPhase: 'ended',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  for (const [index, id] of messageIds.entries())
    db.drizzle
      .insert(conversationMessages)
      .values({
        id,
        sessionId: sourceId,
        runId: runIds[Math.floor(index / 2)]!,
        role: index % 2 ? 'assistant' : 'user',
        agentId: index % 2 ? (index === 1 ? 'claude' : 'codex') : null,
        content: `message-${index}`,
        state: 'complete',
        sequence: index,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        { agentId: 'claude', state: 'ready', executablePath: '/fixture/claude', checkedAt: now },
        { agentId: 'codex', state: 'ready', executablePath: '/fixture/codex', checkedAt: now },
      ],
    },
  })
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  owned.push({ db, flow })
  const prepare = async () => {
    const result = await flow.forkSession({
      action: 'prepare',
      sourceSessionId: sourceId,
      messageId: messageIds[3]!,
    })
    if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result))
    return result.value.prepared
  }
  const create = async (operationId = randomUUID()) => {
    const prepared = await prepare()
    const input = {
      action: 'create' as const,
      sourceSessionId: sourceId,
      messageId: messageIds[3]!,
      operationId,
      sourceRevision: prepared.sourceRevision,
      messageRevision: prepared.messageRevision,
      settingsRevision: prepared.settingsRevision,
      confirmedFullAccessAgents: [],
    }
    const result = await flow.forkSession(input)
    if (!result.ok || result.value.kind !== 'created') throw new Error(JSON.stringify(result))
    return { operation: result.value.operation, input }
  }
  return { db, flow, sourceId, messageIds, runIds, prepare, create }
}

it('rejects a missing peer before any native preparation, dispatch or Pact commit', async () => {
  const f = await fixture()
  f.db.drizzle
    .update(agentRuns)
    .set({ nativeSessionId: null })
    .where(eq(agentRuns.id, f.runIds[1]!))
    .run()
  expect(
    (
      await f.flow.forkSession({
        action: 'prepare',
        sourceSessionId: f.sourceId,
        messageId: f.messageIds[3]!,
      })
    ).ok,
  ).toBe(false)
  expect(native.preparing).toHaveLength(0)
  expect(native.forking).toHaveLength(0)
  expect(
    f.db.sessionRepository.readPage(f.db.sessionRepository.find(f.sourceId)!.projectId).sessions,
  ).toHaveLength(1)
})
it('commits before native dispatch, returns one durable receipt, and gates Send until both native bindings exist', async () => {
  const f = await fixture()
  native.hold = true
  native.beforeDispatch = (input) => {
    expect(f.db.sessionRepository.find(input.sessionId)).toBeDefined()
    expect(f.db.conversationRepository.read(input.sessionId).messages).toHaveLength(4)
  }
  const { operation, input } = await f.create()
  await vi.waitFor(() => expect(native.pending.size).toBe(2))
  const duplicate = await f.flow.forkSession(input)
  expect(duplicate).toMatchObject({
    ok: true,
    value: { kind: 'created', operation: { sessionId: operation.sessionId } },
  })
  expect(native.forking).toHaveLength(2)
  const blocked = await f.flow.send({
    sessionId: operation.sessionId,
    clientMessageId: randomUUID(),
    content: 'Do not dispatch while initializing',
    expectedCommentsRevision: 0,
    commentIds: [],
    route: { type: 'agent', agentId: 'codex' },
  })
  expect(blocked.ok).toBe(false)
  expect(native.modelCalls).toBe(0)
  native.pending.get('claude')!()
  await vi.waitFor(() =>
    expect(
      f.db.conversationRepository
        .forkOperation(operation.sessionId)!
        .sides.find((side) => side.agentId === 'claude')!.state,
    ).toBe('ready'),
  )
  expect(f.db.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(true)
  native.pending.get('codex')!()
  await vi.waitFor(() =>
    expect(f.db.conversationRepository.forkOperation(operation.sessionId)!.ready).toBe(true),
  )
  expect(f.db.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(false)
  expect(native.modelCalls).toBe(0)
  expect(f.db.conversationRepository.read(f.sourceId).messages).toHaveLength(4)
})
it('preserves a successful side and refuses blind replacement after a lost native identity', async () => {
  const f = await fixture()
  native.failCodex = true
  const { operation } = await f.create()
  await vi.waitFor(() =>
    expect(
      f.db.conversationRepository
        .forkOperation(operation.sessionId)!
        .sides.find((side) => side.agentId === 'codex')!.state,
    ).toBe('unconfirmed'),
  )
  const state = f.db.conversationRepository.forkOperation(operation.sessionId)!
  expect(state.sides.find((side) => side.agentId === 'claude')!.state).toBe('ready')
  expect(state.sides.find((side) => side.agentId === 'codex')!.canContinue).toBe(false)
  const beforeRecoveryInitialization = native.initializeCalls
  await f.flow.forkSession({
    action: 'check',
    sessionId: operation.sessionId,
    operationId: operation.id,
    agentId: 'codex',
  })
  await f.flow.forkSession({
    action: 'continue',
    sessionId: operation.sessionId,
    operationId: operation.id,
    agentId: 'codex',
  })
  expect(native.forking).toHaveLength(2)
  expect(native.initializeCalls).toBe(beforeRecoveryInitialization)
  expect(native.modelCalls).toBe(0)
  expect(f.db.sessionRepository.find(operation.sessionId)!.activity.state).toBe('error')
})

it('releases Fork owners and preserves one committed child through 100 success/failure/cold-restart cycles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-fork-cycle-'))
  try {
    // oxlint-disable no-await-in-loop -- Validate release and cold recovery before opening the next owned database.
    for (let cycle = 0; cycle < 100; cycle++) {
      native.hold = cycle % 3 === 2
      native.failCodex = cycle % 3 === 1
      const filePath = join(directory, `cycle-${cycle}.sqlite`),
        f = await fixture(filePath)
      const { operation } = await f.create()
      await vi.waitFor(() =>
        expect(
          f.db.conversationRepository
            .forkOperation(operation.sessionId)!
            .sides.every(
              (side) =>
                side.state === 'ready' ||
                side.state === 'unconfirmed' ||
                (native.hold && side.state === 'forking'),
            ),
        ).toBe(true),
      )
      await f.flow.dispose()
      expect(f.flow.diagnostics()).toMatchObject({
        nativeForks: 0,
        forkPreparations: 0,
        adapterSlots: 0,
        activeExecutions: 0,
        preparingExecutions: 0,
      })
      f.db.close()
      owned.splice(
        owned.findIndex((item) => item.db === f.db),
        1,
      )
      const reopened = await PactDatabase.open({
        filePath,
        migrationsFolder: resolve(
          import.meta.dirname,
          '../../../../../packages/persistence/drizzle',
        ),
      })
      try {
        reopened.conversationRepository.recoverForkIntents()
        expect(reopened.conversationRepository.read(operation.sessionId).messages).toHaveLength(4)
        expect(
          reopened.sessionRepository.readPage(
            reopened.sessionRepository.find(f.sourceId)!.projectId,
          ).sessions,
        ).toHaveLength(2)
        expect(reopened.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(
          cycle % 3 !== 0,
        )
      } finally {
        reopened.close()
      }
      expect(native.pending.size).toBe(0)
    }
    // oxlint-enable no-await-in-loop
    expect(native.modelCalls).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it('bounds even synchronously rejected preparation requests and releases their entries', async () => {
  const f = await fixture()
  const requests = Array.from({ length: 6 }, () =>
    f.flow.forkSession({
      action: 'prepare',
      sourceSessionId: randomUUID(),
      messageId: randomUUID(),
    }),
  )
  expect(f.flow.diagnostics().forkPreparations).toBe(5)
  expect((await Promise.all(requests)).every((reply) => !reply.ok)).toBe(true)
  expect(f.flow.diagnostics().forkPreparations).toBe(0)
  expect(native.preparing).toHaveLength(0)
})
