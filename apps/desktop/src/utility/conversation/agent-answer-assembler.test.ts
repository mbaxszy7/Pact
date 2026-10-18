import { describe, expect, it } from 'vitest'

import { AgentAnswerAssembler } from './agent-answer-assembler.js'
import { AgentExecutionError } from './agent-execution-error.js'

describe('AgentAnswerAssembler', () => {
  it('keeps answer text emitted before and after a peer Tool item', () => {
    using assembler = new AgentAnswerAssembler('run-1')
    assembler.append('assistant-1', 'Before the peer Tool.')
    expect(assembler.complete('assistant-1', 'Before the peer Tool.')).toBe('Before the peer Tool.')
    expect(assembler.complete('assistant-2', 'After the peer Tool.')).toBe(
      'Before the peer Tool.\n\nAfter the peer Tool.',
    )
    expect(assembler.finalize()).toBeUndefined()
  })

  it('does not emit duplicate completion snapshots', () => {
    using assembler = new AgentAnswerAssembler('run-1')
    expect(assembler.complete('assistant-1', 'Answer')).toBe('Answer')
    expect(assembler.complete('assistant-1', 'Answer')).toBeUndefined()
    expect(assembler.finalize()).toBeUndefined()
  })

  it('rejects an answer that crosses its bounded item budget', () => {
    using assembler = new AgentAnswerAssembler('run-1')
    for (let index = 0; index < 128; index += 1) assembler.append(`assistant-${index}`, 'Text')
    expect(() => assembler.append('assistant-overflow', 'Overflow')).toThrowError(
      AgentExecutionError,
    )
    expect(assembler.text.split('\n\n')).toHaveLength(128)
  })

  it('does not let empty native items consume answer slots or emit an empty response', () => {
    using assembler = new AgentAnswerAssembler('run-1')
    for (let index = 0; index < 256; index += 1) {
      expect(assembler.append(`empty-${index}`, '')).toBe('')
      expect(assembler.complete(`empty-${index}`, '')).toBeUndefined()
    }
    expect(assembler.finalize()).toBeUndefined()
    expect(assembler.append('answer', 'Final answer')).toBe('Final answer')
    expect(assembler.complete('answer', 'Final answer')).toBe('Final answer')
    expect(assembler.finalize()).toBeUndefined()
  })
})
