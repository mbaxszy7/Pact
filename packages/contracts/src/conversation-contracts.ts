import { z } from 'zod'

import { agyRebuildInitializationWitnessSchema } from './agy-storage.js'
import {
  anchoredCommentSchema,
  anchoredCommentSummarySchema,
  MAX_COMMENTS_PER_MESSAGE,
} from './anchored-comments.js'
import {
  collaborationViewSchema,
  collaborationDocumentSchema,
  collaborationMarkdownNodeSchema,
  collaborationMarkdownTreeWithinBudget,
  collaborationStageSchema,
  collaborationNotificationSchema,
  collaborationReviewVerdictSchema,
  collaborationRetainedPlanSchema,
  collaborationInputOutcomeSchema,
  collaborationReviewObservationSchema,
  collaborationInputObservationSchema,
  collaborationReplyIntentBasisSchema,
  collaborationAskRefSchema,
  collaborationReplacementSchema,
  pactSkillSchema,
} from './collaboration.js'
import { agentSpeedSchema, sessionPermissionModeSchema } from './execution-settings.js'
import { conversationImageSchema, conversationImagesSchema } from './images.js'
import { CONVERSATION_INTEREST_ITEMS } from './ipc-and-health.js'
import { nativePermissionRequestSchema, NATIVE_PERMISSION_REQUESTS } from './native-permissions.js'
import {
  preparedInputContinuationSchema,
  userInformationDeclarationSchema,
} from './prepared-input.js'
import { relaySchedulingDecisionSchema } from './relay-decisions.js'
import {
  runtimeAgentIdSchema,
  defaultSessionSettingsSchema,
  sessionSettingsSchema,
  agentModelCatalogSchema,
  activeAgentPairInputSchema,
  sessionStatusSchema,
  sessionActivitySchema,
  sessionTitleSourceSchema,
  collaborationSessionSchema,
  sessionCatalogChangeSchema,
  sessionGroupSchema,
  sessionPageScopeSchema,
  type RuntimeAgentId,
} from './runtime-and-sessions.js'
import { CONVERSATION_ACTIVE_SESSIONS_PER_VIEWER, originSideChatSchema } from './side-chats.js'
import { skillSelectionsSchema } from './skills.js'
import { workspaceChangeSetSchema, WORKSPACE_PREVIEW_BYTES } from './workspace-changes.js'

export const moveSessionGroupInputSchema = z
  .strictObject({
    projectId: z.string().uuid(),
    groupId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    direction: z.enum(['up', 'down']).optional(),
    targetGroupId: z.string().uuid().optional(),
    placement: z.enum(['before', 'after']).optional(),
  })
  .refine(
    (input) =>
      input.direction !== undefined ||
      (input.targetGroupId !== undefined && input.placement !== undefined),
    'A move needs a direction or a target group and placement.',
  )
export type MoveSessionGroupInput = z.infer<typeof moveSessionGroupInputSchema>

export const dissolveSessionGroupInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
})
export type DissolveSessionGroupInput = z.infer<typeof dissolveSessionGroupInputSchema>

export const sessionGroupPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('first') }),
  z.strictObject({ kind: z.enum(['before', 'after']), sessionId: z.string().uuid() }),
])
export type SessionGroupPlacement = z.infer<typeof sessionGroupPlacementSchema>

export const setSessionGroupInputSchema = z
  .strictObject({
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    groupId: z.string().uuid().nullable(),
    placement: sessionGroupPlacementSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine(
    (value) =>
      !value.placement ||
      (value.groupId !== null &&
        (value.placement.kind === 'first' || value.placement.sessionId !== value.sessionId)),
  )
export type SetSessionGroupInput = z.infer<typeof setSessionGroupInputSchema>

export const sessionGroupMutationSchema = z.strictObject({
  kind: z.literal('group-change'),
  revision: z.number().int().nonnegative(),
  group: sessionGroupSchema.optional(),
  dissolvedGroupId: z.string().uuid().optional(),
  session: collaborationSessionSchema.optional(),
  sourceScope: sessionPageScopeSchema.optional(),
  targetScope: sessionPageScopeSchema.optional(),
})
export type SessionGroupMutation = z.infer<typeof sessionGroupMutationSchema>

export const sessionCreationPrepareInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  activePair: activeAgentPairInputSchema.optional(),
})
export type SessionCreationPrepareInput = z.infer<typeof sessionCreationPrepareInputSchema>

export const sessionCreateInputSchema = z
  .strictObject({
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    groupId: z.string().uuid().optional(),
    expectedGroupRevision: z.number().int().nonnegative().optional(),
    settings: defaultSessionSettingsSchema,
  })
  .refine(
    (input) => Boolean(input.groupId) === (input.expectedGroupRevision !== undefined),
    'Group creation requires the current organization revision.',
  )
export type SessionCreateInput = z.infer<typeof sessionCreateInputSchema>

export const sessionSettingsInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  activePair: activeAgentPairInputSchema.optional(),
})
export type SessionSettingsInput = z.infer<typeof sessionSettingsInputSchema>

export const sessionArchiveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
})
export type SessionArchiveInput = z.infer<typeof sessionArchiveInputSchema>

export const sessionSidebarHiddenInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  hidden: z.boolean(),
})
export type SessionSidebarHiddenInput = z.infer<typeof sessionSidebarHiddenInputSchema>

export const sessionRenameInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
})
export type SessionRenameInput = z.infer<typeof sessionRenameInputSchema>

export const sessionMarkReadInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  throughSequence: z.number().int().nonnegative(),
})
export type SessionMarkReadInput = z.infer<typeof sessionMarkReadInputSchema>

export const sessionEditorModelCatalogsSchema = z.strictObject({
  claude: agentModelCatalogSchema,
  codex: agentModelCatalogSchema,
  agy: agentModelCatalogSchema.optional(),
})

export const sessionSettingsEditorStateSchema = z.strictObject({
  session: collaborationSessionSchema,
  modelCatalogs: sessionEditorModelCatalogsSchema,
})
export type SessionSettingsEditorState = z.infer<typeof sessionSettingsEditorStateSchema>

export const sessionSettingsSaveResultSchema = z.strictObject({
  catalogChange: sessionCatalogChangeSchema,
  modelCatalogs: sessionEditorModelCatalogsSchema,
})
export type SessionSettingsSaveResult = z.infer<typeof sessionSettingsSaveResultSchema>

export const sessionSettingsSaveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  settings: defaultSessionSettingsSchema,
})
export type SessionSettingsSaveInput = z.infer<typeof sessionSettingsSaveInputSchema>

export const sessionPermissionSaveInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    agentId: runtimeAgentIdSchema,
    mode: sessionPermissionModeSchema,
    expectedRevision: z.number().int().positive(),
    confirmedFullAccess: z.boolean().default(false),
  })
  .refine(
    (input) => input.mode !== 'full' || input.confirmedFullAccess,
    'Full access requires explicit confirmation.',
  )
export type SessionPermissionSaveInput = z.infer<typeof sessionPermissionSaveInputSchema>

export const sessionSpeedSaveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  speed: agentSpeedSchema,
  expectedRevision: z.number().int().positive(),
})
export type SessionSpeedSaveInput = z.infer<typeof sessionSpeedSaveInputSchema>

export const sessionForkSideSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  state: z.enum(['prepared', 'forking', 'unconfirmed', 'initializing', 'ready', 'error']),
  nativeSessionId: z.string().min(1).max(1024).optional(),
  reason: z.string().max(1024).optional(),
  canInitialize: z.boolean(),
  canContinue: z.boolean(),
})
export const sessionForkOperationSchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sourceSessionId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceSequence: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  ready: z.boolean(),
  sides: z.array(sessionForkSideSchema).length(2),
})
export type SessionForkOperation = z.infer<typeof sessionForkOperationSchema>

