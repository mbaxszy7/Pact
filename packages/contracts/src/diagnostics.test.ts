import { describe, expect, it } from 'vitest'

import {
  diagnosticEventSchema,
  diagnosticRequestTypeSchema,
  LOG_RECORD_BYTES,
  sourceReadDiagnosticSchema,
  sourceReadCallIdentity,
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
  it('accepts only closed information refusal reasons without field values', () => {
    expect(
      diagnosticEventSchema.safeParse({
        operation: 'send',
        phase: 'blocked',
        inputAdviceResult: 'stale',
      }).success,
    ).toBe(true)
    expect(
      diagnosticEventSchema.safeParse({
        operation: 'send',
        phase: 'blocked',
        inputAdviceResult: randomUUID(),
      }).success,
    ).toBe(false)
    for (const informationAdviceRefusal of [
      'missing_field',
      'unavailable_field',
      'field_mismatch',
      'host_validation',
    ])
      expect(
        diagnosticEventSchema.safeParse({
          operation: 'send',
          phase: 'blocked',
          informationAdviceRefusal,
        }).success,
      ).toBe(true)
    expect(
      diagnosticEventSchema.safeParse({
        operation: 'send',
        phase: 'blocked',
        informationAdviceRefusal: randomUUID(),
      }).success,
    ).toBe(false)
  })
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
    { planStage: 'private-stage' },
    { planReason: 'private-body' },
    { planCapture: { code: 'hook_prompt_missing', tool: 'Write', phase: 'begin', path: 'secret' } },
    { planCapture: { code: 'private-body', tool: 'Write', phase: 'begin' } },
    { planCapture: { code: 'hook_prompt_missing', tool: 'private-tool', phase: 'begin' } },
    { planCapture: { code: 'hook_prompt_missing', tool: 'Write', phase: 'private-phase' } },
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
      planStage: 'submission',
      planReason: 'submission_hook_unverified',
      planCapture: { code: 'history_binding_missing', tool: 'ExitPlanMode', phase: 'success' },
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
      sourceRead: {
        version: 'source-read-failure-v1',
        form: 'nativeRoot',
        source: 'handoff_sources',
        offset: Number.MAX_SAFE_INTEGER,
        nativeCallSha256: 'a'.repeat(64),
        requestSha256: 'b'.repeat(64),
        entryOwner: 'passed',
        rootBinding: 'passed',
        currentBeforeRead: 'passed',
        readerEntered: true,
        stage: 'repository_scope',
      },
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

it('source failure metadata rejects private fields and unsafe cursor/identity inputs', () => {
  const safe = {
    version: 'source-read-failure-v1',
    form: 'nativeRoot',
    source: 'inputs',
    offset: 0,
    nativeCallSha256: null,
    requestSha256: null,
    entryOwner: 'passed',
    rootBinding: 'passed',
    currentBeforeRead: 'passed',
    readerEntered: true,
    stage: 'repository_scope',
  }
  expect(sourceReadDiagnosticSchema.safeParse(safe).success).toBe(true)
  for (const extra of [
    { source: 'private-credential' },
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { stage: 'private-error' },
    { grant: 'secret' },
    { nativeCallSha256: 'raw-call-id' },
    { body: 'private-body' },
  ])
    expect(sourceReadDiagnosticSchema.safeParse({ ...safe, ...extra }).success).toBe(false)
  for (const value of ['', 'x'.repeat(1025), null, 1, {}])
    expect(sourceReadCallIdentity('thread', 'turn', value)).toBeUndefined()
  expect(sourceReadCallIdentity('a', 'bc', 'd')).not.toBe(sourceReadCallIdentity('ab', 'c', 'd'))
})
