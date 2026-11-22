import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

import {
  FROZEN_EXECUTION_INPUT_ITEMS,
  storedCommentAnchor,
  type AnchoredComment,
  type CommentAnchor,
  type CommentDraftRemoveInput,
  type CommentDraftSaveInput,
  type ConversationMessage,
  type ConversationPatch,
  type CreateSideChatInput,
  type CreateSideChatReceipt,
  type RuntimeAgentId,
  type SideChatSyncMainInput,
  type SideChatSyncMainReceipt,
} from '@pact/contracts'
import {
  conversationImageSchema,
  IMAGE_ORIGINAL_WORK_BYTES,
  IMAGE_REFERENCE_ITEMS,
  type ConversationImage,
} from '@pact/contracts/images'

import type { ConversationRepositoryHost } from './context.js'

import * as forkFacts from '../conversation-fork.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  commentDraftReceipts,
  conversationBodyInputs,
  conversationBodyParts,
  conversationImageAssets,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationMessageImages,
  conversationMessages,
  conversationQueueOperations,
  nativeRebuildOperations,
  sessionForkOperations,
  sessions,
  type nativeForkIntents,
} from '../schema/index.js'
import {
  buildCutoffInlineTail as buildSideChatCutoffInlineTail,
  captureCutoffInTransaction,
  createSideChatInTransaction,
  discardEmptySideChatInTransaction,
  finalizeMainSyncBackReceipt,
  mergeDeliveredCutoffIds,
  parseDeliveredCutoffIds,
  prepareMainSyncBackInTransaction,
  readCreateSideChatReceiptRecord,
  readMessageOriginCutoffs,
  readSideChatAnchorCutoff,
  readCutoffSource as readSideChatCutoffSource,
  readSyncMainReceiptRecord,
  rollbackMainSyncBackInTransaction,
  hasSideChatDrafts as sessionHasSideChatDrafts,
  type CapturedCutoffRecord,
  type CutoffCatalogItem,
  type CutoffInlineTailResult,
  type CutoffSourcePage,
  type MessageOriginCutoffInfo,
  type PrepareMainSyncBackResult,
  type SideChatAnchorCutoffInfo,
} from '../side-chat-persistence.js'
import { toComment, validBodyText } from './helpers.js'
import {
  BODY_APP_PARTS,
  BODY_APP_STORAGE_BYTES,
  BODY_INPUT_PARTS,
  BODY_INTERNAL_READ_BYTES,
  BODY_OWNER_INPUTS,
  BODY_OWNER_PARTS,
  BODY_OWNER_STORAGE_BYTES,
  BODY_PART_UNITS,
  BODY_TEMP_TTL_MS,
  COLLABORATION_INDEX_ITEMS,
  RunOperationConflictError,
  type ConversationInputReceipt,
  type ConversationInputWrite,
  type ImageAssetRecord,
} from './types.js'

export function recoverAbandonedBodyInputs(repo: ConversationRepositoryHost): void {
  // Utility owns one Repository instance. A new owner cannot reuse earlier window handles.
  repo.database
    .delete(conversationBodyInputs)
    .where(
      and(
        ne(conversationBodyInputs.purpose, 'cutoff'),
        isNull(conversationBodyInputs.committedMessageId),
        isNull(conversationBodyInputs.pendingReceiptId),
        or(
          isNull(conversationBodyInputs.sourceRunId),
          eq(conversationBodyInputs.purpose, 'answer'),
        ),
      ),
    )
    .run()
}

export function imageRecord(
  repo: ConversationRepositoryHost,
  id: string,
): ImageAssetRecord | undefined {
  return repo.database
    .select()
    .from(conversationImageAssets)
    .where(eq(conversationImageAssets.id, id))
    .get()
}

