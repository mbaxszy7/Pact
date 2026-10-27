import { sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationDocument,
  CollaborationReviewObservation,
  DecisionInformation,
  DecisionInput,
  ConversationPatch,
} from '@pact/contracts'

import { collaborationDocumentSchema } from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import { Conversation } from './conversation.js'
import { claudePromptContent, codexPromptInput } from './native-image-content.js'
import { enableWorkflowRelay, workflowConversation } from './relay-workflow-fixture.test-support.js'

const native = vi.hoisted(() => ({
  inputs: [] as AgentRunInput[],
  reviews: [] as CollaborationReviewObservation[],
  decisions: [] as DecisionInput[],
  candidate: undefined as string | null | undefined,
  information: undefined as DecisionInformation | undefined,
  interruptNextWrite: false,
  rootBarrier: undefined as Promise<void> | undefined,
  loseObservation: false,
  rebuilds: [] as string[],
  sourceReads: [] as import('./relay-workflow-fixture.test-support.js').WorkflowSourceRead[],
  answers: [] as Array<{ runId: string; document: CollaborationDocument; text: string }>,
}))
vi.mock('./codex-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return {
    CodexAgentAdapter: class extends workflowAdapter('codex', native) {
      override async *run(input: AgentRunInput) {
        const document = input.promptEnvelope.clarificationAnswer
        if (document) {
          const reader = input.collaborationSourceReader!,
            index: unknown = JSON.parse(
              reader.read(
                reader.navigation(
                  { source: 'batch', batchId: input.promptEnvelope.inputBatchRef!.id },
                  'sourceReference',
                ),
              ).page.text,
            )
          if (!index || typeof index !== 'object' || Array.isArray(index))
            throw Error('Missing frozen Batch index.')
          const answer = collaborationDocumentSchema.parse(
            Reflect.get(index, 'clarificationAnswer'),
          )
          if (answer.id !== document.id || answer.sha256 !== document.sha256)
            throw Error('The Batch answer differs from its bound prompt source.')
          let text = '',
            request: unknown = Reflect.get(index, 'clarificationAnswerRead')
          for (;;) {
            const page = reader.read(request).page
            text += page.text
            if (page.nextOffset === null) break
            request = page.nextRead
          }
          native.answers.push({ runId: input.runId, document, text })
        }
        for await (const event of super.run(input)) {
          yield event
          if (event.type === 'turn.started' && native.rootBarrier) await native.rootBarrier
        }
      }
    },
  }
})
vi.mock('./claude-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return { ClaudeAgentAdapter: workflowAdapter('claude', native) }
})
vi.mock('./codex-decision-runtime.js', async () => {
  const { workflowDecisionRuntime } = await import('./relay-workflow-fixture.test-support.js')
  return { CodexDecisionRuntime: workflowDecisionRuntime(native) }
})
const owners: Array<Awaited<ReturnType<typeof workflowConversation>>> = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
  native.inputs = []
  native.decisions = []
  native.answers = []
  native.reviews = []
  native.rootBarrier = undefined
  native.information = undefined
  native.candidate = undefined
  vi.restoreAllMocks()
})
async function fixture() {
  const f = await workflowConversation(Conversation),
    repo = f.db.conversationRepository
  owners.push(f)
  expect(
    await f.flow.send({
      ...f.input('Earlier answer for an anchored Comment.'),
      route: { type: 'agent', agentId: 'claude' },
    }),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(repo.latestAgentRun(f.sessionId, 'claude')?.nativeEffectsState).toBe('settled'),
  )
  const run = repo.latestAgentRun(f.sessionId, 'claude')!,
    text = 'ordinary complete within the original scope.'
  const drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing actual draft projection.')
  const commentId = randomUUID()
  repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId,
    expectedCommentsRevision: drafts.commentsRevision,
    body: 'Include the exact earlier answer.',
    anchor: {
      type: 'message',
      messageId: run.responseMessageId!,
      contentHash: createHash('sha256').update(text).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 8,
      quote: text.slice(0, 8),
    },
  })
  enableWorkflowRelay(f.db)
  native.candidate = 'clarify_prepared_input'
  const declaration = {
    version: 'user-information-v1' as const,
    id: randomUUID(),
    kind: 'user_supplied_value' as const,
    question: 'What launch date should be used?',
    input: 'text' as const,
    options: [],
    state: { status: 'unanswered' as const },
  }
  native.information = { fieldId: declaration.id }

  const input = {
    ...f.input('Wait for my user-supplied launch date before proceeding.'),
    userInformation: declaration,
    routeIntent: 'implicit' as const,
    composerRevision: 5,
    commentIds: [commentId],
  }
  const sent = await f.flow.send(input)
  expect(sent).toMatchObject({
    ok: true,
    value: { sendDisposition: 'held_for_information', messages: [], runs: [] },
  })
  expect(await f.flow.send(input)).toMatchObject({
    ok: true,
    value: { sendDisposition: 'held_for_information' },
  })
  const card = repo.relaySchedulingDecision(f.sessionId)!
  expect(card?.request.category).toBe('necessary_information')
  return { ...f, repo, input, card }
}

