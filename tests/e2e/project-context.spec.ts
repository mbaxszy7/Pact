import { expect, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'macOS Project menus use the registered folder, refresh Git facts, and copy exact values',
  { tag: '@ui' },
  async () => {
    test.skip(process.platform !== 'darwin', 'Verifies the macOS menu wording and clipboard')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const repository = await fixture.createProjectDirectory('repository')
    const nested = await fixture.createProjectDirectory('repository/nested-folder', false)
    const plain = await fixture.createProjectDirectory('plain-folder', false)
    const home = join(fixture.directory, 'git-home')
    await mkdir(home)
    const git = async (...args: string[]) => {
      const result = await promisify(execFile)(
        '/usr/bin/git',
        ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          timeout: 3000,
          maxBuffer: 64 * 1024,
          shell: false,
        },
      )
      return result.stdout.trim()
    }
    const database = await PactDatabase.open({
      filePath: fixture.databaseFile,
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    const rows = [nested, plain].map((directoryPath, index) => {
      const projectId = randomUUID(),
        id = randomUUID(),
        createdAt = new Date().toISOString()
      database.projectCatalogRepository.add({
        id: projectId,
        name: `Display ${index}`,
        directoryPath,
        kind: 'directory',
        createdAt,
      })
      database.sessionRepository.create(
        { id, projectId, title: `Context ${index}`, createdAt },
        {
          primaryAgentId: 'codex',
          agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          runningMessagePolicy: 'next_round',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      return { id, projectId }
    })
    let app: ElectronApplication | undefined
    let observer: ReadonlyFixtureDatabase | undefined
    const writtenClipboard = [nested, 'codex/context-before']
    try {
      await writeFile(join(repository, 'fixture.txt'), 'Owned Git context fixture\n')
      await git('add', 'fixture.txt')
      await git(
        '-c',
        'user.name=Pact Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Owned context fixture',
      )
      await git('checkout', '--quiet', '-b', 'codex/context-before')
      database.close()
      observer = ReadonlyFixtureDatabase.open(fixture)
      app = await fixture.launch()
      const page = await app.firstWindow()
      // Playwright otherwise keeps document focus emulated even while the actual
      // macOS window is hidden, suppressing the native return-to-window event.
      const cdp = await app.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true })
        BrowserWindow.getAllWindows()[0]!.focus()
      })
      await page.getByRole('button', { name: 'Context 0', exact: true }).click()
      const folder = page.getByRole('button', {
        name: 'Project folder: nested-folder',
        exact: true,
      })
      await expect(folder).toHaveAttribute('title', nested)
      await expect(
        page.getByRole('button', { name: 'Git branch: codex/context-before', exact: true }),
      ).toBeVisible()
      expect(
        await page.evaluate(async (projectId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return (await bridge.renameProject({ projectId, name: 'Renamed display' })).ok
        }, rows[0]!.projectId),
      ).toBe(true)
      await expect(folder).toBeVisible()
      await folder.focus()
      await page.keyboard.press('ArrowDown')
      await expect(
        page.getByRole('menuitem', { name: 'Open in Finder', exact: true }),
      ).toBeFocused()
      await page.keyboard.press('End')
      await expect(page.getByRole('menuitem', { name: 'Copy path', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByText('Project path copied', { exact: true })).toBeAttached()
      // Return only equality; never expose a previous clipboard value in test diagnostics.
      await expect
        .poll(() =>
          app!.evaluate(
            async ({ clipboard }, expected) => (await clipboard.readText()) === expected,
            nested,
          ),
        )
        .toBe(true)
      await expect(folder).toBeFocused()
      await page
        .getByRole('button', { name: 'Git branch: codex/context-before', exact: true })
        .click()
      await page.getByRole('menuitem', { name: 'Copy branch name', exact: true }).click()
      await expect(page.getByText('Branch name copied', { exact: true })).toBeAttached()
      expect(
        await app.evaluate(
          async ({ clipboard }) => (await clipboard.readText()) === 'codex/context-before',
        ),
      ).toBe(true)
      await git('checkout', '--quiet', '-b', 'codex/context-after')
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.hide()
      })
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
        )
        .toBe(false)
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.show()
        BrowserWindow.getAllWindows()[0]!.focus()
        BrowserWindow.getAllWindows()[0]!.webContents.focus()
        nativeApp.focus({ steal: true })
      })
      await expect(
        page.getByRole('button', { name: 'Git branch: codex/context-after', exact: true }),
      ).toBeVisible()
      await git('checkout', '--quiet', '--detach', 'HEAD')
      const commit = await git('rev-parse', '--short=8', 'HEAD')
      await page
        .getByRole('button', { name: 'Git branch: codex/context-after', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: `Git branch: Detached · ${commit}`, exact: true }),
      ).toBeVisible()
      await expect(page.getByText('No branch is checked out.', { exact: true })).toBeVisible()
      await expect(
        page.getByRole('menuitem', { name: 'Copy branch name', exact: true }),
      ).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Context 1', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Project folder: plain-folder', exact: true }),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: /^Git branch:/u })).toHaveCount(0)
      for (const row of rows) {
        expect(observer.conversationRepository.read(row.id).messages).toHaveLength(0)
        expect(observer.conversationRepository.read(row.id).runs).toHaveLength(0)
      }
      await app.evaluate(async ({ clipboard }, owned) => {
        if (owned.includes(await clipboard.readText())) clipboard.clear()
      }, writtenClipboard)
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) {
        await app.evaluate(async ({ clipboard }, owned) => {
          if (owned.includes(await clipboard.readText())) clipboard.clear()
        }, writtenClipboard)
        await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      }
      if (database.isHealthy()) database.close()
      observer?.close()
      await fixture.dispose()
    }
  },
)
