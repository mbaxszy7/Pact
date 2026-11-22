import { BrowserWindow, ipcMain } from 'electron'

import {
  IPC_CHANNELS,
  runtimeAgentIdSchema,
  runtimePreparationGetInputSchema,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { RuntimePreparationController } from './controller'

export function registerRuntimePreparationIpcHandlers(
  trust: RendererTrust,
  controller: RuntimePreparationController,
): () => void {
  ipcMain.handle(IPC_CHANNELS.runtimePreparationGet, (event, rawInput?: unknown) => {
    trust.assertTrustedMainFrame(event)
    if (rawInput === undefined) return controller.load()
    const parsedInput = runtimePreparationGetInputSchema.safeParse(rawInput)
    if (!parsedInput.success) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid runtime preparation request.' },
      }
    }
    return controller.load(parsedInput.data)
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
