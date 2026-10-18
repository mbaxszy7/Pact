import { z } from 'zod'

const actor = z.enum(['codex', 'claude'])
const identifier = z.string().min(1).max(80)
export const COLLABORATION_PAGE_ITEMS = 24
export const COLLABORATION_PAGE_BYTES = 48 * 1024
export const COLLABORATION_DISPLAY_TEXT_RULES =
  'Write user-facing prose with task names, plan versions, Todo titles, quoted user answers and relevant file/line references. Do not print Pact Task, Run, Batch, Comment, Todo or question IDs, UUIDs, hashes, ledger revisions, optionIndex values, source manifests or workflow protocol fields. Keep exact identities in structured reference fields and internal tool arguments only. Explain the decision or finding itself, not the transport checks performed to read it. Technical API and code names remain appropriate when they are the actual subject of the task.'
export const collaborationDocumentSchema = z.strictObject({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
})
export type CollaborationDocument = z.infer<typeof collaborationDocumentSchema>
export const collaborationDutySchema = z.enum([
  'plan_submission',
  'plan_adoption',
  'plan_review',
  'code_review',
  'stage_result',
])
export const collaborationTodoQuestionSchema = z.strictObject({
  id: identifier,
  revision: z.number().int().positive(),
  type: z.enum(['choice', 'text']),
  question: z.string().regex(/\S/u).describe(COLLABORATION_DISPLAY_TEXT_RULES),
  reason: z.string().regex(/\S/u).describe(COLLABORATION_DISPLAY_TEXT_RULES),
  options: z.array(z.string().regex(/\S/u).describe(COLLABORATION_DISPLAY_TEXT_RULES)),
  recommended: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      'The recommended option index. Do not repeat a recommendation marker in option text.',
    ),
  answerResolver: actor,
})
export const collaborationTodoDeltaSchema = z.strictObject({
  todoId: identifier,
  expectedRevision: z.number().int().nonnegative(),
  operation: z
    .enum(['create', 'update', 'propose_resolution', 'confirm', 'reopen'])
    .describe(
      'Use update to change an existing question and explain why new input is needed. A new question definition returns the Todo to open and clears its previous resolution; resolutionKind and mergeTargetId must be null. Do not change questions with propose_resolution or confirm. A done Todo requires reopen with evidence before further changes; reopen also requires null resolutionKind and mergeTargetId.',
    ),
  kind: z.enum(['opinion', 'decision', 'information']).nullable(),
  title: z.string().nullable().describe(COLLABORATION_DISPLAY_TEXT_RULES),
  detail: z.string().nullable().describe(COLLABORATION_DISPLAY_TEXT_RULES),
  recommendation: z.string().nullable().describe(COLLABORATION_DISPLAY_TEXT_RULES),
  evidence: z.string().nullable().describe(COLLABORATION_DISPLAY_TEXT_RULES),
  question: collaborationTodoQuestionSchema.nullable(),
  resolutionKind: z.enum(['resolved', 'merged', 'not_adopted', 'withdrawn']).nullable(),
  reason: z.string().describe(COLLABORATION_DISPLAY_TEXT_RULES),
  mergeTargetId: identifier.nullable(),
  userSourceIds: z.array(z.string().uuid()),
  evidenceRefs: z.array(collaborationDocumentSchema),
})
export type CollaborationTodoDelta = z.infer<typeof collaborationTodoDeltaSchema>
export const collaborationInputResponseSchema = z.strictObject({
  batchId: z.string().uuid(),
  memberId: z.string().min(1).max(100),
  disposition: z
    .enum(['responded', 'awaiting_confirmation', 'resolved'])
    .describe(
      'resolved means this authorized Actor fully handled the input and all required confirmations are complete. responded records partial handling only. awaiting_confirmation identifies a specific outstanding responsibility; it is not a generic acknowledgement.',
    ),
  reason: z.string().min(1).describe(COLLABORATION_DISPLAY_TEXT_RULES),
  todoId: identifier.nullable(),
})
export type CollaborationInputResponse = z.infer<typeof collaborationInputResponseSchema>
export const collaborationInputBatchReferenceSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
})
export type CollaborationInputBatchReference = z.infer<
  typeof collaborationInputBatchReferenceSchema
