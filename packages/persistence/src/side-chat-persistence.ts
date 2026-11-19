import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

import {
  COLLABORATION_PAGE_BYTES,
  COLLABORATION_PAGE_ITEMS,
  CONVERSATION_MARKDOWN_BYTES,
  CUTOFF_INLINE_TAIL_MAX_BYTES,
  MESSAGE_ANCHOR_TEXT_BASIS,
  SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS,
  commentAnchorSchema,
  createSideChatReceiptSchema,
  cutoffMessageCommentAnchorSchema,
  isConversationBackgroundReport,
  originSideChatSchema,
  sideChatAnchorSchema,
  sideChatSyncMainReceiptSchema,
  storedCommentAnchor,
  type CommentAnchor,
  type ConversationImage,
  type CreateSideChatInput,
  type CreateSideChatReceipt,
  type OriginSideChat,
  type RuntimeAgentId,
  type SideChatSummary,
  type SideChatSyncMainInput,
  type SideChatSyncMainReceipt,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { updateSessionNativeMetadata } from './native-presence-metadata.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  conversationBodyInputs,
  conversationBodyParts,
  conversationCutoffRevisions,
  conversationCutoffs,
  conversationImageAssets,
  conversationMessages,
  nativeAgentContexts,
  schedulingRuntimeOwners,
  sessionForkOperations,
  sessionSettingsRevisions,
  sessions,
  sideChatOperations,
  workspaceArchiveOperations,
  workspaceChangeSets,
} from './schema/index.js'
import { projectSessionTitle } from './session-projection.js'
import { assertSessionAvailable } from './workspace-archive-repository.js'

const CUTOFF_INLINE_COW_MAX_BYTES = 64 * 1024
const CUTOFF_BODY_PART_BYTES = 8192
const CUTOFF_READ_BUFFER_BYTES = 128 * 1024
const CUTOFF_READ_WINDOW_BYTES = 32 * 1024
const CUTOFF_TAIL_SCAN_LIMIT = 24
const DELIVERED_CUTOFF_MAX_ITEMS = 256
const SQLITE_IN_CHUNK_SIZE = 200

function chunkArray<T>(items: readonly T[], size = SQLITE_IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export interface CapturedCutoffRecord {
  cutoffId: string
  sourceSessionId: string
  maxMessageSequence: number
  sessionMutationSeq: number
  createdAt: string
}

export interface CutoffCatalogItem {
  messageId: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  agentId: RuntimeAgentId | null
  state: 'complete' | 'streaming' | 'incomplete'
  contentBytes: number
  preview: string
  hasComments: boolean
  originSideChat?: OriginSideChat
}

export interface CutoffSourcePage {
  source: 'cutoff'
  cutoffId: string
  part: 'catalog' | 'message' | 'comments' | 'comment'
  sourceSessionId: string
  maxMessageSequence: number
  offset: number
  nextOffset: number | null
  text: string
  items?: CutoffCatalogItem[]
}

export interface CutoffInlineTailResult {
  cutoffId: string
  sourceSessionId: string
  maxMessageSequence: number
  text: string
  byteLength: number
  truncated: boolean
}

export interface PrepareMainSyncBackResult {
  operationId: string
  sideChatId: string
  parentSessionId: string
  sideChatTitle: string
  cutoffId: string
  maxMessageSequence: number
  originSideChat: OriginSideChat
  mainMessageId: string
  mainImageIds: string[]
  mainCommentIds: string[]
  consumedCommentsRevision: number
  existingReceipt?: SideChatSyncMainReceipt
}

export class SideChatPersistenceError extends Error {}

/**
 * Atomically allocate a strictly monotonic canonical conversationMessages sequence for a Session.
 * Never reuses deleted tail sequences or sequences frozen by existing cutoffs.
 */
export function allocateSessionMessageSequence(
  database: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
  sessionId: string,
): number {
  const row = database
    .update(sessions)
    .set({
      nextMessageSequence: sql`max(
        ${sessions.nextMessageSequence},
        coalesce((SELECT max(${conversationMessages.sequence}) + 1 FROM ${conversationMessages} WHERE ${conversationMessages.sessionId} = ${sessionId}), 0),
        coalesce((SELECT max(${conversationCutoffs.maxMessageSequence}) + 1 FROM ${conversationCutoffs} WHERE ${conversationCutoffs.sourceSessionId} = ${sessionId}), 0)
      ) + 1`,
    })
    .where(eq(sessions.id, sessionId))
    .returning({ nextSequence: sessions.nextMessageSequence })
    .get()
  if (!row) {
    throw new SideChatPersistenceError('Session does not exist.')
  }
  return row.nextSequence - 1
}

export function hasSideChatDrafts(database: PactDrizzleDatabase, sideChatId: string): boolean {
  return Boolean(
    database
      .select({ id: anchoredComments.id })
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, sideChatId),
          isNull(anchoredComments.sentWithMessageId),
          isNull(anchoredComments.pendingReceiptId),
        ),
      )
      .limit(1)
      .get(),
  )
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function deterministicUuid(namespace: string, ...parts: string[]): string {
  const hex = sha256Hex(JSON.stringify([namespace, ...parts]))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function formatQuotePreview(quote: string): string {
  const collapsed = quote.replace(/\s+/gu, ' ').trim()
  const source = collapsed || quote
  const chars = Array.from(source)
  return chars.length <= SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS
    ? source
    : chars.slice(0, SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS).join('')
}

function buildSideChatTitle(): {
  title: string
  titleSource: 'placeholder'
} {
  return { title: 'New side chat', titleSource: 'placeholder' }
}

/**
 * Trim any incomplete trailing multi-byte UTF-8 sequence when reading before totalBytes,
 * and advance past up to 3 leading continuation bytes if byteOffset landed mid-codepoint.
 */
function sliceValidUtf8Window(
  raw: Buffer,
  byteOffset: number,
  totalBytes: number,
): { leadSkip: number; text: string } {
  let leadSkip = 0
  if (byteOffset > 0) {
    while (leadSkip < raw.length && leadSkip < 3 && (raw[leadSkip]! & 0xc0) === 0x80) {
      leadSkip += 1
    }
  }
  const slice = raw.subarray(leadSkip)
  let end = slice.length
  const hasMoreAfterRaw = byteOffset + raw.length < totalBytes
  if (hasMoreAfterRaw && end > 0) {
    let inspect = end - 1
    let back = 0
    while (inspect > 0 && back < 3 && (slice[inspect]! & 0xc0) === 0x80) {
      inspect -= 1
      back += 1
    }
    const lead = slice[inspect]!
    const expectedLen =
      (lead & 0xf8) === 0xf0 ? 4 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xe0) === 0xc0 ? 2 : 1
    if (inspect + expectedLen > end) {
      end = inspect
    }
  }
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    slice.subarray(0, end),
  )
  return { leadSkip, text: decoded }
}

export function trimToSurrogateSafePrefix(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  let end = Math.min(text.length, maxChars)
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) {
    end -= 1
  }
  return text.slice(0, end)
}

function trimToUtf8ByteLimit(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  let best = ''
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const candidate = trimToSurrogateSafePrefix(text, mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * Copy a >64 KiB canonical message content into immutable 8 KiB body segments
 * excluded from temporary input expiry cleanup (purpose='cutoff', committedMessageId=null).
 */
function writeImmutableCutoffSegments(
  database: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
  message: { id: string; sessionId: string; contentBytes: number },
  now: string,
): string {
  const inputId = randomUUID()
  database
    .insert(conversationBodyInputs)
    .values({
      id: inputId,
      sessionId: message.sessionId,
      clientMessageId: inputId,
      ownerKey: 'cutoff',
      purpose: 'cutoff',
      bytes: 0,
      chars: 0,
      parts: 0,
      sealed: false,
      committedMessageId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const digest = createHash('sha256')
  let byteOffset = 0
  let charOffset = 0
  let totalBytes = 0
  let partCount = 0

  while (byteOffset < message.contentBytes) {
    const row = database
      .select({
        slice: sql<Buffer>`substr(CAST(${conversationMessages.content} AS BLOB), ${byteOffset + 1}, ${CUTOFF_BODY_PART_BYTES})`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, message.id))
      .get()
    if (!row?.slice.length) {
      throw new SideChatPersistenceError('Source message changed while freezing cutoff snapshot.')
    }
    const { leadSkip, text } = sliceValidUtf8Window(row.slice, byteOffset, message.contentBytes)
    if (!text.length && byteOffset + leadSkip >= message.contentBytes) break
    if (!text.length) {
      throw new SideChatPersistenceError('Source message contains an unreadable UTF-8 boundary.')
    }
    const chunkBytes = Buffer.byteLength(text, 'utf8')
    digest.update(text, 'utf8')
    totalBytes += chunkBytes
    partCount += 1
    database
      .insert(conversationBodyParts)
      .values({
        inputId,
        offset: charOffset,
        text,
        endBytes: totalBytes,
      })
      .run()
    charOffset += text.length
    byteOffset += leadSkip + chunkBytes
  }

  database
    .update(conversationBodyInputs)
    .set({
      bytes: totalBytes,
      chars: charOffset,
      parts: partCount,
      sealed: true,
      hash: digest.digest('hex'),
      updatedAt: now,
    })
    .where(eq(conversationBodyInputs.id, inputId))
    .run()

  return inputId
}

function persistRevisionForMessage(
  database: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
  message: {
    id: string
    sessionId: string
    sequence: number
    role: 'user' | 'assistant' | 'system'
    agentId: RuntimeAgentId | null
    createdAt: string
    state: 'complete' | 'streaming' | 'incomplete'
    isVisible: boolean
    contentBytes: number
  },
  validUpToMutationSeq: number,
  forcedState?: 'complete' | 'streaming' | 'incomplete',
): void {
  const existing = database
    .select({ id: conversationCutoffRevisions.id })
    .from(conversationCutoffRevisions)
    .where(
      and(
        eq(conversationCutoffRevisions.preservedMessageId, message.id),
        gte(conversationCutoffRevisions.validUpToMutationSeq, validUpToMutationSeq),
      ),
    )
    .limit(1)
    .get()
  if (existing) return

  const now = new Date().toISOString()
  let contentInline: string | null = null
  let bodyInputId: string | null = null

  if (message.contentBytes <= CUTOFF_INLINE_COW_MAX_BYTES) {
    const inlineRow = database
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, message.id))
      .get()
    contentInline = inlineRow?.content ?? ''
  } else {
    bodyInputId = writeImmutableCutoffSegments(database, message, now)
  }

  database
    .insert(conversationCutoffRevisions)
    .values({
      id: randomUUID(),
      sourceSessionId: message.sessionId,
      messageId: message.id,
      preservedMessageId: message.id,
      messageSequence: message.sequence,
      role: message.role,
      agentId: message.agentId,
      messageCreatedAt: message.createdAt,
      validUpToMutationSeq,
      state: forcedState ?? (message.state === 'streaming' ? 'incomplete' : message.state),
      isVisible: message.isVisible,
      contentInline,
      bodyInputId,
      createdAt: now,
    })
    .run()
}

/**
 * Capture an O(1) immutable message cutoff for a source Session:
 * bumps sessions.mutationSeq, records maxMessageSequence, and lazily tracks an active streaming message ID without copying.
 */
export function captureCutoffInTransaction(
  transaction: PactDrizzleDatabase,
  input: {
    sourceSessionId: string
    ownerKind: 'side_chat' | 'sync_main'
    ownerOperationId: string
  },
): CapturedCutoffRecord {
  const existing = transaction
    .select()
    .from(conversationCutoffs)
    .where(
      and(
        eq(conversationCutoffs.ownerKind, input.ownerKind),
        eq(conversationCutoffs.ownerOperationId, input.ownerOperationId),
      ),
    )
    .get()
  if (existing) {
    if (existing.sourceSessionId !== input.sourceSessionId) {
      throw new SideChatPersistenceError('Cutoff operation belongs to a different Session.')
    }
    return {
      cutoffId: existing.id,
      sourceSessionId: existing.sourceSessionId,
      maxMessageSequence: existing.maxMessageSequence,
      sessionMutationSeq: existing.sessionMutationSeq,
      createdAt: existing.createdAt,
    }
  }

  const bumped = transaction
    .update(sessions)
    .set({ mutationSeq: sql`${sessions.mutationSeq} + 1` })
    .where(eq(sessions.id, input.sourceSessionId))
    .returning({ mutationSeq: sessions.mutationSeq })
    .get()
  if (!bumped) {
    throw new SideChatPersistenceError('Cutoff source Session does not exist.')
  }

  const maxMessageSequence =
    transaction
      .select({ value: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, input.sourceSessionId))
      .get()?.value ?? -1

  const activeStreaming =
    maxMessageSequence >= 0
      ? transaction
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.sessionId, input.sourceSessionId),
              eq(conversationMessages.role, 'assistant'),
              eq(conversationMessages.state, 'streaming'),
              lte(conversationMessages.sequence, maxMessageSequence),
            ),
          )
          .orderBy(desc(conversationMessages.sequence))
          .limit(1)
          .get()
      : undefined

  const now = new Date().toISOString()
  const cutoffId = deterministicUuid('cutoff', input.ownerKind, input.ownerOperationId)
  transaction
    .insert(conversationCutoffs)
    .values({
      id: cutoffId,
      sourceSessionId: input.sourceSessionId,
      ownerKind: input.ownerKind,
      ownerOperationId: input.ownerOperationId,
      maxMessageSequence,
      sessionMutationSeq: bumped.mutationSeq,
      streamingMessageId: activeStreaming?.id ?? null,
      createdAt: now,
    })
    .run()

  return {
    cutoffId,
    sourceSessionId: input.sourceSessionId,
    maxMessageSequence,
    sessionMutationSeq: bumped.mutationSeq,
    createdAt: now,
  }
}

