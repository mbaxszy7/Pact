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
  type CollaborationTask,
  type SchedulingHandoff,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  conversationBodyInputs,
  conversationImageAssets,
  conversationInputBatchMembers,
  schedulingHandoffs,
  schedulingEvaluations,
  schedulingBudgetReservations,
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
      repo.collaborationReplyActor(repo.collaboration(sessionId)!, send.replyToDecision),
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

function admitHandoff(
  f: Awaited<ReturnType<typeof fixture>>,
  task: CollaborationTask,
  handoff: SchedulingHandoff,
) {
  const next = advanceCollaboration(task, 'continue', settings)
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: `@${next.actor} Next stage.`,
    commentIds: [],
    expectedCommentsRevision: f.drafts().commentsRevision,
    settingsRevision: f.db.sessionRepository.find(f.sessionId)!.settingsRevision,
    agentId: next.actor,
    model: null,
    effort: null,
    collaboration: next,
    expectedCollaborationRevision: task.revision,
    preserveDraftComments: true,
    schedulingHandoff: handoff,
  })
}

async function planSupplementOpportunity(f: Awaited<ReturnType<typeof fixture>>) {
  f.repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  f.finish()
  for (let index = 0; index < 2; index++) {
    const review = advance(f)
    f.finish(review.id, { verdict: 'changes_requested' })
    const revision = advance(f)
    f.finish(revision.id, { plan: `Complete Plan revision ${index + 2}.` })
  }
}

async function confirmedSupplement(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'supplement_plan' | 'supplement_code_response',
) {
  const task = f.repo.collaboration(f.sessionId)!,
    handoff = f.repo.workflowHandoff(task, kind === 'supplement_plan' ? task.reviewer : task.owner),
    candidateId = `propose_${kind}`,
    deadlineAt = Date.now() + 15_000
  expect(f.repo.relaySupplementOpportunity(handoff)?.kind).toBe(kind)
  const material = await f.repo.readRelayWorkflowDecisionSources(
    handoff,
    [
      {
        id: candidateId,
        description: 'One exact read-only clarification and its fixed return review.',
      },
    ],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: hash('config'),
    deadlineAt,
    inputSha256: material.inputSha256,
  })
  if (reserved.status !== 'reserved') throw Error('Expected the original model evaluation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: candidateId,
  })
  const card = f.repo.proposeRelayWorkflowAction({
    handoff,
    kind,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason: 'Clarify the complete frozen scope before returning to its fixed reviewer.',
    sourceIds: material.sources.map((source) => source.id),
  })
  expect(f.repo.relayWorkflowUserGrants(handoff, material.snapshot)).toEqual({})
  const accepted = f.repo.answerRelaySchedulingDecision({
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  })
  if (!('receiptId' in accepted) || !accepted.receiptId)
    throw Error('Expected a concrete user grant')
  return f.repo.preparedRelayWorkflowAction(accepted.receiptId)
}

function startConfirmedSupplement(
  f: Awaited<ReturnType<typeof fixture>>,
  prepared: ReturnType<Awaited<ReturnType<typeof fixture>>['repo']['preparedRelayWorkflowAction']>,
) {
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: prepared.receipt.clientNonce,
    content: 'Perform the exact approved read-only clarification.',
    commentIds: [],
    expectedCommentsRevision: f.drafts().commentsRevision,
    agentId: prepared.next.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: prepared.task.revision,
    collaboration: prepared.next,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }).run
}

