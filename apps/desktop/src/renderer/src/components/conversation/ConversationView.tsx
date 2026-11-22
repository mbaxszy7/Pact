import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { BookOpen, Info, MessageSquareText } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  AnchoredComment,
  CollaborationSession,
  CollaborationTask,
  ConversationDisplayOrder,
  ConversationPage,
  MessageCommentAnchor,
  RelayDecisionAnswer,
  RuntimeAgentId,
  SessionCatalogChange,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SideChatSyncMainReceipt,
  SkillSelection,
  UserInformationDeclaration,
  WorkspaceChangeSet,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import {
  collaborationActor,
  collaborationInputGate,
  collaborationInputProcessing,
  compareConversationDisplayOrder,
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_WINDOW_MESSAGES,
  conversationMessageOrder,
  defaultTaskStageRoles,
  isCollaborationOpenMode,
  otherAgent,
  pactSessionEntryPrimary,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  resolveLegacyCompatibleTaskStageRoles,
  validateSideChatMainSyncContent,
  WORKSPACE_CHANGE_FILES,
  WORKSPACE_OPERATION_TIMEOUT_MS,
} from '@pact/contracts'

import type { RelayDecisionPresentation } from '../scheduling/RelayDecisionCard'
import type { PlanTextSelection, ReportTextSelection } from './CollaborationReview'
import type { ComposerEditorHandle } from './ComposerEditor'
import type { ConversationViewProjection } from './conversation-window'
import type { DraftImage } from './image-client'
import type { ProjectFileTarget } from './MessageMarkdown'
import type { MessageTextSelection } from './MessageSelectionSurface'
import type {
  ConversationComposerMention,
  ConversationFlow,
  ConversationHistoryControls,
  DecisionReplyContext,
} from './useConversation'
import type { ComposerEdit, ComposerSkillOption } from './useSkillComposer'

import { MESSAGE_ANCHOR_TEXT_BASIS } from '../../../../shared/message-anchor-text'
import {
  composerDifference,
  composerHasContent,
  extractBtwSideChatDraft,
  extractMainSyncDraft,
  replaceComposerDocument,
  resolveComposerRoute,
  type ComposerDocument,
} from './composer-document'
import {
  CommentDraftChips,
  CommentEditorCard,
  ComposerIsland,
  type CommentEditorState,
} from './ComposerIsland'
import {
  agentName,
  buildMentionOptions,
  cancelWorkspaceFileLoadWaiters,
  coalesceWorkspaceLoadIntent,
  CONVERSATION_WIDTH,
  EMPTY_COMMENTS,
  EMPTY_IMAGES,
  EMPTY_SKILLS,
  enqueueWorkspaceFileLoadWaiter,
  hasRecordingWarning,
  hasVisibleChanges,
  ignoreSkillChanges,
  mentionQueryAt,
  OLDER_HISTORY_SCROLL_THRESHOLD,
  promoteWorkspaceFileLoadWaiter,
  resolvePlanStatusLabel,
  sha256Hex,
  TRANSCRIPT_OVERSCAN,
  tryAcquireWorkspaceFileLoadSlot,
  upsertWorkspaceFilesLru,
  type MentionOption,
  type MentionQuery,
  type WorkspaceFileLoadIntent,
} from './conversation-view-helpers'
import {
  conversationWindowStartOrder,
  isRunResponseComplete,
  nativeInputRequests,
} from './conversation-window'
import { CurrentPlanPanel, type CurrentPlanDocument } from './CurrentPlanPanel'
import { EditorialMessageItem, type ConversationTranscriptRow } from './EditorialMessageItem'
import { ImageGallery } from './ImageGallery'
import {
  clearProjectionHighlight,
  focusProjectionRange,
  isProjectionHighlightOwned,
  planSelectionSource,
  pulseMessageTarget,
  reportSelectionSource,
  reportSourceSelector,
  selectedTextRange,
} from './message-selection'
import { NativePermissionCard } from './NativePermissionCard'
import { NativeForkRecovery, SessionForkDialog, type SessionForkOpening } from './SessionFork'
import { TaskReplacementConfirmation } from './TaskReplacementConfirmation'
import { commentDraftSaveSucceeded, hasDecisionAnswers, sameDecision } from './useConversation'
import { useSkillComposer } from './useSkillComposer'
import { WorkspaceChangesCard, type WorkspaceChangesList } from './WorkspaceChangesCard'

interface WorkspaceFileLoadSlot {
  changeSetId: string
  generation: number
  inFlight: boolean
  inFlightRevision: number
  inFlightExpand: boolean
  inFlightOpen: boolean
  inFlightContextGeneration?: number | undefined
  timedOut: boolean
  timeout?: number | undefined
  waitingForConcurrency: boolean
  queued?: WorkspaceFileLoadIntent | undefined
}

export interface ConversationViewProps {
  planPanelHost?: HTMLElement | null | undefined
  planPanelOpen?: boolean | undefined
  planPanelExpanded?: boolean | undefined
  onPlanPanelExpandedChange?: ((expanded: boolean) => void) | undefined
  planAvailable?: boolean | undefined
  planRestoreFocusRef?: React.RefObject<HTMLButtonElement | null> | undefined
  showPlanHeaderButton?: boolean | undefined
  onRegisterShowCurrentPlan?: ((fn: (() => void) | undefined) => void) | undefined
  onPlanAvailable?: ((sessionId: string, taskId?: string) => void) | undefined
  onOpenPlan?: (() => void) | undefined
  onClosePlan?: (() => void) | undefined
  onForkSessionCreated?:
    | ((change: SessionCatalogChange, enter: boolean, opening?: SessionForkOpening) => void)
    | undefined
  onForkSessionStarted?: (() => SessionForkOpening) | undefined
  nativePresentationSuspended?: boolean | undefined
  platform?: string | undefined
  sessionSettingsSaving?: boolean | undefined
  onSaveSessionPermission?: ((input: SessionPermissionSaveInput) => Promise<boolean>) | undefined
  onSaveSessionSpeed?: ((input: SessionSpeedSaveInput) => Promise<boolean>) | undefined
  schedulingState?: import('@pact/contracts').SchedulingState | undefined
  relayDecision?: RelayDecisionPresentation | undefined
  onOpenRelaySettings?: (() => void) | undefined
  onOpenSessionSettings?: (() => void) | undefined
  visible: boolean
  session: CollaborationSession
  snapshot?: ConversationViewProjection | undefined
  history: ConversationHistoryControls
  composer: string
  choosingImages?: boolean | undefined
  composerImages?: readonly DraftImage[] | undefined
  onAddComposerImages?: ConversationFlow['addComposerImages'] | undefined
  onChooseComposerImages?: ConversationFlow['chooseComposerImages'] | undefined
  onRemoveComposerImage?: ConversationFlow['removeComposerImage'] | undefined
  onComposerChange: (value: string) => void
  onComposerDocumentChange?: ((value: ComposerDocument) => boolean | void) | undefined
  onOpenSkillDocument?: ((skill: SkillSelection) => void) | undefined
  composerSkills?: SkillSelection[] | undefined
  onComposerSkillsChange?: ((value: SkillSelection[]) => void) | undefined
  composerMention?: ConversationComposerMention | undefined
  composerRoute?: ComposerDocument['route']
  composerReturnedInputOperationId?: string | undefined
  composerUserInformation?: UserInformationDeclaration | undefined
  composerRevision?: number | undefined
  onClearSubmittedDraft?: ((expectedRevision: number) => void) | undefined
  handoffArriveKey?: string | number | undefined
  mainTargetAgentId?: RuntimeAgentId | undefined
  onOpenBtwSideChat?: ((draft: ComposerDocument) => Promise<boolean>) | undefined
  onAskInSideChat?: ((selection: MessageTextSelection) => void) | undefined
  onOpenSideChat?: ((sideChatId: string) => void) | undefined
  resolveSideChatTitle?: ((sideChatId: string, fallbackTitle: string) => string) | undefined
  onSyncToMain?: ConversationFlow['syncToMain'] | undefined
  onViewMainMessage?: ((receipt: SideChatSyncMainReceipt) => void) | undefined
  onComposerMentionChange: (value: ConversationComposerMention | undefined) => void
  loading: boolean
  sending: boolean
  stopping: boolean
  agentActionsEnabled: boolean
  mainSyncEnabled?: boolean | undefined
  sideChatSettingsState?: 'loading' | 'error' | undefined
  error?: string | undefined
  onSend: ConversationFlow['send']
  onSaveCommentDraft: ConversationFlow['saveCommentDraft']
  onRemoveCommentDraft: (commentId: string) => Promise<boolean>
  onStop: ConversationFlow['stop']
  onRebuildNativeContext: ConversationFlow['rebuildNativeContext']
  onCheckNativeContext: ConversationFlow['checkNativeContext']
  onAcceptPeerProposal: (proposalId: string) => Promise<boolean>
  onDismissPeerProposal: (proposalId: string) => Promise<boolean>
  onUndoWorkspaceChanges: (changeSetId: string) => Promise<boolean>
  onUndoWorkspaceFile?: ((changeSetId: string, path: string) => Promise<boolean>) | undefined
  activeWorkspaceDiff?: { sessionId: string; changeSetId: string; path: string } | undefined
  activeWorkspaceFilePath?: string | undefined
  onRespondNativeInput: (input: import('@pact/contracts').NativeInputRespond) => Promise<boolean>
  nativeInputDrafts: ConversationFlow['nativeInputDrafts']
  onNativeInputDraftChange: ConversationFlow['setNativeInputDraft']
  onRespondNativePermission: (
    operationId: string,
    permissionId: string,
    decision: import('@pact/contracts').NativePermissionDecision,
  ) => Promise<boolean>
  onOpenWorkspaceChanges: (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ) => void
  onPrepareWorkspaceChanges: () => number
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onOpenComment: (comment: AnchoredComment) => void
  onNotice: (message: string) => void
  messageNavigation?:
    | {
        navigationId?: string
        messageId: string
        queuedOperationId?: string | undefined
        startOffset: number
        endOffset: number
        textBasis?: MessageCommentAnchor['textBasis']
        plan?: MessageCommentAnchor['plan']
        report?: MessageCommentAnchor['report']
      }
    | undefined
}

