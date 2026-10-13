import { AgentExecutionError } from './agent-execution-error'
import { NativeWorkingMemory } from './native-working-memory'

const MAX_ANSWER_ITEMS = 128
const MAX_ANSWER_ITEM_ID_BYTES = 512
const ENCODED_SEPARATOR_BYTES = Buffer.byteLength(JSON.stringify('\n\n'), 'utf8') - 2

interface AnswerItem {
  text: string
  encodedBytes: number
}

/** Merges bounded provider-native assistant items into Pact's one logical visible answer. */
export class AgentAnswerAssembler {
  readonly outputId: string
  private readonly itemOrder: string[] = []
  private readonly items = new Map<string, AnswerItem>()
  private encodedTextBytes = 0
  private nonemptyItems = 0
  private chars = 0
  private readonly working = new NativeWorkingMemory().reserve(0)
  private lastSnapshot: string | undefined

  constructor(runId: string) {
    this.outputId = `${runId}:assistant`
  }

  begin(itemId: string): void {
    if (this.items.has(itemId)) return
    this.assertNewItem(itemId)
    this.itemOrder.push(itemId)
    this.items.set(itemId, { text: '', encodedBytes: 0 })
  }

  append(itemId: string, text: string): string {
    const previous = this.items.get(itemId)
    if (!previous) this.assertNewItem(itemId)
    const previousText = previous?.text ?? ''
    // Count only the incoming fragment, correcting a surrogate pair formed at its seam.
    const seamPair =
      previousText.length > 0 &&
      text.length > 0 &&
      previousText.charCodeAt(previousText.length - 1) >= 0xd800 &&
      previousText.charCodeAt(previousText.length - 1) <= 0xdbff &&
      text.charCodeAt(0) >= 0xdc00 &&
      text.charCodeAt(0) <= 0xdfff
    const nextBytes =
      (previous?.encodedBytes ?? 0) + AgentAnswerAssembler.encodedBytes(text) - (seamPair ? 8 : 0)
    this.admit(
      this.chars + text.length,
      this.encodedTextBytes - (previous?.encodedBytes ?? 0) + nextBytes,
    )
    const nextText = `${previousText}${text}`
    this.assertTotal(previous, nextText, nextBytes)
    if (!previous) this.itemOrder.push(itemId)
    this.items.set(itemId, { text: nextText, encodedBytes: nextBytes })
    const separator = !previousText && text && this.hasEarlierText(itemId) ? '\n\n' : ''
    return `${separator}${text}`
  }

  complete(itemId: string, text: string): string | undefined {
    const previous = this.items.get(itemId)
    if (!previous) this.assertNewItem(itemId)
    const nextBytes = AgentAnswerAssembler.encodedBytes(text)
    this.admit(
      this.chars - (previous?.text.length ?? 0) + text.length,
      this.encodedTextBytes - (previous?.encodedBytes ?? 0) + nextBytes,
    )
    this.assertTotal(previous, text, nextBytes)
    if (!previous) this.itemOrder.push(itemId)
    this.items.set(itemId, { text, encodedBytes: nextBytes })
    const snapshot = this.text
    if (snapshot === this.lastSnapshot) return undefined
    this.lastSnapshot = snapshot
    return snapshot
  }

  finalize(): string | undefined {
    const snapshot = this.text
    if (!snapshot || snapshot === this.lastSnapshot) return undefined
    this.lastSnapshot = snapshot
    return snapshot
  }

  /** A formal final answer supersedes interim assistant commentary. */
  replace(text: string): string {
    this.admit(text.length, AgentAnswerAssembler.encodedBytes(text))
    this.items.clear()
    this.itemOrder.length = 0
    this.encodedTextBytes = 0
    this.nonemptyItems = 0
    this.chars = 0
    this.lastSnapshot = undefined
    this.complete(this.outputId, text)
    return text
  }

  get text(): string {
    return this.itemOrder
      .map((itemId) => this.items.get(itemId)?.text ?? '')
      .filter((text) => text.length > 0)
      .join('\n\n')
  }

  private assertNewItem(itemId: string): void {
    if (this.itemOrder.length >= MAX_ANSWER_ITEMS) this.limitExceeded()
    if (AgentAnswerAssembler.encodedBytes(itemId) > MAX_ANSWER_ITEM_ID_BYTES) this.limitExceeded()
  }

  private assertTotal(
    previous: AnswerItem | undefined,
    nextText: string,
    nextEncodedBytes: number,
  ): void {
    const nextTotal = this.encodedTextBytes - (previous?.encodedBytes ?? 0) + nextEncodedBytes
    const previousNonempty = Number(Boolean(previous?.text))
    const nextNonempty = Number(Boolean(nextText))
    const nonemptyItems = this.nonemptyItems - previousNonempty + nextNonempty
    const renderedBytes = nextTotal + Math.max(0, nonemptyItems - 1) * ENCODED_SEPARATOR_BYTES
    if (!Number.isSafeInteger(renderedBytes)) this.limitExceeded()
    this.chars += nextText.length - (previous?.text.length ?? 0)
    this.encodedTextBytes = nextTotal
    this.nonemptyItems = nonemptyItems
  }

  /** Bound retained items, old/candidate text, snapshots and JSON encoding workspace together. */
  private admit(nextChars: number, nextEncodedBytes: number): void {
    this.working.resize(
      32 * 1024 +
        Math.max(this.chars, nextChars) * 10 +
        Math.max(this.encodedTextBytes, nextEncodedBytes) * 2,
    )
  }

  dispose(): void {
    this.items.clear()
    this.itemOrder.length = 0
    this.lastSnapshot = undefined
    this.working.release()
  }

  [Symbol.dispose](): void {
    this.dispose()
  }

  private hasEarlierText(itemId: string): boolean {
    const itemIndex = this.itemOrder.indexOf(itemId)
    return this.itemOrder
      .slice(0, itemIndex)
      .some((earlierId) => Boolean(this.items.get(earlierId)?.text))
  }

  private static encodedBytes(text: string): number {
    let bytes = 0
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        bytes += 2
      else if (code < 0x20) bytes += 6
      else if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        bytes += 4
        i += 1
      } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
      else bytes += 3
    }
    return bytes
  }

  private limitExceeded(): never {
    throw new AgentExecutionError(
      'response_too_large',
      'The Agent response exceeded the available working capacity.',
      false,
    )
  }
}
