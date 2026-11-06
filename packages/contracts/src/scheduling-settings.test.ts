import { describe, expect, it } from 'vitest'

import {
  RELAY_KEY_BYTES,
  relayApiKeySchema,
  relayCredentialSaveSchema,
  relayCredentialRemoveSchema,
  relayCredentialRevealSchema,
  relayCredentialWriteSchema,
  relayCredentialReceiptReadSchema,
  relayCryptoMessageSchema,
} from './relay-credential.js'
import {
  schedulingSettingsSaveSchema,
  schedulingSettingsSchema,
  schedulingStateSchema,
  schedulingStateInputSchema,
} from './scheduling-settings.js'

const settings = (
  overrides: Partial<Parameters<typeof schedulingSettingsSchema.parse>[0]> = {},
) => ({
  enabled: false,
  provider: 'openai',
  model: 'gpt-6-luna',
  credential: { configured: false, revision: 0 },
  showIndicator: true,
  revision: 0,
  updatedAt: '2026-11-03T00:00:00.000Z',
  ...overrides,
})

describe('scheduling preferences and capability boundary', () => {
  it('keeps runtime authority out of stored settings independently of the saved enable preference', () => {
    for (const enabled of [false, true]) {
      const value = settings({ enabled })
      expect(schedulingSettingsSchema.parse(value)).toEqual(value)
      for (const patch of [
        { runnerAvailable: true },
        { selection: null },
        { provider: 'codex' },
        { provider: 'claude' },
        { model: 'gpt-6-astra' },
        { credential: { configured: false, revision: 0, ciphertext: 'AAAA' } },
      ])
        expect(schedulingSettingsSchema.safeParse({ ...value, ...patch }).success).toBe(false)
    }
  })

  it('exposes credential metadata only, never ciphertext in the ordinary settings projection', () => {
    for (const credential of [
      { configured: false, revision: 0 },
      { configured: true, revision: 3 },
    ]) {
      const value = settings({ credential })
      expect(schedulingSettingsSchema.parse(value)).toEqual(value)
    }
    for (const credential of [
      { configured: true, revision: -1 },
      { configured: 'yes', revision: 0 },
      { configured: true, revision: 0, key: 'sk-live' },
    ])
      expect(schedulingSettingsSchema.safeParse(settings({ credential })).success).toBe(false)
  })

  it('does not allow preference saves to set provider, model, credential or capability', () => {
    expect(schedulingSettingsSaveSchema.parse({ expectedRevision: 0, enabled: true })).toEqual({
      expectedRevision: 0,
      enabled: true,
    })
    for (const patch of [
      { selection: null },
      { provider: 'openai' },
      { model: 'gpt-6-luna' },
      { credential: { configured: true, revision: 0 } },
      { runnerAvailable: true },
      { expectedRevision: -1 },
    ])
      expect(
        schedulingSettingsSaveSchema.safeParse({ expectedRevision: 0, ...patch }).success,
      ).toBe(false)
  })

  it('requires a complete observed connection for a supported state', () => {
    const connection = {
      status: 'available',
      checkedAt: '2026-11-03T00:00:00.000Z',
      expiresAt: '2026-11-03T00:01:00.000Z',
    }
    const state = {
      settings: settings({ enabled: true }),
      configurationGeneration: 0,
      connection,
      context: null,
      activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
    }
    expect(schedulingStateSchema.parse(state)).toEqual(state)
    for (const patch of [
      { checkedAt: 'not-a-date' },
      { expiresAt: 'not-a-date' },
      { status: 'supported' },
    ])
      expect(
        schedulingStateSchema.safeParse({
          ...state,
          connection: { ...connection, ...patch },
        }).success,
      ).toBe(false)
    for (const status of ['unconfirmed', 'unavailable', 'stale'])
      expect(
        schedulingStateSchema.safeParse({
          ...state,
          connection: { ...connection, status },
        }).success,
      ).toBe(true)
    const context = {
      ...state,
      context: { sessionId: '11111111-1111-4111-8111-111111111111', eligibility: 'available' },
    }
    expect(schedulingStateSchema.parse(context)).toEqual(context)
    for (const patch of [{ provider: 'openai' }, { observation: connection }, { eligible: true }])
      expect(
        schedulingStateSchema.safeParse({
          ...context,
          context: { ...context.context, ...patch },
        }).success,
      ).toBe(false)
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

describe('relay credential contract', () => {
  const nonce = '11111111-1111-4111-8111-111111111111'
  const deadlineAt = Date.now() + 5000

  it('accepts only bounded expectedRevision/deadlineAt for an explicit reveal', () => {
    const base = { expectedRevision: 1, deadlineAt }
    expect(relayCredentialRevealSchema.parse(base)).toEqual(base)
    for (const bad of [
      { ...base, key: 'sk-synthetic' },
      { ...base, ciphertext: 'eA==' },
      { expectedRevision: -1, deadlineAt },
      { expectedRevision: 1.5, deadlineAt },
      { expectedRevision: 1 },
      { expectedRevision: 1, deadlineAt: Number.POSITIVE_INFINITY },
      { expectedRevision: 1, deadlineAt: 0 },
    ])
      expect(relayCredentialRevealSchema.safeParse(bad).success).toBe(false)
  })

  it('requires a UUID nonce, safe nonnegative expectedRevision and positive safe deadlineAt', () => {
    const base = { nonce, expectedRevision: 0, deadlineAt }
    expect(relayCredentialSaveSchema.parse({ ...base, key: 'sk-synthetic' })).toEqual({
      ...base,
      key: 'sk-synthetic',
    })
    expect(relayCredentialRemoveSchema.parse(base)).toEqual(base)
    // deadlineAt is required, never defaulted.
    const missingDeadline = { nonce, expectedRevision: 0 }
    expect(relayCredentialSaveSchema.safeParse({ ...missingDeadline, key: 'k' }).success).toBe(
      false,
    )
    expect(relayCredentialRemoveSchema.safeParse(missingDeadline).success).toBe(false)
    expect(relayCredentialReceiptReadSchema.parse({ nonce })).toEqual({ nonce })
    for (const patch of [
      { nonce: 'not-a-uuid' },
      { expectedRevision: -1 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { deadlineAt: 0 },
      { deadlineAt: -5 },
      { deadlineAt: 1.5 },
      { deadlineAt: Number.MAX_SAFE_INTEGER + 1 },
      { extra: true },
      { provider: 'openai' },
      { selection: { target: 'codex' } },
    ]) {
      expect(relayCredentialSaveSchema.safeParse({ ...base, key: 'sk-x', ...patch }).success).toBe(
        false,
      )
      expect(relayCredentialRemoveSchema.safeParse({ ...base, ...patch }).success).toBe(false)
    }
    expect(relayCredentialReceiptReadSchema.safeParse({ nonce: 'bad' }).success).toBe(false)
  })

  it('accepts only bounded visible-ASCII API keys', () => {
    expect(relayApiKeySchema.parse('sk-synthetic-preview-key-0000')).toBe(
      'sk-synthetic-preview-key-0000',
    )
    expect(relayApiKeySchema.parse('k'.repeat(RELAY_KEY_BYTES))).toHaveLength(RELAY_KEY_BYTES)
    for (const key of [
      '',
      ' ',
      'sk key',
      'sk\tkey',
      'sk\nkey',
      'sk\rkey',
      'sk\x00key',
      'sk\u007fkey',
      'sk-é',
      'sk-你好',
      'k'.repeat(RELAY_KEY_BYTES + 1),
    ])
      expect(relayApiKeySchema.safeParse(key).success).toBe(false)
  })

  it('keeps plaintext keys out of the encrypted Utility write channel', () => {
    const write = {
      operation: 'save' as const,
      nonce,
      expectedRevision: 0,
      deadlineAt,
      ciphertext: 'Y2lwaGVydGV4dA==',
    }
    expect(relayCredentialWriteSchema.parse(write)).toEqual(write)
    expect(relayCredentialWriteSchema.safeParse({ ...write, key: 'sk-synthetic' }).success).toBe(
      false,
    )
    const withKey = { ...write, ciphertext: undefined, key: 'sk-synthetic' }
    expect(relayCredentialWriteSchema.safeParse(withKey).success).toBe(false)
    for (const ciphertext of ['A', 'A===', 'not canonical!', ''])
      expect(relayCredentialWriteSchema.safeParse({ ...write, ciphertext }).success).toBe(false)
    expect(
      relayCredentialWriteSchema.parse({
        operation: 'remove',
        nonce,
        expectedRevision: 0,
        deadlineAt,
      }),
    ).toEqual({ operation: 'remove', nonce, expectedRevision: 0, deadlineAt })
  })

  it('validates the private decrypt protocol exactly, including the reply discriminator', () => {
    const ciphertext = 'Y2lwaGVydGV4dA=='
    const requestId = '22222222-2222-4222-8222-222222222222'
    expect(
      relayCryptoMessageSchema.parse({
        type: 'relay.credential.decrypt.request',
        requestId,
        deadlineAt,
        ciphertext,
      }),
    ).toEqual({ type: 'relay.credential.decrypt.request', requestId, deadlineAt, ciphertext })
    expect(
      relayCryptoMessageSchema.parse({ type: 'relay.credential.decrypt.cancel', requestId }),
    ).toEqual({ type: 'relay.credential.decrypt.cancel', requestId })
    for (const result of [
      { ok: true as const, key: 'sk-synthetic' },
      {
        ok: true as const,
        key: 'sk-synthetic',
        replacementCiphertext: ciphertext,
      },
      { ok: false as const, reason: 'unavailable' as const },
      { ok: false as const, reason: 'cancelled' as const },
      { ok: false as const, reason: 'busy' as const },
    ])
      expect(
        relayCryptoMessageSchema.parse({
          type: 'relay.credential.decrypt.response',
          requestId,
          result,
        }),
      ).toEqual({ type: 'relay.credential.decrypt.response', requestId, result })
    for (const message of [
      { type: 'relay.credential.decrypt.request', requestId, deadlineAt },
      { type: 'relay.credential.decrypt.request', requestId: 'bad', deadlineAt, ciphertext },
      { type: 'relay.credential.decrypt.request', requestId, deadlineAt: 0, ciphertext },
      { type: 'relay.credential.decrypt.cancel', requestId, ciphertext },
      {
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: true, key: 'sk bad key' },
      },
      {
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: false, reason: 'timeout' },
      },
      { type: 'relay.credential.decrypt.other', requestId },
      { type: 'relay.credential.decrypt.request', requestId, deadlineAt, ciphertext, extra: 1 },
    ])
      expect(relayCryptoMessageSchema.safeParse(message).success).toBe(false)
  })
})
