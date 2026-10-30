import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type { NormalizedAgentEvent, RuntimeAgentId } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { AgentExecutionError } from './agent-execution-error.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  inputs: [] as Array<{ agentId: RuntimeAgentId; input: AgentRunInput }>,
  active: 0,
  maximumActive: 0,
  answer: 'current primary answer',
  mode: 'complete' as 'complete' | 'fail' | 'wait',
}))

function adapter(agentId: RuntimeAgentId) {
  return class {
    readonly id = agentId
    async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<NormalizedAgentEvent> {
      native.inputs.push({ agentId, input })
      native.active += 1
      native.maximumActive = Math.max(native.maximumActive, native.active)
      try {
        if (native.mode === 'fail')
          throw new AgentExecutionError('protocol_error', 'Fixture failed before dispatch.', false)
        if (native.mode === 'wait') {
          await new Promise<void>((done) => {
            signal.addEventListener('abort', () => done(), { once: true })
            if (signal.aborted) done()
          })
          signal.throwIfAborted()
        }
        const nativeSessionId = input.nativeSessionId ?? `${agentId}-native`
        input.recordDispatch?.('possibly_sent', nativeSessionId)
        yield { agentId, type: 'session.started', nativeSessionId }
        input.recordDispatch?.('accepted', nativeSessionId)
        yield { agentId, type: 'turn.started', turnId: input.runId }
        yield {
          agentId,
          type: 'text.completed',
          turnId: input.runId,
          outputId: 'answer',
          text: native.answer,
        }
        yield { agentId, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
      } finally {
        native.active -= 1
      }
    }
    async dispose() {}
  }
}
vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: adapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: adapter('claude') }))

const owners: Array<{ db: PactDatabase; flow?: Conversation | undefined; directory: string }> = []
afterEach(async () => {
  await Promise.all(
    owners.splice(0).map(async (owner) => {
      await owner.flow?.dispose()
      owner.db.close()
      await rm(owner.directory, { recursive: true, force: true })
    }),
  )
  native.inputs = []
  native.active = 0
  native.maximumActive = 0
  native.answer = 'current primary answer'
  native.mode = 'complete'
})

async function fixture(primaryAgentId: RuntimeAgentId) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-all-'))
  const filePath = join(directory, 'fixture.sqlite')
  const migrationsFolder = resolve(
    import.meta.dirname,
    '../../../../../packages/persistence/drizzle',
  )
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const owner: (typeof owners)[number] = { db, directory }
  owners.push(owner)
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    directoryPath: directory,
    name: 'All',
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'All', createdAt },
    {
      primaryAgentId,
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 3,

      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const openFlow = () => {
    const preparation = new RuntimePreparation(owner.db.runtimePreparationRepository)
    vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: process.execPath,
            checkedAt: createdAt,
          },
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: process.execPath,
            checkedAt: createdAt,
          },
        ],
      },
    })
    owner.flow = new Conversation(
      owner.db.conversationRepository,
      owner.db.sessionRepository,
      owner.db.projectCatalogRepository,
      preparation,
      new ProjectFileReader(owner.db.sessionRepository, owner.db.projectCatalogRepository),
    )
    return owner.flow
  }
  const input = (content: string) => {
    const drafts = owner.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
    return {
      sessionId,
      clientMessageId: randomUUID(),
      content,
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [] as string[],
    }
  }
  const seed = (agentId: RuntimeAgentId, content: string, all = false) =>
    owner.db.conversationRepository.beginRun({
      ...input(content),
      agentId,
      settingsRevision: 1,
      model: null,
      effort: null,
      ...(all ? { route: { type: 'all' as const } } : {}),
    })
  const complete = (runId: string, agentId: RuntimeAgentId, text: string) => {
    for (const event of [
      { agentId, type: 'session.started', nativeSessionId: `${agentId}-native` },
      { agentId, type: 'turn.started', turnId: runId },
      { agentId, type: 'text.completed', turnId: runId, outputId: 'seed', text },
      { agentId, type: 'turn.completed', turnId: runId, outcome: 'completed' },
    ] as const)
      owner.db.conversationRepository.applyEvent(sessionId, runId, event)
  }
  const idle = () =>
    vi.waitFor(() =>
      expect(owner.flow?.diagnostics()).toMatchObject({
        activeExecutions: 0,
        preparingExecutions: 0,
      }),
    )
  return { owner, sessionId, input, seed, complete, openFlow, idle, filePath, migrationsFolder }
}

