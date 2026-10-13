import { ipcMain } from 'electron'

import type {
  AppearanceSettingsReset,
  AppearanceSettingsUpdate,
  AppearanceSnapshot,
  RpcResult,
} from '@pact/contracts'

import {
  appearanceSettingsResetSchema,
  appearanceSettingsUpdateSchema,
  appearanceSnapshotSchema,
  IPC_CHANNELS,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { AppearanceController } from './controller'

function validateAppearanceOutput(
  result: RpcResult<AppearanceSnapshot>,
): RpcResult<AppearanceSnapshot> {
  if (!result.ok) return result
  return { ok: true, value: appearanceSnapshotSchema.parse(result.value) }
}

function invalidAppearanceInput(message: string): RpcResult<AppearanceSnapshot> {
  return { ok: false, error: { code: 'VALIDATION', message } }
}

export function registerAppearanceIpcHandlers(
  trust: RendererTrust,
  appearance: AppearanceController,
): () => void {
  ipcMain.handle(
    IPC_CHANNELS.appearanceGet,
    async (event): Promise<RpcResult<AppearanceSnapshot>> => {
      trust.assertTrustedMainFrame(event)
      return validateAppearanceOutput(await appearance.refresh())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.appearanceUpdate,
    async (event, rawInput: unknown): Promise<RpcResult<AppearanceSnapshot>> => {
      trust.assertTrustedMainFrame(event)
      const input = appearanceSettingsUpdateSchema.safeParse(rawInput)
      if (!input.success) return invalidAppearanceInput('Appearance update is invalid.')
      return validateAppearanceOutput(
        await appearance.update(input.data satisfies AppearanceSettingsUpdate),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.appearanceReset,
    async (event, rawInput: unknown): Promise<RpcResult<AppearanceSnapshot>> => {
      trust.assertTrustedMainFrame(event)
      const input = appearanceSettingsResetSchema.safeParse(rawInput)
      if (!input.success) return invalidAppearanceInput('Appearance reset is invalid.')
      return validateAppearanceOutput(
        await appearance.reset(input.data satisfies AppearanceSettingsReset),
      )
    },
  )

  const unsubscribeAppearance = appearance.subscribe((snapshot) => {
    const payload = appearanceSnapshotSchema.parse(snapshot)
    for (const window of trust.trustedWindows()) {
      window.webContents.send(IPC_CHANNELS.appearanceChanged, payload)
    }
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.appearanceGet)
    ipcMain.removeHandler(IPC_CHANNELS.appearanceUpdate)
    ipcMain.removeHandler(IPC_CHANNELS.appearanceReset)
    unsubscribeAppearance()
  }
}
