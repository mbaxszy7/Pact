import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import type { RpcResult, UpdateState } from '@pact/contracts'

export function useAppUpdates(
  onOpen: () => void,
  onNotice: (message: string) => void,
  canNotify: boolean,
) {
  const [state, setState] = useState<UpdateState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const current = useRef<UpdateState | undefined>(undefined)
  const mounted = useRef(false)
  const claiming = useRef(false)
  const attempted = useRef<string | undefined>(undefined)
  const settingsRequest = useRef(0)
  const open = useEffectEvent(onOpen)
  const notice = useEffectEvent(onNotice)
  const allowed = useRef(canNotify)
  useEffect(() => {
    allowed.current = canNotify
  }, [canNotify])

  const accept = useCallback((next: UpdateState): void => {
    if (!mounted.current || (current.current && next.stateVersion < current.current.stateVersion))
      return
    current.current = next
    setState(next)
  }, [])

  const run = useCallback(
    async (request: () => Promise<RpcResult<UpdateState>>): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const result = await request()
        if (!mounted.current) return
        if (result.ok) accept(result.value)
        else setError(result.error.message)
      } catch {
        if (mounted.current) setError('Couldn’t load update settings. Try again.')
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [accept],
  )

  useEffect(() => {
    mounted.current = true
    const remove = window.pact.onUpdateStateChanged(accept)
    void window.pact
      .getUpdateState()
      .then((result) => {
        if (!mounted.current) return undefined
        if (result.ok) accept(result.value)
        else setError(result.error.message)
        return undefined
      })
      .catch(() => {
        if (mounted.current) setError('Couldn’t load update settings. Try again.')
      })
    return () => {
      mounted.current = false
      remove()
    }
  }, [accept])

  useEffect(() => {
    if (state && state.settingsRequest > settingsRequest.current) {
      settingsRequest.current = state.settingsRequest
      open()
    }
  }, [state])

  const tryNotice = useEffectEvent(async (): Promise<void> => {
    const candidate = current.current
    if (
      !allowed.current ||
      document.hidden ||
      claiming.current ||
      !candidate?.updateAvailable ||
      !candidate.noticePending ||
      !candidate.latest ||
      attempted.current === candidate.latest.version
    )
      return
    const version = candidate.latest.version
    claiming.current = true
    try {
      const result = await window.pact.claimUpdateNotice({ version })
      if (!mounted.current) return
      if (!result.ok) {
        attempted.current = version
        return
      }
      if (
        result.value.claimed &&
        allowed.current &&
        !document.hidden &&
        current.current?.latest?.version === version
      )
        notice(`Pact ${version} is available. See About & updates.`)
    } catch {
      attempted.current = version
    } finally {
      claiming.current = false
    }
  })

  useEffect(() => {
    if (state?.noticePending && canNotify) void tryNotice()
  }, [state, canNotify])
  useEffect(() => {
    const attempt = (): void => {
      void tryNotice()
    }
    const remove = window.pact.onNativePresenceChanged(attempt)
    document.addEventListener('visibilitychange', attempt)
    window.addEventListener('focus', attempt)
    return () => {
      remove()
      document.removeEventListener('visibilitychange', attempt)
      window.removeEventListener('focus', attempt)
    }
  }, [])

  return {
    state,
    busy,
    error,
    check: () => run(() => window.pact.checkForUpdates()),
    retry: () => run(() => window.pact.getUpdateState()),
    setAutoCheck: (autoCheck: boolean) => {
      const value = current.current
      if (!value?.preferencesReady || busy) return Promise.resolve()
      return run(() =>
        window.pact.setUpdatePreferences({ autoCheck, expectedRevision: value.revision }),
      )
    },
  }
}
