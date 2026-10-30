import { expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type {
  CollaborationDocument,
  DesktopBridge,
  SchedulingModelSelection,
} from '../../packages/contracts/src/index.js'

import { diagnosticRecordSchema } from '../../packages/contracts/src/diagnostics.js'
import {
  collaborationTaskSchema,
  advanceCollaboration,
  handoffGuidanceV2Schema,
  collaborationTurnAuthorizationSchema,
} from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import { nativeAgentContexts, workflowTurns } from '../../packages/persistence/src/schema/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  closeRealWorkspace,
  selectRealSession,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

// The five preceding Turns are explicit fixture prerequisites produced through
// the real Repository, not native/model execution evidence. Only the later
// Electron Continue, DecisionRuntime and fixed reviewer are real Provider work.
const goal =
  'Draft a conceptual three-step cancellation note. Acceptance: distinguish normal completion, cancellation, and disposal; name one cancellation owner; join that owner before releasing resources. Use only the supplied frozen sources. Do not inspect or modify project files, run commands, delegate, or add implementation. The scope is fully specified.'
const plan =
  '1. On normal completion, the existing operation owner joins its pending work before releasing its resources.\n2. On cancellation, that same owner signals cancellation once, then joins its pending work before releasing resources.\n3. On disposal, that same owner cancels remaining work and joins it before releasing resources. No second controller, project edit, or user choice is required.'
const review =
  'Clarify that cancellation and disposal keep the same operation owner and join pending work before resource release.'
const response =
  'The complete unchanged plan now distinguishes all three paths and keeps one owner responsible for cancellation and joining. No scope or permission change is requested.'
const focus = { id: 'cancellation-owner-join', terms: ['cancel', 'join'], source: review }
const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

interface Seed {
  sessionId: string
  projectId: string
  projectDirectory: string
  taskId: string
  planVersion: number
  sourceHashes: Array<{ roles: string[]; sha256: string; bytes: number; chars: number }>
  fixtureRunIds: string[]
}

async function seed(
  fixture: RuntimeFixture,
  db: PactDatabase,
  label: 'Off' | 'On',
  claudeModel: string,
): Promise<Seed> {
  const projectDirectory = await fixture.createProjectDirectory(`relay-real-${label.toLowerCase()}`)
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    messageId = randomUUID(),
    createdAt = new Date().toISOString(),
    repo = db.conversationRepository
  const settings = {
    primaryAgentId: 'codex',
    agents: {
      codex: { model: 'gpt-6-luna', effort: 'low' },
      claude: { model: claudeModel, effort: null },
    },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  } as const
  db.projectCatalogRepository.add({
    id: projectId,
    name: `Relay real ${label}`,
    directoryPath: projectDirectory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: `Relay real ${label}`, createdAt },
    settings,
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: 'codex',
    reviewer: 'claude',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    task: goal,
    taskMessageId: messageId,
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  const ids: string[] = []
  const finish = (runId: string, publish: boolean, verdict?: 'changes_requested') => {
    const run = repo.findRun(runId)!,
      nativeSessionId = `fixture-${sessionId}-${run.agentId}`,
      turnId = `fixture-${runId}`
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: run.agentId,
      nativeSessionId,
    })
    repo.applyEvent(sessionId, runId, { type: 'turn.started', agentId: run.agentId, turnId })
    if (publish) repo.recordWorkflowPlan(runId, { nativeId: `fixture-plan-${runId}`, text: plan })
    else if (run.collaboration?.stage === 'plan') {
      const document = repo.collaboration(sessionId)!.planReference!.document
      repo.recordWorkflowPlanRetained(runId, {
        nativeId: `fixture-retained-${runId}`,
        sha256: document.sha256,
        bytes: document.bytes,
        chars: document.chars,
      })
    }
    if (verdict) repo.recordWorkflowReview(runId, { verdict })
    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId,
      outputId: `fixture-answer-${runId}`,
      text: verdict ? review : response,
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: run.agentId,
        requestId: runId,
        runId,
        nativeSessionId,
        nativeTurnId: turnId,
        bindingGeneration: run.bindingGeneration ?? 1,
      },
    })
    repo.recordNativeEffects(runId, 'settled')
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(runId, 'settled')
    ids.push(runId)
  }
  const first = repo.beginRun({
    sessionId,
    clientMessageId: messageId,
    content: `/plan ${goal}`,
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: 1,
    model: 'gpt-6-luna',
    effort: 'low',
    collaboration: initial,
  }).run
  finish(first.id, true)
  const next = () => {
    const task = repo.collaboration(sessionId)!,
      candidate = advanceCollaboration(task, 'continue', settings),
      agent = settings.agents[candidate.actor]
    return repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Continue the same conceptual plan and its fixed review.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: candidate.actor,
      settingsRevision: 1,
      model: agent.model,
      effort: agent.effort,
      preserveDraftComments: true,
      expectedCollaborationRevision: task.revision,
      collaboration: candidate,
      schedulingHandoff: repo.workflowHandoff(task, candidate.actor),
    }).run
  }
  finish(next().id, false, 'changes_requested')
  finish(next().id, false)
  finish(next().id, false, 'changes_requested')
  finish(next().id, false)
  const task = repo.collaboration(sessionId)!,
    handoff = repo.workflowHandoff(task, task.reviewer)
  expect(repo.relaySupplementOpportunity(handoff)).toMatchObject({ kind: 'supplement_plan' })
  const material = await repo.readRelayWorkflowDecisionSources(
    handoff,
    [
      {
        id: 'continue_plan_review',
        description: 'Return the complete retained plan to its fixed reviewer.',
      },
    ],
    { signal: new AbortController().signal, deadlineAt: Date.now() + 15_000 },
  )
  // Every byte was read; equality is by literal content, not by unrelated UUIDs.
  const sourceHashes = material.sources
    .map((source) => ({
      roles: source.roles.toSorted(),
      sha256: source.document.sha256,
      bytes: source.document.bytes,
      chars: source.document.chars,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    sessionId,
    projectId,
    projectDirectory,
    taskId: task.id,
    planVersion: task.planVersion,
    sourceHashes,
    fixtureRunIds: ids,
  }
}

async function act(page: Page, sessionId: string, action: 'resume' | 'pause') {
  const actionResult = await page.evaluate(
    async (payload) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
        current = await bridge.getConversation({
          scope: 'collaboration',
          sessionId: payload.sessionId,
        })
      if (!current.ok || current.value.scope !== 'collaboration' || !current.value.view.task)
        throw Error('Current workflow is unavailable')
      const task = current.value.view.task,
        actionReply = await bridge.actOnCollaboration({
          sessionId: payload.sessionId,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: crypto.randomUUID(),
          action: payload.action,
        })
      return actionReply.ok ? { ok: true } : { ok: false, error: actionReply.error.code }
    },
    { sessionId, action },
  )
  expect(actionResult).toEqual({ ok: true })
}
async function readCompleteSource(
  page: Page,
  sessionId: string,
  runId: string,
  source: CollaborationDocument,
) {
  const completeText = await page.evaluate(
    async (payload) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      let text = '',
        offset = 0
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the complete immutable source one physical page at a time.
        const result = await bridge.getConversation({
          scope: 'collaboration-text',
          sessionId: payload.sessionId,
          runId: payload.runId,
          document: payload.source,
          offset,
        })
        if (!result.ok || result.value.scope !== 'collaboration-text')
          throw Error('Complete source is unavailable')
        text += result.value.text
        if (result.value.nextOffset === null) return text
        offset = result.value.nextOffset
      }
    },
    { sessionId, runId, source },
  )
  expect(Buffer.byteLength(completeText)).toBe(source.bytes)
  expect(createHash('sha256').update(completeText).digest('hex')).toBe(source.sha256)
  return completeText
}
async function schedulingObservation(page: Page, sessionId: string, refresh = false) {
  return page.evaluate(
    async (payload) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const reply = payload.refresh
        ? await bridge.refreshSchedulingState({ sessionId: payload.sessionId })
        : await bridge.getSchedulingState({ sessionId: payload.sessionId })
      if (!reply.ok) return { ok: false as const, error: reply.error.code }
      const state = reply.value
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper must travel inside the serialized browser closure.
      const project = (value: typeof state.host) => ({
        status: value.status,
        provider: value.capability?.provider ?? null,
        model: value.capability?.modelId ?? null,
        reason: value.capability?.reason ?? null,
        physicalReleased: value.capability?.physicalReleased ?? null,
      })
      return {
        ok: true as const,
        enabled: state.settings.enabled,
        host: project(state.host),
        context: state.context
          ? { eligibility: state.context.eligibility, ...project(state.context.observation) }
          : null,
        decision: state.activity.decision.status,
        check: state.activity.check.status,
      }
    },
    { sessionId, refresh },
  )
}

