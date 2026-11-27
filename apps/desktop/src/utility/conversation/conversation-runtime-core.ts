import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { AgentAdapter, AgentPromptImage } from '@pact/agent-runtime'
import type {
  AgentRun,
  CollaborationDocument,
  ConversationGetInput,
  ConversationInputState,
  ConversationInputWrite,
  ConversationPage,
  ConversationPatch,
  ConversationStreamTrace,
  NativeLoopDeltaObservation,
  NativePresenceVersion,
  NormalizedAgentEvent,
  RpcResult,
  RuntimeAgentId,
  SessionNotificationEvent,
  WorkspaceChangeFilePreview,
  WorkspaceChangeFileReadInput,
  WorkspaceChangesPage,
  WorkspaceChangesReadInput,
  WorkspaceChangesUndoInput,
} from '@pact/contracts'
import type {
  ConversationImage,
  ImageReadInput,
  ImageReadPart,
  ImageWriteInput,
  ImageWriteState,
} from '@pact/contracts/images'
import type {
  ConversationRepository,
  ProjectCatalogRepository,
  SessionRepository,
} from '@pact/persistence'

import {
  agentDisplayName,
  buildBoundedNativePlanId,
  collaborationMarkdownPageSchema,
  CONVERSATION_PATCH_BYTES,
  conversationInterestsSchema,
  conversationPatchSchema,
  conversationStreamTraceSchema,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
  isAgentInPair,
  otherAgent,
  resolveActiveAgentPair,
  STREAM_TRACE_TTL_MS,
} from '@pact/contracts'
import {
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
  OversizedConversationEntityError,
  RunOperationConflictError,
  SideChatPersistenceError,
  StaleConversationCursorError,
  WorkspaceArchiveConflictError,
} from '@pact/persistence'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import type { ProjectFileReader } from '../project-file/project-file-reader'
import type { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import type { WorkspaceChanges } from '../workspace-changes/workspace-changes'
import type { AgentStreamBuffer } from './agent-stream-buffer'
import type { AgyAgentAdapterOptions, AgyCompletedPactPublishPlanCall } from './agy-agent-adapter'
import type { ConversationAdmissionGate } from './conversation-admission-gate'
import type { ConversationImages } from './conversation-images'
import type {
  ActiveExecution,
  ActiveNativeCheck,
  ActiveNativeFork,
  ActiveNativeRebuild,
  ActiveNativeTitleSync,
  ActiveTitleEnrichment,
  CachedAdapter,
  ConversationTerminalCoordinator,
  DecisionConnectionState,
  DecisionInvocationOwner,
  ForkPreparationEntry,
  NativeObservation,
  NativeQuitPreparationState,
  OwnedStreamTrace,
  PendingPermissionEntry,
  PreparedSession,
  PreparingContinuation,
  PreparingSend,
  SkillCatalogEntry,
  SkillDiscoveryEntry,
  SkillDocumentOwner,
} from './conversation-types'
import type { ArchiveAndQuitCoordinator } from './coordinators/archive-and-quit-coordinator'
import type { CollaborationAndHandoffCoordinator } from './coordinators/collaboration-and-handoff-coordinator'
import type { ForkCoordinator } from './coordinators/fork-coordinator'
import type { InteractionAndTitleCoordinator } from './coordinators/interaction-and-title-coordinator'
import type { NativeRecoveryCoordinator } from './coordinators/native-recovery-coordinator'
import type { RunExecutor } from './coordinators/run-executor'
import type { SchedulingDecisionCoordinator } from './coordinators/scheduling-decision-coordinator'
import type { SendAndSteerCoordinator } from './coordinators/send-and-steer-coordinator'
import type { SideChatCoordinator } from './coordinators/side-chat-coordinator'
import type { SkillsCoordinator } from './coordinators/skills-coordinator'

import { observeWorkerTraffic } from '../../shared/logical-ipc-traffic'
import { WorkspaceChangeError } from '../workspace-changes/workspace-changes'
import { AgentExecutionError } from './agent-execution-error'
import { AgyAcpConnectionPool } from './agy-acp-connection'
import { AgyAgentAdapter, buildAgyPactMcpServerName } from './agy-agent-adapter'
import {
  createAgyNativeStorageClient,
  resolveEffectiveAgyAppDataDir,
  stripCallKeyPrefix,
} from './agy/native-storage-client'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { CodexAgentAdapter } from './codex-agent-adapter'
import {
  AGY_PREPARATION_TIMEOUT_MS,
  CAPACITY_NOTICE,
  MAX_ADAPTER_SLOTS,
  PREPARATION_TIMEOUT_MS,
} from './conversation-types'
import { CrossAgentContextBroker, type CollectedHandoff } from './cross-agent-context-broker'
import { NativeForkFiles } from './native-fork-files'
import { NativeWorkingMemory } from './native-working-memory'
import { SessionNotificationProjector } from './session-notification-projector'

export interface ConversationCoordinatorRegistry {
  readonly gate: ConversationAdmissionGate
  readonly scheduling: SchedulingDecisionCoordinator
  readonly archiveAndQuit: ArchiveAndQuitCoordinator
  readonly fork: ForkCoordinator
  readonly interactions: InteractionAndTitleCoordinator
  readonly skills: SkillsCoordinator
  readonly recovery: NativeRecoveryCoordinator
  readonly sendAndSteer: SendAndSteerCoordinator
  readonly executor: RunExecutor
  readonly collaboration: CollaborationAndHandoffCoordinator
  readonly sideChats: SideChatCoordinator
  /** Invokes the public `Conversation.stop({ sessionId })` entry so test spies observe it. */
  readonly stopSession: (sessionId: string) => RpcResult<ConversationPatch>
}

/**
 * Single authoritative runtime state owner shared by all deep Conversation coordinators.
 *
 * Replaces the former 3 shallow `*Host` callback bags (`ConversationHandoffHost`,
 * `ConversationSideChatHost`, `ConversationCollaborationHost`) with direct typed
 * ownership of live operational maps, adapter/pool registries, stream traces,
 * markdown projection worker, and the serialized `publish()` pipeline.
 */
export class ConversationRuntimeCore {
  readonly nativeIncarnation = randomUUID()
  nativeRevision = 0
  nativeInitialization: Promise<void> | undefined
  readonly nativeListeners = new Set<(version: NativePresenceVersion) => void>()
  nativeQuitPreparation: NativeQuitPreparationState | undefined
  readonly archiveOwnerId = randomUUID()
  readonly archiveOperations = new Set<string>()
  readonly forkPreparations = new Map<string, ForkPreparationEntry>()
  readonly nativeForks = new Map<string, ActiveNativeFork>()
  readonly listeners = new Set<(patch: ConversationPatch, progress: boolean) => void>()
  readonly notificationProjector = new SessionNotificationProjector()
  readonly notificationListeners = new Set<(event: SessionNotificationEvent) => void>()
  interestedSessionIds = new Set<string>()
  readonly steerReceiptChecks = new Map<string, string>()
  lastSettledStreamTrace: OwnedStreamTrace | undefined
  suppressedProgress = 0
  publishedProgress = 0
  readonly activeExecutions = new Map<string, ActiveExecution>()
  readonly nativeRebuilds = new Map<string, ActiveNativeRebuild>()
  readonly preparingSends = new Map<string, PreparingSend>()
  readonly collaborationActions = new Map<
    string,
    { request: string; task: Promise<RpcResult<ConversationPatch>> }
  >()
  readonly preparingContinuations = new Map<string, PreparingContinuation>()
  readonly routingOpenInputs = new Map<string, AbortController>()
  readonly titleEnrichments = new Map<string, ActiveTitleEnrichment>()
  readonly nativeTitleSyncs = new Map<string, ActiveNativeTitleSync>()
  readonly skillCatalogs = new Map<string, SkillCatalogEntry>()
  readonly skillDiscoveries = new Map<string, SkillDiscoveryEntry>()
  readonly adapters = new Map<string, CachedAdapter>()
  skillDocumentOwner: SkillDocumentOwner | undefined
  readonly nativeObservations = new Map<string, NativeObservation>()
  readonly unrecordedArchiveFailures = new Map<string, { sessionId: string; error: unknown }>()
  readonly nativeChecks = new Map<string, ActiveNativeCheck>()
  adapterSlotTail: Promise<void> = Promise.resolve()
  pendingContinuationScheduled = false
  pendingContinuationWakeAgain = false
  pendingContinuationImmediate: NodeJS.Immediate | undefined
  workflowCandidateCursor: { updatedAt: string; id: string } | undefined
  workflowCandidateRescan = false
  readonly markdownPreparations = new Map<
    string,
    { id: string; deadline: number; task: Promise<void> }
  >()
  markdownTail: Promise<void> = Promise.resolve()
  markdownWorker: Worker | undefined
  disposed = false
  readonly permissions = new Map<string, PendingPermissionEntry>()
  disposal: Promise<void> | undefined
  baseShutdownDone = false
  shutdownDeadlineAt: number | undefined
  permanentShutdownFailure: Error | undefined
  decisionRuntime: DecisionInvocationOwner | undefined
  decisionRecovery: Promise<void> | undefined
  decisionRecoveryOwner: { operationId: string; sessionId: string | null } | undefined
  readonly utilityEpoch = randomUUID()
  decisionConnection: DecisionConnectionState | undefined
  schedulingListener: (() => void) | undefined
  readonly agyConnectionPools = new Map<string, AgyAcpConnectionPool>()
  readonly retiringAgyPools = new Set<AgyAcpConnectionPool>()
  agyForkFiles: NativeForkFiles | undefined
  readonly contextBroker: CrossAgentContextBroker

  gate!: ConversationAdmissionGate
  scheduling!: SchedulingDecisionCoordinator
  archiveAndQuit!: ArchiveAndQuitCoordinator
  fork!: ForkCoordinator
  interactions!: InteractionAndTitleCoordinator
  skills!: SkillsCoordinator
  recovery!: NativeRecoveryCoordinator
  sendAndSteer!: SendAndSteerCoordinator
  executor!: RunExecutor
  collaboration!: CollaborationAndHandoffCoordinator
  sideChats!: SideChatCoordinator
  stopSession!: (sessionId: string) => RpcResult<ConversationPatch>

  constructor(
    readonly conversations: ConversationRepository,
    readonly sessions: SessionRepository,
    readonly projects: ProjectCatalogRepository,
    readonly runtimePreparation: RuntimePreparation,
    readonly projectFiles: ProjectFileReader,
    readonly workspaceChanges?: WorkspaceChanges,
    readonly images?: ConversationImages,
    readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    readonly loadDecisionCredential?: (context: {
      signal: AbortSignal
      deadlineAt: number
    }) => Promise<string | null> | string | null,
    readonly terminalCoordinator?: ConversationTerminalCoordinator,
  ) {
    this.contextBroker = new CrossAgentContextBroker({
      conversations,
      workspaceChanges,
      images,
    })
  }

  bindCoordinators(registry: ConversationCoordinatorRegistry): void {
    this.gate = registry.gate
    this.scheduling = registry.scheduling
    this.archiveAndQuit = registry.archiveAndQuit
    this.fork = registry.fork
    this.interactions = registry.interactions
    this.skills = registry.skills
    this.recovery = registry.recovery
    this.sendAndSteer = registry.sendAndSteer
    this.executor = registry.executor
    this.collaboration = registry.collaboration
    this.sideChats = registry.sideChats
    this.stopSession = registry.stopSession
  }

  adapterOwnsExecutor(adapter: AgentAdapter, expectedExecutorId: string): boolean {
    const fn: unknown = Reflect.get(adapter, 'hasExecutor')
    if (typeof fn === 'function') {
      return Boolean(fn.call(adapter, expectedExecutorId))
    }
    return adapter.executorId === expectedExecutorId
  }

  shuttingDown(): RpcResult<never> {
    return { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' } }
  }

  quitPrepared(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Pact is preparing to exit. Cancel exit to continue working.',
      },
    }
  }

  archiveBusy(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'This project or session is being archived. Wait or cancel archive first.',
      },
    }
  }

  nativeRecoveryRequired(): RpcResult<never> {
    return {
      ok: false,
      error: {
        code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED',
        message: 'Rebuild the missing Native Session before continuing.',
      },
    }
  }

  capacityFailure(): RpcResult<never> {
    return { ok: false, error: { code: 'AGENT_CAPACITY', message: CAPACITY_NOTICE } }
  }

  sendFailure(error: unknown): RpcResult<never> {
    return {
      ok: false,
      error: {
        code:
          error instanceof WorkspaceChangeError
            ? error.code
            : error instanceof RunOperationConflictError ||
                error instanceof SideChatPersistenceError ||
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

  isConflict(error: unknown): boolean {
    return error instanceof RunOperationConflictError
  }

  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  async markdownVisibleProjection(markdown: string): Promise<string> {
    const projection = await import('../../shared/message-anchor-text.js')
    return projection.markdownVisibleProjection(markdown)
  }

  delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

  localTitle(content: string, fallback = 'New session'): string {
    const plain = content
      .replace(/```[\s\S]*?```/gu, ' ')
      .replace(/[`*_>#()[\]]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (!plain) return fallback
    let title = ''
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      plain,
    )) {
      if (title.length + segment.length > 120) break
      title += segment
    }
    return title.trimEnd() || fallback
  }

  async reconcileSessionSettingsChanged(sessionId: string): Promise<void> {
    if (this.disposed) return
    const session = this.sessions.find(sessionId)
    const project = session ? this.projects.find(session.projectId) : undefined
    const parentSession = session?.parentSessionId
      ? this.sessions.find(session.parentSessionId)
      : undefined
    const isArchived = Boolean(
      !session ||
      session.status === 'archived' ||
      session.archivedAt ||
      parentSession?.status === 'archived' ||
      parentSession?.archivedAt ||
      project?.archivedAt,
    )
    const activePair = session ? resolveActiveAgentPair(session.settings) : undefined
    const agyInPair = Boolean(!isArchived && activePair && isAgentInPair('agy', activePair))
    const agyFullAccess = agyInPair && (session?.settings.permissionModes?.agy ?? 'ask') === 'full'
    if (agyFullAccess) return

    const retireTasks: Promise<void>[] = []
    const cached = this.adapters.get(`${sessionId}:agy`)
    if (cached?.retireFullAccess) {
      retireTasks.push(cached.retireFullAccess({ cwd: cached.cwd, sessionId }))
    }
    for (const pool of this.agyConnectionPools.values()) {
      retireTasks.push(
        pool.retireFullAccess({
          ...(project ? { cwd: project.directoryPath } : {}),
          sessionId,
        }),
      )
    }
    if (retireTasks.length) {
      await Promise.all(retireTasks)
    }
  }

  collectHandoff(
    sessionId: string,
    targetAgentId: RuntimeAgentId,
    signal: AbortSignal,
    excludeMessageId?: string,
    throughSequence?: number,
    workflow = false,
  ): Promise<CollectedHandoff> {
    return this.contextBroker.collectHandoff({
      sessionId,
      targetAgentId,
      signal,
      excludeMessageId,
      throughSequence,
      workflow,
    })
  }

  sessionPreparationTimeoutMs(
    sessionId: string,
    extraAgents: readonly RuntimeAgentId[] = [],
  ): number {
    if (extraAgents.includes('agy')) return AGY_PREPARATION_TIMEOUT_MS
    const session = this.sessions.find(sessionId)
    if (session && resolveActiveAgentPair(session.settings).includes('agy')) {
      return AGY_PREPARATION_TIMEOUT_MS
    }
    return PREPARATION_TIMEOUT_MS
  }

  async prepareSession(
    sessionId: string,
    signal?: AbortSignal,
    extraRequiredAgents: readonly RuntimeAgentId[] = [],
  ): Promise<RpcResult<PreparedSession>> {
    if (this.gate.nativeQuitSealed()) return this.quitPrepared()
    if (this.conversations.archives.blocksSession(sessionId)) return this.archiveBusy()
    const session = this.sessions.find(sessionId)
    if (!session || session.status === 'archived') {
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    }
    const project = this.projects.find(session.projectId)
    if (!project || project.archivedAt) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project is unavailable.' } }
    }
    const requiredAgents = new Set<RuntimeAgentId>([
      ...resolveActiveAgentPair(session.settings),
      ...extraRequiredAgents,
    ])
    const readiness = await this.runtimePreparation.inspectReadiness(signal, [...requiredAgents])
    if (!readiness.ok) return readiness
    if (this.conversations.archives.blocksSession(sessionId)) return this.archiveBusy()
    const discoveredPaths: Partial<Record<RuntimeAgentId, string>> = {}
    for (const agent of readiness.value.agents) {
      if (agent.state === 'ready' && agent.executablePath) {
        discoveredPaths[agent.agentId] = agent.executablePath
      }
    }
    for (const requiredAgent of requiredAgents) {
      if (!discoveredPaths[requiredAgent]) {
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both Agents must be ready.' },
        }
      }
    }
    const executablePaths: Record<RuntimeAgentId, string> = {
      claude: discoveredPaths.claude ?? '',
      codex: discoveredPaths.codex ?? '',
      agy: discoveredPaths.agy ?? '',
    }
    return {
      ok: true,
      value: { session, projectDirectory: project.directoryPath, executablePaths },
    }
  }

  async adapterFor(
    sessionId: string,
    agentId: RuntimeAgentId,
    executablePath: string,
    signal?: AbortSignal,
    cwd?: string,
    onAcquired?: (adapter: AgentAdapter) => void,
  ): Promise<AgentAdapter> {
    const previous = this.adapterSlotTail
    const gate = Promise.withResolvers<void>()
    this.adapterSlotTail = gate.promise
    await previous
    try {
      if (this.disposed || signal?.aborted) {
        throw new Error('Pact is shutting down or recovery was cancelled.')
      }
      if (this.gate.nativeQuitSealed()) {
        throw new RunOperationConflictError('Pact is preparing to exit.')
      }
      if (!cwd) throw new Error('The Agent Adapter requires a confirmed project directory.')
      if (!executablePath) {
        throw new RunOperationConflictError(`${agentDisplayName(agentId)} is not ready.`)
      }
      const resolvePeerTarget = (targetSessionId: string): RuntimeAgentId | undefined => {
        const currentSession = this.sessions.find(targetSessionId)
        if (!currentSession) return undefined
        const pair = resolveActiveAgentPair(currentSession.settings)
        return isAgentInPair(agentId, pair) ? otherAgent(agentId, pair) : undefined
      }
      const peerCandidate = agentId === 'agy' ? resolvePeerTarget(sessionId) : undefined
      const expectedAgyPeer: Exclude<RuntimeAgentId, 'agy'> | undefined =
        agentId === 'agy'
          ? peerCandidate && peerCandidate !== 'agy'
            ? peerCandidate
            : 'codex'
          : undefined
      const agyAppDataDir = agentId === 'agy' ? resolveEffectiveAgyAppDataDir() : undefined
      const key = `${sessionId}:${agentId}`
      const cached = this.adapters.get(key)
      if (
        cached?.executablePath === executablePath &&
        cached.cwd === cwd &&
        (agentId !== 'agy' ||
          (cached.peerTargetAgentId === expectedAgyPeer &&
            cached.appDataDir === agyAppDataDir &&
            cached.connectionPool !== undefined &&
            cached.poolKey !== undefined &&
            !this.retiringAgyPools.has(cached.connectionPool) &&
            this.agyConnectionPools.get(cached.poolKey) === cached.connectionPool))
      ) {
        this.adapters.delete(key)
        this.adapters.set(key, cached)
        onAcquired?.(cached.adapter)
        return cached.adapter
      }
      const isCachedAdapterIdleEligible = (candidate: CachedAdapter): boolean =>
        !candidate.adapter.hasActiveBackgroundWork?.() &&
        [...this.nativeChecks.values()].every((owner) => owner.adapter !== candidate.adapter) &&
        [...this.skillDiscoveries.values()].every(
          (owner) => owner.sessionId !== candidate.sessionId || owner.agentId !== candidate.agentId,
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
        )
      const disposeIdleCachedAdapter = async (
        targetKey: string,
        candidate: CachedAdapter,
        retireSessionLease = false,
      ): Promise<void> => {
        const title = this.titleEnrichments.get(candidate.sessionId)
        if (title?.agentId === candidate.agentId) {
          this.interactions.cancelTitleEnrichment(candidate.sessionId)
          await title.promise
        }
        if (candidate.agentId === 'codex') {
          await this.interactions.cancelNativeTitleSync(candidate.sessionId)
        }
        await Promise.all([
          candidate.adapter.dispose(),
          retireSessionLease && candidate.retireFullAccess
            ? candidate.retireFullAccess({ cwd: candidate.cwd, sessionId: candidate.sessionId })
            : Promise.resolve(),
          candidate.disposeExtra ? candidate.disposeExtra() : Promise.resolve(),
        ])
        this.adapters.delete(targetKey)
      }
      if (cached) {
        if ([...this.nativeChecks.values()].some((owner) => owner.adapter === cached.adapter)) {
          throw new RunOperationConflictError(
            'The previous native check is still using this Adapter. Its configuration was not replaced.',
          )
        }
        if (cached.adapter.hasActiveBackgroundWork?.()) {
          throw new RunOperationConflictError(
            'The previous native runtime still has background work. Its configuration will not be replaced while it is running.',
          )
        }
        await disposeIdleCachedAdapter(key, cached)
      }
      const acquiringParentId = this.sessions.find(sessionId)?.parentSessionId
      const evictionPriority = (candidateSessionId: string): number => {
        const isSideChat = Boolean(this.sessions.find(candidateSessionId)?.parentSessionId)
        const isProtected =
          this.interestedSessionIds.has(candidateSessionId) ||
          candidateSessionId === sessionId ||
          (!isSideChat && candidateSessionId === acquiringParentId)
        if (isSideChat && !isProtected) return 0
        if (!isSideChat && !isProtected) return 1
        if (isSideChat) return 2
        return 3
      }
      while (this.adapters.size >= MAX_ADAPTER_SLOTS) {
        let idle: [string, CachedAdapter] | undefined
        let idleScore = Number.POSITIVE_INFINITY
        for (const entry of this.adapters) {
          const [, candidate] = entry
          if (!isCachedAdapterIdleEligible(candidate)) continue
          const score = evictionPriority(candidate.sessionId)
          if (score < idleScore) {
            idle = entry
            idleScore = score
            if (score === 0) break
          }
        }
        if (!idle) throw new Error('No idle Agent Adapter slot is available.')
        const [idleKey, candidate] = idle
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reclaim each slot completely before admitting its replacement.
        await disposeIdleCachedAdapter(idleKey, candidate, true)
      }
      if (this.disposed || signal?.aborted) {
        throw new Error('Pact is shutting down or recovery was cancelled.')
      }
      let adapter: AgentAdapter
      let retireFullAccess:
        | ((options?: { cwd?: string; sessionId?: string }) => Promise<void>)
        | undefined
      let assignedPoolKey: string | undefined
      let assignedPool: AgyAcpConnectionPool | undefined
      if (agentId === 'claude') {
        adapter = new ClaudeAgentAdapter(
          executablePath,
          undefined,
          this.ipcTraffic,
          resolvePeerTarget,
        )
      } else if (agentId === 'codex') {
        adapter = new CodexAgentAdapter(
          executablePath,
          undefined,
          {},
          this.ipcTraffic,
          resolvePeerTarget,
        )
      } else {
        const resolvedAppDataDir = agyAppDataDir ?? resolveEffectiveAgyAppDataDir()
        const poolKey = JSON.stringify([executablePath, resolvedAppDataDir])
        let connectionPool = this.agyConnectionPools.get(poolKey)
        if (connectionPool && this.retiringAgyPools.has(connectionPool)) {
          await connectionPool.dispose().catch(() => undefined)
          if (connectionPool.occupiedProcessSlotCount === 0) {
            if (this.agyConnectionPools.get(poolKey) === connectionPool) {
              this.agyConnectionPools.delete(poolKey)
            }
            this.retiringAgyPools.delete(connectionPool)
            connectionPool = undefined
          } else {
            throw new Error('Antigravity connection pool for this configuration is still retiring.')
          }
        }
        if (connectionPool) {
          this.agyConnectionPools.delete(poolKey)
          this.agyConnectionPools.set(poolKey, connectionPool)
        } else {
          if (this.agyConnectionPools.size >= 8) {
            const evictionDeadlineAt = Date.now() + 3_000
            let evictedPool = false
            const tryEvictCandidatePool = async (
              candidatePoolKey: string,
              candidatePool: AgyAcpConnectionPool,
              referencingEntries: ReadonlyArray<[string, CachedAdapter]>,
            ): Promise<boolean> => {
              if (this.retiringAgyPools.has(candidatePool)) {
                if (candidatePool.activeLeaseCount > 0) {
                  return false
                }
                await candidatePool.dispose(evictionDeadlineAt)
                if (candidatePool.occupiedProcessSlotCount === 0) {
                  if (this.agyConnectionPools.get(candidatePoolKey) === candidatePool) {
                    this.agyConnectionPools.delete(candidatePoolKey)
                  }
                  this.retiringAgyPools.delete(candidatePool)
                  return true
                }
                return false
              }
              const retirement = candidatePool.tryRetireIdle(evictionDeadlineAt)
              if (retirement.kind === 'busy') {
                return false
              }
              this.retiringAgyPools.add(candidatePool)
              void retirement.physical.then(
                () => {
                  if (
                    this.agyConnectionPools.get(candidatePoolKey) === candidatePool &&
                    candidatePool.occupiedProcessSlotCount === 0
                  ) {
                    this.agyConnectionPools.delete(candidatePoolKey)
                    this.retiringAgyPools.delete(candidatePool)
                  }
                  return undefined
                },
                () => undefined,
              )
              for (const [refKey, refEntry] of referencingEntries) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- Detach idle cached adapters bound to this retiring pool.
                await disposeIdleCachedAdapter(refKey, refEntry, false)
              }
              await retirement.physical
              if (candidatePool.occupiedProcessSlotCount === 0) {
                if (this.agyConnectionPools.get(candidatePoolKey) === candidatePool) {
                  this.agyConnectionPools.delete(candidatePoolKey)
                }
                this.retiringAgyPools.delete(candidatePool)
                return true
              }
              return false
            }
            for (const [candidatePoolKey, candidatePool] of Array.from(this.agyConnectionPools)) {
              const referencingEntries = [...this.adapters.entries()].filter(
                ([, entry]) => entry.connectionPool === candidatePool,
              )
              if (referencingEntries.length === 0) {
                // oxlint-disable-next-line no-await-in-loop -- Wait for unreferenced pool retirement before allocating replacement.
                if (await tryEvictCandidatePool(candidatePoolKey, candidatePool, [])) {
                  evictedPool = true
                  break
                }
              }
            }
            if (!evictedPool) {
              for (const [candidatePoolKey, candidatePool] of Array.from(this.agyConnectionPools)) {
                const referencingEntries = [...this.adapters.entries()].filter(
                  ([, entry]) => entry.connectionPool === candidatePool,
                )
                if (referencingEntries.every(([, entry]) => isCachedAdapterIdleEligible(entry))) {
                  // oxlint-disable-next-line no-await-in-loop -- Retire idle pool atomically and confirm physical release before replacing slot.
                  const evicted = await tryEvictCandidatePool(
                    candidatePoolKey,
                    candidatePool,
                    referencingEntries,
                  )
                  if (evicted) {
                    evictedPool = true
                    break
                  }
                }
              }
            }
            if (!evictedPool) {
              throw new Error('No idle Antigravity connection pool slot is available.')
            }
          }
          connectionPool = new AgyAcpConnectionPool({
            executablePath,
            ...(this.ipcTraffic ? { ipcTraffic: this.ipcTraffic } : {}),
          })
          this.agyConnectionPools.set(poolKey, connectionPool)
        }
        assignedPoolKey = poolKey
        assignedPool = connectionPool
        this.agyForkFiles ??= new NativeForkFiles(this.ipcTraffic)
        const sharedForkFiles = this.agyForkFiles
        const agyOptions: AgyAgentAdapterOptions = {
          executablePath,
          appDataDir: resolvedAppDataDir,
          connectionPool,
          ...(this.ipcTraffic ? { ipcTraffic: this.ipcTraffic } : {}),
          ...(expectedAgyPeer ? { peerTargetAgentId: expectedAgyPeer } : {}),
          storageClient: createAgyNativeStorageClient(
            sharedForkFiles,
            resolvedAppDataDir,
            (targetRunId, terminalState, nativeSessionId) =>
              this.resolveColdOpenPlanIntent(targetRunId, terminalState, nativeSessionId),
          ),
          subscribeStoragePhysicalOperations: (observer) =>
            sharedForkFiles.addPhysicalOperationObserver(observer),
        }
        const agyAdapter = new AgyAgentAdapter(agyOptions)
        retireFullAccess = (opts) => agyAdapter.retireFullAccess(opts)
        adapter = agyAdapter
      }
      this.adapters.set(key, {
        sessionId,
        agentId,
        executablePath,
        cwd,
        adapter,
        ...(agyAppDataDir ? { appDataDir: agyAppDataDir } : {}),
        ...(expectedAgyPeer ? { peerTargetAgentId: expectedAgyPeer } : {}),
        ...(assignedPoolKey ? { poolKey: assignedPoolKey } : {}),
        ...(assignedPool ? { connectionPool: assignedPool } : {}),
        ...(retireFullAccess ? { retireFullAccess } : {}),
      })
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

  resolveColdOpenPlanIntent(
    runId: string,
    terminalState: {
      executionId: string
      status: 'completed' | 'failed' | 'canceled' | 'running'
      hasCompletedPactPublishPlan?: boolean | undefined
      completedPactPublishPlanCalls?: readonly AgyCompletedPactPublishPlanCall[] | undefined
      completedPactPublishPlanTokens?: readonly string[] | undefined
    },
    nativeSessionId?: string,
  ): { plan: { nativeId: string; text: string } } | { planUnavailable: true } | undefined {
    if (terminalState.status !== 'completed') return undefined
    const intents = this.conversations.workflowOpenPlanPublishIntents(runId)
    if (intents.length === 0) return undefined
    if (terminalState.hasCompletedPactPublishPlan !== true) {
      return { planUnavailable: true }
    }
    const eligibleIntents = intents.filter(
      (intent) =>
        intent.executionId === undefined ||
        !terminalState.executionId ||
        intent.executionId === terminalState.executionId,
    )
    if (eligibleIntents.length === 0) {
      return { planUnavailable: true }
    }
    const effectiveNativeSessionId =
      nativeSessionId ?? this.conversations.findRun(runId)?.nativeSessionId ?? runId

    if (terminalState.completedPactPublishPlanCalls !== undefined) {
      const expectedServerName = buildAgyPactMcpServerName(runId)
      const serverCalls = terminalState.completedPactPublishPlanCalls.filter(
        (call) => call.serverName.trim() === expectedServerName,
      )
      if (serverCalls.length === 0) {
        return { planUnavailable: true }
      }
      const latestCall = serverCalls[serverCalls.length - 1]!
      const rawCallId = latestCall.callId?.trim() || undefined
      const rawProgressToken = latestCall.progressToken?.trim() || undefined
      if (!rawCallId && !rawProgressToken) {
        return { planUnavailable: true }
      }
      const callIdKeys = new Set<string>()
      let normalizedCallIdForNativeId: string | undefined
      if (rawCallId) {
        const bareRawCallId = rawCallId.startsWith('call:')
          ? rawCallId.slice('call:'.length)
          : rawCallId
        normalizedCallIdForNativeId = bareRawCallId
        if (rawCallId.startsWith('call:')) {
          callIdKeys.add(rawCallId)
          callIdKeys.add(encodeBoundedOpenPlanCallKey(rawCallId))
          callIdKeys.add(bareRawCallId)
        } else {
          callIdKeys.add(rawCallId)
          callIdKeys.add(`call:${rawCallId}`)
          callIdKeys.add(encodeBoundedOpenPlanCallKey(`call:${rawCallId}`))
        }
      }
      const progressTokenKeys = new Set<string>()
      const provisionalTokenCallKeys = new Set<string>()
      if (rawProgressToken) {
        progressTokenKeys.add(rawProgressToken)
        progressTokenKeys.add(encodeBoundedOpenPlanProgressToken(rawProgressToken))
        provisionalTokenCallKeys.add(`token:${rawProgressToken}`)
        provisionalTokenCallKeys.add(encodeBoundedOpenPlanCallKey(`token:${rawProgressToken}`))
      }
      const matchedIntents = eligibleIntents.filter((intent) => {
        if (
          intent.progressToken !== undefined &&
          rawProgressToken !== undefined &&
          !progressTokenKeys.has(intent.progressToken)
        ) {
          return false
        }
        if (intent.callKey.startsWith('call:')) {
          if (rawCallId !== undefined) {
            return callIdKeys.has(intent.callKey)
          }
          return intent.progressToken !== undefined && progressTokenKeys.has(intent.progressToken)
        }
        if (intent.callKey.startsWith('token:')) {
          return (
            (intent.progressToken !== undefined && progressTokenKeys.has(intent.progressToken)) ||
            provisionalTokenCallKeys.has(intent.callKey)
          )
        }
        if (rawCallId !== undefined) {
          return callIdKeys.has(intent.callKey)
        }
        return intent.progressToken !== undefined && progressTokenKeys.has(intent.progressToken)
      })
      if (matchedIntents.length !== 1) {
        return { planUnavailable: true }
      }
      const matchedIntent = matchedIntents[0]!
      const text = this.conversations.readOpenPlanPublishIntentText(runId, matchedIntent.callKey)
      if (!text || text.trim().length === 0) {
        return { planUnavailable: true }
      }
      const bareCallKey = stripCallKeyPrefix(matchedIntent.callKey)
      const nativeId =
        matchedIntent.nativePlanId ??
        buildBoundedNativePlanId(
          effectiveNativeSessionId,
          matchedIntent.callKey.startsWith('call:')
            ? bareCallKey
            : (normalizedCallIdForNativeId ?? bareCallKey),
        )
      return { plan: { nativeId, text } }
    }

    const rawCompletedTokens = (terminalState.completedPactPublishPlanTokens ?? [])
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
    if (rawCompletedTokens.length === 0) {
      return { planUnavailable: true }
    }
    const completedTokens = new Set<string>()
    for (const raw of rawCompletedTokens) {
      completedTokens.add(raw)
      completedTokens.add(encodeBoundedOpenPlanProgressToken(raw))
      completedTokens.add(encodeBoundedOpenPlanCallKey(`call:${raw}`))
      completedTokens.add(encodeBoundedOpenPlanCallKey(`token:${raw}`))
    }
    const matchedIntents = eligibleIntents.filter((intent) => {
      const bareCallKey = stripCallKeyPrefix(intent.callKey)
      const callKeyMatches = completedTokens.has(intent.callKey) || completedTokens.has(bareCallKey)
      const progressTokenMatches =
        intent.progressToken !== undefined && completedTokens.has(intent.progressToken)
      return callKeyMatches || progressTokenMatches
    })
    if (matchedIntents.length !== 1) {
      return { planUnavailable: true }
    }
    const matchedIntent = matchedIntents[0]!
    const text = this.conversations.readOpenPlanPublishIntentText(runId, matchedIntent.callKey)
    if (!text || text.trim().length === 0) {
      return { planUnavailable: true }
    }
    const bareCallKey = stripCallKeyPrefix(matchedIntent.callKey)
    const nativeId =
      matchedIntent.nativePlanId ?? buildBoundedNativePlanId(effectiveNativeSessionId, bareCallKey)
    return { plan: { nativeId, text } }
  }

  async prepareMarkdown(
    sessionId: string,
    runId: string,
    source: CollaborationDocument,
  ): Promise<void> {
    const row = this.conversations.collaborationDocumentRow(sessionId, source)
    if (row.sourceRunId !== runId) throw new Error('The source Run changed.')
    if (row.projectionPages !== null || row.projectionBasis === 'plain-visible-v1') return
    const existing = this.markdownPreparations.get(source.id)
    if (existing) return existing.task
    if (this.disposed || this.markdownPreparations.size >= 32) {
      throw new Error('Document processing is busy. Try reading again.')
    }
    const expires = Date.now() + 30_000
    const previous = this.markdownTail
    let timedOut = false
    const task = (async () => {
      await previous
      if (this.disposed || Date.now() >= expires) {
        throw new Error('Document preparation timed out. Original content is preserved.')
      }
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
          if (part.scope !== 'collaboration-text' || !part.text.length) {
            throw new Error('The document source has a missing segment.')
          }
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
      } else {
        throw error
      }
    })
    const preparation = { id: randomUUID(), deadline: expires, task }
    this.markdownPreparations.set(source.id, preparation)
    this.markdownTail = task.catch(() => undefined)
    let status: 'ready' | 'failed' = 'failed'
    try {
      await task
      status = 'ready'
    } finally {
      if (this.markdownPreparations.get(source.id) === preparation) {
        this.markdownPreparations.delete(source.id)
      }
      if (!this.disposed) {
        const metadata = this.conversations.metadataPatch(sessionId)
        const patch = conversationPatchSchema.parse({
          version: metadata.version,
          sessionId,
          observation: metadata.observation,
          session: metadata.session,
          messages: [],
          runs: [],
          activities: [],
          activityStates: [],
          documentProjection: {
            runId,
            document: source,
            preparationId: preparation.id,
            status,
            ...(status === 'failed'
              ? { message: 'The plan could not be prepared. Try again.' }
              : {}),
          },
        })
        for (const listener of this.listeners) {
          try {
            listener(patch, false)
          } catch {
            // Notification delivery cannot invalidate durable pages.
          }
        }
      }
    }
  }

  async load(input: ConversationGetInput): Promise<RpcResult<ConversationPage>> {
    const session = this.sessions.find(input.sessionId)
    if (!session || session.status === 'archived') {
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    }
    try {
      if (input.scope === 'collaboration') {
        await this.sendAndSteer.awaitSettlingExecution(input.sessionId, input.runId)
        if (this.disposed) return this.shuttingDown()
        const currentSession = this.sessions.find(input.sessionId)
        if (!currentSession || currentSession.status === 'archived') {
          return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
        }
      }
      if (input.scope === 'collaboration-markdown' && input.basis !== 'plain-visible-v1') {
        const row = this.conversations.collaborationDocumentRow(input.sessionId, input.document)
        if (row.sourceRunId !== input.runId) throw new Error('The source Run changed.')
        if (row.projectionPages === null && row.projectionBasis !== 'plain-visible-v1') {
          if (!input.preparationId) {
            void this.prepareMarkdown(input.sessionId, input.runId, input.document).catch(
              () => undefined,
            )
          }
          const preparation = this.markdownPreparations.get(input.document.id)
          if (!preparation || (input.preparationId && preparation.id !== input.preparationId)) {
            throw new Error('Document preparation is unavailable. Try again.')
          }
          return {
            ok: true,
            value: {
              scope: 'collaboration-markdown-pending',
              sessionId: input.sessionId,
              runId: input.runId,
              document: input.document,
              preparationId: preparation.id,
              deadline: preparation.deadline,
            },
          }
        }
      }
      const page = this.conversations.readPage(input)
      if (page.scope === 'messages') {
        page.header.pendingNativeInteractions = this.interactions.pendingNativeInteractions(
          input.sessionId,
        )
        page.header.forkBlocked = this.gate.forkBlocked(input.sessionId)
        page.header.sessionIssues = this.gate.sessionIssues(
          input.sessionId,
          page.header.nativeContexts ?? [],
        )
        page.header.relaySchedulingDecision = this.scheduling.projectRelaySchedulingDecision(
          input.sessionId,
          page.header.sessionIssues,
        )
        if (input.scope === 'messages') {
          this.recovery.scheduleSteerReceiptCheck(page, input)
        }
        page.header.preparedInputContinuation = this.conversations.preparedInputContinuation(
          input.sessionId,
        )
      }
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

  async writeImage(input: ImageWriteInput, owner: string): Promise<RpcResult<ImageWriteState>> {
    try {
      if (this.disposed || !this.images) throw new Error('Image input is unavailable.')
      return { ok: true, value: await this.images.write(input, owner) }
    } catch (error) {
      return this.sendFailure(error)
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
      return this.sendFailure(error)
    }
  }

  async readImage(input: ImageReadInput, owner: string): Promise<RpcResult<ImageReadPart>> {
    try {
      if (this.disposed || !this.images) throw new Error('Image input is unavailable.')
      return { ok: true, value: await this.images.read(input, owner) }
    } catch (error) {
      return this.sendFailure(error)
    }
  }

  async resolveRebuildImage(session: string, id: string): Promise<AgentPromptImage> {
    const image = this.conversations.resolveMessageImages(session, [id])[0]
    if (!image || !this.images) throw new Error('The saved image source is unavailable.')
    return this.images.resolve(session, image)
  }

  writeInput(input: ConversationInputWrite, ownerKey: string): RpcResult<ConversationInputState> {
    if (this.disposed) return this.shuttingDown()
    try {
      return { ok: true, value: this.conversations.writeConversationInput(input, ownerKey) }
    } catch (error) {
      return this.sendFailure(error)
    }
  }

  releaseInputOwner(ownerKey: string): void {
    this.conversations.releaseConversationInputs(ownerKey)
    void this.images?.releaseOwner(ownerKey).catch(() => undefined)
  }

  readWorkspaceChanges(input: WorkspaceChangesReadInput): RpcResult<WorkspaceChangesPage> {
    try {
      if (!this.workspaceChanges) throw new Error('Protected file changes are unavailable.')
      return { ok: true, value: this.workspaceChanges.readPage(input) }
    } catch (error) {
      return this.sendFailure(error)
    }
  }

  async readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>> {
    try {
      if (!this.workspaceChanges) throw new Error('Protected file changes are unavailable.')
      return { ok: true, value: await this.workspaceChanges.readFile(input) }
    } catch (error) {
      return this.sendFailure(error)
    }
  }

  async undoWorkspaceChanges(
    input: WorkspaceChangesUndoInput,
  ): Promise<RpcResult<ConversationPatch>> {
    if (this.gate.nativeQuitSealed()) return this.quitPrepared()
    try {
      if (!this.workspaceChanges || this.disposed) {
        throw new Error('Protected Undo is unavailable.')
      }
      const targetPathValue: unknown = Reflect.get(input, 'path')
      const targetPath = typeof targetPathValue === 'string' ? targetPathValue : undefined
      const undoTarget: {
        undo(
          id: string,
          projectBusy?: (projectId: string) => boolean,
          path?: string,
        ): ReturnType<WorkspaceChanges['undo']>
      } = this.workspaceChanges
      const summary = await (targetPath !== undefined
        ? undoTarget.undo(
            input.changeSetId,
            (projectId) => this.gate.projectHasNativeWork(projectId),
            targetPath,
          )
        : this.workspaceChanges.undo(input.changeSetId, (projectId) =>
            this.gate.projectHasNativeWork(projectId),
          ))
      const patch = this.conversations.recordWorkspaceChanges(summary)
      this.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      const run = this.conversations.findRun(input.changeSetId)
      const summary = this.workspaceChanges?.summary(input.changeSetId)
      if (run && summary?.state === 'recovery_required') {
        this.publish(this.conversations.recordWorkspaceChanges(summary))
      }
      return this.sendFailure(error)
    }
  }

  setInterests(sessionIds: string[]): RpcResult<{ ready: true }> {
    if (this.disposed) return this.shuttingDown()
    const input = conversationInterestsSchema.safeParse({ sessionIds })
    if (!input.success) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose a bounded set of Sessions.' },
      }
    }
    for (const owner of this.skillDiscoveries.values()) {
      if (!input.data.sessionIds.includes(owner.sessionId)) {
        this.skills.cancelSkillCatalog(owner.sessionId)
      }
    }
    for (const id of this.steerReceiptChecks.keys()) {
      if (!input.data.sessionIds.includes(id)) this.steerReceiptChecks.delete(id)
    }
    for (const check of this.nativeChecks.values()) {
      if (check.receiptSessionId && !input.data.sessionIds.includes(check.receiptSessionId)) {
        check.controller.abort()
      }
    }
    this.interestedSessionIds = new Set(input.data.sessionIds)
    return { ok: true, value: { ready: true } }
  }

  createStreamTrace(run: AgentRun, owner: NativeObservation): OwnedStreamTrace | undefined {
    try {
      const reservation = owner.archiver.archiveMemory.reserve(8192)
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

  currentStreamTrace(owner: NativeObservation): OwnedStreamTrace | undefined {
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

  bumpStreamTrace(
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

  observeNativeDelta(owner: NativeObservation, value: NativeLoopDeltaObservation): void {
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

  observeNormalizedDelta(
    owner: NativeObservation,
    event: NormalizedAgentEvent,
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

  projectStreamTrace(
    owner: NativeObservation,
    foreground?: AgentStreamBuffer,
  ): ConversationStreamTrace | undefined {
    const trace = this.currentStreamTrace(owner)
    if (!trace) return undefined
    try {
      const execution = this.activeExecutions.get(trace.data.sessionId)
      const buffer =
        foreground ?? (execution?.run.id === trace.data.runId ? execution.streamBuffer : undefined)
      if (buffer) trace.data.foregroundBuffer = buffer.diagnostics()
      if (owner.archiver.archiveBuffer) {
        trace.data.archiveBuffer = owner.archiver.archiveBuffer.diagnostics()
      }
      trace.data.outputFailed = Boolean(owner.archiver.outputFailure)
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

  retireStreamTrace(owner: NativeObservation, foreground?: AgentStreamBuffer): void {
    const snapshot = this.projectStreamTrace(owner, foreground)
    const trace = owner.streamTrace
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

  streamTraceProjections(): ConversationStreamTrace[] {
    const result: ConversationStreamTrace[] = []
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
    } else if (last && !result.some((trace) => trace.runId === last.data.runId)) {
      result.push(structuredClone(last.data))
    }
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

  recordUnrecordedArchiveFailure(runId: string, sessionId: string, error: unknown): void {
    if (this.unrecordedArchiveFailures.size >= 64 && !this.unrecordedArchiveFailures.has(runId)) {
      const oldest = this.unrecordedArchiveFailures.keys().next().value
      if (oldest !== undefined) this.unrecordedArchiveFailures.delete(oldest)
    }
    this.unrecordedArchiveFailures.set(runId, { sessionId, error })
  }

  subscribe(listener: (patch: ConversationPatch, progress: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeNotifications(listener: (event: SessionNotificationEvent) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  private readonly drainingSessionPublications = new Set<string>()

  private drainPendingStreamPublications(sessionId: string, beforeSequence: number): void {
    if (this.drainingSessionPublications.has(sessionId)) return
    this.drainingSessionPublications.add(sessionId)
    try {
      const buffers = new Set<AgentStreamBuffer>()
      const activeBuffer = this.activeExecutions.get(sessionId)?.streamBuffer
      if (activeBuffer) buffers.add(activeBuffer)
      for (const owner of this.nativeObservations.values()) {
        if (owner.archiver.sessionId !== sessionId) continue
        buffers.add(owner.archiver.foregroundBuffer)
        if (owner.archiver.archiveBuffer) buffers.add(owner.archiver.archiveBuffer)
      }
      while (buffers.size > 0) {
        let earliestBuffer: AgentStreamBuffer | undefined
        let earliestSeq: number | undefined
        for (const buffer of buffers) {
          const seq = buffer.peekNextCommittedSequence()
          if (seq === undefined || seq >= beforeSequence) continue
          if (earliestSeq === undefined || seq < earliestSeq) {
            earliestSeq = seq
            earliestBuffer = buffer
          }
        }
        if (!earliestBuffer) break
        if (!earliestBuffer.publishNextCommitted()) {
          buffers.delete(earliestBuffer)
        }
      }
    } finally {
      this.drainingSessionPublications.delete(sessionId)
    }
  }

  publish(patch: ConversationPatch, progress = false, streamOwner?: NativeObservation): void {
    const streamTrace = progress && streamOwner ? this.currentStreamTrace(streamOwner) : undefined
    if (streamTrace) this.bumpStreamTrace(streamTrace, streamTrace.data.publication, 'attempts')
    const decision = this.decisionRuntime
    if (!progress && decision?.sessionId === patch.sessionId && !decision.current()) {
      decision.controller.abort()
      void decision.runtime?.dispose()
    }
    if (!progress) {
      this.conversations.refreshSchedulingRecoveryFacts(patch.sessionId)
      if (!this.gate.hasSessionOperation(patch.sessionId, false, undefined, true)) {
        this.conversations.armSchedulingRecoveryFaults(patch.sessionId)
      }
      this.archiveAndQuit.nativeMetadataChanged()
      this.collaboration.schedulePendingRoutedContinuations()
    }
    if (!progress) patch.forkBlocked = this.gate.forkBlocked(patch.sessionId)
    if (!progress) {
      patch.sessionIssues = this.gate.sessionIssues(patch.sessionId, patch.nativeContexts ?? [])
    }
    if (!progress) {
      const collaboration = this.conversations.collaboration(patch.sessionId)
      const notification = collaboration
        ? this.collaboration.collaborationNotification(collaboration)
        : undefined
      if (notification) patch.collaborationNotification = notification
    }
    if (!progress) {
      patch.pendingNativeInteractions = this.interactions.pendingNativeInteractions(patch.sessionId)
    }
    if (!progress) {
      patch.preparedInputContinuation = this.conversations.preparedInputContinuation(
        patch.sessionId,
      )
    }
    if (!progress) {
      patch.relaySchedulingDecision = this.scheduling.projectRelaySchedulingDecision(
        patch.sessionId,
        patch.sessionIssues,
      )
    }
    if (!progress) {
      patch.pendingRoutedContinuation = this.conversations.hasPendingRoutedContinuation(
        patch.sessionId,
      )
    }
    const notificationEvents =
      !progress &&
      this.notificationListeners.size > 0 &&
      !this.disposed &&
      !this.gate.nativeQuitSealed()
        ? this.notificationProjector.observe(patch, false)
        : []
    if (!progress && Buffer.byteLength(JSON.stringify(patch)) > CONVERSATION_PATCH_BYTES) {
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
      if (patch.comments) {
        patch.comments = {
          revision: patch.comments.revision,
          upserts: [],
          removedIds: [],
          ...(patch.comments.sent ? { sent: patch.comments.sent } : {}),
        }
      }
      patch.resync = {
        messages: true,
        drafts: Boolean(patch.comments) || Boolean(patch.resync?.drafts),
        activityRunIds,
      }
      conversationPatchSchema.parse(patch)
    }
    this.drainPendingStreamPublications(patch.sessionId, patch.observation.sequence)
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
    if (!this.disposed && !this.gate.nativeQuitSealed()) {
      for (const event of notificationEvents) {
        for (const listener of this.notificationListeners) listener(event)
      }
    }
  }

  recoveryResult(sessionId: string): RpcResult<ConversationPatch> {
    const patch = this.conversations.contextPatch(sessionId)
    this.publish(patch)
    return { ok: true, value: patch }
  }
}
