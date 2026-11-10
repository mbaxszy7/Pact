import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { markdownVisibleProjection } from '../../apps/desktop/src/shared/message-anchor-text.js'
import { diagnosticRecordSchema } from '../../packages/contracts/src/diagnostics.js'
import {
  collaborationTaskSchema,
  collaborationPlanSettlementSchema,
  collaborationTurnAuthorizationSchema,
  collaborationReviewObservationSchema,
  type CollaborationPlanSettlement,
  type CollaborationPlanReference,
} from '../../packages/contracts/src/index.js'
import { workflowTurns } from '../../packages/persistence/src/schema/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  selectRealConfiguredEffort,
  sendRealMessage,
  type RealWorkspace,
  readRealConversation,
  restartRealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

for (const owner of ['codex', 'claude'] as const)
  test(
    `real ${owner} retains an unchanged plan and settles its reply without implementation authority`,
    { tag: ['@real', '@real-extended'] },
    async () => {
      test.setTimeout(300_000)
      const deadline = Date.now() + 300_000
      const ctx = await launchRealWorkspace(`real-retain-plan-${owner}`)
      const readView = () =>
        ctx.page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const result = await bridge.getConversation({ scope: 'collaboration', sessionId })
          if (!result.ok || result.value.scope !== 'collaboration')
            throw new Error('Collaboration view unavailable')
          return result.value.view
        }, ctx.sessionId)
      try {
        await selectRealConfiguredEffort(ctx, ['codex', 'claude'], owner)
        const initialRequest =
          '/plan Draft a concise conceptual plan for documenting cancellation ownership. Fixed requirements: one requester owns the request handle and cancellation authority; scope disposal delegates cancellation to that same owner. The executor releases work-local resources before its terminal acknowledgement, then the requester releases its handle exactly once. Normal completion needs no cancellation. Repeated cancellation/disposal is idempotent and awaits the same terminal cleanup. Acceptance: three concrete steps covering normal completion, cancellation, and disposal, naming each resource owner and release condition. All choices are specified. Do not inspect or modify project files, run commands, or delegate. The native plan document is permitted. Publish the complete official plan through the native plan mechanism.'
        // Exercise default Primary routing: an @claude prefix masks native /plan interception.
        await sendRealMessage(ctx, initialRequest, 'primary')
        await expect
          .poll(
            async () => {
              const view = await readView()
              if (view.task?.status === 'failed')
                throw new Error('Initial real plan or review did not settle')
              return view.accepted && view.task?.status === 'ready'
            },
            { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] },
          )
          .toBe(true)
        const initial = (await readView()).task!
        expect(initial.owner).toBe(owner)
        expect(initial.reviewer).toBe(owner === 'codex' ? 'claude' : 'codex')
        const originalPlan = initial.planReference!
        const originalText = await readRequiredPlanSource(ctx, originalPlan)
        const initialConversation = await readRealConversation(ctx)
        expect(
          initialConversation.messages.find((message) => message.role === 'user')?.content,
        ).toBe(initialRequest)
        expect(
          initialConversation.runs.find((run) => run.collaboration?.stage === 'plan')?.agentId,
        ).toBe(owner)
        const initialRuns = initialConversation.runs.length
        await sendRealMessage(
          ctx,
          'Recheck the existing accepted plan against my unchanged requirements: cancellation and repeated disposal use the same owner and terminal cleanup. There is no new requirement or choice. If the current plan already covers these requirements, briefly confirm why it remains correct and call retain_current_plan with an empty object in this root. Preserve the existing official plan exactly: do not rewrite or republish it, do not use ExitPlanMode as a substitute for this explicit retention operation, and do not implement or delegate.',
          owner,
        )
        await expect
          .poll(
            async () => {
              const view = await readView()
              if (view.task?.status === 'failed')
                throw new Error('Real unchanged-plan reply lacks authenticated retention')
              return (
                view.task?.inputProcessing?.settled?.inputSequence === initial.inputSequence + 1 &&
                !view.task.inputProcessing.pending &&
                view.task.automation === 'active' &&
                view.accepted &&
                view.task.status === 'ready'
              )
            },
            { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] },
          )
          .toBe(true)
        const retained = await readView()
        expect(retained.task?.planReference).toEqual(originalPlan)
        expect(retained.task?.planVersion).toBe(initial.planVersion)
        expect(retained.task?.planInputSequence).toBe(initial.inputSequence + 1)
        expect(retained.task?.review).toMatchObject({
          actor: initial.reviewer,
          inputSequence: initial.inputSequence + 1,
          planReference: originalPlan,
          verdict: 'accepted',
        })
        expect(retained.task?.review?.runId).not.toBe(initial.review?.runId)
        expect(retained.task?.pauseReason).toBeUndefined()
        expect(retained.accepted).toBe(true)
        expect(retained.availableActions).not.toContain('resume')
        expect(retained.availableActions).toContain('execute')
        expect(await readRequiredPlanSource(ctx, retained.task!.planReference!)).toBe(originalText)
        const snapshot = await readRealConversation(ctx)
        expect(snapshot.runs).toHaveLength(initialRuns + 2)
        const reply = snapshot.runs.find(
          (run) => run.id === retained.task!.inputProcessing!.settled!.runId,
        )!
        expect(reply).toMatchObject({
          agentId: owner,
          status: 'completed',
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          collaboration: { stage: 'reply' },
        })
        const database = ReadonlyFixtureDatabase.open(ctx.fixture)
        try {
          const facts = database.drizzle.query.agentEventJournal
            .findMany({
              where: (fields, { and, eq }) =>
                and(eq(fields.runId, reply.id), eq(fields.eventType, 'workflow.plan_settled')),
              columns: { payload: true },
              limit: 2,
            })
            .sync()
          expect(facts).toHaveLength(1)
          const confirmations = database.drizzle.query.agentEventJournal
            .findMany({
              where: (fields, { and, eq }) =>
                and(eq(fields.runId, reply.id), eq(fields.eventType, 'workflow.plan_retained')),
              columns: { payload: true },
              limit: 2,
            })
            .sync()
          expect(confirmations).toHaveLength(1)
          expect(JSON.parse(confirmations[0]!.payload)).toMatchObject({
            confirmation: 'native_root_settled_v1',
            sha256: originalPlan.document.sha256,
            bytes: originalPlan.document.bytes,
            chars: originalPlan.document.chars,
          })
          expect(
            collaborationPlanSettlementSchema.parse(JSON.parse(facts[0]!.payload)),
          ).toMatchObject({
            kind: 'retained',
            planReference: originalPlan,
            inputSequence: initial.inputSequence + 1,
          })
        } finally {
          database.close()
        }
        await restartRealWorkspace(ctx)
        const cold = await readView()
        expect(cold.task?.planReference).toEqual(originalPlan)
        expect(cold.task?.inputProcessing).toEqual(retained.task?.inputProcessing)
        expect(cold.task?.automation).toBe('paused')
        expect((await readRealConversation(ctx)).runs).toHaveLength(initialRuns + 2)
        await ctx.page.getByRole('button', { name: 'Continue collaboration', exact: true }).click()
        await expect
          .poll(
            async () => {
              const view = await readView()
              if (view.task?.status === 'failed')
                throw new Error('Current-input independent review failed')
              return view.accepted && view.task?.review?.inputSequence === initial.inputSequence + 1
            },
            { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] },
          )
          .toBe(true)
        const reviewed = await readView()
        expect(reviewed.task?.review?.actor).toBe(initial.reviewer)
        expect(reviewed.task?.planReference).toEqual(originalPlan)
        expect(reviewed.task?.review).toEqual(retained.task?.review)
        expect((await readRealConversation(ctx)).runs).toHaveLength(initialRuns + 2)
        expect(reviewed.availableActions).toContain('execute')
        expect(
          (await readRealConversation(ctx)).runs.some((run) =>
            ['implement', 'repair'].includes(run.collaboration?.stage ?? ''),
          ),
        ).toBe(false)
      } catch (error) {
        const view = await readView().catch(() => undefined)
        const snapshot = await readRealConversation(ctx).catch(() => undefined)
        const lastRun = snapshot?.runs.find((run) => run.id === view?.task?.runId)
        const counts: Array<{ type: string; count: number }> = []
        if (lastRun) {
          const database = ReadonlyFixtureDatabase.open(ctx.fixture)
          try {
            const rows = database.drizzle.query.agentEventJournal
              .findMany({
                where: (fields, { eq }) => eq(fields.runId, lastRun.id),
                columns: { eventType: true },
                limit: 1024,
              })
              .sync()
            for (const type of new Set(rows.map((row) => row.eventType)))
              counts.push({ type, count: rows.filter((row) => row.eventType === type).length })
          } finally {
            database.close()
          }
        }
        const planDiagnostics: object[] = []
        const log = await open(
          join(dirname(ctx.fixture.databaseFile), 'logs/development/pact-0.jsonl'),
          'r',
        ).catch(() => undefined)
        if (log) {
          try {
            const size = (await log.stat()).size
            if (size <= 1024 * 1024) {
              const bytes = Buffer.alloc(size)
              const read = await log.read(bytes, 0, size, 0)
              for (const line of bytes.subarray(0, read.bytesRead).toString('utf8').split('\n')) {
                if (!line) continue
                try {
                  const parsed = diagnosticRecordSchema.safeParse(JSON.parse(line))
                  if (
                    parsed.success &&
                    parsed.data.runId === lastRun?.id &&
                    parsed.data.operation === 'claude_plan' &&
                    planDiagnostics.length < 64
                  )
                    planDiagnostics.push({
                      stage: parsed.data.planStage,
                      reason: parsed.data.planReason,
                      capture: parsed.data.planCapture,
                    })
                } catch {
                  /* Only complete validated diagnostic records are evidence. */
                }
              }
            }
          } finally {
            await log.close()
          }
        }
        let tools: Record<string, number> | undefined
        if (lastRun?.nativeSessionId) {
          const native = await findNativeRecord(ctx, owner, lastRun.nativeSessionId).catch(
            () => undefined,
          )
          if (native) {
            tools = {}
            for (const name of native.toolNames) {
              const allowed = [
                'retain_current_plan',
                'submit_input_result',
                'submit_review',
                'Write',
                'Edit',
                'ExitPlanMode',
                'AskUserQuestion',
              ]
              const key =
                allowed.find((value) => name === value || name.endsWith(`__${value}`)) ?? 'other'
              tools[key] = (tools[key] ?? 0) + 1
            }
          }
        }
        const diagnostic = {
          owner,
          task: view?.task && {
            status: view.task.status,
            stage: view.task.stage,
            planVersion: view.task.planVersion,
            inputSequence: view.task.inputSequence,
            planInputSequence: view.task.planInputSequence,
            pending: Boolean(view.task.inputProcessing?.pending),
          },
          run: lastRun && {
            status: lastRun.status,
            outcome: lastRun.nativeOutcome,
            effects: lastRun.nativeEffectsState,
            failureKind: lastRun.failureKind,
          },
          counts,
          planDiagnostics,
          tools,
        }
        const encoded = JSON.stringify(diagnostic)
        if (Buffer.byteLength(encoded) <= 64 * 1024) {
          await writeFile(test.info().outputPath('retention-failure-scalars.json'), encoded)
          console.log(`[pact-retention] ${encoded}`)
        }
        throw error
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )

