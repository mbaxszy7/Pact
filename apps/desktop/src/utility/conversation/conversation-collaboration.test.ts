import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationAction,
  CollaborationReviewObservation,
  CollaborationInputObservation,
  ConversationSendInput,
  NormalizedAgentEvent,
  RuntimeAgentId,
  MessageCommentAnchor,
  DecisionInput,
  DecisionRemoteOutcome,
  DecisionSelectionOutcome,
} from '@pact/contracts'

import {
  OPENAI_DECISION_MODEL,
  advanceCollaboration,
  collaborationAvailableActions,
  handoffGuidanceSchema,
  initialTaskRoleCandidates,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import {
  collaborationActionReceipts,
  conversationBodyInputs,
  nativeAgentContexts,
} from '../../../../../packages/persistence/src/schema/index.js'
import { markdownVisibleProjection } from '../../shared/message-anchor-text.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import {
  collaborationInputResultRequired,
  collaborationPlanMode,
  collaborationReadOnly,
} from './collaboration-prompt.js'
import { Conversation } from './conversation.js'
import { claudePromptContent } from './native-image-content.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
import { DecisionMemoryLease, decisionWorkingMemoryDiagnostics } from './native-working-memory.js'
const markdownWorker = vi.hoisted(() => ({ path: '' }))
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
          String(filename).endsWith('markdown-projection-worker.js')
            ? markdownWorker.path
            : filename,
          options,
        )
      }
    },
  }
})
let workerFixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  workerFixture = await nativeWorkerFixture(['markdown-projection-worker'])
  markdownWorker.path = workerFixture.paths['markdown-projection-worker']!
}, 20_000)
afterAll(async () => {
  await workerFixture?.dispose()
})

const native = vi.hoisted(() => ({
  inputs: [] as AgentRunInput[],
  next: undefined as
    | {
        plan?: string | null
        review?: CollaborationReviewObservation
        input?: CollaborationInputObservation
      }
    | undefined,
  nextReview: undefined as CollaborationReviewObservation | undefined,
  reviews: [] as CollaborationReviewObservation[],
  plans: [] as string[],
  hold: undefined as Promise<void> | undefined,
  fail: false,
  sources: [] as Array<{
    runId: string
    id: string
    chars: number
    sha256: string
    largestReply: number
  }>,
  decisions: [] as DecisionInput[],
  decisionStarted: undefined as ((input: DecisionInput) => void) | undefined,
  decisionHold: undefined as Promise<void> | undefined,
  decisionCandidate: undefined as string | null | undefined,
  decisionFailure: undefined as 'timeout' | 'invalid_output' | undefined,
  decisionPhysicalHold: undefined as Promise<void> | undefined,
  guidanceBodies: [] as string[],
}))
vi.mock('./openai-decision-runtime.js', () => ({
  OpenAIDecisionRuntime: class {
    readonly provider = 'openai'
    readonly modelId = OPENAI_DECISION_MODEL
    invoked = false
    usage = { inputTokens: 31, outputTokens: 7 }
    private remoteOutcome: DecisionRemoteOutcome = 'not_sent'
    private work: Promise<DecisionSelectionOutcome> | undefined
    private closeTask: Promise<boolean> | undefined
    private readonly controller = new AbortController()
    private readonly memory = new DecisionMemoryLease()
    constructor(
      readonly context: ConstructorParameters<
        typeof import('./openai-decision-runtime.js').OpenAIDecisionRuntime
      >[0],
    ) {}
    evaluateDecision(
      value: import('./decision-runtime.js').DecisionInputLoader,
      signal: AbortSignal,
    ) {
      const observed = AbortSignal.any([signal, this.controller.signal])
      this.work = (async (): Promise<DecisionSelectionOutcome> => {
        try {
          const deadlineAt = this.context.deadlineAt
          const input = await value({ signal: observed, deadlineAt })
          const reserved = this.context.reserve(input, { deadlineAt })
          if (reserved !== 'reserved') return { kind: 'unavailable', reason: reserved }
          observed.throwIfAborted()
          if (!this.context.current()) return { kind: 'unavailable', reason: 'stale' }
          if (!(await this.context.credential({ signal: observed, deadlineAt })))
            return { kind: 'unavailable', reason: 'runtime_unavailable' }
          observed.throwIfAborted()
          if (!this.context.current()) return { kind: 'unavailable', reason: 'stale' }
          this.context.dispatch()
          this.invoked = true
          this.remoteOutcome = 'unknown'
          native.decisions.push(input)
          native.decisionStarted?.(input)
          if (native.decisionHold)
            await Promise.race([
              native.decisionHold,
              new Promise<void>((done) => {
                observed.addEventListener('abort', () => done(), { once: true })
                if (observed.aborted) done()
              }),
            ])
          observed.throwIfAborted()
          if (!this.context.current()) return { kind: 'unavailable', reason: 'stale' }
          if (native.decisionFailure) return { kind: 'unavailable', reason: native.decisionFailure }
          const roleChoice = input.candidates.some(
            (candidate) => candidate.id === 'propose_reassign_roles',
          )
          const candidateId =
            roleChoice && native.decisionCandidate !== 'propose_reassign_roles'
              ? null
              : native.decisionCandidate === undefined
                ? input.handoff.slot === 'workflow_next'
                  ? null
                  : (input.candidates[0]?.id ?? null)
                : native.decisionCandidate
          if (candidateId !== null && !input.candidates.some((c) => c.id === candidateId))
            return { kind: 'unavailable', reason: 'invalid_output' }
          this.remoteOutcome = 'responded'
          return { kind: 'selection', selection: { candidateId } }
        } catch {
          return {
            kind: 'unavailable',
            reason: observed.aborted ? 'cancelled' : 'runtime_unavailable',
          }
        }
      })()
      return this.work.then(async (outcome) =>
        outcome.kind === 'selection' && !(await this.settlement())
          ? { kind: 'unavailable' as const, reason: 'runtime_unavailable' as const }
          : outcome,
      )
    }
    diagnostics() {
      return { remoteOutcome: this.remoteOutcome, working: this.memory.diagnostics() }
    }
    settlement() {
      this.closeTask ??= (async () => {
        await this.work
        await native.decisionPhysicalHold
        this.memory.release()
        return true
      })().catch(() => false)
      return this.closeTask
    }
    dispose() {
      this.controller.abort()
      return this.settlement()
    }
  },
}))
function adapter(agentId: RuntimeAgentId) {
  return class {
    readonly id = agentId
    async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<NormalizedAgentEvent> {
      if (native.inputs.length >= 32) throw Error('Fixture Turn bound exceeded')
      native.inputs.push(input)
      const report = native.next
      native.next = undefined
      input.recordDispatch?.('possibly_sent', `${input.sessionId}-${agentId}`)
      yield { agentId, type: 'session.started', nativeSessionId: `${input.sessionId}-${agentId}` }
      input.recordDispatch?.('accepted', `${input.sessionId}-${agentId}`)
      yield { agentId, type: 'turn.started', turnId: input.runId }
      if (native.hold)
        await Promise.race([
          native.hold,
          new Promise<void>((done) => {
            signal.addEventListener('abort', () => done(), { once: true })
            if (signal.aborted) done()
          }),
        ])
      signal.throwIfAborted()
      if (native.fail) throw Error('Fixture failure after accepted delivery')
      const phase = input.promptEnvelope.collaboration
      const sourceReader = input.collaborationSourceReader
      if (sourceReader) {
        const targets: import('@pact/agent-runtime').AgentSourceTarget[] = [
          { source: 'handoff_sources' },
          ...(input.promptEnvelope.inputBatchRef
            ? [{ source: 'batch' as const, batchId: input.promptEnvelope.inputBatchRef.id }]
            : []),
          ...(input.promptEnvelope.collaborationAuthorization
            ? [{ source: 'inputs' as const }]
            : []),
        ]
        for (const target of targets) {
          let request = sourceReader.navigation(target, 'sourceReference')
          for (let ordinal = 0; ; ordinal++) {
            if (ordinal >= 64) throw Error('Controlled index page bound exceeded')
            const page = sourceReader.read(request).page
            expect(page.source).toBe(target.source)
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
            if (page.nextOffset === null) break
            if (!page.nextRead) throw Error('Missing source index continuation')
            request = page.nextRead
          }
        }
      }
      if (!phase) {
        yield {
          agentId,
          type: 'text.completed',
          turnId: input.runId,
          outputId: input.runId,
          text: `${agentId} ordinary response.`,
        }
        yield { agentId, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
        input.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
        })
        return
      }
      const manifest = input.promptEnvelope.collaborationAuthorization?.sourceManifestRef
      for (const document of [phase.planReference?.document, phase.taskDocument, manifest].filter(
        (source) => source !== undefined,
      )) {
        let offset = 0,
          largestReply = 0
        const hash = createHash('sha256')
        let manifestText = ''
        for (;;) {
          const page = input.readCollaborationSourcePart!({
            ...input.promptEnvelope.sourceGrant,
            document,
            offset,
          })
          const reader = input.collaborationSourceReader!
          const reference = reader.navigation({ source: 'document', document }, 'sourceReference')
          const ownedPage = reader.read({ ...reference, offset }).page
          expect(ownedPage.text).toBe(page.text)
          expect(ownedPage.nextOffset).toBe(page.nextOffset)
          expect(ownedPage.binding.submitted).toBe('sourceReference')
          hash.update(page.text)
          if (document.id === manifest?.id) manifestText += page.text
          largestReply = Math.max(largestReply, Buffer.byteLength(JSON.stringify(page)))
          offset += page.text.length
          if (page.nextOffset === null) break
          if (page.nextOffset !== offset)
            throw Error('Source continuation skipped or repeated text')
        }
        if (document.id === manifest?.id) {
          handoffGuidanceSchema.parse(JSON.parse(manifestText))
          native.guidanceBodies.push(manifestText)
        }
        native.sources.push({
          runId: input.runId,
          id: document.id,
          chars: offset,
          sha256: hash.digest('hex'),
          largestReply,
        })
      }
      if (report?.input) input.recordWorkflowInputResult?.(report.input)
      else if (
        phase.stage === 'plan' ||
        (phase.stage === 'reply' &&
          phase.kind === 'plan' &&
          !phase.codeRunId &&
          phase.actor === phase.owner)
      ) {
        if (report?.plan !== null)
          input.recordWorkflowPlan?.({
            nativeId: `plan-${input.runId}`,
            text:
              report?.plan ?? native.plans.shift() ?? '1. Implement scope. 2. Verify cancellation.',
          })
      } else if (phase.stage === 'plan_review' || phase.stage === 'code_review') {
        input.recordWorkflowReview?.(
          report?.review ?? native.nextReview ?? native.reviews.shift() ?? { verdict: 'accepted' },
        )
        native.nextReview = undefined
      } else if (phase.stage === 'reply')
        input.recordWorkflowInputResult?.({ outcome: 'processed' })
      yield {
        agentId,
        type: 'text.completed',
        turnId: input.runId,
        outputId: input.runId,
        text: `${phase.stage} complete.`,
      }
      yield { agentId, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }
    async dispose() {}
  }
}
vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: adapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: adapter('claude') }))
const owners: Array<{ db: PactDatabase; flow: Conversation; directory: string }> = []
afterEach(async () => {
  await Promise.all(
    owners.splice(0).map(async (owner) => {
      await owner.flow.dispose()
      owner.db.close()
      await rm(owner.directory, { recursive: true, force: true })
    }),
  )
  native.inputs = []
  native.next = undefined
  native.nextReview = undefined
  native.reviews = []
  native.plans = []
  native.hold = undefined
  native.fail = false
  native.sources = []
  native.decisions = []
  native.decisionStarted = undefined
  native.decisionHold = undefined
  native.decisionCandidate = undefined
  native.decisionFailure = undefined
  native.decisionPhysicalHold = undefined
  native.guidanceBodies = []
  vi.restoreAllMocks()
})

