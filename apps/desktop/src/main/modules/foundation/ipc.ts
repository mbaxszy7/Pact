import { app, ipcMain } from 'electron'

import type { AppInfo, RpcResult } from '@pact/contracts'

import { appInfoSchema, IPC_CHANNELS } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

import { readProductIdentity } from '../../product-identity'

export function registerFoundationIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  ipcMain.handle(IPC_CHANNELS.appInfo, (event): RpcResult<AppInfo> => {
    trust.assertTrustedMainFrame(event)

    const info = appInfoSchema.parse({
      name: app.getName(),
      version: app.isPackaged ? app.getVersion() : readProductIdentity().version,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    })

    return { ok: true, value: info }
  })

  ipcMain.handle(IPC_CHANNELS.runtimeHealth, (event) => {
    trust.assertTrustedMainFrame(event)
    return utilityClient.getHealth()
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.appInfo)
    ipcMain.removeHandler(IPC_CHANNELS.runtimeHealth)
  }
}
