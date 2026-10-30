import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { syncEvaluationActivity } from '../../packages/persistence/src/conversation-scheduling-activity.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  schedulingEvaluations,
  schedulingHandoffs,
} from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const source = 'The typed IPC boundary keeps the Renderer isolated from privileged code.'
async function seed(fixture: RuntimeFixture, activity = 0) {
  const directory = await fixture.createProjectDirectory('relay'),
    db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Relay fixture',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Retained Relay draft', createdAt },
      {
        primaryAgentId: 'codex',
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const started = db.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Explain the boundary.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    db.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId: 'fixture',
      outputId: 'source',
      text: source,
    })
    db.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'fixture',
      outcome: 'completed',
    })
    const handoffId = 'a'.repeat(64)
    db.drizzle
      .insert(schedulingHandoffs)
      .values({
        id: handoffId,
        sessionId,
        budgetSubjectId: `input:${started.run.userMessageId}`,
        eventId: 'ordinary-default-handoff',
        slot: 'workflow_next',
        factFingerprint: 'b'.repeat(64),
        freshnessGuardJson: '{}',
        createdAt,
      })
      .run()
    if (activity) {
      db.conversationRepository.saveSchedulingSettings({ expectedRevision: 0, enabled: true })
      db.drizzle.transaction((tx) => {
        for (let index = 0; index < activity; index++) {
          const id = randomUUID()
          tx.insert(schedulingEvaluations)
            .values({
              id,
              sessionId,
              handoffId,
              budgetSubjectId: `fixture:${id}`,
              factFingerprint: id.replaceAll('-', '').padEnd(64, '0'),
              configurationFingerprint: 'c'.repeat(64),
              handoffJson: '{}',
              provider: 'codex',
              model: 'gpt-6-luna',
              active: false,
              called: false,
              outcome: 'not_sent',
              createdAt: new Date(Date.now() - index * 1000 - 1000).toISOString(),
              deadline: createdAt,
              settledAt: createdAt,
            })
            .run()
          // Retained evaluation facts and their disposable projection use the same owner as live producers.
          syncEvaluationActivity(db.drizzle, id)
        }
      })
      const projected = db.conversationRepository.readSchedulingActivity({})
      expect(projected.rows).toHaveLength(Math.min(activity, 25))
      expect(
        projected.rows.every((row) => !row.called && row.provider === null && row.model === null),
      ).toBe(true)
    }
    return { sessionId }
  } finally {
    db.close()
  }
}
async function openRelay(page: Page) {
  await page.getByRole('button', { name: /^(Open settings|Settings)$/u }).click()
  await page.getByRole('button', { name: 'Relay', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toBeVisible()
}
async function settings(page: Page) {
  return page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getSchedulingSettings()
  })
}
async function schedulingState(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getSchedulingState({ sessionId: id })
  }, sessionId)
}

