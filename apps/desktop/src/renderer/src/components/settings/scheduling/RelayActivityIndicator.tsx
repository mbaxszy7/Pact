import { Settings2, Workflow } from 'lucide-react'

import type { SchedulingState } from '@pact/contracts'

export function relayActivity(state: SchedulingState):
  | {
      label: string
      description: string
      releasing: boolean
    }
  | undefined {
  const { decision, check } = state.activity
  const descriptions: string[] = []
  const elsewhere = (sessionId: string | null): string =>
    sessionId && sessionId !== state.context?.sessionId ? ' in another Session' : ''
  if (decision.status === 'cleanup_unconfirmed')
    descriptions.push(
      `Decision resources are still being released${elsewhere(decision.sessionId)}.`,
    )
  else if (decision.status === 'inspecting')
    descriptions.push(
      decision.sessionId
        ? `Checking native compatibility${elsewhere(decision.sessionId)}.`
        : 'Checking host native compatibility.',
    )
  else if (decision.status === 'evaluating')
    descriptions.push(`Evaluating a Relay decision${elsewhere(decision.sessionId)}.`)
  if (check.status === 'cleanup_unconfirmed')
    descriptions.push(
      `Session check resources are still being released${elsewhere(check.sessionId)}.`,
    )
  else if (check.status === 'checking')
    descriptions.push(`Checking native Session state${elsewhere(check.sessionId)}.`)
  if (!descriptions.length) return undefined
  const releasing =
    (decision.status === 'idle' || decision.status === 'cleanup_unconfirmed') &&
    (check.status === 'idle' || check.status === 'cleanup_unconfirmed')
  const label = releasing
    ? 'Relay releasing'
    : descriptions.length > 1
      ? 'Relay active'
      : decision.status === 'evaluating'
        ? 'Relay deciding'
        : 'Relay checking'
  return { label, description: descriptions.join(' '), releasing }
}

/** Current-Session presentation only; compatibility probes and cleanup do not imply scheduling. */
export function RelayActivityIndicator({
  state,
  sessionId,
  visible,
  waitingForUser = false,
  onOpenSettings,
}: {
  state: SchedulingState | undefined
  sessionId: string
  visible: boolean
  waitingForUser?: boolean | undefined
  onOpenSettings: () => void
}): React.JSX.Element | null {
  if (!visible || waitingForUser || !state?.settings.enabled || !state.settings.showIndicator)
    return null
  const { decision, check } = state.activity
  const evaluating = decision.status === 'evaluating' && decision.sessionId === sessionId
  const checking = check.status === 'checking' && check.sessionId === sessionId
  if (!evaluating && !checking) return null
  return (
    <div className="relay-edge relay-input-indicator" data-motion-active={visible}>
      <Workflow aria-hidden="true" size={14} strokeWidth={1.75} />
      <output>Scheduling in background</output>
      <button
        type="button"
        className="relay-indicator-settings"
        aria-label="Open decision & scheduling settings"
        title="Open Relay settings"
        onClick={onOpenSettings}
      >
        <Settings2 aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
