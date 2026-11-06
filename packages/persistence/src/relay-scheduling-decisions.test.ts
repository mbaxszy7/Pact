/* oxlint-disable vitest/no-conditional-expect -- Cold recovery assertions distinguish unused gates from bound business obligations. */
import { and, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  collaborationActor,
  collaborationTaskSchema,
  collaborationDocumentSchema,
  defaultTaskStageRoles,
  relayDecisionReceiptSchema,
  relaySchedulingDecisionProofSchema,
  type AgentNativeForkBoundary,
  type CollaborationTask,
  type RelayDecisionAnswer,
} from '@pact/contracts'

import { RunOperationConflictError } from './conversation-errors.js'
import {
  configureDecisionFixtureCredential,
  decisionHttpOwnerFixture,
} from './decision-fixture.test-support.js'
import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentRuns,
  collaborationActionReceipts,
  collaborationTasks,
  conversationBodyParts,
  conversationMessages,
  nativeAgentContexts,
  relayDecisions,
  schedulingActivity,
  schedulingBudgetReservations,
  schedulingEvaluations,
} from './schema/index.js'

const databases = new Set<PactDatabase>(),
  directories: string[] = []
function approvedWork(text: string) {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Missing approved-work document')
  const responsibility: unknown = Reflect.get(value, 'responsibility'),
    sources: unknown = Reflect.get(value, 'sources')
  if (
    Reflect.get(value, 'version') !== 'relay-approved-work-v1' ||
    typeof responsibility !== 'string' ||
    !Array.isArray(sources)
  )
    throw Error('Invalid approved-work document')
  return {
    responsibility,
    sources: sources.map((source: unknown) => {
      if (!source || typeof source !== 'object' || Array.isArray(source))
        throw Error('Invalid approved-work citation')
      return { document: collaborationDocumentSchema.parse(Reflect.get(source, 'document')) }
    }),
  }
}
afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workflow(filePath?: string) {
  const f = await planRevisionFixture(filePath ? { filePath } : {})
  databases.add(f.db)
  const firstResponse = f.repo.beginRun(f.admission()).run
  f.finish(firstResponse.id, { plan: 'First revised Plan.' })
  const secondReview = f.repo.beginRun(f.admission()).run
  f.finish(secondReview.id, {
    verdict: 'changes_requested',
    answer: 'The second complete review still requires cancellation evidence.',
  })
  const response = f.repo.beginRun(f.admission()).run
  f.repo.recordWorkflowPlan(response.id, {
    nativeId: 'unselected-publication',
    text: 'Superseded author material that is not among the selected scheduling sources.',
  })
  const observed = f.db.drizzle.get<{ source: string }>(
    sql`SELECT json_extract(payload, '$.source') AS source FROM agent_event_journal
      WHERE run_id=${response.id} AND event_type='workflow.plan_observed' ORDER BY sequence DESC LIMIT 1`,
  )
  const unrelated = collaborationDocumentSchema.parse(JSON.parse(observed.source))
  f.finish(response.id, {
    plan: 'Revised complete Plan. Preserve the original cancellation boundary.',
    answer: 'Author response addressing the original review, including its complete final page.',
  })
  const admission = f.admission(),
    handoff = admission.schedulingHandoff
  expect(
    f.repo
      .relayWorkflowAlternatives(handoff)
      ?.alternatives.find((e) => e.kind === 'supplement_plan')?.kind,
  ).toBe('supplement_plan')
  return { ...f, response, unrelated, handoff, defaultAdmission: admission }
}

async function evaluated(filePath?: string) {
  const f = await workflow(filePath),
    owner = decisionHttpOwnerFixture()
  configureDecisionFixtureCredential(f.repo)
  const deadlineAt = Date.now() + 15_000,
    configurationFingerprint = f.repo.schedulingConfigurationFingerprint()
  const material = await f.repo.readRelayWorkflowDecisionSources(
    f.handoff,
    [
      {
        id: 'propose_supplement_plan',
        description: 'Request one specific read-only clarification.',
      },
    ],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff: f.handoff,
    configurationFingerprint,
    deadlineAt,
    inputSha256: material.inputSha256,
    httpOwner: owner,
  })
  if (reserved.status !== 'reserved') throw Error('Missing real evaluation reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id, owner)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'propose_supplement_plan',
    httpOwner: owner,
    remoteOutcome: 'responded',
  })
  const proposal = {
    handoff: f.handoff,
    kind: 'supplement_plan' as const,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint,
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    sourceIds: material.sources.map((source) => source.id),
  }
  return { ...f, material, proposal }
}

async function proposed(filePath?: string) {
  const f = await evaluated(filePath),
    card = f.repo.proposeRelayWorkflowAction(f.proposal)
  const answer: RelayDecisionAnswer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  }
  return { ...f, card, answer }
}
type Fixture = Awaited<ReturnType<typeof proposed>>

function startSupplement(f: Fixture) {
  const accepted = f.repo.answerRelaySchedulingDecision(f.answer)
  if (!('receiptId' in accepted) || !accepted.receiptId) throw Error('Missing confirmation receipt')
  const prepared = f.repo.preparedRelayWorkflowAction(accepted.receiptId)
  const result = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: prepared.receipt.clientNonce,
    content: 'Perform the exact approved read-only clarification.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: prepared.next.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: prepared.task.revision,
    collaboration: prepared.next,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  })
  return { ...result, receiptId: prepared.receipt.id }
}

function answerWithNewInput(f: Fixture) {
  const clientMessageId = randomUUID(),
    owner = randomUUID(),
    content = 'Keep the original cancellation requirement while addressing this new input.'
  const body = f.repo.writeConversationInput(
    { type: 'begin', sessionId: f.sessionId, clientMessageId },
    owner,
  )
  f.repo.writeConversationInput(
    { type: 'append', sessionId: f.sessionId, inputId: body.inputId, offset: 0, text: content },
    owner,
  )
  f.repo.writeConversationInput(
    { type: 'seal', sessionId: f.sessionId, inputId: body.inputId },
    owner,
  )
  const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing drafts')
  f.repo.receiveCollaborationInput(
    {
      sessionId: f.sessionId,
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
  const received = f.repo.readReceivedInput(f.sessionId)!,
    task = f.repo.collaboration(f.sessionId)!,
    next = f.repo.workflowReply(task, received.actor)
  next.latestUserMessageId = received.id
  const reply = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: received.id,
    content: received.content,
    commentIds: [],
    expectedCommentsRevision: drafts.commentsRevision,
    agentId: received.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    receivedInputId: received.id,
    expectedCollaborationRevision: task.revision,
    collaboration: next,
  }).run
  f.finish(reply.id, { plan: 'Current Plan after the new input. Keep cancellation explicit.' })
  const settings = f.db.sessionRepository.find(f.sessionId)!.settings
  f.repo.setCollaborationState(
    advanceCollaboration(f.repo.collaboration(f.sessionId)!, 'resume', settings),
  )
  return reply
}

