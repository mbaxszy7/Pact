import { MessageSquareText } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CollaborationDocument } from '@pact/contracts'

import type { ProjectFileTarget } from './MessageMarkdown'

import { CollaborationDocumentView } from './CollaborationDocumentView'
import {
  sameDecision,
  hasDecisionAnswers,
  type DecisionAnswerDraft,
  type DecisionReplyContext,
} from './useConversation'

type QuestionCardProps = {
  sessionId: string
  runId: string
  messageId?: string | undefined
  actor?: 'claude' | 'codex' | undefined
  disabled: boolean
  onOpenProjectFile: (target: ProjectFileTarget) => void
  decision: DecisionReplyContext
  draft?: DecisionAnswerDraft | undefined
  onDraftChange?: ((draft: DecisionAnswerDraft) => boolean) | undefined
  onClearDraft?: ((keepInMessage: boolean) => boolean) | undefined
  onSubmit: () => void
  canSubmit: boolean
}

export function CollaborationQuestionCard(props: QuestionCardProps): React.JSX.Element {
  return props.decision.questions.length ? (
    <DecisionQuestions {...props} decision={props.decision} />
  ) : (
    <LegacyQuestionCard {...props} />
  )
}

/** Fields edit the Session's existing draft; only the shared Send owner admits a reply. */
function DecisionQuestions({
  decision,
  draft,
  actor,
  disabled,
  onDraftChange,
  onClearDraft,
  onSubmit,
  canSubmit,
}: QuestionCardProps & { decision: DecisionReplyContext }): React.JSX.Element {
  const [error, setError] = useState<string>()
  const stale = hasDecisionAnswers(draft) && !sameDecision(draft?.reference, decision.reference)
  const answers = !stale ? (draft?.answers ?? {}) : {}
  const speaker = actor === 'claude' ? 'Claude Code' : actor === 'codex' ? 'Codex' : 'Agent'
  const change = (id: string, value: { optionIds: string[]; text: string }): void => {
    if (!onDraftChange?.({ ...decision, answers: { ...answers, [id]: value } }))
      setError('Your edit could not be saved. Existing answers have been kept.')
    else setError(undefined)
  }
  return (
    <section
      aria-label="Collaboration questions"
      className="rounded-control border border-border bg-surface-muted text-caption"
    >
      <header className="flex items-center gap-2.5 px-group py-3">
        <MessageSquareText
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary"
          strokeWidth={1.75}
        />
        <h2 className="font-medium text-primary">{speaker} is waiting for your reply</h2>
      </header>
      {stale ? (
        <div role="alert" className="px-group pb-3 text-secondary">
          <p>
            You have saved answers to an earlier request. Keep them in your message draft or discard
            them before answering these questions.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onClearDraft?.(true)}
              className="min-h-8 rounded-control px-2 font-medium text-primary hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
            >
              Keep answers in message draft
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onClearDraft?.(false)}
              className="min-h-8 rounded-control px-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
            >
              Discard saved answers
            </button>
          </div>
        </div>
      ) : null}
      <div className="max-h-[min(40vh,28rem)] overflow-auto px-group">
        {decision.questions.map((question, index) => {
          const answer = answers[question.id] ?? { optionIds: [], text: '' }
          return (
            <fieldset
              key={question.id}
              disabled={disabled || stale}
              className="min-w-0 border-t border-border py-group first:border-0 first:pt-0"
            >
              <legend className="max-w-full break-words text-body font-medium text-primary">
                {decision.questions.length > 1 ? `${index + 1}. ` : ''}
                {question.prompt}
              </legend>
              {question.options?.length ? (
                <div className="mt-2 space-y-1">
                  <p className="text-secondary">
                    {question.selection === 'multiple'
                      ? 'Choose any that apply, or write your answer.'
                      : 'Choose one, or write your answer.'}
                  </p>
                  {question.options.map((option) => (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 hover:bg-surface-raised"
                    >
                      <input
                        type={question.selection === 'multiple' ? 'checkbox' : 'radio'}
                        name={`${decision.reference.runId}:${question.id}`}
                        checked={answer.optionIds.includes(option.id)}
                        onChange={(event) =>
                          change(question.id, {
                            ...answer,
                            optionIds:
                              question.selection === 'single'
                                ? [option.id]
                                : event.currentTarget.checked
                                  ? [...answer.optionIds, option.id]
                                  : answer.optionIds.filter((id) => id !== option.id),
                          })
                        }
                        className="mt-0.5 size-4 shrink-0 accent-focus"
                      />
                      <span className="min-w-0 break-words">
                        <span className="font-medium text-primary">{option.label}</span>
                        {option.description ? (
                          <span className="mt-0.5 block text-secondary">{option.description}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                  {answer.optionIds.length ? (
                    <button
                      type="button"
                      onClick={() => change(question.id, { ...answer, optionIds: [] })}
                      className="min-h-8 rounded-control px-2 text-secondary hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      Clear selection
                    </button>
                  ) : null}
                </div>
              ) : null}
              <label className="mt-2 block text-secondary">
                <span>Your answer or additional context</span>
                <textarea
                  value={answer.text}
                  maxLength={4096}
                  rows={2}
                  onChange={(event) =>
                    change(question.id, { ...answer, text: event.currentTarget.value })
                  }
                  className="mt-1 block min-h-16 w-full resize-y rounded-control border border-border bg-surface px-3 py-2 text-body text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                />
              </label>
            </fieldset>
          )
        })}
      </div>
      {error ? (
        <p role="alert" className="px-group pb-2 text-danger">
          {error}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-group py-2">
        <p className="max-w-[56ch] text-secondary">
          Only these answers are sent. Your message draft and attachments are kept. Collaboration
          stays paused.
        </p>
        <button
          type="button"
          disabled={disabled || stale || !canSubmit}
          onClick={onSubmit}
          className="min-h-8 rounded-control bg-surface-inverse px-3 py-1.5 font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-45"
        >
          Send answers
        </button>
      </footer>
    </section>
  )
}

/** The current decision's original reply, with submission owned by the existing Composer. */
function LegacyQuestionCard({
  sessionId,
  runId,
  messageId,
  disabled,
  actor,
  onOpenProjectFile,
  decision,
  draft,
  onDraftChange,
  onClearDraft,
  onSubmit,
  canSubmit,
}: QuestionCardProps): React.JSX.Element {
  const stale = hasDecisionAnswers(draft) && !sameDecision(draft?.reference, decision.reference)
  const [editError, setEditError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<{
    source?: CollaborationDocument
    taskId?: string
    actor?: 'claude' | 'codex'
    error?: string
  }>({})
  useEffect(() => {
    if (!expanded) return undefined
    let current = true
    void window.pact
      .getConversation({ scope: 'collaboration', sessionId, runId, projection: 'report' })
      .then((response) => {
        if (!current) return undefined
        if (!response.ok || response.value.scope !== 'collaboration')
          throw new Error(response.ok ? 'The request could not be loaded.' : response.error.message)
        const view = response.value.view
        const source = view.documents?.find((entry) => entry.key === 'report')?.source
        if (!source) throw new Error('The original request is unavailable.')
        setState({
          source,
          ...(view.task ? { taskId: view.task.id, actor: view.task.actor } : {}),
        })
        return undefined
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            error: error instanceof Error ? error.message : 'The request could not be loaded.',
          })
      })
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry explicitly reissues the failed immutable-source read.
  }, [sessionId, runId, retry, expanded])
  const speaker = actor === 'claude' ? 'Claude Code' : actor === 'codex' ? 'Codex' : 'Agent'
  return (
    <section
      aria-label="Collaboration questions"
      className="rounded-control border border-border bg-surface-muted text-caption"
    >
      <header className="flex items-center gap-2.5 px-group py-3">
        <MessageSquareText
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary"
          strokeWidth={1.75}
        />
        <h2 className="font-medium text-primary">{speaker} is waiting for your reply</h2>
      </header>
      {!expanded ? (
        <p className="px-group pb-3 text-secondary">
          This earlier request was saved as text. Open the original request, then answer here.
        </p>
      ) : (
        <section
          className="max-h-[min(32vh,22rem)] overflow-auto px-group pb-3"
          aria-label="Request to answer"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The bounded reading region must support keyboard scrolling.
          tabIndex={0}
        >
          {state.source ? (
            <CollaborationDocumentView
              key={state.source.id}
              sessionId={sessionId}
              runId={runId}
              source={state.source}
              messageId={messageId ?? runId}
              displayContext={{ taskId: state.taskId }}
              onOpenProjectFile={onOpenProjectFile}
            />
          ) : state.error ? (
            <div role="alert" className="text-secondary">
              <p>{state.error}</p>
              <button
                type="button"
                className="mt-2 min-h-8 rounded-control px-2 font-medium text-primary hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() => {
                  setState({})
                  setRetry((value) => value + 1)
                }}
              >
                Try again
              </button>
            </div>
          ) : (
            <output className="block text-secondary">Loading the request…</output>
          )}
        </section>
      )}
      {stale ? (
        <div role="alert" className="px-group pb-3 text-secondary">
          <p>Saved answers belong to an earlier request.</p>
          <button
            type="button"
            disabled={disabled}
            className="min-h-8 px-2 underline"
            onClick={() => onClearDraft?.(true)}
          >
            Keep answers in message draft
          </button>
          <button
            type="button"
            disabled={disabled}
            className="min-h-8 px-2 underline"
            onClick={() => onClearDraft?.(false)}
          >
            Discard saved answers
          </button>
        </div>
      ) : null}
      <label className="block px-group pb-3 text-secondary">
        <span>Your answer</span>
        <textarea
          rows={3}
          maxLength={4096}
          disabled={disabled || stale}
          value={!stale ? (draft?.originalReply ?? '') : ''}
          onChange={(event) => {
            if (
              !onDraftChange?.({
                ...decision,
                answers: {},
                originalReply: event.currentTarget.value,
              })
            )
              setEditError('Your edit could not be saved. Existing answers have been kept.')
            else setEditError(undefined)
          }}
          className="mt-1 block min-h-16 w-full resize-y rounded-control border border-border bg-surface px-3 py-2 text-body text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
        />
      </label>
      {editError ? (
        <p role="alert" className="px-group pb-2 text-danger">
          {editError}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-group py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="min-h-8 rounded-control px-2 font-medium text-secondary hover:bg-surface-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
        >
          {expanded ? 'Hide original request' : 'Read original request'}
        </button>
        <button
          type="button"
          disabled={disabled || stale || !canSubmit}
          onClick={onSubmit}
          className="min-h-8 rounded-control bg-surface-inverse px-3 py-1.5 font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-45"
        >
          Send answer
        </button>
      </footer>
    </section>
  )
}
