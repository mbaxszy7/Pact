import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { createHash } from 'node:crypto'

import { AgentAnswerAssembler } from './agent-answer-assembler'
import { AgentExecutionError } from './agent-execution-error'
import { NativeWorkingMemory } from './native-working-memory'

// Match the existing cold Native record bound; final text items keep the Assembler's 128 limit.
const MAX_NATIVE_RECORDS = 10_000
const MAX_ID_BYTES = 512

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event']
export interface ClaudeTextUpdate {
  delta?: string | undefined
  completed?: string | undefined
}
interface CurrentMessage {
  id: string
  mode: 'stream' | 'frames'
  parts: string[]
  chars: number
  lastBlock: number
  block?: { index: number; receivedChars: number; completed: boolean } | undefined
}

/** One Claude API item can contain multiple independently identified SDK text frames. */
export class ClaudeAnswerAssembler {
  private readonly memory = new NativeWorkingMemory()
  private readonly answer: AgentAnswerAssembler
  private readonly working
  private readonly frames = new Map<string, { apiId: string; hash: string; chars: number }>()
  private readonly messages = new Set<string>()
  private current: CurrentMessage | undefined
  private metadataBytes = 0
  private disposed = false

  constructor(runId: string) {
    this.answer = new AgentAnswerAssembler(runId, this.memory)
    this.working = this.memory.reserve(0)
  }

  get outputId(): string {
    return this.answer.outputId
  }

  get text(): string {
    return this.answer.text
  }

  stream(event: StreamEvent): ClaudeTextUpdate {
    this.requireOpen()
    if (event.type === 'message_start') return { completed: this.begin(event.message.id, 'stream') }
    const current = this.current
    if (event.type === 'content_block_start') {
      if (!current || current.mode !== 'stream') this.invalid()
      if (!Number.isSafeInteger(event.index) || event.index <= current.lastBlock) this.invalid()
      current.lastBlock = event.index
      if (event.content_block.type !== 'text') return {}
      if (current.block) this.invalid()
      const text = event.content_block.text
      current.block = { index: event.index, receivedChars: text.length, completed: false }
      return { delta: this.answer.append(current.id, text) }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (
        !current ||
        current.mode !== 'stream' ||
        current.block?.index !== event.index ||
        current.block.completed
      )
        this.invalid()
      current.block.receivedChars += event.delta.text.length
      return { delta: this.answer.append(current.id, event.delta.text) }
    }
    if (event.type === 'content_block_stop' && current?.block?.index === event.index) {
      if (current.block.receivedChars && !current.block.completed) this.invalid()
      current.block = undefined
    }
    if (event.type === 'message_stop') {
      if (!current || current.mode !== 'stream' || current.block) this.invalid()
      return { completed: this.seal() }
    }
    return {}
  }

  /** Missing text denotes a tool/thinking-only frame and still supplies an API boundary. */
  frame(
    apiId: string,
    frameId: string,
    text: string | undefined,
    textBlocks = 1,
  ): ClaudeTextUpdate {
    this.requireOpen()
    this.requireId(apiId)
    let hash = ''
    if (text !== undefined) {
      this.requireId(frameId)
      this.charge(text.length)
      // UTF-16 identity also distinguishes unpaired surrogates from replacement characters.
      hash = createHash('sha256').update(text, 'utf16le').digest('hex')
      const previous = this.frames.get(frameId)
      if (previous) {
        if (previous.apiId !== apiId || previous.hash !== hash || previous.chars !== text.length)
          this.invalid()
        this.charge()
        return {}
      }
    }
    const completed = this.current?.id === apiId ? undefined : this.begin(apiId, 'frames')
    const current = this.current!
    if (text === undefined) return { completed }
    if (
      current.mode === 'stream' &&
      (!current.block || current.block.completed || textBlocks !== 1)
    )
      this.invalid()
    if (this.frames.size >= MAX_NATIVE_RECORDS) this.tooLarge()
    const nextMetadata = this.metadataBytes + frameId.length * 2 + apiId.length * 2 + 256
    this.charge(text.length, nextMetadata)
    this.frames.set(frameId, {
      apiId,
      hash,
      chars: text.length,
    })
    this.metadataBytes = nextMetadata
    current.parts.push(text)
    current.chars += text.length
    if (current.block) current.block.completed = true
    this.charge()
    return {
      completed,
      delta: current.mode === 'frames' ? this.answer.append(apiId, text) : undefined,
    }
  }

  /** Successful streaming must reach message_stop; interruption retains every received delta. */
  finish(allowPartial: boolean): string | undefined {
    this.requireOpen()
    const current = this.current
    if (!current) return undefined
    if (current.mode === 'stream') {
      if (!allowPartial) this.invalid()
      this.current = undefined
      this.charge()
      return undefined
    }
    return this.seal()
  }

  private seal(): string | undefined {
    const current = this.current!
    const text = current.parts.join('')
    const completed = this.answer.complete(current.id, text)
    this.current = undefined
    this.charge()
    return completed
  }

  /** Result-only fallback remains an authoritative whole item, separate from SDK text frames. */
  complete(id: string, text: string): string | undefined {
    this.finish(false)
    return this.answer.complete(id, text)
  }

  finalize(): string | undefined {
    return this.finish(false) ?? this.answer.finalize()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.current = undefined
    this.frames.clear()
    this.messages.clear()
    this.answer.dispose()
    this.working.release()
  }

  [Symbol.dispose](): void {
    this.dispose()
  }

  private begin(id: string, mode: CurrentMessage['mode']): string | undefined {
    this.requireId(id)
    if (this.current?.mode === 'stream') this.invalid()
    const completed = this.finish(false)
    if (this.messages.has(id)) this.invalid()
    if (this.messages.size >= MAX_NATIVE_RECORDS) this.tooLarge()
    const metadata = this.metadataBytes + id.length * 2 + 128
    this.charge(0, metadata)
    this.messages.add(id)
    this.metadataBytes = metadata
    this.current = { id, mode, parts: [], chars: 0, lastBlock: -1 }
    return completed
  }

  private charge(extraChars = 0, metadataBytes = this.metadataBytes): void {
    // Cover active frame bodies, joining/hash workspace and bounded retained identity metadata.
    this.working.resize(
      32 * 1024 + metadataBytes * 3 + ((this.current?.chars ?? 0) + extraChars) * 8,
    )
  }

  private requireOpen(): void {
    if (this.disposed) this.invalid()
  }

  private requireId(value: string): void {
    if (typeof value !== 'string' || !value) this.invalid()
    if (Buffer.byteLength(value) > MAX_ID_BYTES) this.tooLarge()
  }

  private invalid(): never {
    throw new AgentExecutionError(
      'protocol_error',
      'Claude native text frame identity or ordering is inconsistent. The complete output could not be confirmed.',
      false,
    )
  }

  private tooLarge(): never {
    throw new AgentExecutionError(
      'response_too_large',
      'Claude native text metadata exceeds its existing Native record or identifier budget. No text was truncated.',
      false,
    )
  }
}