async function safeLogPhases(fixture: RuntimeFixture) {
  try {
    const path = join(dirname(fixture.databaseFile), 'logs/development/pact-0.jsonl'),
      before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 5 * 1024 * 1024)
      return { status: 'unavailable' }
    const handle = await open(path, 'r')
    try {
      const current = await handle.stat()
      if (current.dev !== before.dev || current.ino !== before.ino) return { status: 'changed' }
      const size = Math.min(current.size, 64 * 1024),
        start = current.size - size,
        bytes = Buffer.alloc(size)
      const read = await handle.read(bytes, 0, size, start),
        text = bytes.subarray(0, read.bytesRead).toString('utf8'),
        lines = text.split('\n')
      if (start) lines.shift()
      const events = lines.flatMap((line) => {
        if (!line) return []
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          return []
        }
        const parsed = diagnosticRecordSchema.safeParse(raw)
        if (!parsed.success) return []
        const value = parsed.data
        return [
          {
            operation: value.operation,
            phase: value.phase,
            level: value.level,
            agent: value.agentId ?? null,
            code: value.code ?? null,
            catalogPhase: value.settingsCatalogPhase ?? null,
            catalogFailure: value.settingsCatalogFailure ?? null,
            boundary: value.runtimeBoundary ?? null,
            errorType: value.runtimeErrorType ?? null,
          },
        ]
      })
      return { status: 'bounded-tail', tailBytes: read.bytesRead, events: events.slice(-32) }
    } finally {
      await handle.close()
    }
  } catch {
    return { status: 'unavailable' }
  }
}
function usageCounts(text: string | null) {
  if (!text) return null
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const counts: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens']) {
    const count: unknown = Reflect.get(value, key)
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count
  }
  return counts
}