async function fixture(
  primaryAgentId: RuntimeAgentId = 'codex',
  databaseInProject = false,
  measurePerformance = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-collaboration-flow-'))
  if (databaseInProject) await mkdir(join(directory, '.pact-data/dev'), { recursive: true })
  const db = await PactDatabase.open({
    filePath: databaseInProject ? join(directory, '.pact-data/dev/pact.sqlite') : ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
    measurePerformance,
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Collaboration',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Collaboration', createdAt },
    {
      primaryAgentId,
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
      ],
    },
  })
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
    undefined,
    undefined,
    undefined,
    () => 'OWNED_COLLABORATION_CREDENTIAL',
  )
  owners.push({ db, flow, directory })
  const input = (content: string): ConversationSendInput => {
    const page = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (page.scope !== 'drafts') throw Error('Missing draft')
    return {
      sessionId,
      clientMessageId: randomUUID(),
      content,
      commentIds: [],
      expectedCommentsRevision: page.commentsRevision,
    }
  }
  const settled = async () => {
    await vi.waitFor(() =>
      expect(db.conversationRepository.collaboration(sessionId)?.status).not.toBe('running'),
    )
    await vi.waitFor(() =>
      expect(db.conversationRepository.nativeRecoveryBlocksInput(sessionId)).toBe(false),
    )
    await vi.waitFor(() => expect(flow.diagnostics().activeExecutions).toBe(0))
    return db.conversationRepository.collaboration(sessionId, undefined, true)!
  }
  const act = async (action: CollaborationAction) => {
    const task = db.conversationRepository.collaboration(sessionId)!
    const response = await flow.actOnCollaboration({
      sessionId,
      taskId: task.id,
      revision: task.revision,
      clientMessageId: randomUUID(),
      action,
    })
    if (!response.ok) throw Error(response.error.message)
    await vi.waitFor(() =>
      expect(db.conversationRepository.collaboration(sessionId)?.runId).not.toBe(task.runId),
    )
    return settled()
  }
  const drafts = (id = sessionId) => {
    const page = db.conversationRepository.readPage({ scope: 'drafts', sessionId: id })
    if (page.scope !== 'drafts') throw Error('Missing draft page')
    return page.comments
  }
  return { db, flow, sessionId, input, settled, act, drafts, preparation }
}

it('routes bare /plan to default Claude and preserves the exact user message through native serialization', async () => {
  const f = await fixture('claude')
  const original = '/plan 保留用户原文\nInspect cancellation ownership.'
  const input = f.input(original)
  expect((await f.flow.send(input)).ok).toBe(true)
  await f.settled()
  const planner = native.inputs[0]!
  expect(planner.promptEnvelope.collaboration).toMatchObject({
    kind: 'plan',
    stage: 'plan',
    actor: 'claude',
    owner: 'claude',
  })
  expect(planner.promptEnvelope.message.content).toBe(original)
  const content = await claudePromptContent(planner.promptEnvelope)
  expect(typeof content).toBe('string')
  expect(content).not.toMatch(/^\s*\/plan(?:\s|$)/u)
  expect(content).toContain(original)
  expect(
    f.db.conversationRepository.internalMessage(input.clientMessageId, f.sessionId),
  ).toMatchObject({
    content: original,
    role: 'user',
  })
  expect(native.sources).toContainEqual(
    expect.objectContaining({
      runId: planner.runId,
      chars: original.length,
      sha256: createHash('sha256').update(original).digest('hex'),
    }),
  )
})

function enableRelaySettings(f: Awaited<ReturnType<typeof fixture>>) {
  const repository = f.db.conversationRepository
  repository.saveSchedulingSettings({
    expectedRevision: repository.schedulingSettings().revision,
    enabled: true,
  })
  const credential = repository.writeRelayCredential({
    operation: 'save',
    nonce: randomUUID(),
    expectedRevision: repository.readRelayCredential().revision,
    deadlineAt: Date.now() + 5000,
    ciphertext: Buffer.from('owned collaboration ciphertext').toString('base64'),
  })
  if (!credential.configured) throw Error('Owned collaboration ciphertext must be saved')
}

function enableRelay(f: Awaited<ReturnType<typeof fixture>>, requestedRevisions = 2) {
  enableRelaySettings(f)
  native.reviews = Array.from({ length: requestedRevisions }, () => ({
    verdict: 'changes_requested' as const,
  }))
  native.plans = Array.from(
    { length: requestedRevisions + 1 },
    (_, revision) =>
      `Plan iteration ${revision + 1}: implement the complete scope and verify cancellation.`,
  )
}

async function completedPlanRevision(
  f: Awaited<ReturnType<typeof fixture>>,
  requestedRevisions = 2,
  timeout = 1_000,
) {
  await vi.waitFor(
    () => {
      expect(native.inputs).toHaveLength(2 + requestedRevisions * 2)
      expect(f.db.conversationRepository.collaboration(f.sessionId)?.status).toBe('ready')
    },
    { timeout },
  )
  return f.settled()
}

function decisionsForProducer(runId: string) {
  return native.decisions.filter((decision) => decision.handoff.freshnessGuard.runId === runId)
}

function expectNoRepeatedConsultation(handoffId: string) {
  const forHandoff = native.decisions.filter((decision) => decision.handoff.id === handoffId)
  expect(forHandoff).toHaveLength(1)
  expect(forHandoff[0]!.candidates.map((candidate) => candidate.id)).toEqual([
    'propose_supplement_plan',
  ])
}

