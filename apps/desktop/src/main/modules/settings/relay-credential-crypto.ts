import { safeStorage, type UtilityProcess } from 'electron'

import {
  relayApiKeySchema,
  relayCiphertextSchema,
  relayCredentialRevealSchema,
  relayCredentialSaveSchema,
  relayCredentialWriteSchema,
  relayCryptoMessageSchema,
  RELAY_CIPHERTEXT_BYTES,
  RELAY_CREDENTIAL_TIMEOUT_MS,
  RELAY_CRYPTO_PACKET_BYTES,
  type RelayCredentialReceipt,
  type RelayCredentialReveal,
  type RelayCredentialRevealed,
  type RelayCredentialSave,
  type RelayCredentialStored,
  type RelayCredentialWrite,
  type RpcResult,
} from '@pact/contracts'

type SaveResult = RpcResult<RelayCredentialReceipt>
type DecryptResult =
  | { ok: true; key: string; replacementCiphertext?: string }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'busy' }
type Slot = {
  kind: 'save' | 'decrypt' | 'reveal'
  source: UtilityProcess
  requestId: string | null
  abandoned: boolean
  sourceExited: boolean
  cancel: () => void
  physical: Promise<void>
}
const unavailable = (): Extract<SaveResult, { ok: false }> => ({
  ok: false,
  error: { code: 'RUNTIME_UNAVAILABLE', message: 'Secure credential storage is unavailable.' },
})
const uncertain = (): SaveResult => ({
  ok: false,
  error: { code: 'UNCERTAIN', message: 'The key change could not be confirmed. Check its status.' },
})
const isPrivate = (message: unknown): boolean =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  message.type.startsWith('relay.credential.decrypt.')

function decodeCiphertext(value: string): Buffer {
  const parsed = relayCiphertextSchema.parse(value)
  const decoded = Buffer.from(parsed, 'base64')
  if (
    decoded.length === 0 ||
    decoded.length > RELAY_CIPHERTEXT_BYTES ||
    decoded.toString('base64') !== parsed
  )
    throw new Error('Invalid encrypted credential.')
  return decoded
}
function encodeCiphertext(value: Buffer): string {
  if (value.length === 0 || value.length > RELAY_CIPHERTEXT_BYTES)
    throw new Error('Invalid encrypted credential.')
  return relayCiphertextSchema.parse(value.toString('base64'))
}

/** One physical OS operation, no queue or completed-key cache. */
export class RelayCredentialCrypto {
  private pending: Slot | undefined
  private disposed = false

  private slot(kind: Slot['kind'], source: UtilityProcess, requestId: string | null): Slot {
    const slot: Slot = {
      kind,
      source,
      requestId,
      abandoned: false,
      sourceExited: false,
      physical: Promise.resolve(),
      cancel: () => {
        slot.abandoned = true
      },
    }
    return slot
  }

  /** Install the physical owner before starting any asynchronous native call. */
  private begin<T>(slot: Slot, work: () => Promise<T>): Promise<T> {
    this.pending = slot
    const joined = Promise.resolve()
      .then(work)
      .finally(() => {
        if (this.pending === slot) this.pending = undefined
      })
    slot.physical = joined.then(
      () => undefined,
      () => undefined,
    )
    return joined
  }

