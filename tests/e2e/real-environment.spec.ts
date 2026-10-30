import { expect } from '@playwright/test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { quitPact } from './native-quit.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'real CLIs report independent readiness and first-use gating',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real', firstUse: true })
    try {
      const versions = await Promise.all([
        fixture.runNativeCommand('claude', ['--version']),
        fixture.runNativeCommand('codex', ['--version']),
      ])
      expect(versions.map((row) => row.exitCode)).toEqual([0, 0])
      const app = await fixture.launch(),
        page = await app.firstWindow()
      await expect(page.getByText('2 of 2 ready', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByText('Detected: ' + versions[0].stdout.trim(), { exact: true }),
      ).toBeVisible()
      const codexVersion = versions[1].stdout.match(/\d+\.\d+\.\d+/u)?.[0]
      expect(codexVersion).toBeTruthy()
      await expect(
        page.getByText('Detected: codex-cli ' + codexVersion, { exact: true }),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
      const ready = await page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getRuntimePreparation()
      })
      expect(ready.ok && ready.value.agents.map((row) => row.state)).toEqual(['ready', 'ready'])
    } finally {
      await fixture.dispose()
    }
  },
)

test(
  'real configuration loss offers configuration recovery',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real', firstUse: true })
    try {
      const settingsPath = join(fixture.claudeHome, 'settings.json')
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
      delete settings.env.ANTHROPIC_AUTH_TOKEN
      delete settings.env.ANTHROPIC_API_KEY
      await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 })
      const status = await fixture.runNativeCommand('claude', ['auth', 'status'])
      expect(status.exitCode).toBe(1)
      const app = await fixture.launch(),
        page = await app.firstWindow()
      const row = page.getByRole('heading', { name: 'Claude Code', exact: true }).locator('../..')
      await expect(row.getByText('Setup required', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(row).toContainText('login or compatible API configuration')
      await expect(row.getByRole('button', { name: 'Locate manually…' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled()
      await expect(page.getByText('1 of 2 ready', { exact: true })).toBeVisible()
    } finally {
      await fixture.dispose()
    }
  },
)

test(
  'real configuration loss keeps existing work readable',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-degraded-environment')
    try {
      const marker = 'READABLE_NATIVE_HISTORY'
      await sendRealMessage(ctx, `Reply briefly with ${marker}. Do not use tools.`, 'codex')
      const prior = await waitForRealCompletion(ctx, 1)
      await quitPact(ctx.app)
      await rm(join(ctx.fixture.codexHome, 'auth.json'))
      const nativeConfigPath = join(ctx.fixture.codexHome, 'config.toml')
      const nativeConfig = parse(await readFile(nativeConfigPath, 'utf8'))
      for (const provider of Object.values(nativeConfig.model_providers ?? {})) {
        if (provider && typeof provider === 'object')
          Reflect.deleteProperty(provider, 'http_headers')
      }
      await writeFile(nativeConfigPath, stringify(nativeConfig), { mode: 0o600 })
      const status = await ctx.fixture.runNativeCommand('codex', ['login', 'status'])
      expect(status.exitCode).toBe(1)
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await expect(ctx.page.getByRole('alert')).toContainText('Agent actions paused', {
        timeout: 30_000,
      })
      await ctx.page
        .locator(`[data-session-menu="${ctx.sessionId}"]`)
        .getByRole('button')
        .first()
        .click()
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toContainText(marker)
      await expect(
        ctx.page.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeDisabled()
      await expect(
        ctx.page.getByRole('button', { name: 'Review setup', exact: true }),
      ).toBeVisible()
      const preserved = await readRealConversation(ctx)
      expect(preserved.runs.map((row) => row.id)).toEqual(prior.runs.map((row) => row.id))
      expect(preserved.messages).toEqual(prior.messages)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)
