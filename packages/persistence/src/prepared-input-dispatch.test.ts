import { and, asc, eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  conversationSendInputSchema,
  inputRoutingProposalSchema,
  type ConversationSendInput,
  type DefaultSessionSettings,
  type InputRoutingProposal,
  type RelaySchedulingDecision,
} from '@pact/contracts'

import type { BeginRunInput, PreparedInputDispatch } from './conversation-repository.js'

import { RunOperationConflictError } from './conversation-errors.js'
import { PactDatabase } from './pact-database.js'
import {
  agentEventJournal,
  agentRuns,
  anchoredComments,
  conversationBodyInputs,
  conversationBodyParts,
  conversationInputBatchMembers,
  conversationInputBatches,
  conversationMessages,
  schedulingEvaluations,
} from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const databases = new Set<PactDatabase>()
const directories: string[] = []
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const candidates = [
  { id: 'route_codex', description: 'Send this ordinary input to Codex.' },
  { id: 'route_claude', description: 'Send this ordinary input to Claude.' },
]
const configurationFingerprint = 'a'.repeat(64)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases) db.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

type SessionFixture = {
  db: PactDatabase
  repo: PactDatabase['conversationRepository']
  sessionId: string
}

function drafts(f: SessionFixture) {
  const page = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (page.scope !== 'drafts') throw Error('Expected the public Comment draft projection.')
  return page
}

function complete(f: SessionFixture, runId: string, text: string) {
  const run = f.repo.findRun(runId)!
  const nativeSessionId = `prepared-source-${run.agentId}`
  const turnId = `turn-${runId}`
  f.repo.applyEvent(f.sessionId, runId, {
    type: 'session.started',
    agentId: run.agentId,
    nativeSessionId,
  })
  f.repo.applyEvent(f.sessionId, runId, { type: 'turn.started', agentId: run.agentId, turnId })
  f.repo.applyEvent(f.sessionId, runId, {
    type: 'text.completed',
    agentId: run.agentId,
    turnId,
    outputId: `answer-${runId}`,
    text,
  })
  f.repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome: 'completed',
    identity: {
      sessionId: f.sessionId,
      agentId: run.agentId,
      requestId: runId,
      runId,
      nativeSessionId,
      nativeTurnId: turnId,
      bindingGeneration: run.bindingGeneration ?? 1,
    },
  })
  f.repo.recordNativeEffects(runId, 'settled')
  f.repo.applyEvent(f.sessionId, runId, {
    type: 'turn.completed',
    agentId: run.agentId,
    turnId,
    outcome: 'completed',
  })
  f.repo.recordNativeEffects(runId, 'settled')
  expect(f.repo.findRun(runId)).toMatchObject({
    status: 'completed',
    dispatchPhase: 'ended',
    nativeEffectsState: 'settled',
  })
  const message = f.db.drizzle
    .select()
    .from(conversationMessages)
    .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
    .get()
  if (!message) throw Error('Normal source publication did not produce an assistant Message.')
  expect(message).toMatchObject({ content: text, state: 'complete', agentId: run.agentId })
  return message
}

function addComment(
  f: SessionFixture,
  messageId: string,
  text: string,
  commentBody = 'Please address this exact answer.',
) {
  const commentId = randomUUID()
  f.repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId,
    expectedCommentsRevision: drafts(f).commentsRevision,
    body: commentBody,
    anchor: {
      type: 'message',
      messageId,
      contentHash: digest(text),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 8,
      quote: text.slice(0, 8),
    },
  })
  return commentId
}

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  databases.add(db)
  const sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Prepared input',
    directoryPath: '/prepared-input-fixture',
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Prepared input', createdAt },
    settings,
  )
  const f = { db, repo: db.conversationRepository, sessionId }
  const sourceRun = f.repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'The earlier explicitly addressed request.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'claude',
    route: { type: 'agent', agentId: 'claude' },
    settingsRevision: 1,
    model: null,
    effort: null,
  }).run
  const answer = 'Complete original assistant answer, including its final sentence.'
  const sourceMessage = complete(f, sourceRun.id, answer)
  const commentId = addComment(f, sourceMessage.id, answer)
  f.repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  const input = conversationSendInputSchema.parse({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Resolve the saved Comment without changing the task.\nKeep this final line. 🧭',
    expectedCommentsRevision: drafts(f).commentsRevision,
    commentIds: [commentId],
    route: { type: 'primary' },
    routeIntent: 'implicit',
    composerRevision: 7,
  })
  return { ...f, sourceRun, sourceMessage, answer, commentId, input }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function prepare(f: Fixture, input = f.input) {
  return f.repo.prepareInputDispatch(input, randomUUID(), ['codex', 'claude'])
}

function admission(
  f: Fixture,
  receipt: PreparedInputDispatch,
  proposal?: InputRoutingProposal,
  input = f.input,
): BeginRunInput {
  return {
    ...input,
    preparedInput: receipt,
    ...(proposal ? { inputRouting: proposal } : {}),
    agentId: f.repo.preparedInputRecipient(receipt, proposal),
    settingsRevision: receipt.metadata.settingsRevision,
    model: null,
    effort: null,
  }
}

async function evaluate(f: Fixture, receipt = prepare(f)) {
  const handoff = f.repo.preparedInputHandoff(receipt.batchId)
  const deadlineAt = Date.now() + 15_000
  const material = await f.repo.readPreparedInputDecisionSources(receipt, candidates, {
    signal: new AbortController().signal,
    deadlineAt,
  })
  const reserved = f.repo.reserveEvaluation({
    handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint,
    inputSha256: material.inputSha256,
    deadlineAt,
  })
  if (reserved.status !== 'reserved') throw Error('Expected one admitted input evaluation.')
  expect(f.repo.dispatchEvaluation(reserved.evaluation.id).created).toBe(true)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'route_claude',
  })
  const proposal = inputRoutingProposalSchema.parse({
    version: 'input-routing-v1',
    evaluationId: reserved.evaluation.id,
    handoffId: handoff.id,
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    candidateId: 'route_claude',
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint,
    deadlineAt,
  })
  return { receipt, handoff, material, proposal, evaluationId: reserved.evaluation.id }
}

async function informationRequest(
  f: Fixture,
  change: {
    content?: string
    declaration?: import('@pact/contracts').UserInformationDeclaration | null
    selectedFieldId?: string
  } = {},
) {
  const declaration =
    change.declaration === undefined
      ? {
          version: 'user-information-v1' as const,
          id: randomUUID(),
          kind: 'user_supplied_value' as const,
          question: 'What launch date should be used?',
          input: 'text' as const,
          options: [],
          state: { status: 'unanswered' as const },
        }
      : change.declaration
  f.input = {
    ...f.input,
    content: change.content ?? 'Wait for my user-supplied launch date before proceeding.',
    ...(declaration ? { userInformation: declaration } : {}),
  }
  const receipt = prepare(f),
    handoff = f.repo.preparedInputHandoff(receipt.batchId),
    deadlineAt = Date.now() + 15_000
  const material = await f.repo.readPreparedInputDecisionSources(
    receipt,
    [
      ...candidates,
      { id: 'clarify_prepared_input', description: 'Ask for the explicitly user-supplied value.' },
    ],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint,
    inputSha256: material.inputSha256,
    deadlineAt,
  })
  if (reserved.status !== 'reserved') throw Error('Expected one admitted information evaluation.')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'clarify_prepared_input',
  })
  const request = {
    receipt,
    original: f.input,
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    evaluation: {
      evaluationId: reserved.evaluation.id,
      handoffId: handoff.id,
      configurationGeneration: f.repo.schedulingConfigurationGeneration(),
      configurationFingerprint,
      deadlineAt,
    },
    recommendation: {
      candidateId: 'clarify_prepared_input',
      highlights: [],
      information: { fieldId: change.selectedFieldId ?? declaration?.id ?? randomUUID() },
    },
  }
  return { receipt, request }
}

