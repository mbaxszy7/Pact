import { sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationReviewObservation,
  CollaborationInputObservation,
  DecisionInput,
  CollaborationDocument,
} from '@pact/contracts'

import { collaborationDocumentSchema } from '@pact/contracts'

import type { WorkflowSourceRead } from './relay-workflow-fixture.test-support.js'

import { collaborationPlanMode, collaborationReadOnly } from './collaboration-prompt.js'
import { Conversation } from './conversation.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
import { decisionWorkingMemoryDiagnostics } from './native-working-memory.js'
import {
  enableWorkflowRelay,
  workflowConversation,
  workflowDecisionRuntime as controlledDecisionRuntime,
} from './relay-workflow-fixture.test-support.js'

const native = vi.hoisted(() => ({
  inputs: [] as AgentRunInput[],
  reviews: [] as CollaborationReviewObservation[],
  decisions: [] as DecisionInput[],
  candidate: undefined as string | null | undefined,
  interruptNextWrite: false,
  holdNextWrite: false,
  replyOutcome: undefined as CollaborationInputObservation | undefined,
  holdStage: undefined as { stage: 'plan' | 'plan_review'; until: Promise<void> } | undefined,
  planText: undefined as string | undefined,
  loseObservation: false,
  rebuilds: [] as string[],
  sourceReads: [] as WorkflowSourceRead[],
  unselectedPlan: undefined as string | undefined,
  forbiddenDocuments: [] as CollaborationDocument[],
  workerPath: '',
}))
vi.mock('./codex-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return { CodexAgentAdapter: workflowAdapter('codex', native) }
})
vi.mock('./claude-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return { ClaudeAgentAdapter: workflowAdapter('claude', native) }
})
vi.mock('./openai-decision-runtime.js', async () => {
  const { workflowDecisionRuntime } = await import('./relay-workflow-fixture.test-support.js')
  return { OpenAIDecisionRuntime: workflowDecisionRuntime(native) }
})
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        super(
          String(filename).endsWith('markdown-projection-worker.js') ? native.workerPath : filename,
          options,
        )
      }
    },
  }
})
let workers: Awaited<ReturnType<typeof nativeWorkerFixture>>
const owned: Array<Awaited<ReturnType<typeof workflowConversation>>> = []
beforeAll(async () => {
  workers = await nativeWorkerFixture(['markdown-projection-worker'])
  native.workerPath = workers.paths['markdown-projection-worker']!
}, 20_000)
afterAll(async () => {
  await workers?.dispose()
})
afterEach(async () => {
  await Promise.all(owned.splice(0).map((f) => f.dispose()))
  native.inputs = []
  native.reviews = []
  native.decisions = []
  native.candidate = undefined
  native.interruptNextWrite = false
  native.holdNextWrite = false
  native.replyOutcome = undefined
  native.holdStage = undefined
  native.planText = undefined
  native.loseObservation = false
  native.rebuilds = []
  native.sourceReads = []
  native.unselectedPlan = undefined
  native.forbiddenDocuments = []
  vi.restoreAllMocks()
})
async function fixture(primary: 'codex' | 'claude' = 'codex') {
  const f = await workflowConversation(Conversation, primary)
  owned.push(f)
  return f
}

type Fixture = Awaited<ReturnType<typeof fixture>>
function sources(f: Fixture, runId: string) {
  return f.db.conversationRepository.readRunSources(runId)
}
async function cancel(f: Fixture) {
  const repo = f.db.conversationRepository,
    card = repo.relaySchedulingDecision(f.sessionId)!,
    task = repo.collaboration(f.sessionId)!,
    prior = repo.findRun(task.runId)!,
    beforeSources = sources(f, task.runId)
  const drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing drafts')
  const answer = `${task.stage} complete within the original scope.`
  repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId: randomUUID(),
    expectedCommentsRevision: drafts.commentsRevision,
    body: 'Keep this complete unsent Comment. 最后一行。',
    anchor: {
      type: 'message',
      messageId: prior.responseMessageId!,
      contentHash: createHash('sha256').update(answer).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 4,
      quote: answer.slice(0, 4),
    },
  })
  const saved = repo.readPage({ scope: 'drafts', sessionId: f.sessionId }),
    request = {
      reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
      clientOperationId: randomUUID(),
      answer: { kind: 'cancel' as const },
    },
    decisionCount = native.decisions.length
  const result = await f.flow.answerRelayDecision(request)
  expect(result).toMatchObject({
    ok: true,
    value: { disposition: 'cancelled', runId: null, rebuildId: null },
  })
  expect(await f.flow.answerRelayDecision(request)).toEqual(result)
  expect(
    f.flow.getRelayDecisionReceipt({
      sessionId: f.sessionId,
      decisionId: card.decisionId,
      clientOperationId: request.clientOperationId,
    }),
  ).toEqual(result)
  expect(repo.collaboration(f.sessionId)).toMatchObject({
    id: task.id,
    runId: task.runId,
    automation: 'paused',
    pauseReason: 'user',
  })
  expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
  expect(() => repo.assertRelayDecisionResolved(f.sessionId)).not.toThrow()
  const current = repo.findRun(task.runId)!
  expect(current).toEqual({ ...prior, updatedAt: current.updatedAt })
  expect(sources(f, task.runId)).toEqual(beforeSources)
  const after = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (after.scope !== 'drafts') throw Error('Missing retained draft page')
  expect(after).toEqual({ ...saved, observation: after.observation })
  expect(repo.schedulingBudget(`task:${task.id}`)).toMatchObject({
    extraPlanTurns: 0,
    extraCodeTurns: 0,
  })
  return { task, request, result, decisionCount }
}

