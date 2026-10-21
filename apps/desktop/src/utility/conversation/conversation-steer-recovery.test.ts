import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type {
  AgentNativeInputProbeInput,
  AgentNativeProbeInput,
  AgentRunInput,
  AgentSteerInput,
  AgentSteerResult,
} from '@pact/agent-runtime'
import type {
  DefaultSessionSettings,
  ConversationSendInput,
  NativeProbeResult,
  NormalizedAgentEvent,
  SkillBinding,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  inputs: new Map<string, AgentRunInput>(),
  finishes: new Map<string, () => void>(),
  background: new Set<string>(),
  runCalls: 0,
  disposed: 0,
  finishMode: 'normal' as 'normal' | 'fail_body_after_terminal' | 'seal_body_after_terminal',
  skills: [] as SkillBinding[],
  receipts: vi.fn<(input: AgentNativeInputProbeInput, signal: AbortSignal) => Promise<void>>(),
  status:
    vi.fn<(input: AgentNativeProbeInput, signal: AbortSignal) => Promise<NativeProbeResult>>(),
  steer: vi.fn<(input: AgentSteerInput, signal: AbortSignal) => Promise<AgentSteerResult>>(),
}))

async function* scriptedRun(
  executorId: string,
  input: AgentRunInput,
  signal: AbortSignal,
): AsyncIterable<NormalizedAgentEvent> {
  native.runCalls += 1
  const finishMode = native.finishMode
  native.finishMode = 'normal'
  native.inputs.set(input.runId, input)
  native.background.add(input.runId)
  input.recordExecutor?.(executorId)
  const nativeSessionId = input.nativeSessionId ?? `native:${input.sessionId}`
  const turnId = randomUUID()
  input.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
  yield { type: 'session.started', agentId: 'codex', nativeSessionId }
  input.recordDispatch?.('accepted', nativeSessionId, executorId)
  yield { type: 'turn.started', agentId: 'codex', turnId }
  yield {
    type: 'text.delta',
    agentId: 'codex',
    turnId,
    outputId: 'answer',
    text: 'Initial output.',
  }
  await new Promise<void>((finish) => {
    const release = () => {
      signal.removeEventListener('abort', release)
      native.finishes.delete(input.runId)
      finish()
    }
    native.finishes.set(input.runId, release)
    signal.addEventListener('abort', release, { once: true })
    if (signal.aborted) release()
  })
  signal.throwIfAborted()
  if (finishMode !== 'normal') {
    input.recordNativeEvidence?.({
      kind: 'ended',
      source: 'live_terminal',
      outcome: 'completed',
      identity: {
        sessionId: input.sessionId,
        agentId: 'codex',
        requestId: input.runId,
        runId: input.runId,
        nativeSessionId,
        nativeTurnId: turnId,
        bindingGeneration: input.bindingGeneration ?? 1,
        executorId,
      },
    })
    if (finishMode === 'fail_body_after_terminal') {
      input.recordOutputFailure?.(
        new Error('The terminal arrived before final body storage failed.'),
      )
      native.background.delete(input.runId)
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
      return
    }
  }
  yield {
    type: 'text.completed',
    agentId: 'codex',
    turnId,
    outputId: 'answer',
    text: 'Final output.',
  }
  yield { type: 'turn.completed', agentId: 'codex', turnId, outcome: 'completed' }
  if (finishMode === 'seal_body_after_terminal') {
    native.background.delete(input.runId)
    input.reportNativeEffects?.({
      runId: input.runId,
      generation: input.nativeGeneration!,
      state: 'settled',
    })
  }
}

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    readonly executorId = randomUUID()
    probeNativeInputs = native.receipts
    probeNativeStatus = native.status
    steer = native.steer
    async discoverSkills() {
      return native.skills
    }
    hasActiveBackgroundWork(runId?: string) {
      return runId ? native.background.has(runId) : native.background.size > 0
    }
    run(input: AgentRunInput, signal: AbortSignal) {
      return scriptedRun(this.executorId, input, signal)
    }
    async dispose() {
      native.disposed += 1
    }
  },
}))

