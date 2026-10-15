import { app, ipcMain } from 'electron'

import type { AppInfo, RpcResult } from '@pact/contracts'

import { appInfoSchema, IPC_CHANNELS, runtimeHealthInputSchema } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

export function registerFoundationIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  ipcMain.handle(IPC_CHANNELS.appInfo, (event): RpcResult<AppInfo> => {
    trust.assertTrustedMainFrame(event)

    const info = appInfoSchema.parse({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    })

    return { ok: true, value: info }
  })

  ipcMain.handle(IPC_CHANNELS.runtimeHealth, (event, input: unknown) => {
    trust.assertTrustedMainFrame(event)
    if (input === undefined) return utilityClient.getHealth()
    const parsed = runtimeHealthInputSchema.safeParse(input)
    if (!parsed.success)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid runtime health observation input.' },
      }
    return utilityClient.getHealth(parsed.data)
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.appInfo)
    ipcMain.removeHandler(IPC_CHANNELS.runtimeHealth)
  }
}
