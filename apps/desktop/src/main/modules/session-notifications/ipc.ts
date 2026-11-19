import { ipcMain } from 'electron'

import type { RpcResult, SessionReminderActionResult } from '@pact/contracts'

import { IPC_CHANNELS, sessionReminderActionSchema } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { SessionNotificationController } from './controller'

function invalid(): RpcResult<SessionReminderActionResult> {
  return {
    ok: false,
    error: { code: 'VALIDATION', message: 'Choose a current Session reminder.' },
  }
}

export function registerSessionNotificationIpcHandlers(
  trust: RendererTrust,
  controller: SessionNotificationController,
): () => void {
  ipcMain.handle(IPC_CHANNELS.sessionReminderView, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionReminderActionSchema.safeParse(raw)
    return input.success ? controller.view(input.data.id) : invalid()
  })
  ipcMain.handle(IPC_CHANNELS.sessionReminderDismiss, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionReminderActionSchema.safeParse(raw)
    return input.success ? controller.dismiss(input.data.id) : invalid()
  })
  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.sessionReminderView)
    ipcMain.removeHandler(IPC_CHANNELS.sessionReminderDismiss)
  }
}
