/* oxlint-disable eslint/no-await-in-loop -- One real App/auxiliary owner runs these frozen dependent scenarios serially without parallel provider work. */
import { expect, type TestInfo } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  ConversationSendInput,
  DesktopBridge,
  RelaySchedulingDecision,
  SchedulingModelSelection,
} from '../../packages/contracts/src/index.js'

import {
  preparedInformationControlSchema,
  collaborationDocumentSchema,
  relaySchedulingDecisionProofSchema,
} from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import { nativeAgentContexts } from '../../packages/persistence/src/schema/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  closeRealWorkspace,
  readRealConversation,
  selectRealSession,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeSourceRecord } from './real-native-evidence.js'
import { releaseNoteBusinessOutcome } from './relay-information-outcome.js'
import { retainRoutingNativeSourceEvidence } from './relay-routing-native-source-evidence.js'
import {
  emitRoutingEvidence,
  routingSchedulingObservation,
  routingSafeLogPhases,
  routingUsageCounts,
  retainSourceReadFailureDiagnostics,
} from './relay-routing-real-observation.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'
import { sourceReadFailureScript } from './source-read-failure-diagnostics.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const source =
  'Agreed scope: prepare one short release note about the existing cancellation boundary. No file changes or additional work are requested.'
const comment =
  'Keep this complete agreed scope and the source context. Do not invent or expand requirements.'
const readSources =
  'First read the complete current inputBatchRef and every attached Comment body through the Pact read_collaboration_source reader, using the current sourceGrant and copying sourceReadArguments without changing its identities. Read clarificationAnswer completely when supplied. Use only that source reader; do not use other tools, delegate, inspect or change files, change permissions, or start a workflow.'
const positive = `I reserve the launch date choice for myself: I will supply the launch date before you draft the release note. Ask me for that user-supplied value before drafting. If no date has been supplied, ask one brief question in ordinary text and end the turn. After I supply the date, write one short release note using that exact date and the attached agreed scope. ${readSources}`
const negative = `The launch date is already supplied by me: 2027-04-12. Write one short release note using that date and the complete attached agreed scope. An Agent disagreement about wording is a technical judgment you can resolve within this read-only request; it is not a missing user decision. ${readSources}`
const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
type Seed = {
  sessionId: string
  projectId: string
  projectDirectory: string
  sourceRunId: string
  commentId: string
  revision: number
}

/** Stored source history is controlled prerequisite data, never real-model evidence. */
function seed(
  db: PactDatabase,
  projectDirectory: string,
  claudeModel: string,
  title: string,
  businessAgent: 'codex' | 'claude' = 'codex',
): Seed {
  const repo = db.conversationRepository,
    sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = new Date().toISOString(),
    sourceAgent = businessAgent === 'codex' ? 'claude' : 'codex'
  db.projectCatalogRepository.add({
    id: projectId,
    name: title,
    directoryPath: projectDirectory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title, createdAt },
    {
      primaryAgentId: businessAgent,
      agents: {
        codex: { model: 'gpt-6-luna', effort: 'low' },
        claude: { model: claudeModel, effort: null },
      },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  for (const agentId of ['codex', 'claude'] as const)
    db.sessionRepository.savePermission({
      sessionId,
      agentId,
      mode: 'ask',
      confirmedFullAccess: false,
      expectedRevision: db.sessionRepository.find(sessionId)!.settingsRevision,
    })
  const run = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Provide the agreed read-only release note scope.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: sourceAgent,
    model: sourceAgent === 'claude' ? claudeModel : 'gpt-6-luna',
    effort: sourceAgent === 'claude' ? null : 'low',
    settingsRevision: db.sessionRepository.find(sessionId)!.settingsRevision,
  }).run
  const nativeSessionId = `fixture-${run.id}`,
    turnId = `fixture-turn-${run.id}`
  repo.applyEvent(sessionId, run.id, {
    type: 'session.started',
    agentId: sourceAgent,
    nativeSessionId,
  })
  repo.applyEvent(sessionId, run.id, { type: 'turn.started', agentId: sourceAgent, turnId })
  repo.applyEvent(sessionId, run.id, {
    type: 'text.completed',
    agentId: sourceAgent,
    turnId,
    outputId: run.id,
    text: source,
  })
  repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome: 'completed',
    identity: {
      sessionId,
      agentId: sourceAgent,
      requestId: run.id,
      runId: run.id,
      nativeSessionId,
      nativeTurnId: turnId,
      bindingGeneration: 1,
    },
  })
  repo.recordNativeEffects(run.id, 'settled')
  repo.applyEvent(sessionId, run.id, {
    type: 'turn.completed',
    agentId: sourceAgent,
    turnId,
    outcome: 'completed',
  })
  repo.recordNativeEffects(run.id, 'settled')
  const drafts = repo.readPage({ scope: 'drafts', sessionId })
  if (drafts.scope !== 'drafts') throw Error('Original Comment draft headers unavailable.')
  const commentId = randomUUID()
  repo.saveCommentDraft({
    mode: 'create',
    sessionId,
    commentId,
    expectedCommentsRevision: drafts.commentsRevision,
    body: comment,
    anchor: {
      type: 'message',
      messageId: repo.findRun(run.id)!.responseMessageId!,
      contentHash: digest(source),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 12,
      quote: source.slice(0, 12),
    },
  })
  const next = repo.readPage({ scope: 'drafts', sessionId })
  if (next.scope !== 'drafts') throw Error('Saved Comment headers unavailable.')
  return {
    sessionId,
    projectId,
    projectDirectory,
    sourceRunId: run.id,
    commentId,
    revision: next.commentsRevision,
  }
}