describe('Shared handoff receipts and persistent scheduling budgets', () => {
  it('arbitrates different manual/default client receipts as one business Run and one original counter', async () => {
    const f = await fixture()
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      node = f.repo.workflowHandoff(task, task.reviewer)
    const results = await Promise.all([0, 1, 2, 3].map(async () => admitHandoff(f, task, node)))
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1)
    expect(f.repo.collaboration(f.sessionId)!.discussionRounds).toBe(1)
    expect(f.db.drizzle.select().from(schedulingHandoffs).all()).toHaveLength(1)
    expect(f.repo.handoffReceipt(node.id)?.runId).toBe(results[0]!.run.id)
    f.finish(results[0]!.run.id, { verdict: 'changes_requested' })
    const next = f.repo.collaboration(f.sessionId)!
    expect(f.repo.workflowHandoff(next, next.owner).id).not.toBe(node.id)
  })

  it('keeps node/fact identity through configuration and pause changes, but rejects an old guard', async () => {
    const f = await fixture()
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      old = f.repo.workflowHandoff(task, task.reviewer)
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...settings,
      agents: { ...settings.agents, claude: { model: 'explicit-model', effort: 'high' } },
    })
    const changed = f.repo.workflowHandoff(task, task.reviewer)
    expect(changed.id).toBe(old.id)
    expect(changed.factFingerprint).toBe(old.factFingerprint)
    expect(changed.freshnessGuard).not.toEqual(old.freshnessGuard)
    expect(() => admitHandoff(f, task, old)).toThrow('handoff facts changed')
    f.repo.pauseCollaboration(f.sessionId)
    const paused = f.repo.collaboration(f.sessionId)!
    expect(f.repo.workflowHandoff(paused, paused.reviewer).id).toBe(old.id)
    f.repo.setCollaborationState({
      ...paused,
      revision: paused.revision + 1,
      automation: 'active',
      pauseReason: undefined,
    })
    const resumed = f.repo.collaboration(f.sessionId)!
    const result = admitHandoff(f, resumed, f.repo.workflowHandoff(resumed, resumed.reviewer))
    expect(admitHandoff(f, task, old)).toMatchObject({ created: false, run: { id: result.run.id } })
  })

  it('gives a new priority input its own business event while retaining the task budget root', async () => {
    const f = await fixture()
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      previous = f.repo.workflowHandoff(task, task.reviewer)
    const received = f.receive(),
      updated = f.repo.collaboration(f.sessionId)!
    const node = f.repo.workflowHandoff(updated, updated.owner, received.send.clientMessageId)
    expect(node.id).not.toBe(previous.id)
    expect(node.budgetSubjectId).toBe(previous.budgetSubjectId)
    expect(() => admitHandoff(f, task, previous)).toThrow('handoff facts changed')
    const result = f.materialize()
    expect(f.repo.handoffReceipt(node.id)?.runId).toBe(result.run.id)
    expect(f.repo.handoffReceipt(previous.id)).toBeUndefined()
  })

  it('deduplicates the same evaluation facts across model changes and retains physical capacity after logical failure', async () => {
    const f = await fixture()
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      node = f.repo.workflowHandoff(task, task.reviewer)
    const reserved = f.repo.reserveEvaluation({
      handoff: node,
      provider: 'codex',
      model: 'exact-codex-model',
      configurationFingerprint: hash('config'),
    })
    if (reserved.status !== 'reserved') throw Error('Expected a reservation')
    expect(f.repo.dispatchEvaluation(reserved.evaluation.id).created).toBe(true)
    expect(f.repo.dispatchEvaluation(reserved.evaluation.id).created).toBe(false)
    f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'failed', physicalReleased: false })
    expect(() =>
      f.repo.settleEvaluation(reserved.evaluation.id, {
        outcome: 'not_sent',
        physicalReleased: true,
      }),
    ).toThrow('cannot be refunded')
    f.db.sessionRepository.saveSettings(f.sessionId, settings)
    expect(
      f.repo.reserveEvaluation({
        handoff: f.repo.workflowHandoff(task, task.reviewer),
        provider: 'claude',
        model: 'another-explicit-model',
        configurationFingerprint: hash('new-config'),
      }).status,
    ).toBe('duplicate')
    const fault = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
    expect(
      f.repo.reserveEvaluation({
        handoff: fault,
        provider: 'codex',
        model: 'exact-codex-model',
        configurationFingerprint: hash('config'),
      }).status,
    ).toBe('busy')
    f.repo.settleEvaluation(reserved.evaluation.id, {
      outcome: 'failed',
      physicalReleased: true,
      usage: { inputTokens: 12, outputTokens: 3 },
    })
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(
      f.repo.reserveEvaluation({
        handoff: fault,
        provider: 'codex',
        model: 'exact-codex-model',
        configurationFingerprint: hash('config'),
      }).status,
    ).toBe('reserved')
  })

  it('rejects stale/expired invocation and preserves same-fact deduplication after a proven unsent evaluation', async () => {
    const f = await fixture()
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      node = f.repo.workflowHandoff(task, task.reviewer)
    const reserved = f.repo.reserveEvaluation({
      handoff: node,
      provider: 'codex',
      model: 'exact-model',
      configurationFingerprint: hash('config'),
    })
    if (reserved.status !== 'reserved') throw Error('Expected a reservation')
    f.db.drizzle
      .update(schedulingEvaluations)
      .set({ deadline: new Date(0).toISOString() })
      .where(eq(schedulingEvaluations.id, reserved.evaluation.id))
      .run()
    expect(() => f.repo.dispatchEvaluation(reserved.evaluation.id)).toThrow('no longer eligible')
    f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'not_sent', physicalReleased: true })
    expect(
      f.repo.reserveEvaluation({
        handoff: node,
        provider: 'codex',
        model: 'exact-model',
        configurationFingerprint: hash('config'),
      }).status,
    ).toBe('duplicate')
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  })

  it('records more than twelve actual evaluations on one task without a cumulative evaluation cap', async () => {
    const f = await fixture()
    f.finish()
    for (let index = 0; index < 16; index++) {
      const task = f.repo.collaboration(f.sessionId)!,
        node = f.repo.workflowHandoff(task, task.reviewer)
      const result = f.repo.reserveEvaluation({
        handoff: node,
        provider: 'codex',
        model: 'exact-model',
        configurationFingerprint: hash('config'),
      })
      if (result.status !== 'reserved')
        throw Error(`Expected reservation ${index}: ${result.status}`)
      f.repo.dispatchEvaluation(result.evaluation.id)
      f.repo.settleEvaluation(result.evaluation.id, {
        outcome: 'completed',
        physicalReleased: true,
      })
      if (index < 15) {
        f.receive(f.input(`New decision ${index}`))
        const reply = f.materialize()
        f.finish(reply.run.id, {
          plan: `Complete revised plan ${index}`,
        })
      }
    }
    expect(f.repo.schedulingBudget(`task:${f.initial.id}`)?.evaluationCalls).toBe(16)
  })

  it('atomically retains task-wide extra Turn budgets across new Runs, revisions and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-scheduling-restart-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath)
    await planSupplementOpportunity(f)
    const prepared = await confirmedSupplement(f, 'supplement_plan'),
      node = prepared.handoff
    const supplement = startConfirmedSupplement(f, prepared),
      reservations = f.db.drizzle.select().from(schedulingBudgetReservations).all()
    expect(reservations).toHaveLength(1)
    const extra = reservations[0]!
    expect(extra).toMatchObject({
      handoffId: node.id,
      budget: 'extra_plan_turn',
      state: 'reserved',
      authorizationId: prepared.receipt.id,
    })
    expect(startConfirmedSupplement(f, prepared).id).toBe(supplement.id)
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toHaveLength(1)
    f.repo.settleSchedulingBudget(extra.id, 'possibly_sent')
    expect(() => f.repo.settleSchedulingBudget(extra.id, 'not_sent')).toThrow('cannot be refunded')
    f.finish(supplement.id, { plan: 'The complete clarified Plan.' })
    const returnReview = advance(f)
    f.finish(returnReview.id, { verdict: 'changes_requested' })
    const revisionAfterSupplement = advance(f)
    f.finish(revisionAfterSupplement.id, {
      plan: 'Complete revised Plan after the fixed return review.',
    })
    const exhaustedTask = f.repo.collaboration(f.sessionId)!,
      exhaustedNode = f.repo.workflowHandoff(exhaustedTask, exhaustedTask.reviewer)
    expect(f.repo.relayWorkflowSnapshot(exhaustedNode)?.node).toBe('owner_to_review')
    expect(f.repo.relaySupplementOpportunity(exhaustedNode)).toBeUndefined()
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.extraPlanTurns).toBe(1)
    const finalPlanReview = advance(f)
    f.finish(finalPlanReview.id, { verdict: 'accepted' })

    // A new input and its real reply advance the revision, while the task root keeps its allowance.
    f.receive(f.input('Preserve the clarified Plan while documenting the latest acceptance.'))
    const reply = f.materialize()
    f.finish(reply.run.id, { plan: 'Current complete Plan after the new priority input.' })
    f.repo.setCollaborationState(
      advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'resume', settings),
    )
    const after = f.repo.collaboration(f.sessionId)!,
      nextNode = f.repo.workflowHandoff(after, after.reviewer)
    expect(nextNode.id).not.toBe(node.id)
    expect(nextNode.budgetSubjectId).toBe(node.budgetSubjectId)
    expect(f.repo.relayWorkflowSnapshot(nextNode)?.node).toBe('plan_to_review')
    expect(f.repo.relaySupplementOpportunity(nextNode)).toBeUndefined()
    expect(() =>
      f.repo.reserveSchedulingBudget({
        handoff: nextNode,
        budget: 'extra_plan_turn',
        authorizationId: randomUUID(),
      }),
    ).toThrow('no current, concrete single-use user grant')
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.extraPlanTurns).toBe(1)
    const acceptedReview = advance(f)
    f.finish(acceptedReview.id, { verdict: 'accepted' })
    const implementation = advance(f, 'execute')
    f.finish(implementation.id, { answer: 'Implementation completed within the accepted scope.' })
    const codeReview = advance(f)
    f.finish(codeReview.id, { verdict: 'changes_requested' })
    const response = advance(f, 'respond')
    f.finish(response.id, { answer: 'Complete response to the first code review.' })
    const secondCodeReview = advance(f)
    f.finish(secondCodeReview.id, { verdict: 'changes_requested' })
    const code = await confirmedSupplement(f, 'supplement_code_response')
    expect(
      f.repo.reserveSchedulingBudget({
        handoff: code.handoff,
        budget: 'extra_code_turn',
        authorizationId: code.receipt.id,
      }).status,
    ).toBe('reserved')
    expect(f.repo.schedulingBudget(node.budgetSubjectId)).toMatchObject({
      extraPlanTurns: 1,
      extraCodeTurns: 1,
    })
    databases.splice(databases.indexOf(f.db), 1)
    f.db.close()
    const reopened = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.push(reopened)
    const repo = reopened.conversationRepository
    repo.recoverCollaborationTasks()
    const restored = repo.collaboration(f.sessionId)!
    expect(restored.id).toBe(prepared.task.id)
    expect(restored.automation).toBe('paused')
    expect(repo.schedulingBudget(node.budgetSubjectId)).toMatchObject({
      extraPlanTurns: 1,
      extraCodeTurns: 1,
    })
    expect(
      repo.relaySupplementOpportunity(repo.workflowHandoff(restored, restored.owner)),
    ).toBeUndefined()
  })

  it('refunds only a proven unsent budget and never erases the deduplication receipt', async () => {
    const f = await fixture()
    await planSupplementOpportunity(f)
    const prepared = await confirmedSupplement(f, 'supplement_plan'),
      node = prepared.handoff
    const extra = f.repo.reserveSchedulingBudget({
      handoff: node,
      budget: 'extra_plan_turn',
      authorizationId: prepared.receipt.id,
    })
    if (extra.status !== 'reserved') throw Error('Expected reservation')
    f.repo.settleSchedulingBudget(extra.reservation.id, 'not_sent')
    expect(
      f.repo.reserveSchedulingBudget({
        handoff: node,
        budget: 'extra_plan_turn',
        authorizationId: prepared.receipt.id,
      }),
    ).toMatchObject({
      status: 'duplicate',
      reservation: { id: extra.reservation.id, state: 'not_sent' },
    })
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.extraPlanTurns).toBe(0)
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toHaveLength(1)
  })

  it('uses stable original fault budgets, accepts only new native facts and keeps Check separate from dispatch', async () => {
    const f = await fixture()
    const first = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
    const check = f.repo.reserveSchedulingBudget({ handoff: first, budget: 'automatic_check' })
    if (check.status !== 'reserved') throw Error('Expected check reservation')
    f.repo.settleSchedulingBudget(check.reservation.id, 'settled')
    expect(
      f.repo.reserveSchedulingBudget({ handoff: first, budget: 'automatic_check' }).status,
    ).toBe('duplicate')
    f.repo.recordDispatch(f.first.run.id, 'possibly_sent', 'native-fixture')
    const second = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
    expect(second.id).not.toBe(first.id)
    expect(second.budgetSubjectId).toBe(first.budgetSubjectId)
    const again = f.repo.reserveSchedulingBudget({ handoff: second, budget: 'automatic_check' })
    if (again.status !== 'reserved') throw Error('Expected second check reservation')
    f.repo.settleSchedulingBudget(again.reservation.id, 'possibly_sent')
    f.repo.recordDispatch(f.first.run.id, 'accepted', 'native-fixture')
    const third = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
    expect(
      f.repo.reserveSchedulingBudget({ handoff: third, budget: 'automatic_check' }).status,
    ).toBe('exhausted')
    expect(f.repo.schedulingBudget(first.budgetSubjectId)?.automaticChecks).toBe(2)
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(1)
    expect(f.repo.findRun(f.first.run.id)?.dispatchPhase).toBe('accepted')
  })

  it('uses indexed bounded lookups with a representative retained history', async () => {
    const f = await fixture()
    f.finish()
    const node = f.repo.workflowHandoff(f.repo.collaboration(f.sessionId)!, 'claude')
    f.db.drizzle.transaction((transaction) => {
      for (let index = 0; index < 1_000; index++) {
        const id = hash(`historical-node-${index}`)
        transaction
          .insert(schedulingHandoffs)
          .values({
            id,
            sessionId: f.sessionId,
            budgetSubjectId: node.budgetSubjectId,
            eventId: `historical-event-${index}`,
            slot: 'workflow_next',
            factFingerprint: hash(`fact-${index}`),
            freshnessGuardJson: JSON.stringify(node.freshnessGuard),
            createdAt: f.now,
          })
          .run()
        transaction
          .insert(schedulingEvaluations)
          .values({
            id: randomUUID(),
            sessionId: f.sessionId,
            handoffId: id,
            budgetSubjectId: node.budgetSubjectId,
            factFingerprint: hash(`fact-${index}`),
            provider: 'codex',
            model: 'fixture-model',
            configurationFingerprint: hash('fixture-config'),
            handoffJson: JSON.stringify(node),
            active: false,
            called: true,
            outcome: 'completed',
            createdAt: f.now,
            deadline: f.now,
          })
          .run()
        transaction
          .insert(schedulingBudgetReservations)
          .values({
            id: randomUUID(),
            sessionId: f.sessionId,
            handoffId: id,
            budgetSubjectId: node.budgetSubjectId,
            faultSubjectId: `run:${randomUUID()}`,
            factFingerprint: hash(`fact-${index}`),
            budget: 'automatic_check',
            state: 'settled',
            createdAt: f.now,
          })
          .run()
      }
    })
    const plans = [
      f.db.drizzle.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT * FROM scheduling_handoffs WHERE id = ${node.id}`,
      ),
      f.db.drizzle.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT * FROM scheduling_evaluations WHERE budget_subject_id = ${node.budgetSubjectId} AND fact_fingerprint = ${node.factFingerprint}`,
      ),
      f.db.drizzle.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM scheduling_evaluations WHERE active = 1 LIMIT 1`,
      ),
      f.db.drizzle.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT * FROM scheduling_budget_reservations WHERE handoff_id = ${node.id} AND budget = 'automatic_check' AND replaces_reservation_id IS NULL`,
      ),
    ].map((plan) => plan.map((row) => row.detail).join('; '))
    expect(plans[0]).toContain('USING INDEX sqlite_autoindex_scheduling_handoffs_1')
    expect(plans[1]).toContain('USING INDEX scheduling_evaluations_fact')
    expect(plans[2]).toContain('USING INDEX scheduling_evaluations_active_app')
    expect(plans[3]).toContain('USING INDEX scheduling_budget_reservations_handoff')
    expect(plans.every((plan) => plan.startsWith('SEARCH'))).toBe(true)
  })
})

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
  const clientMessageId = randomUUID()
  const prepared = ['execute', 'repair', 'respond'].includes(action)
    ? f.repo.prepareCollaborationAction(
        {
          sessionId: f.sessionId,
          taskId: current.id,
          revision: current.revision,
          clientMessageId,
          action,
        },
        settings,
      )
    : undefined
  const next = prepared?.next ?? advanceCollaboration(current, action, settings)
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId,
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
    ...(prepared
      ? { schedulingHandoff: prepared.handoff, collaborationActionReceiptId: prepared.receipt.id }
      : {}),
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
  const ready = f.repo.collaboration(f.sessionId)!
  expect(() =>
    f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'An unreceipted implementation must not start.',
      commentIds: [],
      expectedCommentsRevision: f.drafts().commentsRevision,
      agentId: ready.owner,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: ready.revision,
      collaboration: advanceCollaboration(ready, 'execute', settings),
    }),
  ).toThrow('original concrete user receipt')
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
  expect(reply.run.agentId).toBe('claude')
  f.finish(reply.run.id, { inputOutcome: 'processed' })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled.inputProcessing?.decision).toBeUndefined()
  expect(settled.inputProcessing?.pending).toBeUndefined()
  expect(settled).toMatchObject({
    automation: 'paused',
    planInputSequence: 1,
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(advanceCollaboration(settled, 'resume', settings)).toMatchObject({
    automation: 'active',
    nextStage: 'plan',
  })
})