describe('Relay v2 supplement transactions through the existing workflow owner', () => {
  it('uses the host explanation while retaining complete original sources', async () => {
    const f = await evaluated()
    const before = f.material.sources.map((source) => f.readDocument(source.document))
    const card = f.repo.proposeRelayWorkflowAction(f.proposal)
    expect(card.reason).toBe('Clarify the current Plan before another review.')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(card)
    expect(f.material.sources.map((source) => f.readDocument(source.document))).toEqual(before)
  })
  it('proposes before any advance user grant and blocks ordinary or default admission until answered', async () => {
    const f = await proposed()
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(f.card)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.handoffId, f.handoff.id))
        .all(),
    ).toEqual([])
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    expect(() => f.repo.beginRun(f.defaultAdmission)).toThrow('current supplement decision')
    expect(() =>
      f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'An ordinary Send is not a Relay answer.',
        commentIds: [],
        expectedCommentsRevision: 0,
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      }),
    ).toThrow('current supplement decision')
    expect(f.repo.handoffReceipt(f.handoff.id)?.runId).toBeNull()
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(5)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })

  it('uses one immutable confirmation nonce and digest and reads the same receipt after real admission', async () => {
    const f = await proposed(),
      accepted = f.repo.answerRelaySchedulingDecision(f.answer)
    expect(accepted.created).toBe(true)
    expect(f.repo.answerRelaySchedulingDecision(f.answer)).toEqual({
      result: accepted.result,
      created: false,
    })
    for (const changed of [
      { ...f.answer, clientOperationId: randomUUID() },
      { ...f.answer, answer: { kind: 'cancel' as const } },
      { ...f.answer, reference: { ...f.answer.reference, revision: f.card.revision + 1 } },
    ])
      expect(() => f.repo.answerRelaySchedulingDecision(changed)).toThrow('different answer')
    // Readback cannot create a new execution receipt; dispatch still consumes the existing one.
    const prepared = f.repo.preparedRelayWorkflowAction(
      'receiptId' in accepted ? accepted.receiptId! : '',
    )
    const started = f.repo.beginRun({
      ...f.defaultAdmission,
      clientMessageId: f.answer.clientOperationId,
      content: 'Approved read-only clarification.',
      agentId: prepared.next.actor,
      collaboration: prepared.next,
      expectedCollaborationRevision: prepared.task.revision,
      schedulingHandoff: prepared.handoff,
      collaborationActionReceiptId: prepared.receipt.id,
    })
    expect(started.created).toBe(true)
    expect(f.repo.answerRelaySchedulingDecision(f.answer)).toEqual({
      result: { ...accepted.result, runId: started.run.id },
      created: false,
    })
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toHaveLength(1)
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraPlanTurns).toBe(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })

  it('lets an accepted manual handoff win while delayed model advice cannot replace its receipt', async () => {
    const f = await evaluated(),
      task = f.repo.collaboration(f.sessionId)!,
      settings = f.db.sessionRepository.find(f.sessionId)!.settings
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        action: 'continue',
        clientMessageId: randomUUID(),
      },
      settings,
    )
    expect(prepared.handoff?.id).toBe(f.handoff.id)
    expect(() => f.repo.proposeRelayWorkflowAction(f.proposal)).toThrow('no longer current')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([
      prepared.receipt,
    ])
  })

  it.each(['confirm', 'cancel'] as const)(
    'rolls back the complete %s transaction after a late journal failure',
    async (kind) => {
      const f = await proposed(),
        task = f.repo.collaboration(f.sessionId),
        budget = f.repo.schedulingBudget(f.handoff.budgetSubjectId)
      f.db.drizzle.run(sql`CREATE TRIGGER reject_relay_answer BEFORE INSERT ON agent_event_journal
        WHEN NEW.event_type='scheduling.user_decision_answered'
        BEGIN SELECT RAISE(ABORT, 'owned Relay answer failure'); END`)
      expect(() => f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind } })).toThrow(
        'owned Relay answer failure',
      )
      expect(f.repo.collaboration(f.sessionId)).toEqual(task)
      expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)).toEqual(budget)
      expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(f.card)
      expect(f.db.drizzle.select().from(relayDecisions).get()).toMatchObject({
        state: 'awaiting_answer',
        answerNonce: null,
        answerDigest: null,
        answerJson: null,
        resultJson: null,
      })
      expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    },
  )

  it.each(['expired', 'unselected-source'] as const)(
    'rejects a %s proposal before creating authority or an input gate',
    async (mutation) => {
      const f = await evaluated()
      const proposal =
        mutation === 'expired'
          ? { ...f.proposal, deadlineAt: Date.now() - 1 }
          : { ...f.proposal, sourceIds: ['not-a-host-selected-source'] }
      expect(() => f.repo.proposeRelayWorkflowAction(proposal)).toThrow('no longer current')
      expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
      expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
      expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraPlanTurns).toBe(0)
    },
  )

  it('cancels only this advancement, preserves the original completed Run and leaves collaboration paused', async () => {
    const f = await proposed(),
      before = f.repo.findRun(f.response.id)
    const result = f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } })
    expect(result.result.disposition).toBe('cancelled')
    const after = f.repo.findRun(f.response.id)!
    // The new scheduling audit event may advance the projection timestamp only.
    expect(after).toEqual({ ...before, updatedAt: after.updatedAt })
    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      automation: 'paused',
      pauseReason: 'user',
    })
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraPlanTurns).toBe(0)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
  })

  it('invalidates a waiting answer when the receiving reviewer settings change', async () => {
    const f = await proposed(),
      settings = f.db.sessionRepository.find(f.sessionId)!.settings
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...settings,
      agents: { ...settings.agents, claude: { model: 'changed-review-model', effort: 'high' } },
    })
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(/changed/u)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    expect(f.repo.schedulingBudget(f.handoff.budgetSubjectId)?.extraPlanTurns).toBe(0)
  })

  it('freezes the exact approved responsibility and complete citations without granting an unselected sibling document', async () => {
    const f = await proposed(),
      extra = startSupplement(f).run,
      auth = f.repo.collaborationTurnAuthorization(extra.id)!
    expect(auth.userAuthority).toMatchObject({
      purpose: 'supplement_plan',
      returnActor: 'claude',
      returnStage: 'plan_review',
    })
    expect(auth.relayWorkRef).toBeDefined()
    const work = approvedWork(f.readDocument(auth.relayWorkRef!))
    expect(work.responsibility).toBe('Clarify the current Plan before another review.')
    expect(work.sources.map((source) => source.document)).toEqual(
      f.material.sources.map((source) => source.document),
    )
    expect(f.repo.sourceDocumentAuthorized(extra.id, auth.relayWorkRef!)).toBe(true)
    for (const source of work.sources) {
      expect(f.repo.sourceDocumentAuthorized(extra.id, source.document)).toBe(true)
      expect(f.readDocument(source.document)).not.toBe('')
    }
    expect(f.material.sources.some((source) => source.document.id === f.unrelated.id)).toBe(false)
    expect(f.repo.sourceDocumentAuthorized(extra.id, f.unrelated)).toBe(false)
  })

  it('carries the original extra report and every frozen original source to mandatory review after the input cursor advances', async () => {
    const f = await proposed(),
      extra = startSupplement(f).run
    f.finish(extra.id, {
      plan: 'Extra Plan clarification.',
      answer: 'Exact extra report before the later input.',
    })
    const extraAuth = f.repo.collaborationTurnAuthorization(extra.id)!,
      report = f.repo.readRunSources(extra.id).items
    answerWithNewInput(f)
    expect(f.repo.collaboration(f.sessionId)!.inputSequence).toBeGreaterThan(
      extraAuth.inputSequence,
    )
    const review = f.repo.beginRun(f.admission()).run
    expect(review.agentId).toBe('claude')
    expect(review.collaboration?.stage).toBe('plan_review')
    const grants = f.repo.readRunSources(review.id).items
    expect(
      grants.some((source) => source.messageId === f.repo.findRun(extra.id)!.responseMessageId),
    ).toBe(true)
    for (const source of report)
      for (const document of source.documents)
        expect(f.repo.sourceDocumentAuthorized(review.id, document.source)).toBe(true)
    expect(
      f.material.sources
        .filter((source) => !f.repo.sourceDocumentAuthorized(review.id, source.document))
        .map((source) => ({ roles: source.roles, document: source.document })),
    ).toEqual([])
    expect(f.repo.sourceDocumentAuthorized(review.id, f.unrelated)).toBe(false)
    f.finish(review.id, { verdict: 'accepted' })
    expect(f.db.drizzle.select().from(collaborationActionReceipts).get()?.reviewState).toBe(
      'fulfilled',
    )
  })

  it.each(['awaiting_answer', 'available', 'bound'] as const)(
    'discards unused %s intent on cold recovery while preserving bound budgets and mandatory review',
    async (state) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-relay-v2-restart-'))
      directories.push(directory)
      const filePath = join(directory, 'pact.sqlite'),
        f = await proposed(filePath)
      let boundRunId: string | undefined
      if (state === 'available') f.repo.answerRelaySchedulingDecision(f.answer)
      if (state === 'bound') {
        boundRunId = startSupplement(f).run.id
        f.finish(boundRunId, { plan: 'Completed extra clarification.' })
      }
      const budget = f.repo.schedulingBudget(f.handoff.budgetSubjectId)
      databases.delete(f.db)
      f.db.close()
      const reopened = await PactDatabase.open({
        filePath,
        migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
      })
      databases.add(reopened)
      const repo = reopened.conversationRepository
      repo.recoverCollaborationTasks()
      expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(repo.collaboration(f.sessionId)).toMatchObject({
        automation: 'paused',
        pauseReason: 'restart',
      })
      expect(repo.schedulingBudget(f.handoff.budgetSubjectId)).toEqual(budget)
      expect(reopened.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
      const receipt = reopened.drizzle.select().from(collaborationActionReceipts).get()
      if (state === 'bound') {
        expect(receipt).toMatchObject({ boundRunId, reviewState: 'pending' })
        expect(receipt?.state).not.toBe('cancelled')
      } else {
        expect(reopened.drizzle.select().from(relayDecisions).get()).toMatchObject({
          active: false,
          state: 'invalid',
        })
        if (state === 'available')
          expect(receipt).toMatchObject({ active: false, state: 'cancelled', boundRunId: null })
      }
    },
  )

  it('retains remapped historical approved-work documents after Fork while stripping live authority and decisions', async () => {
    const f = await proposed(),
      extra = startSupplement(f).run
    f.finish(extra.id, { plan: 'Completed extra clarification.' })
    const session = f.db.sessionRepository.find(f.sessionId)!,
      selection = f.repo.selectForkSource(
        f.sessionId,
        f.repo.findRun(extra.id)!.responseMessageId!,
        session.settings,
        session.settingsRevision,
      )
    const boundary = (agentId: 'codex' | 'claude'): AgentNativeForkBoundary => {
      const run = selection.runs[agentId],
        response = f.repo.forkResponse(run.id, selection.prepared.sequence)
      return {
        nativeSessionId: run.nativeSessionId!,
        nativeCutId: run.id,
        nativeTurnId: run.nativeTurnId!,
        bindingGeneration: run.bindingGeneration,
        throughSequence: response.sequence,
        deliveryCursor: response.deliveryCursor,
        prefixHash: 'b'.repeat(64),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const child = f.repo.commitFork(
      randomUUID(),
      selection,
      { codex: boundary('codex'), claude: boundary('claude') },
      [],
    )
    const inherited = f.db.drizzle
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.sessionId, child.sessionId))
        .all()
        .find((run) => run.forkSourceRunId === extra.id)!,
      auth = f.repo.collaborationTurnAuthorization(inherited.id)!
    expect(auth.userAuthority).toBeUndefined()
    expect(auth.relayWorkRef).toBeDefined()
    expect(f.repo.sourceDocumentAuthorized(inherited.id, auth.relayWorkRef!)).toBe(true)
    const work = approvedWork(f.readDocument(auth.relayWorkRef!, child.sessionId))
    for (const source of work.sources)
      expect(f.repo.sourceDocumentAuthorized(inherited.id, source.document)).toBe(true)
    expect(f.repo.collaboration(child.sessionId)).toBeUndefined()
    expect(f.repo.relaySchedulingDecision(child.sessionId)).toBeNull()
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.sessionId, child.sessionId))
        .all(),
    ).toEqual([])
  })
})

