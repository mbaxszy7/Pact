import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import type { ConversationSnapshot, DesktopBridge } from '../../packages/contracts/src/index.js'

import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  createRuntimeFixture,
  test,
  type RuntimeFixture,
  type RuntimeFixtureOptions,
} from './runtime-fixture.js'

const maxRuns = 128
const maxBodyBytes = 8 * 1024 * 1024

export interface RealWorkspace {
  fixture: RuntimeFixture
  app: ElectronApplication
  page: Page
  projectId: string
  projectDirectory: string
  sessionId: string
}

/** Observe the same readiness state that actually gates the Composer; allow one explicit UI Retry. */
export async function waitForWindowsRuntimeReady(
  page: Page,
  fixture: RuntimeFixture,
): Promise<void> {
  const deadline = Date.now() + 30_000
  const remaining = (): number => Math.max(1, deadline - Date.now())
  const enabled = page.locator('[data-agent-actions="enabled"]')
  const notice = page.getByRole('alert').filter({ hasText: 'Agent actions paused.' })
  await enabled.or(notice).first().waitFor({ state: 'visible', timeout: remaining() })
  if (!(await enabled.count())) {
    const original = fixture.redactDiagnostic(await notice.innerText())
    const path = test.info().outputPath('windows-initial-readiness.json')
    await writeFile(path, JSON.stringify({ initialNotice: original }))
    await test.info().attach('windows-initial-readiness', { path, contentType: 'application/json' })
    const retry = notice.getByRole('button', { name: 'Retry', exact: true })
    await retry.click({ timeout: remaining() })
    try {
      await enabled.waitFor({ state: 'visible', timeout: remaining() })
    } catch {
      // The Retry button stays enabled while checking, so it cannot signal completion.
      throw new Error(`Runtime preparation remained unavailable after one UI Retry: ${original}`)
    }
  }
  await expect(notice).toHaveCount(0, { timeout: remaining() })
}

export async function launchRealWorkspace(
  name: string,
  options: Pick<RuntimeFixtureOptions, 'transportFault'> = {},
): Promise<RealWorkspace> {
  const fixture = await createRuntimeFixture({ mode: 'real', ...options })
  try {
    const projectDirectory = await fixture.createProjectDirectory(name)
    const app = await fixture.launch()
    const page = await app.firstWindow()
    if (process.platform === 'win32') await waitForWindowsRuntimeReady(page, fixture)
    else
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              const state = await bridge.getRuntimePreparation()
              return state.ok ? state.value.agents.map((agent) => agent.state) : []
            }),
          { timeout: 30_000 },
        )
        .toEqual(['ready', 'ready'])
    await app.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, 'showOpenDialog', async () => ({ canceled: false, filePaths: [path] }))
    }, projectDirectory)
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `Rename Project ${name}`, exact: true }),
    ).toBeVisible()
    const projectId = await page.evaluate(async (selectedPath) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const catalog = await bridge.getProjectCatalog()
      if (!catalog.ok) throw new Error('Project catalog unavailable')
      const project = catalog.value.projects.find((row) => row.directoryPath === selectedPath)
      if (!project) throw new Error('Owned Project was not created')
      return project.id
    }, projectDirectory)
    await page.getByRole('button', { name: `New Session in ${name}` }).focus()
    await page.getByRole('button', { name: `New Session in ${name}` }).click()
    await page
      .getByRole('button', { name: 'Create Session' })
      .click()
      .catch(async (error: unknown) => {
        const dialog = await page
          .locator('body')
          .innerText({ timeout: 1_000 })
          .catch(() => 'Startup page unavailable')
        throw new Error(
          fixture.redactDiagnostic(
            JSON.stringify({
              failure: error instanceof Error ? error.message : 'Session creation failed',
              startup: dialog.slice(0, 6_000),
            }),
          ),
        )
      })
    await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate(async (id) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            const catalog = await bridge.getSessionCatalog(id)
            return catalog.ok ? catalog.value.sessions.length : 0
          }, projectId),
        { timeout: 15_000 },
      )
      .toBe(1)
    const sessionId = await page.evaluate(async (id) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const catalog = await bridge.getSessionCatalog(id)
      if (!catalog.ok || catalog.value.sessions.length !== 1)
        throw new Error('Owned Session was not created exactly once')
      return catalog.value.sessions[0]!.id
    }, projectId)
    await expect(page.getByRole('combobox', { name: 'Message' })).toBeEnabled({ timeout: 15_000 })
    return { fixture, app, page, projectId, projectDirectory, sessionId }
  } catch (error) {
    try {
      await fixture.dispose()
    } catch (cleanup) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- Preserve both sanitized messages without an unsafe raw cause.
      throw new Error(
        fixture.redactDiagnostic(
          `${error instanceof Error ? error.message : 'Real workspace launch failed'}; cleanup: ${cleanup instanceof Error ? cleanup.message : 'Unconfirmed fixture cleanup'}`,
        ),
      )
    }
    throw error
  }
}