/** The exact immutable source must remain complete, including the first author's v1. */
async function readRequiredPlanSource(
  ctx: RealWorkspace,
  expectedReference: CollaborationPlanReference,
): Promise<string> {
  const completeText = await ctx.page.evaluate(
    async ({ sessionId, reference }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      let offset = 0,
        text = ''
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- Each authenticated page supplies the next exact cursor.
        const page = await bridge.getConversation({
          scope: 'collaboration-text',
          sessionId,
          runId: reference.sourceRunId,
          document: reference.document,
          offset,
        })
        if (!page.ok || page.value.scope !== 'collaboration-text')
          throw Error('Complete plan source unavailable')
        text += page.value.text
        if (text.length > reference.document.chars)
          throw Error('The plan source exceeds its exact reference')
        if (page.value.nextOffset === null) return text
        if (page.value.nextOffset <= offset || page.value.nextOffset > reference.document.chars)
          throw Error('The plan source cursor is invalid')
        offset = page.value.nextOffset
      }
    },
    { sessionId: ctx.sessionId, reference: expectedReference },
  )
  expect(completeText.length).toBe(expectedReference.document.chars)
  expect(Buffer.byteLength(completeText)).toBe(expectedReference.document.bytes)
  expect(createHash('sha256').update(completeText).digest('hex')).toBe(
    expectedReference.document.sha256,
  )
  expect(completeText.trim().length).toBeGreaterThan(0)
  return completeText
}

