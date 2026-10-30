import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import {
  rpcResultSchema,
  sessionCatalogPageSchema,
  sessionSettingsSaveResultSchema,
  type SessionCatalogCursor,
  type SessionCatalogPage,
} from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import {
  agentRuns,
  conversationMessages,
  projects,
  sessionSettingsRevisions,
  sessions,
} from '../../packages/persistence/src/schema/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const sessionCount = 1_000
const historyPerSession = 10
const createdAt = Date.parse('2026-09-24T00:00:00.000Z')

test(
  'loads five Sessions at a time and preserves activity and unread state after restart',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(180_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    let app: Awaited<ReturnType<RuntimeFixture['launch']>> | undefined

    try {
      const { projectId, unreadSessionId } = await seedCatalog(fixture)
      app = await fixture.launch()
      let window = await app.firstWindow()
      await expect(
        window.getByRole('button', { name: 'Rename Project Catalog scale', exact: true }),
      ).toBeVisible()
      await expect(
        window.getByRole('button', { name: 'Rename Project Catalog scale', exact: true }),
      ).toHaveText('Catalog scale')
      await expect(window.getByRole('button', { name: 'Session 990', exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Session 980', exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Session 940', exact: true })).toHaveCount(0)
      await expect(window.getByRole('button', { name: /^Session \d+$/ })).toHaveCount(5)
      await expect(
        window
          .getByRole('button', { name: 'Session 990', exact: true })
          .locator('..')
          .getByLabel('New reply'),
      ).toBeVisible()
      await expect(
        window
          .getByRole('button', { name: 'Session 980', exact: true })
          .locator('..')
          .getByLabel('Codex encountered an error'),
      ).toBeVisible()

      const firstPage = await readCatalogPage(window, projectId)
      expect(firstPage.sessions).toHaveLength(5)
      expect(firstPage.sessions[0]).toMatchObject({ id: unreadSessionId, hasUnread: true })
      expect(firstPage.sessions.every((session) => session.status !== 'archived')).toBe(true)
      expect(firstPage.nextCursor).toBeDefined()
      const secondPage = await readCatalogPage(window, projectId, firstPage.nextCursor)
      expect(secondPage.sessions).toHaveLength(5)
      expect(secondPage.sessions[0]?.title).toBe('Session 940')
      expect(secondPage.revision).toBe(firstPage.revision)
      expect(firstPage.sessions[1]).toMatchObject({
        title: 'Session 980',
        activity: { state: 'error', agentId: 'codex' },
      })

      // A change outside the loaded window invalidates the cursor. Load more
      // must rebase without dropping the five Sessions already visible.
      const unseenSessionId = secondPage.sessions[0]?.id
      if (!unseenSessionId) throw new Error('Expected an unseen Session.')
      const changed = await window.evaluate(
        async ({ sessionId, throughSequence }) => {
          const pact: unknown = Reflect.get(globalThis, 'pact')
          if (
            !pact ||
            typeof pact !== 'object' ||
            !('markSessionRead' in pact) ||
            typeof pact.markSessionRead !== 'function'
          ) {
            throw new Error('Pact bridge is unavailable.')
          }
          return pact.markSessionRead({ sessionId, throughSequence })
        },
        { sessionId: unseenSessionId, throughSequence: historyPerSession },
      )
      expect(changed).toMatchObject({ ok: true })

      const loadMore = window.getByRole('button', { name: 'Load more Sessions in Catalog scale' })
      await loadMore.click()
      await expect(window.getByRole('button', { name: 'Session 940', exact: true })).toBeVisible()
      await loadMore.click()
      await expect(window.getByRole('button', { name: 'Session 890', exact: true })).toBeVisible()
      const navigation = window.getByRole('navigation', { name: 'Projects and Sessions' })
      for (let index = 0; index < 17; index += 1) {
        // Once the list exceeds the viewport, the Load more row is intentionally virtualized.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await navigation.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        // oxlint-disable-next-line eslint/no-await-in-loop
        await loadMore.click()
      }
      await expect(loadMore).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Session 0', exact: true })).toBeVisible()
      const mounted = await navigation.evaluate((element) => ({
        rows: element.querySelectorAll('li[data-session-menu]').length,
        height: element.clientHeight,
      }))
      expect(mounted.rows).toBeLessThanOrEqual(Math.ceil(mounted.height / 32) + 12)

      const unreadSettings = firstPage.sessions[0]?.settings
      if (!unreadSettings) throw new Error('Expected Session settings in the first page.')
      const savedRaw = await window.evaluate(
        async ({ sessionId, settings }) => {
          const pact: unknown = Reflect.get(globalThis, 'pact')
          if (
            !pact ||
            typeof pact !== 'object' ||
            !('saveSessionSettings' in pact) ||
            typeof pact.saveSessionSettings !== 'function'
          ) {
            throw new Error('Pact bridge is unavailable.')
          }
          return pact.saveSessionSettings({
            sessionId,
            settings: {
              primaryAgentId: settings.primaryAgentId,
              agents: settings.agents,
              maxDiscussionRounds: 5,
              maxReviewCycles: settings.maxReviewCycles,
              maxRepairAttempts: settings.maxRepairAttempts,
            },
          })
        },
        { sessionId: unreadSessionId, settings: unreadSettings },
      )
      const saved = rpcResultSchema(sessionSettingsSaveResultSchema).parse(savedRaw)
      if (!saved.ok) throw new Error(fixture.redactDiagnostic(JSON.stringify(saved.error)))
      expect(saved).toMatchObject({
        ok: true,
        value: {
          catalogChange: { session: { id: unreadSessionId, settingsRevision: 2 } },
        },
      })

      const marked = await window.evaluate(
        async ({ sessionId, throughSequence }) => {
          const pact: unknown = Reflect.get(globalThis, 'pact')
          if (
            !pact ||
            typeof pact !== 'object' ||
            !('markSessionRead' in pact) ||
            typeof pact.markSessionRead !== 'function'
          ) {
            throw new Error('Pact bridge is unavailable.')
          }
          return pact.markSessionRead({ sessionId, throughSequence })
        },
        { sessionId: unreadSessionId, throughSequence: historyPerSession },
      )
      expect(marked).toMatchObject({ ok: true })

      await quitPact(app)
      app = await fixture.launch()
      window = await app.firstWindow()
      await expect(window.getByRole('button', { name: 'Session 990', exact: true })).toBeVisible()
      await expect(
        window
          .getByRole('button', { name: 'Session 990', exact: true })
          .locator('..')
          .getByLabel('New reply'),
      ).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Session 940', exact: true })).toHaveCount(0)
      const restored = await readCatalogPage(window, projectId)
      expect(restored.sessions).toHaveLength(5)
      expect(restored.sessions[0]).toMatchObject({ id: unreadSessionId, hasUnread: false })
      expect(restored.sessions[0]?.settings.maxDiscussionRounds).toBe(5)
      expect(restored.sessions[1]).toMatchObject({
        activity: { state: 'error', agentId: 'codex' },
      })
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'bounds Project DOM and preserves keyboard focus after scrolling a large Catalog',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(180_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    let app: Awaited<ReturnType<RuntimeFixture['launch']>> | undefined
    try {
      const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        database.drizzle.transaction((transaction) => {
          for (let index = 0; index < 1_000; index += 1) {
            transaction
              .insert(projects)
              .values({
                id: randomUUID(),
                name: `Project ${String(index).padStart(3, '0')}`,
                directoryPath: resolve(dirname(fixture.databaseFile), `project-${index}`),
                kind: 'git',
                createdAt: new Date(createdAt + index).toISOString(),
              })
              .run()
          }
        })
      } finally {
        database.close()
      }
      app = await fixture.launch()
      const window = await app.firstWindow()
      const navigation = window.getByRole('navigation', { name: 'Projects and Sessions' })
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 000', exact: true }),
      ).toBeVisible()
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 000', exact: true }),
      ).toHaveText('Project 000')
      await expect(window.getByText('Loading Sessions…', { exact: true })).toHaveCount(0)
      const mountedAtTop = await navigation.evaluate((element) => ({
        rows: element.querySelectorAll('li[data-project-menu]').length,
        height: element.clientHeight,
      }))
      expect(mountedAtTop.rows).toBeLessThanOrEqual(Math.ceil(mountedAtTop.height / 36) + 12)
      await window.getByRole('button', { name: 'Rename Project Project 000', exact: true }).focus()
      await navigation.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toBeVisible()
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toHaveText('Project 999')
      const focused = await navigation.evaluate((element) =>
        element.contains(document.activeElement),
      )
      expect(focused).toBe(true)
      await window.keyboard.press('Tab')
      const afterTab = await navigation.evaluate((element) =>
        element.contains(document.activeElement),
      )
      expect(afterTab).toBe(true)
      const mountedAtEnd = await navigation.evaluate(
        (element) => element.querySelectorAll('li[data-project-menu]').length,
      )
      expect(mountedAtEnd).toBeLessThanOrEqual(Math.ceil(mountedAtTop.height / 36) + 12)
      await navigation.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toBeVisible()
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toHaveText('Project 999')
      const archiveProject = window.getByRole('button', { name: 'Archive Project Project 999' })
      await archiveProject.focus()
      await expect(archiveProject).toBeInViewport()
      await expect(window.getByRole('menu')).toHaveCount(0)
      await window.keyboard.press('Enter')
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toHaveCount(0)
      await expect(navigation.getByText('Project 999', { exact: true })).toHaveCount(0)
      const archiveNotice = window.getByRole('region', { name: 'Archive results', exact: true })
      await archiveNotice.getByRole('button', { name: 'View', exact: true }).click()
      await archiveNotice
        .getByRole('button', { name: 'Undo archive of Project 999', exact: true })
        .click()
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toBeVisible()
      await expect(
        window.getByRole('button', { name: 'Rename Project Project 999', exact: true }),
      ).toHaveText('Project 999')
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)

async function readCatalogPage(
  page: Page,
  projectId: string,
  cursor?: SessionCatalogCursor,
): Promise<SessionCatalogPage> {
  const raw: unknown = await page.evaluate(
    async (input) => {
      const pact: unknown = Reflect.get(globalThis, 'pact')
      if (
        !pact ||
        typeof pact !== 'object' ||
        !('getSessionCatalog' in pact) ||
        typeof pact.getSessionCatalog !== 'function'
      ) {
        throw new Error('Pact bridge is unavailable.')
      }
      return pact.getSessionCatalog(input.projectId, input.cursor)
    },
    { projectId, cursor },
  )
  const result = rpcResultSchema(sessionCatalogPageSchema).parse(raw)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function seedCatalog(
  fixture: RuntimeFixture,
): Promise<{ projectId: string; unreadSessionId: string }> {
  const directoryPath = await fixture.createProjectDirectory('Catalog scale')
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  try {
    const projectId = randomUUID()
    database.projectCatalogRepository.add({
      id: projectId,
      name: 'Catalog scale',
      directoryPath,
      kind: 'git',
      createdAt: new Date(createdAt).toISOString(),
    })
    let unreadSessionId = ''
    database.drizzle.transaction((transaction) => {
      for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = randomUUID()
        if (index === 990) unreadSessionId = sessionId
        const archived = index % 10 !== 0
        const timestamp = new Date(createdAt + index).toISOString()
        transaction
          .insert(sessions)
          .values({
            id: sessionId,
            projectId,
            title: `Session ${index}`,
            status: archived ? 'archived' : index === 980 ? 'discussing' : 'idle',
            settingsRevision: 1,
            lastSeenMessageSequence: -1,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(archived ? { archivedAt: timestamp } : {}),
          })
          .run()
        transaction
          .insert(sessionSettingsRevisions)
          .values({
            sessionId,
            revision: 1,
            primaryAgentId: 'codex',
            claudeModel: null,
            claudeEffort: null,
            codexModel: null,
            codexEffort: null,
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
            createdAt: timestamp,
          })
          .run()
        for (let sequence = 1; sequence <= historyPerSession; sequence += 1) {
          const eventTime = new Date(createdAt + sequence).toISOString()
          transaction
            .insert(agentRuns)
            .values({
              id: randomUUID(),
              sessionId,
              userMessageId: randomUUID(),
              agentId: 'codex',
              status: index === 980 && sequence === historyPerSession ? 'failed' : 'completed',
              attemptCount: 1,
              settingsRevision: 1,
              createdAt: eventTime,
              updatedAt: eventTime,
            })
            .run()
          transaction
            .insert(conversationMessages)
            .values({
              id: randomUUID(),
              sessionId,
              role: 'assistant',
              agentId: 'codex',
              content: `Answer ${sequence}`,
              state: 'complete',
              sequence,
              createdAt: eventTime,
              updatedAt: eventTime,
            })
            .run()
        }
      }
    })
    return { projectId, unreadSessionId }
  } finally {
    database.close()
  }
}
