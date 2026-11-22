import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'

import type { ConversationImage } from '@pact/contracts/images'

import {
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_PAGE_BYTES,
  MAX_COMMENTS_PER_MESSAGE,
  type AgentRun,
  type AnchoredComment,
  type CollaborationDocument,
  type CollaborationInputBatchReference,
  type CollaborationReviewObservation,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type ConversationActivityChange,
  type ConversationMessageChange,
  type ConversationMessageRoute,
  type ConversationPatch,
  type FrozenSkillInvocation,
  type InitialTaskRolesProposal,
  type InputRoutingProposal,
  type NativeBackgroundReport,
  type NormalizedAgentEvent,
  type OriginSideChat,
  type PreparedInputMetadata,
  type RelayBasisV2,
  type RelayPlanReviewExtensionOperation,
  type RelayReassignRolesOperation,
  type RelaySource,
  type RuntimeAgentId,
  type SchedulingHandoff,
  type SkillSelection,
  type UserInformationDeclaration,
} from '@pact/contracts'

import { RunOperationConflictError } from '../conversation-errors.js'
import { outputSnapshotSummarySql } from '../conversation-output-snapshots.js'
import {
  agentRuns,
  type conversationImageAssets,
  type conversationInputBatchMembers,
} from '../schema/index.js'

export { RunOperationConflictError } from '../conversation-errors.js'

/** Read only root result identity, with bounded stack/key/scalar memory. */

export const activeRunStatuses = ['starting', 'running', 'recovering'] as const

export const INLINE_CONTENT_BYTES = CONVERSATION_MARKDOWN_BYTES

export const BODY_PREVIEW_CHARS = 2_048

export const BODY_CHUNK_CHARS = 16_000

export const MAX_OBSERVED_SESSIONS = 1_024

export const HANDOFF_PAGE_ITEMS = 25

export const HANDOFF_PAGE_BYTES = CONVERSATION_PAGE_BYTES

export const HANDOFF_SOURCE_IDS_BYTES = 512 * 1024

export const NATIVE_REBUILD_PAGE_ITEMS = 25

export const NATIVE_REBUILD_CHUNK_CHARS = 64 * 1024

export const HANDOFF_SAFETY_BYTES = 8 * 1024 * 1024

export const HANDOFF_READ_DEADLINE_MS = 10_000

export const publicRunColumns = {
  workflowTaskId: sql<
    string | null
  >`(SELECT w.task_id FROM workflow_turns w WHERE w.run_id = ${agentRuns.id})`,
  collaborationPlanVersion: sql<
    number | null
  >`(SELECT json_extract(w.state_json, '$.planReference.version') FROM workflow_turns w WHERE w.run_id = ${agentRuns.id} AND w.applied = 1 AND json_extract(w.state_json, '$.planReference.sourceRunId') = ${agentRuns.id})`,
  collaborationTaskId: agentRuns.collaborationTaskId,
  collaborationKind: agentRuns.collaborationKind,
  collaborationStage: agentRuns.collaborationStage,
  id: agentRuns.id,
  sessionId: agentRuns.sessionId,
  userMessageId: agentRuns.userMessageId,
  agentId: agentRuns.agentId,
  status: agentRuns.status,
  attemptCount: agentRuns.attemptCount,
  settingsRevision: agentRuns.settingsRevision,
  permissionMode: agentRuns.permissionMode,
  model: agentRuns.model,
  effort: agentRuns.effort,
  speed: agentRuns.speed,
  observedSpeed: agentRuns.observedSpeed,
  speedDetail: agentRuns.speedDetail,
  nativeSessionId: agentRuns.nativeSessionId,
  nativeTurnId: agentRuns.nativeTurnId,
  forkSourceRunId: agentRuns.forkSourceRunId,
  bindingGeneration: agentRuns.bindingGeneration,
  executorId: agentRuns.executorId,
  controlDisposition: agentRuns.controlDisposition,
  dispatchPhase: agentRuns.dispatchPhase,
  nativeOutcome: agentRuns.nativeOutcome,
  responseMessageId: sql<
    string | null
  >`(SELECT id FROM conversation_messages WHERE run_id = "agent_runs"."id" AND role = 'assistant' ORDER BY sequence DESC LIMIT 1)`,
  // Keep the outer identity qualified inside correlated projection subqueries.
  outputSnapshotsJson: outputSnapshotSummarySql(sql`"agent_runs"."id"`),
  nativeEffectsState: agentRuns.nativeEffectsState,
  nativeEffectsReason: agentRuns.nativeEffectsReason,
  workspaceRecordingUnavailableReason: agentRuns.workspaceRecordingUnavailableReason,
  reexecutedFromRunId: agentRuns.reexecutedFromRunId,
  reexecutionOperationId: agentRuns.reexecutionOperationId,
  failureKind: agentRuns.failureKind,
  failureMessage: agentRuns.failureMessage,
  handoffMessageCount: agentRuns.handoffMessageCount,
  peerProposalId: agentRuns.peerProposalId,
  peerProposalTargetAgentId: agentRuns.peerProposalTargetAgentId,
  peerProposalKind: agentRuns.peerProposalKind,
  peerProposalReason: agentRuns.peerProposalReason,
  peerProposalState: agentRuns.peerProposalState,
  peerProposalAcceptedMessageId: agentRuns.peerProposalAcceptedMessageId,
  workspaceChangesJson: agentRuns.workspaceChangesJson,
  createdAt: agentRuns.createdAt,
  updatedAt: agentRuns.updatedAt,
}

