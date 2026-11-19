import { useEffect, useRef, useState } from 'react'

import {
  agentDisplayName,
  type ConversationPage,
  type PreparedInputContinuation,
  type PreparedInputContinue,
} from '@pact/contracts'

type SourcePage = Extract<ConversationPage, { scope: 'prepared-input' }>

/** Disposable UI over the Repository's saved input and explicit action receipt. */
export function PreparedInputCard({
  sessionId,
  input,
  disabled,
  onChanged,
}: {
  sessionId: string
  input: PreparedInputContinuation
  disabled: boolean
  onChanged: () => void
}): React.JSX.Element {
  const [viewing, setViewing] = useState(false),
    [observedPage, setPage] = useState<SourcePage>(),
    [sourceId, setSourceId] = useState<string>(),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [message, setMessage] = useState<string>(),
    [readFailure, setReadFailure] = useState<string>()
  const operation = useRef<PreparedInputContinue | undefined>(undefined),
    epoch = useRef(0),
    pending = useRef(false)
  const readKey = `${sessionId}:${input.batchId}:${input.revision}:${sourceId ?? 'body'}:${offset}`
  const page =
    observedPage?.batchId === input.batchId &&
    observedPage.revision === input.revision &&
    observedPage.offset === offset &&
    observedPage.sourceId === (sourceId ?? observedPage.sources[0]?.sourceId)
      ? observedPage
      : undefined
  const loading = viewing && !page && readFailure !== readKey
  useEffect(() => {
    const current = ++epoch.current
    if (!viewing) return undefined
    let active = true
    const timer = setTimeout(() => {
      if (active && epoch.current === current) {
        active = false
        setReadFailure(readKey)
        setMessage('Couldn’t load the saved message. Try opening it again.')
      }
    }, 10_000)
    void window.pact
      .getConversation({
        scope: 'prepared-input',
        sessionId,
        batchId: input.batchId,
        revision: input.revision,
        offset,
        ...(sourceId ? { sourceId } : {}),
      })
      .then(
        (result) => {
          if (!active || epoch.current !== current) return undefined
          if (result.ok && result.value.scope === 'prepared-input') setPage(result.value)
          else {
            setReadFailure(readKey)
            setMessage(
              result.ok ? 'The saved message changed. Open it again.' : result.error.message,
            )
          }
          return undefined
        },
        () => {
          if (active && epoch.current === current) {
            setReadFailure(readKey)
            setMessage('Couldn’t load the saved message.')
          }
          return undefined
        },
      )
      .finally(() => {
        clearTimeout(timer)
      })
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [viewing, sessionId, input.batchId, input.revision, sourceId, offset, readKey])

  const act = async (check: boolean): Promise<void> => {
    if (busy || pending.current || (check && !operation.current)) return
    if (!check && (disabled || !input.canContinue || uncertain)) return
    pending.current = true
    setBusy(true)
    setMessage(undefined)
    const request = check
      ? operation.current!
      : {
          sessionId,
          batchId: input.batchId,
          expectedRevision: input.revision,
          operationId: crypto.randomUUID(),
          expectedSettingsRevision: input.settingsRevision,
          expectedQueueRevision: input.queueRevision,
          expectedContinuationFingerprint: input.continuationFingerprint,
        }
    operation.current = request
    try {
      if (check) {
        const result = await window.pact.getRelayDecisionReceipt({
          sessionId,
          decisionId: request.operationId,
          clientOperationId: request.operationId,
        })
        if (result.ok) {
          setUncertain(false)
          setMessage(
            result.value.runId
              ? 'Your message has started.'
              : 'Action confirmed, though no reply has started yet.',
          )
        } else setMessage(result.error.message)
      } else {
        const result = await window.pact.continuePreparedConversationInput(request)
        if (!result.ok) {
          const unknown = result.error.code === 'TIMEOUT' || result.error.code === 'UNCERTAIN'
          setUncertain(unknown)
          setMessage(result.error.message)
          if (!unknown) operation.current = undefined
        }
      }
      onChanged()
    } catch {
      setUncertain(true)
      setMessage('Couldn’t confirm whether this message continued. Click Check status first.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const explicitSettings = [
    input.execution.model,
    input.execution.effort ? `${input.execution.effort} effort` : undefined,
    input.execution.speed === 'native' ? undefined : input.execution.speed,
  ].filter((value): value is string => Boolean(value))
  const permissionLabel =
    input.execution.permissionMode === 'full'
      ? 'Full access'
      : input.execution.permissionMode === 'ask'
        ? 'Ask for approval'
        : input.execution.permissionMode === 'auto'
          ? 'Automatic approvals'
          : 'Default permissions'
  const executionLabel =
    explicitSettings.length === 0 && input.execution.permissionMode === 'native'
      ? 'Default settings'
      : [...explicitSettings, permissionLabel].join(' · ')
  const blockedHint =
    input.blockedReason === 'session_unavailable'
      ? 'Finish setting up or restoring this session before continuing.'
      : input.blockedReason === 'native_interaction'
        ? 'Respond to the pending prompt above first.'
        : input.blockedReason === 'native_recovery'
          ? 'Finish session recovery above before continuing.'
          : input.blockedReason === 'collaboration_active'
            ? 'Finish or pause the active workflow first.'
            : input.blockedReason === 'preparation_active'
              ? 'Wait for active agent work to finish first.'
              : input.blockedReason === 'queue_changed'
                ? 'Handle the queued message first.'
                : undefined
  return (
    <section
      className="relay-decision prepared-input-card"
      aria-label="Pending message"
      aria-busy={busy}
    >
      <div className="prepared-input-content">
        <header className="relay-decision-heading">
          <h3>Pending message</h3>
        </header>
        <div className="relay-decision-body">
          {input.phase === 'preparing' ? (
            <p className="relay-action-title">Preparing pending message…</p>
          ) : null}
          {input.preview ? <p className="relay-action-explanation">{input.preview}</p> : null}
          <p className="relay-action-target">
            {agentDisplayName(input.agentId)} · {executionLabel}
            {input.commentCount > 0
              ? ` · ${input.commentCount} ${input.commentCount === 1 ? 'Comment' : 'Comments'}`
              : ''}
            {input.hasAnswer ? ' · Answer included' : ''}
          </p>
          {blockedHint && input.phase === 'paused' ? (
            <p className="relay-action-explanation">{blockedHint}</p>
          ) : null}
          {message ? <output className="relay-decision-error">{message}</output> : null}
          {viewing ? (
            <section aria-label="Original request source" className="relay-scheduling-field">
              <label>
                Saved source{' '}
                <select
                  value={sourceId ?? page?.sources[0]?.sourceId ?? ''}
                  onChange={(event) => {
                    setSourceId(event.target.value)
                    setOffset(0)
                  }}
                >
                  {page?.sources.map((source) => (
                    <option key={source.sourceId} value={source.sourceId}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </label>
              {page?.declaredInformation ? (
                <div className="text-caption text-primary">
                  <p className="font-medium">Saved information</p>
                  <p>{page.declaredInformation.question}</p>
                  {page.declaredInformation.options.length ? (
                    <ul className="list-inside list-disc">
                      {page.declaredInformation.options.map((option) => (
                        <li key={option.id}>{option.label}</li>
                      ))}
                    </ul>
                  ) : null}
                  {page.declaredInformation.state.status === 'answered' ? (
                    <p>
                      Supplied answer:{' '}
                      {page.declaredInformation.input === 'text'
                        ? page.declaredInformation.state.value
                        : page.declaredInformation.options.find(
                            (option) =>
                              page.declaredInformation?.state.status === 'answered' &&
                              option.id === page.declaredInformation.state.value,
                          )?.label}
                    </p>
                  ) : (
                    <p>Waiting for your answer</p>
                  )}
                </div>
              ) : null}
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-control bg-surface-raised p-3 text-caption">
                {loading ? 'Loading saved source…' : (page?.text ?? '')}
              </pre>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="relay-cancel"
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(0)}
                >
                  First page
                </button>
                <button
                  type="button"
                  className="relay-cancel"
                  disabled={loading || page?.nextOffset == null}
                  onClick={() => {
                    if (page?.nextOffset != null) setOffset(page.nextOffset)
                  }}
                >
                  Next page
                </button>
                <button type="button" className="relay-cancel" onClick={() => setViewing(false)}>
                  Close source
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
      <footer className="relay-decision-footer">
        <button
          type="button"
          className="relay-cancel"
          onClick={() => {
            if (viewing) {
              setViewing(false)
              return
            }
            setOffset(0)
            setSourceId(undefined)
            setViewing(true)
          }}
        >
          {viewing ? 'Hide request' : 'View request'}
        </button>
        <button
          type="button"
          title="Uses the displayed settings and saved request. Your current draft stays saved."
          className="relay-submit"
          disabled={busy || (!uncertain && (disabled || !input.canContinue))}
          onClick={() => void act(uncertain)}
        >
          {busy ? 'Checking…' : uncertain ? 'Check status' : 'Continue request'}
        </button>
      </footer>
    </section>
  )
}
