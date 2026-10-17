import { expect } from '@playwright/test'

import { createRuntimeFixture, test } from './runtime-fixture.js'

test(
  'idle native Quit drains the workspace without late interest IPC errors',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const app = await fixture.launch()
    const child = app.process()
    const warnings: string[] = []
    const observe = (chunk: Buffer): void => {
      const warning = chunk
        .toString()
        .match(/Error occurred in handler for 'pact:conversation:interest': ([^\n]{0,512})/u)?.[1]
      if (warning && warnings.length < 8) warnings.push(warning)
    }
    child.stderr?.on('data', observe)
    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      const closed = app.waitForEvent('close', { timeout: 15_000 })
      await app.evaluate(({ app: nativeApp }) => {
        setImmediate(() => nativeApp.quit())
      })
      await closed
      expect(child.exitCode).toBe(0)
      expect(warnings).toEqual([])
    } finally {
      child.stderr?.removeListener('data', observe)
      // An unsuccessful quit still fails above; only release this owned fixture.
      if (child.exitCode === null) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      await fixture.dispose()
    }
  },
)

test(
  'unknown native work can cancel exit and keep the same workspace before an explicit Exit',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture({ mode: 'ui' })
    const app = await fixture.launch()
    const child = app.process()
    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      const windowId = await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        const utility = nativeApp
          .getAppMetrics()
          .find((item) => item.name === 'Pact Utility Process')
        if (!utility) throw new Error('Fixture Utility missing')
        process.kill(utility.pid, 'SIGTERM')
        return BrowserWindow.getAllWindows()[0]!.id
      })
      await expect
        .poll(() =>
          app.evaluate(({ app: nativeApp }) =>
            nativeApp.getAppMetrics().some((item) => item.name === 'Pact Utility Process'),
          ),
        )
        .toBe(false)
      await app.evaluate(({ app: nativeApp }) => {
        setImmediate(() => nativeApp.quit())
      })
      await expect(page.getByRole('heading', { name: 'Exit Pact?', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Exit Pact?', exact: true })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Start with a project' })).toBeVisible()
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(
        windowId,
      )
      await app.evaluate(({ app: nativeApp }) => {
        setImmediate(() => nativeApp.quit())
      })
      await expect(page.getByRole('heading', { name: 'Exit Pact?', exact: true })).toBeVisible()
      const closed = app.waitForEvent('close', { timeout: 15_000 })
      await page.getByRole('button', { name: 'Exit Pact', exact: true }).click()
      await closed
      expect(child.exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) await app.evaluate(({ app: nativeApp }) => nativeApp.exit(1))
      await fixture.dispose()
    }
  },
)
