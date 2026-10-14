import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationAction,
  CollaborationInputResponse,
  CollaborationResult,
  CollaborationTodo,
  CommentAnchor,
  ConversationSendInput,
  NormalizedAgentEvent,
  RuntimeAgentId,
  MessageCommentAnchor,
} from '@pact/contracts'

import {
  collaborationSubmission,
  collaborationEnvelopeSchema,
  collaborationResultSchema,
  collaborationTodoSchema,
  collaborationDocumentSchema,
  commentAnchorSchema,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { markdownVisibleProjection } from '../../shared/message-anchor-text.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { opinionDelta } from './collaboration-fixture.test-support.js'
import { collaborationReadOnly } from './collaboration-prompt.js'
import { Conversation } from './conversation.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'

let largePlanMetrics: { started: number; events: number } | undefined
const metric = (phase: string, since: number, numbers: Record<string, number> = {}): void => {
  if (!largePlanMetrics) return
  if (++largePlanMetrics.events > 32) throw new Error('Large-source metric inventory exceeded')
  console.log(
    JSON.stringify({
      largePlanMetric: phase,
      ms: Math.round((performance.now() - since) * 100) / 100,
      ...numbers,
    }),
  )
}

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
  next: undefined as Partial<CollaborationResult> | undefined,
  hold: undefined as Promise<void> | undefined,
  fail: false,
  output: true,
  comments: [] as Array<{ runId: string; id: string; body: string; anchor: CommentAnchor }>,
  sources: [] as Array<{
    runId: string
    id: string
    chars: number
    sha256: string
    largestReply: number
  }>,
}))

function frozenItems(
  input: AgentRunInput,
  source: 'todos' | 'required_inputs' | 'batch',
  batchId?: string,
): unknown[] {
  const grant = input.promptEnvelope.sourceGrant
  if (!grant || !input.readCollaborationSourcePart) throw Error('Missing frozen source grant')
  const items: unknown[] = []
  let offset = 0
  for (;;) {
    const page = input.readCollaborationSourcePart({
      ...grant,
      source,
      offset,
      ...(batchId ? { batchId } : {}),
    })
    if (page.source !== source || page.offset !== offset)
      throw Error('Fixture source did not match its frozen request')
    if (Buffer.byteLength(JSON.stringify(page)) > 48 * 1024)
      throw Error('Fixture source exceeded its page budget')
    const value: unknown = JSON.parse(page.text),
      part: unknown =
        value && typeof value === 'object'
          ? Reflect.get(value, source === 'batch' ? 'members' : 'items')
          : undefined
    if (!Array.isArray(part)) throw Error('Missing frozen page items')
    items.push(...part)
    if (items.length > 80) throw Error('Fixture index capacity exceeded')
    if (page.nextOffset === null) break
    if (page.nextOffset <= offset) throw Error('Fixture index did not advance')
    offset = page.nextOffset
  }
  return items
}

function frozenComments(input: AgentRunInput) {
  const required = frozenItems(input, 'required_inputs'),
    batchIds = new Set<string>()
  for (const raw of required) {
    const batchId: unknown =
      raw && typeof raw === 'object' ? Reflect.get(raw, 'batchId') : undefined
    if (typeof batchId !== 'string') throw Error('Missing frozen Batch identity')
    batchIds.add(batchId)
  }
  const read = (value: unknown) => {
    const document = collaborationDocumentSchema.parse(value)
    if (document.bytes > 16 * 1024 * 1024) throw Error('Fixture source capacity exceeded')
    let text = '',
      offset = 0
    for (;;) {
      const page = input.readCollaborationSourcePart!({
        ...input.promptEnvelope.sourceGrant,
        document,
        offset,
      })
      text += page.text
      if (page.nextOffset === null) return text
      if (page.nextOffset !== offset + page.text.length) throw Error('Comment source skipped text')
      offset = page.nextOffset
    }
  }
  return [...batchIds].flatMap((batchId) =>
    frozenItems(input, 'batch', batchId).map((raw) => {
      if (!raw || typeof raw !== 'object') throw Error('Invalid frozen Comment')
      const id: unknown = Reflect.get(raw, 'commentId')
      if (typeof id !== 'string') throw Error('Missing frozen Comment identity')
      return {
        runId: input.runId,
        id,
        body: read(Reflect.get(raw, 'body')),
        anchor: commentAnchorSchema.parse(JSON.parse(read(Reflect.get(raw, 'anchorDocument')))),
      }
    }),
  )
}