it.each(['codex', 'claude'] as const)(
  'runs %s first, retains old history and Comments, and defers only the current answer',
  async (primary) => {
    const f = await fixture(primary),
      secondary = primary === 'codex' ? 'claude' : 'codex'
    const previous = f.seed(primary, 'previous task')
    f.complete(previous.run.id, primary, 'previous answer')
    const answer = f.owner.db.conversationRepository
      .read(f.sessionId)
      .messages.find((message) => message.role === 'assistant')!
    const commentId = randomUUID()
    f.owner.db.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId,
      expectedCommentsRevision: f.input('').expectedCommentsRevision,
      body: 'original sent Comment',
      anchor: {
        type: 'message',
        messageId: answer.id,
        contentHash: createHash('sha256').update(answer.content).digest('hex'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: answer.content.length,
        quote: answer.content,
      },
    })
    const flow = f.openFlow()
    const request = {
      ...f.input('same user task'),
      route: { type: 'all' as const },
      commentIds: [commentId],
    }
    expect((await flow.send(request)).ok).toBe(true)
    await f.idle()
    expect(native.inputs.map((entry) => entry.agentId)).toEqual([primary, secondary])
    expect(native.maximumActive).toBe(1)
    const second = native.inputs[1]!.input
    expect(second.promptEnvelope.message).toEqual({
      id: request.clientMessageId,
      content: request.content,
    })
    expect(second.promptEnvelope.comments).toEqual(native.inputs[0]!.input.promptEnvelope.comments)
    expect(second.promptEnvelope.handoffContext?.map((entry) => entry.content)).toEqual([
      'previous task',
      'previous answer',
    ])
    expect(native.inputs.every((entry) => entry.input.peerAssistanceAllowed === false)).toBe(true)
    expect(
      f.owner.db.conversationRepository
        .read(f.sessionId)
        .messages.filter((message) => message.replyToMessageId === request.clientMessageId),
    ).toHaveLength(2)
    expect((await flow.send(request)).ok).toBe(true)
    expect(native.inputs).toHaveLength(2)
    const drafts = f.owner.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f.sessionId,
    })
    if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
    expect(
      (
        await flow.send({
          ...f.input('next ordinary task'),
          route: { type: 'agent', agentId: secondary },
          expectedCommentsRevision: drafts.commentsRevision,
        })
      ).ok,
    ).toBe(true)
    await f.idle()
    expect(
      native.inputs[2]!.input.promptEnvelope.handoffContext?.map((entry) => entry.content),
    ).toEqual(['current primary answer'])
  },
)

it('preserves an exact large original task while excluding a large current primary answer', async () => {
  const f = await fixture('codex'),
    flow = f.openFlow()
  const content = 'input'.repeat(420_000)
  native.answer = 'answer'.repeat(350_000)
  expect((await flow.send({ ...f.input(content), route: { type: 'all' } })).ok).toBe(true)
  await f.idle()
  expect(native.inputs).toHaveLength(2)
  expect(native.inputs[1]!.input.promptEnvelope.message.content).toBe(content)
  expect(native.inputs[1]!.input.promptEnvelope.handoffContext).toBeUndefined()
  expect(
    f.owner.db.conversationRepository.internalMessage(
      native.inputs[0]!.input.promptEnvelope.message.id,
      f.sessionId,
    )?.content,
  ).toBe(content)
})

it('resumes only an uncreated secondary after reopening the database and retains its original boundary', async () => {
  const f = await fixture('claude')
  const previous = f.seed('claude', 'old task')
  f.complete(previous.run.id, 'claude', 'old answer')
  const current = f.seed('claude', 'original task', true)
  f.complete(current.run.id, 'claude', 'withheld current answer')
  const saved = f.owner.db.sessionRepository.find(f.sessionId)!.settings
  f.owner.db.sessionRepository.saveSettings(f.sessionId, {
    ...saved,
    primaryAgentId: 'codex',
    agents: { ...saved.agents, codex: { model: 'changed-after-send', effort: 'high' } },
  })
  f.owner.db.close()
  f.owner.db = await PactDatabase.open({
    filePath: f.filePath,
    migrationsFolder: f.migrationsFolder,
  })
  f.openFlow()
  await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
  await f.idle()
  expect(native.inputs[0]!.agentId).toBe('codex')
  expect(native.inputs[0]!.input.model).toBeNull()
  expect(native.inputs[0]!.input.effort).toBeNull()
  expect(native.inputs[0]!.input.promptEnvelope.message.content).toBe('original task')
  expect(
    native.inputs[0]!.input.promptEnvelope.handoffContext?.map((entry) => entry.content),
  ).toEqual(['old task', 'old answer'])
  await f.owner.flow!.dispose()
  f.owner.flow = undefined
  f.owner.db.close()
  f.owner.db = await PactDatabase.open({
    filePath: f.filePath,
    migrationsFolder: f.migrationsFolder,
  })
  f.openFlow()
  await f.idle()
  expect(native.inputs).toHaveLength(1)
})

it.each(['fail', 'wait'] as const)(
  'does not start the secondary when primary ends by %s/Stop',
  async (mode) => {
    const f = await fixture('codex'),
      flow = f.openFlow()
    native.mode = mode
    expect((await flow.send({ ...f.input('task'), route: { type: 'all' } })).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    const stopped = mode !== 'wait' || flow.stop({ sessionId: f.sessionId }).ok
    expect(stopped).toBe(true)
    await f.idle()
    expect(native.inputs).toHaveLength(1)
    expect(f.owner.db.conversationRepository.pendingRoutedContinuations()).toEqual([])
  },
)
