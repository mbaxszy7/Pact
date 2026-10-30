import type { ConversationSendInput, RuntimeAgentId, SkillSelection } from '@pact/contracts'

import { parseComposerCommandPrefix } from '@pact/contracts'

import { assertComposerEditLengths, assertComposerReplacementCapacity } from './composer-capacity'

/** Returned routes retain their kind and frozen targets; primary without a target resets routing. */
export type ComposerRoute =
  | { type: 'primary'; agentId?: RuntimeAgentId }
  | { type: 'agent'; agentId: RuntimeAgentId }
  | { type: 'all'; firstAgentId?: RuntimeAgentId; secondAgentId?: RuntimeAgentId }

export interface ComposerMention {
  route: NonNullable<ConversationSendInput['route']>
  token: '@claude' | '@codex' | '@all'
  start: number
  end: number
}
export interface ComposerDocument {
  text: string
  skills: SkillSelection[]
  returnedInputOperationId?: string | undefined
  mention?: ComposerMention | undefined
  route?: ComposerRoute | undefined
}
export interface ComposerRange {
  start: number
  end: number
}
export interface ComposerReplacement extends ComposerRange {
  text: string
}

export function releaseComposerRoute(route: ComposerRoute | undefined): ComposerRoute | undefined {
  return route?.type === 'primary'
    ? { type: 'primary' }
    : route?.type === 'all'
      ? { type: 'all' }
      : route
}

/** Preserve the user's original routing facts before a default Primary is resolved. */
export function composerRouteIntent(
  value: Pick<
    ComposerDocument,
    'text' | 'skills' | 'mention' | 'route' | 'returnedInputOperationId'
  > & {
    queueReturnOperationId?: string | undefined
  },
): NonNullable<ConversationSendInput['routeIntent']> {
  if (
    value.route ||
    value.mention ||
    value.returnedInputOperationId ||
    value.queueReturnOperationId
  )
    return 'explicit'
  const prefix = parseComposerCommandPrefix(value.text, value.skills)
  return prefix.error || prefix.pact || prefix.route || prefix.skills.length || value.skills.length
    ? 'explicit'
    : 'implicit'
}

/** One edit transforms all canonical range facts together, never the displayed chip text. */
export function replaceComposerDocument(
  value: ComposerDocument,
  edit: ComposerReplacement,
): ComposerDocument {
  assertComposerReplacementCapacity(value.text, edit.start, edit.end, edit.text)
  const text = value.text.slice(0, edit.start) + edit.text + value.text.slice(edit.end)
  const delta = edit.text.length - (edit.end - edit.start)
  const shift = <T extends ComposerRange>(entry: T): T | undefined => {
    if (edit.end <= entry.start)
      return { ...entry, start: entry.start + delta, end: entry.end + delta }
    if (edit.start < entry.end && edit.end > entry.start) return undefined
    return entry
  }
  const mention = value.mention ? shift(value.mention) : undefined
  return {
    ...value,
    text,
    skills: value.skills.flatMap((entry) => {
      const next = shift(entry)
      return next ? [next] : []
    }),
    mention,
    route:
      (value.mention && !mention) || (edit.start === 0 && edit.end === value.text.length)
        ? value.route
          ? { type: 'primary' }
          : undefined
        : value.route,
  }
}

/** Validation and Send derive from the same route facts, including returned-input provenance. */
export function resolveComposerRoute(
  value: Pick<
    ComposerDocument,
    'text' | 'skills' | 'mention' | 'route' | 'returnedInputOperationId'
  >,
  primaryAgentId: RuntimeAgentId,
): {
  route: ComposerRoute
  targets: RuntimeAgentId[]
  sendRoute: ConversationSendInput['route']
} {
  const requested =
    value.mention?.route ?? parseComposerCommandPrefix(value.text, value.skills).route
  const stored = value.returnedInputOperationId ? value.route : releaseComposerRoute(value.route)
  const keepsStored =
    stored &&
    (!requested ||
      (stored.type === requested.type &&
        (stored.type !== 'agent' ||
          (requested.type === 'agent' && stored.agentId === requested.agentId))))
  const route: ComposerRoute = keepsStored ? stored : (requested ?? stored ?? { type: 'primary' })
  const secondaryAgentId = primaryAgentId === 'codex' ? 'claude' : 'codex'
  const targets: RuntimeAgentId[] =
    route.type === 'all'
      ? route.firstAgentId && route.secondAgentId
        ? [route.firstAgentId, route.secondAgentId]
        : [primaryAgentId, secondaryAgentId]
      : [route.agentId ?? primaryAgentId]
  // Undefined restores the complete original route through the retained returned-input receipt.
  const sendRoute =
    route.type === 'all'
      ? route.firstAgentId && route.secondAgentId
        ? undefined
        : { type: 'all' as const }
      : route.type === 'primary'
        ? route.agentId
          ? undefined
          : { type: 'primary' as const }
        : { type: 'agent' as const, agentId: route.agentId }
  return { route, targets, sendRoute }
}

