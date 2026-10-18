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
  collaborationEnvelopeSchema,
  type CollaborationDocument,
  prepareCollaborationSupplement,
  type CollaborationResult,
  type CollaborationTodoDelta,
  type ConversationSendInput,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  collaborationTurns,
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
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const
const fixturePlan = 'Scope and acceptance.'
const checked: CollaborationResult = {
  submission: 'plan_submission',
  outcome: 'complete',
  summary: 'Current plan checked.',
  plan: fixturePlan,
  todoDeltas: [],
  inputResponses: [],
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const todoDelta = (
  todoId: string,
  fields: Partial<CollaborationTodoDelta> = {},
): CollaborationTodoDelta => ({
  todoId,
  expectedRevision: 0,
  operation: 'create',
  kind: 'opinion',
  title: 'Release resources',
  detail: 'Pending work must be released.',
  recommendation: null,
  evidence: null,
  question: null,
  resolutionKind: null,
  reason: '',
  mergeTargetId: null,
  userSourceIds: [],
  evidenceRefs: [],
  ...fields,
})

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
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
    primary: 'codex',
    drafter: 'codex',
    implementer: 'claude',
    reviewer: 'codex',
    task: 'Review cancellation.',
    taskMessageId: messageId,
    stage: 'draft',
    actor: 'codex',
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    discussionHalf: false,
    reviewCycles: 0,
    repairAttempts: 0,
    rereview: false,
    nextCycle: false,
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
  const reportFor = (
    runId = first.run.id,
    report: CollaborationResult = checked,
    respondToInputs = true,
  ): CollaborationResult => {
    const auth = repo.collaborationTurnAuthorization(runId)!
    const normalized: CollaborationResult = { ...report, submission: auth.duty }
    if (auth.duty === 'plan_review' || auth.duty === 'code_review' || auth.duty === 'stage_result')
      normalized.plan = undefined
    if (auth.duty === 'plan_review') normalized.reviewedPlan = auth.basePlanRef ?? undefined
    if (auth.duty === 'code_review') normalized.reviewScopeRef = auth.reviewScopeRef ?? undefined
    if (auth.duty === 'plan_review' || auth.duty === 'code_review')
      normalized.verdict =
        report.verdict ??
        (report.todoDeltas.some(
          (item) => item.operation === 'create' || item.operation === 'reopen',
        )
          ? 'changes_requested'
          : 'accepted')
    if (respondToInputs && !report.inputResponses.length) {
      const inputs: CollaborationResult['inputResponses'] = []
      let offset = 0
      for (;;) {
        const page = repo.readRequiredInputMembers(runId, offset)
        inputs.push(
          ...page.items.map((item) => ({
            batchId: item.batchId,
            memberId: item.memberId,
            disposition: 'resolved' as const,
            reason: 'Applied the fixture input to its authorized scope.',
            todoId: null,
          })),
        )
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
      normalized.inputResponses = inputs
    }
    return normalized
  }
  const finish = (runId = first.run.id, report = checked, expectedFailure?: RegExp) => {
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
    const normalized = reportFor(runId, report, expectedFailure === undefined)
    const carrier: unknown = JSON.parse(
      JSON.stringify({
        version: 'pact-collaboration-envelope-v5',
        answer: 'Checked current scope.',
        result: normalized,
      }),
    )
    repo.recordCollaborationCarrier(runId, carrier)
    repo.recordCollaborationResult(runId, collaborationEnvelopeSchema.parse(carrier).result)

    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outputId: `answer-${runId}`,
      text: 'Checked current scope.',
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
        answerFormat: 'collaboration_envelope_v5',
      },
    })
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outcome: 'completed',
    })
    const settled = repo.collaboration(sessionId)!
    expect({
      failure: settled.reportFailure,
      notice: expectedFailure?.test(settled.notice ?? '') ?? settled.notice,
    }).toEqual({
      failure: expectedFailure ? 'invalid' : undefined,
      notice: expectedFailure ? true : undefined,
    })
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
    const next = prepareCollaborationSupplement(task, received.actor, settings)
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
    reportFor,
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
    expect(db.conversationRepository.collaboration(f.sessionId)?.status).toBe('failed')
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
      collaboration: next,
    })
    expect(f.repo.collaboration(f.sessionId)?.discussionRounds).toBe(1)
    f.repo.finishCollaboration(started.run.id, false)
    f.repo.failRun(started.run.id, 'protocol_error', 'Proved not dispatched', false)
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      discussionRounds: 0,
      releasedReservation: true,
      status: 'failed',
    })
    const retry = advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'retry', settings)
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
      releasedReservation: false,
    })
  })

  it('rejects stale phase CAS without partially materializing its received source', async () => {
    const f = await fixture()
    f.finish()
    const received = f.receive()
    const frozen = f.repo.collaboration(f.sessionId)!,
      next = prepareCollaborationSupplement(frozen, 'codex', settings)
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

it('carries the full submitted plan and opinions with a natural message in Handoff and Rebuild', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const report = {
    ...checked,
    todoDeltas: [
      {
        ...todoDelta('report-only'),
        title: 'Plan-only evidence',
        detail: 'This detailed finding exists only in the report.',
        recommendation: 'Keep the complete source.',
      },
    ],
  }
  f.finish(undefined, report)
  const sources = []
  for await (const source of f.repo.readHandoffSources(
    f.sessionId,
    'claude',
    -1,
    100,
    controller.signal,
  ))
    sources.push(source)
  const reply = sources.find((source) => source.speaker === 'codex')!
  expect(reply.contextVersion).toBe('collaboration_v2')
  const stored = f.repo.collaboration(f.sessionId)!
  expect(reply.content).toContain(stored.planDocument!.id)
  const originalReport = f.db.drizzle
    .select()
    .from(collaborationTurns)
    .where(eq(collaborationTurns.runId, stored.runId))
    .get()!
  const originalRef: CollaborationDocument = JSON.parse(originalReport.resultJson!).source
  expect(reply.content).toContain(originalRef.id)
  expect(readDocument(f, stored.planDocument!)).toBe(report.plan)
  expect(readDocument(f, stored.resultDocument!)).toContain(
    'This detailed finding exists only in the report.',
  )
  const chunks = []
  for await (const chunk of f.repo.nativeContextRebuildSource(f.sessionId, controller.signal))
    chunks.push(chunk)
  expect(
    chunks
      .filter((chunk) => chunk.kind === 'message')
      .map((chunk) => chunk.content)
      .join(''),
  ).toContain(originalRef.id)
  expect(f.repo.internalMessage(reply.messageId, f.sessionId)?.content).toBe(
    'Checked current scope.',
  )
  const oldSource = {
    messageId: reply.messageId,
    sequence: reply.sequence,
    contentRevision: reply.contentRevision,
    speaker: reply.speaker,
    handledBy: reply.handledBy,
    content: 'Checked current scope.',
    comments: reply.comments,
  }
  const oldDigest = hash(JSON.stringify(oldSource))
  expect(oldDigest).not.toBe(reply.digest)
  for (const contextVersion of [undefined, 'collaboration_v2'] as const) {
    const target = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Inspect the exact source.',
      expectedCommentsRevision: f.drafts().commentsRevision,
      commentIds: [],
      agentId: 'claude',
      settingsRevision: 1,
      model: null,
      effort: null,
      handoffSourceRefs: [
        {
          id: reply.messageId,
          revision: reply.contentRevision,
          digest: contextVersion ? reply.digest : oldDigest,
          ...(contextVersion ? { contextVersion } : {}),
        },
      ],
    })
    // oxlint-disable-next-line no-await-in-loop -- Each frozen digest version owns a distinct Run before its next receipt can be admitted.
    const saved = await f.repo.readRunHandoff(target.run.id, controller.signal)
    expect(saved[0]?.digest).toBe(contextVersion ? reply.digest : oldDigest)
    expect(saved[0]?.content).toBe(contextVersion ? reply.content : oldSource.content)
    f.repo.failRun(target.run.id, 'protocol_error', 'Fixture refusal before dispatch.', false)
  }
})

