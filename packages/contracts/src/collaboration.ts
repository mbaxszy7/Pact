import { z } from 'zod'

import {
  COLLABORATION_PAGE_BYTES,
  collaborationDocumentSchema,
  type CollaborationDocument,
  collaborationInputBatchReferenceSchema,
} from './collaboration-documents.js'
import { schedulingHandoffSchema } from './scheduling.js'

export * from './collaboration-documents.js'
export * from './scheduling.js'

const agent = z.enum(['claude', 'codex'])
type AgentId = z.infer<typeof agent>
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

export const taskStageRolesSchema = z
  .strictObject({
    version: z.literal('task-stage-roles-v1'),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    planAuthor: agent,
    planReviewer: agent,
    codeAuthor: agent,
    codeReviewer: agent,
  })
  .refine(
    (roles) => roles.planAuthor !== roles.planReviewer && roles.codeAuthor !== roles.codeReviewer,
    'Each author requires a distinct reviewer.',
  )
export type TaskStageRoles = z.infer<typeof taskStageRolesSchema>

export const initialTaskRoleCandidateIdSchema = z.enum([
  'roles_codex_codex',
  'roles_codex_claude',
  'roles_claude_codex',
  'roles_claude_claude',
])
export type InitialTaskRoleCandidateId = z.infer<typeof initialTaskRoleCandidateIdSchema>
export const initialTaskRoleCandidateSchema = z.strictObject({
  id: initialTaskRoleCandidateIdSchema,
  roles: taskStageRolesSchema.refine((roles) => roles.revision === 0, {
    message: 'Initial candidates always start at revision 0.',
  }),
})
export type InitialTaskRoleCandidate = z.infer<typeof initialTaskRoleCandidateSchema>

export function defaultTaskStageRoles(primary: AgentId): TaskStageRoles {
  const secondary = primary === 'codex' ? 'claude' : 'codex'
  return {
    version: 'task-stage-roles-v1',
    revision: 0,
    planAuthor: primary,
    planReviewer: secondary,
    codeAuthor: secondary,
    codeReviewer: primary,
  }
}
export function initialTaskRoleCandidates(
  kind: PactSkill,
  primary: AgentId,
): InitialTaskRoleCandidate[] {
  const defaults = defaultTaskStageRoles(primary)
  const planAuthors: AgentId[] = kind === 'plan' ? ['codex', 'claude'] : [defaults.planAuthor]
  const candidates: InitialTaskRoleCandidate[] = []
  for (const planAuthor of planAuthors) {
    for (const codeAuthor of ['codex', 'claude'] as const) {
      if (planAuthor === defaults.planAuthor && codeAuthor === defaults.codeAuthor) continue
      candidates.push({
        id: `roles_${planAuthor}_${codeAuthor}`,
        roles: {
          version: 'task-stage-roles-v1',
          revision: 0,
          planAuthor,
          planReviewer: planAuthor === 'codex' ? 'claude' : 'codex',
          codeAuthor,
          codeReviewer: codeAuthor === 'codex' ? 'claude' : 'codex',
        },
      })
    }
  }
  return candidates
}
export function collaborationInitialStage(kind: PactSkill): CollaborationStage {
  return kind === 'plan' ? 'plan' : kind === 'build' ? 'implement' : 'code_review'
}

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
  /** Only the host may attest a completed root and drained observation lifecycle. */
  confirmation: z.literal('native_root_settled_v1').optional(),
})
export type CollaborationRetainedPlan = z.infer<typeof collaborationRetainedPlanSchema>

/** The host binds the current frozen plan; a model cannot choose its identity or version. */
export const collaborationPlanRetentionInputSchema = z.strictObject({})

export const collaborationPlanReferenceSchema = z.strictObject({
  version: z.number().int().positive(),
  sourceRunId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  document: collaborationDocumentSchema,
})
export type CollaborationPlanReference = z.infer<typeof collaborationPlanReferenceSchema>

/** Repository-adopted coverage of additional input on an unchanged, accepted Plan. */
const collaborationPlanCoverageBasisSchema = z.strictObject({
  reviewRunId: z.string().uuid(),
  planReference: collaborationPlanReferenceSchema,
  fromInputSequence: z.number().int().nonnegative(),
  throughInputSequence: z.number().int().nonnegative(),
  producerRunId: z.string().uuid(),
  handoffId: z.string().regex(/^[a-f0-9]{64}$/u),
})
const workflowInputDigest = z.string().regex(/^[a-f0-9]{64}$/u)
export const collaborationPlanAcceptanceCoverageSchema = z.union([
  collaborationPlanCoverageBasisSchema.extend({
    origin: z.literal('relay').optional(),
    evaluationId: z.string().uuid(),
    sourceFingerprint: workflowInputDigest,
  }),
  collaborationPlanCoverageBasisSchema.extend({
    origin: z.literal('native'),
    evaluationId: z.never().optional(),
    sourceFingerprint: z.never().optional(),
    inputId: z.string().uuid(),
    inputDigest: workflowInputDigest,
  }),
])

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

