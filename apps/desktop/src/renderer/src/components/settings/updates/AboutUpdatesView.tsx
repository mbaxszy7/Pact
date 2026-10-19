import { ExternalLink, RefreshCw } from 'lucide-react'

import { PACT_RELEASES_URL, isNewerRelease, type AppInfo, type UpdateState } from '@pact/contracts'

interface Props {
  appInfo: AppInfo | undefined
  state: UpdateState | undefined
  busy: boolean
  error: string | undefined
  onCheck: () => void
  onRetry: () => void
  onAutoCheckChange: (value: boolean) => void
}

function date(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value))
}

export function AboutUpdatesView({
  appInfo,
  state,
  busy,
  error,
  onCheck,
  onRetry,
  onAutoCheckChange,
}: Props): React.JSX.Element {
  const latest = state?.enabled ? state.latest : null
  const message = error ?? state?.error
  const currentVersion = appInfo?.version ?? state?.currentVersion
  const status =
    message || !latest
      ? null
      : state?.updateAvailable
        ? 'Update available'
        : currentVersion && isNewerRelease(currentVersion, latest.version)
          ? 'Current version is newer'
          : 'Up to date'

  return (
    <main className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col p-section sm:p-spacious">
      <header className="border-b border-border pb-section">
        <h2 className="text-title font-medium tracking-[-0.025em] text-primary">
          About &amp; updates
        </h2>
      </header>
      <section className="mt-section" aria-label="App version">
        <div className="flex flex-wrap items-baseline justify-between gap-group">
          <h3 className="text-subtitle font-medium text-primary">Pact</h3>
          {status ? (
            <output
              className={`text-caption ${state?.updateAvailable ? 'font-medium text-focus' : 'text-secondary'}`}
            >
              {status}
            </output>
          ) : null}
        </div>
        <dl className="mt-group divide-y divide-border border-y border-border text-body">
          <div className="flex min-h-12 items-center justify-between gap-group py-group">
            <dt className="text-secondary">Current version</dt>
            <dd className="font-medium tabular-nums text-primary">{currentVersion ?? '…'}</dd>
          </div>
          {state?.enabled ? (
            <div className="flex min-h-12 items-baseline justify-between gap-group py-group">
              <dt className="text-secondary">Latest release</dt>
              <dd className="text-right text-primary">
                <span className="font-medium tabular-nums">{latest?.version ?? 'Not checked'}</span>
                {latest ? (
                  <span className="ml-group text-caption text-secondary">
                    <time dateTime={latest.publishedAt}>{date(latest.publishedAt)}</time>
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {state && !state.enabled ? (
          <p className="mt-group text-caption text-secondary">
            Update checks are available in the official Stable app.
          </p>
        ) : null}
        <div className="mt-section flex flex-wrap items-center gap-group">
          {state?.enabled ? (
            <button
              type="button"
              onClick={onCheck}
              disabled={busy || state.checking}
              className="inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface-raised px-4 text-body font-medium text-primary hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${state.checking ? 'motion-safe:animate-spin' : ''}`}
                strokeWidth={1.75}
              />
              {state.checking ? 'Checking…' : 'Check for updates'}
            </button>
          ) : null}
          <a
            href={latest?.url ?? PACT_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 text-body font-medium text-focus underline decoration-current/40 underline-offset-4 hover:decoration-current"
          >
            Download on GitHub{' '}
            <ExternalLink aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </a>
        </div>
        {message ? (
          <div className="mt-group text-caption text-secondary" role="alert">
            <span>{message}</span>{' '}
            {!state?.preferencesReady ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="font-medium text-focus underline underline-offset-4"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {state?.enabled && state.checkedAt ? (
          <p className="mt-group text-caption text-tertiary">
            {message ? 'Last successful check' : 'Last checked'}{' '}
            <time dateTime={state.checkedAt}>{date(state.checkedAt)}</time>
          </p>
        ) : null}
      </section>
      {state?.enabled ? (
        <section
          className="mt-spacious border-t border-border pt-section"
          aria-label="Update preferences"
        >
          <label className="flex min-h-9 cursor-pointer items-center justify-between gap-group text-body text-primary has-[:disabled]:cursor-not-allowed">
            Check automatically
            <input
              type="checkbox"
              checked={state.autoCheck}
              disabled={busy || !state.preferencesReady}
              onChange={(event) => onAutoCheckChange(event.currentTarget.checked)}
              className="size-4 accent-focus"
            />
          </label>
        </section>
      ) : null}
    </main>
  )
}
