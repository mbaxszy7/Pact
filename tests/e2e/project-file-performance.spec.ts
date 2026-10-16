import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { symlink, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

test(
  'keeps maximum-size plain files complete while mounting only viewport code rows',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const sessionTitle = await seedFiles(fixture, {
      'many.unknown': 'x\n'.repeat(100_000),
      'long.unknown': 'a'.repeat(900_000),
    })
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await openSession(window, sessionTitle)
      await window.getByRole('button', { name: 'many.unknown' }).click()
      await expect(window.getByLabel('many.unknown source code')).toBeAttached()
      await expect(window.locator('.monaco-editor .view-line').first()).toBeVisible()
      const mountedRows = await window.locator('.monaco-editor .view-line').count()
      const panelHeight = await window
        .locator('.monaco-editor')
        .evaluate((node) => node.getBoundingClientRect().height)
      expect(mountedRows).toBeLessThanOrEqual(Math.ceil(panelHeight / 20) + 32)
      await window.getByRole('button', { name: 'Close file preview' }).click()

      await window.getByRole('button', { name: 'long.unknown' }).click()
      const source = window.getByRole('textbox', { name: 'long.unknown source' })
      await expect(source).toBeVisible()
      const longLine = await source.evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement)) throw new Error('Plain file is not a textarea.')
        node.setSelectionRange(800_000, 800_000)
        node.blur()
        node.focus()
        return {
          length: node.value.length,
          column: node.selectionStart,
          scrollLeft: node.scrollLeft,
        }
      })
      expect(longLine.length).toBe(900_000)
      expect(longLine.column).toBe(800_000)
      expect(longLine.scrollLeft).toBeGreaterThan(0)
      await window.getByRole('button', { name: 'Wrap lines and hide line numbers' }).click()
      await expect(source).toHaveAttribute('wrap', 'soft')
      await expect(window.locator('[data-pact-plain-line]')).toHaveCount(0)
      await window.getByRole('button', { name: 'Close file preview' }).click()
      await expect(window.locator('.monaco-editor')).toHaveCount(0)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

test(
  'recreates JSON language service across TypeScript and releases Workers after repeated views',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(180_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const sessionTitle = await seedFiles(fixture, {
      'bad.json': '{"broken": }',
      'simple.ts': 'export const answer = 42\n',
    })
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await openSession(window, sessionTitle)
      await window.evaluate(() => {
        const created: string[] = []
        const terminated: string[] = []
        const OriginalWorker = globalThis.Worker
        globalThis.Worker = class extends OriginalWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args)
            created.push(String(args[0]))
            const terminate = this.terminate.bind(this)
            this.terminate = () => {
              terminated.push(String(args[0]))
              terminate()
            }
          }
        }
        Reflect.set(globalThis, 'PactWorkerCounts', { created, terminated })
      })
      const counts = async (): Promise<{
        jsonCreated: number
        jsonTerminated: number
        active: number
      }> =>
        window.evaluate(() => {
          const value: unknown = Reflect.get(globalThis, 'PactWorkerCounts')
          if (
            !value ||
            typeof value !== 'object' ||
            !('created' in value) ||
            !('terminated' in value)
          )
            throw new Error('Worker counter is missing.')
          const created: unknown = Reflect.get(value, 'created')
          const terminated: unknown = Reflect.get(value, 'terminated')
          if (!Array.isArray(created) || !Array.isArray(terminated))
            throw new Error('Worker counters are invalid.')
          return {
            jsonCreated: created.filter(
              (url: unknown) => typeof url === 'string' && url.includes('json.worker'),
            ).length,
            jsonTerminated: terminated.filter(
              (url: unknown) => typeof url === 'string' && url.includes('json.worker'),
            ).length,
            active: created.length - terminated.length,
          }
        })

      await window.getByRole('button', { name: 'bad.json' }).click()
      await expect.poll(async () => (await counts()).jsonCreated).toBe(1)
      await window.getByRole('button', { name: 'Close file preview' }).click()
      await expect.poll(async () => (await counts()).jsonTerminated).toBe(1)

      await window.getByRole('button', { name: 'simple.ts' }).click()
      await expect(window.getByLabel('simple.ts source code')).toBeAttached()
      await window.getByRole('button', { name: 'Close file preview' }).click()

      await window.getByRole('button', { name: 'bad.json' }).click()
      await expect.poll(async () => (await counts()).jsonCreated).toBe(2)
      await window.getByRole('button', { name: 'Close file preview' }).click()
      await expect.poll(async () => (await counts()).jsonTerminated).toBe(2)

      for (let index = 0; index < 100; index += 1) {
        // Ownership is measured only after each preceding view has closed.
        // oxlint-disable-next-line no-await-in-loop
        await window.getByRole('button', { name: 'simple.ts' }).click()
        // oxlint-disable-next-line no-await-in-loop
        await expect(window.getByLabel('simple.ts source code')).toBeAttached()
        // oxlint-disable-next-line no-await-in-loop
        await window.getByRole('button', { name: 'Close file preview' }).click()
      }
      await expect.poll(async () => (await counts()).active).toBe(0)
      await expect(window.locator('.monaco-editor')).toHaveCount(0)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