export const collaborationAskRefSchema = z.strictObject({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
})
export type CollaborationAskRef = z.infer<typeof collaborationAskRefSchema>

/** The host freezes the current basis before accepting the next user input. */
export const collaborationReplyIntentBasisSchema = z.strictObject({
  kind: z.enum(['ask_only', 'explanation_only', 'repair_role_request']),
  inputId: z.string().uuid(),
  inputDigest: workflowInputDigest,
  priorInputSequence: z.number().int().nonnegative(),
  taskRevision: z.number().int().nonnegative(),
  review: collaborationReviewSchema,
  stageRoles: taskStageRolesSchema.optional(),
  planReference: collaborationPlanReferenceSchema.optional(),
  askBinding: z
    .strictObject({
      nativeSessionId: z.string().min(1).max(1024),
      generation: z.number().int().positive(),
    })
    .optional(),
  priorReviewControl: z
    .strictObject({
      producerRunId: z.string().uuid(),
      fingerprint: workflowInputDigest,
    })
    .optional(),
})
export type CollaborationReplyIntentBasis = z.infer<typeof collaborationReplyIntentBasisSchema>

/** Covers the control input only. The original review and its authorization remain historical. */
export const collaborationReviewControlCoverageSchema = z.strictObject({
  kind: z.literal('repair_role_request'),
  reviewRunId: z.string().uuid(),
  reviewInputSequence: z.number().int().nonnegative(),
  report: collaborationDocumentSchema,
  scope: collaborationDocumentSchema,
  producerRunId: z.string().uuid(),
  priorInputSequence: z.number().int().nonnegative(),
  inputSequence: z.number().int().nonnegative(),
  inputId: z.string().uuid(),
  inputDigest: workflowInputDigest,
})
export type CollaborationReviewControlCoverage = z.infer<
  typeof collaborationReviewControlCoverageSchema
>

export const collaborationInputOutcomeSchema = z.enum([
  'processed',
  'needs_user',
  'incomplete',
  'explanation_only',
  'repair_role_request',
])
export type CollaborationInputOutcome = z.infer<typeof collaborationInputOutcomeSchema>
export const collaborationInputObservationSchema = z.strictObject({
  outcome: collaborationInputOutcomeSchema,
  questions: collaborationQuestionsSchema.optional(),
})
export type CollaborationInputObservation = z.infer<typeof collaborationInputObservationSchema>
export const collaborationInputResultSchema = collaborationInputObservationSchema
  .extend({
    outcome: z.enum(['processed', 'needs_user', 'repair_role_request']),
  })
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
  stageRoles: taskStageRolesSchema.optional(),
  inputSequence: z.number().int().nonnegative(),
  planReference: collaborationPlanReferenceSchema.optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
  inputBatchRef: collaborationInputBatchReferenceSchema.optional(),
  inputProcessing: collaborationInputProcessingSchema.optional(),
  replyIntentBasis: collaborationReplyIntentBasisSchema.optional(),
  /** Fork history retains the source type without inheriting the reply grant. */
  historicalInputKind: z.literal('ask_only').optional(),
  sourceManifestRef: collaborationDocumentSchema.optional(),
  relayWorkRef: collaborationDocumentSchema.optional(),
  /** A host-verified user receipt; inherited workflow stage is never write authority. */
  userAuthority: z
    .strictObject({
      receiptId: z.string().uuid(),
      rootReceiptId: z.string().uuid(),
      purpose: z.enum([
        'action',
        'write_continuation',
        'supplement_plan',
        'supplement_code_response',
      ]),
      returnStage: z.enum(['plan_review', 'code_review']).optional(),
      returnActor: agent.optional(),
    })
    .optional(),
})
export type CollaborationTurnAuthorization = z.infer<typeof collaborationTurnAuthorizationSchema>

