import { z } from 'zod'

import type { DiagnosticStatus, RendererFault } from './diagnostics.js'

import {
  commentDraftRemoveInputSchema,
  commentDraftSaveInputSchema,
  commentSourceResolutionSchema,
  type CommentDraftRemoveInput,
  type CommentDraftSaveInput,
  type CommentSourceResolution,
} from './anchored-comments.js'
import {
  updateStoredStateSchema,
  updatePreferencesInputSchema,
  updateNoticeInputSchema,
  updateNoticeResultSchema,
  type UpdateState,
  type UpdatePreferencesInput,
} from './app-updates.js'
import { collaborationActionInputSchema } from './collaboration.js'
import {
  moveSessionGroupInputSchema,
  dissolveSessionGroupInputSchema,
  setSessionGroupInputSchema,
  sessionGroupMutationSchema,
  sessionCreationPrepareInputSchema,
  sessionCreateInputSchema,
  sessionSettingsInputSchema,
  sessionArchiveInputSchema,
  sessionSidebarHiddenInputSchema,
  sessionRenameInputSchema,
  sessionMarkReadInputSchema,
  sessionSettingsEditorStateSchema,
  sessionSettingsSaveResultSchema,
  sessionSettingsSaveInputSchema,
  sessionPermissionSaveInputSchema,
  sessionSpeedSaveInputSchema,
  sessionForkInputSchema,
  sessionForkResultSchema,
  conversationQueueActionInputSchema,
  conversationQueueReturnInputSchema,
  conversationQueueEnabledInputSchema,
  conversationInterestsSchema,
  sessionNotificationEventSchema,
  conversationGetInputSchema,
  conversationPageSchema,
  conversationPatchSchema,
  conversationInputWriteSchema,
  conversationInputStateSchema,
  conversationSendInputSchema,
  peerProposalAcceptInputSchema,
  peerProposalDismissInputSchema,
  conversationRetryInputSchema,
  conversationStopInputSchema,
  nativeContextRebuildInputSchema,
  projectFileReadInputSchema,
  projectFileSchema,
  workspaceChangeFilePreviewSchema,
  appearanceSettingsSchema,
  appearanceSettingsUpdateSchema,
  appearanceSettingsResetSchema,
  type MoveSessionGroupInput,
  type DissolveSessionGroupInput,
  type SetSessionGroupInput,
  type SessionGroupMutation,
  type SessionCreateInput,
  type SessionSidebarHiddenInput,
  type SessionRenameInput,
  type SessionMarkReadInput,
  type SessionSettingsEditorState,
  type SessionSettingsSaveResult,
  type SessionSettingsSaveInput,
  type SessionPermissionSaveInput,
  type SessionSpeedSaveInput,
  type SessionForkInput,
  type SessionForkResult,
  type ConversationQueueActionInput,
  type ConversationQueueReturnInput,
  type ConversationQueueEnabledInput,
  type SessionReminderState,
  type SessionReminderAction,
  type SessionReminderActionResult,
  type ConversationGetInput,
  type ConversationPage,
  type ConversationPatch,
  type ConversationInputWrite,
  type ConversationInputState,
  type ConversationSendInput,
  type PeerProposalAcceptInput,
  type PeerProposalDismissInput,
  type ConversationRetryInput,
  type ConversationStopInput,
  type NativeContextRebuildInput,
  type ProjectFileReadInput,
  type ProjectFile,
  type WorkspaceChangeFilePreview,
  type AppearanceSettingsUpdate,
  type AppearanceSettingsReset,
  type AppearanceSnapshot,
} from './conversation-contracts.js'
import {
  conversationImagesSchema,
  imageWriteInputSchema,
  imageWriteStateSchema,
  imageReadInputSchema,
  imageReadPartSchema,
} from './images.js'
import {
  rpcResultSchema,
  runtimeHealthSchema,
  type RpcResult,
  type AppInfo,
  type MonacoIpcObservation,
  type RuntimeHealth,
} from './ipc-and-health.js'
import {
  nativePermissionRespondInputSchema,
  type NativePermissionRespondInput,
} from './native-permissions.js'
import {
  nativePresenceSnapshotSchema,
  nativePresenceVersionSchema,
  nativeSessionRowSchema,
  NATIVE_MENU_ITEMS,
  nativeAttentionReadInputSchema,
  nativeAttentionPageSchema,
  nativeSessionResolveInputSchema,
  nativeSessionOpenInputSchema,
  nativeJumpListSuppressionInputSchema,
  nativeSessionOpenedResultSchema,
  nativeJumpListSuppressionResultSchema,
  nativeQuitOperationInputSchema,
  nativeQuitPreparationSchema,
  nativeQuitCancelledResultSchema,
  type NativePresenceVersion,
  type NativeAttentionReadInput,
  type NativeAttentionPage,
  type NativeSessionResolveInput,
  type NativeSessionOpenInput,
  type NativeQuitState,
  type NativeQuitDecisionInput,
  type NativeNavigationIntent,
  type NativeNavigationAckInput,
} from './native-presence.js'
import {
  nativeInputReadSchema,
  nativeInputRespondSchema,
  nativeInteractionDetailsSchema,
  type NativeInputRead,
  type NativeInputRespond,
  type NativeInteractionDetails,
} from './native-user-input.js'
import { preparedInputContinueSchema, type PreparedInputContinue } from './prepared-input.js'
import {
  providerUsageCancelResultSchema,
  providerUsageReadInputSchema,
  providerUsageReadyResultSchema,
  providerUsageReleaseOwnerInputSchema,
  providerUsageSnapshotSchema,
  providerUsageUtilityCancelInputSchema,
  providerUsageUtilityRefreshInputSchema,
  type ProviderUsageCancelInput,
  type ProviderUsageCancelResult,
  type ProviderUsageReadInput,
  type ProviderUsageRefreshInput,
  type ProviderUsageSnapshot,
} from './provider-usage.js'
import {
  relayCredentialWriteSchema,
  relayCredentialReceiptSchema,
  relayCredentialReceiptReadSchema,
  relayCredentialRevealSchema,
  relayCredentialStoredSchema,
  type RelayCredentialSave,
  type RelayCredentialRemove,
  type RelayCredentialReceiptRead,
  type RelayCredentialReceipt,
  type RelayCredentialReveal,
  type RelayCredentialRevealed,
} from './relay-credential.js'
import {
  relayDecisionAnswerSchema,
  relayDecisionReceiptReadSchema,
  relayDecisionReceiptSchema,
} from './relay-decisions.js'
import {
  runtimePreparationSchema,
  runtimePreparationGetInputSchema,
  runtimeExecutablePathUpdateSchema,
  defaultSessionSettingsStateSchema,
  defaultSessionSettingsGetInputSchema,
  defaultSessionSettingsEditorStateSchema,
  defaultSessionSettingsSaveInputSchema,
  projectCatalogStateSchema,
  projectDirectoryAddInputSchema,
  projectArchiveInputSchema,
  projectContextInputSchema,
  projectContextSchema,
  projectNameChangeSchema,
  sessionCatalogPageInputSchema,
  sessionCatalogChangeSchema,
  sessionCatalogReplySchema,
  sessionPageInputSchema,
  sessionPageSchema,
  sessionGroupPageInputSchema,
  sessionGroupPageSchema,
  sessionGroupDetailInputSchema,
  sessionGroupDetailSchema,
  sessionMembershipInputSchema,
  sessionMembershipSchema,
  locateSessionNavigationInputSchema,
  locatedSessionNavigationSchema,
  sessionCreationStateInputSchema,
  sessionCreationStateSchema,
  createSessionGroupInputSchema,
  updateSessionGroupInputSchema,
  type RuntimeAgentId,
  type RuntimePreparation,
  type RuntimePreparationGetInput,
  type DefaultSessionSettingsState,
  type ActiveAgentPairInput,
  type DefaultSessionSettingsEditorState,
  type DefaultSessionSettingsSaveInput,
  type ProjectCatalogState,
  type ProjectContextInput,
  type ProjectContext,
  type ProjectNameChange,
  type SessionCatalogCursor,
  type SessionCatalogPage,
  type SessionCatalogChange,
  type SessionPageInput,
  type SessionPage,
  type SessionGroupPageInput,
  type SessionGroupPage,
  type SessionGroupDetailInput,
  type SessionGroupDetail,
  type SessionMembershipInput,
  type SessionMembership,
  type LocateSessionNavigationInput,
  type LocatedSessionNavigation,
  type SessionCreationStateInput,
  type SessionCreationState,
  type CreateSessionGroupInput,
  type UpdateSessionGroupInput,
} from './runtime-and-sessions.js'
import {
  schedulingSettingsSchema,
  schedulingSettingsSaveSchema,
  schedulingStateSchema,
  schedulingStateInputSchema,
  schedulingActivityReadSchema,
  schedulingActivityPageSchema,
  type SchedulingSettings,
  type SchedulingSettingsSave,
  type SchedulingState,
  type SchedulingStateInput,
  type SchedulingActivityRead,
  type SchedulingActivityPage,
} from './scheduling-settings.js'
import {
  createSideChatInputSchema,
  createSideChatReceiptSchema,
  discardEmptySideChatInputSchema,
  discardEmptySideChatResultSchema,
  listSideChatsInputSchema,
  listSideChatsPageSchema,
  readSideChatReceiptInputSchema,
  sideChatSyncMainInputSchema,
  sideChatSyncMainReceiptSchema,
  type CreateSideChatInput,
  type CreateSideChatReceipt,
  type DiscardEmptySideChatInput,
  type DiscardEmptySideChatResult,
  type ListSideChatsInput,
  type ListSideChatsPage,
  type ReadSideChatReceiptInput,
  type SideChatSyncMainInput,
  type SideChatSyncMainReceipt,
} from './side-chats.js'
import {
  skillCatalogReadSchema,
  skillCatalogPageSchema,
  skillDocumentReadSchema,
  skillDocumentSchema,
} from './skills.js'
import {
  MAX_TOTAL_TERMINALS,
  terminalCloseInputSchema,
  terminalCloseResultSchema,
  terminalCreateInputSchema,
  terminalListInputSchema,
  terminalListResultSchema,
  terminalOutputEventSchema,
  terminalResizeInputSchema,
  terminalResizeResultSchema,
  terminalSnapshotInputSchema,
  terminalSnapshotResultSchema,
  terminalStateEventSchema,
  terminalSummarySchema,
  terminalVisibilityInputSchema,
  terminalVisibilityResultSchema,
  terminalWriteInputSchema,
  terminalWriteResultSchema,
  type TerminalAckOutputInput,
  type TerminalAckOutputResult,
  type TerminalCloseInput,
  type TerminalCloseResult,
  type TerminalCreateInput,
  type TerminalLastExitNotice,
  type TerminalListInput,
  type TerminalListResult,
  type TerminalOutputEvent,
  type TerminalReleaseProjectViewsInput,
  type TerminalReleaseProjectViewsResult,
  type TerminalResizeInput,
  type TerminalResizeResult,
  type TerminalSnapshotInput,
  type TerminalSnapshotResult,
  type TerminalStateEvent,
  type TerminalSubscribeInput,
  type TerminalSubscribeResult,
  type TerminalSummary,
  type TerminalUnsubscribeInput,
  type TerminalUnsubscribeResult,
  type TerminalWriteInput,
  type TerminalWriteResult,
} from './terminal.js'
import {
  workspaceArchivePrepareInputSchema,
  workspaceArchiveOperationInputSchema,
  workspaceArchivePreviewSchema,
  workspaceArchiveReceiptSchema,
  type WorkspaceArchivePrepareInput,
  type WorkspaceArchiveOperationInput,
  type WorkspaceArchivePreview,
  type WorkspaceArchiveReceipt,
} from './workspace-archive.js'
import {
  workspaceChangeFileReadInputSchema,
  workspaceChangesReadInputSchema,
  workspaceChangesPageSchema,
  workspaceChangesUndoInputSchema,
  type WorkspaceChangeFileReadInput,
  type WorkspaceChangesReadInput,
  type WorkspaceChangesPage,
  type WorkspaceChangesUndoInput,
} from './workspace-changes.js'

