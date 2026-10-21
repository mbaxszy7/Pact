import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AgentNativeProbeInput } from '@pact/agent-runtime'
import type { DefaultSessionSettings, RuntimePreparation as RuntimeSnapshot } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const lifecycle = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  disposedWhileRunning: 0,
  disposedWhileInspecting: 0,
  live: 0,
  highWater: 0,
}))

const inspections = vi.hoisted(() => ({
  enabled: false,
  pending: [] as Array<{
    nativeSessionId: string
    resolve: (value: 'available' | 'missing') => void
  }>,
}))

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    private running = false
    private inspecting = false

    constructor() {
      lifecycle.created += 1
      lifecycle.live += 1
      lifecycle.highWater = Math.max(lifecycle.highWater, lifecycle.live)
    }

    async *run(input: { runId: string }) {
      this.running = true
      try {
        yield { agentId: 'codex', type: 'session.started', nativeSessionId: input.runId }
        yield {
          agentId: 'codex',
          type: 'text.completed',
          turnId: input.runId,
          outputId: `${input.runId}:answer`,
          text: 'Completed fixture answer',
        }
        yield {
          agentId: 'codex',
          type: 'turn.completed',
          turnId: input.runId,
          outcome: 'completed',
        }
      } finally {
        this.running = false
      }
    }

    async probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal) {
      if (!inspections.enabled) return probeEvidence(input, 'available')
      this.inspecting = true
      try {
        return probeEvidence(input, await inspectNativeProbe(input, signal))
      } finally {
        this.inspecting = false
      }
    }

    async dispose() {
      if (this.running) lifecycle.disposedWhileRunning += 1
      if (this.inspecting) lifecycle.disposedWhileInspecting += 1
      lifecycle.disposed += 1
      lifecycle.live -= 1
    }
  },
}))

vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: class {
    readonly id = 'claude' as const
    private inspecting = false

    constructor() {
      lifecycle.created += 1
      lifecycle.live += 1
      lifecycle.highWater = Math.max(lifecycle.highWater, lifecycle.live)
    }

    async probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal) {
      if (!inspections.enabled) return probeEvidence(input, 'available')
      this.inspecting = true
      try {
        return probeEvidence(input, await inspectNativeProbe(input, signal))
      } finally {
        this.inspecting = false
      }
    }

    async dispose() {
      if (this.inspecting) lifecycle.disposedWhileInspecting += 1
      lifecycle.disposed += 1
      lifecycle.live -= 1
    }
  },
}))

function probeEvidence(input: AgentNativeProbeInput, available: 'available' | 'missing') {
  const identity = {
    sessionId: input.sessionId,
    agentId: input.agentId,
    runId: input.runId,
    requestId: input.requestId,
    nativeSessionId: input.nativeSessionId,
    nativeTurnId: input.nativeTurnId,
    bindingGeneration: input.bindingGeneration,
    executorId: input.executorId,
  }
  return available === 'missing'
    ? { kind: 'missing' as const, source: 'native_error' as const, identity }
    : {
        kind: 'ended' as const,
        source: 'stored_terminal' as const,
        outcome: 'completed' as const,
        identity,
      }
}

function inspectNativeProbe(input: AgentNativeProbeInput, signal: AbortSignal) {
  return new Promise<'available' | 'missing'>((settle, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Inspection cancelled'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    inspections.pending.push({
      nativeSessionId: input.nativeSessionId,
      resolve: (value) => {
        signal.removeEventListener('abort', abort)
        settle(value)
      },
    })
  })
}

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

