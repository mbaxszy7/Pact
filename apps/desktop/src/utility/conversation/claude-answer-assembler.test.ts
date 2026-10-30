/* oxlint-disable typescript/no-unsafe-type-assertion -- The SDK event fixtures supply the consumed protocol fields. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { AgentAnswerAssembler } from './agent-answer-assembler'
import { ClaudeAnswerAssembler } from './claude-answer-assembler'
import { nativeWorkingMemoryDiagnostics } from './native-working-memory'

type Event = Parameters<ClaudeAnswerAssembler['stream']>[0]
const start = (id: string) => ({ type: 'message_start', message: { id } }) as Event
const block = (index: number, text = '') =>
  ({ type: 'content_block_start', index, content_block: { type: 'text', text } }) as Event
const delta = (index: number, text: string) =>
  ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }) as Event
const stop = (index: number) => ({ type: 'content_block_stop', index }) as Event
const end = { type: 'message_stop' } as Event
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('Claude native text frames', () => {
  it('streams both text blocks before message_stop and joins only different API items with paragraphs', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.stream(start('api-1'))
    answer.stream(block(0))
    expect(answer.stream(delta(0, 'First.')).delta).toBe('First.')
    expect(answer.frame('api-1', 'frame-1', 'First.')).toEqual({
      completed: undefined,
      delta: undefined,
    })
    answer.stream(stop(0))
    answer.stream(block(1))
    expect(answer.stream(delta(1, ' Second.')).delta).toBe(' Second.')
    expect(answer.text).toBe('First. Second.')
    answer.frame('api-1', 'frame-2', ' Second.')
    answer.stream(stop(1))
    answer.frame('api-1', 'tool-frame', undefined, 0)
    expect(answer.stream(end).completed).toBe('First. Second.')
    answer.stream(start('api-2'))
    answer.stream(block(0))
    expect(answer.stream(delta(0, 'Final.')).delta).toBe('\n\nFinal.')
    answer.frame('api-2', 'frame-3', 'Final.')
    answer.stream(stop(0))
    expect(answer.stream(end).completed).toBe('First. Second.\n\nFinal.')
  })

  it('preserves the same complete bytes without partial events and at tool/result boundaries', () => {
    using answer = new ClaudeAnswerAssembler('run')
    expect(answer.frame('api-1', 'frame-1', 'First.').delta).toBe('First.')
    expect(answer.frame('api-1', 'frame-2', ' Second.').delta).toBe(' Second.')
    expect(answer.frame('tool-api', 'tool-frame', undefined, 0).completed).toBe('First. Second.')
    answer.frame('api-2', 'frame-3', 'Final.')
    expect(answer.finish(false)).toBe('First. Second.\n\nFinal.')
    expect(sha(answer.text)).toBe(sha('First. Second.\n\nFinal.'))
  })

  it('is idempotent for an exact frame replay, including after closure, while preserving repeated text in distinct frames', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.frame('api', 'one', 'Repeat.')
    expect(answer.frame('api', 'one', 'Repeat.')).toEqual({})
    answer.frame('api', 'two', 'Repeat.')
    answer.finish(false)
    expect(answer.frame('api', 'one', 'Repeat.')).toEqual({})
    expect(answer.text).toBe('Repeat.Repeat.')
    expect(() => answer.frame('api', 'one', 'Changed.')).toThrow('identity or ordering')
    expect(() => answer.frame('another-api', 'one', 'Repeat.')).toThrow('identity or ordering')
  })

  it('keeps received text through Stop between blocks or during an unfinished block', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.stream(start('api'))
    answer.stream(block(0))
    answer.stream(delta(0, 'First.'))
    answer.frame('api', 'one', 'First.')
    answer.stream(stop(0))
    answer.stream(block(1))
    answer.stream(delta(1, ' Partial second.'))
    answer.finish(true)
    expect(answer.finalize()).toBe('First. Partial second.')
  })

  it('requires a successful streaming API boundary and completed block identities', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.stream(start('api'))
    answer.stream(block(0))
    answer.stream(delta(0, 'Text'))
    expect(() => answer.stream(stop(0))).toThrow('identity or ordering')
    answer.frame('api', 'one', 'Text')
    answer.stream(stop(0))
    expect(() => answer.finish(false)).toThrow('identity or ordering')
    expect(() => answer.stream(start('next-api'))).toThrow('identity or ordering')
  })

  it('preserves UTF-16 seams and does not confuse a surrogate with a replacement character on replay', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.stream(start('api'))
    answer.stream(block(0))
    answer.stream(delta(0, '\ud83d'))
    answer.stream(delta(0, '\ude00'))
    answer.frame('api', 'emoji', '😀')
    answer.stream(stop(0))
    answer.stream(end)
    expect(answer.text).toBe('😀')
    using parts = new ClaudeAnswerAssembler('parts')
    parts.frame('api', 'high', '\ud83d')
    parts.frame('api', 'low', '\ude00')
    expect(parts.finalize()).toBe('😀')
    expect(() => parts.frame('api', 'high', '�')).toThrow('identity or ordering')
  })

  it('leaves whole-item replacement semantics intact for result-only output and Codex', () => {
    using answer = new ClaudeAnswerAssembler('run')
    answer.complete('result', 'Old')
    expect(answer.complete('result', 'New')).toBe('New')
    using codex = new AgentAnswerAssembler('codex')
    codex.complete('same-item', 'Old')
    expect(codex.complete('same-item', 'New')).toBe('New')
  })

  it('charges and releases shared Native working capacity on success and resource refusal', () => {
    const before = nativeWorkingMemoryDiagnostics().chargedBytes
    if (before === null) throw new Error('Native working observations are unavailable')
    const answer = new ClaudeAnswerAssembler('run')
    try {
      answer.frame('api', 'one', 'Retained text')
      expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBeGreaterThan(before)
      expect(() => answer.frame('api', 'large', 'x'.repeat(16 * 1024 * 1024))).toThrow('capacity')
    } finally {
      answer.dispose()
    }
    expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(before)
    answer.dispose()
  })
})
