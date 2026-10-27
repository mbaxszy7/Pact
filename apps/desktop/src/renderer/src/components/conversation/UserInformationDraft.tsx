import { MessageSquarePlus, X } from 'lucide-react'
import { useId } from 'react'

import type { UserInformationDeclaration } from '@pact/contracts'

/** Controlled fields in the existing Composer draft; this view owns no request or answer state. */
export function UserInformationDraft({
  value,
  disabled,
  compact = false,
  onChange,
}: {
  value: UserInformationDeclaration | undefined
  disabled: boolean
  compact?: boolean | undefined
  onChange: (value: UserInformationDeclaration | undefined) => boolean | void
}) {
  const id = useId()
  const control =
    'w-full rounded-control border border-border bg-surface-raised px-2 py-1.5 text-body text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50'
  if (!value)
    return (
      <button
        type="button"
        disabled={disabled}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
        onClick={() =>
          onChange({
            version: 'user-information-v1',
            id: crypto.randomUUID(),
            kind: 'user_supplied_value',
            question: '',
            input: 'text',
            options: [],
            state: { status: 'unanswered' },
          })
        }
      >
        <MessageSquarePlus size={15} aria-hidden="true" strokeWidth={1.75} />
        Reserve a detail
      </button>
    )
  const answered = value.state.status === 'answered'
  return (
    <details
      open={!compact}
      className="pact-user-information-draft mb-2 min-w-0 border-b border-border pb-2"
    >
      <summary className="cursor-pointer py-1 text-caption font-medium text-primary focus-visible:outline-2 focus-visible:outline-focus">
        Information from you{compact ? ' · saved in this draft' : ''}
      </summary>
      <fieldset
        disabled={disabled}
        className="max-h-[min(30vh,16rem)] min-w-0 overflow-y-auto pb-2"
      >
        <legend className="sr-only">Reserved detail</legend>
        <div className="flex items-start justify-between gap-2">
          <p id={`${id}-help`} className="max-w-[65ch] text-caption text-secondary">
            Reserve a value or choice for yourself. Relay may collect it before sending; otherwise
            your Agent receives it with your request.
          </p>
          <button
            type="button"
            aria-label="Remove reserved information"
            onClick={() => onChange(undefined)}
            className="grid size-7 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-2 grid min-w-0 gap-2">
          <label className="grid gap-1 text-caption text-secondary" htmlFor={`${id}-kind`}>
            I will provide
            <select
              id={`${id}-kind`}
              className={control}
              value={value.kind}
              onChange={(event) => {
                const choice = event.target.value === 'user_reserved_choice'
                onChange({
                  ...value,
                  kind: choice ? 'user_reserved_choice' : 'user_supplied_value',
                  input: choice ? 'single' : 'text',
                  options: choice
                    ? [
                        { id: crypto.randomUUID(), label: '' },
                        { id: crypto.randomUUID(), label: '' },
                      ]
                    : [],
                  state: { status: 'unanswered' },
                })
              }}
            >
              <option value="user_supplied_value">A value</option>
              <option value="user_reserved_choice">A choice</option>
            </select>
          </label>
          <label className="grid gap-1 text-caption text-secondary" htmlFor={`${id}-question`}>
            Question to ask me
            <input
              id={`${id}-question`}
              className={control}
              maxLength={512}
              value={value.question}
              aria-describedby={`${id}-help`}
              placeholder="What launch date should be used?"
              onChange={(event) => onChange({ ...value, question: event.target.value })}
            />
          </label>
          {value.input === 'single' ? (
            <label className="grid gap-1 text-caption text-secondary" htmlFor={`${id}-choices`}>
              Choices · one per line, 2–6
              <textarea
                id={`${id}-choices`}
                className={`${control} min-h-16 resize-y`}
                maxLength={965}
                value={value.options.map((option) => option.label).join('\n')}
                onChange={(event) => {
                  const labels = event.target.value.split('\n')
                  const options = labels.map((label, index) => ({
                    id: value.options[index]?.id ?? crypto.randomUUID(),
                    label,
                  }))
                  onChange({ ...value, options, state: { status: 'unanswered' } })
                }}
              />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-caption text-secondary">
            <input
              type="checkbox"
              checked={answered}
              onChange={(event) =>
                onChange({
                  ...value,
                  state: event.target.checked
                    ? { status: 'answered', value: '' }
                    : { status: 'unanswered' },
                })
              }
            />
            I have supplied this detail
          </label>
          {answered ? (
            <label className="grid gap-1 text-caption text-secondary" htmlFor={`${id}-answer`}>
              My answer
              {value.input === 'single' ? (
                <select
                  id={`${id}-answer`}
                  className={control}
                  value={value.state.status === 'answered' ? value.state.value : ''}
                  onChange={(event) =>
                    onChange({ ...value, state: { status: 'answered', value: event.target.value } })
                  }
                >
                  <option value="">Choose your answer</option>
                  {value.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${id}-answer`}
                  className={control}
                  maxLength={1024}
                  value={value.state.status === 'answered' ? value.state.value : ''}
                  onChange={(event) =>
                    onChange({ ...value, state: { status: 'answered', value: event.target.value } })
                  }
                />
              )}
            </label>
          ) : null}
        </div>
      </fieldset>
    </details>
  )
}
