import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  DefaultSessionSettings,
  NativeUserInputRequest,
  NativeUserInputResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import { NATIVE_PERMISSION_TIMEOUT_MS } from '@pact/contracts'
import {
  agentEventJournal,
  agentRuns,
  conversationMessages,
  nativeAgentContexts,
  PactDatabase,
} from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  kind: 'form' as 'form' | 'questions' | 'url',
  omitExecutor: false,
  starts: [] as Array<{ runId: string; executorId: string }>,
  replies: [] as NativeUserInputResult[],
  dispatched: 0,
}))

async function* startupRun(
  agentId: RuntimeAgentId,
  executorId: string,
  input: AgentRunInput,
  signal: AbortSignal,
): AsyncIterable<NormalizedAgentEvent> {
  native.starts.push({ runId: input.runId, executorId })
  if (!native.omitExecutor) input.recordExecutor?.(executorId)
  const request: NativeUserInputRequest = {
    kind: native.kind,
    title: 'Startup request',
    message: 'PRIVATE_REQUEST_BODY_TOKEN',
    fields:
      native.kind === 'url'
        ? []
        : [{ id: 'answer', label: 'Answer', type: 'secret', required: true }],
    ...(native.kind === 'url'
      ? { url: 'https://example.invalid/authorize?state=PRIVATE_URL_TOKEN' }
      : {}),
    ...(native.kind === 'form'
      ? {
          requestedSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        }
      : {}),
  }
  if (!input.requestUserInput) throw new Error('Missing public startup callback')
  const answer = await input.requestUserInput(request, signal)
  native.replies.push(answer)
  signal.throwIfAborted()
  const nativeSessionId = `native:${input.runId}`
  input.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
  native.dispatched += 1
  yield { agentId, type: 'session.started', nativeSessionId }
  input.recordDispatch?.('accepted', nativeSessionId, executorId)
  yield { agentId, type: 'turn.started', turnId: `turn:${input.runId}` }
  yield {
    agentId,
    type: 'text.completed',
    turnId: `turn:${input.runId}`,
    outputId: 'answer',
    text: 'Finished the requested task.',
  }
  yield {
    agentId,
    type: 'turn.completed',
    turnId: `turn:${input.runId}`,
    outcome: 'completed',
  }
}

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    readonly executorId = randomUUID()
    run(input: AgentRunInput, signal: AbortSignal) {
      return startupRun(this.id, this.executorId, input, signal)
    }
    async dispose() {
      return undefined
    }
  },
}))
vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: class {
    readonly id = 'claude' as const
    readonly executorId = randomUUID()
    run(input: AgentRunInput, signal: AbortSignal) {
      return startupRun(this.id, this.executorId, input, signal)
    }
    async dispose() {
      return undefined
    }
  },
}))

afterEach(() => {
  vi.useRealTimers()
  native.kind = 'form'
  native.omitExecutor = false
  native.starts = []
  native.replies = []
  native.dispatched = 0
})

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 3,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