async function reachPlanReviewLimit(primary: 'codex' | 'claude' = 'claude') {
  const f = await fixture(primary),
    repo = f.db.conversationRepository,
    session = f.db.sessionRepository.find(f.sessionId)!
  f.db.sessionRepository.saveSettings(f.sessionId, {
    ...session.settings,
    maxDiscussionRounds: 1,
  })
  expect(await f.flow.send(f.input('/plan Preserve cancellation ownership.'))).toMatchObject({
    ok: true,
  })
  await vi.waitFor(() => expect(repo.collaboration(f.sessionId)?.status).toBe('ready'))
  enableWorkflowRelay(f.db)
  native.candidate = 'propose_extend_plan_review'
  expect(await f.flow.send(f.input('Clarify the acceptance wording.'))).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(repo.relaySchedulingDecision(f.sessionId)?.request).toMatchObject({
      category: 'new_authorization',
      operation: { kind: 'extend_plan_review' },
    }),
  )
  const task = await f.settled(),
    card = repo.relaySchedulingDecision(f.sessionId)!,
    request = {
      reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
      clientOperationId: randomUUID(),
      answer: { kind: 'confirm' as const },
    }
  expect(task).toMatchObject({ status: 'waiting', pauseReason: 'limit', discussionRounds: 1 })
  expect(card.request).toMatchObject({
    operation: {
      taskId: task.id,
      afterRunId: task.runId,
      actor: task.reviewer,
      inputSequence: task.inputSequence,
      planReference: task.planReference,
      expectedDiscussionRounds: 1,
      maximum: 1,
    },
  })
  expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
    'plan',
    'plan_review',
    'reply',
  ])
  return { ...f, repo, task, card, request }
}