async function send(ctx: RealWorkspace, item: Seed, content: string) {
  Object.assign(ctx, {
    sessionId: item.sessionId,
    projectId: item.projectId,
    projectDirectory: item.projectDirectory,
  })
  await selectRealSession(ctx, item.sessionId)
  const input: ConversationSendInput = {
    sessionId: item.sessionId,
    clientMessageId: randomUUID(),
    content,
    expectedCommentsRevision: item.revision,
    commentIds: [item.commentId],
    routeIntent: 'implicit',
    composerRevision: 1,
    userInformation: {
      version: 'user-information-v1',
      id: randomUUID(),
      kind: 'user_supplied_value',
      question: 'What launch date should be used?',
      input: 'text',
      options: [],
      state:
        content === negative
          ? { status: 'answered', value: '2027-04-12' }
          : { status: 'unanswered' },
    },
  }
  const reply = await ctx.page.evaluate(async (value) => {
    const bridge: DesktopBridge = Reflect.get(window, 'pact')
    return bridge.sendConversationMessage(value)
  }, input)
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw Error('Original input was refused before the information scenario.')
  return { input, patch: reply.value }
}
async function retainInformationAdmissionEvidence(
  ctx: RealWorkspace,
  input: ConversationSendInput,
  arm: 'cancel' | 'answer',
  observation: Awaited<ReturnType<typeof routingSchedulingObservation>>,
  info: TestInfo,
) {
  let snapshot: unknown = { status: 'unavailable' }
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    const evaluations = db.drizzle.query.schedulingEvaluations
        .findMany({
          where: (fields, { eq }) => eq(fields.sessionId, input.sessionId),
          limit: 2,
          columns: {
            id: true,
            provider: true,
            model: true,
            called: true,
            active: true,
            outcome: true,
            selectedCandidateId: true,
            inputSha256: true,
            createdAt: true,
            deadline: true,
            settledAt: true,
          },
        })
        .sync(),
      batch = db.drizzle.query.conversationInputBatches
        .findFirst({
          where: (fields, { and, eq }) =>
            and(
              eq(fields.sessionId, input.sessionId),
              eq(fields.clientMessageId, input.clientMessageId),
            ),
          columns: {
            id: true,
            dispatchState: true,
            runId: true,
            memberCount: true,
            commentsRevision: true,
            userInformationDocumentJson: true,
          },
        })
        .sync(),
      activeOwner = db.drizzle.query.schedulingRuntimeOwners
        .findFirst({
          where: (fields, { eq }) => eq(fields.active, true),
          columns: {
            kind: true,
            provider: true,
            model: true,
            phase: true,
            nativeStage: true,
            nativeGeneration: true,
            sessionId: true,
          },
        })
        .sync()
    snapshot = {
      status: 'observed',
      evaluations: evaluations.map((evaluation) =>
        Object.assign({}, evaluation, {
          physicalOwner:
            db.drizzle.query.schedulingRuntimeOwners
              .findFirst({
                where: (fields, { eq }) => eq(fields.evaluationId, evaluation.id),
                columns: { active: true, phase: true, nativeStage: true, nativeGeneration: true },
              })
              .sync() ?? null,
        }),
      ),
      batch: batch
        ? {
            id: batch.id,
            dispatchState: batch.dispatchState,
            runId: batch.runId,
            memberCount: batch.memberCount,
            commentsRevision: batch.commentsRevision,
            declaration: batch.userInformationDocumentJson
              ? collaborationDocumentSchema.parse(JSON.parse(batch.userInformationDocumentJson))
              : null,
          }
        : null,
      activeOwner: activeOwner
        ? {
            kind: activeOwner.kind,
            provider: activeOwner.provider,
            model: activeOwner.model,
            phase: activeOwner.phase,
            nativeStage: activeOwner.nativeStage,
            nativeGeneration: activeOwner.nativeGeneration,
            sameSession: activeOwner.sessionId === input.sessionId,
          }
        : null,
    }
  } catch {
    // Observation failure is explicit and cannot turn a missing card into passing evidence.
    snapshot = { status: 'unavailable' }
  } finally {
    db.close()
  }
  await emitRoutingEvidence(info, `information-admission-${arm}`, {
    arm,
    declarationExpected: input.userInformation !== undefined,
    observation,
    snapshot,
    diagnostics: await routingSafeLogPhases(ctx.fixture),
  })
}

