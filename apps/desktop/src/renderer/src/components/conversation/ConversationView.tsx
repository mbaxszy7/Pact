import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Composer autocomplete follows the ARIA listbox pattern; native select/options cannot insert inline Mention tokens. */
import {
  BookOpen,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  CornerUpLeft,
  LoaderCircle,
  ImagePlus,
  Info,
  MessageSquarePlus,
  MessageSquareText,
  Square,
  Split,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import type {
  AgentActivity,
  AgentRun,
  AnchoredComment,
  CollaborationSession,
  CollaborationTask,
  ConversationPage,
  CommentAnchor,
  MessageCommentAnchor,
  PeerRequestProposal,
  RuntimeAgentId,
  WorkspaceChangeSet,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SessionCatalogChange,
  ConversationRunContext,
  ConversationDisplayOrder,
} from '@pact/contracts'
import type { SkillSelection } from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import {
  compareConversationDisplayOrder,
  conversationMessageOrder,
  CONVERSATION_MARKDOWN_BYTES,
  parseComposerCommandPrefix,
  CONVERSATION_WINDOW_MESSAGES,
  WORKSPACE_CHANGE_FILES,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  collaborationInputGate,
  collaborationInputProcessing,
} from '@pact/contracts'

import type { ConversationViewProjection } from './conversation-window'
import type { DraftImage } from './image-client'
import type {
  ConversationComposerMention,
  ConversationHistoryControls,
  ConversationFlow,
} from './useConversation'

import { MESSAGE_ANCHOR_TEXT_BASIS } from '../../../../shared/message-anchor-text'
import { InputReplacement } from '../ui/InputReplacement'
import { AgentActivityList } from './AgentActivityList'
import { CollaborationQuestionCard } from './CollaborationQuestionCard'
import {
  CollaborationReview,
  type PlanTextSelection,
  type ReportTextSelection,
} from './CollaborationReview'
import {
  composerDifference,
  composerHasContent,
  replaceComposerDocument,
  resolveComposerRoute,
  type ComposerDocument,
} from './composer-document'
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor'
import {
  nativeInputRequests,
  conversationWindowStartOrder,
  isRunResponseComplete,
} from './conversation-window'
import { ConversationImages } from './ConversationImages'
import { CurrentPlanPanel, type CurrentPlanDocument } from './CurrentPlanPanel'
import { ImageGallery } from './ImageGallery'
import { LargeMessagePreview } from './LargeBodyPreview'
import {
  clearProjectionHighlight,
  focusProjectionRange,
  isProjectionHighlightOwned,
  selectedTextRange,
  planSelectionSource,
  reportSelectionSource,
  reportSourceSelector,
} from './message-selection'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'
import { NativeInputCard } from './NativeInputCard'
import { NativePermissionCard } from './NativePermissionCard'
import { PermissionMenu } from './PermissionMenu'
import { ProjectContextMenu } from './ProjectContextMenu'
import { QueueMessageBar } from './QueueMessageBar'
import { SentComments } from './SentComments'
import { NativeForkRecovery, SessionForkDialog, type SessionForkOpening } from './SessionFork'
import { SessionWarningCard } from './SessionWarningCard'
import { SpeedMenu } from './SpeedMenu'
import { sameDecision, hasDecisionAnswers, type DecisionReplyContext } from './useConversation'
import { commentDraftSaveSucceeded } from './useConversation'
import { useSkillComposer, type ComposerEdit } from './useSkillComposer'
import { WorkspaceChangesCard, type WorkspaceChangesList } from './WorkspaceChangesCard'

const EMPTY_SKILLS: SkillSelection[] = []
const EMPTY_IMAGES: readonly DraftImage[] = []
const EMPTY_COMMENTS: AnchoredComment[] = []
const ignoreSkillChanges = (_value: SkillSelection[]): void => undefined
const commentSourceLabel = (anchor: CommentAnchor): string =>
  anchor.type === 'unavailable'
    ? 'Source unavailable'
    : anchor.type === 'file'
      ? anchor.path
      : anchor.plan
        ? `Plan v${anchor.plan.version}`
        : anchor.report
          ? 'Review'
          : 'Message'

interface ConversationViewProps {
  planPanelHost?: HTMLElement | null | undefined
  planPanelOpen?: boolean | undefined
  planPanelExpanded?: boolean | undefined
  onPlanPanelExpandedChange?: ((expanded: boolean) => void) | undefined
  planAvailable?: boolean | undefined
  planRestoreFocusRef?: React.RefObject<HTMLButtonElement | null> | undefined
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
  onComposerMentionChange: (value: ConversationComposerMention | undefined) => void
  loading: boolean
  sending: boolean
  stopping: boolean
  agentActionsEnabled: boolean
  error?: string | undefined
  onSend: ConversationFlow['send']
  onSaveCommentDraft: ConversationFlow['saveCommentDraft']
  onRemoveCommentDraft: (commentId: string) => Promise<boolean>
  onStop: () => Promise<boolean>
  onRebuildNativeContext: ConversationFlow['rebuildNativeContext']
  onCheckNativeContext: ConversationFlow['checkNativeContext']
  onAcceptPeerProposal: (proposalId: string) => Promise<boolean>
  onDismissPeerProposal: (proposalId: string) => Promise<boolean>
  onUndoWorkspaceChanges: (changeSetId: string) => Promise<boolean>
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
        startOffset: number
        endOffset: number
        textBasis?: MessageCommentAnchor['textBasis']
        plan?: MessageCommentAnchor['plan']
        report?: MessageCommentAnchor['report']
      }
    | undefined
}

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const messageDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const TRANSCRIPT_OVERSCAN = 4
const CONVERSATION_WIDTH = 'w-full max-w-[clamp(56rem,82cqw,80rem)]'
const OLDER_HISTORY_SCROLL_THRESHOLD = 160

function hasVisibleChanges(run: AgentRun | undefined): boolean {
  return Boolean(
    run?.workspaceChanges &&
    run.workspaceChanges.fileCount > 0 &&
    (run.workspaceChanges.finalizedAt || run.dispatchPhase === 'ended'),
  )
}

function hasRecordingWarning(run: AgentRun | undefined): boolean {
  return Boolean(run?.dispatchPhase === 'ended' && run.workspaceRecordingUnavailableReason)
}
interface MentionQuery {
  start: number
  end: number
  query: string
}
const mentionOptions = [
  {
    token: '@codex' as const,
    label: 'Codex',
    description: 'Send only to Codex',
    route: { type: 'agent', agentId: 'codex' } as const,
    icon: Bot,
  },
  {
    token: '@claude' as const,
    label: 'Claude Code',
    description: 'Send only to Claude Code',
    route: { type: 'agent', agentId: 'claude' } as const,
    icon: Bot,
  },
  {
    token: '@all' as const,
    label: 'All',
    description: 'Primary, then Secondary',
    route: { type: 'all' } as const,
    icon: Users,
  },
]

function mentionQueryAt(value: string, cursor: number): MentionQuery | undefined {
  const prefix = value.slice(0, cursor)
  const match = /(?:^|\s)@([a-z]*)$/iu.exec(prefix)
  if (!match) return undefined
  const start = cursor - match[1]!.length - 1
  return { start, end: cursor, query: match[1]!.toLowerCase() }
}