export const sessionForkPreparedSchema = z.strictObject({
  sourceSessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  messageRevision: z.number().int().nonnegative(),
  settingsRevision: z.number().int().positive(),
  sourceRevision: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  preview: z.string().max(256),
  settings: sessionSettingsSchema,
})
export type SessionForkPrepared = z.infer<typeof sessionForkPreparedSchema>

const sessionForkActionSchema = z.strictObject({
  sessionId: z.string().uuid(),
  operationId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
})
export const sessionForkInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('prepare'),
    sourceSessionId: z.string().uuid(),
    messageId: z.string().uuid(),
  }),
  sessionForkPreparedSchema.omit({ sequence: true, preview: true, settings: true }).extend({
    action: z.literal('create'),
    operationId: z.string().uuid(),
    confirmedFullAccessAgents: z.array(runtimeAgentIdSchema).max(2),
  }),
  z.strictObject({ action: z.literal('read'), sessionId: z.string().uuid() }),
  sessionForkActionSchema.extend({ action: z.literal('check') }),
  sessionForkActionSchema.extend({ action: z.literal('initialize') }),
  sessionForkActionSchema.extend({ action: z.literal('continue') }),
])
export type SessionForkInput = z.infer<typeof sessionForkInputSchema>
export const sessionForkResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), prepared: sessionForkPreparedSchema }),
  z.strictObject({
    kind: z.literal('created'),
    change: sessionCatalogChangeSchema,
    operation: sessionForkOperationSchema,
  }),
  z.strictObject({ kind: z.literal('state'), operation: sessionForkOperationSchema.nullable() }),
])
export type SessionForkResult = z.infer<typeof sessionForkResultSchema>

export const conversationMessageRouteSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('primary'), agentId: runtimeAgentIdSchema }),
  z.strictObject({ type: z.literal('agent'), agentId: runtimeAgentIdSchema }),
  z.strictObject({
    type: z.literal('all'),
    firstAgentId: runtimeAgentIdSchema,
    secondAgentId: runtimeAgentIdSchema,
  }),
])
export type ConversationMessageRoute = z.infer<typeof conversationMessageRouteSchema>

export const peerRequestKindSchema = z.enum(['supplement', 'fact_check', 'challenge', 'review'])
export type PeerRequestKind = z.infer<typeof peerRequestKindSchema>

export const peerRequestToolInputShape = {
  target: runtimeAgentIdSchema,
  kind: peerRequestKindSchema,
  reason: z.string().trim().min(1).max(240).optional(),
}
export function peerRequestToolInputShapeFor<T extends RuntimeAgentId>(target: T) {
  return { ...peerRequestToolInputShape, target: z.literal(target) }
}
export const peerRequestToolInputSchema = z.strictObject(peerRequestToolInputShape)
export type PeerRequestToolInput = z.infer<typeof peerRequestToolInputSchema>

export const peerRequestProposalSchema = z.strictObject({
  id: z.string().uuid(),
  targetAgentId: runtimeAgentIdSchema,
  kind: peerRequestKindSchema,
  reason: z.string().min(1).max(240).optional(),
  state: z.enum(['pending', 'accepted', 'dismissed', 'superseded']),
  acceptedMessageId: z.string().uuid().optional(),
})
export type PeerRequestProposal = z.infer<typeof peerRequestProposalSchema>

export const conversationDisplayOrderSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  rank: z.number().int().min(0).max(2),
  id: z.string().uuid(),
})
export type ConversationDisplayOrder = z.infer<typeof conversationDisplayOrderSchema>
export const conversationSnapshotViewSchema = z.strictObject({
  runId: z.string().uuid(),
  mode: z.enum(['preserve', 'expanded']),
})
export type ConversationSnapshotView = z.infer<typeof conversationSnapshotViewSchema>
export const conversationRunContextSchema = z.strictObject({
  runId: z.string().uuid(),
  order: conversationDisplayOrderSchema,
  earlierResponseCount: z.number().int().nonnegative().max(64),
  settled: z.boolean(),
})
export type ConversationRunContext = z.infer<typeof conversationRunContextSchema>

export const conversationMessageSchema = z.strictObject({
  historicalBackgroundReport: z.literal(true).optional(),
  outputSnapshot: z
    .strictObject({
      ordinal: z.number().int().nonnegative().max(63),
      frozen: z.boolean(),
      canonical: z.boolean(),
      order: conversationDisplayOrderSchema,
    })
    .optional(),
  skills: skillSelectionsSchema.optional(),
  images: conversationImagesSchema.optional(),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  replyToMessageId: z.string().uuid().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  agentId: runtimeAgentIdSchema.optional(),
  route: conversationMessageRouteSchema.optional(),
  pendingAgentId: runtimeAgentIdSchema.optional(),
  sourceMessageId: z.string().uuid().optional(),
  originSideChat: originSideChatSchema.optional(),
  content: z.string(),
  contentRevision: z.number().int().nonnegative(),
  state: z.enum(['complete', 'streaming', 'incomplete']),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

/** An Assistant update with an origin Message and no canonical reply or Turn slot. */
export function isConversationBackgroundReport(message: {
  role: ConversationMessage['role']
  runId?: string | null | undefined
  sourceMessageId?: string | null | undefined
}): boolean {
  return message.role === 'assistant' && !message.runId && Boolean(message.sourceMessageId)
}

export function conversationMessageOrder(
  message: Pick<ConversationMessage, 'id' | 'sequence' | 'outputSnapshot'>,
): ConversationDisplayOrder {
  return message.outputSnapshot?.order ?? { sequence: message.sequence, rank: 1, id: message.id }
}
export function compareConversationDisplayOrder(
  left: ConversationDisplayOrder,
  right: ConversationDisplayOrder,
): number {
  return left.sequence - right.sequence || left.rank - right.rank || left.id.localeCompare(right.id)
}
export function compareConversationMessages(
  left: ConversationMessage,
  right: ConversationMessage,
): number {
  return compareConversationDisplayOrder(
    conversationMessageOrder(left),
    conversationMessageOrder(right),
  )
}

export const agentActivitySchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  nativeId: z.string().min(1),
  kind: z.enum(['reasoning', 'tool']),
  toolName: z.string().min(1).max(120).optional(),
  title: z.string().min(1),
  detail: z.string().optional(),
  detailRevision: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed']),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentActivity = z.infer<typeof agentActivitySchema>

export const runFailureKindSchema = z.enum([
  'transient_transport',
  'agent_process_crash',
  'authentication_required',
  'quota_or_rate_limit',
  'runtime_incompatible',
  'native_session_occupied',
  'protocol_error',
  'response_too_large',
  'permission_blocked',
  'unknown_delivery',
  'context_resume_failed',
  'context_limit',
  'user_stopped',
])
export type RunFailureKind = z.infer<typeof runFailureKindSchema>

export const nativeContinuationStateSchema = z.enum([
  'ready',
  'responding',
  'waiting_user',
  'checking',
  'recovery_required',
  'rebuilding',
])
export type NativeContinuationState = z.infer<typeof nativeContinuationStateSchema>

export const nativeEvidenceIdentitySchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  runId: z.string().uuid().optional(),
  requestId: z.string().uuid(),
  nativeSessionId: z.string().min(1).max(1024),
  nativeTurnId: z.string().min(1).max(1024).optional(),
  bindingGeneration: z.number().int().positive(),
  executorId: z.string().uuid().optional(),
})
export type NativeEvidenceIdentity = z.infer<typeof nativeEvidenceIdentitySchema>

export const codexInitializationWitnessSchema = z.strictObject({
  kind: z.literal('codex_rollout_v1'),
  nativeSessionId: nativeEvidenceIdentitySchema.shape.nativeSessionId,
  verifiedPrefixBytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  verifiedPrefixSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  recordCount: z.number().int().positive().max(10_000),
})
export type CodexInitializationWitness = z.infer<typeof codexInitializationWitnessSchema>

