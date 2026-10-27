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
  ConversationQueueActionInput,
  ConversationQueueReturnInput,
  ConversationQueueEnabledInput,
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
  DecisionInput,
  DecisionEvaluationOutcome,
  RelayDecisionMaterial,
  HandoffGuidanceProposal,
  WorkflowRelayCandidateId,
  InputRoutingProposal,
  SchedulingHandoff,
  SchedulingState,
  SchedulingStateInput,
  SchedulingEligibility,
  DecisionCapability,
  DecisionPhysicalWitness,
  SchedulingModelSelection,
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
  type AgentRunInput,
  type AgentNativeCheckOperation,
  type AgentNativeCheckContext,
  type AgentPromptEnvelope,
  type AgentNativeForkInput,
} from '@pact/agent-runtime'
import { conversationStreamTraceSchema, STREAM_TRACE_TTL_MS } from '@pact/contracts'
import {
  COLLABORATION_PROTOCOL,
  collaborationTaskSchema,
  advanceCollaboration,
  collaborationNextStage,
  collaborationInputGate,
  collaborationStageLabel,
  otherAgent,
  collaborationMarkdownPageSchema,
  type CollaborationTask,
  type CollaborationActionInput,
  handoffGuidanceProposalSchema,
  HANDOFF_GUIDANCE_VERSION,
  decisionJsonBytes,
  schedulingSettingsSchema,
  schedulingStateSchema,
  schedulingCheckPhysicalOwnerSchema,
  schedulingStateInputSchema,
  SCHEDULING_CAPABILITY_TTL_MS,
  SCHEDULING_CAPABILITY_RESIDENT_BYTES,
  DECISION_PHYSICAL_RECEIPT_ITEMS,
  DECISION_CLEANUP_TARGET_MS,
  relayDecisionAnswerSchema,
  preparedInputContinueSchema,
  relayDecisionReceiptReadSchema,
  type RelayDecisionAnswer,
  type RelayDecisionReceipt,
  type RelayDecisionReceiptRead,
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
  PreparedInformationConflictError,
  OversizedConversationEntityError,
  ProjectCatalogRepository,
  SessionRepository,
  StaleConversationCursorError,
  WorkspaceArchiveConflictError,
} from '@pact/persistence'

import type { DecisionRuntime } from './decision-runtime'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { LogicalIpcWorkerTraffic, observeWorkerTraffic } from '../../shared/logical-ipc-traffic'
import { OwnedProcessGroup } from '../owned-process-group'
import { ProjectFileReader } from '../project-file/project-file-reader'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import { WorkspaceChanges, WorkspaceChangeError } from '../workspace-changes/workspace-changes'
import {
  AgentExecutionError,
  PermissionModeRejectedError,
  NativeThreadOccupiedError,
  NativeThreadArchivedError,
  NativeCapacityError,
  NativeInputWithheldError,
  classifyAgentError,
} from './agent-execution-error'
import { AgentStreamBuffer } from './agent-stream-buffer'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { ClaudeDecisionRuntime } from './claude-decision-runtime'
import { CodexAgentAdapter } from './codex-agent-adapter'
import { CodexDecisionRuntime, type DecisionInputLoader } from './codex-decision-runtime'
import { ConversationImages } from './conversation-images'
import { pathlessExecutionInput, restoreExecutionInput } from './execution-input'
import { FrozenSourceReader } from './frozen-source-reader'
import { encodeNativeJsonFrame } from './native-json-encoder'
import { safeNativePermissionText } from './native-permission-wait'
import { NativeWorkingMemory, type NativeMemoryAllocator } from './native-working-memory'
import {
  evaluateRelayPolicy,
  relayWorkflowPolicyFacts,
  type RelayPolicyAdmission,
  type RelayAction,
} from './relay-policy'
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
  promptEnvelope?: AgentPromptEnvelope | undefined
  steering?:
    | {
        operationId: string
        inputId: string
        invocation?: FrozenSkillInvocation | undefined
        task: Promise<RpcResult<ConversationPatch>>
      }
    | undefined
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

interface DecisionInvocationOwner {
  kind: 'evaluation'
  operationId: string
  runtime?: DecisionRuntime | undefined
  sessionId: string
  handoff: SchedulingHandoff | undefined
  controller: AbortController
  current: () => boolean
  consulting: boolean
  reserved?: boolean
  settling?: boolean
}

interface DecisionProbeOwner {
  kind: 'probe'
  operationId: string
  sessionId: string | null
  key: string
  controller: AbortController
  current: () => boolean
  runtime?: DecisionRuntime | undefined
  task?: Promise<RpcResult<SchedulingState>> | undefined
  reserved?: boolean
  settling?: boolean
}

interface DecisionCapabilityObservation {
  sessionId: string | null
  scopeKey: string
  configurationKey: string
  generation: number
  capability: DecisionCapability
  expiresAt: string
}

interface SendOptions {
  collaborationActionReceiptId?: string | undefined
  preparedInput?: import('@pact/persistence').PreparedInputDispatch | undefined
  inputRouting?: InputRoutingProposal | undefined
  inputRoutingCurrent?: (() => boolean) | undefined
  preparationDeadlineAt?: number | undefined
  schedulingHandoff?: import('@pact/contracts').SchedulingHandoff | undefined
  handoffGuidance?:
    | {
        proposal: HandoffGuidanceProposal
        current: () => boolean
        reservation: import('./native-working-memory').NativeMemoryReservation
      }
    | undefined
  imageOwnerKey?: string

  preserveDraftComments?: boolean
  sourceProposalId?: string
  sourceMessageId?: string
  collaboration?: CollaborationTask | undefined
  expectedCollaborationRevision?: number | undefined
  receivedInputId?: string | undefined
  receivedComments?: AnchoredComment[] | undefined
  queuedRoute?: ConversationMessageRoute | undefined
}

interface PreparingContinuation {
  sessionId: string
  userMessageId: string
  protectedAgentId: RuntimeAgentId
  controller: AbortController
  completion?: Promise<void> | undefined
}

interface OwnedStreamTrace {
  data: import('@pact/contracts').ConversationStreamTrace
  startedAt: number
  expiresAt: number
  reservation: import('./native-working-memory').NativeMemoryReservation
}

