import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

async function writeNotificationCodexCli(directory: string) {
  const cliPath = join(directory, 'codex-notify-cli.mjs')
  const factsPath = join(directory, 'codex-notify-facts.json')
  const triggerCompletePath = join(directory, 'trigger-complete')
  const triggerFailPath = join(directory, 'trigger-fail')
  const triggerQuestionPath = join(directory, 'trigger-question')

  await writeFile(factsPath, JSON.stringify({ starts: 0, interrupts: 0 }))
  await writeFile(
    cliPath,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.159.2')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  process.exit(0)
}
if (args[0] === 'features' && args[1] === 'list') {
  console.log('shell_tool stable true')
  process.exit(0)
}
if (args[0] !== 'app-server') {
  process.exit(2)
}

const factsPath = ${JSON.stringify(factsPath)}
const triggerCompletePath = ${JSON.stringify(triggerCompletePath)}
const triggerFailPath = ${JSON.stringify(triggerFailPath)}
const triggerQuestionPath = ${JSON.stringify(triggerQuestionPath)}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const threads = new Map()
const activeStops = new Map()
let threadSeq = 0
let turnSeq = 0

const updateFacts = (fn) => {
  const data = JSON.parse(readFileSync(factsPath, 'utf8'))
  fn(data)
  writeFileSync(factsPath, JSON.stringify(data))
}

const ensureThread = (id) => {
  if (!threads.has(id)) {
    threads.set(id, { id, status: 'idle', turns: [], items: [] })
  }
  return threads.get(id)
}

const waitForFile = (filePath, onReady) => {
  const timer = setInterval(() => {
    if (existsSync(filePath)) {
      clearInterval(timer)
      onReady()
    }
  }, 30)
  return timer
}

const rl = createInterface({ input: process.stdin })
let pendingQuestionFinish
for await (const line of rl) {
  const req = JSON.parse(line)
  if (req.id === 'notify-question' && !req.method) {
    pendingQuestionFinish?.()
    pendingQuestionFinish = undefined
    continue
  }
  if (req.method === 'initialize') {
    send({ id: req.id, result: {} })
  } else if (req.method === 'account/read') {
    send({ id: req.id, result: { account: null, requiresOpenaiAuth: true } })
  } else if (req.method === 'account/rateLimits/read') {
    send({ id: req.id, result: { rateLimits: null } })
  } else if (req.method === 'model/list') {
    send({ id: req.id, result: { data: [] } })
  } else if (req.method === 'skills/list') {
    send({ id: req.id, result: { data: [{ cwd: process.cwd(), skills: [], errors: [] }] } })
  } else if (req.method === 'config/read') {
    send({
      id: req.id,
      result: {
        config: {
          model: 'gpt-fixture',
          model_reasoning_effort: 'medium',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          sandbox_mode: 'danger-full-access',
        },
      },
    })
  } else if (req.method === 'thread/start' || req.method === 'thread/resume') {
    const id =
      req.method === 'thread/resume'
        ? req.params.threadId
        : 'notify-thread-' + (++threadSeq)
    const thread = ensureThread(id)
    send({
      id: req.id,
      result: {
        thread: { id, name: null, path: '', status: { type: thread.status }, model: 'gpt-fixture', reasoningEffort: 'medium' },
        model: 'gpt-fixture',
        reasoningEffort: 'medium',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' },
      },
    })
  } else if (req.method === 'thread/read') {
    const thread = ensureThread(req.params.threadId)
    send({
      id: req.id,
      result: {
        thread: { id: thread.id, name: null, path: '', status: { type: thread.status }, model: 'gpt-fixture', reasoningEffort: 'medium' },
      },
    })
  } else if (req.method === 'thread/turns/list') {
    const thread = ensureThread(req.params.threadId)
    send({ id: req.id, result: { data: thread.turns, nextCursor: null } })
  } else if (req.method === 'thread/items/list') {
    const thread = ensureThread(req.params.threadId)
    send({ id: req.id, result: { data: thread.items, nextCursor: null } })
  } else if (req.method === 'turn/interrupt') {
    updateFacts((facts) => {
      facts.interrupts += 1
    })
    const active = activeStops.get(req.params.turnId)
    if (active) {
      clearInterval(active.timer)
      activeStops.delete(req.params.turnId)
    }
    const thread = ensureThread(req.params.threadId)
    thread.status = 'idle'
    thread.turns.push({ id: req.params.turnId, status: 'interrupted', startedAt: 1, completedAt: 2, durationMs: 1, error: null })
    send({ id: req.id, result: {} })
    send({
      method: 'turn/completed',
      params: { threadId: req.params.threadId, turn: { id: req.params.turnId, status: 'interrupted' } },
    })
  } else if (req.method === 'turn/start') {
    const threadId = req.params.threadId
    const turnId = 'notify-turn-' + (++turnSeq)
    const promptText = req.params.input.map((item) => item.text ?? '').join('\\n')
    const thread = ensureThread(threadId)
    thread.status = 'active'
    updateFacts((facts) => {
      facts.starts += 1
    })
    send({ id: req.id, result: { turn: { id: turnId } } })

    if (promptText.includes('[wait-complete]')) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-' + turnId, delta: 'Working on completion...' },
      })
      waitForFile(triggerCompletePath, () => {
        thread.status = 'idle'
        const text = 'Background completion finished cleanly.'
        thread.turns.push({ id: turnId, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null })
        thread.items.push({ turnId, item: { type: 'agentMessage', id: 'msg-' + turnId, text } })
        send({
          method: 'item/completed',
          params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-' + turnId, text } },
        })
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
      })
    } else if (promptText.includes('[wait-fail]')) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-' + turnId, delta: 'Running until failure...' },
      })
      waitForFile(triggerFailPath, () => {
        thread.status = 'idle'
        thread.turns.push({
          id: turnId,
          status: 'interrupted',
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          error: 'Simulated abnormal interruption',
        })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'failed', error: 'Simulated failure' } },
        })
      })
    } else if (promptText.includes('[wait-question]')) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-' + turnId, delta: 'Preparing question...' },
      })
      waitForFile(triggerQuestionPath, () => {
        pendingQuestionFinish = () => {
          thread.status = 'idle'
          const text = 'Question answered cleanly.'
          thread.turns.push({ id: turnId, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null })
          send({
            method: 'item/completed',
            params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-' + turnId, text } },
          })
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
        }
        send({
          id: 'notify-question',
          method: 'item/tool/requestUserInput',
          params: {
            threadId,
            turnId,
            itemId: 'question-' + turnId,
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Which scope should run?',
                options: [
                  { label: 'Current file', description: 'Only this file.' },
                  { label: 'Whole project', description: 'All files.' },
                ],
              },
            ],
          },
        })
      })
    } else if (promptText.includes('[wait-stop]')) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-' + turnId, delta: 'Streaming until user stops...' },
      })
      const timer = setInterval(() => {}, 1000)
      activeStops.set(turnId, { timer })
    }
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(cliPath, 0o755)
  return {
    cliPath,
    factsPath,
    triggerCompletePath,
    triggerFailPath,
    triggerQuestionPath,
  }
}