export const collaborationTaskSchema = z
  .strictObject({
    protocol: z.literal(COLLABORATION_PROTOCOL),
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    kind: pactSkillSchema,
    revision: z.number().int().nonnegative(),
    /** With split stages these are the frozen Primary and Secondary identities. */
    owner: agent,
    reviewer: agent,
    rolePolicy: z.literal('split-stages-v1').optional(),
    stageRoles: taskStageRolesSchema.optional(),
    task: z.string(),
    taskDocument: collaborationDocumentSchema.optional(),
    taskMessageId: z.string().uuid(),
    latestUserMessageId: z.string().uuid().optional(),
    stage: collaborationStageSchema,
    actor: agent,
    status: z.enum(['running', 'waiting', 'questions', 'ready', 'complete', 'failed']),
    /** Persistent pause intent; inputProcessing separately gates unanswered or pending input. */
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
    planAcceptanceCoverage: collaborationPlanAcceptanceCoverageSchema.optional(),
    reviewControlCoverage: collaborationReviewControlCoverageSchema.optional(),
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
  .refine((task) => !task.rolePolicy || task.owner !== task.reviewer, {
    message: 'Split collaboration stages require two distinct Agents.',
  })
  .refine((task) => !task.stageRoles || task.rolePolicy === 'split-stages-v1', {
    message: 'Explicit stage roles require frozen Primary and Secondary identities.',
  })
export type CollaborationTask = z.infer<typeof collaborationTaskSchema>

export function collaborationAskMode(
  task: CollaborationTask | undefined,
  authorization: CollaborationTurnAuthorization | undefined = task?.authorization,
): boolean {
  return authorization?.stage === 'reply' && authorization.replyIntentBasis?.kind === 'ask_only'
}

/** Only the assigned plan author may publish or retain a native plan for this root. */
export function collaborationPlanMode(
  task: CollaborationTask | undefined,
  authorization?: CollaborationTurnAuthorization,
): boolean {
  if (collaborationAskMode(task, authorization ?? task?.authorization)) return false
  const stage = authorization?.stage ?? task?.stage
  const actor = authorization?.actor ?? task?.actor
  return Boolean(
    task &&
    actor === collaborationActor(task, 'plan') &&
    (stage === 'plan' || (stage === 'reply' && task.kind === 'plan' && !task.codeRunId)),
  )
}

/** Shared by both providers; only the assigned plan author with an existing plan may retain it. */
export function collaborationPlanRetentionAllowed(
  task: CollaborationTask | undefined,
  authorization: CollaborationTurnAuthorization | undefined = task?.authorization,
): boolean {
  return Boolean(
    task &&
    authorization &&
    authorization.taskId === task.id &&
    authorization.taskRevision === task.revision &&
    authorization.runId === task.runId &&
    authorization.actor === task.actor &&
    authorization.stage === task.stage &&
    authorization.inputSequence === task.inputSequence &&
    collaborationPlanMode(task, authorization) &&
    authorization.planReference,
  )
}

export const collaborationActionSchema = z.enum([
  'continue',
  'execute',
  'respond',
  'repair',
  'request_repair_role_switch',
  'pause',
  'resume',
  'retry',
  'recover_plan',
  'request_plan_supplement',
  'request_code_supplement',
  'confirm_supplement',
  'cancel_supplement',
])
export type CollaborationAction = z.infer<typeof collaborationActionSchema>
export const collaborationActionInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    taskId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    action: collaborationActionSchema,
    clientMessageId: z.string().uuid(),
    repairActor: agent.optional(),
    decision: z
      .strictObject({ id: z.string().uuid(), revision: z.number().int().nonnegative() })
      .optional(),
  })
  .refine(
    (input) => (input.action === 'request_repair_role_switch') === Boolean(input.repairActor),
    'A repair role choice requires the selected Agent.',
  )
export type CollaborationActionInput = z.infer<typeof collaborationActionInputSchema>

/** Repository-proved arrangement and permission changes, originating in an explicit user request. */
export const relayDecisionSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  taskId: z.string().uuid(),
  afterRunId: z.string().uuid(),
  kind: z.enum(['supplement_plan', 'supplement_code_response']),
  state: z.enum(['requested', 'awaiting_answer', 'available']),
  actor: agent,
  returnActor: agent,
  planReference: collaborationPlanReferenceSchema.optional(),
  reviewRunId: z.string().uuid().optional(),
  reviewDocument: collaborationDocumentSchema.optional(),
  reviewScopeRef: collaborationDocumentSchema.optional(),
})
export type RelayDecision = z.infer<typeof relayDecisionSchema>

