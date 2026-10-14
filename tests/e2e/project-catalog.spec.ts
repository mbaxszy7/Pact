import { expect } from '@playwright/test'

import { test } from './runtime-fixture.js'
import { createRuntimeFixture } from './runtime-fixture.js'

test(
  'adds, restores, collapses, archives, and re-adds a local Project',
  { tag: ['@real', '@real-extended'] },
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
        name: /^(?:Collapse|Expand) Project sample-project$/,
      })
      const projectName = window.getByRole('button', {
        name: 'Rename Project sample-project',
        exact: true,
      })
      await expect(projectRow).toBeVisible()
      await expect(projectName).toBeVisible()
      await expect(projectName).toHaveText('sample-project')
      await expect(projectRow).toHaveAttribute('aria-expanded', 'true')
      await projectRow.click()
      await expect(projectRow).toHaveAttribute('aria-expanded', 'false')
      await expect(projectRow).toHaveAccessibleName('Expand Project sample-project')
      await expect(projectName).toHaveText('sample-project')
      await projectRow.click()
      await expect(projectRow).toHaveAttribute('aria-expanded', 'true')
      await expect(projectRow).toHaveAccessibleName('Collapse Project sample-project')

      await app.close()
      app = await fixture.launch()
      window = await app.firstWindow()
      const restoredProject = window.getByRole('button', {
        name: 'Rename Project sample-project',
        exact: true,
      })
      await expect(restoredProject).toBeVisible()
      await expect(restoredProject).toHaveText('sample-project')

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
      const archiveNotice = window.getByText('Project archived', { exact: true }).locator('..')
      await expect(archiveNotice).toBeVisible()
      await expect(archiveNotice.getByRole('button', { name: 'View' })).toHaveCount(0)
      await expect
        .poll(async () => (await archiveNotice.boundingBox())?.y)
        .toBeGreaterThanOrEqual(64)
      await archiveNotice.getByRole('button', { name: 'Undo' }).click()
      await expect(restoredProject).toBeVisible()
      await expect(restoredProject).toHaveText('sample-project')

      await restoredProject.hover()
      await archive.click()
      await window.getByRole('button', { name: 'Dismiss archive notice' }).click()
      await app.evaluate(({ dialog }, directoryPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [directoryPath],
        }))
      }, projectDirectory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await expect(restoredProject).toBeVisible()
      await expect(restoredProject).toHaveText('sample-project')
    } finally {
      await fixture.dispose()
    }
  },
)
