import { ShieldQuestion } from 'lucide-react'
import { useState } from 'react'

import type {
  NativePermissionDecision,
  NativePermissionRequest,
  RuntimeAgentId,
} from '@pact/contracts'

import { useNativeInteractionDetails } from './useNativeInteractionDetails'

function focusConfirmationCancel(button: HTMLButtonElement | null): void {
  button?.focus()
}

export function NativePermissionCard({
  request,
  agentId,
  operationId,
  onRespond,
}: {
  request: NativePermissionRequest
  agentId: RuntimeAgentId
  operationId: string
  onRespond: (
    operationId: string,
    permissionId: string,
    decision: NativePermissionDecision,
  ) => Promise<boolean>
}): React.JSX.Element {
  const [responding, setResponding] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const reader = useNativeInteractionDetails(operationId, request.id)
  const details = reader.details?.kind === 'approval' ? reader.details : undefined
  const actions = details?.actions ?? []
  const confirmation = actions.find((action) => action.id === confirming)
  const respond = (decision: NativePermissionDecision): void => {
    if (responding) return
    setResponding(true)
    void onRespond(operationId, request.id, decision).finally(() => setResponding(false))
  }
  return (
    <section
      className="mt-group rounded-message border border-border bg-surface-raised p-group text-caption"
      aria-label={`${agentId === 'codex' ? 'Codex' : 'Claude Code'} permission request`}
      data-pact-native-permission={request.id}
      aria-busy={responding}
    >
      <div className="flex items-start gap-2">
        <ShieldQuestion
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-status-warning-foreground"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-primary">
            {confirmation
              ? `Confirm ${agentId === 'codex' ? 'Codex' : 'Claude Code'} permission change`
              : `${agentId === 'codex' ? 'Codex' : 'Claude Code'} needs approval`}
          </p>
          {!confirmation ? (
            <p className="mt-1 break-words text-primary">
              {details?.title ??
                (reader.loading ? 'Loading native request…' : 'Native request unavailable')}
            </p>
          ) : null}
          {!confirmation && details?.detail ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-secondary">
              {details.detail}
            </pre>
          ) : null}
        </div>
      </div>
      {reader.error ? (
        <p className="mt-2 text-secondary" role="alert">
          {reader.error}
          <button
            type="button"
            className="ml-2 cursor-pointer rounded-control px-2 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
            onClick={reader.retry}
          >
            Retry loading
          </button>
        </p>
      ) : null}
      {!confirmation ? (
        <div className="mt-group flex flex-wrap justify-end gap-2">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={responding}
              onClick={() => {
                if (action.confirmation || action.kind === 'rule') setConfirming(action.id)
                else respond(action.id)
              }}
              className={
                action.kind === 'allow' && !details?.defaultToNo
                  ? 'primary-action-button'
                  : 'min-h-8 cursor-pointer rounded-control border border-border px-3 py-1 text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50'
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {confirmation ? (
        <fieldset className="mt-group" aria-label="Confirm native permission scope">
          <p className="whitespace-pre-wrap break-words text-primary">
            {confirmation.confirmation}
          </p>
          {confirmation.scope ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-secondary">
              {confirmation.scope}
            </pre>
          ) : null}
          <div className="mt-group flex flex-wrap justify-end gap-2">
            <button
              type="button"
              ref={focusConfirmationCancel}
              disabled={responding}
              onClick={() => setConfirming(null)}
              className="h-8 cursor-pointer rounded-control px-3 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={responding}
              onClick={() => respond(confirmation.id)}
              className="primary-action-button"
            >
              Confirm native action
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  )
}
