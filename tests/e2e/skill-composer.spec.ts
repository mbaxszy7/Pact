import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  addRealSession,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  selectRealSession,
} from './real-harness.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const createdAt = '2026-10-07T00:00:00.000Z'

/* oxlint-disable no-await-in-loop -- Ordered gestures share one real Electron window and its current Session. */
test(
  'real Skill menu keeps Plan at its original click position while native catalogs load',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const ctx = await launchRealWorkspace('real-skill-menu-position')
    try {
      const page = ctx.page
      const editor = page.getByRole('combobox', { name: 'Message' })
      const menu = page.getByRole('listbox', { name: 'Native Skills' })
      const plan = page.locator('#skill-pact-plan')
      const observations: unknown[] = []
      for (const [index, scenario] of [
        { width: 1440, height: 1000, gesture: 'click' },
        { width: 1796, height: 1013, gesture: 'hover' },
        { width: 1000, height: 720, gesture: 'click' },
        { width: 720, height: 520, gesture: 'hold' },
      ].entries()) {
        await ctx.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height)
        }, scenario)
        await page.emulateMedia({ reducedMotion: index === 2 ? 'reduce' : 'no-preference' })
        if (index > 0) {
          const id = await addRealSession(ctx, `Skill position ${index}`)
          await selectRealSession(ctx, id)
          ctx.sessionId = id
        }
        await page.mouse.move(20, 20)
        // Observe the real pending menu before either native catalog can arrive. The
        // callback reads DOM geometry only; it does not delay or replace the Bridge.
        const pending = page.evaluate(() => {
          return new Promise<{ x: number; y: number; height: number }>((complete, reject) => {
            const menuElement = document.querySelector('.pact-skill-menu')!
            const observer = new MutationObserver(() => {
              const planElement = menuElement.querySelector('#skill-pact-plan')
              if (
                menuElement.getAttribute('data-open') !== 'true' ||
                menuElement.getAttribute('aria-busy') !== 'true' ||
                !planElement
              )
                return
              const bounds = planElement.getBoundingClientRect()
              observer.disconnect()
              clearTimeout(deadline)
              complete({ x: bounds.x, y: bounds.y, height: bounds.height })
            })
            const deadline = window.setTimeout(() => {
              observer.disconnect()
              reject(new Error('The real pending Skill menu was not observed.'))
            }, 10_000)
            observer.observe(menuElement, { attributes: true, childList: true, subtree: true })
          })
        })
        const [before] = await Promise.all([pending, editor.fill('/')])
        const point = { x: before.x + 80, y: before.y + before.height / 2 }
        if (scenario.gesture !== 'click') await page.mouse.move(point.x, point.y)
        if (scenario.gesture === 'hold') await page.mouse.down()
        try {
          await expect(menu).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 })
          await expect(
            menu.locator('[role="option"]:not([id^="skill-pact-"])').first(),
          ).toBeVisible()
          const after = await plan.boundingBox()
          const hit = await page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.id,
            point,
          )
          observations.push({ scenario, before, after, hit })
          expect(after).not.toBeNull()
          expect(after!.x).toBeCloseTo(before.x, 1)
          expect(after!.y).toBeCloseTo(before.y, 1)
          expect(after!.height).toBeCloseTo(before.height, 1)
          expect(hit).toBe('skill-pact-plan')
          await page.screenshot({
            path: test.info().outputPath(`skill-menu-${scenario.width}x${scenario.height}.png`),
          })
        } finally {
          if (scenario.gesture === 'hold') await page.mouse.up()
        }
        if (scenario.gesture !== 'hold') await page.mouse.click(point.x, point.y)
        await expect(editor.locator('[data-pact-command="plan"]')).toHaveText('pact:plan')
        await expect(editor.getByRole('button', { name: /^Open .* Skill /u })).toHaveCount(0)
        await editor.fill('')
        await editor.press('Escape')
      }
      // Retained catalogs, filtering, scrolling and keyboard choices keep the same
      // command semantics after the cold-load physical-coordinate checks.
      for (const query of ['/', '/plan']) {
        await editor.fill(query)
        await expect(menu).toHaveAttribute('aria-busy', 'false')
        await plan.click()
        await page.keyboard.insertText('Inspect only; do not change files.')
        await expect(editor).toHaveText('pact:plan Inspect only; do not change files.')
        await editor.fill('')
        await editor.press('Escape')
      }
      for (const key of ['Tab', 'Enter']) {
        await editor.fill('/')
        await expect(menu).toHaveAttribute('aria-busy', 'false')
        await editor.press(key)
        await expect(editor.locator('[data-pact-command="plan"]')).toHaveText('pact:plan')
        await editor.fill('')
        await editor.press('Escape')
      }
      await editor.fill('/')
      await expect(menu).toHaveAttribute('aria-busy', 'false')
      await menu.hover()
      await page.mouse.wheel(0, 240)
      await editor.press('Escape')
      await editor.fill('')
      await editor.fill('/')
      await plan.click()
      await expect(editor.locator('[data-pact-command="plan"]')).toHaveText('pact:plan')
      await editor.fill('')
      await editor.press('Escape')
      const conversation = await readRealConversation(ctx)
      expect(conversation.runs).toHaveLength(0)
      expect(conversation.messages).toHaveLength(0)
      await test.info().attach('native-skill-menu-geometry', {
        body: Buffer.from(JSON.stringify(observations)),
        contentType: 'application/json',
      })
      await writeFile(
        test.info().outputPath('native-skill-menu-geometry.json'),
        JSON.stringify(observations, null, 2),
      )
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real Skill menu stays outside the Composer, dismisses, and preserves Pact command badges',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const ctx = await launchRealWorkspace('real-skill-menu-interaction')
    const page = ctx.page
    const editor = page.getByRole('combobox', { name: 'Message' })
    const menu = page.getByRole('listbox', { name: 'Native Skills' })
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Appearance', exact: true }).click()
      await page.getByRole('radio', { name: 'Dark', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await editor.fill('/')
      await expect(menu).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 })
      const bounds = await menu.boundingBox()
      const inputBounds = await page.locator('.pact-composer-box').boundingBox()
      expect(bounds).not.toBeNull()
      expect(inputBounds).not.toBeNull()
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(inputBounds!.y - 7)
      await editor.press('Escape')
      await expect(menu).toBeHidden()
      await editor.press('ArrowRight')
      await expect(menu).toBeHidden()
      await editor.fill('')
      await editor.fill('/')
      await expect(menu).toBeVisible()
      await page.getByRole('heading', { name: 'New session', exact: true }).click()
      await expect(menu).toBeHidden()
      await editor.click()
      await expect(menu).toBeHidden()
      for (const command of ['plan', 'review', 'build']) {
        await editor.fill('')
        await editor.fill(`/${command}`)
        await expect(menu).toBeVisible()
        await page.locator(`#skill-pact-${command}`).click()
        await expect(menu).toBeHidden()
        await expect(editor.locator(`[data-pact-command="${command}"]`)).toHaveText(
          `pact:${command}`,
        )
        await page.keyboard.insertText('Inspect without changing files.')
        if (command === 'plan')
          await page.locator('.pact-composer-box').screenshot({
            path: test.info().outputPath('pact-plan-badge.png'),
          })
        await editor.press('ControlOrMeta+a')
        // Exercise the production copy handler without replacing the user's system clipboard.
        const copied = await editor.evaluate((element) => {
          const clipboard = new DataTransfer()
          element.dispatchEvent(
            new ClipboardEvent('copy', {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          )
          return { text: clipboard.getData('text/plain'), formats: clipboard.types }
        })
        expect(copied.text).toBe(`/${command} Inspect without changing files.`)
        expect(copied.formats).toEqual(['text/plain'])
      }
      await editor.fill('')
      const replacement = page.locator('.input-replacement')
      const clipping = await replacement.evaluate((element) => {
        const facts = { clipped: false, changes: 0 }
        const observer = new MutationObserver(() => {
          if (element.getAttribute('data-transitioning') === 'true') {
            facts.changes++
            facts.clipped ||= getComputedStyle(element).overflowX === 'clip'
          }
        })
        observer.observe(element, { attributes: true })
        Reflect.set(element, 'skillClippingProbe', { facts, observer })
        return true
      })
      expect(clipping).toBe(true)
      await editor.fill('/missing-skill-menu-check')
      await expect(page.getByRole('alert').filter({ hasText: 'unavailable' })).toBeVisible()
      await editor.fill('/plan')
      await expect(page.getByRole('alert').filter({ hasText: 'unavailable' })).toHaveCount(0)
      await expect(menu).toBeVisible()
      const clippingFacts = await replacement.evaluate((element) => {
        const probe: unknown = Reflect.get(element, 'skillClippingProbe')
        if (!probe || typeof probe !== 'object') throw new Error('Clipping probe missing.')
        const observer: unknown = Reflect.get(probe, 'observer')
        const facts: unknown = Reflect.get(probe, 'facts')
        if (!(observer instanceof MutationObserver) || !facts || typeof facts !== 'object')
          throw new Error('Clipping probe is invalid.')
        const clipped: unknown = Reflect.get(facts, 'clipped')
        const changes: unknown = Reflect.get(facts, 'changes')
        if (typeof clipped !== 'boolean' || typeof changes !== 'number')
          throw new Error('Clipping facts are invalid.')
        observer.disconnect()
        Reflect.deleteProperty(element, 'skillClippingProbe')
        return { clipped, changes }
      })
      expect(clippingFacts.clipped).toBe(false)
      await page.screenshot({ path: test.info().outputPath('skill-menu-above-composer.png') })
      await editor.press('Escape')
      await editor.fill('')
      expect((await readRealConversation(ctx)).runs).toHaveLength(0)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

/* oxlint-enable no-await-in-loop */

async function prepare() {
  const documents = await mkdtemp(join(tmpdir(), 'pact-s01-documents-'))
  let fixture: RuntimeFixture | undefined
  try {
    const skills = await Promise.all(
      ['alpha', 'check', 'disabled'].map(async (name) => {
        const folder = join(documents, name)
        await mkdir(folder)
        const path = join(folder, 'SKILL.md')
        await writeFile(path, `# ${name}\n\nOwned ${name} Skill document.\n`)
        return {
          name,
          path,
          description: `Owned ${name} Skill`,
          scope: 'user',
          enabled: name !== 'disabled',
        }
      }),
    )
    fixture = await createRuntimeFixture({
      mode: 'deterministic',
      codexAppServer: 'complete',
      codexSkills: skills,
    })
    const directory = await fixture.createProjectDirectory('skill-composer')
    const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
    const projectId = randomUUID(),
      sessionId = randomUUID()
    try {
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Skill workspace',
        directoryPath: directory,
        kind: 'directory',
        createdAt,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'Skill Composer', createdAt },
        {
          primaryAgentId: 'codex',
          agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
    } finally {
      db.close()
    }
    const owned = fixture
    return {
      fixture: owned,
      skills,
      sessionId,
      async dispose(app?: Awaited<ReturnType<RuntimeFixture['launch']>>) {
        try {
          if (app) await quitPact(app)
        } finally {
          await owned.dispose()
        }
        await rm(documents, { recursive: true, force: true })
      },
    }
  } catch (error) {
    try {
      await fixture?.dispose()
    } finally {
      await rm(documents, { recursive: true, force: true })
    }
    throw error
  }
}

test(
  'selects a Skill by keyboard, previews its real source, and validates the target',
  { tag: '@deterministic' },
  async () => {
    const owned = await prepare()
    let app: Awaited<ReturnType<RuntimeFixture['launch']>> | undefined
    try {
      app = await owned.fixture.launch()
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Skill Composer', exact: true }).click()
      const editor = window.getByRole('combobox', { name: 'Message' })
      await editor.fill('/')
      await expect(window.getByRole('option', { name: /\/alpha\b/u })).toBeVisible()
      await expect(window.getByRole('option', { name: /\/disabled\b/u })).toHaveCount(0)
      await editor.fill('/check')
      await expect(window.getByRole('option', { name: /\/check\b/u })).toBeVisible()
      await editor.press('Tab')
      const chip = window.getByRole('button', { name: 'Open Codex Skill check', exact: true })
      await expect(chip).toBeVisible()
      await chip.click()
      await expect(
        window.getByText('Owned check Skill document.', { exact: false }).first(),
      ).toBeVisible()
      await window.getByRole('button', { name: 'Close Skill preview', exact: true }).click()
      await editor.focus()
      await editor.press('ControlOrMeta+ArrowLeft')
      await window.keyboard.insertText('@claude ')
      await expect(window.getByRole('alert').filter({ hasText: '@claude' })).toContainText(
        '@claude',
      )
      await expect(window.getByRole('alert').filter({ hasText: '@claude' })).toContainText('Codex')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
      await editor.press('ControlOrMeta+Shift+ArrowLeft')
      await window.keyboard.insertText('@codex ')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      expect((await owned.fixture.readCodexFacts()).modelStarts).toHaveLength(0)
    } finally {
      await owned.dispose(app)
    }
  },
)

test(
  'edits an ordered list with a Skill, undoes indentation, and sends one complete task',
  { tag: '@deterministic' },
  async () => {
    const owned = await prepare()
    let app: Awaited<ReturnType<RuntimeFixture['launch']>> | undefined
    try {
      app = await owned.fixture.launch()
      const window = await app.firstWindow()
      await window.getByRole('button', { name: 'Skill Composer', exact: true }).click()
      const editor = window.getByRole('combobox', { name: 'Message' })
      await editor.fill('1. first')
      await editor.press('Shift+Enter')
      await window.keyboard.insertText('second')
      await editor.press('Tab')
      await expect(editor.locator('[data-list-label]').nth(1)).toHaveAttribute(
        'data-list-label',
        'a.',
      )
      await editor.press('ControlOrMeta+z')
      await expect(editor.locator('[data-list-label]').nth(1)).toHaveAttribute(
        'data-list-label',
        '2.',
      )
      await editor.press('Tab')
      await editor.press(process.platform === 'win32' ? 'End' : 'ControlOrMeta+ArrowRight')
      await window.keyboard.insertText(' /check')
      await expect(window.getByRole('option', { name: /\/check\b/u })).toBeVisible()
      await editor.press('Tab')
      await expect(window.getByRole('button', { name: 'Open Codex Skill check' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await editor.press('Enter')
      await expect(window.getByRole('button', { name: 'Copy Codex message' })).toBeVisible()
      await expect(editor).toBeEmpty()
      const db = ReadonlyFixtureDatabase.open(owned.fixture)
      try {
        const messages = db.conversationRepository
          .read(owned.sessionId)
          .messages.filter((message) => message.role === 'user')
        expect(messages).toHaveLength(1)
        expect(messages[0]?.content).toBe('1. first\n    a. second /check')
        expect(messages[0]?.skills?.map((skill) => skill.name)).toEqual(['check'])
      } finally {
        db.close()
      }
      const facts = await owned.fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(1)
      expect(facts.skillInputs).toEqual([
        [{ name: 'check', path: owned.skills.find((skill) => skill.name === 'check')!.path }],
      ])
    } finally {
      await owned.dispose(app)
    }
  },
)
