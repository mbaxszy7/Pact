import { dialog, type BrowserWindow, type Dialog, type OpenDialogOptions } from 'electron'

import type { ProjectCatalogState, ProjectNameChange, RpcResult } from '@pact/contracts'

import type { UtilityProcessClient } from '../../utility-process/client'

export interface ProjectCatalogController {
  load(): Promise<RpcResult<ProjectCatalogState>>
  chooseAndAdd(owner?: BrowserWindow): Promise<RpcResult<ProjectCatalogState>>
  archive(projectId: string): Promise<RpcResult<ProjectCatalogState>>
  restore(projectId: string): Promise<RpcResult<ProjectCatalogState>>
  rename(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>>
}

class ElectronProjectCatalogController implements ProjectCatalogController {
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

  archive(projectId: string): Promise<RpcResult<ProjectCatalogState>> {
    return this.utilityClient.archiveProject({ projectId })
  }

  restore(projectId: string): Promise<RpcResult<ProjectCatalogState>> {
    return this.utilityClient.restoreProject({ projectId })
  }

  rename(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>> {
    return this.utilityClient.renameProject(input)
  }
}

export function createProjectCatalogController(
  utilityClient: UtilityProcessClient,
  nativeDialog: Dialog = dialog,
): ProjectCatalogController {
  return new ElectronProjectCatalogController(utilityClient, nativeDialog)
}
