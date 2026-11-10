import { and, eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  collaborationActor,
  collaborationActionBasisSchema,
  collaborationDocumentSchema,
  CONVERSATION_PATCH_BYTES,
  conversationPatchSchema,
  collaborationTaskSchema,
  decisionInputSchema,
  type CollaborationDocument,
  type ConversationSendInput,
  type CollaborationTask,
  type FrozenExecutionEnvelope,
  type SchedulingHandoff,
} from '@pact/contracts'

import type { HandoffSourceRef } from './conversation-repository.js'

import {
  configureDecisionFixtureCredential,
  decisionHttpOwnerFixture,
  seedHistoricalDecisionEvaluation,
} from './decision-fixture.test-support.js'
import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  collaborationTasks,
  conversationBodyInputs,
  conversationImageAssets,
  conversationInputBatchMembers,
  conversationRunSourceRefs,
  schedulingHandoffs,
  schedulingEvaluations,
  schedulingRuntimeOwners,
  schedulingBudgetReservations,
  workflowTurns,
  collaborationActionReceipts,
  runReexecutionOperations,
  agentEventJournal,
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

function ensureDecisionFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const current = f.repo.schedulingSettings()
  if (!current.enabled)
    f.repo.saveSchedulingSettings({ expectedRevision: current.revision, enabled: true })
  if (!f.repo.schedulingSettings().credential.configured) configureDecisionFixtureCredential(f.repo)
}

function evaluationInput(handoff: SchedulingHandoff) {
  const text = JSON.stringify(handoff)
  return decisionInputSchema.parse({
    version: 1,
    handoff,
    objective: 'Check the supplied scheduling fact.',
    candidates: [{ id: 'wait', description: 'Keep the current workflow.' }],
    sources: [{ id: 'handoff', digest: hash(text), text }],
  })
}

function evaluationArgs(f: Awaited<ReturnType<typeof fixture>>, handoff: SchedulingHandoff) {
  const input = evaluationInput(handoff)
  return {
    handoff,
    configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
    inputSha256: hash(JSON.stringify(input)),
    deadlineAt: Date.now() + 15_000,
    httpOwner: decisionHttpOwnerFixture(),
  }
}
async function fixture(
  filePath = ':memory:',
  onOpened?: () => void,
  roles: {
    primary: 'codex' | 'claude'
    split?: boolean
    inputSequence?: number
    nativeSessionId?: string
  } = {
    primary: 'codex',
  },
) {
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
    { ...settings, primaryAgentId: roles.primary },
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: roles.primary,
    reviewer: roles.primary === 'codex' ? 'claude' : 'codex',
    ...(roles.split ? { rolePolicy: 'split-stages-v1' } : {}),
    automation: 'active',
    inputSequence: roles.inputSequence ?? 0,
    handledInputSequence: 0,
    task: 'Review cancellation.',
    taskMessageId: messageId,
    stage: 'plan',
    actor: roles.primary,
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
    agentId: roles.primary,
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
      inputOutcome?: import('@pact/contracts').CollaborationInputOutcome
      inputObservations?: import('@pact/contracts').CollaborationInputOutcome[]
      outcome?: 'completed' | 'interrupted'
      answer?: string
    } = { plan: 'Scope and acceptance.' },
    settleEffects = true,
  ) => {
    const run = repo.findRun(runId)!,
      nativeSessionId = roles.nativeSessionId ?? `fixture-${run.agentId}`,
      nativeTurnId = roles.nativeSessionId ? runId : `turn-${runId}`
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: run.agentId,
      nativeSessionId,
    })
    repo.applyEvent(sessionId, runId, {
      type: 'turn.started',
      agentId: run.agentId,
      turnId: nativeTurnId,
    })
    if (result.plan)
      repo.recordWorkflowPlan(runId, { nativeId: `plan-${runId}`, text: result.plan })
    if (result.verdict)
      repo.recordWorkflowReview(runId, {
        verdict: result.verdict,
        ...(result.questions ? { questions: result.questions } : {}),
      })
    for (const outcome of result.inputObservations ??
      (result.inputOutcome ? [result.inputOutcome] : []))
      repo.recordWorkflowInputResult(runId, {
        outcome,
        ...(result.questions ? { questions: result.questions } : {}),
      })
    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId: nativeTurnId,
      outputId: `answer-${runId}`,
      text: result.answer ?? 'Checked current scope.',
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: result.outcome ?? 'completed',
      identity: {
        sessionId,
        agentId: run.agentId,
        requestId: runId,
        runId,
        nativeSessionId,
        nativeTurnId,
        bindingGeneration: run.bindingGeneration ?? 1,
      },
    })
    if (settleEffects) repo.recordNativeEffects(runId, 'settled')
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId: nativeTurnId,
      outcome: result.outcome ?? 'completed',
    })
    if (settleEffects) repo.recordNativeEffects(runId, 'settled')
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
  const receive = (send = input(), actor?: 'codex' | 'claude') => {
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
      actor ?? repo.collaborationReplyActor(repo.collaboration(sessionId)!, send.replyToDecision),
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
  ensureDecisionFixture(f)
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
  ensureDecisionFixture(f)
  const owner = decisionHttpOwnerFixture(),
    configurationFingerprint = f.repo.schedulingConfigurationFingerprint()
  const task = f.repo.collaboration(f.sessionId)!,
    handoff = f.repo.workflowHandoff(
      task,
      collaborationActor(task, kind === 'supplement_plan' ? 'plan_review' : 'respond'),
    ),
    candidateId = `propose_${kind}`,
    deadlineAt = Date.now() + 15_000
  expect(
    f.repo.relayWorkflowAlternatives(handoff)?.alternatives.find((e) => e.kind === kind)?.kind,
  ).toBe(kind)
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
    configurationFingerprint,
    deadlineAt,
    inputSha256: material.inputSha256,
    httpOwner: owner,
  })
  if (reserved.status !== 'reserved') throw Error('Expected the original model evaluation')
  f.repo.dispatchEvaluation(reserved.evaluation.id, owner)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: candidateId,
    httpOwner: owner,
    remoteOutcome: 'responded',
  })
  const card = f.repo.proposeRelayWorkflowAction({
    handoff,
    kind,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint,
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    sourceIds: material.sources.map((source) => source.id),
  })
  expect(
    f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.handoffId, handoff.id))
      .all(),
  ).toEqual([])
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

  it('deduplicates the same evaluation facts across credential changes and retains physical capacity after logical failure', async () => {
    const f = await fixture()
    ensureDecisionFixture(f)
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      node = f.repo.workflowHandoff(task, task.reviewer)
    const args = evaluationArgs(f, node),
      owner = args.httpOwner
    const reserved = f.repo.reserveEvaluation(args)
    if (reserved.status !== 'reserved') throw Error('Expected a reservation')
    expect(f.repo.dispatchEvaluation(reserved.evaluation.id, owner).created).toBe(true)
    expect(f.repo.dispatchEvaluation(reserved.evaluation.id, owner).created).toBe(false)
    f.repo.settleEvaluation(reserved.evaluation.id, {
      outcome: 'failed',
      physicalReleased: false,
      httpOwner: owner,
      remoteOutcome: 'unknown',
    })
    expect(() =>
      f.repo.settleEvaluation(reserved.evaluation.id, {
        outcome: 'not_sent',
        physicalReleased: true,
        httpOwner: owner,
        remoteOutcome: 'unknown',
      }),
    ).toThrow('cannot be refunded')
    configureDecisionFixtureCredential(f.repo)
    expect(
      f.repo.reserveEvaluation(evaluationArgs(f, f.repo.workflowHandoff(task, task.reviewer)))
        .status,
    ).toBe('duplicate')
    const fault = f.repo.recoveryHandoff({ kind: 'run', id: f.first.run.id })
    expect(f.repo.reserveEvaluation(evaluationArgs(f, fault)).status).toBe('busy')
    f.repo.settleEvaluation(reserved.evaluation.id, {
      outcome: 'failed',
      physicalReleased: true,
      usage: { inputTokens: 12, outputTokens: 3 },
      httpOwner: owner,
      remoteOutcome: 'unknown',
    })
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(f.repo.reserveEvaluation(evaluationArgs(f, fault)).status).toBe('reserved')
  })

  it('rejects stale/expired invocation and preserves same-fact deduplication after a proven unsent evaluation', async () => {
    const f = await fixture()
    ensureDecisionFixture(f)
    f.finish()
    const task = f.repo.collaboration(f.sessionId)!,
      node = f.repo.workflowHandoff(task, task.reviewer)
    const args = evaluationArgs(f, node)
    const reserved = f.repo.reserveEvaluation(args)
    if (reserved.status !== 'reserved') throw Error('Expected a reservation')
    f.db.drizzle
      .update(schedulingEvaluations)
      .set({ deadline: new Date(0).toISOString() })
      .where(eq(schedulingEvaluations.id, reserved.evaluation.id))
      .run()
    f.db.drizzle
      .update(schedulingRuntimeOwners)
      .set({ deadline: new Date(0).toISOString() })
      .where(eq(schedulingRuntimeOwners.id, reserved.evaluation.id))
      .run()
    expect(() => f.repo.dispatchEvaluation(reserved.evaluation.id, args.httpOwner)).toThrow(
      'no longer eligible',
    )
    f.repo.settleEvaluation(reserved.evaluation.id, {
      outcome: 'not_sent',
      physicalReleased: true,
      httpOwner: args.httpOwner,
      remoteOutcome: 'not_sent',
    })
    expect(f.repo.reserveEvaluation(evaluationArgs(f, node)).status).toBe('duplicate')
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
  })

  it('records more than twelve actual evaluations on one task without a cumulative evaluation cap', async () => {
    const f = await fixture()
    ensureDecisionFixture(f)
    f.finish()
    for (let index = 0; index < 16; index++) {
      const task = f.repo.collaboration(f.sessionId)!,
        node = f.repo.workflowHandoff(task, task.reviewer)
      const args = evaluationArgs(f, node)
      const result = f.repo.reserveEvaluation(args)
      if (result.status !== 'reserved')
        throw Error(`Expected reservation ${index}: ${result.status}`)
      f.repo.dispatchEvaluation(result.evaluation.id, args.httpOwner)
      f.repo.settleEvaluation(result.evaluation.id, {
        outcome: 'completed',
        physicalReleased: true,
        httpOwner: args.httpOwner,
        remoteOutcome: 'responded',
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
    expect(f.repo.relayWorkflowAlternatives(exhaustedNode)).toBeUndefined()
    expect(f.repo.schedulingBudget(node.budgetSubjectId)?.extraPlanTurns).toBe(1)
    const finalPlanReview = advance(f)
    f.finish(finalPlanReview.id, { verdict: 'accepted' })

    // A new input and its real reply advance the revision, while the task root keeps its allowance.
    f.receive(f.input('Preserve the clarified Plan while documenting the latest acceptance.'))
    const reply = f.materialize()
    f.finish(reply.run.id, { plan: 'Current complete Plan after the new priority input.' })
    expect(f.repo.collaboration(f.sessionId)?.automation).toBe('active')
    const after = f.repo.collaboration(f.sessionId)!,
      nextNode = f.repo.workflowHandoff(after, after.reviewer)
    expect(nextNode.id).not.toBe(node.id)
    expect(nextNode.budgetSubjectId).toBe(node.budgetSubjectId)
    expect(f.repo.relayWorkflowSnapshot(nextNode)?.node).toBe('plan_to_review')
    expect(f.repo.relayWorkflowAlternatives(nextNode)).toBeUndefined()
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
      repo.relayWorkflowAlternatives(repo.workflowHandoff(restored, restored.owner)),
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
  action: 'continue' | 'execute' | 'repair' | 'respond' | 'resume' = 'continue',
  handoffSourceRefs?: HandoffSourceRef[],
) {
  const current = f.repo.collaboration(f.sessionId)!
  const clientMessageId = randomUUID()
  const prepared = ['execute', 'repair', 'respond', 'resume'].includes(action)
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
    ...(handoffSourceRefs ? { handoffSourceRefs } : {}),
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

it.each(['valid', 'source_owner', 'source_binding', 'changed_input', 'changed_body'] as const)(
  'authenticates only the current Claude planner frozen published checkpoint: %s',
  async (mode) => {
    const nativeSessionId = randomUUID(),
      f = await fixture(undefined, undefined, { primary: 'claude', nativeSessionId })
    expect(f.repo.workflowPlanCheckpoint(f.first.run.id, nativeSessionId)).toBeUndefined()
    f.finish()
    const basis = f.repo.collaboration(f.sessionId)!.planReference!
    const review = advance(f)
    f.finish(review.id, { verdict: 'accepted' })
    f.receive()
    const reply = f.materialize()
    const source = f.repo.workflowPlanCheckpoint(reply.run.id, nativeSessionId)!
    expect(source.checkpoint).toMatchObject({
      targetRunId: reply.run.id,
      targetNativeTurnId: reply.run.id,
      nativeSessionId,
      bindingGeneration: 1,
      basis,
      sourceNativeTurnId: f.first.run.id,
    })
    expect(f.repo.workflowPlanCheckpoint(reply.run.id, randomUUID())).toBeUndefined()
    if (mode === 'source_owner')
      f.db.drizzle
        .update(conversationBodyInputs)
        .set({ ownerKey: `collaboration:${randomUUID()}` })
        .where(eq(conversationBodyInputs.id, basis.document.id))
        .run()
    if (mode === 'source_binding')
      f.db.drizzle
        .update(agentRuns)
        .set({ bindingGeneration: 2 })
        .where(eq(agentRuns.id, f.first.run.id))
        .run()
    if (mode === 'changed_input') f.receive(f.input('A newer decision.'))
    if (mode === 'changed_body')
      f.db.drizzle.run(
        sql`UPDATE conversation_body_parts SET text='Corrupted saved source' WHERE input_id=${basis.document.id}`,
      )
    const result = await source.read(new AbortController().signal).then(
      (text) => ({ text }),
      (error: unknown) => ({ error }),
    )
    const failure = {
      error: expect.objectContaining({
        message: expect.stringMatching(/source changed|body changed/iu),
      }),
    }
    expect(result).toEqual(mode === 'valid' ? { text: 'Scope and acceptance.' } : failure)
  },
)

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
    automation: 'active',
    status: 'waiting',
    inputProcessing: { pending: { inputId: received.send.clientMessageId, inputSequence: 2 } },
  })
  const reply = f.materialize()
  f.finish(reply.run.id, { plan: 'Updated plan respecting the new decision.' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planVersion: 1,
    planInputSequence: 2,
    automation: 'active',
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.pending).toBeUndefined()
  expect(advance(f).collaboration?.stage).toBe('plan_review')
})

it('waits for the latest reply before automatically reviewing its exact plan', async () => {
  const f = await fixture()
  f.finish()
  f.receive(f.input('First correction.'))
  const first = f.materialize()
  const latest = f.receive(f.input('Second correction.'))
  f.finish(first.run.id, { plan: 'Only the first correction.' })
  const pending = f.repo.collaboration(f.sessionId)!
  expect(pending).toMatchObject({
    status: 'waiting',
    automation: 'active',
    planVersion: 1,
    inputProcessing: {
      pending: { inputId: latest.send.clientMessageId, inputSequence: 3 },
    },
  })
  expect(() => advance(f)).toThrow(/Reply/)
  const last = f.materialize()
  f.finish(last.run.id, { plan: 'Both corrections, complete current plan.' })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({
    status: 'waiting',
    automation: 'active',
    planVersion: 2,
    planInputSequence: 3,
    inputProcessing: { settled: { runId: last.run.id, inputSequence: 3 } },
  })
  const review = advance(f)
  expect(review.collaboration?.stage).toBe('plan_review')
  expect(f.repo.collaborationTurnAuthorization(review.id)?.planReference).toEqual(
    settled.planReference,
  )
})

it('does not hide a failed native plan capture behind newer input', async () => {
  const f = await fixture()
  f.repo.recordWorkflowPlanUnavailable(f.first.run.id)
  f.receive()
  f.finish(f.first.run.id, { answer: 'The native plan capture failed.' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'failed',
    automation: 'paused',
    pauseReason: 'failure',
    planVersion: 0,
  })
  const reply = f.materialize()
  f.finish(reply.run.id, { plan: 'Confirmed current plan.' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    status: 'waiting',
    automation: 'paused',
    pauseReason: 'failure',
    planVersion: 1,
  })
  expect(() => advance(f)).toThrow(/Continue collaboration/)
})

it.each(['user', 'stopped', 'failure', 'restart', 'limit', 'user_message', 'needs_user'] as const)(
  'preserves an existing %s pause through new input and successful plan settlement',
  async (reason) => {
    const f = await fixture()
    f.finish()
    f.repo.pauseCollaboration(f.sessionId, reason)
    f.receive()
    const reply = f.materialize()
    f.finish(reply.run.id, { plan: 'Updated complete plan.' })
    const task = f.repo.collaboration(f.sessionId)!
    expect(task).toMatchObject({ automation: 'paused', pauseReason: reason, planVersion: 2 })
    expect(task.inputProcessing?.pending).toBeUndefined()
    expect(() => advance(f)).toThrow(/Continue collaboration/)
  },
)

it.each(['user', 'stopped', 'restart'] as const)(
  'preserves a concurrent %s pause while the reply completes or asks another question',
  async (reason) => {
    const f = await fixture()
    f.finish()
    f.receive()
    const reply = f.materialize()
    f.repo.pauseCollaboration(f.sessionId, reason)
    f.finish(reply.run.id, {
      inputOutcome: 'needs_user',
      questions: [{ prompt: 'Which remaining scope?', selection: 'single' }],
    })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      status: 'questions',
      automation: 'paused',
      pauseReason: reason,
    })
    f.receive(decisionInput(f, 'Current scope.'))
    const followup = f.materialize()
    f.finish(followup.run.id, { plan: 'Current complete plan.' })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      status: 'waiting',
      automation: 'paused',
      pauseReason: reason,
    })
    expect(() => advance(f)).toThrow(/Continue collaboration/)
  },
)

