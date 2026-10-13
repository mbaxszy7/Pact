import { Check, ChevronDown, ChevronUp, LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { AgentActivity, ConversationPageActivity } from '@pact/contracts'

import type { ExpandedActivityBody, LoadMoreActivityBody } from './conversation-window'

import { LargeActivityPreview } from './LargeBodyPreview'

interface AgentActivityListProps {
  activities: AgentActivity[]
  active: boolean
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
  const failedCount = activities.filter((activity) => activity.status === 'failed').length
  const wasActiveRef = useRef(active)
  const wasDefaultExpandedRef = useRef(defaultExpanded)
  const headerRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()

  useEffect(() => {
    if (wasActiveRef.current && !active && failedCount === 0 && !preserveExpanded)
      setExpanded(false)
    if (!wasActiveRef.current && active) setExpanded(true)
    wasActiveRef.current = active
  }, [active, failedCount, preserveExpanded])
  useEffect(() => {
    if (!wasDefaultExpandedRef.current && defaultExpanded) setExpanded(true)
    wasDefaultExpandedRef.current = defaultExpanded
  }, [defaultExpanded])

  if (activities.length === 0) return null

  const label = active
    ? `Working · ${activities.length} ${partial ? 'shown' : activities.length === 1 ? 'step' : 'steps'}`
    : `Work log · ${activities.length} ${partial ? 'shown' : activities.length === 1 ? 'step' : 'steps'}`

  return (
    <section className="agent-activity" aria-label="Agent activity">
      <button
        ref={headerRef}
        className="group flex min-h-8 w-full items-center gap-2 text-left text-caption font-medium text-secondary hover:text-primary"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          onExpandedChange?.(!expanded)
          setExpanded(!expanded)
        }}
      >
        {active ? (
          <LoaderCircle
            aria-hidden="true"
            className="session-activity-spin size-3.5 shrink-0"
            strokeWidth={1.8}
          />
        ) : failedCount > 0 ? (
          <X aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.8} />
        ) : (
          <Check aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.8} />
        )}
        <span>{label}</span>
        {!expanded ? (
          <ChevronDown aria-hidden="true" className="ml-auto size-3.5 shrink-0" strokeWidth={1.8} />
        ) : null}
      </button>

      <div
        id={detailsId}
        className="agent-activity-reveal"
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {expanded ? (
          <div className="overflow-hidden">
            {truncationNotice ? (
              <p className="pt-1 text-caption text-tertiary">{truncationNotice}</p>
            ) : null}
            <ol className="space-y-2 pb-1 pt-1">
              {activities.map((activity) => (
                <li key={activity.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3">
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
                        className={`${activity.kind === 'tool' ? 'font-mono' : ''} mt-0.5 whitespace-pre-wrap break-words text-caption leading-relaxed text-secondary`}
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
              className="mt-1 flex min-h-7 w-full items-center justify-between text-caption text-tertiary transition-colors duration-150 hover:text-secondary"
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
      <X aria-label="Failed" className="mt-0.5 size-3 shrink-0 text-danger" strokeWidth={1.9} />
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
