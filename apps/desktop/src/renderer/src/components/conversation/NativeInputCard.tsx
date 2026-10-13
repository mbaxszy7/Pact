import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type {
  NativeInputField,
  NativeInputRespond,
  NativeInputValues,
  NativePermissionRequest,
  RuntimeAgentId,
} from '@pact/contracts'

import type { NativeInputDraft } from './useConversation'

import { useNativeInteractionDetails } from './useNativeInteractionDetails'

const PAGE_FIELDS = 4
const RADIO_CHOICES = 6
const control =
  'h-9 w-full rounded-control border border-border bg-surface px-3 text-caption text-primary transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50'
const secondaryAction =
  'inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-control px-2.5 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45'

export function NativeInputCard({
  request,
  agentId,
  onRespond,
  draft,
  onDraftChange,
}: {
  request: NativePermissionRequest
  agentId: RuntimeAgentId
  onRespond: (input: NativeInputRespond) => Promise<boolean>
  draft?: NativeInputDraft | undefined
  onDraftChange: (
    request: NativePermissionRequest,
    draft: Pick<NativeInputDraft, 'values' | 'page'>,
    initializeOnly?: boolean,
  ) => void
}): React.JSX.Element {
  const reader = useNativeInteractionDetails(request.operationId, request.id)
  const details = reader.details?.kind !== 'approval' ? reader.details : undefined
  const values = draft?.values ?? {}
  const page = draft?.page ?? 0
  const [busy, setBusy] = useState(false)
  const [actionError, setError] = useState<string>()
  const error = actionError ?? reader.error
  const identity = { operationId: request.operationId!, requestId: request.id }
  const agentName = agentId === 'codex' ? 'Codex' : 'Claude Code'
  const heading = `${agentName} needs ${request.kind === 'url' ? 'authorization' : 'your input'}`
  const load = (): void => {
    setError(undefined)
    reader.retry()
  }
  useEffect(() => {
    if (!details) return
    onDraftChange(
      request,
      {
        page: 0,
        values: Object.fromEntries(
          details.fields
            .filter((field) => field.default !== undefined || field.type === 'boolean')
            .map((field) => [field.id, field.default ?? false]),
        ),
      },
      true,
    )
  }, [details, request, onDraftChange])
  const respond = (action: NativeInputRespond['action']): void => {
    if (busy) return
    setBusy(true)
    void onRespond({ ...identity, action, ...(action === 'accept' ? { values } : {}) })
      .then((ok) => {
        if (!ok) setError('Check your answers and the notification, then try again.')
        return undefined
      })
      .catch(() => setError('The native answer could not be sent. Try again.'))
      .finally(() => setBusy(false))
  }
  const open = (): void => {
    if (busy) return
    setBusy(true)
    void window.pact
      .openNativeInputURL(identity)
      .then((result) => {
        if (!result.ok) setError(result.error.message)
        return undefined
      })
      .catch(() => setError('The native authorization page could not open.'))
      .finally(() => setBusy(false))
  }
  const fieldControl = (field: NativeInputField): React.JSX.Element => {
    const value = values[field.id]
    const change = (next: NativeInputValues[string]): void =>
      onDraftChange(request, {
        page,
        values: Object.fromEntries(
          Object.entries({ ...values, [field.id]: next }).filter(
            ([id, answer]) => id !== field.id || field.required || answer !== '',
          ),
        ),
      })
    if (field.type === 'boolean')
      return (
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-primary">
          <input
            type="checkbox"
            disabled={busy}
            checked={value === true}
            onChange={(event) => change(event.currentTarget.checked)}
            className="size-4 shrink-0 accent-focus"
            aria-label={field.label}
          />
          <span className="font-medium">
            {field.label}
            {field.required ? ' *' : ''}
          </span>
        </label>
      )
    if (field.type === 'multi-select')
      return (
        <div className="max-h-48 space-y-1 overflow-auto">
          {field.options?.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 hover:bg-surface-muted"
            >
              <input
                type="checkbox"
                disabled={busy}
                checked={Array.isArray(value) && value.includes(option.value)}
                onChange={(event) => {
                  const selected = Array.isArray(value) ? value : []
                  change(
                    event.currentTarget.checked
                      ? [...selected, option.value]
                      : selected.filter((entry) => entry !== option.value),
                  )
                }}
                className="mt-0.5 size-4 accent-focus"
              />
              <span>
                <span className="font-medium text-primary">{option.label}</span>
                {option.description ? (
                  <span className="block text-secondary">{option.description}</span>
                ) : null}
              </span>
            </label>
          ))}
          {field.allowOther ? (
            <input
              type="text"
              disabled={busy}
              placeholder="Other answer"
              className={control}
              aria-label={`${field.label}: other answer`}
              value={
                (Array.isArray(value) ? value : []).find(
                  (entry) => !field.options?.some((option) => option.value === entry),
                ) ?? ''
              }
              onChange={(event) => {
                const text = event.currentTarget.value
                change([
                  ...(Array.isArray(value) ? value : []).filter((entry) =>
                    field.options?.some((option) => option.value === entry),
                  ),
                  ...(text ? [text] : []),
                ])
              }}
            />
          ) : null}
        </div>
      )
    if (field.type === 'select')
      return (
        <div className="space-y-2">
          {details?.kind === 'questions' && (field.options?.length ?? 0) <= RADIO_CHOICES ? (
            <div className="max-h-48 space-y-1 overflow-auto">
              {field.options?.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 ${value === option.value ? 'bg-surface-muted' : 'hover:bg-surface-muted'}`}
                >
                  <input
                    type="radio"
                    name={`${request.id}:${field.id}`}
                    disabled={busy}
                    checked={value === option.value}
                    onChange={() => change(option.value)}
                    className="mt-0.5 size-4 shrink-0 accent-focus"
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-primary">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-secondary">{option.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <select
              disabled={busy}
              value={
                typeof value === 'string' && field.options?.some((option) => option.value === value)
                  ? value
                  : ''
              }
              className={control}
              aria-label={field.label}
              onChange={(event) => change(event.currentTarget.value)}
            >
              <option value="">Choose an answer</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                  {option.description ? ` — ${option.description}` : ''}
                </option>
              ))}
            </select>
          )}
          {field.allowOther ? (
            <input
              type="text"
              disabled={busy}
              value={
                typeof value === 'string' &&
                !field.options?.some((option) => option.value === value)
                  ? value
                  : ''
              }
              onChange={(event) => change(event.currentTarget.value)}
              placeholder="Or write your own answer"
              className={control}
              aria-label={`${field.label}: other answer`}
            />
          ) : null}
        </div>
      )
    return (
      <input
        type={
          field.type === 'secret'
            ? 'password'
            : field.type === 'number' || field.type === 'integer'
              ? 'number'
              : 'text'
        }
        step={field.type === 'integer' ? 1 : 'any'}
        autoComplete={field.type === 'secret' ? 'off' : undefined}
        disabled={busy}
        value={value === undefined ? '' : String(value)}
        aria-label={field.label}
        className={control}
        onChange={(event) => {
          const text = event.currentTarget.value
          if (field.type === 'number' || field.type === 'integer') {
            if (!text)
              onDraftChange(request, {
                page,
                values: Object.fromEntries(
                  Object.entries(values).filter(([id]) => id !== field.id),
                ),
              })
            else if (Number.isFinite(Number(text))) change(Number(text))
          } else change(text)
        }}
      />
    )
  }
  const pages = Math.max(1, Math.ceil((details?.fields.length ?? 0) / PAGE_FIELDS))
  const source = details?.title.startsWith(`${agentName} · `)
    ? details.title.slice(agentName.length + 3)
    : undefined
  const authorizationUrl = details?.kind === 'url' && details.url ? new URL(details.url) : undefined
  const RequestIcon =
    request.kind === 'url' ? ShieldCheck : request.kind === 'form' ? ListChecks : MessageSquareText
  return (
    <section
      className="@container mt-group w-full min-w-0 overflow-hidden rounded-message border border-border bg-surface-raised text-caption"
      aria-label={`${agentName} native input`}
      data-pact-native-input={request.id}
      aria-busy={busy || reader.loading}
    >
      <header className="flex items-start gap-2.5 px-4 pt-4">
        <RequestIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-secondary"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="font-medium text-primary">{heading}</p>
            {source ? (
              <span className="max-w-56 truncate text-secondary" title={details?.title}>
                {source}
              </span>
            ) : null}
          </div>
          {details ? (
            <>
              {!source && details.title !== heading ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-primary">{details.title}</p>
              ) : null}
              {details.message ? (
                <p className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words leading-relaxed text-secondary">
                  {details.message}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-1 text-secondary">Loading native request…</p>
          )}
        </div>
      </header>
      {details?.kind === 'url' ? (
        <div className="px-4 pb-4 pt-4">
          <div className="flex items-center gap-2 text-primary">
            <Globe
              aria-hidden="true"
              className="size-4 shrink-0 text-secondary"
              strokeWidth={1.75}
            />
            <p className="min-w-0 break-all font-medium">{authorizationUrl?.origin}</p>
          </div>
          <p className="mt-1.5 text-secondary">Sign-in happens in your browser.</p>
          <details className="group mt-2 text-secondary">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-control py-1 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
              <ChevronDown
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-180"
                strokeWidth={1.75}
              />
              Full authorization URL
            </summary>
            <p className="mt-1 max-h-24 overflow-auto break-all font-mono text-code text-primary">
              {details.url}
            </p>
          </details>
        </div>
      ) : details ? (
        <div
          className={`grid gap-4 px-4 py-4 ${details.kind === 'form' ? '@min-[30rem]:grid-cols-2' : ''}`}
        >
          {details.fields.slice(page * PAGE_FIELDS, (page + 1) * PAGE_FIELDS).map((field) => (
            <fieldset
              key={field.id}
              className={`min-w-0 ${field.type === 'boolean' ? 'flex flex-col justify-center' : ''}`}
            >
              {field.type !== 'boolean' ? (
                <legend className="mb-1.5 w-full whitespace-pre-wrap break-words font-medium text-primary">
                  {field.label}
                  {field.required ? ' *' : ''}
                </legend>
              ) : null}
              {field.description && details.kind === 'questions' ? (
                <p className="mb-2 break-words text-secondary">{field.description}</p>
              ) : null}
              {fieldControl(field)}
              {field.description && details.kind !== 'questions' ? (
                <p className="mt-1.5 break-words text-secondary">{field.description}</p>
              ) : null}
            </fieldset>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pb-3 text-danger">
          {error}
          {!details ? (
            <button
              type="button"
              onClick={load}
              className="ml-2 cursor-pointer rounded-control px-2 py-1 text-primary hover:bg-surface-muted"
            >
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-3">
        {pages > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0 || busy}
              onClick={() => onDraftChange(request, { values, page: page - 1 })}
              className={secondaryAction}
              aria-label="Previous"
              title="Previous"
            >
              <ChevronLeft aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </button>
            <span className="px-1 tabular-nums text-secondary" aria-live="polite">
              {page + 1} / {pages}
            </span>
            <button
              type="button"
              disabled={page + 1 === pages || busy}
              onClick={() => onDraftChange(request, { values, page: page + 1 })}
              className={secondaryAction}
              aria-label="Next"
              title="Next"
            >
              <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => respond('cancel')}
            className={secondaryAction}
          >
            Cancel
          </button>
          {request.kind === 'url' ? (
            <button
              type="button"
              disabled={!details || busy}
              onClick={open}
              className="primary-action-button"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <ExternalLink aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              )}
              Open in browser
            </button>
          ) : (
            <button
              type="button"
              disabled={!details || busy}
              onClick={() => respond('accept')}
              className="primary-action-button"
            >
              {busy ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
              {request.kind === 'questions' ? 'Submit answers' : 'Submit details'}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
