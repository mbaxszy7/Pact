import { z } from 'zod'

import { commentAnchorSchema } from './anchored-comments.js'
import {
  collaborationDocumentSchema,
  collaborationInputBatchReferenceSchema,
} from './collaboration-documents.js'
import { collaborationTaskSchema, collaborationTurnAuthorizationSchema } from './collaboration.js'
import { conversationImagesSchema } from './images.js'
import { userClarificationSchema } from './prepared-input.js'
import { frozenSkillInvocationSchema, nativeSkillSchema } from './skills.js'

/** Capture limit closes automatic replay eligibility, never the original user content. */
export const FROZEN_EXECUTION_INPUT_BYTES = 8 * 1024 * 1024
export const FROZEN_EXECUTION_INPUT_ITEMS = 4096
const id = z.string().uuid()
const comments = z
  .array(z.strictObject({ id, body: z.string(), anchor: commentAnchorSchema }))
  .max(FROZEN_EXECUTION_INPUT_ITEMS)
const textMessage = z.strictObject({
  id,
  content: z.string(),
  images: conversationImagesSchema.optional(),
})
const basisMessage = textMessage.extend({
  document: collaborationDocumentSchema.optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
  comments,
})

/** No executable handles, native paths or reusable runtime grants can enter this immutable input. */
export const frozenExecutionEnvelopeSchema = z
  .strictObject({
    version: z.literal('pact-agent-prompt-v1'),
    sessionId: id,
    clarificationAnswer: collaborationDocumentSchema.optional(),
    userClarification: userClarificationSchema.optional(),
    requestSessionTitle: z.literal(true).optional(),
    targetAgentId: z.enum(['codex', 'claude']).optional(),
    collaboration: collaborationTaskSchema.optional(),
    collaborationAuthorization: collaborationTurnAuthorizationSchema.optional(),
    inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
    requiredInputScopeRef: collaborationDocumentSchema.optional(),
    handoffSourceRefs: z
      .array(collaborationDocumentSchema)
      .max(FROZEN_EXECUTION_INPUT_ITEMS)
      .optional(),
    skillInvocation: frozenSkillInvocationSchema
      .safeExtend({
        bindings: z.array(nativeSkillSchema).max(FROZEN_EXECUTION_INPUT_ITEMS * 2),
      })
      .optional(),
    message: textMessage,
    comments,
    handoffContext: z
      .array(
        z.strictObject({
          inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
          document: collaborationDocumentSchema.optional(),
          messageId: id,
          speaker: z.enum(['user', 'codex', 'claude']),
          content: z.string(),
          images: conversationImagesSchema.optional(),
          comments,
        }),
      )
      .max(FROZEN_EXECUTION_INPUT_ITEMS)
      .optional(),
    rebuiltContext: z
      .array(
        z.strictObject({
          inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
          document: collaborationDocumentSchema.optional(),
          message: textMessage.extend({ role: z.enum(['user', 'assistant', 'system']) }),
          comments,
        }),
      )
      .max(FROZEN_EXECUTION_INPUT_ITEMS)
      .optional(),
    collaborationBasis: z
      .strictObject({
        report: basisMessage.optional(),
        original: basisMessage.optional(),
        latest: basisMessage.optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      !value.userClarification ||
      Boolean(
        value.clarificationAnswer &&
        value.userClarification.document.id === value.clarificationAnswer.id &&
        value.userClarification.document.sha256 === value.clarificationAnswer.sha256 &&
        value.userClarification.document.bytes === value.clarificationAnswer.bytes &&
        value.userClarification.document.chars === value.clarificationAnswer.chars,
      ),
    'The user clarification must match its frozen answer source.',
  )
export type FrozenExecutionEnvelope = z.infer<typeof frozenExecutionEnvelopeSchema>
