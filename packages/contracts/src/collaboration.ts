import { z } from 'zod'

import {
  COLLABORATION_DISPLAY_TEXT_RULES,
  collaborationDocumentSchema,
  collaborationTodoDeltaSchema,
  collaborationInputResponseSchema,
  collaborationDutySchema,
  collaborationTodoPageSchema,
  collaborationTurnAuthorizationSchema,
  collaborationInputBatchReferenceSchema,
  type CollaborationTurnAuthorization,
} from './collaboration-todos.js'
export {
  collaborationDocumentSchema,
  collaborationSourceReadSchema,
} from './collaboration-todos.js'
export type { CollaborationDocument } from './collaboration-todos.js'

export const PACT_SKILLS = ['plan', 'build', 'review'] as const
export type PactSkill = (typeof PACT_SKILLS)[number]
export const pactSkillSchema = z.enum(PACT_SKILLS)
const agent = z.enum(['claude', 'codex'])
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength
export const COLLABORATION_BYTES = 48 * 1024
export const collaborationPlanReferenceSchema = z.strictObject({
  type: z.literal('unchanged'),
  version: z.number().int().positive(),
  sourceRunId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
export const collaborationPlanOutputSchema = z.union([
  z.string().min(1).regex(/\S/u).describe(COLLABORATION_DISPLAY_TEXT_RULES),
  collaborationPlanReferenceSchema,
])
export const collaborationResultShape = {
  inputRevision: z.number().int().nonnegative().optional(),
  resultNonce: z.string().uuid().nullable().optional(),
  submission: collaborationDutySchema,
  outcome: z.enum(['complete', 'needs_user', 'blocked', 'paused']),
  summary: z
    .string()
    .min(1)
    .describe(
      `A concise conclusion; do not repeat the plan or detailed findings. ${COLLABORATION_DISPLAY_TEXT_RULES}`,
    ),
  plan: collaborationPlanOutputSchema.optional(),
  reviewedPlan: collaborationPlanReferenceSchema.optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
  verdict: z.enum(['accepted', 'changes_requested', 'needs_user', 'incomplete']).optional(),
  todoDeltas: z.array(collaborationTodoDeltaSchema),
  inputResponses: z
    .array(collaborationInputResponseSchema)
    .describe(
      'Exactly one response for every member returned by the current required_inputs source, including each $body user request. A zero Comment memberCount never makes this array optional or empty.',
    ),
}
export const collaborationResultSchema = z
  .strictObject(collaborationResultShape)
  .superRefine((value, context) => {
    if (new Set(value.todoDeltas.map((item) => item.todoId)).size !== value.todoDeltas.length)
      context.addIssue({
        code: 'custom',
        message: 'Each Todo may be changed only once per result.',
      })
    const keys = value.inputResponses.map((item) => `${item.batchId}:${item.memberId}`)
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: 'custom', message: 'Input responses must be unique.' })
    if (value.todoDeltas.filter((item) => item.operation === 'create' && item.question).length > 3)
      context.addIssue({
        code: 'custom',
        message: 'Ask at most three new material questions per Turn.',
      })
    for (const item of value.todoDeltas) {
      if (
        item.operation === 'create' &&
        (item.kind === 'decision' || item.kind === 'information') &&
        !item.question
      )
        context.addIssue({
          code: 'custom',
          message: 'User question Todos require a question definition.',
        })
      if (
        item.question &&
        item.kind !== (item.question.type === 'choice' ? 'decision' : 'information')
      )
        context.addIssue({
          code: 'custom',
          message: 'Question updates must explicitly specify the matching Todo kind.',
        })
      if (
        item.operation === 'create' &&
        (!item.title?.trim() || !item.detail?.trim() || !item.kind || item.expectedRevision !== 0)
      )
        context.addIssue({
          code: 'custom',
          message: 'New Todos require title, problem, kind and revision zero.',
        })
      if (
        ['propose_resolution', 'confirm', 'reopen'].includes(item.operation) &&
        !item.reason.trim()
      )
        context.addIssue({
          code: 'custom',
          message: 'Every resolution, confirmation and reopening requires a reason.',
        })
      if (
        item.question?.type === 'choice' &&
        (item.question.options.length < 2 ||
          item.question.options.length > 3 ||
          new Set(item.question.options).size !== item.question.options.length ||
          (item.question.recommended !== null &&
            item.question.recommended >= item.question.options.length))
      )
        context.addIssue({
          code: 'custom',
          message: 'Decision choices and recommendation are invalid.',
        })
      if (item.question?.type === 'text' && item.question.options.length)
        context.addIssue({
          code: 'custom',
          message: 'Information questions do not have artificial choices.',
        })
    }
  })