describe('Decisions choices through the original workflow owner', () => {
  it('keeps repeated revisions on the original workflow while Relay is disabled', async () => {
    const f = await fixture()
    enableRelay(f)
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: f.db.conversationRepository.schedulingSettings().revision,
        enabled: false,
      }),
    ).toMatchObject({ ok: true, value: { enabled: false } })
    expect((await f.flow.send(f.input('/plan Keep disabled Relay free of inference.'))).ok).toBe(
      true,
    )
    await completedPlanRevision(f, 2, 5_000)
    expect(native.decisions).toEqual([])
    expect(native.guidanceBodies).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 0,
    })
  })

  it('consults once at the first owner response and keeps the default on a null selection', async () => {
    const f = await fixture()
    enableRelay(f, 1)
    expect((await f.flow.send(f.input('/plan Preserve the complete original goal.'))).ok).toBe(true)
    await completedPlanRevision(f, 1)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(2))
    expect(f.flow.getSchedulingSettings()).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        provider: 'openai',
        model: OPENAI_DECISION_MODEL,
        credential: { configured: true },
      },
    })
    expect(native.decisions).toHaveLength(2)
    expect(native.decisions[0]!.candidates.map((candidate) => candidate.id)).toEqual([
      'propose_supplement_plan',
    ])
    expect(native.decisions[1]!.candidates.map((candidate) => candidate.id)).toEqual([
      'propose_reassign_roles',
    ])
    expect(native.guidanceBodies).toEqual([])
    expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 2,
    })
  })

  it('consults only a real alternative and keeps the complete default workflow without generated focus', async () => {
    const f = await fixture()
    enableRelay(f)
    expect(f.flow.getSchedulingSettings()).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        provider: 'openai',
        model: OPENAI_DECISION_MODEL,
        credential: { configured: true },
      },
    })
    const consultation = Promise.withResolvers<void>()
    native.decisionHold = consultation.promise
    const goal = 'Keep the complete original goal and final acceptance.\n'.repeat(120)
    expect((await f.flow.send(f.input(`/plan ${goal}`))).ok).toBe(true)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    // The owner->review handoff holds the first real consult at the third input.
    expect(native.inputs).toHaveLength(3)
    expect(decisionsForProducer(native.inputs[0]!.runId)).toEqual([])
    expect(decisionsForProducer(native.inputs[1]!.runId)).toEqual([])
    const reviewDecisions = decisionsForProducer(native.inputs[2]!.runId)
    expect(reviewDecisions).toHaveLength(1)
    expect(reviewDecisions[0]!.candidates.map((candidate) => candidate.id)).toEqual([
      'propose_supplement_plan',
    ])
    consultation.resolve()
    const task = await completedPlanRevision(f)
    expect(native.decisions).toHaveLength(2)
    expect(native.inputs).toHaveLength(6)
    expect(
      f.db.drizzle.get(
        sql`SELECT count(*) AS count FROM collaboration_action_receipts WHERE action='supplement_plan'`,
      ),
    ).toEqual({ count: 0 })
    expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(native.decisions[0]!.sources.some((source) => source.text.includes(goal.trim()))).toBe(
      true,
    )
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
      'plan',
      'plan_review',
      'plan',
      'plan_review',
      'plan',
      'plan_review',
    ])
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.actor)).toEqual([
      'codex',
      'claude',
      'codex',
      'claude',
      'codex',
      'claude',
    ])
    expect(native.guidanceBodies).toEqual([])
    for (const input of native.inputs)
      expect(input.promptEnvelope.collaborationAuthorization?.sourceManifestRef).toBeUndefined()
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 2,
    })
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 6 })
    expect(f.db.conversationRepository.schedulingBudget(`task:${task.id}`)?.extraPlanTurns).toBe(0)
  })

  it.each([null, 'unsupported_candidate'] as const)(
    'keeps recommendation %s separate from the original revision Run',
    async (candidate) => {
      const f = await fixture()
      enableRelay(f)
      native.decisionCandidate = candidate
      expect(
        (await f.flow.send(f.input('/plan Continue after an undecided auxiliary result.'))).ok,
      ).toBe(true)
      await completedPlanRevision(f, 2, 5_000)
      // Abstention and failure both preserve the default and permit distinct later handoffs.
      const expectedConsults = 3
      await vi.waitFor(() => expect(native.decisions).toHaveLength(expectedConsults))
      expect(new Set(native.decisions.map((input) => input.handoff.id)).size).toBe(expectedConsults)
      expect(
        native.decisions.filter((input) => input.candidates[0]?.id === 'propose_reassign_roles'),
      ).toHaveLength(1)
      expect(native.guidanceBodies).toEqual([])
      for (const input of native.inputs)
        expect(input.promptEnvelope.collaborationAuthorization?.sourceManifestRef).toBeUndefined()
      expect(f.db.drizzle.all(sql`SELECT called,outcome FROM scheduling_evaluations`)).toEqual(
        // The fixture abstains from role reassignment even when its earlier choices are invalid.
        (candidate === null
          ? ['completed', 'completed', 'completed']
          : ['failed', 'failed', 'completed']
        ).map((outcome) => ({ called: 1, outcome })),
      )
    },
  )

  it('lets manual Continue claim the same handoff while consultation is pending and discards late advice', async () => {
    const f = await fixture()
    enableRelay(f)
    const hold = Promise.withResolvers<void>()
    native.decisionHold = hold.promise
    expect((await f.flow.send(f.input('/plan Keep the manual continuation responsive.'))).ok).toBe(
      true,
    )
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1), { timeout: 5_000 })
    const task = f.db.conversationRepository.collaboration(f.sessionId)!
    const handoffId = native.decisions[0]!.handoff.id
    expect(native.inputs).toHaveLength(3)
    expect(native.decisions[0]!.handoff.freshnessGuard.runId).toBe(native.inputs[2]!.runId)
    const result = await f.flow.actOnCollaboration({
      sessionId: f.sessionId,
      taskId: task.id,
      revision: task.revision,
      clientMessageId: randomUUID(),
      action: 'continue',
    })
    expect(result.ok).toBe(true)
    hold.resolve()
    await completedPlanRevision(f, 2, 5_000)
    expectNoRepeatedConsultation(handoffId)
    expect(native.guidanceBodies).toEqual([])
    expect(
      native.inputs[3]!.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
    ).toBeUndefined()
    expect(
      f.db.drizzle.get(sql`SELECT run_id FROM scheduling_handoffs WHERE id = ${handoffId}`),
    ).toEqual({ run_id: native.inputs[3]!.runId })
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 6 })
    expect(
      f.db.drizzle.get(
        sql`SELECT count(*) AS count FROM scheduling_evaluations WHERE handoff_id = ${handoffId}`,
      ),
    ).toEqual({
      count: 1,
    })
  })

  it('does not start another owner Run while automatic wakes share a pending consultation', async () => {
    const f = await fixture()
    enableRelay(f)
    const hold = Promise.withResolvers<void>()
    native.decisionHold = hold.promise
    expect((await f.flow.send(f.input('/plan Keep one consultation per handoff.'))).ok).toBe(true)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    await new Promise<void>((done) => setTimeout(done, 30))
    const handoffId = native.decisions[0]!.handoff.id
    expect(native.inputs).toHaveLength(3)
    expect(native.decisions).toHaveLength(1)
    hold.resolve()
    await completedPlanRevision(f)
    expectNoRepeatedConsultation(handoffId)
    expect(native.guidanceBodies).toEqual([])
  })

  it.each(['succeeds', 'fails', 'is cancelled'] as const)(
    'yields to manual Continue whose preparation %s after consultation ends',
    async (outcome) => {
      const f = await fixture()
      enableRelay(f)
      const decision = Promise.withResolvers<void>()
      native.decisionHold = decision.promise
      expect((await f.flow.send(f.input('/plan Preserve the manual Continue claim.'))).ok).toBe(
        true,
      )
      await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
      const handoffId = native.decisions[0]!.handoff.id
      const task = f.db.conversationRepository.collaboration(f.sessionId)!
      const entered = Promise.withResolvers<void>(),
        preparation = Promise.withResolvers<void>()
      const ready = await f.preparation.inspectReadiness()
      vi.spyOn(f.preparation, 'inspectReadiness').mockImplementationOnce(async () => {
        entered.resolve()
        await preparation.promise
        return outcome === 'fails'
          ? {
              ok: false,
              error: { code: 'RUNTIME_UNAVAILABLE', message: 'Controlled readiness failure.' },
            }
          : ready
      })
      const manual = f.flow.actOnCollaboration({
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: randomUUID(),
        action: 'continue',
      })
      try {
        await entered.promise
        decision.resolve()
        await vi.waitFor(() =>
          expect(
            f.db.drizzle.get(
              sql`SELECT outcome FROM scheduling_evaluations WHERE handoff_id = ${handoffId}`,
            ),
          ).toEqual({
            outcome: 'completed',
          }),
        )
        await new Promise<void>((done) => setImmediate(done))
        expect(f.db.conversationRepository.collaboration(f.sessionId)).toMatchObject({
          revision: task.revision,
          automation: 'active',
        })
        expect(native.inputs).toHaveLength(3)
        const cancellation =
          outcome === 'is cancelled' ? f.flow.stop({ sessionId: f.sessionId }) : undefined
        expect(cancellation?.ok ?? true).toBe(true)
        preparation.resolve()
        const result = await manual
        expect(result.ok).toBe(outcome === 'succeeds')
        const settled =
          outcome === 'is cancelled' ? await f.settled() : await completedPlanRevision(f)
        expect(settled).toMatchObject(
          outcome === 'is cancelled'
            ? { automation: 'paused', pauseReason: 'stopped' }
            : { status: 'ready' },
        )
        expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual(
          outcome === 'is cancelled'
            ? ['plan', 'plan_review', 'plan']
            : ['plan', 'plan_review', 'plan', 'plan_review', 'plan', 'plan_review'],
        )
        expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({
          count: outcome === 'is cancelled' ? 3 : 6,
        })
        expectNoRepeatedConsultation(handoffId)
        expect(native.guidanceBodies).toEqual([])
        expect(
          native.inputs[3]?.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
        ).toBeUndefined()
        expect(
          f.db.drizzle.get(sql`SELECT run_id FROM scheduling_handoffs WHERE id = ${handoffId}`),
        ).toEqual({ run_id: native.inputs[3]?.runId ?? null })
        expect(
          f.db.drizzle.get(
            sql`SELECT count(*) AS count FROM scheduling_evaluations WHERE handoff_id = ${handoffId}`,
          ),
        ).toEqual({
          count: 1,
        })
        expect(f.db.conversationRepository.activeEvaluation()).toBeUndefined()
      } finally {
        decision.resolve()
        preparation.resolve()
        await manual
      }
    },
  )

  it('skips excessive complete auxiliary input while keeping the original plan revision available', async () => {
    const f = await fixture()
    enableRelay(f)
    const goal = 'The durable original objective remains complete.\n'.repeat(3200)
    expect((await f.flow.send(f.input(`/plan ${goal}`))).ok).toBe(true)
    // All six full-source stages share the test's existing five-second total deadline.
    await completedPlanRevision(f, 2, 5_000)
    expect(native.decisions).toEqual([])
    expect(native.guidanceBodies).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 0,
    })
    expect(
      native.sources.some(
        (source) => source.sha256 === createHash('sha256').update(`/plan ${goal}`).digest('hex'),
      ),
    ).toBe(true)
  })

  it('keeps the frozen Comment target with its original recipient without new manifest grants', async () => {
    const f = await fixture()
    const oldPlan = 'Frozen original v1 Plan.'
    native.next = { plan: oldPlan }
    expect((await f.flow.send(f.input('/plan Preserve the original source grant.'))).ok).toBe(true)
    const original = (await f.settled()).planReference!
    const commentId = randomUUID()
    expect(
      (
        await f.flow.saveCommentDraft({
          mode: 'create',
          sessionId: f.sessionId,
          commentId,
          expectedCommentsRevision: f.input('').expectedCommentsRevision,
          body: 'Check this frozen v1 Plan.',
          anchor: {
            type: 'message',
            messageId: original.sourceMessageId,
            plan: { runId: original.sourceRunId, version: original.version },
            contentHash: original.document.sha256,
            textBasis: 'markdown-visible-v2',
            startOffset: 0,
            endOffset: 6,
            quote: 'Frozen',
          },
        })
      ).ok,
    ).toBe(true)
    native.next = { plan: 'Current v2 Plan.' }
    expect(
      (await f.flow.send({ ...f.input('Revise after this Comment.'), commentIds: [commentId] })).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    await f.settled()
    enableRelay(f)
    await f.act('resume')
    await vi.waitFor(() => {
      expect(native.inputs).toHaveLength(8)
      expect(f.db.conversationRepository.collaboration(f.sessionId)?.status).toBe('ready')
    })
    await f.settled()
    expect(native.inputs[6]!.promptEnvelope.collaboration?.actor).toBe('codex')
    expect(native.inputs[6]!.promptEnvelope.collaboration?.stage).toBe('plan')
    expect(
      f.db.conversationRepository.sourceDocumentAuthorized(
        native.inputs[6]!.runId,
        original.document,
      ),
    ).toBe(false)
    // The sole processed-input handoff has no real alternative; no consult runs at all.
    expect(native.decisions).toHaveLength(0)
    expect(native.guidanceBodies).toEqual([])
    // The frozen v1 remains authorized only for its original recipient, not the later review.
    expect(
      f.db.conversationRepository.sourceDocumentAuthorized(
        native.inputs[2]!.runId,
        original.document,
      ),
    ).toBe(true)
    expect(
      f.db.conversationRepository.sourceDocumentAuthorized(
        native.inputs[3]!.runId,
        original.document,
      ),
    ).toBe(false)
    expect(
      native.inputs[3]!.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
    ).toBeUndefined()
    expect(
      native.inputs[6]!.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
    ).toBeUndefined()
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
      count: 0,
    })
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 8 })
  })

  it('cancels a pending consultation on Pause without starting the old continuation or refunding its call', async () => {
    const f = await fixture()
    enableRelay(f)
    const hold = Promise.withResolvers<void>()
    native.decisionHold = hold.promise
    expect((await f.flow.send(f.input('/plan Pause must invalidate pending focus.'))).ok).toBe(true)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    const task = f.db.conversationRepository.collaboration(f.sessionId)!
    expect(
      (
        await f.flow.actOnCollaboration({
          sessionId: f.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: randomUUID(),
          action: 'pause',
        })
      ).ok,
    ).toBe(true)
    hold.resolve()
    await vi.waitFor(() => expect(f.db.conversationRepository.activeEvaluation()).toBeUndefined())
    expect(f.db.conversationRepository.collaboration(f.sessionId)?.automation).toBe('paused')
    expect(native.inputs).toHaveLength(3)
    expect(native.guidanceBodies).toEqual([])
    expect(f.db.drizzle.get(sql`SELECT called,outcome FROM scheduling_evaluations`)).toEqual({
      called: 1,
      outcome: 'failed',
    })
  })

  it('drops enable ABA advice and recomputes the original workflow without replaying that handoff', async () => {
    const f = await fixture()
    enableRelay(f)
    const hold = Promise.withResolvers<void>()
    native.decisionHold = hold.promise
    const decisionStarted = Promise.withResolvers<DecisionInput>()
    native.decisionStarted = decisionStarted.resolve
    try {
      expect(
        (await f.flow.send(f.input('/plan Retain semantic configuration generation.'))).ok,
      ).toBe(true)
      // Observe the consultation itself; preceding workflow Turns share the test's deadline.
      const decision = await decisionStarted.promise
      expect(native.decisions).toHaveLength(1)
      const handoffId = decision.handoff.id
      const repository = f.db.conversationRepository
      let settings = repository.schedulingSettings()
      settings = repository.saveSchedulingSettings({
        expectedRevision: settings.revision,
        enabled: false,
      })
      repository.saveSchedulingSettings({ expectedRevision: settings.revision, enabled: true })
      hold.resolve()
      await completedPlanRevision(f)
      expectNoRepeatedConsultation(handoffId)
      expect(native.guidanceBodies).toEqual([])
      expect(
        native.inputs[3]!.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
      ).toBeUndefined()
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM scheduling_evaluations WHERE handoff_id = ${handoffId}`,
        ),
      ).toEqual({
        count: 1,
      })
    } finally {
      hold.resolve()
    }
  })
})

async function repairDecisionFlow(primary: RuntimeAgentId, candidate: 'propose_repair' | null) {
  const f = await fixture(primary)
  native.nextReview = { verdict: 'changes_requested' }
  expect(
    (await f.flow.send(f.input('/build Repair only the complete current cancellation scope.'))).ok,
  ).toBe(true)
  await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
  await f.settled()
  expect(native.decisions).toEqual([])
  enableRelaySettings(f)
  native.decisionCandidate = candidate
  native.nextReview = { verdict: 'changes_requested' }
  await f.act('respond')
  await vi.waitFor(() => {
    expect(native.inputs).toHaveLength(4)
    expect(native.decisions).toHaveLength(1)
  })
  await f.settled()
  return f
}

describe('Grounded Repair decisions through the existing Conversation owner', () => {
  it.each(['codex', 'claude'] as const)(
    'requires a fresh Secondary repair grant and returns to Primary code review when Primary is %s',
    async (primary) => {
      const f = await repairDecisionFlow(primary, 'propose_repair'),
        repo = f.db.conversationRepository,
        before = repo.collaboration(f.sessionId)!,
        card = repo.relaySchedulingDecision(f.sessionId)!
      expect(before).toMatchObject({
        stage: 'code_review',
        status: 'waiting',
        repairAttempts: 0,
        reviewCycles: 2,
      })
      expect(native.decisions[0]!.candidates.map(({ id }) => id)).toEqual([
        'propose_supplement_code_response',
        'propose_repair',
      ])
      expect(card.request).toMatchObject({
        category: 'new_authorization',
        operation: {
          kind: 'repair',
          actor: primary === 'codex' ? 'claude' : 'codex',
          returnActor: primary,
          afterRunId: before.runId,
        },
      })
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM collaboration_action_receipts WHERE action='repair'`,
        ),
      ).toEqual({ count: 0 })
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM scheduling_budget_reservations WHERE budget='extra_code_turn'`,
        ),
      ).toEqual({ count: 0 })
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
        'implement',
        'code_review',
        'respond',
        'code_review',
      ])
      const answer = {
        reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
        clientOperationId: randomUUID(),
        answer: { kind: 'confirm' as const },
      }
      const hold = Promise.withResolvers<void>()
      native.hold = hold.promise
      const accepted = await f.flow.answerRelayDecision(answer)
      try {
        await vi.waitFor(() => expect(native.inputs).toHaveLength(5))
        expect(accepted).toMatchObject({
          ok: true,
          value: { disposition: 'confirmed', runId: native.inputs[4]!.runId },
        })
        expect(native.decisions).toHaveLength(1)
        expect(repo.schedulingBudget(`task:${before.id}`)).toMatchObject({
          extraCodeTurns: 1,
          evaluationCalls: 1,
        })
        expect(await f.flow.answerRelayDecision(answer)).toEqual(accepted)
        expect(
          await f.flow.answerRelayDecision({ ...answer, clientOperationId: randomUUID() }),
        ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
        expect(native.inputs).toHaveLength(5)
        expect(native.decisions).toHaveLength(1)
      } finally {
        native.decisionCandidate = null
        native.hold = undefined
        hold.resolve()
      }
      await vi.waitFor(() => expect(native.inputs).toHaveLength(6))
      const completed = await f.settled(),
        repair = native.inputs[4]!,
        fixedReview = native.inputs[5]!
      expect(repair.promptEnvelope.collaboration).toMatchObject({
        stage: 'repair',
        actor: primary === 'codex' ? 'claude' : 'codex',
        reviewScopeRef: before.reviewScopeRef,
      })
      expect(repair.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
        purpose: 'action',
      })
      expect(repair.promptEnvelope.collaborationAuthorization?.relayWorkRef).toBeDefined()
      expect(
        collaborationReadOnly(
          repair.promptEnvelope.collaboration,
          repair.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(false)
      expect(fixedReview.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
      expect(
        collaborationReadOnly(
          fixedReview.promptEnvelope.collaboration,
          fixedReview.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(true)
      expect(completed).toMatchObject({
        id: before.id,
        status: 'complete',
        repairAttempts: 1,
        reviewCycles: 3,
      })
      expect(repo.schedulingBudget(`task:${before.id}`)).toMatchObject({
        extraCodeTurns: 1,
        evaluationCalls: 1,
      })
      // The fixed review needs no model call; answer readback does not re-evaluate the original handoff.
      expect(
        native.decisions.map((decision) => ({
          producer: decision.handoff.freshnessGuard.runId,
          candidates: decision.candidates.map(({ id }) => id),
        })),
      ).toEqual([
        {
          producer: before.runId,
          candidates: ['propose_supplement_code_response', 'propose_repair'],
        },
      ])
      expect(new Set(native.decisions.map((decision) => decision.handoff.id)).size).toBe(1)
      expect(await f.flow.answerRelayDecision(answer)).toEqual(accepted)
      expect(
        f.flow.getRelayDecisionReceipt({
          sessionId: f.sessionId,
          decisionId: card.decisionId,
          clientOperationId: answer.clientOperationId,
        }),
      ).toEqual(accepted)
      expect(
        await f.flow.answerRelayDecision({ ...answer, clientOperationId: randomUUID() }),
      ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(native.inputs).toHaveLength(6)
      expect(native.decisions).toHaveLength(1)
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM collaboration_action_receipts WHERE action='repair'`,
        ),
      ).toEqual({ count: 1 })
    },
  )

  it.each(['no recommendation', 'cancel'] as const)(
    'preserves the original zero-extra-Turn path after %s',
    async (choice) => {
      const f = await repairDecisionFlow('codex', choice === 'cancel' ? 'propose_repair' : null),
        repo = f.db.conversationRepository,
        before = repo.collaboration(f.sessionId)!
      if (choice === 'cancel') {
        const card = repo.relaySchedulingDecision(f.sessionId)!
        await f.flow.answerRelayDecision({
          reference: {
            sessionId: f.sessionId,
            decisionId: card.decisionId,
            revision: card.revision,
          },
          clientOperationId: randomUUID(),
          answer: { kind: 'cancel' },
        })
      }
      const current = await f.settled()
      expect(current).toMatchObject({
        id: before.id,
        runId: before.runId,
        stage: 'code_review',
        repairAttempts: 0,
        reviewCycles: 2,
        automation: choice === 'cancel' ? 'paused' : 'active',
      })
      expect(current.pauseReason).toBe(choice === 'cancel' ? 'user' : undefined)
      const resumed =
        choice === 'cancel'
          ? advanceCollaboration(
              current,
              'resume',
              f.db.sessionRepository.find(f.sessionId)!.settings,
            )
          : current
      expect(collaborationAvailableActions(resumed)).toEqual(
        expect.arrayContaining(['respond', 'repair']),
      )
      expect(native.inputs).toHaveLength(4)
      expect(native.decisions).toHaveLength(1)
      expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(repo.schedulingBudget(`task:${before.id}`)).toMatchObject({
        extraCodeTurns: 0,
        evaluationCalls: 1,
      })
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM collaboration_action_receipts WHERE action='repair'`,
        ),
      ).toEqual({ count: 0 })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'consults and admits a repair at the very first review when Primary is %s',
    async (primary) => {
      const f = await fixture(primary)
      enableRelaySettings(f)
      native.decisionCandidate = 'propose_repair'
      native.nextReview = { verdict: 'changes_requested' }
      expect((await f.flow.send(f.input('/build Preserve the current review scope.'))).ok).toBe(
        true,
      )
      await vi.waitFor(() => {
        expect(native.inputs).toHaveLength(2)
        expect(native.decisions).toHaveLength(1)
      })
      await f.settled()
      const repo = f.db.conversationRepository,
        before = repo.collaboration(f.sessionId)!,
        card = repo.relaySchedulingDecision(f.sessionId)!
      expect(before).toMatchObject({
        stage: 'code_review',
        status: 'waiting',
        repairAttempts: 0,
        reviewCycles: 1,
      })
      expect(native.decisions[0]!.candidates.map(({ id }) => id)).toEqual([
        'propose_supplement_code_response',
        'propose_repair',
      ])
      expect(card.request).toMatchObject({
        category: 'new_authorization',
        operation: {
          kind: 'repair',
          actor: primary === 'codex' ? 'claude' : 'codex',
          returnActor: primary,
          afterRunId: before.runId,
        },
      })
      // The objective records durable progress facts; no synthetic prior review or
      // owner response is manufactured for a first-review consult.
      const envelope = JSON.parse(native.decisions[0]!.objective.split('\n').pop()!)
      expect(envelope.progress).toEqual({
        discussionRounds: 0,
        reviewCycles: 1,
        repairAttempts: 0,
      })
      expect(envelope.reviews).toEqual([])
      expect(envelope.responses).toEqual([])
      const answer = {
        reference: {
          sessionId: f.sessionId,
          decisionId: card.decisionId,
          revision: card.revision,
        },
        clientOperationId: randomUUID(),
        answer: { kind: 'confirm' as const },
      }
      const accepted = await f.flow.answerRelayDecision(answer)
      expect(accepted).toMatchObject({ ok: true, value: { disposition: 'confirmed' } })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
      const completed = await f.settled(),
        repair = native.inputs[2]!,
        fixedReview = native.inputs[3]!
      expect(repair.promptEnvelope.collaboration).toMatchObject({
        stage: 'repair',
        actor: primary === 'codex' ? 'claude' : 'codex',
        reviewScopeRef: before.reviewScopeRef,
      })
      expect(repair.promptEnvelope.collaborationAuthorization?.userAuthority).toMatchObject({
        purpose: 'action',
      })
      expect(
        collaborationReadOnly(
          repair.promptEnvelope.collaboration,
          repair.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(false)
      expect(fixedReview.promptEnvelope.collaboration).toMatchObject({
        stage: 'code_review',
        actor: primary,
      })
      expect(
        collaborationReadOnly(
          fixedReview.promptEnvelope.collaboration,
          fixedReview.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(true)
      expect(completed).toMatchObject({ repairAttempts: 1, reviewCycles: 2 })
      expect(native.decisions).toHaveLength(1)
      expect(
        f.db.drizzle.get(
          sql`SELECT count(*) AS count FROM collaboration_action_receipts WHERE action='repair'`,
        ),
      ).toEqual({ count: 1 })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'keeps the waiting task unchanged when the first-review selection is null for %s',
    async (primary) => {
      const f = await fixture(primary)
      enableRelaySettings(f)
      native.decisionCandidate = null
      native.nextReview = { verdict: 'changes_requested' }
      expect((await f.flow.send(f.input('/build Preserve the current review scope.'))).ok).toBe(
        true,
      )
      await vi.waitFor(() => {
        expect(native.inputs).toHaveLength(2)
        expect(native.decisions).toHaveLength(1)
      })
      const repo = f.db.conversationRepository
      expect(await f.settled()).toMatchObject({
        stage: 'code_review',
        status: 'waiting',
        repairAttempts: 0,
        reviewCycles: 1,
      })
      expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(native.inputs).toHaveLength(2)
      expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM scheduling_evaluations`)).toEqual({
        count: 1,
      })
    },
  )
})

