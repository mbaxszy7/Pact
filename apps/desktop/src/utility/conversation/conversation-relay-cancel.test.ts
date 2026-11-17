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

import { collaborationReadOnly } from './collaboration-prompt.js'
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
  noCodeChanges: false,
  recordCodeChange: undefined as ((input: AgentRunInput) => void) | undefined,
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
  native.noCodeChanges = false
  native.recordCodeChange = undefined
  vi.restoreAllMocks()
})
async function fixture(primary: 'codex' | 'claude' = 'codex') {
  const f = await workflowConversation(Conversation, primary, native)
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
  const currentTask = repo.collaboration(f.sessionId)!
  expect(currentTask.id).toBe(task.id)
  expect(currentTask.automation).toBe(task.automation)
  expect(currentTask.pauseReason).toBe(task.pauseReason)
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

  it.each(['review_plan', 'settings'] as const)(
    'refuses a stale card after %s supersedes the original proposal',
    async (change) => {
      const f = await reachPlanReviewLimit()
      if (change === 'review_plan') {
        const manual = await f.act('review_plan')
        if (manual.ok) throw Error('Ordinary Review plan bypassed the review limit')
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
    'continues the %s Plan through explicit Implement and Review code after cancelling role reassignment',
    async (primary) => {
      const f = await fixture(primary),
        repo = f.db.conversationRepository
      const settleEvaluation = vi.spyOn(repo, 'settleEvaluation')
      enableWorkflowRelay(f.db)
      native.candidate = 'propose_reassign_roles'
      expect(
        await f.flow.send(f.input('/plan Preserve the exact original cancellation scope.')),
      ).toMatchObject({ ok: true })
      await vi.waitFor(
        () =>
          expect(repo.relaySchedulingDecision(f.sessionId)?.request).toMatchObject({
            category: 'arrangement_change',
            operation: { kind: 'reassign_roles' },
          }),
        { timeout: 5_000 },
      )
      await vi.waitFor(() =>
        expect(settleEvaluation).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            outcome: 'completed',
            physicalReleased: true,
            selectedCandidateId: 'propose_reassign_roles',
            httpOwner: expect.objectContaining({ version: 1, kind: 'http' }),
            remoteOutcome: 'responded',
          }),
        ),
      )
      native.candidate = null
      const state = await cancel(f)
      expect(await f.settled()).toMatchObject({ status: 'ready' })
      expect(native.decisions).toHaveLength(state.decisionCount)
      expect(repo.collaboration(f.sessionId)?.stageRoles).toEqual(state.task.stageRoles)
      expect(native.inputs).toHaveLength(2)
      expect(await f.act('execute')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
      expect(await f.settled()).toMatchObject({
        openMode: true,
        status: 'waiting',
        unreviewedCodeActor: primary === 'codex' ? 'claude' : 'codex',
      })
      expect(
        native.inputs[2]!.promptEnvelope.collaborationAuthorization?.userAuthority,
      ).toMatchObject({ purpose: 'action' })
      expect(await f.act('review_code')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
      expect(await f.settled()).toMatchObject({
        status: 'waiting',
        review: { verdict: 'accepted' },
      })
      expect(native.inputs[3]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
      expect(await f.flow.answerRelayDecision(state.request)).toEqual(state.result)
      expect(native.inputs).toHaveLength(4)
      expect(repo.schedulingBudget(`task:${state.task.id}`)).toMatchObject({
        extraPlanTurns: 0,
        extraCodeTurns: 0,
      })
    },
  )

  it('continues past plan-review limit cancellation via Session settings and explicit review_plan without extra Relay quota', async () => {
    const f = await reachPlanReviewLimit('codex')
    const state = await cancel(f)
    const session = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...session.settings,
      maxDiscussionRounds: 2,
    })
    const current = f.repo.collaboration(f.sessionId)!
    const manual = {
      sessionId: f.sessionId,
      taskId: current.id,
      revision: current.revision,
      clientMessageId: randomUUID(),
      action: 'review_plan' as const,
    }
    expect(await f.flow.actOnCollaboration(manual)).toMatchObject({ ok: true })
    expect(await f.flow.actOnCollaboration(manual)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    expect(await f.settled()).toMatchObject({ status: 'ready', discussionRounds: 2 })
    expect(native.inputs).toHaveLength(4)
    expect(f.repo.schedulingBudget(`task:${state.task.id}`)).toMatchObject({
      extraPlanTurns: 0,
      extraCodeTurns: 0,
    })
    expect(await f.flow.answerRelayDecision(state.request)).toEqual(state.result)
  })

  it.each(['codex', 'claude'] as const)(
    'continues %s Open Mode review findings through explicit fix and rereview receipts',
    async (primary) => {
      const f = await fixture(primary),
        repo = f.db.conversationRepository
      expect(
        await f.flow.send(f.input('/build Preserve only the original cancellation scope.')),
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
      await f.settled()
      native.reviews = [{ verdict: 'changes_requested' }, { verdict: 'accepted' }]
      expect(await f.act('review_code')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
      const reviewed = await f.settled()
      const task = repo.collaboration(f.sessionId)!,
        fixInput = {
          sessionId: f.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: randomUUID(),
          action: 'fix' as const,
        }
      expect(await f.flow.actOnCollaboration(fixInput)).toMatchObject({ ok: true })
      expect(await f.flow.actOnCollaboration(fixInput)).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
      await f.settled()
      expect(native.inputs).toHaveLength(3)
      expect(native.inputs[2]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'collaborate',
        actor: primary === 'codex' ? 'claude' : 'codex',
        reviewScopeRef: reviewed.reviewScopeRef,
      })
      expect(
        native.inputs[2]!.promptEnvelope.collaborationAuthorization?.userAuthority,
      ).toMatchObject({ purpose: 'action' })
      expect(await f.act('review_code')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
      expect(await f.settled()).toMatchObject({
        status: 'complete',
        repairAttempts: 1,
        reviewCycles: 2,
      })
      expect(native.inputs[3]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
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
  'continues Open Mode implementation after interrupted writes via retry and collaborate with %s Primary',
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
    expect(stopped).toMatchObject({
      openMode: true,
      stage: 'implement',
      status: 'failed',
      automation: 'paused',
      pauseReason: 'stopped',
    })
    const original = repo.collaborationTurnAuthorization(stopped.runId)!
    native.holdNextWrite = true
    expect(await f.act('retry')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    await f.settled()
    expect(
      await f.flow.send(f.input('Continue the same implementation without changing its scope.')),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(5))
    const collaborated = await f.settled(),
      write = native.inputs.at(-1)!
    expect(collaborated).toMatchObject({
      openMode: true,
      stage: 'collaborate',
      actor: implementer,
      status: 'waiting',
      unreviewedCodeActor: implementer,
    })
    expect(write.promptEnvelope.collaborationAuthorization).toMatchObject({
      actor: implementer,
      stage: 'collaborate',
      planReference: original.planReference,
    })
    expect(
      collaborationReadOnly(
        write.promptEnvelope.collaboration,
        write.promptEnvelope.collaborationAuthorization,
      ),
    ).toBe(false)
    expect(await f.act('review_code')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
    expect(await f.settled()).toMatchObject({
      status: 'waiting',
      stage: 'code_review',
      actor: primary,
      repairAttempts: 0,
    })
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
      'plan',
      'plan_review',
      'implement',
      'implement',
      'collaborate',
      'code_review',
    ])
  },
)

it.each([
  { primary: 'codex', stage: 'implement' },
  { primary: 'claude', stage: 'collaborate' },
] as const)(
  'updates an Open Mode plan inside collaborate after %s/$stage interruption before review_plan and execute',
  async ({ primary, stage }) => {
    const f = await fixture(primary)
    const repo = f.db.conversationRepository
    expect(
      await f.flow.send(f.input('/plan Handle cancellation with the original acceptance.')),
    ).toMatchObject({ ok: true })
    expect(await f.settled()).toMatchObject({ status: 'ready' })
    if (stage === 'collaborate') native.reviews = [{ verdict: 'changes_requested' }]
    native.holdNextWrite = stage === 'implement'
    expect(await f.act('execute')).toMatchObject({ ok: true })
    if (stage === 'collaborate') {
      await vi.waitFor(() => {
        if (native.inputs.length !== 3) throw Error('Waiting for execute run')
      })
      await f.settled()
      const reviewed = await f.act('review_code')
      if (!reviewed.ok) throw Error(reviewed.error.message)
      await vi.waitFor(() => {
        if (native.inputs.length !== 4) throw Error('Waiting for review_code run')
      })
      await f.settled()
      native.holdNextWrite = true
      const fixed = await f.act('fix')
      if (!fixed.ok) throw Error(fixed.error.message)
    }
    const writesBefore = stage === 'collaborate' ? 5 : 3
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore))
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    const stopped = await f.settled()
    const original = repo.collaborationTurnAuthorization(stopped.runId)!
    expect(stopped).toMatchObject({ openMode: true, stage, status: 'failed' })
    native.planText = 'Updated acceptance includes cancellation while offline.'
    const request = 'Change acceptance to include cancellation while offline.'
    expect(await f.flow.send(f.input(request))).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 1))
    const published = await f.settled()
    expect(published).toMatchObject({
      openMode: true,
      stage: 'collaborate',
      status: 'waiting',
      planVersion: 2,
      unreviewedPlanActor: published.actor,
    })
    native.planText = undefined
    expect(await f.act('review_plan')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 2))
    const ready = await f.settled()
    expect(ready).toMatchObject({
      stage: 'plan_review',
      status: 'waiting',
      repairAttempts: stopped.repairAttempts,
      review: { verdict: 'accepted' },
    })
    const approval = {
      sessionId: f.sessionId,
      taskId: ready.id,
      revision: ready.revision,
      clientMessageId: randomUUID(),
      action: 'execute' as const,
    }
    expect(await f.flow.actOnCollaboration(approval)).toMatchObject({ ok: true })
    expect(await f.flow.actOnCollaboration(approval)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 3))
    await f.settled()
    expect(await f.act('review_code')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(writesBefore + 4))
    expect(await f.settled()).toMatchObject({
      status: 'waiting',
      review: { verdict: 'accepted' },
      repairAttempts: stopped.repairAttempts,
    })
    expect(
      native.inputs.slice(writesBefore).map((input) => input.promptEnvelope.collaboration?.stage),
    ).toEqual(['collaborate', 'plan_review', 'implement', 'code_review'])
    const implementation = native.inputs[writesBefore + 2]!
    expect(implementation.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
      purpose: 'action',
    })
    expect(
      implementation.promptEnvelope.collaborationAuthorization?.userAuthority?.rootReceiptId,
    ).not.toBe(original.userAuthority?.rootReceiptId)
    for (const run of native.inputs.slice(writesBefore + 1)) {
      const read = native.sourceReads.find((entry) => entry.runId === run.runId)
      expect(read?.inputBodies).toContain(request)
      expect(read?.documents).toContainEqual(
        expect.objectContaining({ id: published.planReference!.document.id }),
      )
    }
  },
)