  save(
    raw: RelayCredentialSave,
    context: {
      source: UtilityProcess
      deadlineAt: number
      isCurrent: () => boolean
      write: (input: RelayCredentialWrite) => Promise<SaveResult>
    },
  ): Promise<SaveResult> {
    if (
      this.disposed ||
      this.pending ||
      !context.isCurrent() ||
      !Number.isSafeInteger(context.deadlineAt)
    )
      return Promise.resolve(unavailable())
    const input = relayCredentialSaveSchema.safeParse(raw)
    if (!input.success) return Promise.resolve(unavailable())
    const deadlineAt = Math.min(
      input.data.deadlineAt,
      context.deadlineAt,
      Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS,
    )
    if (deadlineAt <= Date.now()) return Promise.resolve(unavailable())
    const { nonce, expectedRevision } = input.data
    let key = input.data.key
    let written = false
    const slot = this.slot('save', context.source, null)
    const current = () =>
      !this.disposed &&
      !slot.abandoned &&
      !slot.sourceExited &&
      context.isCurrent() &&
      Date.now() < deadlineAt
    return new Promise<SaveResult>((resolve) => {
      let logicalDone = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (result: SaveResult) => {
        if (logicalDone) return
        logicalDone = true
        clearTimeout(timer)
        resolve(result)
      }
      slot.cancel = () => {
        slot.abandoned = true
        key = ''
        settle(written ? uncertain() : unavailable())
      }
      timer = setTimeout(slot.cancel, Math.max(0, deadlineAt - Date.now()))
      timer.unref?.()
      const work = this.begin(slot, async (): Promise<SaveResult> => {
        try {
          if (!current() || !['darwin', 'win32'].includes(process.platform)) return unavailable()
          if (!(await safeStorage.isAsyncEncryptionAvailable()) || !current()) return unavailable()
          const encryption = safeStorage.encryptStringAsync(key)
          key = ''
          const encrypted = await encryption
          if (!current()) return unavailable()
          const write = relayCredentialWriteSchema.parse({
            operation: 'save',
            nonce,
            expectedRevision,
            deadlineAt,
            ciphertext: encodeCiphertext(encrypted),
          })
          if (!current()) return unavailable()
          written = true
          return await context.write(write)
        } catch {
          return written ? uncertain() : unavailable()
        } finally {
          key = ''
        }
      })
      void work.then((result) => settle(result))
    })
  }

  /** Read-only explicit reveal: bounded ciphertext reads bracket one OS decrypt, never a write. */
  reveal(
    raw: RelayCredentialReveal,
    context: {
      source: UtilityProcess
      isCurrent: () => boolean
      read: (input: RelayCredentialReveal) => Promise<RpcResult<RelayCredentialStored>>
    },
  ): Promise<RpcResult<RelayCredentialRevealed>> {
    if (this.disposed || this.pending || !context.isCurrent()) return Promise.resolve(unavailable())
    const input = relayCredentialRevealSchema.safeParse(raw)
    if (!input.success) return Promise.resolve(unavailable())
    const deadlineAt = Math.min(input.data.deadlineAt, Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS)
    if (deadlineAt <= Date.now()) return Promise.resolve(unavailable())
    const { expectedRevision } = input.data
    const slot = this.slot('reveal', context.source, null)
    const current = () =>
      !this.disposed &&
      !slot.abandoned &&
      !slot.sourceExited &&
      context.isCurrent() &&
      Date.now() < deadlineAt
    return new Promise<RpcResult<RelayCredentialRevealed>>((resolve) => {
      let logicalDone = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (result: RpcResult<RelayCredentialRevealed>) => {
        if (logicalDone) return
        logicalDone = true
        clearTimeout(timer)
        resolve(result)
      }
      slot.cancel = () => {
        slot.abandoned = true
        settle(unavailable())
      }
      timer = setTimeout(slot.cancel, Math.max(0, deadlineAt - Date.now()))
      timer.unref?.()
      const readInput: RelayCredentialReveal = { expectedRevision, deadlineAt }
      const work = this.begin(slot, async (): Promise<RpcResult<RelayCredentialRevealed>> => {
        try {
          if (!current() || !['darwin', 'win32'].includes(process.platform)) return unavailable()
          const before = await context.read(readInput)
          if (
            !current() ||
            !before.ok ||
            before.value.revision !== expectedRevision ||
            before.value.ciphertext === null
          )
            return unavailable()
          const stored = before.value
          const ciphertext = stored.ciphertext
          if (ciphertext === null) return unavailable()
          if (!(await safeStorage.isAsyncEncryptionAvailable()) || !current()) return unavailable()
          const opened = await safeStorage.decryptStringAsync(decodeCiphertext(ciphertext))
          if (!current()) return unavailable()
          const key = relayApiKeySchema.parse(opened.result)
          const after = await context.read(readInput)
          if (
            !current() ||
            !after.ok ||
            after.value.revision !== stored.revision ||
            after.value.ciphertext !== ciphertext
          )
            return unavailable()
          return { ok: true, value: { revision: stored.revision, key } }
        } catch {
          return unavailable()
        }
      })
      // Check current again at logical settlement so timeout/dispose cannot return a late key.
      void work.then((result) => settle(current() ? result : unavailable()))
    })
  }

