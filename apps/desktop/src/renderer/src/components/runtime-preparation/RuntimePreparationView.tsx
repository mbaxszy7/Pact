import { ArrowLeft, FolderOpen, Plus } from 'lucide-react'

import type { RuntimeAgentId, RuntimeAgentReadiness, RuntimePreparation } from '@pact/contracts'

import { RUNTIME_MINIMUM_VERSIONS } from '@pact/contracts'

interface RuntimePreparationViewProps {
  preparation?: RuntimePreparation | undefined
  loading: boolean
  choosingAgent?: RuntimeAgentId | undefined
  error?: string | undefined
  canReturnToWorkspace: boolean
  onBack: () => void
  onRetry: () => void
  onContinue: () => void
  onChooseExecutable: (agentId: RuntimeAgentId) => void
}

const agentCopy = {
  claude: {
    name: 'Claude Code',
    mark: 'C',
    install: 'Install Claude Code, then run claude auth login in your terminal.',
  },
  codex: {
    name: 'Codex',
    mark: 'X',
    install: 'Install Codex, then run codex login in your terminal.',
  },
} as const

function statusCopy(
  agent: RuntimeAgentReadiness | undefined,
  loading: boolean,
): {
  label: string
  detail: string
  tone: 'checking' | 'ready' | 'warning' | 'danger'
} {
  if (!agent)
    return loading
      ? { label: 'Checking', detail: 'Finding the local CLI…', tone: 'checking' }
      : { label: 'Not checked', detail: 'Pact could not check this agent.', tone: 'warning' }
  switch (agent.state) {
    case 'ready':
      return { label: 'Ready', detail: 'Authenticated and available to Pact.', tone: 'ready' }
    case 'missing':
      return { label: 'Not installed', detail: agentCopy[agent.agentId].install, tone: 'danger' }
    case 'unsupported_version':
      return {
        label: 'Upgrade required',
        detail:
          agent.detail ??
          `Requires version ${RUNTIME_MINIMUM_VERSIONS[agent.agentId]} or later. Upgrade ${agentCopy[agent.agentId].name}, then check again.`,
        tone: 'warning',
      }
    case 'authentication_required':
      return {
        label: agent.agentId === 'claude' ? 'Setup required' : 'Sign-in required',
        detail:
          agent.detail ??
          (agent.agentId === 'claude'
            ? 'Sign in or configure a compatible API backend, then check again.'
            : 'Run codex login, then check again.'),
        tone: 'warning',
      }
    case 'startup_failed':
      return {
        label: 'Could not start',
        detail: agent.detail ?? 'Check this installation, then try again.',
        tone: 'danger',
      }
    case 'cannot_verify':
      return {
        label: 'Could not verify',
        detail: agent.detail ?? 'Pact could not confirm this CLI is ready.',
        tone: 'warning',
      }
  }
  return { label: 'Could not verify', detail: 'Pact could not read this status.', tone: 'warning' }
}

const statusClasses = {
  checking: 'bg-surface-muted text-secondary',
  ready: 'bg-status-ready-muted text-status-ready-foreground',
  warning: 'bg-status-warning-muted text-status-warning-foreground',
  danger: 'bg-danger-muted text-danger',
} as const

function AgentBridge({
  preparation,
  loading,
}: {
  preparation?: RuntimePreparation | undefined
  loading: boolean
}): React.JSX.Element {
  const readyCount = preparation?.agents.filter((agent) => agent.state === 'ready').length ?? 0
  return (
    <div
      className="runtime-bridge"
      data-loading={loading}
      aria-label={`${readyCount} of 2 agents ready`}
    >
      <span className="runtime-bridge-node bg-speaker-claude">C</span>
      <span className="runtime-bridge-track" aria-hidden="true">
        <span className="runtime-bridge-signal" />
      </span>
      <span className="runtime-bridge-core" aria-hidden="true">
        <Plus className="size-4" strokeWidth={1.75} />
      </span>
      <span className="runtime-bridge-track" aria-hidden="true">
        <span className="runtime-bridge-signal runtime-bridge-signal-delayed" />
      </span>
      <span className="runtime-bridge-node bg-speaker-codex">X</span>
    </div>
  )
}

