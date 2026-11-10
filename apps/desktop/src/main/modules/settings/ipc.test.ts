import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  IPC_CHANNELS,
  OPENAI_DECISION_MODEL,
  relayCredentialReceiptSchema,
  relayCryptoMessageSchema,
  utilityRequestSchema,
  utilityResponseSchema,
} from '@pact/contracts'

import { createRendererTrust } from '../../renderer-trust'
import { createUtilityProcessClient } from '../../utility-process/client'
import { registerSettingsIpcHandlers } from './ipc'

const harness = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      harness.handlers.set(channel, handler),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}))
afterEach(() => {
  vi.restoreAllMocks()
  harness.handlers.clear()
})

function fixture() {
  const trust = createRendererTrust({ isPackaged: true })
  const client = createUtilityProcessClient()
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  const sender = {
    mainFrame: { url: 'app://bundle/index.html' },
    isDestroyed: () => false,
    getURL: () => sender.mainFrame.url,
    send,
  }
  const window = {
    webContents: sender,
    isDestroyed: () => false,
    once: vi.fn<(event: 'closed', listener: () => void) => void>(),
  }
  const unregister = trust.registerWindow(window)
  const unsubscribe = vi.fn<() => void>()
  let listener: (() => void) | undefined
  vi.spyOn(client, 'subscribeSchedulingChanges').mockImplementation((value) => {
    listener = value
    return unsubscribe
  })
  const settings: Awaited<ReturnType<typeof client.getSchedulingSettings>> = {
    ok: true as const,
    value: {
      enabled: false,
      provider: 'openai' as const,
      model: OPENAI_DECISION_MODEL,
      credential: { configured: false, revision: 0 },
      showIndicator: true,
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    },
  }
  const get = vi.spyOn(client, 'getSchedulingSettings').mockResolvedValue(settings)
  const save = vi.spyOn(client, 'saveSchedulingSettings').mockResolvedValue(settings)
  const state = vi.spyOn(client, 'getSchedulingState').mockResolvedValue({
    ok: false,
    error: { code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable' },
  })
  const credentialSave = vi.spyOn(client, 'saveRelayApiKey').mockImplementation(async (input) => ({
    ok: true as const,
    value: {
      nonce: input.nonce,
      operation: 'save' as const,
      revision: input.expectedRevision + 1,
      configured: true,
    },
  }))
  const credentialRemove = vi
    .spyOn(client, 'removeRelayApiKey')
    .mockImplementation(async (input) => ({
      ok: true as const,
      value: {
        nonce: input.nonce,
        operation: 'remove' as const,
        revision: input.expectedRevision + 1,
        configured: false,
      },
    }))
  const credentialReveal = vi.spyOn(client, 'revealRelayApiKey').mockResolvedValue({
    ok: true,
    value: { revision: 1, key: 'sk-synthetic-reveal' },
  })
  const receipt = vi.spyOn(client, 'readRelayCredentialReceipt').mockResolvedValue({
    ok: true,
    value: null,
  })
  const activity = vi.spyOn(client, 'readSchedulingActivity').mockResolvedValue({
    ok: true,
    value: { asOf: new Date().toISOString(), rows: [], nextCursor: null },
  })
  const dispose = registerSettingsIpcHandlers(trust, client)
  const invoke = (
    channel: string,
    raw?: unknown,
    event = { sender, senderFrame: sender.mainFrame },
  ) => harness.handlers.get(channel)!(event, raw)
  return {
    trust,
    client,
    sender,
    send,
    get,
    save,
    state,
    credentialSave,
    credentialRemove,
    credentialReveal,
    receipt,
    activity,
    dispose,
    unsubscribe,
    unregister,
    invoke,
    publish: () => listener?.(),
  }
}

describe('Relay named IPC trust and validation', () => {
  it('requires the registered current main frame for every scheduling and credential entry and cleans handlers/subscription', async () => {
    const f = fixture()
    for (const channel of [
      IPC_CHANNELS.schedulingStateGet,
      IPC_CHANNELS.schedulingSettingsGet,
      IPC_CHANNELS.schedulingSettingsSave,
      IPC_CHANNELS.schedulingActivityRead,
      IPC_CHANNELS.relayCredentialSave,
      IPC_CHANNELS.relayCredentialRemove,
      IPC_CHANNELS.relayCredentialReceiptRead,
    ]) {
      expect(() =>
        f.invoke(
          channel,
          {},
          { sender: f.sender, senderFrame: { url: 'app://bundle/index.html' } },
        ),
      ).toThrow(/non-main frame/u)
    }
    expect(f.get).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    expect(f.state).not.toHaveBeenCalled()
    expect(f.credentialSave).not.toHaveBeenCalled()
    expect(f.credentialRemove).not.toHaveBeenCalled()
    expect(f.receipt).not.toHaveBeenCalled()
    expect(f.activity).not.toHaveBeenCalled()
    await f.invoke(IPC_CHANNELS.schedulingStateGet, {})
    await f.invoke(IPC_CHANNELS.schedulingSettingsGet)
    await f.invoke(IPC_CHANNELS.schedulingActivityRead, {})
    const saveNonce = randomUUID(),
      saveDeadline = Date.now() + 5000,
      removalNonce = randomUUID(),
      removalDeadline = Date.now() + 5000
    const saveResult = await f.invoke(IPC_CHANNELS.relayCredentialSave, {
      nonce: saveNonce,
      expectedRevision: 0,
      deadlineAt: saveDeadline,
      key: 'OWNED_IPC_CREDENTIAL',
    })
    const removalResult = await f.invoke(IPC_CHANNELS.relayCredentialRemove, {
      nonce: removalNonce,
      expectedRevision: 1,
      deadlineAt: removalDeadline,
    })
    await f.invoke(IPC_CHANNELS.relayCredentialReceiptRead, { nonce: saveNonce })
    expect(f.state).toHaveBeenCalledExactlyOnceWith({})
    expect(f.get).toHaveBeenCalledOnce()
    expect(f.activity).toHaveBeenCalledExactlyOnceWith({})
    // Exact full-input forward — the plaintext key goes only to the owner, never the response.
    expect(f.credentialSave).toHaveBeenCalledExactlyOnceWith({
      nonce: saveNonce,
      expectedRevision: 0,
      deadlineAt: saveDeadline,
      key: 'OWNED_IPC_CREDENTIAL',
    })
    expect(f.credentialRemove).toHaveBeenCalledExactlyOnceWith({
      nonce: removalNonce,
      expectedRevision: 1,
      deadlineAt: removalDeadline,
    })
    expect(f.receipt).toHaveBeenCalledExactlyOnceWith(saveNonce)
    if (typeof saveResult !== 'object' || saveResult === null || !('value' in saveResult))
      throw Error('Missing save receipt')
    if (typeof removalResult !== 'object' || removalResult === null || !('value' in removalResult))
      throw Error('Missing removal receipt')
    relayCredentialReceiptSchema.parse(saveResult.value)
    relayCredentialReceiptSchema.parse(removalResult.value)
    expect(saveResult).toEqual({
      ok: true,
      value: { nonce: saveNonce, operation: 'save', revision: 1, configured: true },
    })
    expect(removalResult).toEqual({
      ok: true,
      value: { nonce: removalNonce, operation: 'remove', revision: 2, configured: false },
    })
    expect(JSON.stringify(saveResult)).not.toContain('OWNED_IPC_CREDENTIAL')
    expect(JSON.stringify(removalResult)).not.toContain('OWNED_IPC_CREDENTIAL')
    f.publish()
    expect(f.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.schedulingChanged, {
      changed: true,
    })
    f.sender.mainFrame.url = 'https://untrusted.invalid/'
    expect(() => f.invoke(IPC_CHANNELS.schedulingSettingsGet)).toThrow(/unregistered or inactive/u)
    f.publish()
    expect(f.send).toHaveBeenCalledOnce()
    f.dispose()
    f.unregister()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.handlers.size).toBe(0)
  })

  it('rejects aliases, retired selectors, extra fields, bad cursors and malformed credential input before forwarding', async () => {
    const f = fixture()
    for (const invalid of [
      { expectedRevision: 0, enabled: true, selection: null },
      {
        expectedRevision: 0,
        selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-sol' },
      },
      { expectedRevision: 0, enabled: true, provider: 'codex' },
      { expectedRevision: 0, enabled: true, model: 'gpt-6-luna' },
      { expectedRevision: 0, enabled: true, catalogIdentity: 'abc' },
      { expectedRevision: 0, enabled: true, helperCalls: 1 },
    ])
      expect(f.invoke(IPC_CHANNELS.schedulingSettingsSave, invalid)).toMatchObject({ ok: false })
    expect(
      f.invoke(IPC_CHANNELS.schedulingActivityRead, {
        cursor: { asOf: 'today', id: 'bad', createdAt: 'today' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const nonce = randomUUID(),
      deadline = Date.now() + 5000
    for (const invalid of [
      { expectedRevision: 0, deadlineAt: deadline, key: 'k' },
      { nonce: 'not-a-uuid', expectedRevision: 0, deadlineAt: deadline, key: 'k' },
      { nonce, expectedRevision: -1, deadlineAt: deadline, key: 'k' },
      { nonce, expectedRevision: 0, deadlineAt: 'later', key: 'k' },
      { nonce, expectedRevision: 0, deadlineAt: deadline, key: 'with space' },
      { nonce, expectedRevision: 0, deadlineAt: deadline, key: 'CR\r\nLF' },
      {
        nonce,
        expectedRevision: 0,
        deadlineAt: deadline,
        key: 'k',
        ciphertext: 'extra',
      },
    ])
      expect(f.invoke(IPC_CHANNELS.relayCredentialSave, invalid)).toMatchObject({ ok: false })
    for (const invalid of [
      { nonce, expectedRevision: 0, deadlineAt: deadline, key: 'k' },
      { expectedRevision: 0, deadlineAt: deadline },
      { nonce: 'bad', expectedRevision: 0, deadlineAt: deadline },
      { nonce, expectedRevision: -1, deadlineAt: deadline },
      { nonce, expectedRevision: 0, deadlineAt: 'x' },
    ])
      expect(f.invoke(IPC_CHANNELS.relayCredentialRemove, invalid)).toMatchObject({ ok: false })
    for (const invalid of [{}, { nonce: 'bad' }, { nonce, extra: 1 }])
      expect(f.invoke(IPC_CHANNELS.relayCredentialReceiptRead, invalid)).toMatchObject({
        ok: false,
      })
    expect(f.save).not.toHaveBeenCalled()
    expect(f.activity).not.toHaveBeenCalled()
    expect(f.credentialSave).not.toHaveBeenCalled()
    expect(f.credentialRemove).not.toHaveBeenCalled()
    expect(f.receipt).not.toHaveBeenCalled()
    await f.invoke(IPC_CHANNELS.schedulingSettingsSave, { expectedRevision: 0, enabled: true })
    expect(f.save).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 0, enabled: true })
    f.dispose()
  })

  it('validates both directions of the Utility seam and forbids invented readiness or generic command fields', () => {
    const requestId = randomUUID()
    expect(
      utilityRequestSchema.safeParse({
        type: 'scheduling.settings.save.request',
        requestId,
        input: { expectedRevision: 0, enabled: true },
      }).success,
    ).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'scheduling.settings.save.request',
        requestId,
        input: { expectedRevision: 0, enabled: true, selection: null },
      }).success,
    ).toBe(false)
    for (const retired of ['scheduling.state.refresh.request', 'scheduling.models.refresh.request'])
      expect(utilityRequestSchema.safeParse({ type: retired, requestId }).success).toBe(false)
    expect(
      utilityRequestSchema.safeParse({
        type: 'scheduling.state.get.request',
        requestId,
        input: {},
      }).success,
    ).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'scheduling.state.get.request',
        requestId,
        input: {},
        command: 'start',
      }).success,
    ).toBe(false)
    const response = {
      type: 'scheduling.settings.response',
      requestId,
      result: {
        ok: true,
        value: {
          enabled: true,
          provider: 'openai',
          model: OPENAI_DECISION_MODEL,
          credential: { configured: false, revision: 0 },
          showIndicator: true,
          revision: 1,
          updatedAt: new Date(0).toISOString(),
        },
      },
    }
    expect(utilityResponseSchema.safeParse(response).success).toBe(true)
    expect(
      utilityResponseSchema.safeParse({
        ...response,
        result: {
          ok: true,
          value: { ...response.result.value, runnerAvailable: true },
        },
      }).success,
    ).toBe(false)
    const privatePacket = {
      type: 'relay.credential.decrypt.request',
      requestId,
      deadlineAt: Date.now() + 5000,
      ciphertext: Buffer.from('owned cipher').toString('base64'),
    }
    expect(relayCryptoMessageSchema.safeParse(privatePacket).success).toBe(true)
    expect(utilityRequestSchema.safeParse(privatePacket).success).toBe(false)
    expect(utilityResponseSchema.safeParse(privatePacket).success).toBe(false)
    expect(
      utilityRequestSchema.safeParse({
        type: 'relay.credential.write.request',
        requestId,
        input: {
          operation: 'save',
          nonce: randomUUID(),
          expectedRevision: 0,
          deadlineAt: Date.now() + 5000,
          ciphertext: Buffer.from('owned cipher').toString('base64'),
        },
      }).success,
    ).toBe(true)
    expect(
      utilityRequestSchema.safeParse({
        type: 'relay.credential.write.request',
        requestId,
        input: {
          operation: 'save',
          nonce: randomUUID(),
          expectedRevision: 0,
          deadlineAt: Date.now() + 5000,
          ciphertext: Buffer.from('owned cipher').toString('base64'),
          key: 'OWNED_IPC_CREDENTIAL',
        },
      }).success,
    ).toBe(false)
  })

  it('rejects the reveal from a non-main frame and exposes no plaintext through invalid input', async () => {
    const f = fixture()
    await expect(
      f.invoke(
        IPC_CHANNELS.relayCredentialReveal,
        { expectedRevision: 1, deadlineAt: Date.now() + 5000 },
        { sender: f.sender, senderFrame: f.sender.mainFrame },
      ),
    ).resolves.toEqual({
      ok: true,
      value: { revision: 1, key: 'sk-synthetic-reveal' },
    })
    expect(f.credentialReveal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedRevision: 1 }),
    )
    await expect(
      f.invoke(
        IPC_CHANNELS.relayCredentialReveal,
        { expectedRevision: 1, deadlineAt: Date.now() + 5000 },
        { sender: f.sender, senderFrame: { url: 'https://untrusted.invalid/' } },
      ),
    ).rejects.toThrow(/unregistered or inactive|non-main frame/u)
    expect(f.credentialReveal).toHaveBeenCalledTimes(1)
    const results = await Promise.all(
      [
        { expectedRevision: 1, deadlineAt: Date.now() + 5000, key: 'x' },
        { expectedRevision: 1, deadlineAt: Date.now() + 5000, ciphertext: 'x' },
        { expectedRevision: -1, deadlineAt: Date.now() + 5000 },
        { expectedRevision: 1 },
      ].map((bad) => f.invoke(IPC_CHANNELS.relayCredentialReveal, bad)),
    )
    for (const result of results) {
      if (
        typeof result !== 'object' ||
        result === null ||
        !('ok' in result) ||
        !('error' in result)
      )
        throw Error('Missing validation result')
      expect(result.ok).toBe(false)
      const error = result.error
      if (typeof error !== 'object' || error === null || !('code' in error))
        throw Error('Missing validation error')
      expect(error.code).toBe('VALIDATION')
    }
    expect(f.credentialReveal).toHaveBeenCalledTimes(1)
    f.dispose()
    f.unregister()
  })

  it('fences a reveal settled after frame registration changes', async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof f.client.revealRelayApiKey>>>()
    f.credentialReveal.mockReturnValueOnce(deferred.promise)
    const pending = f.invoke(IPC_CHANNELS.relayCredentialReveal, {
      expectedRevision: 1,
      deadlineAt: Date.now() + 5000,
    })
    f.sender.mainFrame = { url: 'https://untrusted.invalid/' }
    deferred.resolve({ ok: true, value: { revision: 1, key: 'sk-synthetic-reveal' } })
    await expect(pending).rejects.toThrow(/untrusted|unregistered|inactive|frame/u)
    f.dispose()
    f.unregister()
  })
})