it('retains unresolved questions when a reply fails to provide its authenticated plan', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Choose scope', selection: 'single' }],
  })
  const decision = f.repo.collaboration(f.sessionId)!.inputProcessing!.decision!
  f.receive(decisionInput(f, 'Current scope.'))
  const reply = f.materialize()
  f.finish(reply.run.id, { answer: 'Acknowledged, without a native plan.' })
  const current = f.repo.collaboration(f.sessionId)!
  expect(current.inputProcessing?.decision).toEqual(decision)
  expect(current.inputProcessing?.pending).toMatchObject({ inputSequence: 2 })
  expect(current).toMatchObject({ status: 'failed', automation: 'paused' })
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
      /questions changed|card answers|could not be verified/,
    )
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
    expect(f.repo.readReceivedInput(f.sessionId)).toBeUndefined()
    expect(f.repo.read(f.sessionId).messages).toHaveLength(messageCount)
  }
  const accepted = f.receive(valid)
  expect(accepted.patch.receivedInputIds).toEqual([valid.clientMessageId])
  expect(() => f.receive({ ...valid, clientMessageId: randomUUID() })).toThrow(
    /could not be verified/,
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

it('fails a plan with no native result without inventing questions or a restore source', async () => {
  const f = await fixture()
  f.finish(undefined, { answer: 'I cannot provide a plan yet.' })
  const current = f.repo.collaboration(f.sessionId)!
  expect(current).toMatchObject({
    status: 'failed',
    automation: 'paused',
    pauseReason: 'failure',
    planVersion: 0,
  })
  expect(current.inputProcessing?.decision).toBeUndefined()
  expect(f.repo.needsWorkflowPlanRecovery(f.first.run.id)).toBe(false)
})

it.each(['present', 'legacy'] as const)(
  'verifies the decision source actor when its stored actor is %s',
  async (kind) => {
    const f = await fixture()
    f.finish()
    const review = advance(f)
    f.finish(review.id, {
      verdict: 'needs_user',
      questions: [{ prompt: 'Which scope?', selection: 'single' }],
    })
    const current = f.repo.collaboration(f.sessionId)!
    const decision = current.inputProcessing!.decision!
    if (kind !== 'present') {
      f.repo.setCollaborationState({
        ...current,
        revision: current.revision + 1,
        inputProcessing: {
          ...current.inputProcessing,
          decision: { ...decision, actor: undefined },
        },
      })
    }
    f.receive(decisionInput(f, 'Current scope.'))
    expect(f.repo.readReceivedInput(f.sessionId)?.actor).toBe('claude')
    const reply = f.materialize()
    expect(reply.run.agentId).toBe('claude')
    expect(() =>
      f.repo.recordWorkflowPlan(reply.run.id, {
        nativeId: 'foreign-plan',
        text: 'Cannot write a plan',
      }),
    ).toThrow(/plan author/)
    f.finish(reply.run.id, { inputOutcome: 'processed' })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      status: 'waiting',
      automation: 'paused',
      planVersion: 1,
      inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
    })
  },
)