/**
 * Lazy copy-on-write before any mutation to canonical conversationMessages.content, state, or isVisible.
 * Preserves pre-mutation state for all cutoffs covering message.sequence unless already snapshotted.
 */
export function preserveMessagesBeforeCutoffMutation(
  database: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
  messageIds: string[],
): void {
  const uniqueIds = [...new Set(messageIds)]
  if (!uniqueIds.length) return

  const candidates: Array<{
    id: string
    sessionId: string
    sequence: number
    role: 'user' | 'assistant' | 'system'
    agentId: RuntimeAgentId | null
    createdAt: string
    state: 'complete' | 'streaming' | 'incomplete'
    isVisible: boolean
    contentBytes: number
  }> = []
  for (const chunk of chunkArray(uniqueIds)) {
    const batch = database
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        agentId: conversationMessages.agentId,
        createdAt: conversationMessages.createdAt,
        state: conversationMessages.state,
        isVisible: conversationMessages.isVisible,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      })
      .from(conversationMessages)
      .where(inArray(conversationMessages.id, chunk))
      .all()
    candidates.push(...batch)
  }

  for (const message of candidates) {
    const covered = database
      .select({ seq: max(conversationCutoffs.sessionMutationSeq) })
      .from(conversationCutoffs)
      .where(
        and(
          eq(conversationCutoffs.sourceSessionId, message.sessionId),
          gte(conversationCutoffs.maxMessageSequence, message.sequence),
        ),
      )
      .get()?.seq
    if (covered === null || covered === undefined) continue
    persistRevisionForMessage(database, message, covered)
  }
}

type CutoffRevisionMeta = {
  id: string
  sourceSessionId: string
  preservedMessageId: string
  messageId: string | null
  messageSequence: number
  validUpToMutationSeq: number
  role: 'user' | 'assistant' | 'system'
  agentId: RuntimeAgentId | null
  state: 'complete' | 'streaming' | 'incomplete'
  isVisible: boolean
  bodyInputId: string | null
  hasInline: number
  inlineBytes: number | null
  inlinePreviewRaw: string | null
}

const cutoffRevisionMetaColumns = {
  id: conversationCutoffRevisions.id,
  sourceSessionId: conversationCutoffRevisions.sourceSessionId,
  preservedMessageId: conversationCutoffRevisions.preservedMessageId,
  messageId: conversationCutoffRevisions.messageId,
  messageSequence: conversationCutoffRevisions.messageSequence,
  validUpToMutationSeq: conversationCutoffRevisions.validUpToMutationSeq,
  role: conversationCutoffRevisions.role,
  agentId: conversationCutoffRevisions.agentId,
  state: conversationCutoffRevisions.state,
  isVisible: conversationCutoffRevisions.isVisible,
  bodyInputId: conversationCutoffRevisions.bodyInputId,
  hasInline: sql<number>`CASE WHEN ${conversationCutoffRevisions.contentInline} IS NOT NULL THEN 1 ELSE 0 END`,
  inlineBytes: sql<
    number | null
  >`CASE WHEN ${conversationCutoffRevisions.contentInline} IS NOT NULL THEN length(CAST(${conversationCutoffRevisions.contentInline} AS BLOB)) ELSE NULL END`,
  inlinePreviewRaw: sql<
    string | null
  >`CASE WHEN ${conversationCutoffRevisions.contentInline} IS NOT NULL THEN substr(${conversationCutoffRevisions.contentInline}, 1, 240) ELSE NULL END`,
}

function readCutoffRevision(
  database: PactDrizzleDatabase,
  messageId: string,
  cutoffSeq: number,
): CutoffRevisionMeta | undefined {
  return database
    .select(cutoffRevisionMetaColumns)
    .from(conversationCutoffRevisions)
    .where(
      and(
        eq(conversationCutoffRevisions.preservedMessageId, messageId),
        gte(conversationCutoffRevisions.validUpToMutationSeq, cutoffSeq),
      ),
    )
    .orderBy(asc(conversationCutoffRevisions.validUpToMutationSeq))
    .limit(1)
    .get()
}

function readFrozenMessageByteInfo(
  database: PactDrizzleDatabase,
  messageId: string,
  cutoffSeq: number,
): {
  totalBytes: number
  revision?: CutoffRevisionMeta
} {
  const revision = readCutoffRevision(database, messageId, cutoffSeq)
  if (!revision) {
    const row = database
      .select({
        totalBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId))
      .get()
    return { totalBytes: row?.totalBytes ?? 0 }
  }
  if (revision.hasInline) {
    return {
      totalBytes: revision.inlineBytes ?? 0,
      revision,
    }
  }
  const inputRow = revision.bodyInputId
    ? database
        .select({ bytes: conversationBodyInputs.bytes })
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, revision.bodyInputId))
        .get()
    : undefined
  return { totalBytes: inputRow?.bytes ?? 0, revision }
}

function readFrozenBufferWindow(
  database: PactDrizzleDatabase,
  messageId: string,
  revision: CutoffRevisionMeta | undefined,
  byteOffset: number,
  totalBytes: number,
): Buffer {
  const windowSize = Math.min(
    CUTOFF_READ_WINDOW_BYTES,
    CUTOFF_READ_BUFFER_BYTES,
    Math.max(0, totalBytes - byteOffset),
  )
  if (windowSize === 0) return Buffer.alloc(0)

  if (!revision) {
    const row = database
      .select({
        slice: sql<Buffer>`substr(CAST(${conversationMessages.content} AS BLOB), ${byteOffset + 1}, ${windowSize})`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId))
      .get()
    return row?.slice ?? Buffer.alloc(0)
  }

  if (revision.hasInline) {
    const row = database
      .select({
        slice: sql<Buffer>`substr(CAST(${conversationCutoffRevisions.contentInline} AS BLOB), ${byteOffset + 1}, ${windowSize})`,
      })
      .from(conversationCutoffRevisions)
      .where(eq(conversationCutoffRevisions.id, revision.id))
      .get()
    return row?.slice ?? Buffer.alloc(0)
  }

  if (!revision.bodyInputId) return Buffer.alloc(0)
  const parts = database
    .select({
      text: conversationBodyParts.text,
      endBytes: conversationBodyParts.endBytes,
    })
    .from(conversationBodyParts)
    .where(
      and(
        eq(conversationBodyParts.inputId, revision.bodyInputId),
        gt(conversationBodyParts.endBytes, byteOffset),
      ),
    )
    .orderBy(asc(conversationBodyParts.endBytes))
    .limit(Math.floor(CUTOFF_READ_BUFFER_BYTES / CUTOFF_BODY_PART_BYTES))
    .all()

  const chunks: Buffer[] = []
  let collected = 0
  let cursor = byteOffset
  for (const part of parts) {
    const partBuf = Buffer.from(part.text, 'utf8')
    const partStartByte = part.endBytes - partBuf.length
    const innerStart = Math.max(0, cursor - partStartByte)
    if (innerStart >= partBuf.length) continue
    const take = Math.min(partBuf.length - innerStart, windowSize - collected)
    if (take <= 0) break
    chunks.push(partBuf.subarray(innerStart, innerStart + take))
    collected += take
    cursor += take
    if (collected >= windowSize) break
  }
  return Buffer.concat(chunks)
}

function readCutoffMessageSha256(
  database: PactDrizzleDatabase,
  messageId: string,
  cutoffSeq: number,
): string {
  const { totalBytes, revision } = readFrozenMessageByteInfo(database, messageId, cutoffSeq)
  if (revision?.bodyInputId) {
    const body = database
      .select({ hash: conversationBodyInputs.hash })
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, revision.bodyInputId))
      .get()
    if (body?.hash) return body.hash
  }
  const digest = createHash('sha256')
  let offset = 0
  while (offset < totalBytes) {
    const chunk = readFrozenBufferWindow(database, messageId, revision, offset, totalBytes)
    if (!chunk.length) break
    digest.update(chunk)
    offset += chunk.length
  }
  return digest.digest('hex')
}

function readCutoffMessageBoundedText(
  database: PactDrizzleDatabase,
  messageId: string,
  revision: CutoffRevisionMeta | undefined,
  totalBytes: number,
): string {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < totalBytes) {
    const chunk = readFrozenBufferWindow(database, messageId, revision, offset, totalBytes)
    if (!chunk.length) break
    chunks.push(chunk)
    offset += chunk.length
  }
  return Buffer.concat(chunks).toString('utf8')
}

function fitTextToBudget(
  candidate: string,
  leadSkip: number,
  byteOffset: number,
  totalBytes: number,
  withinBudget: (text: string, nextOffset: number | null) => boolean,
): { text: string; nextOffset: number | null } {
  const computeNext = (text: string): number | null => {
    const consumed = leadSkip + Buffer.byteLength(text, 'utf8')
    return byteOffset + consumed < totalBytes ? byteOffset + consumed : null
  }
  if (withinBudget(candidate, computeNext(candidate))) {
    return { text: candidate, nextOffset: computeNext(candidate) }
  }
  let lo = 1
  let hi = candidate.length
  let best = ''
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const slice = trimToSurrogateSafePrefix(candidate, mid)
    if (!slice.length) break
    if (withinBudget(slice, computeNext(slice))) {
      best = slice
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!best) {
    throw new SideChatPersistenceError('Cutoff message slice exceeds the 48 KiB wire budget.')
  }
  return { text: best, nextOffset: computeNext(best) }
}

