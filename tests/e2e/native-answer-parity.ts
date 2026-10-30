import { createHash } from 'node:crypto'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const facts = (text: string) => ({
  chars: text.length,
  bytes: Buffer.byteLength(text),
  sha256: hash(text),
})

export interface NativeAnswerParityInput {
  nativeSessionId: string
  nativeTurnId: string
  text: string
  markers: string[]
}

/** Strict single-task Codex projection. Returns only bounded comparison facts, never Native text. */
export function nativeAnswerParity(lines: readonly string[], expected: NativeAnswerParityInput) {
  if (lines.length > 10_000 || expected.markers.length > 4)
    throw Error('Native answer diagnostic exceeds its structural bound')
  const sessions = new Set<string>(),
    items = new Map<
      string,
      {
        first: number
        last: number
        phase: string
        text: string
        blocks: Array<ReturnType<typeof facts>>
      }
    >()
  let turn: string | undefined,
    active = false,
    closed = false,
    starts = 0,
    terminals = 0,
    ambiguous = 0,
    unknownBlocks = 0,
    omittedItems = 0,
    blockCount = 0
  for (const [ordinal, line] of lines.entries()) {
    const entry: unknown = JSON.parse(line)
    if (!record(entry) || !record(entry['payload'])) continue
    const payload = entry['payload']
    if (entry['type'] === 'session_meta' && typeof payload['id'] === 'string')
      sessions.add(payload['id'])
    // A new branch is valid only for one canonical task in this entire captured file.
    // Explicit scopes cannot borrow an adjacent task's identity.
    const metadata = payload['internal_chat_message_metadata_passthrough']
    for (const scope of [entry, payload, ...(record(metadata) ? [metadata] : [])]) {
      for (const key of ['turn_id', 'turnId'])
        if (key in scope && scope[key] !== expected.nativeTurnId) ambiguous += 1
      for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId'])
        if (key in scope && scope[key] !== expected.nativeSessionId) ambiguous += 1
    }
    if (entry['type'] === 'turn_context') {
      if (typeof payload['turn_id'] !== 'string' || payload['turn_id'] !== expected.nativeTurnId)
        ambiguous += 1
      turn = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : undefined
    }
    if (entry['type'] === 'event_msg') {
      if (payload['type'] === 'task_started' || payload['type'] === 'turn_started') {
        starts += 1
        if (
          payload['type'] !== 'task_started' ||
          active ||
          closed ||
          payload['turn_id'] !== expected.nativeTurnId
        )
          ambiguous += 1
        turn = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : undefined
        active = true
      }
      if (
        [
          'task_complete',
          'turn_complete',
          'turn_aborted',
          'task_aborted',
          'task_failed',
          'turn_failed',
        ].includes(String(payload['type']))
      ) {
        terminals += 1
        if (
          !active ||
          closed ||
          payload['type'] !== 'task_complete' ||
          payload['turn_id'] !== expected.nativeTurnId ||
          ['error', 'is_error', 'isError', 'aborted', 'interrupted', 'cancelled', 'canceled'].some(
            (key) => payload[key] != null && payload[key] !== false,
          ) ||
          ['status', 'outcome'].some(
            (key) =>
              key in payload &&
              !['completed', 'complete', 'success', 'succeeded'].includes(String(payload[key])),
          )
        )
          ambiguous += 1
        active = false
        closed = true
      }
    }
    if (
      entry['type'] !== 'response_item' ||
      payload['type'] !== 'message' ||
      payload['role'] !== 'assistant' ||
      payload['parent_tool_call_id'] != null
    )
      continue
    if (!active || closed || turn !== expected.nativeTurnId) {
      ambiguous += 1
      continue
    }
    if (!Array.isArray(payload['content'])) {
      unknownBlocks += 1
      continue
    }
    const id = typeof payload['id'] === 'string' ? payload['id'] : `record:${ordinal}`
    if (!items.has(id) && items.size >= 128) {
      omittedItems += 1
      continue
    }
    const text: string[] = [],
      blocks: Array<ReturnType<typeof facts>> = []
    for (const part of payload['content']) {
      blockCount += 1
      if (blockCount > 128) {
        unknownBlocks += 1
        break
      }
      if (!record(part) || part['type'] !== 'output_text' || typeof part['text'] !== 'string') {
        unknownBlocks += 1
        continue
      }
      text.push(part['text'])
      blocks.push(facts(part['text']))
    }
    const previous = items.get(id)
    if (previous && previous.text !== text.join('')) ambiguous += 1
    items.set(id, {
      first: previous?.first ?? ordinal,
      last: ordinal,
      phase: ['commentary', 'final_answer'].includes(String(payload['phase']))
        ? String(payload['phase'])
        : 'unspecified',
      text: text.join(''),
      blocks,
    })
  }
  const nonempty = [...items.entries()].filter(([, item]) => item.text.length > 0),
    joined = nonempty.map(([, item]) => item.text).join('\n\n'),
    native = facts(joined),
    pact = facts(expected.text),
    scoped = sessions.size === 1 && sessions.has(expected.nativeSessionId),
    complete =
      scoped &&
      starts === 1 &&
      terminals === 1 &&
      closed &&
      !active &&
      !ambiguous &&
      !unknownBlocks &&
      !omittedItems
  let prefix = 0,
    suffix = 0,
    offset = 0
  while (
    prefix < Math.min(joined.length, expected.text.length) &&
    joined[prefix] === expected.text[prefix]
  )
    prefix += 1
  while (
    suffix < Math.min(joined.length, expected.text.length) - prefix &&
    joined[joined.length - suffix - 1] === expected.text[expected.text.length - suffix - 1]
  )
    suffix += 1
  return {
    version: 1,
    nativeSessionMatched: scoped,
    targetTurnSha256: hash(expected.nativeTurnId),
    starts,
    terminals,
    ambiguous,
    unknownBlocks,
    omittedItems,
    blockCount,
    completeProjection: complete,
    native,
    pact,
    exactMatch: complete && joined === expected.text,
    commonPrefixChars: prefix,
    commonSuffixChars: suffix,
    markers: expected.markers.map((marker) => ({
      nativeOffset: joined.indexOf(marker),
      pactOffset: expected.text.indexOf(marker),
    })),
    items: nonempty.map(([id, item]) => {
      const startOffset = offset
      offset += item.text.length + 2
      return Object.assign(
        {
          firstOrdinal: item.first,
          lastOrdinal: item.last,
          idSha256: hash(id),
          phase: item.phase,
          startOffset,
          blocks: item.blocks,
        },
        facts(item.text),
      )
    }),
  }
}
