import { expect, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  createQueueFixture,
  queueBodyHash,
} from '../../packages/persistence/src/conversation-queue.test-helper.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'Steer snapshots keep final output, collapsed Work Log and exact Comment navigation across restart',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let app: ElectronApplication | undefined
    try {
      const seeded = await createQueueFixture(
        fixture.databaseFile,
        await fixture.createProjectDirectory('steer-snapshots', false),
      )
      const run = seeded.root()
      seeded.consume(run, 'First supplement')
      seeded.repo.applyEvent(seeded.sessionId, run.id, {
        type: 'text.delta',
        agentId: 'codex',
        turnId: run.nativeTurnId,
        outputId: 'answer',
        text: ' Intermediate response.',
      })
      seeded.consume(run, 'Second supplement')
      seeded.repo.applyEvent(seeded.sessionId, run.id, {
        type: 'tool.started',
        agentId: 'codex',
        turnId: run.nativeTurnId,
        toolCallId: 'read-scope',
        toolName: 'read',
        title: 'Read the supplied scope',
      })
      seeded.repo.applyEvent(seeded.sessionId, run.id, {
        type: 'tool.completed',
        agentId: 'codex',
        turnId: run.nativeTurnId,
        toolCallId: 'read-scope',
        toolName: 'read',
        title: 'Read the supplied scope',
        outcome: 'completed',
      })
      seeded.finish(run)
      seeded.repo.recordNativeEffects(run.id, 'settled')
      const expanded = seeded.page({ snapshotView: { runId: run.id, mode: 'expanded' } })
      const source = expanded.messages.find(
        (entry) => entry.kind === 'complete' && entry.message.outputSnapshot?.ordinal === 0,
      )
      if (!source || source.kind !== 'complete') throw new Error('Frozen source missing')
      const sourceMessageId = source.message.id,
        sessionId = seeded.sessionId
      seeded.repo.saveCommentDraft({
        mode: 'create',
        sessionId,
        commentId: randomUUID(),
        expectedCommentsRevision: seeded.drafts().commentsRevision,
        body: 'Read the frozen source',
        anchor: {
          type: 'message',
          messageId: sourceMessageId,
          contentHash: queueBodyHash(source.message.content),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: 7,
          quote: 'Initial',
        },
      })
      const returned = seeded.queue(run, 'Restore this returned message')
      seeded.repo.returnQueuedConversationMessage({ ...returned, phase: 'return' })
      // Independent draft navigation precedes restoring the frozen returned bundle.
      seeded.repo.saveCommentDraft({
        mode: 'create',
        sessionId,
        commentId: randomUUID(),
        expectedCommentsRevision: seeded.drafts().commentsRevision,
        body: 'Navigate to the frozen source',
        anchor: {
          type: 'message',
          messageId: sourceMessageId,
          contentHash: queueBodyHash(source.message.content),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: 7,
          quote: 'Initial',
        },
      })
      seeded.close()

      app = await fixture.launch()
      let page = await app.firstWindow()
      await page.getByRole('button', { name: 'Queue regression', exact: true }).click()
      const messages = page.locator('[data-pact-message-id]')
      await expect(messages).toHaveCount(4)
      await expect(messages.nth(0)).toContainText('Review scope.')
      await expect(messages.nth(1)).toContainText('First supplement')
      await expect(messages.nth(2)).toContainText('Second supplement')
      await expect(messages.nth(3)).toContainText('Full final response.')
      await expect(page.getByText('Initial response.', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Earlier responses/u })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Show work log', exact: true })).toBeVisible()
      await expect(page.getByText('Read the supplied scope', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Show work log', exact: true }).click()
      await expect(page.getByText('Read the supplied scope', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: /Work log · 1 step/u }).click()
      await expect(page.getByText('Read the supplied scope', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Return to Comment source', exact: true }).click()
      await expect(page.locator(`[data-pact-message-id="${sourceMessageId}"]`)).toContainText(
        'Initial response.',
      )
      await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
      await expect(page.locator(`[data-pact-message-id="${sourceMessageId}"]`)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Restore returned message', exact: true }).click()
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toHaveText(
        'Restore this returned message',
      )
      const receipt = await page.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const history = await bridge.getConversation({ scope: 'messages', sessionId: id })
        const drafts = await bridge.getConversation({ scope: 'drafts', sessionId: id })
        if (
          !history.ok ||
          history.value.scope !== 'messages' ||
          !drafts.ok ||
          drafts.value.scope !== 'drafts'
        )
          throw new Error('Receipt read failed')
        return {
          returned: history.value.header.queue?.returnedInput,
          revision: drafts.value.commentsRevision,
          commentIds: drafts.value.comments.map((item) => item.id),
        }
      }, sessionId)
      expect(receipt.returned?.state).toBe('installed')
      expect(receipt.commentIds).toHaveLength(1)
      await quitPact(app, page)
      app = await fixture.launch()
      page = await app.firstWindow()
      await page.getByRole('button', { name: 'Queue regression', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Show work log', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Restore returned message', exact: true }).click()
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toHaveText(
        'Restore this returned message',
      )
      const restored = await page.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const history = await bridge.getConversation({ scope: 'messages', sessionId: id })
        const drafts = await bridge.getConversation({ scope: 'drafts', sessionId: id })
        if (
          !history.ok ||
          history.value.scope !== 'messages' ||
          !drafts.ok ||
          drafts.value.scope !== 'drafts'
        )
          throw new Error('Cold receipt read failed')
        return {
          returned: history.value.header.queue?.returnedInput,
          revision: drafts.value.commentsRevision,
          commentIds: drafts.value.comments.map((item) => item.id),
        }
      }, sessionId)
      expect(restored).toEqual(receipt)
      await expect(
        page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
      ).toHaveCount(1)
      await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0)
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      await fixture.dispose()
    }
  },
)