describe('Native workflow admission and durable dispatch', () => {
  it.each(['codex', 'claude'] as const)(
    'dispatches a legacy queued build with its original %s actor after Primary changes',
    async (primary) => {
      const f = await fixture(primary),
        hold = Promise.withResolvers<void>()
      native.hold = hold.promise
      try {
        expect(await f.flow.send(f.input('Finish the original request.'))).toMatchObject({
          ok: true,
        })
        await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
        const request = f.input('/build Preserve the already accepted legacy scope.'),
          owner = randomUUID()
        const body = f.db.conversationRepository.writeConversationInput(
          { type: 'begin', sessionId: f.sessionId, clientMessageId: request.clientMessageId },
          owner,
        )
        f.db.conversationRepository.writeConversationInput(
          {
            type: 'append',
            sessionId: f.sessionId,
            inputId: body.inputId,
            offset: 0,
            text: request.content,
          },
          owner,
        )
        f.db.conversationRepository.writeConversationInput(
          { type: 'seal', sessionId: f.sessionId, inputId: body.inputId },
          owner,
        )
        f.db.conversationRepository.receiveQueuedInput(
          request,
          body.inputId,
          primary,
          owner,
          native.inputs[0]!.runId,
        )
        expect(
          f.db.conversationRepository.readReceivedInput(f.sessionId)?.metadata.rolePolicy,
        ).toBeUndefined()
        f.db.sessionRepository.saveSettings(f.sessionId, {
          ...f.db.sessionRepository.find(f.sessionId)!.settings,
          primaryAgentId: primary === 'codex' ? 'claude' : 'codex',
        })
        native.hold = undefined
        hold.resolve()
        await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
        const task = await f.settled()
        expect(task.rolePolicy).toBeUndefined()
        expect(task.owner).toBe(primary)
        expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe(primary)
        expect(f.db.conversationRepository.findRun(native.inputs[2]!.runId)?.agentId).toBe(
          primary === 'codex' ? 'claude' : 'codex',
        )
      } finally {
        native.hold = undefined
        hold.resolve()
      }
    },
  )

  it.each([
    {
      primary: 'codex',
      kind: 'plan',
      first: 'codex',
      stages: ['plan', 'plan_review'],
      actors: ['codex', 'claude'],
    },
    {
      primary: 'claude',
      kind: 'plan',
      first: 'claude',
      stages: ['plan', 'plan_review'],
      actors: ['claude', 'codex'],
    },
    {
      primary: 'codex',
      kind: 'build',
      first: 'claude',
      stages: ['implement', 'code_review'],
      actors: ['claude', 'codex'],
    },
    {
      primary: 'claude',
      kind: 'build',
      first: 'codex',
      stages: ['implement', 'code_review'],
      actors: ['codex', 'claude'],
    },
    {
      primary: 'codex',
      kind: 'review',
      first: 'codex',
      stages: ['code_review'],
      actors: ['codex'],
    },
    {
      primary: 'claude',
      kind: 'review',
      first: 'claude',
      stages: ['code_review'],
      actors: ['claude'],
    },
  ] as const)(
    'admits only the assigned /$kind recipient when Primary is $primary',
    async ({ primary, kind, first, stages, actors }) => {
      const f = await fixture(primary)
      const wrong = first === 'codex' ? 'claude' : 'codex'
      expect(await f.flow.send(f.input(`@${wrong} /${kind} Verify cancellation`))).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      })
      expect(
        await f.flow.send({
          ...f.input(`/${kind} Verify cancellation`),
          route: { type: 'agent', agentId: wrong },
        }),
      ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(native.inputs).toHaveLength(0)
      expect(f.db.conversationRepository.read(f.sessionId).runs).toHaveLength(0)
      expect(await f.flow.send(f.input(`@${first} /${kind} Verify cancellation`))).toMatchObject({
        ok: true,
      })
      const task = await f.settled()
      expect(task).toMatchObject({ owner: primary, rolePolicy: 'split-stages-v1' })
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual(
        stages,
      )
      expect(
        native.inputs.map((input) => f.db.conversationRepository.findRun(input.runId)?.agentId),
      ).toEqual(actors)
    },
  )

  it.each([
    { primary: 'codex', kind: 'plan', actor: 'codex', count: 2 },
    { primary: 'claude', kind: 'plan', actor: 'claude', count: 2 },
    { primary: 'codex', kind: 'build', actor: 'claude', count: 2 },
    { primary: 'claude', kind: 'build', actor: 'codex', count: 2 },
    { primary: 'codex', kind: 'review', actor: 'codex', count: 1 },
    { primary: 'claude', kind: 'review', actor: 'claude', count: 1 },
  ] as const)(
    'preserves accepted queued /$kind roles after Primary $primary changes',
    async ({ primary, kind, actor, count }) => {
      const f = await fixture(primary),
        hold = Promise.withResolvers<void>()
      native.hold = hold.promise
      try {
        expect(await f.flow.send(f.input('Finish the current ordinary request.'))).toMatchObject({
          ok: true,
        })
        await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
        expect(
          await f.flow.send(f.input(`/${kind} Verify the queued cancellation scope.`)),
        ).toMatchObject({ ok: true })
        expect(f.db.conversationRepository.readReceivedInput(f.sessionId)).toMatchObject({
          actor,
          metadata: { rolePolicy: 'split-stages-v1', workflowCommand: true },
        })
        f.db.sessionRepository.saveSettings(f.sessionId, {
          ...f.db.sessionRepository.find(f.sessionId)!.settings,
          primaryAgentId: primary === 'codex' ? 'claude' : 'codex',
        })
        native.hold = undefined
        hold.resolve()
        await vi.waitFor(() => expect(native.inputs).toHaveLength(count + 1))
        const task = await f.settled()
        expect(task).toMatchObject({ owner: primary, rolePolicy: 'split-stages-v1' })
        expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe(actor)
        expect(f.db.conversationRepository.readReceivedInput(f.sessionId)).toBeUndefined()
      } finally {
        native.hold = undefined
        hold.resolve()
      }
    },
  )

  it('rereads current source ownership and document facts across rollback and Stop', async () => {
    const f = await fixture('codex', false, true)
    native.next = { plan: 'Authoritative source.\n'.repeat(700) }
    expect((await f.flow.send(f.input('/plan Verify current source authorization'))).ok).toBe(true)
    await f.settled()
    const task = f.db.conversationRepository.collaboration(f.sessionId)!
    native.hold = Promise.withResolvers<void>().promise
    expect(
      await f.flow.actOnCollaboration({
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: randomUUID(),
        action: 'execute',
      }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    const input = native.inputs[2]!,
      actor = input.promptEnvelope.collaboration!.actor,
      document = input.promptEnvelope.collaboration!.planReference!.document,
      grant = input.promptEnvelope.sourceGrant!,
      reader = input.readCollaborationSourcePart!
    const first = reader({ ...grant, document, offset: 0 })
    expect(first.nextOffset).toBe(4096)
    const before = f.db.performanceDiagnostics()!.sqlite.operations
    const next = reader({ ...grant, document, offset: 4096 })
    expect(next.text).toBe('Authoritative source.\n'.repeat(700).slice(4096, 8192))
    expect(reader({ ...grant, document, offset: 8192 }).text).toBeTruthy()
    expect(f.db.performanceDiagnostics()!.sqlite.operations).toBeGreaterThan(before)
    expect(() => reader({ ...grant, grant: randomUUID(), document, offset: 0 })).toThrow(
      /capability/u,
    )
    expect(() => reader({ ...grant, runId: native.inputs[0]!.runId, document, offset: 0 })).toThrow(
      /capability/u,
    )
    for (const changed of [
      { id: randomUUID() },
      { sha256: '0'.repeat(64) },
      { chars: document.chars + 1 },
      { bytes: document.bytes + 1 },
    ])
      expect(() => reader({ ...grant, document: { ...document, ...changed }, offset: 0 })).toThrow(
        /outside this Run authorization|immutable source does not match/u,
      )
    expect(() =>
      f.db.drizzle.transaction((transaction) => {
        transaction
          .update(conversationBodyInputs)
          .set({ sealed: false })
          .where(eq(conversationBodyInputs.id, document.id))
          .run()
        expect(() => reader({ ...grant, document, offset: 4096 })).toThrow(
          /outside this Run authorization|immutable source does not match/u,
        )
        throw new Error('rollback-source-fixture')
      }),
    ).toThrow('rollback-source-fixture')
    expect(reader({ ...grant, document, offset: 4096 }).text).toBe(next.text)
    expect(f.db.conversationRepository.nativeContext(f.sessionId, actor)?.bindingGeneration).toBe(1)
    expect(() =>
      f.db.drizzle.transaction((transaction) => {
        transaction
          .update(nativeAgentContexts)
          .set({ bindingGeneration: 2 })
          .where(eq(nativeAgentContexts.sessionId, f.sessionId))
          .run()
        expect(() => reader({ ...grant, document, offset: 4096 })).toThrow(/retired Turn/u)
        throw new Error('rollback-binding-fixture')
      }),
    ).toThrow('rollback-binding-fixture')
    expect(reader({ ...grant, document, offset: 4096 }).text).toBe(next.text)
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    expect(() => reader({ ...grant, document, offset: 8192 })).toThrow(/retired Turn/u)
    await f.flow.dispose()
    f.db.close()
    expect(() => f.db.conversationRepository.findRun(input.runId)).toThrow(/not open/u)
  })

  it.each(['codex', 'claude'] as const)(
    'plans with Primary %s, reviews with Secondary, then explicitly implements with Secondary and reviews code with Primary',
    async (primary) => {
      const f = await fixture(primary, true)
      expect((await f.flow.send(f.input('/plan Implement cancellation'))).ok).toBe(true)
      expect(await f.settled()).toMatchObject({
        status: 'ready',
        owner: primary,
        rolePolicy: 'split-stages-v1',
        stage: 'plan_review',
      })
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
        'plan',
        'plan_review',
      ])
      expect(
        native.inputs.every((input) =>
          collaborationReadOnly(
            input.promptEnvelope.collaboration,
            input.promptEnvelope.collaborationAuthorization,
          ),
        ),
      ).toBe(true)
      expect(await f.act('execute')).toMatchObject({ status: 'complete', stage: 'code_review' })
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
        'plan',
        'plan_review',
        'implement',
        'code_review',
      ])
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.actor)).toEqual([
        primary,
        primary === 'codex' ? 'claude' : 'codex',
        primary === 'codex' ? 'claude' : 'codex',
        primary,
      ])
      expect(collaborationReadOnly(native.inputs[2]!.promptEnvelope.collaboration)).toBe(false)
    },
  )
  it(
    'preserves complete 9 MiB native plans in bounded source pages',
    async () => {
      const f = await fixture(),
        plan = '## Scope\n\n' + 'x'.repeat(9 * 1024 * 1024) + '\nTrue tail.'
      native.next = { plan }
      expect((await f.flow.send(f.input('/plan Preserve complete source'))).ok).toBe(true)
      const task = await f.settled()
      expect(task.status).toBe('ready')
      expect(task.planReference?.document.chars).toBe(plan.length)
      expect(native.inputs).toHaveLength(2)
      expect(Buffer.byteLength(JSON.stringify(native.inputs[1]!.promptEnvelope))).toBeLessThan(
        48 * 1024,
      )
      expect(
        native.sources.find((source) => source.id === task.planReference?.document.id),
      ).toMatchObject({
        chars: plan.length,
        sha256: createHash('sha256').update(plan).digest('hex'),
      })
      expect(native.sources.every((source) => source.largestReply < 48 * 1024)).toBe(true)
    },
    process.platform === 'win32' ? 60_000 : 15_000,
  )
  it('binds decision replies to the current question and keeps continuation paused after answering', async () => {
    const f = await fixture('claude')
    native.next = {
      input: {
        outcome: 'needs_user',
        questions: [
          {
            prompt: 'Which scope?',
            selection: 'single',
            options: [{ label: 'File' }, { label: 'Module' }],
          },
        ],
      },
    }
    expect((await f.flow.send(f.input('/plan'))).ok).toBe(true)
    const asked = await f.settled(),
      decision = asked.inputProcessing!.decision!
    expect(asked).toMatchObject({ status: 'questions', automation: 'paused', actor: 'claude' })
    expect(decision.questions?.[0]).toMatchObject({
      id: 'q1',
      options: [
        { id: 'o1', label: 'File' },
        { id: 'o2', label: 'Module' },
      ],
    })
    const replyToDecision = {
      taskId: asked.id,
      runId: decision.runId,
      decisionInputSequence: decision.inputSequence,
      expectedInputSequence: asked.inputSequence,
    }
    expect(
      await f.flow.send({
        ...f.input('File'),
        freezeDrafts: false,
        replyToDecision: { ...replyToDecision, runId: randomUUID() },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(native.inputs).toHaveLength(1)
    const response = await f.flow.send({ ...f.input('File'), freezeDrafts: false, replyToDecision })
    if (!response.ok) throw Error(JSON.stringify(response.error))
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const answered = await f.settled()
    expect(answered).toMatchObject({
      automation: 'paused',
      stage: 'reply',
      actor: 'claude',
      planVersion: 1,
    })
    expect(answered.inputProcessing?.decision).toBeUndefined()
    expect(native.inputs).toHaveLength(2)
    expect(collaborationReadOnly(native.inputs[1]!.promptEnvelope.collaboration)).toBe(true)
    expect(
      await f.flow.send({ ...f.input('Module'), freezeDrafts: false, replyToDecision }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect((await f.act('resume')).status).toBe('ready')
    expect(native.inputs).toHaveLength(3)
  })
  it.each(['claude', 'codex'] as const)(
    'routes %s plan reviewer decisions to the actual reviewer and returns to the owner only after Continue',
    async (owner) => {
      const f = await fixture(owner)
      const reviewer = owner === 'claude' ? 'codex' : 'claude'
      native.nextReview = {
        verdict: 'needs_user',
        questions: [
          {
            prompt: 'Which scope?',
            selection: 'single',
            options: [{ label: 'File' }, { label: 'Module' }],
          },
        ],
      }
      expect((await f.flow.send(f.input('/plan Confirm scope with the reviewer'))).ok).toBe(true)
      const asked = await f.settled()
      expect(asked).toMatchObject({
        stage: 'plan_review',
        actor: reviewer,
        status: 'questions',
        automation: 'paused',
      })
      const decision = asked.inputProcessing!.decision!
      expect(decision.actor).toBe(reviewer)
      const answer = {
        ...f.input('Use the current file.'),
        freezeDrafts: false,
        replyToDecision: {
          taskId: asked.id,
          runId: decision.runId,
          decisionInputSequence: decision.inputSequence,
          expectedInputSequence: asked.inputSequence,
        },
      }
      expect(await f.flow.send(answer)).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
      const replied = await f.settled(),
        input = native.inputs[2]!
      expect(replied).toMatchObject({
        stage: 'reply',
        actor: reviewer,
        automation: 'paused',
        status: 'waiting',
        planVersion: 1,
      })
      expect(replied.inputProcessing).toEqual({ settled: { runId: input.runId, inputSequence: 2 } })
      expect(replied.planReference).toEqual(asked.planReference)
      expect(replied.planInputSequence).toBe(1)
      expect(input.promptEnvelope.collaborationAuthorization?.actor).toBe(reviewer)
      expect(
        collaborationReadOnly(
          input.promptEnvelope.collaboration,
          input.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(true)
      expect(
        collaborationPlanMode(
          input.promptEnvelope.collaboration,
          input.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(false)
      expect(
        collaborationInputResultRequired(
          input.promptEnvelope.collaboration,
          input.promptEnvelope.collaborationAuthorization,
        ),
      ).toBe(true)
      expect(await f.flow.send(answer)).toMatchObject({ ok: true })
      expect(native.inputs).toHaveLength(3)
      await f.act('resume')
      // The bounded workflow scan yields before its mandatory return review starts.
      await vi.waitFor(() =>
        expect(f.db.conversationRepository.collaboration(f.sessionId)?.status).toBe('ready'),
      )
      expect(native.inputs.map((value) => value.promptEnvelope.collaboration?.stage)).toEqual([
        'plan',
        'plan_review',
        'reply',
        'plan',
        'plan_review',
      ])
      expect(native.inputs.map((value) => value.promptEnvelope.collaboration?.actor)).toEqual([
        owner,
        reviewer,
        reviewer,
        owner,
        reviewer,
      ])
    },
  )
  it('receives a user message during a native turn once and pauses automatic peer dispatch', async () => {
    const f = await fixture(),
      held = Promise.withResolvers<void>()
    native.hold = held.promise
    expect((await f.flow.send(f.input('/build Implement cancellation'))).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    const send = f.input('Include restart handling')
    expect(await f.flow.send(send)).toMatchObject({
      ok: true,
      value: { receivedInputIds: [send.clientMessageId] },
    })
    expect(await f.flow.send(send)).toMatchObject({ ok: true })
    native.hold = undefined
    held.resolve()
    const task = await f.settled()
    expect(native.inputs).toHaveLength(2)
    expect(native.inputs[1]!.promptEnvelope.message).toMatchObject({
      id: send.clientMessageId,
      content: send.content,
    })
    expect(task).toMatchObject({ automation: 'paused', stage: 'reply' })
    expect(await f.act('resume')).toMatchObject({ stage: 'code_review', status: 'complete' })
    expect(native.inputs).toHaveLength(3)
  })
  it('rejects stale actions and keeps missing native plans failed without inventing questions or a document', async () => {
    const f = await fixture()
    native.next = { plan: null }
    expect((await f.flow.send(f.input('/plan Inspect cancellation'))).ok).toBe(true)
    const failed = await f.settled()
    expect(failed).toMatchObject({ status: 'failed', automation: 'paused' })
    expect(failed.inputProcessing?.decision).toBeUndefined()
    expect(f.db.conversationRepository.needsWorkflowPlanRecovery(failed.runId)).toBe(false)
    expect(failed.planReference).toBeUndefined()
    expect(native.inputs).toHaveLength(1)
    expect(
      await f.flow.actOnCollaboration({
        sessionId: f.sessionId,
        taskId: failed.id,
        revision: failed.revision - 1,
        clientMessageId: randomUUID(),
        action: 'retry',
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(native.inputs).toHaveLength(1)
  })
  it.each([true, false])(
    'restores the original owner reply without dispatch and requires its actual pending identity: %s',
    async (pendingPresent) => {
      const f = await fixture('codex')
      expect((await f.flow.send(f.input('/plan Preserve recovery authority'))).ok).toBe(true)
      await f.settled()
      native.next = { plan: null }
      expect(
        (await f.flow.send(f.input('Confirm the plan with this additional requirement.'))).ok,
      ).toBe(true)
      await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
      const failed = await f.settled()
      expect(failed).toMatchObject({ stage: 'reply', status: 'failed', automation: 'paused' })
      const repository = f.db.conversationRepository
      const originalRun = repository.findRun(failed.runId)!
      const originalMessage = repository.internalMessage(
        originalRun.responseMessageId!,
        f.sessionId,
      )
      repository.recordWorkflowPlanUnavailable(failed.runId)
      if (!pendingPresent) {
        const current = repository.collaboration(f.sessionId)!
        repository.setCollaborationState({
          ...current,
          inputProcessing: {},
          revision: current.revision + 1,
        })
      }
      repository.recordWorkflowPlan(failed.runId, {
        nativeId: 'recovered-original-plan',
        text: 'Recovered original plan with the supplied requirement.',
      })
      const restore = async () => {
        const task = repository.collaboration(f.sessionId)!
        return f.flow.actOnCollaboration({
          sessionId: f.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: randomUUID(),
          action: 'recover_plan',
        })
      }
      const result = await restore()
      expect(result.ok).toBe(pendingPresent)
      const recovered = repository.collaboration(f.sessionId)!
      expect(recovered).toMatchObject({
        planVersion: 2,
        automation: 'paused',
        status: pendingPresent ? 'waiting' : 'failed',
      })
      expect(recovered.inputProcessing?.settled).toEqual(
        pendingPresent ? { runId: failed.runId, inputSequence: failed.inputSequence } : undefined,
      )
      expect(repository.findRun(failed.runId)?.responseMessageId).toBe(
        originalRun.responseMessageId,
      )
      expect(repository.internalMessage(originalRun.responseMessageId!, f.sessionId)).toEqual(
        originalMessage,
      )
      expect(native.inputs).toHaveLength(3)
      const resume = await f.flow.actOnCollaboration({
        sessionId: f.sessionId,
        taskId: recovered.id,
        revision: recovered.revision,
        clientMessageId: randomUUID(),
        action: 'resume',
      })
      expect(resume.ok).toBe(pendingPresent)
      await vi.waitFor(() => expect(native.inputs).toHaveLength(pendingPresent ? 4 : 3))
      await f.settled()
      expect(native.inputs).toHaveLength(pendingPresent ? 4 : 3)
      expect(repository.collaboration(f.sessionId)?.status).toBe(
        pendingPresent ? 'ready' : 'failed',
      )
    },
  )
  it('validates native plan comment ownership, version, hash and quote without retaining forged drafts', async () => {
    const f = await fixture(),
      content = '## Scope\n\nKeep **cancellation ownership** together.'
    native.next = { plan: content }
    expect((await f.flow.send(f.input('/plan Inspect ownership'))).ok).toBe(true)
    const task = await f.settled(),
      ref = task.planReference!,
      projection = markdownVisibleProjection(content)
    const anchor: MessageCommentAnchor = {
      type: 'message',
      messageId: ref.sourceMessageId,
      plan: { runId: ref.sourceRunId, version: ref.version },
      contentHash: createHash('sha256').update(content).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 5,
      quote: projection.slice(0, 5),
    }
    for (const value of [
      { ...anchor, messageId: randomUUID() },
      { ...anchor, plan: { runId: randomUUID(), version: 1 } },
      { ...anchor, plan: { runId: ref.sourceRunId, version: 2 } },
      { ...anchor, contentHash: '0'.repeat(64) },
      { ...anchor, quote: 'wrong' },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each forgery checks that no draft revision was retained.
      const response = await f.flow.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId: randomUUID(),
        expectedCommentsRevision: 0,
        body: 'Invalid reference',
        anchor: value,
      })
      expect(response.ok).toBe(false)
    }
    expect(f.drafts()).toHaveLength(0)
    const commentId = randomUUID()
    expect(
      (
        await f.flow.saveCommentDraft({
          mode: 'create',
          sessionId: f.sessionId,
          commentId,
          expectedCommentsRevision: f.input('').expectedCommentsRevision,
          body: 'Keep this source',
          anchor,
        })
      ).ok,
    ).toBe(true)
    expect(await f.flow.resolveCommentSource(f.sessionId, commentId)).toMatchObject({
      ok: true,
      value: { status: 'resolved', anchor },
    })
    expect(native.inputs).toHaveLength(2)
    native.next = { plan: '## Updated scope\n\nPreserve the newly requested restart contract.' }
    expect(
      await f.flow.send({
        ...f.input('Include restart handling in the plan.'),
        freezeDrafts: false,
      }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    const revised = await f.settled()
    expect(revised.planVersion).toBe(2)
    expect(revised.planReference?.document.sha256).not.toBe(ref.document.sha256)
    expect(f.drafts().map((draft) => draft.id)).toContain(commentId)
    expect(await f.flow.resolveCommentSource(f.sessionId, commentId)).toMatchObject({
      ok: true,
      value: { status: 'resolved', anchor },
    })
    expect(
      await f.flow.send({ ...f.input('Preserve the original decision.'), commentIds: [commentId] }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    await f.settled()
    expect(native.inputs[3]?.promptEnvelope.inputBatchRef).toBeDefined()
    expect(f.drafts()).toHaveLength(0)
    expect(await f.flow.resolveCommentSource(f.sessionId, commentId)).toMatchObject({
      ok: true,
      value: { status: 'resolved', anchor },
    })
  })
})

describe('Ordinary input routing through the original Send owner', () => {
  async function ordinaryFixture() {
    const f = await fixture()
    expect(
      (
        await f.flow.send({
          ...f.input('Original reference'),
          route: { type: 'agent', agentId: 'claude' },
          routeIntent: 'explicit' as const,
        })
      ).ok,
    ).toBe(true)
    await f.settled()
    const message = f.db.drizzle.get<{ id: string; content: string }>(
      sql`SELECT id,content FROM conversation_messages WHERE session_id=${f.sessionId} AND role='assistant' ORDER BY sequence DESC LIMIT 1`,
    )
    const anchor: MessageCommentAnchor = {
      type: 'message',
      messageId: message.id,
      contentHash: createHash('sha256').update(message.content).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 6,
      quote: 'claude',
    }
    const commentId = randomUUID()
    expect(
      await f.flow.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: f.input('').expectedCommentsRevision,
        body: 'Please clarify this response.',
        anchor,
      }),
    ).toMatchObject({ ok: true })
    enableRelay(f, 0)
    const input: ConversationSendInput = {
      ...f.input('Follow up on the complete referenced response.'),
      commentIds: [commentId],
      route: { type: 'primary' },
      routeIntent: 'implicit' as const,
      composerRevision: 17,
    }
    return { ...f, input, anchor, commentId }
  }

  it('routes implicit input once, preserves Primary and joins duplicate Send while keeping newer drafts', async () => {
    const f = await ordinaryFixture()
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    native.decisionCandidate = 'route_claude'
    const first = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    const duplicate = f.flow.send(f.input)
    const laterId = randomUUID()
    const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing draft page')
    const revision = drafts.commentsRevision
    expect(
      await f.flow.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId: laterId,
        expectedCommentsRevision: revision,
        body: 'A later independent draft.',
        anchor: f.anchor,
      }),
    ).toMatchObject({ ok: true })
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 1 })
    held.resolve()
    expect(await first).toMatchObject({ ok: true })
    expect(await duplicate).toMatchObject({ ok: true })
    await f.settled()
    expect(native.inputs).toHaveLength(2)
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('claude')
    expect(f.db.sessionRepository.find(f.sessionId)!.settings.primaryAgentId).toBe('codex')
    expect(f.drafts().map((comment) => comment.id)).toEqual([laterId])
    expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
    expect(native.decisions).toHaveLength(1)
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 2 })
    expect(
      f.db.drizzle.get(
        sql`SELECT count(*) AS count FROM agent_event_journal WHERE event_type='scheduling.evaluation_called'`,
      ),
    ).toEqual({ count: 0 })
    expect(
      f.db.drizzle.get(
        sql`SELECT count(*) AS count FROM agent_event_journal WHERE event_type='scheduling.input_dispatch_adopted'`,
      ),
    ).toEqual({ count: 1 })
  })

  it.each(['explicit', 'legacy'] as const)(
    'preserves %s Primary routing without an auxiliary call',
    async (mode) => {
      const f = await ordinaryFixture()
      const input = {
        ...f.input,
        ...(mode === 'explicit' ? { routeIntent: 'explicit' as const } : {}),
      }
      if (mode === 'legacy') delete input.routeIntent
      expect(await f.flow.send(input)).toMatchObject({ ok: true })
      await f.settled()
      expect(native.decisions).toEqual([])
      expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
    },
  )

  it('continues the original default Send when advice returns null', async () => {
    const f = await ordinaryFixture()
    native.decisionCandidate = null
    expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
    await f.settled()
    expect(native.decisions).toHaveLength(1)
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
  })

  it('owns the auxiliary memory before freezing complete ordinary Comment material', async () => {
    const f = await ordinaryFixture()
    const observed: Array<number | null> = []
    const prepare = f.db.conversationRepository.prepareInputDispatch.bind(
      f.db.conversationRepository,
    )
    vi.spyOn(f.db.conversationRepository, 'prepareInputDispatch').mockImplementation((...args) => {
      observed.push(decisionWorkingMemoryDiagnostics().chargedBytes)
      expect(args[3]?.signal.aborted).toBe(false)
      expect(args[3]?.deadlineAt).toBeGreaterThan(Date.now())
      return prepare(...args)
    })
    expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
    await f.settled()
    expect(observed[0]).toBe(16 * 1024 * 1024)
  })

  it('keeps the auxiliary lease until physical settlement while the default business Send finishes', async () => {
    const f = await ordinaryFixture()
    const released = Promise.withResolvers<void>()
    native.decisionPhysicalHold = released.promise
    native.decisionFailure = 'timeout'
    try {
      expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
      await f.settled()
      expect(native.inputs).toHaveLength(2)
      expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
      expect(f.db.conversationRepository.activeEvaluation()).toMatchObject({
        called: true,
        outcome: 'failed',
      })
      expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(16 * 1024 * 1024)
    } finally {
      released.resolve()
    }
    await vi.waitFor(() => expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(0))
  })

  it('drops advice when new queued input arrives after recommendation but before business admission', async () => {
    const f = await ordinaryFixture()
    native.decisionCandidate = 'route_claude'
    const readiness = await f.preparation.inspectReadiness()
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>()
    vi.spyOn(f.preparation, 'inspectReadiness').mockImplementationOnce(async () => {
      entered.resolve()
      await proceed.promise
      return readiness
    })
    const sent = f.flow.send(f.input)
    await entered.promise
    expect(f.db.drizzle.get(sql`SELECT outcome FROM scheduling_evaluations`)).toEqual({
      outcome: 'completed',
    })
    const page = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (page.scope !== 'drafts') throw Error('Missing draft page')
    const newer = {
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'New input after the recommendation.',
      route: { type: 'primary' as const },
      routeIntent: 'explicit' as const,
      freezeDrafts: false,
      commentIds: [],
      expectedCommentsRevision: page.commentsRevision,
    }
    try {
      expect(await f.flow.send(newer)).toMatchObject({ ok: true })
    } finally {
      proceed.resolve()
    }
    expect(await sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    await f.settled()
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
    expect(native.inputs[2]!.promptEnvelope.message.content).toBe(newer.content)
    expect(
      f.db.drizzle.get(
        sql`SELECT json_extract(payload,'$.evaluationId') AS evaluationId FROM agent_event_journal WHERE event_type='scheduling.input_dispatch_adopted'`,
      ),
    ).toEqual({ evaluationId: null })
  })

  it('invalidates old recipient advice when a newer complete input is queued', async () => {
    const f = await ordinaryFixture()
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    native.decisionCandidate = 'route_claude'
    const sent = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    const draftPage = f.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f.sessionId,
    })
    if (draftPage.scope !== 'drafts') throw Error('Missing draft page')
    const newer = {
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'A newer complete message. Preserve the final line.',
      route: { type: 'primary' as const },
      routeIntent: 'explicit' as const,
      composerRevision: 18,
      freezeDrafts: false,
      commentIds: [],
      expectedCommentsRevision: draftPage.commentsRevision,
    }
    expect(await f.flow.send(newer)).toMatchObject({ ok: true })
    expect(f.db.conversationRepository.receivedCollaborationInput(f.sessionId)?.id).toBe(
      newer.clientMessageId,
    )
    held.resolve()
    expect(await sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    await f.settled()
    expect.soft(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
    expect(native.inputs[2]!.promptEnvelope.message.content).toBe(newer.content)
    expect
      .soft(
        f.db.drizzle.get(
          sql`SELECT json_extract(payload,'$.evaluationId') AS evaluationId FROM agent_event_journal WHERE event_type='scheduling.input_dispatch_adopted'`,
        ),
      )
      .toEqual({ evaluationId: null })
    expect(f.db.drizzle.get(sql`SELECT count(*) AS count FROM agent_runs`)).toEqual({ count: 3 })
  })

  it('invalidates the draft projection when cancelling a prepared ordinary Comment set', async () => {
    const f = await ordinaryFixture()
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    const sent = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    const hidden = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (hidden.scope !== 'drafts') throw Error('Missing draft page')
    expect(hidden.comments).toEqual([])
    const patches: import('@pact/contracts').ConversationPatch[] = []
    const unsubscribe = f.flow.subscribe((patch) => {
      patches.push(patch)
    })
    try {
      expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
      held.resolve()
      expect(await sent).toMatchObject({ ok: false })
      const restored = f.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f.sessionId,
      })
      if (restored.scope !== 'drafts') throw Error('Missing draft page')
      expect(restored.comments.map((comment) => comment.id)).toEqual([f.commentId])
      expect.soft(restored.commentsRevision).toBeGreaterThan(hidden.commentsRevision)
      expect
        .soft(
          patches.some(
            (patch) =>
              patch.resync?.drafts ||
              (patch.comments && patch.comments.revision > hidden.commentsRevision),
          ),
        )
        .toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('includes frozen input preparation in the original auxiliary deadline without renewing it', async () => {
    const f = await ordinaryFixture()
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const prepare = f.db.conversationRepository.prepareInputDispatch.bind(
      f.db.conversationRepository,
    )
    vi.spyOn(f.db.conversationRepository, 'prepareInputDispatch').mockImplementation((...args) => {
      const result = prepare(...args)
      clock += 16_000
      return result
    })
    expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
    await f.settled()
    expect(native.decisions).toHaveLength(0)
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
  })

  it.each(['timeout', 'invalid_output'] as const)(
    'uses the frozen default after %s advice without another evaluation',
    async (failure) => {
      const f = await ordinaryFixture()
      native.decisionFailure = failure
      expect(await f.flow.send(f.input)).toMatchObject({ ok: true })
      await f.settled()
      expect(native.decisions).toHaveLength(1)
      expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
      expect(f.db.drizzle.get(sql`SELECT outcome,called FROM scheduling_evaluations`)).toEqual({
        outcome: 'failed',
        called: 1,
      })
    },
  )

  it('disabling Relay cancels advice while the original frozen Send continues to Primary', async () => {
    const f = await ordinaryFixture()
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    native.decisionCandidate = 'route_claude'
    const sent = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: f.db.conversationRepository.schedulingSettings().revision,
        enabled: false,
      }),
    ).toMatchObject({ ok: true })
    held.resolve()
    expect(await sent).toMatchObject({ ok: true })
    await f.settled()
    expect(native.inputs).toHaveLength(2)
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
    expect(
      f.db.drizzle.get(
        sql`SELECT dispatch_state FROM conversation_input_batches WHERE client_message_id=${f.input.clientMessageId}`,
      ),
    ).toEqual({ dispatch_state: 'dispatched' })
  })

  it('keeps the full business preparation deadline after advice and drops an expired recommendation', async () => {
    const f = await ordinaryFixture()
    const readiness = await f.preparation.inspectReadiness()
    let clock = Date.now()
    const start = clock
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.spyOn(f.preparation, 'inspectReadiness').mockImplementationOnce(async () => {
      clock += 9_000
      return readiness
    })
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    native.decisionCandidate = 'route_claude'
    const sent = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    clock += 14_000
    held.resolve()
    expect(await sent).toMatchObject({ ok: true })
    expect(clock - start).toBe(23_000)
    await f.settled()
    expect(native.inputs).toHaveLength(2)
    expect(f.db.conversationRepository.findRun(native.inputs[1]!.runId)?.agentId).toBe('codex')
    expect(
      f.db.drizzle.get(
        sql`SELECT json_extract(payload,'$.evaluationId') AS evaluationId FROM agent_event_journal WHERE event_type='scheduling.input_dispatch_adopted'`,
      ),
    ).toEqual({ evaluationId: null })
  })

  it('cancels the prepared Send on Stop, preserves its draft and never revives the same nonce', async () => {
    const f = await ordinaryFixture()
    const held = Promise.withResolvers<void>()
    native.decisionHold = held.promise
    native.decisionCandidate = 'route_claude'
    const sent = f.flow.send(f.input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    expect(f.flow.stop({ sessionId: f.sessionId })).toMatchObject({ ok: true })
    held.resolve()
    expect(await sent).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(f.drafts().map((comment) => comment.id)).toContain(f.commentId)
    expect(await f.flow.send(f.input)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(native.inputs).toHaveLength(1)
    expect(native.decisions).toHaveLength(1)
  })
})

it('prepares a cold plan outside page RPCs and publishes readiness without dispatching work', async () => {
  const f = await fixture()
  expect((await f.flow.send(f.input('/plan Read the original plan.'))).ok).toBe(true)
  const task = await f.settled()
  const reference = task.planReference!
  const input = {
    scope: 'collaboration-markdown' as const,
    sessionId: f.sessionId,
    runId: reference.sourceRunId,
    document: reference.document,
    offset: 0,
  }
  const beforeRuns = native.inputs.length
  const events: NonNullable<import('@pact/contracts').ConversationPatch['documentProjection']>[] =
    []
  const brokenListener = f.flow.subscribe((patch) => {
    if (patch.documentProjection) throw Error('Closed viewer')
  })
  const unsubscribe = f.flow.subscribe((patch) => {
    if (patch.documentProjection) events.push(patch.documentProjection)
  })
  try {
    const pending = await f.flow.load(input)
    expect(pending.ok && pending.value.scope).toBe('collaboration-markdown-pending')
    if (!pending.ok || pending.value.scope !== 'collaboration-markdown-pending')
      throw Error('Expected preparation')
    const duplicate = await f.flow.load({ ...input, preparationId: pending.value.preparationId })
    expect(duplicate).toEqual(pending)
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 15_000 })
    expect(events[0]).toMatchObject({ preparationId: pending.value.preparationId, status: 'ready' })
    const page = await f.flow.load({ ...input, preparationId: pending.value.preparationId })
    expect(page.ok && page.value.scope).toBe('collaboration-markdown')
    expect(native.inputs).toHaveLength(beforeRuns)
    expect(f.db.conversationRepository.collaboration(f.sessionId)).toEqual(task)
  } finally {
    brokenListener()
    unsubscribe()
  }
})

describe('Initial stage-role assignment through the modern Composer', () => {
  it.each(['codex', 'claude'] as const)(
    'assigns roles_claude_claude when Primary is %s without changing Session Primary',
    async (primary) => {
      const f = await fixture(primary)
      enableRelaySettings(f)
      native.decisionCandidate = 'roles_claude_claude'
      native.reviews = [{ verdict: 'accepted' }]
      const roles = {
        planAuthor: 'claude',
        planReviewer: 'codex',
        codeAuthor: 'claude',
        codeReviewer: 'codex',
      }
      expect(
        (
          await f.flow.send({
            ...f.input('/plan Preserve the original cancellation boundary.'),
            routeIntent: 'implicit' as const,
            composerRevision: 0,
          })
        ).ok,
      ).toBe(true)
      await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
      const planTask = await f.settled()
      await vi.waitFor(() => expect(native.decisions).toHaveLength(2))
      expect(native.decisions[0]!.handoff.slot).toBe('input_dispatch')
      expect(native.decisions[0]!.candidates.map((candidate) => candidate.id)).toEqual(
        initialTaskRoleCandidates('plan', primary).map((candidate) => candidate.id),
      )
      expect(native.decisions[1]!.handoff.slot).toBe('workflow_next')
      expect(native.decisions[1]!.candidates.map((candidate) => candidate.id)).toEqual([
        'propose_reassign_roles',
      ])
      expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration)).toMatchObject([
        { stage: 'plan', actor: roles.planAuthor, owner: primary },
        { stage: 'plan_review', actor: roles.planReviewer },
      ])
      for (const input of native.inputs)
        expect(input.promptEnvelope.collaboration?.stageRoles).toMatchObject(roles)
      expect(planTask.stageRoles).toMatchObject(roles)
      expect(f.db.sessionRepository.find(f.sessionId)!.settings.primaryAgentId).toBe(primary)
      expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(await f.act('execute')).toMatchObject({
        stage: 'code_review',
        status: 'complete',
      })
      expect(native.inputs).toHaveLength(4)
      expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.actor)).toEqual([
        roles.planAuthor,
        roles.planReviewer,
        roles.codeAuthor,
        roles.codeReviewer,
      ])
      expect(native.decisions).toHaveLength(2)
    },
  )

  it('runs the default assignment for a send without modern Composer metadata', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.reviews = [{ verdict: 'accepted' }]
    expect((await f.flow.send(f.input('/plan Keep the frozen default.'))).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const task = await f.settled()
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    expect(native.decisions[0]!.handoff.slot).toBe('workflow_next')
    expect(native.decisions[0]!.candidates.map((candidate) => candidate.id)).toEqual([
      'propose_reassign_roles',
    ])
    expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(task.stageRoles).toMatchObject({
      planAuthor: 'codex',
      planReviewer: 'claude',
      codeAuthor: 'claude',
      codeReviewer: 'codex',
    })
    expect(native.inputs[0]!.promptEnvelope.collaboration?.actor).toBe('codex')
  })
})

describe('Initial role assignment boundaries', () => {
  it('assigns roles_codex_codex for /build through implement and review with exact write authority', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.decisionCandidate = 'roles_codex_codex'
    const input = {
      ...f.input('/build Keep the original write authority.'),
      routeIntent: 'implicit' as const,
      composerRevision: 0,
    }
    expect((await f.flow.send(input)).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const task = await f.settled()
    expect(
      native.inputs.map((x) => ({
        stage: x.promptEnvelope.collaboration?.stage,
        actor: x.promptEnvelope.collaboration?.actor,
      })),
    ).toEqual([
      { stage: 'implement', actor: 'codex' },
      { stage: 'code_review', actor: 'claude' },
    ])
    expect(task).toMatchObject({ status: 'complete', stage: 'code_review' })
    expect(native.inputs[0]!.promptEnvelope.message.content).toBe(input.content)
    expect(native.decisions).toHaveLength(1)
    expect(native.decisions[0]!.handoff.slot).toBe('input_dispatch')
    const runs = f.db.conversationRepository.read(f.sessionId).runs
    const writeAuth = f.db.conversationRepository.collaborationTurnAuthorization(runs[0]!.id)!
    const reviewAuth = f.db.conversationRepository.collaborationTurnAuthorization(runs[1]!.id)!
    expect(collaborationReadOnly(task, writeAuth)).toBe(false)
    expect(collaborationReadOnly(task, reviewAuth)).toBe(true)
    expect(writeAuth.stageRoles).toEqual(task.stageRoles)
    expect(reviewAuth.stageRoles).toEqual(task.stageRoles)
    expect(writeAuth.userAuthority?.purpose).toBe('action')
    const receipts = f.db.drizzle.select().from(collaborationActionReceipts).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ action: 'build', actor: 'codex', boundRunId: runs[0]!.id })
    expect(JSON.parse(receipts[0]!.basisJson).stageRoles).toEqual(task.stageRoles)
    expect(f.db.sessionRepository.find(f.sessionId)!.settings.primaryAgentId).toBe('codex')
  })

  it('assigns roles_codex_codex for /review as a read-only turn then repairs as code author', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.decisionStarted = (decision) => {
      native.decisionCandidate =
        decision.handoff.slot === 'input_dispatch' ? 'roles_codex_codex' : null
    }
    native.reviews = [{ verdict: 'changes_requested' }, { verdict: 'accepted' }]
    expect(
      (
        await f.flow.send({
          ...f.input('/review Keep the original write authority.'),
          routeIntent: 'implicit' as const,
          composerRevision: 0,
        })
      ).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    const waiting = await f.settled()
    expect(waiting).toMatchObject({
      stage: 'code_review',
      status: 'waiting',
      actor: 'claude',
      review: { verdict: 'changes_requested' },
    })
    const firstRun = f.db.conversationRepository.read(f.sessionId).runs[0]!
    const reviewAuth = f.db.conversationRepository.collaborationTurnAuthorization(firstRun.id)!
    expect(collaborationReadOnly(waiting, reviewAuth)).toBe(true)
    expect(reviewAuth.userAuthority).toBeUndefined()
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toHaveLength(0)
    expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
    const repaired = await f.act('repair')
    expect(repaired).toMatchObject({ stage: 'code_review', status: 'complete' })
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    const task = await f.settled()
    expect(
      native.inputs.map((x) => ({
        stage: x.promptEnvelope.collaboration?.stage,
        actor: x.promptEnvelope.collaboration?.actor,
      })),
    ).toEqual([
      { stage: 'code_review', actor: 'claude' },
      { stage: 'repair', actor: 'codex' },
      { stage: 'code_review', actor: 'claude' },
    ])
    const runs = f.db.conversationRepository.read(f.sessionId).runs
    const repairAuth = f.db.conversationRepository.collaborationTurnAuthorization(runs[1]!.id)!
    expect(collaborationReadOnly(task, repairAuth)).toBe(false)
    expect(repairAuth.userAuthority?.purpose).toBe('action')
    const receipts = f.db.drizzle.select().from(collaborationActionReceipts).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ action: 'repair', actor: 'codex', boundRunId: runs[1]!.id })
    // The initial-role consult is the only input_dispatch evaluation; workflow consults return null.
    expect(native.decisions.filter((d) => d.handoff.slot === 'input_dispatch')).toHaveLength(1)
    expect(task.stageRoles).toMatchObject({
      planAuthor: 'codex',
      planReviewer: 'claude',
      codeAuthor: 'codex',
      codeReviewer: 'claude',
    })
    expect(f.db.sessionRepository.find(f.sessionId)!.settings.primaryAgentId).toBe('codex')
  })

  it.each([null, 'unsupported_role_id'] as const)(
    'keeps the default map for selection %s and starts the original command once',
    async (candidate) => {
      const f = await fixture('codex')
      enableRelaySettings(f)
      native.decisionCandidate = candidate
      native.reviews = [{ verdict: 'accepted' }]
      expect(
        (
          await f.flow.send({
            ...f.input('/plan Keep the default assignment.'),
            routeIntent: 'implicit' as const,
            composerRevision: 0,
          })
        ).ok,
      ).toBe(true)
      await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
      const task = await f.settled()
      // The distinct plan_ready handoff remains eligible after abstention or invalid output.
      expect(native.decisions).toHaveLength(2)
      expect(new Set(native.decisions.map((input) => input.handoff.id)).size).toBe(2)
      expect(
        native.decisions.filter((input) => input.candidates[0]?.id === 'propose_reassign_roles'),
      ).toHaveLength(1)
      expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(task.stageRoles).toMatchObject({
        planAuthor: 'codex',
        planReviewer: 'claude',
        codeAuthor: 'claude',
        codeReviewer: 'codex',
      })
      expect(native.inputs[0]!.promptEnvelope.collaboration?.actor).toBe('codex')
      expect(f.db.conversationRepository.relaySchedulingDecision(f.sessionId)).toBeNull()
    },
  )

  it('keeps the default map when the decision fails', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.decisionFailure = 'timeout'
    native.reviews = [{ verdict: 'accepted' }]
    expect(
      (
        await f.flow.send({
          ...f.input('/plan Keep the default assignment.'),
          routeIntent: 'implicit' as const,
          composerRevision: 0,
        })
      ).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const task = await f.settled()
    expect(task.stageRoles).toMatchObject({ planAuthor: 'codex', planReviewer: 'claude' })
    expect(native.decisions).toHaveLength(2)
    expect(new Set(native.decisions.map((input) => input.handoff.id)).size).toBe(2)
  })

  it.each(['agent', 'all'] as const)(
    'skips role consult for explicit %s recipients',
    async (routeType) => {
      const f = await fixture('codex')
      enableRelaySettings(f)
      native.reviews = [{ verdict: 'accepted' }]
      const route =
        routeType === 'agent'
          ? { type: 'agent' as const, agentId: 'codex' as const }
          : {
              type: 'all' as const,
              firstAgentId: 'codex' as const,
              secondAgentId: 'claude' as const,
            }
      const result = await f.flow.send({
        ...f.input('/plan Keep the explicit recipient.'),
        route,
        routeIntent: 'explicit' as const,
      })
      expect(result.ok).toBe(routeType === 'agent')
      expect(native.decisions).toEqual([])
    },
  )

  it('stops before the first Run without creating a task or dispatching native input', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    const hold = Promise.withResolvers<void>()
    native.decisionHold = hold.promise
    const input = {
      ...f.input('/plan Stop before the task exists.'),
      routeIntent: 'implicit' as const,
      composerRevision: 0,
    }
    const pending = f.flow.send(input)
    await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
    expect(native.inputs).toEqual([])
    expect(f.db.conversationRepository.collaboration(f.sessionId)).toBeUndefined()
    const stopped = f.flow.stop({ sessionId: f.sessionId })
    expect(stopped.ok).toBe(true)
    hold.resolve()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(native.inputs).toEqual([])
    expect(f.db.conversationRepository.collaboration(f.sessionId)).toBeUndefined()
    const retry = await f.flow.send(input)
    expect(retry.ok).toBe(false)
  })
})