it('saves the typed answer, dispatches one ordinary root and reads its immutable answer with the actual source grant', async () => {
  const f = await fixture()
  if (f.card.request.category !== 'necessary_information') throw Error('Missing typed consumer.')
  const answer = {
    reference: { sessionId: f.sessionId, decisionId: f.card.decisionId, revision: f.card.revision },
    clientOperationId: randomUUID(),
    answer: {
      kind: 'text' as const,
      fieldId: f.card.request.field.fieldId,
      text: '  2027-04-12\n@claude /build stays literal answer data.  ',
    },
  }
  const result = await f.flow.answerRelayDecision(answer)
  expect(result).toMatchObject({
    ok: true,
    value: { disposition: 'confirmed', runId: expect.any(String) },
  })
  await vi.waitFor(() => expect(native.answers).toHaveLength(1))
  expect(JSON.parse(native.answers[0]!.text).answer).toBe(answer.answer.text)
  expect(await f.flow.answerRelayDecision(answer)).toEqual(result)
  expect(
    native.inputs.filter((item) => item.promptEnvelope.message.id === f.input.clientMessageId),
  ).toHaveLength(1)
  expect(native.inputs.at(-1)?.promptEnvelope.message.content).toBe(f.input.content)
  expect(native.inputs.at(-1)?.promptEnvelope.collaboration).toBeUndefined()
  expect(native.inputs.at(-1)?.promptEnvelope.userClarification).toMatchObject({
    fieldId: f.input.userInformation.id,
    question: f.input.userInformation.question,
    answer: answer.answer.text,
    document: native.answers[0]!.document,
  })
  expect(native.decisions).toHaveLength(1)
})

it('supplies the accepted clarification value as current user input for both native providers', async () => {
  const f = await fixture()
  if (f.card.request.category !== 'necessary_information') throw Error('Missing typed consumer.')
  let release!: () => void
  native.rootBarrier = new Promise<void>((done) => {
    release = done
  })
  try {
    expect(
      await f.flow.answerRelayDecision({
        reference: {
          sessionId: f.sessionId,
          decisionId: f.card.decisionId,
          revision: f.card.revision,
        },
        clientOperationId: randomUUID(),
        answer: { kind: 'text', fieldId: f.card.request.field.fieldId, text: '2027-04-12' },
      }),
    ).toMatchObject({ ok: true, value: { disposition: 'confirmed' } })
    await vi.waitFor(() => expect(native.answers).toHaveLength(1))
    const captured = native.inputs.find(
      (input) => input.promptEnvelope.message.id === f.input.clientMessageId,
    )!
    const navigate = (
      target: Parameters<NonNullable<typeof captured.collaborationSourceReader>['navigation']>[0],
    ) => captured.collaborationSourceReader!.navigation(target, 'sourceReference')
    const codex = codexPromptInput(captured.promptEnvelope, navigate),
      claude = await claudePromptContent(captured.promptEnvelope, undefined, navigate),
      codexText = codex
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      claudeText =
        typeof claude === 'string'
          ? claude
          : claude
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
    expect(captured.promptEnvelope.message.content).toBe(f.input.content)
    expect(JSON.parse(native.answers[0]!.text).answer).toBe('2027-04-12')
    expect(codexText.split('Pact context (JSON reference data;')[0]).toContain('2027-04-12')
    expect(claudeText.split('Pact context (JSON reference data;')[0]).toContain('2027-04-12')
  } finally {
    release()
  }
})

