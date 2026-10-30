import { Check, Workflow } from 'lucide-react'
import { useId } from 'react'

import type { RelayDecisionAnswer, RelaySchedulingDecision } from '@pact/contracts'

/**
 * Presentation of one scheduling action admitted by the Conversation owner.
 * This is not a native/Agent question, a model recommendation, or an authority proof.
 * The owner must revalidate it after higher-priority interactions before publishing it again.
 * Necessary scheduling information has its own typed branch and answer. Agent/native
 * questions never enter this component or its answer interface.
 */
export interface RelayDecisionPresentation {
  request: RelaySchedulingDecision
  status: 'awaiting_confirmation' | 'submitting' | 'checking_receipt' | 'receipt_unconfirmed'
  answerValue: string
  onChangeAnswer: (value: string) => void
  cancelling?: boolean | undefined
  error?: string | undefined
  onConfirm: (answer: RelayDecisionAnswer['answer']) => void
  onCheckReceipt?: (() => void) | undefined
  onCancel: () => void
}

export function RelayDecisionCard({
  decision,
  visible,
}: {
  decision: RelayDecisionPresentation
  visible: boolean
}): React.JSX.Element {
  const titleId = useId()
  const actionId = `${titleId}-action`
  const locked = decision.status !== 'awaiting_confirmation' || Boolean(decision.cancelling)
  const { request } = decision
  const field =
    request.request.category === 'necessary_information' ? request.request.field : undefined
  const operation =
    request.request.category === 'necessary_information' ? undefined : request.request.operation
  const confirmLabel = field
    ? 'Continue scheduling'
    : operation?.kind === 'rebuild_native_context'
      ? 'Confirm rebuild'
      : operation?.kind === 'repair'
        ? 'Allow repair'
        : 'Allow one read-only turn'
  const answer: RelayDecisionAnswer['answer'] | undefined = !field
    ? { kind: 'confirm' }
    : field.input.kind === 'single'
      ? field.input.options.some((option) => option.id === decision.answerValue)
        ? { kind: 'selection', fieldId: field.fieldId, optionId: decision.answerValue }
        : undefined
      : decision.answerValue.trim() && decision.answerValue.length <= field.input.maxLength
        ? { kind: 'text', fieldId: field.fieldId, text: decision.answerValue }
        : undefined
  return (
    <section
      className="relay-edge relay-decision"
      data-motion-active={visible}
      aria-labelledby={titleId}
      aria-describedby={actionId}
      aria-busy={locked}
    >
      <header className="relay-decision-heading">
        <Workflow aria-hidden="true" size={18} strokeWidth={1.75} />
        <h3 id={titleId}>Relay decision</h3>
      </header>
      <div className="relay-decision-body">
        <p id={actionId} className="relay-action-title">
          {decision.cancelling ? 'Cancellation pending' : request.title}
        </p>
        <p className="relay-action-target">
          {operation?.kind === 'rebuild_native_context'
            ? `${operation.agentId === 'codex' ? 'Codex' : 'Claude Code'} · Current session`
            : operation
              ? `${operation.actor === 'codex' ? 'Codex' : 'Claude Code'} · ${operation.kind === 'repair' ? 'One repair' : 'One read-only turn'}, then ${operation.returnActor === 'codex' ? 'Codex' : 'Claude Code'} reviews`
              : 'Scheduling information'}
        </p>
        <p className="relay-action-explanation">
          {decision.cancelling
            ? 'Check this decision to confirm the cancellation before sending again.'
            : request.reason}
        </p>
        <p className="relay-action-explanation">
          {decision.cancelling
            ? 'This check does not send your draft. Your current draft and Comments are kept.'
            : request.consequence}
        </p>
        {field && !decision.cancelling ? (
          <div className="relay-scheduling-field">
            <label htmlFor={`${titleId}-field`}>{field.prompt}</label>
            {field.input.kind === 'single' ? (
              <select
                id={`${titleId}-field`}
                value={decision.answerValue}
                disabled={locked}
                onChange={(event) => decision.onChangeAnswer(event.target.value)}
              >
                <option value="">Choose an option</option>
                {field.input.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${titleId}-field`}
                value={decision.answerValue}
                maxLength={field.input.maxLength}
                disabled={locked}
                onChange={(event) => decision.onChangeAnswer(event.target.value)}
              />
            )}
          </div>
        ) : null}
        <p className="relay-action-source">
          Source: {request.sources.map((source) => source.label).join(' · ')}
        </p>
      </div>
      {decision.error ? (
        <p role="alert" className="relay-decision-error">
          {decision.error}
        </p>
      ) : null}
      <footer className="relay-decision-footer">
        <button
          type="button"
          className="relay-cancel"
          disabled={locked}
          onClick={decision.onCancel}
        >
          {decision.cancelling
            ? decision.status === 'submitting'
              ? 'Cancelling…'
              : 'Cancel requested'
            : 'Cancel this scheduling action'}
        </button>
        <button
          className="relay-submit"
          type="button"
          disabled={
            decision.status === 'receipt_unconfirmed' ? !decision.onCheckReceipt : locked || !answer
          }
          onClick={() => {
            if (decision.status === 'receipt_unconfirmed') decision.onCheckReceipt?.()
            else if (answer) decision.onConfirm(answer)
          }}
        >
          <span>
            {decision.status === 'receipt_unconfirmed'
              ? 'Check decision'
              : decision.status === 'checking_receipt'
                ? 'Checking decision…'
                : decision.status === 'submitting'
                  ? 'Confirming…'
                  : confirmLabel}
          </span>
          <Check aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </footer>
    </section>
  )
}
