import { AlertCircle, FileText } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type {
  AgentRun,
  CollaborationAction,
  CollaborationActionInput,
  CollaborationDocument,
  CollaborationSession,
  ConversationPage,
  MessageCommentAnchor,
} from '@pact/contracts'

import {
  collaborationContinuationLimit,
  collaborationActor,
  collaborationInputGate,
  collaborationInputProcessing,
  defaultTaskStageRoles,
  isCollaborationOpenMode,
  otherAgent,
} from '@pact/contracts'

import type { ProjectFileTarget } from './MessageMarkdown'
import type { MessageTextSelection } from './MessageSelectionSurface'

import { CollaborationDocumentView } from './CollaborationDocumentView'
import { TaskPlanConfirmation } from './TaskPlanConfirmation'

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
const agentName = (id: 'claude' | 'codex'): string => (id === 'claude' ? 'Claude Code' : 'Codex')
const verdictLabel = {
  accepted: 'Accepted',
  changes_requested: 'Changes requested',
  needs_user: 'Waiting for your input',
  incomplete: 'Review incomplete',
}
const genericPauseNotice = new Set([
  'Collaboration is paused. Continue when ready.',
  'Automatic collaboration is paused. Your message will be answered next.',
  'Your reply has been processed. Continue collaboration when you are ready.',
])
const proposalActionClass =
  'min-h-8 shrink-0 whitespace-nowrap rounded-control border px-2.5 py-1.5 text-caption font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45'

