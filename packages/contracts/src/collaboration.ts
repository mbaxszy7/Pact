import { z } from 'zod'

import {
  COLLABORATION_PAGE_BYTES,
  collaborationDocumentSchema,
  collaborationInputBatchReferenceSchema,
} from './collaboration-documents.js'

export * from './collaboration-documents.js'

const agent = z.enum(['claude', 'codex'])
export const PACT_SKILLS = ['plan', 'build', 'review'] as const
export type PactSkill = (typeof PACT_SKILLS)[number]
export const pactSkillSchema = z.enum(PACT_SKILLS)
export const COLLABORATION_PROTOCOL = 'native-workflow-v1' as const
export const COLLABORATION_BYTES = COLLABORATION_PAGE_BYTES

export const collaborationStageSchema = z.enum([
  'plan',
  'plan_review',
  'implement',
  'code_review',
  'respond',
  'repair',
  'reply',
])
export type CollaborationStage = z.infer<typeof collaborationStageSchema>
export const collaborationWorkStageSchema = collaborationStageSchema.exclude(['reply'])

export const collaborationReviewVerdictSchema = z.enum([
  'accepted',
  'changes_requested',
  'needs_user',
  'incomplete',
])
export type CollaborationReviewVerdict = z.infer<typeof collaborationReviewVerdictSchema>
const questionOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(512).optional(),
})
const questionShape = {
  prompt: z.string().trim().min(1).max(2048),
  selection: z.enum(['single', 'multiple']),
  options: z.array(questionOptionSchema).min(2).max(6).optional(),
}
export const collaborationQuestionsSchema = z
  .array(z.strictObject(questionShape))
  .min(1)
  .max(3)
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8 * 1024,
    'Questions exceed 8 KiB. Ask fewer or shorter questions without truncating the report.',
  )
export type CollaborationQuestions = z.infer<typeof collaborationQuestionsSchema>
export const collaborationDecisionQuestionsSchema = z
  .array(
    z.strictObject({
      ...questionShape,
      id: z.string().regex(/^q[1-3]$/u),
      options: z
        .array(questionOptionSchema.extend({ id: z.string().regex(/^o[1-6]$/u) }))
        .min(2)
        .max(6)
        .optional(),
    }),
  )
  .min(1)
  .max(3)
  .refine(
    (questions) =>
      questions.every(
        (question, index) =>
          question.id === `q${index + 1}` &&
          (!question.options ||
            question.options.every((option, optionIndex) => option.id === `o${optionIndex + 1}`)),
      ) &&
      collaborationQuestionsSchema.safeParse(
        questions.map(({ id: _id, options, ...question }) => ({
          ...question,
          ...(options ? { options: options.map(({ id: _optionId, ...option }) => option) } : {}),
        })),
      ).success,
    'Decision questions must preserve their bounded source order.',
  )
export type CollaborationDecisionQuestions = z.infer<typeof collaborationDecisionQuestionsSchema>
export function bindCollaborationQuestions(
  questions: CollaborationQuestions | undefined,
): CollaborationDecisionQuestions | undefined {
  return questions?.map(({ options, ...question }, index) => ({
    ...question,
    id: `q${index + 1}`,
    ...(options
      ? {
          options: options.map((option, optionIndex) => ({ ...option, id: `o${optionIndex + 1}` })),
        }
      : {}),
  }))
}

/** Stored observations may predate question forms; new tool submissions must include them. */
export const collaborationReviewObservationSchema = z.strictObject({
  verdict: collaborationReviewVerdictSchema,
  questions: collaborationQuestionsSchema.optional(),
})
export type CollaborationReviewObservation = z.infer<typeof collaborationReviewObservationSchema>
/** The model supplies the result and questions; the host binds its basis and actor. */
export const collaborationReviewInputSchema = collaborationReviewObservationSchema.refine(
  (value) => (value.verdict === 'needs_user') === Boolean(value.questions),
  'Provide questions exactly when the verdict is needs_user.',
)

/** Native current-root submission intent to retain the frozen plan; no model-chosen reference. */
export const collaborationRetainedPlanSchema = z.strictObject({
  nativeId: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().positive(),
  chars: z.number().int().positive(),
})
export type CollaborationRetainedPlan = z.infer<typeof collaborationRetainedPlanSchema>