function RuntimeRow({
  agentId,
  readiness,
  loading,
  choosing,
  onChooseExecutable,
}: {
  agentId: RuntimeAgentId
  readiness?: RuntimeAgentReadiness | undefined
  loading: boolean
  choosing: boolean
  onChooseExecutable: (agentId: RuntimeAgentId) => void
}): React.JSX.Element {
  const status = statusCopy(loading ? undefined : readiness, loading)
  const copy = agentCopy[agentId]
  const hasExecutable = !loading && Boolean(readiness?.executablePath)
  return (
    <article
      className="runtime-row"
      data-agent={agentId}
      data-state={loading ? 'checking' : (readiness?.state ?? 'cannot_verify')}
    >
      <span className="runtime-agent-mark" aria-hidden="true">
        <span>{copy.mark}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <h2 className="text-subtitle font-medium tracking-[-0.015em] text-primary">
            {copy.name}
          </h2>
          <span className={`runtime-status ${statusClasses[status.tone]}`} aria-live="polite">
            {loading ? <span className="runtime-status-dot" aria-hidden="true" /> : null}
            {status.label}
          </span>
        </div>
        <p className="mt-1 max-w-[65ch] text-body leading-relaxed text-secondary">
          {status.detail}
        </p>

        {hasExecutable && readiness?.executablePath ? (
          <div className="runtime-path-line">
            <span
              className="min-w-0 truncate font-mono text-caption text-tertiary"
              title={readiness.executablePath}
            >
              {readiness.executablePath}
            </span>
            <button
              className="runtime-path-action"
              type="button"
              disabled={choosing}
              onClick={() => onChooseExecutable(agentId)}
            >
              {choosing ? 'Opening…' : 'Change path…'}
            </button>
          </div>
        ) : null}
        {!loading && readiness?.version ? (
          <p className="mt-1 text-caption text-tertiary">Detected: {readiness.version}</p>
        ) : null}

        {!hasExecutable && !loading && readiness ? (
          <button
            className="runtime-locate-action"
            type="button"
            disabled={choosing}
            onClick={() => onChooseExecutable(agentId)}
          >
            <FolderOpen aria-hidden="true" className="size-4" strokeWidth={1.75} />
            {choosing ? 'Opening file picker…' : 'Locate manually…'}
          </button>
        ) : null}

        {loading ? <div className="runtime-scan-line" aria-hidden="true" /> : null}
      </div>
    </article>
  )
}

export function RuntimePreparationView({
  preparation,
  loading,
  choosingAgent,
  error,
  canReturnToWorkspace,
  onBack,
  onRetry,
  onContinue,
  onChooseExecutable,
}: RuntimePreparationViewProps): React.JSX.Element {
  const readiness = new Map(preparation?.agents.map((agent) => [agent.agentId, agent]))
  const readyCount = preparation?.agents.filter((agent) => agent.state === 'ready').length ?? 0
  const ready = readyCount === 2
  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-primary"
      aria-labelledby="runtime-preparation-title"
    >
      <header className="pact-titlebar h-12 shrink-0 border-b border-border bg-canvas">
        <div className="pact-titlebar-content flex h-full items-center px-section">
          <span className="text-body font-medium tracking-[-0.015em]">Pact</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        <main className="mx-auto flex min-h-full w-full max-w-[58rem] flex-col px-section py-spacious sm:px-spacious">
          {canReturnToWorkspace ? (
            <button
              className="mb-section flex h-8 items-center gap-2 self-start rounded-control px-2 text-caption font-medium text-primary hover:bg-surface-muted"
              type="button"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
              Back to workspace
            </button>
          ) : null}

          <div className="grid items-end gap-section border-b border-border pb-spacious sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <h1
                id="runtime-preparation-title"
                className="max-w-[14ch] text-title font-medium tracking-[-0.025em]"
              >
                Connect your coding agents
              </h1>
              <p className="mt-group max-w-[60ch] text-body leading-relaxed text-secondary">
                Pact works through the Claude Code and Codex installations on this device. Your
                credentials stay with each CLI.
              </p>
            </div>
            <div className="justify-self-start sm:justify-self-end">
              <AgentBridge preparation={preparation} loading={loading} />
              <p className="mt-2 text-center text-caption text-tertiary">
                {loading ? 'Checking locally…' : `${readyCount} of 2 ready`}
              </p>
            </div>
          </div>

          {error ? (
            <div
              className="mt-section flex flex-wrap items-center justify-between gap-group rounded-control bg-danger-muted px-group py-3 text-caption text-danger"
              role="alert"
            >
              <span>{error}</span>
              <button
                className="h-8 rounded-control border border-current px-3 font-medium hover:bg-surface-raised/30"
                type="button"
                onClick={onRetry}
              >
                Try again
              </button>
            </div>
          ) : null}

          <div className="runtime-agent-list" aria-busy={loading}>
            <RuntimeRow
              agentId="claude"
              readiness={readiness.get('claude')}
              loading={loading}
              choosing={choosingAgent === 'claude'}
              onChooseExecutable={onChooseExecutable}
            />
            <RuntimeRow
              agentId="codex"
              readiness={readiness.get('codex')}
              loading={loading}
              choosing={choosingAgent === 'codex'}
              onChooseExecutable={onChooseExecutable}
            />
          </div>

          <footer className="mt-auto flex flex-wrap items-center justify-between gap-group pt-spacious">
            <output className="flex items-center gap-2 text-caption" aria-live="polite">
              <span
                className={`size-2 rounded-full ${ready ? 'bg-status-ready' : 'bg-status-warning'}`}
                aria-hidden="true"
              />
              <span className={ready ? 'text-status-ready-foreground' : 'text-secondary'}>
                {ready
                  ? canReturnToWorkspace
                    ? 'Both agents are ready. Agent actions can resume.'
                    : 'Both agents are ready. Default collaboration setup comes next.'
                  : canReturnToWorkspace
                    ? 'Resolve the issues above, then check again to resume agent actions.'
                    : 'Both agents must be ready before first-time setup can continue.'}
              </span>
            </output>
            <button
              className="primary-action-button"
              type="button"
              disabled={loading}
              data-busy={loading}
              aria-busy={loading}
              onClick={ready ? onContinue : onRetry}
            >
              {loading ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
              {loading
                ? 'Checking agents'
                : ready
                  ? canReturnToWorkspace
                    ? 'Back to workspace'
                    : 'Continue'
                  : 'Check again'}
            </button>
          </footer>
        </main>
      </div>
    </section>
  )
}

