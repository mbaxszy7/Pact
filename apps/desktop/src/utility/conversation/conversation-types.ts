import type { AgentAdapter, AgentPromptEnvelope } from '@pact/agent-runtime'
import type {
  AgentRun,
  AnchoredComment,
  CollaborationTask,
  ConversationMessageRoute,
  ConversationPatch,
  ConversationSendInput,
  ConversationStreamTrace,
  DecisionConnection,
  FrozenSkillInvocation,
  InitialTaskRolesProposal,
  InputRoutingProposal,
  NativeInteractionDetails,
  NativePermissionDecision,
  NativePermissionRequest,
  NativeQuitPreparation,
  NativeUserInputResult,
  OriginSideChat,
  RpcResult,
  RuntimeAgentId,
  SchedulingHandoff,
  SessionForkResult,
  SkillBinding,
  SkillDocument,
  TerminalQuitSummaryRow,
} from '@pact/contracts'
import type { PreparedInputDispatch, SessionRepository } from '@pact/persistence'

import type { AgentStreamBuffer } from './agent-stream-buffer'
import type { AgyAcpConnectionPool } from './agy-acp-connection'
import type { DecisionRuntime } from './decision-runtime'
import type { FrozenSourceReader } from './frozen-source-reader'
import type { NativeMemoryReservation } from './native-working-memory'
import type { RunOutputArchiver } from './run-output-archiver'

export const DELIVERY_RECONCILIATION_TIMEOUT_MS = 10_000
export const MAX_AGENT_OPERATIONS = 5
export const BACKGROUND_INPUT_REASON = 'Check the background work before sending another message.'
export const MAX_ADAPTER_SLOTS = 5
export const PREPARATION_TIMEOUT_MS = 10_000
export const AGY_PREPARATION_TIMEOUT_MS = 38_000
export const AGY_SKILL_DISCOVERY_OPERATION_MS = 36_000
export const AGY_SKILL_DOCUMENT_OPERATION_MS = 38_000
export const BACKGROUND_STOP_TIMEOUT_MS = 5_000
export const CAPACITY_NOTICE =
  'At most 5 Sessions can run Agents at once. Try again when one finishes.'

