import { AlertCircle, ChevronDown, FileText } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
  collaborationPendingPhase,
  collaborationPendingWork,
  collaborationReportMarkdown,
  collaborationSubmission,
} from '@pact/contracts'

import type { MessageTextSelection } from './MessageSelectionSurface'

import { readableCollaborationText } from '../../../../shared/collaboration-display-text'
import { CollaborationDocumentView } from './CollaborationDocumentView'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'

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

/** Transcript records contain the conclusion, issue summaries and one current Proposal. */
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
  onDetailRead,
  renderedMessageId,
  onOpenTodo,
  onOpenPlan,
}: {
  session: CollaborationSession
  run: AgentRun
  latestRunId?: string | undefined
  disabled: boolean
  onIterate?: (() => void) | undefined
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
  onDetailRead?: (() => void) | undefined
  renderedMessageId?: string | undefined
  onOpenTodo?:
    | ((target: { taskId: string; todoId: string; todoRevision: number }) => void)
    | undefined
  onOpenPlan?: ((source: { runId: string; messageId: string; version: number }) => void) | undefined
}) {
  const [view, setView] = useState<Extract<ConversationPage, { scope: 'collaboration' }>['view']>()
  const [loadedAt, setLoadedAt] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<boolean>()
  const reportRef = useRef<HTMLElement>(null)
  const reportNavigation = useRef({ opened: '', pending: '' })
  const running = ['starting', 'running', 'recovering'].includes(run.status)
  const historical = run.id !== latestRunId
  const revealKey =
    revealReport?.runId === run.id
      ? `${revealReportRequestId ?? ''}:${revealReport.target.type}:${revealReportOffset ?? ''}`
      : ''
  const completeReportNavigation = useCallback(
    (host: HTMLElement): (() => void) | undefined => {
      if (!revealKey || reportNavigation.current.pending !== revealKey) return undefined
      return onReportReady?.(host, () => {
        if (reportNavigation.current.pending === revealKey) reportNavigation.current.pending = ''
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
          setLoadedAt(run.updatedAt)
          setReadError('')
        } else if (!response.ok) setReadError(response.error.message)
        return undefined
      })
      .catch(() => {
        if (current) setReadError('The result could not be loaded. Try again.')
      })
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Refresh is an explicit read nonce after an action receipt or failed source read.
  }, [session.id, run.id, run.updatedAt, running, refresh])
  useLayoutEffect(() => {
    if (!revealKey || !view?.accepted || reportNavigation.current.opened === revealKey) return
    reportNavigation.current = { opened: revealKey, pending: revealKey }
    setExpanded(true)
  }, [revealKey, view?.accepted])
  useLayoutEffect(() => {
    if (
      !expanded ||
      !view?.accepted ||
      view.documents?.some((entry) => entry.key === 'summary') ||
      reportNavigation.current.pending !== revealKey
    )
      return undefined
    const host = reportRef.current?.querySelector<HTMLElement>('[data-pact-report-key="summary"]')
    if (!host) return undefined
    return completeReportNavigation(host)
  }, [revealKey, view?.accepted, view?.documents, expanded, completeReportNavigation])
  const task = view?.task
  const error = actionError || readError
  const actionable = !historical && Boolean(view?.actionable) && loadedAt === run.updatedAt
  const act = async (action: CollaborationAction): Promise<void> => {
    if (
      !task ||
      busy ||
      disabled ||
      feedbackDraft ||
      (!actionable && !['resume_input', 'cancel_input'].includes(action))
    )
      return
    setBusy(true)
    setActionError('')
    try {
      const response = await window.pact.actOnCollaboration({
        sessionId: session.id,
        taskId: task.id,
        revision: task.revision,
        clientMessageId: crypto.randomUUID(),
        action,
        ...(['resume_input', 'cancel_input'].includes(action) && view?.received
          ? { receivedInputId: view.received.id }
          : {}),
      })
      if (!response.ok)
        setActionError(
          response.error.code === 'INTERNAL'
            ? 'This action could not start. Your saved work is preserved. Refresh and try again.'
            : response.error.message,
        )
      setRefresh((value) => value + 1)
    } catch {
      setActionError('The action receipt is unavailable. Refresh before trying again.')
      setRefresh((value) => value + 1)
    } finally {
      setBusy(false)
    }
  }
  const actionButton = (label: string, action: CollaborationAction, primary = false) => (
    <button
      type="button"
      disabled={disabled || busy || feedbackDraft || !actionable}
      onClick={() => void act(action)}
      className={`min-h-8 rounded-control px-3 py-1.5 text-caption font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45 ${primary ? 'bg-surface-inverse text-inverse hover:opacity-90' : 'text-secondary hover:bg-surface-muted hover:text-primary'}`}
    >
      {busy ? 'Sending…' : label}
    </button>
  )
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
  const result = view?.accepted ? task.result : undefined
  const phase = collaborationPendingPhase(task)
  const planning =
    task.kind === 'plan' &&
    task.approvedPlanVersion === undefined &&
    ['draft', 'discuss', 'clarify'].includes(phase.stage)
  const planSubmission =
    result?.submission === 'plan_submission' || result?.submission === 'plan_adoption'
  const planReview = result?.submission === 'plan_review'
  const pendingSubmission = collaborationSubmission(task)
  const pendingPlan = ['plan_submission', 'plan_adoption'].includes(pendingSubmission)
  const pendingReview = ['plan_review', 'code_review'].includes(pendingSubmission)
  const heading = planSubmission
    ? `Plan · v${task.planVersion}`
    : planReview
      ? `Review · v${result.reviewedPlan?.version ?? task.planVersion}`
      : task.reportFailure
        ? pendingPlan
          ? 'Plan'
          : 'Review'
        : task.stage === 'implement' || task.stage === 'repair'
          ? 'Changes'
          : ['respond', 'supplement', 'clarify'].includes(task.stage)
            ? 'Response'
            : 'Review'
  const issues = view?.accepted ? (view.todoSummaries ?? []) : []
  const documents = view?.documents ?? []
  const hasDetails = Boolean(
    (result && !planSubmission) ||
    issues.length ||
    task.reportFailure ||
    view?.received ||
    task.notice,
  )
  const cardExpanded = expanded ?? Boolean(!historical && task.reportFailure)
  const showProposal = actionable && !feedbackDraft && (task.status !== 'complete' || !planning)
  const pendingWork = collaborationPendingWork(task)
  return (
    <section
      ref={reportRef}
      aria-label="Pact collaboration result"
      className="pact-review-card mt-2 mb-7 w-full min-w-0 max-w-[72ch] self-start rounded-panel border border-border bg-surface-raised px-4 py-2.5 text-body"
    >
      <div className="flex min-h-7 items-center gap-2.5">
        <FileText
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary"
          strokeWidth={1.75}
        />
        <button
          type="button"
          aria-expanded={cardExpanded}
          disabled={!hasDetails}
          onClick={() => {
            onDetailRead?.()
            setExpanded(!cardExpanded)
          }}
          className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-control text-left focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default"
        >
          <h3
            className="min-w-0 flex-1 truncate text-body font-medium text-primary"
            title={heading}
          >
            {heading}
          </h3>
          {issues.length ? (
            <span className="shrink-0 text-caption text-secondary">
              {issues.length} {issues.length === 1 ? 'update' : 'updates'}
            </span>
          ) : null}
          {hasDetails ? (
            <ChevronDown
              aria-hidden="true"
              className={`size-4 shrink-0 text-secondary ${cardExpanded ? 'rotate-180' : ''}`}
              strokeWidth={1.75}
            />
          ) : null}
        </button>
        {planSubmission && onOpenPlan && view?.planSource ? (
          <button
            type="button"
            onClick={() => onOpenPlan({ ...view.planSource!, version: task.planVersion })}
            className="min-h-7 shrink-0 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            Open plan
          </button>
        ) : null}
      </div>
      {cardExpanded && hasDetails ? (
        <div className="pt-2">
          {result && !planSubmission ? (
            <ReportSource
              target={{ type: 'summary' }}
              task={task}
              run={run}
              navigationId={revealKey}
              documents={documents}
              onSourceReady={completeReportNavigation}
              basis={revealReportBasis}
              aroundOffset={revealReportOffset}
              renderedMessageId={renderedMessageId}
              onOpenProjectFile={onOpenProjectFile}
              onCreateComment={onCreateReportComment}
            />
          ) : null}
          {issues.length ? (
            <ul aria-label="Issue summaries" className="mt-2 space-y-0.5">
              {issues.map((item) => (
                <li key={`${item.id}:${item.revision}`}>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenTodo?.({
                        taskId: task.id,
                        todoId: item.id,
                        todoRevision: item.revision,
                      })
                    }
                    className="flex min-h-7 w-full items-start gap-2 rounded-control px-1 py-1 text-left text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {readableCollaborationText(item.title, {
                        taskId: task.id,
                        runId: run.id,
                        todoId: item.id,
                      })}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 -rotate-90"
                      strokeWidth={1.75}
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {task.reportFailure ? (
            <p className="text-caption text-secondary">
              {task.reportFailure === 'invalid'
                ? 'Submission needs correction.'
                : pendingPlan
                  ? 'Plan not submitted.'
                  : 'Review not submitted.'}
            </p>
          ) : null}
          {task.notice ? (
            <p className="mt-2 whitespace-pre-wrap text-caption text-secondary">
              {readableCollaborationText(task.notice, { taskId: task.id, runId: task.runId })}
            </p>
          ) : null}
          {task.reportFailure && !task.notice && task.noticeDocument ? (
            <div className="mt-2 text-caption text-secondary">
              <CollaborationDocumentView
                sessionId={session.id}
                runId={run.id}
                source={task.noticeDocument}
                messageId={run.userMessageId}
                displayContext={{ taskId: task.id }}
                onOpenProjectFile={onOpenProjectFile}
              />
            </div>
          ) : null}
          {view?.received ? (
            <output className="mt-2 block text-caption text-secondary">
              <span>{view.received.preview}</span>
              <p className="mt-1">
                {view.received.state === 'blocked'
                  ? 'Delivery needs attention'
                  : view.received.state === 'cancelled'
                    ? 'Cancelled before dispatch'
                    : 'Received'}{' '}
                · {agentName(view.received.actor)}
              </p>
              {view.received.state === 'blocked' ? (
                <button
                  type="button"
                  disabled={disabled || busy || feedbackDraft}
                  onClick={() => void act('resume_input')}
                  className="mt-1 min-h-7 rounded-control px-2 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Continue received message
                </button>
              ) : null}
              {view.received.state !== 'cancelled' ? (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => void act('cancel_input')}
                  className="mt-1 min-h-7 rounded-control px-2 text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Cancel received message
                </button>
              ) : null}
            </output>
          ) : null}
        </div>
      ) : null}
      {showProposal ? (
        <div
          aria-label="Pact Proposal"
          className="pact-review-actions mt-2 flex flex-wrap items-center gap-1.5"
        >
          {task.status === 'failed' ? (
            actionButton(
              task.reportFailure
                ? `${task.reportFailure === 'invalid' ? 'Correct and submit' : 'Submit'} ${pendingPlan ? 'plan' : pendingReview ? 'review' : 'report'} · ${agentName(task.actor)}`
                : `Retry · ${agentName(task.actor)}`,
              task.reportFailure ? 'submit_report' : 'retry',
              true,
            )
          ) : task.status === 'paused' ? (
            actionButton('Resume collaboration', 'resume', true)
          ) : task.status === 'complete' ? (
            <>
              <span className="text-caption text-secondary">Review complete</span>
              {actionButton('Review current changes · read-only', 'continue')}
            </>
          ) : planning ? (
            task.status === 'ready' ? (
              actionButton(`Implement plan · ${agentName(task.implementer)}`, 'execute', true)
            ) : (
              actionButton(
                `${task.actor === task.primary ? 'Review plan' : 'Update plan'} · ${agentName(task.actor === task.primary ? (task.primary === 'codex' ? 'claude' : 'codex') : task.primary)}`,
                'continue',
                true,
              )
            )
          ) : pendingWork && task.status !== 'questions' ? (
            task.questionPendingCount || task.unansweredCount ? null : (
              actionButton(
                `Continue ${pendingWork.stage === 'repair' ? 'repair' : 'implementation'} · ${agentName(pendingWork.actor)} · edits code`,
                'continue',
                true,
              )
            )
          ) : phase.stage === 'review' && task.status !== 'questions' ? (
            task.ledgerOpenCount + task.ledgerAwaitingCount > 0 ? (
              <>
                {actionButton(
                  `Respond · ${agentName(task.implementer)} · read-only`,
                  'respond',
                  true,
                )}
                {!task.questionPendingCount && !task.unansweredCount
                  ? actionButton(`Repair · ${agentName(task.implementer)} · edits code`, 'repair')
                  : null}
              </>
            ) : (
              actionButton('Review current changes · read-only', 'continue', true)
            )
          ) : task.status === 'questions' ? null : (
            actionButton(`Review changes · ${agentName(task.reviewer)}`, 'continue', true)
          )}
          <span className="sr-only">One click authorizes one Agent Turn.</span>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 text-caption text-status-danger-foreground"
        >
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
  task,
  run,
  navigationId,
  target,
  documents,
  onSourceReady,
  aroundOffset,
  basis,
  renderedMessageId,
  onOpenProjectFile,
  onCreateComment,
}: {
  task: CollaborationTask
  run: AgentRun
  navigationId: string
  target: NonNullable<MessageCommentAnchor['report']>['target']
  documents: Array<{ key: string; source: CollaborationDocument }>
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
  const result = task.result!
  const document = documents.find(
    (entry) => entry.key === (target.type === 'summary' ? 'summary' : `feedback:${target.id}`),
  )?.source
  const content = document ? '' : collaborationReportMarkdown(result, target)
  return (
    <div
      ref={hostRef}
      data-pact-report-run-id={run.id}
      data-pact-report-key={target.type === 'summary' ? 'summary' : `feedback:${target.id}`}
      data-pact-message-id={renderedMessageId ?? run.userMessageId}
    >
      {document ? (
        <CollaborationDocumentView
          key={`${document.id}:${navigationId}:${aroundOffset ?? ''}:${basis ?? ''}`}
          sessionId={task.sessionId}
          runId={run.id}
          source={document}
          displayContext={{ taskId: task.id }}
          aroundOffset={aroundOffset}
          basis={basis}
          onReady={sourceReady}
          messageId={run.userMessageId}
          onOpenProjectFile={onOpenProjectFile}
          onCreateComment={
            onCreateComment
              ? (selection) =>
                  onCreateComment({ ...selection, report: { runId: run.id, target }, content: '' })
              : undefined
          }
        />
      ) : (
        <MessageMarkdown
          content={content}
          messageId={run.userMessageId}
          onOpenProjectFile={onOpenProjectFile}
          onCreateComment={
            onCreateComment
              ? (selection) =>
                  onCreateComment({ ...selection, report: { runId: run.id, target }, content })
              : undefined
          }
        />
      )}
    </div>
  )
}
