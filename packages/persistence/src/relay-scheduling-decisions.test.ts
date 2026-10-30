/* oxlint-disable vitest/no-conditional-expect -- Cold recovery assertions distinguish unused gates from bound business obligations. */
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  collaborationDocumentSchema,
  type AgentNativeForkBoundary,
  type RelayDecisionAnswer,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentRuns,
  collaborationActionReceipts,
  relayDecisions,
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
  expect(f.repo.relaySupplementOpportunity(handoff)?.kind).toBe('supplement_plan')
  return { ...f, response, unrelated, handoff, defaultAdmission: admission }
}

async function evaluated(filePath?: string) {
  const f = await workflow(filePath),
    deadlineAt = Date.now() + 15_000
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
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    deadlineAt,
    inputSha256: material.inputSha256,
  })
  if (reserved.status !== 'reserved') throw Error('Missing real evaluation reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'propose_supplement_plan',
  })
  const proposal = {
    handoff: f.handoff,
    kind: 'supplement_plan' as const,
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason:
      'Clarify the cancellation boundary against the complete original review before returning to the fixed reviewer.',
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
  it('declines a non-English script in generated system prose while retaining complete original sources', async () => {
    const f = await evaluated()
    const before = f.material.sources.map((source) => f.readDocument(source.document))
    expect(() =>
      f.repo.proposeRelayWorkflowAction({
        ...f.proposal,
        reason: '需要先澄清取消边界。',
      }),
    ).toThrow('requested English system language')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.material.sources.map((source) => f.readDocument(source.document))).toEqual(before)
    expect(f.repo.proposeRelayWorkflowAction(f.proposal).reason).toBe(f.proposal.reason)
  })
  it('proposes before any advance user grant and blocks ordinary or default admission until answered', async () => {
    const f = await proposed()
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(f.card)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toEqual([])
    expect(f.repo.relayWorkflowUserGrants(f.handoff, f.material.snapshot)).toEqual({})
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
    expect(work.responsibility).toBe(f.proposal.reason)
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
