import { z } from 'zod'

export const STREAM_TRACE_BYTES = 2048
export const STREAM_TRACE_TTL_MS = 600_000
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const elapsed = z.number().int().nonnegative().max(STREAM_TRACE_TTL_MS).nullable()
const buffer = z.strictObject({
  pendingItems: count,
  pendingBytes: count,
  publicationItems: count,
  publicationBytes: count,
  timers: z.number().int().min(0).max(2),
  periodicCommits: count,
  capacityCommits: count,
  forcedCommits: count,
})

/** Bounded counters only. A loop observation is downstream of Connection listeners. */
export interface NativeLoopDeltaObservation {
  kind: 'text' | 'reasoning'
  identity: 'matched' | 'foreign_thread' | 'foreign_turn' | 'missing_identity'
  bytes: number
}

export const conversationStreamTraceSchema = z
  .strictObject({
    runId: z.string().uuid(),
    sessionId: z.string().uuid(),
    generationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capturedAfterMs: z.number().int().min(0).max(STREAM_TRACE_TTL_MS),
    state: z.enum(['active', 'settled', 'retired', 'disposed']),
    nativeBound: z.boolean(),
    invalid: z.boolean(),
    outputFailed: z.boolean(),
    loop: z.strictObject({
      text: count,
      reasoning: count,
      bytes: count,
      foreignThread: count,
      foreignTurn: count,
      missingIdentity: count,
      firstMs: elapsed,
      lastMs: elapsed,
    }),
    normalized: z.strictObject({
      text: count,
      reasoning: count,
      bytes: count,
      current: count,
      archived: count,
      lastMs: elapsed,
    }),
    publication: z.strictObject({
      attempts: count,
      suppressed: count,
      published: count,
      lastMs: elapsed,
    }),
    foregroundBuffer: buffer.nullable(),
    archiveBuffer: buffer.nullable(),
    transport: z
      .strictObject({
        queuedMessages: count,
        queuedInboundBytes: count,
        stdoutPaused: z.boolean(),
        open: z.boolean(),
      })
      .nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= STREAM_TRACE_BYTES,
    'The complete stream diagnostic exceeds its serialized budget.',
  )
export type ConversationStreamTrace = z.infer<typeof conversationStreamTraceSchema>
