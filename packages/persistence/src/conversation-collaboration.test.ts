import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  CONVERSATION_PATCH_BYTES,
  conversationPatchSchema,
  collaborationTaskSchema,
  type CollaborationDocument,
  type ConversationSendInput,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  conversationBodyInputs,
  conversationImageAssets,
  conversationInputBatchMembers,
} from './schema/index.js'

const databases: PactDatabase[] = [],
  directories: string[] = []
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const settings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture(filePath = ':memory:', onOpened?: () => void) {
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
  onOpened?.()
  const repo = db.conversationRepository,
    projectId = randomUUID(),
    sessionId = randomUUID(),
    now = new Date().toISOString(),
    messageId = randomUUID(),
    owner = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Collaboration',
    directoryPath: '/fixture',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Collaboration', createdAt: now },
    settings,
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: 'codex',
    reviewer: 'claude',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    task: 'Review cancellation.',
    taskMessageId: messageId,
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  const first = repo.beginRun({
    sessionId,
    clientMessageId: messageId,
    content: '/plan Review cancellation.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: initial,
  })
  const finish = (
    runId = first.run.id,
    result: {
      plan?: string
      verdict?: 'accepted' | 'changes_requested' | 'needs_user' | 'incomplete'
      questions?: import('@pact/contracts').CollaborationQuestions
      inputOutcome?: 'processed' | 'needs_user' | 'incomplete'
      answer?: string
    } = { plan: 'Scope and acceptance.' },
  ) => {
    const run = repo.findRun(runId)!
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: run.agentId,
      nativeSessionId: `fixture-${run.agentId}`,
    })
    repo.applyEvent(sessionId, runId, {
      type: 'turn.started',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
    })
    if (result.plan)
      repo.recordWorkflowPlan(runId, { nativeId: `plan-${runId}`, text: result.plan })
    if (result.verdict)
      repo.recordWorkflowReview(runId, {
        verdict: result.verdict,
        ...(result.questions ? { questions: result.questions } : {}),
      })
    if (result.inputOutcome)
      repo.recordWorkflowInputResult(runId, {
        outcome: result.inputOutcome,
        ...(result.questions ? { questions: result.questions } : {}),
      })
    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outputId: `answer-${runId}`,
      text: result.answer ?? 'Checked current scope.',
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: run.agentId,
        requestId: runId,
        runId,
        nativeSessionId: `fixture-${run.agentId}`,
        nativeTurnId: `turn-${runId}`,
        bindingGeneration: run.bindingGeneration ?? 1,
      },
    })
    repo.recordNativeEffects(runId, 'settled')
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outcome: 'completed',
    })
    repo.recordNativeEffects(runId, 'settled')
  }
  const drafts = () => {
    const value = repo.readPage({ scope: 'drafts', sessionId })
    if (value.scope !== 'drafts') throw Error('Draft page unavailable')
    return value
  }
  const input = (
    content = 'Latest user decision',
    commentIds: string[] = [],
    imageIds: string[] = [],
  ): ConversationSendInput => ({
    sessionId,
    clientMessageId: randomUUID(),
    content,
    commentIds,
    imageIds,
    expectedCommentsRevision: drafts().commentsRevision,
    route: { type: 'primary' },
  })
  const receive = (send = input()) => {
    const body = repo.writeConversationInput(
      { type: 'begin', sessionId, clientMessageId: send.clientMessageId },
      owner,
    )
    for (let offset = 0; offset < send.content.length; offset += 8192)
      repo.writeConversationInput(
        {
          type: 'append',
          sessionId,
          inputId: body.inputId,
          offset,
          text: send.content.slice(offset, offset + 8192),
        },
        owner,
      )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
    const patch = repo.receiveCollaborationInput(
      send,
      body.inputId,
      'codex',
      'immediate_safe_point',
      owner,
    )
    return { send, body, patch }
  }
  const materialize = () => {
    const received = repo.readReceivedInput(sessionId)!,
      task = repo.collaboration(sessionId)!
    const next = repo.workflowReply(task, received.actor)
    next.latestUserMessageId = received.id
    return repo.beginRun({
      sessionId,
      clientMessageId: received.id,
      content: received.content,
      commentIds: received.metadata.commentIds,
      imageIds: received.metadata.imageIds,
      expectedCommentsRevision: drafts().commentsRevision,
      agentId: received.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      receivedInputId: received.id,
      expectedCollaborationRevision: task.revision,
      collaboration: next,
    })
  }
  return {
    db,
    repo,
    sessionId,
    owner,
    initial,
    first,
    now,
    input,
    receive,
    materialize,
    finish,
    drafts,
  }
}

function readDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  source: CollaborationDocument,
): string {
  let offset = 0,
    text = ''
  const run = f.db.drizzle
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, source.id))
    .get()!.sourceRunId!
  for (;;) {
    const page = f.repo.readPage({
      scope: 'collaboration-text',
      sessionId: f.sessionId,
      runId: run,
      document: source,
      offset,
    })
    if (page.scope !== 'collaboration-text') throw Error('Source unavailable')
    text += page.text
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  expect(hash(text)).toBe(source.sha256)
  return text
}

describe('Durable collaboration receipt and phase ownership', () => {
  it('ACKs a body without creating a placeholder User/Run and deduplicates before released temporary input resolution', async () => {
    const f = await fixture()
    f.finish()
    const before = f.repo.read(f.sessionId),
      received = f.receive()
    expect(received.patch.receivedInputIds).toEqual([received.send.clientMessageId])
    expect(f.repo.read(f.sessionId).messages).toEqual(before.messages)
    f.repo.releaseConversationInputs(f.owner)
    expect(
      f.repo.receivedInputReceipt(f.sessionId, received.send.clientMessageId, received.send)
        ?.receivedInputIds,
    ).toEqual([received.send.clientMessageId])
    expect(() =>
      f.repo.receivedInputReceipt(f.sessionId, received.send.clientMessageId, {
        ...received.send,
        route: { type: 'agent', agentId: 'claude' },
      }),
    ).toThrow(/different input/)
    expect(f.repo.readReceivedInput(f.sessionId)?.content).toBe(received.send.content)
  })

  it('materializes received Comments/images exactly once while preserving later draft Comments', async () => {
    const f = await fixture()
    f.finish()
    const anchor = {
      type: 'message' as const,
      messageId: f.first.run.userMessageId,
      contentHash: hash('/plan Review cancellation.'),
      textBasis: 'markdown-visible-v2' as const,
      startOffset: 0,
      endOffset: 5,
      quote: '/plan',
    }
    const oldId = randomUUID(),
      newId = randomUUID(),
      imageId = randomUUID()
    f.repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: oldId,
      expectedCommentsRevision: f.drafts().commentsRevision,
      body: 'Original observation',
      anchor,
    })
    f.repo.beginImage(f.sessionId, imageId, 'capture.png', f.owner)
    f.repo.advanceImage(imageId, f.sessionId, f.owner, 0, 128)
    f.repo.sealImage(
      imageId,
      f.sessionId,
      f.owner,
      {
        id: imageId,
        name: 'capture.png',
        bytes: 128,
        mediaType: 'image/png',
        width: 10,
        height: 10,
        sha256: hash(imageId),
      },
      64,
    )
    const received = f.receive(f.input('Scope update', [oldId], [imageId]))
    f.repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: newId,
      expectedCommentsRevision: f.drafts().commentsRevision,
      body: 'Later unsent observation',
      anchor,
    })
    const started = f.materialize()
    expect(
      f.repo.commentsForMessage(received.send.clientMessageId).map((comment) => comment.id),
    ).toEqual([oldId])
    expect(f.drafts().comments.map((comment) => comment.id)).toEqual([newId])
    expect(f.repo.imagesForMessage(received.send.clientMessageId).map((image) => image.id)).toEqual(
      [imageId],
    )
    expect(f.repo.readReceivedInput(f.sessionId)).toBeUndefined()
    expect(
      f.repo.receivedInputReceipt(f.sessionId, received.send.clientMessageId, received.send),
    ).toBeDefined()
    expect(f.db.drizzle.select().from(collaborationInputs).get()).toMatchObject({
      state: 'materialized',
      materializedRunId: started.run.id,
    })
    expect(
      f.db.drizzle
        .select()
        .from(conversationImageAssets)
        .where(eq(conversationImageAssets.id, imageId))
        .get()?.pendingReceiptId,
    ).toBeNull()
  })

  it('cancelled A releases the active slot and cannot be revived when blocked B continues', async () => {
    const f = await fixture()
    f.finish()
    const a = f.receive()
    f.repo.setReceivedInputState(f.sessionId, 'cancelled', a.send.clientMessageId)
    const b = f.receive(f.input('Only B should run'))
    f.repo.setReceivedInputState(f.sessionId, 'blocked', b.send.clientMessageId)
    expect(() =>
      f.repo.setReceivedInputState(f.sessionId, 'accepted', a.send.clientMessageId),
    ).toThrow(/Cancelled/)
    expect(() =>
      f.repo.setReceivedInputState(f.sessionId, 'blocked', a.send.clientMessageId),
    ).toThrow(/Cancelled/)
    f.repo.setReceivedInputState(f.sessionId, 'accepted', b.send.clientMessageId)
    const queue = f.repo.queueState(f.sessionId)
    expect(queue.input?.state).toBe('paused')
    f.repo.resumeConversationQueue({
      sessionId: f.sessionId,
      inputId: b.send.clientMessageId,
      operationId: randomUUID(),
      expectedRevision: queue.revision,
    })
    f.materialize()
    expect(
      f.db.drizzle
        .select()
        .from(collaborationInputs)
        .where(eq(collaborationInputs.id, a.send.clientMessageId))
        .get()?.state,
    ).toBe('cancelled')
    expect(
      f.repo.read(f.sessionId).messages.some((message) => message.id === a.send.clientMessageId),
    ).toBe(false)
    expect(
      f.repo.read(f.sessionId).messages.filter((message) => message.id === b.send.clientMessageId),
    ).toHaveLength(1)
  })

  it('restart retains received body and attachments, but does not materialize unknown original work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-collaboration-restart-'))
    directories.push(directory)
    const path = join(directory, 'pact.sqlite'),
      f = await fixture(path)
    const received = f.receive(f.input('Durable update '.repeat(1000)))
    f.repo.releaseConversationInputs(f.owner)
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const db = await PactDatabase.open({
      filePath: path,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.push(db)
    db.conversationRepository.recoverCollaborationTasks()
    expect(db.conversationRepository.collaboration(f.sessionId)).toMatchObject({
      status: 'running',
      automation: 'paused',
      pauseReason: 'restart',
    })
    expect(db.conversationRepository.readReceivedInput(f.sessionId)?.content).toBe(
      received.send.content,
    )
    expect(
      db.conversationRepository
        .read(f.sessionId)
        .messages.some((message) => message.id === received.send.clientMessageId),
    ).toBe(false)
    expect(
      db.drizzle
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, received.body.inputId))
        .get()?.pendingReceiptId,
    ).toBe(received.send.clientMessageId)
  })

  it('refunds a proved unsent reservation and preserves possibly delivered counts', async () => {
    const f = await fixture()
    f.finish()
    const next = advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'continue', settings)
    const started = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Review plan',
      commentIds: [],
      expectedCommentsRevision: f.drafts().commentsRevision,
      agentId: next.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: f.repo.collaboration(f.sessionId)!.revision,
      collaboration: next,
    })
    expect(f.repo.collaboration(f.sessionId)?.discussionRounds).toBe(1)
    f.repo.finishCollaboration(started.run.id, false)
    f.repo.failRun(started.run.id, 'protocol_error', 'Proved not dispatched', false)
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      discussionRounds: 0,
      status: 'failed',
    })
    const resumed = advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'resume', settings)
    f.repo.setCollaborationState(resumed)
    const retry = advanceCollaboration(resumed, 'continue', settings)
    expect(retry.discussionRounds).toBe(1)
    const again = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Retry review',
      commentIds: [],
      expectedCommentsRevision: f.drafts().commentsRevision,
      agentId: retry.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: resumed.revision,
      collaboration: retry,
    })
    f.db.drizzle
      .update(agentRuns)
      .set({ dispatchPhase: 'possibly_sent' })
      .where(eq(agentRuns.id, again.run.id))
      .run()
    f.repo.finishCollaboration(again.run.id, false)
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      discussionRounds: 1,
    })
  })

  it('rejects stale phase CAS without partially materializing its received source', async () => {
    const f = await fixture()
    f.finish()
    const received = f.receive()
    const frozen = f.repo.collaboration(f.sessionId)!,
      next = f.repo.workflowReply(frozen, 'codex')
    f.repo.setReceivedInputState(f.sessionId, 'blocked', received.send.clientMessageId)
    f.repo.setReceivedInputState(f.sessionId, 'accepted', received.send.clientMessageId)
    f.repo.resumeConversationQueue({
      sessionId: f.sessionId,
      inputId: received.send.clientMessageId,
      operationId: randomUUID(),
      expectedRevision: f.repo.queueState(f.sessionId).revision,
    })
    expect(() =>
      f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: received.send.clientMessageId,
        content: received.send.content,
        commentIds: [],
        expectedCommentsRevision: f.drafts().commentsRevision,
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        preserveDraftComments: true,
        receivedInputId: received.send.clientMessageId,
        collaboration: next,
      }),
    ).toThrow(/changed/)
    expect(f.repo.readReceivedInput(f.sessionId)?.id).toBe(received.send.clientMessageId)
    expect(
      f.repo
        .read(f.sessionId)
        .messages.some((message) => message.id === received.send.clientMessageId),
    ).toBe(false)
  })

  it('queries active and cancelled receipt projections through their bounded indexes', async () => {
    const f = await fixture()
    f.finish()
    f.receive()
    const current = f.db.drizzle.select().from(collaborationInputs).get()!
    f.db.drizzle
      .insert(collaborationInputs)
      .values(
        Array.from({ length: 1000 }, () => ({
          ...current,
          id: randomUUID(),
          state: 'cancelled' as const,
        })),
      )
      .run()
    const plan = f.db.drizzle.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT id FROM collaboration_inputs WHERE session_id=${f.sessionId} AND state IN ('accepted','blocked')`,
    )
    const history = f.db.drizzle.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT id FROM collaboration_inputs WHERE session_id=${f.sessionId} AND state <> 'materialized' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'collaboration_inputs_pending_session',
    )
    expect(history.map((row) => row.detail).join(' ')).toContain(
      'collaboration_inputs_session_created',
    )
    const ids = f.repo.readReceivedInput(f.sessionId)!.metadata.commentIds
    expect(ids).toHaveLength(0)
    expect(f.db.drizzle.select().from(anchoredComments).all()).toHaveLength(0)
  })
})

it('receives one hundred explicit legacy draft IDs during a running Turn with durable receipt, full Batch and bounded ACK', async () => {
  const f = await fixture()
  const ids: string[] = []
  const anchor = {
    type: 'message' as const,
    messageId: f.first.run.userMessageId,
    contentHash: hash('/plan Review cancellation.'),
    textBasis: 'markdown-visible-v2' as const,
    startOffset: 0,
    endOffset: 5,
    quote: '/plan',
  }
  for (let index = 0; index < 100; index++) {
    const id = randomUUID()
    ids.push(id)
    f.repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: id,
      expectedCommentsRevision: f.drafts().commentsRevision,
      body: `Independent requested check ${index}`,
      anchor,
    })
  }
  const before = f.repo.collaboration(f.sessionId)!
  expect(before.status).toBe('running')
  const revision = f.drafts().commentsRevision
  expect(() =>
    f.receive({
      ...f.input('Rejected stale receipt.', ids),
      expectedCommentsRevision: revision - 1,
    }),
  ).toThrow(/drafts changed/)
  expect(f.drafts().commentsRevision).toBe(revision)
  expect(f.repo.collaboration(f.sessionId)?.revision).toBe(before.revision)
  expect(f.repo.readReceivedInput(f.sessionId)).toBeUndefined()
  const send = f.input('Receive the full running input.', ids)
  const received = f.receive(send)
  expect(conversationPatchSchema.parse(received.patch)).toEqual(received.patch)
  expect(Buffer.byteLength(JSON.stringify(received.patch))).toBeLessThanOrEqual(
    CONVERSATION_PATCH_BYTES,
  )
  expect(received.patch.resync?.drafts).toBe(true)
  expect(received.patch.comments?.removedIds).toEqual([])
  expect(ids.every((id) => !JSON.stringify(received.patch).includes(id))).toBe(true)
  const batch = f.repo.readReceivedInput(f.sessionId)!.inputBatchRef!
  expect(batch.memberCount).toBe(100)
  expect(
    f.db.drizzle
      .select({ id: conversationInputBatchMembers.commentId })
      .from(conversationInputBatchMembers)
      .where(eq(conversationInputBatchMembers.batchId, batch.id))
      .orderBy(conversationInputBatchMembers.ordinal)
      .all()
      .map((member) => member.id),
  ).toEqual(ids)
  expect(
    f.db.drizzle
      .select({ id: anchoredComments.id })
      .from(anchoredComments)
      .where(eq(anchoredComments.pendingReceiptId, send.clientMessageId))
      .orderBy(anchoredComments.position)
      .all()
      .map((comment) => comment.id),
  ).toEqual(ids)
  expect(() => f.repo.readFrozenInputBatch(f.first.run.id, batch.id)).toThrow(
    /outside this Run authorization/,
  )
  const laterId = randomUUID()
  f.repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId: laterId,
    expectedCommentsRevision: f.drafts().commentsRevision,
    body: 'A later unsent draft must remain local.',
    anchor,
  })
  const afterLater = f.repo.collaboration(f.sessionId)!,
    afterRevision = f.drafts().commentsRevision
  const repeated = f.repo.receivedInputReceipt(f.sessionId, send.clientMessageId, send, true)!
  expect(conversationPatchSchema.parse(repeated)).toEqual(repeated)
  expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThanOrEqual(CONVERSATION_PATCH_BYTES)
  expect(repeated.receivedInputIds).toEqual([send.clientMessageId])
  expect(f.repo.collaboration(f.sessionId)?.revision).toBe(afterLater.revision)
  expect(f.drafts().commentsRevision).toBe(afterRevision)
  expect(f.repo.readReceivedInput(f.sessionId)?.inputBatchRef?.id).toBe(batch.id)
  expect(() =>
    f.repo.receivedInputReceipt(f.sessionId, send.clientMessageId, {
      ...send,
      content: 'Another payload.',
    }),
  ).toThrow(/different input/)
  f.finish()
  const materialized = f.materialize()
  expect(materialized.created).toBe(true)
  const readIds: string[] = []
  let cursor = -1
  for (;;) {
    const page = f.repo.readFrozenInputBatch(materialized.run.id, batch.id, cursor)
    expect(page.members.length).toBeLessThanOrEqual(24)
    readIds.push(...page.members.map((member) => member.commentId))
    if (!page.hasMore) break
    cursor = page.nextOrdinal
  }
  expect(readIds).toEqual(ids)
  expect(f.repo.commentsForMessage(send.clientMessageId).map((comment) => comment.id)).toEqual(ids)
  expect(f.drafts().comments.map((comment) => comment.id)).toEqual([laterId])
  expect(f.repo.read(f.sessionId).runs).toHaveLength(2)
  expect(
    f.repo.receivedInputReceipt(f.sessionId, send.clientMessageId, send)?.receivedInputIds,
  ).toEqual([send.clientMessageId])
})

function advance(
  f: Awaited<ReturnType<typeof fixture>>,
  action: 'continue' | 'execute' | 'repair' | 'respond' = 'continue',
) {
  const current = f.repo.collaboration(f.sessionId)!
  const next = advanceCollaboration(current, action, settings)
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Continue authorized work.',
    commentIds: [],
    expectedCommentsRevision: f.drafts().commentsRevision,
    agentId: next.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: current.revision,
    collaboration: next,
  }).run
}

it('binds native plan/review facts to their actual actor and exact version, then requires explicit implementation', async () => {
  const f = await fixture()
  f.finish()
  const planned = f.repo.collaboration(f.sessionId)!
  expect(planned).toMatchObject({
    status: 'waiting',
    nextStage: 'plan_review',
    planVersion: 1,
    planInputSequence: 1,
  })
  expect(readDocument(f, planned.planReference!.document)).toBe('Scope and acceptance.')
  const review = advance(f)
  expect(() =>
    f.repo.recordWorkflowPlan(review.id, { nativeId: 'foreign', text: 'Foreign plan' }),
  ).toThrow(/plan author/)
  f.finish(review.id, { verdict: 'accepted' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'ready',
    review: { actor: 'claude', verdict: 'accepted', planReference: planned.planReference },
  })
  expect(() => advance(f)).toThrow(/no next/)
  const work = advance(f, 'execute')
  expect(work.agentId).toBe('codex')
  f.finish(work.id, { answer: 'Implemented cancellation.' })
  const codeReview = advance(f)
  f.finish(codeReview.id, { verdict: 'accepted' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'complete',
    codeRunId: work.id,
    reviewCycles: 1,
    review: { stage: 'code_review' },
  })
})

it('keeps the full natural plan and report in handoff/rebuild sources without an envelope', async () => {
  const f = await fixture()
  const full = 'Complete scope with ownership and cleanup.\n'.repeat(5000)
  f.finish(undefined, { plan: full, answer: 'Natural response.' })
  const plan = f.repo.collaboration(f.sessionId)!.planReference!
  expect(plan.document.bytes).toBe(Buffer.byteLength(full))
  expect(readDocument(f, plan.document)).toBe(full)
  const sources = []
  for await (const source of f.repo.readHandoffSources(
    f.sessionId,
    'claude',
    -1,
    100,
    new AbortController().signal,
  ))
    sources.push(source)
  const response = sources.find((source) => source.speaker === 'codex')!
  expect(response.contextVersion).toBe('native_workflow_v1')
  expect(response.content).toContain(plan.document.id)
  expect(f.repo.internalMessage(response.messageId, f.sessionId)?.content).toBe('Natural response.')
  const chunks = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
  ))
    chunks.push(chunk)
  expect(
    chunks
      .filter((chunk) => chunk.kind === 'message')
      .map((chunk) => chunk.content)
      .join(''),
  ).toContain(plan.document.id)
})

it('preserves paused native completion and applies the original plan once', async () => {
  const f = await fixture()
  f.repo.setCollaborationState(
    advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'pause', settings),
  )
  f.finish()
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({ automation: 'paused', planVersion: 1, status: 'waiting' })
  f.repo.finishCollaboration(f.first.run.id, true)
  expect(f.repo.collaboration(f.sessionId)).toEqual(settled)
  expect(() =>
    f.repo.recordWorkflowPlan(f.first.run.id, { nativeId: 'replacement', text: 'Changed' }),
  ).toThrow(/cannot be replaced/)
  expect(f.repo.findRun(f.first.run.id)?.responseMessageId).toBe(settled.sourceMessageId)
})

it('does not settle stale planning over a newer acknowledged input', async () => {
  const f = await fixture(),
    received = f.receive()
  f.finish()
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planVersion: 0,
    inputSequence: 2,
    automation: 'paused',
    inputProcessing: { pending: { inputId: received.send.clientMessageId, inputSequence: 2 } },
  })
  const reply = f.materialize()
  f.finish(reply.run.id, { plan: 'Updated plan respecting the new decision.' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planVersion: 1,
    planInputSequence: 2,
    automation: 'paused',
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.pending).toBeUndefined()
})

it.each(['missing', 'conflicting'] as const)(
  'keeps %s native review conclusions from accepting the plan',
  async (kind) => {
    const f = await fixture()
    f.finish()
    const run = advance(f)
    if (kind === 'conflicting') {
      f.repo.recordWorkflowReview(run.id, { verdict: 'accepted' })
      f.repo.recordWorkflowReview(run.id, { verdict: 'changes_requested' })
    }
    f.finish(run.id, { answer: 'The natural report is not acceptance authority.' })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      status: 'failed',
      automation: 'paused',
      review: { verdict: 'incomplete' },
    })
    expect(() => advance(f, 'execute')).toThrow(/Continue collaboration/)
  },
)

it('persists structured questions with host IDs and requires a settled native reply before resuming', async () => {
  const f = await fixture()
  f.finish()
  const review = advance(f)
  const questions = [
    {
      prompt: 'Which scope?',
      selection: 'single' as const,
      options: [{ label: 'Current' }, { label: 'All' }],
    },
  ]
  f.finish(review.id, { verdict: 'needs_user', questions })
  const decision = f.repo.collaboration(f.sessionId)!.inputProcessing!.decision!
  expect(decision).toMatchObject({
    runId: review.id,
    actor: 'claude',
    questions: [
      {
        id: 'q1',
        prompt: 'Which scope?',
        options: [
          { id: 'o1', label: 'Current' },
          { id: 'o2', label: 'All' },
        ],
      },
    ],
  })
  expect(() =>
    advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'resume', settings),
  ).toThrow(/Reply/)
  f.receive(decisionInput(f, 'Only current scope.'))
  const reply = f.materialize()
  f.finish(reply.run.id, { plan: 'Current scope only.' })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled.inputProcessing?.decision).toBeUndefined()
  expect(settled.inputProcessing?.pending).toBeUndefined()
  expect(settled).toMatchObject({ automation: 'paused', planInputSequence: 2 })
  expect(advanceCollaboration(settled, 'resume', settings)).toMatchObject({
    automation: 'active',
    nextStage: 'plan_review',
  })
})

it('retains unresolved questions when a reply fails to provide its authenticated plan', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Choose scope', selection: 'single' }],
  })
  f.receive(decisionInput(f, 'Current scope.'))
  const reply = f.materialize()
  f.finish(reply.run.id, { answer: 'Acknowledged, without a native plan.' })
  const current = f.repo.collaboration(f.sessionId)!
  expect(current.inputProcessing?.decision).toMatchObject({ runId: reply.run.id, inputSequence: 2 })
  expect(current.inputProcessing?.pending).toBeUndefined()
  expect(() => advanceCollaboration(current, 'resume', settings)).toThrow(/Reply/)
})

it('cold-reads exact documents and pauses automation without losing acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-workflow-cold-'))
  directories.push(directory)
  const filePath = join(directory, 'pact.sqlite'),
    f = await fixture(filePath)
  f.finish(undefined, { plan: 'Durable plan.\n'.repeat(9000) })
  const review = advance(f)
  f.finish(review.id, { verdict: 'accepted' })
  const before = f.repo.collaboration(f.sessionId)!
  f.db.close()
  databases.splice(databases.indexOf(f.db), 1)
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
  db.conversationRepository.recoverCollaborationTasks()
  const cold = db.conversationRepository.collaboration(f.sessionId)!
  expect(cold).toMatchObject({
    status: 'ready',
    automation: 'paused',
    planReference: before.planReference,
    review: before.review,
  })
  expect(
    readDocument({ ...f, db, repo: db.conversationRepository }, cold.planReference!.document),
  ).toBe('Durable plan.\n'.repeat(9000))
})

function decisionInput(
  f: Awaited<ReturnType<typeof fixture>>,
  content: string,
): ConversationSendInput {
  const current = f.repo.collaboration(f.sessionId)!,
    decision = current.inputProcessing!.decision!
  return {
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content,
    commentIds: [],
    freezeDrafts: false,
    expectedCommentsRevision: f.drafts().commentsRevision,
    replyToDecision: {
      taskId: current.id,
      runId: decision.runId,
      decisionInputSequence: decision.inputSequence,
      expectedInputSequence: current.inputSequence,
    },
  }
}

it.each(['identical', 'changed', 'retained'] as const)(
  'settles %s native plan updates without inventing a version or reusing old acceptance',
  async (kind) => {
    const f = await fixture()
    f.finish()
    const original = f.repo.collaboration(f.sessionId)!.planReference!
    const review = advance(f)
    f.finish(review.id, { verdict: 'accepted' })
    f.receive()
    const reply = f.materialize()
    if (kind === 'retained')
      f.repo.recordWorkflowPlanRetained(reply.run.id, {
        nativeId: 'retained-source',
        sha256: original.document.sha256,
        bytes: original.document.bytes,
        chars: original.document.chars,
      })
    f.finish(
      reply.run.id,
      kind === 'retained'
        ? { answer: 'The same plan remains appropriate.' }
        : { plan: kind === 'changed' ? 'Changed exact scope.' : 'Scope and acceptance.' },
    )
    const current = f.repo.collaboration(f.sessionId)!
    expect(current.planVersion).toBe(kind === 'changed' ? 2 : 1)
    expect(current.planInputSequence).toBe(2)
    expect(current.inputProcessing?.pending).toBeUndefined()
    expect(current.automation).toBe('paused')
    expect(current.review?.inputSequence).toBe(1)
    const resumed = advanceCollaboration(current, 'resume', settings)
    expect(resumed.nextStage).toBe('plan_review')
    expect(() => advanceCollaboration(resumed, 'execute', settings)).toThrow(/not been accepted/)
    expect(current.planReference?.sourceRunId).toBe(
      kind === 'retained' ? original.sourceRunId : reply.run.id,
    )
  },
)

it('records capture failure, restores the original native source once, and never resends user input', async () => {
  const f = await fixture()
  f.repo.recordWorkflowPlanUnavailable(f.first.run.id)
  f.finish(undefined, { answer: 'The native plan was saved outside the response.' })
  const failed = f.repo.collaboration(f.sessionId)!,
    run = f.repo.findRun(f.first.run.id)!
  expect(failed).toMatchObject({ status: 'failed', planVersion: 0, automation: 'paused' })
  expect(f.repo.needsWorkflowPlanRecovery(run.id)).toBe(true)
  f.repo.recordWorkflowPlan(run.id, {
    nativeId: 'saved-plan',
    text: 'Recovered exact native plan.',
  })
  f.repo.reconcileCompletedCollaboration(run.id)
  const recovered = f.repo.collaboration(f.sessionId)!
  expect(recovered).toMatchObject({
    status: 'waiting',
    automation: 'paused',
    planVersion: 1,
    nextStage: 'plan_review',
  })
  expect(readDocument(f, recovered.planReference!.document)).toBe('Recovered exact native plan.')
  expect(f.repo.findRun(run.id)?.responseMessageId).toBe(run.responseMessageId)
  expect(f.repo.read(f.sessionId).runs).toHaveLength(1)
  f.repo.reconcileCompletedCollaboration(run.id)
  expect(f.repo.collaboration(f.sessionId)).toEqual(recovered)
})

it('does not let late plan recovery authorize a newer acknowledged input', async () => {
  const f = await fixture()
  f.repo.recordWorkflowPlanUnavailable(f.first.run.id)
  f.finish(undefined, { answer: 'Saved native source.' })
  f.receive()
  const before = f.repo.collaboration(f.sessionId)!
  f.repo.recordWorkflowPlan(f.first.run.id, { nativeId: 'late-plan', text: 'Previous scope only.' })
  f.repo.reconcileCompletedCollaboration(f.first.run.id)
  expect(f.repo.collaboration(f.sessionId)).toEqual(before)
  expect(before.planVersion).toBe(0)
  expect(before.inputProcessing?.pending).toBeDefined()
})

it('rejects stale question-card identities and mixed composer drafts atomically', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Which scope?', selection: 'single' }],
  })
  const valid = decisionInput(f, 'Current scope.'),
    before = f.repo.collaboration(f.sessionId)!,
    messageCount = f.repo.read(f.sessionId).messages.length
  const candidates = [
    { ...valid, replyToDecision: { ...valid.replyToDecision!, runId: randomUUID() } },
    { ...valid, replyToDecision: { ...valid.replyToDecision!, expectedInputSequence: 0 } },
    { ...valid, freezeDrafts: true },
    { ...valid, route: { type: 'primary' as const } },
    { ...valid, content: '/build execute now' },
  ]
  for (const send of candidates) {
    expect(() => f.receive({ ...send, clientMessageId: randomUUID() })).toThrow(
      /questions changed|card answers/,
    )
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
    expect(f.repo.readReceivedInput(f.sessionId)).toBeUndefined()
    expect(f.repo.read(f.sessionId).messages).toHaveLength(messageCount)
  }
  const accepted = f.receive(valid)
  expect(accepted.patch.receivedInputIds).toEqual([valid.clientMessageId])
  expect(() => f.receive({ ...valid, clientMessageId: randomUUID() })).toThrow(
    /One message is already waiting/,
  )
})

it('rejects changed review questions as conflicting rather than silently replacing the decision', async () => {
  const f = await fixture()
  f.finish()
  const run = advance(f)
  f.repo.recordWorkflowReview(run.id, {
    verdict: 'needs_user',
    questions: [{ prompt: 'First decision?', selection: 'single' }],
  })
  f.repo.recordWorkflowReview(run.id, {
    verdict: 'needs_user',
    questions: [{ prompt: 'Different decision?', selection: 'single' }],
  })
  f.finish(run.id, { answer: 'Review source.' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'failed',
    review: { verdict: 'incomplete' },
  })
  expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.decision).toBeUndefined()
})
