import { expect, type ElectronApplication, type Page } from '@playwright/test'

import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

async function addProject(
  fixture: RuntimeFixture,
  app: ElectronApplication,
  window: Page,
  name: string,
): Promise<void> {
  const directory = await fixture.createProjectDirectory(name)
  await app.evaluate(({ dialog }, directoryPath) => {
    Reflect.set(dialog, 'showOpenDialog', async () => ({
      canceled: false,
      filePaths: [directoryPath],
    }))
  }, directory)
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(
    window.getByRole('button', { name: `Rename Project ${name}`, exact: true }),
  ).toBeVisible()
  await expect(
    window.getByRole('button', { name: `Rename Project ${name}`, exact: true }),
  ).toHaveText(name)
}

test(
  'keeps Project context while creating, reopening, archiving, and restoring a Session',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ mode: 'real' })
    let app: ElectronApplication | undefined

    try {
      app = await fixture.launch()
      let window = await app.firstWindow()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await addProject(fixture, app, window, 'project-one')
      await addProject(fixture, app, window, 'project-two')

      await window.getByRole('button', { name: 'New Session in project-two' }).focus()
      await window.getByRole('button', { name: 'New Session in project-two' }).click()
      await expect(window.getByText(/Session in project-two/)).toBeVisible()
      await window.getByRole('button', { name: 'Back to project' }).click()
      await expect(
        window.getByRole('heading', { name: 'Start a Session in project-two' }),
      ).toBeVisible()
      await window.getByRole('button', { name: 'New Session', exact: true }).click()
      await expect(window.getByText(/Session in project-two/)).toBeVisible()
      await window.getByRole('button', { name: 'Create Session' }).click()

      const firstProjectGroup = window
        .getByRole('button', { name: 'Rename Project project-one', exact: true })
        .locator('../..')
      const secondProjectGroup = window
        .getByRole('button', { name: 'Rename Project project-two', exact: true })
        .locator('../..')
      await expect(
        firstProjectGroup.getByRole('button', { name: 'New session', exact: true }),
      ).toHaveCount(0)
      await expect(
        secondProjectGroup.getByRole('button', { name: 'New session', exact: true }),
      ).toBeVisible()
      await expect(window.getByRole('heading', { name: 'New session' })).toBeVisible()

      await quitPact(app)
      app = await fixture.launch()
      window = await app.firstWindow()
      const restoredSession = window.getByRole('button', { name: 'New session', exact: true })
      await expect(restoredSession).toBeVisible()
      await restoredSession.click()
      await expect(window.getByRole('heading', { name: 'New session' })).toBeVisible()

      const archiveSession = window.getByRole('button', { name: 'Archive Session New session' })
      await restoredSession.hover()
      await expect(archiveSession).toHaveCSS('opacity', '1')
      await expect(archiveSession.locator('svg')).toHaveCSS('width', '14px')
      await archiveSession.focus()
      await expect(archiveSession).toBeFocused()
      await window.keyboard.press('Enter')
      await expect(restoredSession).toHaveCount(0)
      const archiveNotice = window.getByRole('region', { name: 'Archive results', exact: true })
      await expect(archiveNotice).toBeVisible()
      await expect(archiveNotice.getByRole('button', { name: 'View' })).toHaveCount(1)
      await expect
        .poll(async () => (await archiveNotice.boundingBox())?.y)
        .toBeGreaterThanOrEqual(64)
      await archiveNotice.getByRole('button', { name: 'View', exact: true }).click()
      await archiveNotice
        .getByRole('button', { name: 'Undo archive of New session', exact: true })
        .click()
      await expect(window.getByRole('heading', { name: 'New session' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'New session', exact: true })).toBeVisible()
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)