async function focusElectronWindow(app: ElectronApplication, page: Page): Promise<void> {
  const cdp = await app.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
    nativeApp.focus({ steal: true })
    BrowserWindow.getAllWindows()[0]?.focus()
  })
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return Boolean(win && win.isVisible() && win.isFocused())
      }),
    )
    .toBe(true)
}

async function seedProjectWithSessions(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
  codexPath: string,
  titles: string[],
) {
  const db = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID()
  const createdAt = new Date().toISOString()
  const settings = {
    primaryAgentId: 'codex' as const,
    secondaryAgentId: 'claude' as const,
    agents: {
      claude: { model: null, effort: null },
      codex: { model: null, effort: null },
      agy: { model: null, effort: null },
    },
    maxDiscussionRounds: 3,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
  try {
    db.runtimePreparationRepository.saveSelectedExecutablePath('codex', codexPath)
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Notifications Project',
      directoryPath: await fixture.createProjectDirectory('notify-project', false),
      kind: 'directory',
      createdAt,
    })
    return titles.map((title, index) => {
      const id = randomUUID()
      const ts = new Date(Date.now() + index * 1000).toISOString()
      db.sessionRepository.create({ id, projectId, title, createdAt: ts }, settings)
      db.sessionRepository.rename(id, title)
      return { id, title }
    })
  } finally {
    db.close()
  }
}

