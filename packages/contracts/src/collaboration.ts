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
export function pactEntryPrimary(kind: PactSkill, primary: AgentId, entryActor?: AgentId): AgentId {
  if (!entryActor) return primary
  return kind === 'build' ? (entryActor === 'codex' ? 'claude' : 'codex') : entryActor
}
type PactEntryRoute = { type: 'agent'; agentId: AgentId } | { type: 'primary' } | { type: 'all' }
export function pactCommandRouteAllowed(
  route: PactEntryRoute | undefined,
  prefixRoute: PactEntryRoute | undefined,
): boolean {
  if (route?.type === 'all' || prefixRoute?.type === 'all') return false
  return (
    !prefixRoute ||
    !route ||
    (route.type === 'agent' &&
      prefixRoute.type === 'agent' &&
      route.agentId === prefixRoute.agentId)
  )
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
  /** This result discharges an older Plan review obligation only. */
  supplementPlanReturn: z.literal(true).optional(),
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

/**
 * One bounded semantic input basis: the last material user input, plus the
 * settled receipt that proved it. A chain of pure replies keeps one flat level.
 */
const collaborationInputBasisSchema = z.strictObject({
  inputSequence: z.number().int().nonnegative(),
  settled: z
    .strictObject({
      runId: z.string().uuid(),
      inputSequence: z.number().int().nonnegative(),
    })
    .optional(),
})
export type CollaborationInputBasis = z.infer<typeof collaborationInputBasisSchema>

/** The host freezes the current basis before accepting the next user input. */
export const collaborationReplyIntentBasisSchema = z
  .strictObject({
    kind: z.enum(['ask_only', 'explanation_only', 'repair_role_request']),
    inputId: z.string().uuid(),
    inputDigest: workflowInputDigest,
    priorInputSequence: z.number().int().nonnegative(),
    taskRevision: z.number().int().nonnegative(),
    review: collaborationReviewSchema.optional(),
    stageRoles: taskStageRolesSchema.optional(),
    planReference: collaborationPlanReferenceSchema.optional(),
    /** Settled task state frozen before the Ask's pending input; restored when it finishes. */
    askCheckpoint: z
      .strictObject({
        stage: collaborationStageSchema,
        actor: agent,
        status: z.enum(['waiting', 'questions', 'ready', 'failed']),
        automation: z.enum(['active', 'paused']),
        pauseReason: z
          .enum(['user_message', 'user', 'needs_user', 'restart', 'limit', 'failure', 'stopped'])
          .optional(),
        nextStage: collaborationWorkStageSchema.optional(),
        notice: z.string().max(512).optional(),
        planInputSequence: z.number().int().nonnegative().optional(),
        inputBasis: collaborationInputBasisSchema.optional(),
      })
      .optional(),
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
  .refine((value) => value.kind !== 'repair_role_request' || Boolean(value.review), {
    message: 'Non-question reply intents keep their immutable review basis.',
    path: ['review'],
  })
  .refine((value) => value.kind !== 'explanation_only' || Boolean(value.askCheckpoint), {
    message: 'An explanation basis requires its frozen checkpoint.',
    path: ['askCheckpoint'],
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
  'plan_revision_required',
])
export type CollaborationInputOutcome = z.infer<typeof collaborationInputOutcomeSchema>
export const collaborationInputObservationSchema = z.strictObject({
  outcome: collaborationInputOutcomeSchema,
  questions: collaborationQuestionsSchema.optional(),
})
export type CollaborationInputObservation = z.infer<typeof collaborationInputObservationSchema>
export const collaborationInputResultSchema = collaborationInputObservationSchema
  .extend({
    outcome: z.enum([
      'processed',
      'needs_user',
      'repair_role_request',
      'plan_revision_required',
      'explanation_only',
    ]),
  })
  .refine(
    (value) =>
      value.outcome === 'plan_revision_required' ||
      (value.outcome === 'needs_user') === Boolean(value.questions),
    'Questions are required for needs_user and optional for plan_revision_required.',
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
    .strictObject({
      runId: z.string().uuid(),
      inputSequence: z.number().int().nonnegative(),
      unchanged: collaborationInputBasisSchema.optional(),
    })
    .optional(),
})
export type CollaborationInputProcessing = z.infer<typeof collaborationInputProcessingSchema>

const collaborationPlanRevisionSchema = z.strictObject({
  origin: z.enum(['user', 'agent']).optional(),
  requestRunId: z.string().uuid(),
  inputSequence: z.number().int().nonnegative(),
  writeRunId: z.string().uuid(),
  planReference: collaborationPlanReferenceSchema,
  priorPlanInputSequence: z.number().int().nonnegative().optional(),
  priorReviewRunId: z.string().uuid().optional(),
  startedRunId: z.string().uuid().optional(),
  returnReview: z
    .strictObject({
      receiptId: z.string().uuid(),
      stage: z.enum(['plan_review', 'code_review']),
    })
    .optional(),
})

/** Frozen at Run admission. Native tools never get to choose these identities. */
export const collaborationTurnAuthorizationSchema = z.strictObject({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskRevision: z.number().int().nonnegative(),
  actor: agent,
  stage: collaborationStageSchema,
  stageRoles: taskStageRolesSchema.optional(),
  /** Host-frozen reply execution mode. Missing on historical Runs retains their original policy. */
  replyMode: z.enum(['plan', 'read_only']).optional(),
  /** Host-verified original write source for an ordinary reply's revision intent. */
  planRevisionWriteRunId: z.string().uuid().optional(),
  /** Read access to evidence retained from an earlier authorized write. */
  planRevisionContextRef: collaborationDocumentSchema.optional(),
  /** Verified continuation of a pending supplementary Plan's user decision. */
  supplementPlanAnswerReceiptId: z.string().uuid().optional(),
  supplementPlanReturn: z
    .strictObject({
      receiptId: z.string().uuid(),
      sourceRunId: z.string().uuid(),
      inputSequence: z.number().int().nonnegative(),
    })
    .optional(),
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

/** Explicit user confirmation that a new Pact command replaces the unfinished current task. */
export const collaborationReplacementSchema = z.strictObject({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
})
export type CollaborationReplacement = z.infer<typeof collaborationReplacementSchema>

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
    /** A material scope change fences off prior write authority until a new Implement admission. */
    planRevision: collaborationPlanRevisionSchema.optional(),
    nextStage: collaborationWorkStageSchema.optional(),
    discussionRounds: z.number().int().nonnegative(),
    reviewCycles: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    notice: z.string().max(512).optional(),
    /** Terminal lifecycle record; distinct from a successful Complete outcome. */
    ending: z
      .strictObject({
        clientMessageId: z.string().uuid(),
        taskRevision: z.number().int().nonnegative(),
        endedAt: z.string().datetime(),
        reason: z.enum(['ended', 'replaced']),
        replacementMessageId: z.string().uuid().optional(),
        unreviewedChanges: z.boolean(),
      })
      .optional(),
  })
  .refine((task) => !task.rolePolicy || task.owner !== task.reviewer, {
    message: 'Split collaboration stages require two distinct Agents.',
  })
  .refine((task) => !task.stageRoles || task.rolePolicy === 'split-stages-v1', {
    message: 'Explicit stage roles require frozen Primary and Secondary identities.',
  })
export type CollaborationTask = z.infer<typeof collaborationTaskSchema>

/**
 * The semantic basis of the workflow's material user input. Pure explanation
 * replies advance the durable input cursor without replacing this basis;
 * receipts, pending input and authorization always use the real cursor.
 */
export function collaborationWorkflowInputBasis(task: CollaborationTask): CollaborationInputBasis {
  const state = task.inputProcessing
  const settled = state?.settled
  if (
    !state?.pending &&
    !state?.decision &&
    settled?.inputSequence === task.inputSequence &&
    settled.unchanged &&
    settled.unchanged.inputSequence <= task.inputSequence
  )
    return settled.unchanged
  return {
    inputSequence: task.inputSequence,
    ...(settled ? { settled: { runId: settled.runId, inputSequence: settled.inputSequence } } : {}),
  }
}

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
  const planningReply = authorization
    ? authorization.replyMode === 'plan' ||
      (authorization.replyMode === undefined && task?.kind === 'plan' && !task.codeRunId)
    : task?.kind === 'plan' && !task.codeRunId && !task.pendingWork && !task.planRevision
  return Boolean(
    task &&
    actor === collaborationActor(task, 'plan') &&
    (stage === 'plan' || (stage === 'reply' && planningReply)),
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
  'resume',
  'retry',
  'recover_plan',
  'request_plan_supplement',
  'request_code_supplement',
  'confirm_supplement',
  'cancel_supplement',
  'revise_plan',
  'keep_current_plan',
  'swap_code_roles',
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
  planRevision: collaborationPlanRevisionSchema.optional(),
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
  if (task.planRevision) return true
  if (task.kind !== 'plan' || task.codeRunId) return false
  const pending = task.pendingWork
  if (pending?.stage !== 'implement') return true
  const unchangedPlan =
    Boolean(pending.planReference && task.planReference) &&
    pending.planReference?.version === task.planReference?.version &&
    pending.planReference?.document.sha256 === task.planReference?.document.sha256 &&
    pending.planReference?.document.bytes === task.planReference?.document.bytes &&
    pending.planReference?.document.chars === task.planReference?.document.chars
  if (!unchangedPlan) return true
  if (pending.inputSequence === task.inputSequence || collaborationPlanAccepted(task)) return false
  // A later processed reply advances the input cursor, not the original write grant.
  // Later replies cannot erase an outstanding review of a genuinely retained/revised Plan.
  return (
    (task.planInputSequence !== undefined &&
      task.planInputSequence > pending.inputSequence &&
      acceptedPlanReview(task)?.review.inputSequence !== task.planInputSequence) ||
    Boolean(collaborationInputGate(task)) ||
    task.handledInputSequence !== task.inputSequence ||
    collaborationInputProcessing(task).settled?.inputSequence !== task.inputSequence
  )
}

function acceptedPlanReview(task: CollaborationTask) {
  const plan = task.planReference
  const review = task.review
  const reference = review?.planReference
  if (
    !plan ||
    review?.stage !== 'plan_review' ||
    review.supplementPlanReturn ||
    review.actor !== collaborationActor(task, 'plan_review') ||
    review.verdict !== 'accepted' ||
    reference?.version !== plan.version ||
    reference.document.sha256 !== plan.document.sha256
  )
    return undefined
  return { plan, review, reference }
}

export function collaborationPlanAccepted(task: CollaborationTask): boolean {
  const accepted = acceptedPlanReview(task)
  const basis = collaborationWorkflowInputBasis(task)
  if (!accepted || collaborationInputGate(task) || task.planInputSequence !== basis.inputSequence)
    return false
  const { plan, review, reference } = accepted
  if (
    task.planRevision &&
    (task.planRevision.returnReview ||
      review.inputSequence < task.planRevision.inputSequence ||
      review.runId === task.planRevision.priorReviewRunId)
  )
    return false
  if (review.inputSequence === basis.inputSequence) return true

  const coverage = task.planAcceptanceCoverage
  const settled = basis.settled
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
    coverage.throughInputSequence === basis.inputSequence &&
    settled?.inputSequence === coverage.throughInputSequence &&
    settled.runId === coverage.producerRunId &&
    sameReference(coverage.planReference) &&
    sameReference(reference),
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
    !task.ending &&
    task.status !== 'running' &&
    task.status !== 'complete' &&
    !collaborationInputGate(task) &&
    (task.automation === 'paused' || collaborationNextStage(task) === undefined)
  )
}

/** The reviewer answers for a review checkpoint; other checkpoints use the reply actor. */
export function collaborationAskActor(task: CollaborationTask) {
  return task.stage === 'code_review'
    ? collaborationActor(task, 'code_review')
    : collaborationActor(task, 'reply')
}

/** Exact identity/digest equality for a frozen Plan reference. */
function samePlanReference(
  left: CollaborationPlanReference | undefined,
  right: CollaborationPlanReference,
): boolean {
  return (
    left?.version === right.version &&
    left.sourceRunId === right.sourceRunId &&
    left.sourceMessageId === right.sourceMessageId &&
    left.document.id === right.document.id &&
    left.document.sha256 === right.document.sha256 &&
    left.document.bytes === right.document.bytes &&
    left.document.chars === right.document.chars
  )
}

/** A finished /plan with a verified write and no pending revision can be revised explicitly. */
export function collaborationCanRevisePlan(task: CollaborationTask): boolean {
  return (
    task.kind === 'plan' &&
    !task.ending &&
    task.status !== 'complete' &&
    task.status !== 'running' &&
    !task.planRevision &&
    !!task.planReference &&
    !!(task.pendingWork?.runId ?? task.codeRunId) &&
    !collaborationInputGate(task)
  )
}

/**
 * Dismissal applies only to the exact still-current revision request: same input cursor,
 * untouched Plan, no admitted planner Run, and at most its own necessary-decision gate.
 */
export function collaborationCanKeepPlan(task: CollaborationTask): boolean {
  const revision = task.planRevision
  if (
    !revision ||
    task.ending ||
    task.status === 'complete' ||
    task.status === 'running' ||
    revision.startedRunId ||
    revision.returnReview ||
    !samePlanReference(task.planReference, revision.planReference)
  )
    return false
  const input = collaborationInputProcessing(task)
  if (
    input.pending ||
    collaborationWorkflowInputBasis(task).inputSequence !== revision.inputSequence
  )
    return false
  if (!revision.origin && task.runId !== revision.requestRunId) return false
  const gate = collaborationInputGate(task)
  return (
    !gate ||
    (gate === 'needs_reply' &&
      input.decision?.runId === revision.requestRunId &&
      input.decision.inputSequence === revision.inputSequence)
  )
}

export function collaborationCanSwapCodeRoles(task: CollaborationTask): boolean {
  return (
    task.kind === 'plan' &&
    task.rolePolicy === 'split-stages-v1' &&
    !task.ending &&
    task.status === 'ready' &&
    !task.planRevision &&
    !task.codeRunId &&
    !task.pendingWork &&
    task.reviewCycles === 0 &&
    task.repairAttempts === 0 &&
    !collaborationInputGate(task) &&
    collaborationPlanAccepted(task) &&
    (task.stageRoles?.revision ?? 0) < Number.MAX_SAFE_INTEGER
  )
}

/** One action basis for both the review's own input and a settled role-control input. */
export function collaborationCodeReviewCurrent(task: CollaborationTask): boolean {
  const { review, reviewScopeRef, reviewControlCoverage: coverage } = task
  if (
    task.planRevision ||
    collaborationInputGate(task) ||
    review?.stage !== 'code_review' ||
    review.verdict !== 'changes_requested'
  )
    return false
  const basis = collaborationWorkflowInputBasis(task)
  if (review.inputSequence === basis.inputSequence) return true
  return Boolean(
    coverage &&
    coverage.reviewRunId === review.runId &&
    coverage.reviewInputSequence === review.inputSequence &&
    coverage.inputSequence === basis.inputSequence &&
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
  if (collaborationAskMode(task, auth)) return false
  if (outcome === 'explanation_only')
    return Boolean(
      auth?.stage === 'reply' &&
      !auth.userAuthority &&
      !auth.supplementPlanAnswerReceiptId &&
      !auth.supplementPlanReturn &&
      auth.replyIntentBasis?.kind !== 'ask_only' &&
      auth.replyIntentBasis?.askCheckpoint?.inputBasis &&
      auth.inputProcessing?.pending?.inputId === auth.replyIntentBasis.inputId &&
      auth.inputProcessing?.pending?.inputSequence === auth.inputSequence,
    )
  const planning = collaborationPlanMode(task, auth)
  if (outcome === 'plan_revision_required')
    return Boolean(
      task.kind === 'plan' &&
      auth?.stage === 'reply' &&
      auth.replyMode === 'read_only' &&
      auth.planRevisionWriteRunId &&
      auth.inputProcessing?.pending?.inputSequence === auth.inputSequence &&
      !planning,
    )
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
function collaborationResolvedNextStage(task: CollaborationTask): CollaborationStage | undefined {
  if (task.planRevision?.returnReview) return task.planRevision.returnReview.stage
  const basis = collaborationWorkflowInputBasis(task)
  if (collaborationRequiresPlan(task)) {
    if (!task.planReference || task.planInputSequence !== basis.inputSequence) return 'plan'
    if (collaborationPlanAccepted(task)) return undefined
    if (
      task.review?.stage === 'plan_review' &&
      task.review.inputSequence === basis.inputSequence &&
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
    task.review.inputSequence < basis.inputSequence &&
    !collaborationCodeReviewCurrent(task)
  )
    return 'code_review'
  return task.nextStage
}

export function collaborationNextStage(task: CollaborationTask): CollaborationStage | undefined {
  return deriveCollaborationDecision(task).nextStage
}

/** The one role resolver for both frozen legacy tasks and split-stage tasks. */
export function collaborationActor(
  task: Pick<
    CollaborationTask,
    | 'owner'
    | 'reviewer'
    | 'rolePolicy'
    | 'stageRoles'
    | 'kind'
    | 'codeRunId'
    | 'pendingWork'
    | 'planRevision'
  >,
  stage: CollaborationStage,
) {
  const roles = task.stageRoles
  if (stage === 'reply' && task.planRevision) return collaborationActor(task, 'plan')
  if (roles) {
    if (stage === 'plan') return roles.planAuthor
    if (stage === 'plan_review') return roles.planReviewer
    if (stage === 'code_review') return roles.codeReviewer
    if (stage === 'reply')
      return task.kind === 'review'
        ? roles.codeReviewer
        : task.kind === 'plan' && !task.codeRunId && !task.pendingWork
          ? roles.planAuthor
          : roles.codeAuthor
    return roles.codeAuthor
  }
  if (task.rolePolicy === 'split-stages-v1') {
    if (stage === 'plan' || stage === 'code_review') return task.owner
    if (stage === 'reply')
      return task.kind === 'review' ||
        (task.kind === 'plan' && !task.codeRunId && !task.pendingWork)
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

export function collaborationStageLabel(stage: CollaborationStage, kind?: PactSkill): string {
  return {
    plan: 'Update the plan',
    plan_review: 'Review the current plan',
    implement: kind === 'build' ? 'Implement the task' : 'Implement the accepted plan',
    code_review: 'Review the current changes',
    respond: 'Respond to the review',
    repair: 'Repair the reviewed changes',
    reply: 'Reply to your message',
  }[stage]
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

export interface CollaborationDecision {
  inputGate: ReturnType<typeof collaborationInputGate>
  nextStage: CollaborationStage | undefined
  nextActor: 'codex' | 'claude' | undefined
  availableActions: CollaborationAction[]
  continuationLimit: CollaborationStageLimit | undefined
}

/** Resolve the bounded task's next step and legal controls from one fact set. */
export function deriveCollaborationDecision(
  task: CollaborationTask,
  limits?: CollaborationLimits,
): CollaborationDecision {
  const inputGate = collaborationInputGate(task)
  const gated = Boolean(task.ending || task.status === 'complete' || inputGate)
  const nextStage = gated ? undefined : collaborationResolvedNextStage(task)
  const availableActions: CollaborationAction[] = []
  if (!task.ending && task.status !== 'complete') {
    if (!inputGate) {
      if (task.status === 'running') {
        if (task.automation === 'paused') availableActions.push('resume')
      } else if (task.automation === 'paused') {
        availableActions.push('resume')
      } else if (collaborationRequiresPlan(task) && collaborationPlanAccepted(task)) {
        availableActions.push('execute')
      } else if (task.status === 'failed') {
        availableActions.push('retry')
      } else if (collaborationCodeReviewCurrent(task) && !task.nextStage && !task.pendingWork) {
        availableActions.push('respond', 'repair')
      } else if (nextStage) {
        availableActions.push('continue')
      }
    }
    // Keep dismisses its own exact decision gate even while it still waits for an answer.
    if (!inputGate || collaborationCanKeepPlan(task)) {
      if (collaborationCanRevisePlan(task)) availableActions.push('revise_plan')
      if (collaborationCanKeepPlan(task)) availableActions.push('keep_current_plan')
      if (collaborationCanSwapCodeRoles(task)) availableActions.push('swap_code_roles')
    }
  }
  return {
    inputGate,
    nextStage,
    nextActor: nextStage ? collaborationActor(task, nextStage) : undefined,
    availableActions,
    continuationLimit:
      limits && !gated && task.status !== 'running'
        ? collaborationStageLimit(task, nextStage, limits)
        : undefined,
  }
}

export function collaborationAvailableActions(task: CollaborationTask): CollaborationAction[] {
  return deriveCollaborationDecision(task).availableActions
}

export function collaborationContinuationLimit(
  task: CollaborationTask,
  limits: CollaborationLimits,
): CollaborationStageLimit | undefined {
  return deriveCollaborationDecision(task, limits).continuationLimit
}

export type CollaborationTransitionReason =
  | { kind: 'limit'; limit: CollaborationStageLimit }
  | {
      kind:
        | 'ended'
        | 'complete'
        | 'recorded_control_action'
        | 'plan_revision_unavailable'
        | 'recovery_only'
        | 'supplement_receipt_required'
        | 'input_pending'
        | 'not_paused'
        | 'running'
        | 'paused'
        | 'plan_not_accepted'
        | 'review_not_current'
        | 'no_next_step'
        | 'write_authorization_required'
        | 'unavailable_action'
    }

export class CollaborationTransitionError extends Error {
  constructor(
    readonly reason: CollaborationTransitionReason,
    message: string,
  ) {
    super(message)
    this.name = 'CollaborationTransitionError'
  }
}

/** Reserve counters before dispatch; proven-unsent reservations alone may be released. */
export function advanceCollaboration(
  task: CollaborationTask,
  action: CollaborationAction,
  limits: CollaborationLimits,
): CollaborationTask {
  if (task.ending)
    throw new CollaborationTransitionError(
      { kind: 'ended' },
      'This task has already ended. Start a new task instead.',
    )
  if (task.status === 'complete')
    throw new CollaborationTransitionError(
      { kind: 'complete' },
      'This collaboration is already complete.',
    )
  if (action === 'keep_current_plan' || action === 'swap_code_roles')
    throw new CollaborationTransitionError(
      { kind: 'recorded_control_action' },
      action === 'keep_current_plan'
        ? 'Keeping a Plan is a recorded control action, not a workflow turn.'
        : 'Swapping code roles is a recorded control action, not a workflow turn.',
    )
  if (action === 'revise_plan') {
    if (
      task.planRevision?.origin !== 'user' ||
      task.planRevision.startedRunId ||
      task.planInputSequence !== undefined
    )
      throw new CollaborationTransitionError(
        { kind: 'plan_revision_unavailable' },
        'The explicit Plan revision is no longer current.',
      )
    return advanceCollaboration(
      { ...task, automation: 'active', pauseReason: undefined },
      'continue',
      limits,
    )
  }
  if (action === 'recover_plan')
    throw new CollaborationTransitionError(
      { kind: 'recovery_only' },
      'Plan recovery checks the original source; it cannot advance collaboration.',
    )
  if (
    [
      'request_plan_supplement',
      'request_code_supplement',
      'confirm_supplement',
      'cancel_supplement',
    ].includes(action)
  )
    throw new CollaborationTransitionError(
      { kind: 'supplement_receipt_required' },
      'A supplement requires its current user decision receipt.',
    )
  const decision = deriveCollaborationDecision(task, limits)
  const next = structuredClone(task)
  if (decision.inputGate)
    throw new CollaborationTransitionError(
      { kind: 'input_pending' },
      'Reply to the questions and wait until your reply has been processed before continuing collaboration.',
    )
  if (action === 'resume') {
    if (task.automation !== 'paused')
      throw new CollaborationTransitionError(
        { kind: 'not_paused' },
        'This collaboration is not paused.',
      )
    next.automation = 'active'
    next.pauseReason = undefined
    next.notice = undefined
    next.revision++
    if (task.status !== 'running') {
      const stage = deriveCollaborationDecision(next).nextStage
      next.status =
        collaborationRequiresPlan(next) && collaborationPlanAccepted(next)
          ? 'ready'
          : !stage &&
              !next.planRevision &&
              next.review?.stage === 'code_review' &&
              next.review.verdict === 'accepted' &&
              next.review.inputSequence === collaborationWorkflowInputBasis(next).inputSequence
            ? 'complete'
            : 'waiting'
      if (stage && stage !== 'reply') next.nextStage = stage
    }
    return collaborationTaskSchema.parse(next)
  }
  if (task.status === 'running')
    throw new CollaborationTransitionError(
      { kind: 'running' },
      'The current Agent is still working.',
    )
  if (task.automation === 'paused')
    throw new CollaborationTransitionError(
      { kind: 'paused' },
      'Continue collaboration before starting its next action.',
    )
  let stage: CollaborationStage | undefined
  if (action === 'execute') {
    if (!collaborationRequiresPlan(task) || !collaborationPlanAccepted(task))
      throw new CollaborationTransitionError(
        { kind: 'plan_not_accepted' },
        'The current plan has not been accepted.',
      )
    stage = 'implement'
    next.pendingWork = undefined
  } else if (action === 'respond' || action === 'repair') {
    if (!collaborationCodeReviewCurrent(task) || task.pendingWork)
      throw new CollaborationTransitionError(
        { kind: 'review_not_current' },
        'This review has no current response or repair action.',
      )
    stage = action
  } else if (action === 'retry' || action === 'continue') {
    stage = decision.nextStage
    if (!stage)
      throw new CollaborationTransitionError(
        { kind: 'no_next_step' },
        'This task has no next automatic step.',
      )
    if (stage === 'implement' || stage === 'repair') {
      if (!task.pendingWork)
        throw new CollaborationTransitionError(
          { kind: 'write_authorization_required' },
          'This writing action requires explicit authorization.',
        )
    }
  }
  if (!stage || stage === 'reply')
    throw new CollaborationTransitionError(
      { kind: 'unavailable_action' },
      'This collaboration action is unavailable.',
    )
  const limit = collaborationStageLimit(next, stage, limits)
  if (limit)
    throw new CollaborationTransitionError(
      { kind: 'limit', limit },
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

type CollaborationSettlementDecision = NonNullable<
  NonNullable<CollaborationTask['inputProcessing']>['decision']
>
type CollaborationReviewAuthorization = CollaborationTurnAuthorization & {
  stage: 'plan_review' | 'code_review'
}
type CollaborationWorkAuthorization = CollaborationTurnAuthorization & {
  stage: 'implement' | 'repair' | 'respond'
}
export type CollaborationStageSettlement =
  | { kind: 'unavailable'; reason: 'effects' | 'source' | 'reply' | 'recovered_reply' }
  | {
      kind: 'interrupted'
      authorization: CollaborationTurnAuthorization
      stopped: boolean
      unstarted: boolean
      failed: boolean
      ended: boolean
      effectsSettled: boolean
      completeResponse: boolean
      reservation?: 'discussionRounds' | 'reviewCycles' | 'repairAttempts'
      supplementReviewState?: 'pending' | 'fulfilled' | 'not_required'
      notice?: string
    }
  | { kind: 'reply' }
  | { kind: 'recovered_reply' }
  | { kind: 'recovered_plan' }
  | {
      kind: 'plan'
      authorization: CollaborationTurnAuthorization
      settled: boolean
      supersededInput: boolean
      observed: boolean
      decision?: CollaborationSettlementDecision
    }
  | {
      kind: 'review'
      authorization: CollaborationReviewAuthorization
      verdict: CollaborationReviewVerdict
      verdictConflict: boolean
      supersededInput: boolean
      document?: CollaborationDocument
      decision?: CollaborationSettlementDecision
    }
  | { kind: 'work'; authorization: CollaborationWorkAuthorization }
  | { kind: 'input_processed'; runId: string; inputSequence: number }
  | { kind: 'input_control'; inputSequence: number }
  | { kind: 'input_needs_user'; decision: CollaborationSettlementDecision }
  | { kind: 'input_unconfirmed' }
  | { kind: 'input_plan_withdrawn' }

/** Apply only host-verified facts. Does not authorize work, persist, or increment revision. */
export function settleCollaborationStage(
  task: CollaborationTask,
  settlement: CollaborationStageSettlement,
): CollaborationTask {
  const next = structuredClone(task)
  switch (settlement.kind) {
    case 'unavailable': {
      next.status = 'failed'
      next.automation = 'paused'
      next.pauseReason = 'failure'
      next.notice =
        settlement.reason === 'effects'
          ? 'The native Turn ended, but its side effects are not settled. Check the original execution before continuing.'
          : settlement.reason === 'source'
            ? 'The native Turn ended, but its complete response source is unavailable.'
            : settlement.reason === 'reply'
              ? 'Your reply has not been confirmed as processed. Check its response before continuing.'
              : 'The plan was restored, but your reply has not been confirmed as processed.'
      break
    }
    case 'interrupted': {
      const auth = settlement.authorization
      next.status = 'failed'
      next.automation = 'paused'
      next.pauseReason = settlement.stopped ? 'stopped' : 'failure'
      next.notice = (
        settlement.notice ??
        'This Turn did not complete. Check its original delivery before continuing.'
      ).slice(0, 512)
      if (auth.stage === 'implement' || auth.stage === 'repair') {
        if (settlement.unstarted || (settlement.ended && (settlement.failed || settlement.stopped)))
          next.pendingWork = {
            stage: auth.stage,
            runId: auth.runId,
            inputSequence: auth.inputSequence,
            ...(auth.planReference ? { planReference: auth.planReference } : {}),
            ...(settlement.unstarted && settlement.reservation === 'repairAttempts'
              ? { repairReservationReleased: true }
              : {}),
          }
      } else if (auth.stage !== 'reply' && auth.stage !== 'respond') {
        next.nextStage = auth.stage
      }
      const supplement = auth.userAuthority?.purpose
      if (supplement === 'supplement_plan' || supplement === 'supplement_code_response') {
        if (settlement.supplementReviewState === 'not_required') {
          next.nextStage = supplement === 'supplement_plan' ? 'plan_review' : undefined
        } else if (
          supplement === 'supplement_code_response' &&
          settlement.effectsSettled &&
          settlement.ended &&
          settlement.completeResponse
        ) {
          next.nextStage = 'code_review'
        }
      }
      if (settlement.unstarted && settlement.reservation)
        next[settlement.reservation] = Math.max(0, next[settlement.reservation] - 1)
      break
    }
    case 'reply': {
      next.status = 'waiting'
      if (collaborationRequiresPlan(next))
        next.nextStage =
          next.planReference && next.planInputSequence === next.inputSequence
            ? 'plan_review'
            : 'plan'
      else if (!next.pendingWork) next.nextStage = 'code_review'
      break
    }
    case 'recovered_reply': {
      next.status = 'waiting'
      const stage = deriveCollaborationDecision(next).nextStage
      next.nextStage = stage === 'reply' ? undefined : stage
      break
    }
    case 'recovered_plan': {
      next.status = 'waiting'
      next.nextStage = 'plan_review'
      next.notice = undefined
      if (next.pauseReason === 'failure') next.pauseReason = 'user'
      break
    }
    case 'plan': {
      if (settlement.settled) {
        next.status = 'waiting'
        next.nextStage = 'plan_review'
      } else if (settlement.supersededInput) {
        next.status = 'waiting'
        next.nextStage = 'plan'
      } else if (settlement.decision) {
        next.status = 'questions'
        next.nextStage = 'plan'
        next.inputProcessing = {
          ...collaborationInputProcessing(next),
          decision: settlement.decision,
        }
        next.notice = 'Your answers are needed before this plan response can be reviewed.'
      } else {
        next.status = 'failed'
        next.nextStage = 'plan'
        next.automation = 'paused'
        next.pauseReason = 'failure'
        next.notice = settlement.observed
          ? 'The latest plan has not been synced to Pact. Restore its saved native source before continuing.'
          : 'The Agent ended without a confirmed plan. Ask the plan author to complete it before continuing.'
      }
      break
    }
    case 'review': {
      const auth = settlement.authorization
      next.planAcceptanceCoverage = undefined
      next.reviewControlCoverage = undefined
      if (settlement.document)
        next.review = {
          runId: auth.runId,
          actor: auth.actor,
          stage: auth.stage,
          verdict: settlement.verdict,
          ...(auth.supplementPlanReturn ? { supplementPlanReturn: true as const } : {}),
          inputSequence: auth.inputSequence,
          ...(auth.planReference ? { planReference: auth.planReference } : {}),
          ...(auth.reviewScopeRef ? { scopeRef: auth.reviewScopeRef } : {}),
          document: settlement.document,
        }
      const currentBasis =
        auth.inputSequence === next.inputSequence &&
        (auth.stage !== 'plan_review' ||
          (auth.planReference?.version === next.planReference?.version &&
            auth.planReference?.document.sha256 === next.planReference?.document.sha256))
      if (settlement.verdict === 'accepted' && currentBasis) {
        const resumingUnchangedPlan =
          auth.stage === 'plan_review' && next.pendingWork && !collaborationRequiresPlan(next)
        next.status =
          auth.stage === 'plan_review'
            ? resumingUnchangedPlan
              ? 'waiting'
              : 'ready'
            : next.planRevision
              ? 'waiting'
              : 'complete'
        next.nextStage = resumingUnchangedPlan ? next.pendingWork!.stage : undefined
      } else if (settlement.verdict === 'changes_requested' && currentBasis) {
        next.status = 'waiting'
        next.nextStage = auth.stage === 'plan_review' ? 'plan' : undefined
      } else if (settlement.verdict === 'incomplete') {
        next.status = 'failed'
        next.nextStage = auth.stage
        next.automation = 'paused'
        next.pauseReason = 'failure'
        next.notice = settlement.verdictConflict
          ? 'The review returned conflicting conclusions. Start a new review to continue.'
          : 'The review did not provide a complete conclusion. Start a new review to continue.'
      } else if (
        settlement.verdict === 'needs_user' &&
        !(auth.supplementPlanReturn && settlement.supersededInput)
      ) {
        if (!settlement.decision)
          throw new Error('A needs_user review requires a supplied decision.')
        next.status = 'questions'
        next.nextStage = auth.stage === 'plan_review' ? 'plan' : 'code_review'
        next.inputProcessing = {
          ...collaborationInputProcessing(next),
          decision: settlement.decision,
        }
        next.notice = 'The review needs your decision before collaboration can continue.'
      } else {
        next.status = 'waiting'
        next.nextStage = auth.stage === 'plan_review' ? 'plan' : 'code_review'
      }
      break
    }
    case 'work': {
      next.status = 'waiting'
      next.nextStage = 'code_review'
      if (
        settlement.authorization.stage === 'implement' ||
        settlement.authorization.stage === 'repair'
      ) {
        next.codeRunId = settlement.authorization.runId
        next.pendingWork = undefined
      }
      break
    }
    case 'input_processed': {
      next.inputProcessing = {
        settled: { runId: settlement.runId, inputSequence: settlement.inputSequence },
      }
      next.notice = next.planRevision
        ? 'The requirements need a revised Plan. Continue collaboration to update it.'
        : next.automation === 'paused'
          ? 'Your reply has been processed. Continue collaboration when you are ready.'
          : undefined
      break
    }
    case 'input_control': {
      next.inputProcessing = {}
      next.handledInputSequence = settlement.inputSequence
      next.status = 'waiting'
      next.nextStage = undefined
      break
    }
    case 'input_needs_user': {
      const inputProcessing = collaborationInputProcessing(next)
      next.status = 'questions'
      next.inputProcessing = {
        ...inputProcessing,
        pending: undefined,
        decision: settlement.decision,
      }
      next.notice = 'More input is needed. Read the response and reply in the message box.'
      break
    }
    case 'input_unconfirmed': {
      next.inputProcessing = collaborationInputProcessing(next)
      next.status = 'failed'
      next.automation = 'paused'
      next.pauseReason = 'failure'
      next.notice =
        'Your reply has not been confirmed as processed. Check the response or recovery notice before sending a follow-up.'
      break
    }
    case 'input_plan_withdrawn': {
      next.status = 'failed'
      next.automation = 'paused'
      next.pauseReason = 'failure'
      next.notice =
        'A later message was withdrawn. Send a follow-up to confirm the current plan before continuing.'
      break
    }
  }
  const settled = next.inputProcessing?.settled
  if (
    settled?.unchanged &&
    ((settlement.kind === 'plan' && settlement.settled) ||
      (settlement.kind === 'review' && next.review?.runId === settlement.authorization.runId) ||
      settlement.kind === 'work')
  ) {
    if (
      settlement.kind === 'review' &&
      settlement.authorization.stage === 'plan_review' &&
      next.planReference &&
      samePlanReference(settlement.authorization.planReference, next.planReference) &&
      next.planInputSequence === settled.unchanged?.inputSequence
    )
      next.planInputSequence = settlement.authorization.inputSequence
    next.inputProcessing = {
      ...next.inputProcessing,
      settled: { runId: settled.runId, inputSequence: settled.inputSequence },
    }
  }
  return next
}

export const collaborationViewSchema = z
  .strictObject({
    task: collaborationTaskSchema.nullable(),
    reportAvailable: z.boolean().default(false),
    accepted: z.boolean().default(false),
    actionable: z.boolean().default(false),
    availableActions: z.array(collaborationActionSchema).max(7).default([]),
    repairChoiceUnavailable: z.string().min(1).max(160).optional(),
    replacement: z
      .strictObject({
        summary: z.string().max(512),
        unreviewedChanges: z.boolean(),
      })
      .optional(),
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
export type CollaborationView = z.infer<typeof collaborationViewSchema>
