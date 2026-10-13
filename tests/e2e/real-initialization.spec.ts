import { expect } from '@playwright/test'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord, readNativeEvidence } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

test(
  'real unconfirmed Fork keeps the committed child locked and resumes the same candidate once after restart',
  { tag: '@real' },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-fork-initialization', {
      transportFault: 'hold-initialization',
    })
    try {
      await ctx.fixture.controlTransportFault('release')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${authMarker('SOURCE')}. Do not use tools.`,
        'all',
      )
      const source = await waitForRealCompletion(ctx, 2)
      const sourceHashes = await Promise.all(
        source.nativeContexts.map((binding) =>
          findNativeRecord(ctx, binding.agentId, binding.nativeSessionId),
        ),
      )
      const reply = source.messages.findLast((row) => row.role === 'assistant')
      if (!reply) throw new Error('Actual source reply unavailable')
      await ctx.page.getByRole('combobox', { name: 'Message' }).fill('Preserve my source draft')
      await ctx.fixture.controlTransportFault('arm')
      const article = ctx.page.locator(`[data-pact-message-id="${reply.id}"]`)
      await article.hover()
      await article.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      await ctx.page
        .getByRole('dialog')
        .getByRole('button', { name: 'Create fork', exact: true })
        .click()
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).some(
              (row) => row.candidateNativeSessionId && row.faultPhase === 'held-after-native',
            ),
          { timeout: 120_000 },
        )
        .toBe(true)
      await expect(ctx.page.getByRole('dialog')).toHaveCount(0, { timeout: 90_000 })
      const childId = await childSession(ctx)
      const child = await readRealConversation(ctx, childId)
      expect(child.forkOperation?.ready).toBe(false)
      expect(child.messages.map((row) => row.content)).toEqual(
        source.messages.map((row) => row.content),
      )
      const candidate = child.forkOperation?.sides.find(
        (side) => side.agentId === 'codex',
      )?.nativeSessionId
      if (!candidate) throw new Error('Actual unconfirmed Fork candidate unavailable')
      expect(child.forkOperation?.sides.find((side) => side.agentId === 'claude')?.state).toBe(
        'ready',
      )
      await selectRealSession(ctx, childId)
      await expect(ctx.page.getByRole('region', { name: 'Native fork confirmation' })).toBeVisible()
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      const turns = await forwarded(ctx)
      expect(turns).toBe(1)
      const forks = await methods(ctx, 'thread/fork')
      expect(forks).toBe(1)
      await selectRealSession(ctx, ctx.sessionId)
      await expect
        .poll(() => ctx.page.getByRole('combobox', { name: 'Message' }).textContent())
        .toBe('Preserve my source draft')
      await selectRealSession(ctx, childId)
      await ctx.fixture.controlTransportFault('release')
      await ctx.app.close()
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, childId)
      await expect(ctx.page.getByRole('region', { name: 'Native fork confirmation' })).toBeVisible()
      const checked = await ctx.page.evaluate(
        async (input) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.forkSession(input)
        },
        {
          action: 'check' as const,
          sessionId: childId,
          operationId: child.forkOperation!.id,
          agentId: 'codex' as const,
        },
      )
      expect(checked.ok).toBe(true)
      const checkedState = await readRealConversation(ctx, childId)
      expect(
        checkedState.forkOperation?.sides.find((side) => side.agentId === 'codex')?.nativeSessionId,
      ).toBe(candidate)
      if (!checkedState.forkOperation?.ready) {
        await ctx.page.getByRole('button', { name: 'Continue initialization', exact: true }).click()
      }
      await expect(ctx.page.getByRole('region', { name: 'Native fork confirmation' })).toHaveCount(
        0,
        { timeout: 120_000 },
      )
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      const ready = await readRealConversation(ctx, childId)
      expect(ready.forkOperation?.ready).toBe(true)
      expect(
        ready.forkOperation?.sides.find((side) => side.agentId === 'codex')?.nativeSessionId,
      ).toBe(candidate)
      expect(await methods(ctx, 'thread/fork')).toBe(forks)
      expect(await forwarded(ctx)).toBe(turns)
      expect(ready.runs.map((row) => row.id)).toEqual(child.runs.map((row) => row.id))
      await selectRealSession(ctx, ctx.sessionId)
      const afterHashes = await Promise.all(
        source.nativeContexts.map((binding) =>
          findNativeRecord(ctx, binding.agentId, binding.nativeSessionId),
        ),
      )
      expect(afterHashes.map((row) => row.sha256)).toEqual(sourceHashes.map((row) => row.sha256))
    } catch (error) {
      await recordWindowsInitialization(
        ctx,
        'fork',
        await childSession(ctx).catch(() => ctx.sessionId),
      )
      throw error
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real unconfirmed rebuild checks its actual candidate before one confirmed replacement and never replays',
  { tag: '@real' },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-rebuild-initialization', {
      transportFault: 'hold-initialization',
    })
    try {
      await ctx.fixture.controlTransportFault('release')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${authMarker('REBUILD_SOURCE')}. Do not use tools.`,
        'codex',
      )
      const source = await waitForRealCompletion(ctx, 1)
      const old = source.nativeContexts.find((row) => row.agentId === 'codex')!
      const evidence = await findNativeRecord(ctx, 'codex', old.nativeSessionId)
      await ctx.app.close()
      const backup = join(ctx.fixture.directory, 'native-backup')
      await mkdir(backup, { mode: 0o700 })
      await rename(evidence.path, join(backup, 'source.jsonl'))
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, ctx.sessionId)
      await ctx.page
        .getByRole('combobox', { name: 'Message' })
        .fill('Preserve this unsubmitted draft')
      const inspection = await ctx.page.evaluate(
        async ({ sessionId, runId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.retryConversationRun(runId, {
            sessionId,
            agentId: 'codex',
            intent: 'inspect',
          })
        },
        { sessionId: ctx.sessionId, runId: source.runs[0]!.id },
      )
      expect(inspection).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      await ctx.fixture.controlTransportFault('arm')
      await ctx.page.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await ctx.page.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).some(
              (row) => row.candidateNativeSessionId && row.faultPhase === 'held-after-native',
            ),
          { timeout: 120_000 },
        )
        .toBe(true)
      await expect(
        ctx.page.getByText('Pact couldn’t confirm the new session.', { exact: true }),
      ).toBeVisible({ timeout: 90_000 })
      const unconfirmed = await readRealConversation(ctx)
      const pending = unconfirmed.rebuildOperations?.find(
        (row) => row.agentId === 'codex',
      )?.operation
      if (!pending?.provisionalNativeSessionId)
        throw new Error('Actual unconfirmed rebuild candidate unavailable')
      expect(pending.stage).toBe('unconfirmed')
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      await expect
        .poll(() => ctx.page.getByRole('combobox', { name: 'Message' }).textContent())
        .toBe('Preserve this unsubmitted draft')
      await ctx.fixture.controlTransportFault('release')
      await ctx.app.close()
      const candidate = await findNativeRecord(ctx, 'codex', pending.provisionalNativeSessionId)
      await rename(candidate.path, join(backup, 'candidate.jsonl'))
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, ctx.sessionId)
      await ctx.page
        .getByRole('region', { name: 'Session recovery' })
        .getByRole('button', { name: 'Retry', exact: true })
        .click()
      await expect(ctx.page.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
        timeout: 45_000,
      })
      const before = await methods(ctx, 'thread/start')
      await ctx.page.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await expect(
        ctx.page.getByText('The previous attempt may already have created a session.', {
          exact: true,
        }),
      ).toBeVisible()
      expect(await methods(ctx, 'thread/start')).toBe(before)
      await ctx.page.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(ctx.page.getByText('Codex native session rebuilt', { exact: true })).toBeVisible(
        { timeout: 120_000 },
      )
      expect(await methods(ctx, 'thread/start')).toBe(before + 1)
      expect(await forwarded(ctx)).toBe(1)
      const ready = await readRealConversation(ctx)
      expect(ready.runs.map((row) => row.id)).toEqual(source.runs.map((row) => row.id))
      expect(ready.nativeContexts.find((row) => row.agentId === 'codex')?.nativeSessionId).not.toBe(
        pending.provisionalNativeSessionId,
      )
      expect(
        ready.messages.filter((row) => row.role !== 'system').map((row) => row.content),
      ).toEqual(source.messages.filter((row) => row.role !== 'system').map((row) => row.content))
      expect((await readNativeEvidence(join(backup, 'source.jsonl'))).sha256).toBe(evidence.sha256)
    } catch (error) {
      await recordWindowsInitialization(ctx, 'rebuild', ctx.sessionId)
      throw error
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

async function recordWindowsInitialization(
  ctx: RealWorkspace,
  name: string,
  sessionId: string,
): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const snapshot = await readRealConversation(ctx, sessionId)
    const data = ctx.fixture.redactDiagnostic(
      JSON.stringify({
        fork: snapshot.forkOperation,
        rebuild: snapshot.rebuildOperations,
        nativeContexts: snapshot.nativeContexts,
        transport: await ctx.fixture.readTransportFacts(),
      }),
    )
    if (Buffer.byteLength(data) > 256 * 1024)
      throw new Error('Initialization diagnostic exceeds 256 KiB')
    const path = test.info().outputPath(`windows-${name}-initialization.json`)
    await writeFile(path, data)
    await test
      .info()
      .attach(`windows-${name}-initialization`, { path, contentType: 'application/json' })
  } catch {
    // Diagnostics must not replace the original assertion or delay owned cleanup.
  }
}

async function childSession(ctx: RealWorkspace): Promise<string> {
  return ctx.page.evaluate(
    async ({ projectId, sourceSessionId }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const catalog = await bridge.getSessionCatalog(projectId)
      if (!catalog.ok || catalog.value.sessions.length !== 2)
        throw new Error('Expected exactly one committed Fork')
      const child = catalog.value.sessions.find((row) => row.id !== sourceSessionId)
      if (!child) throw new Error('Committed Fork unavailable')
      return child.id
    },
    { projectId: ctx.projectId, sourceSessionId: ctx.sessionId },
  )
}
async function forwarded(ctx: RealWorkspace): Promise<number> {
  return (await ctx.fixture.readTransportFacts()).reduce((n, row) => n + row.forwardedTurns, 0)
}
async function methods(ctx: RealWorkspace, method: string): Promise<number> {
  return (await ctx.fixture.readTransportFacts()).reduce(
    (n, row) =>
      n +
      row.entries.filter((entry) => entry.kind === 'stdin-forwarded' && entry.method === method)
        .length,
    0,
  )
}
