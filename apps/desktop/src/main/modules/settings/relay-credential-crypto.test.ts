/* oxlint-disable typescript/unbound-method, typescript/no-unsafe-type-assertion -- Deferred safeStorage/UtilityProcess stubs model only the private physical-owner seam under test. */
import type { UtilityProcess } from 'electron'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RelayCredentialWrite,
  RpcResult,
  RelayCredentialReceipt,
  RelayCredentialStored,
} from '@pact/contracts'

const storage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
  encryptStringAsync: vi.fn<(key: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(bytes: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
}))
vi.mock('electron', () => ({ safeStorage: storage }))

const { RelayCredentialCrypto } = await import('./relay-credential-crypto.js')

const KEY = 'sk-synthetic-preview-key-0000'
const NONCE = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const CIPHER = Buffer.from('synthetic encrypted bytes').toString('base64')
const decryptPacket = (requestId = REQUEST_ID, ciphertext = CIPHER) => ({
  type: 'relay.credential.decrypt.request' as const,
  requestId,
  deadlineAt: Date.now() + 5000,
  ciphertext,
})
const saveInput = (deadlineAt = Date.now() + 5000) => ({
  nonce: NONCE,
  expectedRevision: 0,
  deadlineAt,
  key: KEY,
})
type ReadStored = (input: {
  expectedRevision: number
  deadlineAt: number
}) => Promise<RpcResult<RelayCredentialStored>>
const revealInput = (deadlineAt = Date.now() + 5000) => ({
  expectedRevision: 1,
  deadlineAt,
})
const storedReply: RpcResult<RelayCredentialStored> = {
  ok: true,
  value: { revision: 1, ciphertext: CIPHER },
}
const writeReceipt = (input: RelayCredentialWrite): RpcResult<RelayCredentialReceipt> => ({
  ok: true,
  value: {
    nonce: input.nonce,
    operation: input.operation,
    revision: input.expectedRevision + 1,
    configured: input.operation === 'save',
  },
})