it.each(['remove', 'return', 'cancel'] as const)(
  'requires reconciliation when %s withdraws a newer workflow input',
  async (action) => {
    const f = await fixture()
    f.finish()
    const queued = f.receive()
    const request = {
      sessionId: f.sessionId,
      inputId: queued.send.clientMessageId,
      expectedRevision: f.repo.queueState(f.sessionId).revision,
      operationId: randomUUID(),
    }
    if (action === 'remove') f.repo.removeQueuedConversationMessage(request)
    else if (action === 'return')
      f.repo.returnQueuedConversationMessage({ ...request, phase: 'return' })
    else f.repo.setReceivedInputState(f.sessionId, 'cancelled', request.inputId)
    const task = f.repo.collaboration(f.sessionId)!
    expect(task).toMatchObject({ automation: 'paused', pauseReason: 'failure', inputSequence: 2 })
    expect(task.planInputSequence).toBe(1)
    expect(f.repo.pendingWorkflowTasks()).toEqual([])
    expect(() => advance(f)).toThrow(/Continue collaboration/)
    expect(f.repo.read(f.sessionId).runs).toHaveLength(1)
  },
)

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
    automation: 'active',
    planInputSequence: 1,
    inputProcessing: { settled: { runId: reply.run.id, inputSequence: 2 } },
  })
  expect(advance(f).collaboration?.stage).toBe('plan')
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
        confirmation: 'native_root_settled_v1',
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
    expect(current.automation).toBe('active')
    expect(current.review?.inputSequence).toBe(1)
    expect(current.nextStage).toBe('plan_review')
    expect(() => advanceCollaboration(current, 'execute', settings)).toThrow(/not been accepted/)
    expect(current.planReference?.sourceRunId).toBe(
      kind === 'retained' ? original.sourceRunId : reply.run.id,
    )
  },
)