/** Closed refusal metadata; it never changes information admission or fallback. */
export class PreparedInformationConflictError extends RunOperationConflictError {
  constructor(
    readonly informationAdviceRefusal: 'missing_field' | 'unavailable_field' | 'field_mismatch',
  ) {
    super('The input clarification is no longer current.')
  }
}

export class CommentLimitError extends Error {
  constructor() {
    super(`A message can include at most ${MAX_COMMENTS_PER_MESSAGE} Comments.`)
  }
}

export const visibleWorkspaceArtifact = or(
  and(
    isNotNull(agentRuns.workspaceChangesJson),
    sql`json_extract(${agentRuns.workspaceChangesJson}, '$.fileCount') > 0`,
    or(
      sql`json_extract(${agentRuns.workspaceChangesJson}, '$.finalizedAt') IS NOT NULL`,
      eq(agentRuns.dispatchPhase, 'ended'),
    ),
  ),
  and(
    isNotNull(agentRuns.workspaceRecordingUnavailableReason),
    inArray(agentRuns.status, ['completed', 'failed', 'interrupted']),
  ),
)

export class HandoffSourceUnavailableError extends Error {
  constructor(message = 'The required Agent context could not be read safely.') {
    super(message)
  }
}

export class HandoffTooLargeError extends Error {
  constructor(message = 'The required Agent context is too large to send.') {
    super(message)
  }
}

export interface HandoffBundle {
  inputBatchRef?: { id: string; revision: number; memberCount: number }
  messageId: string
  sequence: number
  contentRevision: number
  digest: string
  contextVersion?: 'native_workflow_v1'
  speaker: 'user' | RuntimeAgentId
  handledBy: RuntimeAgentId
  content: string
  comments: Array<Pick<AnchoredComment, 'id' | 'body' | 'anchor'>>
  images?: ConversationImage[]
}

export interface HandoffSourceRef {
  id: string
  revision: number
  digest: string
  contextVersion?: 'native_workflow_v1'
}

export interface InputBatchReference {
  id: string
  sessionId: string
  taskId?: string
  sequence: number
  memberCount: number
  commentsRevision: number
  revision: number
}

export type FrozenCollaborationAuthorization = CollaborationTurnAuthorization

export interface FrozenInputBatchPage {
  batch: InputBatchReference
  members: Array<{
    memberId: string
    ordinal: number
    commentId: string
    revision: number
    anchorDocument: CollaborationDocument
    body: CollaborationDocument
    state: typeof conversationInputBatchMembers.$inferSelect.state
    answerResolver?: RuntimeAgentId
  }>
  hasMore: boolean
  nextOrdinal: number
  body: CollaborationDocument | undefined
  userInformation: CollaborationDocument | undefined
  clarificationAnswer: CollaborationDocument | undefined
}