export function composerDifference(before: string, after: string): ComposerReplacement {
  let start = 0,
    suffix = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) }
}

export function wholeComposerAtoms(value: ComposerDocument, range: ComposerRange): ComposerRange {
  const next = { ...range }
  for (const skill of value.skills) {
    if (next.start < skill.end && next.end > skill.start) {
      next.start = Math.min(next.start, skill.start)
      next.end = Math.max(next.end, skill.end)
    }
  }
  return next
}

export function sameComposerDocument(a: ComposerDocument, b: ComposerDocument): boolean {
  return (
    a.text === b.text &&
    JSON.stringify(a.skills) === JSON.stringify(b.skills) &&
    JSON.stringify(a.mention) === JSON.stringify(b.mention) &&
    a.returnedInputOperationId === b.returnedInputOperationId &&
    JSON.stringify(a.route) === JSON.stringify(b.route)
  )
}

export const COMPOSER_LIST_ITEMS = 1_024
const COMPOSER_INDEX_ROWS = 2_048
const COMPOSER_INDEX_BYTES = 128 * 1_024
const listEncoder = new TextEncoder()

export interface ComposerRow {
  start: number
  contentStart: number
  end: number
  depth?: 0 | 1
  group?: number
  parent?: number
  orphanPrefixEnd?: number
}
export interface ComposerListGroup {
  start: number
  end: number
  startNumber: string
}
export interface ComposerListIndex {
  rows: ComposerRow[]
  groups: ComposerListGroup[]
  itemCount: number
}
export interface ComposerEditResult {
  document: ComposerDocument
  selection: ComposerRange
}

