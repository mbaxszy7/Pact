/** Editor work and inverse history are operation budgets, independent of the Send text schema. */
export const COMPOSER_EDIT_WORK_BYTES = 32 * 1024 * 1024
export const COMPOSER_HISTORY_BYTES = 1024 * 1024
export const COMPOSER_DRAFT_BYTES = 128 * 1024 * 1024
export const COMPOSER_DRAFT_ITEMS = 512
const EDIT_METADATA_RESERVE = 128 * 1024

function lines(text: string): number {
  let count = 1
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 0x0a) count += 1
  return count
}

/** Check before building the next document; retain the current document on capacity failure. */
export function assertComposerEditCapacity(
  before: string,
  start: number,
  end: number,
  incoming: string,
): void {
  const nextChars = before.length - (end - start) + incoming.length
  assertComposerEditLengths(before.length, nextChars, incoming.length, end - start)
  const work = composerEditWorkBytes(before.length, nextChars, incoming.length, end - start)
  if (work + (lines(before) + lines(incoming)) * 128 > COMPOSER_EDIT_WORK_BYTES)
    throw new Error('This edit needs too much layout work. Your draft was kept.')
}

function composerEditWorkBytes(
  beforeChars: number,
  nextChars: number,
  incomingChars: number,
  deletedChars: number,
): number {
  return (beforeChars + nextChars) * 64 + (incomingChars + deletedChars) * 2 + EDIT_METADATA_RESERVE
}

export function assertComposerEditLengths(
  beforeChars: number,
  nextChars: number,
  incomingChars = nextChars,
  deletedChars = beforeChars,
): void {
  const work = composerEditWorkBytes(beforeChars, nextChars, incomingChars, deletedChars)
  if (!Number.isSafeInteger(nextChars) || nextChars < 0 || work > COMPOSER_EDIT_WORK_BYTES)
    throw new Error('This edit needs too much working memory. Your draft was kept.')
}

/** Exact JSON string payload bytes, without allocating a complete escaped string or Buffer. */
export function composerEncodedTextBytes(text: string, start = 0, end = text.length): number {
  let bytes = 0
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) bytes += 2
    else if (code < 0x20) bytes += 6
    else if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (index + 1 < end && low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}

export function assertComposerInverseCapacity(deleted: string, inserted: string): void {
  if (
    composerEncodedTextBytes(deleted) + composerEncodedTextBytes(inserted) + 64 * 1024 >
    COMPOSER_HISTORY_BYTES
  )
    throw new Error('This edit is too large to undo safely. Your draft was kept.')
}

/** Range form checks the deleted text before creating an inverse string. */
export function assertComposerReplacementCapacity(
  before: string,
  start: number,
  end: number,
  incoming: string,
): void {
  assertComposerEditCapacity(before, start, end, incoming)
  if (
    composerEncodedTextBytes(before, start, end) + composerEncodedTextBytes(incoming) + 64 * 1024 >
    COMPOSER_HISTORY_BYTES
  )
    throw new Error('This edit is too large to undo safely. Your draft was kept.')
}