export interface WorkflowInputsPage {
  items: Array<{
    sequence: number
    messageId: string | null
    batch: CollaborationInputBatchReference
    body?: CollaborationDocument
  }>
  offset: number
  nextOffset: number | null
}

export interface RunSourcesPage {
  runId: string
  items: Array<{
    messageId: string
    revision: number
    documents: Array<{ key: string; source: CollaborationDocument }>
    inputBatchRef?: InputBatchReference
  }>
  offset: number
  nextOffset: number | null
}

export const COLLABORATION_INDEX_ITEMS = 24

export const COLLABORATION_INDEX_BYTES = 48 * 1024

export interface HandoffRow {
  id: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  contentBytes: number
  contentRevision: number
  handledBy: RuntimeAgentId
}

export class StaleConversationCursorError extends Error {
  constructor() {
    super('Conversation data changed. Try again.')
  }
}

export class OversizedConversationEntityError extends Error {
  constructor(
    message = 'This saved Conversation item exceeds the 1 MiB page limit. It was not truncated.',
  ) {
    super(message)
  }
}

export type ConversationInputWrite =
  | { type: 'begin'; sessionId: string; clientMessageId: string }
  | { type: 'append'; sessionId: string; inputId: string; offset: number; text: string }
  | { type: 'seal'; sessionId: string; inputId: string }
  | { type: 'release'; sessionId: string; inputId: string }

export interface ConversationInputReceipt {
  inputId: string
  offset: number
  sealed: boolean
  bytes: number
  chars: number
}

export type CompleteAnswerMetadata = Omit<
  Extract<NormalizedAgentEvent, { type: 'text.completed' }>,
  'text'
>

export type ImageAssetRecord = typeof conversationImageAssets.$inferSelect

export type BackgroundReportIdentity = Omit<NativeBackgroundReport, 'text'>

export interface SealedBodyFact {
  version: 1
  inputId: string
  sha256: string
  bytes: number
  chars: number
}

export const BODY_PART_UNITS = 8192

export const BODY_TEMP_TTL_MS = 10 * 60 * 1000

export const BODY_APP_STORAGE_BYTES = 1024 * 1024 * 1024

export const BODY_OWNER_STORAGE_BYTES = 256 * 1024 * 1024

export const BODY_OWNER_INPUTS = 512

export const BODY_INPUT_PARTS = 8192

export const BODY_OWNER_PARTS = 32_768

export const BODY_APP_PARTS = 131_072

export const BODY_INTERNAL_READ_BYTES = 8 * 1024 * 1024

export interface RelayWorkflowTurnSource {
  taskId: string
  runId: string
  actor: RuntimeAgentId
  stage: CollaborationTask['stage']
  inputSequence: number
  ordinal: number
  sourceId: string
  document: CollaborationDocument
  messageId: string
  sourceRevision: number
  inReplyToRunId: string | null
  verdict: CollaborationReviewObservation['verdict'] | null
  planSha256: string | null
  scopeId: string
}

export interface RelayWorkflowAlternativeBase {
  taskId: string
  afterRunId: string
  actor: RuntimeAgentId
  returnActor: RuntimeAgentId
  inputSequence: number
  sourceFingerprint: string
  budgetAvailable: true
}

export type RelayWorkflowAlternative = RelayWorkflowAlternativeBase &
  (
    | { kind: 'reassign_roles'; operation: RelayReassignRolesOperation }
    | { kind: 'extend_plan_review'; operation: RelayPlanReviewExtensionOperation }
  )

export interface RelayWorkflowSnapshot {
  task: CollaborationTask
  basis: Extract<RelayBasisV2, { kind: 'workflow' }>
  node:
    | 'plan_to_review'
    | 'plan_review_to_owner'
    | 'owner_to_review'
    | 'execution_to_review'
    | 'code_review_to_next'
    | 'plan_ready'
    | 'plan_review_limit'
  producer: RelayWorkflowTurnSource
  reviews: RelayWorkflowTurnSource[]
  responses: RelayWorkflowTurnSource[]
  sources: RelaySource[]
  sourceGrants: Array<{
    messageId: string
    revision: number
    sourceRunId: string
    document: CollaborationDocument
  }>
  sourceActors: Record<string, RuntimeAgentId | null>
  planSourceId: string | null
  scopeSourceId: string
  processedDecision: {
    sourceId: string
    afterReviewRunId: string
    inputSequence: number
    incorporatedPlanSha256: string
  } | null
  retainedPlanSha256: string | null
  sourceFingerprint: string
}

