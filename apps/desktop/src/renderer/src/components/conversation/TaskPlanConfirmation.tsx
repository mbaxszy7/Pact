import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

interface TaskPlanConfirmationProps {
  variant: 'revise' | 'keep' | 'swap_roles'
  planVersion?: number | undefined
  planner: string
  codeRoles?: { author: string; reviewer: string } | undefined
  busy: boolean
  disabled?: boolean | undefined
  suspended: boolean
  error?: string | undefined
  onCancel: () => void
  onConfirm: () => void
}

/** One application dialog; owns show/close/focus while CollaborationReview owns the frozen action. */
export function TaskPlanConfirmation({
  variant,
  planVersion,
  planner,
  codeRoles,
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
  const keep = variant === 'keep'
  const swap = variant === 'swap_roles'
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
          {swap ? 'Swap code roles?' : keep ? 'Keep the current plan?' : 'Revise the current plan?'}
        </h2>
        <button
          type="button"
          aria-label={swap ? 'Cancel role change' : 'Cancel plan decision'}
          disabled={busy}
          onClick={onCancel}
          className="pact-archive-close text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div className="pact-archive-content">
        <div id={descriptionId} className="space-y-2 text-body text-secondary">
          {swap ? (
            <>
              {codeRoles ? (
                <>
                  <p>
                    Implementation: {codeRoles.author} → {codeRoles.reviewer}
                  </p>
                  <p>
                    Code review: {codeRoles.reviewer} → {codeRoles.author}
                  </p>
                </>
              ) : null}
              <p>Implementation still needs approval.</p>
            </>
          ) : keep ? (
            <p>
              Keep Plan{planVersion ? ` v${planVersion}` : ''} and dismiss this revision. Work stays
              paused in the original scope.
            </p>
          ) : (
            <p>
              {planner} revises Plan{planVersion ? ` v${planVersion}` : ''} from your feedback.
              Review and a new Implement approval are required.
            </p>
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
          {swap ? 'Keep current roles' : 'Cancel'}
        </button>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={onConfirm}
          className="h-9 rounded-control bg-surface-inverse px-panel text-body font-medium text-inverse disabled:cursor-wait disabled:opacity-60"
        >
          {busy
            ? swap
              ? 'Swapping…'
              : keep
                ? 'Keeping…'
                : 'Starting…'
            : swap
              ? 'Swap code roles'
              : keep
                ? 'Keep current plan'
                : 'Revise plan'}
        </button>
      </div>
    </dialog>
  )
}