async function readyRoles(
  options: {
    filePath?: string
    owner?: 'codex' | 'claude'
    legacy?: boolean
    implicitRoles?: boolean
  } = {},
) {
  const owner = options.owner ?? 'codex'
  const f = await planRevisionFixture({
    ...(options.filePath ? { filePath: options.filePath } : {}),
    owner,
    ...(!options.legacy ? { rolePolicy: 'split-stages-v1' as const } : {}),
    ...(!options.legacy && !options.implicitRoles
      ? { stageRoles: defaultTaskStageRoles(owner) }
      : {}),
  })
  databases.add(f.db)
  const revision = f.repo.beginRun(f.admission()).run
  f.finish(revision.id, { plan: 'Complete accepted implementation and cancellation scope.' })
  const review = f.repo.beginRun(f.admission()).run
  f.finish(review.id, { verdict: 'accepted' })
  const task = f.repo.collaboration(f.sessionId)!
  const handoff = f.repo.workflowHandoff(task, collaborationActor(task, 'implement'))
  return { ...f, task, handoff }
}

async function evaluatedRoles(
  options: Parameters<typeof readyRoles>[0] = {},
  outcome: 'selected' | 'declined' | 'failed' = 'selected',
) {
  const f = await readyRoles(options),
    owner = decisionHttpOwnerFixture()
  configureDecisionFixtureCredential(f.repo)
  const deadlineAt = Date.now() + 15_000,
    configurationFingerprint = f.repo.schedulingConfigurationFingerprint()
  const material = await f.repo.readRelayWorkflowDecisionSources(
    f.handoff,
    [{ id: 'propose_reassign_roles', description: 'Request a future code-role change.' }],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff: f.handoff,
    configurationFingerprint,
    deadlineAt,
    inputSha256: material.inputSha256,
    httpOwner: owner,
  })
  if (reserved.status !== 'reserved') throw Error('Missing real evaluation reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id, owner)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: outcome === 'failed' ? 'failed' : 'completed',
    physicalReleased: true,
    selectedCandidateId: outcome === 'selected' ? 'propose_reassign_roles' : null,
    httpOwner: owner,
    remoteOutcome: outcome === 'failed' ? 'unknown' : 'responded',
  })
  const proposal = {
    handoff: f.handoff,
    kind: 'reassign_roles' as const,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint,
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    sourceIds: material.sources.map((source) => source.id),
  }
  return { ...f, material, proposal }
}