afterEach(() => {
  vi.useRealTimers()
  native.inputs.clear()
  native.finishes.clear()
  native.background.clear()
  native.runCalls = 0
  native.disposed = 0
  native.finishMode = 'normal'
  native.skills = []
  native.receipts.mockReset()
  native.status.mockReset()
  native.steer.mockReset()
})

const migrationsFolder = resolvePath(
  import.meta.dirname,
  '../../../../../packages/persistence/drizzle',
)
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 3,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const frozenSkill: SkillBinding = {
  id: 'a'.repeat(64),
  agentId: 'codex',
  name: 'format',
  description: '',
  argumentHint: '',
  source: 'native',
  path: '/frozen/format/SKILL.md',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function noRootEvidence(input: AgentNativeProbeInput): NativeProbeResult {
  if (input.target === 'initialized_binding') throw new Error('Expected the original Run')
  return {
    kind: 'no_evidence',
    identity: {
      sessionId: input.sessionId,
      agentId: input.agentId,
      requestId: input.requestId,
      nativeSessionId: input.nativeSessionId,
      bindingGeneration: input.bindingGeneration,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      ...(input.executorId ? { executorId: input.executorId } : {}),
    },
    reason: 'The root terminal was not observed.',
  }
}

async function fixture(
  cold = true,
  freezeSkill = false,
  legacyRootAlias = false,
  acceptedBeforeAlias = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-steer-recovery-'))
  const filePath = join(directory, 'fixture.sqlite')
  let db = await PactDatabase.open({ filePath, migrationsFolder })
  const timestamp = new Date().toISOString()
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    inputOwner = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Receipt recovery',
    directoryPath: directory,
    kind: 'directory',
    createdAt: timestamp,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Receipt fixture', createdAt: timestamp },
    settings,
  )
  function queue(runId: string, content = 'Supplement', clientMessageId: string = randomUUID()) {
    const repo = db.conversationRepository
    const drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Draft fixture missing')
    const body = repo.writeConversationInput(
      { type: 'begin', sessionId, clientMessageId },
      inputOwner,
    )
    repo.writeConversationInput(
      { type: 'append', sessionId, inputId: body.inputId, offset: 0, text: content },
      inputOwner,
    )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, inputOwner)
    repo.receiveQueuedInput(
      {
        sessionId,
        clientMessageId,
        content: '',
        inputId: body.inputId,
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
      },
      body.inputId,
      'codex',
      inputOwner,
      runId,
    )
    const queued = repo.queueState(sessionId)
    return {
      sessionId,
      inputId: queued.input!.id,
      expectedRevision: queued.revision,
      operationId: randomUUID(),
    }
  }
  function seed() {
    const repo = db.conversationRepository
    const started = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Original task',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    const runId = started.run.id,
      executorId = randomUUID(),
      nativeSessionId = randomUUID(),
      nativeTurnId = randomUUID()
    repo.recordExecutor(runId, executorId)
    repo.recordDispatch(runId, 'accepted', nativeSessionId, executorId)
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: 'codex',
      nativeSessionId,
    })
    repo.applyEvent(sessionId, runId, {
      type: 'turn.started',
      agentId: 'codex',
      turnId: nativeTurnId,
    })
    const accepted = acceptedBeforeAlias ? queue(runId, 'Accepted supplement') : undefined
    if (accepted) {
      repo.prepareQueuedSteer(accepted, { runId, bindingGeneration: 1, nativeTurnId, executorId })
      repo.markQueuedSteerPossiblySent(accepted.operationId)
      repo.markQueuedSteerAccepted(accepted.operationId)
    }
    const request = queue(runId, freezeSkill ? '/format Use exact output' : 'Supplement')
    repo.prepareQueuedSteer(
      request,
      { runId, bindingGeneration: 1, nativeTurnId, executorId },
      freezeSkill
        ? {
            version: 'pact-skills-v1',
            arguments: 'Use exact output',
            selections: [],
            bindings: [frozenSkill],
          }
        : undefined,
    )
    repo.markQueuedSteerPossiblySent(request.operationId)
    if (legacyRootAlias) {
      // Simulate a pre-fix database with an admitted root-client alias, retaining
      // its genuinely sealed input body, Batch and same-Run native proof.
      const originalInputId = request.inputId
      db.drizzle.transaction(() => {
        db.drizzle.run(sql`PRAGMA defer_foreign_keys=ON`)
        db.drizzle.run(sql`UPDATE collaboration_inputs SET id=${runId} WHERE id=${originalInputId}`)
        db.drizzle.run(sql`UPDATE conversation_queue_operations SET input_id=${runId}
          WHERE id=${request.operationId}`)
        db.drizzle.run(sql`UPDATE conversation_input_batches SET client_message_id=${runId}
          WHERE client_message_id=${originalInputId}`)
        db.drizzle.run(sql`UPDATE conversation_body_inputs
          SET client_message_id=${runId}, pending_receipt_id=${runId}
          WHERE session_id=${sessionId} AND client_message_id=${originalInputId} AND purpose='input'`)
      })
      request.inputId = runId
    }
    // Deliberately leave root and delivery in-flight: Conversation owns restart classification.
    return { runId, executorId, nativeSessionId, nativeTurnId, request, accepted }
  }
  const saved = cold ? seed() : undefined
  const createFlow = () => {
    const preparation = new RuntimePreparation(db.runtimePreparationRepository)
    vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)
    vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: process.execPath,
            checkedAt: timestamp,
          },
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/fixture/claude',
            checkedAt: timestamp,
          },
        ],
      },
    })
    return new Conversation(
      db.conversationRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      preparation,
      new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
    )
  }
  let flow = createFlow()
  async function load() {
    const result = await flow.load({ scope: 'messages', sessionId })
    if (!result.ok || result.value.scope !== 'messages') throw new Error('Fixture page missing')
    return result.value
  }
  return {
    sessionId,
    saved,
    queue,
    load,
    get flow() {
      return flow
    },
    get db() {
      return db
    },
    async send(overrides: Partial<ConversationSendInput> = {}) {
      const result = await flow.send({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Original task',
        expectedCommentsRevision: 0,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
        ...overrides,
      })
      if (!result.ok) throw new Error(result.error.message)
      const runId = result.value.runs[0]!.id
      await vi.waitFor(() => expect(native.finishes.has(runId)).toBe(true))
      return runId
    },
    async restart() {
      await flow.dispose()
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      flow = createFlow()
    },
    async dispose() {
      try {
        await flow.dispose()
      } finally {
        db.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

it.each([
  { finishMode: 'fail_body_after_terminal', sealed: false, starts: 1 },
  { finishMode: 'seal_body_after_terminal', sealed: true, starts: 2 },
] as const)(
  'queues the follow-up only after its completed root has a sealed body: $finishMode',
  async ({ finishMode, sealed, starts }) => {
    const f = await fixture(false)
    native.finishMode = finishMode
    try {
      const runId = await f.send()
      const drafts = f.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f.sessionId,
      })
      if (drafts.scope !== 'drafts') throw new Error('Draft fixture missing')
      const followup = randomUUID()
      expect(
        await f.flow.send({
          sessionId: f.sessionId,
          clientMessageId: followup,
          content: 'Queued follow-up',
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
          route: { type: 'agent', agentId: 'codex' },
        }),
      ).toMatchObject({ ok: true, value: { receivedInputIds: [followup] } })
      native.finishes.get(runId)!()
      await vi.waitFor(() =>
        expect(f.db.conversationRepository.findRun(runId)).toMatchObject({
          status: 'completed',
          nativeOutcome: 'completed',
          dispatchPhase: 'ended',
          nativeEffectsState: 'settled',
        }),
      )
      expect(f.db.conversationRepository.hasCompleteResponse(runId)).toBe(sealed)
      const expectedQueue = sealed ? { id: null, state: null } : { id: followup, state: 'paused' }
      await vi.waitFor(() => {
        const queued = f.db.conversationRepository.queueState(f.sessionId).input
        expect(
          { id: queued?.id ?? null, state: queued?.state ?? null },
          `Native actor starts: ${native.runCalls}`,
        ).toEqual(expectedQueue)
      })
      await vi.waitFor(() => expect(native.runCalls).toBe(starts))
      expect((await f.load()).messages.some((entry) => entry.message.id === followup)).toBe(sealed)
    } finally {
      await f.dispose()
    }
  },
)

it.each([true, false])(
  'replays a submitted Send while its Run is active with freezeDrafts=%s without queuing it',
  async (freezeDrafts) => {
    const f = await fixture(false)
    try {
      const original: ConversationSendInput = {
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Original task',
        expectedCommentsRevision: 0,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
        freezeDrafts,
      }
      const runId = await f.send(original)
      await vi.waitFor(() => expect(f.flow.diagnostics().preparingExecutions).toBe(0))
      expect(f.flow.diagnostics().activeExecutions).toBe(1)
      const result = await f.flow.send(original)
      expect.soft(result).toMatchObject({ ok: true, value: { runs: [{ id: runId }] } })
      expect.soft(f.db.conversationRepository.queueState(f.sessionId).input).toBeNull()
      expect((await f.load()).messages.filter((entry) => entry.message.role === 'user')).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ id: original.clientMessageId }),
        }),
      ])
      expect(native.runCalls).toBe(1)
    } finally {
      await f.dispose()
    }
  },
)