it.each(['plan', 'plan_review'] as const)(
  'refuses duplicate dispatch while a paused Phase 1 %s run is running, then advances once settled',
  async (stage) => {
    const f = await fixture()
    const repo = f.db.conversationRepository
    if (stage === 'plan_review') {
      native.reviews = [{ verdict: 'changes_requested' }, { verdict: 'accepted' }]
    }
    const hold = Promise.withResolvers<void>()
    native.holdStage = { stage, until: hold.promise }
    try {
      expect(await f.flow.send(f.input('/plan Preserve the accepted scope.'))).toMatchObject({
        ok: true,
      })
      const count = stage === 'plan' ? 1 : 2
      await vi.waitFor(() => expect(native.inputs).toHaveLength(count))
      const running = repo.collaboration(f.sessionId)!
      expect(running).toMatchObject({ stage, status: 'running' })
      repo.pauseCollaboration(f.sessionId, 'user')
      expect(await f.act('resume')).toMatchObject({ ok: false })
      expect(await f.act('review_plan')).toMatchObject({ ok: false })
      expect(repo.collaboration(f.sessionId)).toMatchObject({
        stage,
        status: 'running',
        runId: running.runId,
        automation: 'paused',
      })
      expect(native.inputs).toHaveLength(count)
    } finally {
      hold.resolve()
    }
    const waiting = await f.settled()
    expect(waiting).toMatchObject({ status: 'waiting', automation: 'paused', stage })
    expect(await f.act(stage === 'plan' ? 'review_plan' : 'resume')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(repo.collaboration(f.sessionId)?.status).toBe('ready'))
    expect(await f.settled()).toMatchObject({ status: 'ready', stage: 'plan_review' })
  },
)

