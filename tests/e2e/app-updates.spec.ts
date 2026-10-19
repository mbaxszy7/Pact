import { expect } from '@playwright/test'

import desktopPackage from '../../apps/desktop/package.json' with { type: 'json' }
import { PACT_RELEASES_URL } from '../../packages/contracts/src/app-updates.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

for (const firstUse of [false, true]) {
  test(
    `native update menu shows the local version without enabling release checks${firstUse ? ' during first use' : ''}`,
    { tag: '@ui' },
    async () => {
      const fixture = await createRuntimeFixture({ mode: 'ui', firstUse })
      const app = await fixture.launch()
      try {
        const page = await app.firstWindow()
        await app.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()
            ?.items.flatMap((entry) => entry.submenu?.items ?? [])
            .find((entry) => entry.label === 'Check for Updates…')
          if (!item) throw new Error('Check for Updates menu item is missing.')
          item.click()
        })
        await expect(page.getByRole('heading', { name: 'About & updates' })).toBeVisible()
        await expect(page.getByText(desktopPackage.version, { exact: true })).toBeVisible()
        await expect(page.getByRole('link', { name: 'Download on GitHub' })).toHaveAttribute(
          'href',
          PACT_RELEASES_URL,
        )
        await expect(
          page.getByRole('button', { name: 'Check for updates', exact: true }),
        ).toHaveCount(0)
        await expect(page.getByRole('checkbox', { name: 'Check automatically' })).toHaveCount(0)
        const checked = await page.evaluate('window.pact.checkForUpdates()')
        expect(checked).toMatchObject({
          ok: true,
          value: { enabled: false, checking: false, latest: null, updateAvailable: false },
        })
        if (firstUse) {
          await page.getByRole('button', { name: 'Back to app' }).click()
          await expect(page.getByRole('heading', { name: 'About & updates' })).toHaveCount(0)
          const preparation = await page.evaluate('window.pact.getRuntimePreparation()')
          expect(preparation).toMatchObject({ ok: true, value: { firstUse: true } })
        }
      } finally {
        await quitPact(app)
        await fixture.dispose()
      }
    },
  )
}