it.each(['terminal-before-report', 'late-report'] as const)(
  'preserves %s material across restart without accepting the recovered report',
  async (fault) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-report-restart-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath),
      signal = new AbortController().signal,
      report = {
        ...checked,
        plan: 'Unique recovered plan: retain cancellation ownership.',
        todoDeltas: [
          {
            ...todoDelta('recovered-opinion'),
            title: 'Recovered source',
            detail: 'Unique report-only evidence.',
            recommendation: 'Keep the original source.',
          },
        ],
      }
    f.repo.applyEvent(f.sessionId, f.first.run.id, {
      type: 'session.started',
      agentId: 'codex',
      nativeSessionId: 'recovery-source',
    })
    f.repo.applyEvent(f.sessionId, f.first.run.id, {
      type: 'turn.started',
      agentId: 'codex',
      turnId: 'recovery-turn',
    })
    const evidence = {
      kind: 'ended' as const,
      source: 'live_terminal' as const,
      outcome: 'completed' as const,
      identity: {
        sessionId: f.sessionId,
        agentId: 'codex' as const,
        requestId: f.first.run.id,
        runId: f.first.run.id,
        nativeSessionId: 'recovery-source',
        nativeTurnId: 'recovery-turn',
        bindingGeneration: 1,
        answerFormat: 'collaboration_envelope_v5' as const,
      },
      output: {
        outputId: 'recovered-answer',
        text: 'The scope needs discussion.',
        completeness: 'complete' as const,
        ...(fault === 'terminal-before-report' ? { submittedReport: report } : {}),
      },
    }
    f.repo.recordNativeEvidence(evidence)
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const reopened = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.push(reopened)
    const repo = reopened.conversationRepository
    if (fault === 'late-report') repo.recordRecoveredCollaborationResult(f.first.run.id, report)
    repo.recordRecoveredCollaborationResult(f.first.run.id, report)
    expect(() =>
      repo.recordRecoveredCollaborationResult(f.first.run.id, {
        ...report,
        plan: 'A conflicting source.',
      }),
    ).toThrow(/different report/)
    expect(() =>
      repo.recordNativeEvidence({
        ...evidence,
        identity: { ...evidence.identity, nativeTurnId: 'another-root' },
      }),
    ).toThrow(/identity/)
    await repo.recordNativeOutputComplete(f.first.run.id, evidence.output, signal)

    repo.settleKnownNativeEnding(f.first.run.id)
    const task = repo.collaboration(f.sessionId)!
    expect(task.status).toBe('failed')
    expect(task.result).toBeUndefined()
    expect(task.plan).toBeUndefined()
    expect(task.reportFailure).toBe('missing')
    const recovery = advanceCollaboration(task, 'submit_report', settings)
    recovery.reportRecovery = {
      sourceRunId: task.runId,
      sourceMessageId: repo.findRun(task.runId)!.responseMessageId!,
      sourceContentRevision: repo.internalMessage(
        repo.findRun(task.runId)!.responseMessageId!,
        f.sessionId,
      )!.contentRevision,
    }
    const source = await repo.readCollaborationReport(recovery, signal)
    const recovered = repo.collaborationReportSource(f.sessionId, f.first.run.id)!
    expect(recovered.plan).toBe(report.plan)
    expect(recovered.todoDeltas[0]?.detail).toBe('Unique report-only evidence.')
    expect(source.content).toContain('"acceptedReport":false')
    expect(repo.internalMessage(source.messageId, f.sessionId)?.content).toBe(evidence.output.text)
    expect(repo.read(f.sessionId).runs).toHaveLength(1)
  },
)