describe('Relay confirmation at the Plan review limit', () => {
  it.each([
    { primary: 'claude' as const, verdict: 'accepted' as const },
    { primary: 'codex' as const, verdict: 'changes_requested' as const },
  ])(
    'binds one fixed review for $primary when the verdict is $verdict',
    async ({ primary, verdict }) => {
      const f = await reachPlanReviewLimit(primary)
      native.reviews.push({ verdict })
      const result = await f.flow.answerRelayDecision(f.request)
      if (!result.ok) throw Error(result.error.message)
      expect(result.value.disposition).toBe('confirmed')
      await vi.waitFor(() => expect(native.inputs).toHaveLength(verdict === 'accepted' ? 4 : 5))
      const current = await f.settled(),
        review = native.inputs[3]!,
        authorization = review.promptEnvelope.collaborationAuthorization!
      expect(result).toMatchObject({ value: { runId: review.runId } })
      expect(authorization).toMatchObject({
        runId: review.runId,
        stage: 'plan_review',
        actor: f.task.reviewer,
        planReference: f.task.planReference,
        inputSequence: f.task.inputSequence,
        userAuthority: { purpose: 'action' },
      })
      expect(authorization.userAuthority?.returnStage).toBeUndefined()
      expect(
        f.db.drizzle.get(sql`
        SELECT a.bound_run_id AS runId, a.review_state AS reviewState, b.budget AS budget,
          b.authorization_id AS authorizationId, d.state AS decisionState, h.run_id AS handoffRunId
        FROM collaboration_action_receipts a
        JOIN relay_decisions d ON d.id = a.decision_id AND d.handoff_id = a.handoff_id
        JOIN scheduling_handoffs h ON h.id = a.handoff_id
        JOIN scheduling_budget_reservations b ON b.id = a.budget_reservation_id
        WHERE a.id = ${authorization.userAuthority!.receiptId} AND d.id = ${f.card.decisionId}
      `),
      ).toEqual({
        runId: review.runId,
        reviewState: null,
        budget: 'extra_plan_turn',
        authorizationId: authorization.userAuthority!.receiptId,
        decisionState: 'bound',
        handoffRunId: review.runId,
      })
      expect(current).toMatchObject({
        discussionRounds: 2,
        status: verdict === 'accepted' ? 'ready' : 'waiting',
      })
      expect(f.db.sessionRepository.find(f.sessionId)?.settings.maxDiscussionRounds).toBe(1)
      expect(f.repo.schedulingBudget(`task:${f.task.id}`)?.extraPlanTurns).toBe(1)
      const expectedTask =
        verdict === 'accepted'
          ? { status: 'ready', discussionRounds: 2 }
          : { stage: 'plan', automation: 'paused', pauseReason: 'limit', discussionRounds: 2 }
      const waitForConclusion = () =>
        vi.waitFor(() => expect(f.repo.collaboration(f.sessionId)).toMatchObject(expectedTask))
      await waitForConclusion()
      if (verdict === 'changes_requested') await f.act('resume')
      await waitForConclusion()
      expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(await f.flow.answerRelayDecision(f.request)).toEqual(result)
      expect(
        await f.flow.answerRelayDecision({ ...f.request, clientOperationId: randomUUID() }),
      ).toMatchObject({ ok: false })
      expect(
        native.inputs.slice(3).map(({ promptEnvelope }) => ({
          stage: promptEnvelope.collaboration?.stage,
          actor: promptEnvelope.collaboration?.actor,
        })),
      ).toEqual([
        { stage: 'plan_review', actor: f.task.reviewer },
        ...(verdict === 'changes_requested' ? [{ stage: 'plan', actor: primary }] : []),
      ])
    },
  )

  it('keeps the original Plan and count when the user declines the card', async () => {
    const f = await reachPlanReviewLimit()
    const request = { ...f.request, answer: { kind: 'cancel' as const } },
      declined = await f.flow.answerRelayDecision(request)
    expect(declined).toMatchObject({ ok: true, value: { disposition: 'cancelled', runId: null } })
    expect(await f.flow.answerRelayDecision(request)).toEqual(declined)
    expect(await f.settled()).toMatchObject({
      runId: f.task.runId,
      planReference: f.task.planReference,
      discussionRounds: 1,
      automation: 'paused',
    })
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(native.inputs).toHaveLength(3)
    expect(f.repo.schedulingBudget(`task:${f.task.id}`)?.extraPlanTurns).toBe(0)
  })

  it.each(['continue', 'settings'] as const)(
    'refuses a stale card after %s supersedes the original proposal',
    async (change) => {
      const f = await reachPlanReviewLimit()
      if (change === 'continue') {
        const manual = await f.act('continue')
        if (manual.ok) throw Error('Ordinary Continue bypassed the review limit')
      } else {
        const session = f.db.sessionRepository.find(f.sessionId)!
        f.db.sessionRepository.saveSettings(f.sessionId, {
          ...session.settings,
          maxDiscussionRounds: 2,
        })
      }
      expect(await f.flow.answerRelayDecision(f.request)).toMatchObject({ ok: false })
      expect(await f.settled()).toMatchObject({ runId: f.task.runId, discussionRounds: 1 })
      expect(native.inputs).toHaveLength(3)
      expect(f.repo.schedulingBudget(`task:${f.task.id}`)?.extraPlanTurns).toBe(0)
    },
  )

  it('retires a confirmation left unused when publishing its first projection fails', async () => {
    const f = await reachPlanReviewLimit()
    vi.spyOn(f.repo, 'metadataPatch').mockImplementationOnce(() => {
      throw Error('The confirmation projection failed after the durable answer.')
    })
    expect(await f.flow.answerRelayDecision(f.request)).toMatchObject({ ok: false })
    expect(
      f.flow.getRelayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: f.request.clientOperationId,
      }),
    ).toMatchObject({ ok: true, value: { disposition: 'confirmed', runId: null } })
    expect(await f.flow.answerRelayDecision(f.request)).toMatchObject({
      ok: true,
      value: { runId: null },
    })
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(await f.settled()).toMatchObject({ automation: 'paused', discussionRounds: 1 })
    expect(native.inputs).toHaveLength(3)
    expect(f.repo.schedulingBudget(`task:${f.task.id}`)?.extraPlanTurns).toBe(0)
  })

  it('retains the charged review and does not replay after the accepted delivery loses observation', async () => {
    const f = await reachPlanReviewLimit()
    native.loseObservation = true
    const result = await f.flow.answerRelayDecision(f.request)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    expect(await f.settled()).toMatchObject({ automation: 'paused', discussionRounds: 2 })
    expect(await f.flow.answerRelayDecision(f.request)).toEqual(result)
    expect(f.repo.schedulingBudget(`task:${f.task.id}`)?.extraPlanTurns).toBe(1)
    expect(native.inputs).toHaveLength(4)
  })
})

