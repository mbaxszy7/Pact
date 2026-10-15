import {
  getTableColumns,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  notInArray,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import type {
  AgentActivity,
  AgentRun,
  AnchoredComment,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  ConversationMessage,
  ConversationMessageRoute,
  ConversationMessageChange,
  ConversationActivityChange,
  ConversationGetInput,
  ConversationObservation,
  ConversationPage,
  ConversationPatch,
  ConversationSnapshot,
  NativeAgentContext,
  NativeContextRebuildChunk,
  NormalizedAgentEvent,
  RunFailureKind,
  RuntimeAgentId,
  WorkspaceChangeSet,
  NativeProbeResult,
  NativeRecoveredOutput,
  NativeContinuationState,
  NativeRebuildOperation,
  NativeInitializationWitness,
  RebuildReturnedInputRecord,
  RebuildInputRecovery,
  WorkspaceArchiveScope,
} from '@pact/contracts'

import {
  collaborationTaskSchema,
  collaborationSubmission,
  collaborationEnvelopeSchema,
  collaborationReceivedMetadataSchema,
  collaborationResultSchema,
  collaborationViewSchema,
  settleCollaboration,
  collaborationDocumentSchema,
  collaborationMarkdownNodeSchema,
  collaborationMarkdownTreeWithinBudget,
  type CollaborationMarkdownNode,
  type CollaborationDocument,
  type CollaborationTask,
  type CollaborationResult,
  collaborationTodoDeltaSchema,
  collaborationInputResponseSchema,
  collaborationTodoQuestionSchema,
  type CollaborationTodoDelta,
  type CollaborationInputResponse,
  type CollaborationTodo,
  type CollaborationTodoPage,
  type CollaborationTurnAuthorization,
  type CollaborationInputBatchReference,
  collaborationTurnAuthorizationSchema,
} from '@pact/contracts'
import {
  frozenSkillInvocationSchema,
  skillSelectionsSchema,
  type FrozenSkillInvocation,
  type SkillSelection,
} from '@pact/contracts'
import {
  commentAnchorSchema,
  conversationPatchSchema,
  conversationStreamDeltaKey,
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_PAGE_BYTES,
  CONVERSATION_PAGE_ITEMS,
  CONVERSATION_PATCH_BYTES,
  CONVERSATION_PATCH_TEXT_BYTES,
  CONVERSATION_PATCH_ACTIVITY_ITEMS,
  CONVERSATION_STREAM_BATCH_ITEMS,
  CONVERSATION_STREAM_BATCH_BYTES,
  CONVERSATION_WORK_LOG_ITEMS,
  MAX_COMMENTS_PER_MESSAGE,
  workspaceChangeSetSchema,
  nativePermissionRequestSchema,
  NATIVE_PERMISSION_REQUESTS,
  nativeProbeResultSchema,
  nativeEvidenceIdentitySchema,
  nativeInitializationWitnessSchema,
  nativeContextRebuildChunkSchema,
  rebuildReturnedInputRecordSchema,
} from '@pact/contracts'
import {
  conversationImageSchema,
  IMAGE_REFERENCE_ITEMS,
  IMAGE_ORIGINAL_WORK_BYTES,
  type ConversationImage,
} from '@pact/contracts/images'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appendAgentEvent } from './agent-event-journal.js'
import * as forkFacts from './conversation-fork.js'
import {
  nativeSessionIssueMetadata,
  refreshNativeSessionMetadata,
} from './native-presence-metadata.js'
import {
  collaborationInputs,
  collaborationTasks,
  collaborationTurns,
  collaborationReportItems,
  collaborationMarkdownPages,
  collaborationTodos,
  collaborationTodoRevisions,
  collaborationTurnAuthorizations,
  collaborationRequiredInputMembers,
  conversationRunSourceRefs,
  conversationRebuildSourceRefs,
  collaborationReviewFacts,
  collaborationResultApplications,
  collaborationResultOperations,
  collaborationResultInputResponses,
  conversationInputBatches,
  conversationInputBatchMembers,
  agentEventJournal,
  agentRunActivities,
  agentRuns,
  anchoredComments,
  commentDraftReceipts,
  conversationMessages,
  conversationImageAssets,
  conversationMessageImages,
  conversationBodyInputs,
  conversationBodyParts,
  nativeAgentContexts,
  nativeRebuildOperations,
  nativeForkIntents,
  sessionForkOperations,
  sessions,
  sessionSettingsRevisions,
  workspaceChangeSets,
  workspaceFileChanges,
} from './schema/index.js'
import {
  deriveSessionActivity,
  hasUnreadSessionMessage,
  projectSessionTitle,
} from './session-projection.js'
import {
  WorkspaceArchiveRepository,
  assertSessionAvailable,
} from './workspace-archive-repository.js'

const activeRunStatuses = ['starting', 'running', 'recovering'] as const
const INLINE_CONTENT_BYTES = CONVERSATION_MARKDOWN_BYTES
const BODY_PREVIEW_CHARS = 2_048
const BODY_CHUNK_CHARS = 16_000
const MAX_OBSERVED_SESSIONS = 1_024
const HANDOFF_PAGE_ITEMS = 25
const HANDOFF_PAGE_BYTES = CONVERSATION_PAGE_BYTES
const HANDOFF_SOURCE_IDS_BYTES = 512 * 1024
const NATIVE_REBUILD_PAGE_ITEMS = 25
const NATIVE_REBUILD_CHUNK_CHARS = 64 * 1024
export const HANDOFF_SAFETY_BYTES = 8 * 1024 * 1024
export const HANDOFF_READ_DEADLINE_MS = 10_000

const publicRunColumns = {
  answerFormat: agentRuns.answerFormat,
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

export class CommentLimitError extends Error {
  constructor() {
    super(`A message can include at most ${MAX_COMMENTS_PER_MESSAGE} Comments.`)
  }
}

const visibleWorkspaceArtifact = or(
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

export class RunOperationConflictError extends Error {}

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
  contextVersion?: 'collaboration_v1' | 'collaboration_v2'
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
  contextVersion?: 'collaboration_v1' | 'collaboration_v2'
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

const COLLABORATION_INDEX_ITEMS = 24
const COLLABORATION_INDEX_BYTES = 48 * 1024

interface HandoffRow {
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

interface SealedBodyFact {
  version: 1
  inputId: string
  sha256: string
  bytes: number
  chars: number
}

const BODY_PART_UNITS = 8192
const BODY_TEMP_TTL_MS = 10 * 60 * 1000
const BODY_APP_STORAGE_BYTES = 1024 * 1024 * 1024
const BODY_OWNER_STORAGE_BYTES = 256 * 1024 * 1024
const BODY_OWNER_INPUTS = 512
const BODY_INPUT_PARTS = 8192
const BODY_OWNER_PARTS = 32_768
const BODY_APP_PARTS = 131_072
const BODY_INTERNAL_READ_BYTES = 8 * 1024 * 1024

function validBodyText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function storedObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RunOperationConflictError('The stored structured source is invalid.')
  return Object.fromEntries(Object.entries(value))
}

function storedDocuments(text: string): Array<{ key: string; source: CollaborationDocument }> {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value))
    throw new RunOperationConflictError('The frozen source manifest is invalid.')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || typeof Reflect.get(item, 'key') !== 'string')
      throw new RunOperationConflictError('The frozen source entry is invalid.')
    return {
      key: String(Reflect.get(item, 'key')),
      source: collaborationDocumentSchema.parse(Reflect.get(item, 'source')),
    }
  })
}

function todoAnswerSource(anchor: Extract<AnchoredComment['anchor'], { type: 'todo' }>) {
  const { question, ...source } = anchor
  return question
    ? { ...source, question: { id: question.id, revision: question.revision } }
    : source
}

function todoProjectionBytes(title: SQLWrapper, question: SQLWrapper) {
  return sql<number>`4096 + coalesce(length(CAST(${question} AS BLOB)),0) + 6 * length(CAST(${title} AS BLOB))`
}

function admittedTodoOrdinal(
  rows: ReadonlyArray<{ ordinal: number; bytes: number }>,
  budget: number,
): number {
  let used = 0,
    last = -1
  for (const row of rows.slice(0, COLLABORATION_INDEX_ITEMS)) {
    if (row.bytes > budget && last === -1)
      throw new OversizedConversationEntityError(
        'This question cannot fit the page read budget. Its complete definition remains saved; no answer was submitted.',
      )
    if (used + row.bytes > budget) break
    used += row.bytes
    last = row.ordinal
  }
  return last
}

export interface BeginRunInput {
  inputBatchId?: string
  batchId?: string | undefined
  freezeDrafts?: boolean | undefined
  receivedInputId?: string | undefined
  collaboration?: CollaborationTask | undefined
  sessionId: string
  clientMessageId: string
  skills?: SkillSelection[] | undefined
  skillInvocation?: FrozenSkillInvocation | undefined
  returnedInputOperationId?: string | undefined
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

interface PatchInput {
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

interface EventChanges {
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

export class ConversationRepository {
  private readonly observations = new Map<string, ConversationObservation>()
  private completeReadCount = 0
  private pageReadCount = 0
  private patchCount = 0
  private eventTransactionCount = 0
  private readonly streamLookups = {
    text: { queries: 0, returnedRows: 0 },
    activity: { queries: 0, returnedRows: 0 },
  }

  readonly archives: WorkspaceArchiveRepository

  constructor(private readonly database: PactDrizzleDatabase) {
    this.archives = new WorkspaceArchiveRepository(database)
    // Utility owns one Repository instance. A new owner cannot reuse earlier window handles.
    this.database
      .delete(conversationBodyInputs)
      .where(
        and(
          isNull(conversationBodyInputs.committedMessageId),
          isNull(conversationBodyInputs.pendingReceiptId),
          or(
            isNull(conversationBodyInputs.sourceRunId),
            eq(conversationBodyInputs.purpose, 'answer'),
          ),
        ),
      )
      .run()
  }

  nativeIssueMetadata(sessionId: string): import('@pact/contracts').SessionIssues {
    return nativeSessionIssueMetadata(this.database, sessionId).issues
  }

  nativeRunStatus(runId: string): AgentRun['status'] | undefined {
    return this.database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .get()?.status
  }

  refreshNativeAttention(sessionId: string): void {
    refreshNativeSessionMetadata(this.database, sessionId)
  }

  private nativeMetadataTransaction<T>(
    sessionId: string,
    work: (transaction: PactDrizzleDatabase) => T,
  ): T {
    return this.database.transaction((transaction) => {
      const value = work(transaction)
      refreshNativeSessionMetadata(transaction, sessionId)
      return value
    })
  }

  initializeNativeAttention(sessionIds: string[]): void {
    if (sessionIds.length > 25)
      throw new Error('Native metadata initialization page exceeds its bound.')
    this.database.transaction(() => {
      for (const sessionId of sessionIds) this.refreshNativeAttention(sessionId)
    })
  }

  nativeQuitUnsettled(excludedIds: string[]): { count: number; sessionIds: string[] } {
    if (excludedIds.length > 64) throw new Error('Native quit owner metadata exceeds its bound.')
    const excluded = excludedIds.length
      ? sql`WHERE session_id NOT IN (${sql.join(
          excludedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``
    const work = sql`WITH work(session_id) AS (
      SELECT session_id FROM agent_runs WHERE fork_source_run_id IS NULL AND ((status IN ('starting', 'running', 'recovering') AND control_disposition <> 'abandoned') OR native_effects_state IN ('pending', 'unknown') OR (dispatch_phase IN ('possibly_sent', 'accepted', 'ended') AND native_outcome IS NULL))
      UNION SELECT session_id FROM native_agent_contexts WHERE continuation_state IN ('responding', 'waiting_user')
      UNION SELECT session_id FROM native_rebuild_operations WHERE native_work_state IN ('pending', 'unknown')
      UNION SELECT coalesce(f.session_id, f.source_session_id) FROM native_fork_intents i JOIN session_fork_operations f ON f.id=i.operation_id WHERE i.native_work_state IN ('pending', 'unknown')
    )`
    const count =
      this.database.get<{ count: number }>(
        sql`${work} SELECT count(*) AS count FROM work ${excluded}`,
      )?.count ?? 0
    const rows = this.database.all<{ sessionId: string }>(
      sql`${work} SELECT session_id AS sessionId FROM work ${excluded} ORDER BY session_id LIMIT 5`,
    )
    return { count, sessionIds: rows.map((row) => row.sessionId) }
  }

  imageRecord(id: string): ImageAssetRecord | undefined {
    return this.database
      .select()
      .from(conversationImageAssets)
      .where(eq(conversationImageAssets.id, id))
      .get()
  }

  beginImage(
    sessionId: string,
    clientImageId: string,
    name: string,
    ownerKey: string,
  ): ImageAssetRecord {
    return this.database.transaction(() => {
      const existing = this.imageRecord(clientImageId)
      if (existing) {
        if (
          existing.ownerSessionId !== sessionId ||
          existing.ownerKey !== ownerKey ||
          existing.name !== name
        )
          throw new RunOperationConflictError('This image ID belongs to a different input.')
        return existing
      }
      if (
        !this.database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get()
      )
        throw new RunOperationConflictError('The image Session is unavailable.')
      this.assertImageCapacity(ownerKey, 0, true)
      const count = this.database
        .select({ value: sql<number>`count(*)` })
        .from(conversationImageAssets)
        .where(
          and(
            eq(conversationImageAssets.ownerKey, ownerKey),
            eq(conversationImageAssets.committed, false),
          ),
        )
        .get()!.value
      if (count >= BODY_OWNER_INPUTS)
        throw new RunOperationConflictError(
          'This window has too many prepared images. Remove an unused image and try again.',
        )
      const now = new Date().toISOString()
      this.database
        .insert(conversationImageAssets)
        .values({
          id: clientImageId,
          ownerKey,
          ownerSessionId: sessionId,
          name,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return this.imageRecord(clientImageId)!
    })
  }

  /** Indexed uncommitted storage only: durable image history never enters upload admission. */
  assertImageCapacity(ownerKey: string, addedBytes: number, newIdentity = false): void {
    if (!Number.isSafeInteger(addedBytes) || addedBytes < 0)
      throw new RunOperationConflictError('Invalid image upload size.')
    const global = this.database.get<{ bytes: number; count: number }>(sql`
      SELECT coalesce(sum(bytes + thumbnail_bytes), 0) AS bytes, count(*) AS count
      FROM conversation_image_assets INDEXED BY conversation_image_assets_temp_idx WHERE committed=0
    `)
    const owner = this.database
      .select({
        bytes: sql<number>`coalesce(sum(${conversationImageAssets.bytes} + ${conversationImageAssets.thumbnailBytes}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(conversationImageAssets)
      .where(
        and(
          eq(conversationImageAssets.ownerKey, ownerKey),
          eq(conversationImageAssets.committed, false),
        ),
      )
      .get()!
    if (
      global.bytes + addedBytes > BODY_APP_STORAGE_BYTES ||
      global.count + (newIdentity ? 1 : 0) > BODY_OWNER_INPUTS ||
      owner.bytes + addedBytes > BODY_OWNER_STORAGE_BYTES ||
      owner.count > BODY_OWNER_INPUTS
    )
      throw new RunOperationConflictError(
        'Prepared image storage is full. Remove an unused image and try again.',
      )
  }

  private ownedTemporaryImage(id: string, sessionId: string, ownerKey: string): ImageAssetRecord {
    const image = this.imageRecord(id)
    if (
      !image ||
      image.ownerSessionId !== sessionId ||
      image.ownerKey !== ownerKey ||
      image.committed
    )
      throw new RunOperationConflictError('This prepared image belongs to another owner.')
    return image
  }

  advanceImage(
    id: string,
    sessionId: string,
    ownerKey: string,
    expectedOffset: number,
    nextOffset: number,
  ): ImageAssetRecord {
    return this.database.transaction(() => {
      const image = this.ownedTemporaryImage(id, sessionId, ownerKey)
      if (
        image.ready ||
        image.bytes !== expectedOffset ||
        !Number.isSafeInteger(nextOffset) ||
        nextOffset <= expectedOffset ||
        nextOffset > IMAGE_ORIGINAL_WORK_BYTES
      )
        throw new RunOperationConflictError(
          'The image upload offset is invalid or the image is already sealed.',
        )
      this.assertImageCapacity(ownerKey, nextOffset - expectedOffset)
      this.database
        .update(conversationImageAssets)
        .set({ bytes: nextOffset, updatedAt: new Date().toISOString() })
        .where(eq(conversationImageAssets.id, id))
        .run()
      return this.imageRecord(id)!
    })
  }

  sealImage(
    id: string,
    sessionId: string,
    ownerKey: string,
    meta: ConversationImage,
    thumbnailBytes: number,
  ): ConversationImage {
    return this.database.transaction(() => {
      const image = this.ownedTemporaryImage(id, sessionId, ownerKey)
      const parsed = conversationImageSchema.parse(meta)
      if (
        image.id !== parsed.id ||
        image.name !== parsed.name ||
        image.bytes !== parsed.bytes ||
        !Number.isSafeInteger(thumbnailBytes) ||
        thumbnailBytes < 0
      )
        throw new RunOperationConflictError('The image upload does not match its verified file.')
      if (image.ready) {
        if (
          JSON.stringify(this.publicImage(image)) !== JSON.stringify(parsed) ||
          image.thumbnailBytes !== thumbnailBytes
        )
          throw new RunOperationConflictError('A sealed image is immutable.')
        return parsed
      }
      this.assertImageCapacity(ownerKey, thumbnailBytes)
      this.database
        .update(conversationImageAssets)
        .set({
          ready: true,
          mediaType: parsed.mediaType,
          width: parsed.width,
          height: parsed.height,
          sha256: parsed.sha256,
          thumbnailBytes,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(conversationImageAssets.id, id))
        .run()
      return parsed
    })
  }

  releaseImage(id: string, sessionId: string, ownerKey: string): boolean {
    const image = this.imageRecord(id)
    if (!image) return true
    if (image.committed) return false
    if (image.ownerSessionId !== sessionId || image.ownerKey !== ownerKey)
      throw new RunOperationConflictError('This image belongs to another owner.')
    this.database
      .delete(conversationImageAssets)
      .where(and(eq(conversationImageAssets.id, id), eq(conversationImageAssets.committed, false)))
      .run()
    return true
  }

  /** Cleanup is paged. The file owner releases this batch before requesting the next. */
  temporaryImages(ownerKey?: string, restart = false): ImageAssetRecord[] {
    return this.database
      .select()
      .from(conversationImageAssets)
      .where(
        and(
          eq(conversationImageAssets.committed, false),
          ownerKey === undefined
            ? restart
              ? undefined
              : lt(
                  conversationImageAssets.updatedAt,
                  new Date(Date.now() - BODY_TEMP_TTL_MS).toISOString(),
                )
            : eq(conversationImageAssets.ownerKey, ownerKey),
        ),
      )
      .orderBy(asc(conversationImageAssets.updatedAt), asc(conversationImageAssets.id))
      .limit(BODY_OWNER_INPUTS)
      .all()
  }

  private publicImage(row: ImageAssetRecord): ConversationImage {
    if (!row.ready) throw new RunOperationConflictError('The image upload is not complete.')
    return conversationImageSchema.parse({
      id: row.id,
      name: row.name,
      bytes: row.bytes,
      mediaType: row.mediaType,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
    })
  }

  private imagesForMessages(messageIds: string[]): Map<string, ConversationImage[]> {
    const result = new Map<string, ConversationImage[]>()
    if (!messageIds.length) return result
    // Every production caller supplies one Patch or one <=25-item page.
    const rows = this.database
      .select({
        messageId: conversationMessageImages.messageId,
        image: getTableColumns(conversationImageAssets),
      })
      .from(conversationMessageImages)
      .innerJoin(
        conversationImageAssets,
        eq(conversationImageAssets.id, conversationMessageImages.imageId),
      )
      .where(inArray(conversationMessageImages.messageId, messageIds))
      .orderBy(asc(conversationMessageImages.messageId), asc(conversationMessageImages.ordinal))
      .limit(messageIds.length * IMAGE_REFERENCE_ITEMS + 1)
      .all()
    for (const row of rows) {
      const images = result.get(row.messageId) ?? []
      if (images.length >= IMAGE_REFERENCE_ITEMS)
        throw new RunOperationConflictError(
          'Saved image references exceed their metadata capacity.',
        )
      images.push(this.publicImage(row.image))
      result.set(row.messageId, images)
    }
    return result
  }

  imagesForMessage(messageId: string, sessionId?: string): ConversationImage[] {
    if (
      sessionId !== undefined &&
      !this.database
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, messageId),
            eq(conversationMessages.sessionId, sessionId),
          ),
        )
        .get()
    )
      return []
    return this.imagesForMessages([messageId]).get(messageId) ?? []
  }

  private messageImageMetadata(messageId: string): Pick<ConversationMessage, 'images'> {
    const images = this.imagesForMessage(messageId)
    return images.length ? { images } : {}
  }

  imageAccessible(sessionId: string, id: string, ownerKey?: string): boolean {
    const image = this.imageRecord(id)
    if (!image?.ready) return false
    if (image.pendingReceiptId) return image.ownerSessionId === sessionId
    if (!image.committed) return image.ownerSessionId === sessionId && image.ownerKey === ownerKey
    return Boolean(
      this.database
        .select({ id: conversationMessageImages.imageId })
        .from(conversationMessageImages)
        .innerJoin(
          conversationMessages,
          eq(conversationMessages.id, conversationMessageImages.messageId),
        )
        .where(
          and(
            eq(conversationMessageImages.imageId, id),
            eq(conversationMessages.sessionId, sessionId),
          ),
        )
        .limit(1)
        .get(),
    )
  }

  resolveMessageImages(sessionId: string, ids: string[], ownerKey?: string): ConversationImage[] {
    if (ids.length > IMAGE_REFERENCE_ITEMS || new Set(ids).size !== ids.length)
      throw new RunOperationConflictError(
        'Image references are invalid or exceed their metadata capacity.',
      )
    return ids.map((id) => {
      if (!this.imageAccessible(sessionId, id, ownerKey))
        throw new RunOperationConflictError(
          'An image is unavailable or belongs to another Session.',
        )
      return this.publicImage(this.imageRecord(id)!)
    })
  }

  sweepConversationInputs(ownerKey?: string): void {
    this.database
      .delete(conversationBodyInputs)
      .where(
        and(
          isNull(conversationBodyInputs.committedMessageId),
          isNull(conversationBodyInputs.pendingReceiptId),
          isNull(conversationBodyInputs.sourceRunId),
          ownerKey === undefined
            ? lt(
                conversationBodyInputs.updatedAt,
                new Date(Date.now() - BODY_TEMP_TTL_MS).toISOString(),
              )
            : eq(conversationBodyInputs.ownerKey, ownerKey),
        ),
      )
      .run()
  }

  releaseConversationInputs(ownerKey: string): void {
    this.sweepConversationInputs(ownerKey)
  }

  private bodyHasText(row: typeof conversationBodyInputs.$inferSelect): boolean {
    let offset = 0
    const deadline = Date.now() + 5000
    while (offset < row.chars) {
      if (Date.now() >= deadline)
        throw new RunOperationConflictError(
          'Input text validation timed out; the original draft remains saved.',
        )
      const parts = this.database
        .select({ offset: conversationBodyParts.offset, text: conversationBodyParts.text })
        .from(conversationBodyParts)
        .where(
          and(eq(conversationBodyParts.inputId, row.id), gte(conversationBodyParts.offset, offset)),
        )
        .orderBy(asc(conversationBodyParts.offset))
        .limit(24)
        .all()
      if (!parts.length)
        throw new RunOperationConflictError('The sealed input text has missing parts.')
      for (const part of parts) {
        if (part.offset !== offset)
          throw new RunOperationConflictError('The sealed input text changed.')
        if (/\S/u.test(part.text)) return true
        offset += part.text.length
      }
    }
    return false
  }

  private bodyInput(inputId: string, sessionId: string, ownerKey: string, allowCommitted = false) {
    const row = this.database
      .select()
      .from(conversationBodyInputs)
      .where(
        and(
          eq(conversationBodyInputs.id, inputId),
          eq(conversationBodyInputs.sessionId, sessionId),
          eq(conversationBodyInputs.ownerKey, ownerKey),
          ...(allowCommitted ? [] : [isNull(conversationBodyInputs.committedMessageId)]),
        ),
      )
      .get()
    if (
      !row ||
      (!row.committedMessageId &&
        !row.pendingReceiptId &&
        !row.sourceRunId &&
        Date.parse(row.updatedAt) + BODY_TEMP_TTL_MS <= Date.now())
    )
      throw new RunOperationConflictError(
        'This prepared body is expired or belongs to another owner.',
      )
    return row
  }

  private bodyReceipt(row: typeof conversationBodyInputs.$inferSelect): ConversationInputReceipt {
    return {
      inputId: row.id,
      offset: row.chars,
      sealed: row.sealed,
      bytes: row.bytes,
      chars: row.chars,
    }
  }

  private bodyCapacity(
    ownerKey: string,
    addedBytes: number,
    newIdentity = false,
    addedParts = 0,
  ): void {
    // Force the partial capacity index: committed Journal/input identities must not
    // become work on every subsequent append as durable history grows.
    const global = this.database.get<{ bytes: number; parts: number }>(sql`
      SELECT coalesce(sum(bytes), 0) AS bytes, coalesce(sum(parts), 0) AS parts
      FROM conversation_body_inputs INDEXED BY conversation_body_inputs_bytes_idx
      WHERE committed_message_id IS NULL AND pending_receipt_id IS NULL AND source_run_id IS NULL
    `)
    const owner = this.database
      .select({
        bytes: sql<number>`coalesce(sum(${conversationBodyInputs.bytes}), 0)`,
        count: sql<number>`count(*)`,
        parts: sql<number>`coalesce(sum(${conversationBodyInputs.parts}), 0)`,
      })
      .from(conversationBodyInputs)
      .where(
        and(
          eq(conversationBodyInputs.ownerKey, ownerKey),
          isNull(conversationBodyInputs.committedMessageId),
          isNull(conversationBodyInputs.pendingReceiptId),
          isNull(conversationBodyInputs.sourceRunId),
        ),
      )
      .get()!
    if (
      global.bytes + addedBytes > BODY_APP_STORAGE_BYTES ||
      owner.bytes + addedBytes > BODY_OWNER_STORAGE_BYTES ||
      (newIdentity && owner.count >= BODY_OWNER_INPUTS) ||
      global.parts + addedParts > BODY_APP_PARTS ||
      owner.parts + addedParts > BODY_OWNER_PARTS
    )
      throw new RunOperationConflictError(
        'Prepared body storage capacity is full. Existing content was preserved.',
      )
  }

  writeConversationInput(
    input: ConversationInputWrite,
    ownerKey: string,
  ): ConversationInputReceipt {
    if (!ownerKey || ownerKey.length > 1024)
      throw new RunOperationConflictError('Invalid body owner.')
    this.sweepConversationInputs()
    return this.database.transaction(() => {
      if (input.type === 'begin') {
        if (
          !this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.id, input.sessionId))
            .get()
        )
          throw new RunOperationConflictError('Conversation Session is unavailable.')
        const old = this.database
          .select()
          .from(conversationBodyInputs)
          .where(
            and(
              eq(conversationBodyInputs.ownerKey, ownerKey),
              eq(conversationBodyInputs.sessionId, input.sessionId),
              eq(conversationBodyInputs.clientMessageId, input.clientMessageId),
              eq(conversationBodyInputs.purpose, 'input'),
            ),
          )
          .orderBy(desc(conversationBodyInputs.createdAt))
          .get()
        if (old) {
          this.database
            .update(conversationBodyInputs)
            .set({ updatedAt: new Date().toISOString() })
            .where(eq(conversationBodyInputs.id, old.id))
            .run()
          return this.bodyReceipt(old)
        }
        this.bodyCapacity(ownerKey, 0, true)
        const now = new Date().toISOString()
        const row = {
          id: randomUUID(),
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          ownerKey,
          purpose: 'input' as const,
          bytes: 0,
          chars: 0,
          parts: 0,
          sealed: false,
          hash: null,
          committedMessageId: null,
          pendingReceiptId: null,
          sourceRunId: null,
          projectionPages: null,
          projectionBasis: null,
          createdAt: now,
          updatedAt: now,
        }
        this.database.insert(conversationBodyInputs).values(row).run()
        return this.bodyReceipt(row)
      }
      if (input.type === 'release') {
        const prior = this.database
          .select()
          .from(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, input.inputId))
          .get()
        if (!prior) return { inputId: input.inputId, offset: 0, sealed: false, bytes: 0, chars: 0 }
        if (
          prior.sessionId !== input.sessionId ||
          prior.ownerKey !== ownerKey ||
          prior.purpose !== 'input'
        )
          throw new RunOperationConflictError('This body belongs to another owner.')
        if (
          prior.pendingReceiptId ||
          this.database
            .select({ id: collaborationInputs.id })
            .from(collaborationInputs)
            .where(eq(collaborationInputs.inputId, prior.id))
            .limit(1)
            .get()
        )
          return this.bodyReceipt(prior)
        this.database
          .delete(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, prior.id))
          .run()
        return this.bodyReceipt(prior)
      }
      const row = this.bodyInput(input.inputId, input.sessionId, ownerKey)
      if (row.purpose !== 'input') throw new RunOperationConflictError('Invalid input body kind.')
      if (input.type === 'seal') return this.sealBody(row)
      return this.appendBodyPart(row, input.offset, input.text)
    })
  }

  private appendBodyPart(
    row: typeof conversationBodyInputs.$inferSelect,
    offset: number,
    text: string,
  ): ConversationInputReceipt {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !text.length ||
      text.length > BODY_PART_UNITS ||
      Buffer.byteLength(JSON.stringify({ text })) > 64 * 1024 ||
      !validBodyText(text)
    )
      throw new RunOperationConflictError('Invalid prepared body segment.')
    const prior = this.database
      .select()
      .from(conversationBodyParts)
      .where(
        and(eq(conversationBodyParts.inputId, row.id), eq(conversationBodyParts.offset, offset)),
      )
      .get()
    if (prior) {
      if (prior.text !== text)
        throw new RunOperationConflictError('This body offset already contains different content.')
      this.database
        .update(conversationBodyInputs)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(conversationBodyInputs.id, row.id))
        .run()
      return {
        inputId: row.id,
        offset: offset + text.length,
        sealed: false,
        bytes: prior.endBytes,
        chars: offset + text.length,
      }
    }
    if (row.sealed || offset !== row.chars)
      throw new RunOperationConflictError('Prepared body segments must be complete and ordered.')
    const bytes = Buffer.byteLength(text)
    if (!row.sourceRunId && row.parts >= BODY_INPUT_PARTS)
      throw new RunOperationConflictError(
        'Prepared body segment capacity is full. Existing content was preserved.',
      )
    if (!row.sourceRunId) this.bodyCapacity(row.ownerKey, bytes, false, 1)
    this.database
      .insert(conversationBodyParts)
      .values({ inputId: row.id, offset, text, endBytes: row.bytes + bytes })
      .run()
    const next = {
      ...row,
      bytes: row.bytes + bytes,
      chars: row.chars + text.length,
      parts: row.parts + 1,
      updatedAt: new Date().toISOString(),
    }
    this.database
      .update(conversationBodyInputs)
      .set({ bytes: next.bytes, chars: next.chars, parts: next.parts, updatedAt: next.updatedAt })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    return this.bodyReceipt(next)
  }

  private readBody(
    row: typeof conversationBodyInputs.$inferSelect,
    collect: boolean,
  ): { text: string; hash: string } {
    const digest = createHash('sha256')
    const parts: string[] = []
    let offset = 0,
      bytes = 0,
      partsRead = 0
    const deadline = Date.now() + 10_000
    while (offset < row.chars) {
      const page = this.database
        .select()
        .from(conversationBodyParts)
        .where(
          and(eq(conversationBodyParts.inputId, row.id), gte(conversationBodyParts.offset, offset)),
        )
        .orderBy(asc(conversationBodyParts.offset))
        .limit(64)
        .all()
      if (!page.length || Date.now() >= deadline)
        throw new RunOperationConflictError(
          'Prepared body cannot be read completely before its deadline.',
        )
      for (const part of page) {
        if (part.offset !== offset || !validBodyText(part.text))
          throw new RunOperationConflictError('Prepared body has a missing or invalid segment.')
        partsRead++
        if (!row.sourceRunId && partsRead > BODY_INPUT_PARTS)
          throw new RunOperationConflictError('Prepared body segment capacity changed.')
        offset += part.text.length
        bytes += Buffer.byteLength(part.text)
        if (part.endBytes !== bytes)
          throw new RunOperationConflictError('Prepared body byte offsets changed.')
        digest.update(part.text)
        if (collect) parts.push(part.text)
      }
    }
    if (offset !== row.chars || bytes !== row.bytes || partsRead !== row.parts)
      throw new RunOperationConflictError('Prepared body metadata changed.')
    return { text: collect ? parts.join('') : '', hash: digest.digest('hex') }
  }

  private sealBody(row: typeof conversationBodyInputs.$inferSelect): ConversationInputReceipt {
    if (row.sealed) {
      this.database
        .update(conversationBodyInputs)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(conversationBodyInputs.id, row.id))
        .run()
      return this.bodyReceipt(row)
    }
    const body = this.readBody(row, false)
    const next = { ...row, sealed: true, hash: body.hash, updatedAt: new Date().toISOString() }
    this.database
      .update(conversationBodyInputs)
      .set({ sealed: true, hash: body.hash, updatedAt: next.updatedAt })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    return this.bodyReceipt(next)
  }

  resolveConversationInput(
    sessionId: string,
    clientMessageId: string,
    inputId: string,
    ownerKey: string,
  ): string {
    const row = this.bodyInput(inputId, sessionId, ownerKey, true)
    if (
      row.purpose !== 'input' ||
      row.clientMessageId !== clientMessageId ||
      !row.sealed ||
      !row.hash
    )
      throw new RunOperationConflictError(
        'The complete prepared input was not sealed for this Send.',
      )
    if (row.bytes > BODY_INTERNAL_READ_BYTES)
      throw new RunOperationConflictError(
        'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
      )
    if (row.committedMessageId) {
      const original = this.internalMessage(row.committedMessageId, sessionId)
      if (
        !original ||
        original.id !== clientMessageId ||
        createHash('sha256').update(original.content).digest('hex') !== row.hash
      )
        throw new RunOperationConflictError('Committed input identity changed.')
      return original.content
    }
    const body = this.readBody(row, true)
    if (body.hash !== row.hash)
      throw new RunOperationConflictError('The prepared input changed after sealing.')
    this.database
      .update(conversationBodyInputs)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(conversationBodyInputs.id, row.id))
      .run()
    return body.text
  }

  consumeConversationInput(sessionId: string, inputId: string, ownerKey: string): void {
    this.database.transaction(() => {
      const row = this.bodyInput(inputId, sessionId, ownerKey, true)
      const message = this.internalMessage(row.clientMessageId, sessionId)
      if (row.purpose !== 'input' || !row.sealed || !message)
        throw new RunOperationConflictError(
          'Prepared input cannot be consumed before its original Message is durable.',
        )
      const hash = createHash('sha256').update(message.content).digest('hex')
      if (
        hash !== row.hash &&
        (row.committedMessageId || this.readBody(row, true).text.trim() !== message.content)
      )
        throw new RunOperationConflictError('Prepared input differs from the committed Send.')
      this.database
        .update(conversationBodyInputs)
        .set({
          committedMessageId: message.id,
          parts: 0,
          hash,
          bytes: Buffer.byteLength(message.content),
          chars: message.content.length,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(conversationBodyInputs.id, row.id))
        .run()
      // Retry resolves from the durable original Message. This small identity survives an uncertain ACK.
      this.database
        .delete(conversationBodyParts)
        .where(eq(conversationBodyParts.inputId, row.id))
        .run()
    })
  }

  selectForkSource(
    sourceSessionId: string,
    messageId: string,
    settings: import('@pact/contracts').SessionSettings,
    expectedSettingsRevision: number,
  ) {
    return forkFacts.selectForkSource(
      this.database,
      sourceSessionId,
      messageId,
      settings,
      expectedSettingsRevision,
    )
  }

  forkResponse(runId: string, sequence: number) {
    return forkFacts.forkResponse(this.database, runId, sequence)
  }

  commitFork(
    operationId: string,
    selection: forkFacts.ForkSelection,
    boundaries: Record<RuntimeAgentId, import('@pact/contracts').AgentNativeForkBoundary>,
    fullConsent: RuntimeAgentId[],
  ) {
    return forkFacts.commitFork(this.database, operationId, selection, boundaries, fullConsent)
  }

  forkOperation(sessionId: string) {
    return forkFacts.readFork(this.database, sessionId)
  }

  forkOperationById(operationId: string) {
    const row = this.database
      .select({ sessionId: sessionForkOperations.sessionId })
      .from(sessionForkOperations)
      .where(eq(sessionForkOperations.id, operationId))
      .get()
    return row ? this.forkOperation(row.sessionId) : undefined
  }

  sourceHasPendingFork(sourceSessionId: string): boolean {
    return !!this.database
      .select({ id: sessionForkOperations.id })
      .from(sessionForkOperations)
      .where(
        and(
          eq(sessionForkOperations.sourceSessionId, sourceSessionId),
          eq(sessionForkOperations.ready, false),
        ),
      )
      .limit(1)
      .get()
  }

  metadataPatch(sessionId: string) {
    const current = this.database
      .select({ runId: sql<string>`json_extract(${collaborationTasks.stateJson}, '$.runId')` })
      .from(collaborationTasks)
      .where(and(eq(collaborationTasks.sessionId, sessionId), eq(collaborationTasks.active, true)))
      .get()
    const run = current && this.findRun(current.runId)
    return this.createPatch(sessionId, { runs: run ? [run] : [] })
  }

  forkIntent(sessionId: string, operationId: string, agentId: RuntimeAgentId) {
    return forkFacts.forkIntent(this.database, sessionId, operationId, agentId)
  }

  updateForkIntent(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    patch: Partial<typeof nativeForkIntents.$inferInsert>,
  ) {
    forkFacts.updateForkIntent(this.database, sessionId, operationId, agentId, patch)
    return this.createPatch(sessionId, {})
  }

  completeForkSide(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    nativeSessionId: string,
    witness: import('@pact/contracts').AgentNativeForkWitness,
  ) {
    forkFacts.completeForkSide(
      this.database,
      sessionId,
      operationId,
      agentId,
      nativeSessionId,
      witness,
    )
    return this.createPatch(sessionId, {})
  }

  recoverForkIntents() {
    forkFacts.recoverForkIntents(this.database)
  }

  sessionHasNativeWork(sessionId: string): boolean {
    // Keep completed history outside this gate. Literal predicates make the
    // existing partial indexes eligible; their access path is a resource invariant.
    return (
      !!this.database.get<{ id: string }>(sql`
        SELECT id FROM ${agentRuns} INDEXED BY agent_runs_session_unsettled_work_idx
        WHERE ${agentRuns.sessionId} = ${sessionId} AND ${agentRuns.forkSourceRunId} IS NULL
          AND ((${agentRuns.status} IN ('starting', 'running', 'recovering') AND ${agentRuns.controlDisposition} <> 'abandoned') OR ${agentRuns.nativeEffectsState} IN ('pending', 'unknown'))
        LIMIT 1
      `) ||
      !!this.database.get<{ id: string }>(sql`
        SELECT id FROM ${nativeRebuildOperations} INDEXED BY native_rebuild_operations_unsettled_work_idx
        WHERE ${nativeRebuildOperations.sessionId} = ${sessionId} AND ${nativeRebuildOperations.nativeWorkState} IN ('pending', 'unknown')
        LIMIT 1
      `)
    )
  }

  forkActorIsCurrent(
    sessionId: string,
    operationId: string,
    agentId: RuntimeAgentId,
    executorId: string | undefined,
  ) {
    return forkFacts.forkActorIsCurrent(this.database, sessionId, operationId, agentId, executorId)
  }

  private observationState(sessionId: string): ConversationObservation {
    const existing = this.observations.get(sessionId)
    if (existing) {
      this.observations.delete(sessionId)
      this.observations.set(sessionId, existing)
      return existing
    }
    const created = { incarnation: randomUUID(), sequence: 1 }
    this.observations.set(sessionId, created)
    if (this.observations.size > MAX_OBSERVED_SESSIONS) {
      const oldest = this.observations.keys().next().value
      if (oldest) this.observations.delete(oldest)
    }
    return created
  }

  private currentObservation(sessionId: string): ConversationObservation {
    return this.observationState(sessionId)
  }

  private nextObservation(sessionId: string): ConversationObservation {
    const current = this.observationState(sessionId)
    const next = { ...current, sequence: current.sequence + 1 }
    this.observations.set(sessionId, next)
    return next
  }

  private requireIncarnation(sessionId: string, incarnation: string | undefined): void {
    if (incarnation && incarnation !== this.currentObservation(sessionId).incarnation) {
      throw new StaleConversationCursorError()
    }
  }

  private static fitsPage(page: ConversationPage): boolean {
    return (
      Buffer.byteLength(
        JSON.stringify({
          type: 'conversation.page.response',
          requestId: '00000000-0000-0000-0000-000000000000',
          result: { ok: true, value: page },
        }),
        'utf8',
      ) <= CONVERSATION_PAGE_BYTES
    )
  }

  /** Test/benchmark baseline only; production uses bounded pages and Patches. */
  read(sessionId: string): ConversationSnapshot {
    this.completeReadCount += 1
    const session = this.database.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    if (!session) throw new Error('Session does not exist.')
    const runs = this.database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(asc(agentRuns.createdAt))
      .all()
      .map((run) => ConversationRepository.toRun(run))
    const messages = this.database
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, sessionId))
      .orderBy(asc(conversationMessages.sequence))
      .all()
    const latestCompleteAssistantSequence = messages.findLast(
      (message) => message.role === 'assistant' && message.state === 'complete',
    )?.sequence
    const title = projectSessionTitle(session.title, session.titleSource)
    return {
      observation: this.currentObservation(sessionId),
      sessionId,
      session: {
        id: session.id,
        title: title.title,
        titleSource: title.titleSource,
        status: session.status,
        activity: deriveSessionActivity(session.status, runs.at(-1)),
        hasUnread: hasUnreadSessionMessage(
          session.lastSeenMessageSequence,
          latestCompleteAssistantSequence,
        ),
        updatedAt: session.updatedAt,
      },
      messages: messages.map((message) => this.toMessage(message)),
      comments: this.database
        .select()
        .from(anchoredComments)
        .where(eq(anchoredComments.sessionId, sessionId))
        .orderBy(asc(anchoredComments.position))
        .all()
        .map((comment) => ConversationRepository.toComment(comment)),
      commentsRevision: session.commentsRevision,
      activities: this.database
        .select()
        .from(agentRunActivities)
        .where(eq(agentRunActivities.sessionId, sessionId))
        .orderBy(asc(agentRunActivities.sequence))
        .all()
        .map((activity) => ConversationRepository.toActivity(activity)),
      runs,
      nativeContexts: this.database
        .select()
        .from(nativeAgentContexts)
        .where(eq(nativeAgentContexts.sessionId, sessionId))
        .orderBy(asc(nativeAgentContexts.agentId))
        .all()
        .map((context) => this.projectNativeContext(context)),
      rebuildOperations: this.rebuildOperations(sessionId),
      rebuildInputRecovery: this.rebuildInputRecovery(sessionId),
      forkOperation: this.forkOperation(sessionId),
    }
  }

  handoffRange(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
  ): { afterSequence: number; throughSequence: number } {
    const lastAccepted = this.database
      .select({ sequence: conversationMessages.sequence })
      .from(agentRuns)
      .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.agentId, targetAgentId),
          isNotNull(agentRuns.nativeTurnId),
          or(
            sql`${agentRuns.failureKind} IS NULL`,
            sql`${agentRuns.failureKind} NOT IN ('context_limit', 'unknown_delivery')`,
          ),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(conversationMessages.sequence))
      .limit(1)
      .get()
    const latest = this.database
      .select({ sequence: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, sessionId))
      .get()
    const rebuilt = this.database
      .select({
        sequence: nativeAgentContexts.rebuiltThroughSequence,
        forkSequence: nativeAgentContexts.forkThroughSequence,
      })
      .from(nativeAgentContexts)
      .where(
        and(
          eq(nativeAgentContexts.sessionId, sessionId),
          eq(nativeAgentContexts.agentId, targetAgentId),
        ),
      )
      .get()
    return {
      afterSequence: Math.max(
        lastAccepted?.sequence ?? -1,
        rebuilt?.sequence ?? -1,
        rebuilt?.forkSequence ?? -1,
      ),
      throughSequence: latest?.sequence ?? -1,
    }
  }

  private handoffRows(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    afterSequence: number,
    throughSequence: number,
    excludeMessageId?: string,
  ): HandoffRow[] {
    return this.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        contentRevision: conversationMessages.contentRevision,
        handledBy: agentRuns.agentId,
      })
      .from(conversationMessages)
      .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.isVisible, true),
          ...(excludeMessageId ? [ne(conversationMessages.id, excludeMessageId)] : []),
          gt(conversationMessages.sequence, afterSequence),
          lte(conversationMessages.sequence, throughSequence),
          or(
            and(
              eq(conversationMessages.role, 'user'),
              sql`EXISTS (
                SELECT 1 FROM agent_runs AS accepted
                WHERE accepted.user_message_id = ${conversationMessages.id}
                  AND accepted.agent_id <> ${targetAgentId}
                  AND accepted.native_turn_id IS NOT NULL
                  AND (accepted.failure_kind IS NULL OR accepted.failure_kind NOT IN ('context_limit', 'unknown_delivery'))
              )`,
            ),
            and(
              eq(conversationMessages.role, 'assistant'),
              eq(conversationMessages.state, 'complete'),
              ne(agentRuns.agentId, targetAgentId),
              isNotNull(agentRuns.nativeTurnId),
              or(
                sql`${agentRuns.failureKind} IS NULL`,
                sql`${agentRuns.failureKind} NOT IN ('context_limit', 'unknown_delivery')`,
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(conversationMessages.sequence))
      .limit(HANDOFF_PAGE_ITEMS + 1)
      .all()
  }

  readHandoffPage(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    afterSequence: number,
    throughSequence: number,
  ): { messages: HandoffBundle[]; nextSequence?: number } {
    const rows = this.handoffRows(sessionId, targetAgentId, afterSequence, throughSequence)
    const admitted = this.admitHandoffRows(rows.slice(0, HANDOFF_PAGE_ITEMS))
    const hydrated = this.hydrateHandoffRows(admitted)
    const messages: HandoffBundle[] = []
    let bytes = 0
    for (const message of hydrated) {
      const nextBytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
      if (nextBytes > HANDOFF_PAGE_BYTES)
        throw new HandoffTooLargeError('A required Message exceeds Pact’s safe page size.')
      if (bytes + nextBytes > HANDOFF_PAGE_BYTES) break
      messages.push(message)
      bytes += nextBytes
    }
    return {
      messages,
      ...(messages.length > 0 &&
      (messages.length < hydrated.length ||
        admitted.length < Math.min(rows.length, HANDOFF_PAGE_ITEMS) ||
        rows.length > HANDOFF_PAGE_ITEMS)
        ? { nextSequence: messages.at(-1)!.sequence }
        : {}),
    }
  }

  /** Internal complete sources: metadata pages stay small; oversized text is read in byte parts.
   * The caller consumes only one fixed <=8 MiB context, never a public oversized page. */
  async *readHandoffSources(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    afterSequence: number,
    throughSequence: number,
    signal: AbortSignal,
    excludeMessageId?: string,
  ): AsyncIterable<HandoffBundle> {
    const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
    let cursor = afterSequence,
      totalBytes = 0
    while (cursor < throughSequence) {
      if (signal.aborted || Date.now() >= deadline)
        throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
      const rows = this.handoffRows(
        sessionId,
        targetAgentId,
        cursor,
        throughSequence,
        excludeMessageId,
      )
      if (!rows.length) return
      for (const row of rows.slice(0, HANDOFF_PAGE_ITEMS)) {
        if (!this.collaborationQuotedHandoff(row))
          this.admitHandoffRows([row], HANDOFF_SAFETY_BYTES - totalBytes)
        // oxlint-disable-next-line no-await-in-loop -- Each complete source is assembled from bounded SQLite byte parts.
        const message = await this.readHandoffSource(row, signal, deadline)
        totalBytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
        if (totalBytes > HANDOFF_SAFETY_BYTES)
          throw new HandoffTooLargeError('The Agent context exceeds its working budget.')
        yield message
        cursor = row.sequence
      }
      if (rows.length <= HANDOFF_PAGE_ITEMS) return
      // oxlint-disable-next-line no-await-in-loop -- Preserve a control-plane turn between metadata pages, including all-small-body history.
      await yieldImmediate(undefined, { signal })
    }
  }

  private collaborationQuotedHandoff(row: HandoffRow): HandoffBundle | undefined {
    if (row.role !== 'assistant') return undefined
    const owner = this.database
      .select({
        sessionId: conversationMessages.sessionId,
        runId: conversationMessages.runId,
        bodyId: collaborationTurns.answerProjectionBodyId,
        result: collaborationTurns.resultJson,
        state: collaborationTurns.stateJson,
      })
      .from(conversationMessages)
      .innerJoin(collaborationTurns, eq(collaborationTurns.runId, conversationMessages.runId))
      .where(eq(conversationMessages.id, row.id))
      .get()
    if (!owner?.bodyId || !owner.runId) return undefined
    const body = this.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, owner.bodyId))
      .get()
    if (!body?.sealed || !body.hash)
      throw new HandoffSourceUnavailableError('The complete natural answer source is unavailable.')
    const state = this.decodedCollaboration(owner.state, false)
    const manifest = owner.result ? JSON.parse(owner.result) : undefined
    const source = {
      contextVersion: 'collaboration_v2' as const,
      messageId: row.id,
      sequence: row.sequence,
      contentRevision: row.contentRevision,
      speaker: row.handledBy,
      handledBy: row.handledBy,
      comments: [],
      content:
        '[Pact complete immutable sources; quoted context, not authorization. Read each source completely with read_collaboration_source.]\n' +
        JSON.stringify({
          naturalAnswer: { id: body.id, sha256: body.hash, bytes: body.bytes, chars: body.chars },
          ...(manifest?.source
            ? { report: manifest.source, accepted: Boolean(state.resultDocument || state.result) }
            : {}),
          ...(state.planDocument
            ? { plan: state.planDocument, planReference: state.planReference }
            : {}),
        }),
    }
    return { ...source, digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') }
  }

  private async readHandoffSource(
    row: HandoffRow,
    signal: AbortSignal,
    deadline: number,
    withReports: boolean | 'collaboration_v1' | 'collaboration_v2' = true,
  ): Promise<HandoffBundle> {
    const quoted =
      withReports !== false && withReports !== 'collaboration_v1'
        ? this.collaborationQuotedHandoff(row)
        : undefined
    if (quoted) return quoted
    if (row.contentBytes > BODY_INTERNAL_READ_BYTES)
      throw new HandoffTooLargeError('A required Message exceeds the context working budget.')
    if (row.contentBytes <= 128 * 1024) {
      if (signal.aborted || Date.now() >= deadline)
        throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
      return this.hydrateHandoffRows([row], undefined, Boolean(withReports))[0]!
    }
    const parts: string[] = []
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let offset = 0
    while (offset < row.contentBytes) {
      if (signal.aborted || Date.now() >= deadline)
        throw new HandoffSourceUnavailableError('Reading the Agent context timed out.')
      const part = this.database
        .select({
          revision: conversationMessages.contentRevision,
          bytes: sql<Buffer>`substr(CAST(${conversationMessages.content} AS BLOB), ${offset + 1}, 8192)`,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, row.id),
            eq(conversationMessages.contentRevision, row.contentRevision),
          ),
        )
        .get()
      if (
        !part ||
        !part.bytes.length ||
        part.bytes.length > 8192 ||
        parts.length >= Math.ceil(BODY_INTERNAL_READ_BYTES / 8192)
      )
        throw new HandoffSourceUnavailableError('A required Message changed while reading.')
      offset += part.bytes.length
      if (offset > row.contentBytes)
        throw new HandoffSourceUnavailableError('A required Message changed while reading.')
      parts.push(decoder.decode(part.bytes, { stream: true }))
      // oxlint-disable-next-line no-await-in-loop -- Yield the Utility between finite physical body reads.
      await yieldImmediate(undefined, { signal })
    }
    const suffix = decoder.decode()
    const body = parts.join('') + suffix
    if (
      Buffer.byteLength(body, 'utf8') !== row.contentBytes ||
      signal.aborted ||
      Date.now() >= deadline
    )
      throw new HandoffSourceUnavailableError('A required Message could not be read completely.')
    return this.hydrateHandoffRows([row], new Map([[row.id, body]]), Boolean(withReports))[0]!
  }

  async readCollaborationSource(
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<HandoffBundle> {
    const row = this.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        contentRevision: conversationMessages.contentRevision,
        handledBy: agentRuns.agentId,
      })
      .from(conversationMessages)
      .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
      .where(
        and(
          eq(conversationMessages.id, messageId),
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.role, 'user'),
        ),
      )
      .get()
    if (!row) throw new HandoffSourceUnavailableError('The original task input is unavailable.')
    return this.readHandoffSource(row, signal, Date.now() + HANDOFF_READ_DEADLINE_MS)
  }

  inputBatchForMessage(
    sessionId: string,
    messageId: string,
  ): CollaborationInputBatchReference | undefined {
    const row = this.database
      .select()
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.sessionId, sessionId),
          eq(conversationInputBatches.messageId, messageId),
        ),
      )
      .get()
    return row
      ? { id: row.id, revision: row.commentsRevision, memberCount: row.memberCount }
      : undefined
  }

  inputBatchForRun(runId: string): CollaborationInputBatchReference | undefined {
    const row = this.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.runId, runId))
      .get()
    if (row) return { id: row.id, revision: row.commentsRevision, memberCount: row.memberCount }
    const run = this.findRun(runId)
    return run ? this.inputBatchForMessage(run.sessionId, run.userMessageId) : undefined
  }

  private inputBatchReference(
    row: typeof conversationInputBatches.$inferSelect,
  ): InputBatchReference {
    return {
      id: row.id,
      sessionId: row.sessionId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      sequence: row.sequence,
      memberCount: row.memberCount,
      commentsRevision: row.commentsRevision,
      revision: row.commentsRevision,
    }
  }

  private freezeInputBatch(input: {
    sessionId: string
    clientMessageId: string
    commentsRevision: number
    actor: RuntimeAgentId
    taskId?: string
    runId?: string
    messageId?: string
    inputId?: string
    pendingReceiptId?: string
    preserveDraftComments?: boolean
    batchId?: string
  }): InputBatchReference {
    const existing = this.database
      .select()
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.sessionId, input.sessionId),
          eq(conversationInputBatches.clientMessageId, input.clientMessageId),
        ),
      )
      .get()
    if (existing) {
      if (
        existing.actor !== input.actor ||
        existing.taskId !== (input.taskId ?? null) ||
        existing.id !== (input.batchId ?? input.clientMessageId)
      )
        throw new RunOperationConflictError(
          'This input Batch nonce belongs to another authorization.',
        )
      if (input.runId && !existing.runId)
        this.database
          .update(conversationInputBatches)
          .set({ runId: input.runId, messageId: input.messageId ?? null })
          .where(eq(conversationInputBatches.id, existing.id))
          .run()
      return this.inputBatchReference(existing)
    }
    const condition = and(
      eq(anchoredComments.sessionId, input.sessionId),
      input.preserveDraftComments
        ? sql`0`
        : input.pendingReceiptId
          ? eq(anchoredComments.pendingReceiptId, input.pendingReceiptId)
          : and(
              isNull(anchoredComments.sentWithMessageId),
              isNull(anchoredComments.pendingReceiptId),
            ),
    )
    const count = this.database
      .select({ value: sql<number>`count(*)` })
      .from(anchoredComments)
      .where(condition)
      .get()!.value
    const task = input.taskId
      ? this.database
          .select()
          .from(collaborationTasks)
          .where(eq(collaborationTasks.id, input.taskId))
          .get()
      : undefined
    if (input.taskId && !task)
      throw new RunOperationConflictError('The input Batch task is unavailable.')
    const sequence = task ? task.inputSequence + 1 : 0
    const batchId = input.batchId ?? input.clientMessageId
    const now = new Date().toISOString()
    this.database
      .insert(conversationInputBatches)
      .values({
        id: batchId,
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        sequence,
        clientMessageId: input.clientMessageId,
        actor: input.actor,
        commentsRevision: input.commentsRevision,
        runId: input.runId ?? null,
        messageId: input.messageId ?? null,
        inputId: input.inputId ?? null,
        memberCount: count,
        createdAt: now,
      })
      .run()
    let position = -1
    let ordinal = 0
    for (;;) {
      const rows = this.database
        .select()
        .from(anchoredComments)
        .where(and(condition, gt(anchoredComments.position, position)))
        .orderBy(asc(anchoredComments.position))
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!rows.length) break
      for (const row of rows) {
        const anchor = commentAnchorSchema.parse(JSON.parse(row.anchorJson))
        const todoAnchor = anchor.type === 'todo' ? anchor : undefined
        const todo = todoAnchor
          ? this.database
              .select({
                todoId: collaborationTodoRevisions.todoId,
                answerResolver: collaborationTodoRevisions.answerResolver,
              })
              .from(collaborationTodoRevisions)
              .where(
                and(
                  eq(collaborationTodoRevisions.taskId, todoAnchor.taskId),
                  eq(collaborationTodoRevisions.todoId, todoAnchor.todoId),
                  eq(collaborationTodoRevisions.revision, todoAnchor.todoRevision),
                ),
              )
              .get()
          : undefined
        this.database
          .insert(conversationInputBatchMembers)
          .values({
            batchId,
            memberId: row.id,
            ordinal: ordinal++,
            commentId: row.id,
            commentRevision: row.draftRevision,
            anchorJson: row.anchorJson,
            bodySha256: createHash('sha256').update(row.body).digest('hex'),
            answerResolver: todo?.answerResolver ?? null,
            sourceTaskId: todoAnchor?.taskId,
            sourceTodoId: todoAnchor?.todoId,
            questionId: todoAnchor?.question?.id,
            questionRevision: todoAnchor?.question?.revision,
            todoId: todo?.todoId ?? null,
            updatedAt: now,
          })
          .run()
      }
      position = rows.at(-1)!.position
    }
    if (ordinal !== count)
      throw new RunOperationConflictError('Comment drafts changed while freezing the Batch.')
    if (task)
      this.database
        .update(collaborationTasks)
        .set({ inputSequence: sequence })
        .where(eq(collaborationTasks.id, task.id))
        .run()
    return {
      id: batchId,
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      sequence,
      memberCount: count,
      commentsRevision: input.commentsRevision,
      revision: input.commentsRevision,
    }
  }

  private freezeCollaborationAuthorization(
    task: CollaborationTask,
    runId: string,
    batch: InputBatchReference,
  ) {
    const row = this.database
      .select()
      .from(collaborationTasks)
      .where(eq(collaborationTasks.id, task.id))
      .get()!
    const duty = task.duty ?? collaborationSubmission(task)
    if (task.reportRecovery) {
      const original = this.collaborationTurnAuthorization(task.reportRecovery.sourceRunId)
      const source = this.findRun(task.reportRecovery.sourceRunId)
      if (
        !original ||
        !source ||
        original.taskId !== task.id ||
        original.actor !== task.actor ||
        source.nativeOutcome !== 'completed' ||
        source.dispatchPhase !== 'ended' ||
        !this.hasCompleteResponse(source.id)
      )
        throw new RunOperationConflictError('The original completed report duty is unavailable.')
      if (batch.memberCount !== 0)
        throw new RunOperationConflictError('A report-only submission cannot consume new feedback.')
      const auth = {
        ...original,
        runId,
        reportSourceRunId: original.reportSourceRunId ?? source.id,
      }
      this.database
        .insert(collaborationTurnAuthorizations)
        .values({
          runId,
          taskId: task.id,
          actor: auth.actor,
          duty: auth.duty,
          ledgerRevision: auth.baseTodoRevision,
          inputWatermark: auth.inputWatermark,
          inputSequence: auth.inputSequence,
          inputBatchId: auth.inputBatchId,
          basisJson: JSON.stringify(auth.basis),
          authorizationJson: JSON.stringify(auth),
          createdAt: new Date().toISOString(),
        })
        .run()
      this.database
        .run(sql`INSERT INTO collaboration_required_input_members(run_id,batch_id,member_id)
        SELECT ${runId},batch_id,member_id FROM collaboration_required_input_members WHERE run_id=${source.id}`)
      this.database
        .run(sql`INSERT OR IGNORE INTO conversation_run_source_refs(run_id,source_message_id,source_revision,batch_id,documents_json)
        SELECT ${runId},source_message_id,source_revision,batch_id,documents_json FROM conversation_run_source_refs WHERE run_id=${source.id}`)
      const originalTaskRow = this.database
        .select({ state: collaborationTurns.stateJson })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, source.id))
        .get()
      const origin = originalTaskRow
        ? this.decodedCollaboration(originalTaskRow.state, false)
        : undefined
      if (origin) {
        task.planDocument = origin.planDocument
        task.planReference = origin.planReference
        task.reviewScopeRef = original.reviewScopeRef ?? undefined
      }
      task.authorization = auth
      task.duty = auth.duty
      task.requiredInputScopeRef = auth.requiredInputScopeRef ?? undefined
      task.effectiveDecisionIndexRef = auth.effectiveDecisionIndexRef ?? undefined
      task.todoIdentityIndexRef = auth.todoIdentityIndexRef ?? undefined
      this.nativeFact(runId, 'collaboration.report_submission_authorized', {
        sourceRunId: auth.reportSourceRunId,
        batchId: batch.id,
        modelCalls: 0,
      })
      this.saveCollaboration(task)
      return
    }
    if (duty === 'code_review') {
      const implementation = this.database
        .select({
          runId: agentRuns.id,
          nativeSessionId: agentRuns.nativeSessionId,
          nativeTurnId: agentRuns.nativeTurnId,
          changes: workspaceChangeSets.id,
          changeRevision: workspaceChangeSets.revision,
        })
        .from(collaborationTurns)
        .innerJoin(agentRuns, eq(agentRuns.id, collaborationTurns.runId))
        .leftJoin(workspaceChangeSets, eq(workspaceChangeSets.runId, agentRuns.id))
        .where(
          and(
            eq(collaborationTurns.taskId, task.id),
            eq(agentRuns.nativeOutcome, 'completed'),
            eq(agentRuns.dispatchPhase, 'ended'),
            sql`json_extract(${collaborationTurns.stateJson},'$.stage') IN ('implement','repair')`,
            sql`NOT EXISTS (SELECT 1 FROM collaboration_turn_authorizations a WHERE a.run_id=${agentRuns.id} AND json_extract(a.authorization_json,'$.reportSourceRunId') IS NOT NULL)`,
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1)
        .get()
      const scope = {
        type: 'code-review-scope',
        taskId: task.id,
        taskMessageId: task.taskMessageId,
        taskDocument: task.taskDocument ?? null,
        implementationRunId: implementation?.runId ?? null,
        sourceChangeSetId: implementation?.changes ?? null,
        revision: implementation?.changeRevision ?? null,
        nativeSessionId: implementation?.nativeSessionId ?? null,
        nativeTurnId: implementation?.nativeTurnId ?? null,
      }
      const previous = task.reviewScopeRef
        ? this.collaborationDocumentText(task.sessionId, task.reviewScopeRef)
        : undefined
      if (previous !== JSON.stringify(scope))
        task.reviewScopeRef = this.saveCollaborationDocument(runId, JSON.stringify(scope))
    }
    const basis =
      duty === 'plan_review' || duty === 'plan_adoption' || duty === 'plan_submission'
        ? (task.planReference ?? null)
        : (task.reviewScopeRef ?? null)
    const index = (kind: string) =>
      this.saveCollaborationDocument(
        runId,
        JSON.stringify({ kind, runId, taskId: task.id, ledgerRevision: row.ledgerRevision }),
      )
    const auth: FrozenCollaborationAuthorization = {
      runId,
      taskId: task.id,
      actor: task.actor,
      duty,
      basePlanRef: task.planReference ?? null,
      baseTodoRevision: row.ledgerRevision,
      inputWatermark: row.processedWatermark,
      inputSequence: row.inputSequence,
      inputBatchId: batch.id,
      inputBatchRef: {
        id: batch.id,
        revision: batch.revision,
        memberCount: batch.memberCount,
      },
      requiredInputScopeRef: index('required_inputs'),
      effectiveDecisionIndexRef: index('decisions'),
      todoIdentityIndexRef: index('identities'),
      reviewScopeRef: task.reviewScopeRef ?? null,
      basis: basis ? this.saveCollaborationDocument(runId, JSON.stringify(basis)) : null,
    }
    this.database
      .insert(collaborationTurnAuthorizations)
      .values({
        runId,
        taskId: task.id,
        actor: task.actor,
        duty,
        ledgerRevision: row.ledgerRevision,
        inputWatermark: row.processedWatermark,
        inputSequence: row.inputSequence,
        inputBatchId: batch.id,
        basisJson: JSON.stringify(basis),
        authorizationJson: JSON.stringify(auth),
        createdAt: new Date().toISOString(),
      })
      .run()
    // SQL captures the complete required membership without an unbounded control array.
    this.database
      .run(sql`INSERT INTO collaboration_required_input_members(run_id,batch_id,member_id)
      SELECT ${runId}, b.id, m.member_id FROM conversation_input_batches b
      JOIN conversation_input_batch_members m ON m.batch_id=b.id
      WHERE b.task_id=${task.id} AND b.sequence<=${row.inputSequence} AND b.state='open'
      AND m.state NOT IN ('resolved','withdrawn')`)
    this.database
      .run(sql`INSERT INTO collaboration_required_input_members(run_id,batch_id,member_id)
      SELECT ${runId}, b.id, '$body' FROM conversation_input_batches b
      WHERE b.task_id=${task.id} AND b.sequence<=${row.inputSequence} AND b.state='open'
      AND b.body_state NOT IN ('resolved','withdrawn')`)
    task.authorization = auth
    task.duty = duty
    task.ledgerRevision = row.ledgerRevision
    task.inputSequence = row.inputSequence
    task.processedWatermark = row.processedWatermark
    task.inputBatchRef = auth.inputBatchRef ?? undefined
    task.requiredInputScopeRef = auth.requiredInputScopeRef ?? undefined
    task.effectiveDecisionIndexRef = auth.effectiveDecisionIndexRef ?? undefined
    task.todoIdentityIndexRef = auth.todoIdentityIndexRef ?? undefined
    this.saveCollaboration(task)
  }

  private sealInputBatchSources(batchId: string, runId: string) {
    const batch = this.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, batchId))
      .get()!
    if (!batch.bodyDocumentJson && batch.messageId) {
      const content = this.database
        .select({ text: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, batch.messageId))
        .get()!.text
      this.database
        .update(conversationInputBatches)
        .set({ bodyDocumentJson: JSON.stringify(this.saveCollaborationDocument(runId, content)) })
        .where(eq(conversationInputBatches.id, batchId))
        .run()
    }
    let ordinal = -1
    for (;;) {
      const rows = this.database
        .select({ member: conversationInputBatchMembers, body: anchoredComments.body })
        .from(conversationInputBatchMembers)
        .innerJoin(
          anchoredComments,
          eq(anchoredComments.id, conversationInputBatchMembers.commentId),
        )
        .where(
          and(
            eq(conversationInputBatchMembers.batchId, batchId),
            gt(conversationInputBatchMembers.ordinal, ordinal),
          ),
        )
        .orderBy(asc(conversationInputBatchMembers.ordinal))
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!rows.length) break
      for (const row of rows)
        if (!row.member.bodyDocumentJson)
          this.database
            .update(conversationInputBatchMembers)
            .set({
              bodyDocumentJson: JSON.stringify(this.saveCollaborationDocument(runId, row.body)),
              anchorDocumentJson: JSON.stringify(
                this.saveCollaborationDocument(runId, row.member.anchorJson),
              ),
            })
            .where(
              and(
                eq(conversationInputBatchMembers.batchId, batchId),
                eq(conversationInputBatchMembers.memberId, row.member.memberId),
              ),
            )
            .run()
      ordinal = rows.at(-1)!.member.ordinal
    }
  }

  collaborationTurnAuthorization(runId: string): FrozenCollaborationAuthorization | undefined {
    const row = this.database
      .select()
      .from(collaborationTurnAuthorizations)
      .where(eq(collaborationTurnAuthorizations.runId, runId))
      .get()
    return row
      ? collaborationTurnAuthorizationSchema.parse(JSON.parse(row.authorizationJson))
      : undefined
  }

  private quotedSource(sessionId: string, messageId: string) {
    const message = this.database
      .select()
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
      )
      .get()
    if (!message?.runId)
      throw new HandoffSourceUnavailableError('The frozen quoted Message is unavailable.')
    const batch = this.inputBatchForMessage(sessionId, messageId)
    const documents: Array<{ key: string; source: CollaborationDocument }> = []
    const turn = this.database
      .select()
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, message.runId))
      .get()
    if (message.role === 'assistant' && turn?.answerProjectionBodyId) {
      const body = this.database
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, turn.answerProjectionBodyId))
        .get()
      if (body?.sealed && body.hash)
        documents.push({
          key: 'message',
          source: { id: body.id, sha256: body.hash, bytes: body.bytes, chars: body.chars },
        })
      const task = this.decodedCollaboration(turn.stateJson, false)
      if (task.planDocument) documents.push({ key: 'plan', source: task.planDocument })
      const report = this.indexedResultManifest(message.runId)
      if (report) documents.push({ key: 'summary', source: report.manifest.summaryDocument })
      if (report) documents.push({ key: 'report', source: report.manifest.source })
    } else if (batch) {
      const row = this.database
        .select({ body: conversationInputBatches.bodyDocumentJson })
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.id, batch.id))
        .get()
      if (row?.body)
        documents.push({
          key: 'message',
          source: collaborationDocumentSchema.parse(JSON.parse(row.body)),
        })
    } else
      documents.push({
        key: 'message',
        source: this.saveCollaborationDocument(message.runId, message.content),
      })
    return {
      sourceMessageId: messageId,
      sourceRevision: message.contentRevision,
      batchId: batch?.id ?? null,
      documentsJson: JSON.stringify(documents),
    }
  }

  private freezeRunSources(runId: string, refs: ReadonlyArray<HandoffSourceRef>) {
    const run = this.findRun(runId)!
    for (const ref of refs) {
      const source = this.quotedSource(run.sessionId, ref.id)
      if (source.sourceRevision !== ref.revision)
        throw new HandoffSourceUnavailableError(
          'The quoted source changed before Run authorization.',
        )
      this.database
        .insert(conversationRunSourceRefs)
        .values({ runId, ...source })
        .onConflictDoNothing()
        .run()
    }
    const context = this.nativeContext(run.sessionId, run.agentId)
    if (!context?.nativeSessionId) return
    this.database
      .run(sql`INSERT OR IGNORE INTO conversation_run_source_refs(run_id,source_message_id,source_revision,batch_id,documents_json)
      SELECT ${runId},s.source_message_id,s.source_revision,s.batch_id,s.documents_json FROM conversation_rebuild_source_refs s
      JOIN native_rebuild_operations n ON n.id=s.operation_id WHERE n.session_id=${run.sessionId}
      AND n.agent_id=${run.agentId} AND n.old_generation+1=${run.bindingGeneration ?? 1}
      AND n.provisional_native_session_id=${context.nativeSessionId} AND n.stage='completed' AND n.initialization_witness_json IS NOT NULL`)
  }

  hasRunSources(runId: string): boolean {
    return Boolean(
      this.database
        .select({ id: conversationRunSourceRefs.sourceMessageId })
        .from(conversationRunSourceRefs)
        .where(eq(conversationRunSourceRefs.runId, runId))
        .limit(1)
        .get(),
    )
  }

  readRunSources(runId: string, offset = 0) {
    if (!this.findRun(runId) || !Number.isSafeInteger(offset) || offset < 0)
      throw new RunOperationConflictError('The Run source cursor is unavailable.')
    const rows = this.database
      .select()
      .from(conversationRunSourceRefs)
      .where(eq(conversationRunSourceRefs.runId, runId))
      .orderBy(asc(conversationRunSourceRefs.sourceMessageId))
      .limit(COLLABORATION_INDEX_ITEMS + 1)
      .offset(offset)
      .all()
    const items = rows.slice(0, COLLABORATION_INDEX_ITEMS).map((row) =>
      Object.assign(
        {
          messageId: row.sourceMessageId,
          revision: row.sourceRevision,
          documents: storedDocuments(row.documentsJson),
        },
        row.batchId
          ? {
              inputBatchRef: this.inputBatchReference(
                this.database
                  .select()
                  .from(conversationInputBatches)
                  .where(eq(conversationInputBatches.id, row.batchId))
                  .get()!,
              ),
            }
          : {},
      ),
    )
    if (Buffer.byteLength(JSON.stringify(items)) > COLLABORATION_INDEX_BYTES - 2048)
      throw new OversizedConversationEntityError()
    return {
      runId,
      items,
      offset,
      nextOffset: rows.length > items.length ? offset + items.length : null,
    }
  }

  sourceDocumentAuthorized(runId: string, document: CollaborationDocument): boolean {
    const run = this.findRun(runId)
    if (!run) return false
    let body: ReturnType<ConversationRepository['collaborationDocumentRow']>
    try {
      body = this.collaborationDocumentRow(run.sessionId, document)
    } catch {
      return false
    }
    if (body.sourceRunId === runId) return true
    const auth = this.collaborationTurnAuthorization(runId)
    if (auth) {
      if (
        [
          auth.requiredInputScopeRef,
          auth.effectiveDecisionIndexRef,
          auth.todoIdentityIndexRef,
          auth.reviewScopeRef,
          auth.basis,
        ].some((ref) => ref?.id === document.id && ref.sha256 === document.sha256)
      )
        return true
      const source = this.database
        .select({ id: collaborationTodoRevisions.todoId })
        .from(collaborationTodoRevisions)
        .where(
          and(
            eq(collaborationTodoRevisions.taskId, auth.taskId),
            lte(collaborationTodoRevisions.ledgerRevision, auth.baseTodoRevision),
            or(
              eq(collaborationTodoRevisions.documentId, document.id),
              eq(collaborationTodoRevisions.contentDocumentId, document.id),
              eq(collaborationTodoRevisions.reasonDocumentId, document.id),
            ),
          ),
        )
        .limit(1)
        .get()
      if (source) return true
      const inputSource = this.database.get<{
        found: number
      }>(sql`SELECT 1 AS found FROM collaboration_required_input_members r
        JOIN conversation_input_batches b ON b.id=r.batch_id
        LEFT JOIN conversation_input_batch_members m ON m.batch_id=r.batch_id AND m.member_id=r.member_id
        WHERE r.run_id=${runId} AND (json_extract(b.body_document_json,'$.id')=${document.id} OR json_extract(m.body_document_json,'$.id')=${document.id} OR json_extract(m.anchor_document_json,'$.id')=${document.id}) LIMIT 1`)
      if (inputSource) return true
      const earlierInput = this.database.get<{
        found: number
      }>(sql`SELECT 1 AS found FROM conversation_input_batches b
        LEFT JOIN conversation_input_batch_members m ON m.batch_id=b.id WHERE b.task_id=${auth.taskId} AND b.sequence<=${auth.inputSequence}
        AND (json_extract(b.body_document_json,'$.id')=${document.id} OR json_extract(m.body_document_json,'$.id')=${document.id} OR json_extract(m.anchor_document_json,'$.id')=${document.id}) LIMIT 1`)
      if (earlierInput) return true
      const frozen = this.database
        .select({ state: collaborationTurns.stateJson })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, runId))
        .get()
      const task = frozen ? this.decodedCollaboration(frozen.state, false) : undefined
      if (
        task &&
        [
          task.planDocument,
          task.taskDocument,
          task.priorResultDocument,
          task.reportRecovery?.document,
          task.reportRecovery?.failureDocument,
        ].some((ref) => ref?.id === document.id && ref.sha256 === document.sha256)
      )
        return true
    }
    return Boolean(
      this.database.get<{ found: number }>(sql`SELECT 1 AS found FROM conversation_run_source_refs s
      LEFT JOIN conversation_input_batches b ON b.id=s.batch_id
      LEFT JOIN conversation_input_batch_members m ON m.batch_id=s.batch_id
      WHERE s.run_id=${runId} AND (EXISTS (SELECT 1 FROM json_each(s.documents_json) j WHERE json_extract(j.value,'$.source.id')=${document.id})
      OR json_extract(b.body_document_json,'$.id')=${document.id} OR json_extract(m.body_document_json,'$.id')=${document.id} OR json_extract(m.anchor_document_json,'$.id')=${document.id}) LIMIT 1`),
    )
  }

  collaborationAnswerResolver(task: CollaborationTask): RuntimeAgentId {
    const resolvers = this.database
      .select({ actor: collaborationTodos.answerResolver })
      .from(collaborationTodos)
      .innerJoin(
        anchoredComments,
        sql`json_extract(${anchoredComments.anchorJson}, '$.type') = 'todo'
        AND json_extract(${anchoredComments.anchorJson}, '$.taskId') = ${collaborationTodos.taskId}
        AND json_extract(${anchoredComments.anchorJson}, '$.todoId') = ${collaborationTodos.todoId}
        AND json_extract(${anchoredComments.anchorJson}, '$.question.id') = ${collaborationTodos.questionId}
        AND json_extract(${anchoredComments.anchorJson}, '$.question.revision') = ${collaborationTodos.questionRevision}`,
      )
      .where(
        and(
          eq(collaborationTodos.taskId, task.id),
          isNotNull(collaborationTodos.answerResolver),
          isNull(anchoredComments.sentWithMessageId),
          isNull(anchoredComments.pendingReceiptId),
        ),
      )
      .groupBy(collaborationTodos.answerResolver)
      .limit(2)
      .all()
    if (resolvers.length === 1 && resolvers[0]?.actor) return resolvers[0].actor
    if (
      task.kind === 'plan' &&
      ['draft', 'discuss', 'clarify'].includes(task.resumePhase?.stage ?? task.stage)
    )
      return task.primary
    if (task.stage === 'review' || task.resumePhase?.stage === 'review') return task.reviewer
    return task.implementer
  }

  readRequiredInputMembers(runId: string, offset = 0) {
    const auth = this.collaborationTurnAuthorization(runId)
    if (!auth || !Number.isSafeInteger(offset) || offset < 0)
      throw new RunOperationConflictError('The required input scope is unavailable.')
    const rows = this.database
      .select({
        batchId: collaborationRequiredInputMembers.batchId,
        memberId: collaborationRequiredInputMembers.memberId,
        sequence: conversationInputBatches.sequence,
        ordinal: conversationInputBatchMembers.ordinal,
        state: conversationInputBatchMembers.state,
        bodyState: conversationInputBatches.bodyState,
        actor: conversationInputBatches.actor,
        commentId: conversationInputBatchMembers.commentId,
        answerResolver: conversationInputBatchMembers.answerResolver,
      })
      .from(collaborationRequiredInputMembers)
      .innerJoin(
        conversationInputBatches,
        eq(conversationInputBatches.id, collaborationRequiredInputMembers.batchId),
      )
      .leftJoin(
        conversationInputBatchMembers,
        and(
          eq(conversationInputBatchMembers.batchId, collaborationRequiredInputMembers.batchId),
          eq(conversationInputBatchMembers.memberId, collaborationRequiredInputMembers.memberId),
        ),
      )
      .where(eq(collaborationRequiredInputMembers.runId, runId))
      .orderBy(asc(conversationInputBatches.sequence), asc(conversationInputBatchMembers.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS + 1)
      .offset(offset)
      .all()
    const items = rows
      .slice(0, COLLABORATION_INDEX_ITEMS)
      .map((row) =>
        Object.assign(row, { state: row.memberId === '$body' ? row.bodyState : row.state }),
      )
    return {
      runId,
      taskId: auth.taskId,
      items,
      offset,
      nextOffset: rows.length > items.length ? offset + items.length : null,
    }
  }

  /** Bounded frozen member identities and immutable bodies, also available to ordinary Runs. */
  readFrozenInputBatch(runId: string, batchId: string, afterOrdinal = -1) {
    const run = this.findRun(runId)
    const batch = this.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, batchId))
      .get()
    const allowed =
      batch &&
      run &&
      batch.sessionId === run.sessionId &&
      (batch.runId === runId ||
        (this.collaborationTurnAuthorization(runId)?.taskId === batch.taskId &&
          batch.sequence <= (this.collaborationTurnAuthorization(runId)?.inputSequence ?? -1)) ||
        Boolean(
          this.database
            .select({ runId: collaborationRequiredInputMembers.runId })
            .from(collaborationRequiredInputMembers)
            .where(
              and(
                eq(collaborationRequiredInputMembers.runId, runId),
                eq(collaborationRequiredInputMembers.batchId, batchId),
              ),
            )
            .limit(1)
            .get(),
        ) ||
        this.runHasBatchHandoff(runId, batchId))
    if (!allowed || !batch || !run)
      throw new RunOperationConflictError('The input Batch is outside this Run authorization.')
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1)
      throw new RunOperationConflictError('Invalid input Batch cursor.')
    const rows = this.database
      .select({ member: conversationInputBatchMembers, comment: anchoredComments })
      .from(conversationInputBatchMembers)
      .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
      .where(
        and(
          eq(conversationInputBatchMembers.batchId, batchId),
          gt(conversationInputBatchMembers.ordinal, afterOrdinal),
        ),
      )
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS + 1)
      .all()
    const members: Array<{
      memberId: string
      ordinal: number
      commentId: string
      revision: number
      anchorDocument: CollaborationDocument
      body: CollaborationDocument
      state: typeof conversationInputBatchMembers.$inferSelect.state
      answerResolver?: RuntimeAgentId
    }> = []
    let bytes = 0
    for (const { member, comment } of rows.slice(0, COLLABORATION_INDEX_ITEMS)) {
      if (
        comment.draftRevision !== member.commentRevision ||
        createHash('sha256').update(comment.body).digest('hex') !== member.bodySha256
      )
        throw new RunOperationConflictError('The frozen Comment source changed.')
      // This immutable part reference is Run-owned; ordinary Runs use the same body source path.
      if (!member.bodyDocumentJson)
        throw new RunOperationConflictError('The frozen Comment source was not sealed.')
      const body = collaborationDocumentSchema.parse(JSON.parse(member.bodyDocumentJson))
      const item = {
        memberId: member.memberId,
        ordinal: member.ordinal,
        commentId: member.commentId,
        revision: member.commentRevision,
        anchorDocument: collaborationDocumentSchema.parse(JSON.parse(member.anchorDocumentJson!)),
        body,
        state: member.state,
        ...(member.answerResolver ? { answerResolver: member.answerResolver } : {}),
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item))
      if (bytes + itemBytes > COLLABORATION_INDEX_BYTES - 2048) {
        if (!members.length) throw new OversizedConversationEntityError()
        break
      }
      members.push(item)
      bytes += itemBytes
    }
    return {
      batch: this.inputBatchReference(batch),
      members,
      hasMore: rows.length > members.length,
      nextOrdinal: members.at(-1)?.ordinal ?? afterOrdinal,
      body: batch.bodyDocumentJson
        ? collaborationDocumentSchema.parse(JSON.parse(batch.bodyDocumentJson))
        : undefined,
    }
  }

  private runHasBatchHandoff(runId: string, batchId: string): boolean {
    return Boolean(
      this.database
        .select({ id: conversationRunSourceRefs.sourceMessageId })
        .from(conversationRunSourceRefs)
        .where(
          and(
            eq(conversationRunSourceRefs.runId, runId),
            eq(conversationRunSourceRefs.batchId, batchId),
          ),
        )
        .limit(1)
        .get(),
    )
  }

  readCollaborationTodos(
    taskId: string,
    ledgerRevision: number,
    state: 'active' | 'done' | 'all' = 'active',
    afterOrdinal = -1,
  ): CollaborationTodoPage {
    const task = this.database
      .select()
      .from(collaborationTasks)
      .where(eq(collaborationTasks.id, taskId))
      .get()
    if (!task || task.ledgerRevision !== ledgerRevision) throw new StaleConversationCursorError()
    const predicate = and(
      eq(collaborationTodos.taskId, taskId),
      gt(collaborationTodos.ordinal, afterOrdinal),
      state === 'done'
        ? eq(collaborationTodos.status, 'done')
        : state === 'active'
          ? ne(collaborationTodos.status, 'done')
          : undefined,
    )
    const heads = this.database
      .select({
        ordinal: collaborationTodos.ordinal,
        bytes: todoProjectionBytes(
          collaborationTodos.titlePreview,
          collaborationTodos.questionJson,
        ),
      })
      .from(collaborationTodos)
      .where(predicate)
      .orderBy(asc(collaborationTodos.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS + 1)
      .all()
    const last = admittedTodoOrdinal(heads, COLLABORATION_INDEX_BYTES - 16 * 1024)
    const rows =
      last < 0
        ? []
        : this.database
            .select({
              ...getTableColumns(collaborationTodos),
              questionJson: sql<
                string | null
              >`CASE WHEN length(CAST(${collaborationTodos.questionJson} AS BLOB))<=${COLLABORATION_INDEX_BYTES - 16 * 1024} THEN ${collaborationTodos.questionJson} ELSE NULL END`,
            })
            .from(collaborationTodos)
            .where(and(predicate, lte(collaborationTodos.ordinal, last)))
            .orderBy(asc(collaborationTodos.ordinal))
            .limit(COLLABORATION_INDEX_ITEMS)
            .all()
    const counts = this.todoCounts(taskId)
    const previous = this.database
      .select({ ordinal: collaborationTodos.ordinal })
      .from(collaborationTodos)
      .where(
        and(
          eq(collaborationTodos.taskId, taskId),
          lte(collaborationTodos.ordinal, afterOrdinal),
          state === 'done'
            ? eq(collaborationTodos.status, 'done')
            : state === 'active'
              ? ne(collaborationTodos.status, 'done')
              : undefined,
        ),
      )
      .orderBy(desc(collaborationTodos.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS)
      .all()
    const items: CollaborationTodo[] = []
    for (const row of rows.slice(0, COLLABORATION_INDEX_ITEMS)) {
      const next = this.todoMetadata(row)
      if (
        Buffer.byteLength(JSON.stringify([...items, next])) >
        COLLABORATION_INDEX_BYTES - 16 * 1024
      ) {
        if (!items.length) throw new OversizedConversationEntityError()
        break
      }
      items.push(next)
    }
    return {
      taskId,
      ledgerRevision,
      group: state,
      items,
      offset: afterOrdinal + 1,
      previousOffset: previous.length ? previous.at(-1)!.ordinal : null,
      nextOffset: heads.length > items.length ? heads[items.length - 1]!.ordinal + 1 : null,
      activeCount: counts.open + counts.awaiting,
      doneCount: counts.done,
    }
  }

  readTodoRevision(taskId: string, todoId: string, revision: number): CollaborationTodo {
    const predicate = and(
      eq(collaborationTodoRevisions.taskId, taskId),
      eq(collaborationTodoRevisions.todoId, todoId),
      eq(collaborationTodoRevisions.revision, revision),
    )
    const head = this.database
      .select({
        bytes: todoProjectionBytes(
          collaborationTodoRevisions.titlePreview,
          collaborationTodoRevisions.questionJson,
        ),
      })
      .from(collaborationTodoRevisions)
      .where(predicate)
      .get()
    if (!head) throw new RunOperationConflictError('The Todo revision is unavailable.')
    if (head.bytes > COLLABORATION_INDEX_BYTES - 16 * 1024)
      throw new OversizedConversationEntityError()
    const row = this.database
      .select({
        ...getTableColumns(collaborationTodoRevisions),
        questionJson: sql<
          string | null
        >`CASE WHEN length(CAST(${collaborationTodoRevisions.questionJson} AS BLOB))<=${COLLABORATION_INDEX_BYTES - 16 * 1024} THEN ${collaborationTodoRevisions.questionJson} ELSE NULL END`,
      })
      .from(collaborationTodoRevisions)
      .where(predicate)
      .get()
    if (!row) throw new RunOperationConflictError('The Todo revision is unavailable.')
    return this.todoMetadata(row)
  }

  private todoMetadata(row: typeof collaborationTodos.$inferSelect): CollaborationTodo {
    if (row.questionId && !row.questionJson) throw new OversizedConversationEntityError()
    const run = this.findRun(row.sourceRunId)
    const question = row.questionJson
      ? collaborationTodoQuestionSchema.parse(JSON.parse(row.questionJson))
      : null
    return {
      taskId: row.taskId,
      id: row.todoId,
      revision: row.revision,
      kind: row.kind,
      status: row.status,
      title: row.titlePreview,
      author: row.author,
      sourceRunId: row.sourceRunId,
      sourceMessageId: run?.responseMessageId ?? run?.userMessageId ?? row.sourceRunId,
      document: collaborationDocumentSchema.parse(JSON.parse(row.documentJson)),
      answerResolver: row.answerResolver,
      needsUserAnswer: Boolean(question && row.status === 'open' && !this.todoHasAnswer(row)),
      question,
      resolutionKind: row.resolutionKind,
      resolutionReasonPreview: row.reasonDocumentJson
        ? this.documentPreview(JSON.parse(row.reasonDocumentJson), 180)
        : '',
    }
  }

  private todoHasAnswer(row: typeof collaborationTodos.$inferSelect): boolean {
    if (!row.questionId) return false
    return Boolean(
      this.database.get<{
        found: number
      }>(sql`SELECT 1 AS found FROM conversation_input_batch_members m
      JOIN conversation_input_batches b ON b.id=m.batch_id WHERE b.task_id=${row.taskId}
      AND m.source_task_id=${row.taskId} AND m.source_todo_id=${row.todoId}
      AND m.question_id=${row.questionId} AND m.question_revision=${row.questionRevision}
      AND m.state <> 'withdrawn' LIMIT 1`),
    )
  }

  private documentPreview(ref: CollaborationDocument, length: number): string {
    const rows = this.database
      .select({ text: conversationBodyParts.text })
      .from(conversationBodyParts)
      .where(eq(conversationBodyParts.inputId, ref.id))
      .orderBy(asc(conversationBodyParts.offset))
      .limit(1)
      .all()
    return rows[0]?.text.slice(0, length) ?? ''
  }

  private todoCounts(taskId: string) {
    const rows = this.database
      .select({
        status: collaborationTodos.status,
        count: sql<number>`count(*)`,
        questions: sql<number>`sum(CASE WHEN ${collaborationTodos.status}<>'done' AND ${collaborationTodos.kind} IN ('decision','information') AND ${collaborationTodos.questionId} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(collaborationTodos)
      .where(eq(collaborationTodos.taskId, taskId))
      .groupBy(collaborationTodos.status)
      .all()
    return {
      open: rows.find((r) => r.status === 'open')?.count ?? 0,
      awaiting: rows.find((r) => r.status === 'awaiting_review')?.count ?? 0,
      done: rows.find((r) => r.status === 'done')?.count ?? 0,
      questions: rows.reduce((total, row) => total + row.questions, 0),
    }
  }

  /** Snapshot queries include off-page completed decisions and stable historical identities. */
  readFrozenTodoIndex(
    runId: string,
    kind: 'active' | 'decisions' | 'identities',
    afterOrdinal = -1,
  ) {
    const auth = this.collaborationTurnAuthorization(runId)
    if (!auth) throw new RunOperationConflictError('The frozen Todo index is unavailable.')
    const predicate = and(
      eq(collaborationTodoRevisions.taskId, auth.taskId),
      gt(collaborationTodoRevisions.ordinal, afterOrdinal),
      lte(collaborationTodoRevisions.ledgerRevision, auth.baseTodoRevision),
      sql`${collaborationTodoRevisions.revision} = (SELECT max(r.revision) FROM collaboration_todo_revisions r WHERE r.task_id = ${auth.taskId} AND r.todo_id = ${collaborationTodoRevisions.todoId} AND r.ledger_revision <= ${auth.baseTodoRevision})`,
      kind === 'active'
        ? ne(collaborationTodoRevisions.status, 'done')
        : kind === 'decisions'
          ? eq(collaborationTodoRevisions.status, 'done')
          : undefined,
    )
    const heads = this.database
      .select({
        ordinal: collaborationTodoRevisions.ordinal,
        bytes: todoProjectionBytes(
          collaborationTodoRevisions.titlePreview,
          collaborationTodoRevisions.questionJson,
        ),
      })
      .from(collaborationTodoRevisions)
      .where(predicate)
      .orderBy(asc(collaborationTodoRevisions.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS + 1)
      .all()
    const last = admittedTodoOrdinal(heads, COLLABORATION_INDEX_BYTES / 2)
    const rows =
      last < 0
        ? []
        : this.database
            .select({
              ...getTableColumns(collaborationTodoRevisions),
              questionJson: sql<
                string | null
              >`CASE WHEN length(CAST(${collaborationTodoRevisions.questionJson} AS BLOB))<=${COLLABORATION_INDEX_BYTES / 2} THEN ${collaborationTodoRevisions.questionJson} ELSE NULL END`,
            })
            .from(collaborationTodoRevisions)
            .where(and(predicate, lte(collaborationTodoRevisions.ordinal, last)))
            .orderBy(asc(collaborationTodoRevisions.ordinal))
            .limit(COLLABORATION_INDEX_ITEMS)
            .all()
    const items: Array<CollaborationTodo & { contentDocument: CollaborationDocument }> = []
    for (const row of rows.slice(0, COLLABORATION_INDEX_ITEMS)) {
      const item = {
        ...this.todoMetadata(row),
        contentDocument: collaborationDocumentSchema.parse(JSON.parse(row.contentDocumentJson)),
      }
      if (Buffer.byteLength(JSON.stringify([...items, item])) > COLLABORATION_INDEX_BYTES / 2) {
        if (!items.length) throw new OversizedConversationEntityError()
        break
      }
      items.push(item)
    }
    return {
      taskId: auth.taskId,
      ledgerRevision: auth.baseTodoRevision,
      items,
      hasMore: heads.length > items.length,
      nextOrdinal: rows[items.length - 1]?.ordinal ?? afterOrdinal,
    }
  }

  async readCollaborationReport(
    task: CollaborationTask,
    signal: AbortSignal,
  ): Promise<HandoffBundle> {
    const ref = task.reportRecovery
    if (!ref) throw new HandoffSourceUnavailableError('The original report is unavailable.')
    const run = this.findRun(ref.sourceRunId)
    const row = this.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        contentRevision: conversationMessages.contentRevision,
        handledBy: agentRuns.agentId,
      })
      .from(conversationMessages)
      .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
      .where(
        and(
          eq(conversationMessages.id, ref.sourceMessageId),
          eq(conversationMessages.runId, ref.sourceRunId),
          eq(conversationMessages.sessionId, task.sessionId),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.state, 'complete'),
          eq(conversationMessages.contentRevision, ref.sourceContentRevision),
        ),
      )
      .get()
    if (
      !row ||
      !row.contentBytes ||
      run?.dispatchPhase !== 'ended' ||
      run.nativeOutcome !== 'completed'
    )
      throw new HandoffSourceUnavailableError(
        'The completed original answer is unavailable. Nothing was sent.',
      )
    return this.readHandoffSource(row, signal, Date.now() + HANDOFF_READ_DEADLINE_MS)
  }

  async readRunHandoff(runId: string, signal: AbortSignal): Promise<HandoffBundle[]> {
    const run = this.database
      .select({ sourceIds: agentRuns.handoffSourceIds })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .get()
    if (!run) throw new HandoffSourceUnavailableError('The Run no longer exists.')
    if (Buffer.byteLength(run.sourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
      throw new HandoffTooLargeError()
    const parsed: unknown = JSON.parse(run.sourceIds)
    if (!Array.isArray(parsed)) throw new HandoffSourceUnavailableError()
    const refs: HandoffSourceRef[] = parsed.map((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof Reflect.get(value, 'id') !== 'string' ||
        !Number.isInteger(Reflect.get(value, 'revision')) ||
        typeof Reflect.get(value, 'digest') !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(Reflect.get(value, 'digest')) ||
        (Reflect.get(value, 'contextVersion') !== undefined &&
          !['collaboration_v1', 'collaboration_v2'].includes(
            String(Reflect.get(value, 'contextVersion')),
          ))
      )
        throw new HandoffSourceUnavailableError()
      return Object.assign(
        {
          id: Reflect.get(value, 'id'),
          revision: Reflect.get(value, 'revision'),
          digest: Reflect.get(value, 'digest'),
        },
        Reflect.get(value, 'contextVersion') === 'collaboration_v1' ||
          Reflect.get(value, 'contextVersion') === 'collaboration_v2'
          ? {
              contextVersion:
                Reflect.get(value, 'contextVersion') === 'collaboration_v2'
                  ? ('collaboration_v2' as const)
                  : ('collaboration_v1' as const),
            }
          : {},
      )
    })
    const context: HandoffBundle[] = []
    const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
    let totalBytes = 0
    for (let offset = 0; offset < refs.length;) {
      if (signal.aborted || Date.now() >= deadline)
        throw new HandoffSourceUnavailableError('Reading the saved Agent context timed out.')
      const page = refs.slice(offset, offset + HANDOFF_PAGE_ITEMS)
      const rows = this.database
        .select({
          id: conversationMessages.id,
          sequence: conversationMessages.sequence,
          role: conversationMessages.role,
          contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
          contentRevision: conversationMessages.contentRevision,
          handledBy: agentRuns.agentId,
        })
        .from(conversationMessages)
        .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
        .where(
          inArray(
            conversationMessages.id,
            page.map((source) => source.id),
          ),
        )
        .all()
      const metadataById = new Map(rows.map((row) => [row.id, row]))
      const ordered = page.map((ref) => {
        const row = metadataById.get(ref.id)
        if (!row || row.contentRevision !== ref.revision)
          throw new HandoffSourceUnavailableError('A saved context source changed.')
        return row
      })
      for (const row of ordered) {
        const ref = page.find((candidate) => candidate.id === row.id)!
        if (ref.contextVersion !== 'collaboration_v2')
          this.admitHandoffRows([row], HANDOFF_SAFETY_BYTES - totalBytes)
        // oxlint-disable-next-line no-await-in-loop -- Each source must be read in its frozen digest version before continuing.
        const message = await this.readHandoffSource(
          row,
          signal,
          deadline,
          ref.contextVersion ?? false,
        )
        if (message.contentRevision !== ref.revision || message.digest !== ref.digest)
          throw new HandoffSourceUnavailableError('A saved context source changed.')
        totalBytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
        if (totalBytes > HANDOFF_SAFETY_BYTES)
          throw new HandoffTooLargeError('The saved context exceeds its working budget.')
        context.push(message)
      }
      offset += page.length
      // oxlint-disable-next-line no-await-in-loop -- One bounded source page yields before the next SQLite read.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return context
  }

  private admitHandoffRows(rows: HandoffRow[], budget = HANDOFF_PAGE_BYTES): HandoffRow[] {
    if (rows.some((row) => row.role === 'system')) throw new HandoffSourceUnavailableError()
    const userIds = rows.filter((row) => row.role === 'user').map((row) => row.id)
    const commentSizes = new Map(
      (userIds.length === 0
        ? []
        : this.database
            .select({
              messageId: anchoredComments.sentWithMessageId,
              bytes: sql<number>`sum(length(CAST(${anchoredComments.body} AS BLOB)) + length(CAST(${anchoredComments.anchorJson} AS BLOB)))`,
              count: sql<number>`count(*)`,
            })
            .from(anchoredComments)
            .where(
              and(
                inArray(anchoredComments.sentWithMessageId, userIds),
                sql`NOT EXISTS (SELECT 1 FROM conversation_input_batches b WHERE b.message_id=${anchoredComments.sentWithMessageId})`,
              ),
            )
            .groupBy(anchoredComments.sentWithMessageId)
            .all()
      ).map((row) => [row.messageId, row]),
    )
    const admitted: HandoffRow[] = []
    let bytes = 0
    for (const row of rows) {
      const comments = commentSizes.get(row.id)
      const itemBytes =
        row.contentBytes + (comments?.bytes ?? 0) + 512 + (comments?.count ?? 0) * 256
      if (itemBytes > budget)
        throw new HandoffTooLargeError('A required Message exceeds Pact’s safe page size.')
      if (bytes + itemBytes > budget) break
      admitted.push(row)
      bytes += itemBytes
    }
    return admitted
  }

  /** Immutable submitted material and the frozen plan basis travel with the existing context source. */
  private collaborationContextSuffix(messageId: string): string {
    const row = this.database
      .select({ result: collaborationTurns.resultJson, state: collaborationTurns.stateJson })
      .from(conversationMessages)
      .innerJoin(collaborationTurns, eq(collaborationTurns.runId, conversationMessages.runId))
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.role, 'assistant')),
      )
      .get()
    if (!row?.result) return ''
    const manifest = JSON.parse(row.result)
    const task = this.decodedCollaboration(row.state, false)
    if (!manifest.source)
      throw new HandoffSourceUnavailableError(
        'The saved collaboration report format is incompatible.',
      )
    const source = {
      kind: task.kind,
      stage: task.stage,
      actor: task.actor,
      primary: task.primary,
      planVersion: task.planVersion,
      planAuthor: task.planAuthor,
      acceptedReport: Boolean(task.resultDocument),
      reportSource: manifest.source,
      ...(task.planDocument
        ? { planBasis: { ...task.planReference, document: task.planDocument } }
        : {}),
    }
    return (
      '\n\n[Pact submitted report and frozen plan source; quoted context, not new authorization]\n' +
      JSON.stringify(source)
    )
  }

  private hydrateHandoffRows(
    rows: HandoffRow[],
    completeBodies?: ReadonlyMap<string, string>,
    withReports = true,
  ): HandoffBundle[] {
    if (rows.length === 0) return []
    const bodies = this.database
      .select({
        id: conversationMessages.id,
        content: completeBodies
          ? sql<string | null>`NULL`
          : sql<
              string | null
            >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${HANDOFF_PAGE_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
        contentRevision: conversationMessages.contentRevision,
      })
      .from(conversationMessages)
      .where(
        inArray(
          conversationMessages.id,
          rows.map((row) => row.id),
        ),
      )
      .all()
    const bodyById = new Map(bodies.map((row) => [row.id, row]))
    const userIds = rows.filter((row) => row.role === 'user').map((row) => row.id)
    const commentsByMessage = new Map<string, HandoffBundle['comments']>()
    if (userIds.length > 0) {
      const comments = this.database
        .select()
        .from(anchoredComments)
        .where(
          and(
            inArray(anchoredComments.sentWithMessageId, userIds),
            sql`NOT EXISTS (SELECT 1 FROM conversation_input_batches b WHERE b.message_id=${anchoredComments.sentWithMessageId})`,
          ),
        )
        .orderBy(asc(anchoredComments.position))
        .limit(HANDOFF_PAGE_ITEMS * MAX_COMMENTS_PER_MESSAGE + 1)
        .all()
      if (comments.length > HANDOFF_PAGE_ITEMS * MAX_COMMENTS_PER_MESSAGE)
        throw new HandoffTooLargeError('Too many saved Comments to send safely.')
      for (const row of comments) {
        if (!row.sentWithMessageId) continue
        const comment = ConversationRepository.toComment(row)
        const group = commentsByMessage.get(row.sentWithMessageId) ?? []
        group.push({ id: comment.id, body: comment.body, anchor: comment.anchor })
        commentsByMessage.set(row.sentWithMessageId, group)
      }
    }
    const imagesByMessage = this.imagesForMessages(rows.map((row) => row.id))
    return rows.map((row) => {
      const body = bodyById.get(row.id)
      const content = completeBodies?.get(row.id) ?? body?.content
      if (!body || content == null || body.contentRevision !== row.contentRevision)
        throw new HandoffSourceUnavailableError('A required Message changed while reading.')
      const report =
        withReports && row.role === 'assistant' ? this.collaborationContextSuffix(row.id) : ''
      const batch = this.inputBatchForMessage(
        this.database
          .select({ id: conversationMessages.sessionId })
          .from(conversationMessages)
          .where(eq(conversationMessages.id, row.id))
          .get()!.id,
        row.id,
      )
      const source = {
        ...(batch
          ? {
              inputBatchRef: {
                id: batch.id,
                revision: batch.revision,
                memberCount: batch.memberCount,
              },
            }
          : {}),
        ...(report ? { contextVersion: 'collaboration_v1' as const } : {}),
        messageId: row.id,
        sequence: row.sequence,
        contentRevision: row.contentRevision,
        speaker: row.role === 'user' ? ('user' as const) : row.handledBy,
        handledBy: row.handledBy,
        content: content + report,
        comments: commentsByMessage.get(row.id) ?? [],
        ...(imagesByMessage.get(row.id)?.length ? { images: imagesByMessage.get(row.id)! } : {}),
      }
      return {
        ...source,
        digest: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      }
    })
  }

  private readRunArtifacts(
    sessionId: string,
    userMessageIds: string[],
  ): NonNullable<Extract<ConversationPage, { scope: 'messages' }>['runArtifacts']> {
    if (!userMessageIds.length) return []
    const groups = this.database
      .select({
        userMessageId: agentRuns.userMessageId,
        agentId: agentRuns.agentId,
        totalCount: sql<number>`count(*)`,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          inArray(agentRuns.userMessageId, userMessageIds),
          or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
        ),
      )
      .groupBy(agentRuns.userMessageId, agentRuns.agentId)
      .all()
    return groups.flatMap((group) => {
      const latest = this.database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, sessionId),
            eq(agentRuns.userMessageId, group.userMessageId),
            eq(agentRuns.agentId, group.agentId),
            or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(1)
        .get()
      return latest ? [{ ...group, latestRunId: latest.id }] : []
    })
  }

  receivedCollaborationInput(sessionId: string, includeCancelled = false) {
    return this.database
      .select()
      .from(collaborationInputs)
      .where(
        and(
          eq(collaborationInputs.sessionId, sessionId),
          includeCancelled
            ? ne(collaborationInputs.state, 'materialized')
            : inArray(collaborationInputs.state, ['accepted', 'blocked']),
        ),
      )
      .orderBy(desc(collaborationInputs.createdAt))
      .limit(1)
      .get()
  }

  receivedInputReceipt(
    sessionId: string,
    clientMessageId: string,
    input?: import('@pact/contracts').ConversationSendInput,
    waitingForWork = false,
  ): ConversationPatch | undefined {
    const row = this.database
      .select()
      .from(collaborationInputs)
      .where(
        and(
          eq(collaborationInputs.id, clientMessageId),
          eq(collaborationInputs.sessionId, sessionId),
        ),
      )
      .get()
    if (!row) return undefined
    if (input) {
      const meta = collaborationReceivedMetadataSchema.parse(JSON.parse(row.metadataJson))
      if (
        (input.inputId && input.inputId !== row.inputId) ||
        (!input.inputId &&
          createHash('sha256').update(input.content).digest('hex') !== row.digest) ||
        (!meta.batchId && JSON.stringify(input.commentIds) !== JSON.stringify(meta.commentIds)) ||
        (input.batchId ?? input.clientMessageId) !== (meta.batchId ?? row.id) ||
        (input.freezeDrafts ?? true) !== (meta.freezeDrafts ?? true) ||
        JSON.stringify(input.imageIds ?? []) !== JSON.stringify(meta.imageIds) ||
        JSON.stringify(input.skills ?? []) !== JSON.stringify(meta.skills) ||
        input.planningAction !== meta.planningAction ||
        JSON.stringify(input.route) !== JSON.stringify(meta.route)
      )
        throw new RunOperationConflictError('This received nonce belongs to different input.')
    }
    return this.createPatch(sessionId, {
      receivedInputIds: [row.id],
      ...(waitingForWork && row.state === 'accepted' ? { queuedInputIds: [row.id] } : {}),
    })
  }

  receiveCollaborationInput(
    input: import('@pact/contracts').ConversationSendInput,
    inputId: string,
    actor: RuntimeAgentId,
    policy: 'immediate_safe_point' | 'next_round',
    ownerKey: string,
    waitingForWork = false,
  ): ConversationPatch {
    const task = this.collaboration(input.sessionId)
    if (!task) throw new RunOperationConflictError('The active collaboration task is unavailable.')
    return this.database.transaction(() => {
      assertSessionAvailable(this.database, input.sessionId)
      if (this.receivedCollaborationInput(input.sessionId))
        throw new RunOperationConflictError(
          'One message is already waiting. Your draft was preserved.',
        )
      const count = this.database
        .select({ value: sql<number>`count(*)` })
        .from(collaborationInputs)
        .where(inArray(collaborationInputs.state, ['accepted', 'blocked']))
        .get()!.value
      if (count >= 5)
        throw new RunOperationConflictError(
          'All five received-input slots are occupied. Your draft was preserved.',
        )
      const session = this.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()
      if (!session || session.commentsRevision !== input.expectedCommentsRevision)
        throw new RunOperationConflictError('Comment drafts changed before receipt.')
      const freezeDrafts = input.freezeDrafts ?? true
      if (!freezeDrafts && input.commentIds.length)
        throw new RunOperationConflictError(
          'A preserved draft cannot also be included in this message.',
        )
      const commentCount = this.database
        .select({ value: sql<number>`count(*)` })
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.sessionId, input.sessionId),
            isNull(anchoredComments.sentWithMessageId),
            isNull(anchoredComments.pendingReceiptId),
            freezeDrafts ? undefined : sql`0`,
          ),
        )
        .get()!.value
      const body = this.bodyInput(inputId, input.sessionId, ownerKey)
      if (
        !body.sealed ||
        body.bytes > BODY_INTERNAL_READ_BYTES ||
        body.clientMessageId !== input.clientMessageId
      )
        throw new RunOperationConflictError('The received input is not sealed.')
      if (
        (!input.inputId &&
          createHash('sha256').update(input.content).digest('hex') !== body.hash) ||
        (input.inputId && input.inputId !== inputId)
      )
        throw new RunOperationConflictError('The received nonce has different body content.')
      const images = this.resolveMessageImages(input.sessionId, input.imageIds ?? [], ownerKey)
      if (!commentCount && !images.length && !this.bodyHasText(body))
        throw new RunOperationConflictError(
          'Write a message, add a Comment, or attach an image before sending.',
        )
      const metadata = JSON.stringify({
        skills: input.skills ?? [],
        imageIds: images.map((v) => v.id),
        commentIds: [],
        batchId: input.batchId ?? input.clientMessageId,
        freezeDrafts,
        route: input.route,
        planningAction: input.planningAction,
      })
      if (Buffer.byteLength(metadata) > 64 * 1024)
        throw new RunOperationConflictError('Received metadata exceeds 64 KiB.')
      const now = new Date().toISOString()
      this.freezeInputBatch({
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        commentsRevision: session.commentsRevision,
        actor,
        taskId: task.id,
        inputId,
        preserveDraftComments: !freezeDrafts,
        ...(input.batchId ? { batchId: input.batchId } : {}),
      })
      this.database
        .insert(collaborationInputs)
        .values({
          id: input.clientMessageId,
          sessionId: input.sessionId,
          taskId: task.id,
          anchorRunId: task.runId,
          inputId,
          digest: body.hash!,
          actor,
          policy,
          metadataJson: metadata,
          state: 'accepted',
          createdAt: now,
          deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
        .run()
      this.database
        .update(conversationBodyInputs)
        .set({ pendingReceiptId: input.clientMessageId })
        .where(eq(conversationBodyInputs.id, inputId))
        .run()
      if (commentCount)
        this.database
          .update(anchoredComments)
          .set({ pendingReceiptId: input.clientMessageId })
          .where(
            and(
              eq(anchoredComments.sessionId, input.sessionId),
              isNull(anchoredComments.sentWithMessageId),
              isNull(anchoredComments.pendingReceiptId),
            ),
          )
          .run()
      if (images.length)
        this.database
          .update(conversationImageAssets)
          .set({ pendingReceiptId: input.clientMessageId, committed: true })
          .where(
            inArray(
              conversationImageAssets.id,
              images.map((v) => v.id),
            ),
          )
          .run()
      this.database
        .update(sessions)
        .set({ commentsRevision: session.commentsRevision + 1 })
        .where(eq(sessions.id, input.sessionId))
        .run()
      this.database
        .update(agentRuns)
        .set({ peerProposalState: 'superseded' })
        .where(
          and(eq(agentRuns.sessionId, input.sessionId), eq(agentRuns.peerProposalState, 'pending')),
        )
        .run()
      task.revision++
      this.saveCollaboration(task)
      return this.createPatch(input.sessionId, {
        receivedInputIds: [input.clientMessageId],
        ...(waitingForWork ? { queuedInputIds: [input.clientMessageId] } : {}),
        resync: { messages: false, drafts: true, activityRunIds: [] },
        runs: [this.findRun(task.runId)!],
        comments: {
          revision: session.commentsRevision + 1,
          upserts: [],
          removedIds: input.commentIds.length <= MAX_COMMENTS_PER_MESSAGE ? input.commentIds : [],
        },
      })
    })
  }

  pendingCollaborationInputs() {
    return this.database
      .select({
        sessionId: collaborationInputs.sessionId,
        id: collaborationInputs.id,
        deadline: collaborationInputs.deadline,
      })
      .from(collaborationInputs)
      .where(eq(collaborationInputs.state, 'accepted'))
      .orderBy(asc(collaborationInputs.createdAt))
      .limit(5)
      .all()
  }

  readReceivedInput(sessionId: string) {
    const input = this.receivedCollaborationInput(sessionId)
    if (!input) return undefined
    const body = this.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, input.inputId))
      .get()
    if (!body || !body.sealed || body.hash !== input.digest)
      throw new RunOperationConflictError('The received body is unavailable.')
    const read = this.readBody(body, true)
    if (read.hash !== input.digest)
      throw new RunOperationConflictError('The received body changed.')
    const metadata = collaborationReceivedMetadataSchema.parse(JSON.parse(input.metadataJson))
    return {
      ...input,
      content: read.text.trim(),
      metadata,
      comments: [] as AnchoredComment[],
      inputBatchRef: this.database
        .select()
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.clientMessageId, input.id))
        .get(),
    }
  }

  setReceivedInputState(
    sessionId: string,
    state: 'accepted' | 'blocked' | 'cancelled',
    receiptId?: string,
  ): ConversationPatch {
    return this.database.transaction(() => {
      const row = receiptId
        ? this.database
            .select()
            .from(collaborationInputs)
            .where(
              and(
                eq(collaborationInputs.id, receiptId),
                eq(collaborationInputs.sessionId, sessionId),
              ),
            )
            .get()
        : this.receivedCollaborationInput(sessionId)
      if (!row || row.state === 'materialized') {
        if (receiptId)
          throw new RunOperationConflictError('This received input is no longer available.')
        return this.metadataPatch(sessionId)
      }
      if (state !== 'cancelled' && row.state === 'cancelled')
        throw new RunOperationConflictError(
          'Cancelled input cannot be reauthorized. Send a new message.',
        )
      this.database
        .update(collaborationInputs)
        .set({ state, deadline: new Date(Date.now() + 10 * 60_000).toISOString() })
        .where(eq(collaborationInputs.id, row.id))
        .run()
      if (state === 'cancelled') {
        const batch = this.database
          .select({ id: conversationInputBatches.id })
          .from(conversationInputBatches)
          .where(eq(conversationInputBatches.clientMessageId, row.id))
          .get()
        if (batch) this.withdrawInputBatch(batch.id)
      }
      const task = this.collaboration(sessionId)
      if (task) {
        task.revision++
        this.saveCollaboration(task)
      }
      return this.metadataPatch(sessionId)
    })
  }

  recoverCollaborationTasks(): void {
    // One indexed SQL update: never materialize all task bodies at startup.
    this.database
      .update(collaborationTasks)
      .set({
        stateJson: sql`json_set(${collaborationTasks.stateJson}, '$.status', 'failed', '$.revision', json_extract(${collaborationTasks.stateJson}, '$.revision') + 1, '$.notice', 'Interrupted by restart. Resolve original delivery before continuing.')`,
      })
      .where(
        and(
          eq(collaborationTasks.active, true),
          sql`json_extract(${collaborationTasks.stateJson}, '$.status') = 'running'`,
        ),
      )
      .run()
  }

  collaboration(
    sessionId: string,
    runId?: string,
    hydrate?: boolean,
  ): CollaborationTask | undefined {
    if (runId) {
      const active = this.collaboration(sessionId, undefined, hydrate)
      if (active?.runId === runId) return active
      const run = this.findRun(runId)
      if (!run || run.sessionId !== sessionId)
        throw new RunOperationConflictError('The collaboration source is unavailable.')
      const row = this.database
        .select()
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, runId))
        .get()
      return row
        ? this.collaborationRecoveryProjection(this.decodedCollaboration(row.stateJson, hydrate))
        : undefined
    }
    const row = this.database
      .select()
      .from(collaborationTasks)
      .where(and(eq(collaborationTasks.sessionId, sessionId), eq(collaborationTasks.active, true)))
      .get()
    return row
      ? this.collaborationRecoveryProjection(this.decodedCollaboration(row.stateJson, hydrate))
      : undefined
  }

  /** Recover a completed report's source without changing its immutable facts or frozen duty. */
  private collaborationRecoveryProjection(task: CollaborationTask): CollaborationTask {
    task = this.withPlanReference(task)
    if (task.status !== 'failed') return task
    if (task.reportRecovery) return { ...task, reportFailure: task.reportFailure ?? 'missing' }
    const run = this.findRun(task.runId)
    if (
      run?.dispatchPhase !== 'ended' ||
      run.nativeOutcome !== 'completed' ||
      !run.responseMessageId
    )
      return task
    const body = this.database
      .select({
        state: conversationMessages.state,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, run.responseMessageId),
          eq(conversationMessages.runId, run.id),
          eq(conversationMessages.role, 'assistant'),
        ),
      )
      .get()
    if (body?.state !== 'complete' || !body.contentBytes) return task
    task.sourceMessageId = run.responseMessageId
    if (task.reportFailure) return task
    const receipt = this.database
      .select({ result: collaborationTurns.resultJson })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, run.id))
      .get()
    if (receipt && !receipt.result) return { ...task, reportFailure: 'missing' }
    return task
  }

  /** Immutable Run-owned content; physical segment limits never bound cumulative text. */
  private saveCollaborationDocument(runId: string, text: string): CollaborationDocument {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The content Run is unavailable.')
    const sha256 = createHash('sha256').update(text).digest('hex')
    const ownerKey = `collaboration:${runId}`
    const old = this.database
      .select()
      .from(conversationBodyInputs)
      .where(
        and(
          eq(conversationBodyInputs.ownerKey, ownerKey),
          eq(conversationBodyInputs.clientMessageId, sha256),
          eq(conversationBodyInputs.purpose, 'collaboration'),
        ),
      )
      .get()
    if (old?.sealed && old.hash === sha256)
      return { id: old.id, sha256, bytes: old.bytes, chars: old.chars }
    const now = new Date().toISOString()
    const id = randomUUID()
    this.database
      .insert(conversationBodyInputs)
      .values({
        id,
        sessionId: run.sessionId,
        clientMessageId: sha256,
        ownerKey,
        purpose: 'collaboration',
        sourceRunId: runId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    let row = this.bodyInput(id, run.sessionId, ownerKey)
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + BODY_PART_UNITS)
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
      this.appendBodyPart(row, offset, text.slice(offset, end))
      offset = end
      row = this.bodyInput(id, run.sessionId, ownerKey)
    }
    this.sealBody(row)
    return { id, sha256, bytes: row.bytes, chars: row.chars }
  }

  collaborationDocumentRow(sessionId: string, ref: CollaborationDocument) {
    const row = this.database
      .select()
      .from(conversationBodyInputs)
      .where(
        and(
          eq(conversationBodyInputs.id, ref.id),
          eq(conversationBodyInputs.sessionId, sessionId),
          eq(conversationBodyInputs.purpose, 'collaboration'),
        ),
      )
      .get()
    if (
      !row?.sealed ||
      !row.sourceRunId ||
      row.hash !== ref.sha256 ||
      row.bytes !== ref.bytes ||
      row.chars !== ref.chars
    )
      throw new RunOperationConflictError(
        'The immutable collaboration source changed or is unavailable.',
      )
    return row
  }

  collaborationCommentDocument(
    sessionId: string,
    anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
  ): CollaborationDocument | undefined {
    const runId = anchor.plan?.runId ?? anchor.report?.runId
    if (!runId) return undefined
    const run = this.findRun(runId)
    if (!run || run.sessionId !== sessionId || run.userMessageId !== anchor.messageId)
      throw new RunOperationConflictError('The Comment source Run changed.')
    if (anchor.plan) {
      const task = this.collaboration(sessionId, runId, false)
      if (task?.planVersion !== anchor.plan.version)
        throw new RunOperationConflictError('The plan version changed.')
      return task.planDocument
    }
    const target = anchor.report!.target
    if (target.type === 'feedback') {
      const item = this.database
        .select()
        .from(collaborationReportItems)
        .where(
          and(
            eq(collaborationReportItems.runId, runId),
            eq(collaborationReportItems.itemId, target.id),
          ),
        )
        .get()
      return item ? collaborationDocumentSchema.parse(JSON.parse(item.documentJson)) : undefined
    }
    const row = this.database
      .select({ json: collaborationTurns.resultJson })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    const manifest = row?.json ? JSON.parse(row.json) : undefined
    return manifest?.documents?.find((entry: { key: string }) => entry.key === 'summary')?.source
  }

  collaborationCarrierSource(sessionId: string, runId: string): CollaborationDocument | undefined {
    const run = this.findRun(runId)
    if (!run || run.sessionId !== sessionId)
      throw new RunOperationConflictError('The original report Run is unavailable.')
    const row = this.database
      .select({
        id: sql<
          string | null
        >`coalesce(${collaborationTurns.nativeEnvelopeBodyId}, ${collaborationTurns.pendingEnvelopeBodyId})`,
      })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    if (!row?.id) return undefined
    const body = this.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, row.id))
      .get()
    if (!body?.sealed || !body.hash || body.sessionId !== sessionId || body.sourceRunId !== runId)
      return undefined
    return { id: body.id, sha256: body.hash, bytes: body.bytes, chars: body.chars }
  }

  naturalMessageProjection(messageId: string, sessionId: string): string | undefined {
    const row = this.database
      .select({ id: collaborationTurns.answerProjectionBodyId })
      .from(conversationMessages)
      .innerJoin(collaborationTurns, eq(collaborationTurns.runId, conversationMessages.runId))
      .where(
        and(
          eq(conversationMessages.id, messageId),
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.state, 'complete'),
        ),
      )
      .get()
    if (!row?.id) return undefined
    const body = this.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, row.id))
      .get()
    if (
      !body?.sealed ||
      body.sessionId !== sessionId ||
      !body.hash ||
      body.bytes > CONVERSATION_MARKDOWN_BYTES
    )
      return undefined
    return this.collaborationDocumentText(sessionId, {
      id: body.id,
      sha256: body.hash,
      bytes: body.bytes,
      chars: body.chars,
    })
  }

  usePlainCollaborationProjection(sessionId: string, source: CollaborationDocument): void {
    this.collaborationDocumentRow(sessionId, source)
    this.database
      .update(conversationBodyInputs)
      .set({ projectionBasis: 'plain-visible-v1' })
      .where(eq(conversationBodyInputs.id, source.id))
      .run()
  }

  private collaborationRawRange(
    sessionId: string,
    source: CollaborationDocument,
    start: number,
    end: number,
  ): string {
    this.collaborationDocumentRow(sessionId, source)
    let text = '',
      cursor = start
    while (cursor < end) {
      const row = this.database
        .select()
        .from(conversationBodyParts)
        .where(
          and(
            eq(conversationBodyParts.inputId, source.id),
            lte(conversationBodyParts.offset, cursor),
          ),
        )
        .orderBy(desc(conversationBodyParts.offset))
        .limit(1)
        .get()
      if (!row) throw new RunOperationConflictError('The source has a missing text segment.')
      const next = row.text.slice(cursor - row.offset, Math.min(row.text.length, end - row.offset))
      if (!next.length)
        throw new RunOperationConflictError('The source has a missing text segment.')
      text += next
      cursor += next.length
    }
    return text
  }

  beginMarkdownProjection(sessionId: string, source: CollaborationDocument): void {
    this.collaborationDocumentRow(sessionId, source)
    this.database
      .delete(collaborationMarkdownPages)
      .where(eq(collaborationMarkdownPages.documentId, source.id))
      .run()
  }

  recordMarkdownPage(
    sessionId: string,
    source: CollaborationDocument,
    page: {
      ordinal: number
      visibleStart: number
      visibleEnd: number
      tree: CollaborationMarkdownNode
      visibleText: string
    },
  ): void {
    this.collaborationDocumentRow(sessionId, source)
    const tree = collaborationMarkdownNodeSchema.parse(page.tree)
    const json = JSON.stringify(tree)
    if (
      Buffer.byteLength(json) > 40 * 1024 ||
      !collaborationMarkdownTreeWithinBudget(tree) ||
      page.visibleText.length > 4096 ||
      page.visibleText.length !== page.visibleEnd - page.visibleStart
    )
      throw new RunOperationConflictError(
        'Invalid Markdown projection page. Original content is preserved.',
      )
    const prior = this.database
      .select()
      .from(collaborationMarkdownPages)
      .where(
        and(
          eq(collaborationMarkdownPages.documentId, source.id),
          eq(collaborationMarkdownPages.ordinal, page.ordinal - 1),
        ),
      )
      .get()
    if (
      (page.ordinal === 0 && page.visibleStart !== 0) ||
      (page.ordinal > 0 && prior?.visibleEnd !== page.visibleStart)
    )
      throw new RunOperationConflictError('Markdown projection has a missing page.')
    this.database
      .insert(collaborationMarkdownPages)
      .values({
        documentId: source.id,
        ordinal: page.ordinal,
        visibleStart: page.visibleStart,
        visibleEnd: page.visibleEnd,
        treeJson: json,
        visibleText: page.visibleText,
      })
      .run()
  }

  sealMarkdownProjection(sessionId: string, source: CollaborationDocument, pages: number): void {
    this.collaborationDocumentRow(sessionId, source)
    this.database
      .update(conversationBodyInputs)
      .set({ projectionPages: pages, projectionBasis: 'markdown-visible-v2' })
      .where(eq(conversationBodyInputs.id, source.id))
      .run()
  }

  collaborationQuote(
    sessionId: string,
    source: CollaborationDocument,
    start: number,
    end: number,
    basis: 'markdown-visible-v2' | 'plain-visible-v1' = 'markdown-visible-v2',
  ): string {
    if (end - start > 20_000 || start < 0 || end <= start)
      throw new RunOperationConflictError('Invalid Comment quote range.')
    if (basis === 'plain-visible-v1')
      return this.collaborationRawRange(sessionId, source, start, end)
    const body = this.collaborationDocumentRow(sessionId, source)
    if (body.projectionPages === null || end - start > 20_000)
      throw new RunOperationConflictError('The selected Markdown range is not ready.')
    const rows = this.database
      .select({
        visibleStart: collaborationMarkdownPages.visibleStart,
        visibleText: collaborationMarkdownPages.visibleText,
      })
      .from(collaborationMarkdownPages)
      .where(
        and(
          eq(collaborationMarkdownPages.documentId, source.id),
          gte(collaborationMarkdownPages.visibleStart, Math.max(0, start - 4096)),
          lt(collaborationMarkdownPages.visibleStart, end),
          gt(collaborationMarkdownPages.visibleEnd, start),
          gt(collaborationMarkdownPages.visibleEnd, collaborationMarkdownPages.visibleStart),
        ),
      )
      .orderBy(asc(collaborationMarkdownPages.visibleStart))
      .limit(20_000)
      .all()
    const quote = rows
      .map((row) =>
        row.visibleText.slice(
          Math.max(0, start - row.visibleStart),
          Math.min(row.visibleText.length, end - row.visibleStart),
        ),
      )
      .join('')
    if (quote.length !== end - start)
      throw new RunOperationConflictError('The Comment source range is unavailable.')
    return quote
  }

  private collaborationDocumentText(sessionId: string, ref: CollaborationDocument): string {
    const row = this.collaborationDocumentRow(sessionId, ref)
    const read = this.readBody(row, true)
    if (read.hash !== ref.sha256)
      throw new RunOperationConflictError('The complete source digest changed.')
    return read.text
  }

  private storedCollaboration(task: CollaborationTask): CollaborationTask {
    const planDocument =
      typeof task.plan === 'string'
        ? task.planDocument?.sha256 === createHash('sha256').update(task.plan).digest('hex')
          ? task.planDocument
          : this.saveCollaborationDocument(task.planReference?.sourceRunId ?? task.runId, task.plan)
        : task.planDocument
    return {
      ...task,
      plan: undefined,
      planDocument,
      notice: task.notice && task.notice.length > 512 ? undefined : task.notice,
      noticeDocument:
        task.notice && task.notice.length > 512
          ? this.saveCollaborationDocument(task.runId, task.notice)
          : undefined,
      task: task.task.length > 1024 ? '' : task.task,
      taskDocument:
        task.task.length > 1024
          ? this.saveCollaborationDocument(task.runId, task.task)
          : task.taskDocument,
      result: undefined,
      resultDocument:
        task.resultDocument ??
        (task.result
          ? this.saveCollaborationDocument(task.runId, JSON.stringify(task.result))
          : undefined),
      priorResult: undefined,
      priorResultDocument:
        task.priorResultDocument ??
        (task.priorResult
          ? this.saveCollaborationDocument(
              task.previousRunId ?? task.runId,
              JSON.stringify(task.priorResult),
            )
          : undefined),
    }
  }

  collaborationPromptState(task: CollaborationTask): CollaborationTask {
    if (task.reportRecovery)
      task = {
        ...task,
        reportRecovery: {
          ...task.reportRecovery,
          document: this.collaborationCarrierSource(
            task.sessionId,
            task.reportRecovery.sourceRunId,
          ),
        },
      }
    if (task.priorResult && !task.priorResultDocument && task.previousRunId)
      this.saveSubmittedReport(
        task.previousRunId,
        collaborationResultSchema.parse(task.priorResult),
      )
    if (this.findRun(task.runId)) return this.storedCollaboration(task)
    return { ...task, plan: undefined, result: undefined, priorResult: undefined, task: '' }
  }

  private decodedCollaboration(state: string, hydrate?: boolean): CollaborationTask {
    const task = collaborationTaskSchema.parse(JSON.parse(state))
    if (hydrate === false) return task
    if (hydrate === undefined) {
      const row = this.database
        .select({ json: collaborationTurns.resultJson })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, task.runId))
        .get()
      const manifest = row?.json ? JSON.parse(row.json) : undefined
      return manifest?.header && task.resultDocument
        ? {
            ...task,
            result: { ...manifest.header, control: true },
            resultFeedbackCount: manifest.feedbackCount,
            resultHasOpenDecision: Boolean(manifest.hasOpenDecision),
          }
        : task
    }
    return {
      ...task,
      notice:
        task.notice ??
        (task.noticeDocument
          ? this.collaborationDocumentText(task.sessionId, task.noticeDocument)
          : undefined),
      plan:
        task.plan ??
        (task.planDocument
          ? this.collaborationDocumentText(task.sessionId, task.planDocument)
          : undefined),
      task: task.taskDocument
        ? this.collaborationDocumentText(task.sessionId, task.taskDocument)
        : task.task,
      result:
        task.result ??
        (task.resultDocument
          ? collaborationResultSchema.parse(
              JSON.parse(this.collaborationDocumentText(task.sessionId, task.resultDocument)),
            )
          : undefined),
      priorResult:
        task.priorResult ??
        (task.priorResultDocument
          ? collaborationResultSchema.parse(
              JSON.parse(this.collaborationDocumentText(task.sessionId, task.priorResultDocument)),
            )
          : undefined),
    }
  }

  private storedResult(sessionId: string, json: string): CollaborationResult {
    const manifest: unknown = JSON.parse(json)
    if (!manifest || typeof manifest !== 'object')
      throw new RunOperationConflictError('The stored report has no indexed source.')
    const ref = collaborationDocumentSchema.parse(Reflect.get(manifest, 'source'))
    return collaborationResultSchema.parse(
      JSON.parse(this.collaborationDocumentText(sessionId, ref)),
    )
  }

  private archiveIndexedResult(
    runId: string,
    result: CollaborationResult,
    source: CollaborationDocument,
  ) {
    const auth = this.collaborationTurnAuthorization(runId)
    if (!auth)
      throw new RunOperationConflictError('The submitted result has no immutable authorization.')
    const digest = source.sha256
    const old = this.database
      .select()
      .from(collaborationResultApplications)
      .where(eq(collaborationResultApplications.runId, runId))
      .get()
    if (old) {
      if (old.digest !== digest)
        throw new RunOperationConflictError(
          'A different result cannot replace this Turn submission.',
        )
      return JSON.parse(old.manifestJson)
    }
    const planDocument =
      typeof result.plan === 'string'
        ? this.saveCollaborationDocument(runId, result.plan)
        : undefined
    const summaryDocument = this.saveCollaborationDocument(runId, result.summary)
    const header = {
      ...result,
      summary: result.summary.slice(0, 512),
      plan: typeof result.plan === 'string' ? undefined : result.plan,
      todoDeltas: [],
      inputResponses: [],
    }
    const manifest = {
      source,
      header,
      summaryDocument,
      planDocument,
      todoCount: result.todoDeltas.length,
      inputResponseCount: result.inputResponses.length,
    }
    this.database
      .insert(collaborationResultApplications)
      .values({
        runId,
        taskId: auth.taskId,
        resultId: `${runId}:${digest}`,
        sourceJson: JSON.stringify(source),
        digest,
        manifestJson: JSON.stringify(manifest),
        createdAt: new Date().toISOString(),
      })
      .run()
    for (const [ordinal, delta] of result.todoDeltas.entries())
      this.database
        .insert(collaborationResultOperations)
        .values({
          runId,
          ordinal,
          todoId: delta.todoId,
          expectedRevision: delta.expectedRevision,
          operation: delta.operation,
          titlePreview: (
            delta.title ??
            this.database
              .select({ title: collaborationTodos.titlePreview })
              .from(collaborationTodos)
              .where(
                and(
                  eq(collaborationTodos.taskId, auth.taskId),
                  eq(collaborationTodos.todoId, delta.todoId),
                ),
              )
              .get()?.title ??
            delta.todoId
          ).slice(0, 180),
          documentJson: JSON.stringify(
            this.saveCollaborationDocument(runId, JSON.stringify(delta)),
          ),
        })
        .run()
    for (const response of result.inputResponses)
      this.database
        .insert(collaborationResultInputResponses)
        .values({
          runId,
          batchId: response.batchId,
          memberId: response.memberId,
          disposition: response.disposition,
          todoId: response.todoId,
          documentJson: JSON.stringify(
            this.saveCollaborationDocument(runId, JSON.stringify(response)),
          ),
        })
        .run()
    return manifest
  }

  private indexedResultManifest(runId: string) {
    const row = this.database
      .select()
      .from(collaborationResultApplications)
      .where(eq(collaborationResultApplications.runId, runId))
      .get()
    if (!row) return undefined
    const value = storedObject(row.manifestJson)
    if (
      typeof value.todoCount !== 'number' ||
      !Number.isSafeInteger(value.todoCount) ||
      value.todoCount < 0 ||
      typeof value.inputResponseCount !== 'number' ||
      !Number.isSafeInteger(value.inputResponseCount) ||
      value.inputResponseCount < 0
    )
      throw new RunOperationConflictError('The result index counts are invalid.')
    return {
      row,
      manifest: {
        source: collaborationDocumentSchema.parse(value.source),
        header: collaborationResultSchema.parse(value.header),
        summaryDocument: collaborationDocumentSchema.parse(value.summaryDocument),
        ...(value.planDocument
          ? { planDocument: collaborationDocumentSchema.parse(value.planDocument) }
          : {}),
        todoCount: value.todoCount,
        inputResponseCount: value.inputResponseCount,
      },
    }
  }

  private readIndexedDelta(
    sessionId: string,
    row: typeof collaborationResultOperations.$inferSelect,
  ): CollaborationTodoDelta {
    const value = collaborationTodoDeltaSchema.parse(
      JSON.parse(this.collaborationDocumentText(sessionId, JSON.parse(row.documentJson))),
    )
    if (
      value.todoId !== row.todoId ||
      value.expectedRevision !== row.expectedRevision ||
      value.operation !== row.operation
    )
      throw new RunOperationConflictError('The indexed Todo operation changed.')
    return value
  }

  private readIndexedResponse(
    sessionId: string,
    row: typeof collaborationResultInputResponses.$inferSelect,
  ): CollaborationInputResponse {
    const value = collaborationInputResponseSchema.parse(
      JSON.parse(this.collaborationDocumentText(sessionId, JSON.parse(row.documentJson))),
    )
    const applied =
      this.database
        .select({ state: collaborationResultApplications.state })
        .from(collaborationResultApplications)
        .where(eq(collaborationResultApplications.runId, row.runId))
        .get()?.state === 'applied'
    if (
      value.batchId !== row.batchId ||
      value.memberId !== row.memberId ||
      (!applied && (value.disposition !== row.disposition || value.todoId !== row.todoId))
    )
      throw new RunOperationConflictError('The indexed input response changed.')
    return applied
      ? collaborationInputResponseSchema.parse({
          ...value,
          disposition: row.disposition,
          todoId: row.todoId,
        })
      : value
  }

  private applyTodoDelta(
    task: CollaborationTask,
    run: AgentRun,
    delta: CollaborationTodoDelta,
    ledgerRevision: number,
  ) {
    const current = this.database
      .select()
      .from(collaborationTodos)
      .where(
        and(eq(collaborationTodos.taskId, task.id), eq(collaborationTodos.todoId, delta.todoId)),
      )
      .get()
    if ((current?.revision ?? 0) !== delta.expectedRevision)
      throw new RunOperationConflictError('The Todo advanced after this Turn was authorized.')
    if ((delta.operation === 'create') !== !current)
      throw new RunOperationConflictError('Create must introduce a new stable Todo identity.')
    const questionChanged = Boolean(
      delta.question &&
      (current?.questionId !== delta.question.id ||
        current.questionRevision !== delta.question.revision),
    )
    if (questionChanged && ['propose_resolution', 'confirm'].includes(delta.operation))
      throw new RunOperationConflictError(
        'A new question must be introduced with create, update, or reopen before its resolution can be proposed or confirmed.',
      )
    if (questionChanged && current && !delta.reason.trim())
      throw new RunOperationConflictError(
        'Changing an existing question requires a reason for the additional user input.',
      )
    const resetsResolution = questionChanged || delta.operation === 'reopen'
    if (resetsResolution && (delta.resolutionKind !== null || delta.mergeTargetId !== null))
      throw new RunOperationConflictError(
        'An open question or reopened Todo cannot retain a proposed resolution or merge target.',
      )
    const reviewerDuty =
      task.duty === 'plan_review' || task.duty === 'plan_adoption' || task.duty === 'code_review'
    let answerConfirmation = false
    if (
      delta.operation === 'confirm' &&
      current?.questionId &&
      current.answerResolver === run.agentId &&
      ['decision', 'information'].includes(current.kind) &&
      ['open', 'awaiting_review'].includes(current.status)
    ) {
      for (const sourceId of delta.userSourceIds) {
        const answer = this.database
          .select({ id: conversationInputBatchMembers.memberId })
          .from(collaborationRequiredInputMembers)
          .innerJoin(
            conversationInputBatchMembers,
            and(
              eq(conversationInputBatchMembers.batchId, collaborationRequiredInputMembers.batchId),
              eq(
                conversationInputBatchMembers.memberId,
                collaborationRequiredInputMembers.memberId,
              ),
            ),
          )
          .innerJoin(
            anchoredComments,
            eq(anchoredComments.id, conversationInputBatchMembers.commentId),
          )
          .where(
            and(
              eq(collaborationRequiredInputMembers.runId, run.id),
              eq(conversationInputBatchMembers.commentId, sourceId),
              ne(conversationInputBatchMembers.state, 'withdrawn'),
              isNotNull(anchoredComments.sentWithMessageId),
              eq(conversationInputBatchMembers.sourceTaskId, task.id),
              eq(conversationInputBatchMembers.sourceTodoId, delta.todoId),
              eq(conversationInputBatchMembers.questionId, current.questionId),
              eq(conversationInputBatchMembers.questionRevision, current.questionRevision!),
            ),
          )
          .limit(1)
          .get()
        if (answer) {
          answerConfirmation = true
          break
        }
      }
    }
    if (
      delta.operation === 'confirm' &&
      !answerConfirmation &&
      (!reviewerDuty ||
        current?.status !== 'awaiting_review' ||
        this.findRun(current.sourceRunId)?.agentId === run.agentId)
    )
      throw new RunOperationConflictError(
        'Only an independent reviewer can confirm the exact proposed resolution.',
      )
    if (
      delta.operation === 'reopen' &&
      (current?.status !== 'done' || !delta.reason.trim() || !delta.evidenceRefs.length)
    )
      throw new RunOperationConflictError(
        'Reopening a settled Todo requires new evidence and a reason.',
      )
    if (current?.status === 'done' && !['reopen'].includes(delta.operation))
      throw new RunOperationConflictError(
        'A settled Todo must be explicitly reopened before changing it.',
      )
    if (
      ['propose_resolution', 'confirm'].includes(delta.operation) &&
      (!delta.reason.trim() || !delta.resolutionKind)
    )
      throw new RunOperationConflictError(
        'Every proposed or confirmed closure needs a resolution kind and concrete reason.',
      )
    if (delta.resolutionKind === 'merged') {
      if (!delta.mergeTargetId || delta.mergeTargetId === delta.todoId)
        throw new RunOperationConflictError('A merged Todo requires a distinct same-task target.')
      const target = this.database
        .select()
        .from(collaborationTodos)
        .where(
          and(
            eq(collaborationTodos.taskId, task.id),
            eq(collaborationTodos.todoId, delta.mergeTargetId),
          ),
        )
        .get()
      if (!target)
        throw new RunOperationConflictError('The merge target is unavailable in this task.')
      const cycle = this.database.get<{ found: number }>(sql`WITH RECURSIVE links(id) AS (
        SELECT ${delta.mergeTargetId} UNION SELECT t.merged_into FROM collaboration_todos t JOIN links l ON l.id=t.todo_id
        WHERE t.task_id=${task.id} AND t.merged_into IS NOT NULL)
        SELECT 1 AS found FROM links WHERE id=${delta.todoId} LIMIT 1`)
      if (cycle) throw new RunOperationConflictError('Todo merges cannot form a cycle.')
    } else if (delta.mergeTargetId)
      throw new RunOperationConflictError('Only a merge resolution can name a merge target.')
    const userSources: Array<{
      id: string
      batchId: string
      memberId: string
      bodyDocument: CollaborationDocument
      anchorDocument?: CollaborationDocument
    }> = []
    let hasOlderQuestionAnswer = false,
      hasCurrentQuestionAnswer = false
    for (const sourceId of delta.userSourceIds) {
      const source = this.database
        .select({ id: anchoredComments.id })
        .from(anchoredComments)
        .innerJoin(
          conversationInputBatchMembers,
          eq(conversationInputBatchMembers.commentId, anchoredComments.id),
        )
        .innerJoin(
          collaborationRequiredInputMembers,
          and(
            eq(collaborationRequiredInputMembers.batchId, conversationInputBatchMembers.batchId),
            eq(collaborationRequiredInputMembers.memberId, conversationInputBatchMembers.memberId),
          ),
        )
        .where(
          and(
            eq(collaborationRequiredInputMembers.runId, run.id),
            eq(anchoredComments.id, sourceId),
            isNotNull(anchoredComments.sentWithMessageId),
          ),
        )
        .limit(1)
        .get()
      const bodySource = this.database.get<{
        found: number
      }>(sql`SELECT 1 AS found FROM collaboration_required_input_members r
        JOIN conversation_input_batches b ON b.id=r.batch_id WHERE r.run_id=${run.id} AND r.member_id='$body' AND b.message_id=${sourceId} LIMIT 1`)
      const historical = this.database
        .select({ member: conversationInputBatchMembers, batch: conversationInputBatches })
        .from(conversationInputBatchMembers)
        .innerJoin(
          conversationInputBatches,
          eq(conversationInputBatches.id, conversationInputBatchMembers.batchId),
        )
        .where(
          and(
            eq(conversationInputBatches.taskId, task.id),
            lte(
              conversationInputBatches.sequence,
              this.collaborationTurnAuthorization(run.id)!.inputSequence,
            ),
            eq(conversationInputBatchMembers.commentId, sourceId),
          ),
        )
        .limit(1)
        .get()
      const historicalBody = this.database
        .select()
        .from(conversationInputBatches)
        .where(
          and(
            eq(conversationInputBatches.taskId, task.id),
            lte(
              conversationInputBatches.sequence,
              this.collaborationTurnAuthorization(run.id)!.inputSequence,
            ),
            eq(conversationInputBatches.messageId, sourceId),
          ),
        )
        .limit(1)
        .get()
      if (
        current?.questionId &&
        historical?.member.sourceTaskId === task.id &&
        historical.member.sourceTodoId === delta.todoId &&
        historical.member.questionId
      ) {
        if (
          historical.member.questionId === current.questionId &&
          historical.member.questionRevision === current.questionRevision
        )
          hasCurrentQuestionAnswer = true
        else hasOlderQuestionAnswer = true
      }
      if (!source && !bodySource && !historical && !historicalBody)
        throw new RunOperationConflictError(
          'A user decision must cite a real authorized sent Comment, answer, or Batch message.',
        )
      if (historical?.member.bodyDocumentJson)
        userSources.push({
          id: sourceId,
          batchId: historical.batch.id,
          memberId: historical.member.memberId,
          bodyDocument: JSON.parse(historical.member.bodyDocumentJson),
          ...(historical.member.anchorDocumentJson
            ? { anchorDocument: JSON.parse(historical.member.anchorDocumentJson) }
            : {}),
        })
      else if (historicalBody?.bodyDocumentJson)
        userSources.push({
          id: sourceId,
          batchId: historicalBody.id,
          memberId: '$body',
          bodyDocument: JSON.parse(historicalBody.bodyDocumentJson),
        })
    }
    if (
      ['propose_resolution', 'confirm'].includes(delta.operation) &&
      hasOlderQuestionAnswer &&
      !hasCurrentQuestionAnswer
    )
      throw new RunOperationConflictError(
        'An older question answer cannot settle the current question version.',
      )
    for (const ref of delta.evidenceRefs)
      if (!this.sourceDocumentAuthorized(run.id, ref))
        throw new RunOperationConflictError(
          'The evidence source is outside the frozen authorization.',
        )
    if (
      delta.operation === 'create' &&
      (!delta.kind || !delta.title?.trim() || !delta.detail?.trim())
    )
      throw new RunOperationConflictError(
        'A new Todo requires its kind, title, and problem with impact.',
      )
    if (
      delta.question &&
      current?.questionRevision &&
      delta.question.revision < current.questionRevision
    )
      throw new RunOperationConflictError(
        'A question definition cannot move to an earlier revision.',
      )
    const previous = current
      ? storedObject(
          this.collaborationDocumentText(run.sessionId, JSON.parse(current.contentDocumentJson)),
        )
      : {}
    if (
      delta.question &&
      current?.questionRevision === delta.question.revision &&
      JSON.stringify(previous.question) !== JSON.stringify(delta.question)
    )
      throw new RunOperationConflictError(
        'A changed question definition requires a new question revision.',
      )
    if (
      delta.question &&
      current?.questionId &&
      current.questionId !== delta.question.id &&
      delta.operation !== 'reopen'
    )
      throw new RunOperationConflictError('An existing question identity must remain stable.')
    const resolutionKind = resetsResolution
      ? null
      : (delta.resolutionKind ?? current?.resolutionKind ?? null)
    const content: Record<string, unknown> = {
      ...previous,
      id: delta.todoId,
      taskId: task.id,
      ...Object.fromEntries(
        ['kind', 'title', 'detail', 'recommendation', 'evidence', 'question']
          .filter((key) => Reflect.get(delta, key) !== null)
          .map((key) => [key, Reflect.get(delta, key)]),
      ),
      reason: delta.reason,
      resolutionKind,
      mergeTargetId: delta.mergeTargetId,
      userSourceIds: delta.userSourceIds,
      userSources,
      evidenceRefs: delta.evidenceRefs,
    }
    const question =
      delta.question ??
      (current?.questionJson
        ? collaborationTodoQuestionSchema.parse(JSON.parse(current.questionJson))
        : null)
    const effectiveKind = delta.kind ?? current!.kind
    if (!question && ['decision', 'information'].includes(effectiveKind))
      throw new RunOperationConflictError(
        'A user decision or information Todo requires a complete question definition.',
      )
    if (
      question &&
      ((question.type === 'choice' && effectiveKind !== 'decision') ||
        (question.type === 'text' && effectiveKind !== 'information'))
    )
      throw new RunOperationConflictError(
        'The effective Todo kind must match its retained question definition.',
      )
    const status =
      delta.operation === 'confirm'
        ? 'done'
        : delta.operation === 'propose_resolution'
          ? 'awaiting_review'
          : current?.status === 'awaiting_review' &&
              delta.operation === 'update' &&
              !questionChanged
            ? 'awaiting_review'
            : 'open'
    const contentDocument = this.saveCollaborationDocument(run.id, JSON.stringify(content))
    const display = [
      typeof content.title === 'string' && content.title.length > 180
        ? `**Title**\n\n${content.title}`
        : '',
      typeof content.detail === 'string' ? `**Problem & impact**\n\n${content.detail}` : '',
      typeof content.recommendation === 'string'
        ? `**Suggestion**\n\n${content.recommendation}`
        : '',
      typeof content.evidence === 'string' ? `**Evidence**\n\n${content.evidence}` : '',
      delta.reason.trim()
        ? `**${status === 'done' ? 'Resolution' : 'Handling'}**\n\n${delta.reason}`
        : '',
      question ? `**Question**\n\n${question.question}\n\n${question.reason}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const displayDocument = this.saveCollaborationDocument(
      run.id,
      display || (typeof content.title === 'string' ? content.title : delta.todoId),
    )
    const reasonDocument = delta.reason.trim()
      ? this.saveCollaborationDocument(run.id, delta.reason)
      : current?.reasonDocumentJson
        ? collaborationDocumentSchema.parse(JSON.parse(current.reasonDocumentJson))
        : undefined
    const values: typeof collaborationTodos.$inferInsert = {
      taskId: task.id,
      todoId: delta.todoId,
      revision: delta.expectedRevision + 1,
      ledgerRevision,
      ordinal:
        current?.ordinal ??
        (this.database
          .select({ value: max(collaborationTodos.ordinal) })
          .from(collaborationTodos)
          .where(eq(collaborationTodos.taskId, task.id))
          .get()?.value ?? -1) + 1,
      kind: effectiveKind,
      status,
      titlePreview: (delta.title ?? current!.titlePreview).slice(0, 180),
      author: current?.author ?? run.agentId,
      sourceRunId: run.id,
      documentJson: JSON.stringify(displayDocument),
      documentId: displayDocument.id,
      contentDocumentJson: JSON.stringify(contentDocument),
      contentDocumentId: contentDocument.id,
      reasonDocumentJson: reasonDocument ? JSON.stringify(reasonDocument) : null,
      reasonDocumentId: reasonDocument?.id,
      resolutionKind,
      mergedInto: delta.mergeTargetId,
      questionId: question?.id,
      questionRevision: question?.revision,
      questionJson: question ? JSON.stringify(question) : null,
      answerResolver: question?.answerResolver,
      confirmedBy: status === 'done' ? run.agentId : null,
      confirmedRunId: status === 'done' ? run.id : null,
      updatedAt: new Date().toISOString(),
    }
    this.database
      .insert(collaborationTodos)
      .values(values)
      .onConflictDoUpdate({
        target: [collaborationTodos.taskId, collaborationTodos.todoId],
        set: values,
      })
      .run()
    this.database.insert(collaborationTodoRevisions).values(values).run()
  }

  private advanceInputWatermark(taskId: string) {
    // Close only fully settled batches; a later successful batch never jumps an earlier gap.
    this.database
      .run(sql`UPDATE conversation_input_batches SET state='closed',closed_at=${new Date().toISOString()}
      WHERE task_id=${taskId} AND state='open' AND body_state IN ('resolved','withdrawn')
      AND NOT EXISTS (SELECT 1 FROM conversation_input_batch_members m WHERE m.batch_id=conversation_input_batches.id AND m.state NOT IN ('resolved','withdrawn'))`)
    const task = this.database
      .select()
      .from(collaborationTasks)
      .where(eq(collaborationTasks.id, taskId))
      .get()!
    const gap = this.database
      .select({ sequence: conversationInputBatches.sequence })
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.taskId, taskId),
          eq(conversationInputBatches.state, 'open'),
          gt(conversationInputBatches.sequence, task.processedWatermark),
        ),
      )
      .orderBy(asc(conversationInputBatches.sequence))
      .limit(1)
      .get()
    const watermark = gap ? gap.sequence - 1 : task.inputSequence
    this.database
      .update(collaborationTasks)
      .set({ processedWatermark: watermark })
      .where(eq(collaborationTasks.id, taskId))
      .run()
    return watermark
  }

  private withdrawInputBatch(batchId: string) {
    const batch = this.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, batchId))
      .get()
    if (!batch) return
    const now = new Date().toISOString()
    this.database
      .update(conversationInputBatchMembers)
      .set({ state: 'withdrawn', updatedAt: now })
      .where(eq(conversationInputBatchMembers.batchId, batchId))
      .run()
    this.database
      .update(conversationInputBatches)
      .set({ bodyState: 'withdrawn', state: 'closed', closedAt: now })
      .where(eq(conversationInputBatches.id, batchId))
      .run()
    if (batch.taskId) this.advanceInputWatermark(batch.taskId)
  }

  private applyIndexedInputResponses(task: CollaborationTask, run: AgentRun) {
    const missing = this.database.get<{
      memberId: string
    }>(sql`SELECT r.member_id AS memberId FROM collaboration_required_input_members r
      LEFT JOIN collaboration_result_input_responses s ON s.run_id=r.run_id AND s.batch_id=r.batch_id AND s.member_id=r.member_id
      WHERE r.run_id=${run.id} AND s.member_id IS NULL LIMIT 1`)
    const foreign = this.database.get<{
      memberId: string
    }>(sql`SELECT s.member_id AS memberId FROM collaboration_result_input_responses s
      LEFT JOIN collaboration_required_input_members r ON r.run_id=s.run_id AND r.batch_id=s.batch_id AND r.member_id=s.member_id
      WHERE s.run_id=${run.id} AND r.member_id IS NULL LIMIT 1`)
    if (missing || foreign)
      throw new RunOperationConflictError(
        'Every authorized input member must have exactly one response; foreign members are invalid.',
      )
    let cursor = ''
    for (;;) {
      const rows = this.database
        .select()
        .from(collaborationResultInputResponses)
        .where(
          and(
            eq(collaborationResultInputResponses.runId, run.id),
            sql`${collaborationResultInputResponses.batchId} || ':' || ${collaborationResultInputResponses.memberId} > ${cursor}`,
          ),
        )
        .orderBy(
          asc(collaborationResultInputResponses.batchId),
          asc(collaborationResultInputResponses.memberId),
        )
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!rows.length) break
      for (const row of rows) {
        const response = this.readIndexedResponse(run.sessionId, row)
        const reason = this.saveCollaborationDocument(run.id, response.reason)
        if (response.memberId === '$body') {
          const bodyTodo = response.todoId
            ? this.database
                .select()
                .from(collaborationTodos)
                .where(
                  and(
                    eq(collaborationTodos.taskId, task.id),
                    eq(collaborationTodos.todoId, response.todoId),
                  ),
                )
                .get()
            : undefined
          if (response.todoId && !bodyTodo)
            throw new RunOperationConflictError(
              'The input body response names an unavailable Todo.',
            )
          const hasProposals =
            ['plan_submission', 'stage_result'].includes(
              task.duty ?? collaborationSubmission(task),
            ) &&
            Boolean(
              this.database
                .select({ id: collaborationTodos.todoId })
                .from(collaborationTodos)
                .where(
                  and(
                    eq(collaborationTodos.taskId, task.id),
                    eq(collaborationTodos.status, 'awaiting_review'),
                  ),
                )
                .limit(1)
                .get(),
            )
          const effective =
            response.disposition === 'resolved' &&
            (hasProposals || (bodyTodo && bodyTodo.status !== 'done'))
              ? 'awaiting_confirmation'
              : response.disposition
          this.database
            .update(conversationInputBatches)
            .set({
              bodyState: effective,
            })
            .where(
              and(
                eq(conversationInputBatches.id, response.batchId),
                eq(conversationInputBatches.taskId, task.id),
              ),
            )
            .run()
          this.database
            .update(collaborationResultInputResponses)
            .set({ disposition: effective, todoId: response.todoId })
            .where(
              and(
                eq(collaborationResultInputResponses.runId, run.id),
                eq(collaborationResultInputResponses.batchId, response.batchId),
                eq(collaborationResultInputResponses.memberId, response.memberId),
              ),
            )
            .run()
          continue
        }
        const member = this.database
          .select()
          .from(conversationInputBatchMembers)
          .where(
            and(
              eq(conversationInputBatchMembers.batchId, response.batchId),
              eq(conversationInputBatchMembers.memberId, response.memberId),
            ),
          )
          .get()
        if (!member) throw new RunOperationConflictError('The frozen input member is unavailable.')
        const relatedTodo =
          response.todoId ?? (member.sourceTaskId === task.id ? member.sourceTodoId : null)
        let todo = relatedTodo
          ? this.database
              .select()
              .from(collaborationTodos)
              .where(
                and(
                  eq(collaborationTodos.taskId, task.id),
                  eq(collaborationTodos.todoId, relatedTodo),
                ),
              )
              .get()
          : undefined
        if (response.todoId && !todo)
          throw new RunOperationConflictError('An input response names an unavailable Todo.')
        const anchor = commentAnchorSchema.parse(JSON.parse(member.anchorJson))
        const staleAnswer = Boolean(
          todo &&
          anchor.type === 'todo' &&
          anchor.question &&
          (todo.questionId !== anchor.question.id ||
            todo.questionRevision !== anchor.question.revision),
        )
        if (staleAnswer && response.todoId !== null)
          throw new RunOperationConflictError('An answer cannot resolve another question revision.')
        if (staleAnswer) todo = undefined
        const confirmed = todo?.status === 'done'
        let state = response.disposition
        if (
          state === 'resolved' &&
          ((member.answerResolver && member.answerResolver !== run.agentId && !confirmed) ||
            (todo && !confirmed))
        )
          state = 'awaiting_confirmation'
        this.database
          .update(conversationInputBatchMembers)
          .set({
            state,
            responseRunId: run.id,
            responseDocumentJson: JSON.stringify(reason),
            todoId: staleAnswer ? null : relatedTodo,
          })
          .where(
            and(
              eq(conversationInputBatchMembers.batchId, response.batchId),
              eq(conversationInputBatchMembers.memberId, response.memberId),
              notInArray(conversationInputBatchMembers.state, ['resolved', 'withdrawn']),
            ),
          )
          .run()
        this.database
          .update(collaborationResultInputResponses)
          .set({ disposition: state, todoId: staleAnswer ? null : relatedTodo })
          .where(
            and(
              eq(collaborationResultInputResponses.runId, run.id),
              eq(collaborationResultInputResponses.batchId, response.batchId),
              eq(collaborationResultInputResponses.memberId, response.memberId),
            ),
          )
          .run()
      }
      cursor = `${rows.at(-1)!.batchId}:${rows.at(-1)!.memberId}`
    }
    const recovery = this.collaborationTurnAuthorization(run.id)?.reportSourceRunId
    if (recovery) {
      this.database
        .run(sql`UPDATE conversation_input_batches SET body_state='resolved',state='closed',closed_at=${new Date().toISOString()}
        WHERE task_id=${task.id} AND member_count=0 AND run_id IN (
          SELECT a.run_id FROM collaboration_turn_authorizations a WHERE a.task_id=${task.id}
          AND json_extract(a.authorization_json,'$.reportSourceRunId')=${recovery})`)
      this.nativeFact(run.id, 'collaboration.report_submission_controls_settled', {
        sourceRunId: recovery,
      })
    }
    return this.advanceInputWatermark(task.id)
  }

  private applyIndexedCollaborationResult(
    task: CollaborationTask,
    runId: string,
  ): CollaborationTask {
    return this.database.transaction(() => {
      const run = this.findRun(runId),
        indexed = this.indexedResultManifest(runId),
        auth = this.collaborationTurnAuthorization(runId)
      if (
        !run ||
        !indexed ||
        !auth ||
        auth.taskId !== task.id ||
        auth.actor !== run.agentId ||
        task.actor !== run.agentId ||
        run.dispatchPhase !== 'ended' ||
        run.nativeOutcome !== 'completed' ||
        run.controlDisposition === 'abandoned'
      )
        throw new RunOperationConflictError(
          'Only the matching completed Native Turn can settle its submitted result.',
        )
      if (indexed.row.state === 'applied') return this.collaboration(task.sessionId) ?? task
      if (indexed.row.state !== 'archived')
        throw new RunOperationConflictError(
          'This original result is not eligible for reapplication.',
        )
      const prepared = { ...task, duty: auth.duty, authorization: auth }
      const manifest = indexed.manifest
      if (
        auth.duty === 'plan_adoption' &&
        !manifest.planDocument &&
        (!manifest.header.verdict ||
          JSON.stringify(manifest.header.reviewedPlan) !== JSON.stringify(auth.basePlanRef))
      )
        throw new RunOperationConflictError(
          'Unchanged initial-plan adoption requires an explicit verdict for the exact original draft.',
        )
      if (['plan_submission', 'plan_adoption'].includes(auth.duty) && !manifest.planDocument) {
        if (
          !manifest.header.plan ||
          typeof manifest.header.plan !== 'object' ||
          JSON.stringify(manifest.header.plan) !== JSON.stringify(task.planReference) ||
          JSON.stringify(auth.basePlanRef) !== JSON.stringify(task.planReference)
        )
          throw new RunOperationConflictError(
            'Every plan response must submit a complete plan or the exact frozen current reference.',
          )
      }
      if (
        auth.duty === 'plan_adoption' &&
        manifest.planDocument &&
        manifest.header.verdict === 'accepted'
      )
        throw new RunOperationConflictError(
          'Initial plan adoption requires an exact unchanged reference; a revised plan needs independent review.',
        )
      if (
        auth.duty === 'code_review' &&
        (run.agentId !== task.reviewer || task.reviewer === task.implementer)
      )
        throw new RunOperationConflictError('Code review must use the frozen independent reviewer.')
      if (
        auth.duty === 'code_review' &&
        JSON.stringify(manifest.header.reviewScopeRef) !==
          JSON.stringify(auth.reviewScopeRef ?? undefined)
      )
        throw new RunOperationConflictError(
          'The review scope does not match the exact frozen reference.',
        )
      if (manifest.planDocument) {
        if (
          !['plan_submission', 'plan_adoption'].includes(auth.duty) ||
          (task.planVersion && run.agentId !== task.primary) ||
          (!task.planVersion && run.agentId !== task.drafter)
        )
          throw new RunOperationConflictError(
            'Only the frozen authorized plan owner can publish this plan.',
          )
        if (manifest.planDocument.sha256 !== task.planDocument?.sha256) {
          prepared.planVersion++
          prepared.planAuthor = run.agentId
          prepared.reviewedPlan = undefined
          prepared.approvedPlanVersion = undefined
          prepared.planDocument = manifest.planDocument
          prepared.plan = undefined
          prepared.planReference = {
            type: 'unchanged',
            version: prepared.planVersion,
            sourceRunId: runId,
            sha256: manifest.planDocument.sha256,
          }
        }
      }
      const row = this.database
        .select()
        .from(collaborationTasks)
        .where(eq(collaborationTasks.id, task.id))
        .get()!
      const ledgerRevision = manifest.todoCount ? row.ledgerRevision + 1 : row.ledgerRevision
      let questionCursor = -1,
        newQuestions = 0
      for (;;) {
        const candidates = this.database
          .select()
          .from(collaborationResultOperations)
          .where(
            and(
              eq(collaborationResultOperations.runId, runId),
              gt(collaborationResultOperations.ordinal, questionCursor),
            ),
          )
          .orderBy(asc(collaborationResultOperations.ordinal))
          .limit(COLLABORATION_INDEX_ITEMS)
          .all()
        if (!candidates.length) break
        for (const candidate of candidates) {
          const delta = this.readIndexedDelta(run.sessionId, candidate)
          if (!delta.question) continue
          const baseline = this.database
            .select({
              id: collaborationTodoRevisions.questionId,
              revision: collaborationTodoRevisions.questionRevision,
            })
            .from(collaborationTodoRevisions)
            .where(
              and(
                eq(collaborationTodoRevisions.taskId, task.id),
                eq(collaborationTodoRevisions.todoId, delta.todoId),
                lte(collaborationTodoRevisions.ledgerRevision, auth.baseTodoRevision),
              ),
            )
            .orderBy(desc(collaborationTodoRevisions.revision))
            .limit(1)
            .get()
          if (
            !baseline?.id ||
            baseline.id !== delta.question.id ||
            baseline.revision !== delta.question.revision
          )
            newQuestions++
          if (newQuestions > 3)
            throw new RunOperationConflictError(
              'Ask at most three new material questions per Turn; existing questions and answers remain preserved.',
            )
        }
        questionCursor = candidates.at(-1)!.ordinal
      }
      let ordinal = -1
      for (;;) {
        const page = this.database
          .select()
          .from(collaborationResultOperations)
          .where(
            and(
              eq(collaborationResultOperations.runId, runId),
              gt(collaborationResultOperations.ordinal, ordinal),
            ),
          )
          .orderBy(asc(collaborationResultOperations.ordinal))
          .limit(COLLABORATION_INDEX_ITEMS)
          .all()
        if (!page.length) break
        for (const operation of page)
          this.applyTodoDelta(
            prepared,
            run,
            this.readIndexedDelta(run.sessionId, operation),
            ledgerRevision,
          )
        ordinal = page.at(-1)!.ordinal
      }
      this.database
        .update(collaborationTasks)
        .set({ ledgerRevision })
        .where(eq(collaborationTasks.id, task.id))
        .run()
      const processedWatermark = this.applyIndexedInputResponses(prepared, run)
      const counts = this.todoCounts(task.id)
      prepared.ledgerRevision = ledgerRevision
      prepared.ledgerOpenCount = counts.open
      prepared.ledgerAwaitingCount = counts.awaiting
      prepared.questionPendingCount = counts.questions
      prepared.unansweredCount = this.database.get<{
        count: number
      }>(sql`SELECT count(*) AS count FROM collaboration_todos t
        WHERE t.task_id=${task.id} AND t.status<>'done' AND t.question_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM conversation_input_batch_members m JOIN conversation_input_batches b ON b.id=m.batch_id
          WHERE b.task_id=t.task_id AND m.source_task_id=t.task_id AND m.source_todo_id=t.todo_id
          AND m.question_id=t.question_id AND m.question_revision=t.question_revision AND m.state<>'withdrawn')`).count
      prepared.inputSequence = row.inputSequence
      prepared.processedWatermark = processedWatermark
      const result = {
        ...manifest.header,
        ...(manifest.planDocument ? { plan: prepared.planReference } : {}),
      }
      if (result.verdict === 'accepted') {
        if (counts.open || counts.awaiting)
          throw new RunOperationConflictError(
            'This review cannot be accepted while Todo resolutions still await confirmation.',
          )
        if (prepared.unansweredCount)
          throw new RunOperationConflictError(
            'This review cannot be accepted while a required user answer is missing.',
          )
        if (processedWatermark < auth.inputSequence)
          throw new RunOperationConflictError(
            'This review cannot be accepted while required input responses remain unresolved. Settle them using their actual responsibility or submit a blocked review.',
          )
      }
      const adoptionReview = auth.duty === 'plan_adoption' && !manifest.planDocument
      if (
        (['plan_review', 'code_review'].includes(auth.duty) || adoptionReview) &&
        result.verdict
      ) {
        if (
          auth.duty !== 'code_review' &&
          (prepared.planAuthor === run.agentId ||
            JSON.stringify(result.reviewedPlan) !== JSON.stringify(prepared.planReference))
        )
          throw new RunOperationConflictError(
            'Plan acceptance must review the exact current version independently.',
          )
        this.database
          .insert(collaborationReviewFacts)
          .values({
            id: runId,
            taskId: task.id,
            runId,
            reviewer: run.agentId,
            phase: auth.duty === 'code_review' ? 'code' : 'plan',
            basisJson: JSON.stringify(
              auth.duty === 'code_review' ? auth.reviewScopeRef : auth.basePlanRef,
            ),
            ledgerRevision,
            inputWatermark: processedWatermark,
            verdict: result.verdict,
            createdAt: new Date().toISOString(),
          })
          .run()
      }
      if (auth.reportSourceRunId && result.outcome !== 'complete') {
        const source = this.findRun(auth.reportSourceRunId)
        const sourceAuth = this.collaborationTurnAuthorization(auth.reportSourceRunId)
        const sourceStage = source?.collaboration?.stage
        if (
          source?.sessionId === task.sessionId &&
          source.collaboration?.taskId === task.id &&
          source.nativeOutcome === 'completed' &&
          source.dispatchPhase === 'ended' &&
          sourceAuth?.taskId === task.id &&
          sourceAuth.actor === source.agentId &&
          sourceAuth.duty === 'stage_result' &&
          !sourceAuth.reportSourceRunId &&
          (sourceStage === 'implement' || sourceStage === 'repair')
        ) {
          // The resubmission restores the original writing goal, without making
          // this report-only Turn a new implementation or changing its scope.
          prepared.resumePhase = {
            stage: sourceStage,
            actor: source.agentId,
            status:
              result.outcome === 'needs_user'
                ? 'questions'
                : result.outcome === 'blocked'
                  ? 'failed'
                  : 'waiting',
            workPending: true,
          }
        }
      }
      const next = settleCollaboration(prepared, result, {
        ledgerRevision,
        ledgerOpenCount: counts.open,
        ledgerAwaitingCount: counts.awaiting,
        doneTodoCount: counts.done,
        unansweredCount: prepared.unansweredCount,
        questionPendingCount: counts.questions,
        inputSequence: row.inputSequence,
        processedWatermark,
        planApplied: true,
        planChanged: prepared.planVersion !== task.planVersion,
        acceptedReview:
          result.verdict === 'accepted' &&
          (['plan_review', 'code_review'].includes(auth.duty) || adoptionReview),
        reviewInputSequence: auth.inputSequence,
      })
      next.resultDocument = manifest.source
      next.result = undefined
      next.sourceMessageId = run.responseMessageId ?? task.sourceMessageId
      this.database
        .update(collaborationResultApplications)
        .set({
          state: 'applied',
          settlementRevision: ledgerRevision,
          appliedAt: new Date().toISOString(),
        })
        .where(eq(collaborationResultApplications.runId, runId))
        .run()
      this.saveCollaboration(next)
      return next
    })
  }

  private saveSubmittedReport(runId: string, result: CollaborationResult): string {
    const source = this.saveCollaborationDocument(runId, JSON.stringify(result))
    const manifest = this.database.transaction(() =>
      this.archiveIndexedResult(runId, result, source),
    )
    return JSON.stringify({
      source,
      header: manifest.header,
      documents: [
        { key: 'summary', source: manifest.summaryDocument },
        ...(manifest.planDocument ? [{ key: 'plan', source: manifest.planDocument }] : []),
      ],
      feedbackCount: manifest.todoCount,
      hasOpenDecision: false,
    })
  }

  recordCollaborationCarrierText(runId: string, text: string): void {
    const run = this.findRun(runId)
    if (!run?.answerFormat) return
    this.database.transaction(() => {
      const original = this.collaborationCarrierSource(run.sessionId, runId)
      const frozen = this.database
        .select({ source: collaborationTurns.nativeEnvelopeBodyId })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, runId))
        .get()
      if (frozen?.source) {
        if (original?.sha256 !== createHash('sha256').update(text).digest('hex'))
          throw new RunOperationConflictError(
            'A different carrier cannot replace the original final submission.',
          )
        return
      }
      const source = this.saveCollaborationDocument(runId, text)
      this.database
        .update(collaborationTurns)
        .set({ pendingEnvelopeBodyId: source.id })
        .where(eq(collaborationTurns.runId, runId))
        .run()
    })
  }

  /** Original Native carrier and natural display are separate from immutable Message proof. */
  recordCollaborationCarrier(runId: string, carrier: unknown): void {
    const run = this.findRun(runId)
    if (!run?.answerFormat || !carrier || typeof carrier !== 'object' || Array.isArray(carrier))
      return
    const frozen = this.database
      .select()
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    if (!frozen) return
    this.database.transaction(() => {
      const source =
        this.collaborationCarrierSource(run.sessionId, runId) ??
        this.saveCollaborationDocument(runId, JSON.stringify(carrier))
      // The parsed DTO is a projection of these saved Native bytes, never a second authority.
      const original: unknown = JSON.parse(this.collaborationDocumentText(run.sessionId, source))
      if (!original || typeof original !== 'object' || !isDeepStrictEqual(original, carrier))
        throw new RunOperationConflictError(
          'The result does not match the original final submission.',
        )
      const answer = Reflect.get(original, 'answer')
      const projection =
        typeof answer === 'string' && answer.trim()
          ? this.saveCollaborationDocument(runId, answer)
          : undefined
      this.database
        .update(collaborationTurns)
        .set({ nativeEnvelopeBodyId: source.id, answerProjectionBodyId: projection?.id ?? null })
        .where(eq(collaborationTurns.runId, runId))
        .run()
    })
  }

  private withPlanReference(task: CollaborationTask): CollaborationTask {
    if (!task.plan || !task.planVersion) return task
    const sha256 = createHash('sha256').update(task.plan).digest('hex')
    const reference =
      task.planReference?.version === task.planVersion && task.planReference.sha256 === sha256
        ? task.planReference
        : { type: 'unchanged' as const, version: task.planVersion, sourceRunId: task.runId, sha256 }
    return {
      ...task,
      planReference: reference,
      result:
        task.result && typeof task.result.plan === 'string'
          ? { ...task.result, plan: reference }
          : task.result,
    }
  }

  /** Read exactly one immutable submitted report; candidates retain their independent acceptance state. */
  collaborationReportSource(sessionId: string, runId: string): CollaborationResult | undefined {
    const run = this.findRun(runId)
    if (!run || run.sessionId !== sessionId)
      throw new RunOperationConflictError('The Review source is unavailable.')
    const row = this.database
      .select({ result: collaborationTurns.resultJson })
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    if (!row?.result) return undefined
    return this.storedResult(sessionId, row.result)
  }

  private saveCollaboration(task: CollaborationTask): void {
    const persistent = this.database
      .select()
      .from(collaborationTasks)
      .where(eq(collaborationTasks.id, task.id))
      .get()
    if (persistent) {
      task = {
        ...task,
        ledgerRevision: persistent.ledgerRevision,
        inputSequence: persistent.inputSequence,
        processedWatermark: persistent.processedWatermark,
        questionPendingCount: this.todoCounts(task.id).questions,
      }
    }
    task = this.withPlanReference(task)
    collaborationTaskSchema.parse(task)
    const stored = JSON.stringify(this.storedCollaboration(task))
    this.database
      .update(collaborationTasks)
      .set({ stateJson: stored, updatedAt: new Date().toISOString() })
      .where(eq(collaborationTasks.id, task.id))
      .run()
    const run = this.findRun(task.runId)
    if (run)
      this.database
        .update(agentRuns)
        .set({
          updatedAt: new Date(Math.max(Date.now(), Date.parse(run.updatedAt) + 1)).toISOString(),
        })
        .where(eq(agentRuns.id, run.id))
        .run()
    this.database
      .update(collaborationTurns)
      .set({ stateJson: stored })
      .where(eq(collaborationTurns.runId, task.runId))
      .run()
  }

  setCollaborationState(task: CollaborationTask): ConversationPatch {
    this.saveCollaboration(task)
    return this.metadataPatch(task.sessionId)
  }

  pauseCollaboration(sessionId: string): ConversationPatch {
    const task = this.collaboration(sessionId)
    if (task && task.status !== 'complete') {
      if (task.status !== 'paused')
        task.pausedStatus = task.status === 'running' ? 'failed' : task.status
      task.status = 'paused'
      task.revision++
      task.notice = 'Paused by the user. Existing feedback and code changes are preserved.'
      this.saveCollaboration(task)
    }
    return this.metadataPatch(sessionId)
  }

  recordCollaborationReportFailure(runId: string, reason: 'missing' | 'invalid'): void {
    const run = this.findRun(runId)
    const task = run ? this.collaboration(run.sessionId) : undefined
    if (!task || task.runId !== runId || task.status !== 'running') return
    task.reportFailure = reason
    this.saveCollaboration(task)
  }

  /** Cold/late native facts are immutable recovery material, not workflow acceptance. */
  recordRecoveredCollaborationResult(runId: string, result: CollaborationResult): void {
    const run = this.findRun(runId)
    if (!run || !run.answerFormat) return
    const frozen = this.database
      .select()
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    if (!frozen) throw new RunOperationConflictError('The submitted report has no frozen duty.')
    const parsed = this.verifiedCollaborationResult(run, result),
      json = JSON.stringify(parsed)
    if (frozen.resultJson) {
      if (
        this.indexedResultManifest(runId)?.row.digest !==
        createHash('sha256').update(json).digest('hex')
      )
        throw new RunOperationConflictError('A different report cannot replace this Turn’s source.')
      return
    }
    this.database
      .update(collaborationTurns)
      .set({ resultJson: this.saveSubmittedReport(runId, parsed) })
      .where(eq(collaborationTurns.runId, runId))
      .run()
    const active = this.collaboration(run.sessionId),
      task = active?.runId === runId ? active : this.decodedCollaboration(frozen.stateJson)
    if (task.result) return
    task.reportFailure ??= 'missing'
    task.notice ??=
      'The submitted report was recovered. Acceptance still requires a valid report submission.'
    if (active?.runId === runId) this.saveCollaboration(task)
    else {
      task.status = 'failed'
      this.database
        .update(collaborationTurns)
        .set({ stateJson: JSON.stringify(this.storedCollaboration(task)) })
        .where(eq(collaborationTurns.runId, runId))
        .run()
    }
  }

  private verifiedCollaborationResult(
    run: AgentRun,
    result: CollaborationResult,
  ): CollaborationResult {
    const parsed = collaborationResultSchema.parse(result)
    const source = this.collaborationCarrierSource(run.sessionId, run.id)
    if (source) {
      const envelope = collaborationEnvelopeSchema.parse(
        JSON.parse(this.collaborationDocumentText(run.sessionId, source)),
      )
      if (!isDeepStrictEqual(envelope.result, parsed))
        throw new RunOperationConflictError('The report does not match its original submission.')
    }
    return parsed
  }

  /** Revalidate an authenticated original ending; no model input, no counters or stale-task promotion. */
  reconcileCompletedCollaboration(input: {
    runId: string
    nativeSessionId: string
    nativeTurnId: string
    revision: number
    source: 'live_terminal' | 'stored_terminal'
    executorId?: string
  }): ConversationPatch {
    return this.database.transaction(() => {
      const run = this.findRun(input.runId)
      if (
        !run ||
        run.nativeSessionId !== input.nativeSessionId ||
        run.nativeTurnId !== input.nativeTurnId ||
        run.dispatchPhase !== 'ended' ||
        run.nativeOutcome !== 'completed' ||
        run.controlDisposition === 'abandoned' ||
        !run.responseMessageId
      )
        throw new RunOperationConflictError(
          'The original completed Native identity is unavailable.',
        )
      const binding = this.nativeContext(run.sessionId, run.agentId)
      if (
        !binding ||
        !this.ownsNativeControl(run.id) ||
        !this.isCurrentNativeCursor(run, binding) ||
        !this.hasCompleteResponse(run.id) ||
        (input.source === 'live_terminal' &&
          (!input.executorId ||
            input.executorId !== run.executorId ||
            binding.executorId !== input.executorId))
      )
        throw new RunOperationConflictError(
          'The completed report no longer owns this native binding and visible response.',
        )
      const original = this.collaborationCarrierSource(run.sessionId, run.id)
      if (!original)
        throw new RunOperationConflictError('The original final submission is unavailable.')
      // Authenticated native bytes remain immutable evidence; cold workflow settlement uses its compiled indexes.
      this.collaborationDocumentRow(run.sessionId, original)
      const indexed = this.indexedResultManifest(run.id)
      if (!indexed)
        throw new RunOperationConflictError(
          'The original result has not been indexed; submit the missing report explicitly.',
        )
      const task = this.collaboration(run.sessionId)
      if (task?.runId !== run.id || indexed.row.state === 'applied') return this.runPatch(run.id)
      const completedFailureRevision = this.database
        .select({ revision: collaborationTurns.completedFailureRevision })
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, run.id))
        .get()?.revision
      if (
        completedFailureRevision == null ||
        task.revision !== completedFailureRevision ||
        task.revision !== input.revision ||
        task.status !== 'failed' ||
        !task.reportFailure
      )
        throw new RunOperationConflictError(
          'The task advanced before its original report could be reconciled.',
        )
      const authorization = this.collaborationTurnAuthorization(run.id)
      if (
        !authorization ||
        authorization.taskId !== task.id ||
        authorization.actor !== task.actor ||
        authorization.baseTodoRevision !== task.ledgerRevision ||
        !isDeepStrictEqual(authorization.basePlanRef, task.planReference ?? null)
      )
        throw new RunOperationConflictError(
          'The completed report no longer matches the frozen plan and Todo basis.',
        )
      const next = this.applyIndexedCollaborationResult(task, run.id)
      next.sourceMessageId = run.responseMessageId
      this.saveCollaboration(next)
      this.nativeFact(run.id, 'collaboration.report_reconciled', {
        revision: input.revision,
        nativeSessionId: input.nativeSessionId,
        nativeTurnId: input.nativeTurnId,
        resultDocument: next.resultDocument?.id,
        modelCalls: 0,
      })
      return this.runPatch(run.id)
    })
  }

  recordCollaborationResult(runId: string, result: CollaborationResult): void {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The collaboration Run is unavailable.')
    const task = this.collaboration(run.sessionId)
    const frozen = this.database
      .select()
      .from(collaborationTurns)
      .where(eq(collaborationTurns.runId, runId))
      .get()
    if (!task || task.runId !== runId || task.status !== 'running' || !frozen)
      throw new RunOperationConflictError('The collaboration result belongs to a retired task.')
    const parsed = this.verifiedCollaborationResult(run, result)
    if (
      frozen.resultJson &&
      this.indexedResultManifest(runId)?.row.digest !==
        createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
    )
      throw new RunOperationConflictError('This Turn already reported a different result.')
    this.database
      .update(collaborationTurns)
      .set({ resultJson: this.saveSubmittedReport(runId, parsed) })
      .where(eq(collaborationTurns.runId, runId))
      .run()
    if (parsed.submission !== this.collaborationTurnAuthorization(runId)?.duty) {
      task.reportFailure = 'invalid'
      task.notice = 'The result does not match the frozen responsibility.'
    } else {
      task.reportFailure = undefined
      task.notice = undefined
    }
    this.saveCollaboration(task)
  }

  finishCollaboration(runId: string, complete: boolean, notice?: string): void {
    this.database.transaction(() => {
      const run = this.findRun(runId)
      if (!run) return
      const task = this.collaboration(run.sessionId)
      if (!task || task.runId !== runId || !['running', 'failed'].includes(task.status)) return
      const frozen = this.database
        .select()
        .from(collaborationTurns)
        .where(eq(collaborationTurns.runId, runId))
        .get()
      const nativeCompleted =
        complete && run.dispatchPhase === 'ended' && run.nativeOutcome === 'completed'
      // A repeated terminal may not move or renew an already frozen recovery boundary.
      if (
        nativeCompleted &&
        (frozen?.completedFailureRevision != null ||
          (task.status === 'failed' && task.reportFailure))
      )
        return
      let next = task
      if (complete && !task.reportFailure && frozen?.resultJson) {
        try {
          next = this.applyIndexedCollaborationResult(task, runId)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The required result is invalid.'
          task.reportFailure = 'invalid'
          task.status = 'failed'
          task.notice = message
          task.revision++
          this.database
            .update(collaborationResultApplications)
            .set({ state: message.includes('advanced') ? 'stale' : 'invalid', reason: message })
            .where(
              and(
                eq(collaborationResultApplications.runId, runId),
                eq(collaborationResultApplications.state, 'archived'),
              ),
            )
            .run()
          next = task
        }
      } else {
        next.status = 'failed'
        next.revision++
        const unstarted =
          (run.dispatchPhase === 'not_sent' || run.dispatchPhase === 'rejected') &&
          run.nativeEffectsState === 'not_dispatched'
        const nativeUnfinished =
          run.dispatchPhase === 'ended' &&
          (run.nativeOutcome === 'failed' || run.nativeOutcome === 'interrupted')
        if (
          !task.reportRecovery &&
          (task.stage === 'implement' || task.stage === 'repair') &&
          (unstarted || nativeUnfinished)
        ) {
          next.resumePhase = {
            ...task.resumePhase,
            stage: task.stage,
            actor: task.actor,
            status: 'failed',
            workPending: true,
            ...(unstarted ? { unstarted: true } : {}),
          }
        }
        next.notice =
          notice ??
          (task.reportFailure === 'invalid' ? task.notice : undefined) ??
          (complete
            ? 'The answer was received, but the required report is missing or invalid. Review acceptance is not established.'
            : 'This Turn did not complete. Check delivery before retrying.')
        if (complete && !frozen?.resultJson) next.reportFailure ??= 'missing'
        if (run.dispatchPhase === 'not_sent' || run.dispatchPhase === 'rejected') {
          const prior = task.previousRunId
            ? this.database
                .select()
                .from(collaborationTurns)
                .where(eq(collaborationTurns.runId, task.previousRunId))
                .get()
            : undefined
          const old = prior ? this.decodedCollaboration(prior.stateJson) : undefined
          next.discussionRounds = old?.discussionRounds ?? 0
          next.discussionHalf = old?.discussionHalf ?? false
          next.reviewCycles = old?.reviewCycles ?? 0
          next.repairAttempts = old?.repairAttempts ?? 0
          next.releasedReservation = true
        }
      }
      if (run.responseMessageId) next.sourceMessageId = run.responseMessageId
      this.saveCollaboration(next)
      if (nativeCompleted && next.status === 'failed' && next.reportFailure)
        this.database
          .update(collaborationTurns)
          .set({ completedFailureRevision: next.revision })
          .where(
            and(
              eq(collaborationTurns.runId, runId),
              sql`${collaborationTurns.completedFailureRevision} IS NULL`,
            ),
          )
          .run()
    })
  }

  readPage(input: ConversationGetInput): ConversationPage {
    if (input.scope === 'collaboration-markdown') {
      const row = this.collaborationDocumentRow(input.sessionId, input.document)
      if (row.sourceRunId !== input.runId)
        throw new RunOperationConflictError('The source Run changed.')
      if (input.basis === 'plain-visible-v1' || row.projectionBasis === 'plain-visible-v1') {
        let start =
          input.aroundOffset !== undefined ? Math.max(0, input.aroundOffset - 128) : input.offset
        if (
          start > 0 &&
          /[\uDC00-\uDFFF]/u.test(
            this.collaborationRawRange(
              input.sessionId,
              input.document,
              start,
              Math.min(row.chars, start + 1),
            ),
          )
        )
          start--
        let end = Math.min(row.chars, start + 8192)
        let text = this.collaborationRawRange(input.sessionId, input.document, start, end)
        if (end < row.chars && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) {
          text = text.slice(0, -1)
          end--
        }
        return {
          scope: 'collaboration-markdown',
          basis: 'plain-visible-v1',
          sessionId: input.sessionId,
          document: input.document,
          offset: start,
          visibleStart: start,
          visibleEnd: end,
          tree: {
            type: 'root',
            children: [
              {
                type: 'element',
                tagName: 'span',
                properties: {
                  'data-pact-node-id': 0,
                  'data-pact-projection-start': start,
                  'data-pact-projection-end': end,
                },
                children: [{ type: 'text', value: text }],
              },
            ],
          },
          previousOffset: start ? Math.max(0, start - 8192) : null,
          nextOffset: end < row.chars ? end : null,
        }
      }
      if (row.sourceRunId !== input.runId || row.projectionPages === null)
        throw new RunOperationConflictError('The Markdown source is not ready.')
      const page = this.database
        .select()
        .from(collaborationMarkdownPages)
        .where(
          and(
            eq(collaborationMarkdownPages.documentId, row.id),
            input.aroundOffset !== undefined
              ? and(
                  lte(collaborationMarkdownPages.visibleStart, input.aroundOffset),
                  gt(collaborationMarkdownPages.visibleEnd, input.aroundOffset),
                )
              : eq(collaborationMarkdownPages.ordinal, input.offset),
          ),
        )
        .orderBy(desc(collaborationMarkdownPages.visibleStart))
        .limit(1)
        .get()
      if (!page) throw new RunOperationConflictError('The Markdown page is unavailable.')
      return {
        scope: 'collaboration-markdown',
        basis: 'markdown-visible-v2',
        sessionId: input.sessionId,
        document: input.document,
        offset: page.ordinal,
        visibleStart: page.visibleStart,
        visibleEnd: page.visibleEnd,
        tree: collaborationMarkdownNodeSchema.parse(JSON.parse(page.treeJson)),
        previousOffset: page.ordinal ? page.ordinal - 1 : null,
        nextOffset: page.ordinal + 1 < row.projectionPages ? page.ordinal + 1 : null,
      }
    }
    if (input.scope === 'collaboration-text') {
      const run = this.findRun(input.runId)
      if (!run || run.sessionId !== input.sessionId)
        throw new RunOperationConflictError('The source Run is unavailable.')
      const row = this.collaborationDocumentRow(input.sessionId, input.document)
      if (row.sourceRunId !== input.runId)
        throw new RunOperationConflictError(
          'The document does not belong to the requested source Run.',
        )
      if (input.offset > row.chars) throw new RunOperationConflictError('Invalid document offset.')
      const parts = this.database
        .select()
        .from(conversationBodyParts)
        .where(
          and(
            eq(conversationBodyParts.inputId, row.id),
            lte(conversationBodyParts.offset, input.offset),
          ),
        )
        .orderBy(desc(conversationBodyParts.offset))
        .limit(1)
        .all()
      const part = parts[0]
      let text = part ? part.text.slice(input.offset - part.offset) : ''
      while (Buffer.byteLength(JSON.stringify({ text })) > 40 * 1024)
        text = text.slice(0, Math.max(1, text.length - 256))
      if (text.length && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) text = text.slice(0, -1)
      return {
        scope: 'collaboration-text',
        sessionId: input.sessionId,
        document: input.document,
        offset: input.offset,
        text,
        nextOffset: input.offset + text.length < row.chars ? input.offset + text.length : null,
      }
    }
    if (input.scope === 'collaboration') {
      const taskRow = input.taskId
        ? this.database
            .select()
            .from(collaborationTasks)
            .where(
              and(
                eq(collaborationTasks.id, input.taskId),
                eq(collaborationTasks.sessionId, input.sessionId),
              ),
            )
            .get()
        : undefined
      const task = taskRow
          ? this.decodedCollaboration(taskRow.stateJson, false)
          : this.collaboration(input.sessionId, input.runId, false),
        active = this.collaboration(input.sessionId, undefined, false)
      const indexed = task ? this.indexedResultManifest(task.runId) : undefined
      const todoSummaries =
        task && indexed
          ? this.database
              .select({
                id: collaborationResultOperations.todoId,
                title: collaborationResultOperations.titlePreview,
                expectedRevision: collaborationResultOperations.expectedRevision,
              })
              .from(collaborationResultOperations)
              .where(eq(collaborationResultOperations.runId, task.runId))
              .orderBy(asc(collaborationResultOperations.ordinal))
              .limit(COLLABORATION_INDEX_ITEMS)
              .all()
              .map((item) => ({
                id: item.id,
                title: item.title,
                revision: item.expectedRevision + 1,
              }))
          : []
      const result = indexed
        ? { ...indexed.manifest.header, summary: '', todoDeltas: [], inputResponses: [] }
        : undefined
      const currentRow = task
        ? this.database
            .select()
            .from(collaborationTasks)
            .where(eq(collaborationTasks.id, task.id))
            .get()
        : undefined
      const todoHead =
        task && input.todoId
          ? this.database
              .select({
                revision: collaborationTodos.revision,
                ordinal: collaborationTodos.ordinal,
                status: collaborationTodos.status,
              })
              .from(collaborationTodos)
              .where(
                and(
                  eq(collaborationTodos.taskId, task.id),
                  eq(collaborationTodos.todoId, input.todoId),
                ),
              )
              .get()
          : undefined
      if (task && input.todoId && input.todoRevision === undefined && !todoHead)
        throw new RunOperationConflictError('The Todo source is unavailable.')
      const todo =
        task && input.todoId
          ? this.readTodoRevision(task.id, input.todoId, input.todoRevision ?? todoHead!.revision)
          : undefined
      if (input.todoStatus === 'source' && (!todo || input.projection !== 'todos'))
        throw new RunOperationConflictError('Todo source navigation requires an exact Todo.')
      const todoGroup =
        input.todoStatus === 'source'
          ? (todoHead?.status ?? todo!.status) === 'done'
            ? 'done'
            : 'active'
          : (input.todoStatus ?? 'active')
      let todoAfterOrdinal = (input.todoOffset ?? 0) - 1
      if (input.todoStatus === 'source' && todoHead) {
        // Seek the current item's group and page; the referenced version stays separate.
        const preceding = this.database
          .select({
            ordinal: collaborationTodos.ordinal,
            bytes: todoProjectionBytes(
              collaborationTodos.titlePreview,
              collaborationTodos.questionJson,
            ),
          })
          .from(collaborationTodos)
          .where(
            and(
              eq(collaborationTodos.taskId, task!.id),
              lte(collaborationTodos.ordinal, todoHead.ordinal),
              todoGroup === 'done'
                ? eq(collaborationTodos.status, 'done')
                : ne(collaborationTodos.status, 'done'),
            ),
          )
          .orderBy(desc(collaborationTodos.ordinal))
          .limit(COLLABORATION_INDEX_ITEMS)
          .all()
        todoAfterOrdinal = admittedTodoOrdinal(preceding, COLLABORATION_INDEX_BYTES - 16 * 1024) - 1
      }
      const todos =
        task && input.projection === 'todos'
          ? this.readCollaborationTodos(
              task.id,
              input.ledgerRevision ?? currentRow!.ledgerRevision,
              todoGroup,
              todoAfterOrdinal,
            )
          : undefined
      const source = task?.planReference
        ? this.database
            .select({ runId: agentRuns.id, messageId: agentRuns.userMessageId })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, task.planReference.sourceRunId),
                eq(agentRuns.sessionId, input.sessionId),
              ),
            )
            .get()
        : undefined
      const receipt = this.receivedCollaborationInput(input.sessionId, true)
      const received =
        receipt && receipt.taskId === task?.id && receipt.state !== 'materialized'
          ? receipt
          : undefined
      return {
        scope: 'collaboration',
        sessionId: input.sessionId,
        view: collaborationViewSchema.parse({
          task: task
            ? {
                ...task,
                priorResult: undefined,
                result: input.projection === 'report' ? result : undefined,
                plan: undefined,
              }
            : null,
          accepted: indexed?.row.state === 'applied',
          reportAvailable: Boolean(indexed),
          todoSummaries,
          ...(indexed && input.projection === 'report'
            ? {
                documents: [{ key: 'summary', source: indexed.manifest.summaryDocument }],
                feedbackCount: indexed.manifest.todoCount,
              }
            : {}),
          ...(source ? { planSource: source } : {}),
          ...(todos ? { todos } : {}),
          ...(todo
            ? {
                todo,
                todoCurrent: todoHead
                  ? { revision: todoHead.revision, status: todoHead.status }
                  : null,
              }
            : {}),
          ...(received
            ? {
                received: {
                  id: received.id,
                  actor: received.actor,
                  state: received.state,
                  preview:
                    'A message and its attachments were durably received; no Agent Turn has started.',
                },
              }
            : {}),
          actionable: Boolean(
            (!received || received.state === 'cancelled') &&
            task &&
            active &&
            task.runId === active.runId &&
            task.revision === active.revision &&
            task.status !== 'running',
          ),
        }),
      }
    }
    if (input.scope === 'rebuild-input')
      return this.readReturnedInput(input.sessionId, input.operationId, input.offset)
    this.pageReadCount += 1
    // All reads in this method are synchronous on the Utility's single SQLite connection.
    // Message/Activity sequences and Comment positions never change, so keyset cursors stay
    // traversable during appends. Draft membership alone uses commentsRevision as a fence.
    const session = this.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    if (!session) throw new Error('Session does not exist.')
    const observation = this.currentObservation(input.sessionId)

    if (input.scope === 'run-artifacts') {
      this.requireIncarnation(input.sessionId, input.incarnation)
      const group = this.readRunArtifacts(input.sessionId, [input.userMessageId]).find(
        (item) => item.agentId === input.agentId,
      )
      const latest = group?.latestRunId
        ? this.database
            .select(publicRunColumns)
            .from(agentRuns)
            .where(eq(agentRuns.id, group.latestRunId))
            .get()
        : undefined
      const before =
        input.before ?? (latest ? { createdAt: latest.createdAt, id: latest.id } : undefined)
      const rows = !before
        ? []
        : this.database
            .select(publicRunColumns)
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.sessionId, input.sessionId),
                eq(agentRuns.userMessageId, input.userMessageId),
                eq(agentRuns.agentId, input.agentId),
                or(eq(agentRuns.controlDisposition, 'abandoned'), visibleWorkspaceArtifact),
                or(
                  lt(agentRuns.createdAt, before.createdAt),
                  and(eq(agentRuns.createdAt, before.createdAt), lt(agentRuns.id, before.id)),
                ),
              ),
            )
            .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
            .limit(4)
            .all()
      const page: Extract<ConversationPage, { scope: 'run-artifacts' }> = {
        scope: 'run-artifacts',
        sessionId: input.sessionId,
        observation,
        userMessageId: input.userMessageId,
        agentId: input.agentId,
        totalCount: group?.totalCount ?? 0,
        runs: [],
        ...(latest ? { latestRunId: latest.id } : {}),
      }
      for (const row of rows.slice(0, 3)) {
        page.runs.push(ConversationRepository.toRun(row))
        if (!ConversationRepository.fitsPage(page)) {
          page.runs.pop()
          if (!page.runs.length) throw new OversizedConversationEntityError()
          break
        }
      }
      const last = page.runs.at(-1)
      if (last && rows.length > page.runs.length)
        page.nextBefore = { createdAt: last.createdAt, id: last.id }
      if (!ConversationRepository.fitsPage(page)) throw new OversizedConversationEntityError()
      return page
    }

    if (input.scope === 'messages') {
      this.requireIncarnation(input.sessionId, input.incarnation)
      if (
        Number(input.beforeSequence !== undefined) + Number(input.aroundMessageId !== undefined) >
        1
      ) {
        throw new Error('Choose one Conversation history direction.')
      }
      let target = input.aroundMessageId
        ? this.database
            .select({
              id: conversationMessages.id,
              sequence: conversationMessages.sequence,
              replyTo: conversationMessages.replyToMessageId,
              agentId: conversationMessages.agentId,
              visible: conversationMessages.isVisible,
            })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, input.aroundMessageId),
                eq(conversationMessages.sessionId, input.sessionId),
              ),
            )
            .get()
        : undefined
      if (target && !target.visible && !input.includeHistoricalSource && target.replyTo) {
        target = this.database
          .select({
            id: conversationMessages.id,
            sequence: conversationMessages.sequence,
            replyTo: conversationMessages.replyToMessageId,
            agentId: conversationMessages.agentId,
            visible: conversationMessages.isVisible,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.replyToMessageId, target.replyTo),
              eq(conversationMessages.role, 'assistant'),
              ...(target.agentId ? [eq(conversationMessages.agentId, target.agentId)] : []),
              eq(conversationMessages.isVisible, true),
            ),
          )
          .get()
      }
      const targetSequence = target?.sequence
      if (input.aroundMessageId && targetSequence === undefined) {
        throw new Error('The selected Message is unavailable.')
      }
      // For a direct Comment jump, admit the target first. Filling context before the
      // target could exhaust the byte budget and return a page that never contains it.
      const goingNewer = targetSequence !== undefined
      const conditions = and(
        eq(conversationMessages.sessionId, input.sessionId),
        eq(conversationMessages.isVisible, true),
        target && input.includeHistoricalSource
          ? sql`(${conversationMessages.id} <> ${target.id} AND
              (${target.replyTo} IS NULL OR ${conversationMessages.replyToMessageId} IS NULL OR
                ${conversationMessages.replyToMessageId} <> ${target.replyTo} OR
                ${target.agentId} IS NULL OR ${conversationMessages.agentId} IS NULL OR
                ${conversationMessages.agentId} <> ${target.agentId}))`
          : undefined,
        input.beforeSequence === undefined
          ? undefined
          : lt(conversationMessages.sequence, input.beforeSequence),
        targetSequence === undefined
          ? undefined
          : gte(conversationMessages.sequence, targetSequence),
      )
      const messageQuery = () =>
        this.database
          .select({
            id: conversationMessages.id,
            sessionId: conversationMessages.sessionId,
            runId: conversationMessages.runId,
            replyToMessageId: conversationMessages.replyToMessageId,
            role: conversationMessages.role,
            agentId: conversationMessages.agentId,
            routeKind: conversationMessages.routeKind,
            routeAgentsJson: conversationMessages.routeAgentsJson,
            routePendingAgentId: conversationMessages.routePendingAgentId,
            sourceMessageId: conversationMessages.sourceMessageId,
            skillsJson: sql<
              string | null
            >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
            state: conversationMessages.state,
            sequence: conversationMessages.sequence,
            createdAt: conversationMessages.createdAt,
            updatedAt: conversationMessages.updatedAt,
            contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
            contentRevision: conversationMessages.contentRevision,
            // The outer column must remain qualified: a raw interpolated column here
            // renders unqualified and SQLite resolves it against the inner table.
            hasActivities: sql<number>`EXISTS (SELECT 1 FROM agent_run_activities a WHERE a.run_id = "conversation_messages"."run_id" LIMIT 1)`,
            hasComments: sql<number>`EXISTS (SELECT 1 FROM anchored_comments c WHERE c.sent_with_message_id = "conversation_messages"."id" LIMIT 1)`,
            content: sql<string>`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${INLINE_CONTENT_BYTES} THEN ${conversationMessages.content} ELSE substr(${conversationMessages.content}, 1, ${BODY_PREVIEW_CHARS}) END`,
          })
          .from(conversationMessages)
      const candidates = messageQuery()
        .where(conditions)
        .orderBy(
          goingNewer ? asc(conversationMessages.sequence) : desc(conversationMessages.sequence),
        )
        .limit(CONVERSATION_PAGE_ITEMS + 1)
        .all()
      if (target && input.includeHistoricalSource) {
        // Read an old source by primary key separately so hidden retries cannot
        // turn around-navigation into a scan of every superseded response.
        const source = messageQuery().where(eq(conversationMessages.id, target.id)).get()
        if (source) candidates.unshift(source)
      }
      const latestRunRow = this.database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(and(eq(agentRuns.sessionId, input.sessionId), isNull(agentRuns.forkSourceRunId)))
        .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get()
      const latestRun = latestRunRow ? ConversationRepository.toRun(latestRunRow) : undefined
      const latestCompleteAssistantSequence = this.database
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, input.sessionId),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            eq(conversationMessages.isVisible, true),
          ),
        )
        .get()?.value
      const title = projectSessionTitle(session.title, session.titleSource)
      const receivedInput = this.receivedCollaborationInput(input.sessionId)
      const header: Extract<ConversationPage, { scope: 'messages' }>['header'] = {
        ...(receivedInput ? { receivedInputIds: [receivedInput.id] } : {}),
        session: {
          id: session.id,
          title: title.title,
          titleSource: title.titleSource,
          status: session.status,
          activity: deriveSessionActivity(session.status, latestRun),
          hasUnread: hasUnreadSessionMessage(
            session.lastSeenMessageSequence,
            latestCompleteAssistantSequence ?? undefined,
          ),
          updatedAt: session.updatedAt,
        },
        commentsRevision: session.commentsRevision,
        nativeContexts: this.nativeContexts(input.sessionId),
        rebuildOperations: this.rebuildOperations(input.sessionId),
        rebuildInputRecovery: this.rebuildInputRecovery(input.sessionId),
        forkOperation: this.forkOperation(input.sessionId),
        ...(latestRun ? { latestRun } : {}),
        ...(latestCompleteAssistantSequence === null ||
        latestCompleteAssistantSequence === undefined
          ? {}
          : { latestCompleteAssistantSequence }),
      }
      const page: Extract<ConversationPage, { scope: 'messages' }> = {
        scope: 'messages',
        sessionId: input.sessionId,
        observation,
        header,
        messages: [],
        runs: [],
        runArtifacts: [],
        hasOlder: false,
        hasNewer: false,
        ...(target && input.includeHistoricalSource ? { sourceMessageId: target.id } : {}),
      }
      const candidateRunIds = [
        ...new Set(candidates.flatMap((candidate) => (candidate.runId ? [candidate.runId] : []))),
      ]
      const candidateRuns = new Map(
        (candidateRunIds.length === 0
          ? []
          : this.database
              .select(publicRunColumns)
              .from(agentRuns)
              .where(inArray(agentRuns.id, candidateRunIds))
              .all()
        ).map((run) => [run.id, run]),
      )
      const candidateArtifacts = this.readRunArtifacts(input.sessionId, [
        ...new Set(candidates.map((candidate) => candidate.replyToMessageId ?? candidate.id)),
      ])
      const artifactRuns = new Map(
        candidateArtifacts.map((group) => {
          const row = this.database
            .select(publicRunColumns)
            .from(agentRuns)
            .where(eq(agentRuns.id, group.latestRunId))
            .get()
          return [group.latestRunId, row] as const
        }),
      )
      const candidateImages = this.imagesForMessages(candidates.map((row) => row.id))
      const runIds = new Set<string>()
      for (const row of candidates.slice(0, CONVERSATION_PAGE_ITEMS)) {
        const natural =
          row.role === 'assistant'
            ? this.naturalMessageProjection(row.id, input.sessionId)
            : undefined
        if (natural !== undefined) {
          row.content = natural
          row.contentBytes = Buffer.byteLength(natural)
        }
        const previousRuns = [...page.runs]
        const previousArtifacts = [...page.runArtifacts!]
        const message = {
          id: row.id,
          sessionId: row.sessionId,
          role: row.role,
          state: row.state,
          sequence: row.sequence,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          contentRevision: row.contentRevision,
          ...(candidateImages.get(row.id)?.length ? { images: candidateImages.get(row.id)! } : {}),
          ...(row.runId ? { runId: row.runId } : {}),
          ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
          ...(row.agentId ? { agentId: row.agentId } : {}),
          ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
          ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
          ...ConversationRepository.toMessageRoute(row),
          ...ConversationRepository.toMessageSkills(row),
        }
        const pageMessage =
          row.contentBytes > INLINE_CONTENT_BYTES
            ? ({
                kind: 'oversized',
                message,
                contentBytes: row.contentBytes,
                preview: row.content,
                previewChars: Array.from(row.content).length,
                hasActivities: Boolean(row.hasActivities),
                hasComments: Boolean(row.hasComments),
              } as const)
            : ({
                kind: 'complete',
                message: { ...message, content: row.content },
                hasActivities: Boolean(row.hasActivities),
                hasComments: Boolean(row.hasComments),
              } as const)
        const candidateRun =
          row.runId && !runIds.has(row.runId) ? candidateRuns.get(row.runId) : undefined
        page.messages.push(pageMessage)
        if (candidateRun) {
          const runSummary = ConversationRepository.toRun(candidateRun)
          delete runSummary.failureMessage
          page.runs.push(runSummary)
          runIds.add(candidateRun.id)
        }
        const userId = row.replyToMessageId ?? row.id
        for (const group of candidateArtifacts.filter((item) => item.userMessageId === userId)) {
          if (page.runArtifacts!.some((item) => item.latestRunId === group.latestRunId)) continue
          page.runArtifacts!.push(group)
          const latest = artifactRuns.get(group.latestRunId)
          if (latest && !runIds.has(latest.id)) {
            const summary = ConversationRepository.toRun(latest)
            delete summary.failureMessage
            page.runs.push(summary)
            runIds.add(latest.id)
          }
        }
        if (page.runs.length > CONVERSATION_PAGE_ITEMS || !ConversationRepository.fitsPage(page)) {
          // A rejected candidate is not passed by the cursor. The caller can retry it on
          // the next page, and a first-item failure is visible instead of an empty loop.
          page.messages.pop()
          page.runs = previousRuns
          page.runArtifacts = previousArtifacts
          runIds.clear()
          for (const run of previousRuns) runIds.add(run.id)
          if (page.messages.length === 0) throw new OversizedConversationEntityError()
          break
        }
      }
      if (!goingNewer) page.messages.reverse()
      const first = page.messages[0]?.message.sequence
      const last = page.messages.at(-1)?.message.sequence
      page.hasOlder =
        first !== undefined &&
        Boolean(
          this.database
            .select({ id: conversationMessages.id })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.sessionId, input.sessionId),
                eq(conversationMessages.isVisible, true),
                lt(conversationMessages.sequence, first),
              ),
            )
            .limit(1)
            .get(),
        )
      page.hasNewer =
        last !== undefined &&
        Boolean(
          this.database
            .select({ id: conversationMessages.id })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.sessionId, input.sessionId),
                eq(conversationMessages.isVisible, true),
                gt(conversationMessages.sequence, last),
              ),
            )
            .limit(1)
            .get(),
        )
      if (!ConversationRepository.fitsPage(page)) throw new OversizedConversationEntityError()
      if (target && input.includeHistoricalSource && !target.visible) page.hasNewer = true
      return page
    }

    if (input.scope === 'activity-body') {
      const source = this.database
        .select({
          revision: agentRunActivities.detailRevision,
          chars: sql<number>`length(${agentRunActivities.detail})`,
          text: sql<string>`substr(${agentRunActivities.detail}, ${input.offset + 1}, ${BODY_CHUNK_CHARS})`,
        })
        .from(agentRunActivities)
        .where(
          and(
            eq(agentRunActivities.id, input.activityId),
            eq(agentRunActivities.sessionId, input.sessionId),
          ),
        )
        .get()
      if (!source) throw new Error('The selected Conversation item is unavailable.')
      if (source.revision !== input.detailRevision) throw new StaleConversationCursorError()
      if (input.offset > (source.chars ?? 0)) throw new Error('Body offset is invalid.')
      const nextOffset = input.offset + Array.from(source.text ?? '').length
      const page: Extract<ConversationPage, { scope: 'activity-body' }> = {
        scope: 'activity-body',
        sessionId: input.sessionId,
        observation,
        activityId: input.activityId,
        detailRevision: input.detailRevision,
        offset: input.offset,
        text: source.text ?? '',
        ...(nextOffset < (source.chars ?? 0) ? { nextOffset } : {}),
      }
      if (!ConversationRepository.fitsPage(page)) throw new OversizedConversationEntityError()
      return page
    }

    if (input.scope === 'drafts' || input.scope === 'comments') {
      if (
        input.scope === 'drafts' &&
        input.expectedRevision !== undefined &&
        input.expectedRevision !== session.commentsRevision
      ) {
        throw new StaleConversationCursorError()
      }
      const rows = this.database
        .select()
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.sessionId, input.sessionId),
            input.scope === 'drafts'
              ? sql`${anchoredComments.sentWithMessageId} IS NULL AND ${anchoredComments.pendingReceiptId} IS NULL`
              : inArray(anchoredComments.sentWithMessageId, input.messageIds),
            input.afterPosition === undefined
              ? undefined
              : gt(anchoredComments.position, input.afterPosition),
          ),
        )
        .orderBy(asc(anchoredComments.position))
        .limit(CONVERSATION_PAGE_ITEMS + 1)
        .all()
      const page: Extract<ConversationPage, { scope: 'drafts' | 'comments' }> =
        input.scope === 'drafts'
          ? {
              scope: 'drafts',
              sessionId: input.sessionId,
              observation,
              commentsRevision: session.commentsRevision,
              comments: [],
              hasMore: false,
            }
          : {
              scope: 'comments',
              sessionId: input.sessionId,
              observation,
              comments: [],
              hasMore: false,
            }
      for (const row of rows.slice(0, CONVERSATION_PAGE_ITEMS)) {
        page.comments.push(ConversationRepository.toComment(row))
        if (!ConversationRepository.fitsPage(page)) {
          page.comments.pop()
          if (page.comments.length === 0) throw new OversizedConversationEntityError()
          break
        }
      }
      page.hasMore = rows.length > page.comments.length
      return page
    }

    const rows = this.database
      .select({
        id: agentRunActivities.id,
        sessionId: agentRunActivities.sessionId,
        runId: agentRunActivities.runId,
        agentId: agentRunActivities.agentId,
        nativeId: agentRunActivities.nativeId,
        kind: agentRunActivities.kind,
        toolName: agentRunActivities.toolName,
        title: agentRunActivities.title,
        status: agentRunActivities.status,
        sequence: agentRunActivities.sequence,
        createdAt: agentRunActivities.createdAt,
        updatedAt: agentRunActivities.updatedAt,
        detailRevision: agentRunActivities.detailRevision,
        detailBytes: sql<number>`length(CAST(${agentRunActivities.detail} AS BLOB))`,
        detail: sql<
          string | null
        >`CASE WHEN length(CAST(${agentRunActivities.detail} AS BLOB)) <= ${INLINE_CONTENT_BYTES} THEN ${agentRunActivities.detail} ELSE substr(${agentRunActivities.detail}, 1, ${BODY_PREVIEW_CHARS}) END`,
      })
      .from(agentRunActivities)
      .where(
        and(
          eq(agentRunActivities.sessionId, input.sessionId),
          eq(agentRunActivities.runId, input.runId),
        ),
      )
      .orderBy(desc(agentRunActivities.sequence))
      .limit(CONVERSATION_WORK_LOG_ITEMS + 1)
      .all()
    const page: Extract<ConversationPage, { scope: 'activities' }> = {
      scope: 'activities',
      sessionId: input.sessionId,
      observation,
      runId: input.runId,
      activities: [],
      truncated: false,
    }
    for (const row of rows.slice(0, CONVERSATION_WORK_LOG_ITEMS)) {
      const activity = ConversationRepository.toActivity({ ...row, detail: row.detail })
      const activityWithoutDetail = { ...activity }
      delete activityWithoutDetail.detail
      page.activities.push(
        row.detailBytes > INLINE_CONTENT_BYTES
          ? {
              kind: 'oversized',
              activity: activityWithoutDetail,
              detailBytes: row.detailBytes,
              preview: row.detail ?? '',
              previewChars: Array.from(row.detail ?? '').length,
            }
          : { kind: 'complete', activity },
      )
      if (!ConversationRepository.fitsPage(page)) {
        page.activities.pop()
        if (page.activities.length === 0) throw new OversizedConversationEntityError()
        break
      }
    }
    page.activities.reverse()
    page.truncated = rows.length > page.activities.length
    return page
  }

  message(messageId: string, sessionId: string): ConversationMessage | undefined {
    const row = this.database
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        runId: conversationMessages.runId,
        replyToMessageId: conversationMessages.replyToMessageId,
        role: conversationMessages.role,
        agentId: conversationMessages.agentId,
        routeKind: conversationMessages.routeKind,
        routeAgentsJson: conversationMessages.routeAgentsJson,
        routePendingAgentId: conversationMessages.routePendingAgentId,
        sourceMessageId: conversationMessages.sourceMessageId,
        skillsJson: sql<
          string | null
        >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
        state: conversationMessages.state,
        sequence: conversationMessages.sequence,
        createdAt: conversationMessages.createdAt,
        updatedAt: conversationMessages.updatedAt,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        contentRevision: conversationMessages.contentRevision,
        content: sql<
          string | null
        >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${CONVERSATION_MARKDOWN_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      })
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
      )
      .get()
    if (!row) return undefined
    if (row.content === null) throw new OversizedConversationEntityError()
    return this.toMessage({ ...row, content: row.content })
  }

  /** Internal consumers may hydrate one complete body within the existing 8 MiB work budget. */
  internalMessage(messageId: string, sessionId: string): ConversationMessage | undefined {
    const row = this.database
      .select({
        ...getTableColumns(conversationMessages),
        content: sql<
          string | null
        >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      })
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
      )
      .get()
    if (!row) return undefined
    if (row.content === null)
      throw new RunOperationConflictError(
        'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
      )
    return this.toMessage({ ...row, content: row.content })
  }

  messageMetadata(
    messageId: string,
    sessionId: string,
  ): { contentRevision: number; contentBytes: number } | undefined {
    return this.database
      .select({
        contentRevision: conversationMessages.contentRevision,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
      })
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.id, messageId), eq(conversationMessages.sessionId, sessionId)),
      )
      .get()
  }

  private sessionProjection(sessionId: string): ConversationSnapshot['session'] {
    const session = this.database.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    if (!session) throw new Error('Session does not exist.')
    const latestRunRow = this.database
      .select(publicRunColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          ne(agentRuns.controlDisposition, 'abandoned'),
          isNull(agentRuns.forkSourceRunId),
          sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    const latestRun = latestRunRow ? ConversationRepository.toRun(latestRunRow) : undefined
    const latestCompleteAssistantSequence = this.database
      .select({ value: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.state, 'complete'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .get()?.value
    const title = projectSessionTitle(session.title, session.titleSource)
    return {
      id: session.id,
      title: title.title,
      titleSource: title.titleSource,
      status: session.status,
      activity: forkFacts.forkBlocksInput(this.database, sessionId)
        ? { state: 'error' as const }
        : deriveSessionActivity(session.status, latestRun),
      hasUnread: hasUnreadSessionMessage(
        session.lastSeenMessageSequence,
        latestCompleteAssistantSequence ?? undefined,
      ),
      updatedAt: session.updatedAt,
    }
  }

  private messageChange(
    messageId: string,
    requestedMode: ConversationMessageChange['mode'],
    text?: string,
    previousRevision?: number,
  ): ConversationMessageChange {
    const readReplacement = requestedMode === 'replace' && text === undefined
    const row = this.database
      .select({
        id: conversationMessages.id,
        sessionId: conversationMessages.sessionId,
        runId: conversationMessages.runId,
        replyToMessageId: conversationMessages.replyToMessageId,
        role: conversationMessages.role,
        agentId: conversationMessages.agentId,
        routeKind: conversationMessages.routeKind,
        routeAgentsJson: conversationMessages.routeAgentsJson,
        routePendingAgentId: conversationMessages.routePendingAgentId,
        sourceMessageId: conversationMessages.sourceMessageId,
        skillsJson: sql<
          string | null
        >`json_extract(${conversationMessages.skillInvocationJson}, '$.selections')`,
        contentRevision: conversationMessages.contentRevision,
        state: conversationMessages.state,
        sequence: conversationMessages.sequence,
        createdAt: conversationMessages.createdAt,
        updatedAt: conversationMessages.updatedAt,
        contentBytes: sql<number>`length(CAST(${conversationMessages.content} AS BLOB))`,
        replacementText: sql<string | null>`CASE WHEN ${readReplacement ? 1 : 0} = 1 AND
          length(CAST(${conversationMessages.content} AS BLOB)) <= ${CONVERSATION_PATCH_TEXT_BYTES}
          THEN ${conversationMessages.content} ELSE NULL END`,
        hasActivities: sql<number>`EXISTS (SELECT 1 FROM agent_run_activities a WHERE a.run_id = "conversation_messages"."run_id" LIMIT 1)`,
        hasComments: sql<number>`EXISTS (SELECT 1 FROM anchored_comments c WHERE c.sent_with_message_id = "conversation_messages"."id" LIMIT 1)`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId))
      .get()
    if (!row) throw new Error('Conversation Message does not exist.')
    const replacement = text ?? (readReplacement ? (row.replacementText ?? undefined) : undefined)
    const mode =
      (readReplacement && row.contentBytes > CONVERSATION_PATCH_TEXT_BYTES) ||
      (replacement !== undefined &&
        Buffer.byteLength(replacement, 'utf8') > CONVERSATION_PATCH_TEXT_BYTES)
        ? requestedMode === 'append'
          ? 'advance'
          : 'invalidate'
        : requestedMode
    return {
      message: {
        id: row.id,
        sessionId: row.sessionId,
        role: row.role,
        contentRevision: row.contentRevision,
        ...this.messageImageMetadata(row.id),
        state: row.state,
        sequence: row.sequence,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
        ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
        ...ConversationRepository.toMessageRoute(row),
        ...ConversationRepository.toMessageSkills(row),
      },
      mode,
      ...(mode === 'replace' || mode === 'append' ? { text: replacement ?? '' } : {}),
      ...((mode === 'append' || mode === 'advance') && previousRevision !== undefined
        ? { previousRevision }
        : {}),
      contentBytes: row.contentBytes,
      hasActivities: Boolean(row.hasActivities),
      hasComments: Boolean(row.hasComments),
    }
  }

  private activityChange(
    activityId: string,
    requestedMode: ConversationActivityChange['mode'],
    detail?: string,
    previousRevision?: number,
  ): ConversationActivityChange {
    const row = this.database
      .select()
      .from(agentRunActivities)
      .where(eq(agentRunActivities.id, activityId))
      .get()
    if (!row) throw new Error('Conversation Activity does not exist.')
    const mode =
      detail !== undefined && Buffer.byteLength(detail, 'utf8') > CONVERSATION_PATCH_TEXT_BYTES
        ? requestedMode === 'append'
          ? 'advance'
          : 'invalidate'
        : requestedMode
    const activity = ConversationRepository.toActivity(row)
    const { detail: _detail, ...metadata } = activity
    return {
      activity: metadata,
      mode,
      ...(mode === 'replace' || mode === 'append' ? { detail: detail ?? '' } : {}),
      ...((mode === 'append' || mode === 'advance') && previousRevision !== undefined
        ? { previousRevision }
        : {}),
      detailBytes: row.detail ? Buffer.byteLength(row.detail, 'utf8') : 0,
    }
  }

  private createPatch(sessionId: string, input: PatchInput = {}): ConversationPatch {
    this.patchCount += 1
    const observation = this.nextObservation(sessionId)
    const latestRunId = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          ne(agentRuns.controlDisposition, 'abandoned'),
          isNull(agentRuns.forkSourceRunId),
          sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()?.id
    const received = this.database
      .select({ id: collaborationInputs.id })
      .from(collaborationInputs)
      .where(
        and(
          eq(collaborationInputs.sessionId, sessionId),
          inArray(collaborationInputs.state, ['accepted', 'blocked']),
        ),
      )
      .get()
    const patch: ConversationPatch = {
      version: 'conversation-patch-v1',
      ...(input.receivedInputIds
        ? { receivedInputIds: input.receivedInputIds }
        : received
          ? { receivedInputIds: [received.id] }
          : {}),
      ...(input.queuedInputIds?.length ? { queuedInputIds: input.queuedInputIds } : {}),
      sessionId,
      observation,
      session: this.sessionProjection(sessionId),
      messages: input.messages ?? [],
      ...(input.removedMessageIds?.length ? { removedMessageIds: input.removedMessageIds } : {}),
      runs: input.runs ?? [],
      ...(latestRunId ? { latestRunId } : {}),
      activities: input.activities ?? [],
      activityStates: input.activityStates ?? [],
      nativeContexts: this.nativeContexts(sessionId),
      rebuildOperations: this.rebuildOperations(sessionId),
      rebuildInputRecovery: this.rebuildInputRecovery(sessionId),
      forkOperation: this.forkOperation(sessionId),
      ...(input.comments ? { comments: input.comments } : {}),
      ...(input.commentDraftReceipt ? { commentDraftReceipt: input.commentDraftReceipt } : {}),
      ...(input.resync ? { resync: input.resync } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(patch), 'utf8') <= CONVERSATION_PATCH_BYTES) {
      return conversationPatchSchema.parse(patch)
    }

    return conversationPatchSchema.parse({
      version: 'conversation-patch-v1',
      sessionId,
      observation,
      session: patch.session,
      ...(patch.receivedInputIds ? { receivedInputIds: patch.receivedInputIds } : {}),
      ...(patch.queuedInputIds ? { queuedInputIds: patch.queuedInputIds } : {}),
      messages: [],
      runs: patch.runs.slice(0, 4).map((run) => {
        const { failureMessage: _failureMessage, ...bounded } = run
        return bounded
      }),
      ...(patch.latestRunId ? { latestRunId: patch.latestRunId } : {}),
      activities: [],
      activityStates: patch.activityStates,
      nativeContexts: patch.nativeContexts,
      rebuildOperations: patch.rebuildOperations,
      rebuildInputRecovery: patch.rebuildInputRecovery,
      forkOperation: patch.forkOperation,
      ...(patch.commentDraftReceipt ? { commentDraftReceipt: patch.commentDraftReceipt } : {}),
      ...(patch.comments
        ? {
            comments: {
              revision: patch.comments.revision,
              upserts: [],
              removedIds: [],
            },
          }
        : {}),
      resync: {
        messages:
          patch.messages.length > 0 || patch.runs.length > 0 || Boolean(input.resync?.messages),
        drafts: Boolean(patch.comments) || Boolean(input.resync?.drafts),
        activityRunIds: [
          ...new Set([
            ...patch.activities.map((change) => change.activity.runId),
            ...(input.resync?.activityRunIds ?? []),
          ]),
        ].slice(0, 4),
      },
    })
  }

  diagnostics(): {
    completeReads: number
    pageReads: number
    patches: number
    observedSessions: number
    eventTransactions: number
    streamLookups: {
      text: { queries: number; returnedRows: number }
      activity: { queries: number; returnedRows: number }
    }
  } {
    return {
      completeReads: this.completeReadCount,
      pageReads: this.pageReadCount,
      patches: this.patchCount,
      observedSessions: this.observations.size,
      eventTransactions: this.eventTransactionCount,
      streamLookups: {
        text: { ...this.streamLookups.text },
        activity: { ...this.streamLookups.activity },
      },
    }
  }

  skillInvocation(messageId: string): FrozenSkillInvocation | undefined {
    const row = this.database
      .select({ json: conversationMessages.skillInvocationJson })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId))
      .get()
    return row?.json ? frozenSkillInvocationSchema.parse(JSON.parse(row.json)) : undefined
  }

  submittedRunReceipt(
    input: Pick<
      BeginRunInput,
      | 'sessionId'
      | 'clientMessageId'
      | 'content'
      | 'commentIds'
      | 'expectedCommentsRevision'
      | 'skills'
      | 'route'
      | 'imageIds'
      | 'batchId'
      | 'freezeDrafts'
      | 'preserveDraftComments'
      | 'receivedInputId'
    >,
  ): BeginRunResult | undefined {
    const existingMessage = this.database
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, input.clientMessageId))
      .get()
    if (!existingMessage) return undefined
    if (
      existingMessage.sessionId !== input.sessionId ||
      existingMessage.role !== 'user' ||
      existingMessage.content !== input.content ||
      JSON.stringify(this.imagesForMessage(existingMessage.id).map((image) => image.id)) !==
        JSON.stringify(input.imageIds ?? []) ||
      JSON.stringify(
        existingMessage.skillInvocationJson
          ? frozenSkillInvocationSchema.parse(JSON.parse(existingMessage.skillInvocationJson))
              .selections
          : [],
      ) !== JSON.stringify(input.skills ?? []) ||
      !existingMessage.runId
    ) {
      throw new RunOperationConflictError(
        'This message ID is already associated with different content.',
      )
    }
    const savedRoute = ConversationRepository.toMessageRoute(existingMessage)?.route
    if (
      input.route?.type === 'agent' &&
      (savedRoute?.type !== 'agent' || savedRoute.agentId !== input.route.agentId)
    )
      throw new RunOperationConflictError('This message ID has a different Agent target.')
    if (input.route?.type === 'primary' && savedRoute?.type !== 'primary')
      throw new RunOperationConflictError('This message ID has a different Agent target.')
    if (input.route?.type === 'all' && savedRoute?.type !== 'all')
      throw new RunOperationConflictError('This message ID has a different Agent target.')
    const existingRun = this.findRun(existingMessage.runId)
    if (!existingRun) throw new Error('The existing message has no Agent Run.')
    const batch = this.inputBatchForMessage(input.sessionId, existingMessage.id)
    if (!batch) throw new RunOperationConflictError('The original input Batch is unavailable.')
    const receipt = this.database
      .select({
        freeze: sql<number | null>`json_extract(${agentEventJournal.payload},'$.freezeDrafts')`,
      })
      .from(agentEventJournal)
      .where(
        and(
          eq(agentEventJournal.runId, existingRun.id),
          eq(agentEventJournal.eventType, 'user.message'),
        ),
      )
      .limit(1)
      .get()
    const requestedFreeze = input.receivedInputId
      ? (collaborationReceivedMetadataSchema.parse(
          JSON.parse(
            this.database
              .select({ json: collaborationInputs.metadataJson })
              .from(collaborationInputs)
              .where(eq(collaborationInputs.id, input.receivedInputId))
              .get()!.json,
          ),
        ).freezeDrafts ?? true)
      : (input.freezeDrafts ?? !input.preserveDraftComments)
    if (
      batch.id !== (input.batchId ?? input.clientMessageId) ||
      Boolean(receipt?.freeze) !== requestedFreeze
    )
      throw new RunOperationConflictError(
        'This message nonce has a different Batch or draft-freeze intent.',
      )
    const commentsRevision =
      this.database
        .select({ value: sessions.commentsRevision })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()?.value ?? input.expectedCommentsRevision
    return {
      run: existingRun,
      patch: this.createPatch(input.sessionId, {
        resync: { messages: false, drafts: true, activityRunIds: [] },
        messages: [this.messageChange(existingMessage.id, 'replace', existingMessage.content)],
        runs: [existingRun],
        comments: {
          revision: commentsRevision,
          upserts: [],
          removedIds: [],
        },
      }),
      created: false,
    }
  }

  beginRun(input: BeginRunInput): BeginRunResult {
    const existing = this.submittedRunReceipt(input)
    if (existing) return existing

    const handoffSourceIds = JSON.stringify(input.handoffSourceRefs ?? [])
    if (Buffer.byteLength(handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
      throw new HandoffTooLargeError('The required Agent context is too large to save safely.')

    const runId = randomUUID()
    const userMessageId = input.clientMessageId
    const createdAt = new Date().toISOString()
    const route: ConversationMessageRoute =
      input.route?.type === 'all'
        ? 'firstAgentId' in input.route
          ? input.route
          : {
              type: 'all',
              firstAgentId: input.agentId,
              secondAgentId: input.agentId === 'claude' ? 'codex' : 'claude',
            }
        : input.route?.type === 'agent'
          ? input.route
          : { type: 'primary', agentId: input.agentId }
    const routeAgents =
      route.type === 'all' ? [route.firstAgentId, route.secondAgentId] : [route.agentId]
    const supersededProposalRunIds: string[] = []
    const freezeDrafts = input.receivedInputId
      ? (collaborationReceivedMetadataSchema.parse(
          JSON.parse(
            this.database
              .select({ json: collaborationInputs.metadataJson })
              .from(collaborationInputs)
              .where(eq(collaborationInputs.id, input.receivedInputId))
              .get()!.json,
          ),
        ).freezeDrafts ?? true)
      : (input.freezeDrafts ?? !input.preserveDraftComments)
    if (!freezeDrafts && !input.receivedInputId && input.commentIds.length)
      throw new RunOperationConflictError(
        'A preserved draft cannot also be included in this message.',
      )

    const committedCommentsRevision = this.nativeMetadataTransaction(
      input.sessionId,
      (transaction) => {
        assertSessionAvailable(transaction, input.sessionId)
        const session = transaction
          .select()
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .get()
        if (!session) throw new Error('Session does not exist.')
        const images = this.resolveMessageImages(
          input.sessionId,
          input.imageIds ?? [],
          input.imageOwnerKey,
        )
        if (
          freezeDrafts &&
          !input.receivedInputId &&
          session.commentsRevision !== input.expectedCommentsRevision
        ) {
          throw new Error('Comment drafts changed. Refresh and try again.')
        }
        const activeRun = transaction
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.sessionId, input.sessionId),
              inArray(agentRuns.status, [...activeRunStatuses]),
              ne(agentRuns.controlDisposition, 'abandoned'),
              isNull(agentRuns.forkSourceRunId),
            ),
          )
          .get()
        if (activeRun)
          throw new RunOperationConflictError('This Session already has an active Run.')
        const draftsCondition = and(
          eq(anchoredComments.sessionId, input.sessionId),
          freezeDrafts ? undefined : sql`0`,
          input.receivedInputId
            ? eq(anchoredComments.pendingReceiptId, input.receivedInputId)
            : and(
                isNull(anchoredComments.sentWithMessageId),
                isNull(anchoredComments.pendingReceiptId),
              ),
        )
        const draftCount = transaction
          .select({ value: sql<number>`count(*)` })
          .from(anchoredComments)
          .where(draftsCondition)
          .get()!.value
        if (input.preserveDraftComments && !input.receivedInputId && input.commentIds.length > 0)
          throw new Error('Peer actions cannot consume Comment drafts.')
        if (!input.content.trim() && !images.length && (!draftCount || !freezeDrafts))
          throw new RunOperationConflictError(
            'Write a message, add a Comment, or attach an image before sending.',
          )
        const sourceProposal = input.sourceProposalId
          ? transaction
              .select({
                runId: agentRuns.id,
                runStatus: agentRuns.status,
                sourceAgentId: agentRuns.agentId,
                targetAgentId: agentRuns.peerProposalTargetAgentId,
                state: agentRuns.peerProposalState,
                sourceMessageId: conversationMessages.id,
                sourceMessageAgentId: conversationMessages.agentId,
                sourceMessageState: conversationMessages.state,
                sourceHasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
              })
              .from(agentRuns)
              .innerJoin(
                conversationMessages,
                and(
                  eq(conversationMessages.runId, agentRuns.id),
                  eq(conversationMessages.role, 'assistant'),
                  eq(conversationMessages.isVisible, true),
                ),
              )
              .where(
                and(
                  eq(agentRuns.sessionId, input.sessionId),
                  eq(agentRuns.peerProposalId, input.sourceProposalId),
                ),
              )
              .orderBy(desc(conversationMessages.sequence))
              .limit(1)
              .get()
          : undefined
        if (
          input.sourceProposalId &&
          (!sourceProposal ||
            sourceProposal.state !== 'pending' ||
            sourceProposal.targetAgentId !== input.agentId ||
            sourceProposal.runStatus !== 'completed' ||
            sourceProposal.sourceMessageId !== input.sourceMessageId ||
            sourceProposal.sourceMessageState !== 'complete' ||
            !sourceProposal.sourceHasBody ||
            sourceProposal.sourceMessageAgentId !== sourceProposal.sourceAgentId)
        )
          throw new RunOperationConflictError('This peer request is no longer available.')
        const returnId =
          input.returnedInputOperationId ??
          (!input.preserveDraftComments
            ? this.rebuildInputRecovery(input.sessionId)?.operationId
            : undefined)
        if (returnId) {
          const returned = this.verifyReturnedInput(returnId, input.sessionId)
          if (input.returnedInputOperationId && returned.record.state !== 'installed')
            throw new RunOperationConflictError('Restore this input before sending it.')
          returned.record.state = 'consumed'
          transaction
            .update(nativeRebuildOperations)
            .set({ returnedInputJson: JSON.stringify(returned.record) })
            .where(eq(nativeRebuildOperations.id, returnId))
            .run()
          this.nativeFact(returned.record.runId, 'native.input_consumed', {
            operationId: returnId,
            messageId: returned.record.messageId,
            replacementMessageId: userMessageId,
            reason: input.returnedInputOperationId ? 'returned_input_sent' : 'new_input_sent',
          })
        }
        const superseded = transaction
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.sessionId, input.sessionId),
              eq(agentRuns.peerProposalState, 'pending'),
              ...(input.sourceProposalId
                ? [ne(agentRuns.peerProposalId, input.sourceProposalId)]
                : []),
            ),
          )
          .all()
        supersededProposalRunIds.push(...superseded.map((entry) => entry.id))
        if (supersededProposalRunIds.length > 0)
          transaction
            .update(agentRuns)
            .set({ peerProposalState: 'superseded', updatedAt: createdAt })
            .where(inArray(agentRuns.id, supersededProposalRunIds))
            .run()
        const messageSequence =
          (transaction
            .select({ value: max(conversationMessages.sequence) })
            .from(conversationMessages)
            .where(eq(conversationMessages.sessionId, input.sessionId))
            .get()?.value ?? -1) + 1

        if (input.receivedInputId) {
          const received = this.receivedCollaborationInput(input.sessionId)
          if (!received || received.id !== input.receivedInputId || received.state !== 'accepted')
            throw new RunOperationConflictError('This received input is no longer eligible.')
        }
        if (input.collaboration) {
          const task = collaborationTaskSchema.parse({ ...input.collaboration, runId })
          const current = this.collaboration(input.sessionId)
          if (task.previousRunId) {
            if (
              !current ||
              current.id !== task.id ||
              current.revision + 1 !== task.revision ||
              current.runId !== task.previousRunId
            )
              throw new RunOperationConflictError('The collaboration task changed before dispatch.')
            transaction
              .update(collaborationTasks)
              .set({ stateJson: JSON.stringify(task), updatedAt: createdAt })
              .where(eq(collaborationTasks.id, task.id))
              .run()
          } else {
            transaction
              .update(collaborationTasks)
              .set({ active: false })
              .where(
                and(
                  eq(collaborationTasks.sessionId, input.sessionId),
                  eq(collaborationTasks.active, true),
                ),
              )
              .run()
            transaction
              .insert(collaborationTasks)
              .values({
                id: task.id,
                sessionId: task.sessionId,
                stateJson: JSON.stringify(task),
                active: true,
                updatedAt: createdAt,
              })
              .run()
          }
        } else if (!input.sourceProposalId) {
          const task = this.collaboration(input.sessionId)
          if (task && task.status !== 'complete') {
            if (task.status !== 'paused')
              task.pausedStatus = task.status === 'running' ? 'failed' : task.status
            task.status = 'paused'
            task.revision++
            task.notice =
              'A new user message superseded the previous action. Resume explicitly after handling it.'
            this.saveCollaboration(task)
          }
        }
        transaction
          .insert(conversationMessages)
          .values({
            id: userMessageId,
            sessionId: input.sessionId,
            runId,
            role: 'user',
            routeKind: route.type,
            routeAgentsJson: JSON.stringify(routeAgents),
            skillInvocationJson: input.skillInvocation
              ? JSON.stringify(input.skillInvocation)
              : null,
            routePendingAgentId: route.type === 'all' ? route.secondAgentId : null,
            sourceMessageId: input.sourceMessageId ?? null,
            content: input.content,
            state: 'complete',
            sequence: messageSequence,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        for (const [ordinal, image] of images.entries()) {
          transaction
            .insert(conversationMessageImages)
            .values({ messageId: userMessageId, ordinal, imageId: image.id })
            .run()
          transaction
            .update(conversationImageAssets)
            .set({ committed: true, updatedAt: createdAt })
            .where(eq(conversationImageAssets.id, image.id))
            .run()
        }
        transaction
          .insert(agentRuns)
          .values({
            id: runId,
            collaborationTaskId: input.collaboration?.id,
            collaborationKind: input.collaboration?.kind,
            collaborationStage: input.collaboration?.stage,
            answerFormat: input.collaboration ? 'collaboration_envelope_v5' : undefined,
            sessionId: input.sessionId,
            userMessageId,
            agentId: input.agentId,
            status: 'starting',
            bindingGeneration:
              this.nativeContext(input.sessionId, input.agentId)?.bindingGeneration ?? 1,
            nativeEffectsState: 'not_dispatched',
            attemptCount: 1,
            settingsRevision: input.settingsRevision,
            permissionMode: this.permissionModeAt(
              input.sessionId,
              input.agentId,
              input.settingsRevision,
            ),
            model: input.model,
            effort: input.effort,
            handoffSourceIds,
            handoffMessageCount: input.handoffSourceRefs?.length ?? 0,
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        if (input.collaboration)
          transaction
            .insert(collaborationTurns)
            .values({
              runId,
              taskId: input.collaboration.id,
              stateJson: JSON.stringify({ ...input.collaboration, runId }),
            })
            .run()
        if (input.collaboration) this.saveCollaboration({ ...input.collaboration, runId })
        const batch = this.freezeInputBatch({
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          commentsRevision: session.commentsRevision,
          actor: input.agentId,
          ...(input.batchId ? { batchId: input.batchId } : {}),
          ...(input.collaboration ? { taskId: input.collaboration.id } : {}),
          runId,
          messageId: userMessageId,
          ...(input.receivedInputId ? { pendingReceiptId: input.receivedInputId } : {}),
          preserveDraftComments: !freezeDrafts,
        })
        this.sealInputBatchSources(batch.id, runId)
        this.freezeRunSources(runId, input.handoffSourceRefs ?? [])
        if (input.collaboration)
          this.freezeCollaborationAuthorization({ ...input.collaboration, runId }, runId, batch)
        if (freezeDrafts && draftCount > 0)
          transaction
            .update(anchoredComments)
            .set({ sentWithMessageId: userMessageId, pendingReceiptId: null, updatedAt: createdAt })
            .where(draftsCondition)
            .run()
        if (input.receivedInputId) {
          transaction
            .update(collaborationInputs)
            .set({ state: 'materialized', materializedRunId: runId })
            .where(eq(collaborationInputs.id, input.receivedInputId))
            .run()
          transaction
            .update(conversationBodyInputs)
            .set({ committedMessageId: userMessageId, pendingReceiptId: null })
            .where(
              and(
                eq(conversationBodyInputs.pendingReceiptId, input.receivedInputId),
                eq(
                  conversationBodyInputs.id,
                  transaction
                    .select({ inputId: collaborationInputs.inputId })
                    .from(collaborationInputs)
                    .where(eq(collaborationInputs.id, input.receivedInputId))
                    .get()!.inputId,
                ),
              ),
            )
            .run()
          transaction
            .update(conversationImageAssets)
            .set({ pendingReceiptId: null })
            .where(
              and(
                eq(conversationImageAssets.pendingReceiptId, input.receivedInputId),
                input.imageIds?.length
                  ? inArray(conversationImageAssets.id, input.imageIds)
                  : sql`0`,
              ),
            )
            .run()
        }
        if (input.sourceProposalId) {
          transaction
            .update(agentRuns)
            .set({
              peerProposalState: 'accepted',
              peerProposalAcceptedMessageId: userMessageId,
              updatedAt: createdAt,
            })
            .where(eq(agentRuns.peerProposalId, input.sourceProposalId))
            .run()
        }
        transaction
          .update(sessions)
          .set({
            status: 'discussing',
            commentsRevision: freezeDrafts
              ? session.commentsRevision + 1
              : session.commentsRevision,
            ...(input.suggestedTitle
              ? { title: input.suggestedTitle, titleSource: 'local' as const }
              : {}),
            updatedAt: createdAt,
          })
          .where(eq(sessions.id, input.sessionId))
          .run()
        appendAgentEvent(transaction, {
          sessionId: input.sessionId,
          runId,
          eventType: 'user.message',
          payload: JSON.stringify({
            message:
              Buffer.byteLength(input.content) <= CONVERSATION_PATCH_TEXT_BYTES
                ? { id: userMessageId, content: input.content }
                : {
                    id: userMessageId,
                    source: {
                      version: 1,
                      messageId: userMessageId,
                      revision: 0,
                      sha256: createHash('sha256').update(input.content).digest('hex'),
                      bytes: Buffer.byteLength(input.content),
                    },
                  },
            route,
            ...(images.length ? { images } : {}),
            sourceMessageId: input.sourceMessageId ?? null,
            sourceProposalId: input.sourceProposalId ?? null,
            comments: [],
            freezeDrafts,
            inputBatchRef: batch,
          }),
          createdAt,
        })
        return freezeDrafts ? session.commentsRevision + 1 : session.commentsRevision
      },
    )

    const run = this.findRun(runId)
    if (!run) throw new Error('Agent Run was not created.')
    const sourceRun = input.sourceProposalId
      ? this.database
          .select(publicRunColumns)
          .from(agentRuns)
          .where(eq(agentRuns.peerProposalId, input.sourceProposalId))
          .get()
      : undefined
    const supersededRuns =
      supersededProposalRunIds.length > 0
        ? this.database
            .select(publicRunColumns)
            .from(agentRuns)
            .where(inArray(agentRuns.id, supersededProposalRunIds))
            .all()
            .map((entry) => ConversationRepository.toRun(entry))
        : []
    const relatedRuns = [
      ...(sourceRun ? [ConversationRepository.toRun(sourceRun)] : []),
      ...supersededRuns,
    ]
    return {
      run,
      patch: this.createPatch(input.sessionId, {
        resync: { messages: false, drafts: true, activityRunIds: [] },
        messages: [this.messageChange(userMessageId, 'replace', input.content)],
        runs: [run, ...relatedRuns.slice(0, 3)],
        ...(relatedRuns.length > 3
          ? { resync: { messages: true, drafts: true, activityRunIds: [] } }
          : {}),
        comments: {
          revision: committedCommentsRevision,
          upserts: [],
          removedIds: [],
          ...(freezeDrafts &&
          input.commentIds.length > 0 &&
          input.commentIds.length <= MAX_COMMENTS_PER_MESSAGE
            ? { sent: { messageId: userMessageId, commentIds: input.commentIds } }
            : {}),
        },
      }),
      created: true,
    }
  }

  beginRoutedContinuation(input: BeginRoutedContinuationInput): BeginRunResult {
    const handoffSourceIds = JSON.stringify(input.handoffSourceRefs ?? [])
    if (Buffer.byteLength(handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
      throw new HandoffTooLargeError('The required Agent context is too large to save safely.')
    const runId = randomUUID()
    const createdAt = new Date().toISOString()
    this.nativeMetadataTransaction(input.sessionId, (transaction) => {
      assertSessionAvailable(transaction, input.sessionId)
      const message = transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, input.userMessageId),
            eq(conversationMessages.sessionId, input.sessionId),
            eq(conversationMessages.role, 'user'),
          ),
        )
        .get()
      const route = message ? ConversationRepository.toMessageRoute(message)?.route : undefined
      if (
        !message ||
        route?.type !== 'all' ||
        route.secondAgentId !== input.agentId ||
        message.routePendingAgentId !== input.agentId
      )
        throw new RunOperationConflictError('This routed request has no pending peer stage.')
      const activeRun = transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, input.sessionId),
            inArray(agentRuns.status, [...activeRunStatuses]),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
          ),
        )
        .get()
      if (activeRun) throw new RunOperationConflictError('This Session already has an active Run.')
      const first = transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.userMessageId, input.userMessageId),
            eq(agentRuns.agentId, route.firstAgentId),
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get()
      if (first?.status !== 'completed')
        throw new RunOperationConflictError('The Primary stage has not completed.')
      const priorSecond = transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.userMessageId, input.userMessageId),
            eq(agentRuns.agentId, input.agentId),
          ),
        )
        .limit(1)
        .get()
      if (priorSecond) throw new RunOperationConflictError('The peer stage already exists.')

      transaction
        .insert(agentRuns)
        .values({
          id: runId,
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          agentId: input.agentId,
          status: 'starting',
          bindingGeneration:
            this.nativeContext(input.sessionId, input.agentId)?.bindingGeneration ?? 1,
          nativeEffectsState: 'not_dispatched',
          attemptCount: 1,
          settingsRevision: input.settingsRevision,
          permissionMode: this.permissionModeAt(
            input.sessionId,
            input.agentId,
            input.settingsRevision,
          ),
          model: input.model,
          effort: input.effort,
          handoffSourceIds,
          handoffMessageCount: input.handoffSourceRefs?.length ?? 0,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      this.freezeRunSources(runId, input.handoffSourceRefs ?? [])
      const userSource = this.quotedSource(input.sessionId, input.userMessageId)
      transaction
        .insert(conversationRunSourceRefs)
        .values({ runId, ...userSource })
        .onConflictDoNothing()
        .run()

      transaction
        .update(conversationMessages)
        .set({ routePendingAgentId: null, updatedAt: createdAt })
        .where(eq(conversationMessages.id, input.userMessageId))
        .run()
      transaction
        .update(sessions)
        .set({ status: 'discussing', updatedAt: createdAt })
        .where(eq(sessions.id, input.sessionId))
        .run()
      appendAgentEvent(transaction, {
        sessionId: input.sessionId,
        runId,
        eventType: 'routed.secondary_started',
        payload: JSON.stringify({ userMessageId: input.userMessageId, agentId: input.agentId }),
        createdAt,
      })
    })
    const run = this.findRun(runId)
    if (!run) throw new Error('The routed peer Run was not created.')
    const message = this.internalMessage(input.userMessageId, input.sessionId)
    if (!message) throw new Error('The routed User Message is unavailable.')
    return {
      run,
      patch: this.createPatch(input.sessionId, {
        messages: [this.messageChange(message.id, 'metadata')],
        runs: [run],
      }),
      created: true,
    }
  }

  pendingRoutedContinuations(scope?: WorkspaceArchiveScope): Array<{
    sessionId: string
    userMessageId: string
    agentId: RuntimeAgentId
  }> {
    const query = this.database
      .select({
        sessionId: conversationMessages.sessionId,
        userMessageId: conversationMessages.id,
        agentId: conversationMessages.routePendingAgentId,
      })
      .from(conversationMessages)
      .innerJoin(sessions, eq(sessions.id, conversationMessages.sessionId))
      .where(
        and(
          isNotNull(conversationMessages.routePendingAgentId),
          ne(sessions.status, 'archived'),
          isNull(sessions.archivedAt),
          scope?.kind === 'session'
            ? eq(sessions.id, scope.sessionId)
            : scope?.kind === 'project'
              ? eq(sessions.projectId, scope.projectId)
              : undefined,
        ),
      )
      .orderBy(asc(conversationMessages.sessionId), asc(conversationMessages.sequence))
    return (scope ? query.limit(6).all() : query.all()).flatMap((row) =>
      row.agentId
        ? [{ sessionId: row.sessionId, userMessageId: row.userMessageId, agentId: row.agentId }]
        : [],
    )
  }

  hasPendingRoutedContinuation(sessionId: string): boolean {
    return Boolean(
      this.database
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, sessionId),
            isNotNull(conversationMessages.routePendingAgentId),
          ),
        )
        .limit(1)
        .get(),
    )
  }

  cancelPendingRoutedContinuation(sessionId: string, reason = 'user_cancelled'): ConversationPatch {
    const id = this.database.transaction(() => this.retirePendingRoute(sessionId, reason))
    return this.createPatch(sessionId, { messages: id ? [this.messageChange(id, 'metadata')] : [] })
  }

  /** Called inside the fact transaction: recovery must never leave queued User input behind. */
  private retirePendingRoute(sessionId: string, reason: string): string | undefined {
    const pending = this.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          isNotNull(conversationMessages.routePendingAgentId),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    if (!pending) return undefined
    const now = new Date().toISOString()
    const transaction = this.database

    transaction
      .update(conversationMessages)
      .set({ routePendingAgentId: null, updatedAt: now })
      .where(eq(conversationMessages.id, pending.id))
      .run()
    appendAgentEvent(transaction, {
      sessionId,
      runId: `route:${pending.id}`,
      eventType: 'routed.secondary_cancelled',
      payload: JSON.stringify({ userMessageId: pending.id, reason }),
      createdAt: now,
    })
    transaction
      .update(sessions)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(sessions.id, sessionId))
      .run()
    return pending.id
  }

  failPendingRoutedContinuation(
    sessionId: string,
    userMessageId: string,
    agentId: RuntimeAgentId,
    message: string,
  ): ConversationPatch {
    const pending = this.database
      .select({ agentId: conversationMessages.routePendingAgentId })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, userMessageId),
          eq(conversationMessages.sessionId, sessionId),
        ),
      )
      .get()
    if (pending?.agentId !== agentId) return this.createPatch(sessionId)
    const now = new Date().toISOString()
    const systemMessageId = randomUUID()
    this.database.transaction((transaction) => {
      const messageSequence =
        (transaction
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.sessionId, sessionId))
          .get()?.value ?? -1) + 1

      transaction
        .update(conversationMessages)
        .set({ routePendingAgentId: null, updatedAt: now })
        .where(eq(conversationMessages.id, userMessageId))
        .run()
      transaction
        .insert(conversationMessages)
        .values({
          id: systemMessageId,
          sessionId,
          role: 'system',
          content: message,
          state: 'complete',
          sequence: messageSequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      appendAgentEvent(transaction, {
        sessionId,
        runId: `route:${userMessageId}`,
        eventType: 'routed.secondary_failed',
        payload: JSON.stringify({ userMessageId, agentId, message }),
        createdAt: now,
      })
      transaction
        .update(sessions)
        .set({ status: 'paused', updatedAt: now })
        .where(eq(sessions.id, sessionId))
        .run()
    })
    return this.createPatch(sessionId, {
      messages: [
        this.messageChange(userMessageId, 'metadata'),
        this.messageChange(systemMessageId, 'replace', message),
      ],
    })
  }

  dismissPeerProposal(sessionId: string, proposalId: string): ConversationPatch {
    const run = this.database
      .select({ id: agentRuns.id, state: agentRuns.peerProposalState })
      .from(agentRuns)
      .where(and(eq(agentRuns.sessionId, sessionId), eq(agentRuns.peerProposalId, proposalId)))
      .get()
    if (!run || run.state !== 'pending')
      throw new RunOperationConflictError('This peer request is no longer available.')
    this.database
      .update(agentRuns)
      .set({ peerProposalState: 'dismissed', updatedAt: new Date().toISOString() })
      .where(eq(agentRuns.id, run.id))
      .run()
    const updated = this.findRun(run.id)
    if (!updated) throw new Error('The peer request Run is unavailable.')
    return this.createPatch(sessionId, { runs: [updated] })
  }

  peerProposal(
    sessionId: string,
    proposalId: string,
  ): { run: AgentRun; sourceMessageId: string } | undefined {
    const row = this.database
      .select({ run: publicRunColumns, sourceMessageId: conversationMessages.id })
      .from(agentRuns)
      .innerJoin(
        conversationMessages,
        and(
          eq(conversationMessages.runId, agentRuns.id),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.peerProposalId, proposalId),
          eq(agentRuns.status, 'completed'),
          ne(agentRuns.controlDisposition, 'abandoned'),
          isNull(agentRuns.forkSourceRunId),
          sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
          eq(conversationMessages.state, 'complete'),
          eq(conversationMessages.agentId, agentRuns.agentId),
          sql`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    return row
      ? { run: ConversationRepository.toRun(row.run), sourceMessageId: row.sourceMessageId }
      : undefined
  }

  runPatch(runId: string): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The task is unavailable.')
    return this.createPatch(run.sessionId, { runs: [run] })
  }

  recordNativeEffects(
    runId: string,
    state: 'not_dispatched' | 'pending' | 'settled' | 'unknown',
    reason?: string,
  ): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The native observation owner is unavailable.')
    const updatedAt = new Date().toISOString()
    this.nativeMetadataTransaction(run.sessionId, (transaction) => {
      transaction
        .update(agentRuns)
        .set({ nativeEffectsState: state, nativeEffectsReason: reason?.slice(0, 128) ?? null })
        .where(eq(agentRuns.id, runId))
        .run()

      appendAgentEvent(transaction, {
        sessionId: run.sessionId,
        runId,
        eventType: 'run.native_effects_observed',
        payload: JSON.stringify({ state, ...(reason ? { reason: reason.slice(0, 128) } : {}) }),
        createdAt: updatedAt,
      })
    })
    return this.createPatch(run.sessionId, { runs: [this.findRun(runId)!] })
  }

  ownsNativeControl(runId: string): boolean {
    const run = this.findRun(runId)
    if (!run || run.forkSourceRunId || run.controlDisposition === 'abandoned') return false
    const context = this.nativeContext(run.sessionId, run.agentId)
    return (
      (!context || context.bindingGeneration === run.bindingGeneration) &&
      this.latestAgentRun(run.sessionId, run.agentId)?.id === run.id &&
      !this.pendingNativeRebuild(run.sessionId, run.agentId)
    )
  }

  private mayProjectNativeBody(run: AgentRun): boolean {
    const context = this.nativeContext(run.sessionId, run.agentId)
    return (
      this.ownsNativeControl(run.id) ||
      (context !== undefined && this.isCurrentNativeCursor(run, context))
    )
  }

  private nativeFact(runId: string, eventType: string, payload: object): void {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The native fact has no Run.')

    appendAgentEvent(this.database, {
      sessionId: run.sessionId,
      runId,
      eventType,
      payload: JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    })
  }

  setContinuation(
    sessionId: string,
    agentId: RuntimeAgentId,
    state: NativeContinuationState,
    reason?: string,
    generation?: number,
    failure?: { kind: RunFailureKind; message: string; action?: 'retry' | 'rebuild' | 'none' },
  ): ConversationPatch {
    let retired: string | undefined
    this.nativeMetadataTransaction(sessionId, () => {
      const current = this.nativeContext(sessionId, agentId)
      if (generation !== undefined && current && current.bindingGeneration !== generation) return
      if (state === 'recovery_required')
        retired = this.retirePendingRoute(sessionId, 'native_recovery_required')
      this.database
        .update(nativeAgentContexts)
        .set({
          continuationState: state,
          recoveryReason: reason?.slice(0, 240) ?? null,
          ...(failure
            ? {
                recoveryFailureKind: failure.kind,
                recoveryFailureMessage: failure.message,
                recoveryAction: failure.action ?? 'retry',
              }
            : {}),
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, agentId),
            ...(generation === undefined
              ? []
              : [eq(nativeAgentContexts.bindingGeneration, generation)]),
          ),
        )
        .run()
    })
    return this.createPatch(sessionId, {
      messages: retired ? [this.messageChange(retired, 'metadata')] : [],
    })
  }

  private permissionModeAt(sessionId: string, agentId: RuntimeAgentId, revision: number) {
    const settings = this.database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, sessionId),
          eq(sessionSettingsRevisions.revision, revision),
        ),
      )
      .get()
    if (!settings)
      throw new RunOperationConflictError('The task permission settings are unavailable.')
    return agentId === 'claude' ? settings.claudePermissionMode : settings.codexPermissionMode
  }

  recordExecutor(runId: string, executorId: string): ConversationPatch {
    const run = this.findRun(runId)
    if (
      !run ||
      !this.ownsNativeControl(runId) ||
      !['not_sent', 'rejected'].includes(run.dispatchPhase ?? 'not_sent')
    )
      throw new RunOperationConflictError('The initializing executor no longer owns this Run.')
    this.database.update(agentRuns).set({ executorId }).where(eq(agentRuns.id, runId)).run()
    return this.runPatch(runId)
  }

  recordDispatch(
    runId: string,
    phase: 'possibly_sent' | 'accepted' | 'rejected',
    nativeSessionId?: string,
    executorId?: string,
  ): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('Dispatch owner is unavailable.')
    if (run.dispatchPhase === 'ended') return this.runPatch(runId)
    this.nativeMetadataTransaction(run.sessionId, () => {
      this.database
        .update(agentRuns)
        .set({
          dispatchPhase: phase,
          ...(nativeSessionId ? { nativeSessionId } : {}),
          ...(executorId ? { executorId } : {}),
        })
        .where(eq(agentRuns.id, runId))
        .run()
      this.nativeFact(runId, 'native.dispatch_observed', { phase, nativeSessionId, executorId })
    })
    return this.runPatch(runId)
  }

  recordNativeEvidence(
    result: NativeProbeResult,
    unavailableAction: 'retry' | 'rebuild' = 'rebuild',
  ): ConversationPatch {
    const evidence = nativeProbeResultSchema.parse(result)
    if (evidence.kind === 'binding_ready') {
      this.nativeMetadataTransaction(evidence.identity.sessionId, () => {
        const receipt = this.confirmedNativeInitialization(
          evidence.identity.sessionId,
          evidence.identity.agentId,
        )
        if (
          !receipt ||
          evidence.identity.runId ||
          evidence.identity.nativeTurnId ||
          evidence.identity.executorId ||
          evidence.identity.requestId !== evidence.rebuildId ||
          receipt.rebuildId !== evidence.rebuildId ||
          receipt.sourceHash !== evidence.sourceHash ||
          receipt.nativeSessionId !== evidence.identity.nativeSessionId ||
          receipt.bindingGeneration !== evidence.identity.bindingGeneration ||
          JSON.stringify(receipt.witness) !== JSON.stringify(evidence.witness)
        )
          throw new RunOperationConflictError(
            'The checked initialization no longer owns this binding.',
          )
        this.database
          .update(nativeAgentContexts)
          .set({
            continuationState: 'ready',
            state: 'active',
            recoveryReason: null,
            recoveryAction: null,
            recoveryFailureKind: null,
            recoveryFailureMessage: null,
          })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, evidence.identity.sessionId),
              eq(nativeAgentContexts.agentId, evidence.identity.agentId),
              eq(nativeAgentContexts.bindingGeneration, receipt.bindingGeneration),
              eq(nativeAgentContexts.nativeSessionId, receipt.nativeSessionId),
            ),
          )
          .run()

        appendAgentEvent(this.database, {
          sessionId: evidence.identity.sessionId,
          runId: evidence.rebuildId,
          eventType: 'native.initialization_checked',
          payload: JSON.stringify({
            rebuildId: receipt.rebuildId,
            bindingGeneration: receipt.bindingGeneration,
            source: evidence.source,
          }),
          createdAt: new Date().toISOString(),
        })
      })
      return this.createPatch(evidence.identity.sessionId)
    }
    const id = evidence.identity
    const run = id.runId ? this.findRun(id.runId) : undefined
    const context = this.nativeContext(id.sessionId, id.agentId)
    if (id.runId && !run)
      throw new RunOperationConflictError('Native evidence has no recorded Run owner.')
    if (
      run &&
      (run.sessionId !== id.sessionId ||
        run.agentId !== id.agentId ||
        run.id !== id.requestId ||
        run.bindingGeneration !== id.bindingGeneration ||
        run.answerFormat !== id.answerFormat ||
        (run.nativeSessionId && run.nativeSessionId !== id.nativeSessionId) ||
        (run.nativeTurnId && id.nativeTurnId && run.nativeTurnId !== id.nativeTurnId) ||
        ('source' in evidence &&
          evidence.source.startsWith('live_') &&
          run.executorId &&
          run.executorId !== id.executorId))
    )
      throw new RunOperationConflictError('Native evidence identity does not match its Run.')
    let retired: string | undefined
    this.nativeMetadataTransaction(id.sessionId, () => {
      const currentContext = this.nativeContext(id.sessionId, id.agentId)
      const controls =
        currentContext?.bindingGeneration === id.bindingGeneration &&
        currentContext.nativeSessionId === id.nativeSessionId &&
        (!run || this.ownsNativeControl(run.id) || this.isCurrentNativeCursor(run, currentContext))
      if (run && !run.nativeTurnId && id.nativeTurnId)
        this.database
          .update(agentRuns)
          .set({ nativeTurnId: id.nativeTurnId })
          .where(and(eq(agentRuns.id, run.id), sql`${agentRuns.nativeTurnId} IS NULL`))
          .run()
      if (run)
        this.nativeFact(run.id, 'native.state_evidence', {
          kind: evidence.kind,
          identity: id,
          ...('source' in evidence ? { source: evidence.source } : {}),
          ...(evidence.kind === 'ended' ? { outcome: evidence.outcome } : {}),
          ...(evidence.kind === 'no_evidence' ? { reason: evidence.reason } : {}),
        })
      if (run && evidence.kind === 'ended')
        this.database
          .update(agentRuns)
          .set({
            ...(evidence.outcome ? { nativeOutcome: evidence.outcome } : {}),
            dispatchPhase: 'ended',
          })
          .where(eq(agentRuns.id, run.id))
          .run()
      if (run && 'output' in evidence && evidence.output?.submittedReport) {
        try {
          this.recordRecoveredCollaborationResult(run.id, evidence.output.submittedReport)
        } catch (error) {
          if (!(error instanceof RunOperationConflictError)) throw error
          // A rejected candidate cannot revoke independently verified native termination.
          this.nativeFact(run.id, 'pact.report_source_conflict', {
            reason: error.message.slice(0, 600),
          })
          const task = this.collaboration(run.sessionId)
          if (task?.runId === run.id && !task.result) {
            task.reportFailure = 'invalid'
            task.notice = error.message.slice(0, 600)
            this.saveCollaboration(task)
          }
        }
      }
      if (!controls) return
      const state: NativeContinuationState =
        evidence.kind === 'ended' &&
        currentContext?.recoveryFailureKind === 'native_session_occupied' &&
        evidence.source !== 'live_terminal'
          ? 'recovery_required'
          : evidence.kind === 'ended'
            ? 'ready'
            : evidence.kind === 'running'
              ? 'responding'
              : evidence.kind === 'waiting_user'
                ? 'waiting_user'
                : 'recovery_required'
      if (state === 'recovery_required')
        retired = this.retirePendingRoute(id.sessionId, 'native_evidence_unavailable')
      this.database
        .update(nativeAgentContexts)
        .set({
          continuationState: state,
          recoveryAction:
            state === 'recovery_required'
              ? evidence.kind === 'missing' ||
                currentContext?.recoveryFailureKind === 'native_session_occupied' ||
                currentContext?.recoveryAction === 'rebuild'
                ? 'rebuild'
                : unavailableAction
              : null,
          recoveryFailureKind:
            evidence.kind === 'missing'
              ? 'context_resume_failed'
              : state === 'recovery_required' &&
                  currentContext?.recoveryFailureKind === 'native_session_occupied'
                ? 'native_session_occupied'
                : null,
          recoveryFailureMessage: null,
          executorId: id.executorId ?? context?.executorId ?? null,
          recoveryReason:
            state === 'recovery_required' && evidence.kind === 'ended'
              ? 'Saved history is readable, but it does not confirm that another client released the native writer.'
              : evidence.kind === 'missing'
                ? 'The native session could not be found.'
                : evidence.kind === 'no_evidence'
                  ? evidence.reason
                  : null,
          ...(evidence.kind === 'missing'
            ? { state: 'missing' as const }
            : state !== 'recovery_required'
              ? { state: 'active' as const }
              : {}),
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, id.sessionId),
            eq(nativeAgentContexts.agentId, id.agentId),
            eq(nativeAgentContexts.bindingGeneration, id.bindingGeneration),
          ),
        )
        .run()
    })
    return this.createPatch(id.sessionId, {
      ...(run ? { runs: [this.findRun(run.id)!] } : {}),
      messages: retired ? [this.messageChange(retired, 'metadata')] : [],
    })
  }

  observationUnavailable(runId: string, reason: string): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The observed Run is unavailable.')
    let retired: string | undefined
    this.nativeMetadataTransaction(run.sessionId, () => {
      if (this.ownsNativeControl(runId))
        retired = this.retirePendingRoute(run.sessionId, 'native_observation_unavailable')
      if (
        run.dispatchPhase !== 'ended' &&
        !run.nativeOutcome &&
        run.controlDisposition !== 'abandoned'
      ) {
        this.database
          .update(agentRuns)
          .set({
            status: 'interrupted',
            failureKind: 'transient_transport',
            failureMessage: reason.slice(0, 240),
          })
          .where(eq(agentRuns.id, runId))
          .run()
        this.database
          .update(conversationMessages)
          .set({ state: 'incomplete' })
          .where(
            and(
              eq(conversationMessages.runId, runId),
              eq(conversationMessages.role, 'assistant'),
              ne(conversationMessages.state, 'complete'),
            ),
          )
          .run()
      }
      if (this.ownsNativeControl(runId))
        this.database
          .update(nativeAgentContexts)
          .set({
            continuationState:
              run.nativeOutcome ||
              ['ended', 'not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
                ? 'ready'
                : 'recovery_required',
            recoveryReason:
              run.nativeOutcome ||
              ['ended', 'not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
                ? null
                : reason.slice(0, 240),
          })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, run.sessionId),
              eq(nativeAgentContexts.agentId, run.agentId),
              eq(nativeAgentContexts.bindingGeneration, run.bindingGeneration ?? 1),
            ),
          )
          .run()
      this.nativeFact(runId, 'pact.observation_unavailable', { reason: reason.slice(0, 240) })
    })
    return this.createPatch(run.sessionId, {
      runs: [this.findRun(runId)!],
      messages: retired ? [this.messageChange(retired, 'metadata')] : [],
    })
  }

  /** Binding projection only: a refused local attempt cannot erase the actual native cursor. */
  private isCurrentNativeCursor(run: AgentRun, context: NativeAgentContext): boolean {
    if (
      run.controlDisposition === 'abandoned' ||
      context.lastRunId !== run.id ||
      context.sessionId !== run.sessionId ||
      context.agentId !== run.agentId ||
      context.nativeSessionId !== run.nativeSessionId ||
      context.bindingGeneration !== run.bindingGeneration ||
      this.pendingNativeRebuild(run.sessionId, run.agentId)
    )
      return false
    const blocker = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, run.sessionId),
          eq(agentRuns.agentId, run.agentId),
          eq(agentRuns.bindingGeneration, run.bindingGeneration ?? 1),
          sql`${agentRuns}.rowid > (SELECT rowid FROM agent_runs WHERE id=${run.id})`,
          sql`(${agentRuns.status} NOT IN ('failed','interrupted') OR ${agentRuns.dispatchPhase} NOT IN ('not_sent','rejected'))`,
        ),
      )
      .limit(1)
      .get()
    return blocker === undefined
  }

  latestAgentRun(
    sessionId: string,
    agentId: RuntimeAgentId,
    generation?: number,
  ): AgentRun | undefined {
    const row = this.database
      .select(publicRunColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.agentId, agentId),
          isNull(agentRuns.forkSourceRunId),
          ...(generation === undefined
            ? []
            : [
                eq(agentRuns.bindingGeneration, generation),
                ne(agentRuns.controlDisposition, 'abandoned'),
                isNull(agentRuns.forkSourceRunId),
              ]),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
      .limit(1)
      .get()
    return row ? ConversationRepository.toRun(row) : undefined
  }

  hasCompleteResponse(runId: string): boolean {
    return (
      this.database
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.runId, runId),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.isVisible, true),
            eq(conversationMessages.state, 'complete'),
            sql`length(${conversationMessages.content}) > 0`,
          ),
        )
        .limit(1)
        .get() !== undefined
    )
  }

  bindingHasUnsettledWork(sessionId: string, agentId: RuntimeAgentId, generation: number): boolean {
    return (
      this.database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, sessionId),
            eq(agentRuns.agentId, agentId),
            eq(agentRuns.bindingGeneration, generation),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
            or(
              inArray(agentRuns.nativeEffectsState, ['pending', 'unknown']),
              and(
                sql`${agentRuns.nativeOutcome} IS NULL`,
                inArray(agentRuns.dispatchPhase, ['accepted', 'possibly_sent']),
              ),
            ),
          ),
        )
        .limit(1)
        .get() !== undefined
    )
  }

  contextPatch(sessionId: string): ConversationPatch {
    return this.createPatch(sessionId)
  }

  verifyRebuildReceipt(id: string, sessionId: string, agentId: RuntimeAgentId): void {
    const row = this.database
      .select({
        sessionId: nativeRebuildOperations.sessionId,
        agentId: nativeRebuildOperations.agentId,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!row || row.sessionId !== sessionId || row.agentId !== agentId)
      throw new RunOperationConflictError('The rebuild receipt belongs to another binding.')
  }

  settleKnownNativeEnding(
    runId: string,
    failure?: { kind: RunFailureKind; message: string },
  ): ConversationPatch {
    const run = this.findRun(runId)
    if (!run || run.dispatchPhase !== 'ended')
      throw new RunOperationConflictError('The native ending has no evidence.')
    this.nativeMetadataTransaction(run.sessionId, () => {
      this.database
        .update(agentRuns)
        .set({
          status: run.nativeOutcome ?? 'interrupted',
          failureKind:
            run.nativeOutcome === 'completed'
              ? null
              : ((run.nativeOutcome === 'failed' ? failure?.kind : undefined) ??
                run.failureKind ??
                null),
          failureMessage: run.nativeOutcome
            ? run.nativeOutcome === 'completed'
              ? null
              : ((run.nativeOutcome === 'failed' ? failure?.message : undefined) ??
                run.failureMessage ??
                null)
            : 'The Turn ended, but its outcome was not recorded.',
        })
        .where(eq(agentRuns.id, runId))
        .run()
      if (this.ownsNativeControl(runId))
        this.database
          .update(nativeAgentContexts)
          .set({ continuationState: 'ready', recoveryReason: null })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, run.sessionId),
              eq(nativeAgentContexts.agentId, run.agentId),
              eq(nativeAgentContexts.bindingGeneration, run.bindingGeneration ?? 1),
            ),
          )
          .run()
    })
    this.finishCollaboration(runId, run.nativeOutcome === 'completed', failure?.message)
    return this.runPatch(runId)
  }

  /** Indexed Project-wide facts, including old bindings whose native work is not settled. */
  projectHasNativeWork(projectId: string): boolean {
    if (
      this.database
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(sessionForkOperations, eq(sessionForkOperations.sessionId, sessions.id))
        .innerJoin(nativeForkIntents, eq(nativeForkIntents.operationId, sessionForkOperations.id))
        .where(
          and(
            eq(sessions.projectId, projectId),
            inArray(nativeForkIntents.nativeWorkState, ['pending', 'unknown']),
          ),
        )
        .limit(1)
        .get()
    )
      return true
    const run = this.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, projectId),
          sql`EXISTS (SELECT 1 FROM ${agentRuns} INDEXED BY agent_runs_session_unsettled_work_idx WHERE ${agentRuns.sessionId} = ${sessions.id} AND ${agentRuns.forkSourceRunId} IS NULL AND ((${agentRuns.status} IN ('starting', 'running', 'recovering') AND ${agentRuns.controlDisposition} <> 'abandoned') OR ${agentRuns.nativeEffectsState} IN ('pending', 'unknown')))`,
        ),
      )
      .limit(1)
      .get()
    if (run) return true
    return Boolean(
      this.database
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.projectId, projectId),
            sql`EXISTS (SELECT 1 FROM ${nativeRebuildOperations} INDEXED BY native_rebuild_operations_unsettled_work_idx WHERE ${nativeRebuildOperations.sessionId} = ${sessions.id} AND ${nativeRebuildOperations.nativeWorkState} IN ('pending', 'unknown'))`,
          ),
        )
        .limit(1)
        .get(),
    )
  }

  recordNativeRebuildWork(
    id: string,
    executorId: string,
    nativeSessionId: string | undefined,
    state: 'unknown' | 'settled',
  ): void {
    this.database.transaction(() => {
      const row = this.database
        .select()
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, id))
        .get()
      if (
        !row ||
        row.creationExecutorId !== executorId ||
        (row.provisionalNativeSessionId && row.provisionalNativeSessionId !== nativeSessionId)
      )
        throw new RunOperationConflictError(
          'The native work report belongs to another creation actor.',
        )
      if (
        row.nativeWorkState === 'settled' ||
        row.nativeWorkState === 'not_dispatched' ||
        row.nativeWorkState === state
      )
        return
      this.database
        .update(nativeRebuildOperations)
        .set({ nativeWorkState: state })
        .where(eq(nativeRebuildOperations.id, id))
        .run()

      appendAgentEvent(this.database, {
        sessionId: row.sessionId,
        runId: id,
        eventType: 'native.rebuild_work',
        payload: JSON.stringify({ operationId: id, executorId, state }),
        createdAt: new Date().toISOString(),
      })
    })
  }

  recordNativeRebuildCheck(
    sessionId: string,
    agentId: RuntimeAgentId,
    expected: NativeRebuildOperation,
    expectedNativeSessionId: string | undefined,
  ): ConversationPatch {
    this.database.transaction(() => {
      const row = this.database
        .select()
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, expected.id))
        .get()
      const context = this.nativeContext(sessionId, agentId)
      if (
        !row ||
        row.sessionId !== sessionId ||
        row.agentId !== agentId ||
        row.stage !== 'unconfirmed' ||
        row.oldGeneration !== expected.oldGeneration ||
        row.provisionalNativeSessionId !== (expected.provisionalNativeSessionId ?? null) ||
        row.sourceHash !== (expected.sourceHash ?? null) ||
        (context?.bindingGeneration ?? 1) !== row.oldGeneration ||
        (context?.nativeSessionId ?? null) !== (expectedNativeSessionId ?? null) ||
        row.oldNativeSessionId !== (expectedNativeSessionId ?? null)
      )
        throw new RunOperationConflictError(
          'The candidate check no longer owns this recovery action.',
        )
      this.database
        .update(nativeRebuildOperations)
        .set({ checkAction: 'rebuild' })
        .where(eq(nativeRebuildOperations.id, expected.id))
        .run()
    })
    return this.createPatch(sessionId)
  }

  nativeRebuildOperation(id: string): NativeRebuildOperation | undefined {
    const row = this.database
      .select({
        id: nativeRebuildOperations.id,
        oldGeneration: nativeRebuildOperations.oldGeneration,
        stage: nativeRebuildOperations.stage,
        provisionalNativeSessionId: nativeRebuildOperations.provisionalNativeSessionId,
        sourceHash: nativeRebuildOperations.sourceHash,
        failureReason: nativeRebuildOperations.failureReason,
        checkAction: nativeRebuildOperations.checkAction,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    return row
      ? {
          id: row.id,
          oldGeneration: row.oldGeneration,
          stage: row.stage,
          checkAction: row.checkAction,
          ...(row.provisionalNativeSessionId
            ? { provisionalNativeSessionId: row.provisionalNativeSessionId }
            : {}),
          ...(row.sourceHash ? { sourceHash: row.sourceHash } : {}),
          ...(row.failureReason ? { failureReason: row.failureReason.slice(0, 240) } : {}),
        }
      : undefined
  }

  pendingNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): NativeRebuildOperation | undefined {
    const row = this.database
      .select({ id: nativeRebuildOperations.id })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.sessionId, sessionId),
          eq(nativeRebuildOperations.agentId, agentId),
          inArray(nativeRebuildOperations.stage, [
            'preparing',
            'creating',
            'seeding',
            'unconfirmed',
          ]),
        ),
      )
      .limit(1)
      .get()
    return row ? this.nativeRebuildOperation(row.id) : undefined
  }

  lastNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): NativeRebuildOperation | undefined {
    const row = this.database
      .select({ id: nativeRebuildOperations.id })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.sessionId, sessionId),
          eq(nativeRebuildOperations.agentId, agentId),
        ),
      )
      .orderBy(desc(nativeRebuildOperations.createdAt), desc(nativeRebuildOperations.id))
      .limit(1)
      .get()
    return row ? this.nativeRebuildOperation(row.id) : undefined
  }

  beginNativeRebuild(input: {
    id: string
    sessionId: string
    agentId: RuntimeAgentId
    expectedGeneration: number
    abandon: boolean
    reservedNativeSessionId?: string
  }): ConversationPatch {
    const existing = this.nativeRebuildOperation(input.id)
    if (existing) {
      const identity = this.database
        .select({
          sessionId: nativeRebuildOperations.sessionId,
          agentId: nativeRebuildOperations.agentId,
        })
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, input.id))
        .get()
      if (identity?.sessionId !== input.sessionId || identity.agentId !== input.agentId)
        throw new RunOperationConflictError('This rebuild confirmation belongs to another binding.')
      return this.createPatch(input.sessionId)
    }
    const context = this.nativeContext(input.sessionId, input.agentId)
    if ((context?.bindingGeneration ?? 1) !== input.expectedGeneration)
      throw new RunOperationConflictError('The Native binding changed. Check it again.')
    const run = this.latestAgentRun(input.sessionId, input.agentId)
    if (
      this.bindingHasUnsettledWork(input.sessionId, input.agentId, input.expectedGeneration) &&
      !input.abandon
    )
      throw new RunOperationConflictError(
        'The previous binding may still have native work. Review its effects and confirm rebuilding before continuing.',
      )
    if (
      run &&
      run.controlDisposition !== 'abandoned' &&
      run.bindingGeneration === input.expectedGeneration &&
      !run.nativeOutcome &&
      run.dispatchPhase !== 'ended' &&
      !['not_sent', 'rejected'].includes(run.dispatchPhase ?? '') &&
      !input.abandon
    )
      throw new RunOperationConflictError(
        'Confirm abandoning the unverified task before rebuilding.',
      )
    this.nativeMetadataTransaction(input.sessionId, () => {
      const pending = this.pendingNativeRebuild(input.sessionId, input.agentId)
      assertSessionAvailable(this.database, input.sessionId)
      if (pending && pending.stage !== 'unconfirmed')
        throw new RunOperationConflictError('This Native rebuild is still in progress.')
      if (pending)
        this.database
          .update(nativeRebuildOperations)
          .set({ stage: 'superseded' })
          .where(eq(nativeRebuildOperations.id, pending.id))
          .run()
      const now = new Date().toISOString()
      this.database
        .insert(nativeRebuildOperations)
        .values({
          id: input.id,
          sessionId: input.sessionId,
          agentId: input.agentId,
          oldGeneration: input.expectedGeneration,
          oldNativeSessionId: context?.nativeSessionId ?? null,
          oldRunId: run?.id ?? null,
          returnedInputJson:
            run && run.bindingGeneration === input.expectedGeneration
              ? this.freezeReturnedInput(run)
              : null,
          abandon: input.abandon,
          provisionalNativeSessionId: input.reservedNativeSessionId ?? null,
          stage: 'preparing',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      this.database
        .update(nativeAgentContexts)
        .set({ continuationState: 'rebuilding', recoveryReason: null })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, input.sessionId),
            eq(nativeAgentContexts.agentId, input.agentId),
            eq(nativeAgentContexts.bindingGeneration, input.expectedGeneration),
          ),
        )
        .run()
    })
    return this.createPatch(input.sessionId)
  }

  freezeNativeRebuildSource(id: string, chunks: NativeContextRebuildChunk[]): string {
    const json = JSON.stringify(chunks)
    if (chunks.length > 4096 || Buffer.byteLength(json) > HANDOFF_SAFETY_BYTES)
      throw new HandoffTooLargeError('The complete rebuild history exceeds its preparation limit.')
    const row = this.database
      .select({
        sourceHash: nativeRebuildOperations.sourceHash,
        stage: nativeRebuildOperations.stage,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!row || row.stage !== 'preparing')
      throw new RunOperationConflictError('The rebuild source owner changed.')
    const hash = createHash('sha256').update(json).digest('hex')
    if (row.sourceHash && row.sourceHash !== hash)
      throw new RunOperationConflictError('The rebuild history changed.')
    if (row.sourceHash === hash) return hash
    this.database.transaction(() => {
      const operation = this.database
        .select({ sessionId: nativeRebuildOperations.sessionId })
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, id))
        .get()!
      for (const messageId of new Set(chunks.map((chunk) => chunk.messageId))) {
        const source = this.quotedSource(operation.sessionId, messageId)
        this.database
          .insert(conversationRebuildSourceRefs)
          .values({ operationId: id, ...source })
          .run()
      }
      this.database
        .update(nativeRebuildOperations)
        .set({
          sourceHash: hash,
          sourceChunksJson: json,
          messageCount: new Set(chunks.map((chunk) => chunk.messageId)).size,
          throughSequence: Math.max(-1, ...chunks.map((chunk) => chunk.sequence)),
        })
        .where(eq(nativeRebuildOperations.id, id))
        .run()
    })
    return hash
  }

  private parseReturnedInput(json: string | null): RebuildReturnedInputRecord | undefined {
    if (!json) return undefined
    if (Buffer.byteLength(json) > 64 * 1024)
      throw new RunOperationConflictError('Invalid input return receipt.')
    return rebuildReturnedInputRecordSchema.parse(JSON.parse(json))
  }

  private freezeReturnedInput(run: AgentRun): string | null {
    if (this.rebuildInputRecovery(run.sessionId)) return null
    const message = this.database
      .select({
        ...getTableColumns(conversationMessages),
        content: sql<
          string | null
        >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, run.userMessageId),
          eq(conversationMessages.sessionId, run.sessionId),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .get()
    if (
      !message ||
      message.role !== 'user' ||
      message.content === null ||
      !this.returnedInputWasNotSubmitted(run)
    )
      return null
    const later = this.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, run.sessionId),
          eq(conversationMessages.isVisible, true),
          gt(conversationMessages.sequence, message.sequence),
          inArray(conversationMessages.role, ['user', 'assistant']),
        ),
      )
      .orderBy(asc(conversationMessages.sequence))
      .limit(1)
      .get()
    if (later) return null
    const batch = this.inputBatchForMessage(run.sessionId, message.id)
    if (!batch) return null
    const images = this.imagesForMessage(message.id)
    const record: RebuildReturnedInputRecord = {
      version: 'rebuild-return-v1',
      state: 'prepared',
      messageId: message.id,
      runId: run.id,
      revision: message.contentRevision,
      hash: createHash('sha256').update(message.content).digest('hex'),
      ...(images.length
        ? {
            images: images.map((image) => ({
              id: image.id,
              sha256: image.sha256,
            })),
          }
        : {}),
      route: ConversationRepository.toMessageRoute(message)?.route ?? {
        type: 'agent',
        agentId: run.agentId,
      },
      comments: [],
      inputBatchRef: {
        id: batch.id,
        revision: batch.revision,
        memberCount: batch.memberCount,
      },
    }
    return JSON.stringify(rebuildReturnedInputRecordSchema.parse(record))
  }

  private returnedInputWasNotSubmitted(run: AgentRun): boolean {
    if (run.status !== 'failed') return false
    const badRun = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, run.sessionId),
          eq(agentRuns.userMessageId, run.userMessageId),
          or(
            ne(agentRuns.status, 'failed'),
            sql`${agentRuns.dispatchPhase} NOT IN ('not_sent', 'rejected')`,
            isNotNull(agentRuns.nativeTurnId),
            isNotNull(agentRuns.nativeOutcome),
            eq(agentRuns.failureKind, 'unknown_delivery'),
          ),
        ),
      )
      .limit(1)
      .get()
    return !badRun
  }

  /** One revision-bound verdict over all active drafts; no clone IDs enter a Patch. */
  private returnedDraftsCompatible(
    sessionId: string,
    operationId: string,
    pending: boolean,
  ): boolean {
    const active = sql`${anchoredComments.sessionId}=${sessionId} AND ${anchoredComments.sentWithMessageId} IS NULL AND ${anchoredComments.pendingReceiptId} IS NULL`
    const hasForeign = pending
      ? this.database.get<{ found: number }>(sql`
          SELECT EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active} LIMIT 1) AS found`)
      : this.database.get<{ found: number }>(sql`
          SELECT EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId} IS NULL LIMIT 1)
            OR EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId}<${operationId} LIMIT 1)
            OR EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId}>${operationId} LIMIT 1) AS found`)
    return hasForeign?.found === 0
  }

  rebuildInputRecovery(sessionId: string): RebuildInputRecovery | null {
    const row = this.database
      .select({
        id: nativeRebuildOperations.id,
        agentId: nativeRebuildOperations.agentId,
        generation: nativeRebuildOperations.oldGeneration,
        json: nativeRebuildOperations.returnedInputJson,
      })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.sessionId, sessionId),
          eq(nativeRebuildOperations.stage, 'completed'),
          sql`json_extract(${nativeRebuildOperations.returnedInputJson}, '$.state') IN ('pending', 'installed')`,
        ),
      )
      .limit(1)
      .get()
    if (!row) return null
    const record = this.parseReturnedInput(row.json)
    if (!record || !['pending', 'installed'].includes(record.state)) return null
    return {
      operationId: row.id,
      agentId: row.agentId,
      messageId: record.messageId,
      bindingGeneration:
        this.nativeContext(sessionId, row.agentId)?.bindingGeneration ?? row.generation + 1,
      route: record.route,
      state: record.state === 'pending' ? 'pending' : 'installed',
      commentIds: [],
      draftEligibility: {
        commentsRevision: this.database
          .select({ value: sessions.commentsRevision })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get()!.value,
        canRestore: this.returnedDraftsCompatible(sessionId, row.id, record.state === 'pending'),
      },
      ...(record.inputBatchRef ? { inputBatchRef: record.inputBatchRef } : {}),
    }
  }

  private verifyReturnedInput(operationId: string, sessionId: string) {
    const row = this.database
      .select({
        stage: nativeRebuildOperations.stage,
        agentId: nativeRebuildOperations.agentId,
        returnedInputJson: nativeRebuildOperations.returnedInputJson,
      })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.id, operationId),
          eq(nativeRebuildOperations.sessionId, sessionId),
        ),
      )
      .get()
    const record = this.parseReturnedInput(row?.returnedInputJson ?? null)
    if (
      !row ||
      row.stage !== 'completed' ||
      !record ||
      !['pending', 'installed'].includes(record.state)
    )
      throw new RunOperationConflictError('The returned input is no longer available.')
    const message = this.database
      .select({
        ...getTableColumns(conversationMessages),
        content: sql<
          string | null
        >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, record.messageId),
          eq(conversationMessages.sessionId, sessionId),
        ),
      )
      .get()
    if (message?.content === null)
      throw new RunOperationConflictError(
        'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
      )
    if (
      !message ||
      message.role !== 'user' ||
      message.contentRevision !== record.revision ||
      createHash('sha256').update(message.content).digest('hex') !== record.hash
    )
      throw new RunOperationConflictError('The original returned input changed.')
    const images = this.imagesForMessage(record.messageId, sessionId)
    if (
      JSON.stringify(images.map((image) => ({ id: image.id, sha256: image.sha256 }))) !==
      JSON.stringify(record.images ?? [])
    )
      throw new RunOperationConflictError('The original returned images changed.')
    const originalRun = this.findRun(record.runId)
    if (
      !originalRun ||
      originalRun.sessionId !== sessionId ||
      originalRun.userMessageId !== record.messageId ||
      !this.returnedInputWasNotSubmitted(originalRun)
    )
      throw new RunOperationConflictError('The original input no longer has non-dispatch proof.')
    if (!record.inputBatchRef)
      throw new RunOperationConflictError('The original input Batch source is unavailable.')
    const batch = this.database
      .select()
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.id, record.inputBatchRef.id),
          eq(conversationInputBatches.sessionId, sessionId),
          eq(conversationInputBatches.messageId, record.messageId),
        ),
      )
      .get()
    if (
      !batch ||
      batch.commentsRevision !== record.inputBatchRef.revision ||
      batch.memberCount !== record.inputBatchRef.memberCount
    )
      throw new RunOperationConflictError('The frozen input Batch changed.')
    let cursor = -1,
      count = 0
    const deadline = Date.now() + 5000
    for (;;) {
      if (Date.now() >= deadline)
        throw new RunOperationConflictError(
          'The original input Batch verification timed out; its sources remain saved.',
        )
      const page = this.database
        .select({ member: conversationInputBatchMembers, comment: anchoredComments })
        .from(conversationInputBatchMembers)
        .innerJoin(
          anchoredComments,
          eq(anchoredComments.id, conversationInputBatchMembers.commentId),
        )
        .where(
          and(
            eq(conversationInputBatchMembers.batchId, batch.id),
            gt(conversationInputBatchMembers.ordinal, cursor),
          ),
        )
        .orderBy(asc(conversationInputBatchMembers.ordinal))
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!page.length) break
      for (const { member, comment } of page) {
        if (
          comment.sessionId !== sessionId ||
          comment.sentWithMessageId !== record.messageId ||
          comment.draftRevision !== member.commentRevision ||
          comment.anchorJson !== member.anchorJson ||
          createHash('sha256').update(comment.body).digest('hex') !== member.bodySha256
        )
          throw new RunOperationConflictError('The original frozen Comment changed.')
        count++
      }
      cursor = page.at(-1)!.member.ordinal
    }
    if (count !== batch.memberCount)
      throw new RunOperationConflictError('The original input Batch has missing members.')
    return { row, record, message: { ...message, content: message.content }, batch, images }
  }

  readReturnedInput(
    sessionId: string,
    operationId: string,
    offset: number,
  ): Extract<ConversationPage, { scope: 'rebuild-input' }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > BODY_INTERNAL_READ_BYTES)
      throw new RunOperationConflictError('Invalid returned input offset.')
    // Only page zero verifies complete originals; the final claim verifies them again.
    // Later pages are bounded header/revision reads. Cursors count SQLite Unicode characters.
    const verified = offset === 0 ? this.verifyReturnedInput(operationId, sessionId) : undefined
    if (verified?.message.content.includes('\0'))
      throw new RunOperationConflictError(
        'This input contains an unsupported zero character. Its original content remains saved.',
      )
    const receipt =
      verified?.row ??
      this.database
        .select({
          stage: nativeRebuildOperations.stage,
          agentId: nativeRebuildOperations.agentId,
          returnedInputJson: nativeRebuildOperations.returnedInputJson,
        })
        .from(nativeRebuildOperations)
        .where(
          and(
            eq(nativeRebuildOperations.id, operationId),
            eq(nativeRebuildOperations.sessionId, sessionId),
          ),
        )
        .get()
    const record = this.parseReturnedInput(receipt?.returnedInputJson ?? null)
    if (
      !receipt ||
      receipt.stage !== 'completed' ||
      !record ||
      !['pending', 'installed'].includes(record.state)
    )
      throw new RunOperationConflictError('The returned input is no longer available.')
    const message = this.database
      .select({
        role: conversationMessages.role,
        revision: conversationMessages.contentRevision,
        text: sql<string>`substr(${conversationMessages.content}, ${offset + 1}, 4097)`,
        prior: sql<string>`substr(${conversationMessages.content}, ${Math.max(1, offset)}, 1)`,
        skills: sql<
          string | null
        >`CASE WHEN ${offset} = 0 THEN ${conversationMessages.skillInvocationJson} ELSE NULL END`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, record.messageId),
          eq(conversationMessages.sessionId, sessionId),
        ),
      )
      .get()
    if (
      !message ||
      message.role !== 'user' ||
      message.revision !== record.revision ||
      (offset > 0 && !message.prior)
    )
      throw new RunOperationConflictError(
        'The original returned input changed or its cursor is invalid.',
      )
    const characters = Array.from(message.text)
    const count = Math.min(4096, characters.length)
    return {
      scope: 'rebuild-input',
      sessionId,
      operationId,
      messageId: record.messageId,
      text: characters.slice(0, count).join(''),
      nextOffset: offset + count,
      hasMore: characters.length > count,
      route: record.route,
      ...(offset === 0 && verified?.images.length ? { images: verified.images } : {}),
      ...(offset === 0 && message.skills
        ? { skills: frozenSkillInvocationSchema.parse(JSON.parse(message.skills)).selections }
        : {}),
    }
  }

  claimReturnedInput(
    sessionId: string,
    operationId: string,
    expectedGeneration: number,
    expectedCommentsRevision: number,
  ): ConversationPatch {
    let installed = false
    this.database.transaction(() => {
      const { row, record, batch } = this.verifyReturnedInput(operationId, sessionId)
      if (expectedGeneration !== this.nativeContext(sessionId, row.agentId)?.bindingGeneration)
        throw new RunOperationConflictError('Input recovery generation changed.')
      const session = this.database.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
      if (session.commentsRevision !== expectedCommentsRevision)
        throw new RunOperationConflictError('Comment drafts changed during input recovery.')
      if (!this.returnedDraftsCompatible(sessionId, operationId, record.state === 'pending'))
        throw new RunOperationConflictError(
          'Keep your current Comment drafts before restoring this input.',
        )
      if (record.state === 'installed') return
      let position =
        (this.database
          .select({ value: max(anchoredComments.position) })
          .from(anchoredComments)
          .where(eq(anchoredComments.sessionId, sessionId))
          .get()?.value ?? -1) + 1
      let cursor = -1
      for (;;) {
        const page = this.database
          .select({ member: conversationInputBatchMembers, comment: anchoredComments })
          .from(conversationInputBatchMembers)
          .innerJoin(
            anchoredComments,
            eq(anchoredComments.id, conversationInputBatchMembers.commentId),
          )
          .where(
            and(
              eq(conversationInputBatchMembers.batchId, batch.id),
              gt(conversationInputBatchMembers.ordinal, cursor),
            ),
          )
          .orderBy(asc(conversationInputBatchMembers.ordinal))
          .limit(COLLABORATION_INDEX_ITEMS)
          .all()
        if (!page.length) break
        for (const { comment } of page)
          this.database
            .insert(anchoredComments)
            .values({
              ...comment,
              id: randomUUID(),
              position: position++,
              sentWithMessageId: null,
              pendingReceiptId: null,
              returnOperationId: operationId,
              draftRevision: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
            .run()
        cursor = page.at(-1)!.member.ordinal
      }
      this.database
        .update(conversationInputBatchMembers)
        .set({ state: 'withdrawn', updatedAt: new Date().toISOString() })
        .where(eq(conversationInputBatchMembers.batchId, batch.id))
        .run()
      this.database
        .update(conversationInputBatches)
        .set({ bodyState: 'withdrawn', state: 'closed', closedAt: new Date().toISOString() })
        .where(eq(conversationInputBatches.id, batch.id))
        .run()
      if (batch.taskId) this.advanceInputWatermark(batch.taskId)
      record.state = 'installed'
      this.database
        .update(nativeRebuildOperations)
        .set({ returnedInputJson: JSON.stringify(record) })
        .where(eq(nativeRebuildOperations.id, operationId))
        .run()
      this.database
        .update(sessions)
        .set({ commentsRevision: session.commentsRevision + 1 })
        .where(eq(sessions.id, sessionId))
        .run()

      appendAgentEvent(this.database, {
        sessionId,
        runId: record.runId,
        eventType: 'native.input_returned',
        payload: JSON.stringify({
          operationId,
          messageId: record.messageId,
          inputBatchRef: record.inputBatchRef,
        }),
        createdAt: new Date().toISOString(),
      })
      installed = true
    })
    return this.createPatch(sessionId, {
      comments: {
        revision: this.database
          .select({ revision: sessions.commentsRevision })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get()!.revision,
        upserts: [],
        removedIds: [],
      },
      resync: { messages: false, drafts: installed, activityRunIds: [] },
    })
  }

  discardReturnedInput(sessionId: string, operationId: string): ConversationPatch {
    let removed: string | undefined
    this.database.transaction(() => {
      const { record } = this.verifyReturnedInput(operationId, sessionId)
      if (record.state === 'installed')
        throw new RunOperationConflictError(
          'Send or keep the restored input before discarding its receipt.',
        )
      record.state = 'consumed'
      if (record.inputBatchRef) this.withdrawInputBatch(record.inputBatchRef.id)
      this.database
        .update(nativeRebuildOperations)
        .set({ returnedInputJson: JSON.stringify(record) })
        .where(eq(nativeRebuildOperations.id, operationId))
        .run()
      this.database
        .update(conversationMessages)
        .set({ isVisible: false })
        .where(eq(conversationMessages.id, record.messageId))
        .run()
      this.nativeFact(record.runId, 'native.input_dismissed', {
        operationId,
        messageId: record.messageId,
      })
      removed = record.messageId
    })
    return this.createPatch(sessionId, removed ? { removedMessageIds: [removed] } : {})
  }

  returnedInputRoute(sessionId: string, operationId: string): ConversationMessageRoute {
    return this.verifyReturnedInput(operationId, sessionId).record.route
  }

  markNativeRebuildDispatched(id: string, executorId?: string): void {
    this.database.transaction(() => {
      const operation = this.database
        .select({ sessionId: nativeRebuildOperations.sessionId })
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, id))
        .get()
      if (!operation) throw new RunOperationConflictError('This native rebuild is unavailable.')
      assertSessionAvailable(this.database, operation.sessionId)
      this.database
        .update(nativeRebuildOperations)
        .set({
          stage: 'creating',
          nativeWorkState: 'pending',
          creationExecutorId: executorId ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(eq(nativeRebuildOperations.id, id), eq(nativeRebuildOperations.stage, 'preparing')),
        )
        .run()
    })
  }

  readNativeRebuildSource(id: string): NativeContextRebuildChunk[] {
    const row = this.database
      .select({
        sourceHash: nativeRebuildOperations.sourceHash,
        sourceChunksJson: nativeRebuildOperations.sourceChunksJson,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!row?.sourceHash || !row.sourceChunksJson)
      throw new RunOperationConflictError(
        'The candidate has no complete saved initialization source.',
      )
    if (
      Buffer.byteLength(row.sourceChunksJson) > HANDOFF_SAFETY_BYTES ||
      createHash('sha256').update(row.sourceChunksJson).digest('hex') !== row.sourceHash
    )
      throw new RunOperationConflictError('The saved initialization source cannot be verified.')
    const chunks: unknown = JSON.parse(row.sourceChunksJson)
    if (!Array.isArray(chunks) || chunks.length > 4096)
      throw new RunOperationConflictError('The saved initialization source exceeds its limit.')
    return chunks.map((chunk: unknown) => nativeContextRebuildChunkSchema.parse(chunk))
  }

  recordNativeRebuildIdentity(id: string, nativeSessionId: string): void {
    nativeEvidenceIdentitySchema.shape.nativeSessionId.parse(nativeSessionId)
    const op = this.nativeRebuildOperation(id)
    if (!op || !['creating', 'seeding'].includes(op.stage))
      throw new RunOperationConflictError('The Native creation acknowledgement has no owner.')
    if (op.provisionalNativeSessionId && op.provisionalNativeSessionId !== nativeSessionId)
      throw new RunOperationConflictError('Native acknowledged a different rebuild identity.')
    this.database
      .update(nativeRebuildOperations)
      .set({
        stage: 'seeding',
        provisionalNativeSessionId: nativeSessionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(nativeRebuildOperations.id, id))
      .run()
  }

  failNativeRebuild(id: string, reason: string): ConversationPatch {
    const row = this.database
      .select({
        sessionId: nativeRebuildOperations.sessionId,
        agentId: nativeRebuildOperations.agentId,
        stage: nativeRebuildOperations.stage,
        oldGeneration: nativeRebuildOperations.oldGeneration,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!row) throw new RunOperationConflictError('The rebuild operation is unavailable.')
    if (['completed', 'superseded'].includes(row.stage)) return this.createPatch(row.sessionId)
    this.nativeMetadataTransaction(row.sessionId, () => {
      this.database
        .update(nativeRebuildOperations)
        .set({
          stage: ['creating', 'seeding', 'unconfirmed'].includes(row.stage)
            ? 'unconfirmed'
            : 'failed',
          failureReason: reason.slice(0, 240),
          nativeWorkState: sql`CASE WHEN ${nativeRebuildOperations.nativeWorkState} = 'pending' THEN 'unknown' ELSE ${nativeRebuildOperations.nativeWorkState} END`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(nativeRebuildOperations.id, id))
        .run()
      this.database
        .update(nativeAgentContexts)
        .set({ continuationState: 'recovery_required', recoveryReason: reason.slice(0, 240) })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, row.sessionId),
            eq(nativeAgentContexts.agentId, row.agentId),
            eq(nativeAgentContexts.bindingGeneration, row.oldGeneration),
          ),
        )
        .run()
    })
    return this.createPatch(row.sessionId)
  }

  completeNativeRebuild(
    id: string,
    nativeSessionId: string,
    executorId?: string,
    initializationWitness?: NativeInitializationWitness,
  ): ConversationPatch {
    nativeEvidenceIdentitySchema.shape.nativeSessionId.parse(nativeSessionId)
    nativeEvidenceIdentitySchema.shape.executorId.parse(executorId)
    const witness =
      initializationWitness === undefined
        ? undefined
        : nativeInitializationWitnessSchema.parse(initializationWitness)
    if (witness && witness.nativeSessionId !== nativeSessionId)
      throw new RunOperationConflictError(
        'The initialization witness belongs to another Native Session.',
      )
    const row = this.database
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!row) throw new RunOperationConflictError('The rebuild operation is unavailable.')
    if (row.stage === 'completed') return this.createPatch(row.sessionId)

    if (
      !['seeding', 'unconfirmed'].includes(row.stage) ||
      !row.sourceHash ||
      !row.sourceChunksJson ||
      row.provisionalNativeSessionId !== nativeSessionId
    )
      throw new RunOperationConflictError('The complete Native seed has not been confirmed.')
    if (row.agentId === 'codex' && !witness)
      throw new RunOperationConflictError(
        'The complete native initialization has no durable readback witness.',
      )
    if (witness && row.agentId !== 'codex')
      throw new RunOperationConflictError('The initialization witness belongs to another Agent.')

    const dividerId = randomUUID()
    let returnedMessageId: string | undefined
    let retiredMessages: ConversationPatch['messages'] = []
    this.nativeMetadataTransaction(row.sessionId, () => {
      assertSessionAvailable(this.database, row.sessionId)
      const context = this.nativeContext(row.sessionId, row.agentId)
      if (
        (context?.bindingGeneration ?? 1) !== row.oldGeneration ||
        (context?.nativeSessionId ?? null) !== row.oldNativeSessionId
      )
        throw new RunOperationConflictError('The original Native binding changed during rebuild.')
      retiredMessages = this.cancelPendingRoutedContinuation(
        row.sessionId,
        'native_binding_rebuilt',
      ).messages
      const now = new Date().toISOString()
      const oldRun = row.oldRunId ? this.findRun(row.oldRunId) : undefined
      this.database
        .update(agentRuns)
        .set({ peerProposalState: 'superseded' })
        .where(
          and(
            eq(agentRuns.sessionId, row.sessionId),
            eq(agentRuns.agentId, row.agentId),
            eq(agentRuns.bindingGeneration, row.oldGeneration),
            eq(agentRuns.peerProposalState, 'pending'),
          ),
        )
        .run()
      if (row.abandon && oldRun && oldRun.bindingGeneration === row.oldGeneration) {
        this.database
          .update(agentRuns)
          .set({ controlDisposition: 'abandoned', peerProposalState: 'superseded' })
          .where(eq(agentRuns.id, oldRun.id))
          .run()
        this.database
          .update(conversationMessages)
          .set({ routePendingAgentId: null })
          .where(eq(conversationMessages.id, oldRun.userMessageId))
          .run()
        this.nativeFact(oldRun.id, 'pact.run_abandoned', {
          rebuildId: id,
          oldGeneration: row.oldGeneration,
        })
      }
      const next = {
        nativeSessionId,
        bindingGeneration: row.oldGeneration + 1,
        executorId: executorId ?? null,
        state: 'active' as const,
        continuationState: 'ready' as const,
        permissionRequestsJson: null,
        lastRunId: null,
        recoveryReason: null,
        recoveryFailureKind: null,
        recoveryFailureMessage: null,
        recoveryAction: null,
        rebuildMessageCount: row.messageCount,
        rebuiltThroughSequence:
          row.throughSequence !== null && row.throughSequence >= 0 ? row.throughSequence : null,
        updatedAt: now,
      }
      this.database
        .insert(nativeAgentContexts)
        .values({ sessionId: row.sessionId, agentId: row.agentId, ...next })
        .onConflictDoUpdate({
          target: [nativeAgentContexts.sessionId, nativeAgentContexts.agentId],
          set: next,
        })
        .run()
      this.database
        .update(nativeRebuildOperations)
        .set({
          stage: 'completed',
          nativeWorkState: 'settled',
          initializationWitnessJson: witness ? JSON.stringify(witness) : null,
          returnedInputJson: (() => {
            const returned = this.parseReturnedInput(row.returnedInputJson)
            if (!returned || returned.state !== 'prepared') return row.returnedInputJson
            const current = oldRun && this.freezeReturnedInput(oldRun)
            if (
              !current ||
              JSON.parse(current).hash !== returned.hash ||
              JSON.parse(row.sourceChunksJson!).some(
                (chunk: NativeContextRebuildChunk) => chunk.messageId === returned.messageId,
              )
            )
              return null
            returnedMessageId = returned.messageId
            this.database
              .update(conversationMessages)
              .set({ isVisible: false })
              .where(eq(conversationMessages.id, returned.messageId))
              .run()
            this.nativeFact(returned.runId, 'native.input_return_prepared', {
              operationId: id,
              messageId: returned.messageId,
            })
            return JSON.stringify({ ...returned, state: 'pending' })
          })(),
          updatedAt: now,
        })
        .where(eq(nativeRebuildOperations.id, id))
        .run()
      const sequence =
        (this.database
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.sessionId, row.sessionId))
          .get()?.value ?? -1) + 1
      this.database
        .insert(conversationMessages)
        .values({
          id: dividerId,
          sessionId: row.sessionId,
          agentId: row.agentId,
          role: 'system',
          content: `${row.agentId === 'claude' ? 'Claude Code' : 'Codex'} native session rebuilt`,
          state: 'complete',
          sequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      appendAgentEvent(this.database, {
        sessionId: row.sessionId,
        runId: id,
        eventType: 'native.rebuild_completed',
        payload: JSON.stringify({
          rebuildId: id,
          agentId: row.agentId,
          bindingGeneration: next.bindingGeneration,
          dividerId,
        }),
        createdAt: now,
      })
    })
    return this.createPatch(row.sessionId, {
      ...(returnedMessageId ? { removedMessageIds: [returnedMessageId] } : {}),
      messages: [...retiredMessages, this.messageChange(dividerId, 'replace')],
      runs: this.latestAgentRun(row.sessionId, row.agentId)
        ? [this.latestAgentRun(row.sessionId, row.agentId)!]
        : [],
    })
  }

  saveCommentDraft(input: CommentDraftSaveInput): ConversationPatch {
    const now = new Date().toISOString()
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify(
          input.mode === 'create'
            ? {
                mode: input.mode,
                commentId: input.commentId,
                body: input.body,
                anchor: input.anchor,
              }
            : {
                mode: input.mode,
                commentId: input.commentId,
                body: input.body,
                ...(input.anchor ? { anchor: input.anchor } : {}),
              },
        ),
      )
      .digest('hex')
    const requestHash = createHash('sha256')
      .update(
        `${input.sessionId}:${input.commentId}:${input.expectedCommentsRevision}:${payloadHash}`,
      )
      .digest('hex')
    const fallbackRequestId = `${requestHash.slice(0, 8)}-${requestHash.slice(8, 12)}-5${requestHash.slice(13, 16)}-8${requestHash.slice(17, 20)}-${requestHash.slice(20, 32)}`
    const requestId = input.requestId ?? fallbackRequestId
    let savedId = input.commentId
    let revision = input.expectedCommentsRevision
    this.database.transaction(() => {
      const session = this.database
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()
      if (!session) throw new RunOperationConflictError('Session does not exist.')
      const receipt = this.database
        .select()
        .from(commentDraftReceipts)
        .where(eq(commentDraftReceipts.requestId, requestId))
        .get()
      if (receipt) {
        if (receipt.sessionId !== input.sessionId || receipt.payloadHash !== payloadHash)
          throw new RunOperationConflictError(
            'This Comment request identity belongs to another saved payload.',
          )
        savedId = receipt.commentId
        revision = session.commentsRevision
        return
      }
      const existing = this.database
        .select()
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.id, input.commentId),
            eq(anchoredComments.sessionId, input.sessionId),
          ),
        )
        .get()
      if (
        existing &&
        existing.body === input.body &&
        (input.anchor === undefined || existing.anchorJson === JSON.stringify(input.anchor)) &&
        !existing.sentWithMessageId &&
        !existing.pendingReceiptId
      ) {
        revision = session.commentsRevision
        this.database
          .insert(commentDraftReceipts)
          .values({
            requestId,
            sessionId: input.sessionId,
            commentId: savedId,
            payloadHash,
            commentsRevision: revision,
            createdAt: now,
          })
          .run()
        return
      }
      if (session.commentsRevision !== input.expectedCommentsRevision)
        throw new RunOperationConflictError('Comment drafts changed. Refresh and try again.')
      if (input.mode === 'create') {
        if (
          existing &&
          (existing.sentWithMessageId ||
            existing.pendingReceiptId ||
            existing.anchorJson !== JSON.stringify(input.anchor))
        )
          throw new RunOperationConflictError(
            'This Comment identity already belongs to another source or frozen draft.',
          )
        let answerKey: string | null = null
        if (input.anchor.type === 'todo') {
          const anchor = input.anchor
          const task = this.database
            .select()
            .from(collaborationTasks)
            .where(
              and(
                eq(collaborationTasks.id, anchor.taskId),
                eq(collaborationTasks.sessionId, input.sessionId),
              ),
            )
            .get()
          const todo = this.database
            .select()
            .from(collaborationTodoRevisions)
            .where(
              and(
                eq(collaborationTodoRevisions.taskId, anchor.taskId),
                eq(collaborationTodoRevisions.todoId, anchor.todoId),
                eq(collaborationTodoRevisions.revision, anchor.todoRevision),
              ),
            )
            .get()
          if (!task || !todo)
            throw new RunOperationConflictError('The exact Todo source is unavailable.')
          if (anchor.question) {
            if (
              todo.questionId !== anchor.question.id ||
              todo.questionRevision !== anchor.question.revision
            )
              throw new RunOperationConflictError(
                'The answer belongs to another question revision.',
              )
            const definition = todo.questionJson
              ? collaborationTodoQuestionSchema.parse(JSON.parse(todo.questionJson))
              : undefined
            if (
              !definition ||
              (anchor.question.optionIndex !== undefined &&
                (definition.type !== 'choice' ||
                  anchor.question.optionIndex >= definition.options.length))
            )
              throw new RunOperationConflictError(
                'The selected answer does not belong to this question.',
              )
            answerKey = `${anchor.taskId}:${anchor.todoId}:${anchor.question.id}:${anchor.question.revision}`
          }
        }
        const answer =
          existing ??
          (answerKey
            ? this.database
                .select()
                .from(anchoredComments)
                .where(
                  and(
                    eq(anchoredComments.sessionId, input.sessionId),
                    eq(anchoredComments.answerKey, answerKey),
                    isNull(anchoredComments.sentWithMessageId),
                    isNull(anchoredComments.pendingReceiptId),
                  ),
                )
                .get()
            : undefined)
        if (answer) {
          savedId = answer.id
          this.database
            .update(anchoredComments)
            .set({
              body: input.body,
              anchorJson: JSON.stringify(input.anchor),
              draftRevision: answer.draftRevision + 1,
              updatedAt: now,
            })
            .where(eq(anchoredComments.id, answer.id))
            .run()
        } else {
          const position =
            (this.database
              .select({ value: max(anchoredComments.position) })
              .from(anchoredComments)
              .where(eq(anchoredComments.sessionId, input.sessionId))
              .get()?.value ?? -1) + 1
          this.database
            .insert(anchoredComments)
            .values({
              id: input.commentId,
              sessionId: input.sessionId,
              body: input.body,
              anchorJson: JSON.stringify(input.anchor),
              answerKey,
              draftRevision: 1,
              position,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }
      } else {
        if (!existing || existing.sentWithMessageId || existing.pendingReceiptId)
          throw new RunOperationConflictError('Only an unsent Comment draft can be edited.')
        let editedAnchor = existing.anchorJson
        if (input.anchor) {
          const previous = commentAnchorSchema.parse(JSON.parse(existing.anchorJson))
          const candidate = commentAnchorSchema.parse(input.anchor)
          if (previous.type !== 'todo' || candidate.type !== 'todo')
            throw new RunOperationConflictError('Only a Todo answer choice may update its anchor.')
          if (
            JSON.stringify(todoAnswerSource(previous)) !==
            JSON.stringify(todoAnswerSource(candidate))
          )
            throw new RunOperationConflictError(
              'A Comment edit cannot retarget its immutable source.',
            )
          const todo = this.database
            .select()
            .from(collaborationTodoRevisions)
            .where(
              and(
                eq(collaborationTodoRevisions.taskId, candidate.taskId),
                eq(collaborationTodoRevisions.todoId, candidate.todoId),
                eq(collaborationTodoRevisions.revision, candidate.todoRevision),
              ),
            )
            .get()
          const question = todo?.questionJson
            ? collaborationTodoQuestionSchema.parse(JSON.parse(todo.questionJson))
            : undefined
          if (
            candidate.question?.optionIndex !== undefined &&
            (!question ||
              question.type !== 'choice' ||
              candidate.question.optionIndex >= question.options.length)
          )
            throw new RunOperationConflictError('The edited answer choice is invalid.')
          editedAnchor = JSON.stringify(candidate)
        }
        this.database
          .update(anchoredComments)
          .set({
            body: input.body,
            anchorJson: editedAnchor,
            draftRevision: existing.draftRevision + 1,
            updatedAt: now,
          })
          .where(eq(anchoredComments.id, existing.id))
          .run()
      }
      revision = session.commentsRevision + 1
      this.database
        .update(sessions)
        .set({ commentsRevision: revision, updatedAt: now })
        .where(eq(sessions.id, input.sessionId))
        .run()
      this.database
        .insert(commentDraftReceipts)
        .values({
          requestId,
          sessionId: input.sessionId,
          commentId: savedId,
          payloadHash,
          commentsRevision: revision,
          createdAt: now,
        })
        .run()
    })
    const comment = this.comment(savedId)

    return this.createPatch(input.sessionId, {
      commentDraftReceipt: { requestId, commentId: savedId },
      comments: { revision, upserts: comment ? [comment] : [], removedIds: [] },
      ...(!comment ? { resync: { messages: false, drafts: true, activityRunIds: [] } } : {}),
    })
  }

  removeCommentDraft(input: CommentDraftRemoveInput): ConversationPatch {
    const now = new Date().toISOString()
    this.database.transaction((transaction) => {
      const session = transaction
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()
      if (!session) throw new Error('Session does not exist.')
      if (session.commentsRevision !== input.expectedCommentsRevision) {
        throw new Error('Comment drafts changed. Refresh and try again.')
      }
      const draft = transaction
        .select()
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.id, input.commentId),
            eq(anchoredComments.sessionId, input.sessionId),
          ),
        )
        .get()
      if (!draft || draft.sentWithMessageId || draft.pendingReceiptId)
        throw new Error('Only an unsent Comment draft can be removed.')
      transaction.delete(anchoredComments).where(eq(anchoredComments.id, input.commentId)).run()
      transaction
        .update(sessions)
        .set({ commentsRevision: session.commentsRevision + 1, updatedAt: now })
        .where(eq(sessions.id, input.sessionId))
        .run()
    })
    return this.createPatch(input.sessionId, {
      comments: {
        revision: input.expectedCommentsRevision + 1,
        upserts: [],
        removedIds: [input.commentId],
      },
    })
  }

  comment(commentId: string): AnchoredComment | undefined {
    const row = this.database
      .select()
      .from(anchoredComments)
      .where(eq(anchoredComments.id, commentId))
      .get()
    return row ? ConversationRepository.toComment(row) : undefined
  }

  commentsForMessage(messageId: string): AnchoredComment[] {
    return this.database
      .select()
      .from(anchoredComments)
      .where(eq(anchoredComments.sentWithMessageId, messageId))
      .orderBy(asc(anchoredComments.position))
      .all()
      .map((comment) => ConversationRepository.toComment(comment))
  }

  findRun(runId: string): AgentRun | undefined {
    const run = this.database
      .select(publicRunColumns)
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .get()
    return run ? ConversationRepository.toRun(run) : undefined
  }

  recordWorkspaceChanges(summary: WorkspaceChangeSet): ConversationPatch {
    const parsed = workspaceChangeSetSchema.parse(summary)
    const run = this.findRun(parsed.runId)
    if (
      !run ||
      run.id !== parsed.id ||
      run.sessionId !== parsed.sessionId ||
      run.agentId !== parsed.agentId
    )
      throw new Error('Workspace changes do not belong to this Agent Run.')
    const payload = JSON.stringify(parsed)
    this.database.transaction((transaction) => {
      const stored = transaction
        .select()
        .from(workspaceChangeSets)
        .where(eq(workspaceChangeSets.id, parsed.id))
        .get()
      if (!stored) throw new Error('Workspace changes do not exist.')
      const {
        root: _root,
        rootDevice: _rootDevice,
        rootInode: _rootInode,
        stagingRoot: _stagingRoot,
        projectionPending: _projectionPending,
        ...persisted
      } = stored
      const incompleteCounts = transaction
        .select({ path: workspaceFileChanges.path })
        .from(workspaceFileChanges)
        .where(
          and(
            eq(workspaceFileChanges.changeSetId, parsed.id),
            sql`(${workspaceFileChanges.additions} IS NULL OR ${workspaceFileChanges.deletions} IS NULL)`,
          ),
        )
        .limit(1)
        .get()
      const authoritative = {
        ...persisted,
        ...(parsed.countsAvailable === undefined
          ? {}
          : { countsAvailable: incompleteCounts === undefined }),
      }
      if (JSON.stringify(workspaceChangeSetSchema.parse(authoritative)) !== payload)
        throw new Error('Workspace changes changed before publication.')
      const previous = transaction
        .select({ summary: agentRuns.workspaceChangesJson })
        .from(agentRuns)
        .where(eq(agentRuns.id, run.id))
        .get()
      transaction
        .update(workspaceChangeSets)
        .set({ projectionPending: false })
        .where(eq(workspaceChangeSets.id, parsed.id))
        .run()
      if (previous?.summary === payload) return
      const now = new Date().toISOString()

      appendAgentEvent(transaction, {
        sessionId: run.sessionId,
        runId: run.id,
        eventType: 'workspace.changes_updated',
        payload,
        createdAt: now,
      })
      transaction
        .update(agentRuns)
        .set({ workspaceChangesJson: payload, updatedAt: now })
        .where(eq(agentRuns.id, run.id))
        .run()
    })
    const updated = this.findRun(run.id)
    if (!updated) throw new Error('Agent Run does not exist.')
    return this.createPatch(run.sessionId, { runs: [updated] })
  }

  recordWorkspaceRecordingUnavailable(runId: string, reason: string): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('The file recording owner is unavailable.')
    const message = reason.slice(0, 240)
    this.database.transaction(() => {
      this.database
        .update(agentRuns)
        .set({ workspaceRecordingUnavailableReason: message })
        .where(eq(agentRuns.id, runId))
        .run()
      this.nativeFact(runId, 'workspace.recording_unavailable', { reason: message })
    })
    return this.runPatch(runId)
  }

  expireNativePermissions(): void {
    this.database
      .update(nativeAgentContexts)
      .set({ permissionRequestsJson: null })
      .where(isNotNull(nativeAgentContexts.permissionRequestsJson))
      .run()
  }

  recordContextPermissions(
    sessionId: string,
    agentId: RuntimeAgentId,
    operationId: string,
    requests: import('@pact/contracts').NativePermissionRequest[],
    decision?: {
      permissionId: string
      decision?: 'once' | 'session' | 'deny' | 'accept' | 'decline' | 'cancel'
      source?: 'user' | 'expired' | 'aborted'
      actionId?: string
      actionKind?: 'allow' | 'decline' | 'cancel' | 'rule'
    },
    scope?: { bindingGeneration: number; projectionAllowed: boolean },
  ): ConversationPatch {
    const parsed = nativePermissionRequestSchema
      .array()
      .max(NATIVE_PERMISSION_REQUESTS)
      .parse(requests)
    const summaries = parsed.map((request) => {
      const summary: import('@pact/contracts').NativePermissionRequest = {
        id: request.id,
        kind: request.kind ?? 'approval',
        title: 'Native interaction',
        detail: '',
        createdAt: request.createdAt,
      }
      if (request.operationId) summary.operationId = request.operationId
      return summary
    })
    this.database.transaction((transaction) => {
      const createdAt = new Date().toISOString()

      appendAgentEvent(transaction, {
        sessionId,
        runId: operationId,
        eventType: decision ? 'native.permission_decided' : 'native.permission_requested',
        payload: JSON.stringify({ agentId, requests: summaries, decision }),
        createdAt,
      })
      const binding = this.nativeContext(sessionId, agentId)
      const rebuild = this.pendingNativeRebuild(sessionId, agentId)
      const projectionAllowed =
        scope === undefined ||
        (scope.projectionAllowed &&
          (binding?.bindingGeneration === scope.bindingGeneration ||
            (rebuild?.id === operationId && rebuild.oldGeneration + 1 === scope.bindingGeneration)))
      if (projectionAllowed)
        transaction
          .update(nativeAgentContexts)
          .set({
            permissionRequestsJson: summaries.length ? JSON.stringify(summaries) : null,
            updatedAt: createdAt,
          })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, sessionId),
              eq(nativeAgentContexts.agentId, agentId),
            ),
          )
          .run()
    })
    return this.createPatch(sessionId, {})
  }

  updateAttempt(runId: string, attemptCount: number, recovering: boolean): ConversationPatch {
    const updatedAt = new Date().toISOString()
    const run = this.findRun(runId)
    if (!run) throw new Error('Agent Run does not exist.')
    this.nativeMetadataTransaction(run.sessionId, (transaction) => {
      appendAgentEvent(transaction, {
        sessionId: run.sessionId,
        runId,
        eventType: 'run.attempt_started',
        payload: JSON.stringify({ attemptCount, recovering }),
        createdAt: updatedAt,
      })
      transaction
        .update(agentRuns)
        .set({
          attemptCount,
          status: recovering ? 'recovering' : 'running',
          ...(recovering ? { nativeTurnId: null } : {}),
          failureKind: null,
          failureMessage: null,
          updatedAt,
        })
        .where(eq(agentRuns.id, runId))
        .run()
      transaction
        .update(agentRuns)
        .set({ peerProposalState: 'superseded', updatedAt })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
        .run()
      transaction.update(sessions).set({ updatedAt }).where(eq(sessions.id, run.sessionId)).run()
    })
    const updated = this.findRun(runId)
    if (!updated) throw new Error('Agent Run does not exist.')
    return this.createPatch(run.sessionId, { runs: [updated] })
  }

  applyEvent(sessionId: string, runId: string, event: NormalizedAgentEvent): ConversationPatch {
    return this.commitEvents(sessionId, runId, [event])
  }

  /** Seal a complete authority snapshot before replacing a saved partial body. */
  async completeAnswer(
    runId: string,
    metadata: CompleteAnswerMetadata,
    source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
    signal: AbortSignal,
    options: { archive?: boolean; bodyState?: 'complete' | 'incomplete' } = {},
  ): Promise<ConversationPatch> {
    signal.throwIfAborted()
    const run = this.findRun(runId)
    if (
      !run ||
      metadata.agentId !== run.agentId ||
      (run.nativeTurnId && run.nativeTurnId !== metadata.turnId)
    )
      throw new RunOperationConflictError('This complete answer has no matching Run owner.')
    const ownerKey = `answer:${runId}`
    this.sweepConversationInputs()
    const now = new Date().toISOString()
    const inputId = randomUUID()
    const expiresAt = performance.now() + 10_000
    this.database.transaction(() => {
      this.bodyCapacity(ownerKey, 0, true)
      this.database
        .insert(conversationBodyInputs)
        .values({
          id: inputId,
          sessionId: run.sessionId,
          clientMessageId: `${metadata.outputId}:${inputId}`,
          ownerKey,
          purpose: 'answer',
          sourceRunId: runId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), Math.max(1, expiresAt - performance.now()))
    const observed = AbortSignal.any([signal, deadline.signal])
    const check = (): void => {
      if (performance.now() >= expiresAt) deadline.abort()
      observed.throwIfAborted()
    }
    let iterator: AsyncIterator<string> | undefined
    try {
      // This seam accepts only controlled, cooperative snapshot sources. It does not
      // admit arbitrary external readers whose next/return cannot respond to abort.
      iterator = source(observed)[Symbol.asyncIterator]()
      for (;;) {
        check()
        // oxlint-disable-next-line no-await-in-loop -- This candidate has one physical source read in flight.
        const next = await iterator.next()
        check()
        if (next.done) break
        const text = next.value
        if (typeof text !== 'string' || text.length > 64 * 1024 || !validBodyText(text))
          throw new RunOperationConflictError(
            'Complete answer source must provide bounded Unicode segments.',
          )
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(text.length, offset + BODY_PART_UNITS)
          if (
            end < text.length &&
            text.charCodeAt(end - 1) >= 0xd800 &&
            text.charCodeAt(end - 1) <= 0xdbff
          )
            end--
          const part = text.slice(offset, end)
          check()
          this.database.transaction(() => {
            const row = this.bodyInput(inputId, run.sessionId, ownerKey)
            this.appendBodyPart(row, row.chars, part)
          })
          offset = end
          // oxlint-disable-next-line no-await-in-loop -- Durable candidate segments yield the Utility control plane between writes.
          await yieldImmediate(undefined, { signal: observed })
        }
      }
      check()
      this.database.transaction(() =>
        this.sealBody(this.bodyInput(inputId, run.sessionId, ownerKey)),
      )
      const row = this.bodyInput(inputId, run.sessionId, ownerKey)
      if (!row.hash) throw new RunOperationConflictError('Complete answer candidate changed.')
      check()
      return this.commitEvents(
        run.sessionId,
        runId,
        [{ ...metadata, text: '' }],
        options.archive ?? false,
        options.bodyState,
        { version: 1, inputId, sha256: row.hash, bytes: row.bytes, chars: row.chars },
      )
    } finally {
      deadline.abort()
      try {
        // A logical cancellation cannot release the candidate before its source closes.
        await iterator?.return?.()
      } finally {
        clearTimeout(timer)
        // Committed versions are durable Journal sources; only abandoned candidates can be removed.
        this.database
          .delete(conversationBodyInputs)
          .where(
            and(
              eq(conversationBodyInputs.id, inputId),
              isNull(conversationBodyInputs.committedMessageId),
              isNull(conversationBodyInputs.pendingReceiptId),
            ),
          )
          .run()
      }
    }
  }

  applyArchivedEvent(
    sessionId: string,
    runId: string,
    event: NormalizedAgentEvent,
  ): ConversationPatch {
    return this.commitEvents(sessionId, runId, [event], true)
  }

  private prepareNativeOutput(
    runId: string,
    output: NativeRecoveredOutput,
  ): { run: AgentRun } | { patch: ConversationPatch } {
    const run = this.findRun(runId)
    if (!run) throw new RunOperationConflictError('Native output has no recorded Run owner.')
    if (!run.nativeTurnId) {
      this.nativeFact(runId, 'native.unbound_output_not_projected', {
        outputId: output.outputId,
        hash: createHash('sha256').update(output.text).digest('hex'),
        reason: 'No native Turn identity was confirmed for this output.',
      })
      return { patch: this.runPatch(runId) }
    }
    // A complete archived version is durable evidence, not proof of UI delivery.
    // Preserve every accepted visible answer, including one before a newer archive.
    const acceptedComplete = this.hasCompleteResponse(runId)
    const previous = !acceptedComplete
      ? this.database
          .select({
            content: conversationMessages.content,
            state: conversationMessages.state,
            isVisible: conversationMessages.isVisible,
          })
          .from(conversationMessages)
          .where(
            and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
          )
          .orderBy(desc(conversationMessages.sequence))
          .limit(1)
          .get()
      : undefined
    const repeatedHidden =
      previous?.isVisible === false &&
      previous.content === output.text &&
      previous.state === (output.completeness === 'complete' ? 'complete' : 'incomplete') &&
      !this.mayProjectNativeBody(run)
    if (
      acceptedComplete ||
      repeatedHidden ||
      (previous && output.completeness === 'partial' && !output.text.startsWith(previous.content))
    ) {
      this.nativeFact(runId, 'native.recovered_output_not_projected', {
        outputId: output.outputId,
        completeness: output.completeness,
        hash: createHash('sha256').update(output.text).digest('hex'),
        reason: acceptedComplete
          ? 'The accepted completed answer was preserved.'
          : repeatedHidden
            ? 'This hidden recovered version was already recorded.'
            : 'Partial readback cannot replace the saved answer.',
      })
      return { patch: this.runPatch(runId) }
    }
    return { run }
  }

  recordNativeOutput(runId: string, output: NativeRecoveredOutput): ConversationPatch {
    const prepared = this.prepareNativeOutput(runId, output)
    if ('patch' in prepared) return prepared.patch
    const { run } = prepared
    return this.commitEvents(
      run.sessionId,
      runId,
      [
        {
          agentId: run.agentId,
          type: 'text.completed',
          turnId: run.nativeTurnId!,
          outputId: output.outputId,
          text: output.text,
        },
      ],
      true,
      output.completeness === 'complete' ? 'complete' : 'incomplete',
    )
  }

  async recordNativeOutputComplete(
    runId: string,
    output: NativeRecoveredOutput,
    signal: AbortSignal,
  ): Promise<ConversationPatch> {
    if (Buffer.byteLength(output.text) <= CONVERSATION_PATCH_TEXT_BYTES)
      return this.recordNativeOutput(runId, output)
    const prepared = this.prepareNativeOutput(runId, output)
    if ('patch' in prepared) return prepared.patch
    const { run } = prepared
    const source = (physicalSignal: AbortSignal): AsyncIterable<string> =>
      (async function* (): AsyncIterable<string> {
        for (let offset = 0; offset < output.text.length;) {
          let end = Math.min(output.text.length, offset + BODY_PART_UNITS)
          if (
            end < output.text.length &&
            output.text.charCodeAt(end - 1) >= 0xd800 &&
            output.text.charCodeAt(end - 1) <= 0xdbff
          )
            end--
          physicalSignal.throwIfAborted()
          yield output.text.slice(offset, end)
          offset = end
        }
      })()
    return this.completeAnswer(
      runId,
      {
        agentId: run.agentId,
        type: 'text.completed',
        turnId: run.nativeTurnId!,
        outputId: output.outputId,
      },
      source,
      signal,
      { archive: true, bodyState: output.completeness === 'complete' ? 'complete' : 'incomplete' },
    )
  }

  applyArchivedBatch(
    sessionId: string,
    runId: string,
    events: readonly StreamDeltaEvent[],
  ): ConversationPatch {
    return this.commitEvents(sessionId, runId, events, true)
  }

  applyStreamBatch(
    sessionId: string,
    runId: string,
    events: readonly StreamDeltaEvent[],
  ): ConversationPatch {
    if (events.length === 0 || events.length > CONVERSATION_STREAM_BATCH_ITEMS)
      throw new Error('Invalid stream batch size.')
    if (Buffer.byteLength(JSON.stringify(events), 'utf8') > CONVERSATION_STREAM_BATCH_BYTES)
      throw new Error('Stream batch exceeds its serialized byte limit.')
    // Buffer owns coalescing; reject ambiguous batches rather than merge twice.
    const keys = new Set<string>()
    for (const event of events) {
      const key = conversationStreamDeltaKey(event)
      if (keys.has(key)) throw new Error('Stream batch must contain coalesced keys.')
      keys.add(key)
    }
    return this.commitEvents(sessionId, runId, events)
  }

  private commitEvents(
    sessionId: string,
    runId: string,
    events: readonly NormalizedAgentEvent[],
    archive = false,
    bodyState?: 'complete' | 'incomplete',
    sealedBody?: SealedBodyFact,
  ): ConversationPatch {
    if (
      events.every((event) => event.type === 'session.title.updated') &&
      !this.ownsNativeControl(runId)
    )
      archive = true
    const observation = this.observations.get(sessionId)
    const patchesBefore = this.patchCount
    try {
      const patch = this.database.transaction((transaction) => {
        if (events.some((event) => event.type !== 'session.title.updated')) {
          const current = transaction
            .select({
              id: agentRuns.id,
              agentId: agentRuns.agentId,
              status: agentRuns.status,
              nativeTurnId: agentRuns.nativeTurnId,
            })
            .from(agentRuns)
            .where(
              archive
                ? and(eq(agentRuns.id, runId), eq(agentRuns.sessionId, sessionId))
                : eq(agentRuns.sessionId, sessionId),
            )
            .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
            .limit(1)
            .get()
          if (
            current?.id !== runId ||
            events.some((event) => event.agentId !== current.agentId) ||
            !(archive || activeRunStatuses.some((status) => status === current.status))
          )
            throw new RunOperationConflictError('This Run no longer owns the Session.')
          if (
            events.some(
              (event) =>
                'turnId' in event && current.nativeTurnId && event.turnId !== current.nativeTurnId,
            )
          )
            throw new RunOperationConflictError('This result belongs to an earlier native Turn.')
        }
        const changes = events.map((event) =>
          this.applyEventWithinTransaction(
            transaction,
            sessionId,
            runId,
            event,
            archive,
            bodyState,
            sealedBody,
          ),
        )
        if (!archive)
          transaction
            .update(sessions)
            .set({ updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId))
            .run()
        const messageChanges = changes.flatMap((change) => (change.message ? [change.message] : []))
        if (
          events.some((event) => event.type === 'turn.completed' && event.outcome !== 'completed')
        ) {
          const failedRun = transaction
            .select({ userMessageId: agentRuns.userMessageId })
            .from(agentRuns)
            .where(eq(agentRuns.id, runId))
            .get()
          if (failedRun)
            messageChanges.push({ id: failedRun.userMessageId, mode: 'metadata' as const })
        }
        const uniqueMessages = new Map<string, (typeof messageChanges)[number]>()
        for (const change of messageChanges) {
          const previous = uniqueMessages.get(change.id)
          uniqueMessages.set(change.id, previous?.mode === 'replace' ? previous : change)
        }
        const messages = [...uniqueMessages.values()]
          .filter(
            (change) =>
              transaction
                .select({ visible: conversationMessages.isVisible })
                .from(conversationMessages)
                .where(eq(conversationMessages.id, change.id))
                .get()?.visible,
          )
          .map((change) =>
            this.messageChange(change.id, change.mode, change.text, change.previousRevision),
          )
        const activityChanges = changes.flatMap((change) =>
          change.activity ? [change.activity] : [],
        )
        const activities = activityChanges
          .slice(0, CONVERSATION_PATCH_ACTIVITY_ITEMS)
          .map((change) =>
            this.activityChange(change.id, change.mode, change.detail, change.previousRevision),
          )
        if (
          events.some((event) =>
            ['session.started', 'turn.started', 'turn.completed', 'text.completed'].includes(
              event.type,
            ),
          )
        )
          refreshNativeSessionMetadata(transaction, sessionId)
        const run = this.findRun(runId)
        return this.createPatch(sessionId, {
          messages,
          removedMessageIds: changes.flatMap((change) => change.removedMessageIds ?? []),
          activities,
          ...(run ? { runs: [run] } : {}),
          activityStates: changes.flatMap((change) => change.activityStates),
          ...(activityChanges.length > activities.length
            ? { resync: { messages: false, drafts: false, activityRunIds: [runId] } }
            : {}),
        })
      })
      this.eventTransactionCount += 1
      return patch
    } catch (error) {
      // Projection validation and writes are atomic; no Patch escapes before COMMIT.
      if (observation) this.observations.set(sessionId, observation)
      else this.observations.delete(sessionId)
      this.patchCount = patchesBefore
      throw error
    }
  }

  private applyEventWithinTransaction(
    transaction: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
    sessionId: string,
    runId: string,
    event: NormalizedAgentEvent,
    archive = false,
    bodyState?: 'complete' | 'incomplete',
    sealedBody?: SealedBodyFact,
  ): EventChanges {
    const now = new Date().toISOString()
    const removedMessageIds: string[] = []
    let messageChange:
      | {
          id: string
          mode: ConversationMessageChange['mode']
          text?: string
          previousRevision?: number
        }
      | undefined
    let activityChange:
      | {
          id: string
          mode: ConversationActivityChange['mode']
          detail?: string
          previousRevision?: number
        }
      | undefined
    const activityStates: ConversationPatch['activityStates'] = []

    let eventSequence: number | undefined
    if (!sealedBody && event.type !== 'text.delta' && event.type !== 'reasoning.summary.delta') {
      eventSequence = appendAgentEvent(transaction, {
        sessionId,
        runId,
        eventType: event.type,
        payload: JSON.stringify(event),
        createdAt: now,
      })
    }

    if (event.type === 'session.started') {
      const run = this.findRun(runId)
      if (!run) throw new RunOperationConflictError('The native Run is unavailable.')
      if (run.nativeSessionId && run.nativeSessionId !== event.nativeSessionId)
        throw new RunOperationConflictError('Native startup acknowledged a different Run binding.')
      if (archive) {
        transaction
          .update(agentRuns)
          .set({ nativeSessionId: event.nativeSessionId })
          .where(eq(agentRuns.id, runId))
          .run()
        return { activityStates, removedMessageIds }
      }
      const priorContext = transaction
        .select({
          nativeSessionId: nativeAgentContexts.nativeSessionId,
          bindingGeneration: nativeAgentContexts.bindingGeneration,
          rebuildMessageCount: nativeAgentContexts.rebuildMessageCount,
          rebuiltThroughSequence: nativeAgentContexts.rebuiltThroughSequence,
        })
        .from(nativeAgentContexts)
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, event.agentId),
          ),
        )
        .get()
      const sameNativeContext = priorContext?.nativeSessionId === event.nativeSessionId
      if (
        priorContext &&
        (!sameNativeContext || priorContext.bindingGeneration !== run.bindingGeneration)
      )
        throw new RunOperationConflictError(
          'The native binding changed before startup acknowledgement.',
        )
      transaction
        .insert(nativeAgentContexts)
        .values({
          sessionId,
          agentId: event.agentId,
          nativeSessionId: event.nativeSessionId,
          bindingGeneration: run.bindingGeneration ?? 1,
          executorId: run.executorId ?? null,
          continuationState: 'responding',
          state: 'active',
          lastRunId: runId,
          recoveryFailureKind: null,
          recoveryFailureMessage: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [nativeAgentContexts.sessionId, nativeAgentContexts.agentId],
          set: {
            nativeSessionId: event.nativeSessionId,
            bindingGeneration: run.bindingGeneration ?? 1,
            executorId: run.executorId ?? null,
            continuationState: 'responding',
            state: 'active',
            lastRunId: runId,
            recoveryFailureKind: null,
            recoveryFailureMessage: null,
            rebuildMessageCount: sameNativeContext ? priorContext.rebuildMessageCount : null,
            rebuiltThroughSequence: sameNativeContext ? priorContext.rebuiltThroughSequence : null,
            updatedAt: now,
          },
        })
        .run()
      transaction
        .update(agentRuns)
        .set({ nativeSessionId: event.nativeSessionId, status: 'running', updatedAt: now })
        .where(eq(agentRuns.id, runId))
        .run()
    } else if (event.type === 'run.model.resolved') {
      transaction
        .update(agentRuns)
        .set({
          model: event.model,
          ...(event.effort !== undefined ? { effort: event.effort } : {}),
          updatedAt: now,
        })
        .where(eq(agentRuns.id, runId))
        .run()
    } else if (event.type === 'session.title.updated') {
      if (archive) return { activityStates, removedMessageIds }
      if (event.origin !== 'turn_result') {
        const current = transaction
          .select({ title: sessions.title, source: sessions.titleSource })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get()
        // A successfully reported Pact title survives failed/uncertain Native naming
        // and cold resume. Older Native-only titles retain their existing priority.
        if (
          current?.source === 'agent' &&
          transaction
            .select({ sequence: agentEventJournal.sequence })
            .from(agentEventJournal)
            .where(
              and(
                eq(agentEventJournal.sessionId, sessionId),
                sql`${agentEventJournal.eventType} = 'session.title.updated'`,
                sql`json_extract(${agentEventJournal.payload}, '$.titleAdopted') = 1`,
                sql`json_extract(${agentEventJournal.payload}, '$.title') = ${current.title}`,
              ),
            )
            .limit(1)
            .get()
        )
          return { activityStates, removedMessageIds }
      }
      const latestRunId = transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
        .where(eq(agentRuns.sessionId, sessionId))
        .orderBy(
          desc(conversationMessages.sequence),
          desc(agentRuns.createdAt),
          desc(sql`${agentRuns}.rowid`),
        )
        .limit(1)
        .get()?.id
      if (latestRunId === runId && this.ownsNativeControl(runId)) {
        const adopted = transaction
          .update(sessions)
          .set({ title: event.title, titleSource: 'agent', updatedAt: now })
          .where(
            and(
              eq(sessions.id, sessionId),
              ne(sessions.titleSource, 'user'),
              ...(event.origin === 'turn_result'
                ? [inArray(sessions.titleSource, ['placeholder', 'local'])]
                : []),
              // A Fork's local title is frozen inherited metadata, not the first
              // question's temporary fallback. Native readback cannot replace it.
              or(
                ne(sessions.titleSource, 'local'),
                sql`NOT EXISTS (
              SELECT 1 FROM ${sessionForkOperations}
              WHERE ${sessionForkOperations.sessionId} = ${sessions.id}
            )`,
              ),
            ),
          )
          .returning({ id: sessions.id })
          .get()
        if (adopted && event.origin === 'turn_result' && eventSequence !== undefined)
          transaction
            .update(agentEventJournal)
            .set({ payload: JSON.stringify({ ...event, titleAdopted: true }) })
            .where(
              and(
                eq(agentEventJournal.sessionId, sessionId),
                eq(agentEventJournal.sequence, eventSequence),
              ),
            )
            .run()
      }
    } else if (event.type === 'turn.started') {
      transaction
        .update(agentRuns)
        .set({
          nativeTurnId: event.turnId,
          dispatchPhase: 'accepted',
          ...(!archive ? { status: 'running' as const, updatedAt: now } : {}),
        })
        .where(eq(agentRuns.id, runId))
        .run()
    } else if (event.type === 'peer.assistance.requested') {
      if (archive) return { activityStates, removedMessageIds }
      if (event.targetAgentId === event.agentId)
        throw new RunOperationConflictError('An Agent cannot request itself as a peer.')
      const owner = transaction
        .select({
          id: agentRuns.peerProposalId,
          state: agentRuns.peerProposalState,
          agentId: agentRuns.agentId,
          routeKind: conversationMessages.routeKind,
        })
        .from(agentRuns)
        .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
        .where(eq(agentRuns.id, runId))
        .get()
      if (!owner || owner.agentId !== event.agentId)
        throw new RunOperationConflictError('This peer request does not belong to the Agent Run.')
      if (owner.routeKind === 'all')
        throw new RunOperationConflictError('@all Runs cannot request additional peer assistance.')
      if (owner.id && owner.state === 'accepted')
        return { message: undefined, activity: undefined, activityStates: [], removedMessageIds }
      transaction
        .update(agentRuns)
        .set({
          peerProposalId: event.proposalId,
          peerProposalTargetAgentId: event.targetAgentId,
          peerProposalKind: event.kind,
          peerProposalReason: event.reason ?? null,
          peerProposalState: 'pending',
          peerProposalAcceptedMessageId: null,
          updatedAt: now,
        })
        .where(eq(agentRuns.id, runId))
        .run()
    } else if (event.type === 'interaction.requested') {
      transaction
        .update(sessions)
        .set({ status: 'waiting_for_user', updatedAt: now })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.archivedAt)))
        .run()
    } else if (
      event.type === 'reasoning.summary.delta' ||
      event.type === 'reasoning.summary.completed' ||
      event.type === 'tool.started' ||
      event.type === 'tool.completed'
    ) {
      const nativeId =
        event.type === 'reasoning.summary.delta' || event.type === 'reasoning.summary.completed'
          ? event.activityId
          : event.toolCallId
      const kind =
        event.type === 'reasoning.summary.delta' || event.type === 'reasoning.summary.completed'
          ? ('reasoning' as const)
          : ('tool' as const)
      const existing = transaction
        .select()
        .from(agentRunActivities)
        .where(
          and(
            eq(agentRunActivities.runId, runId),
            eq(agentRunActivities.kind, kind),
            eq(agentRunActivities.nativeId, nativeId),
          ),
        )
        .get()
      this.streamLookups.activity.queries += 1
      this.streamLookups.activity.returnedRows += Number(existing !== undefined)
      const title =
        event.type === 'tool.started' || event.type === 'tool.completed' ? event.title : 'Reasoning'
      const toolName =
        event.type === 'tool.started' || event.type === 'tool.completed'
          ? event.toolName
          : undefined
      const detail =
        event.type === 'reasoning.summary.delta'
          ? `${existing?.detail ?? ''}${event.text}`
          : event.type === 'reasoning.summary.completed'
            ? event.text
            : event.detail
      const status =
        event.type === 'reasoning.summary.completed'
          ? ('completed' as const)
          : event.type === 'tool.completed'
            ? event.outcome
            : ('running' as const)

      if (existing) {
        transaction
          .update(agentRunActivities)
          .set({
            toolName: toolName ?? null,
            title,
            detail: detail || null,
            detailRevision: existing.detailRevision + 1,
            status,
            updatedAt: now,
          })
          .where(eq(agentRunActivities.id, existing.id))
          .run()
        activityChange = {
          id: existing.id,
          mode: event.type === 'reasoning.summary.delta' ? 'append' : 'replace',
          ...(event.type === 'reasoning.summary.delta'
            ? { detail: event.text, previousRevision: existing.detailRevision }
            : { detail: detail ?? '' }),
        }
      } else {
        const sequence =
          (transaction
            .select({ value: max(agentRunActivities.sequence) })
            .from(agentRunActivities)
            .where(eq(agentRunActivities.sessionId, sessionId))
            .get()?.value ?? -1) + 1
        const activityId = randomUUID()
        transaction
          .insert(agentRunActivities)
          .values({
            id: activityId,
            sessionId,
            runId,
            agentId: event.agentId,
            nativeId,
            kind,
            toolName: toolName ?? null,
            title,
            detail: detail || null,
            status,
            sequence,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        activityChange = {
          id: activityId,
          mode: detail === undefined ? 'metadata' : 'replace',
          ...(detail === undefined ? {} : { detail }),
        }
      }
    } else if (event.type === 'text.delta' || event.type === 'text.completed') {
      const archivedRun = archive ? this.findRun(runId) : undefined
      const mayProjectBody =
        !archive ||
        (bodyState !== undefined &&
          archivedRun !== undefined &&
          this.mayProjectNativeBody(archivedRun))
      if (event.type === 'text.completed')
        transaction
          .update(agentRuns)
          .set({ nativeTurnId: event.turnId })
          .where(and(eq(agentRuns.id, runId), sql`${agentRuns.nativeTurnId} IS NULL`))
          .run()
      const previous = transaction
        .select({
          ...getTableColumns(conversationMessages),
          content: sealedBody ? sql<string>`''` : conversationMessages.content,
        })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        )
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()
      this.streamLookups.text.queries += 1
      this.streamLookups.text.returnedRows += Number(previous !== undefined)
      const nextContent = sealedBody
        ? sql<string>`(SELECT group_concat(text, '') FROM (SELECT text FROM conversation_body_parts WHERE input_id=${sealedBody.inputId} ORDER BY offset))`
        : event.type === 'text.delta'
          ? `${previous?.content ?? ''}${event.text}`
          : event.text
      const anchoredSource =
        archive &&
        previous &&
        !previous.isVisible &&
        previous.state === 'streaming' &&
        transaction
          .select({ id: anchoredComments.id })
          .from(anchoredComments)
          .where(
            and(
              eq(anchoredComments.sessionId, sessionId),
              sql`json_extract(${anchoredComments.anchorJson}, '$.type') = 'message'`,
              sql`json_extract(${anchoredComments.anchorJson}, '$.messageId') = ${previous.id}`,
            ),
          )
          .limit(1)
          .get()
      // Recovery can extend a body already referenced by a Comment; preserve its source row.
      const existing =
        previous &&
        !(
          (archive && (previous.isVisible || previous.state !== 'streaming' || anchoredSource)) ||
          (event.type === 'text.completed' &&
            bodyState !== undefined &&
            (previous.content !== event.text || (bodyState === 'complete' && !previous.isVisible)))
        )
          ? previous
          : undefined
      if (existing) {
        transaction
          .update(conversationMessages)
          .set({
            content: nextContent,
            contentRevision: existing.contentRevision + 1,
            state: bodyState ?? 'streaming',
            updatedAt: now,
          })
          .where(eq(conversationMessages.id, existing.id))
          .run()
        messageChange = {
          id: existing.id,
          mode: event.type === 'text.delta' ? 'append' : 'replace',
          ...(sealedBody ? {} : { text: event.text }),
          ...(event.type === 'text.delta' ? { previousRevision: existing.contentRevision } : {}),
        }
      } else {
        const run = this.findRun(runId)
        if (!run) throw new Error('Agent Run does not exist.')
        const visible = transaction
          .select({
            id: conversationMessages.id,
            runId: conversationMessages.runId,
            hasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.replyToMessageId, run.userMessageId),
              eq(conversationMessages.role, 'assistant'),
              eq(conversationMessages.agentId, run.agentId),
              eq(conversationMessages.isVisible, true),
            ),
          )
          .limit(1)
          .get()
        const replacesRecoveredSource =
          bodyState === 'complete' && visible?.runId === runId && this.ownsNativeControl(runId)
        if (visible && ((!visible.hasBody && !archive) || replacesRecoveredSource)) {
          transaction
            .update(conversationMessages)
            .set({ isVisible: false })
            .where(eq(conversationMessages.id, visible.id))
            .run()
          removedMessageIds.push(visible.id)
        }
        const messageSequence =
          (transaction
            .select({ value: max(conversationMessages.sequence) })
            .from(conversationMessages)
            .where(eq(conversationMessages.sessionId, sessionId))
            .get()?.value ?? -1) + 1
        const messageId = randomUUID()
        transaction
          .insert(conversationMessages)
          .values({
            id: messageId,
            sessionId,
            runId,
            role: 'assistant',
            replyToMessageId: run.userMessageId,
            isVisible: mayProjectBody && (replacesRecoveredSource || !visible?.hasBody),
            agentId: event.agentId,
            content: nextContent,
            state: bodyState ?? 'streaming',
            sequence: messageSequence,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        messageChange = {
          id: messageId,
          mode: 'replace',
          ...(sealedBody ? {} : { text: event.text }),
        }
      }
    } else if (event.type === 'turn.completed') {
      if (!archive) this.finishCollaboration(runId, event.outcome === 'completed')
      if (!archive)
        transaction
          .update(nativeAgentContexts)
          .set({
            state: event.outcome === 'completed' ? 'active' : 'interrupted',
            continuationState: 'ready',
            recoveryReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, sessionId),
              eq(nativeAgentContexts.agentId, event.agentId),
              eq(nativeAgentContexts.lastRunId, runId),
            ),
          )
          .run()
      const currentSessionStatus = transaction
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()?.status
      transaction
        .update(agentRuns)
        .set({
          status: event.outcome,
          nativeOutcome: event.outcome,
          dispatchPhase: 'ended',
          failureKind: null,
          failureMessage: null,
          updatedAt: now,
        })
        .where(eq(agentRuns.id, runId))
        .run()
      if (event.outcome !== 'completed' && !archive) {
        transaction
          .update(agentRuns)
          .set({ peerProposalState: 'superseded', updatedAt: now })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
          .run()
        const failedRun = transaction
          .select({ userMessageId: agentRuns.userMessageId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .get()
        if (failedRun)
          transaction
            .update(conversationMessages)
            .set({ routePendingAgentId: null, updatedAt: now })
            .where(eq(conversationMessages.id, failedRun.userMessageId))
            .run()
      }
      transaction
        .update(agentRunActivities)
        .set({
          status: event.outcome === 'completed' ? 'completed' : 'failed',
          updatedAt: now,
        })
        .where(and(eq(agentRunActivities.runId, runId), eq(agentRunActivities.status, 'running')))
        .run()
      const assistantMessage = transaction
        .select({
          id: conversationMessages.id,
          visible: conversationMessages.isVisible,
          replyTo: conversationMessages.replyToMessageId,
          hasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
        })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        )
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()
      if (
        assistantMessage &&
        (!archive || !assistantMessage.visible || this.ownsNativeControl(runId))
      ) {
        if (event.outcome === 'completed' && assistantMessage.replyTo && assistantMessage.hasBody) {
          const previous = transaction
            .select({
              id: conversationMessages.id,
              runId: conversationMessages.runId,
              state: conversationMessages.state,
            })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.replyToMessageId, assistantMessage.replyTo),
                eq(conversationMessages.role, 'assistant'),
                eq(conversationMessages.agentId, event.agentId),
                eq(conversationMessages.isVisible, true),
                ne(conversationMessages.id, assistantMessage.id),
              ),
            )
            .get()
          const replacesArchivedSource =
            archive &&
            previous?.runId === runId &&
            previous.state === 'incomplete' &&
            this.ownsNativeControl(runId)
          if (previous && (!archive || replacesArchivedSource)) {
            transaction
              .update(conversationMessages)
              .set({ isVisible: false })
              .where(eq(conversationMessages.id, previous.id))
              .run()
            removedMessageIds.push(previous.id)
          }
          if (!archive || replacesArchivedSource)
            transaction
              .update(conversationMessages)
              .set({ isVisible: true })
              .where(eq(conversationMessages.id, assistantMessage.id))
              .run()
        }
        transaction
          .update(conversationMessages)
          .set({ state: event.outcome === 'completed' ? 'complete' : 'incomplete', updatedAt: now })
          .where(eq(conversationMessages.id, assistantMessage.id))
          .run()
        messageChange = {
          id: assistantMessage.id,
          mode: assistantMessage.visible ? 'metadata' : 'replace',
        }
      }
      if (event.outcome === 'completed' && !assistantMessage?.hasBody)
        transaction
          .update(agentRuns)
          .set({ peerProposalState: 'superseded', updatedAt: now })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
          .run()
      activityStates.push({
        runId,
        status: event.outcome === 'completed' ? 'completed' : 'failed',
      })
      if (!archive)
        transaction
          .update(sessions)
          .set({
            status:
              event.outcome === 'completed'
                ? currentSessionStatus === 'waiting_for_user'
                  ? 'waiting_for_user'
                  : 'idle'
                : 'paused',
            updatedAt: now,
          })
          .where(and(eq(sessions.id, sessionId), isNull(sessions.archivedAt)))
          .run()
    }
    if (sealedBody && event.type === 'text.completed' && messageChange) {
      transaction
        .update(conversationBodyInputs)
        .set({ committedMessageId: messageChange.id })
        .where(eq(conversationBodyInputs.id, sealedBody.inputId))
        .run()

      const version = transaction
        .select({ revision: conversationMessages.contentRevision })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageChange.id))
        .get()!
      appendAgentEvent(transaction, {
        sessionId,
        runId,
        eventType: 'text.body.sealed',
        createdAt: now,
        payload: JSON.stringify({
          agentId: event.agentId,
          turnId: event.turnId,
          outputId: event.outputId,
          source: { ...sealedBody, messageId: messageChange.id, revision: version.revision },
        }),
      })
    }
    return { message: messageChange, activity: activityChange, activityStates, removedMessageIds }
  }

  failRun(
    runId: string,
    failureKind: RunFailureKind,
    failureMessage: string,
    interrupted = false,
  ): ConversationPatch {
    const run = this.findRun(runId)
    if (!run) throw new Error('Agent Run does not exist.')
    const latest = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, run.sessionId))
      .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    if (latest?.id !== runId || run.status === 'completed')
      throw new RunOperationConflictError('This Run no longer owns failure settlement.')
    const updatedAt = new Date().toISOString()
    this.nativeMetadataTransaction(run.sessionId, (transaction) => {
      const partialMessage = transaction
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        )
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()
      appendAgentEvent(transaction, {
        sessionId: run.sessionId,
        runId,
        eventType: interrupted ? 'run.interrupted' : 'run.failed',
        payload: JSON.stringify({
          failureKind,
          partialOutputPreserved: Boolean(partialMessage?.content),
          partialOutputLength: partialMessage?.content.length ?? 0,
        }),
        createdAt: updatedAt,
      })
      transaction
        .update(agentRuns)
        .set({
          status: interrupted ? 'interrupted' : 'failed',
          failureKind,
          failureMessage,
          updatedAt,
        })
        .where(eq(agentRuns.id, runId))
        .run()
      transaction
        .update(agentRuns)
        .set({ peerProposalState: 'superseded', updatedAt })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
        .run()
      transaction
        .update(conversationMessages)
        .set({ routePendingAgentId: null, updatedAt })
        .where(eq(conversationMessages.id, run.userMessageId))
        .run()
      transaction
        .update(conversationMessages)
        .set({ state: 'incomplete', updatedAt })
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        )
        .run()
      transaction
        .update(agentRunActivities)
        .set({ status: 'failed', updatedAt })
        .where(and(eq(agentRunActivities.runId, runId), eq(agentRunActivities.status, 'running')))
        .run()
      transaction
        .update(nativeAgentContexts)
        .set({ state: 'interrupted', updatedAt })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, run.sessionId),
            eq(nativeAgentContexts.agentId, run.agentId),
            eq(nativeAgentContexts.lastRunId, runId),
          ),
        )
        .run()
      transaction
        .update(sessions)
        .set({ status: 'paused', updatedAt })
        .where(and(eq(sessions.id, run.sessionId), isNull(sessions.archivedAt)))
        .run()
    })
    const updated = this.findRun(runId)
    if (!updated) throw new Error('Agent Run does not exist.')
    const assistantMessage = this.database
      .select({ id: conversationMessages.id, visible: conversationMessages.isVisible })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    const messages = [this.messageChange(run.userMessageId, 'metadata')]
    if (assistantMessage?.visible)
      messages.push(this.messageChange(assistantMessage.id, 'metadata'))
    return this.createPatch(run.sessionId, {
      runs: [updated],
      messages,
      activityStates: [{ runId, status: 'failed' }],
    })
  }

  recoverInterruptedRuns(): string[] {
    const recovered = new Set<string>()
    while (true) {
      const page = this.database.all<{ sessionId: string }>(sql`WITH pending(session_id) AS (
        SELECT session_id FROM agent_runs WHERE status IN ('starting', 'running', 'recovering') AND control_disposition <> 'abandoned' AND fork_source_run_id IS NULL
        UNION SELECT session_id FROM agent_runs WHERE native_effects_state IN ('pending', 'unknown') AND native_effects_state='pending' AND fork_source_run_id IS NULL
        UNION SELECT session_id FROM native_agent_contexts WHERE continuation_state IN ('responding','waiting_user','checking','rebuilding')
        UNION SELECT session_id FROM native_rebuild_operations WHERE native_work_state IN ('pending','unknown') AND native_work_state='pending'
        UNION SELECT session_id FROM native_rebuild_operations WHERE stage IN ('preparing','creating','seeding','unconfirmed') AND stage IN ('preparing','creating','seeding')
      ) SELECT session_id AS sessionId FROM pending ORDER BY session_id LIMIT 25`)
      if (!page.length) break
      const sessionIds = page.map((row) => row.sessionId)
      this.database.transaction(() => {
        this.database
          .update(nativeRebuildOperations)
          .set({ nativeWorkState: 'unknown' })
          .where(
            and(
              inArray(nativeRebuildOperations.sessionId, sessionIds),
              eq(nativeRebuildOperations.nativeWorkState, 'pending'),
            ),
          )
          .run()
        this.database
          .update(agentRuns)
          .set({ nativeEffectsState: 'unknown', nativeEffectsReason: 'pact_restarted' })
          .where(
            and(
              inArray(agentRuns.sessionId, sessionIds),
              eq(agentRuns.nativeEffectsState, 'pending'),
              isNull(agentRuns.forkSourceRunId),
            ),
          )
          .run()
        this.database
          .update(nativeRebuildOperations)
          .set({
            stage: 'unconfirmed',
            failureReason: 'Pact restarted before the Native rebuild was confirmed.',
          })
          .where(
            and(
              inArray(nativeRebuildOperations.sessionId, sessionIds),
              inArray(nativeRebuildOperations.stage, ['creating', 'seeding']),
            ),
          )
          .run()
        this.database
          .update(nativeRebuildOperations)
          .set({
            stage: 'failed',
            failureReason: 'Pact restarted before Native creation was dispatched.',
          })
          .where(
            and(
              inArray(nativeRebuildOperations.sessionId, sessionIds),
              eq(nativeRebuildOperations.stage, 'preparing'),
            ),
          )
          .run()
        this.database
          .update(nativeAgentContexts)
          .set({
            continuationState: 'recovery_required',
            recoveryReason: 'Pact restarted before the native state was confirmed.',
          })
          .where(
            and(
              inArray(nativeAgentContexts.sessionId, sessionIds),
              inArray(nativeAgentContexts.continuationState, [
                'responding',
                'waiting_user',
                'checking',
                'rebuilding',
              ]),
            ),
          )
          .run()
        const active = this.database
          .select({
            id: agentRuns.id,
            nativeOutcome: agentRuns.nativeOutcome,
            dispatchPhase: agentRuns.dispatchPhase,
            sessionId: agentRuns.sessionId,
          })
          .from(agentRuns)
          .where(
            and(
              inArray(agentRuns.sessionId, sessionIds),
              inArray(agentRuns.status, [...activeRunStatuses]),
              ne(agentRuns.controlDisposition, 'abandoned'),
              isNull(agentRuns.forkSourceRunId),
            ),
          )
          .limit(25)
          .all()
        for (const run of active) {
          recovered.add(run.sessionId)
          if (run.nativeOutcome || run.dispatchPhase === 'ended') {
            this.database
              .update(agentRuns)
              .set({ dispatchPhase: 'ended' })
              .where(eq(agentRuns.id, run.id))
              .run()
            this.settleKnownNativeEnding(run.id)
          } else
            this.observationUnavailable(
              run.id,
              'Pact lost observation before the native Turn was confirmed.',
            )
        }
        for (const sessionId of sessionIds) refreshNativeSessionMetadata(this.database, sessionId)
      })
    }
    this.database
      .update(conversationMessages)
      .set({ routePendingAgentId: null })
      .where(
        and(
          isNotNull(conversationMessages.routePendingAgentId),
          or(
            sql`NOT EXISTS (SELECT 1 FROM agent_runs AS first WHERE first.id=${conversationMessages.runId} AND first.status='completed' AND first.control_disposition<>'abandoned')`,
            sql`EXISTS (SELECT 1 FROM agent_runs AS second WHERE second.user_message_id=${conversationMessages.id} AND second.agent_id=${conversationMessages.routePendingAgentId})`,
          ),
        ),
      )
      .run()
    return [...recovered]
  }

  interruptRun(runId: string, deliveryPossible?: boolean): void {
    const run = this.findRun(runId)
    if (!run || !activeRunStatuses.some((status) => status === run.status)) return
    const reconcilingDelivery =
      run.failureKind === 'unknown_delivery' || (deliveryPossible ?? Boolean(run.nativeSessionId))
    this.failRun(
      run.id,
      reconcilingDelivery ? 'unknown_delivery' : 'agent_process_crash',
      reconcilingDelivery
        ? 'Pact stopped while reconciling Agent delivery. Recovery can continue safely.'
        : 'Pact stopped before this Run completed.',
      true,
    )
    this.database
      .update(nativeAgentContexts)
      .set({ state: 'interrupted', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, run.sessionId),
          eq(nativeAgentContexts.agentId, run.agentId),
        ),
      )
      .run()
  }

  nativeContexts(sessionId: string): NativeAgentContext[] {
    return this.database
      .select()
      .from(nativeAgentContexts)
      .where(eq(nativeAgentContexts.sessionId, sessionId))
      .orderBy(asc(nativeAgentContexts.agentId))
      .all()
      .map((context) => this.projectNativeContext(context))
  }

  nativeRecoveryBlocksInput(sessionId: string): boolean {
    if (forkFacts.forkBlocksInput(this.database, sessionId)) return true
    const blockedContext =
      this.database
        .select({ agentId: nativeAgentContexts.agentId })
        .from(nativeAgentContexts)
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            inArray(nativeAgentContexts.continuationState, [
              'recovery_required',
              'checking',
              'rebuilding',
            ]),
          ),
        )
        .limit(1)
        .get() !== undefined
    if (blockedContext) return true
    return this.unacknowledgedNativeRun(sessionId) !== undefined
  }

  /** Same durable blocker used by the send gate and recovery card, including older attempts. */
  unacknowledgedNativeRun(sessionId: string, agentId?: RuntimeAgentId): AgentRun | undefined {
    const row = this.database
      .select(publicRunColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          ...(agentId ? [eq(agentRuns.agentId, agentId)] : []),
          ne(agentRuns.controlDisposition, 'abandoned'),
          isNull(agentRuns.forkSourceRunId),
          inArray(agentRuns.dispatchPhase, ['possibly_sent', 'accepted']),
          inArray(agentRuns.status, ['failed', 'interrupted', 'recovering']),
          sql`${agentRuns.nativeOutcome} IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts c
              WHERE c.session_id = ${agentRuns.sessionId} AND c.agent_id = ${agentRuns.agentId})`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
      .limit(1)
      .get()
    return row ? ConversationRepository.toRun(row) : undefined
  }

  markNativeContextsMissing(
    sessionId: string,
    agentIds: RuntimeAgentId[],
    message = 'The saved Native Session is unavailable.',
  ): ConversationPatch {
    const now = new Date().toISOString()
    let retired: string | undefined
    this.nativeMetadataTransaction(sessionId, (transaction) => {
      retired = this.retirePendingRoute(sessionId, 'native_session_missing')
      for (const agentId of agentIds) {
        transaction
          .update(nativeAgentContexts)
          .set({
            state: 'missing',
            continuationState: 'recovery_required',
            recoveryAction: 'rebuild',
            recoveryReason: message.slice(0, 240),
            recoveryFailureKind: 'context_resume_failed',
            recoveryFailureMessage: message,
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeAgentContexts.sessionId, sessionId),
              eq(nativeAgentContexts.agentId, agentId),
            ),
          )
          .run()
      }
      transaction.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
    })
    return this.createPatch(sessionId, {
      messages: retired ? [this.messageChange(retired, 'metadata')] : [],
    })
  }

  async *nativeContextRebuildSource(
    sessionId: string,
    signal: AbortSignal,
    operationId?: string,
  ): AsyncIterable<NativeContextRebuildChunk> {
    const operation = operationId
      ? this.database
          .select()
          .from(nativeRebuildOperations)
          .where(
            and(
              eq(nativeRebuildOperations.id, operationId),
              eq(nativeRebuildOperations.sessionId, sessionId),
            ),
          )
          .get()
      : this.database
          .select()
          .from(nativeRebuildOperations)
          .where(
            and(
              eq(nativeRebuildOperations.sessionId, sessionId),
              inArray(nativeRebuildOperations.stage, ['preparing', 'creating', 'seeding']),
            ),
          )
          .limit(1)
          .get()
    const returned = this.parseReturnedInput(operation?.returnedInputJson ?? null)
    const activeInput = this.rebuildInputRecovery(sessionId)
    const exclude = [
      ...(returned?.state === 'prepared' ? [returned.messageId] : []),
      ...(activeInput ? [activeInput.messageId] : []),
    ]
    // Recovery may already have retired the pending route. Use the frozen route
    // and dispatch facts, never that transient flag, to bound an unsent secondary.
    const routedThroughSequence = operation
      ? this.undispatchedRoutedHistoryBoundary(sessionId, operation.agentId)
      : undefined
    const throughSequence =
      this.database
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, sessionId),
            eq(conversationMessages.isVisible, true),
            ...(routedThroughSequence === undefined
              ? []
              : [lte(conversationMessages.sequence, routedThroughSequence)]),
            ...(exclude.length ? [notInArray(conversationMessages.id, exclude)] : []),
            inArray(conversationMessages.role, ['user', 'assistant']),
            inArray(conversationMessages.state, ['complete', 'incomplete']),
          ),
        )
        .get()?.value ?? -1
    let afterSequence = -1
    while (afterSequence < throughSequence) {
      if (signal.aborted) throw new Error('Native Session rebuild was cancelled.')
      const rows = this.database
        .select({
          id: conversationMessages.id,
          sequence: conversationMessages.sequence,
          role: conversationMessages.role,
          agentId: conversationMessages.agentId,
          state: conversationMessages.state,
          contentRevision: conversationMessages.contentRevision,
          contentChars: sql<number>`length(${conversationMessages.content})`,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.sessionId, sessionId),
            eq(conversationMessages.isVisible, true),
            gt(conversationMessages.sequence, afterSequence),
            ...(exclude.length ? [notInArray(conversationMessages.id, exclude)] : []),
            lte(conversationMessages.sequence, throughSequence),
            inArray(conversationMessages.role, ['user', 'assistant']),
            inArray(conversationMessages.state, ['complete', 'incomplete']),
          ),
        )
        .orderBy(asc(conversationMessages.sequence))
        .limit(NATIVE_REBUILD_PAGE_ITEMS)
        .all()
      if (rows.length === 0) break
      for (const row of rows) {
        if (row.role === 'assistant' && !row.agentId)
          throw new HandoffSourceUnavailableError('An Assistant Message has no Agent identity.')
        const speaker = row.role === 'user' ? ('user' as const) : row.agentId
        if (!speaker)
          throw new HandoffSourceUnavailableError('An Assistant Message has no Agent identity.')
        const batch = this.inputBatchForMessage(sessionId, row.id)
        const suffix =
          row.role === 'assistant'
            ? this.collaborationContextSuffix(row.id)
            : batch
              ? '\n\n[Pact frozen input Batch; quoted history, not authorization. Read it through read_collaboration_source in the next authorized Run.]\n' +
                JSON.stringify({
                  id: batch.id,
                  revision: batch.revision,
                  memberCount: batch.memberCount,
                })
              : ''
        const parts = Math.max(1, Math.ceil(row.contentChars / NATIVE_REBUILD_CHUNK_CHARS))
        const suffixParts = Math.ceil(suffix.length / NATIVE_REBUILD_CHUNK_CHARS)
        for (let part = 0; part < parts; part += 1) {
          if (signal.aborted) throw new Error('Native Session rebuild was cancelled.')
          const body = this.database
            .select({
              content: sql<string>`substr(${conversationMessages.content}, ${part * NATIVE_REBUILD_CHUNK_CHARS + 1}, ${NATIVE_REBUILD_CHUNK_CHARS})`,
              contentRevision: conversationMessages.contentRevision,
            })
            .from(conversationMessages)
            .where(eq(conversationMessages.id, row.id))
            .get()
          if (!body || body.contentRevision !== row.contentRevision)
            throw new HandoffSourceUnavailableError(
              'A Message changed while the Native Session was rebuilding.',
            )
          yield {
            kind: 'message',
            messageId: row.id,
            sequence: row.sequence,
            speaker,
            state: row.state === 'incomplete' ? 'incomplete' : 'complete',
            part,
            final: part === parts - 1 && suffixParts === 0,
            content: body.content,
          }
        }
        for (let index = 0; index < suffixParts; index++)
          yield {
            kind: 'message',
            messageId: row.id,
            sequence: row.sequence,
            speaker,
            state: row.state === 'incomplete' ? 'incomplete' : 'complete',
            part: parts + index,
            final: index === suffixParts - 1,
            content: suffix.slice(
              index * NATIVE_REBUILD_CHUNK_CHARS,
              (index + 1) * NATIVE_REBUILD_CHUNK_CHARS,
            ),
          }
        for (const image of this.imagesForMessage(row.id, sessionId)) {
          yield { kind: 'image', messageId: row.id, sequence: row.sequence, image }
        }
        afterSequence = row.sequence
      }
      // oxlint-disable-next-line no-await-in-loop -- Rebuild reads yield between bounded pages.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  private undispatchedRoutedHistoryBoundary(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): number | undefined {
    const message = this.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        routeKind: conversationMessages.routeKind,
        routeAgentsJson: conversationMessages.routeAgentsJson,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.isVisible, true),
          eq(conversationMessages.role, 'user'),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    const route = message && ConversationRepository.toMessageRoute(message)?.route
    if (!message || route?.type !== 'all' || route.secondAgentId !== agentId) return undefined
    const dispatched = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userMessageId, message.id),
          eq(agentRuns.agentId, agentId),
          or(
            sql`${agentRuns.dispatchPhase} NOT IN ('not_sent', 'rejected')`,
            isNotNull(agentRuns.nativeTurnId),
            isNotNull(agentRuns.nativeOutcome),
            eq(agentRuns.failureKind, 'unknown_delivery'),
          ),
        ),
      )
      .limit(1)
      .get()
    return dispatched ? undefined : message.sequence - 1
  }

  nativeContext(sessionId: string, agentId: RuntimeAgentId): NativeAgentContext | undefined {
    const context = this.database
      .select()
      .from(nativeAgentContexts)
      .where(
        and(eq(nativeAgentContexts.sessionId, sessionId), eq(nativeAgentContexts.agentId, agentId)),
      )
      .get()
    return context ? this.projectNativeContext(context) : undefined
  }

  recordSystemMessage(sessionId: string, runId: string, content: string): ConversationPatch {
    const now = new Date().toISOString()
    const messageId = randomUUID()
    this.database.transaction((transaction) => {
      const messageSequence =
        (transaction
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.sessionId, sessionId))
          .get()?.value ?? -1) + 1

      transaction
        .insert(conversationMessages)
        .values({
          id: messageId,
          sessionId,
          runId,
          role: 'system',
          content,
          state: 'complete',
          sequence: messageSequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      appendAgentEvent(transaction, {
        sessionId,
        runId,
        eventType: 'context_rebuilt',
        payload: JSON.stringify({ content }),
        createdAt: now,
      })
      transaction.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
    })
    return this.createPatch(sessionId, {
      messages: [this.messageChange(messageId, 'replace', content)],
    })
  }

  private toMessage(
    row: Omit<typeof conversationMessages.$inferSelect, 'isVisible' | 'skillInvocationJson'> & {
      skillInvocationJson?: string | null
      skillsJson?: string | null
    },
  ): ConversationMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      ...this.messageImageMetadata(row.id),
      contentRevision: row.contentRevision,
      state: row.state,
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.runId ? { runId: row.runId } : {}),
      ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
      ...(row.routePendingAgentId ? { pendingAgentId: row.routePendingAgentId } : {}),
      ...ConversationRepository.toMessageRoute(row),
      ...ConversationRepository.toMessageSkills(row),
    }
  }

  private static toMessageSkills(row: {
    skillsJson?: string | null
    skillInvocationJson?: string | null
  }): Pick<ConversationMessage, 'skills'> {
    if (row.skillsJson !== null && row.skillsJson !== undefined)
      return { skills: skillSelectionsSchema.parse(JSON.parse(row.skillsJson)) }
    return row.skillInvocationJson
      ? {
          skills: frozenSkillInvocationSchema.parse(JSON.parse(row.skillInvocationJson)).selections,
        }
      : {}
  }

  private static toComment(row: typeof anchoredComments.$inferSelect): AnchoredComment {
    const parsed = commentAnchorSchema.safeParse(JSON.parse(row.anchorJson))
    if (!parsed.success) throw new Error(`Comment ${row.id} has an invalid persisted anchor.`)
    return {
      id: row.id,
      sessionId: row.sessionId,
      body: row.body,
      anchor: parsed.data,
      status: row.sentWithMessageId ? 'sent' : 'draft',
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.sentWithMessageId ? { sentWithMessageId: row.sentWithMessageId } : {}),
    }
  }

  private static toActivity(row: typeof agentRunActivities.$inferSelect): AgentActivity {
    return {
      id: row.id,
      sessionId: row.sessionId,
      runId: row.runId,
      agentId: row.agentId,
      nativeId: row.nativeId,
      kind: row.kind,
      title: row.title,
      detailRevision: row.detailRevision,
      status: row.status,
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.toolName ? { toolName: row.toolName } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
    }
  }

  private static toRun(
    row: Omit<typeof agentRuns.$inferSelect, 'handoffSourceIds'> & {
      responseMessageId?: string | null
    },
  ): AgentRun {
    return {
      ...(row.answerFormat ? { answerFormat: row.answerFormat } : {}),
      ...(row.collaborationTaskId && row.collaborationKind && row.collaborationStage
        ? {
            collaboration: {
              taskId: row.collaborationTaskId,
              kind: row.collaborationKind,
              stage: row.collaborationStage,
            },
          }
        : {}),
      ...(row.forkSourceRunId ? { forkSourceRunId: row.forkSourceRunId } : {}),
      id: row.id,
      sessionId: row.sessionId,
      userMessageId: row.userMessageId,
      agentId: row.agentId,
      status: row.status,
      attemptCount: row.attemptCount,
      bindingGeneration: row.bindingGeneration,
      controlDisposition: row.controlDisposition,
      dispatchPhase: row.dispatchPhase,
      ...(row.nativeOutcome ? { nativeOutcome: row.nativeOutcome } : {}),
      ...(row.executorId ? { executorId: row.executorId } : {}),
      ...(row.responseMessageId ? { responseMessageId: row.responseMessageId } : {}),
      nativeEffectsState: row.nativeEffectsState,
      ...(row.nativeEffectsReason ? { nativeEffectsReason: row.nativeEffectsReason } : {}),
      ...(row.workspaceRecordingUnavailableReason
        ? { workspaceRecordingUnavailableReason: row.workspaceRecordingUnavailableReason }
        : {}),
      ...(row.reexecutedFromRunId ? { reexecutedFromRunId: row.reexecutedFromRunId } : {}),
      settingsRevision: row.settingsRevision,
      permissionMode: row.permissionMode,
      model: row.model,
      effort: row.effort,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.nativeSessionId ? { nativeSessionId: row.nativeSessionId } : {}),
      ...(row.nativeTurnId ? { nativeTurnId: row.nativeTurnId } : {}),
      ...(row.failureKind ? { failureKind: row.failureKind } : {}),
      ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
      ...(row.handoffMessageCount > 0 ? { handoffMessageCount: row.handoffMessageCount } : {}),
      ...(row.workspaceChangesJson
        ? { workspaceChanges: workspaceChangeSetSchema.parse(JSON.parse(row.workspaceChangesJson)) }
        : {}),
      ...(row.peerProposalId &&
      row.peerProposalTargetAgentId &&
      row.peerProposalKind &&
      row.peerProposalState
        ? {
            peerProposal: {
              id: row.peerProposalId,
              targetAgentId: row.peerProposalTargetAgentId,
              kind: row.peerProposalKind,
              state: row.peerProposalState,
              ...(row.peerProposalReason ? { reason: row.peerProposalReason } : {}),
              ...(row.peerProposalAcceptedMessageId
                ? { acceptedMessageId: row.peerProposalAcceptedMessageId }
                : {}),
            },
          }
        : {}),
    }
  }

  private static toMessageRoute(
    row: Pick<typeof conversationMessages.$inferSelect, 'routeKind' | 'routeAgentsJson'>,
  ): Pick<ConversationMessage, 'route'> | undefined {
    if (!row.routeKind || !row.routeAgentsJson) return undefined
    const agents: unknown = JSON.parse(row.routeAgentsJson)
    if (!Array.isArray(agents) || agents.some((agent) => agent !== 'claude' && agent !== 'codex'))
      throw new Error('Conversation Message has an invalid persisted route.')
    if (row.routeKind === 'all') {
      const [firstAgentId, secondAgentId] = agents
      if (!firstAgentId || !secondAgentId || firstAgentId === secondAgentId)
        throw new Error('Conversation Message has an invalid all-Agent route.')
      return { route: { type: 'all', firstAgentId, secondAgentId } }
    }
    const [agentId] = agents
    if (!agentId) throw new Error('Conversation Message has no routed Agent.')
    return { route: { type: row.routeKind, agentId } }
  }

  rebuildOperations(sessionId: string) {
    return (['codex', 'claude'] as const).flatMap((agentId) => {
      const operation = this.lastNativeRebuild(sessionId, agentId)
      return operation &&
        ['preparing', 'creating', 'seeding', 'unconfirmed', 'failed'].includes(operation.stage)
        ? [{ agentId, operation }]
        : []
    })
  }

  confirmedNativeInitialization(sessionId: string, agentId: RuntimeAgentId) {
    const context = this.nativeContext(sessionId, agentId)
    const operation = this.lastNativeRebuild(sessionId, agentId)
    if (
      !context ||
      !operation ||
      operation.stage !== 'completed' ||
      !operation.sourceHash ||
      operation.provisionalNativeSessionId !== context.nativeSessionId ||
      operation.oldGeneration + 1 !== context.bindingGeneration ||
      this.pendingNativeRebuild(sessionId, agentId)
    )
      return undefined
    const laterRun = this.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.bindingGeneration, context.bindingGeneration ?? 1),
        ),
      )
      .limit(1)
      .get()
    const witnessRow = this.database
      .select({ value: nativeRebuildOperations.initializationWitnessJson })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, operation.id))
      .get()
    const witness = witnessRow?.value
      ? nativeInitializationWitnessSchema.parse(JSON.parse(witnessRow.value))
      : undefined
    if (agentId === 'codex' && !witness) return undefined
    return laterRun
      ? undefined
      : {
          rebuildId: operation.id,
          sourceHash: operation.sourceHash,
          nativeSessionId: context.nativeSessionId,
          bindingGeneration: context.bindingGeneration ?? 1,
          ...(witness ? { witness } : {}),
        }
  }

  private projectNativeContext(row: typeof nativeAgentContexts.$inferSelect): NativeAgentContext {
    const operation = this.lastNativeRebuild(row.sessionId, row.agentId)
    return {
      ...ConversationRepository.toNativeContext(row),
      ...(operation ? { rebuildOperation: operation } : {}),
    }
  }

  private static toNativeContext(row: typeof nativeAgentContexts.$inferSelect): NativeAgentContext {
    return {
      ...(row.permissionRequestsJson
        ? {
            permissionRequests: nativePermissionRequestSchema
              .array()
              .max(NATIVE_PERMISSION_REQUESTS)
              .parse(JSON.parse(row.permissionRequestsJson)),
          }
        : {}),
      sessionId: row.sessionId,
      agentId: row.agentId,
      nativeSessionId: row.nativeSessionId,
      bindingGeneration: row.bindingGeneration,
      continuationState: row.continuationState,
      ...(row.executorId ? { executorId: row.executorId } : {}),
      ...(row.recoveryReason ? { recoveryReason: row.recoveryReason.slice(0, 240) } : {}),
      ...(row.recoveryAction ? { recoveryAction: row.recoveryAction } : {}),
      state: row.state,
      updatedAt: row.updatedAt,
      ...(row.lastRunId ? { lastRunId: row.lastRunId } : {}),
      ...(row.recoveryFailureKind ? { recoveryFailureKind: row.recoveryFailureKind } : {}),
      ...(row.recoveryFailureMessage ? { recoveryFailureMessage: row.recoveryFailureMessage } : {}),
      ...(row.rebuildMessageCount !== null ? { rebuildMessageCount: row.rebuildMessageCount } : {}),
      ...(row.rebuiltThroughSequence !== null
        ? { rebuiltThroughSequence: row.rebuiltThroughSequence }
        : {}),
    }
  }
}