describe('RelayCredentialCrypto', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs the save slot before the OS answer, busies a distinct request and admits no duplicate ACK', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<boolean>()
    storage.isAsyncEncryptionAvailable.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    const write = vi.fn<
      (input: RelayCredentialWrite) => Promise<RpcResult<RelayCredentialReceipt>>
    >(async (input) => writeReceipt(input))
    const save = crypto.save(saveInput(), {
      source: src,
      deadlineAt: Date.now() + 5000,
      isCurrent: () => true,
      write,
    })
    await entered.promise
    // A second save while the physical owner is in flight is refused without touching it.
    const refused = await crypto.save(saveInput(), {
      source: src,
      deadlineAt: Date.now() + 5000,
      isCurrent: () => true,
      write,
    })
    expect(refused.ok).toBe(false)
    const other = {
      postMessage: vi.fn<UtilityProcess['postMessage']>(),
    } as unknown as UtilityProcess
    expect(crypto.receive(other, decryptPacket(), () => true)).toBe(true)
    expect(other.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ result: { ok: false, reason: 'busy' } }),
    )
    native.resolve(true)
    storage.encryptStringAsync.mockResolvedValue(Buffer.from('synthetic encrypted bytes'))
    const result = await save
    expect(result).toEqual({
      ok: true,
      value: { nonce: NONCE, operation: 'save', revision: 1, configured: true },
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(await crypto.settlement(performance.now() + 200)).toBe(true)
  })

  it('writes exactly one encrypted packet with metadata and no plaintext key field', async () => {
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.encryptStringAsync.mockResolvedValue(Buffer.from('synthetic encrypted bytes'))
    const write = vi.fn<
      (input: RelayCredentialWrite) => Promise<RpcResult<RelayCredentialReceipt>>
    >(async (input) => writeReceipt(input))
    const deadlineAt = Date.now() + 5000
    const result = await crypto.save(saveInput(deadlineAt), {
      source: src,
      deadlineAt,
      isCurrent: () => true,
      write,
    })
    expect(write).toHaveBeenCalledTimes(1)
    const packet = write.mock.calls[0]![0]
    expect(packet).toEqual({
      operation: 'save',
      nonce: NONCE,
      expectedRevision: 0,
      deadlineAt,
      ciphertext: CIPHER,
    })
    expect('key' in packet).toBe(false)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('honors the earlier input deadline instead of the 5 s context bound', async () => {
    vi.useFakeTimers()
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    const native = Promise.withResolvers<boolean>()
    storage.isAsyncEncryptionAvailable.mockReturnValue(native.promise)
    const save = crypto.save(saveInput(Date.now() + 20), {
      source: src,
      deadlineAt: Date.now() + 5000,
      isCurrent: () => true,
      write: async (input) => writeReceipt(input),
    })
    await vi.advanceTimersByTimeAsync(40)
    const result = await save
    expect(result.ok).toBe(false)
    expect(storage.encryptStringAsync).not.toHaveBeenCalled()
    native.resolve(true)
    expect(await crypto.settlement(performance.now() + 500)).toBe(true)
  })

  it('times out a pending write as UNCERTAIN and retains the slot until the write joins', async () => {
    vi.useFakeTimers()
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.encryptStringAsync.mockResolvedValue(Buffer.from('synthetic encrypted bytes'))
    const writeDeferred = Promise.withResolvers<RpcResult<RelayCredentialReceipt>>()
    const write = vi.fn<() => Promise<RpcResult<RelayCredentialReceipt>>>(
      () => writeDeferred.promise,
    )
    const save = crypto.save(saveInput(Date.now() + 40), {
      source: src,
      deadlineAt: Date.now() + 40,
      isCurrent: () => true,
      write,
    })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    const result = await save
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'UNCERTAIN' }) })
    // The physical slot is retained until the deferred write actually joins.
    const early = crypto.settlement(performance.now() + 20)
    await vi.advanceTimersByTimeAsync(21)
    expect(await early).toBe(false)
    writeDeferred.resolve(
      writeReceipt({
        operation: 'save',
        nonce: NONCE,
        expectedRevision: 0,
        deadlineAt: Date.now() + 40,
        ciphertext: CIPHER,
      }),
    )
    expect(await crypto.settlement(performance.now() + 200)).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('acknowledges a matching cancel only after the actual native join, with no early ACK', async () => {
    vi.useFakeTimers()
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
    await entered.promise
    // Duplicate request while in flight: no acknowledgement at all.
    expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
    const distinct = {
      postMessage: vi.fn<UtilityProcess['postMessage']>(),
    } as unknown as UtilityProcess
    const otherId = '33333333-3333-4333-8333-333333333333'
    expect(crypto.receive(distinct, decryptPacket(otherId), () => true)).toBe(true)
    expect(distinct.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ result: { ok: false, reason: 'busy' } }),
    )
    // Cancel the actual owner: no reply until the OS call joins.
    expect(
      crypto.receive(
        src,
        { type: 'relay.credential.decrypt.cancel', requestId: REQUEST_ID },
        () => true,
      ),
    ).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
    const held = crypto.settlement(performance.now() + 20)
    await vi.advanceTimersByTimeAsync(21)
    expect(await held).toBe(false)
    native.resolve({ result: KEY, shouldReEncrypt: false })
    expect(await crypto.settlement(performance.now() + 200)).toBe(true)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'relay.credential.decrypt.response',
      requestId: REQUEST_ID,
      result: { ok: false, reason: 'cancelled' },
    })
  })

  it('cancels during delayed availability and delayed rotation the same way', async () => {
    for (const phase of ['availability', 'rotation'] as const) {
      const crypto = new RelayCredentialCrypto()
      const postMessage = vi.fn<UtilityProcess['postMessage']>()
      const src = { postMessage } as unknown as UtilityProcess
      const entered = Promise.withResolvers<void>()
      const native = Promise.withResolvers<unknown>()
      if (phase === 'availability') {
        storage.isAsyncEncryptionAvailable.mockImplementation(() => {
          entered.resolve()
          return native.promise as Promise<boolean>
        })
      } else {
        storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
        storage.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: true })
        storage.encryptStringAsync.mockImplementation(() => {
          entered.resolve()
          return native.promise as Promise<Buffer>
        })
      }
      expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
      // oxlint-disable-next-line no-await-in-loop -- Each phase requires its own entered gate.
      await entered.promise
      expect(
        crypto.receive(
          src,
          { type: 'relay.credential.decrypt.cancel', requestId: REQUEST_ID },
          () => true,
        ),
      ).toBe(true)
      native.resolve(phase === 'availability' ? true : Buffer.from('rotated bytes'))
      // oxlint-disable-next-line no-await-in-loop -- Join each phase before the next scenario.
      expect(await crypto.settlement(performance.now() + 500)).toBe(true)
      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: { ok: false, reason: 'cancelled' } }),
      )
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain(KEY)
    }
  })

  it('suppresses replies to an exited child and ignores a wrong-source cancel', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
    await entered.promise
    // A cancel from a different source does not cancel the actual owner.
    const stranger = {
      postMessage: vi.fn<UtilityProcess['postMessage']>(),
    } as unknown as UtilityProcess
    expect(
      crypto.receive(
        stranger,
        { type: 'relay.credential.decrypt.cancel', requestId: REQUEST_ID },
        () => true,
      ),
    ).toBe(true)
    // Source exit abandons physical ownership without a reply to the dead child.
    crypto.cancelSource(src)
    native.resolve({ result: KEY, shouldReEncrypt: false })
    expect(await crypto.settlement(performance.now() + 500)).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
    expect(stranger.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ ok: true }) }),
    )
  })

  it('returns key plus replacement ciphertext once on a completed rotation, and does not re-encrypt otherwise', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: true })
    storage.encryptStringAsync.mockResolvedValue(Buffer.from('rotated synthetic bytes'))
    expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
    expect(await crypto.settlement(performance.now() + 500)).toBe(true)
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(1)
    const packet = postMessage.mock.calls[0]![0] as {
      result: { ok: boolean; key: string; replacementCiphertext?: string }
    }
    expect(packet.result.ok).toBe(true)
    expect(packet.result.key).toBe(KEY)
    expect(typeof packet.result.replacementCiphertext).toBe('string')

    const second = new RelayCredentialCrypto()
    const secondPort = vi.fn<UtilityProcess['postMessage']>()
    const secondSource = { postMessage: secondPort } as unknown as UtilityProcess
    storage.encryptStringAsync.mockClear()
    storage.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: false })
    expect(second.receive(secondSource, decryptPacket(), () => true)).toBe(true)
    expect(await second.settlement(performance.now() + 500)).toBe(true)
    expect(storage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('evaluates each malformed ciphertext independently without OS decrypt work', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockRejectedValue(new Error('decode failed'))
    for (const [index, ciphertext] of ['AB==', Buffer.alloc(8193).toString('base64')].entries()) {
      const id = `44444444-4444-4444-8444-44444444444${index}`
      expect(crypto.receive(src, decryptPacket(id, ciphertext), () => true)).toBe(true)
      // oxlint-disable-next-line no-await-in-loop -- Each malformed input must join before the next evaluation.
      expect(await crypto.settlement(performance.now() + 500)).toBe(true)
    }
    expect(storage.decryptStringAsync).not.toHaveBeenCalled()
    expect(storage.encryptStringAsync).not.toHaveBeenCalled()
    expect(crypto.receive(src, { type: 'unrelated.message' }, () => true)).toBe(false)
  })

  it('never echoes a synthetic key through a native error path', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockRejectedValue(new Error(`decrypt failed for ${KEY}`))
    expect(crypto.receive(src, decryptPacket(), () => true)).toBe(true)
    expect(await crypto.settlement(performance.now() + 500)).toBe(true)
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain(KEY)
  })

  it('does not cancel the current decrypt for another source or request identity', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    const strangerPost = vi.fn<UtilityProcess['postMessage']>()
    const stranger = { postMessage: strangerPost } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    try {
      crypto.receive(src, decryptPacket(), () => true)
      await entered.promise
      crypto.receive(
        stranger,
        {
          type: 'relay.credential.decrypt.cancel',
          requestId: REQUEST_ID,
        },
        () => true,
      )
      const otherId = '33333333-3333-4333-8333-333333333333'
      crypto.receive(
        src,
        {
          type: 'relay.credential.decrypt.cancel',
          requestId: otherId,
        },
        () => true,
      )
      expect(postMessage).toHaveBeenCalledExactlyOnceWith({
        type: 'relay.credential.decrypt.response',
        requestId: otherId,
        result: { ok: false, reason: 'cancelled' },
      })
      native.resolve({ result: KEY, shouldReEncrypt: false })
      expect(await crypto.settlement(performance.now() + 500)).toBe(true)
      expect(postMessage).toHaveBeenLastCalledWith({
        type: 'relay.credential.decrypt.response',
        requestId: REQUEST_ID,
        result: { ok: true, key: KEY },
      })
      expect(strangerPost).toHaveBeenCalledExactlyOnceWith({
        type: 'relay.credential.decrypt.response',
        requestId: REQUEST_ID,
        result: { ok: false, reason: 'cancelled' },
      })
    } finally {
      crypto.dispose()
      native.resolve({ result: KEY, shouldReEncrypt: false })
      await crypto.settlement(performance.now() + 500)
    }
  })

  it('withholds a late key after the current Utility source changes', async () => {
    const crypto = new RelayCredentialCrypto()
    const postMessage = vi.fn<UtilityProcess['postMessage']>()
    const src = { postMessage } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
    let current = true
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    try {
      crypto.receive(src, decryptPacket(), () => current)
      await entered.promise
      current = false
      native.resolve({ result: KEY, shouldReEncrypt: false })
      expect(await crypto.settlement(performance.now() + 500)).toBe(true)
      expect(postMessage).not.toHaveBeenCalled()
    } finally {
      crypto.dispose()
      native.resolve({ result: KEY, shouldReEncrypt: false })
      await crypto.settlement(performance.now() + 500)
    }
  })

  it('dispose during pending native work blocks admission but joins on settlement', async () => {
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    const native = Promise.withResolvers<boolean>()
    storage.isAsyncEncryptionAvailable.mockReturnValue(native.promise)
    const save = crypto.save(saveInput(), {
      source: src,
      deadlineAt: Date.now() + 5000,
      isCurrent: () => true,
      write: async (input) => writeReceipt(input),
    })
    await Promise.resolve()
    crypto.dispose()
    const result = await save
    expect(result.ok).toBe(false)
    native.resolve(true)
    expect(await crypto.settlement(performance.now() + 500)).toBe(true)
  })

  it('reveals only after two identical bounded reads bracket one native decrypt', async () => {
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: true })
    const read = vi.fn<ReadStored>(async () => storedReply)
    const input = revealInput()
    const result = await crypto.reveal(input, {
      source: src,
      isCurrent: () => true,
      read,
    })
    expect(result).toEqual({ ok: true, value: { revision: 1, key: KEY } })
    expect(read).toHaveBeenCalledTimes(2)
    for (const call of read.mock.calls)
      expect(call[0]).toEqual({ expectedRevision: 1, deadlineAt: input.deadlineAt })
    expect(storage.decryptStringAsync).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(CIPHER, 'base64'),
    )
    expect(storage.encryptStringAsync).not.toHaveBeenCalled()
    expect(src.postMessage).not.toHaveBeenCalled()
  })

  it.each<RpcResult<RelayCredentialStored>>([
    {
      ok: true as const,
      value: { revision: 1, ciphertext: null },
    },
    {
      ok: true as const,
      value: { revision: 2, ciphertext: CIPHER },
    },
  ])(
    'refuses a missing ciphertext or stale stored revision before any decrypt %#',
    async (stored) => {
      const crypto = new RelayCredentialCrypto()
      const src = {
        postMessage: vi.fn<UtilityProcess['postMessage']>(),
      } as unknown as UtilityProcess
      storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
      const read = vi.fn<ReadStored>(async () => stored)
      const result = await crypto.reveal(revealInput(), {
        source: src,
        isCurrent: () => true,
        read,
      })
      expect(result.ok).toBe(false)
      expect(read).toHaveBeenCalledTimes(1)
      expect(storage.decryptStringAsync).not.toHaveBeenCalled()
    },
  )

  it.each<[string, RpcResult<RelayCredentialStored>]>([
    ['a changed revision', { ok: true, value: { revision: 2, ciphertext: CIPHER } }],
    ['changed ciphertext', { ok: true, value: { revision: 1, ciphertext: 'AAAA' } }],
  ])('refuses when the post-decrypt read reports %s', async (_label, after) => {
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: false })
    const read = vi.fn<ReadStored>().mockResolvedValueOnce(storedReply).mockResolvedValue(after)
    const result = await crypto.reveal(revealInput(), {
      source: src,
      isCurrent: () => true,
      read,
    })
    expect(result.ok).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('returns a generic failure on native unavailability or a decrypt rejection', async () => {
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    storage.isAsyncEncryptionAvailable.mockResolvedValue(false)
    const read = vi.fn<ReadStored>(async () => storedReply)
    const unavailable = await crypto.reveal(revealInput(), {
      source: src,
      isCurrent: () => true,
      read,
    })
    expect(unavailable.ok).toBe(false)
    const second = new RelayCredentialCrypto()
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockRejectedValue(new Error('private native detail'))
    const rejected = await second.reveal(revealInput(), {
      source: src,
      isCurrent: () => true,
      read: vi.fn<() => Promise<typeof storedReply>>(async () => storedReply),
    })
    expect(rejected.ok).toBe(false)
    expect(JSON.stringify(rejected)).not.toContain(KEY)
    expect(JSON.stringify(rejected)).not.toContain('private native detail')
  })

  it('timeout resolves unavailable while the physical slot is held until the native join', async () => {
    vi.useFakeTimers()
    const crypto = new RelayCredentialCrypto()
    const src = { postMessage: vi.fn<UtilityProcess['postMessage']>() } as unknown as UtilityProcess
    const entered = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
    storage.decryptStringAsync.mockImplementation(() => {
      entered.resolve()
      return native.promise
    })
    const read = vi.fn<ReadStored>(async () => storedReply)
    const reveal = crypto.reveal(revealInput(Date.now() + 400), {
      source: src,
      isCurrent: () => true,
      read,
    })
    try {
      // The native decrypt must actually be entered before the timer may expire.
      await entered.promise
      await vi.advanceTimersByTimeAsync(500)
      expect((await reveal).ok).toBe(false)
      // Overlapping save and a distinct decrypt packet stay refused while the slot is held.
      const refused = await crypto.save(saveInput(), {
        source: src,
        deadlineAt: Date.now() + 5000,
        isCurrent: () => true,
        write: async (input) => writeReceipt(input),
      })
      expect(refused.ok).toBe(false)
      const other = {
        postMessage: vi.fn<UtilityProcess['postMessage']>(),
      } as unknown as UtilityProcess
      expect(crypto.receive(other, decryptPacket(), () => true)).toBe(true)
      expect(other.postMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: { ok: false, reason: 'busy' } }),
      )
      native.resolve({ result: KEY, shouldReEncrypt: false })
      expect(await crypto.settlement(performance.now() + 500)).toBe(true)
      expect(src.postMessage).not.toHaveBeenCalled()
    } finally {
      crypto.dispose()
      native.resolve({ result: KEY, shouldReEncrypt: false })
      await crypto.settlement(performance.now() + 500)
    }
  })

  it.each(['cancelSource', 'dispose'] as const)(
    '%s during an entered deferred decrypt resolves unavailable and returns no late key',
    async (variant) => {
      const crypto = new RelayCredentialCrypto()
      const src = {
        postMessage: vi.fn<UtilityProcess['postMessage']>(),
      } as unknown as UtilityProcess
      const entered = Promise.withResolvers<void>()
      const native = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>()
      storage.isAsyncEncryptionAvailable.mockResolvedValue(true)
      storage.decryptStringAsync.mockImplementation(() => {
        entered.resolve()
        return native.promise
      })
      const read = vi.fn<ReadStored>(async () => storedReply)
      const reveal = crypto.reveal(revealInput(), {
        source: src,
        isCurrent: () => true,
        read,
      })
      try {
        await entered.promise
        if (variant === 'cancelSource') crypto.cancelSource(src)
        else crypto.dispose()
        expect((await reveal).ok).toBe(false)
        // The confirmation read never runs once the owner is fenced.
        expect(read).toHaveBeenCalledTimes(1)
        native.resolve({ result: KEY, shouldReEncrypt: false })
        expect(await crypto.settlement(performance.now() + 500)).toBe(true)
        expect(read).toHaveBeenCalledTimes(1)
        expect(src.postMessage).not.toHaveBeenCalled()
      } finally {
        crypto.dispose()
        native.resolve({ result: KEY, shouldReEncrypt: false })
        await crypto.settlement(performance.now() + 500)
      }
    },
  )
})
