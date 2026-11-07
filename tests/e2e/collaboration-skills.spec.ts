import { expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  advanceCollaboration,
  collaborationTaskSchema,
} from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'
async function closeContextOverlay(page: Page): Promise<void> {
  const overlay = page.getByRole('dialog', { name: 'Context panel', exact: true })
  if (await overlay.isVisible())
    await page.getByRole('button', { name: 'Close context panel', exact: true }).click()
}
async function current(page: Page, sessionId: string) {
  const response = await page.evaluate(async (id) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getConversation({ scope: 'collaboration', sessionId: id })
  }, sessionId)
  if (!response.ok || response.value.scope !== 'collaboration') throw Error('Workflow unavailable')
  return response.value.view.task
}
async function prepare(
  primary: 'codex' | 'claude' = 'codex',
  viewport?: { width: number; height: number },
  seed?: (context: {
    db: PactDatabase
    fixture: RuntimeFixture
    directory: string
    sessionId: string
  }) => Promise<void>,
) {
  const fixture = await createRuntimeFixture({
    mode: 'deterministic',
    codexAppServer: 'collaboration',
    claudeConversation: 'collaboration',
  })
  const directory = await fixture.createProjectDirectory('collaboration-skills')
  // Real development workspaces contain App data larger than the source evidence budget.
  await mkdir(join(directory, '.pact-data/dev'), { recursive: true })
  const artifact = await open(join(directory, '.pact-data/dev/pact.sqlite'), 'w')
  try {
    await artifact.truncate(9 * 1024 * 1024)
  } finally {
    await artifact.close()
  }
  const db = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Pact Skills',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Collaboration', createdAt },
      {
        primaryAgentId: primary,
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    await seed?.({ db, fixture, directory, sessionId })
  } finally {
    db.close()
  }
  const app = await fixture.launch(),
    page = await app.firstWindow()
  if (viewport) await page.setViewportSize(viewport)
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click()
  const send = async (content: string) => {
    await closeContextOverlay(page)
    const editor = page.getByRole('combobox', { name: 'Message', exact: true })
    await editor.fill(content)
    if (/\/(?:plan|build|review)\s*$/u.test(content))
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    else await editor.press('Enter')
  }
  const counts = async () => ({
    codex: (await fixture.readCodexFacts().catch(() => ({ modelStarts: [] }))).modelStarts.length,
    claude: (await fixture.readClaudeFacts().catch(() => ({ count: 0 }))).count,
  })
  return { fixture, app, page, send, counts, directory, sessionId }
}

