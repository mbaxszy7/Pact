import { CircleAlert, RotateCcw } from 'lucide-react'
import { Component, Fragment, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
  remount: number
  recentFailures: number[]
  locked: boolean
}

const FAILURE_WINDOW_MS = 60_000
const MAX_FAILURES = 3

/** Replaces only the disposable Conversation view; App still owns its draft. */
export class ConversationErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, remount: 0, recentFailures: [], locked: false }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  override componentDidCatch(): void {
    // Never copy the thrown error, component stack or Message body to diagnostics.
    try {
      window.pact?.reportRendererFault?.('view')
    } catch {
      // Diagnostic transport cannot prevent recovery of the disposable view.
    }
    const now = Date.now()
    this.setState((current) => {
      const recentFailures = [
        ...current.recentFailures.filter((time) => now - time < FAILURE_WINDOW_MS),
        now,
      ].slice(-MAX_FAILURES)
      return { recentFailures, locked: recentFailures.length >= MAX_FAILURES }
    })
  }

  private retry = (): void => {
    if (this.state.locked) return
    this.setState((current) => ({ failed: false, remount: current.remount + 1 }))
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return <Fragment key={this.state.remount}>{this.props.children}</Fragment>
    }

    return (
      <div
        className="flex h-full min-h-0 items-center justify-center px-section py-spacious"
        data-pact-conversation-recovery
        role="alert"
      >
        <div className="w-full max-w-[30rem] text-center">
          <CircleAlert
            aria-hidden="true"
            className="mx-auto size-7 text-status-warning-foreground"
            strokeWidth={1.6}
          />
          <h2 className="mt-section text-subtitle font-medium text-primary">
            Couldn’t display this conversation
          </h2>
          <p className="mx-auto mt-group max-w-[48ch] text-body leading-relaxed text-secondary">
            {this.state.locked
              ? 'This view keeps failing. You can switch Sessions or reload the app.'
              : 'Your draft is still here.'}
          </p>
          {this.state.locked ? (
            <>
              <button
                className="primary-action-button mt-section"
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
              <p className="mt-2 text-caption text-tertiary">Reloading may discard unsent text.</p>
            </>
          ) : (
            <button className="primary-action-button mt-section" type="button" onClick={this.retry}>
              <RotateCcw aria-hidden="true" className="size-4" strokeWidth={1.75} />
              Try again
            </button>
          )}
        </div>
      </div>
    )
  }
}