export async function addRealSession(context: RealWorkspace, title: string): Promise<string> {
  // Use the product action so its Catalog cache and selected row update together.
  const previous = context.page.locator('[data-session-menu]:has(button[data-selected="true"])')
  const previousId =
    (await previous.count()) === 1
      ? await previous.getAttribute('data-session-menu')
      : context.sessionId
  const navigation = context.page.getByRole('navigation', { name: 'Projects and Sessions' })
  await navigation.evaluate((element) => {
    element.scrollTop = 0
  })
  const project = context.page.locator(`[data-project-menu="${context.projectId}"]`)
  const create = project.getByRole('button', { name: /^New Session in /u })
  await create.focus()
  await create.click()
  await context.page.getByRole('button', { name: 'Create Session', exact: true }).click()
  await expect(
    context.page.getByRole('button', { name: 'Create Session', exact: true }),
  ).toHaveCount(0)
  const selected = navigation.locator('[data-session-menu]:has(button[data-selected="true"])')
  await expect(selected).toHaveCount(1)
  const id = await selected.getAttribute('data-session-menu')
  if (!id) throw new Error('New Session selected identity unavailable')
  await context.page.getByRole('heading', { name: 'New session', exact: true }).hover()
  await context.page.getByRole('button', { name: 'Rename Session', exact: true }).click()
  await context.page.getByRole('textbox', { name: 'Session title' }).fill(title)
  await context.page.getByRole('button', { name: 'Save Session title', exact: true }).click()
  await expect(context.page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  if (previousId) await selectRealSession(context, previousId)
  return id
}

export async function selectRealSession(context: RealWorkspace, id: string): Promise<void> {
  const navigation = context.page.getByRole('navigation', { name: 'Projects and Sessions' })
  await expect(navigation).toBeVisible()
  await navigation.evaluate((element) => {
    element.scrollTop = 0
  })
  const projectButton = context.page
    .locator(`[data-project-menu="${context.projectId}"] button[data-nav-primary]`)
    .first()
  await expect(projectButton).toBeVisible()
  if ((await projectButton.getAttribute('aria-expanded')) === 'false') await projectButton.click()
  const selected = context.page.locator(`[data-session-menu="${id}"] button[data-nav-primary]`)
  const deadline = Date.now() + 30_000
  let moves = 0
  // oxlint-disable-next-line no-await-in-loop -- The next virtual range depends on the current row's visibility.
  while (!(await selected.isVisible())) {
    if (++moves > 128 || Date.now() > deadline)
      throw new Error('Owned Session is unavailable in the paginated Catalog')
    const more = context.page
      .locator(`[data-project-menu="${context.projectId}"]`)
      .getByRole('button', { name: /^Load more Sessions in /u })
    // oxlint-disable-next-line no-await-in-loop -- Each real UI page must settle before the next Catalog action.
    if (await more.isVisible()) await more.click()
    else {
      // oxlint-disable-next-line no-await-in-loop -- Scroll through the bounded virtual Catalog rather than bypassing its UI.
      await navigation.evaluate((element) => {
        element.scrollTop += Math.max(100, element.clientHeight - 40)
      })
    }
    // oxlint-disable-next-line no-await-in-loop -- Wait for the current virtual range to render before inspecting the next.
    await context.page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    )
  }
  await selected.click()
  await expect(context.page.getByRole('combobox', { name: 'Message' })).toBeVisible()
}

