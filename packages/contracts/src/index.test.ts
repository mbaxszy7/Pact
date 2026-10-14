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
} from './index.js'

const uuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`

describe('foundation contracts', () => {
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