it('restores the exact author reply and settles its answer once without rerunning it', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Scope?', selection: 'single' }],
  })
  f.receive(decisionInput(f, 'Current scope.'))
  const reply = f.materialize()
  f.repo.recordWorkflowPlanUnavailable(reply.run.id)
  f.finish(reply.run.id, { answer: 'Saved the plan but submission failed.' })
  expect(f.repo.needsWorkflowPlanRecovery(reply.run.id)).toBe(true)
  expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.pending).toBeDefined()
  f.repo.recordWorkflowPlan(reply.run.id, {
    nativeId: 'recovered-author-plan',
    text: 'Current scope.',
  })
  f.repo.reconcileCompletedCollaboration(reply.run.id)
  const restored = f.repo.collaboration(f.sessionId)!
  expect(restored).toMatchObject({
    status: 'waiting',
    automation: 'paused',
    planInputSequence: 2,
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(restored.inputProcessing?.decision).toBeUndefined()
  expect(restored.inputProcessing?.pending).toBeUndefined()
  expect(f.repo.read(f.sessionId).runs).toHaveLength(2)
  f.repo.reconcileCompletedCollaboration(reply.run.id)
  expect(f.repo.collaboration(f.sessionId)).toEqual(restored)
})

it('does not clear real unanswered questions when a native plan is recovered', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Scope?', selection: 'single' }],
  })
  const before = f.repo.collaboration(f.sessionId)!
  f.repo.recordWorkflowPlan(f.first.run.id, {
    nativeId: 'late-with-questions',
    text: 'Draft awaiting scope.',
  })
  f.repo.reconcileCompletedCollaboration(f.first.run.id)
  const current = f.repo.collaboration(f.sessionId)!
  expect(current).toMatchObject({ status: 'questions', planVersion: 0, automation: 'paused' })
  expect(current.inputProcessing?.decision).toEqual(before.inputProcessing?.decision)
  expect(f.repo.needsWorkflowPlanRecovery(f.first.run.id)).toBe(false)
  expect(() => advanceCollaboration(current, 'resume', settings)).toThrow(/Reply/)
})