it('retries an unchanged interrupted Plan implementation without a redundant plan review or leaked unselected source', async () => {
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
  expect(stopped).toMatchObject({ stage: 'implement', status: 'failed', pauseReason: 'stopped' })
  expect(await f.act('retry')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
  await f.settled()
  expect(await f.act('review_code')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(5))
  const completed = await f.settled()
  expect(completed).toMatchObject({
    status: 'waiting',
    repairAttempts: 0,
    review: { verdict: 'accepted' },
  })
  expect(native.inputs.slice(3).map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
    'implement',
    'code_review',
  ])
  expect(native.inputs[3]!.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
    purpose: 'action',
  })
  expect(
    native.sourceReads.find((read) => read.runId === native.inputs[3]!.runId)?.rejectedDocumentIds,
  ).toContain(unselected.id)
  expect(repo.sourceDocumentAuthorized(native.inputs[3]!.runId, unselected)).toBe(false)
  expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(0)
})

it.each(['implement', 'collaborate'] as const)(
  'reads original bodies, frozen Comments and fixed scope with the retried %s grant while later drafts remain unsent',
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
    if (stage === 'collaborate')
      native.reviews = [{ verdict: 'changes_requested' }, { verdict: 'accepted' }]
    expect(await f.flow.send({ ...f.input(originalInput), commentIds: [oldId] })).toMatchObject({
      ok: true,
    })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    await f.settled()
    if (stage === 'collaborate') {
      const reviewed = await f.act('review_code')
      if (!reviewed.ok) throw Error(reviewed.error.message)
      await vi.waitFor(() => {
        if (native.inputs.length !== 3) throw Error('Waiting for review_code run')
      })
      await f.settled()
      native.interruptNextWrite = true
      const fixed = await f.act('fix')
      if (!fixed.ok) throw Error(fixed.error.message)
      await vi.waitFor(() => {
        if (native.inputs.length !== 4) throw Error('Waiting for interrupted fix run')
      })
      await f.settled()
    }
    const interrupted = repo.collaboration(f.sessionId)!,
      originalScope = interrupted.reviewScopeRef ?? interrupted.taskDocument!
    expect(interrupted).toMatchObject({ stage, status: 'failed' })
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
    expect(await f.act('retry')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'implement' ? 3 : 5))
    await f.settled()
    expect(await f.act('review_code')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(stage === 'implement' ? 4 : 6))
    expect(await f.settled()).toMatchObject({
      status: 'complete',
      repairAttempts: interrupted.repairAttempts,
    })
    const continuation = native.inputs[stage === 'implement' ? 2 : 4]!,
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
    expect(continuation.promptEnvelope.collaborationAuthorization?.userAuthority?.purpose).toBe(
      'action',
    )
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