it.each(['confirmed', 'legacy', 'missing'] as const)(
  'cold reply settlement requires a final retention confirmation: %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-retained-plan-cold-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath)
    f.finish()
    const reference = f.repo.collaboration(f.sessionId)!.planReference!
    const review = advance(f)
    f.finish(review.id, { verdict: 'accepted' })
    f.receive()
    const reply = f.materialize()
    const hasCandidate = mode === 'confirmed'
    if (mode !== 'missing')
      f.repo.recordWorkflowPlanRetained(reply.run.id, {
        nativeId: 'authenticated-retention',
        ...(hasCandidate ? { confirmation: 'native_root_settled_v1' as const } : {}),
        sha256: reference.document.sha256,
        bytes: reference.document.bytes,
        chars: reference.document.chars,
      })
    if (hasCandidate) {
      f.repo.recordWorkflowPlanRetained(reply.run.id, {
        nativeId: 'stale-cold-candidate',
        sha256: 'f'.repeat(64),
        bytes: 1,
        chars: 1,
      })
    }
    f.finish(reply.run.id, { answer: 'The frozen plan remains appropriate.' }, false)
    expect(f.repo.collaboration(f.sessionId)!.inputProcessing?.pending).toBeDefined()
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const cold = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.push(cold)
    const repo = cold.conversationRepository
    repo.recoverCollaborationTasks()
    // A saved native ending alone cannot establish that effects have finished.
    expect(repo.collaboration(f.sessionId)!.inputProcessing?.pending).toBeDefined()
    repo.recordNativeEffects(reply.run.id, 'settled')
    repo.reconcileCompletedCollaboration(reply.run.id)
    const settled = repo.collaboration(f.sessionId)!
    expect(settled.planReference).toEqual(reference)
    expect(settled.automation).toBe('paused')
    expect(settled.inputProcessing?.pending === undefined).toBe(hasCandidate)
    expect(settled.planInputSequence).toBe(hasCandidate ? 2 : 1)
    expect(settled.review?.inputSequence).toBe(1)
    expect(repo.read(f.sessionId).runs).toHaveLength(3)
    repo.reconcileCompletedCollaboration(reply.run.id)
    expect(repo.collaboration(f.sessionId)).toEqual(settled)
    const facts = cold.drizzle.get<{ count: number }>(
      sql`select count(*) as count from agent_event_journal where run_id=${reply.run.id} and event_type='workflow.plan_settled'`,
    )
    expect(facts?.count).toBe(hasCandidate ? 1 : 0)
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
      automation: 'active',
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
  expect(current).toMatchObject({ status: 'questions', planVersion: 0, automation: 'active' })
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

it('keeps unknown old evaluations active without replay and reads the active owner through the bounded partial index', async () => {
  const f = await fixture()
  ensureDecisionFixture(f)
  f.finish()
  const task = f.repo.collaboration(f.sessionId)!,
    node = f.repo.workflowHandoff(task, task.reviewer)
  const id = seedHistoricalDecisionEvaluation(f.db, evaluationInput(node), null)
  f.repo.recoverInterruptedRuns()
  expect(f.repo.activeEvaluation()).toMatchObject({
    id,
    sessionId: f.sessionId,
    called: true,
    physicalWitnessJson: null,
  })
  expect(f.repo.reserveEvaluation(evaluationArgs(f, node)).status).toBe('duplicate')
  const plan = f.db.drizzle.all(
    sql`EXPLAIN QUERY PLAN SELECT id,session_id,called,outcome,physical_witness_json FROM scheduling_evaluations WHERE active=1 LIMIT 1`,
  )
  console.info('Active decision owner SQL plan', JSON.stringify(plan))
  expect(JSON.stringify(plan)).toContain('scheduling_evaluations_active')
  expect(f.repo.schedulingBudget(node.budgetSubjectId)?.evaluationCalls).toBe(1)
})

describe('Split collaboration stage responsibilities', () => {
  it.each(['codex', 'claude'] as const)(
    'binds planning, both reviews, implementation and repair to the frozen %s Primary',
    async (primary) => {
      const secondary = primary === 'codex' ? 'claude' : 'codex'
      const f = await fixture(':memory:', undefined, { primary, split: true })
      expect(f.first.run.agentId).toBe(primary)
      f.finish()
      const plan = f.repo.collaboration(f.sessionId)!.planReference!
      const refuseSelfReview = () => {
        const current = f.repo.collaboration(f.sessionId)!
        const next = advanceCollaboration(current, 'continue', settings)
        const wrong = next.actor === 'codex' ? 'claude' : 'codex'
        const runs = f.repo.read(f.sessionId).runs.length
        expect(() =>
          f.repo.beginRun({
            sessionId: f.sessionId,
            clientMessageId: randomUUID(),
            content: 'Wrong reviewer',
            commentIds: [],
            expectedCommentsRevision: f.drafts().commentsRevision,
            agentId: wrong,
            settingsRevision: 1,
            model: null,
            effort: null,
            preserveDraftComments: true,
            expectedCollaborationRevision: current.revision,
            collaboration: { ...next, actor: wrong },
          }),
        ).toThrow(/frozen stage responsibility/)
        expect(f.repo.read(f.sessionId).runs).toHaveLength(runs)
      }
      refuseSelfReview()
      const planReview = advance(f)
      expect(planReview.agentId).toBe(secondary)
      expect(() => f.repo.recordWorkflowReview(f.first.run.id, { verdict: 'accepted' })).toThrow(
        /independent review/,
      )
      expect(() =>
        f.repo.recordWorkflowPlan(planReview.id, { nativeId: 'foreign', text: 'Wrong author' }),
      ).toThrow(/plan author/)
      f.finish(planReview.id, { verdict: 'accepted' })
      const implementation = advance(f, 'execute')
      expect(implementation.agentId).toBe(secondary)
      const writeAuth = f.repo.collaborationTurnAuthorization(implementation.id)!
      const receipt = f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, writeAuth.userAuthority!.receiptId))
        .get()!
      expect(receipt.actor).toBe(secondary)
      expect(collaborationActionBasisSchema.parse(JSON.parse(receipt.basisJson))).toMatchObject({
        rolePolicy: 'split-stages-v1',
        actor: secondary,
        stage: 'implement',
        planReference: plan,
      })
      expect(() => f.repo.recordWorkflowReview(implementation.id, { verdict: 'accepted' })).toThrow(
        /independent review/,
      )
      f.finish(implementation.id, { answer: 'Implemented exact scope.' })
      refuseSelfReview()
      const firstCodeReview = advance(f)
      expect(firstCodeReview.agentId).toBe(primary)
      f.finish(firstCodeReview.id, { verdict: 'changes_requested' })
      const response = advance(f, 'respond')
      expect(response.agentId).toBe(secondary)
      f.finish(response.id, { answer: 'Answered the precise code review.' })
      const secondCodeReview = advance(f)
      expect(secondCodeReview.agentId).toBe(primary)
      f.finish(secondCodeReview.id, { verdict: 'changes_requested' })
      const repair = advance(f, 'repair')
      expect(repair.agentId).toBe(secondary)
      f.finish(repair.id, { answer: 'Repaired the explicitly authorized scope.' })
      const finalCodeReview = advance(f)
      expect(finalCodeReview.agentId).toBe(primary)
      f.finish(finalCodeReview.id, { verdict: 'accepted' })
      expect(f.repo.collaboration(f.sessionId)).toMatchObject({
        rolePolicy: 'split-stages-v1',
        status: 'complete',
        owner: primary,
        reviewer: secondary,
        planReference: plan,
        review: { actor: primary, stage: 'code_review', verdict: 'accepted' },
      })
      expect(
        f.db.drizzle
          .select()
          .from(collaborationActionReceipts)
          .all()
          .map((row) => row.actor),
      ).toEqual([secondary, secondary, secondary])
    },
  )

  it.each(['codex', 'claude'] as const)(
    'retains the original four legacy duties when %s is the historical owner',
    async (primary) => {
      const secondary = primary === 'codex' ? 'claude' : 'codex'
      const f = await fixture(':memory:', undefined, { primary })
      f.finish()
      const planReview = advance(f)
      expect(planReview.agentId).toBe(secondary)
      f.finish(planReview.id, { verdict: 'accepted' })
      const implementation = advance(f, 'execute')
      expect(implementation.agentId).toBe(primary)
      const auth = f.repo.collaborationTurnAuthorization(implementation.id)!
      const receipt = f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, auth.userAuthority!.receiptId))
        .get()!
      expect(JSON.parse(receipt.basisJson)).not.toHaveProperty('rolePolicy')
      f.finish(implementation.id, { answer: 'Legacy owner completed authorized implementation.' })
      const codeReview = advance(f)
      expect(codeReview.agentId).toBe(secondary)
      f.finish(codeReview.id, { verdict: 'accepted' })
      expect(f.repo.collaboration(f.sessionId)?.rolePolicy).toBeUndefined()
    },
  )

  it.each(['codex', 'claude'] as const)(
    'round-trips split %s plan and code supplement grants through strict action bases',
    async (primary) => {
      const secondary = primary === 'codex' ? 'claude' : 'codex'
      const f = await fixture(':memory:', undefined, { primary, split: true })
      await planSupplementOpportunity(f)
      const planSupplement = await confirmedSupplement(f, 'supplement_plan')
      expect(planSupplement.next.actor).toBe(primary)
      expect(
        collaborationActionBasisSchema.parse(JSON.parse(planSupplement.receipt.basisJson)),
      ).toMatchObject({
        rolePolicy: 'split-stages-v1',
        actor: primary,
        stage: 'plan',
      })
      const extraPlan = startConfirmedSupplement(f, planSupplement)
      f.finish(extraPlan.id, { plan: 'Complete clarified plan without changing responsibilities.' })
      const planReview = advance(f)
      expect(planReview.agentId).toBe(secondary)
      f.finish(planReview.id, { verdict: 'accepted' })
      const implementation = advance(f, 'execute')
      f.finish(implementation.id, { answer: 'Implemented complete plan.' })
      const codeReview = advance(f)
      f.finish(codeReview.id, { verdict: 'changes_requested' })
      const response = advance(f, 'respond')
      f.finish(response.id, { answer: 'Response within current scope.' })
      const repeatedReview = advance(f)
      f.finish(repeatedReview.id, { verdict: 'changes_requested' })
      const codeSupplement = await confirmedSupplement(f, 'supplement_code_response')
      expect(codeSupplement.next.actor).toBe(secondary)
      expect(
        collaborationActionBasisSchema.parse(JSON.parse(codeSupplement.receipt.basisJson)),
      ).toMatchObject({
        rolePolicy: 'split-stages-v1',
        actor: secondary,
        stage: 'respond',
      })
      const extraCode = startConfirmedSupplement(f, codeSupplement)
      const auth = f.repo.collaborationTurnAuthorization(extraCode.id)!
      expect(auth.userAuthority).toMatchObject({
        purpose: 'supplement_code_response',
        returnStage: 'code_review',
        returnActor: primary,
      })
      f.finish(extraCode.id, { answer: 'Clarified code evidence.' })
      const finalReview = advance(f)
      expect(finalReview.agentId).toBe(primary)
      f.finish(finalReview.id, { verdict: 'accepted' })
      expect(f.repo.collaboration(f.sessionId)?.status).toBe('complete')
    },
  )
})

describe('Explicit adoption of split roles for a ready plan', () => {
  it.each(['codex', 'claude'] as const)(
    'adopts %s Primary once without rewriting plan, review, frozen history or existing bindings, including restart',
    async (primary) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-split-adoption-'))
      directories.push(directory)
      const filePath = join(directory, 'pact.sqlite')
      const f = await fixture(filePath, undefined, { primary })
      f.finish()
      const reviewed = advance(f)
      f.finish(reviewed.id, { verdict: 'accepted' })
      const before = f.repo.collaboration(f.sessionId)!
      const snapshot = () => ({
        turns: f.db.drizzle.select().from(workflowTurns).all(),
        receipts: f.db.drizzle.select().from(collaborationActionReceipts).all(),
        runIds: f.repo.read(f.sessionId).runs.map((run) => run.id),
        bindings: (['codex', 'claude'] as const).map((agent) =>
          f.repo.nativeContext(f.sessionId, agent),
        ),
      })
      const frozen = snapshot()
      const request = {
        sessionId: f.sessionId,
        taskId: before.id,
        revision: before.revision,
        settingsRevision: 1,
        operationId: randomUUID(),
      }
      const oldHandoff = f.repo.workflowHandoff(before, before.owner)
      f.repo.adoptSplitStageRoles(request)
      const adopted = f.repo.collaboration(f.sessionId)!
      expect(adopted).toEqual({
        ...before,
        rolePolicy: 'split-stages-v1',
        revision: before.revision + 1,
      })
      expect(snapshot()).toEqual(frozen)
      expect(f.repo.workflowHandoff(adopted, adopted.reviewer).factFingerprint).not.toBe(
        oldHandoff.factFingerprint,
      )
      f.repo.adoptSplitStageRoles(request)
      expect(f.repo.collaboration(f.sessionId)).toEqual(adopted)
      expect(
        f.db.drizzle
          .select()
          .from(agentEventJournal)
          .where(eq(agentEventJournal.eventType, 'workflow.role_policy_adopted'))
          .all(),
      ).toHaveLength(1)
      expect(() =>
        f.repo.setCollaborationState({
          ...adopted,
          rolePolicy: undefined,
          revision: adopted.revision + 1,
        }),
      ).toThrow(/collaboration changed/)
      f.db.close()
      databases.splice(databases.indexOf(f.db), 1)
      const cold = await PactDatabase.open({
        filePath,
        migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
      })
      databases.push(cold)
      cold.conversationRepository.recoverCollaborationTasks()
      const restored = cold.conversationRepository.collaboration(f.sessionId)!
      expect(restored.rolePolicy).toBe('split-stages-v1')
      expect(restored.planReference).toEqual(before.planReference)
      expect(restored.review).toEqual(before.review)
      expect(restored.authorization).toEqual(before.authorization)
      expect(collaborationActor(restored, 'implement')).toBe(
        primary === 'codex' ? 'claude' : 'codex',
      )
      expect(cold.drizzle.select().from(workflowTurns).all()).toEqual(frozen.turns)
      expect(cold.conversationRepository.read(f.sessionId).runs.map((run) => run.id)).toEqual(
        frozen.runIds,
      )
    },
  )

  it.each(['revision', 'settings', 'primary', 'input', 'effects', 'authority', 'write'] as const)(
    'refuses adoption after %s changes without mutating the task or its audit history',
    async (change) => {
      const f = await fixture()
      f.finish()
      const review = advance(f)
      f.finish(review.id, { verdict: 'accepted' })
      const original = f.repo.collaboration(f.sessionId)!
      if (change === 'settings' || change === 'primary') {
        const saved = f.db.sessionRepository.find(f.sessionId)!.settings
        f.db.sessionRepository.saveSettings(f.sessionId, {
          ...saved,
          primaryAgentId: change === 'primary' ? 'claude' : 'codex',
        })
      } else if (change === 'input') f.receive()
      else if (change === 'effects') f.repo.recordNativeEffects(review.id, 'unknown')
      else if (change === 'authority')
        f.repo.prepareCollaborationAction(
          {
            sessionId: f.sessionId,
            taskId: original.id,
            revision: original.revision,
            clientMessageId: randomUUID(),
            action: 'execute',
          },
          settings,
        )
      else if (change === 'write') advance(f, 'execute')
      const before = f.repo.collaboration(f.sessionId)!
      const turns = f.db.drizzle.select().from(workflowTurns).all()
      const runCount = f.repo.read(f.sessionId).runs.length
      expect(() =>
        f.repo.adoptSplitStageRoles({
          sessionId: f.sessionId,
          taskId: before.id,
          revision: before.revision - (change === 'revision' ? 1 : 0),
          settingsRevision: change === 'primary' ? 2 : 1,
          operationId: randomUUID(),
        }),
      ).toThrow(/Only a settled accepted plan/)
      expect(f.repo.collaboration(f.sessionId)).toEqual(before)
      expect(f.db.drizzle.select().from(workflowTurns).all()).toEqual(turns)
      expect(f.repo.read(f.sessionId).runs).toHaveLength(runCount)
      expect(
        f.db.drizzle
          .select()
          .from(agentEventJournal)
          .where(eq(agentEventJournal.eventType, 'workflow.role_policy_adopted'))
          .all(),
      ).toHaveLength(0)
    },
  )
})

