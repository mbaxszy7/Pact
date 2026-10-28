import { sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationReviewObservation,
  DecisionInput,
  CollaborationDocument,
} from '@pact/contracts'

import { collaborationDocumentSchema } from '@pact/contracts'

import type { WorkflowSourceRead } from './relay-workflow-fixture.test-support.js'

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
vi.mock('./codex-decision-runtime.js', async () => {
  const { workflowDecisionRuntime } = await import('./relay-workflow-fixture.test-support.js')
  return { CodexDecisionRuntime: workflowDecisionRuntime(native) }
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

describe('Cancel an optional Relay advancement, then continue through the original workflow owner', () => {
  it.each(['codex', 'claude'] as const)(
    'continues the %s Plan through its fixed reviewer and explicit Implement',
    async (primary) => {
      const f = await fixture(primary),
        repo = f.db.conversationRepository
      const physicalCompletion = vi.spyOn(repo, 'completeSchedulingRuntimePhysical')
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
      expect(physicalCompletion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ completed: true, candidateId: 'propose_supplement_plan' }),
      )
      const state = await cancel(f)
      expect(native.inputs).toHaveLength(5)
      await f.settled()
      expect(native.inputs).toHaveLength(5)
      native.candidate = undefined
      expect(await f.act('resume')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
      expect(await f.settled()).toMatchObject({ status: 'ready' })
      expect(native.inputs[5]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'plan_review',
        actor: state.task.reviewer,
      })
      expect(native.decisions).toHaveLength(state.decisionCount)
      expect(await f.act('execute')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(8))
      expect(await f.settled()).toMatchObject({ status: 'complete' })
      expect(
        native.inputs[6]!.promptEnvelope.collaborationAuthorization?.userAuthority,
      ).toMatchObject({ purpose: 'action' })
      expect(native.inputs[7]!.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: state.task.reviewer,
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
        actor: primary,
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
        actor: state.task.reviewer,
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

it('returns an unchanged reaccepted Plan to the original unfinished write through the automatic caller', async () => {
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
  await vi.waitFor(() => expect(native.inputs).toHaveLength(7))
  const completed = await f.settled()
  expect(completed).toMatchObject({ status: 'complete', repairAttempts: 0 })
  expect(native.inputs.slice(4).map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
    'plan_review',
    'implement',
    'code_review',
  ])
  expect(native.inputs[5]!.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
    purpose: 'write_continuation',
    rootReceiptId: root,
  })
  expect(
    native.sourceReads.find((read) => read.runId === native.inputs[5]!.runId)?.rejectedDocumentIds,
  ).toContain(unselected.id)
  expect(repo.sourceDocumentAuthorized(native.inputs[5]!.runId, unselected)).toBe(false)
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
      executable: async () => process.execPath,
      current: () => true,
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
