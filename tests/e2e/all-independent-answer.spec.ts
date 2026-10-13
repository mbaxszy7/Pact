import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'secondary omits this @all primary answer and receives it on its next task',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      codexAppServer: 'handoff_echo',
      claudeConversation: 'complete',
    })
    const directory = await fixture.createProjectDirectory('all-independent-answer')
    const sessionId = randomUUID(),
      projectId = randomUUID(),
      createdAt = new Date().toISOString()
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    try {
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'All answers',
        directoryPath: directory,
        kind: 'git',
        createdAt,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'Independent answers', createdAt },
        {
          primaryAgentId: 'claude',
          agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          runningMessagePolicy: 'next_round',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      const prior = db.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Old question',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      for (const event of [
        { agentId: 'claude', type: 'session.started', nativeSessionId: 'claude-fixture-session' },
        { agentId: 'claude', type: 'turn.started', turnId: prior.run.id },
        {
          agentId: 'claude',
          type: 'text.completed',
          turnId: prior.run.id,
          outputId: 'old-answer',
          text: 'Old answer',
        },
        { agentId: 'claude', type: 'turn.completed', turnId: prior.run.id, outcome: 'completed' },
      ] as const)
        db.conversationRepository.applyEvent(sessionId, prior.run.id, event)
    } finally {
      db.close()
    }
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Independent answers', exact: true }).click()
      const userMessageId = randomUUID()
      const sent = await window.evaluate(
        async ({ sessionId: targetSessionId, userMessageId: targetMessageId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const page = await bridge.getConversation({ scope: 'drafts', sessionId: targetSessionId })
          if (!page.ok || page.value.scope !== 'drafts') throw new Error('Missing drafts')
          return bridge.sendConversationMessage({
            sessionId: targetSessionId,
            clientMessageId: targetMessageId,
            content: 'Current shared task',
            route: { type: 'all' },
            expectedCommentsRevision: page.value.commentsRevision,
            commentIds: [],
          })
        },
        { sessionId, userMessageId },
      )
      expect(sent.ok).toBe(true)
      await expect(
        window.getByText('Handoff received: user:Old question | claude:Old answer', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 10_000 })
      expect((await fixture.readClaudeFacts()).count).toBe(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      const next = await window.evaluate(
        async ({ sessionId: targetSessionId, clientMessageId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const page = await bridge.getConversation({ scope: 'drafts', sessionId: targetSessionId })
          if (!page.ok || page.value.scope !== 'drafts') throw new Error('Missing drafts')
          return bridge.sendConversationMessage({
            sessionId: targetSessionId,
            clientMessageId,
            content: 'Next task',
            route: { type: 'agent', agentId: 'codex' },
            expectedCommentsRevision: page.value.commentsRevision,
            commentIds: [],
          })
        },
        { sessionId, clientMessageId: randomUUID() },
      )
      expect(next.ok).toBe(true)
      await expect(
        window.getByText('Handoff received: claude:Claude fixture response.', { exact: true }),
      ).toBeVisible({ timeout: 10_000 })
      expect((await fixture.readClaudeFacts()).count).toBe(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(2)
      const answers = await window.evaluate(
        async ({ sessionId: targetSessionId, userMessageId: targetMessageId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const page = await bridge.getConversation({
            scope: 'messages',
            sessionId: targetSessionId,
          })
          if (!page.ok || page.value.scope !== 'messages') throw new Error('Missing messages')
          return page.value.messages
            .filter((entry) => entry.message.replyToMessageId === targetMessageId)
            .map((entry) => entry.message.agentId)
        },
        { sessionId, userMessageId },
      )
      expect(answers).toEqual(['claude', 'codex'])
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)
