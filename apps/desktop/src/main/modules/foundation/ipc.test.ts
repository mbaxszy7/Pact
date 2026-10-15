import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust.js'
import type { UtilityProcessClient } from '../../utility-process/client.js'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { getName: () => 'Pact', getVersion: () => '0.1.0', isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) =>
      harness.handlers.set(channel, handler),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}))
import { registerFoundationIpcHandlers } from './ipc.js'

beforeEach(() => harness.handlers.clear())

describe('Foundation named health input boundary', () => {
  function fixture() {
    const trusted = vi.fn<RendererTrust['assertTrustedMainFrame']>()
    const getHealth = vi.fn<UtilityProcessClient['getHealth']>().mockResolvedValue({
      ok: true,
      value: { status: 'ready', database: 'ready', pid: 1, checkedAt: new Date().toISOString() },
    })
    const trust: RendererTrust = {
      loadUrl: 'app://bundle/index.html',
      allowsNavigation: () => true,
      registerWindow: () => () => undefined,
      assertTrustedMainFrame: trusted,
      trustedWindows: () => [],
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The named foundation handler uses only getHealth; the test double deliberately does not implement unrelated Utility operations.
    const client = { getHealth } as unknown as UtilityProcessClient
    const dispose = registerFoundationIpcHandlers(trust, client)
    const handle = harness.handlers.get(IPC_CHANNELS.runtimeHealth)
    if (!handle) throw new Error('Named health handler missing.')
    return { handle, trusted, getHealth, dispose }
  }

  it('preserves no-input health and forwards only schema-valid optional ACK input', async () => {
    const f = fixture()
    const event = {}
    await f.handle(event)
    expect(f.getHealth).toHaveBeenLastCalledWith()
    const input = {
      sqlitePlans: {
        ack: {
          observerEpoch: '00000000-0000-4000-8000-000000000001',
          pageSequence: 1,
          payloadDigest: 'a'.repeat(64),
        },
      },
    }
    await f.handle(event, input)
    expect(f.getHealth).toHaveBeenLastCalledWith(input)
    expect(f.trusted).toHaveBeenCalledTimes(2)
    f.dispose()
    expect(harness.handlers.size).toBe(0)
  })

  it.each([null, { sqlitePlans: { ack: { pageSequence: 1 } } }, { rawChannel: 'untrusted' }])(
    'rejects malformed named input without contacting Utility',
    async (input) => {
      const f = fixture()
      await expect(Promise.resolve(f.handle({}, input))).resolves.toEqual({
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid runtime health observation input.' },
      })
      expect(f.getHealth).not.toHaveBeenCalled()
      expect(f.trusted).toHaveBeenCalledOnce()
      f.dispose()
    },
  )

  it('checks the registered main frame before parsing input or contacting Utility', () => {
    const f = fixture()
    f.trusted.mockImplementation(() => {
      throw new Error('Untrusted frame.')
    })
    expect(() => f.handle({}, {})).toThrow('Untrusted frame.')
    expect(f.getHealth).not.toHaveBeenCalled()
    f.dispose()
  })
})