it.each([false, true])(
  'makes a completed late report available after Stop and resume, with inherited source=%s',
  async (inheritSource) => {
    const f = await fixture(),
      signal = new AbortController().signal
    let runId = f.first.run.id,
      agentId = f.first.run.agentId
    if (inheritSource) {
      f.finish()
      const next = advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'continue', settings)
      const started = f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Review the frozen plan.',
        expectedCommentsRevision: f.drafts().commentsRevision,
        commentIds: [],
        agentId: next.actor,
        settingsRevision: 1,
        model: null,
        effort: null,
        collaboration: next,
      })
      runId = started.run.id
      agentId = started.run.agentId
    }
    expect(f.repo.collaboration(f.sessionId)?.sourceMessageId).toBe(
      inheritSource ? f.repo.findRun(f.first.run.id)?.responseMessageId : undefined,
    )
    f.repo.applyEvent(f.sessionId, runId, {
      type: 'session.started',
      agentId,
      nativeSessionId: 'paused-source',
    })
    f.repo.applyEvent(f.sessionId, runId, {
      type: 'turn.started',
      agentId,
      turnId: 'paused-root',
    })
    f.repo.pauseCollaboration(f.sessionId)
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'live_terminal',
      outcome: 'completed',
      identity: {
        sessionId: f.sessionId,
        agentId,
        runId,
        requestId: runId,
        nativeSessionId: 'paused-source',
        nativeTurnId: 'paused-root',
        bindingGeneration: 1,
        answerFormat: 'collaboration_envelope_v5',
      },
      output: {
        outputId: 'late-body',
        text: 'Original completed answer.',
        completeness: 'complete',
        submittedReport: checked,
      },
    })
    await f.repo.recordNativeOutputComplete(
      runId,
      { outputId: 'late-body', text: 'Original completed answer.', completeness: 'complete' },
      signal,
    )
    f.repo.settleKnownNativeEnding(runId)
    expect(f.repo.collaboration(f.sessionId)?.status).toBe('paused')
    f.repo.setCollaborationState(
      advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'resume', settings),
    )
    const resumed = f.repo.collaboration(f.sessionId)!
    expect(resumed.sourceMessageId).toBe(f.repo.findRun(runId)?.responseMessageId)
    expect(() => advanceCollaboration(resumed, 'submit_report', settings)).not.toThrow()
  },
)

it('preserves a proved native ending when a later report conflicts with an existing candidate', async () => {
  const f = await fixture()
  f.repo.applyEvent(f.sessionId, f.first.run.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId: 'conflicting-source',
  })
  f.repo.applyEvent(f.sessionId, f.first.run.id, {
    type: 'turn.started',
    agentId: 'codex',
    turnId: 'conflicting-root',
  })
  const identity = {
    sessionId: f.sessionId,
    agentId: 'codex' as const,
    runId: f.first.run.id,
    requestId: f.first.run.id,
    nativeSessionId: 'conflicting-source',
    nativeTurnId: 'conflicting-root',
    bindingGeneration: 1,
    answerFormat: 'collaboration_envelope_v5' as const,
  }
  f.repo.recordNativeEvidence({
    kind: 'no_evidence',
    identity,
    reason: 'Only a partial source is known.',
    output: {
      outputId: 'candidate',
      text: 'Original source.',
      completeness: 'partial',
      submittedReport: checked,
    },
  })
  try {
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity,
      output: {
        outputId: 'candidate',
        text: 'Original source.',
        completeness: 'complete',
        submittedReport: { ...checked, plan: 'Different candidate.' },
      },
    })
  } catch {
    /* Conflicting material may be rejected but cannot revoke the ending. */
  }
  expect(f.repo.findRun(f.first.run.id)).toMatchObject({
    dispatchPhase: 'ended',
    nativeOutcome: 'completed',
  })
  expect(f.repo.collaboration(f.sessionId)?.reportFailure).toBe('invalid')
  expect(f.repo.collaboration(f.sessionId)?.notice).toContain('different report')
  const saved = f.db.drizzle
    .select()
    .from(collaborationTurns)
    .where(eq(collaborationTurns.runId, f.first.run.id))
    .get()!
  expect(f.repo.collaborationReportSource(f.sessionId, f.first.run.id)).toEqual(checked)
  expect(JSON.parse(saved.resultJson!)).toHaveProperty('source')
  const before = f.repo.findRun(f.first.run.id)
  expect(() =>
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: { ...identity, nativeTurnId: 'wrong-root' },
    }),
  ).toThrow(/identity/)
  expect(f.repo.findRun(f.first.run.id)).toEqual(before)
})

function completeWithoutParsedReport(
  f: Awaited<ReturnType<typeof fixture>>,
  carrier: { version: string; answer: string; result: CollaborationResult },
) {
  const id = f.first.run.id,
    nativeSessionId = 'saved-root',
    nativeTurnId = `root-${id}`
  f.repo.applyEvent(f.sessionId, id, { type: 'session.started', agentId: 'codex', nativeSessionId })
  f.repo.applyEvent(f.sessionId, id, {
    type: 'turn.started',
    agentId: 'codex',
    turnId: nativeTurnId,
  })
  const original = { ...carrier, result: f.reportFor(id, carrier.result) }
  f.repo.recordCollaborationCarrierText(id, JSON.stringify(original))
  f.repo.applyEvent(f.sessionId, id, {
    type: 'text.completed',
    agentId: 'codex',
    turnId: nativeTurnId,
    outputId: 'natural-answer',
    text: carrier.answer,
  })
  f.repo.recordNativeEvidence({
    kind: 'ended',
    source: 'live_terminal',
    outcome: 'completed',
    identity: {
      sessionId: f.sessionId,
      agentId: 'codex',
      runId: id,
      requestId: id,
      nativeSessionId,
      nativeTurnId,
      bindingGeneration: 1,
      answerFormat: 'collaboration_envelope_v5',
    },
  })
  f.repo.applyEvent(f.sessionId, id, {
    type: 'turn.completed',
    agentId: 'codex',
    turnId: nativeTurnId,
    outcome: 'completed',
  })
  f.repo.recordCollaborationCarrier(id, original)
  f.repo.recordRecoveredCollaborationResult(id, original.result)
  return {
    runId: id,
    nativeSessionId,
    nativeTurnId,
    revision: f.repo.collaboration(f.sessionId)!.revision,
    source: 'stored_terminal' as const,
  }
}

