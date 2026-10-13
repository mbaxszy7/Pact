import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  agentRuns,
  anchoredComments,
  conversationMessages,
} from '../../packages/persistence/src/schema/index.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

async function seed(fixture: RuntimeFixture) {
  const directory = await fixture.createProjectDirectory('input-return', false)
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = new Date().toISOString()
  try {
    database.projectCatalogRepository.add({
      id: projectId,
      name: 'Input return',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    database.sessionRepository.create(
      { id: sessionId, projectId, title: 'Input return Session', createdAt },
      {
        primaryAgentId: 'claude',
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 3,
        runningMessagePolicy: 'next_round',
        maxReviewCycles: 2,
        maxRepairAttempts: 2,
      },
    )
  } finally {
    database.close()
  }
  return sessionId
}

for (const keepNewDraft of [false, true]) {
  test(
    `Rebuild returns rejected Codex input and Comments with frozen routing; new draft ${keepNewDraft ? 'preserved' : 'empty'}`,
    { tag: '@deterministic' },
    async () => {
      test.setTimeout(120_000)
      const fixture = await createRuntimeFixture({ codexAppServer: 'writer_rejected_once' })
      let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
      try {
        const sessionId = await seed(fixture)
        app = await fixture.launch()
        let page = await app.firstWindow()
        await page.getByRole('button', { name: 'Input return Session', exact: true }).click()
        let composer = page.getByRole('combobox', { name: 'Message', exact: true })
        await composer.fill('@codex First native request')
        await composer.press('Enter')
        await expect(page.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible()
        await expect(composer).toBeEnabled()
        const comment = await page.evaluate(async (id) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const history = await bridge.getConversation({ scope: 'messages', sessionId: id })
          if (!history.ok || history.value.scope !== 'messages')
            throw new Error('History unavailable')
          const answer = history.value.messages.find(
            (entry) => entry.kind === 'complete' && entry.message.role === 'assistant',
          )
          if (!answer || answer.kind !== 'complete') throw new Error('Answer unavailable')
          const text = answer.message.content
          const hash = [
            ...new Uint8Array(
              await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
          const commentId = crypto.randomUUID()
          const saved = await bridge.saveCommentDraft({
            mode: 'create',
            sessionId: id,
            commentId,
            expectedCommentsRevision: history.value.header.commentsRevision,
            body: 'Retain this anchored instruction',
            anchor: {
              type: 'message',
              messageId: answer.message.id,
              contentHash: hash,
              textBasis: 'markdown-visible-v2',
              startOffset: 0,
              endOffset: text.length,
              quote: text,
            },
          })
          if (!saved.ok) throw new Error(saved.error.message)
          return commentId
        }, sessionId)
        await expect(
          page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)
        await composer.fill('@codex Previous rejected request')
        await composer.press('Enter')
        if (keepNewDraft) {
          await expect.poll(() => composer.textContent()).toBe('')
          await composer.fill('Keep my newer draft')
        }
        await expect(page.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible()
        expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
        await page.getByRole('button', { name: 'Rebuild…', exact: true }).click()
        await page.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
        await expect(page.getByText('Codex native session rebuilt', { exact: true })).toBeVisible({
          timeout: 15_000,
        })
        if (keepNewDraft) {
          await expect.poll(() => composer.textContent()).toBe('Keep my newer draft')
          await expect(
            page.getByText('Previous unsent message is available', { exact: true }),
          ).toBeVisible()
          await expect(
            page.getByRole('button', { name: 'Restore to input', exact: true }),
          ).toBeDisabled()
          await composer.fill('')
        }
        await expect.poll(() => composer.textContent()).toBe('@codex Previous rejected request')
        await expect(
          page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
        ).toHaveCount(1)
        await expect(page.getByText('Unsent message restored', { exact: true })).toBeVisible()
        expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
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
            throw new Error('Recovery unavailable')
          return {
            recovery: history.value.header.rebuildInputRecovery,
            commentIds: drafts.value.comments.map((entry) => entry.id),
            bodies: drafts.value.comments.map((entry) => entry.body),
          }
        }, sessionId)
        expect(restored.recovery?.route).toEqual({ type: 'agent', agentId: 'codex' })
        expect(restored.recovery?.state).toBe('installed')
        expect(restored.commentIds).not.toContain(comment)
        expect(restored.bodies).toEqual(['Retain this anchored instruction'])
        if (!keepNewDraft) {
          const title = await page.evaluate(async (id) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            const settings = await bridge.getSessionSettings(id)
            if (!settings.ok) throw new Error('Session unavailable')
            return settings.value.session.title
          }, sessionId)
          await app.close()
          app = await fixture.launch()
          page = await app.firstWindow()
          await page.getByRole('button', { name: title, exact: true }).click()
          composer = page.getByRole('combobox', { name: 'Message', exact: true })
          await expect.poll(() => composer.textContent()).toBe('@codex Previous rejected request')
          await expect(
            page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
          ).toHaveCount(1)
          expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
        }
        await composer.press('Enter')
        await expect(page.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(2)
        expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(2)
        await expect.poll(() => composer.textContent()).toBe('')
        await app.close()
        app = undefined
        const database = await PactDatabase.open({
          filePath: fixture.databaseFile,
          migrationsFolder,
        })
        try {
          const runs = database.drizzle.select().from(agentRuns).all()
          expect(runs.filter((run) => run.failureKind === 'native_session_occupied')).toHaveLength(
            1,
          )
          expect(
            runs.filter((run) => run.status === 'completed' && run.agentId === 'codex'),
          ).toHaveLength(2)
          const original = database.drizzle
            .select()
            .from(conversationMessages)
            .all()
            .find((message) => message.id === restored.recovery?.messageId)
          expect(original?.isVisible).toBe(false)
          expect(original?.content).toBe('@codex Previous rejected request')
          const comments = database.drizzle.select().from(anchoredComments).all()
          expect(comments.find((entry) => entry.id === comment)?.sentWithMessageId).toBe(
            original?.id,
          )
          expect(comments).toHaveLength(2)
        } finally {
          database.close()
        }
      } finally {
        await app?.close()
        await fixture.dispose()
      }
    },
  )
}