export type CollaborationResult = z.infer<typeof collaborationResultSchema>
export const collaborationAnswerFormatSchema = z.literal('collaboration_envelope_v5')
export type CollaborationAnswerFormat = z.infer<typeof collaborationAnswerFormatSchema>
export const COLLABORATION_NATIVE_VERSION = 'pact-collaboration-envelope-v5'
export const collaborationEnvelopeSchema = z.strictObject({
  version: z.literal(COLLABORATION_NATIVE_VERSION),
  answer: z
    .string()
    .min(1)
    .regex(/\S/u)
    .describe(
      `The natural message contains the conclusion or questions; do not paste the full plan, Todo list or protocol. ${COLLABORATION_DISPLAY_TEXT_RULES}`,
    ),
  result: z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const normalized = { ...value }
    for (const key of ['plan', 'reviewedPlan', 'reviewScopeRef', 'verdict'])
      if (Reflect.get(normalized, key) === null) Reflect.set(normalized, key, undefined)
    return normalized
  }, collaborationResultSchema),
})

export function collaborationReportMarkdown(
  result: CollaborationResult,
  target: { type: 'summary' } | { type: 'feedback'; id: string },
): string {
  if (target.type === 'summary') return result.summary
  const item = result.todoDeltas.find((value) => value.todoId === target.id)
  if (!item) throw new Error('The selected opinion is unavailable.')
  return [
    item.title ? `### ${item.title}` : '',
    item.detail,
    item.recommendation ? `Suggestion: ${item.recommendation}` : '',
    item.evidence,
    item.reason,
  ]
    .filter(Boolean)
    .join('\n\n')
}
export const collaborationResultControlSchema = z.strictObject({
  ...collaborationResultShape,
  control: z.literal(true),
  summary: z.string(),
  todoDeltas: z.array(collaborationTodoDeltaSchema),
  inputResponses: z.array(collaborationInputResponseSchema.extend({ reason: z.string() })),
})
export const collaborationStageSchema = z.enum([
  'draft',
  'discuss',
  'clarify',
  'implement',
  'supplement',
  'review',
  'respond',
  'repair',
])
export type CollaborationStage = z.infer<typeof collaborationStageSchema>
export const collaborationActionSchema = z.enum([
  'continue',
  'execute',
  'respond',
  'repair',
  'pause',
  'resume',
  'resume_input',
  'cancel_input',
  'retry',
  'submit_report',
])
export type CollaborationAction = z.infer<typeof collaborationActionSchema>
const collaborationResumePhaseSchema = z.strictObject({
  stage: collaborationStageSchema.exclude(['supplement', 'clarify']),
  actor: agent,
  status: z.enum(['waiting', 'questions', 'ready', 'failed']),
  unstarted: z.boolean().optional(),
  workPending: z.boolean().optional(),
})
export interface CollaborationMarkdownNode {
  type: 'root' | 'element' | 'text'
  tagName?: string | undefined
  value?: string | undefined
  properties?: Record<string, string | number | boolean | string[]> | undefined
  children?: CollaborationMarkdownNode[] | undefined
}
export const collaborationMarkdownNodeSchema: z.ZodType<CollaborationMarkdownNode> = z.lazy(() =>
  z.strictObject({
    type: z.enum(['root', 'element', 'text']),
    tagName: z
      .enum([
        'a',
        'p',
        'span',
        'strong',
        'em',
        'del',
        'code',
        'pre',
        'blockquote',
        'ol',
        'ul',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'hr',
        'br',
        'img',
        'input',
      ])
      .optional(),
    value: z.string().optional(),
    properties: z
      .partialRecord(
        z.enum([
          'href',
          'title',
          'alt',
          'src',
          'className',
          'start',
          'align',
          'type',
          'checked',
          'disabled',
          'data-pact-node-id',
          'data-pact-projection-start',
          'data-pact-projection-end',
        ]),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      )
      .optional(),
    children: z.array(collaborationMarkdownNodeSchema).optional(),
  }),
)
export function collaborationMarkdownTreeWithinBudget(root: CollaborationMarkdownNode): boolean {
  const stack: Array<{ node: CollaborationMarkdownNode; depth: number }> = [
    { node: root, depth: 0 },
  ]
  let count = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++count > 512 || item.depth > 64) return false
    for (const node of item.node.children ?? []) {
      if (stack.length >= 512) return false
      stack.push({ node, depth: item.depth + 1 })
    }
  }
  return true
}
export const collaborationMarkdownPageSchema = z
  .strictObject({
    ordinal: z.number().int().nonnegative(),
    visibleStart: z.number().int().nonnegative(),
    visibleEnd: z.number().int().nonnegative(),
    tree: collaborationMarkdownNodeSchema,
    visibleText: z.string().max(4096),
  })
  .refine(
    (page) => collaborationMarkdownTreeWithinBudget(page.tree),
    'Markdown projection exceeds its node or stack budget.',
  )