it('reconciles only the saved original, rejects candidate mismatch, and preserves terminal/message identity', async () => {
  const f = await fixture(),
    carrier = {
      version: 'pact-collaboration-envelope-v5',
      answer: 'The original conclusion.',
      result: checked,
    }
  const input = completeWithoutParsedReport(f, carrier),
    before = f.repo.internalMessage(f.repo.findRun(input.runId)!.responseMessageId!, f.sessionId)!
  const source = f.repo.collaborationCarrierSource(f.sessionId, input.runId)!
  const forged = {
    ...carrier,
    answer: 'A different message.',
    result: { ...checked, plan: 'Forged replacement' },
  }
  expect(() => f.repo.recordCollaborationCarrier(input.runId, forged)).toThrow(
    /original final submission/,
  )
  expect(() => f.repo.recordRecoveredCollaborationResult(input.runId, forged.result)).toThrow(
    /original submission/,
  )
  expect(() =>
    f.repo.reconcileCompletedCollaboration({ ...input, nativeTurnId: 'another-root' }),
  ).toThrow(/identity/)
  expect(() =>
    f.repo.reconcileCompletedCollaboration({ ...input, revision: input.revision + 1 }),
  ).toThrow(/advanced/)
  expect(f.repo.collaborationCarrierSource(f.sessionId, input.runId)).toEqual(source)
  f.repo.reconcileCompletedCollaboration(input)
  const settled = f.repo.collaboration(f.sessionId)!,
    revision = settled.revision
  expect(settled).toMatchObject({ status: 'waiting', planVersion: 1 })
  expect(settled.reportFailure).toBeUndefined()
  expect(readDocument(f, settled.planDocument!)).toBe(checked.plan)
  expect(f.repo.internalMessage(before.id, f.sessionId)).toEqual(before)
  f.repo.reconcileCompletedCollaboration(input)
  expect(f.repo.collaboration(f.sessionId)?.revision).toBe(revision)
  expect(() => f.repo.recordCollaborationCarrierText(input.runId, JSON.stringify(forged))).toThrow(
    /replace/,
  )
})

it('cannot accept an original report after pause or after an acknowledged user update', async () => {
  const f = await fixture(),
    input = completeWithoutParsedReport(f, {
      version: 'pact-collaboration-envelope-v5',
      answer: 'Completed natural answer.',
      result: checked,
    })
  const failed = f.repo.collaboration(f.sessionId)!
  f.repo.pauseCollaboration(f.sessionId)
  expect(() =>
    f.repo.reconcileCompletedCollaboration({
      ...input,
      revision: f.repo.collaboration(f.sessionId)!.revision,
    }),
  ).toThrow(/advanced/)
  f.repo.setCollaborationState(failed)
  f.receive()
  expect(() =>
    f.repo.reconcileCompletedCollaboration({
      ...input,
      revision: f.repo.collaboration(f.sessionId)!.revision,
    }),
  ).toThrow(/advanced/)
  expect(f.repo.collaboration(f.sessionId)?.planVersion).toBe(0)
  expect(f.repo.readReceivedInput(f.sessionId)).toBeDefined()
})

it('stores, pages and cold-reads complete plan/report sources beyond former aggregate and field limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-complete-source-regression-'))
  directories.push(directory)
  const filePath = join(directory, 'pact.sqlite'),
    f = await fixture(filePath),
    report = {
      ...checked,
      plan: '界😀'.repeat(25_000),
      todoDeltas: Array.from({ length: 80 }, (_, i) => ({
        ...todoDelta(`opinion-${i}`),
        title: `Complete opinion ${i}`,
        detail: i === 0 ? 'Full detail. '.repeat(5000) : 'Distinct source.',
        recommendation: 'Preserve the whole source.',
      })),
    }
  f.finish(undefined, report)
  const state = f.repo.collaboration(f.sessionId)!,
    current = f.repo.readPage({
      scope: 'collaboration',
      sessionId: f.sessionId,
      projection: 'current',
    })
  expect(current.scope).toBe('collaboration')
  expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThanOrEqual(48 * 1024)
  expect(state.plan).toBeUndefined()
  expect(readDocument(f, state.planDocument!)).toBe(report.plan)
  const ids: string[] = []
  let offset = 0
  for (;;) {
    const page = f.repo.readPage({
      scope: 'collaboration',
      sessionId: f.sessionId,
      projection: 'todos',
      todoStatus: 'all',
      todoOffset: offset,
    })
    if (page.scope !== 'collaboration') throw Error('Report unavailable')
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
    expect(page.view.todos!.items.length).toBeLessThanOrEqual(24)
    ids.push(...page.view.todos!.items.map((item) => item.id))
    if (page.view.todos!.nextOffset === null) break
    offset = page.view.todos!.nextOffset
  }
  expect(ids).toEqual(report.todoDeltas.map((item) => item.todoId))
  expect(f.repo.collaborationReportSource(f.sessionId, state.runId)).toEqual(
    f.reportFor(state.runId, report),
  )
  f.db.close()
  databases.splice(databases.indexOf(f.db), 1)
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
  const cold = db.conversationRepository.collaboration(f.sessionId, undefined, true)!
  expect(cold.plan).toBe(report.plan)
  expect(cold.result?.todoDeltas).toEqual(report.todoDeltas)
})