export interface BeginRunInput {
  userInformation?: UserInformationDeclaration | undefined
  collaborationActionReceiptId?: string | undefined
  preparedInput?: PreparedInputDispatch | undefined
  inputRouting?: InputRoutingProposal | undefined
  initialTaskRoles?: InitialTaskRolesProposal | undefined
  schedulingHandoff?: SchedulingHandoff | undefined
  replyToDecision?: import('@pact/contracts').ConversationSendInput['replyToDecision'] | undefined
  replaceTask?: import('@pact/contracts').ConversationSendInput['replaceTask'] | undefined
  inputBatchId?: string
  batchId?: string | undefined
  freezeDrafts?: boolean | undefined
  receivedInputId?: string | undefined
  collaboration?: CollaborationTask | undefined
  expectedCollaborationRevision?: number | undefined
  sessionId: string
  clientMessageId: string
  skills?: SkillSelection[] | undefined
  skillInvocation?: FrozenSkillInvocation | undefined
  returnedInputOperationId?: string | undefined
  queueReturnOperationId?: string | undefined
  content: string
  imageIds?: string[] | undefined
  imageOwnerKey?: string | undefined
  expectedCommentsRevision: number
  commentIds: string[]
  agentId: RuntimeAgentId
  settingsRevision: number
  model: string | null
  effort: string | null
  route?: ConversationMessageRoute | { type: 'primary' } | { type: 'all' } | undefined
  sourceMessageId?: string
  sourceProposalId?: string
  preserveDraftComments?: boolean
  suggestedTitle?: string
  handoffSourceRefs?: HandoffSourceRef[]
  originSideChat?: OriginSideChat | undefined
  syncMainOperationId?: string | undefined
}

export interface PreparedInputDispatch {
  batchId: string
  sessionId: string
  clientMessageId: string
  recipient: null
  metadata: PreparedInputMetadata
}

export interface PreparedInputSource {
  id: string
  kind: 'input' | 'comment' | 'anchor' | 'message' | 'document' | 'declaration'
  identity: string
  sha256: string
  bytes: number
  roles: Array<'input' | 'comment' | 'anchor' | 'anchor_target'>
  actor: RuntimeAgentId | null
  revision?: number
  document?: CollaborationDocument
}

export interface BeginRunResult {
  run: AgentRun
  patch: ConversationPatch
  created: boolean
}

export interface BeginRoutedContinuationInput {
  sessionId: string
  userMessageId: string
  agentId: RuntimeAgentId
  settingsRevision: number
  model: string | null
  effort: string | null
  handoffSourceRefs?: HandoffSourceRef[]
}

export interface PatchInput {
  runContexts?: ConversationPatch['runContexts']
  commentDraftReceipt?: ConversationPatch['commentDraftReceipt']
  receivedInputIds?: ConversationPatch['receivedInputIds']
  queuedInputIds?: ConversationPatch['queuedInputIds']
  messages?: ConversationMessageChange[]
  removedMessageIds?: string[]
  runs?: AgentRun[]
  activities?: ConversationActivityChange[]
  activityStates?: ConversationPatch['activityStates']
  comments?: ConversationPatch['comments']
  resync?: ConversationPatch['resync']
}

export interface EventChanges {
  snapshotMessageId?: string | undefined
  removedMessageIds?: string[]
  message?:
    | {
        id: string
        mode: ConversationMessageChange['mode']
        text?: string
        previousRevision?: number
      }
    | undefined
  activity?:
    | {
        id: string
        mode: ConversationActivityChange['mode']
        detail?: string
        previousRevision?: number
      }
    | undefined
  activityStates: ConversationPatch['activityStates']
}

export type StreamDeltaEvent = Extract<
  NormalizedAgentEvent,
  { type: 'text.delta' | 'reasoning.summary.delta' }
>