export async function sendRealMessage(
  context: RealWorkspace,
  content: string,
  route: 'primary' | 'all' | 'claude' | 'codex' = 'primary',
): Promise<void> {
  if (content.length > 100_000) throw new Error('Real message exceeds the product input bound')
  const composer = context.page.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeEnabled({ timeout: 20_000 })
  if (route === 'primary') await composer.fill(content)
  else {
    await composer.fill('@' + route)
    await context.page
      .getByRole('option', {
        name: route === 'all' ? /^All/u : route === 'claude' ? /^Claude Code/u : /^Codex/u,
      })
      .click()
    await expect.poll(() => composer.textContent()).toBe('@' + route + ' ')
    await context.page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    )
    await composer.press('End')
    if (process.platform === 'win32' && /[\r\n]/u.test(content))
      await context.page.keyboard.insertText(content)
    else await composer.pressSequentially(content)
  }
  await composer.press('Enter')
}

/** Choose through the UI so Send observes the same committed Session revision. */
export async function selectRealAskPermission(
  context: RealWorkspace,
  agentId: 'claude' | 'codex',
): Promise<void> {
  const label = agentId === 'claude' ? 'Claude' : 'Codex'
  const selected = context.page.getByRole('button', {
    name: `${label} · Ask for approval`,
    exact: true,
  })
  if (!(await selected.isVisible())) {
    await context.page.getByRole('button', { name: new RegExp(`^${label} · `, 'u') }).click()
    const menu = context.page.locator(`#permissions-${context.sessionId}-${agentId}`)
    await menu.getByRole('button', { name: /^Ask for approval/u }).click()
    await expect(menu).toBeHidden()
  }
  await expect(selected).toBeVisible()
}

export async function selectRealConfiguredEffort(
  ctx: RealWorkspace,
  agentIds: readonly ('claude' | 'codex')[] = ['claude', 'codex'],
): Promise<void> {
  if (agentIds.length < 1 || agentIds.length > 2 || new Set(agentIds).size !== agentIds.length)
    throw new Error('Real effort selection requires one or two unique Agents')
  // Select only an effort advertised by the selected real CLI for the user's configured
  // model. This bounds review latency without changing any source config file.
  const saved = await ctx.page.evaluate(
    async ({ sessionId, models, agentIds: selectedAgents }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const state = await bridge.getSessionSettings(sessionId)
      if (!state.ok) throw new Error('Actual Session settings are unavailable')
      const agents = { ...state.value.session.settings.agents }
      for (const agent of selectedAgents) {
        const catalog = state.value.modelCatalogs[agent]
        const model = catalog.models.find((item) => item.id === models[agent])
        if (catalog.status !== 'available' || !model)
          throw new Error('Configured real model is absent from the actual CLI catalog')
        agents[agent] = {
          model: model.id,
          effort: model.supportedEfforts.includes('low')
            ? 'low'
            : (model.supportedEfforts[0] ?? null),
        }
      }
      const previous = state.value.session.settings
      return bridge.saveSessionSettings({
        sessionId,
        settings: {
          primaryAgentId: previous.primaryAgentId,
          agents,
          maxDiscussionRounds: previous.maxDiscussionRounds,
          runningMessagePolicy: previous.runningMessagePolicy,
          maxReviewCycles: previous.maxReviewCycles,
          maxRepairAttempts: previous.maxRepairAttempts,
        },
      })
    },
    { sessionId: ctx.sessionId, models: ctx.fixture.readConfigurationModels(), agentIds },
  )
  expect(saved.ok).toBe(true)
}