function requiredResponses(
  input: AgentRunInput,
  comments: ReturnType<typeof frozenComments>,
): CollaborationInputResponse[] {
  return frozenItems(input, 'required_inputs').map((raw) => {
    if (!raw || typeof raw !== 'object') throw Error('Invalid required input member')
    const batchId: unknown = Reflect.get(raw, 'batchId'),
      memberId: unknown = Reflect.get(raw, 'memberId'),
      commentId: unknown = Reflect.get(raw, 'commentId')
    if (typeof batchId !== 'string' || typeof memberId !== 'string')
      throw Error('Missing frozen member identity')
    const anchor = comments.find((comment) => comment.id === commentId)?.anchor
    return {
      batchId,
      memberId,
      disposition: 'resolved',
      reason: 'The supplied input is handled under the current duty.',
      todoId: anchor?.type === 'todo' ? anchor.todoId : null,
    }
  })
}

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
      const phase = input.promptEnvelope.collaboration!
      for (const document of [phase.planDocument, phase.taskDocument].filter(
        (source) => source !== undefined,
      )) {
        const measuredAt = largePlanMetrics ? performance.now() : 0
        const cpuStarted = largePlanMetrics ? process.cpuUsage() : undefined
        let pages = 0,
          readerMs = 0
        let offset = 0,
          largestReply = 0
        const hash = createHash('sha256')
        for (;;) {
          const readerStarted = largePlanMetrics ? performance.now() : 0
          const page = input.readCollaborationSourcePart!({
            ...input.promptEnvelope.sourceGrant,
            document,
            offset,
          })
          if (largePlanMetrics) readerMs += performance.now() - readerStarted
          pages++
          hash.update(page.text)
          largestReply = Math.max(largestReply, Buffer.byteLength(JSON.stringify(page)))
          offset += page.text.length
          if (page.nextOffset === null) break
          if (page.nextOffset !== offset)
            throw Error('Source continuation skipped or repeated text')
        }
        const cpu = cpuStarted ? process.cpuUsage(cpuStarted) : undefined
        metric(document === phase.planDocument ? 'plan-pages' : 'task-pages', measuredAt, {
          turn: native.inputs.length,
          pages,
          chars: offset,
          readerMs: Math.round(readerMs * 100) / 100,
          cpuUserMs: (cpu?.user ?? 0) / 1000,
          cpuSystemMs: (cpu?.system ?? 0) / 1000,
        })
        native.sources.push({
          runId: input.runId,
          id: document.id,
          chars: offset,
          sha256: hash.digest('hex'),
          largestReply,
        })
      }
      const priorSource = phase.priorResultDocument ?? phase.resultDocument
      if (priorSource) {
        const measuredAt = largePlanMetrics ? performance.now() : 0
        const cpuStarted = largePlanMetrics ? process.cpuUsage() : undefined
        let pages = 0,
          readerMs = 0
        let text = '',
          offset = 0
        for (;;) {
          const readerStarted = largePlanMetrics ? performance.now() : 0
          const page = input.readCollaborationSourcePart!({
            ...input.promptEnvelope.sourceGrant,
            document: priorSource,
            offset,
          })
          if (largePlanMetrics) readerMs += performance.now() - readerStarted
          pages++
          text += page.text
          if (page.nextOffset === null) break
          offset = page.nextOffset
        }
        collaborationResultSchema.parse(JSON.parse(text))
        const cpu = cpuStarted ? process.cpuUsage(cpuStarted) : undefined
        metric('prior-result-pages', measuredAt, {
          turn: native.inputs.length,
          pages,
          chars: text.length,
          readerMs: Math.round(readerMs * 100) / 100,
          cpuUserMs: (cpu?.user ?? 0) / 1000,
          cpuSystemMs: (cpu?.system ?? 0) / 1000,
        })
      }
      const submission = collaborationSubmission(phase),
        comments = frozenComments(input),
        todos = frozenItems(input, 'todos').map((item) => {
          if (!item || typeof item !== 'object') throw Error('Invalid frozen Todo')
          const metadata = { ...item }
          Reflect.deleteProperty(metadata, 'contentDocument')
          return collaborationTodoSchema.parse(metadata)
        }),
        defaultDeltas = todos.flatMap((todo) => {
          const sources = comments.filter((comment) => {
            const anchor = comment.anchor
            return (
              anchor.type === 'todo' &&
              anchor.taskId === todo.taskId &&
              anchor.todoId === todo.id &&
              anchor.question?.id === todo.question?.id &&
              anchor.question?.revision === todo.question?.revision
            )
          })
          const confirmsQuestion = todo.question?.answerResolver === agentId && sources.length > 0,
            review = submission === 'plan_review' || submission === 'code_review',
            confirmsOpinion =
              review && todo.kind === 'opinion' && todo.status === 'awaiting_review',
            proposesOpinion = !review && todo.kind === 'opinion' && todo.status === 'open'
          return confirmsQuestion || confirmsOpinion || proposesOpinion
            ? [
                opinionDelta(todo.id, {
                  operation: proposesOpinion ? 'propose_resolution' : 'confirm',
                  expectedRevision: todo.revision,
                  kind: null,
                  title: null,
                  detail: null,
                  recommendation: null,
                  resolutionKind: 'resolved',
                  reason: proposesOpinion
                    ? 'The responsible author addresses this finding; independent review is due.'
                    : confirmsQuestion
                      ? 'The exact sent answer resolves this required question.'
                      : 'Independent review confirms the proposed resolution.',
                  userSourceIds: confirmsQuestion ? sources.map((comment) => comment.id) : [],
                }),
              ]
            : []
        }),
        result: CollaborationResult = {
          submission,
          outcome: 'complete',
          summary: 'Phase inspected.',
          ...(submission === 'plan_submission'
            ? { plan: phase.planReference ?? '1. Implement scope. 2. Verify cancellation.' }
            : submission === 'plan_review'
              ? { reviewedPlan: phase.planReference, verdict: 'accepted' }
              : submission === 'code_review'
                ? { reviewScopeRef: phase.reviewScopeRef, verdict: 'accepted' }
                : {}),
          todoDeltas: defaultDeltas,
          inputResponses: requiredResponses(input, comments),
          ...report,
        }
      native.comments.push(...comments)
      if (
        (submission === 'plan_review' || submission === 'code_review') &&
        (result.todoDeltas.some((delta) => delta.operation === 'create') ||
          todos.some(
            (todo) =>
              !result.todoDeltas.some(
                (delta) => delta.todoId === todo.id && delta.operation === 'confirm',
              ),
          ))
      )
        result.verdict = 'changes_requested'
      const carrier = {
        version: 'pact-collaboration-envelope-v5',
        answer: `${phase.stage} complete.`,
        result,
      }
      const carrierStarted = largePlanMetrics ? performance.now() : 0
      input.recordCollaborationCarrierText?.(JSON.stringify(carrier))
      metric('carrier-text', carrierStarted, { turn: native.inputs.length })
      const carrierParsed = largePlanMetrics ? performance.now() : 0
      input.recordCollaborationCarrier?.(JSON.parse(JSON.stringify(carrier)))
      metric('carrier-parse', carrierParsed, { turn: native.inputs.length })
      yield {
        agentId,
        type: 'collaboration.result',
        turnId: input.runId,
        result: collaborationEnvelopeSchema.parse(JSON.parse(JSON.stringify(carrier))).result,
      }
      if (native.output)
        yield {
          agentId,
          type: 'text.completed',
          turnId: input.runId,
          outputId: input.runId,
          text: `${phase.stage} complete.`,
        }
      input.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          requestId: input.runId,
          runId: input.runId,
          answerFormat: input.answerFormat,
          nativeSessionId: `${input.sessionId}-${agentId}`,
          nativeTurnId: input.runId,
          bindingGeneration: input.bindingGeneration ?? 1,
        },
      })
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
  native.hold = undefined
  native.fail = false
  native.output = true
  native.sources = []
  native.comments = []
  largePlanMetrics = undefined
  vi.restoreAllMocks()
})

