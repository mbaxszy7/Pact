import { Check, LoaderCircle, Split, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  NativeInputRespond,
  NativePermissionDecision,
  NativePermissionRequest,
  PendingNativeInteraction,
  RuntimeAgentId,
  SessionCatalogChange,
  SessionForkInput,
  SessionForkOperation,
  SessionForkPrepared,
} from '@pact/contracts'

import type { NativeInputDraft } from './useConversation'

import { NativeInputCard } from './NativeInputCard'
import { NativePermissionCard } from './NativePermissionCard'

const secondary =
  'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-control px-3 text-caption text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-40'
const names = { claude: 'Claude Code', codex: 'Codex' }
const modeNames = { native: 'Native', ask: 'Ask', auto: 'Auto', full: 'Full access' }
const working = (operation: SessionForkOperation | undefined): boolean =>
  !!operation &&
  operation.sides.some((side) => ['prepared', 'forking', 'initializing'].includes(side.state))

export interface SessionForkOpening {
  selectionEpoch: number
  openingId: string
}

function NativeForkStates({
  operation,
  onAction,
  busy,
}: {
  operation: SessionForkOperation
  busy?: string | undefined
  onAction?: (agentId: RuntimeAgentId, action: 'check' | 'initialize' | 'continue') => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border rounded-control border border-border">
      {operation.sides.map((side) => {
        const active = ['prepared', 'forking', 'initializing'].includes(side.state)
        return (
          <section key={side.agentId} className="p-3 text-caption">
            <div className="flex items-center gap-2 font-medium text-primary">
              {side.state === 'ready' ? (
                <Check className="size-4 text-secondary" aria-hidden="true" />
              ) : active ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <TriangleAlert
                  className="size-4 text-status-warning-foreground"
                  aria-hidden="true"
                />
              )}
              {names[side.agentId]}
              <span className="ml-auto font-normal text-secondary">
                {side.state === 'ready' ? 'Ready' : active ? 'Initializing…' : 'Needs confirmation'}
              </span>
            </div>
            {side.reason ? <p className="mt-2 break-words text-secondary">{side.reason}</p> : null}
            {onAction && !active && side.state !== 'ready' ? (
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className={secondary}
                  disabled={!!busy}
                  onClick={() => onAction(side.agentId, 'check')}
                >
                  {busy === `${side.agentId}:check` ? 'Checking…' : 'Check original candidate'}
                </button>
                {side.canInitialize ? (
                  <button
                    type="button"
                    className={secondary}
                    disabled={!!busy}
                    onClick={() => onAction(side.agentId, 'initialize')}
                  >
                    Continue initialization
                  </button>
                ) : side.canContinue ? (
                  <button
                    type="button"
                    className={secondary}
                    disabled={!!busy}
                    onClick={() => onAction(side.agentId, 'continue')}
                  >
                    Continue native fork
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/** Mounted confirmation owns one bounded request/result and eight real native interaction drafts. */
export function SessionForkDialog({
  sourceSessionId,
  messageId,
  onClose,
  onCreated,
  suspended = false,
}: {
  sourceSessionId: string
  messageId: string
  onClose: () => void
  onCreated: (change: SessionCatalogChange, enter: boolean) => void
  suspended?: boolean | undefined
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const operationRef = useRef<SessionForkOperation | undefined>(undefined)
  const changeRef = useRef<SessionCatalogChange | undefined>(undefined)
  const finished = useRef(false)
  const creationPending = useRef(false)
  const receiptRequest = useRef<Extract<SessionForkInput, { action: 'create' }> | undefined>(
    undefined,
  )
  const receiptRecovering = useRef(false)
  const operationId = useRef(crypto.randomUUID())
  const [prepared, setPrepared] = useState<SessionForkPrepared>()
  const [modelLabels, setModelLabels] = useState<Partial<Record<RuntimeAgentId, string>>>({})
  const [operation, setOperation] = useState<SessionForkOperation>()
  const [preparing, setPreparing] = useState(true)
  const [creating, setCreating] = useState(false)
  const [receiptKnown, setReceiptKnown] = useState(false)
  const [error, setError] = useState<string>()
  const [interactions, setInteractions] = useState<PendingNativeInteraction[]>([])
  const [drafts, setDrafts] = useState<Record<string, NativeInputDraft>>({})
  const blockedClose = creating || working(operation)
  useEffect(() => {
    const element = dialog.current
    if (suspended) {
      element?.close()
      return undefined
    }
    element?.showModal()
    return () => element?.close()
  }, [suspended])
  const finishCreation = useCallback(
    (next: SessionForkOperation): void => {
      if (creationPending.current || working(next) || finished.current) return
      if (!changeRef.current) {
        const request = receiptRequest.current
        if (!request || receiptRecovering.current) return
        receiptRecovering.current = true
        setCreating(true)
        // The matching durable operation proves commit. Re-reading this exact
        // nonce returns its Catalog receipt before any native dispatch branch.
        void window.pact
          .forkSession(request)
          .then((result) => {
            if (
              !result.ok ||
              result.value.kind !== 'created' ||
              result.value.operation.id !== next.id ||
              result.value.operation.sessionId !== next.sessionId ||
              result.value.operation.sourceSessionId !== sourceSessionId ||
              result.value.operation.sourceMessageId !== messageId ||
              result.value.change.session.id !== next.sessionId
            ) {
              if (alive.current)
                setError(
                  'The fork exists, but its sidebar receipt could not be confirmed. Retry this same creation.',
                )
              return undefined
            }
            onCreated(result.value.change, false)
            if (!alive.current) return undefined
            changeRef.current = result.value.change
            if (
              !operationRef.current ||
              result.value.operation.revision >= operationRef.current.revision
            )
              operationRef.current = result.value.operation
            setReceiptKnown(true)
            finished.current = true
            if ((operationRef.current ?? result.value.operation).ready)
              onCreated(result.value.change, true)
            onClose()
            return undefined
          })
          .catch(() => {
            if (alive.current)
              setError(
                'The fork exists, but its sidebar receipt could not be confirmed. Retry this same creation.',
              )
          })
          .finally(() => {
            receiptRecovering.current = false
            if (alive.current) setCreating(false)
          })
        return
      }
      finished.current = true
      if (next.ready && changeRef.current) onCreated(changeRef.current, true)
      onClose()
    },
    [onCreated, onClose, sourceSessionId, messageId],
  )
  const accept = useCallback(
    (next: SessionForkOperation): void => {
      if (
        !alive.current ||
        next.id !== operationId.current ||
        next.sourceSessionId !== sourceSessionId ||
        next.sourceMessageId !== messageId
      )
        return
      if (operationRef.current && next.revision < operationRef.current.revision) return
      operationRef.current = next
      setOperation(next)
      finishCreation(next)
    },
    [sourceSessionId, messageId, finishCreation],
  )
  useEffect(() => {
    alive.current = true
    let current = true
    void Promise.allSettled([
      window.pact.forkSession({ action: 'prepare', sourceSessionId, messageId }),
      window.pact.getSessionSettings(sourceSessionId),
    ])
      .then(([forkResult, settingsResult]) => {
        if (!alive.current || !current) return undefined
        if (forkResult.status === 'fulfilled') {
          const result = forkResult.value
          if (result.ok && result.value.kind === 'prepared') {
            const snapshot = result.value.prepared
            setPrepared(snapshot)
            if (
              settingsResult.status === 'fulfilled' &&
              settingsResult.value.ok &&
              settingsResult.value.value.session.id === sourceSessionId &&
              settingsResult.value.value.session.settingsRevision === snapshot.settingsRevision
            ) {
              const catalogs = settingsResult.value.value.modelCatalogs
              const labels: Partial<Record<RuntimeAgentId, string>> = {}
              for (const agentId of ['claude', 'codex'] as const) {
                const selected = snapshot.settings.agents[agentId].model
                const model = catalogs[agentId].models.find((entry) => entry.id === selected)
                if (selected && model)
                  labels[agentId] =
                    model.displayName.toLowerCase() === selected.toLowerCase()
                      ? model.displayName
                      : `${model.displayName} — ${selected}`
              }
              setModelLabels(labels)
            }
          } else setError(result.ok ? 'Unexpected fork preparation.' : result.error.message)
        } else setError('Native histories could not be checked. Close this dialog and try again.')
        setPreparing(false)
        return undefined
      })
      .catch(() => {
        if (alive.current && current) {
          setError('Native histories could not be checked. Close this dialog and try again.')
          setPreparing(false)
        }
      })
    return () => {
      current = false
      alive.current = false
    }
  }, [sourceSessionId, messageId])
  useEffect(
    () =>
      window.pact.onConversationChanged((patch) => {
        if (patch.forkOperation?.id !== operationId.current) return
        accept(patch.forkOperation)
        if (patch.pendingNativeInteractions) {
          setInteractions(patch.pendingNativeInteractions)
          const ids = new Set(patch.pendingNativeInteractions.map((item) => item.request.id))
          setDrafts((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))),
          )
        }
      }),
    [accept],
  )
  const create = async (): Promise<void> => {
    if (!prepared || creating || (operation && changeRef.current)) return
    creationPending.current = true
    setCreating(true)
    setError(undefined)
    try {
      const full = (['claude', 'codex'] as const).filter(
        (agentId) => prepared.settings.permissionModes?.[agentId] === 'full',
      )
      const request: Extract<SessionForkInput, { action: 'create' }> = {
        action: 'create',
        operationId: operationId.current,
        sourceSessionId,
        messageId,
        messageRevision: prepared.messageRevision,
        settingsRevision: prepared.settingsRevision,
        sourceRevision: prepared.sourceRevision,
        confirmedFullAccessAgents: full,
      }
      receiptRequest.current = request
      const result = await window.pact.forkSession(request)
      if (!alive.current) return
      if (!result.ok || result.value.kind !== 'created') {
        setError(result.ok ? 'Unexpected fork creation result.' : result.error.message)
        return
      }
      changeRef.current = result.value.change
      setReceiptKnown(true)
      onCreated(result.value.change, false)
      accept(result.value.operation)
      // The durable transition may arrive before the creation receipt.
      const latest = await window.pact.forkSession({
        action: 'read',
        sessionId: result.value.operation.sessionId,
      })
      if (alive.current && latest.ok && latest.value.kind === 'state' && latest.value.operation)
        accept(latest.value.operation)
    } catch {
      if (alive.current)
        setError(
          'Fork creation was not acknowledged. Retry uses this same operation; it will not create a second conversation.',
        )
    } finally {
      creationPending.current = false
      if (alive.current) {
        setCreating(false)
        if (operationRef.current) finishCreation(operationRef.current)
      }
    }
  }
  const respondPermission = async (
    actorOperationId: string,
    permissionId: string,
    decision: NativePermissionDecision,
  ): Promise<boolean> => {
    const result = await window.pact.respondNativePermission({
      operationId: actorOperationId,
      permissionId,
      decision,
    })
    if (!result.ok && alive.current) setError(result.error.message)
    return result.ok
  }
  const respondInput = async (input: NativeInputRespond): Promise<boolean> => {
    const result = await window.pact.respondNativeInput(input)
    if (!result.ok && alive.current) setError(result.error.message)
    return result.ok
  }
  const updateDraft = useCallback(
    (
      request: NativePermissionRequest,
      draft: Pick<NativeInputDraft, 'values' | 'page'>,
      initializeOnly?: boolean,
    ): void => {
      setDrafts((current) => {
        if (initializeOnly && current[request.id]) return current
        const actor = interactions.find((item) => item.request.id === request.id)
        if (!actor || new TextEncoder().encode(JSON.stringify(draft.values)).byteLength > 32 * 1024)
          return current
        return {
          ...current,
          [request.id]: {
            ...draft,
            operationId: request.operationId!,
            agentId: actor.agentId,
            bindingGeneration: actor.bindingGeneration,
            executorId: actor.executorId,
            expiresAt: Date.now() + 10 * 60_000,
          },
        }
      })
    },
    [interactions],
  )
  const full =
    prepared &&
    (['claude', 'codex'] as const).filter(
      (agentId) => prepared.settings.permissionModes?.[agentId] === 'full',
    )
  return (
    <dialog
      ref={dialog}
      aria-labelledby="pact-fork-heading"
      aria-describedby="pact-fork-description"
      className="m-auto max-h-[calc(100vh-3rem)] w-[min(30rem,calc(100vw-2rem))] rounded-card border-0 bg-surface p-5 text-primary shadow-xl backdrop:bg-black/30"
      onCancel={(event) => {
        event.preventDefault()
        if (!blockedClose) onClose()
      }}
    >
      <div className="flex items-center gap-2">
        <Split className="size-5 rotate-90" aria-hidden="true" />
        <h2 id="pact-fork-heading" className="text-body font-medium">
          Fork conversation
        </h2>
      </div>
      <p id="pact-fork-description" className="mt-3 text-body text-secondary">
        Keep history through this reply and share the current Project files. The original
        conversation and drafts stay available.
      </p>
      <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto">
        {preparing ? (
          <output className="flex items-center gap-2 text-caption text-secondary">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Checking native histories…
          </output>
        ) : null}
        {prepared && !operation ? (
          <>
            <blockquote className="line-clamp-3 text-caption text-secondary">
              {prepared.preview}
            </blockquote>
            <dl className="space-y-2 text-caption">
              {(['claude', 'codex'] as const).map((agentId) => (
                <div key={agentId} className="flex flex-wrap justify-between gap-2">
                  <dt className="font-medium">
                    {names[agentId]}
                    {prepared.settings.primaryAgentId === agentId ? ' · Primary' : ''}
                  </dt>
                  <dd className="min-w-0 max-w-full break-words text-right text-secondary">
                    {modelLabels[agentId] ??
                      prepared.settings.agents[agentId].model ??
                      'Native model'}{' '}
                    · {prepared.settings.agents[agentId].effort ?? 'Native effort'} ·{' '}
                    {
                      modeNames[
                        prepared.settings.permissionModes?.[agentId] ??
                          (agentId === 'claude' ? 'ask' : 'native')
                      ]
                    }
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
        {operation ? <NativeForkStates operation={operation} /> : null}
        {interactions.map(({ agentId, request }) =>
          request.kind && request.kind !== 'approval' ? (
            <NativeInputCard
              key={request.id}
              agentId={agentId}
              request={request}
              onRespond={respondInput}
              draft={drafts[request.id]}
              onDraftChange={updateDraft}
            />
          ) : (
            <NativePermissionCard
              key={request.id}
              agentId={agentId}
              request={request}
              operationId={request.operationId!}
              onRespond={respondPermission}
            />
          ),
        )}
        {error ? (
          <p role="alert" className="break-words text-caption text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
        <button type="button" className={secondary} disabled={blockedClose} onClick={onClose}>
          {operation ? 'Close' : 'Cancel'}
        </button>
        {!operation || (!receiptKnown && !blockedClose) ? (
          <button
            type="button"
            className="primary-action-button"
            disabled={preparing || !prepared || creating}
            onClick={() => void create()}
          >
            {creating ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
            {creating ? 'Creating…' : full?.length ? 'Create fork with Full access' : 'Create fork'}
          </button>
        ) : blockedClose ? (
          <button type="button" className="primary-action-button" disabled>
            <span className="primary-action-spinner" aria-hidden="true" />
            Creating…
          </button>
        ) : null}
      </div>
    </dialog>
  )
}

export function NativeForkRecovery({
  operation,
}: {
  operation: SessionForkOperation
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  if (operation.ready) return null
  const act = async (
    agentId: RuntimeAgentId,
    action: 'check' | 'initialize' | 'continue',
  ): Promise<void> => {
    if (busy) return
    setBusy(`${agentId}:${action}`)
    setError(undefined)
    try {
      const result = await window.pact.forkSession({
        action,
        agentId,
        sessionId: operation.sessionId,
        operationId: operation.id,
      })
      if (!result.ok) setError(result.error.message)
    } catch {
      setError('Native confirmation was not acknowledged. Check the original candidate.')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <section className="mt-group" aria-label="Native fork confirmation">
      <h3 className="text-body font-medium">Finish native confirmation</h3>
      <p className="mb-3 mt-1 text-caption text-secondary">
        History is available. Sending becomes available when both Native sessions are ready.
      </p>
      <NativeForkStates
        operation={operation}
        busy={busy}
        onAction={(agentId, action) => void act(agentId, action)}
      />
      {error ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}