test('@deterministic Restore saved plan uses its authenticated checkpoint and native edits without another Agent turn', async () => {
  const original = 'Scope\nA1\nB1\n',
    restored = 'Scope\nA2\nB1\n'
  let targetRunId = '',
    sourceMessageId = '',
    sourceRunId = ''
  const f = await prepare('claude', undefined, async ({ db, fixture, directory, sessionId }) => {
    const repo = db.conversationRepository,
      settings = db.sessionRepository.find(sessionId)!.settings,
      nativeSessionId = randomUUID(),
      userId = randomUUID()
    const initial = collaborationTaskSchema.parse({
      protocol: 'native-workflow-v1',
      id: randomUUID(),
      sessionId,
      kind: 'plan',
      revision: 0,
      owner: 'claude',
      reviewer: 'codex',
      actor: 'claude',
      stage: 'plan',
      status: 'running',
      automation: 'active',
      task: 'Restore the saved plan.',
      taskMessageId: userId,
      runId: userId,
      inputSequence: 0,
      handledInputSequence: 0,
      planVersion: 0,
      discussionRounds: 0,
      reviewCycles: 0,
      repairAttempts: 0,
    })
    const begin = (task: typeof initial, messageId = randomUUID(), revision?: number) => {
      const drafts = repo.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw Error('Missing source draft revision.')
      return repo.beginRun({
        sessionId,
        clientMessageId: messageId,
        content: '/plan Restore the saved plan.',
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        agentId: task.actor,
        settingsRevision: 1,
        model: null,
        effort: null,
        collaboration: task,
        ...(revision === undefined ? {} : { expectedCollaborationRevision: revision }),
      }).run
    }
    const finish = (runId: string, plan?: string, review = false) => {
      const run = repo.findRun(runId)!,
        native = run.agentId === 'claude' ? nativeSessionId : randomUUID()
      repo.applyEvent(sessionId, runId, {
        type: 'session.started',
        agentId: run.agentId,
        nativeSessionId: native,
      })
      repo.applyEvent(sessionId, runId, {
        type: 'turn.started',
        agentId: run.agentId,
        turnId: runId,
      })
      if (plan) repo.recordWorkflowPlan(runId, { nativeId: 'published-edit', text: plan })
      else if (review) repo.recordWorkflowReview(runId, { verdict: 'changes_requested' })
      else repo.recordWorkflowPlanUnavailable(runId)
      repo.applyEvent(sessionId, runId, {
        type: 'text.completed',
        agentId: run.agentId,
        turnId: runId,
        outputId: runId,
        text: review
          ? 'Update A1 to A2.'
          : plan
            ? 'Published original plan.'
            : 'Plan saved; native capture unavailable.',
      })
      repo.recordNativeEvidence({
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
        identity: {
          sessionId,
          agentId: run.agentId,
          requestId: runId,
          runId,
          nativeSessionId: native,
          nativeTurnId: runId,
          bindingGeneration: run.bindingGeneration ?? 1,
        },
      })
      repo.recordNativeEffects(runId, 'settled')
      repo.applyEvent(sessionId, runId, {
        type: 'turn.completed',
        agentId: run.agentId,
        turnId: runId,
        outcome: 'completed',
      })
      repo.recordNativeEffects(runId, 'settled')
    }
    const source = begin(initial, userId)
    sourceRunId = source.id
    finish(source.id, original)
    let task = repo.collaboration(sessionId)!
    const review = begin(
      advanceCollaboration(task, 'continue', settings),
      randomUUID(),
      task.revision,
    )
    finish(review.id, undefined, true)
    task = repo.collaboration(sessionId)!
    const target = begin(
      advanceCollaboration(task, 'continue', settings),
      randomUUID(),
      task.revision,
    )
    targetRunId = target.id
    finish(target.id)
    sourceMessageId = repo.findRun(target.id)!.responseMessageId!
    expect(repo.needsWorkflowPlanRecovery(target.id)).toBe(true)
    const planPath = join(fixture.claudeHome, 'plans', 'checkpoint-plan.md'),
      project = join(
        fixture.claudeHome,
        'projects',
        (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
      )
    await mkdir(project, { recursive: true })
    await mkdir(join(fixture.claudeHome, 'plans'), { recursive: true })
    await writeFile(planPath, 'Untrusted newer disk text must not replace the recovered plan.')
    const rows: object[] = []
    let parent: string | null = null
    const add = (record: Record<string, unknown>) => {
      const uuid = typeof record.uuid === 'string' ? record.uuid : randomUUID()
      rows.push({
        sessionId: nativeSessionId,
        cwd: directory,
        timestamp: new Date().toISOString(),
        uuid,
        parentUuid: parent,
        ...record,
      })
      parent = uuid
    }
    const edit = (id: string, oldString: string, newString: string) => {
      add({
        type: 'assistant',
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id,
              name: 'Edit',
              input: { file_path: planPath, old_string: oldString, new_string: newString },
            },
          ],
        },
      })
      add({
        type: 'user',
        toolUseResult: {
          filePath: planPath,
          oldString,
          newString,
          originalFile: null,
          userModified: false,
          replaceAll: false,
        },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'Done' }],
        },
      })
    }
    add({
      type: 'user',
      uuid: source.id,
      promptId: randomUUID(),
      message: { role: 'user', content: 'Original planning root.' },
    })
    add({
      type: 'attachment',
      attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: planPath },
    })
    // The old native preimage is unavailable; only the prior host-published plan authenticates it.
    edit('published-edit', 'B0', 'B1')
    add({
      type: 'user',
      uuid: target.id,
      promptId: randomUUID(),
      message: { role: 'user', content: 'Revise A1 to A2.' },
    })
    edit('current-edit', 'A1', 'A2')
    add({
      type: 'assistant',
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: 'Plan saved; native capture unavailable.' }],
      },
    })
    await writeFile(
      join(project, `${nativeSessionId}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    )
  })
  try {
    await closeContextOverlay(f.page)
    const before = await current(f.page, f.sessionId)
    expect(before).toMatchObject({ runId: targetRunId, planVersion: 1, automation: 'paused' })
    await f.page.getByRole('button', { name: 'Restore saved plan', exact: true }).click()
    await expect.poll(async () => (await current(f.page, f.sessionId))?.planVersion).toBe(2)
    const after = await current(f.page, f.sessionId)
    expect(after).toMatchObject({
      runId: targetRunId,
      status: 'waiting',
      automation: 'paused',
      nextStage: 'plan_review',
    })
    expect(after?.planReference?.sourceRunId).toBe(targetRunId)
    expect(after?.planReference?.document).toMatchObject({
      bytes: Buffer.byteLength(restored),
      chars: restored.length,
    })
    expect(after?.planReference?.document.sha256).toBe(
      createHash('sha256').update(restored).digest('hex'),
    )
    const database = ReadonlyFixtureDatabase.open(f.fixture)
    try {
      expect(
        database.drizzle.query.agentRuns.findMany({ columns: { id: true }, limit: 4 }).sync(),
      ).toHaveLength(3)
    } finally {
      database.close()
    }
    await expect(
      f.page.getByRole('button', { name: 'Restore saved plan', exact: true }),
    ).toHaveCount(0)
    await expect(
      f.page.getByRole('button', { name: 'Continue collaboration', exact: true }),
    ).toBeVisible()
    expect(after?.sourceMessageId).toBe(sourceMessageId)
    expect(after?.review?.planReference?.sourceRunId).toBe(sourceRunId)
    const repeated = await f.page.evaluate(
      async (input) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.actOnCollaboration(input)
      },
      {
        sessionId: f.sessionId,
        taskId: after!.id,
        revision: after!.revision,
        clientMessageId: randomUUID(),
        action: 'recover_plan' as const,
      },
    )
    expect(repeated.ok).toBe(false)
    expect(await current(f.page, f.sessionId)).toMatchObject({
      runId: targetRunId,
      planVersion: 2,
      automation: 'paused',
    })
    expect(await f.counts()).toEqual({ codex: 0, claude: 0 })
  } finally {
    await quitPact(f.app)
    await f.fixture.dispose()
  }
})

for (const primary of ['codex', 'claude'] as const)
  test(`@deterministic native plan from ${primary} is independently reviewed before explicit Secondary implementation and repair`, async () => {
    const f = await prepare(primary)
    try {
      const secondary = primary === 'codex' ? 'claude' : 'codex'
      await f.send(`@${secondary} /plan Conflicting plan recipient.`)
      await expect(
        f.page.getByText(
          `This Pact plan stage belongs to ${primary}. Remove the conflicting Agent recipient; your draft is preserved.`,
          { exact: true },
        ),
      ).toBeVisible()
      await expect(f.page.getByRole('combobox', { name: 'Message', exact: true })).toContainText(
        'Conflicting plan recipient.',
      )
      expect(await f.counts()).toEqual({ codex: 0, claude: 0 })
      await f.send('/plan Build reliable cancellation')
      const implementer = primary === 'codex' ? 'Claude Code' : 'Codex'
      await expect(
        f.page.getByRole('button', { name: `Implement plan · ${implementer}`, exact: true }),
      ).toBeEnabled()
      await expect(
        f.page.getByRole('button', { name: 'Pause collaboration', exact: true }),
      ).toHaveCount(0)
      expect(await f.counts()).toEqual({ codex: 1, claude: 1 })
      expect(await current(f.page, f.sessionId)).toMatchObject({
        owner: primary,
        status: 'ready',
        planVersion: 1,
      })
      await f.page.getByRole('button', { name: 'Open plan', exact: true }).click()
      await expect(f.page.getByRole('region', { name: /Current plan|Plan source/ })).toContainText(
        'Keep cancellation with its owner.',
      )
      await closeContextOverlay(f.page)
      await writeFile(join(f.directory, '.pact-data/dev/pact.sqlite'), 'App state changed')
      await f.page
        .getByRole('button', { name: `Implement plan · ${implementer}`, exact: true })
        .click()
      await expect(
        f.page.getByRole('button', { name: `Repair · ${implementer}`, exact: true }),
      ).toBeEnabled()
      expect(await f.counts()).toEqual({ codex: 2, claude: 2 })
      const reviewed = await current(f.page, f.sessionId)
      expect(reviewed).toMatchObject({
        stage: 'code_review',
        review: { verdict: 'changes_requested' },
        repairAttempts: 0,
      })
      await writeFile(join(f.directory, 'later-change.txt'), 'A real source change')
      await f.page.getByRole('button', { name: `Repair · ${implementer}`, exact: true }).click()
      await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('complete')
      expect(await current(f.page, f.sessionId)).toMatchObject({
        repairAttempts: 1,
        review: { verdict: 'accepted' },
      })
      expect(await f.counts()).toEqual({ codex: 3, claude: 3 })
      await expect(
        f.page.getByRole('region', { name: 'Pact collaboration result' }).last(),
      ).toContainText('Complete')
    } catch (error) {
      const codex = await f.fixture
          .readCodexFacts()
          .catch(() => ({ fixtureError: 'No native Codex invocation was recorded' })),
        claude = await f.fixture.readClaudeFacts().catch(() => ({ fixtureError: undefined }))
      throw Error(
        `${String(error)}; native fixture: ${codex.fixtureError ?? ''}; ${claude.fixtureError ?? ''}`,
        { cause: error },
      )
    } finally {
      await quitPact(f.app)
      await f.fixture.dispose()
    }
  })

test('@deterministic structured question answers stay bound to the requesting actor and automatically continue review', async () => {
  const f = await prepare('claude', { width: 1000, height: 720 })
  try {
    await f.send('@claude /plan unclear cancellation requirement')
    const card = f.page.getByRole('region', { name: 'Collaboration questions', exact: true })
    await expect(card).toContainText('Claude Code is waiting for your reply')
    await expect(
      card.getByRole('radio', { name: 'Current request', exact: true }),
    ).not.toBeChecked()
    await expect(
      card.getByRole('radio', { name: 'All pending requests', exact: true }),
    ).not.toBeChecked()
    await expect(card.getByRole('button', { name: 'Send answers', exact: true })).toBeDisabled()
    expect(await f.counts()).toEqual({ codex: 0, claude: 1 })
    await card.getByRole('radio', { name: 'Current request', exact: true }).check()
    await card
      .getByRole('textbox', { name: 'Your answer or additional context', exact: true })
      .fill('Preserve restart handling.')
    expect(await f.counts()).toEqual({ codex: 0, claude: 1 })
    await card.getByRole('button', { name: 'Send answers', exact: true }).click()
    await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('ready')
    await expect(card).toHaveCount(0)
    expect(await current(f.page, f.sessionId)).toMatchObject({
      owner: 'claude',
      actor: 'codex',
      stage: 'plan_review',
      automation: 'active',
      review: { inputSequence: 2, verdict: 'accepted' },
    })
    await closeContextOverlay(f.page)
    await expect(
      f.page.getByRole('button', { name: 'Continue collaboration', exact: true }),
    ).toHaveCount(0)
    await expect(
      f.page.getByRole('button', { name: 'Implement plan · Codex', exact: true }),
    ).toBeEnabled()
    expect(await f.counts()).toEqual({ codex: 1, claude: 2 })
  } catch (error) {
    const codex = await f.fixture.readCodexFacts().catch(() => ({ fixtureError: undefined })),
      claude = await f.fixture.readClaudeFacts().catch(() => ({ fixtureError: undefined }))
    throw Error(
      `${String(error)}; native fixture: ${codex.fixtureError ?? ''}; ${claude.fixtureError ?? ''}`,
      { cause: error },
    )
  } finally {
    await quitPact(f.app)
    await f.fixture.dispose()
  }
})

test('@deterministic direct Review remains read-only until explicit repair and independently rereviews the result', async () => {
  const f = await prepare()
  try {
    await f.send('/review Inspect cancellation ownership')
    await expect(
      f.page.getByRole('button', { name: 'Repair · Claude Code', exact: true }),
    ).toBeEnabled()
    const task = await current(f.page, f.sessionId)
    expect(task).toMatchObject({
      owner: 'codex',
      reviewer: 'claude',
      rolePolicy: 'split-stages-v1',
      stage: 'code_review',
      review: { verdict: 'changes_requested' },
      repairAttempts: 0,
    })
    expect(await f.counts()).toEqual({ codex: 1, claude: 0 })
    await expect(
      f.page.getByText(
        'Keep cancellation with its owner. Release the pending request when its owner stops.',
        { exact: true },
      ),
    ).toBeVisible()
    await f.page.getByRole('button', { name: 'Repair · Claude Code', exact: true }).click()
    await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('complete')
    expect(await f.counts()).toEqual({ codex: 2, claude: 1 })
  } catch (error) {
    const codex = await f.fixture.readCodexFacts().catch(() => ({ fixtureError: undefined })),
      claude = await f.fixture.readClaudeFacts().catch(() => ({ fixtureError: undefined }))
    throw Error(
      `${String(error)}; native fixture: ${codex.fixtureError ?? ''}; ${claude.fixtureError ?? ''}`,
      { cause: error },
    )
  } finally {
    await quitPact(f.app)
    await f.fixture.dispose()
  }
})

test('@deterministic cold restart preserves the accepted native plan and pauses collaboration without another turn', async () => {
  const f = await prepare()
  let app = f.app
  try {
    await f.send('/plan Preserve native plan through restart')
    await expect(
      f.page.getByRole('button', { name: 'Implement plan · Claude Code', exact: true }),
    ).toBeEnabled()
    const before = await current(f.page, f.sessionId)
    await quitPact(app)
    app = await f.fixture.launch()
    const page = await app.firstWindow()
    const session = await page.evaluate(async (id) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      return bridge.getConversation({ scope: 'messages', sessionId: id })
    }, f.sessionId)
    if (!session.ok || session.value.scope !== 'messages')
      throw Error('Session unavailable after restart')
    await page
      .getByRole('button', { name: session.value.header.session.title, exact: true })
      .click()
    const after = await current(page, f.sessionId)
    expect(after?.planReference).toEqual(before?.planReference)
    expect(after?.automation).toBe('paused')
    expect(await f.counts()).toEqual({ codex: 1, claude: 1 })
    await page.getByRole('button', { name: 'Open plan', exact: true }).click()
    await expect(page.getByRole('region', { name: /Current plan|Plan source/ })).toContainText(
      'Verify Stop and restart.',
    )
  } finally {
    await quitPact(app)
    await f.fixture.dispose()
  }
})

for (const primary of ['codex', 'claude'] as const) {
  test(`@deterministic ${primary} plan reviewer receives decision answers before automatic author continuation`, async () => {
    const f = await prepare(primary)
    const reviewer = primary === 'codex' ? 'claude' : 'codex'
    try {
      await f.send('/plan reviewer decision about cancellation')
      const card = f.page.getByRole('region', { name: 'Collaboration questions', exact: true })
      await expect(card).toContainText(
        `${reviewer === 'codex' ? 'Codex' : 'Claude Code'} is waiting for your reply`,
      )
      await expect(f.page.getByRole('combobox', { name: 'Message', exact: true })).toHaveCount(0)
      await card.getByRole('radio', { name: 'Current request', exact: true }).check()
      await card.getByRole('button', { name: 'Send answers', exact: true }).click()
      await expect(
        f.page.getByText('The supplied scope decision has been handled.', { exact: true }),
      ).toBeVisible()
      await expect(card).toHaveCount(0)
      const reply = f.page.locator('article').filter({ hasText: 'Replies to your questions' })
      await expect(reply).toContainText(`@${reviewer}`)
      await expect(
        reply.locator('strong').filter({ hasText: 'Replies to your questions' }),
      ).toHaveCount(1)
      await expect(
        reply.locator('p').filter({ hasText: '1. Which cancellation scope should change?' }),
      ).toHaveCount(1)
      await expect(reply.locator('li').filter({ hasText: 'Current request' })).toHaveCount(1)
      await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('ready')
      expect(await current(f.page, f.sessionId)).toMatchObject({
        owner: primary,
        actor: reviewer,
        stage: 'plan_review',
        automation: 'active',
        planVersion: 1,
        review: { inputSequence: 2, verdict: 'accepted' },
      })
      await expect(
        f.page.getByRole('button', { name: 'Continue collaboration', exact: true }),
      ).toHaveCount(0)
      await expect(
        f.page.getByRole('button', {
          name: `Implement plan · ${primary === 'codex' ? 'Claude Code' : 'Codex'}`,
          exact: true,
        }),
      ).toBeEnabled()
      expect(await f.counts()).toEqual(
        primary === 'codex' ? { codex: 2, claude: 3 } : { codex: 3, claude: 2 },
      )
      await expect(
        f.page.getByRole('button', { name: 'Pause collaboration', exact: true }),
      ).toHaveCount(0)
    } finally {
      await quitPact(f.app)
      await f.fixture.dispose()
    }
  })

  test(`@deterministic ${primary} missing native plan does not manufacture a user question or restore evidence`, async () => {
    const f = await prepare(primary)
    try {
      await f.send('/plan missing native plan')
      await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('failed')
      await expect(
        f.page.getByRole('region', { name: 'Collaboration questions', exact: true }),
      ).toHaveCount(0)
      await expect(f.page.getByRole('button', { name: /Restore plan/ })).toHaveCount(0)
      await expect(
        f.page.getByText(
          `Next: Update the plan with ${primary === 'codex' ? 'Codex' : 'Claude Code'}.`,
          { exact: false },
        ),
      ).toBeVisible()
      await expect(f.page.getByRole('combobox', { name: 'Message', exact: true })).toBeVisible()
      expect(await f.counts()).toEqual(
        primary === 'codex' ? { codex: 1, claude: 0 } : { codex: 0, claude: 1 },
      )
      await f.page.getByRole('button', { name: 'Continue collaboration', exact: true }).click()
      await expect
        .poll(f.counts)
        .toEqual(primary === 'codex' ? { codex: 2, claude: 0 } : { codex: 0, claude: 2 })
      await expect.poll(async () => (await current(f.page, f.sessionId))?.status).toBe('failed')
      expect(await current(f.page, f.sessionId)).toMatchObject({
        stage: 'plan',
        actor: primary,
        planVersion: 0,
      })
      await expect(f.page.getByRole('button', { name: /Implement plan/ })).toHaveCount(0)
      await expect(
        f.page.getByRole('region', { name: 'Collaboration questions', exact: true }),
      ).toHaveCount(0)
      await expect(f.page.getByRole('button', { name: /Restore plan/ })).toHaveCount(0)
    } finally {
      await quitPact(f.app)
      await f.fixture.dispose()
    }
  })
}

for (const width of [1440, 1000])
  test(`@deterministic Plan panel preserves its document and Comments through expansion and restoration at ${width}px`, async () => {
    const f = await prepare('codex', { width, height: 900 })
    try {
      await f.send('/plan Build reliable cancellation')
      await expect(
        f.page.getByRole('button', { name: 'Implement plan · Claude Code', exact: true }),
      ).toBeEnabled()
      await closeContextOverlay(f.page)
      const composer = f.page.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('Ordinary message draft must survive Plan reading.')
      await f.page.getByRole('button', { name: 'Plan', exact: true }).click()
      const plan = f.page.getByRole('region', { name: 'Current plan', exact: true })
      await expect(plan).toContainText('Keep cancellation with its owner.')
      if (width === 1440) {
        await f.page.getByRole('button', { name: 'Hide navigation panel', exact: true }).click()
        const separator = f.page.getByRole('separator', {
          name: 'Resize context panel',
          exact: true,
        })
        const handle = await separator.boundingBox()
        if (!handle) throw new Error('Context resize handle is missing.')
        await f.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
        await f.page.mouse.down()
        await f.page.mouse.move(width * 0.4, handle.y + handle.height / 2, { steps: 16 })
        await f.page.mouse.up()
        await expect
          .poll(async () => (await plan.boundingBox())!.width)
          .toBeGreaterThan(width * 0.5)
      }
      const document = plan.locator('.pact-plan-document')
      const originalDocument = await document.elementHandle()
      const originalWidth = (await plan.boundingBox())!.width
      await f.page.getByRole('button', { name: 'Expand plan panel', exact: true }).click()
      await expect(
        f.page.getByRole('button', { name: 'Restore plan panel', exact: true }),
      ).toBeVisible()
      await expect.poll(async () => (await plan.boundingBox())!.width).toBeGreaterThan(width * 0.95)
      expect(await originalDocument.evaluate((node) => node.isConnected)).toBe(true)
      const gesture = await document.evaluate((host) => {
        const phrase = 'Keep cancellation with its owner.'
        const span = [...host.querySelectorAll('[data-pact-projection-start]')].find((node) =>
          node.textContent?.includes(phrase),
        )
        const node = span?.firstChild
        if (!node) throw new Error('Plan text geometry is missing.')
        const offset = node.textContent!.indexOf(phrase)
        const range = window.document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + phrase.length)
        const boxes = [...range.getClientRects()]
        const first = boxes[0]!,
          last = boxes.at(-1)!
        return {
          start: { x: first.left + 1, y: first.top + first.height / 2 },
          end: { x: last.right - 1, y: last.top + last.height / 2 },
        }
      })
      await f.page.mouse.move(gesture.start.x, gesture.start.y)
      await f.page.mouse.down()
      await f.page.mouse.move(gesture.end.x, gesture.end.y, { steps: 12 })
      await f.page.mouse.up()
      await plan.getByRole('button', { name: 'Comment on selected text', exact: true }).click()
      await expect(plan.getByRole('heading', { name: 'New comment', exact: true })).toBeVisible()
      const comment = plan.getByRole('textbox', { name: 'Comment', exact: true })
      await expect(plan.locator('p[title]')).toHaveAttribute(
        'title',
        'Keep cancellation with its owner.',
      )
      await comment.fill('Verify cancellation ownership while reading the expanded plan.')
      await f.page.getByRole('button', { name: 'Restore plan panel', exact: true }).click()
      await expect(f.page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
        'Verify cancellation ownership while reading the expanded plan.',
      )
      await expect
        .poll(async () => Math.abs((await plan.boundingBox())!.width - originalWidth))
        .toBeLessThan(3)
      expect(await originalDocument.evaluate((node) => node.isConnected)).toBe(true)
      // Compact context is modal, so keep editing inside its expanded document.
      await f.page.getByRole('button', { name: 'Expand plan panel', exact: true }).click()
      await comment.press('Enter')
      const drafts = plan.getByLabel('Attached Comment drafts', { exact: true })
      await expect(drafts).toContainText(
        'Verify cancellation ownership while reading the expanded plan.',
      )
      await drafts
        .getByRole('button', {
          name: 'Plan v1 · Verify cancellation ownership while reading the expanded plan.',
          exact: true,
        })
        .click()
      await comment.fill('Edited plan Comment survives restoration.')
      await comment.press('Enter')
      await expect(drafts).toContainText('Edited plan Comment survives restoration.')
      await f.page.getByRole('button', { name: 'Restore plan panel', exact: true }).click()
      await closeContextOverlay(f.page)
      await expect(composer).toHaveText('Ordinary message draft must survive Plan reading.')
      await expect(f.page.getByLabel('Attached Comment drafts', { exact: true })).toContainText(
        'Edited plan Comment survives restoration.',
      )
      expect(await f.counts()).toEqual({ codex: 1, claude: 1 })
      await f.page.getByRole('button', { name: 'Return to Comment source', exact: true }).click()
      const sourcePanel = f.page.getByRole('region', { name: 'Plan source', exact: true })
      await expect(sourcePanel).toContainText('Keep cancellation with its owner.')
      await expect(
        sourcePanel.getByRole('button', { name: 'Expand plan panel', exact: true }),
      ).toBeVisible()
    } finally {
      await quitPact(f.app)
      await f.fixture.dispose()
    }
  })
