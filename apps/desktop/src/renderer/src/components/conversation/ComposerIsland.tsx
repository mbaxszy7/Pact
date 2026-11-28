/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Composer autocomplete follows the ARIA listbox pattern; native select/options cannot insert inline Mention tokens. */
import {
  ArrowUp,
  BookOpen,
  Check,
  CornerUpLeft,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  AgentRun,
  AnchoredComment,
  CollaborationSession,
  CommentAnchor,
  NativeInputRespond,
  NativePermissionDecision,
  RuntimeAgentId,
  SchedulingState,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  SideChatSyncMainReceipt,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import type { ComposerDocument } from './composer-document'
import type { ComposerEditorHandle } from './ComposerEditor'
import type { ConversationViewProjection, nativeInputRequests } from './conversation-window'
import type { DraftImage } from './image-client'
import type { ProjectFileTarget } from './MessageMarkdown'
import type {
  ConversationComposerMention,
  ConversationFlow,
  ConversationHistoryControls,
  DecisionReplyContext,
} from './useConversation'
import type { ComposerEdit, ComposerSkillOption, useSkillComposer } from './useSkillComposer'

import { PreparedInputCard } from '../scheduling/PreparedInputCard'
import { RelayDecisionCard, type RelayDecisionPresentation } from '../scheduling/RelayDecisionCard'
import { RelayActivityIndicator } from '../settings/scheduling/RelayActivityIndicator'
import { InputReplacement } from '../ui/InputReplacement'
import { CollaborationQuestionCard } from './CollaborationQuestionCard'
import { ComposerEditor } from './ComposerEditor'
import {
  agentName,
  commentSourceLabel,
  CONVERSATION_WIDTH,
  type MentionOption,
  type MentionQuery,
} from './conversation-view-helpers'
import { ConversationImages } from './ConversationImages'
import { NativeInputCard } from './NativeInputCard'
import { PermissionMenu } from './PermissionMenu'
import { ProjectContextMenu } from './ProjectContextMenu'
import { QueueMessageBar } from './QueueMessageBar'
import { SessionWarningCard } from './SessionWarningCard'
import { SpeedMenu } from './SpeedMenu'
import { hasDecisionAnswers } from './useConversation'

export interface CommentEditorState {
  commentId?: string
  draftId: string
  anchor: CommentAnchor
  quote: string
  body: string
}

export function CommentEditorCard({
  editor,
  session,
  textareaRef,
  recoveryLocked,
  disabled,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  editor: CommentEditorState
  session: Pick<CollaborationSession, 'id' | 'parentSessionId'>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  recoveryLocked: boolean
  disabled: boolean
  saving: boolean
  onChange: (next: CommentEditorState) => void
  onSave: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  return (
    <section
      className="rounded-2xl border border-border bg-surface-raised p-3 shadow-sheet"
      aria-labelledby="comment-editor-title"
      data-pact-comment-editor
    >
      <header className="flex items-start justify-between gap-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-control bg-status-info-muted text-status-info-foreground">
            <MessageSquarePlus aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id="comment-editor-title" className="text-caption font-medium text-primary">
              {editor.commentId ? 'Edit comment' : 'New comment'}
            </h2>
            <p
              className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-secondary"
              title={editor.quote}
            >
              {commentSourceLabel(editor.anchor, session)} · “{editor.quote}”
            </p>
            {editor.anchor.type === 'unavailable' ? (
              <p className="mt-1 text-caption text-secondary">{editor.anchor.reason}</p>
            ) : null}
          </div>
        </div>
        <button
          className="pact-pressable grid size-7 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          aria-label="Close Comment editor"
          title="Close"
          disabled={recoveryLocked}
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      <div className="mt-2 flex items-end gap-2 rounded-xl bg-surface-muted p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        <textarea
          ref={textareaRef}
          className="field-sizing-content min-h-12 max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-body leading-relaxed text-primary outline-none placeholder:text-tertiary"
          value={editor.body}
          placeholder="What should the Agent notice?"
          aria-label="Comment"
          disabled={recoveryLocked}
          onChange={(event) => onChange({ ...editor, body: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void onSave()
            }
          }}
        />
        <button
          className="pact-pressable h-8 shrink-0 cursor-pointer rounded-xl bg-surface-inverse px-3 text-caption font-medium text-inverse hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          type="button"
          disabled={!editor.body.trim() || disabled || saving}
          onClick={() => void onSave()}
        >
          {editor.commentId
            ? saving
              ? 'Saving…'
              : 'Save comment'
            : saving
              ? 'Adding…'
              : 'Add comment'}
        </button>
      </div>
      <p className="mt-2.5 px-1 text-caption text-tertiary">
        {editor.commentId
          ? 'Enter to save · Shift+Enter for a new line'
          : 'Enter to add · Shift+Enter for a new line'}
      </p>
    </section>
  )
}

export function CommentDraftChips({
  draftComments,
  session,
  history,
  recoveryLocked,
  disabled,
  onEditComment,
  onOpenComment,
  onRemoveCommentDraft,
}: {
  draftComments: readonly AnchoredComment[]
  session: Pick<CollaborationSession, 'id' | 'parentSessionId'>
  history: ConversationHistoryControls
  recoveryLocked: boolean
  disabled: boolean
  onEditComment: (comment: AnchoredComment) => void
  onOpenComment: (comment: AnchoredComment) => void
  onRemoveCommentDraft: (commentId: string) => Promise<boolean>
}): React.JSX.Element {
  return (
    <>
      {draftComments.length > 0 ? (
        <div
          className="flex max-h-20 w-full flex-wrap gap-1.5 overflow-y-auto px-2 pt-1"
          aria-label="Attached Comment drafts"
        >
          {draftComments.map((comment) => {
            const collapsedQuote = comment.anchor.quote.replace(/\s+/gu, ' ').trim()
            const draftLabel =
              comment.body.trim() || (collapsedQuote ? `“${collapsedQuote}”` : 'Quoted selection')
            return (
              <span
                key={comment.id}
                className={`inline-flex max-w-64 items-center gap-1 rounded-pill bg-status-info-muted px-2.5 py-1 text-caption text-status-info-foreground ${recoveryLocked ? 'opacity-55' : ''}`}
              >
                <button
                  className="cursor-pointer truncate text-left"
                  type="button"
                  title={
                    comment.anchor.type === 'unavailable'
                      ? `${comment.anchor.reason}${comment.body ? `\n${comment.body}` : ''}`
                      : comment.body.trim() || comment.anchor.quote
                  }
                  disabled={recoveryLocked}
                  onClick={() => onEditComment(comment)}
                >
                  {commentSourceLabel(comment.anchor, session)} · {draftLabel}
                </button>
                {comment.anchor.type !== 'unavailable' ? (
                  <button
                    type="button"
                    aria-label="Return to Comment source"
                    title="Return to source"
                    disabled={recoveryLocked}
                    onClick={() => onOpenComment(comment)}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-control hover:bg-status-info/15 focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <CornerUpLeft aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
                <button
                  className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-status-info/15"
                  type="button"
                  aria-label="Remove Comment draft"
                  disabled={disabled}
                  onClick={() => void onRemoveCommentDraft(comment.id)}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            )
          })}
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
              className="min-h-7 cursor-pointer rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              First drafts
            </button>
          ) : null}
          {history.draftPage.hasMore ? (
            <button
              type="button"
              disabled={history.draftsLoading}
              onClick={history.loadMoreDrafts}
              className="min-h-7 cursor-pointer rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              More drafts
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export interface ComposerIslandProps {
  session: CollaborationSession
  snapshot?: ConversationViewProjection | undefined
  history: ConversationHistoryControls
  visible: boolean
  isSideChat: boolean
  platform?: string | undefined
  planPanelExpanded: boolean
  nativePresentationSuspended: boolean
  schedulingState?: SchedulingState | undefined
  visibleSessionIssues?: ConversationViewProjection['sessionIssues']
  queuedBackgroundAgent?: RuntimeAgentId | undefined
  stoppingBackgroundAgent?: RuntimeAgentId | undefined
  stoppingBackgroundInQueue: boolean
  waitingBackgroundIssue?:
    | NonNullable<ConversationViewProjection['sessionIssues']>['agents'][number]
    | undefined
  activeRun?: AgentRun | undefined
  latestRun?: AgentRun | undefined
  runsById: ReadonlyMap<string, AgentRun>
  activePair: readonly [RuntimeAgentId, RuntimeAgentId]
  primaryName: string
  secondaryName: string
  respondingAgentId?: RuntimeAgentId | undefined
  responseInProgress: boolean
  continuationBlocked: boolean
  agentActionsEnabled: boolean
  effectiveMainSyncEnabled: boolean
  sideChatSettingsState?: 'loading' | 'error' | undefined
  composerDisabled: boolean
  disabled: boolean
  commonComposerBlocked: boolean
  mainSyncComposerBlocked: boolean
  recoveryLocked: boolean
  sending: boolean
  stopping: boolean
  showStop: boolean
  stopLabel: string
  showSend: boolean
  hasDraft: boolean
  isBtwReady: boolean
  btwSubmitting: boolean
  isMainRoute: boolean
  hasUnfinishedTask: boolean
  hasReplacement: boolean
  queueEnabled: boolean
  canSteerQueuedInput: boolean
  steerUnavailableReason: string
  inputTakeover: boolean
  decisionTakeover: boolean
  decisionSource?:
    | {
        runId: string
        actor?: RuntimeAgentId | undefined
        messageId?: string | undefined
      }
    | undefined
  decisionKey?: string | undefined
  decisionMessageId?: string | undefined
  decisionReply?: DecisionReplyContext | undefined
  decisionAnswersReady: boolean
  inputGateState?: string | undefined
  incompleteCanAnswer: boolean
  questionDisabled: boolean
  planRecovery?: { runId: string } | undefined
  nativeRequests: ReadonlyArray<ReturnType<typeof nativeInputRequests>[number]>
  nativeQuestions: ReadonlyArray<ReturnType<typeof nativeInputRequests>[number]>
  nativeInputDrafts: ConversationFlow['nativeInputDrafts']
  currentRelayDecision?: RelayDecisionPresentation | undefined
  composer: string
  composerImages: readonly DraftImage[]
  choosingImages: boolean
  composerMention?: ConversationComposerMention | undefined
  composerReturnedInputOperationId?: string | undefined
  editorValue: ComposerDocument
  pactCommandHint?: string | undefined
  handoffArriveKey?: string | number | undefined
  lastMainSync?: { sideChatId: string; receipt: SideChatSyncMainReceipt } | undefined
  draftComments: readonly AnchoredComment[]
  commentEditorView: ReactNode
  commentDraftsView: ReactNode
  skillComposer: ReturnType<typeof useSkillComposer>
  skillMenuOpen: boolean
  activeSkillId?: string | undefined
  mentionQuery?: MentionQuery | undefined
  filteredMentionOptions: readonly MentionOption[]
  mentionListOpen: boolean
  mentionListId: string
  activeMentionIndex: number
  activeMentionId?: string | undefined
  sessionSettingsSaving?: boolean | undefined
  queueDockRef: React.RefObject<HTMLDivElement | null>
  composerRef: React.RefObject<ComposerEditorHandle | null>
  onOpenRelaySettings?: (() => void) | undefined
  onRebuildNativeContext: ConversationFlow['rebuildNativeContext']
  onCheckNativeContext: ConversationFlow['checkNativeContext']
  onReturnQueueMessageToComposer: (restore: boolean) => Promise<boolean>
  onRespondNativeInput: (input: NativeInputRespond) => Promise<boolean>
  onNativeInputDraftChange: ConversationFlow['setNativeInputDraft']
  onSubmitAnswers: () => Promise<void>
  onRequestStop: () => Promise<boolean>
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onOpenSkillDocument?: ((skill: import('@pact/contracts').SkillSelection) => void) | undefined
  onNotice: (message: string) => void
  onAddComposerImages?: ConversationFlow['addComposerImages'] | undefined
  onChooseComposerImages?: ConversationFlow['chooseComposerImages'] | undefined
  onRemoveComposerImage?: ConversationFlow['removeComposerImage'] | undefined
  onOpenImageGallery: (images: readonly DraftImage[], image: ConversationImage) => void
  onAcceptComposerDocument: (
    document: ComposerDocument,
    cursor: number,
    composing: boolean,
  ) => boolean
  onCursorChanged: (cursor: number) => void
  onUpdateComposer: (value: string, cursor: number, edits?: ComposerEdit[]) => void
  onChooseSkill: (entry: ComposerSkillOption) => void
  onChooseMention: (option: MentionOption) => void
  onDismissMentionMenu: () => void
  onClearMentionQuery: () => void
  onActiveMentionIndexChange: (updater: number | ((index: number) => number)) => void
  onSubmit: () => Promise<void>
  onOpenBtwSideChat?: ((draft: ComposerDocument) => Promise<boolean>) | undefined
  onSyncToMain?: ConversationFlow['syncToMain'] | undefined
  onViewMainMessage?: ((receipt: SideChatSyncMainReceipt) => void) | undefined
  onDismissMainSync: () => void
  onSaveSessionPermission?: ((input: SessionPermissionSaveInput) => Promise<boolean>) | undefined
  onSaveSessionSpeed?: ((input: SessionSpeedSaveInput) => Promise<boolean>) | undefined
  onInputHeightDelta?: ((delta: number) => void) | undefined
  onRespondNativePermission?: (
    operationId: string,
    permissionId: string,
    decision: NativePermissionDecision,
  ) => Promise<boolean>
}

export function ComposerIsland({
  session,
  snapshot,
  history,
  visible,
  isSideChat,
  platform,
  planPanelExpanded,
  nativePresentationSuspended,
  schedulingState,
  visibleSessionIssues,
  queuedBackgroundAgent,
  stoppingBackgroundAgent,
  stoppingBackgroundInQueue,
  waitingBackgroundIssue,
  activeRun,
  latestRun,
  runsById,
  activePair,
  primaryName,
  secondaryName,
  respondingAgentId,
  responseInProgress,
  continuationBlocked,
  agentActionsEnabled,
  effectiveMainSyncEnabled,
  sideChatSettingsState,
  composerDisabled,
  disabled,
  commonComposerBlocked,
  mainSyncComposerBlocked,
  recoveryLocked,
  sending,
  stopping,
  showStop,
  stopLabel,
  showSend,
  hasDraft,
  isBtwReady,
  btwSubmitting,
  isMainRoute,
  hasUnfinishedTask,
  hasReplacement,
  queueEnabled,
  canSteerQueuedInput,
  steerUnavailableReason,
  inputTakeover,
  decisionTakeover,
  decisionSource,
  decisionKey,
  decisionMessageId,
  decisionReply,
  decisionAnswersReady,
  inputGateState,
  incompleteCanAnswer,
  questionDisabled,
  planRecovery,
  nativeRequests,
  nativeQuestions,
  nativeInputDrafts,
  currentRelayDecision,
  composer,
  composerImages,
  choosingImages,
  composerMention,
  composerReturnedInputOperationId,
  editorValue,
  pactCommandHint,
  handoffArriveKey,
  lastMainSync,
  draftComments,
  commentEditorView,
  commentDraftsView,
  skillComposer,
  skillMenuOpen,
  activeSkillId,
  mentionQuery,
  filteredMentionOptions,
  mentionListOpen,
  mentionListId,
  activeMentionIndex,
  activeMentionId,
  sessionSettingsSaving,
  queueDockRef,
  composerRef,
  onOpenRelaySettings,
  onRebuildNativeContext,
  onCheckNativeContext,
  onReturnQueueMessageToComposer,
  onRespondNativeInput,
  onNativeInputDraftChange,
  onSubmitAnswers,
  onRequestStop,
  onOpenProjectFile,
  onOpenSkillDocument,
  onNotice,
  onAddComposerImages,
  onChooseComposerImages,
  onRemoveComposerImage,
  onOpenImageGallery,
  onAcceptComposerDocument,
  onCursorChanged,
  onUpdateComposer,
  onChooseSkill,
  onChooseMention,
  onDismissMentionMenu,
  onClearMentionQuery,
  onActiveMentionIndexChange,
  onSubmit,
  onOpenBtwSideChat,
  onSyncToMain,
  onViewMainMessage,
  onDismissMainSync,
  onSaveSessionPermission,
  onSaveSessionSpeed,
  onInputHeightDelta,
}: ComposerIslandProps): React.JSX.Element {
  const [imageDropActive, setImageDropActive] = useState(false)
  const [dismissedArriveKey, setDismissedArriveKey] = useState<string | number | undefined>()
  const focusedArriveKeyRef = useRef<string | number | undefined>(undefined)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const skillPopoverOpen = useRef(false)
  const mentionMenuRef = useRef<HTMLDivElement>(null)
  const mentionPopoverOpen = useRef(false)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const composerMenuAnchor = `--pact-composer-menu-${useId().replaceAll(':', '')}`

  const returnedInput = history.window?.view.rebuildInputRecovery
  const queue = snapshot?.queue
  const queuedInput = queue?.input
  const queueActions = history.queueActions

  const isHandoffArriving =
    handoffArriveKey !== undefined && handoffArriveKey !== dismissedArriveKey

  useEffect(() => {
    if (handoffArriveKey === undefined || handoffArriveKey === dismissedArriveKey) {
      return undefined
    }
    const timer = window.setTimeout(() => setDismissedArriveKey(handoffArriveKey), 220)
    return () => window.clearTimeout(timer)
  }, [dismissedArriveKey, handoffArriveKey])

  useLayoutEffect(() => {
    if (
      handoffArriveKey === undefined ||
      !visible ||
      composerDisabled ||
      inputTakeover ||
      focusedArriveKeyRef.current === handoffArriveKey
    ) {
      return
    }
    focusedArriveKeyRef.current = handoffArriveKey
    const editor = composerRef.current
    if (!editor) return
    const end = editor.document().text.length
    editor.focus()
    editor.select(end, end)
  }, [composerDisabled, composerRef, handoffArriveKey, inputTakeover, visible])

  const composerMenuKind = skillMenuOpen ? 'skill' : mentionListOpen ? 'mention' : undefined
  useLayoutEffect(() => {
    const menu = composerMenuKind === 'skill' ? skillMenuRef.current : mentionMenuRef.current
    const open = composerMenuKind === 'skill' ? skillPopoverOpen : mentionPopoverOpen
    const box = composerBoxRef.current
    if (!composerMenuKind || !menu || !box) return undefined
    const fit = (): void => {
      menu.style.setProperty(
        '--pact-composer-menu-available-height',
        `${Math.max(0, box.getBoundingClientRect().top - 16)}px`,
      )
    }
    fit()
    menu.showPopover()
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    window.addEventListener('resize', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      if (open.current && menu.isConnected) menu.hidePopover()
    }
  }, [composerMenuKind])

  useLayoutEffect(() => {
    if (activeSkillId && skillComposer.revealActive)
      skillMenuRef.current?.querySelector<HTMLElement>(`#skill-${activeSkillId}`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'instant',
      })
  }, [activeSkillId, skillComposer.revealActive])

  return (
    <div
      data-pact-surface
      className="pact-conversation-input-dock relative shrink-0 bg-surface px-section pt-3 pb-4"
    >
      <div
        aria-hidden="true"
        className="pact-composer-dock-fade pointer-events-none absolute inset-x-0 -top-5 h-5"
      />
      <div className={`pact-input-dock-inner mx-auto flex ${CONVERSATION_WIDTH} flex-col gap-2`}>
        {visibleSessionIssues && visibleSessionIssues.agents.length > 0 ? (
          <SessionWarningCard
            value={visibleSessionIssues}
            enabled={agentActionsEnabled}
            queuedBackgroundAgent={queuedBackgroundAgent}
            stoppingAgent={stoppingBackgroundAgent}
            onRetry={(issue) =>
              issue.action === 'inspect_rebuild'
                ? onRebuildNativeContext(issue.agentId, {
                    intent: 'inspect',
                    clientOperationId: issue.rebuildId,
                    expectedGeneration: issue.generation,
                  })
                : onCheckNativeContext(issue.agentId, issue.runId)
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

        <div className="relay-indicator-slot">
          {onOpenRelaySettings ? (
            <RelayActivityIndicator
              state={schedulingState}
              sessionId={session.id}
              visible={visible && !nativePresentationSuspended}
              waitingForUser={inputTakeover || nativeRequests.length > 0}
              onOpenSettings={onOpenRelaySettings}
            />
          ) : null}
        </div>

        <div ref={queueDockRef} className="pact-queued-input flex min-h-0 flex-col">
          {queue && queueActions ? (
            <QueueMessageBar
              queue={queue}
              pending={queueActions.pending}
              disabled={composerDisabled || sending}
              canResume={!continuationBlocked}
              backgroundStatus={
                stoppingBackgroundInQueue
                  ? 'stopping'
                  : waitingBackgroundIssue?.resultDisposition === 'incomplete'
                    ? 'waiting_incomplete'
                    : waitingBackgroundIssue
                      ? 'waiting'
                      : undefined
              }
              showSteer={
                activeRun?.status === 'running' &&
                !activeRun.collaboration &&
                !hasUnfinishedTask &&
                !queuedInput?.workflowCommand
              }
              canSteer={!inputTakeover && !stopping && canSteerQueuedInput}
              steerUnavailableReason={
                inputTakeover ? 'Resolve the current interaction first.' : steerUnavailableReason
              }
              respondingAgentId={respondingAgentId}
              onSteer={queueActions.steer}
              onRemove={queueActions.remove}
              onEdit={inputTakeover ? undefined : () => onReturnQueueMessageToComposer(false)}
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
            onHeightDelta={onInputHeightDelta}
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
                          className="rounded-2xl border border-border-strong bg-surface-raised px-group py-panel text-caption shadow-island"
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
                            onSubmit={() => void onSubmitAnswers()}
                            canSubmit={decisionAnswersReady}
                            disabled={questionDisabled}
                            onOpenProjectFile={onOpenProjectFile}
                          />
                        </div>
                      ) : (
                        <section
                          aria-label="Answer progress"
                          className="flex items-center gap-group rounded-2xl border border-border-strong bg-surface-raised px-group py-panel text-caption shadow-island"
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
                          {showStop ? (
                            <button
                              type="button"
                              disabled={stopping}
                              onClick={() => void onRequestStop()}
                              className="pact-pressable min-h-8 cursor-pointer rounded-xl px-3 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                            >
                              {stopping ? 'Stopping…' : 'Stop'}
                            </button>
                          ) : null}
                        </section>
                      ),
                    }
                  : currentRelayDecision && !planRecovery && nativeRequests.length === 0
                    ? {
                        key: `relay:${currentRelayDecision.request.decisionId}`,
                        content: (
                          <RelayDecisionCard
                            decision={currentRelayDecision}
                            visible={visible && !nativePresentationSuspended}
                          />
                        ),
                      }
                    : undefined
            }
          >
            <div className="pact-ordinary-input-stack flex flex-col gap-2">
              {snapshot?.preparedInputContinuation ? (
                <PreparedInputCard
                  key={`${session.id}:${snapshot.preparedInputContinuation.batchId}`}
                  sessionId={session.id}
                  input={snapshot.preparedInputContinuation}
                  disabled={
                    sending || stopping || nativeRequests.length > 0 || Boolean(planRecovery)
                  }
                  onChanged={() => history.retryRead()}
                />
              ) : null}

              {!planPanelExpanded ? commentEditorView : null}

              {skillComposer.warning ? (
                <div
                  id={`skill-warning-${session.id}`}
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-status-danger/30 bg-status-danger-muted px-3 py-2 text-caption text-status-danger-foreground"
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
              composerReturnedInputOperationId !== queue.returnedInput.operationId ? (
                <button
                  type="button"
                  className="pact-pressable min-h-7 cursor-pointer self-start rounded-control px-2 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                  disabled={composerDisabled || sending || stopping || queueActions.pending}
                  title="Replace the current draft with the returned message"
                  onClick={() => void onReturnQueueMessageToComposer(true)}
                >
                  {history.restoringInput ? 'Restoring…' : 'Restore returned message'}
                </button>
              ) : null}

              {isSideChat && lastMainSync?.sideChatId === session.id ? (
                <div
                  role="status"
                  className="pact-side-chat-sync-bar flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 py-1.5 text-caption"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-secondary">
                    <Check
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-status-ready"
                      strokeWidth={1.75}
                    />
                    <span className="truncate">
                      Sent to main chat
                      {lastMainSync.receipt.disposition === 'queued' ? ' (queued)' : ''}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {onViewMainMessage ? (
                      <button
                        type="button"
                        className="cursor-pointer font-medium text-focus hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                        onClick={() => onViewMainMessage(lastMainSync.receipt)}
                      >
                        View
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Dismiss main chat notification"
                      className="grid size-5 cursor-pointer place-items-center rounded-control text-tertiary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
                      onClick={onDismissMainSync}
                    >
                      <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              ) : null}

              <div
                ref={composerBoxRef}
                style={{ anchorName: composerMenuAnchor }}
                className={`pact-composer-box pact-silk-surface relative flex flex-col gap-1.5 rounded-2xl border border-border-strong bg-surface-raised p-2.5 shadow-island focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus ${isHandoffArriving ? 'pact-composer-handoff-arrive' : ''} ${recoveryLocked ? 'opacity-60' : ''} ${imageDropActive ? 'outline-2 outline-focus outline-offset-4' : ''}`}
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
                <div className="pact-composer-editing flex min-h-16 w-full flex-col gap-1.5">
                  {!planPanelExpanded ? commentDraftsView : null}

                  {returnedInput ? (
                    <div className="mb-1 flex flex-wrap items-center gap-2 px-2 text-caption text-secondary">
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
                          ? `${agentName(returnedInput.route.firstAgentId)} → ${agentName(returnedInput.route.secondAgentId)}`
                          : agentName(returnedInput.route.agentId)}
                      </span>
                      {returnedInput.state === 'pending' ||
                      (!composer &&
                        !composerImages.length &&
                        !hasDecisionAnswers(history.decisionDraft)) ? (
                        <>
                          <button
                            type="button"
                            className="cursor-pointer rounded-control px-2 py-1 text-primary hover:bg-surface-muted disabled:cursor-default disabled:opacity-40"
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
                              className="cursor-pointer rounded-control px-2 py-1 hover:bg-surface-muted disabled:cursor-default disabled:opacity-40"
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
                            <span>Sending your current draft replaces the returned message.</span>
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
                    onOpen={(image) => onOpenImageGallery(composerImages, image)}
                    onRemove={onRemoveComposerImage}
                  />

                  <ComposerEditor
                    editorRef={composerRef}
                    value={editorValue}
                    allowPactCommands={!isSideChat}
                    onChange={onAcceptComposerDocument}
                    admitEdit={history.admitComposerEdit}
                    onCursor={onCursorChanged}
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
                      isSideChat && sideChatSettingsState === 'loading'
                        ? 'Loading side chat settings…'
                        : agentActionsEnabled
                          ? 'What should we tackle next?'
                          : isSideChat && effectiveMainSyncEnabled
                            ? 'Mention @Main to send to main chat'
                            : 'Agent actions are paused'
                    }
                    disabled={composerDisabled || inputTakeover}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void onSubmit()
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
                          if (entry) onChooseSkill(entry)
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
                        onUpdateComposer(next, cursor, [
                          {
                            start: selectedMention.start,
                            end: selectedMention.end + trailingSpace,
                            text: '',
                          },
                        ])
                        onClearMentionQuery()
                        return
                      }
                      if (mentionQuery && filteredMentionOptions.length > 0) {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          const direction = event.key === 'ArrowDown' ? 1 : -1
                          onActiveMentionIndexChange(
                            (index) =>
                              (index + direction + filteredMentionOptions.length) %
                              filteredMentionOptions.length,
                          )
                          return
                        }
                        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                          event.preventDefault()
                          const option = filteredMentionOptions[activeMentionIndex]
                          if (option) onChooseMention(option)
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          onDismissMentionMenu()
                          return
                        }
                      }
                      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        if (
                          !isBtwReady &&
                          !isMainRoute &&
                          responseInProgress &&
                          !queueEnabled &&
                          !hasUnfinishedTask
                        )
                          return
                        event.preventDefault()
                        void onSubmit()
                      }
                    }}
                  />
                </div>

                {pactCommandHint ? (
                  <p className="px-2 pb-1 text-caption text-tertiary">{pactCommandHint}</p>
                ) : null}

                <div className="pact-composer-send-row relative flex items-center justify-between">
                  <div
                    ref={skillMenuRef}
                    popover="auto"
                    style={{ positionAnchor: composerMenuAnchor }}
                    onBeforeToggle={(event) => {
                      skillPopoverOpen.current = event.newState === 'open'
                      if (event.newState === 'closed' && skillComposer.query) skillComposer.close()
                    }}
                    id={`skills-${session.id}`}
                    role="listbox"
                    aria-label="Native Skills"
                    aria-hidden={!skillMenuOpen}
                    aria-busy={skillComposer.loading}
                    inert={!skillMenuOpen}
                    data-open={skillMenuOpen}
                    className="pact-skill-menu overflow-y-auto rounded-panel border border-border bg-menu-surface p-1.5 shadow-popover"
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
                              className={`flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption ${index === skillComposer.active ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted'}`}
                              onMouseEnter={() => skillComposer.setActive(index, false)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => onChooseSkill(entry)}
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
                          {agentName(agent)}
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
                                className={`flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption ${index === skillComposer.active ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted'}`}
                                onMouseEnter={() => skillComposer.setActive(index, false)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => onChooseSkill(entry)}
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
                                className="min-h-8 cursor-pointer rounded-control px-2 text-caption text-secondary hover:bg-surface-muted disabled:opacity-50"
                                aria-label={`Previous ${agentName(agent)} Skills`}
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
                                className="min-h-8 cursor-pointer rounded-control px-2 text-caption text-secondary hover:bg-surface-muted disabled:opacity-50"
                                aria-label={`More ${agentName(agent)} Skills`}
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

                  <div
                    ref={mentionMenuRef}
                    id={mentionListId}
                    popover="auto"
                    style={{ positionAnchor: composerMenuAnchor }}
                    data-open={mentionListOpen}
                    aria-hidden={!mentionListOpen}
                    inert={!mentionListOpen}
                    onBeforeToggle={(event) => {
                      mentionPopoverOpen.current = event.newState === 'open'
                      if (event.newState === 'closed' && mentionQuery) onDismissMentionMenu()
                    }}
                    className="pact-mention-menu overflow-y-auto rounded-panel border border-border bg-menu-surface p-1.5 shadow-popover"
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
                          onMouseEnter={() => onActiveMentionIndexChange(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => onChooseMention(option)}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-primary">{option.label}</span>
                            <span className="ml-2 text-caption text-tertiary">
                              {option.token === '@all'
                                ? `${primaryName}, then ${secondaryName}`
                                : option.description}
                            </span>
                          </span>
                          <span className="font-mono text-caption text-tertiary">
                            {option.token}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {onChooseComposerImages ? (
                    <button
                      type="button"
                      className="pact-pressable grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40"
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

                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {showStop ? (
                      <button
                        type="button"
                        aria-label={stopLabel}
                        title={stopLabel}
                        disabled={stopping || !agentActionsEnabled}
                        onClick={() => void onRequestStop()}
                        className={`pact-pressable grid size-9 cursor-pointer place-items-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default ${showSend ? 'border border-border bg-surface-muted text-secondary enabled:hover:border-border-strong enabled:hover:text-primary' : 'bg-surface-inverse text-inverse hover:opacity-85'}`}
                      >
                        {stopping ? (
                          <LoaderCircle
                            aria-hidden="true"
                            className="size-4 animate-spin motion-reduce:animate-none"
                            strokeWidth={1.8}
                          />
                        ) : (
                          <Square
                            aria-hidden="true"
                            className="size-3.5"
                            fill="currentColor"
                            strokeWidth={1.5}
                          />
                        )}
                      </button>
                    ) : null}
                    {showSend ? (
                      <button
                        className="pact-pressable grid size-9 cursor-pointer place-items-center rounded-xl bg-surface-inverse text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-40"
                        type="button"
                        aria-label={isMainRoute ? 'Send to main' : 'Send message'}
                        title={isMainRoute ? 'Send to main' : 'Send message'}
                        disabled={
                          isBtwReady
                            ? commonComposerBlocked || btwSubmitting || !onOpenBtwSideChat
                            : isMainRoute
                              ? mainSyncComposerBlocked || !onSyncToMain
                              : disabled ||
                                !hasDraft ||
                                hasReplacement ||
                                (responseInProgress && !queueEnabled && !hasUnfinishedTask)
                        }
                        onClick={() => void onSubmit()}
                      >
                        {isMainRoute ? (
                          <span
                            key="send-main"
                            className="pact-send-icon inline-flex items-center justify-center"
                          >
                            <CornerUpLeft aria-hidden="true" className="size-4" strokeWidth={1.9} />
                          </span>
                        ) : (
                          <span
                            key="send-normal"
                            className="pact-send-icon inline-flex items-center justify-center"
                          >
                            <ArrowUp aria-hidden="true" className="size-4" strokeWidth={1.9} />
                          </span>
                        )}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {!isSideChat ? (
                <div className="pact-composer-controls flex min-w-0 items-center gap-2">
                  {onSaveSessionPermission ? (
                    <>
                      {activePair.map((agent) => (
                        <div
                          key={`${session.id}-${agent}`}
                          role="group"
                          aria-label={`${agentName(agent)} settings`}
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
              ) : null}

              {history.draftError && snapshot ? (
                <p
                  className="flex items-center gap-2 px-2 text-caption text-secondary"
                  role="alert"
                >
                  Couldn’t load comments.
                  <button
                    className="min-h-8 cursor-pointer font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
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
    </div>
  )
}