it('uses the same settlement for full unchanged primary submissions and real revisions', async () => {
  const f = await fixture()
  f.finish()
  const drafted = f.repo.collaboration(f.sessionId)!,
    peer = advanceCollaboration(drafted, 'continue', settings)
  const reviewed = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Review plan.',
    commentIds: [],
    expectedCommentsRevision: f.drafts().commentsRevision,
    agentId: peer.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: peer,
  })
  f.finish(reviewed.run.id, { ...checked, plan: undefined })
  let prior = f.repo.collaboration(f.sessionId)!
  expect(prior.status).toBe('ready')
  for (const changed of [false, true]) {
    const phase = prepareCollaborationSupplement(prior, 'codex', settings, 'maintain_plan')
    const run = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Maintain the plan.',
      commentIds: [],
      expectedCommentsRevision: f.drafts().commentsRevision,
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      collaboration: phase,
    })
    f.finish(run.run.id, {
      ...checked,
      plan: changed ? 'New source and acceptance.' : checked.plan,
    })
    const next = f.repo.collaboration(f.sessionId)!
    expect(next.planVersion).toBe(prior.planVersion + Number(changed))
    expect(next.planReference).toEqual(
      changed
        ? {
            type: 'unchanged',
            version: prior.planVersion + 1,
            sourceRunId: run.run.id,
            sha256: hash('New source and acceptance.'),
          }
        : prior.planReference,
    )
    expect(next.planDocument?.sha256).toBe(
      hash(changed ? 'New source and acceptance.' : fixturePlan),
    )
    expect(next.reviewedPlan).toEqual(changed ? undefined : prior.reviewedPlan)
    expect(!changed && next.planDocument?.id !== prior.planDocument?.id).toBe(false)
    prior = next
  }
})

it('closes an approved plan after clean code rereview without treating it as plan maintenance', async () => {
  const f = await fixture()
  f.finish()
  const begin = (action: 'continue' | 'execute' | 'repair') => {
    const phase = advanceCollaboration(f.repo.collaboration(f.sessionId)!, action, settings)
    return f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Continue the authorized phase.',
      commentIds: [],
      expectedCommentsRevision: f.drafts().commentsRevision,
      agentId: phase.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      collaboration: phase,
    }).run.id
  }
  f.finish(begin('continue'), { ...checked, plan: undefined })
  const clean = { ...checked, submission: 'stage_result' as const, plan: undefined }
  f.finish(begin('execute'), clean)
  const opinion = {
    ...todoDelta('cleanup'),
    title: 'Dispose pending work',
    detail: 'The owner must release the request.',
    recommendation: 'Dispose on termination.',
  }
  f.finish(begin('continue'), { ...clean, todoDeltas: [opinion] })
  f.finish(begin('repair'), {
    ...clean,
    todoDeltas: [
      todoDelta('cleanup', {
        operation: 'propose_resolution',
        expectedRevision: 1,
        resolutionKind: 'resolved',
        reason: 'Disposed pending work with the owner.',
      }),
    ],
  })
  f.finish(begin('continue'), {
    ...clean,
    todoDeltas: [
      todoDelta('cleanup', {
        operation: 'confirm',
        expectedRevision: 2,
        resolutionKind: 'resolved',
        reason: 'Independent review confirms the owner releases pending work.',
      }),
    ],
  })
  expect(f.repo.collaboration(f.sessionId)?.status).toBe('complete')
  expect(f.repo.collaboration(f.sessionId)?.reportFailure).toBeUndefined()
  expect(f.repo.collaboration(f.sessionId)?.reviewCycles).toBe(1)
})

