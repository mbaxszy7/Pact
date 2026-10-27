import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { markdownVisibleProjection } from '../../apps/desktop/src/shared/message-anchor-text.js'
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
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

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
              columns: { id: true, status: true, nativeOutcome: true, nativeEffectsState: true },
              limit: maxReviews * 2 + 1,
            })
            .sync()
          if (rows.length > maxReviews * 2)
            throw Error('A required-plan case exceeded its frozen review budget')
          if (rows.some((row) => ['failed', 'interrupted'].includes(row.status)))
            throw Error('A required native plan/review root failed')
          if (!taskRow) return false
          const task = collaborationTaskSchema.parse(JSON.parse(taskRow.stateJson))
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
        await selectRealConfiguredEffort(ctx, ['codex', 'claude'])
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
        await expect(panel).toContainText('Select text to add a Comment')
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
