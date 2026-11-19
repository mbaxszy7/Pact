import { z } from 'zod'

import { MAX_COMMENT_QUOTE_LENGTH } from './anchored-comments.js'
import { userInformationDeclarationSchema } from './prepared-input.js'
import { skillSelectionsSchema } from './skills.js'

export const SIDE_CHAT_LIST_PAGE_ITEMS = 5
export const SIDE_CHAT_LIST_PAGE_BYTES = 64 * 1024
export const SIDE_CHAT_LIST_RESIDENT_ITEMS = 100
export const SIDE_CHAT_LIST_RESIDENT_BYTES = 256 * 1024
export const SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS = 240
export const CUTOFF_INLINE_TAIL_MAX_BYTES = 12 * 1024
export const CONVERSATION_ACTIVE_SESSIONS_PER_VIEWER = 2
export const SIDE_CHAT_SYNC_INLINE_BYTES = 64 * 1024

const utf8Encoder = new TextEncoder()
export const utf8ByteLength = (text: string): number => utf8Encoder.encode(text).byteLength

const fits = (value: unknown, bytes: number): boolean =>
  utf8ByteLength(JSON.stringify(value)) <= bytes

const sideChatSessionStatusSchema = z.enum([
  'draft',
  'idle',
  'discussing',
  'waiting_for_user',
  'plan_ready',
  'building',
  'reviewing',
  'completed',
  'paused',
  'archived',
])

export const sideChatOriginSchema = z.enum(['selection', 'btw'])
export type SideChatOrigin = z.infer<typeof sideChatOriginSchema>

export const originSideChatSchema = z.strictObject({
  sideChatId: z.string().uuid(),
  cutoffId: z.string().uuid(),
  sideChatTitle: z.string().min(1).max(240),
})
export type OriginSideChat = z.infer<typeof originSideChatSchema>

