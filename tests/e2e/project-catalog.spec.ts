import { expect } from '@playwright/test'

import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test(
  'adds, restores, collapses, archives, and re-adds a local Project',
  { tag: '@real' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })

    try {
      const projectDirectory = await fixture.createProjectDirectory('sample-project')
      let app = await fixture.launch()
      let window = await app.firstWindow()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toHaveCount(0)

      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, projectDirectory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()

      const projectRow = window.getByRole('button', {
        name: /^(Expand|Collapse) Project sample-project$/u,
      })
      await expect(projectRow).toBeVisible()
      await expect(projectRow).toHaveAttribute('aria-expanded', 'true')
      await projectRow.click()
      await expect(projectRow).toHaveAttribute('aria-expanded', 'false')
      await projectRow.click()
      await expect(projectRow).toHaveAttribute('aria-expanded', 'true')

      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      const restoredProject = window.getByRole('button', {
        name: /^(Expand|Collapse) Project sample-project$/u,
      })
      await expect(restoredProject).toBeVisible()

      const archive = window.getByRole('button', { name: 'Archive Project sample-project' })
      const projectActions = archive.locator('..')
      await expect(projectActions).toHaveCSS('opacity', '0')
      await restoredProject.hover()
      await expect(projectActions).toHaveCSS('opacity', '1')
      await expect(window.getByRole('menu')).toHaveCount(0)
      await expect(archive.locator('svg')).toHaveCSS('width', '14px')
      await archive.focus()
      await expect(archive).toBeFocused()
      await window.keyboard.press('Enter')

      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Open settings' })).toBeVisible()
      const archiveNotice = window.getByRole('region', { name: 'Archive results', exact: true })
      await expect(archiveNotice).toBeVisible()
      await expect(archiveNotice.getByRole('button', { name: 'View' })).toHaveCount(1)
      await expect
        .poll(async () => (await archiveNotice.boundingBox())?.y)
        .toBeGreaterThanOrEqual(64)
      await archiveNotice.getByRole('button', { name: 'View', exact: true }).click()
      await archiveNotice
        .getByRole('button', { name: 'Undo archive of sample-project', exact: true })
        .click()
      await expect(restoredProject).toBeVisible()

      await restoredProject.hover()
      await archive.click()
      await window.getByRole('button', { name: 'Dismiss completed archive results' }).click()
      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, projectDirectory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await expect(restoredProject).toBeVisible()
    } finally {
      await fixture.dispose()
    }
  },
)
