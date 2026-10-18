import { BrowserWindow, ipcMain, shell } from 'electron'

import {
  IPC_CHANNELS,
  workspaceArchivePrepareInputSchema,
  workspaceArchiveOperationInputSchema,
  nativePermissionRespondInputSchema,
  nativeInputReadSchema,
  nativeInputRespondSchema,
  projectArchiveInputSchema,
  projectContextInputSchema,
  projectNameChangeSchema,
  projectFileReadInputSchema,
  sessionArchiveInputSchema,
  sessionCatalogPageInputSchema,
  sessionCreateInputSchema,
  sessionCreationPrepareInputSchema,
  sessionMarkReadInputSchema,
  sessionRenameInputSchema,
  sessionSettingsInputSchema,
  sessionSettingsSaveInputSchema,
  sessionPermissionSaveInputSchema,
  sessionSpeedSaveInputSchema,
  workspaceChangeFileReadInputSchema,
  workspaceChangesReadInputSchema,
  workspaceChangesUndoInputSchema,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'
import type { ProjectCatalogController } from './project-catalog-controller'

export function registerWorkspaceIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
  projectCatalog: ProjectCatalogController,
): () => void {
  ipcMain.handle(IPC_CHANNELS.workspaceArchivePrepare, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = workspaceArchivePrepareInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.prepareWorkspaceArchive(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid item to archive.' } }
  })
  for (const channel of [IPC_CHANNELS.workspaceArchiveRead, IPC_CHANNELS.workspaceArchiveCancel]) {
    ipcMain.handle(channel, (event, rawInput: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = workspaceArchiveOperationInputSchema.safeParse(rawInput)
      return input.success
        ? channel === IPC_CHANNELS.workspaceArchiveRead
          ? utilityClient.readWorkspaceArchive(input.data)
          : utilityClient.cancelWorkspaceArchive(input.data)
        : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid archive operation.' } }
    })
  }
  ipcMain.handle(IPC_CHANNELS.nativeInputRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = nativeInputReadSchema.safeParse(rawInput)
    return parsed.success
      ? utilityClient.readNativeInput(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Invalid native input identity.' } }
  })
  ipcMain.handle(IPC_CHANNELS.nativeInputRespond, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = nativeInputRespondSchema.safeParse(rawInput)
    return parsed.success
      ? utilityClient.respondNativeInput(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Invalid native input response.' } }
  })
  ipcMain.handle(IPC_CHANNELS.nativeInputOpen, async (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = nativeInputReadSchema.safeParse(rawInput)
    if (!parsed.success)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid native authorization identity.' },
      }
    const details = await utilityClient.readNativeInput(parsed.data)
    if (!details.ok) return details
    if (details.value.kind !== 'url' || !details.value.url)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'This native request has no authorization page.' },
      }
    try {
      const url = new URL(details.value.url)
      if (
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password
      )
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'This native authorization URL is not supported.' },
        }
      await shell.openExternal(url.href)
      const confirmed = await utilityClient.confirmNativeInputURL(parsed.data)
      return confirmed.ok ? { ok: true, value: { opened: true } } : confirmed
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The native authorization page could not be opened.' },
      }
    }
  })
  ipcMain.handle(IPC_CHANNELS.nativePermissionRespond, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = nativePermissionRespondInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.respondNativePermission(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'This permission response is invalid.' },
        })
  })
  ipcMain.handle(IPC_CHANNELS.projectCatalogGet, (event) => {
    trust.assertTrustedMainFrame(event)
    return projectCatalog.load()
  })

  ipcMain.handle(IPC_CHANNELS.projectContextRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = projectContextInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.readProjectContext(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid project.' } }
  })
  ipcMain.handle(IPC_CHANNELS.projectDirectoryOpen, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = projectContextInputSchema.safeParse(rawInput)
    return input.success
      ? projectCatalog.openDirectory(input.data, () => trust.assertTrustedMainFrame(event))
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid project.' } }
  })

  ipcMain.handle(IPC_CHANNELS.projectCatalogChooseAndAdd, (event) => {
    trust.assertTrustedMainFrame(event)
    const owner = BrowserWindow.fromWebContents(event.sender)
    return projectCatalog.chooseAndAdd(owner ?? undefined)
  })

  ipcMain.handle(IPC_CHANNELS.projectCatalogRename, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = projectNameChangeSchema.safeParse(rawInput)
    return input.success
      ? projectCatalog.rename(input.data)
      : Promise.resolve({
          ok: false as const,
          error: {
            code: 'VALIDATION' as const,
            message: 'Use a single-line Project name of 1–120 characters.',
          },
        })
  })

  ipcMain.handle(
    IPC_CHANNELS.projectCatalogArchive,
    (event, projectIdInput: unknown, operationId: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = projectArchiveInputSchema.safeParse({ projectId: projectIdInput, operationId })
      return input.success
        ? projectCatalog.archive(input.data.projectId, input.data.operationId)
        : Promise.resolve({
            ok: false as const,
            error: { code: 'VALIDATION' as const, message: 'Choose a valid Project to archive.' },
          })
    },
  )

  ipcMain.handle(IPC_CHANNELS.projectCatalogRestore, (event, projectIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = projectArchiveInputSchema.safeParse({ projectId: projectIdInput })
    return input.success
      ? projectCatalog.restore(input.data.projectId)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Project to restore.' },
        })
  })

  ipcMain.handle(
    IPC_CHANNELS.sessionCatalogGet,
    (event, projectIdInput: unknown, cursorInput: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = sessionCatalogPageInputSchema.safeParse({
        projectId: projectIdInput,
        cursor: cursorInput,
      })
      return input.success
        ? utilityClient.getSessionCatalog(input.data)
        : Promise.resolve({
            ok: false as const,
            error: { code: 'VALIDATION' as const, message: 'Invalid Session Catalog cursor.' },
          })
    },
  )

  ipcMain.handle(IPC_CHANNELS.sessionCreationPrepare, (event, projectIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionCreationPrepareInputSchema.safeParse({ projectId: projectIdInput })
    return input.success
      ? utilityClient.prepareSessionCreation(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Project.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionCreate, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionCreateInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.createSession(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Session settings are invalid.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionRename, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionRenameInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.renameSession(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Enter a valid Session title.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionMarkRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionMarkReadInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.markSessionRead(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Session message.' },
        })
  })

  ipcMain.handle(
    IPC_CHANNELS.sessionArchive,
    (event, sessionIdInput: unknown, operationId: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = sessionArchiveInputSchema.safeParse({ sessionId: sessionIdInput, operationId })
      return input.success
        ? utilityClient.archiveSession(input.data)
        : Promise.resolve({
            ok: false as const,
            error: { code: 'VALIDATION' as const, message: 'Choose a valid Session.' },
          })
    },
  )

  ipcMain.handle(IPC_CHANNELS.sessionRestore, (event, sessionIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionArchiveInputSchema.safeParse({ sessionId: sessionIdInput })
    return input.success
      ? utilityClient.restoreSession(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Session.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionSettingsGet, (event, sessionIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionSettingsInputSchema.safeParse({ sessionId: sessionIdInput })
    return input.success
      ? utilityClient.getSessionSettings(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Session.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionSettingsSave, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionSettingsSaveInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.saveSessionSettings(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Session settings are invalid.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionPermissionSave, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionPermissionSaveInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.saveSessionPermission(input.data)
      : Promise.resolve({
          ok: false as const,
          error: {
            code: 'VALIDATION' as const,
            message: 'Choose a valid permission mode and confirm Full access.',
          },
        })
  })

  ipcMain.handle(IPC_CHANNELS.sessionSpeedSave, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionSpeedSaveInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.saveSessionSpeed(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Agent speed.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.projectFileRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = projectFileReadInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.readProjectFile(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'This file link is invalid.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.workspaceChangesRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = workspaceChangesReadInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.readWorkspaceChanges(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose valid workspace changes.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.workspaceChangeFileRead, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = workspaceChangeFileReadInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.readWorkspaceChangeFile(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid saved file version.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.workspaceChangesUndo, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = workspaceChangesUndoInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.undoWorkspaceChanges(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose valid changes to undo.' },
        })
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.workspaceArchivePrepare)
    ipcMain.removeHandler(IPC_CHANNELS.workspaceArchiveRead)
    ipcMain.removeHandler(IPC_CHANNELS.workspaceArchiveCancel)
    projectCatalog.dispose()
    ipcMain.removeHandler(IPC_CHANNELS.projectContextRead)
    ipcMain.removeHandler(IPC_CHANNELS.projectDirectoryOpen)
    ipcMain.removeHandler(IPC_CHANNELS.nativeInputRead)
    ipcMain.removeHandler(IPC_CHANNELS.nativeInputRespond)
    ipcMain.removeHandler(IPC_CHANNELS.nativeInputOpen)
    ipcMain.removeHandler(IPC_CHANNELS.nativePermissionRespond)
    ipcMain.removeHandler(IPC_CHANNELS.projectCatalogGet)
    ipcMain.removeHandler(IPC_CHANNELS.projectCatalogChooseAndAdd)
    ipcMain.removeHandler(IPC_CHANNELS.projectCatalogArchive)
    ipcMain.removeHandler(IPC_CHANNELS.projectCatalogRestore)
    ipcMain.removeHandler(IPC_CHANNELS.projectCatalogRename)
    ipcMain.removeHandler(IPC_CHANNELS.sessionCatalogGet)
    ipcMain.removeHandler(IPC_CHANNELS.sessionCreationPrepare)
    ipcMain.removeHandler(IPC_CHANNELS.sessionCreate)
    ipcMain.removeHandler(IPC_CHANNELS.sessionRename)
    ipcMain.removeHandler(IPC_CHANNELS.sessionMarkRead)
    ipcMain.removeHandler(IPC_CHANNELS.sessionArchive)
    ipcMain.removeHandler(IPC_CHANNELS.sessionRestore)
    ipcMain.removeHandler(IPC_CHANNELS.sessionSettingsGet)
    ipcMain.removeHandler(IPC_CHANNELS.sessionSettingsSave)
    ipcMain.removeHandler(IPC_CHANNELS.sessionPermissionSave)
    ipcMain.removeHandler(IPC_CHANNELS.sessionSpeedSave)
    ipcMain.removeHandler(IPC_CHANNELS.projectFileRead)
    ipcMain.removeHandler(IPC_CHANNELS.workspaceChangesRead)
    ipcMain.removeHandler(IPC_CHANNELS.workspaceChangeFileRead)
    ipcMain.removeHandler(IPC_CHANNELS.workspaceChangesUndo)
  }
}