async function legacyRetainedPlan() {
  const f = await fixture(':memory:', undefined, { primary: 'codex', split: true })
  f.finish()
  const review = advance(f)
  f.finish(review.id, { verdict: 'accepted' })
  const write = advance(f, 'execute')
  const original = f.repo.collaborationTurnAuthorization(write.id)!
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('Check and retain the original plan.'), 'codex')
  const reply = f.materialize()
  // Replay the pre-replyMode persisted shape: this historical planner already ran in native Plan mode.
  const turn = f.db.drizzle
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, reply.run.id))
    .get()!
  const authorization = f.repo.collaborationTurnAuthorization(reply.run.id)!
  delete authorization.replyMode
  const frozen = JSON.parse(turn.stateJson)
  frozen.authorization = authorization
  f.db.drizzle
    .update(workflowTurns)
    .set({ authorizationJson: JSON.stringify(authorization), stateJson: JSON.stringify(frozen) })
    .where(eq(workflowTurns.runId, reply.run.id))
    .run()
  expect(f.repo.workflowPlanSourceExpected(reply.run.id)).toBe(true)
  f.repo.recordWorkflowPlanRetained(reply.run.id, {
    nativeId: 'legacy-retained-plan',
    confirmation: 'native_root_settled_v1',
    sha256: original.planReference!.document.sha256,
    bytes: original.planReference!.document.bytes,
    chars: original.planReference!.document.chars,
  })
  f.finish(reply.run.id, { answer: 'The original plan is retained.' })
  const retained = f.repo.collaboration(f.sessionId)!
  expect(retained).toMatchObject({
    planReference: original.planReference,
    nextStage: 'plan_review',
    automation: 'paused',
  })
  return { f, original, retained }
}

it.each(['pending', 'rejected'] as const)(
  'does not erase a %s legacy retained Plan review after another processed reply',
  async (scenario) => {
    const { f, retained } = await legacyRetainedPlan()
    if (scenario === 'rejected') {
      f.repo.setCollaborationState(advanceCollaboration(retained, 'resume', settings))
      f.finish(advance(f).id, { verdict: 'changes_requested' })
    }
    f.receive(f.input('Status only; keep the original scope.'))
    const status = f.materialize()
    f.finish(status.run.id, { inputOutcome: 'processed' })
    const current = f.repo.collaboration(f.sessionId)!
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: current.id,
        revision: current.revision,
        clientMessageId: randomUUID(),
        action: current.automation === 'paused' ? 'resume' : 'continue',
      },
      settings,
    )
    expect(prepared.next?.stage).toBe('plan')
  },
)

it.each(['direct', 'accepted_reply'] as const)(
  'preserves legacy planning reply settlement and reacceptance before resuming an unfinished write: %s',
  async (scenario) => {
    const { f, original, retained } = await legacyRetainedPlan()
    f.repo.setCollaborationState(advanceCollaboration(retained, 'resume', settings))
    const rereview = advance(f)
    expect(rereview.collaboration?.stage).toBe('plan_review')
    f.finish(rereview.id, { verdict: 'accepted' })
    if (scenario === 'accepted_reply') {
      f.receive(f.input('Status only; keep the reviewed original scope.'))
      const status = f.materialize()
      f.finish(status.run.id, { inputOutcome: 'processed' })
    }
    const resumed = advance(f)
    expect(f.repo.collaborationTurnAuthorization(resumed.id)).toMatchObject({
      stage: 'implement',
      actor: 'claude',
      planReference: original.planReference,
      userAuthority: {
        purpose: 'write_continuation',
        rootReceiptId: original.userAuthority!.rootReceiptId,
      },
    })
  },
)

it('keeps a requirement revision through its questions, another Stop and cold recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-plan-revision-'))
  directories.push(directory)
  const filePath = join(directory, 'pact.sqlite')
  const f = await fixture(filePath)
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const write = advance(f, 'execute')
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('The goal now includes offline cancellation.'))
  const reply = f.materialize().run
  f.finish(reply.id, {
    inputOutcome: 'plan_revision_required',
    questions: [{ prompt: 'What should cancel while offline?', selection: 'single' }],
  })
  const blocked = f.repo.collaboration(f.sessionId)!
  expect(blocked.inputProcessing?.decision).toMatchObject({ runId: reply.id })
  expect(() => advance(f, 'resume')).toThrow(/Reply/)
  f.receive(decisionInput(f, 'Cancel only the in-flight operation.'))
  const answer = f.materialize().run
  expect(f.repo.collaborationTurnAuthorization(answer.id)?.replyMode).toBe('read_only')
  f.finish(answer.id, { inputOutcome: 'processed' })
  f.repo.pauseCollaboration(f.sessionId, 'stopped')
  f.receive(f.input('Can you explain the change before I continue?'))
  const status = f.materialize().run
  expect(status.agentId).toBe(blocked.owner)
  f.finish(status.id, { inputOutcome: 'processed' })
  expect(f.repo.collaboration(f.sessionId)?.planRevision).toEqual(blocked.planRevision)
  f.db.close()
  databases.splice(databases.indexOf(f.db), 1)
  const reopened = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(reopened)
  const repo = reopened.conversationRepository
  repo.recoverCollaborationTasks()
  const restored = repo.collaboration(f.sessionId)!
  expect(restored).toMatchObject({
    automation: 'paused',
    pendingWork: { runId: write.id },
    planRevision: blocked.planRevision,
  })
  const resumed = advanceCollaboration(restored, 'resume', settings)
  expect(() => repo.setCollaborationState({ ...resumed, planRevision: undefined })).toThrow(
    /changed/,
  )
  expect(() =>
    repo.setCollaborationState({
      ...resumed,
      planRevision: { ...restored.planRevision!, writeRunId: randomUUID() },
    }),
  ).toThrow(/changed/)
  expect(
    repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: restored.id,
        revision: restored.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    ).next,
  ).toMatchObject({ stage: 'plan', actor: restored.owner })
})

it('preserves an authenticated revision observed after a later reply was queued', async () => {
  const f = await fixture()
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const write = advance(f, 'execute')
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('Change acceptance to cover offline cancellation.'))
  const first = f.materialize().run
  const later = f.receive(f.input('Please also explain the current status.'))
  f.finish(first.id, { inputOutcome: 'plan_revision_required' })
  const superseded = f.repo.collaboration(f.sessionId)!
  expect(superseded).toMatchObject({
    automation: 'paused',
    planRevision: { requestRunId: first.id, writeRunId: write.id },
    inputProcessing: { pending: { inputId: later.send.clientMessageId } },
  })
  const followup = f.materialize().run
  f.finish(followup.id, { inputOutcome: 'processed' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planRevision: superseded.planRevision,
    inputProcessing: { settled: { runId: followup.id } },
  })
  expect(advance(f, 'resume').collaboration?.stage).toBe('plan')
})

it.each(['processed', 'plan_revision_required'] as const)(
  'retains the write fence when successful input outcomes conflict, starting with %s',
  async (first) => {
    const f = await fixture()
    f.finish()
    f.finish(advance(f).id, { verdict: 'accepted' })
    const write = advance(f, 'execute')
    f.finish(write.id, { outcome: 'interrupted' })
    f.receive(f.input('Use the new acceptance conditions.'))
    const reply = f.materialize().run
    f.finish(reply.id, {
      inputObservations: [first, first === 'processed' ? 'plan_revision_required' : 'processed'],
    })
    const current = f.repo.collaboration(f.sessionId)!
    expect(current).toMatchObject({
      status: 'failed',
      automation: 'paused',
      planRevision: { requestRunId: reply.id, writeRunId: write.id },
    })
    expect(current.inputProcessing?.pending).toBeDefined()
    expect(() => advance(f, 'resume')).toThrow(/Reply/)
  },
)

async function collidingPlanSourceGrants() {
  const f = await fixture()
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const plan = f.repo.collaboration(f.sessionId)!.planReference!
  const handoff = f.repo.readHandoffPage(f.sessionId, 'claude', -1, Number.MAX_SAFE_INTEGER)
  const originalMessage = handoff.messages.find((item) => item.messageId === plan.sourceMessageId)!
  const write = advance(f, 'execute', [
    {
      id: originalMessage.messageId,
      revision: originalMessage.contentRevision,
      digest: originalMessage.digest,
    },
  ])
  const prior = f.repo
    .readRunSources(write.id)
    .items.find((item) => item.messageId === originalMessage.messageId)!
  expect(prior.documents.length).toBeGreaterThan(1)
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('Change acceptance to cover offline operation.'))
  const reply = f.materialize().run
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  const planner = advance(f, 'resume')
  f.repo.recordWorkflowPlanRetained(planner.id, {
    nativeId: 'retain-accepted-plan-for-new-review',
    confirmation: 'native_root_settled_v1',
    sha256: plan.document.sha256,
    bytes: plan.document.bytes,
    chars: plan.document.chars,
  })
  f.finish(planner.id, { answer: 'The exact Plan already describes offline operation.' })
  f.finish(advance(f).id, { verdict: 'accepted' })
  return { f, plan, write, prior, originalMessage }
}

it('retains every inherited source when a new action also grants the same message', async () => {
  const { f, prior, originalMessage } = await collidingPlanSourceGrants()
  const next = advance(f, 'execute')
  const inherited = f.repo
    .readRunSources(next.id)
    .items.find((item) => item.messageId === originalMessage.messageId)!
  expect(inherited.documents.map((item) => item.source)).toEqual(
    expect.arrayContaining(prior.documents.map((item) => item.source)),
  )
})

it.each(['revision', 'batch', 'document', 'capacity'] as const)(
  'keeps the old Run and revision fence if frozen source %s cannot be merged',
  async (failure) => {
    const { f, plan, write, prior, originalMessage } = await collidingPlanSourceGrants()
    const before = f.repo.collaboration(f.sessionId)!
    const authorization = f.repo.collaborationTurnAuthorization(write.id)
    const key = and(
      eq(conversationRunSourceRefs.runId, write.id),
      eq(conversationRunSourceRefs.sourceMessageId, originalMessage.messageId),
    )
    const old = f.db.drizzle.select().from(conversationRunSourceRefs).where(key).get()!
    const report = prior.documents.find((entry) => entry.key === 'message')!.source
    const item = {
      messageId: prior.messageId,
      revision: prior.revision,
      documents: [{ key: '', source: report }],
    }
    const remaining = 48 * 1024 - 2048 - Buffer.byteLength(JSON.stringify(item)) - 16
    const cases = {
      revision: { sourceRevision: old.sourceRevision + 1 },
      batch: { batchId: authorization!.inputBatchRef!.id },
      document: {
        documentsJson: JSON.stringify([
          {
            key: 'plan',
            source: { ...plan.document, sha256: '0'.repeat(64) },
          },
        ]),
      },
      capacity: { documentsJson: JSON.stringify([{ key: 'x'.repeat(remaining), source: report }]) },
    }
    f.db.drizzle.update(conversationRunSourceRefs).set(cases[failure]).where(key).run()
    const perturbed = f.db.drizzle.select().from(conversationRunSourceRefs).where(key).get()!
    let page = f.repo.readRunSources(write.id)
    while (
      page.nextOffset !== null &&
      !page.items.some((entry) => entry.messageId === prior.messageId)
    )
      page = f.repo.readRunSources(write.id, page.nextOffset)
    expect(page.items.some((entry) => entry.messageId === prior.messageId)).toBe(true)
    const runCount = f.repo.read(f.sessionId).runs.length
    expect(() => advance(f, 'execute')).toThrow(/conflicts|does not belong|metadata budget/i)
    expect(f.repo.read(f.sessionId).runs).toHaveLength(runCount)
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
    expect(f.repo.collaborationTurnAuthorization(write.id)).toEqual(authorization)
    expect(f.db.drizzle.select().from(conversationRunSourceRefs).where(key).get()).toEqual(
      perturbed,
    )
  },
)

