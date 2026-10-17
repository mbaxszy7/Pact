import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

test.describe('Native Session permission lifetime', () => {
  for (const choice of ['once', 'session'] as const) {
    test(
      `offers only current-call/Session actions and sends the exact ${choice} native response`,
      { tag: '@deterministic' },
      async ({ browserName: _browserName }, testInfo) => {
        const fixture = await createRuntimeFixture({ codexAppServer: 'session_permission_scope' })
        const directory = await fixture.createProjectDirectory('permission-lifetime')
        const app = await fixture.launch()
        try {
          const window = await app.firstWindow()
          await app.evaluate(({ dialog }, directoryPath) => {
            Reflect.set(dialog, 'showOpenDialog', async () => ({
              canceled: false,
              filePaths: [directoryPath],
            }))
          }, directory)
          await window.getByRole('button', { name: 'Add project', exact: true }).click()
          await window.getByRole('button', { name: 'New Session in permission-lifetime' }).focus()
          await window.getByRole('button', { name: 'New Session in permission-lifetime' }).click()
          await window.getByRole('button', { name: 'Create Session' }).click()
          const composer = window.getByRole('combobox', { name: 'Message' })
          await composer.fill('Check permission lifetime')
          await expect(
            window.getByRole('button', { name: 'Send message', exact: true }),
          ).toBeEnabled()
          await composer.press('Enter')
          const card = window.getByRole('region', { name: 'Codex permission request', exact: true })
          await expect(
            card.getByRole('button', { name: 'Allow this command', exact: true }),
          ).toBeVisible()
          await expect(
            card.getByRole('button', { name: 'Allow for this session…', exact: true }),
          ).toBeVisible()
          await expect(
            card.getByRole('button', { name: /command rule|host rule|permission changes/iu }),
          ).toHaveCount(0)
          await window.screenshot({ path: testInfo.outputPath('current-session-actions.png') })
          if (choice === 'session') {
            await card.getByRole('button', { name: 'Allow for this session…', exact: true }).click()
            await expect(
              card.getByRole('group', { name: 'Confirm native permission scope' }),
            ).toBeVisible()
            await expect(
              card.getByText(
                'Codex may reuse this approval for the displayed scope in this native session.',
                { exact: true },
              ),
            ).toBeVisible()
            await window.screenshot({
              path: testInfo.outputPath('current-session-confirmation.png'),
            })
            await card.getByRole('button', { name: 'Confirm native action', exact: true }).click()
          } else await card.getByRole('button', { name: 'Allow this command', exact: true }).click()
          await expect(
            window.getByText('Bounded lifecycle response.', { exact: true }),
          ).toBeVisible()
          await expect(card).toHaveCount(0)
          expect((await fixture.readCodexFacts()).permissionDecisions).toEqual([
            choice === 'session' ? 'acceptForSession' : 'accept',
          ])
          expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
        } finally {
          await quitPact(app)
          await fixture.dispose()
        }
      },
    )
  }
})

test(
  'provider completion releases the Composer while title enrichment is silent',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ codexAppServer: 'complete_title_silent' })
    const directory = await fixture.createProjectDirectory('bounded-agent-lifecycle')
    let app = await fixture.launch()

    try {
      let window = await app.firstWindow()
      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, directory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await window.getByRole('button', { name: 'New Session in bounded-agent-lifecycle' }).focus()
      await window.getByRole('button', { name: 'New Session in bounded-agent-lifecycle' }).click()
      await window.getByRole('button', { name: 'Create Session' }).click()

      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Does title silence block completion?')
      await composer.press('Enter')

      await expect(window.getByText('Bounded lifecycle response.')).toBeVisible({ timeout: 5_000 })
      await expect(composer).toBeEnabled({ timeout: 1_000 })
      await expect.poll(() => composer.textContent()).toBe('')
      // A second request really reuses the native context and starts the bounded
      // native title read; completion must not wait for that deliberately silent RPC.
      await composer.fill('Reuse the native context while its title check is silent')
      await composer.press('Enter')
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(2)
      await expect(composer).toBeEnabled({ timeout: 1_000 })
      expect((await fixture.readCodexFacts()).methods).toContain('thread/read')

      await quitPact(app)
      app = await fixture.launch()
      window = await app.firstWindow()
      await window
        .getByRole('button', { name: 'Does title silence block completion?', exact: true })
        .click()
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(2)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'Retry check recovers a lost acknowledgement from native evidence without resending',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ codexAppServer: 'lost_ack_recovered' })
    const directory = await fixture.createProjectDirectory('delivery-reconciliation')
    const app = await fixture.launch()

    try {
      const window = await app.firstWindow()
      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, directory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await window.getByRole('button', { name: 'New Session in delivery-reconciliation' }).focus()
      await window.getByRole('button', { name: 'New Session in delivery-reconciliation' }).click()
      await window.getByRole('button', { name: 'Create Session' }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Recover this delivery internally')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await composer.press('Enter')
      await expect(window.locator('article[data-pact-speaker="user"]')).toHaveCount(1)
      await expect
        .poll(async () => {
          const health = await window.evaluate(() => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getRuntimeHealth()
          })
          return health.ok ? health.value.conversation?.activeExecutions : undefined
        })
        .toBe(0)
      await window.getByRole('button', { name: 'Check session', exact: true }).click()
      await expect(window.getByText('Recovered after lost ACK.')).toBeVisible({ timeout: 10_000 })
      await expect(composer).toBeEnabled()
      await expect(window.getByText('Run failed')).toHaveCount(0)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'absence cannot authorize replay: Retry and confirmed Rebuild start no old task',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'lost_ack_absent_then_retry' })
    const directory = await fixture.createProjectDirectory('safe-delivery-retry')
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, directory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await window.getByRole('button', { name: 'New Session in safe-delivery-retry' }).focus()
      await window.getByRole('button', { name: 'New Session in safe-delivery-retry' }).click()
      await window.getByRole('button', { name: 'Create Session' }).click()
      const composer = window.getByRole('combobox', { name: 'Message' })
      await composer.fill('Never replay solely because native history is absent')
      await expect(window.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await composer.press('Enter')
      await expect(window.locator('article[data-pact-speaker="user"]')).toHaveCount(1)
      await expect
        .poll(async () => {
          const health = await window.evaluate(() => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getRuntimeHealth()
          })
          return health.ok ? health.value.conversation?.activeExecutions : undefined
        })
        .toBe(0)
      await window.getByRole('button', { name: 'Check session', exact: true }).click()
      await expect(window.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible()
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      await window.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await window.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(window.getByText('Codex native session rebuilt', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      const duplicate = await window.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const projects = await bridge.getProjectCatalog()
        if (!projects.ok) throw new Error('Missing fixture Project')
        const sessions = await bridge.getSessionCatalog(projects.value.projects[0]!.id)
        if (!sessions.ok) throw new Error('Missing fixture Session')
        const sessionId = sessions.value.sessions[0]!.id
        const page = await bridge.getConversation({ scope: 'messages', sessionId })
        if (!page.ok || page.value.scope !== 'messages') throw new Error('Missing fixture history')
        const operation = page.value.header.nativeContexts?.[0]?.rebuildOperation
        if (!operation) throw new Error('Missing completed rebuild nonce')
        return (
          await bridge.rebuildNativeContext({
            sessionId,
            agentId: 'codex',
            intent: 'create',
            clientOperationId: operation.id,
            expectedGeneration: operation.oldGeneration,
          })
        ).ok
      })
      expect(duplicate).toBe(true)
      expect((await fixture.readCodexFacts()).threadStarts).toBe(2)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      await composer.fill('New independently submitted task')
      await composer.press('Enter')
      await expect(window.getByText('New task after recovery.')).toBeVisible({ timeout: 10_000 })
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(2)
      await expect(composer).toBeEnabled()
      await expect(
        window
          .getByRole('region', { name: 'Conversation messages' })
          .getByText('Never replay solely because native history is absent', { exact: true }),
      ).toHaveCount(1)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'Retry restores a confirmed completed result without creating another request',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'lost_ack_recovered' })
    const seeded = await seedDeliveryFailure(fixture, 'unknown_delivery', undefined, false)
    const app = await fixture.launch({ PACT_TEST_RECOVERY_RUN_ID: seeded.runId })

    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.title, exact: true }).click()
      await expect(window.getByRole('button', { name: 'Recover delivery' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Check again' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Check session', exact: true })).toBeVisible()
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      await window.getByRole('button', { name: 'Check session', exact: true }).click()
      await expect(window.getByText('Recovered after lost ACK.')).toBeVisible({ timeout: 10_000 })
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      const facts = await fixture.readCodexFacts()
      expect(facts.modelStarts).toHaveLength(0)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'an oversized Agent event shows its explicit bounded failure state',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const seeded = await seedDeliveryFailure(fixture, 'response_too_large')
    const app = await fixture.launch()

    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.title, exact: true }).click()
      await expect(window.getByText('The response exceeds Pact’s size limit.')).toBeVisible()
      await expect(window.getByRole('button', { name: 'Reexecute…', exact: true })).toHaveCount(0)
      await expect(window.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'an empty interrupted response stays hidden and only a new message starts another task',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'complete_title_silent' })
    const seeded = await seedDeliveryFailure(fixture, 'agent_process_crash')
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.title, exact: true }).click()
      await expect(window.getByText('Codex response incomplete', { exact: true })).toBeVisible()
      await expect(window.locator('[data-pact-speaker="codex"]')).toHaveCount(0)
      await expect(window.getByText('Incomplete', { exact: true })).toHaveCount(0)
      await submitNewTask(window)
      await expect(window.getByText('Bounded lifecycle response.')).toBeVisible({ timeout: 10_000 })
      await expect(window.getByText('Did the Agent receive this?', { exact: true })).toHaveCount(1)
      await expect(window.locator('[data-pact-speaker="codex"]')).toHaveCount(1)
      await expect(window.getByText('Run interrupted', { exact: true })).toHaveCount(0)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'graceful quit flushes an unpublished Delta before shutdown acknowledgement and restart',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'shutdown_pending_delta' })
    const seeded = await seedDeliveryFailure(fixture, 'unknown_delivery')
    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.title, exact: true }).click()
      await submitNewTask(window)
      await expect
        .poll(
          async () =>
            window.evaluate(async (sessionId) => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              const result = await bridge.getConversation({ scope: 'messages', sessionId })
              const health = await bridge.getRuntimeHealth()
              return result.ok && result.value.scope === 'messages'
                ? {
                    turnId: result.value.header.latestRun?.nativeTurnId,
                    hasBody: result.value.messages.some(
                      (item) => item.message.role === 'assistant',
                    ),
                    pending: health.ok ? health.value.conversation?.pendingStreamItems : undefined,
                  }
                : undefined
            }, seeded.sessionId),
          { intervals: [10] },
        )
        .toEqual({ turnId: 'fixture-turn', hasBody: false, pending: 1 })
      const closed = app.waitForEvent('close')
      await app.evaluate(({ app: electronApp }) => {
        setImmediate(() => electronApp.quit())
      })
      await expect(window.getByRole('heading', { name: 'Exit Pact?', exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Exit Pact', exact: true }).click()
      await closed
      app = undefined
      const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        const page = database.conversationRepository.readPage({
          scope: 'messages',
          sessionId: seeded.sessionId,
        })
        expect(page).toMatchObject({
          messages: [
            { message: { role: 'user' } },
            { message: { role: 'user', content: 'New independently submitted task' } },
            { message: { content: 'Saved by the graceful shutdown flush.', state: 'incomplete' } },
          ],
        })
        if (page.scope !== 'messages') throw new Error('Expected a Message page.')
        expect(page.header.latestRun?.status).toBe('interrupted')
      } finally {
        database.close()
      }
      app = await fixture.launch()
      const reopened = await app.firstWindow()
      await reopened
        .locator(`[data-session-menu="${seeded.sessionId}"]`)
        .getByRole('button')
        .first()
        .click()
      await expect(
        reopened.getByText('Saved by the graceful shutdown flush.', { exact: true }),
      ).toBeVisible()
      await expect(
        reopened.getByRole('button', { name: 'Check session', exact: true }),
      ).toBeVisible()
      // Interrupted native work still needs an explicit exit choice after restart.
      const reopenedClosed = app.waitForEvent('close', { timeout: 15_000 })
      await app.evaluate(({ app: electronApp }) => {
        setImmediate(() => electronApp.quit())
      })
      await expect(reopened.getByRole('heading', { name: 'Exit Pact?', exact: true })).toBeVisible()
      await reopened.getByRole('button', { name: 'Exit Pact', exact: true }).click()
      await reopenedClosed
      app = undefined
    } finally {
      // A failed assertion cannot leave this owned active fixture at a quit prompt.
      if (app) await app.evaluate(({ app: electronApp }) => electronApp.exit(1))
      await fixture.dispose()
    }
  },
)