it.each(['resume', 'remove_then_send'] as const)(
  'allows an explicit %s after a terminal-before-body failure without changing old actor or source',
  async (action) => {
    const f = await fixture(false)
    native.finishMode = 'fail_body_after_terminal'
    try {
      const runId = await f.send()
      const queued = f.queue(runId, 'Preserved follow-up')
      const originalSource = f.db.conversationRepository.readReceivedInput(f.sessionId)!
      native.finishes.get(runId)!()
      await vi.waitFor(() =>
        expect(f.db.conversationRepository.queueState(f.sessionId).input?.state).toBe('paused'),
      )
      await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
      const originalActor = native.inputs.get(runId)
      const originalRun = f.db.conversationRepository.findRun(runId)!
      const originalMessages = f.db.conversationRepository
        .read(f.sessionId)
        .messages.filter((message) => message.runId === runId)
        .map(({ id, content, state, contentRevision, sequence }) => ({
          id,
          content,
          state,
          contentRevision,
          sequence,
        }))
      expect(f.db.conversationRepository.hasCompleteResponse(runId)).toBe(false)
      expect(native.runCalls).toBe(1)
      const current = f.db.conversationRepository.queueState(f.sessionId)
      const request = {
        sessionId: f.sessionId,
        inputId: queued.inputId,
        expectedRevision: current.revision,
        operationId: randomUUID(),
      }
      const result =
        action === 'resume'
          ? f.flow.resumeConversationQueue(request)
          : f.flow.removeQueuedConversationMessage(request)
      expect(result.ok).toBe(true)
      let startsBeforeManualSend = 1
      if (action === 'remove_then_send') {
        startsBeforeManualSend = native.runCalls
        const drafts = f.db.conversationRepository.readPage({
          scope: 'drafts',
          sessionId: f.sessionId,
        })
        if (drafts.scope !== 'drafts') throw new Error('Draft fixture missing')
        await f.send({
          content: 'An explicitly new task',
          expectedCommentsRevision: drafts.commentsRevision,
        })
      }
      expect(startsBeforeManualSend).toBe(1)
      await vi.waitFor(() => expect(native.runCalls).toBe(2))
      expect(f.db.conversationRepository.queueState(f.sessionId).input).toBeNull()
      const page = await f.load()
      expect(page.messages.some((entry) => entry.message.id === queued.inputId)).toBe(
        action === 'resume',
      )
      expect(
        f.db.conversationRepository
          .read(f.sessionId)
          .messages.filter((message) =>
            originalMessages.some((original) => original.id === message.id),
          )
          .map(({ id, content, state, contentRevision, sequence }) => ({
            id,
            content,
            state,
            contentRevision,
            sequence,
          })),
      ).toEqual(originalMessages)
      expect(native.inputs.get(runId)).toBe(originalActor)
      expect(f.db.conversationRepository.findRun(runId)).toMatchObject({
        status: originalRun.status,
        nativeOutcome: originalRun.nativeOutcome,
        nativeSessionId: originalRun.nativeSessionId,
        nativeTurnId: originalRun.nativeTurnId,
        executorId: originalRun.executorId,
        nativeEffectsState: 'settled',
      })
      expect(
        f.db.drizzle.get(
          sql`SELECT hash FROM conversation_body_inputs WHERE id=${originalSource.inputId}`,
        ),
      ).toEqual({ hash: originalSource.digest })
    } finally {
      await f.dispose()
    }
  },
)

