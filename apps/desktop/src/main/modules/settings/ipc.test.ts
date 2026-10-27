import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'

import { IPC_CHANNELS, utilityRequestSchema, utilityResponseSchema } from '@pact/contracts'

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
  harness.handlers.clear()
  vi.restoreAllMocks()
})
function fixture() {
  const trust = createRendererTrust({ isPackaged: true }),
    client = createUtilityProcessClient(),
    send = vi.fn<(channel: string, ...args: unknown[]) => void>()
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
  const result = {
    ok: true as const,
    value: {
      enabled: false,
      selection: null,
      showIndicator: true,
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    },
  }
  const get = vi.spyOn(client, 'getSchedulingSettings').mockResolvedValue(result)
  const save = vi.spyOn(client, 'saveSchedulingSettings').mockResolvedValue(result)
  const models = vi.spyOn(client, 'refreshSchedulingModels').mockResolvedValue({
    ok: false,
    error: { code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable' },
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
    models,
    activity,
    dispose,
    unsubscribe,
    unregister,
    invoke,
    publish: () => listener?.(),
  }
}

describe('Relay named IPC trust and validation', () => {
  it('requires the registered current main frame for every scheduling entry and cleans its handlers/subscription', async () => {
    const f = fixture()
    for (const channel of [
      IPC_CHANNELS.schedulingStateGet,
      IPC_CHANNELS.schedulingStateRefresh,
      IPC_CHANNELS.schedulingSettingsGet,
      IPC_CHANNELS.schedulingSettingsSave,
      IPC_CHANNELS.schedulingModelsRefresh,
      IPC_CHANNELS.schedulingActivityRead,
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
    expect(f.models).not.toHaveBeenCalled()
    expect(f.activity).not.toHaveBeenCalled()
    expect(await f.invoke(IPC_CHANNELS.schedulingSettingsGet)).toMatchObject({
      ok: true,
      value: { enabled: false, selection: null },
    })
    await f.invoke(IPC_CHANNELS.schedulingModelsRefresh)
    await f.invoke(IPC_CHANNELS.schedulingActivityRead, {})
    expect(f.models).toHaveBeenCalledOnce()
    expect(f.activity).toHaveBeenCalledExactlyOnceWith({})
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

  it('rejects aliases, substituted models, extra fields and invalid cursors before forwarding to Utility', async () => {
    const f = fixture()
    for (const selection of [
      { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-sol' },
      { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'haiku' },
      { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'deepseek-flash' },
    ])
      expect(
        f.invoke(IPC_CHANNELS.schedulingSettingsSave, { expectedRevision: 0, selection }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(
      f.invoke(IPC_CHANNELS.schedulingSettingsSave, {
        expectedRevision: 0,
        enabled: true,
        helperCalls: 1,
      }),
    ).toMatchObject({ ok: false })
    expect(
      f.invoke(IPC_CHANNELS.schedulingActivityRead, {
        cursor: { asOf: 'today', id: 'bad', createdAt: 'today' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(f.save).not.toHaveBeenCalled()
    expect(f.activity).not.toHaveBeenCalled()
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
        input: {
          expectedRevision: 0,
          selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: 'haiku' },
        },
      }).success,
    ).toBe(false)
    expect(
      utilityRequestSchema.safeParse({
        type: 'scheduling.models.refresh.request',
        requestId,
        command: 'start',
      }).success,
    ).toBe(false)
    expect(
      utilityResponseSchema.safeParse({
        type: 'scheduling.settings.response',
        requestId,
        result: {
          ok: true,
          value: {
            enabled: true,
            selection: null,
            showIndicator: true,
            revision: 1,
            updatedAt: new Date().toISOString(),
            runnerAvailable: true,
          },
        },
      }).success,
    ).toBe(false)
  })
})