it('keeps a reviewer reply incomplete until its late authenticated result arrives', async () => {
  const f = await fixture()
  f.finish()
  const review = advance(f)
  f.finish(review.id, {
    verdict: 'needs_user',
    questions: [{ prompt: 'Scope?', selection: 'single' }],
  })
  const decision = f.repo.collaboration(f.sessionId)!.inputProcessing!.decision!
  f.receive(decisionInput(f, 'Current scope.'))
  const reply = f.materialize()
  f.finish(reply.run.id, { answer: 'Natural language is not settlement evidence.' })
  const failed = f.repo.collaboration(f.sessionId)!
  expect(failed).toMatchObject({ status: 'failed', automation: 'paused' })
  expect(failed.inputProcessing?.decision).toEqual(decision)
  expect(failed.inputProcessing?.pending).toMatchObject({ inputSequence: 2 })
  expect(() => advanceCollaboration(failed, 'resume', settings)).toThrow(/Reply/)
  f.repo.recordWorkflowInputResult(reply.run.id, { outcome: 'processed' })
  f.repo.reconcileCompletedCollaboration(reply.run.id)
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({
    status: 'waiting',
    automation: 'paused',
    nextStage: 'plan',
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(settled.inputProcessing?.pending).toBeUndefined()
  expect(settled.inputProcessing?.decision).toBeUndefined()
  f.repo.reconcileCompletedCollaboration(reply.run.id)
  expect(f.repo.collaboration(f.sessionId)).toEqual(settled)
})

it('rejects a decision whose recorded actor conflicts with its authorized source', async () => {
  const f = await fixture()
  f.finish()
  const review = advance(f)
  f.finish(review.id, {
    verdict: 'needs_user',
    questions: [{ prompt: 'Scope?', selection: 'single' }],
  })
  const current = f.repo.collaboration(f.sessionId)!
  f.repo.setCollaborationState({
    ...current,
    revision: current.revision + 1,
    inputProcessing: {
      ...current.inputProcessing,
      decision: { ...current.inputProcessing!.decision!, actor: 'codex' },
    },
  })
  const before = f.repo.collaboration(f.sessionId)!
  expect(() => f.receive(decisionInput(f, 'Current scope.'))).toThrow(/could not be verified/)
  expect(f.repo.collaboration(f.sessionId)).toEqual(before)
  expect(f.repo.readReceivedInput(f.sessionId)).toBeUndefined()
})

it('does not settle a recovered author reply over a newer received answer', async () => {
  const f = await fixture()
  f.finish(undefined, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Scope?', selection: 'single' }],
  })
  f.receive(decisionInput(f, 'Current scope.'))
  const reply = f.materialize()
  f.repo.recordWorkflowPlanUnavailable(reply.run.id)
  f.finish(reply.run.id, { answer: 'Saved source awaiting recovery.' })
  const newer = f.receive(decisionInput(f, 'Actually include all scopes.'))
  const before = f.repo.collaboration(f.sessionId)!
  f.repo.recordWorkflowPlan(reply.run.id, { nativeId: 'stale-reply-plan', text: 'Current scope.' })
  f.repo.reconcileCompletedCollaboration(reply.run.id)
  expect(f.repo.collaboration(f.sessionId)).toEqual(before)
  expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.settled).toBeUndefined()
  expect(f.repo.readReceivedInput(f.sessionId)?.id).toBe(newer.send.clientMessageId)
  expect(f.repo.needsWorkflowPlanRecovery(reply.run.id)).toBe(false)
})