it.each([true, false])(
  'rejects changed task content using an already submitted Send UUID with freezeDrafts=%s',
  async (freezeDrafts) => {
    const f = await fixture(false)
    try {
      const clientMessageId = randomUUID()
      await f.send({ clientMessageId, freezeDrafts })
      const page = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (page.scope !== 'drafts') throw new Error('Draft fixture missing')
      const result = await f.flow.send({
        sessionId: f.sessionId,
        clientMessageId,
        content: 'Different task content',
        expectedCommentsRevision: page.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
        freezeDrafts,
      })
      expect.soft(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect.soft(f.db.conversationRepository.queueState(f.sessionId).input).toBeNull()
      expect(native.runCalls).toBe(1)
    } finally {
      await f.dispose()
    }
  },
)

it('refuses a Steer UUID that aliases the native root client UUID without dispatching it', async () => {
  const f = await fixture(false)
  native.steer.mockImplementation(async (input) => {
    input.recordDispatch('possibly_sent')
    throw new Error('No ACK or supplemental incorporation evidence.')
  })
  try {
    const runId = await f.send()
    const request = f.queue(runId, 'Unconfirmed root alias', runId)
    const result = await f.flow.steerQueuedConversationMessage(request)
    expect(result).toMatchObject({ ok: false })
    expect.soft(native.steer).not.toHaveBeenCalled()
    expect.soft(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: request.inputId,
      state: 'queued',
    })
    expect((await f.load()).messages.map((entry) => entry.message.id)).not.toContain(
      request.inputId,
    )
    expect(native.runCalls).toBe(1)
  } finally {
    await f.dispose()
  }
})