async function information(f: Fixture) {
  const journalCount = businessFacts(f).journal.length
  const { receipt, request } = await informationRequest(f)
  const card = f.repo.proposePreparedInputInformation(request)
  expect(businessFacts(f).journal).toHaveLength(journalCount)
  return { receipt, card, request }
}

function informationAnswer(card: RelaySchedulingDecision, text?: string) {
  if (card.request.category !== 'necessary_information')
    throw Error('Expected the typed information consumer.')
  return {
    reference: { sessionId: card.sessionId, decisionId: card.decisionId, revision: card.revision },
    clientOperationId: randomUUID(),
    answer:
      text === undefined
        ? { kind: 'cancel' as const }
        : { kind: 'text' as const, fieldId: card.request.field.fieldId, text },
  }
}

function continueRequest(f: Fixture) {
  const current = f.repo.preparedInputContinuation(f.sessionId)!
  return {
    sessionId: f.sessionId,
    batchId: current.batchId,
    expectedRevision: current.revision,
    operationId: randomUUID(),
    expectedSettingsRevision: current.settingsRevision,
    expectedQueueRevision: current.queueRevision,
    expectedContinuationFingerprint: current.continuationFingerprint,
  }
}

describe('saved ordinary input information consumer', () => {
  it('checks the scheduling record budget before offering a valid large user declaration', async () => {
    const f = await fixture(),
      declaration = {
        version: 'user-information-v1' as const,
        id: randomUUID(),
        kind: 'user_reserved_choice' as const,
        question: '界'.repeat(512),
        input: 'single' as const,
        options: Array.from({ length: 6 }, (_, index) => ({
          id: randomUUID(),
          label: `项${index}${'界'.repeat(90)}`,
        })),
        state: { status: 'unanswered' as const },
      },
      { receipt, request } = await informationRequest(f, { declaration })
    expect(() => f.repo.proposePreparedInputInformation(request)).toThrow(
      /no longer current|metadata contract/u,
    )
    expect(f.repo.preparedInformationOpportunity(receipt)).toBeUndefined()
    const run = f.repo.beginRun(admission(f, receipt)).run
    const reference = f.repo.readFrozenInputBatch(run.id, receipt.batchId).userInformation!
    const page = f.repo.readPage({
      scope: 'collaboration-text',
      sessionId: f.sessionId,
      runId: run.id,
      document: reference,
      offset: 0,
    })
    if (page.scope !== 'collaboration-text') throw Error('Missing full user declaration.')
    expect(JSON.parse(page.text)).toEqual(declaration)
  })

  it('admits a real user field with an empty original body and a complete current Comment', async () => {
    const f = await fixture(),
      { request, receipt } = await informationRequest(f, { content: '' })
    const card = f.repo.proposePreparedInputInformation(request)
    expect(card.request.category).toBe('necessary_information')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toEqual(card)
    expect(f.repo.heldPreparedInputPatch(f.input)?.sendDisposition).toBe('held_for_information')
    expect(body(f, receipt.batchId).text).toBe('')
  })

  it.each([
    'Compare the existing APIs using the supplied reports; determine facts from the authorized sources.',
    'Wait for my user-supplied launch date before proceeding.',
    'Quoted historical user text: I reserve the launch date for myself.',
  ])('does not create a field from unstructured text: %s', async (content) => {
    const f = await fixture(),
      { request, receipt } = await informationRequest(f, { content, declaration: null })
    expect(f.repo.preparedInformationOpportunity(receipt)).toBeUndefined()
    expect(() => f.repo.proposePreparedInputInformation(request)).toThrow('no longer current')
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(f.repo.heldPreparedInputPatch(f.input)).toBeUndefined()
    const run = f.repo.beginRun(admission(f, receipt)).run
    expect(run.agentId).toBe('codex')
    expect(businessFacts(f).runs).toHaveLength(2)
  })

  it('rejects a different selected field without holding the original Send', async () => {
    const f = await fixture(),
      { request, receipt } = await informationRequest(f, { selectedFieldId: randomUUID() })
    expect(f.repo.preparedInformationOpportunity(receipt)?.fieldId).toBe(
      f.input.userInformation!.id,
    )
    expect(() => f.repo.proposePreparedInputInformation(request)).toThrow('no longer current')
    expect(() => f.repo.proposePreparedInputInformation(request)).toThrowError(
      expect.objectContaining({ informationAdviceRefusal: 'field_mismatch' }),
    )
    expect(f.repo.heldPreparedInputPatch(f.input)).toBeUndefined()
    const run = f.repo.beginRun(admission(f, receipt)).run
    const index = f.repo.readFrozenInputBatch(run.id, receipt.batchId)
    expect(index.userInformation).toBeDefined()
    expect(f.repo.sourceDocumentAuthorized(run.id, index.userInformation!)).toBe(true)
    const document = f.repo.readPage({
      scope: 'collaboration-text',
      sessionId: f.sessionId,
      runId: run.id,
      document: index.userInformation!,
      offset: 0,
    })
    if (document.scope !== 'collaboration-text') throw Error('Missing exact declaration source.')
    expect(JSON.parse(document.text)).toEqual(f.input.userInformation)
    expect(() =>
      f.repo.beginRun({
        ...admission(f, receipt),
        userInformation: { ...f.input.userInformation!, question: 'Changed after dispatch' },
      }),
    ).toThrow('different user declaration')
  })

  it('keeps an already supplied value as a complete user source without admitting a question', async () => {
    const f = await fixture(),
      declaration = {
        version: 'user-information-v1' as const,
        id: randomUUID(),
        kind: 'user_supplied_value' as const,
        question: 'What launch date should be used?',
        input: 'text' as const,
        options: [],
        state: { status: 'answered' as const, value: '2027-04-12' },
      },
      { request, receipt } = await informationRequest(f, { declaration })
    expect(f.repo.preparedInformationOpportunity(receipt)).toBeUndefined()
    expect(() => f.repo.proposePreparedInputInformation(request)).toThrow('no longer current')
    const run = f.repo.beginRun(admission(f, receipt)).run
    expect(f.repo.readFrozenInputBatch(run.id, receipt.batchId).userInformation).toBeDefined()
  })

  it('Cancel closes the old request once and a fresh Send consumes the current restored and newer drafts', async () => {
    const f = await fixture(),
      { receipt, card } = await information(f),
      original = body(f, receipt.batchId),
      pins = members(f, receipt.batchId),
      answer = informationAnswer(card)
    expect(f.repo.heldPreparedInputPatch(f.input)?.sendDisposition).toBe('held_for_information')
    expect(f.repo.answerRelaySchedulingDecision(answer).result).toMatchObject({
      disposition: 'cancelled',
      runId: null,
    })
    expect(f.repo.answerRelaySchedulingDecision(answer).created).toBe(false)
    expect(f.repo.preparedInputContinuation(f.sessionId)).toBeNull()
    expect(batch(f, receipt.batchId)).toMatchObject({
      dispatchState: 'cancelled',
      state: 'closed',
      bodyState: 'withdrawn',
      runId: null,
    })
    expect(body(f, receipt.batchId)).toEqual(original)
    expect(members(f, receipt.batchId)).toEqual(pins)
    expect(businessFacts(f).runs).toHaveLength(1)
    expect(() => prepare(f)).toThrow(/ended without sending/u)
    expect(() => f.repo.beginRun(admission(f, receipt))).toThrow(
      /This input preparation has ended/u,
    )
    const restored = drafts(f).comments
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      body: 'Please address this exact answer.',
      status: 'draft',
    })
    expect(restored[0]!.id).not.toBe(f.commentId)
    expect(() =>
      f.repo.continuePreparedInput({
        sessionId: f.sessionId,
        batchId: receipt.batchId,
        expectedRevision: 1,
        operationId: randomUUID(),
        expectedSettingsRevision: 1,
        expectedQueueRevision: 0,
        expectedContinuationFingerprint: 'a'.repeat(64),
      }),
    ).toThrow(/changed/u)
    const newer = addComment(
        f,
        f.sourceMessage.id,
        f.answer,
        'Include this newer Comment on Send.',
      ),
      next = {
        ...f.input,
        clientMessageId: randomUUID(),
        batchId: randomUUID(),
        content: 'Send this current edited draft.',
        userInformation: undefined,
        expectedCommentsRevision: drafts(f).commentsRevision,
        commentIds: [restored[0]!.id, newer],
        composerRevision: 8,
      },
      prepared = prepare(f, next),
      run = f.repo.beginRun(admission(f, prepared, undefined, next)).run
    expect(run.userMessageId).toBe(next.clientMessageId)
    expect(run.userMessageId).not.toBe(f.input.clientMessageId)
    expect(f.repo.beginRun(admission(f, prepared, undefined, next)).created).toBe(false)
    expect(f.repo.readFrozenInputBatch(run.id, prepared.batchId).batch.memberCount).toBe(2)
    expect(drafts(f).comments).toEqual([])
    expect(f.repo.answerRelaySchedulingDecision(answer).result).toMatchObject({
      disposition: 'cancelled',
      runId: null,
    })
    expect(businessFacts(f).runs).toHaveLength(2)
  })

  it('an aborted preparation with reason cancelled still pauses and permits explicit recovery', async () => {
    const f = await fixture(),
      { receipt } = await information(f)
    expect(f.repo.cancelPreparedInputDispatch(receipt, 'cancelled')).toBe(true)
    expect(batch(f, receipt.batchId).dispatchState).toBe('paused')
    expect(f.repo.preparedInputContinuation(f.sessionId)).toMatchObject({
      canContinue: true,
      phase: 'paused',
    })
    f.repo.recoverInterruptedRuns()
    expect(batch(f, receipt.batchId).dispatchState).toBe('paused')
    expect(f.repo.continuePreparedInput(continueRequest(f)).created).toBe(true)
  })

  it('cold recovery retires a legacy real Cancel without recreating edited or deleted Comment copies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-information-legacy-cancel-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath),
      { receipt, card } = await information(f),
      original = batch(f, receipt.batchId),
      cancelled = informationAnswer(card)
    f.repo.answerRelaySchedulingDecision(cancelled)
    const copy = drafts(f).comments[0]!
    f.repo.removeCommentDraft({
      sessionId: f.sessionId,
      commentId: copy.id,
      expectedCommentsRevision: drafts(f).commentsRevision,
    })
    const newer = addComment(f, f.sourceMessage.id, f.answer, 'Keep this newer draft exactly.')
    f.db.drizzle
      .update(conversationInputBatches)
      .set({
        dispatchState: 'paused',
        state: original.state,
        bodyState: original.bodyState,
        closedAt: original.closedAt,
        dispatchMetadataJson: original.dispatchMetadataJson,
      })
      .where(eq(conversationInputBatches.id, receipt.batchId))
      .run()
    expect(f.repo.preparedInputContinuation(f.sessionId)).toBeNull()
    expect(() => prepare(f)).toThrow(/ended without sending/u)
    const expected = drafts(f).comments
    expect(expected.map((item) => item.id)).toEqual([newer])
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(db)
    const current = { db, repo: db.conversationRepository, sessionId: f.sessionId }
    expect(current.repo.recoverInterruptedRuns()).toContain(f.sessionId)
    expect(batch(current, receipt.batchId).dispatchState).toBe('cancelled')
    expect(current.repo.preparedInputContinuation(f.sessionId)).toBeNull()
    expect(current.repo.answerRelaySchedulingDecision(cancelled).created).toBe(false)
    expect(current.repo.recoverInterruptedRuns()).toEqual([])
    expect(drafts(current).comments).toEqual(expected)
    const plan = db.drizzle.all(sql`EXPLAIN QUERY PLAN SELECT * FROM conversation_input_batches
      WHERE dispatch_state = 'paused' AND session_id > '' ORDER BY session_id LIMIT 25`)
    expect(JSON.stringify(plan)).toContain('conversation_input_batches_paused_session_idx')
  })

  it.each(['cancel', 'answer'] as const)(
    'the first %s transaction wins and a conflicting answer cannot dispatch the old request',
    async (first) => {
      const f = await fixture(),
        { card } = await information(f),
        cancel = informationAnswer(card),
        answer = informationAnswer(card, '2027-04-12')
      const won = f.repo.answerRelaySchedulingDecision(first === 'cancel' ? cancel : answer)
      expect(won.created).toBe(true)
      expect(() =>
        f.repo.answerRelaySchedulingDecision(first === 'cancel' ? answer : cancel),
      ).toThrow(/already has a different answer/u)
      expect(
        f.repo.answerRelaySchedulingDecision(first === 'cancel' ? cancel : answer).created,
      ).toBe(false)
      expect(businessFacts(f).runs).toHaveLength(1)
      expect(f.repo.preparedInputContinuation(f.sessionId)?.phase ?? null).toBe(
        first === 'cancel' ? null : 'preparing',
      )
    },
  )

  it('stores an answer as an independent exact user source, binding it only to the original admitted Run', async () => {
    const f = await fixture(),
      { receipt, card } = await information(f),
      original = body(f, receipt.batchId),
      answer = informationAnswer(
        card,
        '  @claude /build 2027-04-12\nLiteral answer, no new permissions.  ',
      ),
      saved = f.repo.answerRelaySchedulingDecision(answer)
    if (!('preparedInput' in saved) || !saved.preparedInput)
      throw Error('Expected the existing original-input consumer.')
    expect(saved.result).toMatchObject({ disposition: 'confirmed', runId: null })
    expect(body(f, receipt.batchId)).toEqual(original)
    expect(f.repo.answerRelaySchedulingDecision(answer).created).toBe(false)
    const run = f.repo.beginRun(
        admission(f, saved.preparedInput.receipt, undefined, saved.preparedInput.input),
      ).run,
      document = f.repo.preparedAnswerForRun(run.id)!.document,
      row = f.repo.collaborationDocumentRow(f.sessionId, document)
    expect(
      f.repo.readFrozenInputBatch(run.id, saved.preparedInput.receipt.batchId).clarificationAnswer,
    ).toEqual(document)
    expect(row.sourceRunId).toBe(run.id)
    expect(f.repo.preparedAnswerForRun(run.id)).toMatchObject({
      document,
      answer: answer.answer.kind === 'text' ? answer.answer.text : undefined,
    })
    const text = f.db.drizzle
      .select()
      .from(conversationBodyParts)
      .where(eq(conversationBodyParts.inputId, document.id))
      .all()
      .map((item) => item.text)
      .join('')
    expect(JSON.parse(text).answer).toBe(
      answer.answer.kind === 'text' ? answer.answer.text : undefined,
    )
    expect(run.agentId).toBe('codex')
    expect(run.collaboration).toBeUndefined()
    expect(
      f.repo.relayDecisionReceipt({
        sessionId: f.sessionId,
        decisionId: card.decisionId,
        clientOperationId: answer.clientOperationId,
      })?.runId,
    ).toBe(run.id)
  })

  it.each(['owner', 'run', 'hash', 'question'] as const)(
    'rejects a changed bound clarification %s instead of projecting it as current user input',
    async (fault) => {
      const f = await fixture(),
        { card } = await information(f),
        saved = f.repo.answerRelaySchedulingDecision(informationAnswer(card, '2027-04-12'))
      if (!('preparedInput' in saved) || !saved.preparedInput) throw Error('Missing saved input.')
      const run = f.repo.beginRun(
          admission(f, saved.preparedInput.receipt, undefined, saved.preparedInput.input),
        ).run,
        value = f.repo.preparedAnswerForRun(run.id)!
      if (fault === 'owner')
        f.db.drizzle
          .update(conversationBodyInputs)
          .set({ ownerKey: 'different-owner' })
          .where(eq(conversationBodyInputs.id, value.document.id))
          .run()
      if (fault === 'run') {
        const source = f.repo.read(f.sessionId).runs.find((item) => item.id !== run.id)!
        f.db.drizzle
          .update(conversationBodyInputs)
          .set({ sourceRunId: source.id })
          .where(eq(conversationBodyInputs.id, value.document.id))
          .run()
      }
      if (fault === 'hash')
        f.db.drizzle
          .update(conversationBodyInputs)
          .set({ hash: 'f'.repeat(64) })
          .where(eq(conversationBodyInputs.id, value.document.id))
          .run()
      if (fault === 'question') {
        const text = JSON.stringify({ question: 'An unrelated field', answer: value.answer }),
          bytes = Buffer.byteLength(text),
          doc = { ...value.document, sha256: digest(text), bytes, chars: text.length },
          storedBatch = f.db.drizzle
            .select()
            .from(conversationInputBatches)
            .where(eq(conversationInputBatches.runId, run.id))
            .get()!,
          control = JSON.parse(storedBatch.dispatchInformationJson!)
        f.db.drizzle
          .update(conversationBodyParts)
          .set({ text, endBytes: bytes })
          .where(eq(conversationBodyParts.inputId, doc.id))
          .run()
        f.db.drizzle
          .update(conversationBodyInputs)
          .set({ hash: doc.sha256, bytes, chars: text.length })
          .where(eq(conversationBodyInputs.id, doc.id))
          .run()
        f.db.drizzle
          .update(conversationInputBatches)
          .set({ dispatchInformationJson: JSON.stringify({ ...control, answerDocument: doc }) })
          .where(eq(conversationInputBatches.id, storedBatch.id))
          .run()
      }
      expect(() => f.repo.preparedAnswerForRun(run.id)).toThrow(RunOperationConflictError)
    },
  )

  it('keeps failed Continue nonces terminal and allows a later explicit new action', async () => {
    const f = await fixture(),
      { receipt } = await information(f)
    expect(f.repo.pausePreparedInputForStop(f.sessionId)).toBe(true)
    expect(batch(f, receipt.batchId).dispatchState).toBe('paused')
    const operation = continueRequest(f),
      claim = f.repo.continuePreparedInput(operation)
    if (!claim.created) throw Error('Expected one preparation claim.')
    f.repo.cancelPreparedInputDispatch(claim.receipt, 'preparation_failed')
    expect(f.repo.continuePreparedInput(operation).created).toBe(false)
    expect(businessFacts(f).runs).toHaveLength(1)
    expect(f.repo.preparedInputContinuation(f.sessionId)).toMatchObject({
      phase: 'paused',
      canContinue: true,
    })
    const next = f.repo.continuePreparedInput(continueRequest(f))
    expect(next.created).toBe(true)
    expect(f.repo.continuePreparedInput(operation).created).toBe(false)
  })

  it('preserves original members on restart and never resumes a user pause when Relay closes', async () => {
    const f = await fixture(),
      { receipt } = await information(f),
      pins = members(f, receipt.batchId)
    f.repo.recoverInterruptedRuns()
    expect(batch(f, receipt.batchId).dispatchState).toBe('paused')
    expect(members(f, receipt.batchId)).toEqual(pins)
    f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false, selection: null })
    expect(f.repo.pendingPreparedInformationDefaults()).toEqual([])
    expect(f.repo.takePreparedInformationDefault(receipt.batchId)).toBeUndefined()
    expect(businessFacts(f).runs).toHaveLength(1)
  })

  it('closes an unused card on disabling Relay and admits its original default exactly once', async () => {
    const f = await fixture(),
      { receipt } = await information(f)
    f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false, selection: null })
    expect(f.repo.pendingPreparedInformationDefaults()).toEqual([
      { sessionId: f.sessionId, batchId: receipt.batchId },
    ])
    const claim = f.repo.takePreparedInformationDefault(receipt.batchId)!
    if ('paused' in claim)
      throw Error('The unchanged original admission must use its legal default.')
    expect(claim.input).toEqual({ ...f.input, batchId: receipt.batchId })
    expect(f.repo.takePreparedInformationDefault(receipt.batchId)).toBeUndefined()
    f.repo.beginRun(admission(f, claim.receipt, undefined, claim.input))
    expect(businessFacts(f).runs).toHaveLength(2)
  })

  it('reads bounded original source pages and rejects foreign identities and stale revisions', async () => {
    const f = await fixture(),
      { receipt } = await information(f)
    f.repo.pausePreparedInputForStop(f.sessionId)
    const current = f.repo.preparedInputContinuation(f.sessionId)!,
      page = f.repo.readPage({
        scope: 'prepared-input',
        sessionId: f.sessionId,
        batchId: receipt.batchId,
        revision: current.revision,
        offset: 0,
      })
    expect(page).toMatchObject({ scope: 'prepared-input', text: f.input.content, nextOffset: null })
    expect(() =>
      f.repo.readPage({
        scope: 'prepared-input',
        sessionId: f.sessionId,
        batchId: receipt.batchId,
        revision: current.revision,
        sourceId: randomUUID(),
        offset: 0,
      }),
    ).toThrow(/belonging/u)
    expect(() =>
      f.repo.readPage({
        scope: 'prepared-input',
        sessionId: randomUUID(),
        batchId: receipt.batchId,
        revision: current.revision,
        offset: 0,
      }),
    ).toThrow(/saved input view changed/u)
    expect(() =>
      f.repo.readPage({
        scope: 'prepared-input',
        sessionId: f.sessionId,
        batchId: receipt.batchId,
        revision: current.revision - 1,
        offset: 0,
      }),
    ).toThrow(/changed/u)
  })

  it('keeps the bound answer through actual cold reopen, a new source-authorized handoff and historical Fork', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-information-cold-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath),
      { card } = await information(f),
      saved = f.repo.answerRelaySchedulingDecision(
        informationAnswer(card, '  2027-04-12\nKeep exact whitespace.  '),
      )
    if (!('preparedInput' in saved) || !saved.preparedInput)
      throw Error('Missing admitted original input.')
    const run = f.repo.beginRun(
      admission(f, saved.preparedInput.receipt, undefined, saved.preparedInput.input),
    ).run
    complete(f, run.id, 'The release note uses the supplied date.')
    const document = f.repo.preparedAnswerForRun(run.id)!.document
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(db)
    const repo = db.conversationRepository,
      row = repo.collaborationDocumentRow(f.sessionId, document)
    expect(repo.preparedAnswerForRun(run.id)?.answer).toBe('  2027-04-12\nKeep exact whitespace.  ')
    expect(
      repo.readFrozenInputBatch(run.id, repo.inputBatchForRun(run.id)!.id).clarificationAnswer,
    ).toEqual(document)
    expect(row).toMatchObject({
      purpose: 'collaboration',
      sourceRunId: run.id,
      pendingReceiptId: null,
    })
    const page = repo.readPage({
      scope: 'collaboration-text',
      sessionId: f.sessionId,
      runId: run.id,
      document,
      offset: 0,
    })
    if (page.scope !== 'collaboration-text') throw Error('Missing durable answer source page.')
    expect(digest(page.text)).toBe(document.sha256)
    expect(JSON.parse(page.text).answer).toBe('  2027-04-12\nKeep exact whitespace.  ')
    const old = repo.internalMessage(run.userMessageId, f.sessionId)!,
      draftPage = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (draftPage.scope !== 'drafts') throw Error('Missing current draft revision.')
    const next = repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Read the original supplied answer.',
      expectedCommentsRevision: draftPage.commentsRevision,
      commentIds: [],
      agentId: 'claude',
      model: null,
      effort: null,
      settingsRevision: db.sessionRepository.find(f.sessionId)!.settingsRevision,
      handoffSourceRefs: [
        { id: old.id, revision: old.contentRevision, digest: digest(old.content) },
      ],
    }).run
    expect(repo.sourceDocumentAuthorized(next.id, document)).toBe(true)
    expect(repo.preparedAnswerForRun(next.id)).toBeUndefined()
    expect(
      repo.readFrozenInputBatch(next.id, repo.inputBatchForRun(run.id)!.id).clarificationAnswer,
    ).toEqual(document)
    expect(
      repo.readFrozenInputBatch(next.id, repo.inputBatchForRun(next.id)!.id).clarificationAnswer,
    ).toBeUndefined()
    expect(JSON.stringify(repo.readRunSources(next.id))).toContain(document.id)
    complete(
      { db, repo, sessionId: f.sessionId },
      next.id,
      'The inherited user answer remains complete.',
    )
    const current = db.sessionRepository.find(f.sessionId)!,
      selection = repo.selectForkSource(
        f.sessionId,
        repo.findRun(next.id)!.responseMessageId!,
        current.settings,
        current.settingsRevision,
      )
    const boundary = (agentId: 'codex' | 'claude') => {
      const sourceRun = selection.runs[agentId],
        prefix = repo.forkResponse(sourceRun.id, selection.prepared.sequence)
      return {
        nativeSessionId: sourceRun.nativeSessionId!,
        nativeCutId: sourceRun.nativeTurnId!,
        nativeTurnId: sourceRun.nativeTurnId!,
        bindingGeneration: sourceRun.bindingGeneration,
        throughSequence: prefix.sequence,
        deliveryCursor: prefix.deliveryCursor,
        prefixHash: digest(agentId),
        prefixBytes: 100,
        prefixRecords: 2,
      }
    }
    const fork = repo.commitFork(
      randomUUID(),
      selection,
      { codex: boundary('codex'), claude: boundary('claude') },
      [],
    )
    const historical = db.drizzle
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.sessionId, fork.sessionId))
      .all()
      .find((item) => item.dispatchInformationJson !== null)!
    const copied = JSON.parse(historical.dispatchInformationJson!),
      copiedDocument = copied.answerDocument,
      copiedRow = repo.collaborationDocumentRow(fork.sessionId, copiedDocument)
    expect(
      repo.readFrozenInputBatch(copiedRow.sourceRunId!, historical.id).clarificationAnswer,
    ).toEqual(copiedDocument)
    expect(copied.continuation).toBeUndefined()
    expect(copied.draftCopies).toEqual([])
    const inherited = repo.readPage({
      scope: 'collaboration-text',
      sessionId: fork.sessionId,
      runId: copiedRow.sourceRunId!,
      document: copiedDocument,
      offset: 0,
    })
    if (inherited.scope !== 'collaboration-text') throw Error('Missing inherited answer page.')
    expect(inherited.text).toBe(page.text)
    expect(copiedDocument.sha256).toBe(document.sha256)
    db.close()
    databases.delete(db)
    const reopened = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(reopened)
    expect(
      reopened.conversationRepository.collaborationDocumentRow(fork.sessionId, copiedDocument).hash,
    ).toBe(document.sha256)
  })

  it('restores all frozen members once across Cancel, modified copies, Stop and cold restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-information-drafts-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath)
    const second = addComment(f, f.sourceMessage.id, f.answer, 'Second complete original Comment.')
    f.input = { ...f.input, commentIds: [], expectedCommentsRevision: drafts(f).commentsRevision }
    const { card, receipt } = await information(f),
      frozenMembers = members(f, receipt.batchId)
    const newer = addComment(f, f.sourceMessage.id, f.answer, 'Existing newer draft stays exact.')
    const cancelled = informationAnswer(card)
    f.repo.answerRelaySchedulingDecision(cancelled)
    const copies = drafts(f).comments
    expect(copies.map((item) => item.body)).toEqual([
      'Existing newer draft stays exact.',
      'Please address this exact answer.',
      'Second complete original Comment.',
    ])
    expect(copies.map((item) => item.id)).not.toContain(f.commentId)
    expect(copies.map((item) => item.id)).not.toContain(second)
    expect(copies[0]!.id).toBe(newer)
    const edited = copies[1]!
    f.repo.saveCommentDraft({
      mode: 'edit',
      sessionId: f.sessionId,
      commentId: edited.id,
      expectedCommentsRevision: drafts(f).commentsRevision,
      body: 'User-edited restored draft.',
    })
    f.repo.answerRelaySchedulingDecision(cancelled)
    expect(f.repo.preparedInputContinuation(f.sessionId)).toBeNull()
    expect(f.repo.pausePreparedInputForStop(f.sessionId)).toBe(false)
    expect(batch(f, receipt.batchId).dispatchState).toBe('cancelled')
    expect(members(f, receipt.batchId)).toEqual(frozenMembers)
    const expectedDrafts = drafts(f).comments.map((item) => ({
      id: item.id,
      body: item.body,
      anchor: item.anchor,
    }))
    expect(expectedDrafts).toHaveLength(3)
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(db)
    db.conversationRepository.recoverInterruptedRuns()
    expect(
      drafts({ db, repo: db.conversationRepository, sessionId: f.sessionId }).comments.map(
        (item) => ({ id: item.id, body: item.body, anchor: item.anchor }),
      ),
    ).toEqual(expectedDrafts)
  })

  it('rolls back a partial Comment restoration failure without acknowledging Cancel or changing originals', async () => {
    const f = await fixture()
    addComment(f, f.sourceMessage.id, f.answer, 'Second original Comment.')
    f.input = { ...f.input, expectedCommentsRevision: drafts(f).commentsRevision, commentIds: [] }
    const { card, receipt } = await information(f),
      original = batch(f, receipt.batchId),
      pinned = members(f, receipt.batchId),
      answer = informationAnswer(card)
    f.db.drizzle.run(sql`CREATE TEMP TRIGGER refuse_second_information_draft
      BEFORE INSERT ON anchored_comments
      WHEN NEW.pending_receipt_id IS NULL AND
        (SELECT count(*) FROM anchored_comments WHERE pending_receipt_id IS NULL AND sent_with_message_id IS NULL) >= 1
      BEGIN SELECT RAISE(ABORT, 'Controlled second Comment restoration failure'); END`)
    try {
      expect(() => f.repo.answerRelaySchedulingDecision(answer)).toThrow(
        /Controlled second Comment restoration failure/u,
      )
      expect(drafts(f).comments).toEqual([])
      expect(batch(f, receipt.batchId)).toEqual(original)
      expect(members(f, receipt.batchId)).toEqual(pinned)
      expect(
        f.repo.relayDecisionReceipt({
          sessionId: f.sessionId,
          decisionId: card.decisionId,
          clientOperationId: answer.clientOperationId,
        }),
      ).toBeUndefined()
    } finally {
      f.db.drizzle.run(sql`DROP TRIGGER refuse_second_information_draft`)
    }
    expect(f.repo.answerRelaySchedulingDecision(answer).result.disposition).toBe('cancelled')
    expect(drafts(f).comments).toHaveLength(2)
    expect(members(f, receipt.batchId)).toEqual(pinned)
  })
})