it('bounds the complete evaluation row before dispatch and preserves every previously observed physical identity', async () => {
  const f = await fixture()
  f.finish()
  const task = f.repo.collaboration(f.sessionId)!,
    node = f.repo.workflowHandoff(task, task.reviewer)
  const reserved = f.repo.reserveEvaluation({
    handoff: node,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: hash('original'),
  })
  if (reserved.status !== 'reserved') throw Error('Expected evaluation')
  const id = reserved.evaluation.id,
    ownerId = randomUUID()
  const witness = {
    version: 1 as const,
    platform: 'darwin' as const,
    ownerId,
    owner: { pid: 1, started: 'birth' },
    root: { pid: 2, pgid: 2, started: 'birth' },
    members: [
      { pid: 2, pgid: 2, started: 'birth' },
      { pid: 3, pgid: 2, started: 'birth' },
    ],
  }
  f.repo.recordEvaluationPhysicalWitness(id, { witness, configurationFingerprint: hash('native') })
  expect(() =>
    f.repo.recordEvaluationPhysicalWitness(id, {
      witness: { ...witness, members: witness.members.slice(0, 1) },
      configurationFingerprint: hash('native'),
    }),
  ).toThrow('owner changed')
  const before = f.db.drizzle.select().from(schedulingEvaluations).get()!
  const quoted = '"'.repeat(64)
  const large = {
    ...witness,
    owner: { pid: 1, started: quoted },
    root: { pid: 2, pgid: 2, started: quoted },
    members: Array.from({ length: 8 }, (_, i) => ({ pid: i + 2, pgid: 2, started: quoted })),
  }
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(2048)
  // Use a fresh reservation: owner replacement has a separate, stronger rejection.
  f.repo.settleEvaluation(id, { outcome: 'not_sent', physicalReleased: true })
  const fault = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
  const other = f.repo.reserveEvaluation({
    handoff: fault,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: hash('other'),
  })
  if (other.status !== 'reserved') throw Error('Expected distinct evaluation')
  expect(() =>
    f.repo.recordEvaluationPhysicalWitness(other.evaluation.id, {
      witness: large,
      configurationFingerprint: hash('native'),
    }),
  ).toThrow('metadata capacity')
  expect(
    f.db.drizzle
      .select()
      .from(schedulingEvaluations)
      .where(eq(schedulingEvaluations.id, other.evaluation.id))
      .get(),
  ).toMatchObject({ called: false, physicalWitnessJson: null })
  expect(
    f.db.drizzle.select().from(schedulingEvaluations).where(eq(schedulingEvaluations.id, id)).get()
      ?.physicalWitnessJson,
  ).toBe(before.physicalWitnessJson)
  expect(f.repo.schedulingBudget(node.budgetSubjectId)).toBeUndefined()
})

