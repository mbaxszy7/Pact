import { useState } from 'react'

import type { DefaultSessionSettings, DefaultSessionSettingsEditorState } from '@pact/contracts'

import {
  initialSessionSettings,
  SessionSettingsFields,
  sessionSettingsEqual,
} from './SessionSettingsFields'

interface DefaultSessionSettingsViewProps {
  editorState?: DefaultSessionSettingsEditorState | undefined
  loading: boolean
  saving: boolean
  saveError?: string | undefined
  loadError?: string | undefined
  firstUse: boolean
  onRetry: () => void
  onSave: (settings: DefaultSessionSettings) => void
}

function SettingsSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-section" aria-busy="true" aria-label="Loading default settings">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-28 animate-pulse rounded-card bg-surface-muted" />
      ))}
    </div>
  )
}

export function DefaultSessionSettingsView({
  editorState,
  loading,
  saving,
  saveError,
  loadError,
  firstUse,
  onRetry,
  onSave,
}: DefaultSessionSettingsViewProps): React.JSX.Element {
  const [settings, setSettings] = useState<DefaultSessionSettings>(
    () => editorState?.current?.settings ?? initialSessionSettings,
  )
  const hasChanges =
    !editorState?.current || !sessionSettingsEqual(settings, editorState.current.settings)

  return (
    <div className="mx-auto min-h-full w-full max-w-[64rem] px-section py-spacious sm:px-spacious">
      <header className="border-b border-border pb-section">
        <h1 className="text-title font-medium tracking-[-0.025em]">
          {firstUse ? 'Set your collaboration defaults' : 'Default session settings'}
        </h1>
        <p className="mt-group max-w-[68ch] text-body leading-relaxed text-secondary">
          Choose how new Sessions begin. Each Session receives its own copy and can change it
          without changing this App default.
        </p>
      </header>

      {loading && !editorState ? (
        <div className="mt-section">
          <SettingsSkeleton />
        </div>
      ) : null}

      {loadError && !editorState ? (
        <div
          className="mt-section rounded-card bg-danger-muted p-section text-body text-danger"
          role="alert"
        >
          <p>{loadError}</p>
          <button
            className="mt-group h-9 rounded-control border border-current px-4 font-medium"
            type="button"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
      ) : null}

      {loadError && editorState ? (
        <div
          className="mt-section flex flex-wrap items-center justify-between gap-group rounded-control bg-status-warning-muted px-group py-2 text-caption text-status-warning-foreground"
          role="alert"
        >
          <span>{loadError} Existing selections are still shown.</span>
          <button
            className="h-7 rounded-control px-2 font-medium hover:bg-surface-raised/40"
            type="button"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : null}

      {editorState ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSave(settings)
          }}
        >
          <SessionSettingsFields
            idPrefix="default-session"
            settings={settings}
            modelCatalogs={editorState.modelCatalogs}
            disabled={saving}
            refreshing={loading}
            showRefresh={!firstUse}
            onChange={setSettings}
            onRefresh={onRetry}
          />

          <footer className="flex flex-wrap items-center justify-between gap-group border-t border-border py-section">
            <div className="text-caption text-secondary">
              {saveError ? (
                <p className="text-danger" role="alert">
                  {saveError}
                </p>
              ) : (
                <p>Only Sessions created after this save use the updated defaults.</p>
              )}
            </div>
            <button
              className="primary-action-button"
              type="submit"
              disabled={saving || loading || !hasChanges}
              data-busy={saving}
              aria-busy={saving}
            >
              {saving ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
              {saving ? 'Saving defaults' : firstUse ? 'Save and enter Pact' : 'Save defaults'}
            </button>
          </footer>
        </form>
      ) : null}
    </div>
  )
}

export function DefaultSessionOnboardingView(
  props: Omit<DefaultSessionSettingsViewProps, 'firstUse'>,
): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary">
      <header className="pact-titlebar h-12 shrink-0 border-b border-border bg-canvas">
        <div className="pact-titlebar-content flex h-full items-center justify-between px-section">
          <span className="text-body font-medium tracking-[-0.015em]">Pact</span>
          <span className="text-caption text-tertiary">Final setup</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        <DefaultSessionSettingsView {...props} firstUse />
      </div>
    </section>
  )
}