>
export const collaborationTurnAuthorizationSchema = z.strictObject({
  runId: z.string().uuid(),
  reportSourceRunId: z.string().uuid().optional(),
  taskId: z.string().uuid(),
  actor,
  duty: collaborationDutySchema,
  basePlanRef: z
    .object({
      type: z.literal('unchanged'),
      version: z.number().int().positive(),
      sourceRunId: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .nullable(),
  baseTodoRevision: z.number().int().nonnegative(),
  inputBatchId: z.string().uuid().nullable(),
  inputWatermark: z.number().int().nonnegative(),
  inputSequence: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative().optional(),
  resultNonce: z.string().uuid().optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.nullable(),
  basis: collaborationDocumentSchema.nullable(),
  requiredInputScopeRef: collaborationDocumentSchema.nullable(),
  effectiveDecisionIndexRef: collaborationDocumentSchema.nullable(),
  todoIdentityIndexRef: collaborationDocumentSchema.nullable(),
  reviewScopeRef: collaborationDocumentSchema.nullable(),
})
export type CollaborationTurnAuthorization = z.infer<typeof collaborationTurnAuthorizationSchema>
export const collaborationTodoSchema = z.strictObject({
  taskId: z.string().uuid(),
  id: identifier,
  revision: z.number().int().positive(),
  kind: z.enum(['opinion', 'decision', 'information']),
  status: z.enum(['open', 'awaiting_review', 'done']),
  title: z.string(),
  author: actor,
  answerResolver: actor.nullable(),
  needsUserAnswer: z
    .boolean()
    .describe(
      'True only for an open Todo whose current question still needs a user answer. A retained question on an awaiting_review or done Todo is historical context, not a new request for input.',
    ),
  question: collaborationTodoQuestionSchema.nullable(),
  resolutionKind: z.enum(['resolved', 'merged', 'not_adopted', 'withdrawn']).nullable(),
  resolutionReasonPreview: z.string(),
  document: collaborationDocumentSchema,
  sourceRunId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
})
export type CollaborationTodo = z.infer<typeof collaborationTodoSchema>
export const collaborationTodoPageSchema = z
  .strictObject({
    taskId: z.string().uuid(),
    ledgerRevision: z.number().int().nonnegative(),
    group: z.enum(['active', 'done', 'all']),
    items: z.array(collaborationTodoSchema).max(COLLABORATION_PAGE_ITEMS),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    previousOffset: z.number().int().nonnegative().nullable().optional(),
    activeCount: z.number().int().nonnegative(),
    doneCount: z.number().int().nonnegative(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_PAGE_BYTES,
    'Todo page exceeds its byte budget.',
  )
export type CollaborationTodoPage = z.infer<typeof collaborationTodoPageSchema>
export const collaborationSourceReadSchema = z.strictObject({
  inputRevision: z.number().int().nonnegative().optional(),
  runId: z
    .string()
    .uuid()
    .describe('Use the exact current sourceGrant.runId, never a historical Run reference.'),
  grant: z
    .string()
    .uuid()
    .describe(
      'Use the exact current sourceGrant.grant capability. Do not copy a grant from quoted history.',
    ),
  source: z
    .enum([
      'document',
      'todos',
      'decisions',
      'identities',
      'batch',
      'required_inputs',
      'handoff_sources',
    ])
    .default('document'),
  document: collaborationDocumentSchema
    .optional()
    .describe(
      'Document identity is matched only for source=document. Index reads are selected by source and the current Run; a contextual document reference does not select their rows.',
    ),
  taskId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative(),
})
export type CollaborationSourceRead = z.infer<typeof collaborationSourceReadSchema>
export const collaborationSourceReadResultSchema = z
  .strictObject({
    source: z.enum([
      'document',
      'todos',
      'decisions',
      'identities',
      'batch',
      'required_inputs',
      'handoff_sources',
    ]),
    text: z.string(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    document: collaborationDocumentSchema.optional(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_PAGE_BYTES,
    'Source page exceeds its byte budget.',
  )
export type CollaborationSourceReadResult = z.infer<typeof collaborationSourceReadResultSchema>
