import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationPatch, NormalizedAgentEvent } from '@pact/contracts'

import {
  CONVERSATION_STREAM_BATCH_BYTES,
  CONVERSATION_STREAM_BATCH_ITEMS,
  conversationPatchSchema,
} from '@pact/contracts'

import {
  AgentStreamBuffer,
  DURABLE_STREAM_INTERVAL_MS,
  VISIBLE_STREAM_INTERVAL_MS,
} from './agent-stream-buffer'

type TextDelta = Extract<NormalizedAgentEvent, { type: 'text.delta' }>
const delta = (text: string): TextDelta => ({
  agentId: 'codex',
  type: 'text.delta',
  turnId: 'turn',
  outputId: 'output',
  text,
})
function patch(): ConversationPatch {
  const sessionId = randomUUID()
  return {
    version: 'conversation-patch-v1',
    sessionId,
    observation: { incarnation: randomUUID(), sequence: 1 },
    session: {
      id: sessionId,
      title: 'Fixture',
      titleSource: 'user',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      updatedAt: new Date().toISOString(),
    },
    messages: [],
    runs: [],
    activities: [],
    activityStates: [],
  }
}
describe('AgentStreamBuffer', () => {
  afterEach(() => vi.useRealTimers())
  it('discards a failed output tail and queued publication without committing it during cleanup', async () => {
    vi.useFakeTimers()
    const commit = vi.fn<(events: readonly NormalizedAgentEvent[]) => ConversationPatch>(() =>
      patch(),
    )
    const publish = vi.fn<(value: ConversationPatch) => void>(),
      onError = vi.fn<(error: unknown) => void>()
    const buffer = new AgentStreamBuffer(commit, publish, onError)
    buffer.push(delta('Committed prefix'))
    await vi.advanceTimersByTimeAsync(DURABLE_STREAM_INTERVAL_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(buffer.diagnostics().publicationItems).toBe(1)
    buffer.push(delta('Unconfirmed tail'))
    buffer.discard()
    buffer.push(delta('Late output'))
    buffer.dispose()
    await vi.advanceTimersByTimeAsync(DURABLE_STREAM_INTERVAL_MS + VISIBLE_STREAM_INTERVAL_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(buffer.diagnostics()).toMatchObject({ pendingItems: 0, publicationItems: 0, timers: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('checkpoints 64 distinct keys before accepting another and releases all timers', () => {
    vi.useFakeTimers()
    const commit = vi.fn<() => ConversationPatch>(() => patch()),
      publish = vi.fn<() => void>(),
      onError = vi.fn<() => void>()
    const buffer = new AgentStreamBuffer(commit, publish, onError)
    for (let index = 0; index <= CONVERSATION_STREAM_BATCH_ITEMS; index++)
      buffer.push({
        agentId: 'codex',
        type: 'reasoning.summary.delta',
        turnId: 'turn',
        activityId: `activity-${index}`,
        text: 'step',
      })
    expect(commit.mock.calls).toHaveLength(1)
    expect(buffer.diagnostics()).toMatchObject({
      pendingItems: 1,
      capacityCommits: 1,
      publicationItems: 1,
    })
    expect(buffer.dispose()).toBe(true)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    expect(buffer.diagnostics()).toMatchObject({ pendingItems: 0, publicationItems: 0, timers: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('counts JSON escaping and UTF-8 at the byte boundary without losing text', () => {
    vi.useFakeTimers()
    const events: NormalizedAgentEvent[] = []
    const buffer = new AgentStreamBuffer(
      (batch) => {
        events.push(...batch)
        return patch()
      },
      vi.fn<() => void>(),
      vi.fn<() => void>(),
    )
    const metadataBytes = Buffer.byteLength(JSON.stringify(delta('')))
    const text = '"'.repeat(100_000) + '😀'.repeat(50_000)
    const escapedBytes = Buffer.byteLength(JSON.stringify(text)) - 2
    const fitting =
      text + 'a'.repeat(CONVERSATION_STREAM_BATCH_BYTES - metadataBytes - escapedBytes - 2)
    buffer.push(delta(fitting))
    expect(buffer.diagnostics().pendingBytes).toBe(CONVERSATION_STREAM_BATCH_BYTES)
    buffer.push(delta('tail'))
    expect(buffer.diagnostics().capacityCommits).toBe(1)
    buffer.dispose()
    expect(events).toEqual([delta(fitting), delta('tail')])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('segments a large Delta without losing its preceding tail or exceeding a batch', () => {
    vi.useFakeTimers()
    const events: NormalizedAgentEvent[] = []
    const commit = vi.fn<(batch: readonly NormalizedAgentEvent[]) => ConversationPatch>((batch) => {
        expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
          CONVERSATION_STREAM_BATCH_BYTES,
        )
        for (const text of batch.flatMap((event) => ('text' in event ? [event.text] : []))) {
          expect(text).not.toMatch(/[\ud800-\udbff]$/u)
          expect(text).not.toMatch(/^[\udc00-\udfff]/u)
        }
        events.push(...batch)
        return patch()
      }),
      publish = vi.fn<() => void>(),
      onError = vi.fn<() => void>()
    const buffer = new AgentStreamBuffer(commit, publish, onError)
    buffer.push(delta('saved tail'))
    const text = '😀"'.repeat(CONVERSATION_STREAM_BATCH_BYTES / 2)
    buffer.push(delta(text))
    expect(buffer.dispose()).toBe(true)
    expect(events.map((event) => ('text' in event ? event.text : '')).join('')).toBe(
      'saved tail' + text,
    )
    expect(commit.mock.calls.length).toBeGreaterThan(1)
    expect(publish).toHaveBeenCalledTimes(commit.mock.calls.length)
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['items', 'bytes'] as const)(
    'drains committed Patches before exceeding the %s budget',
    (budget) => {
      vi.useFakeTimers()
      const value = patch()
      if (budget === 'bytes')
        value.messages = Array.from({ length: 4 }, (_, sequence) => ({
          mode: 'replace',
          text: 'a'.repeat(15 * 1024),
          hasActivities: false,
          hasComments: false,
          message: {
            id: randomUUID(),
            sessionId: value.sessionId,
            role: 'assistant',
            agentId: 'codex',
            contentRevision: 0,
            state: 'streaming',
            sequence,
            createdAt: value.session.updatedAt,
            updatedAt: value.session.updatedAt,
          },
        }))
      conversationPatchSchema.parse(value)
      const retained =
        budget === 'items'
          ? CONVERSATION_STREAM_BATCH_ITEMS
          : Math.floor(CONVERSATION_STREAM_BATCH_BYTES / Buffer.byteLength(JSON.stringify(value)))
      const publish = vi.fn<() => void>(),
        onError = vi.fn<() => void>()
      const buffer = new AgentStreamBuffer(() => value, publish, onError)
      for (let index = 0; index <= (retained + 1) * CONVERSATION_STREAM_BATCH_ITEMS; index++)
        buffer.push({
          agentId: 'codex',
          type: 'reasoning.summary.delta',
          turnId: 'turn',
          activityId: `activity-${index}`,
          text: 'step',
        })
      expect(publish).toHaveBeenCalledTimes(retained)
      expect(buffer.diagnostics().publicationItems).toBe(1)
      expect(buffer.diagnostics().publicationBytes).toBeLessThanOrEqual(
        CONVERSATION_STREAM_BATCH_BYTES,
      )
      buffer.dispose()
      expect(onError).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )
  it('settles publication failure once without escaping the timer or accepting more data', () => {
    vi.useFakeTimers()
    const failure = new Error('Publish failed'),
      onError = vi.fn<() => void>(),
      commit = vi.fn<() => ConversationPatch>(() => patch())
    const buffer = new AgentStreamBuffer(
      commit,
      () => {
        throw failure
      },
      onError,
    )
    buffer.push(delta('committed'))
    expect(() =>
      vi.advanceTimersByTime(DURABLE_STREAM_INTERVAL_MS + VISIBLE_STREAM_INTERVAL_MS),
    ).not.toThrow()
    buffer.push(delta('must not commit'))
    expect(commit).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(buffer.dispose()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('commits coalesced UTF-8 text before publishing and does not extend the durable deadline', () => {
    vi.useFakeTimers()
    const commit = vi.fn<(events: readonly NormalizedAgentEvent[]) => ConversationPatch>(() =>
      patch(),
    )
    const publish = vi.fn<(value: ConversationPatch) => void>(),
      error = vi.fn<(error: unknown) => void>()
    const buffer = new AgentStreamBuffer(commit, publish, error)
    buffer.push(delta('😀'.repeat(3000)))
    vi.advanceTimersByTime(200)
    buffer.push(delta('界'.repeat(2000)))
    vi.advanceTimersByTime(DURABLE_STREAM_INTERVAL_MS - 200)
    expect(commit).toHaveBeenCalledExactlyOnceWith([delta('😀'.repeat(3000) + '界'.repeat(2000))])
    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(VISIBLE_STREAM_INTERVAL_MS)
    expect(publish).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    buffer.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('commits at most four periodic transactions per second', () => {
    vi.useFakeTimers()
    const commit = vi.fn<() => ConversationPatch>(() => patch())
    const buffer = new AgentStreamBuffer(
      commit,
      vi.fn<(value: ConversationPatch) => void>(),
      vi.fn<(error: unknown) => void>(),
    )
    for (let index = 0; index < 6_000; index++) {
      buffer.push(delta('a'))
      vi.advanceTimersByTime(10)
    }
    expect(commit).toHaveBeenCalledTimes(240)
    expect(buffer.diagnostics().periodicCommits).toBe(240)
    buffer.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('flushes the pending tail immediately on close and publishes only committed data', () => {
    vi.useFakeTimers()
    const order: string[] = []
    const buffer = new AgentStreamBuffer(
      () => {
        order.push('commit')
        return patch()
      },
      () => {
        order.push('publish')
      },
      vi.fn<(error: unknown) => void>(),
    )
    buffer.push(delta('tail'))
    expect(buffer.dispose()).toBe(true)
    expect(order).toEqual(['commit', 'publish'])
    expect(buffer.diagnostics()).toMatchObject({ pendingItems: 0, publicationItems: 0, timers: 0 })
  })
  it('settles commit failures without throwing from a timer or publishing success', () => {
    vi.useFakeTimers()
    const failure = new Error('Commit failed'),
      onError = vi.fn<(error: unknown) => void>(),
      publish = vi.fn<(value: ConversationPatch) => void>()
    const buffer = new AgentStreamBuffer(
      () => {
        throw failure
      },
      publish,
      onError,
    )
    buffer.push(delta('hello'))
    expect(() => vi.advanceTimersByTime(DURABLE_STREAM_INTERVAL_MS)).not.toThrow()
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(publish).not.toHaveBeenCalled()
    expect(buffer.dispose()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
