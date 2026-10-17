import { dialog, shell, type BrowserWindow, type Dialog, type OpenDialogOptions } from 'electron'
import { sep } from 'node:path'

import type {
  ProjectCatalogState,
  ProjectNameChange,
  ProjectContextInput,
  RpcResult,
} from '@pact/contracts'

import type { UtilityProcessClient } from '../../utility-process/client'

export interface ProjectCatalogController {
  load(): Promise<RpcResult<ProjectCatalogState>>
  chooseAndAdd(owner?: BrowserWindow): Promise<RpcResult<ProjectCatalogState>>
  archive(projectId: string, operationId?: string): Promise<RpcResult<ProjectCatalogState>>
  restore(projectId: string): Promise<RpcResult<ProjectCatalogState>>
  rename(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>>
  openDirectory(
    input: ProjectContextInput,
    confirmTrust: () => void,
  ): Promise<RpcResult<{ opened: true }>>
  dispose(): void
}

class ElectronProjectCatalogController implements ProjectCatalogController {
  private opening = false
  private disposed = false
  private openDeadline: ReturnType<typeof setTimeout> | undefined
  private cancelOpen: (() => void) | undefined
  constructor(
    private readonly utilityClient: UtilityProcessClient,
    private readonly nativeDialog: Dialog,
  ) {}

  load(): Promise<RpcResult<ProjectCatalogState>> {
    return this.utilityClient.getProjectCatalog()
  }

  async chooseAndAdd(owner?: BrowserWindow): Promise<RpcResult<ProjectCatalogState>> {
    const options: OpenDialogOptions = {
      title: 'Add a project',
      buttonLabel: 'Add project',
      properties: ['openDirectory'],
    }
    const selection = owner
      ? await this.nativeDialog.showOpenDialog(owner, options)
      : await this.nativeDialog.showOpenDialog(options)
    const directoryPath = selection.filePaths.at(0)
    return directoryPath && !selection.canceled
      ? this.utilityClient.addProjectDirectory({ directoryPath })
      : this.load()
  }

  archive(projectId: string, operationId?: string): Promise<RpcResult<ProjectCatalogState>> {
    return this.utilityClient.archiveProject({ projectId, ...(operationId ? { operationId } : {}) })
  }

  restore(projectId: string): Promise<RpcResult<ProjectCatalogState>> {
    return this.utilityClient.restoreProject({ projectId })
  }

  rename(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>> {
    return this.utilityClient.renameProject(input)
  }

  async openDirectory(
    input: ProjectContextInput,
    confirmTrust: () => void,
  ): Promise<RpcResult<{ opened: true }>> {
    if (this.opening || this.disposed)
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'A folder is already opening. Try again shortly.',
        },
      }
    this.opening = true
    try {
      const context = await this.utilityClient.readProjectContext(input)
      if (!context.ok) return context
      if (this.disposed) throw new Error('Project catalog closed.')
      confirmTrust()
      return await new Promise<RpcResult<{ opened: true }>>((resolve) => {
        const fail = (): void =>
          resolve({
            ok: false,
            error: {
              code: 'INTERNAL',
              message: 'Couldn’t open the project folder. Try copying its path instead.',
            },
          })
        this.cancelOpen = fail
        this.openDeadline = setTimeout(fail, 5_000)
        void shell
          .openPath(`${context.value.directoryPath}${sep}`)
          .then((error) => (error ? fail() : resolve({ ok: true, value: { opened: true } })), fail)
          .finally(() => {
            clearTimeout(this.openDeadline)
            this.openDeadline = undefined
            this.cancelOpen = undefined
            this.opening = false
          })
      })
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Couldn’t open the project folder.' },
      }
    } finally {
      // A timed-out native launch retains its physical slot until shell.openPath settles.
      if (!this.cancelOpen) this.opening = false
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.openDeadline)
    this.openDeadline = undefined
    this.cancelOpen?.()
  }
}

export function createProjectCatalogController(
  utilityClient: UtilityProcessClient,
  nativeDialog: Dialog = dialog,
): ProjectCatalogController {
  return new ElectronProjectCatalogController(utilityClient, nativeDialog)
}