test(
  'Relay preserves rich drafts through navigation and persists global intent and Comments across restart',
  { tag: '@deterministic' },
  async () => {
    const skillDirectory = await mkdtemp(join(tmpdir(), 'pact-relay-skill-'))
    let owned: RuntimeFixture | undefined
    let app: Awaited<ReturnType<RuntimeFixture['launch']>> | undefined
    try {
      const skillPath = join(skillDirectory, 'SKILL.md')
      await writeFile(skillPath, '# Check\n\nOwned review Skill source.\n')
      const fixture = await createRuntimeFixture({
        mode: 'deterministic',
        codexAppServer: 'complete',
        codexModels: [{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna' }],
        codexSkills: [
          {
            name: 'check',
            description: 'Owned review skill',
            path: skillPath,
            scope: 'user',
            enabled: true,
          },
        ],
      })
      owned = fixture
      const { sessionId } = await seed(fixture)
      app = await fixture.launch()
      let page = await app.firstWindow()
      await page.getByRole('button', { name: 'Retained Relay draft', exact: true }).click()
      const editor = page.getByRole('combobox', { name: 'Message', exact: true })
      await editor.fill('/check')
      await expect(page.getByRole('option', { name: /\/check\b/u })).toBeVisible()
      await editor.press('Tab')
      await editor.press('ControlOrMeta+ArrowLeft')
      await page.keyboard.insertText('@codex ')
      await editor.press('End')
      await page.keyboard.insertText(' Retain the complete draft across Relay navigation.')
      const draft = await editor.textContent()
      await page.evaluate((phrase) => {
        const host = [
          ...document.querySelectorAll<HTMLElement>('[data-pact-message-content]'),
        ].find((node) => node.textContent?.includes(phrase))
        const span = host?.querySelector('[data-pact-projection-start]'),
          text = span?.firstChild
        if (!host || !(text instanceof Text) || !span) throw Error('Source projection missing')
        const start = text.data.indexOf('typed IPC'),
          range = document.createRange()
        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        range.setStart(text, start)
        range.setEnd(text, start + 9)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      }, source)
      await page.getByRole('button', { name: 'Comment on selected text' }).click()
      await page
        .getByRole('textbox', { name: 'Comment', exact: true })
        .fill('Keep this exact boundary anchor.')
      await page.getByRole('textbox', { name: 'Comment', exact: true }).press('Enter')
      await expect(page.getByLabel('Attached Comment drafts')).toContainText(
        'Keep this exact boundary anchor.',
      )
      const image = join(fixture.directory, 'draft.png')
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        return canvas.toDataURL('image/png').split(',')[1]!
      })
      await writeFile(image, Buffer.from(png, 'base64'))
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, image)
      await page.getByRole('button', { name: 'Add images', exact: true }).click()
      await expect(page.getByLabel('Attached images').locator('img')).toHaveCount(1)
      await expect
        .poll(() =>
          page
            .getByLabel('Attached images')
            .locator('img')
            .evaluate(
              (thumbnail) =>
                thumbnail instanceof HTMLImageElement &&
                thumbnail.complete &&
                thumbnail.naturalWidth > 0,
            ),
        )
        .toBe(true)
      await openRelay(page)
      const toggle = page.getByRole('switch', { name: 'Enable Relay', exact: true })
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(toggle).toHaveAttribute('aria-disabled', 'false')
      await expect(page.getByRole('radiogroup', { name: 'Model' })).toHaveCount(0)
      await toggle.focus()
      await page.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      const luna = page.getByRole('radio', { name: 'GPT-6 Luna · Codex', exact: true })
      await expect(luna).toBeEnabled()
      await page.getByText('GPT-6 Luna · Codex', { exact: true }).click()
      await expect(luna).toBeChecked()
      await expect
        .poll(() => settings(page))
        .toMatchObject({
          ok: true,
          value: { enabled: true, selection: { modelId: 'gpt-6-luna' } },
        })
      await expect(
        page.getByRole('radio', { name: 'Haiku 5.5 · Claude Code', exact: true }),
      ).toBeDisabled()
      await expect
        .poll(() => schedulingState(page, sessionId))
        .toMatchObject({
          ok: true,
          value: {
            context: {
              sessionId,
              eligibility: 'unconfirmed',
              observation: { status: 'unconfirmed', capability: null, expiresAt: null },
            },
            activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
          },
        })
      await page
        .getByRole('button', { name: 'Refresh models and compatibility', exact: true })
        .click()
      await expect
        .poll(() => schedulingState(page, sessionId))
        .toMatchObject({
          ok: true,
          value: {
            context: {
              sessionId,
              eligibility: 'unavailable',
              observation: {
                status: 'unavailable',
                capability: {
                  provider: 'codex',
                  modelId: 'gpt-6-luna',
                  status: 'unavailable',
                  supported: false,
                  reason:
                    process.platform === 'darwin' ? 'unsupported_protocol' : 'unsupported_platform',
                  physicalReleased: true,
                },
              },
            },
            activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
          },
        })
      await expect(
        page.getByText(
          process.platform === 'darwin'
            ? 'The installed native runtime does not support Relay decisions.'
            : 'This platform does not support Relay decisions.',
          { exact: true },
        ),
      ).toBeVisible()
      await expect(page.getByText('No activity yet.')).toBeVisible()
      await page.getByRole('switch', { name: 'Show activity indicator' }).click()
      await expect
        .poll(() => settings(page))
        .toMatchObject({ ok: true, value: { showIndicator: false } })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByRole('region', { name: 'Relay activity' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(editor).toHaveText(draft!)
      await expect(
        page.getByRole('button', { name: 'Open Codex Skill check', exact: true }),
      ).toBeVisible()
      await expect(page.getByLabel('Attached images').locator('img')).toHaveCount(1)
      await expect(page.getByLabel('Attached Comment drafts')).toContainText(
        'Keep this exact boundary anchor.',
      )
      expect((await fixture.readCodexFacts()).modelStarts).toEqual([])
      const observation = ReadonlyFixtureDatabase.open(fixture)
      try {
        const saved = observation.conversationRepository.read(sessionId)
        expect(saved.runs).toHaveLength(1)
        expect(saved.comments[0]?.anchor).toMatchObject({
          type: 'message',
          startOffset: 4,
          endOffset: 13,
          quote: 'typed IPC',
        })
      } finally {
        observation.close()
      }
      await quitPact(app)
      app = await fixture.launch()
      page = await app.firstWindow()
      await openRelay(page)
      await expect(page.getByRole('switch', { name: 'Enable Relay' })).toHaveAttribute(
        'aria-checked',
        'false',
      )
      await expect
        .poll(() => settings(page))
        .toMatchObject({
          ok: true,
          value: {
            enabled: false,
            showIndicator: false,
            selection: { modelId: 'gpt-6-luna' },
          },
        })
      await expect
        .poll(() => schedulingState(page, sessionId))
        .toMatchObject({
          ok: true,
          value: {
            settings: {
              enabled: false,
              showIndicator: false,
              selection: { modelId: 'gpt-6-luna' },
            },
            context: {
              sessionId,
              eligibility: 'disabled',
              observation: { status: 'unconfirmed', capability: null, expiresAt: null },
            },
            activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
          },
        })
      await page.getByRole('button', { name: 'Back to app' }).click()
      await page.getByRole('button', { name: 'Retained Relay draft', exact: true }).click()
      await expect(page.getByLabel('Attached Comment drafts')).toContainText(
        'Keep this exact boundary anchor.',
      )
      // Ordinary body/images clear on App restart; durable Comment drafts retain their original anchor.
      await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toHaveText('')
      await expect(page.getByLabel('Attached images')).toHaveCount(0)
      expect((await fixture.readCodexFacts()).modelStarts).toEqual([])
    } finally {
      if (app) await quitPact(app)
      await owned?.dispose()
      await rm(skillDirectory, { recursive: true, force: true })
    }
  },
)

test(
  'Relay Activity pages authoritative fixture history read-only and preserves browser selection on a live settings event',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      codexAppServer: 'complete',
      codexModels: [{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna' }],
    })
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      await seed(fixture, 130)
      app = await fixture.launch()
      const page = await app.firstWindow()
      await openRelay(page)
      const activity = page.getByRole('region', { name: 'Relay activity', exact: true })
      await expect(activity.locator('[data-activity-row]')).toHaveCount(25)
      await expect(activity).toContainText('Result: No decision request sent')
      await expect(activity.getByRole('button')).toHaveCount(0)
      await expect(activity.getByRole('link')).toHaveCount(0)
      const title = activity.locator('[data-activity-row]').first().locator('p').first()
      await expect(title).toHaveText('Relay fixture · Retained Relay draft')
      await title.scrollIntoViewIfNeeded()
      await expect(title).toBeVisible()
      const selected = await activity.evaluate((element) => {
        const text = element.querySelector('[data-activity-row] p')?.firstChild
        if (!(text instanceof Text) || text.data !== 'Relay fixture')
          throw Error('The complete visible activity title is unavailable')
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, text.length)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return text.data
      })
      expect(selected).toBe('Relay fixture')
      await expect
        .poll(() => page.evaluate(() => document.getSelection()?.toString()))
        .toBe(selected)
      const first = await activity.locator('[data-activity-row]').first().elementHandle()
      if (!first) throw Error('Activity row missing')
      await page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const current = await bridge.getSchedulingSettings()
        if (!current.ok) throw Error('Settings missing')
        const saved = await bridge.saveSchedulingSettings({
          expectedRevision: current.value.revision,
          showIndicator: false,
        })
        if (!saved.ok) throw Error('Settings save failed')
      })
      await expect(page.getByRole('switch', { name: 'Show activity indicator' })).toHaveAttribute(
        'aria-checked',
        'false',
      )
      expect(await first.evaluate((node) => node.isConnected)).toBe(true)
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
      for (const expected of [50, 75, 100]) {
        // oxlint-disable-next-line no-await-in-loop -- Pagination starts after the preceding page is mounted.
        await activity.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        // oxlint-disable-next-line no-await-in-loop -- Observe each page before requesting its successor.
        await expect(activity.locator('[data-activity-row]')).toHaveCount(expected)
      }
      expect(
        await activity
          .locator('[data-activity-row]')
          .evaluateAll(
            (nodes) => new Set(nodes.map((node) => node.getAttribute('data-activity-row'))).size,
          ),
      ).toBe(100)
      const oldTail = await activity
        .locator('[data-activity-row]')
        .last()
        .getAttribute('data-activity-row')
      const anchor = await activity.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        const top = element.getBoundingClientRect().top
        const row = [...element.querySelectorAll<HTMLElement>('[data-activity-row]')].find(
          (node) => node.getBoundingClientRect().bottom > top,
        )
        if (!row) throw Error('Visible activity anchor missing')
        return { id: row.dataset.activityRow!, top: row.getBoundingClientRect().top - top }
      })
      await expect
        .poll(() =>
          activity.locator('[data-activity-row]').last().getAttribute('data-activity-row'),
        )
        .not.toBe(oldTail)
      await expect(activity.locator('[data-activity-row]')).toHaveCount(100)
      const anchored = activity.locator(`[data-activity-row="${anchor.id}"]`)
      const offset = await anchored.evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node.closest('.relay-activity-list')!.getBoundingClientRect().top,
      )
      expect(Math.abs(offset - anchor.top)).toBeLessThan(1)
      await page.getByRole('button', { name: 'Appearance', exact: true }).click()
      await page.getByRole('button', { name: 'Relay', exact: true }).click()
      await expect(activity.locator('[data-activity-row]')).toHaveCount(25)
      expect((await fixture.readCodexFacts()).modelStarts).toEqual([])
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)
