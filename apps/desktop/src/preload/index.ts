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
} from '@pact/contracts'

const bridge: DesktopBridge = {
  setComposerEditingState: (input) => ipcRenderer.invoke(IPC_CHANNELS.composerEditingState, input),
  settleComposerEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.composerEditReceipt, input),
  onComposerEditCommand: (listener) => {
    const changed = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const command = composerEditCommandSchema.safeParse(raw)
      if (command.success) listener(command.data)
    }
    ipcRenderer.on(IPC_CHANNELS.composerEditCommand, changed)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.composerEditCommand, changed)
  },
  getDiagnosticStatus: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticStatus),
  reportRendererFault: (fault) => {
    try {
      ipcRenderer.send(IPC_CHANNELS.rendererFault, fault)
    } catch {
      // Fault diagnostics are best effort and must not create another Renderer error.
    }
  },
  onDiagnosticStatusChanged: (listener) => {
    const changed = (_event: Electron.IpcRendererEvent, input: unknown): void => {
      const status = diagnosticStatusSchema.safeParse(input)
      if (status.success) listener(status.data)
    }
    ipcRenderer.on(IPC_CHANNELS.diagnosticChanged, changed)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.diagnosticChanged, changed)
  },
  forkSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionFork, input),
  readNativeInput: (input) => ipcRenderer.invoke(IPC_CHANNELS.nativeInputRead, input),
  respondNativeInput: (input) => ipcRenderer.invoke(IPC_CHANNELS.nativeInputRespond, input),
  openNativeInputURL: (input) => ipcRenderer.invoke(IPC_CHANNELS.nativeInputOpen, input),
  respondNativePermission: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.nativePermissionRespond, input),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getRuntimeHealth: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeHealth),
  getRuntimePreparation: () => ipcRenderer.invoke(IPC_CHANNELS.runtimePreparationGet),
  chooseRuntimeExecutable: (agentId) =>
    ipcRenderer.invoke(IPC_CHANNELS.runtimeExecutableChoose, agentId),
  getDefaultSessionSettingsEditorState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.defaultSessionSettingsGet),
  saveDefaultSessionSettings: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.defaultSessionSettingsSave, input),
  getProjectCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.projectCatalogGet),
  chooseAndAddProject: () => ipcRenderer.invoke(IPC_CHANNELS.projectCatalogChooseAndAdd),
  archiveProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectCatalogArchive, projectId),
  restoreProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectCatalogRestore, projectId),
  renameProject: async (input) => {
    const result = rpcResultSchema(projectNameChangeSchema).safeParse(
      await ipcRenderer.invoke(IPC_CHANNELS.projectCatalogRename, input),
    )
    return result.success
      ? result.data
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid Project rename response.' } }
  },
  getSessionCatalog: (projectId, cursor) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionCatalogGet, projectId, cursor),
  prepareSessionCreation: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionCreationPrepare, projectId),
  createSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionCreate, input),
  renameSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionRename, input),
  markSessionRead: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionMarkRead, input),
  archiveSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionArchive, sessionId),
  restoreSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionRestore, sessionId),
  getSessionSettings: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionSettingsGet, sessionId),
  saveSessionSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionSettingsSave, input),
  saveSessionPermission: (input) => ipcRenderer.invoke(IPC_CHANNELS.sessionPermissionSave, input),
  cancelSkillCatalog: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.skillCatalogCancel, sessionId),
  readSkillCatalog: (input) => ipcRenderer.invoke(IPC_CHANNELS.skillCatalogRead, input),
  readSkillDocument: (input) => ipcRenderer.invoke(IPC_CHANNELS.skillDocumentRead, input),
  cancelSkillDocument: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.skillDocumentCancel, requestId),
  actOnCollaboration: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationAction, input),
  getConversation: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationGet, input),
  setConversationInterest: (sessionId, generation) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationInterest, { sessionId, generation }),
  writeConversationImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationImageWrite, input),
  chooseConversationImages: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationImageChoose, input),
  readConversationImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationImageRead, input),
  writeConversationInput: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationInput, input),
  sendConversationMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationSend, input),
  stopConversation: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationStop, input),
  acceptPeerProposal: (input) => ipcRenderer.invoke(IPC_CHANNELS.peerProposalAccept, input),
  dismissPeerProposal: (input) => ipcRenderer.invoke(IPC_CHANNELS.peerProposalDismiss, input),
  saveCommentDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.commentDraftSave, input),
  removeCommentDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.commentDraftRemove, input),
  resolveCommentSource: (sessionId, commentId) =>
    ipcRenderer.invoke(IPC_CHANNELS.commentSourceResolve, sessionId, commentId),
  retryConversationRun: (runId, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationRetry, { runId, ...options }),
  rebuildNativeContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.nativeContextRebuild, input),
  readProjectFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectFileRead, input),
  readWorkspaceChanges: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspaceChangesRead, input),
  readWorkspaceChangeFile: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceChangeFileRead, input),
  undoWorkspaceChanges: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspaceChangesUndo, input),
  onConversationChanged: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const patch = conversationPatchSchema.safeParse(payload)
      if (patch.success) listener(patch.data)
    }
    ipcRenderer.on(IPC_CHANNELS.conversationChanged, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.conversationChanged, handleChange)
  },
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.appearanceGet),
  updateAppearanceSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.appearanceUpdate, input),
  resetAppearanceSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.appearanceReset, input),
  onAppearanceSettingsChanged: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const snapshot = appearanceSnapshotSchema.safeParse(payload)
      if (snapshot.success) listener(snapshot.data)
    }

    ipcRenderer.on(IPC_CHANNELS.appearanceChanged, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appearanceChanged, handleChange)
  },
}

if (!process.contextIsolated) {
  throw new Error('Pact requires context isolation')
}

contextBridge.exposeInMainWorld('pact', bridge)