function businessFacts(f: SessionFixture) {
  return {
    runs: f.db.drizzle.select().from(agentRuns).where(eq(agentRuns.sessionId, f.sessionId)).all(),
    messages: f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, f.sessionId))
      .all(),
    journal: f.db.drizzle
      .select()
      .from(agentEventJournal)
      .where(eq(agentEventJournal.sessionId, f.sessionId))
      .all(),
  }
}

function batch(f: SessionFixture, id: string) {
  const row = f.db.drizzle
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, id))
    .get()
  if (!row) throw Error('Missing durable input Batch.')
  return row
}

function body(f: SessionFixture, batchId: string) {
  const inputId = batch(f, batchId).inputId!
  const row = f.db.drizzle
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, inputId))
    .get()
  const parts = f.db.drizzle
    .select()
    .from(conversationBodyParts)
    .where(eq(conversationBodyParts.inputId, inputId))
    .orderBy(asc(conversationBodyParts.offset))
    .all()
  return { row, parts, text: parts.map((part) => part.text).join('') }
}

function members(f: SessionFixture, batchId: string) {
  return f.db.drizzle
    .select()
    .from(conversationInputBatchMembers)
    .where(eq(conversationInputBatchMembers.batchId, batchId))
    .orderBy(asc(conversationInputBatchMembers.ordinal))
    .all()
}

