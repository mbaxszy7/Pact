import { BrowserWindow, ipcMain } from 'electron'

import { IPC_CHANNELS, runtimeAgentIdSchema } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { RuntimePreparationController } from './controller'

export function registerRuntimePreparationIpcHandlers(
  trust: RendererTrust,
  controller: RuntimePreparationController,
): () => void {
  ipcMain.handle(IPC_CHANNELS.runtimePreparationGet, (event) => {
    trust.assertTrustedMainFrame(event)
    return controller.load()
  })

  ipcMain.handle(IPC_CHANNELS.runtimeExecutableChoose, async (event, agentIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)

    const parsedAgentId = runtimeAgentIdSchema.safeParse(agentIdInput)
    if (!parsedAgentId.success) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose a supported Agent executable.' },
      }
    }

    const owner = BrowserWindow.fromWebContents(event.sender)
    return controller.chooseExecutable(parsedAgentId.data, owner ?? undefined)
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.runtimePreparationGet)
    ipcMain.removeHandler(IPC_CHANNELS.runtimeExecutableChoose)
  }
}
