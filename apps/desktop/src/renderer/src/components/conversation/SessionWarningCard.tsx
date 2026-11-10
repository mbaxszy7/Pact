import { Clock, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'

import type { RuntimeAgentId, SessionIssue, SessionIssues } from '@pact/contracts'

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
  queuedBackgroundAgent,
  stoppingAgent,
  onRetry,
  onRebuild,
}: {
  value: SessionIssues
  enabled: boolean
  queuedBackgroundAgent?: RuntimeAgentId | undefined
  stoppingAgent?: RuntimeAgentId | undefined
  onRetry: (issue: SessionIssue) => Promise<boolean>
  onRebuild: (issue: SessionIssue, operationId: string) => Promise<boolean>
}): React.JSX.Element | null {
  const [confirmation, setConfirmation] = useState<{ scope: string; operationId: string }>()
  const [working, setWorking] = useState<string>()
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const agents = value.agents.filter(
    (issue) =>
      issue.agentId !== queuedBackgroundAgent ||
      !['background_working', 'background_stopping'].includes(issue.phase),
  )
  const confirming = agents.find((issue) => scopeOf(issue) === confirmation?.scope)
  if (!agents.length) return null
  const perform = async (
    issue: SessionIssue,
    action: () => Promise<boolean>,
    check = false,
  ): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setWorking(check ? `check:${scopeOf(issue)}` : scopeOf(issue))
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
    value.agents.some((issue) =>
      ['checking', 'background_checking', 'rebuilding'].includes(issue.phase),
    )
  const compact = !confirming && agents.every((issue) => issue.phase.startsWith('background_'))
  const mixed =
    !confirming && !compact && agents.some((issue) => issue.phase.startsWith('background_'))
  const warningTone =
    'rounded-control bg-status-warning-muted px-group py-3 text-status-warning-foreground'
  const resolvedTone =
    'rounded-control border border-border bg-surface-muted px-group py-3 text-secondary'
  const tone =
    compact || mixed
      ? 'px-1 text-secondary'
      : !confirming && agents.every((issue) => issue.phase === 'resolved')
        ? resolvedTone
        : warningTone
  return (
    <section
      className={`text-caption ${tone}`}
      aria-label={compact ? 'Background work' : 'Session recovery'}
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
            Rebuild keeps your history and drafts and switches to a new session. Your previous task
            won’t run again.
            {confirming.abandon ? ' Work in the old session may continue making changes.' : null}
            {confirming.previousCreationUnconfirmed
              ? ' A previous attempt may already have created a session.'
              : null}
          </p>
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
        <div className={mixed ? 'flex flex-col gap-1.5' : 'divide-y divide-current/15'}>
          {agents.map((issue) => {
            if (issue.phase.startsWith('background_')) {
              const stopping =
                issue.agentId === stoppingAgent || issue.phase === 'background_stopping'
              const checking = issue.phase === 'background_checking' || working === scopeOf(issue)
              const inProgress = stopping || checking
              return (
                <div key={issue.agentId} className="flex min-h-8 items-center gap-2 px-2">
                  <output className="flex min-w-0 flex-1 items-center gap-2">
                    {inProgress ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                      />
                    ) : issue.phase === 'background_check' ? (
                      <TriangleAlert
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-status-warning-foreground"
                      />
                    ) : (
                      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span>
                      {value.agents.length > 1
                        ? `${issue.agentId === 'codex' ? 'Codex' : 'Claude Code'} · `
                        : null}
                      {stopping ? 'Stopping…' : checking ? 'Checking…' : issue.title}
                    </span>
                  </output>
                  {!inProgress && (issue.action === 'retry_check' || issue.action === 'rebuild') ? (
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
                      className="min-h-7 shrink-0 rounded-control px-2 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                    >
                      {issue.action === 'rebuild' ? 'Rebuild…' : 'Check session'}
                    </button>
                  ) : null}
                </div>
              )
            }
            return (
              <div
                key={issue.agentId}
                className={
                  mixed
                    ? issue.phase === 'resolved'
                      ? resolvedTone
                      : warningTone
                    : 'py-1.5 first:pt-0 last:pb-0'
                }
              >
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
                  <div className="mt-2 flex justify-end gap-1.5">
                    {issue.action === 'rebuild' &&
                    issue.runId &&
                    issue.nativeSessionId &&
                    !issue.rebuildId ? (
                      <button
                        type="button"
                        disabled={!enabled || busy}
                        onClick={() => void perform(issue, () => onRetry(issue), true)}
                        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-3 font-medium hover:bg-surface-raised/40 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                      >
                        {working === `check:${scopeOf(issue)}` ? (
                          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                        )}
                        {working === `check:${scopeOf(issue)}` ? 'Checking…' : 'Check session'}
                      </button>
                    ) : null}
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
            )
          })}
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
