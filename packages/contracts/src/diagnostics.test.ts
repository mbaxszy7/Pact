import { describe, expect, it } from 'vitest'

import {
  diagnosticEventSchema,
  diagnosticRequestTypeSchema,
  LOG_RECORD_BYTES,
} from './diagnostics.js'
import { utilityRequestSchema } from './index.js'

const randomUUID = (): string => '00000000-0000-4000-8000-000000000001'
const catalogIdentity = {
  reason: 'missing',
  initialPresent: false,
  refreshed: true,
  captureExited: false,
  captureClosed: false,
  cleanupExited: true,
  cleanupClosed: false,
  pidZero: 'ESRCH',
  groupZero: 'ESRCH',
} as const

describe('Diagnostic trust contract', () => {
  it.each([
    { reason: 'private-output' },
    { initialPresent: 'private-output' },
    { pidZero: '/private/credential/path' },
    { pid: 1234 },
    { env: 'private-output' },
  ])('rejects unreviewed identity facts $reason$initialPresent$pidZero$pid$env', (extra) => {
    expect(
      diagnosticEventSchema.safeParse({
        operation: 'ipc',
        phase: 'failed',
        settingsCatalogFailure: 'root_identity',
        settingsCatalogIdentity: { ...catalogIdentity, ...extra },
      }).success,
    ).toBe(false)
  })
  it('has a fixed safe name for every accepted Utility operation', () => {
    const names = utilityRequestSchema.options.map((option) => option.shape.type.value)
    expect(new Set(diagnosticRequestTypeSchema.options)).toEqual(new Set(names))
  })

  it.each([
    'body',
    'message',
    'stack',
    'params',
    'result',
    'stdout',
    'stderr',
    'env',
    'url',
    'authorization',
  ])('rejects arbitrary %s payloads', (key) => {
    expect(
      diagnosticEventSchema.safeParse({ operation: 'ipc', phase: 'failed', [key]: 'private-data' })
        .success,
    ).toBe(false)
  })

  it.each([
    { requestType: 'arbitrary-user-text' },
    { nativeMethod: 'method-with-a-token' },
    { nativeErrorCode: 'secret' },
    { nativeErrorCode: 1.5 },
    { nativeErrorCode: 2 ** 40 },
    { executorId: '/private/native/path' },
    { failureSource: 'arbitrary-output' },
    { settingsCatalogPhase: '/private/configuration/path' },
    { settingsCatalogFailure: 'private-native-output' },
  ])(
    'rejects unsafe diagnostic metadata $requestType$nativeMethod$nativeErrorCode$executorId$failureSource',
    (metadata) => {
      expect(
        diagnosticEventSchema.safeParse({ operation: 'ipc', phase: 'failed', ...metadata }).success,
      ).toBe(false)
    },
  )

  it('keeps a fully populated error below the record budget with all identifiers', () => {
    const event = diagnosticEventSchema.parse({
      operation: 'process',
      scope: 'request',
      phase: 'blocked',
      level: 'warn',
      requestType: 'workspace-changes.file-read.request',
      nativeMethod: 'thread/resume',
      nativeErrorCode: -32600,
      failureSource: 'native_rpc_rejection',
      settingsCatalogPhase: 'claude_close',
      settingsCatalogFailure: 'root_identity',
      settingsCatalogIdentity: catalogIdentity,
      executorId: randomUUID(),
      operationId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      agentId: 'codex',
      cliVersion: '99999.99999.99999',
      durationMs: Number.MAX_SAFE_INTEGER,
      count: Number.MAX_SAFE_INTEGER,
      pid: 0x7fffffff,
      exitCode: -0x7fffffff,
      code: 'native_rpc_rejected',
    })
    const bytes =
      new TextEncoder().encode(
        JSON.stringify({
          ...event,
          timestamp: new Date().toISOString(),
          identity: {
            launchId: randomUUID(),
            process: 'utility',
            pid: 1234,
            appVersion: '99999.99999.99999',
          },
        }),
      ).length + 1
    expect(bytes).toBeLessThan(LOG_RECORD_BYTES)
  })
})