/** Observe a legal plan/review chain without accepting questions, pauses or limit exhaustion. */
async function waitForRequiredPlan(
  ctx: RealWorkspace,
  owner: 'codex' | 'claude',
  maxReviews: number,
) {
  const database = ReadonlyFixtureDatabase.open(ctx.fixture)
  let lastObservation: unknown
  try {
    await expect
      .poll(
        () => {
          const taskRow = database.drizzle.query.collaborationTasks
            .findFirst({
              where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
              columns: { stateJson: true },
            })
            .sync()
          const rows = database.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
              columns: {
                id: true,
                status: true,
                nativeOutcome: true,
                nativeEffectsState: true,
                updatedAt: true,
              },
              limit: maxReviews * 2 + 1,
            })
            .sync()
          if (rows.length > maxReviews * 2)
            throw Error('A required-plan case exceeded its frozen review budget')
          if (rows.some((row) => ['failed', 'interrupted'].includes(row.status)))
            throw Error('A required native plan/review root failed')
          if (!taskRow) return false
          const task = collaborationTaskSchema.parse(JSON.parse(taskRow.stateJson))
          lastObservation = {
            observedAt: new Date().toISOString(),
            task: {
              status: task.status,
              stage: task.stage,
              automation: task.automation,
              pauseReason: task.pauseReason,
              planVersion: task.planVersion,
              discussionRounds: task.discussionRounds,
              verdict: task.review?.verdict,
            },
            runs: rows,
          }
          return (
            task.status === 'ready' &&
            task.review?.verdict === 'accepted' &&
            rows.length === task.discussionRounds * 2 &&
            rows.every(
              (row) =>
                row.status === 'completed' &&
                row.nativeOutcome === 'completed' &&
                row.nativeEffectsState === 'settled',
            )
          )
        },
        { timeout: 300_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
      .catch((error: unknown) => {
        throw new Error(
          `Required plan settlement: ${JSON.stringify(lastObservation)}; ${error instanceof Error ? error.message : 'observation failed'}`,
          { cause: error },
        )
      })
    const snapshot = await readRealConversation(ctx)
    const runs = snapshot.runs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    const turns = database.drizzle
      .select()
      .from(workflowTurns)
      .limit(maxReviews * 2 + 1)
      .all()
    const row = database.drizzle.query.collaborationTasks
      .findFirst({
        where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
        columns: { stateJson: true },
      })
      .sync()!
    const task = collaborationTaskSchema.parse(JSON.parse(row.stateJson))
    expect(task.inputSequence).toBe(1)
    expect(task.discussionRounds).toBeGreaterThan(0)
    expect(task.discussionRounds).toBeLessThanOrEqual(maxReviews)
    expect(runs).toHaveLength(task.discussionRounds * 2)
    expect(turns).toHaveLength(runs.length)
    expect(new Set(runs.map((run) => run.id)).size).toBe(runs.length)
    expect(new Set(runs.map((run) => run.nativeTurnId)).size).toBe(runs.length)
    expect(task.owner).toBe(owner)
    expect(task.reviewer).toBe(owner === 'codex' ? 'claude' : 'codex')
    const initial = runs.slice(0, 2)
    expect(initial).toHaveLength(2)
    const actorSettings = new Map(
      initial.map((run) => [
        run.agentId,
        {
          model: run.model,
          effort: run.effort,
          permissionMode: run.permissionMode,
          nativeSessionId: run.nativeSessionId,
          bindingGeneration: run.bindingGeneration,
        },
      ]),
    )
    const settlements: CollaborationPlanSettlement[] = []
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index]!,
        turn = turns.find((value) => value.runId === run.id)!
      const planning = index % 2 === 0
      const authorization = collaborationTurnAuthorizationSchema.parse(
        JSON.parse(turn.authorizationJson),
      )
      expect(run).toMatchObject({
        status: 'completed',
        nativeOutcome: 'completed',
        nativeEffectsState: 'settled',
        dispatchPhase: 'ended',
        attemptCount: 1,
        agentId: planning ? owner : task.reviewer,
      })
      expect({
        model: run.model,
        effort: run.effort,
        permissionMode: run.permissionMode,
        nativeSessionId: run.nativeSessionId,
        bindingGeneration: run.bindingGeneration,
      }).toEqual(actorSettings.get(run.agentId))
      expect(run.forkSourceRunId).toBeUndefined()
      expect(run.reexecutedFromRunId).toBeUndefined()
      expect(run.nativeTurnId).toBeTruthy()
      expect(turn).toMatchObject({
        taskId: task.id,
        stage: planning ? 'plan' : 'plan_review',
        actor: run.agentId,
        inputSequence: 1,
        applied: true,
        verdictConflict: false,
      })
      expect(authorization).toMatchObject({
        runId: run.id,
        taskId: task.id,
        actor: run.agentId,
        stage: turn.stage,
        inputSequence: 1,
      })
      const response = snapshot.messages.find(
        (message) =>
          message.id === run.responseMessageId &&
          message.runId === run.id &&
          message.role === 'assistant',
      )
      const eventType = planning ? 'workflow.plan_settled' : 'workflow.review_observed'
      const facts = database.drizzle.query.agentEventJournal
        .findMany({
          where: (fields, { and, eq }) =>
            and(eq(fields.runId, run.id), eq(fields.eventType, eventType)),
          columns: { payload: true },
          limit: 2,
        })
        .sync()
      expect(facts).toHaveLength(1)
      let published = false
      if (planning) {
        const settled = collaborationPlanSettlementSchema.parse(JSON.parse(facts[0]!.payload))
        expect(settled.inputSequence).toBe(1)
        expect(turn.planNativeId).toBe(settled.nativeId)
        const previous = settlements.at(-1)
        expect(settled.planReference.version).toBe(
          previous
            ? previous.planReference.version +
                Number(
                  settled.planReference.document.sha256 !== previous.planReference.document.sha256,
                )
            : 1,
        )
        expect(settled.planReference.sourceRunId).toBe(
          settled.kind === 'published' ? run.id : previous?.planReference.sourceRunId,
        )
        // Published native plans may have no ordinary chat prose. Their complete source is authoritative.
        published = settled.kind === 'published'
        // oxlint-disable-next-line no-await-in-loop -- Verify each historical version through its exact immutable reference.
        await readRequiredPlanSource(ctx, settled.planReference)
        settlements.push(settled)
      } else {
        const observed: unknown = JSON.parse(facts[0]!.payload)
        if (!observed || typeof observed !== 'object' || Array.isArray(observed))
          throw Error('The native review receipt is invalid')
        expect(Reflect.get(observed, 'conflict')).toBe(false)
        const verdict = collaborationReviewObservationSchema.parse({
          verdict: Reflect.get(observed, 'verdict'),
          ...(Reflect.has(observed, 'questions')
            ? { questions: Reflect.get(observed, 'questions') }
            : {}),
        })
        expect(authorization.planReference).toEqual(settlements.at(-1)!.planReference)
        expect(turn.verdict).toBe(verdict.verdict)
        expect(verdict.verdict).toBe(index === runs.length - 1 ? 'accepted' : 'changes_requested')
      }
      expect(response ? response.state === 'complete' : planning && published).toBe(true)
      expect(planning && published ? true : Boolean(response?.content.trim())).toBe(true)
    }
    expect(settlements[0]).toMatchObject({
      kind: 'published',
      planReference: { version: 1, sourceRunId: runs[0]!.id },
    })
    expect(task.planReference).toEqual(settlements.at(-1)!.planReference)
    expect(task.review).toMatchObject({
      runId: runs.at(-1)!.id,
      verdict: 'accepted',
      actor: task.reviewer,
      inputSequence: 1,
      planReference: task.planReference,
    })
    const nativeRoots = []
    for (const actor of ['codex', 'claude'] as const) {
      const actorRuns = runs.filter((run) => run.agentId === actor)
      // oxlint-disable-next-line no-await-in-loop -- One bounded readonly native scan per actor, with no provider call.
      const native = await findNativeRecord(ctx, actor, actorRuns[0]!.nativeSessionId!)
      const observedRoots = actor === 'codex' ? native.codexModelStarts : native.claudeUserInputs
      expect(observedRoots).toBe(actorRuns.length)
      expect(
        actor === 'claude'
          ? native.assistantModels.includes(actorRuns[0]!.model!)
          : actorRuns.every((run) =>
              native.codexTurnSettings.some(
                (turn) => turn.turnId === run.nativeTurnId && turn.model === run.model,
              ),
            ),
      ).toBe(true)
      nativeRoots.push({
        actor,
        hostRuns: actorRuns.length,
        observedNativeRoots: observedRoots,
        nativeRecordSha256: native.sha256,
      })
    }
    await test.info().attach('required-plan-native-roots', {
      contentType: 'application/json',
      body: JSON.stringify({
        discussionRounds: task.discussionRounds,
        planVersion: task.planVersion,
        hostRuns: runs.length,
        nativeRoots,
        note: 'Actual native root counts and host Run trace; no token or monetary usage claim.',
      }),
    })
    return { snapshot, runs, initial, firstPlan: settlements[0]!, task }
  } finally {
    database.close()
  }
}

