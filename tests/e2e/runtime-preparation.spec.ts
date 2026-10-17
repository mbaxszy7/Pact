import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { quitPact } from './native-quit.js'
import { waitForWindowsRuntimeReady } from './real-harness.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test('shows independent first-use readiness for both CLIs', { tag: '@ui' }, async () => {
  const fixture = await createRuntimeFixture({ firstUse: true })
  const app = await fixture.launch()

  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Connect your coding agents' })).toBeVisible()
    await expect(window.getByText('2 of 2 ready', { exact: true })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Claude Code' })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Codex' })).toBeVisible()
    await expect(window.getByText('Ready', { exact: true })).toHaveCount(2)
    await expect(window.getByText('2.1.272 (Claude Code)', { exact: true })).toBeVisible()
    await expect(window.getByText('codex-cli 0.146.0', { exact: true })).toBeVisible()

    await expect(window.getByRole('button', { name: 'Continue' })).toBeEnabled()
  } finally {
    await quitPact(app)
    await fixture.dispose()
  }
})

test(
  'uses configuration recovery instead of an irrelevant executable picker',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({
      firstUse: true,
      claude: 'authentication_required',
    })
    const app = await fixture.launch()

    try {
      const window = await app.firstWindow()
      const claudeRow = window.getByRole('heading', { name: 'Claude Code' }).locator('../..')
      await expect(claudeRow.getByText('Setup required', { exact: true })).toBeVisible()
      await expect(claudeRow).toContainText('login or compatible API configuration')
      await expect(claudeRow.getByRole('button', { name: 'Locate manually…' })).toHaveCount(0)
      await window.mouse.move(1, 1)
      const changePath = claudeRow.getByRole('button', { name: 'Change path…' })
      await expect(changePath).toHaveCSS('opacity', '0')
      await claudeRow.hover()
      await expect(changePath).toHaveCSS('opacity', '1')
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test('keeps returning work readable while Agent actions are gated', { tag: '@ui' }, async () => {
  const fixture = await createRuntimeFixture({ claude: 'authentication_required' })
  const app = await fixture.launch()

  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
    await expect(window.getByRole('alert')).toContainText('Agent actions paused')
    await expect(window.locator('[data-agent-actions="disabled"]')).toBeVisible()
    await expect(window.getByRole('button', { name: 'Review setup' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Add project', exact: true })).toBeVisible()
    if (process.platform === 'win32') {
      await expect(waitForWindowsRuntimeReady(window, fixture)).rejects.toThrow(
        'remained unavailable after one UI Retry',
      )
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      const ready = await createRuntimeFixture({ mode: 'ui' })
      try {
        await writeFile(
          join(fixture.directory, 'claude-fixture.cmd'),
          `"${process.execPath}" -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250)"\r\n` +
            (await readFile(join(ready.directory, 'claude-fixture.cmd'), 'utf8')),
        )
        const direct = await window.evaluate(async () => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const result = await bridge.getRuntimePreparation()
          return result.ok ? result.value.agents.map((agent) => agent.state) : []
        })
        expect(direct).toEqual(['ready', 'ready'])
        await expect(window.locator('[data-agent-actions="disabled"]')).toBeVisible()
        await waitForWindowsRuntimeReady(window, fixture)
        await expect(window.locator('[data-agent-actions="enabled"]')).toBeVisible()
        await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      } finally {
        await ready.dispose()
      }
    }
  } finally {
    await quitPact(app)
    await fixture.dispose()
  }
})
