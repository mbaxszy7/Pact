import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type {
  ConversationSendInput,
  DefaultSessionSettings,
  RpcResult,
  RuntimePreparation,
} from '@pact/contracts'

import { HandoffSourceUnavailableError, PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation as RuntimePreparationOwner } from '../runtime-preparation/runtime-preparation.js'
import { AgentExecutionError } from './agent-execution-error.js'
import { Conversation } from './conversation.js'

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    preflightPrompt(input: { promptEnvelope: { handoffContext?: Array<{ content: string }> } }) {
      if (
        input.promptEnvelope.handoffContext?.some(
          (entry) => entry.content === 'Reject in preflight',
        )
      )
        throw new AgentExecutionError('response_too_large', 'Codex transport is full.', false)
    }
    async *run(input: { runId: string }) {
      yield { agentId: 'codex', type: 'session.started', nativeSessionId: input.runId }
      yield {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: input.runId,
        outcome: 'completed',
      }
    }
    async dispose() {
      return undefined
    }
  },
}))

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const createdAt = '2026-09-28T00:00:00.000Z'
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

async function fixture() {
  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  const projectId = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Capacity',
    directoryPath: '/fixture',
    kind: 'git',
    createdAt,
  })
  const sessionIds = Array.from({ length: 7 }, () => randomUUID())
  sessionIds.forEach((sessionId, index) =>
    db.sessionRepository.create(
      { id: sessionId, projectId, title: `Session ${index}`, createdAt },
      settings,
    ),
  )
  const preparation = new RuntimePreparationOwner(db.runtimePreparationRepository)
  const conversation = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  return { db, conversation, preparation, sessionIds }
}

function sendInput(sessionId: string): ConversationSendInput {
  return {
    sessionId,
    clientMessageId: randomUUID(),
    content: 'One bounded request',
    expectedCommentsRevision: 0,
    commentIds: [],
  }
}

const unavailable: RpcResult<RuntimePreparation> = {
  ok: false,
  error: { code: 'RUNTIME_UNAVAILABLE', message: 'Fixture stopped preparation.' },
}
const ready: RpcResult<RuntimePreparation> = {
  ok: true,
  value: {
    firstUse: false,
    agents: [
      {
        agentId: 'claude',
        state: 'ready',
        executablePath: '/fixture/claude',
        checkedAt: createdAt,
      },
      {
        agentId: 'codex',
        state: 'ready',
        executablePath: '/fixture/codex',
        checkedAt: createdAt,
      },
    ],
  },
}