export function beginImage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  clientImageId: string,
  name: string,
  ownerKey: string,
): ImageAssetRecord {
  return repo.database.transaction(() => {
    const existing = imageRecord(repo, clientImageId)
    if (existing) {
      if (
        existing.ownerSessionId !== sessionId ||
        existing.ownerKey !== ownerKey ||
        existing.name !== name
      )
        throw new RunOperationConflictError('This image ID belongs to a different input.')
      return existing
    }
    if (
      !repo.database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()
    )
      throw new RunOperationConflictError('The image Session is unavailable.')
    assertImageCapacity(repo, ownerKey, 0, true)
    const count = repo.database
      .select({ value: sql<number>`count(*)` })
      .from(conversationImageAssets)
      .where(
        and(
          eq(conversationImageAssets.ownerKey, ownerKey),
          eq(conversationImageAssets.committed, false),
        ),
      )
      .get()!.value
    if (count >= BODY_OWNER_INPUTS)
      throw new RunOperationConflictError(
        'This window has too many prepared images. Remove an unused image and try again.',
      )
    const now = new Date().toISOString()
    repo.database
      .insert(conversationImageAssets)
      .values({
        id: clientImageId,
        storageObjectId: randomUUID(),
        ownerKey,
        ownerSessionId: sessionId,
        name,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return imageRecord(repo, clientImageId)!
  })
}

/** Indexed uncommitted storage only: durable image history never enters upload admission. */
export function assertImageCapacity(
  repo: ConversationRepositoryHost,
  ownerKey: string,
  addedBytes: number,
  newIdentity = false,
): void {
  if (!Number.isSafeInteger(addedBytes) || addedBytes < 0)
    throw new RunOperationConflictError('Invalid image upload size.')
  const global = repo.database.get<{ bytes: number; count: number }>(sql`
      SELECT coalesce(sum(bytes + thumbnail_bytes), 0) AS bytes, count(*) AS count
      FROM conversation_image_assets INDEXED BY conversation_image_assets_temp_idx WHERE committed=0
    `)
  const owner = repo.database
    .select({
      bytes: sql<number>`coalesce(sum(${conversationImageAssets.bytes} + ${conversationImageAssets.thumbnailBytes}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(conversationImageAssets)
    .where(
      and(
        eq(conversationImageAssets.ownerKey, ownerKey),
        eq(conversationImageAssets.committed, false),
      ),
    )
    .get()!
  if (
    global.bytes + addedBytes > BODY_APP_STORAGE_BYTES ||
    global.count + (newIdentity ? 1 : 0) > BODY_OWNER_INPUTS ||
    owner.bytes + addedBytes > BODY_OWNER_STORAGE_BYTES ||
    owner.count > BODY_OWNER_INPUTS
  )
    throw new RunOperationConflictError(
      'Prepared image storage is full. Remove an unused image and try again.',
    )
}

function ownedTemporaryImage(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  ownerKey: string,
): ImageAssetRecord {
  const image = imageRecord(repo, id)
  if (
    !image ||
    image.ownerSessionId !== sessionId ||
    image.ownerKey !== ownerKey ||
    image.committed
  )
    throw new RunOperationConflictError('This prepared image belongs to another owner.')
  return image
}

export function advanceImage(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  ownerKey: string,
  expectedOffset: number,
  nextOffset: number,
): ImageAssetRecord {
  return repo.database.transaction(() => {
    const image = ownedTemporaryImage(repo, id, sessionId, ownerKey)
    if (
      image.ready ||
      image.bytes !== expectedOffset ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset <= expectedOffset ||
      nextOffset > IMAGE_ORIGINAL_WORK_BYTES
    )
      throw new RunOperationConflictError(
        'The image upload offset is invalid or the image is already sealed.',
      )
    assertImageCapacity(repo, ownerKey, nextOffset - expectedOffset)
    repo.database
      .update(conversationImageAssets)
      .set({ bytes: nextOffset, updatedAt: new Date().toISOString() })
      .where(eq(conversationImageAssets.id, id))
      .run()
    return imageRecord(repo, id)!
  })
}

export function sealImage(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  ownerKey: string,
  meta: ConversationImage,
  thumbnailBytes: number,
): ConversationImage {
  return repo.database.transaction(() => {
    const image = ownedTemporaryImage(repo, id, sessionId, ownerKey)
    const parsed = conversationImageSchema.parse(meta)
    if (
      image.id !== parsed.id ||
      image.name !== parsed.name ||
      image.bytes !== parsed.bytes ||
      !Number.isSafeInteger(thumbnailBytes) ||
      thumbnailBytes < 0
    )
      throw new RunOperationConflictError('The image upload does not match its verified file.')
    if (image.ready) {
      if (
        JSON.stringify(publicImage(repo, image)) !== JSON.stringify(parsed) ||
        image.thumbnailBytes !== thumbnailBytes
      )
        throw new RunOperationConflictError('A sealed image is immutable.')
      return parsed
    }
    assertImageCapacity(repo, ownerKey, thumbnailBytes)
    repo.database
      .update(conversationImageAssets)
      .set({
        ready: true,
        mediaType: parsed.mediaType,
        width: parsed.width,
        height: parsed.height,
        sha256: parsed.sha256,
        thumbnailBytes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversationImageAssets.id, id))
      .run()
    return parsed
  })
}

export function imageStorageObjectId(
  repo: ConversationRepositoryHost,
  id: string,
): string | undefined {
  const row = imageRecord(repo, id)
  return row ? (row.storageObjectId ?? row.id) : undefined
}

export function imageStorageObjectReferenced(
  repo: ConversationRepositoryHost,
  storageObjectId: string,
): boolean {
  return Boolean(
    repo.database
      .select({ id: conversationImageAssets.id })
      .from(conversationImageAssets)
      .where(
        or(
          eq(conversationImageAssets.storageObjectId, storageObjectId),
          and(
            isNull(conversationImageAssets.storageObjectId),
            eq(conversationImageAssets.id, storageObjectId),
          ),
        ),
      )
      .limit(1)
      .get(),
  )
}

export function releaseImageAsset(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  ownerKey: string,
): { released: boolean; deleteStorageObjectId: string | null } {
  return repo.database.transaction(() => {
    const image = imageRecord(repo, id)
    if (!image) {
      return {
        released: true,
        deleteStorageObjectId: imageStorageObjectReferenced(repo, id) ? null : id,
      }
    }
    if (image.committed) return { released: false, deleteStorageObjectId: null }
    if (image.ownerSessionId !== sessionId || image.ownerKey !== ownerKey)
      throw new RunOperationConflictError('This image belongs to another owner.')
    const storageObjectId = image.storageObjectId ?? image.id
    repo.database
      .delete(conversationImageAssets)
      .where(and(eq(conversationImageAssets.id, id), eq(conversationImageAssets.committed, false)))
      .run()
    return {
      released: true,
      deleteStorageObjectId: imageStorageObjectReferenced(repo, storageObjectId)
        ? null
        : storageObjectId,
    }
  })
}

export function releaseImage(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  ownerKey: string,
): boolean {
  const outcome = releaseImageAsset(repo, id, sessionId, ownerKey)
  return outcome.released && outcome.deleteStorageObjectId !== null
}

/** Cleanup is paged. The file owner releases this batch before requesting the next. */
export function temporaryImages(
  repo: ConversationRepositoryHost,
  ownerKey?: string,
  restart = false,
): ImageAssetRecord[] {
  return repo.database
    .select()
    .from(conversationImageAssets)
    .where(
      and(
        eq(conversationImageAssets.committed, false),
        ownerKey === undefined
          ? restart
            ? undefined
            : lt(
                conversationImageAssets.updatedAt,
                new Date(Date.now() - BODY_TEMP_TTL_MS).toISOString(),
              )
          : eq(conversationImageAssets.ownerKey, ownerKey),
      ),
    )
    .orderBy(asc(conversationImageAssets.updatedAt), asc(conversationImageAssets.id))
    .limit(BODY_OWNER_INPUTS)
    .all()
}

function publicImage(repo: ConversationRepositoryHost, row: ImageAssetRecord): ConversationImage {
  if (!row.ready) throw new RunOperationConflictError('The image upload is not complete.')
  return conversationImageSchema.parse({
    id: row.id,
    name: row.name,
    bytes: row.bytes,
    mediaType: row.mediaType,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
  })
}

export function imagesForMessages(
  repo: ConversationRepositoryHost,
  messageIds: string[],
): Map<string, ConversationImage[]> {
  const result = new Map<string, ConversationImage[]>()
  if (!messageIds.length) return result
  // Every production caller supplies one Patch or one <=25-item page.
  const rows = repo.database
    .select({
      messageId: conversationMessageImages.messageId,
      image: getTableColumns(conversationImageAssets),
    })
    .from(conversationMessageImages)
    .innerJoin(
      conversationImageAssets,
      eq(conversationImageAssets.id, conversationMessageImages.imageId),
    )
    .where(inArray(conversationMessageImages.messageId, messageIds))
    .orderBy(asc(conversationMessageImages.messageId), asc(conversationMessageImages.ordinal))
    .limit(messageIds.length * IMAGE_REFERENCE_ITEMS + 1)
    .all()
  for (const row of rows) {
    const images = result.get(row.messageId) ?? []
    if (images.length >= IMAGE_REFERENCE_ITEMS)
      throw new RunOperationConflictError('Saved image references exceed their metadata capacity.')
    images.push(publicImage(repo, row.image))
    result.set(row.messageId, images)
  }
  return result
}

export function imagesForMessage(
  repo: ConversationRepositoryHost,
  messageId: string,
  sessionId?: string,
): ConversationImage[] {
  if (
    sessionId !== undefined &&
    !repo.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
      )
      .get()
  )
    return []
  return imagesForMessages(repo, [messageId]).get(messageId) ?? []
}

export function messageImageMetadata(
  repo: ConversationRepositoryHost,
  messageId: string,
): Pick<ConversationMessage, 'images'> {
  const images = imagesForMessage(repo, messageId)
  return images.length ? { images } : {}
}

export function imageAccessible(
  repo: ConversationRepositoryHost,
  sessionId: string,
  id: string,
  ownerKey?: string,
): boolean {
  const image = imageRecord(repo, id)
  if (!image?.ready) return false
  if (image.pendingReceiptId) return image.ownerSessionId === sessionId
  if (!image.committed) return image.ownerSessionId === sessionId && image.ownerKey === ownerKey
  return Boolean(
    repo.database
      .select({ id: conversationMessageImages.imageId })
      .from(conversationMessageImages)
      .innerJoin(
        conversationMessages,
        eq(conversationMessages.id, conversationMessageImages.messageId),
      )
      .where(
        and(
          eq(conversationMessageImages.imageId, id),
          eq(conversationMessages.sessionId, sessionId),
        ),
      )
      .limit(1)
      .get(),
  )
}

export function resolveMessageImages(
  repo: ConversationRepositoryHost,
  sessionId: string,
  ids: string[],
  ownerKey?: string,
): ConversationImage[] {
  if (ids.length > IMAGE_REFERENCE_ITEMS || new Set(ids).size !== ids.length)
    throw new RunOperationConflictError(
      'Image references are invalid or exceed their metadata capacity.',
    )
  return ids.map((id) => {
    if (!imageAccessible(repo, sessionId, id, ownerKey))
      throw new RunOperationConflictError('An image is unavailable or belongs to another Session.')
    return publicImage(repo, imageRecord(repo, id)!)
  })
}

export function sweepConversationInputs(repo: ConversationRepositoryHost, ownerKey?: string): void {
  repo.database
    .delete(conversationBodyInputs)
    .where(
      and(
        ne(conversationBodyInputs.purpose, 'cutoff'),
        isNull(conversationBodyInputs.committedMessageId),
        isNull(conversationBodyInputs.pendingReceiptId),
        isNull(conversationBodyInputs.sourceRunId),
        ownerKey === undefined
          ? lt(
              conversationBodyInputs.updatedAt,
              new Date(Date.now() - BODY_TEMP_TTL_MS).toISOString(),
            )
          : eq(conversationBodyInputs.ownerKey, ownerKey),
      ),
    )
    .run()
}

export function releaseConversationInputs(
  repo: ConversationRepositoryHost,
  ownerKey: string,
): void {
  sweepConversationInputs(repo, ownerKey)
}

export function captureCutoff(
  repo: ConversationRepositoryHost,
  input: {
    sourceSessionId: string
    ownerKind: 'side_chat' | 'sync_main'
    ownerOperationId: string
  },
): CapturedCutoffRecord {
  return repo.database.transaction((transaction) => captureCutoffInTransaction(transaction, input))
}

export function readCutoffSource(
  repo: ConversationRepositoryHost,
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
  return readSideChatCutoffSource(repo.database, input, fits)
}

export function buildCutoffInlineTail(
  repo: ConversationRepositoryHost,
  cutoffId: string,
  maxBytes?: number,
): CutoffInlineTailResult {
  return buildSideChatCutoffInlineTail(repo.database, cutoffId, maxBytes)
}

export function createSideChat(
  repo: ConversationRepositoryHost,
  input: CreateSideChatInput,
  options?: { resolveVisibleText?: (content: string) => string },
): CreateSideChatReceipt {
  return repo.database.transaction((transaction) =>
    createSideChatInTransaction(transaction, input, options),
  )
}

export function readCreateSideChatReceipt(
  repo: ConversationRepositoryHost,
  operationId: string,
): CreateSideChatReceipt | undefined {
  return readCreateSideChatReceiptRecord(repo.database, operationId)
}

export function prepareMainSyncBack(
  repo: ConversationRepositoryHost,
  input: SideChatSyncMainInput,
  imageOwnerKey?: string,
  resolvedContent?: string,
  options?: { resolveVisibleText?: (content: string) => string },
): PrepareMainSyncBackResult {
  return repo.database.transaction((transaction) =>
    prepareMainSyncBackInTransaction(
      transaction,
      input,
      (sessionId, ids, ownerKey) => resolveMessageImages(repo, sessionId, ids, ownerKey),
      imageOwnerKey,
      resolvedContent,
      options,
    ),
  )
}

export function hasSideChatDrafts(repo: ConversationRepositoryHost, sideChatId: string): boolean {
  return sessionHasSideChatDrafts(repo.database, sideChatId)
}

export function completeMainSyncBackReceipt(
  repo: ConversationRepositoryHost,
  receipt: SideChatSyncMainReceipt,
): SideChatSyncMainReceipt {
  return repo.database.transaction((transaction) =>
    finalizeMainSyncBackReceipt(transaction, receipt),
  )
}

export function readSyncSideChatReceipt(
  repo: ConversationRepositoryHost,
  operationId: string,
): SideChatSyncMainReceipt | undefined {
  return readSyncMainReceiptRecord(repo.database, operationId)
}

export function rollbackMainSyncBack(
  repo: ConversationRepositoryHost,
  operationId: string,
): boolean {
  return repo.database.transaction((transaction) =>
    rollbackMainSyncBackInTransaction(transaction, operationId),
  )
}

export function deliveredCutoffIds(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  expectedBindingGeneration?: number,
): string[] {
  const row = repo.sourceQueries.nativeContext().get({ sessionId, agentId })
  if (!row) return []
  if (
    expectedBindingGeneration !== undefined &&
    row.bindingGeneration !== expectedBindingGeneration
  )
    return []
  return parseDeliveredCutoffIds(row.deliveredCutoffIdsJson)
}

export function markCutoffsDelivered(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  bindingGeneration: number,
  cutoffIds: string[],
): string[] {
  return repo.database.transaction((transaction) =>
    mergeDeliveredCutoffIds(transaction, sessionId, agentId, bindingGeneration, cutoffIds),
  )
}

export function sideChatAnchorCutoff(
  repo: ConversationRepositoryHost,
  sessionId: string,
): SideChatAnchorCutoffInfo | undefined {
  return readSideChatAnchorCutoff(repo.database, sessionId)
}

export function messageOriginCutoffs(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageIds: readonly string[],
): MessageOriginCutoffInfo[] {
  return readMessageOriginCutoffs(repo.database, sessionId, messageIds)
}

export function discardEmptySideChat(
  repo: ConversationRepositoryHost,
  sideChatId: string,
): boolean {
  return repo.database.transaction((transaction) =>
    discardEmptySideChatInTransaction(transaction, sideChatId),
  )
}

export function bodyHasText(
  repo: ConversationRepositoryHost,
  row: typeof conversationBodyInputs.$inferSelect,
): boolean {
  let offset = 0
  const deadline = Date.now() + 5000
  while (offset < row.chars) {
    if (Date.now() >= deadline)
      throw new RunOperationConflictError(
        'Input text validation timed out; the original draft remains saved.',
      )
    const parts = repo.database
      .select({ offset: conversationBodyParts.offset, text: conversationBodyParts.text })
      .from(conversationBodyParts)
      .where(
        and(eq(conversationBodyParts.inputId, row.id), gte(conversationBodyParts.offset, offset)),
      )
      .orderBy(asc(conversationBodyParts.offset))
      .limit(24)
      .all()
    if (!parts.length)
      throw new RunOperationConflictError('The sealed input text has missing parts.')
    for (const part of parts) {
      if (part.offset !== offset)
        throw new RunOperationConflictError('The sealed input text changed.')
      if (/\S/u.test(part.text)) return true
      offset += part.text.length
    }
  }
  return false
}

export function bodyInput(
  repo: ConversationRepositoryHost,
  inputId: string,
  sessionId: string,
  ownerKey: string,
  allowCommitted = false,
): typeof conversationBodyInputs.$inferSelect {
  const row = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.id, inputId),
        eq(conversationBodyInputs.sessionId, sessionId),
        eq(conversationBodyInputs.ownerKey, ownerKey),
        ...(allowCommitted ? [] : [isNull(conversationBodyInputs.committedMessageId)]),
      ),
    )
    .get()
  if (
    !row ||
    (!row.committedMessageId &&
      !row.pendingReceiptId &&
      !row.sourceRunId &&
      Date.parse(row.updatedAt) + BODY_TEMP_TTL_MS <= Date.now())
  )
    throw new RunOperationConflictError(
      'This prepared body is expired or belongs to another owner.',
    )
  return row
}

function bodyReceipt(
  repo: ConversationRepositoryHost,
  row: typeof conversationBodyInputs.$inferSelect,
): ConversationInputReceipt {
  return {
    inputId: row.id,
    offset: row.chars,
    sealed: row.sealed,
    bytes: row.bytes,
    chars: row.chars,
  }
}

export function bodyCapacity(
  repo: ConversationRepositoryHost,
  ownerKey: string,
  addedBytes: number,
  newIdentity = false,
  addedParts = 0,
): void {
  // Force the partial capacity index: committed Journal/input identities must not
  // become work on every subsequent append as durable history grows.
  const global = repo.database.get<{ bytes: number; parts: number }>(sql`
      SELECT coalesce(sum(bytes), 0) AS bytes, coalesce(sum(parts), 0) AS parts
      FROM conversation_body_inputs INDEXED BY conversation_body_inputs_bytes_idx
      WHERE committed_message_id IS NULL AND pending_receipt_id IS NULL AND source_run_id IS NULL AND purpose <> 'cutoff'
    `)
  const owner = repo.database
    .select({
      bytes: sql<number>`coalesce(sum(${conversationBodyInputs.bytes}), 0)`,
      count: sql<number>`count(*)`,
      parts: sql<number>`coalesce(sum(${conversationBodyInputs.parts}), 0)`,
    })
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.ownerKey, ownerKey),
        ne(conversationBodyInputs.purpose, 'cutoff'),
        isNull(conversationBodyInputs.committedMessageId),
        isNull(conversationBodyInputs.pendingReceiptId),
        isNull(conversationBodyInputs.sourceRunId),
      ),
    )
    .get()!
  if (
    global.bytes + addedBytes > BODY_APP_STORAGE_BYTES ||
    owner.bytes + addedBytes > BODY_OWNER_STORAGE_BYTES ||
    (newIdentity && owner.count >= BODY_OWNER_INPUTS) ||
    global.parts + addedParts > BODY_APP_PARTS ||
    owner.parts + addedParts > BODY_OWNER_PARTS
  )
    throw new RunOperationConflictError(
      'Prepared body storage capacity is full. Existing content was preserved.',
    )
}

export function writeConversationInput(
  repo: ConversationRepositoryHost,
  input: ConversationInputWrite,
  ownerKey: string,
): ConversationInputReceipt {
  if (!ownerKey || ownerKey.length > 1024)
    throw new RunOperationConflictError('Invalid body owner.')
  sweepConversationInputs(repo)
  return repo.database.transaction(() => {
    if (input.type === 'begin') {
      if (
        !repo.database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .get()
      )
        throw new RunOperationConflictError('Conversation Session is unavailable.')
      const old = repo.database
        .select()
        .from(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.ownerKey, ownerKey),
            eq(conversationBodyInputs.sessionId, input.sessionId),
            eq(conversationBodyInputs.clientMessageId, input.clientMessageId),
            eq(conversationBodyInputs.purpose, 'input'),
          ),
        )
        .orderBy(desc(conversationBodyInputs.createdAt))
        .get()
      if (old) {
        repo.database
          .update(conversationBodyInputs)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(conversationBodyInputs.id, old.id))
          .run()
        return bodyReceipt(repo, old)
      }
      bodyCapacity(repo, ownerKey, 0, true)
      const now = new Date().toISOString()
      const row = {
        id: randomUUID(),
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        ownerKey,
        purpose: 'input' as const,
        bytes: 0,
        chars: 0,
        parts: 0,
        sealed: false,
        hash: null,
        committedMessageId: null,
        pendingReceiptId: null,
        sourceRunId: null,
        projectionPages: null,
        projectionBasis: null,
        createdAt: now,
        updatedAt: now,
      }
      repo.database.insert(conversationBodyInputs).values(row).run()
      return bodyReceipt(repo, row)
    }
    if (input.type === 'release') {
      const prior = repo.database
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, input.inputId))
        .get()
      if (!prior) return { inputId: input.inputId, offset: 0, sealed: false, bytes: 0, chars: 0 }
      if (
        prior.sessionId !== input.sessionId ||
        prior.ownerKey !== ownerKey ||
        prior.purpose !== 'input'
      )
        throw new RunOperationConflictError('This body belongs to another owner.')
      if (
        prior.pendingReceiptId ||
        repo.database
          .select({ id: collaborationInputs.id })
          .from(collaborationInputs)
          .where(eq(collaborationInputs.inputId, prior.id))
          .limit(1)
          .get()
      )
        return bodyReceipt(repo, prior)
      repo.database
        .delete(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, prior.id))
        .run()
      return bodyReceipt(repo, prior)
    }
    const row = bodyInput(repo, input.inputId, input.sessionId, ownerKey)
    if (row.purpose !== 'input') throw new RunOperationConflictError('Invalid input body kind.')
    if (input.type === 'seal') return sealBody(repo, row)
    return appendBodyPart(repo, row, input.offset, input.text)
  })
}

export function appendBodyPart(
  repo: ConversationRepositoryHost,
  row: typeof conversationBodyInputs.$inferSelect,
  offset: number,
  text: string,
): ConversationInputReceipt {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !text.length ||
    text.length > BODY_PART_UNITS ||
    Buffer.byteLength(JSON.stringify({ text })) > 64 * 1024 ||
    !validBodyText(text)
  )
    throw new RunOperationConflictError('Invalid prepared body segment.')
  const prior = repo.database
    .select()
    .from(conversationBodyParts)
    .where(and(eq(conversationBodyParts.inputId, row.id), eq(conversationBodyParts.offset, offset)))
    .get()
  if (prior) {
    if (prior.text !== text)
      throw new RunOperationConflictError('This body offset already contains different content.')
    repo.database
      .update(conversationBodyInputs)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    return {
      inputId: row.id,
      offset: offset + text.length,
      sealed: false,
      bytes: prior.endBytes,
      chars: offset + text.length,
    }
  }
  if (row.sealed || offset !== row.chars)
    throw new RunOperationConflictError('Prepared body segments must be complete and ordered.')
  const bytes = Buffer.byteLength(text)
  if (!row.sourceRunId && row.parts >= BODY_INPUT_PARTS)
    throw new RunOperationConflictError(
      'Prepared body segment capacity is full. Existing content was preserved.',
    )
  if (!row.sourceRunId) bodyCapacity(repo, row.ownerKey, bytes, false, 1)
  repo.database
    .insert(conversationBodyParts)
    .values({ inputId: row.id, offset, text, endBytes: row.bytes + bytes })
    .run()
  const next = {
    ...row,
    bytes: row.bytes + bytes,
    chars: row.chars + text.length,
    parts: row.parts + 1,
    updatedAt: new Date().toISOString(),
  }
  repo.database
    .update(conversationBodyInputs)
    .set({ bytes: next.bytes, chars: next.chars, parts: next.parts, updatedAt: next.updatedAt })
    .where(eq(conversationBodyInputs.id, row.id))
    .run()
  return bodyReceipt(repo, next)
}

export function readBody(
  repo: ConversationRepositoryHost,
  row: typeof conversationBodyInputs.$inferSelect,
  collect: boolean,
): { text: string; hash: string } {
  const digest = createHash('sha256')
  const parts: string[] = []
  let offset = 0,
    bytes = 0,
    partsRead = 0
  const deadline = Date.now() + 10_000
  while (offset < row.chars) {
    const page = repo.database
      .select()
      .from(conversationBodyParts)
      .where(
        and(eq(conversationBodyParts.inputId, row.id), gte(conversationBodyParts.offset, offset)),
      )
      .orderBy(asc(conversationBodyParts.offset))
      .limit(64)
      .all()
    if (!page.length || Date.now() >= deadline)
      throw new RunOperationConflictError(
        'Prepared body cannot be read completely before its deadline.',
      )
    for (const part of page) {
      if (part.offset !== offset || !validBodyText(part.text))
        throw new RunOperationConflictError('Prepared body has a missing or invalid segment.')
      partsRead++
      if (!row.sourceRunId && partsRead > BODY_INPUT_PARTS)
        throw new RunOperationConflictError('Prepared body segment capacity changed.')
      offset += part.text.length
      bytes += Buffer.byteLength(part.text)
      if (part.endBytes !== bytes)
        throw new RunOperationConflictError('Prepared body byte offsets changed.')
      digest.update(part.text)
      if (collect) parts.push(part.text)
    }
  }
  if (offset !== row.chars || bytes !== row.bytes || partsRead !== row.parts)
    throw new RunOperationConflictError('Prepared body metadata changed.')
  return { text: collect ? parts.join('') : '', hash: digest.digest('hex') }
}

export function sealBody(
  repo: ConversationRepositoryHost,
  row: typeof conversationBodyInputs.$inferSelect,
): ConversationInputReceipt {
  if (row.sealed) {
    repo.database
      .update(conversationBodyInputs)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    return bodyReceipt(repo, row)
  }
  const body = readBody(repo, row, false)
  const next = { ...row, sealed: true, hash: body.hash, updatedAt: new Date().toISOString() }
  repo.database
    .update(conversationBodyInputs)
    .set({ sealed: true, hash: body.hash, updatedAt: next.updatedAt })
    .where(eq(conversationBodyInputs.id, row.id))
    .run()
  return bodyReceipt(repo, next)
}

export function ownsTemporaryConversationInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  inputId: string,
  ownerKey: string,
): boolean {
  const row = repo.database
    .select({
      sessionId: conversationBodyInputs.sessionId,
      ownerKey: conversationBodyInputs.ownerKey,
      purpose: conversationBodyInputs.purpose,
      committedMessageId: conversationBodyInputs.committedMessageId,
      pendingReceiptId: conversationBodyInputs.pendingReceiptId,
    })
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, inputId))
    .get()
  if (!row) return false
  if (row.sessionId !== sessionId || row.ownerKey !== ownerKey || row.purpose !== 'input') {
    throw new RunOperationConflictError('This prepared body belongs to another owner.')
  }
  return !row.committedMessageId && !row.pendingReceiptId
}

export function resolveConversationInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  clientMessageId: string,
  inputId: string,
  ownerKey: string,
): string {
  const row = bodyInput(repo, inputId, sessionId, ownerKey, true)
  if (
    row.purpose !== 'input' ||
    row.clientMessageId !== clientMessageId ||
    !row.sealed ||
    !row.hash
  )
    throw new RunOperationConflictError('The complete prepared input was not sealed for this Send.')
  if (row.bytes > BODY_INTERNAL_READ_BYTES)
    throw new RunOperationConflictError(
      'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
    )
  if (row.committedMessageId) {
    const original = repo.internalMessage(row.committedMessageId, sessionId)
    if (
      !original ||
      original.id !== clientMessageId ||
      createHash('sha256').update(original.content).digest('hex') !== row.hash
    )
      throw new RunOperationConflictError('Committed input identity changed.')
    return original.content
  }
  const body = readBody(repo, row, true)
  if (body.hash !== row.hash)
    throw new RunOperationConflictError('The prepared input changed after sealing.')
  repo.database
    .update(conversationBodyInputs)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(conversationBodyInputs.id, row.id))
    .run()
  return body.text
}

export function consumeConversationInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  inputId: string,
  ownerKey: string,
): void {
  repo.database.transaction(() => {
    const row = bodyInput(repo, inputId, sessionId, ownerKey, true)
    const message = repo.internalMessage(row.clientMessageId, sessionId)
    if (row.purpose !== 'input' || !row.sealed || !message)
      throw new RunOperationConflictError(
        'Prepared input cannot be consumed before its original Message is durable.',
      )
    const hash = createHash('sha256').update(message.content).digest('hex')
    if (
      hash !== row.hash &&
      (row.committedMessageId || readBody(repo, row, true).text.trim() !== message.content)
    )
      throw new RunOperationConflictError('Prepared input differs from the committed Send.')
    repo.database
      .update(conversationBodyInputs)
      .set({
        committedMessageId: message.id,
        parts: 0,
        hash,
        bytes: Buffer.byteLength(message.content),
        chars: message.content.length,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    // Retry resolves from the durable original Message. This small identity survives an uncertain ACK.
    repo.database
      .delete(conversationBodyParts)
      .where(eq(conversationBodyParts.inputId, row.id))
      .run()
  })
}

export function selectForkSource(
  repo: ConversationRepositoryHost,
  sourceSessionId: string,
  messageId: string,
  settings: import('@pact/contracts').SessionSettings,
  expectedSettingsRevision: number,
) {
  return forkFacts.selectForkSource(
    repo.database,
    sourceSessionId,
    messageId,
    settings,
    expectedSettingsRevision,
  )
}

export function forkResponse(repo: ConversationRepositoryHost, runId: string, sequence: number) {
  return forkFacts.forkResponse(repo.database, runId, sequence)
}

export function commitFork(
  repo: ConversationRepositoryHost,
  operationId: string,
  selection: forkFacts.ForkSelection,
  boundaries: Partial<Record<RuntimeAgentId, import('@pact/contracts').AgentNativeForkBoundary>>,
  fullConsent: RuntimeAgentId[],
) {
  return forkFacts.commitFork(
    repo.database,
    operationId,
    selection,
    boundaries,
    fullConsent,
    (runId) => repo.collaborationTurnAuthorization(runId),
  )
}

export function forkOperation(repo: ConversationRepositoryHost, sessionId: string) {
  return forkFacts.readFork(repo.database, sessionId)
}

export function forkOperationById(repo: ConversationRepositoryHost, operationId: string) {
  const row = repo.database
    .select({ sessionId: sessionForkOperations.sessionId })
    .from(sessionForkOperations)
    .where(eq(sessionForkOperations.id, operationId))
    .get()
  return row ? forkOperation(repo, row.sessionId) : undefined
}

export function sourceHasPendingFork(
  repo: ConversationRepositoryHost,
  sourceSessionId: string,
): boolean {
  return !!repo.database
    .select({ id: sessionForkOperations.id })
    .from(sessionForkOperations)
    .where(
      and(
        eq(sessionForkOperations.sourceSessionId, sourceSessionId),
        eq(sessionForkOperations.ready, false),
      ),
    )
    .limit(1)
    .get()
}

export function forkIntent(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
) {
  return forkFacts.forkIntent(repo.database, sessionId, operationId, agentId)
}

export function updateForkIntent(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  patch: Partial<typeof nativeForkIntents.$inferInsert>,
) {
  forkFacts.updateForkIntent(repo.database, sessionId, operationId, agentId, patch)
  return repo.createPatch(sessionId, {})
}

export function completeForkSide(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  nativeSessionId: string,
  witness: import('@pact/contracts').AgentNativeForkWitness,
) {
  forkFacts.completeForkSide(
    repo.database,
    sessionId,
    operationId,
    agentId,
    nativeSessionId,
    witness,
  )
  return repo.createPatch(sessionId, {})
}

export function recoverForkIntents(repo: ConversationRepositoryHost) {
  forkFacts.recoverForkIntents(repo.database)
}

export function sessionHasNativeWork(repo: ConversationRepositoryHost, sessionId: string): boolean {
  // Keep completed history outside this gate. Literal predicates make the
  // existing partial indexes eligible; their access path is a resource invariant.
  return (
    !!repo.database.get<{ id: string }>(sql`
        SELECT id FROM ${agentRuns} INDEXED BY agent_runs_session_unsettled_work_idx
        WHERE ${agentRuns.sessionId} = ${sessionId} AND ${agentRuns.forkSourceRunId} IS NULL
          AND ((${agentRuns.status} IN ('starting', 'running', 'recovering') AND ${agentRuns.controlDisposition} <> 'abandoned') OR ${agentRuns.nativeEffectsState} IN ('pending', 'unknown'))
        LIMIT 1
      `) ||
    !!repo.database.get<{ id: string }>(sql`
        SELECT id FROM ${nativeRebuildOperations} INDEXED BY native_rebuild_operations_unsettled_work_idx
        WHERE ${nativeRebuildOperations.sessionId} = ${sessionId} AND ${nativeRebuildOperations.nativeWorkState} IN ('pending', 'unknown')
        LIMIT 1
      `)
  )
}

export function forkActorIsCurrent(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  executorId: string | undefined,
) {
  return forkFacts.forkActorIsCurrent(repo.database, sessionId, operationId, agentId, executorId)
}

export function saveCommentDraft(
  repo: ConversationRepositoryHost,
  input:
    | CommentDraftSaveInput
    | (Omit<Extract<CommentDraftSaveInput, { mode: 'create' }>, 'anchor'> & {
        anchor: Exclude<CommentAnchor, { type: 'unavailable' }>
      }),
): ConversationPatch {
  if (input.mode === 'create' && input.anchor.type === 'cutoff_message') {
    throw new RunOperationConflictError('Cutoff comment anchors cannot be created as drafts.')
  }
  const now = new Date().toISOString()
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify(
        input.mode === 'create'
          ? {
              mode: input.mode,
              commentId: input.commentId,
              body: input.body,
              anchor: input.anchor,
            }
          : {
              mode: input.mode,
              commentId: input.commentId,
              body: input.body,
            },
      ),
    )
    .digest('hex')
  const requestHash = createHash('sha256')
    .update(
      `${input.sessionId}:${input.commentId}:${input.expectedCommentsRevision}:${payloadHash}`,
    )
    .digest('hex')
  const fallbackRequestId = `${requestHash.slice(0, 8)}-${requestHash.slice(8, 12)}-5${requestHash.slice(13, 16)}-8${requestHash.slice(17, 20)}-${requestHash.slice(20, 32)}`
  const requestId = input.requestId ?? fallbackRequestId
  let savedId = input.commentId
  let revision = input.expectedCommentsRevision
  repo.database.transaction(() => {
    const session = repo.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    if (!session) throw new RunOperationConflictError('Session does not exist.')
    const receipt = repo.database
      .select()
      .from(commentDraftReceipts)
      .where(eq(commentDraftReceipts.requestId, requestId))
      .get()
    if (receipt) {
      if (receipt.sessionId !== input.sessionId || receipt.payloadHash !== payloadHash)
        throw new RunOperationConflictError(
          'This Comment request identity belongs to another saved payload.',
        )
      savedId = receipt.commentId
      revision = session.commentsRevision
      return
    }
    const existing = repo.database
      .select()
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.id, input.commentId),
          eq(anchoredComments.sessionId, input.sessionId),
        ),
      )
      .get()
    if (
      existing &&
      existing.body === input.body &&
      (input.mode === 'edit' || existing.anchorJson === JSON.stringify(input.anchor)) &&
      !existing.sentWithMessageId &&
      !existing.pendingReceiptId
    ) {
      revision = session.commentsRevision
      repo.database
        .insert(commentDraftReceipts)
        .values({
          requestId,
          sessionId: input.sessionId,
          commentId: savedId,
          payloadHash,
          commentsRevision: revision,
          createdAt: now,
        })
        .run()
      return
    }
    if (session.commentsRevision !== input.expectedCommentsRevision)
      throw new RunOperationConflictError('Comment drafts changed. Refresh and try again.')
    if (input.mode === 'create') {
      if (
        existing &&
        (existing.sentWithMessageId ||
          existing.pendingReceiptId ||
          existing.anchorJson !== JSON.stringify(input.anchor))
      )
        throw new RunOperationConflictError(
          'This Comment identity already belongs to another source or frozen draft.',
        )
      const answer = existing
      if (answer) {
        savedId = answer.id
        repo.database
          .update(anchoredComments)
          .set({
            body: input.body,
            anchorJson: JSON.stringify(input.anchor),
            draftRevision: answer.draftRevision + 1,
            updatedAt: now,
          })
          .where(eq(anchoredComments.id, answer.id))
          .run()
      } else {
        const position =
          (repo.database
            .select({ value: max(anchoredComments.position) })
            .from(anchoredComments)
            .where(eq(anchoredComments.sessionId, input.sessionId))
            .get()?.value ?? -1) + 1
        repo.database
          .insert(anchoredComments)
          .values({
            id: input.commentId,
            sessionId: input.sessionId,
            body: input.body,
            anchorJson: JSON.stringify(input.anchor),
            answerKey: null,
            draftRevision: 1,
            position,
            createdAt: now,
            updatedAt: now,
          })
          .run()
      }
    } else {
      if (!existing || existing.sentWithMessageId || existing.pendingReceiptId)
        throw new RunOperationConflictError('Only an unsent Comment draft can be edited.')
      repo.database
        .update(anchoredComments)
        .set({
          body: input.body,
          anchorJson: existing.anchorJson,
          draftRevision: existing.draftRevision + 1,
          updatedAt: now,
        })
        .where(eq(anchoredComments.id, existing.id))
        .run()
    }
    revision = session.commentsRevision + 1
    repo.database
      .update(sessions)
      .set({ commentsRevision: revision, updatedAt: now })
      .where(eq(sessions.id, input.sessionId))
      .run()
    repo.database
      .insert(commentDraftReceipts)
      .values({
        requestId,
        sessionId: input.sessionId,
        commentId: savedId,
        payloadHash,
        commentsRevision: revision,
        createdAt: now,
      })
      .run()
  })
  const savedComment = comment(repo, savedId)

  return repo.createPatch(input.sessionId, {
    commentDraftReceipt: { requestId, commentId: savedId },
    comments: { revision, upserts: savedComment ? [savedComment] : [], removedIds: [] },
    ...(!savedComment ? { resync: { messages: false, drafts: true, activityRunIds: [] } } : {}),
  })
}

export function removeCommentDraft(
  repo: ConversationRepositoryHost,
  input: CommentDraftRemoveInput,
): ConversationPatch {
  const now = new Date().toISOString()
  repo.database.transaction((transaction) => {
    const session = transaction
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    if (!session) throw new Error('Session does not exist.')
    if (session.commentsRevision !== input.expectedCommentsRevision) {
      throw new Error('Comment drafts changed. Refresh and try again.')
    }
    const draft = transaction
      .select()
      .from(anchoredComments)
      .where(
        and(
          eq(anchoredComments.id, input.commentId),
          eq(anchoredComments.sessionId, input.sessionId),
        ),
      )
      .get()
    if (!draft || draft.sentWithMessageId || draft.pendingReceiptId)
      throw new Error('Only an unsent Comment draft can be removed.')
    transaction.delete(anchoredComments).where(eq(anchoredComments.id, input.commentId)).run()
    transaction
      .update(sessions)
      .set({ commentsRevision: session.commentsRevision + 1, updatedAt: now })
      .where(eq(sessions.id, input.sessionId))
      .run()
  })
  return repo.createPatch(input.sessionId, {
    comments: {
      revision: input.expectedCommentsRevision + 1,
      upserts: [],
      removedIds: [input.commentId],
    },
  })
}

export function comment(
  repo: ConversationRepositoryHost,
  commentId: string,
): AnchoredComment | undefined {
  const row = repo.database
    .select()
    .from(anchoredComments)
    .where(eq(anchoredComments.id, commentId))
    .get()
  return row ? toComment(row) : undefined
}

export function commentsForMessage(
  repo: ConversationRepositoryHost,
  messageId: string,
): AnchoredComment[] {
  return repo.database
    .select()
    .from(anchoredComments)
    .where(eq(anchoredComments.sentWithMessageId, messageId))
    .orderBy(asc(anchoredComments.position))
    .all()
    .map((row) => toComment(row))
}

/**
 * Read bounded, verified comments from a frozen Input Batch by ordinal.
 * Never loads bodies larger than the remaining byte budget and stops immediately
 * once either byte or item caps are reached, leaving the full Batch ref intact.
 */
export function readFrozenBatchInlineComments(
  repo: ConversationRepositoryHost,
  input: {
    sessionId: string
    runId: string
    batchId: string
    maxBytes: number
    maxItems?: number | undefined
  },
): Array<Pick<AnchoredComment, 'id' | 'body' | 'anchor'>> {
  const maxBytes = Math.floor(input.maxBytes)
  const maxItems = Math.min(
    Math.floor(input.maxItems ?? FROZEN_EXECUTION_INPUT_ITEMS),
    FROZEN_EXECUTION_INPUT_ITEMS,
  )
  if (maxBytes <= 0 || maxItems <= 0) return []
  const batch = repo.database
    .select({
      id: conversationInputBatches.id,
      sessionId: conversationInputBatches.sessionId,
      runId: conversationInputBatches.runId,
      messageId: conversationInputBatches.messageId,
      memberCount: conversationInputBatches.memberCount,
    })
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.id, input.batchId),
        eq(conversationInputBatches.sessionId, input.sessionId),
      ),
    )
    .get()
  if (!batch || batch.memberCount <= 0) return []
  const run = repo.database
    .select({
      id: agentRuns.id,
      sessionId: agentRuns.sessionId,
      userMessageId: agentRuns.userMessageId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.sessionId, input.sessionId)))
    .get()
  const authorizedForRun =
    Boolean(run) &&
    (batch.runId === input.runId ||
      (batch.messageId !== null && batch.messageId === run!.userMessageId) ||
      Boolean(
        repo.database
          .select({ id: conversationQueueOperations.id })
          .from(conversationQueueOperations)
          .where(
            and(
              eq(conversationQueueOperations.targetRunId, input.runId),
              eq(conversationQueueOperations.sessionId, input.sessionId),
              eq(conversationQueueOperations.kind, 'steer'),
              eq(conversationQueueOperations.batchId, batch.id),
              inArray(conversationQueueOperations.state, [
                'prepared',
                'possibly_sent',
                'accepted',
                'consumed',
                'unknown',
              ]),
            ),
          )
          .limit(1)
          .get(),
      ))
  if (!authorizedForRun) return []

  const inlined: Array<Pick<AnchoredComment, 'id' | 'body' | 'anchor'>> = []
  let usedBytes = 0
  let afterOrdinal = -1
  for (;;) {
    const remainingBytes = maxBytes - usedBytes
    if (remainingBytes <= 0 || inlined.length >= maxItems) break
    const pageLimit = Math.min(COLLABORATION_INDEX_ITEMS, maxItems - inlined.length)
    // Phase 1: inspect bounded ordinal + byte lengths without materializing comment bodies or anchors.
    const metaRows = repo.database
      .select({
        ordinal: conversationInputBatchMembers.ordinal,
        commentRevision: conversationInputBatchMembers.commentRevision,
        commentSessionId: anchoredComments.sessionId,
        commentDraftRevision: anchoredComments.draftRevision,
        bodyBytes: sql<number>`length(CAST(${anchoredComments.body} AS BLOB))`,
        anchorBytes: sql<number>`length(CAST(${conversationInputBatchMembers.anchorJson} AS BLOB))`,
      })
      .from(conversationInputBatchMembers)
      .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
      .where(
        and(
          eq(conversationInputBatchMembers.batchId, batch.id),
          gt(conversationInputBatchMembers.ordinal, afterOrdinal),
        ),
      )
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .limit(pageLimit)
      .all()
    if (!metaRows.length) break
    const selectedOrdinals: number[] = []
    let estimatedBytes = usedBytes
    let stoppedByBudget = false
    for (const meta of metaRows) {
      if (
        meta.commentSessionId !== input.sessionId ||
        meta.commentDraftRevision !== meta.commentRevision
      ) {
        throw new RunOperationConflictError('The frozen Comment source changed.')
      }
      const overhead = inlined.length === 0 && selectedOrdinals.length === 0 ? 2 : 1
      const minItemBytes = meta.bodyBytes + meta.anchorBytes + overhead
      if (minItemBytes > maxBytes - estimatedBytes) {
        stoppedByBudget = true
        break
      }
      selectedOrdinals.push(meta.ordinal)
      estimatedBytes += minItemBytes
    }
    if (!selectedOrdinals.length) return inlined
    // Phase 2: materialize bodies and anchors ONLY for the prefix of ordinals that fit the remaining budget.
    const rows = repo.database
      .select({
        ordinal: conversationInputBatchMembers.ordinal,
        commentId: conversationInputBatchMembers.commentId,
        commentRevision: conversationInputBatchMembers.commentRevision,
        anchorJson: conversationInputBatchMembers.anchorJson,
        bodySha256: conversationInputBatchMembers.bodySha256,
        commentSessionId: anchoredComments.sessionId,
        commentDraftRevision: anchoredComments.draftRevision,
        body: anchoredComments.body,
      })
      .from(conversationInputBatchMembers)
      .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
      .where(
        and(
          eq(conversationInputBatchMembers.batchId, batch.id),
          inArray(conversationInputBatchMembers.ordinal, selectedOrdinals),
        ),
      )
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .all()
    if (rows.length !== selectedOrdinals.length) {
      throw new RunOperationConflictError('The frozen Comment source changed.')
    }
    for (const row of rows) {
      if (
        row.commentSessionId !== input.sessionId ||
        row.commentDraftRevision !== row.commentRevision
      ) {
        throw new RunOperationConflictError('The frozen Comment source changed.')
      }
      if (createHash('sha256').update(row.body, 'utf8').digest('hex') !== row.bodySha256) {
        throw new RunOperationConflictError('The frozen Comment source changed.')
      }
      const projected = {
        id: row.commentId,
        body: row.body,
        anchor: storedCommentAnchor(JSON.parse(row.anchorJson)),
      }
      const overhead = inlined.length === 0 ? 2 : 1
      const itemBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8') + overhead
      if (usedBytes + itemBytes > maxBytes) {
        return inlined
      }
      inlined.push(projected)
      usedBytes += itemBytes
      if (inlined.length >= maxItems) {
        return inlined
      }
    }
    if (stoppedByBudget || metaRows.length < pageLimit) break
    afterOrdinal = metaRows.at(-1)!.ordinal
  }
  return inlined
}
