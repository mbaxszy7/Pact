import { BookOpen, Info, MessageSquareText } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  AnchoredComment,
  CollaborationSession,
  RelayDecisionAnswer,
  RuntimeAgentId,
  SessionCatalogChange,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SideChatSyncMainReceipt,
  SkillSelection,
  UserInformationDeclaration,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import {
  collaborationActor,
  defaultTaskStageRoles,
  isCollaborationOpenMode,
  otherAgent,
  pactSessionEntryPrimary,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  resolveLegacyCompatibleTaskStageRoles,
  validateSideChatMainSyncContent,
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
  CONVERSATION_WIDTH,
  EMPTY_COMMENTS,
  EMPTY_IMAGES,
  EMPTY_SKILLS,
  ignoreSkillChanges,
  mentionQueryAt,
  resolvePlanStatusLabel,
  sha256Hex,
  type MentionOption,
  type MentionQuery,
} from './conversation-view-helpers'
import {
  conversationWindowStartOrder,
  isRunResponseComplete,
  nativeInputRequests,
} from './conversation-window'
import { CurrentPlanPanel } from './CurrentPlanPanel'
import { EditorialMessageItem } from './EditorialMessageItem'
import { ImageGallery } from './ImageGallery'
import { NativePermissionCard } from './NativePermissionCard'
import { NativeForkRecovery, SessionForkDialog, type SessionForkOpening } from './SessionFork'
import { TaskReplacementConfirmation } from './TaskReplacementConfirmation'
import { commentDraftSaveSucceeded, hasDecisionAnswers, sameDecision } from './useConversation'
import {
  useConversationPlanPreview,
  type ConversationMessageNavigation,
} from './useConversationPlanPreview'
import { useConversationTranscriptVirtualizer } from './useConversationTranscriptVirtualizer'
import { useConversationWorkspaceChanges } from './useConversationWorkspaceChanges'
import { useSkillComposer } from './useSkillComposer'

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
  messageNavigation?: ConversationMessageNavigation | undefined
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

  const [commentEditor, setCommentEditor] = useState<CommentEditorState | undefined>(undefined)
  const [savingComment, setSavingComment] = useState(false)
  const pendingCommentSave = useRef<CommentEditorState | undefined>(undefined)
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
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null)
  const commentFocusRef = useRef<{ visible: boolean; cancel?: () => void }>({ visible })
  // Completed Markdown can skip Composer/stream renders; its stable event
  // handlers read the latest projection only when the user acts.
  const messageInteractionRef = useRef({
    snapshot,
    messageMeta: history.window?.messageMeta,
    onNotice,
    onOpenProjectFile,
  })

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

  const {
    dismissedNavigation,
    dismissCommentNavigation,
    isNavigationApplied,
    markNavigationApplied,
    openRecordedPlan,
    currentPlan,
    planningTask,
    unfinishedTask,
    inputGateState,
    planRecovery,
    decisionSource,
    decisionKey,
    decisionTakeover,
    planSourcePreview,
    planSourceKey,
    handlePanelPlanReady,
    handlePlanRevealApplied,
    handleClosePlanPanel,
    refreshTaskPlan,
    latestPlanVersion,
    showCurrentPlan,
  } = useConversationPlanPreview({
    sessionId: session.id,
    visible,
    latestRun,
    queueRevision: snapshot?.queue?.revision,
    messageNavigation,
    onPlanAvailable,
    onOpenPlan,
    onClosePlan,
    onRegisterShowCurrentPlan,
  })

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
  const foregroundStopping = Boolean(sessionIssues?.stoppingAgentId)
  const respondingAgentId =
    (snapshot?.nativeContexts ?? []).find(
      (context) =>
        context.continuationState === 'responding' || context.continuationState === 'waiting_user',
    )?.agentId ??
    activeRun?.agentId ??
    sessionIssues?.stoppingAgentId ??
    (!recoveryLocked ? pendingRoutedAgentId : undefined)
  const backgroundIssues = visibleSessionIssues?.agents ?? []
  const backgroundWorking = backgroundIssues.some((issue) => issue.phase === 'background_working')
  const backgroundStopping = backgroundIssues.some((issue) => issue.phase === 'background_stopping')
  const backgroundCheckNeeded = backgroundIssues.some(
    (issue) => issue.phase === 'background_check' || issue.phase === 'background_checking',
  )
  const backgroundStopIssue = backgroundIssues.find((issue) => issue.backgroundStop)
  const backgroundStop = backgroundStopIssue?.backgroundStop
  const stopping = stopRequested || backgroundStopping || foregroundStopping
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

  useEffect(() => {
    dismissedMention.current = undefined
    setMentionQuery(undefined)
    setActiveMentionIndex(0)
  }, [session.id])

  useLayoutEffect(() => {
    messageInteractionRef.current = {
      snapshot,
      messageMeta: history.window?.messageMeta,
      onNotice,
      onOpenProjectFile,
    }
  }, [snapshot, history.window?.messageMeta, onNotice, onOpenProjectFile])

  const openProjectFile = useCallback((target: ProjectFileTarget): void => {
    messageInteractionRef.current.onOpenProjectFile(target)
  }, [])

  const { renderWorkspaceChanges } = useConversationWorkspaceChanges({
    sessionId: session.id,
    visible,
    snapshot,
    latestChangesRun: latestRun,
    activeRun,
    activeWorkspaceDiff,
    activeWorkspaceFilePath,
    onUndoWorkspaceChanges,
    onUndoWorkspaceFile,
    onPrepareWorkspaceChanges,
    onOpenWorkspaceChanges,
    onNotice,
  })

  const {
    transcriptRef,
    transcriptContentRef,
    messageListRef,
    queueDockRef,
    listOffset,
    rows,
    virtualizer,
    virtualRows,
    measureRow,
    hasOlderHistory,
    hasNewerHistory,
    copyFeedback,
    revealReport,
    revealReportRequestId,
    revealReportOffset,
    registerMessageElement,
    copyMessage,
    loadLatest,
    handlePlanReady,
    beginDetailRead,
    viewSavedResponse,
    handleInputHeightDelta,
    resetScrollForSubmit,
    handleTranscriptFocusCapture,
    handleTranscriptBlurCapture,
    handleTranscriptPointerDown,
    handleTranscriptWheel,
    handleTranscriptKeyDown,
    handleTranscriptScroll,
    handleRetryHistoryPage,
  } = useConversationTranscriptVirtualizer({
    visible,
    loading,
    snapshot,
    history,
    activeRun,
    activeRunHasMessage,
    runsById,
    activityOwnerMessageByRun,
    queuedInputId: queuedInput?.id,
    messageNavigation,
    dismissedNavigation,
    dismissCommentNavigation,
    isNavigationApplied,
    markNavigationApplied,
  })

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
    refreshTaskPlan()
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
    resetScrollForSubmit()
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
      refreshTaskPlan()
      skillComposer.close()
      setMentionQuery(undefined)
    } else if (decisionReply) refreshTaskPlan()
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
        refreshTaskPlan()
        skillComposer.close()
        setMentionQuery(undefined)
      } else {
        setReplacementFailed(true)
        refreshTaskPlan()
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
              onRevealApplied={handlePlanRevealApplied}
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
              onClose={handleClosePlanPanel}
              onRetry={refreshTaskPlan}
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
        onFocusCapture={handleTranscriptFocusCapture}
        onBlurCapture={handleTranscriptBlurCapture}
        onPointerDown={handleTranscriptPointerDown}
        onWheel={handleTranscriptWheel}
        onKeyDown={handleTranscriptKeyDown}
        onScroll={handleTranscriptScroll}
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
                onClick={handleRetryHistoryPage}
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
                        revealReportOffset={revealReportOffset}
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
