import { Archive, Check, LoaderCircle, MessageSquare, X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

import type { WorkspaceArchivePreview, WorkspaceArchiveReceipt } from '@pact/contracts'

interface ArchiveConfirmationProps {
  preview: WorkspaceArchivePreview
  busy: boolean
  receipt?: WorkspaceArchiveReceipt
  error?: string
  uncertain?: boolean
  onCancel: () => void
  onConfirm: () => void
  onCheck: () => void
  onReview: () => void
}

export function ArchiveConfirmation({
  preview,
  busy,
  receipt,
  error,
  uncertain = false,
  onCancel,
  onConfirm,
  onCheck,
  onReview,
}: ArchiveConfirmationProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const descriptionId = useId()
  const result = Boolean(receipt || error || uncertain)
  const blocked = Boolean(preview.blockedReason)
  const subject = preview.scope.kind === 'session' ? 'Session' : 'Project'
  useEffect(() => {
    const trigger = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      dialog?.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className="pact-archive-confirmation bg-surface-raised text-primary shadow-dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <div className="pact-archive-heading">
        <Archive aria-hidden="true" className="size-5 text-secondary" strokeWidth={1.75} />
        <h2 id={headingId} className="text-subtitle font-medium">
          {blocked
            ? 'Cannot archive yet'
            : result
              ? 'Archive not completed'
              : busy
                ? 'Stopping before archiving'
                : 'Stop and archive?'}
        </h2>
        <button
          type="button"
          aria-label="Close archive confirmation"
          disabled={busy}
          onClick={onCancel}
          className="pact-archive-close text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div className="pact-archive-content">
        <p className="pact-archive-target text-body font-medium">{preview.title}</p>
        <p id={descriptionId} className="text-body text-secondary">
          {blocked
            ? preview.blockedReason
            : result
              ? 'This item is still in your workspace. Tasks already stopped will not restart automatically.'
              : busy
                ? 'Waiting for the tasks to end and their latest output to be saved.'
                : subject === 'Project'
                  ? `Archiving this Project will stop its ${preview.tasks.length === 1 ? 'active Session' : `${preview.tasks.length} active Sessions`} first.`
                  : 'This Session is still active. Pact will stop its task before archiving it.'}
        </p>
        {preview.tasks.length > 0 ? (
          <ul className="pact-archive-tasks" aria-label="Affected Sessions">
            {preview.tasks.map((task) => {
              const outcome = receipt?.tasks.find(
                (item) => item.sessionId === task.sessionId,
              )?.outcome
              const label =
                outcome === 'stopped'
                  ? 'Stopped'
                  : outcome === 'finished'
                    ? 'Finished'
                    : outcome === 'failed'
                      ? 'Needs checking'
                      : outcome === 'unresolved'
                        ? 'Not confirmed'
                        : busy
                          ? 'Stopping…'
                          : task.state === 'preparing'
                            ? 'Preparing'
                            : task.state === 'continuing'
                              ? 'Continuing'
                              : 'Running'
              return (
                <li key={task.sessionId}>
                  {outcome === 'stopped' || outcome === 'finished' ? (
                    <Check
                      aria-hidden="true"
                      className="size-4 shrink-0 text-status-ready"
                      strokeWidth={1.75}
                    />
                  ) : busy ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 shrink-0 session-activity-spin text-secondary"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <MessageSquare
                      aria-hidden="true"
                      className="size-4 shrink-0 text-secondary"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="pact-archive-task-title text-body">{task.title}</span>
                  <span className="pact-archive-task-state text-caption text-secondary">
                    {label}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}
        {error || receipt?.message ? (
          <p className="pact-archive-error text-body text-danger" role="alert">
            {receipt?.message ?? error}
          </p>
        ) : null}
        {!blocked && !result ? (
          <p className="text-caption text-secondary">
            Messages and completed file changes stay saved. Undo restores the{' '}
            {subject.toLowerCase()} without restarting its tasks.
          </p>
        ) : null}
      </div>
      <div className="pact-archive-actions">
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="h-9 rounded-control px-panel text-body font-medium text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
        >
          {result || blocked ? 'Close' : 'Cancel'}
        </button>
        {!blocked ? (
          <button
            type="button"
            disabled={busy}
            onClick={
              result
                ? uncertain || receipt?.state === 'unresolved' || receipt?.state === 'stopping'
                  ? onCheck
                  : onReview
                : onConfirm
            }
            className="h-9 rounded-control bg-surface-inverse px-panel text-body font-medium text-inverse disabled:cursor-wait disabled:opacity-60"
          >
            {busy
              ? 'Stopping…'
              : result
                ? uncertain || receipt?.state === 'unresolved' || receipt?.state === 'stopping'
                  ? 'Check status'
                  : 'Review again'
                : 'Stop and archive'}
          </button>
        ) : null}
      </div>
    </dialog>
  )
}
