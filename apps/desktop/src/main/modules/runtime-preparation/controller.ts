import { dialog, type BrowserWindow, type Dialog, type OpenDialogOptions } from 'electron'

import type { RpcResult, RuntimeAgentId, RuntimePreparation } from '@pact/contracts'

import type { UtilityProcessClient } from '../../utility-process/client'

export interface RuntimePreparationController {
  load(): Promise<RpcResult<RuntimePreparation>>
  chooseExecutable(
    agentId: RuntimeAgentId,
    owner?: BrowserWindow,
  ): Promise<RpcResult<RuntimePreparation>>
}

class ElectronRuntimePreparationController implements RuntimePreparationController {
  constructor(
    private readonly utilityClient: UtilityProcessClient,
    private readonly nativeDialog: Dialog,
    private readonly platform: NodeJS.Platform,
  ) {}

  load(): Promise<RpcResult<RuntimePreparation>> {
    return this.utilityClient.getRuntimePreparation()
  }

  async chooseExecutable(
    agentId: RuntimeAgentId,
    owner?: BrowserWindow,
  ): Promise<RpcResult<RuntimePreparation>> {
    const options = this.executableDialogOptions(agentId)
    const selection = owner
      ? await this.nativeDialog.showOpenDialog(owner, options)
      : await this.nativeDialog.showOpenDialog(options)
    const executablePath = selection.filePaths.at(0)
    return executablePath && !selection.canceled
      ? this.utilityClient.updateRuntimeExecutablePath({ agentId, executablePath })
      : this.load()
  }

  private executableDialogOptions(agentId: RuntimeAgentId): OpenDialogOptions {
    return {
      title: `Choose ${agentId === 'claude' ? 'Claude Code' : 'Codex'} executable`,
      properties: ['openFile'],
      ...(this.platform === 'win32'
        ? { filters: [{ name: 'Executable', extensions: ['exe', 'cmd'] }] }
        : {}),
    }
  }
}

export function createRuntimePreparationController(
  utilityClient: UtilityProcessClient,
  nativeDialog: Dialog = dialog,
  platform: NodeJS.Platform = process.platform,
): RuntimePreparationController {
  return new ElectronRuntimePreparationController(utilityClient, nativeDialog, platform)
}