async function fixture(agentId: RuntimeAgentId, kind: typeof native.kind) {
  native.kind = kind
  const directory = await mkdtemp(join(tmpdir(), 'pact-native-interactions-'))
  const filePath = join(directory, 'fixture.sqlite')
  let db = await PactDatabase.open({ filePath, migrationsFolder })
  const timestamp = new Date().toISOString()
  const projectId = randomUUID(),
    sessionId = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Startup interactions',
    directoryPath: directory,
    kind: 'directory',
    createdAt: timestamp,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Fixture', createdAt: timestamp },
    { ...settings, primaryAgentId: agentId },
  )
  const createFlow = () => {
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
  const load = async () => {
    const result = await flow.load({ scope: 'messages', sessionId })
    if (!result.ok || result.value.scope !== 'messages') throw new Error('Fixture page missing')
    return result.value
  }
  return {
    sessionId,
    get db() {
      return db
    },
    get flow() {
      return flow
    },
    load,
    async send() {
      return flow.send({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'One startup input task',
        expectedCommentsRevision: 0,
        commentIds: [],
        route: { type: 'agent', agentId },
      })
    },
    async pending() {
      await vi.waitFor(async () =>
        expect((await load()).header.pendingNativeInteractions).toHaveLength(1),
      )
      return (await load()).header.pendingNativeInteractions![0]!
    },
    durableText() {
      return JSON.stringify([
        db.drizzle.select().from(agentEventJournal).all(),
        db.drizzle.select().from(conversationMessages).all(),
        db.drizzle.select().from(agentRuns).all(),
        db.drizzle.select().from(nativeAgentContexts).all(),
      ])
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
        try {
          db.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
  }
}

it.each([
  ['codex', 'form'],
  ['codex', 'questions'],
  ['codex', 'url'],
  ['claude', 'form'],
  ['claude', 'questions'],
  ['claude', 'url'],
] as const)(
  '%s exposes %s before native binding/model dispatch and responds exactly once',
  async (agentId, kind) => {
    const f = await fixture(agentId, kind)
    try {
      expect((await f.send()).ok).toBe(true)
      const pending = await f.pending()
      const identity = { operationId: pending.request.operationId!, requestId: pending.request.id }
      expect(pending).toMatchObject({
        agentId,
        bindingGeneration: 1,
        executorId: native.starts[0]!.executorId,
        request: { kind },
      })
      expect(f.db.conversationRepository.findRun(identity.operationId)).toMatchObject({
        executorId: pending.executorId,
        dispatchPhase: 'not_sent',
        settingsRevision: 1,
      })
      expect((await f.load()).header.nativeContexts ?? []).toEqual([])
      expect(native.dispatched).toBe(0)
      expect(f.flow.readNativeInput(identity)).toMatchObject({
        ok: true,
        value: { kind, message: 'PRIVATE_REQUEST_BODY_TOKEN' },
      })
      expect(JSON.stringify(await f.load())).not.toContain('PRIVATE_REQUEST_BODY_TOKEN')
      expect(
        f.flow.respondNativePermission({
          operationId: identity.operationId,
          permissionId: identity.requestId,
          decision: 'allow',
        }),
      ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(f.flow.readNativeInput({ ...identity, operationId: randomUUID() })).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      /* oxlint-disable vitest/no-conditional-expect -- URL consent and forms have distinct native actions in this provider/kind matrix. */
      if (kind === 'url') {
        expect(f.flow.respondNativeInput({ ...identity, action: 'accept' })).toMatchObject({
          ok: false,
          error: { code: 'VALIDATION' },
        })
        expect(f.flow.confirmNativeInputURL(identity).ok).toBe(true)
        expect(f.flow.confirmNativeInputURL(identity)).toMatchObject({
          ok: false,
          error: { code: 'CONFLICT' },
        })
      } else {
        expect(
          f.flow.respondNativeInput({ ...identity, action: 'accept', values: { unrelated: true } }),
        ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
        expect(
          f.flow.respondNativeInput({
            ...identity,
            action: 'accept',
            values: { answer: 'PRIVATE_VALUE_TOKEN' },
          }).ok,
        ).toBe(true)
        expect(
          f.flow.respondNativeInput({
            ...identity,
            action: 'accept',
            values: { answer: 'PRIVATE_VALUE_TOKEN' },
          }),
        ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      }
      /* oxlint-enable vitest/no-conditional-expect */
      await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
      expect(native.replies).toEqual([
        kind === 'url'
          ? { action: 'accept', values: {} }
          : { action: 'accept', values: { answer: 'PRIVATE_VALUE_TOKEN' } },
      ])
      expect(native.dispatched).toBe(1)
      expect((await f.load()).header.pendingNativeInteractions).toEqual([])
      expect(f.flow.readNativeInput(identity)).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      const durable = f.durableText()
      for (const marker of [
        'PRIVATE_VALUE_TOKEN',
        'PRIVATE_URL_TOKEN',
        'PRIVATE_REQUEST_BODY_TOKEN',
      ])
        expect(durable).not.toContain(marker)
    } finally {
      await f.dispose()
    }
  },
)

it('rejects startup input with no recorded executor without exposing or granting it', async () => {
  native.omitExecutor = true
  const f = await fixture('claude', 'form')
  try {
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
    expect((await f.load()).header.pendingNativeInteractions).toEqual([])
    expect(native.replies).toEqual([])
    expect(native.dispatched).toBe(0)
    expect(native.starts).toHaveLength(1)
  } finally {
    await f.dispose()
  }
})

it('Stop, expiration and file-backed restart invalidate startup inputs without a synthetic response or replay', async () => {
  for (const reason of ['stop', 'expire', 'restart'] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each isolated owner must fully close before the next lifecycle.
    const f = await fixture('codex', 'questions')
    try {
      if (reason === 'expire') vi.useFakeTimers()
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect((await f.send()).ok).toBe(true)
      // oxlint-disable-next-line eslint/no-await-in-loop
      const pending = await f.pending()
      const identity = { operationId: pending.request.operationId!, requestId: pending.request.id }
      const started = native.starts.length
      // oxlint-disable-next-line vitest/no-conditional-expect -- Only the Stop lifecycle has a synchronous control receipt.
      if (reason === 'stop') expect(f.flow.stop({ sessionId: f.sessionId }).ok).toBe(true)
      else if (reason === 'expire') {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await vi.advanceTimersByTimeAsync(NATIVE_PERMISSION_TIMEOUT_MS)
        vi.useRealTimers()
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await f.restart()
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await vi.waitFor(async () =>
        expect((await f.load()).header.pendingNativeInteractions).toEqual([]),
      )
      expect(f.flow.readNativeInput(identity)).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      expect(
        f.flow.respondNativeInput({
          ...identity,
          action: 'accept',
          values: { answer: 'PRIVATE_VALUE_TOKEN' },
        }),
      ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(native.starts).toHaveLength(started)
      expect(native.replies).toEqual([])
      expect(native.dispatched).toBe(0)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each restart variant owns a separate database and must settle before disposal.
      expect((await f.load()).messages.some((item) => item.message.role === 'user')).toBe(true)
    } finally {
      vi.useRealTimers()
      // oxlint-disable-next-line eslint/no-await-in-loop
      await f.dispose()
    }
  }
})
