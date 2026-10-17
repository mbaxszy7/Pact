import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { closeRealWorkspace } from './real-harness.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

async function seedSessions(fixture: RuntimeFixture, count: number): Promise<string[]> {
  const directory = await fixture.createProjectDirectory('agent-capacity')
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const sessionIds: string[] = []
  try {
    const projectId = randomUUID()
    database.projectCatalogRepository.add({
      id: projectId,
      name: 'Agent capacity',
      directoryPath: directory,
      kind: 'git',
      createdAt: '2026-09-28T00:00:00.000Z',
    })
    for (let index = 0; index < count; index += 1) {
      const sessionId = randomUUID()
      sessionIds.push(sessionId)
      database.sessionRepository.create(
        {
          id: sessionId,
          projectId,
          title: `Capacity Session ${index}`,
          createdAt: `2026-09-28T00:00:${String(index).padStart(2, '0')}.000Z`,
        },
        {
          primaryAgentId: 'codex',
          agents: {
            claude: { model: null, effort: null },
            codex: { model: null, effort: null },
          },
          maxDiscussionRounds: 6,
          runningMessagePolicy: 'immediate_safe_point',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
    }
  } finally {
    database.close()
  }
  return sessionIds
}

test(
  'five Sessions run while the sixth gets a warning and keeps its draft',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'shutdown_pending_delta' })
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const sessionIds = await seedSessions(fixture, 6)
      app = await fixture.launch()
      const window = await app.firstWindow()
      const accepted = await Promise.all(
        sessionIds.slice(0, 5).map((sessionId) =>
          window.evaluate((id) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.sendConversationMessage({
              sessionId: id,
              clientMessageId: crypto.randomUUID(),
              content: 'Keep this Run active.',
              expectedCommentsRevision: 0,
              commentIds: [],
            })
          }, sessionId),
        ),
      )
      expect(accepted.every((result) => result.ok)).toBe(true)
      await expect
        .poll(async () => {
          const health = await window.evaluate(() => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getRuntimeHealth()
          })
          return health.ok ? health.value.conversation?.activeExecutions : undefined
        })
        .toBe(5)

      await window.getByRole('button', { name: 'Capacity Session 5', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('The sixth request stays here')
      await window.getByRole('button', { name: 'Send message' }).click()
      await expect(window.locator('[data-pact-toast-tone="warning"]')).toContainText(
        'At most 5 Sessions can run Agents at once.',
      )
      await expect.poll(() => composer.textContent()).toBe('The sixth request stays here')
      await expect(window.locator('article[data-pact-speaker="user"]')).toHaveCount(0)
      const sixthPage = await window.evaluate((sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getConversation({
          scope: 'messages',
          sessionId,
        })
      }, sessionIds[5]!)
      expect(
        sixthPage.ok && sixthPage.value.scope === 'messages' && sixthPage.value.messages.length,
      ).toBe(0)
      const health = await window.evaluate(() => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getRuntimeHealth()
      })
      expect(health.ok && health.value.conversation).toMatchObject({
        activeExecutions: 5,
        preparingExecutions: 0,
        adapterSlots: 5,
      })
    } finally {
      if (app) await closeRealWorkspace({ app, fixture })
      else await fixture.dispose()
    }
  },
)

test('sequential Sessions keep at most five Adapter slots', { tag: '@deterministic' }, async () => {
  test.setTimeout(120_000)
  const fixture = await createRuntimeFixture({ codexAppServer: 'complete' })
  let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
  try {
    const sessionIds = await seedSessions(fixture, 10)
    app = await fixture.launch()
    const window = await app.firstWindow()
    for (const sessionId of sessionIds) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each completed Run releases its slot before the next request.
      const sent = await window.evaluate((id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.sendConversationMessage({
          sessionId: id,
          clientMessageId: crypto.randomUUID(),
          content: 'Complete this short Run.',
          expectedCommentsRevision: 0,
          commentIds: [],
        })
      }, sessionId)
      expect(sent.ok).toBe(true)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the current Run to settle before measuring idle retention.
      await expect
        .poll(async () => {
          const health = await window.evaluate(() => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getRuntimeHealth()
          })
          return health.ok ? health.value.conversation?.activeExecutions : undefined
        })
        .toBe(0)
      // oxlint-disable-next-line eslint/no-await-in-loop -- The high-water assertion belongs to each acquisition, not only the final state.
      const health = await window.evaluate(() => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getRuntimeHealth()
      })
      expect(health.ok && (health.value.conversation?.adapterSlots ?? 0) <= 5).toBe(true)
    }
  } finally {
    if (app) await quitPact(app)
    await fixture.dispose()
  }
})
