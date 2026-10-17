import { expect, type ElectronApplication, type Page } from '@playwright/test'

/** Exercise normal Pact shutdown, including an unsettled background-operation confirmation. */
export async function quitPact(app: ElectronApplication, page?: Page): Promise<void> {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) {
    expect(child.exitCode).toBe(0)
    return
  }
  page ??= await app.firstWindow()
  const closed = app.waitForEvent('close', { timeout: 15_000 })
  const exit = page.getByRole('button', { name: 'Exit Pact', exact: true })
  await app.evaluate(({ app: nativeApp }) => {
    setImmediate(() => nativeApp.quit())
  })
  const confirm = await Promise.race([
    closed.then(() => false),
    exit
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch((error) => {
        if (page.isClosed()) return false
        throw error
      }),
  ])
  if (confirm) await exit.click()
  await closed
  expect(child.exitCode).toBe(0)
}
