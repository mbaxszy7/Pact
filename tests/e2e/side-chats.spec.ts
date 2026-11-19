import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  PactDatabase,
  conversationCutoffs,
  sessions,
} from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const seededAssistantText =
  'The typed IPC boundary keeps the Renderer isolated from privileged code.'

async function seedParentSession(
  fixture: RuntimeFixture,
  options: { projectName?: string; sessionTitle?: string; lockTitle?: boolean } = {},
): Promise<{
  projectId: string
  projectName: string
  sessionId: string
  sessionTitle: string
}> {
  const database = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder,
  })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const projectName = options.projectName ?? 'side-chats-project'
  const sessionTitle = options.sessionTitle ?? 'Side chat parent session'
  const createdAt = new Date().toISOString()
  try {
    const directoryPath = await fixture.createProjectDirectory(projectName)
    database.projectCatalogRepository.add({
      id: projectId,
      name: projectName,
      directoryPath,
      kind: 'git',
      createdAt,
    })
    database.sessionRepository.create(
      { id: sessionId, projectId, title: sessionTitle, createdAt },
      {
        primaryAgentId: 'codex',
        secondaryAgentId: 'claude',
        agents: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
          agy: { model: null, effort: null },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    if (options.lockTitle) {
      database.sessionRepository.rename(sessionId, sessionTitle)
    }
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
      text: seededAssistantText,
    })
    database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'fixture-turn',
      outcome: 'completed',
    })
  } finally {
    database.close()
  }
  return { projectId, projectName, sessionId, sessionTitle }
}

async function ensureWideWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    const bounds = win.getBounds()
    win.setSize(Math.max(bounds.width, 1360), Math.max(bounds.height, 860))
  })
}

async function openSeededSession(window: Page, sessionTitle: string): Promise<void> {
  const session = window.getByRole('button', { name: sessionTitle, exact: true })
  await expect(session).toBeVisible()
  await session.click()
  const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
  await expect(mainWorkspace.getByText(seededAssistantText)).toBeVisible()
}

async function selectAssistantPhrase(window: Page, phrase: string): Promise<void> {
  await window.evaluate((selectedPhrase) => {
    const workspace = document.querySelector<HTMLElement>('section[aria-label="Workspace"]')
    const hosts = [
      ...(workspace ?? document).querySelectorAll<HTMLElement>('[data-pact-message-content]'),
    ]
    const host = hosts.find((candidate) => candidate.textContent?.includes(selectedPhrase))
    const span = host?.querySelector<HTMLElement>('[data-pact-projection-start]')
    const text = span?.firstChild
    if (!host || !span || !(text instanceof Text)) {
      throw new Error('Fixture Message projection is missing.')
    }
    const start = text.data.indexOf(selectedPhrase)
    if (start < 0) throw new Error('Fixture phrase is missing.')
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + selectedPhrase.length)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, phrase)
  await expect(window.getByRole('button', { name: 'Comment on selected text' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Ask in side chat', exact: true })).toBeVisible()
}

function readSideChatRows(fixture: RuntimeFixture, parentSessionId: string) {
  const db = ReadonlyFixtureDatabase.open(fixture)
  try {
    return db.drizzle
      .select()
      .from(sessions)
      .all()
      .filter((row) => row.parentSessionId === parentSessionId)
  } finally {
    db.close()
  }
}

function readCutoffRows(fixture: RuntimeFixture) {
  const db = ReadonlyFixtureDatabase.open(fixture)
  try {
    return db.drizzle.select().from(conversationCutoffs).all()
  } finally {
    db.close()
  }
}

async function recentDockLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ app: nativeApp }) => {
    const items = nativeApp.dock?.getMenu()?.items ?? []
    const heading = items.findIndex((item) => item.label === 'Recent sessions')
    return heading < 0
      ? []
      : items
          .slice(heading + 1)
          .filter(
            (item) =>
              item.type !== 'separator' &&
              item.enabled &&
              !item.label.startsWith('Show ') &&
              item.label !== 'Exit',
          )
          .map((item) => item.label)
  })
}

