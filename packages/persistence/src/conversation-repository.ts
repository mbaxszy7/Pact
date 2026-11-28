import type {
  AgentRun,
  AnchoredComment,
  ClaudePlanCheckpoint,
  CollaborationActionInput,
  CollaborationDocument,
  CollaborationInputBatchReference,
  CollaborationInputObservation,
  CollaborationLimits,
  CollaborationMarkdownNode,
  CollaborationOpenPlanFinalIntentInput,
  CollaborationOpenPlanPublishIntent,
  CollaborationRetainedPlan,
  CollaborationReviewObservation,
  CollaborationTask,
  CommentAnchor,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  ConfirmedUnsentBoundary,
  ConversationGetInput,
  ConversationMessage,
  ConversationMessageRoute,
  ConversationPage,
  ConversationPatch,
  ConversationQueueActionInput,
  ConversationQueueEnabledInput,
  ConversationQueueReturnInput,
  ConversationQueueState,
  ConversationSnapshot,
  CreateSideChatInput,
  CreateSideChatReceipt,
  FrozenSkillInvocation,
  InitialTaskRolesProposal,
  InputRoutingProposal,
  NativeAgentContext,
  NativeBackgroundReport,
  NativeContextRebuildChunk,
  NativeContinuationState,
  NativeInitializationWitness,
  NativeProbeResult,
  NativeRebuildOperation,
  NativeRecoveredOutput,
  NormalizedAgentEvent,
  OriginSideChat,
  PreparedInputContinuation,
  PreparedInputContinue,
  PreparedInputMetadata,
  RebuildInputRecovery,
  RelayDecisionAnswer,
  RelayDecisionMaterial,
  RelayDecisionReceipt,
  RelaySchedulingDecision,
  RunEffectiveExecutionSettings,
  RunFailureKind,
  RunRequestedExecutionSettings,
  RuntimeAgentId,
  SchedulingHandoff,
  SideChatSyncMainInput,
  SideChatSyncMainReceipt,
  TaskStageRoles,
  UserClarification,
  WorkspaceArchiveScope,
  WorkspaceChangeSet,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import type { ConversationRepositoryHost } from './conversation-repository/context.js'
import type {
  BackgroundReportIdentity,
  BeginRoutedContinuationInput,
  BeginRunInput,
  BeginRunResult,
  CompleteAnswerMetadata,
  ConversationInputReceipt,
  ConversationInputWrite,
  FrozenCollaborationAuthorization,
  FrozenInputBatchPage,
  HandoffBundle,
  ImageAssetRecord,
  PreparedInputDispatch,
  RelayWorkflowAlternative,
  RelayWorkflowSnapshot,
  StreamDeltaEvent,
  WorkflowInputsPage,
} from './conversation-repository/types.js'
import type { PactDrizzleDatabase } from './drizzle-database.js'
import type { nativeForkIntents } from './schema/index.js'
import type {
  CapturedCutoffRecord,
  CutoffCatalogItem,
  CutoffInlineTailResult,
  CutoffSourcePage,
  MessageOriginCutoffInfo,
  PrepareMainSyncBackResult,
  SideChatAnchorCutoffInfo,
} from './side-chat-persistence.js'

import * as forkFacts from './conversation-fork.js'
import * as collaborationQueries from './conversation-repository/collaboration-queries.js'
import * as eventStreamQueries from './conversation-repository/event-stream-queries.js'
import * as handoffSourceQueries from './conversation-repository/handoff-source-queries.js'
import { createSourceQueries } from './conversation-repository/helpers.js'
import * as mediaAndBodyQueries from './conversation-repository/media-and-body-queries.js'
import * as messageWindowQueries from './conversation-repository/message-window-queries.js'
import * as nativeRebuildQueries from './conversation-repository/native-rebuild-queries.js'
import * as preparedInputQueries from './conversation-repository/prepared-input-queries.js'
import * as queueAndSteerQueries from './conversation-repository/queue-and-steer-queries.js'
import * as relayDecisionQueries from './conversation-repository/relay-decision-queries.js'
import * as runLifecycleQueries from './conversation-repository/run-lifecycle-queries.js'
import * as schedulingQueries from './conversation-repository/scheduling-queries.js'
import * as workflowPlanQueries from './conversation-repository/workflow-plan-queries.js'
import * as scheduling from './conversation-scheduling.js'
import { WorkspaceArchiveRepository } from './workspace-archive-repository.js'

export {
  RunOperationConflictError,
  HANDOFF_SAFETY_BYTES,
  HANDOFF_READ_DEADLINE_MS,
  PreparedInformationConflictError,
  CommentLimitError,
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
  StaleConversationCursorError,
  OversizedConversationEntityError,
  type HandoffBundle,
  type HandoffSourceRef,
  type InputBatchReference,
  type FrozenCollaborationAuthorization,
  type FrozenInputBatchPage,
  type WorkflowInputsPage,
  type RunSourcesPage,
  type ConversationInputWrite,
  type ConversationInputReceipt,
  type CompleteAnswerMetadata,
  type ImageAssetRecord,
  type RelayWorkflowTurnSource,
  type RelayWorkflowAlternative,
  type RelayWorkflowSnapshot,
  type BeginRunInput,
  type PreparedInputDispatch,
  type BeginRunResult,
  type BeginRoutedContinuationInput,
  type StreamDeltaEvent,
} from './conversation-repository/types.js'

export class ConversationRepository {
  readonly archives: WorkspaceArchiveRepository
  private readonly host: ConversationRepositoryHost

  constructor(database: PactDrizzleDatabase) {
    this.archives = new WorkspaceArchiveRepository(database)
    const host: ConversationRepositoryHost = {
      database,
      archives: this.archives,
      schedulingListeners: new Set(),
      schedulingRecoveryEpoch: undefined,
      observations: new Map(),
      handoffSourceAgentsCache: new Map(),
      completeReadCount: 0,
      pageReadCount: 0,
      patchCount: 0,
      eventTransactionCount: 0,
      streamLookups: {
        text: { queries: 0, returnedRows: 0 },
        activity: { queries: 0, returnedRows: 0 },
      },
      sourceQueries: createSourceQueries(database),
      recordSchedulingRecoveryOrigin: (...args) =>
        schedulingQueries.recordSchedulingRecoveryOrigin(host, ...args),
      refreshSchedulingRecoveryFacts: (...args) =>
        schedulingQueries.refreshSchedulingRecoveryFacts(host, ...args),
      cancelSchedulingRecoveryFaults: (...args) =>
        schedulingQueries.cancelSchedulingRecoveryFaults(host, ...args),
      schedulingChanged: (...args) => schedulingQueries.schedulingChanged(host, ...args),
      recordSchedulingBusinessActivity: (...args) =>
        schedulingQueries.recordSchedulingBusinessActivity(host, ...args),
      schedulingSettings: (...args) => schedulingQueries.schedulingSettings(host, ...args),
      schedulingConfigurationGeneration: (...args) =>
        schedulingQueries.schedulingConfigurationGeneration(host, ...args),
      nativeIssueMetadata: (...args) => nativeRebuildQueries.nativeIssueMetadata(host, ...args),
      nativeMetadataTransaction: (...args) =>
        nativeRebuildQueries.nativeMetadataTransaction(host, ...args),
      imagesForMessages: (...args) => mediaAndBodyQueries.imagesForMessages(host, ...args),
      imagesForMessage: (...args) => mediaAndBodyQueries.imagesForMessage(host, ...args),
      messageImageMetadata: (...args) => mediaAndBodyQueries.messageImageMetadata(host, ...args),
      resolveMessageImages: (...args) => mediaAndBodyQueries.resolveMessageImages(host, ...args),
      sweepConversationInputs: (...args) =>
        mediaAndBodyQueries.sweepConversationInputs(host, ...args),
      bodyHasText: (...args) => mediaAndBodyQueries.bodyHasText(host, ...args),
      bodyInput: (...args) => mediaAndBodyQueries.bodyInput(host, ...args),
      bodyCapacity: (...args) => mediaAndBodyQueries.bodyCapacity(host, ...args),
      writeConversationInput: (...args) =>
        mediaAndBodyQueries.writeConversationInput(host, ...args),
      appendBodyPart: (...args) => mediaAndBodyQueries.appendBodyPart(host, ...args),
      readBody: (...args) => mediaAndBodyQueries.readBody(host, ...args),
      sealBody: (...args) => mediaAndBodyQueries.sealBody(host, ...args),
      forkOperation: (...args) => mediaAndBodyQueries.forkOperation(host, ...args),
      metadataPatch: (...args) => messageWindowQueries.metadataPatch(host, ...args),
      sessionHasNativeWork: (...args) => mediaAndBodyQueries.sessionHasNativeWork(host, ...args),
      inputBatchForMessage: (...args) => handoffSourceQueries.inputBatchForMessage(host, ...args),
      inputBatchForRun: (...args) => handoffSourceQueries.inputBatchForRun(host, ...args),
      preparedInputSources: (...args) => preparedInputQueries.preparedInputSources(host, ...args),
      userInformation: (...args) => preparedInputQueries.userInformation(host, ...args),
      freezeUserInformation: (...args) => preparedInputQueries.freezeUserInformation(host, ...args),
      preparedInputHandoff: (...args) => preparedInputQueries.preparedInputHandoff(host, ...args),
      preparedSourceText: (...args) => preparedInputQueries.preparedSourceText(host, ...args),
      preparedInformation: (...args) => preparedInputQueries.preparedInformation(host, ...args),
      writePreparedInformation: (...args) =>
        preparedInputQueries.writePreparedInformation(host, ...args),
      supersedePausedPreparedInput: (...args) =>
        preparedInputQueries.supersedePausedPreparedInput(host, ...args),
      preparedExecutionFacts: (...args) =>
        preparedInputQueries.preparedExecutionFacts(host, ...args),
      readPreparedInput: (...args) => preparedInputQueries.readPreparedInput(host, ...args),
      isCancelledPreparedInformation: (...args) =>
        preparedInputQueries.isCancelledPreparedInformation(host, ...args),
      closeCancelledPreparedInformation: (...args) =>
        preparedInputQueries.closeCancelledPreparedInformation(host, ...args),
      restorePreparedInformationDrafts: (...args) =>
        preparedInputQueries.restorePreparedInformationDrafts(host, ...args),
      preparedOriginalRequest: (...args) =>
        preparedInputQueries.preparedOriginalRequest(host, ...args),
      cancelPreparedInputDispatch: (...args) =>
        preparedInputQueries.cancelPreparedInputDispatch(host, ...args),
      preparedInputRecipient: (...args) =>
        preparedInputQueries.preparedInputRecipient(host, ...args),
      preparedInitialTaskRoles: (...args) =>
        preparedInputQueries.preparedInitialTaskRoles(host, ...args),
      admittedPreparedInputSelection: (...args) =>
        preparedInputQueries.admittedPreparedInputSelection(host, ...args),
      finalizePreparedInputDispatch: (...args) =>
        preparedInputQueries.finalizePreparedInputDispatch(host, ...args),
      freezeInputBatch: (...args) => handoffSourceQueries.freezeInputBatch(host, ...args),
      freezeCollaborationAuthorization: (...args) =>
        handoffSourceQueries.freezeCollaborationAuthorization(host, ...args),
      sealInputBatchSources: (...args) => handoffSourceQueries.sealInputBatchSources(host, ...args),
      latestSteerGrant: (...args) => handoffSourceQueries.latestSteerGrant(host, ...args),
      documentReference: (...args) => handoffSourceQueries.documentReference(host, ...args),
      messageDocument: (...args) => handoffSourceQueries.messageDocument(host, ...args),
      runHasRecordedCodeChanges: (...args) =>
        handoffSourceQueries.runHasRecordedCodeChanges(host, ...args),
      recordWorkflowPlan: (...args) => workflowPlanQueries.recordWorkflowPlan(host, ...args),
      recordWorkflowPlanRetained: (...args) =>
        workflowPlanQueries.recordWorkflowPlanRetained(host, ...args),
      recordWorkflowPlanUnavailable: (...args) =>
        workflowPlanQueries.recordWorkflowPlanUnavailable(host, ...args),
      recordOpenPlanFinalIntent: (...args) =>
        workflowPlanQueries.recordOpenPlanFinalIntent(host, ...args),
      workflowOpenPlanPublishIntents: (...args) =>
        workflowPlanQueries.workflowOpenPlanPublishIntents(host, ...args),
      readOpenPlanPublishIntentText: (...args) =>
        workflowPlanQueries.readOpenPlanPublishIntentText(host, ...args),
      projectAppliedPlanUnavailable: (...args) =>
        workflowPlanQueries.projectAppliedPlanUnavailable(host, ...args),
      workflowPlanCaptureFailed: (...args) =>
        workflowPlanQueries.workflowPlanCaptureFailed(host, ...args),
      workflowPlanSettlement: (...args) =>
        workflowPlanQueries.workflowPlanSettlement(host, ...args),
      workflowPlanSettled: (...args) => workflowPlanQueries.workflowPlanSettled(host, ...args),
      workflowPlanRetention: (...args) => workflowPlanQueries.workflowPlanRetention(host, ...args),
      workflowPlanHasUnansweredInput: (...args) =>
        workflowPlanQueries.workflowPlanHasUnansweredInput(host, ...args),
      workflowPlanRecoveryState: (...args) =>
        workflowPlanQueries.workflowPlanRecoveryState(host, ...args),
      needsWorkflowPlanRecovery: (...args) =>
        workflowPlanQueries.needsWorkflowPlanRecovery(host, ...args),
      settleWorkflowPlan: (...args) => workflowPlanQueries.settleWorkflowPlan(host, ...args),
      recoverAppliedWorkflowResult: (...args) =>
        workflowPlanQueries.recoverAppliedWorkflowResult(host, ...args),
      workflowInputResult: (...args) => workflowPlanQueries.workflowInputResult(host, ...args),
      recordWorkflowInputResult: (...args) =>
        workflowPlanQueries.recordWorkflowInputResult(host, ...args),
      currentReplyIntent: (...args) => workflowPlanQueries.currentReplyIntent(host, ...args),
      finishAskOnly: (...args) => workflowPlanQueries.finishAskOnly(host, ...args),
      restoreAskCheckpoint: (...args) => workflowPlanQueries.restoreAskCheckpoint(host, ...args),
      settleWorkflowInput: (...args) => workflowPlanQueries.settleWorkflowInput(host, ...args),
      workflowReviewResult: (...args) => workflowPlanQueries.workflowReviewResult(host, ...args),
      recordWorkflowReview: (...args) => workflowPlanQueries.recordWorkflowReview(host, ...args),
      registerWorkflowInput: (...args) => workflowPlanQueries.registerWorkflowInput(host, ...args),
      isInTaskReviewCommand: (...args) => workflowPlanQueries.isInTaskReviewCommand(host, ...args),
      collaborationTurnAuthorization: (...args) =>
        workflowPlanQueries.collaborationTurnAuthorization(host, ...args),
      quotedSource: (...args) => handoffSourceQueries.quotedSource(host, ...args),
      freezeRunSources: (...args) => handoffSourceQueries.freezeRunSources(host, ...args),
      sourceDocumentAuthorized: (...args) =>
        handoffSourceQueries.sourceDocumentAuthorized(host, ...args),
      collaborationContextSuffix: (...args) =>
        handoffSourceQueries.collaborationContextSuffix(host, ...args),
      readRunArtifacts: (...args) => handoffSourceQueries.readRunArtifacts(host, ...args),
      receivedBodyPreview: (...args) => handoffSourceQueries.receivedBodyPreview(host, ...args),
      activePairForSession: (...args) => queueAndSteerQueries.activePairForSession(host, ...args),
      queuedSteerDelivery: (...args) => queueAndSteerQueries.queuedSteerDelivery(host, ...args),
      queueState: (...args) => queueAndSteerQueries.queueState(host, ...args),
      advanceQueue: (...args) => queueAndSteerQueries.advanceQueue(host, ...args),
      requireInstalledQueueReturn: (...args) =>
        queueAndSteerQueries.requireInstalledQueueReturn(host, ...args),
      consumeQueuedReturn: (...args) => queueAndSteerQueries.consumeQueuedReturn(host, ...args),
      readQueuedInputSource: (...args) => queueAndSteerQueries.readQueuedInputSource(host, ...args),
      receivedCollaborationInput: (...args) =>
        collaborationQueries.receivedCollaborationInput(host, ...args),
      assertDecisionInput: (...args) => collaborationQueries.assertDecisionInput(host, ...args),
      receiveCollaborationInput: (...args) =>
        collaborationQueries.receiveCollaborationInput(host, ...args),
      readReceivedInput: (...args) => collaborationQueries.readReceivedInput(host, ...args),
      collaboration: (...args) => collaborationQueries.collaboration(host, ...args),
      saveCollaborationDocument: (...args) =>
        collaborationQueries.saveCollaborationDocument(host, ...args),
      collaborationDocumentRow: (...args) =>
        collaborationQueries.collaborationDocumentRow(host, ...args),
      collaborationCommentDocument: (...args) =>
        collaborationQueries.collaborationCommentDocument(host, ...args),
      collaborationRawRange: (...args) => collaborationQueries.collaborationRawRange(host, ...args),
      collaborationQuote: (...args) => collaborationQueries.collaborationQuote(host, ...args),
      collaborationDocumentText: (...args) =>
        collaborationQueries.collaborationDocumentText(host, ...args),
      storedCollaboration: (...args) => collaborationQueries.storedCollaboration(host, ...args),
      assertWorkflowDispatch: (...args) =>
        collaborationQueries.assertWorkflowDispatch(host, ...args),
      decodedCollaboration: (...args) => collaborationQueries.decodedCollaboration(host, ...args),
      withdrawInputBatch: (...args) => collaborationQueries.withdrawInputBatch(host, ...args),
      saveCollaboration: (...args) => collaborationQueries.saveCollaboration(host, ...args),
      planRevisionBasisMatches: (...args) =>
        collaborationQueries.planRevisionBasisMatches(host, ...args),
      replaceCollaborationTask: (...args) =>
        collaborationQueries.replaceCollaborationTask(host, ...args),
      collaborationReplacementProjection: (...args) =>
        collaborationQueries.collaborationReplacementProjection(host, ...args),
      workflowInputWasNotSent: (...args) =>
        collaborationQueries.workflowInputWasNotSent(host, ...args),
      finishCollaboration: (...args) => collaborationQueries.finishCollaboration(host, ...args),
      internalMessage: (...args) => messageWindowQueries.internalMessage(host, ...args),
      messageChange: (...args) => messageWindowQueries.messageChange(host, ...args),
      activityChange: (...args) => messageWindowQueries.activityChange(host, ...args),
      createPatch: (...args) => messageWindowQueries.createPatch(host, ...args),
      submittedRunReceipt: (...args) => messageWindowQueries.submittedRunReceipt(host, ...args),
      actionReceiptBasis: (...args) => collaborationQueries.actionReceiptBasis(host, ...args),
      authorityJson: (...args) => collaborationQueries.authorityJson(host, ...args),
      activeRelayDecisionRow: (...args) =>
        relayDecisionQueries.activeRelayDecisionRow(host, ...args),
      relayWorkflowActionExecutionFingerprint: (...args) =>
        relayDecisionQueries.relayWorkflowActionExecutionFingerprint(host, ...args),
      codeRoleChangeAvailable: (...args) =>
        relayDecisionQueries.codeRoleChangeAvailable(host, ...args),
      relayWorkflowActionNext: (...args) =>
        relayDecisionQueries.relayWorkflowActionNext(host, ...args),
      planReviewLimits: (...args) => relayDecisionQueries.planReviewLimits(host, ...args),
      planReviewLimitReached: (...args) =>
        relayDecisionQueries.planReviewLimitReached(host, ...args),
      planReviewExtensionAvailable: (...args) =>
        relayDecisionQueries.planReviewExtensionAvailable(host, ...args),
      isUnansweredRelaySuggestion: (...args) =>
        relayDecisionQueries.isUnansweredRelaySuggestion(host, ...args),
      discardUnansweredRelaySchedulingDecision: (...args) =>
        relayDecisionQueries.discardUnansweredRelaySchedulingDecision(host, ...args),
      relayDecisionReceipt: (...args) => relayDecisionQueries.relayDecisionReceipt(host, ...args),
      retireRelayDecisionGates: (...args) =>
        relayDecisionQueries.retireRelayDecisionGates(host, ...args),
      recoverRelayDecisionGates: (...args) =>
        relayDecisionQueries.recoverRelayDecisionGates(host, ...args),
      assertRelayDecisionResolved: (...args) =>
        relayDecisionQueries.assertRelayDecisionResolved(host, ...args),
      collaborationActionProjection: (...args) =>
        collaborationQueries.collaborationActionProjection(host, ...args),
      collaborationActionReceipt: (...args) =>
        collaborationQueries.collaborationActionReceipt(host, ...args),
      unfinishedWriteSource: (...args) => collaborationQueries.unfinishedWriteSource(host, ...args),
      originalWriteAuthority: (...args) =>
        collaborationQueries.originalWriteAuthority(host, ...args),
      originalWriteReceipt: (...args) => collaborationQueries.originalWriteReceipt(host, ...args),
      cancelPreparedCollaborationAction: (...args) =>
        collaborationQueries.cancelPreparedCollaborationAction(host, ...args),
      admitCollaborationAction: (...args) =>
        collaborationQueries.admitCollaborationAction(host, ...args),
      settleCollaborationAction: (...args) =>
        collaborationQueries.settleCollaborationAction(host, ...args),
      workflowHandoff: (...args) => handoffSourceQueries.workflowHandoff(host, ...args),
      recoveryHandoff: (...args) => handoffSourceQueries.recoveryHandoff(host, ...args),
      assertSchedulingFreshness: (...args) =>
        schedulingQueries.assertSchedulingFreshness(host, ...args),
      relayCompletedTurn: (...args) => relayDecisionQueries.relayCompletedTurn(host, ...args),
      relayWorkflowBusinessSources: (...args) =>
        relayDecisionQueries.relayWorkflowBusinessSources(host, ...args),
      relayWorkflowSnapshot: (...args) => relayDecisionQueries.relayWorkflowSnapshot(host, ...args),
      freezeRelayWorkflowSources: (...args) =>
        relayDecisionQueries.freezeRelayWorkflowSources(host, ...args),
      workflowDecisionMessageHasImages: (...args) =>
        relayDecisionQueries.workflowDecisionMessageHasImages(host, ...args),
      planRevisionDocumentChunks: (...args) =>
        handoffSourceQueries.planRevisionDocumentChunks(host, ...args),
      planRevisionAnchorText: (...args) =>
        handoffSourceQueries.planRevisionAnchorText(host, ...args),
      planRevisionAnchorTarget: (...args) =>
        handoffSourceQueries.planRevisionAnchorTarget(host, ...args),
      decisionEvaluationReceipt: (...args) =>
        schedulingQueries.decisionEvaluationReceipt(host, ...args),
      schedulingBudget: (...args) => schedulingQueries.schedulingBudget(host, ...args),
      handoffReceipt: (...args) => schedulingQueries.handoffReceipt(host, ...args),
      executionInput: (...args) => runLifecycleQueries.executionInput(host, ...args),
      hasPendingRoutedContinuation: (...args) =>
        runLifecycleQueries.hasPendingRoutedContinuation(host, ...args),
      cancelPendingRoutedContinuation: (...args) =>
        runLifecycleQueries.cancelPendingRoutedContinuation(host, ...args),
      retirePendingRoute: (...args) => runLifecycleQueries.retirePendingRoute(host, ...args),
      runPatch: (...args) => messageWindowQueries.runPatch(host, ...args),
      ownsNativeControl: (...args) => nativeRebuildQueries.ownsNativeControl(host, ...args),
      ownsBackgroundControl: (...args) => nativeRebuildQueries.ownsBackgroundControl(host, ...args),
      mayProjectNativeBody: (...args) => nativeRebuildQueries.mayProjectNativeBody(host, ...args),
      nativeFact: (...args) => nativeRebuildQueries.nativeFact(host, ...args),
      runSettingsAt: (...args) => nativeRebuildQueries.runSettingsAt(host, ...args),
      observationUnavailable: (...args) =>
        nativeRebuildQueries.observationUnavailable(host, ...args),
      isCurrentNativeCursor: (...args) => nativeRebuildQueries.isCurrentNativeCursor(host, ...args),
      latestAgentRun: (...args) => nativeRebuildQueries.latestAgentRun(host, ...args),
      hasCompleteResponse: (...args) => nativeRebuildQueries.hasCompleteResponse(host, ...args),
      bindingHasUnsettledWork: (...args) =>
        nativeRebuildQueries.bindingHasUnsettledWork(host, ...args),
      settleKnownNativeEnding: (...args) =>
        nativeRebuildQueries.settleKnownNativeEnding(host, ...args),
      nativeRebuildOperation: (...args) =>
        nativeRebuildQueries.nativeRebuildOperation(host, ...args),
      pendingNativeRebuild: (...args) => nativeRebuildQueries.pendingNativeRebuild(host, ...args),
      lastNativeRebuild: (...args) => nativeRebuildQueries.lastNativeRebuild(host, ...args),
      beginNativeRebuild: (...args) => nativeRebuildQueries.beginNativeRebuild(host, ...args),
      parseReturnedInput: (...args) => nativeRebuildQueries.parseReturnedInput(host, ...args),
      rebuildInputRecovery: (...args) => nativeRebuildQueries.rebuildInputRecovery(host, ...args),
      verifyReturnedInput: (...args) => nativeRebuildQueries.verifyReturnedInput(host, ...args),
      readReturnedInput: (...args) => nativeRebuildQueries.readReturnedInput(host, ...args),
      comment: (...args) => mediaAndBodyQueries.comment(host, ...args),
      findRun: (...args) => runLifecycleQueries.findRun(host, ...args),
      commitEvents: (...args) => eventStreamQueries.commitEvents(host, ...args),
      nativeContexts: (...args) => nativeRebuildQueries.nativeContexts(host, ...args),
      nativeRecoveryBlocksInput: (...args) =>
        nativeRebuildQueries.nativeRecoveryBlocksInput(host, ...args),
      nativeContext: (...args) => nativeRebuildQueries.nativeContext(host, ...args),
      toRun: (...args) => messageWindowQueries.toRun(host, ...args),
      rebuildOperations: (...args) => nativeRebuildQueries.rebuildOperations(host, ...args),
      projectNativeContext: (...args) => messageWindowQueries.projectNativeContext(host, ...args),
    }
    this.host = host
  }

  beginSchedulingRecoveryEpoch(epoch: string): void {
    return schedulingQueries.beginSchedulingRecoveryEpoch(this.host, epoch)
  }

  refreshSchedulingRecoveryFacts(sessionId: string): void {
    return schedulingQueries.refreshSchedulingRecoveryFacts(this.host, sessionId)
  }

  takeSchedulingRecoveryFaults() {
    return schedulingQueries.takeSchedulingRecoveryFaults(this.host)
  }

  armSchedulingRecoveryFaults(sessionId: string): void {
    return schedulingQueries.armSchedulingRecoveryFaults(this.host, sessionId)
  }

  cancelSchedulingRecoveryFaults(sessionId: string): void {
    return schedulingQueries.cancelSchedulingRecoveryFaults(this.host, sessionId)
  }

  reserveSchedulingRecoveryCheck(faultId: string, node: SchedulingHandoff, utilityPid: number) {
    return schedulingQueries.reserveSchedulingRecoveryCheck(this.host, faultId, node, utilityPid)
  }

  startSchedulingRecoveryCheck(id: string): void {
    return schedulingQueries.startSchedulingRecoveryCheck(this.host, id)
  }

  recordSchedulingCheckPhysicalOwner(id: string, owner: unknown): void {
    return schedulingQueries.recordSchedulingCheckPhysicalOwner(this.host, id, owner)
  }

  settleSchedulingRecoveryCheck(
    id: string,
    input: Parameters<typeof scheduling.settleRecoveryCheck>[2],
  ): void {
    return schedulingQueries.settleSchedulingRecoveryCheck(this.host, id, input)
  }

  schedulingRecoveryAttempt(id: string) {
    return schedulingQueries.schedulingRecoveryAttempt(this.host, id)
  }

  subscribeSchedulingChanges(listener: () => void): () => void {
    return schedulingQueries.subscribeSchedulingChanges(this.host, listener)
  }

  schedulingSettings() {
    return schedulingQueries.schedulingSettings(this.host)
  }

  schedulingConfigurationFingerprint(): string {
    return schedulingQueries.schedulingConfigurationFingerprint(this.host)
  }

  schedulingConfigurationGeneration(): number {
    return schedulingQueries.schedulingConfigurationGeneration(this.host)
  }

  saveSchedulingSettings(
    input: Parameters<typeof scheduling.saveSettings>[1],
    publishInvalidated?: (patch: ConversationPatch) => void,
  ) {
    return schedulingQueries.saveSchedulingSettings(this.host, input, publishInvalidated)
  }

  readSchedulingActivity(input: Parameters<typeof scheduling.readActivity>[1]) {
    return schedulingQueries.readSchedulingActivity(this.host, input)
  }

  readRelayCredential(): { ciphertext: string | null; revision: number } {
    return schedulingQueries.readRelayCredential(this.host)
  }

  writeRelayCredential(
    input: import('@pact/contracts').RelayCredentialWrite,
    publishInvalidated?: (patch: ConversationPatch) => void,
  ): import('@pact/contracts').RelayCredentialReceipt {
    return schedulingQueries.writeRelayCredential(this.host, input, publishInvalidated)
  }

  readRelayCredentialReceipt(
    nonce: string,
  ): import('@pact/contracts').RelayCredentialReceipt | undefined {
    return schedulingQueries.readRelayCredentialReceipt(this.host, nonce)
  }

  rotateRelayCredentialCiphertext(
    revision: number,
    expectedCiphertext: string,
    ciphertext: string,
  ): boolean {
    return schedulingQueries.rotateRelayCredentialCiphertext(
      this.host,
      revision,
      expectedCiphertext,
      ciphertext,
    )
  }

  recoverAbandonedBodyInputs(): void {
    return mediaAndBodyQueries.recoverAbandonedBodyInputs(this.host)
  }

  nativeIssueMetadata(sessionId: string): import('@pact/contracts').SessionIssues {
    return nativeRebuildQueries.nativeIssueMetadata(this.host, sessionId)
  }

  nativeRunStatus(runId: string): AgentRun['status'] | undefined {
    return nativeRebuildQueries.nativeRunStatus(this.host, runId)
  }

  refreshNativeAttention(sessionId: string): void {
    return nativeRebuildQueries.refreshNativeAttention(this.host, sessionId)
  }

  initializeNativeAttention(sessionIds: string[]): void {
    return nativeRebuildQueries.initializeNativeAttention(this.host, sessionIds)
  }

  nativeQuitUnsettled(excludedIds: string[]): { count: number; sessionIds: string[] } {
    return nativeRebuildQueries.nativeQuitUnsettled(this.host, excludedIds)
  }

  imageRecord(id: string): ImageAssetRecord | undefined {
    return mediaAndBodyQueries.imageRecord(this.host, id)
  }

  beginImage(
    sessionId: string,
    clientImageId: string,
    name: string,
    ownerKey: string,
  ): ImageAssetRecord {
    return mediaAndBodyQueries.beginImage(this.host, sessionId, clientImageId, name, ownerKey)
  }

  assertImageCapacity(ownerKey: string, addedBytes: number, newIdentity = false): void {
    return mediaAndBodyQueries.assertImageCapacity(this.host, ownerKey, addedBytes, newIdentity)
  }

  advanceImage(
    id: string,
    sessionId: string,
    ownerKey: string,
    expectedOffset: number,
    nextOffset: number,
  ): ImageAssetRecord {
    return mediaAndBodyQueries.advanceImage(
      this.host,
      id,
      sessionId,
      ownerKey,
      expectedOffset,
      nextOffset,
    )
  }

  sealImage(
    id: string,
    sessionId: string,
    ownerKey: string,
    meta: ConversationImage,
    thumbnailBytes: number,
  ): ConversationImage {
    return mediaAndBodyQueries.sealImage(this.host, id, sessionId, ownerKey, meta, thumbnailBytes)
  }

  imageStorageObjectId(id: string): string | undefined {
    return mediaAndBodyQueries.imageStorageObjectId(this.host, id)
  }

  imageStorageObjectReferenced(storageObjectId: string): boolean {
    return mediaAndBodyQueries.imageStorageObjectReferenced(this.host, storageObjectId)
  }

  releaseImageAsset(
    id: string,
    sessionId: string,
    ownerKey: string,
  ): { released: boolean; deleteStorageObjectId: string | null } {
    return mediaAndBodyQueries.releaseImageAsset(this.host, id, sessionId, ownerKey)
  }

  releaseImage(id: string, sessionId: string, ownerKey: string): boolean {
    return mediaAndBodyQueries.releaseImage(this.host, id, sessionId, ownerKey)
  }

  temporaryImages(ownerKey?: string, restart = false): ImageAssetRecord[] {
    return mediaAndBodyQueries.temporaryImages(this.host, ownerKey, restart)
  }

  imagesForMessage(messageId: string, sessionId?: string): ConversationImage[] {
    return mediaAndBodyQueries.imagesForMessage(this.host, messageId, sessionId)
  }

  imageAccessible(sessionId: string, id: string, ownerKey?: string): boolean {
    return mediaAndBodyQueries.imageAccessible(this.host, sessionId, id, ownerKey)
  }

  resolveMessageImages(sessionId: string, ids: string[], ownerKey?: string): ConversationImage[] {
    return mediaAndBodyQueries.resolveMessageImages(this.host, sessionId, ids, ownerKey)
  }

  sweepConversationInputs(ownerKey?: string): void {
    return mediaAndBodyQueries.sweepConversationInputs(this.host, ownerKey)
  }

  releaseConversationInputs(ownerKey: string): void {
    return mediaAndBodyQueries.releaseConversationInputs(this.host, ownerKey)
  }

  captureCutoff(input: {
    sourceSessionId: string
    ownerKind: 'side_chat' | 'sync_main'
    ownerOperationId: string
  }): CapturedCutoffRecord {
    return mediaAndBodyQueries.captureCutoff(this.host, input)
  }

  readCutoffSource(
    input: {
      cutoffId: string
      part: 'catalog' | 'message' | 'comments' | 'comment'
      messageId?: string | undefined
      commentId?: string | undefined
      offset: number
    },
    fits?: (page: {
      offset: number
      nextOffset: number | null
      text: string
      items?: CutoffCatalogItem[]
    }) => boolean,
  ): CutoffSourcePage {
    return mediaAndBodyQueries.readCutoffSource(this.host, input, fits)
  }

  buildCutoffInlineTail(cutoffId: string, maxBytes?: number): CutoffInlineTailResult {
    return mediaAndBodyQueries.buildCutoffInlineTail(this.host, cutoffId, maxBytes)
  }

  createSideChat(
    input: CreateSideChatInput,
    options?: { resolveVisibleText?: (content: string) => string },
  ): CreateSideChatReceipt {
    return mediaAndBodyQueries.createSideChat(this.host, input, options)
  }

  readCreateSideChatReceipt(operationId: string): CreateSideChatReceipt | undefined {
    return mediaAndBodyQueries.readCreateSideChatReceipt(this.host, operationId)
  }

  prepareMainSyncBack(
    input: SideChatSyncMainInput,
    imageOwnerKey?: string,
    resolvedContent?: string,
    options?: { resolveVisibleText?: (content: string) => string },
  ): PrepareMainSyncBackResult {
    return mediaAndBodyQueries.prepareMainSyncBack(
      this.host,
      input,
      imageOwnerKey,
      resolvedContent,
      options,
    )
  }

  hasSideChatDrafts(sideChatId: string): boolean {
    return mediaAndBodyQueries.hasSideChatDrafts(this.host, sideChatId)
  }

  completeMainSyncBackReceipt(receipt: SideChatSyncMainReceipt): SideChatSyncMainReceipt {
    return mediaAndBodyQueries.completeMainSyncBackReceipt(this.host, receipt)
  }

  readSyncSideChatReceipt(operationId: string): SideChatSyncMainReceipt | undefined {
    return mediaAndBodyQueries.readSyncSideChatReceipt(this.host, operationId)
  }

  rollbackMainSyncBack(operationId: string): boolean {
    return mediaAndBodyQueries.rollbackMainSyncBack(this.host, operationId)
  }

  deliveredCutoffIds(
    sessionId: string,
    agentId: RuntimeAgentId,
    expectedBindingGeneration?: number,
  ): string[] {
    return mediaAndBodyQueries.deliveredCutoffIds(
      this.host,
      sessionId,
      agentId,
      expectedBindingGeneration,
    )
  }

  markCutoffsDelivered(
    sessionId: string,
    agentId: RuntimeAgentId,
    bindingGeneration: number,
    cutoffIds: string[],
  ): string[] {
    return mediaAndBodyQueries.markCutoffsDelivered(
      this.host,
      sessionId,
      agentId,
      bindingGeneration,
      cutoffIds,
    )
  }

  sideChatAnchorCutoff(sessionId: string): SideChatAnchorCutoffInfo | undefined {
    return mediaAndBodyQueries.sideChatAnchorCutoff(this.host, sessionId)
  }

  messageOriginCutoffs(
    sessionId: string,
    messageIds: readonly string[],
  ): MessageOriginCutoffInfo[] {
    return mediaAndBodyQueries.messageOriginCutoffs(this.host, sessionId, messageIds)
  }

  discardEmptySideChat(sideChatId: string): boolean {
    return mediaAndBodyQueries.discardEmptySideChat(this.host, sideChatId)
  }

  writeConversationInput(
    input: ConversationInputWrite,
    ownerKey: string,
  ): ConversationInputReceipt {
    return mediaAndBodyQueries.writeConversationInput(this.host, input, ownerKey)
  }

  ownsTemporaryConversationInput(sessionId: string, inputId: string, ownerKey: string): boolean {
    return mediaAndBodyQueries.ownsTemporaryConversationInput(
      this.host,
      sessionId,
      inputId,
      ownerKey,
    )
  }

  resolveConversationInput(
    sessionId: string,
    clientMessageId: string,
    inputId: string,
    ownerKey: string,
  ): string {
    return mediaAndBodyQueries.resolveConversationInput(
      this.host,
      sessionId,
      clientMessageId,
      inputId,
      ownerKey,
    )
  }

  consumeConversationInput(sessionId: string, inputId: string, ownerKey: string): void {
    return mediaAndBodyQueries.consumeConversationInput(this.host, sessionId, inputId, ownerKey)
  }

  selectForkSource(
    sourceSessionId: string,
    messageId: string,
    settings: import('@pact/contracts').SessionSettings,
    expectedSettingsRevision: number,
  ) {
    return mediaAndBodyQueries.selectForkSource(
      this.host,
      sourceSessionId,
      messageId,
      settings,
      expectedSettingsRevision,
    )
  }

  forkResponse(runId: string, sequence: number) {
    return mediaAndBodyQueries.forkResponse(this.host, runId, sequence)
  }

  commitFork(
    operationId: string,
    selection: forkFacts.ForkSelection,
    boundaries: Partial<Record<RuntimeAgentId, import('@pact/contracts').AgentNativeForkBoundary>>,
    fullConsent: RuntimeAgentId[],
  ) {
    return mediaAndBodyQueries.commitFork(
      this.host,
      operationId,
      selection,
      boundaries,
      fullConsent,
    )
  }

  forkOperation(sessionId: string) {
    return mediaAndBodyQueries.forkOperation(this.host, sessionId)
  }

  forkOperationById(operationId: string) {
    return mediaAndBodyQueries.forkOperationById(this.host, operationId)
  }

  sourceHasPendingFork(sourceSessionId: string): boolean {
    return mediaAndBodyQueries.sourceHasPendingFork(this.host, sourceSessionId)
  }

  metadataPatch(sessionId: string, options: { draftsChanged?: boolean } = {}) {
    return messageWindowQueries.metadataPatch(this.host, sessionId, options)
  }

  forkIntent(sessionId: string, operationId: string, agentId: RuntimeAgentId) {
    return mediaAndBodyQueries.forkIntent(this.host, sessionId, operationId, agentId)
  }

  updateForkIntent(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    patch: Partial<typeof nativeForkIntents.$inferInsert>,
  ) {
    return mediaAndBodyQueries.updateForkIntent(this.host, sessionId, operationId, agentId, patch)
  }

  completeForkSide(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    nativeSessionId: string,
    witness: import('@pact/contracts').AgentNativeForkWitness,
  ) {
    return mediaAndBodyQueries.completeForkSide(
      this.host,
      sessionId,
      operationId,
      agentId,
      nativeSessionId,
      witness,
    )
  }

  recoverForkIntents() {
    return mediaAndBodyQueries.recoverForkIntents(this.host)
  }

  sessionHasNativeWork(sessionId: string): boolean {
    return mediaAndBodyQueries.sessionHasNativeWork(this.host, sessionId)
  }

  forkActorIsCurrent(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    executorId: string | undefined,
  ) {
    return mediaAndBodyQueries.forkActorIsCurrent(
      this.host,
      sessionId,
      operationId,
      agentId,
      executorId,
    )
  }

  read(sessionId: string): ConversationSnapshot {
    return messageWindowQueries.read(this.host, sessionId)
  }

  handoffRange(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
  ): { afterSequence: number; throughSequence: number } {
    return handoffSourceQueries.handoffRange(this.host, sessionId, targetAgentId)
  }

  readHandoffPage(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    afterSequence: number,
    throughSequence: number,
  ): { messages: HandoffBundle[]; nextSequence?: number } {
    return handoffSourceQueries.readHandoffPage(
      this.host,
      sessionId,
      targetAgentId,
      afterSequence,
      throughSequence,
    )
  }

  readHandoffSources(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    afterSequence: number,
    throughSequence: number,
    signal: AbortSignal,
    excludeMessageId?: string,
    workflow = false,
  ): AsyncIterable<HandoffBundle> {
    return handoffSourceQueries.readHandoffSources(
      this.host,
      sessionId,
      targetAgentId,
      afterSequence,
      throughSequence,
      signal,
      excludeMessageId,
      workflow,
    )
  }

  async readCollaborationSource(
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<HandoffBundle> {
    return handoffSourceQueries.readCollaborationSource(this.host, sessionId, messageId, signal)
  }

  inputBatchForMessage(
    sessionId: string,
    messageId: string,
  ): CollaborationInputBatchReference | undefined {
    return handoffSourceQueries.inputBatchForMessage(this.host, sessionId, messageId)
  }

  inputBatchForRun(runId: string): CollaborationInputBatchReference | undefined {
    return handoffSourceQueries.inputBatchForRun(this.host, runId)
  }

  assertPreparedInputRequest(input: import('@pact/contracts').ConversationSendInput): void {
    return preparedInputQueries.assertPreparedInputRequest(this.host, input)
  }

  initialTaskRoleOpportunity(
    input: import('@pact/contracts').ConversationSendInput,
    allowedAgentIds: RuntimeAgentId[],
  ): PreparedInputMetadata['taskRoles'] | undefined {
    return preparedInputQueries.initialTaskRoleOpportunity(this.host, input, allowedAgentIds)
  }

  ordinaryInputWorthConsulting(
    input: import('@pact/contracts').ConversationSendInput,
    primary: RuntimeAgentId,
  ): boolean {
    return preparedInputQueries.ordinaryInputWorthConsulting(this.host, input, primary)
  }

  preparedInformationOpportunity(receipt: PreparedInputDispatch) {
    return preparedInputQueries.preparedInformationOpportunity(this.host, receipt)
  }

  prepareInputDispatch(
    input: import('@pact/contracts').ConversationSendInput,
    ownerId: string,
    allowedAgentIds: RuntimeAgentId[],
    preparation?: { signal: AbortSignal; deadlineAt: number },
    purpose: 'routing' | 'task_roles' = 'routing',
  ): PreparedInputDispatch {
    return preparedInputQueries.prepareInputDispatch(
      this.host,
      input,
      ownerId,
      allowedAgentIds,
      preparation,
      purpose,
    )
  }

  preparedInputHandoff(batchId: string): SchedulingHandoff {
    return preparedInputQueries.preparedInputHandoff(this.host, batchId)
  }

  async readPreparedInputDecisionSources(
    receipt: PreparedInputDispatch,
    candidates: import('@pact/contracts').DecisionInput['candidates'],
    options: { signal: AbortSignal; deadlineAt: number },
  ) {
    return preparedInputQueries.readPreparedInputDecisionSources(
      this.host,
      receipt,
      candidates,
      options,
    )
  }

  proposePreparedInputInformation(input: {
    receipt: PreparedInputDispatch
    original: import('@pact/contracts').ConversationSendInput
    selection: import('@pact/contracts').DecisionSelection
    evaluation: {
      evaluationId: string
      handoffId: string
      configurationGeneration: number
      configurationFingerprint: string
      deadlineAt: number
    }
    inputSha256: string
    sourceFingerprint: string
  }): RelaySchedulingDecision {
    return preparedInputQueries.proposePreparedInputInformation(this.host, input)
  }

  heldPreparedInputPatch(
    input: import('@pact/contracts').ConversationSendInput,
  ): ConversationPatch | undefined {
    return preparedInputQueries.heldPreparedInputPatch(this.host, input)
  }

  preparedInputContinuation(sessionId: string): PreparedInputContinuation | null {
    return preparedInputQueries.preparedInputContinuation(this.host, sessionId)
  }

  readPreparedInput(
    input: Extract<ConversationGetInput, { scope: 'prepared-input' }>,
  ): ConversationPage {
    return preparedInputQueries.readPreparedInput(this.host, input)
  }

  pausePreparedInputForStop(sessionId: string): boolean {
    return preparedInputQueries.pausePreparedInputForStop(this.host, sessionId)
  }

  pendingPreparedInformationDefaults() {
    return preparedInputQueries.pendingPreparedInformationDefaults(this.host)
  }

  takePreparedInformationDefault(batchId: string) {
    return preparedInputQueries.takePreparedInformationDefault(this.host, batchId)
  }

  preparedAnswerForRun(runId: string): UserClarification | undefined {
    return preparedInputQueries.preparedAnswerForRun(this.host, runId)
  }

  readPreparedInputContinue(raw: PreparedInputContinue): ConversationPatch | undefined {
    return preparedInputQueries.readPreparedInputContinue(this.host, raw)
  }

  continuePreparedInput(raw: PreparedInputContinue) {
    return preparedInputQueries.continuePreparedInput(this.host, raw)
  }

  cancelPreparedInputDispatch(
    receipt: Pick<PreparedInputDispatch, 'batchId' | 'sessionId'>,
    reason: NonNullable<PreparedInputMetadata['cancellationReason']>,
  ): boolean {
    return preparedInputQueries.cancelPreparedInputDispatch(this.host, receipt, reason)
  }

  preparedInputRecipient(
    receipt: PreparedInputDispatch,
    proposal?: InputRoutingProposal | InitialTaskRolesProposal,
  ): RuntimeAgentId {
    return preparedInputQueries.preparedInputRecipient(this.host, receipt, proposal)
  }

  preparedInitialTaskRoles(
    receipt: PreparedInputDispatch,
    proposal?: InitialTaskRolesProposal,
  ): TaskStageRoles | undefined {
    return preparedInputQueries.preparedInitialTaskRoles(this.host, receipt, proposal)
  }

  recordWorkflowPlan(runId: string, plan: { nativeId: string; text: string }): void {
    return workflowPlanQueries.recordWorkflowPlan(this.host, runId, plan)
  }

  recordWorkflowPlanRetained(runId: string, evidence: CollaborationRetainedPlan): void {
    return workflowPlanQueries.recordWorkflowPlanRetained(this.host, runId, evidence)
  }

  recordWorkflowPlanUnavailable(runId: string): void {
    return workflowPlanQueries.recordWorkflowPlanUnavailable(this.host, runId)
  }

  recordOpenPlanFinalIntent(
    runId: string,
    intent: CollaborationOpenPlanFinalIntentInput,
  ): CollaborationOpenPlanPublishIntent | undefined {
    return workflowPlanQueries.recordOpenPlanFinalIntent(this.host, runId, intent)
  }

  workflowOpenPlanPublishIntents(runId: string): CollaborationOpenPlanPublishIntent[] {
    return workflowPlanQueries.workflowOpenPlanPublishIntents(this.host, runId)
  }

  readOpenPlanPublishIntentText(runId: string, callKey: string): string | undefined {
    return workflowPlanQueries.readOpenPlanPublishIntentText(this.host, runId, callKey)
  }

  workflowPlanCaptureFailed(runId: string): boolean {
    return workflowPlanQueries.workflowPlanCaptureFailed(this.host, runId)
  }

  workflowPlanSettled(runId: string): boolean {
    return workflowPlanQueries.workflowPlanSettled(this.host, runId)
  }

  workflowPlanSourceExpected(runId: string): boolean {
    return workflowPlanQueries.workflowPlanSourceExpected(this.host, runId)
  }

  workflowPlanCheckpoint(
    runId: string,
    nativeSessionId: string,
  ): { checkpoint: ClaudePlanCheckpoint; read(signal: AbortSignal): Promise<string> } | undefined {
    return workflowPlanQueries.workflowPlanCheckpoint(this.host, runId, nativeSessionId)
  }

  workflowPlanRecoveryState(
    runId: string,
  ): workflowPlanQueries.WorkflowPlanRecoveryState | undefined {
    return workflowPlanQueries.workflowPlanRecoveryState(this.host, runId)
  }

  needsWorkflowPlanRecovery(runId: string): boolean {
    return workflowPlanQueries.needsWorkflowPlanRecovery(this.host, runId)
  }

  recordWorkflowInputResult(runId: string, result: CollaborationInputObservation): void {
    return workflowPlanQueries.recordWorkflowInputResult(this.host, runId, result)
  }

  recordWorkflowReview(runId: string, result: CollaborationReviewObservation): void {
    return workflowPlanQueries.recordWorkflowReview(this.host, runId, result)
  }

  pendingWorkflowTasks(after?: { updatedAt: string; id: string }) {
    return workflowPlanQueries.pendingWorkflowTasks(this.host, after)
  }

  registerWorkflowInput(sessionId: string, messageId: string, askOnly = false): void {
    return workflowPlanQueries.registerWorkflowInput(this.host, sessionId, messageId, askOnly)
  }

  isInTaskReviewCommand(
    task: CollaborationTask | undefined,
    command: 'plan' | 'build' | 'review' | undefined,
  ): boolean {
    return workflowPlanQueries.isInTaskReviewCommand(this.host, task, command)
  }

  workflowReply(
    task: CollaborationTask,
    actor: RuntimeAgentId,
    askOnly = false,
  ): CollaborationTask {
    return workflowPlanQueries.workflowReply(this.host, task, actor, askOnly)
  }

  workflowInTaskReview(
    task: CollaborationTask,
    explicitReviewer?: RuntimeAgentId,
  ): CollaborationTask {
    return workflowPlanQueries.workflowInTaskReview(this.host, task, explicitReviewer)
  }

  adoptOpenModeInputRecipient(sessionId: string, inputId: string, actor: RuntimeAgentId): void {
    return workflowPlanQueries.adoptOpenModeInputRecipient(this.host, sessionId, inputId, actor)
  }

  async readOpenModeRoutingSources(
    sessionId: string,
    task: CollaborationTask,
    receivedId: string,
    candidates: import('@pact/contracts').DecisionInput['candidates'],
    options: { signal: AbortSignal; deadlineAt: number },
  ) {
    return workflowPlanQueries.readOpenModeRoutingSources(
      this.host,
      sessionId,
      task,
      receivedId,
      candidates,
      options,
    )
  }

  collaborationTurnAuthorization(runId: string): FrozenCollaborationAuthorization | undefined {
    return workflowPlanQueries.collaborationTurnAuthorization(this.host, runId)
  }

  hasRunSources(runId: string): boolean {
    return handoffSourceQueries.hasRunSources(this.host, runId)
  }

  readRunSources(
    runId: string,
    offset = 0,
    fitsTransport?: (page: handoffSourceQueries.RunSourcesIndexPage) => boolean,
  ): handoffSourceQueries.RunSourcesIndexPage {
    return handoffSourceQueries.readRunSources(this.host, runId, offset, fitsTransport)
  }

  sourceDocumentAuthorized(runId: string, document: CollaborationDocument): boolean {
    return handoffSourceQueries.sourceDocumentAuthorized(this.host, runId, document)
  }

  collaborationReplyActor(
    task: CollaborationTask,
    reference?: import('@pact/contracts').ConversationSendInput['replyToDecision'],
  ): RuntimeAgentId {
    return workflowPlanQueries.collaborationReplyActor(this.host, task, reference)
  }

  readWorkflowInputs(
    runId: string,
    offset = 0,
    fitsTransport?: (page: WorkflowInputsPage) => boolean,
  ): WorkflowInputsPage {
    return handoffSourceQueries.readWorkflowInputs(this.host, runId, offset, fitsTransport)
  }

  readFrozenInputBatch(
    runId: string,
    batchId: string,
    afterOrdinal = -1,
    fitsTransport?: (page: FrozenInputBatchPage) => boolean,
  ): FrozenInputBatchPage {
    return handoffSourceQueries.readFrozenInputBatch(
      this.host,
      runId,
      batchId,
      afterOrdinal,
      fitsTransport,
    )
  }

  async readRunHandoff(runId: string, signal: AbortSignal): Promise<HandoffBundle[]> {
    return handoffSourceQueries.readRunHandoff(this.host, runId, signal)
  }

  queueState(sessionId: string): ConversationQueueState {
    return queueAndSteerQueries.queueState(this.host, sessionId)
  }

  receiveQueuedInput(
    input: import('@pact/contracts').ConversationSendInput,
    inputId: string,
    actor: RuntimeAgentId,
    ownerKey: string,
    anchorRunId: string,
    waitingForWork = true,
    rolePolicy?: CollaborationTask['rolePolicy'],
    options?: {
      originSideChat?: OriginSideChat
      syncMainOperationId?: string
    },
  ): ConversationPatch {
    return queueAndSteerQueries.receiveQueuedInput(
      this.host,
      input,
      inputId,
      actor,
      ownerKey,
      anchorRunId,
      waitingForWork,
      rolePolicy,
      options,
    )
  }

  setConversationQueueEnabled(input: ConversationQueueEnabledInput): ConversationPatch {
    return queueAndSteerQueries.setConversationQueueEnabled(this.host, input)
  }

  resumeConversationQueue(input: ConversationQueueActionInput): ConversationPatch {
    return queueAndSteerQueries.resumeConversationQueue(this.host, input)
  }

  pauseConversationQueue(sessionId: string, reason: string): ConversationPatch {
    return queueAndSteerQueries.pauseConversationQueue(this.host, sessionId, reason)
  }

  removeQueuedConversationMessage(input: ConversationQueueActionInput): ConversationPatch {
    return queueAndSteerQueries.removeQueuedConversationMessage(this.host, input)
  }

  returnQueuedConversationMessage(input: ConversationQueueReturnInput): ConversationPatch {
    return queueAndSteerQueries.returnQueuedConversationMessage(this.host, input)
  }

  nativeInputIdsForRun(runId: string): string[] {
    return queueAndSteerQueries.nativeInputIdsForRun(this.host, runId)
  }

  unresolvedSteerInputs(runId: string) {
    return queueAndSteerQueries.unresolvedSteerInputs(this.host, runId)
  }

  recordQueuedSteerConsumption(
    proof: {
      runId: string
      sessionId: string
      nativeSessionId: string
      nativeTurnId: string
      bindingGeneration: number
      executorId?: string | undefined
    },
    inputId: string,
    invocation?: FrozenSkillInvocation,
  ): ConversationPatch {
    return queueAndSteerQueries.recordQueuedSteerConsumption(this.host, proof, inputId, invocation)
  }

  queuedSteerReceipt(
    input: ConversationQueueActionInput,
    consumedByRunId?: string,
  ): ConversationPatch | undefined {
    return queueAndSteerQueries.queuedSteerReceipt(this.host, input, consumedByRunId)
  }

  prepareQueuedSteer(
    input: ConversationQueueActionInput,
    target: { runId: string; bindingGeneration: number; nativeTurnId: string; executorId?: string },
    invocation?: FrozenSkillInvocation,
  ) {
    return queueAndSteerQueries.prepareQueuedSteer(this.host, input, target, invocation)
  }

  markQueuedSteerPossiblySent(operationId: string): ConversationPatch {
    return queueAndSteerQueries.markQueuedSteerPossiblySent(this.host, operationId)
  }

  markQueuedSteerUnknown(
    operationId: string,
    reason = 'Delivery is uncertain. Resolve the original execution before continuing.',
  ): ConversationPatch {
    return queueAndSteerQueries.markQueuedSteerUnknown(this.host, operationId, reason)
  }

  markQueuedSteerRefused(
    operationId: string,
    reason = 'The provider did not accept this input. It remains queued.',
    provenNativeRejection = false,
  ): ConversationPatch {
    return queueAndSteerQueries.markQueuedSteerRefused(
      this.host,
      operationId,
      reason,
      provenNativeRejection,
    )
  }

  markQueuedSteerAccepted(
    operationId: string,
    skillInvocation?: FrozenSkillInvocation,
  ): ConversationPatch {
    return queueAndSteerQueries.markQueuedSteerAccepted(this.host, operationId, skillInvocation)
  }

  markQueuedSteerConsumed(
    operationId: string,
    nativeInputId: string,
    skillInvocation?: FrozenSkillInvocation,
  ): ConversationPatch {
    return queueAndSteerQueries.markQueuedSteerConsumed(
      this.host,
      operationId,
      nativeInputId,
      skillInvocation,
    )
  }

  readQueuedInputSource(
    input: Extract<ConversationGetInput, { scope: 'queued-input' }>,
  ): Extract<ConversationPage, { scope: 'queued-input' }> {
    return queueAndSteerQueries.readQueuedInputSource(this.host, input)
  }

  receivedCollaborationInput(sessionId: string, includeCancelled = false) {
    return collaborationQueries.receivedCollaborationInput(this.host, sessionId, includeCancelled)
  }

  receivedInputReceipt(
    sessionId: string,
    clientMessageId: string,
    input?: import('@pact/contracts').ConversationSendInput,
    waitingForWork = false,
    expectedActor?: RuntimeAgentId,
  ): ConversationPatch | undefined {
    return collaborationQueries.receivedInputReceipt(
      this.host,
      sessionId,
      clientMessageId,
      input,
      waitingForWork,
      expectedActor,
    )
  }

  assertDecisionInput(
    input: Pick<
      import('@pact/contracts').ConversationSendInput,
      | 'sessionId'
      | 'content'
      | 'replyToDecision'
      | 'freezeDrafts'
      | 'imageIds'
      | 'commentIds'
      | 'skills'
      | 'route'
      | 'returnedInputOperationId'
      | 'queueReturnOperationId'
    >,
  ): void {
    return collaborationQueries.assertDecisionInput(this.host, input)
  }

  assertTaskReplacement(
    input: Pick<import('@pact/contracts').ConversationSendInput, 'sessionId' | 'replaceTask'>,
    workflowCommand: boolean,
  ): void {
    return collaborationQueries.assertTaskReplacement(this.host, input, workflowCommand)
  }

  receiveCollaborationInput(
    input: import('@pact/contracts').ConversationSendInput,
    inputId: string,
    actor: RuntimeAgentId,
    policy: 'immediate_safe_point' | 'next_round',
    ownerKey: string,
    waitingForWork = false,
    anchorRunId?: string,
    rolePolicy?: CollaborationTask['rolePolicy'],
    options?: {
      originSideChat?: OriginSideChat
      syncMainOperationId?: string
    },
  ): ConversationPatch {
    return collaborationQueries.receiveCollaborationInput(
      this.host,
      input,
      inputId,
      actor,
      policy,
      ownerKey,
      waitingForWork,
      anchorRunId,
      rolePolicy,
      options,
    )
  }

  pendingCollaborationInputs() {
    return collaborationQueries.pendingCollaborationInputs(this.host)
  }

  readReceivedInput(sessionId: string) {
    return collaborationQueries.readReceivedInput(this.host, sessionId)
  }

  setReceivedInputState(
    sessionId: string,
    state: 'accepted' | 'blocked' | 'cancelled',
    receiptId?: string,
  ): ConversationPatch {
    return collaborationQueries.setReceivedInputState(this.host, sessionId, state, receiptId)
  }

  recoverCollaborationTasks(): void {
    return collaborationQueries.recoverCollaborationTasks(this.host)
  }

  collaboration(
    sessionId: string,
    runId?: string,
    _hydrate?: boolean,
  ): CollaborationTask | undefined {
    return collaborationQueries.collaboration(this.host, sessionId, runId, _hydrate)
  }

  collaborationDocumentRow(sessionId: string, ref: CollaborationDocument) {
    return collaborationQueries.collaborationDocumentRow(this.host, sessionId, ref)
  }

  collaborationCommentDocument(
    sessionId: string,
    anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
  ): CollaborationDocument | undefined {
    return collaborationQueries.collaborationCommentDocument(this.host, sessionId, anchor)
  }

  usePlainCollaborationProjection(sessionId: string, source: CollaborationDocument): void {
    return collaborationQueries.usePlainCollaborationProjection(this.host, sessionId, source)
  }

  beginMarkdownProjection(sessionId: string, source: CollaborationDocument): void {
    return collaborationQueries.beginMarkdownProjection(this.host, sessionId, source)
  }

  recordMarkdownPage(
    sessionId: string,
    source: CollaborationDocument,
    page: {
      ordinal: number
      visibleStart: number
      visibleEnd: number
      tree: CollaborationMarkdownNode
      visibleText: string
    },
  ): void {
    return collaborationQueries.recordMarkdownPage(this.host, sessionId, source, page)
  }

  sealMarkdownProjection(sessionId: string, source: CollaborationDocument, pages: number): void {
    return collaborationQueries.sealMarkdownProjection(this.host, sessionId, source, pages)
  }

  collaborationQuote(
    sessionId: string,
    source: CollaborationDocument,
    start: number,
    end: number,
    basis: 'markdown-visible-v2' | 'plain-visible-v1' = 'markdown-visible-v2',
  ): string {
    return collaborationQueries.collaborationQuote(this.host, sessionId, source, start, end, basis)
  }

  collaborationPromptState(task: CollaborationTask): CollaborationTask {
    return collaborationQueries.collaborationPromptState(this.host, task)
  }

  assertWorkflowDispatch(runId: string): void {
    return collaborationQueries.assertWorkflowDispatch(this.host, runId)
  }

  adoptSplitStageRoles(input: {
    sessionId: string
    taskId: string
    revision: number
    settingsRevision: number
    operationId: string
  }): ConversationPatch {
    return collaborationQueries.adoptSplitStageRoles(this.host, input)
  }

  setCollaborationState(task: CollaborationTask): ConversationPatch {
    return collaborationQueries.setCollaborationState(this.host, task)
  }

  pauseCollaboration(
    sessionId: string,
    reason: NonNullable<CollaborationTask['pauseReason']>,
  ): ConversationPatch {
    return collaborationQueries.pauseCollaboration(this.host, sessionId, reason)
  }

  reconcileCompletedCollaboration(runId: string): ConversationPatch | undefined {
    return collaborationQueries.reconcileCompletedCollaboration(this.host, runId)
  }

  workflowInputWasNotSent(run: AgentRun): boolean {
    return collaborationQueries.workflowInputWasNotSent(this.host, run)
  }

  finishCollaboration(runId: string, complete: boolean, notice?: string): void {
    return collaborationQueries.finishCollaboration(this.host, runId, complete, notice)
  }

  readPage(input: ConversationGetInput): ConversationPage {
    return messageWindowQueries.readPage(this.host, input)
  }

  message(messageId: string, sessionId: string): ConversationMessage | undefined {
    return messageWindowQueries.message(this.host, messageId, sessionId)
  }

  internalMessage(messageId: string, sessionId: string): ConversationMessage | undefined {
    return messageWindowQueries.internalMessage(this.host, messageId, sessionId)
  }

  messageMetadata(
    messageId: string,
    sessionId: string,
  ): { contentRevision: number; contentBytes: number } | undefined {
    return messageWindowQueries.messageMetadata(this.host, messageId, sessionId)
  }

  diagnostics(): {
    completeReads: number
    pageReads: number
    patches: number
    observedSessions: number
    eventTransactions: number
    streamLookups: {
      text: { queries: number; returnedRows: number }
      activity: { queries: number; returnedRows: number }
    }
  } {
    return messageWindowQueries.diagnostics(this.host)
  }

  skillInvocation(messageId: string): FrozenSkillInvocation | undefined {
    return messageWindowQueries.skillInvocation(this.host, messageId)
  }

  submittedRunReceipt(
    input: Pick<
      BeginRunInput,
      | 'sessionId'
      | 'clientMessageId'
      | 'content'
      | 'commentIds'
      | 'expectedCommentsRevision'
      | 'skills'
      | 'route'
      | 'imageIds'
      | 'batchId'
      | 'freezeDrafts'
      | 'preserveDraftComments'
      | 'receivedInputId'
      | 'replyToDecision'
      | 'replaceTask'
      | 'userInformation'
    >,
  ): BeginRunResult | undefined {
    return messageWindowQueries.submittedRunReceipt(this.host, input)
  }

  relayWorkflowAlternatives(
    handoff: SchedulingHandoff,
    existingDecisionId?: string,
  ): { snapshot: RelayWorkflowSnapshot; alternatives: RelayWorkflowAlternative[] } | undefined {
    return relayDecisionQueries.relayWorkflowAlternatives(this.host, handoff, existingDecisionId)
  }

  planReviewLimitAdviceConsidered(handoff: SchedulingHandoff): boolean {
    return relayDecisionQueries.planReviewLimitAdviceConsidered(this.host, handoff)
  }

  recordPlanReviewLimitAdviceConsidered(handoff: SchedulingHandoff): void {
    return relayDecisionQueries.recordPlanReviewLimitAdviceConsidered(this.host, handoff)
  }

  proposeRelayNativeRecovery(
    sessionId: string,
    agentId: RuntimeAgentId,
    originFaultId?: string,
  ): boolean {
    return relayDecisionQueries.proposeRelayNativeRecovery(
      this.host,
      sessionId,
      agentId,
      originFaultId,
    )
  }

  proposeRelayWorkflowAction(input: {
    handoff: SchedulingHandoff
    kind: 'reassign_roles' | 'extend_plan_review'
    evaluationId: string
    configurationGeneration: number
    configurationFingerprint: string
    inputSha256: string
    sourceFingerprint: string
    deadlineAt: number
    sourceIds: string[]
  }): RelaySchedulingDecision {
    return relayDecisionQueries.proposeRelayWorkflowAction(this.host, input)
  }

  swapCodeRoles(input: CollaborationActionInput, waitingForWork: boolean): ConversationPatch {
    return relayDecisionQueries.swapCodeRoles(this.host, input, waitingForWork)
  }

  relaySchedulingDecision(sessionId: string): RelaySchedulingDecision | null {
    return relayDecisionQueries.relaySchedulingDecision(this.host, sessionId)
  }

  discardStaleRelaySchedulingDecision(sessionId: string): boolean {
    return relayDecisionQueries.discardStaleRelaySchedulingDecision(this.host, sessionId)
  }

  discardUnansweredRelaySchedulingDecision(sessionId: string, includePact = true): void {
    return relayDecisionQueries.discardUnansweredRelaySchedulingDecision(
      this.host,
      sessionId,
      includePact,
    )
  }

  relayDecisionReceipt(
    input: import('@pact/contracts').RelayDecisionReceiptRead,
  ): RelayDecisionReceipt | undefined {
    return relayDecisionQueries.relayDecisionReceipt(this.host, input)
  }

  answerRelaySchedulingDecision(raw: RelayDecisionAnswer): {
    result: RelayDecisionReceipt
    created: boolean
    receiptId?: string | undefined
    draftsChanged?: boolean | undefined
    preparedInput?:
      | { receipt: PreparedInputDispatch; input: import('@pact/contracts').ConversationSendInput }
      | undefined
    nativeRebuild?: { agentId: RuntimeAgentId; operationId: string } | undefined
  } {
    return relayDecisionQueries.answerRelaySchedulingDecision(this.host, raw)
  }

  hasRelayDecision(sessionId: string): boolean {
    return relayDecisionQueries.hasRelayDecision(this.host, sessionId)
  }

  assertRelayDecisionResolved(sessionId: string, receiptId?: string, newInput = false): void {
    return relayDecisionQueries.assertRelayDecisionResolved(
      this.host,
      sessionId,
      receiptId,
      newInput,
    )
  }

  releaseUnusedRelayWorkflowAction(
    receiptId: string,
    pause: boolean,
  ): ConversationPatch | undefined {
    return relayDecisionQueries.releaseUnusedRelayWorkflowAction(this.host, receiptId, pause)
  }

  preparedRelayWorkflowAction(receiptId: string) {
    return relayDecisionQueries.preparedRelayWorkflowAction(this.host, receiptId)
  }

  collaborationActionReceipt(input: CollaborationActionInput) {
    return collaborationQueries.collaborationActionReceipt(this.host, input)
  }

  prepareCollaborationAction(input: CollaborationActionInput, limits: CollaborationLimits) {
    return collaborationQueries.prepareCollaborationAction(this.host, input, limits)
  }

  cancelPreparedCollaborationAction(id: string): void {
    return collaborationQueries.cancelPreparedCollaborationAction(this.host, id)
  }

  workflowHandoff(
    task: CollaborationTask,
    actor: RuntimeAgentId,
    inputId?: string,
  ): SchedulingHandoff {
    return handoffSourceQueries.workflowHandoff(this.host, task, actor, inputId)
  }

  recoveryHandoff(fault: NonNullable<SchedulingHandoff['fault']>): SchedulingHandoff {
    return handoffSourceQueries.recoveryHandoff(this.host, fault)
  }

  relayWorkflowSnapshot(
    handoff: SchedulingHandoff,
    requestedDecisionId?: string,
  ): RelayWorkflowSnapshot | undefined {
    return relayDecisionQueries.relayWorkflowSnapshot(this.host, handoff, requestedDecisionId)
  }

  async readRelayWorkflowDecisionSources(
    handoff: SchedulingHandoff,
    candidates: import('@pact/contracts').DecisionInput['candidates'],
    options: { signal: AbortSignal; deadlineAt: number },
  ): Promise<RelayDecisionMaterial & { snapshot: RelayWorkflowSnapshot }> {
    return relayDecisionQueries.readRelayWorkflowDecisionSources(
      this.host,
      handoff,
      candidates,
      options,
    )
  }

  evaluationIsCurrent(node: SchedulingHandoff): boolean {
    return schedulingQueries.evaluationIsCurrent(this.host, node)
  }

  decisionEvaluationReceipt(handoff: SchedulingHandoff): { id: string } | undefined {
    return schedulingQueries.decisionEvaluationReceipt(this.host, handoff)
  }

  activeEvaluation() {
    return schedulingQueries.activeEvaluation(this.host)
  }

  activeSchedulingRuntimeOwner() {
    return schedulingQueries.activeSchedulingRuntimeOwner(this.host)
  }

  schedulingPhysicalReceiptCapacityAvailable(): boolean {
    return schedulingQueries.schedulingPhysicalReceiptCapacityAvailable(this.host)
  }

  hasSchedulingPhysicalReceipts(): boolean {
    return schedulingQueries.hasSchedulingPhysicalReceipts(this.host)
  }

  claimSchedulingPhysicalReceipt(after?: string) {
    return schedulingQueries.claimSchedulingPhysicalReceipt(this.host, after)
  }

  acknowledgeSchedulingPhysicalReceipt(receiptId: string, expectedWitness: string): boolean {
    return schedulingQueries.acknowledgeSchedulingPhysicalReceipt(
      this.host,
      receiptId,
      expectedWitness,
    )
  }

  settleSchedulingOwnerAfterPhysicalProof(
    id: string,
    expectedWitnessJson: string,
    expectedGeneration = 0,
  ): boolean {
    return schedulingQueries.settleSchedulingOwnerAfterPhysicalProof(
      this.host,
      id,
      expectedWitnessJson,
      expectedGeneration,
    )
  }

  reserveEvaluation(input: Parameters<typeof scheduling.reserveEvaluation>[1]) {
    return schedulingQueries.reserveEvaluation(this.host, input)
  }

  settleEvaluationAfterPhysicalProof(id: string, expectedWitnessJson: string): boolean {
    return schedulingQueries.settleEvaluationAfterPhysicalProof(this.host, id, expectedWitnessJson)
  }

  settleSchedulingHttpOwnerAfterExit(id: string, expectedOwnerJson: string): boolean {
    return schedulingQueries.settleSchedulingHttpOwnerAfterExit(this.host, id, expectedOwnerJson)
  }

  settleEvaluation(id: string, input: Parameters<typeof scheduling.settleEvaluation>[2]) {
    return schedulingQueries.settleEvaluation(this.host, id, input)
  }

  dispatchEvaluation(id: string, httpOwner: import('@pact/contracts').DecisionHttpOwner) {
    return schedulingQueries.dispatchEvaluation(this.host, id, httpOwner)
  }

  reserveSchedulingBudget(input: Parameters<typeof scheduling.reserveBudget>[1]) {
    return schedulingQueries.reserveSchedulingBudget(this.host, input)
  }

  settleSchedulingBudget(id: string, state: Parameters<typeof scheduling.settleBudget>[2]) {
    return schedulingQueries.settleSchedulingBudget(this.host, id, state)
  }

  schedulingBudget(subjectId: string) {
    return schedulingQueries.schedulingBudget(this.host, subjectId)
  }

  handoffReceipt(id: string) {
    return schedulingQueries.handoffReceipt(this.host, id)
  }

  async captureExecutionInput(input: {
    runId: string
    nativeGeneration: string
    requested: RunRequestedExecutionSettings
    source: AsyncIterable<Uint8Array>
    signal: AbortSignal
  }): Promise<import('@pact/contracts').FrozenExecutionInput | undefined> {
    return runLifecycleQueries.captureExecutionInput(this.host, input)
  }

  executionInput(runId: string) {
    return runLifecycleQueries.executionInput(this.host, runId)
  }

  recordEffectiveExecutionSettings(
    runId: string,
    nativeGeneration: string,
    raw: RunEffectiveExecutionSettings,
    identity: { executorId: string; nativeSessionId: string },
  ): void {
    return runLifecycleQueries.recordEffectiveExecutionSettings(
      this.host,
      runId,
      nativeGeneration,
      raw,
      identity,
    )
  }

  recordConfirmedUnsent(
    runId: string,
    nativeGeneration: string,
    boundary: ConfirmedUnsentBoundary,
    identity: { executorId: string; nativeSessionId: string },
  ): void {
    return runLifecycleQueries.recordConfirmedUnsent(
      this.host,
      runId,
      nativeGeneration,
      boundary,
      identity,
    )
  }

  frozenExecutionEnvelope(runId: string) {
    return runLifecycleQueries.frozenExecutionEnvelope(this.host, runId)
  }

  beginConfirmedUnsentReexecution(input: {
    operationId: string
    faultId: string
    handoff: SchedulingHandoff
  }) {
    return runLifecycleQueries.beginConfirmedUnsentReexecution(this.host, input)
  }

  canDispatchReexecution(runId: string): boolean {
    return runLifecycleQueries.canDispatchReexecution(this.host, runId)
  }

  beginRun(input: BeginRunInput): BeginRunResult {
    return runLifecycleQueries.beginRun(this.host, input)
  }

  beginRoutedContinuation(input: BeginRoutedContinuationInput): BeginRunResult {
    return runLifecycleQueries.beginRoutedContinuation(this.host, input)
  }

  pendingRoutedContinuations(scope?: WorkspaceArchiveScope): Array<{
    sessionId: string
    userMessageId: string
    agentId: RuntimeAgentId
  }> {
    return runLifecycleQueries.pendingRoutedContinuations(this.host, scope)
  }

  hasPendingRoutedContinuation(sessionId: string): boolean {
    return runLifecycleQueries.hasPendingRoutedContinuation(this.host, sessionId)
  }

  cancelPendingRoutedContinuation(sessionId: string, reason = 'user_cancelled'): ConversationPatch {
    return runLifecycleQueries.cancelPendingRoutedContinuation(this.host, sessionId, reason)
  }

  failPendingRoutedContinuation(
    sessionId: string,
    userMessageId: string,
    agentId: RuntimeAgentId,
    message: string,
  ): ConversationPatch {
    return runLifecycleQueries.failPendingRoutedContinuation(
      this.host,
      sessionId,
      userMessageId,
      agentId,
      message,
    )
  }

  dismissPeerProposal(sessionId: string, proposalId: string): ConversationPatch {
    return runLifecycleQueries.dismissPeerProposal(this.host, sessionId, proposalId)
  }

  peerProposal(
    sessionId: string,
    proposalId: string,
  ): { run: AgentRun; sourceMessageId: string } | undefined {
    return runLifecycleQueries.peerProposal(this.host, sessionId, proposalId)
  }

  runPatch(runId: string): ConversationPatch {
    return messageWindowQueries.runPatch(this.host, runId)
  }

  recordNativeEffects(
    runId: string,
    state: 'not_dispatched' | 'pending' | 'settled' | 'unknown',
    reason?: string,
  ): ConversationPatch {
    return nativeRebuildQueries.recordNativeEffects(this.host, runId, state, reason)
  }

  ownsNativeControl(runId: string): boolean {
    return nativeRebuildQueries.ownsNativeControl(this.host, runId)
  }

  isCurrentBackgroundCursor(runId: string): boolean {
    return nativeRebuildQueries.isCurrentBackgroundCursor(this.host, runId)
  }

  ownsBackgroundControl(runId: string): boolean {
    return nativeRebuildQueries.ownsBackgroundControl(this.host, runId)
  }

  setContinuation(
    sessionId: string,
    agentId: RuntimeAgentId,
    state: NativeContinuationState,
    reason?: string,
    generation?: number,
    failure?: { kind: RunFailureKind; message: string; action?: 'retry' | 'rebuild' | 'none' },
  ): ConversationPatch {
    return nativeRebuildQueries.setContinuation(
      this.host,
      sessionId,
      agentId,
      state,
      reason,
      generation,
      failure,
    )
  }

  recordExecutor(runId: string, executorId: string): ConversationPatch {
    return nativeRebuildQueries.recordExecutor(this.host, runId, executorId)
  }

  recordDispatch(
    runId: string,
    phase: 'possibly_sent' | 'accepted' | 'rejected',
    nativeSessionId?: string,
    executorId?: string,
  ): ConversationPatch {
    return nativeRebuildQueries.recordDispatch(this.host, runId, phase, nativeSessionId, executorId)
  }

  recordNativeEvidence(
    result: NativeProbeResult,
    unavailableAction: 'retry' | 'rebuild' = 'rebuild',
  ): ConversationPatch {
    return nativeRebuildQueries.recordNativeEvidence(this.host, result, unavailableAction)
  }

  observationUnavailable(runId: string, reason: string): ConversationPatch {
    return nativeRebuildQueries.observationUnavailable(this.host, runId, reason)
  }

  recordOutputFailure(
    runId: string,
    failure: { kind: RunFailureKind; message: string },
  ): ConversationPatch {
    return nativeRebuildQueries.recordOutputFailure(this.host, runId, failure)
  }

  nativeRecoveryRun(sessionId: string, agentId: RuntimeAgentId): AgentRun | undefined {
    return nativeRebuildQueries.nativeRecoveryRun(this.host, sessionId, agentId)
  }

  latestAgentRun(
    sessionId: string,
    agentId: RuntimeAgentId,
    generation?: number,
  ): AgentRun | undefined {
    return nativeRebuildQueries.latestAgentRun(this.host, sessionId, agentId, generation)
  }

  hasCompleteResponse(runId: string): boolean {
    return nativeRebuildQueries.hasCompleteResponse(this.host, runId)
  }

  bindingHasUnsettledWork(sessionId: string, agentId: RuntimeAgentId, generation: number): boolean {
    return nativeRebuildQueries.bindingHasUnsettledWork(this.host, sessionId, agentId, generation)
  }

  contextPatch(sessionId: string): ConversationPatch {
    return messageWindowQueries.contextPatch(this.host, sessionId)
  }

  verifyRebuildReceipt(
    id: string,
    sessionId: string,
    agentId: RuntimeAgentId,
    expectedRunId?: string | null,
  ): void {
    return nativeRebuildQueries.verifyRebuildReceipt(
      this.host,
      id,
      sessionId,
      agentId,
      expectedRunId,
    )
  }

  settleKnownNativeEnding(
    runId: string,
    failure?: { kind: RunFailureKind; message: string },
  ): ConversationPatch {
    return nativeRebuildQueries.settleKnownNativeEnding(this.host, runId, failure)
  }

  projectHasNativeWork(projectId: string): boolean {
    return nativeRebuildQueries.projectHasNativeWork(this.host, projectId)
  }

  recordNativeRebuildWork(
    id: string,
    executorId: string,
    nativeSessionId: string | undefined,
    state: 'unknown' | 'settled',
  ): void {
    return nativeRebuildQueries.recordNativeRebuildWork(
      this.host,
      id,
      executorId,
      nativeSessionId,
      state,
    )
  }

  recordNativeRebuildCheck(
    sessionId: string,
    agentId: RuntimeAgentId,
    expected: NativeRebuildOperation,
    expectedNativeSessionId: string | undefined,
  ): ConversationPatch {
    return nativeRebuildQueries.recordNativeRebuildCheck(
      this.host,
      sessionId,
      agentId,
      expected,
      expectedNativeSessionId,
    )
  }

  nativeRebuildOperation(id: string): NativeRebuildOperation | undefined {
    return nativeRebuildQueries.nativeRebuildOperation(this.host, id)
  }

  pendingNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): NativeRebuildOperation | undefined {
    return nativeRebuildQueries.pendingNativeRebuild(this.host, sessionId, agentId)
  }

  lastNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): NativeRebuildOperation | undefined {
    return nativeRebuildQueries.lastNativeRebuild(this.host, sessionId, agentId)
  }

  beginNativeRebuild(input: {
    id: string
    sessionId: string
    agentId: RuntimeAgentId
    expectedGeneration: number
    expectedRunId?: string | null
    abandon: boolean
    reservedNativeSessionId?: string
  }): ConversationPatch {
    return nativeRebuildQueries.beginNativeRebuild(this.host, input)
  }

  freezeNativeRebuildSource(
    id: string,
    chunks: NativeContextRebuildChunk[],
    sourceRevisions: ReadonlyMap<string, number>,
  ): string {
    return nativeRebuildQueries.freezeNativeRebuildSource(this.host, id, chunks, sourceRevisions)
  }

  rebuildInputRecovery(sessionId: string): RebuildInputRecovery | null {
    return nativeRebuildQueries.rebuildInputRecovery(this.host, sessionId)
  }

  readReturnedInput(
    sessionId: string,
    operationId: string,
    offset: number,
  ): Extract<ConversationPage, { scope: 'rebuild-input' }> {
    return nativeRebuildQueries.readReturnedInput(this.host, sessionId, operationId, offset)
  }

  claimReturnedInput(
    sessionId: string,
    operationId: string,
    expectedGeneration: number,
    expectedCommentsRevision: number,
  ): ConversationPatch {
    return nativeRebuildQueries.claimReturnedInput(
      this.host,
      sessionId,
      operationId,
      expectedGeneration,
      expectedCommentsRevision,
    )
  }

  discardReturnedInput(sessionId: string, operationId: string): ConversationPatch {
    return nativeRebuildQueries.discardReturnedInput(this.host, sessionId, operationId)
  }

  returnedInputRoute(sessionId: string, operationId: string): ConversationMessageRoute {
    return nativeRebuildQueries.returnedInputRoute(this.host, sessionId, operationId)
  }

  markNativeRebuildDispatched(id: string, executorId?: string): void {
    return nativeRebuildQueries.markNativeRebuildDispatched(this.host, id, executorId)
  }

  readNativeRebuildSource(id: string): NativeContextRebuildChunk[] {
    return nativeRebuildQueries.readNativeRebuildSource(this.host, id)
  }

  recordNativeRebuildIdentity(id: string, nativeSessionId: string): void {
    return nativeRebuildQueries.recordNativeRebuildIdentity(this.host, id, nativeSessionId)
  }

  failNativeRebuild(id: string, reason: string): ConversationPatch {
    return nativeRebuildQueries.failNativeRebuild(this.host, id, reason)
  }

  completeNativeRebuild(
    id: string,
    nativeSessionId: string,
    executorId?: string,
    initializationWitness?: NativeInitializationWitness,
  ): ConversationPatch {
    return nativeRebuildQueries.completeNativeRebuild(
      this.host,
      id,
      nativeSessionId,
      executorId,
      initializationWitness,
    )
  }

  saveCommentDraft(
    input:
      | CommentDraftSaveInput
      | (Omit<Extract<CommentDraftSaveInput, { mode: 'create' }>, 'anchor'> & {
          anchor: Exclude<CommentAnchor, { type: 'unavailable' }>
        }),
  ): ConversationPatch {
    return mediaAndBodyQueries.saveCommentDraft(this.host, input)
  }

  removeCommentDraft(input: CommentDraftRemoveInput): ConversationPatch {
    return mediaAndBodyQueries.removeCommentDraft(this.host, input)
  }

  comment(commentId: string): AnchoredComment | undefined {
    return mediaAndBodyQueries.comment(this.host, commentId)
  }

  commentsForMessage(messageId: string): AnchoredComment[] {
    return mediaAndBodyQueries.commentsForMessage(this.host, messageId)
  }

  readFrozenBatchInlineComments(input: {
    sessionId: string
    runId: string
    batchId: string
    maxBytes: number
    maxItems?: number | undefined
  }): Array<Pick<AnchoredComment, 'id' | 'body' | 'anchor'>> {
    return mediaAndBodyQueries.readFrozenBatchInlineComments(this.host, input)
  }

  recentPeerWorkspaceChangeCandidates(input: {
    sessionId: string
    messageIds: readonly string[]
    limit: number
    check?: () => void
  }): handoffSourceQueries.PeerWorkspaceChangeCandidate[] {
    return handoffSourceQueries.recentPeerWorkspaceChangeCandidates(this.host, input)
  }

  frozenRunHandoffMessageIdsWithOriginCutoffs(runId: string, sessionId: string): string[] {
    return handoffSourceQueries.frozenRunHandoffMessageIdsWithOriginCutoffs(
      this.host,
      runId,
      sessionId,
    )
  }

  findRun(runId: string): AgentRun | undefined {
    return runLifecycleQueries.findRun(this.host, runId)
  }

  recordWorkspaceChanges(summary: WorkspaceChangeSet): ConversationPatch {
    return runLifecycleQueries.recordWorkspaceChanges(this.host, summary)
  }

  recordWorkspaceRecordingUnavailable(runId: string, reason: string): ConversationPatch {
    return runLifecycleQueries.recordWorkspaceRecordingUnavailable(this.host, runId, reason)
  }

  expireNativePermissions(): void {
    return nativeRebuildQueries.expireNativePermissions(this.host)
  }

  recordContextPermissions(
    sessionId: string,
    agentId: RuntimeAgentId,
    operationId: string,
    requests: import('@pact/contracts').NativePermissionRequest[],
    decision?: {
      permissionId: string
      decision?: 'once' | 'session' | 'deny' | 'accept' | 'decline' | 'cancel'
      source?: 'user' | 'expired' | 'aborted'
      actionId?: string
      actionKind?: 'allow' | 'decline' | 'cancel' | 'rule'
    },
    scope?: { bindingGeneration: number; projectionAllowed: boolean },
  ): ConversationPatch {
    return nativeRebuildQueries.recordContextPermissions(
      this.host,
      sessionId,
      agentId,
      operationId,
      requests,
      decision,
      scope,
    )
  }

  updateAttempt(runId: string, attemptCount: number, recovering: boolean): ConversationPatch {
    return runLifecycleQueries.updateAttempt(this.host, runId, attemptCount, recovering)
  }

  applyEvent(sessionId: string, runId: string, event: NormalizedAgentEvent): ConversationPatch {
    return eventStreamQueries.applyEvent(this.host, sessionId, runId, event)
  }

  async completeAnswer(
    runId: string,
    metadata: CompleteAnswerMetadata,
    source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
    signal: AbortSignal,
    options: { archive?: boolean; bodyState?: 'complete' | 'incomplete' } = {},
  ): Promise<ConversationPatch> {
    return eventStreamQueries.completeAnswer(this.host, runId, metadata, source, signal, options)
  }

  async recordBackgroundReport(
    report: NativeBackgroundReport,
    source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
    signal: AbortSignal,
  ): Promise<ConversationPatch | undefined> {
    return eventStreamQueries.recordBackgroundReport(this.host, report, source, signal)
  }

  recordBackgroundReportUnavailable(
    report: BackgroundReportIdentity,
  ): ConversationPatch | undefined {
    return eventStreamQueries.recordBackgroundReportUnavailable(this.host, report)
  }

  applyArchivedEvent(
    sessionId: string,
    runId: string,
    event: NormalizedAgentEvent,
  ): ConversationPatch {
    return eventStreamQueries.applyArchivedEvent(this.host, sessionId, runId, event)
  }

  recordNativeOutput(runId: string, output: NativeRecoveredOutput): ConversationPatch {
    return eventStreamQueries.recordNativeOutput(this.host, runId, output)
  }

  async recordNativeOutputComplete(
    runId: string,
    output: NativeRecoveredOutput,
    signal: AbortSignal,
  ): Promise<ConversationPatch> {
    return eventStreamQueries.recordNativeOutputComplete(this.host, runId, output, signal)
  }

  applyArchivedBatch(
    sessionId: string,
    runId: string,
    events: readonly StreamDeltaEvent[],
  ): ConversationPatch {
    return eventStreamQueries.applyArchivedBatch(this.host, sessionId, runId, events)
  }

  applyStreamBatch(
    sessionId: string,
    runId: string,
    events: readonly StreamDeltaEvent[],
  ): ConversationPatch {
    return eventStreamQueries.applyStreamBatch(this.host, sessionId, runId, events)
  }

  failRun(
    runId: string,
    failureKind: RunFailureKind,
    failureMessage: string,
    interrupted = false,
  ): ConversationPatch {
    return eventStreamQueries.failRun(this.host, runId, failureKind, failureMessage, interrupted)
  }

  recoverInterruptedRuns(): string[] {
    return eventStreamQueries.recoverInterruptedRuns(this.host)
  }

  interruptRun(runId: string, deliveryPossible?: boolean): void {
    return eventStreamQueries.interruptRun(this.host, runId, deliveryPossible)
  }

  nativeContexts(sessionId: string): NativeAgentContext[] {
    return nativeRebuildQueries.nativeContexts(this.host, sessionId)
  }

  nativeRecoveryBlocksInput(sessionId: string): boolean {
    return nativeRebuildQueries.nativeRecoveryBlocksInput(this.host, sessionId)
  }

  unacknowledgedNativeRun(sessionId: string, agentId?: RuntimeAgentId): AgentRun | undefined {
    return nativeRebuildQueries.unacknowledgedNativeRun(this.host, sessionId, agentId)
  }

  markNativeContextsMissing(
    sessionId: string,
    agentIds: RuntimeAgentId[],
    message = 'The saved Native Session is unavailable.',
  ): ConversationPatch {
    return nativeRebuildQueries.markNativeContextsMissing(this.host, sessionId, agentIds, message)
  }

  nativeContextRebuildSource(
    sessionId: string,
    signal: AbortSignal,
    operationId?: string,
    sourceRevisions?: Map<string, number>,
  ): AsyncIterable<NativeContextRebuildChunk> {
    return nativeRebuildQueries.nativeContextRebuildSource(
      this.host,
      sessionId,
      signal,
      operationId,
      sourceRevisions,
    )
  }

  nativeContext(sessionId: string, agentId: RuntimeAgentId): NativeAgentContext | undefined {
    return nativeRebuildQueries.nativeContext(this.host, sessionId, agentId)
  }

  recordSystemMessage(sessionId: string, runId: string, content: string): ConversationPatch {
    return eventStreamQueries.recordSystemMessage(this.host, sessionId, runId, content)
  }

  rebuildOperations(sessionId: string) {
    return nativeRebuildQueries.rebuildOperations(this.host, sessionId)
  }

  confirmedNativeInitialization(sessionId: string, agentId: RuntimeAgentId) {
    return nativeRebuildQueries.confirmedNativeInitialization(this.host, sessionId, agentId)
  }
}