/** Visit each real result through the bounded virtual transcript, including async card reads. */
async function visitRequiredPlanCards(
  ctx: RealWorkspace,
  runs: Awaited<ReturnType<typeof readRealConversation>>['runs'],
  currentPlanRunId: string,
  deadlineAt: number,
): Promise<void> {
  const transcript = ctx.page.getByRole('region', { name: 'Conversation messages', exact: true })
  const historyStatus = transcript.locator(':scope > div > output[aria-live="polite"]')
  const expected = new Map(runs.map((run) => [run.id, run]))
  const seen = new Map<string, { rowKey: string; scrollTop: number; label: string }>()
  const observations: unknown[] = []
  const remaining = () => {
    expect(
      Date.now(),
      'The original required-Plan deadline still applies to UI reading',
    ).toBeLessThan(deadlineAt)
    return Math.max(1, Math.min(5000, deadlineAt - Date.now()))
  }
  const settle = async () => {
    await expect(historyStatus).not.toHaveText('Loading messages…', {
      timeout: remaining(),
    })
    await ctx.page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    )
  }
  try {
    await transcript.focus()
    for (let page = 0; page < 32; page++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each Home loads the next earlier bounded history range.
      await transcript.press('Home')
      // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for that history range before inspecting its beginning marker.
      await settle()
      // oxlint-disable-next-line eslint/no-await-in-loop -- The marker belongs to the current bounded page.
      if ((await historyStatus.innerText()) === 'Beginning of conversation.') break
      expect(page, 'All earlier result rows must remain reachable').toBeLessThan(31)
    }
    // Home is a key event; reset the owned viewport explicitly so the scan starts
    // at the first page even when focus remained in a child control.
    await transcript.evaluate((host) => {
      host.scrollTop = 0
    })
    await settle()
    for (let step = 0; step < 512; step++) {
      remaining()
      // oxlint-disable-next-line eslint/no-await-in-loop -- Async result reads may change this viewport's measurements.
      await settle()
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe only the currently mounted rows, without reading React or persistence state.
      const visibleRows = await transcript.locator('[data-pact-row-key]').evaluateAll((rows) => {
        const viewport = document.querySelector('[data-pact-transcript]')!.getBoundingClientRect()
        return rows.flatMap((row) => {
          const box = row.getBoundingClientRect()
          return box.bottom > viewport.top + 1 && box.top < viewport.bottom - 1
            ? [
                {
                  rowKey: row.getAttribute('data-pact-row-key')!,
                  messages: [...row.querySelectorAll('[data-pact-message-id]')].map((message) =>
                    message.getAttribute('data-pact-message-id'),
                  ),
                },
              ]
            : []
        })
      })
      for (const row of visibleRows) {
        const run = runs.find(
          (candidate) =>
            (candidate.responseMessageId && row.messages.includes(candidate.responseMessageId)) ||
            row.rowKey === `reply:${candidate.userMessageId}:${candidate.agentId}:${candidate.id}`,
        )
        if (!run) continue
        const host = transcript.locator(`[data-pact-row-key="${row.rowKey}"]`)
        // oxlint-disable-next-line eslint/no-await-in-loop -- A completed row must expose its actual result, rather than being skipped after a failed read.
        await expect(host.getByRole('button', { name: 'Retry read', exact: true })).toHaveCount(0)
        const card = host.locator(`[data-pact-collaboration-run-id="${run.id}"]`)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve the original read deadline while awaiting this row's async projection.
        await expect(card).toHaveCount(1, { timeout: remaining() })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Every visited card must preserve the original no-inline-full-Plan assertion.
        await expect(card.locator('[data-pact-plan-run-id]')).toHaveCount(0)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect the actual card label, not only its presence in the DOM.
        await expect(card.locator(':scope > div > span').first()).toHaveText(
          run.collaboration?.stage === 'plan'
            ? /^Plan(?: · v\d+)?$/u
            : /^Plan review(?: · v\d+)?$/u,
        )
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Record actual viewport intersections after async card rendering settles.
      const frame = await transcript.evaluate((viewport) => {
        const rect = viewport.getBoundingClientRect()
        return {
          top: viewport.scrollTop,
          height: viewport.clientHeight,
          total: viewport.scrollHeight,
          cards: [...viewport.querySelectorAll('[data-pact-collaboration-run-id]')].map((card) => {
            const box = card.getBoundingClientRect()
            return {
              runId: card.getAttribute('data-pact-collaboration-run-id')!,
              rowKey: card.closest('[data-pact-row-key]')!.getAttribute('data-pact-row-key')!,
              label: card.querySelector('span')?.textContent ?? '',
              intersects: box.bottom > rect.top + 1 && box.top < rect.bottom - 1,
              targetTop: viewport.scrollTop + box.top - rect.top - 16,
            }
          }),
        }
      })
      observations.push(frame)
      expect(new Set(frame.cards.map((card) => card.runId)).size).toBe(frame.cards.length)
      for (const card of frame.cards) {
        expect(
          expected.has(card.runId),
          'No unrelated or duplicate result can satisfy a required root',
        ).toBe(true)
        const prior = seen.get(card.runId)
        if (prior) expect(card.rowKey).toBe(prior.rowKey)
        if (card.intersects)
          seen.set(card.runId, {
            rowKey: card.rowKey,
            scrollTop: card.targetTop,
            label: card.label,
          })
      }
      if (frame.top + frame.height >= frame.total - 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Require a second settled physical bottom observation.
        await settle()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Async height changes must not be mistaken for the end of the history.
        const bottom = await transcript.evaluate((host) => ({
          top: host.scrollTop,
          height: host.clientHeight,
          total: host.scrollHeight,
        }))
        if (Math.abs(bottom.top - frame.top) < 1 && bottom.total === frame.total) break
        continue
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Overlapping viewport steps keep short result cards observable between long messages.
      await transcript.evaluate((host) => {
        host.scrollTop += Math.max(16, host.clientHeight / 2)
      })
      expect(step, 'Every required result must be reached within the bounded UI scan').toBeLessThan(
        511,
      )
    }
    expect([...seen.keys()].toSorted()).toEqual([...expected.keys()].toSorted())
    const current = seen.get(currentPlanRunId)!
    expect(current).toBeDefined()
    await transcript.evaluate((host, top) => {
      host.scrollTop = top
    }, current.scrollTop)
    await settle()
    await expect(
      ctx.page.locator(`[data-pact-collaboration-run-id="${currentPlanRunId}"]`),
    ).toBeInViewport({ timeout: remaining() })
  } finally {
    await test.info().attach('required-plan-result-card-visits', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          expectedRunIds: [...expected.keys()],
          visited: [...seen.entries()],
          observations,
        }),
      ),
    })
  }
}