async function card(ctx: RealWorkspace): Promise<RelaySchedulingDecision> {
  const result = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(window, 'pact'),
      reply = await bridge.getConversation({ scope: 'messages', sessionId })
    if (!reply.ok || reply.value.scope !== 'messages')
      throw Error('Current input question unavailable.')
    return reply.value.header.relaySchedulingDecision
  }, ctx.sessionId)
  expect(result?.request.category).toBe('necessary_information')
  if (result?.request.category === 'necessary_information') {
    expect(result.request.field.input.kind).toBe('text')
    expect(result.request.field.prompt.trim().length).toBeGreaterThan(0)
  }
  return result!
}

function questionEvidence(ctx: RealWorkspace, request: RelaySchedulingDecision) {
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    const row = db.drizzle.query.relayDecisions
        .findFirst({
          where: (fields, { eq }) => eq(fields.id, request.decisionId),
          columns: { proofJson: true },
        })
        .sync()!,
      proof = relaySchedulingDecisionProofSchema.parse(JSON.parse(row.proofJson)),
      evidence = proof.informationEvidence!
    expect(evidence.sourceId).toBe('s0')
    expect(evidence.sourceSha256).toBe(digest(positive))
    const quote = positive.slice(evidence.start, evidence.end)
    expect(quote).toMatch(/\bdate\b/iu)
    expect(quote).toMatch(/\b(?:reserve|supply|before)\b/iu)
    return {
      question:
        request.request.category === 'necessary_information' ? request.request.field.prompt : '',
      reason: request.reason,
      evidence: { ...evidence, quote },
      inputSha256: proof.inputSha256,
      sourceFingerprint: proof.sourceFingerprint,
    }
  } finally {
    db.close()
  }
}

