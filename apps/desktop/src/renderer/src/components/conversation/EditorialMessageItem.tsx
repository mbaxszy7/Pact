import {
  Check,
  ChevronDown,
  Copy,
  CornerUpLeft,
  Info,
  LoaderCircle,
  MessageSquarePlus,
  Split,
  TriangleAlert,
  X,
} from 'lucide-react'
import { memo, useId, useState } from 'react'

import type {
  AgentActivity,
  AgentRun,
  AnchoredComment,
  CollaborationSession,
  ConversationRunContext,
  MessageCommentAnchor,
  PeerRequestProposal,
  RuntimeAgentId,
  WorkspaceChangeSet,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import { isConversationBackgroundReport } from '@pact/contracts'

import type { ConversationViewProjection } from './conversation-window'
import type { MessageTextSelection } from './MessageSelectionSurface'
import type { ConversationHistoryControls } from './useConversation'

import { AgentActivityList } from './AgentActivityList'
import {
  CollaborationReview,
  type PlanTextSelection,
  type ReportTextSelection,
} from './CollaborationReview'
import {
  agentName,
  handoffSourceLabel,
  hasRecordingWarning,
  hasVisibleChanges,
  messageDateTimeFormatter,
  messageTimeFormatter,
  speakerCrestClasses,
  speakerForegroundClass,
  speakerLineClass,
} from './conversation-view-helpers'
import { isRunResponseComplete } from './conversation-window'
import { ConversationImages } from './ConversationImages'
import { LargeMessagePreview } from './LargeBodyPreview'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'
import { SentComments } from './SentComments'

export interface ConversationTranscriptRow {
  key: string
  message: ConversationViewProjection['messages'][number] | undefined
  run: AgentRun | undefined
  context?: ConversationRunContext | undefined
}

export interface EditorialMessageItemProps {
  row: ConversationTranscriptRow
  rows: readonly ConversationTranscriptRow[]
  session: CollaborationSession
  snapshot?: ConversationViewProjection | undefined
  history: ConversationHistoryControls
  isSideChat: boolean
  activeRun?: AgentRun | undefined
  latestRun?: AgentRun | undefined
  runsById: ReadonlyMap<string, AgentRun>
  activitiesByRun: ReadonlyMap<string, ConversationViewProjection['activities']>
  activityOwnerMessageByRun: ReadonlyMap<string, string>
  pendingRoutedMessage?: ConversationViewProjection['messages'][number] | undefined
  pendingRoutedAgentId?: RuntimeAgentId | undefined
  recoveryLocked: boolean
  inputTakeover: boolean
  disabled: boolean
  responseInProgress: boolean
  continuationBlocked: boolean
  feedbackDraft: boolean
  nativePresentationSuspended: boolean
  visible: boolean
  loading: boolean
  sending: boolean
  stopping: boolean
  hasNativeQuestions: boolean
  hasRelayDecision: boolean
  canFork: boolean
  copyFeedback?: { messageId: string; result: 'copying' | 'copied' | 'failed' } | undefined
  revealReport?: MessageCommentAnchor['report'] | undefined
  revealReportRequestId?: string | undefined
  revealReportBasis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  revealReportOffset?: number | undefined
  onRegisterMessageElement: (messageId: string, element: HTMLElement | null) => void
  onBeginDetailRead: () => void
  onCopyMessage: (messageId: string, content: string) => Promise<void>
  onRequestFork: (messageId: string) => void
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onCreateMessageComment: (selection: MessageTextSelection) => void
  onCreatePlanComment: (selection: PlanTextSelection | ReportTextSelection) => void
  onAskInSideChat?: ((selection: MessageTextSelection) => void) | undefined
  onOpenSideChat?: ((sideChatId: string) => void) | undefined
  resolveSideChatTitle?: ((sideChatId: string, fallbackTitle: string) => string) | undefined
  onOpenComment: (comment: AnchoredComment) => void
  onOpenGallery: (images: ConversationImage[], initialId: string) => void
  onOpenRecordedPlan: (source: { runId: string; messageId: string; version: number }) => void
  onOpenSessionSettings?: (() => void) | undefined
  onTaskChange: () => void
  onReportReady: (host: HTMLElement, onApplied?: () => void) => (() => void) | undefined
  onAcceptPeerProposal: (proposalId: string) => Promise<boolean>
  onDismissPeerProposal: (proposalId: string) => Promise<boolean>
  onViewSavedResponse: (messageId: string) => void
  renderWorkspaceChanges: (changeSet: WorkspaceChangeSet) => React.JSX.Element
}

export function SpeakerCrest({
  agentId,
}: {
  agentId: RuntimeAgentId | undefined
}): React.JSX.Element {
  const resolved: RuntimeAgentId = agentId ?? 'codex'
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-caption font-medium ${speakerCrestClasses(resolved)}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span>{agentName(resolved)}</span>
    </span>
  )
}

