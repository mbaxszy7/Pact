import { QueryClient } from '@tanstack/react-query'

import type { AppError, RpcResult } from '@pact/contracts'

export const foundationQueryKeys = {
  appInfo: ['foundation', 'app-info'] as const,
  runtimeHealth: ['foundation', 'runtime-health'] as const,
  runtimePreparation: ['foundation', 'runtime-preparation'] as const,
}

export const defaultSessionSettingsQueryKeys = {
  editor: ['default-session-settings', 'editor'] as const,
}

export const projectCatalogQueryKeys = {
  catalog: ['project-catalog'] as const,
}

export const sessionWorkspaceQueryKeys = {
  catalog: ['session-workspace', 'catalog'] as const,
  creation: (projectId: string) => ['session-workspace', 'creation', projectId] as const,
  settings: (sessionId: string) => ['session-workspace', 'settings', sessionId] as const,
}

export const conversationQueryKeys = {
  session: (sessionId: string) => ['conversation', sessionId] as const,
}

export const appearanceQueryKeys = {
  settings: ['appearance', 'settings'] as const,
}

export function createRendererQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
      mutations: {
        retry: 0,
      },
    },
  })
}

export class RpcError extends Error {
  readonly code: AppError['code']

  constructor(error: AppError) {
    super(error.message)
    this.code = error.code
  }
}

export function unwrapRpcResult<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new RpcError(result.error)
  return result.value
}