type CutoffCandidateRow = {
  id: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  agentId: RuntimeAgentId | null
  state: 'complete' | 'streaming' | 'incomplete'
  isVisible: boolean
  originSideChatJson: string | null
  contentBytes: number
  previewRaw: string
  hasComments: number
  revision?: CutoffRevisionMeta
}

type CutoffRecord = typeof conversationCutoffs.$inferSelect

function cutoffMessageByteSize(
  database: PactDrizzleDatabase,
  revision: CutoffRevisionMeta | undefined,
  liveContentBytes: number,
): number {
  if (!revision) return liveContentBytes
  if (revision.hasInline) {
    return revision.inlineBytes ?? 0
  }
  if (!revision.bodyInputId) return 0
  return (
    database
      .select({ bytes: conversationBodyInputs.bytes })
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, revision.bodyInputId))
      .get()?.bytes ?? 0
  )
}

function cutoffRevisionPreview(
  database: PactDrizzleDatabase,
  revision: CutoffRevisionMeta,
): { contentBytes: number; previewRaw: string } {
  if (revision.hasInline) {
    return {
      contentBytes: revision.inlineBytes ?? 0,
      previewRaw: trimToSurrogateSafePrefix(revision.inlinePreviewRaw ?? '', 240),
    }
  }
  if (!revision.bodyInputId) {
    return { contentBytes: 0, previewRaw: '' }
  }
  const inputRow = database
    .select({ bytes: conversationBodyInputs.bytes })
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, revision.bodyInputId))
    .get()
  const firstPart = database
    .select({ text: sql<string>`substr(${conversationBodyParts.text}, 1, 240)` })
    .from(conversationBodyParts)
    .where(eq(conversationBodyParts.inputId, revision.bodyInputId))
    .orderBy(asc(conversationBodyParts.offset))
    .limit(1)
    .get()
  return {
    contentBytes: inputRow?.bytes ?? 0,
    previewRaw: firstPart?.text ?? '',
  }
}

function listCutoffVisibleCandidates(
  database: PactDrizzleDatabase,
  cutoff: CutoffRecord,
  options:
    | { direction: 'asc'; minSequence: number; limit: number }
    | { direction: 'desc'; limit: number },
): { rows: CutoffCandidateRow[]; hasMore: boolean } {
  const seqBounds =
    options.direction === 'asc'
      ? and(
          gte(conversationMessages.sequence, options.minSequence),
          lte(conversationMessages.sequence, cutoff.maxMessageSequence),
        )
      : lte(conversationMessages.sequence, cutoff.maxMessageSequence)

  const liveRows = database
    .select({
      id: conversationMessages.id,
      sequence: conversationMessages.sequence,
      role: conversationMessages.role,
      agentId: conversationMessages.agentId,
      state: conversationMessages.state,
      isVisible: conversationMessages.isVisible,
      originSideChatJson: conversationMessages.originSideChatJson,
      contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      previewRaw: sql<string>`substr(${conversationMessages.content}, 1, 240)`,
      hasComments: sql<number>`EXISTS (SELECT 1 FROM anchored_comments c WHERE c.sent_with_message_id = "conversation_messages"."id" LIMIT 1)`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.sessionId, cutoff.sourceSessionId),
        seqBounds,
        sql`COALESCE(
          (SELECT r.is_visible FROM conversation_cutoff_revisions r
           WHERE r.preserved_message_id = "conversation_messages"."id"
             AND r.valid_up_to_mutation_seq >= ${cutoff.sessionMutationSeq}
           ORDER BY r.valid_up_to_mutation_seq ASC LIMIT 1),
          "conversation_messages"."is_visible"
        ) = 1`,
      ),
    )
    .orderBy(
      options.direction === 'asc'
        ? asc(conversationMessages.sequence)
        : desc(conversationMessages.sequence),
    )
    .limit(options.limit + 1)
    .all()

  const tombstoneBounds =
    options.direction === 'asc'
      ? and(
          gte(conversationCutoffRevisions.messageSequence, options.minSequence),
          lte(conversationCutoffRevisions.messageSequence, cutoff.maxMessageSequence),
        )
      : lte(conversationCutoffRevisions.messageSequence, cutoff.maxMessageSequence)

  const tombstoneRevs = database
    .select(cutoffRevisionMetaColumns)
    .from(conversationCutoffRevisions)
    .where(
      and(
        eq(conversationCutoffRevisions.sourceSessionId, cutoff.sourceSessionId),
        isNull(conversationCutoffRevisions.messageId),
        tombstoneBounds,
        gte(conversationCutoffRevisions.validUpToMutationSeq, cutoff.sessionMutationSeq),
        eq(conversationCutoffRevisions.isVisible, true),
        sql`"conversation_cutoff_revisions"."id" = (
          SELECT r2.id FROM conversation_cutoff_revisions r2
          WHERE r2.preserved_message_id = "conversation_cutoff_revisions"."preserved_message_id"
            AND r2.valid_up_to_mutation_seq >= ${cutoff.sessionMutationSeq}
          ORDER BY r2.valid_up_to_mutation_seq ASC LIMIT 1
        )`,
      ),
    )
    .orderBy(
      options.direction === 'asc'
        ? asc(conversationCutoffRevisions.messageSequence)
        : desc(conversationCutoffRevisions.messageSequence),
    )
    .limit(options.limit + 1)
    .all()

  const mergedById = new Map<string, CutoffCandidateRow>()
  for (const row of liveRows) {
    const rev = readCutoffRevision(database, row.id, cutoff.sessionMutationSeq)
    if (rev && !rev.isVisible) continue
    const revPreview = rev ? cutoffRevisionPreview(database, rev) : undefined
    mergedById.set(row.id, {
      id: row.id,
      sequence: row.sequence,
      role: row.role,
      agentId: row.agentId,
      state: rev
        ? rev.state
        : row.id === cutoff.streamingMessageId || row.state === 'streaming'
          ? 'incomplete'
          : row.state,
      isVisible: true,
      originSideChatJson: row.originSideChatJson,
      contentBytes: revPreview ? revPreview.contentBytes : row.contentBytes,
      previewRaw: revPreview ? revPreview.previewRaw : row.previewRaw,
      hasComments: row.hasComments,
      ...(rev ? { revision: rev } : {}),
    })
  }
  for (const rev of tombstoneRevs) {
    if (mergedById.has(rev.preservedMessageId)) continue
    const revPreview = cutoffRevisionPreview(database, rev)
    const hasComments = Boolean(
      database
        .select({ id: anchoredComments.id })
        .from(anchoredComments)
        .where(eq(anchoredComments.sentWithMessageId, rev.preservedMessageId))
        .limit(1)
        .get(),
    )
    mergedById.set(rev.preservedMessageId, {
      id: rev.preservedMessageId,
      sequence: rev.messageSequence,
      role: rev.role,
      agentId: rev.agentId,
      state: rev.state === 'streaming' ? 'incomplete' : rev.state,
      isVisible: rev.isVisible,
      originSideChatJson: null,
      contentBytes: revPreview.contentBytes,
      previewRaw: revPreview.previewRaw,
      hasComments: hasComments ? 1 : 0,
      revision: rev,
    })
  }

  const sorted = [...mergedById.values()].toSorted((a, b) =>
    options.direction === 'asc' ? a.sequence - b.sequence : b.sequence - a.sequence,
  )
  return {
    rows: sorted.slice(0, options.limit),
    hasMore:
      sorted.length > options.limit ||
      liveRows.length > options.limit ||
      tombstoneRevs.length > options.limit,
  }
}

function loadCutoffVisibleMessage(
  database: PactDrizzleDatabase,
  cutoff: CutoffRecord,
  messageId: string,
): {
  id: string
  sequence: number
  isVisible: boolean
  revision?: CutoffRevisionMeta
} {
  const msg = database
    .select({
      id: conversationMessages.id,
      sessionId: conversationMessages.sessionId,
      sequence: conversationMessages.sequence,
      isVisible: conversationMessages.isVisible,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, messageId),
        eq(conversationMessages.sessionId, cutoff.sourceSessionId),
      ),
    )
    .get()
  const revision = readCutoffRevision(database, messageId, cutoff.sessionMutationSeq)
  if (!msg && (!revision || revision.sourceSessionId !== cutoff.sourceSessionId)) {
    throw new SideChatPersistenceError('Cutoff message does not exist inside this cutoff.')
  }
  const sequence = revision ? revision.messageSequence : msg!.sequence
  if (sequence > cutoff.maxMessageSequence) {
    throw new SideChatPersistenceError('Cutoff message does not exist inside this cutoff.')
  }
  const effectiveVisible = revision ? revision.isVisible : msg!.isVisible
  if (!effectiveVisible) {
    throw new SideChatPersistenceError('Cutoff message is not visible at this cutoff.')
  }
  return {
    id: messageId,
    sequence,
    isVisible: effectiveVisible,
    ...(revision ? { revision } : {}),
  }
}

/**
 * Bounded stateless cutoff source reader (`<=24` items, `<=48 KiB` wire, `<=128 KiB` buffer,
 * UTF-8 boundary-safe SQLite BLOB slicing, zero cross-page WAL snapshot).
 */
