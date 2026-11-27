import type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  AgentSpeed,
  ClaudePlanCheckpoint,
  CollaborationInputObservation,
  CollaborationRetainedPlan,
  CollaborationReviewObservation,
  CollaborationSourceReadResult,
  ConfirmedUnsentBoundary,
  NativeBackgroundReport,
  NativeBackgroundReportIdentity,
  NativeContextRebuildChunk,
  NativeEvidenceIdentity,
  NativeInitializationWitness,
  NativeLoopDeltaObservation,
  NativePermissionDecision,
  NativePermissionRequest,
  NativeProbeResult,
  NativeUserInputRequest,
  NativeUserInputResult,
  NormalizedAgentEvent,
  RunEffectiveExecutionSettings,
  SchedulingCheckPhysicalOwner,
  SessionPermissionMode,
  SkillBinding,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import type { AgentPromptEnvelope } from './prompt-envelope.js'
import type { AgentCollaborationSourceReader } from './source-capability.js'

export type AgentId = 'claude' | 'codex' | 'agy'

export type NativePermissionRequester = (
  request: Omit<NativePermissionRequest, 'id' | 'createdAt'>,
  signal: AbortSignal,
) => Promise<NativePermissionDecision>

export type NativeUserInputRequester = (
  request: NativeUserInputRequest,
  signal: AbortSignal,
) => Promise<NativeUserInputResult>

export type NativeTitleObserver = (nativeSessionId: string, logicalTitle?: string) => void

export interface AgentProbeResult {
  id: AgentId
  available: boolean
  version?: string
  reason?: string
}

export interface AgentNativeCheckOperation<T> {
  result: Promise<T>
  /** Resolves only after owned RPCs, readers, and their cleanup have physically joined. */
  physicalCompletion: Promise<void>
}

export interface AgentNativeCheckContext {
  operationId: string
  recordPhysicalOwner: (owner: SchedulingCheckPhysicalOwner) => void
}

