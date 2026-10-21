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
    await expect(window.getByText('Detected: 2.1.272 (Claude Code)', { exact: true })).toBeVisible()
    await expect(window.getByText('Detected: codex-cli 0.159.2', { exact: true })).toBeVisible()

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
          `@echo off\r\n"${process.execPath}" -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250)"\r\n` +
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

test(
  'first use requires supported CLI versions and recovers after an upgrade',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({
      firstUse: true,
      claude: 'unsupported_version',
      codex: 'unsupported_version',
    })
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await expect(window.getByText('Upgrade required', { exact: true })).toHaveCount(2)
      await expect(
        window.getByText('Detected: 2.1.271 (Claude Code)', { exact: true }),
      ).toBeVisible()
      await expect(window.getByText('Detected: codex-cli 0.159.1', { exact: true })).toBeVisible()
      await expect(
        window.getByText('Requires Claude Code 2.1.272 or later.', { exact: false }),
      ).toBeVisible()
      await expect(
        window.getByText('Requires Codex 0.159.2 or later.', { exact: false }),
      ).toBeVisible()
      await expect(window.getByText('0 of 2 ready', { exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
      const claudePath = join(
        fixture.directory,
        process.platform === 'win32' ? 'claude-fixture.cmd' : 'claude-fixture',
      )
      const codexPath = join(
        fixture.directory,
        process.platform === 'win32' ? 'codex-fixture.cmd' : 'codex-fixture',
      )
      await writeFile(
        claudePath,
        (await readFile(claudePath, 'utf8')).replace('2.1.271', '2.1.272'),
      )
      await writeFile(codexPath, (await readFile(codexPath, 'utf8')).replace('0.159.1', '0.159.2'))
      await window.getByRole('button', { name: 'Check again', exact: true }).click()
      await expect(window.getByText('2 of 2 ready', { exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
      await expect(window.getByText('Upgrade required', { exact: true })).toHaveCount(0)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'a runtime downgrade uses the existing warning bar and setup recovery',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.locator('[data-agent-actions="enabled"]')).toBeVisible()
      const codexPath = join(
        fixture.directory,
        process.platform === 'win32' ? 'codex-fixture.cmd' : 'codex-fixture',
      )
      const supported = await readFile(codexPath, 'utf8')
      await writeFile(codexPath, supported.replace('0.159.2', '0.159.1'))
      await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
      const warning = window.getByRole('alert')
      await expect(warning).toContainText('Upgrade required: Codex 0.159.2+')
      await expect(warning).not.toContainText('Claude Code')
      await expect(window.locator('[data-agent-actions="disabled"]')).toBeVisible()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await window.getByRole('button', { name: 'Review setup', exact: true }).click()
      await expect(window.getByText('Detected: codex-cli 0.159.1', { exact: true })).toBeVisible()
      await expect(window.getByText('Upgrade required', { exact: true })).toHaveCount(1)
      await expect(
        window.getByText('Resolve the issues above, then check again to resume agent actions.', {
          exact: true,
        }),
      ).toBeVisible()
      await window.getByRole('button', { name: 'Back to workspace', exact: true }).click()
      await writeFile(codexPath, supported)
      await window.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(warning).toHaveCount(0)
      await expect(window.locator('[data-agent-actions="enabled"]')).toBeVisible()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'visible runtime readiness refreshes each minute without a user action',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const app = await fixture.launch()
    try {
      const window = await app.firstWindow()
      await window.clock.install()
      await window.reload()
      await expect(window.locator('[data-agent-actions="enabled"]')).toBeVisible()
      const codexPath = join(
        fixture.directory,
        process.platform === 'win32' ? 'codex-fixture.cmd' : 'codex-fixture',
      )
      const supported = await readFile(codexPath, 'utf8')
      await writeFile(codexPath, supported.replace('0.159.2', '0.159.1'))
      await window.clock.fastForward(60_000)
      await expect(window.getByRole('alert')).toContainText('Upgrade required: Codex 0.159.2+')
      await expect(window.locator('[data-agent-actions="disabled"]')).toBeVisible()
      await writeFile(codexPath, supported)
      await window.clock.fastForward(60_000)
      await expect(window.getByRole('alert')).toHaveCount(0)
      await expect(window.locator('[data-agent-actions="enabled"]')).toBeVisible()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
