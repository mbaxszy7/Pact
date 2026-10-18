import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  collaborationTaskSchema,
  type AgentRun,
  type ConversationSendInput,
  type FrozenSkillInvocation,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'

const settings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const

export const queueBodyHash = (text: string) => createHash('sha256').update(text).digest('hex')
export type QueueRootRun = AgentRun & {
  nativeSessionId: string
  nativeTurnId: string
  executorId: string
  bindingGeneration: number
}

/** Owns only a test database; reopen exercises the real persisted receipt boundary. */
export async function createQueueFixture(filePath = ':memory:', directoryPath = '/fixture/queue') {
  const open = () =>
    PactDatabase.open({ filePath, migrationsFolder: resolve(import.meta.dirname, '../drizzle') })
  let db = await open()
  const sessionId = randomUUID(),
    projectId = randomUUID(),
    owner = randomUUID(),
    nativeSessionId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Queue regression',
    directoryPath,
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Queue regression', createdAt: now },
    settings,
  )
  const repo = () => db.conversationRepository
  const drafts = () => {
    const page = repo().readPage({ scope: 'drafts', sessionId })
    if (page.scope !== 'drafts') throw new Error('Wrong draft page scope')
    return page
  }
  const page = (
    options: Omit<
      Extract<Parameters<ReturnType<typeof repo>['readPage']>[0], { scope: 'messages' }>,
      'scope' | 'sessionId'
    > = {},
  ) => {
    const result = repo().readPage({ scope: 'messages', sessionId, ...options })
    if (result.scope !== 'messages') throw new Error('Wrong message page scope')
    return result
  }
  const root = (task = false): QueueRootRun => {
    const clientMessageId = randomUUID()
    const collaboration = task
      ? collaborationTaskSchema.parse({
          id: randomUUID(),
          sessionId,
          kind: 'plan',
          revision: 0,
          primary: 'codex',
          drafter: 'codex',
          implementer: 'claude',
          reviewer: 'codex',
          task: 'Review scope.',
          taskMessageId: clientMessageId,
          stage: 'draft',
          actor: 'codex',
          status: 'running',
          runId: clientMessageId,
          planVersion: 0,
          discussionRounds: 0,
          discussionHalf: false,
          reviewCycles: 0,
          repairAttempts: 0,
          rereview: false,
          nextCycle: false,
        })
      : undefined
    const { run } = repo().beginRun({
      sessionId,
      clientMessageId,
      content: 'Review scope.',
      expectedCommentsRevision: drafts().commentsRevision,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      ...(collaboration ? { collaboration } : {}),
    })
    const executorId = randomUUID(),
      nativeTurnId = randomUUID()
    repo().recordExecutor(run.id, executorId)
    repo().recordDispatch(run.id, 'accepted', nativeSessionId, executorId)
    repo().applyEvent(sessionId, run.id, {
      type: 'session.started',
      agentId: 'codex',
      nativeSessionId,
    })
    repo().applyEvent(sessionId, run.id, {
      type: 'turn.started',
      agentId: 'codex',
      turnId: nativeTurnId,
    })
    repo().recordNativeEffects(run.id, 'pending')
    repo().applyEvent(sessionId, run.id, {
      type: 'text.delta',
      agentId: 'codex',
      turnId: nativeTurnId,
      outputId: 'answer',
      text: 'Initial response.',
    })
    return {
      ...run,
      nativeSessionId,
      nativeTurnId,
      executorId,
      bindingGeneration: run.bindingGeneration ?? 1,
    }
  }
  const queue = (
    run: QueueRootRun,
    content: string,
    options: Pick<ConversationSendInput, 'skills'> = {},
  ) => {
    const clientMessageId = randomUUID()
    const body = repo().writeConversationInput({ type: 'begin', sessionId, clientMessageId }, owner)
    for (let offset = 0; offset < content.length; offset += 8192)
      repo().writeConversationInput(
        {
          type: 'append',
          sessionId,
          inputId: body.inputId,
          offset,
          text: content.slice(offset, offset + 8192),
        },
        owner,
      )
    repo().writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
    repo().receiveQueuedInput(
      {
        sessionId,
        clientMessageId,
        content: '',
        inputId: body.inputId,
        expectedCommentsRevision: drafts().commentsRevision,
        commentIds: drafts().comments.map((comment) => comment.id),
        route: { type: 'agent', agentId: 'codex' },
        ...options,
      },
      body.inputId,
      'codex',
      owner,
      run.id,
    )
    const state = repo().queueState(sessionId)
    if (!state.input) throw new Error('The message was not queued')
    return {
      sessionId,
      inputId: state.input.id,
      expectedRevision: state.revision,
      operationId: randomUUID(),
    }
  }
  const prepare = (
    run: QueueRootRun,
    request: ReturnType<typeof queue>,
    invocation?: FrozenSkillInvocation,
  ) =>
    repo().prepareQueuedSteer(
      request,
      {
        runId: run.id,
        bindingGeneration: run.bindingGeneration,
        nativeTurnId: run.nativeTurnId,
        executorId: run.executorId,
      },
      invocation,
    )
  const proof = (run: QueueRootRun) => ({
    sessionId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    nativeTurnId: run.nativeTurnId,
    bindingGeneration: run.bindingGeneration,
    executorId: run.executorId,
  })
  const consume = (run: QueueRootRun, content = 'Supplement') => {
    const request = queue(run, content)
    prepare(run, request)
    repo().markQueuedSteerPossiblySent(request.operationId)
    repo().recordQueuedSteerConsumption(proof(run), request.inputId)
    return request
  }
  const finish = (run: QueueRootRun) => {
    repo().applyEvent(sessionId, run.id, {
      type: 'text.completed',
      agentId: 'codex',
      turnId: run.nativeTurnId,
      outputId: 'answer',
      text: 'Full final response.',
    })
    repo().recordNativeEvidence({
      kind: 'ended',
      source: 'live_terminal',
      outcome: 'completed',
      identity: {
        ...proof(run),
        agentId: 'codex',
        requestId: run.id,
        ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
      },
    })
    repo().applyEvent(sessionId, run.id, {
      type: 'turn.completed',
      agentId: 'codex',
      turnId: run.nativeTurnId,
      outcome: 'completed',
    })
    repo().settleKnownNativeEnding(run.id)
  }
  const comment = (run: QueueRootRun, body: string) =>
    repo().saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId: randomUUID(),
      expectedCommentsRevision: drafts().commentsRevision,
      body,
      anchor: {
        type: 'message',
        messageId: run.userMessageId,
        contentHash: queueBodyHash('Review scope.'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 6,
        quote: 'Review',
      },
    })
  return {
    get db() {
      return db
    },
    get repo() {
      return repo()
    },
    sessionId,
    drafts,
    page,
    root,
    queue,
    prepare,
    proof,
    consume,
    finish,
    comment,
    async reopen() {
      if (filePath === ':memory:') throw new Error('Reopen requires an owned file database')
      db.close()
      db = await open()
      repo().recoverCollaborationTasks()
    },
    close() {
      db.close()
    },
  }
}

export type QueueFixture = Awaited<ReturnType<typeof createQueueFixture>>
