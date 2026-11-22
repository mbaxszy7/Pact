import { FileText, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { agentDisplayName, type CollaborationDocument, type RuntimeAgentId } from '@pact/contracts'

import type { PlanTextSelection } from './CollaborationReview'

import { CollaborationDocumentView } from './CollaborationDocumentView'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'

export interface CurrentPlanDocument {
  taskId?: string | undefined
  runId: string
  messageId: string
  version: number
  author: RuntimeAgentId
  content: string
  document?: CollaborationDocument | undefined
  sessionId?: string | undefined
  aroundOffset?: number | undefined
  navigationId?: string | undefined
  endOffset?: number | undefined
  basis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  status: string
}

function planStatusBadgeClasses(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'ready' || normalized === 'accepted')
    return 'bg-status-ready-muted text-status-ready-foreground'
  if (
    normalized === 'needs update' ||
    normalized === 'changes requested' ||
    normalized === 'needs restore'
  )
    return 'bg-status-warning-muted text-status-warning-foreground'
  if (normalized === 'drafting' || normalized === 'in review')
    return 'bg-status-info-muted text-status-info-foreground'
  return 'border border-border bg-surface-muted text-secondary'
}

/** One context document; current plan or immutable Comment source, owned by ConversationView. */
export function CurrentPlanPanel({
  plan,
  loading,
  error,
  source = false,
  expanded = false,
  onExpandedChange,
  comments,
  onPlanReady,
  onRevealApplied,
  onClose,
  onRetry,
  onOpenProjectFile,
  onCreatePlanComment,
  latestVersion,
  onOpenLatest,
}: {
  plan?: CurrentPlanDocument | undefined
  loading: boolean
  error?: string | undefined
  source?: boolean | undefined
  expanded?: boolean | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  comments?: ReactNode
  onPlanReady?: ((host: HTMLElement) => (() => void) | undefined) | undefined
  onRevealApplied?: ((id: string) => void) | undefined
  onClose: () => void
  onRetry: () => void
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onCreatePlanComment?: ((selection: PlanTextSelection) => void) | undefined
  latestVersion?: number | undefined
  onOpenLatest?: (() => void) | undefined
}): React.JSX.Element {
  const planDocumentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const planRunId = plan?.runId
  const planVersion = plan?.version
  useLayoutEffect(() => {
    if (
      !plan?.document &&
      !loading &&
      !error &&
      planRunId &&
      planVersion !== undefined &&
      planDocumentRef.current
    )
      return onPlanReady?.(planDocumentRef.current)
    return undefined
  }, [plan?.document, planRunId, planVersion, loading, error, onPlanReady])
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={source ? 'Plan source' : 'Current plan'}
    >
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border px-panel py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-baseline gap-2 text-body font-medium text-primary">
              {source ? 'Earlier version' : plan ? `Plan v${plan.version}` : 'Current plan'}
              {source && plan ? (
                <span className="font-normal text-secondary">· v{plan.version}</span>
              ) : null}
            </h2>
            {source &&
            plan &&
            latestVersion !== undefined &&
            latestVersion > plan.version &&
            onOpenLatest ? (
              <button
                type="button"
                aria-label={`View latest plan version ${latestVersion}`}
                onClick={onOpenLatest}
                className="pact-pressable inline-flex min-h-7 cursor-pointer items-center rounded-xl bg-surface-inverse px-2.5 text-caption font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                View latest · v{latestVersion}
              </button>
            ) : null}
          </div>
          {plan ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-caption">
              <span
                className={`inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 font-medium ${planStatusBadgeClasses(plan.status)}`}
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                <span>
                  {agentDisplayName(plan.author)} · {plan.status}
                </span>
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {onExpandedChange ? (
            <button
              type="button"
              aria-label={expanded ? 'Restore plan panel' : 'Expand plan panel'}
              title={expanded ? 'Restore plan panel' : 'Expand plan panel'}
              onClick={() => onExpandedChange(!expanded)}
              className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            >
              {expanded ? (
                <Minimize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
              ) : (
                <Maximize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close context panel"
            onClick={onClose}
            className="pact-pressable grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div
        ref={scrollRef}
        data-pact-context-scroll
        style={{ overflowAnchor: 'none' }}
        className="min-h-0 flex-1 overflow-auto px-panel py-panel"
      >
        {error ? (
          <div role="alert" className="max-w-[70ch] text-caption text-secondary">
            <p>{error || 'Couldn’t load the plan.'}</p>
            <button
              type="button"
              onClick={onRetry}
              className="pact-pressable mt-group inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} /> Try again
            </button>
          </div>
        ) : plan ? (
          <div
            ref={planDocumentRef}
            className="pact-plan-document min-w-0"
            data-pact-plan-run-id={plan.runId}
            data-pact-plan-version={plan.version}
            data-pact-plan-message-id={plan.messageId}
            data-pact-message-id={plan.messageId}
          >
            {plan.document && plan.sessionId ? (
              <CollaborationDocumentView
                sessionId={plan.sessionId}
                runId={plan.runId}
                source={plan.document}
                displayContext={{ taskId: plan.taskId }}
                messageId={plan.messageId}
                aroundOffset={plan.aroundOffset}
                basis={plan.basis}
                continuous={{
                  viewport: scrollRef,
                  reveal:
                    plan.navigationId &&
                    plan.aroundOffset !== undefined &&
                    plan.endOffset !== undefined
                      ? {
                          id: plan.navigationId,
                          startOffset: plan.aroundOffset,
                          endOffset: plan.endOffset,
                        }
                      : undefined,
                  onRevealApplied,
                }}
                onOpenProjectFile={onOpenProjectFile}
                onReady={() =>
                  planDocumentRef.current ? onPlanReady?.(planDocumentRef.current) : undefined
                }
                onCreateComment={
                  onCreatePlanComment
                    ? (selection) =>
                        onCreatePlanComment({
                          ...selection,
                          plan: { runId: plan.runId, version: plan.version },
                          content: '',
                        })
                    : undefined
                }
              />
            ) : (
              <MessageMarkdown
                key={`${plan.runId}:${plan.version}`}
                content={plan.content}
                messageId={plan.messageId}
                onOpenProjectFile={onOpenProjectFile}
                onCreateComment={
                  onCreatePlanComment
                    ? (selection) =>
                        onCreatePlanComment({
                          ...selection,
                          plan: { runId: plan.runId, version: plan.version },
                          content: plan.content,
                        })
                    : undefined
                }
              />
            )}
          </div>
        ) : loading ? (
          <div aria-busy="true" aria-label="Loading current plan" className="space-y-group">
            <div className="h-4 w-2/3 animate-pulse rounded-control bg-surface-muted" />
            <div className="h-3 w-full animate-pulse rounded-control bg-surface-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded-control bg-surface-muted" />
          </div>
        ) : (
          <div className="mt-section text-caption text-secondary">
            <FileText aria-hidden="true" className="mb-group size-5" strokeWidth={1.75} />
            No plan yet
          </div>
        )}
      </div>
      {comments ? (
        <div className="max-h-[45%] shrink-0 overflow-auto border-t border-border bg-surface-raised p-panel">
          {comments}
        </div>
      ) : null}
    </section>
  )
}