it('Cancel ends the old pending request and the next Send uses the current draft and Comments once', async () => {
  const f = await fixture(),
    request = {
      reference: {
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        revision: f.card.revision,
      },
      clientOperationId: randomUUID(),
      answer: { kind: 'cancel' as const },
    }
  const cancelled = await f.flow.answerRelayDecision(request)
  expect(cancelled).toMatchObject({ ok: true, value: { disposition: 'cancelled', runId: null } })
  expect(await f.flow.answerRelayDecision(request)).toEqual(cancelled)
  expect(f.repo.preparedInputContinuation(f.sessionId)).toBeNull()
  expect(native.inputs).toHaveLength(1)
  expect(await f.flow.send(f.input)).toMatchObject({ ok: false })
  const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing restored drafts.')
  expect(drafts.comments).toHaveLength(1)
  const restored = drafts.comments[0]!,
    newer = randomUUID()
  if (restored.anchor.type !== 'message') throw Error('Missing original Message anchor.')
  const patch = f.repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId: newer,
    expectedCommentsRevision: drafts.commentsRevision,
    body: 'Include this newer draft on Send.',
    anchor: restored.anchor,
  })
  const next = {
    ...f.input,
    clientMessageId: randomUUID(),
    content: 'Send the current edited draft.',
    userInformation: undefined,
    expectedCommentsRevision: patch.comments!.revision,
    commentIds: [restored.id, newer],
    composerRevision: 6,
  }
  native.candidate = null
  expect(await f.flow.send(next)).toMatchObject({ ok: true })
  expect(await f.flow.send(next)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
  expect(native.inputs.at(-1)?.promptEnvelope.message).toMatchObject({
    id: next.clientMessageId,
    content: next.content,
  })
  expect(native.inputs.at(-1)?.promptEnvelope.inputBatchRef?.memberCount).toBe(2)
  expect(native.inputs.at(-1)?.promptEnvelope.userClarification).toBeUndefined()
  expect(native.inputs.at(-1)?.promptEnvelope.clarificationAnswer).toBeUndefined()
  expect(
    native.inputs.some((item) => item.promptEnvelope.message.id === f.input.clientMessageId),
  ).toBe(false)
  const after = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (after.scope !== 'drafts') throw Error('Missing current draft projection.')
  expect(after.comments).toEqual([])
  expect(f.db.drizzle.get(sql`SELECT count(*) AS n FROM agent_runs`)).toEqual({ n: 2 })
})

it('closing Relay dispatches the unpaused original default once through the existing scheduler', async () => {
  const f = await fixture()
  expect(
    await f.flow.saveSchedulingSettings({ expectedRevision: 1, enabled: false, selection: null }),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
  expect(native.inputs.at(-1)?.promptEnvelope.message.id).toBe(f.input.clientMessageId)
  expect(native.inputs.at(-1)?.promptEnvelope.collaboration).toBeUndefined()
  expect(native.decisions).toHaveLength(1)
})

it('a stale default publishes restored Comment revision and drafts resync to the same live subscriber', async () => {
  const f = await fixture(),
    patches: ConversationPatch[] = [],
    unsubscribe = f.flow.subscribe((patch) => {
      if (patch.sessionId === f.sessionId) patches.push(patch)
    })
  try {
    const current = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...current.settings,
      primaryAgentId: 'claude',
    })
    expect(
      await f.flow.saveSchedulingSettings({ expectedRevision: 1, enabled: false, selection: null }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(
        patches.some(
          (patch) =>
            patch.resync?.drafts &&
            patch.comments?.revision &&
            patch.preparedInputContinuation?.phase === 'paused',
        ),
      ).toBe(true),
    )
    const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing same-window restored Comment page.')
    expect(drafts.comments.map((comment) => comment.body)).toEqual([
      'Include the exact earlier answer.',
    ])
    expect(patches.find((patch) => patch.resync?.drafts)?.comments?.revision).toBe(
      drafts.commentsRevision,
    )
    expect(native.inputs).toHaveLength(1)
  } finally {
    unsubscribe()
  }
})

