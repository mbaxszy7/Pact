import { expect, it } from 'vitest'

import { conversationStreamTraceSchema, runtimeHealthSchema, STREAM_TRACE_BYTES } from './index.js'

const trace = () => ({
  runId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  generationSha256: 'e'.repeat(64),
  capturedAfterMs: 600_000,
  state: 'settled',
  nativeBound: true,
  invalid: false,
  outputFailed: false,
  loop: {
    text: Number.MAX_SAFE_INTEGER,
    reasoning: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    foreignThread: Number.MAX_SAFE_INTEGER,
    foreignTurn: Number.MAX_SAFE_INTEGER,
    missingIdentity: Number.MAX_SAFE_INTEGER,
    firstMs: 0,
    lastMs: 600_000,
  },
  normalized: {
    text: Number.MAX_SAFE_INTEGER,
    reasoning: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    current: Number.MAX_SAFE_INTEGER,
    archived: Number.MAX_SAFE_INTEGER,
    lastMs: 600_000,
  },
  publication: {
    attempts: Number.MAX_SAFE_INTEGER,
    suppressed: Number.MAX_SAFE_INTEGER,
    published: Number.MAX_SAFE_INTEGER,
    lastMs: 600_000,
  },
  foregroundBuffer: null,
  archiveBuffer: null,
  transport: {
    queuedMessages: Number.MAX_SAFE_INTEGER,
    queuedInboundBytes: Number.MAX_SAFE_INTEGER,
    stdoutPaused: false,
    open: true,
  },
})
const health = (streamTraces = [trace()]) => ({
  status: 'ready',
  database: 'ready',
  pid: 10,
  checkedAt: new Date().toISOString(),
  conversation: {
    interestedSessions: 1,
    interestedSessionIds: [crypto.randomUUID()],
    streamTraces,
    suppressedProgress: 0,
    publishedProgress: 0,
    activeExecutions: 0,
    completeReads: 0,
  },
})
it('keeps the fixed diagnostic finite, bounded and free of output or native parameters', () => {
  const input = trace()
  expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThanOrEqual(
    STREAM_TRACE_BYTES,
  )
  expect(conversationStreamTraceSchema.safeParse(input).success).toBe(true)
  for (const extra of [
    { text: 'private output' },
    { params: {} },
    { nativeTurnId: 'private-native-id' },
    { generation: crypto.randomUUID() },
  ])
    expect(conversationStreamTraceSchema.safeParse({ ...input, ...extra }).success).toBe(false)
  expect(
    conversationStreamTraceSchema.safeParse({
      ...input,
      loop: { ...input.loop, bytes: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
  ).toBe(false)
})
it('rejects duplicate, excessive and inconsistent health identities while preserving legacy health', () => {
  const base = health(Array.from({ length: 6 }, trace))
  expect(runtimeHealthSchema.safeParse(base).success).toBe(true)
  expect(runtimeHealthSchema.safeParse(health(Array.from({ length: 7 }, trace))).success).toBe(
    false,
  )
  expect(
    runtimeHealthSchema.safeParse(
      health([base.conversation.streamTraces[0]!, base.conversation.streamTraces[0]!]),
    ).success,
  ).toBe(false)
  expect(
    runtimeHealthSchema.safeParse({
      ...base,
      conversation: { ...base.conversation, interestedSessions: 0 },
    }).success,
  ).toBe(false)
  expect(
    runtimeHealthSchema.safeParse({
      ...base,
      conversation: {
        ...base.conversation,
        interestedSessionIds: undefined,
        streamTraces: undefined,
      },
    }).success,
  ).toBe(true)
})
