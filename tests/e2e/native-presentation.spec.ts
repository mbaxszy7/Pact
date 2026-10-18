import { expect, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { agentRuns, conversationMessages } from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'macOS native attention and cancel-exit preserve preview, Fork and composer state',
  { tag: '@deterministic' },
  async () => {
    test.skip(process.platform !== 'darwin', 'Uses the actual macOS Dock menu')
    const fixture = await createRuntimeFixture({
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    let app: ElectronApplication | undefined
    let observer: ReadonlyFixtureDatabase | undefined
    try {
      const projectId = randomUUID(),
        sourceId = randomUUID(),
        createdAt = new Date().toISOString()
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Presentation workspace',
        directoryPath: await fixture.createProjectDirectory('presentation', false),
        kind: 'directory',
        createdAt,
      })
      for (let index = 0; index < 7; index += 1) {
        const id = index ? randomUUID() : sourceId
        db.sessionRepository.create(
          { id, projectId, title: index ? `Attention ${index}` : 'Preserved workspace', createdAt },
          {
            primaryAgentId: 'codex',
            agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
            maxDiscussionRounds: 3,
            runningMessagePolicy: 'next_round',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        )
        if (index) {
          const run = db.conversationRepository.beginRun({
            sessionId: id,
            clientMessageId: randomUUID(),
            content: 'Prior unconfirmed delivery',
            expectedCommentsRevision: 0,
            commentIds: [],
            agentId: 'codex',
            settingsRevision: 1,
            model: null,
            effort: null,
          }).run
          db.conversationRepository.recordDispatch(run.id, 'possibly_sent')
          db.conversationRepository.failRun(
            run.id,
            'unknown_delivery',
            'Native delivery was not confirmed.',
            true,
          )
        }
      }
      const runId = randomUUID(),
        userId = randomUUID(),
        answerId = randomUUID()
      db.drizzle
        .insert(agentRuns)
        .values({
          id: runId,
          sessionId: sourceId,
          userMessageId: userId,
          agentId: 'claude',
          status: 'completed',
          attemptCount: 1,
          settingsRevision: 1,
          model: null,
          effort: null,
          nativeSessionId: 'fixture-claude',
          nativeTurnId: runId,
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          dispatchPhase: 'ended',
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      db.drizzle
        .insert(conversationMessages)
        .values([
          {
            id: userId,
            sessionId: sourceId,
            runId,
            role: 'user',
            content: 'Original task',
            state: 'complete',
            sequence: 0,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: answerId,
            sessionId: sourceId,
            runId,
            role: 'assistant',
            agentId: 'claude',
            content: 'Preserved completed answer',
            state: 'complete',
            sequence: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ])
        .run()
      db.close()
      observer = ReadonlyFixtureDatabase.open(fixture)
      app = await fixture.launch()
      const page = await app.firstWindow()
      await page
        .getByRole('button', { name: 'Load more Sessions in Presentation workspace', exact: true })
        .click()
      await page.getByRole('button', { name: 'Preserved workspace', exact: true }).click()
      const editor = page.getByRole('combobox', { name: 'Message', exact: true })
      await expect(editor).toBeEnabled()
      await editor.fill('Preserved input\nSecond line')
      const attention = async () => {
        await app!.evaluate(({ app: nativeApp }) => {
          const action = nativeApp.dock
            ?.getMenu()
            ?.items.find((item) => item.label === 'View all in Pact…')
          if (!action) throw new Error('Owned attention action missing')
          Reflect.apply(action.click, action, [])
        })
        await expect(
          page.getByRole('heading', { name: 'Needs attention', exact: true }),
        ).toBeVisible()
        await expect(page.locator('dialog:modal')).toHaveCount(0)
      }
      const back = async () => {
        await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
      }
      const cancelQuit = async () => {
        await app!.evaluate(({ app: nativeApp }) => {
          setImmediate(() => nativeApp.quit())
        })
        const quit = page.getByRole('dialog', { name: 'Exit Pact?', exact: true })
        await expect(quit).toBeVisible()
        await expect(page.locator('dialog:modal')).toHaveCount(1)
        await expect(quit.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(quit).toHaveCount(0)
      }
      await page
        .getByRole('button', { name: 'Claude Code permissions: Ask for approval', exact: true })
        .click()
      await attention()
      await expect(page.getByLabel('Claude Code permissions', { exact: true })).toBeHidden()
      await back()
      await expect(
        page.getByRole('button', {
          name: 'Claude Code permissions: Ask for approval',
          exact: true,
        }),
      ).toBeFocused()
      await expect(editor).toHaveText('Preserved input\nSecond line')
      await page.keyboard.press('Escape')
      const answer = page.locator('article[data-pact-speaker="claude"]')
      await answer.locator('[data-pact-message-bubble]').hover()
      await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      const fork = page.getByRole('dialog', { name: 'Fork conversation', exact: true })
      await expect(fork).toBeVisible()
      await expect(fork.getByRole('button', { name: 'Create fork', exact: true })).toBeDisabled()
      await attention()
      await back()
      await expect(fork).toBeVisible()
      await cancelQuit()
      await expect(fork).toBeVisible()
      await fork.getByRole('button', { name: 'Cancel', exact: true }).click()
      // Real browser File input goes through production codec, storage and previews.
      await editor.evaluate((element) => {
        const transfer = new DataTransfer()
        for (let index = 0; index < 2; index += 1) {
          const canvas = document.createElement('canvas')
          canvas.width = 320
          canvas.height = 200
          const context = canvas.getContext('2d')!
          context.fillStyle = index ? '#b5dccc' : '#d6c8ee'
          context.fillRect(0, 0, 320, 200)
          const bytes = Uint8Array.from(
            atob(canvas.toDataURL('image/png').split(',')[1]!),
            (character) => character.charCodeAt(0),
          )
          transfer.items.add(new File([bytes], `preserved-${index}.png`, { type: 'image/png' }))
        }
        element.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
        )
      })
      const attached = page.getByLabel('Attached images')
      await expect(attached.locator('img')).toHaveCount(2)
      await attached.getByRole('button', { name: 'Preview preserved-0.png', exact: true }).click()
      const gallery = page.getByRole('dialog', { name: 'Image preview', exact: true })
      await page.keyboard.press('ArrowRight')
      await expect(gallery.locator('header')).toContainText('2 / 2')
      const close = gallery.getByRole('button', { name: 'Close image preview', exact: true })
      await close.focus()
      await attention()
      await back()
      await expect(gallery.locator('header')).toContainText('2 / 2')
      await expect(close).toBeFocused()
      await cancelQuit()
      await expect(gallery.locator('header')).toContainText('2 / 2')
      await expect(close).toBeFocused()
      await page.emulateMedia({ colorScheme: 'dark' })
      await gallery.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        )
      })
      await page.screenshot({ path: resolve('.pact-data/mac-validation/sixth-preview-dark.png') })
      await close.click()
      await editor.focus()
      await cancelQuit()
      await expect(editor).toHaveText('Preserved input\nSecond line')
      await expect(editor).toBeFocused()
      await expect(attached.locator('img')).toHaveCount(2)
      await page.emulateMedia({ colorScheme: 'light' })
      await page.getByRole('button', { name: /^Project folder:/u }).click()
      await page
        .getByRole('menu', { name: 'Project folder actions', exact: true })
        .evaluate(async (element) => {
          await Promise.all(
            element
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => undefined)),
          )
        })
      await page.screenshot({ path: resolve('.pact-data/mac-validation/sixth-context-light.png') })
      await page.keyboard.press('Escape')
      expect(observer.conversationRepository.read(sourceId).messages).toHaveLength(2)
      expect(observer.conversationRepository.read(sourceId).runs).toHaveLength(1)
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      if (db.isHealthy()) db.close()
      observer?.close()
      await fixture.dispose()
    }
  },
)