test(
  'a silent Retry check cannot authorize generation and exposes checked Rebuild recovery',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'retry_inspection_silent' })
    const seeded = await seedDeliveryFailure(fixture, 'unknown_delivery', undefined, false)
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.getByRole('button', { name: seeded.title, exact: true }).click()
      await window.getByRole('button', { name: 'Check session', exact: true }).click()
      await expect(window.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toHaveCount(0)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(0)
      await expect(window.getByRole('combobox', { name: 'Message', exact: true })).toBeDisabled()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'a new explicit request preserves the previous result and both histories survive restart',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({ codexAppServer: 'retry_progress' })
    const seeded = await seedDeliveryFailure(
      fixture,
      'unknown_delivery',
      'Saved previous response.',
    )
    let app = await fixture.launch()
    try {
      let window = await app.firstWindow()
      await window
        .locator(`[data-session-menu="${seeded.sessionId}"]`)
        .getByRole('button')
        .first()
        .click()
      const prior = window.locator('article[data-pact-speaker="codex"]').first()
      await expect(prior.getByText('Saved previous response.', { exact: true })).toBeVisible()
      await prior.hover()
      const copy = await prior.locator('[data-pact-message-actions] button').boundingBox()
      const bubble = await prior.locator('[data-pact-message-bubble]').boundingBox()
      if (!copy || !bubble) throw new Error('Message geometry unavailable')
      expect(copy.y - bubble.y - bubble.height).toBeGreaterThanOrEqual(4)
      await submitNewTask(window)
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible({
        timeout: 10_000,
      })
      await expect(window.getByText('Saved previous response.', { exact: true })).toHaveCount(1)
      await expect(window.getByText('Did the Agent receive this?', { exact: true })).toHaveCount(1)
      await expect(
        window
          .getByRole('region', { name: 'Conversation messages' })
          .getByText('New independently submitted task', { exact: true }),
      ).toHaveCount(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
      await quitPact(app)
      app = await fixture.launch()
      window = await app.firstWindow()
      await window
        .locator(`[data-session-menu="${seeded.sessionId}"]`)
        .getByRole('button')
        .first()
        .click()
      await expect(window.getByText('Bounded lifecycle response.', { exact: true })).toBeVisible()
      await expect(window.getByText('Saved previous response.', { exact: true })).toHaveCount(1)
      await expect(window.getByText('Did the Agent receive this?', { exact: true })).toHaveCount(1)
      expect((await fixture.readCodexFacts()).modelStarts).toHaveLength(1)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

async function seedDeliveryFailure(
  fixture: RuntimeFixture,
  failureKind: 'unknown_delivery' | 'response_too_large' | 'agent_process_crash',
  partialText?: string,
  ended = true,
): Promise<{ title: string; runId: string; sessionId: string }> {
  const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const title = 'Unknown delivery fixture'
  const createdAt = new Date().toISOString()
  const directoryPath = await fixture.createProjectDirectory('unknown-delivery')
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'unknown-delivery',
    directoryPath,
    kind: 'git',
    createdAt,
  })
  database.sessionRepository.create(
    { id: sessionId, projectId, title, createdAt },
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
    content: 'Did the Agent receive this?',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  database.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId: 'codex',
    type: 'session.started',
    nativeSessionId: 'fixture-thread',
  })
  if (failureKind === 'agent_process_crash') {
    database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'fixture-turn',
      outputId: 'fixture-empty-output',
      text: '',
    })
  }
  if (partialText)
    database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId: 'partial-turn',
      outputId: 'partial-answer',
      text: partialText,
    })
  database.conversationRepository.failRun(
    started.run.id,
    failureKind,
    failureKind === 'unknown_delivery'
      ? 'Delivery could not be confirmed.'
      : 'Agent response exceeded the supported event size.',
    failureKind === 'agent_process_crash',
  )
  if (ended) {
    const observedRun = database.conversationRepository.findRun(started.run.id)!
    database.conversationRepository.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'interrupted',
      identity: {
        sessionId,
        agentId: 'codex',
        runId: started.run.id,
        requestId: started.run.id,
        nativeSessionId: observedRun.nativeSessionId ?? 'fixture-thread',
        nativeTurnId: observedRun.nativeTurnId ?? 'fixture-old-turn',
        bindingGeneration: observedRun.bindingGeneration ?? 1,
      },
    })
    database.conversationRepository.settleKnownNativeEnding(started.run.id)
  }
  database.close()
  return { title, runId: started.run.id, sessionId }
}

async function submitNewTask(window: Page): Promise<void> {
  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeEnabled()
  await composer.fill('New independently submitted task')
  await composer.press('Enter')
}