export async function readRealConversation(
  context: RealWorkspace,
  sessionId = context.sessionId,
): Promise<ConversationSnapshot> {
  const database = ReadonlyFixtureDatabase.open(context.fixture)
  try {
    const snapshot = database.conversationRepository.read(sessionId)
    if (
      snapshot.runs.length > maxRuns ||
      Buffer.byteLength(JSON.stringify(snapshot)) > maxBodyBytes
    )
      throw new Error('Real observation exceeds its count/byte bound')
    return snapshot
  } finally {
    database.close()
  }
}

/** Cold test observer reads indexed scalar Run state; never polls complete transcript bodies. */
export async function waitForRealCompletion(
  context: RealWorkspace,
  count: number,
  sessionId = context.sessionId,
  previousFailures: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ConversationSnapshot> {
  if (count > maxRuns) throw new Error('Real case exceeds its model-Run bound')
  let failedNative: { sessionId: string; turnId: string | null } | undefined
  const database = ReadonlyFixtureDatabase.open(context.fixture)
  try {
    await expect
      .poll(
        () => {
          if (signal?.aborted)
            throw new Error('Real completion observer was cancelled by its owner')
          const rows = database.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, sessionId),
              columns: {
                id: true,
                agentId: true,
                status: true,
                failureKind: true,
                failureMessage: true,
                nativeSessionId: true,
                nativeTurnId: true,
              },
              limit: maxRuns + 1,
            })
            .sync()
          if (rows.length > maxRuns) throw new Error('Real case exceeded its Run capacity')
          const failure = rows.find(
            (row) =>
              !previousFailures.includes(row.id) && ['failed', 'interrupted'].includes(row.status),
          )
          if (failure) {
            if (failure.agentId === 'codex' && failure.nativeSessionId)
              failedNative = {
                sessionId: failure.nativeSessionId,
                turnId: failure.nativeTurnId,
              }
            throw new Error(
              `Real CLI Run is ${failure.status}; code=${failure.failureKind ?? 'none'}; detail=${context.fixture.redactDiagnostic(failure.failureMessage ?? 'unavailable').slice(0, 2000)}`,
            )
          }
          return (
            rows.length === count &&
            rows.every(
              (row) =>
                row.status === 'completed' ||
                (previousFailures.includes(row.id) &&
                  ['failed', 'interrupted'].includes(row.status)),
            )
          )
        },
        { timeout: 300_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
  } catch (error) {
    if (!failedNative) throw error
    // Query only the failed fixture's last terminal metadata before teardown removes it.
    // This creates no model input and cannot change the original completion observation.
    let detail = 'Native terminal metadata unavailable'
    const native = await context.fixture.openCodexClient().catch(() => undefined)
    if (native) {
      try {
        const reply = await native.request<{
          data: Array<{ id: string; status: string; error?: { message?: string } | null }>
        }>('thread/turns/list', {
          threadId: failedNative.sessionId,
          itemsView: 'notLoaded',
          limit: 1,
          sortDirection: 'desc',
        })
        const turn = reply.result?.data?.[0]
        if (turn && (!failedNative.turnId || turn.id === failedNative.turnId))
          detail = context.fixture
            .redactDiagnostic(JSON.stringify({ status: turn.status, error: turn.error?.message }))
            .slice(0, 2000)
      } catch {
        // A diagnostic failure must retain the original failed assertion.
      } finally {
        await native.close().catch(() => undefined)
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : 'Real completion failed'}; ${detail}`,
      { cause: error },
    )
  } finally {
    database.close()
  }
  return readRealConversation(context, sessionId)
}

export async function restartRealWorkspace(context: RealWorkspace): Promise<void> {
  await context.app.close()
  context.app = await context.fixture.launch()
  context.page = await context.app.firstWindow()
  await selectRealSession(context, context.sessionId)
}

export async function closeRealWorkspace(context: RealWorkspace): Promise<void> {
  await context.fixture.dispose()
}

export function authMarker(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}