it('grants exact previous Plan and repair scope after newer documents supersede them', async () => {
  const f = await fixture()
  f.repo.recordWorkflowPlan(f.first.run.id, {
    nativeId: 'unselected-original-plan-draft',
    text: 'An unselected sibling document that was never part of the accepted Plan.',
  })
  f.finish()
  const unselected = f.db.drizzle.get<{ source: string }>(
    sql`SELECT json_extract(payload,'$.source') AS source FROM agent_event_journal WHERE run_id=${f.first.run.id} AND event_type='workflow.plan_observed' ORDER BY sequence LIMIT 1`,
  )
  const unselectedPlan = collaborationDocumentSchema.parse(JSON.parse(unselected.source))
  f.finish(advance(f).id, { verdict: 'accepted' })
  f.finish(advance(f, 'execute').id, { answer: 'Earlier implementation.' })
  f.finish(advance(f).id, { verdict: 'changes_requested', answer: 'The original repair findings.' })
  const findings = f.repo.collaboration(f.sessionId)!.review!
  const repair = advance(f, 'repair')
  const old = f.repo.collaborationTurnAuthorization(repair.id)!
  const originalGrants = f.repo.readRunSources(repair.id)
  expect(
    originalGrants.items.flatMap((item) => item.documents.map((entry) => entry.source.id)),
  ).toContain(findings.document.id)
  f.finish(repair.id, { outcome: 'interrupted' })
  f.receive(f.input('Change acceptance to include operation cancellation while offline.'))
  const reply = f.materialize().run
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  const planner = advance(f, 'resume')
  f.finish(planner.id, { plan: 'P2 is different and covers offline cancellation.' })
  const planReview = advance(f)
  f.finish(planReview.id, { verdict: 'accepted' })
  const implementation = advance(f, 'execute')
  f.finish(implementation.id, { answer: 'Revised implementation.' })
  const codeReview = advance(f)
  const current = f.repo.collaborationTurnAuthorization(codeReview.id)!
  expect(current.planReference?.document.sha256).not.toBe(old.planReference?.document.sha256)
  expect(current.reviewScopeRef?.sha256).not.toBe(old.reviewScopeRef?.sha256)
  for (const run of [planner, planReview, implementation, codeReview]) {
    expect(f.repo.sourceDocumentAuthorized(run.id, unselectedPlan)).toBe(false)
    expect(f.repo.sourceDocumentAuthorized(run.id, findings.document)).toBe(true)
    expect(
      f.repo
        .readRunSources(run.id)
        .items.flatMap((item) => item.documents.map((entry) => entry.source.id)),
    ).toContain(findings.document.id)
    for (const document of [old.planReference!.document, old.reviewScopeRef!]) {
      const source = f.repo
        .readRunSources(run.id)
        .items.find((item) => item.messageId === repair.userMessageId)
      expect(source?.documents.some((entry) => entry.source.id === document.id)).toBe(true)
      expect(f.repo.sourceDocumentAuthorized(run.id, document)).toBe(true)
      expect(readDocument(f, document)).not.toBe('')
    }
  }
  expect(f.repo.readRunSources(repair.id)).toEqual(originalGrants)
})

it('keeps the original write sources in a verified native planning answer', async () => {
  const f = await fixture()
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  f.finish(advance(f, 'execute').id, { answer: 'The earlier implementation completed.' })
  f.finish(advance(f).id, { verdict: 'changes_requested' })
  const write = advance(f, 'repair')
  const original = f.repo.collaborationTurnAuthorization(write.id)!
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('Change the target to offline cancellation.'))
  const reply = f.materialize().run
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  const planner = advance(f, 'resume')
  f.finish(planner.id, {
    inputOutcome: 'needs_user',
    questions: [{ prompt: 'Which offline cases?', selection: 'single' }],
  })
  f.receive(decisionInput(f, 'Cover requests already in progress.'))
  const answer = f.materialize().run
  const auth = f.repo.collaborationTurnAuthorization(answer.id)!
  expect(auth).toMatchObject({ actor: planner.agentId, replyMode: 'plan' })
  expect(auth.planRevisionContextRef).toBeDefined()
  expect(f.repo.sourceDocumentAuthorized(answer.id, auth.planRevisionContextRef!)).toBe(true)
  const exact = f.repo
    .readRunSources(answer.id)
    .items.find((item) => item.messageId === write.userMessageId)
  expect(exact?.documents.map((item) => item.source.id)).toEqual(
    expect.arrayContaining([original.planReference!.document.id, original.reviewScopeRef!.id]),
  )
  expect(f.repo.readFrozenInputBatch(answer.id, original.inputBatchRef!.id).batch).toMatchObject(
    original.inputBatchRef!,
  )
  f.finish(answer.id, { plan: 'Handle in-progress requests when offline.' })
  expect(advance(f).collaboration?.stage).toBe('plan_review')
})

it('keeps the revision fence and input gate while the native reply effects are unknown', async () => {
  const f = await fixture()
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const write = advance(f, 'execute')
  f.finish(write.id, { outcome: 'interrupted' })
  f.receive(f.input('Change the acceptance to require offline operation.'))
  const reply = f.materialize().run
  f.repo.recordNativeEffects(reply.id, 'pending')
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' }, false)
  f.repo.recordNativeEffects(reply.id, 'unknown')
  const current = f.repo.collaboration(f.sessionId)!
  expect(current).toMatchObject({
    automation: 'paused',
    planRevision: { requestRunId: reply.id, writeRunId: write.id },
    inputProcessing: { pending: { inputId: reply.userMessageId } },
  })
  expect(() => advance(f, 'resume')).toThrow(/reply|native recovery/i)
  expect(f.repo.collaboration(f.sessionId)?.planRevision).toEqual(current.planRevision)
})

it('rolls back a revised Implement when the original frozen write source is missing', async () => {
  const f = await fixture()
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const original = advance(f, 'execute')
  const originalBatch = f.repo.collaborationTurnAuthorization(original.id)!.inputBatchRef!
  const source = f.repo.readFrozenInputBatch(original.id, originalBatch.id).body!
  f.finish(original.id, { outcome: 'interrupted' })
  f.receive(f.input('Revise the acceptance to cover offline cancellation.'))
  const reply = f.materialize().run
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  const planner = advance(f, 'resume')
  f.finish(planner.id, { plan: 'An updated Plan for offline cancellation.' })
  f.finish(advance(f).id, { verdict: 'accepted' })
  const ready = f.repo.collaboration(f.sessionId)!
  const prepared = f.repo.prepareCollaborationAction(
    {
      sessionId: f.sessionId,
      taskId: ready.id,
      revision: ready.revision,
      clientMessageId: randomUUID(),
      action: 'execute',
    },
    settings,
  )
  const input = {
    sessionId: f.sessionId,
    clientMessageId: prepared.receipt.clientNonce,
    content: 'Implement the newly accepted scope.',
    commentIds: [],
    expectedCommentsRevision: f.drafts().commentsRevision,
    agentId: prepared.next!.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: ready.revision,
    collaboration: prepared.next!,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }
  f.db.drizzle
    .update(conversationBodyInputs)
    .set({ sealed: false })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
  expect(() => f.repo.beginRun(input)).toThrow(/source|document/i)
  expect(f.repo.collaboration(f.sessionId)).toEqual(ready)
  expect(
    f.repo.collaborationActionReceipt({
      sessionId: f.sessionId,
      taskId: ready.id,
      revision: ready.revision,
      clientMessageId: prepared.receipt.clientNonce,
      action: 'execute',
    }),
  ).toMatchObject({ state: 'available', boundRunId: null })
  f.db.drizzle
    .update(conversationBodyInputs)
    .set({ sealed: true })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
  const admitted = f.repo.beginRun(input)
  expect(admitted.created).toBe(true)
  expect(f.repo.collaboration(f.sessionId)?.planRevision).toBeUndefined()
  expect(f.repo.beginRun(input)).toMatchObject({ created: false, run: { id: admitted.run.id } })
})

async function legacyPlanSupplement() {
  const { f, original, retained } = await legacyRetainedPlan()
  f.repo.setCollaborationState(advanceCollaboration(retained, 'resume', settings))
  for (let index = 0; index < 2; index++) {
    f.finish(advance(f).id, { verdict: 'changes_requested' })
    f.finish(advance(f).id, {
      plan: `A reviewed Plan update before the supplement, pass ${index + 1}.`,
    })
  }
  const supplement = await confirmedSupplement(f, 'supplement_plan')
  const extra = startConfirmedSupplement(f, supplement)
  f.repo.pauseCollaboration(f.sessionId, 'stopped')
  return { f, original, supplement, extra }
}

it('returns a legacy unfinished Plan supplement to its fixed reviewer before revising the requirements', async () => {
  const { f, original, supplement, extra } = await legacyPlanSupplement()
  f.finish(extra.id, { plan: 'The completed supplementary Plan needs its fixed review.' })

  f.receive(f.input('Change acceptance to add offline cancellation.'))
  const reply = f.materialize().run
  expect(f.repo.collaborationTurnAuthorization(reply.id)?.replyMode).toBe('read_only')
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planRevision: {
      requestRunId: reply.id,
      writeRunId: original.runId,
      returnReview: { receiptId: supplement.receipt.id, stage: 'plan_review' },
    },
  })
  const review = advance(f, 'resume')
  expect(review).toMatchObject({
    agentId: supplement.next.reviewer,
    collaboration: { stage: 'plan_review' },
  })
  f.finish(review.id, { verdict: 'accepted' })
  const afterReturn = f.repo.collaboration(f.sessionId)!
  expect(afterReturn.planRevision?.returnReview).toBeUndefined()
  expect(afterReturn.review?.runId).toBe(review.id)
  const planner = advance(f)
  expect(planner.collaboration?.stage).toBe('plan')
  const { document } = afterReturn.planReference!
  f.repo.recordWorkflowPlanRetained(planner.id, {
    nativeId: 'retain-supplemented-plan-for-new-review',
    confirmation: 'native_root_settled_v1',
    sha256: document.sha256,
    bytes: document.bytes,
    chars: document.chars,
  })
  f.finish(planner.id, { answer: 'The exact Plan already covers offline cancellation.' })
  expect(() => advance(f, 'execute')).toThrow(/not been accepted/i)
  const independent = advance(f)
  expect(independent).toMatchObject({
    agentId: review.agentId,
    collaboration: { stage: 'plan_review' },
  })
  f.finish(independent.id, { verdict: 'accepted' })
  const implementation = advance(f, 'execute')
  expect(
    f.repo.collaborationTurnAuthorization(implementation.id)?.userAuthority?.rootReceiptId,
  ).not.toBe(original.userAuthority?.rootReceiptId)
})

it.each(['direct', 'current_chain', 'historical_chain'] as const)(
  'keeps the %s native planning answer as the old supplement review source',
  async (history) => {
    const { f, supplement, extra } = await legacyPlanSupplement()
    f.finish(extra.id, {
      inputOutcome: 'needs_user',
      questions: [{ prompt: 'Which boundary should the supplement cover?', selection: 'single' }],
      answer: 'The original supplementary Plan needs an explicit boundary.',
    })
    const historicalShape = (runId: string) => {
      if (history !== 'historical_chain') return
      f.db.drizzle
        .update(workflowTurns)
        .set({
          authorizationJson: sql`json_remove(authorization_json, '$.supplementPlanAnswerReceiptId', '$.replyMode')`,
          stateJson: sql`json_remove(state_json, '$.authorization.supplementPlanAnswerReceiptId', '$.authorization.replyMode')`,
        })
        .where(eq(workflowTurns.runId, runId))
        .run()
      f.db.drizzle
        .update(collaborationTasks)
        .set({
          stateJson: sql`json_remove(state_json, '$.authorization.supplementPlanAnswerReceiptId', '$.authorization.replyMode')`,
        })
        .where(eq(collaborationTasks.id, f.repo.collaboration(f.sessionId)!.id))
        .run()
    }
    if (history !== 'direct') {
      f.receive(decisionInput(f, 'Cover requests received before the shutdown signal.'))
      const intermediate = f.materialize().run
      f.finish(intermediate.id, {
        inputOutcome: 'needs_user',
        questions: [{ prompt: 'Should draining requests stay in scope?', selection: 'single' }],
      })
      historicalShape(intermediate.id)
    }
    f.receive(decisionInput(f, 'Cover requests still draining from before shutdown.'))
    const answer = f.materialize().run
    expect(f.repo.collaborationTurnAuthorization(answer.id)?.replyMode).toBe('plan')
    f.finish(answer.id, { plan: 'Cover requests received before shutdown.' })
    historicalShape(answer.id)
    const settled = f.repo.collaboration(f.sessionId)!
    expect(settled.planReference?.sourceRunId).toBe(answer.id)
    const originalReturn = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: settled.id,
        revision: settled.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    )
    expect(originalReturn.next?.stage).toBe('plan_review')
    f.repo.cancelPreparedCollaborationAction(originalReturn.receipt.id)

    f.receive(f.input('Change the requested acceptance to cancellation while offline.'))
    const later = f.materialize().run
    expect(f.repo.collaborationTurnAuthorization(later.id)?.replyMode).toBe('read_only')
    f.finish(later.id, { inputOutcome: 'plan_revision_required' })
    const review = advance(f, 'resume')
    expect(review.collaboration?.stage).toBe('plan_review')
    expect(f.repo.collaborationTurnAuthorization(review.id)?.supplementPlanReturn).toMatchObject({
      receiptId: supplement.receipt.id,
      sourceRunId: answer.id,
    })
    f.finish(review.id, { verdict: 'accepted' })
    expect(f.repo.collaboration(f.sessionId)?.planRevision?.returnReview).toBeUndefined()
    expect(advance(f).collaboration?.stage).toBe('plan')
  },
)

