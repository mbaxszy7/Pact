import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  agentRunActivities,
  agentRuns,
  conversationMessages,
} from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const createdAt = '2026-09-25T00:00:00.000Z'
const assistantContent =
  'Here is the answer.\n\nThe Catalog keeps Session history durable while showing five recent entries.'

test(
  'keeps message actions with their bubble and collapses a long Work log from its foot',
  { tag: '@ui' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture()
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const projectDirectory = await fixture.createProjectDirectory('message-actions')
      const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        const projectId = randomUUID()
        const sessionId = randomUUID()
        const userMessageId = randomUUID()
        const runId = randomUUID()
        database.projectCatalogRepository.add({
          id: projectId,
          name: 'Message actions',
          directoryPath: projectDirectory,
          kind: 'git',
          createdAt,
        })
        database.sessionRepository.create(
          { id: sessionId, projectId, title: 'Message actions preview', createdAt },
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
          .values({
            id: userMessageId,
            sessionId,
            role: 'user',
            content: 'Explain the Catalog change.',
            state: 'complete',
            sequence: 0,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        database.drizzle
          .insert(agentRuns)
          .values({
            id: runId,
            sessionId,
            userMessageId,
            agentId: 'codex',
            status: 'completed',
            attemptCount: 1,
            settingsRevision: 1,
            model: 'gpt-6-sol',
            effort: 'high',
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        database.drizzle
          .insert(conversationMessages)
          .values({
            id: randomUUID(),
            sessionId,
            runId,
            role: 'assistant',
            agentId: 'codex',
            content: assistantContent,
            state: 'complete',
            sequence: 1,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        for (let index = 0; index < 50; index += 1) {
          database.drizzle
            .insert(agentRunActivities)
            .values({
              id: randomUUID(),
              sessionId,
              runId,
              agentId: 'codex',
              nativeId: `step-${index}`,
              kind: index % 2 === 0 ? 'reasoning' : 'tool',
              title: index % 2 === 0 ? 'Reasoning' : 'Ran a command',
              detail: `Step ${index + 1}: inspected the Catalog.\n`.repeat(9),
              status: 'completed',
              sequence: index,
              createdAt,
              updatedAt: createdAt,
            })
            .run()
        }
      } finally {
        database.close()
      }

      app = await fixture.launch()
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Message actions preview', exact: true }).click()
      const user = window.locator('article[data-pact-speaker="user"]')
      const assistant = window.locator('article[data-pact-speaker="codex"]')
      const userActions = user.locator('[data-pact-message-actions]')
      const assistantActions = assistant.locator('[data-pact-message-actions]')
      await expect(userActions).toHaveCSS('opacity', '0')
      await user.hover()
      await expect(userActions).toHaveCSS('opacity', '1')
      await expect(userActions.locator('time')).toHaveAttribute('datetime', createdAt)
      const userBubble = await user.locator('[data-pact-message-bubble]').boundingBox()
      const userActionsBox = await userActions.boundingBox()
      const userCopyBox = await user.getByRole('button', { name: 'Copy You message' }).boundingBox()
      const assistantBubble = await assistant.locator('[data-pact-message-bubble]').boundingBox()
      if (!userBubble || !userActionsBox || !userCopyBox || !assistantBubble) {
        throw new Error('Message geometry is unavailable.')
      }
      expect(
        Math.abs(userActionsBox.x + userActionsBox.width - userBubble.x - userBubble.width),
      ).toBeLessThan(1)
      expect(userCopyBox.y - userBubble.y - userBubble.height).toBeGreaterThanOrEqual(4)
      expect(assistantBubble.y - userCopyBox.y - userCopyBox.height).toBeGreaterThanOrEqual(8)

      await window.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              Reflect.set(globalThis, 'copiedMessageText', text)
            },
          },
        })
      })
      await assistant.hover()
      await expect(assistantActions).toHaveCSS('opacity', '1')
      const assistantBubbleBox = await assistant.locator('[data-pact-message-bubble]').boundingBox()
      const assistantActionsBox = await assistantActions.boundingBox()
      if (!assistantBubbleBox || !assistantActionsBox) {
        throw new Error('Assistant message geometry is unavailable.')
      }
      expect(Math.abs(assistantActionsBox.x - assistantBubbleBox.x)).toBeLessThan(1)
      await assistant.getByRole('button', { name: 'Copy Codex message' }).click()
      await expect
        .poll(async () => window.evaluate(() => Reflect.get(globalThis, 'copiedMessageText')))
        .toBe(assistantContent)

      await window.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      await assistant.hover()
      await expect(assistantActions).toHaveCSS('opacity', '1')
      await window.mouse.move(1_000, 650)
      await window.waitForTimeout(100)
      await expect(assistantActions).toHaveCSS('opacity', '1')
      await expect(assistantActions).toHaveCSS('opacity', '0', { timeout: 1_000 })

      await assistant
        .locator('[data-pact-message-content]')
        .dispatchEvent('mousedown', { button: 0 })
      await window.evaluate(() => {
        const text = document.querySelector(
          'article[data-pact-speaker="codex"] [data-pact-projection-start]',
        )?.firstChild
        if (!text) throw new Error('Message text is unavailable.')
        const range = document.createRange()
        range.selectNodeContents(text)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      const addComment = assistant.getByRole('button', { name: 'Comment on selected text' })
      await expect(addComment).toBeVisible()
      await expect(addComment.locator('svg')).toHaveCSS('width', '16px')
      await expect(addComment.locator('svg')).toHaveCSS('height', '16px')
      await window.evaluate(() => getSelection()?.removeAllRanges())

      await window.getByRole('button', { name: 'Show work log' }).click()
      const workLog = window.getByRole('button', { name: 'Work log · 50 steps' })
      await expect(workLog).toHaveAttribute('aria-expanded', 'true')
      await expect(window.locator('.agent-activity-reveal li')).toHaveCount(50)
      const collapse = window.getByRole('button', { name: 'Collapse work log' })
      await expect(collapse).toBeVisible()
      await collapse.scrollIntoViewIfNeeded()
      await expect(collapse).toBeInViewport()
      const headerBounds = await workLog.boundingBox()
      const footerBounds = await collapse.boundingBox()
      if (!headerBounds || !footerBounds) throw new Error('Work log controls are unavailable.')
      expect(footerBounds.y).toBeGreaterThan(headerBounds.y)
      await collapse.click()
      await expect(workLog).toHaveAttribute('aria-expanded', 'false')
      await expect(collapse).toHaveCount(0)
      await expect(window.locator('.agent-activity-reveal li')).toHaveCount(0)
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)
