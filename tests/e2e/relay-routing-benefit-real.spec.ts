import { expect, type Page, type TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import type {
  ConversationSendInput,
  DesktopBridge,
  SchedulingModelSelection,
} from '../../packages/contracts/src/index.js'

import { messageCommentAnchorSchema } from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import { nativeAgentContexts } from '../../packages/persistence/src/schema/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  closeRealWorkspace,
  readRealConversation,
  selectRealSession,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeSourceRecord } from './real-native-evidence.js'
import {
  correctionQuestion,
  hash,
  implicitQuestion,
  initialRoutingInput,
  preregisteredRoutingMetrics,
  routingMigrations,
  routingScenario,
  seedRoutingScenario,
  verifyRoutingPreconditions,
  type RoutingSeed,
} from './relay-routing-benefit-fixture.js'
import { retainRoutingNativeSourceEvidence } from './relay-routing-native-source-evidence.js'
import {
  emitRoutingEvidence,
  routingBenefitSummary,
  routingSafeLogPhases,
  routingSchedulingObservation,
  routingUsageCounts,
  retainSourceReadFailureDiagnostics,
} from './relay-routing-real-observation.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

async function send(page: Page, input: ConversationSendInput) {
  const sent = await page.evaluate(async (value) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
      reply = await bridge.sendConversationMessage(value)
    return reply.ok ? { ok: true } : { ok: false, error: reply.error.code }
  }, input)
  expect(sent).toEqual({ ok: true })
}

async function waitBusiness(ctx: RealWorkspace, seed: RoutingSeed, count: number) {
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    await expect
      .poll(
        () => {
          const rows = db.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId),
              columns: { id: true, status: true, nativeEffectsState: true, failureKind: true },
              limit: 5,
            })
            .sync()
            .filter((row) => row.id !== seed.sourceRunId)
          if (rows.some((row) => row.status === 'failed' || row.status === 'interrupted'))
            throw Error(
              'A real business root failed; bounded routing evidence is retained separately',
            )
          return (
            rows.length === count &&
            rows.every((row) => row.status === 'completed' && row.nativeEffectsState === 'settled')
          )
        },
        { timeout: 120_000, intervals: [100, 250, 500] },
      )
      .toBe(true)
  } finally {
    db.close()
  }
  return readRealConversation(ctx, seed.sessionId)
}

async function freshCorrection(ctx: RealWorkspace, seed: RoutingSeed) {
  const saved = await ctx.page.evaluate(
    async (value) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
        draft = await bridge.getConversation({ scope: 'drafts', sessionId: value.sessionId })
      if (!draft.ok || draft.value.scope !== 'drafts')
        throw Error('New correction draft revision is unavailable')
      const quote = 'I assumed cancellation'
      const response = await bridge.saveCommentDraft({
        mode: 'create',
        sessionId: value.sessionId,
        commentId: crypto.randomUUID(),
        expectedCommentsRevision: draft.value.commentsRevision,
        body: value.comment,
        anchor: {
          type: 'message',
          messageId: value.sourceMessageId,
          contentHash: value.sourceHash,
          textBasis: 'markdown-visible-v2',
          startOffset: value.report.indexOf(quote),
          endOffset: value.report.indexOf(quote) + quote.length,
          quote,
        },
      })
      if (!response.ok) throw Error('The fresh source-bound correction Comment was refused')
      const next = await bridge.getConversation({ scope: 'drafts', sessionId: value.sessionId })
      if (!next.ok || next.value.scope !== 'drafts' || next.value.comments.length !== 1)
        throw Error('The fresh correction Comment was not retained exactly once')
      return { commentId: next.value.comments[0]!.id, revision: next.value.commentsRevision }
    },
    {
      sessionId: seed.sessionId,
      sourceMessageId: seed.sourceMessageId,
      sourceHash: seed.reportSha256,
      report: routingScenario.report,
      comment: routingScenario.comment,
    },
  )
  return {
    sessionId: seed.sessionId,
    clientMessageId: randomUUID(),
    content: correctionQuestion,
    commentIds: [saved.commentId],
    expectedCommentsRevision: saved.revision,
    route: { type: 'agent', agentId: 'codex' },
    routeIntent: 'explicit',
    composerRevision: 2,
  } satisfies ConversationSendInput
}

