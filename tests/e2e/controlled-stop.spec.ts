import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'Stop preserves received text, a recipient draft and an unsaved Comment before exactly one continuation',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'controlled_stop' })
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      createdAt = new Date().toISOString()
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    let observer: ReadonlyFixtureDatabase | undefined
    try {
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Controlled Stop',
        directoryPath: await fixture.createProjectDirectory('controlled-stop'),
        kind: 'directory',
        createdAt,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'Controlled Stop', createdAt },
        {
          primaryAgentId: 'codex',
          agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      db.close()
      let app = await fixture.launch()
      const page = await app.firstWindow()
      observer = ReadonlyFixtureDatabase.open(fixture)
      const observed = observer
      await page.getByRole('button', { name: 'Controlled Stop', exact: true }).last().click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('@all STOP_SOURCE controlled request')
      await composer.press('Enter')
      await expect(page.getByText('Controlled partial response remains visible.')).toBeVisible()
      const live = observed.conversationRepository.read(sessionId)
      const original = live.runs[0]!
      const user = live.messages.find((message) => message.role === 'user')!
      const reply = live.messages.find((message) => message.role === 'assistant')!
      expect(original).toMatchObject({ status: 'running', dispatchPhase: 'accepted' })
      await page.locator(`[data-pact-message-id="${user.id}"]`).scrollIntoViewIfNeeded()
      await page.evaluate((messageId) => {
        const host = document.querySelector(
          `[data-pact-message-id="${messageId}"] [data-pact-message-content]`,
        )
        const walker = document.createTreeWalker(host!, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (!(node instanceof Text) || !node.data.includes('STOP_SOURCE')) continue
          host!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
          const start = node.data.indexOf('STOP_SOURCE')
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + 'STOP_SOURCE'.length)
          const selection = document.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          return
        }
        throw new Error('Controlled User Message quote unavailable')
      }, user.id)
      await page.getByRole('button', { name: 'Comment on selected text', exact: true }).click()
      const comment = page.getByRole('textbox', { name: 'Comment', exact: true })
      await comment.fill('Keep this unsaved Comment after Stop')
      await composer.fill('@codex')
      await page.getByRole('option', { name: /^Codex/u }).click()
      await composer.press('End')
      await composer.pressSequentially('One explicit continuation')
      const draft = '@codex One explicit continuation'
      await expect.poll(() => composer.textContent()).toBe(draft)
      await expect(comment).toHaveValue('Keep this unsaved Comment after Stop')
      expect(observed.conversationRepository.read(sessionId).runs).toHaveLength(1)
      await page.getByRole('button', { name: 'Stop Codex response', exact: true }).click()
      await expect
        .poll(() => observed.conversationRepository.read(sessionId).runs[0]?.status)
        .toBe('interrupted')
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await expect.poll(() => composer.textContent()).toBe(draft)
      await expect(comment).toHaveValue('Keep this unsaved Comment after Stop')
      await comment.press('Enter')
      await expect(page.getByLabel('Attached Comment drafts')).toContainText(
        'Keep this unsaved Comment after Stop',
      )
      const stopped = observed.conversationRepository.read(sessionId)
      const preserved = stopped.messages.find((message) => message.id === reply.id)!
      expect(preserved.content.startsWith(reply.content)).toBe(true)
      expect(preserved.state).toBe('incomplete')
      const anchored = stopped.comments[0]!
      expect(anchored).toMatchObject({
        status: 'draft',
        anchor: { type: 'message', messageId: user.id, quote: 'STOP_SOURCE' },
      })
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      expect((await fixture.readCodexFacts()).methods).toContain('turn/interrupt')
      await expect(
        readFile(join(fixture.directory, 'claude-sdk-state.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible()
      await expect
        .poll(() => observed.conversationRepository.read(sessionId).runs.map((run) => run.status))
        .toEqual(['interrupted', 'completed'])
      const complete = observed.conversationRepository.read(sessionId)
      expect(complete.runs[1]?.nativeSessionId).toBe(original.nativeSessionId)
      expect(complete.messages.find((message) => message.id === reply.id)).toMatchObject({
        content: preserved.content,
        state: 'incomplete',
      })
      expect(complete.comments.find((entry) => entry.id === anchored.id)).toMatchObject({
        status: 'sent',
        sentWithMessageId: complete.runs[1]?.userMessageId,
      })
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(2)
      await expect(
        readFile(join(fixture.directory, 'claude-sdk-state.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await quitPact(app)
      app = await fixture.launch()
      await (
        await app.firstWindow()
      )
        .locator(`[data-session-menu="${sessionId}"] button[data-nav-primary]`)
        .click()
      const cold = observed.conversationRepository.read(sessionId)
      expect(
        cold.runs.map(({ id, status, nativeSessionId, nativeTurnId }) => ({
          id,
          status,
          nativeSessionId,
          nativeTurnId,
        })),
      ).toEqual(
        complete.runs.map(({ id, status, nativeSessionId, nativeTurnId }) => ({
          id,
          status,
          nativeSessionId,
          nativeTurnId,
        })),
      )
      expect(cold.messages).toEqual(complete.messages)
      expect(cold.comments).toEqual(complete.comments)
      await quitPact(app)
    } finally {
      observer?.close()
      db.close()
      await fixture.dispose()
    }
  },
)