async function businessEvidence(
  ctx: RealWorkspace,
  item: Seed,
  input: ConversationSendInput,
  arm: 'off' | 'cancel' | 'answer' | 'already-answered',
  expectedBatchId?: string,
  extraComments: Array<{ id: string; body: string }> = [],
) {
  const answered = arm === 'answer',
    declarationExpected = input.userInformation !== undefined,
    missingDate = arm === 'off' || arm === 'cancel'
  const deadline = performance.now() + 300_000,
    completed = await waitForRealCompletion(ctx, 2),
    completedRun = completed.runs.find((value) => value.id !== item.sourceRunId)!
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    // This case requires settled effects; recovered answers elsewhere can retain unknown effects.
    // Both observations share the original completion budget, without changing the generic helper.
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw Error('Information business completion exceeded its original budget.')
    await expect
      .poll(
        () =>
          db.drizzle.query.agentRuns
            .findFirst({
              where: (fields, { eq }) => eq(fields.id, completedRun.id),
              columns: { nativeEffectsState: true },
            })
            .sync()?.nativeEffectsState,
        { timeout: remaining, intervals: [250, 500, 1000] },
      )
      .toBe('settled')
    const complete = await readRealConversation(ctx),
      run = complete.runs.find((value) => value.id === completedRun.id)!
    expect(run).toMatchObject({
      status: 'completed',
      nativeEffectsState: 'settled',
      permissionMode: 'ask',
      nativeOutcome: 'completed',
      dispatchPhase: 'ended',
      attemptCount: 1,
    })
    expect(run.collaboration).toBeUndefined()
    const original = complete.messages.find((value) => value.id === input.clientMessageId)!,
      response = complete.messages.find((value) => value.id === run.responseMessageId)!
    expect(original.content).toBe(input.content)
    expect(response.state).toBe('complete')
    expect(response.content.trim().length).toBeGreaterThan(0)
    const batch = db.drizzle.query.conversationInputBatches
      .findFirst({
        where: (fields, { eq }) => eq(fields.runId, run.id),
        columns: { id: true, dispatchInformationJson: true, userInformationDocumentJson: true },
      })
      .sync()!
    // The approved Cancel contract withdraws this declaration only from the fresh Send.
    expect(declarationExpected).toBe(arm !== 'cancel')
    expect(batch.userInformationDocumentJson === null).toBe(!declarationExpected)
    const answer = batch.dispatchInformationJson
        ? preparedInformationControlSchema.parse(JSON.parse(batch.dispatchInformationJson))
            .answerDocument
        : undefined,
      pendingNative = await findNativeSourceRecord(ctx, run.agentId, run.nativeSessionId!),
      access = await retainRoutingNativeSourceEvidence(
        pendingNative,
        {
          runId: run.id,
          batchId: batch.id,
          commentId: item.commentId,
          commentSha256: digest(comment),
          batchBodySha256: digest(input.content),
          nativeSessionId: run.nativeSessionId,
          nativeTurnId: run.nativeTurnId,
          declaration: declarationExpected
            ? collaborationDocumentSchema.parse(JSON.parse(batch.userInformationDocumentJson!))
            : undefined,
          ...(answered ? { answer } : {}),
        },
        (receipt) =>
          emitRoutingEvidence(test.info(), `information-source-inspection-${arm}`, receipt),
      )
    const semanticLabel = `information-${arm}-semantic-text`
    await emitRoutingEvidence(test.info(), semanticLabel, {
      arm,
      sha256: digest(response.content),
      chars: response.content.length,
      capturedTextComplete: response.content.length <= 2048,
      text: response.content.slice(0, 2048),
    })
    const businessOutcome = releaseNoteBusinessOutcome(
      response.content,
      missingDate ? null : '2027-04-12',
    )
    await emitRoutingEvidence(test.info(), `information-${arm}-business-outcome`, {
      arm,
      answerSha256: digest(response.content),
      ...businessOutcome,
    })
    if (
      !access.allToolsAllowed ||
      !access.sourceGrantMatched ||
      !access.completeBatch ||
      !access.completeBatchBody ||
      !access.completeComment ||
      (declarationExpected && !access.completeDeclaredInformation) ||
      (answered && !access.completeAnswer)
    ) {
      await emitRoutingEvidence(
        test.info(),
        'information-source-native-arguments',
        access.nativeArgumentDiagnostics,
      )
      await emitRoutingEvidence(
        test.info(),
        'information-source-reference-diagnostics',
        access.sourceReferenceDiagnostics,
      )
      const failedWrappers = new Set(
        access.boundaryDiagnostics.failedLeaves.map((leaf) => leaf.wrapper),
      )
      const scripts = access.boundaryDiagnostics.wrappers.filter(
        (wrapper) => !wrapper.completed || failedWrappers.has(wrapper.index),
      )
      for (const wrapper of scripts) {
        const script = pendingNative.execScripts.find(
          (value) => digest(value.input) === wrapper.sha256,
        )
        if (script)
          await emitRoutingEvidence(test.info(), 'information-source-failed-script', {
            wrapperIndex: wrapper.index,
            ...sourceReadFailureScript(script.input),
          })
      }
      await retainSourceReadFailureDiagnostics(
        test.info(),
        ctx.fixture,
        ctx.page,
        access.boundaryDiagnostics.failedLeaves,
      )
      await emitRoutingEvidence(test.info(), 'information-source-failure', {
        arm,
        sourceAccess: access,
        nativeToolNames: pendingNative.toolNames.slice(0, 16).map((name) => name.slice(0, 160)),
        nativeToolCount: pendingNative.toolNames.length,
        nativeShellCommandCount: null,
        nativeCommandInspection: pendingNative.commandInspection,
      })
    }
    if (expectedBatchId) expect(batch.id).toBe(expectedBatchId)
    expect(answer !== undefined).toBe(answered)
    expect(access).toMatchObject({
      allToolsAllowed: true,
      sourceGrantMatched: true,
      completeBatch: true,
      completeBatchBody: true,
      batchBodySha256: digest(input.content),
      completeComment: true,
      ...(declarationExpected ? { completeDeclaredInformation: true } : {}),
      ...(answered ? { completeAnswer: true, answerSha256: answer!.sha256 } : {}),
    })
    const native = pendingNative.certifySourceAudit(access)
    expect(run.agentId === 'codex' ? native.codexModelStarts : native.claudeUserInputs).toBe(1)
    expect(native.containsText(input.content)).toBe(true)
    expect(native.containsText(comment)).toBe(true)
    expect(extraComments.length).toBeLessThanOrEqual(1)
    for (const extra of extraComments) {
      const extraAccess = await retainRoutingNativeSourceEvidence(
        native,
        {
          runId: run.id,
          batchId: batch.id,
          commentId: extra.id,
          commentSha256: digest(extra.body),
          batchBodySha256: digest(input.content),
          nativeSessionId: run.nativeSessionId,
          nativeTurnId: run.nativeTurnId,
        },
        (receipt) =>
          emitRoutingEvidence(test.info(), `information-current-comment-${arm}`, receipt),
      )
      expect(extraAccess).toMatchObject({
        allToolsAllowed: true,
        sourceGrantMatched: true,
        completeBatch: true,
        completeBatchBody: true,
        completeComment: true,
      })
      expect(native.containsText(extra.body)).toBe(true)
    }
    expect(native.shellCommands).toEqual([])
    expect(native.execScripts.map((script) => digest(script.input))).toEqual(
      access.codeModeScripts.map((script) => script.sha256),
    )
    expect(native.toolNames).toHaveLength(access.genericToolCallCount)
    if (run.agentId === 'codex') {
      expect({ model: run.model, effort: run.effort }).toEqual({
        model: 'gpt-6-luna',
        effort: 'low',
      })
      expect(native.codexTurnSettings.length).toBeGreaterThan(0)
      expect(
        native.codexTurnSettings.every(
          (settings) => settings.model === 'gpt-6-luna' && settings.effort === 'low',
        ),
      ).toBe(true)
    } else {
      expect({ model: run.model, effort: run.effort }).toEqual({
        model: ctx.fixture.readConfigurationModels().claude,
        effort: null,
      })
      expect(native.assistantModels).toContain(run.model)
    }
    expect(businessOutcome.passed, `Final answer did not fulfill ${businessOutcome.expected}`).toBe(
      true,
    )
    if (!missingDate) {
      const visibleAnswer = ctx.page.locator(
        `[data-pact-message-id="${response.id}"] [data-pact-message-content]`,
      )
      await expect(visibleAnswer).toBeVisible()
      await expect
        .poll(
          async () =>
            releaseNoteBusinessOutcome(await visibleAnswer.innerText(), '2027-04-12').passed,
        )
        .toBe(true)
      const screenshot = test.info().outputPath(`${run.agentId}-${arm}-business-complete.png`)
      await ctx.page.screenshot({ path: screenshot })
      await test.info().attach(`information-${run.agentId}-${arm}-business-ui`, {
        path: screenshot,
        contentType: 'image/png',
      })
    }
    return {
      arm,
      actor: run.agentId,
      model: run.model,
      effort: run.effort,
      nativeSha256: native.sha256,
      answerSha256: digest(response.content),
      answerChars: response.content.length,
      answerBytes: Buffer.byteLength(response.content),
      judgmentFragment: response.content.slice(0, 512),
      judgmentTail: response.content.length > 512 ? response.content.slice(-256) : null,
      // Mechanical lifecycle/source assertions do not establish natural-language semantics.
      // Review the bounded actual text against the preregistered criterion after execution.
      // Preserve a separate bounded text record before fixture disposal. Beyond that record,
      // semantics remain unverified; a digest or another model run cannot replace missing text.
      semanticReview: {
        status: 'business_checks_passed_actual_body_review_required',
        capturedTextComplete: response.content.length <= 2048,
        evidenceLabel: semanticLabel,
      },
      semanticCriterion: missingDate
        ? 'Ask only for the missing launch date; invent no date or release note.'
        : 'Use the supplied date in the requested release note; ask no further question.',
      businessOutcome,
      sourceAccess: access,
    }
  } finally {
    db.close()
  }
}

