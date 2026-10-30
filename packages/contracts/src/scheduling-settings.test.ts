import { describe, expect, it } from 'vitest'

import {
  schedulingSettingsSaveSchema,
  schedulingSettingsSchema,
  schedulingStateSchema,
  schedulingStateInputSchema,
} from './scheduling-settings.js'

describe('scheduling preferences and capability boundary', () => {
  it('keeps runtime authority out of stored settings independently of the saved enable preference', () => {
    for (const enabled of [false, true]) {
      const settings = {
        enabled,
        selection: null,
        showIndicator: true,
        revision: 0,
        updatedAt: '2026-10-23T00:00:00.000Z',
      }
      expect(schedulingSettingsSchema.parse(settings)).toEqual(settings)
      expect(
        schedulingSettingsSchema.safeParse({ ...settings, runnerAvailable: true }).success,
      ).toBe(false)
      expect(
        schedulingSettingsSchema.safeParse({ ...settings, runnerAvailable: 'true' }).success,
      ).toBe(false)
    }
  })

  it('does not allow preference saves to set the host runner capability', () => {
    expect(schedulingSettingsSaveSchema.parse({ expectedRevision: 0, enabled: true })).toEqual({
      expectedRevision: 0,
      enabled: true,
    })
    expect(
      schedulingSettingsSaveSchema.safeParse({
        expectedRevision: 0,
        enabled: true,
        runnerAvailable: true,
      }).success,
    ).toBe(false)
  })

  it('requires complete physically settled evidence for a supported observation', () => {
    const capability = {
      provider: 'codex',
      modelId: 'gpt-6-luna',
      status: 'supported',
      supported: true,
      reason: 'supported',
      configurationFingerprint: 'a'.repeat(64),
      checkedAt: '2026-10-23T00:00:00.000Z',
      physicalReleased: true,
    }
    const state = {
      settings: {
        enabled: true,
        selection: null,
        showIndicator: true,
        revision: 0,
        updatedAt: capability.checkedAt,
      },
      configurationGeneration: 0,
      host: { status: 'supported', capability, expiresAt: '2026-10-23T00:01:00.000Z' },
      context: null,
      activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
    }
    expect(schedulingStateSchema.parse(state)).toEqual(state)
    for (const patch of [
      { physicalReleased: false },
      { configurationFingerprint: null },
      { reason: 'timeout' },
      { supported: false },
    ])
      expect(
        schedulingStateSchema.safeParse({
          ...state,
          host: { ...state.host, capability: { ...capability, ...patch } },
        }).success,
      ).toBe(false)
    expect(
      schedulingStateSchema.safeParse({ ...state, host: { ...state.host, status: 'unconfirmed' } })
        .success,
    ).toBe(false)
    expect(
      schedulingStateSchema.safeParse({ ...state, host: { ...state.host, status: 'stale' } })
        .success,
    ).toBe(true)
  })

  it('accepts only the named optional Session context, never caller-supplied probe authority', () => {
    expect(schedulingStateInputSchema.parse({})).toEqual({})
    expect(schedulingStateInputSchema.safeParse({ sessionId: 'bad' }).success).toBe(false)
    for (const patch of [
      { cwd: '/project' },
      { modelId: 'gpt-6-luna' },
      { permission: 'all' },
      { command: 'start' },
    ])
      expect(schedulingStateInputSchema.safeParse(patch).success).toBe(false)
  })
})