export const collaborationPlanReferenceSchema = z.strictObject({
  version: z.number().int().positive(),
  sourceRunId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  document: collaborationDocumentSchema,
})
export type CollaborationPlanReference = z.infer<typeof collaborationPlanReferenceSchema>

export const collaborationPlanSettlementSchema = z.strictObject({
  kind: z.enum(['published', 'retained']),
  nativeId: z.string().min(1).max(1024),
  planReference: collaborationPlanReferenceSchema,
  sourceMessageId: z.string().uuid(),
  inputSequence: z.number().int().nonnegative(),
})
export type CollaborationPlanSettlement = z.infer<typeof collaborationPlanSettlementSchema>

export const collaborationReviewSchema = z.strictObject({
  runId: z.string().uuid(),
  actor: agent,
  stage: z.enum(['plan_review', 'code_review']),
  verdict: collaborationReviewVerdictSchema,
  inputSequence: z.number().int().nonnegative(),
  planReference: collaborationPlanReferenceSchema.optional(),
  scopeRef: collaborationDocumentSchema.optional(),
  document: collaborationDocumentSchema,
})
export type CollaborationReview = z.infer<typeof collaborationReviewSchema>

export const collaborationInputOutcomeSchema = z.enum(['processed', 'needs_user', 'incomplete'])
export type CollaborationInputOutcome = z.infer<typeof collaborationInputOutcomeSchema>
export const collaborationInputObservationSchema = z.strictObject({
  outcome: collaborationInputOutcomeSchema,
  questions: collaborationQuestionsSchema.optional(),
})
export type CollaborationInputObservation = z.infer<typeof collaborationInputObservationSchema>
export const collaborationInputResultSchema = collaborationInputObservationSchema
  .extend({ outcome: z.enum(['processed', 'needs_user']) })
  .refine(
    (value) => (value.outcome === 'needs_user') === Boolean(value.questions),
    'Provide questions exactly when the outcome is needs_user.',
  )
const collaborationInputProcessingSchema = z.strictObject({
  decision: z
    .strictObject({
      runId: z.string().uuid(),
      inputSequence: z.number().int().nonnegative(),
      messageId: z.string().uuid().optional(),
      questions: collaborationDecisionQuestionsSchema.optional(),
      actor: agent.optional(),
    })
    .optional(),
  pending: z
    .strictObject({ inputId: z.string().uuid(), inputSequence: z.number().int().nonnegative() })
    .optional(),
  settled: z
    .strictObject({ runId: z.string().uuid(), inputSequence: z.number().int().nonnegative() })
    .optional(),
})
export type CollaborationInputProcessing = z.infer<typeof collaborationInputProcessingSchema>

/** Frozen at Run admission. Native tools never get to choose these identities. */
export const collaborationTurnAuthorizationSchema = z.strictObject({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskRevision: z.number().int().nonnegative(),
  actor: agent,
  stage: collaborationStageSchema,
  inputSequence: z.number().int().nonnegative(),
  planReference: collaborationPlanReferenceSchema.optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
  inputProcessing: collaborationInputProcessingSchema.optional(),
  sourceManifestRef: collaborationDocumentSchema.optional(),
})
export type CollaborationTurnAuthorization = z.infer<typeof collaborationTurnAuthorizationSchema>