interface NativeObservation {
  sourceReader?: FrozenSourceReader | undefined
  streamTrace?: OwnedStreamTrace | undefined
  generation: string
  adapter: AgentAdapter
  archiveBuffer?: AgentStreamBuffer
  archiveTail?: Promise<void> | undefined
  archivePending: number
  archiveController: AbortController
  archiveMemory: NativeWorkingMemory
  outputFailure?: AgentExecutionError
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
  /** One finite receipt-check intent per interested Session; never rotated by message resync. */
  private readonly steerReceiptChecks = new Map<string, string>()
  private lastSettledStreamTrace: OwnedStreamTrace | undefined
  private suppressedProgress = 0
  private publishedProgress = 0
  private readonly activeExecutions = new Map<string, ActiveExecution>()
  private readonly nativeRebuilds = new Map<string, ActiveNativeRebuild>()
  private readonly preparingSends = new Map<string, PreparingSend>()
  private readonly collaborationActions = new Map<
    string,
    { request: string; task: Promise<RpcResult<ConversationPatch>> }
  >()
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
      physicalCompletion: Promise<void>
      physicalOperations: Set<Promise<void>>
      logicalTimeout: () => void
      phase: 'checking' | 'cleanup_unconfirmed'
      automaticAttemptId?: string | undefined
      configurationGeneration?: number | undefined
      adapter?: AgentAdapter | undefined
      receiptSessionId?: string | undefined
    }
  >()
  private adapterSlotTail: Promise<void> = Promise.resolve()
  private pendingContinuationScheduled = false
  private pendingContinuationWakeAgain = false
  private pendingContinuationImmediate: NodeJS.Immediate | undefined
  private workflowCandidateCursor: { updatedAt: string; id: string } | undefined
  private workflowCandidateRescan = false
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
  private decisionRuntime: DecisionInvocationOwner | DecisionProbeOwner | undefined
  private decisionRecovery: Promise<void> | undefined
  private decisionRecoveryOwner: { operationId: string; sessionId: string | null } | undefined
  private hostDecisionCapability: DecisionCapabilityObservation | undefined
  private contextDecisionCapability: DecisionCapabilityObservation | undefined
  private schedulingListener: (() => void) | undefined

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectCatalogRepository,
    private readonly runtimePreparation: RuntimePreparation,
    private readonly projectFiles: ProjectFileReader,
    private readonly workspaceChanges?: WorkspaceChanges,
    private readonly images?: ConversationImages,
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    private readonly modelCatalogs?: import('../default-session-settings/default-session-settings').DefaultSessionSettings,
  ) {
    this.conversations.archives.recover(this.archiveOwnerId)
    this.conversations.expireNativePermissions()
    this.conversations.recoverInterruptedRuns()
    this.conversations.recoverCollaborationTasks()
    this.conversations.recoverForkIntents()
    this.conversations.beginSchedulingRecoveryEpoch(randomUUID())
    this.schedulePendingRoutedContinuations()
    void this.recoverDecisionReservation()
  }

  subscribeSchedulingChanges(listener: () => void): () => void {
    if (this.schedulingListener) throw new Error('Scheduling already has its Utility subscriber.')
    const unsubscribe = this.conversations.subscribeSchedulingChanges(listener)
    this.schedulingListener = listener
    return () => {
      if (this.schedulingListener === listener) this.schedulingListener = undefined
      unsubscribe()
    }
  }

  getSchedulingSettings(): RpcResult<import('@pact/contracts').SchedulingSettings> {
    const parsed = schedulingSettingsSchema.safeParse(this.conversations.schedulingSettings())
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Scheduling settings could not be confirmed.' },
        }
  }

  private schedulingScope(sessionId: string | undefined) {
    if (!sessionId) return { sessionId: null, cwd: undefined, key: 'host' }
    const session = this.sessions.find(sessionId)
    const project = session && this.projects.find(session.projectId)
    if (!session || !project)
      throw new RunOperationConflictError('The scheduling context is unavailable.')
    return {
      sessionId,
      cwd: project.directoryPath,
      key: JSON.stringify([sessionId, project.id, project.directoryPath]),
    }
  }

  private schedulingObservation(
    saved: DecisionCapabilityObservation | undefined,
    scope: ReturnType<Conversation['schedulingScope']>,
  ): SchedulingState['host'] {
    if (!saved || saved.sessionId !== scope.sessionId)
      return { status: 'unconfirmed', capability: null, expiresAt: null }
    const stale =
      saved.scopeKey !== scope.key ||
      saved.generation !== this.conversations.schedulingConfigurationGeneration() ||
      saved.configurationKey !== this.runtimePreparation.catalogIdentity(scope.cwd) ||
      Date.parse(saved.expiresAt) <= Date.now()
    return {
      status: stale ? 'stale' : saved.capability.status,
      capability: saved.capability,
      expiresAt: saved.expiresAt,
    }
  }

  private schedulingEligibility(
    sessionId: string,
    observation: SchedulingState['host'],
  ): SchedulingEligibility {
    const settings = this.conversations.schedulingSettings()
    if (!settings.enabled) return 'disabled'
    if (!settings.selection) return 'model_required'
    const session = this.sessions.find(sessionId)
    if (
      !session ||
      session.status === 'archived' ||
      this.projects.find(session.projectId)?.archivedAt ||
      this.conversations.archives.blocksSession(sessionId)
    )
      return 'archived'
    if (this.pendingNativeInteractions(sessionId).length) return 'native_interaction'
    const task = this.conversations.collaboration(sessionId)
    if (task?.automation === 'paused') return 'paused'
    if (
      this.conversations.receivedCollaborationInput(sessionId) ||
      this.conversations.hasPendingRoutedContinuation(sessionId) ||
      (task && collaborationInputGate(task))
    )
      return 'input_pending'
    if (this.conversations.nativeRecoveryBlocksInput(sessionId)) return 'recovery_required'
    if (
      this.hasSessionOperation(sessionId, true) ||
      this.decisionRuntime ||
      this.decisionRecovery ||
      this.conversations.activeSchedulingRuntimeOwner()
    )
      return 'busy'
    return observation.status === 'supported'
      ? 'available'
      : observation.status === 'unavailable'
        ? 'unavailable'
        : 'unconfirmed'
  }

  /** Pure projection: neither reading Settings nor the indicator starts native work. */
  getSchedulingState(raw: SchedulingStateInput): RpcResult<SchedulingState> {
    try {
      const input = schedulingStateInputSchema.parse(raw)
      const scope = this.schedulingScope(input.sessionId)
      const observation = scope.sessionId
        ? this.schedulingObservation(this.contextDecisionCapability, scope)
        : null
      const owner = this.conversations.activeSchedulingRuntimeOwner()
      const live = this.decisionRuntime
      const activity: SchedulingState['activity']['decision'] =
        owner && owner.kind !== 'check'
          ? {
              status:
                owner.phase === 'cleanup_unconfirmed' ||
                live?.settling ||
                !live ||
                live.operationId !== owner.id
                  ? 'cleanup_unconfirmed'
                  : owner.kind === 'probe'
                    ? 'inspecting'
                    : 'evaluating',
              operationId: owner.id,
              sessionId: owner.sessionId,
            }
          : live?.settling && live.runtime
            ? {
                status: 'cleanup_unconfirmed',
                operationId: live.operationId,
                sessionId: live.sessionId,
              }
            : this.decisionRecoveryOwner
              ? { status: 'cleanup_unconfirmed', ...this.decisionRecoveryOwner }
              : { status: 'idle' }
      const value = schedulingStateSchema.parse({
        settings: this.conversations.schedulingSettings(),
        configurationGeneration: this.conversations.schedulingConfigurationGeneration(),
        host: this.schedulingObservation(
          this.hostDecisionCapability,
          this.schedulingScope(undefined),
        ),
        context:
          scope.sessionId && observation
            ? {
                sessionId: scope.sessionId,
                observation,
                eligibility: this.schedulingEligibility(scope.sessionId, observation),
              }
            : null,
        activity: {
          decision: activity,
          check:
            owner?.kind === 'check' && owner.sessionId
              ? {
                  status:
                    owner.phase !== 'cleanup_unconfirmed' &&
                    [...this.nativeChecks.values()].find(
                      (entry) => entry.automaticAttemptId === owner.id,
                    )?.phase === 'checking'
                      ? 'checking'
                      : 'cleanup_unconfirmed',
                  operationId: owner.id,
                  sessionId: owner.sessionId,
                }
              : { status: 'idle' },
        },
      })
      return { ok: true, value }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  /** Explicit, zero-Turn refresh shares the exact physical owner used by evaluations. */
  async refreshSchedulingState(raw: SchedulingStateInput): Promise<RpcResult<SchedulingState>> {
    try {
      const input = schedulingStateInputSchema.parse(raw)
      if (this.disposed) return Conversation.shuttingDown()
      if (this.nativeQuitSealed()) return Conversation.quitPrepared()
      const scope = this.schedulingScope(input.sessionId)
      const settings = this.conversations.schedulingSettings()
      if (!settings.selection) return this.getSchedulingState(input)
      const generation = this.conversations.schedulingConfigurationGeneration()
      const configurationKey = this.runtimePreparation.catalogIdentity(scope.cwd)
      const key = JSON.stringify([scope.key, generation, configurationKey, settings.selection])
      const live = this.decisionRuntime
      if (live?.kind === 'probe' && live.key === key && live.task) return live.task
      if (live || this.conversations.activeSchedulingRuntimeOwner() || this.decisionRecovery) {
        void this.recoverDecisionReservation()
        return this.getSchedulingState(input)
      }
      const selection = settings.selection
      const controller = new AbortController()
      const current = () => {
        if (
          this.disposed ||
          this.nativeQuitSealed() ||
          controller.signal.aborted ||
          this.conversations.schedulingConfigurationGeneration() !== generation ||
          this.runtimePreparation.catalogIdentity(scope.cwd) !== configurationKey
        )
          return false
        try {
          if (this.schedulingScope(input.sessionId).key !== scope.key) return false
          if (scope.sessionId) {
            const session = this.sessions.find(scope.sessionId)
            if (
              !session ||
              session.status === 'archived' ||
              this.projects.find(session.projectId)?.archivedAt ||
              this.conversations.archives.blocksSession(scope.sessionId)
            )
              return false
          }
          return true
        } catch {
          return false
        }
      }
      if (!current()) return this.getSchedulingState(input)
      const deadlineAt = Date.now() + 15_000
      const operationId = randomUUID()
      const owner: DecisionProbeOwner = {
        kind: 'probe',
        operationId,
        sessionId: scope.sessionId,
        key,
        controller,
        current,
      }
      this.decisionRuntime = owner
      try {
        if (
          !this.conversations.reserveSchedulingProbe({
            id: operationId,
            sessionId: scope.sessionId,
            provider: selection.provider,
            model: selection.modelId,
            configurationFingerprint: createHash('sha256').update(key).digest('hex'),
            deadlineAt,
          })
        ) {
          this.decisionRuntime = undefined
          return this.getSchedulingState(input)
        }
        owner.reserved = true
      } catch (error) {
        if (this.decisionRuntime === owner) this.decisionRuntime = undefined
        throw error
      }
      const task = Promise.resolve().then(async () => {
        let capability: DecisionCapability | undefined
        try {
          if (!current()) {
            capability = {
              provider: selection.provider,
              modelId: selection.modelId,
              status: 'unavailable',
              supported: false,
              reason: 'cancelled',
              configurationFingerprint: null,
              checkedAt: new Date().toISOString(),
              physicalReleased: true,
            }
          } else {
            const runtime = this.createSchedulingRuntime(owner, selection, scope.cwd, deadlineAt, {
              dispatch: () => {
                throw new Error('A compatibility probe cannot dispatch a Turn.')
              },
              prepared: (facts) =>
                this.conversations.recordSchedulingRuntimeWitness(operationId, facts),
            })
            owner.runtime = runtime
            capability = await runtime.probeAdmission(controller.signal)
          }
          if (current()) {
            const observation: DecisionCapabilityObservation = {
              sessionId: scope.sessionId,
              scopeKey: scope.key,
              configurationKey,
              generation,
              capability,
              expiresAt: new Date(Date.now() + SCHEDULING_CAPABILITY_TTL_MS).toISOString(),
            }
            const host = scope.sessionId ? this.hostDecisionCapability : observation
            const context = scope.sessionId ? observation : this.contextDecisionCapability
            if (
              Buffer.byteLength(JSON.stringify([host, context])) <=
              SCHEDULING_CAPABILITY_RESIDENT_BYTES
            ) {
              this.hostDecisionCapability = host
              this.contextDecisionCapability = context
            }
          }
        } catch {
          // Even a thrown callback may have started a native process. Only settlement clears it.
        }
        owner.settling = true
        const settle = async () => {
          const released = owner.runtime
            ? await owner.runtime.settlement().catch(() => false)
            : true
          this.conversations.settleSchedulingProbe(operationId, released)
          if (released && this.decisionRuntime === owner) this.decisionRuntime = undefined
          this.schedulingListener?.()
        }
        this.conversations.settleSchedulingProbe(operationId, false)
        if (!owner.runtime || capability?.physicalReleased) await settle()
        else void settle()
        this.schedulingListener?.()
        return this.getSchedulingState(input)
      })
      owner.task = task
      return await task
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  /** Both providers retain the existing global owner through every native stage and cleanup. */
  private createSchedulingRuntime(
    owner: DecisionInvocationOwner | DecisionProbeOwner,
    selection: SchedulingModelSelection,
    cwd: string | undefined,
    deadlineAt: number,
    callbacks: {
      dispatch: () => void
      reserve?: NonNullable<ConstructorParameters<typeof CodexDecisionRuntime>[0]['reserve']>
      prepared: (facts: {
        nativeGeneration: number
        witness: DecisionPhysicalWitness
        configurationFingerprint: string
      }) => void
    },
  ): DecisionRuntime {
    const physicalPrepared = (facts: {
      nativeGeneration: number
      witness: DecisionPhysicalWitness
    }) => {
      if (!owner.reserved) throw new Error('Native work requires a durable scheduling owner.')
      this.conversations.recordSchedulingRuntimeWitness(owner.operationId, facts)
    }
    const shared = {
      executable: (signal: AbortSignal) =>
        this.runtimePreparation.findRecoveryExecutable(selection.provider, signal),
      ...(cwd ? { cwd } : {}),
      current: owner.current,
      deadlineAt,
      dispatch: callbacks.dispatch,
      ...(callbacks.reserve ? { reserve: callbacks.reserve } : {}),
      retirePhysicalReceipts: (facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        signal?: AbortSignal | undefined
      }) => this.retireSchedulingPhysicalReceipts(facts),
      physicalCompletion: async (facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        nativeGeneration: number
        witness: DecisionPhysicalWitness | null
        outcome?: import('@pact/contracts').DecisionOutcome | undefined
        usage?: import('@pact/contracts').SchedulingUsage | undefined
      }) => {
        if (!owner.reserved) return
        owner.settling = true
        this.conversations.completeSchedulingRuntimePhysical(owner.operationId, {
          nativeGeneration: facts.nativeGeneration,
          witness: facts.witness,
          completed: facts.outcome?.kind === 'recommendation',
          candidateId:
            facts.outcome?.kind === 'recommendation'
              ? facts.outcome.recommendation.candidateId
              : null,
          ...(facts.usage ? { usage: facts.usage } : {}),
        })
        this.schedulingListener?.()
        // This lease stays held until every started receipt helper and file handle joins.
        await this.retireSchedulingPhysicalReceipts(facts)
      },
    }
    if (selection.provider === 'claude')
      return new ClaudeDecisionRuntime({
        ...shared,
        modelId: selection.modelId,
        ownerId: randomUUID(),
        beginNativeStage: (facts) =>
          this.conversations.beginSchedulingNativeStage(owner.operationId, facts),
        physicalPrepared,
        prepared: callbacks.prepared,
      })
    return new CodexDecisionRuntime({
      ...shared,
      beginNativeStage: (facts) =>
        this.conversations.beginSchedulingNativeStage(owner.operationId, facts),
      physicalPrepared,
      prepared: callbacks.prepared,
    })
  }

  private async retireSchedulingPhysicalReceipts(facts: {
    memory: NativeMemoryAllocator
    deadlineAt: number
    signal?: AbortSignal | undefined
  }): Promise<boolean> {
    if (process.platform !== 'win32') return true
    let cursor: string | undefined
    for (let index = 0; index < DECISION_PHYSICAL_RECEIPT_ITEMS; index++) {
      if (facts.signal?.aborted || Date.now() >= facts.deadlineAt) break
      const receipt = this.conversations.claimSchedulingPhysicalReceipt(cursor)
      if (!receipt) break
      cursor = receipt.receiptId
      // oxlint-disable-next-line no-await-in-loop -- One serial helper inside the existing decision lease and shared deadline.
      const result = await OwnedProcessGroup.cleanupPhysicalReceipt(
        receipt.witness,
        undefined,
        facts.memory,
        {
          deadlineAt: facts.deadlineAt,
          ...(facts.signal ? { signal: facts.signal } : {}),
        },
      )
      if (result === 'removed' || result === 'already_absent')
        this.conversations.acknowledgeSchedulingPhysicalReceipt(
          receipt.receiptId,
          receipt.witnessJson,
        )
    }
    return this.conversations.schedulingPhysicalReceiptCapacityAvailable()
  }

  /** The host supplies complete facts; the result cannot dispatch or authorize a business Turn. */
  async evaluateDecision(
    request:
      | DecisionInput
      | {
          handoff: SchedulingHandoff
          load: DecisionInputLoader
          retainHandoff?: boolean
        }
      | { sessionId: string; prepare: DecisionInputLoader },
    signal: AbortSignal,
  ): Promise<DecisionEvaluationOutcome> {
    const requestedHandoff = 'prepare' in request ? undefined : request.handoff
    const requestedSessionId = 'prepare' in request ? request.sessionId : request.handoff.sessionId
    const settings = this.conversations.schedulingSettings()
    if (this.disposed || !settings.enabled || !settings.selection)
      return { kind: 'unavailable', reason: 'disabled' }
    if (this.decisionRuntime) return { kind: 'unavailable', reason: 'busy' }
    const available = () => {
      if (this.disposed || this.nativeQuitSealed()) return undefined
      try {
        if (this.conversations.archives.blocksSession(requestedSessionId)) return undefined
        const session = this.sessions.find(requestedSessionId)
        if (!session || session.status === 'archived') return undefined
        const project = this.projects.find(session.projectId)
        return project && !project.archivedAt ? { session, project } : undefined
      } catch {
        return undefined
      }
    }
    const scope = available()
    if (!scope) return { kind: 'unavailable', reason: 'stale' }
    const { session, project } = scope
    const configurationKey = this.runtimePreparation.catalogIdentity(project.directoryPath)
    const configurationGeneration = this.conversations.schedulingConfigurationGeneration()
    const selectionKey = JSON.stringify([settings.enabled, settings.selection])
    if (signal.aborted || this.disposed) return { kind: 'unavailable', reason: 'cancelled' }
    if (
      !available() ||
      this.conversations.schedulingConfigurationGeneration() !== configurationGeneration ||
      this.runtimePreparation.catalogIdentity(project.directoryPath) !== configurationKey
    )
      return { kind: 'unavailable', reason: 'stale' }
    if (this.decisionRuntime) return { kind: 'unavailable', reason: 'busy' }
    let handoff = requestedHandoff
    let evaluationId: string | undefined
    let deadlineAt = 0
    let configurationFingerprint = createHash('sha256')
      .update(configurationKey + selectionKey)
      .digest('hex')
    const controller = new AbortController()
    const invocationSignal = AbortSignal.any([signal, controller.signal])
    const invocationDeadlineAt = Date.now() + 15_000
    const current = () => {
      const liveScope = available()
      if (!liveScope) return false
      const saved = this.conversations.schedulingSettings()
      return (
        liveScope.project.id === project.id &&
        liveScope.project.directoryPath === project.directoryPath &&
        !invocationSignal.aborted &&
        JSON.stringify([saved.enabled, saved.selection]) === selectionKey &&
        this.conversations.schedulingConfigurationGeneration() === configurationGeneration &&
        this.runtimePreparation.catalogIdentity(project.directoryPath) === configurationKey &&
        (!handoff || this.conversations.evaluationIsCurrent(handoff))
      )
    }
    if (!current()) return { kind: 'unavailable', reason: 'stale' }
    const existing = handoff && this.conversations.decisionEvaluationReceipt(handoff)
    // This intent owns no native resource or source body. It only merges automatic wakes.
    const owner: DecisionInvocationOwner = {
      kind: 'evaluation',
      operationId: randomUUID(),
      sessionId: session.id,
      handoff,
      controller,
      current,
      consulting: true,
    }
    this.decisionRuntime = owner
    if (existing) {
      // Inspect the stored witness, never wait for its process to exit or replay its inference.
      // An already absent owner must settle before returning the original duplicate receipt.
      await this.waitForDecisionRecovery(invocationDeadlineAt, invocationSignal)
      owner.consulting = 'load' in request && request.retainHandoff === true
      if (!owner.consulting && this.decisionRuntime === owner) this.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'duplicate' }
    }
    if (this.conversations.activeSchedulingRuntimeOwner() || this.decisionRecovery) {
      void this.recoverDecisionReservation()
      if (this.decisionRuntime === owner) this.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'busy' }
    }
    // Retain the preflight checkpoint: Quit/Archive may linearize before resource admission.
    await Promise.resolve()
    if (!current() || Date.now() >= invocationDeadlineAt) {
      if (this.decisionRuntime === owner) this.decisionRuntime = undefined
      return {
        kind: 'unavailable',
        reason: Date.now() >= invocationDeadlineAt ? 'timeout' : 'stale',
      }
    }
    const selection = settings.selection
    let runtime: DecisionRuntime
    try {
      runtime = this.createSchedulingRuntime(
        owner,
        selection,
        project.directoryPath,
        invocationDeadlineAt,
        {
          reserve: (admitted, facts) => {
            handoff = admitted.handoff
            owner.handoff = handoff
            deadlineAt = facts.deadlineAt
            if (!current()) throw new Error('Decision invocation is no longer eligible.')
            const reservation = this.conversations.reserveEvaluation({
              handoff,
              provider: selection.provider,
              model: selection.modelId,
              configurationFingerprint,
              inputSha256: createHash('sha256').update(JSON.stringify(admitted)).digest('hex'),
              deadlineAt,
            })
            if (reservation.status === 'reserved') {
              evaluationId = reservation.evaluation.id
              owner.operationId = evaluationId
              owner.reserved = true
              return 'reserved'
            }
            return reservation.status === 'duplicate' ? 'duplicate' : 'busy'
          },
          dispatch: () => {
            if (
              !evaluationId ||
              !current() ||
              !this.conversations.dispatchEvaluation(evaluationId).created
            )
              throw new Error('Decision invocation is no longer eligible.')
          },
          prepared: (facts) => {
            if (!evaluationId) throw new Error('Decision invocation is unavailable.')
            this.conversations.recordEvaluationPhysicalWitness(evaluationId, facts)
            configurationFingerprint = facts.configurationFingerprint
          },
        },
      )
    } catch {
      if (this.decisionRuntime === owner) this.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'busy' }
    }
    owner.runtime = runtime
    let outcome = await runtime.evaluateDecision(
      async (context: Parameters<DecisionInputLoader>[0]) => {
        context.signal.throwIfAborted()
        if (!current()) throw new Error('Decision invocation is no longer eligible.')
        const input =
          'prepare' in request
            ? await request.prepare(context)
            : 'load' in request
              ? await request.load(context)
              : request
        if (input.handoff.sessionId !== session.id)
          throw new Error('Decision input belongs to another Session.')
        handoff = input.handoff
        owner.handoff = handoff
        if (!current()) throw new Error('Decision invocation is no longer eligible.')
        return input
      },
      invocationSignal,
    )
    owner.consulting = 'load' in request && request.retainHandoff === true
    if (outcome.kind === 'recommendation' && !current())
      outcome = { kind: 'unavailable', reason: 'stale' }
    const terminal = runtime.invoked
      ? outcome.kind === 'recommendation'
        ? 'completed'
        : 'failed'
      : 'not_sent'
    if (evaluationId)
      this.conversations.settleEvaluation(evaluationId, {
        outcome: terminal,
        selectedCandidateId:
          outcome.kind === 'recommendation' ? outcome.recommendation.candidateId : null,
        physicalReleased: false,
        ...(runtime.usage ? { usage: runtime.usage } : {}),
      })
    void runtime
      .settlement()
      .then((released) => {
        if (evaluationId)
          this.conversations.settleEvaluation(evaluationId, {
            outcome: terminal,
            selectedCandidateId:
              outcome.kind === 'recommendation' ? outcome.recommendation.candidateId : null,
            physicalReleased: released,
            ...(runtime.usage ? { usage: runtime.usage } : {}),
          })
        if (released) {
          owner.runtime = undefined
          if (!owner.consulting && this.decisionRuntime === owner) this.decisionRuntime = undefined
          const liveScope = available()
          const unchanged =
            liveScope?.project.directoryPath === project.directoryPath &&
            this.conversations.schedulingConfigurationGeneration() === configurationGeneration &&
            this.runtimePreparation.catalogIdentity(project.directoryPath) === configurationKey
          if (
            evaluationId &&
            unchanged &&
            (outcome.kind === 'recommendation' ||
              !['cancelled', 'stale', 'busy', 'duplicate'].includes(outcome.reason))
          ) {
            const successful = outcome.kind === 'recommendation'
            const capability: DecisionCapability = {
              provider: selection.provider,
              modelId: selection.modelId,
              status: successful ? 'supported' : 'unavailable',
              supported: successful,
              reason: successful
                ? 'supported'
                : (runtime.diagnostics?.().failureReason ??
                  (outcome.kind === 'unavailable' && outcome.reason === 'timeout'
                    ? 'timeout'
                    : 'unavailable')),
              configurationFingerprint: successful ? configurationFingerprint : null,
              checkedAt: new Date().toISOString(),
              physicalReleased: true,
            }
            const observation: DecisionCapabilityObservation = {
              sessionId: session.id,
              scopeKey: this.schedulingScope(session.id).key,
              configurationKey,
              generation: configurationGeneration,
              capability,
              expiresAt: new Date(Date.now() + SCHEDULING_CAPABILITY_TTL_MS).toISOString(),
            }
            if (
              Buffer.byteLength(JSON.stringify([this.hostDecisionCapability, observation])) <=
              SCHEDULING_CAPABILITY_RESIDENT_BYTES
            )
              this.contextDecisionCapability = observation
          }
          this.schedulingListener?.()
        }
        return undefined
      })
      .catch(() => undefined)
    if (outcome.kind !== 'recommendation') return outcome
    if (!evaluationId || !deadlineAt || !handoff)
      return { kind: 'unavailable', reason: 'invalid_output' }
    return {
      ...outcome,
      evaluationReceipt: {
        evaluationId,
        handoffId: handoff.id,
        configurationGeneration,
        configurationFingerprint,
        deadlineAt,
      },
    }
  }

  /** At most one current admission and one unreconciled durable owner; identical Sessions coalesce. */
  private decisionSessionIds(): Set<string> {
    const identities = new Set<string>()
    if (this.decisionRuntime?.runtime && this.decisionRuntime.sessionId)
      identities.add(this.decisionRuntime.sessionId)
    if (this.decisionRecoveryOwner?.sessionId) identities.add(this.decisionRecoveryOwner.sessionId)
    const saved = this.conversations.activeSchedulingRuntimeOwner()
    if (saved?.sessionId) identities.add(saved.sessionId)
    return identities
  }

  private recoverDecisionReservation(): Promise<void> {
    if (this.decisionRecovery) return this.decisionRecovery
    if (this.decisionRuntime?.runtime || this.disposed) return Promise.resolve()
    const saved = this.conversations.activeSchedulingRuntimeOwner()
    if (saved?.kind === 'check') return this.recoverSchedulingCheck(saved.id)
    const hasReceipts =
      process.platform === 'win32' && this.conversations.hasSchedulingPhysicalReceipts()
    if (!saved?.physicalWitnessJson && !hasReceipts) return Promise.resolve()
    const deadlineAt = Date.now() + DECISION_CLEANUP_TARGET_MS
    const memory = new NativeWorkingMemory('decision')
    const recoveryOwner = {
      operationId: saved?.id ?? randomUUID(),
      sessionId: saved?.sessionId ?? null,
    }
    this.decisionRecoveryOwner = recoveryOwner
    const recovery = (async () => {
      if (saved?.physicalWitnessJson) {
        let witness: unknown
        try {
          witness = JSON.parse(saved.physicalWitnessJson)
        } catch {
          return
        }
        if (
          await OwnedProcessGroup.provePhysicalRelease(witness, undefined, memory, { deadlineAt })
        )
          this.conversations.settleSchedulingOwnerAfterPhysicalProof(
            saved.id,
            saved.physicalWitnessJson,
            saved.nativeGeneration,
          )
      }
      await this.retireSchedulingPhysicalReceipts({ memory, deadlineAt })
    })().catch(() => undefined)
    this.decisionRecovery = recovery
    void recovery.then(() => {
      if (this.decisionRecovery === recovery) this.decisionRecovery = undefined
      if (this.decisionRecoveryOwner === recoveryOwner) this.decisionRecoveryOwner = undefined
      this.schedulingListener?.()
      return undefined
    })
    return recovery
  }

  private recoverSchedulingCheck(id: string): Promise<void> {
    const attempt = this.conversations.schedulingRecoveryAttempt(id)
    if (
      !attempt ||
      attempt.utilityPid === process.pid ||
      !Number.isSafeInteger(attempt.utilityPid) ||
      attempt.utilityPid <= 0
    )
      return Promise.resolve()
    const recovery = (async () => {
      try {
        process.kill(attempt.utilityPid, 0)
        return
      } catch (error) {
        if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ESRCH') return
      }
      const owner = schedulingCheckPhysicalOwnerSchema.safeParse(
        JSON.parse(attempt.physicalOwnerJson),
      )
      if (!owner.success || owner.data.kind === 'inspection_pending') return
      if (
        owner.data.kind === 'inspection_group' &&
        !(await OwnedProcessGroup.provePhysicalRelease(owner.data.witness))
      )
        return
      this.conversations.settleSchedulingRecoveryCheck(id, {
        ok: false,
        physicalReleased: true,
        retire: true,
      })
    })().catch(() => undefined)
    this.decisionRecovery = recovery
    void recovery.then(() => {
      if (this.decisionRecovery === recovery) this.decisionRecovery = undefined
      this.schedulingListener?.()
      return undefined
    })
    return recovery
  }

  private async waitForDecisionRecovery(deadlineAt: number, signal: AbortSignal): Promise<void> {
    const recovery = this.recoverDecisionReservation()
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, Math.max(0, deadlineAt - Date.now()))
      signal.addEventListener('abort', finish, { once: true })
      void recovery.then(finish, finish)
      if (signal.aborted) finish()
    })
  }

  async saveSchedulingSettings(
    input: import('@pact/contracts').SchedulingSettingsSave,
  ): Promise<RpcResult<import('@pact/contracts').SchedulingSettings>> {
    try {
      if (input.selection) {
        const identity = this.runtimePreparation.catalogIdentity(process.cwd())
        if (!this.modelCatalogs || this.disposed || input.catalogIdentity !== identity)
          throw new RunOperationConflictError(
            'The native model configuration changed. Refresh models before selecting again.',
          )
        const catalogs = await this.modelCatalogs.loadModelCatalogs()
        const selection = input.selection,
          catalog = catalogs[selection.provider]
        if (
          this.disposed ||
          this.runtimePreparation.catalogIdentity(process.cwd()) !== identity ||
          catalog.status !== 'available' ||
          !catalog.models.some((model) => (model.resolvedModel ?? model.id) === selection.modelId)
        )
          throw new RunOperationConflictError(
            'This exact model is no longer available. Your saved selection is unchanged.',
          )
      }
      const generation = this.conversations.schedulingConfigurationGeneration()
      const saved = this.conversations.saveSchedulingSettings(input, (patch) => this.publish(patch))
      if (this.conversations.schedulingConfigurationGeneration() !== generation) {
        this.hostDecisionCapability = undefined
        this.contextDecisionCapability = undefined
        this.decisionRuntime?.controller.abort()
        for (const check of this.nativeChecks.values())
          if (check.automaticAttemptId) check.controller.abort()
        void this.decisionRuntime?.runtime?.dispose()
        this.schedulePendingRoutedContinuations()
      }
      return { ok: true, value: saved }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  readSchedulingActivity(
    input: import('@pact/contracts').SchedulingActivityRead,
  ): RpcResult<import('@pact/contracts').SchedulingActivityPage> {
    try {
      return { ok: true, value: this.conversations.readSchedulingActivity(input) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Scheduling activity could not be loaded.' },
      }
    }
  }

  async refreshSchedulingModels(): Promise<RpcResult<import('@pact/contracts').SchedulingModels>> {
    try {
      if (!this.modelCatalogs || this.disposed) throw new Error('Model discovery is unavailable.')
      const catalogIdentity = this.runtimePreparation.catalogIdentity(process.cwd())
      const catalogs = await this.modelCatalogs.loadModelCatalogs()
      if (
        this.disposed ||
        this.runtimePreparation.catalogIdentity(process.cwd()) !== catalogIdentity
      )
        throw new Error('Model discovery was cancelled or its configuration changed.')
      const targets = ['codex_luna', 'claude_haiku_5_5'] as const
      const savedSelection = this.conversations.schedulingSettings().selection
      return {
        ok: true,
        value: {
          catalogIdentity,
          models: targets.map((target) => {
            const provider = target === 'codex_luna' ? 'codex' : 'claude',
              catalog = catalogs[provider]
            const matches = catalog.models.filter((model) =>
              target === 'codex_luna'
                ? (model.resolvedModel ?? model.id) === 'gpt-6-luna'
                : /^claude-haiku-5-5(?:-\d{8})?$/u.test(model.resolvedModel ?? model.id),
            )
            const match =
              matches.find(
                (model) =>
                  savedSelection?.target === target &&
                  savedSelection.provider === provider &&
                  (model.resolvedModel ?? model.id) === savedSelection.modelId,
              ) ??
              matches.toSorted((left, right) =>
                (left.resolvedModel ?? left.id).localeCompare(right.resolvedModel ?? right.id),
              )[0]
            return {
              target,
              status: match
                ? 'found'
                : catalog.status === 'available'
                  ? 'not_found'
                  : 'unconfirmed',
              checkedAt: catalog.checkedAt,
              selection: match
                ? target === 'codex_luna'
                  ? { target, provider: 'codex', modelId: 'gpt-6-luna' }
                  : { target, provider: 'claude', modelId: match.resolvedModel ?? match.id }
                : null,
            }
          }),
        },
      }
    } catch {
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'Model availability could not be confirmed. Your selection is unchanged.',
        },
      }
    }
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

  /** Presentation only: use real app-wide owners, never the truncated tray groups. */
  canPresentUpdateNotice(): boolean {
    if (
      this.disposed ||
      !this.sessions.nativeInitialized() ||
      this.nativeQuitPreparation?.sealed ||
      this.activeExecutions.size ||
      this.preparingSends.size ||
      this.preparingContinuations.size ||
      this.nativeRebuilds.size ||
      this.nativeChecks.size ||
      this.forkPreparations.size ||
      this.nativeForks.size ||
      this.titleEnrichments.size ||
      this.nativeTitleSyncs.size ||
      this.skillDiscoveries.size ||
      this.workspaceChanges?.pendingSessionIds().length
    )
      return false
    try {
      const live = this.liveNativeRows()
      return (
        live.running.length === 0 &&
        live.attention.length === 0 &&
        this.conversations.pendingRoutedContinuations().length === 0 &&
        this.conversations.pendingCollaborationInputs().length === 0 &&
        this.conversations.nativeQuitUnsettled([]).count === 0
      )
    } catch {
      return false
    }
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
      for (const sessionId of this.decisionSessionIds()) identities.add(sessionId)
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
        Number(
          this.decisionRuntime?.sessionId === null ||
            this.decisionRecoveryOwner?.sessionId === null ||
            this.conversations.activeSchedulingRuntimeOwner()?.sessionId === null,
        ) +
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
      [...this.decisionSessionIds()].some(belongs) ||
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
                  nativeInputIds: this.conversations.nativeInputIdsForRun(run.id),
                  runId: run.id,
                  bindingGeneration: run.bindingGeneration,
                  throughSequence: response.sequence,
                  deliveryCursor: response.deliveryCursor,
                  responseHash: response.responseHash,
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
      observeWorkerTraffic(
        worker,
        this.ipcTraffic?.collector('utility-markdown'),
        'utility-markdown.request',
        'markdown-utility.reply',
      )
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
      if (page.scope === 'messages')
        page.header.relaySchedulingDecision = this.projectRelaySchedulingDecision(
          input.sessionId,
          page.header.sessionIssues,
        )
      if (page.scope === 'messages' && input.scope === 'messages')
        this.scheduleSteerReceiptCheck(page, input)
      if (page.scope === 'messages')
        page.header.preparedInputContinuation = this.conversations.preparedInputContinuation(
          input.sessionId,
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
          message:
            error instanceof StaleConversationCursorError ||
            error instanceof OversizedConversationEntityError
              ? error.message
              : 'Saved conversation history could not be read.',
        },
      }
    }
  }

  private projectRelaySchedulingDecision(sessionId: string, issues?: SessionIssues) {
    if (this.conversations.discardStaleRelaySchedulingDecision(sessionId))
      this.schedulePendingRoutedContinuations()
    const task = this.conversations.collaboration(sessionId)
    const card = this.conversations.relaySchedulingDecision(sessionId)
    if (!card) return null
    const recovery =
      issues ??
      this.sessionIssues(
        sessionId,
        (['codex', 'claude'] as const).flatMap((actor) => {
          const context = this.conversations.nativeContext(sessionId, actor)
          return context ? [context] : []
        }),
      )
    const nativeRecovery =
      card.request.category === 'arrangement_change' ? card.request.operation : undefined
    const representedIssue = (issue: SessionIssues['agents'][number]): boolean =>
      Boolean(
        nativeRecovery &&
        issue.action === 'rebuild' &&
        issue.agentId === nativeRecovery.agentId &&
        issue.generation === nativeRecovery.expectedGeneration &&
        (issue.nativeSessionId ?? null) === nativeRecovery.expectedNativeSessionId &&
        (issue.runId ?? null) === nativeRecovery.expectedRunId &&
        (issue.rebuildId ?? null) === nativeRecovery.expectedRebuildId &&
        issue.abandon === nativeRecovery.abandonOldWork,
      )
    if (
      this.pendingNativeInteractions(sessionId).length ||
      recovery.agents.some((issue) => !representedIssue(issue)) ||
      (!nativeRecovery && this.conversations.nativeRecoveryBlocksInput(sessionId)) ||
      (nativeRecovery &&
        ([...this.nativeChecks.keys()].some((key) => key.startsWith(`${sessionId}:`)) ||
          this.conversations.rebuildInputRecovery(sessionId))) ||
      (task &&
        (collaborationInputGate(task) || this.conversations.needsWorkflowPlanRecovery(task.runId)))
    )
      return null
    return card
  }

  getRelayDecisionReceipt(raw: RelayDecisionReceiptRead): RpcResult<RelayDecisionReceipt> {
    try {
      const input = relayDecisionReceiptReadSchema.parse(raw)
      const receipt = this.conversations.relayDecisionReceipt(input)
      if (!receipt)
        throw new RunOperationConflictError(
          'This Relay answer has not been recorded. No action was repeated.',
        )
      return { ok: true, value: receipt }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  async answerRelayDecision(raw: RelayDecisionAnswer): Promise<RpcResult<RelayDecisionReceipt>> {
    let committedCancellation: RelayDecisionReceipt | undefined
    let unusedReceiptId: string | undefined
    let unusedPrepared: import('@pact/persistence').PreparedInputDispatch | undefined
    try {
      const input = relayDecisionAnswerSchema.parse(raw)
      const sessionId = input.reference.sessionId
      if (this.disposed) return Conversation.shuttingDown()
      if (this.nativeQuitSealed()) return Conversation.quitPrepared()
      if (this.conversations.archives.blocksSession(sessionId)) return Conversation.archiveBusy()
      const existing = this.conversations.relayDecisionReceipt({
        sessionId,
        decisionId: input.reference.decisionId,
        clientOperationId: input.clientOperationId,
      })
      const card = !existing ? this.projectRelaySchedulingDecision(sessionId) : null
      // The Repository checks the original digest even for identical answer readback.
      if (!existing && input.answer.kind !== 'cancel' && !card)
        throw new RunOperationConflictError(
          'Resolve the current native or collaboration interaction before confirming this scheduling action.',
        )
      if (
        !existing &&
        input.answer.kind !== 'cancel' &&
        (card?.request.category === 'necessary_information' ||
          (input.answer.kind === 'confirm' && card?.request.category === 'arrangement_change')) &&
        (this.hasSessionOperation(sessionId) ||
          this.operationCount() >= MAX_AGENT_OPERATIONS ||
          this.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      )
        return Conversation.capacityFailure()
      const answer = this.conversations.answerRelaySchedulingDecision(input)
      // Only the successful Repository call has checked the original request digest and committed.
      if (
        input.answer.kind === 'cancel' &&
        answer.result.disposition === 'cancelled' &&
        answer.result.sessionId === sessionId &&
        answer.result.decisionId === input.reference.decisionId &&
        answer.result.clientOperationId === input.clientOperationId &&
        answer.result.runId === null &&
        answer.result.rebuildId === null
      )
        committedCancellation = answer.result
      this.publish(
        this.conversations.metadataPatch(sessionId, {
          draftsChanged: 'draftsChanged' in answer && answer.draftsChanged,
        }),
      )
      if (answer.created && 'preparedInput' in answer && answer.preparedInput) {
        unusedPrepared = answer.preparedInput.receipt
        const sent = await this.enqueueSend(answer.preparedInput.input, {
          preparedInput: unusedPrepared,
        })
        if (!sent.ok) return sent
      }
      if (answer.created && 'nativeRebuild' in answer && answer.nativeRebuild)
        this.startNativeRebuildOperation(
          sessionId,
          answer.nativeRebuild.agentId,
          answer.nativeRebuild.operationId,
        )
      if (answer.created && answer.receiptId) {
        unusedReceiptId = answer.receiptId
        const prepared = this.conversations.preparedRelayWorkflowAction(answer.receiptId)
        const dispatched = await this.startWorkflowTurn(
          prepared.task,
          prepared.next,
          input.clientOperationId,
          undefined,
          prepared.receipt.id,
          prepared.handoff,
        )
        if (!dispatched.ok) return dispatched
      }
      this.schedulePendingRoutedContinuations()
      return {
        ok: true,
        value:
          this.conversations.relayDecisionReceipt({
            sessionId,
            decisionId: input.reference.decisionId,
            clientOperationId: input.clientOperationId,
          }) ?? answer.result,
      }
    } catch (error) {
      if (committedCancellation) {
        recordDiagnostic({
          operation: 'ipc',
          scope: 'request',
          requestType: 'relay.decision.answer.request',
          phase: 'failed',
          level: 'warn',
          sessionId: committedCancellation.sessionId,
          operationId: committedCancellation.clientOperationId,
          code: 'INTERNAL',
          failureSource: 'classified_error',
          runtimeBoundary: 'projection',
          runtimeErrorType:
            diagnosticEventSchema.shape.runtimeErrorType.safeParse(
              error instanceof Error ? error.name : 'other',
            ).data ?? 'other',
        })
        // Projection failure cannot undo this fact; receipt readback never repeats the action.
        return { ok: true, value: committedCancellation }
      }
      return Conversation.sendFailure(error)
    } finally {
      if (unusedPrepared) {
        const draftsChanged = this.conversations.cancelPreparedInputDispatch(
          unusedPrepared,
          'preparation_failed',
        )
        if (!this.disposed)
          this.publish(
            this.conversations.metadataPatch(unusedPrepared.sessionId, { draftsChanged }),
          )
      }
      if (unusedReceiptId) {
        const patch = this.conversations.releaseUnusedRelayWorkflowAction(unusedReceiptId, true)
        if (patch && !this.disposed) this.publish(patch)
      }
    }
  }

  async continuePreparedInput(
    raw: import('@pact/contracts').PreparedInputContinue,
  ): Promise<RpcResult<ConversationPatch>> {
    let claimed: import('@pact/persistence').PreparedInputDispatch | undefined
    try {
      const input = preparedInputContinueSchema.parse(raw),
        old = this.conversations.readPreparedInputContinue(input)
      if (old) return { ok: true, value: old }
      if (this.disposed) return Conversation.shuttingDown()
      if (this.nativeQuitSealed()) return Conversation.quitPrepared()
      if (this.conversations.archives.blocksSession(input.sessionId))
        return Conversation.archiveBusy()
      if (
        this.hasSessionOperation(input.sessionId) ||
        this.pendingNativeInteractions(input.sessionId).length ||
        this.operationCount() >= MAX_AGENT_OPERATIONS
      )
        return Conversation.capacityFailure()
      const prepared = this.conversations.continuePreparedInput(input)
      if (!prepared.created) return { ok: true, value: prepared.patch }
      claimed = prepared.receipt
      this.publish(this.conversations.metadataPatch(input.sessionId))
      return await this.enqueueSend(prepared.input, { preparedInput: claimed })
    } catch (error) {
      return Conversation.sendFailure(error)
    } finally {
      if (claimed) {
        const draftsChanged = this.conversations.cancelPreparedInputDispatch(
          claimed,
          'preparation_failed',
        )
        if (!this.disposed)
          this.publish(this.conversations.metadataPatch(claimed.sessionId, { draftsChanged }))
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
      const held = this.conversations.heldPreparedInputPatch(input)
      if (held) return { ok: true, value: held }
      const savedTask = this.conversations.collaboration(input.sessionId)
      const task = savedTask?.status === 'complete' ? undefined : savedTask
      const preparing = this.preparingSends.has(input.clientMessageId)
      const waitingForWork = task?.status === 'running' || this.hasSessionOperation(input.sessionId)
      const received = this.conversations.receivedInputReceipt(
        input.sessionId,
        input.clientMessageId,
        input,
        waitingForWork,
      )
      if (received) {
        if (input.userInformation)
          throw new RunOperationConflictError(
            'A queued message cannot acquire a user declaration. Your draft was kept.',
          )
        return { ok: true, value: received }
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
      this.conversations.assertPreparedInputRequest({ ...input, content })
      const submitted = this.conversations.submittedRunReceipt({ ...input, content })
      if (submitted) {
        this.publish(submitted.patch)
        return { ok: true, value: submitted.patch }
      }
      if (
        input.userInformation &&
        !preparing &&
        (task ||
          waitingForWork ||
          input.returnedInputOperationId ||
          input.queueReturnOperationId ||
          input.replyToDecision ||
          input.skills?.length ||
          input.imageIds?.length ||
          input.route?.type === 'all')
      )
        throw new RunOperationConflictError(
          'Reserved information supports a new ordinary message only. Remove it before queueing, steering, replying to a workflow, using Skills, images or @all. Your draft was kept.',
        )
      this.conversations.assertRelayDecisionResolved(input.sessionId)
      this.conversations.assertDecisionInput({ ...input, content })
      if (this.conversations.receivedCollaborationInput(input.sessionId))
        throw new RunOperationConflictError(
          'One message is already queued. Your draft was preserved.',
        )
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
      const prefix = parseComposerCommandPrefix(content, input.skills)
      if (input.userInformation && (prefix.pact || prefix.skills.length || prefix.error))
        throw new RunOperationConflictError(
          'Remove reserved information before sending a command. Your draft was kept.',
        )
      if (!preparing && (task || waitingForWork)) {
        if (task && !prefix.pact && (input.route ?? prefix.route)?.type === 'all')
          throw new RunOperationConflictError('Finish or stop this Pact task before using @all.')
        const session = this.sessions.find(input.sessionId)
        if (!session || session.status === 'archived')
          throw new RunOperationConflictError('The Session is unavailable.')
        const requestedRoute = input.route ?? prefix.route
        const actor =
          requestedRoute?.type === 'agent'
            ? requestedRoute.agentId
            : task && !prefix.pact
              ? this.conversations.collaborationReplyActor(task, input.replyToDecision)
              : session.settings.primaryAgentId
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
        const anchor =
          this.activeExecutions.get(input.sessionId)?.run ??
          (task ? this.conversations.findRun(task.runId) : undefined) ??
          [
            this.conversations.latestAgentRun(input.sessionId, 'claude'),
            this.conversations.latestAgentRun(input.sessionId, 'codex'),
          ]
            .filter((run): run is AgentRun => Boolean(run))
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        if (!anchor)
          throw new RunOperationConflictError(
            'Wait for the current execution to start before queuing a message.',
          )
        const patch = this.conversations.receiveQueuedInput(
          { ...input, content },
          retainedId,
          actor,
          bodyOwner,
          anchor.id,
          waitingForWork,
        )
        this.publish(patch)
        if (task) {
          this.abortPreparedWorkflow(input.sessionId)
          for (const pending of this.permissions.values())
            if (
              pending.sessionId === input.sessionId &&
              pending.details?.kind === 'questions' &&
              pending.valid()
            )
              pending.settle({ action: 'cancel' })
        }
        this.schedulePendingRoutedContinuations()
        return { ok: true, value: patch }
      }
      const { inputId } = input
      return await this.enqueueSend(
        { ...input, content },
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

  private mutateQueue(
    sessionId: string,
    mutation: () => ConversationPatch,
  ): RpcResult<ConversationPatch> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.conversations.archives.blocksSession(sessionId)) return Conversation.archiveBusy()
    try {
      const patch = mutation()
      this.publish(patch)
      this.schedulePendingRoutedContinuations()
      return { ok: true, value: patch }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  setConversationQueueEnabled(input: ConversationQueueEnabledInput): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.conversations.setConversationQueueEnabled(input),
    )
  }

  resumeConversationQueue(input: ConversationQueueActionInput): RpcResult<ConversationPatch> {
    if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
      return Conversation.nativeRecoveryRequired()
    return this.mutateQueue(input.sessionId, () =>
      this.conversations.resumeConversationQueue(input),
    )
  }

  removeQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.conversations.removeQueuedConversationMessage(input),
    )
  }

  returnQueuedConversationMessage(
    input: ConversationQueueReturnInput,
  ): RpcResult<ConversationPatch> {
    return this.mutateQueue(input.sessionId, () =>
      this.conversations.returnQueuedConversationMessage(input),
    )
  }

  private refreshExecutionInputScope(execution: ActiveExecution): void {
    if (
      this.activeExecutions.get(execution.run.sessionId) !== execution ||
      !this.conversations.ownsNativeControl(execution.run.id)
    )
      return
    const envelope = execution.promptEnvelope
    if (!envelope) return
    const authorization = this.conversations.collaborationTurnAuthorization(execution.run.id)
    execution.promptEnvelope = {
      ...envelope,
      collaborationAuthorization: authorization,
      requiredInputScopeRef: authorization?.sourceManifestRef ?? undefined,
    }
  }

  async steerQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.conversations.archives.blocksSession(input.sessionId))
      return Conversation.archiveBusy()
    const execution = this.activeExecutions.get(input.sessionId)
    if (execution?.steering)
      return execution.steering.operationId === input.operationId
        ? execution.steering.task
        : {
            ok: false,
            error: { code: 'CONFLICT', message: 'A steering request is already being checked.' },
          }
    try {
      const receipt = this.conversations.queuedSteerReceipt(input)
      if (receipt) return { ok: true, value: receipt }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
    const run = execution && this.conversations.findRun(execution.run.id)
    const owner = run && this.nativeObservations.get(run.id)
    const adapter = execution?.adapter
    if (
      !execution ||
      !run?.nativeSessionId ||
      !run.nativeTurnId ||
      !owner ||
      !adapter?.steer ||
      execution.abortController.signal.aborted ||
      !execution.promptEnvelope
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'The current execution cannot accept native steering. Your message remains queued.',
        },
      }
    const sessionId = input.sessionId
    const signal = execution.abortController.signal
    const current = (): boolean =>
      !this.disposed &&
      this.activeExecutions.get(sessionId) === execution &&
      this.nativeObservations.get(run.id) === owner &&
      this.conversations.ownsNativeControl(run.id) &&
      !signal.aborted
    const work = Promise.resolve().then(async (): Promise<RpcResult<ConversationPatch>> => {
      let prepared = false
      const delivery = {
        phase: 'prepared' as 'prepared' | 'possibly_sent' | 'accepted' | 'rejected',
      }
      let invocation: FrozenSkillInvocation | undefined
      try {
        const queued = this.conversations.readReceivedInput(sessionId)
        if (!queued || queued.id !== input.inputId)
          throw new RunOperationConflictError('This queued message is no longer current.')
        const prefix = parseComposerCommandPrefix(queued.content, queued.metadata.skills)
        if (prefix.pact || queued.metadata.route?.type === 'all' || queued.actor !== run.agentId)
          throw new RunOperationConflictError(
            'This message must stay queued for its selected task and recipient.',
          )
        invocation = await this.prepareSkillInvocation(
          { sessionId, content: queued.content, skills: queued.metadata.skills },
          [run.agentId],
          signal,
        )
        if (execution.steering?.operationId === input.operationId)
          execution.steering.invocation = invocation
        if (!current())
          throw new RunOperationConflictError('The target execution ended before steering.')
        const attempt = this.conversations.prepareQueuedSteer(
          input,
          {
            runId: run.id,
            bindingGeneration: run.bindingGeneration ?? 1,
            nativeTurnId: run.nativeTurnId!,
            ...(run.executorId ? { executorId: run.executorId } : {}),
          },
          invocation,
        )
        if (!attempt.created)
          return { ok: true, value: this.conversations.metadataPatch(sessionId) }
        prepared = true
        const images = this.conversations.resolveMessageImages(sessionId, queued.metadata.imageIds)
        const envelope = this.promptEnvelope(
          sessionId,
          { id: queued.id, content: queued.content },
          [],
          [],
          images,
        )
        if (queued.inputBatchRef)
          envelope.inputBatchRef = {
            id: queued.inputBatchRef.id,
            revision: queued.inputBatchRef.commentsRevision,
            memberCount: queued.inputBatchRef.memberCount,
          }
        envelope.sourceGrant = { runId: run.id, grant: owner.generation }
        envelope.targetAgentId = run.agentId
        envelope.skillInvocation = invocation
        envelope.collaboration = this.conversations.collaboration(sessionId, run.id, false)
        envelope.collaborationAuthorization = this.conversations.collaborationTurnAuthorization(
          run.id,
        )
        envelope.requiredInputScopeRef =
          envelope.collaborationAuthorization?.sourceManifestRef ?? undefined
        this.refreshExecutionInputScope(execution)
        this.publish(this.conversations.metadataPatch(sessionId))
        const accepted = (): void => {
          if (current()) this.flushRunOutput(run)
          this.publish(this.conversations.markQueuedSteerAccepted(input.operationId, invocation))
          this.refreshExecutionInputScope(execution)
        }
        const result = await adapter.steer!(
          {
            runId: run.id,
            inputId: queued.id,
            nativeSessionId: run.nativeSessionId!,
            nativeTurnId: run.nativeTurnId!,
            bindingGeneration: run.bindingGeneration ?? 1,
            nativeGeneration: owner.generation,
            promptEnvelope: envelope,
            recordDispatch: (next) => {
              if (
                next === 'possibly_sent'
                  ? !current()
                  : this.nativeObservations.get(run.id) !== owner
              )
                throw new RunOperationConflictError(
                  'The steering observation changed before its receipt.',
                )
              if (next === 'possibly_sent')
                this.publish(this.conversations.markQueuedSteerPossiblySent(input.operationId))
              else if (next === 'accepted') accepted()
              else
                this.publish(
                  this.conversations.markQueuedSteerRefused(
                    input.operationId,
                    'The native execution refused this steering request.',
                    true,
                  ),
                )
              delivery.phase = next
              this.refreshExecutionInputScope(execution)
            },
            recordConsumption: (id) => {
              if (id !== queued.id || this.nativeObservations.get(run.id) !== owner) return
              if (current()) this.flushRunOutput(run)
              this.publish(
                this.conversations.markQueuedSteerConsumed(input.operationId, id, invocation),
              )
              this.refreshExecutionInputScope(execution)
            },
          },
          signal,
        )
        if (result.status === 'accepted' && delivery.phase !== 'accepted') accepted()
        else if (
          (result.status === 'unsupported' || result.status === 'rejected') &&
          delivery.phase !== 'rejected'
        )
          this.publish(
            this.conversations.markQueuedSteerRefused(
              input.operationId,
              result.reason,
              result.status === 'rejected',
            ),
          )
        this.refreshExecutionInputScope(execution)
        return { ok: true, value: this.conversations.metadataPatch(sessionId) }
      } catch (error) {
        if (prepared) {
          // The original observer can persist incorporation before this RPC
          // loses its ACK. That stronger fact must not be downgraded or retried.
          const consumed = this.conversations.queuedSteerReceipt(input, run.id)
          if (consumed) {
            this.refreshExecutionInputScope(execution)
            return { ok: true, value: consumed }
          }
          if (delivery.phase === 'prepared')
            this.publish(
              this.conversations.markQueuedSteerRefused(
                input.operationId,
                'Steering could not be prepared. Your message remains queued.',
              ),
            )
          else if (delivery.phase !== 'rejected' && delivery.phase !== 'accepted')
            this.publish(
              this.conversations.markQueuedSteerUnknown(
                input.operationId,
                'Native steering delivery could not be confirmed. It will not be sent again automatically.',
              ),
            )
          this.refreshExecutionInputScope(execution)
        }
        return Conversation.sendFailure(error)
      }
    })
    const entry: NonNullable<ActiveExecution['steering']> = {
      operationId: input.operationId,
      inputId: input.inputId,
      task: work,
    }
    execution.steering = entry
    try {
      return await work
    } finally {
      if (execution.steering === entry) execution.steering = undefined
      this.schedulePendingRoutedContinuations()
    }
  }

  /** A Steer boundary freezes only output committed before its accepted User. */
  private flushRunOutput(run: Pick<AgentRun, 'id' | 'sessionId'>): void {
    const owner = this.nativeObservations.get(run.id)
    if (owner?.outputFailure) return
    const execution = this.activeExecutions.get(run.sessionId)
    const foreground = execution?.run.id === run.id ? execution.streamBuffer : undefined
    const archived = this.nativeObservations.get(run.id)?.archiveBuffer
    if ((foreground && !foreground.flush()) || (archived && !archived.flush()))
      this.failRunOutput(
        run,
        new AgentExecutionError(
          'protocol_error',
          'The current output could not be committed before its input boundary.',
          false,
        ),
      )
  }

  /** Quarantine only the body lane; exact native control callbacks stay live. */
  private failRunOutput(
    run: Pick<AgentRun, 'id' | 'sessionId'>,
    error: unknown,
  ): AgentExecutionError {
    const owner = this.nativeObservations.get(run.id)
    if (owner?.outputFailure) return owner.outputFailure
    const failure = classifyAgentError(error)
    if (owner) {
      owner.outputFailure = failure
      owner.archiveController.abort()
    }
    const execution = this.activeExecutions.get(run.sessionId)
    if (execution?.run.id === run.id) execution.streamBuffer?.discard()
    owner?.archiveBuffer?.discard()
    this.publish(this.conversations.recordOutputFailure(run.id, failure))
    if (this.conversations.findRun(run.id)?.dispatchPhase === 'ended')
      this.publish(this.conversations.settleKnownNativeEnding(run.id))
    return failure
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
      input.kind === 'questions' &&
      this.conversations.findRun(owner.id)?.collaboration &&
      this.conversations.receivedCollaborationInput(owner.sessionId)
    )
      return Promise.resolve({ action: 'cancel' })
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
    if (!options.preparedInput) {
      try {
        const held = this.conversations.heldPreparedInputPatch(input)
        if (held) return Promise.resolve({ ok: true, value: held })
      } catch (error) {
        return Promise.resolve(Conversation.sendFailure(error))
      }
    }
    if (this.disposed) return Promise.resolve(Conversation.shuttingDown())
    if (this.nativeQuitSealed()) return Promise.resolve(Conversation.quitPrepared())
    if (this.conversations.archives.blocksSession(input.sessionId))
      return Promise.resolve(Conversation.archiveBusy())
    try {
      this.conversations.assertRelayDecisionResolved(
        input.sessionId,
        options.collaborationActionReceiptId,
      )
    } catch (error) {
      return Promise.resolve(Conversation.sendFailure(error))
    }
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
        prior.inputId === input.inputId &&
        prior.routeIntent === input.routeIntent &&
        prior.composerRevision === input.composerRevision &&
        JSON.stringify(prior.userInformation) === JSON.stringify(input.userInformation) &&
        JSON.stringify(prior.replyToDecision) === JSON.stringify(input.replyToDecision) &&
        (prior.batchId ?? prior.clientMessageId) === (input.batchId ?? input.clientMessageId) &&
        (prior.freezeDrafts ?? !preparing.options.preserveDraftComments) ===
          (input.freezeDrafts ?? !options.preserveDraftComments) &&
        prior.returnedInputOperationId === input.returnedInputOperationId &&
        prior.queueReturnOperationId === input.queueReturnOperationId &&
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
    const task = Promise.resolve().then(() => this.sendWithInputRouting(input, controller, options))
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

  actOnCollaboration(input: CollaborationActionInput): Promise<RpcResult<ConversationPatch>> {
    if (
      ['pause', 'request_plan_supplement', 'request_code_supplement', 'cancel_supplement'].includes(
        input.action,
      )
    )
      return this.actOnCollaborationAdmitted(input)
    const request = JSON.stringify(input),
      existing = this.collaborationActions.get(input.clientMessageId)
    if (existing)
      return existing.request === request
        ? existing.task
        : Promise.resolve(
            Conversation.sendFailure(
              new RunOperationConflictError('This action nonce belongs to a different request.'),
            ),
          )
    if (this.collaborationActions.size >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())
    const task = this.actOnCollaborationAdmitted(input).finally(() => {
      this.collaborationActions.delete(input.clientMessageId)
    })
    this.collaborationActions.set(input.clientMessageId, { request, task })
    return task
  }

  private async actOnCollaborationAdmitted(
    input: CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.disposed) return Conversation.shuttingDown()
    if (this.nativeQuitSealed()) return Conversation.quitPrepared()
    if (this.conversations.archives.blocksSession(input.sessionId))
      return Conversation.archiveBusy()
    try {
      const context = this.sessions.find(input.sessionId)
      const task = this.conversations.collaboration(input.sessionId)
      const prior = this.conversations.collaborationActionReceipt(input)
      if (prior?.boundRunId)
        return { ok: true, value: this.conversations.runPatch(prior.boundRunId) }
      if (prior && prior.state !== 'available')
        return { ok: true, value: this.conversations.metadataPatch(input.sessionId) }
      if (
        !context ||
        !task ||
        task.id !== input.taskId ||
        (!prior && task.revision !== input.revision)
      )
        throw new RunOperationConflictError('This collaboration action is no longer current.')
      if (task.status === 'complete')
        throw new RunOperationConflictError('This collaboration is already complete.')
      if (
        ['request_plan_supplement', 'request_code_supplement', 'confirm_supplement'].includes(
          input.action,
        )
      )
        throw new RunOperationConflictError(
          'This manual Relay request was retired. Use the current scheduling decision or existing collaboration action.',
        )
      if (input.action === 'confirm_supplement' || input.action === 'cancel_supplement') {
        if (
          input.action === 'confirm_supplement' &&
          this.pendingNativeInteractions(input.sessionId).length
        )
          return Conversation.capacityFailure()
        const answer = this.conversations.answerRelaySupplement(input)
        this.publish(answer.patch)
        if (input.action === 'cancel_supplement') {
          const decision = this.decisionRuntime
          if (decision?.sessionId === input.sessionId) {
            decision.controller.abort()
            void decision.runtime?.dispose()
          }
          for (const preparing of this.preparingSends.values())
            if (
              preparing.input.sessionId === input.sessionId &&
              ['supplement_plan', 'supplement_code_response'].includes(
                preparing.options.handoffGuidance?.proposal.guidance.candidateId ?? '',
              )
            )
              preparing.controller.abort()
          return { ok: true, value: answer.patch }
        }
        throw new RunOperationConflictError('This legacy Relay grant cannot start new work.')
      }
      if (input.action === 'pause') {
        const patch = this.conversations.pauseCollaboration(input.sessionId)
        this.abortPreparedWorkflow(input.sessionId)
        this.publish(patch)
        return { ok: true, value: patch }
      }
      this.conversations.discardUnansweredRelaySchedulingDecision(input.sessionId)
      if (this.conversations.receivedCollaborationInput(input.sessionId))
        throw new RunOperationConflictError(
          'Your queued message will be answered before collaboration continues.',
        )
      const planRecovery = this.conversations.needsWorkflowPlanRecovery(task.runId)
      if (input.action === 'recover_plan') {
        if (!planRecovery || task.automation !== 'paused')
          throw new RunOperationConflictError('There is no paused native plan source to restore.')
        const settled = this.conversations.reconcileCompletedCollaboration(task.runId)
        if (settled) this.publish(settled)
        if (!this.conversations.workflowPlanSettled(task.runId)) {
          const checked = await this.checkNativeBinding(input.sessionId, task.owner, task.runId)
          if (!checked.ok) return checked
        }
        const recovered = this.conversations.collaboration(input.sessionId)
        if (
          !recovered ||
          recovered.id !== task.id ||
          recovered.runId !== task.runId ||
          recovered.inputSequence !== task.inputSequence ||
          !this.conversations.workflowPlanSettled(task.runId) ||
          this.conversations.needsWorkflowPlanRecovery(task.runId)
        )
          throw new RunOperationConflictError(
            'The saved native plan could not be restored to this task. Its source is preserved; no Agent task was started.',
          )
        if (
          recovered.stage === 'reply' &&
          (collaborationInputGate(recovered) ||
            recovered.inputProcessing?.settled?.runId !== recovered.runId ||
            recovered.inputProcessing.settled.inputSequence !== recovered.inputSequence)
        )
          throw new RunOperationConflictError(
            'The plan was restored, but your reply still needs confirmation. Check its response or recovery notice before continuing.',
          )
        return { ok: true, value: this.conversations.metadataPatch(input.sessionId) }
      }
      if (planRecovery)
        throw new RunOperationConflictError(
          'Restore the saved native plan before continuing collaboration.',
        )
      if (input.action === 'resume' && !task.pendingWork) {
        this.conversations.assertRelayDecisionResolved(input.sessionId)
        if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
          return Conversation.nativeRecoveryRequired()
        const resumed = advanceCollaboration(task, 'resume', context.settings)
        const patch = this.conversations.setCollaborationState(resumed)
        this.publish(patch)
        this.schedulePendingRoutedContinuations()
        return { ok: true, value: patch }
      }
      if (this.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return Conversation.nativeRecoveryRequired()
      const prepared = this.conversations.prepareCollaborationAction(input, context.settings)
      if (prepared.receipt.boundRunId)
        return { ok: true, value: this.conversations.runPatch(prepared.receipt.boundRunId) }
      if (!prepared.task || !prepared.next || !prepared.handoff)
        throw new RunOperationConflictError('The original action preparation is unavailable.')
      let guidance: SendOptions['handoffGuidance']
      let consultation: DecisionInvocationOwner | undefined
      try {
        guidance = await this.prepareWorkflowGuidance(
          prepared.task,
          prepared.next,
          prepared.handoff,
          prepared.receipt.id,
        )
        consultation =
          this.decisionRuntime?.kind === 'evaluation' &&
          this.decisionRuntime.handoff?.id === prepared.handoff.id
            ? this.decisionRuntime
            : undefined
        const dispatched = this.startWorkflowTurn(
          prepared.task,
          prepared.next,
          input.clientMessageId,
          guidance,
          prepared.receipt.id,
          prepared.handoff,
        )
        guidance = undefined
        this.releaseDecisionHandoff(consultation)
        return await dispatched
      } finally {
        guidance?.reservation.release()
        this.releaseDecisionHandoff(consultation)
        this.conversations.cancelPreparedCollaborationAction(prepared.receipt.id)
      }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  private abortPreparedWorkflow(sessionId: string): void {
    const decision = this.decisionRuntime
    if (decision?.sessionId === sessionId) {
      decision.controller.abort()
      void decision.runtime?.dispose()
    }
    for (const preparing of this.preparingSends.values())
      if (preparing.input.sessionId === sessionId && preparing.options.collaboration)
        preparing.controller.abort()
  }

  private async startWorkflowTurn(
    task: CollaborationTask,
    next: CollaborationTask,
    clientMessageId: string = randomUUID(),
    guidance?: SendOptions['handoffGuidance'],
    collaborationActionReceiptId?: string,
    schedulingHandoff?: SchedulingHandoff,
  ): Promise<RpcResult<ConversationPatch>> {
    const options: SendOptions = {
      preserveDraftComments: true,
      collaboration: next,
      expectedCollaborationRevision: task.revision,
      handoffGuidance: guidance,
      collaborationActionReceiptId,
    }
    try {
      options.schedulingHandoff =
        schedulingHandoff ?? this.conversations.workflowHandoff(task, next.actor)
      const drafts = this.conversations.readPage({ scope: 'drafts', sessionId: task.sessionId })
      if (drafts.scope !== 'drafts')
        return Conversation.sendFailure(new Error('Comment drafts are unavailable.'))
      const content = `@${next.actor} ${collaborationStageLabel(next.stage)}.`
      return await this.enqueueSend(
        {
          sessionId: task.sessionId,
          clientMessageId,
          content,
          route: { type: 'agent', agentId: next.actor },
          expectedCommentsRevision: drafts.commentsRevision,
          commentIds: [],
          freezeDrafts: false,
        },
        options,
      )
    } finally {
      this.releaseHandoffGuidance(options)
    }
  }

  private releaseHandoffGuidance(options: SendOptions): void {
    options.handoffGuidance?.reservation.release()
    options.handoffGuidance = undefined
  }

  private releaseDecisionHandoff(owner: DecisionInvocationOwner | undefined): void {
    if (!owner || this.decisionRuntime !== owner) return
    owner.consulting = false
    if (!owner.runtime) this.decisionRuntime = undefined
  }

  private decisionRuntimeAdmission(sessionId: string): RelayPolicyAdmission['runtimeAdmission'] {
    if (this.decisionRuntime || this.conversations.activeSchedulingRuntimeOwner()) return 'busy'
    const scope = this.schedulingScope(sessionId)
    const observation = this.contextDecisionCapability
    if (
      !observation ||
      observation.sessionId !== sessionId ||
      observation.scopeKey !== scope.key ||
      observation.generation !== this.conversations.schedulingConfigurationGeneration() ||
      observation.configurationKey !== this.runtimePreparation.catalogIdentity(scope.cwd)
    )
      return 'may_attempt'
    if (
      [
        'unsupported_platform',
        'unsupported_provider',
        'unsupported_network',
        'unsupported_authentication',
        'unsupported_protocol',
        'project_authentication_differs',
        'executable_unavailable',
        'model_unavailable',
        'model_metadata_invalid',
        'model_effort_unavailable',
      ].includes(observation.capability.reason)
    )
      return 'known_unavailable'
    return observation.capability.status === 'unavailable' &&
      Date.parse(observation.expiresAt) > Date.now()
      ? 'cooldown'
      : 'may_attempt'
  }

  private async prepareWorkflowGuidance(
    task: CollaborationTask,
    next: CollaborationTask | undefined,
    handoff: SchedulingHandoff,
    receiptId?: string,
  ): Promise<SendOptions['handoffGuidance']> {
    let material: Omit<RelayDecisionMaterial, 'input'> | undefined
    let reservation: import('./native-working-memory').NativeMemoryReservation | undefined
    try {
      const preferences = this.conversations.schedulingSettings()
      if (!preferences.enabled || !preferences.selection) return undefined
      const runtimeAdmission = this.decisionRuntimeAdmission(task.sessionId)
      if (
        runtimeAdmission !== 'may_attempt' ||
        !this.conversations.relayWorkflowWorthConsulting(handoff)
      )
        return undefined
      const session = this.sessions.find(task.sessionId)
      const project = session && this.projects.find(session.projectId)
      if (!project) return undefined
      const configurationKey = this.runtimePreparation.catalogIdentity(project.directoryPath)
      const candidateId: WorkflowRelayCandidateId | undefined =
        this.conversations.relayDecision(task.sessionId)?.state === 'available' && receiptId
          ? this.conversations.relayDecision(task.sessionId)?.kind
          : next?.stage === 'respond'
            ? 'respond_to_code_review'
            : next?.stage === 'repair'
              ? 'repair_code'
              : next?.stage === 'plan_review'
                ? 'continue_plan_review'
                : next?.stage === 'plan'
                  ? 'continue_plan_revision'
                  : next?.stage === 'code_review'
                    ? 'continue_code_review'
                    : undefined
      const opportunity = receiptId
        ? undefined
        : this.conversations.relaySupplementOpportunity(handoff)
      const repairOpportunity = receiptId
        ? undefined
        : this.conversations.relayRepairOpportunity(handoff)
      if (!candidateId && !opportunity && !repairOpportunity) return undefined
      const supplementary =
        candidateId === 'supplement_plan' || candidateId === 'supplement_code_response'
      const candidates = [
        ...(candidateId === 'supplement_plan'
          ? [
              {
                id: 'continue_plan_review',
                description: `Continue the original Plan review with ${task.reviewer}, without adding a Turn.`,
              },
            ]
          : []),
        ...(candidateId && next
          ? [
              {
                id: candidateId,
                description: supplementary
                  ? `Use the user's exact single-use grant for one read-only ${next.stage} Turn by ${task.owner}, followed by the mandatory ${task.reviewer} review. Do not change scope or roles.`
                  : `Continue the already-authorized ${next.stage} with the fixed ${next.actor} actor; provide only source-grounded focus.`,
              },
            ]
          : []),
        ...(opportunity
          ? [
              {
                id: `propose_${opportunity.kind}`,
                description: `Propose one extra read-only turn by ${task.owner}, followed by the fixed ${task.reviewer} review, only if complete sources establish a concrete remaining gap that the normal next step cannot address. This candidate requests the user's specific authorization and grants no execution. Choose null or the existing next step when no extra turn is necessary.`,
              },
            ]
          : []),
        ...(repairOpportunity
          ? [
              {
                id: 'propose_repair',
                description: `Request one scoped repair by ${task.owner} under a new exact user grant, followed by the fixed ${task.reviewer} review. Propose this only when complete current review sources establish concrete work within the original task. It grants no execution and cannot expand scope or permissions. Prefer the original next step when no extra work is necessary.`,
              },
            ]
          : []),
      ]
      const legalActions = supplementary
        ? candidateId === 'supplement_plan'
          ? [
              {
                action: 'continue_plan_review' as RelayAction,
                actor: task.reviewer,
                authorizationId: handoff.id,
                authorizationCurrent: true,
                businessBudgetAvailable: true,
              },
            ]
          : []
        : candidateId && next
          ? [
              {
                action: candidateId,
                actor: next.actor,
                authorizationId: receiptId ?? handoff.id,
                authorizationCurrent: true,
                businessBudgetAvailable: true,
              },
            ]
          : []
      const outcome = await this.evaluateDecision(
        {
          handoff,
          retainHandoff: true,
          load: async (context) => {
            const read = await this.conversations.readRelayWorkflowDecisionSources(
              handoff,
              candidates,
              context,
            )
            const settings = this.conversations.schedulingSettings()
            const facts = relayWorkflowPolicyFacts(read.snapshot, {
              handoffId: handoff.id,
              inputBytes: decisionJsonBytes(read.input),
              legalActions,
              supplementOpportunity: opportunity,
              repairOpportunity,
              ...this.conversations.relayWorkflowUserGrants(handoff, read.snapshot, receiptId),
              continuation: this.conversations.relayWorkflowContinuation(read.snapshot) ?? null,
              admission: {
                enabled: settings.enabled,
                modelSelected: settings.selection !== null,
                runtimeAdmission,
                evaluationResourcesAvailable: true,
                factAlreadyEvaluated: Boolean(
                  this.conversations.decisionEvaluationReceipt(handoff),
                ),
                pendingUserInput: Boolean(
                  this.conversations.receivedCollaborationInput(task.sessionId) ||
                  collaborationInputGate(read.snapshot.task),
                ),
                nativeInteraction: this.pendingNativeInteractions(task.sessionId).length > 0,
                newTaskDispatchProtected: false,
              },
            })
            const policy = facts && evaluateRelayPolicy(facts)
            if (
              !policy ||
              policy.kind !== 'eligible' ||
              !candidates.every((candidate) =>
                policy.candidates.some((entry) => entry.id === candidate.id),
              )
            )
              throw new RunOperationConflictError(
                'This workflow node does not need a decision request.',
              )
            material = {
              basis: read.basis,
              sources: read.sources,
              inputSha256: read.inputSha256,
              sourceFingerprint: read.sourceFingerprint,
            }
            return read.input
          },
        },
        new AbortController().signal,
      )
      if (
        outcome.kind !== 'recommendation' ||
        !candidates.some((candidate) => candidate.id === outcome.recommendation.candidateId) ||
        outcome.recommendation.highlights.length === 0 ||
        !material ||
        material.basis.kind !== 'workflow'
      )
        return undefined
      const chosenProposal =
        repairOpportunity && outcome.recommendation.candidateId === 'propose_repair'
          ? repairOpportunity
          : opportunity && outcome.recommendation.candidateId === `propose_${opportunity.kind}`
            ? opportunity
            : undefined
      if (chosenProposal) {
        if (this.pendingNativeInteractions(task.sessionId).length) return undefined
        const reason = outcome.recommendation.highlights[0]!
        this.conversations.proposeRelayWorkflowAction({
          handoff,
          kind: chosenProposal.kind,
          evaluationId: outcome.evaluationReceipt.evaluationId,
          configurationGeneration: outcome.evaluationReceipt.configurationGeneration,
          deadlineAt: outcome.evaluationReceipt.deadlineAt,
          inputSha256: material.inputSha256,
          sourceFingerprint: material.sourceFingerprint,
          reason: reason.text,
          sourceIds: reason.sourceIds,
        })
        this.publish(this.conversations.metadataPatch(task.sessionId))
        return undefined
      }
      if (!next || !candidateId) return undefined
      reservation = new NativeWorkingMemory().reserve(128 * 1024)
      const { evaluationReceipt, recommendation } = outcome
      const proposal = handoffGuidanceProposalSchema.parse({
        guidance: {
          version: HANDOFF_GUIDANCE_VERSION,
          evaluationId: evaluationReceipt.evaluationId,
          handoffId: evaluationReceipt.handoffId,
          ...material,
          ...recommendation,
        },
        configurationGeneration: evaluationReceipt.configurationGeneration,
        configurationFingerprint: evaluationReceipt.configurationFingerprint,
        deadlineAt: evaluationReceipt.deadlineAt,
      })
      const current = () =>
        !this.disposed &&
        !this.nativeQuitSealed() &&
        this.conversations.schedulingConfigurationGeneration() ===
          proposal.configurationGeneration &&
        this.runtimePreparation.catalogIdentity(project.directoryPath) === configurationKey &&
        this.conversations.evaluationIsCurrent(handoff) &&
        Date.now() < proposal.deadlineAt
      if (!current()) return undefined
      const transferred = reservation
      reservation = undefined
      return { proposal, current, reservation: transferred }
    } catch {
      return undefined
    } finally {
      material = undefined
      reservation?.release()
    }
  }

  private async dispatchWorkflowContinuation(sessionId: string): Promise<void> {
    this.conversations.discardStaleRelaySchedulingDecision(sessionId)
    if (
      this.disposed ||
      this.nativeQuitSealed() ||
      this.hasSessionOperation(sessionId, true) ||
      this.operationCount() >= MAX_AGENT_OPERATIONS ||
      this.conversations.receivedCollaborationInput(sessionId) ||
      this.conversations.nativeRecoveryBlocksInput(sessionId) ||
      this.conversations.hasPendingRoutedContinuation(sessionId) ||
      this.pendingNativeInteractions(sessionId).length > 0 ||
      this.conversations.hasRelayDecision(sessionId)
    )
      return
    const task = this.conversations.collaboration(sessionId)
    const session = this.sessions.find(sessionId)
    if (
      !task ||
      !session ||
      session.status === 'archived' ||
      task.automation !== 'active' ||
      task.status !== 'waiting'
    )
      return
    if (collaborationInputGate(task)) {
      this.publish(
        this.conversations.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          automation: 'paused',
          pauseReason: 'needs_user',
          notice: 'Your input must be processed before collaboration can continue.',
        }),
      )
      return
    }
    if (!collaborationNextStage(task)) {
      if (!this.pendingNativeInteractions(sessionId).length) {
        const handoff = this.conversations.workflowHandoff(task, task.owner)
        await this.prepareWorkflowGuidance(task, undefined, handoff)
        const consultation =
          this.decisionRuntime?.kind === 'evaluation' &&
          this.decisionRuntime.handoff?.id === handoff.id
            ? this.decisionRuntime
            : undefined
        this.releaseDecisionHandoff(consultation)
      }
      return
    }
    let next: CollaborationTask
    try {
      next = advanceCollaboration(task, 'continue', session.settings)
    } catch (error) {
      const current = this.conversations.collaboration(sessionId)
      if (current?.id !== task.id || current.revision !== task.revision) return
      const notice = error instanceof Error ? error.message : 'Collaboration could not continue.'
      this.publish(
        this.conversations.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          automation: 'paused',
          pauseReason: notice.includes('limit') ? 'limit' : 'failure',
          notice: notice.slice(0, 512),
        }),
      )
      return
    }
    let guidance: SendOptions['handoffGuidance']
    let consultation: DecisionInvocationOwner | undefined
    const settings = this.conversations.schedulingSettings()
    if (settings.enabled && settings.selection) {
      const handoff = this.conversations.workflowHandoff(task, next.actor)
      if (
        this.decisionRuntime?.kind === 'evaluation' &&
        this.decisionRuntime.consulting &&
        this.decisionRuntime.current() &&
        this.decisionRuntime.handoff?.id === handoff.id
      )
        return
      guidance = await this.prepareWorkflowGuidance(task, next, handoff)
      consultation =
        this.decisionRuntime?.kind === 'evaluation' &&
        this.decisionRuntime.handoff?.id === handoff.id
          ? this.decisionRuntime
          : undefined
      if (this.disposed || this.nativeQuitSealed()) {
        guidance?.reservation.release()
        this.releaseDecisionHandoff(consultation)
        return
      }
      if (this.conversations.hasRelayDecision(sessionId)) {
        guidance?.reservation.release()
        this.releaseDecisionHandoff(consultation)
        return
      }
      if (!this.conversations.evaluationIsCurrent(handoff)) {
        guidance?.reservation.release()
        this.releaseDecisionHandoff(consultation)
        this.schedulePendingRoutedContinuations()
        return
      }
      if (
        [...this.preparingSends.values()].some(
          ({ options }) =>
            options.schedulingHandoff?.id === handoff.id &&
            options.schedulingHandoff.factFingerprint === handoff.factFingerprint,
        )
      ) {
        // The original manual claim is preparing; its existing release path wakes automation.
        guidance?.reservation.release()
        this.releaseDecisionHandoff(consultation)
        return
      }
    }
    const preparation = this.startWorkflowTurn(task, next, undefined, guidance)
    // enqueueSend has synchronously registered the original business preparation, or refused it.
    this.releaseDecisionHandoff(consultation)
    const result = await preparation
    if (!result.ok) {
      const current = this.conversations.collaboration(sessionId)
      if (current?.id !== task.id || current.revision !== task.revision) return
      this.publish(
        this.conversations.setCollaborationState({
          ...current,
          revision: current.revision + 1,
          automation: 'paused',
          pauseReason: 'failure',
          notice: result.error.message.slice(0, 512),
        }),
      )
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
    input: Pick<ConversationSendInput, 'sessionId' | 'content' | 'skills'>,
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

  private async sendWithInputRouting(
    input: ConversationSendInput,
    controller: AbortController,
    options: SendOptions,
  ): Promise<RpcResult<ConversationPatch>> {
    let receipt: import('@pact/persistence').PreparedInputDispatch | undefined =
      options.preparedInput
    let held = false
    let handoff: SchedulingHandoff | undefined
    try {
      const session = this.sessions.find(input.sessionId)
      const settings = this.conversations.schedulingSettings()
      const admission = this.decisionRuntimeAdmission(input.sessionId)
      if (
        !receipt &&
        session &&
        settings.enabled &&
        settings.selection &&
        admission === 'may_attempt' &&
        !options.collaboration &&
        !options.receivedInputId &&
        !options.sourceProposalId &&
        !options.preserveDraftComments &&
        !this.pendingNativeInteractions(input.sessionId).length &&
        this.conversations.ordinaryInputWorthConsulting(input, session.settings.primaryAgentId)
      ) {
        const allowed = (['codex', 'claude'] as const).filter((actor) => {
          const context = this.conversations.nativeContext(input.sessionId, actor)
          return !context || context.continuationState === 'ready'
        })
        const scope = this.projects.find(session.projectId)
        const configurationKey =
          scope && this.runtimePreparation.catalogIdentity(scope.directoryPath)
        let material: { inputSha256: string; sourceFingerprint: string } | undefined
        const outcome = await this.evaluateDecision(
          {
            sessionId: input.sessionId,
            prepare: async (context) => {
              // Runtime owns the fixed lease and original deadline before any complete input freeze.
              receipt = this.conversations.prepareInputDispatch(
                input,
                randomUUID(),
                allowed,
                context,
              )
              options.preparedInput = receipt
              const frozen = receipt
              handoff = this.conversations.preparedInputHandoff(receipt.batchId)
              this.publish(
                this.conversations.metadataPatch(input.sessionId, { draftsChanged: true }),
              )
              const routingCandidates = frozen.metadata.allowedAgentIds.map((actor) => ({
                id: `route_${actor}`,
                description: `Send the exact original input once to ${actor}, preserving its existing permissions and scope.`,
              }))
              const informationOpportunity =
                this.conversations.preparedInformationOpportunity(frozen)
              const candidates = [
                ...routingCandidates,
                ...(informationOpportunity
                  ? [
                      {
                        id: 'clarify_prepared_input',
                        description: `Collect the existing unanswered user-declared field ${informationOpportunity.fieldId}. Select only that exact fieldId; its question and choices are already frozen by the host.`,
                      },
                    ]
                  : []),
              ]
              const read = await this.conversations.readPreparedInputDecisionSources(
                frozen,
                candidates,
                context,
              )
              const policy = evaluateRelayPolicy({
                node: 'send',
                informationOpportunity: informationOpportunity
                  ? {
                      ...informationOpportunity,
                      sourceId:
                        read.sources.find(
                          (source) =>
                            source.kind === 'declaration' &&
                            source.document?.id === informationOpportunity.document.id,
                        )?.id ?? '',
                    }
                  : undefined,
                ordinary: true,
                handoffId: handoff.id,
                budgetSubjectId: handoff.budgetSubjectId,
                primary: frozen.metadata.defaultAgentId,
                route: 'implicit',
                inputSourceId: 's0',
                referencedSourceIds: read.sources
                  .filter((source) => source.actor !== null)
                  .map((source) => source.id),
                materials: {
                  complete: true,
                  inputBytes: decisionJsonBytes(read.input),
                  sources: read.sources.map((source) => ({
                    id: source.id,
                    sha256: source.sha256,
                    bytes: source.bytes,
                    roles: source.roles,
                    actor: source.actor,
                    complete: true,
                    settled: true,
                    frozen: true,
                  })),
                },
                legalActions: frozen.metadata.allowedAgentIds.map((actor) => ({
                  action: 'route_send',
                  actor,
                  authorizationId: handoff!.id,
                  authorizationCurrent: true,
                  businessBudgetAvailable: true,
                })),
                admission: {
                  enabled: settings.enabled,
                  modelSelected: settings.selection !== null,
                  runtimeAdmission: admission,
                  evaluationResourcesAvailable: true,
                  factAlreadyEvaluated: false,
                  pendingUserInput: Boolean(
                    this.conversations.receivedCollaborationInput(input.sessionId),
                  ),
                  nativeInteraction: this.pendingNativeInteractions(input.sessionId).length > 0,
                  newTaskDispatchProtected: false,
                },
              })
              if (
                policy.kind !== 'eligible' ||
                !policy.candidates.length ||
                candidates.length !== policy.candidates.length ||
                candidates.some(
                  (candidate) => !policy.candidates.some((legal) => legal.id === candidate.id),
                )
              )
                throw new RunOperationConflictError(
                  'The frozen input does not need recipient advice.',
                )
              material = {
                inputSha256: read.inputSha256,
                sourceFingerprint: read.sourceFingerprint,
              }
              return read.input
            },
          },
          controller.signal,
        )
        const selected =
          outcome.kind === 'recommendation' ? outcome.recommendation.candidateId : undefined
        recordDiagnostic({
          operation: 'send',
          phase: outcome.kind === 'recommendation' ? 'ready' : 'blocked',
          level: 'info',
          sessionId: input.sessionId,
          inputAdviceResult:
            outcome.kind === 'unavailable'
              ? outcome.reason
              : selected === null
                ? 'no_advice'
                : selected === 'clarify_prepared_input' ||
                    selected === 'route_codex' ||
                    selected === 'route_claude'
                  ? selected
                  : 'other_candidate',
        })
        if (
          outcome.kind === 'recommendation' &&
          material &&
          (outcome.recommendation.candidateId === 'route_codex' ||
            outcome.recommendation.candidateId === 'route_claude')
        ) {
          options.inputRouting = {
            version: 'input-routing-v1',
            ...material,
            ...outcome.evaluationReceipt,
            candidateId: outcome.recommendation.candidateId,
          }
          options.inputRoutingCurrent = () =>
            Boolean(
              scope &&
              this.runtimePreparation.catalogIdentity(scope.directoryPath) === configurationKey,
            )
        }
        if (
          outcome.kind === 'recommendation' &&
          material &&
          receipt &&
          outcome.recommendation.candidateId === 'clarify_prepared_input' &&
          !controller.signal.aborted &&
          !this.disposed &&
          !this.pendingNativeInteractions(input.sessionId).length &&
          scope &&
          this.runtimePreparation.catalogIdentity(scope.directoryPath) === configurationKey
        ) {
          try {
            this.conversations.proposePreparedInputInformation({
              receipt,
              original: input,
              recommendation: outcome.recommendation,
              evaluation: outcome.evaluationReceipt,
              ...material,
            })
            held = true
            const patch = {
              ...this.conversations.metadataPatch(input.sessionId),
              sendDisposition: 'held_for_information' as const,
            }
            this.publish(patch)
            return { ok: true, value: patch }
          } catch (error) {
            // An inadmissible auxiliary question never adds a new obstacle to the original Send.
            if (!(error instanceof RunOperationConflictError)) throw error
            recordDiagnostic({
              operation: 'send',
              phase: 'blocked',
              level: 'info',
              sessionId: input.sessionId,
              code: 'CONFLICT',
              informationAdviceRefusal:
                error instanceof PreparedInformationConflictError
                  ? error.informationAdviceRefusal
                  : 'host_validation',
            })
          }
        }
      }
      if (this.disposed || controller.signal.aborted || this.nativeQuitSealed())
        throw new RunOperationConflictError(
          'This preparation ended without sending. Your draft is preserved.',
        )
      return await this.sendAdmitted(input, controller, options)
    } catch (error) {
      return Conversation.sendFailure(error)
    } finally {
      if (
        !held &&
        receipt &&
        this.conversations.cancelPreparedInputDispatch(
          receipt,
          controller.signal.aborted ? 'cancelled' : 'preparation_failed',
        )
      )
        this.publish(this.conversations.metadataPatch(input.sessionId, { draftsChanged: true }))
      if (
        handoff &&
        this.decisionRuntime?.kind === 'evaluation' &&
        this.decisionRuntime.handoff?.id === handoff.id
      )
        this.releaseDecisionHandoff(this.decisionRuntime)
    }
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
    options.preparationDeadlineAt ??= Date.now() + PREPARATION_TIMEOUT_MS
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, options.preparationDeadlineAt - Date.now()),
    )
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
      if (
        commandPrefix.pact &&
        this.conversations.receivedCollaborationInput(input.sessionId)?.id !==
          options.receivedInputId &&
        this.conversations.receivedCollaborationInput(input.sessionId)
      )
        throw new RunOperationConflictError(
          'Handle or cancel the received input before starting a new Pact task.',
        )
      const requestedRoute = input.route ?? commandPrefix.route
      const primaryAgentId = context.value.session.settings.primaryAgentId
      const secondaryAgentId: RuntimeAgentId = primaryAgentId === 'claude' ? 'codex' : 'claude'
      let route: ConversationMessageRoute =
        options.queuedRoute ??
        (requestedRoute?.type === 'agent'
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
                    ? this.conversations.collaborationReplyActor(options.collaboration)
                    : primaryAgentId,
              })
      if (input.returnedInputOperationId) {
        const original = this.conversations.returnedInputRoute(
          input.sessionId,
          input.returnedInputOperationId,
        )
        if (!input.route) route = original
      }
      if (options.preparedInput) {
        if (options.inputRoutingCurrent && !options.inputRoutingCurrent())
          options.inputRouting = undefined
        route = {
          type: 'primary',
          agentId: this.conversations.preparedInputRecipient(
            options.preparedInput,
            options.inputRouting,
          ),
        }
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
        const owner = kind === 'review' ? otherAgent(agentId) : agentId
        collaboration = collaborationTaskSchema.parse({
          protocol: COLLABORATION_PROTOCOL,
          id: randomUUID(),
          sessionId: input.sessionId,
          kind,
          revision: 0,
          owner,
          reviewer: kind === 'review' ? agentId : otherAgent(owner),
          task,
          taskMessageId: input.clientMessageId,
          stage: kind === 'plan' ? 'plan' : kind === 'build' ? 'implement' : 'code_review',
          actor: agentId,
          status: 'running',
          automation: 'active',
          runId: input.clientMessageId,
          inputSequence: 0,
          handledInputSequence: 0,
          planVersion: 0,
          discussionRounds: 0,
          reviewCycles: kind === 'review' ? 1 : 0,
          repairAttempts: 0,
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
      if (options.handoffGuidance && !options.handoffGuidance.current())
        this.releaseHandoffGuidance(options)
      if (
        options.preparedInput &&
        options.inputRouting &&
        (!options.inputRoutingCurrent?.() ||
          this.conversations.preparedInputRecipient(options.preparedInput, options.inputRouting) !==
            agentId)
      ) {
        options.inputRouting = undefined
        // A stale recommendation returns to the frozen default within the same business deadline.
        return await this.sendAdmitted(input, controller, options)
      }
      const started = this.conversations.beginRun({
        preparedInput: options.preparedInput,
        inputRouting: options.inputRouting,

        ...(options.receivedInputId ? { receivedInputId: options.receivedInputId } : {}),
        ...(collaboration ? { collaboration } : {}),
        schedulingHandoff: options.schedulingHandoff,
        ...(options.handoffGuidance ? { handoffGuidance: options.handoffGuidance.proposal } : {}),
        expectedCollaborationRevision: options.expectedCollaborationRevision,
        collaborationActionReceiptId: options.collaborationActionReceiptId,
        ...(skillInvocation ? { skillInvocation } : {}),
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        ...(input.userInformation ? { userInformation: input.userInformation } : {}),
        ...(input.replyToDecision ? { replyToDecision: input.replyToDecision } : {}),
        ...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
        ...(options.imageOwnerKey ? { imageOwnerKey: options.imageOwnerKey } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.returnedInputOperationId
          ? { returnedInputOperationId: input.returnedInputOperationId }
          : {}),
        ...(input.queueReturnOperationId
          ? { queueReturnOperationId: input.queueReturnOperationId }
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
      this.releaseHandoffGuidance(options)
      prompt.inputBatchRef = this.conversations.inputBatchForRun(started.run.id) ?? undefined
      const clarification = this.conversations.preparedAnswerForRun(started.run.id)
      prompt.clarificationAnswer = clarification?.document
      prompt.userClarification = clarification
      if (collaboration) {
        prompt.collaborationAuthorization =
          this.conversations.collaborationTurnAuthorization(started.run.id) ?? undefined
        prompt.collaboration = this.conversations.collaborationPromptState(
          this.conversations.collaboration(input.sessionId, started.run.id, false)!,
        )
        prompt.requiredInputScopeRef = prompt.collaborationAuthorization?.sourceManifestRef
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
      this.releaseHandoffGuidance(options)
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
      this.conversations.cancelSchedulingRecoveryFaults(input.sessionId)
      if (this.conversations.pausePreparedInputForStop(input.sessionId))
        this.publish(this.conversations.metadataPatch(input.sessionId, { draftsChanged: true }))
      for (const [key, check] of this.nativeChecks)
        if (check.automaticAttemptId && key.startsWith(`${input.sessionId}:`))
          check.controller.abort()
      if (this.conversations.receivedCollaborationInput(input.sessionId))
        this.publish(
          this.conversations.pauseConversationQueue(
            input.sessionId,
            'The execution was stopped. Resume the queued message when ready.',
          ),
        )
      this.conversations.pauseCollaboration(input.sessionId, 'stopped')
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
    const receiptCheck = original && this.nativeChecks.get(`${sessionId}:${agentId}:${original.id}`)
    if (receiptCheck?.receiptSessionId)
      return receiptCheck.physicalCompletion.then(() => this.retry(input))
    if (
      original &&
      (!binding ||
        original.bindingGeneration !== binding.bindingGeneration ||
        original.nativeSessionId !== binding.nativeSessionId)
    )
      return this.inspectPreviousRun(original)
    return this.checkNativeBinding(sessionId, agentId)
  }

  private scheduleSteerReceiptCheck(
    page: Extract<ConversationPage, { scope: 'messages' }>,
    input: Extract<ConversationGetInput, { scope: 'messages' }>,
  ): void {
    if (!this.interestedSessionIds.has(page.sessionId) || this.disposed || this.nativeQuitSealed())
      return
    const intent =
      input.includeHistoricalSource && input.aroundMessageId ? input.aroundMessageId : 'latest'
    const previous = this.steerReceiptChecks.get(page.sessionId)
    if (previous && (intent === 'latest' || previous === intent)) return
    const target = page.messages.find((item) => item.message.id === input.aroundMessageId)?.message
      .runId
    const candidates = target
      ? page.runs.filter((run) => run.id === target)
      : page.runs.toReversed()
    const run = candidates.find(
      (entry) =>
        entry.agentId === 'codex' &&
        entry.nativeSessionId &&
        entry.nativeTurnId &&
        !entry.forkSourceRunId &&
        !this.nativeObservations.has(entry.id) &&
        this.conversations.unresolvedSteerInputs(entry.id).length > 0,
    )
    if (!run) return
    // The page RPC never waits for native I/O. A receipt publishes its own bounded resync.
    void this.inspectPreviousRun(run, true)
    if (this.nativeChecks.has(`${run.sessionId}:${run.agentId}:${run.id}`))
      this.steerReceiptChecks.set(page.sessionId, intent)
  }

  private async probeSteerInputs(
    run: AgentRun,
    adapter: AgentAdapter,
    controller: AbortController,
  ): Promise<void> {
    if (
      run.agentId !== 'codex' ||
      run.forkSourceRunId ||
      !run.nativeSessionId ||
      !run.nativeTurnId ||
      !adapter.beginNativeInputsCheck ||
      this.nativeObservations.has(run.id)
    )
      return
    const ids = this.conversations
      .unresolvedSteerInputs(run.id)
      .flatMap((entry) => (entry.inputId ? [entry.inputId] : []))
    if (!ids.length) return
    const proof = {
      runId: run.id,
      sessionId: run.sessionId,
      nativeSessionId: run.nativeSessionId,
      nativeTurnId: run.nativeTurnId,
      bindingGeneration: run.bindingGeneration ?? 1,
      executorId: run.executorId,
    }
    await this.runNativeCheck(
      controller,
      (checkContext, checkSignal) =>
        adapter.beginNativeInputsCheck!(
          {
            ...proof,
            requestId: run.id,
            agentId: run.agentId,
            cwd: this.projects.find(this.sessions.find(run.sessionId)!.projectId)!.directoryPath,
            model: run.model,
            effort: run.effort,
            unresolvedInputIds: ids,
            recordConsumption: (id) => {
              if (this.disposed || checkSignal.aborted || !ids.includes(id)) return
              this.publish(this.conversations.recordQueuedSteerConsumption(proof, id))
            },
          },
          checkSignal,
          checkContext,
        ),
      true,
    )
  }

  private inspectPreviousRun(
    run: AgentRun,
    receiptsOnly = false,
    automaticAttemptId?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    const key = `${run.sessionId}:${run.agentId}:${run.id}`
    const pending = this.nativeChecks.get(key)
    if (pending)
      return !receiptsOnly && pending.receiptSessionId
        ? pending.physicalCompletion.then(() => this.inspectPreviousRun(run))
        : pending.task
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
      this.operationCount() >= MAX_AGENT_OPERATIONS
    )
      return Promise.resolve(Conversation.capacityFailure())
    const controller = new AbortController()
    return this.startNativeCheck(
      key,
      controller,
      async () => {
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
          try {
            await this.probeSteerInputs(run, adapter, controller)
          } catch (error) {
            if (receiptsOnly || controller.signal.aborted) throw error
            // An unavailable input receipt must not suppress independent root inspection.
          }
          if (receiptsOnly)
            return { ok: true, value: this.conversations.metadataPatch(run.sessionId) }
          const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeStatusCheck)
              throw new Error('The runtime cannot own a native check.')
            return adapter.beginNativeStatusCheck(
              {
                sessionId: run.sessionId,
                agentId: run.agentId,
                runId: run.id,
                requestId: run.id,
                nativeSessionId: run.nativeSessionId!,
                bindingGeneration: run.bindingGeneration ?? 1,
                ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                nativeInputIds: this.conversations.nativeInputIdsForRun(run.id),
                planSource: this.conversations.workflowPlanSourceExpected(run.id),
                ...(run.executorId ? { executorId: run.executorId } : {}),
                cwd: project.directoryPath,
                model: run.model,
                effort: run.effort,
              },
              checkSignal,
              checkContext,
            )
          })
          const archiveTail = this.nativeObservations.get(run.id)?.archiveTail
          if (archiveTail) await archiveTail
          if (!evidence || this.disposed || controller.signal.aborted)
            throw new Error('The previous native result could not be checked.')
          this.flushRunOutput(run)
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
                ...(evidence.identity.executorId
                  ? { executorId: evidence.identity.executorId }
                  : {}),
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
        }
      },
      { ...(receiptsOnly ? { receiptSessionId: run.sessionId } : {}), automaticAttemptId },
    )
  }

  private checkNativeBinding(
    sessionId: string,
    agentId: RuntimeAgentId,
    expectedRunId?: string,
    automaticAttemptId?: string,
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
    if (this.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())
    const controller = new AbortController()
    let markLogicalTimeout: (() => void) | undefined
    return this.startNativeCheck(
      key,
      controller,
      async () => {
        const context = this.conversations.nativeContext(sessionId, agentId)
        const candidate = context?.lastRunId
          ? this.conversations.findRun(context.lastRunId)
          : this.conversations.latestAgentRun(sessionId, agentId)
        const run =
          candidate?.bindingGeneration === context?.bindingGeneration &&
          candidate?.nativeSessionId === context?.nativeSessionId
            ? candidate
            : undefined
        if (expectedRunId && run?.id !== expectedRunId)
          return {
            ok: false,
            error: {
              code: 'CONFLICT',
              message: 'The native plan source is no longer the current execution.',
            },
          }
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
        markLogicalTimeout = () => {
          const current = this.conversations.nativeContext(sessionId, agentId)
          if (
            this.disposed ||
            controller.signal.aborted ||
            current?.bindingGeneration !== generation ||
            current.nativeSessionId !== context.nativeSessionId
          )
            return
          const message =
            'Native state check timed out. Cleanup remains pending. No task was reexecuted.'
          this.publish(
            this.conversations.setContinuation(
              sessionId,
              agentId,
              'recovery_required',
              message,
              generation,
              { kind: 'transient_transport', message, action: 'rebuild' },
            ),
          )
        }
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
          if (run) {
            try {
              await this.probeSteerInputs(run, adapter, controller)
            } catch (error) {
              if (controller.signal.aborted) throw error
              // Receipt availability cannot change the separately checked root outcome.
            }
          }
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
            if (!initialized || !adapter.beginNativeStatusCheck)
              throw new Error('There is no confirmed current initialization to check.')
            const chunks = this.conversations.readNativeRebuildSource(initialized.rebuildId)
            const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) =>
              adapter.beginNativeStatusCheck!(
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
                checkSignal,
                checkContext,
              ),
            )
            if (!evidence || controller.signal.aborted || this.disposed)
              throw new Error('The initialized binding could not be checked.')
            this.publish(this.conversations.recordNativeEvidence(evidence))
            if (evidence.kind !== 'binding_ready')
              throw new Error('Native initialization readback did not confirm this binding.')
            this.scheduleNativeTitleSync(sessionId)
            return { ok: true, value: this.conversations.contextPatch(sessionId) }
          }
          const evidence = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeStatusCheck)
              throw new AgentExecutionError(
                'runtime_incompatible',
                'The runtime cannot provide a safe native check. Update the runtime, then Retry.',
                false,
              )
            return adapter.beginNativeStatusCheck(
              {
                sessionId,
                agentId,
                requestId: run?.id ?? sessionId,
                ...(run ? { runId: run.id } : {}),
                nativeSessionId: context.nativeSessionId,
                ...(run?.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                ...(run
                  ? {
                      nativeInputIds: this.conversations.nativeInputIdsForRun(run.id),
                      planSource: this.conversations.workflowPlanSourceExpected(run.id),
                    }
                  : {}),
                ...(run && this.conversations.needsWorkflowPlanRecovery(run.id)
                  ? { inspectMissingPlan: true }
                  : {}),
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
              checkSignal,
              checkContext,
            )
          })
          if (!evidence || controller.signal.aborted)
            throw new Error('The native check did not return evidence.')
          const archiveTail = run && this.nativeObservations.get(run.id)?.archiveTail
          if (archiveTail) await archiveTail
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.conversations.nativeContext(sessionId, agentId)?.bindingGeneration !== generation
          )
            throw new RunOperationConflictError('The binding changed while checking.')
          if (run) this.flushRunOutput(run)
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
                ...(evidence.identity.executorId
                  ? { executorId: evidence.identity.executorId }
                  : {}),
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
          if (this.disposed) return Conversation.shuttingDown()
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
              message:
                'The native check did not provide reliable evidence. No task was reexecuted.',
            },
          }
        }
      },
      { automaticAttemptId, onLogicalTimeout: () => markLogicalTimeout?.() },
    )
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
      this.publish(patch)
      this.startNativeRebuildOperation(input.sessionId, input.agentId, input.clientOperationId)
      return { ok: true, value: patch }
    } catch (error) {
      return Conversation.sendFailure(error)
    }
  }

  private startNativeRebuildOperation(
    sessionId: string,
    agentId: RuntimeAgentId,
    rebuildId: string,
  ): void {
    const rebuild: ActiveNativeRebuild = {
      agentId,
      rebuildId,
      abortController: new AbortController(),
    }
    this.nativeRebuilds.set(sessionId, rebuild)
    this.workspaceChanges?.cancelUndoForNativeSession(sessionId)
    rebuild.completion = this.runNativeContextRebuild(sessionId, rebuild).finally(() => {
      if (this.nativeRebuilds.get(sessionId) === rebuild) this.nativeRebuilds.delete(sessionId)
      if (!this.disposed) this.publish(this.conversations.metadataPatch(sessionId))
    })
  }

  private checkNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
    operation: NonNullable<ReturnType<ConversationRepository['nativeRebuildOperation']>>,
    automaticAttemptId?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    const key = `${sessionId}:${agentId}:rebuild`
    const pending = this.nativeChecks.get(key)
    if (pending) return pending.task
    if (this.operationCount() >= MAX_AGENT_OPERATIONS)
      return Promise.resolve(Conversation.capacityFailure())
    if (this.hasSessionOperation(sessionId, false, undefined, true))
      return Promise.resolve(Conversation.archiveBusy())
    const controller = new AbortController()
    const expectedNativeSessionId = this.conversations.nativeContext(
      sessionId,
      agentId,
    )?.nativeSessionId
    return this.startNativeCheck(
      key,
      controller,
      async () => {
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

          const result = await this.runNativeCheck(controller, (checkContext, checkSignal) => {
            if (!adapter.beginNativeRebuildCheck)
              throw new Error('The runtime cannot own candidate inspection.')
            return adapter.beginNativeRebuildCheck(
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
              checkSignal,
              checkContext,
            )
          })
          if (controller.signal.aborted) throw new Error('The native check was interrupted.')
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
      },
      {
        automaticAttemptId,
        onPhysicalCompletion: () => {
          if (!this.disposed) this.recoveryResult(sessionId)
        },
      },
    )
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
      if (input.mode === 'create') await this.validateCommentAnchor(input.sessionId, input.anchor)
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
    if (anchor.type === 'unavailable')
      return {
        ok: true,
        value: { status: 'unavailable', commentId, quote: anchor.quote, reason: anchor.reason },
      }
    if (anchor.type === 'file') return this.projectFiles.resolveCommentSource(sessionId, comment)

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
    if (!anchor.plan && !anchor.report && metadata.contentBytes > CONVERSATION_MARKDOWN_BYTES) {
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
    for (const id of this.steerReceiptChecks.keys())
      if (!input.data.sessionIds.includes(id)) this.steerReceiptChecks.delete(id)
    for (const check of this.nativeChecks.values())
      if (check.receiptSessionId && !input.data.sessionIds.includes(check.receiptSessionId))
        check.controller.abort()
    this.interestedSessionIds = new Set(input.data.sessionIds)
    return { ok: true, value: { ready: true } }
  }

  private createStreamTrace(run: AgentRun, owner: NativeObservation): OwnedStreamTrace | undefined {
    try {
      const reservation = owner.archiveMemory.reserve(8192)
      const startedAt = performance.now()
      return {
        startedAt,
        expiresAt: startedAt + STREAM_TRACE_TTL_MS,
        reservation,
        data: {
          runId: run.id,
          sessionId: run.sessionId,
          generationSha256: createHash('sha256').update(owner.generation).digest('hex'),
          capturedAfterMs: 0,
          state: 'active',
          nativeBound: false,
          invalid: false,
          outputFailed: false,
          loop: {
            text: 0,
            reasoning: 0,
            bytes: 0,
            foreignThread: 0,
            foreignTurn: 0,
            missingIdentity: 0,
            firstMs: null,
            lastMs: null,
          },
          normalized: { text: 0, reasoning: 0, bytes: 0, current: 0, archived: 0, lastMs: null },
          publication: { attempts: 0, suppressed: 0, published: 0, lastMs: null },
          foregroundBuffer: null,
          archiveBuffer: null,
          transport: null,
        },
      }
    } catch {
      return undefined
    }
  }

  private currentStreamTrace(owner: NativeObservation): OwnedStreamTrace | undefined {
    const trace = owner.streamTrace
    if (!trace) return undefined
    if (
      performance.now() >= trace.expiresAt ||
      this.nativeObservations.get(trace.data.runId) !== owner
    ) {
      trace.reservation.release()
      owner.streamTrace = undefined
      return undefined
    }
    const elapsed = Math.floor(performance.now() - trace.startedAt)
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) trace.data.invalid = true
    else trace.data.capturedAfterMs = elapsed
    return trace
  }

  private bumpStreamTrace(
    trace: OwnedStreamTrace,
    group: Record<string, number | null>,
    key: string,
    amount = 1,
  ): void {
    if (trace.data.invalid) return
    const value = group[key]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      !Number.isSafeInteger(value + amount)
    ) {
      trace.data.invalid = true
      return
    }
    group[key] = value + amount
  }

  private observeNativeDelta(
    owner: NativeObservation,
    value: import('@pact/contracts').NativeLoopDeltaObservation,
  ): void {
    const trace = this.currentStreamTrace(owner)
    if (!trace || trace.data.invalid) return
    if (
      !['text', 'reasoning'].includes(value.kind) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0
    ) {
      trace.data.invalid = true
      return
    }
    if (value.identity !== 'matched') {
      const key = {
        foreign_thread: 'foreignThread',
        foreign_turn: 'foreignTurn',
        missing_identity: 'missingIdentity',
      }[value.identity]
      this.bumpStreamTrace(trace, trace.data.loop, key)
      return
    }
    this.bumpStreamTrace(trace, trace.data.loop, value.kind)
    this.bumpStreamTrace(trace, trace.data.loop, 'bytes', value.bytes)
    trace.data.loop.firstMs ??= trace.data.capturedAfterMs
    trace.data.loop.lastMs = trace.data.capturedAfterMs
  }

  private observeNormalizedDelta(
    owner: NativeObservation,
    event: import('@pact/contracts').NormalizedAgentEvent,
    archived: boolean,
  ): void {
    if (event.type !== 'text.delta' && event.type !== 'reasoning.summary.delta') return
    if (!event.text.length) return
    const trace = this.currentStreamTrace(owner)
    if (!trace || trace.data.invalid) return
    this.bumpStreamTrace(
      trace,
      trace.data.normalized,
      event.type === 'text.delta' ? 'text' : 'reasoning',
    )
    this.bumpStreamTrace(
      trace,
      trace.data.normalized,
      'bytes',
      Buffer.byteLength(event.text, 'utf8'),
    )
    this.bumpStreamTrace(trace, trace.data.normalized, archived ? 'archived' : 'current')
    trace.data.normalized.lastMs = trace.data.capturedAfterMs
  }

  private projectStreamTrace(
    owner: NativeObservation,
    foreground?: AgentStreamBuffer,
  ): import('@pact/contracts').ConversationStreamTrace | undefined {
    const trace = this.currentStreamTrace(owner)
    if (!trace) return undefined
    try {
      const execution = this.activeExecutions.get(trace.data.sessionId)
      const buffer =
        foreground ?? (execution?.run.id === trace.data.runId ? execution.streamBuffer : undefined)
      if (buffer) trace.data.foregroundBuffer = buffer.diagnostics()
      if (owner.archiveBuffer) trace.data.archiveBuffer = owner.archiveBuffer.diagnostics()
      trace.data.outputFailed = Boolean(owner.outputFailure)
      const run = this.conversations.findRun(trace.data.runId)
      trace.data.nativeBound = Boolean(run?.nativeSessionId && run.nativeTurnId)
      if (
        owner.adapter instanceof CodexAgentAdapter &&
        typeof owner.adapter.diagnostics === 'function'
      ) {
        const facts = owner.adapter.diagnostics()
        trace.data.transport = {
          queuedMessages: facts.queuedMessages,
          queuedInboundBytes: facts.queuedInboundBytes,
          stdoutPaused: facts.stdoutPaused,
          open: facts.open,
        }
      }
      const parsed = conversationStreamTraceSchema.safeParse(trace.data)
      if (!parsed.success) {
        trace.reservation.release()
        owner.streamTrace = undefined
        return undefined
      }
      return parsed.data
    } catch {
      trace.reservation.release()
      owner.streamTrace = undefined
      return undefined
    }
  }

  private retireStreamTrace(owner: NativeObservation, foreground?: AgentStreamBuffer): void {
    const snapshot = this.projectStreamTrace(owner, foreground),
      trace = owner.streamTrace
    owner.streamTrace = undefined
    if (!snapshot || !trace) return
    try {
      snapshot.state =
        this.conversations.findRun(snapshot.runId)?.nativeEffectsState === 'settled'
          ? 'settled'
          : 'retired'
      this.lastSettledStreamTrace?.reservation.release()
      trace.data = snapshot
      this.lastSettledStreamTrace = trace
    } catch {
      trace.reservation.release()
    }
  }

  private streamTraceProjections(): import('@pact/contracts').ConversationStreamTrace[] {
    const result: import('@pact/contracts').ConversationStreamTrace[] = []
    for (const owner of this.nativeObservations.values()) this.currentStreamTrace(owner)
    for (const execution of this.activeExecutions.values()) {
      const owner = this.nativeObservations.get(execution.run.id)
      const trace = owner && this.projectStreamTrace(owner, execution.streamBuffer)
      if (trace) result.push(trace)
    }
    const last = this.lastSettledStreamTrace
    if (last && performance.now() >= last.expiresAt) {
      last.reservation.release()
      this.lastSettledStreamTrace = undefined
    } else if (last && !result.some((trace) => trace.runId === last.data.runId))
      result.push(structuredClone(last.data))
    return result
  }

  diagnostics() {
    return {
      interestedSessionIds: [...this.interestedSessionIds],
      streamTraces: this.streamTraceProjections(),
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
    if (this.pendingContinuationImmediate) clearImmediate(this.pendingContinuationImmediate)
    this.pendingContinuationImmediate = undefined
    this.workflowCandidateCursor = undefined
    this.workflowCandidateRescan = false
    this.decisionRuntime?.controller.abort()
    const decisionProbe =
      this.decisionRuntime?.kind === 'probe' ? this.decisionRuntime.task : undefined
    const decisionCleanup = this.decisionRuntime?.runtime?.dispose().catch(() => false)
    this.hostDecisionCapability = undefined
    this.contextDecisionCapability = undefined
    await this.markdownWorker?.terminate()
    await this.markdownTail
    const forkOwners = [...this.nativeForks.values()]
    const forkPreparations = [...this.forkPreparations.values()]
    for (const owner of forkOwners) owner.controller.abort()
    const nativeChecks = [...this.nativeChecks.values()]
    for (const check of nativeChecks) check.controller.abort()
    this.interestedSessionIds.clear()
    this.steerReceiptChecks.clear()
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
    for (const owner of this.nativeObservations.values()) {
      owner.sourceReader?.retire()
      owner.archiveController.abort()
    }
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
    for (const owner of this.nativeObservations.values()) {
      owner.streamTrace?.reservation.release()
      owner.streamTrace = undefined
    }
    this.lastSettledStreamTrace?.reservation.release()
    this.lastSettledStreamTrace = undefined
    this.nativeObservations.clear()
    const cleanup = await Promise.allSettled([
      ...(decisionCleanup ? [decisionCleanup] : []),
      ...(decisionProbe ? [decisionProbe] : []),
      ...(this.decisionRecovery ? [this.decisionRecovery] : []),
      ...[...this.collaborationActions.values()].map((owner) => owner.task),
      ...adapters.map(async ({ adapter }) => {
        await adapter.dispose()
      }),
      ...forkOwners.flatMap((owner) => (owner.completion ? [owner.completion] : [])),
      ...forkPreparations.map((owner) => owner.task),
      ...nativeChecks.map((owner) => owner.physicalCompletion),
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
    if (
      !flushed ||
      (await decisionCleanup) === false ||
      cleanup.some((result) => result.status === 'rejected')
    )
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

  private schedulePendingRoutedContinuations(continueWorkflowScan = false): void {
    if (this.disposed) return
    if (!continueWorkflowScan && this.workflowCandidateCursor) this.workflowCandidateRescan = true
    if (this.pendingContinuationScheduled) {
      this.pendingContinuationWakeAgain = true
      return
    }
    this.pendingContinuationScheduled = true
    this.pendingContinuationImmediate = setImmediate(() => {
      this.pendingContinuationImmediate = undefined
      void this.resumePendingRoutedContinuations()
        .catch(() => undefined)
        .finally(() => {
          this.pendingContinuationScheduled = false
          if (this.pendingContinuationWakeAgain) {
            this.pendingContinuationWakeAgain = false
            this.schedulePendingRoutedContinuations(Boolean(this.workflowCandidateCursor))
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
    const queue = this.conversations.queueState(sessionId)
    if (queue.input?.state !== 'queued') return
    // Preserve the original @all context boundary: queued work cannot enter the
    // Secondary's native history before its already-authorized independent stage.
    if (
      this.conversations
        .pendingRoutedContinuations()
        .some((pending) => pending.sessionId === sessionId)
    )
      return
    const input = this.conversations.readReceivedInput(sessionId)
    const task = this.conversations.collaboration(sessionId),
      session = this.sessions.find(sessionId)
    if (
      !input ||
      (!queue.enabled && !input.taskId) ||
      input.state !== 'accepted' ||
      !session ||
      session.status === 'archived'
    )
      return
    const prefix = parseComposerCommandPrefix(input.content, input.metadata.skills)
    if (
      prefix.error ||
      Boolean(prefix.pact) !== input.metadata.workflowCommand ||
      (prefix.pact && input.taskId)
    ) {
      this.publish(
        this.conversations.pauseConversationQueue(
          sessionId,
          prefix.error ??
            'The queued message no longer matches its frozen task. Edit it before sending.',
        ),
      )
      return
    }
    const anchor = this.conversations.findRun(input.anchorRunId)
    if (!anchor || (input.taskId && input.taskId !== task?.id)) {
      this.publish(
        this.conversations.pauseConversationQueue(
          sessionId,
          'The queued message needs its original execution to be checked.',
        ),
      )
      return
    }
    if (['starting', 'running', 'recovering'].includes(anchor.status)) return
    if (
      !input.manuallyResumed &&
      !input.taskId &&
      (anchor.status !== 'completed' ||
        anchor.nativeOutcome !== 'completed' ||
        !this.conversations.hasCompleteResponse(anchor.id))
    ) {
      this.publish(
        this.conversations.pauseConversationQueue(
          sessionId,
          'The execution did not complete normally. Resume the queued message when ready.',
        ),
      )
      return
    }
    if (
      (anchor.dispatchPhase !== 'ended' &&
        !(
          (input.manuallyResumed &&
            ['not_sent', 'rejected'].includes(anchor.dispatchPhase ?? 'not_sent')) ||
          (input.taskId && this.conversations.workflowInputWasNotSent(anchor))
        )) ||
      (anchor.nativeEffectsState !== 'settled' && anchor.nativeEffectsState !== 'not_dispatched')
    )
      return
    if (input.taskId && task?.status === 'running') return
    const next =
      input.taskId && task ? this.conversations.workflowReply(task, input.actor) : undefined
    if (next) next.latestUserMessageId = input.id
    const currentDrafts = this.conversations.readPage({ scope: 'drafts', sessionId })
    if (currentDrafts.scope !== 'drafts') return
    const result = await this.enqueueSend(
      {
        sessionId,
        clientMessageId: input.id,
        content: input.content,
        ...(input.metadata.replyToDecision
          ? { replyToDecision: input.metadata.replyToDecision }
          : {}),
        route:
          input.metadata.route?.type === 'all'
            ? { type: 'all' }
            : { type: 'agent', agentId: input.actor },
        ...(input.metadata.skills.length ? { skills: input.metadata.skills } : {}),
        expectedCommentsRevision: currentDrafts.commentsRevision,
        commentIds: [],
        ...(input.metadata.batchId ? { batchId: input.metadata.batchId } : {}),
        freezeDrafts: false,
        ...(input.metadata.imageIds.length ? { imageIds: input.metadata.imageIds } : {}),
      },
      {
        ...(next ? { collaboration: next, expectedCollaborationRevision: task!.revision } : {}),
        queuedRoute:
          input.metadata.route?.type === 'all'
            ? { type: 'all', firstAgentId: input.actor, secondAgentId: otherAgent(input.actor) }
            : { type: 'agent', agentId: input.actor },
        preserveDraftComments: true,
        receivedInputId: input.id,
        receivedComments: input.comments,
      },
    )
    if (!result.ok && this.conversations.receivedCollaborationInput(sessionId)?.id === input.id)
      this.publish(this.conversations.pauseConversationQueue(sessionId, result.error.message))
  }

  private async resumePendingRoutedContinuations(): Promise<void> {
    for (const pending of this.conversations.pendingPreparedInformationDefaults()) {
      if (this.disposed || this.operationCount() >= MAX_AGENT_OPERATIONS) break
      if (this.hasSessionOperation(pending.sessionId)) continue
      const prepared = this.conversations.takePreparedInformationDefault(pending.batchId)
      if (!prepared || 'paused' in prepared) {
        this.publish(
          this.conversations.metadataPatch(pending.sessionId, {
            draftsChanged: Boolean(prepared?.draftsChanged),
          }),
        )
        continue
      }
      const sending = this.enqueueSend(prepared.input, { preparedInput: prepared.receipt })
      void sending
        .finally(() => {
          const draftsChanged = this.conversations.cancelPreparedInputDispatch(
            prepared.receipt,
            'preparation_failed',
          )
          if (!this.disposed)
            this.publish(this.conversations.metadataPatch(pending.sessionId, { draftsChanged }))
        })
        .catch(() => undefined)
    }
    for (const pending of this.conversations.pendingCollaborationInputs()) {
      void this.dispatchReceivedInput(pending.sessionId).catch(() => {
        if (
          !this.disposed &&
          this.conversations.receivedCollaborationInput(pending.sessionId)?.id === pending.id
        )
          this.publish(
            this.conversations.pauseConversationQueue(
              pending.sessionId,
              'Automatic delivery could not be prepared. Resume when ready.',
            ),
          )
      })
    }
    if (!this.workflowCandidateCursor) this.workflowCandidateRescan = false
    const workflowCandidates = this.conversations.pendingWorkflowTasks(this.workflowCandidateCursor)
    for (const pending of workflowCandidates)
      void this.dispatchWorkflowContinuation(pending.sessionId).catch((error) => {
        const task = this.conversations.collaboration(pending.sessionId)
        if (!task || task.automation !== 'active') return
        this.publish(
          this.conversations.setCollaborationState({
            ...task,
            revision: task.revision + 1,
            automation: 'paused',
            pauseReason: 'failure',
            notice: (error instanceof Error
              ? error.message
              : 'Collaboration could not continue.'
            ).slice(0, 512),
          }),
        )
      })
    // Five metadata candidates are a page, not a limit on which Sessions may progress.
    // The existing coalesced wake yields between pages; physical capacity remains authoritative.
    if (
      workflowCandidates.length === 5 &&
      this.operationCount() < MAX_AGENT_OPERATIONS &&
      !this.disposed
    ) {
      const last = workflowCandidates.at(-1)!
      this.workflowCandidateCursor = { updatedAt: last.updatedAt, id: last.id }
      this.pendingContinuationWakeAgain = true
    } else {
      this.workflowCandidateCursor = undefined
      if (this.workflowCandidateRescan) {
        this.workflowCandidateRescan = false
        this.pendingContinuationWakeAgain = true
      }
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
    void this.resumeAutomaticRecovery().catch(() => undefined)
  }

  /** Consume changed fault facts once, including skipped/busy facts. There is no recovery queue. */
  private async resumeAutomaticRecovery(): Promise<void> {
    if (this.disposed || this.nativeQuitSealed()) return
    for (;;) {
      const candidates = this.conversations.takeSchedulingRecoveryFaults()
      if (!candidates.length) return
      for (const { fault, node } of candidates) {
        try {
          const settings = this.conversations.schedulingSettings()
          if (
            !settings.enabled ||
            !settings.selection ||
            this.decisionRuntime ||
            this.decisionRecovery ||
            this.conversations.activeSchedulingRuntimeOwner() ||
            [...this.nativeChecks.keys()].some((key) => key.startsWith(`${node.sessionId}:`)) ||
            this.operationCount() >= MAX_AGENT_OPERATIONS ||
            this.hasSessionOperation(node.sessionId, false, undefined, true) ||
            this.conversations.archives.blocksSession(node.sessionId) ||
            this.pendingNativeInteractions(node.sessionId).length
          )
            continue
          const session = this.sessions.find(node.sessionId),
            task = this.conversations.collaboration(node.sessionId)
          if (
            !session ||
            session.status === 'archived' ||
            this.projects.find(session.projectId)?.archivedAt ||
            (task?.automation === 'paused' && task.pauseReason !== 'failure')
          )
            continue
          const run =
              node.freshnessGuard.runId && this.conversations.findRun(node.freshnessGuard.runId),
            binding = this.conversations.nativeContext(node.sessionId, fault.agentId)
          if (
            !run ||
            run.forkSourceRunId ||
            run.controlDisposition === 'abandoned' ||
            !run.nativeSessionId ||
            this.conversations.latestAgentRun(node.sessionId, fault.agentId)?.id !== run.id ||
            (binding &&
              (binding.bindingGeneration !== run.bindingGeneration ||
                binding.nativeSessionId !== run.nativeSessionId)) ||
            [
              'user_stopped',
              'authentication_required',
              'quota_or_rate_limit',
              'permission_blocked',
              'runtime_incompatible',
            ].includes(run.failureKind ?? '')
          )
            continue
          if (
            fault.faultKind === 'run' &&
            run.dispatchPhase === 'ended' &&
            this.conversations.hasCompleteResponse(run.id) &&
            run.nativeEffectsState === 'settled'
          )
            continue
          const generation = this.conversations.schedulingConfigurationGeneration()
          let observation = this.schedulingObservation(
            this.contextDecisionCapability,
            this.schedulingScope(node.sessionId),
          )
          if (observation.status !== 'supported') {
            if (this.decisionRuntimeAdmission(node.sessionId) !== 'may_attempt') continue
            // A new Session or an expired observation needs zero-Turn native evidence.
            // Use the existing probe owner once for this consumed fault, without a retry queue.
            // oxlint-disable-next-line no-await-in-loop -- One fault uses the global probe lease; later busy facts are consumed without queuing.
            const refreshed = await this.refreshSchedulingState({ sessionId: node.sessionId })
            if (!refreshed.ok || !refreshed.value.context) continue
            observation = refreshed.value.context.observation
          }
          if (
            observation.status !== 'supported' ||
            this.disposed ||
            this.nativeQuitSealed() ||
            this.conversations.schedulingConfigurationGeneration() !== generation ||
            this.decisionRuntime ||
            this.decisionRecovery ||
            this.conversations.activeSchedulingRuntimeOwner() ||
            this.hasSessionOperation(node.sessionId, false, undefined, true) ||
            this.pendingNativeInteractions(node.sessionId).length ||
            this.conversations.archives.blocksSession(node.sessionId)
          )
            continue
          if (
            fault.faultKind === 'run' &&
            !run.reexecutedFromRunId &&
            this.conversations.executionInput(run.id)?.proof &&
            ['not_dispatched', 'settled'].includes(run.nativeEffectsState ?? '') &&
            !this.hasSessionOperation(node.sessionId, true)
          ) {
            this.launchConfirmedUnsentReexecution(fault.id, node)
            continue
          }
          if (
            fault.faultKind === 'run' &&
            ['not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
          )
            continue
          const rebuild =
            fault.faultKind === 'rebuild'
              ? this.conversations.nativeRebuildOperation(fault.faultId)
              : undefined
          if (
            fault.faultKind === 'rebuild' &&
            (!rebuild ||
              rebuild.stage !== 'unconfirmed' ||
              !rebuild.provisionalNativeSessionId ||
              !rebuild.sourceHash)
          )
            continue
          const attempt = this.conversations.reserveSchedulingRecoveryCheck(
            fault.id,
            node,
            process.pid,
          )
          if (!attempt) continue
          const checking =
            fault.faultKind === 'rebuild'
              ? this.checkNativeRebuild(node.sessionId, fault.agentId, rebuild!, attempt.id)
              : fault.faultKind === 'queue'
                ? this.inspectPreviousRun(run, true, attempt.id)
                : this.checkNativeBinding(node.sessionId, fault.agentId, run.id, attempt.id)
          if (
            ![...this.nativeChecks.values()].some(
              (entry) => entry.automaticAttemptId === attempt.id,
            )
          )
            this.conversations.settleSchedulingRecoveryCheck(attempt.id, {
              ok: false,
              physicalReleased: true,
            })
          void checking.catch(() => undefined)
        } catch {
          // Unavailable/stale facts keep their original manual recovery path; no new card or retry.
        }
      }
    }
  }

  private launchConfirmedUnsentReexecution(
    faultId: string,
    node: import('@pact/contracts').SchedulingHandoff,
  ): void {
    const original =
      node.freshnessGuard.runId && this.conversations.findRun(node.freshnessGuard.runId)
    if (!original) return
    const saved = this.conversations.executionInput(original.id)
    const cached = this.adapters.get(`${original.sessionId}:${original.agentId}`)
    const settings = this.sessions.findSettingsRevision(
      original.sessionId,
      original.settingsRevision,
    )
    if (
      !saved?.proof ||
      !cached ||
      cached.adapter.executorId !== saved.proof.executorId ||
      !settings
    )
      return
    const snapshot = this.conversations.frozenExecutionEnvelope(original.id)
    const prompt = restoreExecutionInput(
      snapshot,
      (image) => {
        if (!this.images)
          throw new RunOperationConflictError('The original image source is unavailable.')
        return this.images.resolve(original.sessionId, image)
      },
      this.conversations.skillInvocation(original.userMessageId),
    )
    const started = this.conversations.beginConfirmedUnsentReexecution({
      operationId: randomUUID(),
      faultId,
      handoff: node,
    })
    if (!started.created) return
    this.publish(started.patch)
    void this.trackExecution(started.run, async (execution) => {
      const prepared = await this.prepareSession(
        original.sessionId,
        execution.abortController.signal,
      )
      if (!prepared.ok)
        throw new AgentExecutionError('runtime_incompatible', prepared.error.message, false)
      if (
        this.adapters.get(`${original.sessionId}:${original.agentId}`)?.adapter !==
          cached.adapter ||
        !this.conversations.canDispatchReexecution(started.run.id)
      )
        throw new NativeInputWithheldError()
      await this.executeAttempts(
        execution,
        started.run,
        prompt,
        prepared.value.projectDirectory,
        settings,
        prepared.value.executablePaths,
      )
      if (this.conversations.findRun(started.run.id)?.status === 'completed')
        await this.executeRoutedContinuation(
          execution,
          started.run.userMessageId,
          prepared.value.projectDirectory,
          settings,
          prepared.value.executablePaths,
        )
    })
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
            this.retireStreamTrace(owner, execution.streamBuffer)
            owner.sourceReader?.retire()
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
          const settled = this.conversations.reconcileCompletedCollaboration(execution.run.id)
          if (settled) this.publish(settled)
        } finally {
          execution.streamBuffer?.dispose()
          execution.streamBuffer = undefined
          const finished = this.conversations.findRun(run.id)
          const task = this.conversations.collaboration(run.sessionId)
          if (
            !this.disposed &&
            this.conversations.queueState(run.sessionId).input?.state === 'queued' &&
            !this.conversations.receivedCollaborationInput(run.sessionId)?.taskId &&
            (finished?.status !== 'completed' ||
              finished.dispatchPhase !== 'ended' ||
              finished.nativeOutcome !== 'completed' ||
              !this.conversations.hasCompleteResponse(run.id) ||
              finished.nativeEffectsState === 'unknown' ||
              (task?.runId === run.id && task.status === 'failed'))
          )
            this.publish(
              this.conversations.pauseConversationQueue(
                run.sessionId,
                'The execution did not complete normally. Check its state, then resume the queued message when ready.',
              ),
            )
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
      !run.collaboration &&
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
    owner.streamTrace = this.createStreamTrace(run, owner)
    const stillOwned = (): boolean =>
      !this.disposed && this.nativeObservations.get(run.id) === owner
    const ownsCurrentNativeRun = (): boolean =>
      this.activeExecutions.get(run.sessionId) === execution &&
      this.conversations.ownsNativeControl(run.id)
    const currentControl = (): boolean => !this.disposed && ownsCurrentNativeRun()
    // Compact original-live ending receipt only; never retain another complete body.
    let completedNativeReceipt:
      | { nativeTurnId: string; source: 'live_terminal'; executorId: string }
      | undefined
    const buffer = new AgentStreamBuffer(
      (events) =>
        ownsCurrentNativeRun()
          ? this.conversations.applyStreamBatch(run.sessionId, run.id, events)
          : this.conversations.applyArchivedBatch(run.sessionId, run.id, events),
      (patch) => this.publish(patch, true, owner),
      (error) => {
        this.failRunOutput(run, error)
      },
    )
    execution.streamBuffer = buffer
    const archive = (event: import('@pact/contracts').NormalizedAgentEvent): void => {
      if (!stillOwned()) return
      if (owner.outputFailure) {
        if (
          event.type === 'turn.completed' &&
          this.conversations.findRun(run.id)?.dispatchPhase === 'ended'
        )
          this.publish(this.conversations.settleKnownNativeEnding(run.id, owner.outputFailure))
        return
      }
      let fact: import('@pact/contracts').NormalizedAgentEvent
      try {
        fact = normalizedAgentEventSchema.parse(event)
      } catch (error) {
        this.failRunOutput(run, error)
        return
      }
      this.observeNormalizedDelta(owner, fact, true)
      const large =
        fact.type === 'text.completed' &&
        Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES
      const apply = async (): Promise<void> => {
        if (!stillOwned() || owner.archiveController.signal.aborted || owner.outputFailure) return
        // Late facts preserve their answer, but never establish workflow acceptance.
        if (fact.type === 'collaboration.plan') {
          this.conversations.recordWorkflowPlan(run.id, fact)
          return
        }
        if (fact.type === 'collaboration.review') {
          this.conversations.recordWorkflowReview(run.id, {
            verdict: fact.verdict,
            ...(fact.questions ? { questions: fact.questions } : {}),
          })
          return
        }
        if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') {
          owner.archiveBuffer ??= new AgentStreamBuffer(
            (events) => this.conversations.applyArchivedBatch(run.sessionId, run.id, events),
            (patch) => this.publish(patch, true, owner),
            (error) => {
              this.failRunOutput(run, error)
            },
          )
          owner.archiveBuffer.push(fact)
        } else {
          this.flushRunOutput(run)
          if (owner.outputFailure) {
            if (
              fact.type === 'turn.completed' &&
              this.conversations.findRun(run.id)?.dispatchPhase === 'ended'
            )
              this.publish(this.conversations.settleKnownNativeEnding(run.id, owner.outputFailure))
            return
          }
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
            completedNativeReceipt?.nativeTurnId === fact.turnId
          )
            this.reconcileOwnedCompletedCollaboration(run.id, completedNativeReceipt)
        }
      }
      if (!large && !owner.archiveTail) {
        // Small facts preserve their existing synchronous durable commit order.
        void apply().catch((error: unknown) => {
          this.failRunOutput(run, error)
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
        return void this.failRunOutput(
          run,
          new AgentExecutionError('protocol_error', 'Archived answer work is full.', false),
        )
      const text = 'text' in fact ? fact.text : ''
      let reservation: ReturnType<NativeWorkingMemory['reserve']>
      try {
        reservation = owner.archiveMemory.reserve(
          4096 + text.length * 10 + Buffer.byteLength(text, 'utf8') * 2,
        )
      } catch (error) {
        this.failRunOutput(run, error)
        return
      }
      owner.archivePending += 1
      const task = (owner.archiveTail ?? Promise.resolve())
        .then(apply)
        .catch((error: unknown) => {
          this.failRunOutput(run, error)
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
      this.flushRunOutput(run)
      buffer.dispose()
      owner.archiveBuffer?.dispose()
      if (owner.outputFailure) this.workspaceChanges?.observeUncertainEffects(run.id)
      this.retireStreamTrace(owner, buffer)
      owner.sourceReader?.retire()
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
      const frozenWorkflow = this.conversations.collaboration(run.sessionId, run.id, false)
      promptEnvelope.collaboration = frozenWorkflow
        ? this.conversations.collaborationPromptState(frozenWorkflow)
        : undefined
      promptEnvelope.collaborationAuthorization = this.conversations.collaborationTurnAuthorization(
        run.id,
      )
      const originalInputBatch = this.conversations.inputBatchForRun(run.id)
      promptEnvelope.inputBatchRef = originalInputBatch ?? promptEnvelope.inputBatchRef
      promptEnvelope.requiredInputScopeRef =
        promptEnvelope.collaborationAuthorization?.sourceManifestRef ?? undefined
      // Recovery and Handoff retain their original frozen source scope, but each
      // physical reader always uses this exact current root's ephemeral capability.
      promptEnvelope.sourceGrant =
        promptEnvelope.collaboration ||
        promptEnvelope.inputBatchRef ||
        promptEnvelope.handoffContext?.some((source) => source.inputBatchRef)
          ? { runId: run.id, grant: generation }
          : undefined
      if (promptEnvelope.sourceGrant)
        owner.sourceReader = new FrozenSourceReader(
          promptEnvelope.sourceGrant,
          run.sessionId,
          this.conversations,
          () => stillOwned() && !signal.aborted && this.ownsFrozenSourceRoot(run),
          () => execution.promptEnvelope?.inputBatchRef?.id ?? promptEnvelope.inputBatchRef?.id,
          (error) => {
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
          },
          signal,
          originalInputBatch?.id,
        )
      execution.promptEnvelope = promptEnvelope
      adapter.preflightPrompt?.({
        runId: run.id,
        sessionId: run.sessionId,
        cwd,
        promptEnvelope,
        ...(context?.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        permissionMode: run.permissionMode,
        peerAssistanceAllowed,
        model: run.model,
        effort: run.effort,
        speed: run.speed ?? 'native',
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
      let recovery: AgentRunInput['recovery']
      const schedulingSettings = this.conversations.schedulingSettings()
      if (schedulingSettings.enabled && schedulingSettings.selection) {
        let captureMemory: ReturnType<NativeWorkingMemory['reserve']> | undefined
        try {
          captureMemory = new NativeWorkingMemory().reserve(8 * 1024 * 1024 + 128 * 1024)
          const captured = await this.conversations.captureExecutionInput({
            runId: run.id,
            nativeGeneration: generation,
            requested: {
              provider: run.agentId,
              model: settings.agents[run.agentId].model,
              effort: settings.agents[run.agentId].effort,
              speed: run.speed ?? 'native',
              permissionMode: run.permissionMode ?? 'native',
            },
            source: encodeNativeJsonFrame(pathlessExecutionInput(promptEnvelope), signal),
            signal,
          })
          const original = run.reexecutedFromRunId
            ? this.conversations.executionInput(run.reexecutedFromRunId)
            : undefined
          if (captured)
            recovery = {
              inputSha256: captured.inputSha256,
              ...(original?.effective && original.proof
                ? {
                    expected: {
                      settings: original.effective,
                      executorId: original.proof.executorId,
                      nativeSessionId: original.proof.nativeSessionId,
                    },
                    canDispatch: () =>
                      currentControl() &&
                      !signal.aborted &&
                      !this.pendingNativeInteractions(run.sessionId).length &&
                      this.conversations.canDispatchReexecution(run.id),
                  }
                : {}),
              recordEffectiveSettings: (effective, identity) => {
                if (stillOwned())
                  this.conversations.recordEffectiveExecutionSettings(
                    run.id,
                    generation,
                    effective,
                    identity,
                  )
              },
              recordConfirmedUnsent: (boundary, identity) => {
                if (stillOwned())
                  this.conversations.recordConfirmedUnsent(run.id, generation, boundary, identity)
              },
            }
        } catch (error) {
          if (signal.aborted || run.reexecutedFromRunId) throw error
          // Optional capture failure cannot change the user's original Send.
        } finally {
          captureMemory?.release()
        }
      }
      if (run.reexecutedFromRunId && (!recovery?.expected || !recovery.canDispatch?.()))
        throw new NativeInputWithheldError()
      for await (const event of adapter.run(
        {
          recovery,
          runId: run.id,
          sessionId: run.sessionId,
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
          currentPromptEnvelope: () => execution.promptEnvelope ?? promptEnvelope,
          model: settings.agents[run.agentId].model,
          effort: settings.agents[run.agentId].effort,
          speed: run.speed ?? 'native',
          recordDispatch: (phase, nativeId, executorId) => {
            if (phase === 'possibly_sent') {
              try {
                this.conversations.assertWorkflowDispatch(run.id)
              } catch {
                throw new NativeInputWithheldError()
              }
            }
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
          observeNativeDelta: (value) => {
            if (stillOwned()) this.observeNativeDelta(owner, value)
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
            // Keep the bounded ending durable before any optional body flush or report work.
            const metadata =
              evidence.kind === 'ended'
                ? {
                    kind: evidence.kind,
                    identity: evidence.identity,
                    source: evidence.source,
                    outcome: evidence.outcome,
                    ...(evidence.planUnavailable || evidence.output?.planUnavailable
                      ? { planUnavailable: true as const }
                      : {}),
                  }
                : evidence
            this.publish(this.conversations.recordNativeEvidence(metadata, 'retry'))
            if (evidence.kind === 'ended') {
              this.flushRunOutput(run)
              if (owner.outputFailure) {
                if (!currentControl())
                  this.publish(
                    this.conversations.settleKnownNativeEnding(run.id, owner.outputFailure),
                  )
                return
              }
              if (
                evidence.output?.plan ||
                evidence.output?.retainedPlan ||
                evidence.output?.reviewResult ||
                evidence.output?.reviewVerdict
              )
                this.publish(this.conversations.recordNativeEvidence(evidence, 'retry'))
            }
            if (
              evidence.kind === 'ended' &&
              evidence.source === 'live_terminal' &&
              evidence.outcome === 'completed' &&
              evidence.output?.completeness === 'complete' &&
              evidence.identity.nativeTurnId &&
              evidence.identity.executorId
            )
              completedNativeReceipt = {
                nativeTurnId: evidence.identity.nativeTurnId,
                source: evidence.source,
                executorId: evidence.identity.executorId,
              }
          },
          recordInputConsumption: (id, identity) => {
            if (!stillOwned() || !identity.nativeTurnId) return
            this.flushRunOutput(run)
            const steering = execution.steering
            this.publish(
              this.conversations.recordQueuedSteerConsumption(
                {
                  runId: run.id,
                  sessionId: run.sessionId,
                  bindingGeneration: run.bindingGeneration ?? 1,
                  nativeSessionId: identity.nativeSessionId,
                  nativeTurnId: identity.nativeTurnId,
                  executorId: identity.executorId,
                },
                id,
                steering?.inputId === id ? steering.invocation : undefined,
              ),
            )
            this.refreshExecutionInputScope(execution)
          },
          recordOutputFailure: (error) => {
            if (stillOwned()) this.failRunOutput(run, error)
          },
          recordArchivedEvent: archive,
          collaborationSourceReader: owner.sourceReader,
          readCollaborationSourcePart: owner.sourceReader
            ? (raw) => {
                const {
                  binding: _binding,
                  nextRead: _nextRead,
                  ...page
                } = owner.sourceReader!.read(raw).page
                return page
              }
            : undefined,
          recordWorkflowPlan: (plan) => {
            if (stillOwned()) this.conversations.recordWorkflowPlan(run.id, plan)
          },
          recordWorkflowPlanRetained: (plan) => {
            if (stillOwned()) this.conversations.recordWorkflowPlanRetained(run.id, plan)
          },
          recordWorkflowPlanUnavailable: () => {
            if (stillOwned()) this.conversations.recordWorkflowPlanUnavailable(run.id)
          },
          recordWorkflowReview: (verdict) => {
            if (stillOwned()) this.conversations.recordWorkflowReview(run.id, verdict)
          },
          recordWorkflowInputResult: (outcome) => {
            if (stillOwned()) this.conversations.recordWorkflowInputResult(run.id, outcome)
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
              const saved = this.conversations.findRun(run.id)
              if (
                report.state === 'settled' &&
                report.reason === 'workflow_input_withheld' &&
                saved &&
                !saved.nativeTurnId &&
                !saved.nativeOutcome &&
                ['not_sent', 'rejected'].includes(saved.dispatchPhase ?? '') &&
                this.conversations.ownsNativeControl(run.id)
              )
                this.publish(
                  this.conversations.setContinuation(
                    run.sessionId,
                    run.agentId,
                    'ready',
                    undefined,
                    run.bindingGeneration,
                  ),
                )
              const settled = this.conversations.reconcileCompletedCollaboration(run.id)
              if (settled) this.publish(settled)
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
        let fact: import('@pact/contracts').NormalizedAgentEvent
        try {
          fact = normalizedAgentEventSchema.parse(event)
        } catch (error) {
          if (
            event.type === 'text.delta' ||
            event.type === 'text.completed' ||
            event.type === 'reasoning.summary.delta' ||
            event.type === 'reasoning.summary.completed'
          )
            throw this.failRunOutput(run, error)
          throw error
        }
        if (!currentControl()) {
          archive(fact)
          continue
        }
        this.observeNormalizedDelta(owner, fact, false)
        if (owner.outputFailure) throw owner.outputFailure
        if (fact.type === 'session.title.updated') {
          if (reportedTitle) continue
        }
        if (fact.type === 'collaboration.plan') {
          buffer.flush()
          this.conversations.recordWorkflowPlan(run.id, fact)
          continue
        }
        if (fact.type === 'collaboration.review') {
          buffer.flush()
          this.conversations.recordWorkflowReview(run.id, {
            verdict: fact.verdict,
            ...(fact.questions ? { questions: fact.questions } : {}),
          })
          continue
        }
        if (fact.type === 'peer.assistance.requested' && !peerAssistanceAllowed) continue
        if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') buffer.push(fact)
        else {
          this.flushRunOutput(run)
          if (owner.outputFailure) throw owner.outputFailure
          if (
            fact.type === 'text.completed' &&
            Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES
          ) {
            const { text, ...metadata } = fact
            try {
              this.publish(
                await this.conversations.completeAnswer(
                  run.id,
                  metadata,
                  (bodySignal) => Conversation.answerParts(text, bodySignal),
                  AbortSignal.any([signal, owner.archiveController.signal]),
                ),
              )
            } catch (error) {
              throw this.failRunOutput(run, error)
            }
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
              if (fact.type === 'text.completed' || fact.type === 'reasoning.summary.completed')
                throw this.failRunOutput(run, error)
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
          if (!reportedTitle && !run.collaboration)
            this.scheduleTitleEnrichment(adapter, run, titleBinding.nativeSessionId, cwd)
      }
    } catch (error) {
      buffer.flush()
      if (this.disposed) return
      const failure = classifyAgentError(error)
      if (failure.kind === 'response_too_large') this.failRunOutput(run, error)
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
        if (completedNativeReceipt) {
          if (owner.archiveTail) await owner.archiveTail
          this.reconcileOwnedCompletedCollaboration(run.id, completedNativeReceipt)
        }
      } else if (saved?.dispatchPhase === 'rejected' || saved?.dispatchPhase === 'not_sent') {
        this.publish(this.conversations.failRun(run.id, failure.kind, failure.message, false))
        const currentContext = this.conversations.nativeContext(run.sessionId, run.agentId)
        const unsentProof = this.conversations.executionInput(run.id)?.proof
        const confirmedUnsentBinding = Boolean(
          unsentProof &&
          currentContext &&
          !saved.nativeTurnId &&
          !saved.nativeOutcome &&
          ['not_dispatched', 'settled'].includes(saved.nativeEffectsState ?? '') &&
          currentContext.nativeSessionId === unsentProof.nativeSessionId &&
          currentContext.bindingGeneration === unsentProof.bindingGeneration &&
          currentContext.executorId === unsentProof.executorId &&
          adapter.executorId === unsentProof.executorId &&
          !adapter.hasActiveBackgroundWork?.(run.id) &&
          !this.pendingNativeInteractions(run.sessionId).length &&
          ![
            'authentication_required',
            'quota_or_rate_limit',
            'permission_blocked',
            'runtime_incompatible',
            'context_resume_failed',
            'native_session_occupied',
          ].includes(failure.kind),
        )
        if (confirmedUnsentBinding)
          this.publish(
            this.conversations.setContinuation(
              run.sessionId,
              run.agentId,
              'ready',
              undefined,
              run.bindingGeneration,
            ),
          )
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
          confirmedUnsentBinding ||
          (context?.continuationState === 'ready' &&
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
              capacityRefusedBeforeStartup))
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
      ) {
        owner.sourceReader?.retire()
        owner.adapter.retireSourceGrant?.({ runId, grant: owner.generation })
      }
    }
  }

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
      run.forkSourceRunId ||
      run.nativeTurnId !== receipt.nativeTurnId ||
      run.dispatchPhase !== 'ended' ||
      run.nativeOutcome !== 'completed'
    )
      return
    const binding = this.conversations.nativeContext(run.sessionId, run.agentId)
    if (
      !binding ||
      binding.nativeSessionId !== run.nativeSessionId ||
      binding.bindingGeneration !== (run.bindingGeneration ?? 1)
    )
      return
    const patch = this.conversations.reconcileCompletedCollaboration(runId)
    if (patch) this.publish(patch)
  }

  private startNativeCheck(
    key: string,
    controller: AbortController,
    operation: () => Promise<RpcResult<ConversationPatch>>,
    options: {
      receiptSessionId?: string
      onPhysicalCompletion?: () => void
      automaticAttemptId?: string | undefined
      onLogicalTimeout?: () => void
    } = {},
  ): Promise<RpcResult<ConversationPatch>> {
    const physical = Promise.withResolvers<void>()
    const interruption = Promise.withResolvers<RpcResult<ConversationPatch>>()
    const aborted = (): void =>
      interruption.resolve({
        ok: false,
        error: {
          code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
          message: 'Native state could not be confirmed. No task was reexecuted.',
        },
      })
    const owner: NonNullable<ReturnType<typeof this.nativeChecks.get>> = {
      controller,
      task: interruption.promise,
      physicalCompletion: physical.promise,
      physicalOperations: new Set(),
      logicalTimeout: () => {
        try {
          options.onLogicalTimeout?.()
        } catch {
          // A failed recovery projection cannot disable the check's deadline.
        } finally {
          aborted()
        }
      },
      phase: 'checking',
      automaticAttemptId: options.automaticAttemptId,
      configurationGeneration: options.automaticAttemptId
        ? this.conversations.schedulingConfigurationGeneration()
        : undefined,
      ...(options.receiptSessionId ? { receiptSessionId: options.receiptSessionId } : {}),
    }
    this.nativeChecks.set(key, owner)
    controller.signal.addEventListener('abort', aborted, { once: true })
    const timer = options.automaticAttemptId
      ? setTimeout(
          () => controller.abort(),
          Math.max(
            0,
            Date.parse(
              this.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)!.deadline,
            ) - Date.now(),
          ),
        )
      : undefined
    let workSucceeded = false
    const work = Promise.resolve()
      .then(() => {
        if (
          options.automaticAttemptId &&
          Date.now() >=
            Date.parse(
              this.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)!.deadline,
            )
        )
          controller.abort()
        controller.signal.throwIfAborted()
        if (options.automaticAttemptId)
          this.conversations.startSchedulingRecoveryCheck(options.automaticAttemptId)
        return operation()
      })
      .then((result) => {
        workSucceeded = result.ok
        return result
      })
    owner.task = Promise.race([work, interruption.promise])
      .then((result) => {
        if (options.automaticAttemptId)
          this.conversations.settleSchedulingRecoveryCheck(options.automaticAttemptId, {
            ok: result.ok,
            physicalReleased: false,
          })
        return result
      })
      .finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', aborted)
        if (this.nativeChecks.get(key) === owner) {
          owner.phase = 'cleanup_unconfirmed'
          this.nativeMetadataChanged()
        }
      })
    void work
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.all(owner.physicalOperations)
        if (options.automaticAttemptId)
          this.conversations.settleSchedulingRecoveryCheck(options.automaticAttemptId, {
            ok: workSucceeded,
            physicalReleased: true,
          })
        if (this.nativeChecks.get(key) === owner) {
          owner.adapter = undefined
          this.nativeChecks.delete(key)
          physical.resolve()
          this.nativeMetadataChanged()
          if (
            options.automaticAttemptId &&
            !this.disposed &&
            owner.configurationGeneration === this.conversations.schedulingConfigurationGeneration()
          ) {
            const [sessionId, agentId] = key.split(':')
            if (
              sessionId &&
              (agentId === 'codex' || agentId === 'claude') &&
              !this.pendingNativeInteractions(sessionId).length &&
              this.schedulingObservation(
                this.contextDecisionCapability,
                this.schedulingScope(sessionId),
              ).status === 'supported' &&
              this.conversations.proposeRelayNativeRecovery(
                sessionId,
                agentId,
                this.conversations.schedulingRecoveryAttempt(options.automaticAttemptId)?.faultId,
              )
            )
              this.publish(this.conversations.metadataPatch(sessionId))
          }
          this.schedulePendingRoutedContinuations()
          options.onPhysicalCompletion?.()
        }
        physical.resolve()
        return undefined
      })
      .catch(physical.reject)
    // A rejected cleanup stays owned; disposal reports the failure instead of releasing its slot.
    void physical.promise.catch(() => undefined)
    this.nativeMetadataChanged()
    return owner.task
  }

  private async runNativeCheck<T>(
    controller: AbortController,
    begin: (
      context: AgentNativeCheckContext | undefined,
      signal: AbortSignal,
    ) => AgentNativeCheckOperation<T>,
    receiptStage = false,
  ): Promise<T> {
    const owner = [...this.nativeChecks.values()].find((entry) => entry.controller === controller)
    if (
      owner?.automaticAttemptId &&
      Date.now() >=
        Date.parse(this.conversations.schedulingRecoveryAttempt(owner.automaticAttemptId)!.deadline)
    )
      controller.abort()
    if (!owner || controller.signal.aborted)
      throw new Error('The native check is no longer current.')
    const child = owner.automaticAttemptId ? undefined : new AbortController()
    const checkSignal = child
      ? AbortSignal.any([controller.signal, child.signal])
      : controller.signal
    const interruption = Promise.withResolvers<never>(),
      ownerInterruption = Promise.withResolvers<never>()
    const interrupted = () => interruption.reject(new Error('The native check was interrupted.'))
    const ownerAborted = () =>
      ownerInterruption.reject(new Error('The native check owner was cancelled.'))
    checkSignal.addEventListener('abort', interrupted, { once: true })
    controller.signal.addEventListener('abort', ownerAborted, { once: true })
    // Both rejections are also observed while the result/physical branch is awaiting its peer.
    void interruption.promise.catch(() => undefined)
    void ownerInterruption.promise.catch(() => undefined)
    const timer = child
      ? setTimeout(() => {
          try {
            if (!receiptStage) owner.logicalTimeout()
          } finally {
            child.abort()
          }
        }, DELIVERY_RECONCILIATION_TIMEOUT_MS)
      : undefined
    try {
      const operation = begin(
        owner.automaticAttemptId
          ? {
              operationId: owner.automaticAttemptId,
              recordPhysicalOwner: (physicalOwner) =>
                this.conversations.recordSchedulingCheckPhysicalOwner(
                  owner.automaticAttemptId!,
                  physicalOwner,
                ),
            }
          : undefined,
        checkSignal,
      )
      owner.physicalOperations.add(operation.physicalCompletion)
      void operation.physicalCompletion.then(
        () => owner.physicalOperations.delete(operation.physicalCompletion),
        () => undefined,
      )
      try {
        const result = await Promise.race([
          operation.result.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          ),
          interruption.promise,
        ])
        // Serial stages cannot overlap a still-owned RPC, reader, encoder, or cleanup.
        await Promise.race([operation.physicalCompletion, interruption.promise])
        controller.signal.throwIfAborted()
        if (!result.ok) throw result.error
        return result.value
      } catch (error) {
        if (child?.signal.aborted && !controller.signal.aborted)
          await Promise.race([operation.physicalCompletion, ownerInterruption.promise])
        throw error
      }
    } finally {
      clearTimeout(timer)
      checkSignal.removeEventListener('abort', interrupted)
      controller.signal.removeEventListener('abort', ownerAborted)
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
    const original = await read(task.taskMessageId)
    const latest =
      task.latestUserMessageId !== task.taskMessageId
        ? await read(task.latestUserMessageId)
        : undefined
    return { ...(original ? { original } : {}), ...(latest ? { latest } : {}) }
  }

  private async validateCommentAnchor(
    sessionId: string,
    anchor: Extract<CommentDraftSaveInput, { mode: 'create' }>['anchor'],
  ): Promise<void> {
    if (anchor.type === 'file') {
      await this.projectFiles.validateCommentAnchor(sessionId, anchor)
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
    if (anchor.plan || anchor.report)
      throw new Error('The immutable plan or review source is unavailable.')
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
    const projection = await import('../../shared/message-anchor-text.js')
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
          ? new ClaudeAgentAdapter(executablePath, undefined, this.ipcTraffic)
          : new CodexAgentAdapter(executablePath, undefined, {}, this.ipcTraffic)
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

  private publish(
    patch: ConversationPatch,
    progress = false,
    streamOwner?: NativeObservation,
  ): void {
    const streamTrace = progress && streamOwner ? this.currentStreamTrace(streamOwner) : undefined
    if (streamTrace) this.bumpStreamTrace(streamTrace, streamTrace.data.publication, 'attempts')
    const decision = this.decisionRuntime
    if (!progress && decision?.sessionId === patch.sessionId && !decision.current()) {
      decision.controller.abort()
      void decision.runtime?.dispose()
    }
    if (!progress) {
      this.conversations.refreshSchedulingRecoveryFacts(patch.sessionId)
      if (!this.hasSessionOperation(patch.sessionId, false, undefined, true))
        this.conversations.armSchedulingRecoveryFaults(patch.sessionId)
      this.nativeMetadataChanged()
      this.schedulePendingRoutedContinuations()
    }
    if (!progress) patch.forkBlocked = this.forkBlocked(patch.sessionId)
    if (!progress)
      patch.sessionIssues = this.sessionIssues(patch.sessionId, patch.nativeContexts ?? [])
    // Interaction changes publish non-progress facts. Do not inflate every
    // high-frequency Delta or leak private details into the stream window.
    if (!progress) patch.pendingNativeInteractions = this.pendingNativeInteractions(patch.sessionId)
    if (!progress)
      patch.preparedInputContinuation = this.conversations.preparedInputContinuation(
        patch.sessionId,
      )
    if (!progress)
      patch.relaySchedulingDecision = this.projectRelaySchedulingDecision(
        patch.sessionId,
        patch.sessionIssues,
      )
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
      if (streamTrace) {
        this.bumpStreamTrace(streamTrace, streamTrace.data.publication, 'suppressed')
        streamTrace.data.publication.lastMs = streamTrace.data.capturedAfterMs
      }
      this.suppressedProgress += 1
      return
    }
    if (progress) {
      if (streamTrace) {
        this.bumpStreamTrace(streamTrace, streamTrace.data.publication, 'published')
        streamTrace.data.publication.lastMs = streamTrace.data.capturedAfterMs
      }
      this.publishedProgress += 1
    }
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
