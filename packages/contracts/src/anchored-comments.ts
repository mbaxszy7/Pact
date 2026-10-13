import { z } from 'zod'

export const MESSAGE_ANCHOR_TEXT_BASIS = 'markdown-visible-v2' as const
export const MAX_COMMENT_QUOTE_LENGTH = 20_000
/** A metadata page, never a limit on the durable members of one Send. */
export const MAX_COMMENTS_PER_MESSAGE = 24

const commentBodySchema = z.string().trim().min(1).max(20_000)
const quoteSchema = z.string().min(1).max(MAX_COMMENT_QUOTE_LENGTH)

export const messageCommentAnchorSchema = z
  .strictObject({
    type: z.literal('message'),
    messageId: z.string().uuid(),
    // A bounded structured plan belongs to the source Run, not the ordinary answer body.
    plan: z
      .strictObject({ runId: z.string().uuid(), version: z.number().int().positive() })
      .optional(),
    report: z
      .strictObject({
        runId: z.string().uuid(),
        target: z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('summary') }),
          z.strictObject({ type: z.literal('feedback'), id: z.string().min(1).max(80) }),
        ]),
      })
      .optional(),
    contentHash: z.string().regex(/^[a-f\d]{64}$/iu),
    textBasis: z.enum(['markdown-visible-v1', MESSAGE_ANCHOR_TEXT_BASIS, 'plain-visible-v1']),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    quote: quoteSchema,
  })
  .refine((anchor) => anchor.endOffset > anchor.startOffset, {
    message: 'Message anchor range is invalid.',
    path: ['endOffset'],
  })
  .refine((anchor) => !(anchor.plan && anchor.report), 'A Comment has one immutable source.')
export type MessageCommentAnchor = z.infer<typeof messageCommentAnchorSchema>

export const fileCommentAnchorSchema = z
  .strictObject({
    type: z.literal('file'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes('\\'), {
        message: 'File comment paths must use project-relative forward slashes.',
      }),
    contentHash: z.string().regex(/^[a-f\d]{64}$/iu),
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
    quote: quoteSchema,
  })
  .refine(
    (anchor) =>
      anchor.endLine > anchor.startLine ||
      (anchor.endLine === anchor.startLine && anchor.endColumn > anchor.startColumn),
    { message: 'File comment range is invalid.', path: ['endColumn'] },
  )
export type FileCommentAnchor = z.infer<typeof fileCommentAnchorSchema>

export const todoCommentAnchorSchema = z.strictObject({
  type: z.literal('todo'),
  taskId: z.string().uuid(),
  todoId: z.string().min(1).max(80),
  todoRevision: z.number().int().positive(),
  quote: quoteSchema,
  question: z
    .strictObject({
      id: z.string().min(1).max(80),
      revision: z.number().int().positive(),
      optionIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
  selection: z
    .strictObject({
      contentHash: z.string().regex(/^[a-f\d]{64}$/iu),
      textBasis: z.enum([MESSAGE_ANCHOR_TEXT_BASIS, 'plain-visible-v1']),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().positive(),
    })
    .optional(),
})
export type TodoCommentAnchor = z.infer<typeof todoCommentAnchorSchema>
export const commentAnchorSchema = z.discriminatedUnion('type', [
  messageCommentAnchorSchema,
  fileCommentAnchorSchema,
  todoCommentAnchorSchema,
])
export type CommentAnchor = z.infer<typeof commentAnchorSchema>

export const anchoredCommentSchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  body: commentBodySchema,
  anchor: commentAnchorSchema,
  status: z.enum(['draft', 'sent']),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sentWithMessageId: z.string().uuid().optional(),
})
export type AnchoredComment = z.infer<typeof anchoredCommentSchema>

export const commentDraftSaveInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('create'),
    requestId: z.string().uuid().optional(),
    sessionId: z.string().uuid(),
    commentId: z.string().uuid(),
    expectedCommentsRevision: z.number().int().nonnegative(),
    body: commentBodySchema,
    anchor: commentAnchorSchema,
  }),
  z.strictObject({
    mode: z.literal('edit'),
    requestId: z.string().uuid().optional(),
    anchor: todoCommentAnchorSchema.optional(),
    sessionId: z.string().uuid(),
    commentId: z.string().uuid(),
    expectedCommentsRevision: z.number().int().nonnegative(),
    body: commentBodySchema,
  }),
])
export type CommentDraftSaveInput = z.infer<typeof commentDraftSaveInputSchema>

export const commentDraftRemoveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  commentId: z.string().uuid(),
  expectedCommentsRevision: z.number().int().nonnegative(),
})
export type CommentDraftRemoveInput = z.infer<typeof commentDraftRemoveInputSchema>

export const commentSourceResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('resolved'),
    commentId: z.string().uuid(),
    anchor: commentAnchorSchema,
  }),
  z.strictObject({
    status: z.literal('outdated'),
    commentId: z.string().uuid(),
    quote: quoteSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    commentId: z.string().uuid(),
    quote: quoteSchema,
    reason: z.string().min(1),
  }),
])
export type CommentSourceResolution = z.infer<typeof commentSourceResolutionSchema>