export interface AgentAdapter {
  readonly id: AgentId
  readonly executorId?: string
  hasActiveBackgroundWork?(runId?: string): boolean
  /** Observable work retained by this exact executor after its root reply ends. */
  backgroundWork?(runId: string, executorId: string): 'working' | 'stoppable' | undefined
  /** Send native cancellation to that owner. The observation still proves settlement. */
  stopBackgroundWork?(runId: string, executorId: string, signal: AbortSignal): Promise<void>
  probe(signal?: AbortSignal): Promise<AgentProbeResult>
  discoverSkills?(cwd: string, signal: AbortSignal): Promise<SkillBinding[]>
  setSkillCatalogListener?(listener: (() => void) | undefined): void
  preflightPrompt?(input: AgentRunInput): void
  /** Withdraw only the matching frozen-source capability; native work observation remains owned. */
  retireSourceGrant?(owner: { runId: string; grant: string }): void
  probeNativeStatus?(input: AgentNativeProbeInput, signal: AbortSignal): Promise<NativeProbeResult>
  beginNativeStatusCheck?(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult>
  rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult>
  /** Pure candidate inspection: never initializes/resumes/creates/seeds native work. */
  inspectNativeRebuild?(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined>
  beginNativeRebuildCheck?(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined>
  /** Read-only exact native-prefix preparation; never forks, resumes or submits a prompt. */
  prepareNativeFork?(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary>
  forkNativeContext?(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult>
  /** Pure readback. A persisted initialization witness is required to confirm cold readiness. */
  inspectNativeFork?(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection>
  /** Initialize the same already-verified candidate, with zero Pact model input. */
  initializeNativeFork?(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult>
  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent>
  /** Append only to the exact live owner; never interrupts, resumes, or starts a replacement Run. */
  steer?(input: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult>
  /** Read-only receipt checking, separate from root outcome/continuation evidence. */
  probeNativeInputs?(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void>
  beginNativeInputsCheck?(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void>
  enrichTitle?(input: AgentTitleEnrichmentInput, signal: AbortSignal): Promise<string | undefined>
  /** Cosmetic metadata only; never starts/resumes a Native context or submits model input. */
  setNativeTitle?(
    input: AgentNativeTitleInput,
    signal: AbortSignal,
  ): Promise<'synchronized' | 'unavailable' | 'unknown_delivery'>
  dispose(shutdown?: AgentShutdownSettlement): Promise<void>
}

/** App quit only: the existing foreground owner may settle before the same flush deadline. */
export interface AgentShutdownSettlement {
  flushDeadlineAt: number
  foregroundSettlement?: Promise<void> | undefined
}

export interface AgentSteerInput {
  runId: string
  inputId: string
  nativeSessionId: string
  nativeTurnId: string
  bindingGeneration: number
  nativeGeneration: string
  promptEnvelope: AgentPromptEnvelope
  recordDispatch: (phase: 'possibly_sent' | 'accepted' | 'rejected') => void
  /** A matched native input UUID, not merely SDK write completion. */
  recordConsumption: (inputId: string) => void
}

export type AgentSteerResult =
  | { status: 'accepted' | 'submitted' }
  | { status: 'unsupported' | 'rejected'; reason: string }

export interface AgentNativeForkSourceInput {
  cwd: string
  nativeSessionId: string
  nativeTurnId: string
  /** Exact ordered native User UUIDs consumed by this logical Run, including its root. */
  nativeInputIds?: readonly string[]
  runId: string
  bindingGeneration: number
  throughSequence: number
  /** Last Pact peer-context cursor accepted into this particular native prefix. */
  deliveryCursor: number
  /** Exact complete logical Pact answer, hashed with SHA-256; never a guessed final text fragment. */
  responseHash: string
}

export type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  AgyNativeForkCutMetadata,
  AgyRebuildInitializationWitness,
  CodexInitializationWitness,
  NativeInitializationWitness,
} from '@pact/contracts'

export interface AgentNativeForkInput {
  operationId: string
  sessionId: string
  cwd: string
  model: string | null
  effort: string | null
  permissionMode: SessionPermissionMode
  source: AgentNativeForkBoundary
  lastDispatchedPhase?: 'fork' | 'initialize'
  nativeSessionId?: string
  witness?: AgentNativeForkWitness
  requestPermission?: NativePermissionRequester
  requestUserInput?: NativeUserInputRequester
  /** Must commit possible dispatch before any native write/start. */
  onDispatched: (executorId: string) => Promise<void>
  onCandidate: (nativeSessionId: string, witness?: AgentNativeForkWitness) => Promise<void>
  reportNativeWork: (report: { executorId: string; state: 'unknown' | 'settled' }) => void
}

export interface AgentNativeForkResult {
  nativeSessionId: string
  witness: AgentNativeForkWitness
}

export type AgentNativeForkInspection =
  | { kind: 'verified'; result: AgentNativeForkResult; ready: boolean; workSettled: boolean }
  | { kind: 'missing'; reason: string }
  | { kind: 'unconfirmed'; reason: string }

export interface AgentNativeRunProbeInput extends NativeEvidenceIdentity {
  target?: 'run'
  cwd: string
  model: string | null
  effort: string | null
  observeNativeTitle?: NativeTitleObserver
  /** Root plus accurately consumed native inputs; absence preserves legacy single-Turn probing. */
  nativeInputIds?: readonly string[]
  /** Validated native terminal already persisted by Repository, never a legacy Completed label. */
  confirmedTerminal?: Extract<NativeProbeResult, { kind: 'ended' }>
  /** Explicit readback of a missing artifact, even when the natural answer is complete. */
  inspectMissingPlan?: boolean
  /** Host-frozen planner scope; ordinary/review roots do not recover plan metadata. */
  planSource?: boolean
  planCheckpoint?: ClaudePlanCheckpointSource | undefined
}

/** Borrowed host capability; only read after the native owner admits its working memory. */
export interface ClaudePlanCheckpointSource {
  checkpoint: ClaudePlanCheckpoint
  read(signal: AbortSignal): Promise<string>
}

export interface AgentNativeInitializedBindingProbeInput extends NativeEvidenceIdentity {
  target: 'initialized_binding'
  runId?: never
  nativeTurnId?: never
  executorId?: never
  cwd: string
  model: string | null
  effort: string | null
  observeNativeTitle?: NativeTitleObserver
  confirmedInitialization: {
    rebuildId: string
    sourceHash: string
    witness?: NativeInitializationWitness
  }
  source: AsyncIterable<NativeContextRebuildChunk>
  resolveImage?: (id: string, signal: AbortSignal) => Promise<AgentPromptImage>
}

export type AgentNativeProbeInput =
  | AgentNativeRunProbeInput
  | AgentNativeInitializedBindingProbeInput

export interface AgentNativeInputProbeInput extends AgentNativeRunProbeInput {
  /** At most 64 unresolved candidates; these are not the consumed native input history. */
  unresolvedInputIds: readonly string[]
  recordConsumption: (inputId: string) => void
}

export interface AgentNativeContextRebuildInput {
  rebuildId: string
  sessionId: string
  cwd: string
  model: string | null
  effort: string | null
  nativeSessionId?: string
  sourceHash?: string
  requestPermission?: NativePermissionRequester
  requestUserInput?: NativeUserInputRequester
  /** Utility resolves immutable Pact content; paths never enter public history chunks. */
  resolveImage?: (id: string, signal: AbortSignal) => Promise<AgentPromptImage>
  permissionMode?: SessionPermissionMode | undefined
  onNativeCreationDispatched?: (executorId: string) => Promise<void>
  onNativeSessionCreated?: (nativeSessionId: string) => Promise<void>
  reportNativeWork?: (report: {
    executorId: string
    nativeSessionId?: string
    state: 'unknown' | 'settled'
  }) => void
}

export interface AgentNativeContextRebuildResult {
  nativeSessionId: string
  initializationWitness?: NativeInitializationWitness
  acknowledgement?: string | undefined
}

export interface AgentTitleEnrichmentInput {
  runId: string
  sessionId: string
  nativeSessionId: string
  cwd: string
  observeNativeTitle?: NativeTitleObserver
}

export interface AgentNativeTitleInput {
  nativeSessionId: string
  cwd: string
  title: string
  /** Re-read the current Pact title, binding and Adapter ownership before dispatch. */
  isCurrent: () => boolean
}

export interface RunRecoveryPort {
  inputSha256: string
  expected?:
    | { settings: RunEffectiveExecutionSettings; executorId: string; nativeSessionId: string }
    | undefined
  recordEffectiveSettings: (
    settings: RunEffectiveExecutionSettings,
    identity: { executorId: string; nativeSessionId: string },
  ) => void
  recordConfirmedUnsent: (
    boundary: ConfirmedUnsentBoundary,
    identity: { executorId: string; nativeSessionId: string },
  ) => void
  /** Present only on an admitted replacement; checked at the real root delivery boundary. */
  canDispatch?: (() => boolean) | undefined
}

export interface RunLifecycleSink {
  recordExecutor?: ((executorId: string) => void) | undefined
  recordDispatch?:
    | ((
        phase: 'possibly_sent' | 'accepted' | 'rejected',
        nativeSessionId?: string,
        executorId?: string,
      ) => void)
    | undefined
  recordNativeEvidence?: ((evidence: NativeProbeResult) => void) | undefined
  recordInputConsumption?:
    | ((
        inputId: string,
        identity: Pick<NativeEvidenceIdentity, 'nativeSessionId' | 'nativeTurnId' | 'executorId'>,
      ) => void)
    | undefined
  recordOutputFailure?: ((error: Error) => void) | undefined
  waitForRootOutput?: (() => Promise<void>) | undefined
  observeNativeTitle?: NativeTitleObserver
  observeNativeDelta?: ((observation: NativeLoopDeltaObservation) => void) | undefined
}

export interface RunEffectsSink {
  recordArchivedEvent?: ((event: NormalizedAgentEvent) => void) | undefined
  recordBackgroundReport?: ((report: NativeBackgroundReport) => Promise<void>) | undefined
  recordBackgroundReportUnavailable?:
    | ((identity: NativeBackgroundReportIdentity) => void)
    | undefined
  anchorFileBeforeEdit?: ((path: string, signal: AbortSignal) => Promise<void>) | undefined
  recordFileChange?: ((change: NativeFileChange, signal: AbortSignal) => Promise<void>) | undefined
  recordUncertainEffects?:
    | ((reason: string, scope?: 'unlisted' | 'recorded_files') => void)
    | undefined
  backgroundWorkChanged?: (() => void) | undefined
  reportNativeEffects?:
    | ((report: {
        runId: string
        generation: string
        state: 'pending' | 'settled' | 'unknown'
        reason?: string
      }) => void)
    | undefined
}

export interface RunWorkflowSink {
  recordPlan?: ((plan: { nativeId: string; text: string }) => void) | undefined
  recordPlanUnavailable?: (() => void) | undefined
  recordOpenPlanFinalIntent?: ((intent: AgentOpenPlanFinalIntent) => boolean | void) | undefined
  recordPlanRetained?: ((plan: CollaborationRetainedPlan) => void) | undefined
  recordReview?: ((result: CollaborationReviewObservation) => void) | undefined
  recordInputResult?: ((result: CollaborationInputObservation) => void) | undefined
  sourceReader?: AgentCollaborationSourceReader | undefined
  getPlanCheckpoint?:
    | ((nativeSessionId: string) => ClaudePlanCheckpointSource | undefined)
    | undefined
}

export interface RunInteractionPort {
  requestPermission?: NativePermissionRequester
  requestUserInput?: NativeUserInputRequester
}

/**
 * Grouped host ports replacing the flat 35-callback bag on `AgentRunInput`.
 * Wave 3 wires `host` in `RunExecutor`; Wave 4 completes adapter cutover and removes
 * the legacy flat callback properties from `AgentRunInput`.
 */
export interface RunExecutionHost {
  readonly lifecycle: RunLifecycleSink
  readonly effects: RunEffectsSink
  readonly workflow: RunWorkflowSink
  readonly interactions: RunInteractionPort
  readonly recovery?: RunRecoveryPort | undefined
}

export interface AgentRunInput {
  /** Grouped host ports (target Wave 3/4 contract). */
  host?: RunExecutionHost | undefined

  /** Optional bounded observation; failures cannot affect native control or output. */
  observeNativeDelta?: (observation: NativeLoopDeltaObservation) => void
  /** Optional Relay evidence capture; it supplies no new business authority. */
  recovery?: RunRecoveryPort | undefined
  /** Bind the creating executor before any native startup callback; this is not model dispatch. */
  recordExecutor?: (executorId: string) => void
  /** An owned Native name fact; logicalTitle excludes Pact's derived display prefix. */
  observeNativeTitle?: NativeTitleObserver
  runId: string
  sessionId: string
  permissionMode?: SessionPermissionMode | undefined
  nativeSessionId?: string
  nativeGeneration?: string
  bindingGeneration?: number
  recordNativeEvidence?: (evidence: NativeProbeResult) => void
  /** Native user input incorporated into the original Turn's context, not fully handled. */
  recordInputConsumption?: (
    inputId: string,
    identity: Pick<NativeEvidenceIdentity, 'nativeSessionId' | 'nativeTurnId' | 'executorId'>,
  ) => void
  /** Output processing failed; native control and work observation remain owned. */
  recordOutputFailure?: (error: Error) => void
  /** Join already-delivered root output before its Query releases text workspace; never await native work settlement here. */
  waitForRootOutput?: () => Promise<void>
  /** Seal a provider-authored background update before reading more of this Query. */
  recordBackgroundReport?: (report: NativeBackgroundReport) => Promise<void>
  /** Retain an attributable report whose body cannot be materialized within the Query's working budget. */
  recordBackgroundReportUnavailable?: (identity: NativeBackgroundReportIdentity) => void
  recordArchivedEvent?: (event: NormalizedAgentEvent) => void
  /** Capture authenticated native metadata; Repository promotes only a normally completed root. */
  recordWorkflowPlan?: (plan: { nativeId: string; text: string }) => void
  recordWorkflowPlanUnavailable?: () => void
  /** Persist a bounded open-mode final publish_plan intent before acknowledging the tool call. */
  recordOpenPlanFinalIntent?: (intent: AgentOpenPlanFinalIntent) => boolean | void
  recordWorkflowPlanRetained?: (plan: CollaborationRetainedPlan) => void
  recordWorkflowReview?: (result: CollaborationReviewObservation) => void
  recordWorkflowInputResult?: (result: CollaborationInputObservation) => void
  /** Legacy callback removed in Wave 4 adapter cutover; new callers use `host.workflow.sourceReader`. */
  readCollaborationSourcePart?: ((input: unknown) => CollaborationSourceReadResult) | undefined
  /** Borrowed from the current NativeObservation; never included in frozen execution JSON. */
  collaborationSourceReader?: AgentCollaborationSourceReader | undefined
  getPlanCheckpoint?: (nativeSessionId: string) => ClaudePlanCheckpointSource | undefined
  recordDispatch?: (
    phase: 'possibly_sent' | 'accepted' | 'rejected',
    nativeSessionId?: string,
    executorId?: string,
  ) => void
  /** Conversation supplies this frozen route policy; legacy callers default to allowed. */
  peerAssistanceAllowed?: boolean
  /** Captures pre-touch baseline before a native file edit/delete mutates disk. */
  anchorFileBeforeEdit?: (path: string, signal: AbortSignal) => Promise<void>
  /** Observes applied native results; recording failure must never deny a native tool. */
  recordFileChange?: (change: NativeFileChange, signal: AbortSignal) => Promise<void>
  recordUncertainEffects?: (reason: string, scope?: 'unlisted' | 'recorded_files') => void
  /** Publish a changed live work projection without writing another durable effects receipt. */
  backgroundWorkChanged?: () => void
  /** Run/generation-bound native observation, independent of foreground completion. */
  reportNativeEffects?: (report: {
    runId: string
    generation: string
    state: 'pending' | 'settled' | 'unknown'
    reason?: string
  }) => void
  /** Called only when the native permission policy asks the user. */
  requestPermission?: NativePermissionRequester
  requestUserInput?: NativeUserInputRequester
  cwd: string
  promptEnvelope: AgentPromptEnvelope
  /** Same root's latest append-only input scope; frozen duty/settings remain unchanged. */
  currentPromptEnvelope?: () => AgentPromptEnvelope
  model: string | null
  effort: string | null
  speed?: AgentSpeed
}

export interface AgentOpenPlanFinalIntent {
  executionId?: string | undefined
  callKey: string
  progressToken?: string | undefined
  nativePlanId?: string | undefined
  candidateMarkdown: string
}

/** Native operation evidence, not a whole-working-tree diff or a proposed edit. */
export interface NativeFileChange {
  /** A failed/partial native attempt can invalidate prior evidence, not prove a new edit. */
  invalidateOnly?: true
  operationId?: string
  path: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  previousPath?: string
  /** Undefined means unavailable; null means a positively known absent file. */
  before?: string | null
  after?: string | null
  /** Complete single-file Git patch from the native result. */
  patch?: string
  mixed?: boolean
  unavailableReason?: string
}

/** An immutable Pact image resolved inside Utility, never a Renderer-supplied path. */
export interface AgentPromptImage extends ConversationImage {
  path: string
}

export function createUnavailableAgentAdapter(id: AgentId, reason: string): AgentAdapter {
  return {
    id,
    probe: async () => ({ id, available: false, reason }),
    probeNativeStatus: async ({ cwd: _cwd, model: _model, effort: _effort, ...identity }) => ({
      kind: 'no_evidence',
      identity,
      reason: 'Native runtime unavailable.',
    }),
    rebuildNativeContext: async () => {
      throw new Error(reason)
    },
    run: async function* () {
      yield* [] as NormalizedAgentEvent[]
      throw new Error(reason)
    },
    dispose: async () => undefined,
  }
}
