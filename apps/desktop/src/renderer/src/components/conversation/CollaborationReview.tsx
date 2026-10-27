import { AlertCircle, FileText } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentRun,
  CollaborationAction,
  CollaborationDocument,
  CollaborationSession,
  CollaborationTask,
  ConversationPage,
  MessageCommentAnchor,
} from '@pact/contracts'

import {
  collaborationContinuationLimit,
  collaborationInputGate,
  collaborationInputProcessing,
} from '@pact/contracts'

import type { ProjectFileTarget } from './MessageMarkdown'
import type { MessageTextSelection } from './MessageSelectionSurface'

import { CollaborationDocumentView } from './CollaborationDocumentView'

export type PlanTextSelection = MessageTextSelection & {
  plan: NonNullable<MessageCommentAnchor['plan']>
  content: string
  textBasis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  contentHash?: string | undefined
}
export type ReportTextSelection = MessageTextSelection & {
  report: NonNullable<MessageCommentAnchor['report']>
  content: string
  textBasis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  contentHash?: string | undefined
}
type DisplayedCollaborationAction = Exclude<
  CollaborationAction,
  'request_plan_supplement' | 'request_code_supplement' | 'confirm_supplement'
>

const agentName = (id: 'claude' | 'codex'): string => (id === 'claude' ? 'Claude Code' : 'Codex')
const verdictLabel = {
  accepted: 'Accepted',
  changes_requested: 'Changes requested',
  needs_user: 'Waiting for your input',
  incomplete: 'Review incomplete',
}
const pauseLabel: Record<NonNullable<CollaborationTask['pauseReason']>, string> = {
  user_message: 'Collaboration paused',
  user: 'Collaboration paused',
  needs_user: 'Waiting for your input',
  restart: 'Paused after reopening Pact',
  limit: 'Session limit reached',
  failure: 'Collaboration needs attention',
  stopped: 'Collaboration stopped',
}