export function readCutoffSource(
  database: PactDrizzleDatabase,
  input: {
    cutoffId: string
    part: 'catalog' | 'message' | 'comments' | 'comment'
    messageId?: string | undefined
    commentId?: string | undefined
    offset: number
  },
  fits?: (page: {
    offset: number
    nextOffset: number | null
    text: string
    items?: CutoffCatalogItem[]
  }) => boolean,
): CutoffSourcePage {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new SideChatPersistenceError('Cutoff read offset must be a non-negative integer.')
  }
  const cutoff = database
    .select()
    .from(conversationCutoffs)
    .where(eq(conversationCutoffs.id, input.cutoffId))
    .get()
  if (!cutoff) {
    throw new SideChatPersistenceError('The requested conversation cutoff is unavailable.')
  }

  const fitsWire = (page: {
    offset: number
    nextOffset: number | null
    text: string
    items?: CutoffCatalogItem[]
  }): boolean => {
    if (
      Buffer.byteLength(
        JSON.stringify({
          source: 'cutoff',
          cutoffId: cutoff.id,
          part: input.part,
          offset: page.offset,
          nextOffset: page.nextOffset,
          text: page.text,
        }),
        'utf8',
      ) > COLLABORATION_PAGE_BYTES
    ) {
      return false
    }
    return fits ? fits(page) : true
  }

  if (input.part === 'catalog') {
    if (cutoff.maxMessageSequence < 0) {
      const text = JSON.stringify({
        cutoffId: cutoff.id,
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        items: [],
      })
      return {
        source: 'cutoff',
        cutoffId: cutoff.id,
        part: 'catalog',
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        offset: input.offset,
        nextOffset: null,
        text,
        items: [],
      }
    }

    const { rows: candidates, hasMore: hasBeyondWindow } = listCutoffVisibleCandidates(
      database,
      cutoff,
      {
        direction: 'asc',
        minSequence: input.offset,
        limit: COLLABORATION_PAGE_ITEMS,
      },
    )

    const pageItems: CutoffCatalogItem[] = candidates.map((row) => {
      const originSideChat = row.originSideChatJson
        ? originSideChatSchema.parse(JSON.parse(row.originSideChatJson))
        : undefined
      return {
        messageId: row.id,
        sequence: row.sequence,
        role: row.role,
        agentId: row.agentId ?? null,
        state: row.state,
        contentBytes: row.contentBytes,
        preview: trimToSurrogateSafePrefix(row.previewRaw.replace(/\s+/gu, ' ').trim(), 240),
        hasComments: Boolean(row.hasComments),
        ...(originSideChat ? { originSideChat } : {}),
      }
    })

    const buildCatalogText = (entries: CutoffCatalogItem[]) =>
      JSON.stringify({
        cutoffId: cutoff.id,
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        items: entries,
      })

    let hasMore = hasBeyondWindow
    while (pageItems.length > 0) {
      const nextOffset =
        hasMore || pageItems.length < candidates.length ? pageItems.at(-1)!.sequence + 1 : null
      const text = buildCatalogText(pageItems)
      if (fitsWire({ offset: input.offset, nextOffset, text, items: pageItems })) {
        return {
          source: 'cutoff',
          cutoffId: cutoff.id,
          part: 'catalog',
          sourceSessionId: cutoff.sourceSessionId,
          maxMessageSequence: cutoff.maxMessageSequence,
          offset: input.offset,
          nextOffset,
          text,
          items: pageItems,
        }
      }
      pageItems.pop()
      hasMore = true
    }

    if (candidates.length > 0) {
      throw new SideChatPersistenceError('Cutoff catalog entry exceeds the 48 KiB wire budget.')
    }
    const emptyText = buildCatalogText([])
    return {
      source: 'cutoff',
      cutoffId: cutoff.id,
      part: 'catalog',
      sourceSessionId: cutoff.sourceSessionId,
      maxMessageSequence: cutoff.maxMessageSequence,
      offset: input.offset,
      nextOffset: null,
      text: emptyText,
      items: [],
    }
  }

  if (input.part === 'message') {
    if (!input.messageId) {
      throw new SideChatPersistenceError('Reading cutoff message content requires messageId.')
    }
    const msg = loadCutoffVisibleMessage(database, cutoff, input.messageId)
    const info = readFrozenMessageByteInfo(database, msg.id, cutoff.sessionMutationSeq)
    if (input.offset > info.totalBytes) {
      throw new SideChatPersistenceError('Cutoff message read offset is out of range.')
    }
    if (info.totalBytes === 0) {
      return {
        source: 'cutoff',
        cutoffId: cutoff.id,
        part: 'message',
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        offset: input.offset,
        nextOffset: null,
        text: '',
      }
    }
    const buf = readFrozenBufferWindow(
      database,
      msg.id,
      info.revision,
      input.offset,
      info.totalBytes,
    )
    const { leadSkip, text: decoded } = sliceValidUtf8Window(buf, input.offset, info.totalBytes)
    const fitted = fitTextToBudget(
      decoded,
      leadSkip,
      input.offset,
      info.totalBytes,
      (text, nextOffset) => fitsWire({ offset: input.offset, nextOffset, text }),
    )
    return {
      source: 'cutoff',
      cutoffId: cutoff.id,
      part: 'message',
      sourceSessionId: cutoff.sourceSessionId,
      maxMessageSequence: cutoff.maxMessageSequence,
      offset: input.offset,
      nextOffset: fitted.nextOffset,
      text: fitted.text,
    }
  }

  if (input.part === 'comment') {
    if (!input.commentId) {
      throw new SideChatPersistenceError('Reading a cutoff comment requires commentId.')
    }
    const row = database
      .select({
        id: anchoredComments.id,
        messageId: anchoredComments.sentWithMessageId,
        position: anchoredComments.position,
        body: anchoredComments.body,
        anchorJson: anchoredComments.anchorJson,
        createdAt: anchoredComments.createdAt,
      })
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.id, input.commentId),
          eq(anchoredComments.sessionId, cutoff.sourceSessionId),
          isNotNull(anchoredComments.sentWithMessageId),
        ),
      )
      .get()
    if (!row?.messageId) {
      throw new SideChatPersistenceError('Cutoff comment is unavailable.')
    }
    loadCutoffVisibleMessage(database, cutoff, row.messageId)
    const payloadText = JSON.stringify({
      commentId: row.id,
      messageId: row.messageId,
      position: row.position,
      createdAt: row.createdAt,
      anchor: storedCommentAnchor(JSON.parse(row.anchorJson)),
      body: row.body,
    })
    const payloadBytes = Buffer.from(payloadText, 'utf8')
    const totalBytes = payloadBytes.length
    if (input.offset > totalBytes) {
      throw new SideChatPersistenceError('Cutoff comment read offset is out of range.')
    }
    if (totalBytes === 0 || input.offset === totalBytes) {
      return {
        source: 'cutoff',
        cutoffId: cutoff.id,
        part: 'comment',
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        offset: input.offset,
        nextOffset: null,
        text: '',
      }
    }
    const rawSlice = payloadBytes.subarray(input.offset, input.offset + CUTOFF_READ_WINDOW_BYTES)
    const { leadSkip, text: decoded } = sliceValidUtf8Window(rawSlice, input.offset, totalBytes)
    const fitted = fitTextToBudget(
      decoded,
      leadSkip,
      input.offset,
      totalBytes,
      (text, nextOffset) => fitsWire({ offset: input.offset, nextOffset, text }),
    )
    return {
      source: 'cutoff',
      cutoffId: cutoff.id,
      part: 'comment',
      sourceSessionId: cutoff.sourceSessionId,
      maxMessageSequence: cutoff.maxMessageSequence,
      offset: input.offset,
      nextOffset: fitted.nextOffset,
      text: fitted.text,
    }
  }

  if (input.messageId) {
    loadCutoffVisibleMessage(database, cutoff, input.messageId)
  }

  const commentRows = database
    .select({
      id: anchoredComments.id,
      messageId: anchoredComments.sentWithMessageId,
      position: anchoredComments.position,
      bodyStart: sql<string>`substr(${anchoredComments.body}, 1, 960)`,
      bodyLen: sql<number>`length(${anchoredComments.body})`,
      bodyBytes: sql<number>`length(CAST(${anchoredComments.body} AS BLOB))`,
      quoteStart: sql<
        string | null
      >`substr(json_extract(${anchoredComments.anchorJson}, '$.quote'), 1, 960)`,
      createdAt: anchoredComments.createdAt,
    })
    .from(anchoredComments)
    .where(
      and(
        eq(anchoredComments.sessionId, cutoff.sourceSessionId),
        isNotNull(anchoredComments.sentWithMessageId),
        gte(anchoredComments.position, input.offset),
        input.messageId ? eq(anchoredComments.sentWithMessageId, input.messageId) : undefined,
        sql`COALESCE(
          (SELECT r.is_visible FROM conversation_cutoff_revisions r
           WHERE r.preserved_message_id = "anchored_comments"."sent_with_message_id"
             AND r.source_session_id = ${cutoff.sourceSessionId}
             AND r.valid_up_to_mutation_seq >= ${cutoff.sessionMutationSeq}
           ORDER BY r.valid_up_to_mutation_seq ASC LIMIT 1),
          (SELECT m.is_visible FROM conversation_messages m
           WHERE m.id = "anchored_comments"."sent_with_message_id"
             AND m.session_id = ${cutoff.sourceSessionId}
           LIMIT 1),
          0
        ) = 1`,
        sql`COALESCE(
          (SELECT m.sequence FROM conversation_messages m
           WHERE m.id = "anchored_comments"."sent_with_message_id"
             AND m.session_id = ${cutoff.sourceSessionId}
           LIMIT 1),
          (SELECT r.message_sequence FROM conversation_cutoff_revisions r
           WHERE r.preserved_message_id = "anchored_comments"."sent_with_message_id"
             AND r.source_session_id = ${cutoff.sourceSessionId}
             AND r.valid_up_to_mutation_seq >= ${cutoff.sessionMutationSeq}
           ORDER BY r.valid_up_to_mutation_seq ASC LIMIT 1)
        ) <= ${cutoff.maxMessageSequence}`,
      ),
    )
    .orderBy(asc(anchoredComments.position))
    .limit(COLLABORATION_PAGE_ITEMS + 1)
    .all()

  const commentItems = commentRows.slice(0, COLLABORATION_PAGE_ITEMS).map((row) => {
    const quoteRaw =
      typeof row.quoteStart === 'string' ? trimToSurrogateSafePrefix(row.quoteStart, 960) : ''
    const quotePreview = quoteRaw
      ? trimToUtf8ByteLimit(quoteRaw.replace(/\s+/gu, ' ').trim(), 240)
      : ''
    const safeBodyStart = trimToSurrogateSafePrefix(row.bodyStart, 960)
    const bodyPreview = trimToUtf8ByteLimit(safeBodyStart.replace(/\s+/gu, ' ').trim(), 240)
    const entry: {
      commentId: string
      messageId: string | null
      position: number
      bodyPreview: string
      bodyBytes: number
      truncated: boolean
      quotePreview?: string
      createdAt: string
      commentRead: {
        context: 'native-root-v1'
        source: 'cutoff'
        cutoffId: string
        part: 'comment'
        commentId: string
        offset: number
      }
    } = {
      commentId: row.id,
      messageId: row.messageId,
      position: row.position,
      bodyPreview,
      bodyBytes: row.bodyBytes,
      truncated: row.bodyLen > 960 || bodyPreview !== row.bodyStart,
      createdAt: row.createdAt,
      commentRead: {
        context: 'native-root-v1' as const,
        source: 'cutoff' as const,
        cutoffId: cutoff.id,
        part: 'comment' as const,
        commentId: row.id,
        offset: 0,
      },
    }
    if (quotePreview) entry.quotePreview = quotePreview
    return entry
  })

  let hasMoreComments = commentRows.length > COLLABORATION_PAGE_ITEMS
  const buildCommentsText = (entries: typeof commentItems) =>
    JSON.stringify({
      cutoffId: cutoff.id,
      sourceSessionId: cutoff.sourceSessionId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      items: entries,
    })

  while (commentItems.length > 0) {
    const nextOffset =
      hasMoreComments || commentItems.length < commentRows.length
        ? commentItems.at(-1)!.position + 1
        : null
    const text = buildCommentsText(commentItems)
    if (fitsWire({ offset: input.offset, nextOffset, text })) {
      return {
        source: 'cutoff',
        cutoffId: cutoff.id,
        part: 'comments',
        sourceSessionId: cutoff.sourceSessionId,
        maxMessageSequence: cutoff.maxMessageSequence,
        offset: input.offset,
        nextOffset,
        text,
      }
    }
    commentItems.pop()
    hasMoreComments = true
  }

  if (commentRows.length > 0) {
    throw new SideChatPersistenceError('Cutoff comment entry exceeds the 48 KiB wire budget.')
  }
  return {
    source: 'cutoff',
    cutoffId: cutoff.id,
    part: 'comments',
    sourceSessionId: cutoff.sourceSessionId,
    maxMessageSequence: cutoff.maxMessageSequence,
    offset: input.offset,
    nextOffset: null,
    text: buildCommentsText([]),
  }
}

