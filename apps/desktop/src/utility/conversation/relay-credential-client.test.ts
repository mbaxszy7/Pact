import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

import { relayCryptoMessageSchema } from '@pact/contracts'

import { UtilityRelayCredentialClient } from './relay-credential-client.js'

const KEY = 'sk-synthetic-preview-key-0000'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const cipher = Buffer.from('synthetic encrypted bytes').toString('base64')
const parent = () => ({ postMessage: vi.fn<(message: unknown) => void>() })
const controller = () => new AbortController()
const posted = (port: ReturnType<typeof parent>) =>
  port.postMessage.mock.calls.map((call) => relayCryptoMessageSchema.parse(call[0]))
const requestAt = (port: ReturnType<typeof parent>, index = 0) => {
  const message = posted(port)[index]
  if (message?.type !== 'relay.credential.decrypt.request')
    throw new Error('Expected a private decrypt request.')
  return message
}

describe('UtilityRelayCredentialClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('posts one bounded canonical decrypt request and returns the key on a current success', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const original = Date.now() + 60_000
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: original })
    const packets = posted(port)
    expect(packets).toHaveLength(1)
    const request = requestAt(port)
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(request.ciphertext).toBe(cipher)
    // Deadline is min(original, now + 5 s): the 5 s bound wins over a later original.
    expect(request.deadlineAt).toBeLessThanOrEqual(Date.now() + 5000)
    expect(request.deadlineAt).toBeGreaterThan(Date.now())
    const replacement = Buffer.from('rotated synthetic bytes').toString('base64')
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId: request.requestId,
        result: { ok: true, key: KEY, replacementCiphertext: replacement },
      }),
    ).toBe(true)
    await expect(decrypt).resolves.toEqual({ key: KEY, replacementCiphertext: replacement })
    // No key is cached between invocations: the same source is a fresh request.
    const again = client.decrypt(cipher, { signal: abort.signal, deadlineAt: original })
    const secondId = requestAt(port, 1).requestId
    client.dispose()
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId: secondId,
        result: { ok: false, reason: 'cancelled' },
      }),
    ).toBe(true)
    await expect(again).resolves.toBeNull()
  })

  it('rejects invalid, already-aborted and expired input before posting anything', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    for (const ciphertext of ['AB==', ' ', Buffer.alloc(8193).toString('base64'), 'not-base64!'])
      // oxlint-disable-next-line no-await-in-loop -- Each invalid input must reject independently in order.
      await expect(
        client.decrypt(ciphertext, { signal: abort.signal, deadlineAt: Date.now() + 5000 }),
      ).resolves.toBeNull()
    abort.abort()
    await expect(
      client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 5000 }),
    ).resolves.toBeNull()
    const fresh = controller()
    await expect(
      client.decrypt(cipher, { signal: fresh.signal, deadlineAt: Date.now() - 1 }),
    ).resolves.toBeNull()
    expect(posted(port)).toHaveLength(0)
    client.dispose()
  })

  it('abandonment sends one cancel but never resolves or frees the slot before the physical reply', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 5000 })
    const requestId = requestAt(port).requestId
    abort.abort()
    expect(posted(port)).toHaveLength(2)
    expect(posted(port)[1]).toEqual({
      type: 'relay.credential.decrypt.cancel',
      requestId,
    })
    // The logical promise stays unsettled and the slot stays owned.
    let settled = false
    void decrypt.then(() => {
      settled = true
      return settled
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const second = client.decrypt(cipher, {
      signal: controller().signal,
      deadlineAt: Date.now() + 5000,
    })
    await expect(second).resolves.toBeNull()
    expect(posted(port)).toHaveLength(2)
    // A late matching success resolves null: the abandoned owner is already gone logically.
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: true, key: KEY },
      }),
    ).toBe(true)
    await expect(decrypt).resolves.toBeNull()
    client.dispose()
  })

  it('keeps the promise unsettled past the logical deadline until the cancelled reply arrives', async () => {
    vi.useFakeTimers()
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 40 })
    const requestId = requestAt(port).requestId
    await vi.advanceTimersByTimeAsync(80)
    let settled = false
    void decrypt.then(() => {
      settled = true
      return settled
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(posted(port)).toHaveLength(2)
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: false, reason: 'cancelled' },
      }),
    ).toBe(true)
    await expect(decrypt).resolves.toBeNull()
    // The slot is free for exactly the next admitted request.
    const next = client.decrypt(cipher, {
      signal: controller().signal,
      deadlineAt: Date.now() + 5000,
    })
    const nextId = requestAt(port, 2).requestId
    client.dispose()
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId: nextId,
        result: { ok: false, reason: 'cancelled' },
      }),
    ).toBe(true)
    await expect(next).resolves.toBeNull()
  })

  it('consumes wrong-ID and malformed private packets without releasing the owner', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 5000 })
    const requestId = requestAt(port).requestId
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId: REQUEST_ID,
        result: { ok: true, key: KEY },
      }),
    ).toBe(true)
    expect(client.consume({ type: 'relay.credential.decrypt.request', requestId })).toBe(true)
    expect(client.consume({ type: 'relay.credential.decrypt.bogus' })).toBe(true)
    expect(client.consume({ type: 'unrelated.message' })).toBe(false)
    expect(client.consume('nope')).toBe(false)
    let settled = false
    void decrypt.then(() => {
      settled = true
      return settled
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: true, key: KEY },
      }),
    ).toBe(true)
    await expect(decrypt).resolves.toEqual({ key: KEY })
    client.dispose()
  })

  it('keeps an earlier original deadline without stretching it to 5 s', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const original = Date.now() + 150
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: original })
    const request = requestAt(port)
    expect(request.deadlineAt).toBe(original)
    client.dispose()
    client.consume({
      type: 'relay.credential.decrypt.response',
      requestId: request.requestId,
      result: { ok: false, reason: 'cancelled' },
    })
    await expect(decrypt).resolves.toBeNull()
  })

  it('abandons once when the initial request post itself throws after possible delivery', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    port.postMessage.mockImplementation(() => {
      throw new Error('transport closed before reply')
    })
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 5000 })
    // Possible delivery means physical uncertainty: no release, retry or second admission.
    const refused = await client.decrypt(cipher, {
      signal: abort.signal,
      deadlineAt: Date.now() + 5000,
    })
    expect(refused).toBeNull()
    expect(posted(port).filter((m) => m.type.endsWith('cancel'))).toHaveLength(1)
    let settled = false
    void decrypt.then(() => {
      settled = true
      return settled
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    client.dispose()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(posted(port).filter((m) => m.type.endsWith('cancel'))).toHaveLength(1)
    client.consume({
      type: 'relay.credential.decrypt.response',
      requestId: requestAt(port).requestId,
      result: { ok: false, reason: 'cancelled' },
    })
    await expect(decrypt).resolves.toBeNull()
  })

  it('a throwing transport still sends no early release and no retry', async () => {
    const port = parent()
    const client = new UtilityRelayCredentialClient(port)
    const abort = controller()
    const decrypt = client.decrypt(cipher, { signal: abort.signal, deadlineAt: Date.now() + 5000 })
    const requestId = requestAt(port).requestId
    port.postMessage.mockImplementation(() => {
      throw new Error('transport closed')
    })
    abort.abort()
    // The cancel attempt threw after possible delivery: no fabricated release or retry.
    let settled = false
    void decrypt.then(() => {
      settled = true
      return settled
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    port.postMessage.mockRestore()
    expect(
      client.consume({
        type: 'relay.credential.decrypt.response',
        requestId,
        result: { ok: false, reason: 'cancelled' },
      }),
    ).toBe(true)
    await expect(decrypt).resolves.toBeNull()
    client.dispose()
  })
})
