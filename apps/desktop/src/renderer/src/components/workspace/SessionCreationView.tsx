import { ArrowLeft, SlidersHorizontal, Sparkles, Users } from 'lucide-react'
import { useState } from 'react'

import type {
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  Project,
  RuntimeAgentId,
} from '@pact/contracts'

import { SessionSettingsFields } from '../settings/session/SessionSettingsFields'

interface SessionCreationViewProps {
  project: Project
  editorState?: DefaultSessionSettingsEditorState | undefined
  loading: boolean
  creating: boolean
  error?: string | undefined
  onCancel: () => void
  onRetry: () => void
  onCreate: (settings: DefaultSessionSettings) => void
  onOpenAppDefaults: () => void
}

export function SessionCreationView({
  project,
  editorState,
  loading,
  creating,
  error,
  onCancel,
  onRetry,
  onCreate,
  onOpenAppDefaults,
}: SessionCreationViewProps): React.JSX.Element {
  const [scope, setScope] = useState<'defaults' | 'custom'>('defaults')
  const [settings, setSettings] = useState<DefaultSessionSettings | undefined>(
    editorState?.current?.settings,
  )
  const effectiveSettings = settings ?? editorState?.current?.settings
  const settingsAvailable = Boolean(
    effectiveSettings &&
    editorState &&
    selectionIsAvailable(effectiveSettings.agents.claude, editorState.modelCatalogs.claude) &&
    selectionIsAvailable(effectiveSettings.agents.codex, editorState.modelCatalogs.codex),
  )

  return (
    <main className="min-h-full bg-surface">
      <form
        className="mx-auto flex min-h-full w-full max-w-[64rem] flex-col px-section pt-section sm:px-spacious"
        onSubmit={(event) => {
          event.preventDefault()
          if (effectiveSettings && settingsAvailable) onCreate(effectiveSettings)
        }}
      >
        <div className="flex-1">
          <button
            className="-ml-2 inline-flex h-8 items-center gap-2 rounded-control px-2 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary"
            type="button"
            onClick={onCancel}
          >
            <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
            Back to project
          </button>

          <header className="mt-section border-b border-border pb-section">
            <h1 className="text-title font-medium tracking-[-0.025em]">Create a Session</h1>
            <p className="mt-group max-w-[66ch] text-body leading-relaxed text-secondary">
              Start with your App defaults or tailor how Claude Code and Codex collaborate in this
              Session in {project.name}. The choice belongs only to this Session.
            </p>
          </header>

          {loading && !editorState ? (
            <div className="space-y-group py-section" aria-busy="true">
              <div className="h-24 animate-pulse rounded-card bg-surface-muted" />
              <div className="h-40 animate-pulse rounded-card bg-surface-muted" />
            </div>
          ) : null}

          {error ? (
            <div
              className="mt-section rounded-card bg-danger-muted p-section text-body text-danger"
              role="alert"
            >
              <p>{error}</p>
              <button
                className="mt-group h-8 rounded-control border border-current px-3 font-medium"
                type="button"
                onClick={onRetry}
              >
                Try again
              </button>
            </div>
          ) : null}

          {editorState?.current && effectiveSettings ? (
            <>
              <section className="py-section" aria-labelledby="session-scope-title">
                <h2
                  id="session-scope-title"
                  className="text-subtitle font-medium tracking-[-0.015em]"
                >
                  Starting settings
                </h2>
                <p className="mt-1 text-caption text-secondary">
                  App defaults are copied now; changing them later will not alter this Session.
                </p>
                <div className="mt-group grid overflow-hidden rounded-card border border-border sm:grid-cols-2">
                  <ScopeChoice
                    icon={<Sparkles aria-hidden="true" className="size-4" strokeWidth={1.75} />}
                    title="Use App defaults"
                    description="Create with the current global choices"
                    selected={scope === 'defaults'}
                    onSelect={() => {
                      setScope('defaults')
                      setSettings(editorState.current?.settings)
                    }}
                  />
                  <ScopeChoice
                    icon={
                      <SlidersHorizontal aria-hidden="true" className="size-4" strokeWidth={1.75} />
                    }
                    title="Customize this Session"
                    description="Change this copy before creating"
                    selected={scope === 'custom'}
                    onSelect={() => setScope('custom')}
                  />
                </div>
              </section>

              {scope === 'defaults' ? (
                <DefaultSettingsSummary
                  settings={effectiveSettings}
                  modelCatalogs={editorState.modelCatalogs}
                  onOpenAppDefaults={onOpenAppDefaults}
                />
              ) : (
                <SessionSettingsFields
                  idPrefix="new-session"
                  settings={effectiveSettings}
                  modelCatalogs={editorState.modelCatalogs}
                  disabled={creating}
                  onChange={setSettings}
                />
              )}
              {!settingsAvailable ? (
                <output className="mb-section rounded-control bg-status-warning-muted px-group py-2 text-caption text-status-warning-foreground">
                  A saved Model or Effort is unavailable in this Project. Customize this Session
                  before creating it.
                </output>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="sticky bottom-0 -mx-section mt-section flex flex-wrap items-center justify-between gap-group border-t border-border bg-surface px-section py-group sm:-mx-spacious sm:px-spacious">
          <div className="flex items-center gap-2 text-caption text-secondary">
            <Users aria-hidden="true" className="size-4" strokeWidth={1.75} />
            Settings apply only to this Session
          </div>
          <div className="flex items-center gap-group">
            <button
              className="h-9 rounded-control px-4 text-body font-medium text-secondary hover:bg-surface-muted hover:text-primary"
              type="button"
              disabled={creating}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="primary-action-button"
              type="submit"
              disabled={!effectiveSettings || !settingsAvailable || loading || creating}
              data-busy={creating}
              aria-busy={creating}
            >
              {creating ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
              {creating ? 'Creating Session' : 'Create Session'}
            </button>
          </div>
        </footer>
      </form>
    </main>
  )
}

function ScopeChoice({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: React.ReactNode
  title: string
  description: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      className="flex min-h-20 items-start gap-group bg-surface-raised px-panel py-group text-left transition-colors duration-150 hover:bg-surface-muted data-[selected=true]:bg-surface-muted sm:[&+&]:border-l sm:[&+&]:border-t-0 [&+&]:border-t [&+&]:border-border"
      type="button"
      data-selected={selected}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="mt-0.5 text-tertiary">{icon}</span>
      <span>
        <strong className="block text-body font-medium text-primary">{title}</strong>
        <span className="mt-0.5 block text-caption text-secondary">{description}</span>
      </span>
    </button>
  )
}

function DefaultSettingsSummary({
  settings,
  modelCatalogs,
  onOpenAppDefaults,
}: {
  settings: DefaultSessionSettings
  modelCatalogs: DefaultSessionSettingsEditorState['modelCatalogs']
  onOpenAppDefaults: () => void
}): React.JSX.Element {
  const primary = settings.primaryAgentId === 'claude' ? 'Claude Code' : 'Codex'
  const secondary = settings.primaryAgentId === 'claude' ? 'Codex' : 'Claude Code'
  const agentOrder: RuntimeAgentId[] = [
    settings.primaryAgentId,
    settings.primaryAgentId === 'claude' ? 'codex' : 'claude',
  ]
  return (
    <section className="border-t border-border py-section" aria-labelledby="defaults-summary-title">
      <div className="flex flex-wrap items-start justify-between gap-group">
        <div>
          <h2 id="defaults-summary-title" className="text-subtitle font-medium tracking-[-0.015em]">
            Current App defaults
          </h2>
          <p className="mt-1 text-caption text-secondary">
            A snapshot will be saved with the Session.
          </p>
        </div>
        <button
          className="h-8 rounded-control px-3 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary"
          type="button"
          onClick={onOpenAppDefaults}
        >
          Edit App defaults
        </button>
      </div>
      <div
        className="mt-group overflow-hidden rounded-card bg-surface-muted text-caption"
        aria-label="Current App default summary"
      >
        <SummaryItem
          className="border-b border-border px-panel py-group"
          label="Collaboration"
          value={`${primary} Primary · ${secondary} Secondary`}
        />
        <div className="border-b border-border px-panel py-group">
          <p className="text-tertiary">Agents</p>
          <div className="mt-2 grid gap-group sm:grid-cols-2 sm:gap-0 sm:[&>*+*]:border-l sm:[&>*+*]:border-border sm:[&>*+*]:pl-section">
            {agentOrder.map((agentId, index) => (
              <AgentSummaryItem
                key={agentId}
                label={agentId === 'claude' ? 'Claude Code' : 'Codex'}
                role={index === 0 ? 'Primary' : 'Secondary'}
                value={`${modelDisplayName(settings.agents[agentId].model, modelCatalogs[agentId])} · ${settingValue(settings.agents[agentId].effort)}`}
              />
            ))}
          </div>
        </div>
        <SummaryItem
          className="px-panel py-group"
          label="Limits"
          value={`${settings.maxDiscussionRounds} plan reviews · ${settings.maxReviewCycles} code reviews · ${settings.maxRepairAttempts} repairs`}
        />
      </div>
    </section>
  )
}

function settingValue(value: string | null): string {
  return value ?? 'CLI default'
}

function modelDisplayName(
  modelId: string | null,
  catalog: DefaultSessionSettingsEditorState['modelCatalogs']['claude'],
): string {
  if (modelId === null) return 'CLI default'
  return catalog.models.find((model) => model.id === modelId)?.displayName ?? modelId
}

function selectionIsAvailable(
  selection: DefaultSessionSettings['agents']['claude'],
  catalog: DefaultSessionSettingsEditorState['modelCatalogs']['claude'],
): boolean {
  if (selection.model === null) return true
  const model = catalog.models.find((option) => option.id === selection.model)
  return Boolean(
    model && (selection.effort === null || model.supportedEfforts.includes(selection.effort)),
  )
}

function SummaryItem({
  label,
  value,
  className = '',
}: {
  label: string
  value: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="text-tertiary">{label}</p>
      <p className="mt-0.5 truncate font-medium text-primary" title={value}>
        {value}
      </p>
    </div>
  )
}

function AgentSummaryItem({
  label,
  role,
  value,
}: {
  label: string
  role: 'Primary' | 'Secondary'
  value: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-secondary">{label}</p>
        <span
          className={
            role === 'Primary'
              ? 'rounded-full bg-status-info-muted px-2 py-0.5 text-caption font-medium text-status-info-foreground'
              : 'rounded-full border border-border px-2 py-0.5 text-caption font-medium text-tertiary'
          }
        >
          {role}
        </span>
      </div>
      <p className="mt-1 truncate font-medium text-primary" title={value}>
        {value}
      </p>
    </div>
  )
}