/** Bounded durable proof references, produced and rechecked only by the existing host owner. */
export const relayDecisionProofSchema = z.strictObject({
  card: relayDecisionSchema,
  request: z.strictObject({
    taskRevision: z.number().int().nonnegative(),
    inputSequence: z.number().int().nonnegative(),
    configurationGeneration: z.number().int().nonnegative(),
    wasRunning: z.boolean(),
  }),
  handoff: schedulingHandoffSchema.optional(),
  sourceFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
})

export const collaborationActionBasisSchema = z.strictObject({
  handoff: schedulingHandoffSchema,
  rolePolicy: z.literal('split-stages-v1').optional(),
  stageRoles: taskStageRolesSchema.optional(),
  taskId: z.string().uuid(),
  inputSequence: z.number().int().nonnegative(),
  stage: collaborationStageSchema,
  actor: agent,
  planReference: collaborationPlanReferenceSchema.nullable(),
  review: collaborationReviewSchema.nullable(),
  reviewScopeRef: collaborationDocumentSchema.nullable(),
  previousRunId: z.string().uuid().nullable(),
  actorBinding: z.strictObject({
    generation: z.number().int().positive(),
    nativeSessionId: z.string().max(1024).nullable(),
    continuationState: z.string().max(128).nullable(),
    permissions: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
})
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
  if (
    collaborationInputGate(task) ||
    !plan ||
    task.planInputSequence !== task.inputSequence ||
    review?.stage !== 'plan_review' ||
    review.actor !== collaborationActor(task, 'plan_review') ||
    review.verdict !== 'accepted' ||
    review.planReference?.version !== plan.version ||
    review.planReference.document.sha256 !== plan.document.sha256
  )
    return false
  if (review.inputSequence === task.inputSequence) return true

  const coverage = task.planAcceptanceCoverage
  const settled = collaborationInputProcessing(task).settled
  const sameReference = (ref: CollaborationPlanReference) =>
    ref.version === plan.version &&
    ref.sourceRunId === plan.sourceRunId &&
    ref.sourceMessageId === plan.sourceMessageId &&
    ref.document.id === plan.document.id &&
    ref.document.sha256 === plan.document.sha256 &&
    ref.document.bytes === plan.document.bytes &&
    ref.document.chars === plan.document.chars
  return Boolean(
    task.kind === 'plan' &&
    coverage &&
    coverage.reviewRunId === review.runId &&
    coverage.fromInputSequence === review.inputSequence &&
    coverage.fromInputSequence < coverage.throughInputSequence &&
    coverage.throughInputSequence === task.inputSequence &&
    settled?.inputSequence === coverage.throughInputSequence &&
    settled.runId === coverage.producerRunId &&
    sameReference(coverage.planReference) &&
    sameReference(review.planReference),
  )
}

const sameCollaborationDocument = (
  left: CollaborationDocument | undefined,
  right: CollaborationDocument,
) =>
  left?.id === right.id &&
  left.sha256 === right.sha256 &&
  left.bytes === right.bytes &&
  left.chars === right.chars

export function collaborationAskAvailable(task: CollaborationTask): boolean {
  return (
    task.status === 'ready' &&
    task.automation === 'active' &&
    !task.pendingWork &&
    collaborationRequiresPlan(task) &&
    collaborationPlanAccepted(task)
  )
}

/** One action basis for both the review's own input and a settled role-control input. */
export function collaborationCodeReviewCurrent(task: CollaborationTask): boolean {
  const { review, reviewScopeRef, reviewControlCoverage: coverage } = task
  if (
    collaborationInputGate(task) ||
    review?.stage !== 'code_review' ||
    review.verdict !== 'changes_requested'
  )
    return false
  if (review.inputSequence === task.inputSequence) return true
  return Boolean(
    coverage &&
    coverage.reviewRunId === review.runId &&
    coverage.reviewInputSequence === review.inputSequence &&
    coverage.inputSequence === task.inputSequence &&
    coverage.reviewInputSequence <= coverage.priorInputSequence &&
    coverage.priorInputSequence + 1 === coverage.inputSequence &&
    sameCollaborationDocument(review.document, coverage.report) &&
    sameCollaborationDocument(review.scopeRef, coverage.scope) &&
    sameCollaborationDocument(reviewScopeRef, coverage.scope),
  )
}

/** Only the frozen reply can make either structured intent available to the native tool. */
export function collaborationInputOutcomeAllowed(
  task: CollaborationTask,
  auth: CollaborationTurnAuthorization | undefined,
  outcome: CollaborationInputOutcome,
): boolean {
  if (collaborationAskMode(task, auth) || outcome === 'explanation_only') return false
  const planning = collaborationPlanMode(task, auth)
  if (outcome === 'repair_role_request')
    return (
      auth?.stage === 'reply' &&
      auth.inputProcessing?.pending?.inputId === auth.replyIntentBasis?.inputId &&
      auth.inputProcessing?.pending?.inputSequence === auth.inputSequence &&
      auth.replyIntentBasis?.kind === outcome &&
      !planning
    )
  return outcome !== 'processed' || !planning
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
    !(collaborationAskMode(task) && !input.pending) &&
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
  if (
    task.review &&
    task.review.inputSequence < task.inputSequence &&
    !collaborationCodeReviewCurrent(task)
  )
    return 'code_review'
  return task.nextStage
}

/** The one role resolver for both frozen legacy tasks and split-stage tasks. */
export function collaborationActor(
  task: Pick<
    CollaborationTask,
    'owner' | 'reviewer' | 'rolePolicy' | 'stageRoles' | 'kind' | 'codeRunId'
  >,
  stage: CollaborationStage,
) {
  const roles = task.stageRoles
  if (roles) {
    if (stage === 'plan') return roles.planAuthor
    if (stage === 'plan_review') return roles.planReviewer
    if (stage === 'code_review') return roles.codeReviewer
    if (stage === 'reply')
      return task.kind === 'review'
        ? roles.codeReviewer
        : task.kind === 'plan' && !task.codeRunId
          ? roles.planAuthor
          : roles.codeAuthor
    return roles.codeAuthor
  }
  if (task.rolePolicy === 'split-stages-v1') {
    if (stage === 'plan' || stage === 'code_review') return task.owner
    if (stage === 'reply')
      return task.kind === 'review' || (task.kind === 'plan' && !task.codeRunId)
        ? task.owner
        : task.reviewer
    return task.reviewer
  }
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
  if (collaborationCodeReviewCurrent(task) && !task.nextStage && !task.pendingWork)
    return ['respond', 'repair', 'pause']
  return collaborationNextStage(task) ? ['continue', 'pause'] : ['pause']
}

export interface CollaborationStageLimit {
  stage: 'plan_review' | 'code_review' | 'repair'
  used: number
  maximum: number
}

/** The projection and actual reservation use the same stage allowance. */
function collaborationStageLimit(
  task: CollaborationTask,
  stage: CollaborationStage | undefined,
  limits: CollaborationLimits,
): CollaborationStageLimit | undefined {
  if (stage === 'plan_review' && task.discussionRounds >= limits.maxDiscussionRounds)
    return { stage, used: task.discussionRounds, maximum: limits.maxDiscussionRounds }
  if (stage === 'code_review' && task.reviewCycles >= limits.maxReviewCycles)
    return { stage, used: task.reviewCycles, maximum: limits.maxReviewCycles }
  if (
    stage === 'repair' &&
    (!task.pendingWork || task.pendingWork.repairReservationReleased) &&
    task.repairAttempts >= limits.maxRepairAttempts
  )
    return { stage, used: task.repairAttempts, maximum: limits.maxRepairAttempts }
  return undefined
}

export function collaborationContinuationLimit(
  task: CollaborationTask,
  limits: CollaborationLimits,
): CollaborationStageLimit | undefined {
  if (task.status === 'running' || task.status === 'complete' || collaborationInputGate(task))
    return undefined
  return collaborationStageLimit(task, collaborationNextStage(task), limits)
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
  if (
    [
      'request_plan_supplement',
      'request_code_supplement',
      'confirm_supplement',
      'cancel_supplement',
    ].includes(action)
  )
    throw new Error('A supplement requires its current user decision receipt.')
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
    if (!collaborationCodeReviewCurrent(task) || task.pendingWork)
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
  const limit = collaborationStageLimit(next, stage, limits)
  if (limit)
    throw new Error(
      {
        plan_review: 'The Session discussion limit has been reached.',
        code_review: 'The Session review limit has been reached.',
        repair: 'The Session repair limit has been reached.',
      }[limit.stage],
    )
  if (stage === 'plan_review') {
    next.discussionRounds++
  }
  if (stage === 'code_review') {
    next.reviewCycles++
  }
  if (stage === 'repair' && (!task.pendingWork || task.pendingWork.repairReservationReleased)) {
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
    repairChoiceUnavailable: z.string().min(1).max(160).optional(),
    relayDecision: relayDecisionSchema.optional(),
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
