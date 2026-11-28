import { Check, ChevronDown, ChevronUp, LoaderCircle, Square, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { AgentActivity, ConversationPageActivity, RuntimeAgentId } from '@pact/contracts'

import type { ExpandedActivityBody, LoadMoreActivityBody } from './conversation-window'

import { speakerForegroundClass, speakerLineClass } from './conversation-view-helpers'
import { LargeActivityPreview } from './LargeBodyPreview'

const COLLAPSE_RETAIN_FALLBACK_MS = 260

interface AgentActivityListProps {
  activities: AgentActivity[]
  active: boolean
  agentId?: RuntimeAgentId | undefined
  defaultExpanded?: boolean
  preserveExpanded?: boolean
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  partial?: boolean
  truncationNotice?: string | undefined
  oversizedActivities?: Record<string, Extract<ConversationPageActivity, { kind: 'oversized' }>>
  expandedBody?: ExpandedActivityBody | undefined
  onLoadMoreBody?: LoadMoreActivityBody
}

export function AgentActivityList({
  activities,
  active,
  agentId,
  defaultExpanded = false,
  preserveExpanded = false,
  onExpandedChange,
  partial = false,
  truncationNotice,
  oversizedActivities,
  expandedBody,
  onLoadMoreBody,
}: AgentActivityListProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(active || defaultExpanded)
  // Exit-retained mount state keeps the timeline DOM present during the 0fr collapse transition
  // so CSS grid-template-rows animates smoothly without snapping closed on unmount.
  const [contentMounted, setContentMounted] = useState(active || defaultExpanded)
  const failedCount = activities.filter((activity) => activity.status === 'failed').length
  const stoppedCount = activities.filter((activity) => activity.status === 'interrupted').length
  const wasActiveRef = useRef(active)
  const wasDefaultExpandedRef = useRef(defaultExpanded)
  const headerRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()

  useEffect(() => {
    if (wasActiveRef.current && !active && failedCount === 0 && !preserveExpanded)
      setExpanded(false)
    if (!wasActiveRef.current && active) {
      setContentMounted(true)
      setExpanded(true)
    }
    wasActiveRef.current = active
  }, [active, failedCount, preserveExpanded])

  useEffect(() => {
    if (!wasDefaultExpandedRef.current && defaultExpanded) {
      setContentMounted(true)
      setExpanded(true)
    }
    wasDefaultExpandedRef.current = defaultExpanded
  }, [defaultExpanded])

  useEffect(() => {
    if (expanded || !contentMounted) return undefined
    const timer = window.setTimeout(() => setContentMounted(false), COLLAPSE_RETAIN_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [expanded, contentMounted])

  if (activities.length === 0) return null

  const label = active
    ? `Working · ${activities.length} ${partial ? 'steps shown' : activities.length === 1 ? 'step' : 'steps'}`
    : `Work log · ${activities.length} ${partial ? 'steps shown' : activities.length === 1 ? 'step' : 'steps'}`
  const guideBorderClass = agentId ? speakerLineClass(agentId) : 'border-border-strong'
  const statusAccentClass =
    failedCount > 0
      ? 'text-status-danger-foreground'
      : agentId
        ? speakerForegroundClass(agentId)
        : 'text-secondary'
  const showContent = expanded || contentMounted

  return (
    <section
      className={`agent-activity border-l-2 pl-3 ${guideBorderClass}`}
      aria-label="Agent activity"
    >
      <button
        ref={headerRef}
        className="group flex min-h-7 w-full cursor-pointer items-center gap-2 text-left text-caption font-medium text-secondary transition-colors duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          const next = !expanded
          if (next) setContentMounted(true)
          onExpandedChange?.(next)
          setExpanded(next)
        }}
      >
        {active ? (
          <LoaderCircle
            aria-hidden="true"
            className={`session-activity-spin size-3.5 shrink-0 ${statusAccentClass}`}
            strokeWidth={1.9}
          />
        ) : failedCount > 0 ? (
          <X
            aria-hidden="true"
            className="size-3.5 shrink-0 text-status-danger-foreground"
            strokeWidth={2}
          />
        ) : stoppedCount > 0 ? (
          <Square aria-hidden="true" className="size-3 shrink-0 text-tertiary" strokeWidth={2} />
        ) : (
          <Check
            aria-hidden="true"
            className={`size-3.5 shrink-0 ${statusAccentClass}`}
            strokeWidth={2}
          />
        )}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={`ml-auto size-3.5 shrink-0 text-tertiary transition-transform duration-150 ease-out-pact group-hover:text-secondary ${expanded ? 'rotate-180' : ''}`}
          strokeWidth={1.8}
        />
      </button>

      <div
        id={detailsId}
        className="agent-activity-reveal"
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
        onTransitionEnd={(event) => {
          if (
            !expanded &&
            event.target === event.currentTarget &&
            event.propertyName === 'grid-template-rows'
          )
            setContentMounted(false)
        }}
      >
        {showContent ? (
          <div className="min-h-0 overflow-hidden">
            {truncationNotice ? (
              <p className="pt-1 text-caption text-tertiary">{truncationNotice}</p>
            ) : null}
            <ol className="space-y-2 pb-1 pt-1.5">
              {activities.map((activity, index) => (
                <li
                  key={activity.id}
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 font-mono text-[11px] leading-4 text-tertiary tabular-nums"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-caption font-medium text-primary">
                      {activity.title}
                    </p>
                    {oversizedActivities?.[activity.id] && onLoadMoreBody ? (
                      <LargeActivityPreview
                        source={{
                          activityId: activity.id,
                          revision: oversizedActivities[activity.id]!.activity.detailRevision,
                          bodyBytes: oversizedActivities[activity.id]!.detailBytes,
                          preview: oversizedActivities[activity.id]!.preview,
                          previewChars: oversizedActivities[activity.id]!.previewChars,
                        }}
                        expanded={expandedBody}
                        onLoadMore={onLoadMoreBody}
                      />
                    ) : activity.detail ? (
                      <p
                        className={`${activity.kind === 'tool' ? 'font-mono text-[12px]' : 'text-caption'} mt-0.5 whitespace-pre-wrap break-words leading-relaxed text-secondary`}
                      >
                        {activity.detail}
                      </p>
                    ) : activity.kind === 'reasoning' && activity.status === 'running' ? (
                      <p className="mt-0.5 text-caption text-tertiary">Preparing a summary…</p>
                    ) : null}
                  </div>
                  <ActivityStatus activity={activity} />
                </li>
              ))}
            </ol>
            <button
              className="mt-1 flex min-h-7 w-full cursor-pointer items-center justify-between rounded-control px-1 text-caption text-tertiary transition-colors duration-150 hover:text-secondary focus-visible:outline-2 focus-visible:outline-focus"
              type="button"
              aria-label="Collapse work log"
              aria-controls={detailsId}
              aria-expanded
              onClick={() => {
                headerRef.current?.focus({ preventScroll: true })
                onExpandedChange?.(false)
                setExpanded(false)
              }}
            >
              <span>Collapse</span>
              <ChevronUp aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.8} />
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ActivityStatus({ activity }: { activity: AgentActivity }): React.JSX.Element {
  if (activity.status === 'running') {
    return (
      <LoaderCircle
        aria-label="Running"
        className="session-activity-spin mt-0.5 size-3 shrink-0 text-tertiary"
        strokeWidth={1.8}
      />
    )
  }
  if (activity.status === 'failed') {
    return (
      <X
        aria-label="Failed"
        className="mt-0.5 size-3 shrink-0 text-status-danger-foreground"
        strokeWidth={1.9}
      />
    )
  }
  if (activity.status === 'interrupted') {
    return (
      <Square
        aria-label="Stopped"
        className="mt-0.5 size-2.5 shrink-0 text-tertiary"
        strokeWidth={2}
      />
    )
  }
  return (
    <Check
      aria-label="Completed"
      className="mt-0.5 size-3 shrink-0 text-tertiary"
      strokeWidth={1.9}
    />
  )
}