export function ConversationView({
  planPanelHost,
  planPanelExpanded = false,
  onPlanPanelExpandedChange,
  planAvailable,
  planRestoreFocusRef,
  showPlanHeaderButton = true,
  onRegisterShowCurrentPlan,
  onPlanAvailable,
  onOpenPlan,
  onClosePlan,
  onForkSessionCreated,
  onForkSessionStarted,
  nativePresentationSuspended = false,
  platform,
  sessionSettingsSaving,
  onSaveSessionPermission,
  onSaveSessionSpeed,
  visible,
  schedulingState,
  relayDecision,
  onOpenRelaySettings,
  onOpenSessionSettings,
  session,
  snapshot,
  history,
  composer,
  composerImages = EMPTY_IMAGES,
  choosingImages = false,
  onAddComposerImages,
  onChooseComposerImages,
  onRemoveComposerImage,
  onComposerChange,
  onComposerDocumentChange,
  onOpenSkillDocument,
  composerSkills = EMPTY_SKILLS,
  onComposerSkillsChange = ignoreSkillChanges,
  composerMention,
  composerRoute,
  composerReturnedInputOperationId,
  composerUserInformation,
  composerRevision = 0,
  onClearSubmittedDraft,
  handoffArriveKey,
  mainTargetAgentId,
  onOpenBtwSideChat,
  onAskInSideChat,
  onOpenSideChat,
  resolveSideChatTitle,
  onSyncToMain,
  onViewMainMessage,
  onComposerMentionChange,
  loading,
  sending,
  stopping: stopRequested,
  agentActionsEnabled,
  mainSyncEnabled,
  sideChatSettingsState,
  error,
  onSend,
  onSaveCommentDraft,
  onRemoveCommentDraft,
  onStop,
  onRebuildNativeContext,
  onCheckNativeContext,
  onAcceptPeerProposal,
  onDismissPeerProposal,
  onUndoWorkspaceChanges,
  onUndoWorkspaceFile,
  activeWorkspaceDiff,
  activeWorkspaceFilePath,
  onRespondNativePermission,
  onRespondNativeInput,
  nativeInputDrafts,
  onNativeInputDraftChange,
  onOpenWorkspaceChanges,
  onPrepareWorkspaceChanges,
  onOpenProjectFile,
  onOpenComment,
  onNotice,
  messageNavigation,
}: ConversationViewProps): React.JSX.Element {
  const [forkPoint, setForkPoint] = useState<{
    sourceSessionId: string
    messageId: string
    opening?: SessionForkOpening | undefined
  }>()
  useEffect(() => {
    setForkPoint((current) => (current?.sourceSessionId === session.id ? current : undefined))
  }, [session.id])

  // Bounded LRU map (max 8 entries) keyed by changeSetId prevents expanding Card B from wiping Card A.
  const [workspaceFilesById, setWorkspaceFilesById] = useState<Map<string, WorkspaceChangesList>>(
    () => new Map(),
  )
  const workspaceFilesMapRef = useRef<Map<string, WorkspaceChangesList>>(new Map())
  const workspaceFileLoadsRef = useRef<Map<string, WorkspaceFileLoadSlot>>(new Map())
  const workspaceLoadOwnerIdRef = useRef<symbol>(Symbol('workspace-file-loads'))
  const loadWorkspaceFilesRef = useRef<
    | ((
        changeSetId: string,
        expand?: boolean,
        open?: boolean,
        contextGeneration?: number,
        targetRevision?: number,
      ) => Promise<void>)
    | undefined
  >(undefined)
  const [undoingChangeSetId, setUndoingChangeSetId] = useState<string>()
  const undoingChangeSetRef = useRef<string | undefined>(undefined)
  const [undoingFile, setUndoingFile] = useState<{ changeSetId: string; path: string }>()
  const undoingFileRef = useRef<{ changeSetId: string; path: string } | undefined>(undefined)
  const workspaceOwnerActiveRef = useRef(true)
  const defaultWorkspaceChangesIdRef = useRef<string | undefined>(undefined)

  const upsertWorkspaceFiles = useCallback(
    (changeSetId: string, entry: WorkspaceChangesList): void => {
      const next = upsertWorkspaceFilesLru(workspaceFilesMapRef.current, changeSetId, entry)
      workspaceFilesMapRef.current = next
      setWorkspaceFilesById(next)
    },
    [],
  )

  const currentWorkspaceChangeSetRevision = useCallback(
    (changeSetId: string): number | undefined => {
      const summary = messageInteractionRef.current.snapshot?.runs.find(
        (run) => run.workspaceChanges?.id === changeSetId,
      )?.workspaceChanges
      return summary ? (summary.revision ?? 0) : undefined
    },
    [],
  )

  const clearAllWorkspaceLoads = useCallback((): void => {
    cancelWorkspaceFileLoadWaiters(workspaceLoadOwnerIdRef.current)
    workspaceLoadOwnerIdRef.current = Symbol('workspace-file-loads')
    for (const slot of workspaceFileLoadsRef.current.values()) {
      slot.generation += 1
      slot.queued = undefined
      slot.waitingForConcurrency = false
      if (slot.timeout !== undefined) {
        window.clearTimeout(slot.timeout)
        slot.timeout = undefined
      }
    }
    workspaceFileLoadsRef.current.clear()
  }, [])

  useEffect(() => {
    workspaceOwnerActiveRef.current = true
    return () => {
      workspaceOwnerActiveRef.current = false
      clearAllWorkspaceLoads()
    }
  }, [clearAllWorkspaceLoads])

  useEffect(() => {
    clearAllWorkspaceLoads()
    const empty = new Map<string, WorkspaceChangesList>()
    workspaceFilesMapRef.current = empty
    setWorkspaceFilesById(empty)
    defaultWorkspaceChangesIdRef.current = undefined
  }, [session.id, clearAllWorkspaceLoads])

  const loadWorkspaceFiles = useCallback(
    async (
      changeSetId: string,
      expand = false,
      open = false,
      contextGeneration?: number,
      targetRevision?: number,
    ): Promise<void> => {
      const existing = workspaceFilesMapRef.current.get(changeSetId)
      const revision = currentWorkspaceChangeSetRevision(changeSetId) ?? targetRevision ?? 0
      const current = (existing?.revision ?? 0) === revision ? existing : undefined
      let slot = workspaceFileLoadsRef.current.get(changeSetId)

      // Cache hits never allocate a tracking slot.
      if (!slot) {
        if (
          current &&
          !current.loading &&
          !current.error &&
          ((!expand && current.files.length) || (expand && !current.expanded))
        ) {
          upsertWorkspaceFiles(changeSetId, { ...current, expanded: expand || current.expanded })
          if (open && current.files[0])
            onOpenWorkspaceChanges(
              changeSetId,
              current.files[0].path,
              contextGeneration,
              current.revision,
            )
          return
        }
        if (current && !current.loading && expand && !current.nextPath && !current.error) return
      }

      if (slot && (slot.inFlight || slot.waitingForConcurrency)) {
        slot.queued = coalesceWorkspaceLoadIntent(slot.queued, {
          expand,
          open,
          contextGeneration,
          targetRevision: revision,
        })
        if (slot.waitingForConcurrency && slot.queued.open) {
          promoteWorkspaceFileLoadWaiter(workspaceLoadOwnerIdRef.current, changeSetId)
        }
        return
      }

      if (!slot) {
        slot = {
          changeSetId,
          generation: 0,
          inFlight: false,
          inFlightRevision: revision,
          inFlightExpand: expand,
          inFlightOpen: open,
          inFlightContextGeneration: contextGeneration,
          timedOut: false,
          waitingForConcurrency: false,
        }
        workspaceFileLoadsRef.current.set(changeSetId, slot)
      }

      const releasePhysicalSlot = tryAcquireWorkspaceFileLoadSlot()
      if (!releasePhysicalSlot) {
        const waitingSlot = slot
        waitingSlot.waitingForConcurrency = true
        waitingSlot.queued = coalesceWorkspaceLoadIntent(waitingSlot.queued, {
          expand,
          open,
          contextGeneration,
          targetRevision: revision,
        })
        enqueueWorkspaceFileLoadWaiter({
          ownerId: workspaceLoadOwnerIdRef.current,
          changeSetId,
          priority: waitingSlot.queued.open,
          timeoutMs: WORKSPACE_OPERATION_TIMEOUT_MS,
          shouldDispatch: () => {
            if (!workspaceOwnerActiveRef.current) return false
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return false
            }
            const intent = currentSlot.queued
            if (!intent) return false
            if (!intent.open && currentWorkspaceChangeSetRevision(changeSetId) === undefined) {
              currentSlot.waitingForConcurrency = false
              currentSlot.queued = undefined
              workspaceFileLoadsRef.current.delete(changeSetId)
              return false
            }
            return true
          },
          onGrant: () => {
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return
            }
            const intent = currentSlot.queued
            currentSlot.waitingForConcurrency = false
            currentSlot.queued = undefined
            workspaceFileLoadsRef.current.delete(changeSetId)
            if (intent) {
              void loadWorkspaceFilesRef.current?.(
                changeSetId,
                intent.expand,
                intent.open,
                intent.contextGeneration,
                intent.targetRevision,
              )
            }
          },
          onReject: (reason) => {
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return
            }
            const intent = currentSlot.queued
            currentSlot.waitingForConcurrency = false
            currentSlot.queued = undefined
            workspaceFileLoadsRef.current.delete(changeSetId)
            if (!workspaceOwnerActiveRef.current || !intent) return
            const message =
              reason === 'queue_full'
                ? 'Too many changed file lists are loading right now. Try again.'
                : 'Loading changed files took too long. Try again.'
            const existingEntry = workspaceFilesMapRef.current.get(changeSetId)
            const latestRev =
              currentWorkspaceChangeSetRevision(changeSetId) ?? intent.targetRevision
            const currentEntry =
              (existingEntry?.revision ?? 0) === latestRev ? existingEntry : undefined
            upsertWorkspaceFiles(changeSetId, {
              changeSetId,
              revision: latestRev,
              files: currentEntry?.files ?? [],
              nextPath: currentEntry?.nextPath ?? null,
              loading: false,
              expanded: intent.expand || existingEntry?.expanded || false,
              error: message,
            })
            if (intent.open) onNotice(message)
          },
        })
        return
      }

      const activeSlot = slot
      const generation = ++activeSlot.generation
      activeSlot.waitingForConcurrency = false
      activeSlot.inFlight = true
      activeSlot.inFlightRevision = revision
      activeSlot.inFlightExpand = expand || existing?.expanded || false
      activeSlot.inFlightOpen = open
      activeSlot.inFlightContextGeneration = contextGeneration
      activeSlot.timedOut = false
      if (activeSlot.timeout !== undefined) window.clearTimeout(activeSlot.timeout)
      const initial: WorkspaceChangesList = {
        changeSetId,
        revision,
        files: current?.files ?? [],
        nextPath: current?.nextPath ?? null,
        loading: true,
        expanded: expand || existing?.expanded || false,
      }
      upsertWorkspaceFiles(changeSetId, initial)
      const localTimeout = window.setTimeout(() => {
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation
        )
          return
        activeSlot.generation += 1
        activeSlot.timedOut = true
        activeSlot.timeout = undefined
        upsertWorkspaceFiles(changeSetId, {
          ...initial,
          loading: false,
          error: 'Loading changed files took too long. Try again.',
        })
        if (open) onNotice('Loading changed files took too long. Try again.')
      }, WORKSPACE_OPERATION_TIMEOUT_MS)
      activeSlot.timeout = localTimeout
      try {
        const result = await window.pact.readWorkspaceChanges({
          changeSetId,
          ...(current?.nextPath ? { afterPath: current.nextPath } : {}),
        })
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation ||
          activeSlot.timedOut
        )
          return
        const latestRevision = currentWorkspaceChangeSetRevision(changeSetId)
        if (latestRevision !== undefined && latestRevision !== revision) {
          activeSlot.queued = coalesceWorkspaceLoadIntent(
            activeSlot.queued,
            {
              expand: initial.expanded,
              open,
              contextGeneration,
              targetRevision: latestRevision,
            },
            { autoRefresh: true },
          )
          return
        }
        if (!result.ok) {
          upsertWorkspaceFiles(changeSetId, {
            ...initial,
            loading: false,
            error: result.error.message,
          })
          if (open) onNotice(result.error.message)
          return
        }
        if (
          result.value.changeSet.id !== changeSetId ||
          result.value.changeSet.sessionId !== session.id
        )
          throw new Error('These file changes do not belong to this session.')
        if ((result.value.changeSet.revision ?? 0) !== revision)
          throw new Error('Changed files were updated while loading. Try again.')
        const files = [...initial.files, ...result.value.files]
        if (files.length > WORKSPACE_CHANGE_FILES)
          throw new Error('Too many changed files to display at once.')
        if (new Set(files.map((file) => file.path)).size !== files.length)
          throw new Error('Changed file list contained duplicate paths.')
        if (!result.value.nextPath && files.length !== result.value.changeSet.fileCount)
          throw new Error('Changed file list is incomplete. Try again.')
        if (result.value.nextPath && result.value.nextPath === current?.nextPath)
          throw new Error('Couldn’t load the next page of changed files.')
        upsertWorkspaceFiles(changeSetId, {
          ...initial,
          revision: result.value.changeSet.revision ?? 0,
          files,
          nextPath: result.value.nextPath,
          loading: false,
        })
        if (open) {
          const first = files[0]
          if (first)
            onOpenWorkspaceChanges(
              changeSetId,
              first.path,
              contextGeneration,
              result.value.changeSet.revision,
            )
          else onNotice('No changed files were recorded for this turn.')
        }
      } catch (failure) {
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation ||
          activeSlot.timedOut
        )
          return
        const latestRevision = currentWorkspaceChangeSetRevision(changeSetId)
        if (latestRevision !== undefined && latestRevision !== revision) {
          activeSlot.queued = coalesceWorkspaceLoadIntent(
            activeSlot.queued,
            {
              expand: initial.expanded,
              open,
              contextGeneration,
              targetRevision: latestRevision,
            },
            { autoRefresh: true },
          )
          return
        }
        const message = failure instanceof Error ? failure.message : 'Couldn’t load changed files.'
        upsertWorkspaceFiles(changeSetId, { ...initial, loading: false, error: message })
        if (open) onNotice(message)
      } finally {
        window.clearTimeout(localTimeout)
        let replayIntent: WorkspaceFileLoadIntent | undefined
        if (workspaceFileLoadsRef.current.get(changeSetId) === activeSlot) {
          if (activeSlot.timeout === localTimeout) activeSlot.timeout = undefined
          activeSlot.inFlight = false
          activeSlot.timedOut = false
          replayIntent = activeSlot.queued
          activeSlot.queued = undefined
          if (!activeSlot.waitingForConcurrency) {
            workspaceFileLoadsRef.current.delete(changeSetId)
          }
        }
        releasePhysicalSlot()
        if (workspaceOwnerActiveRef.current && replayIntent) {
          void loadWorkspaceFilesRef.current?.(
            changeSetId,
            replayIntent.expand,
            replayIntent.open,
            replayIntent.contextGeneration,
            replayIntent.targetRevision,
          )
        }
      }
    },
    [
      currentWorkspaceChangeSetRevision,
      onNotice,
      onOpenWorkspaceChanges,
      session.id,
      upsertWorkspaceFiles,
    ],
  )

  useLayoutEffect(() => {
    loadWorkspaceFilesRef.current = loadWorkspaceFiles
  }, [loadWorkspaceFiles])

  const latestChangesRun = history.window?.latestRun
  const newestChangesId = hasVisibleChanges(latestChangesRun)
    ? latestChangesRun?.workspaceChanges?.id
    : undefined
  useEffect(() => {
    if (visible && newestChangesId && defaultWorkspaceChangesIdRef.current !== newestChangesId) {
      defaultWorkspaceChangesIdRef.current = newestChangesId
      void loadWorkspaceFiles(newestChangesId)
    }
  }, [visible, newestChangesId, loadWorkspaceFiles])

  const undoWorkspaceChanges = useCallback(
    (changeSetId: string): void => {
      if (undoingChangeSetRef.current || undoingFileRef.current) return
      undoingChangeSetRef.current = changeSetId
      setUndoingChangeSetId(changeSetId)
      void onUndoWorkspaceChanges(changeSetId).finally(() => {
        undoingChangeSetRef.current = undefined
        if (workspaceOwnerActiveRef.current) setUndoingChangeSetId(undefined)
      })
    },
    [onUndoWorkspaceChanges],
  )

  const handleUndoWorkspaceFile = useCallback(
    async (changeSetId: string, path: string): Promise<boolean> => {
      if (!onUndoWorkspaceFile || undoingChangeSetRef.current || undoingFileRef.current) {
        return false
      }
      const target = { changeSetId, path }
      undoingFileRef.current = target
      setUndoingFile(target)
      try {
        return await onUndoWorkspaceFile(changeSetId, path)
      } finally {
        undoingFileRef.current = undefined
        if (workspaceOwnerActiveRef.current) setUndoingFile(undefined)
      }
    },
    [onUndoWorkspaceFile],
  )

  const [commentEditor, setCommentEditor] = useState<CommentEditorState | undefined>(undefined)
  const [savingComment, setSavingComment] = useState(false)
  const pendingCommentSave = useRef<CommentEditorState | undefined>(undefined)
  const gapRetryRef = useRef<{ mode: 'around'; messageId: string } | { mode: 'latest' }>({
    mode: 'latest',
  })
  const [copyFeedback, setCopyFeedback] = useState<
    { messageId: string; result: 'copying' | 'copied' | 'failed' } | undefined
  >(undefined)
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined)
  const composerRef = useRef<ComposerEditorHandle>(null)
  const [gallery, setGallery] = useState<{ images: ConversationImage[]; initialId: string }>()
  const openImageGallery = useCallback(
    (images: readonly DraftImage[], image: ConversationImage): void =>
      setGallery({
        images: images.flatMap((entry) => (entry.image ? [entry.image] : [])),
        initialId: image.id,
      }),
    [],
  )
  const openMessageGallery = useCallback(
    (images: ConversationImage[], initialId: string): void => setGallery({ images, initialId }),
    [],
  )
  const dismissedMention = useRef<MentionQuery | undefined>(undefined)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | undefined>()
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const copyRequestGenerationRef = useRef(0)
  const copyActiveRef = useRef(true)
  const transcriptRef = useRef<HTMLElement>(null)
  const transcriptContentRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLOListElement>(null)
  const [listOffset, setListOffset] = useState(24)
  const [selectionMessageIds, setSelectionMessageIds] = useState<string[]>([])
  const [selectionPlan, setSelectionPlan] = useState<MessageCommentAnchor['plan']>()
  const [selectionReport, setSelectionReport] = useState<MessageCommentAnchor['report']>()
  const [restorationReport, setRestorationReport] = useState<MessageCommentAnchor['report']>()
  const [restorationPlan, setRestorationPlan] = useState<MessageCommentAnchor['plan']>()
  const [restorationMessageIds, setRestorationMessageIds] = useState<string[]>([])
  const [requestedResponseId, setRequestedResponseId] = useState<string>()
  const [focusedRowKey, setFocusedRowKey] = useState<string>()
  const olderRequestedRef = useRef(false)
  const scrollIntentRef = useRef<'older' | 'newer' | 'drag' | 'start' | undefined>(undefined)
  const lastScrollRef = useRef({ top: 0, backward: false })
  const historyReadDirectionRef = useRef<'older' | 'latest'>('older')
  const prependAnchorRef = useRef<
    { messageId: string; top: number; beforeDisplay: ConversationDisplayOrder } | undefined
  >(undefined)
  const focusAfterPageRef = useRef<'latest' | undefined>(undefined)
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null)
  const commentFocusRef = useRef<{ visible: boolean; cancel?: () => void }>({ visible })
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const messagesRef = useRef(snapshot?.messages)
  // Completed Markdown can skip Composer/stream renders; its stable event
  // handlers read the latest projection only when the user acts.
  const messageInteractionRef = useRef({
    snapshot,
    messageMeta: history.window?.messageMeta,
    onNotice,
    onOpenProjectFile,
  })
  const [dismissedNavigation, setDismissedNavigation] = useState<typeof messageNavigation>()
  const [cardPlanNavigation, setCardPlanNavigation] = useState<
    NonNullable<ConversationViewProps['messageNavigation']> & { sessionId: string }
  >()
  const planSourceNavigation =
    messageNavigation?.plan && dismissedNavigation !== messageNavigation
      ? messageNavigation
      : cardPlanNavigation?.sessionId === session.id
        ? cardPlanNavigation
        : undefined
  const openRecordedPlan = useCallback(
    (source: { runId: string; messageId: string; version: number }): void => {
      setDismissedNavigation(messageNavigation)
      setCardPlanNavigation({
        sessionId: session.id,
        navigationId: crypto.randomUUID(),
        messageId: source.messageId,
        startOffset: 0,
        endOffset: 0,
        plan: { runId: source.runId, version: source.version },
      })
      onOpenPlan?.()
    },
    [messageNavigation, onOpenPlan, session.id],
  )
  const planSourceNavigationRef = useRef(planSourceNavigation)
  planSourceNavigationRef.current = planSourceNavigation
  const openPlanCallback = useRef(onOpenPlan)
  openPlanCallback.current = onOpenPlan
  const appliedNavigationRef = useRef<typeof messageNavigation>(undefined)
  const queueDockRef = useRef<HTMLDivElement>(null)
  const appliedGapResyncRef = useRef(0)
  const gapRestoreRef = useRef<
    | {
        messageId: string
        top: number
        plan?: MessageCommentAnchor['plan']
        report?: MessageCommentAnchor['report']
        selection?: {
          messageId?: string
          startOffset: number
          endOffset: number
          highlight?: boolean
          plan?: MessageCommentAnchor['plan']
          report?: MessageCommentAnchor['report']
        }
      }
    | undefined
  >(undefined)
  const stickToBottomRef = useRef(true)
  const wasVisibleRef = useRef(visible)

  const runsById = useMemo(
    () => new Map((snapshot?.runs ?? []).map((run) => [run.id, run])),
    [snapshot?.runs],
  )
  const activitiesByRun = useMemo(() => {
    const grouped = new Map<string, ConversationViewProjection['activities']>()
    for (const activity of snapshot?.activities ?? []) {
      const current = grouped.get(activity.runId)
      if (current) current.push(activity)
      else grouped.set(activity.runId, [activity])
    }
    return grouped
  }, [snapshot?.activities])
  const activityOwnerMessageByRun = useMemo(() => {
    const owners = new Map<string, string>()
    for (const message of snapshot?.messages ?? []) {
      if (
        message.role === 'assistant' &&
        message.runId &&
        (!message.outputSnapshot ||
          (message.outputSnapshot.canonical && isRunResponseComplete(runsById.get(message.runId))))
      )
        owners.set(message.runId, message.id)
    }
    return owners
  }, [snapshot?.messages, runsById])
  const latestRun = history.window?.latestRun

  const [currentPlan, setCurrentPlan] = useState<{
    sessionId: string
    task?: CollaborationTask | undefined
    replacement?:
      | Extract<ConversationPage, { scope: 'collaboration' }>['view']['replacement']
      | undefined
    planSync?: Extract<ConversationPage, { scope: 'collaboration' }>['view']['planSync'] | undefined
    source?: { runId: string; messageId: string } | undefined
    error?: string | undefined
  }>()
  const [planRefresh, setPlanRefresh] = useState(0)
  const [answeredDecisionKey, setAnsweredDecisionKey] = useState<string>()
  const [replacement, setReplacement] = useState<{
    sessionId: string
    taskId: string
    command: 'plan' | 'build' | 'review'
    draftToken: object
  }>()
  const [replacementBusy, setReplacementBusy] = useState(false)
  const [replacementFailed, setReplacementFailed] = useState(false)
  // One frozen replacement reference per confirmation; uncertain acknowledgments retry the same proof.
  const replacementAttempt = useRef<{ taskId: string; revision: number } | undefined>(undefined)
  const replacementRestoreFocus = useRef(false)
  const planReadOwner = useRef<{
    active: boolean
    pending: boolean
    desired?: { sessionId: string; key: string } | undefined
  }>({ active: true, pending: false })
  const planAvailableCallback = useRef(onPlanAvailable)
  planAvailableCallback.current = onPlanAvailable
  const planReadKey = `${latestRun?.id ?? ''}:${latestRun?.status ?? ''}:${latestRun && !['starting', 'running', 'recovering'].includes(latestRun.status) ? latestRun.updatedAt : ''}:${snapshot?.queue?.revision ?? ''}:${planRefresh}`

  useEffect(() => {
    const owner = planReadOwner.current
    owner.active = true
    return () => {
      owner.active = false
      owner.desired = undefined
    }
  }, [])

  useEffect(() => {
    const owner = planReadOwner.current
    owner.desired = visible ? { sessionId: session.id, key: planReadKey } : undefined
    const read = async (): Promise<void> => {
      if (owner.pending || !owner.active || !owner.desired) return
      owner.pending = true
      const requested = owner.desired
      try {
        const response = await window.pact.getConversation({
          scope: 'collaboration',
          sessionId: requested.sessionId,
          projection: 'current',
        })
        if (!owner.active || owner.desired !== requested) return
        if (!response.ok || response.value.scope !== 'collaboration') {
          setCurrentPlan((current) => ({
            ...(current?.sessionId === requested.sessionId ? current : {}),
            sessionId: requested.sessionId,
            error: response.ok ? 'Plan unavailable.' : response.error.message,
          }))
          return
        }
        const view = response.value.view
        const task = view.task ?? undefined
        setCurrentPlan({
          sessionId: requested.sessionId,
          task,
          replacement: view.replacement,
          source: view.planSource,
          planSync: view.planSync,
        })
        if (!planSourceNavigationRef.current)
          planAvailableCallback.current?.(
            requested.sessionId,
            task?.planReference && view.planSource ? task.id : undefined,
          )
      } catch {
        if (owner.active && owner.desired === requested)
          setCurrentPlan((current) => ({
            ...(current?.sessionId === requested.sessionId ? current : {}),
            sessionId: requested.sessionId,
            error: 'Plan unavailable.',
          }))
      } finally {
        owner.pending = false
        if (owner.active && owner.desired && owner.desired !== requested) void read()
      }
    }
    void read()
  }, [session.id, planReadKey, visible])

  const currentTask = currentPlan?.sessionId === session.id ? currentPlan.task : undefined
  const planningTask =
    currentTask && (currentTask.kind === 'plan' || Boolean(currentTask.planReference))
      ? currentTask
      : undefined
  const unfinishedTask = currentTask?.status === 'complete' ? undefined : currentTask
  const inputGateState = unfinishedTask ? collaborationInputGate(unfinishedTask) : undefined
  const planRecovery =
    currentPlan?.sessionId === session.id && currentPlan.planSync?.runId === unfinishedTask?.runId
      ? currentPlan?.planSync
      : undefined
  const decisionSource = unfinishedTask
    ? collaborationInputProcessing(unfinishedTask).decision
    : undefined
  const decisionKey =
    unfinishedTask && decisionSource
      ? `${unfinishedTask.id}:${decisionSource.runId}:${unfinishedTask.inputSequence}`
      : undefined
  const decisionTakeover = Boolean(decisionSource)
  const nativeRequests = nativeInputRequests(snapshot)
  const nativeQuestions = nativeRequests.filter(
    ({ request }) => request.kind && request.kind !== 'approval',
  )

  const relayRequest =
    snapshot?.relaySchedulingDecision?.sessionId === session.id &&
    snapshot.relaySchedulingDecision.decisionId !== history.cancelledInformationDecisionId
      ? snapshot.relaySchedulingDecision
      : undefined
  const relayIdentity = relayRequest
    ? `${relayRequest.sessionId}:${relayRequest.decisionId}:${relayRequest.revision}`
    : undefined
  const [relayUi, setRelayUi] = useState<{
    identity: string
    value: string
    status: RelayDecisionPresentation['status']
    error?: string | undefined
  }>()
  const relayAnswerOwner = useRef<
    { identity: string; input: RelayDecisionAnswer; pending: boolean } | undefined
  >(undefined)
  const relayUiRef = useRef(relayIdentity)
  relayUiRef.current = relayIdentity

  const readRelayReceipt = async (): Promise<void> => {
    const owner = relayAnswerOwner.current
    if (!owner || owner.pending || owner.identity !== relayUiRef.current) return
    owner.pending = true
    setRelayUi((current) =>
      current?.identity === owner.identity ? { ...current, status: 'checking_receipt' } : current,
    )
    try {
      const { reference, clientOperationId } = owner.input
      const result = await window.pact.getRelayDecisionReceipt({
        sessionId: reference.sessionId,
        decisionId: reference.decisionId,
        clientOperationId,
      })
      if (relayUiRef.current !== owner.identity) return
      if (result.ok) {
        history.retryRead()
      } else
        setRelayUi((current) =>
          current?.identity === owner.identity
            ? { ...current, status: 'receipt_unconfirmed', error: result.error.message }
            : current,
        )
    } catch {
      if (relayUiRef.current === owner.identity)
        setRelayUi((current) =>
          current?.identity === owner.identity
            ? {
                ...current,
                status: 'receipt_unconfirmed',
                error:
                  'The scheduling decision is not confirmed. Check its receipt before another action.',
              }
            : current,
        )
    } finally {
      owner.pending = false
    }
  }

  const submitRelayAnswer = async (answer: RelayDecisionAnswer['answer']): Promise<void> => {
    if (
      answer.kind === 'cancel' &&
      relayRequest?.request.category === 'necessary_information' &&
      history.cancelPreparedInformation
    ) {
      await history.cancelPreparedInformation(relayRequest)
      return
    }
    if (!relayRequest || !relayIdentity || relayAnswerOwner.current?.identity === relayIdentity)
      return
    const owner = {
      identity: relayIdentity,
      pending: true,
      input: {
        reference: {
          sessionId: relayRequest.sessionId,
          decisionId: relayRequest.decisionId,
          revision: relayRequest.revision,
        },
        clientOperationId: crypto.randomUUID(),
        answer,
      },
    }
    relayAnswerOwner.current = owner
    setRelayUi((current) => ({
      identity: relayIdentity,
      value: current?.identity === relayIdentity ? current.value : '',
      status: 'submitting',
    }))
    try {
      const result = await window.pact.answerRelayDecision(owner.input)
      if (relayUiRef.current !== owner.identity) return
      if (result.ok) history.retryRead()
      else if (result.error.code === 'TIMEOUT' || result.error.code === 'UNCERTAIN') {
        owner.pending = false
        await readRelayReceipt()
      } else {
        relayAnswerOwner.current = undefined
        setRelayUi((current) =>
          current?.identity === owner.identity
            ? { ...current, status: 'awaiting_confirmation', error: result.error.message }
            : current,
        )
      }
    } catch {
      if (relayUiRef.current === owner.identity) {
        owner.pending = false
        await readRelayReceipt()
      }
    } finally {
      owner.pending = false
    }
  }

  const activeRelayUi = relayUi?.identity === relayIdentity ? relayUi : undefined
  const productionRelayDecision: RelayDecisionPresentation | undefined = relayRequest
    ? {
        request: relayRequest,
        status: activeRelayUi?.status ?? 'awaiting_confirmation',
        answerValue: activeRelayUi?.value ?? '',
        error: activeRelayUi?.error,
        onChangeAnswer: (value) => {
          if (relayIdentity)
            setRelayUi({ identity: relayIdentity, value, status: 'awaiting_confirmation' })
        },
        onConfirm: (answer) => {
          void submitRelayAnswer(answer)
        },
        onCheckReceipt: () => {
          void readRelayReceipt()
        },
        onCancel: () => {
          void submitRelayAnswer({ kind: 'cancel' })
        },
      }
    : undefined
  const cancellation = history.informationCancellation
  const currentRelayDecision =
    cancellation?.request.sessionId === session.id
      ? {
          ...cancellation,
          cancelling: true,
          answerValue: '',
          onChangeAnswer: () => undefined,
          onConfirm: () => undefined,
          onCancel: () => undefined,
          onCheckReceipt: () => {
            void history.checkInformationCancellation?.()
          },
        }
      : relayDecision?.request.sessionId === session.id
        ? relayDecision
        : productionRelayDecision
  const inputTakeover =
    decisionTakeover || nativeQuestions.length > 0 || Boolean(currentRelayDecision)

  const replacementDraftToken = useMemo(
    () => ({}),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Deliberate identity token over the draft inputs.
    [
      composer,
      composerSkills,
      composerMention,
      composerRoute,
      composerReturnedInputOperationId,
      composerImages,
      snapshot?.commentsRevision,
    ],
  )
  const replacementTask =
    replacement && replacement.sessionId === session.id && unfinishedTask?.id === replacement.taskId
      ? unfinishedTask
      : undefined
  const replacementDetails =
    replacementTask && currentPlan?.sessionId === session.id ? currentPlan.replacement : undefined
  useEffect(() => {
    if (
      replacement &&
      (replacement.sessionId !== session.id ||
        replacement.taskId !== unfinishedTask?.id ||
        replacement.draftToken !== replacementDraftToken)
    ) {
      replacementAttempt.current = undefined
      setReplacement(undefined)
    }
  }, [replacement, session.id, unfinishedTask?.id, replacementDraftToken])
  useEffect(() => {
    if (replacement || !replacementRestoreFocus.current) return
    replacementRestoreFocus.current = false
    composerRef.current?.focus()
  }, [replacement])

  const showDecisionNotice = Boolean(
    decisionSource &&
    !planRecovery &&
    decisionKey !== answeredDecisionKey &&
    (inputGateState === 'needs_reply' || inputGateState === 'incomplete'),
  )
  const decisionMessageId =
    decisionSource?.messageId ??
    (decisionSource ? runsById.get(decisionSource.runId)?.responseMessageId : undefined)
  const decisionReply: DecisionReplyContext | undefined =
    showDecisionNotice && decisionSource && unfinishedTask
      ? {
          reference: {
            taskId: unfinishedTask.id,
            runId: decisionSource.runId,
            decisionInputSequence: decisionSource.inputSequence,
            expectedInputSequence: unfinishedTask.inputSequence,
          },
          questions: decisionSource.questions ?? [],
        }
      : undefined
  const decisionAnswersReady = Boolean(
    decisionReply &&
    sameDecision(history.decisionDraft?.reference, decisionReply.reference) &&
    hasDecisionAnswers(history.decisionDraft),
  )
  const activeRun =
    latestRun &&
    latestRun.controlDisposition !== 'abandoned' &&
    ['starting', 'running', 'recovering'].includes(latestRun.status) &&
    !(snapshot?.nativeContexts ?? []).some(
      (context) =>
        context.agentId === latestRun.agentId &&
        context.continuationState &&
        !['responding', 'waiting_user'].includes(context.continuationState),
    )
      ? latestRun
      : undefined

  const sessionIssues = snapshot?.sessionIssues
  const relayRebuild =
    currentRelayDecision?.request.request.category === 'arrangement_change' &&
    currentRelayDecision.request.request.operation.kind === 'rebuild_native_context' &&
    !decisionTakeover &&
    !nativeRequests.length &&
    !planRecovery
      ? currentRelayDecision.request.request.operation
      : undefined
  const visibleSessionIssues =
    sessionIssues && relayRebuild
      ? {
          ...sessionIssues,
          agents: sessionIssues.agents.filter(
            (issue) =>
              !(
                issue.agentId === relayRebuild.agentId &&
                issue.generation === relayRebuild.expectedGeneration &&
                (issue.nativeSessionId ?? null) === relayRebuild.expectedNativeSessionId &&
                (issue.runId ?? null) === relayRebuild.expectedRunId &&
                (issue.rebuildId ?? null) === relayRebuild.expectedRebuildId
              ),
          ),
        }
      : sessionIssues
  const inputGate = sessionIssues?.inputGate ?? 'read_only'
  const recoveryLocked = inputGate === 'read_only'

  const pendingRoutedMessage = snapshot?.messages.find(
    (message) => message.role === 'user' && message.pendingAgentId,
  )
  const pendingRoutedAgentId = pendingRoutedMessage?.pendingAgentId
  const respondingAgentId =
    (snapshot?.nativeContexts ?? []).find(
      (context) =>
        context.continuationState === 'responding' || context.continuationState === 'waiting_user',
    )?.agentId ??
    activeRun?.agentId ??
    (!recoveryLocked ? pendingRoutedAgentId : undefined)
  const backgroundIssues = visibleSessionIssues?.agents ?? []
  const backgroundWorking = backgroundIssues.some((issue) => issue.phase === 'background_working')
  const backgroundStopping = backgroundIssues.some((issue) => issue.phase === 'background_stopping')
  const backgroundCheckNeeded = backgroundIssues.some(
    (issue) => issue.phase === 'background_check' || issue.phase === 'background_checking',
  )
  const backgroundStopIssue = backgroundIssues.find((issue) => issue.backgroundStop)
  const backgroundStop = backgroundStopIssue?.backgroundStop
  const stopping = stopRequested || backgroundStopping
  const responseInProgress = Boolean(respondingAgentId) || stopping
  const showStop = stopping || (!recoveryLocked && Boolean(respondingAgentId || backgroundStop))
  const stopLabel = stopping
    ? 'Stopping…'
    : respondingAgentId
      ? `Stop ${agentName(respondingAgentId)} response`
      : 'Stop background work'
  const requestStop = (): Promise<boolean> => onStop(respondingAgentId ? undefined : backgroundStop)
  const continuationBlocked =
    inputGate !== 'open' || backgroundWorking || backgroundCheckNeeded || stopping
  const activeRunHasMessage = Boolean(
    activeRun &&
    snapshot?.messages.some(
      (message) =>
        (message.runId === activeRun.id ||
          (message.outputSnapshot?.canonical !== false &&
            message.replyToMessageId === activeRun.userMessageId &&
            message.agentId === activeRun.agentId &&
            history.window?.sourceMessageId !== message.id)) &&
        message.role === 'assistant' &&
        (message.content.trim() || history.window?.messageMeta[message.id]?.oversized),
    ),
  )

  const isSideChat = Boolean(session.parentSessionId)
  const [btwSubmitting, setBtwSubmitting] = useState(false)
  const [lastMainSync, setLastMainSync] = useState<
    { sideChatId: string; receipt: SideChatSyncMainReceipt } | undefined
  >()
  const effectiveMainSyncEnabled = mainSyncEnabled ?? agentActionsEnabled
  const anyComposerActionEnabled =
    agentActionsEnabled || (isSideChat && effectiveMainSyncEnabled && Boolean(onSyncToMain))
  const composerDisabled =
    !anyComposerActionEnabled || recoveryLocked || Boolean(history.restoringInput)
  const composerContentReady = useMemo(() => composerHasContent(composer), [composer])
  const composerPrefix = parseComposerCommandPrefix(composer, composerSkills)
  const isBtwReady = !isSideChat && Boolean(composerPrefix.btw && !composerPrefix.error)
  const activePair = useMemo(() => resolveActiveAgentPair(session.settings), [session.settings])
  const resolvedComposerRoute = resolveComposerRoute(
    {
      text: composer,
      skills: composerSkills,
      mention: composerMention,
      route: composerRoute,
      returnedInputOperationId: composerReturnedInputOperationId,
    },
    activePair[0],
    { allowMainRoute: isSideChat, secondaryAgentId: activePair[1] },
  ).route
  const isMainRoute = isSideChat && resolvedComposerRoute.type === 'main'
  const skillComposerDisabled =
    composerDisabled || inputTakeover || (!agentActionsEnabled && !isMainRoute)
  const skillComposer = useSkillComposer({
    session,
    text: composer,
    selections: composerSkills,
    route: composerRoute,
    mention: composerMention,
    returnedInputOperationId: composerReturnedInputOperationId,
    mainTargetAgentId,
    disabled: skillComposerDisabled,
  })
  const activeSkillId = skillComposer.query
    ? skillComposer.options[skillComposer.active]?.id
    : undefined
  const skillMenuOpen = Boolean(skillComposer.query) && visible && !skillComposerDisabled
  const returnedInput = history.window?.view.rebuildInputRecovery
  const queue = snapshot?.queue
  const queueEnabled = queue?.enabled ?? true
  const queuedInput = queue?.input
  const queueActions = history.queueActions
  const canSteerQueuedInput = Boolean(
    queuedInput &&
    queuedInput.recipient !== 'all' &&
    queuedInput.recipient === activeRun?.agentId &&
    activeRun.status === 'running' &&
    activeRun.dispatchPhase === 'accepted' &&
    !activeRun.collaboration &&
    !queuedInput.workflowCommand,
  )
  const steerUnavailableReason = queuedInput?.workflowCommand
    ? 'New workflows wait until the current response finishes.'
    : queuedInput?.recipient === 'all'
      ? 'Messages for all Agents stay queued.'
      : 'Steer is available only for the Agent currently responding.'
  const sharedComposerBlocked =
    recoveryLocked ||
    Boolean(history.restoringInput) ||
    choosingImages ||
    composerImages.some((image) => image.status !== 'ready') ||
    Boolean(skillComposer.warning) ||
    skillComposer.checking ||
    sending ||
    history.draftsLoading
  const mainSyncComposerBlocked = !effectiveMainSyncEnabled || sharedComposerBlocked
  const commonComposerBlocked = !agentActionsEnabled || sharedComposerBlocked
  const disabled =
    commonComposerBlocked ||
    stopping ||
    (inputGate === 'send_blocked' && (!activeRun?.collaboration || backgroundCheckNeeded))
  const previousDecisionRun = unfinishedTask ? runsById.get(unfinishedTask.runId) : undefined
  const incompleteCanAnswer =
    inputGateState !== 'incomplete' ||
    Boolean(
      previousDecisionRun &&
      ((previousDecisionRun.dispatchPhase === 'ended' &&
        previousDecisionRun.nativeEffectsState === 'settled') ||
        (!previousDecisionRun.nativeTurnId &&
          !previousDecisionRun.nativeOutcome &&
          ['not_sent', 'rejected'].includes(previousDecisionRun.dispatchPhase ?? '') &&
          ['not_dispatched', 'settled'].includes(previousDecisionRun.nativeEffectsState ?? ''))),
    )
  const questionDisabled =
    !agentActionsEnabled ||
    composerDisabled ||
    sending ||
    stopping ||
    Boolean(activeRun) ||
    inputGate !== 'open' ||
    Boolean(history.restoringInput) ||
    !incompleteCanAnswer
  const draftComments = snapshot?.draftComments ?? EMPTY_COMMENTS
  const hasDraft =
    composerContentReady ||
    draftComments.length > 0 ||
    Boolean(history.draftPage?.hasMore || history.draftPage?.hasEarlier) ||
    composerImages.length > 0
  const showSend = !showStop || hasDraft
  const workingIssues = backgroundIssues.filter((issue) => issue.phase === 'background_working')
  const waitingBackgroundIssue =
    queueEnabled &&
    queuedInput?.state === 'queued' &&
    workingIssues.length === 1 &&
    workingIssues[0]?.action === 'none'
      ? workingIssues[0]
      : undefined
  const stoppingBackgroundAgent =
    !respondingAgentId && stopping
      ? (backgroundIssues.find((issue) => issue.phase === 'background_stopping')?.agentId ??
        backgroundStopIssue?.agentId)
      : undefined
  const stoppingBackgroundInQueue = Boolean(
    queuedInput &&
    queuedInput.state !== 'unknown' &&
    queuedInput.state !== 'dispatching' &&
    stoppingBackgroundAgent,
  )
  const queuedBackgroundAgent = stoppingBackgroundInQueue
    ? stoppingBackgroundAgent
    : waitingBackgroundIssue?.agentId
  const feedbackDraft = Boolean(
    unfinishedTask &&
    (composerContentReady ||
      draftComments.length ||
      composerImages.length ||
      commentEditor?.body.trim()),
  )
  const commentDraftId = commentEditor?.draftId

  const defaultRecipient =
    unfinishedTask && !composerPrefix.pact
      ? collaborationActor(unfinishedTask, 'reply')
      : session.settings.primaryAgentId
  const primaryName = agentName(activePair[0])
  const secondaryName = agentName(activePair[1])
  const availableMentionOptions = useMemo(
    () => buildMentionOptions(activePair, isSideChat),
    [activePair, isSideChat],
  )
  const filteredMentionOptions = availableMentionOptions.filter(
    (option) =>
      (option.token === '@Main' ? effectiveMainSyncEnabled : agentActionsEnabled) &&
      option.token
        .slice(1)
        .toLowerCase()
        .startsWith((mentionQuery?.query ?? '').toLowerCase()) &&
      (!unfinishedTask || isBtwReady || option.token !== '@all'),
  )
  const mentionListOpen = Boolean(
    mentionQuery &&
    filteredMentionOptions.length > 0 &&
    visible &&
    !composerDisabled &&
    !inputTakeover,
  )
  const mentionListId = `message-recipients-${session.id}`
  const activeMentionId = mentionListOpen
    ? `${mentionListId}-${filteredMentionOptions[activeMentionIndex]?.token.slice(1) ?? 'none'}`
    : undefined

  const scrollVersion = `${snapshot?.messages.at(-1)?.id ?? ''}:${snapshot?.messages.length ?? 0}:${snapshot?.activities.length ?? 0}:${snapshot?.runs.length ?? 0}:${loading}`
  const residentMessages = snapshot?.messages
  const navigationMessage = messageNavigation
    ? residentMessages?.find((message) => message.id === messageNavigation.messageId)
    : undefined
  useEffect(() => {
    dismissedMention.current = undefined
    setMentionQuery(undefined)
    setActiveMentionIndex(0)
  }, [session.id])

  const historyLoadingPage = history.loadingPage
  const hasOlderHistory = history.window?.hasOlder
  const hasNewerHistory = Boolean(
    history.window &&
    (history.window.hasNewer ||
      (history.window.latestCompleteAssistantSequence ?? -1) >
        (residentMessages?.reduce(
          (latest, message) => Math.max(latest, conversationMessageOrder(message).sequence),
          -1,
        ) ?? -1)),
  )
  const ensureMessage = history.ensureMessage
  const recoverFromGap = history.recoverFromGap
  const loadLatestForGap = history.recoverLatest ?? history.loadLatest
  const historyLoading = history.loadingPage
  const gapRecoveryPending = history.gapRecoveryPending
  const historyResyncToken = history.historyResyncToken
  const protectReading = history.protectReading

  useLayoutEffect(() => {
    messagesRef.current = snapshot?.messages
    messageInteractionRef.current = {
      snapshot,
      messageMeta: history.window?.messageMeta,
      onNotice,
      onOpenProjectFile,
    }
  }, [snapshot, history.window?.messageMeta, onNotice, onOpenProjectFile])

  // Refresh any cached workspace file lists whose changeSet revision advanced (e.g. recording -> settled).
  const workspaceChangesRevisionKey = useMemo(
    () =>
      (snapshot?.runs ?? [])
        .filter((run) => Boolean(run.workspaceChanges))
        .map((run) => `${run.workspaceChanges!.id}:${run.workspaceChanges!.revision ?? 0}`)
        .join('|'),
    [snapshot?.runs],
  )
  useEffect(() => {
    const runs = messageInteractionRef.current.snapshot?.runs
    if (!runs?.length) return
    const trackedIds = new Set<string>([
      ...workspaceFilesMapRef.current.keys(),
      ...workspaceFileLoadsRef.current.keys(),
    ])
    for (const changeSetId of trackedIds) {
      const summary = runs.find((run) => run.workspaceChanges?.id === changeSetId)?.workspaceChanges
      if (!summary) continue
      const nextRevision = summary.revision ?? 0
      const list = workspaceFilesMapRef.current.get(changeSetId)
      const slot = workspaceFileLoadsRef.current.get(changeSetId)
      if (slot?.inFlight) {
        if (slot.inFlightRevision === nextRevision) continue
        slot.generation += 1
        if (slot.timeout !== undefined) {
          window.clearTimeout(slot.timeout)
          slot.timeout = undefined
        }
        slot.queued = coalesceWorkspaceLoadIntent(
          slot.queued,
          {
            expand: slot.inFlightExpand || list?.expanded || false,
            open: slot.inFlightOpen,
            contextGeneration: slot.inFlightContextGeneration,
            targetRevision: nextRevision,
          },
          { autoRefresh: true },
        )
        continue
      }
      if (slot?.waitingForConcurrency && slot.queued) {
        if (slot.queued.targetRevision !== nextRevision) {
          slot.queued = { ...slot.queued, targetRevision: nextRevision }
        }
        continue
      }
      if (list && (list.revision ?? 0) !== nextRevision) {
        void loadWorkspaceFiles(changeSetId, list.expanded)
      }
    }
  }, [workspaceChangesRevisionKey, loadWorkspaceFiles])

  const openProjectFile = useCallback((target: ProjectFileTarget): void => {
    messageInteractionRef.current.onOpenProjectFile(target)
  }, [])
  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLElement | null): void => {
      if (element) messageRefs.current.set(messageId, element)
      else messageRefs.current.delete(messageId)
    },
    [],
  )

  const visibleReadingSource = useCallback(():
    | {
        messageId: string
        element: HTMLElement
        plan?: MessageCommentAnchor['plan']
      }
    | undefined => {
    const transcript = transcriptRef.current
    if (!transcript) return undefined
    const viewport = transcript.getBoundingClientRect()
    const visibleElement = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    }
    let first:
      | { messageId: string; element: HTMLElement; plan?: MessageCommentAnchor['plan'] }
      | undefined
    const consider = (candidate: NonNullable<typeof first>): void => {
      if (!visibleElement(candidate.element)) return
      if (
        !first ||
        first.element.compareDocumentPosition(candidate.element) & Node.DOCUMENT_POSITION_PRECEDING
      )
        first = candidate
    }
    for (const message of messagesRef.current ?? []) {
      const element = messageRefs.current.get(message.id)
      if (element) consider({ messageId: message.id, element })
    }
    for (const document of transcript.querySelectorAll<HTMLElement>('[data-pact-plan-run-id]')) {
      const plan = planSelectionSource(document)
      const messageId = document.dataset.pactPlanMessageId
      const element = document.closest<HTMLElement>('.pact-review-card')
      if (plan && messageId && element) consider({ messageId, element, plan })
    }
    return first
  }, [])

  const readingPositionLost = history.readingPositionLost
  const hasProtectedSelection = useCallback((): boolean => {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const messageId = (
      anchor instanceof HTMLElement ? anchor : anchor?.parentElement
    )?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    return Boolean(
      selection &&
      !selection.isCollapsed &&
      transcriptRef.current?.contains(selection.anchorNode) &&
      messagesRef.current?.find((message) => message.id === messageId)?.state !== 'streaming' &&
      !isProjectionHighlightOwned(),
    )
  }, [])

  const clearOffscreenOrdinarySelection = useCallback((): void => {
    const selection = window.getSelection()
    const transcript = transcriptRef.current
    if (
      !selection ||
      selection.isCollapsed ||
      !transcript?.contains(selection.anchorNode) ||
      isProjectionHighlightOwned()
    )
      return
    const anchor = selection.anchorNode
    const selectedMessageId = (
      anchor instanceof HTMLElement ? anchor : anchor?.parentElement
    )?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const selectedIds = selectionMessageIds.length
      ? selectionMessageIds
      : selectedMessageId
        ? [selectedMessageId]
        : []
    const viewport = transcript.getBoundingClientRect()
    const selectedRows = selectionPlan
      ? [transcript.querySelector<HTMLElement>(`[data-pact-plan-run-id="${selectionPlan.runId}"]`)]
      : selectedIds.map((id) => messageRefs.current.get(id))
    const offscreen = selectedRows.some((row) => {
      if (!row) return true
      const rect = row.getBoundingClientRect()
      return rect.bottom <= viewport.top || rect.top >= viewport.bottom
    })
    if (!offscreen) return
    const restore = gapRestoreRef.current
    if (restore?.selection) {
      gapRestoreRef.current = {
        messageId: restore.messageId,
        top: restore.top,
        ...(restore.plan ? { plan: restore.plan } : {}),
      }
      setRestorationMessageIds([restore.messageId])
    }
    selection.removeAllRanges()
    setSelectionMessageIds([])
  }, [selectionMessageIds, selectionPlan])

  const snapshotFoldGuard = useCallback(
    (): boolean =>
      visible &&
      stickToBottomRef.current &&
      !hasProtectedSelection() &&
      !history.gapRecoveryPending &&
      !Object.values(history.window?.messageMeta ?? {}).some((meta) => meta.bodyResync),
    [visible, hasProtectedSelection, history.gapRecoveryPending, history.window?.messageMeta],
  )
  useLayoutEffect(() => {
    history.setSnapshotFoldGuard?.(snapshotFoldGuard)
    return () => history.setSnapshotFoldGuard?.(undefined)
  }, [history, snapshotFoldGuard])

  const collapseCompletedOutput = useCallback(() => {
    const runId = history.window?.preserveRunId
    if (!runId) return
    const run = runsById.get(runId)
    if (
      !run?.outputSnapshots?.settled ||
      history.loadingPage ||
      history.pageError ||
      !snapshotFoldGuard()
    )
      return
    const canonical = snapshot?.messages.find(
      (message) => message.runId === run.id && message.outputSnapshot?.canonical,
    )
    if (!canonical || canonical.state !== 'complete') return
    void history.collapseEarlierResponses?.(run.id)
  }, [history, runsById, snapshotFoldGuard, snapshot?.messages])
  useEffect(collapseCompletedOutput, [collapseCompletedOutput])

  const rows = useMemo<ConversationTranscriptRow[]>(() => {
    const messages = (snapshot?.messages ?? []).filter(
      (message) =>
        message.role !== 'assistant' ||
        message.content.trim() ||
        history.window?.messageMeta[message.id]?.oversized ||
        history.window?.messageMeta[message.id]?.hasComments ||
        Boolean(
          message.runId &&
          (hasVisibleChanges(runsById.get(message.runId)) ||
            runsById.get(message.runId)?.collaboration),
        ),
    )
    const result: ConversationTranscriptRow[] = messages.map((message) => ({
      key:
        message.outputSnapshot && message.outputSnapshot.ordinal > 0
          ? `message:${message.id}`
          : history.window?.sourceMessageId === message.id
            ? `source:${message.id}`
            : message.replyToMessageId
              ? `reply:${message.replyToMessageId}:${message.agentId ?? 'unknown'}:${message.runId ?? 'unknown'}`
              : `message:${message.id}`,
      message,
      run: undefined,
      context: undefined,
    }))
    for (const context of history.window?.runContexts ?? []) {
      const run = runsById.get(context.runId)
      if (run && !isRunResponseComplete(run))
        result.push({ key: `run-context:${context.runId}`, message: undefined, run, context })
    }
    result.sort((left, right) =>
      compareConversationDisplayOrder(
        left.message ? conversationMessageOrder(left.message) : left.context!.order,
        right.message ? conversationMessageOrder(right.message) : right.context!.order,
      ),
    )
    const artifactGroups = history.window?.runArtifacts ?? []
    const latestArtifactIds = new Set(artifactGroups.map((group) => group.latestRunId))
    for (const run of snapshot?.runs ?? []) {
      if ((!hasVisibleChanges(run) && !hasRecordingWarning(run)) || !latestArtifactIds.has(run.id))
        continue
      const replyIndex = result.findIndex(
        (row) =>
          row.message?.replyToMessageId === run.userMessageId &&
          row.message.agentId === run.agentId &&
          row.message.outputSnapshot?.canonical !== false,
      )
      if (run.outputSnapshots?.count && replyIndex < 0) continue
      const userIndex =
        replyIndex >= 0
          ? replyIndex
          : result.findIndex(
              (row) =>
                row.message?.id === run.userMessageId ||
                row.message?.replyToMessageId === run.userMessageId,
            )
      if (userIndex < 0) continue
      let index = userIndex + 1
      while (index < result.length) {
        const next = result[index]!
        if (
          next.message?.replyToMessageId !== run.userMessageId &&
          next.run?.userMessageId !== run.userMessageId
        )
          break
        const nextRun =
          next.run ?? (next.message?.runId ? runsById.get(next.message.runId) : undefined)
        if (nextRun && nextRun.createdAt > run.createdAt) break
        index += 1
      }
      result.splice(index, 0, { key: `changes:${run.id}`, message: undefined, run })
    }
    for (const run of snapshot?.runs ?? []) {
      if (
        !run.collaboration ||
        ['starting', 'running', 'recovering'].includes(run.status) ||
        result.some(
          (row) =>
            row.run?.id === run.id ||
            (row.message?.role === 'assistant' && row.message.runId === run.id),
        )
      )
        continue
      const userIndex = result.findIndex((row) => row.message?.id === run.userMessageId)
      if (userIndex >= 0)
        result.splice(userIndex + 1, 0, {
          key: `reply:${run.userMessageId}:${run.agentId}:${run.id}`,
          message: undefined,
          run,
        })
    }
    if (
      activeRun &&
      !activeRunHasMessage &&
      !result.some((row) => row.context?.runId === activeRun.id)
    )
      result.push({
        key: `reply:${activeRun.userMessageId}:${activeRun.agentId}:${activeRun.id}`,
        message: undefined,
        run: activeRun,
      })
    return result
  }, [
    snapshot?.messages,
    history.window?.messageMeta,
    history.window?.sourceMessageId,
    activeRun,
    activeRunHasMessage,
    snapshot?.runs,
    history.window?.runArtifacts,
    history.window?.runContexts,
    runsById,
  ])

  const rowKeySignature = useMemo(() => rows.map((row) => row.key).join('\0'), [rows])
  const rowKeys = useMemo(
    () => (rowKeySignature ? rowKeySignature.split('\0') : []),
    [rowKeySignature],
  )
  const getRowKey = useCallback((index: number) => rowKeys[index]!, [rowKeys])
  const pinnedIndexes = useMemo(() => {
    const ids = new Set(selectionMessageIds)
    const workLogRunId = history.window?.activityView?.manual
      ? history.window.activityView.runId
      : undefined
    const workLogComplete = isRunResponseComplete(
      workLogRunId ? runsById.get(workLogRunId) : undefined,
    )
    const planRunId =
      selectionPlan?.runId ??
      selectionReport?.runId ??
      restorationReport?.runId ??
      restorationPlan?.runId ??
      (messageNavigation && dismissedNavigation !== messageNavigation
        ? (messageNavigation.plan?.runId ?? messageNavigation.report?.runId)
        : undefined)
    for (const id of restorationMessageIds) ids.add(id)
    if (messageNavigation && dismissedNavigation !== messageNavigation)
      ids.add(messageNavigation.messageId)
    return rows.flatMap((row, index) =>
      row.key === focusedRowKey ||
      (row.message && ids.has(row.message.id)) ||
      Boolean(
        planRunId &&
        !row.context &&
        row.message?.outputSnapshot?.canonical !== false &&
        (row.run?.id === planRunId || row.message?.runId === planRunId),
      ) ||
      Boolean(
        workLogRunId &&
        (workLogComplete
          ? row.message?.id === activityOwnerMessageByRun.get(workLogRunId)
          : row.context?.runId === workLogRunId ||
            (!history.window?.runContexts?.some((context) => context.runId === workLogRunId) &&
              (row.run?.id === workLogRunId ||
                row.message?.id === activityOwnerMessageByRun.get(workLogRunId)))),
      )
        ? [index]
        : [],
    )
  }, [
    selectionMessageIds,
    selectionPlan,
    selectionReport,
    restorationReport,
    restorationPlan,
    restorationMessageIds,
    focusedRowKey,
    messageNavigation,
    dismissedNavigation,
    rows,
    history.window?.activityView,
    history.window?.runContexts,
    activityOwnerMessageByRun,
    runsById,
  ])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => 180,
    getItemKey: getRowKey,
    overscan: TRANSCRIPT_OVERSCAN,
    useFlushSync: true,
    measureElement: (element, entry) =>
      entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height,
    scrollMargin: listOffset,
    rangeExtractor: useCallback(
      (range) => {
        const indexes = new Set(pinnedIndexes.slice(0, CONVERSATION_WINDOW_MESSAGES))
        for (const index of defaultRangeExtractor(range)) {
          if (indexes.size >= CONVERSATION_WINDOW_MESSAGES) break
          indexes.add(index)
        }
        return [...indexes].toSorted((a, b) => a - b)
      },
      [pinnedIndexes],
    ),
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (scrollIntentRef.current === 'start') return false
    const top = transcriptRef.current?.scrollTop ?? instance.scrollOffset ?? 0
    return instance.itemSizeCache.has(item.key) ? item.end <= top : item.start < top
  }
  const virtualRows = virtualizer.getVirtualItems()
  const isViewportCommitted = useCallback(
    (transcript: HTMLElement): boolean => {
      if (Math.abs((virtualizer.scrollOffset ?? 0) - transcript.scrollTop) > 1) return false
      const current = virtualizer.getVirtualItems()
      return (
        current.length === virtualRows.length &&
        current.every((item, index) => {
          const rendered = virtualRows[index]!
          return (
            item.index === rendered.index &&
            item.key === rendered.key &&
            item.start === rendered.start &&
            item.size === rendered.size
          )
        })
      )
    },
    [virtualizer, virtualRows],
  )
  const mountedRowKeys = virtualRows.map((row) => row.key).join(':')
  const retainedRowKeys = useMemo(() => new Set(rowKeys), [rowKeys])
  const pruneMeasurements = useCallback(() => {
    for (const key of virtualizer.itemSizeCache.keys()) {
      if (!retainedRowKeys.has(String(key))) virtualizer.itemSizeCache.delete(key)
    }
  }, [virtualizer, retainedRowKeys])
  const measureRow = useCallback(
    (element: HTMLLIElement | null) => {
      if (element) pruneMeasurements()
      virtualizer.measureElement(element)
    },
    [virtualizer, pruneMeasurements],
  )
  useLayoutEffect(() => {
    pruneMeasurements()
  }, [pruneMeasurements])
  const cancelPrepend = useCallback(() => {
    if (!prependAnchorRef.current) return
    prependAnchorRef.current = undefined
    setRestorationMessageIds([])
  }, [])

  useEffect(() => {
    const protectSelection = (): void => {
      const selection = window.getSelection()
      const transcript = transcriptRef.current
      const ids: string[] = []
      let plan: MessageCommentAnchor['plan']
      let report: MessageCommentAnchor['report']
      if (selection && !selection.isCollapsed && selection.rangeCount === 1 && transcript) {
        const range = selection.getRangeAt(0)
        if (transcript.contains(range.commonAncestorContainer)) {
          const node = range.commonAncestorContainer
          const host = (
            node instanceof HTMLElement ? node : node.parentElement
          )?.closest<HTMLElement>('[data-pact-message-content]')
          if (host) {
            plan = planSelectionSource(host)
            report = reportSelectionSource(host)
          }
          for (const [id, row] of messageRefs.current) {
            if (
              messagesRef.current?.find((message) => message.id === id)?.state !== 'streaming' &&
              range.intersectsNode(row)
            )
              if (!ids.includes(id)) ids.push(id)
          }
        }
      }
      setSelectionMessageIds((previous) =>
        previous.length === ids.length && previous.every((id, index) => id === ids[index])
          ? previous
          : ids,
      )
      setSelectionPlan((previous) =>
        previous?.runId === plan?.runId && previous?.version === plan?.version ? previous : plan,
      )
      if (ids.length > 0) {
        stickToBottomRef.current = false
        scrollIntentRef.current = undefined
      }
      setSelectionReport((previous) =>
        JSON.stringify(previous) === JSON.stringify(report) ? previous : report,
      )
    }
    document.addEventListener('selectionchange', protectSelection)
    return () => document.removeEventListener('selectionchange', protectSelection)
  }, [])

  useEffect(() => {
    if (historyResyncToken === 0) {
      appliedGapResyncRef.current = 0
      gapRestoreRef.current = undefined
      gapRetryRef.current = { mode: 'latest' }
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
    }
  }, [historyResyncToken])

  useLayoutEffect(() => {
    const element = transcriptRef.current
    if (visible && scrollVersion && element && stickToBottomRef.current)
      element.scrollTop = element.scrollHeight
  }, [scrollVersion, visible, mountedRowKeys])

  useLayoutEffect(() => {
    if (wasVisibleRef.current === visible) return
    wasVisibleRef.current = visible
    if (visible) return
    cancelPrepend()
    const transcript = transcriptRef.current
    const selection = window.getSelection()
    const host =
      selection?.anchorNode instanceof HTMLElement
        ? selection.anchorNode.closest<HTMLElement>('[data-pact-message-content]')
        : selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-pact-message-content]')
    const selectedId = host?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const plan = host ? planSelectionSource(host) : undefined
    const report = host ? reportSelectionSource(host) : undefined
    const selected =
      snapshot?.messages.find((message) => message.id === selectedId)?.state !== 'streaming' &&
      selection &&
      !selection.isCollapsed &&
      host &&
      transcript?.contains(host)
        ? selectedTextRange(host, selection, CONVERSATION_MARKDOWN_BYTES)
        : undefined
    const anchor = visibleReadingSource()
    const row = anchor?.element
    if (!anchor || !row || (stickToBottomRef.current && !selected)) {
      protectReading(undefined)
      return
    }
    gapRestoreRef.current = {
      messageId: anchor.messageId,
      top: row.getBoundingClientRect().top,
      ...(anchor.plan ? { plan: anchor.plan } : {}),
      ...(selected && selectedId
        ? {
            selection: {
              messageId: selectedId,
              highlight: isProjectionHighlightOwned(),
              startOffset: selected.startOffset,
              endOffset: selected.endOffset,
              ...(plan ? { plan } : {}),
              ...(report ? { report } : {}),
            },
          }
        : {}),
    }
    setRestorationMessageIds([anchor.messageId, ...(selected && selectedId ? [selectedId] : [])])
    setRestorationPlan(anchor.plan ?? (selected ? plan : undefined))
    setRestorationReport(selected ? report : undefined)
    protectReading(anchor.messageId)
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
  }, [protectReading, snapshot?.messages, visible, cancelPrepend, visibleReadingSource])

  useLayoutEffect(() => {
    if (!residentMessages) return undefined
    const anchor = prependAnchorRef.current
    if (!anchor) return undefined
    const oldest = history.window ? conversationWindowStartOrder(history.window) : undefined
    if (!oldest || compareConversationDisplayOrder(oldest, anchor.beforeDisplay) >= 0)
      return undefined
    const message = messageRefs.current.get(anchor.messageId)
    const transcript = transcriptRef.current
    if (!transcript) return undefined
    if (!message) {
      const index = rows.findIndex((row) => row.message?.id === anchor.messageId)
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' })
      else {
        prependAnchorRef.current = undefined
        setRestorationMessageIds([])
      }
      return undefined
    }
    virtualizer.scrollToOffset(
      transcript.scrollTop + message.getBoundingClientRect().top - anchor.top,
    )
    const frame = requestAnimationFrame(() => {
      if (
        prependAnchorRef.current !== anchor ||
        !message.isConnected ||
        !isViewportCommitted(transcript) ||
        Math.abs(message.getBoundingClientRect().top - anchor.top) > 2
      )
        return undefined
      prependAnchorRef.current = undefined
      setRestorationMessageIds([])
      return undefined
    })
    return () => cancelAnimationFrame(frame)
  }, [residentMessages, history.window, rows, virtualizer, virtualRows, isViewportCommitted])

  useLayoutEffect(() => {
    const restore = gapRestoreRef.current
    const transcript = transcriptRef.current
    if (
      !visible ||
      loading ||
      !snapshot?.messages ||
      !transcript ||
      historyLoading ||
      gapRecoveryPending
    )
      return undefined
    if (!restore && !readingPositionLost) return undefined
    const message = restore?.plan
      ? transcript
          .querySelector<HTMLElement>(`[data-pact-plan-run-id="${restore.plan.runId}"]`)
          ?.closest<HTMLElement>('.pact-review-card')
      : restore
        ? messageRefs.current.get(restore.messageId)
        : undefined
    if (restore?.plan && !message && !readingPositionLost) return undefined
    if (restore && !message && !readingPositionLost) {
      const index = rows.findIndex((row) => row.message?.id === restore.messageId)
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'start' })
        return undefined
      }
    }
    if (!message || readingPositionLost) {
      gapRestoreRef.current = undefined
      setRestorationMessageIds([])
      gapRetryRef.current = { mode: 'latest' }
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      protectReading(undefined)
      stickToBottomRef.current = true
      transcript.scrollTop = transcript.scrollHeight
      if (!readingPositionLost) void loadLatestForGap()
      return undefined
    }
    if (!restore) return undefined
    const selectionMessage = restore.selection?.messageId
      ? messageRefs.current.get(restore.selection.messageId)
      : message
    if (
      restore.selection?.messageId &&
      !selectionMessage &&
      !restore.selection.plan &&
      !restore.selection.report
    ) {
      const index = rows.findIndex((row) => row.message?.id === restore.selection!.messageId)
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'start' })
        return undefined
      }
      gapRestoreRef.current = {
        messageId: restore.messageId,
        top: restore.top,
        ...(restore.plan ? { plan: restore.plan } : {}),
      }
      setRestorationMessageIds([restore.messageId])
      setSelectionMessageIds([])
      const currentSelection = window.getSelection()
      if (transcript.contains(currentSelection?.anchorNode ?? null))
        currentSelection?.removeAllRanges()
      return undefined
    }
    virtualizer.scrollToOffset(
      transcript.scrollTop + message.getBoundingClientRect().top - restore.top,
    )
    const content = restore.selection?.plan
      ? transcript.querySelector<HTMLElement>(
          `[data-pact-plan-run-id="${restore.selection.plan.runId}"] [data-pact-message-content]`,
        )
      : restore.selection?.report
        ? transcript.querySelector<HTMLElement>(
            `${reportSourceSelector(restore.selection.report)} [data-pact-message-content]`,
          )
        : selectionMessage?.querySelector<HTMLElement>('[data-pact-message-content]')
    const frame = requestAnimationFrame(() => {
      if (
        gapRestoreRef.current !== restore ||
        !wasVisibleRef.current ||
        !message.isConnected ||
        !isViewportCommitted(transcript) ||
        Math.abs(message.getBoundingClientRect().top - restore.top) > 2
      )
        return undefined
      if (restore.selection) {
        if (
          !content?.isConnected ||
          !focusProjectionRange(
            content,
            restore.selection.startOffset,
            restore.selection.endOffset,
            { scroll: false, highlight: restore.selection.highlight ?? false },
          )
        )
          return undefined
        setSelectionMessageIds([restore.selection.messageId ?? restore.messageId])
      }
      gapRestoreRef.current = undefined
      setRestorationMessageIds([])
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      return undefined
    })
    return () => cancelAnimationFrame(frame)
  }, [
    visible,
    loading,
    snapshot?.messages,
    historyLoading,
    gapRecoveryPending,
    protectReading,
    readingPositionLost,
    loadLatestForGap,
    rows,
    virtualizer,
    virtualRows,
    isViewportCommitted,
    messageNavigation,
  ])

  useEffect(() => {
    const token = historyResyncToken
    if (!visible || !token || token === appliedGapResyncRef.current || historyLoading) return
    appliedGapResyncRef.current = token
    cancelPrepend()
    scrollIntentRef.current = undefined
    const transcript = transcriptRef.current
    const firstVisible = visibleReadingSource()
    if (!firstVisible || !transcript) {
      gapRetryRef.current = { mode: 'latest' }
      gapRestoreRef.current = undefined
      setRestorationPlan(undefined)
      setRestorationReport(undefined)
      protectReading(undefined)
      stickToBottomRef.current = true
      if (transcript) transcript.scrollTop = transcript.scrollHeight
      void loadLatestForGap()
      return
    }
    const row = firstVisible.element
    if (!row) return
    const selection = window.getSelection()
    const selectionHost = (() => {
      if (!selection || selection.rangeCount !== 1) return undefined
      const node = selection.getRangeAt(0).commonAncestorContainer
      return (
        (node instanceof HTMLElement
          ? node.closest<HTMLElement>('[data-pact-message-content]')
          : node.parentElement?.closest<HTMLElement>('[data-pact-message-content]')) ?? undefined
      )
    })()
    const selectedMessageId =
      selectionHost?.closest<HTMLElement>('[data-pact-message-id]')?.dataset.pactMessageId
    const plan = selectionHost ? planSelectionSource(selectionHost) : undefined
    const report = selectionHost ? reportSelectionSource(selectionHost) : undefined
    const selected =
      selectedMessageId &&
      snapshot?.messages.find((message) => message.id === selectedMessageId)?.state !==
        'streaming' &&
      selection &&
      selectionHost
        ? selectedTextRange(selectionHost, selection, CONVERSATION_MARKDOWN_BYTES)
        : undefined
    gapRestoreRef.current = {
      messageId: firstVisible.messageId,
      top: row.getBoundingClientRect().top,
      ...(firstVisible.plan ? { plan: firstVisible.plan } : {}),
      ...(selected && selectedMessageId
        ? {
            selection: {
              messageId: selectedMessageId,
              startOffset: selected.startOffset,
              endOffset: selected.endOffset,
              highlight: isProjectionHighlightOwned(),
              ...(plan ? { plan } : {}),
              ...(report ? { report } : {}),
            },
          }
        : {}),
    }
    setRestorationMessageIds([
      firstVisible.messageId,
      ...(selected && selectedMessageId ? [selectedMessageId] : []),
    ])
    setRestorationPlan(firstVisible.plan ?? (selected ? plan : undefined))
    setRestorationReport(selected ? report : undefined)
    gapRetryRef.current = { mode: 'around', messageId: firstVisible.messageId }
    stickToBottomRef.current = false
    void recoverFromGap(firstVisible.messageId)
  }, [
    historyResyncToken,
    visible,
    historyLoading,
    recoverFromGap,
    loadLatestForGap,
    protectReading,
    snapshot?.messages,
    visibleReadingSource,
    cancelPrepend,
  ])

  useEffect(() => {
    if (historyLoadingPage || !focusAfterPageRef.current) return
    const direction = focusAfterPageRef.current
    focusAfterPageRef.current = undefined
    if (direction === 'latest' && !hasNewerHistory) {
      const last = residentMessages?.findLast((message) => message.role !== 'system')
      if (last) messageRefs.current.get(last.id)?.focus({ preventScroll: true })
    }
  }, [historyLoadingPage, hasNewerHistory, residentMessages])

  useLayoutEffect(() => {
    const content = transcriptContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const transcript = transcriptRef.current
      const list = messageListRef.current
      if (transcript && list)
        setListOffset(
          list.getBoundingClientRect().top -
            transcript.getBoundingClientRect().top +
            transcript.scrollTop,
        )
      if (transcript && !document.hidden && stickToBottomRef.current)
        transcript.scrollTop = transcript.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !messageNavigation || dismissedNavigation === messageNavigation)
      return undefined
    if (appliedNavigationRef.current === messageNavigation) return undefined
    if (messageNavigation.plan) return undefined
    cancelPrepend()
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
    gapRestoreRef.current = undefined
    setRestorationMessageIds([])
    setRestorationPlan(undefined)
    setRestorationReport(undefined)
    if (
      messageNavigation.queuedOperationId &&
      queuedInput?.id === messageNavigation.queuedOperationId
    ) {
      const dock = queueDockRef.current
      if (!dock) return undefined
      const focusDock = (): void => {
        dock.scrollIntoView({ behavior: 'smooth', block: 'center' })
        pulseMessageTarget(dock)
        appliedNavigationRef.current = messageNavigation
      }
      const frame = requestAnimationFrame(focusDock)
      return () => cancelAnimationFrame(frame)
    }
    void ensureMessage(messageNavigation.messageId)
    if (history.window?.sourceMessageId !== messageNavigation.messageId) return undefined
    if (messageNavigation.plan || messageNavigation.report) return undefined
    const message = navigationMessage
      ? messageRefs.current.get(messageNavigation.messageId)
      : undefined
    if (!message && navigationMessage) {
      const index = rows.findIndex((row) => row.message?.id === messageNavigation.messageId)
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
      return undefined
    }
    if (message) {
      stickToBottomRef.current = false
      const focus = (): boolean => {
        if (hasProtectedSelection()) return false
        if (
          focusProjectionRange(
            message,
            messageNavigation.startOffset,
            messageNavigation.endOffset,
            { scroll: false },
          )
        ) {
          const transcript = transcriptRef.current
          const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
          if (transcript && range) {
            virtualizer.scrollToOffset(
              transcript.scrollTop +
                range.top -
                transcript.getBoundingClientRect().top -
                transcript.clientHeight / 2 +
                range.height / 2,
              { behavior: 'smooth' },
            )
          }
          appliedNavigationRef.current = messageNavigation
          return true
        }
        if (messageNavigation.textBasis === 'plain-visible-v1') {
          const transcript = transcriptRef.current
          const rect = message.getBoundingClientRect()
          if (transcript && rect.height > 0) {
            virtualizer.scrollToOffset(
              transcript.scrollTop +
                rect.top -
                transcript.getBoundingClientRect().top -
                transcript.clientHeight / 2 +
                rect.height / 2,
              { behavior: 'smooth' },
            )
          }
          pulseMessageTarget(message)
          appliedNavigationRef.current = messageNavigation
          return true
        }
        return false
      }
      const frame = focus() ? undefined : requestAnimationFrame(() => void focus())
      return () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
      }
    }
    return undefined
  }, [
    ensureMessage,
    dismissedNavigation,
    hasProtectedSelection,
    messageNavigation,
    queuedInput?.id,
    history.window?.sourceMessageId,
    visible,
    navigationMessage,
    mountedRowKeys,
    rows,
    virtualizer,
    cancelPrepend,
  ])

  useEffect(() => clearProjectionHighlight, [messageNavigation, dismissedNavigation])

  useLayoutEffect(() => {
    if (!requestedResponseId || !visible) return
    const index = rows.findIndex((row) => row.message?.id === requestedResponseId)
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    const element = messageRefs.current.get(requestedResponseId)
    if (!element) return
    element.focus({ preventScroll: true })
    setRequestedResponseId(undefined)
    setRestorationMessageIds([])
  }, [requestedResponseId, visible, rows, mountedRowKeys, virtualizer])

  useLayoutEffect(() => {
    commentFocusRef.current.visible = visible
    if (!visible) commentFocusRef.current.cancel?.()
  }, [visible])

  useLayoutEffect(() => {
    const textarea = commentTextareaRef.current
    if (
      !commentDraftId ||
      !commentFocusRef.current.visible ||
      !textarea ||
      document.activeElement === textarea
    )
      return undefined
    const origin = document.activeElement
    let active = true
    let frame: number | undefined
    const detach = (): void => {
      document.removeEventListener('focusin', cancel, true)
      window.removeEventListener('blur', cancel)
      if (commentFocusRef.current.cancel === cancel) delete commentFocusRef.current.cancel
    }
    const cancel = (): void => {
      active = false
      detach()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
    }
    commentFocusRef.current.cancel = cancel
    document.addEventListener('focusin', cancel, true)
    window.addEventListener('blur', cancel)
    frame = requestAnimationFrame(() => {
      if (!active) return
      active = false
      frame = undefined
      detach()
      if (
        commentTextareaRef.current !== textarea ||
        !commentFocusRef.current.visible ||
        !textarea.isConnected ||
        textarea.disabled ||
        textarea.readOnly ||
        document.activeElement !== origin ||
        textarea.closest('[inert], [hidden], [aria-hidden="true"]')
      )
        return
      for (let element: HTMLElement | null = textarea; element; element = element.parentElement) {
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return
      }
      textarea.focus()
      if (document.activeElement === textarea)
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
    return cancel
  }, [commentDraftId, planPanelExpanded])

  useEffect(() => {
    copyActiveRef.current = true
    return () => {
      copyActiveRef.current = false
      copyRequestGenerationRef.current += 1
      if (copyFeedbackTimerRef.current !== undefined) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const copyMessage = useCallback(async (messageId: string, content: string): Promise<void> => {
    const generation = ++copyRequestGenerationRef.current
    if (copyFeedbackTimerRef.current !== undefined) clearTimeout(copyFeedbackTimerRef.current)
    setCopyFeedback({ messageId, result: 'copying' })
    let result: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      result = 'failed'
    }
    if (!copyActiveRef.current || generation !== copyRequestGenerationRef.current) return
    setCopyFeedback({ messageId, result })
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = undefined
      setCopyFeedback(undefined)
    }, 2_000)
  }, [])

  const dismissCommentNavigation = (): void => {
    setDismissedNavigation(messageNavigation)
    clearProjectionHighlight()
  }

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      snapshot &&
      snapshot.messages.length + (history.window?.runContexts?.length ?? 0) >=
        CONVERSATION_WINDOW_MESSAGES &&
      hasProtectedSelection()
    ) {
      return
    }
    if (olderRequestedRef.current || history.loadingPage || !hasOlderHistory) return
    const transcript = transcriptRef.current
    const firstVisible = snapshot?.messages.find((message) => {
      const row = messageRefs.current.get(message.id)
      return (
        row &&
        transcript &&
        row.getBoundingClientRect().bottom > transcript.getBoundingClientRect().top &&
        row.getBoundingClientRect().top < transcript.getBoundingClientRect().bottom
      )
    })
    const element = firstVisible ? messageRefs.current.get(firstVisible.id) : undefined
    if (!firstVisible || !element) return
    olderRequestedRef.current = true
    scrollIntentRef.current = undefined
    historyReadDirectionRef.current = 'older'
    stickToBottomRef.current = false
    if (firstVisible && element) {
      prependAnchorRef.current = {
        messageId: firstVisible.id,
        top: element.getBoundingClientRect().top,
        beforeDisplay: conversationWindowStartOrder(history.window!)!,
      }
      setRestorationMessageIds([firstVisible.id])
    }
    try {
      await history.loadOlder()
    } finally {
      olderRequestedRef.current = false
    }
  }, [snapshot, history, hasProtectedSelection, hasOlderHistory])

  const loadLatest = async (): Promise<void> => {
    setRequestedResponseId(undefined)
    gapRestoreRef.current = undefined
    setRestorationPlan(undefined)
    setRestorationReport(undefined)
    cancelPrepend()
    setRestorationMessageIds([])
    dismissCommentNavigation()
    const currentSelection = window.getSelection()
    if (transcriptRef.current?.contains(currentSelection?.anchorNode ?? null))
      currentSelection?.removeAllRanges()
    setSelectionMessageIds([])
    protectReading(undefined)
    historyReadDirectionRef.current = 'latest'
    stickToBottomRef.current = true
    scrollIntentRef.current = undefined
    focusAfterPageRef.current = 'latest'
    await history.loadLatest()
  }

  const requestOlderAtTop = useCallback(
    (scrollTop: number): void => {
      if (
        visible &&
        !loading &&
        !history.pageError &&
        !history.loadingPage &&
        !gapRecoveryPending &&
        scrollTop < OLDER_HISTORY_SCROLL_THRESHOLD
      )
        void loadOlder()
    },
    [visible, loading, history.pageError, history.loadingPage, gapRecoveryPending, loadOlder],
  )
  useLayoutEffect(() => {
    const intent = scrollIntentRef.current
    const transcript = transcriptRef.current
    if (transcript && (intent === 'older' || (intent === 'drag' && lastScrollRef.current.backward)))
      requestOlderAtTop(transcript.scrollTop)
  }, [virtualRows, requestOlderAtTop])

  const editorValue = useMemo<ComposerDocument>(
    () => ({
      text: composer,
      skills: composerSkills,
      mention: composerMention,
      route: composerRoute,
      returnedInputOperationId: composerReturnedInputOperationId,
    }),
    [composer, composerSkills, composerMention, composerRoute, composerReturnedInputOperationId],
  )
  const pactCommandHint = (() => {
    if (isSideChat || !composerPrefix.pact || composerPrefix.error) return undefined
    const inTaskReviewHint =
      composerPrefix.pact === 'review' &&
      unfinishedTask &&
      !unfinishedTask.ending &&
      isCollaborationOpenMode(unfinishedTask) &&
      (unfinishedTask.kind === 'plan' || unfinishedTask.kind === 'build')
    if (inTaskReviewHint) {
      const explicit =
        composerPrefix.route?.type === 'agent'
          ? composerPrefix.route.agentId
          : composerRoute?.type === 'agent'
            ? composerRoute.agentId
            : undefined
      const taskRoles = resolveLegacyCompatibleTaskStageRoles(unfinishedTask)
      const taskPair: readonly [RuntimeAgentId, RuntimeAgentId] =
        unfinishedTask.owner !== unfinishedTask.reviewer
          ? [unfinishedTask.owner, unfinishedTask.reviewer]
          : [taskRoles.planAuthor, taskRoles.planReviewer]
      const fallbackReviewer = otherAgent(
        unfinishedTask.unreviewedCodeActor ??
          unfinishedTask.lastCodeActor ??
          collaborationActor(unfinishedTask, 'implement'),
        taskPair,
      )
      return `${agentName(explicit ?? fallbackReviewer)} reviews code.`
    }
    const { route } = resolveComposerRoute(editorValue, activePair[0], {
      secondaryAgentId: activePair[1],
    })
    if (route.type !== 'agent' || !activePair.includes(route.agentId)) return undefined
    const entryPrimary = pactSessionEntryPrimary(composerPrefix.pact, activePair, route.agentId)
    const roles = defaultTaskStageRoles(entryPrimary, otherAgent(entryPrimary, activePair))
    return composerPrefix.pact === 'plan'
      ? `${agentName(roles.planAuthor)} drafts plan · ${agentName(roles.planReviewer)} reviews plan.`
      : composerPrefix.pact === 'build'
        ? `${agentName(roles.codeAuthor)} implements.`
        : `${agentName(roles.codeReviewer)} reviews code.`
  })()

  const dismissMentionMenu = (): void => {
    dismissedMention.current = mentionQuery
    setMentionQuery(undefined)
  }
  const updateMentionQuery = (text: string, cursor: number): void => {
    const next = mentionQueryAt(text, cursor)
    const dismissed = dismissedMention.current
    if (
      next &&
      dismissed &&
      next.start === dismissed.start &&
      next.end === dismissed.end &&
      next.query === dismissed.query
    )
      return
    dismissedMention.current = undefined
    setMentionQuery(next)
  }
  const acceptComposerDocument = (
    document: ComposerDocument,
    cursor: number,
    composing: boolean,
  ): boolean => {
    if (onComposerDocumentChange) {
      if (onComposerDocumentChange(document) === false) return false
    } else {
      onComposerChange(document.text)
      onComposerSkillsChange(document.skills)
      onComposerMentionChange(document.mention)
    }
    if (composing) {
      skillComposer.close()
      setMentionQuery(undefined)
      return true
    }
    skillComposer.update(document.text, cursor, document.skills)
    updateMentionQuery(document.text, cursor)
    setActiveMentionIndex(0)
    return true
  }
  const cursorChanged = (cursor: number): void => {
    const current = composerRef.current?.document() ?? editorValue
    skillComposer.update(current.text, cursor, current.skills)
    updateMentionQuery(current.text, cursor)
    setActiveMentionIndex(0)
  }
  const documentAfterEdits = (edits: ComposerEdit[]): ComposerDocument | undefined => {
    let next = composerRef.current?.document() ?? editorValue
    const nextChars =
      next.text.length +
      edits.reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0)
    if (history.admitComposerEdit?.(nextChars) === false) return undefined
    for (const edit of edits.toSorted((a, b) => b.start - a.start))
      next = replaceComposerDocument(next, edit)
    return next
  }
  const updateComposer = (value: string, cursor: number, edits?: ComposerEdit[]): void => {
    try {
      const replacements = edits ?? [
        composerDifference((composerRef.current?.document() ?? editorValue).text, value),
      ]
      const next = documentAfterEdits(replacements)
      if (!next) return
      composerRef.current?.apply(next, { start: cursor, end: cursor }, replacements)
    } catch (editError) {
      composerRef.current?.refuseEdit(
        editError instanceof Error
          ? editError.message
          : 'Couldn’t apply that edit. Your draft was kept.',
      )
    }
  }
  const chooseSkill = (entry: ComposerSkillOption): void => {
    const skillReplacement = skillComposer.choose(entry)
    if (!skillReplacement) return
    const current = composerRef.current?.document() ?? editorValue
    if (
      history.admitComposerEdit?.(
        current.text.length -
          (skillReplacement.end - skillReplacement.start) +
          skillReplacement.text.length,
      ) === false
    )
      return
    try {
      const next = replaceComposerDocument(current, skillReplacement)
      if (skillReplacement.skill)
        next.skills = [...next.skills, skillReplacement.skill].toSorted((a, b) => a.start - b.start)
      const cursor = skillReplacement.start + skillReplacement.text.length
      composerRef.current?.focus()
      composerRef.current?.apply(next, { start: cursor, end: cursor }, [skillReplacement])
    } catch (editError) {
      composerRef.current?.refuseEdit(
        editError instanceof Error
          ? editError.message
          : 'Couldn’t apply that skill. Your draft was kept.',
      )
    }
  }

  const chooseMention = (option: MentionOption): void => {
    if (!mentionQuery) return
    const current = composerRef.current?.document() ?? editorValue
    const selectedMention = current.mention
    const overlaps =
      selectedMention &&
      mentionQuery.start < selectedMention.end &&
      mentionQuery.end > selectedMention.start
    const range = overlaps ? selectedMention : mentionQuery
    const remove = selectedMention && !overlaps ? selectedMention : undefined
    const start =
      range.start - (remove && remove.start < range.start ? remove.end - remove.start : 0)
    const suffix = current.text.slice(range.end)
    const needsSpace = suffix.length === 0 || !/^\s/u.test(suffix)
    const insertion = `${option.token}${needsSpace ? ' ' : ''}`
    const mention: ConversationComposerMention = {
      route: option.route,
      token: option.token,
      start,
      end: start + option.token.length,
    }
    const edits: ComposerEdit[] = [{ start: range.start, end: range.end, text: insertion }]
    if (remove) edits.push({ start: remove.start, end: remove.end, text: '' })
    try {
      const nextDocument = documentAfterEdits(edits)
      if (!nextDocument) return
      nextDocument.mention = mention
      nextDocument.route = option.route
      const cursor = start + insertion.length
      composerRef.current?.focus()
      composerRef.current?.apply(nextDocument, { start: cursor, end: cursor }, edits)
    } catch (editError) {
      composerRef.current?.refuseEdit(
        editError instanceof Error
          ? editError.message
          : 'Couldn’t insert that mention. Your draft was kept.',
      )
      return
    }
    setMentionQuery(undefined)
    setActiveMentionIndex(0)
  }

  const submitAnswers = async (): Promise<void> => {
    if (!decisionReply || questionDisabled || !decisionAnswersReady) return
    const submittedKey = decisionKey
    const sent = await onSend('', [], undefined, undefined, decisionReply)
    if (sent) setAnsweredDecisionKey(submittedKey)
    setPlanRefresh((value) => value + 1)
  }

  const submit = async (): Promise<void> => {
    if (inputTakeover) return
    const document = composerRef.current?.document() ?? editorValue
    const prefix = parseComposerCommandPrefix(document.text, document.skills)
    if (isSideChat && (prefix.pact || prefix.btw)) {
      onNotice('Pact commands (/plan, /build, /review, /btw) can only be used in the main chat.')
      return
    }
    const { route: effectiveRoute, sendRoute } = resolveComposerRoute(document, defaultRecipient, {
      allowMainRoute: isSideChat,
      secondaryAgentId: activePair[1],
    })
    if (!isSideChat && prefix.btw && !prefix.error) {
      if (btwSubmitting || commonComposerBlocked || !onOpenBtwSideChat) return
      if (decisionReply) {
        onNotice('Reply to the active questions before starting a /btw side chat.')
        return
      }
      if (
        composerReturnedInputOperationId ||
        returnedInput?.state === 'installed' ||
        queue?.returnedInput?.operationId ||
        composerUserInformation
      ) {
        onNotice('Send or clear the saved message before starting a /btw side chat.')
        return
      }
      if (composerImages.length > 0 || draftComments.length > 0) {
        onNotice('Remove attached images or draft comments before starting a /btw side chat.')
        return
      }
      const btwDraft = extractBtwSideChatDraft(document)
      if (!btwDraft) return
      const submittedRevision = composerRevision
      setBtwSubmitting(true)
      try {
        const opened = await onOpenBtwSideChat(btwDraft)
        if (opened) {
          if (onClearSubmittedDraft) onClearSubmittedDraft(submittedRevision)
          else if (onComposerDocumentChange) onComposerDocumentChange({ text: '', skills: [] })
          else onComposerChange('')
          skillComposer.close()
          setMentionQuery(undefined)
        }
      } finally {
        setBtwSubmitting(false)
      }
      return
    }
    if (isSideChat && effectiveRoute.type === 'main') {
      if (mainSyncComposerBlocked || !onSyncToMain) return
      const syncDraft = extractMainSyncDraft(document)
      const trimmedLead = syncDraft.text.length - syncDraft.text.trimStart().length
      const syncContent = syncDraft.text.trim()
      if (
        syncContent.length === 0 &&
        composerImages.length === 0 &&
        draftComments.length === 0 &&
        !history.draftPage?.hasMore &&
        !history.draftPage?.hasEarlier
      ) {
        onNotice('Write a message before sending to the main chat.')
        return
      }
      const shiftedSkills = syncDraft.skills.map((entry) =>
        Object.assign({}, entry, {
          start: entry.start - trimmedLead,
          end: entry.end - trimmedLead,
        }),
      )
      const syncValidation = validateSideChatMainSyncContent(syncContent, shiftedSkills)
      if (!syncValidation.ok) {
        onNotice(syncValidation.message)
        return
      }
      const receipt = await onSyncToMain(
        syncContent,
        draftComments.map((comment) => comment.id),
        shiftedSkills,
      )
      if (receipt) {
        setLastMainSync({ sideChatId: session.id, receipt })
        skillComposer.close()
        setMentionQuery(undefined)
      }
      return
    }
    if (responseInProgress && !queueEnabled && !unfinishedTask) return
    if (responseInProgress && queuedInput) {
      onNotice('One message is already queued. Edit or remove it before queuing another.')
      return
    }
    if (
      (!composerHasContent(document.text) &&
        draftComments.length === 0 &&
        composerImages.length === 0 &&
        !decisionAnswersReady) ||
      disabled
    )
      return
    stickToBottomRef.current = true
    cancelPrepend()
    scrollIntentRef.current = undefined
    const removed = document.text.length - document.text.trimStart().length
    if (unfinishedTask && sendRoute?.type === 'all') {
      onNotice('Choose one Agent for this feedback batch.')
      return
    }
    if (decisionReply && prefix.pact) {
      onNotice('Send your answers as a reply before starting another Pact command.')
      return
    }
    if (replacement) return
    const inTaskReview = Boolean(
      prefix.pact === 'review' &&
      unfinishedTask &&
      !unfinishedTask.ending &&
      isCollaborationOpenMode(unfinishedTask) &&
      (unfinishedTask.kind === 'plan' || unfinishedTask.kind === 'build'),
    )
    if (prefix.pact && unfinishedTask && !inTaskReview) {
      setReplacementFailed(false)
      setReplacement({
        sessionId: session.id,
        taskId: unfinishedTask.id,
        command: prefix.pact,
        draftToken: replacementDraftToken,
      })
      return
    }
    const submittedDecisionKey = decisionKey
    const targetRoute = sendRoute
    const sent = await onSend(
      document.text,
      draftComments.map((comment) => comment.id),
      targetRoute,
      document.skills.map((entry) =>
        Object.assign({}, entry, { start: entry.start - removed, end: entry.end - removed }),
      ),
    )
    if (sent) {
      setAnsweredDecisionKey(submittedDecisionKey)
      setPlanRefresh((value) => value + 1)
      skillComposer.close()
      setMentionQuery(undefined)
    } else if (decisionReply) setPlanRefresh((value) => value + 1)
  }

  const cancelReplacement = (): void => {
    replacementAttempt.current = undefined
    replacementRestoreFocus.current = true
    setReplacementFailed(false)
    setReplacement(undefined)
  }
  const confirmReplacement = async (): Promise<void> => {
    const task = replacementTask
    if (
      !replacement ||
      !task ||
      replacementBusy ||
      disabled ||
      inputTakeover ||
      queuedInput ||
      sending
    )
      return
    setReplacementBusy(true)
    setReplacementFailed(false)
    try {
      const document = composerRef.current?.document() ?? editorValue
      const prefix = parseComposerCommandPrefix(document.text, document.skills)
      if (prefix.pact !== replacement.command || replacement.draftToken !== replacementDraftToken) {
        cancelReplacement()
        return
      }
      replacementAttempt.current ??= { taskId: task.id, revision: task.revision }
      const removed = document.text.length - document.text.trimStart().length
      const { sendRoute } = resolveComposerRoute(document, defaultRecipient, {
        secondaryAgentId: activePair[1],
      })
      const sent = await onSend(
        document.text,
        draftComments.map((comment) => comment.id),
        sendRoute,
        document.skills.map((entry) =>
          Object.assign({}, entry, { start: entry.start - removed, end: entry.end - removed }),
        ),
        undefined,
        replacementAttempt.current,
      )
      if (sent) {
        replacementAttempt.current = undefined
        setReplacement(undefined)
        setPlanRefresh((value) => value + 1)
        skillComposer.close()
        setMentionQuery(undefined)
      } else {
        setReplacementFailed(true)
        setPlanRefresh((value) => value + 1)
      }
    } finally {
      setReplacementBusy(false)
    }
  }

  const returnQueueMessageToComposer = async (restore: boolean): Promise<boolean> => {
    const restored = await (restore
      ? queueActions?.restoreReturned()
      : queueActions?.returnToComposer())
    if (restored) {
      setCommentEditor(undefined)
      setMentionQuery(undefined)
      skillComposer.close()
      composerRef.current?.focus()
    }
    return Boolean(restored)
  }

  const createMessageComment = useCallback(
    async (selection: {
      messageId: string
      startOffset: number
      endOffset: number
      quote: string
    }): Promise<void> => {
      const { snapshot: current, messageMeta } = messageInteractionRef.current
      if (recoveryLocked) return
      const message = current?.messages.find((candidate) => candidate.id === selection.messageId)
      if (!message || messageMeta?.[message.id]?.oversized) return
      const contentHash = await sha256Hex(message.content)
      setCommentEditor({
        draftId: crypto.randomUUID(),
        anchor: {
          type: 'message',
          messageId: selection.messageId,
          contentHash,
          textBasis: MESSAGE_ANCHOR_TEXT_BASIS,
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
          quote: selection.quote,
        },
        quote: selection.quote,
        body: '',
      })
    },
    [recoveryLocked],
  )
  const handleCreateMessageComment = useCallback(
    (selection: Parameters<typeof createMessageComment>[0]): void => {
      void createMessageComment(selection)
    },
    [createMessageComment],
  )
  const handleCreatePlanComment = useCallback(
    (selection: PlanTextSelection | ReportTextSelection): void => {
      const ownerSessionId = session.id
      const current = messageInteractionRef.current
      if (recoveryLocked || current.snapshot?.session.id !== ownerSessionId) return
      void (
        selection.contentHash
          ? Promise.resolve(selection.contentHash)
          : sha256Hex(selection.content)
      ).then((contentHash) => {
        if (messageInteractionRef.current.snapshot?.session.id !== ownerSessionId) return undefined
        setCommentEditor({
          draftId: crypto.randomUUID(),
          anchor: {
            type: 'message',
            messageId: selection.messageId,
            ...('plan' in selection ? { plan: selection.plan } : { report: selection.report }),
            contentHash,
            textBasis: selection.textBasis ?? MESSAGE_ANCHOR_TEXT_BASIS,
            startOffset: selection.startOffset,
            endOffset: selection.endOffset,
            quote: selection.quote,
          },
          quote: selection.quote,
          body: '',
        })
        return undefined
      })
    },
    [session.id, recoveryLocked],
  )

  const handlePlanReady = useCallback(
    (host: HTMLElement, onApplied?: () => void): (() => void) | undefined => {
      if (!visible || gapRecoveryPending || historyLoading || loading) return undefined
      const reveal = (): boolean => {
        const restore = gapRestoreRef.current
        const content = host.querySelector<HTMLElement>('[data-pact-message-content]')
        if (!content?.isConnected) return false
        const matches = (source: {
          plan?: MessageCommentAnchor['plan']
          report?: MessageCommentAnchor['report']
        }): boolean => {
          if (source.plan) return source.plan.runId === host.dataset.pactPlanRunId
          if (source.report) {
            const actual = reportSelectionSource(host)
            return actual?.runId === source.report.runId
          }
          return false
        }
        if (restore?.selection && matches(restore.selection)) {
          const transcript = transcriptRef.current
          const row =
            restore.plan || restore.report
              ? host.closest<HTMLElement>('.pact-review-card')
              : messageRefs.current.get(restore.messageId)
          if (
            !transcript ||
            !row ||
            !isViewportCommitted(transcript) ||
            Math.abs(row.getBoundingClientRect().top - restore.top) > 2
          )
            return false
          if (
            !focusProjectionRange(
              content,
              restore.selection.startOffset,
              restore.selection.endOffset,
              { scroll: false, highlight: restore.selection.highlight ?? false },
            )
          )
            return false
          gapRestoreRef.current = undefined
          setRestorationMessageIds([])
          setRestorationPlan(undefined)
          setRestorationReport(undefined)
          return true
        }
        if (
          (!messageNavigation?.plan && !messageNavigation?.report) ||
          dismissedNavigation === messageNavigation ||
          appliedNavigationRef.current === messageNavigation
        )
          return true
        if (
          !matches(messageNavigation) ||
          history.window?.sourceMessageId !== messageNavigation.messageId ||
          hasProtectedSelection()
        )
          return false
        if (
          !focusProjectionRange(
            content,
            messageNavigation.startOffset,
            messageNavigation.endOffset,
            { scroll: false },
          )
        )
          return false
        const transcript = transcriptRef.current
        const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
        if (transcript && range)
          virtualizer.scrollToOffset(
            transcript.scrollTop +
              range.top -
              transcript.getBoundingClientRect().top -
              transcript.clientHeight / 2 +
              range.height / 2,
            { behavior: 'smooth' },
          )
        appliedNavigationRef.current = messageNavigation
        return true
      }
      const frame = requestAnimationFrame(() => {
        if (reveal()) onApplied?.()
      })
      return () => {
        cancelAnimationFrame(frame)
      }
    },
    [
      visible,
      gapRecoveryPending,
      historyLoading,
      loading,
      messageNavigation,
      dismissedNavigation,
      history.window?.sourceMessageId,
      hasProtectedSelection,
      isViewportCommitted,
      virtualizer,
    ],
  )

  const revealReport =
    messageNavigation && dismissedNavigation !== messageNavigation
      ? messageNavigation.report
      : restorationReport
  const revealReportRequestId =
    messageNavigation && dismissedNavigation !== messageNavigation
      ? messageNavigation.navigationId
      : `restore:${gapRecoveryPending ?? ''}:${gapRestoreRef.current?.messageId ?? ''}`
  const [planSourcePreview, setPlanSourcePreview] = useState<{
    key: string
    taskId?: string | undefined
    plan?: CurrentPlanDocument | undefined
    error?: string | undefined
  }>()
  const planSourceRead = useRef<{
    active: boolean
    pending: boolean
    desired?: { key: string; sessionId: string; runId: string; version: number } | undefined
  }>({ active: true, pending: false })
  const planSourceKey = planSourceNavigation?.plan
    ? `${session.id}:${planSourceNavigation.navigationId ?? ''}:${planSourceNavigation.plan.runId}:${planSourceNavigation.plan.version}:${planSourceNavigation.startOffset}:${planSourceNavigation.endOffset}:${planSourceNavigation.textBasis ?? ''}:${planRefresh}`
    : undefined

  useEffect(() => {
    const owner = planSourceRead.current
    owner.active = true
    return () => {
      owner.active = false
      owner.desired = undefined
    }
  }, [])

  useEffect(() => {
    const owner = planSourceRead.current
    const anchor = planSourceNavigationRef.current?.plan
    owner.desired =
      visible && planSourceKey && anchor
        ? {
            key: planSourceKey,
            sessionId: session.id,
            runId: anchor.runId,
            version: anchor.version,
          }
        : undefined
    if (owner.desired) openPlanCallback.current?.()
    const read = async (): Promise<void> => {
      if (!owner.active || owner.pending || !owner.desired) return
      owner.pending = true
      const requested = owner.desired
      try {
        const result = await window.pact.getConversation({
          scope: 'collaboration',
          projection: 'plan',
          sessionId: requested.sessionId,
          runId: requested.runId,
        })
        if (!owner.active || owner.desired !== requested) return
        const view =
          result.ok && result.value.scope === 'collaboration' ? result.value.view : undefined
        const source = view?.planSource
        const task = view?.task
        if (
          !task?.planReference ||
          task.planVersion !== requested.version ||
          source?.runId !== requested.runId
        ) {
          setPlanSourcePreview({ key: requested.key, error: 'This plan source is unavailable.' })
          return
        }
        setPlanSourcePreview({
          key: requested.key,
          taskId: task.id,
          plan: {
            runId: requested.runId,
            messageId: source.messageId,
            version: requested.version,
            author:
              task.planReference.author ?? task.planAuthor ?? collaborationActor(task, 'plan'),
            content: '',
            document: task.planReference.document,
            sessionId: requested.sessionId,
            aroundOffset: planSourceNavigationRef.current?.startOffset,
            endOffset: planSourceNavigationRef.current?.endOffset,
            navigationId: planSourceNavigationRef.current?.navigationId,
            basis:
              planSourceNavigationRef.current?.textBasis === 'plain-visible-v1'
                ? 'plain-visible-v1'
                : undefined,
            status: 'Original version',
          },
        })
        planAvailableCallback.current?.(requested.sessionId, task.id)
        openPlanCallback.current?.()
      } catch {
        if (owner.active && owner.desired === requested)
          setPlanSourcePreview({ key: requested.key, error: 'This plan source is unavailable.' })
      } finally {
        owner.pending = false
        if (owner.active && owner.desired && owner.desired !== requested) void read()
      }
    }
    void read()
  }, [session.id, planSourceKey, visible])

  const handlePanelPlanReady = useCallback(
    (host: HTMLElement): (() => void) | undefined => {
      if (
        !visible ||
        !planSourceNavigation?.plan ||
        planSourceNavigation.endOffset <= planSourceNavigation.startOffset ||
        appliedNavigationRef.current === planSourceNavigation
      )
        return undefined
      if (
        host.dataset.pactPlanRunId !== planSourceNavigation.plan.runId ||
        Number(host.dataset.pactPlanVersion) !== planSourceNavigation.plan.version
      )
        return undefined
      const frame = requestAnimationFrame(() => {
        const content = host.querySelector<HTMLElement>('[data-pact-message-content]')
        if (
          content?.isConnected &&
          focusProjectionRange(
            content,
            planSourceNavigation.startOffset,
            planSourceNavigation.endOffset,
          )
        )
          appliedNavigationRef.current = planSourceNavigation
      })
      return () => cancelAnimationFrame(frame)
    },
    [visible, planSourceNavigation],
  )

  const beginDetailRead = useCallback((): void => {
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
  }, [])

  const viewSavedResponse = useCallback(
    (messageId: string): void => {
      cancelPrepend()
      stickToBottomRef.current = false
      scrollIntentRef.current = undefined
      setRequestedResponseId(messageId)
      setRestorationMessageIds([messageId])
      void history.ensureMessage(messageId)
    },
    [cancelPrepend, history],
  )

  const requestForkForMessage = useCallback(
    (messageId: string): void => {
      setForkPoint({
        sourceSessionId: session.id,
        messageId,
        opening: onForkSessionStarted?.(),
      })
    },
    [onForkSessionStarted, session.id],
  )

  const refreshTaskPlan = useCallback((): void => {
    setPlanRefresh((value) => value + 1)
  }, [])

  const saveComment = async (): Promise<void> => {
    if (!commentEditor?.body.trim() || disabled || savingComment) return
    const submitted =
      pendingCommentSave.current?.draftId === commentEditor.draftId
        ? pendingCommentSave.current
        : commentEditor
    pendingCommentSave.current = submitted
    const requestedSessionId = session.id
    setSavingComment(true)
    try {
      const saveInput = submitted.commentId
        ? {
            mode: 'edit' as const,
            requestId: submitted.draftId,
            sessionId: session.id,
            commentId: submitted.commentId,
            body: submitted.body,
          }
        : submitted.anchor.type === 'unavailable' || submitted.anchor.type === 'cutoff_message'
          ? undefined
          : {
              mode: 'create' as const,
              requestId: submitted.draftId,
              sessionId: session.id,
              commentId: submitted.draftId,
              body: submitted.body,
              anchor: submitted.anchor,
            }
      if (!saveInput) return
      const saved = await onSaveCommentDraft(saveInput)
      if (
        typeof saved === 'object' &&
        requestedSessionId === messageInteractionRef.current.snapshot?.session.id
      ) {
        pendingCommentSave.current = undefined
        setCommentEditor((current) =>
          current?.draftId === submitted.draftId
            ? { ...current, draftId: crypto.randomUUID() }
            : current,
        )
      } else if (
        commentDraftSaveSucceeded(saved) &&
        requestedSessionId === messageInteractionRef.current.snapshot?.session.id
      ) {
        pendingCommentSave.current = undefined
        setCommentEditor((current) =>
          current?.draftId === submitted.draftId
            ? current.body === submitted.body
              ? undefined
              : {
                  ...current,
                  draftId: crypto.randomUUID(),
                  commentId:
                    typeof saved === 'string' ? saved : (submitted.commentId ?? submitted.draftId),
                }
            : current,
        )
      }
    } finally {
      setSavingComment(false)
    }
  }

  const handleInputHeightDelta = useCallback(
    (delta: number): void => {
      if (!visible || !stickToBottomRef.current || hasProtectedSelection()) return
      const selection = window.getSelection()
      if (
        selection &&
        !selection.isCollapsed &&
        transcriptRef.current?.contains(selection.anchorNode) &&
        !isProjectionHighlightOwned()
      ) {
        return
      }
      const transcript = transcriptRef.current
      if (!transcript || !Number.isFinite(delta) || Math.abs(delta) <= 0.5) return
      scrollIntentRef.current = undefined
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight)
    },
    [hasProtectedSelection, visible],
  )

  const renderWorkspaceChanges = useCallback(
    (changeSet: WorkspaceChangeSet): React.JSX.Element => {
      const cached = workspaceFilesById.get(changeSet.id)
      const list =
        cached && (cached.revision ?? 0) === (changeSet.revision ?? 0) ? cached : undefined
      const activeFilePathForCard = activeWorkspaceDiff
        ? activeWorkspaceDiff.sessionId === session.id &&
          activeWorkspaceDiff.changeSetId === changeSet.id
          ? activeWorkspaceDiff.path
          : undefined
        : activeWorkspaceFilePath
      return (
        <WorkspaceChangesCard
          changeSet={changeSet}
          list={list}
          undoing={undoingChangeSetId === changeSet.id}
          disabled={Boolean(activeRun || undoingChangeSetId || undoingFile)}
          activeFilePath={activeFilePathForCard}
          undoingPath={undoingFile?.changeSetId === changeSet.id ? undoingFile.path : undefined}
          onUndo={undoWorkspaceChanges}
          onUndoFile={onUndoWorkspaceFile ? handleUndoWorkspaceFile : undefined}
          onView={(id) => void loadWorkspaceFiles(id, false, true, onPrepareWorkspaceChanges())}
          onShowFiles={(id) => void loadWorkspaceFiles(id, true)}
          onOpenFile={(id, path) => onOpenWorkspaceChanges(id, path, undefined, changeSet.revision)}
        />
      )
    },
    [
      workspaceFilesById,
      undoingChangeSetId,
      undoingFile,
      activeRun,
      activeWorkspaceDiff,
      activeWorkspaceFilePath,
      session.id,
      undoWorkspaceChanges,
      onUndoWorkspaceFile,
      handleUndoWorkspaceFile,
      loadWorkspaceFiles,
      onPrepareWorkspaceChanges,
      onOpenWorkspaceChanges,
    ],
  )

  const commentEditorView = commentEditor ? (
    <CommentEditorCard
      editor={commentEditor}
      session={session}
      textareaRef={commentTextareaRef}
      recoveryLocked={recoveryLocked}
      disabled={disabled}
      saving={savingComment}
      onChange={setCommentEditor}
      onSave={saveComment}
      onClose={() => setCommentEditor(undefined)}
    />
  ) : null

  const commentDraftsView = (
    <CommentDraftChips
      draftComments={draftComments}
      session={session}
      history={history}
      recoveryLocked={recoveryLocked}
      disabled={disabled}
      onEditComment={(comment) =>
        setCommentEditor({
          commentId: comment.id,
          draftId: crypto.randomUUID(),
          anchor: comment.anchor,
          quote: comment.anchor.quote,
          body: comment.body,
        })
      }
      onOpenComment={onOpenComment}
      onRemoveCommentDraft={onRemoveCommentDraft}
    />
  )

  const sourcePreview =
    planSourceKey && planSourcePreview?.key === planSourceKey ? planSourcePreview : undefined
  const latestPlanVersion =
    sourcePreview?.plan &&
    planningTask?.planReference &&
    currentPlan?.source &&
    planningTask.id === sourcePreview.taskId &&
    planningTask.planVersion > sourcePreview.plan.version
      ? planningTask.planVersion
      : undefined
  const showCurrentPlan = (): void => {
    if (planSourceNavigation) {
      planSourceRead.current.desired = undefined
      setPlanSourcePreview(undefined)
      setCardPlanNavigation(undefined)
      setDismissedNavigation(messageNavigation)
      planAvailableCallback.current?.(
        session.id,
        planningTask?.planReference && currentPlan?.source ? planningTask.id : undefined,
      )
    }
    onOpenPlan?.()
  }
  const showCurrentPlanRef = useRef(showCurrentPlan)
  useLayoutEffect(() => {
    showCurrentPlanRef.current = showCurrentPlan
  })
  useEffect(() => {
    if (!onRegisterShowCurrentPlan) return undefined
    onRegisterShowCurrentPlan(() => showCurrentPlanRef.current())
    return () => onRegisterShowCurrentPlan(undefined)
  }, [onRegisterShowCurrentPlan])

  return (
    <main className="@container/conversation flex h-full min-h-0 flex-col">
      {planPanelHost
        ? createPortal(
            <CurrentPlanPanel
              expanded={planPanelExpanded}
              onExpandedChange={onPlanPanelExpandedChange}
              comments={
                planPanelExpanded &&
                (commentEditor ||
                  draftComments.length ||
                  history.draftPage?.hasMore ||
                  history.draftPage?.hasEarlier) ? (
                  <div className="flex flex-col gap-group">
                    {commentEditorView}
                    {commentDraftsView}
                    {error ? (
                      <p role="alert" className="text-caption text-danger">
                        {error}
                      </p>
                    ) : null}
                  </div>
                ) : undefined
              }
              plan={
                planSourceKey
                  ? planSourcePreview?.key === planSourceKey
                    ? planSourcePreview.plan
                    : undefined
                  : planningTask?.planReference && currentPlan?.source
                    ? {
                        taskId: planningTask.id,
                        runId: currentPlan.source.runId,
                        messageId: currentPlan.source.messageId,
                        version: planningTask.planVersion,
                        author:
                          planningTask.planReference.author ??
                          planningTask.planAuthor ??
                          collaborationActor(planningTask, 'plan'),
                        content: '',
                        document: planningTask.planReference.document,
                        sessionId: session.id,
                        status: resolvePlanStatusLabel(planningTask, currentPlan.planSync),
                      }
                    : undefined
              }
              source={Boolean(planSourceKey)}
              latestVersion={latestPlanVersion}
              onOpenLatest={showCurrentPlan}
              onPlanReady={handlePanelPlanReady}
              onRevealApplied={(id) => {
                const navigation = planSourceNavigationRef.current
                if (navigation?.navigationId === id && navigation.plan)
                  appliedNavigationRef.current = navigation
              }}
              loading={
                planSourceKey
                  ? planSourcePreview?.key !== planSourceKey
                  : !currentPlan || currentPlan.sessionId !== session.id
              }
              error={
                planSourceKey
                  ? planSourcePreview?.key === planSourceKey
                    ? planSourcePreview.error
                    : undefined
                  : currentPlan?.sessionId === session.id
                    ? currentPlan.error
                    : undefined
              }
              onClose={() => {
                if (planSourceNavigation) {
                  planSourceRead.current.desired = undefined
                  setPlanSourcePreview(undefined)
                  setCardPlanNavigation(undefined)
                  setDismissedNavigation(messageNavigation)
                }
                onClosePlan?.()
              }}
              onRetry={() => setPlanRefresh((value) => value + 1)}
              onOpenProjectFile={openProjectFile}
              onCreatePlanComment={
                recoveryLocked || inputTakeover ? undefined : handleCreatePlanComment
              }
            />,
            planPanelHost,
          )
        : null}

      {planAvailable && showPlanHeaderButton ? (
        <div className="flex shrink-0 justify-end px-section pt-2">
          <button
            ref={planRestoreFocusRef}
            type="button"
            onClick={showCurrentPlan}
            className="pact-pressable inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            <BookOpen aria-hidden="true" className="size-4" strokeWidth={1.75} /> Plan
          </button>
        </div>
      ) : null}

      {isSideChat && session.sideChatOrigin === 'btw' && session.sideChatHasContext ? (
        <div
          key={`origin:${session.id}`}
          className="pact-side-chat-origin-enter shrink-0 px-section pt-2.5"
        >
          <div
            className={`mx-auto flex ${CONVERSATION_WIDTH} items-center gap-1.5 text-caption text-tertiary`}
          >
            <Info aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span>Context from main chat</span>
          </div>
        </div>
      ) : null}

      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The focusable Transcript region uses native wheel and keyboard scrolling. */}
      <section
        ref={transcriptRef}
        data-pact-transcript
        data-pact-transcript-scroll
        // Keyboard focus lets PageUp/PageDown/Home/End operate the scroll region.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Conversation messages"
        className="min-h-0 flex-1 overflow-auto px-section pt-5 pb-8 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        style={{ overflowAnchor: 'none' }}
        onFocusCapture={(event) => {
          const row = event.target.closest<HTMLElement>('[data-pact-row-key]')
          setFocusedRowKey(row?.dataset.pactRowKey)
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRowKey(undefined)
        }}
        onPointerDown={(event) => {
          cancelPrepend()
          scrollIntentRef.current =
            event.target === event.currentTarget || event.pointerType === 'touch'
              ? 'drag'
              : undefined
        }}
        onWheel={(event) => {
          cancelPrepend()
          scrollIntentRef.current = event.deltaY < 0 ? 'older' : 'newer'
          if (scrollIntentRef.current === 'older') {
            stickToBottomRef.current = false
            requestOlderAtTop(event.currentTarget.scrollTop)
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          cancelPrepend()
          scrollIntentRef.current =
            event.key === 'Home'
              ? 'start'
              : ['PageUp', 'ArrowUp'].includes(event.key)
                ? 'older'
                : ['End', 'PageDown', 'ArrowDown'].includes(event.key)
                  ? 'newer'
                  : undefined
          if (scrollIntentRef.current === 'older' || scrollIntentRef.current === 'start') {
            stickToBottomRef.current = false
            requestOlderAtTop(event.currentTarget.scrollTop)
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget
          const scrollingUp = element.scrollTop < lastScrollRef.current.top
          lastScrollRef.current = { top: element.scrollTop, backward: scrollingUp }
          clearOffscreenOrdinarySelection()
          const intent = scrollIntentRef.current
          if (intent === 'older' || intent === 'start' || (intent === 'drag' && scrollingUp))
            stickToBottomRef.current = false
          else if (intent === 'newer' || intent === 'drag')
            stickToBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 36
          if (stickToBottomRef.current && !hasProtectedSelection()) {
            protectReading(undefined)
            collapseCompletedOutput()
          }
          if ((intent === 'older' || intent === 'start' || intent === 'drag') && scrollingUp)
            requestOlderAtTop(element.scrollTop)
        }}
      >
        <div
          ref={transcriptContentRef}
          className={`mx-auto flex min-h-full ${CONVERSATION_WIDTH} flex-col`}
        >
          <output className="sr-only" aria-live="polite">
            {history.loadingPage
              ? 'Loading messages…'
              : hasOlderHistory
                ? 'Scroll up for earlier messages.'
                : 'Beginning of conversation.'}
          </output>
          {history.pageError && !hasNewerHistory ? (
            <div
              className="mb-group flex items-center justify-center gap-2 text-caption text-danger"
              role="alert"
            >
              <span>{history.pageError}</span>
              <button
                className="cursor-pointer font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                type="button"
                onClick={() => {
                  if (!history.gapRecoveryPending) {
                    if (historyReadDirectionRef.current === 'latest') void loadLatest()
                    else void loadOlder()
                    return
                  }
                  const retry = gapRetryRef.current
                  if (retry.mode === 'around') void history.recoverFromGap(retry.messageId)
                  else void loadLatestForGap()
                }}
              >
                Retry
              </button>
            </div>
          ) : null}

          {loading && !snapshot ? (
            <div className="space-y-group" aria-busy="true">
              <div className="h-20 animate-pulse rounded-2xl bg-surface-muted" />
              <div className="ml-auto h-16 w-3/4 animate-pulse rounded-2xl bg-surface-muted" />
            </div>
          ) : rows.length ? (
            <ol
              ref={messageListRef}
              data-pact-virtual-transcript
              aria-busy={history.loadingPage}
              data-pact-resident-message-count={
                (snapshot?.messages.length ?? 0) + (history.window?.runContexts?.length ?? 0)
              }
              data-pact-oldest-sequence={
                history.window ? conversationWindowStartOrder(history.window)?.sequence : undefined
              }
            >
              {virtualRows.map((virtualRow, position) => {
                const row = rows[virtualRow.index]!
                const previousEnd = position === 0 ? listOffset : virtualRows[position - 1]!.end
                return (
                  <Fragment key={virtualRow.key}>
                    <li
                      aria-hidden="true"
                      style={{ height: Math.max(0, virtualRow.start - previousEnd) }}
                    />
                    <li
                      ref={measureRow}
                      data-index={virtualRow.index}
                      data-pact-row-key={virtualRow.key}
                      aria-posinset={virtualRow.index + 1}
                      aria-setsize={-1}
                      className="pb-5"
                    >
                      <EditorialMessageItem
                        row={row}
                        rows={rows}
                        session={session}
                        snapshot={snapshot}
                        history={history}
                        isSideChat={isSideChat}
                        activeRun={activeRun}
                        latestRun={latestRun}
                        runsById={runsById}
                        activitiesByRun={activitiesByRun}
                        activityOwnerMessageByRun={activityOwnerMessageByRun}
                        pendingRoutedMessage={pendingRoutedMessage}
                        pendingRoutedAgentId={pendingRoutedAgentId}
                        recoveryLocked={recoveryLocked}
                        inputTakeover={inputTakeover}
                        disabled={disabled}
                        responseInProgress={responseInProgress}
                        continuationBlocked={continuationBlocked}
                        feedbackDraft={feedbackDraft}
                        nativePresentationSuspended={nativePresentationSuspended}
                        visible={visible}
                        loading={loading}
                        sending={sending}
                        stopping={stopping}
                        hasNativeQuestions={nativeQuestions.length > 0}
                        hasRelayDecision={Boolean(currentRelayDecision)}
                        canFork={Boolean(onForkSessionCreated)}
                        copyFeedback={copyFeedback}
                        revealReport={revealReport}
                        revealReportRequestId={revealReportRequestId}
                        revealReportBasis={
                          messageNavigation?.textBasis === 'plain-visible-v1'
                            ? 'plain-visible-v1'
                            : undefined
                        }
                        revealReportOffset={
                          gapRestoreRef.current?.selection?.startOffset ??
                          messageNavigation?.startOffset
                        }
                        onRegisterMessageElement={registerMessageElement}
                        onBeginDetailRead={beginDetailRead}
                        onCopyMessage={copyMessage}
                        onRequestFork={requestForkForMessage}
                        onOpenProjectFile={openProjectFile}
                        onCreateMessageComment={handleCreateMessageComment}
                        onCreatePlanComment={handleCreatePlanComment}
                        onAskInSideChat={onAskInSideChat}
                        onOpenSideChat={onOpenSideChat}
                        resolveSideChatTitle={resolveSideChatTitle}
                        onOpenComment={onOpenComment}
                        onOpenGallery={openMessageGallery}
                        onOpenRecordedPlan={openRecordedPlan}
                        onOpenSessionSettings={onOpenSessionSettings}
                        onTaskChange={refreshTaskPlan}
                        onReportReady={handlePlanReady}
                        onAcceptPeerProposal={onAcceptPeerProposal}
                        onDismissPeerProposal={onDismissPeerProposal}
                        onViewSavedResponse={viewSavedResponse}
                        renderWorkspaceChanges={renderWorkspaceChanges}
                      />
                    </li>
                  </Fragment>
                )
              })}
              <li
                aria-hidden="true"
                style={{
                  height: Math.max(
                    0,
                    virtualizer.getTotalSize() -
                      ((virtualRows.at(-1)?.end ?? listOffset) - listOffset),
                  ),
                }}
              />
            </ol>
          ) : (
            <div className="my-auto py-spacious text-center">
              <MessageSquareText
                aria-hidden="true"
                className="mx-auto size-9 text-tertiary"
                strokeWidth={1.5}
              />
              <h2 className="mt-section text-subtitle font-medium text-primary">
                {isSideChat
                  ? sideChatSettingsState === 'loading'
                    ? 'Loading side chat settings…'
                    : sideChatSettingsState === 'error'
                      ? 'Ask in this side chat'
                      : `Ask ${primaryName}`
                  : `Start with ${primaryName}`}
              </h2>
              <p className="mx-auto mt-1 max-w-[46ch] text-caption leading-relaxed text-secondary">
                {isSideChat
                  ? 'Ask about the main chat, or type @Main to send a takeaway back.'
                  : 'Ask a question, describe a change, or type @ to mention an agent.'}
              </p>
            </div>
          )}

          {snapshot?.forkOperation && !snapshot.forkOperation.ready ? (
            <NativeForkRecovery operation={snapshot.forkOperation} />
          ) : null}
          {nativeRequests
            .filter(({ request }) => !request.kind || request.kind === 'approval')
            .map(({ agentId, request }) => (
              <NativePermissionCard
                key={request.id}
                request={request}
                operationId={request.operationId!}
                agentId={agentId}
                onRespond={onRespondNativePermission}
              />
            ))}

          {hasNewerHistory ? (
            <div className="mx-auto mt-group">
              <button
                className="pact-pressable min-h-8 cursor-pointer rounded-xl border border-border bg-surface-raised px-3 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                type="button"
                disabled={history.loadingPage}
                onClick={() => void loadLatest()}
              >
                {history.loadingPage ? 'Loading latest messages…' : 'Jump to latest'}
              </button>
            </div>
          ) : null}
          {hasNewerHistory && history.pageError ? (
            <div
              className="mt-1 flex items-center justify-center gap-2 text-caption text-danger"
              role="alert"
            >
              <span>{history.pageError}</span>
              <button
                className="cursor-pointer font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                type="button"
                onClick={() => void loadLatest()}
              >
                Retry
              </button>
            </div>
          ) : null}

          {history.readError ? (
            <p className="mt-group flex items-center gap-2 text-caption text-danger" role="alert">
              <span>{history.readError}</span>
              <button
                className="min-h-8 cursor-pointer font-medium hover:underline disabled:opacity-50"
                type="button"
                aria-label="Retry loading messages"
                disabled={loading}
                onClick={history.retryRead}
              >
                Retry
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="mt-group text-caption text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <ComposerIsland
        session={session}
        snapshot={snapshot}
        history={history}
        visible={visible}
        isSideChat={isSideChat}
        platform={platform}
        planPanelExpanded={planPanelExpanded}
        nativePresentationSuspended={nativePresentationSuspended}
        schedulingState={schedulingState}
        visibleSessionIssues={visibleSessionIssues}
        queuedBackgroundAgent={queuedBackgroundAgent}
        stoppingBackgroundAgent={stoppingBackgroundAgent}
        stoppingBackgroundInQueue={stoppingBackgroundInQueue}
        waitingBackgroundIssue={waitingBackgroundIssue}
        activeRun={activeRun}
        latestRun={latestRun}
        runsById={runsById}
        activePair={activePair}
        primaryName={primaryName}
        secondaryName={secondaryName}
        respondingAgentId={respondingAgentId}
        responseInProgress={responseInProgress}
        continuationBlocked={continuationBlocked}
        agentActionsEnabled={agentActionsEnabled}
        effectiveMainSyncEnabled={effectiveMainSyncEnabled}
        sideChatSettingsState={sideChatSettingsState}
        composerDisabled={composerDisabled}
        disabled={disabled}
        commonComposerBlocked={commonComposerBlocked}
        mainSyncComposerBlocked={mainSyncComposerBlocked}
        recoveryLocked={recoveryLocked}
        sending={sending}
        stopping={stopping}
        showStop={showStop}
        stopLabel={stopLabel}
        showSend={showSend}
        hasDraft={hasDraft}
        isBtwReady={isBtwReady}
        btwSubmitting={btwSubmitting}
        isMainRoute={isMainRoute}
        hasUnfinishedTask={Boolean(unfinishedTask)}
        hasReplacement={Boolean(replacement)}
        queueEnabled={queueEnabled}
        canSteerQueuedInput={canSteerQueuedInput}
        steerUnavailableReason={steerUnavailableReason}
        inputTakeover={inputTakeover}
        decisionTakeover={decisionTakeover}
        decisionSource={decisionSource}
        decisionKey={decisionKey}
        decisionMessageId={decisionMessageId}
        decisionReply={decisionReply}
        decisionAnswersReady={decisionAnswersReady}
        inputGateState={inputGateState}
        incompleteCanAnswer={incompleteCanAnswer}
        questionDisabled={questionDisabled}
        planRecovery={planRecovery}
        nativeRequests={nativeRequests}
        nativeQuestions={nativeQuestions}
        nativeInputDrafts={nativeInputDrafts}
        currentRelayDecision={currentRelayDecision}
        composer={composer}
        composerImages={composerImages}
        choosingImages={choosingImages}
        composerMention={composerMention}
        composerReturnedInputOperationId={composerReturnedInputOperationId}
        editorValue={editorValue}
        pactCommandHint={pactCommandHint}
        handoffArriveKey={handoffArriveKey}
        lastMainSync={lastMainSync}
        draftComments={draftComments}
        commentEditorView={commentEditorView}
        commentDraftsView={commentDraftsView}
        skillComposer={skillComposer}
        skillMenuOpen={skillMenuOpen}
        activeSkillId={activeSkillId}
        mentionQuery={mentionQuery}
        filteredMentionOptions={filteredMentionOptions}
        mentionListOpen={mentionListOpen}
        mentionListId={mentionListId}
        activeMentionIndex={activeMentionIndex}
        activeMentionId={activeMentionId}
        sessionSettingsSaving={sessionSettingsSaving}
        queueDockRef={queueDockRef}
        composerRef={composerRef}
        onOpenRelaySettings={onOpenRelaySettings}
        onRebuildNativeContext={onRebuildNativeContext}
        onCheckNativeContext={onCheckNativeContext}
        onReturnQueueMessageToComposer={returnQueueMessageToComposer}
        onRespondNativeInput={onRespondNativeInput}
        onNativeInputDraftChange={onNativeInputDraftChange}
        onSubmitAnswers={submitAnswers}
        onRequestStop={requestStop}
        onOpenProjectFile={openProjectFile}
        onOpenSkillDocument={onOpenSkillDocument}
        onNotice={onNotice}
        onAddComposerImages={onAddComposerImages}
        onChooseComposerImages={onChooseComposerImages}
        onRemoveComposerImage={onRemoveComposerImage}
        onOpenImageGallery={openImageGallery}
        onAcceptComposerDocument={acceptComposerDocument}
        onCursorChanged={cursorChanged}
        onUpdateComposer={updateComposer}
        onChooseSkill={chooseSkill}
        onChooseMention={chooseMention}
        onDismissMentionMenu={dismissMentionMenu}
        onClearMentionQuery={() => setMentionQuery(undefined)}
        onActiveMentionIndexChange={setActiveMentionIndex}
        onSubmit={submit}
        onOpenBtwSideChat={onOpenBtwSideChat}
        onSyncToMain={onSyncToMain}
        onViewMainMessage={onViewMainMessage}
        onDismissMainSync={() => setLastMainSync(undefined)}
        onSaveSessionPermission={onSaveSessionPermission}
        onSaveSessionSpeed={onSaveSessionSpeed}
        onInputHeightDelta={handleInputHeightDelta}
      />

      {replacement && replacementTask ? (
        <TaskReplacementConfirmation
          task={replacementTask}
          command={replacement.command}
          running={responseInProgress}
          actor={respondingAgentId ?? collaborationActor(replacementTask, replacementTask.stage)}
          summary={replacementDetails?.summary}
          unreviewedChanges={replacementDetails?.unreviewedChanges ?? false}
          busy={replacementBusy}
          disabled={disabled || inputTakeover || Boolean(queuedInput) || sending}
          suspended={nativePresentationSuspended || inputTakeover || !visible}
          error={
            replacementFailed
              ? error || 'The new task could not be started. Your draft is preserved.'
              : undefined
          }
          onCancel={cancelReplacement}
          onConfirm={() => void confirmReplacement()}
        />
      ) : null}

      {forkPoint?.sourceSessionId === session.id && onForkSessionCreated ? (
        <SessionForkDialog
          key={`${forkPoint.sourceSessionId}:${forkPoint.messageId}`}
          sourceSessionId={forkPoint.sourceSessionId}
          messageId={forkPoint.messageId}
          onClose={() => setForkPoint(undefined)}
          onCreated={(change, enter) =>
            forkPoint.opening
              ? onForkSessionCreated(change, enter, forkPoint.opening)
              : onForkSessionCreated(change, enter)
          }
          suspended={nativePresentationSuspended}
        />
      ) : null}

      {gallery ? (
        <ImageGallery
          key={gallery.initialId}
          sessionId={session.id}
          images={gallery.images}
          initialId={gallery.initialId}
          onClose={() => setGallery(undefined)}
          suspended={nativePresentationSuspended}
        />
      ) : null}
    </main>
  )
}
