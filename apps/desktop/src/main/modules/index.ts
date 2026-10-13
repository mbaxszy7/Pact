import type { RendererTrust } from '../renderer-trust'
import type { UtilityProcessClient } from '../utility-process/client'
import type { AppearanceController } from './appearance/controller'

import { registerAppearanceIpcHandlers } from './appearance/ipc'
import { registerConversationIpcHandlers } from './conversation/ipc'
import { registerFoundationIpcHandlers } from './foundation/ipc'
import { createRuntimePreparationController } from './runtime-preparation/controller'
import { registerRuntimePreparationIpcHandlers } from './runtime-preparation/ipc'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { registerWorkspaceIpcHandlers } from './workspace/ipc'
import { createProjectCatalogController } from './workspace/project-catalog-controller'

export function registerDesktopModules(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
  appearance: AppearanceController,
): () => void {
  const runtimePreparation = createRuntimePreparationController(utilityClient)
  const projectCatalog = createProjectCatalogController(utilityClient)
  const disposers = [
    registerFoundationIpcHandlers(trust, utilityClient),
    registerAppearanceIpcHandlers(trust, appearance),
    registerConversationIpcHandlers(trust, utilityClient),
    registerRuntimePreparationIpcHandlers(trust, runtimePreparation),
    registerSettingsIpcHandlers(trust, utilityClient),
    registerWorkspaceIpcHandlers(trust, utilityClient, projectCatalog),
  ]

  return () => {
    for (const dispose of disposers.toReversed()) dispose()
  }
}