async function fixture(primaryAgentId: RuntimeAgentId = 'codex', databaseInProject = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-collaboration-flow-'))
  if (databaseInProject) await mkdir(join(directory, '.pact-data/dev'), { recursive: true })
  const db = await PactDatabase.open({
    filePath: databaseInProject ? join(directory, '.pact-data/dev/pact.sqlite') : ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
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
      runningMessagePolicy: 'immediate_safe_point',
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
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
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
    const measuredAt = largePlanMetrics ? performance.now() : 0
    const result = db.conversationRepository.collaboration(sessionId, undefined, true)!
    metric('settled-hydrate', measuredAt, { turn: native.inputs.length })
    return result
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
    return settled()
  }
  const drafts = (id = sessionId) => {
    const page = db.conversationRepository.readPage({ scope: 'drafts', sessionId: id })
    if (page.scope !== 'drafts') throw Error('Missing draft page')
    return page.comments
  }
  const todos = (): CollaborationTodo[] => {
    const task = db.conversationRepository.collaboration(sessionId)!
    const items: CollaborationTodo[] = []
    let offset = -1
    for (;;) {
      const page = db.conversationRepository.readCollaborationTodos(
        task.id,
        task.ledgerRevision,
        'all',
        offset,
      )
      items.push(...page.items)
      if (items.length > 80) throw Error('Fixture Todo capacity exceeded')
      if (page.nextOffset === null) return items
      offset = page.nextOffset - 1
    }
  }
  return { db, flow, sessionId, input, settled, act, drafts, todos }
}

describe('Pact workflow admission and durable dispatch', () => {
  it('keeps the reviewed master version and source for identical full plan maintenance, then invalidates approval for a real revision', async () => {
    const f = await fixture()
    expect((await f.flow.send(f.input('/plan Inspect version identity'))).ok).toBe(true)
    const first = await f.settled(),
      reviewed = await f.act('continue')
    expect(reviewed.status).toBe('ready')
    native.next = { plan: first.plan, summary: 'The complete plan is confirmed unchanged.' }
    expect(
      (
        await f.flow.send({
          ...f.input('Keep the existing plan; clarify its conclusion.'),
          planningAction: 'maintain_plan',
        })
      ).ok,
    ).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(3))
    const unchanged = await f.settled()
    expect(unchanged.planVersion).toBe(1)
    expect(unchanged.planReference).toEqual(reviewed.planReference)
    expect(unchanged.planDocument).toEqual(reviewed.planDocument)
    expect(unchanged.reviewedPlan).toEqual(reviewed.reviewedPlan)
    native.next = {
      plan: first.plan! + '\n3. Cover a newly requested restart scenario.',
      summary: 'The scope is revised.',
    }
    const changedSend = await f.flow.send({
      ...f.input('Add the restart scenario to the plan.'),
      planningAction: 'maintain_plan',
    })
    if (!changedSend.ok) throw Error(JSON.stringify(changedSend.error))
    await vi.waitFor(() => expect(native.inputs).toHaveLength(4))
    const changed = await f.settled()
    expect(changed.planVersion).toBe(2)
    expect(changed.reviewedPlan).toBeUndefined()
    expect(changed.planReference?.sourceRunId).not.toBe(first.planReference?.sourceRunId)
    expect(native.inputs).toHaveLength(4)
  })
  it(
    'continues an approved complete 9 MiB plan through the source reader without hydrating preflight or starting extra Turns',
    async () => {
      if (process.env.PACT_TEST_SOURCE_METRICS === '1')
        largePlanMetrics = { started: performance.now(), events: 0 }
      const measuredFixture = largePlanMetrics ? performance.now() : 0
      const f = await fixture(),
        plan =
          '## Scope\n\n```text\n' + 'x'.repeat(9 * 1024 * 1024) + '\n```\n\nVerify the true tail.'
      metric('fixture', measuredFixture)
      native.next = {
        plan,
        summary: 'Complete large plan.',
        todoDeltas: Array.from({ length: 40 }, (_, index) =>
          opinionDelta(`opinion-${index}`, {
            title: `Evidence ${index}`,
            detail: 'The checked source needs confirmation.',
          }),
        ),
      }
      expect((await f.flow.send(f.input('/plan Preserve complete source'))).ok).toBe(true)
      const first = await f.settled()
      expect(first.plan).toBe(plan)
      expect(native.inputs).toHaveLength(1)
      const inspected = await f.act('continue')
      expect(inspected.status).toBe('waiting')
      expect(native.inputs).toHaveLength(2)
      const prompt = native.inputs[1]!.promptEnvelope
      expect(prompt.collaboration?.plan).toBeUndefined()
      expect(Buffer.byteLength(JSON.stringify(prompt))).toBeLessThan(48 * 1024)
      expect(
        native.sources.find(
          (source) =>
            source.runId === native.inputs[1]!.runId && source.id === first.planDocument!.id,
        ),
      ).toMatchObject({
        chars: plan.length,
        sha256: createHash('sha256').update(plan).digest('hex'),
      })
      expect(native.sources.every((source) => source.largestReply < 48 * 1024)).toBe(true)
      expect((await f.act('continue')).result?.todoDeltas).toHaveLength(40)
      const reviewed = await f.act('continue')
      expect(reviewed.status).toBe('ready')
      expect(reviewed.planVersion).toBe(1)
      expect(reviewed.result?.todoDeltas).toHaveLength(40)
      expect(reviewed.result?.todoDeltas.every((delta) => delta.operation === 'confirm')).toBe(true)
      expect(native.inputs).toHaveLength(4)
      if (largePlanMetrics) metric('whole-case', largePlanMetrics.started)
      // Windows runs four complete Turns and three full 9 MiB source reads in this scenario.
      // Its aggregate test deadline is separate from the unchanged per-operation runtime limits.
    },
    process.platform === 'win32' ? 60_000 : 15_000,
  )
  it.each(['codex', 'claude'] as const)(
    'accepts one valid report-only submission after an invalid plan report from %s',
    async (primary) => {
      const f = await fixture(primary)
      native.next = {
        outcome: 'complete',
        summary: 'Investigated the scope but omitted the required plan.',
        plan: undefined,
      }
      expect((await f.flow.send(f.input('/plan Inspect cancellation'))).ok).toBe(true)
      const failed = await f.settled()
      expect(failed.status).toBe('failed')
      expect(failed.reportFailure).toBe('invalid')
      const recovered = await f.act('submit_report')
      expect(recovered.status).toBe('waiting')
      expect(recovered.reportFailure).toBeUndefined()
      expect(recovered.plan).toBe('1. Implement scope. 2. Verify cancellation.')
      expect(native.inputs).toHaveLength(2)
      expect(native.inputs[1]!.promptEnvelope.collaboration?.reportRecovery?.sourceRunId).toBe(
        failed.runId,
      )
      expect(
        f.db.conversationRepository
          .read(f.sessionId)
          .messages.filter((message) => message.role === 'assistant'),
      ).toHaveLength(2)
    },
  )

  it.each([true, false])(
    'validates and resolves a frozen plan Comment after a newer version, with answer output=%s',
    async (output) => {
      const f = await fixture()
      const original = '## Plan v1\n\nKeep **cancellation ownership** together.'
      native.output = output
      native.next = {
        outcome: 'complete',
        summary: 'Original plan.',
        plan: original,
      }
      const sent = f.input('/plan Inspect ownership')
      expect((await f.flow.send(sent)).ok).toBe(true)
      const source = await f.settled()
      const projection = markdownVisibleProjection(original)
      const quote = 'cancellation ownership'
      const startOffset = projection.indexOf(quote)
      const anchor: MessageCommentAnchor = {
        type: 'message',
        messageId: sent.clientMessageId,
        plan: { runId: source.runId, version: 1 },
        contentHash: createHash('sha256').update(original).digest('hex'),
        textBasis: 'markdown-visible-v2',
        startOffset,
        endOffset: startOffset + quote.length,
        quote,
      }
      native.next = {
        outcome: 'complete',
        summary: 'One opinion.',
        reviewedPlan: source.planReference,
        todoDeltas: [
          opinionDelta('owner', {
            title: 'Check owner',
            detail: 'Keep the owner explicit.',
            recommendation: 'Clarify the plan.',
          }),
        ],
      }
      await f.act('continue')
      native.next = {
        outcome: 'complete',
        summary: 'Revised.',
        plan: '## Plan v2\n\nA revised scope.',
        todoDeltas: [
          opinionDelta('owner', {
            operation: 'propose_resolution',
            expectedRevision: 1,
            title: 'Check owner',
            detail: 'The revised scope addresses the ownership question.',
            recommendation: '',
            resolutionKind: 'resolved',
            reason: 'The new scope explicitly preserves the owner; peer confirmation is due.',
          }),
        ],
      }
      expect((await f.act('continue')).planVersion).toBe(2)
      const commentId = randomUUID()
      expect(
        (
          await f.flow.saveCommentDraft({
            mode: 'create',
            sessionId: f.sessionId,
            commentId,
            expectedCommentsRevision: f.input('').expectedCommentsRevision,
            body: 'Keep this v1 decision.',
            anchor,
          })
        ).ok,
      ).toBe(true)
      expect(await f.flow.resolveCommentSource(f.sessionId, commentId)).toMatchObject({
        ok: true,
        value: { status: 'resolved', anchor },
      })
      // A Proposal must preserve this draft; only explicit Send consumes and carries it.
      await f.act('continue')
      expect(f.drafts().map((c) => c.id)).toContain(commentId)
      const input = f.input('Please inspect this original decision.')
      input.commentIds = [commentId]
      expect((await f.flow.send(input)).ok).toBe(true)
      await vi.waitFor(() =>
        expect(
          native.inputs.some((entry) => entry.promptEnvelope.message.id === input.clientMessageId),
        ).toBe(true),
      )
      await f.settled()
      expect(
        native.comments.filter((comment) => comment.runId === native.inputs.at(-1)?.runId),
      ).toEqual([
        expect.objectContaining({ id: commentId, body: 'Keep this v1 decision.', anchor }),
      ])
      expect(f.drafts()).toHaveLength(0)
      expect((await f.flow.resolveCommentSource(f.sessionId, commentId)).ok).toBe(true)
    },
  )

  it('rejects plan Comment ownership, version, hash and quote forgery without retaining drafts', async () => {
    const f = await fixture()
    expect((await f.flow.send(f.input('/plan Inspect ownership'))).ok).toBe(true)
    const task = await f.settled()
    const run = f.db.conversationRepository.findRun(task.runId)!
    const content = task.plan!
    const projection = markdownVisibleProjection(content)
    const anchor: MessageCommentAnchor = {
      type: 'message',
      messageId: run.userMessageId,
      plan: { runId: run.id, version: task.planVersion },
      contentHash: createHash('sha256').update(content).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 5,
      quote: projection.slice(0, 5),
    }
    const invalid = [
      { ...anchor, messageId: randomUUID() },
      { ...anchor, plan: { runId: randomUUID(), version: 1 } },
      { ...anchor, plan: { runId: run.id, version: 2 } },
      { ...anchor, contentHash: '0'.repeat(64) },
      { ...anchor, quote: 'wrong' },
    ]
    const results = await Promise.all(
      invalid.map((value) =>
        f.flow.saveCommentDraft({
          mode: 'create',
          sessionId: f.sessionId,
          commentId: randomUUID(),
          expectedCommentsRevision: 0,
          body: 'Invalid reference',
          anchor: value,
        }),
      ),
    )
    expect(results.every((result) => !result.ok)).toBe(true)
    const session = f.db.sessionRepository.find(f.sessionId)!
    const otherId = randomUUID()
    f.db.sessionRepository.create(
      {
        id: otherId,
        projectId: session.projectId,
        title: 'Other',
        createdAt: new Date().toISOString(),
      },
      session.settings,
    )
    expect(
      (
        await f.flow.saveCommentDraft({
          mode: 'create',
          sessionId: otherId,
          commentId: randomUUID(),
          expectedCommentsRevision: 0,
          body: 'Wrong Session',
          anchor,
        })
      ).ok,
    ).toBe(false)
    expect(f.drafts()).toHaveLength(0)
    expect(f.drafts(otherId)).toHaveLength(0)
  })
  it('bare Secondary build routes the frozen answer directly to its resolver and requires an explicit work continuation', async () => {
    const f = await fixture(),
      question = {
        id: 'scope',
        revision: 1,
        type: 'choice' as const,
        question: 'Which file should change?',
        reason: 'A target is required.',
        options: ['Current file', 'Current module'],
        recommended: 0,
        answerResolver: 'claude' as const,
      }
    native.next = {
      outcome: 'needs_user',
      summary: 'Scope required.',
      todoDeltas: [
        opinionDelta('scope', {
          kind: 'decision',
          title: 'Implementation target',
          detail: 'The implementation needs a concrete target.',
          question,
        }),
      ],
    }
    expect((await f.flow.send(f.input('@claude /build'))).ok).toBe(true)
    const requested = await f.settled(),
      todo = f.todos()[0]!,
      commentId = randomUUID()
    expect(requested).toMatchObject({
      actor: 'claude',
      status: 'questions',
    })
    expect(native.inputs).toHaveLength(1)
    expect(
      (
        await f.flow.saveCommentDraft({
          mode: 'create',
          sessionId: f.sessionId,
          commentId,
          expectedCommentsRevision: f.input('').expectedCommentsRevision,
          body: 'Current file',
          anchor: {
            type: 'todo',
            taskId: requested.id,
            todoId: todo.id,
            todoRevision: todo.revision,
            quote: todo.title,
            question: { id: question.id, revision: question.revision, optionIndex: 0 },
          },
        })
      ).ok,
    ).toBe(true)
    expect(native.inputs).toHaveLength(1)
    expect(f.todos()[0]?.status).toBe('open')
    expect((await f.flow.send({ ...f.input(''), commentIds: [commentId] })).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const answered = await f.settled()
    expect(answered.resumePhase).toMatchObject({ stage: 'implement', actor: 'claude' })
    expect(f.todos()[0]?.status).toBe('done')
    expect(
      collaborationReadOnly(
        native.inputs[1]?.promptEnvelope.collaboration,
        native.inputs[1]?.promptEnvelope.collaborationAuthorization,
      ),
    ).toBe(true)
    await f.act('continue')
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.actor)).toEqual([
      'claude',
      'claude',
      'claude',
    ])
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
      'clarify',
      'supplement',
      'implement',
    ])
    expect(f.db.conversationRepository.collaboration(f.sessionId)?.repairAttempts).toBe(0)
  })

  it.each(['codex', 'claude'] as const)(
    'completes plan, implementation and peer Review from %s primary with project-local App data and exactly one target Turn per click',
    async (primary) => {
      const f = await fixture(primary, true)
      expect((await f.flow.send(f.input('/plan Implement cancellation'))).ok).toBe(true)
      expect((await f.settled()).status).toBe('waiting')
      expect(native.inputs).toHaveLength(1)
      const ready = await f.act('continue')
      expect(ready.status).toBe('ready')
      expect(native.inputs).toHaveLength(2)
      expect((await f.act('execute')).stage).toBe('implement')
      expect(native.inputs).toHaveLength(3)
      expect((await f.act('continue')).status).toBe('complete')
      expect(native.inputs).toHaveLength(4)
      const phases = native.inputs.map((input) => input.promptEnvelope.collaboration!)
      expect(phases.map((phase) => phase.stage)).toEqual([
        'draft',
        'discuss',
        'implement',
        'review',
      ])
      expect(phases.map((phase) => phase.actor)).toEqual([
        primary,
        primary === 'codex' ? 'claude' : 'codex',
        primary === 'codex' ? 'claude' : 'codex',
        primary,
      ])
      expect(phases.every((phase) => phase.primary === primary)).toBe(true)
      expect(native.inputs[2]?.promptEnvelope.collaborationBasis?.original?.content).toBe(
        '/plan Implement cancellation',
      )
    },
  )

  it('direct review displays suggestions, requires a separate repair click, and re-reviews without automatic peer work', async () => {
    const f = await fixture(),
      opinion = opinionDelta('cleanup', {
        title: 'Cleanup',
        detail: 'Release the pending request.',
        recommendation: 'Dispose with its owner.',
      })
    native.next = {
      outcome: 'complete',
      summary: 'One suggestion.',
      todoDeltas: [opinion],
    }
    expect((await f.flow.send(f.input('/review Inspect cancellation'))).ok).toBe(true)
    const reviewed = await f.settled()
    expect(reviewed.result?.todoDeltas).toEqual([opinion])
    expect(f.todos()[0]).toMatchObject({ id: 'cleanup', revision: 1, status: 'open' })
    expect(native.inputs).toHaveLength(1)
    expect((await f.act('repair')).repairAttempts).toBe(1)
    expect(f.todos()[0]).toMatchObject({ id: 'cleanup', revision: 2, status: 'awaiting_review' })
    expect(native.inputs).toHaveLength(2)
    native.next = {
      outcome: 'complete',
      summary: 'No remaining opinions.',
    }
    expect((await f.act('continue')).status).toBe('complete')
    expect(f.todos()[0]).toMatchObject({ id: 'cleanup', revision: 3, status: 'done' })
    expect(native.inputs).toHaveLength(3)
    expect(native.inputs.map((input) => input.promptEnvelope.collaboration?.stage)).toEqual([
      'review',
      'repair',
      'review',
    ])
  })

  it('durably receives during an active Turn, fences its old Proposal and dispatches the user-authorized supplement once', async () => {
    const f = await fixture(),
      held = Promise.withResolvers<void>()
    native.hold = held.promise
    expect((await f.flow.send(f.input('/build Implement cancellation'))).ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(1))
    const send = f.input('Include the restart path'),
      received = await f.flow.send(send)
    expect(received).toMatchObject({
      ok: true,
      value: { receivedInputIds: [send.clientMessageId] },
    })
    expect(
      f.db.conversationRepository
        .read(f.sessionId)
        .messages.some((message) => message.id === send.clientMessageId),
    ).toBe(false)
    expect(await f.flow.send(send)).toMatchObject({ ok: true })
    native.hold = undefined
    held.resolve()
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    await f.settled()
    expect(native.inputs[1]?.promptEnvelope.message).toMatchObject({
      id: send.clientMessageId,
      content: send.content,
    })
    expect(native.inputs[1]?.promptEnvelope.collaboration).toMatchObject({
      stage: 'supplement',
      actor: 'codex',
      reviewCycles: 0,
    })
    expect(native.inputs).toHaveLength(2)
    expect((await f.act('continue')).status).toBe('complete')
    expect(native.inputs).toHaveLength(3)
  })

  it('rejects stale and duplicate action identities before another Native Turn', async () => {
    const f = await fixture()
    await f.flow.send(f.input('/plan Implement cancellation'))
    const old = await f.settled()
    await f.act('continue')
    expect(
      await f.flow.actOnCollaboration({
        sessionId: f.sessionId,
        taskId: old.id,
        revision: old.revision,
        clientMessageId: randomUUID(),
        action: 'continue',
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(native.inputs).toHaveLength(2)
  })

  it('bare plan uses bounded clarification rather than rejecting the entry', async () => {
    const f = await fixture()
    native.next = {
      outcome: 'needs_user',
      summary: 'Scope is missing.',
      plan: 'Provisional plan: determine the target, define acceptance, then implement only the approved scope.',
      todoDeltas: [
        opinionDelta('scope', {
          kind: 'decision',
          title: 'Scope',
          detail: 'A target is required before the plan can be approved.',
          question: {
            id: 'scope',
            revision: 1,
            type: 'choice',
            question: 'Which change should be planned?',
            reason: 'A target is required.',
            options: ['Current feature', 'Current module'],
            recommended: 0,
            answerResolver: 'codex',
          },
        }),
      ],
    }
    expect((await f.flow.send(f.input('/plan'))).ok).toBe(true)
    expect((await f.settled()).status).toBe('questions')
    expect(native.inputs).toHaveLength(1)
  })
})
