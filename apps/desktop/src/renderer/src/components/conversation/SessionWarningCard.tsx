import { LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'

import type { SessionIssue, SessionIssues } from '@pact/contracts'

function focusCancel(button: HTMLButtonElement | null): void {
  button?.focus()
}
const scopeOf = (issue: SessionIssue): string =>
  JSON.stringify([
    issue.agentId,
    issue.generation,
    issue.nativeSessionId,
    issue.runId,
    issue.rebuildId,
    issue.action,
  ])

/** Presentation only: action availability and input gating are owned by Conversation. */
export function SessionWarningCard({
  value,
  enabled,
  onRetry,
  onRebuild,
}: {
  value: SessionIssues
  enabled: boolean
  onRetry: (issue: SessionIssue) => Promise<boolean>
  onRebuild: (issue: SessionIssue, operationId: string) => Promise<boolean>
}): React.JSX.Element | null {
  const [confirmation, setConfirmation] = useState<{ scope: string; operationId: string }>()
  const [working, setWorking] = useState<string>()
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const confirming = value.agents.find((issue) => scopeOf(issue) === confirmation?.scope)
  if (!value.agents.length) return null
  const perform = async (issue: SessionIssue, action: () => Promise<boolean>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setWorking(scopeOf(issue))
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request could not be delivered.')
    } finally {
      inFlight.current = false
      setWorking(undefined)
    }
  }
  const busy =
    Boolean(working) ||
    value.agents.some((issue) => issue.phase === 'checking' || issue.phase === 'rebuilding')
  const tone = value.agents.every((issue) => issue.phase === 'resolved')
    ? 'border border-border bg-surface-muted text-secondary'
    : 'bg-status-warning-muted text-status-warning-foreground'
  return (
    <section
      className={`rounded-control px-group py-3 text-caption ${tone}`}
      aria-label="Session recovery"
      data-pact-session-warning
      aria-busy={busy}
    >
      {confirming && confirmation ? (
        <>
          <h3 className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            Rebuild {confirming.agentId === 'codex' ? 'Codex' : 'Claude Code'} session?
          </h3>
          <p className="mt-2 leading-relaxed">
            Switches Pact to a new session. Your history and drafts are kept, and your previous task
            won’t be repeated.
          </p>
          {confirming.abandon ? (
            <p className="mt-1.5 leading-relaxed">
              Work still running in the old session may continue making changes.
            </p>
          ) : null}
          {confirming.previousCreationUnconfirmed ? (
            <p className="mt-1.5 leading-relaxed">
              The previous attempt may already have created a session.
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-1.5">
            <button
              ref={focusCancel}
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmation(undefined)
                setError(undefined)
              }}
              className="h-8 cursor-pointer rounded-control px-3 hover:bg-surface-raised/40 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!enabled || busy}
              onClick={() =>
                void perform(confirming, () => onRebuild(confirming, confirmation.operationId))
              }
              className="h-8 cursor-pointer rounded-control bg-surface-inverse px-3 font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
            >
              {working ? 'Rebuilding…' : 'Confirm rebuild'}
            </button>
          </div>
        </>
      ) : (
        <div className="divide-y divide-current/15">
          {value.agents.map((issue) => (
            <div key={issue.agentId} className="py-1.5 first:pt-0 last:pb-0">
              <h3 className="flex items-center gap-2 font-medium">
                {issue.phase === 'checking' || issue.phase === 'rebuilding' ? (
                  <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                ) : (
                  <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                )}
                {issue.title}
              </h3>
              {issue.reason ? (
                <p className="mt-1.5 break-words leading-relaxed">{issue.reason}</p>
              ) : null}
              {issue.action !== 'none' ? (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    disabled={!enabled || busy}
                    onClick={() =>
                      issue.action === 'rebuild'
                        ? setConfirmation({
                            scope: scopeOf(issue),
                            operationId: crypto.randomUUID(),
                          })
                        : void perform(issue, () => onRetry(issue))
                    }
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-3 font-medium hover:bg-surface-raised/40 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                  >
                    {working === scopeOf(issue) ? (
                      <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : issue.action !== 'rebuild' ? (
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                    ) : null}
                    {issue.action === 'rebuild'
                      ? 'Rebuild…'
                      : working === scopeOf(issue)
                        ? 'Checking…'
                        : issue.action === 'retry_check'
                          ? 'Check session'
                          : 'Retry'}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {error ? (
        <p className="mt-2 break-words" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