export function RuntimeDegradedNotice({
  preparation,
  onReview,
  onRetry,
}: {
  preparation: RuntimePreparation
  onReview: () => void
  onRetry: () => void
}): React.JSX.Element {
  const unavailable = preparation.agents.filter((agent) => agent.state !== 'ready')
  const unavailableNames = unavailable.map((agent) => agentCopy[agent.agentId].name).join(' and ')
  const attentionVerb = unavailable.length === 1 ? 'needs' : 'need'
  const outdated = unavailable.filter((agent) => agent.state === 'unsupported_version')
  const upgradeDetails = outdated
    .map((agent) => `${agentCopy[agent.agentId].name} ${RUNTIME_MINIMUM_VERSIONS[agent.agentId]}+`)
    .join(' and ')
  const otherUnavailable = unavailable.filter((agent) => agent.state !== 'unsupported_version')
  const otherUnavailableNames = otherUnavailable
    .map((agent) => agentCopy[agent.agentId].name)
    .join(' and ')
  return (
    <div
      className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-group border-b border-status-warning bg-status-warning-muted px-section py-2 text-status-warning-foreground"
      role="alert"
    >
      <div className="flex min-w-0 items-center gap-group">
        <span
          className="grid size-5 shrink-0 place-items-center rounded-full border border-current text-caption font-medium"
          aria-hidden="true"
        >
          !
        </span>
        <p className="min-w-0 text-caption">
          <strong className="font-medium">Agent actions paused.</strong>{' '}
          {outdated.length > 0 ? (
            <>
              Upgrade required: {upgradeDetails}.
              {otherUnavailable.length > 0
                ? ` ${otherUnavailableNames} ${otherUnavailable.length === 1 ? 'needs' : 'need'} attention.`
                : ''}
            </>
          ) : (
            <>
              {unavailableNames} {attentionVerb} attention.
            </>
          )}{' '}
          Existing work remains available.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="h-7 rounded-control px-2.5 text-caption font-medium hover:bg-surface-raised/50"
          type="button"
          onClick={onRetry}
        >
          Retry
        </button>
        <button
          className="h-7 rounded-control border border-current px-2.5 text-caption font-medium hover:bg-surface-raised/50"
          type="button"
          onClick={onReview}
        >
          Review setup
        </button>
      </div>
    </div>
  )
}