it('does not consume a legacy unknown Steer alias from a cold probe of the original root client UUID', async () => {
  const f = await fixture(true, false, true)
  native.receipts.mockImplementation(async (input) => {
    // The native reader observed only the original root user item's client UUID.
    input.recordConsumption(f.saved!.runId)
  })
  native.status.mockImplementation(async (input) => noRootEvidence(input))
  try {
    expect(f.saved!.request.inputId).toBe(f.saved!.runId)
    await f.restart()
    expect((await f.flow.retry({ runId: f.saved!.runId })).ok).toBe(false)
    expect.soft(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: f.saved!.request.inputId,
      state: 'unknown',
    })
    expect
      .soft(f.db.conversationRepository.readReceivedInput(f.sessionId)?.content)
      .toBe('Supplement')
    expect((await f.load()).messages.map((entry) => entry.message.id)).not.toContain(f.saved!.runId)
    expect(native.runCalls).toBe(0)
    expect(native.steer).not.toHaveBeenCalled()
  } finally {
    await f.dispose()
  }
})

it('ignores a cold root-client alias and continues to consume another accepted grant in the same Run', async () => {
  const f = await fixture(true, false, true, true)
  native.receipts.mockImplementation(async (input) => {
    input.recordConsumption(f.saved!.runId)
    input.recordConsumption(f.saved!.accepted!.inputId)
  })
  native.status.mockImplementation(async (input) => noRootEvidence(input))
  try {
    const source = f.db.conversationRepository.readReceivedInput(f.sessionId)!
    const acceptedMessage = f.db.conversationRepository
      .read(f.sessionId)
      .messages.find((message) => message.id === f.saved!.accepted!.inputId)!
    await f.restart()
    expect((await f.flow.retry({ runId: f.saved!.runId })).ok).toBe(false)
    expect(native.receipts).toHaveBeenCalledTimes(1)
    expect(
      f.db.drizzle.get(sql`SELECT state FROM conversation_queue_operations
      WHERE id=${f.saved!.accepted!.operationId}`),
    ).toEqual({ state: 'consumed' })
    expect(
      f.db.drizzle.get(sql`SELECT state FROM conversation_queue_operations
      WHERE id=${f.saved!.request.operationId}`),
    ).toEqual({ state: 'unknown' })
    expect(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: f.saved!.runId,
      state: 'unknown',
    })
    expect(f.db.conversationRepository.readReceivedInput(f.sessionId)).toMatchObject({
      id: source.id,
      digest: source.digest,
      inputId: source.inputId,
      content: source.content,
    })
    const page = await f.load()
    expect(
      f.db.conversationRepository
        .read(f.sessionId)
        .messages.find((message) => message.id === acceptedMessage.id),
    ).toMatchObject({
      id: acceptedMessage.id,
      content: acceptedMessage.content,
      state: acceptedMessage.state,
      contentRevision: acceptedMessage.contentRevision,
      sequence: acceptedMessage.sequence,
    })
    expect(page.messages.map((entry) => entry.message.id)).not.toContain(f.saved!.runId)
    expect(f.db.conversationRepository.nativeInputIdsForRun(f.saved!.runId)).toContain(
      f.saved!.accepted!.inputId,
    )
    expect(native.runCalls).toBe(0)
    expect(native.steer).not.toHaveBeenCalled()
  } finally {
    await f.dispose()
  }
})

