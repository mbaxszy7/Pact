import { expect, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { conversationMessages } from '../../packages/persistence/src/schema/index.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

const resultCard = (page: Page): Locator =>
  page.getByRole('region', { name: 'Pact collaboration result', exact: true }).last()

async function closeContextOverlay(page: Page): Promise<void> {
  const overlay = page.getByRole('dialog', { name: 'Context panel', exact: true })
  if (await overlay.isVisible()) {
    await page.getByRole('button', { name: 'Close context panel', exact: true }).click()
    await expect(overlay).toHaveCount(0)
  }
}

async function expandResult(card: Locator): Promise<void> {
  const toggle = card.getByRole('heading').locator('..')
  await expect(toggle).toBeEnabled()
  await closeContextOverlay(card.page())
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

async function openIssue(page: Page, title: string, card = resultCard(page)): Promise<void> {
  await expandResult(card)
  await card
    .getByRole('list', { name: 'Issue summaries' })
    .getByRole('button', { name: title, exact: true })
    .click()
  await expect(page.getByRole('region', { name: 'Shared Todos', exact: true })).toBeVisible()
}

async function readTodos(page: Page, sessionId: string) {
  const response = await page.evaluate(async (id) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getConversation({
      scope: 'collaboration',
      sessionId: id,
      projection: 'todos',
      todoStatus: 'all',
    })
  }, sessionId)
  if (!response.ok || response.value.scope !== 'collaboration' || !response.value.view.todos)
    throw Error('Current Task Todo metadata is unavailable')
  return response.value.view
}

async function expectCompleteReview(page: Page): Promise<void> {
  const card = resultCard(page)
  await expect(card.getByLabel('Pact Proposal')).toContainText('Review complete')
  await expandResult(card)
  await expect(card).toContainText('No unresolved feedback')
  await expect(
    card.getByRole('button', { name: 'Review current changes · read-only', exact: true }),
  ).toBeEnabled()
}

async function todoOffset(row: Locator): Promise<number> {
  return row.evaluate((element) => {
    const host = element.closest<HTMLElement>('[data-pact-context-scroll]')
    if (!host) throw Error('The Todo has no Context scroll owner')
    const inset = Number.parseFloat(getComputedStyle(host).paddingTop) || 0
    return element.getBoundingClientRect().top - host.getBoundingClientRect().top - inset
  })
}

async function expectAlignedTodo(row: Locator): Promise<void> {
  await expect(row.locator('[data-pact-todo-toggle]')).toHaveAttribute('aria-expanded', 'true')
  await expect(row.locator('[data-pact-message-content]')).toBeVisible()
  await expect(row.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect.poll(async () => Math.abs(await todoOffset(row))).toBeLessThanOrEqual(2)
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
        runningMessagePolicy: 'immediate_safe_point',
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
  test(`@deterministic Pact plan closes through explicit discussion, implementation, repair and rereview with ${primary} primary`, async () => {
    const f = await prepare(primary)
    try {
      await f.send('/plan Build reliable cancellation')
      const peer = primary === 'codex' ? 'Claude Code' : 'Codex'
      const discussion = f.page.getByRole('button', {
        name: `Review plan · ${peer}`,
        exact: true,
      })
      await expect(discussion)
        .toBeEnabled()
        .catch(async (error) => {
          const facts =
            primary === 'codex'
              ? await f.fixture.readCodexFacts()
              : await f.fixture.readClaudeFacts()
          throw new Error(
            `Synthetic collaboration failed: ${facts.fixtureError ?? 'No fixture exception'}; ${error.message}`,
          )
        })
      expect(await f.counts()).toEqual(
        primary === 'codex' ? { codex: 1, claude: 0 } : { codex: 0, claude: 1 },
      )
      await writeFile(join(f.directory, '.pact-data/dev/pact.sqlite'), 'App state changed')
      await writeFile(
        join(f.directory, 'cancellation.ts'),
        '// A real source change during planning is allowed.\n',
      )
      await closeContextOverlay(f.page)
      await discussion.click()
      await expect(
        f.page.getByRole('button', { name: `Implement plan · ${peer}`, exact: true }),
      ).toBeVisible()
      expect(await f.counts()).toEqual({ codex: 1, claude: 1 })
      const cards = f.page.getByRole('region', { name: 'Pact collaboration result' })
      await expect(cards).toHaveCount(2)
      const reviewed = cards.last()
      await expect(reviewed.getByRole('heading', { name: 'Review · v1' })).toBeVisible()
      await expect(reviewed.locator('[data-pact-plan-run-id]')).toHaveCount(0)
      if (!(await f.page.getByRole('navigation', { name: 'Task context' }).isVisible()))
        await f.page.getByRole('button', { name: 'Plan', exact: true }).click()
      await f.page
        .getByRole('navigation', { name: 'Task context' })
        .getByRole('button', { name: 'Plan', exact: true })
        .click()
      await expect(f.page.getByRole('region', { name: 'Current plan', exact: true })).toContainText(
        'Keep cancellation with its owner.',
      )
      await expect(f.page.getByText('View original reply', { exact: true })).toHaveCount(0)
      await expect(f.page.getByText(/View Pact .* details/u)).toHaveCount(0)
      await closeContextOverlay(f.page)
      await f.page.getByRole('button', { name: `Implement plan · ${peer}`, exact: true }).click()
      const reviewer = primary === 'codex' ? 'Codex' : 'Claude Code'
      await closeContextOverlay(f.page)
      await f.page
        .getByRole('button', { name: `Review changes · ${reviewer}`, exact: true })
        .click()
      await expect(
        f.page.getByRole('button', { name: `Repair · ${peer} · edits code`, exact: true }),
      ).toBeEnabled()
      await openIssue(f.page, 'Keep cancellation with its owner')
      expect((await readTodos(f.page, f.sessionId)).todos?.items).toEqual([
        expect.objectContaining({ id: 'cleanup', revision: 1, status: 'open' }),
      ])
      await closeContextOverlay(f.page)
      await f.page
        .getByRole('button', { name: `Repair · ${peer} · edits code`, exact: true })
        .click()
      await closeContextOverlay(f.page)
      await f.page
        .getByRole('button', { name: `Review changes · ${reviewer}`, exact: true })
        .click()
      await expectCompleteReview(f.page)
      expect((await readTodos(f.page, f.sessionId)).todos?.items).toEqual([
        expect.objectContaining({ id: 'cleanup', revision: 3, status: 'done' }),
      ])
      expect(await f.counts()).toEqual({ codex: 3, claude: 3 })
    } finally {
      await f.app.close()
      await f.fixture.dispose()
    }
  })

test('@deterministic Pact questions accept a deliberate answer and direct Review remains readonly until repair is clicked', async () => {
  const f = await prepare('codex', { width: 1000, height: 720 })
  try {
    await f.send('/plan unclear cancellation requirement')
    await openIssue(f.page, 'Choose the cancellation scope')
    const todo = f.page
      .getByRole('region', { name: 'Shared Todos', exact: true })
      .locator('[data-pact-todo-id="scope"][data-pact-todo-revision="1"]')
    await expect(todo).toContainText('Which cancellation scope should change?')
    await todo.getByRole('button', { name: 'Add your answer', exact: true }).click()
    const option = todo.getByRole('button', { name: 'Current request Recommended', exact: true })
    await expect(option).toHaveAttribute('aria-pressed', 'false')
    await expect(todo.getByRole('button', { name: 'Add to comment', exact: true })).toBeDisabled()
    await option.click()
    await expect(option).toHaveAttribute('aria-pressed', 'true')
    await option.click()
    await expect(option).toHaveAttribute('aria-pressed', 'false')
    await option.click()
    await todo.getByRole('button', { name: 'Add to comment', exact: true }).click()
    await expect(f.page.getByLabel('Attached Comment drafts')).toContainText('Current request')
    expect(await f.counts()).toEqual({ codex: 1, claude: 0 })
    expect((await readTodos(f.page, f.sessionId)).todos?.items[0]).toMatchObject({
      status: 'open',
      revision: 1,
    })
    await closeContextOverlay(f.page)
    await f.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(
      f.page.getByRole('button', { name: 'Review plan · Claude Code', exact: true }),
    ).toBeEnabled()
    expect(await f.counts()).toEqual({ codex: 2, claude: 0 })
    expect((await readTodos(f.page, f.sessionId)).todos?.items[0]).toMatchObject({
      status: 'done',
      revision: 2,
    })
    await f.send('/review Check cancellation ownership')
    await expect(
      f.page.getByRole('button', { name: 'Respond · Claude Code · read-only', exact: true }),
    ).toBeEnabled()
    await openIssue(f.page, 'Keep cancellation with its owner')
    expect(await f.counts()).toEqual({ codex: 3, claude: 0 })
    await closeContextOverlay(f.page)
    await f.page
      .getByRole('button', { name: 'Respond · Claude Code · read-only', exact: true })
      .click()
    await expect(
      f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }),
    ).toBeEnabled()
    const proposed = await readTodos(f.page, f.sessionId)
    expect(proposed.task?.stage).toBe('respond')
    expect(proposed.todos?.items[0]).toMatchObject({
      id: 'cleanup',
      status: 'awaiting_review',
      revision: 2,
      resolutionKind: 'not_adopted',
    })
    expect(await f.counts()).toEqual({ codex: 3, claude: 1 })
    await closeContextOverlay(f.page)
    await f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }).click()
    await expectCompleteReview(f.page)
    expect((await readTodos(f.page, f.sessionId)).todos?.items[0]).toMatchObject({
      id: 'cleanup',
      status: 'done',
      revision: 3,
      resolutionKind: 'not_adopted',
    })
    expect(await f.counts()).toEqual({ codex: 4, claude: 1 })
  } finally {
    await f.app.close()
    await f.fixture.dispose()
  }
})

