import { expect, type ElectronApplication, type Page } from '@playwright/test'

import type { AppearanceSnapshot, RpcResult } from '../../packages/contracts/src/index.js'

import { quitPact } from './native-quit.js'
import { test } from './runtime-fixture.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

async function launchAppearanceApp(
  fixture: RuntimeFixture,
  extraEnvironment: Record<string, string> = {},
): Promise<ElectronApplication> {
  return fixture.launch(extraEnvironment)
}

function settingsEntry(window: Page) {
  return window.getByRole('button', { name: /^(Open settings|Settings)$/ })
}

async function openAppearanceSettings(window: Page): Promise<void> {
  await settingsEntry(window).click()
  await window.getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Appearance' })).toBeVisible()
}

test(
  'Windows keeps page Alpha and native controls while Solid remains opaque',
  { tag: '@ui' },
  async () => {
    test.skip(process.platform !== 'win32', 'Windows transparent window backing only')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let app = await launchAppearanceApp(fixture)
    try {
      let window = await app.firstWindow()
      await openAppearanceSettings(window)
      await window.getByRole('radio', { name: 'Dark' }).click()
      await window.getByRole('radio', { name: 'Translucent' }).click()
      await expect
        .poll(() => window.evaluate('window.pact.getAppearanceSettings()'))
        .toMatchObject({ ok: true, value: { requested: { windowMaterial: 'translucent' } } })
      await quitPact(app)
      app = await launchAppearanceApp(fixture)
      window = await app.firstWindow()
      await openAppearanceSettings(window)
      const settings = await window.evaluate('window.pact.getAppearanceSettings()')
      expect(settings).toMatchObject({
        ok: true,
        value: { effective: { windowMaterial: 'translucent' } },
      })
      const slider = window.getByRole('slider', { name: 'Transparency strength' })
      await slider.evaluate((element) => {
        if (!(element instanceof HTMLInputElement)) throw new Error('Transparency slider missing')
        element.value = '100'
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      await expect
        .poll(() =>
          window.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue(
              '--pact-material-navigation-alpha',
            ),
          ),
        )
        .toBe('0.55')
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      const alpha = await app.evaluate(async ({ BrowserWindow }) => {
        const native = BrowserWindow.getAllWindows()[0]
        if (!native) throw new Error('Native window missing')
        const image = await native.webContents.capturePage({ x: 70, y: 350, width: 1, height: 1 })
        const bitmap = image.toBitmap()
        if (bitmap.length < 4) throw new Error('Native page pixel unavailable')
        return {
          alpha: bitmap[3],
          resizable: native.isResizable(),
          maximizable: native.isMaximizable(),
        }
      })
      expect(Math.abs((alpha.alpha ?? 255) - 140)).toBeLessThanOrEqual(2)
      expect(alpha).toMatchObject({ resizable: true, maximizable: true })
      expect(
        await window.evaluate(() =>
          Boolean(Reflect.get(navigator, 'windowControlsOverlay')?.visible),
        ),
      ).toBe(true)
      await window.getByRole('radio', { name: 'Solid' }).click()
      await expect
        .poll(() => window.evaluate('window.pact.getAppearanceSettings()'))
        .toMatchObject({
          ok: true,
          value: {
            requested: { windowMaterial: 'solid' },
            effective: { windowMaterial: 'translucent', restartRequired: true },
          },
        })
      await quitPact(app)
      app = await launchAppearanceApp(fixture)
      window = await app.firstWindow()
      await openAppearanceSettings(window)
      await expect(window.locator('html')).toHaveAttribute('data-material', 'solid')
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      const solidAlpha = await app.evaluate(async ({ BrowserWindow }) => {
        const native = BrowserWindow.getAllWindows()[0]
        if (!native) throw new Error('Native window missing')
        const image = await native.webContents.capturePage({ x: 70, y: 350, width: 1, height: 1 })
        return image.toBitmap()[3]
      })
      expect(solidAlpha).toBe(255)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'previews and persists global Appearance settings across a real restart',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real' })
    let app: ElectronApplication | undefined

    try {
      app = await launchAppearanceApp(fixture)
      let window = await app.firstWindow()
      const projectEmptyTitle = window.getByRole('heading', { name: 'Start with a project' })
      await expect(projectEmptyTitle).toBeVisible()
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toHaveCount(0)

      await openAppearanceSettings(window)
      await expect(window.getByRole('button', { name: 'Back to app' })).toBeVisible()
      await expect(projectEmptyTitle).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Open context panel' })).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Close context panel' })).toHaveCount(0)
      await expect
        .poll(() =>
          window
            .getByTestId('workspace-context')
            .evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeLessThan(1)
      await expect(window.getByRole('radio', { name: 'Follow system' }).first()).toBeChecked()
      await expect(window.getByRole('heading', { name: 'Window background' })).toBeVisible()
      await expect(window.getByRole('radio', { name: 'Automatic' })).toBeVisible()

      await window.getByRole('radio', { name: 'Dark' }).click()
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(window.getByRole('radio', { name: 'Dark' })).toBeChecked()
      await expect(window.getByText('Saved', { exact: true })).toBeVisible()

      await window.getByRole('radio', { name: 'Solid' }).click()
      if (process.platform === 'win32') {
        await expect
          .poll(() => window.evaluate('window.pact.getAppearanceSettings()'))
          .toMatchObject({ ok: true, value: { requested: { windowMaterial: 'solid' } } })
        await quitPact(app)
        app = await launchAppearanceApp(fixture)
        window = await app.firstWindow()
        await openAppearanceSettings(window)
      }
      await expect(window.locator('html')).toHaveAttribute('data-material', 'solid')
      const effectOption = 'Translucent'
      const sliderName = 'Transparency strength'
      await expect(window.getByRole('slider', { name: sliderName })).toBeDisabled()
      await window.getByRole('radio', { name: effectOption }).click()
      if (process.platform === 'win32') {
        await expect
          .poll(() => window.evaluate('window.pact.getAppearanceSettings()'))
          .toMatchObject({
            ok: true,
            value: {
              requested: { windowMaterial: 'translucent' },
              effective: { windowMaterial: 'solid', restartRequired: true },
            },
          })
        await quitPact(app)
        app = await launchAppearanceApp(fixture)
        window = await app.firstWindow()
        await openAppearanceSettings(window)
      }
      await expect(window.getByRole('radio', { name: effectOption })).toBeChecked()
      const stored: unknown = await window.evaluate('window.pact.getAppearanceSettings()')
      expect(stored).toMatchObject({
        ok: true,
        value: {
          requested: { theme: 'dark', windowMaterial: 'translucent', materialOpacity: 85 },
        },
      })
      const nativeMaterialActive = await window.evaluate<'solid' | 'translucent' | null>(
        'window.pact.getAppearanceSettings().then((result) => result.ok ? result.value.effective.windowMaterial : null)',
      )
      const opacity = window.getByRole('slider', { name: sliderName })
      let savedOpacity = 85
      if (nativeMaterialActive === 'translucent') {
        await expect(opacity).toBeEnabled()
        const saveStrength = async (strength: number, storedOpacity: number): Promise<void> => {
          await opacity.evaluate((element, next) => {
            if (!(element instanceof HTMLInputElement))
              throw new TypeError('Opacity slider is missing.')
            element.value = String(next)
            element.dispatchEvent(new Event('input', { bubbles: true }))
            element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
          }, strength)
          await expect(opacity).toHaveValue(String(strength))
          await expect
            .poll(() =>
              window.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue(
                  '--pact-material-navigation-alpha',
                ),
              ),
            )
            .toBe(storedOpacity === 70 ? '0.55' : storedOpacity === 85 ? '0.725' : '0.9')
          await expect
            .poll(() =>
              window.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue(
                  '--pact-material-chat-alpha',
                ),
              ),
            )
            .toBe(storedOpacity === 70 ? '0.72' : storedOpacity === 85 ? '0.845' : '0.97')
          if (storedOpacity === 70) {
            await expect
              .poll(() =>
                window
                  .getByTestId('workspace-navigation')
                  .evaluate((element) => getComputedStyle(element).backgroundColor),
              )
              .toMatch(/, 0\.55\)$/)
            await expect
              .poll(() =>
                window
                  .getByTestId('workspace-center')
                  .evaluate((element) => getComputedStyle(element).backgroundColor),
              )
              .toMatch(/, 0\.72\)$/)
            await expect(window.getByRole('heading', { name: 'Settings' })).toHaveCSS(
              'color',
              'rgb(255, 255, 255)',
            )
          }
          await expect
            .poll(() =>
              window.evaluate<number | null>(
                'window.pact.getAppearanceSettings().then(result => result.ok ? result.value.requested.materialOpacity : null)',
              ),
            )
            .toBe(storedOpacity)
          await expect(window.getByText('Saved', { exact: true })).toBeVisible()
        }
        await saveStrength(100, 70)
        await saveStrength(50, 85)
        await saveStrength(0, 100)
        savedOpacity = 100
        await expect
          .poll(() => window.evaluate('window.pact.getAppearanceSettings()'))
          .toMatchObject({ ok: true, value: { requested: { materialOpacity: 100 } } })
      } else {
        await expect(opacity).toBeDisabled()
        await expect(window.getByText(/Using Solid/)).toBeVisible()
      }

      await quitPact(app)
      app = await launchAppearanceApp(fixture)
      window = await app.firstWindow()
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
      await openAppearanceSettings(window)
      await expect(window.getByRole('radio', { name: 'Dark' })).toBeChecked()
      await expect(window.getByRole('radio', { name: effectOption })).toBeChecked()
      await expect(window.getByRole('slider', { name: sliderName })).toHaveValue(
        String(savedOpacity === 100 ? 0 : 50),
      )

      await window.getByRole('button', { name: 'Restore defaults' }).click()
      await expect(window.getByRole('radio', { name: 'Follow system' }).first()).toBeChecked()
      await expect(window.getByRole('radio', { name: 'Automatic' })).toBeChecked()
      await expect(window.locator('html')).not.toHaveAttribute('data-theme', /.+/)
      const reset: unknown = await window.evaluate('window.pact.getAppearanceSettings()')
      expect(reset).toMatchObject({
        ok: true,
        value: {
          requested: { theme: 'system', windowMaterial: 'system', materialOpacity: 85 },
        },
      })

      await window.getByRole('button', { name: 'Back to app' }).click()
      await expect(settingsEntry(window)).toBeFocused()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Hide navigation panel' })).toHaveCount(0)
      await openAppearanceSettings(window)

      await app.evaluate(({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().at(0)
        if (!mainWindow) throw new Error('Main window missing')
        mainWindow.setContentSize(720, 520)
      })
      await expect
        .poll(() => window.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
        .toEqual([720, 520])
      await expect(window.locator('[data-workspace-viewport="narrow"]')).toBeVisible()
      await expect(window.getByRole('heading', { name: 'Appearance' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Back to app' })).toBeVisible()
      await expect(window.getByRole('button', { name: 'Open context panel' })).toHaveCount(0)
      await expect(window.getByRole('dialog', { name: 'Context fixture' })).toHaveCount(0)
      await expect
        .poll(() =>
          window.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true)

      await window.getByRole('button', { name: 'Back to app' }).click()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      await expect(window.getByRole('dialog', { name: 'Context fixture' })).toHaveCount(0)
      await expect(settingsEntry(window)).toBeFocused()
    } finally {
      if (app) await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'restores the last committed appearance when a save fails',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const app = await launchAppearanceApp(fixture, {
      PACT_TEST_APPEARANCE_WRITE_FAILURE: '1',
    })

    try {
      const window = await app.firstWindow()
      await openAppearanceSettings(window)
      await expect(window.getByRole('radio', { name: 'Follow system' }).first()).toBeChecked()

      await window.getByRole('radio', { name: 'Dark' }).click()
      await expect(window.getByRole('alert')).toContainText('Couldn’t save')
      await expect(window.getByRole('radio', { name: 'Follow system' }).first()).toBeChecked()
      await expect(window.locator('html')).not.toHaveAttribute('data-theme', /.+/)

      const stored: unknown = await window.evaluate('window.pact.getAppearanceSettings()')
      expect(stored).toMatchObject({ ok: true, value: { requested: { theme: 'system' } } })
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'macOS page Alpha follows transparency strength while Solid stays opaque',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.skip(process.platform !== 'darwin', 'macOS window backing only')
    const fixture = await createRuntimeFixture({ mode: 'real' })
    const app = await launchAppearanceApp(fixture)

    const navigationAlpha = async (): Promise<number> =>
      app.evaluate(async ({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().at(0)
        if (!mainWindow) throw new Error('Main window missing')
        const image = await mainWindow.webContents.capturePage({
          x: 70,
          y: 350,
          width: 1,
          height: 1,
        })
        const bitmap = image.toBitmap()
        if (bitmap.length < 4) throw new Error('Navigation pixel was not captured')
        return bitmap[3] ?? 255
      })

    try {
      const window = await app.firstWindow()
      await openAppearanceSettings(window)
      await window.getByRole('radio', { name: 'Light' }).click()
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
      await window.getByRole('radio', { name: 'Translucent' }).click()
      const effective = await window.evaluate<'solid' | 'translucent' | null>(
        'window.pact.getAppearanceSettings().then(result => result.ok ? result.value.effective.windowMaterial : null)',
      )
      test.skip(effective !== 'translucent', 'macOS accessibility settings require Solid')
      await expect(window.locator('html')).toHaveAttribute('data-material', 'translucent')
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      const defaultAlpha = await navigationAlpha()
      expect(defaultAlpha).toBeLessThan(255)

      const slider = window.getByRole('slider', { name: 'Transparency strength' })
      const alphaAt = async (strength: number, cssAlpha: string): Promise<number> => {
        await slider.evaluate((element, next) => {
          if (!(element instanceof HTMLInputElement))
            throw new TypeError('Transparency slider is missing')
          element.value = String(next)
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        }, strength)
        await expect
          .poll(() =>
            window.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue(
                '--pact-material-navigation-alpha',
              ),
            ),
          )
          .toBe(cssAlpha)
        await window.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        )
        return navigationAlpha()
      }

      const strongAlpha = await alphaAt(100, '0.55')
      const subtleAlpha = await alphaAt(0, '0.9')
      expect(strongAlpha).toBeLessThan(defaultAlpha)
      expect(subtleAlpha).toBeGreaterThan(defaultAlpha)
      expect(subtleAlpha).toBeLessThan(255)
      expect(Math.abs(strongAlpha - 166)).toBeLessThanOrEqual(2)
      expect(Math.abs(defaultAlpha - 198)).toBeLessThanOrEqual(2)
      expect(Math.abs(subtleAlpha - 230)).toBeLessThanOrEqual(2)

      await window.getByRole('radio', { name: 'Dark' }).click()
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
      const darkSubtleAlpha = await navigationAlpha()
      const darkStrongAlpha = await alphaAt(100, '0.55')
      expect(darkStrongAlpha).toBeLessThan(darkSubtleAlpha)
      expect(darkSubtleAlpha).toBeLessThan(255)

      await window.getByRole('radio', { name: 'Solid' }).click()
      await expect(window.locator('html')).toHaveAttribute('data-material', 'solid')
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      expect(await navigationAlpha()).toBe(255)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)

test(
  'macOS changes material in the same window without a restart notice and restores it on cold launch',
  { tag: '@ui' },
  async () => {
    test.skip(process.platform !== 'darwin', 'macOS live material policy only')
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    let app = await launchAppearanceApp(fixture)
    try {
      let window = await app.firstWindow()
      await openAppearanceSettings(window)
      const before = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
        id: BrowserWindow.getAllWindows()[0]!.id,
        accessibilitySolid:
          nativeTheme.prefersReducedTransparency ||
          nativeTheme.shouldUseHighContrastColors ||
          nativeTheme.inForcedColorsMode,
      }))
      await window.getByRole('radio', { name: 'Dark' }).click()
      await window.getByRole('radio', { name: 'Solid' }).click()
      await expect(window.locator('html')).toHaveAttribute('data-material', 'solid')
      await window.getByRole('radio', { name: 'Translucent' }).click()
      const effectiveMaterial = before.accessibilitySolid ? 'solid' : 'translucent'
      await expect(window.locator('html')).toHaveAttribute('data-material', effectiveMaterial)
      const strength = window.getByRole('slider', { name: 'Transparency strength' })
      if (!before.accessibilitySolid) {
        await strength.focus()
        await strength.press('End')
      }
      const expectedOpacity = before.accessibilitySolid ? 85 : 70
      const expected = {
        ok: true,
        value: {
          requested: {
            theme: 'dark',
            windowMaterial: 'translucent',
            materialOpacity: expectedOpacity,
          },
          effective: { theme: 'dark', windowMaterial: effectiveMaterial },
        },
      }
      await expect
        .poll(() =>
          window.evaluate<RpcResult<AppearanceSnapshot>>('window.pact.getAppearanceSettings()'),
        )
        .toMatchObject(expected)
      const live = await window.evaluate<RpcResult<AppearanceSnapshot>>(
        'window.pact.getAppearanceSettings()',
      )
      expect(live.ok && live.value.effective.restartRequired).toBeUndefined()
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(
        before.id,
      )

      await quitPact(app)
      app = await launchAppearanceApp(fixture)
      window = await app.firstWindow()
      await openAppearanceSettings(window)
      await expect
        .poll(() =>
          window.evaluate<RpcResult<AppearanceSnapshot>>('window.pact.getAppearanceSettings()'),
        )
        .toMatchObject(expected)
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(window.locator('html')).toHaveAttribute('data-material', effectiveMaterial)
      const restored = await window.evaluate<RpcResult<AppearanceSnapshot>>(
        'window.pact.getAppearanceSettings()',
      )
      expect(restored.ok && restored.value.effective.restartRequired).toBeUndefined()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