describe('Cancel an optional Relay advancement, then continue through the original workflow owner', () => {
  it.each(['codex', 'claude'] as const)(
    'continues the %s Plan through its fixed reviewer and explicit Implement',
    async (primary) => {
      const f = await fixture(primary),
        repo = f.db.conversationRepository
      const settleEvaluation = vi.spyOn(repo, 'settleEvaluation')
      enableWorkflowRelay(f.db)
      native.reviews = [{ verdict: 'changes_requested' }, { verdict: 'changes_requested' }]
      native.candidate = 'propose_supplement_plan'
      expect(
        await f.flow.send(f.input('/plan Preserve the exact original cancellation scope.')),
      ).toMatchObject({ ok: true })
      await vi.waitFor(
        () =>
          expect(repo.relaySchedulingDecision(f.sessionId)?.request).toMatchObject({
            category: 'new_authorization',
            operation: { kind: 'supplement_plan' },
          }),
        { timeout: 5_000 },
      )
      await vi.waitFor(() =>
        expect(settleEvaluation).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            outcome: 'completed',
            physicalReleased: true,
            selectedCandidateId: 'propose_supplement_plan',
            httpOwner: expect.objectContaining({ version: 1, kind: 'http' }),
            remoteOutcome: 'responded',
          }),
        ),
      )
      const state = await cancel(f)
      expect(native.inputs).toHaveLength(3)
      await f.settled()
      expect(native.inputs).toHaveLength(3)
      native.candidate = null
      expect(await f.act('resume')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
      expect(await f.settled()).toMatchObject({ status: 'ready' })
      expect(native.inputs[5]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'plan_review',
        actor: state.task.reviewer,
      })
      // Native settlement precedes the optional accepted-plan role consultation.
      // Wait for both distinct handoffs rather than sampling a transient total.
      await vi.waitFor(() =>
        expect(
          native.decisions.slice(state.decisionCount).map((decision) => ({
            candidates: decision.candidates.map((candidate) => candidate.id),
            runId: decision.handoff?.freshnessGuard.runId,
          })),
        ).toEqual([
          { candidates: ['propose_supplement_plan'], runId: native.inputs[4]!.runId },
          { candidates: ['propose_reassign_roles'], runId: native.inputs[5]!.runId },
        ]),
      )
      expect(native.decisions).toHaveLength(state.decisionCount + 2)
      expect(repo.collaboration(f.sessionId)?.stageRoles).toEqual(state.task.stageRoles)
      expect(native.inputs).toHaveLength(6)
      expect(await f.act('execute')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(8))
      expect(await f.settled()).toMatchObject({ status: 'complete' })
      expect(
        native.inputs[6]!.promptEnvelope.collaborationAuthorization?.userAuthority,
      ).toMatchObject({ purpose: 'action' })
      expect(native.inputs[7]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
      expect(await f.flow.answerRelayDecision(state.request)).toEqual(state.result)
      expect(native.inputs).toHaveLength(8)
      expect(repo.schedulingBudget(`task:${state.task.id}`)).toMatchObject({
        extraPlanTurns: 0,
        extraCodeTurns: 0,
      })
    },
  )

  it.each([
    {
      primary: 'codex' as const,
      candidate: 'propose_supplement_code_response',
      action: 'respond' as const,
    },
    {
      primary: 'claude' as const,
      candidate: 'propose_supplement_code_response',
      action: 'respond' as const,
    },
    { primary: 'codex' as const, candidate: 'propose_repair', action: 'repair' as const },
    { primary: 'claude' as const, candidate: 'propose_repair', action: 'repair' as const },
  ])(
    'continues $candidate through explicit $action with the $primary owner',
    async ({ primary, candidate, action }) => {
      const f = await fixture(primary),
        repo = f.db.conversationRepository
      native.reviews = [{ verdict: 'changes_requested' }]
      expect(
        await f.flow.send(f.input('/build Preserve only the original cancellation scope.')),
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
      await f.settled()
      enableWorkflowRelay(f.db)
      native.candidate = candidate
      native.reviews = [{ verdict: 'changes_requested' }]
      expect(await f.act('respond')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(repo.relaySchedulingDecision(f.sessionId)).not.toBeNull())
      const state = await cancel(f)
      expect(native.inputs).toHaveLength(4)
      expect(await f.act('resume')).toMatchObject({ ok: true })
      await f.settled()
      expect(native.inputs).toHaveLength(4)
      native.candidate = undefined
      const task = repo.collaboration(f.sessionId)!,
        input = {
          sessionId: f.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: randomUUID(),
          action,
        }
      expect(await f.flow.actOnCollaboration(input)).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
      expect(await f.settled()).toMatchObject({
        status: 'complete',
        repairAttempts: action === 'repair' ? 1 : 0,
      })
      expect(await f.flow.actOnCollaboration(input)).toMatchObject({ ok: true })
      expect(native.inputs).toHaveLength(6)
      expect(native.inputs[4]!.promptEnvelope.collaboration).toMatchObject({
        stage: action,
        actor: primary === 'codex' ? 'claude' : 'codex',
        reviewScopeRef: state.task.reviewScopeRef,
      })
      expect(
        native.inputs[4]!.promptEnvelope.collaborationAuthorization?.userAuthority,
      ).toMatchObject({ purpose: 'action' })
      expect(
        native.inputs[4]!.promptEnvelope.collaborationAuthorization?.relayWorkRef,
      ).toBeUndefined()
      expect(native.inputs[5]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
      expect(
        native.decisions.filter(
          (decision) => decision.handoff.freshnessGuard.runId === state.task.runId,
        ),
      ).toHaveLength(1)
      expect(repo.schedulingBudget(`task:${state.task.id}`)).toMatchObject({
        extraPlanTurns: 0,
        extraCodeTurns: 0,
      })
      expect(await f.flow.answerRelayDecision(state.request)).toEqual(state.result)
    },
  )

  it('keeps original native uncertainty after Rebuild Cancel and allows the original explicit Rebuild entry once', async () => {
    const f = await fixture(),
      repo = f.db.conversationRepository
    native.loseObservation = true
    expect(
      await f.flow.send(f.input('Preserve the complete original recovery input.')),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
    const run = repo.findRun(native.inputs[0]!.runId)!
    repo.markNativeContextsMissing(f.sessionId, ['codex'])
    enableWorkflowRelay(f.db)
    expect(repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(true)
    const card = repo.relaySchedulingDecision(f.sessionId)!,
      before = repo.findRun(run.id)!,
      context = repo.nativeContext(f.sessionId, 'codex')!,
      issues = repo.nativeIssueMetadata(f.sessionId)
    const answer = {
      reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
      clientOperationId: randomUUID(),
      answer: { kind: 'cancel' as const },
    }
    const result = await f.flow.answerRelayDecision(answer)
    expect(result).toMatchObject({ ok: true, value: { disposition: 'cancelled' } })
    expect(await f.flow.answerRelayDecision(answer)).toEqual(result)
    expect(repo.findRun(run.id)).toEqual(before)
    expect(repo.nativeIssueMetadata(f.sessionId)).toEqual(issues)
    expect(native.rebuilds).toEqual([])
    expect(repo.proposeRelayNativeRecovery(f.sessionId, 'codex')).toBe(false)
    const rebuild = {
      sessionId: f.sessionId,
      agentId: 'codex' as const,
      intent: 'create' as const,
      clientOperationId: randomUUID(),
      expectedGeneration: context.bindingGeneration,
      abandon: true,
    }
    expect(await f.flow.rebuildNativeContext(rebuild)).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(repo.nativeRebuildOperation(rebuild.clientOperationId)?.stage).toBe('completed'),
    )
    expect(await f.flow.rebuildNativeContext(rebuild)).toMatchObject({ ok: true })
    expect(native.rebuilds).toEqual([rebuild.clientOperationId])
    expect(native.inputs).toHaveLength(1)
    expect(repo.findRun(run.id)).toMatchObject({
      nativeEffectsState: before.nativeEffectsState,
      controlDisposition: 'abandoned',
    })
    expect(repo.findRun(run.id)?.nativeOutcome).toBeUndefined()
    expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
  })
})

it.each(['codex', 'claude'] as const)(
  'continues the original plan implementation after two interrupted writes and replies with %s Primary',
  async (primary) => {
    const f = await fixture(primary),
      repo = f.db.conversationRepository,
      implementer = primary === 'codex' ? 'claude' : 'codex'
    expect(
      await f.flow.send(f.input('/plan Preserve the accepted cancellation scope.')),
    ).toMatchObject({ ok: true })
    expect(await f.settled()).toMatchObject({ status: 'ready' })
    native.holdNextWrite = true
    expect(await f.act('execute')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    const stopped = await f.settled()
    const original = repo.collaborationTurnAuthorization(stopped.pendingWork!.runId)!
    const resumeAfterReply = async (index: number) => {
      expect(
        await f.flow.send(f.input('Continue the same implementation without changing its scope.')),
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(4 + index * 2))
      const replied = await f.settled(),
        input = native.inputs.at(-1)!
      expect(replied).toMatchObject({ stage: 'reply', actor: implementer, automation: 'paused' })
      expect(
        collaborationPlanMode(
          input.promptEnvelope.collaboration,
          input.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(false)
      expect(
        collaborationReadOnly(
          input.promptEnvelope.collaboration,
          input.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(true)
      native.holdNextWrite = index === 0
      expect(await f.act('resume')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(index === 0 ? 5 : 8))
      const stop = index === 0 ? f.flow.stop({ sessionId: f.sessionId }) : undefined
      expect(stop?.ok).toBe(index === 0 ? true : undefined)
      await f.settled()
      const write = native.inputs.findLast(
        (value) => value.promptEnvelope.collaboration?.stage === 'implement',
      )!
      expect(write.promptEnvelope.collaborationAuthorization).toMatchObject({
        actor: implementer,
        stage: 'implement',
        planReference: original.planReference,
        userAuthority: {
          purpose: 'write_continuation',
          rootReceiptId: original.userAuthority!.rootReceiptId,
        },
      })
      expect(
        collaborationReadOnly(
          write.promptEnvelope.collaboration,
          write.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(false)
    }
    await resumeAfterReply(0)
    await resumeAfterReply(1)
    expect(repo.collaboration(f.sessionId)).toMatchObject({
      status: 'complete',
      stage: 'code_review',
      actor: primary,
      repairAttempts: 0,
    })
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
      'plan',
      'plan_review',
      'implement',
      'reply',
      'implement',
      'reply',
      'implement',
      'code_review',
    ])
  },
)

it.each([
  { primary: 'codex', stage: 'implement' },
  { primary: 'claude', stage: 'repair' },
] as const)(
  'keeps changed requirements paused after $stage and gives $primary the Plan before a fresh Implement',
  async ({ primary, stage }) => {
    const f = await fixture(primary)
    const repo = f.db.conversationRepository
    expect(
      await f.flow.send(f.input('/plan Handle cancellation with the original acceptance.')),
    ).toMatchObject({ ok: true })
    expect(await f.settled()).toMatchObject({ status: 'ready' })
    if (stage === 'repair') native.reviews = [{ verdict: 'changes_requested' }]
    native.holdNextWrite = stage === 'implement'
    expect(await f.act('execute')).toMatchObject({ ok: true })
    const repair = async () => {
      await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
      await f.settled()
      native.holdNextWrite = true
      return f.act('repair')
    }
    const repairResult = stage === 'repair' ? await repair() : undefined
    expect(repairResult?.ok).toBe(stage === 'repair' ? true : undefined)
    const writesBefore = stage === 'repair' ? 5 : 3
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore))
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    const stopped = await f.settled()
    const original = repo.collaborationTurnAuthorization(stopped.pendingWork!.runId)!
    expect(stopped.pendingWork?.stage).toBe(stage)
    native.replyOutcome = { outcome: 'plan_revision_required' }
    native.planText = 'Updated acceptance includes cancellation while offline.'
    const request = 'Change acceptance to include cancellation while offline.'
    expect(await f.flow.send(f.input(request))).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 1))
    expect(await f.settled()).toMatchObject({
      stage: 'reply',
      automation: 'paused',
      planRevision: { writeRunId: original.runId },
      pendingWork: stopped.pendingWork,
    })
    expect(native.inputs).toHaveLength(writesBefore + 1)
    expect(await f.act('resume')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 3))
    const ready = await f.settled()
    expect(ready).toMatchObject({
      stage: 'plan_review',
      status: 'ready',
      repairAttempts: stopped.repairAttempts,
      pendingWork: stopped.pendingWork,
    })
    expect(
      native.inputs
        .slice(writesBefore + 1)
        .map((input) => input.promptEnvelope.collaboration?.stage),
    ).toEqual(['plan', 'plan_review'])
    expect(native.inputs[writesBefore + 1]?.promptEnvelope.collaborationAuthorization?.actor).toBe(
      primary,
    )

    const approval = {
      sessionId: f.sessionId,
      taskId: ready.id,
      revision: ready.revision,
      clientMessageId: randomUUID(),
      action: 'execute' as const,
    }
    expect(await f.flow.actOnCollaboration(approval)).toMatchObject({ ok: true })
    expect(await f.flow.actOnCollaboration(approval)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 5))
    expect(await f.settled()).toMatchObject({
      status: 'complete',
      repairAttempts: stopped.repairAttempts,
    })
    expect(
      native.inputs
        .slice(writesBefore + 3)
        .map((input) => input.promptEnvelope.collaboration?.stage),
    ).toEqual(['implement', 'code_review'])
    const implementation = native.inputs[writesBefore + 3]!
    expect(implementation.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
      purpose: 'action',
    })
    expect(
      implementation.promptEnvelope.collaborationAuthorization?.userAuthority?.rootReceiptId,
    ).not.toBe(original.userAuthority?.rootReceiptId)
    expect(repo.collaboration(f.sessionId)?.planRevision).toBeUndefined()
    for (const run of native.inputs.slice(writesBefore + 1)) {
      const authorization = run.promptEnvelope.collaborationAuthorization!
      const read = native.sourceReads.find((entry) => entry.runId === run.runId)
      expect(repo.sourceDocumentAuthorized(run.runId, original.planReference!.document)).toBe(true)
      expect(read?.documents).toContainEqual(
        expect.objectContaining({ id: original.planReference!.document.id }),
      )
      const scopeAuthorized = original.reviewScopeRef
        ? repo.sourceDocumentAuthorized(run.runId, original.reviewScopeRef)
        : undefined
      expect(scopeAuthorized).toBe(stage === 'repair' ? true : undefined)
      expect(read?.inputBodies).toContain(request)
      expect(read?.documents).toContainEqual(
        expect.objectContaining({
          id: authorization.planRevisionContextRef?.id,
        }),
      )
      expect(repo.readFrozenInputBatch(run.runId, original.inputBatchRef!.id).batch).toMatchObject(
        original.inputBatchRef!,
      )
    }
  },
)

