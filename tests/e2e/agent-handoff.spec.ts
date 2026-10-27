import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DefaultSessionSettings, DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  agentRuns,
  conversationMessages,
  nativeRebuildOperations,
} from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

test(
  '@all preserves ordered distinct Agent rows while the second response is pending',
  { tag: '@deterministic' },
  async ({ browserName: _browserName }, testInfo) => {
    const fixture = await createRuntimeFixture({
      codexAppServer: 'retry_progress',
      claudeConversation: 'complete',
    })
    const directory = await fixture.createProjectDirectory('all-native-agents')
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await createAgentSession(app, window, directory, 'all-native-agents')
      await sendAll(window, 'Answer in order')
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect
        .poll(async () =>
          window.locator('[data-pact-row-key]').evaluateAll((nodes) => {
            const keys = nodes.map((node) => node.getAttribute('data-pact-row-key') ?? '')
            return {
              codex: keys.some((key) => key.startsWith('reply:') && key.split(':')[2] === 'codex'),
              claude: keys.some(
                (key) => key.startsWith('reply:') && key.split(':')[2] === 'claude',
              ),
              unique: new Set(keys).size === keys.length,
            }
          }),
        )
        .toEqual({ codex: true, claude: true, unique: true })
      await expect(window.getByText('Claude fixture response.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      expect(
        await window
          .locator('article[data-pact-speaker="codex"], article[data-pact-speaker="claude"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-pact-speaker'))),
      ).toEqual(['codex', 'claude'])
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      expect((await fixture.readClaudeFacts()).count).toBe(1)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } catch (error) {
      await fixture.captureUiFailure(testInfo).catch(() => undefined)
      throw error
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'a new explicit Claude request after @all does not rerun the confirmed Codex peer',
  { tag: '@deterministic' },
  async ({ browserName: _browserName }, testInfo) => {
    const fixture = await createRuntimeFixture({
      codexAppServer: 'complete',
      claudeConversation: 'failure_once',
    })
    const directory = await fixture.createProjectDirectory('all-agent-retry')
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await createAgentSession(app, window, directory, 'all-agent-retry')
      await sendAll(window, 'Keep each Agent independent')
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect(window.getByRole('button', { name: 'Reexecute…', exact: true })).toHaveCount(0)
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('@claude')
      await window.getByRole('option', { name: /^Claude Code/u }).click()
      await composer.press('End')
      await composer.pressSequentially('New independently authorized task')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await composer.press('Enter')
      await expect(window.getByText('Claude fixture response.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      expect((await fixture.readClaudeFacts()).count).toBe(2)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } catch (error) {
      // Capture the actual Electron target before finally closes it; preserve the original failure.
      await fixture.captureUiFailure(testInfo).catch(() => undefined)
      throw error
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

async function createAgentSession(
  app: ElectronApplication,
  window: Page,
  directory: string,
  projectName: string,
): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Reflect.set(dialog, 'showOpenDialog', async () => ({
      canceled: false,
      filePaths: [selectedPath],
    }))
  }, directory)
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  await window.getByRole('button', { name: `New Session in ${projectName}` }).focus()
  await window.getByRole('button', { name: `New Session in ${projectName}` }).click()
  await window.getByRole('button', { name: 'Create Session' }).click()
}

async function sendAll(window: Page, content: string): Promise<void> {
  const composer = window.getByRole('combobox', { name: 'Message' })
  await composer.fill('@all')
  await window.getByRole('option', { name: /^All/u }).click()
  await expect.poll(() => composer.textContent()).toBe('@all ')
  await window.evaluate(
    () => new Promise<void>((nextFrame) => requestAnimationFrame(() => nextFrame())),
  )
  await composer.press('End')
  await composer.pressSequentially(content)
  await composer.press('Enter')
}

test(
  'supplies every intervening peer question and answer to the next Agent',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'handoff_echo' })
    const projectDirectory = await fixture.createProjectDirectory('cross-agent-handoff')
    const sessionId = randomUUID()
    const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Cross-Agent Handoff',
        directoryPath: projectDirectory,
        kind: 'git',
        createdAt: '2026-09-29T00:00:00.000Z',
      })
      database.sessionRepository.create(
        {
          id: sessionId,
          projectId,
          title: 'Handoff Session',
          createdAt: '2026-09-29T00:00:00.000Z',
        },
        settings,
      )
      for (const [index, question, answer] of [
        [1, 'First question', 'First answer'],
        [2, 'Second question', 'Second answer'],
      ] as const) {
        const drafts = database.conversationRepository.readPage({ scope: 'drafts', sessionId })
        if (drafts.scope !== 'drafts') throw new Error('Missing draft page')
        const started = database.conversationRepository.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: question,
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
          agentId: 'claude',
          settingsRevision: 1,
          model: null,
          effort: null,
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'claude',
          type: 'session.started',
          nativeSessionId: 'claude-fixture-session',
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'claude',
          type: 'turn.started',
          turnId: `claude-turn-${index}`,
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'claude',
          type: 'text.completed',
          turnId: `claude-turn-${index}`,
          outputId: `claude-answer-${index}`,
          text: answer,
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'claude',
          type: 'turn.completed',
          turnId: `claude-turn-${index}`,
          outcome: 'completed',
        })
      }
    } finally {
      database.close()
    }

    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Handoff Session', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Review the full handoff')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled({
        timeout: 30_000,
      })
      await composer.press('Enter')
      await expect(
        window.getByText(
          'Handoff received: user:First question | claude:First answer | user:Second question | claude:Second answer',
        ),
      ).toBeVisible({ timeout: 10_000 })
      await expect(
        window.getByText('Context supplied · 4 messages involving Claude Code'),
      ).toBeVisible()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'size and source-read failures show distinct top Error Toasts without losing the draft',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'complete_title_silent' })
    const directory = await fixture.createProjectDirectory('handoff-errors')
    const sessionId = randomUUID()
    const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Handoff errors',
        directoryPath: directory,
        kind: 'git',
        createdAt: '2026-09-29T00:00:00.000Z',
      })
      database.sessionRepository.create(
        { id: sessionId, projectId, title: 'Error Session', createdAt: '2026-09-29T00:00:00.000Z' },
        settings,
      )
    } finally {
      database.close()
    }
    const app = await fixture.launch()
    let savedMessageCount: number | undefined
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Error Session', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Keep this draft')
      for (const [code, copy] of [
        ['CONTEXT_TOO_LARGE', 'The full context is too large to send. Your draft is still here.'],
        [
          'CONTEXT_UNAVAILABLE',
          "Pact couldn't load the required context. Your draft is still here.",
        ],
      ] as const) {
        // The Utility Interface is tested separately; this real Electron path
        // verifies the typed Main/Preload/Renderer error presentation.
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each second Send starts after the previous Toast is visible.
        await app.evaluate(({ ipcMain }, failureCode) => {
          ipcMain.removeHandler('pact:conversation:send')
          ipcMain.handle('pact:conversation:send', () => ({
            ok: false,
            error: { code: failureCode, message: 'Fixture failure' },
          }))
        }, code)
        // oxlint-disable-next-line eslint/no-await-in-loop -- These are two sequential user actions in one App.
        await composer.press('Enter')
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the delivered error before replacing the handler.
        await expect(window.locator('[data-pact-toast-tone="error"]')).toContainText(copy)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Draft ownership is checked after each failure.
        await expect.poll(() => composer.textContent()).toBe('Keep this draft')
      }
    } finally {
      await quitPact(app)
      try {
        const persisted = await PactDatabase.open({
          filePath: fixture.databaseFile,
          migrationsFolder,
        })
        try {
          const page = persisted.conversationRepository.readPage({ scope: 'messages', sessionId })
          savedMessageCount = page.scope === 'messages' ? page.messages.length : undefined
        } finally {
          persisted.close()
        }
      } finally {
        await fixture.dispose()
      }
    }
    expect(savedMessageCount).toBe(0)
  },
)