/** Natural answers own the report body; this footer owns provenance and current actions. */
export const CollaborationReview = memo(function CollaborationReview({
  session,
  run,
  latestRunId,
  disabled,
  continuationBlocked = false,
  replyBodyComplete: _replyBodyComplete = false,
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
  nativePresentationSuspended = false,
}: {
  session: CollaborationSession
  run: AgentRun
  latestRunId?: string | undefined
  disabled: boolean
  continuationBlocked?: boolean
  replyBodyComplete?: boolean
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
  nativePresentationSuspended?: boolean | undefined
}) {
  const [view, setView] = useState<Extract<ConversationPage, { scope: 'collaboration' }>['view']>()
  const [loadedAt, setLoadedAt] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const failedAction = useRef<{ taskId: string; revision: number } | undefined>(undefined)
  const planTrigger = useRef<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [planDecision, setPlanDecision] = useState<
    | {
        input: CollaborationActionInput
        currentImplementer: string
        nextImplementer: string
        scope: object
        error?: string | undefined
      }
    | undefined
  >(undefined)
  const draftHintId = useId()
  const refreshStatus = (): void => {
    setRefreshing(true)
    setRefresh((value) => value + 1)
  }
  const running = ['starting', 'running', 'recovering'].includes(run.status)
  const historical = run.id !== latestRunId
  const reportVersion = `${run.updatedAt}:${session.settingsRevision}:${run.workspaceChanges?.revision ?? ''}:${run.workspaceChanges?.state ?? ''}`
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
          const next = response.value.view.task
          if (
            next &&
            failedAction.current &&
            (next.id !== failedAction.current.taskId ||
              (next.revision !== failedAction.current.revision && next.status !== 'failed'))
          ) {
            setActionError('')
            failedAction.current = undefined
          }
        } else if (!response.ok) setReadError(response.error.message)
        return undefined
      })
      .catch(() => {
        if (current) setReadError('The collaboration result could not be loaded. Try again.')
      })
      .finally(() => {
        if (current) setRefreshing(false)
      })
    return () => {
      current = false
    }
  }, [session.id, run.id, reportVersion, running, refresh])
  const task = view?.task
  const error = actionError || readError
  const actionable = !historical && Boolean(view?.actionable) && loadedAt === reportVersion
  // An ephemeral scope token retires a frozen decision on Session/task/history change;
  // the dependencies are intentional even though the memoized value ignores them.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const decisionScope = useMemo(() => ({}), [session.id, task?.id, historical])
  const currentPlanDecision =
    planDecision && planDecision.scope === decisionScope && !historical ? planDecision : undefined
  const act = async (
    action: CollaborationAction,
    confirmedInput?: CollaborationActionInput,
  ): Promise<boolean> => {
    if (!task || busy || disabled || (feedbackDraft && action !== 'recover_plan') || !actionable)
      return false
    setBusy(true)
    if (action !== 'recover_plan') setActionError('')
    failedAction.current = { taskId: task.id, revision: task.revision }
    try {
      const response = await window.pact.actOnCollaboration(
        confirmedInput ?? {
          sessionId: session.id,
          taskId: task.id,
          revision: task.revision,
          clientMessageId: crypto.randomUUID(),
          action,
        },
      )
      if (!response.ok) {
        const message =
          response.error.code === 'INTERNAL'
            ? 'This action could not start. Refresh and try again.'
            : response.error.message
        setActionError(message)
        if (confirmedInput)
          setPlanDecision((current) =>
            current?.input.clientMessageId === confirmedInput.clientMessageId
              ? { ...current, error: message }
              : current,
          )
        refreshStatus()
        onTaskChange?.()
        return false
      }
      refreshStatus()
      onTaskChange?.()
      return true
    } catch {
      const message = 'The action receipt is unavailable. Refresh before trying again.'
      setActionError(message)
      if (confirmedInput)
        setPlanDecision((current) =>
          current?.input.clientMessageId === confirmedInput.clientMessageId
            ? { ...current, error: message }
            : current,
        )
      refreshStatus()
      onTaskChange?.()
      return false
    } finally {
      setBusy(false)
    }
  }
  const confirmPlanDecision = (): void => {
    if (!currentPlanDecision || busy) return
    const submitted = currentPlanDecision.input.clientMessageId
    void act(currentPlanDecision.input.action, currentPlanDecision.input).then((sent) => {
      setPlanDecision((current) =>
        current?.input.clientMessageId !== submitted
          ? current
          : sent
            ? undefined
            : {
                ...current,
                error: current.error ?? 'This Plan decision could not be recorded. Try again.',
              },
      )
      return undefined
    })
  }
  if (running) return null
  if (!task)
    return error ? (
      <p role="alert" className="mt-2 text-caption text-status-danger-foreground">
        {error}{' '}
        <button type="button" className="underline" onClick={() => refreshStatus()}>
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
  const runPublishedPlan =
    (stage === 'plan' && Boolean(planVersion)) ||
    (view?.planSource?.runId === run.id && Boolean(planVersion))
  const runFailedOrStopped =
    (!historical && task.status === 'failed' && task.runId === run.id) ||
    ['failed', 'interrupted'].includes(run.status)
  const runStopped =
    (task.pauseReason === 'stopped' && task.runId === run.id) || run.failureKind === 'user_stopped'
  const questionCardActive = Boolean(
    actionable && inputState.decision && inputGate === 'needs_reply' && !planSync,
  )
  const isEndedFinalRun = Boolean(task.ending && run.id === task.runId)
  const showRestartPaused =
    !historical &&
    !isCollaborationOpenMode(task) &&
    paused &&
    task.pauseReason === 'restart' &&
    !planSync &&
    !inputGate
  let label: string | undefined
  if (!historical && planSync) label = 'Plan recovery required'
  else if (runFailedOrStopped) label = runStopped ? 'Stopped' : 'Failed'
  else if (stage === 'plan_review') {
    if (!questionCardActive) label = `Plan review${planVersion ? ` · v${planVersion}` : ''}`
  } else if (stage === 'code_review') {
    if (!questionCardActive) label = 'Code review'
  } else if (runPublishedPlan) {
    if (!questionCardActive) label = planVersion ? `Plan v${planVersion}` : 'Plan'
  } else if (showRestartPaused) {
    label = 'Paused'
  }
  const showStageLabel = Boolean(label)
  const actions = actionable
    ? (view?.availableActions ?? []).filter(
        (action): action is CollaborationAction =>
          (!continuationBlocked || action !== 'resume') &&
          (!continuationLimit || !['resume', 'retry'].includes(action)) &&
          (!inputGate || action === 'recover_plan') &&
          !(action === 'recover_plan' && actionError),
      )
    : []
  const draftBlocksActions = feedbackDraft && actions.some((action) => action !== 'recover_plan')
  const codeRoles = task.stageRoles ?? defaultTaskStageRoles(task.owner)
  const canOpenLimitSettings = Boolean(continuationLimit && onOpenSessionSettings)
  const actionLabel = (action: CollaborationAction): string =>
    ({
      execute: `Implement plan · ${agentName(
        isCollaborationOpenMode(task) && task.review
          ? otherAgent(task.review.actor)
          : collaborationActor(task, 'implement'),
      )}`,
      review_plan: `Review plan · ${agentName(
        isCollaborationOpenMode(task) && task.unreviewedPlanActor
          ? otherAgent(task.unreviewedPlanActor)
          : collaborationActor(task, 'plan_review'),
      )}`,
      review_code: `Review code · ${agentName(
        task.unreviewedCodeActor
          ? otherAgent(task.unreviewedCodeActor)
          : collaborationActor(task, 'code_review'),
      )}`,
      fix:
        task.review?.runId === task.runId && task.review.stage === 'plan_review'
          ? `Update plan · ${agentName(otherAgent(task.review.actor))}`
          : `Fix issues · ${agentName(
              task.review ? otherAgent(task.review.actor) : collaborationActor(task, 'repair'),
            )}`,
      swap_code_roles: 'Swap implementer',
      resume: `Update plan · ${agentName(collaborationActor(task, 'plan'))}`,
      recover_plan: planSync?.kind === 'response' ? 'Restore plan response' : 'Restore saved plan',
      retry: `Retry · ${agentName(task.actor)}`,
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
      className="pact-review-card mt-2 mb-7 w-full min-w-0 self-start text-caption empty:hidden"
    >
      {showStageLabel ? (
        <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1 text-secondary">
          <FileText aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{label}</span>
          {review && (stage === 'plan_review' || stage === 'code_review') ? (
            <span>· {verdictLabel[review.verdict]}</span>
          ) : null}
          {runPublishedPlan && onOpenPlan && view?.planSource && planVersion ? (
            <button
              type="button"
              onClick={() => onOpenPlan({ ...view.planSource!, version: planVersion })}
              className="min-h-7 rounded-control px-2 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            >
              Open plan
            </button>
          ) : null}
          {isEndedFinalRun ? <span>· Ended</span> : null}
        </div>
      ) : null}
      {isEndedFinalRun && !showStageLabel ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-secondary">
          <span>Ended</span>
        </div>
      ) : null}
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
      {planSync && !actionError ? (
        <p className="mt-1 text-secondary">
          {planSync.kind === 'response'
            ? 'Restore the saved response to continue.'
            : 'Restore the saved plan to continue.'}
        </p>
      ) : continuationLimit ? (
        <p className="mt-1 text-secondary">
          Plan review limit reached (
          {continuationLimit.used > continuationLimit.maximum
            ? `${continuationLimit.used} used; Session limit ${continuationLimit.maximum}`
            : `${continuationLimit.used}/${continuationLimit.maximum}`}
          ).
        </p>
      ) : null}
      {actionable &&
      !planSync &&
      !inputGate &&
      !questionCardActive &&
      task.status !== 'complete' &&
      !runStopped &&
      task.notice &&
      !duplicateLimitNotice &&
      !duplicateRestartNotice &&
      // Retained tasks may contain these older generic confirmations; keep other notices.
      !genericPauseNotice.has(task.notice) &&
      (!continuationLimit || runFailedOrStopped) ? (
        <p className="mt-1 whitespace-pre-wrap text-secondary">{task.notice}</p>
      ) : null}
      {actionable && view?.received?.state === 'blocked' ? (
        <p className="mt-1 text-secondary">Your message delivery needs attention.</p>
      ) : null}
      {draftBlocksActions ? (
        <p id={draftHintId} className="sr-only">
          Send or clear your draft before continuing this task.
        </p>
      ) : null}
      {actions.length || canOpenLimitSettings ? (
        <div
          aria-label="Pact Proposal"
          className="pact-review-actions mt-2 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto"
          data-compact-targets={actions.length > 2}
        >
          {actions.map((action, index) => {
            const actionText = actionLabel(action)
            const agentSeparator = actionText.lastIndexOf(' · ')
            const draftBlocked = draftBlocksActions && action !== 'recover_plan'
            const title = draftBlocked
              ? `${actionText}. Send or clear your draft first.`
              : actionText
            return (
              <button
                key={action}
                type="button"
                disabled={
                  disabled || busy || (feedbackDraft && action !== 'recover_plan') || !actionable
                }
                aria-label={actionText}
                title={title}
                aria-describedby={draftBlocked ? draftHintId : undefined}
                onClick={(event) => {
                  if (action === 'swap_code_roles') {
                    planTrigger.current = event.currentTarget
                    setPlanDecision({
                      currentImplementer: agentName(codeRoles.codeAuthor),
                      nextImplementer: agentName(codeRoles.codeReviewer),
                      scope: decisionScope,
                      input: {
                        sessionId: session.id,
                        taskId: task.id,
                        revision: task.revision,
                        clientMessageId: crypto.randomUUID(),
                        action,
                      },
                    })
                  } else void act(action)
                }}
                className={`${proposalActionClass} ${
                  index === 0
                    ? 'border-transparent bg-surface-inverse text-inverse hover:opacity-90'
                    : 'border-border bg-surface-muted text-primary hover:bg-surface-raised'
                }`}
              >
                {busy ? (
                  action === 'recover_plan' ? (
                    'Restoring…'
                  ) : action === 'swap_code_roles' ? (
                    'Switching…'
                  ) : (
                    'Sending…'
                  )
                ) : agentSeparator === -1 ? (
                  actionText
                ) : (
                  <>
                    {actionText.slice(0, agentSeparator)}
                    <span className="pact-review-action-agent">
                      {actionText.slice(agentSeparator)}
                    </span>
                  </>
                )}
              </button>
            )
          })}
          {canOpenLimitSettings ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={onOpenSessionSettings}
              className={`${proposalActionClass} ${
                actions.length === 0
                  ? 'border-transparent bg-surface-inverse text-inverse hover:opacity-90'
                  : 'border-border bg-surface-muted text-primary hover:bg-surface-raised'
              }`}
            >
              Session settings
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-status-danger-foreground"
        >
          <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            {planSync && actionError ? "Couldn't restore the plan. Your plan is saved." : error}
          </span>
          <button
            type="button"
            disabled={
              busy || refreshing || (Boolean(planSync && actionError) && (disabled || !actionable))
            }
            className="min-h-8 rounded-control px-2 text-caption font-medium text-primary underline underline-offset-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
            onClick={() => (planSync && actionError ? void act('recover_plan') : refreshStatus())}
          >
            {busy ? 'Restoring…' : refreshing ? 'Checking…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {currentPlanDecision ? (
        <TaskPlanConfirmation
          currentImplementer={currentPlanDecision.currentImplementer}
          nextImplementer={currentPlanDecision.nextImplementer}
          busy={busy}
          disabled={disabled || !actionable}
          suspended={nativePresentationSuspended}
          error={currentPlanDecision.error}
          onCancel={() => {
            if (busy) return
            setPlanDecision(undefined)
            const trigger = planTrigger.current
            planTrigger.current = null
            if (trigger?.isConnected) queueMicrotask(() => trigger.focus())
          }}
          onConfirm={confirmPlanDecision}
        />
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
