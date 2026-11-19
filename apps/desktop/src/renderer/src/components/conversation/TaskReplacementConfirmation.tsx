import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

import { agentDisplayName, type CollaborationTask, type RuntimeAgentId } from '@pact/contracts'

interface TaskReplacementConfirmationProps {
  task: CollaborationTask
  command: 'plan' | 'build' | 'review'
  running: boolean
  actor: RuntimeAgentId
  summary?: string | undefined
  unreviewedChanges: boolean
  busy: boolean
  disabled: boolean
  suspended: boolean
  error?: string | undefined
  onCancel: () => void
  onConfirm: () => void
}

/** One application dialog; owns show/close/focus while the parent owns draft and Send. */
export function TaskReplacementConfirmation({
  task,
  command,
  running,
  actor,
  summary,
  unreviewedChanges,
  busy,
  disabled,
  suspended,
  error,
  onCancel,
  onConfirm,
}: TaskReplacementConfirmationProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pausedFocus = useRef<HTMLElement | undefined>(undefined)
  const headingId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const element = dialogRef.current
    if (suspended) {
      element?.close()
      return undefined
    }
    element?.showModal()
    const paused = pausedFocus.current
    if (paused?.isConnected && element?.contains(paused)) paused.focus({ preventScroll: true })
    else cancelRef.current?.focus()
    return () => {
      if (
        document.activeElement instanceof HTMLElement &&
        element?.contains(document.activeElement)
      )
        pausedFocus.current = document.activeElement
      element?.close()
    }
  }, [suspended])
  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className="pact-task-replacement-confirmation bg-surface-raised text-primary shadow-dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <div className="pact-archive-heading">
        <h2 id={headingId} className="text-subtitle font-medium">
          {running ? 'Queue a new task?' : 'Replace the current task?'}
        </h2>
        <button
          type="button"
          aria-label="Cancel task replacement"
          disabled={busy}
          onClick={onCancel}
          className="pact-archive-close text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div className="pact-archive-content">
        <p className="pact-archive-target text-body font-medium">
          Current task · /{task.kind}
          {task.task ? ` · ${task.task}` : ''}
        </p>
        <div id={descriptionId} className="space-y-2 text-body text-secondary">
          {running ? (
            <p>
              {agentDisplayName(actor)} finishes this response first.{' '}
              {unreviewedChanges
                ? 'Current changes won’t be reviewed.'
                : 'The current task will end.'}
            </p>
          ) : (
            <>
              <p>{summary}</p>
              <p>Replacing this task ends the current workflow. Your chat history stays saved.</p>
            </>
          )}
        </div>
        {error ? (
          <p role="alert" className="pact-archive-error text-body text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="pact-archive-actions">
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="h-9 rounded-control border border-border bg-surface-muted px-panel text-body font-medium text-primary hover:bg-surface-raised disabled:opacity-45"
        >
          Keep current task
        </button>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={onConfirm}
          className="h-9 rounded-control bg-surface-inverse px-panel text-body font-medium text-inverse disabled:cursor-wait disabled:opacity-60"
        >
          {busy
            ? running
              ? 'Queueing…'
              : 'Starting…'
            : running
              ? 'Queue new task'
              : `Replace and start /${command}`}
        </button>
      </div>
    </dialog>
  )
}