test(
  'Ask in side chat opens a locked draft with a pre-attached quote chip and discards it when left untouched',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let app: ElectronApplication | undefined

    try {
      const seeded = await seedParentSession(fixture)
      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)

      await selectAssistantPhrase(window, 'typed IPC')
      await window.getByRole('button', { name: 'Ask in side chat', exact: true }).click()

      const sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      const activeStage = sideChatsPanel.locator('[data-stage-state="active"]')

      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()
      await expect(
        activeStage.getByRole('heading', { name: 'Ask Codex', exact: true }),
      ).toBeVisible()
      await expect(
        activeStage.getByText('Ask about the main chat, or type @Main to send a takeaway back.', {
          exact: true,
        }),
      ).toBeVisible()
      await expect(activeStage.getByLabel('Attached Comment drafts')).toContainText(
        'Main chat · “typed IPC”',
      )
      await expect(activeStage.getByRole('combobox', { name: 'Message' })).toBeVisible()

      // Locked composer and side-chat chrome omit settings, permission/speed/project controls, and Fork.
      await expect(activeStage.locator('.pact-composer-controls')).toHaveCount(0)
      await expect(activeStage.getByRole('group', { name: 'Codex settings' })).toHaveCount(0)
      await expect(activeStage.getByRole('group', { name: 'Claude Code settings' })).toHaveCount(0)
      await expect(
        activeStage.getByRole('button', {
          name: /Permission|Speed|Project context|Open project/iu,
        }),
      ).toHaveCount(0)
      await expect(
        activeStage.getByRole('button', { name: 'Session settings', exact: true }),
      ).toHaveCount(0)
      await expect(activeStage.getByRole('button', { name: /Fork/iu })).toHaveCount(0)

      await expect.poll(() => readSideChatRows(fixture, seeded.sessionId).length).toBe(1)
      await expect.poll(() => readCutoffRows(fixture).length).toBe(1)

      // Leaving an untouched empty side chat discards both the side chat and its cutoff row.
      await activeStage.getByRole('button', { name: 'Back to side chats', exact: true }).click()
      await expect(activeStage.getByText('No side chats yet', { exact: true })).toBeVisible()
      await expect.poll(() => readSideChatRows(fixture, seeded.sessionId).length).toBe(0)
      await expect.poll(() => readCutoffRows(fixture).length).toBe(0)
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'preserves a drafted New side chat across navigation and restart, and hands off /btw without auto-sending',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let app: ElectronApplication | undefined

    try {
      const seeded = await seedParentSession(fixture)
      app = await fixture.launch()
      await ensureWideWindow(app)
      let window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)

      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      let sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      let activeStage = sideChatsPanel.locator('[data-stage-state="active"]')

      await activeStage.getByRole('button', { name: 'New side chat', exact: true }).click()
      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()
      const sideComposer = activeStage.getByRole('combobox', { name: 'Message' })
      await sideComposer.click()
      await sideComposer.fill('Draft preserved across navigation')
      await expect(sideComposer).toHaveText('Draft preserved across navigation')

      await activeStage.getByRole('button', { name: 'Back to side chats', exact: true }).click()
      await expect(activeStage.locator('[data-side-chat-row]')).toHaveCount(1)
      await expect(activeStage.locator('[data-side-chat-row]').first()).toContainText(
        'New side chat',
      )
      await expect(activeStage.locator('[data-side-chat-row]').first()).toContainText('/btw')

      // Reopening within the same session keeps the typed draft in the side-chat composer.
      await activeStage.locator('[data-side-chat-row] button').first().click()
      await expect(activeStage.getByRole('combobox', { name: 'Message' })).toHaveText(
        'Draft preserved across navigation',
      )
      await activeStage.getByRole('button', { name: 'Back to side chats', exact: true }).click()
      await expect(activeStage.locator('[data-side-chat-row]')).toHaveCount(1)

      // Cold restart preserves the drafted side chat row in SQLite and the Side chats list.
      await quitPact(app, window)
      app = undefined
      app = await fixture.launch()
      await ensureWideWindow(app)
      window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)

      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      activeStage = sideChatsPanel.locator('[data-stage-state="active"]')
      await expect(activeStage.locator('[data-side-chat-row]')).toHaveCount(1)

      // `/btw` in the main composer renders the `pact:btw` chip, strips the command, opens a new
      // `btw` side chat without auto-sending, and clears the main composer.
      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const mainComposer = mainWorkspace.getByRole('combobox', { name: 'Message' })
      await mainComposer.click()
      await mainComposer.fill('/btw')
      const skillMenu = window.getByRole('listbox', { name: 'Native Skills' })
      await expect(skillMenu).toBeVisible()
      await window.locator('#skill-pact-btw').click()
      await expect(mainComposer.locator('[data-pact-command="btw"]')).toHaveText('pact:btw')
      await window.keyboard.insertText('Does this retry safely?')
      await expect(mainComposer).toHaveText('pact:btw Does this retry safely?')
      await mainComposer.press('Enter')

      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()
      await expect(activeStage.getByText('Context from main chat', { exact: true })).toBeVisible()
      await expect(activeStage.getByRole('combobox', { name: 'Message' })).toHaveText(
        'Does this retry safely?',
      )
      await expect(mainComposer).toBeEmpty()

      const sideChatsAfterBtw = readSideChatRows(fixture, seeded.sessionId)
      expect(sideChatsAfterBtw).toHaveLength(2)
      const db = ReadonlyFixtureDatabase.open(fixture)
      try {
        expect(db.conversationRepository.read(seeded.sessionId).runs).toHaveLength(1)
        for (const sideChat of sideChatsAfterBtw) {
          expect(sideChat.sideChatOrigin).toBe('btw')
          const convo = db.conversationRepository.read(sideChat.id)
          expect(convo.runs).toHaveLength(0)
          expect(convo.messages).toHaveLength(0)
        }
      } finally {
        db.close()
      }
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'updates side chat unread state, live preview, From side chat tooltip, and cascades parent archive/restore off sidebar and MRU',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      codexAppServer: 'background_stream',
      sessionTitles: true,
    })
    let app: ElectronApplication | undefined

    try {
      const seeded = await seedParentSession(fixture, {
        projectName: 'side-chat-lifecycle',
        sessionTitle: 'Parent lifecycle session',
        lockTitle: true,
      })
      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)

      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      const activeStage = sideChatsPanel.locator('[data-stage-state="active"]')

      // Start a side chat and send a takeaway to main while its title is still "New side chat".
      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      await activeStage.getByRole('button', { name: 'New side chat', exact: true }).click()
      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()

      const sideComposer = activeStage.getByRole('combobox', { name: 'Message' })
      await sideComposer.click()
      await sideComposer.fill('@Main Initial takeaway before title update')
      await activeStage.getByRole('button', { name: 'Send to main', exact: true }).click()

      const fromBadge = mainWorkspace.getByRole('button', { name: 'From side chat', exact: true })
      await expect(fromBadge).toBeVisible()
      await expect(fromBadge).toHaveAttribute('title', 'Open side chat: New side chat')
      await expect(mainWorkspace.getByText('Background result complete.')).toBeVisible({
        timeout: 20_000,
      })

      const [sideChatRow] = readSideChatRows(fixture, seeded.sessionId)
      expect(sideChatRow).toBeDefined()
      const sideChatId = sideChatRow!.id

      // Send a side-chat prompt so publish_session_title updates the title live, then return to the
      // list before the assistant reply completes so the reply lands unread with live previewText.
      await sideComposer.click()
      await sideComposer.fill('Check unread reply and live preview')
      await sideComposer.press('Enter')

      await expect(
        activeStage.getByRole('heading', { name: 'Title from the authorized Turn', exact: true }),
      ).toBeVisible({ timeout: 15_000 })
      await activeStage.getByRole('button', { name: 'Back to side chats', exact: true }).click()

      const listRow = activeStage.locator(`[data-side-chat-row="${sideChatId}"]`)
      await expect(listRow).toBeVisible()
      await expect(listRow.getByLabel('New reply')).toBeVisible({ timeout: 20_000 })
      await expect(listRow).toContainText('Title from the authorized Turn')
      await expect(listRow).toContainText('Part 1 saved.')
      await expect(
        window.getByRole('button', { name: /Side chats/u }).getByLabel('1 unread side chat'),
      ).toBeVisible()

      // The main-chat "From side chat" badge reflects the live side-chat title and reopens it.
      await expect(fromBadge).toHaveAttribute(
        'title',
        'Open side chat: Title from the authorized Turn',
      )
      await activeStage.getByRole('button', { name: 'Close side chats', exact: true }).click()
      await expect(sideChatsPanel).toHaveCount(0)

      await fromBadge.click()
      await expect(
        activeStage.getByRole('heading', { name: 'Title from the authorized Turn', exact: true }),
      ).toBeVisible()
      await expect(activeStage.getByText('Background result complete.')).toBeVisible()
      // Side chats never offer Fork even on completed assistant messages.
      await expect(activeStage.getByRole('button', { name: /Fork/iu })).toHaveCount(0)

      // Opening the unread side chat triggers markSessionRead and clears unread indicators.
      await expect
        .poll(() => readSideChatRows(fixture, seeded.sessionId)[0]?.lastSeenMessageSequence ?? -1)
        .toBeGreaterThanOrEqual(1)
      await expect(
        window.getByRole('button', { name: /Side chats/u }).getByLabel(/unread side chat/u),
      ).toHaveCount(0)
      await activeStage.getByRole('button', { name: 'Back to side chats', exact: true }).click()
      await expect(listRow.getByLabel('New reply')).toHaveCount(0)

      // Side chats stay off the left sidebar and Recent MRU.
      const navigation = window.getByRole('navigation')
      await expect(
        navigation.getByRole('button', { name: 'Title from the authorized Turn', exact: true }),
      ).toHaveCount(0)
      expect(readSideChatRows(fixture, seeded.sessionId)[0]).toMatchObject({
        sidebarHidden: true,
        lastOpenedOrdinal: null,
      })
      if (process.platform === 'darwin') {
        await expect
          .poll(() => recentDockLabels(app!))
          .toContain(`${seeded.sessionTitle} — ${seeded.projectName}`)
        expect(await recentDockLabels(app)).not.toContain(
          `Title from the authorized Turn — ${seeded.projectName}`,
        )
      }

      // Archiving the parent Session cascades to its side chats; Undo archive restores both.
      const parentSidebarButton = window.getByRole('button', {
        name: seeded.sessionTitle,
        exact: true,
      })
      await parentSidebarButton.hover()
      const archiveParentButton = window.getByRole('button', {
        name: `Archive Session ${seeded.sessionTitle}`,
        exact: true,
      })
      await archiveParentButton.focus()
      await archiveParentButton.click()
      await expect(parentSidebarButton).toHaveCount(0)
      await expect(sideChatsPanel).toHaveCount(0)

      await expect
        .poll(() => {
          const db = ReadonlyFixtureDatabase.open(fixture)
          try {
            const parent = db.drizzle
              .select()
              .from(sessions)
              .all()
              .find((row) => row.id === seeded.sessionId)
            const child = db.drizzle
              .select()
              .from(sessions)
              .all()
              .find((row) => row.id === sideChatId)
            return {
              parentStatus: parent?.status,
              parentArchived: Boolean(parent?.archivedAt),
              childStatus: child?.status,
              childArchived: Boolean(child?.archivedAt),
            }
          } finally {
            db.close()
          }
        })
        .toEqual({
          parentStatus: 'archived',
          parentArchived: true,
          childStatus: 'archived',
          childArchived: true,
        })

      const archiveNotice = window.getByRole('region', { name: 'Archive results', exact: true })
      await expect(archiveNotice).toBeVisible()
      await archiveNotice.getByRole('button', { name: 'View', exact: true }).click()
      await archiveNotice
        .getByRole('button', { name: `Undo archive of ${seeded.sessionTitle}`, exact: true })
        .click()
      await expect(parentSidebarButton).toBeVisible()

      await expect
        .poll(() => {
          const db = ReadonlyFixtureDatabase.open(fixture)
          try {
            const parent = db.drizzle
              .select()
              .from(sessions)
              .all()
              .find((row) => row.id === seeded.sessionId)
            const child = db.drizzle
              .select()
              .from(sessions)
              .all()
              .find((row) => row.id === sideChatId)
            return {
              parentArchived: Boolean(parent?.archivedAt),
              childArchived: Boolean(child?.archivedAt),
              childLastOpenedOrdinal: child?.lastOpenedOrdinal ?? null,
            }
          } finally {
            db.close()
          }
        })
        .toEqual({
          parentArchived: false,
          childArchived: false,
          childLastOpenedOrdinal: null,
        })

      await expect(
        navigation.getByRole('button', { name: 'Title from the authorized Turn', exact: true }),
      ).toHaveCount(0)
      await parentSidebarButton.click()
      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      await expect(listRow).toContainText('Title from the authorized Turn')
      await expect(listRow).toContainText('Part 1 saved.')
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'places @Main below @claude in side chat autocomplete and syncs takeaways back to main chat',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined

    try {
      const seeded = await seedParentSession(fixture, {
        projectName: 'side-chat-main-sync',
        sessionTitle: 'Main sync target session',
        lockTitle: true,
      })
      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      await openSeededSession(window, seeded.sessionTitle)

      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      const activeStage = sideChatsPanel.locator('[data-stage-state="active"]')

      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      await activeStage.getByRole('button', { name: 'New side chat', exact: true }).click()
      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()

      const sideComposer = activeStage.getByRole('combobox', { name: 'Message' })
      await sideComposer.click()
      await sideComposer.fill('@')

      const recipients = activeStage.getByRole('listbox', { name: 'Message recipients' })
      await expect(recipients).toBeVisible()
      const optionTexts = await recipients.getByRole('option').allInnerTexts()
      const claudeIndex = optionTexts.findIndex((text) => text.includes('@claude'))
      const allIndex = optionTexts.findIndex((text) => text.includes('@all'))
      const mainIndex = optionTexts.findIndex((text) => text.includes('@Main'))
      expect(claudeIndex).toBeGreaterThanOrEqual(0)
      expect(allIndex).toBe(claudeIndex + 1)
      expect(mainIndex).toBe(allIndex + 1)

      const claudeOption = recipients.getByRole('option', { name: /^Claude Code/u })
      const mainOption = recipients.getByRole('option', { name: /^Main chat/u })
      const claudeBounds = await claudeOption.boundingBox()
      const mainBounds = await mainOption.boundingBox()
      expect(claudeBounds).not.toBeNull()
      expect(mainBounds).not.toBeNull()
      expect(mainBounds!.y).toBeGreaterThan(claudeBounds!.y)

      await mainOption.click()
      await expect(recipients).toBeHidden()
      await expect(sideComposer).toHaveText('@Main ')

      const sendToMainButton = activeStage.getByRole('button', {
        name: 'Send to main',
        exact: true,
      })
      await expect(sendToMainButton).toBeVisible()
      await expect(sendToMainButton).toBeEnabled()

      await window.keyboard.insertText('Keep the IPC boundary strict.')
      await sendToMainButton.click()

      const syncBar = activeStage.locator('.pact-side-chat-sync-bar')
      await expect(syncBar).toBeVisible()
      await expect(syncBar).toContainText('Sent to main chat')
      const viewButton = syncBar.getByRole('button', { name: 'View', exact: true })
      await expect(viewButton).toBeVisible()
      await expect(sideComposer).toBeEmpty()

      await expect(mainWorkspace.getByText('Keep the IPC boundary strict.')).toBeVisible()
      await expect(
        mainWorkspace.getByRole('button', { name: 'From side chat', exact: true }),
      ).toBeVisible()
      await expect(mainWorkspace.getByText('Bounded lifecycle response.')).toBeVisible()

      await viewButton.click()
      await expect(mainWorkspace.getByText('Keep the IPC boundary strict.')).toBeVisible()

      const [sideChat] = readSideChatRows(fixture, seeded.sessionId)
      expect(sideChat).toBeDefined()
      const db = ReadonlyFixtureDatabase.open(fixture)
      try {
        const mainConversation = db.conversationRepository.read(seeded.sessionId)
        const syncedMessage = mainConversation.messages.find(
          (message) =>
            message.role === 'user' && message.content === 'Keep the IPC boundary strict.',
        )
        expect(syncedMessage?.originSideChat).toMatchObject({
          sideChatId: sideChat!.id,
          sideChatTitle: 'New side chat',
        })
      } finally {
        db.close()
      }
      expect(
        readCutoffRows(fixture).some(
          (cutoff) => cutoff.ownerKind === 'sync_main' && cutoff.sourceSessionId === sideChat!.id,
        ),
      ).toBe(true)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)
