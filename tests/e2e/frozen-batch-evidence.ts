import {
  COLLABORATION_PAGE_ITEMS,
  collaborationDocumentSchema,
  collaborationInputBatchReferenceSchema,
  type CollaborationDocument,
  type CollaborationInputBatchReference,
  type CollaborationSourceReadResult,
} from '../../packages/contracts/src/index.js'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    object(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => a.localeCompare(b)))
      : entry,
  )

/** Only individually authenticated current-root pages enter this pure, bounded fact assembler. */
export function assembleFrozenBatch(
  expected: CollaborationInputBatchReference,
  pages: readonly CollaborationSourceReadResult[],
) {
  const frozen = collaborationInputBatchReferenceSchema.parse(expected)
  if (pages.length > 256) throw Error('Frozen Batch evidence exceeds its call bound')
  const byOrdinal = new Map<number, string>(),
    byMember = new Map<string, number>(),
    byComment = new Map<string, number>()
  const edges = new Map<number, CollaborationSourceReadResult[]>()
  let header: string | undefined,
    body: CollaborationDocument | undefined,
    userInformation: CollaborationDocument | undefined
  // Validate every page, including pages that will not be selected for the complete path.
  for (const page of pages) {
    if (
      page.source !== 'batch' ||
      !integer(page.offset) ||
      page.offset < 0 ||
      (page.nextOffset !== null && (!integer(page.nextOffset) || page.nextOffset <= page.offset))
    )
      throw Error('The frozen Batch cursor did not advance')
    const index: unknown = JSON.parse(page.text)
    if (
      !object(index) ||
      !object(index['batch']) ||
      !Array.isArray(index['members']) ||
      index['members'].length > COLLABORATION_PAGE_ITEMS
    )
      throw Error('The Native Batch receipt does not match the frozen input')
    const actual = collaborationInputBatchReferenceSchema.parse({
      id: index['batch']['id'],
      revision: index['batch']['revision'],
      memberCount: index['batch']['memberCount'],
    })
    if (stable(actual) !== stable(frozen)) throw Error('The frozen Batch identity changed')
    const currentBody =
      index['body'] === undefined ? undefined : collaborationDocumentSchema.parse(index['body'])
    const currentInformation =
      index['userInformation'] === undefined
        ? undefined
        : collaborationDocumentSchema.parse(index['userInformation'])
    if (body && currentBody && stable(body) !== stable(currentBody))
      throw Error('The Native Batch body reference changed between index pages')
    if (
      userInformation &&
      currentInformation &&
      stable(userInformation) !== stable(currentInformation)
    )
      throw Error('The Native user declaration changed between index pages')
    body = currentBody ?? body
    userInformation = currentInformation ?? userInformation
    const currentHeader = stable(
      Object.fromEntries(
        Object.entries(index).filter(
          ([key]) =>
            !['members', 'hasMore', 'nextOrdinal', 'bodyRead', 'userInformationRead'].includes(key),
        ),
      ),
    )
    if (header !== undefined && header !== currentHeader)
      throw Error('The frozen Batch header changed between authenticated reads')
    header = currentHeader
    const members = index['members']
    for (let position = 0; position < members.length; position++) {
      const member: unknown = members[position]
      if (!object(member)) throw Error('The frozen Batch member is unavailable')
      const memberId = collaborationDocumentSchema.shape.id.parse(member['memberId'])
      const commentId = collaborationDocumentSchema.shape.id.parse(member['commentId'])
      const ordinal = member['ordinal']
      if (
        !integer(ordinal) ||
        ordinal !== page.offset + position ||
        ordinal < 0 ||
        ordinal >= frozen.memberCount
      )
        throw Error('The frozen Batch member ordinal is unavailable')
      collaborationDocumentSchema.shape.chars.parse(member['revision'])
      collaborationDocumentSchema.parse(member['anchorDocument'])
      collaborationDocumentSchema.parse(member['body'])
      if (
        typeof member['state'] !== 'string' ||
        ![
          'pending_response',
          'responded',
          'awaiting_confirmation',
          'resolved',
          'withdrawn',
        ].includes(member['state']) ||
        (member['answerResolver'] !== undefined &&
          member['answerResolver'] !== 'claude' &&
          member['answerResolver'] !== 'codex')
      )
        throw Error('The frozen Batch member state is unavailable')
      const facts = stable(
        Object.fromEntries(Object.entries(member).filter(([key]) => key !== 'bodyRead')),
      )
      if (
        (byOrdinal.has(ordinal) && byOrdinal.get(ordinal) !== facts) ||
        (byMember.has(memberId) && byMember.get(memberId) !== ordinal) ||
        (byComment.has(commentId) && byComment.get(commentId) !== ordinal)
      )
        throw Error('The frozen Batch member changed between authenticated reads')
      byOrdinal.set(ordinal, facts)
      byMember.set(memberId, ordinal)
      byComment.set(commentId, ordinal)
    }
    const last = members.length ? page.offset + members.length - 1 : page.offset - 1
    const more = members.length > 0 && last + 1 < frozen.memberCount
    if (
      index['nextOrdinal'] !== last ||
      index['hasMore'] !== more ||
      page.nextOffset !== (more ? last + 1 : null) ||
      (members.length === 0 && page.offset < frozen.memberCount)
    )
      throw Error('The frozen Batch page does not cover its cursor interval')
    const candidates = edges.get(page.offset) ?? []
    candidates.push(page)
    edges.set(page.offset, candidates)
  }
  // At most one parent per cursor: no path enumeration or allocation by durable memberCount.
  const reached = new Map<number, { previous: number; page: CollaborationSourceReadResult }>()
  const queue = [0]
  for (let head = 0; head < queue.length; head++) {
    const offset = queue[head]!
    for (const page of edges.get(offset) ?? []) {
      if (offset > frozen.memberCount) continue
      if (page.nextOffset === null) {
        const path = [page]
        let cursor = offset
        while (cursor !== 0) {
          const parent = reached.get(cursor)!
          path.push(parent.page)
          cursor = parent.previous
        }
        path.reverse()
        const covered = path.reduce((sum, entry) => {
          const index: unknown = JSON.parse(entry.text)
          if (!object(index) || !Array.isArray(index['members']))
            throw Error('The complete Batch page is unavailable')
          return sum + index['members'].length
        }, 0)
        if (covered !== frozen.memberCount)
          throw Error('The complete Batch path omits frozen members')
        return { pages: path, body, userInformation }
      }
      if (!reached.has(page.nextOffset)) {
        reached.set(page.nextOffset, { previous: offset, page })
        queue.push(page.nextOffset)
      }
    }
  }
  return { pages: undefined, body, userInformation }
}
