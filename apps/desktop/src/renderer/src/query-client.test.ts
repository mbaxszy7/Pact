import { describe, expect, it } from 'vitest'

import {
  createRendererQueryClient,
  foundationQueryKeys,
  RpcError,
  unwrapRpcResult,
} from './query-client'

describe('renderer query foundation', () => {
  it('uses stable namespaced query keys', () => {
    expect(foundationQueryKeys).toEqual({
      appInfo: ['foundation', 'app-info'],
      runtimeHealth: ['foundation', 'runtime-health'],
      runtimePreparation: ['foundation', 'runtime-preparation'],
    })
  })

  it('unwraps successful IPC results', () => {
    expect(unwrapRpcResult({ ok: true, value: 'ready' })).toBe('ready')
  })

  it('turns an IPC error into a query error', () => {
    expect(() =>
      unwrapRpcResult({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Runtime unavailable' },
      }),
    ).toThrow('Runtime unavailable')
  })

  it('disables automatic window-focus refetching', () => {
    const client = createRendererQueryClient()
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })

  it('preserves domain error codes independently of human-facing wording', () => {
    const error = (() => {
      try {
        unwrapRpcResult({
          ok: false,
          error: { code: 'COMMENT_LIMIT', message: 'Custom limit notice' },
        })
      } catch (caught) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: 'COMMENT_LIMIT', message: 'Custom limit notice' })
  })
})
