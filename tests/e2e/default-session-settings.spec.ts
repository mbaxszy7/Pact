import { expect } from '@playwright/test'

import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test(
  'saves first-use defaults and reopens the singleton from Settings',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real', firstUse: true })

    try {
      let app = await fixture.launch()
      let window = await app.firstWindow()
      await expect(
        window.getByRole('heading', { name: 'Connect your coding agents' }),
      ).toBeVisible()
      await window.getByRole('button', { name: 'Continue' }).click()

      await expect(
        window.getByRole('heading', { name: 'Set your collaboration defaults' }),
      ).toBeVisible()
      await window.getByRole('radio', { name: 'Codex Set as Primary LLM' }).click()
      await window.getByRole('spinbutton', { name: 'Maximum discussion rounds' }).fill('4')
      await window.getByRole('spinbutton', { name: 'Repair attempts per task' }).fill('3')
      await window.getByRole('button', { name: 'Save and enter Pact' }).click()

      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()

      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await window.getByRole('button', { name: 'Open settings' }).click()

      await expect(window.getByRole('heading', { name: 'Default session settings' })).toBeVisible()
      await expect(window.getByRole('radio', { name: 'Codex Primary LLM' })).toBeChecked()
      await expect(
        window.getByRole('spinbutton', { name: 'Maximum discussion rounds' }),
      ).toHaveValue('4')
      await expect(window.getByRole('button', { name: 'Save defaults' })).toBeDisabled()
      await expect(window.getByRole('button', { name: 'Save defaults' })).toHaveCSS(
        'cursor',
        'default',
      )
    } finally {
      await fixture.dispose()
    }
  },
)