/** Build bounded <=12 KiB inline tail context for initial cutoff delivery per bindingGeneration. */
export function buildCutoffInlineTail(
  database: PactDrizzleDatabase,
  cutoffId: string,
  maxBytes = CUTOFF_INLINE_TAIL_MAX_BYTES,
): CutoffInlineTailResult {
  const budget = Math.min(maxBytes, CUTOFF_INLINE_TAIL_MAX_BYTES)
  const cutoff = database
    .select()
    .from(conversationCutoffs)
    .where(eq(conversationCutoffs.id, cutoffId))
    .get()
  if (!cutoff || cutoff.maxMessageSequence < 0) {
    return {
      cutoffId,
      sourceSessionId: cutoff?.sourceSessionId ?? '',
      maxMessageSequence: cutoff?.maxMessageSequence ?? -1,
      text: '',
      byteLength: 0,
      truncated: false,
    }
  }

  const { rows: scanned, hasMore: hasOlderBeyondScan } = listCutoffVisibleCandidates(
    database,
    cutoff,
    {
      direction: 'desc',
      limit: CUTOFF_TAIL_SCAN_LIMIT,
    },
  )
  if (!scanned.length) {
    return {
      cutoffId: cutoff.id,
      sourceSessionId: cutoff.sourceSessionId,
      maxMessageSequence: cutoff.maxMessageSequence,
      text: '',
      byteLength: 0,
      truncated: false,
    }
  }

  const headerBase = `Frozen cutoff context (cutoffId=${cutoff.id}, sourceSessionId=${cutoff.sourceSessionId}, maxMessageSequence=${cutoff.maxMessageSequence}):\n`
  const headerTruncatedNote = `Note: Earlier or larger messages omitted; use collaboration source='cutoff' to read in full.\n`
  const reservedBytes = Buffer.byteLength(headerBase + headerTruncatedNote, 'utf8')
  const availableBodyBytes = Math.max(0, budget - reservedBytes)

  const selectedBlocks: string[] = []
  let usedBodyBytes = 0
  let truncated = hasOlderBeyondScan

  for (const row of scanned) {
    const rev = row.revision
    const prefix = `[#${row.sequence} id=${row.id} role=${row.role}${row.agentId ? ` agent=${row.agentId}` : ''} state=${row.state}]:\n`

    const totalMsgBytes = cutoffMessageByteSize(database, rev, row.contentBytes)
    const buf = readFrozenBufferWindow(database, row.id, rev, 0, totalMsgBytes)
    const { text: decoded } = sliceValidUtf8Window(buf, 0, totalMsgBytes)
    const messageTruncated = totalMsgBytes > Buffer.byteLength(decoded, 'utf8')
    const suffix = messageTruncated ? '\n...[truncated; read full message via cutoff]' : ''
    const block = `${prefix}${decoded}${suffix}`
    const sepBytes = selectedBlocks.length > 0 ? 2 : 0
    const blockBytes = Buffer.byteLength(block, 'utf8')

    if (usedBodyBytes + sepBytes + blockBytes <= availableBodyBytes) {
      selectedBlocks.push(block)
      usedBodyBytes += sepBytes + blockBytes
      if (messageTruncated) truncated = true
      continue
    }

    if (selectedBlocks.length === 0) {
      const prefixBytes = Buffer.byteLength(
        prefix + '\n...[truncated; read full message via cutoff]',
        'utf8',
      )
      const contentBudget = Math.max(0, availableBodyBytes - prefixBytes)
      const trimmedContent = trimToUtf8ByteLimit(decoded, contentBudget)
      const fallbackBlock = `${prefix}${trimmedContent}${trimmedContent.length < decoded.length || messageTruncated ? '\n...[truncated; read full message via cutoff]' : ''}`
      selectedBlocks.push(trimToUtf8ByteLimit(fallbackBlock, availableBodyBytes))
    }
    truncated = true
    break
  }

  selectedBlocks.reverse()
  const finalText = trimToUtf8ByteLimit(
    `${headerBase}${truncated ? headerTruncatedNote : ''}${selectedBlocks.join('\n\n')}`,
    budget,
  )
  return {
    cutoffId: cutoff.id,
    sourceSessionId: cutoff.sourceSessionId,
    maxMessageSequence: cutoff.maxMessageSequence,
    text: finalText,
    byteLength: Buffer.byteLength(finalText, 'utf8'),
    truncated,
  }
}