async function proposedRoles(options: Parameters<typeof readyRoles>[0] = {}) {
  const f = await evaluatedRoles(options),
    card = f.repo.proposeRelayWorkflowAction(f.proposal)
  const answer: RelayDecisionAnswer = {
    reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  }
  return { ...f, card, answer }
}
type RoleFixture = Awaited<ReturnType<typeof readyRoles>>

function roleStable<T extends { updatedAt?: string }>({ updatedAt: _updatedAt, ...rest }: T) {
  return rest
}

function roleSnapshot(f: RoleFixture, sessionId: string) {
  const runs = f.db.drizzle.select().from(agentRuns).all()
  const budget = f.repo.schedulingBudget(f.handoff.budgetSubjectId)
  expect(budget).toBeDefined()
  return {
    task: f.repo.collaboration(sessionId),
    runs: runs.map(roleStable),
    authorizations: Object.fromEntries(
      runs.map((run) => [run.id, f.repo.collaborationTurnAuthorization(run.id)]),
    ),
    sources: Object.fromEntries(runs.map((run) => [run.id, f.repo.readRunSources(run.id)])),
    receipts: f.db.drizzle.select().from(collaborationActionReceipts).all().map(roleStable),
    decisions: f.db.drizzle.select().from(relayDecisions).all().map(roleStable),
    evaluations: f.db.drizzle.select().from(schedulingEvaluations).all(),
    budget,
    messages: f.db.drizzle.select().from(conversationMessages).all().map(roleStable),
    settings: f.db.sessionRepository.find(sessionId)!.settings,
    settingsRevision: f.db.sessionRepository.find(sessionId)!.settingsRevision,
  }
}