export const collaborationTaskSchema = z.strictObject({
  reportFailure: z.enum(['missing', 'invalid']).optional(),
  reportRecovery: z
    .strictObject({
      sourceRunId: z.string().uuid(),
      sourceMessageId: z.string().uuid(),
      sourceContentRevision: z.number().int().nonnegative(),
      document: collaborationDocumentSchema.optional(),
      failureReason: z.string().max(512).optional(),
      failureDocument: collaborationDocumentSchema.optional(),
    })
    .optional(),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: pactSkillSchema,
  revision: z.number().int().nonnegative(),
  primary: agent,
  drafter: agent,
  implementer: agent,
  reviewer: agent,
  duty: collaborationDutySchema.optional(),
  authorization: collaborationTurnAuthorizationSchema.optional(),
  ledgerRevision: z.number().int().nonnegative().default(0),
  ledgerOpenCount: z.number().int().nonnegative().default(0),
  ledgerAwaitingCount: z.number().int().nonnegative().default(0),
  doneTodoCount: z.number().int().nonnegative().default(0),
  unansweredCount: z.number().int().nonnegative().default(0),
  questionPendingCount: z.number().int().nonnegative().default(0),
  inputSequence: z.number().int().nonnegative().default(0),
  processedWatermark: z.number().int().nonnegative().default(0),
  reviewedTodoRevision: z.number().int().nonnegative().optional(),
  reviewedInputWatermark: z.number().int().nonnegative().optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
  requiredInputScopeRef: collaborationDocumentSchema.optional(),
  effectiveDecisionIndexRef: collaborationDocumentSchema.optional(),
  todoIdentityIndexRef: collaborationDocumentSchema.optional(),
  task: z.string(),
  taskMessageId: z.string().uuid(),
  latestUserMessageId: z.string().uuid().optional(),
  stage: collaborationStageSchema,
  actor: agent,
  status: z.enum(['running', 'waiting', 'questions', 'ready', 'complete', 'paused', 'failed']),
  pausedStatus: z.enum(['waiting', 'questions', 'ready', 'failed']).optional(),
  runId: z.string().uuid(),
  sourceMessageId: z.string().uuid().optional(),
  plan: z.string().optional(),
  planDocument: collaborationDocumentSchema.optional(),
  noticeDocument: collaborationDocumentSchema.optional(),
  resultDocument: collaborationDocumentSchema.optional(),
  priorResultDocument: collaborationDocumentSchema.optional(),
  taskDocument: collaborationDocumentSchema.optional(),
  planVersion: z.number().int().nonnegative(),
  planReference: collaborationPlanReferenceSchema.optional(),
  reviewedPlan: collaborationPlanReferenceSchema.optional(),
  approvedPlanVersion: z.number().int().nonnegative().optional(),
  planAuthor: agent.optional(),
  discussionRounds: z.number().int().nonnegative(),
  discussionHalf: z.boolean(),
  reviewCycles: z.number().int().nonnegative(),
  repairAttempts: z.number().int().nonnegative(),
  rereview: z.boolean(),
  nextCycle: z.boolean(),
  resumePhase: collaborationResumePhaseSchema.optional(),
  releasedReservation: z.boolean().optional(),
  result: z.union([collaborationResultSchema, collaborationResultControlSchema]).optional(),
  priorResult: z.union([collaborationResultSchema, collaborationResultControlSchema]).optional(),
  resultFeedbackCount: z.number().int().nonnegative().optional(),
  resultHasOpenDecision: z.boolean().optional(),
  previousRunId: z.string().uuid().optional(),
  notice: z.string().optional(),
})
export type CollaborationTask = z.infer<typeof collaborationTaskSchema>
/** The due phase is preserved while one user supplement is being handled. */
export const collaborationPendingPhase = (task: CollaborationTask) => task.resumePhase ?? task
/** User answers settle questions, not an unfinished implementation or repair. */
export function collaborationPendingWork(task: CollaborationTask) {
  const phase = task.resumePhase
  if (
    phase &&
    (phase.stage === 'implement' || phase.stage === 'repair') &&
    (phase.workPending || phase.unstarted || phase.status === 'questions')
  )
    return phase
  if (
    !phase &&
    task.status === 'questions' &&
    task.result?.outcome === 'needs_user' &&
    (task.stage === 'implement' || task.stage === 'repair')
  )
    return { stage: task.stage, actor: task.actor, status: 'questions' as const, workPending: true }
  return undefined
}
export function collaborationSubmission(task: CollaborationTask) {
  if (task.duty) return task.duty
  if (collaborationRequiresPlan(task)) {
    if (!(task.plan || task.planDocument)) return 'plan_submission' as const
    if (task.actor !== task.primary) return 'plan_review' as const
    return task.planAuthor !== task.primary && !task.reviewedPlan
      ? ('plan_adoption' as const)
      : ('plan_submission' as const)
  }
  return task.stage === 'review' ||
    (task.resumePhase?.stage === 'review' && task.actor === task.reviewer)
    ? ('code_review' as const)
    : ('stage_result' as const)
}
const collaborationResultProjectionSchema = z.strictObject({
  ...collaborationResultShape,
  summary: z.string(),
  todoDeltas: z.array(collaborationTodoDeltaSchema).max(24),
  inputResponses: z.array(collaborationInputResponseSchema.extend({ reason: z.string() })).max(24),
})
const collaborationTaskProjectionSchema = collaborationTaskSchema.extend({
  result: collaborationResultProjectionSchema.optional(),
})
export const collaborationViewSchema = z
  .strictObject({
    received: z
      .strictObject({
        id: z.string().uuid(),
        actor: agent,
        state: z.enum(['accepted', 'blocked', 'cancelled']),
        preview: z.string().max(512),
      })
      .optional(),
    task: collaborationTaskProjectionSchema.nullable(),
    submittedReport: collaborationResultSchema.optional(),
    accepted: z.boolean().default(false),
    reportAvailable: z.boolean().default(false),
    documents: z
      .array(
        z.strictObject({ key: z.string().min(1).max(100), source: collaborationDocumentSchema }),
      )
      .max(64)
      .optional(),
    feedbackCount: z.number().int().nonnegative().optional(),
    feedbackOffset: z.number().int().nonnegative().optional(),
    nextFeedbackOffset: z.number().int().nonnegative().optional(),
    planSource: z
      .strictObject({ runId: z.string().uuid(), messageId: z.string().uuid() })
      .optional(),
    todos: collaborationTodoPageSchema.optional(),
    todo: collaborationTodoPageSchema.shape.items.element.optional(),
    todoCurrent: collaborationTodoPageSchema.shape.items.element
      .pick({ revision: true, status: true })
      .nullable()
      .optional(),
    todoSummaries: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(80),
          revision: z.number().int().positive(),
          title: z.string(),
        }),
      )
      .max(24)
      .optional(),
    actionable: z.boolean().default(false),
  })
  .refine((v) => bytes(v) <= COLLABORATION_BYTES, 'Collaboration view exceeds 48 KiB.')
