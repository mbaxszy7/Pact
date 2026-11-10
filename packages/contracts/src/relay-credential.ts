import { z } from 'zod'

export const RELAY_KEY_BYTES = 4096
export const RELAY_CIPHERTEXT_BYTES = 8192
export const RELAY_CREDENTIAL_TIMEOUT_MS = 5_000

/** Non-empty ASCII-visible key; controls, space and newlines are rejected, no prefix assumptions. */
export const relayApiKeySchema = z
  .string()
  .min(1)
  .max(RELAY_KEY_BYTES)
  .regex(/^[!-~]+$/u)
export type RelayApiKey = z.infer<typeof relayApiKeySchema>

/** Canonical base64 OS ciphertext; native consumers additionally enforce the 8192-byte bound. */
export const relayCiphertextSchema = z
  .string()
  .min(4)
  .max(10924)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
export type RelayCiphertext = z.infer<typeof relayCiphertextSchema>

export const relayCredentialSaveSchema = z.strictObject({
  nonce: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  key: relayApiKeySchema,
})
export type RelayCredentialSave = z.infer<typeof relayCredentialSaveSchema>
export const relayCredentialRemoveSchema = z.strictObject({
  nonce: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export type RelayCredentialRemove = z.infer<typeof relayCredentialRemoveSchema>
export const relayCredentialReceiptReadSchema = z.strictObject({ nonce: z.string().uuid() })
export type RelayCredentialReceiptRead = z.infer<typeof relayCredentialReceiptReadSchema>
export const relayCredentialRevealSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export type RelayCredentialReveal = z.infer<typeof relayCredentialRevealSchema>
export const relayCredentialStoredSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ciphertext: relayCiphertextSchema.nullable(),
})
export type RelayCredentialStored = z.infer<typeof relayCredentialStoredSchema>
export const relayCredentialRevealedSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  key: relayApiKeySchema,
})
export type RelayCredentialRevealed = z.infer<typeof relayCredentialRevealedSchema>
export const relayCredentialReceiptSchema = z.strictObject({
  nonce: z.string().uuid(),
  operation: z.enum(['save', 'remove']),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  configured: z.boolean(),
})
export type RelayCredentialReceipt = z.infer<typeof relayCredentialReceiptSchema>

/** Utility-only encrypted write; the plaintext key never crosses this boundary. */
export const relayCredentialWriteSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('save'),
    nonce: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ciphertext: relayCiphertextSchema,
  }),
  z.strictObject({
    operation: z.literal('remove'),
    nonce: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
])
export type RelayCredentialWrite = z.infer<typeof relayCredentialWriteSchema>

export const RELAY_CRYPTO_PACKET_BYTES = 32 * 1024
/** Private Main↔Utility crypto protocol; never a renderer or generic diagnostic payload. */
export const relayCryptoMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('relay.credential.decrypt.request'),
    requestId: z.string().uuid(),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ciphertext: relayCiphertextSchema,
  }),
  z.strictObject({
    type: z.literal('relay.credential.decrypt.cancel'),
    requestId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('relay.credential.decrypt.response'),
    requestId: z.string().uuid(),
    result: z.discriminatedUnion('ok', [
      z.strictObject({
        ok: z.literal(true),
        key: relayApiKeySchema,
        replacementCiphertext: relayCiphertextSchema.optional(),
      }),
      z.strictObject({
        ok: z.literal(false),
        reason: z.enum(['unavailable', 'cancelled', 'busy']),
      }),
    ]),
  }),
])
export type RelayCryptoMessage = z.infer<typeof relayCryptoMessageSchema>
