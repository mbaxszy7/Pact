import { Check, Workflow } from 'lucide-react'
import { useId } from 'react'

import {
  isOptionalRelaySuggestion,
  type RelayDecisionAnswer,
  type RelaySchedulingDecision,
} from '@pact/contracts'

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

const agentName = (id: 'codex' | 'claude'): string => (id === 'codex' ? 'Codex' : 'Claude Code')

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
  const fieldConsequence =
    request.request.category === 'necessary_information' &&
    request.request.consumer.kind === 'prepared_input_clarification'
      ? 'Continue sends this request with your answer. Cancel returns to your draft.'
      : request.consequence
  const operation =
    request.request.category === 'necessary_information' ? undefined : request.request.operation
  const optional = isOptionalRelaySuggestion(request)
  const confirmLabel = field
    ? 'Continue'
    : operation?.kind === 'rebuild_native_context'
      ? 'Rebuild context'
      : operation?.kind === 'reassign_roles'
        ? 'Use suggested roles'
        : operation?.kind === 'extend_plan_review'
          ? 'Add review'
          : 'Continue'
  const cancelLabel = decision.cancelling
    ? decision.status === 'submitting'
      ? 'Cancelling…'
      : 'Cancel requested'
    : optional
      ? 'Skip'
      : operation?.kind === 'reassign_roles'
        ? 'Keep current roles'
        : 'Cancel'
  let actionText: string | undefined
  let detailText: string | undefined
  if (decision.cancelling) {
    actionText = 'Cancellation pending'
    detailText = 'Check the result before sending again.'
  } else if (operation) {
    switch (operation.kind) {
      case 'extend_plan_review':
        actionText = `Review plan v${operation.planReference.version} again?`
        detailText = `${agentName(operation.actor)} · Read-only`
        break
      case 'reassign_roles':
        actionText = `${agentName(operation.proposedRoles.codeAuthor)} implements · ${agentName(operation.proposedRoles.codeReviewer)} reviews.`
        detailText = 'Implementation still needs approval.'
        break
      case 'rebuild_native_context':
        actionText = request.title
        detailText = request.consequence
        break
      default:
        actionText = request.title
        detailText = request.consequence
    }
  } else if (!field) {
    actionText = request.title
    detailText = request.consequence
  }
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
        <h3 id={titleId}>{optional ? 'Relay suggestion' : 'Relay decision'}</h3>
      </header>
      <div className="relay-decision-body">
        {actionText ? (
          <p id={actionId} className="relay-action-title">
            {actionText}
          </p>
        ) : null}
        {detailText ? <p className="relay-action-explanation">{detailText}</p> : null}
        {field && !decision.cancelling ? (
          <div className="relay-scheduling-field">
            <label id={actionId} htmlFor={`${titleId}-field`}>
              {field.prompt}
            </label>
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
        {field && fieldConsequence && !decision.cancelling ? (
          <p className="relay-action-explanation">{fieldConsequence}</p>
        ) : null}
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
          {cancelLabel}
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