for (const actor of ['codex', 'claude'] as const)
  test(
    `real ${actor} submits a required plan in its first authorized root Turn @real`,
    { tag: '@real-extended' },
    async () => {
      test.setTimeout(300_000)
      const acceptanceDeadline = Date.now() + 300_000
      const ctx = await launchRealWorkspace(`real-required-plan-${actor}`)
      try {
        await selectRealConfiguredEffort(ctx, ['codex', 'claude'], actor)
        const maxReviews = await ctx.page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const settings = await bridge.getSessionSettings(sessionId)
          if (!settings.ok) throw Error('The original frozen review limit is unavailable')
          return settings.value.session.settings.maxDiscussionRounds
        }, ctx.sessionId)
        await sendRealMessage(
          ctx,
          "/plan Draft a small conceptual plan for documenting cancellation ownership. Scope: explain which owner cancels a pending request and releases its resources. Fixed design constraints: one requester owner owns the request handle and cancellation authority; the owning scope's disposer delegates to that same owner for requests created by its scope. The executor releases work-local resources before publishing its terminal acknowledgement; only then does the requester owner release the handle, exactly once. Normal completion needs no cancellation. Cancellation and disposal request cancellation only while pending, await the same terminal cleanup, and remain idempotent when they race with completion or repeat. Completion and cancellation converge on one terminal outcome and one cleanup. Acceptance: document normal completion, cancellation and disposal in three concrete steps, naming the owner and release condition for each resource without leaving alternatives undecided. This is planning only; do not inspect or modify project files, run commands or delegate; the native plan document is permitted. The scope is fully specified.",
          actor,
        )
        const completion = await waitForRequiredPlan(ctx, actor, maxReviews).catch(
            async (error: unknown) => {
              const saved = await readRealConversation(ctx)
              let nativeErrors: unknown
              if (actor === 'codex' && saved.runs[0]?.nativeSessionId) {
                const native = await ctx.fixture.openCodexClient()
                try {
                  const turns = await native.request('thread/turns/list', {
                    threadId: saved.runs[0].nativeSessionId,
                    itemsView: 'notLoaded',
                    limit: 1,
                    sortDirection: 'desc',
                  })
                  nativeErrors = turns.result
                } finally {
                  await native.close()
                }
              }
              throw new Error(
                ctx.fixture.redactDiagnostic(
                  JSON.stringify({
                    assertionFailure: ctx.fixture
                      .redactDiagnostic(error instanceof Error ? error.message : String(error))
                      .slice(0, 8000),
                    runs: saved.runs.map((run) => ({
                      id: run.id,
                      status: run.status,
                      nativeOutcome: run.nativeOutcome,
                      failureKind: run.failureKind,
                      failureMessage: run.failureMessage,
                    })),
                    nativeErrors,
                    answers: saved.messages
                      .filter((message) => message.role === 'assistant')
                      .map((message) => message.content.slice(0, 6000)),
                  }),
                ),
              )
            },
          ),
          snapshot = completion.snapshot,
          run = completion.initial[0]!
        expect(run).toMatchObject({
          agentId: actor,
          status: 'completed',
        })
        const response = await ctx.page.evaluate(
          async ({ sessionId }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getConversation({ scope: 'collaboration', sessionId })
          },
          { sessionId: ctx.sessionId, runId: run.id },
        )
        expect(response.ok).toBe(true)
        if (!response.ok || response.value.scope !== 'collaboration')
          throw new Error('The real plan result is unavailable.')
        const task = response.value.view.task!
        let sourceToolEvidence: unknown
        if (actor === 'codex' && !['ready'].includes(task.status) && run.nativeSessionId) {
          const client = await ctx.fixture.openCodexClient()
          try {
            const native = await client.request('thread/turns/list', {
              threadId: run.nativeSessionId,
              itemsView: 'full',
              limit: 1,
              sortDirection: 'desc',
            })
            const queue: unknown[] = [native.result]
            const items: object[] = []
            let nodes = 0
            while (queue.length) {
              if (++nodes > 10_000)
                throw new Error('Source failure evidence exceeds its structural bound')
              const value = queue.pop()
              if (!value || typeof value !== 'object') continue
              if (Array.isArray(value)) {
                if (queue.length + value.length > 10_000)
                  throw new Error('Source failure evidence exceeds its queue bound')
                queue.push(...value)
                continue
              }
              const type = Reflect.get(value, 'type')
              if (typeof type === 'string' && /tool|execution/iu.test(type)) {
                if (items.length === 64)
                  throw new Error('Source failure evidence exceeds its item bound')
                const record: Record<string, unknown> = {}
                for (const key of [
                  'type',
                  'name',
                  'server',
                  'status',
                  'error',
                  'output',
                  'result',
                  'content',
                ]) {
                  if (Reflect.has(value, key)) record[key] = Reflect.get(value, key)
                }
                items.push(record)
              }
              const children = Object.values(value)
              if (queue.length + children.length > 10_000)
                throw new Error('Source failure evidence exceeds its queue bound')
              queue.push(...children)
            }
            const safe = ctx.fixture
              .redactDiagnostic(JSON.stringify(items))
              .replace(
                /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu,
                '[private-id]',
              )
              .replace(/[a-f0-9]{32,64}/giu, '[private-id]')
            sourceToolEvidence = safe.slice(0, 12_000)
          } finally {
            await client.close()
          }
        }
        expect(
          ['ready'],
          JSON.stringify({
            status: task.status,
            notice: task.notice,

            planVersion: task.planVersion,
            sourceToolEvidence,
            answer: ctx.fixture
              .redactDiagnostic(
                snapshot.messages.find((message) => message.role === 'assistant')?.content ?? '',
              )
              .slice(0, 6000),
          }),
        ).toContain(task.status)
        expect(task.automation).toBeDefined()
        expect(task.planReference?.document).toBeDefined()
        const plan = await ctx.page.evaluate(
          async ({ sessionId, runId, document }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            let offset = 0,
              text = ''
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- Each immutable source page supplies the next cursor.
              const page = await bridge.getConversation({
                scope: 'collaboration-text',
                sessionId,
                runId,
                document,
                offset,
              })
              if (!page.ok || page.value.scope !== 'collaboration-text')
                throw Error('Complete plan source unavailable')
              text += page.value.text
              if (page.value.nextOffset === null) return text
              offset = page.value.nextOffset
            }
          },
          {
            sessionId: ctx.sessionId,
            runId: task.planReference!.sourceRunId,
            document: task.planReference!.document,
          },
        )
        expect(plan.trim().length).toBeGreaterThan(0)
        expect(completion.firstPlan.planReference.version).toBe(1)
        expect(task.owner).toBe(actor)
        const card = ctx.page.getByRole('region', { name: 'Pact collaboration result' })
        await visitRequiredPlanCards(
          ctx,
          completion.runs,
          task.planReference!.sourceRunId,
          acceptanceDeadline,
        )
        await ctx.page
          .locator(`[data-pact-collaboration-run-id="${task.planReference!.sourceRunId}"]`)
          .getByRole('button', { name: 'Open plan', exact: true })
          .click()
        const panel = ctx.page.getByRole('region', { name: /Current plan|Plan source/ })
        await expect(panel).toBeVisible()
        await expect(panel.locator('[data-pact-plan-run-id]')).toContainText(
          markdownVisibleProjection(plan).trim().slice(0, 40),
        )
        await expect(panel.getByRole('textbox', { name: 'Plan text' })).toHaveAttribute(
          'aria-readonly',
          'true',
        )
        await panel.getByRole('button', { name: 'Expand plan panel', exact: true }).click()
        await expect(
          panel.getByRole('button', { name: 'Restore plan panel', exact: true }),
        ).toBeVisible()
        const planText = panel.getByRole('textbox', { name: 'Plan text' })
        await expect(ctx.page.locator('.workspace-layout[data-animating="true"]')).toHaveCount(0)
        // Complete Playwright's scroll/stability checks before reading mouse coordinates.
        await planText.click({ trial: true })
        const gesture = await planText.evaluate((host) => {
          const viewport = host.closest('[data-pact-context-scroll]')?.getBoundingClientRect()
          if (!viewport) throw new Error('The plan scroll viewport is unavailable')
          for (const span of host.querySelectorAll('[data-pact-projection-start]')) {
            if (span.closest('button,a,input,textarea,select')) continue
            const node = span.firstChild
            if (!node || node.nodeType !== Node.TEXT_NODE) continue
            const text = node.textContent ?? ''
            const start = text.search(/\S/u)
            if (start < 0 || text.length - start < 4) continue
            const range = document.createRange()
            range.setStart(node, start)
            range.setEnd(node, Math.min(text.length, start + 12))
            const boxes = [...range.getClientRects()]
            const box = boxes[0]
            if (
              boxes.length !== 1 ||
              !box ||
              box.width < 8 ||
              // Keep an ordinary selection outside the document's 32px auto-scroll bands.
              box.top < Math.max(48, viewport.top + 40) ||
              box.bottom > Math.min(window.innerHeight - 24, viewport.bottom - 40)
            )
              continue
            const startPoint = { x: box.left + 1, y: box.top + box.height / 2 }
            const endPoint = { x: box.right - 1, y: box.top + box.height / 2 }
            if (
              !span.contains(document.elementFromPoint(startPoint.x, startPoint.y)) ||
              !span.contains(document.elementFromPoint(endPoint.x, endPoint.y))
            )
              continue
            return { start: startPoint, end: endPoint }
          }
          throw new Error('A visible native plan text range is unavailable')
        })
        await ctx.page.mouse.move(gesture.start.x, gesture.start.y)
        await ctx.page.mouse.down()
        await ctx.page.mouse.move(gesture.end.x, gesture.end.y, { steps: 12 })
        await ctx.page.mouse.up()
        try {
          await panel.getByRole('button', { name: 'Comment on selected text', exact: true }).click()
        } catch (error) {
          const boundary = await planText.evaluate((host, points) => {
            const selection = window.getSelection()
            const hit = (point: { x: number; y: number }) => {
              const node = document.elementFromPoint(point.x, point.y)
              return {
                tag: node?.tagName,
                inPlan: Boolean(node && host.contains(node)),
                interactive: Boolean(node?.closest('button,a,input,textarea,select')),
              }
            }
            const scroller = host.closest('[data-pact-context-scroll]')
            return {
              points,
              viewport: scroller
                ? {
                    top: scroller.getBoundingClientRect().top,
                    bottom: scroller.getBoundingClientRect().bottom,
                    scrollTop: scroller.scrollTop,
                  }
                : undefined,
              start: hit(points.start),
              end: hit(points.end),
              selectionChars: selection?.toString().length ?? 0,
              collapsed: selection?.isCollapsed,
              projectionSpans: host.querySelectorAll('[data-pact-projection-start]').length,
              statuses: [...host.querySelectorAll('output')].map((node) =>
                node.textContent?.slice(0, 300),
              ),
            }
          }, gesture)
          const control = await ctx.page.evaluate(async (sessionId) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            const result = await bridge.getConversation({ scope: 'messages', sessionId })
            if (!result.ok || result.value.scope !== 'messages') return { available: false }
            return {
              available: true,
              inputGate: result.value.header.sessionIssues?.inputGate,
              issues: result.value.header.sessionIssues?.agents.map((issue) => ({
                agentId: issue.agentId,
                phase: issue.phase,
                action: issue.action,
              })),
            }
          }, ctx.sessionId)
          const diagnostic = ctx.fixture.redactDiagnostic(
            JSON.stringify({ version: 1, boundary, control }),
          )
          if (Buffer.byteLength(diagnostic) <= 8192)
            await test.info().attach('plan-comment-boundary', {
              body: diagnostic,
              contentType: 'application/json',
            })
          const screenshot = test.info().outputPath('plan-comment-panel.png')
          await panel.screenshot({ path: screenshot })
          await test
            .info()
            .attach('plan-comment-panel', { path: screenshot, contentType: 'image/png' })
          throw error
        }
        await expect(panel.getByRole('heading', { name: 'New comment', exact: true })).toBeVisible()
        await expect(panel.locator('[data-pact-comment-editor] p[title]')).toHaveAttribute(
          'title',
          /\S/u,
        )
        await panel.getByRole('button', { name: 'Close Comment editor', exact: true }).click()
        await expect(card.locator('[data-pact-plan-run-id]')).toHaveCount(0)
        expect(completion.initial).toHaveLength(2)
        expect(
          snapshot.runs.find((candidate) => candidate.collaboration?.stage === 'plan_review')
            ?.agentId,
        ).toBe(actor === 'codex' ? 'claude' : 'codex')
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )
