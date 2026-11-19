import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

async function writeUsageClis(directory: string, options: { failClaude?: boolean } = {}) {
  const codexPath = join(directory, 'codex-usage-e2e.mjs')
  const claudePath = join(directory, 'claude-usage-e2e.mjs')
  const codexFactsPath = join(directory, 'codex-usage-e2e-facts.json')
  const claudeFactsPath = join(directory, 'claude-usage-e2e-facts.json')

  await writeFile(codexFactsPath, JSON.stringify({ usageProbes: 0 }))
  await writeFile(claudeFactsPath, JSON.stringify({ usageProbes: 0 }))

  await writeFile(
    codexPath,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.159.2')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0)
if (args[0] === 'features' && args[1] === 'list') {
  console.log('shell_tool stable true')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)

const factsPath = ${JSON.stringify(codexFactsPath)}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const req = JSON.parse(line)
  if (req.method === 'initialize') {
    send({ id: req.id, result: {} })
  } else if (req.method === 'account/read') {
    send({
      id: req.id,
      result: {
        account: { type: 'chatgpt', email: 'codex-e2e@example.invalid' },
        userId: 'e2e-codex-user',
        requiresOpenaiAuth: false,
      },
    })
  } else if (req.method === 'account/rateLimits/read') {
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
    facts.usageProbes += 1
    writeFileSync(factsPath, JSON.stringify(facts))
    const futureFiveHour = Math.floor(Date.now() / 1000) + 90 * 60
    // Provide 5h only (82% used => 18% left warning) and omit 7d to prove absent windows stay hidden.
    send({
      id: req.id,
      result: {
        rateLimitsByLimitId: {
          codex: {
            primary: { windowDurationMins: 300, usedPercent: 82, resetsAt: futureFiveHour },
          },
        },
      },
    })
  } else if (req.method === 'model/list') {
    send({ id: req.id, result: { data: [] } })
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(codexPath, 0o755)

  await writeFile(
    claudePath,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.272 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0)

const failClaude = ${JSON.stringify(Boolean(options.failClaude))}
const factsPath = ${JSON.stringify(claudeFactsPath)}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const msg = JSON.parse(line)
  if (msg.type !== 'control_request') continue
  if (msg.request.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [],
          account: {
            email: 'claude-e2e@example.invalid',
            organization: 'Secret E2E Org',
            apiProvider: 'firstParty',
            subscriptionType: 'max',
          },
          hooks_applied: true,
          current_permission_mode: 'dontAsk',
        },
      },
    })
  } else if (msg.request.subtype === 'get_usage') {
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
    facts.usageProbes += 1
    writeFileSync(factsPath, JSON.stringify(facts))
    if (failClaude) {
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: msg.request_id,
          error: 'Simulated initial limits probe failure',
        },
      })
    } else {
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              five_hour: {
                utilization: 96,
                resets_at: new Date(Date.now() + 45 * 60_000).toISOString(),
              },
              seven_day: {
                utilization: 35,
                resets_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
              },
            },
          },
        },
      })
    }
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(claudePath, 0o755)

  return { codexPath, claudePath, codexFactsPath, claudeFactsPath }
}

async function seedProject(
  fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
  codexPath: string,
  claudePath: string,
) {
  const db = await PactDatabase.open({
    filePath: fixture.databaseFile,
    migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
  })
  try {
    db.runtimePreparationRepository.saveSelectedExecutablePath('codex', codexPath)
    db.runtimePreparationRepository.saveSelectedExecutablePath('claude', claudePath)
    db.projectCatalogRepository.add({
      id: randomUUID(),
      name: 'Usage Project',
      directoryPath: await fixture.createProjectDirectory('usage-project', false),
      kind: 'directory',
      createdAt: new Date().toISOString(),
    })
  } finally {
    db.close()
  }
}