export const collaborationActionInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  clientMessageId: z.string().uuid(),
  action: collaborationActionSchema,
  receivedInputId: z.string().uuid().optional(),
})
export type CollaborationActionInput = z.infer<typeof collaborationActionInputSchema>
export type CollaborationLimits = {
  maxDiscussionRounds: number
  maxReviewCycles: number
  maxRepairAttempts: number
}
export const otherAgent = (id: 'claude' | 'codex'): 'claude' | 'codex' =>
  id === 'claude' ? 'codex' : 'claude'

export function collaborationInspectionPhase(task: CollaborationTask): {
  stage: 'draft' | 'discuss' | 'review'
  actor: CollaborationTask['actor']
} {
  const phase = task.stage === 'supplement' ? collaborationPendingPhase(task) : task
  if (task.kind === 'plan' && ['draft', 'discuss', 'clarify'].includes(phase.stage))
    return task.plan || task.planDocument
      ? { stage: 'discuss', actor: otherAgent(task.planAuthor ?? phase.actor) }
      : { stage: 'draft', actor: task.drafter }
  return { stage: 'review', actor: task.reviewer }
}

export function collaborationRequiresPlan(task: CollaborationTask): boolean {
  return (
    task.kind === 'plan' &&
    (['draft', 'discuss', 'clarify'].includes(task.stage) ||
      (task.stage === 'supplement' &&
        ['draft', 'discuss', 'clarify'].includes(collaborationPendingPhase(task).stage)))
  )
}
export function collaborationSubmittedPlan(
  task: CollaborationTask,
  result: CollaborationResult,
): string | undefined {
  if (result.plan === undefined) return undefined
  if (typeof result.plan === 'string') return result.plan
  const expected = task.planReference,
    supplied = result.plan
  if (
    !(task.plan || task.planDocument) ||
    !expected ||
    expected.version !== supplied.version ||
    expected.sourceRunId !== supplied.sourceRunId ||
    expected.sha256 !== supplied.sha256
  )
    throw new Error('The submitted plan reference is not the frozen plan version and source.')
  return task.plan
}
/** Native output is one exact, frozen duty. Optional host fields are required nullable native fields. */
export function collaborationOutputSchema(
  task: CollaborationTask,
  authorization?: CollaborationTurnAuthorization,
): Record<string, unknown> {
  const submission = authorization?.duty ?? collaborationSubmission(task)
  const supplied = authorization?.basePlanRef ?? task.planReference
  const reference = supplied
    ? collaborationPlanReferenceSchema.extend({
        version: z.literal(supplied.version),
        sourceRunId: z.literal(supplied.sourceRunId),
        sha256: z.literal(supplied.sha256),
      })
    : z.never()
  const publishes = ['plan_submission', 'plan_adoption'].includes(submission)
  const reviews = ['plan_review', 'plan_adoption', 'code_review'].includes(submission)
  const scope = authorization?.reviewScopeRef ?? task.reviewScopeRef
  const planText = z.string().min(1).describe(COLLABORATION_DISPLAY_TEXT_RULES)
  const schema = collaborationEnvelopeSchema.extend({
    result: z.strictObject({
      ...collaborationResultShape,
      inputRevision: z.number().int().nonnegative(),
      resultNonce: z.string().uuid().nullable(),
      submission: z.literal(submission),
      plan: publishes ? (supplied ? z.union([planText, reference]) : planText) : z.null(),
      reviewedPlan:
        submission === 'plan_review'
          ? reference
          : submission === 'plan_adoption'
            ? reference.nullable()
            : z.null(),
      reviewScopeRef:
        submission === 'code_review' && scope
          ? collaborationDocumentSchema.extend({
              id: z.literal(scope.id),
              sha256: z.literal(scope.sha256),
            })
          : z.null(),
      verdict: reviews
        ? z.enum(['accepted', 'changes_requested', 'needs_user', 'incomplete']).nullable()
        : z.null(),
    }),
  })
  return { ...z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) }
}

