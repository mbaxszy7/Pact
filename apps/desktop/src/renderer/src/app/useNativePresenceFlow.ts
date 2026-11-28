import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import type {
  NativeNavigationIntent,
  NativeQuitState,
  RuntimePreparation,
  SessionCatalogChange,
} from '@pact/contracts'

import { NATIVE_METADATA_TIMEOUT_MS, NATIVE_RECENT_CANDIDATES } from '@pact/contracts'

import type { NavigationIntent } from '../components/workspace/ProjectNavigation'

import { foundationQueryKeys } from '../query-client'

interface NativeSessionOpening {
  sessionId: string
  openingId: string
  selectionEpoch: number
  deadline: number
}

interface NativeOpeningQueue {
  active: boolean
  inFlight?: NativeSessionOpening | undefined
  pending: NativeSessionOpening[]
}

export interface WindowPresenceFlow {
  documentVisible: boolean
  windowFocused: boolean
  nativeAttentionOpen: boolean
  setNativeAttentionOpen: React.Dispatch<React.SetStateAction<boolean>>
  nativeQuitState: NativeQuitState | null
  navigationIntent: NavigationIntent | undefined
  requestSessionLocation: (projectId: string, sessionId: string) => void
  beginUserSelection: () => number
  recordSessionOpened: (sessionId: string, openingId: string) => void
  acknowledgeNativeNavigation: (navigationId: string) => void
  userSelectionEpochRef: React.RefObject<number>
  nativeNavigationRequestRef: React.RefObject<number>
  nativeNavigationIntentRef: React.RefObject<NativeNavigationIntent | undefined>
  acknowledgedNativeNavigationRef: React.RefObject<string | undefined>
}