/** Natural answers own the report body; this footer owns provenance and current actions. */
export const CollaborationReview = memo(function CollaborationReview({
  session,
  run,
  latestRunId,
  disabled,
  onOpenProjectFile,
  onCreateReportComment,
  feedbackDraft = false,
  revealReport,
  revealReportRequestId,
  revealReportOffset,
  revealReportBasis,
  onReportReady,
  onTaskChange,
  renderedMessageId,
  onOpenPlan,
  onOpenSessionSettings,
}: {
  session: CollaborationSession
  run: AgentRun
  latestRunId?: string | undefined
  disabled: boolean
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onCreateReportComment?: ((selection: ReportTextSelection) => void) | undefined
  feedbackDraft?: boolean | undefined
  revealReport?: MessageCommentAnchor['report'] | undefined
  revealReportRequestId?: string | undefined
  revealReportOffset?: number | undefined
  revealReportBasis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  onReportReady?:
    | ((host: HTMLElement, onApplied?: () => void) => (() => void) | undefined)
    | undefined
  onTaskChange?: (() => void) | undefined
  renderedMessageId?: string | undefined
  onOpenPlan?: ((source: { runId: string; messageId: string; version: number }) => void) | undefined
  onOpenSessionSettings?: (() => void) | undefined
}) {
  const [view, setView] = useState<Extract<ConversationPage, { scope: 'collaboration' }>['view']>()
  const [loadedAt, setLoadedAt] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const running = ['starting', 'running', 'recovering'].includes(run.status)
  const historical = run.id !== latestRunId
  const reportVersion = `${run.updatedAt}:${session.settingsRevision}`
  const revealKey =
    revealReport?.runId === run.id
      ? `${revealReportRequestId ?? ''}:${revealReportOffset ?? ''}`
      : ''
  const reportNavigation = useRef('')
  const completeReportNavigation = useCallback(
    (host: HTMLElement): (() => void) | undefined => {
      if (!revealKey || reportNavigation.current === revealKey) return undefined
      return onReportReady?.(host, () => {
        reportNavigation.current = revealKey
      })
    },
    [revealKey, onReportReady],
  )
  useEffect(() => {
    let current = true
    if (running) return undefined
    void window.pact
      .getConversation({
        scope: 'collaboration',
        sessionId: session.id,
        runId: run.id,
        projection: 'report',
      })
      .then((response) => {
        if (!current) return undefined
        if (response.ok && response.value.scope === 'collaboration') {
          setView(response.value.view)
          setLoadedAt(reportVersion)
          setReadError('')
        } else if (!response.ok) setReadError(response.error.message)
        return undefined
      })
      .catch(() => {
        if (current) setReadError('The collaboration result could not be loaded. Try again.')
      })
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit refresh after an action receipt or failed read.
  }, [session.id, run.id, reportVersion, running, refresh])
  const task = view?.task
  const error = actionError || readError
  const actionable = !historical && Boolean(view?.actionable) && loadedAt === reportVersion
  const act = async (action: CollaborationAction): Promise<void> => {
    if (
      !task ||
      busy ||
      disabled ||
      (feedbackDraft && action !== 'recover_plan' && action !== 'pause') ||
      !actionable
    )
      return
    // Retired requests may still have durable gates; retain cancellation through the existing actions.
    const decision = action === 'cancel_supplement' ? view?.relayDecision : undefined
    if (action === 'cancel_supplement' && !decision) return
    setBusy(true)
    setActionError('')
    try {
      const response = await window.pact.actOnCollaboration({
        sessionId: session.id,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: crypto.randomUUID(),
        action,
        ...(decision ? { decision: { id: decision.id, revision: decision.revision } } : {}),
      })
      if (!response.ok)
        setActionError(
          response.error.code === 'INTERNAL'
            ? 'This action could not start. Refresh and try again.'
            : response.error.message,
        )
      setRefresh((value) => value + 1)
      onTaskChange?.()
    } catch {
      setActionError('The action receipt is unavailable. Refresh before trying again.')
      setRefresh((value) => value + 1)
      onTaskChange?.()
    } finally {
      setBusy(false)
    }
  }
  if (running) return null
  if (!task)
    return error ? (
      <p role="alert" className="mt-2 text-caption text-status-danger-foreground">
        {error}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Retry read
        </button>
      </p>
    ) : null
  const stage = run.collaboration?.stage ?? task.stage
  const planVersion =
    run.collaboration?.planVersion ??
    (view?.planSource?.runId === run.id ? task.planVersion : undefined) ??
    (task.review?.runId === run.id ? task.review.planReference?.version : undefined)
  const review = task.review?.runId === run.id ? task.review : undefined
  const planSync = view?.planSync
  const inputState = collaborationInputProcessing(task)
  const paused = actionable && task.status !== 'complete' && task.automation === 'paused'
  const inputGate = collaborationInputGate(task)
  const continuationLimit =
    actionable && !planSync && !inputGate
      ? collaborationContinuationLimit(task, session.settings)
      : undefined
  const nextStep = planSync || inputGate || continuationLimit ? undefined : view?.nextStep
  const resumedLimit =
    paused && task.pauseReason === 'limit' && !continuationLimit && !planSync && !inputGate
  const limitName = continuationLimit
    ? {
        plan_review: { step: 'Plan review', setting: 'Plan reviews' },
        code_review: { step: 'Code review', setting: 'Code reviews' },
        repair: { step: 'Repair', setting: 'Repair attempts' },
      }[continuationLimit.stage]
    : undefined
  const duplicateLimitNotice = [
    'The Session discussion limit has been reached.',
    'The Session review limit has been reached.',
    'The Session repair limit has been reached.',
  ].includes(task.notice ?? '')
  const duplicateRestartNotice =
    task.pauseReason === 'restart' &&
    task.notice ===
      'Application restarted. Check the original execution, then continue collaboration.' &&
    run.status === 'completed' &&
    run.nativeOutcome === 'completed' &&
    run.nativeEffectsState === 'settled' &&
    run.dispatchPhase === 'ended' &&
    session.activity.state === 'idle' &&
    !planSync &&
    !inputGate
  const readyToContinue =
    stage === 'reply' &&
    inputState.settled?.runId === run.id &&
    paused &&
    task.pauseReason === 'user_message' &&
    !planSync &&
    !inputGate &&
    !continuationLimit &&
    view?.availableActions?.includes('resume')
  const replyLabel = planSync
    ? 'Plan recovery required'
    : inputState.decision?.runId === run.id
      ? actionable
        ? 'Waiting for your answer'
        : 'Asked for your input'
      : inputState.settled?.runId === run.id
        ? readyToContinue
          ? 'Ready to continue'
          : 'Reply complete'
        : 'Reply to your message'
  const label =
    stage === 'plan'
      ? `Plan${planVersion ? ` · v${planVersion}` : ''}`
      : stage === 'plan_review'
        ? `Plan review${planVersion ? ` · v${planVersion}` : ''}`
        : stage === 'code_review'
          ? 'Code review'
          : stage === 'implement' || stage === 'repair'
            ? 'Changes'
            : stage === 'respond'
              ? 'Review response'
              : replyLabel
  const actions = actionable
    ? (view?.availableActions ?? []).filter(
        (action): action is DisplayedCollaborationAction =>
          action !== 'request_plan_supplement' &&
          action !== 'request_code_supplement' &&
          action !== 'confirm_supplement' &&
          action !== 'continue' &&
          action !== 'pause' &&
          (!continuationLimit || !['resume', 'retry'].includes(action)) &&
          (!inputGate || action === 'recover_plan'),
      )
    : []
  const actionLabel = (action: DisplayedCollaborationAction): string =>
    ({
      execute: `Implement plan · ${agentName(task.owner)}`,
      respond: `Respond · ${agentName(task.owner)}`,
      repair: `Repair · ${agentName(task.owner)}`,
      pause: 'Pause collaboration',
      resume: 'Continue collaboration',
      recover_plan: planSync?.kind === 'response' ? 'Restore plan response' : 'Restore saved plan',
      retry: `Retry · ${agentName(task.actor)}`,
      continue: 'Continue collaboration',
      cancel_supplement: 'Cancel scheduling action',
    })[action]
  const reportDocument =
    view?.documents?.find((entry) => entry.key === 'report')?.source ??
    (review ? review.document : undefined)
  const showReportSource = Boolean(
    reportDocument && (revealKey || !renderedMessageId) && stage !== 'plan',
  )
  return (
    <section
      aria-label="Pact collaboration result"
      data-pact-collaboration-run-id={run.id}
      className="pact-review-card mt-2 mb-7 w-full min-w-0 max-w-[72ch] self-start text-caption"
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1 text-secondary">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span>{label}</span>
        {review ? <span>· {verdictLabel[review.verdict]}</span> : null}
        {stage === 'plan' && onOpenPlan && view?.planSource && planVersion ? (
          <button
            type="button"
            onClick={() => onOpenPlan({ ...view.planSource!, version: planVersion })}
            className="min-h-7 rounded-control px-2 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            Open plan
          </button>
        ) : null}
        {actionable && task.status === 'complete' ? <span>· Complete</span> : null}
      </div>
      {showReportSource && reportDocument ? (
        <ReportSource
          sessionId={session.id}
          run={run}
          source={reportDocument}
          taskId={task.id}
          navigationId={revealKey}
          onSourceReady={completeReportNavigation}
          basis={revealReportBasis}
          aroundOffset={revealReportOffset}
          renderedMessageId={renderedMessageId}
          onOpenProjectFile={onOpenProjectFile}
          onCreateComment={onCreateReportComment}
        />
      ) : null}
      {planSync ? (
        <p className="mt-1 text-secondary">
          {planSync.kind === 'response'
            ? 'The response for the existing plan needs recovery before review.'
            : 'The Agent finished, but its latest plan has not been synced to Pact.'}
          {planSync.retainedVersion > 0
            ? ` Version ${planSync.retainedVersion} is still preserved.`
            : ''}
          {planSync.kind === 'response'
            ? ' Restore the saved response, then continue for independent review.'
            : ' Restore the saved plan, then continue for independent review.'}
        </p>
      ) : continuationLimit && limitName ? (
        <p className="mt-1 text-secondary">
          {limitName.step} limit reached ({continuationLimit.used}/{continuationLimit.maximum}).
          {' Increase '}
          {limitName.setting} in Session settings to continue.
        </p>
      ) : paused && !inputGate ? (
        <p className="mt-1 text-secondary">
          {readyToContinue || resumedLimit
            ? nextStep
              ? `Next: ${nextStep}.`
              : 'Collaboration stays paused until you continue.'
            : `${pauseLabel[task.pauseReason ?? 'user']}${nextStep ? `. Next: ${nextStep}.` : '.'}`}
        </p>
      ) : null}
      {actionable &&
      !planSync &&
      (!inputGate || inputGate === 'incomplete') &&
      task.status !== 'complete' &&
      task.notice &&
      !duplicateLimitNotice &&
      !duplicateRestartNotice &&
      // Retained tasks may contain this older, redundant confirmation; keep other notices.
      (!readyToContinue ||
        task.notice !==
          'Your reply has been processed. Continue collaboration when you are ready.') ? (
        <p className="mt-1 whitespace-pre-wrap text-secondary">{task.notice}</p>
      ) : null}
      {actionable && view?.received?.state === 'blocked' ? (
        <p className="mt-1 text-secondary">Your message delivery needs attention.</p>
      ) : null}
      {actions.length || (continuationLimit && onOpenSessionSettings) ? (
        <div
          aria-label="Pact Proposal"
          className="pact-review-actions mt-2 flex flex-wrap items-center gap-1.5"
        >
          {actions.map((action, index) => (
            <button
              key={action}
              type="button"
              disabled={
                disabled ||
                busy ||
                (feedbackDraft && action !== 'recover_plan' && action !== 'pause') ||
                !actionable
              }
              onClick={() => void act(action)}
              className={`min-h-8 rounded-control px-3 py-1.5 text-caption font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45 ${index === 0 && action !== 'pause' ? 'bg-surface-inverse text-inverse hover:opacity-90' : 'text-secondary hover:bg-surface-muted hover:text-primary'}`}
            >
              {busy ? (action === 'recover_plan' ? 'Restoring…' : 'Sending…') : actionLabel(action)}
            </button>
          ))}
          {continuationLimit && onOpenSessionSettings ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={onOpenSessionSettings}
              className="min-h-8 rounded-control bg-surface-inverse px-3 py-1.5 text-caption font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-45"
            >
              Session settings
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-status-danger-foreground">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            {error}{' '}
            <button
              type="button"
              className="underline"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh
            </button>
          </span>
        </p>
      ) : null}
    </section>
  )
})

function ReportSource({
  sessionId,
  run,
  source,
  taskId,
  navigationId,
  onSourceReady,
  aroundOffset,
  basis,
  renderedMessageId,
  onOpenProjectFile,
  onCreateComment,
}: {
  sessionId: string
  run: AgentRun
  source: CollaborationDocument
  taskId: string
  navigationId: string
  onSourceReady?: ((host: HTMLElement) => (() => void) | undefined) | undefined
  aroundOffset?: number | undefined
  basis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  renderedMessageId?: string | undefined
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onCreateComment?: ((selection: ReportTextSelection) => void) | undefined
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sourceReady = useCallback(
    () => (hostRef.current ? onSourceReady?.(hostRef.current) : undefined),
    [onSourceReady],
  )
  return (
    <div
      ref={hostRef}
      className="mt-2 text-body"
      data-pact-report-run-id={run.id}
      data-pact-report-key="summary"
      data-pact-message-id={renderedMessageId ?? run.userMessageId}
    >
      <CollaborationDocumentView
        key={`${source.id}:${navigationId}:${aroundOffset ?? ''}:${basis ?? ''}`}
        sessionId={sessionId}
        runId={run.id}
        source={source}
        displayContext={{ taskId }}
        aroundOffset={aroundOffset}
        basis={basis}
        onReady={sourceReady}
        messageId={run.userMessageId}
        onOpenProjectFile={onOpenProjectFile}
        onCreateComment={
          onCreateComment
            ? (selection) =>
                onCreateComment({
                  ...selection,
                  report: { runId: run.id, target: { type: 'summary' } },
                  content: '',
                })
            : undefined
        }
      />
    </div>
  )
}