it.each(['direct', 'processed_status', 'decision_status', 'interrupted_status'] as const)(
  'preserves a legacy ordinary planner reply as the Plan source (%s)',
  async (history) => {
    const { f, supplement, extra } = await legacyPlanSupplement()
    f.finish(extra.id, { plan: 'The original supplementary Plan.' })
    const statusSources: string[] = []
    const statusAnchor = () => {
      f.receive(
        {
          ...f.input('Give me the status of the supplementary Plan.'),
          route: { type: 'agent', agentId: 'claude' },
        },
        'claude',
      )
      const status = f.materialize().run
      expect(f.repo.workflowPlanSourceExpected(status.id)).toBe(false)
      statusSources.push(status.id)
      if (history === 'decision_status') {
        f.finish(status.id, {
          inputOutcome: 'needs_user',
          questions: [{ prompt: 'Which progress should I report?', selection: 'single' }],
        })
        f.receive(decisionInput(f, 'Summarize just the shutdown sequencing.'))
        const answer = f.materialize().run
        f.finish(answer.id, { inputOutcome: 'processed' })
        statusSources.push(answer.id)
        return answer.id
      }
      f.finish(
        status.id,
        history === 'interrupted_status'
          ? { outcome: 'interrupted', answer: 'The status response was interrupted.' }
          : { inputOutcome: 'processed' },
      )
      return status.id
    }
    const anchorRunId = history === 'direct' ? extra.id : statusAnchor()
    const statusHistory = () =>
      statusSources.map((id) => {
        const { updatedAt: _activity, ...run } = f.repo.findRun(id)!
        return {
          run,
          turn: f.db.drizzle.select().from(workflowTurns).where(eq(workflowTurns.runId, id)).get(),
          input: f.db.drizzle
            .select()
            .from(collaborationInputs)
            .where(eq(collaborationInputs.id, run.userMessageId))
            .get(),
          inputResults: f.db.drizzle
            .select()
            .from(agentEventJournal)
            .where(sql`run_id=${id} AND event_type='workflow.input_result_observed'`)
            .all(),
        }
      })
    const before = statusHistory()
    f.receive(
      {
        ...f.input('Clarify the current shutdown sequencing in the Plan.'),
        route: { type: 'agent', agentId: 'codex' },
      },
      'codex',
    )
    const historical = f.materialize().run
    f.db.drizzle
      .update(workflowTurns)
      .set({
        authorizationJson: sql`json_remove(authorization_json, '$.replyMode', '$.planRevisionWriteRunId')`,
        stateJson: sql`json_remove(state_json, '$.authorization.replyMode', '$.authorization.planRevisionWriteRunId')`,
      })
      .where(eq(workflowTurns.runId, historical.id))
      .run()
    f.db.drizzle
      .update(collaborationTasks)
      .set({
        stateJson: sql`json_remove(state_json, '$.authorization.replyMode', '$.authorization.planRevisionWriteRunId')`,
      })
      .where(eq(collaborationTasks.id, f.repo.collaboration(f.sessionId)!.id))
      .run()
    expect(f.repo.workflowPlanSourceExpected(historical.id)).toBe(true)
    f.finish(historical.id, { plan: 'The supplementary Plan with exact shutdown sequencing.' })
    const settled = f.repo.collaboration(f.sessionId)!
    expect(settled.planReference?.sourceRunId).toBe(historical.id)
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: settled.id,
        revision: settled.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    )
    expect(prepared.next?.stage).toBe('plan_review')
    f.repo.cancelPreparedCollaborationAction(prepared.receipt.id)

    f.receive(f.input('Change acceptance to cancellation while offline.'))
    f.finish(f.materialize().run.id, { inputOutcome: 'plan_revision_required' })
    const originalInput = f.db.drizzle
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, historical.userMessageId))
      .get()!
    expect(originalInput.anchorRunId).toBe(anchorRunId)
    f.db.drizzle
      .update(collaborationInputs)
      .set({ anchorRunId: f.first.run.id })
      .where(eq(collaborationInputs.id, historical.userMessageId))
      .run()
    expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
    f.db.drizzle
      .update(collaborationInputs)
      .set({ anchorRunId: originalInput.anchorRunId })
      .where(eq(collaborationInputs.id, historical.userMessageId))
      .run()
    const assertUnchangedCarrier = () => {
      const filter = eq(workflowTurns.runId, anchorRunId)
      const carrier = f.db.drizzle.select().from(workflowTurns).where(filter).get()!
      f.db.drizzle
        .update(workflowTurns)
        .set({
          stateJson: sql`json_set(state_json, '$.planReference.sourceRunId', ${f.first.run.id})`,
        })
        .where(filter)
        .run()
      expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
      f.db.drizzle.update(workflowTurns).set({ stateJson: carrier.stateJson }).where(filter).run()
      const effectsFilter = eq(agentRuns.id, anchorRunId)
      const priorEffects = f.db.drizzle
        .select({ state: agentRuns.nativeEffectsState })
        .from(agentRuns)
        .where(effectsFilter)
        .get()!.state
      f.db.drizzle
        .update(agentRuns)
        .set({ nativeEffectsState: 'unknown' })
        .where(effectsFilter)
        .run()
      expect(() => advance(f, 'resume')).toThrow(/original reviewer|native recovery/i)
      f.db.drizzle
        .update(agentRuns)
        .set({ nativeEffectsState: priorEffects })
        .where(effectsFilter)
        .run()
    }
    if (history !== 'direct') assertUnchangedCarrier()
    const exactAuth = f.repo.collaborationTurnAuthorization(historical.id)!
    for (const invalid of [
      { ...exactAuth, replyMode: 'read_only' },
      { ...exactAuth, planReference: { ...exactAuth.planReference!, sourceRunId: f.first.run.id } },
    ]) {
      f.db.drizzle
        .update(workflowTurns)
        .set({ authorizationJson: JSON.stringify(invalid) })
        .where(eq(workflowTurns.runId, historical.id))
        .run()
      expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
    }
    f.db.drizzle
      .update(workflowTurns)
      .set({ authorizationJson: JSON.stringify(exactAuth) })
      .where(eq(workflowTurns.runId, historical.id))
      .run()
    const review = advance(f, 'resume')
    expect(f.repo.collaborationTurnAuthorization(review.id)?.supplementPlanReturn).toMatchObject({
      receiptId: supplement.receipt.id,
      sourceRunId: historical.id,
    })
    f.finish(review.id, { verdict: 'accepted' })
    expect(statusHistory()).toEqual(before)
    expect(advance(f).collaboration?.stage).toBe('plan')
  },
)

it('keeps a legacy planner source anchored after the interrupted exact Plan return review', async () => {
  const { f, supplement, extra } = await legacyPlanSupplement()
  f.finish(extra.id, { plan: 'The supplementary Plan before the return review.' })
  const originalPlan = f.repo.collaboration(f.sessionId)!.planReference!
  const interrupted = advance(f, 'resume')
  expect(interrupted.collaboration?.stage).toBe('plan_review')
  expect(f.repo.collaborationTurnAuthorization(interrupted.id)?.planReference).toEqual(originalPlan)
  f.finish(interrupted.id, { outcome: 'interrupted', answer: 'The original review was stopped.' })
  expect(f.repo.findRun(interrupted.id)).toMatchObject({
    dispatchPhase: 'ended',
    nativeOutcome: 'interrupted',
    nativeEffectsState: 'settled',
  })
  expect(
    f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, supplement.receipt.id))
      .get(),
  ).toMatchObject({ reviewState: 'pending', reviewRunId: interrupted.id, boundRunId: extra.id })

  f.receive(
    {
      ...f.input('Clarify the current Plan after the interrupted review.'),
      route: { type: 'agent', agentId: 'codex' },
    },
    'codex',
  )
  const historical = f.materialize().run
  expect(
    f.db.drizzle
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, historical.userMessageId))
      .get(),
  ).toMatchObject({ state: 'materialized', anchorRunId: interrupted.id })
  expect(f.repo.collaborationTurnAuthorization(historical.id)?.planReference).toEqual(originalPlan)
  f.db.drizzle
    .update(workflowTurns)
    .set({
      authorizationJson: sql`json_remove(authorization_json, '$.replyMode', '$.planRevisionWriteRunId')`,
      stateJson: sql`json_remove(state_json, '$.authorization.replyMode', '$.authorization.planRevisionWriteRunId')`,
    })
    .where(eq(workflowTurns.runId, historical.id))
    .run()
  f.db.drizzle
    .update(collaborationTasks)
    .set({
      stateJson: sql`json_remove(state_json, '$.authorization.replyMode', '$.authorization.planRevisionWriteRunId')`,
    })
    .where(eq(collaborationTasks.id, f.repo.collaboration(f.sessionId)!.id))
    .run()
  expect(f.repo.workflowPlanSourceExpected(historical.id)).toBe(true)
  f.finish(historical.id, { plan: 'The exact clarified Plan after the stopped review.' })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled.planReference?.sourceRunId).toBe(historical.id)
  const prepared = f.repo.prepareCollaborationAction(
    {
      sessionId: f.sessionId,
      taskId: settled.id,
      revision: settled.revision,
      clientMessageId: randomUUID(),
      action: 'resume',
    },
    settings,
  )
  expect(prepared.next?.stage).toBe('plan_review')
  f.repo.cancelPreparedCollaborationAction(prepared.receipt.id)

  f.receive(f.input('Change acceptance to cancellation while offline.'))
  f.finish(f.materialize().run.id, { inputOutcome: 'plan_revision_required' })
  const before = f.repo.collaboration(f.sessionId)!
  const handoffFilter = eq(schedulingHandoffs.runId, interrupted.id)
  const originalHandoff = f.db.drizzle.select().from(schedulingHandoffs).where(handoffFilter).get()!
  expect(originalHandoff).toMatchObject({
    sessionId: f.sessionId,
    budgetSubjectId: `task:${before.id}`,
    eventId: extra.id,
    slot: 'workflow_next',
    action: 'workflow:plan_review',
  })
  const otherSession = randomUUID()
  const session = f.db.sessionRepository.find(f.sessionId)!
  f.db.sessionRepository.create(
    {
      id: otherSession,
      projectId: session.projectId,
      title: 'Unrelated session',
      createdAt: f.now,
    },
    settings,
  )
  for (const invalid of [
    { action: 'workflow:implement' },
    { slot: 'input_dispatch' },
    { sessionId: otherSession },
    { budgetSubjectId: `task:${randomUUID()}` },
    { eventId: historical.id },
  ]) {
    f.db.drizzle.update(schedulingHandoffs).set(invalid).where(handoffFilter).run()
    expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
    f.db.drizzle
      .update(schedulingHandoffs)
      .set({
        action: originalHandoff.action,
        slot: originalHandoff.slot,
        sessionId: originalHandoff.sessionId,
        budgetSubjectId: originalHandoff.budgetSubjectId,
        eventId: originalHandoff.eventId,
      })
      .where(handoffFilter)
      .run()
  }
  const reviewFilter = eq(workflowTurns.runId, interrupted.id)
  const historicalReview = f.db.drizzle.select().from(workflowTurns).where(reviewFilter).get()!
  f.db.drizzle
    .update(workflowTurns)
    .set({
      authorizationJson: sql`json_set(authorization_json, '$.planReference.sourceRunId', ${f.first.run.id})`,
    })
    .where(reviewFilter)
    .run()
  expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
  f.db.drizzle
    .update(workflowTurns)
    .set({ authorizationJson: historicalReview.authorizationJson })
    .where(reviewFilter)
    .run()
  const effectsFilter = eq(agentRuns.id, interrupted.id)
  f.db.drizzle.update(agentRuns).set({ nativeEffectsState: 'unknown' }).where(effectsFilter).run()
  expect(() => advance(f, 'resume')).toThrow(/original reviewer|native recovery/i)
  f.db.drizzle.update(agentRuns).set({ nativeEffectsState: 'settled' }).where(effectsFilter).run()
  expect(f.repo.collaboration(f.sessionId)).toEqual(before)

  const review = advance(f, 'resume')
  const receiptFilter = eq(collaborationActionReceipts.id, supplement.receipt.id)
  expect(
    f.db.drizzle.select().from(collaborationActionReceipts).where(receiptFilter).get(),
  ).toMatchObject({ reviewState: 'pending', reviewRunId: review.id, boundRunId: extra.id })
  expect(f.repo.collaborationTurnAuthorization(review.id)?.supplementPlanReturn).toMatchObject({
    receiptId: supplement.receipt.id,
    sourceRunId: historical.id,
  })
  f.finish(review.id, { verdict: 'accepted' })
  expect(
    f.db.drizzle.select().from(collaborationActionReceipts).where(receiptFilter).get(),
  ).toMatchObject({ reviewState: 'fulfilled', reviewRunId: review.id, boundRunId: extra.id })
  const planner = advance(f)
  expect(planner.collaboration?.stage).toBe('plan')
  f.finish(planner.id, { plan: 'The newly revised Plan for cancellation while offline.' })
  const independent = advance(f)
  expect(independent.collaboration?.stage).toBe('plan_review')
  expect(
    f.repo.collaborationTurnAuthorization(independent.id)?.supplementPlanReturn,
  ).toBeUndefined()
  f.finish(independent.id, { verdict: 'accepted' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({ status: 'ready' })
  expect(f.db.drizzle.select().from(schedulingHandoffs).where(handoffFilter).get()).toEqual(
    originalHandoff,
  )
  expect(f.db.drizzle.select().from(workflowTurns).where(reviewFilter).get()).toEqual(
    historicalReview,
  )
})

