import { useCallback, useEffect, useRef, useState } from 'react'

import type { NativeInteractionDetails } from '@pact/contracts'

/** At most eight mounted requests; one ≤32 KiB read/request, fenced by identity and 30s. */
export function useNativeInteractionDetails(
  operationId: string | undefined,
  requestId: string,
): {
  details: NativeInteractionDetails | undefined
  error: string | undefined
  loading: boolean
  retry: () => void
} {
  const [snapshot, setSnapshot] = useState<{
    operationId: string
    requestId: string
    revision: number
    details?: NativeInteractionDetails
    error?: string
  }>()
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    if (!operationId) return undefined
    const ticket = ++generation.current
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled || ticket !== generation.current) return
      settled = true
      setSnapshot({
        operationId,
        requestId,
        revision,
        error: 'The native request took too long to load. Try again.',
      })
    }, 30000)
    void window.pact
      .readNativeInput({ operationId, requestId })
      .then((result) => {
        if (settled || ticket !== generation.current) return undefined
        settled = true
        window.clearTimeout(timer)
        setSnapshot({
          operationId,
          requestId,
          revision,
          ...(result.ok ? { details: result.value } : { error: result.error.message }),
        })
        return undefined
      })
      .catch(() => {
        if (settled || ticket !== generation.current) return
        settled = true
        window.clearTimeout(timer)
        setSnapshot({
          operationId,
          requestId,
          revision,
          error: 'The native request could not load. Try again.',
        })
      })
    return () => {
      settled = true
      generation.current += 1
      window.clearTimeout(timer)
    }
  }, [operationId, requestId, revision])
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  const current =
    snapshot &&
    snapshot.operationId === operationId &&
    snapshot.requestId === requestId &&
    snapshot.revision === revision
      ? snapshot
      : undefined
  return {
    details: current?.details,
    error: operationId ? current?.error : 'This native request is no longer active.',
    loading: Boolean(operationId && !current),
    retry,
  }
}