/** Small private initialization receipt; never a copy of native history. */
export const nativeInitializationWitnessSchema = z.discriminatedUnion('kind', [
  codexInitializationWitnessSchema,
  agyRebuildInitializationWitnessSchema,
])
export type NativeInitializationWitness = z.infer<typeof nativeInitializationWitnessSchema>

const nativeRecoveredOutputSchema = z
  .strictObject({
    outputId: z.string().min(1).max(1024),
    text: z.string(),
    completeness: z.enum(['complete', 'partial']),
    plan: z.strictObject({ nativeId: z.string().min(1).max(1024), text: z.string() }).optional(),
    planUnavailable: z.literal(true).optional(),
    retainedPlan: collaborationRetainedPlanSchema.optional(),
    reviewVerdict: collaborationReviewVerdictSchema.optional(),
    reviewResult: collaborationReviewObservationSchema.optional(),
    inputResult: collaborationInputObservationSchema.optional(),
    inputOutcome: collaborationInputOutcomeSchema.optional(),
  })
  .refine(
    (value) =>
      Number(Boolean(value.plan)) +
        Number(Boolean(value.retainedPlan)) +
        Number(Boolean(value.planUnavailable)) <=
      1,
    'Native plan observations conflict.',
  )
  .refine(
    (value) =>
      (!value.reviewResult ||
        !value.reviewVerdict ||
        value.reviewResult.verdict === value.reviewVerdict) &&
      (!value.inputResult ||
        !value.inputOutcome ||
        value.inputResult.outcome === value.inputOutcome),
    'Native workflow observations conflict.',
  )
export type NativeRecoveredOutput = z.infer<typeof nativeRecoveredOutputSchema>
export const nativeProbeResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('binding_ready'),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('completed_initialization_readback'),
    rebuildId: z.string().uuid(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    witness: nativeInitializationWitnessSchema.optional(),
  }),
  z.strictObject({
    kind: z.enum(['running', 'waiting_user']),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('live_runtime'),
  }),
  z.strictObject({
    kind: z.literal('ended'),
    identity: nativeEvidenceIdentitySchema,
    source: z.enum(['live_terminal', 'stored_terminal']),
    outcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
    planUnavailable: z.literal(true).optional(),
    output: nativeRecoveredOutputSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('missing'),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('native_error'),
  }),
  z.strictObject({
    kind: z.literal('no_evidence'),
    identity: nativeEvidenceIdentitySchema,
    reason: z.string().min(1).max(240),
    output: nativeRecoveredOutputSchema.optional(),
  }),
])
export type NativeProbeResult = z.infer<typeof nativeProbeResultSchema>

export const nativeRebuildOperationSchema = z.strictObject({
  id: z.string().uuid(),
  oldGeneration: z.number().int().positive(),
  stage: z.enum([
    'preparing',
    'creating',
    'seeding',
    'unconfirmed',
    'completed',
    'failed',
    'superseded',
  ]),
  provisionalNativeSessionId: z.string().min(1).max(1024).optional(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  failureReason: z.string().max(240).optional(),
  checkAction: z.enum(['inspect', 'rebuild']).optional(),
})
export type NativeRebuildOperation = z.infer<typeof nativeRebuildOperationSchema>
export const pendingNativeRebuildSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  operation: nativeRebuildOperationSchema,
})
export type PendingNativeRebuild = z.infer<typeof pendingNativeRebuildSchema>

export const pendingNativeInteractionSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  bindingGeneration: z.number().int().positive(),
  executorId: z.string().uuid().optional(),
  request: nativePermissionRequestSchema,
})
export type PendingNativeInteraction = z.infer<typeof pendingNativeInteractionSchema>

export const agentRunSchema = z.strictObject({
  outputSnapshots: z
    .strictObject({
      count: z.number().int().nonnegative().max(64),
      lastInputMessageId: z.string().uuid(),
      lastInputSequence: z.number().int().nonnegative(),
      settled: z.boolean(),
    })
    .optional(),
  collaboration: z
    .strictObject({
      taskId: z.string().uuid(),
      kind: z.enum(['plan', 'build', 'review']),
      stage: collaborationStageSchema,
      planVersion: z.number().int().positive().optional(),
    })
    .optional(),
  forkSourceRunId: z.string().uuid().optional(),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  status: z.enum(['starting', 'running', 'recovering', 'completed', 'failed', 'interrupted']),
  attemptCount: z.number().int().positive(),
  settingsRevision: z.number().int().positive(),
  model: z.string().min(1).nullable(),
  permissionMode: sessionPermissionModeSchema.optional(),
  effort: z.string().min(1).nullable(),
  speed: agentSpeedSchema.optional(),
  observedSpeed: z.enum(['standard', 'fast']).optional(),
  speedDetail: z.string().max(512).optional(),
  nativeSessionId: z.string().min(1).optional(),
  nativeTurnId: z.string().min(1).optional(),
  bindingGeneration: z.number().int().positive().optional(),
  executorId: z.string().uuid().optional(),
  controlDisposition: z.enum(['retained', 'abandoned']).optional(),
  dispatchPhase: z.enum(['not_sent', 'possibly_sent', 'accepted', 'ended', 'rejected']).optional(),
  nativeOutcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
  responseMessageId: z.string().uuid().optional(),
  nativeEffectsState: z.enum(['not_dispatched', 'pending', 'settled', 'unknown']).optional(),
  nativeEffectsReason: z.string().max(128).optional(),
  workspaceRecordingUnavailableReason: z.string().min(1).max(240).optional(),
  reexecutedFromRunId: z.string().uuid().optional(),
  failureKind: runFailureKindSchema.optional(),
  failureMessage: z.string().optional(),
  handoffMessageCount: z.number().int().positive().optional(),
  handoffSourceAgents: z.array(runtimeAgentIdSchema).min(1).max(3).optional(),
  peerProposal: peerRequestProposalSchema.optional(),
  workspaceChanges: workspaceChangeSetSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentRun = z.infer<typeof agentRunSchema>

export const nativeAgentContextSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  permissionRequests: z
    .array(nativePermissionRequestSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
  nativeSessionId: z.string().min(1),
  bindingGeneration: z.number().int().positive().optional(),
  executorId: z.string().uuid().optional(),
  continuationState: nativeContinuationStateSchema.optional(),
  recoveryReason: z.string().max(240).optional(),
  recoveryAction: z.enum(['retry', 'rebuild', 'none']).optional(),
  rebuildOperation: nativeRebuildOperationSchema.optional(),
  state: z.enum([
    'active',
    'interrupted',
    'missing',
    'rebuilding',
    'unavailable',
    'uncertain',
    'superseded',
  ]),
  lastRunId: z.string().uuid().optional(),
  recoveryFailureKind: runFailureKindSchema.optional(),
  recoveryFailureMessage: z.string().optional(),
  rebuildMessageCount: z.number().int().nonnegative().optional(),
  rebuiltThroughSequence: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
})
export type NativeAgentContext = z.infer<typeof nativeAgentContextSchema>

export const backgroundStopTargetSchema = z.strictObject({
  runId: z.string().uuid(),
  nativeSessionId: z.string().min(1).max(1024),
  bindingGeneration: z.number().int().positive(),
  executorId: z.string().min(1).max(1024),
})
export type BackgroundStopTarget = z.infer<typeof backgroundStopTargetSchema>

export const sessionIssueSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  generation: z.number().int().positive(),
  nativeSessionId: z.string().min(1).max(1024).optional(),
  runId: z.string().uuid().optional(),
  rebuildId: z.string().uuid().optional(),
  phase: z.enum([
    'warning',
    'checking',
    'rebuild_offer',
    'rebuilding',
    'unconfirmed',
    'resolved',
    'background_working',
    'background_stopping',
    'background_check',
    'background_checking',
  ]),
  backgroundStop: backgroundStopTargetSchema.optional(),
  title: z.string().max(120),
  reason: z.string().max(1024),
  inputDisposition: z.enum(['not_submitted', 'possibly_submitted', 'submitted']),
  resultDisposition: z.enum(['pending', 'complete', 'incomplete', 'unavailable']),
  action: z.enum(['retry_check', 'rebuild', 'inspect_rebuild', 'none']),
  actionReason: z.string().max(512).optional(),
  abandon: z.boolean(),
  previousCreationUnconfirmed: z.boolean(),
})
export type SessionIssue = z.infer<typeof sessionIssueSchema>
export const sessionIssuesSchema = z.strictObject({
  sessionId: z.string().uuid(),
  inputGate: z.enum(['open', 'send_blocked', 'read_only']),
  agents: z.array(sessionIssueSchema).max(3),
})
export type SessionIssues = z.infer<typeof sessionIssuesSchema>