test(
  'shows Usage trigger above Settings, displays hover compact vs click detailed popovers, omits absent windows, and keeps PII out of Renderer',
  { tag: '@deterministic' },
  async () => {
    test.skip(process.platform === 'win32', 'Uses POSIX executable node scripts')
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'deterministic' })
    const clis = await writeUsageClis(fixture.directory)
    await seedProject(fixture, clis.codexPath, clis.claudePath)
    const app = await fixture.launch()

    try {
      const page = await app.firstWindow()
      const usageTrigger = page.getByRole('button', { name: 'Usage', exact: true })
      const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
      await expect(usageTrigger).toBeVisible()
      await expect(settingsButton).toBeVisible()

      // Usage trigger is directly above Settings in Project Navigation.
      const orderOk = await page.evaluate(() => {
        const usage = document.querySelector<HTMLElement>('[data-usage-trigger]')
        const settings = Array.from(document.querySelectorAll('button')).find(
          (el) => el.textContent?.trim() === 'Settings',
        )
        if (!usage || !settings) return false
        const usageRect = usage.getBoundingClientRect()
        const settingsRect = settings.getBoundingClientRect()
        return usage.nextElementSibling === settings && usageRect.bottom <= settingsRect.top + 4
      })
      expect(orderOk).toBe(true)

      // Cold launch must NOT probe external provider CLIs before user hover/click interaction.
      expect(
        Reflect.get(JSON.parse(await readFile(clis.codexFactsPath, 'utf8')), 'usageProbes'),
      ).toBe(0)
      expect(
        Reflect.get(JSON.parse(await readFile(clis.claudeFactsPath, 'utf8')), 'usageProbes'),
      ).toBe(0)

      // Hover opens compact popover and initiates lazy probe showing % left without reset times or Refresh controls.
      await usageTrigger.hover()
      const compact = page.locator('[data-provider-usage-popover="compact"]')
      await expect(compact).toBeVisible()
      await expect(compact).toContainText('Codex')
      await expect(compact).toContainText('18% left')
      await expect(compact).toContainText('Claude Code')
      await expect(compact).toContainText('4% left')
      await expect(compact).toContainText('65% left')
      await expect(usageTrigger.locator('.bg-status-danger')).toBeVisible()
      await expect(compact.getByText(/Codex 7d/u)).toHaveCount(0)
      await expect(compact.getByText(/Resets/u)).toHaveCount(0)
      await expect(compact.getByRole('button', { name: /Refresh/u })).toHaveCount(0)

      // Click opens detailed popover with reset times and cooldown-disabled Refresh buttons.
      await usageTrigger.click()
      const detailed = page.locator('[data-provider-usage-popover="detailed"]')
      await expect(detailed).toBeVisible()
      await expect(usageTrigger).toHaveAttribute('aria-expanded', 'true')
      await expect(detailed).toContainText('Resets in')
      await expect(
        detailed.getByRole('button', { name: 'Refresh Codex', exact: true }),
      ).toBeDisabled()
      await expect(
        detailed.getByRole('button', { name: 'Refresh Claude Code', exact: true }),
      ).toBeDisabled()
      await expect(
        detailed.locator('[data-provider-usage="codex"] .bg-status-warning'),
      ).toBeVisible()
      await expect(
        detailed.locator('[data-provider-usage="claude"] .bg-status-danger'),
      ).toBeVisible()

      // Verify zero PII leaked into the DOM.
      const bodyText = await detailed.textContent()
      expect(bodyText).not.toContain('codex-e2e@example.invalid')
      expect(bodyText).not.toContain('claude-e2e@example.invalid')
      expect(bodyText).not.toContain('Secret E2E Org')

      // Pressing Escape closes the detailed popover and restores focus to the trigger.
      await page.keyboard.press('Escape')
      await expect(detailed).toHaveCount(0)
      await expect(usageTrigger).toBeFocused()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'persists initial usage failure snapshot across Settings round-trip during cooldown without re-probing',
  { tag: '@deterministic' },
  async () => {
    test.skip(process.platform === 'win32', 'Uses POSIX executable node scripts')
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'deterministic' })
    const clis = await writeUsageClis(fixture.directory, { failClaude: true })
    await seedProject(fixture, clis.codexPath, clis.claudePath)
    const app = await fixture.launch()

    try {
      const page = await app.firstWindow()
      const usageTrigger = page.getByRole('button', { name: 'Usage', exact: true })
      await expect(usageTrigger).toBeVisible()

      // Click Usage to trigger initial probes (Codex warning dot appears, Claude probe fails once).
      expect(
        Reflect.get(JSON.parse(await readFile(clis.claudeFactsPath, 'utf8')), 'usageProbes'),
      ).toBe(0)
      await usageTrigger.click()
      await expect(usageTrigger.locator('.bg-status-warning')).toBeVisible()
      await expect
        .poll(async () =>
          Reflect.get(JSON.parse(await readFile(clis.claudeFactsPath, 'utf8')), 'usageProbes'),
        )
        .toBe(1)

      const detailedBefore = page.locator('[data-provider-usage-popover="detailed"]')
      await expect(detailedBefore.locator('[data-provider-usage="claude"]')).toContainText(
        'Unavailable',
      )
      await expect(
        detailedBefore.getByRole('button', { name: 'Refresh Claude Code', exact: true }),
      ).toBeDisabled()

      // Round-trip through Settings (unmounts ProjectNavigation) and Back to app.
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Default session settings' })).toBeVisible()
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(usageTrigger).toBeVisible()

      // Initial failure snapshot persists during cooldown without firing a second probe!
      await usageTrigger.click()
      const detailedAfter = page.locator('[data-provider-usage-popover="detailed"]')
      await expect(detailedAfter.locator('[data-provider-usage="claude"]')).toContainText(
        'Unavailable',
      )
      await expect(
        detailedAfter.getByRole('button', { name: 'Refresh Claude Code', exact: true }),
      ).toBeDisabled()
      expect(
        Reflect.get(JSON.parse(await readFile(clis.claudeFactsPath, 'utf8')), 'usageProbes'),
      ).toBe(1)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
