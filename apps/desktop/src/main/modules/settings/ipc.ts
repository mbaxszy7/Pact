import { ipcMain } from 'electron'

import type { DefaultSessionSettingsState, RpcResult } from '@pact/contracts'

import {
  defaultSessionSettingsSaveInputSchema,
  IPC_CHANNELS,
  schedulingSettingsSaveSchema,
  schedulingStateInputSchema,
  schedulingActivityReadSchema,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

export function registerSettingsIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  ipcMain.handle(IPC_CHANNELS.schedulingStateGet, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = schedulingStateInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.getSchedulingState(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Scheduling context is invalid.' } }
  })
  ipcMain.handle(IPC_CHANNELS.schedulingStateRefresh, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = schedulingStateInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.refreshSchedulingState(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Scheduling context is invalid.' } }
  })
  ipcMain.handle(IPC_CHANNELS.schedulingSettingsGet, (event) => {
    trust.assertTrustedMainFrame(event)
    return utilityClient.getSchedulingSettings()
  })
  ipcMain.handle(IPC_CHANNELS.schedulingSettingsSave, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = schedulingSettingsSaveSchema.safeParse(raw)
    return input.success
      ? utilityClient.saveSchedulingSettings(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Scheduling settings are invalid.' } }
  })
  ipcMain.handle(IPC_CHANNELS.schedulingModelsRefresh, (event) => {
    trust.assertTrustedMainFrame(event)
    return utilityClient.refreshSchedulingModels()
  })
  ipcMain.handle(IPC_CHANNELS.schedulingActivityRead, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = schedulingActivityReadSchema.safeParse(raw)
    return input.success
      ? utilityClient.readSchedulingActivity(input.data)
      : {
          ok: false,
          error: { code: 'VALIDATION', message: 'Scheduling activity cursor is invalid.' },
        }
  })
  const unsubscribeScheduling = utilityClient.subscribeSchedulingChanges(() => {
    for (const window of trust.trustedWindows())
      window.webContents.send(IPC_CHANNELS.schedulingChanged, { changed: true })
  })
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
    unsubscribeScheduling()
    ipcMain.removeHandler(IPC_CHANNELS.schedulingStateGet)
    ipcMain.removeHandler(IPC_CHANNELS.schedulingStateRefresh)
    ipcMain.removeHandler(IPC_CHANNELS.schedulingSettingsGet)
    ipcMain.removeHandler(IPC_CHANNELS.schedulingSettingsSave)
    ipcMain.removeHandler(IPC_CHANNELS.schedulingModelsRefresh)
    ipcMain.removeHandler(IPC_CHANNELS.schedulingActivityRead)
    ipcMain.removeHandler(IPC_CHANNELS.defaultSessionSettingsGet)
    ipcMain.removeHandler(IPC_CHANNELS.defaultSessionSettingsSave)
  }
}