async function frozenBatchFixture() {
  const f = await fixture()
  f.finish()
  const ids: string[] = []
  for (let index = 0; index < 26; index++) {
    const id = randomUUID()
    ids.push(id)
    f.repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: id,
      expectedCommentsRevision: f.drafts().commentsRevision,
      body: `Distinct requested check ${index}`,
      anchor: {
        type: 'message',
        messageId: f.first.run.userMessageId,
        contentHash: hash('/plan Review cancellation.'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 5,
        quote: '/plan',
      },
    })
  }
  expect(f.drafts().comments.length).toBeLessThan(ids.length)
  // The supplied visible subset must not replace the authoritative full draft set.
  f.receive(f.input('Apply the complete Batch.', ids.slice(0, 10)))
  const started = f.materialize()
  const batch = f.repo.inputBatchForRun(started.run.id)!
  expect(batch.memberCount).toBe(26)
  const firstPage = f.repo.readFrozenInputBatch(started.run.id, batch.id)
  expect(firstPage.members).toHaveLength(24)
  expect(firstPage.hasMore).toBe(true)
  const lastPage = f.repo.readFrozenInputBatch(started.run.id, batch.id, firstPage.nextOrdinal)
  expect(lastPage.members).toHaveLength(2)
  expect(lastPage.hasMore).toBe(false)
  expect([...firstPage.members, ...lastPage.members].map((item) => item.commentId)).toEqual(ids)
  const before = f.repo.collaboration(f.sessionId)!
  const report = f.reportFor(started.run.id, { ...checked, todoDeltas: [todoDelta('atomic')] })
  expect(report.inputResponses).toHaveLength(27)
  expect(
    new Set(report.inputResponses.map((item) => `${item.batchId}:${item.memberId}`)).size,
  ).toBe(27)
  return { f, started, batch, before, report, firstPage, lastPage }
}
function expectUnsettledBatch(value: Awaited<ReturnType<typeof frozenBatchFixture>>) {
  const { f, started, batch, before, firstPage, lastPage } = value
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled.ledgerRevision).toBe(before.ledgerRevision)
  expect(settled.processedWatermark).toBe(before.processedWatermark)
  expect(() => f.repo.readTodoRevision(settled.id, 'atomic', 1)).toThrow(/unavailable/)
  expect(f.repo.readFrozenInputBatch(started.run.id, batch.id).members).toEqual(firstPage.members)
  expect(
    f.repo.readFrozenInputBatch(started.run.id, batch.id, firstPage.nextOrdinal).members,
  ).toEqual(lastPage.members)
}
it('settles every off-page frozen Batch member exactly once', async () => {
  const { f, started, batch, before, report } = await frozenBatchFixture()
  f.finish(started.run.id, report)
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({
    ledgerRevision: before.ledgerRevision + 1,
    ledgerOpenCount: 1,
    processedWatermark: settled.inputSequence,
  })
  expect(f.repo.readTodoRevision(settled.id, 'atomic', 1).status).toBe('open')
  expect(
    f.repo
      .readFrozenInputBatch(started.run.id, batch.id)
      .members.every((item) => item.state === 'resolved'),
  ).toBe(true)
})
it.each(['missing-last', 'foreign-member'] as const)(
  'rejects %s without partial Todo or input settlement',
  async (fault) => {
    const value = await frozenBatchFixture()
    const { f, started, report } = value
    if (fault === 'missing-last') report.inputResponses.pop()
    else
      report.inputResponses.push({
        batchId: randomUUID(),
        memberId: 'foreign',
        disposition: 'resolved',
        reason: 'A foreign request.',
        todoId: null,
      })
    f.finish(started.run.id, report, /exactly one response/)
    expect(f.repo.collaboration(f.sessionId)?.reportFailure).toBe('invalid')
    expectUnsettledBatch(value)
  },
)
it('rejects a duplicate last Batch response without partial Todo or input settlement', async () => {
  const value = await frozenBatchFixture()
  const { f, started, report } = value
  report.inputResponses.push(report.inputResponses.at(-1)!)
  expect(() => f.finish(started.run.id, report, /unique/)).toThrow(/unique/)
  expectUnsettledBatch(value)
})

it('a later resolved Batch cannot advance the continuous watermark past an earlier partial response', async () => {
  const f = await fixture()
  f.finish()
  const priorWatermark = f.repo.collaboration(f.sessionId)!.processedWatermark
  f.receive(f.input('A still needs a final decision.'))
  const a = f.materialize()
  const aBatch = f.repo.inputBatchForRun(a.run.id)!
  const partial = f.reportFor(a.run.id, checked)
  partial.inputResponses = partial.inputResponses.map((item) => ({
    ...item,
    disposition: 'responded',
  }))
  f.finish(a.run.id, partial)
  expect(f.repo.collaboration(f.sessionId)!.processedWatermark).toBe(priorWatermark)
  f.receive(f.input('B is fully handled.'))
  const b = f.materialize()
  const bBatch = f.repo.inputBatchForRun(b.run.id)!
  const report = f.reportFor(b.run.id, checked)
  expect(report.inputResponses.map((item) => item.batchId)).toContain(aBatch.id)
  expect(report.inputResponses.map((item) => item.batchId)).toContain(bBatch.id)
  report.inputResponses = report.inputResponses.map((item) => ({
    ...item,
    disposition: item.batchId === aBatch.id ? 'responded' : 'resolved',
  }))
  f.finish(b.run.id, report)
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'waiting',
    inputSequence: priorWatermark + 2,
    processedWatermark: priorWatermark,
  })
  const current = f.repo.collaboration(f.sessionId)!
  const peer = advanceCollaboration(current, 'continue', settings)
  const review = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Review the complete scope.',
    expectedCommentsRevision: f.drafts().commentsRevision,
    commentIds: [],
    agentId: peer.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: peer,
  })
  const rejected = f.reportFor(review.run.id, checked)
  rejected.inputResponses = rejected.inputResponses.map((item) => ({
    ...item,
    disposition: item.batchId === aBatch.id ? 'responded' : 'resolved',
  }))
  f.finish(review.run.id, rejected, /input responses remain unresolved/)
  expect(f.repo.collaboration(f.sessionId)?.processedWatermark).toBe(priorWatermark)
})

it('seeks the current Done page while preserving the exact historical Todo version and complete ledger acceptance', async () => {
  const f = await fixture()
  const created = Array.from({ length: 26 }, (_, index) => todoDelta(`retained-${index}`))
  f.finish(undefined, { ...checked, todoDeltas: created })
  const draft = f.repo.collaboration(f.sessionId)!
  const maintenance = prepareCollaborationSupplement(draft, 'codex', settings, 'maintain_plan')
  const proposed = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Apply ownership handling.',
    expectedCommentsRevision: f.drafts().commentsRevision,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: maintenance,
  })
  f.finish(proposed.run.id, {
    ...checked,
    todoDeltas: created.map((item) =>
      Object.assign({}, item, {
        expectedRevision: 1,
        operation: 'propose_resolution',
        resolutionKind: 'resolved',
        reason: 'The owner now releases its request.',
      }),
    ),
  })
  expect(f.repo.collaboration(f.sessionId)?.ledgerAwaitingCount).toBe(26)
  const peer = advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'continue', settings)
  const review = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Review every exact resolution.',
    expectedCommentsRevision: f.drafts().commentsRevision,
    commentIds: [],
    agentId: peer.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: peer,
  })
  f.finish(review.run.id, {
    ...checked,
    todoDeltas: created.map((item) =>
      Object.assign({}, item, {
        expectedRevision: 2,
        operation: 'confirm',
        resolutionKind: 'resolved',
        reason: 'Independent review confirms request cleanup.',
      }),
    ),
  })
  const ready = f.repo.collaboration(f.sessionId)!
  expect(ready).toMatchObject({
    status: 'ready',
    ledgerOpenCount: 0,
    ledgerAwaitingCount: 0,
    doneTodoCount: 26,
    processedWatermark: ready.inputSequence,
  })
  const page = f.repo.readPage({
    scope: 'collaboration',
    sessionId: f.sessionId,
    taskId: ready.id,
    projection: 'todos',
    todoId: 'retained-25',
    todoRevision: 1,
    todoStatus: 'source',
  })
  if (page.scope !== 'collaboration') throw Error('Missing exact Todo source')
  expect(page.view).toMatchObject({
    todo: { id: 'retained-25', revision: 1, status: 'open' },
    todoCurrent: { revision: 3, status: 'done' },
    todos: { group: 'done', activeCount: 0, doneCount: 26 },
  })
  expect(page.view.todos!.items.length).toBeLessThanOrEqual(24)
  expect(page.view.todos!.items.every((item) => item.status === 'done')).toBe(true)
  expect(
    page.view.todos!.items.some((item) => item.id === 'retained-25' && item.revision === 3),
  ).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
})