export function ConversationView({
  planPanelHost,
  planPanelExpanded = false,
  onPlanPanelExpandedChange,
  planAvailable,
  planRestoreFocusRef,
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
  onComposerMentionChange,
  loading,
  sending,
  stopping,
  agentActionsEnabled,
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
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceChangesList>()
  const workspaceFilesRef = useRef<WorkspaceChangesList | undefined>(undefined)
  const workspaceFilesGenerationRef = useRef(0)
  const workspaceFilesTimeoutRef = useRef<number | undefined>(undefined)
  const workspaceFilesPendingRef = useRef(false)
  const queuedWorkspaceFilesRef = useRef<
    | {
        changeSetId: string
        expand: boolean
        open: boolean
        contextGeneration?: number | undefined
      }
    | undefined
  >(undefined)
  const [undoingChangeSetId, setUndoingChangeSetId] = useState<string>()
  const undoingChangeSetRef = useRef<string | undefined>(undefined)
  const workspaceOwnerActiveRef = useRef(true)
  const defaultWorkspaceChangesIdRef = useRef<string | undefined>(undefined)
  const installWorkspaceFiles = useCallback((list: WorkspaceChangesList | undefined): void => {
    workspaceFilesRef.current = list
    setWorkspaceFiles(list)
  }, [])
  useEffect(() => {
    workspaceOwnerActiveRef.current = true
    return () => {
      workspaceOwnerActiveRef.current = false
      workspaceFilesGenerationRef.current += 1
      queuedWorkspaceFilesRef.current = undefined
      if (workspaceFilesTimeoutRef.current !== undefined)
        window.clearTimeout(workspaceFilesTimeoutRef.current)
    }
  }, [])
  const loadWorkspaceFiles = useCallback(
    async (
      changeSetId: string,
      expand = false,
      open = false,
      contextGeneration?: number,
    ): Promise<void> => {
      const existing =
        workspaceFilesRef.current?.changeSetId === changeSetId
          ? workspaceFilesRef.current
          : undefined
      const revision =
        messageInteractionRef.current.snapshot?.runs.find(
          (run) => run.workspaceChanges?.id === changeSetId,
        )?.workspaceChanges?.revision ?? 0
      const current = (existing?.revision ?? 0) === revision ? existing : undefined
      if (workspaceFilesPendingRef.current) {
        queuedWorkspaceFilesRef.current = { changeSetId, expand, open, contextGeneration }
        return
      }
      if (
        current &&
        !current.error &&
        ((!expand && current.files.length) || (expand && !current.expanded))
      ) {
        installWorkspaceFiles({ ...current, expanded: expand || current.expanded })
        if (open && current.files[0])
          onOpenWorkspaceChanges(
            changeSetId,
            current.files[0].path,
            contextGeneration,
            current.revision,
          )
        return
      }
      if (current && expand && !current.nextPath && !current.error) return
      const generation = ++workspaceFilesGenerationRef.current
      workspaceFilesPendingRef.current = true
      if (workspaceFilesTimeoutRef.current !== undefined)
        window.clearTimeout(workspaceFilesTimeoutRef.current)
      const initial: WorkspaceChangesList = {
        changeSetId,
        revision,
        files: current?.files ?? [],
        nextPath: current?.nextPath ?? null,
        loading: true,
        expanded: expand || existing?.expanded || false,
      }
      installWorkspaceFiles(initial)
      workspaceFilesTimeoutRef.current = window.setTimeout(() => {
        if (generation !== workspaceFilesGenerationRef.current) return
        workspaceFilesGenerationRef.current += 1
        workspaceFilesTimeoutRef.current = undefined
        installWorkspaceFiles({
          ...initial,
          loading: false,
          error: 'Loading saved files took too long. Try again.',
        })
      }, WORKSPACE_OPERATION_TIMEOUT_MS)
      try {
        const result = await window.pact.readWorkspaceChanges({
          changeSetId,
          ...(current?.nextPath ? { afterPath: current.nextPath } : {}),
        })
        if (!workspaceOwnerActiveRef.current || generation !== workspaceFilesGenerationRef.current)
          return
        if (!result.ok) {
          installWorkspaceFiles({ ...initial, loading: false, error: result.error.message })
          if (open) onNotice(result.error.message)
          return
        }
        if (
          result.value.changeSet.id !== changeSetId ||
          result.value.changeSet.sessionId !== session.id
        )
          throw new Error('These changes do not belong to this Session.')
        if ((result.value.changeSet.revision ?? 0) !== revision)
          throw new Error('The recorded changes changed while loading. Try again.')
        const files = [...initial.files, ...result.value.files]
        if (files.length > WORKSPACE_CHANGE_FILES)
          throw new Error('The saved file list exceeded its supported size.')
        if (new Set(files.map((file) => file.path)).size !== files.length)
          throw new Error('The saved file list contains duplicate paths.')
        if (!result.value.nextPath && files.length !== result.value.changeSet.fileCount)
          throw new Error('The saved file list is incomplete. Try again.')
        if (result.value.nextPath && result.value.nextPath === current?.nextPath)
          throw new Error('The saved file list did not advance.')
        installWorkspaceFiles({
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
          else onNotice('No saved files are available for this round.')
        }
      } catch (failure) {
        if (!workspaceOwnerActiveRef.current || generation !== workspaceFilesGenerationRef.current)
          return
        const message =
          failure instanceof Error ? failure.message : 'Pact could not load saved files.'
        installWorkspaceFiles({ ...initial, loading: false, error: message })
        if (open) onNotice(message)
      } finally {
        workspaceFilesPendingRef.current = false
        if (
          generation === workspaceFilesGenerationRef.current &&
          workspaceFilesTimeoutRef.current !== undefined
        ) {
          window.clearTimeout(workspaceFilesTimeoutRef.current)
          workspaceFilesTimeoutRef.current = undefined
        }
        const queued = queuedWorkspaceFilesRef.current
        queuedWorkspaceFilesRef.current = undefined
        if (workspaceOwnerActiveRef.current && queued)
          void loadWorkspaceFiles(
            queued.changeSetId,
            queued.expand,
            queued.open,
            queued.contextGeneration,
          )
      }
    },
    [installWorkspaceFiles, onNotice, onOpenWorkspaceChanges, session.id],
  )
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
  const undoWorkspaceChanges = (changeSetId: string): void => {
    if (undoingChangeSetRef.current) return
    undoingChangeSetRef.current = changeSetId
    setUndoingChangeSetId(changeSetId)
    void onUndoWorkspaceChanges(changeSetId).finally(() => {
      undoingChangeSetRef.current = undefined
      if (workspaceOwnerActiveRef.current) setUndoingChangeSetId(undefined)
    })
  }
  const [commentEditor, setCommentEditor] = useState<
    | { commentId?: string; draftId: string; anchor: CommentAnchor; quote: string; body: string }
    | undefined
  >(undefined)
  const [savingComment, setSavingComment] = useState(false)
  const pendingCommentSave = useRef<typeof commentEditor>(undefined)
  const gapRetryRef = useRef<{ mode: 'around'; messageId: string } | { mode: 'latest' }>({
    mode: 'latest',
  })
  const [copyFeedback, setCopyFeedback] = useState<
    { messageId: string; result: 'copying' | 'copied' | 'failed' } | undefined
  >(undefined)
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined)
  const composerRef = useRef<ComposerEditorHandle>(null)
  const [gallery, setGallery] = useState<{ images: ConversationImage[]; initialId: string }>()
  const [imageDropActive, setImageDropActive] = useState(false)
  const openImageGallery = (images: readonly DraftImage[], image: ConversationImage): void =>
    setGallery({
      images: images.flatMap((entry) => (entry.image ? [entry.image] : [])),
      initialId: image.id,
    })
  const skillMenuRef = useRef<HTMLDivElement>(null)
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
  const openRecordedPlan = (source: {
    runId: string
    messageId: string
    version: number
  }): void => {
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
  }
  const planSourceNavigationRef = useRef(planSourceNavigation)
  planSourceNavigationRef.current = planSourceNavigation
  const openPlanCallback = useRef(onOpenPlan)
  openPlanCallback.current = onOpenPlan
  const appliedNavigationRef = useRef<typeof messageNavigation>(undefined)
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
    planSync?: Extract<ConversationPage, { scope: 'collaboration' }>['view']['planSync'] | undefined
    source?: { runId: string; messageId: string } | undefined
    error?: string | undefined
  }>()
  const [planRefresh, setPlanRefresh] = useState(0)
  const [answeredDecisionKey, setAnsweredDecisionKey] = useState<string>()
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
  const planningTask = currentTask?.kind === 'plan' ? currentTask : undefined
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
  // A successful Send dismisses this notice immediately, including while the
  // current-task projection is refreshing. A new reply or withdrawn input has
  // a different identity/version and can ask for a decision again.
  const decisionTakeover = Boolean(decisionSource)
  const nativeRequests = nativeInputRequests(snapshot)
  const nativeQuestions = nativeRequests.filter(
    ({ request }) => request.kind && request.kind !== 'approval',
  )
  const inputTakeover = decisionTakeover || nativeQuestions.length > 0
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
  const responseInProgress = Boolean(respondingAgentId) || stopping
  const composerActionLabel = stopping
    ? 'Stopping response'
    : respondingAgentId &&
        !(
          unfinishedTask &&
          (composerHasContent(composer) || snapshot?.draftComments.length || composerImages.length)
        )
      ? `Stop ${respondingAgentId === 'claude' ? 'Claude Code' : 'Codex'} response`
      : 'Send message'
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
  const composerDisabled = !agentActionsEnabled || recoveryLocked || Boolean(history.restoringInput)
  const composerContentReady = useMemo(() => composerHasContent(composer), [composer])
  const skillComposer = useSkillComposer({
    session,
    text: composer,
    selections: composerSkills,
    route: composerRoute,
    mention: composerMention,
    returnedInputOperationId: composerReturnedInputOperationId,
    disabled: composerDisabled || inputTakeover,
  })
  const activeSkillId = skillComposer.query
    ? skillComposer.options[skillComposer.active]?.id
    : undefined
  useLayoutEffect(() => {
    if (activeSkillId && skillComposer.revealActive)
      skillMenuRef.current?.querySelector<HTMLElement>(`#skill-${activeSkillId}`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'instant',
      })
  }, [activeSkillId, skillComposer.revealActive])
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
    !queuedInput.workflowCommand,
  )
  const steerUnavailableReason = queuedInput?.workflowCommand
    ? 'New workflows wait until the current response finishes.'
    : queuedInput?.recipient === 'all'
      ? 'Messages for all Agents stay queued.'
      : 'Steer is available only for the Agent currently responding.'
  const disabled =
    choosingImages ||
    composerImages.some((image) => image.status !== 'ready') ||
    Boolean(skillComposer.warning) ||
    skillComposer.checking ||
    composerDisabled ||
    (inputGate === 'send_blocked' && !activeRun?.collaboration) ||
    sending ||
    stopping ||
    history.draftsLoading
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
    composerDisabled ||
    sending ||
    stopping ||
    Boolean(activeRun) ||
    inputGate !== 'open' ||
    Boolean(history.restoringInput) ||
    !incompleteCanAnswer
  const draftComments = snapshot?.draftComments ?? EMPTY_COMMENTS
  const sendWhileWorking = Boolean(
    unfinishedTask &&
    responseInProgress &&
    (composerContentReady || draftComments.length || composerImages.length),
  )
  const stopComposerAction = responseInProgress && !sendWhileWorking
  const feedbackDraft = Boolean(
    unfinishedTask &&
    (composerContentReady ||
      draftComments.length ||
      composerImages.length ||
      commentEditor?.body.trim()),
  )
  const activeCommentAnchor = commentEditor?.anchor
  const defaultRecipient =
    unfinishedTask && !parseComposerCommandPrefix(composer, composerSkills).pact
      ? unfinishedTask.kind === 'review'
        ? unfinishedTask.reviewer
        : unfinishedTask.owner
      : session.settings.primaryAgentId
  const primaryName = session.settings.primaryAgentId === 'claude' ? 'Claude Code' : 'Codex'
  const filteredMentionOptions = mentionOptions.filter(
    (option) =>
      option.token.slice(1).startsWith(mentionQuery?.query ?? '') &&
      (!unfinishedTask || option.token !== '@all'),
  )
  const mentionListOpen = Boolean(
    mentionQuery && filteredMentionOptions.length > 0 && !composerDisabled,
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
  const workspaceFilesSummary = snapshot?.runs.find(
    (run) => run.workspaceChanges?.id === workspaceFiles?.changeSetId,
  )?.workspaceChanges
  const workspaceFilesRevision = workspaceFilesSummary?.revision ?? 0
  useEffect(() => {
    const list = workspaceFilesRef.current
    if (
      !workspaceFiles?.changeSetId ||
      !workspaceFilesSummary?.id ||
      !list ||
      list.changeSetId !== workspaceFiles.changeSetId ||
      (list.revision ?? 0) === workspaceFilesRevision
    )
      return
    // A recording set is mutable. Retire only this existing list/read owner;
    // its one queued replacement starts at the first page after settlement.
    workspaceFilesGenerationRef.current += 1
    if (workspaceFilesTimeoutRef.current !== undefined) {
      window.clearTimeout(workspaceFilesTimeoutRef.current)
      workspaceFilesTimeoutRef.current = undefined
    }
    void loadWorkspaceFiles(list.changeSetId, list.expanded)
  }, [
    workspaceFilesRevision,
    workspaceFilesSummary?.id,
    workspaceFiles?.changeSetId,
    loadWorkspaceFiles,
  ])
  const openProjectFile = useCallback((target: ProjectFileTarget): void => {
    messageInteractionRef.current.onOpenProjectFile(target)
  }, [])
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
    // A settled Run can publish a plan without an ordinary answer Message.
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

  const rows = useMemo(() => {
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
    const result = messages.map((message) => ({
      key:
        message.outputSnapshot && message.outputSnapshot.ordinal > 0
          ? `message:${message.id}`
          : history.window?.sourceMessageId === message.id
            ? `source:${message.id}`
            : message.replyToMessageId
              ? `reply:${message.replyToMessageId}:${message.agentId ?? 'unknown'}:${message.runId ?? 'unknown'}`
              : `message:${message.id}`,
      message,
      run: undefined as AgentRun | undefined,
      context: undefined as ConversationRunContext | undefined,
    })) as Array<{
      key: string
      message: (typeof messages)[number] | undefined
      run: AgentRun | undefined
      context?: ConversationRunContext | undefined
    }>
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
  // Body Patches can replace a row without changing its logical key. Keep
  // measurement callbacks stable across those high-frequency text updates.
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
  // TanStack owns mutable measurements; React Compiler must not memoize its methods.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => 180,
    getItemKey: getRowKey,
    overscan: TRANSCRIPT_OVERSCAN,
    // Scroll compensation and spacer positions must commit in the same paint.
    useFlushSync: true,
    measureElement: (element, entry) =>
      entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height,
    scrollMargin: listOffset,
    // A pinned Selection must survive wheel scrolling. Include its intervening
    // rows, then bound viewport/overscan + protected rows by the same DOM budget.
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
  // Cold card reads can finish after an upward scroll. Compensate changes
  // entirely above the viewport in either direction; growing the visible
  // message itself must not move the reader's position.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    // Home requests the beginning itself, rather than preserving an earlier visible row.
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
    // Only evicted keys are removed. Erasing still-resident heights would make
    // a known reading anchor an estimate again and double its compensation.
    for (const key of virtualizer.itemSizeCache.keys()) {
      if (!retainedRowKeys.has(String(key))) virtualizer.itemSizeCache.delete(key)
    }
  }, [virtualizer, retainedRowKeys])
  const measureRow = useCallback(
    (element: HTMLLIElement | null) => {
      // Prune before admitting a new measurement, not just after commit: even
      // transient capacity stays within the bounded resident row keyset.
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
      // The user has read past a merely selected Message. Keep the reading
      // anchor, but let the disposable browser Selection go with its source.
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
    // Navigation must stop tail-following before its around page arrives, not
    // after that page has already been mounted and scrolled to the bottom.
    stickToBottomRef.current = false
    scrollIntentRef.current = undefined
    gapRestoreRef.current = undefined
    setRestorationMessageIds([])
    setRestorationPlan(undefined)
    setRestorationReport(undefined)
    void ensureMessage(messageNavigation.messageId)
    // A resident source marker can change the row key. Focus only after that
    // render has committed, never on a DOM node about to be replaced.
    if (history.window?.sourceMessageId !== messageNavigation.messageId) return undefined
    if (messageNavigation.plan || messageNavigation.report) return undefined
    const message = navigationMessage
      ? messageRefs.current.get(messageNavigation.messageId)
      : undefined
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
            // Register the exact range target with the same virtualizer that
            // owns height compensation, so an above-viewport measure cannot
            // cancel a separate native smooth scroll.
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
    history.window?.sourceMessageId,
    visible,
    navigationMessage,
    mountedRowKeys,
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
  useEffect(() => {
    if (!activeCommentAnchor) return undefined
    const frame = requestAnimationFrame(() => {
      const textarea = commentTextareaRef.current
      textarea?.focus()
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeCommentAnchor, planPanelExpanded])
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
    // A scroll event can precede the virtual range commit. Keep its existing
    // intent until that commit; never preserve an offscreen overscan/pinned row.
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
    // Explicit navigation wins over a pending reading/Selection restoration.
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
    setMentionQuery(mentionQueryAt(document.text, cursor))
    setActiveMentionIndex(0)
    return true
  }
  const cursorChanged = (cursor: number): void => {
    const current = composerRef.current?.document() ?? editorValue
    skillComposer.update(current.text, cursor, current.skills)
    setMentionQuery(mentionQueryAt(current.text, cursor))
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
        editError instanceof Error ? editError.message : 'Your draft was kept.',
      )
    }
  }
  const chooseSkill = (entry: import('./useSkillComposer').ComposerSkillOption): void => {
    const replacement = skillComposer.choose(entry)
    if (!replacement) return
    const current = composerRef.current?.document() ?? editorValue
    if (
      history.admitComposerEdit?.(
        current.text.length - (replacement.end - replacement.start) + replacement.text.length,
      ) === false
    )
      return
    try {
      const next = replaceComposerDocument(current, replacement)
      if (replacement.skill)
        next.skills = [...next.skills, replacement.skill].toSorted((a, b) => a.start - b.start)
      const cursor = replacement.start + replacement.text.length
      composerRef.current?.focus()
      composerRef.current?.apply(next, { start: cursor, end: cursor }, [replacement])
    } catch (editError) {
      composerRef.current?.refuseEdit(
        editError instanceof Error ? editError.message : 'Your draft was kept.',
      )
    }
  }

  const chooseMention = (option: (typeof mentionOptions)[number]): void => {
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
        editError instanceof Error ? editError.message : 'Your draft was kept.',
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
    if (responseInProgress && !queueEnabled && !unfinishedTask) return
    if (responseInProgress && queuedInput) {
      onNotice('One message is already queued. Edit or remove it before queuing another.')
      return
    }
    if (
      (!composerHasContent(composerRef.current?.document().text ?? composer) &&
        draftComments.length === 0 &&
        composerImages.length === 0 &&
        !decisionAnswersReady) ||
      disabled
    )
      return
    stickToBottomRef.current = true
    cancelPrepend()
    scrollIntentRef.current = undefined
    const document = composerRef.current?.document() ?? editorValue
    const removed = document.text.length - document.text.trimStart().length
    const { sendRoute } = resolveComposerRoute(document, defaultRecipient)
    if (unfinishedTask && sendRoute?.type === 'all') {
      onNotice('Choose one Agent for this feedback batch.')
      return
    }
    const prefix = parseComposerCommandPrefix(document.text, document.skills)
    if (decisionReply && prefix.pact) {
      onNotice('Send your answers as a reply before starting another Pact command.')
      return
    }
    const submittedDecisionKey = decisionKey
    const targetRoute =
      unfinishedTask && sendRoute?.type === 'primary' && !prefix.pact
        ? { type: 'agent' as const, agentId: defaultRecipient }
        : sendRoute
    const sent = await onSend(
      document.text,
      draftComments.map((comment) => comment.id),
      targetRoute,
      document.skills.map((entry) => {
        return Object.assign({}, entry, { start: entry.start - removed, end: entry.end - removed })
      }),
    )
    if (sent) {
      setAnsweredDecisionKey(submittedDecisionKey)
      setPlanRefresh((value) => value + 1)
      skillComposer.close()
      setMentionQuery(undefined)
    } else if (decisionReply) setPlanRefresh((value) => value + 1)
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
      // The previous navigation's passive cleanup must finish before this source owns a highlight.
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
          plan: {
            runId: requested.runId,
            messageId: source.messageId,
            version: requested.version,
            author: task.owner,
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
        : submitted.anchor.type === 'unavailable'
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

  const renderWorkspaceChanges = (changeSet: WorkspaceChangeSet): React.JSX.Element => (
    <WorkspaceChangesCard
      changeSet={changeSet}
      list={
        workspaceFiles?.changeSetId === changeSet.id &&
        (workspaceFiles.revision ?? 0) === (changeSet.revision ?? 0)
          ? workspaceFiles
          : undefined
      }
      undoing={undoingChangeSetId === changeSet.id}
      disabled={Boolean(activeRun || undoingChangeSetId)}
      onUndo={undoWorkspaceChanges}
      onView={(id) => void loadWorkspaceFiles(id, false, true, onPrepareWorkspaceChanges())}
      onShowFiles={(id) => void loadWorkspaceFiles(id, true)}
      onOpenFile={(id, path) => onOpenWorkspaceChanges(id, path, undefined, changeSet.revision)}
    />
  )
  const renderChangeMetadata = (run: AgentRun): React.JSX.Element => (
    <p className="mb-1 px-1 text-caption text-secondary">
      {run.agentId === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
      <time dateTime={run.createdAt}>
        {messageDateTimeFormatter.format(new Date(run.createdAt))}
      </time>{' '}
      ·{' '}
      {run.controlDisposition === 'abandoned'
        ? 'Abandoned'
        : run.status === 'interrupted'
          ? 'Stopped'
          : run.status === 'failed'
            ? 'Failed'
            : 'Completed'}
    </p>
  )
  const renderRecordingWarning = (run: AgentRun): React.JSX.Element | null =>
    hasRecordingWarning(run) ? (
      <p
        className="flex items-start gap-2 px-1 py-1 text-caption text-status-warning-foreground"
        role="status"
        data-pact-workspace-warning={run.id}
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
        <span>{run.workspaceRecordingUnavailableReason}</span>
      </p>
    ) : null
  const renderSavedRunResult = (run: AgentRun): React.JSX.Element | null =>
    run.responseMessageId ? (
      <button
        type="button"
        onClick={() => {
          const id = run.responseMessageId!
          cancelPrepend()
          stickToBottomRef.current = false
          scrollIntentRef.current = undefined
          setRequestedResponseId(id)
          setRestorationMessageIds([id])
          void history.ensureMessage(id)
        }}
        className="min-h-8 w-fit cursor-pointer rounded-control px-2 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
      >
        View response
      </button>
    ) : null
  const renderChangeGroup = (run: AgentRun): React.JSX.Element => {
    const group = history.window?.runArtifacts?.find((item) => item.latestRunId === run.id)
    const previousCount = Math.max(0, (group?.totalCount ?? 1) - 1)
    const opened = history.window?.artifactHistory
    const sameGroup = opened?.userMessageId === run.userMessageId && opened.agentId === run.agentId
    const loadingGroup =
      history.loadingArtifacts?.userMessageId === run.userMessageId &&
      history.loadingArtifacts.agentId === run.agentId
    const failure =
      history.artifactError?.userMessageId === run.userMessageId &&
      history.artifactError.agentId === run.agentId
        ? history.artifactError.message
        : undefined
    const expanded = sameGroup || loadingGroup || Boolean(failure)
    const earlier = sameGroup
      ? opened.runIds
          .map((id) => runsById.get(id))
          .filter((item): item is AgentRun => Boolean(item))
      : []
    return (
      <div className="flex w-full min-w-0 flex-col gap-2">
        <div className="min-w-0">
          {renderChangeMetadata(run)}
          {hasVisibleChanges(run) && run.workspaceChanges
            ? renderWorkspaceChanges(run.workspaceChanges)
            : null}
          {renderRecordingWarning(run)}
          {run.controlDisposition === 'abandoned' ? renderSavedRunResult(run) : null}
        </div>
        {previousCount > 0 ? (
          <div>
            <button
              type="button"
              aria-expanded={expanded}
              disabled={Boolean(history.loadingArtifacts) && !loadingGroup}
              onClick={() =>
                expanded
                  ? history.closeRunArtifacts()
                  : void history.loadRunArtifacts(run.userMessageId, run.agentId)
              }
              className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
            >
              Previous {previousCount} {previousCount === 1 ? 'record' : 'records'}
              <ChevronDown
                className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {expanded ? (
              <div className="mt-1 flex min-w-0 flex-col gap-group">
                {earlier.toReversed().map((previous) => (
                  <div key={previous.id} className="min-w-0">
                    {renderChangeMetadata(previous)}
                    {hasVisibleChanges(previous) && previous.workspaceChanges
                      ? renderWorkspaceChanges(previous.workspaceChanges)
                      : null}
                    {renderRecordingWarning(previous)}
                    {renderSavedRunResult(previous)}
                  </div>
                ))}
                {loadingGroup ? (
                  <p className="px-2 text-caption text-secondary" aria-busy="true">
                    Loading earlier records…
                  </p>
                ) : null}
                {failure ? (
                  <p className="px-2 text-caption text-status-warning-foreground" role="alert">
                    {failure}
                  </p>
                ) : null}
                {failure || (sameGroup && opened.nextBefore) ? (
                  <button
                    type="button"
                    disabled={loadingGroup}
                    onClick={() =>
                      void history.loadRunArtifacts(
                        run.userMessageId,
                        run.agentId,
                        failure ? history.artifactError?.before : opened?.nextBefore,
                      )
                    }
                    className="min-h-8 w-fit cursor-pointer rounded-control px-2 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                  >
                    {failure ? 'Try again' : 'Load earlier records'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
  const renderRow = (row: (typeof rows)[number]): React.JSX.Element | null => {
    const { message } = row
    const placeholderRun = row.run ?? activeRun
    if (row.context && row.run) {
      const run = row.run
      return (
        <article className="w-fit max-w-[92%] min-w-0 self-start" data-pact-run-context-id={run.id}>
          <div
            className={`rounded-message ${run.agentId === 'claude' ? 'bg-speaker-claude' : 'bg-speaker-codex'} px-4 py-3`}
          >
            <p className="flex min-w-0 items-baseline gap-1.5 text-caption text-secondary">
              <span className="shrink-0 font-medium">
                {run.agentId === 'claude' ? 'Claude Code' : 'Codex'}
              </span>
              <RunConfiguration run={run} />
            </p>
            {run.handoffMessageCount ? (
              <ContextReceipt
                count={run.handoffMessageCount}
                target={run.agentId}
                accepted={Boolean(run.nativeTurnId)}
              />
            ) : null}
            <RunWorkLog
              runId={run.id}
              activities={activitiesByRun.get(run.id) ?? []}
              active={['starting', 'running', 'recovering'].includes(run.status)}
              available
              history={history}
              onRead={beginDetailRead}
            />
          </div>
        </article>
      )
    }
    if (!message && row.key.startsWith('changes:') && row.run)
      return (
        <article className="flex w-full min-w-0 flex-col" data-pact-change-run-id={row.run.id}>
          {renderChangeGroup(row.run)}
          {row.run.collaboration &&
          !['starting', 'running', 'recovering'].includes(row.run.status) &&
          !snapshot?.messages.some(
            (candidate) => candidate.role === 'assistant' && candidate.runId === row.run!.id,
          ) ? (
            <CollaborationReview
              session={session}
              run={row.run}
              latestRunId={latestRun?.id}
              disabled={disabled || responseInProgress}
              onOpenPlan={openRecordedPlan}
              onOpenProjectFile={openProjectFile}
              onCreateReportComment={
                recoveryLocked || inputTakeover ? undefined : handleCreatePlanComment
              }
              feedbackDraft={feedbackDraft}
              onTaskChange={() => setPlanRefresh((value) => value + 1)}
              revealReport={revealReport}
              revealReportRequestId={revealReportRequestId}
              revealReportBasis={
                messageNavigation?.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : undefined
              }
              revealReportOffset={
                gapRestoreRef.current?.selection?.startOffset ?? messageNavigation?.startOffset
              }
              onReportReady={handlePlanReady}
            />
          ) : null}
        </article>
      )
    if (!message)
      return placeholderRun ? (
        <article
          className="flex w-full min-w-0 flex-col"
          data-pact-speaker={placeholderRun.agentId}
        >
          <div className="w-fit max-w-[92%] self-start">
            <div
              className={`rounded-message ${placeholderRun.agentId === 'claude' ? 'bg-speaker-claude' : 'bg-speaker-codex'} px-4 py-3`}
              data-pact-message-bubble
            >
              <p className="flex min-w-0 items-baseline gap-1.5 text-caption text-secondary">
                <span className="shrink-0 font-medium">
                  {placeholderRun.agentId === 'claude' ? 'Claude Code' : 'Codex'}
                </span>
                <RunConfiguration run={placeholderRun} />
              </p>
              {placeholderRun.handoffMessageCount ? (
                <ContextReceipt
                  count={placeholderRun.handoffMessageCount}
                  target={placeholderRun.agentId}
                  accepted={Boolean(placeholderRun.nativeTurnId)}
                />
              ) : null}
              <RunWorkLog
                runId={placeholderRun.id}
                activities={activitiesByRun.get(placeholderRun.id) ?? []}
                active={['starting', 'running', 'recovering'].includes(placeholderRun.status)}
                available={Boolean(activitiesByRun.get(placeholderRun.id)?.length)}
                history={history}
                onRead={beginDetailRead}
              />
            </div>
            {['starting', 'running', 'recovering'].includes(placeholderRun.status) ? (
              <MessageResponseIndicator agentId={placeholderRun.agentId} />
            ) : null}
          </div>
          {placeholderRun.collaboration &&
          !['starting', 'running', 'recovering'].includes(placeholderRun.status) ? (
            <CollaborationReview
              session={session}
              run={placeholderRun}
              latestRunId={latestRun?.id}
              disabled={disabled || responseInProgress}
              onOpenPlan={openRecordedPlan}
              onOpenProjectFile={openProjectFile}
              onCreateReportComment={
                recoveryLocked || inputTakeover ? undefined : handleCreatePlanComment
              }
              feedbackDraft={feedbackDraft}
              onTaskChange={() => setPlanRefresh((value) => value + 1)}
              revealReport={revealReport}
              revealReportRequestId={revealReportRequestId}
              revealReportBasis={
                messageNavigation?.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : undefined
              }
              revealReportOffset={
                gapRestoreRef.current?.selection?.startOffset ?? messageNavigation?.startOffset
              }
              onReportReady={handlePlanReady}
            />
          ) : null}
        </article>
      ) : null
    if (message.role === 'system') {
      const nativeRebuild = message.content.endsWith('native session rebuilt')
      return (
        <div
          data-pact-message-id={message.id}
          tabIndex={-1}
          ref={(element) => {
            if (element) messageRefs.current.set(message.id, element)
            else messageRefs.current.delete(message.id)
          }}
          className={
            nativeRebuild
              ? 'flex items-center gap-3 py-1 text-caption text-tertiary'
              : 'text-center text-caption text-tertiary'
          }
        >
          {nativeRebuild ? <span aria-hidden="true" className="h-px flex-1 bg-border" /> : null}
          <span>{message.content}</span>
          {nativeRebuild ? <span aria-hidden="true" className="h-px flex-1 bg-border" /> : null}
        </div>
      )
    }
    const speaker =
      message.role === 'user' ? 'You' : message.agentId === 'claude' ? 'Claude Code' : 'Codex'
    const background =
      message.role === 'user'
        ? 'bg-speaker-user'
        : message.agentId === 'claude'
          ? 'bg-speaker-claude'
          : 'bg-speaker-codex'
    const retryInThisSlot =
      activeRun &&
      message.outputSnapshot?.canonical !== false &&
      message.replyToMessageId === activeRun.userMessageId &&
      message.agentId === activeRun.agentId &&
      history.window?.sourceMessageId !== message.id
    const messageRun = retryInThisSlot
      ? activeRun
      : message.runId
        ? runsById.get(message.runId)
        : undefined
    const replyRecipient =
      message.role === 'user' && messageRun?.collaboration?.stage === 'reply'
        ? message.route?.type === 'agent'
          ? message.route.agentId
          : messageRun.agentId
        : undefined
    const activityRunId = messageRun?.id ?? message.runId
    const visibleContent = message.content
    const messageMeta = history.window?.messageMeta[message.id]
    const sentComments = history.window?.sentCommentsByMessage[message.id]
    const commentsLoaded = Boolean(history.window?.loadedCommentMessageIds[message.id])
    const commentOnly = message.role === 'user' && !message.content && messageMeta?.hasComments
    const ownsRunActivity = Boolean(
      (message.outputSnapshot?.canonical && isRunResponseComplete(messageRun)) ||
      (!messageRun?.outputSnapshots &&
        !history.window?.runContexts?.some((context) => context.runId === activityRunId) &&
        (retryInThisSlot ||
          (message.runId && activityOwnerMessageByRun.get(message.runId) === message.id))),
    )
    const activities =
      ownsRunActivity && activityRunId ? (activitiesByRun.get(activityRunId) ?? []) : []
    const runActive = Boolean(
      message.outputSnapshot?.canonical !== false &&
      messageRun &&
      messageRun.controlDisposition !== 'abandoned' &&
      (messageRun.id === activeRun?.id ||
        (snapshot?.nativeContexts ?? []).some(
          (context) =>
            context.lastRunId === messageRun.id &&
            (context.continuationState === 'responding' ||
              context.continuationState === 'waiting_user'),
        )),
    )
    const pendingPeerAgentId =
      !activeRun &&
      !recoveryLocked &&
      message.role === 'assistant' &&
      message.outputSnapshot?.canonical !== false &&
      message.replyToMessageId === pendingRoutedMessage?.id &&
      message.agentId !== pendingRoutedAgentId
        ? pendingRoutedAgentId
        : undefined
    return (
      <article
        tabIndex={-1}
        className={
          message.role === 'user'
            ? `ml-auto flex min-w-0 flex-col ${messageMeta?.oversized ? 'w-full max-w-[min(92%,72ch)]' : 'w-fit max-w-[92%]'}`
            : 'flex w-full min-w-0 flex-col'
        }
        data-pact-speaker={message.role === 'user' ? 'user' : (message.agentId ?? 'codex')}
        data-pact-message-id={message.id}
        ref={(element) => {
          if (element) messageRefs.current.set(message.id, element)
          else messageRefs.current.delete(message.id)
        }}
      >
        <div
          className={
            message.role === 'assistant'
              ? `min-w-0 self-start ${messageMeta?.oversized ? 'w-full max-w-[min(92%,72ch)]' : 'w-fit max-w-[92%]'}`
              : 'min-w-0'
          }
        >
          <div className="group/message flex min-w-0 flex-col">
            <div data-pact-message-bubble className={`rounded-message ${background} px-4 py-3`}>
              <p className="flex min-w-0 items-baseline gap-1.5 text-caption text-secondary">
                <span className="shrink-0 font-medium">{speaker}</span>
                {replyRecipient ? (
                  <span
                    className="font-medium text-primary"
                    aria-label={`Reply to ${replyRecipient === 'codex' ? 'Codex' : 'Claude Code'}`}
                  >
                    @{replyRecipient}
                  </span>
                ) : null}
                {message.role === 'assistant' && messageRun ? (
                  <RunConfiguration run={messageRun} />
                ) : null}
              </p>
              {ownsRunActivity && messageRun?.handoffMessageCount ? (
                <ContextReceipt
                  count={messageRun.handoffMessageCount}
                  target={messageRun.agentId}
                  accepted={Boolean(messageRun.nativeTurnId)}
                />
              ) : null}
              {ownsRunActivity && activityRunId ? (
                <RunWorkLog
                  runId={activityRunId}
                  completed={isRunResponseComplete(messageRun)}
                  activities={activities}
                  active={runActive}
                  available={
                    retryInThisSlot ? activities.length > 0 : Boolean(messageMeta?.hasActivities)
                  }
                  history={history}
                  onRead={beginDetailRead}
                />
              ) : null}
              <div
                className={
                  message.role === 'assistant' && activities.length > 0
                    ? 'mt-2 border-t border-border/55 pt-2.5'
                    : 'mt-1'
                }
              >
                {messageMeta?.oversized ? (
                  <LargeMessagePreview preview={messageMeta.oversized.preview} />
                ) : !commentOnly ? (
                  <MessageMarkdown
                    content={visibleContent}
                    skills={message.role === 'user' ? message.skills : undefined}
                    onOpenProjectFile={openProjectFile}
                    messageId={message.id}
                    onCreateComment={
                      recoveryLocked || inputTakeover ? undefined : handleCreateMessageComment
                    }
                  />
                ) : null}
                {message.images?.length ? (
                  <ConversationImages
                    sessionId={session.id}
                    images={message.images.map((image) => ({
                      id: image.id,
                      name: image.name,
                      status: 'ready',
                      image,
                    }))}
                    onOpen={(image) => setGallery({ images: message.images!, initialId: image.id })}
                  />
                ) : null}
                {messageMeta?.hasComments ? (
                  <SentComments
                    comments={sentComments}
                    loading={!commentsLoaded && !history.window?.commentError}
                    error={commentsLoaded ? undefined : history.window?.commentError}
                    commentOnly={Boolean(commentOnly)}
                    onRetry={history.retryComments}
                    onOpenComment={onOpenComment}
                    hasMore={history.commentPages?.[message.id]?.hasMore ?? true}
                    hasEarlier={history.commentPages?.[message.id]?.hasEarlier}
                    paging={
                      history.loadingCommentsFor === '*' ||
                      history.loadingCommentsFor === message.id
                    }
                    onNext={() => history.loadCommentPage?.(message.id)}
                    onFirst={() => history.loadCommentPage?.(message.id, true)}
                  />
                ) : null}
              </div>
            </div>
            <MessageHoverActions
              messageId={message.id}
              content={visibleContent}
              longMessage={Boolean(messageMeta?.oversized)}
              createdAt={message.createdAt}
              speaker={speaker}
              isUser={message.role === 'user'}
              copyResult={copyFeedback?.messageId === message.id ? copyFeedback.result : undefined}
              onCopy={copyMessage}
              onFork={
                message.role === 'assistant' &&
                message.outputSnapshot?.canonical !== false &&
                message.state === 'complete' &&
                onForkSessionCreated
                  ? () =>
                      setForkPoint({
                        sourceSessionId: session.id,
                        messageId: message.id,
                        opening: onForkSessionStarted?.(),
                      })
                  : undefined
              }
              forkDisabled={
                snapshot?.forkBlocked !== false ||
                sending ||
                stopping ||
                responseInProgress ||
                loading
              }
            />
          </div>
          {message.role === 'assistant' && runActive && messageRun ? (
            <MessageResponseIndicator agentId={messageRun.agentId} />
          ) : pendingPeerAgentId ? (
            <MessageResponseIndicator agentId={pendingPeerAgentId} />
          ) : null}
        </div>
        {message.role === 'assistant' &&
        message.outputSnapshot?.canonical !== false &&
        messageRun?.collaboration &&
        !['starting', 'running', 'recovering'].includes(messageRun.status) ? (
          <CollaborationReview
            session={session}
            run={messageRun}
            latestRunId={latestRun?.id}
            disabled={disabled || responseInProgress}
            onOpenPlan={openRecordedPlan}
            onOpenProjectFile={openProjectFile}
            onCreateReportComment={
              recoveryLocked || inputTakeover ? undefined : handleCreatePlanComment
            }
            feedbackDraft={feedbackDraft}
            onTaskChange={() => setPlanRefresh((value) => value + 1)}
            revealReport={revealReport}
            revealReportRequestId={revealReportRequestId}
            revealReportBasis={
              messageNavigation?.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : undefined
            }
            revealReportOffset={
              gapRestoreRef.current?.selection?.startOffset ?? messageNavigation?.startOffset
            }
            onReportReady={handlePlanReady}
            renderedMessageId={message.id}
          />
        ) : null}
        {message.role === 'assistant' &&
        message.outputSnapshot?.canonical !== false &&
        messageRun?.peerProposal &&
        messageRun.status === 'completed' &&
        messageRun.peerProposal.state === 'pending' ? (
          <PeerProposalAction
            proposal={messageRun.peerProposal}
            requester={messageRun.agentId}
            disabled={disabled}
            onAccept={onAcceptPeerProposal}
            onDismiss={onDismissPeerProposal}
          />
        ) : null}
      </article>
    )
  }

  const commentEditorView = commentEditor ? (
    <section
      className="rounded-card border border-border bg-surface-raised p-3"
      aria-labelledby="comment-editor-title"
    >
      <header className="flex items-start justify-between gap-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-control bg-status-info-muted text-status-info-foreground">
            <MessageSquarePlus aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id="comment-editor-title" className="text-caption font-medium text-primary">
              {commentEditor.commentId ? 'Edit comment' : 'New comment'}
            </h2>
            <p
              className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-secondary"
              title={commentEditor.quote}
            >
              {commentSourceLabel(commentEditor.anchor)} · “{commentEditor.quote}”
            </p>
            {commentEditor.anchor.type === 'unavailable' ? (
              <p className="mt-1 text-caption text-secondary">{commentEditor.anchor.reason}</p>
            ) : null}
          </div>
        </div>
        <button
          className="grid size-7 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          aria-label="Close Comment editor"
          title="Close"
          disabled={recoveryLocked}
          onClick={() => setCommentEditor(undefined)}
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      <div className="mt-2 flex items-end gap-2 rounded-control bg-surface-muted p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        <textarea
          ref={commentTextareaRef}
          className="field-sizing-content min-h-12 max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-body leading-relaxed text-primary outline-none placeholder:text-tertiary"
          value={commentEditor.body}
          placeholder="What should the Agent notice?"
          aria-label="Comment"
          disabled={recoveryLocked}
          onChange={(event) => setCommentEditor({ ...commentEditor, body: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setCommentEditor(undefined)
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void saveComment()
            }
          }}
        />
        <button
          className="h-8 shrink-0 rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={!commentEditor.body.trim() || disabled || savingComment}
          onClick={() => void saveComment()}
        >
          {savingComment ? 'Adding…' : 'Add to comment'}
        </button>
      </div>
      <p className="mt-2.5 px-1 text-caption text-tertiary">
        Enter to add · Shift+Enter for a new line
      </p>
    </section>
  ) : null
  const commentDraftsView = (
    <>
      {draftComments.length > 0 ? (
        <div
          className="flex max-h-20 w-full flex-wrap gap-1.5 overflow-y-auto px-2 pt-1"
          aria-label="Attached Comment drafts"
        >
          {draftComments.map((comment) => (
            <span
              key={comment.id}
              className={`inline-flex max-w-64 items-center gap-1 rounded-pill bg-status-info-muted px-2.5 py-1 text-caption text-status-info-foreground ${recoveryLocked ? 'opacity-55' : ''}`}
            >
              <button
                className="truncate text-left"
                type="button"
                title={
                  comment.anchor.type === 'unavailable'
                    ? `${comment.anchor.reason}\n${comment.body}`
                    : comment.body
                }
                disabled={recoveryLocked}
                onClick={() =>
                  setCommentEditor({
                    commentId: comment.id,
                    draftId: crypto.randomUUID(),
                    anchor: comment.anchor,
                    quote: comment.anchor.quote,
                    body: comment.body,
                  })
                }
              >
                {commentSourceLabel(comment.anchor)} · {comment.body}
              </button>
              {comment.anchor.type !== 'unavailable' ? (
                <button
                  type="button"
                  aria-label="Return to Comment source"
                  title="Return to source"
                  disabled={recoveryLocked}
                  onClick={() => onOpenComment(comment)}
                  className="grid size-6 shrink-0 place-items-center rounded-control hover:bg-status-info/15 focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <CornerUpLeft aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
              <button
                className="grid size-4 shrink-0 place-items-center rounded-full hover:bg-status-info/15"
                type="button"
                aria-label="Remove Comment draft"
                disabled={disabled}
                onClick={() => void onRemoveCommentDraft(comment.id)}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {history.draftPage?.hasMore || history.draftPage?.hasEarlier ? (
        <div
          aria-label="Comment draft pages"
          className="flex gap-2 px-2 text-caption text-secondary"
        >
          {history.draftPage.hasEarlier ? (
            <button
              type="button"
              disabled={history.draftsLoading}
              onClick={history.firstDraftPage}
              className="min-h-7 rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              First drafts
            </button>
          ) : null}
          {history.draftPage.hasMore ? (
            <button
              type="button"
              disabled={history.draftsLoading}
              onClick={history.loadMoreDrafts}
              className="min-h-7 rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              More drafts
            </button>
          ) : null}
        </div>
      ) : null}
    </>
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
                        author: planningTask.owner,
                        content: '',
                        document: planningTask.planReference.document,
                        sessionId: session.id,
                        status: currentPlan.planSync
                          ? currentPlan.planSync.kind === 'response'
                            ? 'Response awaiting recovery'
                            : 'Newer revision not synced'
                          : planningTask.status === 'running'
                            ? {
                                plan: 'Updating plan',
                                plan_review: 'Under review',
                                implement: 'Implementing',
                                code_review: 'Reviewing changes',
                                respond: 'Responding to review',
                                repair: 'Repairing changes',
                                reply: 'Replying to your message',
                              }[planningTask.stage]
                            : planningTask.status === 'complete'
                              ? 'Completed'
                              : planningTask.automation === 'paused'
                                ? 'Paused'
                                : planningTask.status === 'ready'
                                  ? 'Ready to implement'
                                  : planningTask.stage === 'plan_review'
                                    ? 'Awaiting revision'
                                    : 'Awaiting review',
                      }
                    : undefined
              }
              source={Boolean(planSourceKey)}
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
      {planAvailable ? (
        <div className="flex shrink-0 justify-end px-section pt-2">
          <button
            ref={planRestoreFocusRef}
            type="button"
            onClick={() => {
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
            }}
            className="inline-flex min-h-8 items-center gap-2 rounded-control px-2 text-caption font-medium text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
          >
            <BookOpen aria-hidden="true" className="size-4" strokeWidth={1.75} /> Plan
          </button>
        </div>
      ) : null}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The focusable Transcript region uses native wheel and keyboard scrolling. */}
      <section
        ref={transcriptRef}
        data-pact-transcript
        // Keyboard focus lets PageUp/PageDown/Home/End operate the scroll region.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Conversation messages"
        className="min-h-0 flex-1 overflow-auto px-section py-section focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
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
          {history.pageError ? (
            <div
              className="mb-group flex items-center justify-center gap-2 text-caption text-danger"
              role="alert"
            >
              <span>{history.pageError}</span>
              {history.pageError ? (
                <button
                  className="font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
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
              ) : null}
            </div>
          ) : null}
          {loading && !snapshot ? (
            <div className="space-y-group" aria-busy="true">
              <div className="h-20 animate-pulse rounded-message bg-surface-muted" />
              <div className="ml-auto h-16 w-3/4 animate-pulse rounded-message bg-surface-muted" />
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
                      className="pb-2"
                    >
                      {renderRow(row)}
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
                Start with {primaryName}
              </h2>
              <p className="mx-auto mt-1 max-w-[46ch] text-caption leading-relaxed text-secondary">
                Work with your Agent in this Project. This conversation will be saved.
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
                className="min-h-8 rounded-control px-2.5 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                type="button"
                disabled={history.loadingPage}
                onClick={() => void loadLatest()}
              >
                {history.loadingPage ? 'Loading latest messages…' : 'Jump to latest'}
              </button>
            </div>
          ) : null}
          {hasNewerHistory && history.pageError ? (
            <p className="mt-1 text-center text-caption text-danger" role="alert">
              {history.pageError}
            </p>
          ) : null}

          {history.readError ? (
            <p className="mt-group flex items-center gap-2 text-caption text-danger" role="alert">
              <span>{history.readError}</span>
              <button
                className="min-h-8 font-medium hover:underline disabled:opacity-50"
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

      <div className="shrink-0 px-section py-group">
        <div className={`mx-auto flex ${CONVERSATION_WIDTH} flex-col gap-2`}>
          {sessionIssues && sessionIssues.agents.length > 0 ? (
            <SessionWarningCard
              value={sessionIssues}
              enabled={agentActionsEnabled}
              onRetry={(issue) =>
                issue.action === 'inspect_rebuild'
                  ? onRebuildNativeContext(issue.agentId, {
                      intent: 'inspect',
                      clientOperationId: issue.rebuildId,
                      expectedGeneration: issue.generation,
                    })
                  : onCheckNativeContext(issue.agentId)
              }
              onRebuild={(issue, operationId) =>
                onRebuildNativeContext(issue.agentId, {
                  intent: 'create',
                  clientOperationId: operationId,
                  expectedGeneration: issue.generation,
                  ...(issue.nativeSessionId
                    ? { expectedNativeSessionId: issue.nativeSessionId }
                    : {}),
                  expectedRunId: issue.runId ?? null,
                  expectedRebuildId: issue.rebuildId ?? null,
                  abandon: issue.abandon,
                })
              }
            />
          ) : null}
          {queue && queueActions ? (
            <QueueMessageBar
              queue={queue}
              pending={queueActions.pending}
              disabled={composerDisabled || sending || stopping}
              canSteer={!inputTakeover && canSteerQueuedInput}
              steerUnavailableReason={
                inputTakeover ? 'Answer the current questions first.' : steerUnavailableReason
              }
              respondingAgentId={respondingAgentId}
              onSteer={queueActions.steer}
              onRemove={queueActions.remove}
              onEdit={inputTakeover ? undefined : () => returnQueueMessageToComposer(false)}
              onResume={queueActions.resume}
              onSetEnabled={queueActions.setEnabled}
              onCheckStatus={
                queuedInput?.state === 'unknown' && queuedInput.delivery
                  ? queueActions.checkStatus
                  : undefined
              }
            />
          ) : null}
          <InputReplacement
            key={session.id}
            replacement={
              nativeQuestions.length
                ? {
                    key: `native:${nativeQuestions.map(({ request }) => `${request.operationId}:${request.id}`).join(':')}`,
                    content: (
                      <div className="max-h-[min(60vh,36rem)] space-y-2 overflow-auto">
                        {nativeQuestions.map(({ agentId, request }) => (
                          <NativeInputCard
                            key={`${request.operationId}:${request.id}`}
                            request={request}
                            agentId={agentId}
                            onRespond={onRespondNativeInput}
                            draft={nativeInputDrafts[request.id]}
                            onDraftChange={onNativeInputDraftChange}
                          />
                        ))}
                      </div>
                    ),
                  }
                : decisionTakeover && decisionSource
                  ? {
                      key: planRecovery
                        ? `recovery:${planRecovery.runId}`
                        : decisionReply
                          ? `question:${decisionKey}`
                          : `processing:${decisionKey}`,
                      content: planRecovery ? (
                        <section
                          aria-label="Plan recovery required"
                          className="rounded-control border border-border bg-surface-muted px-group py-panel text-caption"
                        >
                          <p className="font-medium text-primary">Plan recovery required</p>
                          <p className="mt-1 text-secondary">
                            Restore the saved plan using the recovery action above. Your previous
                            answers and message draft are kept.
                          </p>
                        </section>
                      ) : decisionReply ? (
                        <div className="space-y-2">
                          {inputGateState === 'incomplete' ? (
                            <p role="status" className="px-group text-caption text-secondary">
                              {incompleteCanAnswer
                                ? 'Your previous reply was not confirmed. You can send a follow-up answer.'
                                : 'Your previous reply needs recovery before another answer can be sent.'}
                            </p>
                          ) : null}
                          <CollaborationQuestionCard
                            key={decisionKey}
                            sessionId={session.id}
                            runId={decisionSource.runId}
                            messageId={decisionMessageId}
                            actor={
                              decisionSource.actor ?? runsById.get(decisionSource.runId)?.agentId
                            }
                            decision={decisionReply}
                            draft={history.decisionDraft}
                            onDraftChange={history.setDecisionDraft}
                            onClearDraft={history.clearDecisionDraft}
                            onSubmit={() => void submitAnswers()}
                            canSubmit={decisionAnswersReady}
                            disabled={questionDisabled}
                            onOpenProjectFile={openProjectFile}
                          />
                        </div>
                      ) : (
                        <section
                          aria-label="Answer progress"
                          className="flex items-center gap-group rounded-control border border-border bg-surface-muted px-group py-panel text-caption"
                        >
                          <LoaderCircle
                            aria-hidden="true"
                            className="size-4 shrink-0 animate-spin text-secondary motion-reduce:animate-none"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-primary">
                              {inputGateState === 'queued'
                                ? 'Answers queued'
                                : responseInProgress
                                  ? 'Processing your answers'
                                  : 'Answers sent'}
                            </p>
                            <p className="mt-1 text-secondary">
                              Your message draft is kept until these questions are resolved.
                            </p>
                          </div>
                          {responseInProgress ? (
                            <button
                              type="button"
                              disabled={stopping}
                              onClick={() => void onStop()}
                              className="min-h-8 rounded-control px-3 font-medium text-primary hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
                            >
                              {stopping ? 'Stopping…' : 'Stop'}
                            </button>
                          ) : null}
                        </section>
                      ),
                    }
                  : undefined
            }
          >
            <div className="flex flex-col gap-2">
              {!planPanelExpanded ? commentEditorView : null}
              {skillComposer.warning ? (
                <div
                  id={`skill-warning-${session.id}`}
                  role="alert"
                  className="flex items-start gap-2 rounded-control border border-status-danger/30 bg-status-danger-muted px-3 py-2 text-caption text-status-danger-foreground"
                >
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                    strokeWidth={1.75}
                  />
                  <span>{skillComposer.warning}</span>
                </div>
              ) : null}
              {queue?.returnedInput &&
              queueActions &&
              (composerReturnedInputOperationId !== queue.returnedInput.operationId ||
                (!composer && !composerImages.length && !draftComments.length)) ? (
                <div
                  className="flex min-h-8 flex-wrap items-center gap-2 px-2 text-caption text-secondary"
                  role="status"
                >
                  <span>Returned message available</span>
                  <button
                    type="button"
                    className="min-h-7 rounded-control px-2 font-medium text-primary hover:bg-surface-muted disabled:opacity-40"
                    disabled={composerDisabled || sending || stopping || queueActions.pending}
                    title="Replace the current draft with the returned message"
                    onClick={() => void returnQueueMessageToComposer(true)}
                  >
                    {history.restoringInput ? 'Restoring message…' : 'Restore returned message'}
                  </button>
                </div>
              ) : null}
              <div
                className={`relative flex flex-col gap-1.5 rounded-card border border-border bg-surface-raised p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus ${recoveryLocked ? 'opacity-60' : ''} ${imageDropActive ? 'outline-2 outline-focus outline-offset-4' : ''}`}
                onDragEnter={(event) => {
                  if (
                    !composerDisabled &&
                    !inputTakeover &&
                    event.dataTransfer.types.includes('Files')
                  ) {
                    event.preventDefault()
                    setImageDropActive(true)
                  }
                }}
                onDragOver={(event) => {
                  if (
                    !composerDisabled &&
                    !inputTakeover &&
                    event.dataTransfer.types.includes('Files')
                  ) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'copy'
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget instanceof Node ? event.relatedTarget : null,
                    )
                  )
                    setImageDropActive(false)
                }}
                onDropCapture={(event) => {
                  setImageDropActive(false)
                  if (
                    event.dataTransfer.files.length &&
                    onAddComposerImages &&
                    !composerDisabled &&
                    !inputTakeover
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                    void onAddComposerImages([...event.dataTransfer.files])
                  }
                }}

                aria-disabled={recoveryLocked}
              >
                <div
                  ref={skillMenuRef}
                  id={`skills-${session.id}`}
                  role="listbox"
                  aria-label="Native Skills"
                  aria-hidden={!skillComposer.query}
                  aria-busy={skillComposer.loading}
                  inert={!skillComposer.query}
                  data-open={Boolean(skillComposer.query)}
                  className="pact-skill-menu absolute right-0 bottom-[calc(100%+8px)] left-0 z-30 min-h-32 max-h-80 overflow-y-auto rounded-panel border border-border bg-surface-raised p-1.5 shadow-lg"
                >
                  {skillComposer.pactOptions.length > 0 ? (
                    <>
                      <p className="px-2.5 pt-2 pb-1 text-caption font-medium text-tertiary">
                        Pact
                      </p>
                      {skillComposer.pactOptions.map((entry) => {
                        const index = skillComposer.options.indexOf(entry)
                        return (
                          <button
                            key={entry.id}
                            id={`skill-${entry.id}`}
                            type="button"
                            role="option"
                            aria-selected={index === skillComposer.active}
                            className={`flex min-h-10 w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption ${index === skillComposer.active ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted'}`}
                            onMouseEnter={() => skillComposer.setActive(index, false)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => chooseSkill(entry)}
                          >
                            <BookOpen
                              aria-hidden="true"
                              className="size-4 shrink-0"
                              strokeWidth={1.75}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium text-primary">{entry.name}</span>
                              <span className="block text-tertiary">{entry.description}</span>
                            </span>
                            <span className="text-tertiary">Pact</span>
                          </button>
                        )
                      })}
                    </>
                  ) : null}
                  {skillComposer.agents.map((agent) => (
                    <Fragment key={agent}>
                      <p className="px-2.5 pt-2 pb-1 text-caption font-medium text-tertiary">
                        {agent === 'claude' ? 'Claude Code' : 'Codex'}
                      </p>
                      {skillComposer.visibleOptions
                        .filter((entry) => entry.agentId === agent)
                        .map((entry) => {
                          const index = skillComposer.options.indexOf(entry)
                          return (
                            <button
                              key={entry.id}
                              id={`skill-${entry.id}`}
                              type="button"
                              role="option"
                              aria-selected={index === skillComposer.active}
                              className={`flex min-h-10 w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption ${index === skillComposer.active ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted'}`}
                              onMouseEnter={() => skillComposer.setActive(index, false)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                chooseSkill(entry)
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-primary">
                                  /{entry.name}
                                  {entry.argumentHint ? (
                                    <span className="ml-2 font-normal text-tertiary">
                                      {entry.argumentHint}
                                    </span>
                                  ) : null}
                                </span>
                                <span
                                  className="block truncate text-tertiary"
                                  title={entry.description}
                                >
                                  {entry.description}
                                </span>
                              </span>
                              <span className="shrink-0 text-tertiary">
                                {entry.source === 'native'
                                  ? 'Native'
                                  : entry.source[0]!.toUpperCase() + entry.source.slice(1)}
                              </span>
                            </button>
                          )
                        })}
                      {skillComposer.errors[agent] ? (
                        <p className="px-2.5 py-2 text-caption text-secondary">
                          {skillComposer.errors[agent]}
                        </p>
                      ) : null}
                      {!skillComposer.loading &&
                      !skillComposer.errors[agent] &&
                      !skillComposer.pages[agent]?.skills.length ? (
                        <p className="px-2.5 py-2 text-caption text-tertiary">
                          No matching Skills.
                        </p>
                      ) : null}
                      {skillComposer.canPrevious(agent) || skillComposer.canMore(agent) ? (
                        <div className="flex items-center justify-between gap-2 px-2.5 py-1">
                          {skillComposer.canPrevious(agent) ? (
                            <button
                              type="button"
                              className="min-h-8 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted disabled:opacity-50"
                              aria-label={`Previous ${agent === 'claude' ? 'Claude Code' : 'Codex'} Skills`}
                              disabled={skillComposer.loading}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                composerRef.current?.focus()
                                void skillComposer.more(agent, true)
                              }}
                            >
                              Previous Skills
                            </button>
                          ) : (
                            <span />
                          )}
                          <span role="status" className="text-caption text-tertiary">
                            {skillComposer.rangeLabel(agent)}
                          </span>
                          {skillComposer.canMore(agent) ? (
                            <button
                              type="button"
                              className="min-h-8 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted disabled:opacity-50"
                              aria-label={`More ${agent === 'claude' ? 'Claude Code' : 'Codex'} Skills`}
                              disabled={skillComposer.loading}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                composerRef.current?.focus()
                                void skillComposer.more(agent)
                              }}
                            >
                              More Skills
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                  {skillComposer.loading && skillComposer.options.length === 0 ? (
                    <p
                      role="status"
                      className="flex items-center gap-2 px-2.5 py-2 text-caption text-tertiary"
                    >
                      <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                      Loading native Skills…
                    </p>
                  ) : null}
                </div>
                {mentionListOpen ? (
                  <div
                    id={mentionListId}
                    className="absolute right-0 bottom-[calc(100%+8px)] left-0 z-20 overflow-hidden rounded-panel border border-border bg-surface-raised p-1.5 shadow-lg"
                    role="listbox"
                    aria-label="Message recipients"
                  >
                    {filteredMentionOptions.map((option, index) => {
                      const Icon = option.icon
                      const active = index === activeMentionIndex
                      return (
                        <button
                          id={`${mentionListId}-${option.token.slice(1)}`}
                          key={option.token}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 text-left text-caption ${active ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted/70 hover:text-primary'}`}
                          onMouseEnter={() => setActiveMentionIndex(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseMention(option)}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-primary">{option.label}</span>
                            <span className="ml-2 text-caption text-tertiary">
                              {option.description}
                            </span>
                          </span>
                          <span className="font-mono text-caption text-tertiary">
                            {option.token}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                {!planPanelExpanded ? commentDraftsView : null}
                {returnedInput ? (
                  <div className="mb-2 flex flex-wrap items-center gap-2 px-2 text-caption text-secondary">
                    <span>
                      {history.restoringInput
                        ? 'Restoring unsent message…'
                        : returnedInput.state === 'installed' &&
                            (composer || composerImages.length || draftComments.length)
                          ? 'Unsent message restored'
                          : 'Previous unsent message is available'}
                    </span>
                    <span>
                      ·{' '}
                      {returnedInput.route.type === 'all'
                        ? `${returnedInput.route.firstAgentId === 'codex' ? 'Codex' : 'Claude Code'} → ${returnedInput.route.secondAgentId === 'codex' ? 'Codex' : 'Claude Code'}`
                        : returnedInput.route.agentId === 'codex'
                          ? 'Codex'
                          : 'Claude Code'}
                    </span>
                    {returnedInput.state === 'pending' ||
                    (!composer &&
                      !composerImages.length &&
                      !hasDecisionAnswers(history.decisionDraft)) ? (
                      <>
                        <button
                          type="button"
                          className="rounded-control px-2 py-1 text-primary hover:bg-surface-muted disabled:opacity-40"
                          disabled={Boolean(
                            composer ||
                            hasDecisionAnswers(history.decisionDraft) ||
                            composerImages.length ||
                            composerMention ||
                            draftComments.some(
                              (comment) => !returnedInput.commentIds.includes(comment.id),
                            ) ||
                            history.restoringInput ||
                            history.draftsLoading,
                          )}
                          onClick={() => void history.restoreReturnedInput?.()}
                        >
                          Restore to input
                        </button>
                        {returnedInput.state === 'pending' ? (
                          <button
                            type="button"
                            className="rounded-control px-2 py-1 hover:bg-surface-muted disabled:opacity-40"
                            disabled={Boolean(history.restoringInput)}
                            onClick={() => void history.discardReturnedInput?.()}
                          >
                            Dismiss
                          </button>
                        ) : null}
                        {returnedInput.state === 'pending' &&
                        (composer ||
                          composerImages.length ||
                          composerMention ||
                          draftComments.length) ? (
                          <span>
                            Keep your current draft. Sending it replaces the previous input.
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
                <ConversationImages
                  sessionId={session.id}
                  images={composerImages}
                  draft
                  disabled={composerDisabled}
                  onOpen={(image) => openImageGallery(composerImages, image)}
                  onRemove={onRemoveComposerImage}
                />
                <div className="flex w-full flex-col gap-1">
                  <ComposerEditor
                    editorRef={composerRef}
                    value={editorValue}
                    onChange={acceptComposerDocument}
                    admitEdit={history.admitComposerEdit}
                    onCursor={cursorChanged}
                    onSkillOpen={(skill) => onOpenSkillDocument?.(skill)}
                    onNotice={onNotice}
                    onImages={
                      onAddComposerImages ? (files) => void onAddComposerImages(files) : undefined
                    }
                    expanded={mentionListOpen || Boolean(skillComposer.query)}
                    controls={
                      skillComposer.query
                        ? `skills-${session.id}`
                        : mentionListOpen
                          ? mentionListId
                          : undefined
                    }
                    describedBy={skillComposer.warning ? `skill-warning-${session.id}` : undefined}
                    activeDescendant={
                      skillComposer.query && skillComposer.options[skillComposer.active]
                        ? `skill-${skillComposer.options[skillComposer.active]!.id}`
                        : activeMentionId
                    }
                    placeholder={
                      history.draftError
                        ? 'Comments unavailable'
                        : history.draftsLoading
                          ? 'Loading saved comments…'
                          : agentActionsEnabled
                            ? 'What should we tackle next?'
                            : 'Agent actions are paused'
                    }
                    disabled={composerDisabled || inputTakeover}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void submit()
                        return
                      }
                      const editingDocument = composerRef.current?.document() ?? editorValue
                      const selectedMention = editingDocument.mention
                      const range = composerRef.current?.selection() ?? { start: 0, end: 0 }
                      if (skillComposer.query) {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          skillComposer.close()
                          return
                        }
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          const next = skillComposer.active + (event.key === 'ArrowDown' ? 1 : -1)
                          const current = skillComposer.options[skillComposer.active]
                          if (
                            event.key === 'ArrowUp' &&
                            current &&
                            current.agentId !== 'pact' &&
                            (skillComposer.pages[current.agentId]?.startOffset ?? 0) > 0 &&
                            skillComposer.options[next]?.agentId !== current.agentId
                          ) {
                            void skillComposer.more(current.agentId, true)
                            return
                          }
                          if (
                            event.key === 'ArrowDown' &&
                            current &&
                            current.agentId !== 'pact' &&
                            skillComposer.pages[current.agentId]?.nextOffset != null &&
                            skillComposer.options[next]?.agentId !== current.agentId
                          )
                            void skillComposer.more(current.agentId)
                          else if (next >= skillComposer.options.length && skillComposer.hasMore)
                            void skillComposer.more()
                          else
                            skillComposer.setActive(
                              Math.max(0, Math.min(skillComposer.options.length - 1, next)),
                            )
                          return
                        }
                        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                          // Keep keyboard intent in the Composer while a filtered page is arriving.
                          event.preventDefault()
                          const entry = skillComposer.options[skillComposer.active]
                          if (entry) {
                            chooseSkill(entry)
                          }
                          return
                        }
                      }
                      if (
                        selectedMention &&
                        range.start === range.end &&
                        ((event.key === 'Backspace' && range.start === selectedMention.end) ||
                          (event.key === 'Delete' && range.start === selectedMention.start))
                      ) {
                        event.preventDefault()
                        const trailingSpace =
                          editingDocument.text[selectedMention.end] === ' ' ? 1 : 0
                        const next = `${editingDocument.text.slice(0, selectedMention.start)}${editingDocument.text.slice(selectedMention.end + trailingSpace)}`
                        const cursor = selectedMention.start
                        updateComposer(next, cursor, [
                          {
                            start: selectedMention.start,
                            end: selectedMention.end + trailingSpace,
                            text: '',
                          },
                        ])
                        setMentionQuery(undefined)
                        return
                      }
                      if (mentionQuery && filteredMentionOptions.length > 0) {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          const direction = event.key === 'ArrowDown' ? 1 : -1
                          setActiveMentionIndex(
                            (index) =>
                              (index + direction + filteredMentionOptions.length) %
                              filteredMentionOptions.length,
                          )
                          return
                        }
                        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                          event.preventDefault()
                          const option = filteredMentionOptions[activeMentionIndex]
                          if (option) chooseMention(option)
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setMentionQuery(undefined)
                          return
                        }
                      }
                      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        if (responseInProgress && !queueEnabled && !unfinishedTask) return
                        event.preventDefault()
                        void submit()
                      }
                    }}
                  />
                  <div className="flex items-center justify-between">
                    {onChooseComposerImages ? (
                      <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-40"
                        aria-label="Add images"
                        title="Add images · paste or drop also works"
                        disabled={composerDisabled || choosingImages}
                        aria-busy={choosingImages}
                        onClick={() => void onChooseComposerImages()}
                      >
                        {choosingImages ? (
                          <LoaderCircle
                            className="size-4 animate-spin"
                            aria-hidden="true"
                            strokeWidth={1.75}
                          />
                        ) : (
                          <ImagePlus className="size-4" aria-hidden="true" strokeWidth={1.75} />
                        )}
                      </button>
                    ) : null}
                    {sendWhileWorking ? (
                      <button
                        type="button"
                        aria-label={`Stop ${respondingAgentId === 'claude' ? 'Claude Code' : 'Codex'} response`}
                        title="Stop current response"
                        disabled={stopping}
                        onClick={() => void onStop()}
                        className="ml-auto grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
                      >
                        <Square
                          aria-hidden="true"
                          className="size-3.5"
                          fill="currentColor"
                          strokeWidth={1.5}
                        />
                      </button>
                    ) : null}
                    <button
                      className={`${sendWhileWorking ? '' : 'ml-auto '}grid size-9 shrink-0 cursor-pointer place-items-center rounded-control bg-surface-inverse text-inverse hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-40`}
                      type="button"
                      aria-label={composerActionLabel}
                      title={composerActionLabel}
                      disabled={
                        stopComposerAction
                          ? stopping
                          : disabled ||
                            (!composerContentReady &&
                              draftComments.length === 0 &&
                              composerImages.length === 0)
                      }
                      onClick={() => void (stopComposerAction ? onStop() : submit())}
                    >
                      {stopping ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="size-4 animate-spin"
                          strokeWidth={1.8}
                        />
                      ) : stopComposerAction ? (
                        <Square
                          aria-hidden="true"
                          className="size-3.5"
                          fill="currentColor"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <ArrowUp aria-hidden="true" className="size-4" strokeWidth={1.9} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <div className="pact-composer-controls flex min-w-0 items-center gap-2">
                {onSaveSessionPermission ? (
                  <>
                    {(['claude', 'codex'] as const).map((agent) => (
                      <div
                        key={`${session.id}-${agent}`}
                        role="group"
                        aria-label={`${agent === 'claude' ? 'Claude Code' : 'Codex'} settings`}
                        className="pact-agent-controls text-caption"
                      >
                        <PermissionMenu
                          session={session}
                          agent={agent}
                          run={activeRun ?? latestRun}
                          busy={responseInProgress}
                          disabled={sessionSettingsSaving}
                          visible={visible && !nativePresentationSuspended && !inputTakeover}
                          onSave={onSaveSessionPermission}
                          onNotice={onNotice}
                        />
                        {onSaveSessionSpeed ? (
                          <>
                            <span className="pact-agent-divider" aria-hidden="true" />
                            <SpeedMenu
                              session={session}
                              agent={agent}
                              run={activeRun ?? latestRun}
                              busy={responseInProgress}
                              disabled={sessionSettingsSaving}
                              visible={visible && !nativePresentationSuspended && !inputTakeover}
                              onSave={onSaveSessionSpeed}
                              onNotice={onNotice}
                            />
                          </>
                        ) : null}
                      </div>
                    ))}
                  </>
                ) : null}
                <ProjectContextMenu
                  key={`${session.id}-${session.projectId}`}
                  projectId={session.projectId}
                  platform={platform}
                  visible={visible && !inputTakeover}
                  refreshKey={`${latestRun?.id ?? ''}:${latestRun?.status ?? ''}`}
                  onNotice={onNotice}
                />
              </div>
              {history.draftError && snapshot ? (
                <p
                  className="flex items-center gap-2 px-2 text-caption text-secondary"
                  role="alert"
                >
                  Couldn’t load comments.
                  <button
                    className="min-h-8 font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    type="button"
                    onClick={() => history.retryDrafts()}
                  >
                    Retry
                  </button>
                </p>
              ) : null}
            </div>
          </InputReplacement>
        </div>
      </div>
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

function ContextReceipt({
  count,
  target,
  accepted,
}: {
  count: number
  target: AgentRun['agentId']
  accepted: boolean
}): React.JSX.Element {
  const source = target === 'claude' ? 'Codex' : 'Claude Code'
  return (
    <p className="mt-1 text-caption text-tertiary">
      {accepted ? 'Context supplied' : 'Context prepared'} · {count}{' '}
      {count === 1 ? 'message' : 'messages'} involving {source}
    </p>
  )
}

function MessageResponseIndicator({ agentId }: { agentId: RuntimeAgentId }): React.JSX.Element {
  const name = agentId === 'claude' ? 'Claude Code' : 'Codex'
  return (
    <div className="mt-1.5 flex justify-center">
      <span
        className={`inline-flex h-5 items-center gap-1 rounded-pill px-2 text-secondary ${agentId === 'claude' ? 'bg-speaker-claude' : 'bg-speaker-codex'}`}
        role="status"
        aria-label={`${name} is responding`}
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            aria-hidden="true"
            className="size-1 rounded-full bg-current animate-[pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
      </span>
    </div>
  )
}

function PeerProposalAction({
  proposal,
  requester,
  disabled,
  onAccept,
  onDismiss,
}: {
  proposal: PeerRequestProposal
  requester: RuntimeAgentId
  disabled: boolean
  onAccept: (proposalId: string) => Promise<boolean>
  onDismiss: (proposalId: string) => Promise<boolean>
}): React.JSX.Element {
  const [working, setWorking] = useState<'accept' | 'dismiss' | undefined>()
  const requesterName = requester === 'claude' ? 'Claude Code' : 'Codex'
  const targetName = proposal.targetAgentId === 'claude' ? 'Claude Code' : 'Codex'
  const action =
    proposal.kind === 'fact_check'
      ? 'fact-check'
      : proposal.kind === 'supplement'
        ? 'follow-up'
        : proposal.kind
  return (
    <div className="mt-2 flex w-full min-w-0 flex-wrap items-center gap-2 rounded-control border border-status-info/25 bg-status-info-muted/45 px-3 py-2 text-caption">
      <MessageSquarePlus
        aria-hidden="true"
        className="size-4 shrink-0 text-status-info-foreground"
        strokeWidth={1.75}
      />
      <p className="min-w-48 flex-1 font-medium text-primary">
        {requesterName} suggests a {targetName} {action}.
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          className="h-7 cursor-pointer rounded-control bg-surface-inverse px-2.5 font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
          type="button"
          disabled={disabled || Boolean(working)}
          onClick={() => {
            setWorking('accept')
            void onAccept(proposal.id).finally(() => setWorking(undefined))
          }}
        >
          {working === 'accept' ? 'Sending…' : `Ask ${targetName}`}
        </button>
        <button
          className="h-7 cursor-pointer rounded-control px-2 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
          type="button"
          aria-label="Dismiss peer suggestion"
          disabled={disabled || Boolean(working)}
          onClick={() => {
            setWorking('dismiss')
            void onDismiss(proposal.id).finally(() => setWorking(undefined))
          }}
        >
          {working === 'dismiss' ? 'Dismissing…' : 'Not now'}
        </button>
      </div>
    </div>
  )
}

function RunWorkLog({
  runId,
  activities,
  active,
  completed = false,
  available,
  history,
  onRead,
}: {
  runId: string
  activities: AgentActivity[]
  active: boolean
  completed?: boolean
  available: boolean
  history: ConversationHistoryControls
  onRead: () => void
}): React.JSX.Element | null {
  const detailError =
    history.activityError?.runId === runId ? history.activityError.message : undefined
  if (!available && activities.length === 0 && !detailError) {
    return active ? (
      <output className="mt-2 flex items-center gap-2 text-caption text-secondary">
        <span className="primary-action-spinner" aria-hidden="true" />
        Working
      </output>
    ) : null
  }
  const viewing = history.window?.activityView?.runId === runId
  const truncated = viewing && Boolean(history.window?.activityView?.truncated)
  const loading = history.loadingActivityRunId === runId
  const canLoad = Boolean(detailError) || (available && !viewing && activities.length === 0)

  return (
    <div className="mt-1">
      {activities.length > 0 ? (
        <>
          <AgentActivityList
            key={completed ? 'complete' : 'pending'}
            activities={activities}
            active={active}
            defaultExpanded={
              viewing && (!completed || Boolean(history.window?.activityView?.manual))
            }
            preserveExpanded={viewing && Boolean(history.window?.activityView?.manual)}
            onExpandedChange={(expanded) => {
              if (expanded) onRead()
              history.setActivityReading?.(runId, expanded)
            }}
            partial={!viewing || truncated}
            truncationNotice={truncated ? 'Showing the latest 50 steps.' : undefined}
            oversizedActivities={history.oversizedActivities}
            expandedBody={history.expandedActivityBody}
            onLoadMoreBody={history.loadMoreActivityBody}
          />
        </>
      ) : null}
      {canLoad ? (
        <button
          className="min-h-8 text-caption text-secondary hover:text-primary disabled:opacity-50"
          type="button"
          disabled={loading}
          onClick={() => {
            onRead()
            void history.loadActivities(runId)
          }}
        >
          {loading ? 'Loading work log…' : detailError ? 'Retry work log' : 'Show work log'}
        </button>
      ) : null}
      {detailError ? (
        <p className="mt-1 text-caption text-danger" role="alert">
          {detailError}
        </p>
      ) : null}
    </div>
  )
}

const MessageHoverActions = memo(function MessageHoverActions({
  messageId,
  content,
  longMessage,
  createdAt,
  speaker,
  isUser,
  copyResult,
  onCopy,
  onFork,
  forkDisabled,
}: {
  messageId: string
  content: string
  longMessage: boolean
  createdAt: string
  speaker: string
  isUser: boolean
  copyResult: 'copying' | 'copied' | 'failed' | undefined
  onCopy: (messageId: string, content: string) => Promise<void>
  onFork?: (() => void) | undefined
  forkDisabled: boolean
}): React.JSX.Element {
  const date = new Date(createdAt)
  const fullDate = messageDateTimeFormatter.format(date)
  const copyLabel = longMessage
    ? 'Full copy is unavailable for long Messages'
    : copyResult === 'copying'
      ? 'Copying message'
      : copyResult === 'copied'
        ? 'Message copied'
        : copyResult === 'failed'
          ? 'Could not copy message'
          : `Copy ${speaker} message`

  return (
    <div
      className={`pointer-events-none mt-1 flex h-6 shrink-0 items-center gap-1 whitespace-nowrap text-caption text-tertiary opacity-0 transition-opacity delay-200 duration-150 ease-out-pact group-hover/message:delay-0 group-hover/message:opacity-100 group-focus-within/message:delay-0 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100 ${isUser ? 'self-end' : 'self-start'}`}
      data-pact-message-actions
    >
      <time dateTime={createdAt} title={fullDate} aria-label={fullDate} className="tabular-nums">
        {messageTimeFormatter.format(date)}
      </time>
      <button
        className="pointer-events-auto grid size-6 shrink-0 place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40"
        type="button"
        disabled={!content || copyResult === 'copying' || longMessage}
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => void onCopy(messageId, content)}
      >
        {copyResult === 'copied' ? (
          <Check aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
        ) : copyResult === 'failed' ? (
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
        ) : copyResult === 'copying' ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" strokeWidth={1.8} />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.8} />
        )}
      </button>
      {onFork ? (
        <button
          type="button"
          className="pointer-events-auto grid size-6 shrink-0 place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40"
          aria-label="Fork conversation from this reply"
          title={
            forkDisabled
              ? 'Wait for this session and native tasks to finish'
              : 'Fork conversation from this reply'
          }
          disabled={forkDisabled}
          onClick={onFork}
        >
          <Split aria-hidden="true" className="size-3.5 rotate-90" strokeWidth={1.8} />
        </button>
      ) : null}
      <output className="sr-only">
        {copyResult === 'copied' ? 'Message copied' : copyResult === 'failed' ? 'Copy failed' : ''}
      </output>
    </div>
  )
})

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function RunConfiguration({ run }: { run: AgentRun }): React.JSX.Element | null {
  const tooltipId = useId()
  const speed = run.observedSpeed
    ? run.observedSpeed === 'fast'
      ? 'Fast'
      : 'Standard speed'
    : run.speedDetail
      ? 'Native speed'
      : run.speed === 'fast'
        ? 'Fast requested'
        : run.speed === 'standard'
          ? 'Standard requested'
          : undefined
  const details = [run.model, run.effort, speed].filter((value): value is string => Boolean(value))
  if (!details.length) return null
  return (
    <span className="relative inline-flex min-w-0 items-center gap-1 font-normal text-tertiary">
      <span className="truncate">· {details.join(' · ')}</span>
      {run.speedDetail ? (
        <>
          <button
            type="button"
            aria-label="Speed information"
            aria-describedby={tooltipId}
            className="peer grid size-6 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </button>
          <span
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none invisible absolute left-0 top-[calc(100%+0.25rem)] z-30 w-80 max-w-[calc(100vw-2rem)] whitespace-normal break-words rounded-control border border-border bg-surface-raised px-3 py-2 text-left text-caption font-normal leading-relaxed text-primary opacity-0 shadow-popover transition-opacity duration-150 peer-hover:visible peer-hover:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100"
          >
            {run.speedDetail}
          </span>
        </>
      ) : null}
    </span>
  )
}
