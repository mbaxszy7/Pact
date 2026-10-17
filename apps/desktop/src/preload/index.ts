import { contextBridge, ipcRenderer } from 'electron'

import type { DesktopBridge } from '@pact/contracts'

import {
  appearanceSnapshotSchema,
  conversationPatchSchema,
  diagnosticStatusSchema,
  composerEditCommandSchema,
  IPC_CHANNELS,
  projectNameChangeSchema,
  rpcResultSchema,
  runtimeHealthSchema,
  rendererFaultSchema,
  monacoIpcObservationSchema,
  projectContextSchema,
  projectDirectoryOpenResultSchema,
  workspaceArchivePreviewSchema,
  workspaceArchiveReceiptSchema,
  nativeSessionResolveInputSchema,
  nativeSessionOpenInputSchema,
  nativeAttentionReadInputSchema,
  nativeAttentionPageSchema,
  nativePresenceVersionSchema,
  nativeNavigationIntentSchema,
  nativeNavigationAckInputSchema,
  nativeNavigationAckResultSchema,
  nativeQuitStateSchema,
  nativeQuitDecisionInputSchema,
  nativeQuitDecisionResultSchema,
  nativeSessionOpenedResultSchema,
  sessionCatalogChangeSchema,
} from '@pact/contracts'

import {
  hasLogicalIpcFixtureNonce,
  LogicalIpcTrafficCollector,
  logicalIpcTrafficSnapshot,
} from '../shared/logical-ipc-traffic'

if (!process.contextIsolated) {
  throw new Error('Pact requires context isolation')
}

function observationEpoch(): string | null {
  try {
    return globalThis.crypto?.randomUUID?.() ?? null
  } catch {
    return null
  }
}
const traffic =
  hasLogicalIpcFixtureNonce(process.env) && process.env.PACT_E2E_ROOT
    ? new LogicalIpcTrafficCollector('renderer-bridge', observationEpoch())
    : undefined
const monacoTraffic = traffic
  ? new LogicalIpcTrafficCollector('renderer-monaco', observationEpoch())
  : undefined
const controlChannels = new Set<string>([
  IPC_CHANNELS.runtimeHealth,
  IPC_CHANNELS.appInfo,
  IPC_CHANNELS.diagnosticStatus,
])
const eventCleanup: (() => void)[] = []

// ContextBridge has already copied/frozen these named API arguments into the isolated world.
// Replies are observed after Electron's actual structured-clone receive. Routing channel/native
// event metadata are not application DTO bytes; the invoke argument list is one logical array.
const invoke: typeof ipcRenderer.invoke = (channel, ...args) => {
  if (!traffic) return ipcRenderer.invoke(channel, ...args)
  const lane = controlChannels.has(channel) ? 'control' : 'business'
  let pending: ReturnType<typeof ipcRenderer.invoke>
  try {
    pending = ipcRenderer.invoke(channel, ...args)
    traffic.record('renderer-main.invoke', lane, args)
  } catch (error) {
    traffic.invalidate('transport_error')
    throw error
  }
  // Settlement callbacks capture only metadata, not the request arguments during an RPC wait.
  return pending.then(
    (result) => {
      traffic.record('main-renderer.reply', lane, result)
      return result
    },
    (error: unknown) => {
      traffic.invalidate('transport_error')
      throw error
    },
  )
}

function eventSubscription<T>(
  channel: string,
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false }
  },
  lane: 'business' | 'control',
): (listener: (input: T) => void) => () => void {
  if (traffic) {
    // Seven fixed observation taps own no consumer registry. Actual business
    // registrations keep Electron's duplicate and dispatch-snapshot semantics.
    const observe = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      try {
        if (schema.safeParse(raw).success) traffic.record('main-renderer.event', lane, raw)
        else traffic.invalidate('unvalidated_message')
      } catch {
        traffic.invalidate('unvalidated_message')
      }
    }
    ipcRenderer.on(channel, observe)
    eventCleanup.push(() => ipcRenderer.removeListener(channel, observe))
  }
  return (listener) => {
    const handle = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const parsed = schema.safeParse(raw)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(channel, handle)
    return () => ipcRenderer.removeListener(channel, handle)
  }
}