/** Only explicit user actions advance a frozen responsibility. */
export function advanceCollaboration(
  task: CollaborationTask,
  action: CollaborationAction,
  limits: CollaborationLimits,
): CollaborationTask {
  if (
    task.status === 'running' ||
    (task.status === 'complete' && !(action === 'continue' && !collaborationRequiresPlan(task)))
  )
    throw new Error('This task has no pending action.')
  const next = structuredClone(task)
  if (action === 'pause') {
    next.pausedStatus =
      task.status === 'paused'
        ? task.pausedStatus
        : task.status === 'ready'
          ? 'ready'
          : task.status === 'failed'
            ? 'failed'
            : task.status === 'questions'
              ? 'questions'
              : 'waiting'
    next.status = 'paused'
    next.revision++
    return next
  }
  if (action === 'resume') {
    if (task.status !== 'paused') throw new Error('This task is not paused.')
    next.status = task.pausedStatus ?? 'waiting'
    next.pausedStatus = undefined
    next.revision++
    return next
  }
  if (task.status === 'paused') throw new Error('Resume this task before dispatching.')
  if (action === 'submit_report') {
    if (task.status !== 'failed' || !task.reportFailure || !task.sourceMessageId)
      throw new Error('There is no completed report to submit.')
    next.reportRecovery = {
      ...(task.reportRecovery ?? {
        sourceRunId: task.runId,
        sourceMessageId: task.sourceMessageId,
        sourceContentRevision: 0,
      }),
      failureReason: task.notice && task.notice.length <= 512 ? task.notice : undefined,
      failureDocument: task.noticeDocument,
    }
  } else if (action === 'execute') {
    if (task.kind !== 'plan' || task.status !== 'ready' || !(task.plan || task.planDocument))
      throw new Error('The current plan has not been accepted.')
    next.stage = 'implement'
    next.actor = task.implementer
    next.duty = 'stage_result'
    next.resumePhase = undefined
    next.approvedPlanVersion = task.planVersion
  } else if (action === 'retry') {
    if (task.status !== 'failed') throw new Error('This task cannot be retried.')
    if (task.stage === 'repair') next.repairAttempts++
    else if (task.stage === 'implement' && !task.resumePhase?.unstarted) {
      next.stage = 'repair'
      next.actor = task.implementer
      next.duty = 'stage_result'
      next.repairAttempts++
    } else if (task.stage === 'review') {
      if (!task.releasedReservation || !task.rereview) next.reviewCycles++
      if (!task.releasedReservation) next.rereview = false
    } else if (
      task.stage === 'discuss' &&
      task.releasedReservation &&
      task.actor !== task.primary
    ) {
      next.discussionRounds++
      next.discussionHalf = true
    }
  } else if (action === 'respond' || action === 'repair') {
    if (
      collaborationRequiresPlan(task) ||
      collaborationPendingWork(task) ||
      collaborationPendingPhase(task).stage !== 'review' ||
      task.ledgerOpenCount + task.ledgerAwaitingCount === 0
    )
      throw new Error('This review has no pending opinions.')
    if (action === 'repair' && (task.questionPendingCount || task.unansweredCount))
      throw new Error('Settle the required user questions before repairing code.')
    next.stage = action
    next.actor = task.implementer
    next.duty = 'stage_result'
    next.resumePhase = undefined
    if (task.nextCycle) next.reviewCycles++
    next.nextCycle = false
    if (action === 'repair') next.repairAttempts++
  } else if (action === 'continue') {
    const phase = collaborationPendingPhase(task)
    const pendingWork = collaborationPendingWork(task)
    if (collaborationRequiresPlan(task)) {
      next.stage = 'discuss'
      next.actor = task.actor === task.primary ? otherAgent(task.primary) : task.primary
      next.duty = undefined
      if (next.actor !== task.primary) {
        next.discussionRounds++
        next.discussionHalf = true
      } else next.discussionHalf = false
    } else if (pendingWork) {
      if (task.questionPendingCount || task.unansweredCount)
        throw new Error('Settle the required user questions before resuming work.')
      next.stage = pendingWork.stage
      next.actor = pendingWork.actor
      next.resumePhase = undefined
      next.duty = 'stage_result'
    } else if (['implement', 'repair', 'respond', 'supplement', 'review'].includes(task.stage)) {
      next.stage = 'review'
      next.actor = task.reviewer
      next.duty = 'code_review'
      next.resumePhase = undefined
      next.rereview = phase.stage === 'repair' || phase.stage === 'respond'
      if (!next.rereview) next.reviewCycles++
    } else throw new Error('Choose a response or repair action.')
  } else throw new Error('This task action is unavailable.')
  if (
    (next.discussionRounds > task.discussionRounds &&
      next.discussionRounds > limits.maxDiscussionRounds) ||
    (next.reviewCycles > task.reviewCycles && next.reviewCycles > limits.maxReviewCycles) ||
    (next.repairAttempts > task.repairAttempts && next.repairAttempts > limits.maxRepairAttempts)
  )
    throw new Error('The configured collaboration limit has been reached.')
  next.priorResult = task.result ?? task.priorResult
  next.priorResultDocument = task.resultDocument ?? task.priorResultDocument
  next.result = undefined
  next.resultDocument = undefined
  next.authorization = undefined
  next.status = 'running'
  next.revision++
  next.notice = undefined
  next.releasedReservation = false
  if (action !== 'submit_report') {
    next.reportRecovery = undefined
    next.reportFailure = undefined
  }
  next.previousRunId = task.runId
  return collaborationTaskSchema.parse(next)
}

