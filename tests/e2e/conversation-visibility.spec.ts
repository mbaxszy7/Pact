import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { IPC_CHANNELS } from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

async function seed(fixture: RuntimeFixture, history = 1, largeDetail = false) {
  const db = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  const sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = new Date().toISOString()
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Visibility',
      directoryPath: await fixture.createProjectDirectory('visibility'),
      kind: 'git',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Visible Session', createdAt },
      {
        primaryAgentId: 'codex',
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        runningMessagePolicy: 'immediate_safe_point',
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    db.sessionRepository.rename(sessionId, 'Visible Session')
    for (let index = 0; index < history; index++) {
      const current = db.conversationRepository.readPage({ scope: 'messages', sessionId })
      if (current.scope !== 'messages') throw new Error('Unexpected seed scope')
      const run = db.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: `Original request ${index}`,
        expectedCommentsRevision: current.header.commentsRevision,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      }).run
      const text = `History answer ${index} keeps the selected excerpt intact.\n\nThis paragraph stays at the same reading position.\n\nOriginal durable content.`
      if (largeDetail)
        db.conversationRepository.applyEvent(sessionId, run.id, {
          agentId: 'codex',
          type: 'reasoning.summary.completed',
          turnId: `seed-${index}`,
          activityId: 'large-detail',
          text: 'Saved reasoning\n'.repeat(10_000),
        })
      db.conversationRepository.applyEvent(sessionId, run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: `seed-${index}`,
        outputId: 'seed',
        text,
      })
      db.conversationRepository.applyEvent(sessionId, run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: `seed-${index}`,
        outcome: 'completed',
      })
    }
    return sessionId
  } finally {
    db.close()
  }
}

test(
  'manual historical work log stays open through another Run progress and Collapse resumes live steps',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'background_stream' })
    await seed(fixture, 1, true)
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Visible Session', exact: true }).click()
      await window
        .getByRole('combobox', { name: 'Message', exact: true })
        .fill('Inspect the next task while reading earlier work.')
      await window.getByRole('combobox', { name: 'Message', exact: true }).press('Enter')
      await expect(
        window.getByRole('button', { name: 'Working · 1 step', exact: true }),
      ).toBeVisible()
      await window.getByRole('button', { name: 'Show work log', exact: true }).click()
      const historical = window.getByRole('button', { name: 'Work log · 1 step', exact: true })
      await expect(historical).toHaveAttribute('aria-expanded', 'true')
      const published = () =>
        window.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const result = await bridge.getRuntimeHealth()
          if (!result.ok || !result.value.conversation) throw new Error('Missing diagnostics')
          return result.value.conversation.publishedProgress
        })
      const before = await published()
      await expect.poll(published).toBeGreaterThan(before)
      await expect(historical).toHaveAttribute('aria-expanded', 'true')
      await window.getByRole('button', { name: 'Collapse work log', exact: true }).click()
      await expect(
        window.getByRole('button', { name: 'Working · 1 step', exact: true }),
      ).toBeVisible()
      await expect(window.getByText('Background result complete.', { exact: true })).toBeVisible()
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

