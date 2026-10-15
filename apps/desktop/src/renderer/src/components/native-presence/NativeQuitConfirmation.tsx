import { LoaderCircle, LogOut, MessageSquare, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { NativeQuitState } from '@pact/contracts'

import { NativeSessionState } from './NativeSessionState'

export function NativeQuitConfirmation({ state }: { state: NativeQuitState }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)
  const activeRef = useRef(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const headingId = useId()
  const descriptionId = useId()
  const confirming = state.phase === 'confirming'
  const canRespond = confirming && !pending
  useEffect(() => {
    activeRef.current = true
    const trigger = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    if (cancelRef.current) cancelRef.current.focus()
    else dialog?.focus()
    return () => {
      activeRef.current = false
      dialog?.close()
      if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.closest('[inert]'))
        trigger.focus({ preventScroll: true })
    }
  }, [])

  const respond = async (decision: 'cancel' | 'exit'): Promise<void> => {
    if (!confirming || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    let accepted = false
    try {
      const result = await window.pact.respondNativeQuit({
        operationId: state.operationId,
        decision,
      })
      accepted = result.ok
      if (activeRef.current && !result.ok) setError(result.error.message)
    } catch {
      if (activeRef.current)
        setError('Could not confirm your choice. Try again to check this exit request.')
    } finally {
      if (!accepted) {
        pendingRef.current = false
        if (activeRef.current) setPending(false)
      }
    }
  }

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className="pact-native-quit bg-surface-raised text-primary shadow-dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={pending || state.phase === 'closing' || state.phase === 'cancelling'}
      onCancel={(event) => {
        event.preventDefault()
        if (canRespond) void respond('cancel')
      }}
    >
      <div className="pact-native-quit-heading">
        <LogOut aria-hidden="true" className="size-5 text-secondary" strokeWidth={1.75} />
        <h2 id={headingId} className="text-subtitle font-medium">
          {confirming
            ? 'Exit Pact?'
            : state.phase === 'cancelling'
              ? 'Keeping Pact open'
              : state.phase === 'unconfirmed'
                ? 'Exit not yet confirmed'
                : 'Exiting Pact'}
        </h2>
        {confirming ? (
          <button
            type="button"
            aria-label="Cancel exit"
            disabled={!canRespond}
            onClick={() => void respond('cancel')}
            className="pact-native-close text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      <div className="pact-native-quit-content">
        <p id={descriptionId} className="text-body text-secondary">
          {confirming
            ? state.unknown
              ? 'Pact could not confirm the current task status. Exiting may interrupt work that is still active.'
              : 'Active or unsettled work may be interrupted.'
            : state.phase === 'cancelling'
              ? 'Waiting for the exit request to be cancelled. Your tasks will stay in Pact.'
              : state.phase === 'unconfirmed'
                ? 'Pact is still waiting for its runtime to exit. Tasks may still be active; this window will close when exit is confirmed.'
                : 'Waiting for tasks to end and saved work to finish closing.'}
        </p>
        {state.sessions.length ? (
          <ul className="pact-native-quit-sessions" aria-label="Affected Sessions">
            {state.sessions.map((session) => (
              <li key={session.sessionId}>
                <MessageSquare
                  aria-hidden="true"
                  className="size-4 shrink-0 text-secondary"
                  strokeWidth={1.75}
                />
                <span className="pact-native-session-name">
                  <span className="text-body">{session.title}</span>
                  <span className="text-caption text-secondary">{session.projectName}</span>
                </span>
                <NativeSessionState state={session.state} />
              </li>
            ))}
          </ul>
        ) : null}
        {state.activeCount > state.sessions.length ? (
          <p className="text-caption text-secondary">
            {state.activeCount - state.sessions.length} additional{' '}
            {state.activeCount - state.sessions.length === 1 ? 'operation' : 'operations'} may also
            be interrupted.
          </p>
        ) : null}
        {state.message ? <p className="text-body text-secondary">{state.message}</p> : null}
        {error ? (
          <p className="text-body text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {confirming ? (
          <p className="text-caption text-secondary">
            Saved conversations and files remain available after you exit. To keep Pact running in
            the background, choose Cancel, then close the main window. Reopen Pact from the system
            tray.
          </p>
        ) : null}
      </div>
      <div className="pact-native-quit-actions">
        {confirming ? (
          <>
            <button
              ref={cancelRef}
              type="button"
              disabled={!canRespond}
              onClick={() => void respond('cancel')}
              className="h-9 rounded-control px-panel text-body font-medium text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canRespond}
              onClick={() => void respond('exit')}
              className="pact-native-quit-exit h-9 rounded-control bg-danger px-panel text-body font-medium disabled:cursor-wait disabled:opacity-60"
            >
              Exit Pact
            </button>
          </>
        ) : (
          <output className="pact-native-quit-progress text-body text-secondary">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 session-activity-spin"
              strokeWidth={1.75}
            />
            {state.phase === 'cancelling'
              ? 'Cancelling exit…'
              : state.phase === 'unconfirmed'
                ? 'Waiting for runtime exit…'
                : 'Exiting…'}
          </output>
        )}
      </div>
    </dialog>
  )
}