export const collaborationTaskSchema = z.strictObject({
  protocol: z.literal(COLLABORATION_PROTOCOL),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: pactSkillSchema,
  revision: z.number().int().nonnegative(),
  owner: agent,
  reviewer: agent,
  task: z.string(),
  taskDocument: collaborationDocumentSchema.optional(),
  taskMessageId: z.string().uuid(),
  latestUserMessageId: z.string().uuid().optional(),
  stage: collaborationStageSchema,
  actor: agent,
  status: z.enum(['running', 'waiting', 'questions', 'ready', 'complete', 'failed']),
  /** Pausing automation never suppresses settlement of the current native root. */
  automation: z.enum(['active', 'paused']),
  pauseReason: z
    .enum(['user_message', 'user', 'needs_user', 'restart', 'limit', 'failure', 'stopped'])
    .optional(),
  runId: z.string().uuid(),
  sourceMessageId: z.string().uuid().optional(),
  authorization: collaborationTurnAuthorizationSchema.optional(),
  inputSequence: z.number().int().nonnegative(),
  handledInputSequence: z.number().int().nonnegative(),
  inputProcessing: collaborationInputProcessingSchema.optional(),
  planVersion: z.number().int().nonnegative(),
  planReference: collaborationPlanReferenceSchema.optional(),
  planInputSequence: z.number().int().nonnegative().optional(),
  review: collaborationReviewSchema.optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
  codeRunId: z.string().uuid().optional(),
  /** Only an already-authorized unfinished write may be resumed without a new Repair action. */
  pendingWork: z
    .strictObject({
      stage: z.enum(['implement', 'repair']),
      runId: z.string().uuid(),
      inputSequence: z.number().int().nonnegative(),
      planReference: collaborationPlanReferenceSchema.optional(),
      repairReservationReleased: z.boolean().optional(),
    })
    .optional(),
  nextStage: collaborationWorkStageSchema.optional(),
  discussionRounds: z.number().int().nonnegative(),
  reviewCycles: z.number().int().nonnegative(),
  repairAttempts: z.number().int().nonnegative(),
  notice: z.string().max(512).optional(),
})
export type CollaborationTask = z.infer<typeof collaborationTaskSchema>

/** Only the frozen owner may publish or retain a native plan for this root. */
export function collaborationPlanMode(
  task: CollaborationTask | undefined,
  authorization?: CollaborationTurnAuthorization,
): boolean {
  const stage = authorization?.stage ?? task?.stage
  const actor = authorization?.actor ?? task?.actor
  return Boolean(
    task &&
    actor === task.owner &&
    (stage === 'plan' || (stage === 'reply' && task.kind === 'plan' && !task.codeRunId)),
  )
}

export const collaborationActionSchema = z.enum([
  'continue',
  'execute',
  'respond',
  'repair',
  'pause',
  'resume',
  'retry',
  'recover_plan',
])
export type CollaborationAction = z.infer<typeof collaborationActionSchema>
export const collaborationActionInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  action: collaborationActionSchema,
  clientMessageId: z.string().uuid(),
})
export type CollaborationActionInput = z.infer<typeof collaborationActionInputSchema>
export interface CollaborationLimits {
  maxDiscussionRounds: number
  maxReviewCycles: number
  maxRepairAttempts: number
}

export const otherAgent = (id: 'claude' | 'codex'): 'claude' | 'codex' =>
  id === 'claude' ? 'codex' : 'claude'

export function collaborationRequiresPlan(task: CollaborationTask): boolean {
  if (task.kind !== 'plan' || task.codeRunId) return false
  const pending = task.pendingWork
  if (pending?.stage !== 'implement') return true
  const unchangedPlan =
    pending.planReference?.version === task.planReference?.version &&
    pending.planReference?.document.sha256 === task.planReference?.document.sha256
  return (
    !unchangedPlan ||
    (pending.inputSequence !== task.inputSequence && !collaborationPlanAccepted(task))
  )
}

export function collaborationPlanAccepted(task: CollaborationTask): boolean {
  const plan = task.planReference
  const review = task.review
  return Boolean(
    !collaborationInputGate(task) &&
    plan &&
    task.planInputSequence === task.inputSequence &&
    review?.stage === 'plan_review' &&
    review.actor === task.reviewer &&
    review.verdict === 'accepted' &&
    review.inputSequence === task.inputSequence &&
    review.planReference?.version === plan.version &&
    review.planReference.document.sha256 === plan.document.sha256,
  )
}

