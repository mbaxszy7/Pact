import type {
  AgentModelCatalog,
  AgentModelSelection,
  DefaultSessionSettings,
  RuntimeAgentId,
} from '@pact/contracts'

import { AgentModelSelector } from './AgentModelSelector'
import { InfoTip } from './InfoTip'

interface SessionSettingsFieldsProps {
  idPrefix: string
  settings: DefaultSessionSettings
  modelCatalogs: { claude: AgentModelCatalog; codex: AgentModelCatalog }
  disabled: boolean
  refreshing?: boolean
  showRefresh?: boolean
  compact?: boolean
  onChange: (settings: DefaultSessionSettings) => void
  onRefresh?: () => void
}

export const initialSessionSettings: DefaultSessionSettings = {
  primaryAgentId: 'claude',
  agents: {
    claude: { model: null, effort: null, speed: 'native' },
    codex: { model: null, effort: null, speed: 'native' },
  },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

export function sessionSettingsEqual(
  left: DefaultSessionSettings,
  right: DefaultSessionSettings,
): boolean {
  return (
    left.primaryAgentId === right.primaryAgentId &&
    left.agents.claude.model === right.agents.claude.model &&
    left.agents.claude.effort === right.agents.claude.effort &&
    left.agents.codex.model === right.agents.codex.model &&
    left.agents.codex.effort === right.agents.codex.effort &&
    left.maxDiscussionRounds === right.maxDiscussionRounds &&
    left.runningMessagePolicy === right.runningMessagePolicy &&
    left.maxReviewCycles === right.maxReviewCycles &&
    left.maxRepairAttempts === right.maxRepairAttempts
  )
}

export function SessionSettingsFields({
  idPrefix,
  settings,
  modelCatalogs,
  disabled,
  refreshing = false,
  showRefresh = false,
  compact = false,
  onChange,
  onRefresh,
}: SessionSettingsFieldsProps): React.JSX.Element {
  const primaryName = settings.primaryAgentId === 'claude' ? 'Claude Code' : 'Codex'
  const secondaryName = settings.primaryAgentId === 'claude' ? 'Codex' : 'Claude Code'
  const updateAgent = (agentId: RuntimeAgentId, selection: AgentModelSelection): void => {
    onChange({ ...settings, agents: { ...settings.agents, [agentId]: selection } })
  }

  return (
    <div className="divide-y divide-border">
      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-lead-title`}
      >
        <h2
          id={`${idPrefix}-lead-title`}
          className="text-subtitle font-medium tracking-[-0.015em] text-primary"
        >
          Choose the primary LLM
        </h2>
        <p className="mt-1 text-caption text-secondary">
          The Primary leads the collaboration. You can still direct either Agent for a specific
          task.
        </p>
        <div
          className={`mt-group grid overflow-hidden rounded-card border border-border ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}
          role="radiogroup"
          aria-labelledby={`${idPrefix}-lead-title`}
        >
          {(['claude', 'codex'] as const).map((agentId) => {
            const selected = settings.primaryAgentId === agentId
            const inputId = `${idPrefix}-primary-${agentId}`
            return (
              <div
                key={agentId}
                className={`flex cursor-pointer items-center gap-group bg-surface-raised px-panel py-group text-body text-primary has-[:checked]:bg-surface-muted [&+&]:border-border ${compact ? '[&+&]:border-t' : 'sm:[&+&]:border-l sm:[&+&]:border-t-0 [&+&]:border-t'}`}
              >
                <input
                  id={inputId}
                  className="size-4 accent-focus"
                  type="radio"
                  name={`${idPrefix}-primary-agent`}
                  value={agentId}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onChange({ ...settings, primaryAgentId: agentId })}
                />
                <label className="min-w-0 flex-1 cursor-pointer" htmlFor={inputId}>
                  <span className="block font-medium">
                    {agentId === 'claude' ? 'Claude Code' : 'Codex'}
                  </span>
                  <span className="mt-0.5 block text-caption text-secondary">
                    {selected ? 'Primary LLM' : 'Set as Primary LLM'}
                  </span>
                </label>
              </div>
            )
          })}
        </div>
        {!compact ? (
          <dl className="mt-group divide-y divide-border rounded-card bg-surface-muted px-panel text-caption leading-relaxed">
            <div className="grid gap-1 py-group sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-section">
              <dt>
                <span className="block text-tertiary">Primary LLM</span>
                <strong className="mt-0.5 block font-medium text-primary">{primaryName}</strong>
              </dt>
              <dd className="text-secondary">
                Clarifies requirements, maintains the Plan and Summary, coordinates the Secondary,
                and performs the final read-only review.
              </dd>
            </div>
            <div className="grid gap-1 py-group sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-section">
              <dt>
                <span className="block text-tertiary">Secondary LLM</span>
                <strong className="mt-0.5 block font-medium text-primary">{secondaryName}</strong>
              </dt>
              <dd className="text-secondary">
                Challenges the plan, inspects the codebase, implements approved work, runs checks,
                and repairs review findings.
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-agents-title`}
      >
        <div className="flex items-start justify-between gap-group">
          <div>
            <h2
              id={`${idPrefix}-agents-title`}
              className="text-subtitle font-medium tracking-[-0.015em]"
            >
              Agent defaults
            </h2>
            <p className="mt-1 text-caption text-secondary">
              Options come from the CLI versions currently available.
            </p>
          </div>
          {showRefresh && onRefresh ? (
            <button
              className="h-8 shrink-0 rounded-control px-3 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-55"
              type="button"
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshing ? 'Refreshing…' : 'Refresh options'}
            </button>
          ) : null}
        </div>
        <div className="mt-group divide-y divide-border">
          <AgentModelSelector
            agentId="claude"
            catalog={modelCatalogs.claude}
            selection={settings.agents.claude}
            disabled={disabled}
            compact={compact}
            onChange={(selection) => updateAgent('claude', selection)}
          />
          <AgentModelSelector
            agentId="codex"
            catalog={modelCatalogs.codex}
            selection={settings.agents.codex}
            disabled={disabled}
            compact={compact}
            onChange={(selection) => updateAgent('codex', selection)}
          />
        </div>
      </section>

      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-limits-title`}
      >
        <h2
          id={`${idPrefix}-limits-title`}
          className="text-subtitle font-medium tracking-[-0.015em] text-primary"
        >
          Collaboration limits
        </h2>
        <p className="mt-1 text-caption text-secondary">
          These bounds prevent open-ended discussion and repeated repair loops.
        </p>
        <div className={`mt-group grid gap-group ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
          <NumberSetting
            label="Maximum discussion rounds"
            value={settings.maxDiscussionRounds}
            max={20}
            disabled={disabled}
            description="One round is peer review plus the original drafter responding or confirming, whichever Agent drafted first. Review starts the round; a new version needs a new review round."
            onChange={(maxDiscussionRounds) => onChange({ ...settings, maxDiscussionRounds })}
          />
          <NumberSetting
            label="Maximum review cycles"
            value={settings.maxReviewCycles}
            max={10}
            disabled={disabled}
            description="One cycle is review, response or repair, and re-review. Suggestions and declined suggestions also count. Remaining feedback starts a new cycle at the next response."
            onChange={(maxReviewCycles) => onChange({ ...settings, maxReviewCycles })}
          />
          <NumberSetting
            label="Repair attempts per task"
            value={settings.maxRepairAttempts}
            max={10}
            disabled={disabled}
            description="Each explicitly authorized repair Turn counts, whether successful or failed. Initial implementation and read-only response or review do not count."
            onChange={(maxRepairAttempts) => onChange({ ...settings, maxRepairAttempts })}
          />
        </div>
      </section>
    </div>
  )
}

function SettingLabel({ label, children }: { label: string; children: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-caption font-medium text-secondary">
      <span>{label}</span>
      <InfoTip label={label.toLowerCase()}>{children}</InfoTip>
    </div>
  )
}

function NumberSetting({
  label,
  value,
  max,
  disabled,
  description,
  onChange,
}: {
  label: string
  value: number
  max: number
  disabled: boolean
  description: string
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div>
      <SettingLabel label={label}>{description}</SettingLabel>
      <input
        aria-label={label}
        className="mt-2 h-10 w-full rounded-control border border-border bg-surface-raised px-3 text-body text-primary"
        type="number"
        min="1"
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}