describe('App-wide Agent admission', () => {
  it('keeps both ordered @all answers visible under one User Message', async () => {
    const f = await fixture()
    try {
      const sessionId = f.sessionIds[0]!
      const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft page')
      const first = f.db.conversationRepository.beginRun({
        ...sendInput(sessionId),
        expectedCommentsRevision: drafts.commentsRevision,
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        route: { type: 'all' },
      })
      f.db.conversationRepository.applyEvent(sessionId, first.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'primary-turn',
        outputId: 'primary-answer',
        text: 'Primary answer',
      })
      f.db.conversationRepository.applyEvent(sessionId, first.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'primary-turn',
        outcome: 'completed',
      })
      const second = f.db.conversationRepository.beginRoutedContinuation({
        sessionId,
        userMessageId: first.run.userMessageId,
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
        handoffSourceRefs: [],
      })
      f.db.conversationRepository.applyEvent(sessionId, second.run.id, {
        agentId: 'claude',
        type: 'text.completed',
        turnId: 'secondary-turn',
        outputId: 'secondary-answer',
        text: 'Secondary answer',
      })
      f.db.conversationRepository.applyEvent(sessionId, second.run.id, {
        agentId: 'claude',
        type: 'turn.completed',
        turnId: 'secondary-turn',
        outcome: 'completed',
      })
      const page = f.db.conversationRepository.readPage({ scope: 'messages', sessionId })
      if (page.scope !== 'messages') throw new Error('Missing message page')
      const answers = page.messages.filter((item) => item.message.role === 'assistant')
      expect(answers.map((item) => item.message.agentId)).toEqual(['codex', 'claude'])
      expect(
        answers.map((item) => ('content' in item.message ? item.message.content : '')),
      ).toEqual(['Primary answer', 'Secondary answer'])
      expect(
        new Set(answers.map((item) => `${item.message.replyToMessageId}:${item.message.agentId}`))
          .size,
      ).toBe(2)
    } finally {
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('blocks Send and every Comment mutation while Native Session recovery owns the Session', async () => {
    const f = await fixture()
    try {
      const sessionId = f.sessionIds[0]!
      const original = f.db.conversationRepository.beginRun({
        ...sendInput(sessionId),
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      for (const event of [
        { agentId: 'codex', type: 'session.started', nativeSessionId: 'missing-native' },
        { agentId: 'codex', type: 'turn.started', turnId: 'turn-1' },
        { agentId: 'codex', type: 'turn.completed', turnId: 'turn-1', outcome: 'completed' },
      ] as const)
        f.db.conversationRepository.applyEvent(sessionId, original.run.id, event)
      f.db.conversationRepository.markNativeContextsMissing(sessionId, ['codex'])

      await expect(f.conversation.send(sendInput(sessionId))).resolves.toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      await expect(
        f.conversation.saveCommentDraft({
          mode: 'create',
          sessionId,
          commentId: randomUUID(),
          expectedCommentsRevision: 0,
          body: 'Preserve this draft',
          anchor: {
            type: 'message',
            messageId: original.run.userMessageId,
            contentHash: 'not-read-while-locked',
            textBasis: 'markdown-visible-v2',
            startOffset: 0,
            endOffset: 3,
            quote: 'One',
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      expect(
        f.conversation.removeCommentDraft({
          sessionId,
          commentId: randomUUID(),
          expectedCommentsRevision: 0,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
    } finally {
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('refuses an oversized cross-Agent handoff before writing the new User Message', async () => {
    const f = await fixture()
    vi.spyOn(f.preparation, 'inspectReadiness').mockResolvedValue(ready)
    try {
      const sessionId = f.sessionIds[0]!
      const previous = f.db.conversationRepository.beginRun({
        ...sendInput(sessionId),
        content: 'Peer question',
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      for (const event of [
        { agentId: 'claude', type: 'session.started', nativeSessionId: 'claude-native' },
        { agentId: 'claude', type: 'turn.started', turnId: 'peer-turn' },
        {
          agentId: 'claude',
          type: 'text.completed',
          turnId: 'peer-turn',
          outputId: 'peer-answer',
          text: 'Reject in preflight',
        },
        { agentId: 'claude', type: 'turn.completed', turnId: 'peer-turn', outcome: 'completed' },
      ] as const)
        f.db.conversationRepository.applyEvent(sessionId, previous.run.id, event)
      const input = sendInput(sessionId)
      const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Unexpected page scope')
      input.expectedCommentsRevision = drafts.commentsRevision
      const before = f.db.conversationRepository.readPage({ scope: 'messages', sessionId })
      const result = await f.conversation.send(input)
      expect(result).toMatchObject({ ok: false, error: { code: 'CONTEXT_TOO_LARGE' } })
      const after = f.db.conversationRepository.readPage({ scope: 'messages', sessionId })
      expect(after.scope === 'messages' && after.messages.length).toBe(
        before.scope === 'messages' ? before.messages.length : -1,
      )
      if (after.scope !== 'messages') throw new Error('Unexpected page scope')
      expect(after.messages.some((item) => item.message.id === input.clientMessageId)).toBe(false)
    } finally {
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('fails unreadable saved history safely and reads repaired storage through the same owner', async () => {
    const f = await fixture()
    try {
      const sessionId = f.sessionIds[0]!
      const peer = f.db.conversationRepository.beginRun({
        ...sendInput(sessionId),
        content: 'Peer question',
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      for (const event of [
        { agentId: 'claude', type: 'session.started', nativeSessionId: 'claude-native' },
        { agentId: 'claude', type: 'turn.started', turnId: 'peer-turn' },
        {
          agentId: 'claude',
          type: 'text.completed',
          turnId: 'peer-turn',
          outputId: 'peer-answer',
          text: 'The complete saved peer answer.',
        },
        { agentId: 'claude', type: 'turn.completed', turnId: 'peer-turn', outcome: 'completed' },
      ] as const)
        f.db.conversationRepository.applyEvent(sessionId, peer.run.id, event)
      const before = await f.conversation.load({ scope: 'messages', sessionId })
      if (!before.ok || before.value.scope !== 'messages') throw new Error('Saved page unavailable')
      const answer = before.value.messages.find((row) => row.message.role === 'assistant')
      if (!answer) throw new Error('Saved answer unavailable')
      f.db.drizzle.run(sql`UPDATE conversation_messages SET id=CAST(id AS BLOB)
        WHERE id=${answer.message.id} AND session_id=${sessionId}`)
      expect(await f.conversation.load({ scope: 'messages', sessionId })).toEqual({
        ok: false,
        error: { code: 'INTERNAL', message: 'Saved conversation history could not be read.' },
      })
      f.db.drizzle.run(sql`UPDATE conversation_messages SET id=CAST(id AS TEXT)
        WHERE id=CAST(${answer.message.id} AS BLOB) AND session_id=${sessionId}`)
      const repaired = await f.conversation.load({ scope: 'messages', sessionId })
      expect(repaired).toEqual(before)
    } finally {
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('reports an unreadable handoff separately from a size refusal', async () => {
    const f = await fixture()
    vi.spyOn(f.preparation, 'inspectReadiness').mockResolvedValue(ready)
    try {
      const sessionId = f.sessionIds[0]!
      const peer = f.db.conversationRepository.beginRun({
        ...sendInput(sessionId),
        content: 'Peer question',
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      f.db.conversationRepository.applyEvent(sessionId, peer.run.id, {
        agentId: 'claude',
        type: 'session.started',
        nativeSessionId: 'claude-native',
      })
      f.db.conversationRepository.applyEvent(sessionId, peer.run.id, {
        agentId: 'claude',
        type: 'turn.started',
        turnId: 'peer-turn',
      })
      f.db.conversationRepository.applyEvent(sessionId, peer.run.id, {
        agentId: 'claude',
        type: 'turn.completed',
        turnId: 'peer-turn',
        outcome: 'completed',
      })
      vi.spyOn(f.db.conversationRepository, 'readHandoffSources').mockImplementation(() => {
        throw new HandoffSourceUnavailableError('A saved source changed.')
      })
      const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Unexpected page scope')
      const input = { ...sendInput(sessionId), expectedCommentsRevision: drafts.commentsRevision }
      const result = await f.conversation.send(input)
      expect(result).toMatchObject({ ok: false, error: { code: 'CONTEXT_UNAVAILABLE' } })
      const page = f.db.conversationRepository.readPage({ scope: 'messages', sessionId })
      expect(
        page.scope === 'messages' &&
          page.messages.some((item) => item.message.id === input.clientMessageId),
      ).toBe(false)
    } finally {
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('settles a stalled preparation at its deadline without starting a Run later', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
    vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation(() => gate.promise)
    vi.useFakeTimers()
    try {
      const input = sendInput(f.sessionIds[0]!)
      const result = f.conversation.send(input)
      await vi.advanceTimersByTimeAsync(10_000)
      let settled = false
      void result.then(() => {
        settled = true
        return undefined
      })
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
      expect(f.conversation.diagnostics().preparingExecutions).toBe(0)
      gate.resolve(unavailable)
      await Promise.resolve()
      const page = f.db.conversationRepository.readPage({
        scope: 'messages',
        sessionId: input.sessionId,
      })
      expect(page.scope === 'messages' && page.messages.length).toBe(0)
    } finally {
      gate.resolve(unavailable)
      await f.conversation.dispose()
      f.db.close()
      vi.useRealTimers()
    }
  })

  it('reserves five slots before readiness and rejects the sixth without writes', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
    const probe = vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation(() => gate.promise)
    try {
      const requests = f.sessionIds
        .slice(0, 5)
        .map((sessionId) => f.conversation.send(sendInput(sessionId)))
      expect(f.conversation.diagnostics()).toMatchObject({
        preparingExecutions: 5,
        activeExecutions: 0,
      })
      const before = f.db.conversationRepository.diagnostics().eventTransactions
      const refused = await f.conversation.send(sendInput(f.sessionIds[5]!))
      expect(refused).toMatchObject({ ok: false, error: { code: 'AGENT_CAPACITY' } })
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5))
      expect(f.db.conversationRepository.diagnostics().eventTransactions).toBe(before)
      const page = f.db.conversationRepository.readPage({
        scope: 'messages',
        sessionId: f.sessionIds[5]!,
      })
      expect(page.scope === 'messages' && page.messages.length).toBe(0)

      gate.resolve(unavailable)
      await Promise.all(requests)
      expect(f.conversation.diagnostics()).toMatchObject({ preparingExecutions: 0 })
      probe.mockResolvedValue(ready)
      expect((await f.conversation.send(sendInput(f.sessionIds[5]!))).ok).toBe(true)
      expect(probe).toHaveBeenCalledTimes(6)
    } finally {
      gate.resolve(unavailable)
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it('joins one preparing client ID and returns a committed receipt even when full', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
    const probe = vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation(() => gate.promise)
    try {
      const firstInput = sendInput(f.sessionIds[0]!)
      const first = f.conversation.send(firstInput)
      const joined = f.conversation.send({
        ...firstInput,
        expectedCommentsRevision: 99,
        batchId: firstInput.clientMessageId,
        freezeDrafts: true,
      })
      expect(
        await f.conversation.send({ ...firstInput, content: 'Different content' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      const other = f.sessionIds
        .slice(1, 5)
        .map((sessionId) => f.conversation.send(sendInput(sessionId)))
      const committedInput = sendInput(f.sessionIds[5]!)
      const committed = f.db.conversationRepository.beginRun({
        ...committedInput,
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      f.db.conversationRepository.failRun(committed.run.id, 'unknown_delivery', 'Fixture', true)
      const repeated = await f.conversation.send(committedInput)
      expect(repeated).toMatchObject({
        ok: true,
        value: { messages: [{ message: { id: committedInput.clientMessageId } }] },
      })
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5))

      gate.resolve(unavailable)
      const [firstResult, joinedResult] = await Promise.all([first, joined, ...other])
      expect(joinedResult).toEqual(firstResult)
      expect(probe).toHaveBeenCalledTimes(5)
      expect(f.conversation.diagnostics().preparingExecutions).toBe(0)
    } finally {
      gate.resolve(unavailable)
      await f.conversation.dispose()
      f.db.close()
    }
  })

  it.each([
    'freezeDrafts',
    'batchId',
    'returnedInputOperationId',
    'queueReturnOperationId',
  ] as const)(
    'rejects changed %s on a duplicate preparing message without starting another preparation',
    async (field) => {
      const f = await fixture()
      const gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
      const probe = vi
        .spyOn(f.preparation, 'inspectReadiness')
        .mockImplementation(() => gate.promise)
      try {
        const input = { ...sendInput(f.sessionIds[0]!), freezeDrafts: false }
        const first = f.conversation.send(input)
        const changed = f.conversation.send({
          ...input,
          [field]: field === 'freezeDrafts' ? true : randomUUID(),
        })
        await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
        gate.resolve(unavailable)
        const [original, duplicate] = await Promise.all([first, changed])
        expect(original).toEqual(unavailable)
        expect(duplicate).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
        expect(probe).toHaveBeenCalledTimes(1)
        expect(f.conversation.diagnostics().preparingExecutions).toBe(0)
      } finally {
        gate.resolve(unavailable)
        await f.conversation.dispose()
        f.db.close()
      }
    },
  )

  it('does not dispatch replacement work when checking an old Run with all Send slots reserved', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
    vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation(() => gate.promise)
    try {
      const original = f.db.conversationRepository.beginRun({
        ...sendInput(f.sessionIds[5]!),
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      f.db.conversationRepository.failRun(original.run.id, 'unknown_delivery', 'Fixture', true)
      const originalStatus = f.db.conversationRepository.findRun(original.run.id)?.status
      const requests = f.sessionIds
        .slice(0, 5)
        .map((sessionId) => f.conversation.send(sendInput(sessionId)))
      const before = f.db.conversationRepository.diagnostics().eventTransactions
      const refused = await f.conversation.retry({
        runId: original.run.id,
        intent: 'inspect',
      })
      expect(refused.ok).toBe(false)
      expect(f.db.conversationRepository.findRun(original.run.id)?.status).toBe(originalStatus)
      expect(f.db.conversationRepository.diagnostics().eventTransactions).toBe(before)

      gate.resolve(unavailable)
      await Promise.all(requests)
    } finally {
      gate.resolve(unavailable)
      await f.conversation.dispose()
      f.db.close()
    }
  })
})

it('binds a declared field to the original Send while native preparation is still pending', async () => {
  const f = await fixture(),
    gate = Promise.withResolvers<RpcResult<RuntimePreparation>>()
  const probe = vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation(() => gate.promise)
  const input: ConversationSendInput = {
    ...sendInput(f.sessionIds[0]!),
    userInformation: {
      version: 'user-information-v1',
      id: randomUUID(),
      kind: 'user_supplied_value',
      question: 'What launch date should be used?',
      input: 'text',
      options: [],
      state: { status: 'unanswered' },
    },
  }
  try {
    const first = f.conversation.send(input)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const same = f.conversation.send(structuredClone(input))
    expect(
      await f.conversation.send({
        ...input,
        userInformation: { ...input.userInformation!, question: 'A changed question' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(
      await f.conversation.send({
        ...input,
        userInformation: {
          ...input.userInformation!,
          state: { status: 'answered', value: '2027-04-12' },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    gate.resolve(ready)
    const [original, duplicate] = await Promise.all([first, same])
    expect(original).toMatchObject({ ok: true })
    expect(duplicate).toEqual(original)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.read(input.sessionId).runs).toHaveLength(1)
  } finally {
    gate.resolve(unavailable)
    await f.conversation.dispose()
    f.db.close()
  }
})