/** Older native-workflow records retain their unresolved questions until proved processed. */
export function collaborationInputProcessing(
  task: CollaborationTask,
): CollaborationInputProcessing {
  if (task.inputProcessing) return task.inputProcessing
  const decision =
    task.status === 'questions' && task.runId !== task.review?.runId
      ? {
          runId: task.runId,
          inputSequence: task.authorization?.inputSequence ?? task.inputSequence,
          ...(task.sourceMessageId ? { messageId: task.sourceMessageId } : {}),
        }
      : task.review?.verdict === 'needs_user'
        ? {
            runId: task.review.runId,
            inputSequence: task.review.inputSequence,
            ...(task.runId === task.review.runId && task.sourceMessageId
              ? { messageId: task.sourceMessageId }
              : {}),
          }
        : undefined
  return {
    ...(decision ? { decision } : {}),
    ...(task.stage === 'reply' &&
    (task.status === 'running' ||
      task.status === 'failed' ||
      task.handledInputSequence < task.inputSequence)
      ? {
          pending: {
            inputId: task.latestUserMessageId ?? task.taskMessageId,
            inputSequence: task.inputSequence,
          },
        }
      : {}),
  }
}

export function collaborationInputGate(
  task: CollaborationTask,
): 'needs_reply' | 'queued' | 'processing' | 'incomplete' | undefined {
  const input = collaborationInputProcessing(task)
  if (
    task.stage === 'reply' &&
    task.status === 'failed' &&
    (input.settled?.runId !== task.runId || input.settled.inputSequence !== task.inputSequence)
  )
    return 'incomplete'
  if (!input.pending) return input.decision ? 'needs_reply' : undefined
  if (task.status === 'failed') return 'incomplete'
  if (task.stage === 'reply' && task.status === 'running') return 'processing'
  return 'queued'
}

/** Recompute from current facts; no queued prompt or old action is an authority to resume. */
export function collaborationNextStage(task: CollaborationTask): CollaborationStage | undefined {
  if (task.status === 'complete') return undefined
  if (collaborationInputGate(task)) return undefined
  if (collaborationRequiresPlan(task)) {
    if (!task.planReference || task.planInputSequence !== task.inputSequence) return 'plan'
    if (collaborationPlanAccepted(task)) return undefined
    if (
      task.review?.stage === 'plan_review' &&
      task.review.inputSequence === task.inputSequence &&
      task.review.planReference?.version === task.planReference.version &&
      task.review.verdict === 'changes_requested' &&
      task.nextStage === 'plan'
    )
      return 'plan'
    return 'plan_review'
  }
  if (task.pendingWork) return task.pendingWork.stage
  if (task.review && task.review.inputSequence < task.inputSequence) return 'code_review'
  return task.nextStage
}

export function collaborationActor(task: CollaborationTask, stage: CollaborationStage) {
  return stage === 'plan_review' || stage === 'code_review'
    ? task.reviewer
    : stage === 'reply' && task.kind === 'review'
      ? task.reviewer
      : task.owner
}

export function collaborationStageLabel(stage: CollaborationStage): string {
  return {
    plan: 'Update the plan',
    plan_review: 'Review the current plan',
    implement: 'Implement the accepted plan',
    code_review: 'Review the current changes',
    respond: 'Respond to the review',
    repair: 'Repair the reviewed changes',
    reply: 'Reply to your message',
  }[stage]
}

export function collaborationAvailableActions(task: CollaborationTask): CollaborationAction[] {
  if (task.status === 'complete') return []
  if (collaborationInputGate(task)) return task.automation === 'active' ? ['pause'] : []
  if (task.status === 'running') return task.automation === 'active' ? ['pause'] : ['resume']
  if (task.automation === 'paused') return ['resume']
  if (collaborationRequiresPlan(task) && collaborationPlanAccepted(task))
    return ['execute', 'pause']
  if (task.status === 'failed') return ['retry', 'pause']
  if (
    task.review?.stage === 'code_review' &&
    task.review.verdict === 'changes_requested' &&
    task.review.inputSequence === task.inputSequence &&
    !task.nextStage &&
    !task.pendingWork
  )
    return ['respond', 'repair', 'pause']
  return collaborationNextStage(task) ? ['continue', 'pause'] : ['pause']
}

