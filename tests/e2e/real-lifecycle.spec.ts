import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

for (const cold of [false, true]) {
  test(
    `real lost ACK recovers the actual completed result without resend; ${cold ? 'cold' : 'warm'} inspection`,
    { tag: ['@real', '@real-extended'] },
    async () => {
      test.setTimeout(360_000)
      const ctx = await launchRealWorkspace(`real-lost-ack-${cold}`, {
        transportFault: 'drop-turn-ack',
      })
      try {
        const marker = authMarker('ACK')
        await sendRealMessage(
          ctx,
          `Briefly acknowledge ${marker}. Do not use tools, read files or write files.`,
          'codex',
        )
        await expect
          .poll(
            async () => {
              const facts = await ctx.fixture.readTransportFacts()
              return {
                dropped: facts.reduce((n, row) => n + row.droppedAcks, 0),
                completed: facts.some((row) =>
                  row.entries.some((entry) => entry.event === 'turn/completed'),
                ),
              }
            },
            { timeout: 120_000 },
          )
          .toEqual({ dropped: 1, completed: true })
        await expect(
          ctx.page.getByRole('button', { name: 'Check session', exact: true }),
        ).toBeVisible({
          timeout: 60_000,
        })
        const failed = await readRealConversation(ctx)
        expect(failed.runs).toHaveLength(1)
        // The current public loss-of-observation projection is interrupted /
        // transient_transport. Actual delivery stays uncertain and gated.
        expect(failed.runs[0]).toMatchObject({
          status: 'interrupted',
          failureKind: 'transient_transport',
        })
        if (cold) await restartRealWorkspace(ctx)
        const inspected = await ctx.page.evaluate(
          async ({ runId, sessionId }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.retryConversationRun(runId, {
              sessionId,
              agentId: 'codex',
              intent: 'inspect',
            })
          },
          { runId: failed.runs[0]!.id, sessionId: ctx.sessionId },
        )
        expect(inspected).toMatchObject({ ok: true })
        const checkedSnapshot = await readRealConversation(ctx)
        const database = ReadonlyFixtureDatabase.open(ctx.fixture)
        let allMessages
        try {
          const rows = database.drizzle.query.conversationMessages
            .findMany({
              where: (fields, { eq }) => eq(fields.runId, failed.runs[0]!.id),
              columns: { id: true, role: true, state: true, isVisible: true, content: true },
              limit: 8,
            })
            .sync()
          allMessages = rows.map((row) => ({
            id: row.id,
            role: row.role,
            state: row.state,
            isVisible: row.isVisible,
            bytes: Buffer.byteLength(row.content),
            hash: hash(row.content),
            marker: row.content.includes(marker),
          }))
        } finally {
          database.close()
        }
        const nativeReader = await ctx.fixture.openCodexClient()
        const nativeState = await nativeReader.request<{
          thread: {
            id: string
            turns: Array<{ id: string; items: Array<{ type: string; text?: string }> }>
          }
        }>('thread/read', {
          threadId: failed.nativeContexts[0]!.nativeSessionId,
          includeTurns: true,
        })
        const nativeEncoded = JSON.stringify(nativeState.result ?? {})
        if (Buffer.byteLength(nativeEncoded) > 8 * 1024 * 1024)
          throw new Error('Native recovery observation exceeded its bound')
        expect(nativeState.error).toBeUndefined()
        const actualTurn = nativeState.result?.thread.turns.find(
          (turn) => turn.id === checkedSnapshot.runs[0]?.nativeTurnId,
        )
        if (!actualTurn || actualTurn.items.length > 128)
          throw new Error('Exact recovered Native Turn unavailable')
        const originalText = actualTurn.items
          .filter((item) => item.type === 'agentMessage')
          .map((item) => item.text)
          .filter((text): text is string => typeof text === 'string' && text.length > 0)
          .join('\n\n')
        const recoveredText = checkedSnapshot.messages.find(
          (row) => row.role === 'assistant' && row.state === 'complete',
        )?.content
        expect(recoveredText).toBe(originalText)
        expect(hash(recoveredText)).toBe(hash(originalText))
        await nativeReader.close()
        await test.info().attach('actual-recovery-state', {
          body: ctx.fixture.redactDiagnostic(
            JSON.stringify({
              cold,
              inspectedOk: inspected.ok,
              run: checkedSnapshot.runs[0],
              assistant: checkedSnapshot.messages
                .filter((row) => row.role === 'assistant')
                .map((row) => ({
                  id: row.id,
                  state: row.state,
                  bytes: Buffer.byteLength(row.content),
                  marker: row.content.includes(marker),
                })),
              nativeContainsMarker: nativeEncoded.includes(marker),
              allMessages,
              nativeReadErrorCode: nativeState.error?.code,
              traffic: await ctx.fixture.readTransportFacts(),
            }),
          ),
          contentType: 'application/json',
        })
        await writeFile(
          test.info().outputPath('actual-recovery-state.json'),
          ctx.fixture.redactDiagnostic(
            JSON.stringify({
              cold,
              run: checkedSnapshot.runs[0],
              allMessages,
              nativeContainsMarker: nativeEncoded.includes(marker),
            }),
          ),
          { mode: 0o600 },
        )
        const visibleWindow = await ctx.page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.getConversation({ scope: 'messages', sessionId })
        }, ctx.sessionId)
        expect(visibleWindow.ok).toBe(true)
        if (!visibleWindow.ok || visibleWindow.value.scope !== 'messages')
          throw new Error('Production recovery window unavailable')
        const visibleAnswers = visibleWindow.value.messages.filter(
          (row) => row.message.role === 'assistant',
        )
        expect(visibleAnswers).toHaveLength(1)
        expect(visibleAnswers[0]?.kind).toBe('complete')
        if (visibleAnswers[0]?.kind !== 'complete')
          throw new Error('Recovered answer is not complete')
        expect(visibleAnswers[0].message.content).toBe(originalText)
        expect(
          allMessages?.filter((row) => row.isVisible && row.role === 'assistant'),
        ).toHaveLength(1)
        await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toContainText(marker, {
          timeout: 60_000,
        })
        const completed = await waitForRealCompletion(ctx, 1)
        expect(completed.runs[0]?.id).toBe(failed.runs[0]?.id)
        expect(completed.messages.find((row) => row.role === 'assistant')?.content).toContain(
          marker,
        )
        expect(await forwarded(ctx)).toBe(1)
        await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
        const digest = hash(completed.messages)
        await restartRealWorkspace(ctx)
        expect(hash((await readRealConversation(ctx)).messages)).toBe(digest)
        expect(await forwarded(ctx)).toBe(1)
        await attachTraffic(ctx)
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )
}

