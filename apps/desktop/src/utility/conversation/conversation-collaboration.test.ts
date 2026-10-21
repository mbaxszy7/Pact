import { eq } from 'drizzle-orm'
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
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import {
  conversationBodyInputs,
  nativeAgentContexts,
} from '../../../../../packages/persistence/src/schema/index.js'
import { markdownVisibleProjection } from '../../shared/message-anchor-text.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import {
  collaborationInputResultRequired,
  collaborationPlanMode,
  collaborationReadOnly,
} from './collaboration-prompt.js'
import { Conversation } from './conversation.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
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
  hold: undefined as Promise<void> | undefined,
  fail: false,
  sources: [] as Array<{
    runId: string
    id: string
    chars: number
    sha256: string
    largestReply: number
  }>,
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
      const phase = input.promptEnvelope.collaboration!
      for (const document of [phase.planReference?.document, phase.taskDocument].filter(
        (source) => source !== undefined,
      )) {
        let offset = 0,
          largestReply = 0
        const hash = createHash('sha256')
        for (;;) {
          const page = input.readCollaborationSourcePart!({
            ...input.promptEnvelope.sourceGrant,
            document,
            offset,
          })
          hash.update(page.text)
          largestReply = Math.max(largestReply, Buffer.byteLength(JSON.stringify(page)))
          offset += page.text.length
          if (page.nextOffset === null) break
          if (page.nextOffset !== offset)
            throw Error('Source continuation skipped or repeated text')
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
            text: report?.plan ?? '1. Implement scope. 2. Verify cancellation.',
          })
      } else if (phase.stage === 'plan_review' || phase.stage === 'code_review') {
        input.recordWorkflowReview?.(report?.review ?? native.nextReview ?? { verdict: 'accepted' })
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
  native.hold = undefined
  native.fail = false
  native.sources = []
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
  return { db, flow, sessionId, input, settled, act, drafts }
}

describe('Native workflow admission and durable dispatch', () => {
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
    'automatically reviews %s plans but requires explicit execution by their owner',
    async (primary) => {
      const f = await fixture(primary, true)
      expect((await f.flow.send(f.input('/plan Implement cancellation'))).ok).toBe(true)
      expect(await f.settled()).toMatchObject({
        status: 'ready',
        owner: primary,
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
        primary,
        primary === 'codex' ? 'claude' : 'codex',
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
      expect((await f.act('resume')).status).toBe('ready')
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
