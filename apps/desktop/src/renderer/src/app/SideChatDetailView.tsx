import type {
  AnchoredComment,
  CollaborationSession,
  RuntimeAgentId,
  RuntimePreparation,
  SchedulingState,
  SideChatSyncMainReceipt,
  SkillSelection,
} from '@pact/contracts'

import type { ProjectFileTarget } from '../components/conversation/MessageMarkdown'
import type { ConversationFlow } from '../components/conversation/useConversation'
import type { SideChatSettingsState } from './useSideChatFlow'
import type { MessageNavigationState } from './useWorkspacePanels'

import {
  ConversationView,
  type ConversationViewProps,
} from '../components/conversation/ConversationView'
import { ConversationErrorBoundary } from '../components/workspace/ConversationErrorBoundary'
import { requiredAgentsForSession } from './session-issues'

export interface ActiveWorkspaceDiffTarget {
  sessionId: string
  changeSetId: string
  path: string
}

const ConversationViewWithDiff: React.ComponentType<
  ConversationViewProps & { activeWorkspaceDiff?: ActiveWorkspaceDiffTarget | undefined }
> = ConversationView

export interface SideChatDetailViewProps {
  sideChatId: string
  mainParentSessionId: string
  activeSideChatId: string | undefined
  sideSession: CollaborationSession | undefined
  lockedSettingsLoaded: boolean
  sideChatSettingsState: SideChatSettingsState
  onRetrySideChatSettings: (sideChatId: string) => void
  sideChatConversation: ConversationFlow
  sideChatVisible: boolean
  sideChatHandoffKey: string | undefined
  mainTargetAgentId: RuntimeAgentId | undefined
  mainActionsEnabled: boolean
  preparation: RuntimePreparation | undefined
  readyAgentSet: Set<RuntimeAgentId>
  nativePresentationSuspended: boolean
  platform: string | undefined
  schedulingState: SchedulingState | undefined
  messageNavigation: MessageNavigationState | undefined
  onViewMainMessage: (receipt: SideChatSyncMainReceipt) => void
  onOpenComment: (comment: AnchoredComment) => void
  onNotice: (message: string) => void
  onOpenSkillDocument: (
    sideChatId: string,
    skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>,
  ) => void
  onOpenWorkspaceChanges: (
    sideChatId: string,
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ) => void
  onPrepareWorkspaceChanges: () => number
  onOpenProjectFile: (target: ProjectFileTarget, sideChatId: string) => void
  onUndoWorkspaceChanges: (changeSetId: string, path?: string) => Promise<boolean>
  onUndoWorkspaceFile?: ((changeSetId: string, path: string) => Promise<boolean>) | undefined
  activeWorkspaceDiff?: ActiveWorkspaceDiffTarget | undefined
  activeWorkspaceFilePath?: string | undefined
}