it('returns the verified Plan published by an exact unsent answer replacement to the original reviewer', async () => {
  const { f, supplement, extra } = await legacyPlanSupplement()
  f.finish(extra.id, {
    inputOutcome: 'needs_user',
    questions: [
      { prompt: 'Which cleanup boundary should the supplement cover?', selection: 'single' },
    ],
    answer: 'The supplementary Plan needs an explicit cleanup boundary.',
  })
  const content = 'Keep requests received before shutdown in scope.'
  f.receive(decisionInput(f, content))
  const original = f.materialize().run
  const originalAuth = f.repo.collaborationTurnAuthorization(original.id)!
  expect(originalAuth.replyMode).toBe('plan')
  const nativeGeneration = randomUUID()
  const nativeSessionId = 'fixture-codex'
  const executorId = randomUUID()
  f.repo.beginSchedulingRecoveryEpoch(randomUUID())
  f.repo.recordExecutor(original.id, executorId)
  f.repo.applyEvent(f.sessionId, original.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId,
  })
  f.repo.setContinuation(f.sessionId, 'codex', 'ready')
  const envelope: FrozenExecutionEnvelope = {
    version: 'pact-agent-prompt-v1',
    sessionId: f.sessionId,
    message: { id: original.userMessageId, content },
    comments: [],
    inputBatchRef: originalAuth.inputBatchRef,
    collaboration: f.repo.collaborationPromptState(f.repo.collaboration(f.sessionId)!),
    collaborationAuthorization: originalAuth,
  }
  const capture = await f.repo.captureExecutionInput({
    runId: original.id,
    nativeGeneration,
    requested: {
      provider: 'codex',
      model: null,
      effort: null,
      speed: 'standard',
      permissionMode: 'native',
    },
    source: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(envelope))
    })(),
    signal: new AbortController().signal,
  })
  expect(capture).toBeDefined()
  f.repo.recordEffectiveExecutionSettings(
    original.id,
    nativeGeneration,
    {
      version: 1,
      provider: 'codex',
      model: 'fixture-effective-model',
      effort: { known: true, value: null },
      speed: 'standard',
      permissionMode: 'native',
      configurationSha256: 'a'.repeat(64),
      provenance: 'codex_thread_configuration',
    },
    { executorId, nativeSessionId },
  )
  f.repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
  f.repo.recordConfirmedUnsent(
    original.id,
    nativeGeneration,
    {
      kind: 'codex_root_frame_not_written',
      requestId: 19,
    },
    { executorId, nativeSessionId },
  )
  f.repo.failRun(original.id, 'transient_transport', 'The exact root frame was not sent.')
  f.repo.recordNativeEffects(original.id, 'not_dispatched')
  f.repo.finishCollaboration(original.id, false)
  f.repo.armSchedulingRecoveryFaults(f.sessionId)
  const candidate = f.repo
    .takeSchedulingRecoveryFaults()
    .find((item) => item.fault.runId === original.id)!
  const reexecution = {
    operationId: randomUUID(),
    faultId: candidate.fault.id,
    handoff: f.repo.recoveryHandoff({ kind: 'run', id: original.id }),
  }
  const replacement = f.repo.beginConfirmedUnsentReexecution(reexecution).run
  expect(replacement.reexecutedFromRunId).toBe(original.id)
  f.repo.recordExecutor(replacement.id, executorId)
  f.repo.recordDispatch(replacement.id, 'possibly_sent', nativeSessionId, executorId)
  f.repo.recordDispatch(replacement.id, 'accepted', nativeSessionId, executorId)
  f.finish(replacement.id, { plan: 'Complete cleanup for requests received before shutdown.' })
  expect(
    f.db.drizzle
      .select()
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.id, reexecution.operationId))
      .get(),
  ).toMatchObject({ result: 'completed', replacementRunId: replacement.id })
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled.planReference?.sourceRunId).toBe(replacement.id)
  const originalReturn = f.repo.prepareCollaborationAction(
    {
      sessionId: f.sessionId,
      taskId: settled.id,
      revision: settled.revision,
      clientMessageId: randomUUID(),
      action: 'resume',
    },
    settings,
  )
  expect(originalReturn.next?.stage).toBe('plan_review')
  f.repo.cancelPreparedCollaborationAction(originalReturn.receipt.id)
  f.receive(f.input('Change the acceptance to require offline operation.'))
  f.finish(f.materialize().run.id, { inputOutcome: 'plan_revision_required' })
  const pending = f.repo.collaboration(f.sessionId)!
  f.db.drizzle
    .update(runReexecutionOperations)
    .set({ result: 'possibly_sent' })
    .where(eq(runReexecutionOperations.id, reexecution.operationId))
    .run()
  expect(() => advance(f, 'resume')).toThrow(/original reviewer/)
  expect(f.repo.collaboration(f.sessionId)).toEqual(pending)
  f.db.drizzle
    .update(runReexecutionOperations)
    .set({ result: 'completed' })
    .where(eq(runReexecutionOperations.id, reexecution.operationId))
    .run()
  expect(f.repo.inputBatchForRun(original.id)).toEqual(originalAuth.inputBatchRef)
  const review = advance(f, 'resume')
  expect(f.repo.collaborationTurnAuthorization(review.id)?.supplementPlanReturn).toMatchObject({
    receiptId: supplement.receipt.id,
    sourceRunId: replacement.id,
  })
  f.finish(review.id, { verdict: 'accepted' })
  expect(advance(f).collaboration?.stage).toBe('plan')
})

it('does not settle an interrupted Plan return and keeps newer input when its retry fulfills the old receipt', async () => {
  const { f, supplement, extra } = await legacyPlanSupplement()
  f.finish(extra.id, { plan: 'The supplementary Plan to return to the original reviewer.' })
  f.receive(f.input('Revise acceptance to include offline cancellation.'))
  f.finish(f.materialize().run.id, { inputOutcome: 'plan_revision_required' })
  const first = advance(f, 'resume')
  const historical = f.repo.collaborationTurnAuthorization(first.id)?.supplementPlanReturn
  expect(historical).toMatchObject({ receiptId: supplement.receipt.id, sourceRunId: extra.id })
  f.finish(first.id, { outcome: 'interrupted' })
  f.repo.recoverCollaborationTasks()
  expect(f.repo.collaboration(f.sessionId)?.planRevision?.returnReview?.receiptId).toBe(
    supplement.receipt.id,
  )
  const second = advance(f, 'resume')
  expect(f.repo.collaborationTurnAuthorization(second.id)?.supplementPlanReturn).toEqual(historical)
  f.repo.pauseCollaboration(f.sessionId, 'user')
  const queued = f.receive(f.input('Also keep the cleanup log.')).send.clientMessageId
  f.finish(second.id, { verdict: 'accepted' })
  const fulfilled = f.repo.collaboration(f.sessionId)!
  expect(fulfilled).toMatchObject({
    automation: 'paused',
    inputProcessing: { pending: { inputId: queued } },
    review: { runId: second.id, supplementPlanReturn: true },
  })
  expect(fulfilled.planRevision?.returnReview).toBeUndefined()
  f.repo.finishCollaboration(second.id, true)
  expect(f.repo.collaboration(f.sessionId)).toEqual(fulfilled)
  expect(
    f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, supplement.receipt.id))
      .get(),
  ).toMatchObject({ reviewState: 'fulfilled', reviewRunId: second.id })
  const answer = f.materialize().run
  f.finish(answer.id, { inputOutcome: 'processed' })
  expect(advance(f, 'resume').collaboration?.stage).toBe('plan')
})

it.each(['receipt', 'settlement', 'report', 'effects'] as const)(
  'blocks the historical Plan return when its exact %s cannot be proved',
  async (failure) => {
    const { f, supplement, extra } = await legacyPlanSupplement()
    f.finish(extra.id, { plan: 'A completed supplementary Plan.' })
    f.receive(f.input('Revise acceptance to include offline cancellation.'))
    f.finish(f.materialize().run.id, { inputOutcome: 'plan_revision_required' })
    const before = f.repo.collaboration(f.sessionId)!
    if (failure === 'receipt') {
      f.db.drizzle
        .update(collaborationActionReceipts)
        .set({ budgetReservationId: null })
        .where(eq(collaborationActionReceipts.id, supplement.receipt.id))
        .run()
    } else if (failure === 'settlement') {
      f.db.drizzle
        .delete(agentEventJournal)
        .where(sql`run_id=${extra.id} AND event_type='workflow.plan_settled'`)
        .run()
    } else if (failure === 'report') {
      f.db.drizzle
        .update(workflowTurns)
        .set({ reportBodyId: null })
        .where(eq(workflowTurns.runId, extra.id))
        .run()
    } else {
      f.db.drizzle
        .update(agentRuns)
        .set({ nativeEffectsState: 'unknown' })
        .where(eq(agentRuns.id, extra.id))
        .run()
    }
    expect(() => advance(f, 'resume')).toThrow(/supplement|recovery/i)
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
  },
)

it('finishes the exact outstanding code supplement review before revising the Plan', async () => {
  const f = await fixture(':memory:', undefined, { primary: 'codex', split: true })
  f.finish()
  f.finish(advance(f).id, { verdict: 'accepted' })
  const write = advance(f, 'execute')
  f.finish(write.id, { answer: 'The earlier implementation is complete.' })
  f.finish(advance(f).id, { verdict: 'changes_requested' })
  f.finish(advance(f, 'respond').id, { answer: 'Response to the original findings.' })
  f.finish(advance(f).id, { verdict: 'changes_requested' })
  const supplement = await confirmedSupplement(f, 'supplement_code_response')
  const extra = startConfirmedSupplement(f, supplement)
  f.repo.pauseCollaboration(f.sessionId, 'stopped')
  f.finish(extra.id, { answer: 'Complete supplementary response.' })

  f.receive(f.input('Expand the Plan to cover offline cancellation.'))
  const reply = f.materialize().run
  f.finish(reply.id, { inputOutcome: 'plan_revision_required' })
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    planRevision: {
      requestRunId: reply.id,
      writeRunId: write.id,
      returnReview: { receiptId: supplement.receipt.id, stage: 'code_review' },
    },
    automation: 'paused',
  })
  const review = advance(f, 'resume')
  expect(review).toMatchObject({ agentId: 'codex', collaboration: { stage: 'code_review' } })
  f.finish(review.id, { verdict: 'accepted' })
  const reviewed = f.repo.collaboration(f.sessionId)!
  expect(reviewed).toMatchObject({
    status: 'waiting',
    codeRunId: write.id,
    reviewCycles: 3,
    planRevision: { requestRunId: reply.id, writeRunId: write.id },
  })
  expect(reviewed.planRevision?.returnReview).toBeUndefined()
  expect(
    f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, supplement.receipt.id))
      .get(),
  ).toMatchObject({ reviewState: 'fulfilled', reviewRunId: review.id })
  const planner = advance(f)
  expect(planner).toMatchObject({ agentId: 'codex', collaboration: { stage: 'plan' } })
})

