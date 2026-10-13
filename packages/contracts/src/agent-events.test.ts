import { describe, expect, it } from 'vitest'

import { normalizedAgentEventSchema, sessionTitleInputSchema } from './agent-events.js'

it('accepts only bounded title metadata, never a Session selector or host adoption witness', () => {
  expect(sessionTitleInputSchema.parse({ title: '  可靠取消与任务协作  ' })).toEqual({
    title: '可靠取消与任务协作',
  })
  for (const input of [
    { title: '' },
    { title: 'x'.repeat(121) },
    { title: 'line\nline' },
    { title: '[Pact] derived name' },
    { title: 'Title', sessionId: 'foreign' },
    { title: 'Title', titleAdopted: true },
  ])
    expect(sessionTitleInputSchema.safeParse(input).success).toBe(false)
  expect(
    normalizedAgentEventSchema.safeParse({
      agentId: 'codex',
      type: 'session.title.updated',
      title: 'Title',
      origin: 'turn_result',
      titleAdopted: true,
    }).success,
  ).toBe(false)
})

describe('NormalizedAgentEvent', () => {
  it.each([
    { agentId: 'codex', type: 'session.started', nativeSessionId: 'thr_123' },
    { agentId: 'codex', type: 'turn.started', turnId: 'turn_456' },
    {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'turn_456',
      outputId: 'item_789',
      text: 'Draft',
    },
    {
      agentId: 'codex',
      type: 'text.completed',
      turnId: 'turn_456',
      outputId: 'item_789',
      text: 'Final answer',
    },
    {
      agentId: 'claude',
      type: 'interaction.requested',
      turnId: 'local-turn-1',
      requestId: 'tool-use-1',
      category: 'question',
    },
    {
      agentId: 'claude',
      type: 'run.model.resolved',
      model: 'kimi-k2.5',
      effort: 'high',
    },
    { agentId: 'claude', type: 'turn.completed', turnId: 'local-turn-1', outcome: 'completed' },
    { agentId: 'codex', type: 'unrecognized', nativeType: 'future/notification' },
  ])('accepts the minimal Pact fact %s', (event) => {
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true)
  })

  it('accepts an unrecognized native type without a nonexistent Journal reference', () => {
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'claude',
        type: 'unrecognized',
        nativeType: 'new_sdk_event',
      }).success,
    ).toBe(true)
  })

  it('rejects raw payloads and malformed Pact facts without guessing a replacement', () => {
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'codex',
        type: 'unrecognized',
        nativeType: 'future/notification',
        rawPayload: { authorization: 'sensitive' },
      }).success,
    ).toBe(false)
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'codex',
        type: 'text.delta',
        turnId: 'turn_456',
        outputId: '',
        text: 'hello',
      }).success,
    ).toBe(false)
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'claude',
        type: 'interaction.requested',
        turnId: 'local-turn-1',
        requestId: 'tool-use-1',
        category: 'unsupported',
      }).success,
    ).toBe(false)
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'codex',
        type: 'interaction.requested',
        turnId: 'turn_456',
        requestId: 'request-1',
        category: 'approval',
        summary: 'A display sentence is not a shared native field',
      }).success,
    ).toBe(false)
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'claude',
        type: 'run.model.resolved',
        model: ' ',
      }).success,
    ).toBe(false)
    expect(
      normalizedAgentEventSchema.safeParse({
        agentId: 'claude',
        type: 'run.model.resolved',
        model: 'kimi-k2.5',
        effort: '',
      }).success,
    ).toBe(false)
  })
})