export const rebuildInputRecoverySchema = z.strictObject({
  inputBatchRef: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.number().int().nonnegative(),
      memberCount: z.number().int().nonnegative(),
    })
    .optional(),
  operationId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  messageId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  state: z.enum(['pending', 'installed']),
  route: conversationMessageRouteSchema,
  commentIds: z.array(z.string().uuid()).default([]),
  draftEligibility: z
    .strictObject({
      commentsRevision: z.number().int().nonnegative(),
      canRestore: z.boolean(),
    })
    .optional(),
})
export type RebuildInputRecovery = z.infer<typeof rebuildInputRecoverySchema>
/** Private durable return receipt; original bodies remain in their existing rows. */
export const rebuildReturnedInputRecordSchema = z.strictObject({
  inputBatchRef: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.number().int().nonnegative(),
      memberCount: z.number().int().nonnegative(),
    })
    .optional(),
  images: z
    .array(z.strictObject({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }))
    .max(128)
    .optional(),
  version: z.literal('rebuild-return-v1'),
  state: z.enum(['prepared', 'pending', 'installed', 'consumed']),
  messageId: z.string().uuid(),
  runId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f\d]{64}$/u),
  route: conversationMessageRouteSchema,
  comments: z.array(
    z.strictObject({
      sourceId: z.string().uuid(),
      cloneId: z.string().uuid(),
      hash: z.string().regex(/^[a-f\d]{64}$/u),
    }),
  ),
})
export type RebuildReturnedInputRecord = z.infer<typeof rebuildReturnedInputRecordSchema>

/** One durable pending input; previews never carry complete message bodies. */
export const conversationQueuedInputSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  recipient: z.enum(['claude', 'codex', 'agy', 'all']),
  preview: z.string().max(512),
  workflowCommand: z.boolean(),
  state: z.enum(['queued', 'paused', 'dispatching', 'unknown']),
  delivery: z.strictObject({ runId: z.string().uuid(), canRemove: z.boolean() }).optional(),
  reason: z.string().max(512).optional(),
  /** Display-only projection of the task this queued command confirmed it replaces. */
  replacesTask: z
    .strictObject({
      kind: pactSkillSchema,
      actor: runtimeAgentIdSchema,
    })
    .optional(),
  imageCount: z.number().int().nonnegative().max(128),
  commentCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
})
export type ConversationQueuedInput = z.infer<typeof conversationQueuedInputSchema>
export const conversationQueueStateSchema = z.strictObject({
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  input: conversationQueuedInputSchema.nullable(),
  returnedInput: z
    .strictObject({
      inputId: z.string().uuid(),
      operationId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      claimId: z.string().uuid().optional(),
      installedCommentsRevision: z.number().int().nonnegative().optional(),
      state: z.enum(['pending', 'installed']),
    })
    .nullable()
    .optional(),
})
export type ConversationQueueState = z.infer<typeof conversationQueueStateSchema>
export const conversationQueueActionInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  inputId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
})
export type ConversationQueueActionInput = z.infer<typeof conversationQueueActionInputSchema>
export const conversationQueueReturnInputSchema = conversationQueueActionInputSchema.extend({
  phase: z.enum(['return', 'claim']).default('return'),
  claimId: z.string().uuid().optional(),
  expectedCommentsRevision: z.number().int().nonnegative().optional(),
})
export type ConversationQueueReturnInput = z.infer<typeof conversationQueueReturnInputSchema>
export const conversationQueueEnabledInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  enabled: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
})
export type ConversationQueueEnabledInput = z.infer<typeof conversationQueueEnabledInputSchema>

export const conversationSnapshotSchema = z.strictObject({
  preparedInputContinuation: preparedInputContinuationSchema.nullable().optional(),
  relaySchedulingDecision: relaySchedulingDecisionSchema.nullable().optional(),
  observation: z.strictObject({
    incarnation: z.string().uuid(),
    sequence: z.number().int().positive(),
  }),
  sessionId: z.string().uuid(),
  session: z.strictObject({
    id: z.string().uuid(),
    title: z.string().min(1),
    titleSource: sessionTitleSourceSchema,
    status: sessionStatusSchema,
    activity: sessionActivitySchema,
    hasUnread: z.boolean(),
    updatedAt: z.string().datetime(),
  }),
  messages: z.array(conversationMessageSchema),
  comments: z.array(anchoredCommentSchema),
  commentsRevision: z.number().int().nonnegative(),
  activities: z.array(agentActivitySchema),
  runs: z.array(agentRunSchema),
  nativeContexts: z.array(nativeAgentContextSchema),
  rebuildOperations: z.array(pendingNativeRebuildSchema).max(3).optional(),
  rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
  forkOperation: sessionForkOperationSchema.optional(),
  forkBlocked: z.boolean().optional(),
  pendingNativeInteractions: z
    .array(pendingNativeInteractionSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
})
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>

export const CONVERSATION_PAGE_ITEMS = 25
export const CONVERSATION_PAGE_BYTES = 1024 * 1024
export const CONVERSATION_WINDOW_MESSAGES = 100
export const CONVERSATION_WORK_LOG_ITEMS = 50
export const CONVERSATION_EXPAND_BYTES = 2 * 1024 * 1024
export const CONVERSATION_MARKDOWN_BYTES = 128 * 1024
export const CONVERSATION_PATCH_BYTES = 64 * 1024
export const CONVERSATION_PATCH_TEXT_BYTES = 16 * 1024
export const CONVERSATION_PATCH_ACTIVITY_ITEMS = 16
export const CONVERSATION_STREAM_BATCH_ITEMS = 64
export const CONVERSATION_STREAM_BATCH_BYTES = 1024 * 1024
export const conversationInterestSchema = z
  .strictObject({
    sessionId: z.string().uuid().nullable().optional(),
    sessionIds: z.array(z.string().uuid()).max(CONVERSATION_ACTIVE_SESSIONS_PER_VIEWER).optional(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) => value.sessionId !== undefined || value.sessionIds !== undefined,
    'Provide sessionId or sessionIds for conversation interest.',
  )
  .refine(
    (value) => !(value.sessionId !== undefined && value.sessionIds !== undefined),
    'Provide either sessionId or sessionIds, not both.',
  )
  .refine(
    (value) =>
      value.sessionIds === undefined || new Set(value.sessionIds).size === value.sessionIds.length,
    'Conversation interest sessionIds must be unique.',
  )
export const conversationInterestsSchema = z
  .strictObject({
    sessionIds: z.array(z.string().uuid()).max(CONVERSATION_INTEREST_ITEMS),
  })
  .refine(
    (value) =>
      new Set(value.sessionIds).size === value.sessionIds.length &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512,
    'Conversation interests exceed their unique-item or byte limit.',
  )

export const SESSION_NOTIFICATION_PRIORITIES = {
  completed: 1,
  failure: 2,
  needs_input: 3,
} as const
export const sessionNotificationCategorySchema = z.enum(['needs_input', 'failure', 'completed'])
export type SessionNotificationCategory = z.infer<typeof sessionNotificationCategorySchema>
export const sessionNotificationRaiseSchema = z.strictObject({
  kind: z.literal('raise'),
  id: z.string().min(1).max(160),
  sessionId: z.string().uuid(),
  sessionTitle: z.string().min(1).max(120),
  agentId: runtimeAgentIdSchema.optional(),
  category: sessionNotificationCategorySchema,
  priority: z.number().int().min(1).max(3),
  createdAt: z.string().datetime(),
})
export const sessionNotificationRevokeSchema = z.strictObject({
  kind: z.literal('revoke'),
  id: z.string().min(1).max(160),
  sessionId: z.string().uuid(),
})
export const sessionNotificationEventSchema = z.discriminatedUnion('kind', [
  sessionNotificationRaiseSchema,
  sessionNotificationRevokeSchema,
])
export type SessionNotificationEvent = z.infer<typeof sessionNotificationEventSchema>
export const sessionReminderSchema = sessionNotificationRaiseSchema.omit({ kind: true }).extend({
  secondaryCategory: sessionNotificationCategorySchema.optional(),
  secondaryIsLatest: z.boolean().optional(),
  summary: z.boolean().optional(),
  summaryAttention: z.number().int().nonnegative().max(999).optional(),
  summaryCompleted: z.number().int().nonnegative().max(999).optional(),
  summaryTarget: z.enum(['attention', 'workspace']).optional(),
})
export type SessionReminder = z.infer<typeof sessionReminderSchema>
export const sessionReminderStateSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  current: sessionReminderSchema.nullable(),
  pending: z.number().int().nonnegative().max(32),
})
export type SessionReminderState = z.infer<typeof sessionReminderStateSchema>
export const sessionReminderActionSchema = z.strictObject({
  id: z.string().min(1).max(160),
})
export type SessionReminderAction = z.infer<typeof sessionReminderActionSchema>
export const sessionReminderActionResultSchema = z.strictObject({ accepted: z.literal(true) })
export type SessionReminderActionResult = z.infer<typeof sessionReminderActionResultSchema>

const conversationPageBaseInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
})
export const conversationGetInputSchema = z.discriminatedUnion('scope', [
  conversationPageBaseInputSchema
    .extend({
      scope: z.literal('collaboration-quote'),
      runId: z.string().uuid(),
      document: collaborationDocumentSchema,
      basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
    })
    .refine(
      (value) =>
        value.endOffset > value.startOffset &&
        value.endOffset - value.startOffset <= 20_000 &&
        value.offset >= value.startOffset &&
        value.offset < value.endOffset,
      'Invalid document selection range.',
    ),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration-markdown'),
    basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']).optional(),
    runId: z.string().uuid(),
    document: collaborationDocumentSchema,
    offset: z.number().int().nonnegative(),
    aroundOffset: z.number().int().nonnegative().optional(),
    preparationId: z.string().uuid().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration-text'),
    runId: z.string().uuid(),
    document: collaborationDocumentSchema,
    offset: z.number().int().nonnegative(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration'),
    runId: z.string().uuid().optional(),
    projection: z.enum(['current', 'report', 'plan']).optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('prepared-input'),
    batchId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    sourceId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('queued-input'),
    source: z.enum(['queued', 'returned']),
    inputId: z.string().uuid(),
    operationId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative(),
    commentsAfterPosition: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('rebuild-input'),
    operationId: z.string().uuid(),
    offset: z.number().int().nonnegative(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('messages'),
    beforeSequence: z.number().int().nonnegative().optional(),
    beforeDisplay: conversationDisplayOrderSchema.optional(),
    snapshotView: conversationSnapshotViewSchema.optional(),
    preserveRunId: z.string().uuid().optional(),
    aroundMessageId: z.string().uuid().optional(),
    includeHistoricalSource: z.boolean().optional(),
    incarnation: z.string().uuid().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('drafts'),
    afterPosition: z.number().int().nonnegative().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('comments'),
    messageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(CONVERSATION_WINDOW_MESSAGES)
      .refine((ids) => new Set(ids).size === ids.length, 'Message IDs must be unique.'),
    afterPosition: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('activities'),
    runId: z.string().uuid(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('run-artifacts'),
    userMessageId: z.string().uuid(),
    agentId: runtimeAgentIdSchema,
    before: z.strictObject({ createdAt: z.string().datetime(), id: z.string().uuid() }).optional(),
    incarnation: z.string().uuid().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('activity-body'),
    activityId: z.string().uuid(),
    detailRevision: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  }),
])
export type ConversationGetInput = z.infer<typeof conversationGetInputSchema>

const conversationObservationSchema = z.strictObject({
  incarnation: z.string().uuid(),
  sequence: z.number().int().positive(),
})
export type ConversationObservation = z.infer<typeof conversationObservationSchema>

const conversationPageMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('complete'),
    message: conversationMessageSchema,
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('oversized'),
    message: conversationMessageSchema.omit({ content: true }),
    contentBytes: z.number().int().positive(),
    preview: z.string(),
    previewChars: z.number().int().nonnegative(),
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  }),
])
export type ConversationPageMessage = z.infer<typeof conversationPageMessageSchema>

const conversationPageActivitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete'), activity: agentActivitySchema }),
  z.strictObject({
    kind: z.literal('oversized'),
    activity: agentActivitySchema.omit({ detail: true }),
    detailBytes: z.number().int().positive(),
    preview: z.string(),
    previewChars: z.number().int().nonnegative(),
  }),
])
export type ConversationPageActivity = z.infer<typeof conversationPageActivitySchema>