test(
  'a background context-window refusal shows one top Error Toast and keeps the failed Run',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'context_limit' })
    const directory = await fixture.createProjectDirectory('context-limit-notice')
    const firstId = randomUUID()
    const secondId = randomUUID()
    const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Context Limit',
        directoryPath: directory,
        kind: 'git',
        createdAt: '2026-09-29T00:00:00.000Z',
      })
      for (const [id, title] of [
        [firstId, 'First Session'],
        [secondId, 'Second Session'],
      ] as const) {
        database.sessionRepository.create(
          { id, projectId, title, createdAt: '2026-09-29T00:00:00.000Z' },
          settings,
        )
      }
    } finally {
      database.close()
    }
    const app = await fixture.launch()
    let latestRun: unknown
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'First Session', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('This context may be rejected')
      await composer.press('Enter')
      await window.getByRole('button', { name: 'Second Session', exact: true }).click()
      await expect(window.locator('[data-pact-toast-tone="error"]')).toContainText(
        'The context was too large for the Agent',
        { timeout: 10_000 },
      )
    } finally {
      await quitPact(app)
      try {
        const persisted = await PactDatabase.open({
          filePath: fixture.databaseFile,
          migrationsFolder,
        })
        try {
          const page = persisted.conversationRepository.readPage({
            scope: 'messages',
            sessionId: firstId,
          })
          latestRun = page.scope === 'messages' ? page.header.latestRun : undefined
        } finally {
          persisted.close()
        }
      } finally {
        await fixture.dispose()
      }
    }
    expect(latestRun).toMatchObject({ status: 'failed', failureKind: 'context_limit' })
  },
)