describe('prepared ordinary input through repository admission', () => {
  it('freezes real source material and accounts for a runless evaluation without a new Run, Message or Agent journal', async () => {
    const f = await fixture(),
      before = businessFacts(f)
    const e = await evaluate(f)
    expect(
      f.repo.prepareInputDispatch(f.input, e.receipt.metadata.ownerId, ['codex', 'claude']),
    ).toEqual(e.receipt)
    expect(() => f.repo.prepareInputDispatch(f.input, randomUUID(), ['codex', 'claude'])).toThrow(
      'original input preparation owns this message ID',
    )
    expect(e.handoff).toMatchObject({
      slot: 'input_dispatch',
      freshnessGuard: { kind: 'prepared_input', runId: null, batchId: e.receipt.batchId },
    })
    expect(e.material.input.sources.map((source) => source.text)).toEqual(
      expect.arrayContaining([f.input.content, f.repo.comment(f.commentId)!.body, f.answer]),
    )
    expect(e.material.sources.map((source) => source.kind)).toEqual([
      'input',
      'comment',
      'anchor',
      'message',
    ])
    expect(e.material.sources.find((source) => source.kind === 'message')).toMatchObject({
      identity: f.sourceMessage.id,
      actor: 'claude',
      sha256: digest(f.answer),
    })
    expect(body(f, e.receipt.batchId).text).toBe(f.input.content)
    expect(body(f, e.receipt.batchId).row).toMatchObject({
      sealed: true,
      hash: digest(f.input.content),
      pendingReceiptId: f.input.clientMessageId,
      committedMessageId: null,
    })
    expect(batch(f, e.receipt.batchId)).toMatchObject({
      dispatchState: 'prepared',
      runId: null,
      messageId: null,
      taskId: null,
      memberCount: 1,
    })
    expect(businessFacts(f)).toEqual(before)
    expect(f.repo.schedulingBudget(e.handoff.budgetSubjectId)).toMatchObject({
      evaluationCalls: 1,
      automaticResends: 0,
    })
    expect(f.repo.dispatchEvaluation(e.evaluationId).created).toBe(false)
    expect(f.repo.schedulingBudget(e.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toMatchObject([
      { called: true, active: false, outcome: 'completed', handoffId: e.handoff.id },
    ])
    expect(businessFacts(f)).toEqual(before)
  })

  it('atomically dispatches one selected Run and reads the same nonce after a lost ACK without changing the primary setting', async () => {
    const f = await fixture(),
      before = businessFacts(f),
      originalSettings = f.db.sessionRepository.find(f.sessionId)!.settings
    const e = await evaluate(f),
      input = admission(f, e.receipt, e.proposal)
    expect(input.agentId).toBe('claude')
    const first = f.repo.beginRun(input)
    expect(first.created).toBe(true)
    expect(first.run).toMatchObject({
      agentId: 'claude',
      userMessageId: f.input.clientMessageId,
      settingsRevision: 1,
    })
    expect(f.db.sessionRepository.find(f.sessionId)).toMatchObject({
      settingsRevision: 1,
      settings: originalSettings,
    })
    expect(f.db.sessionRepository.find(f.sessionId)!.settings.primaryAgentId).toBe('codex')
    expect(batch(f, e.receipt.batchId)).toMatchObject({
      dispatchState: 'dispatched',
      actor: 'claude',
      runId: first.run.id,
      messageId: first.run.userMessageId,
    })
    expect(body(f, e.receipt.batchId).row).toMatchObject({
      committedMessageId: first.run.userMessageId,
      pendingReceiptId: null,
    })
    expect(f.repo.commentsForMessage(first.run.userMessageId).map((comment) => comment.id)).toEqual(
      [f.commentId],
    )
    expect(f.repo.handoffReceipt(e.handoff.id)).toMatchObject({
      action: 'input:route_claude',
      runId: first.run.id,
    })
    const committed = businessFacts(f)
    expect(committed.runs).toHaveLength(before.runs.length + 1)
    expect(committed.messages).toHaveLength(before.messages.length + 1)
    expect(
      committed.journal.filter(
        (event) =>
          event.runId === first.run.id && event.eventType === 'scheduling.input_dispatch_adopted',
      ),
    ).toHaveLength(1)
    expect(f.repo.beginRun(input)).toMatchObject({ created: false, run: { id: first.run.id } })
    expect(f.repo.submittedRunReceipt(f.input)).toMatchObject({
      created: false,
      run: { id: first.run.id },
    })
    expect(f.repo.dispatchEvaluation(e.evaluationId).created).toBe(false)
    expect(f.repo.schedulingBudget(e.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(businessFacts(f)).toEqual(committed)
  })

  it('keeps later Comment drafts separate while admitting exactly the previously frozen Comment set', async () => {
    const f = await fixture(),
      e = await evaluate(f)
    const laterId = addComment(
      f,
      f.sourceMessage.id,
      f.answer,
      'A later independent Comment remains in the editor.',
    )
    expect(drafts(f).commentsRevision).toBeGreaterThan(f.input.expectedCommentsRevision)
    expect(f.repo.preparedInputHandoff(e.receipt.batchId)).toEqual(e.handoff)
    const admitted = f.repo.beginRun(admission(f, e.receipt, e.proposal))
    expect(
      f.repo.commentsForMessage(admitted.run.userMessageId).map((comment) => comment.id),
    ).toEqual([f.commentId])
    expect(members(f, e.receipt.batchId).map((member) => member.commentId)).toEqual([f.commentId])
    expect(
      f.db.drizzle.select().from(anchoredComments).where(eq(anchoredComments.id, laterId)).get(),
    ).toMatchObject({
      sentWithMessageId: null,
      pendingReceiptId: null,
      body: 'A later independent Comment remains in the editor.',
    })
    expect(f.repo.comment(laterId)).toBeDefined()
    expect(f.repo.beginRun(admission(f, e.receipt, e.proposal))).toMatchObject({
      created: false,
      run: { id: admitted.run.id },
    })
  })

  it('cancels only its own Comment pins and members, retains the sealed body and permits a fresh Send nonce', async () => {
    const f = await fixture()
    const historical = f.repo.beginRun({
      ...f.input,
      clientMessageId: randomUUID(),
      agentId: 'claude',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    complete(f, historical.run.id, 'Complete earlier ordinary follow-up answer.')
    const historicalBatch = f.repo.inputBatchForRun(historical.run.id)!
    const historicalMembers = members(f, historicalBatch.id)
    expect(historicalMembers.map((member) => member.commentId)).toEqual([f.commentId])
    const pinnedId = addComment(f, f.sourceMessage.id, f.answer, 'Frozen by the cancelled request.')
    const input: ConversationSendInput = {
      ...f.input,
      clientMessageId: randomUUID(),
      commentIds: [pinnedId],
      expectedCommentsRevision: drafts(f).commentsRevision,
    }
    const receipt = prepare(f, input),
      originalBody = body(f, receipt.batchId),
      before = businessFacts(f)
    const laterId = addComment(f, f.sourceMessage.id, f.answer, 'Created after preparation.')
    expect(() =>
      f.repo.saveCommentDraft({
        mode: 'edit',
        sessionId: f.sessionId,
        commentId: pinnedId,
        expectedCommentsRevision: drafts(f).commentsRevision,
        body: 'Cannot edit a pinned Comment.',
      }),
    ).toThrow('Only an unsent Comment draft')
    f.repo.cancelPreparedInputDispatch(receipt, 'cancelled')
    f.repo.cancelPreparedInputDispatch(receipt, 'cancelled')
    expect(batch(f, receipt.batchId)).toMatchObject({
      dispatchState: 'cancelled',
      state: 'closed',
      bodyState: 'withdrawn',
      runId: null,
      messageId: null,
    })
    expect(body(f, receipt.batchId)).toEqual(originalBody)
    expect(members(f, receipt.batchId)).toEqual([])
    expect(members(f, historicalBatch.id)).toEqual(historicalMembers)
    for (const commentId of [pinnedId, laterId])
      expect(
        f.db.drizzle
          .select()
          .from(anchoredComments)
          .where(eq(anchoredComments.id, commentId))
          .get(),
      ).toMatchObject({ sentWithMessageId: null, pendingReceiptId: null })
    expect(businessFacts(f)).toEqual(before)
    expect(() => f.repo.prepareInputDispatch(input, randomUUID(), ['codex', 'claude'])).toThrow(
      'ended without sending',
    )
    expect(() => f.repo.beginRun(admission(f, receipt, undefined, input))).toThrow(
      'preparation has ended',
    )
    const fresh: ConversationSendInput = {
      ...input,
      clientMessageId: randomUUID(),
      commentIds: [pinnedId, laterId],
      expectedCommentsRevision: drafts(f).commentsRevision,
    }
    const freshReceipt = prepare(f, fresh)
    const sent = f.repo.beginRun(admission(f, freshReceipt, undefined, fresh))
    expect(sent.created).toBe(true)
    expect(sent.run.agentId).toBe('codex')
    expect(f.repo.commentsForMessage(sent.run.userMessageId).map((comment) => comment.id)).toEqual([
      pinnedId,
      laterId,
    ])
    expect(batch(f, receipt.batchId).dispatchState).toBe('cancelled')
    expect(body(f, receipt.batchId)).toEqual(originalBody)
    expect(members(f, historicalBatch.id)).toEqual(historicalMembers)
  })

  it('rejects changed body content atomically and preserves the prepared input for the exact request', async () => {
    const f = await fixture(),
      e = await evaluate(f),
      before = businessFacts(f)
    const changed = { ...f.input, content: `${f.input.content}\nChanged after advice.` }
    expect(() => f.repo.assertPreparedInputRequest(changed)).toThrow('different frozen request')
    expect(() =>
      f.repo.assertPreparedInputRequest({
        ...f.input,
        composerRevision: f.input.composerRevision! + 1,
      }),
    ).toThrow('different frozen request')
    expect(() =>
      f.repo.beginRun({ ...admission(f, e.receipt, e.proposal), content: changed.content }),
    ).toThrow('frozen Send request changed')
    expect(businessFacts(f)).toEqual(before)
    expect(batch(f, e.receipt.batchId)).toMatchObject({
      dispatchState: 'prepared',
      runId: null,
      messageId: null,
    })
    expect(body(f, e.receipt.batchId).text).toBe(f.input.content)
    expect(f.repo.beginRun(admission(f, e.receipt, e.proposal)).created).toBe(true)
  })

  it.each<{
    name: string
    change: (f: Fixture) => Partial<BeginRunInput>
    error: string
  }>([
    {
      name: 'removed Comment identities',
      change: () => ({ commentIds: [] }),
      error: 'frozen Send request changed',
    },
    {
      name: 'additional Comment identities',
      change: (f) => ({ commentIds: [...f.input.commentIds, randomUUID()] }),
      error: 'frozen Send request changed',
    },
    {
      name: 'disabled Comment freezing',
      change: () => ({ freezeDrafts: false }),
      error: 'A preserved draft cannot also be included in this message',
    },
    {
      name: 'an explicit Agent route',
      change: () => ({ route: { type: 'agent', agentId: 'claude' } }),
      error: 'frozen Send request changed',
    },
    {
      name: 'an all-Agent route',
      change: () => ({ route: { type: 'all' } }),
      error: 'frozen Send request changed',
    },
    {
      name: 'a different business model',
      change: () => ({ model: 'changed-business-model' }),
      error: 'frozen recipient settings changed',
    },
    {
      name: 'a different business effort',
      change: () => ({ effort: 'high' }),
      error: 'frozen recipient settings changed',
    },
    {
      name: 'an injected source Message',
      change: (f) => ({ sourceMessageId: f.sourceMessage.id }),
      error: 'frozen Send request changed',
    },
    {
      name: 'an injected peer proposal',
      change: () => ({ sourceProposalId: randomUUID() }),
      error: 'peer request is no longer available',
    },
    {
      name: 'an injected Skill invocation',
      change: (f) => ({
        skillInvocation: {
          version: 'pact-skills-v1',
          arguments: f.input.content,
          selections: [],
          bindings: [],
        },
      }),
      error: 'frozen Send request changed',
    },
    {
      name: 'a changed draft preservation intent',
      change: () => ({ preserveDraftComments: true }),
      error: 'A preserved draft cannot also be included in this message',
    },
  ])('rejects $name without changing any frozen or business facts', async ({ change, error }) => {
    const f = await fixture(),
      e = await evaluate(f)
    const snapshot = () => ({
      business: businessFacts(f),
      prepared: batch(f, e.receipt.batchId),
      sealedBody: body(f, e.receipt.batchId),
      members: members(f, e.receipt.batchId),
      comments: f.db.drizzle
        .select()
        .from(anchoredComments)
        .where(eq(anchoredComments.sessionId, f.sessionId))
        .all(),
      session: f.db.sessionRepository.find(f.sessionId),
      nativeContexts: f.repo.nativeContexts(f.sessionId),
      handoff: f.repo.handoffReceipt(e.handoff.id),
      budget: f.repo.schedulingBudget(e.handoff.budgetSubjectId),
      evaluations: f.db.drizzle.select().from(schedulingEvaluations).all(),
    })
    const before = snapshot()
    expect(() => f.repo.beginRun({ ...admission(f, e.receipt, e.proposal), ...change(f) })).toThrow(
      error,
    )
    expect(snapshot()).toEqual(before)
    expect(f.repo.preparedInputHandoff(e.receipt.batchId)).toEqual(e.handoff)
    const accepted = f.repo.beginRun(admission(f, e.receipt, e.proposal))
    expect(accepted).toMatchObject({
      created: true,
      run: { agentId: 'claude', model: null, effort: null },
    })
    expect(businessFacts(f).runs).toHaveLength(before.business.runs.length + 1)
    expect(
      f.repo.commentsForMessage(accepted.run.userMessageId).map((comment) => comment.id),
    ).toEqual([f.commentId])
    expect(f.repo.schedulingBudget(e.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
  })

  it('rejects stale native binding facts before invoking the evaluation', async () => {
    const f = await fixture(),
      receipt = prepare(f),
      handoff = f.repo.preparedInputHandoff(receipt.batchId)
    const reserved = f.repo.reserveEvaluation({
      handoff,
      provider: 'codex',
      model: 'gpt-6-luna',
      configurationFingerprint,
    })
    if (reserved.status !== 'reserved') throw Error('Expected an evaluation reservation.')
    f.repo.markNativeContextsMissing(f.sessionId, ['claude'])
    const before = businessFacts(f)
    expect(f.repo.evaluationIsCurrent(handoff)).toBe(false)
    expect(() => f.repo.dispatchEvaluation(reserved.evaluation.id)).toThrow('handoff facts changed')
    expect(f.repo.schedulingBudget(handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(0)
    expect(businessFacts(f)).toEqual(before)
    f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'not_sent', physicalReleased: true })
  })

  it('rejects changed Session settings without consuming or rerouting the frozen request', async () => {
    const f = await fixture(),
      e = await evaluate(f)
    const current = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...current.settings,
      primaryAgentId: 'claude',
    })
    const before = businessFacts(f)
    expect(() => f.repo.preparedInputHandoff(e.receipt.batchId)).toThrow(
      'prepared input facts changed',
    )
    expect(() =>
      f.repo.beginRun({ ...admission(f, e.receipt, e.proposal), agentId: 'claude' }),
    ).toThrow('prepared input facts changed')
    expect(businessFacts(f)).toEqual(before)
    expect(batch(f, e.receipt.batchId).dispatchState).toBe('prepared')
    expect(body(f, e.receipt.batchId).text).toBe(f.input.content)
  })

  it.each(['late', 'configuration', 'source', 'input', 'candidate'] as const)(
    'rejects %s advice for the other Agent and retains the authorized original recipient',
    async (change) => {
      const f = await fixture(),
        e = await evaluate(f)
      const proposal = { ...e.proposal }
      if (change === 'late') vi.spyOn(Date, 'now').mockReturnValue(proposal.deadlineAt)
      if (change === 'configuration')
        f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false, selection: null })
      if (change === 'source') proposal.sourceFingerprint = 'b'.repeat(64)
      if (change === 'input') proposal.inputSha256 = 'b'.repeat(64)
      if (change === 'candidate') proposal.candidateId = 'route_codex'
      const before = businessFacts(f)
      expect(f.repo.preparedInputRecipient(e.receipt, proposal)).toBe('codex')
      expect(() =>
        f.repo.beginRun({ ...admission(f, e.receipt, proposal), agentId: 'claude' }),
      ).toThrow('recipient is no longer authorized')
      expect(businessFacts(f)).toEqual(before)
      expect(batch(f, e.receipt.batchId).dispatchState).toBe('prepared')
      const fallback = f.repo.beginRun(admission(f, e.receipt, proposal))
      expect(fallback.run.agentId).toBe('codex')
      expect(f.repo.schedulingBudget(e.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
      expect(
        f.repo.commentsForMessage(fallback.run.userMessageId).map((comment) => comment.id),
      ).toEqual([f.commentId])
      const events = f.db.drizzle
        .select()
        .from(agentEventJournal)
        .where(
          and(
            eq(agentEventJournal.runId, fallback.run.id),
            eq(agentEventJournal.eventType, 'scheduling.input_dispatch_adopted'),
          ),
        )
        .all()
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.payload)).toEqual({
        handoffId: e.handoff.id,
        batchId: e.receipt.batchId,
        evaluationId: null,
        candidateId: null,
        recipient: 'codex',
      })
    },
  )

  it('honors source-read cancellation and its original deadline without materializing input', async () => {
    const f = await fixture(),
      receipt = prepare(f),
      before = businessFacts(f),
      controller = new AbortController()
    controller.abort()
    await expect(
      f.repo.readPreparedInputDecisionSources(receipt, candidates, {
        signal: controller.signal,
        deadlineAt: Date.now() + 15_000,
      }),
    ).rejects.toThrow('aborted')
    await expect(
      f.repo.readPreparedInputDecisionSources(receipt, candidates, {
        signal: new AbortController().signal,
        deadlineAt: Date.now(),
      }),
    ).rejects.toThrow('timed out')
    expect(businessFacts(f)).toEqual(before)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it('cancels prepared input on a cold restart, preserves its body and Comments, and never sends automatically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-prepared-input-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture(filePath),
      e = await evaluate(f)
    const before = businessFacts(f),
      savedBody = body(f, e.receipt.batchId)
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.add(db)
    const cold = { ...f, db, repo: db.conversationRepository }
    expect(cold.repo.recoverInterruptedRuns()).toContain(f.sessionId)
    expect(cold.repo.recoverInterruptedRuns()).toEqual([])
    expect(batch(cold, e.receipt.batchId)).toMatchObject({
      dispatchState: 'cancelled',
      runId: null,
      messageId: null,
    })
    expect(JSON.parse(batch(cold, e.receipt.batchId).dispatchMetadataJson!)).toMatchObject({
      cancellationReason: 'restarted',
    })
    expect(body(cold, e.receipt.batchId)).toEqual(savedBody)
    expect(members(cold, e.receipt.batchId)).toEqual([])
    expect(
      cold.db.drizzle
        .select()
        .from(anchoredComments)
        .where(eq(anchoredComments.id, f.commentId))
        .get(),
    ).toMatchObject({ pendingReceiptId: null, sentWithMessageId: null })
    expect(businessFacts(cold)).toEqual(before)
    expect(cold.repo.handoffReceipt(e.handoff.id)).toMatchObject({ action: null, runId: null })
    expect(cold.repo.schedulingBudget(e.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
    expect(() =>
      cold.repo.prepareInputDispatch(f.input, randomUUID(), ['codex', 'claude']),
    ).toThrow('ended without sending')
    expect(() => cold.repo.beginRun(admission(cold, e.receipt, e.proposal))).toThrow(
      'preparation has ended',
    )
    expect(
      cold.db.drizzle.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM agent_runs WHERE user_message_id=${f.input.clientMessageId}`,
      )?.count,
    ).toBe(0)
  })
})
