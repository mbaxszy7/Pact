import { expect } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { agentRuns, conversationMessages } from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const createdAt = '2026-10-04T00:00:00.000Z'
const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
async function seed(fixture: RuntimeFixture, both: boolean, commit: boolean) {
  const projectDirectory = await fixture.createProjectDirectory('fork-project', false)
  const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  try {
    const projectId = randomUUID(),
      sourceId = randomUUID(),
      messageIds = Array.from({ length: both ? 4 : 2 }, () => randomUUID()),
      runIds = [randomUUID(), randomUUID()]
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Fork project',
      directoryPath: projectDirectory,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sourceId, projectId, title: 'Fork source', createdAt },
      {
        primaryAgentId: 'codex',
        agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
        maxDiscussionRounds: 3,
        maxReviewCycles: 2,
        maxRepairAttempts: 2,
      },
    )
    for (const [index, agentId] of (both
      ? (['claude', 'codex'] as const)
      : (['claude'] as const)
    ).entries())
      db.drizzle
        .insert(agentRuns)
        .values({
          id: runIds[index]!,
          sessionId: sourceId,
          userMessageId: messageIds[index * 2]!,
          agentId,
          status: 'completed',
          attemptCount: 1,
          settingsRevision: 1,
          model: null,
          effort: null,
          nativeSessionId: `fixture-${agentId}`,
          nativeTurnId: runIds[index]!,
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          dispatchPhase: 'ended',
          createdAt,
          updatedAt: createdAt,
        })
        .run()
    for (const [index, id] of messageIds.entries())
      db.drizzle
        .insert(conversationMessages)
        .values({
          id,
          sessionId: sourceId,
          runId: runIds[Math.floor(index / 2)]!,
          role: index % 2 ? 'assistant' : 'user',
          agentId: index % 2 ? (index === 1 ? 'claude' : 'codex') : null,
          content:
            index % 2 ? `Frozen ${index === 1 ? 'Claude' : 'Codex'} answer` : 'Original user task',
          state: 'complete',
          sequence: index,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
    if (!commit) return { sourceId }
    const source = db.sessionRepository.find(sourceId)!,
      selected = db.conversationRepository.selectForkSource(
        sourceId,
        messageIds[3]!,
        source.settings,
        source.settingsRevision,
      )
    const boundary = (agentId: 'claude' | 'codex', index: number) => ({
      nativeSessionId: `fixture-${agentId}`,
      nativeTurnId: runIds[index]!,
      nativeCutId: runIds[index]!,
      bindingGeneration: 1,
      throughSequence: index * 2 + 1,
      deliveryCursor: index * 2,
      prefixHash: createHash('sha256').update(agentId).digest('hex'),
      prefixRecords: 2,
      prefixBytes: 100,
    })
    return {
      sourceId,
      operation: db.conversationRepository.commitFork(
        randomUUID(),
        selected,
        { claude: boundary('claude', 0), codex: boundary('codex', 1) },
        [],
      ),
    }
  } finally {
    db.close()
  }
}
async function isolatedEnvironment(fixture: RuntimeFixture) {
  const root = join(dirname(fixture.databaseFile), 'claude-home')
  await mkdir(root, { recursive: true })
  return { CLAUDE_CONFIG_DIR: root }
}

