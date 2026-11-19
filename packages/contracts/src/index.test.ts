import { describe, expect, it } from 'vitest'

import {
  activeAgentPairInputSchema,
  agentModelOptionSchema,
  appearanceSettingsUpdateSchema,
  appearanceSnapshotSchema,
  appInfoSchema,
  conversationSendInputSchema,
  defaultSessionSettingsGetInputSchema,
  runtimePreparationSchema,
  runtimeHealthSchema,
  sessionCreationPrepareInputSchema,
  sessionSettingsInputSchema,
  IPC_TRAFFIC_UNIT,
  ipcTrafficSchema,
  monacoIpcObservationSchema,
  nativeMemoryDiagnosticsSchema,
  utilityRequestSchema,
} from './index.js'

const uuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`

describe('foundation contracts', () => {
  it('preserves a bounded shutdown epoch deadline while accepting legacy requests without one', () => {
    const legacy = { type: 'runtime.shutdown.request', requestId: uuid(1) }
    expect(utilityRequestSchema.parse(legacy)).toEqual(legacy)
    const request = { ...legacy, flushDeadlineAt: 1_794_268_804_000 }
    expect(utilityRequestSchema.parse(request)).toEqual(request)
  })
  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '4000'])(
    'rejects invalid shutdown deadline %s at the process boundary',
    (flushDeadlineAt) => {
      expect(
        utilityRequestSchema.safeParse({
          type: 'runtime.shutdown.request',
          requestId: uuid(1),
          flushDeadlineAt,
        }).success,
      ).toBe(false)
    },
  )
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

  it('restricts app metadata to supported desktop operating systems', () => {
    const metadata = { name: 'Pact', version: '0.1.0', arch: 'arm64', packaged: false }
    for (const platform of ['darwin', 'win32'])
      expect(appInfoSchema.safeParse({ ...metadata, platform }).success).toBe(true)
    for (const platform of ['freebsd', 'unsupported'])
      expect(appInfoSchema.safeParse({ ...metadata, platform }).success).toBe(false)
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

import {
  AGENTS,
  RUNTIME_MINIMUM_VERSIONS,
  agentDisplayName,
  agentIdForRouteCandidate,
  agentRunSchema,
  confirmedUnsentBoundarySchema,
  defaultSessionSettingsSchema,
  nativeBackgroundReportIdentitySchema,
  nativeForkBoundarySchema,
  nativeForkWitnessSchema,
  nativeInitializationWitnessSchema,
  otherAgent,
  pactEntryPrimary,
  pactSessionEntryPrimary,
  preparedInputMetadataSchema,
  providerUsageProviderSchema,
  resolveLegacyCompatibleTaskStageRoles,
  routeCandidateIdForAgent,
  runEffectiveExecutionSettingsSchema,
  sessionSettingsSchema,
  unsentBoundaryMatchesProvider,
} from './index.js'

describe('Antigravity (agy) and 2-of-3 active pair contracts', () => {
  it('defines AGENTS, minimum versions, display labels, and 2-or-3 unique agent readiness', () => {
    expect(AGENTS).toEqual(['claude', 'codex', 'agy'])
    expect(RUNTIME_MINIMUM_VERSIONS).toEqual({
      claude: '2.1.272',
      codex: '0.159.2',
      agy: '1.5.9',
    })
    expect(agentDisplayName('agy')).toBe('Antigravity')
    expect(providerUsageProviderSchema.options).toEqual(['claude', 'codex', 'agy'])
    expect(
      nativeBackgroundReportIdentitySchema.safeParse({
        agentId: 'agy',
        runId: uuid(60),
        nativeSessionId: 'agy-1',
        nativeTurnId: 'turn-1',
        bindingGeneration: 1,
        executorId: 'exec-1',
        frameId: uuid(61),
        nativeMessageId: 'msg-1',
      }).success,
    ).toBe(true)

    const checkedAt = new Date().toISOString()
    const threeAgents = runtimePreparationSchema.parse({
      firstUse: false,
      agents: [
        { agentId: 'claude', state: 'ready', version: '2.1.272', checkedAt },
        { agentId: 'codex', state: 'ready', version: '0.159.2', checkedAt },
        {
          agentId: 'agy',
          state: 'ready',
          version: '1.5.9',
          agentInfoVersion: '1.0.0',
          acpVersion: '1',
          checkedAt,
        },
      ],
    })
    expect(threeAgents.agents).toHaveLength(3)
    expect(
      runtimePreparationSchema.safeParse({
        firstUse: false,
        agents: [threeAgents.agents[0], threeAgents.agents[0]],
      }).success,
    ).toBe(false)
  })

  it('enforces distinct (primaryAgentId, secondaryAgentId) across all 6 permutations and agy settings', () => {
    const base = {
      agents: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
        agy: { model: 'gemini-3.1-pro', effort: 'high' },
      },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    }
    for (const primaryAgentId of AGENTS) {
      expect(
        defaultSessionSettingsSchema.safeParse({
          ...base,
          primaryAgentId,
          secondaryAgentId: primaryAgentId,
        }).success,
      ).toBe(false)
      for (const secondaryAgentId of AGENTS) {
        if (primaryAgentId === secondaryAgentId) continue
        const parsedDefault = defaultSessionSettingsSchema.parse({
          ...base,
          primaryAgentId,
          secondaryAgentId,
        })
        expect(parsedDefault.secondaryAgentId).toBe(secondaryAgentId)
        expect(otherAgent(primaryAgentId, [primaryAgentId, secondaryAgentId])).toBe(
          secondaryAgentId,
        )
        expect(otherAgent(secondaryAgentId, [primaryAgentId, secondaryAgentId])).toBe(
          primaryAgentId,
        )
        expect(pactEntryPrimary('plan', primaryAgentId, undefined, secondaryAgentId)).toBe(
          primaryAgentId,
        )

        const parsedSession = sessionSettingsSchema.parse({
          ...base,
          primaryAgentId,
          secondaryAgentId,
          agents: {
            claude: { model: null, effort: null, speed: 'native' },
            codex: { model: null, effort: null, speed: 'native' },
            agy: { model: 'gemini-3.1-pro', effort: 'high', speed: 'native' },
          },
          permissionModes: { claude: 'ask', codex: 'native', agy: 'ask' },
        })
        expect(parsedSession.permissionModes?.agy).toBe('ask')
      }
    }
    expect(() => otherAgent('agy')).toThrow(/explicit 2-member Agent pair/)
  })

  it('validates agy execution-settings boundaries, unsent proof matching, rebuild witness, and route candidates', () => {
    expect(
      runEffectiveExecutionSettingsSchema.safeParse({
        version: 1,
        provider: 'agy',
        model: 'gemini-3.1-pro',
        effort: { known: true, value: 'high' },
        speed: 'native',
        permissionMode: 'ask',
        configurationSha256: 'a'.repeat(64),
        provenance: 'agy_applied_settings',
      }).success,
    ).toBe(true)
    for (const unsupportedSpeed of ['standard', 'fast'] as const) {
      expect(
        runEffectiveExecutionSettingsSchema.safeParse({
          version: 1,
          provider: 'agy',
          model: 'gemini-3.1-pro',
          effort: { known: true, value: 'high' },
          speed: unsupportedSpeed,
          permissionMode: 'ask',
          configurationSha256: 'a'.repeat(64),
          provenance: 'agy_applied_settings',
        }).success,
      ).toBe(false)
    }
    expect(
      confirmedUnsentBoundarySchema.safeParse({
        kind: 'agy_root_frame_not_written',
        requestId: 'req-1',
      }).success,
    ).toBe(true)

    const boundaries = [
      ['codex', 'codex_root_frame_not_written', true],
      ['codex', 'claude_root_not_yielded', false],
      ['codex', 'agy_root_frame_not_written', false],
      ['claude', 'claude_root_not_yielded', true],
      ['claude', 'codex_root_frame_not_written', false],
      ['claude', 'agy_root_frame_not_written', false],
      ['agy', 'agy_root_frame_not_written', true],
      ['agy', 'codex_root_frame_not_written', false],
      ['agy', 'claude_root_not_yielded', false],
      ['agy', 'host_before_root_start', true],
    ] as const
    for (const [provider, boundary, expected] of boundaries) {
      expect(unsentBoundaryMatchesProvider(provider, boundary)).toBe(expected)
    }

    const validAgyRebuildWitness = {
      kind: 'agy_rebuild_v1' as const,
      nativeSessionId: '00000000-0000-4000-8000-000000000001',
      pbSha256: 'a'.repeat(64),
      pbBytes: 256,
      stepCount: 2 as const,
      sourceHash: 'b'.repeat(64),
      coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
    }
    expect(nativeInitializationWitnessSchema.safeParse(validAgyRebuildWitness).success).toBe(true)
    expect(
      nativeInitializationWitnessSchema.safeParse({
        ...validAgyRebuildWitness,
        pbBytes: 0,
      }).success,
    ).toBe(false)
    for (const badStepCount of [0, 1, 3] as const) {
      expect(
        nativeInitializationWitnessSchema.safeParse({
          ...validAgyRebuildWitness,
          stepCount: badStepCount,
        }).success,
      ).toBe(false)
    }
    const { sourceHash: _missingSourceHash, ...withoutSourceHash } = validAgyRebuildWitness
    expect(nativeInitializationWitnessSchema.safeParse(withoutSourceHash).success).toBe(false)
    const { coldLoadVerifiedAt: _missingColdLoad, ...withoutColdLoad } = validAgyRebuildWitness
    expect(nativeInitializationWitnessSchema.safeParse(withoutColdLoad).success).toBe(false)

    const baseRun = {
      id: uuid(70),
      sessionId: uuid(71),
      userMessageId: uuid(72),
      agentId: 'agy' as const,
      status: 'completed' as const,
      attemptCount: 1,
      settingsRevision: 1,
      model: 'gemini-3.1-pro',
      effort: 'high',
      createdAt: '2026-11-19T12:00:00.000Z',
      updatedAt: '2026-11-19T12:00:01.000Z',
    }
    expect(agentRunSchema.safeParse(baseRun).success).toBe(true)
    expect(
      agentRunSchema.safeParse({
        ...baseRun,
        handoffMessageCount: 2,
        handoffSourceAgents: ['claude', 'codex'],
      }).success,
    ).toBe(true)
    expect(
      agentRunSchema.safeParse({
        ...baseRun,
        handoffSourceAgents: [],
      }).success,
    ).toBe(false)
    expect(
      agentRunSchema.safeParse({
        ...baseRun,
        handoffSourceAgents: ['claude', 'codex', 'agy', 'claude'],
      }).success,
    ).toBe(false)

    const agyCut = {
      version: 'pact-agy-fork-cut-v1' as const,
      trajectoryId: 'traj-parent',
      executionId: 'exec-1',
      cutStepIdx: 4,
    }
    const baseBoundary = {
      nativeSessionId: 'sid-1',
      nativeCutId: 'exec-1',
      nativeTurnId: 'turn-1',
      bindingGeneration: 1,
      throughSequence: 2,
      deliveryCursor: 1,
      prefixHash: 'c'.repeat(64),
      prefixRecords: 5,
      prefixBytes: 512,
    }
    expect(
      nativeForkBoundarySchema.safeParse({
        ...baseBoundary,
        provider: 'agy',
        agyCut,
      }).success,
    ).toBe(true)
    expect(
      nativeForkBoundarySchema.safeParse({
        ...baseBoundary,
        provider: 'agy',
      }).success,
    ).toBe(false)
    for (const nonAgyProvider of [undefined, 'claude', 'codex'] as const) {
      expect(
        nativeForkBoundarySchema.safeParse({
          ...baseBoundary,
          ...(nonAgyProvider ? { provider: nonAgyProvider } : {}),
        }).success,
      ).toBe(true)
      expect(
        nativeForkBoundarySchema.safeParse({
          ...baseBoundary,
          ...(nonAgyProvider ? { provider: nonAgyProvider } : {}),
          agyCut,
        }).success,
      ).toBe(false)
    }

    const baseWitness = {
      version: 'pact-native-fork-v1' as const,
      sourceNativeSessionId: 'sid-parent',
      nativeSessionId: 'sid-child',
      sourceCutId: 'exec-1',
      sourcePrefixHash: 'c'.repeat(64),
      candidatePrefixHash: 'd'.repeat(64),
      idMap: [['turn-1', 'turn-1']] as [string, string][],
      model: 'gemini-3.1-pro',
      effort: 'high',
      permissionMode: 'ask' as const,
    }
    const validAgyWitness = {
      ...baseWitness,
      provider: 'agy' as const,
      sourceTrajectoryId: 'traj-parent',
      candidateTrajectoryId: 'traj-child',
      cutStepIdx: 4,
      agyCut,
    }
    expect(nativeForkWitnessSchema.safeParse(validAgyWitness).success).toBe(true)
    expect(
      nativeForkWitnessSchema.safeParse({
        ...validAgyWitness,
        cutStepIdx: 3,
      }).success,
    ).toBe(false)
    for (const omittedKey of [
      'agyCut',
      'sourceTrajectoryId',
      'candidateTrajectoryId',
      'cutStepIdx',
    ] as const) {
      const copy = { ...validAgyWitness }
      delete copy[omittedKey]
      expect(nativeForkWitnessSchema.safeParse(copy).success).toBe(false)
    }
    for (const nonAgyProvider of [undefined, 'claude', 'codex'] as const) {
      expect(
        nativeForkWitnessSchema.safeParse({
          ...baseWitness,
          ...(nonAgyProvider ? { provider: nonAgyProvider } : {}),
        }).success,
      ).toBe(true)
      expect(
        nativeForkWitnessSchema.safeParse({
          ...baseWitness,
          ...(nonAgyProvider ? { provider: nonAgyProvider } : {}),
          agyCut,
        }).success,
      ).toBe(false)
    }

    expect(pactSessionEntryPrimary('build', ['claude', 'agy'], 'claude')).toBe('agy')
    expect(
      resolveLegacyCompatibleTaskStageRoles({ owner: 'claude', reviewer: 'claude' }).planReviewer,
    ).toBe('codex')

    expect(routeCandidateIdForAgent('agy')).toBe('route_agy')
    expect(agentIdForRouteCandidate('route_agy')).toBe('agy')
    const basePrepared = {
      version: 'prepared-input-v1' as const,
      ownerId: uuid(50),
      requestFingerprint: 'a'.repeat(64),
      inputId: uuid(51),
      routeSpecified: false,
      defaultAgentId: 'claude' as const,
      allowedAgentIds: ['claude', 'agy'] as const,
      routeIntent: 'implicit' as const,
      composerRevision: 1,
      settingsRevision: 1,
      sourceFingerprint: 'b'.repeat(64),
    }
    expect(preparedInputMetadataSchema.safeParse(basePrepared).success).toBe(true)
    expect(
      preparedInputMetadataSchema.safeParse({
        ...basePrepared,
        allowedAgentIds: ['claude', 'codex', 'agy'],
      }).success,
    ).toBe(false)

    // Optional activePair input schemas for active-pair model catalog loading
    expect(
      activeAgentPairInputSchema.safeParse({
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }).success,
    ).toBe(true)
    expect(
      activeAgentPairInputSchema.safeParse({
        primaryAgentId: 'agy',
        secondaryAgentId: 'agy',
      }).success,
    ).toBe(false)
    expect(defaultSessionSettingsGetInputSchema.safeParse({}).success).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'default-session-settings.get.request',
        requestId: uuid(60),
      }).success,
    ).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'default-session-settings.get.request',
        requestId: uuid(61),
        input: { activePair: { primaryAgentId: 'claude', secondaryAgentId: 'agy' } },
      }).success,
    ).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'default-session-settings.get.request',
        requestId: uuid(62),
        input: { activePair: { primaryAgentId: 'claude', secondaryAgentId: 'claude' } },
      }).success,
    ).toBe(false)
    expect(
      sessionCreationPrepareInputSchema.safeParse({
        projectId: uuid(63),
        activePair: { primaryAgentId: 'codex', secondaryAgentId: 'agy' },
      }).success,
    ).toBe(true)
    expect(
      sessionSettingsInputSchema.safeParse({
        sessionId: uuid(64),
        activePair: { primaryAgentId: 'agy', secondaryAgentId: 'claude' },
      }).success,
    ).toBe(true)
  })
})
