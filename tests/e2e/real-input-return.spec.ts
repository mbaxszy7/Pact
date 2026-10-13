import { expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'
import type { NativeRpc, NativeThread } from '../native/native-harness.js'

import { markdownVisibleProjection } from '../../apps/desktop/src/shared/message-anchor-text.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

test.describe('real business input return', { tag: '@real' }, () => {
  for (const keepNewDraft of [false, true]) {
    test(`real occupied writer returns frozen Codex input and Comments; new draft ${keepNewDraft ? 'preserved' : 'empty'}`, async () => {
      test.setTimeout(600_000)
      const ctx = await launchRealWorkspace(
        `real-input-return-${keepNewDraft ? 'preserved' : 'empty'}`,
        keepNewDraft ? { transportFault: 'pause-resume' } : {},
      )
      let writer: NativeRpc | undefined
      let reader: NativeRpc | undefined
      let resumeHeld = false
      try {
        if (keepNewDraft) await ctx.fixture.controlTransportFault('release')
        const sourceMarker = `SOURCE_${randomUUID()}`
        await sendRealMessage(
          ctx,
          `Briefly acknowledge ${sourceMarker}. Do not use tools, read files or write files.`,
          'codex',
        )
        const source = await waitForRealCompletion(ctx, 1)
        const sourceRun = source.runs[0]
        const answer = source.messages.find((message) => message.role === 'assistant')
        if (!sourceRun?.nativeSessionId || !sourceRun.nativeTurnId || !answer)
          throw new Error('Real source Native identity or answer is unavailable')
        const projection = markdownVisibleProjection(answer.content)
        const startOffset = projection.indexOf(sourceMarker)
        expect(
          startOffset,
          ctx.fixture.redactDiagnostic(
            JSON.stringify({ sourceAnswer: answer.content.slice(0, 2000) }),
          ),
        ).toBeGreaterThanOrEqual(0)
        const commentId = randomUUID()
        const commentBody = `Retain anchored instruction ${randomUUID()}`
        const saved = await ctx.page.evaluate(
          async (input) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.saveCommentDraft(input)
          },
          {
            mode: 'create' as const,
            sessionId: ctx.sessionId,
            commentId,
            expectedCommentsRevision: source.commentsRevision,
            body: commentBody,
            anchor: {
              type: 'message' as const,
              messageId: answer.id,
              contentHash: createHash('sha256').update(answer.content).digest('hex'),
              textBasis: 'markdown-visible-v2' as const,
              startOffset,
              endOffset: startOffset + sourceMarker.length,
              quote: sourceMarker,
            },
          },
        )
        expect(saved.ok).toBe(true)
        const resolved = await ctx.page.evaluate(
          async ({ sessionId, id }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.resolveCommentSource(sessionId, id)
          },
          { sessionId: ctx.sessionId, id: commentId },
        )
        expect(resolved).toMatchObject({ ok: true, value: { status: 'resolved' } })
        await expect(
          ctx.page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)
        const settings = await ctx.page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const current = await bridge.getSessionSettings(sessionId)
          if (!current.ok) throw new Error(current.error.message)
          const changed = await bridge.saveSessionSettings({
            sessionId,
            settings: {
              primaryAgentId: 'claude',
              agents: current.value.session.settings.agents,
              maxDiscussionRounds: current.value.session.settings.maxDiscussionRounds,
              runningMessagePolicy: current.value.session.settings.runningMessagePolicy,
              maxReviewCycles: current.value.session.settings.maxReviewCycles,
              maxRepairAttempts: current.value.session.settings.maxRepairAttempts,
            },
          })
          if (!changed.ok) throw new Error(changed.error.message)
          const updated = await bridge.getSessionSettings(sessionId)
          if (!updated.ok) throw new Error(updated.error.message)
          return {
            before: current.value.session.settings,
            after: updated.value.session.settings,
          }
        }, ctx.sessionId)
        expect(settings.after.primaryAgentId).toBe('claude')
        expect(settings.after.agents).toEqual(settings.before.agents)

        // Close Pact before another actual app-server owns this same Native writer.
        await ctx.app.close()
        writer = await ctx.fixture.openCodexClient('Codex Desktop')
        const resumed = await writer.request<{ thread: NativeThread }>('thread/resume', {
          threadId: sourceRun.nativeSessionId,
          cwd: ctx.projectDirectory,
        })
        expect(resumed.error).toBeUndefined()
        expect(resumed.result?.thread.id).toBe(sourceRun.nativeSessionId)
        expect(resumed.result?.thread.status.type).toBe('idle')
        const originalTurns = await nativeTurnIds(writer, sourceRun.nativeSessionId)
        expect(originalTurns).toContain(sourceRun.nativeTurnId)
        ctx.app = await ctx.fixture.launch()
        ctx.page = await ctx.app.firstWindow()
        await selectRealSession(ctx, ctx.sessionId)

        const rejectedMarker = `RETURN_${randomUUID()}`
        const rejectedBody = `Acknowledge ${rejectedMarker}. Do not use tools, read files or write files.`
        const rejectedInput = `@codex ${rejectedBody}`
        if (keepNewDraft) {
          await ctx.fixture.controlTransportFault('arm')
          resumeHeld = true
        }
        await sendRealMessage(ctx, rejectedBody, 'codex')
        const composer = ctx.page.getByRole('combobox', { name: 'Message', exact: true })
        if (keepNewDraft) {
          // Hold the unchanged resume request before real dispatch, so the newer
          // draft precedes the genuine writer refusal rather than racing it.
          await expect
            .poll(
              async () => {
                const rows = (await ctx.fixture.readTransportFacts()).filter(
                  (row) => !row.closed && row.faultPhase === 'held-before-native',
                )
                const held = rows[0]
                return {
                  heldCount: rows.length,
                  forwardedTurns: held?.forwardedTurns,
                  heldResume: held?.entries.some(
                    (entry) =>
                      entry.kind === 'stdin-held' &&
                      entry.method === 'thread/resume' &&
                      entry.nativeSessionId === sourceRun.nativeSessionId,
                  ),
                }
              },
              { timeout: 5_000 },
            )
            .toEqual({ heldCount: 1, forwardedTurns: 0, heldResume: true })
          await expect.poll(() => composer.textContent()).toBe('')
          await composer.fill('Keep my newer draft')
          const held = (await ctx.fixture.readTransportFacts()).find(
            (row) => !row.closed && row.faultPhase === 'held-before-native',
          )
          const heldAt = held?.entries.find((entry) => entry.kind === 'stdin-held')?.at
          if (heldAt === undefined) throw new Error('Owned resume hold is unavailable')
          expect(Date.now() - heldAt).toBeLessThan(2_000)
          await ctx.fixture.controlTransportFault('release')
          resumeHeld = false
        }
        await expect(ctx.page.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
          timeout: 20_000,
        })
        const rejected = await readRealConversation(ctx)
        expect(rejected.runs).toHaveLength(2)
        const failed = rejected.runs.find((run) => run.id !== sourceRun.id)
        expect(failed).toMatchObject({
          agentId: 'codex',
          status: 'failed',
          failureKind: 'native_session_occupied',
        })
        if (!failed || failed.failureKind !== 'native_session_occupied')
          throw new Error('Actual occupied-writer rejection did not persist its failed Run')
        expect(await nativeTurnIds(writer, sourceRun.nativeSessionId)).toEqual(originalTurns)
        expect(writer.child.exitCode).toBeNull()
        // EOF is natural release of our own writer; no lock deletion or external termination.
        writer.child.stdin.end()
        await writer.exited
        expect(writer.child.exitCode).toBe(0)
        await writer.close()
        writer = undefined

        await ctx.page.getByRole('button', { name: 'Rebuild…', exact: true }).click()
        await ctx.page.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
        await expect(
          ctx.page.getByText('Codex native session rebuilt', { exact: true }),
        ).toBeVisible({ timeout: 120_000 })
        if (keepNewDraft) {
          await expect.poll(() => composer.textContent()).toBe('Keep my newer draft')
          await expect(
            ctx.page.getByText('Previous unsent message is available', { exact: true }),
          ).toBeVisible()
          await expect(
            ctx.page.getByRole('button', { name: 'Restore to input', exact: true }),
          ).toBeDisabled()
          await composer.fill('')
        }
        await expect.poll(() => composer.textContent()).toBe(rejectedInput)
        await expect(
          ctx.page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)
        await expect(ctx.page.getByText('Unsent message restored', { exact: true })).toBeVisible()
        const restored = await readRealConversation(ctx)
        expect(restored.runs.map((run) => run.id)).toEqual(rejected.runs.map((run) => run.id))
        expect(restored.rebuildInputRecovery).toMatchObject({
          route: { type: 'agent', agentId: 'codex' },
          state: 'installed',
          messageId: failed.userMessageId,
        })
        const receipt = restored.rebuildInputRecovery
        if (!receipt) throw new Error('Returned-input receipt is unavailable')
        const drafts = restored.comments.filter((comment) => comment.status === 'draft')
        expect(drafts).toHaveLength(1)
        expect(drafts[0]?.id).not.toBe(commentId)
        expect(drafts[0]?.body).toBe(commentBody)
        expect(receipt.commentIds).toEqual([])
        expect(receipt.draftEligibility).toEqual({
          commentsRevision: restored.commentsRevision,
          canRestore: true,
        })
        expect(receipt.inputBatchRef?.memberCount).toBe(1)
        const rebuiltNativeId = restored.nativeContexts.find(
          (context) => context.agentId === 'codex',
        )?.nativeSessionId
        if (!rebuiltNativeId) throw new Error('Rebuilt actual Native identity is unavailable')
        expect(rebuiltNativeId).not.toBe(sourceRun.nativeSessionId)

        // A real read-only Native client proves Rebuild has launched no model Turn.
        reader = await ctx.fixture.openCodexClient('Codex Desktop')
        expect(await nativeTurnIds(reader, sourceRun.nativeSessionId)).toEqual(originalTurns)
        expect(await nativeTurnIds(reader, rebuiltNativeId)).toEqual([])
        await reader.close()
        reader = undefined
        await restartRealWorkspace(ctx)
        const coldComposer = ctx.page.getByRole('combobox', { name: 'Message', exact: true })
        await expect.poll(() => coldComposer.textContent()).toBe(rejectedInput)
        await expect(
          ctx.page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)
        const cold = await readRealConversation(ctx)
        expect(cold.rebuildInputRecovery).toEqual(receipt)
        expect(
          cold.comments
            .filter((comment) => comment.status === 'draft')
            .map((comment) => comment.id),
        ).toEqual(drafts.map((comment) => comment.id))
        expect(cold.runs.map((run) => run.id)).toEqual(rejected.runs.map((run) => run.id))

        // Only this new explicit user Enter may deliver the returned task.
        await coldComposer.press('Enter')
        const completed = await waitForRealCompletion(ctx, 3, ctx.sessionId, [failed.id])
        expect(
          completed.runs.filter((run) => run.status === 'completed' && run.agentId === 'codex'),
        ).toHaveLength(2)
        expect(completed.runs.filter((run) => run.agentId === 'claude')).toHaveLength(0)
        const newRun = completed.runs.find((run) => run.id !== sourceRun.id && run.id !== failed.id)
        expect(newRun).toMatchObject({
          nativeSessionId: rebuiltNativeId,
          status: 'completed',
          agentId: 'codex',
        })
        expect(
          completed.messages.find(
            (message) => message.role === 'assistant' && message.runId === newRun?.id,
          )?.content,
        ).toContain(rejectedMarker)
        await expect.poll(() => coldComposer.textContent()).toBe('')
        await ctx.app.close()
        const database = await PactDatabase.open({
          filePath: ctx.fixture.databaseFile,
          migrationsFolder,
        })
        try {
          const runs = database.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
              limit: 4,
            })
            .sync()
          expect(runs).toHaveLength(3)
          expect(runs.filter((run) => run.failureKind === 'native_session_occupied')).toHaveLength(
            1,
          )
          const original = database.drizzle.query.conversationMessages
            .findFirst({
              where: (fields, { and, eq }) =>
                and(eq(fields.sessionId, ctx.sessionId), eq(fields.id, receipt.messageId)),
            })
            .sync()
          expect(original?.isVisible).toBe(false)
          expect(original?.content).toBe(rejectedInput)
          const comments = database.drizzle.query.anchoredComments
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
              limit: 3,
            })
            .sync()
          expect(comments).toHaveLength(2)
          expect(comments.find((comment) => comment.id === commentId)?.sentWithMessageId).toBe(
            original?.id,
          )
          expect(comments.find((comment) => comment.id === drafts[0]?.id)?.sentWithMessageId).toBe(
            newRun?.userMessageId,
          )
        } finally {
          database.close()
        }
      } finally {
        try {
          if (resumeHeld) await ctx.fixture.controlTransportFault('cancel')
          await writer?.close()
          await reader?.close()
        } finally {
          await closeRealWorkspace(ctx)
        }
      }
    })
  }
})

async function nativeTurnIds(client: NativeRpc, threadId: string): Promise<string[]> {
  const reply = await client.request<{ data: Array<{ id: string }>; nextCursor: string | null }>(
    'thread/turns/list',
    {
      threadId,
      limit: 25,
      sortDirection: 'asc',
    },
  )
  expect(reply.error).toBeUndefined()
  if (!reply.result || !Array.isArray(reply.result.data))
    throw new Error('Actual Native Turn page is unavailable')
  expect(reply.result.nextCursor).toBeNull()
  expect(reply.result.data.length).toBeLessThanOrEqual(25)
  for (const turn of reply.result.data) expect(typeof turn.id).toBe('string')
  return reply.result.data.map((turn) => turn.id)
}