const onComposerEditCommand = eventSubscription(
  IPC_CHANNELS.composerEditCommand,
  composerEditCommandSchema,
  'business',
)
const onDiagnosticStatusChanged = eventSubscription(
  IPC_CHANNELS.diagnosticChanged,
  diagnosticStatusSchema,
  'control',
)
const onConversationChanged = eventSubscription(
  IPC_CHANNELS.conversationChanged,
  conversationPatchSchema,
  'business',
)
const onAppearanceSettingsChanged = eventSubscription(
  IPC_CHANNELS.appearanceChanged,
  appearanceSnapshotSchema,
  'business',
)

if (traffic) {
  const add: unknown = Reflect.get(globalThis, 'addEventListener')
  if (typeof add === 'function')
    Reflect.apply(add, globalThis, [
      'unload',
      () => {
        for (const cleanup of eventCleanup) cleanup()
        eventCleanup.length = 0
        traffic.dispose()
        monacoTraffic?.dispose()
      },
      { once: true },
    ])
  else traffic.invalidate('cleanup_unavailable')
}

const onNativePresenceChanged = eventSubscription(
  IPC_CHANNELS.nativePresenceChanged,
  nativePresenceVersionSchema,
  'business',
)

const onNativeNavigationChanged = eventSubscription(
  IPC_CHANNELS.nativeNavigationChanged,
  nativeNavigationIntentSchema,
  'business',
)

const onNativeQuitStateChanged = eventSubscription(
  IPC_CHANNELS.nativeQuitChanged,
  nativeQuitStateSchema.nullable(),
  'business',
)