it('cold message reads return before receipt I/O, check only once per interest, and never resend', async () => {
  const f = await fixture()
  const read = deferred()
  native.receipts.mockImplementation(async () => read.promise)
  try {
    expect(f.db.conversationRepository.queueState(f.sessionId).input?.state).toBe('unknown')
    await f.load()
    expect(native.receipts).not.toHaveBeenCalled()
    f.flow.setInterests([f.sessionId])
    const page = await f.load()
    expect(page.sessionId).toBe(f.sessionId)
    await vi.waitFor(() => expect(native.receipts).toHaveBeenCalledTimes(1))
    expect(native.receipts.mock.calls[0]![0]).toMatchObject({
      runId: f.saved!.runId,
      nativeSessionId: f.saved!.nativeSessionId,
      nativeTurnId: f.saved!.nativeTurnId,
      executorId: f.saved!.executorId,
      unresolvedInputIds: [f.saved!.request.inputId],
    })
    await f.load()
    const pendingRevision = f.flow.nativePresenceVersion().revision
    read.resolve()
    await vi.waitFor(() =>
      expect(f.flow.nativePresenceVersion().revision).toBeGreaterThan(pendingRevision),
    )
    await f.load()
    expect(native.receipts).toHaveBeenCalledTimes(1)
    expect(native.status).not.toHaveBeenCalled()
    expect(native.runCalls).toBe(0)
    expect(native.steer).not.toHaveBeenCalled()
    expect(f.db.conversationRepository.unresolvedSteerInputs(f.saved!.runId)).toHaveLength(1)
  } finally {
    read.resolve()
    await f.dispose()
  }
})

it('interest retirement aborts receipt I/O and rejects its late receipt without consuming delivery', async () => {
  const f = await fixture()
  const physical = deferred()
  native.receipts.mockImplementation(async () => physical.promise)
  try {
    f.flow.setInterests([f.sessionId])
    await f.load()
    await vi.waitFor(() => expect(native.receipts).toHaveBeenCalledTimes(1))
    const [input, signal] = native.receipts.mock.calls[0]!
    f.flow.setInterests([])
    expect(signal.aborted).toBe(true)
    input.recordConsumption(input.unresolvedInputIds[0]!)
    expect(f.db.conversationRepository.unresolvedSteerInputs(f.saved!.runId)).toHaveLength(1)
    const pendingRevision = f.flow.nativePresenceVersion().revision
    physical.resolve()
    await vi.waitFor(() =>
      expect(f.flow.nativePresenceVersion().revision).toBeGreaterThan(pendingRevision),
    )
    f.flow.setInterests([f.sessionId])
    await f.load()
    await vi.waitFor(() => expect(native.receipts).toHaveBeenCalledTimes(2))
    expect(native.runCalls).toBe(0)
  } finally {
    physical.resolve()
    await f.dispose()
  }
})