const conversationPageHeaderSchema = z.strictObject({
  preparedInputContinuation: preparedInputContinuationSchema.nullable().optional(),
  relaySchedulingDecision: relaySchedulingDecisionSchema.nullable().optional(),
  queue: conversationQueueStateSchema.optional(),
  receivedInputIds: z.array(z.string().uuid()).max(1).optional(),
  session: conversationSnapshotSchema.shape.session,
  commentsRevision: z.number().int().nonnegative(),
  latestRun: agentRunSchema.optional(),
  latestCompleteAssistantSequence: z.number().int().nonnegative().optional(),
  nativeContexts: z.array(nativeAgentContextSchema).max(3).optional(),
  rebuildOperations: z.array(pendingNativeRebuildSchema).max(3).optional(),
  rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
  forkOperation: sessionForkOperationSchema.optional(),
  forkBlocked: z.boolean().optional(),
  sessionIssues: sessionIssuesSchema.optional(),
  pendingNativeInteractions: z
    .array(pendingNativeInteractionSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
})

export const conversationPageSchema = z
  .discriminatedUnion('scope', [
    z
      .strictObject({
        scope: z.literal('collaboration-quote'),
        sessionId: z.string().uuid(),
        document: collaborationDocumentSchema,
        basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']),
        startOffset: z.number().int().nonnegative(),
        endOffset: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        text: z.string().min(1).max(4096),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .refine(
        (value) =>
          value.endOffset > value.startOffset &&
          value.endOffset - value.startOffset <= 20_000 &&
          value.offset >= value.startOffset &&
          value.offset + value.text.length <= value.endOffset &&
          value.nextOffset ===
            (value.offset + value.text.length < value.endOffset
              ? value.offset + value.text.length
              : null) &&
          new TextEncoder().encode(JSON.stringify(value)).byteLength <= 48 * 1024,
        'Invalid document selection page.',
      ),
    z.strictObject({
      scope: z.literal('collaboration-markdown-pending'),
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      document: collaborationDocumentSchema,
      preparationId: z.string().uuid(),
      deadline: z.number().int().positive(),
    }),
    z
      .strictObject({
        scope: z.literal('collaboration-markdown'),
        basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']),
        sessionId: z.string().uuid(),
        document: collaborationDocumentSchema,
        offset: z.number().int().nonnegative(),
        visibleStart: z.number().int().nonnegative(),
        visibleEnd: z.number().int().nonnegative(),
        tree: collaborationMarkdownNodeSchema,
        nextOffset: z.number().int().nonnegative().nullable(),
        previousOffset: z.number().int().nonnegative().nullable(),
      })
      .refine(
        (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 48 * 1024,
        'Collaboration Markdown page exceeds its byte budget.',
      )
      .refine(
        (page) => collaborationMarkdownTreeWithinBudget(page.tree),
        'Markdown page exceeds its node or stack budget.',
      ),
    z
      .strictObject({
        scope: z.literal('collaboration-text'),
        sessionId: z.string().uuid(),
        document: collaborationDocumentSchema,
        offset: z.number().int().nonnegative(),
        text: z.string(),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .refine(
        (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 48 * 1024,
        'Collaboration text page exceeds its byte budget.',
      ),
    z.strictObject({
      scope: z.literal('collaboration'),
      sessionId: z.string().uuid(),
      view: collaborationViewSchema,
    }),
    z
      .strictObject({
        scope: z.literal('prepared-input'),
        sessionId: z.string().uuid(),
        batchId: z.string().uuid(),
        revision: z.number().int().nonnegative(),
        body: collaborationDocumentSchema,
        offset: z.number().int().nonnegative(),
        text: z.string().max(4096),
        nextOffset: z.number().int().nonnegative().nullable(),
        sourceId: z.string().uuid(),
        declaredInformation: userInformationDeclarationSchema.optional(),
        sources: z
          .array(
            z.strictObject({
              sourceId: z.string().uuid(),
              label: z.string().max(96),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              bytes: z.number().int().nonnegative(),
              chars: z.number().int().nonnegative(),
            }),
          )
          .max(13),
      })
      .refine(
        (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 48 * 1024,
        'The prepared input page exceeds its byte budget.',
      ),
    z.strictObject({
      scope: z.literal('queued-input'),
      source: z.enum(['queued', 'returned']),
      offset: z.number().int().nonnegative(),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
      operationId: z.string().uuid().optional(),
      text: z.string().max(8192),
      nextOffset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      commentsNextPosition: z.number().int().nonnegative().nullable(),
      images: conversationImagesSchema.optional(),
      skills: skillSelectionsSchema.optional(),
      route: conversationMessageRouteSchema,
      batchId: z.string().uuid().optional(),
    }),
    z.strictObject({
      scope: z.literal('rebuild-input'),
      images: conversationImagesSchema.optional(),
      skills: skillSelectionsSchema.optional(),
      sessionId: z.string().uuid(),
      operationId: z.string().uuid(),
      messageId: z.string().uuid(),
      text: z.string().max(8192),
      nextOffset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      route: conversationMessageRouteSchema,
    }),
    z.strictObject({
      scope: z.literal('messages'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      header: conversationPageHeaderSchema,
      messages: z.array(conversationPageMessageSchema).max(CONVERSATION_PAGE_ITEMS),
      runContexts: z.array(conversationRunContextSchema).max(CONVERSATION_PAGE_ITEMS).optional(),
      snapshotView: conversationSnapshotViewSchema.optional(),
      preserveRunId: z.string().uuid().optional(),
      runs: z.array(agentRunSchema).max(CONVERSATION_PAGE_ITEMS),
      runArtifacts: z
        .array(
          z.strictObject({
            userMessageId: z.string().uuid(),
            agentId: runtimeAgentIdSchema,
            totalCount: z.number().int().nonnegative(),
            latestRunId: z.string().uuid(),
          }),
        )
        .max(50)
        .optional(),
      hasOlder: z.boolean(),
      hasNewer: z.boolean(),
      sourceMessageId: z.string().uuid().optional(),
    }),
    z.strictObject({
      scope: z.literal('drafts'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      commentsRevision: z.number().int().nonnegative(),
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      hasMore: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('comments'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      hasMore: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('activities'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      runId: z.string().uuid(),
      activities: z.array(conversationPageActivitySchema).max(CONVERSATION_WORK_LOG_ITEMS),
      truncated: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('run-artifacts'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      userMessageId: z.string().uuid(),
      agentId: runtimeAgentIdSchema,
      runs: z.array(agentRunSchema).max(3),
      totalCount: z.number().int().nonnegative(),
      latestRunId: z.string().uuid().optional(),
      nextBefore: z
        .strictObject({ createdAt: z.string().datetime(), id: z.string().uuid() })
        .optional(),
    }),
    z.strictObject({
      scope: z.literal('activity-body'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      activityId: z.string().uuid(),
      detailRevision: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      text: z.string(),
      nextOffset: z.number().int().nonnegative().optional(),
    }),
  ])
  .superRefine((page, context) => {
    if (
      page.scope === 'messages' &&
      page.messages.length + (page.runContexts?.length ?? 0) > CONVERSATION_PAGE_ITEMS
    )
      context.addIssue({
        code: 'custom',
        message: 'Message and Run context rows exceed the shared page limit.',
      })
  })
export type ConversationPage = z.infer<typeof conversationPageSchema>

const conversationPatchTextEncoder = new TextEncoder()

const patchTextSchema = z
  .string()
  .refine(
    (value) =>
      conversationPatchTextEncoder.encode(value).byteLength <= CONVERSATION_PATCH_TEXT_BYTES,
    `Patch text must not exceed ${CONVERSATION_PATCH_TEXT_BYTES} UTF-8 bytes.`,
  )

const conversationMessageChangeSchema = z
  .strictObject({
    message: conversationMessageSchema.omit({ content: true }),
    mode: z.enum(['replace', 'append', 'advance', 'metadata', 'invalidate']),
    text: patchTextSchema.optional(),
    previousRevision: z.number().int().nonnegative().optional(),
    contentBytes: z.number().int().nonnegative().optional(),
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  })
  .superRefine((change, context) => {
    if ((change.mode === 'replace' || change.mode === 'append') && change.text === undefined) {
      context.addIssue({ code: 'custom', message: 'Text is required for this Message change.' })
    }
    if (
      (change.mode === 'append' || change.mode === 'advance') &&
      change.previousRevision === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Incremental change requires a previous revision.',
      })
    }
    if (
      (change.mode === 'advance' || change.mode === 'metadata' || change.mode === 'invalidate') &&
      change.text !== undefined
    ) {
      context.addIssue({ code: 'custom', message: 'This Message change cannot contain text.' })
    }
  })
export type ConversationMessageChange = z.infer<typeof conversationMessageChangeSchema>

const conversationActivityChangeSchema = z
  .strictObject({
    activity: agentActivitySchema.omit({ detail: true }),
    mode: z.enum(['replace', 'append', 'advance', 'metadata', 'invalidate']),
    detail: patchTextSchema.optional(),
    previousRevision: z.number().int().nonnegative().optional(),
    detailBytes: z.number().int().nonnegative().optional(),
  })
  .superRefine((change, context) => {
    if ((change.mode === 'replace' || change.mode === 'append') && change.detail === undefined) {
      context.addIssue({ code: 'custom', message: 'Detail is required for this Activity change.' })
    }
    if (
      (change.mode === 'append' || change.mode === 'advance') &&
      change.previousRevision === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Incremental change requires a previous revision.',
      })
    }
    if (
      (change.mode === 'advance' || change.mode === 'metadata' || change.mode === 'invalidate') &&
      change.detail !== undefined
    ) {
      context.addIssue({ code: 'custom', message: 'This Activity change cannot contain detail.' })
    }
  })
export type ConversationActivityChange = z.infer<typeof conversationActivityChangeSchema>

export const conversationPatchSchema = z
  .strictObject({
    documentProjection: z
      .strictObject({
        runId: z.string().uuid(),
        document: collaborationDocumentSchema,
        preparationId: z.string().uuid(),
        status: z.enum(['ready', 'failed']),
        message: z.string().max(512).optional(),
      })
      .optional(),
    version: z.literal('conversation-patch-v1'),
    runContexts: z.array(conversationRunContextSchema).max(1).optional(),
    queue: conversationQueueStateSchema.optional(),
    commentDraftReceipt: z
      .strictObject({ requestId: z.string().uuid(), commentId: z.string().uuid() })
      .optional(),
    sessionId: z.string().uuid(),
    observation: conversationObservationSchema,
    sendDisposition: z.literal('held_for_information').optional(),
    preparedInputContinuation: preparedInputContinuationSchema.nullable().optional(),
    relaySchedulingDecision: relaySchedulingDecisionSchema.nullable().optional(),
    session: conversationSnapshotSchema.shape.session,
    messages: z.array(conversationMessageChangeSchema).max(4),
    removedMessageIds: z.array(z.string().uuid()).max(4).optional(),
    runs: z.array(agentRunSchema).max(4),
    latestRunId: z.string().uuid().optional(),
    activities: z.array(conversationActivityChangeSchema).max(CONVERSATION_PATCH_ACTIVITY_ITEMS),
    activityStates: z
      .array(
        z.strictObject({
          runId: z.string().uuid(),
          status: z.enum(['completed', 'failed']),
        }),
      )
      .max(4),
    nativeContexts: z.array(nativeAgentContextSchema).max(3).optional(),
    rebuildOperations: z.array(pendingNativeRebuildSchema).max(3).optional(),
    rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
    forkOperation: sessionForkOperationSchema.optional(),
    forkBlocked: z.boolean().optional(),
    sessionIssues: sessionIssuesSchema.optional(),
    collaborationNotification: collaborationNotificationSchema.optional(),
    pendingNativeInteractions: z
      .array(pendingNativeInteractionSchema)
      .max(NATIVE_PERMISSION_REQUESTS)
      .optional(),
    pendingRoutedContinuation: z.boolean().optional(),
    comments: z
      .strictObject({
        revision: z.number().int().nonnegative(),
        upserts: z.array(anchoredCommentSchema).max(MAX_COMMENTS_PER_MESSAGE),
        removedIds: z.array(z.string().uuid()).max(MAX_COMMENTS_PER_MESSAGE),
        sent: z
          .strictObject({
            messageId: z.string().uuid(),
            commentIds: z.array(z.string().uuid()).max(MAX_COMMENTS_PER_MESSAGE),
          })
          .optional(),
      })
      .optional(),
    receivedInputIds: z.array(z.string().uuid()).max(1).optional(),
    // Send acknowledgement only: work was genuinely active when this input was received.
    queuedInputIds: z.array(z.string().uuid()).max(1).optional(),
    resync: z
      .strictObject({
        messages: z.boolean(),
        drafts: z.boolean(),
        activityRunIds: z.array(z.string().uuid()).max(4),
      })
      .optional(),
  })
  .refine(
    (patch) =>
      conversationPatchTextEncoder.encode(JSON.stringify(patch)).byteLength <=
      CONVERSATION_PATCH_BYTES,
    `Conversation Patch must not exceed ${CONVERSATION_PATCH_BYTES} UTF-8 bytes.`,
  )
export type ConversationPatch = z.infer<typeof conversationPatchSchema>

/** Bounded physical writes; logical message text is assembled by the Utility owner. */
export const CONVERSATION_INPUT_PART_CHARS = 8192
export const CONVERSATION_INPUT_WRITE_BYTES = 64 * 1024
export const conversationInputWriteSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('begin'),
      sessionId: z.string().uuid(),
      clientMessageId: z.string().uuid(),
    }),
    z.strictObject({
      type: z.literal('append'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      text: z.string().min(1).max(CONVERSATION_INPUT_PART_CHARS),
    }),
    z.strictObject({
      type: z.literal('seal'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
    }),
    z.strictObject({
      type: z.literal('release'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
    }),
  ])
  .refine(
    (input) =>
      conversationPatchTextEncoder.encode(JSON.stringify(input)).byteLength <=
      CONVERSATION_INPUT_WRITE_BYTES,
    'Input write exceeds its transport budget.',
  )
export type ConversationInputWrite = z.infer<typeof conversationInputWriteSchema>
export const conversationInputStateSchema = z.strictObject({
  inputId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  sealed: z.boolean(),
  bytes: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
})
export type ConversationInputState = z.infer<typeof conversationInputStateSchema>

export const conversationSendInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    clientMessageId: z.string().uuid(),
    returnedInputOperationId: z.string().uuid().optional(),
    queueReturnOperationId: z.string().uuid().optional(),
    /** The Composer preserves whether the user chose a recipient explicitly. */
    routeIntent: z.enum(['implicit', 'explicit']).optional(),
    askOnly: collaborationAskRefSchema.optional(),
    composerRevision: z.number().int().nonnegative().optional(),
    userInformation: userInformationDeclarationSchema.optional(),
    replyToDecision: z
      .strictObject({
        taskId: z.string().uuid(),
        runId: z.string().uuid(),
        decisionInputSequence: z.number().int().nonnegative(),
        expectedInputSequence: z.number().int().nonnegative(),
      })
      .optional(),
    inputId: z.string().uuid().optional(),
    imageIds: z.array(z.string().uuid()).max(128).optional(),
    skills: skillSelectionsSchema.optional(),
    content: z.string().trim(),
    batchId: z.string().uuid().optional(),
    freezeDrafts: z.boolean().optional(),
    expectedCommentsRevision: z.number().int().nonnegative(),
    commentIds: z.array(z.string().uuid()).default([]),
    route: z
      .discriminatedUnion('type', [
        z.strictObject({ type: z.literal('primary') }),
        z.strictObject({ type: z.literal('agent'), agentId: runtimeAgentIdSchema }),
        z.strictObject({ type: z.literal('all') }),
      ])
      .optional(),
    /** The Composer's confirmed reference to the unfinished task this command replaces. */
    replaceTask: collaborationReplacementSchema.optional(),
  })
  .superRefine((input, context) => {
    if (
      input.askOnly &&
      (input.freezeDrafts !== false ||
        input.route ||
        input.userInformation ||
        input.replyToDecision ||
        input.returnedInputOperationId ||
        input.queueReturnOperationId ||
        input.skills?.length ||
        input.imageIds?.length ||
        input.commentIds.length)
    )
      context.addIssue({
        code: 'custom',
        message: 'Ask only sends the question text and preserves other drafts.',
        path: ['askOnly'],
      })
    if (input.routeIntent === 'implicit' && input.route && input.route.type !== 'primary')
      context.addIssue({
        code: 'custom',
        message: 'Implicit routing must retain the original Primary intent.',
        path: ['routeIntent'],
      })
    if (input.replaceTask && (input.askOnly || input.replyToDecision || input.userInformation))
      context.addIssue({
        code: 'custom',
        message: 'A task replacement belongs to an explicit new Pact command only.',
        path: ['replaceTask'],
      })
    if (
      !input.content &&
      !input.inputId &&
      !input.imageIds?.length &&
      input.commentIds.length === 0 &&
      !input.freezeDrafts
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A message or Comment is required.',
        path: ['content'],
      })
    }
    if (input.inputId && input.content)
      context.addIssue({
        code: 'custom',
        message: 'Use either sealed input or inline content.',
        path: ['inputId'],
      })
    if (new Set(input.commentIds).size !== input.commentIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Comment IDs must be unique.',
        path: ['commentIds'],
      })
    }
  })
export type ConversationSendInput = z.infer<typeof conversationSendInputSchema>
const queuedCollaborationRouteSchema = z.union([
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('primary') }),
    z.strictObject({ type: z.literal('agent'), agentId: runtimeAgentIdSchema }),
    z.strictObject({ type: z.literal('all') }),
  ]),
  conversationMessageRouteSchema,
])