function roleEventCount(f: RoleFixture) {
  return f.db.drizzle.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM agent_event_journal WHERE event_type='scheduling.roles_reassigned'`,
  ).n
}

function expectedRoleSwap(previous: {
  revision: number
  planAuthor: 'codex' | 'claude'
  planReviewer: 'codex' | 'claude'
  codeAuthor: 'codex' | 'claude'
  codeReviewer: 'codex' | 'claude'
}) {
  return {
    ...previous,
    revision: previous.revision + 1,
    codeAuthor: previous.codeReviewer,
    codeReviewer: previous.codeAuthor,
  }
}

function beginRoleStep(f: Awaited<ReturnType<typeof readyRoles>>, action: 'execute' | 'continue') {
  const task = f.repo.collaboration(f.sessionId)!
  const settings = f.db.sessionRepository.find(f.sessionId)!.settings
  const draftsPage = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  const commentsRevision = draftsPage.scope === 'drafts' ? draftsPage.commentsRevision : 0
  if (action === 'execute') {
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: randomUUID(),
        action: 'execute',
      },
      settings,
    )
    const run = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: prepared.receipt.clientNonce,
      content: 'Implement the accepted Plan.',
      commentIds: [],
      expectedCommentsRevision: commentsRevision,
      agentId: collaborationActor(task, 'implement'),
      settingsRevision: 1,
      model: null,
      effort: null,
      expectedCollaborationRevision: task.revision,
      collaboration: prepared.next,
      schedulingHandoff: prepared.handoff,
      collaborationActionReceiptId: prepared.receipt.id,
    }).run
    return { run, prepared }
  }
  const next = advanceCollaboration(task, 'continue', settings)
  const run = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Continue authorized work.',
    commentIds: [],
    expectedCommentsRevision: commentsRevision,
    agentId: collaborationActor(task, next.stage),
    settingsRevision: 1,
    model: null,
    effort: null,
    expectedCollaborationRevision: task.revision,
    collaboration: next,
  }).run
  return { run }
}

describe('Relay v2 future code-role change at accepted plan-ready', () => {
  it.each(['codex', 'claude'] as const)(
    'confirms one versioned code-role change for %s before any implementation',
    async (owner) => {
      const f = await proposedRoles({ owner })
      const before = f.repo.collaboration(f.sessionId)!
      const previous = before.stageRoles!
      const swapped = expectedRoleSwap(previous)
      const beforeSnap = roleSnapshot(f, f.sessionId)
      const answered = f.repo.answerRelaySchedulingDecision(f.answer)
      expect(answered.created).toBe(true)
      expect(answered.receiptId).toBeUndefined()
      expect(answered.result).toMatchObject({
        disposition: 'confirmed',
        runId: null,
        rebuildId: null,
        roleChange: {
          taskId: before.id,
          taskRevision: before.revision + 1,
          stageRoles: swapped,
        },
      })
      expect(f.repo.collaboration(f.sessionId)).toEqual({
        ...before,
        revision: before.revision + 1,
        stageRoles: swapped,
      })
      const afterSnap = roleSnapshot(f, f.sessionId)
      expect(afterSnap.runs).toEqual(beforeSnap.runs)
      expect(afterSnap.authorizations).toEqual(beforeSnap.authorizations)
      expect(afterSnap.sources).toEqual(beforeSnap.sources)
      expect(afterSnap.receipts).toEqual(beforeSnap.receipts)
      expect(afterSnap.budget).toEqual(beforeSnap.budget)
      expect(afterSnap.messages).toEqual(beforeSnap.messages)
      expect(afterSnap.settings).toEqual(beforeSnap.settings)
      expect(afterSnap.settingsRevision).toBe(beforeSnap.settingsRevision)
      expect(roleEventCount(f)).toBe(1)
      // The ready task awaits explicit Implement plan; the confirmed map drives new stages.
      const implement = beginRoleStep(f, 'execute')
      expect(implement.run.agentId).toBe(swapped.codeAuthor)
      expect(f.repo.collaborationTurnAuthorization(implement.run.id)?.userAuthority?.purpose).toBe(
        'action',
      )
      f.finish(implement.run.id, { answer: 'Implemented.' })
      const review = beginRoleStep(f, 'continue')
      expect(review.run.agentId).toBe(swapped.codeReviewer)
      expect(f.repo.collaborationTurnAuthorization(review.run.id)?.userAuthority).toBeUndefined()
      f.finish(review.run.id, { verdict: 'accepted' })
      const endSnap = roleSnapshot(f, f.sessionId)
      // Frozen Plan/review auths and sources retain their original roles.
      for (const runId of Object.keys(beforeSnap.authorizations)) {
        expect(f.repo.collaborationTurnAuthorization(runId)).toEqual(
          beforeSnap.authorizations[runId],
        )
        expect(f.repo.readRunSources(runId)).toEqual(beforeSnap.sources[runId])
      }
      expect(endSnap.receipts.length).toBeGreaterThan(beforeSnap.receipts.length)
      expect(
        f.repo.relayDecisionReceipt({
          sessionId: f.sessionId,
          decisionId: f.card.decisionId,
          clientOperationId: f.answer.clientOperationId,
        }),
      ).toEqual(answered.result)
    },
  )

  it('proposes the host operation and leaves task, Runs, auths and receipts unchanged', async () => {
    const f = await evaluatedRoles()
    const beforeSnap = roleSnapshot(f, f.sessionId)
    const card = f.repo.proposeRelayWorkflowAction(f.proposal)
    expect(card.request).toMatchObject({
      category: 'arrangement_change',
      operation: { kind: 'reassign_roles', taskId: f.task.id, afterRunId: f.task.runId },
    })
    expect(card.sources.length).toBeGreaterThan(0)
    expect(card.sources.every((source) => f.proposal.sourceIds.includes(source.id))).toBe(true)
    const afterSnap = roleSnapshot(f, f.sessionId)
    expect(afterSnap.task).toEqual(beforeSnap.task)
    expect(afterSnap.runs).toEqual(beforeSnap.runs)
    expect(afterSnap.authorizations).toEqual(beforeSnap.authorizations)
    expect(afterSnap.receipts).toEqual(beforeSnap.receipts)
    expect(afterSnap.messages).toEqual(beforeSnap.messages)
  })

  it('offers no candidate for a legacy task; implicit split policy uses owner defaults', async () => {
    const f = await readyRoles({ legacy: true })
    expect(
      f.repo
        .relayWorkflowAlternatives(f.handoff)
        ?.alternatives.find((entry) => entry.kind === 'reassign_roles'),
    ).toBeUndefined()
    const implicit = await readyRoles({ implicitRoles: true })
    expect(implicit.task.stageRoles).toBeUndefined()
    const alternative = implicit.repo
      .relayWorkflowAlternatives(implicit.handoff)!
      .alternatives.find((entry) => entry.kind === 'reassign_roles')
    expect(alternative?.kind).toBe('reassign_roles')
    expect(alternative?.operation.previousRoles).toEqual(defaultTaskStageRoles(implicit.task.owner))
  })

  it('cancellation preserves the entire ready task, receipts and producing fact', async () => {
    const f = await proposedRoles()
    const beforeSnap = roleSnapshot(f, f.sessionId)
    const result = f.repo.answerRelaySchedulingDecision({
      ...f.answer,
      answer: { kind: 'cancel' },
    })
    expect(result.result).toMatchObject({
      disposition: 'cancelled',
      runId: null,
      rebuildId: null,
    })
    expect(result.result.roleChange).toBeUndefined()
    const afterSnap = roleSnapshot(f, f.sessionId)
    expect(afterSnap.task).toEqual(beforeSnap.task)
    expect(afterSnap.runs).toEqual(beforeSnap.runs)
    expect(afterSnap.authorizations).toEqual(beforeSnap.authorizations)
    expect(afterSnap.receipts).toEqual(beforeSnap.receipts)
    expect(afterSnap.settings).toEqual(beforeSnap.settings)
    expect(afterSnap.settingsRevision).toBe(beforeSnap.settingsRevision)
    expect(afterSnap.budget).toEqual(beforeSnap.budget)
    expect(afterSnap.messages).toEqual(beforeSnap.messages)
    const replay = f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } })
    expect(replay.created).toBe(false)
    expect(replay.result).toEqual(result.result)
  })

  it('duplicate confirm returns the same receipt; different nonce or cancel refuses', async () => {
    const f = await proposedRoles()
    const first = f.repo.answerRelaySchedulingDecision(f.answer)
    const replay = f.repo.answerRelaySchedulingDecision(f.answer)
    expect(replay.created).toBe(false)
    expect(replay.result).toEqual(first.result)
    expect(roleEventCount(f)).toBe(1)
    const task = f.repo.collaboration(f.sessionId)!
    expect(() =>
      f.repo.answerRelaySchedulingDecision({ ...f.answer, clientOperationId: randomUUID() }),
    ).toThrow(RunOperationConflictError)
    expect(() =>
      f.repo.answerRelaySchedulingDecision({ ...f.answer, answer: { kind: 'cancel' } }),
    ).toThrow(RunOperationConflictError)
    expect(f.repo.collaboration(f.sessionId)).toEqual(task)
  })

  it.each(['delete', 'corrupt'] as const)(
    'detects a physically %sed source part on confirm',
    async (mode) => {
      const f = await proposedRoles()
      expect(f.material.sources.length).toBeGreaterThan(1)
      const roleSource = f.material.sources.at(-1)!
      const part = f.db.drizzle
        .select()
        .from(conversationBodyParts)
        .where(eq(conversationBodyParts.inputId, roleSource.document.id))
        .limit(1)
        .get()
      expect(part).toBeDefined()
      const before = f.repo.collaboration(f.sessionId)!
      if (mode === 'delete') {
        f.db.drizzle
          .delete(conversationBodyParts)
          .where(eq(conversationBodyParts.inputId, roleSource.document.id))
          .run()
      } else {
        // One UTF-8 character changed while retaining byte/char length.
        const text = part!.text
        const flipped = text.charCodeAt(0) ^ 0x01
        f.db.drizzle
          .update(conversationBodyParts)
          .set({ text: String.fromCharCode(flipped) + text.slice(1) })
          .where(eq(conversationBodyParts.inputId, roleSource.document.id))
          .run()
      }
      expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(
        RunOperationConflictError,
      )
      expect(f.repo.collaboration(f.sessionId)).toEqual(before)
      expect(roleEventCount(f)).toBe(0)
    },
  )

  it('does not offer reassignment after a failed implementation', async () => {
    const f = await readyRoles()
    const implement = beginRoleStep(f, 'execute')
    // Settle the implementation as failed without a new proposal opportunity.
    f.repo.applyEvent(f.sessionId, implement.run.id, {
      type: 'session.started',
      agentId: implement.run.agentId,
      nativeSessionId: `fixture-${implement.run.agentId}`,
    })
    f.repo.applyEvent(f.sessionId, implement.run.id, {
      type: 'turn.started',
      agentId: implement.run.agentId,
      turnId: `turn-${implement.run.id}`,
    })
    f.repo.applyEvent(f.sessionId, implement.run.id, {
      type: 'text.completed',
      agentId: implement.run.agentId,
      turnId: `turn-${implement.run.id}`,
      outputId: `answer-${implement.run.id}`,
      text: 'Partial implementation.',
    })
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'failed',
      identity: {
        sessionId: f.sessionId,
        agentId: implement.run.agentId,
        requestId: implement.run.id,
        runId: implement.run.id,
        nativeSessionId: `fixture-${implement.run.agentId}`,
        nativeTurnId: `turn-${implement.run.id}`,
        bindingGeneration: 1,
      },
    })
    f.repo.recordNativeEffects(implement.run.id, 'settled')
    f.repo.applyEvent(f.sessionId, implement.run.id, {
      type: 'turn.completed',
      agentId: implement.run.agentId,
      turnId: `turn-${implement.run.id}`,
      outcome: 'failed',
    })
    const task = f.repo.collaboration(f.sessionId)!
    expect(
      f.repo
        .relayWorkflowAlternatives(
          f.repo.workflowHandoff(task, collaborationActor(task, 'implement')),
        )
        ?.alternatives.find((entry) => entry.kind === 'reassign_roles'),
    ).toBeUndefined()
  })

  it('does not forget admitted code history when a task is restored to its former ready state', async () => {
    const f = await readyRoles()
    const implement = beginRoleStep(f, 'execute')
    f.finish(implement.run.id, { answer: 'Implemented the accepted scope.' })
    const review = beginRoleStep(f, 'continue')
    f.finish(review.run.id, { verdict: 'accepted' })
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(
          and(
            eq(collaborationActionReceipts.taskId, f.task.id),
            eq(collaborationActionReceipts.active, true),
          ),
        )
        .all(),
    ).toEqual([])
    expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(false)
    // Deliberately corrupt only the mutable task projection, leaving real completed Turns intact.
    f.db.drizzle
      .update(collaborationTasks)
      .set({ active: true, stateJson: JSON.stringify(f.task) })
      .where(eq(collaborationTasks.id, f.task.id))
      .run()
    const current = f.repo.collaboration(f.sessionId)!
    expect(current).toEqual(f.task)
    expect(
      f.repo.relayWorkflowAlternatives(
        f.repo.workflowHandoff(current, collaborationActor(current, 'implement')),
      ),
    ).toBeUndefined()
  })

  it.each(['confirm', 'cancel', 'declined', 'failed'] as const)(
    'does not consult the producing fact again after %s and a configuration change',
    async (outcome) => {
      const f = await evaluatedRoles(
        {},
        outcome === 'declined' || outcome === 'failed' ? outcome : 'selected',
      )
      if (outcome === 'confirm' || outcome === 'cancel') {
        const card = f.repo.proposeRelayWorkflowAction(f.proposal)
        f.repo.answerRelaySchedulingDecision({
          reference: {
            sessionId: f.sessionId,
            decisionId: card.decisionId,
            revision: card.revision,
          },
          clientOperationId: randomUUID(),
          answer: { kind: outcome },
        })
      }
      f.repo.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        enabled: false,
      })
      f.repo.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        enabled: true,
      })
      const task = f.repo.collaboration(f.sessionId)!
      const handoff = f.repo.workflowHandoff(task, collaborationActor(task, 'implement'))
      if (outcome === 'confirm' || outcome === 'cancel') {
        expect(f.repo.relayWorkflowAlternatives(handoff)).toBeUndefined()
        expect(() => f.repo.proposeRelayWorkflowAction(f.proposal)).toThrow(
          RunOperationConflictError,
        )
      } else {
        const deadlineAt = Date.now() + 15_000
        const material = await f.repo.readRelayWorkflowDecisionSources(
          handoff,
          [{ id: 'propose_reassign_roles', description: 'Request a future code-role change.' }],
          { signal: new AbortController().signal, deadlineAt },
        )
        expect(
          f.repo.reserveEvaluation({
            handoff,
            configurationFingerprint: f.repo.schedulingConfigurationFingerprint(),
            inputSha256: material.inputSha256,
            deadlineAt,
            httpOwner: decisionHttpOwnerFixture(),
          }),
        ).toMatchObject({
          status: 'duplicate',
          evaluation: { id: f.proposal.evaluationId },
        })
      }
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
      expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    },
  )

  it('does not create a card from expired advice or while an execute grant is available', async () => {
    const f = await evaluatedRoles()
    expect(() =>
      f.repo.proposeRelayWorkflowAction({ ...f.proposal, deadlineAt: Date.now() - 1 }),
    ).toThrow(RunOperationConflictError)
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.repo.collaboration(f.sessionId)).toEqual(f.task)
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: f.task.id,
        revision: f.task.revision,
        clientMessageId: randomUUID(),
        action: 'execute',
      },
      f.db.sessionRepository.find(f.sessionId)!.settings,
    )
    const receipt = f.db.drizzle
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, prepared.receipt.id))
      .get()
    expect(receipt).toMatchObject({ active: true, state: 'available', boundRunId: null })
    expect(f.repo.relayWorkflowAlternatives(f.handoff)).toBeUndefined()
    expect(() => f.repo.proposeRelayWorkflowAction(f.proposal)).toThrow(RunOperationConflictError)
    expect(f.repo.collaboration(f.sessionId)).toEqual(f.task)
  })

  it.each(
    (['codex', 'claude'] as const).flatMap((actor) =>
      (['missing', 'generation', 'pending', 'unknown'] as const).map((change) => ({
        actor,
        change,
      })),
    ),
  )('refuses the role answer after $actor becomes $change', async ({ actor, change }) => {
    const f = await proposedRoles()
    if (change === 'missing') f.repo.markNativeContextsMissing(f.sessionId, [actor])
    else if (change === 'generation') {
      // Isolated stale-binding fixture: history remains unchanged, the live binding is replaced.
      f.db.drizzle
        .update(nativeAgentContexts)
        .set({ bindingGeneration: sql`${nativeAgentContexts.bindingGeneration} + 1` })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, f.sessionId),
            eq(nativeAgentContexts.agentId, actor),
          ),
        )
        .run()
    } else {
      const run = f.repo.read(f.sessionId).runs.findLast((entry) => entry.agentId === actor)!
      f.repo.recordNativeEffects(run.id, change)
    }
    const before = f.repo.collaboration(f.sessionId)
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(RunOperationConflictError)
    expect(f.repo.collaboration(f.sessionId)).toEqual(before)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    expect(roleEventCount(f)).toBe(0)
  })

  it('Fork retains both historical role versions without inheriting live authority', async () => {
    const f = await proposedRoles()
    f.repo.answerRelaySchedulingDecision(f.answer)
    const implement = beginRoleStep(f, 'execute')
    f.finish(implement.run.id, { answer: 'Implemented the accepted scope.' })
    const review = beginRoleStep(f, 'continue')
    f.finish(review.run.id, { verdict: 'accepted' })
    const original = f.db.drizzle.select().from(agentRuns).all()
    const authorizations = new Map(
      original.map((run) => [run.id, f.repo.collaborationTurnAuthorization(run.id)!]),
    )
    expect(new Set([...authorizations.values()].map((auth) => auth.stageRoles?.revision))).toEqual(
      new Set([0, 1]),
    )
    const session = f.db.sessionRepository.find(f.sessionId)!
    const selection = f.repo.selectForkSource(
      f.sessionId,
      f.repo.findRun(review.run.id)!.responseMessageId!,
      session.settings,
      session.settingsRevision,
    )
    const boundary = (agentId: 'codex' | 'claude'): AgentNativeForkBoundary => {
      const run = selection.runs[agentId]
      const response = f.repo.forkResponse(run.id, selection.prepared.sequence)
      return {
        nativeSessionId: run.nativeSessionId!,
        nativeCutId: run.id,
        nativeTurnId: run.nativeTurnId!,
        bindingGeneration: run.bindingGeneration,
        throughSequence: response.sequence,
        deliveryCursor: response.deliveryCursor,
        prefixHash: 'b'.repeat(64),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const child = f.repo.commitFork(
      randomUUID(),
      selection,
      { codex: boundary('codex'), claude: boundary('claude') },
      [],
    )
    const inherited = f.db.drizzle
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, child.sessionId))
      .all()
    expect(inherited).toHaveLength(original.length)
    for (const run of inherited) {
      const originalAuth = authorizations.get(run.forkSourceRunId!)!
      expect(originalAuth).toBeDefined()
      const copied = f.repo.collaborationTurnAuthorization(run.id)!
      expect(copied.stageRoles).toEqual(originalAuth.stageRoles)
      expect(copied.userAuthority).toBeUndefined()
    }
    expect(f.repo.collaboration(child.sessionId)).toBeUndefined()
    expect(f.repo.relaySchedulingDecision(child.sessionId)).toBeNull()
    expect(
      f.db.drizzle
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.sessionId, child.sessionId))
        .all(),
    ).toEqual([])
  })

  it.each([
    'wrong_decision_id',
    'wrong_session_id',
    'non_null_run_id',
    'non_null_rebuild_id',
    'cancelled_with_role_change',
    'wrong_task_revision',
    'wrong_stage_roles',
    'wrong_card_decision_id',
    'wrong_operation_fingerprint',
  ] as const)('the saved receipt refuses persisted %s corruption', async (corruption) => {
    const f = await proposedRoles()
    f.repo.answerRelaySchedulingDecision(f.answer)
    const row = f.db.drizzle
      .select()
      .from(relayDecisions)
      .where(eq(relayDecisions.id, f.card.decisionId))
      .get()!
    const result = relayDecisionReceiptSchema.parse(JSON.parse(row.resultJson!))
    const proof = relaySchedulingDecisionProofSchema.parse(JSON.parse(row.proofJson))
    const mutate = (field: string, value: unknown) => {
      const next = { ...result, [field]: value }
      f.db.drizzle
        .update(relayDecisions)
        .set({ resultJson: JSON.stringify(next) })
        .where(eq(relayDecisions.id, f.card.decisionId))
        .run()
    }
    const mutateProof = (field: string, value: unknown) => {
      const next = { ...proof, [field]: value }
      f.db.drizzle
        .update(relayDecisions)
        .set({ proofJson: JSON.stringify(next) })
        .where(eq(relayDecisions.id, f.card.decisionId))
        .run()
    }
    const roleChange = result.roleChange!
    if (corruption === 'wrong_session_id') mutate('sessionId', randomUUID())
    if (corruption === 'wrong_decision_id') mutate('decisionId', randomUUID())
    if (corruption === 'non_null_run_id') mutate('runId', randomUUID())
    if (corruption === 'non_null_rebuild_id') mutate('rebuildId', randomUUID())
    if (corruption === 'cancelled_with_role_change') mutate('disposition', 'cancelled')
    if (corruption === 'wrong_task_revision')
      mutate('roleChange', { ...roleChange, taskRevision: roleChange.taskRevision + 1 })
    if (corruption === 'wrong_stage_roles')
      mutate('roleChange', {
        ...roleChange,
        stageRoles: defaultTaskStageRoles('codex'),
      })
    if (corruption === 'wrong_card_decision_id')
      mutateProof('card', { ...proof.card, decisionId: randomUUID() })
    if (corruption === 'wrong_operation_fingerprint')
      mutateProof('operationFingerprint', '0'.repeat(64))
    expect(() =>
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
      }),
    ).toThrow(RunOperationConflictError)
    expect(f.repo.collaboration(f.sessionId)!.stageRoles).toEqual(
      expectedRoleSwap(f.task.stageRoles!),
    )
  })

  it('confirmed role activity is reassign_roles/completed; later work cannot overwrite it', async () => {
    const f = await proposedRoles()
    f.repo.answerRelaySchedulingDecision(f.answer)
    const roleRow = f.db.drizzle
      .select()
      .from(schedulingActivity)
      .all()
      .find((row) => row.action === 'reassign_roles')
    expect(roleRow).toMatchObject({
      suggestionState: 'adopted',
      action: 'reassign_roles',
      actionResult: 'completed',
    })
    // An unrelated non-role row in the same fixture proves the SQL OR precedence.
    const clone = {
      ...roleRow!,
      id: randomUUID(),
      action: 'repair' as const,
      actionResult: 'reserved' as const,
      handoffId: null,
      evaluationId: null,
      decisionId: null,
      faultId: null,
      rebuildId: null,
      activityAt: new Date().toISOString(),
    }
    f.db.drizzle.insert(schedulingActivity).values(clone).run()
    // Settle real implementation and review through the existing interfaces.
    const implement = beginRoleStep(f, 'execute')
    f.finish(implement.run.id, { answer: 'Implemented.' })
    const review = beginRoleStep(f, 'continue')
    f.finish(review.run.id, { verdict: 'accepted' })
    const after = f.db.drizzle.select().from(schedulingActivity).all()
    const afterRole = after.find((row) => row.action === 'reassign_roles')
    const afterClone = after.find((row) => row.id === clone.id)
    expect(afterRole).toEqual(roleRow)
    expect(afterClone).toEqual(clone)
  })

  it('indexed existence queries use the dedicated partial indexes', async () => {
    const f = await readyRoles()
    const turnPlan = f.db.drizzle.get<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT run_id FROM workflow_turns WHERE task_id=${f.task.id} AND stage='implement' LIMIT 1`,
    )
    const matterPlan = f.db.drizzle.get<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT id FROM relay_decisions WHERE session_id=${f.sessionId} AND matter_key=${`reassign_roles:${f.task.id}:${f.task.runId}`} AND format_version=2 LIMIT 1`,
    )
    expect(turnPlan?.detail).toContain('workflow_turns_task_stage_revision_idx')
    expect(turnPlan?.detail).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/u)
    expect(matterPlan?.detail).toContain('relay_decisions_matter_history')
    expect(matterPlan?.detail).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/u)
  })

  it('cold reopen keeps the pending card dropped and the original map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pact-role-'))
    directories.push(dir)
    const filePath = join(dir, 'preview.sqlite')
    const f = await proposedRoles({ filePath })
    const before = f.repo.collaboration(f.sessionId)!
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.add(reopened)
    const repo = reopened.conversationRepository
    repo.recoverCollaborationTasks()
    const task = repo.collaboration(f.sessionId)!
    expect(task.stageRoles).toEqual(before.stageRoles)
    expect(task).toMatchObject({ automation: 'paused', pauseReason: 'restart' })
    expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(reopened.drizzle.select().from(collaborationActionReceipts).all()).toHaveLength(0)
  })

  it('cold reopen keeps the confirmed map, receipt and frozen auths; restart pause preserved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pact-role-'))
    directories.push(dir)
    const filePath = join(dir, 'preview.sqlite')
    const f = await proposedRoles({ filePath })
    const answered = f.repo.answerRelaySchedulingDecision(f.answer)
    const before = f.repo.collaboration(f.sessionId)!
    const beforeSnap = roleSnapshot(f, f.sessionId)
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.add(reopened)
    const repo = reopened.conversationRepository
    repo.recoverCollaborationTasks()
    const task = repo.collaboration(f.sessionId)!
    expect(task.stageRoles).toEqual(before.stageRoles)
    expect(task).toMatchObject({ automation: 'paused', pauseReason: 'restart' })
    expect(task.revision).toBeGreaterThanOrEqual(before.revision)
    expect(
      repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.answer.clientOperationId,
      }),
    ).toEqual(answered.result)
    // Frozen older authorizations survive the reopen.
    for (const runId of Object.keys(beforeSnap.authorizations))
      expect(repo.collaborationTurnAuthorization(runId)).toEqual(beforeSnap.authorizations[runId])
    // Replay of the exact answer after recover is idempotent.
    expect(repo.answerRelaySchedulingDecision(f.answer)).toMatchObject({
      created: false,
      result: answered.result,
    })
    expect(repo.collaboration(f.sessionId)).toEqual(task)
  })

  it.each([
    'settings_generation',
    'pending_input',
    'paused_task',
    'task_revision',
    'role_revision',
  ] as const)('a stale %s change refuses confirmation without map mutation', async (kind) => {
    const f = await proposedRoles()
    const before = f.repo.collaboration(f.sessionId)!
    const task = f.repo.collaboration(f.sessionId)!
    if (kind === 'settings_generation') {
      const settings = f.repo.schedulingSettings()
      f.repo.saveSchedulingSettings({
        expectedRevision: settings.revision,
        enabled: !settings.enabled,
      })
      f.repo.saveSchedulingSettings({
        expectedRevision: f.repo.schedulingSettings().revision,
        enabled: true,
      })
    }
    if (kind === 'pending_input') {
      const inputOwner = randomUUID(),
        clientMessageId = randomUUID()
      const body = f.repo.writeConversationInput(
        { type: 'begin', sessionId: f.sessionId, clientMessageId },
        inputOwner,
      )
      f.repo.writeConversationInput(
        {
          type: 'append',
          sessionId: f.sessionId,
          inputId: body.inputId,
          offset: 0,
          text: 'New scope.',
        },
        inputOwner,
      )
      f.repo.writeConversationInput(
        { type: 'seal', sessionId: f.sessionId, inputId: body.inputId },
        inputOwner,
      )
      const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      f.repo.receiveCollaborationInput(
        {
          sessionId: f.sessionId,
          clientMessageId,
          inputId: body.inputId,
          content: 'New scope.',
          commentIds: [],
          expectedCommentsRevision: drafts.scope === 'drafts' ? drafts.commentsRevision : 0,
          route: { type: 'primary' },
        },
        body.inputId,
        'codex',
        'immediate_safe_point',
        inputOwner,
      )
    }
    const corruptTask = (mutate: (state: CollaborationTask) => void) => {
      const state = collaborationTaskSchema.parse(
        JSON.parse(
          f.db.drizzle
            .select({ stateJson: collaborationTasks.stateJson })
            .from(collaborationTasks)
            .where(eq(collaborationTasks.id, task.id))
            .get()!.stateJson,
        ),
      )
      mutate(state)
      f.db.drizzle
        .update(collaborationTasks)
        .set({ stateJson: JSON.stringify(state) })
        .where(eq(collaborationTasks.id, task.id))
        .run()
    }
    if (kind === 'paused_task')
      corruptTask((state) => {
        state.automation = 'paused'
        state.pauseReason = 'user'
        state.revision = task.revision + 1
      })
    if (kind === 'task_revision')
      corruptTask((state) => {
        state.revision = task.revision + 1
      })
    if (kind === 'role_revision')
      corruptTask((state) => {
        state.stageRoles!.revision += 1
      })
    const invalidated = f.repo.collaboration(f.sessionId)
    expect(() => f.repo.answerRelaySchedulingDecision(f.answer)).toThrow(RunOperationConflictError)
    const after = f.repo.collaboration(f.sessionId)!
    expect(after.stageRoles?.codeAuthor).toBe(before.stageRoles?.codeAuthor)
    expect(after.stageRoles?.codeReviewer).toBe(before.stageRoles?.codeReviewer)
    expect(after).toEqual(invalidated)
    expect(roleEventCount(f)).toBe(0)
  })
})
