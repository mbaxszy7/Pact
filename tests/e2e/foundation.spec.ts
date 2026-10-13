import { expect } from '@playwright/test'

import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test(
  'starts the Project Empty State and preserves the appearance foundation',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const electronApp = await fixture.launch()

    try {
      const window = await electronApp.firstWindow()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Add project', exact: true })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Open settings' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toHaveCount(0)

      await window.evaluate(() => {
        document.documentElement.dataset.theme = 'light'
      })

      await expect
        .poll(() =>
          window.evaluate(() => {
            const root = getComputedStyle(document.documentElement)
            return {
              canvas: root.getPropertyValue('--pact-canvas').trim(),
              surface: root.getPropertyValue('--pact-surface').trim(),
              text: root.getPropertyValue('--pact-text-primary').trim(),
              user: root.getPropertyValue('--pact-speaker-user').trim(),
              claude: root.getPropertyValue('--pact-speaker-claude').trim(),
              codex: root.getPropertyValue('--pact-speaker-codex').trim(),
              diffAdded: root.getPropertyValue('--pact-diff-added').trim(),
              diffRemoved: root.getPropertyValue('--pact-diff-removed').trim(),
              readyForeground: root.getPropertyValue('--pact-status-ready-foreground').trim(),
              focus: root.getPropertyValue('--pact-focus').trim(),
            }
          }),
        )
        .toEqual({
          canvas: '#ebf5ff',
          surface: '#fafdff',
          text: '#0a0d12',
          user: '#f1e6ff',
          claude: '#fff2eb',
          codex: '#d3f6e3',
          diffAdded: '#e5f8ed',
          diffRemoved: '#fff0ee',
          readyForeground: '#0d6b32',
          focus: '#0069e0',
        })

      await window.getByRole('button', { name: 'Open settings' }).click()
      await expect(window.getByRole('heading', { name: 'Default session settings' })).toBeVisible()
      await window.keyboard.press('Tab')
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toBeFocused()
      await expect
        .poll(() =>
          window
            .getByRole('button', { name: 'Hide navigation panel' })
            .evaluate((element) => getComputedStyle(element).outlineColor),
        )
        .toBe('rgb(0, 105, 224)')

      await window.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })

      await expect
        .poll(() =>
          window.evaluate(() => {
            const root = getComputedStyle(document.documentElement)
            return {
              canvas: root.getPropertyValue('--pact-canvas').trim(),
              surface: root.getPropertyValue('--pact-surface').trim(),
              text: root.getPropertyValue('--pact-text-primary').trim(),
              user: root.getPropertyValue('--pact-speaker-user').trim(),
              claude: root.getPropertyValue('--pact-speaker-claude').trim(),
              codex: root.getPropertyValue('--pact-speaker-codex').trim(),
              diffAdded: root.getPropertyValue('--pact-diff-added').trim(),
              diffRemoved: root.getPropertyValue('--pact-diff-removed').trim(),
              readyForeground: root.getPropertyValue('--pact-status-ready-foreground').trim(),
              focus: root.getPropertyValue('--pact-focus').trim(),
            }
          }),
        )
        .toEqual({
          canvas: '#0f1720',
          surface: '#141e28',
          text: '#f2f7fb',
          user: '#2b2941',
          claude: '#382923',
          codex: '#19372f',
          diffAdded: '#17392b',
          diffRemoved: '#402421',
          readyForeground: '#5ee58a',
          focus: '#67b1ff',
        })

      await window.setViewportSize({ width: 720, height: 900 })
      await expect
        .poll(() =>
          window.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true)
    } finally {
      await electronApp.close()
      await fixture.dispose()
    }
  },
)