export function SideChatDetailView({
  sideChatId,
  mainParentSessionId,
  activeSideChatId,
  sideSession,
  lockedSettingsLoaded,
  sideChatSettingsState,
  onRetrySideChatSettings,
  sideChatConversation,
  sideChatVisible,
  sideChatHandoffKey,
  mainTargetAgentId,
  mainActionsEnabled,
  preparation,
  readyAgentSet,
  nativePresentationSuspended,
  platform,
  schedulingState,
  messageNavigation,
  onViewMainMessage,
  onOpenComment,
  onNotice,
  onOpenSkillDocument,
  onOpenWorkspaceChanges,
  onPrepareWorkspaceChanges,
  onOpenProjectFile,
  onUndoWorkspaceChanges,
  onUndoWorkspaceFile,
  activeWorkspaceDiff,
  activeWorkspaceFilePath,
}: SideChatDetailViewProps): React.JSX.Element | null {
  if (!sideSession || sideSession.parentSessionId !== mainParentSessionId) {
    return null
  }
  const sideChatSettingsError =
    !lockedSettingsLoaded && sideChatSettingsState.sideChatId === sideChatId
      ? sideChatSettingsState.error
      : undefined
  const sideChatSettingsLoading = !lockedSettingsLoaded && !sideChatSettingsError
  const sideSnapshot =
    sideChatConversation.snapshot?.session.id === sideSession.id
      ? sideChatConversation.snapshot
      : undefined
  const sideChatInTakeoverOrRecovering =
    sideSession.activity.state === 'recovering' ||
    Boolean(sideSnapshot?.runs.some((run) => run.status === 'recovering')) ||
    (sideSnapshot?.pendingNativeInteractions?.length ?? 0) > 0 ||
    Boolean(sideSnapshot?.relaySchedulingDecision) ||
    Boolean(
      sideSnapshot?.rebuildOperations?.some((entry) =>
        ['preparing', 'creating', 'seeding', 'unconfirmed'].includes(entry.operation.stage),
      ),
    ) ||
    (sideSnapshot?.sessionIssues?.inputGate ?? 'open') === 'read_only' ||
    Boolean(
      sideSnapshot?.nativeContexts.some(
        (ctx) =>
          (ctx.permissionRequests?.length ?? 0) > 0 ||
          ['waiting_user', 'checking', 'rebuilding'].includes(ctx.continuationState ?? ''),
      ),
    )
  const sideChatAgentActionsEnabled =
    lockedSettingsLoaded &&
    !sideChatSettingsLoading &&
    Boolean(preparation) &&
    requiredAgentsForSession(sideSession, sideSnapshot?.sessionIssues).every((agentId) =>
      readyAgentSet.has(agentId),
    ) &&
    sideSession.status !== 'archived'
  const sideChatMainSyncEnabled =
    lockedSettingsLoaded &&
    !sideChatSettingsLoading &&
    mainActionsEnabled &&
    sideSession.status !== 'archived' &&
    !sideChatInTakeoverOrRecovering

  return (
    <ConversationErrorBoundary key={sideChatId}>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {sideChatSettingsError ? (
          <div
            className="mx-section mt-group flex shrink-0 items-center justify-between gap-group rounded-card bg-danger-muted p-group text-caption text-danger"
            role="alert"
          >
            <span>{sideChatSettingsError}</span>
            <button
              className="shrink-0 font-medium underline underline-offset-4"
              type="button"
              onClick={() => onRetrySideChatSettings(sideChatId)}
            >
              Try again
            </button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationViewWithDiff
            nativePresentationSuspended={nativePresentationSuspended}
            platform={platform}
            session={sideSession}
            schedulingState={schedulingState}
            visible={sideChatVisible && sideChatId === activeSideChatId}
            snapshot={sideChatConversation.snapshot}
            history={sideChatConversation.history}
            composer={sideChatConversation.composer}
            composerImages={sideChatConversation.composerImages}
            choosingImages={sideChatConversation.choosingImages}
            onAddComposerImages={sideChatConversation.addComposerImages}
            onChooseComposerImages={sideChatConversation.chooseComposerImages}
            onRemoveComposerImage={sideChatConversation.removeComposerImage}
            onComposerChange={(value) => sideChatConversation.setComposer(value)}
            onComposerDocumentChange={(value) => sideChatConversation.setComposerDocument(value)}
            onOpenSkillDocument={(skill) => onOpenSkillDocument(sideChatId, skill)}
            composerSkills={sideChatConversation.composerSkills}
            onComposerSkillsChange={(values) => sideChatConversation.setComposerSkills(values)}
            composerMention={sideChatConversation.composerMention}
            composerRoute={sideChatConversation.composerRoute}
            composerReturnedInputOperationId={sideChatConversation.composerReturnedInputOperationId}
            composerUserInformation={sideChatConversation.composerUserInformation}
            composerRevision={sideChatConversation.composerRevision}
            onClearSubmittedDraft={(expectedRevision) =>
              sideChatConversation.clearSubmittedComposerDraft(sideChatId, expectedRevision)
            }
            handoffArriveKey={sideChatId === activeSideChatId ? sideChatHandoffKey : undefined}
            mainTargetAgentId={mainTargetAgentId}
            onSyncToMain={sideChatConversation.syncToMain}
            onViewMainMessage={onViewMainMessage}
            onComposerMentionChange={(value) => sideChatConversation.setComposerMention(value)}
            loading={sideChatConversation.loading}
            sending={sideChatConversation.sending}
            stopping={sideChatConversation.stopping}
            agentActionsEnabled={sideChatAgentActionsEnabled}
            mainSyncEnabled={sideChatMainSyncEnabled}
            sideChatSettingsState={
              sideChatSettingsLoading ? 'loading' : sideChatSettingsError ? 'error' : undefined
            }
            error={sideChatConversation.error}
            onSend={(...args) => sideChatConversation.send(...args)}
            onSaveCommentDraft={(input) => sideChatConversation.saveCommentDraft(input)}
            onRemoveCommentDraft={(commentId) => sideChatConversation.removeCommentDraft(commentId)}
            onOpenComment={onOpenComment}
            onNotice={onNotice}
            onStop={(background) => sideChatConversation.stop(background)}
            onRebuildNativeContext={(agentId, options) =>
              sideChatConversation.rebuildNativeContext(agentId, options)
            }
            onCheckNativeContext={(agentId, runId) =>
              sideChatConversation.checkNativeContext(agentId, runId)
            }
            onAcceptPeerProposal={(proposalId) =>
              sideChatConversation.acceptPeerProposal(proposalId)
            }
            onDismissPeerProposal={(proposalId) =>
              sideChatConversation.dismissPeerProposal(proposalId)
            }
            onUndoWorkspaceChanges={onUndoWorkspaceChanges}
            onUndoWorkspaceFile={onUndoWorkspaceFile}
            activeWorkspaceDiff={activeWorkspaceDiff}
            activeWorkspaceFilePath={activeWorkspaceFilePath}
            onRespondNativePermission={(operationId, permissionId, decision) =>
              sideChatConversation.respondNativePermission(operationId, permissionId, decision)
            }
            onRespondNativeInput={(input) => sideChatConversation.respondNativeInput(input)}
            nativeInputDrafts={sideChatConversation.nativeInputDrafts}
            onNativeInputDraftChange={sideChatConversation.setNativeInputDraft}
            onOpenWorkspaceChanges={(changeSetId, path, expectedGeneration, revision) =>
              onOpenWorkspaceChanges(sideChatId, changeSetId, path, expectedGeneration, revision)
            }
            onPrepareWorkspaceChanges={onPrepareWorkspaceChanges}
            onOpenProjectFile={(target) => onOpenProjectFile(target, sideChatId)}
            messageNavigation={
              messageNavigation?.sessionId === sideChatId ? messageNavigation : undefined
            }
          />
        </div>
      </div>
    </ConversationErrorBoundary>
  )
}