describe('Initial role staleness and mutation boundaries', () => {
  it('falls back to the default map when durable config changes after selection', async () => {
    const f = await fixture('claude'),
      repo = f.db.conversationRepository
    enableRelaySettings(f)
    native.decisionCandidate = 'roles_claude_claude'
    native.reviews = [{ verdict: 'accepted' }]
    const readRoles = repo.preparedInitialTaskRoles.bind(repo)
    vi.spyOn(repo, 'preparedInitialTaskRoles').mockImplementationOnce((...args) => {
      const value = readRoles(...args)
      const settings = repo.schedulingSettings()
      repo.saveSchedulingSettings({ expectedRevision: settings.revision, enabled: false })
      return value
    })
    expect(
      (
        await f.flow.send({
          ...f.input('/plan Keep the exact original scope.'),
          routeIntent: 'implicit' as const,
          composerRevision: 0,
        })
      ).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const task = await f.settled()
    // The disabled Relay invalidates the prepared receipt; the default map still runs once.
    expect(task.stageRoles).toMatchObject({
      planAuthor: 'claude',
      planReviewer: 'codex',
      codeAuthor: 'codex',
      codeReviewer: 'claude',
    })
    expect(native.decisions).toHaveLength(1)
    expect(native.inputs[0]!.promptEnvelope.collaboration?.actor).toBe('claude')
  })

  it('refuses a task whose future roles mutated while its first actor stayed the same', async () => {
    const f = await fixture('codex'),
      repo = f.db.conversationRepository
    enableRelaySettings(f)
    native.decisionCandidate = 'roles_claude_claude'
    native.reviews = [{ verdict: 'accepted' }]
    expect(
      (
        await f.flow.send({
          ...f.input('/plan Preserve the map.'),
          routeIntent: 'implicit' as const,
          composerRevision: 0,
        })
      ).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const task = await f.settled()
    expect(task.stageRoles).toMatchObject({ planAuthor: 'claude', codeAuthor: 'claude' })
    // Intercept the real continuation beginRun and inject a mutated plan pair; the code pair
    // and first actor stay identical, so only the stageRoles guard can refuse it.
    const begin = repo.beginRun.bind(repo)
    vi.spyOn(repo, 'beginRun').mockImplementationOnce((input) => {
      if (!input.collaboration) throw Error('Expected real collaboration continuation.')
      return begin({
        ...input,
        collaboration: {
          ...input.collaboration,
          stageRoles: {
            ...input.collaboration.stageRoles!,
            planAuthor: 'codex',
            planReviewer: 'claude',
          },
        },
      })
    })
    const before = repo.collaboration(f.sessionId)!
    const result = await f.flow.actOnCollaboration({
      sessionId: f.sessionId,
      taskId: before.id,
      revision: before.revision,
      clientMessageId: randomUUID(),
      action: 'execute',
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'The collaboration changed before this Turn was admitted.',
      },
    })
    expect(native.inputs).toHaveLength(2)
    expect(repo.collaboration(f.sessionId)!.stageRoles).toEqual(before.stageRoles)
  })
})

describe('Future code-role change through the real Conversation owner', () => {
  it('proposes, confirms and starts implementation with the new code pair', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.decisionCandidate = 'propose_reassign_roles'
    native.reviews = [{ verdict: 'accepted' }]
    expect((await f.flow.send(f.input('/plan Preserve the accepted scope.'))).ok).toBe(true)
    const repo = f.db.conversationRepository
    await vi.waitFor(() =>
      expect(repo.relaySchedulingDecision(f.sessionId)?.request).toMatchObject({
        category: 'arrangement_change',
        operation: { kind: 'reassign_roles' },
      }),
    )
    const before = repo.collaboration(f.sessionId)!
    const card = repo.relaySchedulingDecision(f.sessionId)!
    const result = await f.flow.answerRelayDecision({
      reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
      clientOperationId: randomUUID(),
      answer: { kind: 'confirm' },
    })
    expect(result).toMatchObject({
      ok: true,
      value: { disposition: 'confirmed', runId: null, rebuildId: null },
    })
    expect(native.inputs).toHaveLength(2)
    const task = repo.collaboration(f.sessionId)!
    expect(task.stageRoles).toMatchObject({
      planAuthor: 'codex',
      planReviewer: 'claude',
      codeAuthor: 'codex',
      codeReviewer: 'claude',
      revision: 1,
    })
    expect(task.revision).toBe(before.revision + 1)
    // Confirmation created no Run and no action receipt.
    expect(repo.read(f.sessionId).runs).toHaveLength(2)
    expect(f.db.drizzle.select().from(collaborationActionReceipts).all()).toHaveLength(0)
    // Explicit Implement plan uses the confirmed map.
    native.decisionCandidate = null
    await f.act('execute')
    const executed = repo.read(f.sessionId).runs
    expect(executed.length).toBe(4)
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.actor)).toEqual([
      'codex',
      'claude',
      'codex',
      'claude',
    ])
    const implementRun = repo.read(f.sessionId).runs[2]!
    expect(implementRun.agentId).toBe('codex')
    const reviewRun = repo.read(f.sessionId).runs[3]!
    expect(reviewRun.agentId).toBe('claude')
  })

  it('cancellation preserves the whole ready task and uses the original code pair', async () => {
    const f = await fixture('codex')
    enableRelaySettings(f)
    native.decisionCandidate = 'propose_reassign_roles'
    native.reviews = [{ verdict: 'accepted' }]
    expect((await f.flow.send(f.input('/plan Preserve the accepted scope.'))).ok).toBe(true)
    const repo = f.db.conversationRepository
    await vi.waitFor(() => expect(repo.relaySchedulingDecision(f.sessionId)).not.toBeNull())
    const before = repo.collaboration(f.sessionId)!
    const card = repo.relaySchedulingDecision(f.sessionId)!
    const result = await f.flow.answerRelayDecision({
      reference: { sessionId: f.sessionId, decisionId: card.decisionId, revision: card.revision },
      clientOperationId: randomUUID(),
      answer: { kind: 'cancel' },
    })
    expect(result).toMatchObject({ ok: true, value: { disposition: 'cancelled', runId: null } })
    expect(repo.collaboration(f.sessionId)).toEqual(before)
    native.decisionCandidate = null
    await f.act('execute')
    const runs = repo.read(f.sessionId).runs
    expect(runs.length).toBe(4)
    expect(runs[2]!.agentId).toBe('claude')
    expect(runs[3]!.agentId).toBe('codex')
  })

  it.each([null, 'invalid_output', 'timeout'] as const)(
    'a %s role selection leaves the ready task and produces no card',
    async (failure) => {
      const f = await fixture('codex')
      enableRelaySettings(f)
      if (failure === null) native.decisionCandidate = null
      else native.decisionFailure = failure === 'timeout' ? 'timeout' : 'invalid_output'
      native.reviews = [{ verdict: 'accepted' }]
      expect((await f.flow.send(f.input('/plan Preserve the accepted scope.'))).ok).toBe(true)
      const repo = f.db.conversationRepository
      await f.settled()
      await vi.waitFor(() => expect(native.decisions).toHaveLength(1))
      expect(native.decisions[0]!.candidates.map((candidate) => candidate.id)).toEqual([
        'propose_reassign_roles',
      ])
      await vi.waitFor(() =>
        expect(
          f.db.drizzle.all<{ active: number }>(sql`SELECT active FROM scheduling_evaluations`),
        ).toEqual([{ active: 0 }]),
      )
      expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(repo.collaboration(f.sessionId)!.status).toBe('ready')
      expect(repo.read(f.sessionId).runs).toHaveLength(2)
    },
  )

  it.each(['stop', 'disable'] as const)(
    'a held role consultation cannot resurrect a card after %s',
    async (cancellation) => {
      const f = await fixture('codex')
      enableRelaySettings(f)
      native.decisionCandidate = 'propose_reassign_roles'
      const hold = Promise.withResolvers<void>()
      native.decisionHold = hold.promise
      native.reviews = [{ verdict: 'accepted' }]
      const sent = await f.flow.send(f.input('/plan Preserve the accepted scope.'))
      expect(sent.ok).toBe(true)
      const repo = f.db.conversationRepository
      await vi.waitFor(() =>
        expect(
          native.decisions.some((input) => input.candidates[0]?.id === 'propose_reassign_roles'),
        ).toBe(true),
      )
      const before = repo.collaboration(f.sessionId)!
      const runsBefore = repo.read(f.sessionId).runs.length
      const cancelled =
        cancellation === 'stop'
          ? f.flow.stop({ sessionId: f.sessionId })
          : await f.flow.saveSchedulingSettings({
              expectedRevision: repo.schedulingSettings().revision,
              enabled: false,
            })
      expect(cancelled).toMatchObject({ ok: true })
      hold.resolve()
      await vi.waitFor(() => expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull())
      await vi.waitFor(() =>
        expect(
          f.db.drizzle
            .all<{ active: number }>(sql`SELECT active FROM scheduling_evaluations`)
            .every((row) => row.active === 0),
        ).toBe(true),
      )
      expect(repo.relaySchedulingDecision(f.sessionId)).toBeNull()
      expect(repo.collaboration(f.sessionId)!.stageRoles).toEqual(before.stageRoles)
      expect(repo.read(f.sessionId).runs).toHaveLength(runsBefore)
    },
  )
})