test('@deterministic Pact build coalesces a running update into a readonly response and preserves explicit review', async ({
  browserName: _browserName,
}, testInfo) => {
  const f = await prepare()
  try {
    await f.send('@claude /build Build cancellation')
    await expect(
      f.page.getByRole('button', { name: 'Send update · after current work', exact: true }),
    ).toBeVisible()
    const editor = f.page.getByRole('combobox', { name: 'Message', exact: true })
    await editor.fill('Also inspect the restart path')
    await f.page
      .getByRole('button', { name: 'Send update · after current work', exact: true })
      .click()
    await expect(
      f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }),
    ).toBeEnabled({ timeout: 30_000 })
    const response = await readTodos(f.page, f.sessionId)
    expect(response.task?.stage).toBe('supplement')
    expect(response.task?.duty).toBe('stage_result')
    expect(await f.counts()).toEqual({ codex: 0, claude: 2 })
    await expect(
      f.page.getByRole('button', { name: 'Repair · Claude Code · edits code', exact: true }),
    ).toHaveCount(0)
    await f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }).click()
    await expect(
      f.page.getByRole('button', { name: 'Repair · Claude Code · edits code', exact: true }),
    ).toBeEnabled()
    await openIssue(f.page, 'Keep cancellation with its owner')
    expect(await f.counts()).toEqual({ codex: 1, claude: 2 })
    await expect(
      f.page.getByRole('button', { name: 'Repair · Claude Code · edits code', exact: true }),
    ).toBeEnabled()
    await expect(f.page.getByRole('button', { name: 'Not now', exact: true })).toHaveCount(0)
    expect(await f.counts()).toEqual({ codex: 1, claude: 2 })
  } catch (error) {
    try {
      const state = await readTodos(f.page, f.sessionId)
      const facts = {
        phase: 'coalescing-failure',
        counts: await f.counts(),
        task: state.task
          ? { stage: state.task.stage, status: state.task.status, duty: state.task.duty }
          : null,
        view: await f.page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          visibility: document.visibilityState,
          openContextOverlays: document.querySelectorAll(
            '.workspace-context-overlay[data-open="true"]',
          ).length,
          resultCards: document.querySelectorAll('[aria-label="Pact collaboration result"]').length,
          workingIndicators: document.querySelectorAll('[aria-label$="is responding"]').length,
        })),
      }
      const body = Buffer.from(JSON.stringify(facts))
      if (body.byteLength > 64 * 1024)
        throw new Error('Scalar diagnostics exceeded their bound', { cause: error })
      await testInfo.attach('collaboration-scalar-diagnostics', {
        body,
        contentType: 'application/json',
      })
    } catch (diagnosticError) {
      throw new AggregateError(
        [error],
        'Collaboration failed and scalar diagnostics were unavailable',
        { cause: diagnosticError },
      )
    }
    throw error
  } finally {
    await f.app.close()
    await f.fixture.dispose()
  }
})

