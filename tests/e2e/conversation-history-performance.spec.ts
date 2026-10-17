import { expect, type Page, type ElectronApplication } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { markdownVisibleProjection } from '../../apps/desktop/src/shared/message-anchor-text.js'
import {
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_PAGE_BYTES,
  CONVERSATION_PATCH_TEXT_BYTES,
  type DesktopBridge,
} from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  agentRunActivities,
  agentRuns,
  anchoredComments,
  conversationMessages,
} from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const messageCount = 10_000
const pageItems = 25

test(
  'opens a 10,000-Message Session through bounded pages and keeps large bodies bounded',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(180_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const seeded = await seedLongConversation(fixture)
    const app = await fixture.launch()

    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.sessionTitle, exact: true }).click()

      expect(seeded.firstPageBytes).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES)
      expect(seeded.fullSnapshotBytes).toBeGreaterThan(seeded.firstPageBytes * 10)
      expect(seeded.fullReadMs).toBeGreaterThan(0)
      expect(seeded.pageReadMs).toBeGreaterThan(0)
      expect(seeded.streamCompleteReadDelta).toBe(0)
      expect(seeded.streamPatchMaxBytes).toBeLessThanOrEqual(CONVERSATION_PATCH_TEXT_BYTES)
      expect(seeded.streamTotalMs).toBeGreaterThan(0)

      const transcriptRows = window.locator('[data-pact-message-id]')
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-resident-message-count',
        String(pageItems),
      )
      expect(await transcriptRows.count()).toBeLessThan(pageItems)
      await expect(
        window.getByText('Long message · Plain-text preview for performance'),
      ).toBeVisible()
      await expect(window.getByText('Comment 30', { exact: true })).toBeVisible()
      await expect(window.getByText('View all comments')).toHaveCount(0)

      const firstPage = await readMessagePage(window, seeded.sessionId)
      expect(firstPage.count).toBe(pageItems)
      expect(firstPage.bytes).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES)
      expect(firstPage.hasOlder).toBe(true)

      await window.getByRole('button', { name: 'Show work log' }).click()
      await expect(window.getByText('Showing the latest 50 steps.')).toBeVisible()
      await expect(window.getByText('Step 10', { exact: true })).toBeVisible()
      await expect(window.getByText('Step 9', { exact: true })).toHaveCount(0)

      await expect(window.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0)
      const transcriptLocator = window.locator('[data-pact-transcript]')
      for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each user scroll starts after the preceding bounded page settles.
        await transcriptLocator.evaluate((element) => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
          element.scrollTop = 0
          element.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the next page, not a guessed Renderer delay.
        await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
          'data-pact-oldest-sequence',
          String(messageCount - pageItems * (pageIndex + 2)),
        )
        // oxlint-disable-next-line eslint/no-await-in-loop -- Do not send the next user scroll while the previous page still owns its request.
        await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
          'aria-busy',
          'false',
        )
      }
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-resident-message-count',
        '100',
      )
      expect(await transcriptRows.count()).toBeLessThanOrEqual(100)
      const jumpToLatest = window.getByRole('button', { name: 'Jump to latest' })
      await expect(jumpToLatest).toBeVisible()
      await expect(
        window.getByText('Long message · Plain-text preview for performance'),
      ).toHaveCount(0)

      // Deliver a valid transport gap while the reader is in older history. No
      // provider or timing assumption is needed to test pixel/Selection recovery.
      await expect
        .poll(() =>
          window.evaluate(() => {
            const viewport = document
              .querySelector('[data-pact-transcript]')!
              .getBoundingClientRect()
            return [...document.querySelectorAll('[data-pact-message-id]')].some((row) => {
              const rect = row.getBoundingClientRect()
              return rect.top >= viewport.top && rect.bottom <= viewport.bottom
            })
          }),
        )
        .toBe(true)
      const anchor = await window.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>('[data-pact-transcript]')!
        const rows = [...transcript.querySelectorAll<HTMLElement>('[data-pact-message-id]')]
        const row = rows.find(
          (item) => item.getBoundingClientRect().top >= transcript.getBoundingClientRect().top,
        )!
        const content = row.querySelector('[data-pact-message-content]')!
        const range = document.createRange()
        range.selectNodeContents(content)
        const selection = globalThis.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return {
          id: row.dataset.pactMessageId!,
          top: row.getBoundingClientRect().top,
          quote: selection.toString(),
        }
      })
      await publishRealGap(app, window, seeded.sessionId, anchor.id)
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-resident-message-count',
        String(pageItems),
      )
      await expect
        .poll(() =>
          window.evaluate(
            (id) => {
              const row = document.querySelector<HTMLElement>(`[data-pact-message-id="${id.id}"]`)
              return row
                ? Math.abs(row.getBoundingClientRect().top - id.top)
                : Number.POSITIVE_INFINITY
            },
            { id: anchor.id, top: anchor.top },
          ),
        )
        .toBeLessThanOrEqual(2)
      const restored = await window.evaluate(
        (id) => ({
          top: document.querySelector(`[data-pact-message-id="${id}"]`)!.getBoundingClientRect()
            .top,
          quote: globalThis.getSelection()?.toString(),
        }),
        anchor.id,
      )
      expect(Math.abs(restored.top - anchor.top)).toBeLessThanOrEqual(2)
      await expect
        .poll(() => window.evaluate(() => globalThis.getSelection()?.toString()))
        .toBe(anchor.quote)
      await transcriptLocator.evaluate(async () => {
        // The gap restoration clears its protected scroll anchor on the next
        // committed animation frame. Let that finish before a new user scroll.
        await new Promise<void>((finish) => requestAnimationFrame(() => finish()))
        await new Promise<void>((finish) => requestAnimationFrame(() => finish()))
      })

      // A normal Selection is disposable once its completed source leaves the
      // viewport. A later gap must keep B's reading position, not wait for A.
      await transcriptLocator.evaluate((element, messageId) => {
        const source = element.querySelector<HTMLElement>(`[data-pact-message-id="${messageId}"]`)
        if (!source) throw new Error('Selection source is not mounted')
        // A Message can be taller than the viewport; one viewport of scrolling
        // does not necessarily move the selected source out of view.
        const distance = source.getBoundingClientRect().bottom - element.getBoundingClientRect().top
        element.scrollTop += Math.max(element.clientHeight, distance) + 200
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      }, anchor.id)
      await expect.poll(() => window.evaluate(() => globalThis.getSelection()?.toString())).toBe('')
      await expect.poll(() => messageIntersectsViewport(window, anchor.id)).toBe(false)
      const laterAnchor = await window.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-pact-transcript]')!
        const bounds = viewport.getBoundingClientRect()
        const row = [...viewport.querySelectorAll<HTMLElement>('[data-pact-message-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect()
            return (
              rect.bottom > bounds.top &&
              rect.top < bounds.bottom &&
              candidate.querySelector('[data-pact-message-content]')
            )
          },
        )!
        return { id: row.dataset.pactMessageId!, top: row.getBoundingClientRect().top }
      })
      expect(laterAnchor.id).not.toBe(anchor.id)
      await publishRealGap(app, window, seeded.sessionId, laterAnchor.id)
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-resident-message-count',
        String(pageItems),
      )
      await expect
        .poll(() =>
          window.evaluate(({ id, top }) => {
            const row = document.querySelector<HTMLElement>(`[data-pact-message-id="${id}"]`)
            return row ? Math.abs(row.getBoundingClientRect().top - top) : Number.POSITIVE_INFINITY
          }, laterAnchor),
        )
        .toBeLessThanOrEqual(2)
      await expect.poll(() => messageIntersectsViewport(window, anchor.id)).toBe(false)

      // An explicit latest intent also clears a still-visible ordinary Selection.
      await window.evaluate((id) => {
        const content = document.querySelector<HTMLElement>(`[data-pact-message-id="${id}"]`)!
        const range = document.createRange()
        range.selectNodeContents(content)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      }, laterAnchor.id)
      await expect
        .poll(() => window.evaluate(() => globalThis.getSelection()?.toString().length ?? 0))
        .toBeGreaterThan(0)

      await jumpToLatest.click()
      await expect.poll(() => window.evaluate(() => globalThis.getSelection()?.toString())).toBe('')
      await expect(
        window.getByText('Long message · Plain-text preview for performance'),
      ).toBeVisible()
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-resident-message-count',
        String(pageItems),
      )
      expect(await transcriptRows.count()).toBeLessThan(pageItems)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

