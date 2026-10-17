import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import type { ConversationSnapshot } from '../../packages/contracts/src/index.js'

import { quitPact } from './native-quit.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  selectRealSession,
  waitForRealCompletion,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

test(
  'real @all completes each Agent once and keeps ordered distinct response rows',
  { tag: ['@real', '@real-core'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-all')
    try {
      const marker = `ALL_${randomUUID()}`
      await sendRealMessage(
        ctx,
        `Reply briefly acknowledging ${marker}. Do not use tools, read files or write files.`,
        'all',
      )
      const completed = await waitForRealCompletion(ctx, 2)
      expect(completed.runs.map((run) => run.agentId)).toEqual(['codex', 'claude'])
      expect(new Set(completed.runs.map((run) => run.id)).size).toBe(2)
      expect(completed.runs.every((run) => run.status === 'completed')).toBe(true)
      expect(completed.runs.every((run) => run.peerProposal === undefined)).toBe(true)
      expect(completed.runs.every((run) => Boolean(run.nativeSessionId))).toBe(true)
      const answers = completed.messages
        .filter((message) => message.role === 'assistant')
        .toSorted((left, right) => left.sequence - right.sequence)
      expect(answers.map((message) => message.agentId)).toEqual(['codex', 'claude'])
      expect(answers.every((message) => message.state === 'complete')).toBe(true)
      for (const answer of answers) expect(answer.content).toContain(marker)
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toHaveCount(1)
      await expect(ctx.page.locator('article[data-pact-speaker="claude"]')).toHaveCount(1)
      const rows = await ctx.page
        .locator('[data-pact-row-key]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-pact-row-key')))
      expect(new Set(rows).size).toBe(rows.length)
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real Claude follow-ups do not rerun Codex and both peer answers reach its next task',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-peer-history')
    try {
      await sendRealMessage(
        ctx,
        'Acknowledge this conversation briefly. Do not use tools, read files or write files.',
        'all',
      )
      const initial = await waitForRealCompletion(ctx, 2)
      const codexRun = initial.runs.find((run) => run.agentId === 'codex')
      expect(codexRun).toBeDefined()
      if (!codexRun?.nativeSessionId)
        throw new Error('The initial real Codex binding is unavailable')
      const questions: Array<{ label: string; word: string }> = []
      for (let index = 0; index < 2; index += 1) {
        const label = `PEER_${randomUUID()}`
        // oxlint-disable-next-line no-await-in-loop -- Each real reply must complete before the next conversation turn.
        await sendRealMessage(
          ctx,
          `Reply with the label ${label}, a colon, and one newly invented short lowercase word, different from your earlier word, and no explanation. Do not use tools, read files or write files.`,
          'claude',
        )
        // oxlint-disable-next-line no-await-in-loop -- Observe each completed turn before submitting the next one.
        const completed = await waitForRealCompletion(ctx, 3 + index)
        expect(
          completed.runs.filter((run) => run.agentId === 'codex').map((run) => run.id),
        ).toEqual([codexRun.id])
        const claudeRuns = completed.runs.filter((run) => run.agentId === 'claude')
        expect(claudeRuns).toHaveLength(2 + index)
        const answer = responseFor(completed, claudeRuns.at(-1)?.id)
        expect(answer).toContain(label)
        const generatedWords = answer.replaceAll(label, '').match(/\b[a-z]{4,32}\b/gu)
        const generatedWord = generatedWords?.at(-1)
        expect(
          generatedWord,
          'The actual peer answer must provide a value absent from its question',
        ).toBeTruthy()
        if (!generatedWord) throw new Error('Claude answer value is unavailable')
        questions.push({ label, word: generatedWord })
      }
      // The request supplies neither question markers nor Claude-generated values.
      await sendRealMessage(
        ctx,
        'Report both PEER labels and their answer words from the last two Claude replies. Do not use tools, read files or write files.',
        'codex',
      )
      const completed = await waitForRealCompletion(ctx, 5)
      const codexRuns = completed.runs.filter((run) => run.agentId === 'codex')
      expect(codexRuns).toHaveLength(2)
      expect(completed.runs.filter((run) => run.agentId === 'claude')).toHaveLength(3)
      const recalled = responseFor(completed, codexRuns.at(-1)?.id)
      for (const { label, word } of questions) {
        expect(recalled).toContain(label)
        expect(recalled).toContain(word)
      }
      const finalBinding = completed.nativeContexts.find((context) => context.agentId === 'codex')
      expect(finalBinding?.nativeSessionId).toBe(codexRun.nativeSessionId)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real Native first title accepts an IPC rename and cold resume preserves title and identity',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-native-title')
    try {
      const firstMarker = `FIRST_${randomUUID()}`
      await sendRealMessage(
        ctx,
        `Briefly explain why typed IPC separates privileges and acknowledge ${firstMarker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const first = await waitForRealCompletion(ctx, 1)
      const nativeSessionId = first.nativeContexts.find(
        (context) => context.agentId === 'codex',
      )?.nativeSessionId
      expect(nativeSessionId).toBeTruthy()
      expect(responseFor(first, first.runs[0]?.id)).toContain(firstMarker)
      // App-server 0.159.2 does not promise an automatic name. Exercise an
      // actual Native rename while its writer is closed, then a fresh resume.
      expect(['local', 'agent']).toContain(first.session.titleSource)
      await quitPact(ctx.app)
      const native = await ctx.fixture.openCodexClient()
      const resumed = await native.request('thread/resume', {
        threadId: nativeSessionId,
        cwd: ctx.projectDirectory,
      })
      expect(resumed.error).toBeUndefined()
      const nativeTitle = `Native first title ${randomUUID()}`
      const named = await native.request('thread/name/set', {
        threadId: nativeSessionId,
        name: nativeTitle,
      })
      expect(named.error).toBeUndefined()
      await native.close()
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, ctx.sessionId)
      await sendRealMessage(
        ctx,
        'Acknowledge the independently named Native conversation. Do not use tools.',
        'codex',
      )
      const namedSnapshot = await waitForRealCompletion(ctx, 2)
      // A Pact title reported in the first Turn is already the durable source of truth.
      const expectedTitle =
        first.session.titleSource === 'agent' ? first.session.title : nativeTitle
      expect(namedSnapshot.session).toMatchObject({ title: expectedTitle, titleSource: 'agent' })

      const userTitle = `Saved title ${randomUUID()}`
      await ctx.page.getByRole('heading', { name: expectedTitle, exact: true }).hover()
      await ctx.page.getByRole('button', { name: 'Rename Session', exact: true }).click()
      await ctx.page.getByRole('textbox', { name: 'Session title' }).fill(userTitle)
      await ctx.page.getByRole('button', { name: 'Save Session title' }).click()
      await expect(ctx.page.getByRole('heading', { name: userTitle, exact: true })).toBeVisible()
      const saved = await readRealConversation(ctx)
      expect(saved.session).toMatchObject({ title: userTitle, titleSource: 'user' })
      expect(saved.runs).toHaveLength(2)

      await restartRealWorkspace(ctx)
      const reopened = await readRealConversation(ctx)
      expect(reopened.session).toMatchObject({ title: userTitle, titleSource: 'user' })
      expect(
        reopened.nativeContexts.find((context) => context.agentId === 'codex')?.nativeSessionId,
      ).toBe(nativeSessionId)
      expect(reopened.runs.map((run) => run.id)).toEqual(saved.runs.map((run) => run.id))

      const secondMarker = `SECOND_${randomUUID()}`
      await sendRealMessage(
        ctx,
        `Acknowledge the new task ${secondMarker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const completed = await waitForRealCompletion(ctx, 3)
      expect(completed.session).toMatchObject({ title: userTitle, titleSource: 'user' })
      expect(completed.runs.map((run) => run.agentId)).toEqual(['codex', 'codex', 'codex'])
      expect(new Set(completed.runs.map((run) => run.id)).size).toBe(3)
      expect(completed.runs.every((run) => run.nativeSessionId === nativeSessionId)).toBe(true)
      expect(responseFor(completed, completed.runs.at(-1)?.id)).toContain(secondMarker)
      expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(3)
      expect(completed.messages.filter((message) => message.role === 'assistant')).toHaveLength(3)
      await expect(ctx.page.getByRole('heading', { name: userTitle, exact: true })).toBeVisible()
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

function responseFor(snapshot: ConversationSnapshot, runId: string | undefined): string {
  if (!runId) throw new Error('Completed real Run identity is unavailable')
  const answer = snapshot.messages.find(
    (message) => message.role === 'assistant' && message.runId === runId,
  )
  if (!answer || answer.state !== 'complete')
    throw new Error('Completed real Agent answer is unavailable')
  return answer.content
}
