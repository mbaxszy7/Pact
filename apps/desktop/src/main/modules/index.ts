import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import type { RendererTrust } from '../renderer-trust'
import type { UtilityProcessClient } from '../utility-process/client'
import type { AppearanceController } from './appearance/controller'
import type { NativePresence } from './native-presence'

import { registerAppearanceIpcHandlers } from './appearance/ipc'
import { registerConversationIpcHandlers } from './conversation/ipc'
import { registerFoundationIpcHandlers } from './foundation/ipc'
import { registerProviderUsageIpcHandlers } from './provider-usage/ipc'
import { createRuntimePreparationController } from './runtime-preparation/controller'
import { registerRuntimePreparationIpcHandlers } from './runtime-preparation/ipc'
import { SessionNotificationController } from './session-notifications/controller'
import { registerSessionNotificationIpcHandlers } from './session-notifications/ipc'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { registerWorkspaceIpcHandlers } from './workspace/ipc'
import { createProjectCatalogController } from './workspace/project-catalog-controller'

export function registerDesktopModules(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
  appearance: AppearanceController,
  nativePresence?: NativePresence,
  recordDiagnostic?: (event: DiagnosticEvent) => void,
): () => void {
  const runtimePreparation = createRuntimePreparationController(utilityClient)
  const projectCatalog = createProjectCatalogController(utilityClient)
  const conversation = registerConversationIpcHandlers(trust, utilityClient)
  const sessionNotifications = nativePresence
    ? new SessionNotificationController(
        trust,
        utilityClient,
        nativePresence,
        conversation.isSessionVisible,
        {
          subscribeVisibilityChanges: conversation.subscribeVisibilityChanges,
          ...(recordDiagnostic ? { recordDiagnostic } : {}),
        },
      )
    : undefined
  const disposers = [
    registerFoundationIpcHandlers(trust, utilityClient),
    registerAppearanceIpcHandlers(trust, appearance),
    conversation,
    ...(sessionNotifications
      ? [registerSessionNotificationIpcHandlers(trust, sessionNotifications)]
      : []),
    registerRuntimePreparationIpcHandlers(trust, runtimePreparation),
    registerProviderUsageIpcHandlers(trust, utilityClient),
    registerSettingsIpcHandlers(trust, utilityClient),
    registerWorkspaceIpcHandlers(trust, utilityClient, projectCatalog),
  ]

  return () => {
    for (const dispose of disposers.toReversed()) dispose()
    sessionNotifications?.dispose()
  }
}