/** Native files are synthetic; real Electron, IPC, repository, SDK file fork and Adapters execute. */
async function seedNativeSource(fixture: RuntimeFixture, resolvedModel: string) {
  const directory = await fixture.createProjectDirectory('native-fork-project', false)
  const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID(),
    sourceId = randomUUID(),
    nativeClaude = randomUUID(),
    claudeTurn = randomUUID(),
    claudeAnswer = randomUUID(),
    codexTurn = randomUUID(),
    messageIds = Array.from({ length: 4 }, () => randomUUID()),
    runIds = [randomUUID(), randomUUID()]
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Native fork project',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sourceId, projectId, title: 'Native fork source', createdAt },
      {
        primaryAgentId: 'codex',
        agents: {
          claude: { model: 'opus', effort: 'high' },
          codex: { model: 'gpt-fixture', effort: 'medium' },
        },
        maxDiscussionRounds: 3,
        maxReviewCycles: 2,
        maxRepairAttempts: 2,
      },
    )
    for (const [index, agentId] of (['claude', 'codex'] as const).entries()) {
      db.drizzle
        .insert(agentRuns)
        .values({
          id: runIds[index]!,
          sessionId: sourceId,
          userMessageId: messageIds[index * 2]!,
          agentId,
          status: 'completed',
          attemptCount: 1,
          settingsRevision: 1,
          model: agentId === 'claude' ? 'opus' : 'gpt-fixture',
          effort: agentId === 'claude' ? 'high' : 'medium',
          nativeSessionId: agentId === 'claude' ? nativeClaude : 'native-source-codex',
          nativeTurnId: agentId === 'claude' ? claudeTurn : codexTurn,
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          dispatchPhase: 'ended',
          createdAt,
          updatedAt: createdAt,
        })
        .run()
    }
    for (const [index, id] of messageIds.entries())
      db.drizzle
        .insert(conversationMessages)
        .values({
          id,
          sessionId: sourceId,
          runId: runIds[Math.floor(index / 2)]!,
          role: index % 2 ? 'assistant' : 'user',
          agentId: index % 2 ? (index === 1 ? 'claude' : 'codex') : null,
          content:
            index % 2 ? `Frozen ${index === 1 ? 'Claude' : 'Codex'} answer` : 'Original user task',
          state: 'complete',
          sequence: index,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
  } finally {
    db.close()
  }
  const projectKey = (await realpath(directory)).replace(/[^a-zA-Z0-9]/gu, '-')
  await mkdir(join(fixture.claudeHome, 'projects', projectKey), { recursive: true })
  await writeFile(
    join(fixture.claudeHome, 'projects', projectKey, nativeClaude + '.jsonl'),
    [
      {
        type: 'user',
        uuid: claudeTurn,
        parentUuid: null,
        sessionId: nativeClaude,
        timestamp: createdAt,
        cwd: directory,
        message: { role: 'user', content: 'Original user task' },
      },
      {
        type: 'assistant',
        uuid: claudeAnswer,
        parentUuid: claudeTurn,
        sessionId: nativeClaude,
        timestamp: createdAt,
        cwd: directory,
        message: {
          role: 'assistant',
          id: 'frozen-claude-answer',
          model: resolvedModel,
          content: [{ type: 'text', text: 'Frozen Claude answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  )
  const path = join(fixture.codexHome, 'sessions', 'source.jsonl')
  await writeFile(
    path,
    [
      { type: 'session_meta', payload: { id: 'native-source-codex', history_mode: 'legacy' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: codexTurn } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Original user task' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Frozen Codex answer' }],
        },
        metadata: { client_authored: false },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: codexTurn } },
    ]
      .map((record) => JSON.stringify({ timestamp: createdAt, ...record }) + '\n')
      .join(''),
  )
  await writeFile(
    join(dirname(fixture.databaseFile), 'codex-app-server-state.json'),
    JSON.stringify({
      methods: [],
      modelStarts: [],
      threadStarts: 0,
      threads: {
        'native-source-codex': {
          path,
          status: 'idle',
          model: 'gpt-fixture',
          reasoningEffort: 'medium',
          turns: [{ id: codexTurn, status: 'completed', error: null }],
          items: [],
        },
      },
    }),
  )
  return { sourceId, messageId: messageIds[3]! }
}

test(
  'rejects missing peer native history through the real Fork IPC without creating an empty side',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      await seed(fixture, false, false)
      app = await fixture.launch(await isolatedEnvironment(fixture))
      const page = await app.firstWindow()
      await page.getByRole('button', { name: 'Fork source', exact: true }).click()
      const answer = page.locator('article[data-pact-speaker="claude"]')
      await answer.hover()
      await expect(
        page
          .locator('article[data-pact-speaker="user"]')
          .getByRole('button', { name: 'Fork conversation from this reply' }),
      ).toHaveCount(0)
      const copy = await answer
          .getByRole('button', { name: 'Copy Claude Code message' })
          .boundingBox(),
        fork = await answer
          .getByRole('button', { name: 'Fork conversation from this reply' })
          .boundingBox()
      expect(copy).not.toBeNull()
      expect(fork).not.toBeNull()
      expect(fork!.x).toBeGreaterThan(copy!.x)
      await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      await expect(page.getByRole('dialog')).toContainText(/codex.*(?:history|source)/iu)
      await expect(page.getByRole('button', { name: 'Create fork', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await quitPact(app)
      app = undefined
      const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        expect(db.drizzle.select().from(agentRuns).all()).toHaveLength(1)
        expect(
          db.sessionRepository.readPage(db.projectCatalogRepository.read().projects[0]!.id)
            .sessions,
        ).toHaveLength(1)
      } finally {
        db.close()
      }
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)
test(
  'a committed fork survives startup with sidebar error, readable history and a locked Composer',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const seeded = await seed(fixture, true, true)
      app = await fixture.launch(await isolatedEnvironment(fixture))
      const page = await app.firstWindow()
      const child = page.getByRole('button', { name: 'Fork source (fork)', exact: true })
      await expect(child).toBeVisible()
      await child.click()
      await expect(page.getByText('Frozen Claude answer', { exact: true })).toBeVisible()
      await expect(page.getByText('Frozen Codex answer', { exact: true })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Continue native fork', exact: true }),
      ).toHaveCount(2)
      await quitPact(app)
      app = undefined
      const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        expect(db.sessionRepository.find(seeded.operation!.sessionId)!.activity.state).toBe('error')
        expect(db.conversationRepository.read(seeded.operation!.sessionId).messages).toHaveLength(4)
        expect(
          db.conversationRepository.nativeRecoveryBlocksInput(seeded.operation!.sessionId),
        ).toBe(true)
        expect(db.drizzle.select().from(agentRuns).all()).toHaveLength(4)
      } finally {
        db.close()
      }
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)

for (const resolvedModel of ['custom-fixture-one[1m]', 'custom-fixture-two']) {
  test(
    `full Fork UI initializes both providers without a model turn and resolves ${resolvedModel}`,
    { tag: '@deterministic' },
    async () => {
      test.setTimeout(120_000)
      const fixture = await createRuntimeFixture({
        claudeConversation: 'fork_complete',
        claudeResolvedModel: resolvedModel,
        codexAppServer: 'fork_complete',
      })
      let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
      try {
        const seeded = await seedNativeSource(fixture, resolvedModel)
        app = await fixture.launch()
        const page = await app.firstWindow()
        await page.getByRole('button', { name: 'Native fork source', exact: true }).click()
        const composer = page.getByRole('combobox', { name: 'Message', exact: true })
        await composer.fill('Keep the source draft')
        const answer = page.locator(`[data-pact-message-id="${seeded.messageId}"]`)
        await answer.hover()
        await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText(`${resolvedModel} — opus`)
        await expect(dialog).toContainText('high · Ask')
        await expect(dialog.getByRole('button', { name: 'Create fork', exact: true })).toBeEnabled()
        await dialog.getByRole('button', { name: 'Create fork', exact: true }).click()
        await expect(dialog).toHaveCount(0, { timeout: 25_000 })
        await expect.poll(() => composer.textContent()).toBe('')
        await expect(composer).toBeEnabled()
        await expect(page.getByRole('region', { name: 'Native fork confirmation' })).toHaveCount(0)
        await expect(page.getByText('Frozen Claude answer', { exact: true })).toBeVisible()
        await expect(page.getByText('Frozen Codex answer', { exact: true })).toBeVisible()
        expect(
          (await fixture.readCodexFacts()).methods.filter((method) => method === 'thread/fork'),
        ).toHaveLength(1)
        expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
        expect((await fixture.readClaudeFacts()).count).toBe(0)
        const snapshot = await page.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const catalog = await bridge.getProjectCatalog()
          if (!catalog.ok) throw new Error('Catalog unavailable')
          const sessions = await bridge.getSessionCatalog(catalog.value.projects[0]!.id)
          if (!sessions.ok) throw new Error('Session catalog unavailable')
          const child = sessions.value.sessions.find((session) => session.title.endsWith('(fork)'))
          if (!child) throw new Error('Fork child missing')
          const history = await bridge.getConversation({ scope: 'messages', sessionId: child.id })
          if (!history.ok || history.value.scope !== 'messages')
            throw new Error('Fork history unavailable')
          return {
            childId: child.id,
            ready: history.value.header.forkOperation?.ready,
            messages: history.value.messages.length,
          }
        })
        expect(snapshot.ready).toBe(true)
        expect(snapshot.messages).toBe(4)
        await page.getByRole('button', { name: 'Native fork source', exact: true }).click()
        await expect.poll(() => composer.textContent()).toBe('Keep the source draft')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await page.getByRole('button', { name: 'Native fork source (fork)', exact: true }).click()
        await composer.fill('@codex Continue only this branch')
        await composer.press('Enter')
        await expect(page.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible()
        expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
        await page.getByRole('button', { name: 'Native fork source', exact: true }).click()
        await expect(page.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(0)
        await expect.poll(() => composer.textContent()).toBe('Keep the source draft')
      } finally {
        if (app) await quitPact(app)
        await fixture.dispose()
      }
    },
  )
}

test(
  'failed initialization closes the create dialog and restart recovers the same candidate once',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      claudeConversation: 'fork_settings_once',
      codexAppServer: 'fork_complete',
    })
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const seeded = await seedNativeSource(fixture, 'custom-fixture-one[1m]')
      app = await fixture.launch()
      let page = await app.firstWindow()
      await page.getByRole('button', { name: 'Native fork source', exact: true }).click()
      const answer = page.locator(`[data-pact-message-id="${seeded.messageId}"]`)
      await answer.hover()
      await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Create fork', exact: true })
        .click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 25_000 })
      await expect(page.getByRole('region', { name: 'Native fork confirmation' })).toHaveCount(0)
      const child = page.getByRole('button', { name: 'Native fork source (fork)', exact: true })
      await expect(child.locator('output[aria-label$="encountered an error"]')).toHaveCount(1)
      await child.click()
      const recovery = page.getByRole('region', { name: 'Native fork confirmation' })
      await expect(recovery).toHaveCount(1)
      await expect(recovery).toContainText('Claude did not confirm')
      await expect(recovery).toContainText('Ready')
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toBeDisabled()
      const before = await fixture.readClaudeFacts()
      const candidate = before.resumes?.at(-1)
      expect(candidate).toBeTruthy()
      await recovery.getByRole('button', { name: 'Check original candidate', exact: true }).click()
      await expect(
        recovery.getByRole('button', { name: 'Continue initialization', exact: true }),
      ).toBeEnabled()
      expect((await fixture.readClaudeFacts()).settingsReads).toBe(before.settingsReads)
      await quitPact(app)
      app = await fixture.launch()
      page = await app.firstWindow()
      await page.getByRole('button', { name: 'Native fork source (fork)', exact: true }).click()
      const restored = page.getByRole('region', { name: 'Native fork confirmation' })
      await expect(restored).toHaveCount(1)
      expect((await fixture.readClaudeFacts()).settingsReads).toBe(before.settingsReads)
      await restored.getByRole('button', { name: 'Continue initialization', exact: true }).click()
      await expect(restored).toHaveCount(0, { timeout: 25_000 })
      await expect(
        page
          .getByRole('button', { name: 'Native fork source (fork)', exact: true })
          .locator('output[aria-label$="encountered an error"]'),
      ).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toBeEnabled()
      const facts = await fixture.readClaudeFacts()
      expect(facts.resumes?.filter((id) => id === candidate)).toHaveLength(2)
      expect(facts.count).toBe(0)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
      expect(
        (await fixture.readCodexFacts()).methods.filter((method) => method === 'thread/fork'),
      ).toHaveLength(1)
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)