/** Reserve counters before dispatch; proven-unsent reservations alone may be released. */
export function advanceCollaboration(
  task: CollaborationTask,
  action: CollaborationAction,
  limits: CollaborationLimits,
): CollaborationTask {
  if (task.status === 'complete') throw new Error('This collaboration is already complete.')
  if (action === 'recover_plan')
    throw new Error('Plan recovery checks the original source; it cannot advance collaboration.')
  const next = structuredClone(task)
  if (action === 'pause') {
    next.automation = 'paused'
    next.pauseReason = 'user'
    next.revision++
    return next
  }
  if (collaborationInputGate(task))
    throw new Error(
      'Reply to the questions and wait until your reply has been processed before continuing collaboration.',
    )
  if (action === 'resume') {
    if (task.automation !== 'paused') throw new Error('This collaboration is not paused.')
    next.automation = 'active'
    next.pauseReason = undefined
    next.notice = undefined
    next.revision++
    if (task.status !== 'running') {
      const stage = collaborationNextStage(next)
      next.status =
        collaborationRequiresPlan(next) && collaborationPlanAccepted(next)
          ? 'ready'
          : !stage &&
              next.review?.stage === 'code_review' &&
              next.review.verdict === 'accepted' &&
              next.review.inputSequence === next.inputSequence
            ? 'complete'
            : 'waiting'
      if (stage && stage !== 'reply') next.nextStage = stage
    }
    return collaborationTaskSchema.parse(next)
  }
  if (task.status === 'running') throw new Error('The current Agent is still working.')
  if (task.automation === 'paused')
    throw new Error('Continue collaboration before starting its next action.')
  let stage: CollaborationStage | undefined
  if (action === 'execute') {
    if (!collaborationRequiresPlan(task) || !collaborationPlanAccepted(task))
      throw new Error('The current plan has not been accepted.')
    stage = 'implement'
    next.pendingWork = undefined
  } else if (action === 'respond' || action === 'repair') {
    if (
      task.review?.stage !== 'code_review' ||
      task.review.verdict !== 'changes_requested' ||
      task.review.inputSequence !== task.inputSequence ||
      task.pendingWork
    )
      throw new Error('This review has no current response or repair action.')
    stage = action
  } else if (action === 'retry' || action === 'continue') {
    stage = collaborationNextStage(task)
    if (!stage) throw new Error('This task has no next automatic step.')
    if (stage === 'implement' || stage === 'repair') {
      if (!task.pendingWork) throw new Error('This writing action requires explicit authorization.')
    }
  }
  if (!stage || stage === 'reply') throw new Error('This collaboration action is unavailable.')
  if (stage === 'plan_review') {
    if (next.discussionRounds >= limits.maxDiscussionRounds)
      throw new Error('The Session discussion limit has been reached.')
    next.discussionRounds++
  }
  if (stage === 'code_review') {
    if (next.reviewCycles >= limits.maxReviewCycles)
      throw new Error('The Session review limit has been reached.')
    next.reviewCycles++
  }
  if (stage === 'repair' && (!task.pendingWork || task.pendingWork.repairReservationReleased)) {
    if (next.repairAttempts >= limits.maxRepairAttempts)
      throw new Error('The Session repair limit has been reached.')
    next.repairAttempts++
  }
  next.stage = stage
  next.actor = collaborationActor(next, stage)
  next.status = 'running'
  next.nextStage = undefined
  next.authorization = undefined
  next.notice = undefined
  next.revision++
  return collaborationTaskSchema.parse(next)
}

export const collaborationViewSchema = z
  .strictObject({
    task: collaborationTaskSchema.nullable(),
    reportAvailable: z.boolean().default(false),
    accepted: z.boolean().default(false),
    actionable: z.boolean().default(false),
    availableActions: z.array(collaborationActionSchema).max(7).default([]),
    nextStep: z.string().max(160).optional(),
    planSync: z
      .strictObject({
        state: z.literal('recovery_required'),
        kind: z.enum(['plan', 'response']),
        runId: z.string().uuid(),
        retainedVersion: z.number().int().nonnegative(),
      })
      .optional(),
    planSource: z
      .strictObject({ runId: z.string().uuid(), messageId: z.string().uuid() })
      .optional(),
    documents: z
      .array(
        z.strictObject({ key: z.string().min(1).max(100), source: collaborationDocumentSchema }),
      )
      .max(24)
      .optional(),
    received: z
      .strictObject({
        id: z.string().uuid(),
        actor: agent,
        state: z.enum(['accepted', 'blocked', 'cancelled']),
        preview: z.string().max(512),
      })
      .optional(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_BYTES,
    'Collaboration view exceeds 48 KiB.',
  )
