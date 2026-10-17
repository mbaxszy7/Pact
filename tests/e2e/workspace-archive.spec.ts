import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

async function seed(fixture: RuntimeFixture) {
  const database = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    extraProjectId = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  const directory = await fixture.createProjectDirectory('archive-project')
  const sentinel = join(directory, 'preserved.txt')
  await writeFile(sentinel, 'User project content must survive archive and Undo.\n', { flag: 'wx' })
  const createdAt = new Date().toISOString()
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'Archive Project',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  database.projectCatalogRepository.add({
    id: extraProjectId,
    name: 'Other Project',
    directoryPath: await fixture.createProjectDirectory('archive-other'),
    kind: 'directory',
    createdAt,
  })
  for (const [id, title] of [
    [first, 'First archive Session'],
    [second, 'Second archive Session'],
  ])
    database.sessionRepository.create(
      { id: id!, projectId, title: title!, createdAt },
      {
        primaryAgentId: 'codex',
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 3,
        runningMessagePolicy: 'next_round',
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
  return { database, projectId, extraProjectId, first, second, sentinel }
}

async function undo(page: Page, title: string): Promise<void> {
  const results = page.getByRole('region', { name: 'Archive results', exact: true })
  const view = results.getByRole('button', { name: 'View', exact: true })
  if (await view.isVisible()) await view.click()
  await results.getByRole('button', { name: `Undo archive of ${title}`, exact: true }).click()
}

test(
  'multiple idle archives retain independent Undo actions and cold archive identity',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'controlled_stop' })
    const f = await seed(fixture)
    let app: ElectronApplication | undefined
    try {
      app = await fixture.launch()
      let page = await app.firstWindow()
      const original = await readFile(f.sentinel, 'utf8')
      for (const title of ['First archive Session', 'Second archive Session']) {
        // oxlint-disable-next-line no-await-in-loop -- The second archive must preserve the first Undo action.
        await page.getByRole('button', { name: `Archive Session ${title}`, exact: true }).focus()
        // oxlint-disable-next-line no-await-in-loop
        await page.getByRole('button', { name: `Archive Session ${title}`, exact: true }).click()
        // oxlint-disable-next-line no-await-in-loop
        await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0)
      }
      const results = page.getByRole('region', { name: 'Archive results', exact: true })
      await expect(results.getByRole('status')).toHaveText('2 archived')
      await page.getByRole('button', { name: 'Archive Project Other Project', exact: true }).focus()
      await page.getByRole('button', { name: 'Archive Project Other Project', exact: true }).click()
      await expect(results.getByRole('status')).toHaveText('3 archived')
      await undo(page, 'First archive Session')
      await expect(results.getByRole('status')).toHaveText('2 archived')
      await expect(
        page.getByRole('button', { name: 'First archive Session', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Second archive Session', exact: true }),
      ).toHaveCount(0)
      await expect(
        results.getByRole('button', {
          name: 'Undo archive of Second archive Session',
          exact: true,
        }),
      ).toBeVisible()
      await undo(page, 'Other Project')
      await expect(results.getByRole('status')).toHaveText('1 archived')
      await expect(
        page.getByRole('button', { name: 'Rename Project Other Project', exact: true }),
      ).toBeVisible()
      expect(f.database.sessionRepository.find(f.first)?.status).not.toBe('archived')
      expect(f.database.sessionRepository.find(f.second)?.status).toBe('archived')
      expect(await readFile(f.sentinel, 'utf8')).toBe(original)
      await expect(
        readFile(join(fixture.directory, 'codex-app-server-state.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await quitPact(app, page)
      app = undefined
      app = await fixture.launch()
      page = await app.firstWindow()
      await expect(
        page.getByRole('button', { name: 'First archive Session', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Second archive Session', exact: true }),
      ).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Archive results', exact: true })).toHaveCount(
        0,
      )
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      f.database.close()
      await fixture.dispose()
    }
  },
)

test(
  'confirmed archive stops one live native task, cancels @all continuation and preserves saved output on Undo',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'controlled_stop' })
    const f = await seed(fixture)
    let app: ElectronApplication | undefined
    try {
      app = await fixture.launch()
      const page = await app.firstWindow()
      await page.getByRole('button', { name: 'First archive Session', exact: true }).click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('@all Preserve the original archive input')
      await composer.press('Enter')
      await expect(page.getByText('Controlled partial response remains visible.')).toBeVisible()
      const before = f.database.conversationRepository.read(f.first)
      const run = before.runs[0]!
      const answer = before.messages.find((message) => message.role === 'assistant')!
      expect(run).toMatchObject({ status: 'running', dispatchPhase: 'accepted' })
      const sessionRow = page.locator(`[data-session-menu="${f.first}"]`)
      const archive = sessionRow.getByRole('button', { name: /^Archive Session /u })
      await archive.focus()
      await archive.click()
      const confirmation = page.getByRole('dialog', { name: 'Stop and archive?', exact: true })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(f.database.sessionRepository.find(f.first)?.status).not.toBe('archived')
      expect(
        (await fixture.readCodexFacts()).methods.filter((method) => method === 'turn/interrupt'),
      ).toHaveLength(0)
      await expect(
        page.getByRole('button', { name: 'Stop Codex response', exact: true }),
      ).toBeVisible()
      await archive.focus()
      await archive.click()
      const archivedTitle = await confirmation.locator('.pact-archive-target').innerText()
      await confirmation.getByRole('button', { name: 'Stop and archive', exact: true }).click()
      const results = page.getByRole('region', { name: 'Archive results', exact: true })
      await expect(results.getByRole('status')).toHaveText('1 archived', { timeout: 25_000 })
      await expect(sessionRow).toHaveCount(0)
      const stopped = f.database.conversationRepository.read(f.first)
      expect(stopped.runs).toHaveLength(1)
      expect(stopped.runs[0]).toMatchObject({
        id: run.id,
        status: 'interrupted',
        nativeOutcome: 'interrupted',
        nativeEffectsState: 'settled',
      })
      expect(
        stopped.messages
          .find((message) => message.id === answer.id)
          ?.content.startsWith(answer.content),
      ).toBe(true)
      expect(stopped.messages.some((message) => message.pendingAgentId)).toBe(false)
      const facts = await fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(1)
      expect(facts.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1)
      await expect(
        readFile(join(fixture.directory, 'claude-sdk-state.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const receipt = f.database.drizzle.query.workspaceArchiveOperations
        .findFirst({
          where: (fields, { and, eq }) =>
            and(eq(fields.sessionId, f.first), eq(fields.state, 'archived')),
        })
        .sync()
      expect(receipt?.state).toBe('archived')
      await undo(page, archivedTitle)
      await expect(page.getByRole('heading', { name: archivedTitle, exact: true })).toBeVisible()
      await expect(sessionRow.locator('button[data-nav-primary]')).toBeVisible()
      expect(f.database.conversationRepository.read(f.first).runs.map((item) => item.id)).toEqual([
        run.id,
      ])
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      expect(await readFile(f.sentinel, 'utf8')).toBe(
        'User project content must survive archive and Undo.\n',
      )
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      f.database.close()
      await fixture.dispose()
    }
  },
)

test(
  'Project archive stops current work and preserves an independently archived Session until its Project is restored',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'controlled_stop' })
    const f = await seed(fixture)
    let app: ElectronApplication | undefined
    try {
      app = await fixture.launch()
      const page = await app.firstWindow()
      const second = page.getByRole('button', {
        name: 'Archive Session Second archive Session',
        exact: true,
      })
      await second.focus()
      await second.click()
      const results = page.getByRole('region', { name: 'Archive results', exact: true })
      await expect(results.getByRole('status')).toHaveText('1 archived')
      await page.getByRole('button', { name: 'First archive Session', exact: true }).click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill('@all Preserve Project archive output')
      await composer.press('Enter')
      await expect(page.getByText('Controlled partial response remains visible.')).toBeVisible()
      const original = f.database.conversationRepository.read(f.first)
      const run = original.runs[0]!
      const answer = original.messages.find((item) => item.role === 'assistant')!
      const archive = page.getByRole('button', {
        name: 'Archive Project Archive Project',
        exact: true,
      })
      await archive.focus()
      await archive.click()
      const confirmation = page.getByRole('dialog', { name: 'Stop and archive?', exact: true })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(f.database.projectCatalogRepository.find(f.projectId)?.archivedAt).toBeUndefined()
      expect(
        (await fixture.readCodexFacts()).methods.filter((method) => method === 'turn/interrupt'),
      ).toHaveLength(0)
      await archive.focus()
      await archive.click()
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Stop and archive', exact: true }).click()
      await expect(results.getByRole('status')).toHaveText('2 archived', { timeout: 25_000 })
      await expect(
        page.getByRole('button', { name: 'Rename Project Archive Project', exact: true }),
      ).toHaveCount(0)
      const stopped = f.database.conversationRepository.read(f.first)
      expect(stopped.runs).toHaveLength(1)
      expect(stopped.runs[0]).toMatchObject({
        id: run.id,
        nativeOutcome: 'interrupted',
        nativeEffectsState: 'settled',
      })
      expect(
        stopped.messages.find((item) => item.id === answer.id)?.content.startsWith(answer.content),
      ).toBe(true)
      await undo(page, 'Second archive Session')
      await expect(results.getByRole('alert')).toHaveText(
        'Restore or re-add its Project first, then undo this Session archive.',
      )
      expect(f.database.sessionRepository.find(f.second)?.status).toBe('archived')
      await undo(page, 'Archive Project')
      await expect(
        page.getByRole('button', { name: 'Rename Project Archive Project', exact: true }),
      ).toBeVisible()
      await expect(page.locator(`[data-session-menu="${f.first}"]`)).toBeVisible()
      await expect(page.locator(`[data-session-menu="${f.second}"]`)).toHaveCount(0)
      await undo(page, 'Second archive Session')
      await expect(
        page.getByRole('button', { name: 'Second archive Session', exact: true }),
      ).toBeVisible()
      expect(f.database.conversationRepository.read(f.first).runs.map((item) => item.id)).toEqual([
        run.id,
      ])
      const facts = await fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(1)
      expect(facts.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1)
      await expect(
        readFile(join(fixture.directory, 'claude-sdk-state.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(f.sentinel, 'utf8')).toBe(
        'User project content must survive archive and Undo.\n',
      )
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      f.database.close()
      await fixture.dispose()
    }
  },
)