async function runHandoff(ctx: RealWorkspace, prepared: Seed, enabled: boolean) {
  ctx.projectId = prepared.projectId
  ctx.sessionId = prepared.sessionId
  ctx.projectDirectory = prepared.projectDirectory
  await selectRealSession(ctx, prepared.sessionId)
  const beforeProbe = await schedulingObservation(ctx.page, prepared.sessionId)
  const probeStartedAt = Date.now()
  const zeroTurnProbe = enabled
    ? await schedulingObservation(ctx.page, prepared.sessionId, true)
    : beforeProbe
  if (enabled)
    await expect
      .poll(
        async () => {
          const value = await schedulingObservation(ctx.page, prepared.sessionId)
          return value.ok ? value.decision : 'unavailable'
        },
        { timeout: 20_000, intervals: [100, 250, 500] },
      )
      .toBe('idle')
  const afterProbe = await schedulingObservation(ctx.page, prepared.sessionId)
  const probeElapsedMs = Date.now() - probeStartedAt
  // Disposable observations never authorize this handoff: production Runtime
  // independently performs every admission/native check again after Continue.
  const observation = ReadonlyFixtureDatabase.open(ctx.fixture)
  const startedAt = Date.now()
  let cancelledCards = 0
  const answered = new Set<string>()
  try {
    await act(ctx.page, prepared.sessionId, 'resume')
    let realRunId: string | undefined
    await expect
      .poll(
        async () => {
          const rows = observation.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, prepared.sessionId),
              columns: { id: true, nativeTurnId: true, dispatchPhase: true },
              limit: 8,
            })
            .sync()
          const real = rows.filter((row) => !prepared.fixtureRunIds.includes(row.id))
          if (real.length > 1) throw Error('Unexpected additional business generation')
          if (real[0]?.nativeTurnId) {
            realRunId = real[0].id
            return true
          }
          const pending = await ctx.page.evaluate(async (sessionId) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
              header = await bridge.getConversation({ scope: 'messages', sessionId })
            return header.ok && header.value.scope === 'messages'
              ? header.value.header.relaySchedulingDecision
              : null
          }, prepared.sessionId)
          if (pending && !answered.has(pending.decisionId)) {
            expect(enabled).toBe(true)
            expect(pending.request.category).toBe('new_authorization')
            answered.add(pending.decisionId)
            const result = await ctx.page.evaluate(
              async (reference) => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
                return bridge.answerRelayDecision({
                  reference,
                  clientOperationId: crypto.randomUUID(),
                  answer: { kind: 'cancel' },
                })
              },
              {
                sessionId: prepared.sessionId,
                decisionId: pending.decisionId,
                revision: pending.revision,
              },
            )
            expect(result).toMatchObject({ ok: true, value: { disposition: 'cancelled' } })
            cancelledCards++
            await act(ctx.page, prepared.sessionId, 'resume')
          }
          return false
        },
        { timeout: 45_000, intervals: [50, 100, 250] },
      )
      .toBe(true)
    // Bound paid work without changing or interrupting this genuine reviewer:
    // Pause only following automation after its real Run has been admitted.
    await act(ctx.page, prepared.sessionId, 'pause')
    const complete = await waitForRealCompletion(ctx, prepared.fixtureRunIds.length + 1)
    const run = complete.runs.find((value) => value.id === realRunId)!
    expect(run).toMatchObject({
      agentId: 'claude',
      status: 'completed',
      collaboration: { taskId: prepared.taskId, stage: 'plan_review' },
    })
    await expect
      .poll(() => observation.conversationRepository.findRun(run.id)?.nativeEffectsState, {
        timeout: 15_000,
      })
      .toBe('settled')
    const answer = complete.messages.find((value) => value.id === run.responseMessageId)!
    expect(answer).toMatchObject({ state: 'complete', role: 'assistant' })
    expect(answer.content.trim().length).toBeGreaterThan(0)
    const turn = observation.drizzle
      .select()
      .from(workflowTurns)
      .all()
      .find((value) => value.runId === run.id)!
    expect(turn.reportBodyId).toBeTruthy()
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    expect(auth.userAuthority).toBeUndefined()
    let guidance: null | {
      sourceCount: number
      highlightCount: number
      predefinedFocusCovered: boolean
    } = null
    if (auth.sourceManifestRef) {
      const parsed = handoffGuidanceV2Schema.parse(
        JSON.parse(
          await readCompleteSource(ctx.page, prepared.sessionId, run.id, auth.sourceManifestRef),
        ),
      )
      expect(parsed.basis.task.id).toBe(prepared.taskId)
      for (const source of parsed.sources) {
        expect(prepared.sourceHashes.map((value) => value.sha256)).toContain(source.document.sha256)
        expect(source.sourceRunId).toBeTruthy()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Verify complete citations rather than truncated source samples.
        await readCompleteSource(ctx.page, prepared.sessionId, source.sourceRunId!, source.document)
      }
      const text = parsed.highlights
        .map((value) => value.text)
        .join(' ')
        .toLowerCase()
      guidance = {
        sourceCount: parsed.sources.length,
        highlightCount: parsed.highlights.length,
        predefinedFocusCovered: focus.terms.every((term) => text.includes(term)),
      }
    }
    const evaluations = observation.drizzle.query.schedulingEvaluations
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, prepared.sessionId), limit: 4 })
      .sync()
    const diagnostic = {
      evaluation: evaluations.map((value) => ({
        called: value.called,
        active: value.active,
        outcome: value.outcome,
        provider: value.provider,
        model: value.model,
        createdAt: value.createdAt,
        deadline: value.deadline,
        settledAt: value.settledAt,
        usage: usageCounts(value.usageJson),
      })),
      beforeProbe,
      zeroTurnProbe,
      afterProbe,
      afterHandoff: await schedulingObservation(ctx.page, prepared.sessionId),
      probeElapsedMs,
      logs: await safeLogPhases(ctx.fixture),
    }
    const diagnosticText = JSON.stringify(diagnostic)
    if (Buffer.byteLength(diagnosticText) > 16 * 1024)
      throw Error('Bounded handoff diagnostics exceeded their observation limit')
    console.info('[pact-relay-real-admission]', diagnosticText)
    await test.info().attach(`relay-${enabled ? 'on' : 'off'}-admission-evidence`, {
      body: Buffer.from(diagnosticText),
      contentType: 'application/json',
    })
    expect(evaluations, diagnosticText).toHaveLength(enabled ? 1 : 0)
    const evaluated = evaluations[0]
    if (evaluated) {
      expect(evaluated, diagnosticText).toMatchObject({
        called: true,
        active: false,
        outcome: 'completed',
      })
      const owner = observation.drizzle.query.schedulingRuntimeOwners
        .findFirst({ where: (fields, { eq }) => eq(fields.evaluationId, evaluated.id) })
        .sync()!
      expect(owner).toMatchObject({ kind: 'evaluation', active: false, phase: 'released' })
    }
    const task = observation.drizzle.query.collaborationTasks
      .findFirst({ where: (fields, { eq }) => eq(fields.id, prepared.taskId) })
      .sync()!
    const final = collaborationTaskSchema.parse(JSON.parse(task.stateJson))
    expect(final).toMatchObject({
      id: prepared.taskId,
      owner: 'codex',
      reviewer: 'claude',
      planVersion: prepared.planVersion,
      repairAttempts: 0,
      reviewCycles: 0,
    })
    expect(final.planReference?.document.sha256).toBe(
      createHash('sha256').update(plan).digest('hex'),
    )
    const reservations = observation.drizzle.query.schedulingBudgetReservations
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, prepared.sessionId), limit: 4 })
      .sync()
    expect(reservations).toEqual([])
    const decisions = observation.drizzle.query.relayDecisions
      .findMany({ where: (fields, { eq }) => eq(fields.sessionId, prepared.sessionId), limit: 4 })
      .sync()
    expect(decisions.length).toBe(cancelledCards)
    const native = await findNativeRecord(ctx, 'claude', run.nativeSessionId!)
    expect(native.claudeUserInputs).toBe(1)
    expect(native.assistantModels).toContain(run.model)
    const publicActivity = await ctx.page.evaluate(async () => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      return bridge.readSchedulingActivity({})
    })
    expect(publicActivity.ok).toBe(true)
    return {
      enabled,
      fixtureBusinessTurns: prepared.fixtureRunIds.length,
      realBusinessTurns: 1,
      requiredReviewRetained: true,
      fixedReviewer: 'claude',
      realReviewerModel: run.model,
      completeReportSha256: createHash('sha256').update(answer.content).digest('hex'),
      nativeRecordSha256: native.sha256,
      reviewFocusCovered: focus.terms.every((term) => answer.content.toLowerCase().includes(term)),
      elapsedMs: Date.now() - startedAt,
      zeroTurnProbeElapsedMs: probeElapsedMs,
      decisionCalls: evaluations.filter((value) => value.called).length,
      decisionModel: evaluated?.model ?? null,
      decisionProvider: evaluated?.provider ?? null,
      decisionOutcome: evaluated?.outcome ?? null,
      selectedCandidateId: evaluated?.selectedCandidateId ?? null,
      decisionElapsedMs: evaluated?.settledAt
        ? Date.parse(evaluated.settledAt) - Date.parse(evaluated.createdAt)
        : null,
      observableDecisionUsage: usageCounts(evaluated?.usageJson ?? null),
      decisionPhysicalReleased: !evaluated || !evaluated.active,
      decisionCards: decisions.length,
      manualCheckRequests: 0,
      cancelledCards,
      pausedOnlyFollowingAutomation: true,
      guidance,
    }
  } finally {
    observation.close()
  }
}

