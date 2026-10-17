import { expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'

import type {
  ConversationSnapshot,
  DesktopBridge,
  RuntimeHealth,
} from '../../packages/contracts/src/index.js'

import {
  CONVERSATION_PAGE_BYTES,
  CONVERSATION_PATCH_BYTES,
} from '../../packages/contracts/src/index.js'
import {
  addRealSession,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

const caseDeadlineMs = 600_000
const observationKey = '__pactRealStreamObservation'
const observationItems = 64
const observationBytes = 1024 * 1024
const backgroundBytes = 8 * 1024
type StreamPhase = 'foreground' | 'background' | 'settings' | 'minimized' | 'background-completion'
interface PhaseCounters {
  patches: number
  bytes: number
  assistantChanges: number
  assistantTextBytes: number
}
interface PatchSummary {
  phase: StreamPhase
  sequence: number
  bytes: number
  assistantChanges: number
  assistantTextBytes: number
}
interface StreamObservation {
  phase: StreamPhase
  runId?: string
  userMessageId?: string
  assistantTextBytes: number
  maxPatchBytes: number
  retainedBytes: number
  records: PatchSummary[]
  phases: Record<StreamPhase, PhaseCounters>
  fault?: string
}

test(
  'real five active Sessions reject a sixth without accepting input',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-capacity', { transportFault: 'pause-turn' })
    try {
      const activeIds = [ctx.sessionId]
      for (let index = 1; index < 5; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Create each owned Session before simultaneous real admission.
        activeIds.push(await addRealSession(ctx, `Capacity Session ${index}`))
      }
      const sixthId = await addRealSession(ctx, 'Capacity Session 5')
      await selectRealSession(ctx, sixthId)
      const marker = `CAPACITY_${randomUUID()}`
      const accepted = await ctx.page.evaluate(
        async ({ sessionIds, requestMarker }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return Promise.all(
            sessionIds.map((sessionId, index) =>
              bridge.sendConversationMessage({
                sessionId,
                clientMessageId: crypto.randomUUID(),
                content: `Briefly acknowledge ${requestMarker}_${index}. Do not use tools, read files or write files.`,
                expectedCommentsRevision: 0,
                commentIds: [],
                route: { type: 'agent', agentId: 'codex' },
              }),
            ),
          )
        },
        { sessionIds: activeIds, requestMarker: marker },
      )
      expect(accepted).toHaveLength(5)
      expect(accepted.every((result) => result.ok)).toBe(true)
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).filter(
              (row) => row.faultPhase === 'held-before-native',
            ).length,
          { timeout: 60_000 },
        )
        .toBe(5)
      await expect
        .poll(() => health(ctx), { timeout: 60_000, intervals: [100, 250, 500] })
        .toMatchObject({ activeExecutions: 5, preparingExecutions: 0, adapterSlots: 5 })

      const composer = ctx.page.getByRole('combobox', { name: 'Message' })
      const draft = `The sixth request stays here ${randomUUID()}`
      await composer.fill(draft)
      await ctx.page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(ctx.page.locator('[data-pact-toast-tone="warning"]')).toContainText(
        'At most 5 Sessions can run Agents at once.',
      )
      await expect.poll(() => composer.textContent()).toBe(draft)
      await expect(ctx.page.locator('article[data-pact-speaker="user"]')).toHaveCount(0)
      const rejected = await readRealConversation(ctx, sixthId)
      expect(rejected.messages).toHaveLength(0)
      expect(rejected.runs).toHaveLength(0)
      expect(rejected.nativeContexts).toHaveLength(0)
      expect(await health(ctx)).toMatchObject({
        activeExecutions: 5,
        preparingExecutions: 0,
        adapterSlots: 5,
      })

      // Each saturated slot owns an actual CLI and a real request. Release all
      // held bytes after rejection, then require five genuine model completions.
      await ctx.fixture.controlTransportFault('release')
      const completed = await Promise.all(activeIds.map((id) => waitForRealCompletion(ctx, 1, id)))
      const nativeIds = await Promise.all(
        completed.map(async (snapshot, index) => {
          expect(snapshot.runs).toHaveLength(1)
          expect(snapshot.messages.filter((message) => message.role === 'user')).toHaveLength(1)
          const reply = answer(snapshot)
          expect(reply.content.trim().length).toBeGreaterThan(0)
          expect(snapshot.runs[0]?.nativeSessionId).toBeTruthy()
          expect(snapshot.runs[0]?.nativeTurnId).toBeTruthy()
          const native = await findNativeRecord(ctx, 'codex', snapshot.runs[0]!.nativeSessionId!)
          expect(native.codexModelStarts).toBe(1)
          expect(native.containsText(`${marker}_${index}`)).toBe(true)
          expect(native.containsText(reply.content)).toBe(true)
          return snapshot.runs[0]!.nativeSessionId
        }),
      )
      expect(new Set(nativeIds).size).toBe(5)
      expect(
        (await ctx.fixture.readTransportFacts()).reduce(
          (count, row) => count + row.forwardedTurns,
          0,
        ),
      ).toBe(5)
      await expect
        .poll(() => health(ctx), { timeout: 20_000 })
        .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
      expect((await health(ctx)).adapterSlots).toBeLessThanOrEqual(5)
      await expect.poll(() => composer.textContent()).toBe(draft)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real sequential Sessions bound Adapter retention',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-sequential-capacity')
    const observed: Array<{ sessionId: string; nativeSessionId: string; runId: string }> = []
    try {
      for (let index = 0; index < 10; index += 1) {
        const sessionId =
          // oxlint-disable-next-line no-await-in-loop -- Each new context follows settlement of the preceding one.
          index === 0 ? ctx.sessionId : await addRealSession(ctx, `Sequential ${index}`)
        // oxlint-disable-next-line no-await-in-loop -- Select the current newly created row before its one authorized Send.
        await selectRealSession(ctx, sessionId)
        const marker = `SEQUENTIAL_${index}_${randomUUID()}`
        // oxlint-disable-next-line no-await-in-loop -- Exactly one model request is authorized per fresh Session.
        await sendRealMessage(
          ctx,
          `Briefly acknowledge ${marker}. Do not use tools, read files or write files.`,
          'codex',
        )
        // oxlint-disable-next-line no-await-in-loop -- Complete the current model task before acquiring another Adapter.
        const completed = await waitForRealCompletion(ctx, 1, sessionId)
        expect(completed.runs).toHaveLength(1)
        expect(completed.runs[0]?.agentId).toBe('codex')
        expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
        const reply = answer(completed)
        expect(reply.content.trim().length).toBeGreaterThan(0)
        const run = completed.runs[0]!
        expect(run.nativeSessionId).toBeTruthy()
        expect(run.nativeTurnId).toBeTruthy()
        if (!run.nativeSessionId) throw new Error('Actual native Session identity is missing')
        // Resource retention is a Pact invariant, not a model transcription test.
        // Independently prove the one request and authentic completed answer.
        // oxlint-disable-next-line no-await-in-loop -- Observe this settled Native context before acquiring the next one.
        const native = await findNativeRecord(ctx, 'codex', run.nativeSessionId)
        expect(native.codexModelStarts).toBe(1)
        expect(native.containsText(marker)).toBe(true)
        expect(native.containsText(reply.content)).toBe(true)
        observed.push({ sessionId, nativeSessionId: run.nativeSessionId, runId: run.id })
        // oxlint-disable-next-line no-await-in-loop -- High-water ownership is checked after every acquisition, not only at the end.
        await expect
          .poll(() => health(ctx), { timeout: 20_000 })
          .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
        // oxlint-disable-next-line no-await-in-loop -- No next Session is created until current resource counts are observed.
        const idle = await health(ctx)
        expect(typeof idle.adapterSlots).toBe('number')
        expect(idle.adapterSlots).toBeLessThanOrEqual(5)
        // oxlint-disable-next-line no-await-in-loop -- The actual selected Session must show exactly its own completed reply.
        await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(1)
      }
      expect(observed).toHaveLength(10)
      expect(new Set(observed.map((item) => item.sessionId)).size).toBe(10)
      expect(new Set(observed.map((item) => item.nativeSessionId)).size).toBe(10)
      expect(new Set(observed.map((item) => item.runId)).size).toBe(10)
      await test.info().attach('real-sequential-ownership', {
        body: JSON.stringify({ sessions: observed, health: await health(ctx) }),
        contentType: 'application/json',
      })
    } finally {
      observed.length = 0
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real inactive Session streaming retains completion, unread and Selection',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-stream-interest')
    try {
      const readingId = await addRealSession(ctx, 'Reading Session')
      const marker = `STREAM_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const selectionMarker = `SELECT_${randomUUID()}`
      await installObservation(ctx)
      await sendRealMessage(
        ctx,
        `Begin with ${marker}_BEGIN. Then write 480 numbered lines, each containing a short original twelve-word sentence about typed software boundaries. Finish with ${marker}_END. Write the complete list without summarizing. Do not use tools, read files or write files. The reading-selection marker in this completed User Message is ${selectionMarker}; do not repeat that marker in your answer.`,
        'codex',
      )
      await expect
        .poll(async () => (await observation(ctx)).assistantTextBytes, {
          timeout: 180_000,
          intervals: [100, 250, 500],
        })
        .toBeGreaterThan(256)
      const started = await observation(ctx)
      expect(started.runId).toBeTruthy()
      expect(started.userMessageId).toBeTruthy()
      if (!started.runId || !started.userMessageId)
        throw new Error('Real streaming source identity is unavailable')
      await requireStreaming(ctx, started.runId)

      await selectRealSession(ctx, readingId)
      await observeSuppression(ctx, 'background', 1)
      await selectRealSession(ctx, ctx.sessionId)
      await setPhase(ctx, 'foreground')
      await requireStreaming(ctx, started.runId)
      const live = await liveIdentity(ctx)
      expect(live.runId).toBe(started.runId)
      expect(live.users).toBe(1)

      // The selected source is the actual accepted, complete User Message. No
      // synthetic completed history or second same-native task is introduced.
      const source = ctx.page.locator(`[data-pact-message-id="${started.userMessageId}"]`)
      await source.scrollIntoViewIfNeeded()
      const selectedTop = await source.evaluate((row, quote) => {
        const host = row.querySelector('[data-pact-message-content]')
        if (!host) throw new Error('Actual User Message source is not mounted')
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const offset = node.textContent?.indexOf(quote) ?? -1
          if (offset < 0) continue
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + quote.length)
          const selection = getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          return row.getBoundingClientRect().top
        }
        throw new Error('Accepted User Message quote is unavailable')
      }, selectionMarker)
      await expect
        .poll(() => ctx.page.evaluate(() => getSelection()?.toString()))
        .toBe(selectionMarker)
      await ctx.page.getByRole('button', { name: 'Settings', exact: true }).click()
      await observeSuppression(ctx, 'settings', 0)
      await ctx.page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await setPhase(ctx, 'foreground')
      await expect
        .poll(() => ctx.page.evaluate(() => getSelection()?.toString()))
        .toBe(selectionMarker)
      expect(
        Math.abs((await source.evaluate((row) => row.getBoundingClientRect().top)) - selectedTop),
      ).toBeLessThanOrEqual(2)
      await requireStreaming(ctx, started.runId)

      await ctx.app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.minimize()
      })
      await observeSuppression(ctx, 'minimized', 0)
      await ctx.app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.restore()
          window.show()
        }
      })
      await setPhase(ctx, 'foreground')
      await expect
        .poll(() => ctx.page.evaluate(() => getSelection()?.toString()))
        .toBe(selectionMarker)
      expect(
        Math.abs((await source.evaluate((row) => row.getBoundingClientRect().top)) - selectedTop),
      ).toBeLessThanOrEqual(2)
      await requireStreaming(ctx, started.runId)
      expect((await liveIdentity(ctx)).runId).toBe(started.runId)
      await expect(ctx.page.getByText(/Reading position changed/)).toHaveCount(0)

      await selectRealSession(ctx, readingId)
      await expect.poll(async () => (await health(ctx)).interestedSessions).toBe(1)
      await setPhase(ctx, 'background-completion')
      const completed = await waitForRealCompletion(ctx, 1)
      const completedAnswer = answer(completed)
      expect(completed.runs[0]?.id).toBe(started.runId)
      expect(completed.runs[0]?.nativeSessionId).toBeTruthy()
      expect(completed.runs[0]?.nativeTurnId).toBeTruthy()
      expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
      const native = await findNativeRecord(ctx, 'codex', completed.runs[0]!.nativeSessionId!)
      expect(
        native.containsText(completedAnswer.content),
        'Pact must retain the complete authentic Native answer, including its exact markers.',
      ).toBe(true)
      expect(completedAnswer.content).toContain(`${marker}_BEGIN`)
      expect(completedAnswer.content).toContain(`${marker}_END`)
      const expectedHash = createHash('sha256').update(completedAnswer.content).digest('hex')
      const expectedBytes = Buffer.byteLength(completedAnswer.content)
      expect(expectedBytes).toBeGreaterThan(1500)
      await expect.poll(() => unread(ctx)).toBe(true)
      const captured = await observation(ctx)
      for (const phase of [
        'background',
        'settings',
        'minimized',
        'background-completion',
      ] as const) {
        expect(captured.phases[phase].assistantChanges).toBe(0)
        expect(captured.phases[phase].bytes).toBeLessThan(backgroundBytes)
      }
      expect(captured.maxPatchBytes).toBeLessThanOrEqual(CONVERSATION_PATCH_BYTES)
      expect(captured.records.length).toBeLessThanOrEqual(observationItems)
      expect(captured.retainedBytes).toBeLessThanOrEqual(observationBytes)
      expect((await health(ctx)).completeReads).toBe(0)

      await selectRealSession(ctx, ctx.sessionId)
      await expect.poll(() => unread(ctx)).toBe(false)
      await expect(ctx.page.locator('article[data-pact-speaker="user"]')).toHaveCount(1)
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(1)
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toContainText(
        `${marker}_END`,
      )
      expect(await browserAnswer(ctx)).toMatchObject({
        runId: started.runId,
        hash: expectedHash,
        bytes: expectedBytes,
        users: 1,
        assistants: 1,
      })
      await test.info().attach('real-stream-interest', {
        body: JSON.stringify({
          captured,
          health: await health(ctx),
          answer: { bytes: expectedBytes, sha256: expectedHash },
        }),
        contentType: 'application/json',
      })
      await disposeObservation(ctx)
      await ctx.page.reload()
      await selectRealSession(ctx, ctx.sessionId)
      expect(await browserAnswer(ctx)).toMatchObject({
        runId: started.runId,
        hash: expectedHash,
        bytes: expectedBytes,
        users: 1,
        assistants: 1,
      })
      expect((await readRealConversation(ctx)).runs).toHaveLength(1)
      await expect
        .poll(() => health(ctx), { timeout: 20_000 })
        .toMatchObject({ activeExecutions: 0, preparingExecutions: 0 })
    } finally {
      try {
        await disposeObservation(ctx)
      } finally {
        await closeRealWorkspace(ctx)
      }
    }
  },
)

async function health(ctx: RealWorkspace): Promise<NonNullable<RuntimeHealth['conversation']>> {
  return ctx.page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const result = await bridge.getRuntimeHealth()
    if (!result.ok || !result.value.conversation)
      throw new Error('Actual runtime counters are unavailable')
    return result.value.conversation
  })
}

function answer(snapshot: ConversationSnapshot) {
  const replies = snapshot.messages.filter((message) => message.role === 'assistant')
  expect(replies).toHaveLength(1)
  expect(replies[0]?.state).toBe('complete')
  if (!replies[0]) throw new Error('Actual completed model reply is unavailable')
  return replies[0]
}

async function installObservation(ctx: RealWorkspace): Promise<void> {
  await ctx.page.evaluate(
    ({ key, sessionId, maxItems, maxBytes, maxPatchBytes, ttl }) => {
      if (Reflect.get(globalThis, key))
        throw new Error('Only one real stream observer may be owned')
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const emptyCounters: PhaseCounters = {
        patches: 0,
        bytes: 0,
        assistantChanges: 0,
        assistantTextBytes: 0,
      }
      const state: StreamObservation = {
        phase: 'foreground',
        assistantTextBytes: 0,
        maxPatchBytes: 0,
        retainedBytes: 0,
        records: [],
        phases: {
          foreground: { ...emptyCounters },
          background: { ...emptyCounters },
          settings: { ...emptyCounters },
          minimized: { ...emptyCounters },
          'background-completion': { ...emptyCounters },
        },
      }
      const encoder = new TextEncoder()
      const remove = bridge.onConversationChanged((patch) => {
        if (patch.sessionId !== sessionId || state.fault) return
        const bytes = encoder.encode(JSON.stringify(patch)).byteLength
        state.maxPatchBytes = Math.max(state.maxPatchBytes, bytes)
        if (bytes > maxPatchBytes) {
          state.fault = 'Actual IPC Patch exceeds the product byte budget'
          return
        }
        const runId = patch.latestRunId ?? patch.runs.at(-1)?.id
        if (runId) {
          if (state.runId && state.runId !== runId)
            state.fault = 'View navigation created an unexpected native task'
          state.runId = runId
        }
        const failed = patch.runs.find((run) => ['failed', 'interrupted'].includes(run.status))
        if (failed)
          state.fault = `Actual model task ended ${failed.status}; code=${failed.failureKind ?? 'none'}`
        const user = patch.messages.find((change) => change.message.role === 'user')
        if (user) state.userMessageId ??= user.message.id
        const assistantChanges = patch.messages.filter(
          (change) => change.message.role === 'assistant',
        )
        const textBytes = assistantChanges.reduce(
          (total, change) => total + encoder.encode(change.text ?? '').byteLength,
          0,
        )
        const counters = state.phases[state.phase]
        counters.patches++
        counters.bytes += bytes
        counters.assistantChanges += assistantChanges.length
        counters.assistantTextBytes += textBytes
        state.assistantTextBytes += textBytes
        const record = {
          phase: state.phase,
          sequence: patch.observation.sequence,
          bytes,
          assistantChanges: assistantChanges.length,
          assistantTextBytes: textBytes,
        }
        const size = encoder.encode(JSON.stringify(record)).byteLength
        while (state.records.length >= maxItems || state.retainedBytes + size > maxBytes) {
          const oldest = state.records.shift()
          if (!oldest) {
            state.fault = 'A stream observation summary exceeds its retention budget'
            return
          }
          state.retainedBytes -= encoder.encode(JSON.stringify(oldest)).byteLength
        }
        state.records.push(record)
        state.retainedBytes += size
      })
      const timer = setTimeout(() => {
        state.fault = 'Real stream evidence did not settle before its observation deadline'
        remove()
        state.records.length = 0
        state.retainedBytes = 0
      }, ttl)
      Reflect.set(globalThis, key, state)
      Reflect.set(globalThis, `${key}Dispose`, () => {
        clearTimeout(timer)
        remove()
        state.records.length = 0
        state.retainedBytes = 0
        Reflect.deleteProperty(globalThis, key)
        Reflect.deleteProperty(globalThis, `${key}Dispose`)
      })
    },
    {
      key: observationKey,
      sessionId: ctx.sessionId,
      maxItems: observationItems,
      maxBytes: observationBytes,
      maxPatchBytes: CONVERSATION_PATCH_BYTES,
      ttl: caseDeadlineMs,
    },
  )
}

async function observation(ctx: RealWorkspace): Promise<StreamObservation> {
  const result = await ctx.page.evaluate((key) => {
    const state: StreamObservation | undefined = Reflect.get(globalThis, key)
    if (!state) throw new Error('Owned real stream observer is unavailable')
    return state
  }, observationKey)
  if (result.fault) {
    const snapshot = await readRealConversation(ctx)
    const run = snapshot.runs.find((row) => row.id === result.runId) ?? snapshot.runs.at(-1)
    throw new Error(
      `${result.fault}; detail=${ctx.fixture.redactDiagnostic(run?.failureMessage ?? 'unavailable').slice(0, 2000)}`,
    )
  }
  return result
}

async function setPhase(ctx: RealWorkspace, phase: StreamPhase): Promise<void> {
  await ctx.page.evaluate(
    ({ key, nextPhase }) => {
      const state: StreamObservation | undefined = Reflect.get(globalThis, key)
      if (!state || state.fault) throw new Error('Owned stream observer cannot change phase')
      state.phase = nextPhase
    },
    { key: observationKey, nextPhase: phase },
  )
}

async function requireStreaming(ctx: RealWorkspace, runId: string): Promise<void> {
  expect((await observation(ctx)).runId).toBe(runId)
  expect(
    (await health(ctx)).activeExecutions,
    'The real model must provide enough live streaming evidence for every phase',
  ).toBe(1)
}

async function observeSuppression(
  ctx: RealWorkspace,
  phase: StreamPhase,
  interestedSessions: number,
): Promise<void> {
  await expect.poll(async () => (await health(ctx)).interestedSessions).toBe(interestedSessions)
  await setPhase(ctx, phase)
  const before = await health(ctx)
  expect(
    before.activeExecutions,
    'Insufficient real stream evidence is a failure, never a skip or a replacement response',
  ).toBe(1)
  await expect
    .poll(async () => (await health(ctx)).suppressedProgress, {
      timeout: 20_000,
      intervals: [100, 250, 500],
    })
    .toBeGreaterThan(before.suppressedProgress)
  const after = await health(ctx)
  expect(after.publishedProgress).toBe(before.publishedProgress)
  expect(after.completeReads).toBe(0)
  const captured = await observation(ctx)
  expect(captured.phases[phase].assistantChanges).toBe(0)
  expect(captured.phases[phase].bytes).toBeLessThan(backgroundBytes)
}

async function disposeObservation(ctx: RealWorkspace): Promise<void> {
  if (ctx.page.isClosed()) return
  await ctx.page.evaluate((key) => {
    const dispose: (() => void) | undefined = Reflect.get(globalThis, `${key}Dispose`)
    dispose?.()
  }, observationKey)
}

async function liveIdentity(
  ctx: RealWorkspace,
): Promise<{ runId: string | undefined; users: number }> {
  return ctx.page.evaluate(
    async ({ sessionId, maxBytes }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const result = await bridge.getConversation({ sessionId, scope: 'messages' })
      if (!result.ok || result.value.scope !== 'messages')
        throw new Error('Bounded actual Message page is unavailable')
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes)
        throw new Error('Actual Message page exceeds product budget')
      return {
        runId: result.value.header.latestRun?.id,
        users: result.value.messages.filter((entry) => entry.message.role === 'user').length,
      }
    },
    { sessionId: ctx.sessionId, maxBytes: CONVERSATION_PAGE_BYTES },
  )
}

async function unread(ctx: RealWorkspace): Promise<boolean> {
  return ctx.page.evaluate(
    async ({ projectId, sessionId }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const result = await bridge.getSessionCatalog(projectId)
      if (!result.ok) throw new Error('Actual Catalog is unavailable')
      const session = result.value.sessions.find((entry) => entry.id === sessionId)
      if (!session) throw new Error('Actual streaming Session is absent from its Catalog page')
      return session.hasUnread
    },
    { projectId: ctx.projectId, sessionId: ctx.sessionId },
  )
}

async function browserAnswer(ctx: RealWorkspace): Promise<{
  runId: string | undefined
  hash: string
  bytes: number
  users: number
  assistants: number
}> {
  return ctx.page.evaluate(
    async ({ sessionId, maxBytes }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const result = await bridge.getConversation({ sessionId, scope: 'messages' })
      if (!result.ok || result.value.scope !== 'messages')
        throw new Error('Actual completed Message page is unavailable')
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes)
        throw new Error('Actual Message page exceeds product budget')
      const replies = result.value.messages.filter((entry) => entry.message.role === 'assistant')
      const reply = replies[0]
      if (replies.length !== 1 || reply?.kind !== 'complete')
        throw new Error('Actual completed reply is not present in full')
      const body = new TextEncoder().encode(reply.message.content)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return {
        runId: result.value.header.latestRun?.id,
        hash,
        bytes: body.byteLength,
        users: result.value.messages.filter((entry) => entry.message.role === 'user').length,
        assistants: replies.length,
      }
    },
    { sessionId: ctx.sessionId, maxBytes: CONVERSATION_PAGE_BYTES },
  )
}
