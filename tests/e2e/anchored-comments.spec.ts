import { expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

test(
  'persists a Message Comment draft and restores its Composer chip after restart',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })

    try {
      const seeded = await seedConversation(fixture)
      let app = await fixture.launch()
      let window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)
      await selectAssistantPhrase(
        window,
        'The typed IPC boundary keeps the Renderer isolated from privileged code.',
        true,
      )
      await window.getByRole('combobox', { name: 'Message' }).click()
      await expect(window.getByRole('button', { name: 'Comment on selected text' })).toHaveCount(0)
      await selectAssistantPhrase(window, 'typed IPC')
      await window.getByRole('button', { name: 'Comment on selected text' }).click()
      await expect(window.getByRole('heading', { name: 'New comment' })).toBeVisible()
      await window.getByRole('textbox', { name: 'Comment' }).fill('Please verify this boundary.')
      await window.getByRole('textbox', { name: 'Comment' }).press('Enter')
      await expect(window.getByLabel('Attached Comment drafts')).toContainText(
        'Please verify this boundary.',
      )

      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)
      await expect(window.getByLabel('Attached Comment drafts')).toContainText(
        'Please verify this boundary.',
      )
    } finally {
      await fixture.dispose()
    }
  },
)

test(
  'preserves an eleven-Comment draft bundle across restart without the retired ten-item limit',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })

    try {
      const seeded = await seedConversation(fixture, { draftComments: 10 })
      let app = await fixture.launch()
      let window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)
      let drafts = window.getByLabel('Attached Comment drafts').locator(':scope > span')
      await expect(drafts).toHaveCount(10)

      await selectAssistantPhrase(window, 'typed IPC')
      await window.getByRole('button', { name: 'Comment on selected text' }).click()

      await expect(window.getByRole('heading', { name: 'New comment' })).toBeVisible()
      await window
        .getByRole('textbox', { name: 'Comment' })
        .fill('The eleventh Comment is retained.')
      await window.getByRole('textbox', { name: 'Comment' }).press('Enter')
      await expect(drafts).toHaveCount(11)
      await expect(window.locator('[data-pact-toast-tone="warning"]')).toHaveCount(0)
      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)
      drafts = window.getByLabel('Attached Comment drafts').locator(':scope > span')
      await expect(drafts).toHaveCount(11)
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          expect(
            drafts.filter({ hasText: new RegExp(`Fixture Comment ${index + 1}\\b`, 'u') }),
          ).toHaveCount(1),
        ),
      )
      await expect(window.getByLabel('Attached Comment drafts')).toContainText(
        'The eleventh Comment is retained.',
      )
    } finally {
      await fixture.dispose()
    }
  },
)

async function seedConversation(
  fixture: RuntimeFixture,
  options: { draftComments?: number } = {},
): Promise<{ sessionTitle: string }> {
  const database = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder,
  })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const sessionTitle = 'Comment fixture session'
  const createdAt = new Date().toISOString()
  const directoryPath = await fixture.createProjectDirectory('anchored-comments-project')
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'anchored-comments-project',
    directoryPath,
    kind: 'git',
    createdAt,
  })
  database.sessionRepository.create(
    { id: sessionId, projectId, title: sessionTitle, createdAt },
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
  const started = database.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Explain the boundary.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  database.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId: 'codex',
    type: 'text.completed',
    turnId: 'fixture-turn',
    outputId: 'fixture-output',
    text: 'The typed IPC boundary keeps the Renderer isolated from privileged code.',
  })
  database.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId: 'codex',
    type: 'turn.completed',
    turnId: 'fixture-turn',
    outcome: 'completed',
  })
  const completed = database.conversationRepository.read(sessionId)
  const assistantMessage = completed.messages.find((message) => message.role === 'assistant')
  if (!assistantMessage) throw new Error('Comment fixture Assistant Message is missing.')
  for (let index = 0; index < (options.draftComments ?? 0); index += 1) {
    database.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId: randomUUID(),
      expectedCommentsRevision: completed.commentsRevision + index,
      body: `Fixture Comment ${index + 1}`,
      anchor: {
        type: 'message',
        messageId: assistantMessage.id,
        contentHash: createHash('sha256').update(assistantMessage.content).digest('hex'),
        textBasis: 'markdown-visible-v2',
        startOffset: 4,
        endOffset: 13,
        quote: 'typed IPC',
      },
    })
  }
  database.close()
  return { sessionTitle }
}

async function openSeededSession(window: Page, sessionTitle: string): Promise<void> {
  const session = window.getByRole('button', { name: sessionTitle, exact: true })
  await expect(session).toBeVisible()
  await session.click()
  await expect(
    window.getByText('The typed IPC boundary keeps the Renderer isolated from privileged code.'),
  ).toBeVisible()
}

async function selectAssistantPhrase(
  window: Page,
  phrase: string,
  releaseOutside = false,
): Promise<void> {
  await window.evaluate(
    ({ selectedPhrase, outside }) => {
      const host = [...document.querySelectorAll<HTMLElement>('[data-pact-message-content]')].find(
        (candidate) => candidate.textContent?.includes(selectedPhrase),
      )
      const span = host?.querySelector<HTMLElement>('[data-pact-projection-start]')
      const text = span?.firstChild
      if (!host || !span || !(text instanceof Text))
        throw new Error('Fixture Message projection is missing.')
      const start = text.data.indexOf(selectedPhrase)
      if (start < 0) throw new Error('Fixture phrase is missing.')
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + selectedPhrase.length)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(outside ? document.body : span).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    { selectedPhrase: phrase, outside: releaseOutside },
  )
  await expect(window.getByRole('button', { name: 'Comment on selected text' })).toBeVisible()
}