export const collaborationReceivedMetadataSchema = z.strictObject({
  steerSkillInvocation: collaborationDocumentSchema.optional(),
  replyIntentBasis: collaborationReplyIntentBasisSchema.optional(),
  workflowCommand: z.boolean().default(false),
  inTaskReview: z.boolean().optional(),
  routeIntent: z.enum(['implicit', 'explicit']).optional(),
  rolePolicy: z.literal('split-stages-v1').optional(),
  skills: skillSelectionsSchema.default([]),
  imageIds: conversationSendInputSchema.shape.imageIds.default([]),
  commentIds: conversationSendInputSchema.shape.commentIds,
  route: queuedCollaborationRouteSchema.optional(),
  replyToDecision: conversationSendInputSchema.shape.replyToDecision,
  replaceTask: conversationSendInputSchema.shape.replaceTask,
  batchId: conversationSendInputSchema.shape.batchId,
  freezeDrafts: conversationSendInputSchema.shape.freezeDrafts,
  originSideChat: originSideChatSchema.optional(),
})

export const peerProposalAcceptInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  proposalId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
})
export type PeerProposalAcceptInput = z.infer<typeof peerProposalAcceptInputSchema>

export const peerProposalDismissInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  proposalId: z.string().uuid(),
})
export type PeerProposalDismissInput = z.infer<typeof peerProposalDismissInputSchema>