const bridge: DesktopBridge = {
  resolveNativeSession: async (input) =>
    rpcResultSchema(sessionCatalogChangeSchema).parse(
      await invoke(IPC_CHANNELS.nativeSessionResolve, nativeSessionResolveInputSchema.parse(input)),
    ),
  recordNativeSessionOpened: async (input) =>
    rpcResultSchema(nativeSessionOpenedResultSchema).parse(
      await invoke(IPC_CHANNELS.nativeSessionOpened, nativeSessionOpenInputSchema.parse(input)),
    ),
  readNativeAttention: async (input) =>
    rpcResultSchema(nativeAttentionPageSchema).parse(
      await invoke(IPC_CHANNELS.nativeAttentionRead, nativeAttentionReadInputSchema.parse(input)),
    ),
  onNativePresenceChanged,
  getNativeNavigation: async () =>
    rpcResultSchema(nativeNavigationIntentSchema.nullable()).parse(
      await invoke(IPC_CHANNELS.nativeNavigationGet),
    ),
  acknowledgeNativeNavigation: async (input) =>
    rpcResultSchema(nativeNavigationAckResultSchema).parse(
      await invoke(IPC_CHANNELS.nativeNavigationAck, nativeNavigationAckInputSchema.parse(input)),
    ),
  onNativeNavigationChanged,
  getNativeQuitState: async () =>
    rpcResultSchema(nativeQuitStateSchema.nullable()).parse(
      await invoke(IPC_CHANNELS.nativeQuitGet),
    ),
  respondNativeQuit: async (input) =>
    rpcResultSchema(nativeQuitDecisionResultSchema).parse(
      await invoke(IPC_CHANNELS.nativeQuitRespond, nativeQuitDecisionInputSchema.parse(input)),
    ),
  onNativeQuitStateChanged,
  prepareWorkspaceArchive: async (input) =>
    rpcResultSchema(workspaceArchivePreviewSchema).parse(
      await invoke(IPC_CHANNELS.workspaceArchivePrepare, input),
    ),
  readWorkspaceArchive: async (input) =>
    rpcResultSchema(workspaceArchiveReceiptSchema).parse(
      await invoke(IPC_CHANNELS.workspaceArchiveRead, input),
    ),
  cancelWorkspaceArchive: async (input) =>
    rpcResultSchema(workspaceArchiveReceiptSchema).parse(
      await invoke(IPC_CHANNELS.workspaceArchiveCancel, input),
    ),
  ...(monacoTraffic
    ? {
        observeMonacoWorkerTraffic: (
          input: import('@pact/contracts').MonacoIpcObservation,
        ): void => {
          const parsed = monacoIpcObservationSchema.safeParse(input)
          if (!parsed.success) {
            monacoTraffic.invalidate('unvalidated_message')
            return
          }
          if (parsed.data.type === 'message')
            monacoTraffic.recordMeasurement(
              parsed.data.category,
              'business',
              parsed.data.measurement,
            )
          else if (parsed.data.type === 'created') {
            monacoTraffic.beginTransport()
            monacoTraffic.invalidate('cleanup_unavailable') // No Browser API acknowledges physical Worker settlement.
          } else if (parsed.data.type === 'transport-error')
            monacoTraffic.invalidate('transport_error')
          else monacoTraffic.invalidate('cleanup_unavailable') // Browser terminate() has no physical settlement receipt.
        },
      }
    : {}),
  setComposerEditingState: (input) => invoke(IPC_CHANNELS.composerEditingState, input),
  settleComposerEdit: (input) => invoke(IPC_CHANNELS.composerEditReceipt, input),
  onComposerEditCommand,
  getDiagnosticStatus: () => invoke(IPC_CHANNELS.diagnosticStatus),
  reportRendererFault: (fault) => {
    try {
      ipcRenderer.send(IPC_CHANNELS.rendererFault, fault)
      if (traffic) {
        if (rendererFaultSchema.safeParse(fault).success)
          traffic.record('renderer-main.send', 'control', [fault])
        else traffic.invalidate('unvalidated_message')
      }
    } catch {
      traffic?.invalidate('transport_error')
      // Fault diagnostics are best effort and must not create another Renderer error.
    }
  },
  onDiagnosticStatusChanged,
  forkSession: (input) => invoke(IPC_CHANNELS.sessionFork, input),
  readNativeInput: (input) => invoke(IPC_CHANNELS.nativeInputRead, input),
  respondNativeInput: (input) => invoke(IPC_CHANNELS.nativeInputRespond, input),
  openNativeInputURL: (input) => invoke(IPC_CHANNELS.nativeInputOpen, input),
  respondNativePermission: (input) => invoke(IPC_CHANNELS.nativePermissionRespond, input),
  getAppInfo: () => invoke(IPC_CHANNELS.appInfo),
  getRuntimeHealth: async () => {
    const raw = await invoke(IPC_CHANNELS.runtimeHealth)
    if (!traffic) return raw
    const parsed = rpcResultSchema(runtimeHealthSchema).safeParse(raw)
    if (!parsed.success) {
      traffic.invalidate('unvalidated_message')
      return raw
    }
    if (!parsed.data.ok || !parsed.data.value.ipcTraffic) return raw
    const observation = parsed.data.value.ipcTraffic
    return {
      ...parsed.data,
      value: {
        ...parsed.data.value,
        ipcTraffic: logicalIpcTrafficSnapshot(traffic.snapshot(), [
          ...observation.owners.filter(
            (owner) => owner.owner !== 'renderer-bridge' && owner.owner !== 'renderer-monaco',
          ),
          ...(monacoTraffic ? [monacoTraffic.snapshot()] : []),
        ]),
      },
    }
  },
  getRuntimePreparation: () => invoke(IPC_CHANNELS.runtimePreparationGet),
  chooseRuntimeExecutable: (agentId) => invoke(IPC_CHANNELS.runtimeExecutableChoose, agentId),
  getDefaultSessionSettingsEditorState: () => invoke(IPC_CHANNELS.defaultSessionSettingsGet),
  saveDefaultSessionSettings: (input) => invoke(IPC_CHANNELS.defaultSessionSettingsSave, input),
  getProjectCatalog: () => invoke(IPC_CHANNELS.projectCatalogGet),
  readProjectContext: async (input) => {
    const result = rpcResultSchema(projectContextSchema).safeParse(
      await invoke(IPC_CHANNELS.projectContextRead, input),
    )
    return result.success
      ? result.data
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid project context response.' } }
  },
  openProjectDirectory: async (input) => {
    const result = rpcResultSchema(projectDirectoryOpenResultSchema).safeParse(
      await invoke(IPC_CHANNELS.projectDirectoryOpen, input),
    )
    return result.success
      ? result.data
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid folder open response.' } }
  },
  chooseAndAddProject: () => invoke(IPC_CHANNELS.projectCatalogChooseAndAdd),
  archiveProject: (projectId, operationId) =>
    invoke(IPC_CHANNELS.projectCatalogArchive, projectId, operationId),
  restoreProject: (projectId) => invoke(IPC_CHANNELS.projectCatalogRestore, projectId),
  renameProject: async (input) => {
    const result = rpcResultSchema(projectNameChangeSchema).safeParse(
      await invoke(IPC_CHANNELS.projectCatalogRename, input),
    )
    return result.success
      ? result.data
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid Project rename response.' } }
  },
  getSessionCatalog: (projectId, cursor) =>
    invoke(IPC_CHANNELS.sessionCatalogGet, projectId, cursor),
  prepareSessionCreation: (projectId) => invoke(IPC_CHANNELS.sessionCreationPrepare, projectId),
  createSession: (input) => invoke(IPC_CHANNELS.sessionCreate, input),
  renameSession: (input) => invoke(IPC_CHANNELS.sessionRename, input),
  markSessionRead: (input) => invoke(IPC_CHANNELS.sessionMarkRead, input),
  archiveSession: (sessionId, operationId) =>
    invoke(IPC_CHANNELS.sessionArchive, sessionId, operationId),
  restoreSession: (sessionId) => invoke(IPC_CHANNELS.sessionRestore, sessionId),
  getSessionSettings: (sessionId) => invoke(IPC_CHANNELS.sessionSettingsGet, sessionId),
  saveSessionSettings: (input) => invoke(IPC_CHANNELS.sessionSettingsSave, input),
  saveSessionPermission: (input) => invoke(IPC_CHANNELS.sessionPermissionSave, input),
  cancelSkillCatalog: (sessionId) => invoke(IPC_CHANNELS.skillCatalogCancel, sessionId),
  readSkillCatalog: (input) => invoke(IPC_CHANNELS.skillCatalogRead, input),
  readSkillDocument: (input) => invoke(IPC_CHANNELS.skillDocumentRead, input),
  cancelSkillDocument: (requestId) => invoke(IPC_CHANNELS.skillDocumentCancel, requestId),
  actOnCollaboration: (input) => invoke(IPC_CHANNELS.collaborationAction, input),
  getConversation: (input) => invoke(IPC_CHANNELS.conversationGet, input),
  setConversationInterest: (sessionId, generation) =>
    invoke(IPC_CHANNELS.conversationInterest, { sessionId, generation }),
  writeConversationImage: (input) => invoke(IPC_CHANNELS.conversationImageWrite, input),
  chooseConversationImages: (input) => invoke(IPC_CHANNELS.conversationImageChoose, input),
  readConversationImage: (input) => invoke(IPC_CHANNELS.conversationImageRead, input),
  writeConversationInput: (input) => invoke(IPC_CHANNELS.conversationInput, input),
  sendConversationMessage: (input) => invoke(IPC_CHANNELS.conversationSend, input),
  stopConversation: (input) => invoke(IPC_CHANNELS.conversationStop, input),
  acceptPeerProposal: (input) => invoke(IPC_CHANNELS.peerProposalAccept, input),
  dismissPeerProposal: (input) => invoke(IPC_CHANNELS.peerProposalDismiss, input),
  saveCommentDraft: (input) => invoke(IPC_CHANNELS.commentDraftSave, input),
  removeCommentDraft: (input) => invoke(IPC_CHANNELS.commentDraftRemove, input),
  resolveCommentSource: (sessionId, commentId) =>
    invoke(IPC_CHANNELS.commentSourceResolve, sessionId, commentId),
  retryConversationRun: (runId, options) =>
    invoke(IPC_CHANNELS.conversationRetry, { runId, ...options }),
  rebuildNativeContext: (input) => invoke(IPC_CHANNELS.nativeContextRebuild, input),
  readProjectFile: (input) => invoke(IPC_CHANNELS.projectFileRead, input),
  readWorkspaceChanges: (input) => invoke(IPC_CHANNELS.workspaceChangesRead, input),
  readWorkspaceChangeFile: (input) => invoke(IPC_CHANNELS.workspaceChangeFileRead, input),
  undoWorkspaceChanges: (input) => invoke(IPC_CHANNELS.workspaceChangesUndo, input),
  onConversationChanged,
  getAppearanceSettings: () => invoke(IPC_CHANNELS.appearanceGet),
  updateAppearanceSettings: (input) => invoke(IPC_CHANNELS.appearanceUpdate, input),
  resetAppearanceSettings: (input) => invoke(IPC_CHANNELS.appearanceReset, input),
  onAppearanceSettingsChanged,
}

contextBridge.exposeInMainWorld('pact', bridge)