export function EditorialMessageItem({
  row,
  rows,
  session,
  snapshot,
  history,
  isSideChat,
  activeRun,
  latestRun,
  runsById,
  activitiesByRun,
  activityOwnerMessageByRun,
  pendingRoutedMessage,
  pendingRoutedAgentId,
  recoveryLocked,
  inputTakeover,
  disabled,
  responseInProgress,
  continuationBlocked,
  feedbackDraft,
  nativePresentationSuspended,
  visible,
  loading,
  sending,
  stopping,
  hasNativeQuestions,
  hasRelayDecision,
  canFork,
  copyFeedback,
  revealReport,
  revealReportRequestId,
  revealReportBasis,
  revealReportOffset,
  onRegisterMessageElement,
  onBeginDetailRead,
  onCopyMessage,
  onRequestFork,
  onOpenProjectFile,
  onCreateMessageComment,
  onCreatePlanComment,
  onAskInSideChat,
  onOpenSideChat,
  resolveSideChatTitle,
  onOpenComment,
  onOpenGallery,
  onOpenRecordedPlan,
  onOpenSessionSettings,
  onTaskChange,
  onReportReady,
  onAcceptPeerProposal,
  onDismissPeerProposal,
  onViewSavedResponse,
  renderWorkspaceChanges,
}: EditorialMessageItemProps): React.JSX.Element | null {
  const { message } = row
  const placeholderRun = row.run ?? activeRun
  const reviewPresentationSuspended =
    nativePresentationSuspended || hasNativeQuestions || hasRelayDecision || !visible

  if (row.context && row.run) {
    const run = row.run
    return (
      <article className="flex w-full min-w-0 flex-col space-y-2" data-pact-run-context-id={run.id}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          <SpeakerCrest agentId={run.agentId} />
          <RunConfiguration run={run} />
          {run.handoffMessageCount ? (
            <ContextReceipt
              count={run.handoffMessageCount}
              source={handoffSourceLabel(run)}
              accepted={Boolean(run.nativeTurnId)}
            />
          ) : null}
        </div>
        <RunWorkLog
          runId={run.id}
          agentId={run.agentId}
          activities={activitiesByRun.get(run.id) ?? []}
          active={['starting', 'running', 'recovering'].includes(run.status)}
          available
          history={history}
          onRead={onBeginDetailRead}
        />
      </article>
    )
  }

  if (!message && row.key.startsWith('changes:') && row.run) {
    const run = row.run
    return (
      <article className="flex w-full min-w-0 flex-col" data-pact-change-run-id={run.id}>
        <EditorialChangeGroup
          run={run}
          rows={rows}
          runsById={runsById}
          history={history}
          renderWorkspaceChanges={renderWorkspaceChanges}
          onViewSavedResponse={onViewSavedResponse}
        />
        {run.collaboration &&
        !['starting', 'running', 'recovering'].includes(run.status) &&
        !snapshot?.messages.some(
          (candidate) => candidate.role === 'assistant' && candidate.runId === run.id,
        ) ? (
          <CollaborationReview
            session={session}
            run={run}
            latestRunId={latestRun?.id}
            disabled={disabled || responseInProgress}
            continuationBlocked={continuationBlocked}
            onOpenPlan={onOpenRecordedPlan}
            onOpenSessionSettings={isSideChat ? undefined : onOpenSessionSettings}
            nativePresentationSuspended={reviewPresentationSuspended}
            onOpenProjectFile={onOpenProjectFile}
            onCreateReportComment={
              recoveryLocked || inputTakeover ? undefined : onCreatePlanComment
            }
            feedbackDraft={feedbackDraft}
            onTaskChange={onTaskChange}
            revealReport={revealReport}
            revealReportRequestId={revealReportRequestId}
            revealReportBasis={revealReportBasis}
            revealReportOffset={revealReportOffset}
            onReportReady={onReportReady}
          />
        ) : null}
      </article>
    )
  }

  if (!message) {
    if (!placeholderRun) return null
    const runActive = ['starting', 'running', 'recovering'].includes(placeholderRun.status)
    return (
      <article className="flex w-full min-w-0 flex-col" data-pact-speaker={placeholderRun.agentId}>
        <div className="min-w-0 w-full">
          <div className="rounded-message px-0.5 py-0.5" data-pact-message-bubble>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
              <SpeakerCrest agentId={placeholderRun.agentId} />
              <RunConfiguration run={placeholderRun} />
              {placeholderRun.handoffMessageCount ? (
                <ContextReceipt
                  count={placeholderRun.handoffMessageCount}
                  source={handoffSourceLabel(placeholderRun)}
                  accepted={Boolean(placeholderRun.nativeTurnId)}
                />
              ) : null}
            </div>
            <RunWorkLog
              runId={placeholderRun.id}
              agentId={placeholderRun.agentId}
              activities={activitiesByRun.get(placeholderRun.id) ?? []}
              active={runActive}
              available={Boolean(activitiesByRun.get(placeholderRun.id)?.length)}
              history={history}
              onRead={onBeginDetailRead}
            />
          </div>
          {runActive ? <MessageResponseIndicator agentId={placeholderRun.agentId} /> : null}
        </div>
        {placeholderRun.collaboration && !runActive ? (
          <CollaborationReview
            session={session}
            run={placeholderRun}
            latestRunId={latestRun?.id}
            disabled={disabled || responseInProgress}
            continuationBlocked={continuationBlocked}
            onOpenPlan={onOpenRecordedPlan}
            onOpenSessionSettings={isSideChat ? undefined : onOpenSessionSettings}
            nativePresentationSuspended={reviewPresentationSuspended}
            onOpenProjectFile={onOpenProjectFile}
            onCreateReportComment={
              recoveryLocked || inputTakeover ? undefined : onCreatePlanComment
            }
            feedbackDraft={feedbackDraft}
            onTaskChange={onTaskChange}
            revealReport={revealReport}
            revealReportRequestId={revealReportRequestId}
            revealReportBasis={revealReportBasis}
            revealReportOffset={revealReportOffset}
            onReportReady={onReportReady}
          />
        ) : null}
      </article>
    )
  }

  if (message.role === 'system') {
    const nativeRebuild = message.content.endsWith('native session rebuilt')
    return (
      <div
        data-pact-message-id={message.id}
        tabIndex={-1}
        ref={(element) => onRegisterMessageElement(message.id, element)}
        className={
          nativeRebuild
            ? 'flex items-center gap-3 py-1 text-caption text-tertiary'
            : 'py-1 text-center text-caption text-tertiary'
        }
      >
        {nativeRebuild ? <span aria-hidden="true" className="h-px flex-1 bg-border" /> : null}
        <span>{message.content}</span>
        {nativeRebuild ? <span aria-hidden="true" className="h-px flex-1 bg-border" /> : null}
      </div>
    )
  }

  const isUser = message.role === 'user'
  const backgroundReport = isConversationBackgroundReport(message)
  const speaker = isUser ? 'You' : message.agentId ? agentName(message.agentId) : 'Codex'
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
    isUser && messageRun?.collaboration?.stage === 'reply'
      ? message.route?.type === 'agent'
        ? message.route.agentId
        : messageRun.agentId
      : undefined
  const activityRunId = messageRun?.id ?? message.runId
  const visibleContent = message.content
  const messageMeta = history.window?.messageMeta[message.id]
  const sentComments = history.window?.sentCommentsByMessage[message.id]
  const commentsLoaded = Boolean(history.window?.loadedCommentMessageIds[message.id])
  const commentOnly = isUser && !message.content && messageMeta?.hasComments
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
    !isUser &&
    !backgroundReport &&
    message.outputSnapshot?.canonical !== false &&
    message.replyToMessageId === pendingRoutedMessage?.id &&
    message.agentId !== pendingRoutedAgentId
      ? pendingRoutedAgentId
      : undefined
  const showUserSideChatBadge = Boolean(
    !isSideChat && isUser && message.originSideChat && onOpenSideChat,
  )
  const resolvedAgentId: RuntimeAgentId | undefined = message.agentId ?? messageRun?.agentId

  return (
    <article
      tabIndex={-1}
      className={
        isUser
          ? `ml-auto flex min-w-0 flex-col ${messageMeta?.oversized ? 'w-full max-w-[min(86%,68ch)]' : 'w-fit max-w-[min(78%,68ch)]'}`
          : 'flex w-full min-w-0 flex-col'
      }
      data-pact-speaker={isUser ? 'user' : (message.agentId ?? 'codex')}
      data-pact-message-id={message.id}
      ref={(element) => onRegisterMessageElement(message.id, element)}
    >
      <div className="min-w-0 w-full">
        <div className="group/message flex min-w-0 flex-col">
          <div
            data-pact-message-bubble
            className={
              isUser
                ? 'rounded-2xl bg-speaker-user px-4 py-2.5 text-primary'
                : 'rounded-message px-0.5 py-0.5 text-primary'
            }
          >
            {isUser ? (
              <>
                <span className="sr-only">You</span>
                {replyRecipient || showUserSideChatBadge ? (
                  <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-caption">
                    {replyRecipient ? (
                      <span
                        className="rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-focus"
                        aria-label={`Reply to ${agentName(replyRecipient)}`}
                      >
                        @{replyRecipient}
                      </span>
                    ) : null}
                    {showUserSideChatBadge && message.originSideChat && onOpenSideChat ? (
                      <button
                        type="button"
                        className="pact-side-chat-from-badge pact-pressable inline-flex cursor-pointer items-center gap-1 rounded-pill border border-border bg-surface-raised/90 px-2 py-0.5 text-caption font-medium leading-none text-secondary transition-colors hover:border-border-strong hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
                        title={`Open side chat: ${
                          resolveSideChatTitle
                            ? resolveSideChatTitle(
                                message.originSideChat.sideChatId,
                                message.originSideChat.sideChatTitle,
                              )
                            : message.originSideChat.sideChatTitle
                        }`}
                        onClick={() => onOpenSideChat(message.originSideChat!.sideChatId)}
                      >
                        <CornerUpLeft
                          aria-hidden="true"
                          className="size-3 shrink-0"
                          strokeWidth={1.75}
                        />
                        From side chat
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                <SpeakerCrest agentId={resolvedAgentId} />
                {backgroundReport ? (
                  <span className="text-tertiary">
                    Background update{message.historicalBackgroundReport ? ' · Earlier task' : ''}
                  </span>
                ) : messageRun ? (
                  <RunConfiguration run={messageRun} />
                ) : null}
                {ownsRunActivity && messageRun?.handoffMessageCount ? (
                  <ContextReceipt
                    count={messageRun.handoffMessageCount}
                    source={handoffSourceLabel(messageRun)}
                    accepted={Boolean(messageRun.nativeTurnId)}
                  />
                ) : null}
              </div>
            )}

            {!isUser && ownsRunActivity && activityRunId ? (
              <RunWorkLog
                runId={activityRunId}
                agentId={resolvedAgentId}
                completed={isRunResponseComplete(messageRun)}
                activities={activities}
                active={runActive}
                available={
                  retryInThisSlot ? activities.length > 0 : Boolean(messageMeta?.hasActivities)
                }
                history={history}
                onRead={onBeginDetailRead}
              />
            ) : null}

            <div className={isUser ? '' : 'mt-2'}>
              {backgroundReport && message.state === 'incomplete' ? (
                <p className="text-caption text-secondary">
                  The background update could not be saved.
                </p>
              ) : messageMeta?.oversized ? (
                <LargeMessagePreview preview={messageMeta.oversized.preview} />
              ) : !commentOnly ? (
                <MessageMarkdown
                  content={visibleContent}
                  skills={isUser ? (message.skills ?? []) : undefined}
                  onOpenProjectFile={onOpenProjectFile}
                  messageId={message.id}
                  onCreateComment={
                    recoveryLocked || inputTakeover ? undefined : onCreateMessageComment
                  }
                  onAskInSideChat={
                    !isSideChat &&
                    !backgroundReport &&
                    !messageMeta?.oversized &&
                    message.state !== 'streaming' &&
                    (isUser || message.role === 'assistant')
                      ? onAskInSideChat
                      : undefined
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
                  onOpen={(image) => onOpenGallery(message.images!, image.id)}
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
                    history.loadingCommentsFor === '*' || history.loadingCommentsFor === message.id
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
            isUser={isUser}
            copyResult={copyFeedback?.messageId === message.id ? copyFeedback.result : undefined}
            onCopy={onCopyMessage}
            onFork={
              !isSideChat &&
              !isUser &&
              !backgroundReport &&
              message.outputSnapshot?.canonical !== false &&
              message.state === 'complete' &&
              canFork
                ? () => onRequestFork(message.id)
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

        {!isUser && runActive && messageRun ? (
          <MessageResponseIndicator agentId={messageRun.agentId} />
        ) : pendingPeerAgentId ? (
          <MessageResponseIndicator agentId={pendingPeerAgentId} />
        ) : null}
      </div>

      {!isUser &&
      message.outputSnapshot?.canonical !== false &&
      messageRun?.collaboration &&
      !['starting', 'running', 'recovering'].includes(messageRun.status) ? (
        <CollaborationReview
          session={session}
          run={messageRun}
          latestRunId={latestRun?.id}
          disabled={disabled || responseInProgress}
          continuationBlocked={continuationBlocked}
          onOpenPlan={onOpenRecordedPlan}
          onOpenSessionSettings={onOpenSessionSettings}
          nativePresentationSuspended={reviewPresentationSuspended}
          onOpenProjectFile={onOpenProjectFile}
          onCreateReportComment={recoveryLocked || inputTakeover ? undefined : onCreatePlanComment}
          feedbackDraft={feedbackDraft}
          onTaskChange={onTaskChange}
          revealReport={revealReport}
          revealReportRequestId={revealReportRequestId}
          revealReportBasis={revealReportBasis}
          revealReportOffset={revealReportOffset}
          onReportReady={onReportReady}
          renderedMessageId={message.id}
          replyBodyComplete={message.state === 'complete'}
        />
      ) : null}

      {!isUser &&
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

function renderChangeMetadata(target: AgentRun): React.JSX.Element {
  return (
    <p className="mb-1 flex flex-wrap items-center gap-1.5 px-0.5 text-caption text-tertiary">
      <span className={`font-medium ${speakerForegroundClass(target.agentId)}`}>
        {agentName(target.agentId)}
      </span>
      <span aria-hidden="true">·</span>
      <time dateTime={target.createdAt}>
        {messageDateTimeFormatter.format(new Date(target.createdAt))}
      </time>
      <span aria-hidden="true">·</span>
      <span>
        {target.controlDisposition === 'abandoned'
          ? 'Cancelled'
          : target.status === 'interrupted'
            ? 'Stopped'
            : target.status === 'failed'
              ? 'Failed'
              : target.nativeEffectsState === 'pending' || target.nativeEffectsState === 'unknown'
                ? 'Reply finished'
                : 'Completed'}
      </span>
    </p>
  )
}

function renderRecordingWarning(target: AgentRun): React.JSX.Element | null {
  return hasRecordingWarning(target) ? (
    <output
      className="flex items-start gap-2 px-1 py-1 text-caption text-status-warning-foreground"
      data-pact-workspace-warning={target.id}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
      <span>{target.workspaceRecordingUnavailableReason}</span>
    </output>
  ) : null
}

function EditorialChangeGroup({
  run,
  rows,
  runsById,
  history,
  renderWorkspaceChanges,
  onViewSavedResponse,
}: {
  run: AgentRun
  rows: readonly ConversationTranscriptRow[]
  runsById: ReadonlyMap<string, AgentRun>
  history: ConversationHistoryControls
  renderWorkspaceChanges: (changeSet: WorkspaceChangeSet) => React.JSX.Element
  onViewSavedResponse: (messageId: string) => void
}): React.JSX.Element {
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
    ? opened.runIds.map((id) => runsById.get(id)).filter((item): item is AgentRun => Boolean(item))
    : []

  const renderSavedResult = (target: AgentRun): React.JSX.Element | null => {
    const id = target.responseMessageId
    if (!id || rows.some((row) => row.message?.id === id)) return null
    return (
      <button
        type="button"
        onClick={() => onViewSavedResponse(id)}
        className="pact-pressable mt-1 min-h-8 w-fit cursor-pointer rounded-control px-2 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
      >
        View response
      </button>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="min-w-0">
        {renderChangeMetadata(run)}
        {hasVisibleChanges(run) && run.workspaceChanges
          ? renderWorkspaceChanges(run.workspaceChanges)
          : null}
        {renderRecordingWarning(run)}
        {run.controlDisposition === 'abandoned' ? renderSavedResult(run) : null}
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
            className="pact-pressable inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
          >
            Previous {previousCount} {previousCount === 1 ? 'attempt' : 'attempts'}
            <ChevronDown
              className={`size-3.5 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
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
                  {renderSavedResult(previous)}
                </div>
              ))}
              {loadingGroup ? (
                <p className="px-2 text-caption text-secondary" aria-busy="true">
                  Loading earlier attempts…
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
                  className="pact-pressable min-h-8 w-fit cursor-pointer rounded-control px-2 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                >
                  {failure ? 'Try again' : 'Load earlier attempts'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ContextReceipt({
  count,
  source,
  accepted,
}: {
  count: number
  source?: string | undefined
  accepted: boolean
}): React.JSX.Element {
  const unit = count === 1 ? 'message' : 'messages'
  return (
    <span className="text-caption text-tertiary">
      <span aria-hidden="true">· </span>
      <span>
        {source
          ? `${accepted ? 'Shared' : 'Prepared'} ${count} earlier ${unit} from ${source}`
          : `Included ${count} earlier ${unit}`}
      </span>
    </span>
  )
}

function MessageResponseIndicator({ agentId }: { agentId: RuntimeAgentId }): React.JSX.Element {
  const name = agentName(agentId)
  return (
    <div className="mt-2 flex justify-start">
      <output
        className={`inline-flex h-5 items-center gap-1 rounded-pill px-2.5 ${speakerCrestClasses(agentId)}`}
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
      </output>
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
  const requesterName = agentName(requester)
  const targetName = agentName(proposal.targetAgentId)
  const action =
    proposal.kind === 'fact_check'
      ? 'fact-check'
      : proposal.kind === 'supplement'
        ? 'follow-up'
        : proposal.kind
  return (
    <div className="mt-2.5 flex w-full min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-status-info/25 bg-status-info-muted/45 px-3.5 py-2.5 text-caption">
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
          className="pact-pressable h-7 cursor-pointer rounded-xl bg-surface-inverse px-3 font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
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
          className="pact-pressable h-7 cursor-pointer rounded-xl px-2.5 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
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
  agentId,
  activities,
  active,
  completed = false,
  available,
  history,
  onRead,
}: {
  runId: string
  agentId?: RuntimeAgentId | undefined
  activities: AgentActivity[]
  active: boolean
  completed?: boolean
  available: boolean
  history: ConversationHistoryControls
  onRead: () => void
}): React.JSX.Element | null {
  const detailError =
    history.activityError?.runId === runId ? history.activityError.message : undefined
  const guideClass = agentId ? speakerLineClass(agentId) : 'border-border-strong'

  if (!available && activities.length === 0 && !detailError) {
    return active ? (
      <output
        className={`mt-2 flex items-center gap-2 border-l-2 pl-3 text-caption text-secondary ${guideClass}`}
      >
        <span className="primary-action-spinner" aria-hidden="true" />
        Working
      </output>
    ) : null
  }
  const viewing = history.window?.activityView?.runId === runId
  const truncated = viewing && Boolean(history.window?.activityView?.truncated)
  const loading = history.loadingActivityRunId === runId
  const showLoadingRow = !detailError && activities.length === 0 && (loading || viewing)
  const canLoad =
    Boolean(detailError) || (available && !viewing && !loading && activities.length === 0)
  const statusAccentClass = agentId ? speakerForegroundClass(agentId) : 'text-secondary'

  return (
    <div className="mt-2">
      {activities.length > 0 ? (
        <AgentActivityList
          key={completed ? 'complete' : 'pending'}
          activities={activities}
          active={active}
          agentId={agentId}
          defaultExpanded={viewing && (!completed || Boolean(history.window?.activityView?.manual))}
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
      ) : null}
      {showLoadingRow ? (
        <div
          className={`flex min-h-7 items-center gap-2 border-l-2 pl-3 text-caption font-medium text-secondary ${guideClass}`}
        >
          <LoaderCircle
            aria-hidden="true"
            className={`session-activity-spin size-3.5 shrink-0 ${statusAccentClass}`}
            strokeWidth={1.9}
          />
          <span>Loading work log…</span>
        </div>
      ) : canLoad ? (
        <div className={activities.length > 0 ? 'mt-1 pl-3.5' : `border-l-2 pl-3 ${guideClass}`}>
          <button
            className="flex min-h-7 cursor-pointer items-center text-caption font-medium text-secondary transition-colors duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
            type="button"
            disabled={loading}
            onClick={() => {
              onRead()
              void history.loadActivities(runId)
            }}
          >
            {detailError ? 'Retry work log' : 'Show work log'}
          </button>
        </div>
      ) : null}
      {detailError ? (
        <p className="mt-1 pl-3.5 text-caption text-danger" role="alert">
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
    ? 'Copy unavailable for long messages'
    : copyResult === 'copying'
      ? 'Copying message'
      : copyResult === 'copied'
        ? 'Message copied'
        : copyResult === 'failed'
          ? 'Couldn’t copy message'
          : isUser
            ? 'Copy your message'
            : `Copy ${speaker} message`

  return (
    <div
      className={`pointer-events-none mt-1 flex h-6 shrink-0 items-center gap-1 whitespace-nowrap text-caption text-tertiary opacity-0 transition-opacity delay-150 duration-[160ms] ease-out-pact group-hover/message:delay-0 group-hover/message:opacity-100 group-focus-within/message:delay-0 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100 ${isUser ? 'self-end' : 'self-start'}`}
      data-pact-message-actions
    >
      <time dateTime={createdAt} title={fullDate} aria-label={fullDate} className="tabular-nums">
        {messageTimeFormatter.format(date)}
      </time>
      <button
        className="pointer-events-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40"
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
          className="pointer-events-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40"
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
      <span className="truncate">{details.join(' · ')}</span>
      {run.speedDetail ? (
        <>
          <button
            type="button"
            aria-label="Speed information"
            aria-describedby={tooltipId}
            className="peer grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
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