export interface CollaborationSettlementFacts {
  reviewInputSequence?: number
  planApplied?: boolean
  planChanged?: boolean
  acceptedReview?: boolean
  ledgerRevision: number
  ledgerOpenCount: number
  ledgerAwaitingCount: number
  doneTodoCount: number
  unansweredCount: number
  questionPendingCount: number
  inputSequence: number
  processedWatermark: number
}
/** Repository supplies these facts after validating/applying the complete persistent ledger in one transaction. */
export function settleCollaboration(
  task: CollaborationTask,
  result: CollaborationResult,
  facts?: CollaborationSettlementFacts,
): CollaborationTask {
  const duty = task.authorization?.duty ?? collaborationSubmission(task)
  if (result.submission !== duty) throw new Error('The result does not match the frozen duty.')
  const next = structuredClone(task)
  if (facts)
    Object.assign(next, {
      ledgerRevision: facts.ledgerRevision,
      ledgerOpenCount: facts.ledgerOpenCount,
      ledgerAwaitingCount: facts.ledgerAwaitingCount,
      doneTodoCount: facts.doneTodoCount,
      unansweredCount: facts.unansweredCount,
      questionPendingCount: facts.questionPendingCount,
      inputSequence: facts.inputSequence,
      processedWatermark: facts.processedWatermark,
    })
  const publishes = duty === 'plan_submission' || duty === 'plan_adoption'
  const adoptionAccepted =
    duty === 'plan_adoption' && typeof result.plan === 'object' && result.verdict === 'accepted'
  const reviews = duty === 'plan_review' || duty === 'code_review' || adoptionAccepted
  if (publishes) {
    if (result.plan === undefined && !facts?.planApplied)
      throw new Error(
        'Every planning response must submit a complete plan or exact unchanged reference.',
      )
    if (!facts?.planApplied && result.plan !== undefined) {
      const submitted = collaborationSubmittedPlan(task, result)
      if (!(task.plan || task.planDocument) && task.actor !== task.drafter)
        throw new Error('Only the specified drafter can publish the initial plan.')
      if ((task.plan || task.planDocument) && task.actor !== task.primary)
        throw new Error('Only the Primary can maintain the plan.')
      if (typeof result.plan === 'string' && submitted !== task.plan) {
        next.plan = submitted
        next.planDocument = undefined
        next.planReference = undefined
        next.planVersion++
        next.planAuthor = task.actor
        next.reviewedPlan = undefined
        next.approvedPlanVersion = undefined
        next.reviewedTodoRevision = undefined
      }
    }
    if (
      duty === 'plan_adoption' &&
      typeof result.plan === 'string' &&
      result.verdict === 'accepted'
    )
      throw new Error('A revised initial plan requires peer review.')
  } else if (result.plan !== undefined) throw new Error('This duty cannot publish a plan.')
  if (duty === 'plan_review' || adoptionAccepted) {
    if (!result.reviewedPlan)
      throw new Error('A plan review must identify the exact reviewed plan.')
    collaborationSubmittedPlan(task, { ...result, plan: result.reviewedPlan })
  }
  if (
    duty === 'code_review' &&
    task.authorization?.reviewScopeRef &&
    result.reviewScopeRef?.id !== task.authorization.reviewScopeRef.id
  )
    throw new Error('Code review must identify its frozen scope.')
  if ((duty === 'plan_review' || duty === 'code_review') && !result.verdict)
    throw new Error('Formal review requires a verdict.')
  if (!reviews && duty !== 'plan_adoption' && result.verdict !== undefined)
    throw new Error('A response cannot claim review acceptance.')
  const noUnresolved =
    next.ledgerOpenCount === 0 &&
    next.ledgerAwaitingCount === 0 &&
    next.unansweredCount === 0 &&
    next.processedWatermark === next.inputSequence
  if (reviews && result.verdict === 'accepted') {
    const frozenResolved =
      next.ledgerOpenCount === 0 &&
      next.ledgerAwaitingCount === 0 &&
      next.unansweredCount === 0 &&
      next.processedWatermark >= (facts?.reviewInputSequence ?? next.inputSequence)
    if (result.outcome !== 'complete' || !facts?.acceptedReview || !frozenResolved)
      throw new Error(
        'Review acceptance requires a completed review and its complete frozen input scope to be resolved.',
      )
    if (duty !== 'code_review') next.reviewedPlan = result.reviewedPlan
    next.reviewedTodoRevision = next.ledgerRevision
    next.reviewedInputWatermark = next.processedWatermark
  }
  if (facts?.planChanged) {
    next.reviewedPlan = undefined
    next.reviewedTodoRevision = undefined
    next.reviewedInputWatermark = undefined
    next.approvedPlanVersion = undefined
  }
  next.result = result
  next.resultDocument = undefined
  next.resultFeedbackCount = result.todoDeltas.length
  next.resultHasOpenDecision = next.unansweredCount > 0
  next.reportFailure = undefined
  next.reportRecovery = undefined
  next.priorResult = undefined
  next.priorResultDocument = undefined
  next.notice = undefined
  next.noticeDocument = undefined
  next.revision++
  if (
    duty === 'stage_result' &&
    !task.reportRecovery &&
    (task.stage === 'implement' || task.stage === 'repair')
  )
    next.resumePhase =
      result.outcome === 'complete'
        ? undefined
        : {
            stage: task.stage,
            actor: task.actor,
            status:
              result.outcome === 'needs_user'
                ? 'questions'
                : result.outcome === 'blocked'
                  ? 'failed'
                  : 'waiting',
            workPending: true,
          }
  if (result.outcome === 'paused') {
    next.status = 'paused'
    next.notice = result.summary
    return next
  }
  if (result.outcome === 'blocked') {
    next.status = 'failed'
    next.notice = result.summary
    return next
  }
  if (result.outcome === 'needs_user' || next.unansweredCount > 0) {
    next.status = 'questions'
    return next
  }
  if (collaborationRequiresPlan(task)) {
    const accepted = Boolean(
      next.reviewedPlan &&
      next.reviewedPlan.version === next.planVersion &&
      next.reviewedPlan.sha256 === next.planReference?.sha256,
    )
    next.status = accepted && noUnresolved ? 'ready' : 'waiting'
  } else if (reviews && duty === 'code_review') {
    next.status =
      result.verdict === 'accepted' && noUnresolved && !collaborationPendingWork(next)
        ? 'complete'
        : 'waiting'
    next.nextCycle = task.rereview && next.status !== 'complete'
  } else next.status = 'waiting'
  return collaborationTaskSchema.parse(next)
}