export function useWindowPresence({
  showWarning,
}: {
  showWarning: (message: string) => void
}): WindowPresenceFlow {
  const queryClient = useQueryClient()
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [nativeAttentionOpen, setNativeAttentionOpen] = useState(false)
  const [nativeQuitState, setNativeQuitState] = useState<NativeQuitState | null>(null)
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent>()

  const userSelectionEpochRef = useRef(0)
  const nativeNavigationRequestRef = useRef(0)
  const nativeNavigationIntentRef = useRef<NativeNavigationIntent | undefined>(undefined)
  const acknowledgedNativeNavigationRef = useRef<string | undefined>(undefined)
  const nativeQuitFocusRef = useRef<HTMLElement | undefined>(undefined)
  const nativeQuitOperationRef = useRef<string | undefined>(undefined)
  const nativeOpeningQueueRef = useRef<NativeOpeningQueue>({ active: true, pending: [] })

  useEffect(() => {
    const updateVisibility = (): void => {
      setDocumentVisible(!document.hidden)
      setWindowFocused(document.hasFocus())
    }
    const updateFocus = (): void => setWindowFocused(document.hasFocus())
    updateVisibility()
    const refreshRuntime = (): void => {
      if (document.hidden) return
      const state = queryClient.getQueryState<RuntimePreparation>(
        foundationQueryKeys.runtimePreparation,
      )
      const allReady =
        state?.data !== undefined && state.data.agents.every((agent) => agent.state === 'ready')
      if (allReady && state.dataUpdatedAt > 0 && Date.now() - state.dataUpdatedAt < 15_000) {
        return
      }
      void queryClient.refetchQueries(
        { queryKey: foundationQueryKeys.runtimePreparation, exact: true },
        { cancelRefetch: false },
      )
    }
    document.addEventListener('visibilitychange', updateVisibility)
    document.addEventListener('focusin', updateFocus)
    window.addEventListener('focus', updateFocus)
    window.addEventListener('blur', updateFocus)
    window.addEventListener('focus', refreshRuntime)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      document.removeEventListener('focusin', updateFocus)
      window.removeEventListener('focus', updateFocus)
      window.removeEventListener('blur', updateFocus)
      window.removeEventListener('focus', refreshRuntime)
    }
  }, [queryClient])

  const acknowledgeNativeNavigation = useCallback((navigationId: string): void => {
    if (nativeNavigationIntentRef.current?.navigationId !== navigationId) return
    nativeNavigationIntentRef.current = undefined
    acknowledgedNativeNavigationRef.current = navigationId
    // ACK is bounded to the current intent. An uncertain ACK is not retried:
    // its stable opening ID also prevents a later redelivery from reordering MRU.
    void window.pact.acknowledgeNativeNavigation({ navigationId }).catch(() => undefined)
  }, [])

  const requestSessionLocation = useCallback((projectId: string, sessionId: string): void => {
    setNavigationIntent({ projectId, sessionId, focus: false })
  }, [])

  const beginUserSelection = useCallback((): number => {
    setNavigationIntent(undefined)
    nativeNavigationRequestRef.current++
    const intent = nativeNavigationIntentRef.current
    if (intent) acknowledgeNativeNavigation(intent.navigationId)
    return ++userSelectionEpochRef.current
  }, [acknowledgeNativeNavigation])

  const recordSessionOpened = useCallback(
    (sessionId: string, openingId: string): void => {
      const owner = nativeOpeningQueueRef.current
      if (!owner.active || owner.inFlight?.openingId === openingId) return
      if (owner.pending.some((item) => item.openingId === openingId)) return
      // Only the latest uncommitted visit to the same Session is needed. The
      // durable Utility receipt, rather than this queue, owns saved MRU order.
      owner.pending = owner.pending.filter((item) => item.sessionId !== sessionId)
      if (owner.pending.length >= NATIVE_RECENT_CANDIDATES) {
        showWarning('Couldn’t update your recent sessions list.')
        return
      }
      owner.pending.push({
        sessionId,
        openingId,
        selectionEpoch: userSelectionEpochRef.current,
        deadline: performance.now() + NATIVE_METADATA_TIMEOUT_MS,
      })
      owner.pending.sort((left, right) => left.selectionEpoch - right.selectionEpoch)
      const drain = (): void => {
        if (!owner.active) {
          owner.pending = []
          return
        }
        if (owner.inFlight) return
        const next = owner.pending.shift()
        if (!next) return
        if (performance.now() >= next.deadline) {
          showWarning('Couldn’t update your recent sessions list.')
          drain()
          return
        }
        owner.inFlight = next
        void window.pact
          .recordNativeSessionOpened({ sessionId: next.sessionId, openingId: next.openingId })
          .then((result) => {
            if (owner.active && !result.ok)
              showWarning('Could not confirm the recent Session list. Your Session is still open.')
            return undefined
          })
          .catch(() => {
            if (owner.active)
              showWarning('Could not confirm the recent Session list. Your Session is still open.')
          })
          .finally(() => {
            owner.inFlight = undefined
            drain()
          })
      }
      drain()
    },
    [showWarning],
  )

  useEffect(() => {
    const owner = nativeOpeningQueueRef.current
    owner.active = true
    return () => {
      owner.active = false
      owner.pending = []
    }
  }, [])

  useEffect(() => {
    let active = true
    let changed = false
    const receive = (state: NativeQuitState | null): void => {
      changed = true
      if (!active) return
      if (state && state.operationId !== nativeQuitOperationRef.current) {
        nativeQuitOperationRef.current = state.operationId
        beginUserSelection()
      }
      if (state && !nativeQuitFocusRef.current && document.activeElement instanceof HTMLElement)
        nativeQuitFocusRef.current = document.activeElement
      if (!state) {
        nativeQuitOperationRef.current = undefined
        const focus = nativeQuitFocusRef.current
        nativeQuitFocusRef.current = undefined
        window.requestAnimationFrame(() => {
          const modal = document.querySelector('dialog:modal')
          if (
            active &&
            focus?.isConnected &&
            !focus.closest('[inert]') &&
            (!modal || (focus && modal.contains(focus)))
          )
            focus.focus({ preventScroll: true })
        })
      }
      setNativeQuitState(state)
    }
    const remove = window.pact.onNativeQuitStateChanged(receive)
    void window.pact
      .getNativeQuitState()
      .then((result) => {
        if (active && !changed && result.ok) receive(result.value)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
      remove()
    }
  }, [beginUserSelection])

  return {
    documentVisible,
    windowFocused,
    nativeAttentionOpen,
    setNativeAttentionOpen,
    nativeQuitState,
    navigationIntent,
    requestSessionLocation,
    beginUserSelection,
    recordSessionOpened,
    acknowledgeNativeNavigation,
    userSelectionEpochRef,
    nativeNavigationRequestRef,
    nativeNavigationIntentRef,
    acknowledgedNativeNavigationRef,
  }
}