  /** Consume known private packets even when invalid, stale, or from an exited child. */
  receive(source: UtilityProcess, message: unknown, isCurrent: () => boolean): boolean {
    if (!isPrivate(message)) return false
    if (!isCurrent()) return true
    const parsed = relayCryptoMessageSchema.safeParse(message)
    if (!parsed.success) return true
    const packet = parsed.data
    if (Buffer.byteLength(JSON.stringify(packet)) > RELAY_CRYPTO_PACKET_BYTES) return true
    if (packet.type === 'relay.credential.decrypt.cancel') {
      const pending = this.pending
      if (
        pending?.kind === 'decrypt' &&
        pending.source === source &&
        pending.requestId === packet.requestId
      )
        pending.cancel()
      else {
        // No physical operation with this identity remains; a malformed original request
        // also reaches this terminal acknowledgement without creating an OS owner.
        this.reply(source, packet.requestId, { ok: false, reason: 'cancelled' })
      }
      return true
    }
    if (packet.type !== 'relay.credential.decrypt.request') return true
    if (this.pending) {
      // A repeated request must not acknowledge the original operation before it joins.
      if (
        this.pending.kind !== 'decrypt' ||
        this.pending.source !== source ||
        this.pending.requestId !== packet.requestId
      )
        this.reply(source, packet.requestId, { ok: false, reason: 'busy' })
      return true
    }
    if (this.disposed) {
      this.reply(source, packet.requestId, { ok: false, reason: 'unavailable' })
      return true
    }
    const deadlineAt = Math.min(packet.deadlineAt, Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS)
    const slot = this.slot('decrypt', source, packet.requestId)
    const current = () =>
      !this.disposed &&
      !slot.abandoned &&
      !slot.sourceExited &&
      isCurrent() &&
      Date.now() < deadlineAt
    const work = this.begin(slot, async (): Promise<DecryptResult> => {
      try {
        if (!current() || !['darwin', 'win32'].includes(process.platform))
          return { ok: false, reason: 'unavailable' }
        if (!(await safeStorage.isAsyncEncryptionAvailable()) || !current())
          return { ok: false, reason: 'unavailable' }
        const opened = await safeStorage.decryptStringAsync(decodeCiphertext(packet.ciphertext))
        if (!current()) return { ok: false, reason: 'cancelled' }
        const key = relayApiKeySchema.parse(opened.result)
        let replacementCiphertext: string | undefined
        if (opened.shouldReEncrypt) {
          replacementCiphertext = encodeCiphertext(await safeStorage.encryptStringAsync(key))
          if (!current()) return { ok: false, reason: 'cancelled' }
        }
        return { ok: true, key, ...(replacementCiphertext ? { replacementCiphertext } : {}) }
      } catch {
        return { ok: false, reason: slot.abandoned ? 'cancelled' : 'unavailable' }
      }
    })
    void work
      .then((result) => {
        // OS work has actually joined. Cancellation only now acknowledges physical release.
        if (slot.sourceExited || !isCurrent()) return undefined
        return this.reply(
          source,
          packet.requestId,
          current() ? result : { ok: false, reason: 'cancelled' },
        )
      })
      .catch(() => undefined)
    return true
  }

  cancelSource(source: UtilityProcess): void {
    const slot = this.pending
    if (!slot || slot.source !== source) return
    slot.sourceExited = true
    slot.cancel()
  }

  dispose(): void {
    this.disposed = true
    this.pending?.cancel()
    // No early ACK, no cleared physical slot, no inferred release.
  }

  settlement(deadlineMonotonic?: number): Promise<boolean> {
    const slot = this.pending
    if (!slot) return Promise.resolve(true)
    if (deadlineMonotonic === undefined) return slot.physical.then(() => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      slot.physical.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadlineMonotonic - performance.now()))
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  private reply(source: UtilityProcess, requestId: string, result: DecryptResult): void {
    try {
      source.postMessage(
        relayCryptoMessageSchema.parse({
          type: 'relay.credential.decrypt.response',
          requestId,
          result,
        }),
      )
    } catch {
      // No raw OS error/key is emitted. The underlying physical operation is already complete.
    }
  }
}
