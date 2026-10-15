import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'

import type {
  AnchoredComment,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  CommentAnchor,
  CommentSourceResolution,
  AgentRun,
  ConversationGetInput,
  ConversationInputWrite,
  ConversationInputState,
  ConversationMessageRoute,
  ConversationPage,
  ConversationPatch,
  ConversationRetryInput,
  ConversationSendInput,
  ConversationStopInput,
  ConversationSnapshot,
  DefaultSessionSettings,
  NativeContextRebuildInput,
  PeerProposalAcceptInput,
  PeerProposalDismissInput,
  PeerRequestKind,
  RpcResult,
  RuntimeAgentId,
  WorkspaceChangesReadInput,
  WorkspaceChangesPage,
  WorkspaceChangeFileReadInput,
  WorkspaceChangeFilePreview,
  WorkspaceChangesUndoInput,
  NativePermissionRequest,
  NativePermissionDecision,
  NativePermissionRespondInput,
  NativeInteractionDetails,
  NativeInputRead,
  NativeInputRespond,
  NativeUserInputRequest,
  NativeUserInputResult,
  PendingNativeInteraction,
  SessionIssues,
  SessionForkInput,
  SessionForkResult,
  AgentNativeForkBoundary,
  WorkspaceArchivePrepareInput,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
  WorkspaceArchiveTask,
  NativePresenceVersion,
  NativePresenceSnapshot,
  NativeAttentionPage,
  NativeAttentionReadInput,
  NativeSessionRow,
  NativeQuitOperationInput,
  NativeQuitPreparation,
} from '@pact/contracts'
import type {
  ConversationImage,
  ImageWriteInput,
  ImageWriteState,
  ImageReadInput,
  ImageReadPart,
} from '@pact/contracts/images'
import type { HandoffBundle } from '@pact/persistence'

import {
  serializeAgentPromptEnvelope,
  type AgentAdapter,
  type AgentPromptEnvelope,
  type AgentNativeForkInput,
} from '@pact/agent-runtime'
import {
  prepareCollaborationSupplement,
  collaborationSubmission,
  collaborationTaskSchema,
  collaborationReportMarkdown,
  collaborationRequiresPlan,
  advanceCollaboration,
  otherAgent,
  collaborationResultSchema,
  collaborationSourceReadSchema,
  collaborationMarkdownPageSchema,
  type CollaborationTask,
  type CollaborationActionInput,
} from '@pact/contracts'
import {
  frozenSkillInvocationSchema,
  skillDocumentSchema,
  type SkillDocument,
  type SkillDocumentRead,
  parseComposerCommandPrefix,
  skillArguments,
  skillCatalogPageSchema,
  SKILL_PAGE_BYTES,
  SKILL_PAGE_ITEMS,
  type SkillBinding,
  type SkillCatalogRead,
  type SkillCatalogPage,
  type FrozenSkillInvocation,
} from '@pact/contracts'
import {
  conversationInterestsSchema,
  WORKSPACE_ARCHIVE_PREVIEW_MS,
  WORKSPACE_ARCHIVE_STOP_MS,
  WORKSPACE_ARCHIVE_TASK_LIMIT,
  NATIVE_QUIT_PREPARATION_MS,
  conversationPatchSchema,
  CONVERSATION_PATCH_BYTES,
  CONVERSATION_MARKDOWN_BYTES,
  MESSAGE_ANCHOR_TEXT_BASIS,
  normalizedAgentEventSchema,
  nativePermissionRequestSchema,
  NATIVE_PERMISSION_REQUESTS,
  NATIVE_PERMISSION_TIMEOUT_MS,
  nativeInputDetailsSchema,
  nativeApprovalDetailsSchema,
  nativeInputValuesSchema,
  nativePermissionDecisionSchema,
  compileNativeFormValidator,
  validateNativeInputValues,
} from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'
import {
  ConversationRepository,
  CommentLimitError,
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
  HANDOFF_SAFETY_BYTES,
  HANDOFF_READ_DEADLINE_MS,
  RunOperationConflictError,
  OversizedConversationEntityError,
  ProjectCatalogRepository,
  SessionRepository,
  StaleConversationCursorError,
  WorkspaceArchiveConflictError,
} from '@pact/persistence'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { ProjectFileReader } from '../project-file/project-file-reader'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import { WorkspaceChanges, WorkspaceChangeError } from '../workspace-changes/workspace-changes'
import {
  AgentExecutionError,
  PermissionModeRejectedError,
  NativeThreadOccupiedError,
  NativeThreadArchivedError,
  NativeCapacityError,
  classifyAgentError,
} from './agent-execution-error'
import { AgentStreamBuffer } from './agent-stream-buffer'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { CodexAgentAdapter } from './codex-agent-adapter'
import { ConversationImages } from './conversation-images'
import { safeNativePermissionText } from './native-permission-wait'
import { NativeWorkingMemory } from './native-working-memory'
import { presentSessionIssues } from './session-issues'

const DELIVERY_RECONCILIATION_TIMEOUT_MS = 10_000
const MAX_AGENT_OPERATIONS = 5
const MAX_ADAPTER_SLOTS = 5
const PREPARATION_TIMEOUT_MS = 10_000
const CAPACITY_NOTICE = 'At most 5 Sessions can run Agents at once. Try again when one finishes.'

interface ActiveExecution {
  adapter?: AgentAdapter | undefined
  run: AgentRun
  protectedAgentId?: RuntimeAgentId | undefined
  deliveryPossible: boolean
  cancelledByUser?: boolean | undefined
  abortController: AbortController
  streamBuffer?: AgentStreamBuffer | undefined
  completion?: Promise<void> | undefined
}

interface PreparedSession {
  session: NonNullable<ReturnType<SessionRepository['find']>>
  projectDirectory: string
  executablePaths: Record<RuntimeAgentId, string>
}

interface ActiveTitleEnrichment {
  runId: string
  agentId: RuntimeAgentId
  abortController: AbortController
  promise: Promise<void>
}

interface ActiveNativeRebuild {
  adapter?: AgentAdapter | undefined
  agentId: RuntimeAgentId
  rebuildId: string
  abortController: AbortController
  completion?: Promise<void> | undefined
  executorId?: string | undefined
}

interface CachedAdapter {
  sessionId: string
  agentId: RuntimeAgentId
  executablePath: string
  cwd: string
  adapter: AgentAdapter
  nativeTitleObserved?: {
    nativeSessionId: string
    bindingGeneration: number
    executorId: string | undefined
  }
}

interface ActiveNativeTitleSync {
  adapter: AgentAdapter
  executorId: string | undefined
  abortController: AbortController
  desiredKey: string
  dirty: boolean
  cancelled: boolean
  promise: Promise<void>
}

interface PreparingSend {
  input: ConversationSendInput
  options: SendOptions
  protectedAgentId?: RuntimeAgentId | undefined
  controller: AbortController
  task: Promise<RpcResult<ConversationPatch>>
}

interface SendOptions {
  imageOwnerKey?: string

  preserveDraftComments?: boolean
  sourceProposalId?: string
  sourceMessageId?: string
  collaboration?: CollaborationTask | undefined
  receivedInputId?: string | undefined
  receivedComments?: AnchoredComment[] | undefined
}

interface PreparingContinuation {
  sessionId: string
  userMessageId: string
  protectedAgentId: RuntimeAgentId
  controller: AbortController
  completion?: Promise<void> | undefined
}

interface NativeObservation {
  generation: string
  adapter: AgentAdapter
  archiveBuffer?: AgentStreamBuffer
  archiveTail?: Promise<void> | undefined
  archivePending: number
  archiveController: AbortController
  archiveMemory: NativeWorkingMemory
}

interface NativeInteractionOwner {
  id: string
  sessionId: string
  agentId: RuntimeAgentId
  bindingGeneration?: number
  executorId?: string | undefined
  valid: () => boolean
}

export class Conversation {
  private readonly nativeIncarnation = randomUUID()
  private nativeRevision = 0
  private nativeInitialization: Promise<void> | undefined
  private readonly nativeListeners = new Set<(version: NativePresenceVersion) => void>()
  private nativeQuitPreparation:
    | {
        operationId: string
        result: RpcResult<NativeQuitPreparation>
        sealed: boolean
        expired: boolean
        timer?: ReturnType<typeof setTimeout> | undefined
      }
    | undefined
  private readonly archiveOwnerId = randomUUID()
  private readonly archiveOperations = new Set<string>()
  // Single flight for duplicate document/StrictMode preparation, under the same five operation slots.
  private readonly forkPreparations = new Map<
    string,
    { messageId: string; task: Promise<RpcResult<SessionForkResult>> }
  >()
  private readonly nativeForks = new Map<
    string,
    {
      sourceSessionId: string
      sessionId?: string
      operationId?: string
      controller: AbortController
      completion?: Promise<void>
      activeAdapters?: Set<AgentAdapter>
    }
  >()
  private readonly listeners = new Set<(patch: ConversationPatch, progress: boolean) => void>()
  private interestedSessionIds = new Set<string>()
  private suppressedProgress = 0
  private publishedProgress = 0
  private readonly activeExecutions = new Map<string, ActiveExecution>()
  private readonly nativeRebuilds = new Map<string, ActiveNativeRebuild>()
  private readonly preparingSends = new Map<string, PreparingSend>()
  private readonly preparingContinuations = new Map<string, PreparingContinuation>()
  private readonly titleEnrichments = new Map<string, ActiveTitleEnrichment>()
  private readonly nativeTitleSyncs = new Map<string, ActiveNativeTitleSync>()
  private readonly skillCatalogs = new Map<
    string,
    {
      generation: string
      expiresAt: number
      key: string
      checkedAt: string
      entries: SkillBinding[]
      failure?: boolean
    }
  >()
  private readonly skillDiscoveries = new Map<
    string,
    {
      sessionId: string
      agentId: RuntimeAgentId
      controller: AbortController
      readers: Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>
      invalidated?: boolean
      refresh: boolean
      usedCache?: boolean
      task: Promise<SkillBinding[]>
    }
  >()