export const conversationRetryInputSchema = z.strictObject({
  runId: z.string().uuid(),
  intent: z.literal('inspect').optional(),
  sessionId: z.string().uuid().optional(),
  agentId: runtimeAgentIdSchema.optional(),
})
export type ConversationRetryInput = z.infer<typeof conversationRetryInputSchema>

export const conversationStopInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  background: backgroundStopTargetSchema.optional(),
})
export type ConversationStopInput = z.infer<typeof conversationStopInputSchema>

export const nativeContextRebuildInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  clientOperationId: z.string().uuid().optional(),
  expectedGeneration: z.number().int().positive().optional(),
  expectedNativeSessionId: z.string().min(1).max(1024).optional(),
  expectedRunId: z.string().uuid().nullable().optional(),
  expectedRebuildId: z.string().uuid().nullable().optional(),
  abandon: z.boolean().optional(),
  intent: z.enum(['create', 'inspect', 'claim_input', 'discard_input']).optional(),
  expectedCommentsRevision: z.number().int().nonnegative().optional(),
})
export type NativeContextRebuildInput = z.infer<typeof nativeContextRebuildInputSchema>

export const nativeContextRebuildChunkSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    image: conversationImageSchema,
  }),
  z.strictObject({
    kind: z.literal('message'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    speaker: z.enum(['user', 'claude', 'codex', 'agy']),
    state: z.enum(['complete', 'incomplete']),
    part: z.number().int().nonnegative(),
    final: z.boolean(),
    content: z.string().max(64 * 1024),
  }),
  z.strictObject({
    kind: z.literal('comment'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    comment: anchoredCommentSummarySchema,
  }),
])
export type NativeContextRebuildChunk = z.infer<typeof nativeContextRebuildChunkSchema>

export const projectFileReadInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      input.lineStart === undefined ||
      input.lineEnd === undefined ||
      input.lineEnd >= input.lineStart,
    { message: 'Line range is invalid.', path: ['lineEnd'] },
  )
export type ProjectFileReadInput = z.infer<typeof projectFileReadInputSchema>

export const projectFileSchema = z.strictObject({
  sessionId: z.string().uuid(),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  isExternal: z.boolean().optional(),
  content: z.string(),
  contentHash: z.string().regex(/^[a-f\d]{64}$/iu),
  lineCount: z.number().int().nonnegative(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  updatedAt: z.string().datetime(),
})
export type ProjectFile = z.infer<typeof projectFileSchema>

export const workspaceChangeFilePreviewSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      changeSetId: z.string().uuid(),
      side: z.enum(['before', 'after', 'patch']),
      patchIndex: z.number().int().min(0).max(63).optional(),
      file: projectFileSchema,
      patchCount: z.number().int().min(0).max(64),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      changeSetId: z.string().uuid(),
      side: z.enum(['before', 'after', 'patch']),
      patchIndex: z.number().int().min(0).max(63).optional(),
      sessionId: z.string().uuid(),
      relativePath: z.string().min(1).max(4096),
      reason: z.enum([
        'not_recorded',
        'not_final',
        'blob_missing',
        'blob_corrupt',
        'too_large',
        'unsupported_encoding',
        'temporary_io',
      ]),
      patchCount: z.number().int().min(0).max(64),
    }),
  ])
  .refine(
    (preview) =>
      new TextEncoder().encode(JSON.stringify(preview)).byteLength <= WORKSPACE_PREVIEW_BYTES,
    'Saved preview exceeds its serialized byte limit.',
  )
export type WorkspaceChangeFilePreview = z.infer<typeof workspaceChangeFilePreviewSchema>

export const appearanceThemeSchema = z.enum(['system', 'light', 'dark'])
export type AppearanceTheme = z.infer<typeof appearanceThemeSchema>

export const windowMaterialSchema = z.enum(['system', 'solid', 'translucent'])
export type WindowMaterial = z.infer<typeof windowMaterialSchema>

export const MATERIAL_OPACITY_MIN = 70
export const MATERIAL_OPACITY_MAX = 100
export const materialOpacitySchema = z
  .number()
  .int()
  .min(MATERIAL_OPACITY_MIN)
  .max(MATERIAL_OPACITY_MAX)

export const appearanceSettingsSchema = z.object({
  theme: appearanceThemeSchema,
  windowMaterial: windowMaterialSchema,
  materialOpacity: materialOpacitySchema,
  revision: z.number().int().nonnegative(),
})
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>

export const appearanceSettingsUpdateSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    theme: appearanceThemeSchema.optional(),
    windowMaterial: windowMaterialSchema.optional(),
    materialOpacity: materialOpacitySchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.theme === undefined &&
      value.windowMaterial === undefined &&
      value.materialOpacity === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Appearance update must change at least one setting.',
      })
    }
  })
export type AppearanceSettingsUpdate = z.infer<typeof appearanceSettingsUpdateSchema>

export const appearanceSettingsResetSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
})
export type AppearanceSettingsReset = z.infer<typeof appearanceSettingsResetSchema>

export const appearanceFallbackReasonSchema = z.enum([
  'native_material_not_supported',
  'reduced_transparency',
  'high_contrast',
  'forced_colors',
  'native_material_initialization_failed',
])
export type AppearanceFallbackReason = z.infer<typeof appearanceFallbackReasonSchema>

export const appearanceEffectiveSettingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  windowMaterial: z.enum(['solid', 'translucent']),
  fallbackReason: appearanceFallbackReasonSchema.optional(),
  restartRequired: z.boolean().optional(),
  revision: z.number().int().nonnegative(),
})
export type AppearanceEffectiveSettings = z.infer<typeof appearanceEffectiveSettingsSchema>

export const appearanceSnapshotSchema = z.object({
  requested: appearanceSettingsSchema,
  effective: appearanceEffectiveSettingsSchema,
  projectionVersion: z.number().int().nonnegative(),
})
export type AppearanceSnapshot = z.infer<typeof appearanceSnapshotSchema>