export const utilityRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('conversation.prepared-input.continue.request'),
    requestId: z.string().uuid(),
    input: preparedInputContinueSchema,
  }),
  z.strictObject({
    type: z.literal('relay.decision.answer.request'),
    requestId: z.string().uuid(),
    input: relayDecisionAnswerSchema,
  }),
  z.strictObject({
    type: z.literal('relay.decision.receipt.request'),
    requestId: z.string().uuid(),
    input: relayDecisionReceiptReadSchema,
  }),
  z.strictObject({
    type: z.literal('scheduling.state.get.request'),
    requestId: z.string().uuid(),
    input: schedulingStateInputSchema,
  }),

  z.strictObject({
    type: z.literal('scheduling.settings.get.request'),
    requestId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('scheduling.settings.save.request'),
    requestId: z.string().uuid(),
    input: schedulingSettingsSaveSchema,
  }),

  z.strictObject({
    type: z.literal('relay.credential.write.request'),
    requestId: z.string().uuid(),
    input: relayCredentialWriteSchema,
  }),
  z.strictObject({
    type: z.literal('relay.credential.receipt.read.request'),
    requestId: z.string().uuid(),
    input: relayCredentialReceiptReadSchema,
  }),
  z.strictObject({
    type: z.literal('relay.credential.read.request'),
    requestId: z.string().uuid(),
    input: relayCredentialRevealSchema,
  }),
  z.strictObject({
    type: z.literal('scheduling.activity.read.request'),
    requestId: z.string().uuid(),
    input: schedulingActivityReadSchema,
  }),
  z.strictObject({ type: z.literal('updates.get.request'), requestId: z.string().uuid() }),
  z.strictObject({ type: z.literal('updates.check.request'), requestId: z.string().uuid() }),
  z.strictObject({
    type: z.literal('updates.preferences.request'),
    requestId: z.string().uuid(),
    input: updatePreferencesInputSchema,
  }),
  z.strictObject({
    type: z.literal('updates.notice.request'),
    requestId: z.string().uuid(),
    input: updateNoticeInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.prepare.request'),
    requestId: z.string().uuid(),
    input: workspaceArchivePrepareInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.read.request'),
    requestId: z.string().uuid(),
    input: workspaceArchiveOperationInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.cancel.request'),
    requestId: z.string().uuid(),
    input: workspaceArchiveOperationInputSchema,
  }),
  z.object({
    type: z.literal('skill-document.read.request'),
    requestId: z.string().uuid(),
    input: skillDocumentReadSchema,
  }),
  z.object({
    type: z.literal('skill-document.cancel.request'),
    requestId: z.string().uuid(),
    input: z.object({ requestId: z.string().uuid() }),
  }),
  z.object({
    type: z.literal('session.fork.request'),
    requestId: z.string().uuid(),
    input: sessionForkInputSchema,
  }),
  z.object({
    type: z.literal('conversation.interests.request'),
    requestId: z.string().uuid(),
    input: conversationInterestsSchema,
  }),
  z.object({
    type: z.literal('runtime.shutdown.request'),
    requestId: z.string().uuid(),
    flushDeadlineAt: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({ type: z.literal('native-presence.read.request'), requestId: z.string().uuid() }),
  z.object({
    type: z.literal('native-attention.read.request'),
    requestId: z.string().uuid(),
    input: nativeAttentionReadInputSchema,
  }),
  z.object({
    type: z.literal('native-session.resolve.request'),
    requestId: z.string().uuid(),
    input: nativeSessionResolveInputSchema,
  }),
  z.object({
    type: z.literal('native-session.opened.request'),
    requestId: z.string().uuid(),
    input: nativeSessionOpenInputSchema,
  }),
  z.object({
    type: z.literal('native-jump-list.suppression.request'),
    requestId: z.string().uuid(),
    input: nativeJumpListSuppressionInputSchema,
  }),
  z.object({
    type: z.literal('native-quit.prepare.request'),
    requestId: z.string().uuid(),
    input: nativeQuitOperationInputSchema,
  }),
  z.object({
    type: z.literal('native-quit.cancel.request'),
    requestId: z.string().uuid(),
    input: nativeQuitOperationInputSchema,
  }),
  z.object({
    type: z.literal('runtime.health.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('comment-draft.save.request'),
    requestId: z.string().uuid(),
    input: commentDraftSaveInputSchema,
  }),
  z.object({
    type: z.literal('comment-draft.remove.request'),
    requestId: z.string().uuid(),
    input: commentDraftRemoveInputSchema,
  }),
  z.object({
    type: z.literal('comment-source.resolve.request'),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    commentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('appearance.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('appearance.update.request'),
    requestId: z.string().uuid(),
    input: appearanceSettingsUpdateSchema,
  }),
  z.object({
    type: z.literal('appearance.reset.request'),
    requestId: z.string().uuid(),
    input: appearanceSettingsResetSchema,
  }),
  z.object({
    type: z.literal('runtime-preparation.get.request'),
    requestId: z.string().uuid(),
    input: runtimePreparationGetInputSchema.optional(),
  }),
  z.object({
    type: z.literal('runtime-preparation.path.update.request'),
    requestId: z.string().uuid(),
    input: runtimeExecutablePathUpdateSchema,
  }),
  z.object({
    type: z.literal('default-session-settings.get.request'),
    requestId: z.string().uuid(),
    input: defaultSessionSettingsGetInputSchema.optional(),
  }),
  z.object({
    type: z.literal('default-session-settings.save.request'),
    requestId: z.string().uuid(),
    input: defaultSessionSettingsSaveInputSchema,
  }),
  z.strictObject({
    type: z.literal('provider-usage.get.request'),
    requestId: z.string().uuid(),
    input: providerUsageReadInputSchema,
  }),
  z.strictObject({
    type: z.literal('provider-usage.refresh.request'),
    requestId: z.string().uuid(),
    input: providerUsageUtilityRefreshInputSchema,
  }),
  z.strictObject({
    type: z.literal('provider-usage.cancel.request'),
    requestId: z.string().uuid(),
    input: providerUsageUtilityCancelInputSchema,
  }),
  z.strictObject({
    type: z.literal('provider-usage.release-owner.request'),
    requestId: z.string().uuid(),
    input: providerUsageReleaseOwnerInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('project-context.read.request'),
    requestId: z.string().uuid(),
    input: projectContextInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.add.request'),
    requestId: z.string().uuid(),
    input: projectDirectoryAddInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.archive.request'),
    requestId: z.string().uuid(),
    input: projectArchiveInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.restore.request'),
    requestId: z.string().uuid(),
    input: projectArchiveInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.rename.request'),
    requestId: z.string().uuid(),
    input: projectNameChangeSchema,
  }),
  z.object({
    type: z.literal('session-catalog.get.request'),
    requestId: z.string().uuid(),
    input: sessionCatalogPageInputSchema,
  }),
  z.object({
    type: z.literal('session-page.get.request'),
    requestId: z.string().uuid(),
    input: sessionPageInputSchema,
  }),
  z.object({
    type: z.literal('session-groups.get.request'),
    requestId: z.string().uuid(),
    input: sessionGroupPageInputSchema,
  }),
  z.object({
    type: z.literal('session-group.get.request'),
    requestId: z.string().uuid(),
    input: sessionGroupDetailInputSchema,
  }),
  z.object({
    type: z.literal('session-membership.get.request'),
    requestId: z.string().uuid(),
    input: sessionMembershipInputSchema,
  }),
  z.object({
    type: z.literal('session-navigation.locate.request'),
    requestId: z.string().uuid(),
    input: locateSessionNavigationInputSchema,
  }),
  z.object({
    type: z.literal('session-creation.state.request'),
    requestId: z.string().uuid(),
    input: sessionCreationStateInputSchema,
  }),
  z.object({
    type: z.literal('session-group.create.request'),
    requestId: z.string().uuid(),
    input: createSessionGroupInputSchema,
  }),
  z.object({
    type: z.literal('session-group.update.request'),
    requestId: z.string().uuid(),
    input: updateSessionGroupInputSchema,
  }),
  z.object({
    type: z.literal('session-group.move.request'),
    requestId: z.string().uuid(),
    input: moveSessionGroupInputSchema,
  }),
  z.object({
    type: z.literal('session-group.dissolve.request'),
    requestId: z.string().uuid(),
    input: dissolveSessionGroupInputSchema,
  }),
  z.object({
    type: z.literal('session-group.set.request'),
    requestId: z.string().uuid(),
    input: setSessionGroupInputSchema,
  }),
  z.object({
    type: z.literal('session-creation.prepare.request'),
    requestId: z.string().uuid(),
    input: sessionCreationPrepareInputSchema,
  }),
  z.object({
    type: z.literal('session.create.request'),
    requestId: z.string().uuid(),
    input: sessionCreateInputSchema,
  }),
  z.object({
    type: z.literal('session.rename.request'),
    requestId: z.string().uuid(),
    input: sessionRenameInputSchema,
  }),
  z.object({
    type: z.literal('session.mark-read.request'),
    requestId: z.string().uuid(),
    input: sessionMarkReadInputSchema,
  }),
  z.object({
    type: z.literal('session.archive.request'),
    requestId: z.string().uuid(),
    input: sessionArchiveInputSchema,
  }),
  z.object({
    type: z.literal('session.restore.request'),
    requestId: z.string().uuid(),
    input: sessionArchiveInputSchema,
  }),
  z.object({
    type: z.literal('session-sidebar-hidden.set.request'),
    requestId: z.string().uuid(),
    input: sessionSidebarHiddenInputSchema,
  }),
  z.object({
    type: z.literal('session-settings.get.request'),
    requestId: z.string().uuid(),
    input: sessionSettingsInputSchema,
  }),
  z.object({
    type: z.literal('session-settings.save.request'),
    requestId: z.string().uuid(),
    input: sessionSettingsSaveInputSchema,
  }),
  z.object({
    type: z.literal('session-permission.save.request'),
    requestId: z.string().uuid(),
    input: sessionPermissionSaveInputSchema,
  }),
  z.object({
    type: z.literal('session-speed.save.request'),
    requestId: z.string().uuid(),
    input: sessionSpeedSaveInputSchema,
  }),
  z.object({
    type: z.literal('skills.cancel.request'),
    requestId: z.string().uuid(),
    input: z.object({ sessionId: z.string().uuid() }),
  }),
  z.object({
    type: z.literal('skills.read.request'),
    requestId: z.string().uuid(),
    input: skillCatalogReadSchema,
  }),
  z.object({
    type: z.literal('conversation.image.write.request'),
    requestId: z.string().uuid(),
    input: imageWriteInputSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.image.choose.request'),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    paths: z.array(z.string().min(1).max(4096)).max(128),
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.image.read.request'),
    requestId: z.string().uuid(),
    input: imageReadInputSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.input.request'),
    requestId: z.string().uuid(),
    input: conversationInputWriteSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.input.release-owner.request'),
    requestId: z.string().uuid(),
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.get.request'),
    requestId: z.string().uuid(),
    input: conversationGetInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.steer.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.return.request'),
    requestId: z.string().uuid(),
    input: conversationQueueReturnInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.remove.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.resume.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.enabled.request'),
    requestId: z.string().uuid(),
    input: conversationQueueEnabledInputSchema,
  }),
  z.object({
    type: z.literal('conversation.send.request'),
    requestId: z.string().uuid(),
    input: conversationSendInputSchema,
    ownerKey: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal('collaboration.action.request'),
    requestId: z.string().uuid(),
    input: collaborationActionInputSchema,
  }),
  z.object({
    type: z.literal('peer-proposal.accept.request'),
    requestId: z.string().uuid(),
    input: peerProposalAcceptInputSchema,
  }),
  z.object({
    type: z.literal('peer-proposal.dismiss.request'),
    requestId: z.string().uuid(),
    input: peerProposalDismissInputSchema,
  }),
  z.object({
    type: z.literal('conversation.retry.request'),
    requestId: z.string().uuid(),
    input: conversationRetryInputSchema,
  }),
  z.object({
    type: z.literal('native-permission.respond.request'),
    requestId: z.string().uuid(),
    input: nativePermissionRespondInputSchema,
  }),
  z.object({
    type: z.literal('native-input.read.request'),
    requestId: z.string().uuid(),
    input: nativeInputReadSchema,
  }),
  z.object({
    type: z.literal('native-input.respond.request'),
    requestId: z.string().uuid(),
    input: nativeInputRespondSchema,
  }),
  z.object({
    type: z.literal('native-input.opened.request'),
    requestId: z.string().uuid(),
    input: nativeInputReadSchema,
  }),
  z.object({
    type: z.literal('conversation.stop.request'),
    requestId: z.string().uuid(),
    input: conversationStopInputSchema,
  }),
  z.object({
    type: z.literal('native-context.rebuild.request'),
    requestId: z.string().uuid(),
    input: nativeContextRebuildInputSchema,
  }),
  z.object({
    type: z.literal('project-file.read.request'),
    requestId: z.string().uuid(),
    input: projectFileReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.read.request'),
    requestId: z.string().uuid(),
    input: workspaceChangesReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.file-read.request'),
    requestId: z.string().uuid(),
    input: workspaceChangeFileReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.undo.request'),
    requestId: z.string().uuid(),
    input: workspaceChangesUndoInputSchema,
  }),
  z.strictObject({
    type: z.literal('side-chat.create.request'),
    requestId: z.string().uuid(),
    input: createSideChatInputSchema,
  }),
  z.strictObject({
    type: z.literal('side-chat.create-receipt.request'),
    requestId: z.string().uuid(),
    input: readSideChatReceiptInputSchema,
  }),
  z.strictObject({
    type: z.literal('side-chat.list.request'),
    requestId: z.string().uuid(),
    input: listSideChatsInputSchema,
  }),
  z.strictObject({
    type: z.literal('side-chat.discard-empty.request'),
    requestId: z.string().uuid(),
    input: discardEmptySideChatInputSchema,
  }),
  z.strictObject({
    type: z.literal('side-chat.sync-main.request'),
    requestId: z.string().uuid(),
    input: sideChatSyncMainInputSchema,
    ownerKey: z.string().uuid().optional(),
  }),
  z.strictObject({
    type: z.literal('side-chat.sync-main-receipt.request'),
    requestId: z.string().uuid(),
    input: readSideChatReceiptInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.list.request'),
    requestId: z.string().uuid(),
    input: terminalListInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.create.request'),
    requestId: z.string().uuid(),
    input: terminalCreateInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.visibility.request'),
    requestId: z.string().uuid(),
    input: terminalVisibilityInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.write.request'),
    requestId: z.string().uuid(),
    input: terminalWriteInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.resize.request'),
    requestId: z.string().uuid(),
    input: terminalResizeInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.close.request'),
    requestId: z.string().uuid(),
    input: terminalCloseInputSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.snapshot.request'),
    requestId: z.string().uuid(),
    input: terminalSnapshotInputSchema,
  }),
])

export type UtilityRequest = z.infer<typeof utilityRequestSchema>

export const utilityResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('conversation.prepared-input.continue.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationPatchSchema),
  }),
  z.strictObject({
    type: z.literal('relay.decision.receipt.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(relayDecisionReceiptSchema),
  }),
  z.strictObject({
    type: z.literal('scheduling.state.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(schedulingStateSchema),
  }),
  z.strictObject({
    type: z.literal('scheduling.settings.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(schedulingSettingsSchema),
  }),

  z.strictObject({
    type: z.literal('relay.credential.write.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(relayCredentialReceiptSchema),
  }),
  z.strictObject({
    type: z.literal('relay.credential.receipt.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(relayCredentialReceiptSchema.nullable()),
  }),
  z.strictObject({
    type: z.literal('relay.credential.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(relayCredentialStoredSchema),
  }),
  z.strictObject({
    type: z.literal('scheduling.activity.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(schedulingActivityPageSchema),
  }),
  z.strictObject({
    type: z.literal('updates.state.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(updateStoredStateSchema),
  }),
  z.strictObject({
    type: z.literal('updates.notice.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(updateNoticeResultSchema),
  }),
  z.strictObject({
    type: z.literal('workspace-archive.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceArchivePreviewSchema),
  }),
  z.strictObject({
    type: z.literal('workspace-archive.receipt.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceArchiveReceiptSchema),
  }),
  z.object({
    type: z.literal('skill-document.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(skillDocumentSchema),
  }),
  z.object({
    type: z.literal('skill-document.cancel.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('session.fork.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionForkResultSchema),
  }),
  z.object({
    type: z.literal('native-input.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeInteractionDetailsSchema),
  }),
  z.object({
    type: z.literal('conversation.interests.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('runtime.shutdown.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(
      z.object({
        flushed: z.literal(true),
        unconfirmedTerminals: z.number().int().nonnegative().max(MAX_TOTAL_TERMINALS).optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('native-presence.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativePresenceSnapshotSchema),
  }),
  z.object({
    type: z.literal('native-attention.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeAttentionPageSchema),
  }),
  z.object({
    type: z.literal('native-session.resolve.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionCatalogChangeSchema),
  }),
  z.object({
    type: z.literal('native-session.opened.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeSessionOpenedResultSchema),
  }),
  z.object({
    type: z.literal('native-jump-list.suppression.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeJumpListSuppressionResultSchema),
  }),
  z.object({
    type: z.literal('native-quit.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeQuitPreparationSchema),
  }),
  z.object({
    type: z.literal('native-quit.cancel.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeQuitCancelledResultSchema),
  }),
  z.object({
    type: z.literal('runtime.health.response'),
    requestId: z.string().uuid(),
    health: runtimeHealthSchema,
  }),
  z.object({
    type: z.literal('comment-source.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(commentSourceResolutionSchema),
  }),
  z.object({
    type: z.literal('appearance.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(appearanceSettingsSchema),
  }),
  z.object({
    type: z.literal('runtime-preparation.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(runtimePreparationSchema),
  }),
  z.object({
    type: z.literal('default-session-settings.get.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('default-session-settings.save.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsStateSchema),
  }),
  z.strictObject({
    type: z.literal('provider-usage.snapshot.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(providerUsageSnapshotSchema),
  }),
  z.strictObject({
    type: z.literal('provider-usage.cancel.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(providerUsageCancelResultSchema),
  }),
  z.strictObject({
    type: z.literal('provider-usage.release-owner.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(providerUsageReadyResultSchema),
  }),
  z.object({
    type: z.literal('project-catalog.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectCatalogStateSchema),
  }),
  z.object({
    type: z.literal('project-context.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectContextSchema),
  }),
  z.object({
    type: z.literal('project-catalog.rename.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectNameChangeSchema),
  }),
  z.object({
    type: z.literal('session-catalog.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionCatalogReplySchema),
  }),
  z.object({
    type: z.literal('session-page.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionPageSchema),
  }),
  z.object({
    type: z.literal('session-groups.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionGroupPageSchema),
  }),
  z.object({
    type: z.literal('session-group.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionGroupDetailSchema),
  }),
  z.object({
    type: z.literal('session-membership.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionMembershipSchema),
  }),
  z.object({
    type: z.literal('session-navigation.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(locatedSessionNavigationSchema),
  }),
  z.object({
    type: z.literal('session-creation-state.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionCreationStateSchema),
  }),
  z.object({
    type: z.literal('session-group-change.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionGroupMutationSchema),
  }),
  z.object({
    type: z.literal('session-creation.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('session-settings.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('session-settings.save.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionSettingsSaveResultSchema),
  }),
  z.object({
    type: z.literal('skills.page.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(skillCatalogPageSchema),
  }),
  z.object({
    type: z.literal('conversation.image.write.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(imageWriteStateSchema),
  }),
  z.object({
    type: z.literal('conversation.image.choose.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationImagesSchema),
  }),
  z.object({
    type: z.literal('conversation.image.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(imageReadPartSchema),
  }),
  z.object({
    type: z.literal('conversation.input.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationInputStateSchema),
  }),
  z.object({
    type: z.literal('conversation.input.release-owner.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('conversation.page.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationPageSchema),
  }),
  z.object({
    type: z.literal('conversation.patch.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationPatchSchema),
  }),
  z.object({
    type: z.literal('project-file.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectFileSchema),
  }),
  z.object({
    type: z.literal('workspace-changes.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceChangesPageSchema),
  }),
  z.object({
    type: z.literal('workspace-changes.file-response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceChangeFilePreviewSchema),
  }),
  z.strictObject({
    type: z.literal('side-chat.create.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(createSideChatReceiptSchema),
  }),
  z.strictObject({
    type: z.literal('side-chat.create-receipt.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(createSideChatReceiptSchema.nullable()),
  }),
  z.strictObject({
    type: z.literal('side-chat.list.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(listSideChatsPageSchema),
  }),
  z.strictObject({
    type: z.literal('side-chat.discard-empty.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(discardEmptySideChatResultSchema),
  }),
  z.strictObject({
    type: z.literal('side-chat.sync-main.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sideChatSyncMainReceiptSchema),
  }),
  z.strictObject({
    type: z.literal('side-chat.sync-main-receipt.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sideChatSyncMainReceiptSchema.nullable()),
  }),
  z.strictObject({
    type: z.literal('terminal.list.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalListResultSchema),
  }),
  z.strictObject({
    type: z.literal('terminal.create.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalSummarySchema),
  }),
  z.strictObject({
    type: z.literal('terminal.visibility.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalVisibilityResultSchema),
  }),
  z.strictObject({
    type: z.literal('terminal.write.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalWriteResultSchema),
  }),
  z.strictObject({
    type: z.literal('terminal.resize.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalResizeResultSchema),
  }),
  z.strictObject({
    type: z.literal('terminal.close.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalCloseResultSchema),
  }),
  z.strictObject({
    type: z.literal('terminal.snapshot.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(terminalSnapshotResultSchema),
  }),
])

export type UtilityResponse = z.infer<typeof utilityResponseSchema>

export const runtimeStartupFailureSchema = z.strictObject({
  type: z.literal('runtime.startup-failed.event'),
  failureId: z.string().uuid(),
  stage: z.enum(['persistence', 'runtime']),
  code: z.enum([
    'DATABASE_IN_USE',
    'DATABASE_INCOMPATIBLE',
    'DATABASE_BACKUP_FAILED',
    'DATABASE_MIGRATION_FAILED',
    'DATABASE_STORAGE_FAILED',
  ]),
  reason: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z-]+$/u),
  dataFilePath: z.string().min(1).max(4096),
  backupFilePath: z.string().min(1).max(4096).optional(),
  partialBackupFilePath: z.string().min(1).max(4096).optional(),
  stagingFilePath: z.string().min(1).max(4096).optional(),
})
export type RuntimeStartupFailure = z.infer<typeof runtimeStartupFailureSchema>
export const runtimeStartupFailureAckSchema = z.strictObject({
  type: z.literal('runtime.startup-failed.ack'),
  failureId: z.string().uuid(),
})

export const utilityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('scheduling.changed.event') }),
  z.strictObject({ type: z.literal('runtime.ready.event') }),
  z.strictObject({
    type: z.literal('native-presence.quit-recent.event'),
    version: nativePresenceVersionSchema,
    sessions: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  }),
  z.strictObject({
    type: z.literal('native-presence.changed.event'),
    version: nativePresenceVersionSchema,
  }),
  runtimeStartupFailureSchema,
  z.strictObject({
    type: z.literal('conversation.patch.event'),
    patch: conversationPatchSchema,
    progress: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('session.notification.event'),
    event: sessionNotificationEventSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.output.event'),
    event: terminalOutputEventSchema,
  }),
  z.strictObject({
    type: z.literal('terminal.state.event'),
    event: terminalStateEventSchema,
  }),
])
export type UtilityEvent = z.infer<typeof utilityEventSchema>

export interface DesktopBridge {
  continuePreparedConversationInput(
    input: PreparedInputContinue,
  ): Promise<RpcResult<ConversationPatch>>
  getSchedulingState(input: SchedulingStateInput): Promise<RpcResult<SchedulingState>>
  getSchedulingSettings(): Promise<RpcResult<SchedulingSettings>>
  saveSchedulingSettings(input: SchedulingSettingsSave): Promise<RpcResult<SchedulingSettings>>
  saveRelayApiKey(input: RelayCredentialSave): Promise<RpcResult<RelayCredentialReceipt>>
  removeRelayApiKey(input: RelayCredentialRemove): Promise<RpcResult<RelayCredentialReceipt>>
  revealRelayApiKey(input: RelayCredentialReveal): Promise<RpcResult<RelayCredentialRevealed>>
  readRelayCredentialReceipt(
    input: RelayCredentialReceiptRead,
  ): Promise<RpcResult<RelayCredentialReceipt | null>>
  readSchedulingActivity(input: SchedulingActivityRead): Promise<RpcResult<SchedulingActivityPage>>
  onSchedulingChanged(listener: () => void): () => void
  getUpdateState(): Promise<RpcResult<UpdateState>>
  checkForUpdates(): Promise<RpcResult<UpdateState>>
  setUpdatePreferences(input: UpdatePreferencesInput): Promise<RpcResult<UpdateState>>
  claimUpdateNotice(input: { version: string }): Promise<RpcResult<{ claimed: boolean }>>
  onUpdateStateChanged(listener: (state: UpdateState) => void): () => void
  resolveNativeSession(input: NativeSessionResolveInput): Promise<RpcResult<SessionCatalogChange>>
  recordNativeSessionOpened(input: NativeSessionOpenInput): Promise<RpcResult<{ recorded: true }>>
  readNativeAttention(input: NativeAttentionReadInput): Promise<RpcResult<NativeAttentionPage>>
  onNativePresenceChanged(listener: (version: NativePresenceVersion) => void): () => void
  onSessionReminderChanged(listener: (state: SessionReminderState) => void): () => void
  viewSessionReminder(input: SessionReminderAction): Promise<RpcResult<SessionReminderActionResult>>
  dismissSessionReminder(
    input: SessionReminderAction,
  ): Promise<RpcResult<SessionReminderActionResult>>
  getNativeNavigation(): Promise<RpcResult<NativeNavigationIntent | null>>
  acknowledgeNativeNavigation(
    input: NativeNavigationAckInput,
  ): Promise<RpcResult<{ acknowledged: true }>>
  onNativeNavigationChanged(listener: (intent: NativeNavigationIntent) => void): () => void
  getNativeQuitState(): Promise<RpcResult<NativeQuitState | null>>
  onNativeQuitStateChanged(listener: (state: NativeQuitState | null) => void): () => void
  respondNativeQuit(input: NativeQuitDecisionInput): Promise<RpcResult<{ accepted: true }>>
  prepareWorkspaceArchive(
    input: WorkspaceArchivePrepareInput,
  ): Promise<RpcResult<WorkspaceArchivePreview>>
  readWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  cancelWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  /** Fixture-only scalar observation; local Preload counters, never generic IPC or business DTOs. */
  observeMonacoWorkerTraffic?(this: void, observation: MonacoIpcObservation): void
  getDiagnosticStatus?(): Promise<DiagnosticStatus>
  onDiagnosticStatusChanged?(listener: (status: DiagnosticStatus) => void): () => void
  reportRendererFault?(fault: RendererFault): void
  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>>
  saveSessionPermission(input: SessionPermissionSaveInput): Promise<RpcResult<SessionCatalogChange>>
  saveSessionSpeed(input: SessionSpeedSaveInput): Promise<RpcResult<SessionCatalogChange>>
  readNativeInput(input: NativeInputRead): Promise<RpcResult<NativeInteractionDetails>>
  respondNativeInput(input: NativeInputRespond): Promise<RpcResult<ConversationPatch>>
  openNativeInputURL(input: NativeInputRead): Promise<RpcResult<{ opened: true }>>
  respondNativePermission(
    input: NativePermissionRespondInput,
  ): Promise<RpcResult<ConversationPatch>>
  getAppInfo(): Promise<RpcResult<AppInfo>>
  getRuntimeHealth(): Promise<RpcResult<RuntimeHealth>>
  getRuntimePreparation(input?: RuntimePreparationGetInput): Promise<RpcResult<RuntimePreparation>>
  chooseRuntimeExecutable(agentId: RuntimeAgentId): Promise<RpcResult<RuntimePreparation>>
  getDefaultSessionSettingsEditorState(
    activePair?: ActiveAgentPairInput,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  saveDefaultSessionSettings(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>>
  getProviderUsage(input: ProviderUsageReadInput): Promise<RpcResult<ProviderUsageSnapshot>>
  refreshProviderUsage(input: ProviderUsageRefreshInput): Promise<RpcResult<ProviderUsageSnapshot>>
  cancelProviderUsage(
    input: ProviderUsageCancelInput,
  ): Promise<RpcResult<ProviderUsageCancelResult>>
  getProjectCatalog(): Promise<RpcResult<ProjectCatalogState>>
  readProjectContext(input: ProjectContextInput): Promise<RpcResult<ProjectContext>>
  openProjectDirectory(input: ProjectContextInput): Promise<RpcResult<{ opened: true }>>
  chooseAndAddProject(): Promise<RpcResult<ProjectCatalogState>>
  archiveProject(projectId: string, operationId?: string): Promise<RpcResult<ProjectCatalogState>>
  restoreProject(projectId: string): Promise<RpcResult<ProjectCatalogState>>
  renameProject(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>>
  getSessionCatalog(
    projectId: string,
    cursor?: SessionCatalogCursor,
  ): Promise<RpcResult<SessionCatalogPage>>
  getSessionPage(input: SessionPageInput): Promise<RpcResult<SessionPage>>
  getSessionGroups(input: SessionGroupPageInput): Promise<RpcResult<SessionGroupPage>>
  getSessionGroup(input: SessionGroupDetailInput): Promise<RpcResult<SessionGroupDetail>>
  getSessionMembership(input: SessionMembershipInput): Promise<RpcResult<SessionMembership>>
  locateSessionNavigation(
    input: LocateSessionNavigationInput,
  ): Promise<RpcResult<LocatedSessionNavigation>>
  recoverSessionOrganization(): Promise<RpcResult<{ ready: true }>>
  getSessionCreationState(
    input: SessionCreationStateInput,
  ): Promise<RpcResult<SessionCreationState>>
  createSessionGroup(input: CreateSessionGroupInput): Promise<RpcResult<SessionGroupMutation>>
  updateSessionGroup(input: UpdateSessionGroupInput): Promise<RpcResult<SessionGroupMutation>>
  moveSessionGroup(input: MoveSessionGroupInput): Promise<RpcResult<SessionGroupMutation>>
  dissolveSessionGroup(input: DissolveSessionGroupInput): Promise<RpcResult<SessionGroupMutation>>
  setSessionGroup(input: SetSessionGroupInput): Promise<RpcResult<SessionGroupMutation>>
  prepareSessionCreation(
    projectId: string,
    activePair?: ActiveAgentPairInput,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  createSession(input: SessionCreateInput): Promise<RpcResult<SessionCatalogChange>>
  renameSession(input: SessionRenameInput): Promise<RpcResult<SessionCatalogChange>>
  markSessionRead(input: SessionMarkReadInput): Promise<RpcResult<SessionCatalogChange>>
  archiveSession(sessionId: string, operationId?: string): Promise<RpcResult<SessionCatalogChange>>
  restoreSession(sessionId: string): Promise<RpcResult<SessionCatalogChange>>
  setSessionSidebarHidden(
    input: SessionSidebarHiddenInput,
  ): Promise<RpcResult<SessionCatalogChange>>
  getSessionSettings(
    sessionId: string,
    activePair?: ActiveAgentPairInput,
  ): Promise<RpcResult<SessionSettingsEditorState>>
  saveSessionSettings(
    input: SessionSettingsSaveInput,
  ): Promise<RpcResult<SessionSettingsSaveResult>>
  cancelSkillCatalog(sessionId: string): Promise<RpcResult<{ ready: true }>>
  setComposerEditingState(
    input: import('./skills.js').ComposerEditingState,
  ): Promise<RpcResult<{ ready: true }>>
  onComposerEditCommand(
    listener: (command: import('./skills.js').ComposerEditCommand) => void,
  ): () => void
  settleComposerEdit(
    input: import('./skills.js').ComposerEditReceipt,
  ): Promise<RpcResult<{ ready: true }>>
  readSkillDocument(
    input: import('./skills.js').SkillDocumentRead,
  ): Promise<RpcResult<import('./skills.js').SkillDocument>>
  cancelSkillDocument(requestId: string): Promise<RpcResult<{ ready: true }>>
  readSkillCatalog(
    input: import('./skills.js').SkillCatalogRead,
  ): Promise<RpcResult<import('./skills.js').SkillCatalogPage>>
  actOnCollaboration(
    input: import('./collaboration.js').CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  answerRelayDecision(
    input: import('./relay-decisions.js').RelayDecisionAnswer,
  ): Promise<RpcResult<import('./relay-decisions.js').RelayDecisionReceipt>>
  getRelayDecisionReceipt(
    input: import('./relay-decisions.js').RelayDecisionReceiptRead,
  ): Promise<RpcResult<import('./relay-decisions.js').RelayDecisionReceipt>>
  getConversation(input: ConversationGetInput): Promise<RpcResult<ConversationPage>>
  setConversationInterest(
    sessionId: string | readonly string[] | null,
    generation: number,
  ): Promise<RpcResult<{ ready: true }>>
  createSideChat(input: CreateSideChatInput): Promise<RpcResult<CreateSideChatReceipt>>
  readCreateSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): Promise<RpcResult<CreateSideChatReceipt | null>>
  listSideChats(input: ListSideChatsInput): Promise<RpcResult<ListSideChatsPage>>
  discardEmptySideChat(
    input: DiscardEmptySideChatInput,
  ): Promise<RpcResult<DiscardEmptySideChatResult>>
  syncSideChatToMain(input: SideChatSyncMainInput): Promise<RpcResult<SideChatSyncMainReceipt>>
  readSyncSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): Promise<RpcResult<SideChatSyncMainReceipt | null>>
  writeConversationImage(
    input: import('./images.js').ImageWriteInput,
  ): Promise<RpcResult<import('./images.js').ImageWriteState>>
  chooseConversationImages(
    input: import('./images.js').ImageChooseInput,
  ): Promise<RpcResult<import('./images.js').ConversationImage[]>>
  readConversationImage(
    input: import('./images.js').ImageReadInput,
  ): Promise<RpcResult<import('./images.js').ImageReadPart>>
  writeConversationInput(input: ConversationInputWrite): Promise<RpcResult<ConversationInputState>>
  steerQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  returnQueuedConversationMessage(
    input: ConversationQueueReturnInput,
  ): Promise<RpcResult<ConversationPatch>>
  removeQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  resumeConversationQueue(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  setConversationQueueEnabled(
    input: ConversationQueueEnabledInput,
  ): Promise<RpcResult<ConversationPatch>>
  sendConversationMessage(input: ConversationSendInput): Promise<RpcResult<ConversationPatch>>
  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>>
  dismissPeerProposal(input: PeerProposalDismissInput): Promise<RpcResult<ConversationPatch>>
  saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>>
  removeCommentDraft(input: CommentDraftRemoveInput): Promise<RpcResult<ConversationPatch>>
  resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>>
  retryConversationRun(
    runId: string,
    options?: Omit<ConversationRetryInput, 'runId'>,
  ): Promise<RpcResult<ConversationPatch>>
  stopConversation(input: ConversationStopInput): Promise<RpcResult<ConversationPatch>>
  rebuildNativeContext(input: NativeContextRebuildInput): Promise<RpcResult<ConversationPatch>>
  onConversationChanged(listener: (patch: ConversationPatch) => void): () => void
  readProjectFile(input: ProjectFileReadInput): Promise<RpcResult<ProjectFile>>
  readWorkspaceChanges(input: WorkspaceChangesReadInput): Promise<RpcResult<WorkspaceChangesPage>>
  readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>>
  undoWorkspaceChanges(input: WorkspaceChangesUndoInput): Promise<RpcResult<ConversationPatch>>
  getAppearanceSettings(): Promise<RpcResult<AppearanceSnapshot>>
  updateAppearanceSettings(input: AppearanceSettingsUpdate): Promise<RpcResult<AppearanceSnapshot>>
  resetAppearanceSettings(input: AppearanceSettingsReset): Promise<RpcResult<AppearanceSnapshot>>
  onAppearanceSettingsChanged(listener: (snapshot: AppearanceSnapshot) => void): () => void
  listTerminals(input: TerminalListInput): Promise<RpcResult<TerminalListResult>>
  createTerminal(input: TerminalCreateInput): Promise<RpcResult<TerminalSummary>>
  subscribeTerminal(input: TerminalSubscribeInput): Promise<RpcResult<TerminalSubscribeResult>>
  unsubscribeTerminal(
    input: TerminalUnsubscribeInput,
  ): Promise<RpcResult<TerminalUnsubscribeResult>>
  ackTerminalOutput(input: TerminalAckOutputInput): Promise<RpcResult<TerminalAckOutputResult>>
  releaseProjectTerminalViews(
    input: TerminalReleaseProjectViewsInput,
  ): Promise<RpcResult<TerminalReleaseProjectViewsResult>>
  writeTerminal(input: TerminalWriteInput): Promise<RpcResult<TerminalWriteResult>>
  resizeTerminal(input: TerminalResizeInput): Promise<RpcResult<TerminalResizeResult>>
  closeTerminal(input: TerminalCloseInput): Promise<RpcResult<TerminalCloseResult>>
  readTerminalSnapshot(input: TerminalSnapshotInput): Promise<RpcResult<TerminalSnapshotResult>>
  consumeTerminalLastExitNotice(): Promise<RpcResult<TerminalLastExitNotice | null>>
  onTerminalOutput(listener: (event: TerminalOutputEvent) => void): () => void
  onTerminalState(listener: (event: TerminalStateEvent) => void): () => void
}
