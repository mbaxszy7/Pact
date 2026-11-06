import { randomUUID } from 'node:crypto'

import {
  relayCiphertextSchema,
  relayCryptoMessageSchema,
  RELAY_CIPHERTEXT_BYTES,
  RELAY_CREDENTIAL_TIMEOUT_MS,
  RELAY_CRYPTO_PACKET_BYTES,
} from '@pact/contracts'

type Opened = { key: string; replacementCiphertext?: string }
type Pending = {
  requestId: string
  deadlineAt: number
  signal: AbortSignal
  abort: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  abandoned: boolean
  cancelSent: boolean
  resolve: (value: Opened | null) => void
}

export class UtilityRelayCredentialClient {
  private pending: Pending | undefined
  private disposed = false
  constructor(private readonly parent: { postMessage(message: unknown): void }) {}

  decrypt(
    ciphertext: string,
    context: { signal: AbortSignal; deadlineAt: number },
  ): Promise<Opened | null> {
    if (this.disposed || this.pending || context.signal.aborted) return Promise.resolve(null)
    const parsed = relayCiphertextSchema.safeParse(ciphertext)
    if (!parsed.success) return Promise.resolve(null)
    const decoded = Buffer.from(parsed.data, 'base64')
    if (
      decoded.length === 0 ||
      decoded.length > RELAY_CIPHERTEXT_BYTES ||
      decoded.toString('base64') !== parsed.data
    )
      return Promise.resolve(null)
    const deadlineAt = Math.min(context.deadlineAt, Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS)
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) return Promise.resolve(null)
    const requestId = randomUUID()
    return new Promise<Opened | null>((resolve) => {
      const pending: Pending = {
        requestId,
        deadlineAt,
        signal: context.signal,
        abort: () => this.abandon(pending),
        timer: undefined,
        abandoned: false,
        cancelSent: false,
        resolve,
      }
      this.pending = pending
      pending.timer = setTimeout(pending.abort, Math.max(0, deadlineAt - Date.now()))
      pending.timer.unref?.()
      context.signal.addEventListener('abort', pending.abort, { once: true })
      try {
        this.parent.postMessage(
          relayCryptoMessageSchema.parse({
            type: 'relay.credential.decrypt.request',
            requestId,
            deadlineAt,
            ciphertext: parsed.data,
          }),
        )
      } catch {
        // Transport failure is not evidence of OS completion after possibly escaped delivery.
        this.abandon(pending)
      }
    })
  }

  private abandon(pending: Pending): void {
    if (this.pending !== pending) return
    pending.abandoned = true
    this.removeLogicalWaits(pending)
    if (pending.cancelSent) return
    pending.cancelSent = true
    try {
      this.parent.postMessage({
        type: 'relay.credential.decrypt.cancel',
        requestId: pending.requestId,
      })
    } catch {
      // Physical ownership stays unresolved; never create a second decrypt or retry.
    }
  }

  private removeLogicalWaits(pending: Pending): void {
    clearTimeout(pending.timer)
    pending.timer = undefined
    pending.signal.removeEventListener('abort', pending.abort)
  }

  consume(message: unknown): boolean {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      typeof message.type !== 'string' ||
      !message.type.startsWith('relay.credential.decrypt.')
    )
      return false
    const parsed = relayCryptoMessageSchema.safeParse(message)
    if (!parsed.success || parsed.data.type !== 'relay.credential.decrypt.response') return true
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > RELAY_CRYPTO_PACKET_BYTES) return true
    const pending = this.pending,
      response = parsed.data
    if (!pending || pending.requestId !== response.requestId) return true
    const current =
      !this.disposed &&
      !pending.abandoned &&
      !pending.signal.aborted &&
      Date.now() < pending.deadlineAt
    this.pending = undefined
    this.removeLogicalWaits(pending)
    pending.resolve(
      current && response.result.ok
        ? {
            key: response.result.key,
            ...(response.result.replacementCiphertext
              ? { replacementCiphertext: response.result.replacementCiphertext }
              : {}),
          }
        : null,
    )
    return true
  }

  dispose(): void {
    this.disposed = true
    if (this.pending) this.abandon(this.pending)
  }
}