async function messageIntersectsViewport(page: Page, messageId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const row = document.querySelector<HTMLElement>(`[data-pact-message-id="${id}"]`)
    if (!row) return false
    const viewport = document.querySelector<HTMLElement>('[data-pact-transcript]')!
    const rowBounds = row.getBoundingClientRect()
    const viewportBounds = viewport.getBoundingClientRect()
    return rowBounds.bottom > viewportBounds.top && rowBounds.top < viewportBounds.bottom
  }, messageId)
}

test(
  'Comment navigation mounts the exact offscreen source and preserves its selection while scrolling',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const seeded = await seedLongConversation(fixture)
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.sessionTitle, exact: true }).click()
      await window
        .getByRole('button', { name: '“History message 50” Comment 21', exact: true })
        .click()
      await expect
        .poll(() => window.evaluate(() => globalThis.getSelection()?.toString()))
        .toBe('History message 50')
      const source = window.locator(`[data-pact-message-id="${seeded.sourceMessageId}"]`)
      await expect(source).toHaveCount(1)
      await expect
        .poll(() =>
          window.evaluate(() => {
            const range = globalThis.getSelection()?.getRangeAt(0)
            const target = range?.getBoundingClientRect()
            const viewport = document
              .querySelector('[data-pact-transcript]')
              ?.getBoundingClientRect()
            return Boolean(
              target && viewport && target.bottom >= viewport.top && target.top <= viewport.bottom,
            )
          }),
        )
        .toBe(true)
      await expect(source).toHaveAttribute('data-pact-comment-pulse', 'true')
      await expect(window.locator('[data-pact-virtual-transcript]')).toHaveAttribute(
        'data-pact-oldest-sequence',
        '50',
      )
      await window.locator('[data-pact-transcript]').evaluate((el) => {
        el.scrollTop = el.scrollHeight
        el.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      await expect(source).toHaveCount(1)
      expect(await window.evaluate(() => globalThis.getSelection()?.toString())).toBe(
        'History message 50',
      )
      expect(await window.locator('[data-index]').count()).toBeLessThanOrEqual(100)
      await window.evaluate(() => globalThis.getSelection()?.removeAllRanges())
      await window.getByRole('button', { name: 'Jump to latest', exact: true }).click()
      await expect(
        window.getByText('Long message · Plain-text preview for performance'),
      ).toBeVisible()
      for (const target of [
        { name: '“History message 9990” Comment 22', quote: 'History message 9990' },
        {
          name: '“Middle quote for precise navigation” Comment 23',
          quote: 'Middle quote for precise navigation',
        },
      ]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each navigation owns the current Selection before the next explicit intent.
        await window.getByRole('button', { name: target.name, exact: true }).click()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Geometry must settle before checking the next navigation case.
        await expect
          .poll(() =>
            window.evaluate((quote) => {
              const selection = getSelection(),
                range = selection?.rangeCount
                  ? selection.getRangeAt(0).getBoundingClientRect()
                  : undefined,
                viewport = document.querySelector('[data-pact-transcript]')?.getBoundingClientRect()
              return (
                selection?.toString() === quote &&
                Boolean(
                  range && viewport && range.bottom >= viewport.top && range.top <= viewport.bottom,
                )
              )
            }, target.quote),
          )
          .toBe(true)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Clearing the current Selection is a deliberate user interaction, not retry policy.
        await window.evaluate(() => getSelection()?.removeAllRanges())
        // oxlint-disable-next-line eslint/no-await-in-loop -- Restore latest before testing another source on that Message.
        if (await window.getByRole('button', { name: 'Jump to latest', exact: true }).count()) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- This source replaced the page, so its explicit latest action is necessary.
          await window.getByRole('button', { name: 'Jump to latest', exact: true }).click()
        } else {
          // oxlint-disable-next-line eslint/no-await-in-loop -- A resident source requires only normal keyboard scrolling, not another read.
          await window.locator('[data-pact-transcript]').focus()
          // oxlint-disable-next-line eslint/no-await-in-loop -- Native End tests the scroll region's keyboard access.
          await window.locator('[data-pact-transcript]').press('End')
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the bounded latest page, not a fixed timeout.
        await expect(
          window.getByText('Long message · Plain-text preview for performance'),
        ).toBeVisible()
      }
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

async function readMessagePage(
  window: Page,
  sessionId: string,
): Promise<{ bytes: number; count: number; hasOlder: boolean }> {
  return window.evaluate(async (requestedSessionId) => {
    const pact: unknown = Reflect.get(globalThis, 'pact')
    if (
      !pact ||
      typeof pact !== 'object' ||
      !('getConversation' in pact) ||
      typeof pact.getConversation !== 'function'
    ) {
      throw new Error('Pact bridge is unavailable.')
    }
    const reply = await pact.getConversation({
      scope: 'messages',
      sessionId: requestedSessionId,
    })
    if (!reply.ok || reply.value.scope !== 'messages') {
      throw new Error('Conversation page is unavailable.')
    }
    return {
      bytes: new TextEncoder().encode(JSON.stringify(reply)).byteLength,
      count: reply.value.messages.length,
      hasOlder: reply.value.hasOlder,
    }
  }, sessionId)
}

// The authoritative snapshot must have reached the missed sequence. Drop real
// committed notifications, not invent future sequence numbers with no durable readback.
async function publishRealGap(
  app: ElectronApplication,
  window: Page,
  sessionId: string,
  aroundMessageId: string,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    const original = contents.send.bind(contents)
    Reflect.set(contents, 'historyGapOriginalSend', original)
    contents.send = (channel, ...args) => {
      if (channel !== 'pact:conversation:changed') original(channel, ...args)
    }
  })
  try {
    const patch = await window.evaluate(
      async ({ sessionId: requestedSessionId, aroundMessageId: requestedMessageId }) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const page = await bridge.getConversation({
          scope: 'messages',
          sessionId: requestedSessionId,
          aroundMessageId: requestedMessageId,
        })
        const drafts = await bridge.getConversation({
          scope: 'drafts',
          sessionId: requestedSessionId,
        })
        if (
          !page.ok ||
          page.value.scope !== 'messages' ||
          !drafts.ok ||
          drafts.value.scope !== 'drafts'
        )
          throw Error('Gap fixture unavailable')
        const source = page.value.messages.find(
          (item) => item.kind === 'complete' && /^History message \d+$/u.test(item.message.content),
        )
        if (!source || source.kind !== 'complete') throw Error('Missing complete gap source')
        const text = source.message.content
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
        const commentId = crypto.randomUUID()
        const created = await bridge.saveCommentDraft({
          mode: 'create',
          sessionId: requestedSessionId,
          commentId,
          expectedCommentsRevision: drafts.value.commentsRevision,
          body: 'Synthetic gap fixture',
          anchor: {
            type: 'message',
            messageId: source.message.id,
            contentHash: hash,
            textBasis: 'markdown-visible-v2',
            startOffset: 0,
            endOffset: text.length,
            quote: text,
          },
        })
        if (!created.ok || !created.value.comments) throw Error('Gap source mutation failed')
        const removed = await bridge.removeCommentDraft({
          sessionId: requestedSessionId,
          commentId,
          expectedCommentsRevision: created.value.comments.revision,
        })
        if (!removed.ok) throw Error('Gap source cleanup failed')
        return removed.value
      },
      { sessionId, aroundMessageId },
    )
    await app.evaluate(({ BrowserWindow }, committedPatch) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      const original: typeof contents.send = Reflect.get(contents, 'historyGapOriginalSend')
      original('pact:conversation:changed', committedPatch)
    }, patch)
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      contents.send = Reflect.get(contents, 'historyGapOriginalSend')
      Reflect.deleteProperty(contents, 'historyGapOriginalSend')
    })
  }
}

