import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test(
  'suppresses inactive Session progress upstream while retaining completion, unread and latest content',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'background_stream' })
    const projectId = randomUUID(),
      a = randomUUID(),
      b = randomUUID(),
      createdAt = new Date().toISOString()
    const directory = await fixture.createProjectDirectory('interest-performance')
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    try {
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Interest performance',
        directoryPath: directory,
        kind: 'git',
        createdAt,
      })
      const settings = {
        primaryAgentId: 'codex' as const,
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }
      for (const [id, title] of [
        [a, 'Streaming A'],
        [b, 'Reading B'],
      ] as const) {
        db.sessionRepository.create({ id, projectId, title, createdAt }, settings)
        db.sessionRepository.rename(id, title)
      }
    } finally {
      db.close()
    }
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      const health = () =>
        window.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const result = await bridge.getRuntimeHealth()
          if (!result.ok || !result.value.conversation) throw new Error('Diagnostics missing')
          return result.value.conversation
        })
      await window.getByRole('button', { name: 'Streaming A', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('Foreground fixture')
      await composer.press('Enter')
      await expect(window.getByText('Background result complete.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      const foreground = await health()
      expect(foreground.publishedProgress).toBeGreaterThan(1)
      expect(foreground.suppressedProgress).toBe(0)
      await composer.fill('Background fixture')
      await composer.press('Enter')
      await expect(window.locator('[data-pact-speaker="codex"]')).toHaveCount(2)
      await window.getByRole('button', { name: 'Reading B', exact: true }).click()
      await expect(window.getByRole('heading', { name: 'Reading B', exact: true })).toBeVisible()
      await expect(composer).toBeEnabled()
      await window.evaluate((id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const counters = { bodyPatches: 0, bytes: 0 }
        Reflect.set(globalThis, 'backgroundCounters', counters)
        Reflect.set(
          globalThis,
          'removeBackgroundListener',
          bridge.onConversationChanged((patch) => {
            if (patch.sessionId !== id) return
            counters.bytes += new TextEncoder().encode(JSON.stringify(patch)).byteLength
            if (patch.messages.some((change) => change.message.role === 'assistant'))
              counters.bodyPatches++
          }),
        )
      }, a)
      const beforeBackground = await health()
      await expect
        .poll(
          async () =>
            window.evaluate(
              async ({ requestedProjectId, requestedSessionId }) => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
                  result = await bridge.getSessionCatalog(requestedProjectId)
                return result.ok
                  ? result.value.sessions.find((session) => session.id === requestedSessionId)
                      ?.hasUnread
                  : false
              },
              { requestedProjectId: projectId, requestedSessionId: a },
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
      const background = await health()
      expect(background.suppressedProgress).toBeGreaterThan(beforeBackground.suppressedProgress)
      expect(background.publishedProgress).toBe(beforeBackground.publishedProgress)
      expect(background.completeReads).toBe(0)
      const counters = await window.evaluate(() => Reflect.get(globalThis, 'backgroundCounters'))
      expect(counters.bodyPatches).toBe(0)
      expect(counters.bytes).toBeLessThan(8 * 1024)
      await test.info().attach('interest-counters', {
        body: JSON.stringify({ foreground, beforeBackground, background, counters }),
        contentType: 'application/json',
      })
      await window.getByRole('button', { name: 'Streaming A', exact: true }).click()
      await expect(window.getByText('Background result complete.', { exact: true })).toHaveCount(2)
      await expect(window.getByText(/Part 60 saved/)).toHaveCount(2)
      await expect
        .poll(async () =>
          window.evaluate(
            async ({ requestedProjectId, requestedSessionId }) => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
                result = await bridge.getSessionCatalog(requestedProjectId)
              return result.ok
                ? result.value.sessions.find((session) => session.id === requestedSessionId)
                    ?.hasUnread
                : true
            },
            { requestedProjectId: projectId, requestedSessionId: a },
          ),
        )
        .toBe(false)
      await app.evaluate(({ webContents }) => {
        for (const contents of webContents.getAllWebContents())
          if (!contents.isDestroyed() && contents.getURL().startsWith('app://bundle'))
            contents.reload()
      })
      await expect(window.getByRole('button', { name: 'Streaming A', exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Streaming A', exact: true }).click()
      await expect(window.getByText('Background result complete.', { exact: true })).toHaveCount(2)
      await composer.fill('Return while still responding')
      await composer.press('Enter')
      const activeReply = window.locator('[data-pact-speaker="codex"]').last()
      await expect(
        activeReply.getByText('Reviewing current request.', { exact: true }),
      ).toBeVisible()
      const activeRunId = await window.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getConversation({ sessionId, scope: 'messages' })
        return result.ok && result.value.scope === 'messages'
          ? result.value.header.latestRun?.id
          : undefined
      }, a)
      await window.getByRole('button', { name: 'Reading B', exact: true }).click()
      const beforeReturn = await health()
      await expect
        .poll(async () => (await health()).suppressedProgress)
        .toBeGreaterThan(beforeReturn.suppressedProgress)
      await window.getByRole('button', { name: 'Streaming A', exact: true }).click()
      await expect(
        activeReply.getByText('Reviewing current request.', { exact: true }),
      ).toBeVisible()
      await expect(activeReply.getByText(/Part 1 saved/)).toBeVisible()
      await expect(activeReply.getByRole('button', { name: /Working ·/ })).toBeVisible()
      await expect(window.getByText(/getting oriented/)).toHaveCount(0)
      const resumedRunId = await window.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getConversation({ sessionId, scope: 'messages' })
        return result.ok && result.value.scope === 'messages'
          ? result.value.header.latestRun?.id
          : undefined
      }, a)
      expect(resumedRunId).toBe(activeRunId)
      await expect(window.locator('[data-pact-speaker="user"]')).toHaveCount(3)
      await expect(window.getByText('Background result complete.', { exact: true })).toHaveCount(3)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
