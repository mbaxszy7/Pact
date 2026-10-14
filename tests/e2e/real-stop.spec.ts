import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationSnapshot, DesktopBridge } from '../../packages/contracts/src/index.js'

import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  selectRealConfiguredEffort,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import {
  findNativeRecord,
  nativeByteLimit,
  readNativeEvidence,
  type NativeEvidence,
} from './real-native-evidence.js'
import { test } from './runtime-fixture.js'
import { windowsTextCommand } from './windows-test-command.js'

const commandDelayMs = 15_000

for (const agentId of ['codex', 'claude'] as const) {
  test(
    `real ${agentId} UI Stop preserves received text and unsent input before one explicit continuation${agentId === 'codex' ? '; @all never starts its secondary' : ''}`,
    { tag: ['@real', '@real-core'] },
    async () => {
      test.setTimeout(600_000)
      const ctx = await launchRealWorkspace(`real-stop-${agentId}`)
      let observer: ReadonlyFixtureDatabase | undefined
      try {
        observer = ReadonlyFixtureDatabase.open(ctx.fixture)
        const database = observer
        if (agentId === 'claude') await selectRealConfiguredEffort(ctx, [agentId])
        const sourceMarker = authMarker('STOP_SOURCE')
        await sendRealMessage(
          ctx,
          `Print ${sourceMarker} as your first line. Then print 600 numbered lines with the two words alpha beta on every line. Produce the complete list without abbreviation or explanation. Do not use tools, read files or write files.`,
          agentId === 'codex' ? 'all' : 'claude',
        )
        // The scalar observer requires a genuinely accepted, still-live model
        // task; an empty placeholder or a completed fast reply cannot pass.
        await expect
          .poll(
            () => {
              const runs = database.drizzle.query.agentRuns
                .findMany({
                  where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
                  columns: { id: true, agentId: true, status: true, dispatchPhase: true },
                  limit: 3,
                })
                .sync()
              const response = runs[0]
                ? database.drizzle.query.conversationMessages
                    .findFirst({
                      where: (fields, { and, eq }) =>
                        and(eq(fields.runId, runs[0]!.id), eq(fields.role, 'assistant')),
                      columns: { contentRevision: true },
                    })
                    .sync()
                : undefined
              return {
                runs: runs.length,
                agentId: runs[0]?.agentId,
                status: runs[0]?.status,
                dispatchPhase: runs[0]?.dispatchPhase,
                hasOutput: (response?.contentRevision ?? 0) > 0,
              }
            },
            { timeout: 120_000, intervals: [100, 250, 500] },
          )
          .toEqual({
            runs: 1,
            agentId,
            status: 'running',
            dispatchPhase: 'accepted',
            hasOutput: true,
          })
        const live = await readRealConversation(ctx)
        const originalRun = live.runs[0]
        const originalUser = live.messages.find((message) => message.role === 'user')
        const received = live.messages.find(
          (message) => message.runId === originalRun?.id && message.role === 'assistant',
        )
        if (!originalRun?.nativeSessionId || !originalUser || !received?.content)
          throw new Error('Actual accepted Native task and received source text are unavailable')
        await expect(
          ctx.page.locator(`[data-pact-message-id="${received.id}"] [data-pact-message-content]`),
        ).toContainText(/\S/u)

        // Anchor to the actual accepted User Message, whose projection remains
        // stable while the same task streams. No synthetic answer is inserted.
        const commentBody = `Preserve this unsent Comment ${authMarker('STOP_COMMENT')}`
        await createCommentOnAcceptedMessage(ctx.page, originalUser.id, sourceMarker, commentBody)
        const nextMarker = authMarker('EXPLICIT_AFTER_STOP')
        const draftBody = `Briefly acknowledge ${nextMarker}. Do not use tools, read files or write files.`
        const draft = `@${agentId} ${draftBody}`
        const composer = ctx.page.getByRole('combobox', { name: 'Message', exact: true })
        await composer.fill(`@${agentId}`)
        await ctx.page
          .getByRole('option', { name: agentId === 'codex' ? /^Codex/u : /^Claude Code/u })
          .click()
          .catch(async (error: unknown) => {
            const state = await composer.evaluate((element) => {
              const selection = document.getSelection()
              return {
                focused: document.activeElement === element,
                editable: element.getAttribute('contenteditable'),
                expanded: element.getAttribute('aria-expanded'),
                text: element.textContent?.slice(0, 80),
                caretInside: selection?.anchorNode ? element.contains(selection.anchorNode) : false,
                anchorOffset: selection?.anchorOffset,
                collapsed: selection?.isCollapsed,
              }
            })
            const current = (await readRealConversation(ctx)).runs.find(
              (run) => run.id === originalRun.id,
            )
            await test.info().attach('stop-draft-preparation-boundary', {
              body: ctx.fixture.redactDiagnostic(
                JSON.stringify({
                  state,
                  run: current && {
                    status: current.status,
                    dispatchPhase: current.dispatchPhase,
                    failureKind: current.failureKind,
                  },
                }),
              ),
              contentType: 'application/json',
            })
            throw error
          })
        await ctx.page.evaluate(
          () => new Promise<void>((done) => requestAnimationFrame(() => done())),
        )
        await composer.press('End')
        await composer.pressSequentially(draftBody)
        await expect.poll(() => composer.textContent()).toBe(draft)
        const beforeStop = await readRealConversation(ctx)
        expect(beforeStop.runs).toHaveLength(1)
        expect(beforeStop.runs[0]).toMatchObject({ id: originalRun.id, status: 'running' })
        const receivedBeforeStop = beforeStop.messages.find((message) => message.id === received.id)
        if (!receivedBeforeStop?.content)
          throw new Error('Actual pre-Stop response checkpoint disappeared')
        // During a running task the Comment editor accepts text, while Save is
        // intentionally unavailable. Stop must preserve that real unsaved UI
        // input and its anchor, then permit normal durable saving.
        await expect(ctx.page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
          commentBody,
        )
        await expect.poll(async () => (await runtimeCounters(ctx)).activeExecutions).toBe(1)
        await ctx.page
          .getByRole('button', {
            name: `Stop ${agentId === 'codex' ? 'Codex' : 'Claude Code'} response`,
            exact: true,
          })
          .click()
        await expect
          .poll(
            () =>
              database.drizzle.query.agentRuns
                .findFirst({
                  where: (fields, { eq }) => eq(fields.id, originalRun.id),
                  columns: { status: true },
                })
                .sync(),
            { timeout: 30_000 },
          )
          .toEqual({ status: 'interrupted' })
        await expect
          .poll(() => runtimeCounters(ctx), { timeout: 30_000 })
          .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
        // Idle Adapters are an intentional bounded cache; actual resource
        // release is observed through task settlement and successful reuse.
        expect((await runtimeCounters(ctx)).adapterSlots).toBeLessThanOrEqual(1)
        await expect(
          ctx.page.getByRole('button', { name: 'Send message', exact: true }),
        ).toBeEnabled()
        await expect.poll(() => composer.textContent()).toBe(draft)
        const commentEditor = ctx.page.getByRole('textbox', { name: 'Comment', exact: true })
        await expect(commentEditor).toHaveValue(commentBody)
        await expect(
          ctx.page.getByRole('heading', { name: 'New comment', exact: true }),
        ).toBeVisible()
        await commentEditor.press('Enter')
        await expect(ctx.page.getByLabel('Attached Comment drafts')).toContainText(commentBody)

        const stopped = await readRealConversation(ctx)
        const draftComment = stopped.comments.find((comment) => comment.body === commentBody)
        expect(draftComment).toMatchObject({
          status: 'draft',
          anchor: { type: 'message', messageId: originalUser.id, quote: sourceMarker },
        })
        if (!draftComment)
          throw new Error('The preserved UI Comment could not be durably saved after Stop')
        const preserved = stopped.messages.find((message) => message.id === received.id)
        if (!preserved?.content) throw new Error('Stop lost actual received text')
        expect(preserved.state).toBe('incomplete')
        expect(preserved.content.startsWith(receivedBeforeStop.content)).toBe(true)
        expect(stopped.runs).toHaveLength(1)
        expect(stopped.messages.find((message) => message.id === originalUser.id)).toMatchObject({
          content: originalUser.content,
          route: originalUser.route,
        })
        expect(stopped.messages.some((message) => message.content.includes(nextMarker))).toBe(false)
        expect(stopped.commentsRevision).toBe(beforeStop.commentsRevision + 1)
        expect(stopped.messages.some((message) => message.pendingAgentId)).toBe(false)
        const sourceFacts = responseFacts(preserved)
        const nativeAtStop = await findNativeRecord(ctx, agentId, originalRun.nativeSessionId)
        expect(nativeAtStop.containsText(sourceMarker)).toBe(true)
        expect(
          agentId === 'codex' ? nativeAtStop.codexModelStarts : nativeAtStop.claudeUserInputs,
        ).toBe(1)
        if (agentId === 'codex') expect(await secondaryModelInputs(ctx)).toBe(0)

        // Observe real queued events after the cancellation/resource barrier.
        // Nothing is injected, and the bounded quiet window is not a retry.
        await ctx.page.waitForTimeout(2_000)
        const quiet = await readRealConversation(ctx)
        expect(
          responseFacts(quiet.messages.find((message) => message.id === preserved.id)),
        ).toEqual(sourceFacts)
        expect(quiet.runs).toHaveLength(1)
        await expect.poll(() => composer.textContent()).toBe(draft)
        await expect(
          ctx.page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)

        // Send the very draft/route/Comment left intact by Stop. Its nonempty
        // genuine reply proves the slot and Native writer are reusable.
        await ctx.page.getByRole('button', { name: 'Send message', exact: true }).click()
        const complete = await waitForRealCompletion(ctx, 2, ctx.sessionId, [originalRun.id])
        expect(complete.runs.find((run) => run.id === originalRun.id)).toMatchObject({
          status: 'interrupted',
          nativeSessionId: originalRun.nativeSessionId,
        })
        const nextRun = complete.runs.find((run) => run.id !== originalRun.id)
        expect(nextRun).toMatchObject({
          agentId,
          status: 'completed',
          nativeSessionId: originalRun.nativeSessionId,
        })
        if (!nextRun) throw new Error('Explicit post-Stop model task did not persist')
        const nextUser = complete.messages.find((message) => message.id === nextRun.userMessageId)
        expect(nextUser).toMatchObject({ content: draft, route: { type: 'agent', agentId } })
        expect(
          complete.messages
            .find((message) => message.runId === nextRun.id && message.role === 'assistant')
            ?.content.trim().length,
        ).toBeGreaterThan(0)
        expect(
          responseFacts(complete.messages.find((message) => message.id === preserved.id)),
        ).toEqual(sourceFacts)
        expect(complete.comments.find((comment) => comment.id === draftComment.id)).toMatchObject({
          body: draftComment.body,
          anchor: draftComment.anchor,
          status: 'sent',
          sentWithMessageId: nextRun.userMessageId,
        })
        const nativeAfter = await findNativeRecord(ctx, agentId, originalRun.nativeSessionId)
        expect(nativeAfter.containsText(nextMarker)).toBe(true)
        expect(
          agentId === 'codex' ? nativeAfter.codexModelStarts : nativeAfter.claudeUserInputs,
        ).toBe(2)
        if (agentId === 'codex') {
          expect(complete.runs.some((run) => run.agentId === 'claude')).toBe(false)
          expect(await secondaryModelInputs(ctx)).toBe(0)
        }
        await expect
          .poll(() => runtimeCounters(ctx), { timeout: 30_000 })
          .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
        await restartRealWorkspace(ctx)
        const cold = await readRealConversation(ctx)
        expect(responseFacts(cold.messages.find((message) => message.id === preserved.id))).toEqual(
          sourceFacts,
        )
        expect(cold.runs.map((run) => run.id)).toEqual(complete.runs.map((run) => run.id))
        expect(
          cold.nativeContexts.find((context) => context.agentId === agentId)?.nativeSessionId,
        ).toBe(originalRun.nativeSessionId)
        await test.info().attach('actual-stop-evidence', {
          body: JSON.stringify({
            agentId,
            stoppedRunId: originalRun.id,
            nextRunId: nextRun.id,
            nativeSessionId: originalRun.nativeSessionId,
            source: sourceFacts,
            explicitModelInputs: 2,
            secondaryModelInputs: agentId === 'codex' ? 0 : undefined,
            commentId: draftComment.id,
          }),
          contentType: 'application/json',
        })
      } finally {
        observer?.close()
        await closeRealWorkspace(ctx)
      }
    },
  )
}