async function emitArm(
  info: TestInfo,
  label: string,
  evidence: Awaited<ReturnType<typeof businessEvidence>> & {
    question?: ReturnType<typeof questionEvidence>
  },
) {
  await emitRoutingEvidence(info, label, evidence)
  return {
    label,
    sha256: digest(JSON.stringify(evidence)),
    arm: evidence.arm,
    actor: evidence.actor,
    model: evidence.model,
    answerSha256: evidence.answerSha256,
    answerChars: evidence.answerChars,
    sourceVerified: true,
  }
}

async function runInformationScenario(
  target: 'codex_luna' | 'claude_haiku_5_5',
  businessAgent: 'codex' | 'claude',
  info: TestInfo,
  confirmedOnly = false,
) {
  const fixture = await createRuntimeFixture({ mode: 'real' })
  let ctx: RealWorkspace | undefined
  try {
    const claudeModel = fixture.readConfigurationModels().claude
    if (!claudeModel || !/^claude-haiku-5-5(?:-\d{8})?$/u.test(claudeModel))
      throw Error('An exact configured Haiku 5.5 model is required.')
    const selection: SchedulingModelSelection =
        target === 'codex_luna'
          ? { target, provider: 'codex', modelId: 'gpt-6-luna' }
          : { target, provider: 'claude', modelId: claudeModel },
      db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    const fixtures: Seed[] = []
    try {
      for (const label of ['Off', 'Cancel', 'Answer', 'Already answered'])
        fixtures.push(
          seed(
            db,
            await fixture.createProjectDirectory(
              `information-${label.replaceAll(' ', '-').toLowerCase()}`,
            ),
            claudeModel,
            `Information ${label}`,
            businessAgent,
          ),
        )
      db.conversationRepository.saveSchedulingSettings({
        expectedRevision: 0,
        enabled: false,
        selection,
      })
      db.drizzle.delete(nativeAgentContexts).run()
    } finally {
      db.close()
    }
    const app = await fixture.launch(),
      page = await app.firstWindow(),
      off = fixtures[0]!
    ctx = {
      fixture,
      app,
      page,
      sessionId: off.sessionId,
      projectId: off.projectId,
      projectDirectory: off.projectDirectory,
    }
    await emitRoutingEvidence(info, 'information-preregistered', {
      version: 1,
      target,
      businessAgent,
      scenarioArms: confirmedOnly
        ? ['answer', 'already-answered']
        : ['off', 'cancel', 'answer', 'already-answered'],
      sourceHistoryFixture: true,
      positiveSha256: digest(positive),
      negativeSha256: digest(negative),
      commentSha256: digest(comment),
      sourceSha256: digest(source),
      retries: 0,
      declarationPrerequisite:
        'Actual typed user declaration sent through DesktopBridge; no inference from text. Dispatched declarations require their own authenticated complete native read. The approved Cancel fresh Send withdraws the old declaration and must have no declaration document; all other arms still require one. Original natural task, models, permissions, deadlines and other source assertions remain.',
      expected: {
        offCalls: 0,
        positiveCallsEach: 1,
        cancelNoAutomaticDispatch: true,
        cancelEndsOldRequestAndFreshSendUsesCurrentDraft: true,
        answerSeparateSource: true,
        alreadyAnsweredMustNotAsk: true,
        questionCriterion:
          'Ask only for the launch date explicitly reserved by the current user; no technical, permission, scope, model or Agent question.',
        offAndCancelCriterion:
          'The actual native answer asks for the missing date without inventing a date or drafting the note.',
        answerAndNegativeCriterion:
          'The actual native answer uses 2027-04-12 to complete the requested release note without another question.',
      },
    })
    const observations: Awaited<ReturnType<typeof emitArm>>[] = []
    if (!confirmedOnly) {
      const offInput = await send(ctx, off, positive)
      expect(offInput.patch.sendDisposition).toBeUndefined()
      const offEvidence = await businessEvidence(ctx, off, offInput.input, 'off')
      expect(offEvidence.actor).toBe(businessAgent)
      observations.push(await emitArm(info, 'information-off', offEvidence))
    }
    const enabled = await page.evaluate(async () => {
      const bridge: DesktopBridge = Reflect.get(window, 'pact'),
        current = await bridge.getSchedulingSettings()
      if (!current.ok) throw Error('Relay settings unavailable.')
      return bridge.saveSchedulingSettings({
        expectedRevision: current.value.revision,
        enabled: true,
      })
    })
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true, selection } })
    for (const [index, answered] of [
      [1, false],
      [2, true],
    ] as const) {
      if (confirmedOnly && !answered) continue
      const item = fixtures[index]!
      const observation = await routingSchedulingObservation(page, item.sessionId, true),
        started = await send(ctx, item, positive)
      await retainInformationAdmissionEvidence(
        ctx,
        started.input,
        answered ? 'answer' : 'cancel',
        observation,
        info,
      )
      const request = await card(ctx)
      expect(started.patch.sendDisposition).toBe('held_for_information')
      const before = await readRealConversation(ctx)
      expect(before.runs).toHaveLength(1)
      if (request.request.category !== 'necessary_information')
        throw Error('Expected the original typed consumer.')
      expect(request.request.consumer.clientMessageId).toBe(started.input.clientMessageId)
      expect(request.request.consumer.defaultAgentId).toBe(businessAgent)
      const question = questionEvidence(ctx, request)
      await emitRoutingEvidence(info, 'information-question', {
        arm: answered ? 'answer' : 'cancel',
        ...question,
      })
      let currentInput = started.input,
        currentSeed = item,
        currentBatchId = request.request.consumer.batchId,
        sentDrafts: Array<{ id: string; body: string }> | undefined
      const answer = {
        reference: {
          sessionId: item.sessionId,
          decisionId: request.decisionId,
          revision: request.revision,
        },
        clientOperationId: randomUUID(),
        answer: answered
          ? {
              kind: 'text' as const,
              fieldId: request.request.field.fieldId,
              text: '2027-04-12',
            }
          : { kind: 'cancel' as const },
      }
      if (answered) expect(request.request.field.input.kind).toBe('text')
      const result = await page.evaluate(async (input) => {
        const bridge: DesktopBridge = Reflect.get(window, 'pact')
        return bridge.answerRelayDecision(input)
      }, answer)
      expect(result).toMatchObject({
        ok: true,
        value: { disposition: answered ? 'confirmed' : 'cancelled' },
      })
      expect(
        await page.evaluate(async (input) => {
          const bridge: DesktopBridge = Reflect.get(window, 'pact')
          return bridge.answerRelayDecision(input)
        }, answer),
      ).toEqual(result)
      if (!answered) {
        expect((await readRealConversation(ctx)).runs).toHaveLength(1)
        const current = await page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(window, 'pact'),
            reply = await bridge.getConversation({ scope: 'messages', sessionId })
          if (!reply.ok || reply.value.scope !== 'messages')
            throw Error('Current input projection unavailable.')
          return reply.value.header.preparedInputContinuation
        }, item.sessionId)
        expect(current).toBeNull()
        const old = ReadonlyFixtureDatabase.open(fixture)
        try {
          const batch = old.drizzle.query.conversationInputBatches
            .findFirst({
              where: (fields, { eq }) =>
                eq(
                  fields.id,
                  request.request.category === 'necessary_information'
                    ? request.request.consumer.batchId
                    : '',
                ),
            })
            .sync()!
          expect(batch).toMatchObject({
            dispatchState: 'cancelled',
            state: 'closed',
            bodyState: 'withdrawn',
            runId: null,
            messageId: null,
          })
          expect(batch.userInformationDocumentJson).not.toBeNull()
        } finally {
          old.close()
        }
        expect(
          (
            await page.evaluate(async (input) => {
              const bridge: DesktopBridge = Reflect.get(window, 'pact')
              return bridge.sendConversationMessage(input)
            }, started.input)
          ).ok,
        ).toBe(false)
        sentDrafts = await page.evaluate(
          async (value) => {
            const bridge: DesktopBridge = Reflect.get(window, 'pact'),
              drafts = await bridge.getConversation({
                scope: 'drafts',
                sessionId: value.sessionId,
              })
            if (!drafts.ok || drafts.value.scope !== 'drafts' || drafts.value.comments.length !== 1)
              throw Error('Cancel did not restore exactly one editable Comment copy.')
            const copy = drafts.value.comments[0]!
            if (
              copy.id === value.originalId ||
              copy.body !== value.body ||
              copy.status !== 'draft' ||
              copy.anchor.type !== 'message'
            )
              throw Error('The restored Comment copy changed the original facts.')
            const id = crypto.randomUUID(),
              newer = 'Include this newer Comment in the current Send.'
            const saved = await bridge.saveCommentDraft({
              mode: 'create',
              sessionId: value.sessionId,
              commentId: id,
              expectedCommentsRevision: drafts.value.commentsRevision,
              body: newer,
              anchor: copy.anchor,
            })
            if (!saved.ok) throw Error('The newer current Comment draft could not be saved.')
            return [
              { id: copy.id, body: copy.body },
              { id, body: newer },
            ]
          },
          { sessionId: item.sessionId, originalId: item.commentId, body: comment },
        )
        const currentDrafts = await page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(window, 'pact'),
            reply = await bridge.getConversation({ scope: 'drafts', sessionId })
          if (!reply.ok || reply.value.scope !== 'drafts')
            throw Error('Missing current draft revision.')
          return reply.value.commentsRevision
        }, item.sessionId)
        currentInput = {
          ...started.input,
          clientMessageId: randomUUID(),
          batchId: randomUUID(),
          content: `${positive}\nThis is the current edited draft after Cancel.`,
          expectedCommentsRevision: currentDrafts,
          commentIds: sentDrafts.map((draft) => draft.id),
          userInformation: undefined,
          composerRevision: 2,
          // The user explicitly selects the current Primary for this fresh draft.
          route: { type: 'primary' },
          routeIntent: 'explicit',
        }
        currentSeed = { ...item, commentId: sentDrafts[0]!.id, revision: currentDrafts }
        currentBatchId = currentInput.batchId!
        const sent = await page.evaluate(async (value) => {
          const bridge: DesktopBridge = Reflect.get(window, 'pact')
          return bridge.sendConversationMessage(value)
        }, currentInput)
        expect(sent.ok).toBe(true)
        expect(currentInput.clientMessageId).not.toBe(started.input.clientMessageId)
        expect(currentBatchId).not.toBe(request.request.consumer.batchId)
        expect(
          (
            await page.evaluate(async (value) => {
              const bridge: DesktopBridge = Reflect.get(window, 'pact')
              return bridge.sendConversationMessage(value)
            }, currentInput)
          ).ok,
        ).toBe(true)
      }
      const evidence = await businessEvidence(
        ctx,
        currentSeed,
        currentInput,
        answered ? 'answer' : 'cancel',
        currentBatchId,
        sentDrafts?.slice(1),
      )
      expect(evidence.actor).toBe(businessAgent)
      if (sentDrafts) {
        const drafts = await page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(window, 'pact'),
            reply = await bridge.getConversation({ scope: 'drafts', sessionId })
          if (!reply.ok || reply.value.scope !== 'drafts')
            throw Error('Current unsent drafts unavailable.')
          return reply.value.comments.map((value) => ({ id: value.id, body: value.body }))
        }, item.sessionId)
        expect(drafts).toEqual([])
      }
      observations.push(
        await emitArm(info, answered ? 'information-answer' : 'information-cancel', {
          ...evidence,
          question,
        }),
      )
    }
    const completeInput = await send(ctx, fixtures[3]!, negative)
    expect(completeInput.patch.sendDisposition).toBeUndefined()
    observations.push(
      await emitArm(
        info,
        'information-already-answered',
        await businessEvidence(ctx, fixtures[3]!, completeInput.input, 'already-answered'),
      ),
    )
    const observer = ReadonlyFixtureDatabase.open(fixture)
    try {
      const evaluations = fixtures.map((item) =>
        observer.drizzle.query.schedulingEvaluations
          .findMany({
            where: (fields, { eq }) => eq(fields.sessionId, item.sessionId),
            limit: 2,
          })
          .sync(),
      )
      expect(evaluations[0]).toEqual([])
      for (const [index, values] of evaluations.entries()) {
        if (index === 0) continue
        if (confirmedOnly && index === 1) {
          expect(values).toEqual([])
          continue
        }
        expect(values).toHaveLength(1)
        expect(values[0]).toMatchObject({
          called: true,
          active: false,
          outcome: 'completed',
          provider: selection.provider,
          model: selection.modelId,
        })
        const owner = observer.drizzle.query.schedulingRuntimeOwners
          .findFirst({
            where: (fields, { eq }) => eq(fields.evaluationId, values[0]!.id),
            columns: { active: true, phase: true },
          })
          .sync()
        expect(owner).toEqual({ active: false, phase: 'released' })
        if (index < 3) expect(values[0]!.selectedCandidateId).toBe('clarify_prepared_input')
        else expect(values[0]!.selectedCandidateId).not.toBe('clarify_prepared_input')
      }
      expect(observer.drizzle.query.collaborationTasks.findMany({ limit: 1 }).sync()).toEqual([])
      expect(
        observer.drizzle.query.collaborationActionReceipts.findMany({ limit: 1 }).sync(),
      ).toEqual([])
      await emitRoutingEvidence(info, 'information-complete', {
        target,
        selection,
        evaluations: evaluations.map((values) =>
          values.map((value) => ({
            called: value.called,
            active: value.active,
            outcome: value.outcome,
            model: value.model,
            candidate: value.selectedCandidateId,
            usage: routingUsageCounts(value.usageJson),
          })),
        ),
        observations,
      })
    } finally {
      observer.close()
    }
  } catch (error) {
    if (ctx)
      await emitRoutingEvidence(
        info,
        'information-failure-final-diagnostics',
        await routingSafeLogPhases(ctx.fixture, ctx.page),
      ).catch(() => undefined)
    throw error
  } finally {
    if (ctx) await closeRealWorkspace(ctx)
    else await fixture.dispose()
  }
}

for (const target of ['codex_luna', 'claude_haiku_5_5'] as const)
  test(
    `real Relay ${target} preserves necessary information through Cancel and a fresh Send without inventing user questions`,
    { tag: ['@real', '@real-extended'] },
    async ({ browserName: _browserName }, info) => {
      test.skip(
        process.platform !== 'darwin',
        'Production decision containment is currently verified on macOS.',
      )
      test.setTimeout(480_000)
      await runInformationScenario(target, 'codex', info)
    },
  )

test(
  'real Claude completes a confirmed user value and an already-answered release note without repeated questions',
  { tag: ['@real', '@real-extended'] },
  async ({ browserName: _browserName }, info) => {
    test.skip(
      process.platform !== 'darwin',
      'Production decision containment is currently verified on macOS.',
    )
    test.setTimeout(480_000)
    await runInformationScenario('claude_haiku_5_5', 'claude', info, true)
  },
)