  private readonly adapters = new Map<string, CachedAdapter>()
  private skillDocumentOwner:
    | {
        requestId: string
        controller: AbortController
        task: Promise<RpcResult<SkillDocument>>
      }
    | undefined
  // Five Adapters × eight owned native contexts. Run generations fence late callbacks.
  private readonly nativeObservations = new Map<string, NativeObservation>()
  private readonly nativeChecks = new Map<
    string,
    {
      controller: AbortController
      task: Promise<RpcResult<ConversationPatch>>
      adapter?: AgentAdapter | undefined
    }
  >()
  private adapterSlotTail: Promise<void> = Promise.resolve()
  private pendingContinuationScheduled = false
  private pendingContinuationWakeAgain = false
  private receivedDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly markdownPreparations = new Map<string, Promise<void>>()
  private markdownTail: Promise<void> = Promise.resolve()
  private markdownWorker: Worker | undefined
  private disposed = false
  private readonly permissions = new Map<
    string,
    {
      operationId: string
      sessionId: string
      agentId: RuntimeAgentId
      bindingGeneration: number
      executorId?: string
      visible: boolean
      valid: () => boolean
      request: NativePermissionRequest
      details?: NativeInteractionDetails
      settle: (reply: NativePermissionDecision | NativeUserInputResult) => ConversationPatch
      withdraw: (source: 'expired' | 'aborted') => void
    }
  >()
  private disposal: Promise<void> | undefined

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectCatalogRepository,
    private readonly runtimePreparation: RuntimePreparation,
    private readonly projectFiles: ProjectFileReader,
    private readonly workspaceChanges?: WorkspaceChanges,
    private readonly images?: ConversationImages,
  ) {
    this.conversations.archives.recover(this.archiveOwnerId)
    this.conversations.expireNativePermissions()
    this.conversations.recoverInterruptedRuns()
    this.conversations.recoverCollaborationTasks()
    this.conversations.recoverForkIntents()
    this.schedulePendingRoutedContinuations()
  }

  sessionTitleChanged(sessionId: string): void {
    this.scheduleNativeTitleSync(sessionId)
  }

  subscribeNativePresence(listener: (version: NativePresenceVersion) => void): () => void {
    if (this.nativeListeners.size >= 1)
      throw new Error('Native metadata already has its Utility subscriber.')
    this.nativeListeners.add(listener)
    return () => {
      this.nativeListeners.delete(listener)
    }
  }

  nativeMetadataChanged(): void {
    if (this.disposed) return
    this.nativeRevision += 1
    const version = this.nativePresenceVersion()
    for (const listener of this.nativeListeners) listener(version)
  }

  nativePresenceVersion(): NativePresenceVersion {
    return { incarnation: this.nativeIncarnation, revision: this.nativeRevision }
  }

  initializeNativePresence(): Promise<void> {
    this.nativeInitialization ??= (async () => {
      if (this.sessions.nativeInitialized()) return
      let after: string | undefined
      while (!this.disposed) {
        const ids = this.sessions.nativeInitializationPage(after)
        if (!ids.length) {
          this.sessions.finishNativeInitialization()
          this.nativeMetadataChanged()
          return
        }
        this.conversations.initializeNativeAttention(ids)
        after = ids.at(-1)
        // oxlint-disable-next-line no-await-in-loop -- Initial migration projects at most 25 metadata rows before yielding; later restarts never scan the Catalog.
        await yieldImmediate()
      }
    })()
    return this.nativeInitialization
  }

  private liveNativeRows(): { running: NativeSessionRow[]; attention: NativeSessionRow[] } {
    const states = new Map<string, NativeSessionRow['state']>()
    const add = (id: string, state: NativeSessionRow['state']): void => {
      if (!states.has(id) || state === 'recovering') states.set(id, state)
    }
    const referenced = new Set<AgentAdapter>()
    for (const owner of this.activeExecutions.values())
      if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.nativeRebuilds.values())
      if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.nativeChecks.values()) if (owner.adapter) referenced.add(owner.adapter)
    for (const owner of this.nativeForks.values())
      for (const adapter of owner.activeAdapters ?? []) referenced.add(adapter)
    const cached = new Set([...this.adapters.values()].map((entry) => entry.adapter))
    if ([...referenced].some((adapter) => !cached.has(adapter)))
      throw new Error('An active native Adapter is absent from its physical owner.')
    for (const entry of this.adapters.values()) {
      if (!referenced.has(entry.adapter) && !entry.adapter.hasActiveBackgroundWork?.()) continue
      const recovering =
        [...this.nativeRebuilds.values()].some((owner) => owner.adapter === entry.adapter) ||
        [...this.nativeChecks.values()].some((owner) => owner.adapter === entry.adapter) ||
        [...this.nativeForks.values()].some((owner) => owner.activeAdapters?.has(entry.adapter)) ||
        [...this.activeExecutions.values()].some(
          (owner) =>
            owner.adapter === entry.adapter &&
            this.conversations.nativeRunStatus(owner.run.id) === 'recovering',
        )
      add(entry.sessionId, recovering ? 'recovering' : 'running')
    }
    const attention = new Map<string, NativeSessionRow>()
    for (const pending of this.permissions.values()) {
      if (!this.interactionCurrent(pending)) continue
      const row = this.sessions.findNativeRow(pending.sessionId)
      if (!row) continue
      const prior = attention.get(row.sessionId)
      if (!prior || pending.request.kind === 'approval')
        attention.set(row.sessionId, {
          ...row,
          state:
            pending.request.kind === 'approval' || pending.request.kind === undefined
              ? 'approval'
              : 'input',
        })
    }
    if (attention.size > 8 || states.size > 5)
      throw new Error('Native owner metadata exceeds its item budget.')
    const running = [...states].flatMap(([id, state]) => {
      const row = this.sessions.findNativeRow(id)
      return row ? [{ ...row, state }] : []
    })
    return { running, attention: [...attention.values()] }
  }

  private nativeLogicalPreparation(sessionId: string): boolean {
    return (
      [...this.preparingSends.values()].some((owner) => owner.input.sessionId === sessionId) ||
      this.preparingContinuations.has(sessionId) ||
      this.nativeRebuilds.has(sessionId) ||
      [...this.nativeChecks.keys()].some((key) => key.startsWith(`${sessionId}:`)) ||
      this.forkPreparations.has(sessionId) ||
      [...this.nativeForks.values()].some(
        (owner) => (owner.sessionId ?? owner.sourceSessionId) === sessionId,
      )
    )
  }

  getNativePresence(): RpcResult<NativePresenceSnapshot> {
    if (!this.sessions.nativeInitialized())
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Session metadata is starting.' },
      }
    try {
      const live = this.liveNativeRows()
      const liveIds = new Set(live.attention.map((row) => row.sessionId))
      const durable = this.sessions
        .nativeAttention()
        .filter((item) => !liveIds.has(item.row.sessionId))
      const attention = [...live.attention, ...durable.map((item) => item.row)].slice(0, 5)
      const attentionIds = new Set(attention.map((row) => row.sessionId))
      const running = live.running.filter(
        (row) => !attentionIds.has(row.sessionId) && !liveIds.has(row.sessionId),
      )
      const grouped = new Set([
        ...liveIds,
        ...attentionIds,
        ...live.running.map((row) => row.sessionId),
      ])
      const recent = this.sessions
        .nativeRecent()
        .filter((row) => !grouped.has(row.sessionId))
        .slice(0, 5)
        .map((row) => {
          if (this.nativeLogicalPreparation(row.sessionId)) row.state = 'preparing'
          return row
        })
      const attentionTotal =
        this.sessions.nativeAttentionTotal() +
        live.attention.filter((row) => !this.sessions.nativeNeedsAttention(row.sessionId)).length
      return {
        ok: true,
        value: {
          version: this.nativePresenceVersion(),
          running,
          attention,
          recent,
          attentionTotal,
        },
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Native Session metadata could not be loaded.' },
      }
    }
  }

  readNativeAttention(input: NativeAttentionReadInput): RpcResult<NativeAttentionPage> {
    if (!this.sessions.nativeInitialized())
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Session metadata is starting.' },
      }
    const version = this.nativePresenceVersion()
    if (
      input.cursor &&
      (input.cursor.incarnation !== version.incarnation ||
        input.cursor.revision !== version.revision)
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Session attention changed. Reload its first page.' },
      }
    try {
      const live = this.liveNativeRows().attention
      const liveIds = new Set(live.map((row) => row.sessionId))
      let liveOffset = input.cursor?.liveOffset ?? 0
      const rows = live.slice(liveOffset, liveOffset + 5)
      liveOffset += rows.length
      let after = input.cursor?.after
      const candidates = this.sessions.nativeAttention(after)
      for (const item of candidates) {
        if (rows.length === 5) break
        after = { ordinal: item.ordinal, id: item.row.sessionId }
        if (!liveIds.has(item.row.sessionId)) rows.push(item.row)
      }
      const remainingDurable = candidates.some(
        (item) =>
          !liveIds.has(item.row.sessionId) &&
          !rows.some((row) => row.sessionId === item.row.sessionId) &&
          (!after ||
            item.ordinal < after.ordinal ||
            (item.ordinal === after.ordinal && item.row.sessionId < after.id)),
      )
      const total =
        this.sessions.nativeAttentionTotal() +
        live.filter((row) => !this.sessions.nativeNeedsAttention(row.sessionId)).length
      return {
        ok: true,
        value: {
          version,
          sessions: rows,
          total,
          ...(liveOffset < live.length || remainingDurable
            ? { nextCursor: { ...version, liveOffset, ...(after ? { after } : {}) } }
            : {}),
        },
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Sessions needing attention could not be loaded.' },
      }
    }
  }

  prepareNativeQuit(
    input: NativeQuitOperationInput,
    otherPreparationActive = false,
  ): RpcResult<NativeQuitPreparation> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitPreparation?.operationId === input.operationId)
      return this.nativeQuitPreparation.expired
        ? Conversation.quitPrepared()
        : this.nativeQuitPreparation.result
    if (this.nativeQuitPreparation?.sealed) return Conversation.quitPrepared()
    clearTimeout(this.nativeQuitPreparation?.timer)
    // Even a failed metadata query must leave this accepted operation
    // cancellable. Keep the failure itself, never an invented idle result.
    const quitOwner = {
      operationId: input.operationId,
      result: {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Running work could not be confirmed. Review before exiting.',
        },
      } as RpcResult<NativeQuitPreparation>,
      sealed: false,
      expired: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.nativeQuitPreparation = quitOwner
    quitOwner.timer = setTimeout(() => {
      if (this.nativeQuitPreparation === quitOwner) {
        quitOwner.sealed = false
        quitOwner.expired = true
        this.schedulePendingRoutedContinuations()
      }
    }, NATIVE_QUIT_PREPARATION_MS)
    quitOwner.timer.unref()
    try {
      const rows = this.liveNativeRows()
      const identities = new Set([...rows.running, ...rows.attention].map((row) => row.sessionId))
      for (const owner of this.preparingSends.values()) identities.add(owner.input.sessionId)
      for (const owner of this.preparingContinuations.values()) identities.add(owner.sessionId)
      for (const id of this.nativeRebuilds.keys()) identities.add(id)
      for (const key of this.nativeChecks.keys()) identities.add(key.split(':')[0]!)
      for (const id of this.forkPreparations.keys()) identities.add(id)
      for (const owner of this.nativeForks.values())
        identities.add(owner.sessionId ?? owner.sourceSessionId)
      for (const id of this.workspaceChanges?.pendingSessionIds() ?? []) identities.add(id)
      for (const id of this.titleEnrichments.keys()) identities.add(id)
      for (const id of this.nativeTitleSyncs.keys()) identities.add(id)
      for (const owner of this.skillDiscoveries.values()) identities.add(owner.sessionId)
      for (const owner of this.conversations.pendingRoutedContinuations())
        identities.add(owner.sessionId)
      for (const owner of this.conversations.pendingCollaborationInputs())
        identities.add(owner.sessionId)
      const unsettled = this.conversations.nativeQuitUnsettled([...identities])
      const activeCount =
        identities.size +
        unsettled.count +
        Number(otherPreparationActive && identities.size === 0 && unsettled.count === 0)
      const listed = [...new Set([...identities, ...unsettled.sessionIds])]
        .slice(0, 5)
        .flatMap((id) => {
          const row = this.sessions.findNativeRow(id)
          return row
            ? [
                {
                  ...row,
                  state:
                    rows.running.find((item) => item.sessionId === id)?.state ??
                    ('recovering' as const),
                },
              ]
            : []
        })
      const result: NativeQuitPreparation = {
        operationId: input.operationId,
        state: activeCount ? 'confirmation_required' : 'idle_prepared',
        activeCount,
        sessions: listed,
      }
      quitOwner.result = { ok: true, value: result }
      quitOwner.sealed = activeCount === 0
    } catch {
      // The bounded owner retains the uncertain result for cancellation/readback.
    }
    return quitOwner.result
  }

  cancelNativeQuit(
    input: NativeQuitOperationInput,
  ): RpcResult<{ operationId: string; cancelled: true }> {
    const owner = this.nativeQuitPreparation
    if (!owner || owner.operationId !== input.operationId)
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This exit preparation is no longer current.' },
      }
    clearTimeout(owner.timer)
    owner.sealed = false
    owner.expired = true
    this.schedulePendingRoutedContinuations()
    return { ok: true, value: { operationId: input.operationId, cancelled: true } }
  }

  private nativeQuitSealed(): boolean {
    return this.nativeQuitPreparation?.sealed === true
  }
  private static quitPrepared(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Pact is preparing to exit. Cancel Exit before starting new work.',
      },
    }
  }

  prepareWorkspaceArchive(input: WorkspaceArchivePrepareInput): RpcResult<WorkspaceArchivePreview> {
    if (this.disposed) return Conversation.shuttingDown()
    try {
      // A fresh user request may inspect old receipts; it never repeats their Stop or commit.
      for (const operationId of this.conversations.archives.unresolvedOperations(input.scope))
        this.readWorkspaceArchive(operationId)
      const context = this.conversations.archives.context(input.scope)
      const work = this.archiveWork(input.scope)
      return {
        ok: true,
        value: this.conversations.archives.prepare(
          {
            operationId: input.operationId,
            scope: input.scope,
            ...context,
            tasks: work.tasks,
            ...(work.blockedReason ? { blockedReason: work.blockedReason } : {}),
            expiresAt: new Date(Date.now() + WORKSPACE_ARCHIVE_PREVIEW_MS).toISOString(),
          },
          this.archiveOwnerId,
        ),
      }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  readWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    try {
      const receipt = this.conversations.archives.read(operationId)
      if (!receipt)
        throw new WorkspaceArchiveConflictError('This archive operation no longer exists.')
      if (receipt.state === 'unresolved') {
        const work = this.archiveWork(receipt.preview.scope)
        if (
          !work.tasks.length &&
          !work.blockedReason &&
          !this.workspaceChanges?.hasPendingFinalization(receipt.preview.scope)
        )
          this.conversations.archives.releaseResolved(operationId)
      }
      return { ok: true, value: this.conversations.archives.read(operationId)! }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  cancelWorkspaceArchive(operationId: string): RpcResult<WorkspaceArchiveReceipt> {
    try {
      return { ok: true, value: this.conversations.archives.cancel(operationId) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  private archiveWork(scope: WorkspaceArchiveScope): {
    tasks: WorkspaceArchiveTask[]
    blockedReason?: string
  } {
    const projectId = this.conversations.archives.context(scope).projectId
    const belongs = (sessionId: string): boolean =>
      scope.kind === 'session'
        ? sessionId === scope.sessionId
        : this.conversations.archives.sessionMetadata(sessionId)?.projectId === projectId
    const identities = new Map<string, { ids: string[]; state: WorkspaceArchiveTask['state'] }>()
    const add = (
      sessionId: string,
      identity: string,
      state: WorkspaceArchiveTask['state'],
    ): void => {
      if (!belongs(sessionId)) return
      const prior = identities.get(sessionId)
      if (prior) prior.ids.push(identity)
      else identities.set(sessionId, { ids: [identity], state })
    }
    const runs: string[] = []
    for (const entry of this.activeExecutions.values()) {
      add(entry.run.sessionId, `run:${entry.run.id}:${entry.run.bindingGeneration}`, 'running')
      if (belongs(entry.run.sessionId)) runs.push(entry.run.id)
    }
    for (const entry of this.preparingSends.values())
      add(entry.input.sessionId, `send:${entry.input.clientMessageId}`, 'preparing')
    for (const entry of this.preparingContinuations.values())
      add(entry.sessionId, `route:${entry.userMessageId}:${entry.protectedAgentId}`, 'continuing')
    for (const entry of this.conversations.pendingRoutedContinuations(scope))
      add(entry.sessionId, `pending:${entry.userMessageId}:${entry.agentId}`, 'continuing')
    for (const entry of this.conversations.archives.pendingInputs(scope))
      add(entry.sessionId, `input:${entry.id}`, 'continuing')
    const tasks = [...identities].map(([sessionId, entry]) => ({
      sessionId,
      title: this.conversations.archives.sessionMetadata(sessionId)!.title,
      state: entry.state,
      identity: entry.ids.toSorted().join('|'),
    }))
    if (tasks.length > WORKSPACE_ARCHIVE_TASK_LIMIT)
      throw new WorkspaceArchiveConflictError(
        'Too many tasks changed at once. Nothing was stopped; try again.',
      )
    const unsupported =
      [...this.nativeRebuilds.keys()].some(belongs) ||
      [...this.nativeForks.values()].some(
        (entry) =>
          belongs(entry.sourceSessionId) || Boolean(entry.sessionId && belongs(entry.sessionId)),
      ) ||
      [...this.nativeChecks.keys()].some((key) => belongs(key.split(':')[0]!)) ||
      [...this.adapters.values()].some((entry) => {
        if (!belongs(entry.sessionId) || !entry.adapter.hasActiveBackgroundWork?.()) return false
        const foreground = this.activeExecutions.get(entry.sessionId)
        return !foreground || Boolean(this.conversations.findRun(foreground.run.id)?.nativeOutcome)
      }) ||
      this.conversations.archives.hasNativeWork(scope, runs)
    return {
      tasks,
      ...(unsupported
        ? {
            blockedReason:
              'Native work is still recovering, rebuilding, forking, running in the background, or has an unconfirmed ending. Check or finish that work before archiving. Nothing was stopped.',
          }
        : {}),
    }
  }

  async archiveWorkspace<T>(
    scope: WorkspaceArchiveScope,
    operationId: string | undefined,
    commit: (operationId: string) => RpcResult<T>,
    readCommitted: () => RpcResult<T>,
  ): Promise<RpcResult<T>> {
    if (this.disposed) return Conversation.shuttingDown()
    const id = operationId ?? randomUUID()
    const outcomes: WorkspaceArchiveReceipt['tasks'] = []
    let confirmedTasks: WorkspaceArchiveTask[] = []
    let claimed = false
    try {
      const previous = this.conversations.archives.read(id)
      if (previous && JSON.stringify(previous.preview.scope) !== JSON.stringify(scope))
        throw new WorkspaceArchiveConflictError('This confirmation belongs to another item.')
      if (previous?.state === 'archived') {
        if (JSON.stringify(previous.preview.scope) !== JSON.stringify(scope))
          throw new WorkspaceArchiveConflictError('This receipt belongs to another item.')
        return readCommitted()
      }
      if (!operationId) {
        const preview = this.prepareWorkspaceArchive({ operationId: id, scope })
        if (!preview.ok) return preview
        if (preview.value.tasks.length || preview.value.blockedReason)
          throw new WorkspaceArchiveConflictError(
            'Review the running tasks before archiving this item.',
          )
      }
      const work = this.archiveWork(scope)
      if (work.blockedReason) throw new WorkspaceArchiveConflictError(work.blockedReason)
      if (this.archiveOperations.size >= WORKSPACE_ARCHIVE_TASK_LIMIT)
        throw new WorkspaceArchiveConflictError(
          'Archive operations are busy. Nothing new was stopped; try again shortly.',
        )
      const ownedRunIds = [...this.activeExecutions.values()]
        .filter((entry) => work.tasks.some((task) => task.sessionId === entry.run.sessionId))
        .map((entry) => entry.run.id)
      const retiredPatches: ConversationPatch[] = []
      const receipt = this.conversations.archives.claim(
        id,
        this.archiveOwnerId,
        work.tasks,
        ownedRunIds,
        () => {
          for (const task of work.tasks) {
            this.conversations.setReceivedInputState(task.sessionId, 'cancelled')
            this.conversations.pauseCollaboration(task.sessionId)
            retiredPatches.push(this.conversations.cancelPendingRoutedContinuation(task.sessionId))
          }
        },
      )
      if (JSON.stringify(receipt.preview.scope) !== JSON.stringify(scope))
        throw new WorkspaceArchiveConflictError('This confirmation belongs to another item.')
      claimed = true
      this.archiveOperations.add(id)
      confirmedTasks = receipt.preview.tasks
      for (const task of confirmedTasks)
        if (!work.tasks.some((current) => current.sessionId === task.sessionId))
          outcomes.push({ sessionId: task.sessionId, outcome: 'finished' })
      const deadline = performance.now() + WORKSPACE_ARCHIVE_STOP_MS
      const pending = new Set<string>()
      const failures = new Set<string>()
      const runIds: string[] = []
      for (const patch of retiredPatches) {
        try {
          this.publish(patch)
        } catch {
          /* Durable retirement remains authoritative; the Renderer resyncs. */
        }
      }
      const scopeSessionIds = new Set(work.tasks.map((task) => task.sessionId))
      for (const entry of this.adapters.values()) {
        if (
          scope.kind === 'session'
            ? entry.sessionId === scope.sessionId
            : this.conversations.archives.sessionMetadata(entry.sessionId)?.projectId ===
              receipt.preview.projectId
        )
          scopeSessionIds.add(entry.sessionId)
      }
      for (const task of work.tasks) {
        const sessionId = task.sessionId
        const execution = this.activeExecutions.get(sessionId)
        const preparations = [...this.preparingSends.values()].filter(
          (entry) => entry.input.sessionId === sessionId,
        )
        const continuation = this.preparingContinuations.get(sessionId)
        const promises = [
          execution?.completion,
          continuation?.completion,
          ...preparations.map((entry) => entry.task),
        ].filter((promise): promise is Promise<void> | Promise<RpcResult<ConversationPatch>> =>
          Boolean(promise),
        )
        if (execution) runIds.push(execution.run.id)
        const stop = this.stop({ sessionId })
        if (!stop.ok) failures.add(sessionId)
        pending.add(sessionId)
        void Promise.allSettled(promises).then((results) => {
          if (results.some((result) => result.status === 'rejected')) failures.add(sessionId)
          pending.delete(sessionId)
          return undefined
        })
      }
      for (const sessionId of scopeSessionIds) {
        // Pending stages retired in the claim transaction cannot resume after a crash.
        const enrichment = this.titleEnrichments.get(sessionId)
        enrichment?.abortController.abort()
        // oxlint-disable-next-line no-await-in-loop -- The existing title owners have bounded native I/O and share the archive deadline.
        await Conversation.awaitArchiveFinalization(
          Promise.all([this.cancelNativeTitleSync(sessionId), enrichment?.promise]).then(
            () => undefined,
          ),
          deadline,
        )
      }
      // One bounded wait chain per admitted archive (no Run queue, no provider replay).
      while (!this.disposed && performance.now() < deadline) {
        const current = [...scopeSessionIds].some(
          (sessionId) =>
            this.activeExecutions.has(sessionId) ||
            this.preparingContinuations.has(sessionId) ||
            [...this.preparingSends.values()].some((entry) => entry.input.sessionId === sessionId),
        )
        const background = [...this.adapters.values()].some(
          (entry) =>
            scopeSessionIds.has(entry.sessionId) && entry.adapter.hasActiveBackgroundWork?.(),
        )
        if (!pending.size && !current && !background) break
        // oxlint-disable-next-line no-await-in-loop -- One absolute 15-second settlement chain, at most one timer.
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
      for (const task of work.tasks) {
        const unresolved =
          pending.has(task.sessionId) ||
          this.conversations.archives.hasNativeWork({
            kind: 'session',
            sessionId: task.sessionId,
          }) ||
          this.activeExecutions.has(task.sessionId) ||
          [...this.adapters.values()].some(
            (entry) =>
              entry.sessionId === task.sessionId && entry.adapter.hasActiveBackgroundWork?.(),
          )
        outcomes.push({
          sessionId: task.sessionId,
          outcome: unresolved ? 'unresolved' : failures.has(task.sessionId) ? 'failed' : 'stopped',
        })
      }
      if (
        this.disposed ||
        performance.now() >= deadline ||
        failures.size ||
        this.conversations.archives.hasNativeWork(scope) ||
        this.archiveWork(scope).tasks.length
      )
        throw new WorkspaceArchiveConflictError(
          'Not archived. Some tasks were stopped, but other work or saved output could not be confirmed. Check the task results; stopped tasks will not restart automatically.',
        )
      for (const runId of runIds) {
        // Joining the existing owner also joins background-triggered finalization.
        // oxlint-disable-next-line no-await-in-loop -- At most five captured Runs, under the same absolute deadline.
        await Conversation.awaitArchiveFinalization(this.finalizeWorkspaceChanges(runId), deadline)
      }
      if (this.workspaceChanges)
        await Conversation.awaitArchiveFinalization(
          this.workspaceChanges.awaitFinalization(scope),
          deadline,
        )
      if (this.disposed || performance.now() >= deadline)
        throw new WorkspaceArchiveConflictError(
          'Pact closed or archive settlement timed out. Nothing was archived.',
        )
      return this.conversations.archives.finish(id, outcomes, () => {
        const result = commit(id)
        if (!result.ok) throw new WorkspaceArchiveConflictError(result.error.message)
        return result
      })
    } catch (error) {
      if (claimed) {
        for (const task of confirmedTasks)
          if (!outcomes.some((result) => result.sessionId === task.sessionId)) {
            const remaining =
              this.conversations.archives.hasNativeWork({
                kind: 'session',
                sessionId: task.sessionId,
              }) ||
              this.activeExecutions.has(task.sessionId) ||
              [...this.preparingSends.values()].some(
                (entry) => entry.input.sessionId === task.sessionId,
              ) ||
              this.preparingContinuations.has(task.sessionId) ||
              this.workspaceChanges?.hasPendingFinalization({
                kind: 'session',
                sessionId: task.sessionId,
              })
            outcomes.push({
              sessionId: task.sessionId,
              outcome: remaining ? 'unresolved' : 'finished',
            })
          }
        try {
          const remaining = this.archiveWork(scope)
          const unresolved =
            this.conversations.archives.hasNativeWork(scope) ||
            remaining.tasks.length > 0 ||
            Boolean(remaining.blockedReason) ||
            Boolean(this.workspaceChanges?.hasPendingFinalization(scope))
          this.conversations.archives.fail(
            id,
            outcomes,
            error instanceof Error ? error.message : 'Nothing was archived.',
            unresolved,
          )
        } catch {
          return {
            ok: false,
            error: {
              code: 'UNCERTAIN',
              message:
                'The archive result could not be saved. Check this operation after restarting Pact; it will not automatically repeat.',
            },
          }
        }
      }
      return Conversation.sendFailure(error)
    } finally {
      if (claimed) this.archiveOperations.delete(id)
    }
  }

  private static async awaitArchiveFinalization(
    work: Promise<void>,
    deadline: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkspaceArchiveConflictError(
                  'Saving the stopped task took too long. Nothing was archived.',
                ),
              ),
            Math.max(1, deadline - performance.now()),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private observeNativeTitle(
    sessionId: string,
    adapter: AgentAdapter,
    nativeSessionId: string,
    bindingGeneration: number,
  ): void {
    const cached = this.adapters.get(`${sessionId}:codex`)
    const binding = this.conversations.nativeContext(sessionId, 'codex')
    if (
      this.disposed ||
      cached?.adapter !== adapter ||
      binding?.nativeSessionId !== nativeSessionId ||
      binding.bindingGeneration !== bindingGeneration
    )
      return
    cached.nativeTitleObserved = {
      nativeSessionId,
      bindingGeneration,
      executorId: adapter.executorId,
    }
  }

  private nativeTitleState(sessionId: string, adapter: AgentAdapter) {
    if (this.nativeQuitSealed()) return undefined
    if (this.conversations.archives.blocksSession(sessionId)) return undefined
    const cached = this.adapters.get(`${sessionId}:codex`)
    if (this.disposed || cached?.adapter !== adapter || !adapter.setNativeTitle) return undefined
    const session = this.sessions.find(sessionId)
    if (!session || session.status === 'archived') return undefined
    const fork = this.conversations.forkOperation(sessionId)
    if (
      session.titleSource !== 'agent' &&
      session.titleSource !== 'user' &&
      !(session.titleSource === 'local' && fork?.ready)
    )
      return undefined // Let the existing first Native title arrive before decorating.
    if (fork && !fork.ready) return undefined
    const binding = this.conversations.nativeContext(sessionId, 'codex')
    const project = this.projects.find(session.projectId)
    if (
      !binding?.nativeSessionId ||
      !project ||
      cached.cwd !== project.directoryPath ||
      !['ready', 'responding'].includes(binding.continuationState ?? '')
    )
      return undefined
    const observed = cached.nativeTitleObserved
    if (
      session.titleSource === 'agent' &&
      (!observed ||
        observed.nativeSessionId !== binding.nativeSessionId ||
        observed.bindingGeneration !== binding.bindingGeneration ||
        observed.executorId !== adapter.executorId)
    )
      return undefined // A Claude title must not preempt Codex's own first Native title.
    const title = `[Pact] ${project.name} · ${session.title}`
    const key = JSON.stringify([
      title,
      session.titleSource,
      binding.nativeSessionId,
      binding.bindingGeneration,
      cached.executablePath,
      cached.cwd,
      adapter.executorId,
    ])
    if (Buffer.byteLength(key) > 8192) return undefined
    return { key, title, cwd: cached.cwd, nativeSessionId: binding.nativeSessionId }
  }

  private scheduleNativeTitleSync(sessionId: string): void {
    if (this.nativeQuitSealed()) return
    if (this.conversations.archives.blocksSession(sessionId)) return
    const cached = this.adapters.get(`${sessionId}:codex`)
    if (!cached?.adapter.setNativeTitle || this.disposed) return
    const state = this.nativeTitleState(sessionId, cached.adapter)
    if (!state) return
    const previous = this.nativeTitleSyncs.get(sessionId)
    if (previous) {
      if (previous.desiredKey !== state.key) {
        previous.desiredKey = state.key
        previous.dirty = true
      }
      return
    }
    if (this.nativeTitleSyncs.size >= MAX_ADAPTER_SLOTS) return
    const owner: ActiveNativeTitleSync = {
      adapter: cached.adapter,
      executorId: cached.adapter.executorId,
      abortController: new AbortController(),
      desiredKey: state.key,
      dirty: false,
      cancelled: false,
      promise: Promise.resolve(),
    }
    this.nativeTitleSyncs.set(sessionId, owner)
    owner.promise = (async () => {
      const timer = setTimeout(() => owner.abortController.abort(), 4000)
      let retryLatest = false
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (this.disposed || owner.abortController.signal.aborted) break
          const latest = this.nativeTitleState(sessionId, owner.adapter)
          if (!latest || owner.adapter.executorId !== owner.executorId) break
          owner.desiredKey = latest.key
          owner.dirty = false
          // oxlint-disable-next-line no-await-in-loop -- Serialize this Session's absolute metadata writes and coalesce to the newest durable title.
          const result = await owner.adapter.setNativeTitle!(
            {
              nativeSessionId: latest.nativeSessionId,
              cwd: latest.cwd,
              title: latest.title,
              isCurrent: () =>
                this.nativeTitleSyncs.get(sessionId) === owner &&
                owner.adapter.executorId === owner.executorId &&
                this.nativeTitleState(sessionId, owner.adapter)?.key === latest.key,
            },
            owner.abortController.signal,
          )
          const current = this.nativeTitleState(sessionId, owner.adapter)
          owner.dirty = owner.dirty || Boolean(current && current.key !== latest.key)
          if (result === 'unknown_delivery') {
            owner.dirty = false
            break
          }
          if (!owner.dirty) break
          retryLatest = true
        }
      } catch {
        /* The persistent Pact title remains the next connection's desired value. */
      } finally {
        clearTimeout(timer)
        if (this.nativeTitleSyncs.get(sessionId) === owner) this.nativeTitleSyncs.delete(sessionId)
        if (retryLatest && owner.dirty && !this.disposed && !owner.cancelled)
          queueMicrotask(() => this.scheduleNativeTitleSync(sessionId))
      }
      return undefined
    })()
  }

  private cancelNativeTitleSync(sessionId: string): Promise<void> {
    const owner = this.nativeTitleSyncs.get(sessionId)
    if (owner) owner.cancelled = true
    owner?.abortController.abort()
    return owner?.promise ?? Promise.resolve()
  }

  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    if (input.action !== 'prepare') return this.executeForkRequest(input)
    const existing = this.forkPreparations.get(input.sourceSessionId)
    if (existing)
      return existing.messageId === input.messageId
        ? existing.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'Another message is being prepared for a fork.' },
          })
    if (this.forkPreparations.size >= MAX_AGENT_OPERATIONS)
      return Promise.resolve({
        ok: false,
        error: { code: 'CONFLICT', message: 'Fork preparation capacity is unavailable.' },
      })
    const entry = { messageId: input.messageId, task: this.executeForkRequest(input) }
    this.forkPreparations.set(input.sourceSessionId, entry)
    this.nativeMetadataChanged()
    const release = (): void => {
      if (this.forkPreparations.get(input.sourceSessionId) === entry)
        this.forkPreparations.delete(input.sourceSessionId)
      this.nativeMetadataChanged()
    }
    void entry.task.then(release, release)
    return entry.task
  }

  private async executeForkRequest(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    if (this.disposed) return Conversation.shuttingDown()
    if (input.action === 'read')
      return {
        ok: true,
        value: {
          kind: 'state',
          operation: this.conversations.forkOperation(input.sessionId) ?? null,
        },
      }
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    const archiveSessionId = 'sourceSessionId' in input ? input.sourceSessionId : input.sessionId
    if (this.conversations.archives.blocksSession(archiveSessionId, input.action === 'check'))
      return Conversation.archiveBusy()
    const sourceSessionId =
      input.action === 'prepare' || input.action === 'create'
        ? input.sourceSessionId
        : input.sessionId
    const sourceSession = this.sessions.find(sourceSessionId)
    if (!sourceSession || sourceSession.status === 'archived')
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    if (input.action === 'create') {
      const existing = this.conversations.forkOperationById(input.operationId)
      if (existing) {
        if (
          existing.sourceSessionId !== input.sourceSessionId ||
          existing.sourceMessageId !== input.messageId
        )
          return {
            ok: false,
            error: { code: 'CONFLICT', message: 'This fork operation belongs to another message.' },
          }
        return {
          ok: true,
          value: {
            kind: 'created',
            change: this.sessions.change(existing.sessionId),
            operation: existing,
          },
        }
      }
    }
    if (
      this.operationCount() >= MAX_AGENT_OPERATIONS ||
      this.hasSessionOperation(sourceSessionId, input.action !== 'check')
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'Wait for this session and its native tasks to finish before forking or confirming native setup.',
        },
      }
    const owner = {
      sourceSessionId,
      controller: new AbortController(),
      ...(input.action !== 'prepare' && input.action !== 'create'
        ? { sessionId: input.sessionId, operationId: input.operationId }
        : {}),
    } as {
      sourceSessionId: string
      sessionId?: string
      operationId?: string
      controller: AbortController
      completion?: Promise<void>
      activeAdapters?: Set<AgentAdapter>
    }
    this.nativeForks.set(sourceSessionId, owner)
    this.publish(this.conversations.metadataPatch(sourceSessionId))
    let continued = false
    try {
      if (input.action === 'prepare' || input.action === 'create') {
        const prepared = await this.prepareSession(sourceSessionId, owner.controller.signal)
        if (!prepared.ok) return prepared
        const session = prepared.value.session
        if (
          this.conversations.sessionHasNativeWork(sourceSessionId) ||
          this.conversations.forkOperation(sourceSessionId)?.ready === false
        )
          throw new Error('Native tasks from the source session have not been confirmed finished.')
        const selection = this.conversations.selectForkSource(
          sourceSessionId,
          input.messageId,
          session.settings,
          session.settingsRevision,
        )
        if (
          input.action === 'create' &&
          (selection.prepared.sourceRevision !== input.sourceRevision ||
            selection.prepared.messageRevision !== input.messageRevision ||
            selection.prepared.settingsRevision !== input.settingsRevision)
        )
          throw new Error(
            'The source conversation or settings changed. Review the fork confirmation again.',
          )
        const boundaries: Partial<Record<RuntimeAgentId, AgentNativeForkBoundary>> = {}
        // Two independent read-only sources; neither provider may write during preparation.
        const inspected = await Promise.allSettled(
          (['claude', 'codex'] as const).map(async (agentId) => {
            const run = selection.runs[agentId]
            const adapter = await this.adapterFor(
              sourceSessionId,
              agentId,
              prepared.value.executablePaths[agentId],
              owner.controller.signal,
              prepared.value.projectDirectory,
            )
            const releaseAdapter = this.holdForkAdapter(owner, adapter)
            try {
              if (!adapter.prepareNativeFork)
                throw new Error(`${agentId} does not support native forking.`)
              const response = this.conversations.forkResponse(run.id, selection.prepared.sequence)
              boundaries[agentId] = await adapter.prepareNativeFork(
                {
                  cwd: prepared.value.projectDirectory,
                  nativeSessionId: run.nativeSessionId!,
                  nativeTurnId: run.nativeTurnId!,
                  runId: run.id,
                  bindingGeneration: run.bindingGeneration,
                  throughSequence: response.sequence,
                  deliveryCursor: response.deliveryCursor,
                  responseHash: response.responseHash,
                  ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
                },
                owner.controller.signal,
              )
            } finally {
              releaseAdapter()
            }
          }),
        )
        for (const result of inspected) if (result.status === 'rejected') throw result.reason
        if (this.disposed || owner.controller.signal.aborted)
          throw new Error('Fork preparation was cancelled.')
        if (input.action === 'prepare')
          return { ok: true, value: { kind: 'prepared', prepared: selection.prepared } }
        if (
          this.hasSessionOperation(sourceSessionId, true, owner) ||
          this.conversations.sessionHasNativeWork(sourceSessionId)
        )
          throw new Error('The source session started native work. No fork was created.')
        const operation = this.conversations.commitFork(
          input.operationId,
          selection,
          { claude: boundaries.claude!, codex: boundaries.codex! },
          input.confirmedFullAccessAgents,
        )
        owner.sessionId = operation.sessionId
        owner.operationId = operation.id
        const change = this.sessions.change(operation.sessionId)
        // Commit receipt goes back immediately; progress/real native interactions use bounded Patches.
        continued = true
        owner.completion = Promise.allSettled(
          (['claude', 'codex'] as const).map((agentId) =>
            this.runForkSide(owner, agentId, 'continue'),
          ),
        )
          .then(() => undefined)
          .finally(() => {
            if (this.nativeForks.get(sourceSessionId) === owner)
              this.nativeForks.delete(sourceSessionId)
            if (!this.disposed) this.publish(this.conversations.metadataPatch(sourceSessionId))
          })
        return { ok: true, value: { kind: 'created', change, operation } }
      }
      const operation = this.conversations.forkOperation(input.sessionId)
      if (!operation || operation.id !== input.operationId)
        throw new Error('The fork operation is unavailable.')
      if (input.action === 'continue') {
        owner.sourceSessionId = operation.sourceSessionId
        this.publish(this.conversations.metadataPatch(operation.sourceSessionId))
      }
      if (input.action === 'check') {
        await this.checkForkSide(owner, input.agentId)
      } else {
        continued = true
        owner.completion = this.runForkSide(owner, input.agentId, input.action).finally(() => {
          if (this.nativeForks.get(sourceSessionId) === owner)
            this.nativeForks.delete(sourceSessionId)
          if (!this.disposed) {
            this.publish(this.conversations.metadataPatch(input.sessionId))
            if (owner.sourceSessionId !== input.sessionId)
              this.publish(this.conversations.metadataPatch(owner.sourceSessionId))
          }
        })
      }
      return {
        ok: true,
        value: { kind: 'state', operation: this.conversations.forkOperation(input.sessionId)! },
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: safeNativePermissionText(
            error instanceof Error ? error.message : 'The fork could not be prepared.',
          ),
        },
      }
    } finally {
      if (!continued && this.nativeForks.get(sourceSessionId) === owner) {
        this.nativeForks.delete(sourceSessionId)
        if (!this.disposed) this.publish(this.conversations.metadataPatch(sourceSessionId))
      }
    }
  }

  private async forkAdapter(
    owner: { sessionId?: string; controller: AbortController },
    agentId: RuntimeAgentId,
  ) {
    const prepared = await this.prepareSession(owner.sessionId!, owner.controller.signal)
    if (!prepared.ok) throw new Error(prepared.error.message)
    const adapter = await this.adapterFor(
      owner.sessionId!,
      agentId,
      prepared.value.executablePaths[agentId],
      owner.controller.signal,
      prepared.value.projectDirectory,
    )
    return { adapter, prepared: prepared.value }
  }

  private holdForkAdapter(
    owner: { activeAdapters?: Set<AgentAdapter> },
    adapter: AgentAdapter,
  ): () => void {
    owner.activeAdapters ??= new Set()
    const alreadyHeld = owner.activeAdapters.has(adapter)
    owner.activeAdapters.add(adapter)
    this.nativeMetadataChanged()
    return () => {
      if (!alreadyHeld) owner.activeAdapters?.delete(adapter)
      this.nativeMetadataChanged()
    }
  }

  private forkAdapterInput(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
    prepared: PreparedSession,
    phase: 'fork' | 'initialize',
  ): AgentNativeForkInput {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    const intent = this.conversations.forkIntent(sessionId, operationId, agentId)
    const settingsRevision = prepared.session.settingsRevision
    const current = (): boolean =>
      !this.disposed &&
      !owner.controller.signal.aborted &&
      this.conversations.forkOperation(sessionId)?.id === operationId &&
      this.sessions.find(sessionId)?.settingsRevision === settingsRevision &&
      this.sessions.find(sessionId)?.status !== 'archived'
    let dispatchedExecutor: string | undefined
    const actor = () => ({
      id: operationId,
      sessionId,
      agentId,
      bindingGeneration: 1,
      executorId:
        this.conversations.forkIntent(sessionId, operationId, agentId).executorId ?? undefined,
      valid: current,
    })
    return {
      operationId,
      sessionId,
      cwd: prepared.projectDirectory,
      model: prepared.session.settings.agents[agentId].model,
      effort: prepared.session.settings.agents[agentId].effort,
      permissionMode:
        prepared.session.settings.permissionModes?.[agentId] ??
        (agentId === 'claude' ? 'ask' : 'native'),
      source: intent.source,
      lastDispatchedPhase: intent.phase,
      ...(intent.nativeSessionId && !(phase === 'fork' && intent.candidateMissing)
        ? { nativeSessionId: intent.nativeSessionId }
        : {}),
      ...(intent.witness && !(phase === 'fork' && intent.candidateMissing)
        ? { witness: intent.witness }
        : {}),
      onDispatched: async (executorId) => {
        if (!current())
          throw new Error('The fork settings or operation changed before native dispatch.')
        this.workspaceChanges?.cancelUndoForNativeSession(sessionId)
        dispatchedExecutor = executorId
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            executorId,
            settingsRevision,
            phase,
            dispatched: true,
            state: phase === 'fork' ? 'forking' : 'initializing',
            nativeWorkState: 'pending',
            reason: null,
          }),
        )
      },
      onCandidate: async (nativeSessionId, witness) => {
        if (!current()) throw new Error('The fork candidate owner changed.')
        const saved = this.conversations.forkIntent(sessionId, operationId, agentId)
        if (
          dispatchedExecutor &&
          (saved.executorId !== dispatchedExecutor || saved.phase !== phase)
        )
          throw new Error('A late native candidate does not own this dispatch.')
        if (
          saved.nativeSessionId &&
          saved.nativeSessionId !== nativeSessionId &&
          !saved.candidateMissing
        )
          throw new Error('A different native candidate cannot replace this fork.')
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId,
            ...(witness ? { witnessJson: JSON.stringify(witness) } : {}),
            ...(phase === 'fork' ? { state: 'forking' as const, candidateVerified: false } : {}),
            candidateMissing: false,
          }),
        )
      },
      reportNativeWork: (report) => {
        const saved = this.conversations.forkIntent(sessionId, operationId, agentId)
        if (saved.executorId !== report.executorId) return
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeWorkState: report.state,
          }),
        )
      },
      requestPermission: (request, signal) =>
        this.requestNativePermission(actor(), request, signal),
      requestUserInput: (request, signal) => this.requestNativeUserInput(actor(), request, signal),
    }
  }

  private async checkForkSide(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
  ): Promise<void> {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    const intent = this.conversations.forkIntent(sessionId, operationId, agentId)
    const alreadyReady = intent.state === 'ready'
    if (alreadyReady && this.conversations.latestAgentRun(sessionId, agentId)) return
    if (!intent.dispatched) return // Explicit Continue is the only creation path.
    if (!intent.nativeSessionId) {
      this.publish(
        this.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: 'unconfirmed',
          reason:
            'Native fork may have been created, but its identity was not acknowledged. It will not be created again.',
        }),
      )
      return
    }
    const { adapter, prepared } = await this.forkAdapter(owner, agentId)
    const releaseAdapter = this.holdForkAdapter(owner, adapter)
    try {
      if (!adapter.inspectNativeFork)
        throw new Error('The native runtime does not support pure fork inspection.')
      const probe = this.forkAdapterInput(owner, agentId, prepared, 'initialize')
      // Later ordinary settings apply to the next task. Inspect the actual completed setup receipt.
      if (alreadyReady && intent.witness) {
        probe.model = intent.witness.model
        probe.effort = intent.witness.effort
        probe.permissionMode = intent.witness.permissionMode
      }
      const result = await adapter.inspectNativeFork(probe, owner.controller.signal)
      if (result.kind === 'verified') {
        if (alreadyReady && result.ready) {
          this.publish(this.conversations.metadataPatch(sessionId))
          this.scheduleNativeTitleSync(sessionId)
          return
        }
        const saved = this.conversations.forkIntent(sessionId, operationId, agentId)
        const maySettle = result.workSettled || saved.nativeWorkState === 'settled'
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId: result.result.nativeSessionId,
            witnessJson: JSON.stringify(result.result.witness),
            candidateVerified: true,
            candidateMissing: false,
            ...(maySettle ? { nativeWorkState: 'settled' as const } : {}),
            state: result.ready
              ? 'unconfirmed'
              : saved.phase === 'initialize' && !maySettle
                ? 'unconfirmed'
                : 'error',
            reason: result.ready
              ? null
              : maySettle
                ? 'Native fork verified. Continue initialization to make it ready.'
                : 'Native fork verified, but previous startup work has not been confirmed finished.',
          }),
        )
        if (result.ready) {
          this.publish(
            this.conversations.completeForkSide(
              sessionId,
              operationId,
              agentId,
              result.result.nativeSessionId,
              result.result.witness,
            ),
          )
          this.scheduleNativeTitleSync(sessionId)
        }
      } else
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            state: result.kind === 'missing' ? 'error' : 'unconfirmed',
            candidateVerified: false,
            candidateMissing: result.kind === 'missing',
            reason: safeNativePermissionText(result.reason).slice(0, 1024),
          }),
        )
    } finally {
      releaseAdapter()
    }
  }

  private async runForkSide(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
    action: 'continue' | 'initialize',
  ): Promise<void> {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    let releaseAdapter: (() => void) | undefined
    try {
      let intent = this.conversations.forkIntent(sessionId, operationId, agentId)
      if (intent.state === 'ready') return
      this.publish(
        this.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: action === 'continue' ? 'forking' : 'initializing',
          reason: null,
        }),
      )
      const { adapter, prepared } = await this.forkAdapter(owner, agentId)
      releaseAdapter = this.holdForkAdapter(owner, adapter)
      if (!adapter.forkNativeContext || !adapter.initializeNativeFork || !adapter.inspectNativeFork)
        throw new Error(`${agentId} cannot perform and verify a true native fork.`)
      if (action === 'continue') {
        if (intent.candidateMissing) {
          await this.checkForkSide(owner, agentId)
          intent = this.conversations.forkIntent(sessionId, operationId, agentId)
          if (intent.state === 'ready') return
        }
        if (intent.dispatched && !intent.candidateMissing)
          throw new Error(
            'Check the original native candidate before continuing. A possibly delivered fork will not be repeated.',
          )
        const operation = this.conversations.forkOperation(sessionId)!
        if (
          this.hasSessionOperation(operation.sourceSessionId, true, owner) ||
          this.conversations.sessionHasNativeWork(operation.sourceSessionId)
        )
          throw new Error(
            'The source session is running. Wait for it to finish before continuing native fork creation.',
          )
        const result = await adapter.forkNativeContext(
          this.forkAdapterInput(owner, agentId, prepared, 'fork'),
          owner.controller.signal,
        )
        this.publish(
          this.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId: result.nativeSessionId,
            witnessJson: JSON.stringify(result.witness),
            candidateVerified: true,
            candidateMissing: false,
          }),
        )
        intent = this.conversations.forkIntent(sessionId, operationId, agentId)
      } else {
        await this.checkForkSide(owner, agentId)
        intent = this.conversations.forkIntent(sessionId, operationId, agentId)
        if (intent.state === 'ready') return
      }
      if (
        !intent.candidateVerified ||
        !intent.nativeSessionId ||
        !intent.witness ||
        intent.nativeWorkState !== 'settled'
      )
        throw new Error(
          'The original native candidate or its previous work is not yet confirmed. No new initialization was started.',
        )
      const result = await adapter.initializeNativeFork(
        this.forkAdapterInput(owner, agentId, prepared, 'initialize'),
        owner.controller.signal,
      )
      if (this.sessions.find(sessionId)?.settingsRevision !== prepared.session.settingsRevision)
        throw new Error(
          'Session settings changed during native initialization. Check this candidate again.',
        )
      this.publish(
        this.conversations.completeForkSide(
          sessionId,
          operationId,
          agentId,
          result.nativeSessionId,
          result.witness,
        ),
      )
      this.scheduleNativeTitleSync(sessionId)
    } catch (error) {
      const intent = this.conversations.forkIntent(sessionId, operationId, agentId)
      this.publish(
        this.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: intent.dispatched && !intent.nativeSessionId ? 'unconfirmed' : 'error',
          reason: safeNativePermissionText(
            error instanceof Error ? error.message : 'Native fork could not be confirmed.',
          ).slice(0, 1024),
        }),
      )
    } finally {
      releaseAdapter?.()
    }
  }

  /** One physical compiler, bounded waiting identities, durable derived pages and no retained AST. */
  private async prepareMarkdown(
    sessionId: string,
    runId: string,
    source: import('@pact/contracts').CollaborationDocument,
  ): Promise<void> {
    const row = this.conversations.collaborationDocumentRow(sessionId, source)
    if (row.sourceRunId !== runId) throw new Error('The source Run changed.')
    if (row.projectionPages !== null || row.projectionBasis === 'plain-visible-v1') return
    const existing = this.markdownPreparations.get(source.id)
    if (existing) return existing
    if (this.disposed || this.markdownPreparations.size >= 32)
      throw new Error('Document processing is busy. Try reading again.')
    const expires = Date.now() + 30_000
    const previous = this.markdownTail
    let timedOut = false
    const task = (async () => {
      await previous
      if (this.disposed || Date.now() >= expires)
        throw new Error('Document preparation timed out. Original content is preserved.')
      const memory = new NativeWorkingMemory().reserve(128 * 1024 * 1024)
      let worker: Worker
      try {
        worker = new Worker(join(__dirname, 'markdown-projection-worker.js'), {
          resourceLimits: {
            maxOldGenerationSizeMb: 96,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 8,
          },
        })
      } catch (error) {
        memory.release()
        throw error
      }
      // Per-request listeners propagate failures; retain a terminal handler between credited requests.
      worker.on('error', () => undefined)
      this.markdownWorker = worker
      const timer = setTimeout(
        () => {
          timedOut = true
          void worker.terminate()
        },
        Math.min(10_000, expires - Date.now()),
      )
      try {
        this.conversations.beginMarkdownProjection(sessionId, source)
        const request = (message: object): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            const cleanup = () => {
              worker.off('message', answer)
              worker.off('error', failed)
              worker.off('exit', exited)
            }
            const answer = (reply: Record<string, unknown>) => {
              cleanup()
              if (reply.type === 'error') reject(new Error(String(reply.message)))
              else resolve(reply)
            }
            const failed = (error: Error) => {
              cleanup()
              reject(error)
            }
            const exited = () =>
              failed(new Error('Document processing stopped. Original content is preserved.'))
            worker.once('message', answer)
            worker.once('error', failed)
            worker.once('exit', exited)
            worker.postMessage(message)
          })
        let offset = 0
        while (offset < source.chars) {
          const part = this.conversations.readPage({
            scope: 'collaboration-text',
            sessionId,
            runId,
            document: source,
            offset,
          })
          if (part.scope !== 'collaboration-text' || !part.text.length)
            throw new Error('The document source has a missing segment.')
          // oxlint-disable-next-line no-await-in-loop -- One physical input segment is credited at a time.
          await request({ type: 'append', text: part.text })
          offset += part.text.length
        }
        let pages = 0
        let type: 'compile' | 'next' = 'compile'
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- The Worker sends one bounded page only after the prior page commits.
          const reply = await request({ type })
          if (reply.type === 'complete') break
          if (reply.type !== 'page') throw new Error('Invalid Markdown compiler response.')
          const page = collaborationMarkdownPageSchema.parse(reply.page)
          this.conversations.recordMarkdownPage(sessionId, source, page)
          pages++
          type = 'next'
        }
        this.conversations.sealMarkdownProjection(sessionId, source, pages)
      } finally {
        clearTimeout(timer)
        await worker.terminate()
        if (this.markdownWorker === worker) this.markdownWorker = undefined
        memory.release()
      }
    })().catch((error: unknown) => {
      if (
        !this.disposed &&
        error instanceof Error &&
        (Reflect.get(error, 'code') === 'ERR_WORKER_OUT_OF_MEMORY' ||
          timedOut ||
          /projection exceeded its working stack/u.test(error.message))
      ) {
        this.conversations.usePlainCollaborationProjection(sessionId, source)
      } else throw error
    })
    this.markdownPreparations.set(source.id, task)
    this.markdownTail = task.catch(() => undefined)
    try {
      await task
    } finally {
      if (this.markdownPreparations.get(source.id) === task)
        this.markdownPreparations.delete(source.id)
    }
  }

  async load(input: ConversationGetInput): Promise<RpcResult<ConversationPage>> {
    const session = this.sessions.find(input.sessionId)
    if (!session || session.status === 'archived') {
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    }
    try {
      if (input.scope === 'collaboration-markdown' && input.basis !== 'plain-visible-v1')
        await this.prepareMarkdown(input.sessionId, input.runId, input.document)
      const page = this.conversations.readPage(input)
      if (page.scope === 'messages')
        page.header.pendingNativeInteractions = this.pendingNativeInteractions(input.sessionId)
      if (page.scope === 'messages') page.header.forkBlocked = this.forkBlocked(input.sessionId)
      if (page.scope === 'messages')
        page.header.sessionIssues = this.sessionIssues(
          input.sessionId,
          page.header.nativeContexts ?? [],
        )
      return { ok: true, value: page }
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof StaleConversationCursorError
              ? 'CONFLICT'
              : error instanceof OversizedConversationEntityError
                ? 'VALIDATION'
                : 'INTERNAL',
          message: error instanceof Error ? error.message : 'Conversation history could not load.',
        },
      }
    }
  }

  async writeImage(input: ImageWriteInput, owner: string): Promise<RpcResult<ImageWriteState>> {
    try {
      if (this.disposed || !this.images) throw new Error('Image input is unavailable.')
      return { ok: true, value: await this.images.write(input, owner) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }
  async chooseImages(
    session: string,
    paths: string[],
    owner: string,
  ): Promise<RpcResult<ConversationImage[]>> {
    try {
      if (this.disposed || !this.images) throw new Error('Image input is unavailable.')
      return { ok: true, value: await this.images.choose(session, paths, owner) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }
  async readImage(input: ImageReadInput, owner: string): Promise<RpcResult<ImageReadPart>> {
    try {
      if (this.disposed || !this.images) throw new Error('Image input is unavailable.')
      return { ok: true, value: await this.images.read(input, owner) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }
  private async resolveRebuildImage(
    session: string,
    id: string,
  ): Promise<import('@pact/agent-runtime').AgentPromptImage> {
    const image = this.conversations.resolveMessageImages(session, [id])[0]
    if (!image || !this.images) throw new Error('The saved image source is unavailable.')
    return this.images.resolve(session, image)
  }

  writeInput(input: ConversationInputWrite, ownerKey: string): RpcResult<ConversationInputState> {
    if (this.disposed) return Conversation.shuttingDown()
    try {
      return { ok: true, value: this.conversations.writeConversationInput(input, ownerKey) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  releaseInputOwner(ownerKey: string): void {
    this.conversations.releaseConversationInputs(ownerKey)
    void this.images?.releaseOwner(ownerKey).catch(() => undefined)
  }

  async send(
    input: ConversationSendInput,
    ownerKey?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    let releaseImages: (() => void) | undefined
    try {
      const task = this.conversations.collaboration(input.sessionId)
      const waitingForWork =
        task?.status !== 'paused' &&
        (task?.status === 'running' || this.hasSessionOperation(input.sessionId, true))
      const received = this.conversations.receivedInputReceipt(
        input.sessionId,
        input.clientMessageId,
        input,
        waitingForWork,
      )
      if (received) return { ok: true, value: received }
      if (this.nativeQuitSealed()) return Conversation.quitPrepared()
      if (this.conversations.archives.blocksSession(input.sessionId))
        return Conversation.archiveBusy()
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()

      if (input.imageIds?.length) {
        if (!this.images) throw new Error('Image input is unavailable.')
        this.conversations.resolveMessageImages(input.sessionId, input.imageIds, ownerKey)
        releaseImages = this.images.hold(input.imageIds)
      }
      const content = input.inputId
        ? this.conversations
            .resolveConversationInput(
              input.sessionId,
              input.clientMessageId,
              input.inputId,
              ownerKey ?? '',
            )
            .trim()
        : input.content
      if (
        input.planningAction &&
        (!task ||
          !(task.plan || task.planDocument) ||
          !collaborationRequiresPlan(task) ||
          task.approvedPlanVersion !== undefined)
      )
        throw new RunOperationConflictError('Planning feedback requires a current unapproved plan.')
      if (
        task &&
        !parseComposerCommandPrefix(content, input.skills).pact &&
        !parseComposerCommandPrefix(content, input.skills).skills.length &&
        !input.skills?.length
      ) {
        if (input.route?.type === 'all')
          throw new RunOperationConflictError('Finish or stop this Pact task before using @all.')
        const actor =
          input.route?.type === 'agent'
            ? input.route.agentId
            : this.conversations.collaborationAnswerResolver(task)
        if (
          input.planningAction &&
          actor !==
            (input.planningAction === 'maintain_plan' ? task.primary : otherAgent(task.primary))
        )
          throw new RunOperationConflictError('The selected Agent does not own this planning duty.')
        const session = this.sessions.find(input.sessionId)
        if (!session || session.status === 'archived')
          throw new RunOperationConflictError('The Session is unavailable.')
        const bodyOwner = ownerKey ?? 'pact-received-input'
        let retainedId = input.inputId
        if (!retainedId) {
          const initial = this.conversations.writeConversationInput(
            { type: 'begin', sessionId: input.sessionId, clientMessageId: input.clientMessageId },
            bodyOwner,
          )
          retainedId = initial.inputId
          let offset = initial.offset
          while (offset < content.length) {
            let end = Math.min(content.length, offset + 8192)
            if (
              end < content.length &&
              content.charCodeAt(end - 1) >= 0xd800 &&
              content.charCodeAt(end - 1) <= 0xdbff
            )
              end--
            this.conversations.writeConversationInput(
              {
                type: 'append',
                sessionId: input.sessionId,
                inputId: retainedId,
                offset,
                text: content.slice(offset, end),
              },
              bodyOwner,
            )
            offset = end
          }
          this.conversations.writeConversationInput(
            { type: 'seal', sessionId: input.sessionId, inputId: retainedId },
            bodyOwner,
          )
        }
        const patch = this.conversations.receiveCollaborationInput(
          { ...input, content },
          retainedId,
          actor,
          session.settings.runningMessagePolicy,
          bodyOwner,
          waitingForWork,
        )
        this.publish(patch)
        this.schedulePendingRoutedContinuations()
        return { ok: true, value: patch }
      }
      const { inputId, ...fields } = input
      return await this.enqueueSend(
        { ...fields, content },
        ownerKey ? { imageOwnerKey: ownerKey } : {},
      ).then((result) => {
        if (result.ok && inputId)
          this.conversations.consumeConversationInput(input.sessionId, inputId, ownerKey!)
        return result
      })
    } catch (error) {
      return Conversation.sendFailure(error)
    } finally {
      releaseImages?.()
    }
  }

  private interactionCurrent(pending: {
    operationId: string
    sessionId: string
    agentId: RuntimeAgentId
    bindingGeneration: number
    executorId?: string | undefined
    visible: boolean
    valid: () => boolean
  }): boolean {
    if (!pending.visible || !pending.valid()) return false
    if (!pending.executorId) return false
    if (
      this.conversations.forkActorIsCurrent(
        pending.sessionId,
        pending.operationId,
        pending.agentId,
        pending.executorId,
      )
    ) {
      const adapter = this.adapters.get(`${pending.sessionId}:${pending.agentId}`)?.adapter
      return (
        pending.bindingGeneration === 1 &&
        (adapter?.hasActiveBackgroundWork?.(pending.operationId) === true ||
          [...this.nativeForks.values()].some(
            (owner) =>
              owner.sessionId === pending.sessionId && owner.operationId === pending.operationId,
          ))
      )
    }
    const operation = this.conversations.nativeRebuildOperation(pending.operationId)
    if (operation) {
      const adapter = this.adapters.get(`${pending.sessionId}:${pending.agentId}`)?.adapter
      const context = this.conversations.nativeContext(pending.sessionId, pending.agentId)
      const rebuild = this.nativeRebuilds.get(pending.sessionId)
      try {
        this.conversations.verifyRebuildReceipt(
          pending.operationId,
          pending.sessionId,
          pending.agentId,
        )
      } catch {
        return false
      }
      return (
        !['completed', 'failed', 'superseded'].includes(operation.stage) &&
        (context?.bindingGeneration ?? 1) === operation.oldGeneration &&
        pending.bindingGeneration === operation.oldGeneration + 1 &&
        adapter?.executorId === pending.executorId &&
        (rebuild?.rebuildId === pending.operationId ||
          adapter.hasActiveBackgroundWork?.(pending.operationId) === true)
      )
    }
    const run = this.conversations.findRun(pending.operationId)
    const context = this.conversations.nativeContext(pending.sessionId, pending.agentId)
    return (
      run !== undefined &&
      !run.forkSourceRunId &&
      run.sessionId === pending.sessionId &&
      run.agentId === pending.agentId &&
      run.controlDisposition !== 'abandoned' &&
      (run.bindingGeneration ?? 1) === pending.bindingGeneration &&
      (context?.bindingGeneration ?? run?.bindingGeneration ?? 1) === pending.bindingGeneration &&
      run.executorId === pending.executorId &&
      (!context?.executorId ||
        context.lastRunId !== run.id ||
        context.executorId === pending.executorId)
    )
  }

  private pendingNativeInteractions(sessionId: string): PendingNativeInteraction[] {
    return [...this.permissions.values()]
      .filter((pending) => pending.sessionId === sessionId && this.interactionCurrent(pending))
      .map((pending) => {
        const projection: PendingNativeInteraction = {
          agentId: pending.agentId,
          bindingGeneration: pending.bindingGeneration,
          request: {
            id: pending.request.id,
            operationId: pending.operationId,
            kind: pending.request.kind ?? 'approval',
            title: 'Native interaction',
            detail: '',
            createdAt: pending.request.createdAt,
          },
        }
        if (pending.executorId) projection.executorId = pending.executorId
        return projection
      })
  }

  respondNativePermission(input: NativePermissionRespondInput): RpcResult<ConversationPatch> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    const pending = this.permissions.get(input.permissionId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      (pending.request.kind !== undefined && pending.request.kind !== 'approval') ||
      pending.details?.kind !== 'approval' ||
      !pending.details.actions.some((action) => action.id === input.decision)
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This permission request is no longer active.' },
      }
    try {
      return { ok: true, value: pending.settle(input.decision) }
    } catch {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message:
            'The permission decision could not be saved; its native outcome is not confirmed.',
        },
      }
    }
  }

  private requestNativePermission(
    owner: NativeInteractionOwner,
    input: Omit<NativePermissionRequest, 'id' | 'createdAt'>,
    signal: AbortSignal,
  ): Promise<NativePermissionDecision> {
    if (!input.actions?.length)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The native request supplied no usable actions. No user decision was supplied.',
        false,
      )
    const details = nativeApprovalDetailsSchema.parse({
      kind: 'approval',
      title: input.title,
      detail: input.detail,
      actions: input.actions,
      ...(input.defaultToNo != null ? { defaultToNo: input.defaultToNo } : {}),
    })
    return this.requestNativeInteraction(
      owner,
      { title: 'Native interaction', detail: '', kind: 'approval' },
      signal,
      (reply) => nativePermissionDecisionSchema.parse(reply),
      details,
    )
  }

  readNativeInput(input: NativeInputRead): RpcResult<NativeInteractionDetails> {
    const pending = this.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      !pending.details
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This native input request is no longer active.' },
      }
    return { ok: true, value: pending.details }
  }

  respondNativeInput(input: NativeInputRespond): RpcResult<ConversationPatch> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    const pending = this.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      !pending.details ||
      pending.details.kind === 'approval'
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This native input request is no longer active.' },
      }
    if (pending.details.kind === 'url' && input.action === 'accept')
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Open the native authorization page before consenting.',
        },
      }
    try {
      return {
        ok: true,
        value: pending.settle({
          action: input.action,
          ...(input.values ? { values: input.values } : {}),
        }),
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: error instanceof Error ? error.message : 'Check the native input fields.',
        },
      }
    }
  }

  confirmNativeInputURL(input: NativeInputRead): RpcResult<ConversationPatch> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    const pending = this.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      pending.details?.kind !== 'url'
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'This native authorization request is no longer active.',
        },
      }
    try {
      return { ok: true, value: pending.settle({ action: 'accept' }) }
    } catch {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message:
            'The browser consent could not be recorded. Native authorization was not confirmed.',
        },
      }
    }
  }

  private requestNativeUserInput(
    owner: NativeInteractionOwner,
    input: NativeUserInputRequest,
    signal: AbortSignal,
  ): Promise<NativeUserInputResult> {
    if (
      owner.valid() &&
      input.nativeSessionId &&
      !this.conversations.nativeContext(owner.sessionId, owner.agentId)
    ) {
      const execution = this.activeExecutions.get(owner.sessionId)
      if (execution?.run.id === owner.id)
        this.publish(
          this.conversations.applyEvent(owner.sessionId, owner.id, {
            type: 'session.started',
            agentId: owner.agentId,
            nativeSessionId: input.nativeSessionId,
          }),
        )
    }
    const details = nativeInputDetailsSchema.parse({
      kind: input.kind,
      title: input.title,
      message: input.message,
      fields: input.fields,
      ...(input.url ? { url: input.url } : {}),
    })
    if (details.kind === 'url') {
      const url = new URL(details.url ?? '')
      if (
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password
      )
        throw new Error(
          'The native authorization URL uses an unsupported or credential-bearing address.',
        )
    }
    const validateForm = input.requestedSchema
      ? compileNativeFormValidator(input.requestedSchema)
      : undefined
    return this.requestNativeInteraction(
      owner,
      {
        kind: details.kind,
        title: 'Native user input',
        detail:
          details.kind === 'url'
            ? 'Open the native authorization page to continue.'
            : 'The native Agent or MCP server needs your input.',
      },
      signal,
      (reply) => {
        if (typeof reply === 'string')
          throw new Error('This request needs input, not permission approval.')
        if (reply.action !== 'accept') return { action: reply.action }
        const values = nativeInputValuesSchema.parse(reply.values ?? {})
        if (!validateNativeInputValues(details.fields, values))
          throw new Error(
            'Complete the required fields using the provided answer types and choices.',
          )
        if (validateForm && !validateForm(values))
          throw new Error(
            'The input does not match the native form requirements. Check the fields and try again.',
          )
        return { action: 'accept', values }
      },
      details,
    )
  }

  private requestNativeInteraction<T extends NativePermissionDecision | NativeUserInputResult>(
    owner: NativeInteractionOwner,
    input: Omit<NativePermissionRequest, 'id' | 'createdAt'>,
    signal: AbortSignal,
    validate: (reply: NativePermissionDecision | NativeUserInputResult) => T,
    details?: NativeInteractionDetails,
  ): Promise<T> {
    const bindingGeneration =
      owner.bindingGeneration ?? this.conversations.findRun(owner.id)?.bindingGeneration ?? 1
    const pendingOwner = {
      operationId: owner.id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      bindingGeneration,
      executorId: owner.executorId,
      visible: true,
      valid: () => owner.valid() && !signal.aborted,
    }
    if (!this.interactionCurrent(pendingOwner))
      throw new RunOperationConflictError(
        'The native request owner is no longer available. No user decision was supplied.',
      )
    if (this.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Native interaction capacity is occupied. No user decision was supplied.',
        false,
      )
    const request = nativePermissionRequestSchema.parse({
      ...input,
      operationId: owner.id,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    const current = this.activeExecutions.get(owner.sessionId)
    if (current?.run.id === owner.id) current.streamBuffer?.flush()
    const result = Promise.withResolvers<T>()
    let settled = false
    const requests = (): NativePermissionRequest[] =>
      [...this.permissions.values()]
        .filter(
          (pending) =>
            pending.sessionId === owner.sessionId &&
            pending.agentId === owner.agentId &&
            this.interactionCurrent(pending),
        )
        .map((pending) => pending.request)
    const scope = () => {
      const pending = this.permissions.get(request.id) ?? pendingOwner
      return {
        bindingGeneration,
        // A native abort expires the request but may still clear its own
        // projection; it cannot clear a different binding or retired owner.
        projectionAllowed: this.interactionCurrent({ ...pending, valid: () => true }),
      }
    }
    const withdraw = (source: 'expired' | 'aborted'): void => {
      if (settled) return
      try {
        const patch = this.conversations.recordContextPermissions(
          owner.sessionId,
          owner.agentId,
          owner.id,
          requests().filter((item) => item.id !== request.id),
          { permissionId: request.id, source },
          scope(),
        )
        settled = true
        this.permissions.delete(request.id)
        this.publish(patch)
      } catch {
        settled = true
        this.permissions.delete(request.id)
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        result.reject(
          new AgentExecutionError(
            'runtime_incompatible',
            source === 'expired'
              ? 'The native interaction expired without a user decision.'
              : 'The native interaction was interrupted without a user decision.',
            false,
          ),
        )
      }
    }
    const abort = (): void => withdraw('aborted')
    const timeout = setTimeout(() => withdraw('expired'), NATIVE_PERMISSION_TIMEOUT_MS)
    const settle = (reply: NativePermissionDecision | NativeUserInputResult): ConversationPatch => {
      if (settled) throw new RunOperationConflictError('The permission request already settled.')
      const decision = validate(reply)
      const action =
        typeof decision === 'string' && details?.kind === 'approval'
          ? details.actions.find((item) => item.id === decision)
          : undefined
      // Approval cannot reach the provider before its audit is committed.
      const patch = this.conversations.recordContextPermissions(
        owner.sessionId,
        owner.agentId,
        owner.id,
        requests().filter((item) => item.id !== request.id),
        {
          permissionId: request.id,
          source: 'user',
          decision:
            typeof decision === 'string'
              ? action?.kind === 'allow' || action?.kind === 'rule'
                ? 'accept'
                : action?.kind === 'decline'
                  ? 'decline'
                  : 'cancel'
              : decision.action,
          ...(action ? { actionId: action.id, actionKind: action.kind } : {}),
        },
        scope(),
      )
      settled = true
      this.permissions.delete(request.id)
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      this.publish(patch)
      result.resolve(decision)
      return patch
    }
    this.permissions.set(request.id, {
      operationId: owner.id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      bindingGeneration,
      ...(owner.executorId ? { executorId: owner.executorId } : {}),
      visible: true,
      valid: () => owner.valid() && !signal.aborted,
      request,
      ...(details ? { details } : {}),
      settle,
      withdraw,
    })
    try {
      this.publish(
        this.conversations.recordContextPermissions(
          owner.sessionId,
          owner.agentId,
          owner.id,
          requests(),
          undefined,
          scope(),
        ),
      )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    } catch (error) {
      clearTimeout(timeout)
      this.permissions.delete(request.id)
      signal.removeEventListener('abort', abort)
      result.reject(error)
    }
    return result.promise
  }

  readWorkspaceChanges(input: WorkspaceChangesReadInput): RpcResult<WorkspaceChangesPage> {
    try {
      if (!this.workspaceChanges) throw new Error('Protected file changes are unavailable.')
      return { ok: true, value: this.workspaceChanges.readPage(input) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  async readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>> {
    try {
      if (!this.workspaceChanges) throw new Error('Protected file changes are unavailable.')
      return { ok: true, value: await this.workspaceChanges.readFile(input) }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  async undoWorkspaceChanges(
    input: WorkspaceChangesUndoInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    try {
      if (!this.workspaceChanges || this.disposed) throw new Error('Protected Undo is unavailable.')
      const summary = await this.workspaceChanges.undo(input.changeSetId, (projectId) =>
        this.projectHasNativeWork(projectId),
      )
      const patch = this.conversations.recordWorkspaceChanges(summary)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      const run = this.conversations.findRun(input.changeSetId)
      const summary = this.workspaceChanges?.summary(input.changeSetId)
      if (run && summary?.state === 'recovery_required')
        this.publish(this.conversations.recordWorkspaceChanges(summary))
      return Conversation.sendFailure(error)
    }
  }

  private projectHasNativeWork(projectId: string): boolean {
    if (this.conversations.projectHasNativeWork(projectId)) return true
    const belongs = (sessionId: string): boolean =>
      this.sessions.find(sessionId)?.projectId === projectId
    return (
      [...this.preparingSends.values()].some((entry) => belongs(entry.input.sessionId)) ||
      [...this.preparingContinuations.values()].some((entry) => belongs(entry.sessionId)) ||
      [...this.activeExecutions.values()].some((entry) => belongs(entry.run.sessionId)) ||
      [...this.nativeRebuilds.keys()].some(belongs) ||
      [...this.adapters.values()].some(
        (entry) => belongs(entry.sessionId) && entry.adapter.hasActiveBackgroundWork?.(),
      )
    )
  }

  private enqueueSend(
    input: ConversationSendInput,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Promise.resolve(Conversation.shuttingDown())
    if (this.nativeQuitSealed()) return Promise.resolve(Conversation.quitPrepared())
    if (this.conversations.archives.blocksSession(input.sessionId))
      return Promise.resolve(Conversation.archiveBusy())
    if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return Promise.resolve(Conversation.nativeRecoveryRequired())
    if (
      this.conversations
        .nativeContexts(input.sessionId)
        .some(
          (context) =>
            context.continuationState === 'responding' ||
            context.continuationState === 'waiting_user',
        )
    )
      return Promise.resolve(Conversation.capacityFailure())
    if (this.conversations.hasPendingRoutedContinuation(input.sessionId))
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Wait for or stop the remaining @all response before sending another message.',
        },
      })
    const preparing = this.preparingSends.get(input.clientMessageId)
    if (preparing) {
      const prior = preparing.input
      const identical =
        prior.sessionId === input.sessionId &&
        prior.content === input.content &&
        JSON.stringify(prior.imageIds ?? []) === JSON.stringify(input.imageIds ?? []) &&
        JSON.stringify(prior.skills ?? []) === JSON.stringify(input.skills ?? []) &&
        JSON.stringify(prior.route) === JSON.stringify(input.route) &&
        prior.commentIds.length === input.commentIds.length &&
        prior.commentIds.every((id, index) => id === input.commentIds[index]) &&
        preparing.options.sourceProposalId === options.sourceProposalId
      return identical
        ? preparing.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'This message ID already has different content.' },
          })
    }
    try {
      const existing = this.conversations.submittedRunReceipt(input)
      if (existing) {
        this.publish(existing.patch)
        return Promise.resolve({ ok: true, value: existing.patch })
      }
    } catch (error) {
      return Promise.resolve(Conversation.sendFailure(error))
    }
    if (this.hasSessionOperation(input.sessionId)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: this.hasSessionOperation(input.sessionId, false)
            ? 'This Session already has an active operation.'
            : 'Native work from the previous task has not finished or could not be confirmed. Your draft was not sent.',
        },
      })
    }
    if (this.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())

    const controller = new AbortController()
    const task = Promise.resolve().then(() => this.sendAdmitted(input, controller, options))
    const entry: PreparingSend = { input, options, controller, task }
    this.preparingSends.set(input.clientMessageId, entry)
    this.workspaceChanges?.cancelUndoForNativeSession(input.sessionId)
    const release = (): void => {
      if (this.preparingSends.get(input.clientMessageId) === entry)
        this.preparingSends.delete(input.clientMessageId)
      if (!this.disposed) this.publish(this.conversations.metadataPatch(input.sessionId))
      this.schedulePendingRoutedContinuations()
    }
    void task.then(release, release)
    return task
  }

  async actOnCollaboration(input: CollaborationActionInput): Promise<RpcResult<ConversationPatch>> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.conversations.archives.blocksSession(input.sessionId))
      return Conversation.archiveBusy()
    try {
      const context = this.sessions.find(input.sessionId)
      const task = this.conversations.collaboration(input.sessionId)
      if (!context || !task || task.id !== input.taskId || task.revision !== input.revision)
        throw new RunOperationConflictError('This collaboration action is no longer current.')
      if (input.action === 'resume_input' || input.action === 'cancel_input') {
        const received = this.conversations.receivedCollaborationInput(input.sessionId)
        if (!received || received.id !== input.receivedInputId)
          throw new RunOperationConflictError('This received input is no longer current.')
        if (input.action === 'resume_input' && task.status === 'paused') {
          const resumed = advanceCollaboration(task, 'resume', context.settings)
          this.conversations.setCollaborationState(resumed)
        }
        const patch = this.conversations.setReceivedInputState(
          input.sessionId,
          input.action === 'cancel_input' ? 'cancelled' : 'accepted',
          received.id,
        )
        this.publish(patch)
        this.schedulePendingRoutedContinuations()
        return { ok: true, value: patch }
      }
      if (
        this.conversations.receivedCollaborationInput(input.sessionId) &&
        input.action !== 'pause'
      )
        throw new RunOperationConflictError(
          'Handle the received user message before continuing this Proposal.',
        )
      if (input.action === 'resume') {
        const resumed = advanceCollaboration(task, 'resume', context.settings)
        const patch = this.conversations.setCollaborationState(resumed)
        this.publish(patch)
        return { ok: true, value: patch }
      }
      if (input.action === 'pause') {
        this.conversations.setReceivedInputState(input.sessionId, 'cancelled')
        const patch = this.conversations.pauseCollaboration(input.sessionId)
        this.publish(patch)
        return { ok: true, value: patch }
      }
      if (
        this.conversations.findRun(task.runId)?.failureKind === 'unknown_delivery' &&
        this.conversations.findRun(task.runId)?.dispatchPhase !== 'ended'
      )
        throw new RunOperationConflictError(
          'Resolve uncertain delivery before continuing this task.',
        )
      const next = advanceCollaboration(task, input.action, context.settings)
      if (input.action === 'submit_report') {
        const sourceRunId = task.reportRecovery?.sourceRunId ?? task.runId
        const sourceMessageId = task.reportRecovery?.sourceMessageId ?? task.sourceMessageId
        const sourceRun = this.conversations.findRun(sourceRunId)
        const metadata = sourceMessageId
          ? this.conversations.messageMetadata(sourceMessageId, task.sessionId)
          : undefined
        if (
          !sourceMessageId ||
          !metadata?.contentBytes ||
          sourceRun?.dispatchPhase !== 'ended' ||
          sourceRun.nativeOutcome !== 'completed' ||
          sourceRun.collaboration?.taskId !== task.id ||
          sourceRun.agentId !== next.actor
        )
          throw new RunOperationConflictError(
            'Only the original Agent can submit a report for its completed answer.',
          )
        next.reportRecovery = {
          ...next.reportRecovery,
          sourceRunId,
          sourceMessageId,
          sourceContentRevision:
            task.reportRecovery?.sourceContentRevision ?? metadata.contentRevision,
        }
      }
      const drafts = this.conversations.readPage({ scope: 'drafts', sessionId: input.sessionId })
      if (drafts.scope !== 'drafts')
        throw new RunOperationConflictError('Comment drafts are unavailable.')
      const labels = {
        draft: 'Draft the plan',
        discuss:
          collaborationSubmission(next) === 'plan_submission'
            ? 'Update the current plan using the feedback'
            : 'Review the current plan and feedback',
        clarify: 'Clarify the pending questions',
        implement: `Implement plan v${task.planVersion}`,
        review: 'Review the current implementation',
        respond: 'Respond to the Review opinions without editing code',
        repair: 'Repair the Review opinions within this task',
        supplement: 'Handle the received user message without editing code',
      }
      const request =
        input.action === 'submit_report'
          ? `${task.reportFailure === 'invalid' ? 'Correct and submit' : 'Submit'} the ${collaborationSubmission(next) === 'plan_submission' ? 'plan' : 'review'} from your previous completed response`
          : labels[next.stage]
      // Native adapters add the frozen report contract separately on every Turn.
      const content = `@${next.actor} ${request}.`
      return this.enqueueSend(
        {
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          content,
          route: { type: 'agent', agentId: next.actor },
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
        },
        { preserveDraftComments: true, collaboration: next },
      )
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Promise.resolve(Conversation.shuttingDown())
    if (this.nativeQuitSealed()) return Promise.resolve(Conversation.quitPrepared())
    if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return Promise.resolve(Conversation.nativeRecoveryRequired())
    const proposal = this.conversations.peerProposal(input.sessionId, input.proposalId)
    if (!proposal?.run.peerProposal || proposal.run.peerProposal.state !== 'pending')
      return Promise.resolve({
        ok: false,
        error: { code: 'CONFLICT', message: 'This peer request is no longer available.' },
      })
    const targetAgentId = proposal.run.peerProposal.targetAgentId
    const target = targetAgentId === 'claude' ? 'claude' : 'codex'
    const source = proposal.run.agentId === 'claude' ? 'Claude Code' : 'Codex'
    const action = Conversation.peerActionCopy(proposal.run.peerProposal.kind, source)
    const drafts = this.conversations.readPage({ scope: 'drafts', sessionId: input.sessionId })
    if (drafts.scope !== 'drafts')
      return Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'Comment drafts are unavailable.' },
      })
    return this.enqueueSend(
      {
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        content: `@${target} ${action}`,
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: targetAgentId },
      },
      {
        preserveDraftComments: true,
        sourceProposalId: input.proposalId,
        sourceMessageId: proposal.sourceMessageId,
      },
    )
  }

  dismissPeerProposal(input: PeerProposalDismissInput): RpcResult<ConversationPatch> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return Conversation.nativeRecoveryRequired()
    try {
      const patch = this.conversations.dismissPeerProposal(input.sessionId, input.proposalId)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof RunOperationConflictError ? 'CONFLICT' : 'INTERNAL',
          message:
            error instanceof Error ? error.message : 'The peer request could not be dismissed.',
        },
      }
    }
  }

  cancelSkillCatalog(sessionId: string): void {
    for (const owner of this.skillDiscoveries.values()) {
      if (owner.sessionId === sessionId)
        for (const reader of owner.readers)
          if (!reader.reserved && !reader.documentRead) reader.cancel()
    }
  }

  cancelSkillDocument(requestId: string): void {
    if (this.skillDocumentOwner?.requestId === requestId) this.skillDocumentOwner.controller.abort()
  }

  async readSkillDocument(input: SkillDocumentRead): Promise<RpcResult<SkillDocument>> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.disposed || this.skillDocumentOwner)
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'The previous document read is still settling. Try again shortly.',
        },
      }
    const controller = new AbortController()
    const cancelled = Promise.withResolvers<RpcResult<SkillDocument>>()
    const abort = (): void =>
      cancelled.resolve({
        ok: false,
        error: { code: 'TIMEOUT', message: 'Skill document reading was cancelled or timed out.' },
      })
    controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), 10_000)
    const task = (async (): Promise<RpcResult<SkillDocument>> => {
      const catalog = await this.skillBindings(
        input.sessionId,
        input.agentId,
        controller.signal,
        false,
        false,
        true,
      )
      controller.signal.throwIfAborted()
      const binding = catalog.find((entry) => entry.id === input.skillId)
      if (!binding)
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'This Skill changed in its native catalog. Select it again.',
          },
        }
      if (!binding.path)
        return {
          ok: true,
          value: skillDocumentSchema.parse({
            status: 'unavailable',
            agentId: input.agentId,
            skillId: input.skillId,
            name: binding.name,
            reason: 'native_document_not_exposed',
            description: binding.description,
            argumentHint: binding.argumentHint,
          }),
        }
      if (!isAbsolute(binding.path) || basename(binding.path).toLowerCase() !== 'skill.md')
        return {
          ok: false,
          error: {
            code: 'VALIDATION',
            message: 'The native runtime did not provide a valid SKILL.md path.',
          },
        }
      const file = await this.projectFiles.read({ sessionId: input.sessionId, path: binding.path })
      controller.signal.throwIfAborted()
      if (!file.ok) return file
      return {
        ok: true,
        value: skillDocumentSchema.parse({
          status: 'available',
          agentId: input.agentId,
          skillId: input.skillId,
          name: binding.name,
          content: file.value.content,
          contentHash: file.value.contentHash,
          updatedAt: file.value.updatedAt,
        }),
      }
    })()
      .catch((): RpcResult<SkillDocument> => ({
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'The native Skill document could not be read.',
        },
      }))
      .finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (this.skillDocumentOwner?.requestId === input.requestId)
          this.skillDocumentOwner = undefined
      })
    // Logical cancellation never releases a still-active filesystem read's physical capacity.
    this.skillDocumentOwner = { requestId: input.requestId, controller, task }
    return Promise.race([task, cancelled.promise])
  }

  async readSkillCatalog(input: SkillCatalogRead): Promise<RpcResult<SkillCatalogPage>> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    try {
      const entries = await this.skillBindings(
        input.sessionId,
        input.agentId,
        undefined,
        input.refresh,
      )
      const snapshot = this.skillCatalogs.get(`${input.sessionId}:${input.agentId}`)!
      if (input.generation && input.generation !== snapshot.generation)
        return {
          ok: false,
          error: { code: 'CONFLICT', message: 'The native Skill catalog changed. Search again.' },
        }
      const query = input.query.toLocaleLowerCase()
      const names = input.names ? new Set(input.names) : undefined
      const filtered = entries.filter((entry) =>
        names
          ? names.has(entry.name)
          : `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(query),
      )
      const page: SkillCatalogPage = {
        agentId: input.agentId,
        generation: snapshot.generation,
        checkedAt: snapshot.checkedAt,
        skills: [],
        total: filtered.length,
        nextOffset: null,
      }
      for (const entry of filtered.slice(input.offset, input.offset + SKILL_PAGE_ITEMS)) {
        const { path: _path, ...projection } = entry
        page.skills.push(projection)
        if (Buffer.byteLength(JSON.stringify(page)) > SKILL_PAGE_BYTES - 128) {
          page.skills.pop()
          break
        }
      }
      if (input.offset + page.skills.length < filtered.length)
        page.nextOffset = input.offset + page.skills.length
      return { ok: true, value: skillCatalogPageSchema.parse(page) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message:
            error instanceof RunOperationConflictError
              ? error.message
              : 'Native Skill discovery is unavailable. Open / again to refresh its catalog.',
        },
      }
    }
  }

  private async skillBindings(
    sessionId: string,
    agentId: RuntimeAgentId,
    signal?: AbortSignal,
    refresh = false,
    reserved = false,
    documentRead = false,
  ): Promise<SkillBinding[]> {
    const key = `${sessionId}:${agentId}`
    signal?.throwIfAborted()
    const existing = this.skillDiscoveries.get(key)
    if (existing) {
      if (refresh && existing.usedCache) {
        await this.waitForSkillDiscovery(key, existing, signal, reserved, documentRead)
        return this.skillBindings(sessionId, agentId, signal, true, reserved, documentRead)
      }
      if (refresh) existing.refresh = true
      return this.waitForSkillDiscovery(key, existing, signal, reserved, documentRead)
    }
    if (
      this.skillDiscoveries.size >= 2 ||
      (!reserved && this.operationCount() >= MAX_AGENT_OPERATIONS)
    )
      throw new Error('Native Skill discovery is busy. Try again when current work settles.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    let currentKey = ''
    const task = (async () => {
      const executablePath = await this.runtimePreparation.findRecoveryExecutable(
        agentId,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      const executable = executablePath ? await realpath(executablePath) : undefined
      controller.signal.throwIfAborted()
      const executableInfo = executable ? await stat(executable) : undefined
      controller.signal.throwIfAborted()
      const executableGeneration = [executable, executableInfo?.size, executableInfo?.mtimeMs]
      const currentSession = this.sessions.find(sessionId)
      const binding = this.conversations.nativeContext(sessionId, agentId)
      const adapterEntry = this.adapters.get(key)
      currentKey = JSON.stringify([
        executableGeneration,
        currentSession?.projectId,
        currentSession?.settingsRevision,
        binding?.bindingGeneration,
        adapterEntry?.executablePath,
        adapterEntry?.cwd,
        adapterEntry?.adapter.executorId,
      ])
      const cached = this.skillCatalogs.get(key)
      if (
        !this.skillDiscoveries.get(key)?.refresh &&
        cached &&
        cached.key === currentKey &&
        cached.expiresAt > Date.now()
      ) {
        if (cached.failure)
          throw new Error('Native Skill discovery is temporarily unavailable. Try again shortly.')
        const owner = this.skillDiscoveries.get(key)
        if (owner) owner.usedCache = true
        return cached.entries
      }

      const context = await this.prepareSession(sessionId, controller.signal)
      if (!context.ok) throw new Error(context.error.message)
      const adapter = await this.adapterFor(
        sessionId,
        agentId,
        context.value.executablePaths[agentId],
        controller.signal,
        context.value.projectDirectory,
      )
      if (!adapter.discoverSkills) throw new Error('This runtime cannot discover native Skills.')
      const entries = await adapter.discoverSkills(
        context.value.projectDirectory,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      if (this.skillDiscoveries.get(key)?.invalidated)
        throw new Error('The native Skill catalog changed during discovery.')
      const refreshedKey = JSON.stringify([
        executableGeneration,
        currentSession?.projectId,
        currentSession?.settingsRevision,
        binding?.bindingGeneration,
        context.value.executablePaths[agentId],
        context.value.projectDirectory,
        adapter.executorId,
      ])
      // A verified identical refresh must not invalidate an open reader's pagination token.
      // Native invalidation, environment changes or any effective binding change still replace it.
      const unchanged =
        cached &&
        !cached.failure &&
        this.skillCatalogs.get(key) === cached &&
        cached.key === refreshedKey &&
        cached.entries.length === entries.length &&
        cached.entries.every((entry, index) => entry.id === entries[index]?.id)
      this.skillCatalogs.delete(key)
      while (this.skillCatalogs.size >= 4)
        this.skillCatalogs.delete(this.skillCatalogs.keys().next().value!)
      this.skillCatalogs.set(key, {
        key: refreshedKey,
        generation: unchanged ? cached.generation : randomUUID(),
        checkedAt: new Date().toISOString(),
        expiresAt: Date.now() + 30_000,
        entries,
      })
      return entries
    })()
      .catch((error: unknown) => {
        while (this.skillCatalogs.size >= 4 && !this.skillCatalogs.has(key))
          this.skillCatalogs.delete(this.skillCatalogs.keys().next().value!)
        if (!controller.signal.aborted && !this.disposed)
          this.skillCatalogs.set(key, {
            generation: randomUUID(),
            key: currentKey,
            checkedAt: new Date().toISOString(),
            expiresAt: Date.now() + 5_000,
            entries: [],
            failure: true,
          })
        throw error
      })
      .finally(() => {
        clearTimeout(timer)
        this.skillDiscoveries.delete(key)
      })
    const owner = {
      sessionId,
      agentId,
      controller,
      refresh,
      readers: new Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>(),
      task,
    }
    this.skillDiscoveries.set(key, owner)
    controller.signal.addEventListener(
      'abort',
      () => {
        for (const reader of owner.readers) reader.cancel()
      },
      { once: true },
    )
    return this.waitForSkillDiscovery(key, owner, signal, reserved, documentRead)
  }

  private waitForSkillDiscovery(
    key: string,
    owner: {
      controller: AbortController
      readers: Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>
      task: Promise<SkillBinding[]>
    },
    signal: AbortSignal | undefined,
    reserved: boolean,
    documentRead = false,
  ): Promise<SkillBinding[]> {
    if (owner.controller.signal.aborted)
      return Promise.reject(
        new Error(
          'The native Skill reader is still releasing its previous actor. Try again after it settles.',
        ),
      )
    if (owner.readers.size >= 4)
      return Promise.reject(
        new Error('Too many readers are waiting for this native Skill catalog.'),
      )
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: SkillBinding[]): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', reader.cancel)
        owner.readers.delete(reader)
        if (!owner.readers.size && this.skillDiscoveries.get(key) === owner)
          owner.controller.abort()
        if (error) reject(error)
        else resolve(value!)
      }
      const reader = {
        reserved,
        documentRead,
        cancel: () => finish(new Error('Native Skill reading was cancelled.')),
      }
      owner.readers.add(reader)
      signal?.addEventListener('abort', reader.cancel, { once: true })
      if (signal?.aborted || owner.controller.signal.aborted) reader.cancel()
      void owner.task.then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error),
      )
    })
  }

  private async prepareSkillInvocation(
    input: ConversationSendInput,
    targets: RuntimeAgentId[],
    signal: AbortSignal,
  ): Promise<FrozenSkillInvocation | undefined> {
    const prefix = parseComposerCommandPrefix(input.content, input.skills)
    if (prefix.error) throw new RunOperationConflictError(prefix.error)
    const selections = input.skills ?? []
    const names = [
      ...new Set([
        ...prefix.skills.map((entry) => entry.name),
        ...selections.map((entry) => entry.name),
      ]),
    ]
    if (!names.length) return undefined
    for (const selection of selections) {
      if (input.content.slice(selection.start, selection.end) !== `/${selection.name}`)
        throw new RunOperationConflictError('The selected Skill token changed. Select it again.')
      if (!targets.includes(selection.agentId))
        throw new RunOperationConflictError(
          `/${selection.name} belongs to ${selection.agentId === 'claude' ? 'Claude Code' : 'Codex'}, not the message target.`,
        )
    }
    const bindings: SkillBinding[] = []
    for (const target of targets) {
      // Serial cold reads respect the shared finite Native-operation capacity.
      // oxlint-disable-next-line no-await-in-loop -- The routed Send reuses one reservation for serial Native preparation.
      const catalog = await this.skillBindings(input.sessionId, target, signal, true, true)
      for (const name of names) {
        const entry = catalog.find((candidate) => candidate.name === name)
        if (!entry)
          throw new RunOperationConflictError(
            `/${name} is unavailable for ${target === 'claude' ? 'Claude Code' : 'Codex'}.`,
          )
        if (
          selections.some(
            (item) => item.name === name && item.agentId === target && item.id !== entry.id,
          )
        )
          throw new RunOperationConflictError(
            `/${name} changed in its native catalog. Select it again.`,
          )
        bindings.push(entry)
      }
    }
    return frozenSkillInvocationSchema.parse({
      version: 'pact-skills-v1',
      arguments: skillArguments(input.content, selections),
      selections,
      bindings,
    })
  }

  private async sendAdmitted(
    input: ConversationSendInput,
    controller: AbortController,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    const cancelled = Promise.withResolvers<RpcResult<PreparedSession>>()
    const onAbort = (): void => {
      cancelled.resolve({
        ok: false,
        error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
      })
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
    const timeout = setTimeout(() => controller.abort(), PREPARATION_TIMEOUT_MS)
    try {
      const context = await Promise.race([
        this.prepareSession(input.sessionId, controller.signal),
        cancelled.promise,
      ])
      if (this.disposed) return Conversation.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      if (!context.ok) return context
      const commandPrefix = parseComposerCommandPrefix(input.content, input.skills)
      if (commandPrefix.error) throw new RunOperationConflictError(commandPrefix.error)
      if (commandPrefix.pact && this.conversations.receivedCollaborationInput(input.sessionId))
        throw new RunOperationConflictError(
          'Handle or cancel the received input before starting a new Pact task.',
        )
      const requestedRoute = input.route ?? commandPrefix.route
      const primaryAgentId = context.value.session.settings.primaryAgentId
      const secondaryAgentId: RuntimeAgentId = primaryAgentId === 'claude' ? 'codex' : 'claude'
      let route: ConversationMessageRoute =
        requestedRoute?.type === 'agent'
          ? { type: 'agent', agentId: requestedRoute.agentId }
          : requestedRoute?.type === 'all'
            ? {
                type: 'all',
                firstAgentId: primaryAgentId,
                secondAgentId: secondaryAgentId,
              }
            : {
                type: 'primary',
                agentId:
                  options.collaboration && !commandPrefix.pact
                    ? this.conversations.collaborationAnswerResolver(options.collaboration)
                    : primaryAgentId,
              }
      if (input.returnedInputOperationId) {
        const original = this.conversations.returnedInputRoute(
          input.sessionId,
          input.returnedInputOperationId,
        )
        if (!input.route) route = original
      }
      const targets =
        route.type === 'all' ? [route.firstAgentId, route.secondAgentId] : [route.agentId]
      const agentId = targets[0]!
      const skillInvocation = await this.prepareSkillInvocation(input, targets, controller.signal)
      const agentSettings = context.value.session.settings.agents[agentId]
      // A saved, evidence-backed ready binding does not need a new startup probe.
      for (const target of targets) {
        const binding = this.conversations.nativeContext(input.sessionId, target)
        if (binding && binding.continuationState !== 'ready')
          return Conversation.nativeRecoveryRequired()
      }
      const preparing = this.preparingSends.get(input.clientMessageId)
      if (preparing?.controller === controller) preparing.protectedAgentId = agentId
      const adapter = await this.adapterFor(
        input.sessionId,
        agentId,
        context.value.executablePaths[agentId],
        controller.signal,
        context.value.projectDirectory,
      )
      const nativeContext = this.conversations.nativeContext(input.sessionId, agentId)
      const handoff = await this.collectHandoff(input.sessionId, agentId, controller.signal)
      if (this.disposed) return Conversation.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      // The Repository freezes every draft member atomically at the expected revision.
      // The prompt carries only the resulting Batch reference; no mounted-page IDs limit delivery.
      const drafts: AnchoredComment[] = []
      const prompt = this.promptEnvelope(
        input.sessionId,
        { id: input.clientMessageId, content: input.content },
        drafts,
        handoff,
        this.conversations.resolveMessageImages(
          input.sessionId,
          input.imageIds ?? [],
          options.imageOwnerKey,
        ),
        options.imageOwnerKey,
      )
      let collaboration = options.collaboration
      if (!collaboration && commandPrefix.pact) {
        const kind = commandPrefix.pact
        const task =
          input.content.slice(commandPrefix.argumentsStart).trim() ||
          'Use the explicit conversation context if it establishes the task. Otherwise ask at most three material questions before proceeding. No implementation scope is authorized until clarified.'
        const implementer =
          kind === 'plan' ? secondaryAgentId : kind === 'build' ? agentId : otherAgent(agentId)
        collaboration = collaborationTaskSchema.parse({
          id: randomUUID(),
          sessionId: input.sessionId,
          kind,
          revision: 0,
          primary: primaryAgentId,
          drafter: agentId,
          implementer,
          reviewer: kind === 'plan' ? primaryAgentId : otherAgent(implementer),
          task:
            Buffer.byteLength(task, 'utf8') <= 8000
              ? task
              : 'Use the complete original task message.',
          taskMessageId: input.clientMessageId,
          stage:
            kind === 'plan'
              ? 'draft'
              : kind === 'build'
                ? input.content.slice(commandPrefix.argumentsStart).trim()
                  ? 'implement'
                  : 'clarify'
                : 'review',
          ...(!input.content.slice(commandPrefix.argumentsStart).trim() && kind === 'build'
            ? {
                resumePhase: {
                  stage: 'implement',
                  actor: agentId,
                  status: 'waiting',
                  unstarted: true,
                },
              }
            : {}),
          actor: agentId,
          status: 'running',
          runId: input.clientMessageId,
          planVersion: 0,
          discussionRounds: 0,
          discussionHalf: false,
          reviewCycles: kind === 'review' ? 1 : 0,
          repairAttempts: 0,
          rereview: false,
          nextCycle: false,
        })
      }
      if (collaboration) {
        prompt.collaboration = this.conversations.collaborationPromptState(collaboration)
        prompt.collaborationBasis = await this.collaborationBasis(
          prompt.collaboration,
          prompt.message.id,
          controller.signal,
        )
      }
      if (skillInvocation) {
        prompt.skillInvocation = skillInvocation
        prompt.targetAgentId = agentId
      }
      if (Buffer.byteLength(serializeAgentPromptEnvelope(prompt), 'utf8') > HANDOFF_SAFETY_BYTES)
        throw new HandoffTooLargeError('The Agent context is too large to send safely.')
      if (!collaboration)
        adapter.preflightPrompt?.({
          runId: input.clientMessageId,
          sessionId: input.sessionId,
          ...(nativeContext ? { nativeSessionId: nativeContext.nativeSessionId } : {}),
          peerAssistanceAllowed: route.type !== 'all',
          cwd: context.value.projectDirectory,
          promptEnvelope: prompt,
          ...(collaboration ? { answerFormat: 'collaboration_envelope_v5' as const } : {}),
          model: agentSettings.model,
          effort: agentSettings.effort,
        })
      if (this.disposed) return Conversation.shuttingDown()
      if (controller.signal.aborted)
        return {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Agent preparation took too long. Try again.' },
        }
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()
      if (
        this.conversations
          .nativeContexts(input.sessionId)
          .some(
            (binding) =>
              binding.continuationState === 'responding' ||
              binding.continuationState === 'waiting_user',
          )
      )
        return Conversation.capacityFailure()
      for (const target of targets) {
        const binding = this.conversations.nativeContext(input.sessionId, target)
        if (binding && binding.continuationState !== 'ready')
          return Conversation.nativeRecoveryRequired()
      }
      const binding = this.conversations.nativeContext(input.sessionId, agentId)
      if (
        binding?.bindingGeneration !== nativeContext?.bindingGeneration ||
        binding?.nativeSessionId !== nativeContext?.nativeSessionId
      )
        throw new RunOperationConflictError(
          'The native binding changed during message preparation.',
        )
      const started = this.conversations.beginRun({
        ...(options.receivedInputId ? { receivedInputId: options.receivedInputId } : {}),
        ...(collaboration ? { collaboration } : {}),
        ...(skillInvocation ? { skillInvocation } : {}),
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        ...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
        ...(options.imageOwnerKey ? { imageOwnerKey: options.imageOwnerKey } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.returnedInputOperationId
          ? { returnedInputOperationId: input.returnedInputOperationId }
          : {}),
        expectedCommentsRevision: input.expectedCommentsRevision,
        commentIds: input.commentIds,
        freezeDrafts: input.freezeDrafts ?? !options.preserveDraftComments,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        agentId,
        settingsRevision: context.value.session.settingsRevision,
        model: agentSettings.model,
        effort: agentSettings.effort,
        route,
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.sourceProposalId ? { sourceProposalId: options.sourceProposalId } : {}),
        ...(options.preserveDraftComments ? { preserveDraftComments: true } : {}),
        handoffSourceRefs: handoff.map((source) =>
          Object.assign(
            {
              id: source.messageId,
              revision: source.contentRevision,
              digest: source.digest,
            },
            source.contextVersion ? { contextVersion: source.contextVersion } : {},
          ),
        ),
        ...(context.value.session.titleSource === 'placeholder'
          ? { suggestedTitle: Conversation.localTitle(input.content) }
          : {}),
      })
      prompt.inputBatchRef = this.conversations.inputBatchForRun(started.run.id) ?? undefined
      if (collaboration) {
        prompt.collaborationAuthorization =
          this.conversations.collaborationTurnAuthorization(started.run.id) ?? undefined
        prompt.requiredInputScopeRef =
          prompt.collaborationAuthorization?.requiredInputScopeRef ?? undefined
      }
      this.publish(started.patch)
      if (started.created) {
        this.cancelTitleEnrichment(input.sessionId)
        void this.execute(
          started.run,
          prompt,
          context.value.projectDirectory,
          context.value.session.settings,
          context.value.executablePaths,
        )
      }
      return { ok: true, value: started.patch }
    } catch (error) {
      return Conversation.sendFailure(error)
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      const entry = this.preparingSends.get(input.clientMessageId)
      if (entry?.controller === controller) this.preparingSends.delete(input.clientMessageId)
    }
  }

  private static sendFailure(error: unknown): RpcResult<never> {
    return {
      ok: false,
      error: {
        code:
          error instanceof WorkspaceChangeError
            ? error.code
            : error instanceof RunOperationConflictError ||
                error instanceof WorkspaceArchiveConflictError
              ? 'CONFLICT'
              : error instanceof HandoffTooLargeError ||
                  error instanceof OversizedConversationEntityError ||
                  (error instanceof AgentExecutionError && error.kind === 'response_too_large')
                ? 'CONTEXT_TOO_LARGE'
                : error instanceof HandoffSourceUnavailableError
                  ? 'CONTEXT_UNAVAILABLE'
                  : 'INTERNAL',
        message: error instanceof Error ? error.message : 'The Run could not be started.',
      },
    }
  }

  private static capacityFailure(): RpcResult<never> {
    return { ok: false, error: { code: 'AGENT_CAPACITY', message: CAPACITY_NOTICE } }
  }

  private operationCount(): number {
    return (
      this.activeExecutions.size +
      this.preparingSends.size +
      this.preparingContinuations.size +
      this.nativeRebuilds.size +
      this.nativeChecks.size +
      this.nativeForks.size +
      [...this.skillDiscoveries.values()].filter(
        (owner) => ![...owner.readers].some((reader) => reader.reserved),
      ).length
    )
  }

  private hasSessionOperation(
    sessionId: string,
    includeBackground = false,
    ignoreFork?: object,
    allowUnresolvedArchive = false,
  ): boolean {
    return (
      this.conversations.archives.blocksSession(sessionId, allowUnresolvedArchive) ||
      [...this.nativeForks.values()].some(
        (owner) =>
          owner !== ignoreFork &&
          (owner.sessionId === sessionId || owner.sourceSessionId === sessionId),
      ) ||
      this.activeExecutions.has(sessionId) ||
      this.preparingContinuations.has(sessionId) ||
      this.nativeRebuilds.has(sessionId) ||
      (includeBackground &&
        [...this.adapters.entries()].some(
          ([key, entry]) =>
            key.startsWith(`${sessionId}:`) && Boolean(entry.adapter.hasActiveBackgroundWork?.()),
        )) ||
      [...this.preparingSends.values()].some((entry) => entry.input.sessionId === sessionId)
    )
  }

  private static nativeRecoveryRequired(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
        message: 'Rebuild the missing Native Session before continuing.',
      },
    }
  }

  private static archiveBusy(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'This item is archived or its archive is still settling. Nothing new was started.',
      },
    }
  }

  stop(input: ConversationStopInput): RpcResult<ConversationPatch> {
    if (this.disposed) return Conversation.shuttingDown()
    try {
      this.conversations.setReceivedInputState(input.sessionId, 'cancelled')
      this.conversations.pauseCollaboration(input.sessionId)
      const execution = this.activeExecutions.get(input.sessionId)
      const continuation = this.preparingContinuations.get(input.sessionId)
      const preparingSend = [...this.preparingSends.values()].find(
        (entry) => entry.input.sessionId === input.sessionId,
      )
      if (execution) {
        // The provider is stopped only after every Delta already accepted by Pact
        // crosses the durable checkpoint. Closing here also clears both timers;
        // late provider events are ignored by the cancellation fence below.
        let streamSaved = true
        try {
          streamSaved = execution.streamBuffer?.dispose() ?? true
        } finally {
          execution.streamBuffer = undefined
          execution.adapter = undefined
          execution.cancelledByUser = true
          execution.abortController.abort()
        }
        if (!streamSaved)
          return {
            ok: false,
            error: {
              code: 'INTERNAL',
              message: 'The response stopped, but its latest output could not be saved.',
            },
          }
        const current = this.conversations.findRun(execution.run.id)
        const patch =
          current && ['starting', 'running', 'recovering'].includes(current.status)
            ? this.conversations.failRun(current.id, 'user_stopped', 'Stopped by the user.', true)
            : this.conversations.cancelPendingRoutedContinuation(input.sessionId)
        this.publish(patch)
        return { ok: true, value: patch }
      }
      if (continuation) continuation.controller.abort()
      if (preparingSend) preparingSend.controller.abort()
      if (
        this.conversations
          .nativeContexts(input.sessionId)
          .some(
            (context) =>
              context.continuationState === 'responding' ||
              context.continuationState === 'waiting_user',
          )
      )
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'Pact has no foreground Stop handle for this native task. Check its state or explicitly rebuild; it was not stopped.',
          },
        }
      const patch = this.conversations.cancelPendingRoutedContinuation(input.sessionId)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof RunOperationConflictError ? 'CONFLICT' : 'INTERNAL',
          message: error instanceof Error ? error.message : 'The Run could not be stopped.',
        },
      }
    }
  }

  async retry(input: ConversationRetryInput): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    const original = this.conversations.findRun(input.runId)
    if (original?.forkSourceRunId)
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Inherited native actions are read-only.' },
      }
    const sessionId = input.sessionId ?? original?.sessionId
    const agentId = input.agentId ?? original?.agentId
    if (!sessionId || !agentId)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'The native binding is unavailable.' },
      }
    const binding = this.conversations.nativeContext(sessionId, agentId)
    if (
      original &&
      (!binding ||
        original.bindingGeneration !== binding.bindingGeneration ||
        original.nativeSessionId !== binding.nativeSessionId)
    )
      return this.inspectPreviousRun(original)
    return this.checkNativeBinding(sessionId, agentId)
  }

  private inspectPreviousRun(run: AgentRun): Promise<RpcResult<ConversationPatch>> {
    const key = `${run.sessionId}:${run.agentId}:${run.id}`
    const pending = this.nativeChecks.get(key)
    if (pending) return pending.task
    if (!run.nativeSessionId)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The previous task has no confirmed native identity. The current binding was not changed.',
        },
      })
    if (
      this.hasSessionOperation(run.sessionId, false, undefined, true) ||
      this.nativeChecks.size >= MAX_AGENT_OPERATIONS
    )
      return Promise.resolve(Conversation.capacityFailure())
    const controller = new AbortController()
    const task = (async (): Promise<RpcResult<ConversationPatch>> => {
      try {
        const session = this.sessions.find(run.sessionId),
          project = session && this.projects.find(session.projectId)
        if (!session || !project) throw new Error('The project is unavailable.')
        const executable = await this.runtimePreparation.findRecoveryExecutable(
          run.agentId,
          controller.signal,
        )
        if (!executable) throw new Error('The native executable is unavailable.')
        const adapter = await this.adapterFor(
          run.sessionId,
          run.agentId,
          executable,
          controller.signal,
          project.directoryPath,
          (acquired) => {
            const owner = this.nativeChecks.get(key)
            if (owner?.controller !== controller || controller.signal.aborted)
              throw new RunOperationConflictError('The native check is no longer current.')
            owner.adapter = acquired
            this.nativeMetadataChanged()
          },
        )
        const evidence = await Conversation.withRecoveryDeadline(
          controller,
          async () =>
            adapter.probeNativeStatus?.(
              {
                sessionId: run.sessionId,
                agentId: run.agentId,
                runId: run.id,
                requestId: run.id,
                nativeSessionId: run.nativeSessionId!,
                bindingGeneration: run.bindingGeneration ?? 1,
                ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
                ...(run.executorId ? { executorId: run.executorId } : {}),
                cwd: project.directoryPath,
                model: run.model,
                effort: run.effort,
              },
              controller.signal,
            ),
          undefined,
        )
        if (!evidence || this.disposed || controller.signal.aborted)
          throw new Error('The previous native result could not be checked.')
        this.publish(this.conversations.recordNativeEvidence(evidence))
        if ('output' in evidence && evidence.output)
          this.publish(
            await this.conversations.recordNativeOutputComplete(
              run.id,
              evidence.output,
              controller.signal,
            ),
          )
        if (evidence.kind === 'ended') {
          this.publish(this.conversations.settleKnownNativeEnding(run.id))
          if (
            evidence.outcome === 'completed' &&
            evidence.output?.completeness === 'complete' &&
            evidence.identity.nativeTurnId
          )
            this.reconcileOwnedCompletedCollaboration(run.id, {
              nativeTurnId: evidence.identity.nativeTurnId,
              source: evidence.source,
              ...(evidence.identity.executorId ? { executorId: evidence.identity.executorId } : {}),
            })
        }
        return evidence.kind === 'ended'
          ? { ok: true, value: this.conversations.contextPatch(run.sessionId) }
          : {
              ok: false,
              error: {
                code: 'CONFLICT',
                message:
                  'The previous native result was not confirmed. The current binding was not changed.',
              },
            }
      } catch {
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'The previous native result could not be checked. The current binding was not changed.',
          },
        }
      } finally {
        const physicalOwner = this.nativeChecks.get(key)
        if (physicalOwner?.controller === controller) physicalOwner.adapter = undefined
        this.nativeChecks.delete(key)
        this.nativeMetadataChanged()
        this.schedulePendingRoutedContinuations()
      }
    })()
    this.nativeChecks.set(key, { controller, task })
    this.nativeMetadataChanged()
    return task
  }

  private checkNativeBinding(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): Promise<RpcResult<ConversationPatch>> {
    const fork = this.conversations.forkOperation(sessionId)
    const forkBinding = this.conversations.nativeContext(sessionId, agentId)
    if (
      fork &&
      !this.conversations.latestAgentRun(sessionId, agentId) &&
      (!forkBinding || forkBinding.bindingGeneration === 1)
    )
      return this.forkSession({ action: 'check', sessionId, operationId: fork.id, agentId }).then(
        (result) =>
          result.ok ? { ok: true, value: this.conversations.metadataPatch(sessionId) } : result,
      )
    const key = `${sessionId}:${agentId}`
    const pending = this.nativeChecks.get(key)
    if (pending) return pending.task
    if (this.hasSessionOperation(sessionId, false, undefined, true))
      return Promise.resolve(Conversation.capacityFailure())
    if (this.nativeChecks.size >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())
    const controller = new AbortController()
    const task = (async (): Promise<RpcResult<ConversationPatch>> => {
      const context = this.conversations.nativeContext(sessionId, agentId)
      const candidate = context?.lastRunId
        ? this.conversations.findRun(context.lastRunId)
        : this.conversations.latestAgentRun(sessionId, agentId)
      const run =
        candidate?.bindingGeneration === context?.bindingGeneration &&
        candidate?.nativeSessionId === context?.nativeSessionId
          ? candidate
          : undefined
      if (!context)
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'No native identity was confirmed. You can create a replacement without reexecuting the task.',
          },
        }
      const generation = context.bindingGeneration ?? 1
      this.publish(
        this.conversations.setContinuation(sessionId, agentId, 'checking', undefined, generation),
      )
      try {
        const session = this.sessions.find(sessionId)
        const project = session && this.projects.find(session.projectId)
        if (!session || !project) throw new Error('The Session project is unavailable.')
        const executable = await this.runtimePreparation.findRecoveryExecutable(
          agentId,
          controller.signal,
        )
        if (executable === undefined)
          throw new AgentExecutionError(
            'runtime_incompatible',
            'The native executable is unavailable. Restore the executable, then Retry.',
            false,
          )
        const adapter = await this.adapterFor(
          sessionId,
          agentId,
          executable,
          controller.signal,
          project.directoryPath,
          (acquired) => {
            const owner = this.nativeChecks.get(key)
            if (owner?.controller !== controller || controller.signal.aborted)
              throw new RunOperationConflictError('The native check is no longer current.')
            owner.adapter = acquired
            this.nativeMetadataChanged()
          },
        )
        const observeCheckedTitle = (nativeSessionId: string, logicalTitle?: string): void => {
          const current = this.conversations.nativeContext(sessionId, agentId)
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.adapters.get(key)?.adapter !== adapter ||
            current?.nativeSessionId !== nativeSessionId ||
            current.bindingGeneration !== generation
          )
            return
          if (logicalTitle) {
            // A late first title must follow the same save/priority guard as
            // terminal enrichment before its Native name can be decorated.
            if (!run || !this.conversations.ownsNativeControl(run.id)) return
            try {
              this.publish(
                this.conversations.applyEvent(sessionId, run.id, {
                  agentId,
                  type: 'session.title.updated',
                  title: logicalTitle,
                }),
              )
            } catch {
              return // Title I/O cannot turn a reliable Native check into a failure.
            }
          }
          this.observeNativeTitle(sessionId, adapter, nativeSessionId, generation)
        }
        if (!run) {
          const initialized = this.conversations.confirmedNativeInitialization(sessionId, agentId)
          if (!initialized || !adapter.probeNativeStatus)
            throw new Error('There is no confirmed current initialization to check.')
          const chunks = this.conversations.readNativeRebuildSource(initialized.rebuildId)
          const evidence = await Conversation.withRecoveryDeadline(
            controller,
            () =>
              adapter.probeNativeStatus!(
                {
                  target: 'initialized_binding',
                  resolveImage: (id, _signal) => this.resolveRebuildImage(sessionId, id),
                  sessionId,
                  agentId,
                  requestId: initialized.rebuildId,
                  nativeSessionId: initialized.nativeSessionId,
                  bindingGeneration: initialized.bindingGeneration,
                  cwd: project.directoryPath,
                  model: session.settings.agents[agentId].model,
                  effort: session.settings.agents[agentId].effort,
                  confirmedInitialization: {
                    rebuildId: initialized.rebuildId,
                    sourceHash: initialized.sourceHash,
                    ...(initialized.witness ? { witness: initialized.witness } : {}),
                  },
                  source: (async function* () {
                    yield* chunks
                  })(),
                  observeNativeTitle: observeCheckedTitle,
                },
                controller.signal,
              ),
            undefined,
          )
          if (!evidence || controller.signal.aborted || this.disposed)
            throw new Error('The initialized binding could not be checked.')
          this.publish(this.conversations.recordNativeEvidence(evidence))
          if (evidence.kind !== 'binding_ready')
            throw new Error('Native initialization readback did not confirm this binding.')
          this.scheduleNativeTitleSync(sessionId)
          return { ok: true, value: this.conversations.contextPatch(sessionId) }
        }
        const evidence = await Conversation.withRecoveryDeadline(
          controller,
          async () => {
            if (!adapter.probeNativeStatus)
              throw new AgentExecutionError(
                'runtime_incompatible',
                'The runtime cannot provide a safe native check. Update the runtime, then Retry.',
                false,
              )
            return adapter.probeNativeStatus(
              {
                sessionId,
                agentId,
                requestId: run?.id ?? sessionId,
                ...(run ? { runId: run.id } : {}),
                nativeSessionId: context.nativeSessionId,
                ...(run?.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                ...(run?.answerFormat ? { answerFormat: run.answerFormat } : {}),
                bindingGeneration: generation,
                ...(run?.executorId ? { executorId: run.executorId } : {}),
                ...(agentId === 'claude' &&
                run?.dispatchPhase === 'ended' &&
                run.controlDisposition !== 'abandoned' &&
                run.nativeSessionId === context.nativeSessionId &&
                run.bindingGeneration === generation &&
                run.nativeTurnId
                  ? {
                      confirmedTerminal: {
                        kind: 'ended' as const,
                        source: 'stored_terminal' as const,
                        identity: {
                          sessionId,
                          agentId,
                          requestId: run.id,
                          runId: run.id,
                          nativeSessionId: context.nativeSessionId,
                          nativeTurnId: run.nativeTurnId,
                          ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
                          bindingGeneration: generation,
                          ...(run.executorId ? { executorId: run.executorId } : {}),
                        },
                        ...(run.nativeOutcome ? { outcome: run.nativeOutcome } : {}),
                      },
                    }
                  : {}),
                cwd: project.directoryPath,
                model: session.settings.agents[agentId].model,
                effort: session.settings.agents[agentId].effort,
                observeNativeTitle: observeCheckedTitle,
              },
              controller.signal,
            )
          },
          undefined,
        )
        if (!evidence || controller.signal.aborted)
          throw new Error('The native check did not return evidence.')
        if (
          this.disposed ||
          this.conversations.nativeContext(sessionId, agentId)?.bindingGeneration !== generation
        )
          throw new RunOperationConflictError('The binding changed while checking.')
        this.publish(this.conversations.recordNativeEvidence(evidence))
        if (run && 'output' in evidence && evidence.output) {
          this.publish(
            await this.conversations.recordNativeOutputComplete(
              run.id,
              evidence.output,
              controller.signal,
            ),
          )
        }
        if (run && evidence.kind === 'ended') {
          this.publish(this.conversations.settleKnownNativeEnding(run.id))
          if (
            evidence.outcome === 'completed' &&
            evidence.output?.completeness === 'complete' &&
            evidence.identity.nativeTurnId
          )
            this.reconcileOwnedCompletedCollaboration(run.id, {
              nativeTurnId: evidence.identity.nativeTurnId,
              source: evidence.source,
              ...(evidence.identity.executorId ? { executorId: evidence.identity.executorId } : {}),
            })
        }
        if (evidence.kind === 'no_evidence' || evidence.kind === 'missing')
          return {
            ok: false,
            error: {
              code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
              message:
                evidence.kind === 'missing'
                  ? 'The native session is unavailable. Rebuild it to continue.'
                  : 'The native check did not confirm the Turn. You can retry or rebuild; no task was reexecuted.',
            },
          }
        if (this.conversations.pendingNativeRebuild(sessionId, agentId))
          this.publish(
            this.conversations.setContinuation(
              sessionId,
              agentId,
              'recovery_required',
              'The candidate rebuild has not been confirmed. Check that creation or explicitly create another.',
              generation,
            ),
          )
        this.scheduleNativeTitleSync(sessionId)
        return { ok: true, value: this.conversations.contextPatch(sessionId) }
      } catch (error) {
        const patch = this.conversations.setContinuation(
          sessionId,
          agentId,
          'recovery_required',
          safeNativePermissionText(
            `Native state check failed: ${error instanceof Error ? error.message : 'No reliable response.'}`,
            240,
          ),
          generation,
          {
            kind: classifyAgentError(error).kind,
            message: safeNativePermissionText(
              error instanceof Error ? error.message : 'No reliable native response.',
              1024,
            ),
            action: [
              'authentication_required',
              'quota_or_rate_limit',
              'permission_blocked',
              'runtime_incompatible',
              'response_too_large',
            ].includes(classifyAgentError(error).kind)
              ? 'retry'
              : 'rebuild',
          },
        )
        this.publish(patch)
        return {
          ok: false,
          error: {
            code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
            message: 'The native check did not provide reliable evidence. No task was reexecuted.',
          },
        }
      }
    })().finally(() => {
      if (this.nativeChecks.get(key)?.controller === controller) {
        this.nativeChecks.get(key)!.adapter = undefined
        this.nativeChecks.delete(key)
        this.nativeMetadataChanged()
      }
      this.schedulePendingRoutedContinuations()
    })
    this.nativeChecks.set(key, { controller, task })
    this.nativeMetadataChanged()
    return task
  }

  async rebuildNativeContext(
    input: NativeContextRebuildInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (input.intent === 'claim_input' || input.intent === 'discard_input') {
      try {
        if (!input.expectedRebuildId || this.hasSessionOperation(input.sessionId))
          throw new RunOperationConflictError(
            'Input recovery is unavailable while this Session is working.',
          )
        const patch =
          input.intent === 'claim_input'
            ? this.conversations.claimReturnedInput(
                input.sessionId,
                input.expectedRebuildId,
                input.expectedGeneration ?? 0,
                input.expectedCommentsRevision ?? -1,
              )
            : this.conversations.discardReturnedInput(input.sessionId, input.expectedRebuildId)
        this.publish(patch)
        return { ok: true, value: patch }
      } catch (error) {
        return Conversation.sendFailure(error)
      }
    }
    if (this.conversations.forkOperation(input.sessionId)?.ready === false)
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'Confirm the original native fork candidates first. Rebuild cannot replace this fork.',
        },
      }
    if (
      input.intent === 'create' &&
      input.clientOperationId &&
      this.conversations.nativeRebuildOperation(input.clientOperationId)
    ) {
      try {
        this.conversations.verifyRebuildReceipt(
          input.clientOperationId,
          input.sessionId,
          input.agentId,
        )
        return this.recoveryResult(input.sessionId)
      } catch (error) {
        return Conversation.sendFailure(error)
      }
    }
    const context = this.conversations.nativeContext(input.sessionId, input.agentId)
    const currentOperation = this.conversations.lastNativeRebuild(input.sessionId, input.agentId)
    const currentOperationId =
      currentOperation && !['completed', 'superseded'].includes(currentOperation.stage)
        ? currentOperation.id
        : null
    if (
      (input.expectedNativeSessionId !== undefined &&
        context?.nativeSessionId !== input.expectedNativeSessionId) ||
      (input.expectedRunId !== undefined &&
        (
          (!context
            ? this.conversations.unacknowledgedNativeRun(input.sessionId, input.agentId)
            : undefined) ??
          this.conversations.latestAgentRun(
            input.sessionId,
            input.agentId,
            context?.bindingGeneration,
          )
        )?.id !== (input.expectedRunId ?? undefined)) ||
      (input.expectedRebuildId !== undefined && currentOperationId !== input.expectedRebuildId)
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The session changed since this recovery card was shown. Review the refreshed card before continuing.',
        },
      }

    const last = input.clientOperationId
      ? this.conversations.nativeRebuildOperation(input.clientOperationId)
      : this.conversations.lastNativeRebuild(input.sessionId, input.agentId)
    if (input.intent === 'inspect') {
      if (input.clientOperationId) {
        try {
          this.conversations.verifyRebuildReceipt(
            input.clientOperationId,
            input.sessionId,
            input.agentId,
          )
          if (
            input.expectedGeneration !== undefined &&
            last?.oldGeneration !== input.expectedGeneration
          )
            throw new RunOperationConflictError(
              'The rebuild confirmation belongs to a different generation.',
            )
        } catch (error) {
          return Conversation.sendFailure(error)
        }
      }
      if (last?.stage === 'completed') return this.recoveryResult(input.sessionId)
      // Checking an unacknowledged creation never invokes create/resume or a model.
      if (!last?.provisionalNativeSessionId)
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message:
              'Native creation returned no identity. It cannot be confirmed by retrying creation. Create another only as a new explicit operation.',
          },
        }
      return this.checkNativeRebuild(input.sessionId, input.agentId, last)
    }
    if (!input.clientOperationId)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Rebuild requires a confirmation identity.' },
      }
    if (
      this.nativeRebuilds.has(input.sessionId) ||
      this.preparingSends.size >= MAX_AGENT_OPERATIONS ||
      this.operationCount() >= MAX_AGENT_OPERATIONS
    )
      return Conversation.capacityFailure()
    if (this.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      return {
        ok: false,
        error: {
          code: 'AGENT_CAPACITY',
          message:
            'All 8 native interaction slots are occupied. Rebuild was not started; no native request was cancelled.',
        },
      }
    if (this.hasSessionOperation(input.sessionId))
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The current foreground task is still observed. Stop it or check its state first.',
        },
      }
    try {
      const patch = this.conversations.beginNativeRebuild({
        id: input.clientOperationId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        expectedGeneration: input.expectedGeneration ?? context?.bindingGeneration ?? 1,
        abandon: input.abandon === true,
        ...(input.agentId === 'claude' ? { reservedNativeSessionId: randomUUID() } : {}),
      })
      const rebuild: ActiveNativeRebuild = {
        agentId: input.agentId,
        rebuildId: input.clientOperationId,
        abortController: new AbortController(),
      }
      this.nativeRebuilds.set(input.sessionId, rebuild)
      this.workspaceChanges?.cancelUndoForNativeSession(input.sessionId)
      this.publish(patch)
      rebuild.completion = this.runNativeContextRebuild(input.sessionId, rebuild).finally(() => {
        if (this.nativeRebuilds.get(input.sessionId) === rebuild)
          this.nativeRebuilds.delete(input.sessionId)
        if (!this.disposed) this.publish(this.conversations.metadataPatch(input.sessionId))
      })
      return { ok: true, value: patch }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  private checkNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
    operation: NonNullable<ReturnType<ConversationRepository['nativeRebuildOperation']>>,
  ): Promise<RpcResult<ConversationPatch>> {
    const key = `${sessionId}:${agentId}:rebuild`
    const pending = this.nativeChecks.get(key)
    if (pending) return pending.task
    if (this.nativeChecks.size >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())
    if (this.hasSessionOperation(sessionId, false, undefined, true))
      return Promise.resolve(Conversation.archiveBusy())
    const controller = new AbortController()
    const expectedNativeSessionId = this.conversations.nativeContext(
      sessionId,
      agentId,
    )?.nativeSessionId
    const task = (async (): Promise<RpcResult<ConversationPatch>> => {
      try {
        this.conversations.verifyRebuildReceipt(operation.id, sessionId, agentId)
        const session = this.sessions.find(sessionId)
        const project = session && this.projects.find(session.projectId)
        if (!session || !project) throw new Error('The Session project is unavailable.')
        const executable = await this.runtimePreparation.findRecoveryExecutable(
          agentId,
          controller.signal,
        )
        if (!executable) throw new Error('The native executable is unavailable.')
        const adapter = await this.adapterFor(
          sessionId,
          agentId,
          executable,
          controller.signal,
          project.directoryPath,
          (acquired) => {
            const owner = this.nativeChecks.get(key)
            if (owner?.controller !== controller || controller.signal.aborted)
              throw new RunOperationConflictError('The native check is no longer current.')
            owner.adapter = acquired
            this.nativeMetadataChanged()
          },
        )
        const chunks = this.conversations.readNativeRebuildSource(operation.id)

        const result = await Conversation.withRecoveryDeadline(
          controller,
          async () => {
            if (!adapter.inspectNativeRebuild) return undefined
            return adapter.inspectNativeRebuild(
              {
                rebuildId: operation.id,
                sessionId,
                resolveImage: (id, _signal) => this.resolveRebuildImage(sessionId, id),
                cwd: project.directoryPath,
                model: session.settings.agents[agentId].model,
                effort: session.settings.agents[agentId].effort,
                ...(operation.provisionalNativeSessionId
                  ? { nativeSessionId: operation.provisionalNativeSessionId }
                  : {}),
                ...(operation.sourceHash ? { sourceHash: operation.sourceHash } : {}),
              },
              (async function* () {
                yield* chunks
              })(),
              controller.signal,
            )
          },
          undefined,
        )
        if (this.disposed) throw new Error('Pact is shutting down.')
        if (!result) {
          this.publish(
            this.conversations.recordNativeRebuildCheck(
              sessionId,
              agentId,
              operation,
              expectedNativeSessionId,
            ),
          )
          return {
            ok: false,
            error: {
              code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
              message: 'Pact couldn’t confirm the new session.',
            },
          }
        }
        const patch = this.conversations.completeNativeRebuild(
          operation.id,
          result.nativeSessionId,
          adapter.executorId,
          result.initializationWitness,
        )
        this.retireChangedSourceGrants(sessionId, agentId)
        for (const interaction of this.permissions.values())
          if (interaction.sessionId === sessionId && interaction.agentId === agentId)
            interaction.visible = false
        this.publish(patch)
        this.scheduleNativeTitleSync(sessionId)
        return { ok: true, value: patch }
      } catch (error) {
        return Conversation.sendFailure(error)
      }
    })().finally(() => {
      if (this.nativeChecks.get(key)?.controller === controller) {
        this.nativeChecks.get(key)!.adapter = undefined
        this.nativeChecks.delete(key)
        this.nativeMetadataChanged()
      }
      this.schedulePendingRoutedContinuations()
      if (!this.disposed) this.recoveryResult(sessionId)
    })
    this.nativeChecks.set(key, { controller, task })
    this.nativeMetadataChanged()
    this.recoveryResult(sessionId)
    return task
  }

  private async runNativeContextRebuild(
    sessionId: string,
    rebuild: ActiveNativeRebuild,
  ): Promise<void> {
    try {
      const prepared = await this.prepareSession(sessionId, rebuild.abortController.signal)
      if (!prepared.ok) throw new Error(prepared.error.message)
      const settings = prepared.value.session.settings.agents[rebuild.agentId]
      // The existing slot owner reserves a compatible Adapter or refuses before native creation.
      const adapter = await this.adapterFor(
        sessionId,
        rebuild.agentId,
        prepared.value.executablePaths[rebuild.agentId],
        rebuild.abortController.signal,
        prepared.value.projectDirectory,
      )
      rebuild.adapter = adapter
      this.nativeMetadataChanged()
      if (this.permissions.size >= NATIVE_PERMISSION_REQUESTS)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'All 8 native interaction slots are occupied. No replacement native session was created.',
          false,
        )
      rebuild.executorId = adapter.executorId
      const chunks: import('@pact/contracts').NativeContextRebuildChunk[] = []

      let bytes = 2
      const sourceDeadline = Date.now() + HANDOFF_READ_DEADLINE_MS
      for await (const chunk of this.conversations.nativeContextRebuildSource(
        sessionId,
        rebuild.abortController.signal,
        rebuild.rebuildId,
      )) {
        bytes += Buffer.byteLength(JSON.stringify(chunk)) + 1
        if (chunks.length >= 4096 || bytes > HANDOFF_SAFETY_BYTES || Date.now() > sourceDeadline)
          throw new HandoffTooLargeError(
            'The complete rebuild history exceeds its bounded preparation. It was not shortened.',
          )
        chunks.push(chunk)
      }
      const sourceHash = this.conversations.freezeNativeRebuildSource(rebuild.rebuildId, chunks)
      const operation = this.conversations.nativeRebuildOperation(rebuild.rebuildId)!
      const current = (): boolean => {
        const saved = this.conversations.nativeRebuildOperation(rebuild.rebuildId)
        return (
          !this.disposed &&
          saved !== undefined &&
          !['completed', 'failed', 'superseded'].includes(saved.stage) &&
          (this.conversations.nativeContext(sessionId, rebuild.agentId)?.bindingGeneration ?? 1) ===
            operation.oldGeneration &&
          (this.nativeRebuilds.get(sessionId) === rebuild ||
            adapter.hasActiveBackgroundWork?.(rebuild.rebuildId) === true)
        )
      }
      const owner = () => ({
        id: rebuild.rebuildId,
        sessionId,
        agentId: rebuild.agentId,
        bindingGeneration: operation.oldGeneration + 1,
        executorId: adapter.executorId,
        valid: () => current(),
      })
      const result = await adapter.rebuildNativeContext(
        {
          rebuildId: rebuild.rebuildId,
          sessionId,
          resolveImage: (id, _signal) => this.resolveRebuildImage(sessionId, id),
          cwd: prepared.value.projectDirectory,
          model: settings.model,
          effort: settings.effort,
          sourceHash,

          permissionMode: prepared.value.session.settings.permissionModes?.[rebuild.agentId],
          ...(operation.provisionalNativeSessionId
            ? { nativeSessionId: operation.provisionalNativeSessionId }
            : {}),
          onNativeCreationDispatched: async (executorId) => {
            if (!current()) throw new Error('The rebuild creation owner changed.')
            this.conversations.markNativeRebuildDispatched(rebuild.rebuildId, executorId)
          },
          onNativeSessionCreated: async (nativeId) => {
            if (!current()) throw new Error('The rebuild acknowledgement owner changed.')
            this.conversations.recordNativeRebuildIdentity(rebuild.rebuildId, nativeId)
          },

          reportNativeWork: (report) =>
            this.conversations.recordNativeRebuildWork(
              rebuild.rebuildId,
              report.executorId,
              report.nativeSessionId,
              report.state,
            ),
          requestPermission: (request, signal) =>
            this.requestNativePermission(owner(), request, signal),
          requestUserInput: (request, signal) =>
            this.requestNativeUserInput(owner(), request, signal),
        },
        (async function* () {
          yield* chunks
        })(),
        rebuild.abortController.signal,
      )
      if (!current()) return
      this.publish(
        this.conversations.completeNativeRebuild(
          rebuild.rebuildId,
          result.nativeSessionId,
          adapter.executorId,
          result.initializationWitness,
        ),
      )
      this.retireChangedSourceGrants(sessionId, rebuild.agentId)
      this.scheduleNativeTitleSync(sessionId)
      // Retire only the UI/control projection. Do not answer or cancel old Native requests.
      for (const pending of this.permissions.values())
        if (
          pending.sessionId === sessionId &&
          pending.agentId === rebuild.agentId &&
          pending.operationId !== rebuild.rebuildId
        )
          pending.visible = false
    } catch (error) {
      if (this.disposed || this.nativeRebuilds.get(sessionId) !== rebuild) return
      this.publish(
        this.conversations.failNativeRebuild(
          rebuild.rebuildId,
          error instanceof Error ? error.message : 'Native initialization could not be confirmed.',
        ),
      )
    } finally {
      rebuild.adapter = undefined
      this.nativeMetadataChanged()
    }
  }

  async saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>> {
    try {
      const session = this.sessions.find(input.sessionId)
      if (!session || session.status === 'archived') {
        return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
      }
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()
      if (input.mode === 'create' || input.anchor)
        await this.validateCommentAnchor(input.sessionId, input.anchor!)
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()
      if (this.disposed) return Conversation.shuttingDown()
      const patch = this.conversations.saveCommentDraft(input)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof CommentLimitError
              ? 'COMMENT_LIMIT'
              : this.isConflict(error)
                ? 'CONFLICT'
                : 'VALIDATION',
          message: error instanceof Error ? error.message : 'The Comment draft could not be saved.',
        },
      }
    }
  }

  removeCommentDraft(input: CommentDraftRemoveInput): RpcResult<ConversationPatch> {
    try {
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()
      const patch = this.conversations.removeCommentDraft(input)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: this.isConflict(error) ? 'CONFLICT' : 'VALIDATION',
          message:
            error instanceof Error ? error.message : 'The Comment draft could not be removed.',
        },
      }
    }
  }

  async resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>> {
    const comment = this.conversations.comment(commentId)
    if (!comment || comment.sessionId !== sessionId) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Comment is unavailable.' } }
    }
    const anchor = comment.anchor
    if (anchor.type === 'file') return this.projectFiles.resolveCommentSource(sessionId, comment)
    if (anchor.type === 'todo') {
      const todo = this.conversations.readTodoRevision(
        anchor.taskId,
        anchor.todoId,
        anchor.todoRevision,
      )
      const owner = todo ? this.conversations.findRun(todo.sourceRunId) : undefined
      if (!todo || owner?.sessionId !== sessionId)
        return {
          ok: true,
          value: {
            status: 'unavailable',
            commentId,
            quote: anchor.quote,
            reason: 'The original Todo revision is unavailable.',
          },
        }
      if (anchor.selection && anchor.selection.contentHash !== todo.document.sha256)
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: 'The immutable Todo source changed.',
          },
        }
      return { ok: true, value: { status: 'resolved', commentId, anchor } }
    }
    if (
      anchor.textBasis !== MESSAGE_ANCHOR_TEXT_BASIS &&
      !(anchor.textBasis === 'plain-visible-v1' && (anchor.plan || anchor.report))
    ) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'This Comment uses an earlier Markdown projection.',
        },
      }
    }
    const metadata = this.conversations.messageMetadata(anchor.messageId, sessionId)
    if (!metadata) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'Message unavailable.',
        },
      }
    }
    const natural = this.conversations.naturalMessageProjection(anchor.messageId, sessionId)
    const naturalBasis = natural !== undefined && Conversation.hash(natural) === anchor.contentHash
    if (
      !anchor.plan &&
      !anchor.report &&
      !naturalBasis &&
      metadata.contentBytes > CONVERSATION_MARKDOWN_BYTES
    ) {
      return {
        ok: true,
        value: {
          status: 'unavailable',
          commentId,
          quote: anchor.quote,
          reason:
            'This long Message is shown as plain text; exact Comment positioning is unavailable.',
        },
      }
    }
    try {
      const source = this.conversations.collaborationCommentDocument(sessionId, anchor)
      if (source) {
        const owner = this.conversations.collaborationDocumentRow(sessionId, source).sourceRunId!
        if (anchor.textBasis !== 'plain-visible-v1')
          await this.prepareMarkdown(sessionId, owner, source)
        const matched =
          source.sha256 === anchor.contentHash &&
          this.conversations.collaborationQuote(
            sessionId,
            source,
            anchor.startOffset,
            anchor.endOffset,
            anchor.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : 'markdown-visible-v2',
          ) === anchor.quote
        return {
          ok: true,
          value: matched
            ? { status: 'resolved', commentId, anchor }
            : {
                status: 'outdated',
                commentId,
                quote: anchor.quote,
                reason: 'Comment source changed.',
              },
        }
      }
    } catch (error) {
      return {
        ok: true,
        value: {
          status: 'unavailable',
          commentId,
          quote: anchor.quote,
          reason: error instanceof Error ? error.message : 'Comment source unavailable.',
        },
      }
    }
    let content: string
    try {
      content = this.commentMarkdown(sessionId, anchor)
    } catch (error) {
      if (anchor.plan || anchor.report)
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: error instanceof Error ? error.message : 'Plan source unavailable.',
          },
        }
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: error instanceof Error ? error.message : 'The Comment source is unavailable.',
        },
      }
    }
    if (Conversation.hash(content) !== anchor.contentHash) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: anchor.plan || anchor.report ? 'Comment source changed.' : 'Message changed.',
        },
      }
    }
    const projection = await Conversation.markdownVisibleProjection(content)
    if (projection.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'Message text changed.',
        },
      }
    }
    return { ok: true, value: { status: 'resolved', commentId, anchor } }
  }

  setInterests(sessionIds: string[]): RpcResult<{ ready: true }> {
    if (this.disposed) return Conversation.shuttingDown()
    const input = conversationInterestsSchema.safeParse({ sessionIds })
    if (!input.success)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose a bounded set of Sessions.' },
      }
    for (const owner of this.skillDiscoveries.values())
      if (!input.data.sessionIds.includes(owner.sessionId)) this.cancelSkillCatalog(owner.sessionId)
    this.interestedSessionIds = new Set(input.data.sessionIds)
    return { ok: true, value: { ready: true } }
  }

  diagnostics() {
    return {
      interestedSessions: this.interestedSessionIds.size,
      suppressedProgress: this.suppressedProgress,
      publishedProgress: this.publishedProgress,
      activeExecutions: this.activeExecutions.size,
      pendingStreamItems: [...this.activeExecutions.values()].reduce(
        (sum, owner) => sum + (owner.streamBuffer?.diagnostics().pendingItems ?? 0),
        0,
      ),
      nativeRebuilds: this.nativeRebuilds.size,
      nativeForks: this.nativeForks.size,
      forkPreparations: this.forkPreparations.size,
      preparingExecutions: this.preparingSends.size + this.preparingContinuations.size,
      adapterSlots: this.adapters.size,
    }
  }

  subscribe(listener: (patch: ConversationPatch, progress: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): Promise<void> {
    clearTimeout(this.nativeQuitPreparation?.timer)
    this.nativeQuitPreparation = undefined
    this.nativeListeners.clear()
    this.skillDocumentOwner?.controller.abort()
    for (const owner of this.skillDiscoveries.values()) owner.controller.abort()
    this.skillCatalogs.clear()
    this.disposal ??= this.close()
    return this.disposal
  }

  private async close(): Promise<void> {
    this.disposed = true
    await this.markdownWorker?.terminate()
    await this.markdownTail
    clearTimeout(this.receivedDeadlineTimer)
    const forkOwners = [...this.nativeForks.values()]
    const forkPreparations = [...this.forkPreparations.values()]
    for (const owner of forkOwners) owner.controller.abort()
    for (const check of this.nativeChecks.values()) check.controller.abort()
    this.nativeChecks.clear()
    this.interestedSessionIds.clear()
    const executions = [...this.activeExecutions.values()]
    const preparing = [...this.preparingSends.values()]
    const preparingContinuations = [...this.preparingContinuations.values()]
    const nativeRebuilds = [...this.nativeRebuilds.values()]
    const titleEnrichments = [...this.titleEnrichments.values()]
    const nativeTitleSyncs = [...this.nativeTitleSyncs.values()]
    for (const owner of nativeTitleSyncs) {
      owner.cancelled = true
      owner.abortController.abort()
    }
    let flushed = true
    for (const execution of executions) {
      try {
        if (execution.streamBuffer && !execution.streamBuffer.dispose()) flushed = false
      } catch {
        flushed = false
      }
    }
    // Reuse the accepted restart classification, but save the interruption now.
    for (const execution of executions) {
      try {
        this.conversations.interruptRun(execution.run.id, execution.deliveryPossible)
      } catch {
        flushed = false
      }
    }
    this.titleEnrichments.clear()
    for (const execution of executions) execution.abortController.abort()
    for (const admission of preparing) admission.controller.abort()
    for (const continuation of preparingContinuations) continuation.controller.abort()
    for (const rebuild of nativeRebuilds) rebuild.abortController.abort()
    for (const enrichment of titleEnrichments) enrichment.abortController.abort()
    // Actual App shutdown releases our waits. Abandon/Rebuild never enters
    // this path and never fabricates a user cancellation for old requests.
    for (const pending of this.permissions.values()) pending.withdraw('aborted')
    await Promise.allSettled([...this.skillDiscoveries.values()].map((owner) => owner.task))
    if (this.skillDocumentOwner) await this.skillDocumentOwner.task
    await this.adapterSlotTail
    const adapters = [...this.adapters.values()]
    this.adapters.clear()
    for (const owner of this.nativeObservations.values()) owner.archiveController.abort()
    await Promise.allSettled(
      [...this.nativeObservations.values()].flatMap((owner) =>
        owner.archiveTail ? [owner.archiveTail] : [],
      ),
    )
    for (const owner of this.nativeObservations.values()) {
      try {
        if (owner.archiveBuffer && !owner.archiveBuffer.dispose()) flushed = false
      } catch {
        flushed = false
      }
    }
    this.nativeObservations.clear()
    const cleanup = await Promise.allSettled([
      ...adapters.map(async ({ adapter }) => {
        await adapter.dispose()
      }),
      ...forkOwners.flatMap((owner) => (owner.completion ? [owner.completion] : [])),
      ...forkPreparations.map((owner) => owner.task),
      ...titleEnrichments.map(({ promise }) => promise),
      ...nativeTitleSyncs.map(({ promise }) => promise),
      ...executions.flatMap((execution) => (execution.completion ? [execution.completion] : [])),
      ...preparing.map((admission) => admission.task),
      ...preparingContinuations.flatMap((continuation) =>
        continuation.completion ? [continuation.completion] : [],
      ),
      ...nativeRebuilds.flatMap((rebuild) => (rebuild.completion ? [rebuild.completion] : [])),
    ])
    this.activeExecutions.clear()
    this.preparingSends.clear()
    this.preparingContinuations.clear()
    this.nativeRebuilds.clear()
    this.nativeForks.clear()
    this.forkPreparations.clear()
    this.listeners.clear()
    await this.images?.dispose()
    if (!flushed || cleanup.some((result) => result.status === 'rejected'))
      throw new Error(
        'Pact could not finish all output commits and resource cleanup before shutdown.',
      )
  }

  private async collectHandoff(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    signal: AbortSignal,
    excludeMessageId?: string,
    throughSequence?: number,
  ): Promise<HandoffBundle[]> {
    const range = this.conversations.handoffRange(sessionId, targetAgentId)
    const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
    const messages: HandoffBundle[] = []
    let bytes = 0
    for await (const message of this.conversations.readHandoffSources(
      sessionId,
      targetAgentId,
      range.afterSequence,
      Math.min(range.throughSequence, throughSequence ?? range.throughSequence),
      signal,
      excludeMessageId,
    )) {
      if (signal.aborted || Date.now() >= deadline)
        throw new HandoffSourceUnavailableError('Reading the Agent handoff timed out.')
      bytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
      if (bytes > HANDOFF_SAFETY_BYTES)
        throw new HandoffTooLargeError('The Agent handoff exceeds its safe processing size.')
      messages.push(message)
    }
    return messages
  }

  private async prepareSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RpcResult<PreparedSession>> {
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.conversations.archives.blocksSession(sessionId)) return Conversation.archiveBusy()
    const session = this.sessions.find(sessionId)
    if (!session || session.status === 'archived') {
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    }
    const project = this.projects.find(session.projectId)
    if (!project || project.archivedAt) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project is unavailable.' } }
    }
    const readiness = await this.runtimePreparation.inspectReadiness(signal)
    if (!readiness.ok) return readiness
    if (this.conversations.archives.blocksSession(sessionId)) return Conversation.archiveBusy()
    let claudeExecutablePath: string | undefined
    let codexExecutablePath: string | undefined
    for (const agent of readiness.value.agents) {
      if (agent.state !== 'ready' || !agent.executablePath) {
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both Agents must be ready.' },
        }
      }
      if (agent.agentId === 'claude') claudeExecutablePath = agent.executablePath
      else codexExecutablePath = agent.executablePath
    }
    if (!claudeExecutablePath || !codexExecutablePath) {
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both Agents must be ready.' },
      }
    }
    const executablePaths: Record<RuntimeAgentId, string> = {
      claude: claudeExecutablePath,
      codex: codexExecutablePath,
    }
    return {
      ok: true,
      value: { session, projectDirectory: project.directoryPath, executablePaths },
    }
  }

  private execute(
    run: AgentRun,
    initialPrompt: AgentPromptEnvelope,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    return this.trackExecution(run, async (execution) => {
      await this.executeAttempts(execution, run, initialPrompt, cwd, settings, executablePaths)
      if (this.conversations.findRun(run.id)?.status !== 'completed') return
      try {
        await this.executeRoutedContinuation(
          execution,
          run.userMessageId,
          cwd,
          settings,
          executablePaths,
        )
      } catch (error) {
        if (
          !this.disposed &&
          !execution.abortController.signal.aborted &&
          !execution.cancelledByUser
        ) {
          const targetAgentId: RuntimeAgentId = run.agentId === 'claude' ? 'codex' : 'claude'
          this.publish(
            this.conversations.failPendingRoutedContinuation(
              run.sessionId,
              run.userMessageId,
              targetAgentId,
              Conversation.pendingContinuationFailureCopy(targetAgentId, error),
            ),
          )
        }
      }
    })
  }

  private async executeRoutedContinuation(
    execution: ActiveExecution,
    userMessageId: string,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    const message = this.conversations.internalMessage(userMessageId, execution.run.sessionId)
    if (message?.route?.type !== 'all') return
    const pending = this.conversations
      .pendingRoutedContinuations()
      .find((entry) => entry.userMessageId === userMessageId)
    if (!pending) {
      execution.protectedAgentId = undefined
      return
    }
    execution.protectedAgentId = pending.agentId
    const prepared = await this.beginPendingRoutedContinuation(
      pending,
      {
        cwd,
        settings,
        settingsRevision: execution.run.settingsRevision,
        executablePaths,
      },
      execution.abortController.signal,
    )
    if (!prepared) return
    const { started, prompt } = prepared
    execution.run = started.run
    execution.protectedAgentId = started.run.agentId
    this.publish(started.patch)
    await this.executeAttempts(execution, started.run, prompt, cwd, settings, executablePaths)
  }

  private async beginPendingRoutedContinuation(
    pending: { sessionId: string; userMessageId: string; agentId: RuntimeAgentId },
    context: {
      cwd: string
      settings: DefaultSessionSettings
      settingsRevision: number
      executablePaths: Record<RuntimeAgentId, string>
    },
    signal: AbortSignal,
  ): Promise<
    | {
        started: ReturnType<ConversationRepository['beginRoutedContinuation']>
        prompt: AgentPromptEnvelope
      }
    | undefined
  > {
    const message = this.conversations.internalMessage(pending.userMessageId, pending.sessionId)
    if (message?.route?.type !== 'all') return undefined
    const agentId = pending.agentId
    const adapter = await this.adapterFor(
      pending.sessionId,
      agentId,
      context.executablePaths[agentId],
      signal,
      context.cwd,
    )
    const nativeContext = this.conversations.nativeContext(pending.sessionId, agentId)
    if (nativeContext && nativeContext.continuationState !== 'ready') {
      return undefined
    }
    const frozen = this.conversations.skillInvocation(pending.userMessageId)
    if (frozen) {
      const current = await this.skillBindings(pending.sessionId, agentId, signal, true, true)
      if (
        frozen.bindings
          .filter((entry) => entry.agentId === agentId)
          .some((entry) => !current.some((item) => item.id === entry.id))
      )
        throw new RunOperationConflictError(
          'The secondary Agent Skill catalog changed. Its stage was not sent; the first answer is preserved.',
        )
    }
    const comments: AnchoredComment[] = []
    const handoff = await this.collectHandoff(
      pending.sessionId,
      agentId,
      signal,
      pending.userMessageId,
      message.sequence - 1,
    )
    const prompt = this.promptEnvelope(
      pending.sessionId,
      { id: message.id, content: message.content },
      comments,
      handoff,
    )
    if (Buffer.byteLength(serializeAgentPromptEnvelope(prompt), 'utf8') > HANDOFF_SAFETY_BYTES)
      throw new HandoffTooLargeError('The Agent context is too large to send safely.')
    adapter.preflightPrompt?.({
      runId: randomUUID(),
      sessionId: pending.sessionId,
      ...(nativeContext ? { nativeSessionId: nativeContext.nativeSessionId } : {}),
      peerAssistanceAllowed: false,
      cwd: context.cwd,
      promptEnvelope: prompt,
      model: context.settings.agents[agentId].model,
      effort: context.settings.agents[agentId].effort,
    })
    return {
      started: this.conversations.beginRoutedContinuation({
        sessionId: pending.sessionId,
        userMessageId: pending.userMessageId,
        agentId,
        settingsRevision: context.settingsRevision,
        model: context.settings.agents[agentId].model,
        effort: context.settings.agents[agentId].effort,
        handoffSourceRefs: handoff.map((source) =>
          Object.assign(
            {
              id: source.messageId,
              revision: source.contentRevision,
              digest: source.digest,
            },
            source.contextVersion ? { contextVersion: source.contextVersion } : {},
          ),
        ),
      }),
      prompt,
    }
  }

  private schedulePendingRoutedContinuations(): void {
    if (this.disposed) return
    if (this.pendingContinuationScheduled) {
      this.pendingContinuationWakeAgain = true
      return
    }
    this.pendingContinuationScheduled = true
    queueMicrotask(() => {
      void this.resumePendingRoutedContinuations()
        .catch(() => undefined)
        .finally(() => {
          this.pendingContinuationScheduled = false
          if (this.pendingContinuationWakeAgain) {
            this.pendingContinuationWakeAgain = false
            this.schedulePendingRoutedContinuations()
          }
        })
    })
  }

  private async dispatchReceivedInput(sessionId: string): Promise<void> {
    if (
      this.disposed ||
      this.nativeQuitSealed() ||
      this.hasSessionOperation(sessionId, true) ||
      this.operationCount() >= MAX_AGENT_OPERATIONS ||
      this.conversations.nativeRecoveryBlocksInput(sessionId)
    )
      return
    const input = this.conversations.readReceivedInput(sessionId)
    const task = this.conversations.collaboration(sessionId),
      session = this.sessions.find(sessionId)
    if (!input || input.state !== 'accepted' || !task || !session || session.status === 'archived')
      return
    if (
      input.taskId !== task.id ||
      (this.conversations.findRun(task.runId)?.failureKind === 'unknown_delivery' &&
        this.conversations.findRun(task.runId)?.dispatchPhase !== 'ended')
    ) {
      this.publish(this.conversations.setReceivedInputState(sessionId, 'blocked', input.id))
      return
    }
    if (task.status === 'running' || task.status === 'paused') return
    // A user wait is a boundary: Next Round cannot require an unapproved peer Turn.
    const next = prepareCollaborationSupplement(
      task,
      input.actor,
      session.settings,
      input.metadata.planningAction,
    )
    next.latestUserMessageId = input.id
    const currentDrafts = this.conversations.readPage({ scope: 'drafts', sessionId })
    if (currentDrafts.scope !== 'drafts') return
    const result = await this.enqueueSend(
      {
        sessionId,
        clientMessageId: input.id,
        content: input.content,
        route: { type: 'agent', agentId: input.actor },
        expectedCommentsRevision: currentDrafts.commentsRevision,
        commentIds: [],
        ...(input.metadata.batchId ? { batchId: input.metadata.batchId } : {}),
        freezeDrafts: false,
        ...(input.metadata.imageIds.length ? { imageIds: input.metadata.imageIds } : {}),
      },
      {
        collaboration: next,
        preserveDraftComments: true,
        receivedInputId: input.id,
        receivedComments: input.comments,
      },
    )
    if (!result.ok && this.conversations.receivedCollaborationInput(sessionId)?.id === input.id)
      this.publish(this.conversations.setReceivedInputState(sessionId, 'blocked', input.id))
  }

  private async resumePendingRoutedContinuations(): Promise<void> {
    clearTimeout(this.receivedDeadlineTimer)
    this.receivedDeadlineTimer = undefined
    for (const pending of this.conversations.pendingCollaborationInputs()) {
      if (Date.parse(pending.deadline) <= Date.now()) {
        this.publish(
          this.conversations.setReceivedInputState(pending.sessionId, 'blocked', pending.id),
        )
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- Admission reserves shared Session/App capacity before considering the next receipt.
      await this.dispatchReceivedInput(pending.sessionId).catch(() => {
        if (
          !this.disposed &&
          this.conversations.receivedCollaborationInput(pending.sessionId)?.id === pending.id
        )
          this.publish(
            this.conversations.setReceivedInputState(pending.sessionId, 'blocked', pending.id),
          )
      })
    }
    const pendingDeadlines = this.conversations.pendingCollaborationInputs()
    if (!this.disposed && pendingDeadlines.length) {
      const delay = Math.max(
        1,
        Math.min(...pendingDeadlines.map((row) => Date.parse(row.deadline))) - Date.now(),
      )
      this.receivedDeadlineTimer = setTimeout(
        () => this.schedulePendingRoutedContinuations(),
        delay,
      )
      this.receivedDeadlineTimer.unref()
    }
    for (const pending of this.conversations.pendingRoutedContinuations()) {
      if (
        this.disposed ||
        this.nativeQuitSealed() ||
        this.conversations.nativeRecoveryBlocksInput(pending.sessionId) ||
        this.hasSessionOperation(pending.sessionId) ||
        this.operationCount() >= MAX_AGENT_OPERATIONS
      )
        continue
      const continuation: PreparingContinuation = {
        sessionId: pending.sessionId,
        userMessageId: pending.userMessageId,
        protectedAgentId: pending.agentId,
        controller: new AbortController(),
      }
      this.preparingContinuations.set(pending.sessionId, continuation)
      this.workspaceChanges?.cancelUndoForNativeSession(pending.sessionId)
      continuation.completion = this.preparePendingRoutedContinuation(pending, continuation)
    }
  }

  private async preparePendingRoutedContinuation(
    pending: { sessionId: string; userMessageId: string; agentId: RuntimeAgentId },
    continuation: PreparingContinuation,
  ): Promise<void> {
    try {
      const preparedSession = await this.prepareSession(
        pending.sessionId,
        continuation.controller.signal,
      )
      if (!preparedSession.ok)
        throw new AgentExecutionError('runtime_incompatible', preparedSession.error.message, false)
      if (
        this.disposed ||
        continuation.controller.signal.aborted ||
        this.preparingContinuations.get(pending.sessionId) !== continuation
      )
        return
      const context = preparedSession.value
      const source = this.conversations.internalMessage(pending.userMessageId, pending.sessionId)
      const firstRun = source?.runId ? this.conversations.findRun(source.runId) : undefined
      const frozenSettings =
        firstRun && this.sessions.findSettingsRevision(pending.sessionId, firstRun.settingsRevision)
      if (!firstRun || !frozenSettings)
        throw new RunOperationConflictError('The original routed task settings are unavailable.')
      const prepared = await this.beginPendingRoutedContinuation(
        pending,
        {
          cwd: context.projectDirectory,
          settings: frozenSettings,
          settingsRevision: firstRun.settingsRevision,
          executablePaths: context.executablePaths,
        },
        continuation.controller.signal,
      )
      if (
        !prepared ||
        this.disposed ||
        continuation.controller.signal.aborted ||
        this.preparingContinuations.get(pending.sessionId) !== continuation
      )
        return
      this.preparingContinuations.delete(pending.sessionId)
      this.publish(prepared.started.patch)
      void this.trackExecution(prepared.started.run, (execution) =>
        this.executeAttempts(
          execution,
          prepared.started.run,
          prepared.prompt,
          context.projectDirectory,
          frozenSettings,
          context.executablePaths,
        ),
      )
    } catch (error) {
      if (
        !this.disposed &&
        !continuation.controller.signal.aborted &&
        this.preparingContinuations.get(pending.sessionId) === continuation
      )
        this.publish(
          this.conversations.failPendingRoutedContinuation(
            pending.sessionId,
            pending.userMessageId,
            pending.agentId,
            Conversation.pendingContinuationFailureCopy(pending.agentId, error),
          ),
        )
    } finally {
      if (this.preparingContinuations.get(pending.sessionId) === continuation)
        this.preparingContinuations.delete(pending.sessionId)
      if (!this.disposed) this.publish(this.conversations.metadataPatch(pending.sessionId))
      this.schedulePendingRoutedContinuations()
    }
  }

  private trackExecution(
    run: AgentRun,
    work: (execution: ActiveExecution) => Promise<void>,
  ): Promise<void> {
    if (this.activeExecutions.has(run.sessionId))
      throw new RunOperationConflictError('This Session already has an active operation.')
    const execution: ActiveExecution = {
      run,
      protectedAgentId: run.agentId,
      deliveryPossible: false,
      abortController: new AbortController(),
    }
    this.activeExecutions.set(run.sessionId, execution)
    execution.completion = work(execution)
      .catch((error: unknown) => {
        if (
          !this.disposed &&
          !execution.cancelledByUser &&
          this.activeExecutions.get(execution.run.sessionId) === execution &&
          this.conversations.findRun(execution.run.id)?.status !== 'completed'
        )
          this.publish(
            this.conversations.failRun(
              execution.run.id,
              execution.run.failureKind === 'unknown_delivery' || execution.deliveryPossible
                ? 'unknown_delivery'
                : 'protocol_error',
              error instanceof Error ? error.message : 'Pact could not start the Agent stream.',
            ),
          )
      })
      // oxlint-disable-next-line typescript/no-misused-promises -- Promise.finally awaits the asynchronous resource cleanup on both settlement paths.
      .finally(async () => {
        try {
          const owner = this.nativeObservations.get(execution.run.id)
          if (owner?.archiveTail) await owner.archiveTail
          if (owner && !owner.adapter.hasActiveBackgroundWork?.(execution.run.id)) {
            // Commit the foreground tail before late archived facts, while the
            // exact observer still owns its callbacks and acknowledgements.
            if (execution.streamBuffer && !execution.streamBuffer.flush())
              throw new Error('The last foreground output could not be committed.')
            if (
              owner.archiveBuffer &&
              (!owner.archiveBuffer.flush() || !owner.archiveBuffer.dispose())
            )
              throw new Error('The late native output could not be committed.')
            this.nativeObservations.delete(execution.run.id)
            if (this.conversations.findRun(execution.run.id)?.nativeEffectsState === 'pending')
              this.publish(
                this.conversations.recordNativeEffects(
                  execution.run.id,
                  'unknown',
                  'observer_ended_without_settlement',
                ),
              )
          }
          await this.finalizeWorkspaceChanges(execution.run.id)
        } finally {
          execution.streamBuffer?.dispose()
          execution.streamBuffer = undefined
          if (this.activeExecutions.get(run.sessionId) === execution)
            this.activeExecutions.delete(run.sessionId)
          if (!this.disposed) this.publish(this.conversations.metadataPatch(run.sessionId))
          this.schedulePendingRoutedContinuations()
        }
      })
    // Send launches this promise without awaiting it; shutdown still receives its real
    // rejected state, while this observer prevents a detached unhandled rejection.
    void execution.completion.catch(() => undefined)
    return execution.completion
  }

  private async finalizeWorkspaceChanges(runId: string): Promise<void> {
    if (this.disposed) return
    const run = this.conversations.findRun(runId)
    if (!run || ['starting', 'running', 'recovering'].includes(run.status)) return
    if (
      this.adapters.get(`${run.sessionId}:${run.agentId}`)?.adapter.hasActiveBackgroundWork?.(runId)
    ) {
      const recorded = this.workspaceChanges?.summary(runId)
      if (run.dispatchPhase === 'ended' && recorded && recorded.fileCount > 0)
        this.publish(this.conversations.recordWorkspaceChanges(recorded))
      return
    }
    const summary = await this.workspaceChanges?.finish(runId)
    if (summary && (summary.fileCount > 0 || summary.state === 'recovery_required'))
      this.publish(this.conversations.recordWorkspaceChanges(summary))
  }

  private static async *answerParts(text: string, signal: AbortSignal): AsyncIterable<string> {
    for (let offset = 0; offset < text.length;) {
      signal.throwIfAborted()
      let end = Math.min(text.length, offset + 8192)
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      )
        end -= 1
      yield text.slice(offset, end)
      offset = end
    }
  }

  private async executeAttempts(
    execution: ActiveExecution,
    run: AgentRun,
    promptEnvelope: AgentPromptEnvelope,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void> {
    const diagnosticStartedAt = Date.now()
    recordDiagnostic({
      operation: 'send',
      scope: 'run',
      phase: 'started',
      sessionId: run.sessionId,
      runId: run.id,
      agentId: run.agentId,
    })
    const context = this.conversations.nativeContext(run.sessionId, run.agentId)
    const peerAssistanceAllowed =
      this.conversations.internalMessage(run.userMessageId, run.sessionId)?.route?.type !== 'all'
    const signal = execution.abortController.signal
    let reportedTitle = false
    const recordingIssue = await this.workspaceChanges?.start(run, signal)
    if (recordingIssue)
      this.publish(this.conversations.recordWorkspaceRecordingUnavailable(run.id, recordingIssue))
    const adapter = await this.adapterFor(
      run.sessionId,
      run.agentId,
      executablePaths[run.agentId],
      signal,
      cwd,
    )
    execution.adapter = adapter
    this.nativeMetadataChanged()
    const currentBinding = this.conversations.nativeContext(run.sessionId, run.agentId)
    if (
      currentBinding &&
      (currentBinding.continuationState !== 'ready' ||
        currentBinding.bindingGeneration !== run.bindingGeneration ||
        (run.nativeSessionId && currentBinding.nativeSessionId !== run.nativeSessionId))
    )
      throw new RunOperationConflictError(
        'The native binding is no longer ready for this prepared task.',
      )
    if (!this.ownsExecution(execution, run.id)) return
    this.retireChangedSourceGrants(run.sessionId, run.agentId)
    if (this.nativeObservations.size >= 40 && !this.nativeObservations.has(run.id))
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Native observation capacity is occupied.',
        false,
      )
    const generation = randomUUID()
    const owner: NativeObservation = {
      generation,
      adapter,
      archivePending: 0,
      archiveController: new AbortController(),
      archiveMemory: new NativeWorkingMemory(),
    }
    this.nativeObservations.set(run.id, owner)
    const stillOwned = (): boolean =>
      !this.disposed && this.nativeObservations.get(run.id) === owner
    const ownsCurrentNativeRun = (): boolean =>
      this.activeExecutions.get(run.sessionId) === execution &&
      this.conversations.ownsNativeControl(run.id)
    const currentControl = (): boolean => !this.disposed && ownsCurrentNativeRun()
    // Compact original-live ending receipt only; never retain another complete body.
    let completedNativeReportReceipt:
      | { nativeTurnId: string; source: 'live_terminal'; executorId: string }
      | undefined
    let streamFailed = false
    const buffer = new AgentStreamBuffer(
      (events) =>
        ownsCurrentNativeRun()
          ? this.conversations.applyStreamBatch(run.sessionId, run.id, events)
          : this.conversations.applyArchivedBatch(run.sessionId, run.id, events),
      (patch) => this.publish(patch, true),
      () => {
        streamFailed = true
      },
    )
    execution.streamBuffer = buffer
    const archive = (event: import('@pact/contracts').NormalizedAgentEvent): void => {
      if (!stillOwned()) return
      const fact = normalizedAgentEventSchema.parse(event)
      const large =
        fact.type === 'text.completed' &&
        Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES
      const apply = async (): Promise<void> => {
        if (!stillOwned() || owner.archiveController.signal.aborted) return
        // Late facts preserve their answer, but never establish workflow acceptance.
        if (fact.type === 'collaboration.result') {
          this.conversations.recordRecoveredCollaborationResult(
            run.id,
            collaborationResultSchema.parse(fact.result),
          )
          return
        }
        if (fact.type === 'collaboration.result_incomplete') return
        if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') {
          owner.archiveBuffer ??= new AgentStreamBuffer(
            (events) => this.conversations.applyArchivedBatch(run.sessionId, run.id, events),
            (patch) => this.publish(patch, true),
            () => this.workspaceChanges?.observeUncertainEffects(run.id),
          )
          owner.archiveBuffer.push(fact)
        } else {
          owner.archiveBuffer?.flush()
          if (large && fact.type === 'text.completed') {
            const { text, ...metadata } = fact
            this.publish(
              await this.conversations.completeAnswer(
                run.id,
                metadata,
                (bodySignal) => Conversation.answerParts(text, bodySignal),
                owner.archiveController.signal,
                { archive: true },
              ),
            )
          } else this.publish(this.conversations.applyArchivedEvent(run.sessionId, run.id, fact))
          if (
            fact.type === 'turn.completed' &&
            fact.outcome === 'completed' &&
            completedNativeReportReceipt?.nativeTurnId === fact.turnId
          )
            this.reconcileOwnedCompletedCollaboration(run.id, completedNativeReportReceipt)
        }
      }
      if (!large && !owner.archiveTail) {
        // Small facts preserve their existing synchronous durable commit order.
        void apply().catch((error: unknown) => {
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            sessionId: run.sessionId,
            runId: run.id,
            agentId: run.agentId,
            runtimeBoundary: 'archive',
            code: classifyAgentError(error).kind,
            runtimeErrorType:
              diagnosticEventSchema.shape.runtimeErrorType.safeParse(
                error instanceof Error ? error.name : 'other',
              ).data ?? 'other',
          })
          this.workspaceChanges?.observeUncertainEffects(run.id)
        })
        return
      }
      if (owner.archivePending >= 8)
        throw new AgentExecutionError('protocol_error', 'Archived answer work is full.', false)
      const text = 'text' in fact ? fact.text : ''
      const reservation = owner.archiveMemory.reserve(
        4096 + text.length * 10 + Buffer.byteLength(text, 'utf8') * 2,
      )
      owner.archivePending += 1
      const task = (owner.archiveTail ?? Promise.resolve())
        .then(apply)
        .catch((error: unknown) => {
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            sessionId: run.sessionId,
            runId: run.id,
            agentId: run.agentId,
            runtimeBoundary: 'archive',
            code: classifyAgentError(error).kind,
            runtimeErrorType:
              diagnosticEventSchema.shape.runtimeErrorType.safeParse(
                error instanceof Error ? error.name : 'other',
              ).data ?? 'other',
          })
          this.workspaceChanges?.observeUncertainEffects(run.id)
        })
        .finally(() => {
          reservation.release()
          owner.archivePending -= 1
          if (owner.archiveTail === task) owner.archiveTail = undefined
        })
      owner.archiveTail = task
    }
    const release = (): void => {
      if (!stillOwned() || adapter.hasActiveBackgroundWork?.(run.id)) return
      if (owner.archiveTail) {
        void owner.archiveTail.then(release)
        return
      }
      if (
        ['starting', 'running', 'recovering'].includes(
          this.conversations.findRun(run.id)?.status ?? '',
        )
      )
        return
      if (
        !buffer.flush() ||
        (owner.archiveBuffer && (!owner.archiveBuffer.flush() || !owner.archiveBuffer.dispose()))
      ) {
        this.workspaceChanges?.observeUncertainEffects(run.id)
        return
      }
      this.nativeObservations.delete(run.id)
      void this.finalizeWorkspaceChanges(run.id).catch(() => undefined)
    }
    const interactionOwner = () => ({
      id: run.id,
      sessionId: run.sessionId,
      agentId: run.agentId,
      bindingGeneration: run.bindingGeneration ?? 1,
      executorId: this.conversations.findRun(run.id)?.executorId ?? adapter.executorId,
      valid: () =>
        stillOwned() && (currentControl() || Boolean(adapter.hasActiveBackgroundWork?.(run.id))),
    })
    try {
      this.publish(this.conversations.updateAttempt(run.id, 1, false))
      this.publish(this.conversations.recordNativeEffects(run.id, 'pending'))
      promptEnvelope.collaboration = this.conversations.collaboration(run.sessionId, run.id, false)
      promptEnvelope.collaborationAuthorization = this.conversations.collaborationTurnAuthorization(
        run.id,
      )
      promptEnvelope.inputBatchRef =
        this.conversations.inputBatchForRun(run.id) ?? promptEnvelope.inputBatchRef
      promptEnvelope.requiredInputScopeRef =
        promptEnvelope.collaborationAuthorization?.requiredInputScopeRef ?? undefined
      // Recovery and Handoff retain their original frozen source scope, but each
      // physical reader always uses this exact current root's ephemeral capability.
      promptEnvelope.sourceGrant =
        promptEnvelope.collaboration ||
        promptEnvelope.inputBatchRef ||
        promptEnvelope.handoffContext?.some((source) => source.inputBatchRef)
          ? { runId: run.id, grant: generation }
          : undefined
      if (promptEnvelope.collaboration?.reportRecovery)
        promptEnvelope.collaboration.reportRecovery.document =
          this.conversations.collaborationCarrierSource(
            run.sessionId,
            promptEnvelope.collaboration.reportRecovery.sourceRunId,
          )
      adapter.preflightPrompt?.({
        runId: run.id,
        sessionId: run.sessionId,
        cwd,
        promptEnvelope,
        ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
        ...(context?.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        permissionMode: run.permissionMode,
        peerAssistanceAllowed,
        model: run.model,
        effort: run.effort,
      })
      const titleSource = this.sessions.find(run.sessionId)?.titleSource
      if (
        (titleSource === 'placeholder' || titleSource === 'local') &&
        !this.conversations.forkOperation(run.sessionId)
      )
        promptEnvelope.requestSessionTitle = true
      if (promptEnvelope.collaboration && !promptEnvelope.collaborationBasis)
        promptEnvelope.collaborationBasis = await this.collaborationBasis(
          promptEnvelope.collaboration,
          promptEnvelope.message.id,
          signal,
        )
      promptEnvelope.targetAgentId = run.agentId
      for await (const event of adapter.run(
        {
          runId: run.id,
          sessionId: run.sessionId,
          ...(run.answerFormat ? { answerFormat: run.answerFormat } : {}),
          permissionMode: run.permissionMode,
          recordExecutor: (executorId) => {
            if (stillOwned())
              recordDiagnostic({
                operation: 'process',
                scope: 'run',
                phase: 'started',
                sessionId: run.sessionId,
                runId: run.id,
                agentId: run.agentId,
                executorId,
              })
            if (stillOwned()) this.publish(this.conversations.recordExecutor(run.id, executorId))
          },
          observeNativeTitle: (nativeSessionId, logicalTitle) => {
            if (currentControl() && !logicalTitle) {
              this.observeNativeTitle(
                run.sessionId,
                adapter,
                nativeSessionId,
                run.bindingGeneration ?? 1,
              )
              // A prefixed read is already derived metadata. It can reconcile
              // now without waiting for another logical-title event or Turn.
              this.scheduleNativeTitleSync(run.sessionId)
            }
          },
          ...(context?.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
          nativeGeneration: generation,
          bindingGeneration: run.bindingGeneration ?? 1,
          peerAssistanceAllowed,
          cwd,
          promptEnvelope,
          model: settings.agents[run.agentId].model,
          effort: settings.agents[run.agentId].effort,
          recordDispatch: (phase, nativeId, executorId) => {
            if (stillOwned())
              recordDiagnostic({
                operation: 'send',
                scope: 'run',
                phase:
                  phase === 'possibly_sent' || phase === 'accepted'
                    ? 'dispatched'
                    : phase === 'rejected'
                      ? 'blocked'
                      : 'started',
                sessionId: run.sessionId,
                runId: run.id,
                agentId: run.agentId,
                ...(executorId ? { executorId } : {}),
              })
            if (phase === 'possibly_sent' || phase === 'accepted') execution.deliveryPossible = true
            if (stillOwned())
              this.publish(this.conversations.recordDispatch(run.id, phase, nativeId, executorId))
          },
          recordNativeEvidence: (evidence) => {
            if (
              !stillOwned() ||
              evidence.identity.bindingGeneration !== (run.bindingGeneration ?? 1) ||
              evidence.identity.runId !== run.id ||
              (this.conversations.findRun(run.id)?.executorId &&
                evidence.identity.executorId !== this.conversations.findRun(run.id)?.executorId)
            )
              return
            this.publish(this.conversations.recordNativeEvidence(evidence, 'retry'))
            if (
              evidence.kind === 'ended' &&
              evidence.source === 'live_terminal' &&
              evidence.outcome === 'completed' &&
              evidence.output?.completeness === 'complete' &&
              evidence.identity.nativeTurnId &&
              evidence.identity.executorId
            )
              completedNativeReportReceipt = {
                nativeTurnId: evidence.identity.nativeTurnId,
                source: evidence.source,
                executorId: evidence.identity.executorId,
              }
          },
          recordArchivedEvent: archive,
          readCollaborationSourcePart:
            promptEnvelope.collaboration ||
            promptEnvelope.inputBatchRef ||
            promptEnvelope.handoffContext?.some((source) => source.inputBatchRef)
              ? (raw) => {
                  try {
                    if (!stillOwned() || signal.aborted || !this.ownsFrozenSourceRoot(run))
                      throw new Error('The source reader belongs to a retired Turn.')
                    const input = collaborationSourceReadSchema.parse(raw)
                    if (input.runId !== run.id || input.grant !== generation)
                      throw new Error('This source capability does not belong to the current root.')
                    const auth = promptEnvelope.collaborationAuthorization
                    if (input.taskId && input.taskId !== auth?.taskId)
                      throw new Error('The source is outside the frozen task.')
                    if (
                      input.revision !== undefined &&
                      input.source !== 'batch' &&
                      input.revision !== auth?.baseTodoRevision
                    )
                      throw new Error('The source is not the frozen ledger version.')
                    if (input.source === 'document') {
                      if (
                        !input.document ||
                        !this.conversations.sourceDocumentAuthorized(run.id, input.document)
                      )
                        throw new Error('The document is outside this Run authorization.')
                      const body = this.conversations.collaborationDocumentRow(
                        run.sessionId,
                        input.document,
                      )
                      const page = this.conversations.readPage({
                        scope: 'collaboration-text',
                        sessionId: run.sessionId,
                        runId: body.sourceRunId ?? run.id,
                        document: input.document,
                        offset: input.offset,
                      })
                      if (page.scope !== 'collaboration-text')
                        throw new Error('The document source changed.')
                      let text = page.text.slice(0, 4096)
                      if (text.length < page.text.length && /[\uD800-\uDBFF]/u.test(text.at(-1)!))
                        text = text.slice(0, -1)
                      return {
                        source: input.source,
                        document: input.document,
                        text,
                        offset: input.offset,
                        nextOffset:
                          input.offset + text.length < input.document.chars
                            ? input.offset + text.length
                            : null,
                      }
                    }
                    const after = input.offset - 1
                    if (input.source === 'batch') {
                      const batchId = input.batchId ?? promptEnvelope.inputBatchRef?.id
                      if (!batchId) throw new Error('The frozen input Batch is unavailable.')
                      const page = this.conversations.readFrozenInputBatch(run.id, batchId, after)
                      return {
                        source: input.source,
                        offset: input.offset,
                        text: JSON.stringify(page),
                        nextOffset: page.hasMore ? page.nextOrdinal + 1 : null,
                      }
                    }
                    if (input.source === 'required_inputs') {
                      const page = this.conversations.readRequiredInputMembers(run.id, input.offset)
                      return {
                        source: input.source,
                        offset: input.offset,
                        text: JSON.stringify(page),
                        nextOffset: page.nextOffset,
                      }
                    }
                    if (input.source === 'handoff_sources') {
                      const page = this.conversations.readRunSources(run.id, input.offset)
                      return {
                        source: input.source,
                        offset: input.offset,
                        text: JSON.stringify(page),
                        nextOffset: page.nextOffset,
                      }
                    }
                    const kind = input.source === 'todos' ? 'active' : input.source
                    const page = this.conversations.readFrozenTodoIndex(run.id, kind, after)
                    return {
                      source: input.source,
                      offset: input.offset,
                      text: JSON.stringify(page),
                      nextOffset: page.hasMore ? page.nextOrdinal + 1 : null,
                    }
                  } catch (error) {
                    recordDiagnostic({
                      operation: 'native_check',
                      phase: 'failed',
                      level: 'warn',
                      scope: 'run',
                      sessionId: run.sessionId,
                      runId: run.id,
                      agentId: run.agentId,
                      runtimeBoundary: 'source_read',
                      code: classifyAgentError(error).kind,
                      runtimeErrorType:
                        diagnosticEventSchema.shape.runtimeErrorType.safeParse(
                          error instanceof Error ? error.name : 'other',
                        ).data ?? 'other',
                    })
                    throw error
                  }
                }
              : undefined,
          recordCollaborationCarrierText: (text) => {
            if (stillOwned()) this.conversations.recordCollaborationCarrierText(run.id, text)
          },
          recordCollaborationCarrier: (value) => {
            if (stillOwned()) this.conversations.recordCollaborationCarrier(run.id, value)
          },
          recordFileChange: async (change, ioSignal) => {
            if (!stillOwned()) return
            await this.workspaceChanges?.record(run.id, change, ioSignal)
            const updated = this.conversations.findRun(run.id)
            const recorded = this.workspaceChanges?.summary(run.id)
            if (
              stillOwned() &&
              updated?.dispatchPhase === 'ended' &&
              recorded &&
              recorded.fileCount > 0
            )
              this.publish(this.conversations.recordWorkspaceChanges(recorded))
          },
          recordUncertainEffects: (reason, scope) =>
            !stillOwned()
              ? undefined
              : scope === 'recorded_files'
                ? this.workspaceChanges?.uncertain(run.id, reason)
                : this.workspaceChanges?.observeUncertainEffects(run.id),
          reportNativeEffects: (report) => {
            if (!stillOwned() || report.runId !== run.id || report.generation !== generation) return
            this.publish(
              this.conversations.recordNativeEffects(run.id, report.state, report.reason),
            )
            if (report.state === 'unknown') this.workspaceChanges?.observeUncertainEffects(run.id)
            if (report.state !== 'pending') {
              release()
              this.schedulePendingRoutedContinuations()
            }
          },
          requestPermission: (request, ioSignal) =>
            this.requestNativePermission(interactionOwner(), request, ioSignal),
          requestUserInput: (request, ioSignal) =>
            this.requestNativeUserInput(interactionOwner(), request, ioSignal),
        },
        signal,
      )) {
        if (this.disposed) return
        const fact = normalizedAgentEventSchema.parse(event)
        if (!currentControl()) {
          archive(fact)
          continue
        }
        if (streamFailed)
          throw new AgentExecutionError('protocol_error', 'The stream could not be saved.', false)
        if (fact.type === 'session.title.updated') {
          if (reportedTitle) continue
        }
        if (fact.type === 'collaboration.result_incomplete') {
          buffer.flush()
          this.conversations.recordCollaborationReportFailure(run.id, fact.reason)
          continue
        }
        if (fact.type === 'collaboration.result') {
          buffer.flush()
          this.conversations.recordCollaborationResult(
            run.id,
            collaborationResultSchema.parse(fact.result),
          )
          continue
        }
        if (fact.type === 'peer.assistance.requested' && !peerAssistanceAllowed) continue
        if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') buffer.push(fact)
        else {
          buffer.flush()
          if (
            fact.type === 'text.completed' &&
            Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES
          ) {
            const { text, ...metadata } = fact
            this.publish(
              await this.conversations.completeAnswer(
                run.id,
                metadata,
                (bodySignal) => Conversation.answerParts(text, bodySignal),
                signal,
              ),
            )
          } else {
            try {
              const patch = this.conversations.applyEvent(run.sessionId, run.id, fact)
              this.publish(patch)
              if (fact.type === 'session.title.updated' && fact.origin === 'turn_result')
                reportedTitle =
                  patch.session.titleSource === 'agent' && patch.session.title === fact.title
            } catch (error) {
              // Failed optional metadata keeps the local title; the substantive Turn continues.
              if (fact.type === 'session.title.updated' && fact.origin === 'turn_result') continue
              throw error
            }
          }
          if (fact.type === 'session.title.updated' && run.agentId === 'codex') {
            const binding = this.conversations.nativeContext(run.sessionId, 'codex')
            if (binding?.nativeSessionId)
              this.observeNativeTitle(
                run.sessionId,
                adapter,
                binding.nativeSessionId,
                run.bindingGeneration ?? 1,
              )
          }
          if (fact.type === 'session.started' || fact.type === 'session.title.updated')
            this.scheduleNativeTitleSync(run.sessionId)
        }
      }
      buffer.flush()
      const saved = this.conversations.findRun(run.id)
      recordDiagnostic({
        operation: 'send',
        scope: 'run',
        phase:
          saved?.status === 'completed'
            ? 'completed'
            : saved?.failureKind === 'unknown_delivery'
              ? 'unknown_delivery'
              : 'interrupted',
        sessionId: run.sessionId,
        runId: run.id,
        agentId: run.agentId,
        durationMs: Date.now() - diagnosticStartedAt,
      })
      if (saved?.dispatchPhase !== 'ended')
        this.publish(
          this.conversations.observationUnavailable(
            run.id,
            'The native Turn has not supplied a reliable ending. Check its state or rebuild.',
          ),
        )
      else {
        this.publish(this.conversations.settleKnownNativeEnding(run.id))
        const titleBinding = this.conversations.nativeContext(run.sessionId, run.agentId)
        if (
          titleBinding?.nativeSessionId &&
          titleBinding.bindingGeneration === (run.bindingGeneration ?? 1) &&
          currentControl()
        )
          if (!reportedTitle)
            this.scheduleTitleEnrichment(adapter, run, titleBinding.nativeSessionId, cwd)
      }
    } catch (error) {
      buffer.flush()
      if (this.disposed) return
      const failure = classifyAgentError(error)
      this.conversations.finishCollaboration(run.id, false, failure.message)
      recordDiagnostic({
        operation: 'send',
        scope: 'run',
        phase: 'failed',
        level: 'warn',
        sessionId: run.sessionId,
        runId: run.id,
        agentId: run.agentId,
        code: failure.kind,
        failureSource: 'classified_error',
        runtimeBoundary: 'foreground',
        runtimeErrorType:
          diagnosticEventSchema.shape.runtimeErrorType.safeParse(
            error instanceof Error ? error.name : 'other',
          ).data ?? 'other',
        durationMs: Date.now() - diagnosticStartedAt,
      })
      const saved = this.conversations.findRun(run.id)
      if (saved?.dispatchPhase === 'ended') {
        // A known ending is independent of whether its outcome or complete body arrived.
        this.publish(this.conversations.settleKnownNativeEnding(run.id, failure))
        // The matching terminal can race foreground failure settlement. Commit
        // any already-owned late body before revalidating that original report.
        if (completedNativeReportReceipt) {
          if (owner.archiveTail) await owner.archiveTail
          this.reconcileOwnedCompletedCollaboration(run.id, completedNativeReportReceipt)
        }
      } else if (saved?.dispatchPhase === 'rejected' || saved?.dispatchPhase === 'not_sent') {
        this.publish(this.conversations.failRun(run.id, failure.kind, failure.message, false))
        const currentContext = this.conversations.nativeContext(run.sessionId, run.agentId)
        const capacityRefusedBeforeStartup =
          error instanceof NativeCapacityError &&
          saved.dispatchPhase === 'not_sent' &&
          !saved.nativeTurnId &&
          !saved.nativeOutcome &&
          !execution.deliveryPossible &&
          !adapter.hasActiveBackgroundWork?.(run.id)
        if (capacityRefusedBeforeStartup)
          this.publish(
            this.conversations.recordNativeEffects(
              run.id,
              'not_dispatched',
              'native_capacity_not_started',
            ),
          )
        const unchangedReadyBinding =
          context?.continuationState === 'ready' &&
          currentContext?.continuationState === 'ready' &&
          currentContext.nativeSessionId === context.nativeSessionId &&
          currentContext.bindingGeneration === context.bindingGeneration &&
          ((error instanceof PermissionModeRejectedError &&
            (!adapter.hasActiveBackgroundWork?.() ||
              // Claude's negative native ACK proves this gated request was
              // refused; a preserved startup Hook is not this User Turn.
              (run.agentId === 'claude' &&
                saved.dispatchPhase === 'rejected' &&
                !saved.nativeTurnId &&
                !saved.nativeOutcome &&
                !execution.deliveryPossible))) ||
            capacityRefusedBeforeStartup)
        if (
          error instanceof NativeThreadOccupiedError ||
          error instanceof NativeThreadArchivedError
        )
          this.publish(
            this.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'recovery_required',
              failure.message,
              run.bindingGeneration,
              {
                kind: failure.kind,
                message: safeNativePermissionText(failure.message, 1024),
                action: 'rebuild',
              },
            ),
          )
        else if (failure.kind === 'context_resume_failed')
          this.publish(
            this.conversations.markNativeContextsMissing(
              run.sessionId,
              [run.agentId],
              safeNativePermissionText(failure.message, 1024),
            ),
          )
        else if (!unchangedReadyBinding)
          this.publish(
            this.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'recovery_required',
              safeNativePermissionText(failure.message, 240),
              run.bindingGeneration,
              {
                kind: failure.kind,
                message: safeNativePermissionText(failure.message, 1024),
                action: 'retry',
              },
            ),
          )
      } else {
        this.workspaceChanges?.observeUncertainEffects(run.id)
        this.publish(
          this.conversations.observationUnavailable(
            run.id,
            'Pact could not confirm the native Turn. Retry checks it without reexecuting.',
          ),
        )
      }
    } finally {
      buffer.flush()
      release()
    }
  }

  private ownsFrozenSourceRoot(run: AgentRun): boolean {
    const saved = this.conversations.findRun(run.id),
      binding = this.conversations.nativeContext(run.sessionId, run.agentId)
    // A merely prepared/failed replacement candidate is not committed source
    // ownership loss. Its previous live root keeps only its original grant.
    return Boolean(
      saved &&
      !saved.forkSourceRunId &&
      saved.controlDisposition !== 'abandoned' &&
      saved.dispatchPhase !== 'ended' &&
      this.conversations.latestAgentRun(run.sessionId, run.agentId)?.id === run.id &&
      (!binding ||
        (binding.bindingGeneration === (run.bindingGeneration ?? 1) &&
          (!saved.nativeSessionId || binding.nativeSessionId === saved.nativeSessionId))),
    )
  }

  private retireChangedSourceGrants(sessionId: string, agentId: RuntimeAgentId): void {
    for (const [runId, owner] of this.nativeObservations) {
      const run = this.conversations.findRun(runId)
      if (
        run?.sessionId === sessionId &&
        run.agentId === agentId &&
        !this.ownsFrozenSourceRoot(run)
      )
        owner.adapter.retireSourceGrant?.({ runId, grant: owner.generation })
    }
  }

  /** Only a complete, authenticated ending of the still-current original root may settle its recovered report. */
  private reconcileOwnedCompletedCollaboration(
    runId: string,
    receipt: {
      nativeTurnId: string
      source: 'live_terminal' | 'stored_terminal'
      executorId?: string
    },
  ): void {
    if (this.disposed || !this.conversations.ownsNativeControl(runId)) return
    const run = this.conversations.findRun(runId)
    if (
      !run ||
      run.nativeTurnId !== receipt.nativeTurnId ||
      !run.nativeSessionId ||
      run.dispatchPhase !== 'ended' ||
      run.nativeOutcome !== 'completed'
    )
      return
    const binding = this.conversations.nativeContext(run.sessionId, run.agentId),
      task = this.conversations.collaboration(run.sessionId)
    if (
      !binding ||
      binding.nativeSessionId !== run.nativeSessionId ||
      binding.bindingGeneration !== (run.bindingGeneration ?? 1) ||
      task?.runId !== run.id ||
      task.status !== 'failed' ||
      !task.reportFailure
    )
      return
    try {
      this.publish(
        this.conversations.reconcileCompletedCollaboration({
          runId: run.id,
          nativeSessionId: run.nativeSessionId,
          nativeTurnId: receipt.nativeTurnId,
          source: receipt.source,
          ...(receipt.executorId ? { executorId: receipt.executorId } : {}),
          revision: task.revision,
        }),
      )
    } catch (error) {
      // Preserve the native carrier and ending. A missing/stale workflow candidate
      // remains unavailable rather than manufacturing a submission or acceptance.
      recordDiagnostic({
        operation: 'native_check',
        phase: 'blocked',
        level: 'warn',
        scope: 'run',
        sessionId: run.sessionId,
        runId: run.id,
        agentId: run.agentId,
        runtimeBoundary: 'workflow_reconcile',
        code: 'CONFLICT',
        runtimeErrorType:
          diagnosticEventSchema.shape.runtimeErrorType.safeParse(
            error instanceof Error ? error.name : 'other',
          ).data ?? 'other',
      })
    }
  }

  private static async withRecoveryDeadline<T>(
    controller: AbortController,
    operation: () => Promise<T>,
    cancelled: T,
  ): Promise<T> {
    if (controller.signal.aborted) return cancelled
    const interruption = Promise.withResolvers<T>()
    const aborted = (): void => interruption.resolve(cancelled)
    controller.signal.addEventListener('abort', aborted, { once: true })
    const timer = setTimeout(() => controller.abort(), DELIVERY_RECONCILIATION_TIMEOUT_MS)
    try {
      return await Promise.race([operation(), interruption.promise])
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', aborted)
    }
  }

  private promptEnvelope(
    sessionId: string,
    message: Pick<ConversationSnapshot['messages'][number], 'id' | 'content'>,
    comments: AnchoredComment[],
    handoff: HandoffBundle[] = [],
    pendingImages?: ConversationImage[],
    imageOwner?: string,
  ): AgentPromptEnvelope {
    const imageMetadata =
      pendingImages ?? this.conversations.imagesForMessage(message.id, sessionId)
    const currentImages = imageMetadata.map((image) => {
      if (!this.images) throw new Error('Image input is unavailable.')
      return this.images.resolve(sessionId, image, imageOwner)
    })
    const skillInvocation = this.conversations.skillInvocation(message.id)
    return {
      version: 'pact-agent-prompt-v1',
      sessionId,
      ...(skillInvocation ? { skillInvocation } : {}),
      message: { ...message, ...(currentImages.length ? { images: currentImages } : {}) },
      inputBatchRef: this.conversations.inputBatchForMessage(sessionId, message.id) ?? undefined,
      comments: comments.map(({ id, body, anchor }) => ({ id, body, anchor })),
      ...(handoff.length > 0
        ? {
            handoffContext: handoff.map(
              ({ messageId, speaker, content, comments: sent, images }) => ({
                messageId,
                inputBatchRef:
                  this.conversations.inputBatchForMessage(sessionId, messageId) ?? undefined,
                speaker,
                content,
                comments: sent,
                ...(images?.length
                  ? {
                      images: images.map((image) => {
                        if (!this.images) throw new Error('Saved image input is unavailable.')
                        return this.images.resolve(sessionId, image)
                      }),
                    }
                  : {}),
              }),
            ),
          }
        : {}),
    }
  }

  private async collaborationBasis(
    task: CollaborationTask,
    currentMessageId: string,
    signal: AbortSignal,
  ): Promise<AgentPromptEnvelope['collaborationBasis']> {
    const read = async (id: string | undefined) => {
      if (!id || id === currentMessageId) return undefined
      const source = await this.conversations.readCollaborationSource(task.sessionId, id, signal)
      const images = (source.images ?? []).map((image) => {
        if (!this.images) throw new Error('Task images are unavailable.')
        return this.images.resolve(task.sessionId, image)
      })
      return {
        id,
        content: source.content,
        inputBatchRef: this.conversations.inputBatchForMessage(task.sessionId, id) ?? undefined,
        comments: source.comments.map(({ id: commentId, body, anchor }) => ({
          id: commentId,
          body,
          anchor,
        })),
        ...(images.length ? { images } : {}),
      }
    }
    const original = await read(task.taskMessageId),
      latest =
        task.latestUserMessageId !== task.taskMessageId
          ? await read(task.latestUserMessageId)
          : undefined
    const report =
      task.reportRecovery && !task.reportRecovery.document
        ? await this.conversations.readCollaborationReport(task, signal)
        : undefined
    return {
      ...(original ? { original } : {}),
      ...(latest ? { latest } : {}),
      ...(report
        ? { report: { id: report.messageId, content: report.content, comments: [] } }
        : {}),
    }
  }

  private async validateCommentAnchor(
    sessionId: string,
    anchor: Extract<CommentDraftSaveInput, { mode: 'create' }>['anchor'],
  ): Promise<void> {
    if (anchor.type === 'file') {
      await this.projectFiles.validateCommentAnchor(sessionId, anchor)
      return
    }
    if (anchor.type === 'todo') {
      const todo = this.conversations.readTodoRevision(
        anchor.taskId,
        anchor.todoId,
        anchor.todoRevision,
      )
      if (!todo || this.conversations.findRun(todo.sourceRunId)?.sessionId !== sessionId)
        throw new Error('The Todo source is unavailable in this Session.')
      if (
        anchor.question &&
        (!todo.question ||
          todo.question.id !== anchor.question.id ||
          todo.question.revision !== anchor.question.revision ||
          (anchor.question.optionIndex !== undefined &&
            (todo.question.type !== 'choice' ||
              anchor.question.optionIndex >= todo.question.options.length)))
      )
        throw new Error('This answer does not match the question version.')
      if (anchor.selection) {
        if (anchor.selection.contentHash !== todo.document.sha256)
          throw new Error('The immutable Todo source changed.')
        await this.prepareMarkdown(sessionId, todo.sourceRunId, todo.document)
        if (
          this.conversations.collaborationQuote(
            sessionId,
            todo.document,
            anchor.selection.startOffset,
            anchor.selection.endOffset,
            anchor.selection.textBasis === 'plain-visible-v1'
              ? 'plain-visible-v1'
              : 'markdown-visible-v2',
          ) !== anchor.quote
        )
          throw new Error('The Todo quote no longer matches its source.')
      }
      return
    }
    if (
      anchor.textBasis !== MESSAGE_ANCHOR_TEXT_BASIS &&
      !(anchor.textBasis === 'plain-visible-v1' && (anchor.plan || anchor.report))
    ) {
      throw new Error('This Comment uses an earlier Markdown projection.')
    }
    const source = this.conversations.collaborationCommentDocument(sessionId, anchor)
    if (source) {
      if (source.sha256 !== anchor.contentHash)
        throw new Error('The immutable Comment source changed.')
      const owner = this.conversations.collaborationDocumentRow(sessionId, source).sourceRunId!
      if (anchor.textBasis !== 'plain-visible-v1')
        await this.prepareMarkdown(sessionId, owner, source)
      if (
        this.conversations.collaborationQuote(
          sessionId,
          source,
          anchor.startOffset,
          anchor.endOffset,
          anchor.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : 'markdown-visible-v2',
        ) !== anchor.quote
      )
        throw new Error('The Comment quote no longer matches its source range.')
      return
    }
    const content = this.commentMarkdown(sessionId, anchor)
    if (Conversation.hash(content) !== anchor.contentHash) {
      throw new Error('The selected message changed before this Comment could be saved.')
    }
    if (
      (await Conversation.markdownVisibleProjection(content)).slice(
        anchor.startOffset,
        anchor.endOffset,
      ) !== anchor.quote
    ) {
      throw new Error('The selected message range no longer matches its quoted text.')
    }
  }

  /** Select the bounded immutable source behind a Message's body or structured plan Comment. */
  private commentMarkdown(
    sessionId: string,
    anchor: Extract<CommentAnchor, { type: 'message' }>,
  ): string {
    if (anchor.report) {
      const run = this.conversations.findRun(anchor.report.runId)
      if (!run || run.sessionId !== sessionId || run.userMessageId !== anchor.messageId)
        throw new Error('The selected Review source is unavailable.')
      const result = this.conversations.collaborationReportSource(sessionId, run.id)
      if (!result) throw new Error('The selected Review report is unavailable.')
      return collaborationReportMarkdown(result, anchor.report.target)
    }
    if (anchor.plan) {
      const run = this.conversations.findRun(anchor.plan.runId)
      if (!run || run.sessionId !== sessionId || run.userMessageId !== anchor.messageId)
        throw new Error('The selected plan source is unavailable.')
      const task = this.conversations.collaboration(sessionId, run.id)
      if (!task?.plan || task.planVersion !== anchor.plan.version)
        throw new Error('The selected plan version is unavailable.')
      return task.plan
    }
    const natural = this.conversations.naturalMessageProjection(anchor.messageId, sessionId)
    if (natural !== undefined && Conversation.hash(natural) === anchor.contentHash) return natural
    const metadata = this.conversations.messageMetadata(anchor.messageId, sessionId)
    if (!metadata) throw new Error('The selected message is unavailable.')
    if (metadata.contentBytes > CONVERSATION_MARKDOWN_BYTES)
      throw new Error('Text Comments are unavailable on long plain-text Messages.')
    const message = this.conversations.internalMessage(anchor.messageId, sessionId)
    if (!message) throw new Error('The selected message is unavailable.')
    return message.content
  }

  private isConflict(error: unknown): boolean {
    return error instanceof Error && /changed|active Run|already exists/u.test(error.message)
  }

  private ownsExecution(execution: ActiveExecution, runId: string): boolean {
    return (
      !this.disposed &&
      !execution.cancelledByUser &&
      this.activeExecutions.get(execution.run.sessionId) === execution &&
      execution.run.id === runId
    )
  }

  private static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private static async markdownVisibleProjection(markdown: string): Promise<string> {
    const projection = await import('../../shared/message-anchor-text')
    return projection.markdownVisibleProjection(markdown)
  }

  private async adapterFor(
    sessionId: string,
    agentId: RuntimeAgentId,
    executablePath: string,
    signal?: AbortSignal,
    cwd?: string,
    onAcquired?: (adapter: AgentAdapter) => void,
  ): Promise<AgentAdapter> {
    // Serialize only slot replacement, not Runs. A disposing Adapter still
    // owns its slot until the child/session cleanup has actually settled.
    const previous = this.adapterSlotTail
    const gate = Promise.withResolvers<void>()
    this.adapterSlotTail = gate.promise
    await previous
    try {
      if (this.disposed || signal?.aborted)
        throw new Error('Pact is shutting down or recovery was cancelled.')
      if (this.nativeQuitSealed()) throw new RunOperationConflictError('Pact is preparing to exit.')
      if (!cwd) throw new Error('The Agent Adapter requires a confirmed project directory.')
      const key = `${sessionId}:${agentId}`
      const cached = this.adapters.get(key)
      if (cached?.executablePath === executablePath && cached.cwd === cwd) {
        this.adapters.delete(key)
        this.adapters.set(key, cached)
        onAcquired?.(cached.adapter)
        return cached.adapter
      }
      if (cached) {
        if ([...this.nativeChecks.values()].some((owner) => owner.adapter === cached.adapter))
          throw new RunOperationConflictError(
            'The previous native check is still using this Adapter. Its configuration was not replaced.',
          )
        if (cached.adapter.hasActiveBackgroundWork?.())
          throw new RunOperationConflictError(
            'The previous native runtime still has background work. Its configuration will not be replaced while it is running.',
          )
        const title = this.titleEnrichments.get(sessionId)
        if (title?.agentId === agentId) {
          this.cancelTitleEnrichment(sessionId)
          await title.promise
        }
        if (agentId === 'codex') await this.cancelNativeTitleSync(sessionId)
        await cached.adapter.dispose()
        this.adapters.delete(key)
      }
      while (this.adapters.size >= MAX_ADAPTER_SLOTS) {
        const idle = [...this.adapters].find(
          ([, candidate]) =>
            !candidate.adapter.hasActiveBackgroundWork?.() &&
            [...this.nativeChecks.values()].every((owner) => owner.adapter !== candidate.adapter) &&
            [...this.skillDiscoveries.values()].every(
              (owner) =>
                owner.sessionId !== candidate.sessionId || owner.agentId !== candidate.agentId,
            ) &&
            [...this.activeExecutions.values()].every(
              (execution) =>
                execution.run.sessionId !== candidate.sessionId ||
                execution.protectedAgentId !== candidate.agentId,
            ) &&
            [...this.nativeRebuilds.entries()].every(
              ([rebuildSessionId, rebuild]) =>
                rebuildSessionId !== candidate.sessionId || rebuild.agentId !== candidate.agentId,
            ) &&
            [...this.preparingSends.values()].every(
              (preparing) =>
                preparing.input.sessionId !== candidate.sessionId ||
                preparing.protectedAgentId !== candidate.agentId,
            ) &&
            [...this.preparingContinuations.values()].every(
              (preparing) =>
                preparing.sessionId !== candidate.sessionId ||
                preparing.protectedAgentId !== candidate.agentId,
            ) &&
            [...this.nativeForks.values()].every(
              (owner) => (owner.sessionId ?? owner.sourceSessionId) !== candidate.sessionId,
            ),
        )
        if (!idle) throw new Error('No idle Agent Adapter slot is available.')
        const [idleKey, candidate] = idle
        const title = this.titleEnrichments.get(candidate.sessionId)
        if (title?.agentId === candidate.agentId) {
          this.cancelTitleEnrichment(candidate.sessionId)
          // oxlint-disable-next-line eslint/no-await-in-loop -- A title must release this slot before its Adapter can be disposed.
          await title.promise
        }
        if (candidate.agentId === 'codex') {
          // oxlint-disable-next-line no-await-in-loop -- Metadata writes settle before their Adapter slot can be reclaimed.
          await this.cancelNativeTitleSync(candidate.sessionId)
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reclaim each slot completely before admitting its replacement.
        await candidate.adapter.dispose()
        this.adapters.delete(idleKey)
      }
      if (this.disposed || signal?.aborted)
        throw new Error('Pact is shutting down or recovery was cancelled.')
      const adapter =
        agentId === 'claude'
          ? new ClaudeAgentAdapter(executablePath)
          : new CodexAgentAdapter(executablePath)
      this.adapters.set(key, { sessionId, agentId, executablePath, cwd, adapter })
      adapter.setSkillCatalogListener?.(() => {
        if (this.adapters.get(key)?.adapter !== adapter) return
        this.skillCatalogs.delete(key)
        const discovery = this.skillDiscoveries.get(key)
        if (discovery) {
          discovery.invalidated = true
          discovery.controller.abort()
        }
      })
      onAcquired?.(adapter)
      return adapter
    } finally {
      gate.resolve()
    }
  }

  private scheduleTitleEnrichment(
    adapter: AgentAdapter,
    run: AgentRun,
    nativeSessionId: string,
    cwd: string,
  ): void {
    if (!adapter.enrichTitle || this.disposed || this.nativeQuitSealed()) return
    this.cancelTitleEnrichment(run.sessionId)
    const abortController = new AbortController()
    const promise = adapter
      .enrichTitle(
        {
          runId: run.id,
          sessionId: run.sessionId,
          nativeSessionId,
          cwd,
          observeNativeTitle: (nativeId, logicalTitle) => {
            if (
              !logicalTitle &&
              !abortController.signal.aborted &&
              this.conversations.ownsNativeControl(run.id)
            )
              this.observeNativeTitle(run.sessionId, adapter, nativeId, run.bindingGeneration ?? 1)
          },
        },
        abortController.signal,
      )
      .then((title) => {
        if (!title || this.disposed || abortController.signal.aborted) return undefined
        const event: import('@pact/contracts').NormalizedAgentEvent = {
          agentId: run.agentId,
          type: 'session.title.updated',
          title,
        }
        this.publish(
          this.conversations.ownsNativeControl(run.id)
            ? this.conversations.applyEvent(run.sessionId, run.id, event)
            : this.conversations.applyArchivedEvent(run.sessionId, run.id, event),
        )
        if (this.conversations.ownsNativeControl(run.id))
          this.observeNativeTitle(
            run.sessionId,
            adapter,
            nativeSessionId,
            run.bindingGeneration ?? 1,
          )
        return undefined
      })
      .catch(() => undefined)
      .finally(() => {
        const active = this.titleEnrichments.get(run.sessionId)
        if (active?.runId === run.id) this.titleEnrichments.delete(run.sessionId)
        this.scheduleNativeTitleSync(run.sessionId)
      })
    this.titleEnrichments.set(run.sessionId, {
      runId: run.id,
      agentId: run.agentId,
      abortController,
      promise,
    })
  }

  private cancelTitleEnrichment(sessionId: string): void {
    const active = this.titleEnrichments.get(sessionId)
    if (!active) return
    this.titleEnrichments.delete(sessionId)
    active.abortController.abort()
  }

  private publish(patch: ConversationPatch, progress = false): void {
    if (!progress) this.nativeMetadataChanged()
    if (!progress) patch.forkBlocked = this.forkBlocked(patch.sessionId)
    if (!progress)
      patch.sessionIssues = this.sessionIssues(patch.sessionId, patch.nativeContexts ?? [])
    // Interaction changes publish non-progress facts. Do not inflate every
    // high-frequency Delta or leak private details into the stream window.
    if (!progress) patch.pendingNativeInteractions = this.pendingNativeInteractions(patch.sessionId)
    if (!progress && Buffer.byteLength(JSON.stringify(patch)) > CONVERSATION_PATCH_BYTES) {
      // Recovery projection is mandatory; large durable bodies are read through existing pagination.
      const activityRunIds = [
        ...new Set([
          ...patch.activities.map((item) => item.activity.runId),
          ...(patch.resync?.activityRunIds ?? []),
        ]),
      ].slice(0, 4)
      patch.messages = patch.messages.map(
        ({ message, hasActivities, hasComments, contentBytes }) => ({
          message,
          hasActivities,
          hasComments,
          ...(contentBytes === undefined ? {} : { contentBytes }),
          mode: 'invalidate' as const,
        }),
      )
      patch.runs = []
      patch.activities = []
      if (patch.comments)
        patch.comments = {
          revision: patch.comments.revision,
          upserts: [],
          removedIds: [],
          ...(patch.comments.sent ? { sent: patch.comments.sent } : {}),
        }
      patch.resync = {
        messages: true,
        drafts: Boolean(patch.comments) || Boolean(patch.resync?.drafts),
        activityRunIds,
      }
      conversationPatchSchema.parse(patch)
    }
    if (!progress) this.activeExecutions.get(patch.sessionId)?.streamBuffer?.publishPending()
    if (progress && !this.interestedSessionIds.has(patch.sessionId)) {
      this.suppressedProgress += 1
      return
    }
    if (progress) this.publishedProgress += 1
    for (const listener of this.listeners) listener(patch, progress)
  }

  private recoveryResult(sessionId: string): RpcResult<ConversationPatch> {
    const patch = this.conversations.contextPatch(sessionId)
    this.publish(patch)
    return { ok: true, value: patch }
  }

  private sessionIssues(
    sessionId: string,
    contexts: NonNullable<ConversationPatch['nativeContexts']>,
  ): SessionIssues {
    if (this.conversations.forkOperation(sessionId)?.ready === false)
      return { sessionId, inputGate: 'read_only', agents: [] }
    if (
      [...this.nativeForks.values()].some(
        (owner) => owner.sourceSessionId === sessionId && owner.sessionId !== sessionId,
      )
    )
      return { sessionId, inputGate: 'send_blocked', agents: [] }
    const runs = (['codex', 'claude'] as const).map((agentId) => {
      const context = contexts.find((item) => item.agentId === agentId)
      return (
        (!context ? this.conversations.unacknowledgedNativeRun(sessionId, agentId) : undefined) ??
        this.conversations.latestAgentRun(sessionId, agentId, context?.bindingGeneration)
      )
    })
    const cursors = contexts.map((context) =>
      context.lastRunId ? this.conversations.findRun(context.lastRunId) : undefined,
    )
    const incomplete = runs.flatMap((run) =>
      run?.dispatchPhase === 'ended' && !this.conversations.hasCompleteResponse(run.id)
        ? [run.id]
        : [],
    )
    const projection = presentSessionIssues(
      sessionId,
      contexts,
      runs,
      cursors,
      incomplete,
      this.conversations.rebuildOperations(sessionId),
    )
    for (const issue of projection.agents) {
      if (this.nativeChecks.has(`${sessionId}:${issue.agentId}:rebuild`)) {
        issue.phase = 'checking'
        issue.action = 'none'
        issue.title = `Checking ${issue.agentId === 'codex' ? 'Codex' : 'Claude Code'} session`
        issue.reason = ''
      }
      issue.abandon ||= this.conversations.bindingHasUnsettledWork(
        sessionId,
        issue.agentId,
        issue.generation,
      )
    }
    return projection
  }

  private forkBlocked(sessionId: string): boolean {
    return (
      this.hasSessionOperation(sessionId, true) ||
      this.conversations.sessionHasNativeWork(sessionId) ||
      this.conversations.sourceHasPendingFork(sessionId) ||
      this.conversations.forkOperation(sessionId)?.ready === false
    )
  }

  private static shuttingDown(): RpcResult<never> {
    return { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' } }
  }

  private static delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timeout = setTimeout(finish, milliseconds)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private static localTitle(content: string): string {
    const plain = content
      .replace(/```[\s\S]*?```/gu, ' ')
      .replace(/[`*_>#()[\]]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (!plain) return 'New session'
    const characters = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(plain),
      ({ segment }) => segment,
    )
    const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(plain)
    if (containsCjk) return characters.length > 20 ? `${characters.slice(0, 20).join('')}…` : plain
    const words = plain.split(' ').slice(0, 8).join(' ')
    return words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words
  }

  private static peerActionCopy(kind: PeerRequestKind, source: string): string {
    switch (kind) {
      case 'supplement':
        return `Supplement ${source}’s previous response.`
      case 'fact_check':
        return `Verify the key facts in ${source}’s previous response.`
      case 'challenge':
        return `Challenge the assumptions and conclusions in ${source}’s previous response.`
      case 'review':
        return `Review ${source}’s previous response.`
    }
    throw new Error('Unsupported peer request kind.')
  }

  private static pendingContinuationFailureCopy(agentId: RuntimeAgentId, error: unknown): string {
    const name = agentId === 'claude' ? 'Claude Code' : 'Codex'
    const detail = error instanceof Error ? error.message.trim() : ''
    return `${name} could not start the second @all response.${detail ? ` ${detail.slice(0, 300)}` : ''}`
  }
}