it('an explicit full check waits for the receipt owner then still inspects the root', async () => {
  const f = await fixture()
  const read = deferred()
  native.receipts.mockImplementation(async (input) => {
    await read.promise
    input.recordConsumption(input.unresolvedInputIds[0]!)
  })
  native.status.mockImplementation(async (input) => noRootEvidence(input))
  try {
    f.flow.setInterests([f.sessionId])
    await f.load()
    await vi.waitFor(() => expect(native.receipts).toHaveBeenCalledTimes(1))
    const retry = f.flow.retry({ runId: f.saved!.runId })
    expect(native.status).not.toHaveBeenCalled()
    read.resolve()
    expect((await retry).ok).toBe(false)
    expect(native.status).toHaveBeenCalledTimes(1)
    expect(native.receipts).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.unresolvedSteerInputs(f.saved!.runId)).toHaveLength(0)
    expect(native.status.mock.calls[0]![0]).toMatchObject({
      runId: f.saved!.runId,
      nativeInputIds: expect.arrayContaining([f.saved!.request.inputId]),
    })
    // Incorporation is independent of a reliable native ending.
    expect(f.db.conversationRepository.findRun(f.saved!.runId)?.nativeOutcome).toBeUndefined()
    expect(native.runCalls).toBe(0)
  } finally {
    read.resolve()
    await f.dispose()
  }
})

it('receipt timeout waits for physical cleanup and does not abort the independent root check', async () => {
  const f = await fixture()
  const physical = deferred()
  const childAborted = deferred()
  native.receipts.mockImplementation(async (_input, signal) => {
    signal.addEventListener('abort', childAborted.resolve, { once: true })
    await physical.promise
    signal.throwIfAborted()
  })
  native.status.mockImplementation(async (input, signal) => {
    expect(signal.aborted).toBe(false)
    return noRootEvidence(input)
  })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const retry = f.flow.retry({ runId: f.saved!.runId })
    await vi.waitFor(() => expect(native.receipts).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(10_000)
    await childAborted.promise
    expect(native.status).not.toHaveBeenCalled()
    // Another same-binding check must share the still-owned physical work.
    const sameCheck = f.flow.retry({ runId: f.saved!.runId })
    expect(native.receipts).toHaveBeenCalledTimes(1)
    physical.resolve()
    expect((await retry).ok).toBe(false)
    expect((await sameCheck).ok).toBe(false)
    expect(native.status).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.unresolvedSteerInputs(f.saved!.runId)).toHaveLength(1)
    expect(native.runCalls).toBe(0)
  } finally {
    physical.resolve()
    vi.useRealTimers()
    await f.dispose()
  }
})

it('a cold exact receipt restores frozen Skill metadata without catalog discovery and survives reopen', async () => {
  const f = await fixture(true, true)
  native.receipts.mockImplementation(async (input) => {
    input.recordConsumption(randomUUID())
    input.recordConsumption(input.unresolvedInputIds[0]!)
  })
  try {
    await f.restart()
    f.flow.setInterests([f.sessionId])
    await f.load()
    await vi.waitFor(() =>
      expect(f.db.conversationRepository.unresolvedSteerInputs(f.saved!.runId)).toHaveLength(0),
    )
    expect(f.db.conversationRepository.findRun(f.saved!.runId)?.nativeOutcome).toBeUndefined()
    expect(f.db.conversationRepository.skillInvocation(f.saved!.request.inputId)).toMatchObject({
      version: 'pact-skills-v1',
      arguments: 'Use exact output',
      selections: [],
      bindings: [frozenSkill],
    })
    await f.restart()
    f.flow.setInterests([f.sessionId])
    await f.load()
    expect(native.receipts).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.nativeInputIdsForRun(f.saved!.runId)).toContain(
      f.saved!.request.inputId,
    )
    expect(native.runCalls).toBe(0)
    expect(native.steer).not.toHaveBeenCalled()
  } finally {
    await f.dispose()
  }
})

it('a queued UUID matching the root Turn is not a consumed Steer receipt', async () => {
  const f = await fixture(false)
  native.steer.mockImplementation(async (input) => {
    input.recordDispatch('possibly_sent')
    throw new Error('No ACK or consumption evidence.')
  })
  try {
    const runId = await f.send()
    const root = f.db.conversationRepository.findRun(runId)!
    const request = f.queue(runId, 'Unconfirmed supplement', root.nativeTurnId)
    expect(request.inputId).toBe(root.nativeTurnId)
    const result = await f.flow.steerQueuedConversationMessage(request)
    expect.soft(result.ok).toBe(false)
    expect.soft(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: request.inputId,
      state: 'unknown',
    })
    expect((await f.load()).messages.map((entry) => entry.message.id)).not.toContain(
      request.inputId,
    )
    expect(f.db.conversationRepository.unresolvedSteerInputs(runId)).toHaveLength(1)
    expect(native.steer).toHaveBeenCalledTimes(1)
    expect(native.runCalls).toBe(1)
  } finally {
    await f.dispose()
  }
})