test('@deterministic plan Comments survive restart and return to the frozen source outside the visible history', async () => {
  const f = await prepare()
  let app = f.app,
    page = f.page
  try {
    await f.send('/plan Improve plan readability')
    const card = page.getByRole('region', { name: 'Pact collaboration result' })
    await expect(
      card.getByRole('button', { name: 'Review plan · Claude Code', exact: true }),
    ).toBeEnabled()
    const before = await page
      .locator('[data-pact-transcript]')
      .evaluate((element) => element.scrollTop)
    await page
      .getByRole('navigation', { name: 'Task context' })
      .getByRole('button', { name: 'Plan', exact: true })
      .click()
    const plan = page
      .getByRole('region', { name: 'Current plan', exact: true })
      .locator('[data-pact-plan-run-id]')
    await expect(plan).toBeVisible()
    expect(
      await page.locator('[data-pact-transcript]').evaluate((element) => element.scrollTop),
    ).toBeLessThanOrEqual(before + 2)
    const runId = await plan.getAttribute('data-pact-plan-run-id')
    const phrase = (await plan
      .locator('[data-pact-projection-start]')
      .first()
      .textContent())!.slice(0, 8)
    await page.evaluate(
      ({ runId: selectedRun, phrase: selectedPhrase }) => {
        const planDocument = document.querySelector<HTMLElement>(
          `[data-pact-plan-run-id="${selectedRun}"]`,
        )!
        const host = planDocument.querySelector<HTMLElement>('[data-pact-message-content]')!
        const span = [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')].find(
          (node) => node.textContent?.includes(selectedPhrase),
        )!
        const text = span.firstChild!
        const start = text.textContent!.indexOf(selectedPhrase)
        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        const range = document.createRange()
        range.setStart(text, start)
        range.setEnd(text, start + selectedPhrase.length)
        document.getSelection()!.removeAllRanges()
        document.getSelection()!.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      },
      { runId, phrase },
    )
    await page.getByRole('button', { name: 'Comment on selected text' }).click()
    await expect(page.getByRole('region', { name: 'New comment' })).toContainText('Plan v1')
    await page.getByRole('textbox', { name: 'Comment' }).fill('Keep this exact plan decision.')
    await page.getByRole('textbox', { name: 'Comment' }).press('Enter')
    await expect(page.getByLabel('Attached Comment drafts')).toContainText('Plan v1')
    await app.close()
    const db = await PactDatabase.open({
      filePath: f.fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    let title: string
    try {
      title = db.sessionRepository.find(f.sessionId)!.title
      const messages = db.conversationRepository.read(f.sessionId).messages
      const sequence = Math.max(...messages.map((message) => message.sequence)) + 1
      const now = new Date().toISOString()
      db.drizzle
        .insert(conversationMessages)
        .values(
          Array.from({ length: 42 }, (_, index) => ({
            id: randomUUID(),
            sessionId: f.sessionId,
            role: 'system' as const,
            content: `Intervening history ${index}`,
            state: 'complete' as const,
            sequence: sequence + index,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run()
    } finally {
      db.close()
    }
    app = await f.fixture.launch()
    page = await app.firstWindow()
    await page.getByRole('button', { name: title!, exact: true }).click()
    await expect(page.getByLabel('Attached Comment drafts')).toContainText(
      'Keep this exact plan decision.',
    )
    await closeContextOverlay(page)
    await page
      .getByRole('combobox', { name: 'Message', exact: true })
      .fill('Keep this exact historical plan decision.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const comment = page.getByRole('button').filter({ hasText: 'Keep this exact plan decision.' })
    await expect(comment).toBeVisible()
    await expect(page.getByLabel('Attached Comment drafts')).toHaveCount(0)
    await comment.click()
    const source = page.locator(`[data-pact-plan-run-id="${runId}"]`)
    await expect(source).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(phrase)
    expect(await f.counts()).toEqual({ codex: 2, claude: 0 })
    await expect(page.getByRole('button', { name: 'Not now', exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    await f.fixture.dispose()
  }
})

test('@deterministic source edits do not block an authorized repair and normal rereview', async () => {
  const f = await prepare()
  try {
    await f.send('/build Build cancellation')
    await f.page.getByRole('button', { name: 'Review changes · Claude Code', exact: true }).click()
    await expect(
      f.page.getByRole('button', { name: 'Repair · Codex · edits code', exact: true }),
    ).toBeEnabled()
    await writeFile(join(f.directory, 'later-change.txt'), 'A real source change')
    await closeContextOverlay(f.page)
    await f.page.getByRole('button', { name: 'Repair · Codex · edits code', exact: true }).click()
    await expect(f.page.getByText(/Code version changed|The code version changed/)).toHaveCount(0)
    await f.page.getByRole('button', { name: 'Review changes · Claude Code', exact: true }).click()
    await expectCompleteReview(f.page)
    expect(await f.counts()).toEqual({ codex: 2, claude: 2 })
  } finally {
    await f.app.close()
    await f.fixture.dispose()
  }
})

test('@deterministic Pact bare Secondary build sends a frozen answer directly to its implementer before explicit work continuation', async () => {
  const f = await prepare('codex', { width: 1000, height: 720 })
  try {
    await f.page.getByRole('combobox', { name: 'Message', exact: true }).fill('@claude /build')
    await expect
      .poll(
        async () =>
          (await f.fixture.readClaudeFacts().catch(() => ({ metadataReads: 0 }))).metadataReads ??
          0,
      )
      .toBe(1)
    await expect(f.page.getByRole('listbox', { name: 'Native Skills' })).toHaveAttribute(
      'aria-busy',
      'false',
    )
    expect(await f.counts()).toEqual({ codex: 0, claude: 0 })
    await f.send('@claude /build')
    await openIssue(f.page, 'Choose the cancellation scope')
    const row = f.page
      .getByRole('region', { name: 'Shared Todos', exact: true })
      .locator('[data-pact-todo-id="scope"][data-pact-todo-revision="1"]')
    await expect(row).toContainText('Answer to Claude Code')
    await expect(row).toContainText('Which cancellation scope should change?')
    expect(await f.counts()).toEqual({ codex: 0, claude: 1 })
    await row.getByRole('button', { name: 'Add your answer', exact: true }).click()
    await row.getByRole('button', { name: 'Current request Recommended', exact: true }).click()
    await row.getByRole('button', { name: 'Add to comment', exact: true }).click()
    await expect(f.page.getByLabel('Attached Comment drafts')).toContainText('Current request')
    expect(await f.counts()).toEqual({ codex: 0, claude: 1 })
    await closeContextOverlay(f.page)
    await f.page.getByRole('button', { name: 'Send message', exact: true }).click()
    const continueWork = f.page.getByRole('button', {
      name: 'Continue implementation · Claude Code · edits code',
      exact: true,
    })
    await expect(continueWork).toBeEnabled()
    const answered = await readTodos(f.page, f.sessionId)
    expect(answered.task?.stage).toBe('supplement')
    expect(answered.task?.actor).toBe('claude')
    expect(answered.task?.resumePhase).toMatchObject({ stage: 'implement', actor: 'claude' })
    expect(answered.todos?.items[0]).toMatchObject({ id: 'scope', revision: 2, status: 'done' })
    expect(await f.counts()).toEqual({ codex: 0, claude: 2 })
    await closeContextOverlay(f.page)
    await continueWork.click()
    await expect(
      f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }),
    ).toBeEnabled()
    expect(await f.counts()).toEqual({ codex: 0, claude: 3 })
  } finally {
    await f.app.close()
    await f.fixture.dispose()
  }
})

test('@deterministic right Todos titles align the exact loaded item and preserve current selection beside historical versions', async () => {
  const f = await prepare()
  try {
    await f.page.setViewportSize({ width: 1280, height: 720 })
    await f.send('/review Verify Todo navigation for cancellation ownership')
    const originalReview = f.page
      .getByRole('region', { name: 'Pact collaboration result', exact: true })
      .first()
    await openIssue(f.page, 'Keep cancellation with its owner', originalReview)
    const todos = f.page.getByRole('region', { name: 'Shared Todos', exact: true }),
      cleanup = todos.locator('[data-pact-todo-id="cleanup"][data-pact-todo-revision="1"]'),
      third = todos.locator('[data-pact-todo-id="navigation-third"][data-pact-todo-revision="1"]'),
      second = todos.locator('[data-pact-todo-id="navigation-second"][data-pact-todo-revision="1"]')
    await expect(cleanup.locator('[data-pact-message-content]')).toBeVisible()
    await cleanup.locator('[data-pact-todo-toggle]').click()
    await expect(cleanup.locator('[data-pact-todo-toggle]')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(todos.locator('[data-pact-todo-id]')).toHaveCount(3)
    await expect(todos.locator('[data-pact-todo-id]').nth(2)).toHaveAttribute(
      'data-pact-todo-id',
      'navigation-third',
    )
    const scroll = todos.locator('xpath=ancestor::*[@data-pact-context-scroll]')
    // The original eager layout scroll is clamped here. The real metadata and
    // Markdown RPCs then populate enough DOM for the requested header to align.
    expect(
      await scroll.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1)
    expect(await todoOffset(third)).toBeGreaterThan(20)
    await third.locator('[data-pact-todo-toggle]').click()
    await expect(third).toContainText(
      'The request owner preserves its exact source and releases pending work.',
    )
    await expectAlignedTodo(third)
    expect(
      await scroll.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeGreaterThan(100)
    await second.locator('[data-pact-todo-toggle]').click()
    await expectAlignedTodo(second)
    await expect(third.locator('[data-pact-todo-toggle]')).toHaveAttribute('aria-expanded', 'false')
    await third.locator('[data-pact-todo-toggle]').click()
    await expectAlignedTodo(third)
    await expect(second.locator('[data-pact-todo-toggle]')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(await f.counts()).toEqual({ codex: 1, claude: 0 })

    await f.page
      .getByRole('button', { name: 'Repair · Claude Code · edits code', exact: true })
      .click()
    await f.page.getByRole('button', { name: 'Review changes · Codex', exact: true }).click()
    await expectCompleteReview(f.page)
    const completed = await readTodos(f.page, f.sessionId)
    expect(
      completed.todos?.items.map((item) => ({
        id: item.id,
        revision: item.revision,
        status: item.status,
      })),
    ).toEqual([
      { id: 'cleanup', revision: 3, status: 'done' },
      { id: 'navigation-second', revision: 3, status: 'done' },
      { id: 'navigation-third', revision: 3, status: 'done' },
    ])
    await openIssue(f.page, 'Keep the clicked Todo aligned', originalReview)
    await expect(third).toContainText('Historical version · v1 · Then: Open')
    await expect(third).toContainText('Current status: Done · v3')
    await expectAlignedTodo(third)
    const currentThird = todos.locator(
        '[data-pact-todo-id="navigation-third"][data-pact-todo-revision="3"]',
      ),
      currentSecond = todos.locator(
        '[data-pact-todo-id="navigation-second"][data-pact-todo-revision="3"]',
      )
    await currentThird.locator('[data-pact-todo-toggle]').click()
    await expectAlignedTodo(currentThird)
    await expect(currentThird).not.toContainText('Historical version')
    await expect(third.locator('[data-pact-todo-toggle]')).toHaveAttribute('aria-expanded', 'false')
    await currentSecond.locator('[data-pact-todo-toggle]').click()
    await expectAlignedTodo(currentSecond)

    // A genuine saved draft publishes a Renderer update. Its old source target
    // must not re-expand the historical item or steal the current row position.
    const commentId = randomUUID(),
      selected = completed.todos!.items.find((item) => item.id === 'navigation-second')!
    const saved = await f.page.evaluate(
      async ({ sessionId, commentId: requestedCommentId, todo }) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact'),
          drafts = await bridge.getConversation({ scope: 'drafts', sessionId })
        if (!drafts.ok || drafts.value.scope !== 'drafts') throw Error('Draft revision unavailable')
        return bridge.saveCommentDraft({
          mode: 'create',
          sessionId,
          commentId: requestedCommentId,
          expectedCommentsRevision: drafts.value.commentsRevision,
          body: 'Keep the current Todo position while its metadata refreshes.',
          anchor: {
            type: 'todo',
            taskId: todo.taskId,
            todoId: todo.id,
            todoRevision: todo.revision,
            quote: todo.title,
          },
        })
      },
      { sessionId: f.sessionId, commentId, todo: selected },
    )
    expect(saved.ok).toBe(true)
    await expect(f.page.getByLabel('Attached Comment drafts')).toContainText(
      'Keep the current Todo position',
    )
    await expectAlignedTodo(currentSecond)
    await expect(third.locator('[data-pact-todo-toggle]')).toHaveAttribute('aria-expanded', 'false')

    await currentSecond.getByRole('button', { name: 'Comment on Todo', exact: true }).click()
    await currentSecond
      .getByRole('textbox', { name: 'Todo comment', exact: true })
      .fill('An unsaved note belongs to this current item.')
    await third.locator('[data-pact-todo-toggle]').click()
    await expect(
      currentSecond.getByRole('textbox', { name: 'Todo comment', exact: true }),
    ).toHaveValue('An unsaved note belongs to this current item.')
    await expect(currentSecond.locator('[data-pact-todo-toggle]')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(third.locator('[data-pact-todo-toggle]')).toHaveAttribute('aria-expanded', 'false')
    await currentSecond.getByRole('button', { name: 'Cancel', exact: true }).click()
    await f.page.getByRole('button', { name: 'Remove Comment draft', exact: true }).click()
    await expect(f.page.getByLabel('Attached Comment drafts')).toHaveCount(0)
    expect(await f.counts()).toEqual({ codex: 2, claude: 1 })
  } finally {
    await f.app.close()
    await f.fixture.dispose()
  }
})