for (const target of ['codex_luna', 'claude_haiku_5_5'] as const)
  test(
    `real Relay ${target} compares Off and On through the fixed native reviewer`,
    { tag: ['@real', '@real-extended'] },
    async () => {
      test.skip(
        process.platform !== 'darwin',
        'Production decision runtimes currently require the verified macOS native profile.',
      )
      test.setTimeout(360_000)
      const fixture = await createRuntimeFixture({ mode: 'real' })
      let ctx: RealWorkspace | undefined
      try {
        const claudeModel = fixture.readConfigurationModels().claude
        if (!claudeModel || !/^claude-haiku-5-5(?:-\d{8})?$/u.test(claudeModel))
          throw Error('Exact configured Claude Haiku 5.5 wire model is required')
        const selection: SchedulingModelSelection =
          target === 'codex_luna'
            ? { target, provider: 'codex', modelId: 'gpt-6-luna' }
            : { target, provider: 'claude', modelId: claudeModel }
        const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
        let off: Seed, on: Seed
        try {
          off = await seed(fixture, db, 'Off', claudeModel)
          on = await seed(fixture, db, 'On', claudeModel)
          expect(on.sourceHashes).toEqual(off.sourceHashes)
          db.conversationRepository.saveSchedulingSettings({
            expectedRevision: db.conversationRepository.schedulingSettings().revision,
            enabled: false,
            selection,
          })
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
          projectId: off.projectId,
          projectDirectory: off.projectDirectory,
          sessionId: off.sessionId,
        }
        await expect
          .poll(
            () =>
              page.evaluate(async () => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
                  state = await bridge.getRuntimePreparation()
                return state.ok ? state.value.agents.map((value) => value.state) : []
              }),
            { timeout: 30_000 },
          )
          .toEqual(['ready', 'ready'])
        // Normal zero-inference catalog initialization owns installation identity;
        // DecisionRuntime must never fabricate or repair native configuration.
        const catalog = await page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
            settings = await bridge.getSessionSettings(sessionId)
          if (!settings.ok) throw Error('Actual native catalogs are unavailable')
          return {
            codex: settings.value.modelCatalogs.codex.models.some(
              (model) => model.id === 'gpt-6-luna' || model.resolvedModel === 'gpt-6-luna',
            ),
            claude: settings.value.modelCatalogs.claude.models.some(
              (model) =>
                model.id === settings.value.session.settings.agents.claude.model ||
                model.resolvedModel === settings.value.session.settings.agents.claude.model,
            ),
          }
        }, off.sessionId)
        expect(catalog).toEqual({ codex: true, claude: true })
        const without = await runHandoff(ctx, off, false)
        const enabled = await page.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
            settings = await bridge.getSchedulingSettings()
          if (!settings.ok) throw Error('Relay settings unavailable')
          return bridge.saveSchedulingSettings({
            expectedRevision: settings.value.revision,
            enabled: true,
          })
        })
        expect(enabled).toMatchObject({ ok: true, value: { enabled: true, selection } })
        const withRelay = await runHandoff(ctx, on, true)
        expect(withRelay.decisionModel).toBe(selection.modelId)
        expect(withRelay.decisionProvider).toBe(selection.provider)
        expect(withRelay.decisionCalls).toBe(1)
        const comparison = {
          target,
          fixturePrerequisitesOnly: true,
          sourceContentEqual: true,
          sourceHashes: off.sourceHashes,
          businessSettings: {
            codex: { model: 'gpt-6-luna', effort: 'low' },
            claude: { model: claudeModel, effort: null },
          },
          predefinedFocus: { id: focus.id, terms: focus.terms },
          metrics: [
            'grounded focus',
            'fixed reviewer',
            'required review',
            'business Turns',
            'decision cards',
            'manual checks',
            'latency',
            'observable usage',
          ],
          off: without,
          on: withRelay,
          optimizationBenefitClaimed: false,
        }
        const comparisonText = JSON.stringify(comparison)
        if (Buffer.byteLength(comparisonText) > 16 * 1024)
          throw Error('Safe Relay comparison exceeded its observation limit')
        console.info('[pact-relay-real-comparison]', comparisonText)
        await test.info().attach(`relay-real-${target}-comparison`, {
          contentType: 'application/json',
          body: Buffer.from(comparisonText),
        })
      } finally {
        if (ctx) await closeRealWorkspace(ctx)
        else await fixture.dispose()
      }
    },
  )
