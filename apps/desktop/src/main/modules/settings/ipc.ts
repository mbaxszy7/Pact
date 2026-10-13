import { ipcMain } from 'electron'

import type { DefaultSessionSettingsState, RpcResult } from '@pact/contracts'

import { defaultSessionSettingsSaveInputSchema, IPC_CHANNELS } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

export function registerSettingsIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  ipcMain.handle(IPC_CHANNELS.defaultSessionSettingsGet, (event) => {
    trust.assertTrustedMainFrame(event)
    return utilityClient.getDefaultSessionSettingsEditorState()
  })

  ipcMain.handle(
    IPC_CHANNELS.defaultSessionSettingsSave,
    (event, rawInput: unknown): Promise<RpcResult<DefaultSessionSettingsState>> => {
      trust.assertTrustedMainFrame(event)
      const input = defaultSessionSettingsSaveInputSchema.safeParse(rawInput)
      if (!input.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'VALIDATION', message: 'Default Session settings are invalid.' },
        })
      }
      return utilityClient.saveDefaultSessionSettings(input.data)
    },
  )

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.defaultSessionSettingsGet)
    ipcMain.removeHandler(IPC_CHANNELS.defaultSessionSettingsSave)
  }
}