for (const agentId of ['codex', 'claude'] as const) {
  test(
    `real ${agentId} UI Stop retires an unanswered native permission without executing its command`,
    { tag: ['@real', '@real-core'] },
    async () => {
      test.setTimeout(600_000)
      const ctx = await launchRealWorkspace(`real-stop-permission-${agentId}`)
      try {
        if (agentId === 'claude') await selectRealConfiguredEffort(ctx, [agentId])
        await askMode(ctx, agentId)
        const marker = authMarker('UNAPPROVED_STOP')
        const filename = `stop-permission-${marker}.txt`
        const target = join(ctx.fixture.directory, filename)
        const command =
          process.platform === 'win32' && agentId === 'codex'
            ? windowsTextCommand(marker, filename)
            : `printf '%s' '${marker}' >> ../${filename}`
        await sendRealMessage(
          ctx,
          `Execute exactly this shell command once: ${command}. Its destination is outside the Project but inside this isolated test directory. Request sandbox escalation with justification if required. Do not inspect other files or change permissions. Do not continue without the user's approval.`,
          agentId === 'codex' ? 'all' : 'claude',
        )
        const card = permissionCard(ctx, agentId)
        await expect(
          card.getByRole('button', { name: allowLabel(agentId), exact: true }),
        ).toBeVisible({ timeout: 120_000 })
        const pending = await currentPermission(ctx, agentId, filename)
        const before = await readRealConversation(ctx)
        const run = before.runs[0]
        if (before.runs.length !== 1 || !run?.nativeSessionId)
          throw new Error('Actual permission-waiting Native task is unavailable')
        expect(run).toMatchObject({
          agentId,
          status: 'running',
          dispatchPhase: 'accepted',
          permissionMode: 'ask',
        })
        expect(await fileExists(target)).toBe(false)
        await clickStop(ctx, agentId)
        await requireNativeStop(ctx, run.id)
        await expect(card).toHaveCount(0)
        const stale = await ctx.page.evaluate(async (input) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.respondNativePermission(input)
        }, pending)
        expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
        expect(await fileExists(target)).toBe(false)
        const stopped = await readRealConversation(ctx)
        for (const source of before.messages.filter((message) => message.role === 'assistant'))
          expect(
            stopped.messages
              .find((message) => message.id === source.id)
              ?.content.startsWith(source.content),
          ).toBe(true)
        const visibleAfter = await visibleResponseFacts(ctx)
        await ctx.page.waitForTimeout(2_000)
        expect(await visibleResponseFacts(ctx)).toEqual(visibleAfter)
        expect(await fileExists(target)).toBe(false)
        const after = await readRealConversation(ctx)
        expect(after.runs).toHaveLength(1)
        expect(after.messages.some((message) => message.pendingAgentId)).toBe(false)
        const native = await findNativeRecord(ctx, agentId, run.nativeSessionId)
        expect(native.containsText(marker)).toBe(true)
        expect(agentId === 'codex' ? native.codexModelStarts : native.claudeUserInputs).toBe(1)
        if (agentId === 'codex') expect(await secondaryModelInputs(ctx)).toBe(0)
        await test.info().attach('actual-unanswered-permission-stop', {
          body: JSON.stringify({
            agentId,
            runId: run.id,
            nativeSessionId: run.nativeSessionId,
            permissionId: pending.permissionId,
            staleDecisionCode: stale.ok ? 'unexpected-success' : stale.error.code,
            fileCreated: false,
            explicitModelInputs: 1,
            visibleResponses: visibleAfter,
          }),
          contentType: 'application/json',
        })
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )

  test(
    `real ${agentId} UI Stop interrupts its foreground command before the delayed filesystem effect`,
    { tag: ['@real', '@real-core'] },
    async () => {
      test.setTimeout(600_000)
      const ctx = await launchRealWorkspace(`real-stop-command-${agentId}`)
      const marker = authMarker('FOREGROUND_STOP')
      const filename = `stop-command-${marker}.mjs`
      const readyPath = join(ctx.projectDirectory, `${marker}-ready.json`)
      const finishedPath = join(ctx.projectDirectory, `${marker}-finished.txt`)
      let ready: CommandReady | undefined
      let runId: string | undefined
      let stopStartedAt: number | undefined,
        stopReturnedAt: number | undefined,
        nativeEndedAt: number | undefined,
        firstPidExitAt: number | undefined
      let pidObserver: ReturnType<typeof setInterval> | undefined
      let atStopNative: NativeEvidence | undefined
      try {
        if (agentId === 'claude') await selectRealConfiguredEffort(ctx, [agentId])
        await askMode(ctx, agentId)
        await writeFile(join(ctx.projectDirectory, filename), commandScript(marker), {
          mode: 0o600,
          flag: 'wx',
        })
        const command =
          process.platform === 'win32' && agentId === 'codex'
            ? `& '${process.execPath.replaceAll("'", "''")}' './${filename.replaceAll("'", "''")}'`
            : `${shellQuote(process.execPath)} ${shellQuote(`./${filename}`)}`
        await sendRealMessage(
          ctx,
          `Run exactly this shell command once in the Project directory: ${command}. It runs a local bounded test script for 15 seconds. Run it in the foreground and wait for it; use timeout 60000 ms and yield/wait 30000 ms where those tool options exist. Do not background, detach, spawn another agent, modify the script, run any other command, or inspect other files. Request approval if the native tool requires it.`,
          agentId === 'codex' ? 'all' : 'claude',
        )
        const card = permissionCard(ctx, agentId)
        // Workspace-write may permit this exact owned command directly. When
        // Native asks, approve only its current offered one-call action.
        await expect
          .poll(
            async () =>
              (await readCommandReady(readyPath, marker))
                ? 'started'
                : (await card.isVisible())
                  ? 'approval'
                  : 'waiting',
            { timeout: 120_000 },
          )
          .not.toBe('waiting')
        if (!(await readCommandReady(readyPath, marker))) {
          await currentPermission(ctx, agentId, filename)
          await card.getByRole('button', { name: allowLabel(agentId), exact: true }).click()
        }
        await expect
          .poll(async () => Boolean(await readCommandReady(readyPath, marker)), {
            timeout: 120_000,
          })
          .toBe(true)
        ready = await readCommandReady(readyPath, marker)
        if (!ready)
          throw new Error('The real foreground command did not publish its owned PID witness')
        expect(isProcessAlive(ready.pid)).toBe(true)
        expect(
          ready.finishDueAt - Date.now(),
          'The actual command must still be executing when UI Stop is clicked',
        ).toBeGreaterThan(3_000)
        expect(await fileExists(finishedPath)).toBe(false)
        const running = await readRealConversation(ctx)
        const run = running.runs[0]
        if (running.runs.length !== 1 || !run?.nativeSessionId)
          throw new Error('Actual foreground Native task is unavailable')
        runId = run.id
        expect(run).toMatchObject({ agentId, status: 'running', dispatchPhase: 'accepted' })
        expect(
          running.activities.some(
            (activity) =>
              activity.kind === 'tool' &&
              (agentId === 'claude'
                ? activity.toolName === 'Bash'
                : (activity.title + (activity.detail ?? '')).includes(filename)),
          ),
        ).toBe(true)
        atStopNative = await findNativeRecord(ctx, agentId, run.nativeSessionId)
        const physical = ready
        const observationDeadline = Date.now() + 45_000
        // This case owns one PID observer, at most 1800 samples/45 seconds.
        // It observes signal zero and releases its timer before fixture teardown.
        pidObserver = setInterval(() => {
          if (!isProcessAlive(physical.pid) && firstPidExitAt === undefined)
            firstPidExitAt = Date.now()
          if (Date.now() >= observationDeadline) clearInterval(pidObserver)
        }, 25)
        stopStartedAt = Date.now()
        await clickStop(ctx, agentId)
        stopReturnedAt = Date.now()
        // Native terminal evidence is independent of Pact's immediate Stopped
        // projection. This case also observes the exact script PID naturally
        // exit; it never kills a process to make cancellation appear to work.
        const settlements = await Promise.allSettled([
          requireNativeStop(ctx, run.id).then(() => {
            nativeEndedAt = Date.now()
            return undefined
          }),
          expect.poll(() => isProcessAlive(physical.pid), { timeout: 10_000 }).toBe(false),
        ])
        for (const settlement of settlements)
          if (settlement.status === 'rejected') throw settlement.reason
        const stopped = await visibleResponseFacts(ctx)
        await ctx.page.waitForTimeout(Math.max(0, ready.finishDueAt + 500 - Date.now()))
        expect(await fileExists(finishedPath)).toBe(false)
        expect(isProcessAlive(ready.pid)).toBe(false)
        expect(await visibleResponseFacts(ctx)).toEqual(stopped)
        const after = await readRealConversation(ctx)
        expect(after.runs).toHaveLength(1)
        expect(after.messages.some((message) => message.pendingAgentId)).toBe(false)
        const native = await findNativeRecord(ctx, agentId, run.nativeSessionId)
        expect(native.containsText(filename)).toBe(true)
        expect(agentId === 'codex' ? native.codexModelStarts : native.claudeUserInputs).toBe(1)
        if (agentId === 'codex') expect(await secondaryModelInputs(ctx)).toBe(0)
      } finally {
        try {
          if (ready) {
            // Even a failed cancellation check must observe the owned command
            // beyond its original deadline before ordinary teardown can end it.
            await ctx.page.waitForTimeout(Math.max(0, ready.finishDueAt + 500 - Date.now()))
            clearInterval(pidObserver)
            // Capture observed physical facts before ordinary fixture teardown,
            // including failures where Native retained uncancellable background work.
            const facts = await readRealConversation(ctx)
            const run = facts.runs.find((candidate) => candidate.id === runId)
            const latestNative = run?.nativeSessionId
              ? await findNativeRecord(ctx, agentId, run.nativeSessionId).catch(() => undefined)
              : undefined
            const commandFacts = (evidence: NativeEvidence | undefined) => {
              if (!evidence) return undefined
              const calls = evidence.commandCalls.filter((call) => call.command.includes(filename))
              const scripts = evidence.execScripts.filter((script) =>
                script.input.includes(filename),
              )
              const ids = new Set([...calls, ...scripts].map((call) => call.callId))
              return {
                calls,
                scripts: scripts.map((script) => ({
                  callId: script.callId,
                  at: script.at,
                  input: ctx.fixture.redactDiagnostic(script.input),
                })),
                results: evidence.commandResults
                  .filter((result) => ids.has(result.callId))
                  .map((result) => ({
                    callId: result.callId,
                    at: result.at,
                    outputSha256: createHash('sha256').update(result.output).digest('hex'),
                    status:
                      result.output.match(
                        /Process exited with code -?\d+|Process running with session ID [A-Za-z0-9_-]+|Script running with cell ID [A-Za-z0-9_-]+/gu,
                      ) ?? [],
                  })),
              }
            }
            await test.info().attach('actual-foreground-command-stop', {
              body: JSON.stringify({
                agentId,
                runId,
                ready,
                pidStillAliveBeforeTeardown: isProcessAlive(ready.pid),
                finishedFileExistsBeforeTeardown: await fileExists(finishedPath),
                observedAt: Date.now(),
                stopStartedAt,
                stopReturnedAt,
                nativeEndedAt,
                firstPidExitAt,
                nativeAtStop: commandFacts(atStopNative),
                nativeAfterStop: commandFacts(latestNative),
                run: run
                  ? {
                      status: run.status,
                      failureKind: run.failureKind,
                      dispatchPhase: run.dispatchPhase,
                      nativeOutcome: run.nativeOutcome,
                      nativeEffectsState: run.nativeEffectsState,
                    }
                  : undefined,
              }),
              contentType: 'application/json',
            })
          }
        } finally {
          clearInterval(pidObserver)
          await closeRealWorkspace(ctx)
        }
      }
    },
  )
}

interface CommandReady {
  marker: string
  pid: number
  startedAt: number
  finishDueAt: number
}

function commandScript(marker: string): string {
  return `import { renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const marker = ${JSON.stringify(marker)};
const startedAt = Date.now();
const path = (suffix) => fileURLToPath(new URL(marker + suffix, import.meta.url));
writeFileSync(path('-ready.tmp'), JSON.stringify({marker, pid: process.pid, startedAt, finishDueAt: startedAt + ${commandDelayMs}}), {flag: 'wx', mode: 0o600});
renameSync(path('-ready.tmp'), path('-ready.json'));
setTimeout(() => writeFileSync(path('-finished.txt'), marker, {flag: 'wx', mode: 0o600}), ${commandDelayMs});
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return false
    throw error
  }
}

async function readCommandReady(path: string, marker: string): Promise<CommandReady | undefined> {
  if (!(await fileExists(path))) return undefined
  if ((await stat(path)).size > 2048) throw new Error('Owned command PID witness exceeds 2 KiB')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed owned command PID witness')
  const pid: unknown = Reflect.get(value, 'pid')
  const startedAt: unknown = Reflect.get(value, 'startedAt')
  const finishDueAt: unknown = Reflect.get(value, 'finishDueAt')
  if (
    Reflect.get(value, 'marker') !== marker ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    typeof startedAt !== 'number' ||
    !Number.isSafeInteger(startedAt) ||
    typeof finishDueAt !== 'number' ||
    !Number.isSafeInteger(finishDueAt) ||
    finishDueAt - startedAt !== commandDelayMs
  )
    throw new Error('Owned command PID witness does not match this exact bounded script')
  return { marker, pid, startedAt, finishDueAt }
}

/** Signal zero observes this script's witnessed PID; no terminating signal is sent. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ESRCH') return false
    throw error
  }
}

function permissionCard(ctx: RealWorkspace, agentId: 'claude' | 'codex') {
  return ctx.page.getByRole('region', {
    name: `${agentId === 'codex' ? 'Codex' : 'Claude Code'} permission request`,
    exact: true,
  })
}

function allowLabel(agentId: 'claude' | 'codex'): string {
  return agentId === 'codex' ? 'Allow this command' : 'Allow this tool call'
}

async function askMode(ctx: RealWorkspace, agentId: 'claude' | 'codex'): Promise<void> {
  const saved = await ctx.page.evaluate(
    async ({ sessionId, agentId: agent }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const current = await bridge.getSessionSettings(sessionId)
      if (!current.ok) throw new Error('Actual Session permission settings unavailable')
      return bridge.saveSessionPermission({
        sessionId,
        agentId: agent,
        mode: 'ask',
        expectedRevision: current.value.session.settingsRevision,
        confirmedFullAccess: false,
      })
    },
    { sessionId: ctx.sessionId, agentId },
  )
  expect(saved.ok).toBe(true)
}

async function currentPermission(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  commandFilename: string,
) {
  return ctx.page.evaluate(
    async ({ sessionId, agentId: agent, filename, allow }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const page = await bridge.getConversation({ scope: 'messages', sessionId })
      if (!page.ok || page.value.scope !== 'messages')
        throw new Error('Actual Native interaction projection unavailable')
      const pending = page.value.header.pendingNativeInteractions?.filter(
        (row) => row.agentId === agent,
      )
      if (pending?.length !== 1 || !pending[0]?.request.operationId)
        throw new Error('Expected exactly one current Native permission owner')
      const request = pending[0].request
      const operationId = request.operationId!
      const detail = await bridge.readNativeInput({ operationId, requestId: request.id })
      if (!detail.ok || detail.value.kind !== 'approval' || !detail.value.detail.includes(filename))
        throw new Error('Native approval is not for this exact owned test command')
      const action = detail.value.actions.find(
        (candidate) => candidate.kind === 'allow' && candidate.label === allow,
      )
      if (!action) throw new Error('Native approval did not offer its one-call action')
      return { operationId, permissionId: request.id, decision: action.id }
    },
    { sessionId: ctx.sessionId, agentId, filename: commandFilename, allow: allowLabel(agentId) },
  )
}

async function clickStop(ctx: RealWorkspace, agentId: 'claude' | 'codex'): Promise<void> {
  await ctx.page
    .getByRole('button', {
      name: `Stop ${agentId === 'codex' ? 'Codex' : 'Claude Code'} response`,
      exact: true,
    })
    .click()
}

async function requireNativeStop(ctx: RealWorkspace, runId: string): Promise<void> {
  const database = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    await expect
      .poll(
        () =>
          database.drizzle.query.agentRuns
            .findFirst({
              where: (fields, { eq }) => eq(fields.id, runId),
              columns: {
                status: true,
                dispatchPhase: true,
                nativeOutcome: true,
              },
            })
            .sync(),
        { timeout: 30_000 },
      )
      .toEqual({
        status: 'interrupted',
        dispatchPhase: 'ended',
        nativeOutcome: 'interrupted',
      })
    await expect
      .poll(() => runtimeCounters(ctx), { timeout: 30_000 })
      .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
  } finally {
    database.close()
  }
}

async function visibleResponseFacts(ctx: RealWorkspace) {
  const page = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getConversation({ scope: 'messages', sessionId })
  }, ctx.sessionId)
  if (!page.ok || page.value.scope !== 'messages')
    throw new Error('Actual stopped response window unavailable')
  return page.value.messages
    .filter((row) => row.message.role === 'assistant')
    .map((row) => {
      if (row.kind !== 'complete')
        throw new Error('Small stopped response unexpectedly exceeded its page bound')
      return responseFacts(row.message)
    })
}

async function runtimeCounters(ctx: RealWorkspace) {
  return ctx.page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const result = await bridge.getRuntimeHealth()
    if (!result.ok || !result.value.conversation)
      throw new Error('Actual runtime counters unavailable')
    return result.value.conversation
  })
}

function responseFacts(message: ConversationSnapshot['messages'][number] | undefined) {
  if (!message) throw new Error('Interrupted response identity disappeared')
  return {
    id: message.id,
    state: message.state,
    contentRevision: message.contentRevision,
    bytes: Buffer.byteLength(message.content),
    sha256: createHash('sha256').update(message.content).digest('hex'),
  }
}

async function createCommentOnAcceptedMessage(
  page: Page,
  messageId: string,
  quote: string,
  body: string,
) {
  const transcript = page.getByRole('region', { name: 'Conversation messages', exact: true })
  // Home is a completed keyboard gesture: it withdraws tail-following before
  // Selection even when the first streamed fragment does not overflow yet.
  await transcript.focus()
  await transcript.press('Home')
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
  await page.locator(`[data-pact-message-id="${messageId}"]`).scrollIntoViewIfNeeded()
  await page.evaluate(
    ({ messageId: id, quote: selected }) => {
      const host = document.querySelector<HTMLElement>(
        `[data-pact-message-id="${id}"] [data-pact-message-content]`,
      )
      const projections = host?.querySelectorAll<HTMLElement>('[data-pact-projection-start]')
      if (!host || !projections || projections.length > 256)
        throw new Error('Actual Message selection projection unavailable')
      const span = [...projections].find(
        (candidate) =>
          candidate.firstChild instanceof Text && candidate.firstChild.data.includes(selected),
      )
      const node = span?.firstChild
      if (!(node instanceof Text) || !span)
        throw new Error('Actual accepted Message quote unavailable')
      const start = node.data.indexOf(selected)
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + selected.length)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    { messageId, quote },
  )
  await page.getByRole('button', { name: 'Comment on selected text', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New comment', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill(body)
  await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(body)
}

/** Scan only the unused secondary's isolated home; count actual explicit inputs, never fake counters. */
async function secondaryModelInputs(ctx: RealWorkspace): Promise<number> {
  const queue = [join(ctx.fixture.claudeHome, 'projects')]
  let entries = 0
  let files = 0
  let totalBytes = 0
  let inputs = 0
  const deadline = Date.now() + 15_000
  while (queue.length) {
    if (Date.now() > deadline) throw new Error('Unused secondary Native scan exceeded its deadline')
    const path = queue.shift()!
    let directory
    try {
      // oxlint-disable-next-line no-await-in-loop -- One owned bounded directory is opened at a time.
      directory = await opendir(path)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        Reflect.get(error, 'code') === 'ENOENT' &&
        entries === 0
      )
        return 0
      throw error
    }
    // oxlint-disable-next-line no-await-in-loop -- Finish and release one owned directory before opening another.
    for await (const entry of directory) {
      if (++entries > 1000) throw new Error('Unused secondary Native scan exceeded 1000 entries')
      if (Date.now() > deadline)
        throw new Error('Unused secondary Native scan exceeded its deadline')
      if (entry.isSymbolicLink()) throw new Error('Unused secondary Native scan refuses symlinks')
      const child = join(path, entry.name)
      if (entry.isDirectory()) queue.push(child)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        totalBytes += (await stat(child)).size
        if (++files > 8 || totalBytes > nativeByteLimit)
          throw new Error('Unused secondary Native evidence exceeded 8 files / 8 MiB')
        inputs += (await readNativeEvidence(child)).claudeUserInputs
      }
    }
  }
  return inputs
}