async function runRouting(ctx: RealWorkspace, seed: RoutingSeed, enabled: boolean, info: TestInfo) {
  ctx.sessionId = seed.sessionId
  ctx.projectId = seed.projectId
  ctx.projectDirectory = seed.projectDirectory
  await selectRealSession(ctx, seed.sessionId)
  const beforeState = await routingSchedulingObservation(ctx.page, seed.sessionId)
  const probe = enabled
    ? await routingSchedulingObservation(ctx.page, seed.sessionId, true)
    : beforeState
  if (enabled)
    await expect
      .poll(
        async () => {
          const value = await routingSchedulingObservation(ctx.page, seed.sessionId)
          return value.ok ? value.decision : 'unavailable'
        },
        { timeout: 20_000, intervals: [100, 250, 500] },
      )
      .toBe('idle')
  const original = ReadonlyFixtureDatabase.open(ctx.fixture)
  const before = original.sessionRepository.find(seed.sessionId)!.settings
  original.close()
  const firstInput: ConversationSendInput = await ctx.page.evaluate(
    async (value) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
        drafts = await bridge.getConversation({ scope: 'drafts', sessionId: value.sessionId })
      if (!drafts.ok || drafts.value.scope !== 'drafts')
        throw Error('Original frozen Comment draft is unavailable')
      return {
        sessionId: value.sessionId,
        clientMessageId: crypto.randomUUID(),
        content: value.question,
        commentIds: [value.commentId],
        expectedCommentsRevision: drafts.value.commentsRevision,
        route: { type: 'primary' as const },
        routeIntent: 'implicit' as const,
        composerRevision: 1,
      }
    },
    { sessionId: seed.sessionId, question: implicitQuestion, commentId: seed.commentId },
  )
  const started = Date.now()
  await send(ctx.page, firstInput)
  let complete = await waitBusiness(ctx, seed, 1)
  const first = complete.runs.find((run) => run.id !== seed.sourceRunId)!
  expect(first.status).toBe('completed')
  let manualRouteCorrections = 0
  let correctionInput: ConversationSendInput | undefined
  if (first.agentId !== routingScenario.correctRecipient) {
    expect(first.agentId).toBe('claude')
    expect(first.nativeEffectsState).toBe('settled')
    // This is one new explicit user correction after completed delivery, never
    // a resend, a reused input nonce or an automatic repair of failed delivery.
    correctionInput = await freshCorrection(ctx, seed)
    expect(correctionInput.clientMessageId !== firstInput.clientMessageId).toBe(true)
    expect(correctionInput.commentIds[0] !== firstInput.commentIds[0]).toBe(true)
    await send(ctx.page, correctionInput)
    manualRouteCorrections = 1
    complete = await waitBusiness(ctx, seed, 2)
  }
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    const runs = complete.runs.filter((run) => run.id !== seed.sourceRunId)
    const initialEvaluations = db.drizzle.query.schedulingEvaluations
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 3 })
      .sync()
    await emitRoutingEvidence(info, enabled ? 'on-result' : 'off-result', {
      firstActualRecipient: first.agentId,
      correctRecipient: routingScenario.correctRecipient,
      realBusinessTurns: runs.length,
      manualRouteCorrections,
      reportSha256: seed.reportSha256,
      commentSha256: seed.commentSha256,
      evaluations: initialEvaluations.map((value) => ({
        called: value.called,
        active: value.active,
        outcome: value.outcome,
        provider: value.provider,
        model: value.model,
        candidate: value.selectedCandidateId,
        createdAt: value.createdAt,
        deadline: value.deadline,
        settledAt: value.settledAt,
        usage: routingUsageCounts(value.usageJson),
      })),
    })
    const batches = db.drizzle.query.conversationInputBatches
      .findMany({
        where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId),
        columns: { id: true, clientMessageId: true, actor: true, runId: true },
        limit: 5,
      })
      .sync()
    const nativeFacts = []
    for (const run of runs) {
      expect({
        status: run.status,
        effects: run.nativeEffectsState,
        permission: run.permissionMode,
      }).toEqual({ status: 'completed', effects: 'settled', permission: 'ask' })
      expect(run.collaboration).toBeUndefined()
      const answer = complete.messages.find((message) => message.id === run.responseMessageId)!
      expect({ role: answer.role, state: answer.state }).toEqual({
        role: 'assistant',
        state: 'complete',
      })
      expect(answer.content.trim().length).toBeGreaterThan(0)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect only this completed root's bounded owned native record.
      const pendingNative = await findNativeSourceRecord(ctx, run.agentId, run.nativeSessionId!)
      const input = run.id === first.id ? firstInput : correctionInput,
        batch = batches.find((value) => value.runId === run.id)
      expect(input).toBeDefined()
      expect(batch).toBeDefined()
      // oxlint-disable-next-line eslint/no-await-in-loop -- Validate only this actual root's matched tool receipts and complete pages.
      const sourceAccess = await retainRoutingNativeSourceEvidence(
        pendingNative,
        {
          runId: run.id,
          batchId: batch!.id,
          commentId: input!.commentIds[0]!,
          commentSha256: seed.commentSha256,
          nativeSessionId: run.nativeSessionId,
          nativeTurnId: run.nativeTurnId,
        },
        (receipt) => emitRoutingEvidence(info, 'native-source-inspection', receipt),
      )
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve bounded failure evidence before any assertion.
      await emitRoutingEvidence(info, 'native-source-access', {
        actor: run.agentId,
        ...sourceAccess,
      })
      if (!sourceAccess.allToolsAllowed)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Retain this exact failed Root before its unchanged assertion and fixture cleanup.
        await retainSourceReadFailureDiagnostics(
          info,
          ctx.fixture,
          ctx.page,
          sourceAccess.boundaryDiagnostics.failedLeaves,
        )
      expect(sourceAccess).toMatchObject({
        allToolsAllowed: true,
        sourceGrantMatched: true,
        completeBatch: true,
        completeComment: true,
        commentSha256: seed.commentSha256,
      })
      const native = pendingNative.certifySourceAudit(sourceAccess)
      expect(native.containsText(routingScenario.report)).toBe(true)
      expect(native.containsText(routingScenario.comment)).toBe(true)
      expect(native.shellCommands).toEqual([])
      expect(native.execScripts.map((script) => hash(script.input))).toEqual(
        sourceAccess.codeModeScripts.map((script) => script.sha256),
      )
      // The dedicated decoder validates the actual Codex namespace as well as the name.
      // Match its strict source-call count against the independent generic tool observer.
      expect(native.toolNames).toHaveLength(sourceAccess.genericToolCallCount)
      const nativeInputs =
        run.agentId === 'codex' ? native.codexModelStarts : native.claudeUserInputs
      expect(nativeInputs).toBe(1)
      if (run.agentId === 'codex') {
        expect({ model: run.model, effort: run.effort }).toEqual({
          model: 'gpt-6-luna',
          effort: 'low',
        })
        expect(
          native.codexTurnSettings.every(
            (value) => value.model === 'gpt-6-luna' && value.effort === 'low',
          ),
        ).toBe(true)
      } else expect(native.assistantModels).toContain(run.model)
      nativeFacts.push({
        actor: run.agentId,
        model: run.model,
        effort: run.effort,
        permissionMode: run.permissionMode,
        nativeInputs,
        nativeHistorySha256: native.sha256,
        answerSha256: hash(answer.content),
        sourceAccess,
      })
    }
    const source = complete.messages.find((message) => message.id === seed.sourceMessageId)!
    expect(source.content === routingScenario.report).toBe(true)
    expect(hash(source.content)).toBe(seed.reportSha256)
    const comments = db.drizzle.query.anchoredComments
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 4 })
      .sync()
    expect(comments).toHaveLength(correctionInput ? 2 : 1)
    for (const comment of comments) {
      expect(hash(comment.body)).toBe(seed.commentSha256)
      const anchor = messageCommentAnchorSchema.parse(JSON.parse(comment.anchorJson))
      expect(
        anchor.messageId === seed.sourceMessageId && anchor.contentHash === seed.reportSha256,
      ).toBe(true)
      expect(comment.sentWithMessageId).toBeTruthy()
    }
    expect(new Set(comments.map((comment) => comment.sentWithMessageId)).size).toBe(comments.length)
    expect(
      batches.find((batch) => batch.clientMessageId === firstInput.clientMessageId)?.actor,
    ).toBe(first.agentId)
    if (correctionInput)
      expect(
        batches.find((batch) => batch.clientMessageId === correctionInput.clientMessageId)?.actor,
      ).toBe('codex')
    expect(db.sessionRepository.find(seed.sessionId)!.settings).toEqual(before)
    expect(db.sessionRepository.find(seed.sessionId)!.settings.primaryAgentId).toBe('claude')
    expect(
      db.drizzle.query.collaborationTasks
        .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 2 })
        .sync(),
    ).toEqual([])
    expect(
      db.drizzle.query.collaborationActionReceipts
        .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 2 })
        .sync(),
    ).toEqual([])
    expect(
      db.drizzle.query.schedulingBudgetReservations
        .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 2 })
        .sync(),
    ).toEqual([])
    const evaluations = db.drizzle.query.schedulingEvaluations
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, seed.sessionId), limit: 3 })
      .sync()
    const evaluation = evaluations[0]
    const owner = evaluation
      ? db.drizzle.query.schedulingRuntimeOwners
          .findFirst({ where: (fields, { eq }) => eq(fields.evaluationId, evaluation.id) })
          .sync()
      : undefined
    const adopted = db.drizzle.query.agentEventJournal
      .findMany({
        where: (fields, { and, eq }) =>
          and(
            eq(fields.sessionId, seed.sessionId),
            eq(fields.eventType, 'scheduling.input_dispatch_adopted'),
          ),
        columns: { eventType: true },
        limit: 3,
      })
      .sync().length
    const facts = {
      enabled,
      fixtureHistoryOnly: true,
      sourceActor: seed.sourceActor,
      correctRecipient: routingScenario.correctRecipient,
      defaultRecipient: 'claude',
      reportSha256: seed.reportSha256,
      commentSha256: seed.commentSha256,
      firstActualRecipient: first.agentId,
      finalRecipient: runs.at(-1)!.agentId,
      manualRouteCorrections,
      realBusinessTurns: runs.length,
      elapsedMs: Date.now() - started,
      decisionCalls: evaluations.filter((value) => value.called).length,
      evaluation: evaluation
        ? {
            called: evaluation.called,
            active: evaluation.active,
            outcome: evaluation.outcome,
            provider: evaluation.provider,
            model: evaluation.model,
            selectedCandidateId: evaluation.selectedCandidateId,
            createdAt: evaluation.createdAt,
            deadline: evaluation.deadline,
            settledAt: evaluation.settledAt,
            usage: routingUsageCounts(evaluation.usageJson),
          }
        : null,
      physicalReleased: owner ? owner.phase === 'released' && !owner.active : null,
      adoptedRoutingEvents: adopted,
      settingsPreserved: true,
      sourceAndCommentsPreserved: true,
      newWriteAuthorities: 0,
      benefitStatus: enabled
        ? manualRouteCorrections === 0
          ? 'observed'
          : 'Unverified'
        : 'baseline',
      nativeFacts,
      beforeState,
      zeroTurnProbe: probe,
      afterState: await routingSchedulingObservation(ctx.page, seed.sessionId),
      safeLogPhases: await routingSafeLogPhases(ctx.fixture),
    }
    await emitRoutingEvidence(info, enabled ? 'on' : 'off', facts)
    expect(evaluations).toHaveLength(enabled ? 1 : 0)
    if (enabled) {
      expect(evaluation).toMatchObject({
        called: true,
        active: false,
        outcome: 'completed',
      })
      expect(owner).toMatchObject({ kind: 'evaluation', active: false, phase: 'released' })
      if (evaluation?.selectedCandidateId === null) {
        // A valid abstention uses the legal default once. A later explicit user
        // correction completes the same source-author request; it earns no benefit.
        expect(first.agentId).toBe('claude')
        expect(runs.map((run) => run.agentId)).toEqual(['claude', 'codex'])
        expect(manualRouteCorrections).toBe(1)
        expect(adopted).toBe(0)
        expect(facts.benefitStatus).toBe('Unverified')
      } else {
        expect(evaluation?.selectedCandidateId).toBe('route_codex')
        expect(first.agentId).toBe('codex')
        expect(runs).toHaveLength(1)
        expect(manualRouteCorrections).toBe(0)
        expect(adopted).toBe(1)
        expect(facts.benefitStatus).toBe('observed')
      }
    } else {
      expect(first.agentId).toBe('claude')
      expect(runs.map((run) => run.agentId)).toEqual(['claude', 'codex'])
      expect(manualRouteCorrections).toBe(1)
      expect(adopted).toBe(0)
    }
    return facts
  } finally {
    db.close()
  }
}

