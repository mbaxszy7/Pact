import { describe, expect, it } from 'vitest'

import {
  agentModelOptionSchema,
  appearanceSettingsUpdateSchema,
  appearanceSnapshotSchema,
  appInfoSchema,
  conversationSendInputSchema,
  runtimePreparationSchema,
  runtimeHealthSchema,
  IPC_TRAFFIC_UNIT,
  ipcTrafficSchema,
  monacoIpcObservationSchema,
  nativeMemoryDiagnosticsSchema,
} from './index.js'

const uuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`

describe('foundation contracts', () => {
  it('requires truthful, bounded Native reservation scalars and accepts explicit unknown counts', () => {
    const observed = {
      unit: 'native-working-reservations-v1',
      observationsComplete: true,
      chargedBytes: 50,
      reservationItems: 1,
      highWaterBytes: 100,
      highWaterItems: 2,
      acquiredBytes: 150,
      releasedBytes: 100,
      acquiredItems: 3,
      releasedItems: 2,
    }
    expect(nativeMemoryDiagnosticsSchema.safeParse(observed).success).toBe(true)
    expect(
      nativeMemoryDiagnosticsSchema.safeParse({
        ...observed,
        observationsComplete: false,
        acquiredBytes: null,
      }).success,
    ).toBe(true)
    for (const invalid of [
      { ...observed, unit: 'node-active-resources' },
      { ...observed, paths: ['/private/source'] },
      { ...observed, model: 'private-model' },
      { ...observed, body: 'private-body' },
      { ...observed, chargedBytes: -1 },
      { ...observed, chargedBytes: 512 * 1024 * 1024 + 1 },
      { ...observed, acquiredBytes: 149 },
      { ...observed, releasedItems: 3 },
      { ...observed, highWaterBytes: 49 },
      { ...observed, highWaterItems: 0 },
      { ...observed, highWaterBytes: 151 },
      { ...observed, highWaterItems: 4 },
      { ...observed, acquiredItems: Number.MAX_SAFE_INTEGER + 1 },
      { ...observed, reservationItems: 0.5 },
      { ...observed, acquiredBytes: null },
      { ...observed, observationsComplete: false },
      { ...observed, observationsComplete: false, acquiredItems: null, acquiredBytes: 149 },
    ])
      expect(nativeMemoryDiagnosticsSchema.safeParse(invalid).success).toBe(false)
  })
  it('rejects missing and older Monaco measurement units before counting traffic', () => {
    const observation = {
      type: 'message',
      unit: IPC_TRAFFIC_UNIT,
      category: 'renderer-monaco.request',
      measurement: { complete: true, jsonBytes: 38, binaryBytes: 0, totalBytes: 38 },
    }
    expect(monacoIpcObservationSchema.safeParse(observation).success).toBe(true)
    expect(monacoIpcObservationSchema.safeParse({ ...observation, unit: undefined }).success).toBe(
      false,
    )
    expect(
      monacoIpcObservationSchema.safeParse({
        ...observation,
        unit: 'json-utf8-null-binary-skeleton-plus-visible-binary-bytes',
      }).success,
    ).toBe(false)
    expect(monacoIpcObservationSchema.safeParse({ type: 'created' }).success).toBe(false)
  })
  it('keeps optional IPC health backward compatible and rejects fabricated full coverage', () => {
    const health = {
      status: 'ready',
      database: 'ready',
      pid: 100,
      checkedAt: new Date().toISOString(),
    }
    expect(runtimeHealthSchema.safeParse(health).success).toBe(true)
    const observation = {
      schemaVersion: 1,
      unit: IPC_TRAFFIC_UNIT,
      complete: false,
      owners: [],
      uncovered: ['main-directory-worker'],
    }
    expect(runtimeHealthSchema.safeParse({ ...health, ipcTraffic: observation }).success).toBe(true)
    expect(ipcTrafficSchema.safeParse({ ...observation, complete: true }).success).toBe(false)
    expect(
      ipcTrafficSchema.safeParse({
        ...observation,
        unit: 'json-utf8-null-binary-skeleton-plus-visible-binary-bytes',
      }).success,
    ).toBe(false)
    expect(
      ipcTrafficSchema.safeParse({ ...observation, unit: 'electron-wire-bytes' }).success,
    ).toBe(false)
    expect(
      ipcTrafficSchema.safeParse({ ...observation, payload: 'never-export-business-facts' })
        .success,
    ).toBe(false)
  })
  it('preserves native aliases with optional exact wire identity and accepts old catalogs', () => {
    const old = { id: 'haiku', displayName: 'Haiku', supportedEfforts: ['low', 'high'] }
    expect(agentModelOptionSchema.parse(old)).toEqual(old)
    expect(agentModelOptionSchema.parse({ ...old, resolvedModel: 'configured-wire[1m]' })).toEqual({
      ...old,
      resolvedModel: 'configured-wire[1m]',
    })
    expect(agentModelOptionSchema.safeParse({ ...old, resolvedModel: '' }).success).toBe(false)
    expect(
      agentModelOptionSchema.safeParse({ ...old, resolvedModel: 'x'.repeat(241) }).success,
    ).toBe(false)
  })
  it('admits only bounded, content-free first SQLite plan failures while accepting old snapshots', () => {
    const health = {
      status: 'ready',
      database: 'ready',
      pid: 100,
      checkedAt: new Date().toISOString(),
      performance: {
        eventLoopLagP95Ms: 0,
        eventLoopSamples: 0,
        activeResources: {},
        resourceHighWater: 0,
        resourceCapacityExceeded: false,
        sqlite: {
          operations: 65,
          transactions: 0,
          rowsReturned: 65,
          totalMs: 1,
          maxMs: 1,
          planOverflow: true,
          unsupportedOperations: false,
          queryPlans: [],
        },
      },
    }
    const failure = {
      reason: 'plan-capacity',
      sqlSha256: 'a'.repeat(64),
      sourceBytes: 18,
      operationIndex: 65,
      retainedPlans: 64,
      retainedPlanBytes: 16384,
      planRows: null,
    }
    const withFailure = (value: unknown) => ({
      ...health,
      performance: {
        ...health.performance,
        sqlite: { ...health.performance.sqlite, firstPlanFailure: value },
      },
    })
    expect(runtimeHealthSchema.safeParse(health).success).toBe(true)
    const nativeMemory = {
      unit: 'native-working-reservations-v1',
      observationsComplete: true,
      chargedBytes: 0,
      reservationItems: 0,
      highWaterBytes: 4096,
      highWaterItems: 1,
      acquiredBytes: 4096,
      releasedBytes: 4096,
      acquiredItems: 1,
      releasedItems: 1,
    }
    expect(
      runtimeHealthSchema.safeParse({
        ...health,
        performance: { ...health.performance, nativeMemory },
      }).success,
    ).toBe(true)
    expect(
      runtimeHealthSchema.safeParse({
        ...health,
        performance: {
          ...health.performance,
          nativeMemory: { ...nativeMemory, observationsComplete: false },
        },
      }).success,
    ).toBe(false)
    expect(runtimeHealthSchema.safeParse(withFailure(failure)).success).toBe(true)
    expect(
      runtimeHealthSchema.safeParse(
        withFailure({ ...failure, reason: 'statement-bytes', sourceBytes: 8193, sqlSha256: null }),
      ).success,
    ).toBe(true)
    expect(
      runtimeHealthSchema.safeParse(withFailure({ ...failure, reason: 'plan-rows', planRows: 131 }))
        .success,
    ).toBe(true)
    for (const invalid of [
      { ...failure, reason: 'raw-error' },
      { ...failure, source: 'SELECT private_business_content' },
      { ...failure, bindings: ['private_business_content'] },
      { ...failure, error: 'raw provider error' },
      { ...failure, sqlSha256: 'not-a-digest' },
      { ...failure, sqlSha256: null },
      { ...failure, sourceBytes: 8193 },
      { ...failure, reason: 'statement-bytes', sqlSha256: null },
      { ...failure, sourceBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...failure, operationIndex: 0 },
      { ...failure, operationIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...failure, retainedPlans: 65 },
      { ...failure, retainedPlanBytes: 16385 },
      { ...failure, planRows: -1 },
      { ...failure, planRows: 0x100000000 },
    ])
      expect(runtimeHealthSchema.safeParse(withFailure(invalid)).success).toBe(false)
  })
  it('accepts valid app metadata', () => {
    expect(
      appInfoSchema.parse({
        name: 'Pact',
        version: '0.0.0',
        platform: 'darwin',
        arch: 'arm64',
        packaged: false,
      }),
    ).toBeDefined()
  })

  it('rejects an invalid runtime process id', () => {
    const result = runtimeHealthSchema.safeParse({
      status: 'ready',
      database: 'ready',
      pid: 0,
      checkedAt: new Date().toISOString(),
    })

    expect(result.success).toBe(false)
  })

  it('validates separate first-use readiness for both local agents', () => {
    expect(
      runtimePreparationSchema
        .parse({
          firstUse: true,
          agents: [
            {
              agentId: 'claude',
              state: 'authentication_required',
              executablePath: '/opt/claude',
              checkedAt: new Date().toISOString(),
            },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: '/opt/codex',
              version: 'codex-cli 1.0.0',
              checkedAt: new Date().toISOString(),
            },
          ],
        })
        .agents.map((agent) => agent.state),
    ).toEqual(['authentication_required', 'ready'])
  })

  it('requires revision-controlled appearance updates and preserves requested/effective separation', () => {
    expect(
      appearanceSettingsUpdateSchema.safeParse({ expectedRevision: 2, materialOpacity: 86 })
        .success,
    ).toBe(true)
    expect(appearanceSettingsUpdateSchema.safeParse({ expectedRevision: 2 }).success).toBe(false)
    expect(
      appearanceSettingsUpdateSchema.safeParse({ expectedRevision: 2, materialOpacity: 69 })
        .success,
    ).toBe(false)
    expect(
      appearanceSnapshotSchema.parse({
        requested: {
          theme: 'system',
          windowMaterial: 'translucent',
          materialOpacity: 70,
          revision: 3,
        },
        effective: {
          theme: 'dark',
          windowMaterial: 'solid',
          fallbackReason: 'native_material_not_supported',
          revision: 3,
        },
        projectionVersion: 4,
      }),
    ).toBeDefined()
  })

  it('accepts all frozen Comments beyond a projection page and rejects duplicate identities', () => {
    const input = {
      sessionId: uuid(1),
      clientMessageId: uuid(2),
      content: 'Review these Comments.',
      expectedCommentsRevision: 25,
      commentIds: Array.from({ length: 25 }, (_, index) => uuid(index + 3)),
      batchId: uuid(40),
      freezeDrafts: true,
    }

    expect(conversationSendInputSchema.parse(input).commentIds).toHaveLength(25)
    expect(
      conversationSendInputSchema.safeParse({
        ...input,
        commentIds: [...input.commentIds, input.commentIds[0]],
      }).success,
    ).toBe(false)
  })
})