export function useNativeNavigation({
  presence,
  showWarning,
  onEnterResolvedSession,
  onBackToWorkspace,
}: {
  presence: WindowPresenceFlow
  showWarning: (message: string) => void
  onEnterResolvedSession: (change: SessionCatalogChange, openingId: string) => void
  onBackToWorkspace: () => void
}): { openAttentionSession: (sessionId: string) => Promise<void> } {
  const {
    acknowledgeNativeNavigation,
    acknowledgedNativeNavigationRef,
    beginUserSelection,
    nativeNavigationIntentRef,
    nativeNavigationRequestRef,
    setNativeAttentionOpen,
    userSelectionEpochRef,
  } = presence

  const acceptNativeSession = useEffectEvent(onEnterResolvedSession)
  const showNativeAttention = useEffectEvent((): void => setNativeAttentionOpen(true))
  const showNativeWorkspace = useEffectEvent(onBackToWorkspace)

  useEffect(() => {
    let active = true
    let changed = false
    let resolving = false
    let pending:
      | {
          intent: Extract<NativeNavigationIntent, { kind: 'session' }>
          requestId: number
          selectionEpoch: number
        }
      | undefined
    const drain = (): void => {
      if (!active || resolving || !pending) return
      const { intent, requestId, selectionEpoch } = pending
      pending = undefined
      const current = (): boolean =>
        active &&
        nativeNavigationRequestRef.current === requestId &&
        userSelectionEpochRef.current === selectionEpoch &&
        nativeNavigationIntentRef.current?.navigationId === intent.navigationId
      if (!current()) return
      resolving = true
      void window.pact
        .resolveNativeSession({ sessionId: intent.sessionId })
        .then((result) => {
          if (!current()) return undefined
          if (result.ok) acceptNativeSession(result.value, intent.navigationId)
          else showWarning(result.error.message)
          acknowledgeNativeNavigation(intent.navigationId)
          return undefined
        })
        .catch(() => {
          if (!current()) return
          showWarning('Could not open this Session. Try its shortcut again to check its status.')
          acknowledgeNativeNavigation(intent.navigationId)
        })
        .finally(() => {
          resolving = false
          drain()
        })
    }
    const receive = (intent: NativeNavigationIntent): void => {
      changed = true
      if (
        !active ||
        intent.navigationId === nativeNavigationIntentRef.current?.navigationId ||
        intent.navigationId === acknowledgedNativeNavigationRef.current
      )
        return
      nativeNavigationIntentRef.current = intent
      const requestId = ++nativeNavigationRequestRef.current
      const selectionEpoch = ++userSelectionEpochRef.current
      if (intent.kind === 'attention') {
        pending = undefined
        showNativeAttention()
        acknowledgeNativeNavigation(intent.navigationId)
        return
      }
      if (intent.kind === 'workspace') {
        pending = undefined
        showNativeWorkspace()
        acknowledgeNativeNavigation(intent.navigationId)
        return
      }
      pending = { intent, requestId, selectionEpoch }
      drain()
    }
    const remove = window.pact.onNativeNavigationChanged(receive)
    const readSelectionEpoch = userSelectionEpochRef.current
    void window.pact
      .getNativeNavigation()
      .then((result) => {
        if (active && !changed && result.ok && result.value) {
          if (readSelectionEpoch === userSelectionEpochRef.current) receive(result.value)
          else {
            nativeNavigationIntentRef.current = result.value
            acknowledgeNativeNavigation(result.value.navigationId)
          }
        }
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
      pending = undefined
      remove()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- This is a request generation, not a rendered node; invalidate the current asynchronous resolve on disposal.
      nativeNavigationRequestRef.current++
      nativeNavigationIntentRef.current = undefined
    }
  }, [
    acknowledgeNativeNavigation,
    acknowledgedNativeNavigationRef,
    nativeNavigationIntentRef,
    nativeNavigationRequestRef,
    showWarning,
    userSelectionEpochRef,
  ])

  const openAttentionSession = async (sessionId: string): Promise<void> => {
    const selectionEpoch = beginUserSelection()
    const requestId = ++nativeNavigationRequestRef.current
    const openingId = crypto.randomUUID()
    try {
      const result = await window.pact.resolveNativeSession({ sessionId })
      if (
        selectionEpoch !== userSelectionEpochRef.current ||
        requestId !== nativeNavigationRequestRef.current
      )
        return
      if (!result.ok) {
        showWarning(result.error.message)
        return
      }
      onEnterResolvedSession(result.value, openingId)
    } catch {
      if (
        selectionEpoch === userSelectionEpochRef.current &&
        requestId === nativeNavigationRequestRef.current
      )
        showWarning('Could not open this Session. Try again to check its status.')
    }
  }

  return { openAttentionSession }
}