it.each(['codex', 'claude'] as const)(
  'routes a changed requirement through the fixed plan roles and a new authorization with %s as Primary',
  async (primary) => {
    const f = await fixture(':memory:', undefined, { primary, split: true })
    f.finish()
    f.finish(advance(f).id, { verdict: 'accepted' })
    const original = advance(f, 'execute')
    const originalAuth = f.repo.collaborationTurnAuthorization(original.id)!
    f.finish(original.id, { outcome: 'interrupted', answer: 'Partial implementation remains.' })
    const interrupted = f.repo.collaboration(f.sessionId)!
    const originalContinuation = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: interrupted.id,
        revision: interrupted.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    )

    f.receive(f.input('Change the acceptance criterion to durable cancellation.'))
    const request = f.materialize().run
    f.finish(request.id, { inputOutcome: 'plan_revision_required' })
    const pending = f.repo.collaboration(f.sessionId)!
    expect(pending).toMatchObject({
      automation: 'paused',
      pendingWork: { runId: original.id },
      planRevision: { requestRunId: request.id, writeRunId: original.id },
    })
    expect(() =>
      f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: originalContinuation.receipt.clientNonce,
        content: 'Stale resume before changed requirements.',
        commentIds: [],
        expectedCommentsRevision: f.drafts().commentsRevision,
        agentId: original.agentId,
        settingsRevision: 1,
        model: null,
        effort: null,
        preserveDraftComments: true,
        expectedCollaborationRevision: interrupted.revision,
        collaboration: originalContinuation.next!,
        schedulingHandoff: originalContinuation.handoff,
        collaborationActionReceiptId: originalContinuation.receipt.id,
      }),
    ).toThrow(/changed|current|handoff/i)
    const planner = advance(f, 'resume')
    expect(planner).toMatchObject({ agentId: primary, collaboration: { stage: 'plan' } })
    expect(
      f.repo.readFrozenInputBatch(planner.id, originalAuth.inputBatchRef!.id).batch,
    ).toMatchObject(originalAuth.inputBatchRef!)
    if (primary === 'claude') {
      const { document } = pending.planReference!
      f.repo.recordWorkflowPlanRetained(planner.id, {
        nativeId: 'unchanged-current-plan',
        confirmation: 'native_root_settled_v1',
        sha256: document.sha256,
        bytes: document.bytes,
        chars: document.chars,
      })
      f.finish(planner.id, { answer: 'The current Plan covers the revised requirement.' })
    } else f.finish(planner.id, { plan: 'Scope and acceptance.' })
    const review = advance(f)
    expect(review).toMatchObject({
      agentId: original.agentId,
      collaboration: { stage: 'plan_review' },
    })
    f.finish(review.id, { verdict: 'accepted' })
    const ready = f.repo.collaboration(f.sessionId)!
    expect(ready.status).toBe('ready')
    expect(ready.pendingWork).toEqual(pending.pendingWork)
    expect(ready.planVersion).toBe(pending.planVersion)
    const revised = advance(f, 'execute')
    const authorization = f.repo.collaborationTurnAuthorization(revised.id)!
    expect(authorization.userAuthority?.purpose).toBe('action')
    expect(authorization.userAuthority?.rootReceiptId).not.toBe(
      originalAuth.userAuthority?.rootReceiptId,
    )
    expect(f.repo.collaboration(f.sessionId)?.planRevision).toBeUndefined()
    expect(f.repo.collaborationTurnAuthorization(original.id)).toEqual(originalAuth)
    expect(
      f.repo.readFrozenInputBatch(revised.id, originalAuth.inputBatchRef!.id).batch,
    ).toMatchObject(originalAuth.inputBatchRef!)
  },
)

it.each(['codex', 'claude'] as const)(
  'resumes interrupted plan implementation after processed replies with %s as Primary',
  async (primary) => {
    const f = await fixture(':memory:', undefined, { primary, split: true })
    const implementer = primary === 'codex' ? 'claude' : 'codex'
    f.finish()
    const review = advance(f)
    f.finish(review.id, { verdict: 'accepted' })
    const write = advance(f, 'execute')
    const original = f.repo.collaborationTurnAuthorization(write.id)!
    f.finish(write.id, { outcome: 'interrupted' })
    const interrupted = f.repo.collaboration(f.sessionId)!
    for (let index = 0; index < 2; index++) {
      f.receive(f.input('Continue the same accepted implementation; keep its scope unchanged.'))
      const reply = f.materialize()
      expect(reply.run.agentId).toBe(implementer)
      expect(reply.run.collaboration?.stage).toBe('reply')
      f.finish(reply.run.id, { inputOutcome: 'processed' })
      expect(f.repo.collaboration(f.sessionId)).toMatchObject({
        automation: 'paused',
        pendingWork: interrupted.pendingWork,
        planReference: interrupted.planReference,
      })
    }
    const current = f.repo.collaboration(f.sessionId)!
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: current.id,
        revision: current.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    )
    expect(prepared.next).toMatchObject({ stage: 'implement', actor: implementer })
    if (!prepared.next || !prepared.task || !prepared.handoff) throw Error('Missing continuation')
    const admission = {
      sessionId: f.sessionId,
      clientMessageId: prepared.receipt.clientNonce,
      content: 'Continue the original implementation.',
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
    }
    const continued = f.repo.beginRun(admission)
    expect(f.repo.collaborationTurnAuthorization(continued.run.id)).toMatchObject({
      stage: 'implement',
      actor: implementer,
      inputSequence: current.inputSequence,
      planReference: original.planReference,
      userAuthority: {
        purpose: 'write_continuation',
        rootReceiptId: original.userAuthority!.rootReceiptId,
      },
    })
    expect(f.repo.beginRun(admission)).toMatchObject({ created: false })
    expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(0)
    expect(f.repo.collaborationTurnAuthorization(write.id)).toEqual(original)
    f.finish(continued.run.id, { answer: 'Original implementation completed.' })
    expect(advance(f).collaboration).toMatchObject({ stage: 'code_review' })
  },
)

it.each([
  { primary: 'codex', split: false },
  { primary: 'claude', split: false },
  { primary: 'codex', split: true },
  { primary: 'claude', split: true },
] as const)(
  'continues the exact original $primary write after processed input, restart and Primary changes; split=$split',
  async ({ primary, split }) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-role-continuation-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath, undefined, { primary, split })
    const secondary = primary === 'codex' ? 'claude' : 'codex'
    const implementer = split ? secondary : primary
    f.finish()
    const review = advance(f)
    f.finish(review.id, { verdict: 'accepted' })
    const write = advance(f, 'execute')
    const originalAuth = f.repo.collaborationTurnAuthorization(write.id)!
    const rootReceipt = f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, originalAuth.userAuthority!.rootReceiptId))
      .get()!
    f.finish(write.id, {
      outcome: 'interrupted',
      answer: 'Unfinished authorized work; source retained.',
    })
    const interrupted = f.repo.collaboration(f.sessionId)!
    expect(interrupted.pendingWork).toMatchObject({ stage: 'implement', runId: write.id })
    f.receive(f.input('Report where the original implementation stopped; preserve its scope.'))
    const reply = f.materialize()
    expect(reply.run.agentId).toBe(implementer)
    f.finish(reply.run.id, { inputOutcome: 'processed' })
    const frozenTurn = f.db.drizzle
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, write.id))
      .get()!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...f.db.sessionRepository.find(f.sessionId)!.settings,
      primaryAgentId: secondary,
    })
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const db = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.push(db)
    const repo = db.conversationRepository
    repo.recoverCollaborationTasks()
    const current = repo.collaboration(f.sessionId)!
    expect(current.rolePolicy).toBe(split ? 'split-stages-v1' : undefined)
    expect(current.pendingWork).toEqual(interrupted.pendingWork)
    const prepared = repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: current.id,
        revision: current.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      },
      settings,
    )
    if (!prepared.next || !prepared.task || !prepared.handoff)
      throw new Error('Missing concrete continuation')
    expect(prepared.next.actor).toBe(implementer)
    const basis = collaborationActionBasisSchema.parse(JSON.parse(prepared.receipt.basisJson))
    expect(basis.actor).toBe(implementer)
    expect(basis.rolePolicy).toBe(split ? 'split-stages-v1' : undefined)
    const admission = {
      sessionId: f.sessionId,
      clientMessageId: prepared.receipt.clientNonce,
      content: 'Continue only the original unfinished scope.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: prepared.next.actor,
      settingsRevision: 2,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: prepared.task.revision,
      collaboration: prepared.next,
      schedulingHandoff: prepared.handoff,
      collaborationActionReceiptId: prepared.receipt.id,
    }
    const continued = repo.beginRun(admission)
    const auth = repo.collaborationTurnAuthorization(continued.run.id)!
    expect(continued.run.agentId).toBe(implementer)
    expect(auth.userAuthority).toMatchObject({
      rootReceiptId: originalAuth.userAuthority!.rootReceiptId,
      purpose: 'write_continuation',
    })
    expect(repo.collaboration(f.sessionId)?.repairAttempts).toBe(interrupted.repairAttempts)
    expect(
      db.drizzle.select().from(workflowTurns).where(eq(workflowTurns.runId, write.id)).get(),
    ).toEqual(frozenTurn)
    const savedRoot = db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, rootReceipt.id))
      .get()!
    expect({
      actor: savedRoot.actor,
      rootReceiptId: savedRoot.rootReceiptId,
      basisJson: savedRoot.basisJson,
    }).toEqual({
      actor: rootReceipt.actor,
      rootReceiptId: rootReceipt.rootReceiptId,
      basisJson: rootReceipt.basisJson,
    })
    const batch = repo.readFrozenInputBatch(continued.run.id, originalAuth.inputBatchRef!.id)
    expect(batch.batch).toMatchObject(originalAuth.inputBatchRef!)
    expect(repo.sourceDocumentAuthorized(continued.run.id, batch.body!)).toBe(true)
    expect(repo.beginRun(admission)).toMatchObject({
      created: false,
      run: { id: continued.run.id },
    })
  },
)

it('settles the original plan after a completed root was applied as a projection failure', async () => {
  const f = await fixture(undefined, undefined, { primary: 'claude', inputSequence: 1 })
  const runId = f.first.run.id
  f.repo.recordNativeEffects(runId, 'pending')
  f.finish(runId, { answer: 'The plan is saved.' }, false)
  f.repo.finishCollaboration(runId, false, 'Native plan observations conflict.')
  expect(f.repo.collaboration(f.sessionId)).toMatchObject({
    handledInputSequence: 0,
    automation: 'paused',
  })
  expect(
    f.db.drizzle.select().from(workflowTurns).where(eq(workflowTurns.runId, runId)).get()?.applied,
  ).toBe(true)
  f.repo.recordWorkflowPlan(runId, { nativeId: 'saved-plan', text: 'Verified original plan.' })
  f.repo.reconcileCompletedCollaboration(runId)
  expect(f.repo.collaboration(f.sessionId)?.planVersion).toBe(0)
  f.repo.recordNativeEffects(runId, 'settled')
  f.repo.reconcileCompletedCollaboration(runId)
  const settled = f.repo.collaboration(f.sessionId)!
  expect(settled).toMatchObject({
    handledInputSequence: 1,
    planVersion: 1,
    automation: 'paused',
    nextStage: 'plan_review',
  })
  expect(f.repo.read(f.sessionId).runs).toHaveLength(1)
  f.repo.reconcileCompletedCollaboration(runId)
  expect(f.repo.collaboration(f.sessionId)).toEqual(settled)
})