/** A bounded, disposable index. Original text is never changed by reading or projecting it. */
export function indexComposerLists(text: string): ComposerListIndex {
  if (text.length > 100_000) throw new Error('This draft exceeds the list projection capacity.')
  const rows: ComposerRow[] = [],
    groups: ComposerListGroup[] = []
  let start = 0,
    group: number | undefined,
    parent: number | undefined,
    fence = '',
    items = 0,
    overflow = false
  while (start <= text.length) {
    if (rows.length >= COMPOSER_INDEX_ROWS) overflow = true
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(start, end)
    const boundary = /^\s*(`{3,}|~{3,})/u.exec(line)
    const protectedLine = Boolean(fence || boundary)
    if (boundary) {
      if (!fence) fence = boundary[1]![0]!
      else if (fence === boundary[1]![0]) fence = ''
    }
    const numeric = protectedLine ? null : /^(\d+)\.[ \t]/u.exec(line)
    const number = numeric?.[1]?.replace(/^0+/u, '')
    const alpha = protectedLine ? null : /^(?: {2,4}|\t)([a-z]+)\.[ \t]/u.exec(line)
    const row: ComposerRow = { start, contentStart: start, end }
    if (numeric && number) {
      if (group === undefined) {
        group = groups.length
        groups.push({ start, end, startNumber: number })
      }
      row.contentStart = start + numeric[0].length
      row.depth = 0
      row.group = group
      parent = rows.length
    } else if (alpha && group !== undefined && parent !== undefined) {
      row.contentStart = start + alpha[0].length
      row.depth = 1
      row.group = group
      row.parent = parent
    } else {
      if (alpha) row.orphanPrefixEnd = start + alpha[0].length
      group = undefined
      parent = undefined
    }
    if (row.group !== undefined) {
      if (++items > COMPOSER_LIST_ITEMS)
        throw new Error('A draft can contain up to 1,024 list items.')
      groups[row.group]!.end = end
    }
    if (!overflow) rows.push(row)
    if (newline < 0) break
    start = newline + 1
  }
  if (overflow && groups.length) throw new Error('This draft exceeds the list formatting capacity.')
  const result = {
    rows: overflow ? [{ start: 0, contentStart: 0, end: text.length }] : rows,
    groups,
    itemCount: items,
  }
  if (listEncoder.encode(JSON.stringify(result)).byteLength > COMPOSER_INDEX_BYTES)
    throw new Error('This draft exceeds the list formatting capacity.')
  return result
}

export function composerRowAt(index: ComposerListIndex, position: number): ComposerRow | undefined {
  return index.rows.find((row) => position >= row.start && position <= row.end)
}

export function composerHasContent(text: string): boolean {
  if (!text.trim()) return false
  try {
    const index = indexComposerLists(text)
    return (
      index.groups.length === 0 ||
      index.rows.some((row) => text.slice(row.contentStart, row.end).trim())
    )
  } catch {
    return true
  }
}

const decimalNext = (value: string): string => {
  const digits = value.split('')
  for (let at = digits.length - 1; at >= 0; at--) {
    if (digits[at] !== '9') {
      digits[at] = String(Number(digits[at]) + 1)
      return digits.join('')
    }
    digits[at] = '0'
  }
  return `1${digits.join('')}`
}
const alphabetNumber = (value: number): string => {
  let label = '',
    number = value
  while (number > 0) {
    number--
    label = String.fromCharCode(97 + (number % 26)) + label
    number = Math.floor(number / 26)
  }
  return label
}

/** Map an old coordinate through simultaneous, nonoverlapping replacements. */
const mappedPosition = (
  position: number,
  edits: ComposerReplacement[],
  edge: 'start' | 'end',
): number => {
  let delta = 0
  for (const edit of edits) {
    if (position < edit.start || (position === edit.start && edge === 'start')) break
    if (position <= edit.end) return edit.start + delta + (edge === 'end' ? edit.text.length : 0)
    delta += edit.text.length - (edit.end - edit.start)
  }
  return position + delta
}

function applyPrefixEdits(
  value: ComposerEditResult,
  edits: ComposerReplacement[],
): ComposerEditResult {
  if (!edits.length) return value
  const ordered = edits.toSorted((a, b) => a.start - b.start)
  const finalLength =
    value.document.text.length +
    ordered.reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0)
  assertComposerEditLengths(value.document.text.length, finalLength)
  const pieces: string[] = []
  let at = 0,
    delta = 0
  const prefixes: number[] = []
  for (const edit of ordered) {
    if (
      edit.start < at ||
      value.document.skills.some((skill) => skill.start < edit.end && skill.end > edit.start) ||
      (value.document.mention &&
        value.document.mention.start < edit.end &&
        value.document.mention.end > edit.start)
    )
      throw new Error('List numbering overlapped another input token. Your draft was kept.')
    pieces.push(value.document.text.slice(at, edit.start), edit.text)
    prefixes.push(delta)
    delta += edit.text.length - (edit.end - edit.start)
    at = edit.end
  }
  pieces.push(value.document.text.slice(at))
  const map = (position: number): number => {
    let left = 0,
      right = ordered.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (ordered[middle]!.start <= position) left = middle + 1
      else right = middle
    }
    const number = left - 1
    if (number < 0) return position
    const edit = ordered[number]!,
      prefix = prefixes[number]!
    return position <= edit.end
      ? edit.start + prefix + edit.text.length
      : position + prefix + edit.text.length - (edit.end - edit.start)
  }
  const mention = value.document.mention
  return {
    document: {
      ...value.document,
      text: pieces.join(''),
      skills: value.document.skills.map((skill) => ({
        ...skill,
        start: map(skill.start),
        end: map(skill.end),
      })),
      mention: mention
        ? { ...mention, start: map(mention.start), end: map(mention.end) }
        : undefined,
    },
    selection: { start: map(value.selection.start), end: map(value.selection.end) },
  }
}

/** Apply list repair/numbering to one already transformed user edit, without another draft owner. */
export function formatComposerLists(
  before: ComposerDocument,
  after: ComposerDocument,
  edits: ComposerReplacement[],
  selection: ComposerRange,
): ComposerEditResult {
  const orderedEdits = edits.toSorted((a, b) => a.start - b.start)
  let original: ComposerListIndex | undefined
  try {
    original = indexComposerLists(before.text)
  } catch {
    /* Existing oversized drafts remain editable as plain text. */
  }
  let result = { document: after, selection }
  let index: ComposerListIndex
  try {
    index = indexComposerLists(after.text)
  } catch (error) {
    // Projection capacity does not restrict the complete editable body.
    if (after.text.length > 100_000) return result
    if (!original) return result
    throw error
  }
  let repair: ComposerReplacement[] = []
  if (original) {
    repair = index.rows.flatMap((row): ComposerReplacement[] => {
      if (row.orphanPrefixEnd === undefined) return []
      const known = original.rows.some(
        (old) =>
          old.depth === 1 &&
          mappedPosition(old.start, orderedEdits, 'end') === row.start &&
          !edits.some((edit) => edit.start <= old.start && edit.end >= old.end),
      )
      return known ? [{ start: row.start, end: row.orphanPrefixEnd, text: '1. ' }] : []
    })
    // Removing a paragraph boundary can leave an old immutable marker inside another
    // item's body. It is still a generated prefix, not newly authored body text.
    const lineStarts = new Set(index.rows.map((row) => row.start))
    for (const old of original.rows) {
      if (
        old.group === undefined ||
        edits.some((edit) => edit.start < old.contentStart && edit.end > old.start)
      )
        continue
      // Track the surviving prefix itself, excluding inserted text at either edge.
      const start = mappedPosition(old.start, orderedEdits, 'end')
      const end = mappedPosition(old.contentStart, orderedEdits, 'start')
      if (lineStarts.has(start)) continue
      if (after.text.slice(start, end) === before.text.slice(old.start, old.contentStart))
        repair.push({ start, end, text: '' })
    }
    repair = repair.toSorted((a, b) => a.start - b.start)
    if (repair.length) {
      result = applyPrefixEdits(result, repair)
      index = indexComposerLists(result.document.text)
    }
  }
  const numbering: ComposerReplacement[] = []
  let projectedLength = result.document.text.length
  const previousGroups = (original?.groups ?? []).flatMap((old) =>
    edits.some((edit) => edit.start <= old.start && edit.end >= old.end)
      ? []
      : [
          {
            start: mappedPosition(
              mappedPosition(old.start, orderedEdits, 'start'),
              repair,
              'start',
            ),
            end: mappedPosition(mappedPosition(old.end, orderedEdits, 'end'), repair, 'end'),
            startNumber: old.startNumber,
            changed: edits.some((edit) => edit.start <= old.end && edit.end >= old.start),
          },
        ],
  )
  const membersByGroup: ComposerRow[][] = index.groups.map(() => [])
  for (const row of index.rows) if (row.group !== undefined) membersByGroup[row.group]!.push(row)
  let previousAt = 0
  for (const [groupId, current] of index.groups.entries()) {
    while (previousAt < previousGroups.length && previousGroups[previousAt]!.end < current.start)
      previousAt++
    const previous = previousGroups[previousAt]
    if (
      previous &&
      !previous.changed &&
      current.start >= previous.start &&
      current.start <= previous.end
    )
      continue
    let number = previous?.startNumber ?? current.startNumber,
      child = 0
    if (previous && (current.start < previous.start || current.start > previous.end))
      number = current.startNumber
    const members = membersByGroup[groupId]!
    // A large starting number must not expand thousands of prefixes before refusal.
    const oldPrefixChars = members.reduce((sum, row) => sum + row.contentStart - row.start, 0)
    const minimumPrefixChars = members.reduce(
      (sum, row) => sum + (row.depth === 0 ? number.length + 2 : 7),
      0,
    )
    assertComposerEditLengths(
      before.text.length,
      projectedLength - oldPrefixChars + minimumPrefixChars,
    )
    for (const row of members) {
      const prefix = row.depth === 0 ? `${number}. ` : `    ${alphabetNumber(++child)}. `
      if (row.depth === 0) {
        number = decimalNext(number)
        child = 0
      }
      const originalPrefix = result.document.text.slice(row.start, row.contentStart)
      if (originalPrefix === prefix) continue
      projectedLength += prefix.length - originalPrefix.length
      assertComposerEditLengths(before.text.length, projectedLength)
      numbering.push({ start: row.start, end: row.contentStart, text: prefix })
    }
  }
  return applyPrefixEdits(result, numbering)
}

export function editComposerDocument(
  before: ComposerDocument,
  edit: ComposerReplacement,
  selection?: ComposerRange,
): ComposerEditResult {
  const range = wholeComposerAtoms(before, edit)
  const replacement = { ...range, text: edit.text }
  const next = replaceComposerDocument(before, replacement)
  const cursor = replacement.start + replacement.text.length
  return formatComposerLists(
    before,
    next,
    [replacement],
    selection ?? { start: cursor, end: cursor },
  )
}

/** Structural keys return one complete transaction; undefined leaves normal input handling in charge. */
export function composerListCommand(
  before: ComposerDocument,
  range: ComposerRange,
  command: 'break' | 'indent' | 'outdent' | 'backspace' | 'delete',
): ComposerEditResult | undefined {
  const index = indexComposerLists(before.text)
  const row = composerRowAt(index, range.start)
  if (!row) return undefined
  const apply = (edits: ComposerReplacement[], cursor?: number): ComposerEditResult => {
    let document = before
    for (const edit of edits.toSorted((a, b) => b.start - a.start))
      document = replaceComposerDocument(document, edit)
    const ordered = edits.toSorted((a, b) => a.start - b.start)
    return formatComposerLists(
      before,
      document,
      edits,
      cursor === undefined
        ? {
            start: mappedPosition(range.start, ordered, 'end'),
            end: mappedPosition(range.end, ordered, 'end'),
          }
        : { start: cursor, end: cursor },
    )
  }
  const promoteChildren = (parent: ComposerRow): ComposerReplacement[] =>
    index.rows.flatMap((child) =>
      child.depth === 1 && child.parent === index.rows.indexOf(parent)
        ? [{ start: child.start, end: child.contentStart, text: '1. ' }]
        : [],
    )
  const lift = (keepSelection = false): ComposerEditResult => {
    const replacement = {
      start: row.start,
      end: row.contentStart,
      text: row.depth === 1 ? '1. ' : '',
    }
    return apply(
      [replacement, ...(row.depth === 0 ? promoteChildren(row) : [])],
      keepSelection ? undefined : row.start + replacement.text.length,
    )
  }
  if (command === 'break') {
    if (row.group === undefined) return editComposerDocument(before, { ...range, text: '\n' })
    if (!before.text.slice(row.contentStart, row.end).trim()) return lift()
    return editComposerDocument(before, { ...range, text: row.depth === 1 ? '\n    a. ' : '\n1. ' })
  }
  if (command === 'indent' || command === 'outdent') {
    if (row.group === undefined) return undefined
    if (command === 'outdent')
      return row.depth === 1 ? lift(true) : { document: before, selection: range }
    const previous = index.rows
      .slice(0, index.rows.indexOf(row))
      .findLast((candidate) => candidate.group === row.group && candidate.depth === 0)
    if (row.depth === 1 || !previous || promoteChildren(row).length)
      return { document: before, selection: range }
    const replacement = { start: row.start, end: row.contentStart, text: '    a. ' }
    return apply([replacement])
  }
  if (range.start !== range.end) return undefined
  if (command === 'backspace' && row.group !== undefined && range.start === row.contentStart)
    return lift()
  if (command === 'delete' && range.start === row.end) {
    const next = index.rows[index.rows.indexOf(row) + 1]
    if (!next) return undefined
    return apply(
      [
        { start: row.end, end: next.contentStart, text: '' },
        ...(next.depth === 0 ? promoteChildren(next) : []),
      ],
      row.end,
    )
  }
  if (
    command === 'backspace' &&
    row.group === undefined &&
    range.start === row.start &&
    row.start > 0
  )
    return editComposerDocument(before, { start: row.start - 1, end: row.start, text: '' })
  return undefined
}