export interface ActiveExecution {
  adapter?: AgentAdapter | undefined
  run: AgentRun
  protectedAgentId?: RuntimeAgentId | undefined
  deliveryPossible: boolean
  enteredNativeAdapter?: boolean | undefined
  cancelledByUser?: boolean | undefined
  abortController: AbortController
  streamBuffer?: AgentStreamBuffer | undefined
  lastArchiver?: RunOutputArchiver | undefined
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

export interface PreparedSession {
  session: NonNullable<ReturnType<SessionRepository['find']>>
  projectDirectory: string
  executablePaths: Record<RuntimeAgentId, string>
}

export interface ActiveTitleEnrichment {
  runId: string
  agentId: RuntimeAgentId
  abortController: AbortController
  promise: Promise<void>
}

export interface ActiveNativeRebuild {
  adapter?: AgentAdapter | undefined
  agentId: RuntimeAgentId
  rebuildId: string
  abortController: AbortController
  completion?: Promise<void> | undefined
  executorId?: string | undefined
}

export interface CachedAdapter {
  sessionId: string
  agentId: RuntimeAgentId
  executablePath: string
  cwd: string
  adapter: AgentAdapter
  appDataDir?: string | undefined
  peerTargetAgentId?: Exclude<RuntimeAgentId, 'agy'> | undefined
  poolKey?: string | undefined
  connectionPool?: AgyAcpConnectionPool | undefined
  disposeExtra?: (() => Promise<void>) | undefined
  retireFullAccess?: ((options?: { cwd?: string; sessionId?: string }) => Promise<void>) | undefined
  nativeTitleObserved?: {
    nativeSessionId: string
    bindingGeneration: number
    executorId: string | undefined
  }
}

export interface ActiveNativeTitleSync {
  adapter: AgentAdapter
  executorId: string | undefined
  abortController: AbortController
  desiredKey: string
  dirty: boolean
  cancelled: boolean
  promise: Promise<void>
}

export interface PreparingSend {
  input: ConversationSendInput
  options: SendOptions
  protectedAgentId?: RuntimeAgentId | undefined
  controller: AbortController
  task: Promise<RpcResult<ConversationPatch>>
}

export interface DecisionInvocationOwner {
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

export interface SendOptions {
  collaborationActionReceiptId?: string | undefined
  preparedInput?: PreparedInputDispatch | undefined
  inputRouting?: InputRoutingProposal | undefined
  initialTaskRoles?: InitialTaskRolesProposal | undefined
  initialRolesConsidered?: boolean
  preparedSelectionCurrent?: (() => boolean) | undefined
  preparationDeadlineAt?: number | undefined
  schedulingHandoff?: SchedulingHandoff | undefined
  imageOwnerKey?: string
  preserveDraftComments?: boolean
  sourceProposalId?: string
  sourceMessageId?: string
  expectedSettingsRevision?: number | undefined
  collaboration?: CollaborationTask | undefined
  expectedCollaborationRevision?: number | undefined
  receivedInputId?: string | undefined
  receivedComments?: AnchoredComment[] | undefined
  queuedRoute?: ConversationMessageRoute | undefined
  queuedRolePolicy?: CollaborationTask['rolePolicy'] | undefined
  originSideChat?: OriginSideChat | undefined
  syncMainOperationId?: string | undefined
}

export interface PreparingContinuation {
  sessionId: string
  userMessageId: string
  protectedAgentId: RuntimeAgentId
  controller: AbortController
  completion?: Promise<void> | undefined
}

export interface OwnedStreamTrace {
  data: ConversationStreamTrace
  startedAt: number
  expiresAt: number
  reservation: NativeMemoryReservation
}

export interface NativeObservation {
  shutdown?:
    | {
        deadlineAt: number
        nativeSessionId: string
        nativeTurnId: string
        executorId: string
        bindingGeneration: number
        ended: boolean
        drained: boolean
        failed: boolean
        complete: () => void
      }
    | undefined
  sourceReader?: FrozenSourceReader | undefined
  streamTrace?: OwnedStreamTrace | undefined
  generation: string
  adapter: AgentAdapter
  archiver: RunOutputArchiver
  foregroundExited: boolean
  observationController: AbortController
  backgroundReportTasks?: Set<Promise<void>> | undefined
  backgroundReportFailed?: boolean | undefined
  release?: (() => void) | undefined
  backgroundStop?:
    | {
        controller: AbortController
        deadline: ReturnType<typeof setTimeout>
      }
    | undefined
  backgroundStopUnconfirmed?: boolean
}

export interface NativeInteractionOwner {
  id: string
  sessionId: string
  agentId: RuntimeAgentId
  bindingGeneration?: number
  executorId?: string | undefined
  valid: () => boolean
}

export interface PendingPermissionEntry {
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

export interface ActiveNativeCheck {
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
  targetRunId?: string | undefined
}

export interface ActiveNativeFork {
  sourceSessionId: string
  sessionId?: string
  operationId?: string
  controller: AbortController
  completion?: Promise<void>
  activeAdapters?: Set<AgentAdapter>
}

export interface NativeQuitPreparationState {
  operationId: string
  result: RpcResult<NativeQuitPreparation>
  sealed: boolean
  expired: boolean
  timer?: ReturnType<typeof setTimeout> | undefined
}

export interface SkillCatalogEntry {
  generation: string
  expiresAt: number
  key: string
  checkedAt: string
  entries: SkillBinding[]
  failure?: boolean
}

export interface SkillDiscoveryEntry {
  sessionId: string
  agentId: RuntimeAgentId
  controller: AbortController
  readers: Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>
  invalidated?: boolean
  refresh: boolean
  usedCache?: boolean
  task: Promise<SkillBinding[]>
}

export interface SkillDocumentOwner {
  requestId: string
  controller: AbortController
  task: Promise<RpcResult<SkillDocument>>
}

export interface ForkPreparationEntry {
  messageId: string
  task: Promise<RpcResult<SessionForkResult>>
}

export type DecisionConnectionState = DecisionConnection & { generation: number }

export interface ConversationTerminalCoordinator {
  listBlockingProjectSummaries(projectId: string): TerminalQuitSummaryRow[]
  acquireProjectArchiveLock(projectId: string): () => void
  releaseIdleProjectTerminals(projectId: string): Promise<void>
}
