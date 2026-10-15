import {
  Archive,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Folder,
  LoaderCircle,
  MessageSquare,
  X,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { WorkspaceArchivePreview, WorkspaceArchiveReceipt } from '@pact/contracts'

export const ARCHIVE_RESULT_LIMIT = 50
const ARCHIVE_RESULT_PAGE_SIZE = 10

export type ArchivedItem =
  | { kind: 'session'; id: string; title: string; projectId: string }
  | { kind: 'project'; id: string; title: string }

export interface ArchiveResult {
  id: string
  item: ArchivedItem
  state: 'archived' | 'failed' | 'unresolved'
  preview?: WorkspaceArchivePreview
  receipt?: WorkspaceArchiveReceipt
  message?: string
  actionError?: string
}

export interface ArchiveAction {
  id: string
  kind: 'preparing' | 'archiving' | 'restoring' | 'checking'
}

interface ArchiveNoticeProps {
  results: ArchiveResult[]
  action: ArchiveAction | undefined
  blocked: boolean
  onUndo: (result: ArchiveResult) => void
  onCheck: (result: ArchiveResult) => void
  onReview: (result: ArchiveResult) => void
  onDismiss: (id?: string) => void
}

export function ArchiveNotice({
  results,
  action,
  blocked,
  onUndo,
  onCheck,
  onReview,
  onDismiss,
}: ArchiveNoticeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [detailId, setDetailId] = useState<string>()
  const [pageIndex, setPageIndex] = useState(0)
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const noticeRef = useRef<HTMLElement>(null)
  const focusedResultRef = useRef<string | undefined>(undefined)
  const archived = results.filter((result) => result.state === 'archived').length
  const failed = results.filter((result) => result.state === 'failed').length
  const unresolved = results.length - archived - failed
  const summary = [
    archived ? `${archived} archived` : undefined,
    failed ? `${failed} failed` : undefined,
    unresolved ? `${unresolved} to check` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const pageCount = Math.ceil(results.length / ARCHIVE_RESULT_PAGE_SIZE)
  const page = Math.min(pageIndex, pageCount - 1)
  const visible = results.slice(
    page * ARCHIVE_RESULT_PAGE_SIZE,
    (page + 1) * ARCHIVE_RESULT_PAGE_SIZE,
  )
  useEffect(() => {
    if (
      focusedResultRef.current &&
      !results.some((result) => result.id === focusedResultRef.current)
    ) {
      focusedResultRef.current = undefined
      if (document.activeElement === document.body) toggleRef.current?.focus()
    }
  }, [results])
  useEffect(() => {
    const notice = noticeRef.current
    if (!expanded || !notice) return undefined
    const collapse = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setExpanded(false)
      toggleRef.current?.focus()
    }
    notice.addEventListener('keydown', collapse)
    return () => notice.removeEventListener('keydown', collapse)
  }, [expanded])
  return (
    <section
      ref={noticeRef}
      className="pact-archive-notice bg-surface-raised text-primary shadow-dialog"
      aria-label="Archive results"
    >
      <div className="pact-archive-notice-heading">
        <Archive aria-hidden="true" className="size-4 shrink-0 text-secondary" strokeWidth={1.75} />
        <output
          className="pact-archive-summary text-caption font-medium"
          aria-live="polite"
          aria-atomic="true"
        >
          {summary}
        </output>
        <button
          ref={toggleRef}
          className="pact-archive-notice-button text-caption text-primary hover:bg-surface-muted"
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setExpanded(!expanded)
            if (!expanded) setPageIndex(0)
          }}
        >
          {expanded ? 'Hide' : 'View'}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 ${expanded ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
          />
        </button>
        <button
          className="pact-archive-notice-icon text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
          type="button"
          aria-label="Dismiss completed archive results"
          title={
            unresolved
              ? 'Dismiss resolved results; items to check stay available'
              : 'Dismiss archive results'
          }
          disabled={blocked || archived + failed === 0}
          onClick={() => onDismiss()}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div id={listId} hidden={!expanded} className="pact-archive-notice-expanded">
        <ul className="pact-archive-result-list" aria-label="Individual archive results">
          {visible.map((result) => {
            const subject = result.item.kind === 'session' ? 'Session' : 'Project'
            const KindIcon = result.item.kind === 'session' ? MessageSquare : Folder
            const active = action?.id === result.id ? action.kind : undefined
            const detailsOpen = detailId === result.id && result.state !== 'archived'
            const detailDomId = `${listId}-${result.id}`
            const tasks = result.preview?.tasks ?? []
            return (
              <li
                key={result.id}
                onFocusCapture={() => {
                  focusedResultRef.current = result.id
                }}
              >
                <div className="pact-archive-result-row">
                  <KindIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-secondary"
                    strokeWidth={1.75}
                  />
                  <div className="pact-archive-result-label">
                    <p className="text-body font-medium">{result.item.title}</p>
                    <p className="pact-archive-result-status text-caption text-secondary">
                      {subject}
                      <span aria-hidden="true">·</span>
                      {result.state === 'failed' ? (
                        <CircleAlert
                          aria-hidden="true"
                          className="size-3 text-danger"
                          strokeWidth={1.75}
                        />
                      ) : result.state === 'unresolved' ? (
                        <CircleHelp
                          aria-hidden="true"
                          className="size-3 text-status-warning"
                          strokeWidth={1.75}
                        />
                      ) : null}
                      <span
                        className={
                          result.state === 'failed'
                            ? 'text-danger'
                            : result.state === 'unresolved'
                              ? 'text-status-warning'
                              : undefined
                        }
                      >
                        {result.state === 'archived'
                          ? 'Archived'
                          : result.state === 'failed'
                            ? 'Archive failed'
                            : 'Result to check'}
                      </span>
                    </p>
                  </div>
                  <button
                    className="pact-archive-notice-button pact-archive-result-action text-caption font-medium text-primary hover:bg-surface-muted disabled:cursor-wait disabled:opacity-55"
                    type="button"
                    disabled={blocked}
                    aria-label={`${result.state === 'archived' ? 'Undo archive of' : result.state === 'failed' ? 'View archive failure for' : 'Check archive status of'} ${result.item.title}`}
                    {...(result.state === 'failed'
                      ? { 'aria-expanded': detailsOpen, 'aria-controls': detailDomId }
                      : {})}
                    onClick={() => {
                      if (result.state === 'archived') onUndo(result)
                      else if (result.state === 'unresolved') onCheck(result)
                      else setDetailId(detailsOpen ? undefined : result.id)
                    }}
                  >
                    {active ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 session-activity-spin"
                        strokeWidth={1.75}
                      />
                    ) : null}
                    {active === 'restoring'
                      ? 'Restoring…'
                      : active === 'checking'
                        ? 'Checking…'
                        : active === 'preparing' || active === 'archiving'
                          ? 'Working…'
                          : result.state === 'archived'
                            ? 'Undo'
                            : result.state === 'failed'
                              ? 'View reason'
                              : 'Check status'}
                  </button>
                  {result.state !== 'unresolved' ? (
                    <button
                      className="pact-archive-notice-icon text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
                      type="button"
                      aria-label={`Dismiss archive result for ${result.item.title}`}
                      disabled={blocked}
                      onClick={() => onDismiss(result.id)}
                    >
                      <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                    </button>
                  ) : (
                    <span className="pact-archive-notice-icon" aria-hidden="true" />
                  )}
                </div>
                {result.state === 'unresolved' ? (
                  <button
                    className="pact-archive-details-toggle text-caption text-secondary hover:text-primary"
                    type="button"
                    aria-expanded={detailsOpen}
                    aria-controls={detailDomId}
                    onClick={() => setDetailId(detailsOpen ? undefined : result.id)}
                  >
                    {detailsOpen ? 'Hide details' : 'View details'}
                  </button>
                ) : null}
                <div id={detailDomId} hidden={!detailsOpen} className="pact-archive-result-detail">
                  <p className="text-body text-secondary">
                    {result.message ??
                      result.receipt?.message ??
                      'This item has not been archived. Review its current tasks before trying again.'}
                  </p>
                  {tasks.length ? (
                    <ul
                      className="pact-archive-result-tasks"
                      aria-label={`Stop results for ${result.item.title}`}
                    >
                      {tasks.map((task) => {
                        const outcome = result.receipt?.tasks.find(
                          (item) => item.sessionId === task.sessionId,
                        )?.outcome
                        return (
                          <li key={task.sessionId}>
                            <span className="text-caption">{task.title}</span>
                            <span className="text-caption text-secondary">
                              {outcome === 'stopped'
                                ? 'Stopped'
                                : outcome === 'finished'
                                  ? 'Finished'
                                  : outcome === 'failed'
                                    ? 'Needs checking'
                                    : 'Not confirmed'}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                  {result.state === 'failed' ? (
                    <button
                      className="pact-archive-notice-button text-caption font-medium bg-surface-inverse text-inverse disabled:opacity-55"
                      type="button"
                      disabled={blocked}
                      onClick={() => onReview(result)}
                    >
                      Review again
                    </button>
                  ) : null}
                </div>
                {result.actionError ? (
                  <p className="pact-archive-result-error text-caption text-danger" role="alert">
                    {result.actionError}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
        <div className="pact-archive-notice-footer">
          <p className="text-caption text-secondary">
            Undo restores visibility. Stopped tasks stay stopped.
          </p>
          {pageCount > 1 ? (
            <div className="pact-archive-result-pages text-caption">
              <button
                className="pact-archive-notice-button hover:bg-surface-muted disabled:opacity-45"
                type="button"
                disabled={page === 0}
                onClick={() => setPageIndex(page - 1)}
              >
                Previous
              </button>
              <span>
                {page * ARCHIVE_RESULT_PAGE_SIZE + 1}–
                {Math.min((page + 1) * ARCHIVE_RESULT_PAGE_SIZE, results.length)} of{' '}
                {results.length}
              </span>
              <button
                className="pact-archive-notice-button hover:bg-surface-muted disabled:opacity-45"
                type="button"
                disabled={page + 1 === pageCount}
                onClick={() => setPageIndex(page + 1)}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
