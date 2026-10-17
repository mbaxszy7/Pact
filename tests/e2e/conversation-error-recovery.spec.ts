import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { conversationMessages } from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const createdAt = '2026-09-28T00:00:00.000Z'
const assistantCreatedAt = '2026-09-28T01:23:45.000Z'

test(
  'a Message-row render fault leaves navigation and draft intact through one view remount',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const directory = await fixture.createProjectDirectory('conversation-render-fault')
      const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        const projectId = randomUUID()
        const sessionId = randomUUID()
        database.projectCatalogRepository.add({
          id: projectId,
          name: 'Render recovery',
          directoryPath: directory,
          kind: 'git',
          createdAt,
        })
        database.sessionRepository.create(
          { id: sessionId, projectId, title: 'Recoverable conversation', createdAt },
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
        database.drizzle
          .insert(conversationMessages)
          .values([
            {
              id: randomUUID(),
              sessionId,
              role: 'user' as const,
              content: 'Review the recovery flow.',
              state: 'complete' as const,
              sequence: 0,
              createdAt,
              updatedAt: createdAt,
            },
            {
              id: randomUUID(),
              sessionId,
              role: 'assistant' as const,
              agentId: 'codex' as const,
              content: 'Persisted answer after a display fault.',
              state: 'complete' as const,
              sequence: 1,
              createdAt: assistantCreatedAt,
              updatedAt: assistantCreatedAt,
            },
          ])
          .run()
      } finally {
        database.close()
      }

      app = await fixture.launch()
      const window = await app.firstWindow()
      const sessionButton = window.getByRole('button', {
        name: 'Recoverable conversation',
        exact: true,
      })
      await sessionButton.click()
      await expect(window.getByText('Persisted answer after a display fault.')).toBeVisible()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Keep this unsent draft')
      await window.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: Promise.resolve.bind(Promise) },
        })
      })
      // Establish the genuine action before arming the fault: hover renders the
      // timestamp too, so arming first can remove its target before hover settles.
      await window.locator('article[data-pact-speaker="codex"]').hover()
      await expect(window.getByRole('button', { name: 'Copy Codex message' })).toBeVisible()
      // The unique assistant timestamp is read while its Message actions render.
      // Throw repeatedly because React may retry a concurrent render before
      // reaching the boundary; no production test hook or durable data is changed.
      await window.evaluate((timestamp) => {
        const NativeDate = Date
        Reflect.set(globalThis, 'pactRenderFaults', 8)
        Reflect.set(
          globalThis,
          'Date',
          new Proxy(NativeDate, {
            construct(target, argumentsList, newTarget) {
              const remaining = Number(Reflect.get(globalThis, 'pactRenderFaults'))
              if (argumentsList[0] === timestamp && remaining > 0) {
                Reflect.set(globalThis, 'pactRenderFaults', remaining - 1)
                throw new Error('Fixture-only render fault; never show raw error text')
              }
              return Reflect.construct(target, argumentsList, newTarget)
            },
          }),
        )
      }, assistantCreatedAt)
      await window.getByRole('button', { name: 'Copy Codex message' }).click()

      await expect(window.locator('[data-pact-conversation-recovery]')).toBeVisible()
      await expect(sessionButton).toBeVisible()
      await expect(
        window.getByText('Fixture-only render fault; never show raw error text'),
      ).toHaveCount(0)
      await window.evaluate(() => Reflect.set(globalThis, 'pactRenderFaults', 0))
      await window.getByRole('button', { name: 'Try again' }).click()

      await expect(window.getByText('Persisted answer after a display fault.')).toBeVisible()
      await expect.poll(() => composer.textContent()).toBe('Keep this unsent draft')
      await expect(window.locator('[data-pact-conversation-recovery]')).toHaveCount(0)
      await expect(window.locator('article[data-pact-speaker="user"]')).toHaveCount(1)
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)
