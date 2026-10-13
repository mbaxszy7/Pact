import { X } from 'lucide-react'
import { useState } from 'react'

import type { DefaultSessionSettings, SessionSettingsEditorState } from '@pact/contracts'

import { SessionSettingsFields, sessionSettingsEqual } from './SessionSettingsFields'

interface SessionSettingsPanelProps {
  editorState?: SessionSettingsEditorState | undefined
  loading: boolean
  saving: boolean
  error?: string | undefined
  onClose: () => void
  onRetry: () => void
  onSave: (settings: DefaultSessionSettings) => void
}

export function SessionSettingsPanel({
  editorState,
  loading,
  saving,
  error,
  onClose,
  onRetry,
  onSave,
}: SessionSettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<DefaultSessionSettings | undefined>(
    editorState?.session.settings,
  )
  const hasChanges = Boolean(
    editorState && settings && !sessionSettingsEqual(settings, editorState.session.settings),
  )

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface-raised"
      aria-labelledby="session-settings-title"
    >
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border p-section">
        <div>
          <h2 id="session-settings-title" className="text-subtitle font-medium tracking-[-0.015em]">
            Session settings
          </h2>
          <p className="mt-1 text-caption text-secondary">Changes stay with this Session.</p>
        </div>
        <button
          className="grid size-8 place-items-center rounded-control border border-border bg-surface-raised text-primary hover:bg-surface-muted"
          type="button"
          aria-label="Close Session settings"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-section">
        {loading && !editorState ? (
          <div className="space-y-group py-section" aria-busy="true">
            <div className="h-28 animate-pulse rounded-card bg-surface-muted" />
            <div className="h-40 animate-pulse rounded-card bg-surface-muted" />
          </div>
        ) : null}

        {error ? (
          <div
            className="my-section rounded-card bg-danger-muted p-group text-caption text-danger"
            role="alert"
          >
            <p>{error}</p>
            <button
              className="mt-2 font-medium underline underline-offset-4"
              type="button"
              onClick={onRetry}
            >
              Try again
            </button>
          </div>
        ) : null}

        {editorState && settings ? (
          <SessionSettingsFields
            idPrefix={`session-${editorState.session.id}`}
            settings={settings}
            modelCatalogs={editorState.modelCatalogs}
            disabled={saving}
            compact
            onChange={setSettings}
            onRefresh={onRetry}
          />
        ) : null}
      </div>

      {editorState && settings ? (
        <footer className="flex shrink-0 items-center justify-between gap-group border-t border-border bg-surface-raised p-group">
          <p className="text-caption text-secondary">Only this Session</p>
          <button
            className="primary-action-button"
            type="button"
            disabled={saving || loading || !hasChanges}
            data-busy={saving}
            aria-busy={saving}
            onClick={() => onSave(settings)}
          >
            {saving ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
            {saving ? 'Saving' : 'Save changes'}
          </button>
        </footer>
      ) : null}
    </section>
  )
}
