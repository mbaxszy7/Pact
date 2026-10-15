import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle, MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { NativeAttentionCursor, NativeAttentionPage, NativeVersion } from '@pact/contracts'

import { NativeSessionState } from './NativeSessionState'

interface AttentionRead {
  cursor?: NativeAttentionCursor
  pageIndex: number
  generation: number
}

export function NativeAttentionView({
  onBack,
  onOpenSession,
}: {
  onBack: () => void
  onOpenSession: (sessionId: string) => Promise<void>
}): React.JSX.Element {
  const [page, setPage] = useState<NativeAttentionPage>()
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [openingSessionId, setOpeningSessionId] = useState<string>()
  const backRef = useRef<HTMLButtonElement>(null)
  const pageRef = useRef<NativeAttentionPage | undefined>(undefined)
  const queueReadRef = useRef<
    ((cursor?: NativeAttentionCursor, index?: number) => void) | undefined
  >(undefined)
  const openingRef = useRef(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    const trigger = document.activeElement
    backRef.current?.focus({ preventScroll: true })
    let active = true
    let inFlight = false
    let generation = 0
    let latest: AttentionRead | undefined
    let announcedVersion: NativeVersion | undefined

    const drain = (): void => {
      if (!active || inFlight || !latest) return
      const request = latest
      latest = undefined
      inFlight = true
      setLoading(true)
      setError(undefined)
      void window.pact
        .readNativeAttention(request.cursor ? { cursor: request.cursor } : {})
        .then((result) => {
          if (!active || request.generation !== generation) return undefined
          if (!result.ok) {
            setError(result.error.message)
            return undefined
          }
          pageRef.current = result.value
          setPage(result.value)
          setPageIndex(request.pageIndex)
          return undefined
        })
        .catch(() => {
          if (active && request.generation === generation)
            setError('Could not read Sessions needing attention. Try again to refresh the list.')
        })
        .finally(() => {
          inFlight = false
          if (!active) return
          if (latest) drain()
          else setLoading(false)
        })
    }
    const queueRead = (cursor?: NativeAttentionCursor, index = 0): void => {
      latest = {
        ...(cursor ? { cursor } : {}),
        pageIndex: index,
        generation: ++generation,
      }
      drain()
    }
    queueReadRef.current = queueRead
    const remove = window.pact.onNativePresenceChanged((version) => {
      const current = announcedVersion ?? pageRef.current?.version
      if (current?.incarnation === version.incarnation && current.revision >= version.revision)
        return
      announcedVersion = version
      // A changed keyset starts at its first page. Only one read and one latest
      // request are retained, even when several state changes arrive together.
      queueRead()
    })
    queueRead()
    return () => {
      active = false
      activeRef.current = false
      latest = undefined
      queueReadRef.current = undefined
      remove()
      if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.closest('[inert]'))
        trigger.focus({ preventScroll: true })
    }
  }, [])

  const openSession = async (sessionId: string): Promise<void> => {
    if (openingRef.current) return
    openingRef.current = true
    setOpeningSessionId(sessionId)
    try {
      await onOpenSession(sessionId)
    } finally {
      openingRef.current = false
      if (activeRef.current) setOpeningSessionId(undefined)
    }
  }

  const start = page?.sessions.length ? pageIndex * 5 + 1 : 0
  const end = page ? pageIndex * 5 + page.sessions.length : 0
  return (
    <section
      className="pact-native-attention bg-surface text-primary"
      aria-labelledby="pact-native-attention-title"
      aria-busy={loading}
    >
      <header className="pact-titlebar h-12 shrink-0 border-b border-border bg-surface">
        <div className="pact-titlebar-content flex h-full items-center px-group text-body font-medium">
          Pact
        </div>
      </header>
      <div className="pact-native-attention-content">
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="pact-native-attention-back text-body text-secondary hover:bg-surface-muted hover:text-primary"
        >
          <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
          Back to workspace
        </button>
        <header className="pact-native-attention-heading">
          <h1 id="pact-native-attention-title" className="text-title font-medium">
            Needs attention
          </h1>
          <p className="text-body text-secondary">
            Open a Session to review its pending decision or new result.
          </p>
        </header>
        <output className="pact-native-attention-summary text-body text-secondary">
          <span>
            {page
              ? `${page.total} ${page.total === 1 ? 'Session needs' : 'Sessions need'} attention`
              : 'Loading Sessions…'}
          </span>
          {loading && page ? (
            <span className="pact-native-quit-progress text-caption">
              <LoaderCircle
                aria-hidden="true"
                className="size-4 session-activity-spin"
                strokeWidth={1.75}
              />
              Refreshing…
            </span>
          ) : null}
        </output>
        {error ? (
          <div className="pact-native-attention-error text-body" role="alert">
            <CircleAlert aria-hidden="true" className="size-4 text-danger" strokeWidth={1.75} />
            <p className="text-danger">{error}</p>
            <button
              type="button"
              disabled={loading}
              onClick={() => queueReadRef.current?.()}
              className="h-8 rounded-control px-group font-medium text-primary hover:bg-surface-muted disabled:opacity-45"
            >
              Refresh list
            </button>
          </div>
        ) : null}
        {page?.sessions.length ? (
          <ul className="pact-native-attention-sessions" aria-label="Sessions needing attention">
            {page.sessions.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  disabled={loading || Boolean(openingSessionId)}
                  onClick={() => void openSession(session.sessionId)}
                  className="pact-native-attention-session hover:bg-surface-muted disabled:opacity-60"
                >
                  {openingSessionId === session.sessionId ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 shrink-0 session-activity-spin text-secondary"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <MessageSquare
                      aria-hidden="true"
                      className="size-4 shrink-0 text-secondary"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="pact-native-session-name">
                    <span className="text-body font-medium">{session.title}</span>
                    <span className="text-caption text-secondary">{session.projectName}</span>
                  </span>
                  <span className="pact-native-attention-session-status">
                    <NativeSessionState state={session.state} />
                    {session.unread ? (
                      <span className="text-caption text-secondary">Unread</span>
                    ) : null}
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-secondary"
                    strokeWidth={1.75}
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : !loading && !error ? (
          <p className="pact-native-attention-empty text-body text-secondary">
            No Sessions need your attention right now.
          </p>
        ) : null}
        {page?.total ? (
          <nav className="pact-native-attention-pages" aria-label="Attention list pages">
            <p className="text-caption text-secondary" aria-live="polite">
              {start}–{end} of {page.total}
            </p>
            <button
              type="button"
              disabled={loading || pageIndex === 0}
              onClick={() => queueReadRef.current?.()}
              className="h-8 rounded-control px-group text-body text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-45"
            >
              First page
            </button>
            <button
              type="button"
              disabled={loading || !page.nextCursor}
              onClick={() => {
                if (page.nextCursor) queueReadRef.current?.(page.nextCursor, pageIndex + 1)
              }}
              className="h-8 rounded-control bg-surface-inverse px-group text-body font-medium text-inverse disabled:opacity-45"
            >
              Next page
            </button>
          </nav>
        ) : null}
      </div>
    </section>
  )
}
