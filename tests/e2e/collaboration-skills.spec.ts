import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'
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

for (const primary of ['codex', 'claude'] as const)
  test(`@deterministic native plan from ${primary} is independently reviewed before explicit owner implementation and repair`, async () => {
    const f = await prepare(primary)
    try {
      await f.send('/plan Build reliable cancellation')
      const owner = primary === 'codex' ? 'Codex' : 'Claude Code'
      await expect(
        f.page.getByRole('button', { name: `Implement plan · ${owner}`, exact: true }),
      ).toBeEnabled()
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
      await f.page.getByRole('button', { name: `Implement plan · ${owner}`, exact: true }).click()
      await expect(
        f.page.getByRole('button', { name: `Repair · ${owner}`, exact: true }),
      ).toBeEnabled()
      expect(await f.counts()).toEqual({ codex: 2, claude: 2 })
      const reviewed = await current(f.page, f.sessionId)
      expect(reviewed).toMatchObject({
        stage: 'code_review',
        review: { verdict: 'changes_requested' },
        repairAttempts: 0,
      })
      await writeFile(join(f.directory, 'later-change.txt'), 'A real source change')
      await f.page.getByRole('button', { name: `Repair · ${owner}`, exact: true }).click()
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
      const codex = await f.fixture.readCodexFacts(),
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

test('@deterministic structured question answers stay bound to the requesting actor and resume only on explicit continuation', async () => {
  const f = await prepare('codex', { width: 1000, height: 720 })
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
    await expect.poll(async () => (await current(f.page, f.sessionId))?.planVersion).toBe(1)
    await expect(card).toHaveCount(0)
    expect(await current(f.page, f.sessionId)).toMatchObject({
      owner: 'claude',
      actor: 'claude',
      stage: 'reply',
      automation: 'paused',
    })
    expect(await f.counts()).toEqual({ codex: 0, claude: 2 })
    await closeContextOverlay(f.page)
    await f.page.getByRole('button', { name: 'Continue collaboration', exact: true }).click()
    await expect(
      f.page.getByRole('button', { name: 'Implement plan · Claude Code', exact: true }),
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
      owner: 'claude',
      reviewer: 'codex',
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
      f.page.getByRole('button', { name: 'Implement plan · Codex', exact: true }),
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