test(
  'shows in-app Session reminders for background needs_input/failure/completed, keeps user_stopped silent, and handles Settings visibility & auto-clear',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'deterministic' })
    const codex = await writeNotificationCodexCli(fixture.directory)
    const [sessionA, sessionB, sessionC] = await seedProjectWithSessions(fixture, codex.cliPath, [
      'Session Alpha',
      'Session Beta',
      'Session Gamma',
    ])
    const app = await fixture.launch()

    try {
      const page = await app.firstWindow()
      await focusElectronWindow(app, page)

      // 1. User Stop stays completely silent (no reminder).
      await page.getByRole('button', { name: sessionA!.title, exact: true }).click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      await expect(composer).toBeEnabled()
      await composer.fill('[wait-stop]')
      await composer.press('Enter')
      await expect(page.getByText('Streaming until user stops...', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Stop Codex response', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Stop Codex response', exact: true }),
      ).toHaveCount(0)
      await page.getByRole('button', { name: sessionB!.title, exact: true }).click()
      await expect(page.locator('[data-session-reminder]')).toHaveCount(0)

      // 2. Background completion in Session Alpha while viewing Session Beta -> reminder appears -> View Session navigates and clears.
      await page.getByRole('button', { name: sessionA!.title, exact: true }).click()
      await expect(composer).toBeEnabled()
      await composer.fill('[wait-complete]')
      await composer.press('Enter')
      await expect(page.getByText('Working on completion...', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: sessionB!.title, exact: true }).click()
      await expect(page.getByRole('heading', { name: sessionB!.title, exact: true })).toBeVisible()
      await writeFile(codex.triggerCompletePath, 'go')

      const completedCard = page.locator('[data-session-reminder="completed"]')
      await expect(completedCard).toBeVisible()
      await expect(completedCard).toContainText('Session Alpha')
      await expect(completedCard).toContainText('Codex · Finished')
      await completedCard.getByRole('button', { name: 'View Session', exact: true }).click()
      await expect(completedCard).toHaveCount(0)
      await expect(
        page.getByText('Background completion finished cleanly.', { exact: true }),
      ).toBeVisible()

      // 3. Multi-session priority + overflow count badge: failure in Gamma + needs_input in Alpha while viewing Beta.
      await page.getByRole('button', { name: sessionC!.title, exact: true }).click()
      await expect(composer).toBeEnabled()
      await composer.fill('[wait-fail]')
      await composer.press('Enter')
      await expect(page.getByText('Running until failure...', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: sessionA!.title, exact: true }).click()
      await expect(composer).toBeEnabled()
      await composer.fill('[wait-question]')
      await composer.press('Enter')
      await expect(page.getByText('Preparing question...', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: sessionB!.title, exact: true }).click()
      await expect(page.getByRole('heading', { name: sessionB!.title, exact: true })).toBeVisible()
      await writeFile(codex.triggerFailPath, 'go')
      await expect(page.locator('[data-session-reminder="failure"]')).toBeVisible()

      // Higher-priority needs_input promotes over failure and displays +1 overflow badge.
      await writeFile(codex.triggerQuestionPath, 'go')
      const needsCard = page.locator('[data-session-reminder="needs_input"]')
      await expect(needsCard).toBeVisible()
      await expect(needsCard).toContainText('Session Alpha')
      await expect(needsCard).toContainText('Codex · Needs your input')
      await expect(needsCard.getByLabel('1 more pending')).toHaveText('+1')

      // Dismissing needs_input promotes remaining failure reminder; dismissing failure clears rail.
      await needsCard.getByRole('button', { name: 'Dismiss Session reminder', exact: true }).click()
      const failureCard = page.locator('[data-session-reminder="failure"]')
      await expect(failureCard).toBeVisible()
      await expect(failureCard).toContainText('Session Gamma')
      await failureCard
        .getByRole('button', { name: 'Dismiss Session reminder', exact: true })
        .click()
      await expect(page.locator('[data-session-reminder]')).toHaveCount(0)

      // 4. Settings view toggle over hidden mounted Session Beta: reminder IS visible while Settings is open,
      //    and clicking Back to app auto-clears the reminder!
      const secondCompleteTrigger = join(fixture.directory, 'trigger-complete')
      // Reuse a fresh completion in Session Beta while Settings is open over Session Beta's hidden DOM.
      await page.evaluate(() => {
        /* ensure Beta is selected before opening Settings */
      })
      const betaSession = sessionB!
      await page.getByRole('button', { name: betaSession.title, exact: true }).click()
      await expect(composer).toBeEnabled()
      // Remove old trigger file before starting Beta's turn.
      const { rmSync } = await import('node:fs')
      rmSync(secondCompleteTrigger, { force: true })
      await composer.fill('[wait-complete]')
      await composer.press('Enter')
      await expect(page.getByText('Working on completion...', { exact: true })).toBeVisible()

      // Toggle Settings open while Session Beta remains mounted in hidden DOM!
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Default session settings' })).toBeVisible()

      await writeFile(secondCompleteTrigger, 'go')
      const overSettings = page.locator('[data-session-reminder="completed"]')
      await expect(overSettings).toBeVisible()
      await expect(overSettings).toContainText('Session Beta')

      // Return to workspace: Session Beta becomes visible & focused -> reminder auto-clears!
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(overSettings).toHaveCount(0)
      await expect(
        page.getByText('Background completion finished cleanly.', { exact: true }),
      ).toBeVisible()

      expect(Reflect.get(JSON.parse(await readFile(codex.factsPath, 'utf8')), 'interrupts')).toBe(1)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'macOS Dock badge tracks unconfirmed background notifications and hands off to foreground on focus restore',
  { tag: '@deterministic' },
  async () => {
    test.skip(process.platform !== 'darwin', 'Verifies actual macOS Dock badge behavior')
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'deterministic' })
    const codex = await writeNotificationCodexCli(fixture.directory)
    const [sessionA, sessionB] = await seedProjectWithSessions(fixture, codex.cliPath, [
      'Dock Alpha',
      'Dock Beta',
    ])
    const app = await fixture.launch()

    try {
      const page = await app.firstWindow()
      await focusElectronWindow(app, page)

      await page.getByRole('button', { name: sessionA!.title, exact: true }).click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      await expect(composer).toBeEnabled()
      await composer.fill('[wait-complete]')
      await composer.press('Enter')
      await expect(page.getByText('Working on completion...', { exact: true })).toBeVisible()

      // Switch to Session Beta, then minimize so Pact is no longer visible/focused.
      await page.getByRole('button', { name: sessionB!.title, exact: true }).click()
      await expect(page.getByRole('heading', { name: sessionB!.title, exact: true })).toBeVisible()
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.minimize()
      })
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]
            return Boolean(win && win.isMinimized())
          }),
        )
        .toBe(true)

      await writeFile(codex.triggerCompletePath, 'go')
      await expect
        .poll(() => app.evaluate(({ app: nativeApp }) => nativeApp.dock?.getBadge() ?? ''))
        .toBe('1')

      // Restoring focus onto Session Beta hands unconfirmed Dock Alpha reminder to foreground rail.
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.restore()
        nativeApp.focus({ steal: true })
        win?.focus()
      })
      const handedOff = page.locator('[data-session-reminder="completed"]')
      await expect(handedOff).toBeVisible()
      await expect(handedOff).toContainText('Dock Alpha')

      // Viewing the handed-off reminder navigates to Dock Alpha and clears the macOS Dock badge.
      await handedOff.getByRole('button', { name: 'View Session', exact: true }).click()
      await expect(handedOff).toHaveCount(0)
      await expect
        .poll(() => app.evaluate(({ app: nativeApp }) => nativeApp.dock?.getBadge() ?? ''))
        .toBe('')
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