it('a live frozen report preserves its plan and a newer acknowledged input without approving the newer scope', async () => {
  const f = await fixture()
  const received = f.receive(f.input('A newer decision still needs handling.'))
  f.finish()
  const current = f.repo.collaboration(f.sessionId)!
  expect(current).toMatchObject({ status: 'waiting', planVersion: 1 })
  expect(current.reportFailure).toBeUndefined()
  expect(readDocument(f, current.planDocument!)).toBe(fixturePlan)
  expect(current.processedWatermark).toBeLessThan(current.inputSequence)
  expect(f.repo.readReceivedInput(f.sessionId)?.id).toBe(received.send.clientMessageId)
  expect(f.repo.read(f.sessionId).runs).toHaveLength(1)
})

it('pause and actual resume cannot restore reconciliation authority for an earlier completed report', async () => {
  const f = await fixture()
  const input = completeWithoutParsedReport(f, {
    version: 'pact-collaboration-envelope-v5',
    answer: 'Original completed conclusion.',
    result: checked,
  })
  f.repo.pauseCollaboration(f.sessionId)
  const paused = f.repo.collaboration(f.sessionId)!
  expect(paused.status).toBe('paused')
  f.repo.setCollaborationState(advanceCollaboration(paused, 'resume', settings))
  const resumed = f.repo.collaboration(f.sessionId)!
  expect(resumed.status).toBe('failed')
  expect(() =>
    f.repo.reconcileCompletedCollaboration({ ...input, revision: resumed.revision }),
  ).toThrow(/advanced/)
  expect(f.repo.collaboration(f.sessionId)?.planVersion).toBe(0)
  expect(f.repo.collaborationCarrierSource(f.sessionId, input.runId)).toBeDefined()
})

it('repeated identical native ending is idempotent and leaves unchanged completed-report reconciliation valid', async () => {
  const f = await fixture()
  const input = completeWithoutParsedReport(f, {
    version: 'pact-collaboration-envelope-v5',
    answer: 'Original completed conclusion.',
    result: checked,
  })
  const before = f.repo.collaboration(f.sessionId)!
  f.repo.settleKnownNativeEnding(input.runId)
  f.repo.settleKnownNativeEnding(input.runId)
  expect(f.repo.collaboration(f.sessionId)?.revision).toBe(before.revision)
  f.repo.reconcileCompletedCollaboration({
    ...input,
    revision: f.repo.collaboration(f.sessionId)!.revision,
  })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({ status: 'waiting', planVersion: 1 })
  expect(settled.reportFailure).toBeUndefined()
  f.repo.reconcileCompletedCollaboration({ ...input, revision: settled.revision })
  expect(f.repo.collaboration(f.sessionId)?.revision).toBe(settled.revision)
  expect(f.repo.collaboration(f.sessionId)?.planVersion).toBe(1)
})

