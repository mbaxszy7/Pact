import { expect, type ElectronApplication, type Page } from '@playwright/test'

import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

async function setContentSize(
  electronApp: ElectronApplication,
  window: Page,
  width: number,
  height: number,
  viewport: 'wide' | 'compact' | 'narrow',
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const mainWindow = BrowserWindow.getAllWindows().at(0)
      if (!mainWindow) throw new Error('Main Electron window was not available.')
      mainWindow.setContentSize(size.width, size.height)
    },
    { height, width },
  )
  await expect
    .poll(() => window.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
    .toEqual([width, height])
  await expect(window.locator(`[data-workspace-viewport="${viewport}"]`)).toBeVisible()
}

async function addProject(
  fixture: RuntimeFixture,
  electronApp: ElectronApplication,
  window: Page,
): Promise<void> {
  const projectDirectory = await fixture.createProjectDirectory('layout-project')
  await electronApp.evaluate(({ dialog }, directoryPath) => {
    Reflect.set(dialog, 'showOpenDialog', async () => ({
      canceled: false,
      filePaths: [directoryPath],
    }))
  }, projectDirectory)
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(
    window.getByRole('button', { name: 'Rename Project layout-project', exact: true }),
  ).toBeVisible()
  await expect(
    window.getByRole('button', { name: 'Rename Project layout-project', exact: true }),
  ).toHaveText('layout-project')
}

test(
  'resizes and collapses the Project navigation without squeezing its content',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const electronApp = await fixture.launch()

    try {
      const window = await electronApp.firstWindow()
      await addProject(fixture, electronApp, window)
      await setContentSize(electronApp, window, 1600, 1000, 'wide')

      const navigationPanel = window.getByTestId('workspace-navigation')
      const workspacePanel = window.getByTestId('workspace-center')
      const separator = window.getByRole('separator', { name: 'Resize navigation' })
      const navigationContent = navigationPanel.locator(':scope > .workspace-panel-content')

      await expect(navigationPanel).toBeVisible()
      await expect(workspacePanel).toBeVisible()
      await expect(separator).toHaveCSS('width', '1px')
      const initialNavigationWidth = (await navigationPanel.boundingBox())?.width
      await separator.focus()
      await window.keyboard.press('ArrowRight')
      await expect
        .poll(async () => (await navigationPanel.boundingBox())?.width)
        .not.toBe(initialNavigationWidth)

      const contentWidthBeforeClose = await navigationContent.evaluate(
        (element) => element.getBoundingClientRect().width,
      )
      await window.getByRole('button', { name: 'Hide navigation panel' }).click()
      const navigationToggle = window.getByRole('button', { name: 'Show navigation panel' })
      await expect(navigationToggle).toBeFocused()
      await window.waitForTimeout(100)
      await expect
        .poll(() => navigationContent.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(contentWidthBeforeClose, 0)
      await expect
        .poll(() => navigationPanel.evaluate((element) => element.getBoundingClientRect().width))
        .toBeLessThan(1)

      await navigationToggle.click()
      await expect
        .poll(() => navigationPanel.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(190)
      await expect(window.getByRole('button', { name: 'Open context panel' })).toHaveCount(0)
    } finally {
      await quitPact(electronApp)
      await fixture.dispose()
    }
  },
)

test(
  'keeps Project navigation left of the workspace at the minimum supported width',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const electronApp = await fixture.launch()

    try {
      const window = await electronApp.firstWindow()
      await addProject(fixture, electronApp, window)
      await setContentSize(electronApp, window, 720, 900, 'narrow')

      const readTopology = async (): Promise<{
        navigation: number[]
        rootScroll: number[]
        workspace: number[]
      }> =>
        window.evaluate(() => {
          const navigation = document.querySelector<HTMLElement>('[aria-label="Navigation"]')
          const workspace = document.querySelector<HTMLElement>('[aria-label="Workspace"]')
          if (!navigation || !workspace) throw new Error('Constrained topology target missing.')
          const navigationBounds = navigation.getBoundingClientRect()
          const workspaceBounds = workspace.getBoundingClientRect()
          return {
            navigation: [navigationBounds.left, navigationBounds.right],
            workspace: [workspaceBounds.left, workspaceBounds.right],
            rootScroll: [document.documentElement.scrollLeft, document.documentElement.scrollTop],
          }
        })

      // The navigation surface has an existing 240 ms entrance transition.
      // Observe its settled position before asserting the unchanged topology.
      await expect.poll(async () => (await readTopology()).navigation[0]).toBe(0)
      const expanded = await readTopology()
      expect(expanded.navigation[0]).toBe(0)
      expect(expanded.navigation[1]).toBeLessThanOrEqual(expanded.workspace[0] ?? 0)
      expect(expanded.rootScroll).toEqual([0, 0])

      const separator = window.getByRole('separator', { name: 'Resize navigation' })
      await window.getByRole('button', { name: 'Hide navigation panel' }).click()
      await expect
        .poll(() =>
          window
            .getByTestId('workspace-navigation')
            .evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeLessThan(1)
      await expect(separator).toHaveCSS('width', '0px')
      const collapsed = await readTopology()
      expect(collapsed.workspace[0]).toBeCloseTo(0, 0)
      expect(collapsed.rootScroll).toEqual([0, 0])

      await window.getByRole('button', { name: 'Show navigation panel' }).click()
      await expect
        .poll(() =>
          window
            .getByTestId('workspace-navigation')
            .evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeGreaterThan(190)
      await expect
        .poll(() =>
          window.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true)
    } finally {
      await quitPact(electronApp)
      await fixture.dispose()
    }
  },
)