test(
  'applies the same Comment quote limit to LF-normalized CRLF files',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const sessionTitle = await seedFiles(fixture, {
      'allowed.ts': 'x\r\n'.repeat(10_000),
      'too-large.ts': 'x\r\n'.repeat(10_001),
    })
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await openSession(window, sessionTitle)
      const selectAllCode = async (name: string): Promise<void> => {
        await window.getByRole('button', { name }).click()
        await expect(window.locator('.monaco-editor .view-line').first()).toBeVisible()
        await window.locator('.monaco-editor').click({ position: { x: 100, y: 80 } })
        await window.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      }
      await selectAllCode('allowed.ts')
      await expect(window.getByRole('button', { name: 'Comment on selected code' })).toBeVisible()
      await expect(window.getByText('Select at most 20,000 characters')).toHaveCount(0)
      await window.getByRole('button', { name: 'Close file preview' }).click()

      await selectAllCode('too-large.ts')
      await expect(window.getByText('Select at most 20,000 characters')).toBeVisible()
      await expect(window.getByRole('button', { name: 'Comment on selected code' })).toHaveCount(0)
    } finally {
      await app.close()
      await fixture.dispose()
    }
  },
)

async function seedFiles(
  fixture: RuntimeFixture,
  files: Record<string, string>,
  externalLinks: string[] = [],
): Promise<string> {
  const directoryPath = await fixture.createProjectDirectory('project-file-performance')
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await writeFile(resolve(directoryPath, name), content)
    }),
  )
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const sessionTitle = 'Project file performance fixture'
  const createdAt = new Date().toISOString()
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'project-file-performance',
    directoryPath,
    kind: 'git',
    createdAt,
  })
  database.sessionRepository.create(
    { id: sessionId, projectId, title: sessionTitle, createdAt },
    {
      primaryAgentId: 'codex',
      agents: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      maxDiscussionRounds: 6,
      runningMessagePolicy: 'immediate_safe_point',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const started = database.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Open the project files.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  database.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId: 'codex',
    type: 'text.completed',
    turnId: 'fixture-turn',
    outputId: 'fixture-output',
    text: [...Object.keys(files).map((name) => `[${name}](${name})`), ...externalLinks].join(' · '),
  })
  database.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId: 'codex',
    type: 'turn.completed',
    turnId: 'fixture-turn',
    outcome: 'completed',
  })
  database.close()
  return sessionTitle
}

async function openSession(window: Page, title: string): Promise<void> {
  const session = window.getByRole('button', { name: title, exact: true })
  await expect(session).toBeVisible()
  await session.click()
}

test(
  'previews external local file links while retaining Project Comment boundaries',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    try {
      const externalPath = resolve(fixture.directory, 'SKILL.md')
      const markdownPath =
        process.platform === 'win32' ? externalPath.replaceAll('\\', '/') : externalPath
      await writeFile(externalPath, '# Local skill\n\nRead only\n')
      const title = await seedFiles(fixture, { 'inside.ts': 'export const answer = 42\n' }, [
        `[External skill](${markdownPath}#L3)`,
        '[Traversal](../SKILL.md)',
        '[Symlink](escape.md)',
      ])
      await symlink(
        externalPath,
        resolve(fixture.directory, 'project-file-performance/escape.md'),
        'file',
      )
      const app = await fixture.launch()
      const window = await app.firstWindow()
      await openSession(window, title)
      await window.getByRole('button', { name: 'External skill', exact: true }).click()
      await expect(window.getByRole('heading', { name: 'SKILL.md', exact: true })).toBeVisible()
      await expect(window.locator('.pact-monaco-linked-range')).toBeVisible()
      const source = window.getByLabel(
        `${relative(resolve(fixture.directory, 'project-file-performance'), externalPath)} source code`,
      )
      await expect(source).toBeAttached()
      await window.locator('.monaco-editor .view-line').first().click()
      await window.keyboard.press('ControlOrMeta+A')
      await expect(window.getByRole('button', { name: 'Comment on selected code' })).toHaveCount(0)
      await window.getByRole('button', { name: 'Close file preview' }).click()
      await expect(window.locator('.monaco-editor')).toHaveCount(0)

      // oxlint-disable eslint/no-await-in-loop -- Each case uses the same panel and must finish closing before the next click.
      for (const name of ['Traversal', 'Symlink']) {
        await window.getByRole('button', { name, exact: true }).click()
        await expect(
          window.getByRole('heading', { name: 'File preview unavailable' }),
        ).toBeVisible()
        await expect(
          window.getByText('Use an absolute path to preview a file outside this Project.'),
        ).toBeVisible()
        await window.getByRole('button', { name: 'Close file preview' }).click()
      }
      // oxlint-enable eslint/no-await-in-loop

      await window.getByRole('button', { name: 'inside.ts', exact: true }).click()
      const inside = window.getByLabel('inside.ts source code')
      await expect(inside).toBeAttached()
      await window.locator('.monaco-editor .view-line').first().click()
      await window.keyboard.press('ControlOrMeta+A')
      await expect(window.getByRole('button', { name: 'Comment on selected code' })).toBeVisible()
    } finally {
      await fixture.dispose()
    }
  },
)
