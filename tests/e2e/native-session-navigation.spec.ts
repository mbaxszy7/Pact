import { expect, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

async function seed(fixture: RuntimeFixture) {
  const database = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  const rows: Array<{ id: string; title: string; projectId: string; projectName: string }> = []
  const createdAt = new Date().toISOString()
  for (const projectName of ['Alpha & Tools', 'Beta Project']) {
    const projectId = randomUUID()
    // oxlint-disable-next-line no-await-in-loop -- Each owned Project precedes its Session fixtures.
    const directoryPath = await fixture.createProjectDirectory(projectName)
    database.projectCatalogRepository.add({
      id: projectId,
      name: projectName,
      directoryPath,
      kind: 'directory',
      createdAt,
    })
    for (let index = 0; index < 4; index += 1) {
      const id = randomUUID(),
        title = `Session ${rows.length + 1}`
      database.sessionRepository.create(
        { id, projectId, title, createdAt },
        {
          primaryAgentId: 'codex',
          agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          runningMessagePolicy: 'next_round',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      rows.push({ id, title, projectId, projectName })
    }
  }
  database.close()
  return { database: ReadonlyFixtureDatabase.open(fixture), rows }
}

async function recentLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ app: nativeApp }) => {
    const items = nativeApp.dock?.getMenu()?.items ?? []
    const heading = items.findIndex((item) => item.label === 'Recent sessions')
    return heading < 0
      ? []
      : items
          .slice(heading + 1)
          .filter(
            (item) =>
              item.type !== 'separator' &&
              item.enabled &&
              !item.label.startsWith('Show ') &&
              item.label !== 'Exit',
          )
          .map((item) => item.label)
  })
}

test(
  'macOS Dock keeps five cross-Project recent Sessions across cold restart and clicks only navigate',
  { tag: '@ui' },
  async () => {
    test.skip(process.platform !== 'darwin', 'Uses the actual macOS Dock menu')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const f = await seed(fixture)
    let app: ElectronApplication | undefined
    try {
      app = await fixture.launch()
      let page = await app.firstWindow()
      for (const row of f.rows) {
        // oxlint-disable-next-line no-await-in-loop -- Real user visits establish the durable MRU order.
        await page.getByRole('button', { name: row.title, exact: true }).click()
        // oxlint-disable-next-line no-await-in-loop
        await expect(page.getByRole('heading', { name: row.title, exact: true })).toBeVisible()
      }
      const expected = f.rows
        .slice(-5)
        .toReversed()
        .map((row) => `${row.title} — ${row.projectName}`)
      await expect.poll(() => recentLabels(app!)).toEqual(expected)
      await quitPact(app, page)
      app = undefined
      app = await fixture.launch()
      page = await app.firstWindow()
      await expect.poll(() => recentLabels(app!)).toEqual(expected)
      const target = f.rows[3]!
      await app.evaluate(({ app: nativeApp }, label) => {
        const item = nativeApp.dock?.getMenu()?.items.find((row) => row.label === label)
        if (!item) throw new Error('Recent Dock Session action missing')
        Reflect.apply(item.click, item, [])
      }, `${target.title} — ${target.projectName}`)
      await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible()
      await expect
        .poll(() => recentLabels(app!))
        .toEqual([`${target.title} — ${target.projectName}`, ...expected.slice(0, 4)])
      for (const row of f.rows) {
        expect(f.database.conversationRepository.read(row.id).runs).toHaveLength(0)
        expect(f.database.conversationRepository.read(row.id).messages).toHaveLength(0)
      }
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
  'macOS native navigation cannot overwrite a newer sidebar choice after a delayed Utility response',
  { tag: '@ui' },
  async () => {
    test.skip(process.platform !== 'darwin', 'Pauses only the owned macOS Utility process')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const f = await seed(fixture)
    let app: ElectronApplication | undefined
    try {
      app = await fixture.launch()
      const page = await app.firstWindow()
      for (const row of f.rows) {
        // oxlint-disable-next-line no-await-in-loop -- Both Project pages and real visit receipts precede the delayed native choice.
        await page.getByRole('button', { name: row.title, exact: true }).click()
        // oxlint-disable-next-line no-await-in-loop
        await expect(page.getByRole('heading', { name: row.title, exact: true })).toBeVisible()
      }
      const stale = f.rows[3]!,
        latest = f.rows[5]!
      await expect.poll(() => recentLabels(app!)).toContain(`${stale.title} — ${stale.projectName}`)
      const utilityPid = await app.evaluate(
        ({ app: nativeApp }, expectedProfile) => {
          if (nativeApp.getPath('userData') !== expectedProfile)
            throw new Error('Unexpected fixture profile')
          const utility = nativeApp
            .getAppMetrics()
            .find((item) => item.name === 'Pact Utility Process')
          if (!utility) throw new Error('Owned Utility missing')
          return utility.pid
        },
        await realpath(join(fixture.directory, 'electron-profile')),
      )
      try {
        await app.evaluate(({ app: nativeApp }, pid) => {
          if (
            !nativeApp
              .getAppMetrics()
              .some((item) => item.pid === pid && item.name === 'Pact Utility Process')
          )
            throw new Error('Owned Utility changed before pause')
          process.kill(pid, 'SIGSTOP')
        }, utilityPid)
        await app.evaluate(({ app: nativeApp }, label) => {
          const item = nativeApp.dock?.getMenu()?.items.find((row) => row.label === label)
          if (!item) throw new Error('Delayed Dock Session action missing')
          Reflect.apply(item.click, item, [])
        }, `${stale.title} — ${stale.projectName}`)
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        )
        await page.getByRole('button', { name: latest.title, exact: true }).click({ timeout: 1000 })
        await expect(page.getByRole('heading', { name: latest.title, exact: true })).toBeVisible({
          timeout: 1000,
        })
      } finally {
        await app.evaluate(({ app: nativeApp }, pid) => {
          if (
            nativeApp
              .getAppMetrics()
              .some((item) => item.pid === pid && item.name === 'Pact Utility Process')
          )
            process.kill(pid, 'SIGCONT')
        }, utilityPid)
      }
      await page.evaluate(async (projectId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getSessionCatalog(projectId)
        if (!result.ok) throw new Error('Resumed catalog read failed')
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        )
      }, latest.projectId)
      await expect(page.getByRole('heading', { name: latest.title, exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: stale.title, exact: true })).toHaveCount(0)
      await expect
        .poll(() => recentLabels(app!))
        .toEqual(
          [
            latest,
            ...f.rows
              .slice(-5)
              .toReversed()
              .filter((row) => row.id !== latest.id),
          ].map((row) => `${row.title} — ${row.projectName}`),
        )
      expect(f.database.conversationRepository.read(stale.id).runs).toHaveLength(0)
      expect(f.database.conversationRepository.read(latest.id).messages).toHaveLength(0)
      await quitPact(app, page)
      app = undefined
    } finally {
      if (app) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      f.database.close()
      await fixture.dispose()
    }
  },
)
