import { z } from 'zod'

import { collaborationDocumentSchema } from './collaboration-documents.js'
import { agentSpeedSchema, sessionPermissionModeSchema } from './execution-settings.js'

const uuid = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)

/** Exact confirmed user data; never a command, route or permission grant. */
export const userClarificationValueSchema = z.strictObject({
  question: z.string().min(1).max(512),
  answer: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => Boolean(value.trim())),
})
export const userClarificationSchema = userClarificationValueSchema
  .extend({ fieldId: uuid, document: collaborationDocumentSchema })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 12 * 1024,
    'The confirmed user clarification exceeds its projection budget.',
  )
export type UserClarification = z.infer<typeof userClarificationSchema>

/** An explicit current-user declaration, never inferred from prose or an Agent suggestion. */
export const userInformationDeclarationSchema = z
  .strictObject({
    version: z.literal('user-information-v1'),
    id: uuid,
    kind: z.enum(['user_supplied_value', 'user_reserved_choice']),
    question: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => Boolean(value.trim())),
    input: z.enum(['text', 'single']),
    options: z
      .array(
        z.strictObject({
          id: uuid,
          label: z
            .string()
            .min(1)
            .max(160)
            .refine((value) => Boolean(value.trim())),
        }),
      )
      .max(6),
    state: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unanswered') }),
      z.strictObject({
        status: z.literal('answered'),
        value: z
          .string()
          .min(1)
          .max(1024)
          .refine((value) => Boolean(value.trim())),
      }),
    ]),
  })
  .superRefine((value, context) => {
    const state = value.state
    if (
      (value.input === 'text' && value.options.length !== 0) ||
      (value.input === 'single' && value.options.length < 2) ||
      new Set(value.options.map((option) => option.id)).size !== value.options.length ||
      new Set(value.options.map((option) => option.label)).size !== value.options.length ||
      (state.status === 'answered' &&
        value.input === 'single' &&
        !value.options.some((option) => option.id === state.value))
    )
      context.addIssue({
        code: 'custom',
        message: 'Provide one valid user-owned information field and answer.',
      })
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096)
      context.addIssue({
        code: 'custom',
        message: 'The declared information exceeds its 4 KiB budget.',
      })
  })
export type UserInformationDeclaration = z.infer<typeof userInformationDeclarationSchema>

/** A user action over the original saved input, independent of the current Composer. */
export const preparedInputContinueSchema = z.strictObject({
  sessionId: uuid,
  batchId: uuid,
  expectedRevision: z.number().int().nonnegative(),
  operationId: uuid,
  expectedSettingsRevision: z.number().int().positive(),
  expectedQueueRevision: z.number().int().nonnegative(),
  expectedContinuationFingerprint: digest,
})
export type PreparedInputContinue = z.infer<typeof preparedInputContinueSchema>

/** One disposable projection. The saved request and Comments remain authoritative in SQLite. */
export const preparedInputContinuationSchema = z.strictObject({
  batchId: uuid,
  revision: z.number().int().nonnegative(),
  clientMessageId: uuid,
  preview: z.string().max(512),
  body: collaborationDocumentSchema,
  commentCount: z.number().int().nonnegative().max(12),
  hasAnswer: z.boolean(),
  phase: z.enum(['paused', 'preparing']),
  agentId: z.enum(['codex', 'claude']),
  settingsRevision: z.number().int().positive(),
  queueRevision: z.number().int().nonnegative(),
  continuationFingerprint: digest,
  execution: z.strictObject({
    model: z.string().max(160).nullable(),
    effort: z.string().max(80).nullable(),
    speed: agentSpeedSchema,
    permissionMode: sessionPermissionModeSchema,
  }),
  canContinue: z.boolean(),
  blockedReason: z
    .enum([
      'source_unavailable',
      'session_unavailable',
      'native_interaction',
      'native_recovery',
      'collaboration_active',
      'preparation_active',
      'queue_changed',
    ])
    .nullable(),
})
export type PreparedInputContinuation = z.infer<typeof preparedInputContinuationSchema>

/** Control metadata only; it never replaces or rewrites the immutable original dispatch metadata. */
export const preparedInformationControlSchema = z
  .strictObject({
    version: z.literal('prepared-information-v1'),
    decisionId: uuid,
    revision: z.number().int().nonnegative(),
    preview: z.string().max(512),
    originalCommentIds: z.array(uuid).max(12),
    pauseReason: z
      .enum(['cancelled', 'restarted', 'preparation_failed', 'stale', 'stopped'])
      .optional(),
    answerDocument: collaborationDocumentSchema.optional(),
    draftCopies: z
      .array(z.strictObject({ originalId: uuid, draftId: uuid }))
      .max(12)
      .refine(
        (values) =>
          new Set(values.map((item) => item.originalId)).size === values.length &&
          new Set(values.map((item) => item.draftId)).size === values.length,
        'Draft restoration identities must be unique.',
      ),
    continuation: z
      .strictObject({
        operationId: uuid,
        receiptId: uuid,
        kind: z.enum(['answer', 'continue', 'default']),
        requestDigest: digest,
        settingsRevision: z.number().int().positive(),
        queueRevision: z.number().int().nonnegative(),
        executionFingerprint: digest,
      })
      .optional(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * 1024,
    'Prepared information control metadata exceeds its byte bound.',
  )
export type PreparedInformationControl = z.infer<typeof preparedInformationControlSchema>

/** Durable nonce history; reading it never admits execution. */
export const preparedInputActionProofSchema = z.strictObject({
  version: z.literal('prepared-input-action-v1'),
  request: preparedInputContinueSchema,
  clientMessageId: uuid,
  sourceFingerprint: digest,
  executionFingerprint: digest,
})