it('keeps unknown old evaluations active without replay and reads the active owner through the bounded partial index', async () => {
  const f = await fixture()
  f.finish()
  const task = f.repo.collaboration(f.sessionId)!,
    node = f.repo.workflowHandoff(task, task.reviewer)
  const reserved = f.repo.reserveEvaluation({
    handoff: node,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: hash('native'),
  })
  if (reserved.status !== 'reserved') throw Error('Expected evaluation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.recoverInterruptedRuns()
  expect(f.repo.activeEvaluation()).toMatchObject({
    id: reserved.evaluation.id,
    sessionId: f.sessionId,
    called: true,
    physicalWitnessJson: null,
  })
  expect(
    f.repo.reserveEvaluation({
      handoff: node,
      provider: 'codex',
      model: 'gpt-6-luna',
      configurationFingerprint: hash('new config'),
    }).status,
  ).toBe('duplicate')
  const plan = f.db.drizzle.all(
    sql`EXPLAIN QUERY PLAN SELECT id,session_id,called,outcome,physical_witness_json FROM scheduling_evaluations WHERE active=1 LIMIT 1`,
  )
  console.info('Active decision owner SQL plan', JSON.stringify(plan))
  expect(JSON.stringify(plan)).toContain('scheduling_evaluations_active')
  expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls).toBe(1)
})