export const sideChatAnchorSchema = z
  .strictObject({
    messageId: z.string().uuid(),
    quote: z.string().min(1).max(MAX_COMMENT_QUOTE_LENGTH),
    quotePreview: z.string().min(1).max(SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
  })
  .refine((anchor) => anchor.endOffset > anchor.startOffset, {
    message: 'Side chat anchor range is invalid.',
    path: ['endOffset'],
  })
export type SideChatAnchor = z.infer<typeof sideChatAnchorSchema>

export const sideChatSummarySchema = z.strictObject({
  id: z.string().uuid(),
  parentSessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(240),
  origin: sideChatOriginSchema,
  anchorQuotePreview: z.string().max(SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS).nullable(),
  previewText: z.string().max(512).nullable(),
  status: sideChatSessionStatusSchema,
  isRunning: z.boolean(),
  needsAttention: z.boolean(),
  hasUnread: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type SideChatSummary = z.infer<typeof sideChatSummarySchema>

export const sideChatCursorSchema = z.strictObject({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
})
export type SideChatCursor = z.infer<typeof sideChatCursorSchema>

export const createSideChatInputSchema = z.discriminatedUnion('origin', [
  z
    .strictObject({
      origin: z.literal('selection'),
      operationId: z.string().uuid(),
      parentSessionId: z.string().uuid(),
      messageId: z.string().uuid(),
      quote: z.string().min(1).max(MAX_COMMENT_QUOTE_LENGTH),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().positive(),
    })
    .refine((input) => input.endOffset > input.startOffset, {
      message: 'Side chat selection range is invalid.',
      path: ['endOffset'],
    }),
  z.strictObject({
    origin: z.literal('btw'),
    operationId: z.string().uuid(),
    parentSessionId: z.string().uuid(),
    initialTitleHint: z.string().max(4096).optional(),
  }),
])
export type CreateSideChatInput = z.infer<typeof createSideChatInputSchema>

export const createSideChatReceiptSchema = z.strictObject({
  operationId: z.string().uuid(),
  sideChat: sideChatSummarySchema,
  cutoffId: z.string().uuid(),
  maxMessageSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
})
export type CreateSideChatReceipt = z.infer<typeof createSideChatReceiptSchema>

export const readSideChatReceiptInputSchema = z.strictObject({
  operationId: z.string().uuid(),
})
export type ReadSideChatReceiptInput = z.infer<typeof readSideChatReceiptInputSchema>

export const listSideChatsInputSchema = z.strictObject({
  parentSessionId: z.string().uuid(),
  cursor: sideChatCursorSchema.optional(),
  direction: z.enum(['older', 'newer']).default('older'),
  limit: z.number().int().min(1).max(SIDE_CHAT_LIST_PAGE_ITEMS).default(SIDE_CHAT_LIST_PAGE_ITEMS),
})
export type ListSideChatsInput = z.infer<typeof listSideChatsInputSchema>

export const listSideChatsPageSchema = z
  .strictObject({
    parentSessionId: z.string().uuid(),
    items: z.array(sideChatSummarySchema).max(SIDE_CHAT_LIST_PAGE_ITEMS),
    nextCursor: sideChatCursorSchema.nullable(),
    prevCursor: sideChatCursorSchema.nullable(),
    hasMoreOlder: z.boolean(),
    hasMoreNewer: z.boolean(),
    activeCount: z.number().int().nonnegative(),
    attentionCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative().default(0),
  })
  .refine((value) => fits(value, SIDE_CHAT_LIST_PAGE_BYTES), {
    message: 'Side chat list page exceeds its byte budget.',
  })
export type ListSideChatsPage = z.infer<typeof listSideChatsPageSchema>

export const sideChatSyncMainInputSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    sideChatId: z.string().uuid(),
    inputId: z.string().uuid().optional(),
    contentSha256: z
      .string()
      .regex(/^[a-f\d]{64}$/iu)
      .optional(),
    content: z.string().trim(),
    imageIds: z.array(z.string().uuid()).max(128).default([]),
    commentIds: z.array(z.string().uuid()).default([]),
    skills: skillSelectionsSchema.default([]),
    userInformation: userInformationDeclarationSchema.optional(),
    expectedCommentsRevision: z.number().int().nonnegative(),
  })
  .superRefine((input, context) => {
    if (
      !input.content &&
      !input.inputId &&
      !input.imageIds.length &&
      input.commentIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A message, image, or Comment is required.',
        path: ['content'],
      })
    }
    if (input.inputId && input.content) {
      context.addIssue({
        code: 'custom',
        message: 'Use either sealed input or inline content.',
        path: ['inputId'],
      })
    }
    if (input.inputId && !input.contentSha256) {
      context.addIssue({
        code: 'custom',
        message: 'Sealed input requires its contentSha256 digest.',
        path: ['contentSha256'],
      })
    }
    if (input.contentSha256 && !input.inputId) {
      context.addIssue({
        code: 'custom',
        message: 'Content digest requires a sealed inputId.',
        path: ['contentSha256'],
      })
    }
    if (!input.inputId && utf8ByteLength(input.content) > SIDE_CHAT_SYNC_INLINE_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'Inline side-chat sync content exceeds the 64 KiB limit.',
        path: ['content'],
      })
    }
    if (new Set(input.commentIds).size !== input.commentIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Comment IDs must be unique.',
        path: ['commentIds'],
      })
    }
  })
export type SideChatSyncMainInput = z.infer<typeof sideChatSyncMainInputSchema>

export const sideChatSyncMainReceiptSchema = z.strictObject({
  operationId: z.string().uuid(),
  sideChatId: z.string().uuid(),
  parentSessionId: z.string().uuid(),
  cutoffId: z.string().uuid(),
  disposition: z.enum(['sent', 'queued']),
  mainMessageId: z.string().uuid().nullable(),
  queuedOperationId: z.string().uuid().nullable(),
})
export type SideChatSyncMainReceipt = z.infer<typeof sideChatSyncMainReceiptSchema>

export const discardEmptySideChatInputSchema = z.strictObject({
  sideChatId: z.string().uuid(),
})
export type DiscardEmptySideChatInput = z.infer<typeof discardEmptySideChatInputSchema>

export const discardEmptySideChatResultSchema = z.strictObject({
  discarded: z.boolean(),
})
export type DiscardEmptySideChatResult = z.infer<typeof discardEmptySideChatResultSchema>
