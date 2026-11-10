import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { AgentRunInput, AgentShutdownSettlement } from '@pact/agent-runtime'
import type { NativeProbeResult, NormalizedAgentEvent } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  mode: 'exact' as 'exact' | 'ack_only' | 'wrong_turn' | 'stored_terminal' | 'drain_first',
  waiting: false,
  runs: 0,
  interrupts: 0,
  closed: false,
  deadline: undefined as number | undefined,
}))

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    readonly executorId = randomUUID()
    async *run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
      native.runs++
      const nativeSessionId = `native:${input.sessionId}`
      input.recordExecutor?.(this.executorId)
      input.recordDispatch?.('accepted', nativeSessionId, this.executorId)
      yield { type: 'session.started', agentId: this.id, nativeSessionId }
      yield { type: 'turn.started', agentId: this.id, turnId: input.runId }
      yield {
        type: 'text.delta',
        agentId: this.id,
        turnId: input.runId,
        outputId: 'answer',
        text: 'Saved prefix.',
      }
      native.waiting = true
      await new Promise<void>((done) => {
        signal.addEventListener('abort', () => done(), { once: true })
        if (signal.aborted) done()
      })
      native.interrupts++
      const drain = () =>
        input.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
          reason: 'native_work_drained',
        })
      if (native.mode === 'drain_first') drain()
      if (native.mode !== 'ack_only') {
        const evidence: NativeProbeResult = {
          kind: 'ended',
          source: native.mode === 'stored_terminal' ? 'stored_terminal' : 'live_terminal',
          outcome: 'interrupted',
          identity: {
            sessionId: input.sessionId,
            agentId: this.id,
            requestId: input.runId,
            runId: input.runId,
            nativeSessionId,
            nativeTurnId: native.mode === 'wrong_turn' ? 'different-turn' : input.runId,
            bindingGeneration: input.bindingGeneration!,
            executorId: this.executorId,
          },
        }
        input.recordNativeEvidence?.(evidence)
        if (native.mode !== 'drain_first') drain()
      }
      input.recordArchivedEvent?.({
        type: 'text.delta',
        agentId: this.id,
        turnId: input.runId,
        outputId: 'answer',
        text: 'Late text must not be appended.',
      })
      input.recordWorkflowPlan?.({
        nativeId: 'late-plan',
        text: 'No new workflow action during shutdown.',
      })
    }
    async dispose(shutdown?: AgentShutdownSettlement) {
      native.deadline = shutdown?.flushDeadlineAt
      if (shutdown) await shutdown.foregroundSettlement
      native.closed = true
    }
  },
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((finish) => finish()))
  native.mode = 'exact'
  native.waiting = false
  native.runs = 0
  native.interrupts = 0
  native.closed = false
  native.deadline = undefined
  vi.restoreAllMocks()
})

async function fixture(expectShutdownFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-shutdown-settlement-'))
  const filePath = join(directory, 'pact.sqlite')
  const migrationsFolder = resolve(
    import.meta.dirname,
    '../../../../../packages/persistence/drizzle',
  )
  let db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Shutdown',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Shutdown', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 3,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          state: 'ready',
          executablePath: '/fixture/codex',
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          state: 'ready',
          executablePath: '/fixture/claude',
          checkedAt: createdAt,
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
  )
  cleanup.push(async () => {
    try {
      if (expectShutdownFailure) await flow.dispose().catch(() => undefined)
      else await flow.dispose()
    } finally {
      db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  const result = await flow.send({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'One explicit request.',
    expectedCommentsRevision: 0,
    commentIds: [],
    route: { type: 'agent', agentId: 'codex' },
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(native.waiting).toBe(true))
  const runId = db.conversationRepository.latestAgentRun(sessionId, 'codex')!.id
  return {
    flow,
    sessionId,
    runId,
    get db() {
      return db
    },
    async reopen() {
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
    },
  }
}

it.each(['exact', 'drain_first'] as const)(
  'persists only exact shutdown terminal and work drain (%s), including cold restart',
  async (mode) => {
    native.mode = mode
    const f = await fixture()
    const plan = vi.spyOn(f.db.conversationRepository, 'recordWorkflowPlan')
    const deadline = Date.now() + 4000
    await f.flow.dispose({ flushDeadlineAt: deadline })
    expect(native.closed).toBe(true)
    expect(native.deadline).toBe(deadline)
    expect(native.interrupts).toBe(1)
    expect(native.runs).toBe(1)
    expect(plan).not.toHaveBeenCalled()
    expect(f.db.conversationRepository.findRun(f.runId)).toMatchObject({
      status: 'interrupted',
      dispatchPhase: 'ended',
      nativeOutcome: 'interrupted',
      nativeEffectsState: 'settled',
      nativeEffectsReason: 'native_work_drained',
    })
    const before = f.db.conversationRepository.read(f.sessionId)
    expect(before.messages.find((m) => m.role === 'assistant')).toMatchObject({
      content: 'Saved prefix.',
      state: 'incomplete',
    })
    await f.reopen()
    expect(f.db.conversationRepository.findRun(f.runId)?.nativeEffectsState).toBe('settled')
    expect(f.db.conversationRepository.read(f.sessionId).messages).toEqual(before.messages)
  },
)

it.each(['ack_only', 'wrong_turn', 'stored_terminal'] as const)(
  'does not convert %s into native settlement during shutdown',
  async (mode) => {
    native.mode = mode
    const f = await fixture()
    await f.flow.dispose({ flushDeadlineAt: Date.now() + 3300 })
    expect(native.closed).toBe(true)
    expect(native.interrupts).toBe(1)
    expect(native.runs).toBe(1)
    expect(['pending', 'unknown']).toContain(
      f.db.conversationRepository.findRun(f.runId)?.nativeEffectsState,
    )
    await f.reopen()
    expect(f.db.conversationRepository.findRun(f.runId)).toMatchObject({
      nativeEffectsState: 'unknown',
    })
    expect(
      f.db.conversationRepository.read(f.sessionId).messages.find((m) => m.role === 'assistant')
        ?.content,
    ).toBe('Saved prefix.')
  },
)

it('preserves an already-running flush deadline after the observation window expires', async () => {
  native.mode = 'ack_only'
  const f = await fixture()
  const deadline = Date.now() + 2900
  await f.flow.dispose({ flushDeadlineAt: deadline })
  expect(native.deadline).toBe(deadline)
  expect(native.closed).toBe(true)
  expect(native.runs).toBe(1)
  await f.reopen()
  expect(f.db.conversationRepository.findRun(f.runId)?.nativeEffectsState).toBe('unknown')
})

it('still aborts and physically closes its owner after a shutdown eligibility read fails', async () => {
  native.mode = 'ack_only'
  const f = await fixture(true)
  const repo = f.db.conversationRepository
  const interrupt = repo.interruptRun.bind(repo)
  vi.spyOn(repo, 'interruptRun').mockImplementation((...args) => {
    const result = interrupt(...args)
    vi.spyOn(repo, 'findRun').mockImplementationOnce(() => {
      throw new Error('Injected shutdown eligibility read failure')
    })
    return result
  })
  const deadline = Date.now() + 4000
  const result = await f.flow
    .dispose({ flushDeadlineAt: deadline })
    .catch((error: unknown) => error)
  expect(native.closed).toBe(true)
  expect(native.interrupts).toBe(1)
  expect(native.deadline).toBe(deadline)
  expect(result).toEqual(
    new Error('Pact could not finish all output commits and resource cleanup before shutdown.'),
  )
})