it.each(['plan', 'plan_review'] as const)(
  'resumes automation within the running revised %s without admitting a replacement',
  async (stage) => {
    const f = await fixture()
    const repo = f.db.conversationRepository
    expect(await f.flow.send(f.input('/plan Preserve the accepted scope.'))).toMatchObject({
      ok: true,
    })
    await f.settled()
    native.interruptNextWrite = true
    expect(await f.act('execute')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    await f.settled()
    native.replyOutcome = { outcome: 'plan_revision_required' }
    expect(await f.flow.send(f.input('Revise the original acceptance criteria.'))).toMatchObject({
      ok: true,
    })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    await f.settled()

    const hold = Promise.withResolvers<void>()
    native.holdStage = { stage, until: hold.promise }
    const count = stage === 'plan' ? 5 : 6
    try {
      expect(await f.act('resume')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(count))
      const running = repo.collaboration(f.sessionId)!
      expect(running).toMatchObject({ stage, status: 'running' })
      expect(await f.act('pause')).toMatchObject({ ok: true })
      expect(await f.act('resume')).toMatchObject({ ok: true })
      expect(repo.collaboration(f.sessionId)).toMatchObject({
        stage,
        status: 'running',
        runId: running.runId,
        automation: 'active',
      })
      expect(native.inputs).toHaveLength(count)
    } finally {
      hold.resolve()
    }
    await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
    expect(await f.settled()).toMatchObject({ status: 'ready', stage: 'plan_review' })
    expect(
      native.inputs.slice(4).map((input) => input.promptEnvelope.collaboration?.stage),
    ).toEqual(['plan', 'plan_review'])
  },
)

it('returns an unchanged Plan to the original unfinished write without a redundant plan review', async () => {
  const f = await fixture(),
    repo = f.db.conversationRepository
  native.unselectedPlan =
    'Unselected earlier plan publication; it is outside the accepted write source scope.'
  expect(
    await f.flow.send(f.input('/plan Preserve the exact accepted cancellation scope.')),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
  expect(await f.settled()).toMatchObject({ status: 'ready' })
  const accepted = repo.collaboration(f.sessionId)!.planReference!
  const observed = f.db.drizzle.get<{ source: string }>(
    sql`SELECT json_extract(payload,'$.source') AS source FROM agent_event_journal WHERE run_id=${native.inputs[0]!.runId} AND event_type='workflow.plan_observed' ORDER BY sequence LIMIT 1`,
  )
  const unselected = collaborationDocumentSchema.parse(JSON.parse(observed.source))
  expect(unselected.id).not.toBe(accepted.document.id)
  native.forbiddenDocuments = [unselected]
  native.interruptNextWrite = true
  expect(await f.act('execute')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
  const stopped = await f.settled()
  expect(stopped.pendingWork).toMatchObject({ stage: 'implement', runId: native.inputs[2]!.runId })
  const root = repo.collaborationTurnAuthorization(native.inputs[2]!.runId)!.userAuthority!
    .rootReceiptId
  expect(
    await f.flow.send(
      f.input(
        'Status only: report where this unchanged accepted plan stopped; keep the original plan and write scope.',
      ),
    ),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
  await f.settled()
  expect(repo.collaboration(f.sessionId)?.planReference?.document.sha256).toBe(
    accepted.document.sha256,
  )
  expect(await f.act('resume')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
  const completed = await f.settled()
  expect(completed).toMatchObject({ status: 'complete', repairAttempts: 0 })
  expect(native.inputs.slice(4).map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
    'implement',
    'code_review',
  ])
  expect(native.inputs[4]!.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
    purpose: 'write_continuation',
    rootReceiptId: root,
  })
  expect(
    native.sourceReads.find((read) => read.runId === native.inputs[4]!.runId)?.rejectedDocumentIds,
  ).toContain(unselected.id)
  expect(repo.sourceDocumentAuthorized(native.inputs[4]!.runId, unselected)).toBe(false)
  expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(0)
})

it.each(['implement', 'repair'] as const)(
  'reads original bodies, frozen Comments and fixed scope with the new %s caller grant while later drafts remain unsent',
  async (stage) => {
    const f = await fixture(),
      repo = f.db.conversationRepository
    expect(await f.flow.send(f.input('Provide the immutable Comment anchor.'))).toMatchObject({
      ok: true,
    })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
    const origin = repo.findRun(native.inputs[0]!.runId)!,
      anchorText = 'ordinary complete within the original scope.'
    const anchor = {
      type: 'message' as const,
      messageId: origin.responseMessageId!,
      contentHash: createHash('sha256').update(anchorText).digest('hex'),
      textBasis: 'markdown-visible-v2' as const,
      startOffset: 0,
      endOffset: 8,
      quote: anchorText.slice(0, 8),
    }
    const oldId = randomUUID(),
      oldBody = 'Original frozen cancellation Comment.\n'.repeat(400) + 'FINAL COMMENT LINE 🧪'
    let drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing drafts')
    repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: oldId,
      expectedCommentsRevision: drafts.commentsRevision,
      body: oldBody,
      anchor,
    })
    const originalInput =
      '/build ' +
      'Preserve only the exact original cancellation scope.\n'.repeat(300) +
      'FINAL ORIGINAL INPUT LINE 🧪'
    native.interruptNextWrite = stage === 'implement'
    if (stage === 'repair') native.reviews = [{ verdict: 'changes_requested' }]
    expect(await f.flow.send({ ...f.input(originalInput), commentIds: [oldId] })).toMatchObject({
      ok: true,
    })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'implement' ? 2 : 3))
    await f.settled()
    native.interruptNextWrite = stage === 'repair'
    const repair = stage === 'repair' ? await f.act('repair') : undefined
    expect(repair?.ok).toBe(stage === 'repair' ? true : undefined)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'repair' ? 4 : 2))
    await f.settled()
    const interrupted = repo.collaboration(f.sessionId)!,
      original = repo.collaborationTurnAuthorization(interrupted.pendingWork!.runId)!,
      originalScope = original.reviewScopeRef ?? interrupted.taskDocument!
    expect(
      await f.flow.send(
        f.input(
          'Status only: report progress without changing the original scope or accepted authorization.',
        ),
      ),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'implement' ? 3 : 5))
    await f.settled()
    drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing drafts')
    const laterId = randomUUID()
    repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId: laterId,
      expectedCommentsRevision: drafts.commentsRevision,
      body: 'A later draft remains local and grants no new scope.',
      anchor,
    })
    expect(await f.act('resume')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'implement' ? 5 : 7))
    expect(await f.settled()).toMatchObject({
      status: 'complete',
      repairAttempts: interrupted.repairAttempts,
    })
    const continuation = native.inputs.find(
        (input) =>
          input.promptEnvelope.collaborationAuthorization?.userAuthority?.purpose ===
          'write_continuation',
      )!,
      read = native.sourceReads.find((value) => value.runId === continuation.runId)!
    expect(read.inputBodies).toContain(originalInput)
    expect(read.comments).toContainEqual({ id: oldId, text: oldBody })
    expect(read.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: originalScope.id, sha256: originalScope.sha256 }),
      ]),
    )
    expect(read.comments.some((comment) => comment.id === laterId)).toBe(false)
    const remaining = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (remaining.scope !== 'drafts') throw Error('Missing retained drafts')
    expect(remaining.comments.map((comment) => comment.id)).toEqual([laterId])
    expect(
      repo.readFrozenInputBatch(
        continuation.runId,
        continuation.promptEnvelope.collaborationAuthorization!.inputBatchRef!.id,
      ).members,
    ).toEqual([])
    expect(continuation.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
      rootReceiptId: original.userAuthority!.rootReceiptId,
      purpose: 'write_continuation',
    })
  },
)

it('controlled decision cancellation releases its admitted lease after loader rejection', async () => {
  const Runtime = controlledDecisionRuntime(native),
    runtime = new Runtime({
      deadlineAt: Date.now() + 15_000,
      credential: () => 'OWNED_WORKFLOW_CREDENTIAL',
      current: () => true,
      reserve: () => 'reserved',
      dispatch: vi.fn<() => void>(),
    }),
    controller = new AbortController()
  controller.abort()
  try {
    await expect(
      runtime.evaluateDecision(async ({ signal }) => {
        signal.throwIfAborted()
        throw Error('Cancelled loader unexpectedly continued')
      }, controller.signal),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'cancelled' })
    await expect(runtime.settlement()).resolves.toBe(true)
    expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(0)
  } finally {
    await runtime.dispose().catch(() => undefined)
  }
})