it('reads the same declared Send receipt during its active root, rejects changed fields, and never dispatches twice', async () => {
  const f = await fixture()
  if (f.card.request.category !== 'necessary_information') throw Error('Missing typed consumer.')
  let release!: () => void
  native.rootBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const answer = await f.flow.answerRelayDecision({
      reference: {
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        revision: f.card.revision,
      },
      clientOperationId: randomUUID(),
      answer: { kind: 'text', fieldId: f.card.request.field.fieldId, text: '2027-04-12' },
    })
    expect(answer).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(f.repo.latestAgentRun(f.sessionId, 'codex')?.status).toBe('running'),
    )
    await vi.waitFor(() =>
      expect(
        native.inputs.filter(
          (input) => input.promptEnvelope.message.id === f.input.clientMessageId,
        ),
      ).toHaveLength(1),
    )
    const run = f.repo.latestAgentRun(f.sessionId, 'codex')!
    expect(await f.flow.send(f.input)).toMatchObject({
      ok: true,
      value: { runs: [expect.objectContaining({ id: run.id })] },
    })
    expect(
      await f.flow.send({
        ...f.input,
        userInformation: { ...f.input.userInformation, question: 'A different field question' },
      }),
    ).toMatchObject({ ok: false })
    expect(
      native.inputs.filter((input) => input.promptEnvelope.message.id === f.input.clientMessageId),
    ).toHaveLength(1)
    expect(f.repo.latestAgentRun(f.sessionId, 'codex')?.id).toBe(run.id)
  } finally {
    release()
    native.rootBarrier = undefined
  }
})

it.each(['ordinary', 'conflict'] as const)(
  'retains the committed Cancel receipt when its following metadata publication fails with %s error',
  async (kind) => {
    const f = await fixture(),
      request = {
        reference: {
          sessionId: f.sessionId,
          decisionId: f.card.decisionId,
          revision: f.card.revision,
        },
        clientOperationId: randomUUID(),
        answer: { kind: 'cancel' as const },
      }
    vi.spyOn(f.repo, 'metadataPatch').mockImplementationOnce(() => {
      if (kind === 'conflict')
        throw new RunOperationConflictError('Controlled post-commit conflict.')
      throw Error('Controlled failure after the Cancel transaction committed.')
    })
    const result = await f.flow.answerRelayDecision(request),
      receipt = f.flow.getRelayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: f.card.decisionId,
        clientOperationId: request.clientOperationId,
      })
    expect(result).toEqual(receipt)
    expect(receipt).toMatchObject({ ok: true, value: { disposition: 'cancelled', runId: null } })
    if (f.card.request.category !== 'necessary_information')
      throw Error('Missing typed declaration.')
    expect(
      await f.flow.answerRelayDecision({
        ...request,
        answer: {
          kind: 'text',
          fieldId: f.card.request.field.fieldId,
          text: '2027-04-12',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await f.flow.answerRelayDecision(request)).toEqual(receipt)
    const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing restored Comment projection.')
    expect(drafts.comments).toHaveLength(1)
    expect(f.repo.preparedInputContinuation(f.sessionId)).toBeNull()
    expect(native.inputs).toHaveLength(1)
    console.info(
      '[pact-cancel-post-commit-counterexample]',
      JSON.stringify({
        response: result.ok ? result.value.disposition : result.error.code,
        durableReceipt: receipt.ok ? receipt.value.disposition : receipt.error.code,
        restoredDrafts: drafts.comments.length,
        businessDispatchesAfterCancel: native.inputs.length - 1,
        controlledNativeFixture: true,
        paidProviderCalls: 0,
      }),
    )
  },
)