function completeInvalidReport(f: Awaited<ReturnType<typeof fixture>>) {
  const report = f.reportFor(f.first.run.id, { ...checked, verdict: 'accepted' })
  f.finish(undefined, report, /cannot claim review acceptance/)
  const run = f.repo.findRun(f.first.run.id)!
  return {
    runId: run.id,
    nativeSessionId: run.nativeSessionId!,
    nativeTurnId: run.nativeTurnId!,
    revision: f.repo.collaboration(f.sessionId)!.revision,
    source: 'stored_terminal' as const,
  }
}
async function reopenCollaborationFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  filePath: string,
) {
  f.db.close()
  databases.splice(databases.indexOf(f.db), 1)
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
  return db
}
function receiveColdInput(repo: PactDatabase['conversationRepository'], sessionId: string) {
  const owner = randomUUID(),
    clientMessageId = randomUUID(),
    content = 'A new acknowledged user decision.'
  const drafts = repo.readPage({ scope: 'drafts', sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing cold draft revision')
  const body = repo.writeConversationInput({ type: 'begin', sessionId, clientMessageId }, owner)
  repo.writeConversationInput(
    { type: 'append', sessionId, inputId: body.inputId, offset: 0, text: content },
    owner,
  )
  repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
  repo.receiveCollaborationInput(
    {
      sessionId,
      clientMessageId,
      content,
      commentIds: [],
      expectedCommentsRevision: drafts.commentsRevision,
      route: { type: 'primary' },
    },
    body.inputId,
    'codex',
    'immediate_safe_point',
    owner,
  )
  return clientMessageId
}

it.each([
  ['missing', 'ack'],
  ['missing', 'pause-resume'],
  ['invalid', 'ack'],
  ['invalid', 'pause-resume'],
] as const)(
  'persists the completed %s report fence across a cold restart and rejects %s revision renewal',
  async (failure, mutation) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-cold-completed-fence-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath)
    const input =
      failure === 'missing'
        ? completeWithoutParsedReport(f, {
            version: 'pact-collaboration-envelope-v5',
            answer: 'Original cold conclusion.',
            result: checked,
          })
        : completeInvalidReport(f)
    const fence = f.db.drizzle
      .select({ revision: collaborationTurns.completedFailureRevision })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, input.runId))
      .get()!.revision
    expect(fence).toBe(input.revision)
    const source = f.repo.collaborationCarrierSource(f.sessionId, input.runId)
    const db = await reopenCollaborationFixture(f, filePath),
      repo = db.conversationRepository
    expect(
      db.drizzle
        .select({ revision: collaborationTurns.completedFailureRevision })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, input.runId))
        .get()!.revision,
    ).toBe(fence)
    if (mutation === 'ack') receiveColdInput(repo, f.sessionId)
    else {
      repo.pauseCollaboration(f.sessionId)
      repo.setCollaborationState(
        advanceCollaboration(repo.collaboration(f.sessionId)!, 'resume', settings),
      )
    }
    const current = repo.collaboration(f.sessionId)!
    expect(current.revision).toBeGreaterThan(fence!)
    expect(() =>
      repo.reconcileCompletedCollaboration({ ...input, revision: current.revision }),
    ).toThrow(/advanced/)
    expect(repo.collaboration(f.sessionId)).toMatchObject({
      status: 'failed',
      planVersion: 0,
      reportFailure: failure,
    })
    expect(repo.collaborationCarrierSource(f.sessionId, input.runId)).toEqual(source)
    expect(
      db.drizzle
        .select({ revision: collaborationTurns.completedFailureRevision })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, input.runId))
        .get()!.revision,
    ).toBe(fence)
    expect(
      advanceCollaboration(current, 'submit_report', settings).reportRecovery?.sourceRunId,
    ).toBe(input.runId)
    expect(repo.read(f.sessionId).runs).toHaveLength(1)
  },
)

it('a cold unchanged original report reconciles once without renewing its persisted completion fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-cold-unchanged-report-'))
  directories.push(directory)
  const filePath = join(directory, 'pact.sqlite'),
    f = await fixture(filePath)
  const input = completeWithoutParsedReport(f, {
    version: 'pact-collaboration-envelope-v5',
    answer: 'Original cold conclusion.',
    result: checked,
  })
  const source = f.repo.collaborationCarrierSource(f.sessionId, input.runId)
  const originalMessage = f.repo.internalMessage(
    f.repo.findRun(input.runId)!.responseMessageId!,
    f.sessionId,
  )
  const db = await reopenCollaborationFixture(f, filePath),
    repo = db.conversationRepository
  repo.settleKnownNativeEnding(input.runId)
  expect(repo.collaboration(f.sessionId)?.revision).toBe(input.revision)
  repo.reconcileCompletedCollaboration(input)
  const settled = repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({ status: 'waiting', planVersion: 1 })
  expect(settled.reportFailure).toBeUndefined()
  expect(settled.revision).toBe(input.revision + 1)
  repo.reconcileCompletedCollaboration({ ...input, revision: settled.revision })
  expect(repo.collaboration(f.sessionId)?.revision).toBe(settled.revision)
  expect(repo.collaborationCarrierSource(f.sessionId, input.runId)).toEqual(source)
  expect(repo.internalMessage(originalMessage!.id, f.sessionId)).toEqual(originalMessage)
  expect(
    db.drizzle
      .select({ revision: collaborationTurns.completedFailureRevision })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, input.runId))
      .get()!.revision,
  ).toBe(input.revision)
  expect(repo.read(f.sessionId).runs).toHaveLength(1)
})

it.each(['missing', 'invalid'] as const)(
  'legacy completed %s data never gains a fabricated reconciliation fence from repeated endings',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-legacy-completion-fence-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath)
    const input =
      failure === 'missing'
        ? completeWithoutParsedReport(f, {
            version: 'pact-collaboration-envelope-v5',
            answer: 'Retained original conclusion.',
            result: checked,
          })
        : completeInvalidReport(f)
    const source = f.repo.collaborationCarrierSource(f.sessionId, input.runId)
    f.db.drizzle
      .update(collaborationTurns)
      .set({ completedFailureRevision: null })
      .where(eq(collaborationTurns.runId, input.runId))
      .run()
    const db = await reopenCollaborationFixture(f, filePath),
      repo = db.conversationRepository
    const before = repo.collaboration(f.sessionId)!
    repo.settleKnownNativeEnding(input.runId)
    repo.settleKnownNativeEnding(input.runId)
    expect(repo.collaboration(f.sessionId)?.revision).toBe(before.revision)
    expect(
      db.drizzle
        .select({ revision: collaborationTurns.completedFailureRevision })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, input.runId))
        .get()!.revision,
    ).toBeNull()
    expect(() =>
      repo.reconcileCompletedCollaboration({ ...input, revision: before.revision }),
    ).toThrow(/advanced/)
    expect(repo.collaborationCarrierSource(f.sessionId, input.runId)).toEqual(source)
    expect(repo.collaboration(f.sessionId)).toMatchObject({
      status: 'failed',
      planVersion: 0,
      reportFailure: failure,
    })
    expect(advanceCollaboration(before, 'submit_report', settings)).toMatchObject({
      status: 'running',
      actor: before.actor,
      reportRecovery: { sourceRunId: input.runId },
    })
    expect(repo.read(f.sessionId).runs).toHaveLength(1)
  },
)

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