describe('bounded Conversation Adapter lifetime', () => {
  it('returns every owned Adapter after 1,000 distinct Sessions', async () => {
    lifecycle.created = 0
    lifecycle.disposed = 0
    lifecycle.disposedWhileRunning = 0
    lifecycle.disposedWhileInspecting = 0
    lifecycle.live = 0
    lifecycle.highWater = 0
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const projectId = randomUUID()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Adapter capacity',
      directoryPath: '/fixture',
      kind: 'git',
      createdAt: '2026-09-28T00:00:00.000Z',
    })
    const preparation = new RuntimePreparation(db.runtimePreparationRepository)
    vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/fixture/claude',
            checkedAt: '2026-09-28T00:00:00.000Z',
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/fixture/codex',
            checkedAt: '2026-09-28T00:00:00.000Z',
          },
        ],
      } satisfies RuntimeSnapshot,
    })
    vi.spyOn(preparation, 'findRecoveryExecutable').mockImplementation(
      async (agentId) => `/fixture/${agentId}`,
    )
    const conversation = new Conversation(
      db.conversationRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      preparation,
      new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
    )
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const sessionId = randomUUID()
        db.sessionRepository.create(
          {
            id: sessionId,
            projectId,
            title: `Session ${index}`,
            createdAt: '2026-09-28T00:00:00.000Z',
          },
          settings,
        )
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each Run must release its protected slot before the next acquisition.
        const sent = await conversation.send({
          sessionId,
          clientMessageId: randomUUID(),
          content: 'Finish this Run.',
          expectedCommentsRevision: 0,
          commentIds: [],
        })
        expect(sent.ok).toBe(true)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Terminal settlement is the measured lifecycle boundary.
        await vi.waitFor(() => expect(conversation.diagnostics().activeExecutions).toBe(0), {
          interval: 1,
        })
        expect(conversation.diagnostics().adapterSlots).toBeLessThanOrEqual(5)
      }
    } finally {
      await conversation.dispose()
      db.close()
    }
    expect(conversation.diagnostics()).toMatchObject({
      activeExecutions: 0,
      preparingExecutions: 0,
      adapterSlots: 0,
    })
    expect(lifecycle.created).toBe(1_000)
    expect(lifecycle.disposed).toBe(1_000)
    expect(lifecycle.disposedWhileRunning).toBe(0)
    expect(lifecycle.disposedWhileInspecting).toBe(0)
    expect(lifecycle.highWater).toBeLessThanOrEqual(5)
    expect(lifecycle.live).toBe(0)
  }, 120_000)

  it('does not reclaim an Adapter from any of five concurrent Native Session checks', async () => {
    lifecycle.created = 0
    lifecycle.disposed = 0
    lifecycle.disposedWhileRunning = 0
    lifecycle.disposedWhileInspecting = 0
    lifecycle.live = 0
    lifecycle.highWater = 0
    inspections.enabled = false
    inspections.pending = []
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const projectId = randomUUID()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Inspection capacity',
      directoryPath: '/fixture',
      kind: 'git',
      createdAt: '2026-09-29T00:00:00.000Z',
    })
    const sessionIds = Array.from({ length: 5 }, () => randomUUID())
    const preparation = new RuntimePreparation(db.runtimePreparationRepository)
    vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/fixture/claude',
            checkedAt: '2026-09-29T00:00:00.000Z',
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/fixture/codex',
            checkedAt: '2026-09-29T00:00:00.000Z',
          },
        ],
      } satisfies RuntimeSnapshot,
    })
    vi.spyOn(preparation, 'findRecoveryExecutable').mockImplementation(
      async (agentId) => `/fixture/${agentId}`,
    )
    for (const sessionId of sessionIds) {
      db.sessionRepository.create(
        {
          id: sessionId,
          projectId,
          title: `Session ${sessionId}`,
          createdAt: '2026-09-29T00:00:00.000Z',
        },
        settings,
      )
      for (const agentId of ['codex', 'claude'] as const) {
        const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
        if (drafts.scope !== 'drafts') throw new Error('Missing draft page')
        const started = db.conversationRepository.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: `${agentId} establishes its Native Session`,
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
          agentId,
          settingsRevision: 1,
          model: null,
          effort: null,
        })
        db.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId,
          type: 'session.started',
          nativeSessionId: `${agentId}:${sessionId}`,
        })
        db.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId,
          type: 'turn.started',
          turnId: `${agentId}:turn:${sessionId}`,
        })
        db.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId,
          type: 'turn.completed',
          turnId: `${agentId}:turn:${sessionId}`,
          outcome: 'completed',
        })
      }
    }
    const conversation = new Conversation(
      db.conversationRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      preparation,
      new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
    )
    inspections.enabled = true
    try {
      const checks = sessionIds.map((sessionId) =>
        conversation.retry({
          sessionId,
          agentId: 'codex',
          runId: db.conversationRepository.nativeContext(sessionId, 'codex')!.lastRunId!,
          intent: 'inspect',
        }),
      )
      await vi.waitFor(() => expect(inspections.pending).toHaveLength(5))
      const duplicate = conversation.retry({
        sessionId: sessionIds[0]!,
        agentId: 'codex',
        runId: db.conversationRepository.nativeContext(sessionIds[0]!, 'codex')!.lastRunId!,
        intent: 'inspect',
      })
      await Promise.resolve()
      expect(inspections.pending).toHaveLength(5)
      const lastSessionId = sessionIds.at(-1)!
      for (const pending of inspections.pending) {
        pending.resolve(
          pending.nativeSessionId === `codex:${lastSessionId}` ? 'missing' : 'available',
        )
      }
      const results = await Promise.all(checks)
      expect(await duplicate).toEqual(results[0])
      expect(results.at(-1)).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      expect(conversation.diagnostics().adapterSlots).toBe(5)
      expect(lifecycle.disposedWhileInspecting).toBe(0)
      expect(inspections.pending).toHaveLength(5)
      for (const sessionId of sessionIds.slice(0, -1))
        expect(db.conversationRepository.nativeContext(sessionId, 'codex')?.continuationState).toBe(
          'ready',
        )
      expect(
        db.conversationRepository.nativeContext(lastSessionId, 'codex')?.continuationState,
      ).toBe('recovery_required')
      const runId = db.conversationRepository.nativeContext(lastSessionId, 'codex')!.lastRunId!
      const outcomeBeforeTimeout = db.conversationRepository.findRun(runId)?.nativeOutcome
      vi.useFakeTimers()
      const stalled = conversation.retry({ runId, intent: 'inspect' })
      await vi.waitFor(() => expect(inspections.pending).toHaveLength(6))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await stalled).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      expect(
        db.conversationRepository.nativeContext(lastSessionId, 'codex')?.continuationState,
      ).toBe('recovery_required')
      expect(db.conversationRepository.findRun(runId)?.nativeOutcome).toBe(outcomeBeforeTimeout)
      vi.useRealTimers()
      const resumed = conversation.retry({ runId, intent: 'inspect' })
      await vi.waitFor(() => expect(inspections.pending).toHaveLength(7))
      inspections.pending[6]!.resolve('available')
      expect((await resumed).ok).toBe(true)
      expect(
        db.conversationRepository.nativeContext(lastSessionId, 'codex')?.continuationState,
      ).toBe('ready')
      await vi.waitFor(() => expect(conversation.diagnostics().activeExecutions).toBe(0))
    } finally {
      vi.useRealTimers()
      inspections.enabled = false
      for (const pending of inspections.pending) pending.resolve('available')
      await conversation.dispose()
      db.close()
    }
    expect(lifecycle.disposedWhileInspecting).toBe(0)
    expect(lifecycle.live).toBe(0)
    expect(lifecycle.highWater).toBeLessThanOrEqual(5)
  }, 120_000)
})
