import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import type {
  ProviderUsageProvider,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from '@pact/contracts'

const PROVIDERS: readonly ProviderUsageProvider[] = ['codex', 'claude', 'agy']
const CLOCK_TICK_MS = 30_000
const STALE_AFTER_MS = 5 * 60 * 1000

function createIdleSnapshot(provider: ProviderUsageProvider): ProviderUsageSnapshot {
  return {
    provider,
    revision: 0,
    status: 'idle',
    fiveHour: null,
    sevenDay: null,
    checkedAt: null,
    cooldownUntil: null,
    identityConfirmed: false,
  }
}

export function isUsageSnapshotStale(snapshot: ProviderUsageSnapshot, nowMs: number): boolean {
  if (snapshot.status === 'stale') return true
  if (snapshot.status !== 'ready' && snapshot.status !== 'partial') return false
  const checkedAtMs = snapshot.checkedAt ? Date.parse(snapshot.checkedAt) : Number.NaN
  if (Number.isFinite(checkedAtMs) && nowMs - checkedAtMs > STALE_AFTER_MS) return true
  const windows: Array<ProviderUsageWindow | null> = snapshot.pools?.length
    ? snapshot.pools.flatMap((pool) => [pool.fiveHour, pool.sevenDay])
    : [snapshot.fiveHour, snapshot.sevenDay]
  for (const window of windows) {
    if (!window?.resetsAt) continue
    const resetsMs = Date.parse(window.resetsAt)
    if (Number.isFinite(resetsMs) && resetsMs <= nowMs) return true
  }
  return false
}

export interface ProviderUsageViewState {
  snapshots: Record<ProviderUsageProvider, ProviderUsageSnapshot>
  refreshing: Record<ProviderUsageProvider, boolean>
  nowMs: number
  refresh: (provider: ProviderUsageProvider) => void
}

export function useProviderUsage(visible: boolean): ProviderUsageViewState {
  const [snapshots, setSnapshots] = useState<Record<ProviderUsageProvider, ProviderUsageSnapshot>>(
    () => ({
      codex: createIdleSnapshot('codex'),
      claude: createIdleSnapshot('claude'),
      agy: createIdleSnapshot('agy'),
    }),
  )
  const [refreshing, setRefreshing] = useState<Record<ProviderUsageProvider, boolean>>(() => ({
    codex: false,
    claude: false,
    agy: false,
  }))
  const [documentVisible, setDocumentVisible] = useState<boolean>(
    () => typeof document === 'undefined' || !document.hidden,
  )
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  const inFlightRef = useRef<Partial<Record<ProviderUsageProvider, string>>>({})
  const syncTimersRef = useRef<Partial<Record<ProviderUsageProvider, number>>>({})
  const closeUnconfirmedAttemptsRef = useRef<Partial<Record<ProviderUsageProvider, number>>>({})
  const syncFnRef = useRef<(provider: ProviderUsageProvider) => void>(() => undefined)
  const mountedRef = useRef(true)

  const clearSyncTimer = useCallback((provider: ProviderUsageProvider): void => {
    const existing = syncTimersRef.current[provider]
    if (existing !== undefined) {
      window.clearTimeout(existing)
      delete syncTimersRef.current[provider]
    }
  }, [])

  const clearSyncTimers = useCallback((): void => {
    for (const provider of PROVIDERS) {
      clearSyncTimer(provider)
    }
  }, [clearSyncTimer])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearSyncTimers()
    }
  }, [clearSyncTimers])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleVisibilityChange = (): void => {
      setDocumentVisible(!document.hidden)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  const effectiveVisible = visible && documentVisible

  const cancelAllInFlight = useCallback((): void => {
    clearSyncTimers()
    const activeEntries: { provider: ProviderUsageProvider; requestId: string }[] = []
    for (const provider of PROVIDERS) {
      const requestId = inFlightRef.current[provider]
      if (requestId) activeEntries.push({ provider, requestId })
    }
    if (activeEntries.length === 0) return
    inFlightRef.current = {}
    if (mountedRef.current) {
      setRefreshing({ codex: false, claude: false, agy: false })
    }
    if (typeof window.pact?.cancelProviderUsage === 'function') {
      for (const entry of activeEntries) {
        void window.pact.cancelProviderUsage(entry).catch(() => undefined)
      }
    }
  }, [clearSyncTimers])

  const scheduleSync = useEffectEvent((provider: ProviderUsageProvider, delayMs: number): void => {
    if (!mountedRef.current || !effectiveVisible) return
    clearSyncTimer(provider)
    syncTimersRef.current[provider] = window.setTimeout(() => {
      delete syncTimersRef.current[provider]
      syncFnRef.current(provider)
    }, delayMs)
  })

  const startRefresh = useEffectEvent(
    (provider: ProviderUsageProvider, hintSnapshot?: ProviderUsageSnapshot): void => {
      if (!mountedRef.current || !effectiveVisible) return
      if (typeof window.pact?.refreshProviderUsage !== 'function') return
      if (inFlightRef.current[provider]) return

      clearSyncTimer(provider)
      closeUnconfirmedAttemptsRef.current[provider] = 0
      const requestId = crypto.randomUUID()
      inFlightRef.current[provider] = requestId
      setRefreshing((current) => ({ ...current, [provider]: true }))
      setSnapshots((current) => {
        const baseline = hintSnapshot ?? current[provider]
        const retainWindows =
          baseline.identityConfirmed &&
          (baseline.fiveHour ||
            baseline.sevenDay ||
            Boolean(baseline.pools?.some((pool) => pool.fiveHour || pool.sevenDay)))
        const { pools: _previousPools, ...baselineWithoutPools } = baseline
        return {
          ...current,
          [provider]: {
            ...baselineWithoutPools,
            status: 'loading',
            fiveHour: retainWindows ? baseline.fiveHour : null,
            sevenDay: retainWindows ? baseline.sevenDay : null,
            ...(retainWindows && baseline.pools ? { pools: baseline.pools } : {}),
            message: undefined,
          },
        }
      })

      void window.pact
        .refreshProviderUsage({ provider, requestId })
        .then((result) => {
          if (!mountedRef.current || inFlightRef.current[provider] !== requestId) return undefined
          delete inFlightRef.current[provider]
          setRefreshing((current) => ({ ...current, [provider]: false }))
          setNowMs(Date.now())
          if (result.ok) {
            const snapshot = result.value
            setSnapshots((current) => ({ ...current, [provider]: snapshot }))
            if (
              snapshot.status === 'loading' ||
              snapshot.status === 'busy' ||
              snapshot.status === 'cancelling'
            ) {
              scheduleSync(provider, 350)
            }
          } else {
            setSnapshots((current) => {
              const { pools: _previousPools, ...previousWithoutPools } = current[provider]
              return {
                ...current,
                [provider]: {
                  ...previousWithoutPools,
                  status: 'unavailable',
                  fiveHour: null,
                  sevenDay: null,
                  identityConfirmed: false,
                  message: 'Unavailable',
                },
              }
            })
          }
          return undefined
        })
        .catch(() => {
          if (!mountedRef.current || inFlightRef.current[provider] !== requestId) return undefined
          delete inFlightRef.current[provider]
          setRefreshing((current) => ({ ...current, [provider]: false }))
          setNowMs(Date.now())
          setSnapshots((current) => {
            const { pools: _previousPools, ...previousWithoutPools } = current[provider]
            return {
              ...current,
              [provider]: {
                ...previousWithoutPools,
                status: 'unavailable',
                fiveHour: null,
                sevenDay: null,
                identityConfirmed: false,
                message: 'Unavailable',
              },
            }
          })
          return undefined
        })
    },
  )

  const syncProvider = useEffectEvent((provider: ProviderUsageProvider): void => {
    clearSyncTimer(provider)
    if (!mountedRef.current || !effectiveVisible || inFlightRef.current[provider]) return
    if (typeof window.pact?.getProviderUsage !== 'function') return
    void window.pact
      .getProviderUsage({ provider })
      .then((result) => {
        if (!mountedRef.current || !effectiveVisible || inFlightRef.current[provider]) {
          return undefined
        }
        if (!result.ok) return undefined
        const snapshot = result.value
        const now = Date.now()
        setNowMs(now)
        setSnapshots((current) => ({ ...current, [provider]: snapshot }))
        if (
          snapshot.status === 'loading' ||
          snapshot.status === 'busy' ||
          snapshot.status === 'cancelling'
        ) {
          closeUnconfirmedAttemptsRef.current[provider] = 0
          scheduleSync(provider, 350)
          return undefined
        }
        if (snapshot.status === 'close_unconfirmed') {
          const attempts = closeUnconfirmedAttemptsRef.current[provider] ?? 0
          if (attempts < 10) {
            closeUnconfirmedAttemptsRef.current[provider] = attempts + 1
            scheduleSync(provider, Math.min(5_000, 350 * 2 ** attempts))
          }
          return undefined
        }
        closeUnconfirmedAttemptsRef.current[provider] = 0
        return undefined
      })
      .catch(() => undefined)
  })

  useEffect(() => {
    syncFnRef.current = syncProvider
  })

  useEffect(() => {
    if (!effectiveVisible) {
      cancelAllInFlight()
      return undefined
    }

    for (const provider of PROVIDERS) {
      syncProvider(provider)
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, CLOCK_TICK_MS)

    return () => {
      window.clearInterval(interval)
      cancelAllInFlight()
    }
  }, [cancelAllInFlight, effectiveVisible])

  useEffect(() => {
    if (!effectiveVisible) return undefined
    let nextWakeMs: number | undefined
    for (const provider of PROVIDERS) {
      const snapshot = snapshots[provider]
      for (const timestamp of [
        snapshot.cooldownUntil,
        snapshot.fiveHour?.resetsAt,
        snapshot.sevenDay?.resetsAt,
      ]) {
        if (!timestamp) continue
        const targetMs = Date.parse(timestamp)
        if (!Number.isFinite(targetMs) || targetMs <= nowMs) continue
        if (nextWakeMs === undefined || targetMs < nextWakeMs) nextWakeMs = targetMs
      }
    }
    if (nextWakeMs === undefined || nextWakeMs - nowMs > 65_000) return undefined
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.max(100, nextWakeMs - nowMs + 50),
    )
    return () => window.clearTimeout(timer)
  }, [effectiveVisible, nowMs, snapshots])

  const refresh = (provider: ProviderUsageProvider): void => {
    startRefresh(provider)
  }

  return { snapshots, refreshing, nowMs, refresh }
}
