import { expect } from '@playwright/test'

import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'closing during native resize hides the same workspace and retains its geometry on reveal',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const app = await fixture.launch()
    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      const resized = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error('Main window missing')
        const bounds = window.getBounds(),
          minimum = window.getMinimumSize()
        window.close()
        window.setBounds({
          ...bounds,
          width: Math.max(minimum[0]!, bounds.width - 24),
          height: Math.max(minimum[1]!, bounds.height - 24),
        })
        return { id: window.id, bounds: window.getBounds() }
      })
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(),
            resized.id,
          ),
        )
        .toBe(false)
      await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'))
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }, id) => {
            const window = BrowserWindow.fromId(id)
            return window && { visible: window.isVisible(), opacity: window.getOpacity() }
          }, resized.id),
        )
        .toEqual({ visible: true, opacity: 1 })
      expect(
        await app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.getBounds(),
          resized.id,
        ),
      ).toEqual(resized.bounds)
      await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