async function seedLongConversation(fixture: RuntimeFixture): Promise<{
  sessionId: string
  sessionTitle: string
  sourceMessageId: string
  fullSnapshotBytes: number
  firstPageBytes: number
  fullReadMs: number
  pageReadMs: number
  streamCompleteReadDelta: number
  streamPatchMaxBytes: number
  streamTotalMs: number
}> {
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const sessionTitle = 'Long Conversation fixture'
  const createdAt = '2026-09-26T00:00:00.000Z'
  const directoryPath = await fixture.createProjectDirectory('long-conversation-project')
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'Long Conversation project',
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
        codex: { model: 'gpt-5.6-sol', effort: 'high' },
      },
      maxDiscussionRounds: 6,
      runningMessagePolicy: 'immediate_safe_point',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )

  const messageIds = Array.from({ length: messageCount }, () => randomUUID())
  const runId = randomUUID()
  database.drizzle
    .insert(agentRuns)
    .values({
      id: runId,
      sessionId,
      userMessageId: messageIds[messageCount - 2]!,
      agentId: 'codex',
      status: 'running',
      nativeTurnId: 'fixture-stream-turn',
      attemptCount: 1,
      settingsRevision: 1,
      model: 'gpt-5.6-sol',
      effort: 'high',
      createdAt,
      updatedAt: createdAt,
    })
    .run()

  const rows = messageIds.map((id, sequence) => {
    const role = sequence % 2 === 0 ? ('user' as const) : ('assistant' as const)
    const latest = sequence === messageCount - 1
    return {
      id,
      sessionId,
      ...(sequence >= messageCount - 2 ? { runId } : {}),
      role,
      ...(role === 'assistant' ? { agentId: 'codex' as const } : {}),
      content: latest
        ? `Large response\n\n${'x'.repeat(CONVERSATION_MARKDOWN_BYTES + 1)}`
        : sequence === 100
          ? `Intro.\n\n${'A paragraph before the quote.\n\n'.repeat(150)}Middle quote for precise navigation\n\n${'A paragraph after the quote.\n\n'.repeat(150)}`
          : sequence >= 9980 && sequence < 9990
            ? `History message ${sequence}\n\n${'A variable-height **paragraph** with inline code.\n\n'.repeat((sequence % 5) + 1)}`
            : `History message ${sequence}`,
      contentRevision: 0,
      state: 'complete' as const,
      sequence,
      createdAt,
      updatedAt: createdAt,
    }
  })
  database.drizzle.transaction((transaction) => {
    for (let offset = 0; offset < rows.length; offset += 50) {
      transaction
        .insert(conversationMessages)
        .values(rows.slice(offset, offset + 50))
        .run()
    }
  })

  database.drizzle
    .insert(agentRunActivities)
    .values(
      Array.from({ length: 60 }, (_, sequence) => ({
        id: randomUUID(),
        sessionId,
        runId,
        agentId: 'codex' as const,
        nativeId: `work-log-${sequence}`,
        kind: 'reasoning' as const,
        title: `Step ${sequence}`,
        detail: `Durable detail ${sequence}`,
        detailRevision: 0,
        status: 'completed' as const,
        sequence,
        createdAt,
        updatedAt: createdAt,
      })),
    )
    .run()

  const commentMessageIds = messageIds.slice(-3)
  database.drizzle
    .insert(anchoredComments)
    .values(
      Array.from({ length: 30 }, (_, position) => {
        const messageId = commentMessageIds[Math.floor(position / 10)]!
        const sourceIndex =
          position === 20 ? 50 : position === 21 ? 9990 : position === 22 ? 100 : undefined
        const sourceMessageId = sourceIndex === undefined ? messageId : messageIds[sourceIndex]!
        const quote =
          position === 20
            ? 'History message 50'
            : position === 21
              ? 'History message 9990'
              : position === 22
                ? 'Middle quote for precise navigation'
                : 'History'
        const startOffset =
          sourceIndex === undefined
            ? 0
            : markdownVisibleProjection(rows[sourceIndex]!.content).indexOf(quote)
        return {
          id: randomUUID(),
          sessionId,
          body: `Comment ${position + 1}`,
          anchorJson: JSON.stringify({
            type: 'message',
            messageId: sourceMessageId,
            contentHash:
              sourceIndex !== undefined
                ? createHash('sha256').update(rows[sourceIndex]!.content).digest('hex')
                : 'a'.repeat(64),
            textBasis: 'markdown-visible-v2',
            startOffset,
            endOffset: startOffset + quote.length,
            quote,
          }),
          createdAt,
          updatedAt: createdAt,
          sentWithMessageId: messageId,
          position,
        }
      }),
    )
    .run()

  const fullReadStartedAt = performance.now()
  const fullSnapshot = database.conversationRepository.read(sessionId)
  const fullReadMs = performance.now() - fullReadStartedAt
  const pageReadStartedAt = performance.now()
  const firstPage = database.conversationRepository.readPage({ scope: 'messages', sessionId })
  const pageReadMs = performance.now() - pageReadStartedAt
  const fullSnapshotBytes = Buffer.byteLength(JSON.stringify(fullSnapshot), 'utf8')
  const firstPageBytes = Buffer.byteLength(JSON.stringify(firstPage), 'utf8')
  const completeReadsBeforeStream = database.conversationRepository.diagnostics().completeReads
  const streamStartedAt = performance.now()
  const streamPatches = Array.from({ length: 100 }, (_, index) =>
    database.conversationRepository.applyEvent(sessionId, runId, {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'fixture-stream-turn',
      outputId: 'fixture-stream-output',
      text: `-${index}`,
    }),
  )
  database.conversationRepository.applyEvent(sessionId, runId, {
    agentId: 'codex',
    type: 'text.completed',
    turnId: 'fixture-stream-turn',
    outputId: 'fixture-stream-output',
    text: rows.at(-1)?.content ?? '',
  })
  database.conversationRepository.applyEvent(sessionId, runId, {
    agentId: 'codex',
    type: 'turn.completed',
    turnId: 'fixture-stream-turn',
    outcome: 'completed',
  })
  const streamTotalMs = performance.now() - streamStartedAt
  const streamCompleteReadDelta =
    database.conversationRepository.diagnostics().completeReads - completeReadsBeforeStream
  const streamPatchMaxBytes = Math.max(
    ...streamPatches.map((patch) => Buffer.byteLength(JSON.stringify(patch), 'utf8')),
  )
  database.close()
  return {
    sessionId,
    sessionTitle,
    sourceMessageId: messageIds[50]!,
    fullSnapshotBytes,
    firstPageBytes,
    fullReadMs,
    pageReadMs,
    streamCompleteReadDelta,
    streamPatchMaxBytes,
    streamTotalMs,
  }
}