test(
  'real absence and empty interruption never authorize replay or old-task rebuild',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(360_000)
    const ctx = await launchRealWorkspace('real-before-native', { transportFault: 'pause-turn' })
    try {
      const marker = authMarker('UNDELIVERED')
      await sendRealMessage(ctx, `Acknowledge ${marker} briefly. Do not use tools.`, 'codex')
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).some(
              (row) => row.faultPhase === 'held-before-native',
            ),
          { timeout: 45_000 },
        )
        .toBe(true)
      expect(await forwarded(ctx)).toBe(0)
      await ctx.fixture.controlTransportFault('cancel')
      await expect(
        ctx.page.getByRole('button', { name: 'Check session', exact: true }),
      ).toBeVisible({
        timeout: 45_000,
      })
      const failed = await readRealConversation(ctx)
      expect(failed.runs).toHaveLength(1)
      expect(failed.runs[0]?.status).toBe('interrupted')
      expect(failed.messages.filter((row) => row.role === 'assistant' && row.content)).toHaveLength(
        0,
      )
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(0)
      await ctx.fixture.controlTransportFault('release')
      await ctx.page.getByRole('button', { name: 'Check session', exact: true }).click()
      await expect(ctx.page.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
        timeout: 45_000,
      })
      expect(await forwarded(ctx)).toBe(0)
      await ctx.page.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await ctx.page.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(ctx.page.getByText('Codex native session rebuilt', { exact: true })).toBeVisible(
        { timeout: 120_000 },
      )
      const rebuilt = await readRealConversation(ctx)
      expect(rebuilt.runs.map((row) => row.id)).toEqual(failed.runs.map((row) => row.id))
      expect(await forwarded(ctx)).toBe(0)
      const binding = rebuilt.nativeContexts.find((row) => row.agentId === 'codex')
      const operation = binding?.rebuildOperation
      if (!operation) throw new Error('Actual rebuild receipt unavailable')
      const duplicate = await ctx.page.evaluate(
        async (input) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.rebuildNativeContext(input)
        },
        {
          sessionId: ctx.sessionId,
          agentId: 'codex' as const,
          intent: 'create' as const,
          clientOperationId: operation.id,
          expectedGeneration: operation.oldGeneration,
        },
      )
      expect(duplicate.ok).toBe(true)
      await restartRealWorkspace(ctx)
      expect(
        (await readRealConversation(ctx)).nativeContexts.find((row) => row.agentId === 'codex')
          ?.nativeSessionId,
      ).toBe(binding?.nativeSessionId)
      expect(await forwarded(ctx)).toBe(0)
      const newMarker = authMarker('NEW_EXPLICIT')
      await sendRealMessage(ctx, `Briefly acknowledge ${newMarker}. Do not use tools.`, 'codex')
      const final = await waitForRealCompletion(ctx, 2, ctx.sessionId, [failed.runs[0]!.id])
      expect(final.messages.filter((row) => row.role === 'user')).toHaveLength(2)
      const newRun = final.runs.find((row) => row.id !== failed.runs[0]!.id)
      const reply = final.messages.find(
        (row) => row.runId === newRun?.id && row.role === 'assistant',
      )
      if (!newRun?.nativeSessionId || !reply?.content.trim())
        throw new Error('The explicit new request did not produce an actual completed reply')
      expect(newRun.nativeSessionId).toBe(binding?.nativeSessionId)
      expect(reply.state).toBe('complete')
      const native = await findNativeRecord(ctx, 'codex', newRun.nativeSessionId)
      expect(native.codexModelStarts).toBe(1)
      expect(native.containsText(newMarker)).toBe(true)
      expect(native.containsText(reply.content)).toBe(true)
      expect(await forwarded(ctx)).toBe(1)
      await attachTraffic(ctx)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real completion releases the Composer while Native title evidence is delayed',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(360_000)
    const ctx = await launchRealWorkspace('real-title-read-deadline', {
      transportFault: 'block-inspection',
    })
    try {
      await ctx.fixture.controlTransportFault('release')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${authMarker('FIRST')}. Do not use tools.`,
        'codex',
      )
      await waitForRealCompletion(ctx, 1)
      await ctx.fixture.controlTransportFault('arm')
      const marker = authMarker('SECOND')
      await sendRealMessage(ctx, `Briefly acknowledge ${marker}. Do not use tools.`, 'codex')
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).some(
              (row) => row.faultPhase === 'held-after-native',
            ),
          { timeout: 90_000 },
        )
        .toBe(true)
      const completed = await waitForRealCompletion(ctx, 2)
      const run = completed.runs.at(-1)
      const reply = completed.messages.find(
        (row) => row.role === 'assistant' && row.runId === run?.id,
      )
      if (!run?.nativeSessionId || !reply?.content.trim())
        throw new Error('The completed request has no actual Native reply')
      expect(reply.state).toBe('complete')
      const native = await findNativeRecord(ctx, 'codex', run.nativeSessionId)
      expect(native.codexModelStarts).toBe(2)
      expect(native.containsText(marker)).toBe(true)
      expect(native.containsText(reply.content)).toBe(true)
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled({
        timeout: 1_000,
      })
      expect(await forwarded(ctx)).toBe(2)
      await ctx.fixture.controlTransportFault('release')
      await restartRealWorkspace(ctx)
      expect((await readRealConversation(ctx)).runs).toHaveLength(2)
      expect(await forwarded(ctx)).toBe(2)
      await attachTraffic(ctx)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real graceful quit preserves interrupted text through a new explicit request and cold restart',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(360_000)
    const ctx = await launchRealWorkspace('real-graceful-stream')
    try {
      const marker = authMarker('SHUTDOWN')
      await sendRealMessage(
        ctx,
        `Start with ${marker}. Then write 180 numbered lines, each with twelve ordinary words about software testing. Write the complete list without abbreviation. Do not use tools.`,
        'codex',
      )
      try {
        await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toContainText(marker, {
          timeout: 120_000,
        })
      } catch (error) {
        const boundary: Record<string, unknown> = { version: 1, phase: 'before-quit-first-output' }
        try {
          const snapshot = await readRealConversation(ctx),
            run = snapshot.runs[0]
          const response = snapshot.messages.find(
            (message) => message.runId === run?.id && message.role === 'assistant',
          )
          boundary['host'] = {
            runs: snapshot.runs.length,
            runId: run?.id,
            status: run?.status,
            dispatchPhase: run?.dispatchPhase,
            nativeOutcome: run?.nativeOutcome,
            nativeEffectsState: run?.nativeEffectsState,
            nativeSessionPresent: Boolean(run?.nativeSessionId),
            nativeTurnPresent: Boolean(run?.nativeTurnId),
            responseState: response?.state,
            responseRevision: response?.contentRevision,
            responseChars: response?.content.length ?? 0,
            responseBytes: Buffer.byteLength(response?.content ?? ''),
            responseSha256: createHash('sha256')
              .update(response?.content ?? '')
              .digest('hex'),
            markerPresent: response?.content.includes(marker) ?? false,
          }
          boundary['renderer'] = await ctx.page.evaluate(
            (expectedMarker) => ({
              visibility: document.visibilityState,
              focused: document.hasFocus(),
              articles: document.querySelectorAll('article[data-pact-speaker="codex"]').length,
              markerPresent: [
                ...document.querySelectorAll('article[data-pact-speaker="codex"]'),
              ].some((element) => element.textContent?.includes(expectedMarker)),
            }),
            marker,
          )
          if (run?.nativeSessionId && run.nativeTurnId) {
            const native = await findNativeRecord(ctx, 'codex', run.nativeSessionId)
            const parity = native.answerParity({
              nativeSessionId: run.nativeSessionId,
              nativeTurnId: run.nativeTurnId,
              text: response?.content ?? '',
              markers: [marker],
            })
            boundary['nativeFile'] = {
              starts: native.codexModelStarts,
              file: parity.file,
              rootAssistant: parity.native,
              markerOffsets: parity.markers,
              terminals: parity.terminals,
              ambiguous: parity.ambiguous,
              completeProjection: parity.completeProjection,
              exactMatch: parity.exactMatch,
              items: parity.items.slice(0, 4),
              omittedItems: Math.max(0, parity.items.length - 4),
              note: 'Persisted Native text is not a live token-delivery witness; an unfinished item may not yet be stored.',
            }
          }
        } catch {
          boundary['observation'] = 'unavailable'
        }
        const evidence = JSON.stringify(boundary)
        try {
          if (Buffer.byteLength(evidence) <= 16 * 1024) {
            console.info('[pact-graceful-start-boundary]', evidence)
            await test.info().attach('graceful-start-boundary', {
              body: evidence,
              contentType: 'application/json',
            })
          } else console.info('[pact-graceful-start-boundary]', '{"observation":"unavailable"}')
        } catch {
          console.info('[pact-graceful-start-boundary]', '{"observation":"unavailable"}')
        }
        throw error
      }
      const before = await readRealConversation(ctx)
      const response = before.messages.find(
        (row) => row.role === 'assistant' && row.content.includes(marker),
      )
      if (!response) throw new Error('Actual received text unavailable before graceful quit')
      expect(['preparing', 'running', 'waiting_permission', 'waiting_input']).toContain(
        before.runs[0]?.status,
      )
      const runId = before.runs[0]!.id
      await quitPact(ctx.app)
      const durable = await readRealConversation(ctx)
      const persisted = durable.messages.find((row) => row.id === response.id)
      expect(persisted?.content.startsWith(response.content)).toBe(true)
      expect(durable.runs[0]?.id).toBe(runId)
      expect(durable.runs[0]?.status).toBe('interrupted')
      if (!persisted?.content || persisted.state !== 'incomplete')
        throw new Error('Actual interrupted source text is unavailable')
      const preservedId = persisted.id,
        preservedText = persisted.content,
        preservedHash = hash(persisted.content)
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      const cold = await readRealConversation(ctx)
      expect(cold.runs.map((row) => row.id)).toEqual([runId])
      expect(hash(cold.messages)).toBe(hash(durable.messages))
      await selectRealSession(ctx, ctx.sessionId)
      const composer = ctx.page.getByRole('combobox', { name: 'Message' })
      if (!(await composer.isEnabled())) {
        const inspected = await ctx.page.evaluate(
          async ({ sessionId, originalRun }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.retryConversationRun(originalRun, {
              sessionId,
              agentId: 'codex',
              intent: 'inspect',
            })
          },
          { sessionId: ctx.sessionId, originalRun: runId },
        )
        expect(inspected.ok).toBe(true)
      }
      await expect(composer).toBeEnabled()
      const second = authMarker('EXPLICIT_AFTER_INTERRUPTION')
      await sendRealMessage(ctx, `Briefly acknowledge ${second}. Do not use tools.`, 'codex')
      const complete = await waitForRealCompletion(ctx, 2, ctx.sessionId, [runId])
      expect(complete.messages.find((row) => row.id === preservedId)?.content).toBe(preservedText)
      expect(hash(complete.messages.find((row) => row.id === preservedId)?.content)).toBe(
        preservedHash,
      )
      expect(complete.runs.filter((row) => row.id !== runId)).toHaveLength(1)
      const newRun = complete.runs.find((row) => row.id !== runId)!
      expect(
        complete.messages
          .find((row) => row.runId === newRun.id && row.role === 'assistant')
          ?.content.trim().length,
      ).toBeGreaterThan(0)
      const actualInput = await findNativeRecord(ctx, 'codex', newRun.nativeSessionId!)
      expect(actualInput.containsText(second)).toBe(true)
      expect(actualInput.codexModelStarts).toBe(2)
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(2)
      await restartRealWorkspace(ctx)
      const reopened = await readRealConversation(ctx)
      expect(reopened.messages.find((row) => row.id === preservedId)?.content).toBe(preservedText)
      expect(hash(reopened.messages.find((row) => row.id === preservedId)?.content)).toBe(
        preservedHash,
      )
      expect(reopened.runs.map((row) => row.id)).toEqual(complete.runs.map((row) => row.id))
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(2)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

async function forwarded(ctx: RealWorkspace): Promise<number> {
  return (await ctx.fixture.readTransportFacts()).reduce((n, row) => n + row.forwardedTurns, 0)
}
async function attachTraffic(ctx: RealWorkspace): Promise<void> {
  const records = await ctx.fixture.readTransportFacts()
  expect(records.some((row) => typeof row.actualVersion === 'string')).toBe(true)
  expect(records.some((row) => row.appServer && row.actualChildPid)).toBe(true)
  expect(records.every((row) => row.evictedEntries === 0)).toBe(true)
  await test.info().attach('actual-native-traffic', {
    body: JSON.stringify(records),
    contentType: 'application/json',
  })
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