test(
  'Settings and minimization pause progress without losing reading position or Selection',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'background_stream' })
    const sessionId = await seed(fixture, 10)
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Visible Session', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('Keep the same Run while hiding its view.')
      await composer.press('Enter')
      await expect(
        window.getByRole('button', { name: 'Working · 1 step', exact: true }),
      ).toBeVisible()
      const startedRun = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getConversation({ scope: 'messages', sessionId: id })
        if (!result.ok || result.value.scope !== 'messages') throw new Error('Page unavailable')
        return result.value.header.latestRun?.id
      }, sessionId)
      const target = window.getByText('History answer 8 keeps the selected excerpt intact.', {
        exact: true,
      })
      await target.scrollIntoViewIfNeeded()
      const originalTop = await target.evaluate((element) => {
        const host = element.closest('[data-pact-message-content]')
        const span = [
          ...(host?.querySelectorAll<HTMLElement>('[data-pact-projection-start]') ?? []),
        ].find((node) => node.textContent?.includes('selected excerpt'))
        const node = span?.firstChild
        if (!node) throw new Error('Projection span unavailable')
        const offset = node.textContent?.indexOf('selected excerpt') ?? -1
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 'selected excerpt'.length)
        const selection = globalThis.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return element.closest('[data-pact-message-id]')?.getBoundingClientRect().top
      })
      const health = () =>
        window.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
            result = await bridge.getRuntimeHealth()
          if (!result.ok || !result.value.conversation) throw new Error('Diagnostics unavailable')
          return result.value.conversation
        })
      await window.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect.poll(async () => (await health()).interestedSessions).toBe(0)
      const hidden = await health()
      await expect
        .poll(async () => (await health()).suppressedProgress)
        .toBeGreaterThan(hidden.suppressedProgress)
      expect((await health()).publishedProgress).toBe(hidden.publishedProgress)
      await window.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect
        .poll(() => window.evaluate(() => globalThis.getSelection()?.toString()))
        .toBe('selected excerpt')
      expect(
        Math.abs(
          (await target.evaluate(
            (element) => element.closest('[data-pact-message-id]')?.getBoundingClientRect().top,
          ))! - originalTop!,
        ),
      ).toBeLessThanOrEqual(2)
      await app.evaluate(({ BrowserWindow }) => {
        for (const nativeWindow of BrowserWindow.getAllWindows()) nativeWindow.minimize()
      })
      await expect.poll(async () => (await health()).interestedSessions).toBe(0)
      const minimized = await health()
      await expect
        .poll(async () => (await health()).suppressedProgress)
        .toBeGreaterThan(minimized.suppressedProgress)
      expect((await health()).publishedProgress).toBe(minimized.publishedProgress)
      await app.evaluate(({ BrowserWindow }) => {
        for (const nativeWindow of BrowserWindow.getAllWindows()) {
          nativeWindow.restore()
          nativeWindow.show()
        }
      })
      await expect
        .poll(() => window.evaluate(() => globalThis.getSelection()?.toString()))
        .toBe('selected excerpt')
      await expect(window.getByText('Background result complete.', { exact: true })).toHaveCount(1)
      expect((await health()).completeReads).toBe(0)
      const persisted = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getConversation({ scope: 'messages', sessionId: id })
        if (!result.ok || result.value.scope !== 'messages') throw new Error('Page unavailable')
        return {
          users: result.value.messages.filter((item) => item.message.role === 'user').length,
          run: result.value.header.latestRun?.id,
        }
      }, sessionId)
      expect(persisted.users).toBe(11)
      expect(persisted.run).toBe(startedRun)
      await expect(window.getByText(/Reading position changed/)).toHaveCount(0)
      const composerBefore = await composer.boundingBox()
      await window.evaluate(() => {
        const input = document.querySelector('textarea[aria-label="Message"]')
        for (let node = input?.parentElement; node; node = node.parentElement)
          if (getComputedStyle(node).overflowY === 'auto') node.scrollTop = node.scrollHeight
      })
      expect((await composer.boundingBox())?.y).toBe(composerBefore?.y)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

test(
  'read Retry never resends and hidden detail cancellation permits another expansion',
  { tag: '@real' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real' })
    await seed(fixture, 1, true)
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Visible Session', exact: true }).click()
      await window.getByRole('button', { name: 'Show work log', exact: true }).click()
      await expect(window.getByRole('button', { name: 'Load more', exact: true })).toBeVisible()
      await app.evaluate(({ ipcMain }, channel) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers')
        if (!(handlers instanceof Map)) throw new Error('Native fault-injection seam unavailable')
        const original = handlers.get(channel)
        let bodyDelay = true,
          readFailures = 0
        Reflect.set(globalThis, 'failNextMessageReads', () => {
          // Manual reading protects an around anchor; fail that read and its
          // existing one-shot latest fallback to exercise the explicit Retry.
          readFailures = 2
        })
        handlers.set(channel, async (event: unknown, input: { scope: string }) => {
          if (input.scope === 'messages' && readFailures > 0) {
            readFailures--
            return {
              ok: false,
              error: { code: 'VALIDATION', message: 'Messages could not refresh.' },
            }
          }
          if (input.scope === 'activity-body' && bodyDelay) {
            bodyDelay = false
            await new Promise((done) => setTimeout(done, 500))
          }
          return original(event, input)
        })
      }, IPC_CHANNELS.conversationGet)
      await window.getByRole('button', { name: 'Load more', exact: true }).click()
      await expect(window.getByRole('button', { name: 'Loading…', exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Settings', exact: true }).click()
      await window.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(window.getByRole('button', { name: 'Load more', exact: true })).toBeEnabled()
      await window.getByRole('button', { name: 'Load more', exact: true }).click()
      await expect(window.getByLabel('Full work log detail')).toBeVisible()
      await app.evaluate(() => Reflect.get(globalThis, 'failNextMessageReads')())
      await window.getByRole('button', { name: 'Settings', exact: true }).click()
      await window.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(
        window.getByRole('button', { name: 'Retry loading messages', exact: true }),
      ).toBeVisible()
      await window.getByRole('button', { name: 'Retry loading messages', exact: true }).click()
      await expect(
        window.getByRole('button', { name: 'Retry loading messages', exact: true }),
      ).toHaveCount(0)
      await expect(window.getByLabel('Full work log detail')).toBeVisible()
      await expect(window.locator('[data-pact-speaker="user"]')).toHaveCount(1)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)