/** Create a side chat Session atomically with parent settings snapshot, O(1) cutoff, and idempotent receipt. */
export function createSideChatInTransaction(
  transaction: PactDrizzleDatabase,
  input: CreateSideChatInput,
  options?: { resolveVisibleText?: (content: string) => string },
): CreateSideChatReceipt {
  const requestSha256 = sha256Hex(JSON.stringify({ kind: 'create', ...input }))
  const existing = transaction
    .select()
    .from(sideChatOperations)
    .where(eq(sideChatOperations.id, input.operationId))
    .get()
  if (existing) {
    if (
      existing.kind !== 'create' ||
      existing.targetSessionId !== input.parentSessionId ||
      existing.requestSha256 !== requestSha256 ||
      !existing.receiptJson
    ) {
      throw new SideChatPersistenceError(
        'This side-chat operation ID belongs to a different request.',
      )
    }
    return createSideChatReceiptSchema.parse(JSON.parse(existing.receiptJson))
  }

  assertSessionAvailable(transaction, input.parentSessionId)
  const parent = transaction
    .select()
    .from(sessions)
    .where(eq(sessions.id, input.parentSessionId))
    .get()
  if (!parent) throw new SideChatPersistenceError('Parent Session does not exist.')
  if (parent.parentSessionId) {
    throw new SideChatPersistenceError('Nested side chats are not supported.')
  }
  const parentSettings = transaction
    .select()
    .from(sessionSettingsRevisions)
    .where(
      and(
        eq(sessionSettingsRevisions.sessionId, parent.id),
        eq(sessionSettingsRevisions.revision, parent.settingsRevision),
      ),
    )
    .get()
  if (!parentSettings) {
    throw new SideChatPersistenceError('Parent Session settings snapshot is unavailable.')
  }

  let anchorQuote: string | null = null
  let anchorQuotePreview: string | null = null
  let anchorMessageId: string | null = null
  let anchorStartOffset: number | null = null
  let anchorEndOffset: number | null = null
  let anchorContentSha256: string | null = null

  if (input.origin === 'selection') {
    if (input.startOffset < 0 || input.endOffset <= input.startOffset) {
      throw new SideChatPersistenceError('Selection anchor offsets are invalid.')
    }
    const anchorMeta = transaction
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        role: conversationMessages.role,
        state: conversationMessages.state,
        isVisible: conversationMessages.isVisible,
        runId: conversationMessages.runId,
        sourceMessageId: conversationMessages.sourceMessageId,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.sessionId, input.parentSessionId),
        ),
      )
      .get()
    if (
      !anchorMeta ||
      !anchorMeta.isVisible ||
      (anchorMeta.role !== 'user' && anchorMeta.role !== 'assistant') ||
      anchorMeta.state === 'streaming' ||
      isConversationBackgroundReport(anchorMeta)
    ) {
      throw new SideChatPersistenceError('Selection target message is unavailable.')
    }
    if (anchorMeta.contentBytes > CONVERSATION_MARKDOWN_BYTES) {
      throw new SideChatPersistenceError('Selection target message exceeds anchor text capacity.')
    }
    const anchorRow = transaction
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, anchorMeta.id))
      .get()
    if (!anchorRow) {
      throw new SideChatPersistenceError('Selection target message is unavailable.')
    }
    const visibleText = options?.resolveVisibleText
      ? options.resolveVisibleText(anchorRow.content)
      : anchorRow.content
    if (
      input.endOffset > visibleText.length ||
      visibleText.slice(input.startOffset, input.endOffset) !== input.quote
    ) {
      throw new SideChatPersistenceError('Selection anchor no longer matches the source message.')
    }
    anchorContentSha256 = sha256Hex(anchorRow.content)
    anchorMessageId = input.messageId
    anchorQuote = input.quote
    anchorQuotePreview = formatQuotePreview(input.quote)
    anchorStartOffset = input.startOffset
    anchorEndOffset = input.endOffset
    sideChatAnchorSchema.parse({
      messageId: anchorMessageId,
      quote: anchorQuote,
      quotePreview: anchorQuotePreview,
      startOffset: anchorStartOffset,
      endOffset: anchorEndOffset,
    })
  }

  const cutoff = captureCutoffInTransaction(transaction, {
    sourceSessionId: input.parentSessionId,
    ownerKind: 'side_chat',
    ownerOperationId: input.operationId,
  })

  const sideChatId = deterministicUuid('side-chat-session', input.operationId)
  const { title, titleSource } = buildSideChatTitle()
  const now = new Date().toISOString()

  transaction
    .insert(sessions)
    .values({
      id: sideChatId,
      projectId: parent.projectId,
      title,
      titleSource,
      status: 'draft',
      settingsRevision: 1,
      lastSeenMessageSequence: -1,
      lastOpenedOrdinal: null,
      workspaceVisible: true,
      sidebarHidden: true,
      needsAttention: false,
      queueEnabled: parent.queueEnabled,
      queueRevision: 0,
      commentsRevision: input.origin === 'selection' ? 1 : 0,
      parentSessionId: input.parentSessionId,
      sideChatOrigin: input.origin,
      anchorCutoffId: cutoff.cutoffId,
      anchorMessageId,
      anchorQuote,
      anchorQuotePreview,
      anchorStartOffset,
      anchorEndOffset,
      mutationSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const {
    sessionId: _ignoredSession,
    revision: _ignoredRev,
    createdAt: _ignoredAt,
    ...settingsCols
  } = parentSettings
  transaction
    .insert(sessionSettingsRevisions)
    .values({
      ...settingsCols,
      sessionId: sideChatId,
      revision: 1,
      createdAt: now,
    })
    .run()

  if (
    input.origin === 'selection' &&
    anchorMessageId &&
    anchorQuote &&
    anchorStartOffset !== null &&
    anchorEndOffset !== null &&
    anchorContentSha256
  ) {
    const initialCommentAnchor = cutoffMessageCommentAnchorSchema.parse({
      type: 'cutoff_message',
      sourceSessionId: input.parentSessionId,
      cutoffId: cutoff.cutoffId,
      messageId: anchorMessageId,
      textBasis: MESSAGE_ANCHOR_TEXT_BASIS,
      quote: anchorQuote,
      startOffset: anchorStartOffset,
      endOffset: anchorEndOffset,
      contentSha256: anchorContentSha256,
    })
    transaction
      .insert(anchoredComments)
      .values({
        id: deterministicUuid('side-chat-initial-comment', input.operationId),
        sessionId: sideChatId,
        body: '',
        anchorJson: JSON.stringify(initialCommentAnchor),
        sentWithMessageId: null,
        pendingReceiptId: null,
        returnOperationId: null,
        answerKey: null,
        draftRevision: 1,
        position: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  updateSessionNativeMetadata(transaction, sideChatId)

  const sideChat: SideChatSummary = {
    id: sideChatId,
    parentSessionId: input.parentSessionId,
    projectId: parent.projectId,
    title: projectSessionTitle(title, titleSource, 'New side chat').title,
    origin: input.origin,
    anchorQuotePreview,
    previewText: null,
    status: 'draft',
    isRunning: false,
    needsAttention: false,
    hasUnread: false,
    createdAt: now,
    updatedAt: now,
  }
  const receipt: CreateSideChatReceipt = createSideChatReceiptSchema.parse({
    operationId: input.operationId,
    sideChat,
    cutoffId: cutoff.cutoffId,
    maxMessageSequence: cutoff.maxMessageSequence,
  })

  transaction
    .insert(sideChatOperations)
    .values({
      id: input.operationId,
      kind: 'create',
      sessionId: sideChatId,
      targetSessionId: input.parentSessionId,
      requestSha256,
      receiptJson: JSON.stringify(receipt),
      createdAt: now,
    })
    .run()

  return receipt
}

/** Prepare @Main sync-back: freezes side-chat own messages, clones zero-copy images, mints cutoff_message anchors, consumes side-chat drafts. */
export function prepareMainSyncBackInTransaction(
  transaction: PactDrizzleDatabase,
  input: SideChatSyncMainInput,
  resolveImages: (sessionId: string, imageIds: string[], ownerKey?: string) => ConversationImage[],
  imageOwnerKey?: string,
  resolvedContent?: string,
  options?: { resolveVisibleText?: (content: string) => string },
): PrepareMainSyncBackResult {
  const effectiveContent = resolvedContent ?? input.content
  if (
    resolvedContent !== undefined &&
    input.contentSha256 &&
    sha256Hex(resolvedContent) !== input.contentSha256.toLowerCase()
  ) {
    throw new SideChatPersistenceError('The prepared message changed before sending.')
  }
  const contentDigest = input.contentSha256?.toLowerCase() ?? sha256Hex(effectiveContent)
  const requestSha256 = sha256Hex(
    JSON.stringify({
      kind: 'sync_main',
      sideChatId: input.sideChatId,
      contentSha256: contentDigest,
      imageIds: input.imageIds,
      commentIds: input.commentIds,
      skills: input.skills,
      userInformation: input.userInformation,
      expectedCommentsRevision: input.expectedCommentsRevision,
    }),
  )
  const mainMessageId = deterministicUuid('side-chat-main-msg', input.operationId)
  const mainImageIds = input.imageIds.map((id) =>
    deterministicUuid('side-chat-sync-image', input.operationId, id),
  )
  const existingOp = transaction
    .select()
    .from(sideChatOperations)
    .where(eq(sideChatOperations.id, input.operationId))
    .get()

  if (existingOp) {
    if (
      existingOp.kind !== 'sync_main' ||
      existingOp.sessionId !== input.sideChatId ||
      existingOp.requestSha256 !== requestSha256
    ) {
      throw new SideChatPersistenceError('This sync operation ID belongs to a different request.')
    }
    const sideChatRow = transaction
      .select({
        title: sessions.title,
        titleSource: sessions.titleSource,
        parentSessionId: sessions.parentSessionId,
        commentsRevision: sessions.commentsRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, input.sideChatId))
      .get()
    if (!sideChatRow?.parentSessionId) {
      throw new SideChatPersistenceError('Side chat is no longer available.')
    }
    const cutoff = transaction
      .select()
      .from(conversationCutoffs)
      .where(
        and(
          eq(conversationCutoffs.ownerKind, 'sync_main'),
          eq(conversationCutoffs.ownerOperationId, input.operationId),
        ),
      )
      .get()
    if (!cutoff) {
      throw new SideChatPersistenceError('Sync cutoff metadata is unavailable.')
    }
    const existingReceipt = existingOp.receiptJson
      ? sideChatSyncMainReceiptSchema.parse(JSON.parse(existingOp.receiptJson))
      : undefined
    const mintedComments = transaction
      .select({ id: anchoredComments.id })
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, sideChatRow.parentSessionId),
          existingReceipt?.disposition === 'sent'
            ? or(
                eq(anchoredComments.sentWithMessageId, mainMessageId),
                eq(anchoredComments.pendingReceiptId, mainMessageId),
              )
            : or(
                eq(anchoredComments.pendingReceiptId, mainMessageId),
                eq(anchoredComments.sentWithMessageId, mainMessageId),
              ),
        ),
      )
      .orderBy(asc(anchoredComments.position))
      .all()
    const sideChatTitle = projectSessionTitle(
      sideChatRow.title,
      sideChatRow.titleSource,
      'New side chat',
    ).title
    return {
      operationId: input.operationId,
      sideChatId: input.sideChatId,
      parentSessionId: sideChatRow.parentSessionId,
      sideChatTitle,
      cutoffId: cutoff.id,
      maxMessageSequence: cutoff.maxMessageSequence,
      originSideChat: originSideChatSchema.parse({
        sideChatId: input.sideChatId,
        cutoffId: cutoff.id,
        sideChatTitle,
      }),
      mainMessageId,
      mainImageIds,
      mainCommentIds: mintedComments.map((row) => row.id),
      consumedCommentsRevision: sideChatRow.commentsRevision,
      ...(existingReceipt ? { existingReceipt } : {}),
    }
  }

  assertSessionAvailable(transaction, input.sideChatId)
  const sideChat = transaction
    .select()
    .from(sessions)
    .where(eq(sessions.id, input.sideChatId))
    .get()
  if (!sideChat?.parentSessionId) {
    throw new SideChatPersistenceError('Only side chats can sync back to a parent Session.')
  }
  assertSessionAvailable(transaction, sideChat.parentSessionId)
  if (sideChat.commentsRevision !== input.expectedCommentsRevision) {
    throw new SideChatPersistenceError('Comment drafts changed. Refresh and try again.')
  }

  if (new Set(input.commentIds).size !== input.commentIds.length) {
    throw new SideChatPersistenceError('Selected Comment references are invalid.')
  }

  const DRAFT_PAGE_SIZE = SQLITE_IN_CHUNK_SIZE
  const seenDraftIds = new Set<string>()
  const draftsToMint: Array<typeof anchoredComments.$inferSelect> = []
  let afterPosition = -1
  while (true) {
    const page = transaction
      .select()
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, input.sideChatId),
          isNull(anchoredComments.sentWithMessageId),
          isNull(anchoredComments.pendingReceiptId),
          gt(anchoredComments.position, afterPosition),
        ),
      )
      .orderBy(asc(anchoredComments.position))
      .limit(DRAFT_PAGE_SIZE)
      .all()
    if (page.length === 0) break
    for (const row of page) {
      seenDraftIds.add(row.id)
      draftsToMint.push(row)
    }
    if (page.length < DRAFT_PAGE_SIZE) break
    afterPosition = page.at(-1)!.position
  }
  for (const commentId of input.commentIds) {
    if (!seenDraftIds.has(commentId)) {
      throw new SideChatPersistenceError('Selected Comment draft is no longer current.')
    }
  }

  if (!effectiveContent.trim() && !input.imageIds.length && !draftsToMint.length) {
    throw new SideChatPersistenceError(
      'Write a message, add a Comment, or attach an image before sending to main.',
    )
  }

  // Validate side-chat images first (throws if missing or unowned)
  resolveImages(input.sideChatId, input.imageIds, imageOwnerKey)

  // Capture side-chat own messages cutoff (side_chatId owns only its own conversationMessages, never parent's)
  const cutoff = captureCutoffInTransaction(transaction, {
    sourceSessionId: input.sideChatId,
    ownerKind: 'sync_main',
    ownerOperationId: input.operationId,
  })
  const cutoffRecord = transaction
    .select()
    .from(conversationCutoffs)
    .where(eq(conversationCutoffs.id, cutoff.cutoffId))
    .get()!

  const now = new Date().toISOString()
  let nextPosition =
    (transaction
      .select({ value: max(anchoredComments.position) })
      .from(anchoredComments)
      .where(eq(anchoredComments.sessionId, sideChat.parentSessionId))
      .get()?.value ?? -1) + 1

  const mintedCommentIds: string[] = []
  for (const draft of draftsToMint) {
    const parsedAnchor = storedCommentAnchor(JSON.parse(draft.anchorJson))
    let targetAnchor: CommentAnchor
    if (parsedAnchor.type === 'message') {
      if (parsedAnchor.plan || parsedAnchor.report) {
        throw new SideChatPersistenceError(
          'Plan and report comment anchors cannot be synced from a side chat.',
        )
      }
      if (
        parsedAnchor.textBasis !== MESSAGE_ANCHOR_TEXT_BASIS &&
        parsedAnchor.textBasis !== 'markdown-visible-v1'
      ) {
        throw new SideChatPersistenceError(
          'Comment anchor uses an unsupported Markdown projection.',
        )
      }
      try {
        loadCutoffVisibleMessage(transaction, cutoffRecord, parsedAnchor.messageId)
      } catch {
        throw new SideChatPersistenceError('Comment anchor target is outside the side chat.')
      }
      const contentSha256 = readCutoffMessageSha256(
        transaction,
        parsedAnchor.messageId,
        cutoff.sessionMutationSeq,
      )
      if (parsedAnchor.contentHash.toLowerCase() !== contentSha256.toLowerCase()) {
        throw new SideChatPersistenceError('Comment anchor source content changed.')
      }
      const msgByteInfo = readFrozenMessageByteInfo(
        transaction,
        parsedAnchor.messageId,
        cutoff.sessionMutationSeq,
      )
      if (msgByteInfo.totalBytes > CONVERSATION_MARKDOWN_BYTES) {
        throw new SideChatPersistenceError(
          'Comment anchor target exceeds Markdown anchor capacity.',
        )
      }
      if (parsedAnchor.textBasis === 'markdown-visible-v1' || options?.resolveVisibleText) {
        const raw = readCutoffMessageBoundedText(
          transaction,
          parsedAnchor.messageId,
          msgByteInfo.revision,
          msgByteInfo.totalBytes,
        )
        const projected =
          parsedAnchor.textBasis === MESSAGE_ANCHOR_TEXT_BASIS && options?.resolveVisibleText
            ? options.resolveVisibleText(raw)
            : raw
        if (
          parsedAnchor.endOffset > projected.length ||
          projected.slice(parsedAnchor.startOffset, parsedAnchor.endOffset) !== parsedAnchor.quote
        ) {
          throw new SideChatPersistenceError('Comment quote no longer matches its source message.')
        }
      }
      targetAnchor = cutoffMessageCommentAnchorSchema.parse({
        type: 'cutoff_message',
        sourceSessionId: input.sideChatId,
        cutoffId: cutoff.cutoffId,
        messageId: parsedAnchor.messageId,
        textBasis: parsedAnchor.textBasis,
        quote: parsedAnchor.quote,
        startOffset: parsedAnchor.startOffset,
        endOffset: parsedAnchor.endOffset,
        contentSha256,
      })
    } else {
      targetAnchor = commentAnchorSchema.parse(parsedAnchor)
    }

    const mintedId = deterministicUuid('side-chat-sync-comment', input.operationId, draft.id)
    mintedCommentIds.push(mintedId)
    transaction
      .insert(anchoredComments)
      .values({
        id: mintedId,
        sessionId: sideChat.parentSessionId,
        body: draft.body,
        anchorJson: JSON.stringify(targetAnchor),
        sentWithMessageId: null,
        pendingReceiptId: mainMessageId,
        returnOperationId: null,
        answerKey: null,
        position: nextPosition++,
        draftRevision: draft.draftRevision,
        createdAt: draft.createdAt,
        updatedAt: now,
      })
      .run()
  }

  // Side-chat draft comments remain intact until finalizeMainSyncBackReceipt commits the parent send or queue write.
  const consumedCommentsRevision = sideChat.commentsRevision

  // Zero-copy shared storageObjectId asset rows for parent Session
  for (const [index, sourceImageId] of input.imageIds.entries()) {
    const sourceAsset = transaction
      .select()
      .from(conversationImageAssets)
      .where(eq(conversationImageAssets.id, sourceImageId))
      .get()
    if (!sourceAsset) {
      throw new SideChatPersistenceError('Attached image is no longer available.')
    }
    const storageObjectId = sourceAsset.storageObjectId ?? sourceAsset.id
    if (!sourceAsset.storageObjectId) {
      transaction
        .update(conversationImageAssets)
        .set({ storageObjectId })
        .where(eq(conversationImageAssets.id, sourceAsset.id))
        .run()
    }
    const clonedId = mainImageIds[index]!
    transaction
      .insert(conversationImageAssets)
      .values({
        id: clonedId,
        pendingReceiptId: mainMessageId,
        ownerKey: imageOwnerKey ?? sourceAsset.ownerKey,
        ownerSessionId: sideChat.parentSessionId,
        name: sourceAsset.name,
        bytes: sourceAsset.bytes,
        ready: true,
        committed: false,
        mediaType: sourceAsset.mediaType,
        width: sourceAsset.width,
        height: sourceAsset.height,
        sha256: sourceAsset.sha256,
        thumbnailBytes: sourceAsset.thumbnailBytes,
        storageObjectId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run()
  }

  transaction
    .insert(sideChatOperations)
    .values({
      id: input.operationId,
      kind: 'sync_main',
      sessionId: input.sideChatId,
      targetSessionId: sideChat.parentSessionId,
      requestSha256,
      receiptJson: null,
      createdAt: now,
    })
    .run()

  const sideChatTitle = projectSessionTitle(
    sideChat.title,
    sideChat.titleSource,
    'New side chat',
  ).title
  return {
    operationId: input.operationId,
    sideChatId: input.sideChatId,
    parentSessionId: sideChat.parentSessionId,
    sideChatTitle,
    cutoffId: cutoff.cutoffId,
    maxMessageSequence: cutoff.maxMessageSequence,
    originSideChat: originSideChatSchema.parse({
      sideChatId: input.sideChatId,
      cutoffId: cutoff.cutoffId,
      sideChatTitle,
    }),
    mainMessageId,
    mainImageIds,
    mainCommentIds: mintedCommentIds,
    consumedCommentsRevision,
  }
}

export function finalizeMainSyncBackReceipt(
  database: PactDrizzleDatabase,
  receipt: SideChatSyncMainReceipt,
): SideChatSyncMainReceipt {
  const validated = sideChatSyncMainReceiptSchema.parse(receipt)
  const existing = database
    .select()
    .from(sideChatOperations)
    .where(eq(sideChatOperations.id, validated.operationId))
    .get()
  if (!existing || existing.kind !== 'sync_main') {
    throw new SideChatPersistenceError('Side-chat sync operation does not exist.')
  }
  if (existing.receiptJson) {
    const prior = sideChatSyncMainReceiptSchema.parse(JSON.parse(existing.receiptJson))
    if (
      prior.disposition !== validated.disposition ||
      prior.mainMessageId !== validated.mainMessageId ||
      prior.queuedOperationId !== validated.queuedOperationId
    ) {
      throw new SideChatPersistenceError('Side-chat sync operation already settled differently.')
    }
    return prior
  }
  const mainMessageId = deterministicUuid('side-chat-main-msg', existing.id)
  const mintedComments = database
    .select({
      id: anchoredComments.id,
      draftRevision: anchoredComments.draftRevision,
    })
    .from(anchoredComments)
    .where(
      and(
        eq(anchoredComments.sessionId, existing.targetSessionId),
        validated.disposition === 'sent'
          ? or(
              eq(anchoredComments.sentWithMessageId, mainMessageId),
              eq(anchoredComments.pendingReceiptId, mainMessageId),
            )
          : eq(anchoredComments.pendingReceiptId, mainMessageId),
      ),
    )
    .all()
  if (mintedComments.length > 0) {
    const draftByMintedId = new Map<string, { id: string; draftRevision: number }>()
    let afterDraftPos = -1
    while (true) {
      const page = database
        .select({
          id: anchoredComments.id,
          draftRevision: anchoredComments.draftRevision,
          position: anchoredComments.position,
        })
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.sessionId, existing.sessionId),
            isNull(anchoredComments.sentWithMessageId),
            isNull(anchoredComments.pendingReceiptId),
            gt(anchoredComments.position, afterDraftPos),
          ),
        )
        .orderBy(asc(anchoredComments.position))
        .limit(SQLITE_IN_CHUNK_SIZE)
        .all()
      if (page.length === 0) break
      for (const row of page) {
        draftByMintedId.set(deterministicUuid('side-chat-sync-comment', existing.id, row.id), {
          id: row.id,
          draftRevision: row.draftRevision,
        })
      }
      if (page.length < SQLITE_IN_CHUNK_SIZE) break
      afterDraftPos = page.at(-1)!.position
    }
    const consumedDraftIds: string[] = []
    for (const minted of mintedComments) {
      const sourceDraft = draftByMintedId.get(minted.id)
      if (!sourceDraft || sourceDraft.draftRevision !== minted.draftRevision) {
        throw new SideChatPersistenceError('Selected Comment draft is no longer current.')
      }
      consumedDraftIds.push(sourceDraft.id)
    }
    for (const chunk of chunkArray(consumedDraftIds)) {
      database.delete(anchoredComments).where(inArray(anchoredComments.id, chunk)).run()
    }
    database
      .update(sessions)
      .set({
        commentsRevision: sql`${sessions.commentsRevision} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sessions.id, existing.sessionId))
      .run()
  }
  database
    .update(sideChatOperations)
    .set({ receiptJson: JSON.stringify(validated) })
    .where(eq(sideChatOperations.id, validated.operationId))
    .run()
  return validated
}

function garbageCollectUnreferencedCutoffRevisions(
  database: PactDrizzleDatabase,
  sourceSessionId: string,
): void {
  const remainingCutoffs = database
    .select({
      id: conversationCutoffs.id,
      maxMessageSequence: conversationCutoffs.maxMessageSequence,
      sessionMutationSeq: conversationCutoffs.sessionMutationSeq,
    })
    .from(conversationCutoffs)
    .where(eq(conversationCutoffs.sourceSessionId, sourceSessionId))
    .all()

  const revisions = database
    .select({
      id: conversationCutoffRevisions.id,
      preservedMessageId: conversationCutoffRevisions.preservedMessageId,
      messageSequence: conversationCutoffRevisions.messageSequence,
      validUpToMutationSeq: conversationCutoffRevisions.validUpToMutationSeq,
      bodyInputId: conversationCutoffRevisions.bodyInputId,
    })
    .from(conversationCutoffRevisions)
    .where(eq(conversationCutoffRevisions.sourceSessionId, sourceSessionId))
    .orderBy(asc(conversationCutoffRevisions.validUpToMutationSeq))
    .all()

  if (!revisions.length) return

  const keepIds = new Set<string>()
  if (remainingCutoffs.length > 0) {
    const byMsg = new Map<string, typeof revisions>()
    for (const rev of revisions) {
      const list = byMsg.get(rev.preservedMessageId) ?? []
      list.push(rev)
      byMsg.set(rev.preservedMessageId, list)
    }
    for (const cutoff of remainingCutoffs) {
      for (const msgRevs of byMsg.values()) {
        if (msgRevs[0]!.messageSequence > cutoff.maxMessageSequence) continue
        const match = msgRevs.find((r) => r.validUpToMutationSeq >= cutoff.sessionMutationSeq)
        if (match) keepIds.add(match.id)
      }
    }
  }

  const dropIds: string[] = []
  const candidateBodyInputIds = new Set<string>()
  for (const rev of revisions) {
    if (!keepIds.has(rev.id)) {
      dropIds.push(rev.id)
      if (rev.bodyInputId) candidateBodyInputIds.add(rev.bodyInputId)
    }
  }

  for (const chunk of chunkArray(dropIds)) {
    database
      .delete(conversationCutoffRevisions)
      .where(inArray(conversationCutoffRevisions.id, chunk))
      .run()
  }

  for (const bodyInputId of candidateBodyInputIds) {
    const stillReferenced = database
      .select({ id: conversationCutoffRevisions.id })
      .from(conversationCutoffRevisions)
      .where(eq(conversationCutoffRevisions.bodyInputId, bodyInputId))
      .limit(1)
      .get()
    if (!stillReferenced) {
      database
        .delete(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.id, bodyInputId),
            eq(conversationBodyInputs.purpose, 'cutoff'),
          ),
        )
        .run()
    }
  }
  if (!remainingCutoffs.length) {
    database.run(sql`
      DELETE FROM conversation_body_inputs
      WHERE session_id = ${sourceSessionId}
        AND purpose = 'cutoff'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_cutoff_revisions r
          WHERE r.body_input_id = conversation_body_inputs.id
        )
    `)
  }
}

/**
 * Remove an untouched empty draft side chat and reclaim its cutoff metadata when nothing was
 * sent, typed/seeded as a durable input, uploaded, commented on, or run inside it.
 */
export function discardEmptySideChatInTransaction(
  database: PactDrizzleDatabase,
  sideChatId: string,
): boolean {
  const sideChat = database
    .select({
      id: sessions.id,
      parentSessionId: sessions.parentSessionId,
      status: sessions.status,
      archivedAt: sessions.archivedAt,
      anchorCutoffId: sessions.anchorCutoffId,
    })
    .from(sessions)
    .where(eq(sessions.id, sideChatId))
    .get()
  if (
    !sideChat ||
    !sideChat.parentSessionId ||
    sideChat.archivedAt !== null ||
    sideChat.status !== 'draft'
  ) {
    return false
  }

  const hasContent = Boolean(
    database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: collaborationInputs.id })
      .from(collaborationInputs)
      .where(eq(collaborationInputs.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: conversationImageAssets.id })
      .from(conversationImageAssets)
      .where(eq(conversationImageAssets.ownerSessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: conversationBodyInputs.id })
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: sideChatOperations.id })
      .from(sideChatOperations)
      .where(
        and(eq(sideChatOperations.sessionId, sideChatId), eq(sideChatOperations.kind, 'sync_main')),
      )
      .limit(1)
      .get() ||
    database
      .select({ id: anchoredComments.id })
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.sessionId, sideChatId),
          sql`(
              ${anchoredComments.sentWithMessageId} IS NOT NULL
              OR ${anchoredComments.pendingReceiptId} IS NOT NULL
              OR length(trim(${anchoredComments.body})) > 0
              OR ${anchoredComments.draftRevision} > 1
              OR json_extract(${anchoredComments.anchorJson}, '$.type') <> 'cutoff_message'
            )`,
        ),
      )
      .limit(1)
      .get() ||
    database
      .select({ id: workspaceArchiveOperations.id })
      .from(workspaceArchiveOperations)
      .where(eq(workspaceArchiveOperations.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: workspaceChangeSets.id })
      .from(workspaceChangeSets)
      .where(eq(workspaceChangeSets.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: sessionForkOperations.id })
      .from(sessionForkOperations)
      .where(eq(sessionForkOperations.sessionId, sideChatId))
      .limit(1)
      .get() ||
    database
      .select({ id: schedulingRuntimeOwners.id })
      .from(schedulingRuntimeOwners)
      .where(eq(schedulingRuntimeOwners.sessionId, sideChatId))
      .limit(1)
      .get(),
  )
  if (hasContent) return false

  database
    .delete(sideChatOperations)
    .where(and(eq(sideChatOperations.sessionId, sideChatId), eq(sideChatOperations.kind, 'create')))
    .run()
  database.delete(sessions).where(eq(sessions.id, sideChatId)).run()
  if (sideChat.anchorCutoffId) {
    database
      .delete(conversationCutoffs)
      .where(
        and(
          eq(conversationCutoffs.id, sideChat.anchorCutoffId),
          eq(conversationCutoffs.ownerKind, 'side_chat'),
        ),
      )
      .run()
  }
  garbageCollectUnreferencedCutoffRevisions(database, sideChat.parentSessionId)
  return true
}

/** Roll back an unfinalized @Main sync-back preparation so rejected sends leave zero orphaned rows. */
export function rollbackMainSyncBackInTransaction(
  database: PactDrizzleDatabase,
  operationId: string,
): boolean {
  const existing = database
    .select()
    .from(sideChatOperations)
    .where(and(eq(sideChatOperations.id, operationId), eq(sideChatOperations.kind, 'sync_main')))
    .get()
  if (!existing || existing.receiptJson) return false

  const mainMessageId = deterministicUuid('side-chat-main-msg', operationId)
  const materialized = database
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, mainMessageId))
    .get()
  const queued = database
    .select({ id: collaborationInputs.id })
    .from(collaborationInputs)
    .where(eq(collaborationInputs.id, mainMessageId))
    .get()
  if (materialized || queued) return false

  database
    .delete(anchoredComments)
    .where(
      and(
        eq(anchoredComments.sessionId, existing.targetSessionId),
        eq(anchoredComments.pendingReceiptId, mainMessageId),
        isNull(anchoredComments.sentWithMessageId),
      ),
    )
    .run()
  database
    .delete(conversationImageAssets)
    .where(
      and(
        eq(conversationImageAssets.ownerSessionId, existing.targetSessionId),
        eq(conversationImageAssets.pendingReceiptId, mainMessageId),
        eq(conversationImageAssets.committed, false),
      ),
    )
    .run()
  database
    .delete(conversationCutoffs)
    .where(
      and(
        eq(conversationCutoffs.ownerKind, 'sync_main'),
        eq(conversationCutoffs.ownerOperationId, operationId),
      ),
    )
    .run()
  garbageCollectUnreferencedCutoffRevisions(database, existing.sessionId)
  database
    .delete(sideChatOperations)
    .where(and(eq(sideChatOperations.id, operationId), isNull(sideChatOperations.receiptJson)))
    .run()
  return true
}

/** Reconcile incomplete @Main sync-back operations on startup (finalize committed sends/queues or roll back orphans). */
export function recoverIncompleteSyncMainOperations(database: PactDrizzleDatabase): void {
  const incomplete = database
    .select()
    .from(sideChatOperations)
    .where(and(eq(sideChatOperations.kind, 'sync_main'), isNull(sideChatOperations.receiptJson)))
    .all()

  for (const op of incomplete) {
    database.transaction((transaction) => {
      const mainMessageId = deterministicUuid('side-chat-main-msg', op.id)
      const cutoff = transaction
        .select({ id: conversationCutoffs.id })
        .from(conversationCutoffs)
        .where(
          and(
            eq(conversationCutoffs.ownerKind, 'sync_main'),
            eq(conversationCutoffs.ownerOperationId, op.id),
          ),
        )
        .get()
      const committedMessage = transaction
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, mainMessageId))
        .get()
      if (committedMessage && cutoff) {
        finalizeMainSyncBackReceipt(transaction, {
          operationId: op.id,
          sideChatId: op.sessionId,
          parentSessionId: op.targetSessionId,
          cutoffId: cutoff.id,
          disposition: 'sent',
          mainMessageId: committedMessage.id,
          queuedOperationId: null,
        })
        return
      }
      const queuedInput = transaction
        .select({ id: collaborationInputs.id })
        .from(collaborationInputs)
        .where(eq(collaborationInputs.id, mainMessageId))
        .get()
      if (queuedInput && cutoff) {
        finalizeMainSyncBackReceipt(transaction, {
          operationId: op.id,
          sideChatId: op.sessionId,
          parentSessionId: op.targetSessionId,
          cutoffId: cutoff.id,
          disposition: 'queued',
          mainMessageId: null,
          queuedOperationId: queuedInput.id,
        })
        return
      }
      rollbackMainSyncBackInTransaction(transaction, op.id)
    })
  }
}

export function readCreateSideChatReceiptRecord(
  database: PactDrizzleDatabase,
  operationId: string,
): CreateSideChatReceipt | undefined {
  const row = database
    .select({ receiptJson: sideChatOperations.receiptJson })
    .from(sideChatOperations)
    .where(and(eq(sideChatOperations.id, operationId), eq(sideChatOperations.kind, 'create')))
    .get()
  return row?.receiptJson
    ? createSideChatReceiptSchema.parse(JSON.parse(row.receiptJson))
    : undefined
}

export function readSyncMainReceiptRecord(
  database: PactDrizzleDatabase,
  operationId: string,
): SideChatSyncMainReceipt | undefined {
  const row = database
    .select({ receiptJson: sideChatOperations.receiptJson })
    .from(sideChatOperations)
    .where(and(eq(sideChatOperations.id, operationId), eq(sideChatOperations.kind, 'sync_main')))
    .get()
  return row?.receiptJson
    ? sideChatSyncMainReceiptSchema.parse(JSON.parse(row.receiptJson))
    : undefined
}

export interface SideChatAnchorCutoffInfo {
  cutoffId: string
  origin: 'selection' | 'btw'
  sourceSessionId: string
  maxMessageSequence: number
  selectionAnchor?: {
    messageId: string
    quotePreview: string
    quoteTruncated: boolean
    quoteBytes: number
    startOffset: number
    endOffset: number
  }
}

export interface MessageOriginCutoffInfo {
  messageId: string
  originSideChat: OriginSideChat
  maxMessageSequence: number
}

export function readSideChatAnchorCutoff(
  database: PactDrizzleDatabase,
  sessionId: string,
): SideChatAnchorCutoffInfo | undefined {
  const row = database
    .select({
      cutoffId: conversationCutoffs.id,
      origin: sessions.sideChatOrigin,
      sourceSessionId: conversationCutoffs.sourceSessionId,
      maxMessageSequence: conversationCutoffs.maxMessageSequence,
      anchorMessageId: sessions.anchorMessageId,
      anchorQuote: sessions.anchorQuote,
      anchorQuotePreview: sessions.anchorQuotePreview,
      anchorStartOffset: sessions.anchorStartOffset,
      anchorEndOffset: sessions.anchorEndOffset,
    })
    .from(sessions)
    .innerJoin(conversationCutoffs, eq(conversationCutoffs.id, sessions.anchorCutoffId))
    .where(eq(sessions.id, sessionId))
    .get()
  if (!row || !row.origin) return undefined
  if (
    row.origin === 'selection' &&
    row.anchorMessageId &&
    row.anchorQuote !== null &&
    row.anchorQuotePreview !== null &&
    row.anchorStartOffset !== null &&
    row.anchorEndOffset !== null
  ) {
    const quoteBytes = Buffer.byteLength(row.anchorQuote, 'utf8')
    const quotePreview = trimToUtf8ByteLimit(row.anchorQuotePreview, 512)
    return {
      cutoffId: row.cutoffId,
      origin: row.origin,
      sourceSessionId: row.sourceSessionId,
      maxMessageSequence: row.maxMessageSequence,
      selectionAnchor: {
        messageId: row.anchorMessageId,
        quotePreview,
        quoteTruncated:
          quotePreview !== row.anchorQuote || row.anchorQuotePreview !== row.anchorQuote,
        quoteBytes,
        startOffset: row.anchorStartOffset,
        endOffset: row.anchorEndOffset,
      },
    }
  }
  return {
    cutoffId: row.cutoffId,
    origin: row.origin,
    sourceSessionId: row.sourceSessionId,
    maxMessageSequence: row.maxMessageSequence,
  }
}

export function readMessageOriginCutoffs(
  database: PactDrizzleDatabase,
  sessionId: string,
  messageIds: readonly string[],
): MessageOriginCutoffInfo[] {
  const uniqueIds = [...new Set(messageIds)]
  if (!uniqueIds.length) return []
  const parsed: Array<{ messageId: string; originSideChat: OriginSideChat }> = []
  for (let start = 0; start < uniqueIds.length; start += 256) {
    const chunk = uniqueIds.slice(start, start + 256)
    const rows = database
      .select({
        messageId: conversationMessages.id,
        originSideChatJson: conversationMessages.originSideChatJson,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          inArray(conversationMessages.id, chunk),
          isNotNull(conversationMessages.originSideChatJson),
        ),
      )
      .all()
    for (const row of rows) {
      parsed.push({
        messageId: row.messageId,
        originSideChat: originSideChatSchema.parse(JSON.parse(row.originSideChatJson!)),
      })
    }
  }
  const cutoffIds = [...new Set(parsed.map((item) => item.originSideChat.cutoffId))]
  if (!cutoffIds.length) return []
  const cutoffs = new Map<string, number>()
  for (let start = 0; start < cutoffIds.length; start += 256) {
    const chunk = cutoffIds.slice(start, start + 256)
    const rows = database
      .select({
        id: conversationCutoffs.id,
        maxMessageSequence: conversationCutoffs.maxMessageSequence,
      })
      .from(conversationCutoffs)
      .where(
        and(inArray(conversationCutoffs.id, chunk), gte(conversationCutoffs.maxMessageSequence, 0)),
      )
      .all()
    for (const row of rows) cutoffs.set(row.id, row.maxMessageSequence)
  }
  return parsed.flatMap((item) => {
    const maxMessageSequence = cutoffs.get(item.originSideChat.cutoffId)
    return maxMessageSequence === undefined
      ? []
      : [{ messageId: item.messageId, originSideChat: item.originSideChat, maxMessageSequence }]
  })
}

export function parseDeliveredCutoffIds(json: string | null | undefined): string[] {
  if (!json) return []
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

export function mergeDeliveredCutoffIds(
  database: PactDrizzleDatabase,
  sessionId: string,
  agentId: RuntimeAgentId,
  bindingGeneration: number,
  cutoffIds: string[],
): string[] {
  const context = database
    .select({
      bindingGeneration: nativeAgentContexts.bindingGeneration,
      deliveredCutoffIdsJson: nativeAgentContexts.deliveredCutoffIdsJson,
    })
    .from(nativeAgentContexts)
    .where(
      and(eq(nativeAgentContexts.sessionId, sessionId), eq(nativeAgentContexts.agentId, agentId)),
    )
    .get()
  if (!context || context.bindingGeneration !== bindingGeneration) return []
  const merged = [
    ...new Set([...parseDeliveredCutoffIds(context.deliveredCutoffIdsJson), ...cutoffIds]),
  ]
  const bounded =
    merged.length > DELIVERED_CUTOFF_MAX_ITEMS ? merged.slice(-DELIVERED_CUTOFF_MAX_ITEMS) : merged
  database
    .update(nativeAgentContexts)
    .set({ deliveredCutoffIdsJson: JSON.stringify(bounded) })
    .where(
      and(
        eq(nativeAgentContexts.sessionId, sessionId),
        eq(nativeAgentContexts.agentId, agentId),
        eq(nativeAgentContexts.bindingGeneration, bindingGeneration),
      ),
    )
    .run()
  return bounded
}
