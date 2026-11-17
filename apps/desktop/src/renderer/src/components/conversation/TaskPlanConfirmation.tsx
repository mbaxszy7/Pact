import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

interface TaskPlanConfirmationProps {
  currentImplementer: string
  nextImplementer: string
  busy: boolean
  disabled?: boolean | undefined
  suspended: boolean
  error?: string | undefined
  onCancel: () => void
  onConfirm: () => void
}

/** One application dialog; owns show/close/focus while CollaborationReview owns the frozen action. */
export function TaskPlanConfirmation({
  currentImplementer,
  nextImplementer,
  busy,
  disabled = false,
  suspended,
  error,
  onCancel,
  onConfirm,
}: TaskPlanConfirmationProps): React.JSX.Element {
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
          Switch initial implementer?
        </h2>
        <button
          type="button"
          aria-label="Cancel"
          disabled={busy}
          onClick={onCancel}
          className="pact-archive-close text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div className="pact-archive-content">
        <div id={descriptionId} className="text-body text-secondary">
          <p>
            Start implementation with {nextImplementer} instead of {currentImplementer}.
          </p>
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
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={onConfirm}
          className="h-9 rounded-control bg-surface-inverse px-panel text-body font-medium text-inverse disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Switching…' : `Switch to ${nextImplementer}`}
        </button>
      </div>
    </dialog>
  )
}
