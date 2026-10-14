import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

for (const command of ['ordinary', '/plan', '/build', '/review'] as const)
  test(
    `same authorized ${command} Turn publishes metadata without a Native name`,
    { tag: '@deterministic' },
    async ({ browserName: _browserName }, testInfo) => {
      const fixture = await createRuntimeFixture({
        codexAppServer: command === 'ordinary' ? 'complete' : 'collaboration',
        claudeConversation: 'collaboration',
        sessionTitles: true,
      })
      const db = await PactDatabase.open({
        filePath: fixture.databaseFile,
        migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
      })
      const projectId = randomUUID(),
        sessionId = randomUUID(),
        now = new Date().toISOString()
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Metadata title',
        directoryPath: await fixture.createProjectDirectory('metadata-title'),
        kind: 'directory',
        createdAt: now,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'New session', createdAt: now },
        {
          primaryAgentId: 'codex',
          agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
          maxDiscussionRounds: 6,
          runningMessagePolicy: 'immediate_safe_point',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      db.close()
      const app = await fixture.launch()
      const page = await app.firstWindow()
      try {
        await page.getByRole('button', { name: 'New session', exact: true }).click()
        const editor = page.getByRole('combobox', { name: 'Message', exact: true })
        await editor.fill(
          command === 'ordinary'
            ? 'Inspect cancellation ownership'
            : `${command} Inspect cancellation ownership`,
        )
        await editor.press('Enter')
        await expect(
          page.getByRole('heading', { name: 'Title from the authorized Turn', exact: true }),
        ).toBeVisible()
        await expect.poll(async () => (await fixture.readCodexFacts()).modelStarts.length).toBe(1)
        expect((await fixture.readCodexFacts()).threadStarts).toBe(1)
        await page
          .getByRole('heading', { name: 'Title from the authorized Turn', exact: true })
          .hover()
        await page.getByRole('button', { name: 'Rename Session', exact: true }).click()
        await page.getByRole('textbox', { name: 'Session title' }).fill('My deliberate title')
        await page.getByRole('button', { name: 'Save Session title' }).click()
        await expect(
          page.getByRole('heading', { name: 'My deliberate title', exact: true }),
        ).toBeVisible()
      } catch (error) {
        try {
          const observations = await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>('[aria-label="Session title"]')
            const save = document.querySelector<HTMLButtonElement>(
              '[aria-label="Save Session title"]',
            )
            return {
              schemaVersion: 1,
              phase: 'authorized-title-and-manual-rename',
              width: window.innerWidth,
              height: window.innerHeight,
              visibility: document.visibilityState,
              focusedTitleInput: input !== null && document.activeElement === input,
              titleInputPresent: input !== null,
              deliberateDraftPresent: input?.value === 'My deliberate title',
              savePresent: save !== null,
              saveDisabled: save?.disabled ?? null,
              deliberateTitlePresent: [...document.querySelectorAll('h1')].some(
                (heading) => heading.textContent === 'My deliberate title',
              ),
              openContextOverlays: document.querySelectorAll(
                '.workspace-context-overlay[data-open="true"]',
              ).length,
              workingIndicators: document.querySelectorAll('[aria-label$="is responding"]').length,
            }
          })
          const body = Buffer.from(JSON.stringify(observations))
          if (body.byteLength > 4096)
            throw new Error('Native title scalar diagnostics exceed their byte bound', {
              cause: error,
            })
          await testInfo.attach('native-title-scalar-diagnostics', {
            body,
            contentType: 'application/json',
          })
        } catch (diagnosticError) {
          throw new AggregateError(
            [error],
            'Native title failed and scalar diagnostics were unavailable',
            { cause: diagnosticError },
          )
        }
        throw error
      } finally {
        await app.close()
        await fixture.dispose()
      }
    },
  )

test(
  'Claude root metadata updates the title while child metadata is ignored',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      codexAppServer: 'complete',
      claudeConversation: 'complete',
      sessionTitles: true,
    })
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      now = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Claude title',
      directoryPath: await fixture.createProjectDirectory('claude-metadata'),
      kind: 'directory',
      createdAt: now,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'New session', createdAt: now },
      {
        primaryAgentId: 'claude',
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        runningMessagePolicy: 'immediate_safe_point',
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    db.close()
    const app = await fixture.launch()
    try {
      const page = await app.firstWindow()
      await page.getByRole('button', { name: 'New session', exact: true }).click()
      await page
        .getByRole('combobox', { name: 'Message', exact: true })
        .fill('Inspect cancellation ownership')
      await page.getByRole('combobox', { name: 'Message', exact: true }).press('Enter')
      await expect(
        page.getByRole('heading', { name: 'Title from the authorized Turn', exact: true }),
      ).toBeVisible()
      await expect(page.getByText('Claude fixture response.', { exact: true })).toBeVisible()
      expect((await fixture.readClaudeFacts()).count).toBe(1)
      await expect(
        page.getByRole('heading', { name: 'Untrusted child title', exact: true }),
      ).toHaveCount(0)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

test(
  'keeps the Native first title, renames through IPC and preserves user title on cold resume',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'native_title' })
    const directory = await fixture.createProjectDirectory('native-title')
    const db = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    const projectId = randomUUID(),
      sessionId = randomUUID(),
      now = new Date().toISOString()
    try {
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Title project',
        directoryPath: directory,
        kind: 'directory',
        createdAt: now,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'Title fixture', createdAt: now },
        {
          primaryAgentId: 'codex',
          agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          runningMessagePolicy: 'next_round',
          maxReviewCycles: 2,
          maxRepairAttempts: 2,
        },
      )
    } finally {
      db.close()
    }
    let app = await fixture.launch()
    try {
      let window = await app.firstWindow()
      await window.getByRole('button', { name: 'Title fixture', exact: true }).click()
      let composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Question with a different local fallback title')
      await composer.press('Enter')
      await expect(
        window.getByRole('heading', { name: 'Native auto title', exact: true }),
      ).toBeVisible()
      await expect
        .poll(async () => (await fixture.readCodexFacts()).threads?.['fixture-thread']?.name)
        .toBe('[Pact] Title project · Native auto title')
      await window.getByRole('heading', { name: 'Native auto title', exact: true }).hover()
      await window.getByRole('button', { name: 'Rename Session', exact: true }).click()
      await window.getByRole('textbox', { name: 'Session title' }).fill('My saved title')
      await window.getByRole('button', { name: 'Save Session title' }).click()
      await expect(
        window.getByRole('heading', { name: 'My saved title', exact: true }),
      ).toBeVisible()
      await expect
        .poll(async () => (await fixture.readCodexFacts()).threads?.['fixture-thread']?.name)
        .toBe('[Pact] Title project · My saved title')
      let facts = await fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(1)
      expect(facts.threadStarts).toBe(1)
      expect(facts.methods.indexOf('thread/name/set')).toBeGreaterThan(
        facts.methods.indexOf('turn/start'),
      )
      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      await window.getByRole('button', { name: 'My saved title', exact: true }).click()
      composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Second independently requested task')
      await composer.press('Enter')
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(2)
      await expect(
        window.getByRole('heading', { name: 'My saved title', exact: true }),
      ).toBeVisible()
      facts = await fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(2)
      expect(facts.threadStarts).toBe(1)
      expect(facts.threads?.['fixture-thread']?.name).toBe('[Pact] Title project · My saved title')
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)