for (const target of ['codex_luna', 'claude_haiku_5_5'] as const)
  test(
    `real Relay ${target} saves one source-author route correction against the legal default`,
    { tag: ['@real', '@real-extended'] },
    async ({ browserName: _browserName }, info) => {
      test.skip(
        process.platform !== 'darwin',
        'Verified production decision runtimes currently require macOS.',
      )
      test.setTimeout(360_000)
      const preflight = await verifyRoutingPreconditions()
      await emitRoutingEvidence(info, 'preregistered', preflight)
      const fixture = await createRuntimeFixture({ mode: 'real' })
      let ctx: RealWorkspace | undefined
      try {
        const claudeModel = fixture.readConfigurationModels().claude
        if (!claudeModel || !/^claude-haiku-5-5(?:-\d{8})?$/u.test(claudeModel))
          throw Error('Exact configured Haiku 5.5 model is required')
        const selection: SchedulingModelSelection =
          target === 'codex_luna'
            ? { target, provider: 'codex', modelId: 'gpt-6-luna' }
            : { target, provider: 'claude', modelId: claudeModel }
        const db = await PactDatabase.open({
          filePath: fixture.databaseFile,
          migrationsFolder: routingMigrations,
        })
        let off: RoutingSeed, on: RoutingSeed
        try {
          off = seedRoutingScenario(
            db,
            await fixture.createProjectDirectory('routing-off'),
            claudeModel,
            'Off',
          )
          on = seedRoutingScenario(
            db,
            await fixture.createProjectDirectory('routing-on'),
            claudeModel,
            'On',
          )
          expect({ report: on.reportSha256, comment: on.commentSha256 }).toEqual({
            report: off.reportSha256,
            comment: off.commentSha256,
          })
          expect(
            db.conversationRepository.ordinaryInputWorthConsulting(
              initialRoutingInput(db, on),
              'claude',
            ),
          ).toBe(true)
          db.conversationRepository.saveSchedulingSettings({
            expectedRevision: db.conversationRepository.schedulingSettings().revision,
            enabled: false,
            selection,
          })
          const contexts = db.drizzle.query.nativeAgentContexts.findMany().sync()
          expect(
            contexts.every(
              (value) => value.sessionId === off.sessionId || value.sessionId === on.sessionId,
            ),
          ).toBe(true)
          db.drizzle.delete(nativeAgentContexts).run()
        } finally {
          db.close()
        }
        const app = await fixture.launch(),
          page = await app.firstWindow()
        ctx = {
          fixture,
          app,
          page,
          sessionId: off.sessionId,
          projectId: off.projectId,
          projectDirectory: off.projectDirectory,
        }
        await expect
          .poll(
            () =>
              page.evaluate(async () => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
                  ready = await bridge.getRuntimePreparation()
                return ready.ok ? ready.value.agents.map((value) => value.state) : []
              }),
            { timeout: 30_000 },
          )
          .toEqual(['ready', 'ready'])
        const catalogs = await page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
            value = await bridge.getSessionSettings(sessionId)
          if (!value.ok) throw Error('Normal native catalog initialization failed')
          return {
            codex: value.value.modelCatalogs.codex.models.some(
              (model) => model.id === 'gpt-6-luna' || model.resolvedModel === 'gpt-6-luna',
            ),
            claude: value.value.modelCatalogs.claude.models.some(
              (model) =>
                model.id === value.value.session.settings.agents.claude.model ||
                model.resolvedModel === value.value.session.settings.agents.claude.model,
            ),
          }
        }, off.sessionId)
        expect(catalogs).toEqual({ codex: true, claude: true })
        const without = await runRouting(ctx, off, false, info)
        const enabled = await page.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
            settings = await bridge.getSchedulingSettings()
          if (!settings.ok) throw Error('Relay settings unavailable')
          return bridge.saveSchedulingSettings({
            expectedRevision: settings.value.revision,
            enabled: true,
          })
        })
        expect(enabled).toMatchObject({ ok: true, value: { selection, enabled: true } })
        const withRelay = await runRouting(ctx, on, true, info)
        expect(withRelay.evaluation).toMatchObject({
          provider: selection.provider,
          model: selection.modelId,
        })
        await emitRoutingEvidence(info, 'benefit', {
          target,
          preregistered: preregisteredRoutingMetrics,
          businessSettings: {
            codex: { model: 'gpt-6-luna', effort: 'low', permission: 'ask' },
            claude: { model: claudeModel, effort: null, permission: 'ask' },
          },
          ...routingBenefitSummary(without, withRelay),
          benefitStatus: withRelay.benefitStatus,
          generalBenefit: 'Unverified',
          benefitScope:
            'This preregistered unique-source-author routing scenario only; no general quality or latency claim.',
        })
      } catch (error) {
        if (ctx)
          await emitRoutingEvidence(
            info,
            'routing-failure-final-diagnostics',
            await routingSafeLogPhases(ctx.fixture, ctx.page),
          ).catch(() => undefined)
        throw error
      } finally {
        if (ctx) await closeRealWorkspace(ctx)
        else await fixture.dispose()
      }
    },
  )