it.each(['lost ACK', 'rejected result', 'rejected callback', 'accepted ACK'] as const)(
  'the original observer consumption beats a later %s and preserves the frozen native Skill',
  async (ending) => {
    const f = await fixture(false)
    native.skills = [frozenSkill]
    native.steer.mockImplementation(async (input) => {
      input.recordDispatch('possibly_sent')
      const root = native.inputs.get(input.runId)!
      const run = f.db.conversationRepository.findRun(input.runId)!
      root.recordInputConsumption?.(input.inputId, {
        nativeSessionId: run.nativeSessionId!,
        nativeTurnId: run.nativeTurnId!,
        executorId: run.executorId!,
      })
      if (ending === 'lost ACK') throw new Error('The original ACK was lost after incorporation.')
      if (ending === 'rejected callback') input.recordDispatch('rejected')
      if (ending === 'rejected result' || ending === 'rejected callback')
        return { status: 'rejected', reason: 'Contradictory late rejection.' }
      input.recordDispatch('accepted')
      return { status: 'accepted' }
    })
    try {
      const runId = await f.send()
      const request = f.queue(runId, '/format Use exact output')
      const result = await f.flow.steerQueuedConversationMessage(request)
      expect(result.ok).toBe(true)
      expect(f.db.conversationRepository.unresolvedSteerInputs(runId)).toHaveLength(0)
      expect(f.db.conversationRepository.skillInvocation(request.inputId)).toMatchObject({
        version: 'pact-skills-v1',
        arguments: 'Use exact output',
        selections: [],
        bindings: [frozenSkill],
      })
      expect(f.db.conversationRepository.nativeInputIdsForRun(runId)).toContain(request.inputId)
      expect(native.runCalls).toBe(1)
      expect((await f.flow.steerQueuedConversationMessage(request)).ok).toBe(true)
      expect(native.steer).toHaveBeenCalledTimes(1)
    } finally {
      await f.dispose()
    }
  },
)

it('a retained original observer accepts a late exact receipt after foreground completion only', async () => {
  const f = await fixture(false)
  native.skills = [frozenSkill]
  native.steer.mockImplementation(async (input) => {
    input.recordDispatch('possibly_sent')
    throw new Error('ACK unavailable.')
  })
  try {
    const runId = await f.send()
    const request = f.queue(runId, '/format Use exact output')
    expect((await f.flow.steerQueuedConversationMessage(request)).ok).toBe(false)
    native.finishes.get(runId)!()
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
    const root = native.inputs.get(runId)!,
      run = f.db.conversationRepository.findRun(runId)!
    const identity = {
      nativeSessionId: run.nativeSessionId!,
      nativeTurnId: run.nativeTurnId!,
      executorId: run.executorId!,
    }
    expect(() =>
      root.recordInputConsumption?.(request.inputId, { ...identity, nativeTurnId: randomUUID() }),
    ).toThrow(/original execution/u)
    expect(() =>
      root.recordInputConsumption?.(request.inputId, { ...identity, executorId: randomUUID() }),
    ).toThrow(/original execution/u)
    expect(f.db.conversationRepository.unresolvedSteerInputs(runId)).toHaveLength(1)
    root.recordInputConsumption?.(request.inputId, identity)
    root.recordInputConsumption?.(request.inputId, identity)
    expect(f.db.conversationRepository.unresolvedSteerInputs(runId)).toHaveLength(0)
    expect(f.db.conversationRepository.skillInvocation(request.inputId)).toMatchObject({
      version: 'pact-skills-v1',
      arguments: 'Use exact output',
      selections: [],
      bindings: [frozenSkill],
    })
    expect(native.steer).toHaveBeenCalledTimes(1)
    expect(native.runCalls).toBe(1)
  } finally {
    await f.dispose()
  }
})
