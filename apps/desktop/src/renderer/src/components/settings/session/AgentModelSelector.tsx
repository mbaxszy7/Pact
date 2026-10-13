import type { AgentModelCatalog, AgentModelSelection, RuntimeAgentId } from '@pact/contracts'

import { SettingsSelect } from './SettingsSelect'

interface AgentModelSelectorProps {
  agentId: RuntimeAgentId
  catalog: AgentModelCatalog
  selection: AgentModelSelection
  disabled: boolean
  compact?: boolean
  onChange: (selection: AgentModelSelection) => void
}

export function AgentModelSelector({
  agentId,
  catalog,
  selection,
  disabled,
  compact = false,
  onChange,
}: AgentModelSelectorProps): React.JSX.Element {
  const name = agentId === 'claude' ? 'Claude Code' : 'Codex'
  const selectedModel = catalog.models.find((model) => model.id === selection.model)
  const duplicateDisplayNames = new Map<string, number>()
  for (const model of catalog.models) {
    duplicateDisplayNames.set(
      model.displayName,
      (duplicateDisplayNames.get(model.displayName) ?? 0) + 1,
    )
  }
  const modelIsUnavailable = selection.model !== null && !selectedModel
  const efforts = selectedModel?.supportedEfforts ?? []
  const effortIsUnavailable = selection.effort !== null && !efforts.includes(selection.effort)
  const sectionTitleId = `${agentId}-model-settings-title`

  return (
    <section className="min-w-0 py-section" aria-labelledby={sectionTitleId}>
      <div className="flex items-center justify-between gap-group">
        <h3 id={sectionTitleId} className="text-body font-medium text-primary">
          {name}
        </h3>
        <span
          className={`inline-flex min-w-0 max-w-[70%] items-center gap-2 text-caption font-normal ${catalog.status === 'available' ? 'text-status-ready-foreground' : 'text-status-warning-foreground'}`}
          title={`${catalog.cliVersion ?? name} · ${catalog.status === 'available' ? 'Options refreshed' : 'CLI default only'}`}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${catalog.status === 'available' ? 'bg-status-ready' : 'bg-status-warning'}`}
            aria-hidden="true"
          />
          <span className="truncate">
            {catalog.cliVersion ?? name} ·{' '}
            {catalog.status === 'available' ? 'Options refreshed' : 'CLI default only'}
          </span>
        </span>
      </div>

      <div className={`mt-group grid gap-group ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
        <label className="block min-w-0 text-caption font-medium text-secondary">
          Model
          <SettingsSelect
            value={selection.model ?? ''}
            disabled={disabled}
            onChange={(event) => onChange({ model: event.target.value || null, effort: null })}
          >
            <option value="">Use CLI default</option>
            {modelIsUnavailable ? (
              <option value={selection.model ?? ''}>{selection.model} — unavailable</option>
            ) : null}
            {catalog.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
                {(duplicateDisplayNames.get(model.displayName) ?? 0) > 1
                  ? model.id === model.displayName
                    ? ' — explicit ID'
                    : ` — ${model.id}`
                  : ''}
              </option>
            ))}
          </SettingsSelect>
        </label>

        <label className="block min-w-0 text-caption font-medium text-secondary">
          Effort
          <SettingsSelect
            value={selection.effort ?? ''}
            disabled={disabled || selection.model === null || modelIsUnavailable}
            onChange={(event) => onChange({ ...selection, effort: event.target.value || null })}
          >
            <option value="">Use model default</option>
            {effortIsUnavailable ? (
              <option value={selection.effort ?? ''}>{selection.effort} — unavailable</option>
            ) : null}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
                {effort === selectedModel?.defaultEffort ? ' — recommended' : ''}
              </option>
            ))}
          </SettingsSelect>
        </label>
      </div>

      {catalog.status === 'unavailable' && catalog.detail ? (
        <p className="mt-group text-caption leading-relaxed text-status-warning-foreground">
          {catalog.detail}
        </p>
      ) : null}
    </section>
  )
}
