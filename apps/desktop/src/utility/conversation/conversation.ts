import type {
  CollaborationActionInput,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  CommentSourceResolution,
  ConversationGetInput,
  ConversationInputState,
  ConversationInputWrite,
  ConversationPage,
  ConversationPatch,
  ConversationQueueActionInput,
  ConversationQueueEnabledInput,
  ConversationQueueReturnInput,
  ConversationRetryInput,
  ConversationSendInput,
  ConversationStopInput,
  CreateSideChatInput,
  CreateSideChatReceipt,
  DecisionEvaluationOutcome,
  DecisionInput,
  DiscardEmptySideChatInput,
  DiscardEmptySideChatResult,
  ListSideChatsInput,
  ListSideChatsPage,
  NativeAttentionPage,
  NativeAttentionReadInput,
  NativeContextRebuildInput,
  NativeInputRead,
  NativeInputRespond,
  NativeInteractionDetails,
  NativePermissionRespondInput,
  NativePresenceSnapshot,
  NativePresenceVersion,
  NativeQuitOperationInput,
  NativeQuitPreparation,
  PeerProposalAcceptInput,
  PeerProposalDismissInput,
  ReadSideChatReceiptInput,
  RelayDecisionAnswer,
  RelayDecisionReceipt,
  RelayDecisionReceiptRead,
  RpcResult,
  SchedulingHandoff,
  SchedulingSettings,
  SchedulingState,
  SchedulingStateInput,
  SessionForkInput,
  SessionForkResult,
  SessionNotificationEvent,
  SideChatSyncMainInput,
  SideChatSyncMainReceipt,
  SkillCatalogPage,
  SkillCatalogRead,
  SkillDocument,
  SkillDocumentRead,
  WorkspaceArchivePrepareInput,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
  WorkspaceChangeFilePreview,
  WorkspaceChangeFileReadInput,
  WorkspaceChangesPage,
  WorkspaceChangesReadInput,
  WorkspaceChangesUndoInput,
} from '@pact/contracts'
import type {
  ConversationImage,
  ImageReadInput,
  ImageReadPart,
  ImageWriteInput,
  ImageWriteState,
} from '@pact/contracts/images'
import type {
  ConversationRepository,
  ProjectCatalogRepository,
  SessionRepository,
} from '@pact/persistence'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import type { ProjectFileReader } from '../project-file/project-file-reader'
import type { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import type { WorkspaceChanges } from '../workspace-changes/workspace-changes'
import type { ConversationImages } from './conversation-images'
import type { ConversationTerminalCoordinator } from './conversation-types'
import type { DecisionInputLoader } from './decision-runtime'

import { ConversationAdmissionGate } from './conversation-admission-gate'
import { ConversationRuntimeCore } from './conversation-runtime-core'
import { ArchiveAndQuitCoordinator } from './coordinators/archive-and-quit-coordinator'
import { CollaborationAndHandoffCoordinator } from './coordinators/collaboration-and-handoff-coordinator'
import { ForkCoordinator } from './coordinators/fork-coordinator'
import { InteractionAndTitleCoordinator } from './coordinators/interaction-and-title-coordinator'
import { NativeRecoveryCoordinator } from './coordinators/native-recovery-coordinator'
import { RunExecutor } from './coordinators/run-executor'
import { SchedulingDecisionCoordinator } from './coordinators/scheduling-decision-coordinator'
import { SendAndSteerCoordinator } from './coordinators/send-and-steer-coordinator'
import { SideChatCoordinator } from './coordinators/side-chat-coordinator'
import { SkillsCoordinator } from './coordinators/skills-coordinator'

export type { ConversationTerminalCoordinator } from './conversation-types'

/**
 * Thin facade composing `ConversationRuntimeCore` and Pact's deep autonomous coordinators.
 *
 * All live state lives in `ConversationRuntimeCore`; admission and blocking invariants live
 * in `ConversationAdmissionGate`; single-writer output/archive lives in `RunOutputArchiver`.
 */
export class Conversation {
  private readonly core: ConversationRuntimeCore
  private readonly gate: ConversationAdmissionGate
  private readonly scheduling: SchedulingDecisionCoordinator
  private readonly archiveAndQuit: ArchiveAndQuitCoordinator
  private readonly fork: ForkCoordinator
  private readonly interactions: InteractionAndTitleCoordinator
  private readonly skills: SkillsCoordinator
  private readonly recovery: NativeRecoveryCoordinator
  private readonly sendAndSteer: SendAndSteerCoordinator
  private readonly executor: RunExecutor
  private readonly collaboration: CollaborationAndHandoffCoordinator
  private readonly sideChats: SideChatCoordinator

  constructor(
    conversations: ConversationRepository,
    sessions: SessionRepository,
    projects: ProjectCatalogRepository,
    runtimePreparation: RuntimePreparation,
    projectFiles: ProjectFileReader,
    workspaceChanges?: WorkspaceChanges,
    images?: ConversationImages,
    ipcTraffic?: LogicalIpcWorkerTraffic,
    loadDecisionCredential?: (context: {
      signal: AbortSignal
      deadlineAt: number
    }) => Promise<string | null> | string | null,
    terminalCoordinator?: ConversationTerminalCoordinator,
  ) {
    this.core = new ConversationRuntimeCore(
      conversations,
      sessions,
      projects,
      runtimePreparation,
      projectFiles,
      workspaceChanges,
      images,
      ipcTraffic,
      loadDecisionCredential,
      terminalCoordinator,
    )
    this.gate = new ConversationAdmissionGate(this.core)
    this.scheduling = new SchedulingDecisionCoordinator(this.core)
    this.archiveAndQuit = new ArchiveAndQuitCoordinator(this.core)
    this.fork = new ForkCoordinator(this.core)
    this.interactions = new InteractionAndTitleCoordinator(this.core)
    this.skills = new SkillsCoordinator(this.core)
    this.recovery = new NativeRecoveryCoordinator(this.core)
    this.sendAndSteer = new SendAndSteerCoordinator(this.core)
    this.executor = new RunExecutor(this.core)
    this.collaboration = new CollaborationAndHandoffCoordinator(this.core)
    this.sideChats = new SideChatCoordinator(this.core)

    this.core.bindCoordinators({
      gate: this.gate,
      scheduling: this.scheduling,
      archiveAndQuit: this.archiveAndQuit,
      fork: this.fork,
      interactions: this.interactions,
      skills: this.skills,
      recovery: this.recovery,
      sendAndSteer: this.sendAndSteer,
      executor: this.executor,
      collaboration: this.collaboration,
      sideChats: this.sideChats,
      stopSession: (sessionId) => this.stop({ sessionId }),
    })

    conversations.archives.recover(this.core.archiveOwnerId)
    conversations.expireNativePermissions()
    conversations.recoverInterruptedRuns()
    conversations.recoverCollaborationTasks()
    conversations.recoverForkIntents()
    conversations.beginSchedulingRecoveryEpoch(this.core.utilityEpoch)
    this.collaboration.schedulePendingRoutedContinuations()
    void this.scheduling.recoverDecisionReservation()
  }

  reconcileSessionSettingsChanged(sessionId: string): Promise<void> {
    return this.core.reconcileSessionSettingsChanged(sessionId)
  }

  subscribeSchedulingChanges(listener: () => void): () => void {
    return this.scheduling.subscribeSchedulingChanges(listener)
  }

  getSchedulingSettings(): RpcResult<SchedulingSettings> {
    return this.scheduling.getSchedulingSettings()
  }

  getSchedulingState(raw: SchedulingStateInput): RpcResult<SchedulingState> {
    return this.scheduling.getSchedulingState(raw)
  }

  evaluateDecision(
    request:
      | DecisionInput
      | {
          handoff: SchedulingHandoff
          load: DecisionInputLoader
          retainHandoff?: boolean
        }
      | { sessionId: string; prepare: DecisionInputLoader },
    signal: AbortSignal,
  ): Promise<DecisionEvaluationOutcome> {
    return this.scheduling.evaluateDecision(request, signal)
  }

  saveSchedulingSettings(
    input: import('@pact/contracts').SchedulingSettingsSave,
  ): Promise<RpcResult<SchedulingSettings>> {
    return this.scheduling.saveSchedulingSettings(input)
  }

  writeRelayCredential(
    input: import('@pact/contracts').RelayCredentialWrite,
  ): Promise<RpcResult<import('@pact/contracts').RelayCredentialReceipt>> {
    return this.scheduling.writeRelayCredential(input)
  }

  readSchedulingActivity(
    input: import('@pact/contracts').SchedulingActivityRead,
  ): RpcResult<import('@pact/contracts').SchedulingActivityPage> {
    return this.scheduling.readSchedulingActivity(input)
  }

  sessionTitleChanged(sessionId: string): void {
    this.archiveAndQuit.sessionTitleChanged(sessionId)
  }

  subscribeNativePresence(listener: (version: NativePresenceVersion) => void): () => void {
    return this.archiveAndQuit.subscribeNativePresence(listener)
  }

  nativeMetadataChanged(): void {
    this.archiveAndQuit.nativeMetadataChanged()
  }

  nativePresenceVersion(): NativePresenceVersion {
    return this.archiveAndQuit.nativePresenceVersion()
  }

  initializeNativePresence(): Promise<void> {
    return this.archiveAndQuit.initializeNativePresence()
  }

  canPresentUpdateNotice(): boolean {
    return this.gate.canPresentUpdateNotice()
  }

  getNativePresence(): RpcResult<NativePresenceSnapshot> {
    return this.archiveAndQuit.getNativePresence()
  }

  readNativeAttention(input: NativeAttentionReadInput): RpcResult<NativeAttentionPage> {
    return this.archiveAndQuit.readNativeAttention(input)
  }

  prepareNativeQuit(
    input: NativeQuitOperationInput,
    otherPreparationActive = false,
  ): RpcResult<NativeQuitPreparation> {
    return this.archiveAndQuit.prepareNativeQuit(input, otherPreparationActive)
  }

  cancelNativeQuit(
    input: NativeQuitOperationInput,
  ): RpcResult<{ operationId: string; cancelled: true }> {
    return this.archiveAndQuit.cancelNativeQuit(input)
  }

  isQuitSealed(): boolean {
    return this.gate.isQuitSealed()
  }

  isTerminalQuitSealed(): boolean {
    return this.gate.isTerminalQuitSealed()
  }

  prepareWorkspaceArchive(input: WorkspaceArchivePrepareInput): RpcResult<WorkspaceArchivePreview> {
    return this.archiveAndQuit.prepareWorkspaceArchive(input)
  }

  readWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    return this.archiveAndQuit.readWorkspaceArchive(operationId)
  }

  cancelWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    return this.archiveAndQuit.cancelWorkspaceArchive(operationId)
  }

  archiveWorkspace<T>(
    scope: WorkspaceArchiveScope,
    operationId: string | undefined,
    commit: (operationId: string) => RpcResult<T>,
    readCommitted: () => RpcResult<T>,
  ): Promise<RpcResult<T>> {
    return this.archiveAndQuit.archiveWorkspace(scope, operationId, commit, readCommitted)
  }

  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    return this.fork.forkSession(input)
  }

  load(input: ConversationGetInput): Promise<RpcResult<ConversationPage>> {
    return this.core.load(input)
  }

  getRelayDecisionReceipt(raw: RelayDecisionReceiptRead): RpcResult<RelayDecisionReceipt> {
    return this.scheduling.getRelayDecisionReceipt(raw)
  }

  answerRelayDecision(raw: RelayDecisionAnswer): Promise<RpcResult<RelayDecisionReceipt>> {
    return this.scheduling.answerRelayDecision(raw)
  }

  continuePreparedInput(
    raw: import('@pact/contracts').PreparedInputContinue,
  ): Promise<RpcResult<ConversationPatch>> {
    return this.scheduling.continuePreparedInput(raw)
  }

  writeImage(input: ImageWriteInput, owner: string): Promise<RpcResult<ImageWriteState>> {
    return this.core.writeImage(input, owner)
  }

  chooseImages(
    session: string,
    paths: string[],
    owner: string,
  ): Promise<RpcResult<ConversationImage[]>> {
    return this.core.chooseImages(session, paths, owner)
  }

  readImage(input: ImageReadInput, owner: string): Promise<RpcResult<ImageReadPart>> {
    return this.core.readImage(input, owner)
  }

  writeInput(input: ConversationInputWrite, ownerKey: string): RpcResult<ConversationInputState> {
    return this.core.writeInput(input, ownerKey)
  }

  releaseInputOwner(ownerKey: string): void {
    this.core.releaseInputOwner(ownerKey)
  }

  send(input: ConversationSendInput, ownerKey?: string): Promise<RpcResult<ConversationPatch>> {
    return this.sendAndSteer.send(input, ownerKey)
  }

  setConversationQueueEnabled(input: ConversationQueueEnabledInput): RpcResult<ConversationPatch> {
    return this.sendAndSteer.setConversationQueueEnabled(input)
  }

  resumeConversationQueue(input: ConversationQueueActionInput): RpcResult<ConversationPatch> {
    return this.sendAndSteer.resumeConversationQueue(input)
  }

  removeQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): RpcResult<ConversationPatch> {
    return this.sendAndSteer.removeQueuedConversationMessage(input)
  }

  returnQueuedConversationMessage(
    input: ConversationQueueReturnInput,
  ): RpcResult<ConversationPatch> {
    return this.sendAndSteer.returnQueuedConversationMessage(input)
  }

  steerQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return this.sendAndSteer.steerQueuedConversationMessage(input)
  }

  respondNativePermission(input: NativePermissionRespondInput): RpcResult<ConversationPatch> {
    return this.interactions.respondNativePermission(input)
  }

  readNativeInput(input: NativeInputRead): RpcResult<NativeInteractionDetails> {
    return this.interactions.readNativeInput(input)
  }

  respondNativeInput(input: NativeInputRespond): RpcResult<ConversationPatch> {
    return this.interactions.respondNativeInput(input)
  }

  confirmNativeInputURL(input: NativeInputRead): RpcResult<ConversationPatch> {
    return this.interactions.confirmNativeInputURL(input)
  }

  readWorkspaceChanges(input: WorkspaceChangesReadInput): RpcResult<WorkspaceChangesPage> {
    return this.core.readWorkspaceChanges(input)
  }

  readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>> {
    return this.core.readWorkspaceChangeFile(input)
  }

  undoWorkspaceChanges(input: WorkspaceChangesUndoInput): Promise<RpcResult<ConversationPatch>> {
    return this.core.undoWorkspaceChanges(input)
  }

  actOnCollaboration(input: CollaborationActionInput): Promise<RpcResult<ConversationPatch>> {
    return this.collaboration.actOnCollaboration(input)
  }

  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>> {
    return this.collaboration.acceptPeerProposal(input)
  }

  dismissPeerProposal(input: PeerProposalDismissInput): RpcResult<ConversationPatch> {
    return this.collaboration.dismissPeerProposal(input)
  }

  cancelSkillCatalog(sessionId: string): void {
    this.skills.cancelSkillCatalog(sessionId)
  }

  cancelSkillDocument(requestId: string): void {
    this.skills.cancelSkillDocument(requestId)
  }

  readSkillDocument(input: SkillDocumentRead): Promise<RpcResult<SkillDocument>> {
    return this.skills.readSkillDocument(input)
  }

  readSkillCatalog(input: SkillCatalogRead): Promise<RpcResult<SkillCatalogPage>> {
    return this.skills.readSkillCatalog(input)
  }

  stop(input: ConversationStopInput): RpcResult<ConversationPatch> {
    return this.recovery.stop(input)
  }

  retry(input: ConversationRetryInput): Promise<RpcResult<ConversationPatch>> {
    return this.recovery.retry(input)
  }

  rebuildNativeContext(input: NativeContextRebuildInput): Promise<RpcResult<ConversationPatch>> {
    return this.recovery.rebuildNativeContext(input)
  }

  saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>> {
    return this.interactions.saveCommentDraft(input)
  }

  removeCommentDraft(input: CommentDraftRemoveInput): RpcResult<ConversationPatch> {
    return this.interactions.removeCommentDraft(input)
  }

  resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>> {
    return this.interactions.resolveCommentSource(sessionId, commentId)
  }

  setInterests(sessionIds: string[]): RpcResult<{ ready: true }> {
    return this.core.setInterests(sessionIds)
  }

  diagnostics() {
    return this.core.diagnostics()
  }

  subscribe(listener: (patch: ConversationPatch, progress: boolean) => void): () => void {
    return this.core.subscribe(listener)
  }

  subscribeNotifications(listener: (event: SessionNotificationEvent) => void): () => void {
    return this.core.subscribeNotifications(listener)
  }

  dispose(shutdown?: { flushDeadlineAt?: number }): Promise<void> {
    return this.archiveAndQuit.dispose(shutdown)
  }

  createSideChat(input: CreateSideChatInput): Promise<RpcResult<CreateSideChatReceipt>> {
    return this.sideChats.createSideChat(input)
  }

  async readCreateSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): Promise<RpcResult<CreateSideChatReceipt | null>> {
    return this.sideChats.readCreateSideChatReceipt(input)
  }

  async listSideChats(input: ListSideChatsInput): Promise<RpcResult<ListSideChatsPage>> {
    return this.sideChats.listSideChats(input)
  }

  async discardEmptySideChat(
    input: DiscardEmptySideChatInput,
  ): Promise<RpcResult<DiscardEmptySideChatResult>> {
    return this.sideChats.discardEmptySideChat(input)
  }

  async readSyncSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): Promise<RpcResult<SideChatSyncMainReceipt | null>> {
    return this.sideChats.readSyncSideChatReceipt(input)
  }

  syncSideChatToMain(
    input: SideChatSyncMainInput,
    ownerKey?: string,
  ): Promise<RpcResult<SideChatSyncMainReceipt>> {
    return this.sideChats.syncSideChatToMain(input, ownerKey)
  }
}