export const collaborationToolJsonSchema = (task: CollaborationTask): Record<string, unknown> => {
  const schema = collaborationOutputSchema(task)
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties))
    throw new Error('Report schema is unavailable.')
  const result = Reflect.get(properties, 'result')
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Report schema is unavailable.')
  return { ...result }
}

/** Send stays read-only and routes answers to a frozen responsibility, never through an implicit Primary Turn. */
export function prepareCollaborationSupplement(
  task: CollaborationTask,
  actor: 'claude' | 'codex',
  _limits: CollaborationLimits,
  planningAction?: 'maintain_plan' | 'review_plan',
): CollaborationTask {
  const next = structuredClone(task)
  if (
    planningAction &&
    (!collaborationRequiresPlan(task) ||
      actor !== (planningAction === 'maintain_plan' ? task.primary : otherAgent(task.primary)))
  )
    throw new Error('This planning purpose is unavailable.')
  if (collaborationRequiresPlan(task)) {
    next.stage = task.plan || task.planDocument ? 'discuss' : 'draft'
    next.actor = actor
    next.duty = undefined
    next.duty = collaborationSubmission(next)
    next.resumePhase = undefined
  } else {
    const phase = collaborationPendingPhase(task)
    const pendingWork = collaborationPendingWork(task)
    next.resumePhase = task.resumePhase ?? {
      stage: collaborationResumePhaseSchema.shape.stage.parse(
        phase.stage === 'clarify' || phase.stage === 'supplement' ? 'respond' : phase.stage,
      ),
      actor: phase.actor,
      status:
        task.status === 'ready'
          ? 'ready'
          : task.status === 'failed'
            ? 'failed'
            : task.status === 'questions'
              ? 'questions'
              : 'waiting',
      ...(pendingWork ? { workPending: true } : {}),
    }
    next.actor = actor
    if (actor === task.reviewer && (phase.stage === 'review' || task.unansweredCount > 0)) {
      next.stage = 'review'
      next.duty = 'code_review'
    } else {
      next.stage = 'supplement'
      next.duty = 'stage_result'
    }
  }
  next.status = 'running'
  next.authorization = undefined
  next.revision++
  next.previousRunId = task.runId
  next.priorResult = task.result ?? task.priorResult
  next.priorResultDocument = task.resultDocument ?? task.priorResultDocument
  next.result = undefined
  next.resultDocument = undefined
  next.reportFailure = undefined
  next.reportRecovery = undefined
  next.notice = undefined
  return collaborationTaskSchema.parse(next)
}
