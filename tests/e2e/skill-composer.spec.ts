import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const createdAt = '2026-10-07T00:00:00.000Z'

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