test(
  'a missing Native Session preserves the draft, locks input, and rebuilds in place',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'native_context_recovery' })
    const directory = await fixture.createProjectDirectory('native-context-recovery')
    const sessionId = randomUUID()
    let originalRunId = ''
    const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      const projectId = randomUUID()
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Native recovery',
        directoryPath: directory,
        kind: 'git',
        createdAt: '2026-09-29T00:00:00.000Z',
      })
      database.sessionRepository.create(
        {
          id: sessionId,
          projectId,
          title: 'Recovery Session',
          createdAt: '2026-09-29T00:00:00.000Z',
        },
        settings,
      )
      const drafts = database.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft page')
      const started = database.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Question saved before the Native Session disappeared',
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      originalRunId = started.run.id
      for (const event of [
        { agentId: 'codex', type: 'session.started', nativeSessionId: 'missing-thread' },
        { agentId: 'codex', type: 'turn.started', turnId: 'original-turn' },
        {
          agentId: 'codex',
          type: 'text.completed',
          turnId: 'original-turn',
          outputId: 'original-answer',
          text: 'Answer saved in Pact.',
        },
        { agentId: 'codex', type: 'turn.completed', turnId: 'original-turn', outcome: 'completed' },
      ] as const)
        database.conversationRepository.applyEvent(sessionId, started.run.id, event)
      database.conversationRepository.recordNativeEvidence({
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
        identity: {
          sessionId,
          agentId: 'codex',
          runId: started.run.id,
          requestId: started.run.id,
          nativeSessionId: 'missing-thread',
          nativeTurnId: 'original-turn',
          bindingGeneration: 1,
        },
      })
      database.conversationRepository.settleKnownNativeEnding(started.run.id)
    } finally {
      database.close()
    }

    let app = await fixture.launch()
    try {
      let window = await app.firstWindow()
      await window.getByRole('button', { name: 'Recovery Session', exact: true }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Keep this unsent draft')
      await window.evaluate(
        async ({ sessionId: requestedSessionId, runId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          await bridge.retryConversationRun(runId, {
            sessionId: requestedSessionId,
            agentId: 'codex',
            intent: 'inspect',
          })
        },
        { sessionId, runId: originalRunId },
      )
      await expect(window.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
      await expect(window.getByRole('region', { name: 'Session recovery' })).toBeVisible()
      expect((await fixture.readCodexFacts()).threadStarts).toBe(0)
      await expect.poll(() => composer.textContent()).toBe('Keep this unsent draft')
      await expect(composer).toBeDisabled()

      await window.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await expect(
        window.getByRole('button', { name: 'Confirm rebuild', exact: true }),
      ).toBeVisible()
      expect((await fixture.readCodexFacts()).threadStarts).toBe(0)
      await window.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(window.getByText('Codex native session rebuilt', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect(window.getByRole('region', { name: 'Session recovery' })).toHaveCount(0)
      await expect(composer).toBeEnabled()
      await expect.poll(() => composer.textContent()).toBe('Keep this unsent draft')
      await expect(window.getByText('Codex native session rebuilt', { exact: true })).toHaveCount(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
      expect((await fixture.readCodexFacts()).threadStarts).toBe(1)
      await quitPact(app)
      app = await fixture.launch()
      window = await app.firstWindow()
      await window.getByRole('button', { name: 'Recovery Session', exact: true }).click()
      const checked = await window.evaluate(async (requestedSessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.retryConversationRun(requestedSessionId, {
          sessionId: requestedSessionId,
          agentId: 'codex',
          intent: 'inspect',
        })
        return result.ok
      }, sessionId)
      expect(checked).toBe(true)
      await expect(window.getByText('Codex native session rebuilt', { exact: true })).toHaveCount(1)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
    } finally {
      await quitPact(app)
    }

    const persisted = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    try {
      const page = persisted.conversationRepository.readPage({ scope: 'messages', sessionId })
      if (page.scope !== 'messages') throw new Error('Missing message page')
      expect(page.messages.filter((entry) => entry.message.role === 'user')).toHaveLength(1)
      expect(page.header.nativeContexts).toMatchObject([
        {
          agentId: 'codex',
          nativeSessionId: 'rebuilt-thread',
          state: 'active',
          continuationState: 'ready',
          bindingGeneration: 2,
          rebuildMessageCount: 2,
        },
      ])
    } finally {
      persisted.close()
      await fixture.dispose()
    }
  },
)

test(
  'a failed candidate check offers one confirmed creation and never dispatches the old task',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'native_context_recovery' })
    const directory = await fixture.createProjectDirectory('candidate-recovery')
    const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      operationId = randomUUID(),
      now = new Date().toISOString()
    try {
      database.projectCatalogRepository.add({
        id: projectId,
        name: 'Candidate recovery',
        kind: 'git',
        directoryPath: directory,
        createdAt: now,
      })
      database.sessionRepository.create(
        { id: sessionId, projectId, title: 'Unconfirmed candidate', createdAt: now },
        settings,
      )
      const run = database.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Original task remains saved',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      }).run
      database.conversationRepository.failRun(
        run.id,
        'agent_process_crash',
        'Input was not sent.',
        false,
      )
      database.conversationRepository.beginNativeRebuild({
        id: operationId,
        sessionId,
        agentId: 'codex',
        expectedGeneration: 1,
        abandon: false,
      })
      database.conversationRepository.freezeNativeRebuildSource(operationId, [
        {
          kind: 'message',
          messageId: run.userMessageId,
          sequence: 0,
          speaker: 'user',
          state: 'complete',
          part: 0,
          final: true,
          content: 'Original task remains saved',
        },
      ])
      database.conversationRepository.markNativeRebuildDispatched(operationId)
      database.conversationRepository.recordNativeRebuildIdentity(
        operationId,
        'unconfirmed-candidate',
      )
      database.conversationRepository.failNativeRebuild(operationId, 'Initialization reply lost.')
    } finally {
      database.close()
    }
    const app = await fixture.launch()
    let appClosed = false
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Unconfirmed candidate', exact: true }).click()
      const card = window.getByRole('region', { name: 'Session recovery' })
      await expect(card).toHaveCount(1)
      await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      await card.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(card.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible()
      await expect(card.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
      expect((await fixture.readCodexFacts()).threadStarts).toBe(0)
      const warningPath = test.info().outputPath('candidate-check-failed.png')
      await window.screenshot({ path: warningPath })
      await test
        .info()
        .attach('candidate-check-failed', { path: warningPath, contentType: 'image/png' })
      await card.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await expect(
        card.getByText('The previous attempt may already have created a session.'),
      ).toBeVisible()
      await expect(card.getByText('Pact couldn’t confirm the new session.')).toHaveCount(0)
      const confirmationPath = test.info().outputPath('candidate-confirmation.png')
      await window.screenshot({ path: confirmationPath })
      await test
        .info()
        .attach('candidate-confirmation', { path: confirmationPath, contentType: 'image/png' })
      expect((await fixture.readCodexFacts()).threadStarts).toBe(0)
      await card.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(window.getByText('Codex native session rebuilt', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
      expect((await fixture.readCodexFacts()).threadStarts).toBe(1)
      await expect
        .poll(() => window.getByRole('combobox', { name: 'Message' }).textContent())
        .toBe('Original task remains saved')
      await expect(
        window
          .getByRole('region', { name: 'Conversation messages' })
          .getByText('Original task remains saved', { exact: true }),
      ).toHaveCount(0)
      const returned = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const history = await bridge.getConversation({ scope: 'messages', sessionId: id })
        if (!history.ok || history.value.scope !== 'messages')
          throw new Error('History unavailable')
        return history.value.header.rebuildInputRecovery
      }, sessionId)
      expect(returned?.route).toEqual({ type: 'primary', agentId: 'codex' })
      expect(returned?.state).toBe('installed')
      await quitPact(app)
      appClosed = true
      const persisted = await PactDatabase.open({
        filePath: fixture.databaseFile,
        migrationsFolder,
      })
      try {
        const original = persisted.drizzle
          .select()
          .from(conversationMessages)
          .all()
          .find((message) => message.id === returned?.messageId)
        expect(original).toMatchObject({ content: 'Original task remains saved', isVisible: false })
        const originalRun = persisted.drizzle
          .select()
          .from(agentRuns)
          .all()
          .find((run) => run.userMessageId === original?.id)
        expect(originalRun).toMatchObject({ status: 'failed', dispatchPhase: 'not_sent' })
        const completed = persisted.drizzle
          .select()
          .from(nativeRebuildOperations)
          .all()
          .filter((operation) => operation.stage === 'completed')
        expect(completed).toHaveLength(1)
        expect(completed[0]?.sourceChunksJson).toBe('[]')
      } finally {
        persisted.close()
      }
    } finally {
      if (!appClosed) await quitPact(app)
      await fixture.dispose()
    }
  },
)
